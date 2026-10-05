import { Elysia } from 'elysia'
import { authErrorMessage, getApiKey } from '../shared/auth'
import { CFG } from '../shared/config'
import { log } from '../shared/logger'

// Shim over the legacy pure auth helpers (src/shared/auth.ts).
// Enforcement is via createAuthPreCheck below (onTransform/derive).
// No route references a `requireAuth` macro (verified: no usages),
// so no macro is provided.
//
// Dual-protocol note: src/shared/auth.ts authErrorMessage returns a
// single message string (no per-path OpenAI/Anthropic split there — the split
// lives in createAuthPreCheck below, which picks the per-protocol body).
export const authPlugin = new Elysia({ name: 'auth' })
  .decorate('getApiKey', getApiKey)

// Per-protocol 401 bodies — byte-identical literals to the old hand-rolled
// handlers (openai.ts:62 / anthropic.ts:418).
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
