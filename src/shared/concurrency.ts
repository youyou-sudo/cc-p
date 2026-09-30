// Layer: domain（可依赖 kernel / toolkit，不可被 kernel 依赖）
// Per-key concurrency gate: bound in-flight requests per upstream key, queue
// the overflow with a deadline, fail fast when the queue is full. Covered by
// test/unit.ts.
//
// Isolation key is the effective upstream key (the same `apiKey` string that
// session.ts / fingerprint.ts / runtime.ts already scope on): one Map bucket
// per key, keys never share slots. Single-process singleton via proxy-handler.

export class ConcurrencyAborted extends Error {
  constructor(message = 'Concurrency acquire aborted') {
    super(message)
    this.name = 'ConcurrencyAborted'
  }
}

export class ConcurrencyTimeout extends Error {
  constructor(message = 'Concurrency queue timeout') {
    super(message)
    this.name = 'ConcurrencyTimeout'
  }
}

export class ConcurrencyRoomFull extends Error {
  constructor(message = 'Concurrency queue full') {
    super(message)
    this.name = 'ConcurrencyRoomFull'
  }
}

export interface ConcurrencyGateOptions {
  maxInFlightPerKey?: number
  maxQueuePerKey?: number
  queueTimeoutMs?: number
}

export interface AcquireOptions {
  signal?: AbortSignal
}

export interface GateSnapshot {
  inFlight: number
  queued: number
}

/** Aggregate water-level for readyz/health. Non-breaking additive API. */
export interface GateStats extends GateSnapshot {
  keys: number
  maxInFlightPerKey: number
  maxQueuePerKey: number
  queueTimeoutMs: number
}

export type ReleaseFn = () => void

interface Waiter {
  key: string
  resolve: (release: ReleaseFn) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
  onAbort: (() => void) | undefined
  signal: AbortSignal | undefined
  settled: boolean
}

const DEFAULT_MAX_IN_FLIGHT = 16
const DEFAULT_MAX_QUEUE = 64
const DEFAULT_QUEUE_TIMEOUT_MS = 60_000

const allGates = new Set<ConcurrencyGate>()

/** Global prune for session cleanup: drops empty buckets on every gate
 *  without needing a handle to the proxy-handler singleton (avoids a
 *  session -> proxy-handler -> cc -> session import cycle). */
export function pruneAllGatesEmpty(): void {
  for (const g of allGates) {
    try { g.pruneEmpty() } catch {}
  }
}

export class ConcurrencyGate {
  private readonly maxInFlightPerKey: number
  private readonly maxQueuePerKey: number
  private readonly queueTimeoutMs: number
  private readonly inFlight = new Map<string, number>()
  private readonly queues = new Map<string, Waiter[]>()

  constructor(opts: ConcurrencyGateOptions = {}) {
    this.maxInFlightPerKey = opts.maxInFlightPerKey ?? DEFAULT_MAX_IN_FLIGHT
    this.maxQueuePerKey = opts.maxQueuePerKey ?? DEFAULT_MAX_QUEUE
    this.queueTimeoutMs = opts.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS
    allGates.add(this)
  }

  snapshot(key?: string): GateSnapshot {
    if (key !== undefined) {
      return {
        inFlight: this.inFlight.get(key) ?? 0,
        queued: this.queues.get(key)?.length ?? 0,
      }
    }
    let inFlight = 0
    let queued = 0
    for (const n of this.inFlight.values()) inFlight += n
    for (const q of this.queues.values()) queued += q.length
    return { inFlight, queued }
  }

  /** Aggregate water-level for readyz/health. Additive only, no breaking change. */
  getStats(): GateStats {
    const snap = this.snapshot()
    const keys = new Set<string>([...this.inFlight.keys(), ...this.queues.keys()]).size
    return {
      ...snap,
      keys,
      maxInFlightPerKey: this.maxInFlightPerKey,
      maxQueuePerKey: this.maxQueuePerKey,
      queueTimeoutMs: this.queueTimeoutMs,
    }
  }

  /** Non-blocking acquire: returns a release fn when a slot is free, else null
   *  without queueing. Used for water-level probes / load-shedding. */
  tryAcquire(key: string): ReleaseFn | null {
    const inFlight = this.inFlight.get(key) ?? 0
    if (inFlight < this.maxInFlightPerKey) {
      this.inFlight.set(key, inFlight + 1)
      return this.makeRelease(key)
    }
    return null
  }

  /** Defensive cleanup of empty buckets (queues already delete on drain, but
   *  long-lived processes can accumulate empty keys via races). Idempotent. */
  pruneEmpty(): void {
    for (const [k, q] of this.queues) {
      if (q.length === 0) this.queues.delete(k)
    }
    for (const [k, n] of this.inFlight) {
      if (n <= 0) this.inFlight.delete(k)
    }
  }

  acquire(key: string, opts: AcquireOptions = {}): Promise<ReleaseFn> {
    const signal = opts.signal
    if (signal?.aborted) return Promise.reject(new ConcurrencyAborted())
    const inFlight = this.inFlight.get(key) ?? 0
    if (inFlight < this.maxInFlightPerKey) {
      this.inFlight.set(key, inFlight + 1)
      return Promise.resolve(this.makeRelease(key))
    }
    const queue = this.queues.get(key) ?? []
    if (queue.length >= this.maxQueuePerKey) {
      return Promise.reject(new ConcurrencyRoomFull(`No queue room for key (queued=${queue.length})`))
    }
    return new Promise<ReleaseFn>((resolve, reject) => {
      const waiter: Waiter = {
        key,
        resolve,
        reject,
        timer: undefined,
        onAbort: undefined,
        signal,
        settled: false,
      }
      waiter.timer = setTimeout(() => {
        this.settleWaiter(waiter, (w) => w.reject(new ConcurrencyTimeout(`Queued wait exceeded ${this.queueTimeoutMs}ms`)))
      }, this.queueTimeoutMs)
      if (signal) {
        waiter.onAbort = () => {
          this.settleWaiter(waiter, (w) => w.reject(new ConcurrencyAborted()))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      queue.push(waiter)
      this.queues.set(key, queue)
    })
  }

  private makeRelease(key: string): ReleaseFn {
    let released = false
    return () => {
      if (released) return
      released = true
      this.release(key)
    }
  }

  /** Remove a waiter from its queue, clear its timer/abort hook, then run fn.
   *  Returns false when the waiter already settled (timeout/abort/promotion). */
  private settleWaiter(waiter: Waiter, fn: (w: Waiter) => void): boolean {
    if (waiter.settled) return false
    waiter.settled = true
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort)
    const q = this.queues.get(waiter.key)
    if (q) {
      const idx = q.indexOf(waiter)
      if (idx >= 0) q.splice(idx, 1)
      if (q.length === 0) this.queues.delete(waiter.key)
    }
    fn(waiter)
    return true
  }

  private release(key: string): void {
    const queue = this.queues.get(key)
    if (queue) {
      // Slot transfers directly to the oldest live waiter: in-flight count is
      // unchanged, so no new acquire can sneak in between.
      while (queue.length > 0) {
        const waiter = queue[0]!
        const admitted = this.settleWaiter(waiter, (w) => w.resolve(this.makeRelease(key)))
        if (admitted) {
          if (queue.length === 0) this.queues.delete(key)
          return
        }
      }
      this.queues.delete(key)
    }
    const current = this.inFlight.get(key) ?? 0
    if (current <= 1) this.inFlight.delete(key)
    else this.inFlight.set(key, current - 1)
  }
}
