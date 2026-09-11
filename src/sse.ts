import { log } from './logger'
import { mapCcEventError, mapFinishReason, normalizeUsage } from './errors'
import { CcStreamParser } from './cc-events'
import type { CcEventHooks } from './cc-events'

export class SsePipeline {
  private encoder = new TextEncoder()
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  private buffered: string[] = []
  private firstOutputResolve: (() => void) | null = null
  private terminalResolve: (() => void) | null = null

  readonly stream: ReadableStream<Uint8Array>
  readonly firstOutput: Promise<void>
  readonly terminal: Promise<void>
  started = false
  closed = false
  keepaliveCount = 0

  constructor(private readonly autoStart: boolean) {
    this.firstOutput = new Promise((r) => { this.firstOutputResolve = r })
    this.terminal = new Promise((r) => { this.terminalResolve = r })
    this.stream = new ReadableStream({
      start: (controller) => { this.controller = controller },
    })
  }

  private enqueue(text: string): void {
    try {
      this.controller?.enqueue(this.encoder.encode(text))
    } catch {}
  }

  emit(events: string[]): void {
    if (!events.length) return
    for (const event of events) {
      if (this.started) this.enqueue(event)
      else this.buffered.push(event)
    }
    if (this.autoStart) this.start()
  }

  emitKeepalive(): void {
    if (!this.started || this.closed) return
    this.enqueue(': keepalive\n\n')
    this.keepaliveCount++
  }

  writeNow(event: string): void {
    this.enqueue(event)
  }

  start(): void {
    if (this.started || this.closed) return
    this.started = true
    for (const event of this.buffered) this.enqueue(event)
    this.buffered = []
    this.firstOutputResolve?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.controller?.close()
    } catch {}
    this.terminalResolve?.()
  }

  terminateWith(events: string[]): void {
    if (this.closed) return
    this.started = true
    for (const event of this.buffered) this.enqueue(event)
    this.buffered = []
    for (const event of events) this.enqueue(event)
    this.firstOutputResolve?.()
    this.close()
  }
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
      return makeChunk(completionId, created, model, {}, fr, openaiUsage)
    },
    'error': (event: any) => {
      const msg = event.error?.message || event.message || 'Unknown error'
      log('warn', 'CC stream error', { message: msg })
      state.upstreamError = mapCcEventError(event)
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

    parseChunk(bytes: Uint8Array): string[] {
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
