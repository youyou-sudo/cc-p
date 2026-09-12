// modules/chat/non-stream-handler.ts — chat 非流分支（原 handler.ts L306-433 搬运）。
//
// 语义逐字保留，红线不变量：
//  - aggregator 聚合 + readLoop（idleTimeoutFor(lastCcEvent,false) + readWithTimeout tag
//    'STREAM_IDLE_TIMEOUT' 不可改，catch 侧靠字符串匹配分流）。
//  - 流前/读中 abort → 499 无 body；超时 429（input_tokens 取请求估算值 estimatedInputTokens，
//    使 80k 大上下文分支可达）；泛错 502 统一不带 retry_after。
//  - 零判定三元组：fullText / reasoningContent / toolCalls.length / usage.outputTokens
//    任一即非零（对称流式 sawText/sawReasoning/sawTool + outputTokens）。
//  - 成功收尾：recordTimeoutSuccess + buildChatCompletion + rawUsageFromCcUsage。
//  - 错误尾（upstreamError / zeroOutput）经 chat/terminal.assemble 组装（成功 200 直返，不进 assemble）。

import { readWithTimeout, sendJSON } from '../../shared/http'
import { log } from '../../shared/logger'
import {
  idleTimeoutFor,
  isThinkingWait,
  recordTimeout,
  recordTimeoutSuccess,
  timeoutDetails,
  timeoutMessage,
} from '../../shared/runtime'
import type { UpstreamFlow } from '../../infra/proxy-handler'
import { buildChatCompletion, createChatAggregator, rawUsageFromCcUsage } from './aggregator'
import { proxy502Response, timeout429Response } from './errors'
import { assembleChatTerminal } from './terminal'

export interface ChatNonStreamDeps {
  ccResponse: Response
  apiKey: string
  sessionId: string
  headers: Record<string, string | undefined>
  model: string
  stream: boolean
  completionId: string
  created: number
  estimatedInputTokens: number
  signal?: AbortSignal
  flow: UpstreamFlow
  releaseUpstream: () => void
}

export async function handleChatNonStream(deps: ChatNonStreamDeps): Promise<Response> {
  const {
    ccResponse,
    apiKey,
    sessionId,
    model,
    completionId,
    created,
    estimatedInputTokens,
    flow,
    releaseUpstream,
  } = deps

  const abortController = flow.controller
  const aborted = () => flow.aborted
  const startTime = Date.now()
  let bytesReceived = 0
  let lastCcEvent = ''

  const aggregator = createChatAggregator({
    onEventError: (event, mapped) => {
      const message = event.error?.message || event.message || 'Unknown error'
      log('warn', 'CC stream error (non-stream)', {
        path: '/v1/chat/completions',
        model,
        completionId,
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
      const idleMs = idleTimeoutFor(lastCcEvent, false)
      const { done, value } = await readWithTimeout(reader.read(), idleMs, 'STREAM_IDLE_TIMEOUT')
      if (done) break
      bytesReceived += value.byteLength
      aggregator.push(value)
      if (aggregator.lastCcEvent) lastCcEvent = aggregator.lastCcEvent
    }
    aggregator.flush()
  } catch (e: any) {
    if (aborted()) {
      try { reader.cancel().catch(() => {}) } catch {}
      releaseUpstream()
      return new Response(null, { status: 499 })
    }
    if (e?.message === 'STREAM_IDLE_TIMEOUT') {
      const idleMs = idleTimeoutFor(lastCcEvent, false)
      log('warn', 'Stream idle timeout', {
        path: '/v1/chat/completions',
        model,
        streaming: false,
        timeoutMs: idleMs,
        thinkingPhase: isThinkingWait(lastCcEvent),
        elapsedMs: Date.now() - startTime,
        id: completionId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: aggregator.result().fullText.length,
      })
      reader.cancel().catch(() => {})
      try { abortController.abort() } catch {}
      recordTimeout(apiKey, sessionId)
      // 非流超时 input_tokens 取请求估算值（而非写死 0），使 80k 大上下文分支可达。
      const msg = timeoutMessage(apiKey, { sessionId, inputTokens: estimatedInputTokens, timeoutMs: idleMs })
      const details = timeoutDetails(apiKey, { sessionId, timeoutMs: idleMs })
      releaseUpstream()
      return timeout429Response(msg, details, estimatedInputTokens)
    }
    log('error', 'Upstream error', {
      path: '/v1/chat/completions',
      model,
      completionId,
      streaming: false,
      message: e?.message,
      bytesReceived,
      lastCcEvent: lastCcEvent || '(none)',
    })
    try { abortController.abort() } catch {}
    releaseUpstream()
    // 502 统一不带 retry_after / Retry-After（流内帧保持无头，此处为外层 JSON）。
    return proxy502Response(`Upstream error: ${e?.message}`, estimatedInputTokens)
  }

  if (aborted()) {
    try { reader.cancel().catch(() => {}) } catch {}
    releaseUpstream()
    return new Response(null, { status: 499 })
  }

  const aggregate = aggregator.result()
  releaseUpstream()

  if (aggregate.upstreamError || !(
    !!aggregate.fullText
    || !!(aggregate as { reasoningContent?: string }).reasoningContent
    || !!((aggregate.toolCalls?.length ?? 0) > 0)
    || ((aggregate.usage?.outputTokens ?? 0) > 0)
  )) {
    // zero 口径统一：文本 / reasoning / tool 任一即非零（对称 messages 非流判定）。
    if (!aggregate.upstreamError) {
      try { if (!abortController.signal.aborted) abortController.abort() } catch {}
      log('warn', 'Zero-output 429 (non-stream)', {
        path: '/v1/chat/completions',
        model,
        completionId,
        streaming: false,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        rawUsage: rawUsageFromCcUsage(aggregate.usage),
      })
    }
    return assembleChatTerminal(
      {
        upstreamError: aggregate.upstreamError,
        timedOut: false,
        zeroOutput: !aggregate.upstreamError,
        errorMsg: '',
      },
      {
        apiKey,
        sessionId,
        lastCcEvent,
        streaming: false,
        inputTokens: estimatedInputTokens,
        rawUsage: rawUsageFromCcUsage(aggregate.usage),
      },
    )
  }

  recordTimeoutSuccess(apiKey, sessionId)
  const rawUsage = rawUsageFromCcUsage(aggregate.usage)
  log('info', 'OpenAI non-stream finish', {
    path: '/v1/chat/completions',
    model,
    completionId,
    streaming: false,
    finishReason: aggregate.finishReason,
    inputTokens: rawUsage.input_tokens,
    outputTokens: rawUsage.output_tokens,
    cachedInputTokens: rawUsage.cached_tokens,
  })
  return sendJSON(200, buildChatCompletion(model, completionId, created, aggregate))
}
