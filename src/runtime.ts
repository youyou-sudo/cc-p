// Consecutive-timeout tracking.
//
// State is isolated per API key: one client's slow requests must not inflate
// another client's timeout guidance, and successful requests from unrelated
// keys must not reset it either. Entries live only while a key is actively
// failing - a successful response deletes the entry, and entries idle for
// TIMEOUT_STATE_TTL_MS are pruned lazily, so the map stays bounded.

export { NONSTREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, THINKING_IDLE_TIMEOUT_MS } from './config'
import { NONSTREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, THINKING_IDLE_TIMEOUT_MS } from './config'
export const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3
/** Only suggest reducing context when we actually know input is large. */
export const TIMEOUT_LARGE_CONTEXT_TOKENS = 80_000

/** Entries untouched for this long are pruned / treated as reset. */
const TIMEOUT_STATE_TTL_MS = 30 * 60 * 1000

interface TimeoutEntry {
  consecutiveTimeouts: number
  lastUpdatedAt: number
}

const timeoutStates = new Map<string, TimeoutEntry>()

/** Scoped counter key: one bucket per (apiKey, session). Missing session
 *  falls back to the 'default' bucket so old single-arg calls keep working. */
export function scopeKey(apiKey: string, sessionId?: string): string {
  return `${apiKey}::${sessionId || 'default'}`
}

/** Legacy pre-scope storage key (bare apiKey, no '::' suffix). Kept only as
 *  a read-through fallback so counters survive the upgrade rollout. */
function legacyKey(apiKey: string): string {
  return apiKey
}

function pruneStale(now: number): void {
  for (const [key, entry] of timeoutStates) {
    if (now - entry.lastUpdatedAt > TIMEOUT_STATE_TTL_MS) timeoutStates.delete(key)
  }
}

function freshCount(key: string, now: number): number {
  const entry = timeoutStates.get(key)
  if (!entry || now - entry.lastUpdatedAt > TIMEOUT_STATE_TTL_MS) return 0
  return entry.consecutiveTimeouts
}

function entryFor(scopedKey: string, now: number): TimeoutEntry {
  let entry = timeoutStates.get(scopedKey)
  if (!entry || now - entry.lastUpdatedAt > TIMEOUT_STATE_TTL_MS) {
    entry = { consecutiveTimeouts: 0, lastUpdatedAt: now }
    timeoutStates.set(scopedKey, entry)
  }
  return entry
}

/** A request for this key hit the idle timeout: bump its scoped counter. */
export function recordTimeout(apiKey: string, sessionId?: string): void {
  const now = Date.now()
  if (timeoutStates.size > 0) pruneStale(now)
  const entry = entryFor(scopeKey(apiKey, sessionId), now)
  entry.consecutiveTimeouts++
  entry.lastUpdatedAt = now
}

/** A request for this key completed successfully: clear its scoped counter. */
export function recordTimeoutSuccess(apiKey: string, sessionId?: string): void {
  timeoutStates.delete(scopeKey(apiKey, sessionId))
  if (sessionId === undefined) {
    // Drop legacy bare-key entry left by pre-scope versions.
    timeoutStates.delete(legacyKey(apiKey))
  }
}

/** Current consecutive-timeout count for the scoped key (0 when absent/stale). */
export function consecutiveTimeouts(apiKey: string, sessionId?: string): number {
  const now = Date.now()
  const scoped = freshCount(scopeKey(apiKey, sessionId), now)
  if (sessionId !== undefined) return scoped
  // Rollout fallback: honour legacy bare-key entries written before scoping.
  const legacy = freshCount(legacyKey(apiKey), now)
  return Math.max(scoped, legacy)
}

export interface TimeoutMessageOptions {
  inputTokens?: number
  timeoutMs?: number
  sessionId?: string
}

export function timeoutMessage(apiKey: string, opts?: TimeoutMessageOptions): string {
  const consecutive = consecutiveTimeouts(apiKey, opts?.sessionId)
  if (consecutive >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD) {
    const input = opts?.inputTokens
    if (input != null && input > TIMEOUT_LARGE_CONTEXT_TOKENS) {
      return 'Response timeout - try reducing context length (summarize earlier messages)'
    }
    const timeoutMs = opts?.timeoutMs
    const window = timeoutMs != null ? ` of ${timeoutMs}ms` : ''
    return `Response timeout (upstream slow, ${consecutive} consecutive idle timeouts${window}) - retry or try a fresh session/key`
  }
  return 'Response timeout - request timed out'
}

export interface TimeoutDetailsOptions {
  timeoutMs?: number
  sessionId?: string
}

/** Machine-readable timeout diagnostics for error response bodies. */
export function timeoutDetails(
  apiKey: string,
  opts?: TimeoutDetailsOptions,
): { consecutiveTimeouts: number; timeoutMs?: number } {
  const details: { consecutiveTimeouts: number; timeoutMs?: number } = {
    consecutiveTimeouts: consecutiveTimeouts(apiKey, opts?.sessionId),
  }
  if (opts?.timeoutMs != null) details.timeoutMs = opts.timeoutMs
  return details
}

/** True while waiting on upstream reasoning prefill / first token:
 *  zero-byte CC events where a long stall is expected. Empty string returns
 *  false so a connect-time hang (no event yet) still fails fast on 30s. */
export function isThinkingWait(lastCcEvent: string): boolean {
  return lastCcEvent === 'start'
    || lastCcEvent === 'start-step'
    || lastCcEvent === 'reasoning-start'
    || lastCcEvent === 'reasoning-delta'
}

/** Per-read idle budget: thinking phase gets the long window, everything
 *  else keeps the stream/non-stream defaults. Non-stream thinking also gets
 *  the long window (deep-reasoning prefill can exceed 90s). */
export function idleTimeoutFor(lastCcEvent: string, streaming: boolean): number {
  if (isThinkingWait(lastCcEvent)) return THINKING_IDLE_TIMEOUT_MS
  return streaming ? STREAM_IDLE_TIMEOUT_MS : NONSTREAM_IDLE_TIMEOUT_MS
}
