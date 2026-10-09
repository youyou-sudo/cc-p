import { CcStreamParser } from '../../infra/cc-events'
import type { CcEventHooks } from '../../infra/cc-events'
import { anthropicUsage, isTruncatedStream, mapAnthropicStopReason, mapCcEventError, mapFinishReason, normalizeUsage, TRUNCATED_STREAM_MESSAGE } from '../../shared/errors'
import { ccToolArgsToString, ccToolCallId, ccToolName, createToolCallIdGuard, UNKNOWN_TOOL_NAME } from '../../shared/cc-types'
import { log } from '../../shared/logger'
import { shortUrl, redactLargeDataUrls, uuid } from '../../shared/util'
import { mapAnthropicServerTool } from '../../infra/builtin-tools'

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
  log('debug', 'unknown CC finishReason mapped to stop', { reason })
  return 'stop'
}
/**
 * Anthropic stop mapping with debug on unknown: unknown → end_turn is kept
 * (Anthropic SDK requires a known stop_reason) but logged so masking is visible.
 */
function safeMapAnthropicStopReason(finishReason: string): string {
  if (finishReason === 'tool_calls') return 'tool_use'
  if (finishReason === 'length') return 'max_tokens'
  if (finishReason === 'stop') return 'end_turn'
  const mapped = mapAnthropicStopReason(finishReason)
  log('debug', 'unknown stop reason mapped to end_turn', { finishReason })
  return mapped
}
/**
 * Multi-step priority: tool_use > max_tokens > end_turn.
 * First non-end_turn wins; a later end_turn must not overwrite max_tokens.
 */
function mergeAnthropicStopReason(current: string | null, incoming: string): string {
  const pri = (v: string | null): number => {
    if (v === 'tool_use') return 3
    if (v === 'max_tokens') return 2
    if (v === 'end_turn') return 1
    return 0
  }
  if (current == null) return incoming
  return pri(incoming) > pri(current) ? incoming : current
}
/** Length-based output estimate (len/4, min 1 for non-empty) — never +1/+20 hardcode. */
function estimateTokensForText(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

// Anthropic thinking 分片的 signature：官方 CLI 在 gateway 路线上就发空串
// （1.62.1 bundle 内 legacy 路径写死 signature:""），上游不校验其内容。
// 本地此前伪造 base64 密文属于凭空造数据，改为与官方一致的占位空串。
export const EMPTY_THINKING_SIGNATURE = ''

/** Extract a data-URL or plain URL from an Anthropic image/document source. */
function anthropicSourceToUrl(source: any): string {
  if (!source) return ''
  if (typeof source === 'string') return source
  if (source.url) return source.url
  if (source.data) {
    const media = source.media_type || source.mediaType || 'image/jpeg'
    return `data:${media};base64,${source.data}`
  }
  return ''
}

/** Anthropic 服务端（provider-executed）工具 type 前缀白名单：这些没有 input_schema，
 *  必须走服务端工具分支（映射或丢弃），绝不能被当成客户端 function 工具直传 ——
 *  直传会产出一个 name/描述都不可用的假工具。 */
const SERVER_TOOL_TYPE_PREFIXES = [
  'web_search',
  'web_fetch',
  'computer_',
  'text_editor_',
  'bash_',
  'code_execution',
  'memory_',
  'tool_search',
  'mcp_toolset',
]

function isAnthropicServerToolType(type: any): boolean {
  if (typeof type !== 'string') return false
  return SERVER_TOOL_TYPE_PREFIXES.some((p) => type === p || type.startsWith(p))
}

/** tool_result content → text, preserving image placeholders instead of dropping. */
function toolResultContentToText(content: any): string {
  if (typeof content === 'string') return redactLargeDataUrls(content)
  if (Array.isArray(content)) {
    return redactLargeDataUrls(content.map((c: any) => {
      if (c == null) return ''
      if (typeof c === 'string') return c
      if (c.type === 'text') return c.text || ''
      if (c.type === 'image') {
        const url = anthropicSourceToUrl(c.source)
        log('warn', 'tool_result image demoted to placeholder', { url: url ? shortUrl(url) : '(empty)' })
        return url ? `[image: ${shortUrl(url)}]` : '[image omitted]'
      }
      // 工具结果里的文件/附件分片：绝不 stringify 成文本。内联 base64 截图
      // （可达数 MB）随历史每轮重发会直接顶爆上下文，必须降级为占位符。
      if (c.type === 'file' || c.type === 'document' || c.type === 'input_file') {
        const name = c.filename || c.name || ''
        const uri = typeof c.uri === 'string' ? c.uri : (typeof c.url === 'string' ? c.url : anthropicSourceToUrl(c.source))
        const size = uri && uri.startsWith('data:') ? `, ${uri.length} chars inline` : ''
        return `[file: ${name || 'attachment'}${size}]`
      }
      if (c.text) return c.text
      return ''
    }).join(''))
  }
  if (content == null) return ''
  if (typeof content === 'object' && (content as any).text) return redactLargeDataUrls((content as any).text)
  return redactLargeDataUrls(String(content || ''))
}

export function convertAnthropicToOpenAI(anthropicReq: any): any {
  let systemPrompt = ''
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      systemPrompt = anthropicReq.system
    } else if (Array.isArray(anthropicReq.system)) {
      systemPrompt = anthropicReq.system
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
    }
  }

  const toolNameFromId: Record<string, string> = {}
  // 服务端工具声明（CC 工具名 → 客户端声明的 name），供 handler 决定是否挂
  // 代理侧代执行 tool-loop。非标准 OpenAI 字段，只在本地消费。
  const serverToolNames: Record<string, string> = {}
  const openaiMessages: any[] = []

  if (systemPrompt) {
    openaiMessages.push({ role: 'system', content: systemPrompt })
  }

  const messages = anthropicReq.messages || []
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const textParts: string[] = []
      const reasoningParts: string[] = []
      const toolCalls: any[] = []
      const imageParts: any[] = []
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }]
      for (const block of blocks) {
        if (block.type === 'text') {
          if (block.text) textParts.push(block.text)
        } else if (block.type === 'image') {
          // Assistant 历史图片不断点：收为 image_url 由 cc.ts 原样透传（与 user 路一致）。
          const url = anthropicSourceToUrl(block.source)
          if (url) {
            const imgPart: any = { type: 'image_url', image_url: { url } }
            if (block.cache_control?.type === 'ephemeral') imgPart.cache_control = { type: 'ephemeral' }
            imageParts.push(imgPart)
          }
        } else if (block.type === 'tool_use') {
          toolNameFromId[block.id] = block.name
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          })
        } else if (block.type === 'thinking') {
          // Preserve thinking history as reasoning_content (don't drop).
          if (block.thinking) reasoningParts.push(block.thinking)
        } else if (block.type === 'redacted_thinking') {
          reasoningParts.push('[redacted thinking omitted]')
        }
      }
      // Multi-text blocks joined with \n\n (preserve paragraph boundaries).
      const textContent = textParts.join('\n\n')
      // assistant content 形：纯文本走 string/null；含图片走数组（cc.ts assistant 分支透传 image_url）。
      let assistantContent: any = textContent || null
      if (imageParts.length > 0) {
        const arr: any[] = []
        if (textContent) arr.push({ type: 'text', text: textContent })
        arr.push(...imageParts)
        assistantContent = arr
      }
      const assistantMsg: any = { role: 'assistant', content: assistantContent }
      if (reasoningParts.length > 0) assistantMsg.reasoning_content = reasoningParts.join('\n\n')
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
      openaiMessages.push(assistantMsg)
    } else if (msg.role === 'user') {
      const contentParts: any[] = []
      const toolResults: any[] = []
      if (typeof msg.content === 'string') {
        if (msg.content) contentParts.push({ type: 'text', text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            if (block.text == null && !block.cache_control) continue
            const part: any = { type: 'text', text: block.text || '' }
            // Preserve ephemeral breakpoints per-part (don't collapse to first only).
            if (block.cache_control?.type === 'ephemeral') {
              part.cache_control = { type: 'ephemeral' }
            }
            contentParts.push(part)
          } else if (block.type === 'image') {
            // Pass through as OpenAI image_url (don't drop).
            const url = anthropicSourceToUrl(block.source)
            if (url) {
              const imgPart: any = { type: 'image_url', image_url: { url } }
              if (block.cache_control?.type === 'ephemeral') imgPart.cache_control = { type: 'ephemeral' }
              contentParts.push(imgPart)
            } else {
              contentParts.push({ type: 'text', text: '[image omitted]' })
            }
          } else if (block.type === 'document') {
            // Documents have no OpenAI equivalent; pass through as image_url when possible.
            const url = anthropicSourceToUrl(block.source)
            if (url) {
              const docPart: any = { type: 'image_url', image_url: { url } }
              if (block.cache_control?.type === 'ephemeral') docPart.cache_control = { type: 'ephemeral' }
              contentParts.push(docPart)
            } else {
              contentParts.push({ type: 'text', text: '[document omitted]' })
            }
          } else if (block.type === 'tool_result') {
            toolResults.push(block)
          } else if (block.type === 'tool_use') {
            // Defensive: tool_use should not appear in user turn, but don't drop.
            toolNameFromId[block.id] = block.name
          }
        }
      }
      for (const tr of toolResults) {
        const toolContent = toolResultContentToText(tr.content)
        const toolMsg: any = {
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: toolContent,
        }
        if (toolNameFromId[tr.tool_use_id]) toolMsg.name = toolNameFromId[tr.tool_use_id]
        // Pass through error flag (don't drop).
        if ((tr as any).is_error !== undefined) toolMsg.is_error = (tr as any).is_error
        openaiMessages.push(toolMsg)
      }
      // Pure-image messages (textContent=='' but images present) must still push.
      if (contentParts.length > 0) {
        openaiMessages.push({ role: 'user', content: contentParts })
      }
    }
  }

  const openaiReq: any = {
    // Default aligns with messages handler (claude-sonnet-4-6), not chat default.
    model: anthropicReq.model || 'claude-sonnet-4-6',
    messages: openaiMessages,
    max_tokens: anthropicReq.max_tokens || 64000,
    stream: anthropicReq.stream === true,
  }

  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    const tools: any[] = []
    for (const t of anthropicReq.tools) {
      // Anthropic 服务端工具（provider-executed，如 `{type:'web_search_20250305',
      // name:'web_search'}`）没有 input_schema：客户端自己不执行它，模型回一个
      // 普通 tool-call 就是死路（客户端报未知工具）。有 CC 对应能力的由代理代执行
      // —— 这里映射成 CC 的 web_search 声明并记录声明名，handler 据此挂 tool-loop。
      const mapped = mapAnthropicServerTool(t)
      if (mapped) {
        tools.push({
          type: 'function',
          function: {
            name: mapped.tool.name,
            description: mapped.tool.description,
            parameters: mapped.tool.parameters,
          },
        })
        if (mapped.tool.name === 'web_search') {
          serverToolNames.web_search = mapped.declaredName
          log('info', 'anthropic server tool mapped for proxy execution', {
            declaredType: mapped.declaredType,
            declaredName: mapped.declaredName,
            tool: mapped.tool.name,
          })
        }
        continue
      }
      // 已知服务端工具但没有 CC 对应能力（computer / text_editor / code_execution /
      // memory / tool_search 等）：丢弃并 warn（与 Responses 侧同口径，不硬映射）。
      if (isAnthropicServerToolType(t?.type)) {
        log('warn', 'anthropic server tool dropped (no CC counterpart)', { type: t.type, name: t?.name })
        continue
      }
      // 客户端 function 工具：description 兜底非空 —— 上游要求工具描述非空，
      // Anthropic 的 description 是可选字段，缺省时直传空串会被上游整轮 400。
      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || `Tool ${t.name}`,
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      })
    }
    if (tools.length > 0) openaiReq.tools = tools
  }

  if (anthropicReq.tool_choice) {
    const tc = anthropicReq.tool_choice
    if (tc.type === 'auto' || tc.type === undefined) {
      openaiReq.tool_choice = 'auto'
    } else if (tc.type === 'any') {
      openaiReq.tool_choice = 'required'
    } else if (tc.type === 'tool') {
      openaiReq.tool_choice = { type: 'function', function: { name: tc.name } }
    } else if (tc.type === 'none') {
      openaiReq.tool_choice = 'none'
    }
    // Pass through parallel-use switch (don't silently drop).
    if (tc.disable_parallel_tool_use !== undefined) {
      if (typeof openaiReq.tool_choice === 'string') {
        openaiReq.tool_choice = { type: openaiReq.tool_choice, disable_parallel_tool_use: tc.disable_parallel_tool_use }
      } else if (openaiReq.tool_choice && typeof openaiReq.tool_choice === 'object') {
        openaiReq.tool_choice.disable_parallel_tool_use = tc.disable_parallel_tool_use
      }
    }
  }

  if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature
  if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p
  if (anthropicReq.top_k !== undefined) {
    // OpenAI/CC has no top_k; pass through for CC to ignore, debug-log so it's visible.
    openaiReq.top_k = anthropicReq.top_k
    log('debug', 'anthropic top_k passthrough (CC ignores)', { top_k: anthropicReq.top_k })
  }
  if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences
  if (anthropicReq.metadata?.user_id) openaiReq.user = anthropicReq.metadata.user_id

  if (anthropicReq.thinking) {
    const t = anthropicReq.thinking
    if (t.type === 'disabled' || t.type === 'none') {
    } else if (t.type === 'adaptive') {
      openaiReq.reasoning_effort = t.effort ?? 'medium'
    } else if (t.budget_tokens !== undefined) {
      // 官方档位全集 low<medium<high<xhigh<max（bundle 内 41 处 xhigh）；
      // 本地原先把 >=10k 一律压到 high，丢失 xhigh/max。切点按数量级放大，
      // 保持与官方 5 档语义一致（budget 越大档位越高）。
      if (t.budget_tokens >= 50000) openaiReq.reasoning_effort = 'max'
      else if (t.budget_tokens >= 25000) openaiReq.reasoning_effort = 'xhigh'
      else if (t.budget_tokens >= 10000) openaiReq.reasoning_effort = 'high'
      else if (t.budget_tokens >= 5000) openaiReq.reasoning_effort = 'medium'
      else openaiReq.reasoning_effort = 'low'
    }
  }

  // 服务端工具映射的反向表（CC 工具名 → 客户端声明的 name）：只在声明了服务端
  // 工具时挂载。下游流式/非流式 handler 看到工具名即代执行（见 tool-loop 的
  // executors），绝不把 provider-executed 调用透给客户端。
  if (Object.keys(serverToolNames).length > 0) openaiReq._serverToolNames = serverToolNames

  return openaiReq
}

export interface AnthropicStreamContext {
  bytesReceived: number
  lastCcEvent: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  upstreamError: { status: number; body: any } | null
}

export function createAnthropicSseTranslator(
  model: string,
  messageId: string,
  ctx: AnthropicStreamContext,
) {
  let nextBlockIndex = 0
  let currentBlockIndex = -1
  let currentBlockType: string | null = null
  let blockStarted = false
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let cacheWriteTokens = 0
  let stopReason: string | null = null
  let hasError = false
  // sawFinish: CC 正常结束必发 finish（或 finish-step）；缺失 + 有内容 + 无错误 = 截断。
  let sawFinish = false
  let currentThinkingText = ''
  // Zero-output caliber: text / thinking / tool any-present counts as non-zero.
  let hasText = false
  let hasThinking = false
  let hasToolCall = false
  let textChars = 0
  let thinkingChars = 0
  let toolInputChars = 0
  // tool-input-* incremental accumulation (large params assembled here).
  let pendingToolInput: { id: string; name: string; json: string } | null = null

  function closeBlock(): string {
    if (blockStarted) {
      const idx = currentBlockIndex
      const type = currentBlockType
      let out = ''
      if (type === 'thinking') {
        out += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: EMPTY_THINKING_SIGNATURE } })}\n\n`
        currentThinkingText = ''
      }
      blockStarted = false
      currentBlockType = null
      return out + `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`
    }
    return ''
  }

  function startBlock(type: string, contentBlock: any): string {
    if (!blockStarted || currentBlockType !== type) {
      const close = closeBlock()
      currentBlockIndex = nextBlockIndex++
      currentBlockType = type
      blockStarted = true
      return close + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: contentBlock })}\n\n`
    }
    return ''
  }

  function startTextBlock(): string {
    return startBlock('text', { type: 'text', text: '' })
  }

  function startThinkingBlock(): string {
    return startBlock('thinking', { type: 'thinking', thinking: '' })
  }

  const isDuplicateToolCallId = createToolCallIdGuard()

  function emitToolUseBlock(id: string, name: string, inputJson: string): string[] {
    // 同一 id 二次出现必须跳过（见 createToolCallIdGuard），否则客户端回传重复
    // tool_use id，上游 400。
    if (isDuplicateToolCallId(id)) {
      log('debug', 'cc duplicate tool-call id suppressed (stream)', { toolCallId: id })
      return []
    }
    // 无参数调用必须发 '{}'：空串不是合法 JSON，客户端解析失败会丢掉这次调用，
    // 写进历史后再回放就变成 arguments:""（见 cc-types.ccToolArgsToString）。
    inputJson = ccToolArgsToString(inputJson)
    const out: string[] = []
    const close = closeBlock()
    if (close) out.push(close)
    const finalId = id || `toolu_${uuid().slice(0, 12)}`
    // Anthropic 契约要求 tool_use.name 非空；空名会被 SDK/客户端判为无效工具调用。
    if (!name) {
      log('warn', 'cc tool-call empty name fallback', { path: '/v1/messages', toolCallId: finalId })
    }
    const tcIndex = nextBlockIndex++
    out.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: tcIndex, content_block: { type: 'tool_use', id: finalId, name: name || UNKNOWN_TOOL_NAME, input: {} } })}\n\n`)
    out.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: tcIndex, delta: { type: 'input_json_delta', partial_json: inputJson } })}\n\n`)
    out.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: tcIndex })}\n\n`)
    hasToolCall = true
    toolInputChars += inputJson.length
    // NOTE: outputTokens here is authoritative usage only (set in
    // handleFinishStep). Length estimates are applied solely as a backfill
    // in finishEvents when upstream reports 0/missing — never incremented
    // per-event (avoids +1/+20 hardcode and double-count with deltas).
    return out
  }

  function flushPendingToolInput(): string[] {
    if (pendingToolInput && pendingToolInput.json) {
      const { id, name, json } = pendingToolInput
      pendingToolInput = null
      return emitToolUseBlock(id, name, json)
    }
    pendingToolInput = null
    return []
  }

  const messageStartFrame = `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })}\n\n`

  const parser = new CcStreamParser()

  const hooks: CcEventHooks = {
    'reasoning-delta': (event: any) => {
      const text = textOrDelta(event)
      if (!text) return
      // Thinking counts toward non-zero-output (via hasThinking + char counts
      // backfilled in finishEvents), but outputTokens stays authoritative usage.
      hasThinking = true
      thinkingChars += text.length
      const open = startThinkingBlock()
      currentThinkingText += text
      return open + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'thinking_delta', thinking: text } })}\n\n`
    },

    'text-delta': (event: any) => {
      const text = textOrDelta(event)
      if (!text) return
      hasText = true
      textChars += text.length
      const open = startTextBlock()
      return open + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text } })}\n\n`
    },

    'tool-call': (event: any) => {
      if (hasError) return
      const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input ?? {})
      // 最终 tool-call 可能只带 input：先取回 tool-input-* 缓存里的 id/name 再清空，
      // 否则会丢掉上游早先给出的工具名，发出空 name 的 tool_use 块。
      const id = ccToolCallId(event) || pendingToolInput?.id || ''
      const name = ccToolName(event) || pendingToolInput?.name || ''
      pendingToolInput = null
      return emitToolUseBlock(id, name, input)
    },

    'tool-input-start': (event: any) => {
      if (hasError) return
      pendingToolInput = {
        id: ccToolCallId(event) || pendingToolInput?.id || '',
        name: ccToolName(event) || pendingToolInput?.name || '',
        json: '',
      }
    },

    'tool-input-delta': (event: any) => {
      if (hasError) return
      const d = event.delta ?? event.text ?? event.partial_json ?? event.partialJson
        ?? event.data ?? event.json ?? event.value ?? event.input ?? ''
      const s = typeof d === 'string' ? d : JSON.stringify(d)
      const id = ccToolCallId(event)
      const name = ccToolName(event)
      if (!pendingToolInput) {
        pendingToolInput = { id, name, json: '' }
      } else {
        if (id) pendingToolInput.id = id
        if (name) pendingToolInput.name = name
      }
      if (s) {
        pendingToolInput.json += s
        // Track chars for the finishEvents backfill estimate; outputTokens
        // stays authoritative usage (see emitToolUseBlock note).
        toolInputChars += s.length
        hasToolCall = true
      }
    },

    'tool-input-end': (event: any) => {
      if (hasError) return
      const fullInput = event.input ?? event.json ?? null
      // End carries the complete input when present; otherwise emit the
      // buffered incremental payload. Either way pending is cleared so a
      // later flush/finishEvents cannot double-emit the same block.
      const id = ccToolCallId(event) || pendingToolInput?.id || ''
      const name = ccToolName(event) || pendingToolInput?.name || ''
      const argsStr = fullInput != null
        ? (typeof fullInput === 'string' ? fullInput : JSON.stringify(fullInput ?? {}))
        : (pendingToolInput?.json || '')
      pendingToolInput = null
      if (argsStr || id || name) return emitToolUseBlock(id, name, argsStr)
    },

    'finish-step': handleFinishStep,
    'finish': handleFinishStep,

    // 上游 abort：生成被中途取消，不是 finish。handler 的 sawFinish 判定会把
    // 「有内容但无 finish」识别为截断，绝不回报正常 end_turn 成功帧。
    'abort': () => {
      log('warn', 'CC stream aborted by upstream', {
        path: '/v1/messages',
        model,
        messageId,
        lastCcEvent: parser.lastCcEvent || '(none)',
        bytesReceived: ctx.bytesReceived,
        hasText,
        hasThinking,
        hasToolCall,
      })
    },

    'error': (event: any) => {
      hasError = true
      const upstreamError = mapCcEventError(event)
      ctx.upstreamError = upstreamError
      log('warn', 'CC stream error', {
        path: '/v1/messages',
        model,
        messageId,
        streaming: true,
        message: (event as any)?.error?.message || (event as any)?.message || 'Unknown error',
        mappedStatus: upstreamError.status,
        mappedType: (upstreamError.body as any)?.error?.type,
        lastCcEvent: parser.lastCcEvent || '(none)',
        bytesReceived: ctx.bytesReceived,
      })
      const retry = (upstreamError.body as any)?.retry_after;
      return `event: error\ndata: ${JSON.stringify({ type: 'error', error: upstreamError.body.error, ...(retry !== undefined ? { retry_after: retry } : {}) })}\n\n`
    },
  }

  function handleFinishStep(event: any): void {
    // Suppress post-error finish (error wins).
    if (hasError) return
    sawFinish = true
    if (event.finishReason) {
      const mapped = safeMapAnthropicStopReason(safeMapFinishReason(event.finishReason))
      stopReason = mergeAnthropicStopReason(stopReason, mapped)
    }
    const u = event.totalUsage || event.usage
    if (u) {
      normalizeUsage(u)
      // Accumulate, never reset: missing fields preserve earlier step values.
      // String numerals tolerated via toNum (NaN → 0 handled at read time).
      if (u.inputTokens != null) inputTokens = toNum(u.inputTokens)
      if (u.outputTokens != null) outputTokens = toNum(u.outputTokens)
      if (u.cachedInputTokens != null) cachedInputTokens = toNum(u.cachedInputTokens)
      const cw = u.inputTokenDetails?.cacheWriteTokens ?? (u as any).cacheWriteTokens
      if (cw != null) cacheWriteTokens = toNum(cw)
    }
    ctx.inputTokens = inputTokens
    ctx.outputTokens = outputTokens
    ctx.cachedInputTokens = cachedInputTokens
    ctx.cacheWriteTokens = cacheWriteTokens
  }

  return {
    startEvents(): string[] {
      return [messageStartFrame]
    },

    /** 有内容、无错误、却未收到 finish → 截断；handler 据此写错误尾而非成功帧。 */
    get truncated(): boolean {
      return isTruncatedStream(sawFinish, hasText || hasThinking || hasToolCall, hasError)
    },

    parseChunk(bytes: Uint8Array): string[] {
      ctx.bytesReceived += bytes.byteLength
      const out = parser.push(bytes, hooks)
      ctx.lastCcEvent = parser.lastCcEvent
      return out
    },

    flush(): string[] {
      const out = parser.flush(hooks)
      ctx.lastCcEvent = parser.lastCcEvent
      // Incremental-only tool calls (deltas without a final tool-call/end)
      // must still surface when the stream ends without a finish event.
      if (!hasError) out.push(...flushPendingToolInput())
      return out
    },

    finishEvents(): string[] {
      // 截断优先于一切成功终帧：有内容、无上游错误、却从未收到 finish。
      // 保留已产出的部分块，然后发错误帧——绝不发 end_turn 的 message_delta，
      // 否则客户端会把半截回答当成完整回答（这正是「说到一半就停」被误报成功的原因）。
      const preFlushHasContent = hasText || hasThinking || hasToolCall
      if (!hasError && isTruncatedStream(sawFinish, preFlushHasContent, false)) {
        const out: string[] = []
        out.push(...flushPendingToolInput())
        const close = closeBlock()
        if (close) out.push(close)
        log('warn', 'Stream truncated before finish (anthropic)', {
          path: '/v1/messages',
          model,
          messageId,
          lastCcEvent: parser.lastCcEvent || '(none)',
          bytesReceived: ctx.bytesReceived,
          inputTokens,
          outputTokens,
        })
        out.push(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: TRUNCATED_STREAM_MESSAGE }, retry_after: 10 })}\n\n`)
        out.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
        return out
      }
      // Incremental-only tool calls flush here when finish arrives without a final tool-call.
      if (!hasError) {
        const pending = flushPendingToolInput()
        if (pending.length > 0) {
          // Emit pending tool blocks before the terminal frames.
          const out: string[] = [...pending]
          const close = closeBlock()
          if (close) out.push(close)
          const hasContent = hasText || hasThinking || hasToolCall
          let outTokens = outputTokens
          if (outTokens === 0 && hasContent) {
            const est = Math.ceil((textChars + thinkingChars + toolInputChars) / 4) || 1
            outTokens = est
            outputTokens = est
            ctx.outputTokens = est
          }
          if (outTokens === 0) {
            out.push(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`)
          } else {
            out.push(`event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: stopReason || 'end_turn' },
              // output_tokens 用零输出守卫修正后的 outTokens（上游缺失时是长度估算），
              // 其余字段由 anthropicUsage 按 Anthropic 契约拆分缓存口径。
              usage: anthropicUsage({ inputTokens, outputTokens: outTokens, cachedInputTokens, inputTokenDetails: { cacheWriteTokens, cacheReadTokens: cachedInputTokens } }),
            })}\n\n`)
            out.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
          }
          return out
        }
      }
      if (hasError) {
        // Terminate the SSE stream cleanly after an error frame.
        const out: string[] = []
        const close = closeBlock()
        if (close) out.push(close)
        out.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
        return out
      }
      const out: string[] = []
      const close = closeBlock()
      if (close) out.push(close)

      // Content-aware zero guard: text / thinking / tool any-present counts
      // as non-zero; backfill a length estimate when upstream reports 0/missing.
      const zeroGuardHasContent = hasText || hasThinking || hasToolCall
      let outTokens = outputTokens
      if (outTokens === 0 && zeroGuardHasContent) {
        const est = Math.ceil((textChars + thinkingChars + toolInputChars) / 4)
        if (est > 0) {
          outTokens = est
          outputTokens = est
          ctx.outputTokens = est
        } else {
          outTokens = 1
          outputTokens = 1
          ctx.outputTokens = 1
        }
      }
      if (outTokens === 0) {
        out.push(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`)
      } else {
        out.push(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason || 'end_turn' },
          usage: anthropicUsage({ inputTokens, outputTokens: outTokens, cachedInputTokens, inputTokenDetails: { cacheWriteTokens, cacheReadTokens: cachedInputTokens } }),
        })}\n\n`)

        out.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
      }
      return out
    },
  }
}
