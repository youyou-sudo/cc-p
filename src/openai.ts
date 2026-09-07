import { authErrorMessage, getApiKey } from './auth'
import { buildCcRequest } from './cc'
import { CcStreamParser } from './cc-events'
import type { CcEventHooks } from './cc-events'
import { mapCcEventError, mapFinishReason, normalizeUsage } from './errors'
import { SSE_HEADERS, readWithTimeout, sendJSON } from './http'
import { log } from './logger'
import { callUpstream, createUpstreamFlow, readRequestJson } from './proxy-handler'
import type { JsonParseErrorKind } from './proxy-handler'
import { NONSTREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, runtimeState, timeoutMessage } from './runtime'
import { createSseTranslator, SsePipeline } from './sse'
import { nowUnix, uuid } from './util'

interface TerminalState {
  upstreamError: { status: number; body: any } | null
  timedOut: boolean
  zeroOutput: boolean
  errorMsg: string
}

function buildError(kind: JsonParseErrorKind, message: string): Response {
  return sendJSON(kind === 'too-large' ? 413 : 400, {
    error: { message, type: 'invalid_request_error' },
  })
}

function zeroUsageChunk(completionId: string, created: number, model: string): string {
  return `data: ${JSON.stringify({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
  })}\n\n`
}

export async function handleChatCompletions(request: Request, headers: Record<string, string | undefined>): Promise<Response> {
  const parsed = await readRequestJson<any>(request, buildError)
  if (!parsed.ok) return parsed.response
  const openaiReq = parsed.value

  const apiKey = getApiKey(headers)
  if (!apiKey) {
    return sendJSON(401, { error: { message: authErrorMessage(headers), type: 'auth_error' } })
  }

  const stream = openaiReq.stream === true
  const model = openaiReq.model || 'deepseek/deepseek-v4-flash'
  const completionId = `chatcmpl-${uuid().slice(0, 12)}`
  const created = nowUnix()

  const ccBody = buildCcRequest(openaiReq)
  const flow = createUpstreamFlow(request)
  const abortController = flow.controller
  const aborted = () => flow.aborted
  const startTime = Date.now()
  let bytesReceived = 0
  let lastCcEvent = ''
  let fullText = ''

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
          bytesSent: bytesReceived,
          lastCcEvent: lastCcEvent || '(none)',
          keepaliveCount: pipeline.keepaliveCount,
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
            const { done, value } = await readWithTimeout(reader.read(), STREAM_IDLE_TIMEOUT_MS, 'STREAM_IDLE_TIMEOUT')
            if (done) break
            bytesReceived += value.byteLength

            const events = translator.parseChunk(value)
            if (events.length > 0) {
              pipeline.emit(events)
              if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent
            } else {
              pipeline.emitKeepalive()
            }
          }

          if (!aborted()) {
            const flushed = translator.flush()
            if (flushed.length > 0) {
              pipeline.emit(flushed)
              if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent
            }
            if (translator.upstreamError) {
              state.upstreamError = translator.upstreamError
              if (pipeline.started) {
                pipeline.writeNow(`data: ${JSON.stringify(translator.upstreamError.body)}\n\n`)
              }
            } else if (translator.outputTokens === 0) {
              state.zeroOutput = true
              try { if (!abortController.signal.aborted) abortController.abort() } catch {}
              if (pipeline.started) {
                pipeline.writeNow(`data: ${JSON.stringify({ error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 })}\n\n`)
              }
            } else {
              runtimeState.consecutiveTimeouts = 0
              pipeline.emit([translator.getDoneEvent()])
            }
          }
        } catch (e: any) {
          if (aborted()) {
            reader.cancel().catch(() => {})
          } else if (e?.message === 'STREAM_IDLE_TIMEOUT') {
            log('warn', 'Stream idle timeout', {
              path: '/v1/chat/completions',
              model,
              streaming: true,
              timeoutMs: STREAM_IDLE_TIMEOUT_MS,
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
            runtimeState.consecutiveTimeouts++
            state.timedOut = true
            if (pipeline.started) {
              pipeline.writeNow(`data: ${JSON.stringify({ error: { message: timeoutMessage(), type: 'rate_limit_error' }, retry_after: 5 })}\n\n`)
            }
          } else {
            state.errorMsg = e?.message ?? String(e)
            log('error', 'Stream error', { message: state.errorMsg })
            try { abortController.abort() } catch {}
            if (pipeline.started) {
              pipeline.writeNow(`data: ${JSON.stringify({ error: { message: state.errorMsg, type: 'proxy_error' } })}\n\n`)
            }
          }
        } finally {
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
          return sendJSON(state.upstreamError.status, state.upstreamError.body)
        }
        if (state.timedOut) {
          return sendJSON(429, { error: { message: timeoutMessage(), type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 })
        }
        if (state.zeroOutput || !state.errorMsg) {
          return sendJSON(429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 })
        }
        return sendJSON(502, { error: { message: `Upstream error: ${state.errorMsg}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 })
      }

      return new Response(pipeline.stream, { status: 200, headers: SSE_HEADERS })
    }

    let reasoningContent = ''
    let finishReason = 'stop'
    let usage: any = null
    let toolCalls: any[] | null = null
    const state = { upstreamError: null as { status: number; body: any } | null }

    const reader = ccResponse.body!.getReader()
    const parser = new CcStreamParser()
    const hooks: CcEventHooks = {
      'text-delta': (event: any) => { fullText += event.text || '' },
      'reasoning-delta': (event: any) => { reasoningContent += event.text || '' },
      'tool-call': (event: any) => {
        toolCalls = toolCalls || []
        toolCalls.push({
          id: event.toolCallId || ('call_' + uuid().slice(0, 8)),
          type: 'function',
          function: {
            name: event.toolName || '',
            arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
          },
        })
      },
      'finish': (event: any) => {
        finishReason = mapFinishReason(event.finishReason || 'stop')
        if (event.totalUsage) usage = event.totalUsage
      },
      'error': (event: any) => {
        log('warn', 'CC stream error (non-stream)', { message: event.error?.message || event.message })
        state.upstreamError = mapCcEventError(event)
      },
    }
    const processBytes = (bytes: Uint8Array): void => {
      parser.push(bytes, hooks)
      if (parser.lastCcEvent) lastCcEvent = parser.lastCcEvent
    }

    try {
      while (true) {
        if (aborted()) break
        const { done, value } = await readWithTimeout(reader.read(), NONSTREAM_IDLE_TIMEOUT_MS, 'STREAM_IDLE_TIMEOUT')
        if (done) break
        bytesReceived += value.byteLength
        processBytes(value)
      }
      parser.flush(hooks)
    } catch (e: any) {
      if (aborted()) {
        return new Response(null, { status: 499 })
      }
      if (e?.message === 'STREAM_IDLE_TIMEOUT') {
        log('warn', 'Stream idle timeout', {
          path: '/v1/chat/completions',
          model,
          streaming: false,
          timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
          elapsedMs: Date.now() - startTime,
          id: completionId,
          bytesReceived,
          lastCcEvent: lastCcEvent || '(none)',
          partialLen: fullText ? fullText.length : 0,
        })
        reader.cancel().catch(() => {})
        try { abortController.abort() } catch {}
        runtimeState.consecutiveTimeouts++
        return sendJSON(429, { error: { message: timeoutMessage(), type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 })
      }
      log('error', 'Upstream error', { message: e?.message })
      try { abortController.abort() } catch {}
      return sendJSON(502, { error: { message: `Upstream error: ${e?.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 })
    }

    if (aborted()) {
      return new Response(null, { status: 499 })
    }

    if (state.upstreamError) {
      return sendJSON(state.upstreamError.status, state.upstreamError.body)
    }

    if ((usage?.outputTokens ?? 0) === 0) {
      try { if (!abortController.signal.aborted) abortController.abort() } catch {}
      return sendJSON(429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 })
    }

    runtimeState.consecutiveTimeouts = 0
    return sendJSON(200, {
      id: completionId,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: Object.assign(
          { role: 'assistant', content: fullText || null },
          toolCalls ? { tool_calls: toolCalls } : {},
          reasoningContent ? { reasoning_content: reasoningContent } : {},
        ),
        finish_reason: finishReason,
      }],
      usage: (() => {
        if (!usage) usage = {}
        normalizeUsage(usage)
        return {
          prompt_tokens: usage.inputTokens ?? 0,
          completion_tokens: usage.outputTokens ?? 0,
          total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
        }
      })(),
    })
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
