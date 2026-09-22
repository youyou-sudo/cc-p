// modules/responses/aggregator.ts — Responses 非流聚合 + response 对象组装。
// 纯函数、无 I/O；聚合 hooks 与 chat/messages 同形（usage 只覆盖不重置、
// 多步 finish 优先级、tool-input-* 增量缓冲），仅出口对象换成 Responses 形。

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
function textOrDelta(e: any): string {
  return e.text ?? e.delta ?? ''
}
function safeMapFinishReason(reason: any): string {
  const mapped = mapFinishReason(String(reason || 'stop'))
  if (mapped === 'tool_calls' || mapped === 'length' || mapped === 'stop') return mapped
  if (mapped === 'content_filter' || mapped === 'function_call') return mapped
  return 'stop'
}
function mergeFinishReason(current: string, incoming: string): string {
  const pri = (v: string): number => {
    if (v === 'tool_calls') return 3
    if (v === 'length') return 2
    if (v === 'stop') return 1
    return 0
  }
  return pri(incoming) > pri(current) ? incoming : current
}
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
export function rawUsageFromCcUsage(u: any): { input_tokens: number; output_tokens: number; cached_tokens: number } {
  return {
    input_tokens: toNum(u?.inputTokens),
    output_tokens: toNum(u?.outputTokens),
    cached_tokens: toNum(u?.cachedInputTokens),
  }
}

export interface ResponsesAggregate {
  fullText: string
  reasoningContent: string
  toolCalls: any[] | null
  finishReason: string
  usage: any
  upstreamError: { status: number; body: any } | null
}

export function createResponsesAggregator(opts?: { onEventError?: (event: any, mapped: { status: number; body: any }) => void }): {
  get lastCcEvent(): string
  push(bytes: Uint8Array): void
  flush(): void
  result(): ResponsesAggregate
} {
  let fullText = ''
  let reasoningContent = ''
  let finishReason = 'stop'
  let usage: any = null
  let toolCalls: any[] | null = null
  let upstreamError: { status: number; body: any } | null = null
  // tool-input-* incremental accumulation for large params (flushed on end or result()).
  let pendingToolInput: { id: string; name: string; json: string } | null = null

  const isDuplicateToolCallId = createToolCallIdGuard()

  function pushToolCall(id: string, name: string, argsStr: string): void {
    // 同一 id 二次出现必须丢弃（见 createToolCallIdGuard）。
    if (isDuplicateToolCallId(id)) {
      log('debug', 'cc duplicate tool-call id suppressed (aggregate)', { toolCallId: id })
      return
    }
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
    'reasoning-delta': (event: any) => { reasoningContent += textOrDelta(event) },
    'tool-call': (event: any) => {
      pushToolCall(
        event.toolCallId || pendingToolInput?.id || '',
        event.toolName || pendingToolInput?.name || '',
        toolArgsToString(event.input),
      )
      // A final tool-call supersedes any pending incremental buffer for the same call.
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
    result(): ResponsesAggregate {
      flushPendingToolInput()
      const hasContent = !!fullText || !!reasoningContent || !!toolCalls
      if (hasContent) {
        let est = Math.ceil((fullText.length + reasoningContent.length) / 4)
        if (toolCalls) {
          for (const tc of toolCalls) est += Math.ceil(toolArgsToString(tc.function?.arguments).length / 4)
          if (toolCalls.length > 0 && est === 0) est = 1
        }
        const cur = usage?.outputTokens
        if ((cur == null || toNum(cur) === 0) && est > 0) {
          usage = { ...(usage || {}), outputTokens: est }
        }
      }
      return { fullText, reasoningContent, toolCalls, finishReason, usage, upstreamError }
    },
  }
}

/** 非流 Responses 对象（status/output/usage 三段与官方形对齐）。 */
export function buildResponsesObject(
  model: string,
  responseId: string,
  createdAt: number,
  aggregate: ResponsesAggregate,
): any {
  const u = aggregate.usage || {}
  normalizeUsage(u)
  const inputTokens = toNum(u.inputTokens)
  let outputTokens = toNum(u.outputTokens)
  if (outputTokens === 0 && (aggregate.fullText || aggregate.reasoningContent || aggregate.toolCalls)) {
    let est = Math.ceil((aggregate.fullText.length + aggregate.reasoningContent.length) / 4)
    for (const tc of aggregate.toolCalls || []) est += Math.ceil(toolArgsToString(tc.function?.arguments).length / 4)
    outputTokens = est || 1
  }
  const status = aggregate.finishReason === 'length' ? 'incomplete' : 'completed'
  const output: any[] = []
  if (aggregate.reasoningContent) {
    output.push({
      id: `rs_${uuid().slice(0, 12)}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: aggregate.reasoningContent }],
    })
  }
  if (aggregate.fullText) {
    output.push({
      id: `msg_${uuid().slice(0, 12)}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: aggregate.fullText, annotations: [] }],
    })
  }
  for (const tc of aggregate.toolCalls || []) {
    output.push({
      id: `fc_${uuid().slice(0, 12)}`,
      type: 'function_call',
      status: 'completed',
      call_id: tc.id,
      name: tc.function?.name || '',
      arguments: toolArgsToString(tc.function?.arguments),
    })
  }
  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    background: false,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: null,
    max_output_tokens: null,
    model,
    output,
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
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: toNum(u.cachedInputTokens) },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
    user: null,
    metadata: {},
  }
}
