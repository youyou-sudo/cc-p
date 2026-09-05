import { MAX_BODY_SIZE } from './config'

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
}

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
}

export function sendJSON(status: number, data: unknown): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if ((data as any)?.retry_after !== undefined) {
    headers['Retry-After'] = String((data as any).retry_after)
  }
  return new Response(JSON.stringify(data), { status, headers })
}

export function sendAnthropicError(
  status: number,
  type: string,
  message: string,
  opts?: { retryAfter?: number; headerOnly?: boolean },
): Response {
  const body: any = { type: 'error', error: { type, message } }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts?.retryAfter !== undefined && !opts.headerOnly) {
    body.retry_after = opts.retryAfter
    headers['Retry-After'] = String(opts.retryAfter)
  } else if (opts?.retryAfter !== undefined && opts.headerOnly) {
    headers['Retry-After'] = String(opts.retryAfter)
  }
  return new Response(JSON.stringify(body), { status, headers })
}

export class BodyTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds ${Math.round(MAX_BODY_SIZE / 1024 / 1024)}MB limit`)
  }
}

const DRAIN_LIMIT = 32 * 1024 * 1024
const sharedDecoder = new TextDecoder()

export async function readJsonBody(request: Request): Promise<any> {
  const contentLength = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
    throw new BodyTooLargeError()
  }

  const reader = request.body?.getReader()
  if (!reader) throw new Error('Invalid JSON')

  const chunks: Uint8Array[] = []
  let totalSize = 0
  let tooLarge = false
  let drained = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (tooLarge) {
      drained += value.byteLength
      if (drained > DRAIN_LIMIT) {
        try { reader.cancel() } catch {}
        break
      }
      continue
    }
    totalSize += value.byteLength
    if (totalSize > MAX_BODY_SIZE) {
      tooLarge = true
      chunks.length = 0
      continue
    }
    chunks.push(value)
  }
  if (tooLarge) throw new BodyTooLargeError()

  const text = chunks.map((c) => sharedDecoder.decode(c, { stream: true })).join('') + sharedDecoder.decode()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Invalid JSON')
  }
}

export async function readWithTimeout<T>(promise: Promise<T>, timeoutMs: number, tag: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(tag)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
