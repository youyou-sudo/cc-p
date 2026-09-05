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
  return `${process.platform}-${process.arch}, Node.js ${process.versions.node}`
}

export function tryParseJSON(str: string): any {
  try {
    return JSON.parse(str)
  } catch {
    return {}
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
