import { Elysia } from 'elysia'
import { MAX_BODY_SIZE } from '../config'

// Reusable copy of the src/index.ts onError branches (NOT_FOUND / 413 /
// PARSE / VALIDATION + 500 fallback). Kept byte-identical in shape:
// OpenAI routes get { error: … }, /v1/messages gets the Anthropic
// { type: 'error', error: … } wrapper. No response-schema validation is
// added — handlers return raw Responses. Standalone: no routes added, so
// app.use(errorsPlugin) only contributes the onError hook.
//
// Errors thrown via status() (ElysiaCustomStatusResponse: resolve/macro
// auth failures) pass through untouched — returning undefined lets Elysia's
// default mapping render them. Only plain Errors / framework codes are
// normalized here.
function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function isStatusResponse(error: any): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    'response' in error &&
    (error as any)?.constructor?.name === 'ElysiaCustomStatusResponse'
  )
}

export const errorsPlugin = new Elysia({ name: 'errors' })
  // scoped (not local): fires for routes registered on the app AFTER
  // app.use(errorsPlugin): local misses NOT_FOUND entirely, global would
  // also hijack routes registered before .use(). Scoped + returning
  // undefined on foreign error classes (status()-thrown Elysia responds,
  // e.g. macro auth failures) lets Elysia's default mapping render them.
  .onError({ as: 'scoped' }, ({ code, error, request }) => {
    if (isStatusResponse(error)) return undefined
    const status = (error as any)?.status
    if (code === 'NOT_FOUND') {
      return jsonResponse(404, { error: { message: 'Not found', type: 'not_found' } })
    }
    if (status === 413 || code === 'PARSE' || code === 'VALIDATION') {
      const path = new URL(request.url).pathname
      if (status === 413) {
        const msg = `Request body exceeds ${Math.round(MAX_BODY_SIZE / 1024 / 1024)}MB limit`
        if (path === '/v1/messages') {
          return jsonResponse(413, { type: 'error', error: { type: 'invalid_request_error', message: msg } })
        }
        return jsonResponse(413, { error: { message: msg, type: 'invalid_request_error' } })
      }
      if (path === '/v1/messages') {
        return jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } })
      }
      return jsonResponse(400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } })
    }
    const message = (error as any)?.message ?? 'Internal error'
    return jsonResponse(500, { error: { message, type: 'internal_error' } })
  })
