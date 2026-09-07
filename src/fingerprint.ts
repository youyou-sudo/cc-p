import { CFG } from './config'
import { log } from './logger'
import { pick, randHex, sha256hex } from './util'
import { CC_VERSION } from './version'

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
  lastUsedAt: number
}

const KEY_STATE_TTL_MS = 24 * 60 * 60 * 1000
const KEY_STATE_MAX_ENTRIES = 10_000

export const keyStateStore = new Map<string, KeyState>()

export function getOrCreateKeyState(apiKey: string): KeyState {
  const now = Date.now()
  let state = keyStateStore.get(apiKey)
  if (!state) {
    state = {
      fingerprint: generateFingerprint(),
      nextInitAt: 0,
      lastUsedAt: now,
    }
    keyStateStore.set(apiKey, state)
    log('info', 'Fingerprint generated for key', { keyPrefix: apiKey.slice(0, 8) })
    return state
  }
  state.lastUsedAt = now
  keyStateStore.delete(apiKey)
  keyStateStore.set(apiKey, state)
  return state
}

export function pruneKeyStates(): number {
  const now = Date.now()
  let removed = 0
  for (const [key, state] of keyStateStore) {
    if (now - state.lastUsedAt > KEY_STATE_TTL_MS) {
      keyStateStore.delete(key)
      removed++
    }
  }
  while (keyStateStore.size > KEY_STATE_MAX_ENTRIES) {
    const oldest = keyStateStore.keys().next().value
    if (oldest === undefined) break
    keyStateStore.delete(oldest)
    removed++
  }
  return removed
}

export function startKeyStateCleanup(): void {
  setInterval(() => {
    const removed = pruneKeyStates()
    if (removed > 0) log('info', 'Key state cleanup', { removed, remaining: keyStateStore.size })
  }, 60 * 60 * 1000)
}

const INIT_REFRESH_MS = 8 * 60 * 60 * 1000
const INIT_JITTER_MS = 2 * 60 * 60 * 1000

const inFlightInit = new Map<string, Promise<void>>()

export async function ensureInitialized(apiKey: string, signal: AbortSignal): Promise<void> {
  const state = getOrCreateKeyState(apiKey)
  const now = Date.now()
  if (now < state.nextInitAt) return

  const existing = inFlightInit.get(apiKey)
  if (existing) return existing

  const init = doInit(apiKey, state, signal)
    .catch((e: any) => {
      // Never let a failed init poison callers; the key stays stale and the
      // next request retries.
      if (e?.name !== 'AbortError') {
        log('warn', 'Fingerprint/lifecycle refresh error, will retry next request', { error: e?.message })
      }
    })
    .finally(() => {
      if (inFlightInit.get(apiKey) === init) inFlightInit.delete(apiKey)
    })
  inFlightInit.set(apiKey, init)
  return init
}

async function doInit(apiKey: string, state: KeyState, signal: AbortSignal): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-cli-environment': 'production',
    'Authorization': `Bearer ${apiKey}`,
    'x-command-code-version': CC_VERSION,
    ...(CFG.zdr ? { 'x-cmd-zdr': '1' } : {}),
  }
  const fingerprint = state.fingerprint ?? ({} as Fingerprint)

  const record = fetch(`${CFG.apiBase}/alpha/fingerprint/record`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify(fingerprint),
  }).then((r) => {
    if (!r.ok) log('warn', 'Fingerprint record failed', { status: r.status })
    else log('info', 'Fingerprint recorded')
  }).catch((e: any) => {
    if (e.name !== 'AbortError') log('warn', 'Fingerprint record error', { error: e.message })
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
  }).then((r) => {
    if (!r.ok) log('warn', 'Lifecycle event failed', { status: r.status })
    else log('info', 'Lifecycle event sent')
  }).catch((e: any) => {
    if (e.name !== 'AbortError') log('warn', 'Lifecycle event error', { error: e.message })
  })

  await Promise.all([record, lifecycle])

  const jitter = Math.floor(Math.random() * INIT_JITTER_MS)
  state.nextInitAt = Date.now() + INIT_REFRESH_MS + jitter
  log('info', 'Fingerprint/lifecycle next refresh', { nextIn: `${(INIT_REFRESH_MS + jitter) / 3600000}h` })
}
