import { log } from './logger'
import { mapCcEventError, mapFinishReason, normalizeUsage } from './errors'
import { CcStreamParser } from './cc-events'
import type { CcEventHooks } from './cc-events'

export const SSE_HEARTBEAT_INTERVAL_MS = 5_000
export const SSE_HEARTBEAT_IDLE_MS = 15_000
export const SSE_PING_EVENT = `event: ping\ndata: {"type":"ping"}\n\n`
export const SSE_KEEPALIVE_COMMENT = `: keepalive\n\n`

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
  pingCount = 0
  lastSentAt = Date.now()

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
      this.lastSentAt = Date.now()
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

  /** Anthropic early-flush: keep `message_start` (+ trailing
   *  message_delta/message_stop/error) buffered to preserve zero-output JSON
   *  retry-ability; flush headers on the first content_block_* event (covers
   *  thinking/text/tool_use start or delta). Upstream 487f219 spells this as
   *  "first non-message_start flushes" — narrowed here to content blocks so
   *  an empty-response `error` event can't flip the stream to SSE 200. */
  emitAnthropic(events: string[]): void {
    if (!events.length) return
    for (const event of events) {
      if (this.started) {
        this.enqueue(event)
      } else {
        this.buffered.push(event)
        if (event.startsWith('event: content_block_')) this.start()
      }
    }
  }

  emitKeepalive(): void {
    if (!this.started || this.closed) return
    this.enqueue(SSE_KEEPALIVE_COMMENT)
    this.keepaliveCount++
  }

  /** Idle heartbeat ping. Defaults to the Anthropic-native `ping` event
   *  (Anthropic side must keep it). OpenAI path overrides with the
   *  spec-safe SSE comment heartbeat (SSE_KEEPALIVE_COMMENT), because
   *  plain OpenAI SDKs only look at `data:` lines and would misparse
   *  `{"type":"ping"}` as a chunk. */
  sendPing(event: string = SSE_PING_EVENT): void {
    if (!this.started || this.closed) return
    this.enqueue(event)
    this.pingCount++
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

/** Shared idle-heartbeat: every `intervalMs`, if the pipeline has been
 *  silent for `idleMs`, send an SSE ping. Caller clears the timer in
 *  `finally` (both handlers do). Pings only go out after headers started;
 *  while fully buffered, zero-output retry-ability is preserved. */
export function startSseHeartbeat(
  pipeline: SsePipeline,
  opts?: { intervalMs?: number; idleMs?: number; pingEvent?: string },
): ReturnType<typeof setInterval> {
  const intervalMs = opts?.intervalMs ?? SSE_HEARTBEAT_INTERVAL_MS
  const idleMs = opts?.idleMs ?? SSE_HEARTBEAT_IDLE_MS
  const pingEvent = opts?.pingEvent ?? SSE_PING_EVENT
  return setInterval(() => {
    try {
      if (pipeline.closed) return
      if (!pipeline.started) return
      if (Date.now() - pipeline.lastSentAt > idleMs) pipeline.sendPing(pingEvent)
    } catch {}
  }, intervalMs)
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
