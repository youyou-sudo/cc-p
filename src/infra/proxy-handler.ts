// Shared plumbing for the two protocol handlers (/v1/chat/completions and
// /v1/messages). Each handler still owns its wire format and its stream /
// non-stream state machine, but the request preamble and the upstream
// forwarding are identical, so they live here once.

import { forwardToCC } from './cc'
import { mapCcError } from '../shared/errors'
import type { MappedError } from '../shared/errors'
import { ensureInitialized } from './fingerprint'
import { log } from '../shared/logger'
import { CFG } from '../shared/config'
import { ConcurrencyAborted, ConcurrencyGate, ConcurrencyTimeout } from '../shared/concurrency'
import type { ReleaseFn } from '../shared/concurrency'
import { limitMeta } from '../shared/limit'
import { backoffDelay, parseRetryAfter } from '../shared/retry'
import { sha256hex } from '../shared/util'

/** @deprecated 旧 readRequestJson 已删（统一走 bodyLimitPlugin 单次限流解析）；
 *  仅为 chat/errors.ts 与 messages/handler-errors.ts 的 buildError 签名保留，
 *  Wave3 迁往 shared/ 后删除。 */
export type JsonParseErrorKind = 'too-large' | 'invalid'

/**
 * Unified client-disconnect handling.
 *
 * A single 'abort' listener is registered first, so it always runs before any
 * later phase hooks. The stream phase may attach a graceful close
 * via `setGracefulClose`; aborting the controller still
 * stops the upstream fetch / billing. When the response goes terminal the
 * graceful hook is dropped via `setGracefulClose(null)`.
 */
export interface UpstreamFlow {
  readonly signal: AbortSignal
  readonly controller: AbortController
  readonly aborted: boolean
  setGracefulClose(fn: (() => void) | null): void
  abort(): void
}

export function createUpstreamFlow(request: Request): UpstreamFlow {
  const controller = new AbortController()
  let aborted = false
  let gracefulClose: (() => void) | null = null
  request.signal.addEventListener('abort', () => {
    aborted = true
    gracefulClose?.()
    try { controller.abort() } catch {}
  }, { once: true })
  return {
    get signal() { return controller.signal },
    get controller() { return controller },
    get aborted() { return aborted },
    setGracefulClose(fn: (() => void) | null): void { gracefulClose = fn },
    abort(): void { try { controller.abort() } catch {} },
  }
}

export interface UpstreamCallArgs<T> {
  apiKey: string
  headers: Record<string, string | undefined>
  ccBody: any
  signal: AbortSignal
  promptCacheKey?: string
  /** Startup log label, e.g. 'CC API error' / 'CC API error (Anthropic)'. */
  label: string
  /** Map a non-2xx upstream status into this protocol's error Response. */
  onCcError: (mapped: MappedError) => T
}

/** Process-wide gate: one in-flight/queue bucket per effective upstream key
 *  (the same key string session/fingerprint/runtime already scope on).
 *  Limits are read from CFG once at module load (CFG itself is frozen after
 *  loadConfig, same as CORS_HEADERS in shared/http). */
const gate = new ConcurrencyGate({
  maxInFlightPerKey: CFG.maxConcurrencyPerKey,
  maxQueuePerKey: CFG.maxQueuePerKey,
  queueTimeoutMs: CFG.queueTimeoutMs,
})

/** Exported for /readyz water-level (additive, no behavior change). */
export function getGateStats() {
  return gate.getStats()
}
export { gate }

/** Non-2xx error body cap: never buffer an unbounded upstream body. */
const ERROR_TEXT_CAP = 64 * 1024
const ERROR_TEXT_TIMEOUT_MS = 10_000

function keyHash(apiKey: string): string {
  try {
    return sha256hex(apiKey).slice(0, 6)
  } catch {
    return 'unknown'
  }
}

/** Redact key/session material from a snippet, then truncate to 200 chars.
 * Never log key/session plaintext: only keyHash() (hash prefix) is logged elsewhere. */
function sanitizeSnippet(text: string, apiKey: string): string {
  let out = text || ''
  try {
    if (apiKey && out.includes(apiKey)) out = out.split(apiKey).join('[REDACTED_KEY]')
  } catch {}
  // Generic patterns (apiKey may appear in a different form than passed in).
  out = out.replace(/user_[A-Za-z0-9_-]+/g, '[REDACTED_KEY]')
  out = out.replace(/sess_[A-Za-z0-9_-]+/g, '[REDACTED_SESSION]')
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED_SESSION]')
  if (out.length > 200) out = out.slice(0, 200)
  return out
}

function headerCaseInsensitive(headers: Record<string, string | undefined>, name: string): string | undefined {
  const direct = headers[name]
  if (direct !== undefined) return direct
  const lower = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k]
  }
  return undefined
}

/** Bounded non-2xx body read: 64KB cap + AbortSignal.timeout(10s) race.
 *  Over-long bodies are truncated (never buffered unbounded). */
async function readUpstreamErrorText(resp: Response): Promise<string> {
  try {
    const textP = resp.text().catch(() => '')
    const timeoutP = new Promise<string>((_, reject) => {
      const sig = AbortSignal.timeout(ERROR_TEXT_TIMEOUT_MS)
      if (sig.aborted) reject(new Error('error-text-timeout'))
      else sig.addEventListener('abort', () => reject(new Error('error-text-timeout')), { once: true })
    })
    const raced = await Promise.race([textP, timeoutP]).catch(() => '')
    const s = typeof raced === 'string' ? raced : ''
    return s.length > ERROR_TEXT_CAP ? s.slice(0, ERROR_TEXT_CAP) : s
  } catch {
    try { await resp.body?.cancel().catch(() => {}) } catch {}
    return ''
  }
}

/** Abort-aware sleep for the 429 retry loop. Rejects on abort so a client
 *  disconnect stops the wait instead of firing one more upstream POST. */
function sleepCancellable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal.aborted) return Promise.reject(new Error('Upstream aborted'))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    try { (timer as unknown as { unref?: () => void }).unref?.() } catch {}
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Upstream aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const noopRelease: ReleaseFn = () => {}

/** Wrap a 2xx upstream Response so the gate slot is held for the whole
 *  stream/aggregate lifecycle:
 *  - explicit `release()` by the handler (stream end / aggregate end), plus
 *  - automatic release when the wrapped body reaches done/cancel/error.
 *  Idempotent: explicit + automatic race safely (first wins). This keeps
 *  backward compat: old handlers that ignore `release` still free the slot
 *  when they drain/cancel `response.body` (all current handlers do). */
function wrapWithGate(response: Response, held: ReleaseFn, signal?: AbortSignal): { response: Response; release: ReleaseFn } {
  let released = false
  const doRelease: ReleaseFn = () => {
    if (released) return
    released = true
    try { held() } catch {}
    try { signal?.removeEventListener('abort', onSignalAbort) } catch {}
  }
  // Abort fallback: handlers return 499 on client disconnect without draining
  // the body (and without calling release); the signal fires in exactly those
  // paths, so the slot is still freed. Normal paths release via done/cancel
  // or the explicit handler call — all idempotent through doRelease.
  const onSignalAbort = () => { doRelease() }
  try { signal?.addEventListener('abort', onSignalAbort, { once: true }) } catch {}
  const body = response.body
  if (!body) {
    // No body to track: ownership transfers to the caller who must release().
    return { response, release: doRelease }
  }
  let origReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!origReader) origReader = body.getReader()
        const { done, value } = await origReader.read()
        if (done) {
          try { controller.close() } catch {}
          doRelease()
        } else {
          controller.enqueue(value)
        }
      } catch (e) {
        doRelease()
        try { controller.error(e) } catch {}
      }
    },
    async cancel(reason) {
      try { await origReader?.cancel(reason).catch(() => {}) } catch {}
      try { await body.cancel(reason).catch(() => {}) } catch {}
      doRelease()
    },
  })
  const out = new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  return { response: out, release: doRelease }
}

/** ensureInitialized → gate → POST /alpha/generate (retry rate_limit) → map non-2xx.
 *
 *  Gate ownership: on 2xx the slot is NOT released here; the returned
 *  `release` transfers ownership to the handler, which must call it at
 *  stream end / aggregate end. The wrapped `response.body` also auto-releases
 *  on done/cancel, so handlers that ignore `release` still free the slot
 *  once they drain the body (backward compat). Error paths release before
 *  returning (returned `release` is a no-op).
 *  `response`/`value` are aliases pointing at the same payload so old callers
 *  using either field keep working: 2xx has both = Response, non-2xx both = T.
 *
 *  Retry budget: total upstream POSTs = retryMax (CFG.retryMax, default 3).
 *  (Previously `attempt >= retryMax` with an open-ended loop issued
 *  retryMax+1 posts — off-by-one: retryMax=3 fired 4 times. Fixed to
 *  `attempt < maxAttempts` where maxAttempts = max(1, retryMax).)
 *
 *  Retry-After: the client-facing value is always passed through verbatim
 *  (never lie), but the local sleep is capped: min(retryAfterMs, retryCapMs).
 *  The slot is released before sleeping and re-acquired after, so a large
 *  Retry-After never holds a gate slot for hours.
 */
export async function callUpstream<T>(
  args: UpstreamCallArgs<T>,
): Promise<
  | { ok: true; response: Response; value: Response; release: ReleaseFn }
  | { ok: false; value: T; response: T; release: ReleaseFn }
> {
  const { apiKey, headers, ccBody, signal, promptCacheKey, label, onCcError } = args
  let model: unknown = undefined
  try {
    model = (ccBody as any)?.params?.model ?? (ccBody as any)?.model
  } catch { model = undefined }
  const kh = keyHash(typeof apiKey === 'string' ? apiKey : '')

  // ZDR unification: CFG.zdr || per-request `x-cmd-zdr: 1` (case-insensitive,
  // read-only from forward's incomingHeaders; no changes to cc.ts).
  const zdrHeader = headerCaseInsensitive(headers, 'x-cmd-zdr')
  const zdr = zdrHeader === '1'
  await ensureInitialized(apiKey, signal, { zdr })

  let release: ReleaseFn | null = null
  // transferred=true means ownership moved to the caller (2xx wrap); the
  // finally below must NOT release in that case.
  let transferred = false
  try {
    try {
      release = await gate.acquire(apiKey, { signal })
    } catch (e: any) {
      // Client disconnect while queued: silent 499 path, never a 429 JSON.
      if (e instanceof ConcurrencyAborted || signal.aborted) {
        log('info', 'Concurrency acquire aborted (client disconnect)', { label, model, keyHash: kh })
        throw e instanceof ConcurrencyAborted ? e : new ConcurrencyAborted()
      }
      // Jittered backoff hints so a gate stampede does not retry in lockstep.
      const isTimeout = e instanceof ConcurrencyTimeout
      const retryAfter = isTimeout ? 2 + Math.random() : 1 + Math.random()
      log('warn', 'Concurrency gate rejected', {
        label, model, keyHash: kh,
        reason: isTimeout ? 'queue_timeout' : 'queue_full',
      })
      const gateReject = onCcError({ status: 429, body: { error: { message: e?.message ?? 'Concurrency limit exceeded', type: 'rate_limit_error' }, retry_after: retryAfter } })
      return { ok: false as const, value: gateReject, response: gateReject, release: noopRelease }
    }

    // Total attempts = retryMax (min 1 so retryMax=0 still tries once).
    const retryMax = Math.max(0, Math.floor(CFG.retryMax))
    const maxAttempts = Math.max(1, retryMax)
    const retryCapMs = Math.max(1, CFG.retryCapMs)
    const retryBaseMs = Math.max(1, CFG.retryBaseMs)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal.aborted) throw new Error('Upstream aborted')
      let ccResponse: Response
      try {
        ccResponse = await forwardToCC(ccBody, apiKey, headers, signal, promptCacheKey)
      } catch (e: any) {
        // Client disconnect / handler abort: propagate so the handler returns
        // 499 / stops the pump; must NOT become a 502 JSON (see timeouts.ts).
        if (e?.name === 'AbortError' || e instanceof ConcurrencyAborted || signal.aborted) throw e
        // Fixed external copy; details stay in logs only.
        log('error', label, { status: 'fetch_error', bodySnippet: sanitizeSnippet(e?.message ?? String(e), apiKey), model, keyHash: kh, attempt })
        const fetchErr = onCcError(mapCcError(502, 'Upstream unavailable'))
        const out = { ok: false as const, value: fetchErr, response: fetchErr, release: noopRelease }
        try { release?.() } catch {}
        release = null
        return out
      }
      if (ccResponse.ok) {
        const held = release!
        release = null
        transferred = true
        const wrapped = wrapWithGate(ccResponse, held, signal)
        return { ok: true as const, response: wrapped.response, value: wrapped.response, release: wrapped.release }
      }

      const errorText = await readUpstreamErrorText(ccResponse)
      const headerValue = ccResponse.headers.get('retry-after')
      const headerSecs = parseRetryAfter(headerValue)
      const meta = limitMeta(ccResponse.status, errorText, headerSecs)
      const retryAfterMs = meta.retryAfterMs
      log('error', label, { status: ccResponse.status, bodySnippet: sanitizeSnippet(errorText, apiKey), model, keyHash: kh, attempt, kind: meta.kind, retryable: meta.retryable })
      if (!meta.retryable || attempt >= maxAttempts - 1 || signal.aborted) {
        // Never lie to the client: pass the upstream Retry-After through even
        // when the local retry loop gives up (e.g. retryAfter > retryCapMs).
        const mapped = onCcError(mapCcError(ccResponse.status, errorText, retryAfterMs))
        const out = { ok: false as const, value: mapped, response: mapped, release: noopRelease }
        try { release?.() } catch {}
        release = null
        return out
      }
      // Upstream Retry-After wins for scheduling but is capped locally:
      // sleep min(retryAfterMs, retryCapMs); passthrough above is unaffected.
      const waitMs = retryAfterMs != null ? Math.min(retryAfterMs, retryCapMs) : backoffDelay(attempt, retryBaseMs, retryCapMs)
      // Release the slot while sleeping so a huge Retry-After never pins the
      // gate; re-acquire before the next POST.
      try { release?.() } catch {}
      release = null
      await sleepCancellable(waitMs, signal)
      try {
        release = await gate.acquire(apiKey, { signal })
      } catch (e: any) {
        if (e instanceof ConcurrencyAborted || signal.aborted) {
          log('info', 'Concurrency re-acquire aborted (client disconnect)', { label, model, keyHash: kh, attempt })
          throw e instanceof ConcurrencyAborted ? e : new ConcurrencyAborted()
        }
        const isTimeout = e instanceof ConcurrencyTimeout
        const retryAfter = isTimeout ? 2 + Math.random() : 1 + Math.random()
        log('warn', 'Concurrency gate rejected (re-acquire)', {
          label, model, keyHash: kh,
          reason: isTimeout ? 'queue_timeout' : 'queue_full', attempt,
        })
        const reacquireReject = onCcError({ status: 429, body: { error: { message: e?.message ?? 'Concurrency limit exceeded', type: 'rate_limit_error' }, retry_after: retryAfter } })
        return { ok: false as const, value: reacquireReject, response: reacquireReject, release: noopRelease }
      }
    }
    // Unreachable (loop always returns/throws), kept for type safety.
    try { release?.() } catch {}
    release = null
    const fallback = onCcError(mapCcError(502, 'Upstream unavailable'))
    return { ok: false as const, value: fallback, response: fallback, release: noopRelease }
  } finally {
    // Backward-compat safety net: error paths already released and nulled;
    // 2xx transferred ownership to the caller (auto-release on body close).
    // Only a throw before transfer (abort/fetch-error race) lands here held.
    if (!transferred) release?.()
  }
}
