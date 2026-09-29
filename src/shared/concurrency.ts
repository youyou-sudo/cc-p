// Per-key concurrency control: bounded in-flight slots + FIFO queue with timeout.

export interface ConcurrencyConfig {
  maxInFlightPerKey: number
  maxQueuePerKey: number
  queueTimeoutMs: number
  maxKeys: number
  keyTtlMs: number
}

const DEFAULT: ConcurrencyConfig = {
  maxInFlightPerKey: 4,
  maxQueuePerKey: 16,
  queueTimeoutMs: 15000,
  maxKeys: 5000,
  keyTtlMs: 30 * 60 * 1000,
}

export interface AcquireOptions {
  signal: AbortSignal
  timeoutMs?: number
}

export type Release = () => void

export class ConcurrencyRoomFull extends Error {
  public readonly kind = 'queue_full'
  constructor() {
    super('Concurrency room full')
    this.name = 'ConcurrencyRoomFull'
    Object.setPrototypeOf(this, ConcurrencyRoomFull.prototype)
  }
}

export class ConcurrencyTimeout extends Error {
  public readonly kind = 'queue_timeout'
  constructor() {
    super('Concurrency wait timed out')
    this.name = 'ConcurrencyTimeout'
    Object.setPrototypeOf(this, ConcurrencyTimeout.prototype)
  }
}

export class ConcurrencyAborted extends Error {
  public readonly kind = 'aborted'
  constructor() {
    super('Concurrency wait aborted')
    this.name = 'ConcurrencyAborted'
    Object.setPrototypeOf(this, ConcurrencyAborted.prototype)
  }
}

interface Entry {
  inFlight: number
  waiters: Waiter[]
  lastActiveMs: number
}

interface Waiter {
  opts: AcquireOptions
  deadline: number
  resolve: (release: Release) => void
  reject: (err: Error) => void
  signalListener?: () => void
  timer?: ReturnType<typeof setTimeout>
  started: boolean
}

export class ConcurrencyGate {
  private readonly config: ConcurrencyConfig
  private store: Map<string, Entry> = new Map()

  constructor(config: Partial<ConcurrencyConfig> = {}) {
    this.config = { ...DEFAULT, ...config }
  }

  acquire(key: string, opts: AcquireOptions): Promise<Release> {
    const entry = this.getOrCreate(key)
    const deadline = (opts.timeoutMs ?? this.config.queueTimeoutMs) + Date.now()
    return new Promise<Release>((resolve, reject) => {
      if (opts.signal.aborted) {
        reject(new ConcurrencyAborted())
        return
      }
      const waiter: Waiter = {
        opts,
        deadline,
        resolve,
        reject,
        signalListener: undefined,
        timer: undefined,
        started: false,
      }
      const onAbort = () => this.removeWaiter(entry, waiter, true)
      waiter.signalListener = onAbort
      opts.signal.addEventListener('abort', onAbort, { once: true })
      entry.waiters.push(waiter)
      // Queue capacity only bites when no slot is free: an idle gate always
      // admits immediately (tryDrain promotes before returning), while a
      // saturated one fast-fails once more than maxQueuePerKey are queued.
      const freeSlots = this.config.maxInFlightPerKey - entry.inFlight
      if (freeSlots <= 0 && entry.waiters.length > this.config.maxQueuePerKey) {
        this.removeWaiter(entry, waiter, false)
        reject(new ConcurrencyRoomFull())
        return
      }
      // Enforce the queue deadline even when no release ever triggers a
      // drain (e.g. every in-flight request stalls past the queue timeout).
      waiter.timer = setTimeout(() => {
        waiter.timer = undefined
        if (!waiter.started && entry.waiters.includes(waiter)) {
          this.removeWaiter(entry, waiter, false)
          waiter.reject(new ConcurrencyTimeout())
        }
      }, Math.max(0, deadline - Date.now()))
      this.tryDrain(entry)
    })
  }

  release(key: string): void {
    if (!key) return
    const entry = this.store.get(key)
    if (!entry) return
    entry.lastActiveMs = Date.now()
    if (entry.inFlight > 0) entry.inFlight--
    this.tryDrain(entry)
  }

  snapshot(): { keys: number; inFlight: number; queued: number } {
    let keys = 0
    let inFlight = 0
    let queued = 0
    for (const [, e] of this.store) {
      keys++
      inFlight += e.inFlight
      queued += e.waiters.length
    }
    return { keys, inFlight, queued }
  }

  private tryDrain(entry: Entry): void {
    if (entry.inFlight >= this.config.maxInFlightPerKey) return
    if (entry.waiters.length === 0) return
    const waiter = entry.waiters[0]
    if (!waiter) return
    if (waiter.started) {
      entry.waiters.shift()
      this.tryDrain(entry)
      return
    }
    if (Date.now() >= waiter.deadline) {
      this.removeWaiter(entry, waiter, false)
      waiter.reject(new ConcurrencyTimeout())
      this.tryDrain(entry)
      return
    }
    entry.waiters.shift()
    waiter.started = true
    this.clearWaiterTimer(waiter)
    if (waiter.signalListener) {
      waiter.opts.signal.removeEventListener('abort', waiter.signalListener)
      waiter.signalListener = undefined
    }
    entry.inFlight++
    const release: Release = () => {
      if (entry.inFlight > 0) entry.inFlight--
      this.tryDrain(entry)
    }
    waiter.resolve(release)
  }

  private removeWaiter(entry: Entry, waiter: Waiter, aborted: boolean): void {
    this.clearWaiterTimer(waiter)
    const idx = entry.waiters.indexOf(waiter)
    if (idx !== -1) entry.waiters.splice(idx, 1)
    if (waiter.signalListener) {
      try { waiter.opts.signal.removeEventListener('abort', waiter.signalListener) } catch {}
      waiter.signalListener = undefined
    }
    if (aborted && !waiter.started) {
      waiter.reject(new ConcurrencyAborted())
    }
  }

  private clearWaiterTimer(waiter: Waiter): void {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer)
      waiter.timer = undefined
    }
  }

  private getOrCreate(key: string): Entry {
    let entry = this.store.get(key)
    const now = Date.now()
    // Only recycle a TTL-expired entry that is completely idle: resetting one
    // that still owns in-flight slots would drop their accounting.
    if (!entry || (now - entry.lastActiveMs > this.config.keyTtlMs && entry.inFlight === 0 && entry.waiters.length === 0)) {
      entry = { inFlight: 0, waiters: [], lastActiveMs: now }
      this.store.set(key, entry)
    } else {
      entry.lastActiveMs = now
    }
    return entry
  }

  pruneIfNecessary(): void {
    if (this.store.size < this.config.maxKeys) return
    const now = Date.now()
    for (const [key, entry] of [...this.store]) {
      // Never drop an entry that still owns slots or queued waiters.
      if (now - entry.lastActiveMs > this.config.keyTtlMs && entry.inFlight === 0 && entry.waiters.length === 0) {
        this.store.delete(key)
      }
    }
  }
}

export function createConcurrencyGate(config: Partial<ConcurrencyConfig> = {}): ConcurrencyGate {
  return new ConcurrencyGate(config)
}
