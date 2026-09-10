// Non-streaming aggregation + response building. Pure, no I/O.

import { mapCcEventError, mapFinishReason, normalizeUsage } from '../../shared/errors'
import { CcStreamParser } from '../../infra/cc-events'
import type { CcEventHooks } from '../../infra/cc-events'
import { uuid } from '../../shared/util'

/** 从已聚合 CC usage 取真实上报口径的 rawUsage（只加字段，不改状态码分支）。 */
export function rawUsageFromCcUsage(u: any): { input_tokens: number; output_tokens: number; cached_tokens: number } {
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

export interface ChatAggregate {
  fullText: string
  reasoningContent: string
  toolCalls: any[] | null
  finishReason: string
  usage: any
  upstreamError: { status: number; body: any } | null
}

export function createChatAggregator(opts?: { onEventError?: (event: any, mapped: { status: number; body: any }) => void }): {
  get lastCcEvent(): string
  push(bytes: Uint8Array): void
  flush(): void
  result(): ChatAggregate
} {
  let fullText = ''
  let reasoningContent = ''
  let finishReason = 'stop'
  let usage: any = null
  let toolCalls: any[] | null = null
  let upstreamError: { status: number; body: any } | null = null

  const parser = new CcStreamParser()
  const hooks: CcEventHooks = {
    'text-delta': (event: any) => { fullText += event.text || '' },
    'reasoning-delta': (event: any) => { reasoningContent += event.text || '' },
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
      if (event.totalUsage) usage = event.totalUsage
    },
    'error': (event: any) => {
      upstreamError = mapCcEventError(event)
      opts?.onEventError?.(event, upstreamError)
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
    result(): ChatAggregate {
      return { fullText, reasoningContent, toolCalls, finishReason, usage, upstreamError }
    },
  }
}

export function buildChatCompletion(model: string, completionId: string, created: number, aggregate: ChatAggregate): any {
  let usage = aggregate.usage
  if (!usage) usage = {}
  normalizeUsage(usage)
  const rawUsage = rawUsageFromCcUsage(usage)
  return {
    id: completionId,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: Object.assign(
        { role: 'assistant', content: aggregate.fullText || null },
        aggregate.toolCalls ? { tool_calls: aggregate.toolCalls } : {},
        aggregate.reasoningContent ? { reasoning_content: aggregate.reasoningContent } : {},
      ),
      finish_reason: aggregate.finishReason,
    }],
    usage: {
      prompt_tokens: rawUsage.input_tokens,
      completion_tokens: rawUsage.output_tokens,
      total_tokens: rawUsage.input_tokens + rawUsage.output_tokens,
      prompt_tokens_details: { cached_tokens: rawUsage.cached_tokens },
    },
  }
}
