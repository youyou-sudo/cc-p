// modules/responses/translator.ts — OpenAI Responses 请求转换 + 流式翻译。
//
// 请求侧：Responses 形 → 内部 OpenAI chat 形（buildCcRequest 的输入），与
// messages/translator.ts 的 convertAnthropicToOpenAI 对称，三路协议最终汇于
// 同一上游 /alpha/generate 请求体。
// 响应侧：CC NDJSON → Responses SSE 事件（response.created / output_item.added /
// output_text.delta / ... / response.completed）。
//
// 无状态说明：store / previous_response_id / include / truncation / text.format
// 在 CC 侧无对应实现，忽略并记 debug 日志（代理不假装支持有状态续接）。
// reasoning：上游 reasoning-delta → {type:'reasoning',summary:[...]} item +
// response.reasoning_summary_* 事件；不发 encrypted_content（无签名可发）。
// 请求侧对称：input 里的 reasoning item → 下一条 assistant 消息的
// reasoning_content（cc.ts 回灌为 {type:'reasoning',text}）——推理模型要求
// 上一轮思考随历史回传，丢弃会让模型半途失忆（此前这里整项 ignore）。
// 零输出不变量：startEvents() 只缓冲（created/in_progress），首个内容事件
// （output_item.added）才由 stream-handler 显式 start()，保证空回包仍能回落
// 429 JSON（与 messages 侧 message_start 缓冲语义一致）。

import { isTruncatedStream, mapCcEventError, mapFinishReason, normalizeUsage, TRUNCATED_STREAM_MESSAGE } from '../../shared/errors'
import { ccToolArgsToString, ccToolCallId, ccToolName, createToolCallIdGuard, UNKNOWN_TOOL_NAME } from '../../shared/cc-types'
import { log } from '../../shared/logger'
import { CcStreamParser } from '../../infra/cc-events'
import type { CcEventHooks } from '../../infra/cc-events'
import { shortUrl, uuid, redactLargeDataUrls } from '../../shared/util'

// ---- local helpers (file-local, avoid cycles) ----
function toNum(v: any): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
/** CC text delta may arrive as {text} or {delta}; tolerate both. */
function textOrDelta(e: any): string {
  return e.text ?? e.delta ?? ''
}
/** Only allow legal OpenAI finish_reason; unknown maps to stop (never pass through illegal). */
function safeMapFinishReason(reason: any): string {
  const mapped = mapFinishReason(String(reason || 'stop'))
  if (mapped === 'tool_calls' || mapped === 'length' || mapped === 'stop') return mapped
  if (mapped === 'content_filter' || mapped === 'function_call') return mapped
  return 'stop'
}
/**
 * Multi-step priority: tool_calls > length > stop.
 * First non-stop wins; a later stop must not overwrite an earlier length.
 */
function mergeFinishReason(current: string | null, incoming: string): string {
  const pri = (v: string | null): number => {
    if (v === 'tool_calls') return 3
    if (v === 'length') return 2
    if (v === 'stop') return 1
    return 0
  }
  if (current == null) return incoming
  return pri(incoming) > pri(current) ? incoming : current
}
/** Accumulate usage without reset (same invariant as chat/messages aggregators). */
function mergeUsage(acc: any, incoming: any): any {
  if (!incoming) return acc
  if (!acc) return { ...incoming }
  const out: any = { ...acc }
  if (incoming.inputTokens != null) out.inputTokens = incoming.inputTokens
  if (incoming.outputTokens != null) out.outputTokens = incoming.outputTokens
  if (incoming.cachedInputTokens != null) out.cachedInputTokens = incoming.cachedInputTokens
  const cw = incoming.inputTokenDetails?.cacheWriteTokens ?? (incoming as any).cacheWriteTokens
  if (cw != null) {
    out.inputTokenDetails = { ...(out.inputTokenDetails || {}), cacheWriteTokens: cw }
  }
  return out
}
function stringifyUnknownContent(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content) ?? ''
  } catch {
    return String(content)
  }
}
function toolArgsToString(input: any): string {
  return typeof input === 'string' ? input : JSON.stringify(input ?? {})
}
/** Responses input_image / image_url → URL string (tolerates string or {url}). */
function extractImageUrl(part: any): string {
  if (!part || typeof part !== 'object') return ''
  const candidates = [part.image_url, part.url, part.image]
  for (const v of candidates) {
    if (typeof v === 'string' && v) return v
    if (v && typeof v === 'object' && typeof v.url === 'string' && v.url) return v.url
  }
  if (part.source && typeof part.source === 'object') {
    const s = part.source
    if (typeof s.url === 'string' && s.url) return s.url
    if (typeof s.data === 'string' && s.data) {
      const media = s.media_type || s.mediaType || 'image/jpeg'
      return `data:${media};base64,${s.data}`
    }
  }
  return ''
}
/** Responses `reasoning` item → plaintext (summary[] / content[] / bare text).
 *
 *  与 messages 侧 `thinking` 块对称：推理模型要求把上一轮 assistant 的 reasoning
 *  随历史回传，否则模型「忘记自己想过什么」。上游 wire 形是 `{type:'reasoning',
 *  text}`（见 infra/cc.ts assistant 分支）。`encrypted_content` 无明文（需 provider
 *  解密），本地绝不伪造，直接跳过。 */
function reasoningItemText(item: any): string {
  if (!item || typeof item !== 'object') return ''
  const collect = (arr: any): string => Array.isArray(arr)
    ? arr.map((p: any) => (typeof p === 'string' ? p : (typeof p?.text === 'string' ? p.text : ''))).filter((s: string) => s).join('\n')
    : ''
  if (typeof item.text === 'string' && item.text) return item.text
  const summary = collect(item.summary)
  if (summary) return summary
  return collect(item.content)
}

/** function_call_output.output → text (string / content parts / arbitrary object). */
function outputToText(output: any): string {
  if (output == null) return ''
  if (typeof output === 'string') return redactLargeDataUrls(output)
  if (Array.isArray(output)) {
    return redactLargeDataUrls(output.map((c: any) => {
      if (c == null) return ''
      if (typeof c === 'string') return c
      if (typeof c.text === 'string') return c.text
      if (c.type === 'input_image' || c.type === 'image_url' || c.type === 'image') {
        const url = extractImageUrl(c)
        return url ? `[image: ${shortUrl(url)}]` : '[image omitted]'
      }
      // 工具结果里的文件分片（截图/附件）：绝不能 stringify 成文本，否则
      // 内联 base64（可达数 MB）会随历史每轮重发，直接顶爆上下文触发压缩。
      if (c.type === 'file' || c.type === 'input_file') {
        const name = c.filename || c.name || ''
        const uri = typeof c.uri === 'string' ? c.uri : (typeof c.url === 'string' ? c.url : '')
        const size = uri.startsWith('data:') ? `, ${uri.length} chars inline` : ''
        return `[file: ${name || 'attachment'}${size}]`
      }
      if (typeof c.text === 'string') return c.text
      return stringifyUnknownContent(c)
    }).join('\n'))
  }
  if (typeof output === 'object') {
    if (typeof output.text === 'string') return redactLargeDataUrls(output.text)
    if (output.output != null) return outputToText(output.output)
    return redactLargeDataUrls(stringifyUnknownContent(output))
  }
  return String(output)
}

// ── request conversion ──────────────────────────────────────────────────

/** Responses input message content parts → chat content (string | parts[]). */
function convertContentParts(content: any): any {
  if (typeof content === 'string') return content
  if (content == null) return ''
  if (!Array.isArray(content)) {
    if (typeof content === 'object' && typeof content.text === 'string') return content.text
    return stringifyUnknownContent(content)
  }
  const parts: any[] = []
  for (const part of content) {
    if (part == null) continue
    if (typeof part === 'string') {
      if (part) parts.push({ type: 'text', text: part })
      continue
    }
    const pt = part.type
    if (pt === 'input_text' || pt === 'output_text' || pt === 'text' || pt === 'summary_text') {
      parts.push({ type: 'text', text: part.text ?? '' })
    } else if (pt === 'input_image' || pt === 'image_url' || pt === 'image') {
      const url = extractImageUrl(part)
      if (url) parts.push({ type: 'image_url', image_url: { url } })
      else {
        log('warn', 'responses image omitted: empty url', { partType: pt })
        parts.push({ type: 'text', text: '[image omitted: empty url]' })
      }
    } else if (pt === 'refusal') {
      const text = part.refusal ?? ''
      if (text) parts.push({ type: 'text', text })
    } else if (pt === 'input_file' || pt === 'file') {
      // CC has no file input: demote to a visible placeholder instead of dropping.
      const label = part.filename ? `[file: ${part.filename}]` : '[file omitted]'
      log('warn', 'responses file part demoted to placeholder', { partType: pt })
      parts.push({ type: 'text', text: label })
    } else if (part.text != null) {
      parts.push({ type: 'text', text: String(part.text) })
    } else {
      log('warn', 'responses content part dropped', { partType: pt || '' })
    }
  }
  if (parts.length === 0) return ''
  return parts
}

/**
 * Responses tools (flat {type,name,parameters}) → chat nested function tools.
 *
 * `namespace` tools (codex `collaboration` / `multi_agent_v1`) group several
 * function tools under one name; CC has no namespace concept, so the whole
 * group must be flattened to bare-name function tools — otherwise the model
 * never sees its subtools and the client replays a call the proxy cannot name
 * (which upstream then rejects with "`name` must be non-empty"). `namespaces`
 * records bare-name → namespace so response translation can restore the
 * `namespace` field codex routes on (see createResponsesSseTranslator /
 * buildResponsesObject). Built-in tools with no CC equivalent are still dropped
 * with a warn (never silently).
 */
function convertTools(tools: any, namespaces: Record<string, string>): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out: any[] = []
  const seen = new Set<string>()
  const pushFunction = (name: string, description: string, params: any, strict: any, namespace?: string): void => {
    // 先到先赢：顶层同名 function 工具优先，避免两套 schema 漂移。
    if (!name || seen.has(name)) return
    seen.add(name)
    if (namespace) namespaces[name] = namespace
    const fn: any = { name, description: description || '' }
    if (params !== undefined) fn.parameters = params
    if (strict !== undefined) fn.strict = strict
    out.push({ type: 'function', function: fn })
  }
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    const type = t.type || 'function'
    if (type === 'namespace') {
      const ns = t.name || ''
      const subTools = Array.isArray(t.tools) ? t.tools : []
      if (!ns || subTools.length === 0) {
        log('warn', 'responses namespace tool empty dropped', { name: ns, subTools: subTools.length })
        continue
      }
      for (const sub of subTools) {
        const subType = sub?.type || 'function'
        if (subType !== 'function') {
          log('warn', 'responses namespace sub-tool dropped', { namespace: ns, toolType: subType, name: sub?.name || '' })
          continue
        }
        const subName = sub.name || ''
        if (!subName) {
          log('warn', 'responses namespace sub-tool missing name dropped', { namespace: ns })
          continue
        }
        // 描述前缀保留命名空间来源，模型仍能据此选择正确的子工具。
        const desc = `[namespace: ${ns}] ${sub.description ?? ''}`.trim()
        pushFunction(subName, desc, sub.parameters ?? sub.input_schema, sub.strict, ns)
      }
      continue
    }
    if (type !== 'function') {
      // Built-in tools (web_search/file_search/mcp/...): CC has no equivalent.
      log('warn', 'responses non-function tool dropped', { toolType: type, name: t.name || '' })
      continue
    }
    const name = t.name || t.function?.name || ''
    if (!name) {
      log('warn', 'responses tool missing name dropped', {})
      continue
    }
    pushFunction(name, t.description ?? t.function?.description ?? '', t.parameters ?? t.function?.parameters ?? t.input_schema, t.strict ?? t.function?.strict)
  }
  return out.length > 0 ? out : undefined
}

/** 把 Responses 的带命名空间调用名规范成扁平的裸子工具名。
 *  codex 会把命名空间调用的 name 写成 `<ns>.<tool>`；上行 tools 已按裸名展平，
 *  这里剥掉已知前缀，避免上游因引用不存在的工具名而 400。 */
export function normalizeNamespacedName(name: string, namespaces: Record<string, string>): string {
  if (!name) return name
  if (namespaces[name]) return name
  const dot = name.indexOf('.')
  if (dot > 0) {
    const bare = name.slice(dot + 1)
    if (namespaces[bare]) return bare
  }
  return name
}

/** 回放 `function_call` 时的工具名解析。
 *
 *  codex 的命名空间调用回放时可能**不带 name**（只带 namespace / call_id），
 *  直接 `item.name || ''` 会向上游发出空名，上游以
 *  "`name` must be non-empty" 400 掉整个请求（生产日志实证）。
 *  解析顺序：name / function.name / tool_name → 归一点分名 → namespace 唯一子工具
 *  → 非空占位名。**永不返回空串**（上游契约要求非空）。 */
function resolveCallName(item: any, namespaces: Record<string, string>): string {
  const raw = String(item?.name ?? item?.function?.name ?? item?.tool_name ?? '').trim()
  const normalized = normalizeNamespacedName(raw, namespaces)
  if (normalized) return normalized
  const ns = typeof item?.namespace === 'string' ? item.namespace : ''
  if (ns) {
    const subs = Object.keys(namespaces).filter((k) => namespaces[k] === ns)
    if (subs.length === 1) return subs[0]!
  }
  return 'unknown_tool'
}

function convertToolChoice(tc: any, namespaces: Record<string, string>): any {
  if (tc === undefined || tc === null) return undefined
  if (typeof tc === 'string') return tc
  if (typeof tc !== 'object') return undefined
  if (tc.type === 'function') {
    let name = tc.name ?? tc.function?.name
    if (!name) {
      log('warn', 'responses tool_choice function missing name dropped', {})
      return undefined
    }
    // 命名空间选择：`{namespace, name:"ns.tool"}` 或点分裸名 → 裸子工具名。
    if (typeof tc.namespace === 'string' && tc.namespace) {
      name = name.replace(new RegExp(`^${tc.namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`), '')
    }
    name = normalizeNamespacedName(name, namespaces)
    const out: any = { type: 'function', function: { name } }
    if (tc.disable_parallel_tool_use !== undefined) out.disable_parallel_tool_use = tc.disable_parallel_tool_use
    return out
  }
  // allowed_tools / mcp / ...: pass through untouched (buildCcRequest forwards
  // unknown tool_choice objects wholesale instead of silently downgrading).
  return tc
}

const IGNORED_FIELDS = [
  'store', 'previous_response_id', 'include', 'truncation', 'text',
  'background', 'service_tier', 'max_tool_calls', 'safety_identifier',
  'prompt', 'conversation', 'context_management', 'stream_options',
]

/**
 * Responses 请求 → 内部 OpenAI chat 请求（buildCcRequest 的输入）。
 * 未知/无对应字段一律忽略并记 debug，绝不静默丢内容（图片/文件降级为占位符）。
 */
export function convertResponsesToOpenAI(responsesReq: any): any {
  const req = responsesReq || {}
  const messages: any[] = []

  // tools/namespaces 先于 input 解析：function_call 回放需要 namespaces 做名字
  // 归一与空名兜底（见 resolveCallName），否则会向上游发出空名而被 400。
  const namespaces: Record<string, string> = {}
  const tools = convertTools(req.tools, namespaces)
  const toolChoice = convertToolChoice(req.tool_choice, namespaces)

  const instructions = req.instructions
  if (typeof instructions === 'string') {
    if (instructions) messages.push({ role: 'system', content: instructions })
  } else if (Array.isArray(instructions)) {
    const text = instructions
      .map((b: any) => (typeof b === 'string' ? b : (b?.text ?? '')))
      .filter((s: string) => s)
      .join('\n')
    if (text) messages.push({ role: 'system', content: text })
  } else if (instructions != null) {
    log('debug', 'responses instructions ignored (unexpected shape)', { type: typeof instructions })
  }

  const input = req.input
  if (typeof input === 'string') {
    if (input) messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    // Parallel tool calls arrive as consecutive `function_call` items. Upstream
    // requires one assistant tool_calls message immediately followed by tool
    // results, so merge consecutive calls into a single assistant message
    // (symmetric with messages/translator.ts grouping an assistant turn's
    // tool_use blocks). Non-call items reset the container.
    let toolCallContainer: any = null
    // A `reasoning` item precedes the assistant message / function_call it
    // belongs to, so buffer its text and attach it to the next assistant item
    // as `reasoning_content` (cc.ts → upstream `{type:'reasoning',text}`).
    // Anything that ends the assistant turn clears it (never mis-attach).
    let pendingReasoning = ''
    for (const item of input) {
      if (typeof item === 'string') {
        toolCallContainer = null
        pendingReasoning = ''
        if (item) messages.push({ role: 'user', content: item })
        continue
      }
      if (!item || typeof item !== 'object') {
        log('warn', 'responses input item dropped', { itemType: typeof item })
        continue
      }
      const type = item.type
      if (type === 'reasoning') {
        // 思考历史必须回灌：丢弃会让推理模型「忘记自己的推理」，多轮
        // tool-loop 表现为重新规划 / 半途停下（与 messages 侧 thinking 对称）。
        const text = reasoningItemText(item)
        if (text) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n\n${text}` : text
        else log('debug', 'responses reasoning item without plaintext (encrypted only) ignored', {})
        continue
      }
      if (type === 'function_call') {
        const callId = item.call_id || item.id || `call_${uuid().slice(0, 8)}`
        const name = resolveCallName(item, namespaces)
        if (name === UNKNOWN_TOOL_NAME) {
          // 区分两种情况，否则整段历史每轮刷屏 warn：
          //  - 客户端回放的调用本来就叫 unknown_tool（上一轮真的丢过名字）→ debug；
          //  - 本次确实没给名字 → warn，便于定位上游丢名事件。
          const providedName = String(item.name ?? item.function?.name ?? item.tool_name ?? '').trim()
          if (providedName) {
            log('debug', 'responses function_call replayed as unknown_tool', { callId })
          } else {
            // 非空兜底只为满足上游校验（"`name` must be non-empty"）；记下形态便于定位。
            log('warn', 'responses function_call name fallback', {
              callId,
              namespace: item.namespace || '',
              hadName: false,
            })
          }
        }
        const toolCall = {
          id: callId,
          type: 'function',
          function: { name, arguments: toolArgsToString(item.arguments) },
        }
        if (toolCallContainer) {
          toolCallContainer.tool_calls.push(toolCall)
        } else {
          toolCallContainer = { role: 'assistant', content: null, tool_calls: [toolCall] }
          if (pendingReasoning) {
            toolCallContainer.reasoning_content = pendingReasoning
            pendingReasoning = ''
          }
          messages.push(toolCallContainer)
        }
      } else if (type === 'function_call_output') {
        toolCallContainer = null
        pendingReasoning = ''
        const callId = item.call_id || item.id || ''
        if (!callId) log('warn', 'responses function_call_output missing call_id', {})
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          // 客户端可能只回放 output 而不带调用项（stateless 转发忽略
          // previous_response_id），带上 name 可避免 cc.ts 落到 unknown_tool 兜底。
          ...(item.name ? { name: String(item.name) } : {}),
          content: outputToText(item.output),
        })
      } else if (type === 'item_reference' || type === 'computer_call_output' || type === 'mcp_call' || type === 'mcp_approval_response') {
        // Ignored items with no CC equivalent must not break the tool-call
        // grouping, so the container is intentionally kept.
        log('debug', 'responses input item ignored (no CC equivalent)', { itemType: type })
      } else if (item.role) {
        toolCallContainer = null
        const msg: any = { role: item.role, content: convertContentParts(item.content) }
        if (item.role === 'assistant' && pendingReasoning) msg.reasoning_content = pendingReasoning
        pendingReasoning = ''
        messages.push(msg)
      } else {
        log('warn', 'responses input item unknown dropped', { itemType: type || '' })
      }
    }
  } else if (input != null) {
    log('warn', 'responses input ignored (expected string|array)', { type: typeof input })
  }

  const openaiReq: any = {
    model: req.model || 'deepseek/deepseek-v4-flash',
    messages,
  }
  if (req.stream !== undefined) openaiReq.stream = req.stream
  if (req.max_output_tokens !== undefined) openaiReq.max_tokens = req.max_output_tokens
  if (req.temperature !== undefined) openaiReq.temperature = req.temperature
  if (req.top_p !== undefined) openaiReq.top_p = req.top_p
  if (req.parallel_tool_calls !== undefined) openaiReq.parallel_tool_calls = req.parallel_tool_calls
  if (req.prompt_cache_key !== undefined) openaiReq.prompt_cache_key = req.prompt_cache_key
  if (req.seed !== undefined) openaiReq.seed = req.seed
  if (req.user !== undefined) openaiReq.user = req.user
  if (req.metadata?.user_id !== undefined) openaiReq.user = req.metadata.user_id

  if (tools) openaiReq.tools = tools
  if (toolChoice !== undefined) openaiReq.tool_choice = toolChoice
  // namespace 子工具展平后，名字→命名空间的映射需透传到响应侧：上游把该调用
  // 当扁平 function 返回，回放时必须还原 `namespace` 字段（codex-rs 按
  // (namespace, name) 路由，点分 ns.name 会被判 unsupported call）。
  // 内部透传字段（非标准 OpenAI，仅在 proxy 内部消费，绝不进上游请求体：
  // buildCcRequest 只挑白名单字段，会自然忽略）。
  if (Object.keys(namespaces).length > 0) openaiReq._toolNamespaces = namespaces

  if (req.reasoning && typeof req.reasoning === 'object') {
    if (req.reasoning.effort !== undefined) openaiReq.reasoning_effort = req.reasoning.effort
    if (req.reasoning.summary !== undefined) {
      log('debug', 'responses reasoning.summary ignored (summary always emitted)', { summary: req.reasoning.summary })
    }
  }
  if (req.reasoning_effort !== undefined) openaiReq.reasoning_effort = req.reasoning_effort

  for (const key of IGNORED_FIELDS) {
    if (req[key] !== undefined) log('debug', 'responses stateless field ignored', { field: key })
  }

  return openaiReq
}

// ── streaming translation ───────────────────────────────────────────────

function sseEvent(type: string, data: Record<string, any>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

/** Response skeleton shared by created/in_progress/completed events. */
function responseSkeleton(model: string, responseId: string, createdAt: number, status: string): any {
  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: null,
    user: null,
    metadata: {},
  }
}

interface OpenItem {
  kind: 'message' | 'reasoning' | 'function_call'
  id: string
  outputIndex: number
  text: string
  args: string
  name: string
  callId: string
  /** 展平后的命名空间子工具：回放时附加 namespace 字段（codex-rs 路由键）。 */
  namespace: string
}

export function createResponsesSseTranslator(
  model: string,
  responseId: string,
  createdAt: number,
  /** 裸子工具名 → 命名空间（来自请求转换 convertTools 的展平）。 */
  toolNamespaces: Record<string, string> = {},
) {
  let sequence = 0
  let outputIndex = 0
  const items: any[] = []
  let current: OpenItem | null = null
  let finishReason: string | null = null
  let usage: any = null
  let hasError = false
  // sawFinish: CC 正常结束必发 finish（或 finish-step）；缺失 + 有内容 + 无错误 = 截断。
  let sawFinish = false
  let upstreamError: { status: number; body: any } | null = null
  let pendingToolInput: { id: string; name: string; json: string } | null = null
  let sawText = false
  let sawReasoning = false
  let sawToolCall = false
  let textChars = 0
  let reasoningChars = 0
  let toolChars = 0
  let bytesReceived = 0

  const nextSeq = (): number => sequence++
  const event = (type: string, data: Record<string, any>): string => sseEvent(type, { sequence_number: nextSeq(), ...data })

  function openMessage(): string[] {
    const out: string[] = []
    if (current && current.kind !== 'message') out.push(...closeCurrent())
    if (current) return out
    const item: OpenItem = { kind: 'message', id: `msg_${uuid().slice(0, 12)}`, outputIndex: outputIndex++, text: '', args: '', name: '', callId: '', namespace: '' }
    current = item
    out.push(event('response.output_item.added', {
      output_index: item.outputIndex,
      item: { id: item.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    }))
    out.push(event('response.content_part.added', {
      item_id: item.id,
      output_index: item.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }))
    return out
  }

  function openReasoning(): string[] {
    const out: string[] = []
    if (current && current.kind !== 'reasoning') out.push(...closeCurrent())
    if (current) return out
    const item: OpenItem = { kind: 'reasoning', id: `rs_${uuid().slice(0, 12)}`, outputIndex: outputIndex++, text: '', args: '', name: '', callId: '', namespace: '' }
    current = item
    out.push(event('response.output_item.added', {
      output_index: item.outputIndex,
      item: { id: item.id, type: 'reasoning', summary: [] },
    }))
    out.push(event('response.reasoning_summary_part.added', {
      item_id: item.id,
      output_index: item.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    }))
    return out
  }

  function closeCurrent(): string[] {
    if (!current) return []
    const c = current
    current = null
    const out: string[] = []
    if (c.kind === 'message') {
      out.push(event('response.output_text.done', {
        item_id: c.id, output_index: c.outputIndex, content_index: 0, text: c.text,
      }))
      out.push(event('response.content_part.done', {
        item_id: c.id, output_index: c.outputIndex, content_index: 0,
        part: { type: 'output_text', text: c.text, annotations: [] },
      }))
      const item = {
        id: c.id, type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: c.text, annotations: [] }],
      }
      items.push(item)
      out.push(event('response.output_item.done', { output_index: c.outputIndex, item }))
    } else if (c.kind === 'reasoning') {
      out.push(event('response.reasoning_summary_text.done', {
        item_id: c.id, output_index: c.outputIndex, summary_index: 0, text: c.text,
      }))
      out.push(event('response.reasoning_summary_part.done', {
        item_id: c.id, output_index: c.outputIndex, summary_index: 0,
        part: { type: 'summary_text', text: c.text },
      }))
      const item = { id: c.id, type: 'reasoning', summary: [{ type: 'summary_text', text: c.text }] }
      items.push(item)
      out.push(event('response.output_item.done', { output_index: c.outputIndex, item }))
    } else {
      out.push(event('response.function_call_arguments.done', {
        item_id: c.id, output_index: c.outputIndex, arguments: c.args,
      }))
      const item: any = {
        id: c.id, type: 'function_call', status: 'completed',
        call_id: c.callId, name: c.name, arguments: c.args,
      }
      if (c.namespace) item.namespace = c.namespace
      items.push(item)
      out.push(event('response.output_item.done', { output_index: c.outputIndex, item }))
    }
    return out
  }

  const isDuplicateToolCallId = createToolCallIdGuard()

  function emitFunctionCall(callId: string, rawName: string, args: string): string[] {
    // 同一 id 二次出现必须跳过（见 createToolCallIdGuard），否则客户端回传重复
    // call_id，上游 400。
    if (isDuplicateToolCallId(callId)) {
      log('debug', 'cc duplicate tool-call id suppressed (stream)', { toolCallId: callId })
      return []
    }
    // 无参数调用必须发 '{}'：空串不是合法 JSON，客户端解析失败会丢掉这次调用，
    // 写进历史后再回放就变成 arguments:""（见 cc-types.ccToolArgsToString）。
    args = ccToolArgsToString(args)
    // 上游按扁平 function 返回；若该名字来自命名空间展平，回放时剥掉可能的
    // `<ns>.` 前缀并还原 namespace 字段（codex-rs 按 (namespace, name) 路由）。
    const name = normalizeNamespacedName(rawName || '', toolNamespaces)
    const namespace = toolNamespaces[name] || ''
    // Responses SDK / codex 契约要求 function_call 的 name 与 call_id 非空；空 name
    // 会让客户端 ToolStream 抛错（见 cc-types.ccToolName 注释），空 call_id 则无法
    // 配对回放。上游确实缺失时统一兜底。
    const finalCallId = callId || `call_${uuid().slice(0, 12)}`
    const finalName = name || UNKNOWN_TOOL_NAME
    if (!name || !callId) {
      log('warn', 'cc tool-call identity fallback', {
        path: '/v1/responses',
        missingName: !name,
        missingCallId: !callId,
        callId: finalCallId,
      })
    }
    const out: string[] = []
    if (current) out.push(...closeCurrent())
    const item: OpenItem = {
      kind: 'function_call',
      id: `fc_${uuid().slice(0, 12)}`,
      outputIndex: outputIndex++,
      text: '',
      args,
      name: finalName,
      callId: finalCallId,
      namespace,
    }
    current = item
    const addedItem: any = { id: item.id, type: 'function_call', status: 'in_progress', call_id: finalCallId, name: finalName, arguments: '' }
    if (namespace) addedItem.namespace = namespace
    out.push(event('response.output_item.added', {
      output_index: item.outputIndex,
      item: addedItem,
    }))
    if (args) {
      out.push(event('response.function_call_arguments.delta', {
        item_id: item.id, output_index: item.outputIndex, delta: args,
      }))
    }
    out.push(...closeCurrent())
    return out
  }

  function flushPendingToolInput(): string[] {
    if (pendingToolInput && (pendingToolInput.json || pendingToolInput.id || pendingToolInput.name)) {
      const { id, name, json } = pendingToolInput
      pendingToolInput = null
      return emitFunctionCall(id, name, json)
    }
    pendingToolInput = null
    return []
  }

  const parser = new CcStreamParser()
  const hooks: CcEventHooks = {
    'text-delta': (e: any) => {
      const text = textOrDelta(e)
      if (!text) return
      sawText = true
      textChars += text.length
      const out = openMessage()
      const c = current!
      c.text += text
      out.push(event('response.output_text.delta', {
        item_id: c.id, output_index: c.outputIndex, content_index: 0, delta: text,
      }))
      return out
    },
    'reasoning-delta': (e: any) => {
      const text = textOrDelta(e)
      if (!text) return
      sawReasoning = true
      reasoningChars += text.length
      const out = openReasoning()
      const c = current!
      c.text += text
      out.push(event('response.reasoning_summary_text.delta', {
        item_id: c.id, output_index: c.outputIndex, summary_index: 0, delta: text,
      }))
      return out
    },
    'tool-call': (e: any) => {
      if (hasError) return
      // 最终 tool-call 可能只带 input：先取回 tool-input-* 缓存里的 id/name 再清空，
      // 否则会丢掉上游早先给出的工具名、发出空 name（见 emitFunctionCall 兜底）。
      const id = ccToolCallId(e) || pendingToolInput?.id || ''
      const name = ccToolName(e) || pendingToolInput?.name || ''
      pendingToolInput = null
      const args = toolArgsToString(e.input)
      sawToolCall = true
      toolChars += args.length
      return emitFunctionCall(id, name, args)
    },
    'tool-input-start': (e: any) => {
      if (hasError) return
      pendingToolInput = {
        id: ccToolCallId(e) || pendingToolInput?.id || '',
        name: ccToolName(e) || pendingToolInput?.name || '',
        json: '',
      }
    },
    'tool-input-delta': (e: any) => {
      if (hasError) return
      const d = e.delta ?? e.text ?? e.partial_json ?? e.partialJson
        ?? e.data ?? e.json ?? e.value ?? e.input ?? ''
      const s = typeof d === 'string' ? d : JSON.stringify(d)
      const id = ccToolCallId(e)
      const name = ccToolName(e)
      if (!pendingToolInput) {
        pendingToolInput = { id, name, json: '' }
      } else {
        if (id) pendingToolInput.id = id
        if (name) pendingToolInput.name = name
      }
      if (s) pendingToolInput.json += s
    },
    'tool-input-end': (e: any) => {
      if (hasError) return
      const fullInput = e.input ?? e.json ?? null
      const id = ccToolCallId(e) || pendingToolInput?.id || ''
      const name = ccToolName(e) || pendingToolInput?.name || ''
      const args = fullInput != null ? toolArgsToString(fullInput) : (pendingToolInput?.json || '')
      pendingToolInput = null
      if (args || id || name) {
        sawToolCall = true
        toolChars += args.length
        return emitFunctionCall(id, name, args)
      }
    },
    'finish-step': (e: any) => {
      if (hasError) return
      sawFinish = true
      if (e.finishReason) finishReason = mergeFinishReason(finishReason, safeMapFinishReason(e.finishReason))
      if (e.usage) usage = mergeUsage(usage, e.usage)
    },
    'finish': (e: any) => {
      if (hasError) return
      sawFinish = true
      if (e.finishReason) finishReason = mergeFinishReason(finishReason, safeMapFinishReason(e.finishReason))
      const incoming = e.totalUsage ?? e.usage
      if (incoming) usage = mergeUsage(usage, incoming)
    },
    // 上游 abort：生成被中途取消，不是 finish。保持 sawFinish=false，收尾时
    // finishEvents() 会判为截断并改写响应状态，绝不发 completed 成功帧。
    'abort': (e: any) => {
      log('warn', 'CC stream aborted by upstream', {
        path: '/v1/responses',
        model,
        responseId,
        lastCcEvent: parser.lastCcEvent || '(none)',
        bytesReceived,
        sawText,
        sawReasoning,
        sawToolCall,
      })
      return []
    },
    'error': (e: any) => {
      hasError = true
      upstreamError = mapCcEventError(e)
      const retry = (upstreamError.body as any)?.retry_after
      return event('error', {
        code: upstreamError.body?.error?.type ?? 'upstream_error',
        message: upstreamError.body?.error?.message ?? 'Unknown error',
        param: null,
        ...(retry !== undefined ? { retry_after: retry } : {}),
      })
    },
  }

  return {
    get lastCcEvent() {
      return parser.lastCcEvent
    },
    get upstreamError() {
      return upstreamError
    },
    get inputTokens() {
      return toNum(usage?.inputTokens)
    },
    get outputTokens() {
      return toNum(usage?.outputTokens)
    },
    get cachedInputTokens() {
      return toNum(usage?.cachedInputTokens)
    },
    get sawContent() {
      return sawText || sawReasoning || sawToolCall
    },
    /** 有内容、无上游错误、却未收到 finish → 截断；收尾须报错而非 completed。 */
    get truncated() {
      return isTruncatedStream(sawFinish, sawText || sawReasoning || sawToolCall, hasError)
    },
    get bytesReceived() {
      return bytesReceived
    },
    get rawUsage() {
      return {
        input_tokens: toNum(usage?.inputTokens),
        output_tokens: toNum(usage?.outputTokens),
        cached_tokens: toNum(usage?.cachedInputTokens),
      }
    },

    startEvents(): string[] {
      return [
        event('response.created', { response: responseSkeleton(model, responseId, createdAt, 'in_progress') }),
        event('response.in_progress', { response: responseSkeleton(model, responseId, createdAt, 'in_progress') }),
      ]
    },

    parseChunk(bytes: Uint8Array): string[] {
      bytesReceived += bytes.byteLength
      return parser.push(bytes, hooks)
    },

    flush(): string[] {
      const out = parser.flush(hooks)
      if (!hasError) out.push(...flushPendingToolInput())
      return out
    },

    finishEvents(): string[] {
      // Error wins: the error event was already emitted by the hook; a completed
      // event after an error would misreport the turn as successful.
      if (hasError) return []
      const out: string[] = []
      out.push(...flushPendingToolInput())
      out.push(...closeCurrent())
      const u = usage || {}
      normalizeUsage(u)
      const inputTokens = toNum(u.inputTokens)
      let outputTokens = toNum(u.outputTokens)
      // Zero-output guard: content present but upstream reported 0/missing →
      // backfill a length estimate so a real answer is never billed as zero.
      if (outputTokens === 0 && (sawText || sawReasoning || sawToolCall)) {
        outputTokens = Math.ceil((textChars + reasoningChars + toolChars) / 4) || 1
      }
      // 截断 = 有内容、无上游错误、却从未收到 finish。按 Responses 规范发
      // response.incomplete（而不是伪造 completed），让 SDK/客户端明确知道
      // 这一轮没有正常结束，而不是把半截回答当作完整成功。
      const truncated = isTruncatedStream(sawFinish, sawText || sawReasoning || sawToolCall, false)
      const status = truncated ? 'incomplete' : (finishReason === 'length' ? 'incomplete' : 'completed')
      const incompleteReason = truncated ? 'upstream_interrupted' : 'max_output_tokens'
      const response = {
        ...responseSkeleton(model, responseId, createdAt, status),
        output: items,
        usage: {
          input_tokens: inputTokens,
          input_tokens_details: { cached_tokens: toNum(u.cachedInputTokens) },
          output_tokens: outputTokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: inputTokens + outputTokens,
        },
        ...(status === 'incomplete' ? { incomplete_details: { reason: incompleteReason } } : {}),
      }
      out.push(event(status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response }))
      return out
    },

    /** Sequenced in-stream error frame (timeout / generic) for writeNow paths. */
    errorFrame(code: string, message: string, extra?: Record<string, any>): string {
      return event('error', { code, message, param: null, ...(extra || {}) })
    },
  }
}

export type ResponsesStreamTranslator = ReturnType<typeof createResponsesSseTranslator>
