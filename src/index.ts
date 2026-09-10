import { Elysia } from 'elysia'
import { CFG, MAX_BODY_SIZE } from './config'
import { CORS_HEADERS } from './http'
import { log } from './logger'
import { handleMessages } from './anthropic'
import { handleModels, MODELS } from './models'
import { handleChatCompletions } from './openai'
import { startSessionCleanup } from './session'
import { startVersionRefresh } from './version'

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function startServer() {
  startVersionRefresh()
  startSessionCleanup()

  const app = new Elysia()
    .onRequest(({ request, set }) => {
      Object.assign(set.headers, CORS_HEADERS)
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }
    })
    .get('/', () => new Response('OK', { headers: { 'Content-Type': 'text/plain' } }))
    .get('/health', () => jsonResponse(200, { ok: true }))
    .get('/v1/models', ({ headers }) => handleModels(headers))
    .post('/v1/chat/completions', ({ request, headers }) => handleChatCompletions(request, headers))
    .post('/v1/messages', ({ request, headers }) => handleMessages(request, headers))
    .onError(({ code, error, request }) => {
      const status = (error as any)?.status
      if (code === 'NOT_FOUND') {
        return jsonResponse(404, { error: { message: 'Not found', type: 'not_found' } })
      }
      if (status === 413 || code === 'PARSE' || code === 'VALIDATION') {
        const path = new URL(request.url).pathname
        if (status === 413) {
          return jsonResponse(413, { error: { message: `Request body exceeds ${Math.round(MAX_BODY_SIZE / 1024 / 1024)}MB limit`, type: 'invalid_request_error' } })
        }
        if (path === '/v1/messages') {
          return jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } })
        }
        return jsonResponse(400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } })
      }
      const message = (error as any)?.message ?? 'Internal error'
      return jsonResponse(500, { error: { message, type: 'internal_error' } })
    })
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