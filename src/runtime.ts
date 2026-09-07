export const STREAM_IDLE_TIMEOUT_MS = 30_000
export const NONSTREAM_IDLE_TIMEOUT_MS = 90_000
export const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3

export const runtimeState = {
  consecutiveTimeouts: 0,
}

export function timeoutMessage(): string {
  return runtimeState.consecutiveTimeouts >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
    ? 'Response timeout - try reducing context length (summarize earlier messages)'
    : 'Response timeout - request timed out'
}
