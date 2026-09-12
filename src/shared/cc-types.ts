// Layer: toolkit（零依赖叶，谁都可依赖，谁都不依赖）
// Command Code wire protocol types: the NDJSON stream events CC emits on
// /alpha/generate, plus the request-body / usage shapes the proxy translates.

export interface CcUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  inputTokenDetails?: { cacheWriteTokens?: number }
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
export interface CcFinishStepEvent { type: 'finish-step'; finishReason?: string; usage?: CcUsage }
export interface CcFinishEvent { type: 'finish'; finishReason?: string; totalUsage?: CcUsage; usage?: CcUsage }
export interface CcErrorEvent { type: 'error'; error?: { message?: string; type?: string }; message?: string; retry_after?: number }
// NOTE: `retry_after` is client-facing seconds (see errors.toRetryAfterSeconds):
// upstream Retry-After wins, else 30s fallback; always passed through even when
// the local retry loop gives up, so the client never waits less than upstream.

export type CcStreamEvent =
  | CcStartEvent | CcStartStepEvent | CcReasoningStartEvent | CcTextStartEvent
  | CcTextEndEvent | CcReasoningEndEvent | CcToolInputStartEvent | CcToolInputDeltaEvent
  | CcToolInputEndEvent | CcToolErrorEvent | CcProviderMetadataEvent
  | CcTextDeltaEvent | CcReasoningDeltaEvent | CcToolCallEvent
  | CcFinishStepEvent | CcFinishEvent | CcErrorEvent

export type CcEventType = CcStreamEvent['type']
