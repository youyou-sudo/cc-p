import type { UpstreamFlow } from '../../infra/proxy-handler'
import { normalizeUsage } from '../../shared/errors'
import { readWithTimeout, sendAnthropicError, sendJSON } from '../../shared/http'
import { log } from '../../shared/logger'
import { idleTimeoutFor, isThinkingWait, recordTimeout, recordTimeoutSuccess, timeoutDetails, timeoutMessage } from '../../shared/runtime'
import { createMessagesAggregator, buildAnthropicResponse, rawUsageFromCcUsageAnthropic } from './aggregator'
import { anthropicRetryOpts, buildAnthropicZeroResponse } from './handler-errors'

export interface MessagesNonStreamDeps {
  ccResponse: Response
  apiKey: string
  sessionId: string | undefined
  model: string
  estimatedInputTokens: number
  startTime: number
  flow: UpstreamFlow
  abortController: AbortController
  aborted: () => boolean
  releaseUpstream: () => void
  messageIdHolder: { current: string }
}

/** 非流分支（原 handler.ts L320-459 纯搬运：aggregator+usage回落+三元组零判定+normalizeUsage+buildAnthropicResponse）。 */
export async function handleMessagesNonStream(deps: MessagesNonStreamDeps): Promise<Response> {
  const { ccResponse, apiKey, sessionId, model, estimatedInputTokens, startTime, abortController, aborted, releaseUpstream, messageIdHolder } = deps
  const messageId = messageIdHolder.current
  let bytesReceived = 0
  // ── 4. 非流 ────────────────────────────────────────────────────────
  const aggregator = createMessagesAggregator({
    onEventError: (event, mapped) => {
      const message = event.error?.message || event.message || 'Unknown error'
      log('warn', 'CC error (Anthropic non-stream)', {
        path: '/v1/messages',
        model,
        messageId,
        streaming: false,
        message,
        mappedStatus: mapped.status,
        mappedType: mapped.body?.error?.type,
        lastCcEvent: aggregator.lastCcEvent || '(none)',
        bytesReceived,
      })
    },
  })

  const reader = ccResponse.body!.getReader()

  try {
    while (true) {
      if (aborted()) break
      const idleMs = idleTimeoutFor(aggregator.lastCcEvent, false)
      const { done, value } = await readWithTimeout(reader.read(), idleMs, 'STREAM_IDLE_TIMEOUT')
      if (done) break
      bytesReceived += value.byteLength
      aggregator.push(value)
    }
    aggregator.flush()
  } catch (e: any) {
    if (aborted()) {
      try { reader.cancel().catch(() => {}) } catch {}
      releaseUpstream()
      return new Response(null, { status: 499 })
    }
    if (e?.message === 'STREAM_IDLE_TIMEOUT') {
      const idleMs = idleTimeoutFor(aggregator.lastCcEvent, false)
      const agg = aggregator.result()
      const timeoutRawUsage = rawUsageFromCcUsageAnthropic(agg.usage)
      log('warn', 'Stream idle timeout', {
        path: '/v1/messages',
        model,
        streaming: false,
        timeoutMs: idleMs,
        thinkingPhase: isThinkingWait(aggregator.lastCcEvent),
        elapsedMs: Date.now() - startTime,
        id: messageId,
        bytesReceived,
        lastCcEvent: aggregator.lastCcEvent || '(none)',
        partialLen: agg.fullText ? agg.fullText.length : 0,
        inputTokens: timeoutRawUsage.input_tokens,
        outputTokens: timeoutRawUsage.output_tokens,
        cachedInputTokens: timeoutRawUsage.cached_tokens,
      })
      reader.cancel().catch(() => {})
      try { abortController.abort() } catch {}
      recordTimeout(apiKey, sessionId)
      // 非流超时 inputTokens 取上游部分 usage，未知时回落到请求估算值
      // （而非写死 0/undefined），使 80k 大上下文分支可达。
      const knownInput = timeoutRawUsage.input_tokens > 0 ? timeoutRawUsage.input_tokens : estimatedInputTokens
      const msg = timeoutMessage(apiKey, { sessionId, inputTokens: knownInput || undefined, timeoutMs: idleMs })
      const details = timeoutDetails(apiKey, { sessionId, timeoutMs: idleMs })
      releaseUpstream()
      const body: any = { type: 'error', error: { type: 'rate_limit_error', message: msg, code: 'stream_idle_timeout', consecutive_timeouts: details.consecutiveTimeouts, timeout_ms: details.timeoutMs }, retry_after: 5 }
      return new Response(JSON.stringify(body), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } })
    }
    log('error', 'Upstream error', {
      path: '/v1/messages',
      model,
      messageId,
      streaming: false,
      message: e?.message,
      bytesReceived,
      lastCcEvent: aggregator.lastCcEvent || '(none)',
    })
    try { abortController.abort() } catch {}
    releaseUpstream()
    // 502 统一不带 retry_after / Retry-After。
    return sendAnthropicError(502, 'proxy_error', `Upstream error: ${e?.message}`)
  }

  if (aborted()) {
    try { reader.cancel().catch(() => {}) } catch {}
    releaseUpstream()
    return new Response(null, { status: 499 })
  }

  const agg = aggregator.result()
  releaseUpstream()

  if (agg.upstreamError) {
    log('warn', 'CC error (non-stream JSON)', {
      path: '/v1/messages',
      model,
      messageId,
      streaming: false,
      message: agg.upstreamError.body?.error?.message,
      mappedStatus: agg.upstreamError.status,
      mappedType: agg.upstreamError.body?.error?.type,
      lastCcEvent: aggregator.lastCcEvent || '(none)',
      bytesReceived,
      rawUsage: rawUsageFromCcUsageAnthropic(agg.usage),
    })
    return sendAnthropicError(agg.upstreamError.status, agg.upstreamError.body.error.type, agg.upstreamError.body.error.message, anthropicRetryOpts(agg.upstreamError.body))
  }

  // zero 口径统一：文本 / thinking / tool 任一即非零（对称 chat 非流判定）。
  if (!agg.fullText && !agg.thinkingText && !agg.toolCalls) {
    try { if (!abortController.signal.aborted) abortController.abort() } catch {}
    const rawUsage = rawUsageFromCcUsageAnthropic(agg.usage)
    log('warn', 'Zero-output 429 (non-stream)', {
      path: '/v1/messages',
      model,
      messageId,
      streaming: false,
      bytesReceived,
      lastCcEvent: aggregator.lastCcEvent || '(none)',
      rawUsage,
    })
    return buildAnthropicZeroResponse(rawUsage)
  }

  recordTimeoutSuccess(apiKey, sessionId)
  const usage = agg.usage || {}
  normalizeUsage(usage)
  const rawUsage = rawUsageFromCcUsageAnthropic(usage)
  log('info', 'Anthropic non-stream finish', {
    path: '/v1/messages',
    model,
    messageId,
    streaming: false,
    finishReason: agg.finishReason,
    inputTokens: rawUsage.input_tokens,
    outputTokens: rawUsage.output_tokens,
    cachedInputTokens: rawUsage.cached_tokens,
    lastCcEvent: aggregator.lastCcEvent || '(none)',
    bytesReceived,
  })
  return sendJSON(200, buildAnthropicResponse(model, agg.fullText, agg.toolCalls, agg.finishReason, usage, agg.thinkingText))
}
