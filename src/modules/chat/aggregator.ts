// Non-streaming aggregation + response building. Pure, no I/O.

import { isTruncatedStream, mapCcEventError, mapFinishReason, normalizeUsage, truncatedStreamError } from '../../shared/errors'
import { ccToolArgsToString, ccToolCallId, ccToolName, createToolCallIdGuard, UNKNOWN_TOOL_NAME } from '../../shared/cc-types'
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
 * preserve old values otherwise. Upstream finish-step usage is cumulative,
 * so last-wins-with-preserve avoids double-count and ensures a finish event
 * missing usage does not wipe accumulated step usage (avoids misleading 0).
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
/** Length-based output estimate (len/4) so content-present never reports 0. */
function estimateOutputTokens(fullText: string, reasoning: string, toolCalls: any[] | null): number {
  let est = Math.ceil(((fullText?.length || 0) + (reasoning?.length || 0)) / 4)
  if (toolCalls) {
    for (const tc of toolCalls) {
      const a = tc.function?.arguments
      const s = typeof a === 'string' ? a : JSON.stringify(a ?? {})
      est += Math.ceil(s.length / 4)
    }
    if (toolCalls.length > 0 && est === 0) est = 1
  }
  return est
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

export interface ChatAggregate {
  fullText: string
  reasoningContent: string
  toolCalls: any[] | null
  finishReason: string
  usage: any
  upstreamError: { status: number; body: any } | null
  /** 有内容、无错误、却未收到 finish → 上游截断；调用方须走 502 而非 200。 */
  truncated: boolean
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
  // sawFinish: CC 正常结束必发 finish（或 finish-step）；缺失 + 有内容 + 无错误 = 截断。
  let sawFinish = false
  // tool-input-* incremental accumulation for large params (flushed on end or result()).
  let pendingToolInput: { id: string; name: string; json: string } | null = null

  const isDuplicateToolCallId = createToolCallIdGuard()

  function pushToolCall(id: string, name: string, argsStr: string): void {
    // 同一 id 二次出现必须丢弃（见 createToolCallIdGuard）：非流式下它会变成
    // 响应里两条同 id 的 tool_calls，客户端回传后上游 400。
    if (isDuplicateToolCallId(id)) {
      log('debug', 'cc duplicate tool-call id suppressed (aggregate)', { toolCallId: id })
      return
    }
    argsStr = ccToolArgsToString(argsStr)
    toolCalls = toolCalls || []
    toolCalls.push({
      id: id || ('call_' + uuid().slice(0, 8)),
      type: 'function',
      // name 非空是下游契约（见 cc-types.UNKNOWN_TOOL_NAME）：空名会让客户端
      // ToolStream 直接抛错，整条响应作废。
      function: { name: name || UNKNOWN_TOOL_NAME, arguments: argsStr },
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
        ccToolCallId(event) || pendingToolInput?.id || '',
        ccToolName(event) || pendingToolInput?.name || '',
        toolArgsToString(event.input),
      )
      // A final tool-call supersedes any pending incremental buffer for the same call.
      pendingToolInput = null
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
      // later result() flush cannot double-emit.
      const id = ccToolCallId(event) || pendingToolInput?.id || ''
      const name = ccToolName(event) || pendingToolInput?.name || ''
      const argsStr = fullInput != null ? toolArgsToString(fullInput) : (pendingToolInput?.json || '')
      // Only push when we actually accumulated something (avoid empty phantom calls).
      if (argsStr || id || name) pushToolCall(id, name, argsStr)
      pendingToolInput = null
    },
    'finish-step': (event: any) => {
      sawFinish = true
      if (event.finishReason) finishReason = mergeFinishReason(finishReason, safeMapFinishReason(event.finishReason))
      if (event.usage) usage = mergeUsage(usage, event.usage)
    },
    'finish': (event: any) => {
      sawFinish = true
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
    result(): ChatAggregate {
      // Flush incremental-only tool calls (deltas without a final tool-call event).
      flushPendingToolInput()
      // Content-aware zero guard: text/reasoning/tool any-present must not report 0 output
      // (aligns with messages side; avoids finish-missing-usage misleading 0).
      const hasContent = !!fullText || !!reasoningContent || !!toolCalls
      if (hasContent) {
        const est = estimateOutputTokens(fullText, reasoningContent, toolCalls)
        const cur = usage?.outputTokens
        if ((cur == null || toNum(cur) === 0) && est > 0) {
          usage = { ...(usage || {}), outputTokens: est }
        }
      }
      // 截断归一：无 finish + 有内容 + 无错误 → 复用 upstreamError 通道，
      // 让上层既有的错误尾处理（502 + rawUsage）自动生效，不必新增分支。
      const truncated = isTruncatedStream(sawFinish, hasContent, !!upstreamError)
      if (truncated) upstreamError = truncatedStreamError()
      return { fullText, reasoningContent, toolCalls, finishReason, usage, upstreamError, truncated }
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
