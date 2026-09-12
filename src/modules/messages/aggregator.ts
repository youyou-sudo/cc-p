import { CcStreamParser } from '../../infra/cc-events'
import type { CcEventHooks } from '../../infra/cc-events'
import { mapAnthropicStopReason, mapCcEventError, mapFinishReason, normalizeUsage } from '../../shared/errors'
import { uuid } from '../../shared/util'
import { fakeThinkingSignature } from './translator'

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
 * First non-stop wins; length must not be overwritten by a later stop.
 */
function mergeFinishReason(current: string, incoming: string): string {
  const pri = (v: string): number => {
    if (v === 'tool_calls') return 3
    if (v === 'length') return 2
    if (v === 'stop') return 1
    return 0
  }
  return pri(incoming) > pri(current) ? incoming : current
}
/**
 * Accumulate usage without reset: only overwrite fields present in incoming,
 * preserving earlier step values when a step omits them.
 */
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
function toolArgsToString(input: any): string {
  return typeof input === 'string' ? input : JSON.stringify(input ?? {})
}

/** 从已聚合 CC usage 取真实上报口径的 rawUsage（只加字段，不改状态码分支）。 */
export function rawUsageFromCcUsageAnthropic(u: any): { input_tokens: number; output_tokens: number; cached_tokens: number } {
  return {
    input_tokens: toNum(u?.inputTokens),
    output_tokens: toNum(u?.outputTokens),
    cached_tokens: toNum(u?.cachedInputTokens),
  }
}

export function buildAnthropicResponse(model: string, fullText: string, toolCalls: any[] | null, finishReason: string, usage: any, thinkingText: string): any {
  const content: any[] = []
  // fakeThinkingSignature kept: Anthropic requires a signature for thinking
  // blocks; upstream gives none, so we synthesize a deterministic placeholder.
  if (thinkingText) content.push({ type: 'thinking', thinking: thinkingText, signature: fakeThinkingSignature(thinkingText) })
  if (fullText) content.push({ type: 'text', text: fullText })
  if (toolCalls) {
    for (const tc of toolCalls) {
      const rawArgs = tc.function?.arguments
      let input: any
      try {
        input = JSON.parse(rawArgs)
      } catch {
        // Pass through the original string instead of silently dropping to {} —
        // callers can see the malformed payload instead of a misleading empty object.
        input = typeof rawArgs === 'string' ? rawArgs : (rawArgs ?? {})
      }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
    }
  }
  return {
    id: `msg_${uuid().slice(0, 12)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapAnthropicStopReason(safeMapFinishReason(finishReason || 'stop')),
    stop_sequence: null,
    usage: (() => {
      const u = usage || {}
      normalizeUsage(u)
      return {
        input_tokens: toNum(u.inputTokens),
        output_tokens: toNum(u.outputTokens),
        cache_creation_input_tokens: toNum(u.inputTokenDetails?.cacheWriteTokens),
        cache_read_input_tokens: toNum(u.cachedInputTokens),
      }
    })(),
  }
}

export interface MessagesAggregate {
  fullText: string
  thinkingText: string
  toolCalls: any[] | null
  finishReason: string
  usage: any
  upstreamError: { status: number; body: any } | null
}

export function createMessagesAggregator(opts?: { onEventError?: (event: any, mapped: { status: number; body: any }) => void }): {
  get lastCcEvent(): string
  push(bytes: Uint8Array): void
  flush(): void
  result(): MessagesAggregate
} {
  let fullText = ''
  let thinkingText = ''
  let toolCalls: any[] | null = null
  let finishReason = 'stop'
  let usage: any = null
  let upstreamError: { status: number; body: any } | null = null
  // tool-input-* incremental accumulation for large params.
  let pendingToolInput: { id: string; name: string; json: string } | null = null

  function pushToolCall(id: string, name: string, argsStr: string): void {
    toolCalls = toolCalls || []
    toolCalls.push({
      id: id || ('call_' + uuid().slice(0, 8)),
      type: 'function',
      function: { name: name || '', arguments: argsStr },
    })
  }

  function flushPendingToolInput(): void {
    if (pendingToolInput && pendingToolInput.json) {
      pushToolCall(pendingToolInput.id, pendingToolInput.name, pendingToolInput.json)
    }
    pendingToolInput = null
  }

  const parser = new CcStreamParser()
  const hooks: CcEventHooks = {
    'text-delta': (event: any) => { fullText += textOrDelta(event) },
    'reasoning-delta': (event: any) => { thinkingText += textOrDelta(event) },
    'tool-call': (event: any) => {
      pushToolCall(
        event.toolCallId || pendingToolInput?.id || '',
        event.toolName || pendingToolInput?.name || '',
        toolArgsToString(event.input),
      )
      pendingToolInput = null
    },
    'tool-input-start': (event: any) => {
      pendingToolInput = {
        id: event.toolCallId || event.id || event.toolUseId || pendingToolInput?.id || '',
        name: event.toolName || event.name || pendingToolInput?.name || '',
        json: '',
      }
    },
    'tool-input-delta': (event: any) => {
      const d = event.delta ?? event.text ?? event.partial_json ?? event.partialJson
        ?? event.data ?? event.json ?? event.value ?? event.input ?? ''
      const s = typeof d === 'string' ? d : JSON.stringify(d)
      if (!pendingToolInput) {
        pendingToolInput = {
          id: event.toolCallId || event.id || '',
          name: event.toolName || event.name || '',
          json: '',
        }
      } else {
        if (event.toolCallId || event.id) pendingToolInput.id = event.toolCallId || event.id
        if (event.toolName || event.name) pendingToolInput.name = event.toolName || event.name
      }
      if (s) pendingToolInput.json += s
    },
    'tool-input-end': (event: any) => {
      const fullInput = event.input ?? event.json ?? null
      // End carries the complete input when present; otherwise emit the
      // buffered incremental payload. Either way pending is cleared so a
      // later result() flush cannot double-emit.
      const id = event.toolCallId || event.id || pendingToolInput?.id || ''
      const name = event.toolName || event.name || pendingToolInput?.name || ''
      const argsStr = fullInput != null ? toolArgsToString(fullInput) : (pendingToolInput?.json || '')
      if (argsStr || id || name) pushToolCall(id, name, argsStr)
      pendingToolInput = null
    },
    'finish-step': (event: any) => {
      if (event.finishReason) finishReason = mergeFinishReason(finishReason, safeMapFinishReason(event.finishReason))
      if (event.usage) usage = mergeUsage(usage, event.usage)
    },
    'finish': (event: any) => {
      if (event.finishReason) finishReason = mergeFinishReason(finishReason, safeMapFinishReason(event.finishReason))
      const incoming = event.totalUsage ?? event.usage
      if (incoming) usage = mergeUsage(usage, incoming)
    },
    'error': (event: any) => {
      const mapped = mapCcEventError(event)
      upstreamError = mapped
      opts?.onEventError?.(event, mapped)
    },
  }

  return {
    get lastCcEvent() {
      return parser.lastCcEvent
    },

    push(bytes: Uint8Array): void {
      parser.push(bytes, hooks)
    },

    flush(): void {
      parser.flush(hooks)
    },

    result(): MessagesAggregate {
      flushPendingToolInput()
      // Content-aware zero guard: text/reasoning/tool any-present must not
      // report 0 output when finish omits usage (avoids misleading 0).
      const hasContent = !!fullText || !!thinkingText || !!toolCalls
      if (hasContent) {
        let est = Math.ceil((fullText.length + thinkingText.length) / 4)
        if (toolCalls) {
          for (const tc of toolCalls) {
            const a = tc.function?.arguments
            const s = typeof a === 'string' ? a : JSON.stringify(a ?? {})
            est += Math.ceil(s.length / 4)
          }
          if (toolCalls.length > 0 && est === 0) est = 1
        }
        const cur = usage?.outputTokens
        if ((cur == null || toNum(cur) === 0) && est > 0) {
          usage = { ...(usage || {}), outputTokens: est }
        }
      }
      return { fullText, thinkingText, toolCalls, finishReason, usage, upstreamError }
    },
  }
}
