// OpenAI SSE translator: CC NDJSON → `chat.completion.chunk` frames.
// Pure streaming translation, no I/O.

import { mapCcEventError, mapFinishReason, normalizeUsage } from '../../shared/errors'
import { log } from '../../shared/logger'
import { CcStreamParser } from '../../infra/cc-events'
import type { CcEventHooks } from '../../infra/cc-events'

export function zeroUsageChunk(completionId: string, created: number, model: string): string {
  return `data: ${JSON.stringify({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
  })}\n\n`
}

function makeChunk(id: string, created: number, model: string, delta: any, finishReason: string | null, usage: any): string {
  const chunk: any = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  }
  if (usage) chunk.usage = usage
  return `data: ${JSON.stringify(chunk)}\n\n`
}

export function createSseTranslator(model: string, completionId: string, created: number) {
  let chunkIndex = 0
  let finishReason: string | null = null
  let usage: any = null
  let toolCallIndex = 0

  const parser = new CcStreamParser()
  const state = {
    upstreamError: null as { status: number; body: any } | null,
  }
  const inputTokens = { value: 0 }
  const outputTokens = { value: 0 }
  const cachedInputTokens = { value: 0 }
  let bytesReceived = 0

  const hooks: CcEventHooks = {
    'text-delta': (event: any) => {
      const text = event.text || event.delta || ''
      if (!text) return
      const delta = chunkIndex === 0 ? { role: 'assistant', content: text } : { content: text }
      chunkIndex++
      return makeChunk(completionId, created, model, delta, null, null)
    },
    'reasoning-delta': (event: any) => {
      const text = event.text || ''
      if (!text) return
      const delta = chunkIndex === 0 ? { role: 'assistant', reasoning_content: text } : { reasoning_content: text }
      chunkIndex++
      return makeChunk(completionId, created, model, delta, null, null)
    },
    'tool-call': (event: any) => {
      const id = event.toolCallId || `call_${Date.now()}_${toolCallIndex}`
      const name = event.toolName || ''
      const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {})
      const tcEntry = { index: toolCallIndex, id, type: 'function', function: { name, arguments: args } }
      const delta = chunkIndex === 0
        ? { role: 'assistant', content: null, tool_calls: [tcEntry] }
        : { tool_calls: [tcEntry] }
      chunkIndex++
      toolCallIndex++
      return makeChunk(completionId, created, model, delta, null, null)
    },
    'finish-step': (event: any) => {
      if (event.finishReason) finishReason = mapFinishReason(event.finishReason)
      if (event.usage) {
        usage = event.usage
        inputTokens.value = event.usage.inputTokens ?? 0
        outputTokens.value = event.usage.outputTokens ?? 0
        cachedInputTokens.value = event.usage.cachedInputTokens ?? 0
      }
    },
    'finish': (event: any) => {
      const fr = finishReason || mapFinishReason(event.finishReason || 'stop')
      const u = event.totalUsage || usage || {}
      normalizeUsage(u)
      inputTokens.value = u.inputTokens ?? 0
      outputTokens.value = u.outputTokens ?? 0
      cachedInputTokens.value = u.cachedInputTokens ?? 0
      const openaiUsage = {
        prompt_tokens: u.inputTokens ?? 0,
        completion_tokens: u.outputTokens ?? 0,
        total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
        prompt_tokens_details: { cached_tokens: u.cachedInputTokens ?? 0 },
      }
      log('info', 'OpenAI stream finish', {
        path: '/v1/chat/completions',
        model,
        completionId,
        streaming: true,
        inputTokens: inputTokens.value,
        outputTokens: outputTokens.value,
        cachedInputTokens: cachedInputTokens.value,
      })
      return makeChunk(completionId, created, model, {}, fr, openaiUsage)
    },
    'error': (event: any) => {
      const msg = event.error?.message || event.message || 'Unknown error'
      state.upstreamError = mapCcEventError(event)
      log('warn', 'CC stream error', {
        path: '/v1/chat/completions',
        model,
        completionId,
        streaming: true,
        message: msg,
        lastCcEvent: parser.lastCcEvent || '(none)',
        bytesReceived,
        mappedStatus: state.upstreamError.status,
        mappedType: state.upstreamError.body?.error?.type,
      })
    },
  }

  return {
    get lastCcEvent() {
      return parser.lastCcEvent
    },
    get upstreamError() {
      return state.upstreamError
    },
    get inputTokens() {
      return inputTokens.value
    },
    get outputTokens() {
      return outputTokens.value
    },
    get cachedInputTokens() {
      return cachedInputTokens.value
    },
    get bytesReceived() {
      return bytesReceived
    },
    get rawUsage() {
      const toNum = (v: any): number => {
        const n = Number(v)
        return Number.isFinite(n) ? n : 0
      }
      return {
        input_tokens: toNum(inputTokens.value),
        output_tokens: toNum(outputTokens.value),
        cached_tokens: toNum(cachedInputTokens.value),
      }
    },

    parseChunk(bytes: Uint8Array): string[] {
      bytesReceived += bytes.byteLength
      return parser.push(bytes, hooks)
    },

    flush(): string[] {
      return parser.flush(hooks)
    },

    getDoneEvent(): string {
      return 'data: [DONE]\n\n'
    },
  }
}

export type ChatStreamTranslator = ReturnType<typeof createSseTranslator>
