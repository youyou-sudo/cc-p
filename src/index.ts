import { CFG } from './shared/config'
import { log } from './shared/logger'
import { MODELS } from './modules/models/catalog'
import { startSessionCleanup } from './infra/session'
import { startVersionRefresh } from './shared/version'
import { createApp } from './app'

export function startServer() {
  startVersionRefresh()
  startSessionCleanup()

  const app = createApp()
    .listen({ port: CFG.port, hostname: CFG.host })

  log('info', 'CC Proxy started', {
    url: `http://${CFG.host}:${CFG.port}`,
    api: CFG.apiBase,
    models: MODELS.length,
    cors: CFG.apiKey
      ? `restricted (CC_API_KEY fallback set; browser calls only from ${CFG.corsAllowOrigin || 'no origin (CORS disabled)'})`
      : CFG.corsAllowOrigin
        ? `allowed from ${CFG.corsAllowOrigin}`
        : 'open (no CC_API_KEY fallback; per-request keys only)',
    session: '12h + 1h jitter, per API key',
    zdr: CFG.zdr
      ? 'enabled (x-cmd-zdr: 1 on generation/init requests)'
      : 'off (CMD_ZDR=1 or per-request x-cmd-zdr: 1 to enable)',
    emptySystemPlaceholder: CFG.emptySystemPlaceholder ? 'on' : 'off',
    logFile: CFG.logFile || '(console only)',
  })

  if (!CFG.apiKey) {
    log('info', 'No fallback API key (CC_API_KEY). Requests must send one in Authorization: Bearer <key> or x-api-key header.')
  }

  return app
}

// 按 CFG.host 解析拨测地址：0.0.0.0（全接口监听）无法直接 dial，
// 回落 127.0.0.1；::（IPv6 全接口）回落 ::1；其余按 CFG.host 直拨。
// 仍允许 PORT env 覆盖端口（Docker 传参场景），回落 CFG.port。
function healthcheckDialHost(): string {
  const host = (process.env.HOST ?? CFG.host ?? '').trim()
  if (host === '0.0.0.0') return '127.0.0.1'
  if (host === '::') return '::1'
  if (host === '') return '127.0.0.1'
  return host
}

function formatDialHost(host: string): string {
  // IPv6 字面量需加方括号（http://[::1]:3050/health）。
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

export async function healthcheck(): Promise<void> {
  const port = Number(process.env.PORT) || CFG.port
  const host = formatDialHost(healthcheckDialHost())
  const url = `http://${host}:${port}/health`

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      console.error(`[err] Healthcheck failed: ${res.status} ${res.statusText}`)
      process.exit(1)
    }
    const body = (await res.json()) as { ok?: boolean }
    if (body.ok !== true) {
      console.error('[err] Healthcheck failed: unexpected response body')
      process.exit(1)
    }
    console.log('[ ok ] Healthcheck passed')
    process.exit(0)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[err] Healthcheck failed:', msg)
    process.exit(1)
  }
}

// 脱敏：key/secret/token/authorization/cookie/set-cookie 头值打码，
// user_xxx 长 token 截断，query 中的 key/secret 参数打码。
function redactLine(line: string): string {
  return line
    .replace(/(authorization["'\s:=]+bearer\s+)([A-Za-z0-9_.~-]+)/gi, '$1***')
    .replace(/(user_[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1***')
    .replace(/((?:api[_-]?key|secret|token|password)["'\s:=]+)([^"'\s,};&]+)/gi, '$1***')
}

process.on('unhandledRejection', (reason: any) => {
  if (reason?.name === 'AbortError' || reason?.code === 'ABORT_ERR') {
    log('info', 'Aborted request cleaned up')
  } else {
    // 记完整 stack 前 10 行（旧代码只记首行，丢调用链无法定位）+ 脱敏。
    const rawStack = typeof reason?.stack === 'string' ? reason.stack : undefined
    const stackLines = rawStack
      ? rawStack.split('\n').slice(0, 10).map((l: string) => redactLine(l))
      : undefined
    log('error', 'Unhandled rejection', {
      message: typeof reason?.message === 'string' ? redactLine(reason.message) : redactLine(String(reason)),
      stack: stackLines,
    })
  }
})

const command = process.argv[2]
if (command === 'healthcheck') {
  void healthcheck()
} else {
  startServer()
}
