import { CcStreamParser } from '../../infra/cc-events'
import type { CcEventHooks } from '../../infra/cc-events'
import { mapAnthropicStopReason, mapCcEventError, mapFinishReason, normalizeUsage } from '../../shared/errors'
import { log } from '../../shared/logger'
import { bytesToBase64, sha256bytes, uuid } from '../../shared/util'

export function fakeThinkingSignature(thinkingText: string): string {
  const seed = sha256bytes(thinkingText || 'dsh-proxy-thinking').slice(0, 64)
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
      let textCacheControl: { type: 'ephemeral' } | undefined
      const toolResults: any[] = []
      if (typeof msg.content === 'string') {
        textContent = msg.content
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            textContent += block.text || ''
            if (!textCacheControl && block.cache_control?.type === 'ephemeral') {
              textCacheControl = { type: 'ephemeral' }
            }
          } else if (block.type === 'tool_result') {
            toolResults.push(block)
          }
        }
      }
      for (const tr of toolResults) {
        const toolContent = typeof tr.content === 'string' ? tr.content
          : Array.isArray(tr.content) ? tr.content.map((c: any) => c.text || '').join('')
          : String(tr.content || '')
        const toolMsg: any = {
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: toolContent,
        }
        if (toolNameFromId[tr.tool_use_id]) toolMsg.name = toolNameFromId[tr.tool_use_id]
        openaiMessages.push(toolMsg)
      }
      if (textContent) {
        const userMsg: any = { role: 'user', content: [{ type: 'text', text: textContent }] }
        if (textCacheControl) userMsg.content[0].cache_control = textCacheControl
        openaiMessages.push(userMsg)
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

export interface AnthropicStreamContext {
  bytesReceived: number
  lastCcEvent: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  upstreamError: { status: number; body: any } | null
}

export function createAnthropicSseTranslator(
  model: string,
  messageId: string,
  ctx: AnthropicStreamContext,
) {
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

  const messageStartFrame = `event: message_start\ndata: ${JSON.stringify({
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
      log('warn', 'CC stream error', {
        path: '/v1/messages',
        model,
        messageId,
        streaming: true,
        message: (event as any)?.error?.message || (event as any)?.message || 'Unknown error',
        mappedStatus: upstreamError.status,
        mappedType: (upstreamError.body as any)?.error?.type,
        lastCcEvent: parser.lastCcEvent || '(none)',
        bytesReceived: ctx.bytesReceived,
      })
      const retry = (upstreamError.body as any)?.retry_after;
      return `event: error\ndata: ${JSON.stringify({ type: 'error', error: upstreamError.body.error, ...(retry !== undefined ? { retry_after: retry } : {}) })}\n\n`
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
    }
    ctx.inputTokens = inputTokens
    ctx.outputTokens = outputTokens
    ctx.cachedInputTokens = cachedInputTokens
    ctx.cacheWriteTokens = cacheWriteTokens
  }

  return {
    startEvents(): string[] {
      return [messageStartFrame]
    },

    parseChunk(bytes: Uint8Array): string[] {
      ctx.bytesReceived += bytes.byteLength
      const out = parser.push(bytes, hooks)
      ctx.lastCcEvent = parser.lastCcEvent
      return out
    },

    flush(): string[] {
      const out = parser.flush(hooks)
      ctx.lastCcEvent = parser.lastCcEvent
      return out
    },

    finishEvents(): string[] {
      if (hasError) return []
      const out: string[] = []
      const close = closeBlock()
      if (close) out.push(close)

      if (outputTokens === 0) {
        out.push(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`)
      } else {
        out.push(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason || 'end_turn' },
          usage: { output_tokens: outputTokens, cache_read_input_tokens: cachedInputTokens, cache_creation_input_tokens: cacheWriteTokens || 0, input_tokens: inputTokens },
        })}\n\n`)

        out.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
      }
      return out
    },
  }
}
