import { SSE_PING_EVENT, SsePipeline, startSseHeartbeat } from '../src/sse.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra?: any) {
  if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : '') }
}

const dec = new TextDecoder()

async function readOne(p: SsePipeline, timeoutMs = 200): Promise<string> {
  const reader = p.stream.getReader()
  try {
    const r = await Promise.race([
      reader.read(),
      Bun.sleep(timeoutMs).then(() => null),
    ])
    if (r === null || r.done) return ''
    return dec.decode(r.value)
  } finally {
    try { reader.releaseLock() } catch {}
  }
}

console.log('--- heartbeat ---')
// 心跳只保下游不续租上游：startSseHeartbeat 只向客户端 SSE 写 ping/keepalive，
// 不触碰上游 readWithTimeout 空闲计时。上游思考期（reasoning-start 后 30s+ 零字节）
// 仍由 CC_THINKING_IDLE_MS（默认 120s）裁决，心跳 ping 不能为上游续租——
// “客户端连接存活”不等于“上游有字节”。思考超时定性看服务端日志
// thinkingPhase=true + lastCcEvent=reasoning-start + elapsedMs≈timeoutMs。
{
  // started + idle → `event: ping` (Anthropic default) 且 pingCount>0
  const p = new SsePipeline(false)
  p.start()
  const hb = startSseHeartbeat(p, { intervalMs: 20, idleMs: 50 })
  await Bun.sleep(160)
  clearInterval(hb)
  const text = await readOne(p)
  check('idle → event: ping frame', text.includes('event: ping') && text.includes('"type":"ping"'), text)
  check('pingCount>0 after idle', p.pingCount > 0, p.pingCount)
  check('default ping event shape', SSE_PING_EVENT === 'event: ping\ndata: {"type":"ping"}\n\n')
  p.close()
}
{
  // !started 时不发（zero-output 可重试不变式：缓冲期保 JSON）
  const p = new SsePipeline(false)
  const hb = startSseHeartbeat(p, { intervalMs: 20, idleMs: 50 })
  await Bun.sleep(140)
  clearInterval(hb)
  check('unstarted → no ping', p.pingCount === 0, p.pingCount)
  p.close()
}
{
  // close() 后停发
  const p = new SsePipeline(false)
  p.start()
  p.close()
  const hb = startSseHeartbeat(p, { intervalMs: 20, idleMs: 50 })
  await Bun.sleep(140)
  clearInterval(hb)
  check('closed → no ping', p.pingCount === 0, p.pingCount)
}
{
  // OpenAI 覆盖参数 pingEvent=': keepalive\n\n' → 注释帧而非 event: ping
  const p = new SsePipeline(false)
  p.start()
  const hb = startSseHeartbeat(p, { intervalMs: 20, idleMs: 50, pingEvent: ': keepalive\n\n' })
  await Bun.sleep(160)
  clearInterval(hb)
  const text = await readOne(p)
  check('custom pingEvent → comment frame', text.includes(': keepalive') && !text.includes('event: ping'), text)
  check('custom ping counted', p.pingCount > 0, p.pingCount)
  p.close()
}
{
  // 未 idle 时不发：刚写入后 lastSentAt 更新，idle 窗口内无 ping
  const p = new SsePipeline(false)
  p.start()
  const hb = startSseHeartbeat(p, { intervalMs: 20, idleMs: 10_000 })
  await Bun.sleep(120)
  clearInterval(hb)
  check('no idle → no ping', p.pingCount === 0, p.pingCount)
  p.close()
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)

export {}
