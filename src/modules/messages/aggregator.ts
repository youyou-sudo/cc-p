import { CcStreamParser } from '../../infra/cc-events'
import type { CcEventHooks } from '../../infra/cc-events'
import { mapAnthropicStopReason, mapCcEventError, mapFinishReason, normalizeUsage } from '../../shared/errors'
import { uuid } from '../../shared/util'
import { fakeThinkingSignature } from './translator'

/** 从已聚合 CC usage 取真实上报口径的 rawUsage（只加字段，不改状态码分支）。 */
export function rawUsageFromCcUsageAnthropic(u: any): { input_tokens: number; output_tokens: number; cached_tokens: number } {
  const toNum = (v: any): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return {
    input_tokens: toNum(u?.inputTokens),
    output_tokens: toNum(u?.outputTokens),
    cached_tokens: toNum(u?.cachedInputTokens),
  }
}

export function buildAnthropicResponse(model: string, fullText: string, toolCalls: any[] | null, finishReason: string, usage: any, thinkingText: string): any {
  const content: any[] = []
  if (thinkingText) content.push({ type: 'thinking', thinking: thinkingText, signature: fakeThinkingSignature(thinkingText) })
  if (fullText) content.push({ type: 'text', text: fullText })
  if (toolCalls) {
    for (const tc of toolCalls) {
      let input: any = {}
      try { input = JSON.parse(tc.function.arguments) } catch { input = {} }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
    }
  }
  return {
    id: `msg_${uuid().slice(0, 12)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapAnthropicStopReason(finishReason || 'stop'),
    stop_sequence: null,
    usage: (() => {
      const u = usage || {}
      normalizeUsage(u)
      return {
        input_tokens: u.inputTokens ?? 0,
        output_tokens: u.outputTokens ?? 0,
        cache_creation_input_tokens: u.inputTokenDetails?.cacheWriteTokens ?? 0,
        cache_read_input_tokens: u.cachedInputTokens ?? 0,
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

  const parser = new CcStreamParser()
  const hooks: CcEventHooks = {
    'text-delta': (event: any) => { fullText += event.text || '' },
    'reasoning-delta': (event: any) => { thinkingText += event.text || '' },
    'tool-call': (event: any) => {
      toolCalls = toolCalls || []
      toolCalls.push({
        id: event.toolCallId || ('call_' + uuid().slice(0, 8)),
        type: 'function',
        function: {
          name: event.toolName || '',
          arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
        },
      })
    },
    'finish': (event: any) => {
      finishReason = mapFinishReason(event.finishReason || 'stop')
      if (event.totalUsage || event.usage) usage = event.totalUsage || event.usage
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
      return { fullText, thinkingText, toolCalls, finishReason, usage, upstreamError }
    },
  }
}
