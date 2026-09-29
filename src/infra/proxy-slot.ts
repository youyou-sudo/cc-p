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

      log('error', label, {
        status: ccResponse.status,
        category,
        keyPrefix: apiKey.slice(0, 8),
        attempt,
        retryable: meta.retryable,
      })

      if (!meta.retryable || attempt >= CFG.retryMax || signal.aborted) {
        return { ok: false, value: onCcError(mapped) }
      }

      const fromHeader = parseRetryAfter(retryAfterHeader ?? undefined)
      const waitMs = Math.max(
        backoffDelay(attempt, CFG.retryBaseMs, CFG.retryCapMs),
        fromHeader != null ? fromHeader * 1000 : 0,
      )
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
