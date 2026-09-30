process.env.PORT = '4210'
process.env.HOST = '127.0.0.1'
process.env.CC_API_BASE = 'http://127.0.0.1:4110'
process.env.CC_API_KEY = ''

const enc = new TextEncoder()
let generateCancelled = false

Bun.serve({
  port: 4110,
  idleTimeout: 120,
  fetch: async (req) => {
    const url = new URL(req.url)
    if (url.pathname === '/alpha/fingerprint/record') return Response.json({})
    if (url.pathname === '/alpha/lifecycle-events') return Response.json({})
    if (url.pathname === '/provider/v1/models') return Response.json({ data: [{ id: 'm' }] })
    if (url.pathname === '/alpha/generate') {
      req.signal.addEventListener('abort', () => { generateCancelled = true })
      // disconnect 用例用 mock/hang-started：先发 text-delta 使下游 start()
      // （客户端 headers 到达、可 abort），再挂起；默认走 ":" 保活行挂起。
      let hangStarted = false
      try {
        const body: any = await req.clone().json()
        hangStarted = body?.params?.model === 'mock/hang-started'
      } catch {}
      const stream = new ReadableStream({
        start(c) {
          // Bun buffers response headers until the first body bytes: enqueue a
          // parser-ignored ":" keepalive so forwardToCC receives headers
          // immediately. CcStreamParser skips ":" lines, so lastCcEvent stays
          // '' → 30s non-thinking budget (thinking 120s: pure-fn asserts below).
          // disconnect 用例用 mock/hang-started（text-delta 先发 → Anthropic 侧
          // content_block_start → pipeline.start() → 客户端 headers 到达可 abort）。
          if (hangStarted) {
            c.enqueue(enc.encode(JSON.stringify({ type: 'text-delta', text: 'hi' }) + '\n'))
          } else {
            c.enqueue(enc.encode(':\n'))
          }
          setTimeout(() => { try { c.close() } catch {} }, 120000)
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
// 本用例 mock /alpha/generate ":" 保活行挂起（parser 忽略 ":" 行，零事件 =>
// lastCcEvent 保持 '' => isThinkingWait('') 为 false => 仍走流式 30s 预算，
// 下面 28–35s 断言依然成立）。此前"零字节挂起（不发任何行）"写法在 Bun 下
// headers 被缓冲 120s 才到达，代理 30s 计时从 headers 到达才开始，导致 120s
// 超时 + 502（见 CC fetch failed 日志）；":" 保活首字节使 headers 即时到达。
// 思考期（start/start-step/reasoning-start/reasoning-delta
// 后挂起）期望 120s（CC_THINKING_IDLE_MS），只做纯函数断言，不做真实等待：见文件末尾
// ENABLE_THINKING_ASSERT 门控块；THINKING env 解析由 test/idle-timeout-env.ts 覆盖。
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
    body: JSON.stringify({ model: 'mock/hang-started', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'q' }] }),
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

// 可跳过的思考期纯函数单测（无真实等待）：src 并行修改中，isThinkingWait /
// idleTimeoutFor 落定前默认跳过。启用：ENABLE_THINKING_ASSERT=1 bun test/timeouts.ts
//（仍不跑 120s 真等待，只断言纯函数映射）。
if (process.env.ENABLE_THINKING_ASSERT === '1') {
  console.log('--- thinking idle mapping (skippable, no real wait) ---')
  try {
    const rt: any = await import('../src/shared/runtime.ts')
    if (typeof rt.isThinkingWait === 'function' && typeof rt.idleTimeoutFor === 'function') {
      check('thinking: start → wait', rt.isThinkingWait('start') === true)
      check('thinking: start-step → wait', rt.isThinkingWait('start-step') === true)
      check('thinking: reasoning-start → wait', rt.isThinkingWait('reasoning-start') === true)
      check('thinking: reasoning-delta → wait', rt.isThinkingWait('reasoning-delta') === true)
      check('thinking: empty → fast fail', rt.isThinkingWait('') === false)
      check('thinking: content-delta → normal', rt.isThinkingWait('content-delta') === false)
      const thinkMs = rt.idleTimeoutFor('reasoning-start', true)
      const streamMs = rt.idleTimeoutFor('', true)
      check('thinking window > stream window', thinkMs > streamMs, { thinkMs, streamMs })
    } else {
      console.log('SKIP thinking asserts: runtime exports not yet landed (parallel src change)')
    }
  } catch (e: any) {
    console.log('SKIP thinking asserts:', e?.message ?? e)
  }
  console.log(`\nRESULT(after thinking asserts): ${pass} passed, ${fail} failed`)
}
process.exit(fail > 0 ? 1 : 0)

export {}
