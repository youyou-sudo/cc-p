// Classification and detection helpers for upstream limits and context pressure.

/** Distinct upstream-limit families. Plain "rate_limit_error" is ambiguous;
 *  callers inspect the original upstream message to distinguish what actually
 *  happened and decide whether a retry is even possible. */
export type UpstreamLimitKind =
  | 'rate_limit'                 // 429 "rate limit exceeded" — retry after delay
  | 'usage_window_5h'            // 429 / usage window 5h (monthly credits paced)
  | 'usage_window_weekly'        // 429 / usage window weekly
  | 'usage_window_other'         // 429 usage window with unknown window name
  | 'payment_required'          // 402 — no credits / pay-as-you-go needed
  | 'context_overflow'          // 400-ish "prompt too long / context overflow"
  | 'authed_session_refused'     // 401/403 indicating session/fingerprint rejected
  | 'unknown'                    // other 429 / 50x we can't classify

/** Heuristic classification of an upstream failure. Works on the HTTP status
 *  and the upstream message, because Command Code encodes a lot of semantics
 *  into the message text (usage-window names, "prompt too long", etc.). */
export function classifyUpstreamLimit(status: number, message: string): UpstreamLimitKind {
  const m = message.trim()

  // 402 is a separate family and is not a "rate limit" at all.
  if (status === 402) return 'payment_required'
  if (status !== 429 && status !== 400 && status !== 403 && status !== 401) return 'unknown'

  // 401/403 read as an auth/session rejection regardless of wording — the
  // upstream encodes fingerprint/session refusals here. Not retryable.
  if (status === 401 || status === 403) {
    return 'authed_session_refused'
  }

  // 400 family: context overflow patterns from Command Code docs.
  if (status === 400) {
    if (likelyContextOverflow(m)) return 'context_overflow'
    return 'unknown'
  }

  // 429 family.
  if (status === 429) {
    if (containsUsageWindow(m, '5-hour')) return 'usage_window_5h'
    if (containsUsageWindow(m, 'weekly') || containsUsageWindow(m, '7-day') || containsUsageWindow(m, '7 day')) return 'usage_window_weekly'
    if (isUsageWindow(m)) return 'usage_window_other'
    if (isRateLimit(m)) return 'rate_limit'
    return 'rate_limit'
  }

  return 'unknown'
}

export interface LimitMeta {
  kind: UpstreamLimitKind
  retryable: boolean
  retryAfterMs: number | null
  resetHint: string | null
  category: string
}

/** Classify and produce retry guidance. `retryAfterFromHeader` is parsed from
 *  the `Retry-After` response header (seconds or HTTP-date), not from the
 *  upstream error message (which may be text only). */
export function limitMeta(
  status: number,
  message: string,
  retryAfterFromHeader: number | null,
): LimitMeta {
  const kind = classifyUpstreamLimit(status, message)
  switch (kind) {
    case 'payment_required':
      return noRetry('payment_required', message, 0)
    case 'usage_window_5h':
    case 'usage_window_weekly':
    case 'usage_window_other':
      // Windows resolve on a schedule. Retrying only wastes credit; user/SDK
      // should wait for reset or buy extra credits (which bypass the window).
      return noRetry(kind, message + ' (usage window — wait for reset or use extra credits)', null)
    case 'context_overflow':
      return noRetry('context_overflow', message, 0)
    case 'authed_session_refused':
      return noRetry('authed_session_refused', message, 0)
    case 'rate_limit': {
      // 30s default matches the previous proxy contract (Retry-After: 30).
      // The in-proxy retry loop uses its own backoff (retry.ts), so this only
      // affects what the client sees / SDK-level retry delays.
      const base = retryAfterFromHeader && retryAfterFromHeader > 0
        ? retryAfterFromHeader * 1000
        : 30_000
      return {
        kind,
        retryable: true,
        retryAfterMs: Math.max(1000, base),
        resetHint: null,
        category: 'rate_limit',
      }
    }
    default: {
      // Unclassified failures are only worth a retry when the outcome can
      // actually change (server-side trouble / request timeout); a 404 or
      // 422 fails identically on every attempt.
      const base = retryAfterFromHeader && retryAfterFromHeader > 0
        ? retryAfterFromHeader * 1000
        : 4000
      return {
        kind,
        retryable: status >= 500 || status === 408,
        retryAfterMs: Math.max(500, base),
        resetHint: null,
        category: 'unknown',
      }
    }
  }
}

function noRetry(kind: UpstreamLimitKind, message: string, fallbackMs: number | null): LimitMeta {
  return {
    kind,
    retryable: false,
    retryAfterMs: fallbackMs,
    resetHint: null,
    category: kind,
  }
}

// Helpers for text classification. Case-insensitive; tolerate punctuation.

const USAGE_WINDOW_PATTERNS: Array<[RegExp, UpstreamLimitKind]> = [
  [/5[- ]?hour/i, 'usage_window_5h' as UpstreamLimitKind],
  [/weekly|7[- ]?day/i, 'usage_window_weekly' as UpstreamLimitKind],
]

function isUsageWindow(message: string): boolean {
  const lower = message.toLowerCase()
  // Must NOT be a pure rate-limit phrase ("limit" alone is too broad — a
  // "rate limit exceeded" message would match `limit`).
  if (lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('request rate')) return false
  return hasLimitVerb(lower)
}

function containsUsageWindow(message: string, marker: string): boolean {
  const lower = message.toLowerCase()
  return isUsageWindow(message) && lower.includes(marker.toLowerCase())
}

/** True when the text reads like a usage/credit window: it names a cap/window
 *  CONTEXT, not merely the word "limit". */
function hasLimitVerb(lower: string): boolean {
  return (
    lower.includes('usage limit') ||
    lower.includes('usage window') ||
    lower.includes('spend limit') ||
    lower.includes('spend cap') ||
    lower.includes('credit limit') ||
    lower.includes('weekly') ||
    lower.includes('monthly') ||
    lower.includes('cap on') ||
    lower.includes('reached your') ||
    lower.includes('resets in') ||
    lower.includes('resets at')
  )
}

function isRateLimit(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('request rate')
}

function likelyContextOverflow(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('prompt too long') ||
    lower.includes('prompt is too long') ||
    lower.includes('too long') ||
    (lower.includes('context') && (lower.includes('exceed') || lower.includes('overflow') || lower.includes('too large') || lower.includes('too long'))) ||
    (lower.includes('max ') && (lower.includes('tokens') || lower.includes('length'))) ||
    lower.includes('exceeded the context') ||
    lower.includes('context window')
  )
}
