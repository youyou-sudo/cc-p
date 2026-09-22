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
// 零输出不变量：startEvents() 只缓冲（created/in_progress），首个内容事件
// （output_item.added）才由 stream-handler 显式 start()，保证空回包仍能回落
// 429 JSON（与 messages 侧 message_start 缓冲语义一致）。

import { mapCcEventError, mapFinishReason, normalizeUsage } from '../../shared/errors'
import { createToolCallIdGuard } from '../../shared/cc-types'
import { log } from '../../shared/logger'
import { CcStreamParser } from '../../infra/cc-events'
import type { CcEventHooks } from '../../infra/cc-events'
import { uuid } from '../../shared/util'

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
/** function_call_output.output → text (string / content parts / arbitrary object). */
function outputToText(output: any): string {
  if (output == null) return ''
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output.map((c: any) => {
      if (c == null) return ''
      if (typeof c === 'string') return c
      if (typeof c.text === 'string') return c.text
      if (c.type === 'input_image' || c.type === 'image_url' || c.type === 'image') {
        const url = extractImageUrl(c)
        return url ? `[image: ${url}]` : '[image omitted]'
      }
      return stringifyUnknownContent(c)
    }).join('\n')
  }
  if (typeof output === 'object') {
    if (typeof output.text === 'string') return output.text
    if (output.output != null) return outputToText(output.output)
    return stringifyUnknownContent(output)
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

/** Responses tools (flat {type,name,parameters}) → chat nested function tools. */
function convertTools(tools: any): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out: any[] = []
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    const type = t.type || 'function'
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
    const fn: any = {
      name,
      description: t.description ?? t.function?.description ?? '',
    }
    const params = t.parameters ?? t.function?.parameters ?? t.input_schema
    if (params !== undefined) fn.parameters = params
    const strict = t.strict ?? t.function?.strict
    if (strict !== undefined) fn.strict = strict
    out.push({ type: 'function', function: fn })
  }
  return out.length > 0 ? out : undefined
}

function convertToolChoice(tc: any): any {
  if (tc === undefined || tc === null) return undefined
  if (typeof tc === 'string') return tc
  if (typeof tc !== 'object') return undefined
  if (tc.type === 'function') {
    const name = tc.name ?? tc.function?.name
    if (!name) {
      log('warn', 'responses tool_choice function missing name dropped', {})
      return undefined
    }
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
    for (const item of input) {
      if (typeof item === 'string') {
        toolCallContainer = null
        if (item) messages.push({ role: 'user', content: item })
        continue
      }
      if (!item || typeof item !== 'object') {
        log('warn', 'responses input item dropped', { itemType: typeof item })
        continue
      }
      const type = item.type
      if (type === 'function_call') {
        const callId = item.call_id || item.id || `call_${uuid().slice(0, 8)}`
        const toolCall = {
          id: callId,
          type: 'function',
          function: { name: item.name || '', arguments: toolArgsToString(item.arguments) },
        }
        if (toolCallContainer) {
          toolCallContainer.tool_calls.push(toolCall)
        } else {
          toolCallContainer = { role: 'assistant', content: null, tool_calls: [toolCall] }
          messages.push(toolCallContainer)
        }
      } else if (type === 'function_call_output') {
        toolCallContainer = null
        const callId = item.call_id || item.id || ''
        if (!callId) log('warn', 'responses function_call_output missing call_id', {})
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          content: outputToText(item.output),
        })
      } else if (type === 'reasoning' || type === 'item_reference' || type === 'computer_call_output' || type === 'mcp_call' || type === 'mcp_approval_response') {
        // Ignored items (e.g. reasoning between parallel calls) must not break
        // the tool-call grouping, so the container is intentionally kept.
        log('debug', 'responses input item ignored (no CC equivalent)', { itemType: type })
      } else if (item.role) {
        toolCallContainer = null
        messages.push({ role: item.role, content: convertContentParts(item.content) })
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

  const tools = convertTools(req.tools)
  if (tools) openaiReq.tools = tools
  const toolChoice = convertToolChoice(req.tool_choice)
  if (toolChoice !== undefined) openaiReq.tool_choice = toolChoice

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
}

export function createResponsesSseTranslator(model: string, responseId: string, createdAt: number) {
  let sequence = 0
  let outputIndex = 0
  const items: any[] = []
  let current: OpenItem | null = null
  let finishReason: string | null = null
  let usage: any = null
  let hasError = false
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
    const item: OpenItem = { kind: 'message', id: `msg_${uuid().slice(0, 12)}`, outputIndex: outputIndex++, text: '', args: '', name: '', callId: '' }
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
    const item: OpenItem = { kind: 'reasoning', id: `rs_${uuid().slice(0, 12)}`, outputIndex: outputIndex++, text: '', args: '', name: '', callId: '' }
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
      const item = {
        id: c.id, type: 'function_call', status: 'completed',
        call_id: c.callId, name: c.name, arguments: c.args,
      }
      items.push(item)
      out.push(event('response.output_item.done', { output_index: c.outputIndex, item }))
    }
    return out
  }

  const isDuplicateToolCallId = createToolCallIdGuard()

  function emitFunctionCall(callId: string, name: string, args: string): string[] {
    // 同一 id 二次出现必须跳过（见 createToolCallIdGuard），否则客户端回传重复
    // call_id，上游 400。
    if (isDuplicateToolCallId(callId)) {
      log('warn', 'cc duplicate tool-call id suppressed (stream)', { toolCallId: callId })
      return []
    }
    const out: string[] = []
    if (current) out.push(...closeCurrent())
    const item: OpenItem = {
      kind: 'function_call',
      id: `fc_${uuid().slice(0, 12)}`,
      outputIndex: outputIndex++,
      text: '',
      args,
      name,
      callId,
    }
    current = item
    out.push(event('response.output_item.added', {
      output_index: item.outputIndex,
      item: { id: item.id, type: 'function_call', status: 'in_progress', call_id: callId, name, arguments: '' },
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
      pendingToolInput = null
      const args = toolArgsToString(e.input)
      sawToolCall = true
      toolChars += args.length
      return emitFunctionCall(e.toolCallId || '', e.toolName || '', args)
    },
    'tool-input-start': (e: any) => {
      if (hasError) return
      pendingToolInput = {
        id: e.toolCallId || e.id || e.toolUseId || '',
        name: e.toolName || e.name || '',
        json: '',
      }
    },
    'tool-input-delta': (e: any) => {
      if (hasError) return
      const d = e.delta ?? e.text ?? e.partial_json ?? e.partialJson
        ?? e.data ?? e.json ?? e.value ?? e.input ?? ''
      const s = typeof d === 'string' ? d : JSON.stringify(d)
      if (!pendingToolInput) {
        pendingToolInput = { id: e.toolCallId || e.id || '', name: e.toolName || e.name || '', json: '' }
      } else {
        if (e.toolCallId || e.id) pendingToolInput.id = e.toolCallId || e.id
        if (e.toolName || e.name) pendingToolInput.name = e.toolName || e.name
      }
      if (s) pendingToolInput.json += s
    },
    'tool-input-end': (e: any) => {
      if (hasError) return
      const fullInput = e.input ?? e.json ?? null
      const id = e.toolCallId || e.id || pendingToolInput?.id || ''
      const name = e.toolName || e.name || pendingToolInput?.name || ''
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
      if (e.finishReason) finishReason = mergeFinishReason(finishReason, safeMapFinishReason(e.finishReason))
      if (e.usage) usage = mergeUsage(usage, e.usage)
    },
    'finish': (e: any) => {
      if (hasError) return
      if (e.finishReason) finishReason = mergeFinishReason(finishReason, safeMapFinishReason(e.finishReason))
      const incoming = e.totalUsage ?? e.usage
      if (incoming) usage = mergeUsage(usage, incoming)
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
      const status = finishReason === 'length' ? 'incomplete' : 'completed'
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
        ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
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
