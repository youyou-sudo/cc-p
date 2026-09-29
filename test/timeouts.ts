process.env.PORT = '4210'
process.env.HOST = '127.0.0.1'
process.env.CC_API_BASE = 'http://127.0.0.1:4110'
process.env.CC_API_KEY = ''
// mock 上游只发 {type:'start'} 后挂起，而 'start' 命中 isThinkingWait()，
// 故空闲预算取 THINKING_IDLE_TIMEOUT_MS 而非 STREAM_IDLE_TIMEOUT_MS。
// 压到 30s 使本用例只需真实等待 ~30s（保持 CI 时长不变），
// 同时仍走「thinking 预算」这条真实代码路径。thinking 预算的
// 默认值/覆盖/=0/非数字契约由 test/idle-timeout-env.ts 覆盖。
process.env.CC_THINKING_IDLE_MS = '30000'

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
      // 只发 {type:'start'} 再挂起：
      //  - 保持零输出、未 flush 任何下游头，故超时后仍能返回 JSON 429
      //    （若先发 text-delta，SSE 头已 flush，只能得到流内 error 事件）
      //  - 但 'start' 属于 isThinkingWait()，预算会取 THINKING_IDLE_TIMEOUT_MS，
      //    故本文件用 CC_THINKING_IDLE_MS 显式压低该预算而非依赖 30s 默认值
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
  check('timeout around 30s', elapsed > 28000 && elapsed < 45000, elapsed)
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
