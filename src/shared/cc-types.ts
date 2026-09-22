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
