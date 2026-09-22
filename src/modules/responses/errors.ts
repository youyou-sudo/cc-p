// modules/responses/errors.ts — Responses 协议错误 Response 组装（sendJSON 形）。
//
// 外层与 OpenAI 路由同为 { error: { message, type } }（Responses API 的
// error 对象同构），故 401/400/413 由 plugins/auth.ts、plugins/errors.ts 的
// 非 /v1/messages 分支自动覆盖，此处只负责超时/零输出/502 三个终端形。
// 502 统一不带 retry_after / Retry-After（sendJSON 保证）。

import { sendJSON } from '../../shared/http'

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
