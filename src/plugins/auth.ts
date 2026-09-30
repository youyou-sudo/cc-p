import { Elysia } from 'elysia'
import { authErrorMessage, getApiKey } from '../shared/auth'
import { CFG } from '../shared/config'
import { log } from '../shared/logger'

// Shim over the legacy pure auth helpers (src/auth.ts).
// Old call sites (openai.ts / anthropic.ts hand-rolled 401s) keep working:
// this plugin only re-exports getApiKey as a decorator and adds an opt-in
// `requireAuth` macro — nothing is enforced unless a route opts in.
//
// Dual-protocol note: src/auth.ts keyFormatError/authErrorMessage returns a
// single message string (no per-path OpenAI/Anthropic split there — the split
// lives in the protocol handlers). The macro mirrors that: the 401 body
// carries both shapes at once ({ error: OpenAI } + top-level type: Anthropic)
// so either client parses it. resolve failures use status(401, …) (thrown, so
// resolve maps it to a short-circuit response) — never `new Response`.
export function authErrorBody(headers: Record<string, string | undefined>): {
  error: { message: string; type: string }
  type: string
} {
  return {
    error: { message: authErrorMessage(headers), type: 'auth_error' },
    type: 'error',
  }
}

export const authPlugin = new Elysia({ name: 'auth' })
  .decorate('getApiKey', getApiKey)
  .macro({
    requireAuth: {
      resolve({ headers, status }: { headers: Record<string, string | undefined>; status: any }) {
        const apiKey = getApiKey(headers)
        if (!apiKey) throw status(401, authErrorBody(headers))
        return { apiKey }
      },
    },
  })

// Per-protocol 401 bodies — byte-identical literals to the old hand-rolled
// handlers (openai.ts:62 / anthropic.ts:418). authErrorBody above is a merged
// shape (top-level type + error.type) and must NOT be reused here.
export const openAI401Body = (msg: string) => ({ error: { message: msg, type: 'auth_error' as const } })
export const anthropic401Body = (msg: string) => ({
  type: 'error' as const,
  error: { type: 'authentication_error' as const, message: msg },
})

// Auth pre-check factory for onTransform/derive (NOT guard/resolve/macro).
// Why return status (not throw): in Elysia 1.4.30 AoT (compose.js) the order
// is parse → transform/derive → validation → beforeHandle/resolve, so a
// `return status(401, …)` from transform/derive short-circuits validation
// and never enters onError; a resolve/macro (requireAuth) runs AFTER
// validation and cannot fix the no-key + illegal-schema 401→400 regression.
// Why per-isAnthropic literal: replicates the legacy dual shapes exactly.
// Why no onParse/new Response/plain Error: onParse return values become
// c.body and thrown Errors are wrapped as PARSE by the framework.
export function createAuthPreCheck(isAnthropic: boolean) {
  return ({
    request,
    headers,
    status,
  }: {
    request: Request
    headers: Record<string, string | undefined>
    status: any
  }) => {
    const h = headers as unknown as Record<string, string | undefined>
    if (getApiKey(h)) return undefined
    const msg = authErrorMessage(h)
    // This is the 401 that actually reaches clients: it short-circuits
    // before the handler runs, so the handler's own 'Authentication failed'
    // log in chat/handler.ts and messages/handler.ts is unreachable via the
    // routed path and only fires for direct handleXxxBody callers. Without a
    // log here, a 401 storm (wrong key deployed, SDK sending the wrong
    // header) showed only a status code in the access log, never a reason.
    log('warn', 'Authentication failed (pre-check)', {
      path: new URL(request.url).pathname,
      protocol: isAnthropic ? 'anthropic' : 'openai',
      reason: msg,
      hasAuthorization: !!h['authorization'] || !!h['Authorization'],
      hasXApiKey: !!h['x-api-key'] || !!h['X-Api-Key'],
      fallbackKeyConfigured: !!CFG.apiKey,
    })
    return status(401, isAnthropic ? anthropic401Body(msg) : openAI401Body(msg))
  }
}
