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

export function normalizeUsage(u: any): void {
  if (!u) return
  const ot = Number(u.outputTokens)
  if (!ot) {
    u.inputTokens = 0
    u.cachedInputTokens = 0
  }
}

export function mapAnthropicStopReason(finishReason: string): string {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    case 'stop': return 'end_turn'
    default: return 'end_turn'
  }
}
