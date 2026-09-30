// OpenAI SSE translator: CC NDJSON → `chat.completion.chunk` frames.
// Pure streaming translation, no I/O.

import { isTruncatedStream, mapCcEventError, mapFinishReason, normalizeUsage } from '../../shared/errors'
import { ccToolCallId, ccToolName, createToolCallIdGuard, UNKNOWN_TOOL_NAME } from '../../shared/cc-types'
import { log } from '../../shared/logger'
import { CcStreamParser } from '../../infra/cc-events'
import type { CcEventHooks } from '../../infra/cc-events'

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
export function zeroUsageChunk(completionId: string, created: number, model: string): string {
  return `data: ${JSON.stringify({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
  })}\n\n`
}

function makeChunk(id: string, created: number, model: string, delta: any, finishReason: string | null, usage: any): string {
  const chunk: any = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  }
  if (usage) chunk.usage = usage
  return `data: ${JSON.stringify(chunk)}\n\n`
}

export function createSseTranslator(model: string, completionId: string, created: number) {
  let chunkIndex = 0
  let finishReason: string | null = null
  let usage: any = null
  let toolCallIndex = 0
  let hasError = false
  // Zero-output caliber: text / reasoning / tool any-present counts as non-zero (aligns with messages side).
  let hasText = false
  let hasReasoning = false
  let hasToolCall = false
  // sawFinish: 是否收到过 finish/finish-step。CC 正常结束必发 finish；
  // 缺失 + 有内容 + 无错误 = 上游截断（abort / 断流），必须走错误帧而非成功。
  let sawFinish = false
  let textChars = 0
  let reasoningChars = 0
  // tool-input-* incremental accumulation for large params.
  let pendingToolInput: { id: string; name: string; json: string } | null = null

  const parser = new CcStreamParser()
  const state = {
    upstreamError: null as { status: number; body: any } | null,
  }
  const inputTokens = { value: 0 }
  const outputTokens = { value: 0 }
  const cachedInputTokens = { value: 0 }
  let bytesReceived = 0

  const isDuplicateToolCallId = createToolCallIdGuard()

  function emitToolCallChunk(id: string, name: string, argsStr: string): string {
    // 同一 id 二次出现（tool-call 后又来 tool-input-end，或上游重放）必须跳过：
    // 重复 tool_call_id 会让客户端回传两份相同 id，上游 400 掉整个会话。
    if (isDuplicateToolCallId(id)) {
      log('debug', 'cc duplicate tool-call id suppressed (stream)', { toolCallId: id })
      return ''
    }
    hasToolCall = true
    const finalId = id || `call_${Date.now()}_${toolCallIndex}`
    // OpenAI 契约要求 function.name 非空；opencode 的 ToolStream.appendOrStart 对
    // 空串 name 会直接抛 "OpenAI Chat tool call delta is missing id or name"，
    // 整条流失败。上游确实没给名字时兜底占位名并记日志。
    if (!name) {
      log('warn', 'cc tool-call empty name fallback', { path: '/v1/chat/completions', toolCallId: finalId })
    }
    const tcEntry = { index: toolCallIndex, id: finalId, type: 'function', function: { name: name || UNKNOWN_TOOL_NAME, arguments: argsStr } }
    const delta = chunkIndex === 0
      ? { role: 'assistant', content: null, tool_calls: [tcEntry] }
      : { tool_calls: [tcEntry] }
    chunkIndex++
    toolCallIndex++
    return makeChunk(completionId, created, model, delta, null, null)
  }

  function flushPendingToolInput(): string | null {
    if (pendingToolInput && pendingToolInput.json) {
      const { id, name, json } = pendingToolInput
      pendingToolInput = null
      return emitToolCallChunk(id, name, json)
    }
    pendingToolInput = null
    return null
  }

  const hooks: CcEventHooks = {
    'text-delta': (event: any) => {
      const text = textOrDelta(event)
      if (!text) return
      hasText = true
      textChars += text.length
      const delta = chunkIndex === 0 ? { role: 'assistant', content: text } : { content: text }
      chunkIndex++
      return makeChunk(completionId, created, model, delta, null, null)
    },
    'reasoning-delta': (event: any) => {
      const text = textOrDelta(event)
      if (!text) return
      hasReasoning = true
      reasoningChars += text.length
      // NOTE: reasoning_content is NOT an official OpenAI field; kept for
      // client compatibility (codex-style consumers read it). Official
      // OpenAI only defines role/content/tool_calls/refusal.
      const delta = chunkIndex === 0 ? { role: 'assistant', reasoning_content: text } : { reasoning_content: text }
      chunkIndex++
      return makeChunk(completionId, created, model, delta, null, null)
    },
    'tool-call': (event: any) => {
      const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input ?? {})
      // 最终 tool-call 可能只带 input：先把 tool-input-* 缓存里的 id/name 取回
      // 再清空，否则会丢掉上游早先给出的工具名、发出空 name（见 emitToolCallChunk）。
      const id = ccToolCallId(event) || pendingToolInput?.id || ''
      const name = ccToolName(event) || pendingToolInput?.name || ''
      pendingToolInput = null
      return emitToolCallChunk(id, name, args)
    },
    'tool-input-start': (event: any) => {
      pendingToolInput = {
        id: ccToolCallId(event) || pendingToolInput?.id || '',
        name: ccToolName(event) || pendingToolInput?.name || '',
        json: '',
      }
    },
    'tool-input-delta': (event: any) => {
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
      if (s) pendingToolInput.json += s
    },
    'tool-input-end': (event: any) => {
      const fullInput = event.input ?? event.json ?? null
      // End carries the complete input when present; otherwise emit the
      // buffered incremental payload. Either way pending is cleared so a
      // later finish/flush cannot double-emit the same call.
      const id = ccToolCallId(event) || pendingToolInput?.id || ''
      const name = ccToolName(event) || pendingToolInput?.name || ''
      const argsStr = fullInput != null
        ? (typeof fullInput === 'string' ? fullInput : JSON.stringify(fullInput ?? {}))
        : (pendingToolInput?.json || '')
      pendingToolInput = null
      if (argsStr || id || name) return emitToolCallChunk(id, name, argsStr)
    },
    'finish-step': (event: any) => {
      if (hasError) return
      sawFinish = true
      if (event.finishReason) finishReason = mergeFinishReason(finishReason, safeMapFinishReason(event.finishReason))
      if (event.usage) {
        // Accumulate, never reset: only overwrite fields the step reports,
        // preserving earlier step values when a step omits them.
        usage = usage || {}
        if (event.usage.inputTokens != null) {
          usage.inputTokens = event.usage.inputTokens
          inputTokens.value = toNum(event.usage.inputTokens)
        }
        if (event.usage.outputTokens != null) {
          usage.outputTokens = event.usage.outputTokens
          outputTokens.value = toNum(event.usage.outputTokens)
        }
        if (event.usage.cachedInputTokens != null) {
          usage.cachedInputTokens = event.usage.cachedInputTokens
          cachedInputTokens.value = toNum(event.usage.cachedInputTokens)
        }
        if (event.usage.inputTokenDetails != null) usage.inputTokenDetails = event.usage.inputTokenDetails
      }
    },
    'finish': (event: any) => {
      // Suppress any finish chunk after an upstream error (error wins).
      if (hasError) return
      sawFinish = true
      const flushed = flushPendingToolInput()
      const fr = finishReason || safeMapFinishReason(event.finishReason || 'stop')
      const u = event.totalUsage || event.usage || usage || {}
      normalizeUsage(u)
      // Accumulate, never reset: missing fields keep previously seen step values.
      if (u.inputTokens == null && usage?.inputTokens != null) u.inputTokens = usage.inputTokens
      if (u.outputTokens == null && usage?.outputTokens != null) u.outputTokens = usage.outputTokens
      if (u.cachedInputTokens == null && usage?.cachedInputTokens != null) u.cachedInputTokens = usage.cachedInputTokens
      inputTokens.value = toNum(u.inputTokens)
      // Zero-output caliber: text / reasoning / tool any-present counts as
      // non-zero. When upstream reports 0/missing output but we emitted
      // content, backfill a length-based estimate so abort paths don't treat
      // a real answer as zero-output (aligns with messages side).
      let outTokens = toNum(u.outputTokens)
      if (outTokens === 0 && (hasText || hasReasoning || hasToolCall)) {
        const est = Math.ceil((textChars + reasoningChars) / 4) + (hasToolCall && textChars + reasoningChars === 0 ? 1 : 0)
        if (est > 0) {
          outTokens = est
          u.outputTokens = est
        }
      }
      outputTokens.value = outTokens
      cachedInputTokens.value = toNum(u.cachedInputTokens)
      const openaiUsage = {
        prompt_tokens: toNum(u.inputTokens),
        completion_tokens: outTokens,
        total_tokens: toNum(u.inputTokens) + outTokens,
        prompt_tokens_details: { cached_tokens: toNum(u.cachedInputTokens) },
      }
      log('info', 'OpenAI stream finish', {
        path: '/v1/chat/completions',
        model,
        completionId,
        streaming: true,
        inputTokens: inputTokens.value,
        outputTokens: outputTokens.value,
        cachedInputTokens: cachedInputTokens.value,
      })
      const finishChunk = makeChunk(completionId, created, model, {}, fr, openaiUsage)
      return flushed ? [flushed, finishChunk] : finishChunk
    },
    'error': (event: any) => {
      hasError = true
      const msg = event.error?.message || event.message || 'Unknown error'
      state.upstreamError = mapCcEventError(event)
      log('warn', 'CC stream error', {
        path: '/v1/chat/completions',
        model,
        completionId,
        streaming: true,
        message: msg,
        lastCcEvent: parser.lastCcEvent || '(none)',
        bytesReceived,
        mappedStatus: state.upstreamError.status,
        mappedType: state.upstreamError.body?.error?.type,
      })
    },
    // 上游 abort：生成被中途取消。本身不是一个错误帧（错误由客户端断流等
    // 路径自行处理），但必须让收尾逻辑知道「这不是 finish」——否则会被当成
    // 正常 stop 成功返回半截内容。sawFinish 保持 false 即可被截断判定捕获。
    'abort': () => {
      log('warn', 'CC stream aborted by upstream', {
        path: '/v1/chat/completions',
        model,
        completionId,
        lastCcEvent: parser.lastCcEvent || '(none)',
        bytesReceived,
        hasText,
        hasReasoning,
        hasToolCall,
      })
    },
  }

  return {
    get lastCcEvent() {
      return parser.lastCcEvent
    },
    get upstreamError() {
      return state.upstreamError
    },
    /** 无上游错误、有内容、却一次 finish 都没收到 → 截断（不得回报成功）。 */
    get truncated() {
      return isTruncatedStream(sawFinish, hasText || hasReasoning || hasToolCall, hasError)
    },
    get inputTokens() {
      return inputTokens.value
    },
    get outputTokens() {
      return outputTokens.value
    },
    get cachedInputTokens() {
      return cachedInputTokens.value
    },
    get bytesReceived() {
      return bytesReceived
    },
    get rawUsage() {
      return {
        input_tokens: toNum(inputTokens.value),
        output_tokens: toNum(outputTokens.value),
        cached_tokens: toNum(cachedInputTokens.value),
      }
    },

    parseChunk(bytes: Uint8Array): string[] {
      bytesReceived += bytes.byteLength
      return parser.push(bytes, hooks)
    },

    flush(): string[] {
      const out = parser.flush(hooks)
      // Incremental-only tool calls (deltas without a final tool-call event)
      // must still surface when the stream ends without a finish event.
      const pending = flushPendingToolInput()
      if (pending) out.push(pending)
      return out
    },

    getDoneEvent(): string {
      return 'data: [DONE]\n\n'
    },
  }
}

export type ChatStreamTranslator = ReturnType<typeof createSseTranslator>
