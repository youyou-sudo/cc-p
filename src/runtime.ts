export const STREAM_IDLE_TIMEOUT_MS = 30_000
export const NONSTREAM_IDLE_TIMEOUT_MS = 90_000
export const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3

const MAX_TIMEOUT_STATE_ENTRIES = 10_000

const consecutiveTimeouts = new Map<string, number>()

export function recordRequestTimeout(apiKey: string): void {
  const next = (consecutiveTimeouts.get(apiKey) ?? 0) + 1
  consecutiveTimeouts.delete(apiKey)
  consecutiveTimeouts.set(apiKey, next)
  if (consecutiveTimeouts.size > MAX_TIMEOUT_STATE_ENTRIES) {
    const oldest = consecutiveTimeouts.keys().next().value
    if (oldest !== undefined) consecutiveTimeouts.delete(oldest)
  }
}

export function recordRequestSuccess(apiKey: string): void {
  consecutiveTimeouts.delete(apiKey)
}

export function timeoutMessage(apiKey: string): string {
  return (consecutiveTimeouts.get(apiKey) ?? 0) >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
    ? 'Response timeout - try reducing context length (summarize earlier messages)'
    : 'Response timeout - request timed out'
}
