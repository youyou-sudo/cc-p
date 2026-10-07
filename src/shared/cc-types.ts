// Layer: toolkit（零依赖叶，谁都可依赖，谁都不依赖）
// Command Code wire protocol types: the NDJSON stream events CC emits on
// /alpha/generate, plus the request-body / usage shapes the proxy translates.

// Internal normalized usage. Real upstream (`finish` / `finish-step`) reports
// cache counters as `inputTokenDetails.cacheReadTokens` / `.cacheWriteTokens`,
// and 1h-write separately; the proxy keeps the historical `cachedInputTokens`
// name for the normalized cache-read count so the rest of the pipeline reads
// one shape (see normalizeCcUsage, applied at the wire boundary in cc-events).
export interface CcUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  inputTokenDetails?: {
    cacheWriteTokens?: number
    cacheWriteTokens1h?: number
  }
}

function firstNumber(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

/** Upstream usage object → internal normalized usage.
 *
 *  Upstream sends `{inputTokens, outputTokens, inputTokenDetails:{cacheReadTokens,
 *  cacheWriteTokens}}`; this proxy reads `cachedInputTokens` everywhere. Without
 *  this mapping real cache hits silently become 0. Tolerates both the structured
 *  and the flat legacy spellings, and always carries `cacheWriteTokens1h` through
 *  so Anthropic-side 1h cache writes are not lost. */
export function normalizeCcUsage(raw: any): CcUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const details = raw.inputTokenDetails ?? {}
  const cached = firstNumber(details.cacheReadTokens, raw.cacheReadTokens, raw.cachedInputTokens)
  const cacheWrite = firstNumber(details.cacheWriteTokens, raw.cacheWriteTokens)
  const cacheWrite1h = firstNumber(details.cacheWriteTokens1h, raw.cacheWriteTokens1h)
  const out: CcUsage = {}
  const inputTokens = firstNumber(raw.inputTokens)
  const outputTokens = firstNumber(raw.outputTokens)
  if (inputTokens !== undefined) out.inputTokens = inputTokens
  if (outputTokens !== undefined) out.outputTokens = outputTokens
  if (cached !== undefined) out.cachedInputTokens = cached
  if (cacheWrite !== undefined || cacheWrite1h !== undefined) {
    out.inputTokenDetails = {}
    if (cacheWrite !== undefined) out.inputTokenDetails.cacheWriteTokens = cacheWrite
    if (cacheWrite1h !== undefined) out.inputTokenDetails.cacheWriteTokens1h = cacheWrite1h
  }
  return out
}

/** 上游会重复投递同一个 tool call：同一个 id 既可能出现在权威的 `tool-call`
 *  事件里，又可能在后随的 `tool-input-end` 里再出现一次（两条路径各自独立发射），
 *  重连/重试时也可能被重放。参考实现（cmdcode2api 的 toolCallDeduper）同样按 id 去重。
 *  一旦重复 id 流到客户端，客户端会把两条同 id 的 tool call 回传，上游随即用
 *  "Duplicate value for 'tool_call_id' of X in message[N]" 400 掉整个会话。
 *
 *  返回 true = 该 id 已出现过，调用方必须跳过这一次发射/收集。
 *  空 id 一律放行（调用方会生成唯一兜底 id，不是上游的重复投递）。 */
export function createToolCallIdGuard(): (id: string) => boolean {
  const seen = new Set<string>()
  return (id: string): boolean => {
    if (!id) return false
    if (seen.has(id)) return true
    seen.add(id)
    return false
  }
}

/** 上游工具名可能落在不同字段：权威 `tool-call` 用 `toolName`，部分事件/版本
 *  用 `name`，个别包装在 `tool.name`。六个钩子各自手写会漏读，最终向下游发出
 *  空 `function.name`/`tool_use.name` —— opencode 的 ToolStream 遇空 name 直接抛
 *  "OpenAI Chat tool call delta is missing id or name"，整条流失败。
 *  统一提取，永远是去掉首尾空白的字符串（可能为空，由发射端兜底）。 */
export function ccToolName(event: any): string {
  const v = event?.toolName ?? event?.tool_name ?? event?.name ?? event?.tool?.name ?? event?.tool?.toolName ?? event?.function?.name
  return typeof v === 'string' ? v.trim() : ''
}

/** 上游工具调用 id 可能落在 `toolCallId` / `tool_call_id` / `call_id` / `callId` /
 *  `toolUseId` / `id`（tool-input-start 用 `id`）。同样统一提取，避免流式路径
 *  漏读后下发空 id。 */
export function ccToolCallId(event: any): string {
  const v = event?.toolCallId ?? event?.tool_call_id ?? event?.call_id ?? event?.callId ?? event?.id ?? event?.toolUseId
  return typeof v === 'string' ? v.trim() : ''
}

/** 工具入参 → 合法 JSON 字符串。
 *
 *  空串 / 纯空白**不是**合法 JSON：`JSON.parse('')` 抛错，AI SDK / opencode 会把
 *  这次 tool call 当成坏调用丢掉；更糟的是它随后被写进会话历史，回放时变成
 *  `arguments:""`（生产日志：`cc tool arguments parse failed {"raw":""}` 成片刷屏）。
 *  无参数调用必须落成 `'{}'`，对象/字符串照旧序列化。 */
export function ccToolArgsToString(input: any): string {
  if (typeof input === 'string') return input.trim() ? input : '{}'
  if (input == null) return '{}'
  try {
    return JSON.stringify(input) ?? '{}'
  } catch {
    return '{}'
  }
}

/** 下游契约要求工具名非空；上游确实完全没给名字时的统一占位符
 *  （与 request 侧 resolveCallName / cc.ts 的空名兜底同名，保持一轮自洽）。 */
export const UNKNOWN_TOOL_NAME = 'unknown_tool'

// ── NDJSON stream events ────────────────────────────────────────────────

export interface CcStartEvent { type: 'start' }
export interface CcStartStepEvent { type: 'start-step' }
export interface CcReasoningStartEvent { type: 'reasoning-start' }
export interface CcTextStartEvent { type: 'text-start' }
export interface CcTextEndEvent { type: 'text-end' }
export interface CcReasoningEndEvent { type: 'reasoning-end' }
export interface CcToolInputStartEvent { type: 'tool-input-start' }
export interface CcToolInputDeltaEvent { type: 'tool-input-delta' }
export interface CcToolInputEndEvent { type: 'tool-input-end' }
export interface CcToolErrorEvent { type: 'tool-error' }
export interface CcProviderMetadataEvent { type: 'provider-metadata' }

export interface CcTextDeltaEvent { type: 'text-delta'; text?: string; delta?: string }
// NOTE: upstream sends either `text` (newer) or `delta` (older) on text-delta;
// consumers must read `event.text ?? event.delta ?? ''` to cover both shapes.
export interface CcReasoningDeltaEvent { type: 'reasoning-delta'; text?: string }
export interface CcToolCallEvent { type: 'tool-call'; toolCallId?: string; toolName?: string; input?: unknown }
// Provider-executed tool result (server-side web_search/computer use etc.).
// Only emitted when upstream ran the tool itself (`providerExecuted === true`);
// local tool results never legitimately arrive on the stream.
export interface CcToolResultEvent {
  type: 'tool-result'
  toolCallId?: string
  toolName?: string
  output?: unknown
  isError?: boolean
  providerExecuted?: boolean
}
// Upstream abort signal (client/server cancelled the generation).
export interface CcAbortEvent { type: 'abort' }
export interface CcFinishStepEvent { type: 'finish-step'; finishReason?: string; usage?: CcUsage }
export interface CcFinishEvent { type: 'finish'; finishReason?: string; totalUsage?: CcUsage; usage?: CcUsage }
// Official 1.62.1 stream errors are `{error: {message, statusCode, isRetryable}}`;
// the legacy `{message, type}` + "<NNN>" prefix shapes are still tolerated.
export interface CcErrorEvent {
  type: 'error'
  error?: { message?: string; type?: string; statusCode?: number; isRetryable?: boolean; retry_after?: number }
  message?: string
  retry_after?: number
}
// NOTE: `retry_after` is client-facing seconds (see errors.toRetryAfterSeconds):
// upstream Retry-After wins, else 30s fallback; always passed through even when
// the local retry loop gives up, so the client never waits less than upstream.

export type CcStreamEvent =
  | CcStartEvent | CcStartStepEvent | CcReasoningStartEvent | CcTextStartEvent
  | CcTextEndEvent | CcReasoningEndEvent | CcToolInputStartEvent | CcToolInputDeltaEvent
  | CcToolInputEndEvent | CcToolErrorEvent | CcProviderMetadataEvent
  | CcTextDeltaEvent | CcReasoningDeltaEvent | CcToolCallEvent
  | CcToolResultEvent | CcAbortEvent
  | CcFinishStepEvent | CcFinishEvent | CcErrorEvent

export type CcEventType = CcStreamEvent['type']
