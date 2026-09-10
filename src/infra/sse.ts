// Protocol-agnostic SSE pipeline + idle heartbeat.
//
// Infra owns only the buffered `ReadableStream` machinery and the shared
// idle-heartbeat timer. Protocol-specific translation (e.g. the OpenAI
// `chat.completion.chunk` translator) lives with its protocol module in
// `src/modules/chat/translator.ts`.

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
