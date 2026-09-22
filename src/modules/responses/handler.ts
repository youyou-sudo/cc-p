// modules/responses/handler.ts — /v1/responses 请求门面。
//
// 与 chat/handler.ts 对称：前检(401) → 请求转换(convertResponsesToOpenAI →
// buildCcRequest) → callUpstream → 流式/非流分流。上游编排、gate、重试、
// 会话/指纹全部复用 infra，不重复实现。
//
// ── 499 语义（三 handler 统一） ──────────────────────────────────────────
// 流前 abort（上游响应前 / 首帧前 terminal）与非流 abort → 499（无 body）。
// 流中 abort（SSE 200 已发，pipeline.started=true）→ 静默 close：绝不伪造
// 成功帧（response.completed 会污染统计/计费）。

import { authErrorMessage, getApiKey } from '../../shared/auth'
import { buildCcRequest } from '../../infra/cc'
import { sendJSON } from '../../shared/http'
import { log } from '../../shared/logger'
import { callUpstream, createUpstreamFlow } from '../../infra/proxy-handler'
import { getSessionId } from '../../infra/session'
import { nowUnix, uuid } from '../../shared/util'
import { convertResponsesToOpenAI } from './translator'
import { handleResponsesNonStream } from './non-stream-handler'
import { handleResponsesStream } from './stream-handler'

/** 请求估算输入长度（字符/4）：超时分支 input_tokens 无上游 usage 时使用。 */
function estimateInputTokens(responsesReq: any): number {
  try {
    const parts: string[] = []
    if (typeof responsesReq?.instructions === 'string') parts.push(responsesReq.instructions)
    if (responsesReq?.input != null) {
      parts.push(typeof responsesReq.input === 'string' ? responsesReq.input : JSON.stringify(responsesReq.input))
    }
    const text = parts.join('')
    if (!text) return 0
    return Math.max(1, Math.ceil(text.length / 4))
  } catch {
    return 0
  }
}

export async function handleResponsesBody(responsesReq: any, headers: Record<string, string | undefined>, signal?: AbortSignal): Promise<Response> {
  // ── 1. 前检 ──────────────────────────────────────────────────────────
  const apiKey = getApiKey(headers)
  if (!apiKey) {
    return sendJSON(401, { error: { message: authErrorMessage(headers), type: 'auth_error' } })
  }

  const stream = responsesReq.stream === true
  const model = responsesReq.model || 'deepseek/deepseek-v4-flash'
  const responseId = `resp_${uuid().slice(0, 12)}`
  const createdAt = nowUnix()
  const estimatedInputTokens = estimateInputTokens(responsesReq)

  const openaiReq = convertResponsesToOpenAI(responsesReq)
  const ccBody = buildCcRequest(openaiReq)
  // Scoped timeout bucket: main session hangs must not mislead a small
  // sub-agent sharing the same key.
  const sessionId = getSessionId(headers, apiKey, openaiReq.prompt_cache_key)
  const flow = createUpstreamFlow({ signal: signal ?? new AbortController().signal } as Request)
  const abortController = flow.controller
  const aborted = () => flow.aborted
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
      label: 'CC API error (Responses)',
      onCcError: (mapped) => sendJSON(mapped.status, mapped.body),
    })
    if (!upstream.ok) return upstream.value
    const ccResponse = upstream.response
    const upstreamRelease = (upstream as unknown as { release?: () => void })?.release
    releaseUpstream = () => { try { upstreamRelease?.() } catch {} }

    // ── 3/4. 分发：流式 → stream-handler，非流 → non-stream-handler ─────
    const deps = {
      ccResponse,
      apiKey,
      sessionId,
      model,
      responseId,
      createdAt,
      estimatedInputTokens,
      flow,
      releaseUpstream: () => releaseUpstream(),
    }
    if (stream) {
      return handleResponsesStream(deps)
    }
    return handleResponsesNonStream(deps)
  } catch (e: any) {
    if (aborted() || abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/responses',
        model,
        responseId,
      })
      try { releaseUpstream() } catch {}
      return new Response(null, { status: 499 })
    }
    log('error', 'Upstream error', { message: e?.message })
    try { abortController.abort() } catch {}
    try { releaseUpstream() } catch {}
    // 502 统一不带 retry_after / Retry-After。
    return sendJSON(502, { error: { message: `Upstream error: ${e?.message}`, type: 'proxy_error', input_tokens: estimatedInputTokens } })
  }
}
