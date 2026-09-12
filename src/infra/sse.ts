// Protocol-agnostic SSE pipeline + idle heartbeat.
//
// Infra owns only the buffered `ReadableStream` machinery and the shared
// idle-heartbeat timer. Protocol-specific translation (e.g. the OpenAI
// `chat.completion.chunk` translator) lives with its protocol module in
// `src/modules/chat/translator.ts`.
//
// ── 双语义说明（一类两语义，策略参数显式命名） ──────────────────────────
// 同一个 SsePipeline 服务两路协议，但心跳帧语义不同，由调用方通过
// startSseHeartbeat(opts.pingEvent) 显式选择：
//   - OpenAI (/v1/chat/completions): SSE 注释帧 `: keepalive`（SSE_KEEPALIVE_COMMENT）。
//     纯 OpenAI SDK 只解析 `data:` 行，`{"type":"ping"}` 会被误解析为 chunk，
//     所以必须用 spec-safe 的 SSE comment 心跳。
//   - Anthropic (/v1/messages): 原生 `event: ping` 事件（SSE_PING_EVENT）。
//     Anthropic SDK 要求保留该事件。
// autoStart 语义（构造函数参数）：
//   - true (chat): 任意 emit() 到来即 start()（立即刷响应头，首帧即 200）。
//   - false (messages): 仅当 content_block_* 到来才 start()，`message_start` 及
//     后续空响应的 `error` 事件保持 buffered，以保留零输出转 429 JSON 的能力；
//     空响应 `error` 事件绝不能触发 start()（否则流会翻转为 SSE 200）。

import { log } from '../shared/logger'

export const SSE_HEARTBEAT_INTERVAL_MS = 5_000
export const SSE_HEARTBEAT_IDLE_MS = 15_000
export const SSE_PING_EVENT = `event: ping\ndata: {"type":"ping"}\n\n`
export const SSE_KEEPALIVE_COMMENT = `: keepalive\n\n`

/** buffered 熔断上限：条数与近似字节数（Bun ReadableStream 无可靠
 *  desiredSize，超时空转时上游仍在推事件，用 buffered 长度熔断避免无限涨）。 */
export const SSE_MAX_BUFFERED_EVENTS = 1000
export const SSE_MAX_BUFFERED_BYTES = 1_000_000

export class SsePipeline {
  private encoder = new TextEncoder()
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  private buffered: string[] = []
  private bufferedBytes = 0
  private firstOutputResolve: (() => void) | null = null
  private terminalResolve: (() => void) | null = null
  /** 由 handler 经 attachReader() 登记的上游 reader；cancel() 负责取消它
   *  （停止上游 fetch / 计费），与 close()（关闭下游流）语义分离。 */
  private upstreamReader: { cancel: () => unknown } | null = null

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

  /** 登记上游 reader，供 cancel() 调用。Handler 在 pump 内 getReader() 后应立即登记。 */
  attachReader(reader: { cancel: () => unknown } | null): void {
    this.upstreamReader = reader
  }

  /** 取消上游拉取（abort/超时/finally 统一路径调用）。幂等，可重复调用。 */
  cancel(): void {
    const r = this.upstreamReader
    this.upstreamReader = null
    if (!r) return
    try {
      const res = r.cancel() as unknown
      if (res instanceof Promise) res.catch(() => {})
    } catch {}
  }

  private enqueue(text: string): void {
    if (this.closed) return
    try {
      this.controller?.enqueue(this.encoder.encode(text))
      this.lastSentAt = Date.now()
    } catch (e: any) {
      // 背压/下游已断开：队列满抛错时直接关闭，避免异常上浮杀死 pump；
      // buffered 已在 close() 中清空，不会无限涨。
      log('warn', 'SSE enqueue failed, closing pipeline', { message: e?.message ?? String(e) })
      try { this.close() } catch {}
    }
  }

  /** buffered 入队（含 1000 条 / 1MB 熔断：超限丢最旧并记 warn）。 */
  private pushBuffered(event: string): void {
    const len = event.length
    if (this.buffered.length >= SSE_MAX_BUFFERED_EVENTS || this.bufferedBytes + len > SSE_MAX_BUFFERED_BYTES) {
      let dropped = 0
      while (this.buffered.length > 0 && (this.buffered.length >= SSE_MAX_BUFFERED_EVENTS || this.bufferedBytes + len > SSE_MAX_BUFFERED_BYTES)) {
        const old = this.buffered.shift()!
        this.bufferedBytes -= old.length
        dropped++
      }
      log('warn', 'SSE buffered cap hit, dropped oldest', {
        dropped,
        bufferedEvents: this.buffered.length,
        autoStart: this.autoStart,
      })
    }
    this.buffered.push(event)
    this.bufferedBytes += len
  }

  emit(events: string[]): void {
    if (this.closed || !events.length) return
    for (const event of events) {
      if (this.started) this.enqueue(event)
      else this.pushBuffered(event)
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
    if (this.closed || !events.length) return
    for (const event of events) {
      if (this.started) {
        this.enqueue(event)
      } else {
        this.pushBuffered(event)
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
    this.bufferedBytes = 0
    this.firstOutputResolve?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    // 静默关闭：清空 buffered 并只 resolve terminal，不碰 firstOutput。
    // 刻意让「未 start 即 close」（流前 abort）的 race 落到 terminal 分支，
    // 若此处也 resolve firstOutput，race 会误判为 started（已返回 200）。
    this.buffered = []
    this.bufferedBytes = 0
    try {
      this.controller?.close()
    } catch {}
    this.terminalResolve?.()
  }
}

/** Shared idle-heartbeat: every `intervalMs`, if the pipeline has been
 *  silent for `idleMs`, send an SSE ping. Caller clears the timer in
 *  `finally` (both handlers do). Pings only go out after headers started;
 *  while fully buffered, zero-output retry-ability is preserved.
 *  定时器已 unref：纯保活计时器不得拖住进程退出。 */
export function startSseHeartbeat(
  pipeline: SsePipeline,
  opts?: { intervalMs?: number; idleMs?: number; pingEvent?: string },
): ReturnType<typeof setInterval> {
  const intervalMs = opts?.intervalMs ?? SSE_HEARTBEAT_INTERVAL_MS
  const idleMs = opts?.idleMs ?? SSE_HEARTBEAT_IDLE_MS
  const pingEvent = opts?.pingEvent ?? SSE_PING_EVENT
  const timer = setInterval(() => {
    try {
      if (pipeline.closed) return
      if (!pipeline.started) return
      if (Date.now() - pipeline.lastSentAt > idleMs) pipeline.sendPing(pingEvent)
    } catch {}
  }, intervalMs)
  try { (timer as unknown as { unref?: () => void }).unref?.() } catch {}
  return timer
}
