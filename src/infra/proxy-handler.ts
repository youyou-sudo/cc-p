// Shared plumbing for the two protocol handlers (/v1/chat/completions and
// /v1/messages). Each handler still owns its wire format and its stream /
// non-stream state machine, but the request preamble and the upstream
// forwarding are identical, so they live here once.

import { forwardToCC } from './cc'
import { mapCcError } from '../shared/errors'
import type { MappedError } from '../shared/errors'
import { ensureInitialized } from './fingerprint'
import { BodyTooLargeError, readJsonBody } from '../shared/http'
import { log } from '../shared/logger'
import { CFG } from '../shared/config'
import { ConcurrencyGate, ConcurrencyRoomFull, ConcurrencyTimeout } from '../shared/concurrency'
import { limitMeta } from '../shared/limit'
import { backoffDelay, parseRetryAfter } from '../shared/retry'

export type JsonParseErrorKind = 'too-large' | 'invalid'

/** Parse the request JSON body; the protocol file supplies its own error
 *  marshalling (OpenAI vs Anthropic error shapes differ). */
export async function readRequestJson<T = any>(
  request: Request,
  buildError: (kind: JsonParseErrorKind, message: string) => Response,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: (await readJsonBody(request)) as T }
  } catch (e: any) {
    if (e instanceof BodyTooLargeError) {
      return { ok: false, response: buildError('too-large', e.message) }
    }
    return { ok: false, response: buildError('invalid', 'Invalid JSON body') }
  }
}

/**
 * Unified client-disconnect handling.
 *
 * A single 'abort' listener is registered first, so it always runs before any
 * later phase hooks. The stream phase may attach a graceful close
 * (e.g. terminateWith) via `setGracefulClose`; aborting the controller still
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
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Upstream aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** ensureInitialized → gate → POST /alpha/generate (retry rate_limit) → map non-2xx. */
export async function callUpstream<T>(
  args: UpstreamCallArgs<T>,
): Promise<{ ok: true; response: Response } | { ok: false; value: T }> {
  const { apiKey, headers, ccBody, signal, promptCacheKey, label, onCcError } = args
  let model: unknown = undefined
  try {
    model = (ccBody as any)?.params?.model ?? (ccBody as any)?.model
  } catch { model = undefined }
  const apiKeySuffix = typeof apiKey === 'string' && apiKey.length > 4 ? apiKey.slice(-4) : '****'

  await ensureInitialized(apiKey, signal)

  let release: (() => void) | null = null
  try {
    try {
      release = await gate.acquire(apiKey, { signal })
    } catch (e: any) {
      const retryAfter = e instanceof ConcurrencyTimeout ? 2 : 1
      log('warn', 'Concurrency gate rejected', {
        label, model, apiKeySuffix,
        reason: e instanceof ConcurrencyTimeout ? 'queue_timeout' : 'queue_full',
      })
      return { ok: false, value: onCcError({ status: 429, body: { error: { message: e?.message ?? 'Concurrency limit exceeded', type: 'rate_limit_error' }, retry_after: retryAfter } }) }
    }

    const retryMax = Math.max(0, Math.floor(CFG.retryMax))
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new Error('Upstream aborted')
      let ccResponse: Response
      try {
        ccResponse = await forwardToCC(ccBody, apiKey, headers, signal, promptCacheKey)
      } catch (e: any) {
        // Client disconnect / handler abort: propagate so the handler returns
        // 499 / stops the pump; must NOT become a 502 JSON (see timeouts.ts).
        if (e?.name === 'AbortError' || signal.aborted) throw e
        log('error', label, { status: 'fetch_error', bodySnippet: e?.message ?? String(e), model, apiKeySuffix, attempt })
        return { ok: false, value: onCcError(mapCcError(502, e?.message ?? 'Upstream fetch failed')) }
      }
      if (ccResponse.ok) return { ok: true, response: ccResponse }

      const errorText = await ccResponse.text().catch(() => '')
      const headerValue = ccResponse.headers.get('retry-after')
      const headerSecs = parseRetryAfter(headerValue)
      const meta = limitMeta(ccResponse.status, errorText, headerSecs)
      const retryAfterMs = meta.retryAfterMs
      log('error', label, { status: ccResponse.status, bodySnippet: errorText.slice(0, 200), model, apiKeySuffix, attempt, kind: meta.kind, retryable: meta.retryable })
      if (!meta.retryable || attempt >= retryMax || signal.aborted) {
        // Never lie to the client: pass the upstream Retry-After through even
        // when the local retry loop gives up (e.g. retryAfter > retryCapMs).
        return { ok: false, value: onCcError(mapCcError(ccResponse.status, errorText, retryAfterMs)) }
      }
      // Upstream Retry-After wins; otherwise 1s-start exponential backoff + jitter.
      const waitMs = retryAfterMs ?? backoffDelay(attempt, Math.max(1, CFG.retryBaseMs), Math.max(1, CFG.retryCapMs))
      await sleepCancellable(waitMs, signal)
    }
  } finally {
    release?.()
  }
}
