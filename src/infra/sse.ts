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
  /** Frames the downstream controller rejected (client already gone). */
  enqueueErrorCount = 0
  /** Frames successfully handed to the client. */
  emittedCount = 0
  /** Why close() was called, for the terminal log. */
  closeReason: string | null = null
  lastSentAt = Date.now()

  constructor(private readonly autoStart: boolean) {
    this.firstOutput = new Promise((r) => { this.firstOutputResolve = r })
    this.terminal = new Promise((r) => { this.terminalResolve = r })
    this.stream = new ReadableStream({
      start: (controller) => { this.controller = controller },
      // Fires when the CLIENT goes away mid-stream (Bun cancels the response
      // body). Previously unobserved: the pump loop would keep running until
      // the upstream read timed out, so a disconnect looked like an upstream
      // stall in the logs. Recorded so the terminal log can say which it was.
      cancel: (reason) => {
        this.clientCancelled = true
        this.clientCancelReason = String(reason ?? '(none)')
      },
    })
    this.clientCancelled = false
    this.clientCancelReason = null
  }

  /**
   * Write one SSE frame.
   *
   * `enqueueErrorCount` tracks frames we could NOT hand to the client. That
   * happens exactly when the downstream connection is already gone: the
   * ReadableStream controller throws. This used to be a bare `catch {}`, which
   * hid the single most diagnostic signal of a client-side disconnect — the
   * heartbeat would keep counting keepaliveCount/pingCount as it wrote into a
   * dead socket, and nothing in the log revealed it. Now the count is surfaced
   * in the handler's terminal log (see `snapshot()`), so "the client vanished
   * mid-stream" is distinguishable from "the client was slow".
   */
  private enqueue(text: string): void {
    try {
      this.controller?.enqueue(this.encoder.encode(text))
      this.lastSentAt = Date.now()
      this.emittedCount++
    } catch {
      this.enqueueErrorCount++
    }
  }

  clientCancelled = false
  clientCancelReason: string | null = null
  closeErrorCount = 0
  heartbeatErrorCount = 0
  heartbeatErrorLast: string | null = null

  /** Counters for the terminal log line. */
  snapshot(): {
    keepaliveCount: number
    pingCount: number
    enqueueErrorCount: number
    emitted: number
    clientCancelled: boolean
    closeReason: string | null
    closeErrorCount: number
    heartbeatErrorCount: number
    heartbeatErrorLast: string | null
  } {
    return {
      keepaliveCount: this.keepaliveCount,
      pingCount: this.pingCount,
      enqueueErrorCount: this.enqueueErrorCount,
      emitted: this.emittedCount,
      clientCancelled: this.clientCancelled,
      closeReason: this.closeReason,
      closeErrorCount: this.closeErrorCount,
      heartbeatErrorCount: this.heartbeatErrorCount,
      heartbeatErrorLast: this.heartbeatErrorLast,
    }
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

  close(reason?: string): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason ?? 'normal'
    try {
      this.controller?.close()
    } catch {
      // Closing a stream the client already abandoned throws. That is a
      // disconnect, not a bug, but it must be visible: the handler logs
      // `enqueueErrorCount`/`clientCancelled` and this is the matching signal
      // that the failure happened at close rather than during a write.
      this.closeErrorCount++
    }
    this.terminalResolve?.()
  }

  /** Flush trailing events and close. Both call sites are client-abort paths
   *  (chat and messages `onClientAbort`), so the reason is fixed rather than
   *  left to close()'s 'normal' default — otherwise a disconnect was recorded
   *  as a normal close, which is the opposite of what it is. */
  terminateWith(events: string[], reason: string = 'client-abort'): void {
    if (this.closed) return
    this.started = true
    for (const event of this.buffered) this.enqueue(event)
    this.buffered = []
    for (const event of events) this.enqueue(event)
    this.firstOutputResolve?.()
    this.close(reason)
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
    } catch (e: any) {
      // Previously silent. A throwing heartbeat means the interval is writing
      // into a dead pipeline, which is exactly the "sudden disconnect" shape;
      // count it and let the handler's terminal log report it.
      pipeline.heartbeatErrorCount++
      pipeline.heartbeatErrorLast = e?.message ?? String(e)
    }
  }, intervalMs)
}
