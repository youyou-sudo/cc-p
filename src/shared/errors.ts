// Layer: domain（可依赖 kernel / toolkit，不可被 kernel 依赖）
import { classifyUpstreamLimit } from './limit'

export const CC_STATUS_MAP: Record<number, { status: number; type: string }> = {
  400: { status: 400, type: 'invalid_request_error' },
  401: { status: 401, type: 'authentication_error' },
  402: { status: 402, type: 'payment_required' },
  // 403 is authorization (forbidden), NOT authentication: keep 403 so the
  // client can distinguish bad-key (401) from forbidden/session-refused (403).
  403: { status: 403, type: 'permission_denied' },
  404: { status: 404, type: 'not_found' },
  408: { status: 408, type: 'timeout_error' },
  413: { status: 413, type: 'request_too_large' },
  422: { status: 400, type: 'invalid_request_error' },
  429: { status: 429, type: 'rate_limit_error' },
  500: { status: 502, type: 'upstream_error' },
  502: { status: 502, type: 'upstream_error' },
  503: { status: 503, type: 'temporarily_unavailable' },
  504: { status: 504, type: 'gateway_timeout' },
}

export interface MappedError {
  status: number
  body: any
}

// Whitelist-only overflow wording. Deliberately tight so a true 429 rate
// limit is never demoted to 400: no bare `max.*tokens`, no bare
// `context.*limit|length`. Overflow downgrade is additionally gated to 4xx
// (excluding 429) in limit.ts, so even a matching phrase on 429/5xx stays.
export const CONTEXT_WINDOW_EXCEEDED_PATTERN =
  /context_window_exceeded|prompt\s+(is\s+)?too\s+(long|large)|prompt\s+exceeds?.*tokens?|input\s+(is\s+)?too\s+(long|large)|input\s+tokens?.*exceed|context\s+length\s+exceeded|context\s+(window\s+)?exceeded|context\s+too\s+(long|large)|context\s+limit.*exceed|too\s+many\s+tokens|maximum\s+context|message\s+(is\s+)?too\s+long/i

export function isContextWindowExceeded(message: string): boolean {
  return CONTEXT_WINDOW_EXCEEDED_PATTERN.test(message || '')
}

export const CONTEXT_WINDOW_ERROR = { status: 400, type: 'context_window_exceeded' }

/** 503 fallback when upstream omits Retry-After: short backoff hint so the
 *  client backs off instead of hammering. Only 503 gets a default; every
 *  other non-rate_limit kind omits retry_after entirely (no fabrication). */
const DEFAULT_503_RETRY_AFTER_SECS = 5
/** Client-facing message cap: classification always runs on the FULL upstream
 *  text first; only the sanitized copy sent to the client is truncated. */
const MAX_CLIENT_MESSAGE_CHARS = 500

/** Upstream Retry-After (ms) → client-facing `retry_after` seconds. Returns
 *  null when absent/invalid so the caller omits the field (and therefore the
 *  Retry-After header via sendJSON) instead of fabricating 30s. Only true
 *  rate_limit (and 503, see below) ever carries retry_after. */
export function toRetryAfterSeconds(retryAfterMs?: number | null): number | null {
  if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.ceil(retryAfterMs / 1000)
  }
  return null
}

const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const IPV6_PATTERN = /\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}\b/g
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi
const STACK_FRAME_PATTERN = /\s+at\s+[^\n]*\([^)]*:\d+:\d+\)/g
const TRACEBACK_WORD_PATTERN = /\b(traceback|stack trace)\b/gi
const POSIX_PATH_PATTERN = /(?:\/[\w.\-]+)+(?:\.\w+)(?::\d+){1,2}/g
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\(?:[^\\\s]+\\)*[^\s]*/g

/** Strip IPs / URLs / stack-trace fragments before echoing upstream text to
 *  the client. The raw text stays in server logs via the caller's bodySnippet. */
function sanitizeUpstreamMessage(message: string): string {
  if (!message) return message
  let out = message
  out = out.replace(URL_PATTERN, '[url-redacted]')
  out = out.replace(IPV4_PATTERN, '[ip-redacted]')
  out = out.replace(IPV6_PATTERN, '[ip-redacted]')
  out = out.replace(STACK_FRAME_PATTERN, ' [stack-redacted]')
  out = out.replace(TRACEBACK_WORD_PATTERN, '[stack-redacted]')
  out = out.replace(POSIX_PATH_PATTERN, '[path-redacted]')
  out = out.replace(WINDOWS_PATH_PATTERN, '[path-redacted]')
  return out
}

function toClientMessage(rawMessage: string, fallback: string): string {
  const sanitized = sanitizeUpstreamMessage(String(rawMessage || fallback))
  if (sanitized.length > MAX_CLIENT_MESSAGE_CHARS) {
    return sanitized.slice(0, MAX_CLIENT_MESSAGE_CHARS)
  }
  return sanitized
}

/** CcErrorEvent.retry_after (seconds, per cc-types) → client retry_after.
 *  Tolerates numeric strings; null when absent/invalid (caller omits). */
function parseEventRetryAfter(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.ceil(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    if (Number.isFinite(n) && n > 0) return Math.ceil(n)
  }
  return null
}

export function mapCcError(ccStatus: number, ccBody?: string, retryAfterMs?: number | null): MappedError {
  // Full upstream text first: classification runs BEFORE any truncation.
  let rawMessage = `CC API error (${ccStatus})`
  if (ccBody) {
    try {
      const parsed = JSON.parse(ccBody)
      rawMessage = parsed.error?.message || parsed.message || rawMessage
    } catch {
      rawMessage = ccBody || rawMessage
    }
  }
  rawMessage = String(rawMessage || `CC API error (${ccStatus})`)

  // Classify first: usage_window / payment / auth / overflow all suppress
  // retry_after so the SDK does not auto-retry non-retryable failures.
  const kind = classifyUpstreamLimit(ccStatus, rawMessage)
  const message = toClientMessage(rawMessage, `CC API error (${ccStatus})`)

  if (kind === 'context_overflow') {
    return {
      status: CONTEXT_WINDOW_ERROR.status,
      body: { error: { message, type: CONTEXT_WINDOW_ERROR.type } },
    }
  }
  if (kind === 'usage_window_5h' || kind === 'usage_window_weekly') {
    // 403 (not 429) + no retry_after/Retry-After: prevents SDK auto-retry
    // loops that burn quota during a usage window.
    return {
      status: 403,
      body: { error: { message, type: 'usage_quota_exceeded' } },
    }
  }
  if (kind === 'payment_required') {
    // 402 keeps payment_required with NO retry_after (documented: payment is
    // not retryable; retrying burns money).
    return {
      status: 402,
      body: { error: { message, type: 'payment_required' } },
    }
  }
  if (kind === 'authed_session_refused') {
    // Keep 401 vs 403 distinct: bad key vs forbidden/session-refused.
    if (ccStatus === 403) {
      return { status: 403, body: { error: { message, type: 'permission_denied' } } }
    }
    return { status: 401, body: { error: { message, type: 'authentication_error' } } }
  }

  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' }

  // Only true rate_limit carries retry_after; omit when upstream gave none.
  if (kind === 'rate_limit') {
    const retrySecs = toRetryAfterSeconds(retryAfterMs)
    const body: any = { error: { message, type: 'rate_limit_error' } }
    if (retrySecs != null) body.retry_after = retrySecs
    return { status: 429, body }
  }

  // 503 passes upstream Retry-After through, else a short default backoff
  // hint (the only non-rate_limit case that carries retry_after).
  if (ccStatus === 503 || mapped.status === 503) {
    const retrySecs = toRetryAfterSeconds(retryAfterMs)
    const body: any = { error: { message, type: mapped.type } }
    body.retry_after = retrySecs ?? DEFAULT_503_RETRY_AFTER_SECS
    return { status: 503, body }
  }

  return { status: mapped.status, body: { error: { message, type: mapped.type } } }
}

export function mapCcEventError(event: any): MappedError {
  const raw = event?.error?.message || event?.message || 'Unknown CC error'
  const rawMessage = String(raw)
  // Trim BEFORE <NNN> match: upstream may pad with spaces/newlines.
  const trimmed = rawMessage.trim()
  const statusMatch = trimmed.match(/^<(\d{3})>/)
  const ccStatus = statusMatch ? Number(statusMatch[1]) : 502
  const msgForClassify = trimmed.replace(/^<\d{3}>\s*/, '') || trimmed

  // Prefer the structured CcErrorEvent.retry_after (seconds) over fabrication.
  const eventRetrySecs =
    parseEventRetryAfter(event?.retry_after) ?? parseEventRetryAfter(event?.error?.retry_after)

  const kind = classifyUpstreamLimit(ccStatus, msgForClassify)
  const message = toClientMessage(trimmed, 'Unknown CC error')

  if (kind === 'context_overflow') {
    return {
      status: CONTEXT_WINDOW_ERROR.status,
      body: { error: { message, type: CONTEXT_WINDOW_ERROR.type } },
    }
  }
  if (kind === 'usage_window_5h' || kind === 'usage_window_weekly') {
    return {
      status: 403,
      body: { error: { message, type: 'usage_quota_exceeded' } },
    }
  }
  if (kind === 'payment_required') {
    return {
      status: 402,
      body: { error: { message, type: 'payment_required' } },
    }
  }
  if (kind === 'authed_session_refused') {
    if (ccStatus === 403) {
      return { status: 403, body: { error: { message, type: 'permission_denied' } } }
    }
    return { status: 401, body: { error: { message, type: 'authentication_error' } } }
  }

  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' }

  if (kind === 'rate_limit') {
    const body: any = { error: { message, type: 'rate_limit_error' } }
    if (eventRetrySecs != null) body.retry_after = eventRetrySecs
    return { status: 429, body }
  }

  if (ccStatus === 503 || mapped.status === 503) {
    const body: any = { error: { message, type: mapped.type } }
    body.retry_after = eventRetrySecs ?? DEFAULT_503_RETRY_AFTER_SECS
    return { status: 503, body }
  }

  return { status: mapped.status, body: { error: { message, type: mapped.type } } }
}

export function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'tool-calls': return 'tool_calls'
    case 'length': return 'length'
    case 'stop': return 'stop'
    default: return reason || 'stop'
  }
}

// 保留上游真实上报的 usage 口径：outputTokens 缺失/0 也不清零
// inputTokens/cachedInputTokens（调用方需容忍 undefined/NaN）。纯函数式空操作。
export function normalizeUsage(u: any): void {
  if (!u) return
  return
}

export function mapAnthropicStopReason(finishReason: string): string {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    case 'stop': return 'end_turn'
    default: return 'end_turn'
  }
}
