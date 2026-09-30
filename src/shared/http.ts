// Layer: kernel（底层，可被所有人依赖，自己只依赖 kernel）
import { CFG, MAX_BODY_SIZE } from './config'
import { log } from './logger'

// Default CORS policy. `*` (any web page may call the proxy) is fine when no
// `CC_API_KEY` fallback is set — every request must still present its own key.
// Once a fallback key is configured, keyless browser calls must NOT be
// readable cross-origin: unless the operator opts in via `CORS_ALLOW_ORIGIN`,
// we omit `Access-Control-Allow-Origin` entirely (browsers then block the read
// by default). Never emit `Allow-Origin: null` — that would wrongly allow
// opaque origins such as `file://` pages to drain the fallback key's quota.
// (curl / SDKs are unaffected — they do not send an Origin header).
function corsAllowOrigin(): string {
  if (CFG.corsAllowOrigin) return CFG.corsAllowOrigin
  return CFG.apiKey ? '' : '*'
}

function buildCorsHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Vary': 'Origin',
  }
  const origin = corsAllowOrigin()
  if (origin) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

export const CORS_HEADERS: Record<string, string> = buildCorsHeaders()

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
}

export function sendJSON(status: number, data: unknown): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // Only 429 carries a legitimate Retry-After. Never emit it for 5xx (502/500):
  // SDKs must not backoff-retry a proxy/upstream failure as if it were rate limiting.
  if (status === 429 && (data as any)?.retry_after !== undefined) {
    headers['Retry-After'] = String((data as any).retry_after)
  }
  return new Response(JSON.stringify(data), { status, headers })
}

export function sendAnthropicError(
  status: number,
  type: string,
  message: string,
  opts?: { retryAfter?: number; headerOnly?: boolean },
): Response {
  const body: any = { type: 'error', error: { type, message } }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts?.retryAfter !== undefined && !opts.headerOnly) {
    body.retry_after = opts.retryAfter
    headers['Retry-After'] = String(opts.retryAfter)
  } else if (opts?.retryAfter !== undefined && opts.headerOnly) {
    headers['Retry-After'] = String(opts.retryAfter)
  }
  return new Response(JSON.stringify(body), { status, headers })
}

export class BodyTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds ${Math.round(MAX_BODY_SIZE / 1024 / 1024)}MB limit`)
  }
}

// Drain cap for over-limit bodies: proportional to MAX_BODY_SIZE so a small
// CC_MAX_BODY_MB still discards quickly, capped at 32MB for huge limits.
const DRAIN_LIMIT = Math.min(32 * 1024 * 1024, Math.max(1024 * 1024, Math.floor(MAX_BODY_SIZE / 4)))
// Per-read stall timeout. Total budget is enforced separately via start+totalTimeoutMs.

/**
 * Read + parse a JSON request body with a single-pass size cap.
 *
 * Every rejection path here is logged. That is deliberate: this function is
 * the choke point for body reads on BOTH entry paths (plugins/body.ts onParse
 * and proxy-handler readRequestJson), and each of these outcomes is a
 * candidate slow-loris / oversized-payload / malformed-client signal that was
 * previously only inferable from the status code the client received. The
 * access log records the 400/413 but not WHY, so a client stuck in a 413 loop
 * (or a slow-upload attack) had no signature to grep for.
 *
 * `timeoutMs` is the per-read stall budget; `totalTimeoutMs` is the whole-body
 * budget, so a slow drip (each read under the stall limit) still fails.
 */
export async function readJsonBody(
  request: Request,
  timeoutMs: number = 30000,
  totalTimeoutMs: number = 300000,
): Promise<any> {
  const readStartedAt = Date.now()
  const ctx = (extra: Record<string, unknown>) => ({
    method: request.method,
    contentLength: request.headers.get('content-length') ?? '(none)',
    elapsedMs: Date.now() - readStartedAt,
    ...extra,
  })

  const contentLength = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
    // Rejected on the declared length alone: the body is never read, so this
    // is cheap and cannot be used to make the proxy buffer anything.
    log('warn', 'Request body rejected on content-length', ctx({
      declaredBytes: contentLength,
      limitBytes: MAX_BODY_SIZE,
      rejectedEarly: true,
    }))
    throw new BodyTooLargeError()
  }

  const reader = request.body?.getReader()
  if (!reader) {
    log('warn', 'Request body is not a readable stream', ctx({}))
    throw new Error('Invalid JSON')
  }

  const startedAt = Date.now()
  const chunks: Uint8Array[] = []
  let totalSize = 0
  let tooLarge = false
  let drained = 0

  while (true) {
    // Total budget: orthogonal to the per-read stall timeout below. A slow
    // drip (each read < timeoutMs) must still fail after totalTimeoutMs.
    const elapsed = Date.now() - startedAt
    if (elapsed >= totalTimeoutMs) {
      try { reader.cancel() } catch {}
      throw new Error('Request read timeout')
    }
    const remaining = Math.min(timeoutMs, totalTimeoutMs - elapsed)
    let result: { done: boolean; value?: Uint8Array }
    try {
      result = await readWithTimeout(reader.read(), remaining, 'READ_BODY_TIMEOUT')
    } catch (e: any) {
      if (e.message === 'READ_BODY_TIMEOUT') {
        try { reader.cancel() } catch {}
        log('warn', 'Request body read timeout', ctx({
          timeoutMs,
          bytesSoFar: totalSize,
          // A single read() exceeding the budget is the slow-loris shape:
          // the client opened the body then trickled or stalled.
          stalledMidBody: totalSize > 0,
        }))
        throw new Error('Request read timeout')
      }
      throw e
    }
    if (result.done) break
    const value = result.value!
    if (tooLarge) {
      drained += value.byteLength
      if (drained > DRAIN_LIMIT) {
        try { reader.cancel() } catch {}
        // We already know the body is oversized; we drain a bounded amount so
        // the client sees a clean 413 instead of a reset connection, then
        // stop reading. Stopping early here is what keeps an oversized upload
        // from pinning memory/CPU, so it is worth recording.
        log('warn', 'Oversized body drain aborted', ctx({
          bytesAtAbort: totalSize,
          drainedBytes: drained,
          drainLimitBytes: DRAIN_LIMIT,
        }))
        break
      }
      continue
    }
    totalSize += value.byteLength
    if (totalSize > MAX_BODY_SIZE) {
      tooLarge = true
      chunks.length = 0
      continue
    }
    chunks.push(value)
  }
  if (tooLarge) {
    // Undeclared length (chunked transfer-encoding) that exceeded the cap
    // only became visible while streaming, so this is the case a
    // content-length pre-check cannot catch.
    log('warn', 'Request body exceeded size limit while streaming', ctx({
      bytesAtAbort: totalSize,
      limitBytes: MAX_BODY_SIZE,
      rejectedEarly: false,
    }))
    throw new BodyTooLargeError()
  }

  const decoder = new TextDecoder()
  const text = chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode()
  try {
    return JSON.parse(text)
  } catch {
    log('warn', 'Request body is not valid JSON', ctx({ bytes: totalSize }))
    throw new Error('Invalid JSON')
  }
}

export async function readWithTimeout<T>(promise: Promise<T>, timeoutMs: number, tag: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(tag)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
