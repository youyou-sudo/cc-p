import { CFG } from '../shared/config'
import { log } from '../shared/logger'
import { pick, randHex, sha256hex } from '../shared/util'
import { CC_VERSION } from '../shared/version'

const FINGERPRINT_CPUS = [
  { model: '12th Gen Intel(R) Core(TM) i7-12650H', cores: 10 },
  { model: '12th Gen Intel(R) Core(TM) i5-12400F', cores: 6 },
  { model: '12th Gen Intel(R) Core(TM) i9-12900K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i7-13700K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i5-13600K', cores: 14 },
  { model: '13th Gen Intel(R) Core(TM) i9-13900K', cores: 24 },
  { model: 'Intel(R) Core(TM) Ultra 7 155H', cores: 16 },
  { model: 'Intel(R) Core(TM) Ultra 9 285H', cores: 16 },
  { model: 'Intel(R) Core(TM) i9-14900K', cores: 24 },
  { model: 'Intel(R) Core(TM) i7-14700K', cores: 20 },
  { model: 'AMD Ryzen 7 7800X3D', cores: 8 },
  { model: 'AMD Ryzen 9 7950X', cores: 16 },
  { model: 'AMD Ryzen 5 7600', cores: 6 },
  { model: 'AMD Ryzen 9 7900X', cores: 12 },
  { model: 'AMD Ryzen 7 5800X3D', cores: 8 },
] as const

const FINGERPRINT_MEMS = [8, 16, 24, 32, 48, 64] as const

const FINGERPRINT_TZS = [
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Toronto',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Seoul', 'Asia/Hong_Kong',
  'Australia/Sydney', 'Pacific/Auckland',
] as const

const FINGERPRINT_MAC_COUNT_RANGE = [2, 3, 4, 5] as const

export interface Fingerprint {
  thumbmark: string
  components: {
    machineIdHash: string
    macHashes: string[]
    osUserHash: string
    hostnameHash: string
    gitEmailHash: string
    platform: string
    arch: string
    osRelease: string
    cpuModel: string
    cpuCount: number
    memGiB: number
    isContainer: boolean
    timezone: string
    runtime: string
    collectorVersion: number
  }
}

export function generateFingerprint(): Fingerprint {
  const cpuEntry = pick(FINGERPRINT_CPUS)
  const memGiB = pick(FINGERPRINT_MEMS)
  const tz = pick(FINGERPRINT_TZS)
  const macCount = pick(FINGERPRINT_MAC_COUNT_RANGE)

  const macHashes: string[] = []
  for (let i = 0; i < macCount; i++) macHashes.push(sha256hex(randHex(32)))

  const machineIdHash = sha256hex(randHex(32))
  const osUserHash = sha256hex(randHex(16))
  const hostnameHash = sha256hex(randHex(16))
  const gitEmailHash = sha256hex(randHex(16))

  const thumbData = [machineIdHash, ...macHashes, osUserHash, hostnameHash, gitEmailHash, 'win32', '10.0.22631', cpuEntry.model, String(cpuEntry.cores), String(memGiB)].join('|')
  const thumbmark = sha256hex(thumbData)

  return {
    thumbmark,
    components: {
      machineIdHash,
      macHashes,
      osUserHash,
      hostnameHash,
      gitEmailHash,
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.22631',
      cpuModel: cpuEntry.model,
      cpuCount: cpuEntry.cores,
      memGiB,
      isContainer: false,
      timezone: tz,
      runtime: 'cli',
      collectorVersion: 1,
    },
  }
}

export interface KeyState {
  fingerprint: Fingerprint
  nextInitAt: number
}

export const keyStateStore = new Map<string, KeyState>()

/** Soft cap for fingerprint states: apiKey is attacker-influenced cardinality.
 *  Evict oldest-inserted when exceeded (Map preserves insertion order). */
export const MAX_KEY_STATES = 100_000

function keyHash(apiKey: string): string {
  try {
    return sha256hex(apiKey).slice(0, 6)
  } catch {
    return 'unknown'
  }
}

export function getOrCreateKeyState(apiKey: string): KeyState {
  let state = keyStateStore.get(apiKey)
  if (!state) {
    // Soft-cap eviction before insert to keep the map bounded.
    if (keyStateStore.size >= MAX_KEY_STATES) {
      const oldest = keyStateStore.keys().next()
      if (!oldest.done) keyStateStore.delete(oldest.value)
    }
    state = {
      fingerprint: generateFingerprint(),
      nextInitAt: 0,
    }
    keyStateStore.set(apiKey, state)
    log('info', 'Fingerprint generated for key', { keyHash: keyHash(apiKey) })
  }
  return state
}

const INIT_REFRESH_MS = 8 * 60 * 60 * 1000
const INIT_JITTER_MS = 2 * 60 * 60 * 1000
/** Failure backoff: retry soon but not hot-loop; randomized 5s..60s. */
const INIT_FAIL_BASE_MS = 5_000
const INIT_FAIL_JITTER_MS = 55_000

const inFlightInit = new Map<string, Promise<void>>()

export interface EnsureInitOptions {
  /** Per-request ZDR flag (e.g. from `x-cmd-zdr: 1` header). Unified with CFG.zdr. */
  zdr?: boolean
}

export async function ensureInitialized(apiKey: string, signal: AbortSignal, opts?: EnsureInitOptions): Promise<void> {
  const state = getOrCreateKeyState(apiKey)
  const now = Date.now()
  if (now < state.nextInitAt) return

  const existing = inFlightInit.get(apiKey)
  if (existing) return existing

  const init = doInit(apiKey, state, signal, opts)
    .catch((e: any) => {
      // Never let a failed init poison callers; the key stays stale and the
      // next request retries after a short backoff (set inside doInit).
      if (e?.name !== 'AbortError') {
        log('warn', 'Fingerprint/lifecycle refresh error, will retry next request', { error: e?.message, keyHash: keyHash(apiKey) })
      }
    })
    .finally(() => {
      if (inFlightInit.get(apiKey) === init) inFlightInit.delete(apiKey)
    })
  inFlightInit.set(apiKey, init)
  return init
}

/** Consume (and discard) a Response body so the socket can be reused.
 *  Must be called for every fingerprint/lifecycle response, ok or not. */
async function consumeBody(r: Response): Promise<void> {
  try {
    // text() drains the stream; catch() covers already-disturbed bodies.
    await r.text().catch(() => {})
  } catch {
    try { await r.body?.cancel().catch(() => {}) } catch {}
  }
}

async function doInit(apiKey: string, state: KeyState, signal: AbortSignal, opts?: EnsureInitOptions): Promise<void> {
  const zdr = CFG.zdr || opts?.zdr === true
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-cli-environment': 'production',
    'Authorization': `Bearer ${apiKey}`,
    'x-command-code-version': CC_VERSION,
    ...(zdr ? { 'x-cmd-zdr': '1' } : {}),
  }
  const fingerprint = state.fingerprint ?? ({} as Fingerprint)

  const record = fetch(`${CFG.apiBase}/alpha/fingerprint/record`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify(fingerprint),
  }).then(async (r) => {
    await consumeBody(r)
    if (!r.ok) {
      log('warn', 'Fingerprint record failed', { status: r.status, keyHash: keyHash(apiKey) })
      return false
    }
    log('info', 'Fingerprint recorded', { keyHash: keyHash(apiKey) })
    return true
  }).catch((e: any) => {
    if (e?.name !== 'AbortError') log('warn', 'Fingerprint record error', { error: e?.message, keyHash: keyHash(apiKey) })
    return e?.name === 'AbortError' ? null : false
  })

  const lifecycle = fetch(`${CFG.apiBase}/alpha/lifecycle-events`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      eventType: 'cli_session_exists',
      metadata: {
        sessionId: `sess_${randHex(8)}`,
        cliVersion: CC_VERSION,
        mode: 'interactive',
        os: `${fingerprint.components?.platform}-${fingerprint.components?.arch}`,
      },
    }),
  }).then(async (r) => {
    await consumeBody(r)
    if (!r.ok) {
      log('warn', 'Lifecycle event failed', { status: r.status, keyHash: keyHash(apiKey) })
      return false
    }
    log('info', 'Lifecycle event sent', { keyHash: keyHash(apiKey) })
    return true
  }).catch((e: any) => {
    if (e?.name !== 'AbortError') log('warn', 'Lifecycle event error', { error: e?.message, keyHash: keyHash(apiKey) })
    return e?.name === 'AbortError' ? null : false
  })

  const [recordOk, lifecycleOk] = await Promise.all([record, lifecycle])

  // Only a full success pushes the 8h window; any failure keeps the key
  // retryable with a short backoff so the next request retries soon.
  if (recordOk === true && lifecycleOk === true) {
    const jitter = Math.floor(Math.random() * INIT_JITTER_MS)
    state.nextInitAt = Date.now() + INIT_REFRESH_MS + jitter
    log('info', 'Fingerprint/lifecycle next refresh', { nextIn: `${(INIT_REFRESH_MS + jitter) / 3600000}h`, keyHash: keyHash(apiKey) })
  } else if (recordOk === null || lifecycleOk === null) {
    // Aborted (client disconnect): keep nextInitAt at 0 so the next real
    // request retries immediately; do not apply failure backoff.
  } else {
    const backoff = INIT_FAIL_BASE_MS + Math.floor(Math.random() * INIT_FAIL_JITTER_MS)
    state.nextInitAt = Date.now() + backoff
    log('info', 'Fingerprint/lifecycle retry scheduled', { backoffMs: backoff, keyHash: keyHash(apiKey) })
  }
}
