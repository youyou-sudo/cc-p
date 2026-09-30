// proxy-slot.ts — shared concurrency + retry for upstream /alpha/generate.
// Kept OUT of proxy-handler.ts to avoid CRLF-mangling that file again.

import { CFG } from '../shared/config'
import { ConcurrencyGate, ConcurrencyRoomFull, ConcurrencyTimeout } from '../shared/concurrency'
import { parseApiKeyEnv, resolveUpstreamKey, setPoolStrategy, type ApiKeyPool } from '../shared/api-keys'
import { limitMeta } from '../shared/limit'
import { parseRetryAfter, backoffDelay, sleep } from '../shared/retry'
import { forwardToCC } from './cc'
import { mapCcError } from '../shared/errors'
import type { MappedError } from '../shared/errors'
import { ensureInitialized } from './fingerprint'
import { log } from '../shared/logger'
import type { UpstreamCallArgs } from './proxy-handler'

const gate = new ConcurrencyGate({
  maxInFlightPerKey: CFG.maxConcurrencyPerKey,
  maxQueuePerKey: CFG.maxQueuePerKey,
  queueTimeoutMs: CFG.queueTimeoutMs,
})

const keyPool: ApiKeyPool = {
  keys: parseApiKeyEnv(),
  strategy: CFG.keySelectionStrategy,
  roundRobinCursor: 0,
}
setPoolStrategy(keyPool, CFG.keySelectionStrategy)

export function upstreamKeyFor(clientKey: string): string {
  const resolved = resolveUpstreamKey(clientKey, keyPool)
  return resolved || clientKey
}

/** Pool shape for startup logging (counts only — never the keys). */
export function upstreamPoolInfo(): { keys: number; strategy: ApiKeyPool['strategy'] } {
  return { keys: keyPool.keys.length, strategy: keyPool.strategy }
}

function concurrencyErrorToMapped(concurrency: { kind: string }): MappedError {
  if (concurrency.kind === 'queue_full') {
    return {
      status: 429,
      body: {
        error: {
          message: 'Too many concurrent requests, reduce parallel subagents',
          type: 'rate_limit_error',
          category: 'concurrency_queue_full',
        },
        retry_after: Math.max(1, Math.ceil(CFG.queueTimeoutMs / 1000 / 3)),
      },
    }
  }
  if (concurrency.kind === 'queue_timeout') {
    return {
      status: 429,
      body: {
        error: {
          message: 'Timed out waiting for an upstream slot, reduce parallel subagents',
          type: 'rate_limit_error',
          category: 'concurrency_queue_timeout',
        },
        retry_after: 5,
      },
    }
  }
  return {
    status: 499,
    body: {
      error: {
        message: 'Upstream request aborted while queued',
        type: 'client_closed_request',
        category: 'concurrency_aborted',
      },
    },
  }
}

/**
 * Is it safe to re-POST the whole request after this failure?
 *
 * `/alpha/generate` is NOT idempotent. A retry re-sends the entire conversation
 * (`ccBody` is built from the full message history by `buildCcRequest`), so
 * retrying an error that the upstream may have already accepted and billed
 * costs the user twice and can produce duplicate generations.
 *
 * `limitMeta` classifies a status/message as `retryable`, but that answers "is
 * the failure transient", NOT "did the work happen". A 429 returned *before*
 * the request was accepted is safe to repeat; a 5xx or a dropped connection may
 * well be a response lost after the generation completed.
 *
 * The conservative rule below retries only failures that are provably
 * pre-acceptance:
 *   - 429 rate limiting: rejected at admission, nothing was generated
 *   - 402 payment required / 401: rejected before generation
 *   - 5xx: NOT retried. The upstream may have started and billed before
 *     failing to respond, so repeating risks double-charging. The client can
 *     retry under its own control, which also keeps the decision visible.
 *
 * This narrows `meta.retryable`; it does not replace it. A future upstream that
 * documents idempotency for a given status can relax the rule here.
 */
function isSafeToRetry(status: number, metaRetryable: boolean): boolean {
  if (!metaRetryable) return false
  if (status === 429) return true
  if (status === 402 || status === 401) return true
  return false
}

/** Test-only re-export of the retry guard; keeps the decision table assertable
 *  without standing up the whole upstream path. */
export const isSafeToRetryForTest = isSafeToRetry

export async function callUpstreamWithSlots<T>(
  args: UpstreamCallArgs<T>,
): Promise<{ ok: true; response: Response } | { ok: false; value: T }> {
  const { apiKey, headers, ccBody, signal, promptCacheKey, label, onCcError } = args
  const upstreamKey = upstreamKeyFor(apiKey)

  let release: (() => void) | undefined
  let hasSlot = false
  try {
    release = await gate.acquire(upstreamKey, { signal, timeoutMs: CFG.queueTimeoutMs })
    hasSlot = true
  } catch (e: any) {
    const category = e instanceof ConcurrencyRoomFull ? 'queue_full'
      : e instanceof ConcurrencyTimeout ? 'queue_timeout'
      : 'aborted'
    const mapped = concurrencyErrorToMapped({ kind: category })
    log('warn', `${label} concurrency rejected`, {
      category: (mapped.body.error as any)?.category,
      keyPrefix: apiKey.slice(0, 8),
      ...gate.snapshot(),
    })
    return { ok: false, value: onCcError(mapped) }
  }

  try {
    gate.pruneIfNecessary()
    await ensureInitialized(upstreamKey, signal)

    let attempt = 0
    for (;;) {
      const ccResponse = await forwardToCC(ccBody, upstreamKey, headers, signal, promptCacheKey)
      if (ccResponse.ok) {
        return { ok: true, response: ccResponse }
      }

      const errorText = await ccResponse.text().catch(() => '')
      const retryAfterHeader = ccResponse.headers.get('retry-after') ?? ccResponse.headers.get('Retry-After') ?? undefined
      const mapped = mapCcError(
        ccResponse.status,
        errorText,
      )
      const category = (mapped.body?.error as any)?.category ?? 'unknown'
      const meta = limitMeta(
        ccResponse.status,
        (mapped.body?.error as any)?.message ?? errorText,
        parseRetryAfter(retryAfterHeader ?? undefined),
      )

      // Guard against re-sending a request the upstream may already have
      // accepted and billed; see isSafeToRetry for why 5xx is excluded.
      const retryable = isSafeToRetry(ccResponse.status, meta.retryable)
      log('error', label, {
        status: ccResponse.status,
        category,
        keyPrefix: apiKey.slice(0, 8),
        attempt,
        retryable: meta.retryable,
        // Distinguishes "transient" from "safe to repeat", which is what the
        // decision below actually uses.
        safeToRetry: retryable,
      })

      if (!retryable || attempt >= CFG.retryMax || signal.aborted) {
        return { ok: false, value: onCcError(mapped) }
      }

      const fromHeader = parseRetryAfter(retryAfterHeader ?? undefined)
      let waitMs = Math.max(
        backoffDelay(attempt, CFG.retryBaseMs, CFG.retryCapMs),
        fromHeader != null ? fromHeader * 1000 : 0,
      )
      // The client's own read timeout is the ceiling we must respect: a longer
      // sleep than the caller is willing to wait produces a pointless retry
      // (and, for a non-idempotent endpoint, a pointless second generation).
      const deadline = args.clientDeadlineAt
      if (deadline !== undefined) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          log('warn', `${label} retry skipped (no time left before client deadline)`, {
            category, attempt, keyPrefix: apiKey.slice(0, 8),
          })
          return { ok: false, value: onCcError(mapped) }
        }
        waitMs = Math.min(waitMs, remaining)
      }
      log('warn', `${label} retrying upstream`, {
        category,
        attempt: attempt + 1,
        waitMs: Math.round(waitMs),
        keyPrefix: apiKey.slice(0, 8),
      })
      try {
        await sleep(waitMs, signal)
      } catch {
        return { ok: false, value: onCcError(mapped) }
      }
      attempt++
    }
  } finally {
    // The slot covers init + the upstream call (+ retries) and is released as
    // soon as the response is handed off: long-running streams don't pin a
    // slot while no longer contending for upstream admission.
    if (hasSlot) {
      try { gate.release(upstreamKey) } catch {}
    }
  }
}
