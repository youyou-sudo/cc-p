import { authErrorMessage, getApiKey } from '../../shared/auth'
import { buildCcRequest } from '../../infra/cc'
import { normalizeUsage } from '../../shared/errors'
import { SSE_HEADERS, readWithTimeout, sendAnthropicError, sendJSON } from '../../shared/http'
import { log } from '../../shared/logger'
import { callUpstream, createUpstreamFlow, readRequestJson } from '../../infra/proxy-handler'
import type { JsonParseErrorKind } from '../../infra/proxy-handler'
import { idleTimeoutFor, isThinkingWait, recordTimeout, recordTimeoutSuccess, timeoutDetails, timeoutMessage } from '../../shared/runtime'
import { getSessionId } from '../../infra/session'
import { SsePipeline, startSseHeartbeat } from '../../infra/sse'
import { uuid } from '../../shared/util'
import { convertAnthropicToOpenAI, createAnthropicSseTranslator } from './translator'
import type { AnthropicStreamContext } from './translator'
import { buildAnthropicResponse, createMessagesAggregator, rawUsageFromCcUsageAnthropic } from './aggregator'

/** 与 sendAnthropicError 同形，仅多带 error.rawUsage（供零输出 429 可重试回包用）。 */
function anthropicRetryOpts(body: any): { retryAfter: number } | undefined {
  const v = (body as any)?.retry_after;
  return v !== undefined ? { retryAfter: Number(v) } : undefined;
}

function sendAnthropicErrorWithRawUsage(
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

function buildAnthropicError(kind: JsonParseErrorKind, message: string): Response {
  return sendAnthropicError(kind === 'too-large' ? 413 : 400, 'invalid_request_error', message)
}

export async function handleMessages(request: Request, headers: Record<string, string | undefined>): Promise<Response> {
  const parsed = await readRequestJson<any>(request, buildAnthropicError)
  if (!parsed.ok) return parsed.response
  return handleMessagesBody(parsed.value, headers, request.signal)
}

export async function handleMessagesBody(anthropicReq: any, headers: Record<string, string | undefined>, signal?: AbortSignal): Promise<Response> {
  const apiKey = getApiKey(headers)
  if (!apiKey) {
    return sendJSON(401, { type: 'error', error: { type: 'authentication_error', message: authErrorMessage(headers) } })
  }

  const stream = anthropicReq.stream === true
  const model = anthropicReq.model || 'claude-sonnet-4-6'

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
  let messageId = ''
  let bytesReceived = 0

  try {
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

    if (stream) {
      const pipeline = new SsePipeline(false)
      const ctx: AnthropicStreamContext = { bytesReceived: 0, lastCcEvent: '', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, upstreamError: null }
      const state = { upstreamError: null as { status: number; body: any } | null, timedOut: false, timedOutMs: undefined as number | undefined, zeroOutput: false, errorMsg: '' }

      const onClientAbort = () => {
        if (pipeline.closed) return
        pipeline.terminateWith([
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 0, input_tokens: 0, cache_read_input_tokens: 0 },
          })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
        ])
        log('warn', 'Client disconnected', {
          path: '/v1/messages',
          model,
          messageId,
          streaming: true,
          elapsedMs: Date.now() - startTime,
          bytesReceived: ctx.bytesReceived,
          lastCcEvent: ctx.lastCcEvent || '(none)',
          inputTokens: ctx.inputTokens,
          outputTokens: ctx.outputTokens,
          cachedInputTokens: ctx.cachedInputTokens,
        })
      }
      flow.setGracefulClose(onClientAbort)

      const heartbeat = startSseHeartbeat(pipeline)
      const pump = async (): Promise<void> => {
        const reader = ccResponse.body!.getReader()
        try {
          messageId = 'msg_' + uuid().slice(0, 12)
          const translator = createAnthropicSseTranslator(model, messageId, ctx)
          pipeline.emitAnthropic(translator.startEvents())
          while (true) {
            if (aborted()) break
            const idleMs = idleTimeoutFor(ctx.lastCcEvent, true)
            const { done, value } = await readWithTimeout(reader.read(), idleMs, 'STREAM_IDLE_TIMEOUT')
            if (done) break
            pipeline.emitAnthropic(translator.parseChunk(value))
          }

          if (!aborted()) {
            pipeline.emitAnthropic(translator.flush())
            pipeline.emitAnthropic(translator.finishEvents())
            recordTimeoutSuccess(apiKey, sessionId)
            if (ctx.upstreamError) {
              state.upstreamError = ctx.upstreamError
            } else if (ctx.outputTokens === 0) {
              state.zeroOutput = true
              try { abortController.abort() } catch {}
            } else {
              pipeline.start()
            }
          }
        } catch (e: any) {
          if (aborted()) {
          } else if (e?.message === 'STREAM_IDLE_TIMEOUT') {
            const idleMs = idleTimeoutFor(ctx.lastCcEvent, true)
            log('warn', 'Stream idle timeout', {
              path: '/v1/messages',
              model,
              messageId,
              streaming: true,
              timeoutMs: idleMs,
              thinkingPhase: isThinkingWait(ctx.lastCcEvent),
              elapsedMs: Date.now() - startTime,
              id: messageId,
              bytesReceived: ctx.bytesReceived,
              lastCcEvent: ctx.lastCcEvent || '(none)',
              inputTokens: ctx.inputTokens,
              outputTokens: ctx.outputTokens,
              cachedInputTokens: ctx.cachedInputTokens,
            })
            try { abortController.abort() } catch {}
            recordTimeout(apiKey, sessionId)
            state.timedOut = true
            state.timedOutMs = idleMs
            if (pipeline.started) {
              const msg = timeoutMessage(apiKey, { sessionId, inputTokens: ctx.inputTokens, timeoutMs: idleMs })
              const details = timeoutDetails(apiKey, { sessionId, timeoutMs: idleMs })
              pipeline.writeNow(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: msg, code: 'stream_idle_timeout', consecutive_timeouts: details.consecutiveTimeouts, timeout_ms: details.timeoutMs }, retry_after: 5 })}\n\n`)
            }
          } else {
            state.errorMsg = e?.message ?? String(e)
            log('error', 'Anthropic stream error', {
              path: '/v1/messages',
              model,
              messageId,
              streaming: true,
              message: state.errorMsg,
              lastCcEvent: ctx.lastCcEvent || '(none)',
              bytesReceived: ctx.bytesReceived,
              inputTokens: ctx.inputTokens,
              outputTokens: ctx.outputTokens,
              cachedInputTokens: ctx.cachedInputTokens,
              elapsedMs: Date.now() - startTime,
            })
            try { abortController.abort() } catch {}
            if (pipeline.started) {
              pipeline.writeNow(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: state.errorMsg } })}\n\n`)
            }
          }
        } finally {
          reader.cancel().catch(() => {})
          clearInterval(heartbeat)
          pipeline.close()
        }
      }

      void pump()

      const outcome = await Promise.race([
        pipeline.firstOutput.then(() => 'started' as const),
        pipeline.terminal.then(() => 'terminal' as const),
      ])

      if (outcome === 'terminal') {
        flow.setGracefulClose(null)
        if (state.upstreamError) {
          log('warn', 'CC stream error (terminal JSON)', {
            path: '/v1/messages',
            model,
            messageId,
            streaming: true,
            message: state.upstreamError.body?.error?.message,
            mappedStatus: state.upstreamError.status,
            mappedType: state.upstreamError.body?.error?.type,
            lastCcEvent: ctx.lastCcEvent || '(none)',
            bytesReceived: ctx.bytesReceived,
            inputTokens: ctx.inputTokens,
            outputTokens: ctx.outputTokens,
            cachedInputTokens: ctx.cachedInputTokens,
            started: pipeline.started,
          })
          return sendAnthropicError(state.upstreamError.status, state.upstreamError.body.error.type, state.upstreamError.body.error.message, anthropicRetryOpts(state.upstreamError.body))
        }
        if (state.timedOut) {
          const terminalMs = state.timedOutMs ?? idleTimeoutFor(ctx.lastCcEvent, true)
          const msg = timeoutMessage(apiKey, { sessionId, inputTokens: ctx.inputTokens, timeoutMs: terminalMs })
          const details = timeoutDetails(apiKey, { sessionId, timeoutMs: terminalMs })
          const body: any = { type: 'error', error: { type: 'rate_limit_error', message: msg, code: 'stream_idle_timeout', consecutive_timeouts: details.consecutiveTimeouts, timeout_ms: details.timeoutMs }, retry_after: 5 }
          return new Response(JSON.stringify(body), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } })
        }
        if (state.zeroOutput) {
          const rawUsage = {
            input_tokens: ctx.inputTokens,
            output_tokens: ctx.outputTokens,
            cached_tokens: ctx.cachedInputTokens,
          }
          log('warn', 'Zero-output 429 (stream terminal)', {
            path: '/v1/messages',
            model,
            messageId,
            streaming: true,
            bytesReceived: ctx.bytesReceived,
            lastCcEvent: ctx.lastCcEvent || '(none)',
            rawUsage,
            started: pipeline.started,
          })
          return sendAnthropicErrorWithRawUsage(429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', rawUsage, 10)
        }
        if (state.errorMsg) {
          return sendAnthropicError(502, 'proxy_error', `Upstream error: ${state.errorMsg}`, { retryAfter: 10 })
        }
        const rawUsageFallback = {
          input_tokens: ctx.inputTokens,
          output_tokens: ctx.outputTokens,
          cached_tokens: ctx.cachedInputTokens,
        }
        log('warn', 'Zero-output 429 (stream terminal)', {
          path: '/v1/messages',
          model,
          messageId,
          streaming: true,
          bytesReceived: ctx.bytesReceived,
          lastCcEvent: ctx.lastCcEvent || '(none)',
          rawUsage: rawUsageFallback,
          started: pipeline.started,
        })
        return sendAnthropicErrorWithRawUsage(429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', rawUsageFallback, 10)
      }

      return new Response(pipeline.stream, { status: 200, headers: SSE_HEADERS })
    }

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
        // Non-stream has partial usage only; pass inputTokens when known.
        const msg = timeoutMessage(apiKey, { sessionId, inputTokens: timeoutRawUsage.input_tokens || undefined, timeoutMs: idleMs })
        const details = timeoutDetails(apiKey, { sessionId, timeoutMs: idleMs })
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
      return sendAnthropicError(502, 'proxy_error', `Upstream error: ${e?.message}`, { retryAfter: 10 })
    }

    if (aborted()) {
      return new Response(null, { status: 499 })
    }

    const agg = aggregator.result()

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
      return sendAnthropicErrorWithRawUsage(429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', rawUsage, 10)
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
  } catch (e: any) {
    if (aborted() || abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/messages',
        model,
        messageId,
      })
      return new Response(null, { status: 499 })
    }
    log('error', 'Upstream error', { message: e?.message })
    try { abortController.abort() } catch {}
    return sendAnthropicError(502, 'proxy_error', `Upstream error: ${e?.message}`, { retryAfter: 10 })
  }
}
