import { log } from './logger'
import { uuid } from './util'
import { keyStateStore } from './fingerprint'

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000
const SESSION_JITTER_MS = 60 * 60 * 1000

interface SessionEntry {
  sessionId: string
  expiresAt: number
}

const sessionStore = new Map<string, SessionEntry>()

export function ensureSession(apiKey: string): string {
  const now = Date.now()
  const entry = sessionStore.get(apiKey)

  if (entry && now < entry.expiresAt) {
    return entry.sessionId
  }

  const jitter = Math.floor(Math.random() * SESSION_JITTER_MS)
  const sessionId = uuid()
  sessionStore.set(apiKey, { sessionId, expiresAt: now + SESSION_DURATION_MS + jitter })
  log('info', 'Session created', { sessionId: sessionId.slice(0, 8), storeSize: sessionStore.size })
  return sessionId
}

export function getSessionId(
  incomingHeaders: Record<string, string | undefined>,
  apiKey: string,
  promptCacheKey?: string,
): string {
  const candidates = [
    incomingHeaders['x-session-id'],
    incomingHeaders['x-claude-code-session-id'],
    incomingHeaders['session_id'],
    promptCacheKey,
  ]
  for (const id of candidates) {
    if (id && typeof id === 'string' && id.length >= 8) return id
  }
  return ensureSession(apiKey)
}

export function startSessionCleanup(): void {
  setInterval(() => {
    const now = Date.now()
    let cleaned = 0
    for (const [key, entry] of sessionStore) {
      if (now >= entry.expiresAt) {
        sessionStore.delete(key)
        keyStateStore.delete(key)
        cleaned++
      }
    }
    if (cleaned > 0) log('info', 'Session cleanup', { cleaned, remaining: sessionStore.size })
  }, 60 * 60 * 1000)
}
