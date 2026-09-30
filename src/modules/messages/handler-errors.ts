import { sendAnthropicError } from '../../shared/http'
import type { JsonParseErrorKind } from '../../infra/proxy-handler'

/** 与 sendAnthropicError 同形，仅多带 error.rawUsage（供零输出 429 可重试回包用）。 */
export function anthropicRetryOpts(body: any): { retryAfter: number } | undefined {
  const v = (body as any)?.retry_after;
  return v !== undefined ? { retryAfter: Number(v) } : undefined;
}

export function sendAnthropicErrorWithRawUsage(
  status: number,
  type: string,
  message: string,
  rawUsage: { input_tokens: number; output_tokens: number; cached_tokens: number },
  retryAfter?: number,
): Response {
  const body: any = { type: 'error', error: { type, message, rawUsage } }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (retryAfter !== undefined) {
    body.retry_after = retryAfter
    headers['Retry-After'] = String(retryAfter)
  }
  return new Response(JSON.stringify(body), { status, headers })
}

export function buildAnthropicError(kind: JsonParseErrorKind, message: string): Response {
  return sendAnthropicError(kind === 'too-large' ? 413 : 400, 'invalid_request_error', message)
}

export interface AnthropicRawUsage {
  input_tokens: number
  output_tokens: number
  cached_tokens: number
}

export interface AnthropicTimeoutDetails {
  consecutiveTimeouts: number
  timeoutMs?: number
}

/** 终端/非流通用的 429 超时 JSON（原 handler.ts 内联体纯搬运）。 */
export function buildAnthropicTimeoutResponse(msg: string, details: AnthropicTimeoutDetails): Response {
  const body: any = { type: 'error', error: { type: 'rate_limit_error', message: msg, code: 'stream_idle_timeout', consecutive_timeouts: details.consecutiveTimeouts, timeout_ms: details.timeoutMs }, retry_after: 5 }
  return new Response(JSON.stringify(body), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } })
}

/** 零输出 429（原 handler.ts 内联体纯搬运）。 */
export function buildAnthropicZeroResponse(rawUsage: AnthropicRawUsage): Response {
  return sendAnthropicErrorWithRawUsage(429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', rawUsage, 10)
}

/** 502 统一不带 retry_after / Retry-After（原 handler.ts 内联体纯搬运）。 */
export function buildAnthropicProxyError(errorMsg: string): Response {
  return sendAnthropicError(502, 'proxy_error', `Upstream error: ${errorMsg}`)
}

/** 空关 502（原 handler.ts 内联体纯搬运）。 */
export function buildAnthropicUpstreamClosedResponse(): Response {
  return sendAnthropicError(502, 'proxy_error', 'Upstream closed without output')
}

/** 流内超时帧（pipeline.started 时 writeNow 用，原 handler.ts 内联体纯搬运）。 */
export function buildAnthropicTimeoutFrame(msg: string, details: AnthropicTimeoutDetails): string {
  return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: msg, code: 'stream_idle_timeout', consecutive_timeouts: details.consecutiveTimeouts, timeout_ms: details.timeoutMs }, retry_after: 5 })}\n\n`
}

/** 流内泛错帧（pipeline.started 时 writeNow 用，原 handler.ts 内联体纯搬运）。 */
export function buildAnthropicErrorFrame(errorMsg: string): string {
  return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: errorMsg } })}\n\n`
}
