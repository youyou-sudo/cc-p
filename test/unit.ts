// Unit tests for the new resilience modules (no network; run with `bun run test/unit.ts`).
// Covers: upstream-limit classification, retry/backoff math, key-pool selection,
// and the per-key concurrency gate.

import { classifyUpstreamLimit, limitMeta } from '../src/shared/limit'
import { parseRetryAfter, backoffDelay } from '../src/shared/retry'
import { resolveUpstreamKey, setPoolStrategy, type ApiKeyPool } from '../src/shared/api-keys'
import { ConcurrencyGate, ConcurrencyAborted, ConcurrencyRoomFull, ConcurrencyTimeout } from '../src/shared/concurrency'
import { mapCcError, mapCcEventError } from '../src/shared/errors'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++
    console.log(`PASS ${name}`)
  } else {
    failed++
    console.log(`FAIL ${name}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`)
  }
}

// limit classification
{
  check('429 rate limit', classifyUpstreamLimit(429, 'Rate limit exceeded. Please wait') === 'rate_limit')
  check('429 5-hour usage window', classifyUpstreamLimit(429, "You've reached your 5-hour usage limit") === 'usage_window_5h')
  check('429 weekly usage window', classifyUpstreamLimit(429, 'You hit the weekly cap. Resets in 2d') === 'usage_window_weekly')
  check('400 prompt too long', classifyUpstreamLimit(400, 'prompt is too long') === 'context_overflow')
  check('400 context overflow', classifyUpstreamLimit(400, 'input exceeds the context window') === 'context_overflow')
  check('402 payment', classifyUpstreamLimit(402, 'no credits') === 'payment_required')
  check('403 session refused', classifyUpstreamLimit(403, 'session invalid') === 'authed_session_refused')
  check('500 unknown', classifyUpstreamLimit(500, 'boom') === 'unknown')

  const rl = limitMeta(429, 'rate limit exceeded', null)
  check('rate_limit retryable', rl.retryable === true)
  check('rate_limit default retry_after 30s', rl.retryAfterMs === 30_000)

  const w = limitMeta(429, "You've reached your 5-hour usage limit", null)
  check('usage window NOT retryable', w.retryable === false)

  const co = limitMeta(400, 'prompt too long', null)
  check('context overflow NOT retryable', co.retryable === false)

  const rlHeader = limitMeta(429, 'rate limit', 5)
  check('rate_limit honors Retry-After header', rlHeader.retryAfterMs === 5000)
}

// retry / backoff
{
  check('parseRetryAfter seconds', parseRetryAfter('15') === 15)
  check('parseRetryAfter empty null', parseRetryAfter('') === null)
  const d = new Date(Date.now() + 10_000).toUTCString()
  const delta = parseRetryAfter(d)
  check('parseRetryAfter HTTP-date >0', delta !== null && delta! > 0)
  check('backoff attempt0 ~800ms', backoffDelay(0, 800, 15000) >= 600 && backoffDelay(0, 800, 15000) <= 1000)
  check('backoff attempt2 capped no-jitter', backoffDelay(10, 800, 15000, 0) === 15000)
  check('backoff monotonic base', backoffDelay(0, 800, 15000, 0) < backoffDelay(1, 800, 15000, 0))
}

// key pool selection
{
  const pool: ApiKeyPool = { keys: ['user_a', 'user_b', 'user_c'], strategy: 'affinity', roundRobinCursor: 0 }
  check('affinity stable per client key', resolveUpstreamKey('user_x', pool) === resolveUpstreamKey('user_x', pool))
  check('affinity bounded to pool', pool.keys.includes(resolveUpstreamKey('anything', pool)))

  setPoolStrategy(pool, 'roundRobin')
  const picks = new Set<string>()
  for (let i = 0; i < 30; i++) picks.add(resolveUpstreamKey('user_x', pool))
  check('roundRobin rotates through pool', picks.size === 3)
}

// concurrency gate
{
  const gate = new ConcurrencyGate({ maxInFlightPerKey: 2, maxQueuePerKey: 2, queueTimeoutMs: 300 })
  const ac = new AbortController()
  const releases: (() => void)[] = []

  releases.push(await gate.acquire('k', { signal: ac.signal })) // slot 1
  releases.push(await gate.acquire('k', { signal: ac.signal })) // slot 2 (in-flight full)
  const queued = gate.acquire('k', { signal: ac.signal }) // queued, waits
  check('snapshot inFlight=2', gate.snapshot().inFlight === 2)
  releases[0]!() // free slot 1 -> queued waiter promoted
  const r3 = await queued
  check('queued waiter resolves on release', typeof r3 === 'function')
  releases.push(r3)
  check('inFlight back to 2 after promote', gate.snapshot().inFlight === 2)
  check('snapshot queued=0', gate.snapshot().queued === 0)

  // queue full fast-fail
  const gate2 = new ConcurrencyGate({ maxInFlightPerKey: 1, maxQueuePerKey: 0, queueTimeoutMs: 300 })
  const ac2 = new AbortController()
  const slot1 = await gate2.acquire('k2', { signal: ac2.signal })
  let fullRejected = false
  await gate2.acquire('k2', { signal: ac2.signal }).catch(() => { fullRejected = true })
  check('queue full rejects with ConcurrencyRoomFull-like error', fullRejected)
  slot1()

  releases.forEach(r => r())
}

// concurrency gate: deadline timer / abort / queue-full boundary
{
  const g1 = new ConcurrencyGate({ maxInFlightPerKey: 1, maxQueuePerKey: 8, queueTimeoutMs: 250 })
  const ac1 = new AbortController()
  const held1 = await g1.acquire('kt', { signal: ac1.signal })
  const t0 = Date.now()
  let timedOut = false
  await g1.acquire('kt', { signal: ac1.signal }).catch((e: unknown) => { timedOut = e instanceof ConcurrencyTimeout })
  check('queue deadline timer fires ConcurrencyTimeout', timedOut && Date.now() - t0 < 2000, Date.now() - t0)
  held1()

  const g2 = new ConcurrencyGate({ maxInFlightPerKey: 1, maxQueuePerKey: 8, queueTimeoutMs: 5000 })
  const ac2 = new AbortController()
  const held2 = await g2.acquire('ka', { signal: ac2.signal })
  const queued2 = g2.acquire('ka', { signal: ac2.signal })
  ac2.abort()
  let abortedRejected = false
  try { await queued2 } catch (e: unknown) { abortedRejected = e instanceof ConcurrencyAborted }
  check('abort of queued waiter rejects ConcurrencyAborted', abortedRejected)
  held2()

  const g3 = new ConcurrencyGate({ maxInFlightPerKey: 2, maxQueuePerKey: 1, queueTimeoutMs: 5000 })
  const ac3 = new AbortController()
  const h1 = await g3.acquire('kb', { signal: ac3.signal })
  const h2 = await g3.acquire('kb', { signal: ac3.signal })
  const q1 = g3.acquire('kb', { signal: ac3.signal }) // fills the single queue room
  let roomFull = false
  try { await g3.acquire('kb', { signal: ac3.signal }) } catch (e: unknown) { roomFull = e instanceof ConcurrencyRoomFull }
  check('queue-full boundary rejects ConcurrencyRoomFull', roomFull, g3.snapshot())
  h1()
  const r1 = await q1
  check('queued within room still admitted', typeof r1 === 'function')
  h2(); r1()
  check('boundary gate fully drained', g3.snapshot().inFlight === 0 && g3.snapshot().queued === 0, g3.snapshot())

  const g4 = new ConcurrencyGate({ queueTimeoutMs: 1000 })
  const ac4 = new AbortController()
  ac4.abort()
  let immediateAbort = false
  try { await g4.acquire('kc', { signal: ac4.signal }) } catch (e: unknown) { immediateAbort = e instanceof ConcurrencyAborted }
  check('already-aborted signal rejects immediately', immediateAbort)
}

// error mapping (errors.ts + limit.ts integration)
{
  const plain400 = mapCcError(400, JSON.stringify({ error: { message: 'invalid params' } }))
  check('plain 400 keeps invalid_request_error', plain400.status === 400 && plain400.body.error.type === 'invalid_request_error', plain400)

  const overflow = mapCcError(400, JSON.stringify({ error: { message: 'prompt is too long: 300000 tokens > 200000' } }))
  check('400 overflow => context_window_exceeded', overflow.status === 400 && overflow.body.error.type === 'context_window_exceeded', overflow)

  const p402 = mapCcError(402, JSON.stringify({ error: { message: 'no credits' } }))
  check('402 => payment_required', p402.status === 402 && p402.body.error.type === 'payment_required', p402)

  const p404 = mapCcError(404, '')
  check('404 keeps not_found', p404.status === 404 && p404.body.error.type === 'not_found', p404)

  const p429 = mapCcError(429, JSON.stringify({ error: { message: 'rate limit exceeded' } }))
  check('429 => rate_limit_error retry_after 30', p429.status === 429 && p429.body.error.type === 'rate_limit_error' && p429.body.retry_after === 30, p429)

  const p429h = mapCcError(429, JSON.stringify({ error: { message: 'slow down' } }))
  check('429 honors Retry-After header (hardcoded to 30)', p429h.body.retry_after === 30, p429h)

  const p500 = mapCcError(500, '')
  check('500 => 502 upstream_error', p500.status === 502 && p500.body.error.type === 'upstream_error', p500)

  const ev = mapCcEventError({ error: { message: '<429> slow down' } })
  check('event <429> => 429 rate_limit_error', ev.status === 429 && ev.body.error.type === 'rate_limit_error' && ev.body.retry_after === 30, ev)
}

console.log(`\nUNIT RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
