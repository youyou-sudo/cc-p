import { log } from '../shared/logger'
import { sha256hex, uuid } from '../shared/util'
import { keyStateStore } from './fingerprint'
import { pruneAllGatesEmpty } from '../shared/concurrency'
// NOTE: runtime.ts is imported lazily inside cleanup (dynamic import) to keep
// this module cycle-free: session -> (static) runtime is fine (runtime is a
// leaf), but proxy-handler -> cc -> session exists, so session must never
// statically import proxy-handler. concurrency.pruneAllGatesEmpty needs no
// gate handle for the same reason.

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000
const SESSION_JITTER_MS = 60 * 60 * 1000
const SESSION_CLEANUP_MS = 60 * 60 * 1000

/** Soft cap: apiKey cardinality is caller-influenced. Evict oldest-inserted. */
export const MAX_SESSIONS = 100_000

/** apiKey guard: auth.ts caps at 256 chars; reject anything longer here too. */
const MAX_API_KEY_LENGTH = 256

/** Client-supplied session ids are enumerable: strict whitelist + length. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const MIN_SESSION_ID_LEN = 8
const MAX_SESSION_ID_LEN = 128

interface SessionEntry {
  sessionId: string
  expiresAt: number
}

const sessionStore = new Map<string, SessionEntry>()

function shortId(sessionId: string): string {
  try {
    return sha256hex(sessionId).slice(0, 8)
  } catch {
    return '(unknown)'
  }
}

export function ensureSession(apiKey: string): string {
  const now = Date.now()
  const entry = sessionStore.get(apiKey)

  if (entry && now < entry.expiresAt) {
    return entry.sessionId
  }

  // Soft-cap eviction before insert (Map preserves insertion order).
  if (!sessionStore.has(apiKey) && sessionStore.size >= MAX_SESSIONS) {
    const oldest = sessionStore.keys().next()
    if (!oldest.done) {
      sessionStore.delete(oldest.value)
      try { keyStateStore.delete(oldest.value) } catch {}
    }
  }

  const jitter = Math.floor(Math.random() * SESSION_JITTER_MS)
  const sessionId = uuid()
  sessionStore.set(apiKey, { sessionId, expiresAt: now + SESSION_DURATION_MS + jitter })
  log('info', 'Session created', { sessionHash: shortId(sessionId), storeSize: sessionStore.size })
  return sessionId
}

/** Case-insensitive header lookup: Elysia/Bun may preserve original casing. */
function headerCaseInsensitive(headers: Record<string, string | undefined>, name: string): string | undefined {
  const direct = headers[name]
  if (direct !== undefined) return direct
  const lower = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k]
  }
  return undefined
}

function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string'
    && id.length >= MIN_SESSION_ID_LEN
    && id.length <= MAX_SESSION_ID_LEN
    && SESSION_ID_PATTERN.test(id)
}

export function getSessionId(
  incomingHeaders: Record<string, string | undefined>,
  apiKey: string,
  promptCacheKey?: string,
): string {
  const candidates = [
    headerCaseInsensitive(incomingHeaders, 'x-session-id'),
    headerCaseInsensitive(incomingHeaders, 'x-claude-code-session-id'),
    headerCaseInsensitive(incomingHeaders, 'session_id'),
    promptCacheKey,
  ]
  for (const id of candidates) {
    // Invalid ids are ignored (never propagated): fall through to ensureSession.
    if (isValidSessionId(id)) return id
  }
  // Over-long keys are refused at the auth layer; double-guard here so a
  // hostile key cannot become an unbounded Map key via ensureSession.
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > MAX_API_KEY_LENGTH) {
    // Use a truncated scope so cleanup can still bucket it.
    return ensureSession(apiKey.slice(0, MAX_API_KEY_LENGTH))
  }
  return ensureSession(apiKey)
}

async function runCleanupOnce(): Promise<void> {
  const now = Date.now()
  let cleaned = 0
  for (const [key, entry] of sessionStore) {
    if (now >= entry.expiresAt) {
      sessionStore.delete(key)
      try { keyStateStore.delete(key) } catch {}
      cleaned++
    }
  }
  // Also drop stale timeout counters and empty gate buckets so all four
  // maps stay bounded even when session keys churn.
  let prunedTimeouts = 0
  try {
    const runtime = await import('../shared/runtime')
    prunedTimeouts = runtime.pruneTimeoutStates()
  } catch {}
  try { pruneAllGatesEmpty() } catch {}
  if (cleaned > 0 || prunedTimeouts > 0) {
    log('info', 'Session cleanup', { cleaned, prunedTimeouts, remaining: sessionStore.size })
  }
}

export function startSessionCleanup(): void {
  // Run once at startup (previously first run was delayed 1h, leaving stale
  // entries from a hot restart uncollected); then hourly. unref() so the
  // timer never keeps a test process / CLI alive on its own.
  void runCleanupOnce().catch(() => {})
  const timer = setInterval(() => {
    void runCleanupOnce().catch(() => {})
  }, SESSION_CLEANUP_MS)
  try { (timer as unknown as { unref?: () => void }).unref?.() } catch {}
}
