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
export interface CcReasoningDeltaEvent { type: 'reasoning-delta'; text?: string }
export interface CcToolCallEvent { type: 'tool-call'; toolCallId?: string; toolName?: string; input?: unknown }
export interface CcFinishStepEvent { type: 'finish-step'; finishReason?: string; usage?: CcUsage }
export interface CcFinishEvent { type: 'finish'; finishReason?: string; totalUsage?: CcUsage; usage?: CcUsage }
export interface CcErrorEvent { type: 'error'; error?: { message?: string; type?: string }; message?: string; retry_after?: number }

export type CcStreamEvent =
  | CcStartEvent | CcStartStepEvent | CcReasoningStartEvent | CcTextStartEvent
  | CcTextEndEvent | CcReasoningEndEvent | CcToolInputStartEvent | CcToolInputDeltaEvent
  | CcToolInputEndEvent | CcToolErrorEvent | CcProviderMetadataEvent
  | CcTextDeltaEvent | CcReasoningDeltaEvent | CcToolCallEvent
  | CcFinishStepEvent | CcFinishEvent | CcErrorEvent

export type CcEventType = CcStreamEvent['type']
