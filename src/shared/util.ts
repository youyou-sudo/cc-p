// Layer: toolkit（零依赖叶，谁都可依赖，谁都不依赖）
export function sha256hex(input: string): string {
  return new Bun.CryptoHasher('sha256').update(input).digest('hex')
}

export function sha256bytes(input: string): Uint8Array {
  return new Bun.CryptoHasher('sha256').update(input).digest()
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export function randHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function uuid(): string {
  return crypto.randomUUID()
}

/** 官方 CLI 的 session id 形状：`sess_` + uuid 去横线后前 16 位 hex
 *  （bundle 内 generateSessionId）。本地此前发裸 UUID，格式与真实 CLI 不符。 */
export function generateSessionId(): string {
  return `sess_${uuid().replace(/-/g, '').slice(0, 16)}`
}

/** 由稳定种子派生 v4 形状 UUID（sha256 hex 重排，确定性）。
 *  用途：上游 `threadId` 必须是合法 UUID 才会被发送（官方 toWireThreadId 对
 *  非 UUID 返回 undefined），而 session id 是 `sess_` 前缀、客户端也可能传任意
 *  id，所以需要一层确定性映射保证同一 session 恒得同一 thread。 */
export function uuidFromSeed(seed: string): string {
  const h = sha256hex(seed)
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

export function getDateStr(): string {
  return new Date().toISOString().slice(0, 10)
}

export function getEnvironment(): string {
  return 'win32-x64, Node.js 22.10.0'
}

export function tryParseJSON(str: string): any {
  try {
    return JSON.parse(str)
  } catch {
    return {}
  }
}

/** Strict JSON parse result: on failure returns a sentinel instead of silent {}. */
export interface JSONParseFailure {
  __parseError: true
  raw: string
  message: string
}

export function isJSONParseFailure(v: any): v is JSONParseFailure {
  return !!v && typeof v === 'object' && (v as any).__parseError === true
}

/** Strict variant: never silently returns {}. Caller decides (passthrough raw + log). */
export function tryParseJSONStrict(str: string): any | JSONParseFailure {
  try {
    return JSON.parse(str)
  } catch (e: any) {
    return { __parseError: true, raw: str, message: e?.message ?? 'Invalid JSON' }
  }
}

export function generateTraceparent(): string {
  return `00-${randHex(16)}-${randHex(8)}-01`
}

export function fakeProjectSlug(sessionId: string): string {
  const names = ['app', 'api', 'backend', 'bot', 'cli', 'core', 'data', 'frontend',
    'lib', 'plugin', 'proxy', 'server', 'service', 'tool', 'web', 'worker']
  const id = String(sessionId || '')
  const head = id.slice(0, 4)
  let idx = parseInt(head, 16)
  if (!Number.isFinite(idx)) {
    let h = 0
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
    idx = h
  }
  const name = names[idx % names.length]
  const suffix = head || '0000'
  const path = `C:\\Users\\dev\\projects\\${name}-${suffix}`
  return path
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
