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

/** ensureInitialized → POST /alpha/generate → map non-2xx (protocol-specific). */
export async function callUpstream<T>(
  args: UpstreamCallArgs<T>,
): Promise<{ ok: true; response: Response } | { ok: false; value: T }> {
  const { apiKey, headers, ccBody, signal, promptCacheKey, label, onCcError } = args
  await ensureInitialized(apiKey, signal)
  const ccResponse = await forwardToCC(ccBody, apiKey, headers, signal, promptCacheKey)
  if (!ccResponse.ok) {
    const errorText = await ccResponse.text().catch(() => '')
    const bodySnippet = errorText.slice(0, 200)
    let model: unknown = undefined
    try {
      model = (ccBody as any)?.params?.model ?? (ccBody as any)?.model
    } catch { model = undefined }
    const apiKeySuffix = typeof apiKey === 'string' && apiKey.length > 4 ? apiKey.slice(-4) : '****'
    log('error', label, { status: ccResponse.status, bodySnippet, model, apiKeySuffix })
    return { ok: false, value: onCcError(mapCcError(ccResponse.status, errorText)) }
  }
  return { ok: true, response: ccResponse }
}
