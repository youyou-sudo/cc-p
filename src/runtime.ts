// Consecutive-timeout tracking.
//
// State is isolated per API key: one client's slow requests must not inflate
// another client's timeout guidance, and successful requests from unrelated
// keys must not reset it either. Entries live only while a key is actively
// failing - a successful response deletes the entry, and entries idle for
// TIMEOUT_STATE_TTL_MS are pruned lazily, so the map stays bounded.

export { STREAM_IDLE_TIMEOUT_MS, NONSTREAM_IDLE_TIMEOUT_MS } from './config'
export const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3

/** Entries untouched for this long are pruned / treated as reset. */
const TIMEOUT_STATE_TTL_MS = 30 * 60 * 1000

interface TimeoutEntry {
  consecutiveTimeouts: number
  lastUpdatedAt: number
}

const timeoutStates = new Map<string, TimeoutEntry>()

function pruneStale(now: number): void {
  for (const [key, entry] of timeoutStates) {
    if (now - entry.lastUpdatedAt > TIMEOUT_STATE_TTL_MS) timeoutStates.delete(key)
  }
}

function entryFor(apiKey: string, now: number): TimeoutEntry {
  let entry = timeoutStates.get(apiKey)
  if (!entry || now - entry.lastUpdatedAt > TIMEOUT_STATE_TTL_MS) {
    entry = { consecutiveTimeouts: 0, lastUpdatedAt: now }
    timeoutStates.set(apiKey, entry)
  }
  return entry
}

/** A request for this key hit the idle timeout: bump its counter. */
export function recordTimeout(apiKey: string): void {
  const now = Date.now()
  if (timeoutStates.size > 0) pruneStale(now)
  const entry = entryFor(apiKey, now)
  entry.consecutiveTimeouts++
  entry.lastUpdatedAt = now
}

/** A request for this key completed successfully: clear its counter. */
export function recordTimeoutSuccess(apiKey: string): void {
  timeoutStates.delete(apiKey)
}

/** Current consecutive-timeout count for the key (0 when absent/stale). */
export function consecutiveTimeouts(apiKey: string): number {
  const entry = timeoutStates.get(apiKey)
  if (!entry || Date.now() - entry.lastUpdatedAt > TIMEOUT_STATE_TTL_MS) return 0
  return entry.consecutiveTimeouts
}

export function timeoutMessage(apiKey: string): string {
  return consecutiveTimeouts(apiKey) >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
    ? 'Response timeout - try reducing context length (summarize earlier messages)'
    : 'Response timeout - request timed out'
}