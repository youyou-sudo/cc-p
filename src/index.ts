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

export async function healthcheck(): Promise<void> {
  const port = Number(process.env.PORT) || CFG.port
  const url = `http://127.0.0.1:${port}/health`

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

process.on('unhandledRejection', (reason: any) => {
  if (reason?.name === 'AbortError' || reason?.code === 'ABORT_ERR') {
    log('info', 'Aborted request cleaned up')
  } else {
    log('error', 'Unhandled rejection', {
      message: reason?.message || String(reason),
      stack: reason?.stack?.split('\n')[0],
    })
  }
})

const command = process.argv[2]
if (command === 'healthcheck') {
  void healthcheck()
} else {
  startServer()
}
