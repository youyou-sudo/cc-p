// Regression coverage for the P0/P1/P2 logging work:
//   1. access log emits one line per outcome with the right status
//   2. SsePipeline records enqueue/close/cancel failures instead of swallowing
//   3. recordTimeout / recordTimeoutSuccess log state transitions
import { Elysia } from 'elysia'
import { accessLogPlugin } from '../src/plugins/access'
import { SsePipeline, startSseHeartbeat } from '../src/infra/sse'
import { recordTimeout, recordTimeoutSuccess, consecutiveTimeouts } from '../src/shared/runtime'
import { log } from '../src/shared/logger'

// ── capture log output ───────────────────────────────────────────────
const lines: Array<{ level: string; msg: string; data: any }> = []
const realLog = log
// logger.ts writes via console.log + optional file; intercept console instead
// so we exercise the real log() path including level filtering.
const realConsoleLog = console.log
console.log = (line: string) => {
  const m = line.match(/^\[[^\]]+\] \[(\w+)\] (.*?)(?: (\{.*\}))?$/)
  if (m) lines.push({ level: m[1], msg: m[2], data: m[3] ? JSON.parse(m[3]) : undefined })
  realConsoleLog(line)
}

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; realConsoleLog('PASS', name) }
  else { fail++; realConsoleLog('FAIL', name, extra !== undefined ? JSON.stringify(extra) : '') }
}
const find = (msg: string) => lines.filter((l) => l.msg === msg)
const clear = () => { lines.length = 0 }

// ── 1. access log ────────────────────────────────────────────────────
const app = new Elysia()
  .use(accessLogPlugin)
  .get('/ok', () => new Response('ok'))
  .post('/json', () => new Response('{}', { status: 201 }))
  .get('/boom', () => { throw new Error('kaboom') })
  .get('/teapot', () => new Response('x', { status: 418 }))
app.listen({ port: 4390, hostname: '127.0.0.1' })
await Bun.sleep(200)

const B = 'http://127.0.0.1:4390'
const get = (p: string) => fetch(B + p, { signal: AbortSignal.timeout(20_000) })
// onAfterResponse runs as the response is flushed, so assertions must let the
// event loop turn before reading the captured lines.
const settle = () => Bun.sleep(50)

clear(); await (await get('/ok')).text(); await settle()
check('access log: 200 -> info', find('Request completed').length === 1, lines)
check('access log: 200 has path+method+status+elapsed',
  find('Request completed')[0]?.data?.path === '/ok'
  && find('Request completed')[0]?.data?.method === 'GET'
  && find('Request completed')[0]?.data?.status === 200
  && typeof find('Request completed')[0]?.data?.elapsedMs === 'number', lines)

clear(); await (await fetch(B + '/json', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).text(); await settle()
check('access log: 201 recorded verbatim', find('Request completed')[0]?.data?.status === 201, lines)

clear(); await get('/nope').then((r) => r.text()).catch(() => {}); await settle()
check('access log: unrouted 404 is warn not info', find('Request rejected').length === 1, lines)
check('access log: unrouted 404 status correct', find('Request rejected')[0]?.data?.status === 404, lines)

clear(); await get('/boom').then((r) => r.text()).catch(() => {}); await settle()
check('access log: thrown error -> 500 (never a false 200)', find('Request failed').length === 1
  && find('Request failed')[0]?.data?.status === 500, lines)

clear(); await (await get('/teapot')).text(); await settle()
check('access log: 4xx -> warn', find('Request rejected').length === 1
  && find('Request rejected')[0]?.data?.status === 418, lines)

clear()
await Promise.all([get('/ok').then((r) => r.text()), get('/ok').then((r) => r.text()), get('/ok').then((r) => r.text())])
await settle()
check('access log: concurrent requests each get a line', find('Request completed').length === 3, lines)

// ── 2. SsePipeline failure accounting ────────────────────────────────
const p = new SsePipeline(true)
p.start()
p.writeNow('data: {"a":1}\n\n')
check('sse: emittedCount tracks successful writes', p.snapshot().emitted === 1, p.snapshot())
check('sse: no enqueue errors on a healthy pipeline', p.snapshot().enqueueErrorCount === 0, p.snapshot())

// Simulate the downstream controller being gone: enqueue must throw.
;(p as any).controller = {
  enqueue() { throw new Error('stream cancelled') },
  close() { throw new Error('stream already closed') },
}
p.writeNow('data: {"b":2}\n\n')
p.emitKeepalive()
p.sendPing()
check('sse: enqueue failure is counted, not swallowed', p.snapshot().enqueueErrorCount === 3, p.snapshot())
check('sse: failed writes do not inflate emitted', p.snapshot().emitted === 1, p.snapshot())
check('sse: keepalive/ping still counted (proves we were writing to a dead socket)',
  p.snapshot().keepaliveCount === 1 && p.snapshot().pingCount === 1, p.snapshot())

p.close('test-close')
check('sse: close failure is counted', p.snapshot().closeErrorCount === 1, p.snapshot())
check('sse: closeReason recorded', p.snapshot().closeReason === 'test-close', p.snapshot())

// heartbeat must not throw out of setInterval
const p2 = new SsePipeline(true)
p2.start()
;(p2 as any).controller = { enqueue() { throw new Error('gone') }, close() {} }
const timer = startSseHeartbeat(p2, { intervalMs: 5, idleMs: 0 })
await Bun.sleep(40)
clearInterval(timer)
check('sse: heartbeat error counted instead of swallowed', p2.snapshot().heartbeatErrorCount > 0
  || p2.snapshot().enqueueErrorCount > 0, p2.snapshot())

// terminal promise must still resolve even when close() throws
const p3 = new SsePipeline(true)
p3.start()
;(p3 as any).controller = { enqueue() {}, close() { throw new Error('gone') } }
p3.close('x')
let resolved = false
await p3.terminal.then(() => { resolved = true })
check('sse: terminal resolves despite close() throwing', resolved)

// ── 3. runtime counter transitions ───────────────────────────────────
const K = 'user_logging_test'
clear()
recordTimeout(K, 'sess-a')
recordTimeout(K, 'sess-a')
recordTimeout(K, 'sess-b')
check('runtime: recordTimeout logs each bump', find('Timeout recorded').length === 3, lines)
check('runtime: log shows the scoped session bucket',
  find('Timeout recorded')[0]?.data?.session === 'sess-a', find('Timeout recorded')[0])
check('runtime: log shows running count + threshold',
  find('Timeout recorded')[1]?.data?.consecutiveTimeouts === 2
  && find('Timeout recorded')[1]?.data?.threshold === 3, find('Timeout recorded')[1])
check('runtime: buckets are isolated per session', consecutiveTimeouts(K, 'sess-a') === 2
  && consecutiveTimeouts(K, 'sess-b') === 1)

clear()
recordTimeoutSuccess(K, 'sess-a')
check('runtime: clearing a populated bucket logs', find('Timeout counter cleared').length === 1, lines)
check('runtime: cleared counter is gone', consecutiveTimeouts(K, 'sess-a') === 0)
check('runtime: sibling bucket untouched', consecutiveTimeouts(K, 'sess-b') === 1)

clear()
recordTimeoutSuccess(K, 'sess-never-timed-out')
check('runtime: no log when there was nothing to clear (quiet success path)',
  find('Timeout counter cleared').length === 0, lines)

recordTimeoutSuccess(K, 'sess-b')

console.log = realConsoleLog
console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
void realLog
process.exit(fail > 0 ? 1 : 0)
