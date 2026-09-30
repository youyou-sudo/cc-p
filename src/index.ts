import { CFG } from './shared/config'
import { log } from './shared/logger'
import { MODELS } from './modules/models/catalog'
import { startSessionCleanup } from './infra/session'
import { startVersionRefresh } from './shared/version'
import { createApp } from './app'

export function startServer() {
  startVersionRefresh()
  startSessionCleanup()

  // idleTimeout: Elysia's Bun adapter hardcodes 30s (its dist/adapter/bun
  // serve options) and .listen() only overrides it if asked. That 30s ceiling
  // is TIGHTER than this proxy's own budgets (stream 30s / non-stream 90s /
  // thinking 120s), so the latter two can never be reached — and it sits below
  // 0, so a request is cut mid-flight with a generic socket error rather than
  // the intended 429 + guidance.
  //
  // 0 disables the transport-level ceiling so shared/runtime.ts is the single
  // authority for timeouts. It only bit bodyless slow requests in practice
  // (Bun refreshes the idle timer when a request body is read, which is why
  // POST generation survived), so this is a guard against a future bodyless
  // slow route rather than a fix for an active bug.
  //
  // 0 also means nothing here bounds a stalled response, so pin an operational
  // ceiling at the proxy in front of this service (nginx/ALB/cloud LB) if you
  // need one. See doc/modules/02a-plugins-access.md for the measured behaviour.
  const app = createApp().listen({ port: CFG.port, hostname: CFG.host, idleTimeout: 0 })

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
    emptySystemPlaceholder: CFG.emptySystemPlaceholder
      ? 'on (single-space system placeholder keeps prompt_tokens minimal)'
      : 'off (real upstream default system prompt applies)',
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
