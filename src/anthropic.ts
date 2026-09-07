import { authErrorMessage, getApiKey } from './auth'
import { buildCcRequest } from './cc'
import { CcStreamParser } from './cc-events'
import type { CcEventHooks } from './cc-events'
import { mapAnthropicStopReason, mapCcEventError, mapFinishReason, normalizeUsage } from './errors'
import { SSE_HEADERS, readWithTimeout, sendAnthropicError, sendJSON } from './http'
import { log } from './logger'
import { callUpstream, createUpstreamFlow, readRequestJson } from './proxy-handler'
import type { JsonParseErrorKind } from './proxy-handler'
import { NONSTREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, recordRequestSuccess, recordRequestTimeout, timeoutMessage } from './runtime'
import { SsePipeline } from './sse'
import { bytesToBase64, sha256bytes, uuid } from './util'

const PLACEHOLDER_THINKING_SIGNATURE = (() => {
  const seed = sha256bytes('dsh-proxy-thinking').slice(0, 64)
  return bytesToBase64(new Uint8Array([0x12, seed.length, ...seed]))
})()

export function fakeThinkingSignature(thinkingText: string): string {
  if (!thinkingText) return PLACEHOLDER_THINKING_SIGNATURE
  const seed = sha256bytes(thinkingText).slice(0, 64)
  const raw = new Uint8Array([0x12, seed.length, ...seed])
  return bytesToBase64(raw)
}

export function convertAnthropicToOpenAI(anthropicReq: any): any {
  let systemPrompt = ''
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      systemPrompt = anthropicReq.system
    } else if (Array.isArray(anthropicReq.system)) {
      systemPrompt = anthropicReq.system
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
    }
  }

  const toolNameFromId: Record<string, string> = {}
  const openaiMessages: any[] = []

  if (systemPrompt) {
    openaiMessages.push({ role: 'system', content: systemPrompt })
  }

  const messages = anthropicReq.messages || []
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      let textContent = ''
      const toolCalls: any[] = []
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }]
      for (const block of blocks) {
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          continue
        }
        if (block.type === 'text') {
          textContent += block.text || ''
        } else if (block.type === 'tool_use') {
          toolNameFromId[block.id] = block.name
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          })
        }
      }
      const assistantMsg: any = { role: 'assistant', content: textContent || null }
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
      openaiMessages.push(assistantMsg)
    } else if (msg.role === 'user') {
      let textContent = ''
      const toolResults: any[] = []
      if (typeof msg.content === 'string') {
        textContent = msg.content
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            continue
          }
          if (block.type === 'text') {
            textContent += block.text || ''
          } else if (block.type === 'tool_result') {
            toolResults.push(block)
          }
        }
      }
      if (textContent) {
        openaiMessages.push({ role: 'user', content: textContent })
      }
      for (const tr of toolResults) {
        const toolContent = typeof tr.content === 'string' ? tr.content
          : Array.isArray(tr.content) ? tr.content.map((c: any) => c.text || '').join('')
          : String(tr.content || '')
        openaiMessages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          name: toolNameFromId[tr.tool_use_id] || '',
          content: toolContent,
        })
      }
    }
  }

  const openaiReq: any = {
    model: anthropicReq.model || 'deepseek/deepseek-v4-flash',
    messages: openaiMessages,
    max_tokens: anthropicReq.max_tokens || 64000,
    stream: anthropicReq.stream === true,
  }

  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    openaiReq.tools = anthropicReq.tools.map((t: any) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }))
  }

  if (anthropicReq.tool_choice) {
    const tc = anthropicReq.tool_choice
    if (tc.type === 'auto' || tc.type === undefined) {
      openaiReq.tool_choice = 'auto'
    } else if (tc.type === 'any') {
      openaiReq.tool_choice = 'required'
    } else if (tc.type === 'tool') {
      openaiReq.tool_choice = { type: 'function', function: { name: tc.name } }
    } else if (tc.type === 'none') {
      openaiReq.tool_choice = 'none'
    }
  }

  if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature
  if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p
  if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences
  if (anthropicReq.metadata?.user_id) openaiReq.user = anthropicReq.metadata.user_id

  if (anthropicReq.thinking) {
    const t = anthropicReq.thinking
    if (t.type === 'disabled' || t.type === 'none') {
    } else if (t.type === 'adaptive') {
      openaiReq.reasoning_effort = t.effort ?? 'medium'
    } else if (t.budget_tokens !== undefined) {
      if (t.budget_tokens >= 10000) openaiReq.reasoning_effort = 'high'
      else if (t.budget_tokens >= 5000) openaiReq.reasoning_effort = 'medium'
      else if (t.budget_tokens >= 2000) openaiReq.reasoning_effort = 'low'
      else openaiReq.reasoning_effort = 'low'
    }
  }

  return openaiReq
}

export function buildAnthropicResponse(model: string, fullText: string, toolCalls: any[] | null, finishReason: string, usage: any, thinkingText: string): any {
  const content: any[] = []
  if (thinkingText) content.push({ type: 'thinking', thinking: thinkingText, signature: fakeThinkingSignature(thinkingText) })
  if (fullText) content.push({ type: 'text', text: fullText })
  if (toolCalls) {
    for (const tc of toolCalls) {
      let input: any = {}
      try { input = JSON.parse(tc.function.arguments) } catch { input = {} }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
    }
  }
  return {
    id: `msg_${uuid().slice(0, 12)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapAnthropicStopReason(finishReason || 'stop'),
    stop_sequence: null,
    usage: (() => {
      const u = usage || {}
      normalizeUsage(u)
      return {
        input_tokens: u.inputTokens ?? 0,
        output_tokens: u.outputTokens ?? 0,
        cache_creation_input_tokens: u.inputTokenDetails?.cacheWriteTokens ?? null,
        cache_read_input_tokens: u.cachedInputTokens ?? 0,
      }
    })(),
  }
}

export interface AnthropicStreamContext {
  bytesReceived: number
  lastCcEvent: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  upstreamError: { status: number; body: any } | null
}

export async function* createAnthropicSseTranslator(
  response: Response,
  model: string,
  messageId: string,
  ctx: AnthropicStreamContext,
): AsyncGenerator<string> {
  let nextBlockIndex = 0
  let currentBlockIndex = -1
  let currentBlockType: string | null = null
  let blockStarted = false
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let cacheWriteTokens = 0
  let stopReason: string | null = null
  let hasError = false
  let currentThinkingText = ''

  function closeBlock(): string {
    if (blockStarted) {
      const idx = currentBlockIndex
      const type = currentBlockType
      let out = ''
      if (type === 'thinking') {
        out += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: fakeThinkingSignature(currentThinkingText) } })}\n\n`
        currentThinkingText = ''
      }
      blockStarted = false
      currentBlockType = null
      return out + `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`
    }
    return ''
  }

  function startBlock(type: string, contentBlock: any): string {
    if (!blockStarted || currentBlockType !== type) {
      const close = closeBlock()
      currentBlockIndex = nextBlockIndex++
      currentBlockType = type
      blockStarted = true
      return close + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: contentBlock })}\n\n`
    }
    return ''
  }

  function startTextBlock(): string {
    return startBlock('text', { type: 'text', text: '' })
  }

  function startThinkingBlock(): string {
    return startBlock('thinking', { type: 'thinking', thinking: '' })
  }

  yield `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })}\n\n`

  const reader = response.body!.getReader()
  const parser = new CcStreamParser()

  const hooks: CcEventHooks = {
    'reasoning-delta': (event: any) => {
      const text = event.text || ''
      if (!text) return
      const open = startThinkingBlock()
      currentThinkingText += text
      return open + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'thinking_delta', thinking: text } })}\n\n`
    },

    'text-delta': (event: any) => {
      const text = event.text || ''
      const open = startTextBlock()
      outputTokens += 1
      return open + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text } })}\n\n`
    },

    'tool-call': (event: any) => {
      const out: string[] = []
      const close = closeBlock()
      if (close) out.push(close)

      const id = event.toolCallId || `toolu_${uuid().slice(0, 12)}`
      const name = event.toolName || ''
      const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {})

      const tcIndex = nextBlockIndex++
      out.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: tcIndex, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`)
      out.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: tcIndex, delta: { type: 'input_json_delta', partial_json: input } })}\n\n`)
      out.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: tcIndex })}\n\n`)
      outputTokens += 20
      return out
    },

    'finish-step': handleFinishStep,
    'finish': handleFinishStep,

    'error': (event: any) => {
      hasError = true
      const upstreamError = mapCcEventError(event)
      ctx.upstreamError = upstreamError
      return `event: error\ndata: ${JSON.stringify({ type: 'error', error: upstreamError.body.error })}\n\n`
    },
  }

  function handleFinishStep(event: any): void {
    if (event.finishReason) stopReason = mapAnthropicStopReason(mapFinishReason(event.finishReason))
    const u = event.totalUsage || event.usage
    if (u) {
      normalizeUsage(u)
      inputTokens = u.inputTokens ?? inputTokens
      outputTokens = u.outputTokens ?? outputTokens
      cachedInputTokens = u.cachedInputTokens ?? cachedInputTokens
      cacheWriteTokens = u.inputTokenDetails?.cacheWriteTokens ?? cacheWriteTokens
    } else {
      inputTokens = 0
      outputTokens = 0
      cachedInputTokens = 0
      cacheWriteTokens = 0
    }
    ctx.inputTokens = inputTokens
    ctx.outputTokens = outputTokens
    ctx.cachedInputTokens = cachedInputTokens
  }

  try {
    while (true) {
      const { done, value } = await readWithTimeout(reader.read(), STREAM_IDLE_TIMEOUT_MS, 'STREAM_IDLE_TIMEOUT')
      if (done) break
      ctx.bytesReceived += value.byteLength
      const out = parser.push(value, hooks)
      ctx.lastCcEvent = parser.lastCcEvent
      for (const s of out) yield s
    }
    for (const s of parser.flush(hooks)) yield s

    if (!hasError) {
      const close = closeBlock()
      if (close) yield close

      if (outputTokens === 0) {
        yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`
      } else {
        yield `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason || 'end_turn' },
          usage: { output_tokens: outputTokens, cache_read_input_tokens: cachedInputTokens, cache_creation_input_tokens: cacheWriteTokens || null, input_tokens: inputTokens },
        })}\n\n`

        yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

function buildAnthropicError(kind: JsonParseErrorKind, message: string): Response {
  return sendAnthropicError(kind === 'too-large' ? 413 : 400, 'invalid_request_error', message)
}

export async function handleMessages(request: Request, headers: Record<string, string | undefined>): Promise<Response> {
  const parsed = await readRequestJson<any>(request, buildAnthropicError)
  if (!parsed.ok) return parsed.response
  const anthropicReq = parsed.value

  const apiKey = getApiKey(headers)
  if (!apiKey) {
    return sendJSON(401, { type: 'error', error: { type: 'authentication_error', message: authErrorMessage(headers) } })
  }

  const stream = anthropicReq.stream === true
  const model = anthropicReq.model || 'claude-sonnet-4-6'

  const openaiReq = convertAnthropicToOpenAI(anthropicReq)
  const ccBody = buildCcRequest(openaiReq)

  const flow = createUpstreamFlow(request)
  const abortController = flow.controller
  const aborted = () => flow.aborted
  const startTime = Date.now()
  let messageId = ''
  let bytesReceived = 0
  let lastCcEvent = ''
  let fullText = ''

  try {
    const upstream = await callUpstream({
      apiKey,
      headers,
      ccBody,
      signal: flow.signal,
      label: 'CC API error (Anthropic)',
      onCcError: (mapped) => sendAnthropicError(mapped.status, mapped.body.error.type, mapped.body.error.message),
    })
    if (!upstream.ok) return upstream.value
    const ccResponse = upstream.response

    if (stream) {
      const pipeline = new SsePipeline(false)
      const ctx: AnthropicStreamContext = { bytesReceived: 0, lastCcEvent: '', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, upstreamError: null }
      const state = { upstreamError: null as { status: number; body: any } | null, timedOut: false, zeroOutput: false, errorMsg: '' }

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
        })
      }
      flow.setGracefulClose(onClientAbort)

      const pump = async (): Promise<void> => {
        try {
          messageId = 'msg_' + uuid().slice(0, 12)
          const generator = createAnthropicSseTranslator(ccResponse, model, messageId, ctx)
          for await (const event of generator) {
            if (aborted()) break
            if (!pipeline.started) {
              pipeline.emit([event])
              if (event.includes('"text_delta"') || event.includes('"tool_use"')) {
                pipeline.start()
              }
            } else {
              pipeline.writeNow(event)
            }
          }

          if (!aborted()) {
            recordRequestSuccess(apiKey)
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
            log('warn', 'Stream idle timeout', {
              path: '/v1/messages',
              model,
              streaming: true,
              timeoutMs: STREAM_IDLE_TIMEOUT_MS,
              elapsedMs: Date.now() - startTime,
              id: messageId,
              bytesReceived: ctx.bytesReceived,
              lastCcEvent: ctx.lastCcEvent || '(none)',
              inputTokens: ctx.inputTokens,
              outputTokens: ctx.outputTokens,
              cachedInputTokens: ctx.cachedInputTokens,
            })
            try { abortController.abort() } catch {}
            recordRequestTimeout(apiKey)
            state.timedOut = true
            if (pipeline.started) {
              pipeline.writeNow(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: timeoutMessage(apiKey) }, retry_after: 5 })}\n\n`)
            }
          } else {
            state.errorMsg = e?.message ?? String(e)
            log('error', 'Anthropic stream error', { message: state.errorMsg })
            try { abortController.abort() } catch {}
            if (pipeline.started) {
              pipeline.writeNow(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: state.errorMsg } })}\n\n`)
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
          return sendAnthropicError(state.upstreamError.status, state.upstreamError.body.error.type, state.upstreamError.body.error.message)
        }
        if (state.timedOut) {
          return sendAnthropicError(429, 'rate_limit_error', timeoutMessage(apiKey))
        }
        if (state.zeroOutput) {
          return sendAnthropicError(429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', { retryAfter: 10 })
        }
        if (state.errorMsg) {
          return sendAnthropicError(502, 'proxy_error', `Upstream error: ${state.errorMsg}`, { retryAfter: 10 })
        }
        return sendAnthropicError(429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', { retryAfter: 10 })
      }

      return new Response(pipeline.stream, { status: 200, headers: SSE_HEADERS })
    }

    let finishReason = 'stop'
    let usage: any = null
    let toolCalls: any[] | null = null
    let thinkingText = ''
    const state = { upstreamError: null as { status: number; body: any } | null }

    const reader = ccResponse.body!.getReader()
    const parser = new CcStreamParser()
    const hooks: CcEventHooks = {
      'text-delta': (event: any) => { fullText += event.text || '' },
      'reasoning-delta': (event: any) => { thinkingText += event.text || '' },
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
        log('warn', 'CC error (Anthropic non-stream)', { message: event.error?.message || event.message })
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
          path: '/v1/messages',
          model,
          streaming: false,
          timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
          elapsedMs: Date.now() - startTime,
          id: messageId,
          bytesReceived,
          lastCcEvent: lastCcEvent || '(none)',
          partialLen: fullText ? fullText.length : 0,
        })
        reader.cancel().catch(() => {})
        try { abortController.abort() } catch {}
        recordRequestTimeout(apiKey)
        return sendAnthropicError(429, 'rate_limit_error', timeoutMessage(apiKey), { retryAfter: 5, headerOnly: true })
      }
      log('error', 'Upstream error', { message: e?.message })
      try { abortController.abort() } catch {}
      return sendAnthropicError(502, 'proxy_error', `Upstream error: ${e?.message}`, { retryAfter: 10 })
    }

    if (aborted()) {
      return new Response(null, { status: 499 })
    }

    if (state.upstreamError) {
      return sendAnthropicError(state.upstreamError.status, state.upstreamError.body.error.type, state.upstreamError.body.error.message)
    }

    if ((usage?.outputTokens ?? 0) === 0) {
      try { if (!abortController.signal.aborted) abortController.abort() } catch {}
      return sendAnthropicError(429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', { retryAfter: 10 })
    }

    recordRequestSuccess(apiKey)
    return sendJSON(200, buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText))
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
