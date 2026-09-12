import { authErrorMessage, getApiKey } from '../../shared/auth'
import { buildCcRequest } from '../../infra/cc'
import { sendAnthropicError, sendJSON } from '../../shared/http'
import { log } from '../../shared/logger'
import { callUpstream, createUpstreamFlow } from '../../infra/proxy-handler'
import { getSessionId } from '../../infra/session'
import { convertAnthropicToOpenAI } from './translator'
import { anthropicRetryOpts } from './handler-errors'
import { handleMessagesStream } from './stream-handler'
import { handleMessagesNonStream } from './non-stream-handler'

// ── 499 语义（双 handler 统一，对称 chat/handler.ts） ─────────────────────
// 流前 abort（上游响应前 / 首帧前 terminal）与非流 abort → 499（客户端已断开，无 body）。
// 流中 abort（SSE 200 已发，pipeline.started=true）→ 静默 close：绝不伪造成功帧
// （message_delta + message_stop 零 usage 会污染统计/计费，把一次断开记成一次成功补全），
// 下游直接断流。

/** 请求估算输入长度（messages 字符/4）：超时分支 inputTokens 无上游 usage 时使用，
 *  使 80k 大上下文分支可达（传 0 则 TIMEOUT_LARGE_CONTEXT_TOKENS 永不可达）。 */
function estimateInputTokens(anthropicReq: any): number {
  try {
    const parts: string[] = []
    if (typeof anthropicReq?.system === 'string') parts.push(anthropicReq.system)
    else if (anthropicReq?.system != null) parts.push(JSON.stringify(anthropicReq.system))
    if (anthropicReq?.messages != null) parts.push(JSON.stringify(anthropicReq.messages))
    const text = parts.join('')
    if (!text) return 0
    return Math.max(1, Math.ceil(text.length / 4))
  } catch {
    return 0
  }
}

export async function handleMessagesBody(anthropicReq: any, headers: Record<string, string | undefined>, signal?: AbortSignal): Promise<Response> {
  // ── 1. 前检 ──────────────────────────────────────────────────────────
  const apiKey = getApiKey(headers)
  if (!apiKey) {
    return sendJSON(401, { type: 'error', error: { type: 'authentication_error', message: authErrorMessage(headers) } })
  }

  const stream = anthropicReq.stream === true
  const model = anthropicReq.model || 'claude-sonnet-4-6'
  const estimatedInputTokens = estimateInputTokens(anthropicReq)

  const openaiReq = convertAnthropicToOpenAI(anthropicReq)
  if (anthropicReq.prompt_cache_key !== undefined) openaiReq.prompt_cache_key = anthropicReq.prompt_cache_key
  const ccBody = buildCcRequest(openaiReq)
  // Same scoping as openai.ts: per-session buckets stop a hanging main
  // session from misleading a small-context sub-agent on the same key.
  const sessionId = getSessionId(headers, apiKey, openaiReq.prompt_cache_key)

  const flow = createUpstreamFlow({ signal: signal ?? new AbortController().signal } as Request)
  const abortController = flow.controller
  const aborted = () => flow.aborted
  const startTime = Date.now()
  const messageIdHolder = { current: '' }
  // Hoisted so outer catch (callUpstream throw / post-transfer throw) can
  // still free the gate slot. Assigned right after a 2xx transfer; no-op
  // until then. Idempotent via wrapWithGate doRelease.
  let releaseUpstream: () => void = () => {}

  try {
    // ── 2. 上游 ────────────────────────────────────────────────────────
    const upstream = await callUpstream({
      apiKey,
      headers,
      ccBody,
      signal: flow.signal,
      promptCacheKey: openaiReq.prompt_cache_key,
      label: 'CC API error (Anthropic)',
      onCcError: (mapped) => sendAnthropicError(mapped.status, mapped.body.error.type, mapped.body.error.message, anthropicRetryOpts(mapped.body)),
    })
    if (!upstream.ok) return upstream.value
    const ccResponse = upstream.response
    const upstreamRelease = (upstream as unknown as { release?: () => void })?.release
    releaseUpstream = () => { try { upstreamRelease?.() } catch {} }

    if (stream) {
      return handleMessagesStream({
        ccResponse,
        apiKey,
        sessionId,
        model,
        estimatedInputTokens,
        startTime,
        flow,
        abortController,
        aborted,
        releaseUpstream: () => releaseUpstream(),
        messageIdHolder,
      })
    }

    return handleMessagesNonStream({
      ccResponse,
      apiKey,
      sessionId,
      model,
      estimatedInputTokens,
      startTime,
      flow,
      abortController,
      aborted,
      releaseUpstream: () => releaseUpstream(),
      messageIdHolder,
    })
  } catch (e: any) {
    if (aborted() || abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/messages',
        model,
        messageId: messageIdHolder.current,
      })
      try { releaseUpstream() } catch {}
      return new Response(null, { status: 499 })
    }
    log('error', 'Upstream error', { message: e?.message })
    try { abortController.abort() } catch {}
    try { releaseUpstream() } catch {}
    // 502 统一不带 retry_after / Retry-After。
    return sendAnthropicError(502, 'proxy_error', `Upstream error: ${e?.message}`)
  }
}
