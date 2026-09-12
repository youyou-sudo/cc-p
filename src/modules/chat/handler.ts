// ── 499 语义（双 handler 统一） ──────────────────────────────────────────
// 流前 abort（上游响应前 / 首帧前 terminal）与非流 abort → 499（客户端已断开，无 body）。
// 流中 abort（SSE 200 已发，pipeline.started=true）→ 静默 close：绝不伪造成功帧
// （zeroUsageChunk + [DONE] 会污染统计/计费，把一次断开记成一次成功补全），下游直接断流。

import { authErrorMessage, getApiKey } from '../../shared/auth'
import { buildCcRequest } from '../../infra/cc'
import { sendJSON } from '../../shared/http'
import { log } from '../../shared/logger'
import { callUpstream, createUpstreamFlow } from '../../infra/proxy-handler'
import { getSessionId } from '../../infra/session'
import { nowUnix, uuid } from '../../shared/util'
import { handleChatNonStream } from './non-stream-handler'
import { handleChatStream } from './stream-handler'

// TerminalState 统一由 streaming/pump 拥有，此处仅 re-export（薄门面不自建状态形）。
export type { TerminalState } from '../streaming/pump'

/** 请求估算输入长度（字符/4）：超时分支 inputTokens 无上游 usage 时使用，
 *  使 80k 大上下文分支可达（写死 0 则 TIMEOUT_LARGE_CONTEXT_TOKENS 永不可达）。 */
function estimateInputTokens(openaiReq: any): number {
  try {
    const msgs = openaiReq?.messages
    if (msgs == null) return 0
    const text = typeof msgs === 'string' ? msgs : JSON.stringify(msgs)
    if (!text) return 0
    return Math.max(1, Math.ceil(text.length / 4))
  } catch {
    return 0
  }
}

export async function handleChatCompletionsBody(openaiReq: any, headers: Record<string, string | undefined>, signal?: AbortSignal): Promise<Response> {
  // ── 1. 前检 ──────────────────────────────────────────────────────────
  const apiKey = getApiKey(headers)
  if (!apiKey) {
    return sendJSON(401, { error: { message: authErrorMessage(headers), type: 'auth_error' } })
  }

  const stream = openaiReq.stream === true
  const model = openaiReq.model || 'deepseek/deepseek-v4-flash'
  const completionId = `chatcmpl-${uuid().slice(0, 12)}`
  const created = nowUnix()
  const estimatedInputTokens = estimateInputTokens(openaiReq)

  const ccBody = buildCcRequest(openaiReq)
  // Scoped timeout bucket: main session hangs must not mislead a small
  // sub-agent sharing the same key. Falls back to ensureSession(apiKey)
  // when the client sends no explicit session id (zero-cost, same as
  // forwardToCC's upstream session resolution for explicit ids).
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
      label: 'CC API error',
      onCcError: (mapped) => sendJSON(mapped.status, mapped.body),
    })
    if (!upstream.ok) return upstream.value
    const ccResponse = upstream.response
    const upstreamRelease = (upstream as unknown as { release?: () => void })?.release
    releaseUpstream = () => { try { upstreamRelease?.() } catch {} }

    // ── 3/4. 分发：流式 → stream-handler，非流 → non-stream-handler ─────
    // deps 与 Body 现有变量一一对应；release 经闭包取最新绑定（幂等）。
    const deps = {
      ccResponse,
      apiKey,
      sessionId,
      headers,
      model,
      stream,
      completionId,
      created,
      estimatedInputTokens,
      signal,
      flow,
      releaseUpstream: () => releaseUpstream(),
    }
    if (stream) {
      return handleChatStream(deps)
    }
    return handleChatNonStream(deps)
  } catch (e: any) {
    if (aborted() || abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/chat/completions',
        model,
        completionId,
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
