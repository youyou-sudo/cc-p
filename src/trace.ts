// Request-scoped trace context.
//
// A trace id is minted at the entry layer (index.ts route handlers) and stored
// in an AsyncLocalStorage, so every log() call made anywhere inside the
// request's async continuations (pump loops, upstream hooks, translators)
// automatically carries the same traceId - no plumbing through every function
// signature. Outside a request scope (startup logs, background refreshes)
// currentTraceId() returns null and log output stays unchanged.

import { AsyncLocalStorage } from 'node:async_hooks'
import { uuid } from './util'

const requestTrace = new AsyncLocalStorage<string>()

/** Run `fn` with `traceId` bound for the whole async continuation. */
export function runWithTrace<T>(traceId: string, fn: () => T): T {
  return requestTrace.run(traceId, fn)
}

/** Current trace id, or null outside a request scope. */
export function currentTraceId(): string | null {
  return requestTrace.getStore() ?? null
}

/** Mint a new request trace id. */
export function newTraceId(): string {
  return `req_${uuid().slice(0, 12)}`
}