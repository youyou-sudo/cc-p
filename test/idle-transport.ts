// test/idle-transport.ts — 传输层空闲上限回归（约 33s，无真实上游调用）。
//
// 根因：Elysia 的 Bun adapter 在构造 Bun.serve 时写死 `idleTimeout: 30`
// （node_modules/elysia/dist/adapter/bun/index.mjs:173）。src/index.ts 的
// .listen 若不覆盖，项目自己的预算（非流式 90s / 思考期 120s）在 GET 形态下
// 永远走不到——Bun 只在收到请求体等网络活动时重置空闲计时，所以带 body 的
// POST 侥幸存活，而无 body、又无 SSE 心跳的慢 GET 会被 30s 准点掐断。
// 修法：LISTEN_OPTIONS 带 idleTimeout: 0，把超时治理完全交还 runtime.ts。
//
// 本用例复用生产同一份 LISTEN_OPTIONS 启动临时服务器（含一个 32s 慢 GET），
// 断言响应越过旧 30s 传输上限仍返回 200。若有人删掉 / 改回 idleTimeout，
// 服务器会在 ~30s 断开、用例失败——这正是要守住的回归。
process.env.PORT = '4231'
process.env.HOST = '127.0.0.1'
process.env.CC_API_BASE = 'http://127.0.0.1:4130'
process.env.CC_API_KEY = ''

import { Elysia } from 'elysia'

// 动态 import 生产入口：用上面的 PORT 启动真实服务器（无慢路由，不受影响），
// 同时取回共享的 LISTEN_OPTIONS（单独导出即为此测试 seam）。
const { LISTEN_OPTIONS } = await import('../src/index.ts')
await Bun.sleep(300)

const PORT = 4230
const SLOW_MS = 32_000

const app = new Elysia()
  .get('/slow', async () => {
    await Bun.sleep(SLOW_MS)
    return new Response('ok', { headers: { 'content-type': 'text/plain' } })
  })
  .listen({ ...LISTEN_OPTIONS, port: PORT, hostname: '127.0.0.1' })

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra?: any) {
  if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : '') }
}

check('LISTEN_OPTIONS disables the transport idle cap', LISTEN_OPTIONS.idleTimeout === 0, LISTEN_OPTIONS)

console.log('--- slow GET must survive past the legacy 30s transport cap (waits ~32s) ---')
{
  const t0 = Date.now()
  let status = 0
  let body = ''
  let err = ''
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/slow`, { signal: AbortSignal.timeout(SLOW_MS + 8000) })
    status = r.status
    body = await r.text()
  } catch (e: any) {
    err = e?.name ?? String(e)
  }
  const elapsed = Date.now() - t0
  check('slow GET → 200 ok (transport cap disabled)', status === 200 && body === 'ok' && err === '', { status, body, err, elapsed })
  check('elapsed actually exceeds the 30s cap', elapsed > 30_000, elapsed)
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
await app.stop(true)
process.exit(fail > 0 ? 1 : 0)

export {}
