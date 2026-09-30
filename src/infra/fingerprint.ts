import { CFG } from '../shared/config'
import { log } from '../shared/logger'
import { generateSessionId, pick, randHex, sha256hex } from '../shared/util'
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

// 官方指纹盐（bundle 内 Ub）：thumbmark 与每个组件哈希都由它派生。
const FP_SALT = 'command-code:device-fingerprint:v1'

/** 官方组件哈希公式：sha256(salt + "\0" + value.trim().toLowerCase())。
 *  空值 → undefined（官方 filter(Boolean) 语义）。 */
function fpHash(value: string): string | undefined {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return undefined
  return sha256hex(`${FP_SALT}\0${v}`)
}

/** 生成与官方 CLI 同公式的指纹。
 *
 *  官方 thumbmark = sha256(salt + "\0machine\0" + parts.join("|") || "unknown")，
 *  parts = [machineId, 排序去重小写MAC.join(","), machineId 为空时的 hostname,
 *  machineId 为空时的 cpuModel]；components 各项是上面 fpHash 的结果。
 *  本地没有真实设备信号，用随机但形状正确的值合成，关键是保持
 *  thumbmark 与 components 的内部一致性（上游可重算校验）。 */
export function generateFingerprint(): Fingerprint {
  const cpuEntry = pick(FINGERPRINT_CPUS)
  const memGiB = pick(FINGERPRINT_MEMS)
  const tz = pick(FINGERPRINT_TZS)
  const macCount = pick(FINGERPRINT_MAC_COUNT_RANGE)

  const machineId = randHex(16)
  const macs = Array.from({ length: macCount }, () => (randHex(6).match(/../g) ?? []).join(':'))
  const osUser = `dev${randHex(2)}`
  const hostname = `dev-pc-${randHex(3)}`
  const gitEmail = `dev${randHex(2)}@example.com`
  const cpuModel = cpuEntry.model

  const uniqueSortedMacs = [...new Set(macs.map((m) => m.toLowerCase()))].filter(Boolean).sort()
  const machineIdTrimmed = machineId.trim()
  // machineId 非空时 hostname/cpuModel 不参与 thumbmark —— 与官方条件一致。
  const parts = [
    machineIdTrimmed,
    uniqueSortedMacs.join(','),
    machineIdTrimmed ? '' : hostname.trim(),
    machineIdTrimmed ? '' : cpuModel.trim(),
  ].filter(Boolean)
  const thumbmark = sha256hex(`${FP_SALT}\0machine\0${parts.join('|') || 'unknown'}`)

  return {
    thumbmark,
    components: {
      machineIdHash: fpHash(machineId) ?? '',
      macHashes: uniqueSortedMacs.map((m) => fpHash(m)).filter((h): h is string => !!h),
      osUserHash: fpHash(osUser) ?? '',
      hostnameHash: fpHash(hostname) ?? '',
      gitEmailHash: fpHash(gitEmail) ?? '',
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.22631',
      cpuModel,
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

// Lifecycle 事件的一次性标记（进程级）：官方 CLI 的 cli_installed /
// cli_first_message 一个安装周期只发一次，cli_session_exists 每次启动都发。
let installedReported = false
let firstMessageReported = false

interface LifecycleEvent {
  eventType: string
  metadata: Record<string, unknown>
}

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
    // User-Agent 是官方 CLI 的必备身份头（bundle 内 buildCommandAuthHeaders 固定
    // 发 "cli"）；缺失会被 Cloudflare 以 403 Error 1010 拦截（cc-manage SPEC 实测）。
    'User-Agent': 'cli',
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

  // 官方 eventType 全集：cli_installed / cli_session_exists / cli_first_message /
  // cli_updated（后者只在自动更新后触发，反代无更新动作故不发）。
  const sessionId = generateSessionId()
  const events: LifecycleEvent[] = []
  if (!installedReported) events.push({ eventType: 'cli_installed', metadata: { cliVersion: CC_VERSION } })
  events.push({
    eventType: 'cli_session_exists',
    metadata: {
      sessionId,
      cliVersion: CC_VERSION,
      mode: 'interactive',
      os: `${fingerprint.components?.platform}-${fingerprint.components?.arch}`,
    },
  })
  if (!firstMessageReported) events.push({ eventType: 'cli_first_message', metadata: {} })

  const sendLifecycle = (evt: LifecycleEvent): Promise<{ eventType: string; ok: boolean | null }> =>
    fetch(`${CFG.apiBase}/alpha/lifecycle-events`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({ eventType: evt.eventType, metadata: evt.metadata }),
    }).then(async (r) => {
      await consumeBody(r)
      if (!r.ok) {
        log('warn', 'Lifecycle event failed', { status: r.status, eventType: evt.eventType, keyHash: keyHash(apiKey) })
        return { eventType: evt.eventType, ok: false }
      }
      log('info', 'Lifecycle event sent', { eventType: evt.eventType, keyHash: keyHash(apiKey) })
      return { eventType: evt.eventType, ok: true }
    }).catch((e: any) => {
      if (e?.name !== 'AbortError') {
        log('warn', 'Lifecycle event error', { eventType: evt.eventType, error: e?.message, keyHash: keyHash(apiKey) })
      }
      return { eventType: evt.eventType, ok: e?.name === 'AbortError' ? null : false }
    })

  const lifecycle = Promise.all(events.map(sendLifecycle))

  const [recordOk, lifecycleResults] = await Promise.all([record, lifecycle])
  const lifecycleOk: boolean | null = lifecycleResults.every((r) => r.ok === true)
    ? true
    : lifecycleResults.some((r) => r.ok === null)
      ? null
      : false

  // 只有成功发出的事件才标记为“已上报”，失败留待下次 init 重试。
  for (const r of lifecycleResults) {
    if (r.ok !== true) continue
    if (r.eventType === 'cli_installed') installedReported = true
    if (r.eventType === 'cli_first_message') firstMessageReported = true
  }

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
