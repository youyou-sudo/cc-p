// Upstream limit classification: distinguish retryable rate limits from
// non-retryable usage windows / context overflow / payment / auth failures.
// Pure functions, no I/O — covered by test/unit.ts.

import { isContextWindowExceeded } from './errors'

export type UpstreamLimitKind =
  | 'rate_limit'
  | 'usage_window_5h'
  | 'usage_window_weekly'
  | 'context_overflow'
  | 'payment_required'
  | 'authed_session_refused'
  | 'unknown'

export interface LimitMeta {
  kind: UpstreamLimitKind
  retryable: boolean
  retryAfterMs: number | null
}

const USAGE_5H_PATTERN = /5-hour|5 hour|five hour/i
const USAGE_WEEKLY_PATTERN = /week/i

export function classifyUpstreamLimit(status: number, message: string): UpstreamLimitKind {
  const msg = message || ''
  // Usage windows first: they arrive as 429 but must NOT be retried.
  if (status === 429 && USAGE_5H_PATTERN.test(msg)) return 'usage_window_5h'
  if (status === 429 && USAGE_WEEKLY_PATTERN.test(msg)) return 'usage_window_weekly'
  // Single source of truth for overflow wording lives in errors.ts.
  if (isContextWindowExceeded(msg)) return 'context_overflow'
  if (status === 402) return 'payment_required'
  if (status === 401 || status === 403) return 'authed_session_refused'
  if (status === 429) return 'rate_limit'
  return 'unknown'
}

/** Retry guidance for a classified limit. `retryAfter` is the upstream
 *  Retry-After header value in seconds (number) or null when absent. */
export function limitMeta(
  status: number,
  message: string,
  retryAfter: number | string | null | undefined,
): LimitMeta {
  const kind = classifyUpstreamLimit(status, message)
  if (kind !== 'rate_limit') {
    return { kind, retryable: false, retryAfterMs: null }
  }
  let retryAfterMs: number | null = null
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    retryAfterMs = retryAfter * 1000
  } else if (typeof retryAfter === 'string' && retryAfter !== '') {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs) && secs > 0) retryAfterMs = secs * 1000
  }
  return { kind, retryable: true, retryAfterMs }
}
