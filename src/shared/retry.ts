// Retry helpers: Retry-After parsing and capped exponential backoff with
// jitter. Pure functions, no I/O — covered by test/unit.ts.

/** Parse a Retry-After header value into seconds. Accepts delta-seconds or an
 *  HTTP-date; returns null when unparseable or non-positive. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const secs = Number(trimmed)
  if (Number.isFinite(secs)) {
    return secs > 0 ? secs : null
  }
  const when = Date.parse(trimmed)
  if (Number.isFinite(when)) {
    const delta = Math.ceil((when - Date.now()) / 1000)
    return delta > 0 ? delta : null
  }
  return null
}

/** Capped exponential backoff: base * 2^attempt plus uniform jitter in
 *  [0, jitterMs]. Pass jitterMs=0 for deterministic tests. */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  capMs: number,
  jitterMs: number = baseMs * 0.25,
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt))
  const grown = baseMs * 2 ** safeAttempt
  const capped = Math.min(grown, capMs)
  if (jitterMs <= 0) return capped
  return capped + Math.random() * jitterMs
}
