import { Elysia } from 'elysia'
import { CORS_HEADERS } from '../shared/http'

// Shim over src/http.ts CORS_HEADERS (module-load snapshot of
// corsAllowOrigin(): CFG.apiKey ? 'null' : '*' unless CORS_ALLOW_ORIGIN set).
// Same semantics as src/index.ts onRequest: stamp CORS headers on every
// request via set.headers, short-circuit OPTIONS with 204 + CORS headers.
// Deliberately NOT @elysiajs/cors (semantics differ). Standalone: no routes,
// no decorate — safe to app.use() before route registration.
export const corsPlugin = new Elysia({ name: 'cors' })
  .onRequest(({ request, set }) => {
    Object.assign(set.headers, CORS_HEADERS)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }
  })
