// modules/chat/errors.ts — chat 协议错误 Response 组装（sendJSON 形）。
//
// 纯搬运自 handler.ts，原语义逐字保留：
//  - buildError：readRequestJson 错误编组（too-large→413，其余→400）。
//  - timeout429：流终端 / 非流超时共用 429（code stream_idle_timeout，retry_after 5）。
//  - zeroOutput429：零输出 429（rawUsage，retry_after 10）。
//  - proxy502：泛上游错误 502（统一不带 retry_after / Retry-After，sendJSON 已保证）。
// 不含 SSE 帧内 writeNow（仍在 stream-handler pump 内）。

import { sendJSON } from '../../shared/http'
import type { JsonParseErrorKind } from '../../infra/proxy-handler'

export function buildError(kind: JsonParseErrorKind, message: string): Response {
  return sendJSON(kind === 'too-large' ? 413 : 400, {
    error: { message, type: 'invalid_request_error' },
  })
}

/** 上游已映射错误的终端透传（status/body 原样）。 */
export function upstreamErrorResponse(status: number, body: any): Response {
  return sendJSON(status, body)
}

export function timeout429Response(
  msg: string,
  details: { consecutiveTimeouts: number; timeoutMs?: number },
  inputTokens: number,
): Response {
  return sendJSON(429, {
    error: {
      message: msg,
      type: 'rate_limit_error',
      code: 'stream_idle_timeout',
      consecutive_timeouts: details.consecutiveTimeouts,
      timeout_ms: details.timeoutMs,
      input_tokens: inputTokens,
    },
    retry_after: 5,
  })
}

export function zeroOutput429Response(rawUsage: {
  input_tokens: number
  output_tokens: number
  cached_tokens: number
}): Response {
  return sendJSON(429, {
    error: {
      message: 'Empty response from upstream (zero output tokens)',
      type: 'rate_limit_error',
      rawUsage,
    },
    retry_after: 10,
  })
}

/** 502 统一形：message + type proxy_error + input_tokens，不带 retry_after。 */
export function proxy502Response(message: string, inputTokens: number): Response {
  return sendJSON(502, { error: { message, type: 'proxy_error', input_tokens: inputTokens } })
}
