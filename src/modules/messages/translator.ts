import { CcStreamParser } from '../../infra/cc-events'
import type { CcEventHooks } from '../../infra/cc-events'
import { mapAnthropicStopReason, mapCcEventError, mapFinishReason, normalizeUsage } from '../../shared/errors'
import { log } from '../../shared/logger'
import { bytesToBase64, sha256bytes, uuid } from '../../shared/util'

// ---- local helpers (file-local, avoid cycles) ----
function toNum(v: any): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
/** CC text delta may arrive as {text} or {delta}; tolerate both. */
function textOrDelta(e: any): string {
  return e.text ?? e.delta ?? ''
}
/** Only allow legal OpenAI finish_reason; unknown maps to stop (never pass through illegal). */
function safeMapFinishReason(reason: any): string {
  const mapped = mapFinishReason(String(reason || 'stop'))
  if (mapped === 'tool_calls' || mapped === 'length' || mapped === 'stop') return mapped
  if (mapped === 'content_filter' || mapped === 'function_call') return mapped
  log('debug', 'unknown CC finishReason mapped to stop', { reason })
  return 'stop'
}
/**
 * Anthropic stop mapping with debug on unknown: unknown → end_turn is kept
 * (Anthropic SDK requires a known stop_reason) but logged so masking is visible.
 */
function safeMapAnthropicStopReason(finishReason: string): string {
  if (finishReason === 'tool_calls') return 'tool_use'
  if (finishReason === 'length') return 'max_tokens'
  if (finishReason === 'stop') return 'end_turn'
  const mapped = mapAnthropicStopReason(finishReason)
  log('debug', 'unknown stop reason mapped to end_turn', { finishReason })
  return mapped
}
/**
 * Multi-step priority: tool_use > max_tokens > end_turn.
 * First non-end_turn wins; a later end_turn must not overwrite max_tokens.
 */
function mergeAnthropicStopReason(current: string | null, incoming: string): string {
  const pri = (v: string | null): number => {
    if (v === 'tool_use') return 3
    if (v === 'max_tokens') return 2
    if (v === 'end_turn') return 1
    return 0
  }
  if (current == null) return incoming
  return pri(incoming) > pri(current) ? incoming : current
}
/** Length-based output estimate (len/4, min 1 for non-empty) — never +1/+20 hardcode. */
function estimateTokensForText(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

// fakeThinkingSignature kept: Anthropic requires a signature for thinking
// blocks; upstream gives none, so we synthesize a deterministic placeholder.
export function fakeThinkingSignature(thinkingText: string): string {
  const seed = sha256bytes(thinkingText || 'dsh-proxy-thinking').slice(0, 64)
  const raw = new Uint8Array([0x12, seed.length, ...seed])
  return bytesToBase64(raw)
}

/** Extract a data-URL or plain URL from an Anthropic image/document source. */
function anthropicSourceToUrl(source: any): string {
  if (!source) return ''
  if (typeof source === 'string') return source
  if (source.url) return source.url
  if (source.data) {
    const media = source.media_type || source.mediaType || 'image/jpeg'
    return `data:${media};base64,${source.data}`
  }
  return ''
}

/** tool_result content → text, preserving image placeholders instead of dropping. */
function toolResultContentToText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c: any) => {
      if (c == null) return ''
      if (typeof c === 'string') return c
      if (c.type === 'text') return c.text || ''
      if (c.type === 'image') return '[image omitted]'
      if (c.text) return c.text
      return ''
    }).join('')
  }
  if (content == null) return ''
  if (typeof content === 'object' && (content as any).text) return (content as any).text
  return String(content || '')
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
      const textParts: string[] = []
      const reasoningParts: string[] = []
      const toolCalls: any[] = []
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }]
      for (const block of blocks) {
        if (block.type === 'text') {
          if (block.text) textParts.push(block.text)
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
        } else if (block.type === 'thinking') {
          // Preserve thinking history as reasoning_content (don't drop).
          if (block.thinking) reasoningParts.push(block.thinking)
        } else if (block.type === 'redacted_thinking') {
          reasoningParts.push('[redacted thinking omitted]')
        }
      }
      // Multi-text blocks joined with \n\n (preserve paragraph boundaries).
      const textContent = textParts.join('\n\n')
      const assistantMsg: any = { role: 'assistant', content: textContent || null }
      if (reasoningParts.length > 0) assistantMsg.reasoning_content = reasoningParts.join('\n\n')
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
      openaiMessages.push(assistantMsg)
    } else if (msg.role === 'user') {
      const contentParts: any[] = []
      const toolResults: any[] = []
      if (typeof msg.content === 'string') {
        if (msg.content) contentParts.push({ type: 'text', text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            if (block.text == null && !block.cache_control) continue
            const part: any = { type: 'text', text: block.text || '' }
            // Preserve ephemeral breakpoints per-part (don't collapse to first only).
            if (block.cache_control?.type === 'ephemeral') {
              part.cache_control = { type: 'ephemeral' }
            }
            contentParts.push(part)
          } else if (block.type === 'image') {
            // Pass through as OpenAI image_url (don't drop).
            const url = anthropicSourceToUrl(block.source)
            if (url) {
              const imgPart: any = { type: 'image_url', image_url: { url } }
              if (block.cache_control?.type === 'ephemeral') imgPart.cache_control = { type: 'ephemeral' }
              contentParts.push(imgPart)
            } else {
              contentParts.push({ type: 'text', text: '[image omitted]' })
            }
          } else if (block.type === 'document') {
            // Documents have no OpenAI equivalent; pass through as image_url when possible.
            const url = anthropicSourceToUrl(block.source)
            if (url) {
              const docPart: any = { type: 'image_url', image_url: { url } }
              if (block.cache_control?.type === 'ephemeral') docPart.cache_control = { type: 'ephemeral' }
              contentParts.push(docPart)
            } else {
              contentParts.push({ type: 'text', text: '[document omitted]' })
            }
          } else if (block.type === 'tool_result') {
            toolResults.push(block)
          } else if (block.type === 'tool_use') {
            // Defensive: tool_use should not appear in user turn, but don't drop.
            toolNameFromId[block.id] = block.name
          }
        }
      }
      for (const tr of toolResults) {
        const toolContent = toolResultContentToText(tr.content)
        const toolMsg: any = {
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: toolContent,
        }
        if (toolNameFromId[tr.tool_use_id]) toolMsg.name = toolNameFromId[tr.tool_use_id]
        // Pass through error flag (don't drop).
        if ((tr as any).is_error !== undefined) toolMsg.is_error = (tr as any).is_error
        openaiMessages.push(toolMsg)
      }
      // Pure-image messages (textContent=='' but images present) must still push.
      if (contentParts.length > 0) {
        openaiMessages.push({ role: 'user', content: contentParts })
      }
    }
  }

  const openaiReq: any = {
    // Default aligns with messages handler (claude-sonnet-4-6), not chat default.
    model: anthropicReq.model || 'claude-sonnet-4-6',
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
    // Pass through parallel-use switch (don't silently drop).
    if (tc.disable_parallel_tool_use !== undefined) {
      if (typeof openaiReq.tool_choice === 'string') {
        openaiReq.tool_choice = { type: openaiReq.tool_choice, disable_parallel_tool_use: tc.disable_parallel_tool_use }
      } else if (openaiReq.tool_choice && typeof openaiReq.tool_choice === 'object') {
        openaiReq.tool_choice.disable_parallel_tool_use = tc.disable_parallel_tool_use
      }
    }
  }

  if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature
  if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p
  if (anthropicReq.top_k !== undefined) {
    // OpenAI/CC has no top_k; pass through for CC to ignore, debug-log so it's visible.
    openaiReq.top_k = anthropicReq.top_k
    log('debug', 'anthropic top_k passthrough (CC ignores)', { top_k: anthropicReq.top_k })
  }
  if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences
  if (anthropicReq.metadata?.user_id) openaiReq.user = anthropicReq.metadata.user_id

  if (anthropicReq.thinking) {
    const t = anthropicReq.thinking
    if (t.type === 'disabled' || t.type === 'none') {
    } else if (t.type === 'adaptive') {
      openaiReq.reasoning_effort = t.effort ?? 'medium'
    } else if (t.budget_tokens !== undefined) {
      // 10k/5k cutoffs kept; <5k (incl 2k bucket) → low (previously duplicated else branch collapsed).
      if (t.budget_tokens >= 10000) openaiReq.reasoning_effort = 'high'
      else if (t.budget_tokens >= 5000) openaiReq.reasoning_effort = 'medium'
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
  // Zero-output caliber: text / thinking / tool any-present counts as non-zero.
  let hasText = false
  let hasThinking = false
  let hasToolCall = false
  let textChars = 0
  let thinkingChars = 0
  let toolInputChars = 0
  // tool-input-* incremental accumulation (large params assembled here).
  let pendingToolInput: { id: string; name: string; json: string } | null = null

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

  function emitToolUseBlock(id: string, name: string, inputJson: string): string[] {
    const out: string[] = []
    const close = closeBlock()
    if (close) out.push(close)
    const finalId = id || `toolu_${uuid().slice(0, 12)}`
    const tcIndex = nextBlockIndex++
    out.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: tcIndex, content_block: { type: 'tool_use', id: finalId, name: name || '', input: {} } })}\n\n`)
    out.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: tcIndex, delta: { type: 'input_json_delta', partial_json: inputJson } })}\n\n`)
    out.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: tcIndex })}\n\n`)
    hasToolCall = true
    toolInputChars += inputJson.length
    // NOTE: outputTokens here is authoritative usage only (set in
    // handleFinishStep). Length estimates are applied solely as a backfill
    // in finishEvents when upstream reports 0/missing — never incremented
    // per-event (avoids +1/+20 hardcode and double-count with deltas).
    return out
  }

  function flushPendingToolInput(): string[] {
    if (pendingToolInput && pendingToolInput.json) {
      const { id, name, json } = pendingToolInput
      pendingToolInput = null
      return emitToolUseBlock(id, name, json)
    }
    pendingToolInput = null
    return []
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
      const text = textOrDelta(event)
      if (!text) return
      // Thinking counts toward non-zero-output (via hasThinking + char counts
      // backfilled in finishEvents), but outputTokens stays authoritative usage.
      hasThinking = true
      thinkingChars += text.length
      const open = startThinkingBlock()
      currentThinkingText += text
      return open + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'thinking_delta', thinking: text } })}\n\n`
    },

    'text-delta': (event: any) => {
      const text = textOrDelta(event)
      if (!text) return
      hasText = true
      textChars += text.length
      const open = startTextBlock()
      return open + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text } })}\n\n`
    },

    'tool-call': (event: any) => {
      if (hasError) return
      const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input ?? {})
      // A final tool-call supersedes any pending incremental buffer.
      pendingToolInput = null
      return emitToolUseBlock(event.toolCallId || '', event.toolName || '', input)
    },

    'tool-input-start': (event: any) => {
      if (hasError) return
      pendingToolInput = {
        id: event.toolCallId || event.id || event.toolUseId || pendingToolInput?.id || '',
        name: event.toolName || event.name || pendingToolInput?.name || '',
        json: '',
      }
    },

    'tool-input-delta': (event: any) => {
      if (hasError) return
      const d = event.delta ?? event.text ?? event.partial_json ?? event.partialJson
        ?? event.data ?? event.json ?? event.value ?? event.input ?? ''
      const s = typeof d === 'string' ? d : JSON.stringify(d)
      if (!pendingToolInput) {
        pendingToolInput = {
          id: event.toolCallId || event.id || '',
          name: event.toolName || event.name || '',
          json: '',
        }
      } else {
        if (event.toolCallId || event.id) pendingToolInput.id = event.toolCallId || event.id
        if (event.toolName || event.name) pendingToolInput.name = event.toolName || event.name
      }
      if (s) {
        pendingToolInput.json += s
        // Track chars for the finishEvents backfill estimate; outputTokens
        // stays authoritative usage (see emitToolUseBlock note).
        toolInputChars += s.length
        hasToolCall = true
      }
    },

    'tool-input-end': (event: any) => {
      if (hasError) return
      const fullInput = event.input ?? event.json ?? null
      // End carries the complete input when present; otherwise emit the
      // buffered incremental payload. Either way pending is cleared so a
      // later flush/finishEvents cannot double-emit the same block.
      const id = event.toolCallId || event.id || pendingToolInput?.id || ''
      const name = event.toolName || event.name || pendingToolInput?.name || ''
      const argsStr = fullInput != null
        ? (typeof fullInput === 'string' ? fullInput : JSON.stringify(fullInput ?? {}))
        : (pendingToolInput?.json || '')
      pendingToolInput = null
      if (argsStr || id || name) return emitToolUseBlock(id, name, argsStr)
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
    // Suppress post-error finish (error wins).
    if (hasError) return
    if (event.finishReason) {
      const mapped = safeMapAnthropicStopReason(safeMapFinishReason(event.finishReason))
      stopReason = mergeAnthropicStopReason(stopReason, mapped)
    }
    const u = event.totalUsage || event.usage
    if (u) {
      normalizeUsage(u)
      // Accumulate, never reset: missing fields preserve earlier step values.
      // String numerals tolerated via toNum (NaN → 0 handled at read time).
      if (u.inputTokens != null) inputTokens = toNum(u.inputTokens)
      if (u.outputTokens != null) outputTokens = toNum(u.outputTokens)
      if (u.cachedInputTokens != null) cachedInputTokens = toNum(u.cachedInputTokens)
      const cw = u.inputTokenDetails?.cacheWriteTokens ?? (u as any).cacheWriteTokens
      if (cw != null) cacheWriteTokens = toNum(cw)
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
      // Incremental-only tool calls (deltas without a final tool-call/end)
      // must still surface when the stream ends without a finish event.
      if (!hasError) out.push(...flushPendingToolInput())
      return out
    },

    finishEvents(): string[] {
      // Incremental-only tool calls flush here when finish arrives without a final tool-call.
      if (!hasError) {
        const pending = flushPendingToolInput()
        if (pending.length > 0) {
          // Emit pending tool blocks before the terminal frames.
          const out: string[] = [...pending]
          const close = closeBlock()
          if (close) out.push(close)
          const hasContent = hasText || hasThinking || hasToolCall
          let outTokens = outputTokens
          if (outTokens === 0 && hasContent) {
            const est = Math.ceil((textChars + thinkingChars + toolInputChars) / 4) || 1
            outTokens = est
            outputTokens = est
            ctx.outputTokens = est
          }
          if (outTokens === 0) {
            out.push(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`)
          } else {
            out.push(`event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: stopReason || 'end_turn' },
              usage: { output_tokens: outTokens, cache_read_input_tokens: cachedInputTokens, cache_creation_input_tokens: cacheWriteTokens || 0, input_tokens: inputTokens },
            })}\n\n`)
            out.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
          }
          return out
        }
      }
      if (hasError) {
        // Terminate the SSE stream cleanly after an error frame.
        const out: string[] = []
        const close = closeBlock()
        if (close) out.push(close)
        out.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
        return out
      }
      const out: string[] = []
      const close = closeBlock()
      if (close) out.push(close)

      // Content-aware zero guard: text / thinking / tool any-present counts
      // as non-zero; backfill a length estimate when upstream reports 0/missing.
      const hasContent = hasText || hasThinking || hasToolCall
      let outTokens = outputTokens
      if (outTokens === 0 && hasContent) {
        const est = Math.ceil((textChars + thinkingChars + toolInputChars) / 4)
        if (est > 0) {
          outTokens = est
          outputTokens = est
          ctx.outputTokens = est
        } else {
          outTokens = 1
          outputTokens = 1
          ctx.outputTokens = 1
        }
      }
      if (outTokens === 0) {
        out.push(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`)
      } else {
        out.push(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason || 'end_turn' },
          usage: { output_tokens: outTokens, cache_read_input_tokens: cachedInputTokens, cache_creation_input_tokens: cacheWriteTokens || 0, input_tokens: inputTokens },
        })}\n\n`)

        out.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
      }
      return out
    },
  }
}
