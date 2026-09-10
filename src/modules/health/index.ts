import { Elysia } from 'elysia'

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const healthController = new Elysia({ name: 'health', prefix: '' })
  .get('/', () => new Response('OK', { headers: { 'Content-Type': 'text/plain' } }))
  .get('/health', () => jsonResponse(200, { ok: true }))
