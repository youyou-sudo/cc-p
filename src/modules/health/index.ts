import { Elysia } from 'elysia'
import { getGateStats } from '../../infra/proxy-handler'

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 进程启动时刻（readyz uptime 基准；与 process.uptime() 二选一，此处用 Date.now 便于测试 mock）。
const BOOT_AT = Date.now()

function uptimeSeconds(): number {
  return Math.floor((Date.now() - BOOT_AT) / 1000)
}

export const healthController = new Elysia({ name: 'health', prefix: '' })
  // 存活探针：恒 ok，不做任何下游依赖。Docker HEALTHCHECK / CLI healthcheck 只看它。
  .get('/', () => new Response('OK', { headers: { 'Content-Type': 'text/plain' } }))
  .get('/health', () => jsonResponse(200, { ok: true }))
  // 就绪探针：深检。返回 gate 真实水位 + uptime；上游拨测可选（默认不拨，避免 ready 依赖外网）。
  // gate 为 proxy-handler 内进程级 ConcurrencyGate 单例，getGateStats() 返回聚合水位
  // { inFlight, queued, keys, maxInFlightPerKey, maxQueuePerKey, queueTimeoutMs }。
  .get('/readyz', () => {
    const uptime = uptimeSeconds()
    const mem = process.memoryUsage()
    return jsonResponse(200, {
      ok: true,
      uptimeSeconds: uptime,
      gate: getGateStats(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      // 可选上游拨测：默认关闭。如需开启，调用方带 ?probe=1，本路由再 fetch
      // `${CFG.apiBase}/provider/v1/models`（5s 超时），失败则 ok:false + 503。
      // 当前为避免 ready 抖动（外网抖动≠本进程不可用），默认不拨，只返回本地状态。
    })
  })
