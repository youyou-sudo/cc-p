process.env.PORT = '4210'
process.env.HOST = '127.0.0.1'
process.env.CC_API_BASE = 'http://127.0.0.1:4110'
process.env.CC_API_KEY = ''

const enc = new TextEncoder()
let generateCancelled = false

Bun.serve({
  port: 4110,
  idleTimeout: 120,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/alpha/fingerprint/record') return Response.json({})
    if (url.pathname === '/alpha/lifecycle-events') return Response.json({})
    if (url.pathname === '/provider/v1/models') return Response.json({ data: [{ id: 'm' }] })
    if (url.pathname === '/alpha/generate') {
      req.signal.addEventListener('abort', () => { generateCancelled = true })
      const stream = new ReadableStream({
        async start(c) {
          c.enqueue(enc.encode(JSON.stringify({ type: 'start' }) + '\n'))
          await Bun.sleep(120000)
          c.close()
        },
        cancel() { generateCancelled = true },
      })
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
    }
    return new Response('nf', { status: 404 })
  },
})

await import('../src/index.ts')
await Bun.sleep(300)

const BASE = 'http://127.0.0.1:4210'
const KEY = 'user_timeout_test'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra?: any) {
  if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : '') }
}

console.log('--- stream idle timeout (waits ~30s) ---')
{
  const t0 = Date.now()
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/hang', stream: true, messages: [{ role: 'user', content: 'q' }] }),
  })
  const elapsed = Date.now() - t0
  const body = await r.json().catch(() => null)
  check('stream idle timeout → 429 JSON', r.status === 429 && body?.error?.type === 'rate_limit_error' && body?.retry_after === 5, body)
  check('timeout around 30s', elapsed > 28000 && elapsed < 35000, elapsed)
  await Bun.sleep(500)
  check('upstream aborted after timeout', generateCancelled)
}

console.log('--- anthropic client disconnect mid-stream ---')
{
  generateCancelled = false
  const ac = new AbortController()
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ model: 'mock/hang', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'q' }] }),
    signal: ac.signal,
  })
  const reader = r.body!.getReader()
  await reader.read()
  ac.abort()
  await Bun.sleep(600)
  check('anthropic upstream aborted on disconnect', generateCancelled)
  const health = await fetch(BASE + '/health')
  check('server alive', health.status === 200)
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)

export {}
