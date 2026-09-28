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

/** 日志 / 占位符用 URL 缩写：data: URL 只保留 `data:<mime>;base64` 前缀，
 *  绝不把整段 base64 打进日志或上游文本。与 infra/cc.ts 的 local shortUrl 同形。 */
export function shortUrl(url: string, max = 120): string {
  if (typeof url !== 'string' || !url) return ''
  if (url.length <= max) return url
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    const head = comma >= 0 ? url.slice(0, comma) : url.slice(0, max)
    return `${head};…[${url.length} chars omitted]`
  }
  return url.slice(0, max) + '…'
}

// 工具结果里嵌入的巨型内联 data: URL（截图 base64 可达数 MB）必须以占位符
// 落地，否则每轮历史回灌都会把它当文本重发，直接顶爆上下文并触发对话压缩。
// 阈值取 4096 base64 字符（≈3KB 二进制）：大截图命中，代码里的微型 data URL 保留。
const LARGE_DATA_URL_PATTERN = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,[A-Za-z0-9+/=]{4096,}/gi

/** 把文本中过大的内联 data: URL 替换为占位符（保留 mime 与原始长度）。
 *  只作用于文本通道：真正的图片分片（type:'image'）不走这里，视觉输入不受影响。 */
export function redactLargeDataUrls(text: string): string {
  if (!text || !text.includes(';base64,')) return text
  return text.replace(LARGE_DATA_URL_PATTERN, (m, mime) => {
    const kind = mime ? `data:${mime};base64` : 'data:;base64'
    return `${kind},[${m.length} chars omitted]`
  })
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
