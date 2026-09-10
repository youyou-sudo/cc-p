export const CC_STATUS_MAP: Record<number, { status: number; type: string }> = {
  400: { status: 400, type: 'invalid_request_error' },
  401: { status: 401, type: 'authentication_error' },
  402: { status: 402, type: 'payment_required' },
  403: { status: 401, type: 'authentication_error' },
  404: { status: 404, type: 'not_found' },
  422: { status: 400, type: 'invalid_request_error' },
  429: { status: 429, type: 'rate_limit_error' },
  500: { status: 502, type: 'upstream_error' },
  502: { status: 502, type: 'upstream_error' },
  503: { status: 503, type: 'temporarily_unavailable' },
}

export interface MappedError {
  status: number
  body: any
}

export const CONTEXT_WINDOW_EXCEEDED_PATTERN =
  /prompt.*too long|context.*(too long|exceed|limit|length)|max.*tokens|input.*too (long|large)|message.*too long/i

export function isContextWindowExceeded(message: string): boolean {
  return CONTEXT_WINDOW_EXCEEDED_PATTERN.test(message || '')
}

export const CONTEXT_WINDOW_ERROR = { status: 400, type: 'context_window_exceeded' }

export function mapCcError(ccStatus: number, ccBody?: string): MappedError {
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' }
  let message = `CC API error (${ccStatus})`

  if (ccBody) {
    try {
      const parsed = JSON.parse(ccBody)
      message = parsed.error?.message || parsed.message || message
    } catch {
      message = ccBody.slice(0, 200) || message
    }
  }

  // prompt-too-long must NOT be 429 (SDK auto-retries 429); use explicit 400.
  // 超长关键词优先：即使上游误报 429 也按 400 不可重试处理。
  if (isContextWindowExceeded(message)) {
    return {
      status: CONTEXT_WINDOW_ERROR.status,
      body: { error: { message, type: CONTEXT_WINDOW_ERROR.type } },
    }
  }

  if (ccStatus === 429) {
    return {
      status: 429,
      body: {
        error: { message, type: 'rate_limit_error' },
        retry_after: 30,
      },
    }
  }

  return { status: mapped.status, body: { error: { message, type: mapped.type } } }
}

export function mapCcEventError(event: any): MappedError {
  const message = event.error?.message || event.message || 'Unknown CC error'
  // 超长关键词优先于 <NNN> 显式码：即使上游误标状态码也按 400 不可重试处理。
  if (isContextWindowExceeded(message)) {
    return {
      status: CONTEXT_WINDOW_ERROR.status,
      body: { error: { message, type: CONTEXT_WINDOW_ERROR.type } },
    }
  }
  const statusMatch = message.match(/^<(\d{3})>/)
  const ccStatus = statusMatch ? Number(statusMatch[1]) : 502
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' }

  if (mapped.status === 429) {
    return {
      status: 429,
      body: { error: { message, type: 'rate_limit_error' }, retry_after: 30 },
    }
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
