// Regression coverage for the logging work:
//   1. access log emits one line per outcome with the right status
//   2. SsePipeline records enqueue/close/cancel failures instead of swallowing
//   3. recordTimeout / recordTimeoutSuccess log state transitions
//   4. readJsonBody logs every rejection path (body limits, read timeout, bad JSON)
//   5. the log-file writer reports write failures instead of swallowing them
// CFG is snapshotted when shared/config is first evaluated, so the environment
// must be set BEFORE that module loads. Static imports are hoisted above these
// statements, so the src modules are pulled in dynamically instead.
process.env.LOG_FILE = 'D:/Git/cc_p_forked/.hb/_logging-test.log'
// Shrink the cap so the size-limit paths are reachable with a small fixture.
// The default is 100MB, which would need a 100MB body to exercise.
process.env.CC_MAX_BODY_MB = '1'

import { Elysia } from 'elysia'
const { accessLogPlugin } = await import('../src/plugins/access')
const { authPlugin } = await import('../src/plugins/auth')
const { chatController } = await import('../src/modules/chat/index')
const { SsePipeline, startSseHeartbeat } = await import('../src/infra/sse')
const { recordTimeout, recordTimeoutSuccess, consecutiveTimeouts } = await import('../src/shared/runtime')
const { readJsonBody, BodyTooLargeError } = await import('../src/shared/http')
const { log, logFileWriteError } = await import('../src/shared/logger')
const { MAX_BODY_SIZE } = await import('../src/shared/config')

// ── capture log output ───────────────────────────────────────────────
const lines: Array<{ level: string; msg: string; data: any }> = []
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

// The 413 sentinel: a plain Error carrying status=413, thrown from the parse
// phase, which Elysia reports as code 'UNKNOWN' and renders with no Response.
// The onError stash in plugins/access.ts exists solely for this, and e2e only
// asserts the status the CLIENT sees, not that the log agrees.
//
// The throw must come from a hook, not the handler: a handler that returns
// normally never reaches onError, so the stash stays empty.
const sentinel = new Elysia()
  .use(accessLogPlugin)
  .onTransform({ as: 'scoped' }, () => {
    const err: any = new Error('body too large')
    err.status = 413
    throw err
  })
  .post('/sentinel', () => new Response('ok'))
sentinel.listen({ port: 4384, hostname: '127.0.0.1' })
await Bun.sleep(200)

clear()
await fetch('http://127.0.0.1:4384/sentinel', { method: 'POST', body: '{}' }).then((r) => r.text()).catch(() => {})
await settle()
// 413 is a 4xx, so it lands on 'Request rejected' (warn). The assertion is
// about the recovered STATUS, not the level: before the onError stash this
// outcome had no Response and no numeric set.status, so it fell through to the
// 500 default and was logged as a server error for a client-side problem.
check('access log: error-carrying 413 is recovered, not logged as 500',
  find('Request rejected').length === 1
  && find('Request rejected')[0]?.data?.status === 413
  && find('Request failed').length === 0, lines)

// 499 (client gone) is the status both handlers return on cancellation. It
// must be recorded rather than dropped, and must not be mistaken for success.
clear()
const goneApp = new Elysia()
  .use(accessLogPlugin)
  .get('/gone', () => new Response(null, { status: 499 }))
goneApp.listen({ port: 4383, hostname: '127.0.0.1' })
await Bun.sleep(200)
const goneRes = await fetch('http://127.0.0.1:4383/gone')
await settle()
check('access log: 499 is recorded as a rejection', goneRes.status === 499
  && find('Request rejected').length === 1, { status: goneRes.status, lines })
check('access log: 499 is never recorded as success', find('Request completed').length === 0, lines)

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

// terminateWith is only ever called from the client-abort paths, so it must
// not label a disconnect as a normal close. It did before this was fixed:
// close()'s default reason won because the pump's later close('pump-finished')
// returns early once `closed` is set.
const pTerm = new SsePipeline(true)
pTerm.start()
pTerm.terminateWith(['data: [DONE]\n\n'])
check('sse: terminateWith records a client-abort close, not normal',
  pTerm.snapshot().closeReason === 'client-abort', pTerm.snapshot())
const pTerm2 = new SsePipeline(true)
pTerm2.start()
pTerm2.terminateWith(['data: [DONE]\n\n'], 'custom-reason')
check('sse: terminateWith accepts an explicit reason',
  pTerm2.snapshot().closeReason === 'custom-reason', pTerm2.snapshot())
check('sse: a second close() after terminateWith does not overwrite the reason',
  (pTerm2.close('pump-finished'), pTerm2.snapshot().closeReason === 'custom-reason'),
  pTerm2.snapshot())

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

// ── 4. readJsonBody rejection paths ──────────────────────────────────
const jsonReq = (body: string | Uint8Array, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  new Request('http://x/probe', { method: 'POST', headers, body: body as any })

clear()
let threw: unknown = null
try { await readJsonBody(jsonReq('{"a":1}')) } catch (e) { threw = e }
check('readJsonBody: a valid body logs nothing', lines.length === 0, lines)
check('readJsonBody: valid body parses', threw === null)

clear()
threw = null
try { await readJsonBody(jsonReq('not-json')) } catch (e) { threw = e }
check('readJsonBody: invalid JSON is logged', find('Request body is not valid JSON').length === 1, lines)
check('readJsonBody: invalid JSON still throws the same message',
  (threw as Error)?.message === 'Invalid JSON', (threw as Error)?.message)

// Oversized on the DECLARED length: rejected before any body is read.
// The header must be set explicitly — Bun's Request constructor does not
// derive content-length from a string body, so relying on it would silently
// test the streaming path instead of the pre-check.
clear()
threw = null
const bigBody = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) })
const declared = new Request('http://x/probe', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(bigBody)),
  },
  body: bigBody,
})
try { await readJsonBody(declared) } catch (e) { threw = e }
check('readJsonBody: content-length rejection is logged', find('Request body rejected on content-length').length === 1, lines)
check('readJsonBody: content-length rejection flags early exit',
  find('Request body rejected on content-length')[0]?.data?.rejectedEarly === true, lines)
check('readJsonBody: content-length rejection throws BodyTooLargeError',
  threw instanceof BodyTooLargeError, (threw as Error)?.constructor?.name)

// Undeclared length (chunked) that only exceeds the cap while streaming:
// this is the case a content-length pre-check cannot catch.
clear()
threw = null
const stream = new ReadableStream<Uint8Array>({
  start(c) {
    const enc = new TextEncoder()
    // No content-length header; two chunks straddle the limit.
    c.enqueue(enc.encode('{"pad":"' + 'x'.repeat(600 * 1024)))
    c.enqueue(enc.encode('x'.repeat(600 * 1024) + '"}'))
    c.close()
  },
})
try {
  await readJsonBody(new Request('http://x/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as any))
} catch (e) { threw = e }
check('readJsonBody: streaming over-limit is logged', find('Request body exceeded size limit while streaming').length === 1, lines)
check('readJsonBody: streaming over-limit flags late rejection',
  find('Request body exceeded size limit while streaming')[0]?.data?.rejectedEarly === false, lines)
check('readJsonBody: streaming over-limit throws BodyTooLargeError',
  threw instanceof BodyTooLargeError, (threw as Error)?.constructor?.name)

clear()
threw = null
// A POST with no body at all: request.body is null, so there is no reader.
try {
  await readJsonBody(new Request('http://x/probe', { method: 'POST', headers: { 'content-type': 'application/json' } }))
} catch (e) {
  threw = e
}
check('readJsonBody: missing body stream is logged', find('Request body is not a readable stream').length === 1, lines)

// Read timeout: the slow-loris shape. 40ms budget against a stalled body.
clear()
threw = null
const stalling = new ReadableStream<Uint8Array>({
  async start(c) {
    c.enqueue(new TextEncoder().encode('{"pad":"'))
    await Bun.sleep(500)
    c.close()
  },
})
try {
  await readJsonBody(
    new Request('http://x/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stalling, duplex: 'half' } as any),
    40,
  )
} catch (e) { threw = e }
check('readJsonBody: read timeout is logged', find('Request body read timeout').length === 1, lines)
check('readJsonBody: read timeout reports the budget', find('Request body read timeout')[0]?.data?.timeoutMs === 40, lines)
check('readJsonBody: read timeout flags a mid-body stall',
  find('Request body read timeout')[0]?.data?.stalledMidBody === true, lines)
check('readJsonBody: read timeout throws the documented message',
  (threw as Error)?.message === 'Request read timeout', (threw as Error)?.message)

// ── 5. auth pre-check logs the 401 clients actually receive ───────────
// The pre-check short-circuits in onTransform, so the handler's own
// 'Authentication failed' log is unreachable via the routed path. Assert the
// pre-check records a reason, which is the only 401 signal a client ever hits.
const authApp = new Elysia()
  .use(accessLogPlugin)
  .use(authPlugin)
  .use(chatController)
authApp.listen({ port: 4389, hostname: '127.0.0.1' })
await Bun.sleep(200)

clear()
const noKey = await fetch('http://127.0.0.1:4389/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm', messages: [] }),
  signal: AbortSignal.timeout(15_000),
})
await settle()
check('auth: pre-check returns 401', noKey.status === 401, noKey.status)
check('auth: pre-check logs the reason', find('Authentication failed (pre-check)').length === 1, lines)
check('auth: pre-check log names the path and protocol',
  find('Authentication failed (pre-check)')[0]?.data?.path === '/v1/chat/completions'
  && find('Authentication failed (pre-check)')[0]?.data?.protocol === 'openai',
  find('Authentication failed (pre-check)')[0])
check('auth: pre-check log records which credential was presented',
  find('Authentication failed (pre-check)')[0]?.data?.hasAuthorization === false
  && find('Authentication failed (pre-check)')[0]?.data?.hasXApiKey === false,
  find('Authentication failed (pre-check)')[0])
check('auth: access log still records the 401', find('Request rejected')[0]?.data?.status === 401, lines)

// A malformed key must be distinguishable from a missing one.
clear()
const badKey = await fetch('http://127.0.0.1:4389/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'sk-wrong-prefix' },
  body: JSON.stringify({ model: 'm', messages: [] }),
  signal: AbortSignal.timeout(15_000),
})
await settle()
check('auth: malformed key also 401', badKey.status === 401, badKey.status)
check('auth: malformed key logs a distinct reason',
  /Invalid API key/.test(find('Authentication failed (pre-check)')[0]?.data?.reason ?? ''),
  find('Authentication failed (pre-check)')[0]?.data?.reason)
check('auth: malformed key log notes the presented header',
  find('Authentication failed (pre-check)')[0]?.data?.hasXApiKey === true,
  find('Authentication failed (pre-check)')[0])

// ── 6. log file writer ────────────────────────────────────────────────
const logFile = process.env.LOG_FILE!
const written = await Bun.file(logFile).text()
check('logfile: lines are actually written to the configured file',
  written.includes('Request body is not valid JSON'), written.slice(0, 200))
check('logfile: no write failure was recorded for a writable file',
  logFileWriteError().message === null, logFileWriteError())

// A failing write must be reported once and must not recurse through log().
// Exercised in a child process because CFG.logFile is fixed at config load.
const child = Bun.spawnSync({
  cmd: ['bun', 'run', import.meta.dir + '/_logging-writefail-child.ts'],
  stdout: 'pipe',
  stderr: 'pipe',
})
const childErr = child.stderr.toString()
const childOut = child.stdout.toString()
const reports = childErr.split('\n').filter((l) => l.includes('[logger] log file write failed'))
const stateLine = childOut.split('\n').find((l) => l.startsWith('CHILD_STATE '))
const childState = stateLine ? JSON.parse(stateLine.slice('CHILD_STATE '.length)) : null

check('logfile: write failure is reported', reports.length === 1, childErr)
check('logfile: reporter names the offending path', reports[0]?.includes('Z:/no-such-drive') ?? false, reports[0])
check('logfile: reporter does not recurse into log()', !reports.some((l) => l.includes('probe child')), childErr)
// Five failing writes must produce ONE stderr line, not five.
check('logfile: repeat failures are suppressed, not flooded',
  reports.length === 1 && childState?.total === 5 && childState?.suppressed === 4,
  { reports: reports.length, state: childState })
check('logfile: console still received every line while the file sink was broken',
  [0, 1, 2, 3, 4].every((i) => childOut.includes(`probe child line`) && childOut.includes(`"i":${i}`)), childOut.slice(0, 300))
check('logfile: a failing file sink does not crash the process', child.exitCode === 0, child.exitCode)

console.log = realConsoleLog
console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
await Bun.file(logFile).delete()
process.exit(fail > 0 ? 1 : 0)
