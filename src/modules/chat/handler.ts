import { authErrorMessage, getApiKey } from '../../shared/auth'
import { buildCcRequest } from '../../infra/cc'
import { SSE_HEADERS, readWithTimeout, sendJSON } from '../../shared/http'
import { log } from '../../shared/logger'
import { callUpstream, createUpstreamFlow, readRequestJson } from '../../infra/proxy-handler'
import type { JsonParseErrorKind } from '../../infra/proxy-handler'
import { idleTimeoutFor, isThinkingWait, recordTimeout, recordTimeoutSuccess, timeoutDetails, timeoutMessage } from '../../shared/runtime'
import { getSessionId } from '../../infra/session'
import { SSE_KEEPALIVE_COMMENT, SsePipeline, startSseHeartbeat } from '../../infra/sse'
import { nowUnix, uuid } from '../../shared/util'
import { createSseTranslator, zeroUsageChunk } from './translator'
import { buildChatCompletion, createChatAggregator, rawUsageFromCcUsage } from './aggregator'

interface TerminalState {
  upstreamError: { status: number; body: any } | null
  timedOut: boolean
  timedOutMs?: number
  zeroOutput: boolean
  errorMsg: string
}

function buildError(kind: JsonParseErrorKind, message: string): Response {
  return sendJSON(kind === 'too-large' ? 413 : 400, {
    error: { message, type: 'invalid_request_error' },
  })
}

export async function handleChatCompletions(request: Request, headers: Record<string, string | undefined>): Promise<Response> {
  const parsed = await readRequestJson<any>(request, buildError)
  if (!parsed.ok) return parsed.response
  return handleChatCompletionsBody(parsed.value, headers, request.signal)
}

export async function handleChatCompletionsBody(openaiReq: any, headers: Record<string, string | undefined>, signal?: AbortSignal): Promise<Response> {
  const apiKey = getApiKey(headers)
  if (!apiKey) {
    return sendJSON(401, { error: { message: authErrorMessage(headers), type: 'auth_error' } })
  }

  const stream = openaiReq.stream === true
  const model = openaiReq.model || 'deepseek/deepseek-v4-flash'
  const completionId = `chatcmpl-${uuid().slice(0, 12)}`
  const created = nowUnix()

  const ccBody = buildCcRequest(openaiReq)
  // Scoped timeout bucket: main session hangs must not mislead a small
  // sub-agent sharing the same key. Falls back to ensureSession(apiKey)
  // when the client sends no explicit session id (zero-cost, same as
  // forwardToCC's upstream session resolution for explicit ids).
  const sessionId = getSessionId(headers, apiKey, openaiReq.prompt_cache_key)
  const flow = createUpstreamFlow({ signal: signal ?? new AbortController().signal } as Request)
  const abortController = flow.controller
  const aborted = () => flow.aborted
  const startTime = Date.now()
  let bytesReceived = 0
  let lastCcEvent = ''

  try {
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

    if (stream) {
      const translator = createSseTranslator(model, completionId, created)
      const pipeline = new SsePipeline(true)
      const heartbeat = startSseHeartbeat(pipeline, { pingEvent: SSE_KEEPALIVE_COMMENT })
      const state: TerminalState = { upstreamError: null, timedOut: false, zeroOutput: false, errorMsg: '' }

      const onClientAbort = () => {
        if (pipeline.closed) return
        const reason = lastCcEvent.startsWith('tool-input') ? 'tool-input-silent-timeout'
          : lastCcEvent.includes('delta') ? 'streaming-active-disconnect'
          : 'client-hangup'
        log('warn', 'Client disconnected', {
          path: '/v1/chat/completions',
          model, completionId, reason,
          streaming: true,
          elapsedMs: Date.now() - startTime,
          bytesReceived,
          lastCcEvent: lastCcEvent || '(none)',
          keepaliveCount: pipeline.keepaliveCount,
          pingCount: pipeline.pingCount,
          inputTokens: translator.inputTokens,
          outputTokens: translator.outputTokens,
          cachedInputTokens: translator.cachedInputTokens,
        })
        pipeline.terminateWith([zeroUsageChunk(completionId, created, model), 'data: [DONE]\n\n'])
      }
      flow.setGracefulClose(onClientAbort)

      const pump = async (): Promise<void> => {
        const reader = ccResponse.body!.getReader()
        try {
          while (true) {
            if (aborted()) break
            const idleMs = idleTimeoutFor(lastCcEvent, true)
            const { done, value } = await readWithTimeout(reader.read(), idleMs, 'STREAM_IDLE_TIMEOUT')
            if (done) break
            bytesReceived += value.byteLength

            const events = translator.parseChunk(value)
            if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent
            if (events.length > 0) {
              pipeline.emit(events)
            } else {
              pipeline.emitKeepalive()
            }
          }

          if (!aborted()) {
            const flushed = translator.flush()
            if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent
            if (flushed.length > 0) {
              pipeline.emit(flushed)
            }
            if (translator.upstreamError) {
              state.upstreamError = translator.upstreamError
              if (pipeline.started) {
                const errBody = translator.upstreamError.body
                pipeline.writeNow(`data: ${JSON.stringify({ ...errBody, error: { ...errBody.error, rawUsage: translator.rawUsage } })}\n\n`)
              }
            } else if (translator.outputTokens === 0) {
              state.zeroOutput = true
              try { if (!abortController.signal.aborted) abortController.abort() } catch {}
              if (pipeline.started) {
                pipeline.writeNow(`data: ${JSON.stringify({ error: { message: 'Empty response from upstream (zero output tokens)', type: 'upstream_error', rawUsage: translator.rawUsage }, retry_after: 10 })}\n\n`)
              }
            } else {
              recordTimeoutSuccess(apiKey, sessionId)
              pipeline.emit([translator.getDoneEvent()])
            }
          }
        } catch (e: any) {
          if (aborted()) {
            reader.cancel().catch(() => {})
          } else if (e?.message === 'STREAM_IDLE_TIMEOUT') {
            const idleMs = idleTimeoutFor(lastCcEvent, true)
            log('warn', 'Stream idle timeout', {
              path: '/v1/chat/completions',
              model,
              streaming: true,
              timeoutMs: idleMs,
              thinkingPhase: isThinkingWait(lastCcEvent),
              elapsedMs: Date.now() - startTime,
              id: completionId,
              bytesReceived,
              lastCcEvent: lastCcEvent || '(none)',
              inputTokens: translator.inputTokens,
              outputTokens: translator.outputTokens,
              cachedInputTokens: translator.cachedInputTokens,
            })
            reader.cancel().catch(() => {})
            try { abortController.abort() } catch {}
            recordTimeout(apiKey, sessionId)
            state.timedOut = true
            state.timedOutMs = idleMs
            if (pipeline.started) {
              const msg = timeoutMessage(apiKey, { sessionId, inputTokens: translator.inputTokens, timeoutMs: idleMs })
              const details = timeoutDetails(apiKey, { sessionId, timeoutMs: idleMs })
              pipeline.writeNow(`data: ${JSON.stringify({ error: { message: msg, type: 'rate_limit_error', code: 'stream_idle_timeout', consecutive_timeouts: details.consecutiveTimeouts, timeout_ms: details.timeoutMs }, retry_after: 5 })}\n\n`)
            }
          } else {
            state.errorMsg = e?.message ?? String(e)
            log('error', 'Stream error', {
              path: '/v1/chat/completions',
              model,
              completionId,
              streaming: true,
              message: state.errorMsg,
              lastCcEvent: lastCcEvent || '(none)',
              bytesReceived,
              inputTokens: translator.inputTokens,
              outputTokens: translator.outputTokens,
              cachedInputTokens: translator.cachedInputTokens,
              elapsedMs: Date.now() - startTime,
            })
            try { abortController.abort() } catch {}
            if (pipeline.started) {
              pipeline.writeNow(`data: ${JSON.stringify({ error: { message: state.errorMsg, type: 'proxy_error' } })}\n\n`)
            }
          }
        } finally {
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
            path: '/v1/chat/completions',
            model,
            completionId,
            streaming: true,
            message: state.upstreamError.body?.error?.message,
            mappedStatus: state.upstreamError.status,
            mappedType: state.upstreamError.body?.error?.type,
            lastCcEvent: lastCcEvent || '(none)',
            bytesReceived,
            inputTokens: translator.inputTokens,
            outputTokens: translator.outputTokens,
            cachedInputTokens: translator.cachedInputTokens,
            started: pipeline.started,
          })
          return sendJSON(state.upstreamError.status, state.upstreamError.body)
        }
        if (state.timedOut) {
          const terminalMs = state.timedOutMs ?? idleTimeoutFor(lastCcEvent, true)
          const msg = timeoutMessage(apiKey, { sessionId, inputTokens: translator.inputTokens, timeoutMs: terminalMs })
          const details = timeoutDetails(apiKey, { sessionId, timeoutMs: terminalMs })
          return sendJSON(429, { error: { message: msg, type: 'rate_limit_error', code: 'stream_idle_timeout', consecutive_timeouts: details.consecutiveTimeouts, timeout_ms: details.timeoutMs, input_tokens: 0 }, retry_after: 5 })
        }
        if (state.zeroOutput || !state.errorMsg) {
          return sendJSON(429, {
            error: {
              message: 'Empty response from upstream (zero output tokens)',
              type: 'rate_limit_error',
              rawUsage: translator.rawUsage,
            },
            retry_after: 10,
          })
        }
        return sendJSON(502, { error: { message: `Upstream error: ${state.errorMsg}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 })
      }

      return new Response(pipeline.stream, { status: 200, headers: SSE_HEADERS })
    }

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
        // Non-stream has no translator usage yet; unknown input size must NOT
        // claim "reduce context" -- context-aware message falls back to the
        // non-misleading upstream-slow wording.
        const msg = timeoutMessage(apiKey, { sessionId, timeoutMs: idleMs })
        const details = timeoutDetails(apiKey, { sessionId, timeoutMs: idleMs })
        return sendJSON(429, { error: { message: msg, type: 'rate_limit_error', code: 'stream_idle_timeout', consecutive_timeouts: details.consecutiveTimeouts, timeout_ms: details.timeoutMs, input_tokens: 0 }, retry_after: 5 })
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
      return sendJSON(502, { error: { message: `Upstream error: ${e?.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 })
    }

    if (aborted()) {
      return new Response(null, { status: 499 })
    }

    const aggregate = aggregator.result()

    if (aggregate.upstreamError) {
      return sendJSON(aggregate.upstreamError.status, aggregate.upstreamError.body)
    }

    const usage = aggregate.usage
    if ((usage?.outputTokens ?? 0) === 0) {
      try { if (!abortController.signal.aborted) abortController.abort() } catch {}
      log('warn', 'Zero-output 429 (non-stream)', {
        path: '/v1/chat/completions',
        model,
        completionId,
        streaming: false,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        rawUsage: rawUsageFromCcUsage(usage),
      })
      return sendJSON(429, {
        error: {
          message: 'Empty response from upstream (zero output tokens)',
          type: 'rate_limit_error',
          rawUsage: rawUsageFromCcUsage(usage),
        },
        retry_after: 10,
      })
    }

    recordTimeoutSuccess(apiKey, sessionId)
    const rawUsage = rawUsageFromCcUsage(usage)
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
  } catch (e: any) {
    if (aborted() || abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/chat/completions',
        model,
        completionId,
      })
      return new Response(null, { status: 499 })
    }
    log('error', 'Upstream error', { message: e?.message })
    try { abortController.abort() } catch {}
    return sendJSON(502, { error: { message: `Upstream error: ${e?.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 })
  }
}
