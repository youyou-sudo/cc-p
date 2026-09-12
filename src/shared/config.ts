// Layer: kernel（底层，可被所有人依赖，自己只依赖 kernel）
export interface AppConfig {
  port: number
  host: string
  apiBase: string
  apiKey: string
  corsAllowOrigin: string
  logFile: string
  logLevel: string
  useProviderModels: boolean
  modelRefreshIntervalMs: number
  zdr: boolean
  maxConcurrencyPerKey: number
  maxQueuePerKey: number
  queueTimeoutMs: number
  retryMax: number
  retryBaseMs: number
  retryCapMs: number
  emptySystemPlaceholder: boolean
}

function die(message: string): never {
  console.error(`[config] ${message}`)
  process.exit(1)
}

function candidateDirs(): string[] {
  const dirs: string[] = []
  if (Bun.isStandaloneExecutable) {
    // Standalone binaries (Release artifacts / Docker): a real config.json next
    // to the executable (process.cwd()) wins; otherwise fall back to the copy
    // embedded via `--asset config.json` (older builds), which lives at
    // import.meta.dir (e.g. /$bunfs/root on Linux, B:\~BUN\root on Windows).
    dirs.push(process.cwd())
    if (import.meta.dir) dirs.push(import.meta.dir)
  } else {
    // Source runs (bun run / bun test): project root sits two levels above src/shared/.
    if (import.meta.dir && !import.meta.dir.includes('$bunfs')) {
      dirs.push(import.meta.dir + '/../..')
    }
    dirs.push(process.cwd())
  }
  return dirs
}

async function findConfigJson(): Promise<Record<string, any> | null> {
  for (const dir of candidateDirs()) {
    const file = Bun.file(`${dir.replace(/[\\/]+$/, '')}/config.json`)
    if (await file.exists()) {
      try {
        return JSON.parse(await file.text()) as Record<string, any>
      } catch (e: any) {
        // 解析失败必须 die() 退出：静默回默认会掩盖手误（缺逗号/注释/截断写入），
        // 导致线上跑着错误配置。只有“文件缺失”才允许用默认 + info。
        die(`Failed to parse config.json: ${e?.message ?? String(e)}`)
      }
    }
  }
  return null
}

export interface AppConfigWithSource extends AppConfig {
  configPath?: string
}

// ── env 读取语义（统一 0/空约定，逐项注释见 loadConfig 调用处） ──
// envString: undefined/'' 视为“未设置”，返回 undefined（调用方保留文件值/默认值）。
// 注意 '   '（纯空白）不视为空，由各字段校验器按“非空”规则 die，避免静默接受。
const envString = (key: string): string | undefined => {
  const value = process.env[key]
  return value === undefined || value === '' ? undefined : value
}

const envNumber = (key: string): number | undefined => {
  const value = envString(key)
  if (value === undefined) return undefined
  const num = Number(value)
  if (!Number.isFinite(num)) die(`Invalid numeric value for ${key}: '${value}'`)
  return num
}

// ── envBool 严格解析（修复旧 envBool/envBoolDefaultTrue 双标陷阱） ──
// 旧陷阱：envBool 把 'yes'/'on'/'garbage' 全判 false；envBoolDefaultTrue 把
// 'garbage'/'' 以外全判 true。现统一：1/true/yes/on→true，0/false/no/off→false
// （大小写不敏感，前后 trim），其他一律 die。空/未设置返回 undefined（保留默认）。
const BOOL_TRUE = new Set(['1', 'true', 'yes', 'on'])
const BOOL_FALSE = new Set(['0', 'false', 'no', 'off'])

function parseBoolStrict(key: string, raw: string): boolean {
  const v = raw.trim().toLowerCase()
  if (BOOL_TRUE.has(v)) return true
  if (BOOL_FALSE.has(v)) return false
  die(`Invalid boolean value for ${key}: '${raw}' (expected one of 1/true/yes/on/0/false/no/off)`)
}

const envBool = (key: string): boolean | undefined => {
  const value = envString(key)
  if (value === undefined) return undefined
  return parseBoolStrict(key, value)
}

// ── zod-free 手写 schema（未知键 warn+忽略，类型错 die） ──
type FieldType = 'number' | 'string' | 'boolean'
const FILE_SCHEMA: Record<keyof AppConfig, FieldType> = {
  port: 'number',
  host: 'string',
  apiBase: 'string',
  apiKey: 'string',
  corsAllowOrigin: 'string',
  logFile: 'string',
  logLevel: 'string',
  useProviderModels: 'boolean',
  modelRefreshIntervalMs: 'number',
  zdr: 'boolean',
  maxConcurrencyPerKey: 'number',
  maxQueuePerKey: 'number',
  queueTimeoutMs: 'number',
  retryMax: 'number',
  retryBaseMs: 'number',
  retryCapMs: 'number',
  emptySystemPlaceholder: 'boolean',
}

function applyFileConfig(config: AppConfig, fileConfig: Record<string, any>): void {
  for (const key of Object.keys(fileConfig)) {
    if (!(key in FILE_SCHEMA)) {
      // 未知键：warn + 忽略（不 Object.assign），防止拼写错误静默生效。
      console.warn(`[config] Unknown config.json key '${key}' ignored`)
      continue
    }
    const expected = FILE_SCHEMA[key as keyof AppConfig]
    const value = fileConfig[key]
    if (typeof value !== expected) {
      die(`config.json "${key}" must be ${expected}, got ${typeof value}`)
    }
    ;(config as any)[key] = value
  }
}

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const API_KEY_PATTERN = /^user_[A-Za-z0-9_-]+$/

function assertPort(value: number, source: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    die(`${source} "port" must be an integer 1-65535, got '${value}'`)
  }
}

function assertHost(value: string, source: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    die(`${source} "host" must be a non-empty string`)
  }
}

function normalizeApiBase(value: unknown, source: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    die(`${source} "apiBase" must be a non-empty URL string`)
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    die(`${source} "apiBase" must be a valid URL, got '${value}'`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    die(`${source} "apiBase" must use http(s), got '${url.protocol}'`)
  }
  // 归一化：去尾斜杠（https://x/ → https://x），避免下游拼接出双斜杠。
  return url.toString().replace(/\/+$/, '')
}

function normalizeLogLevel(value: unknown, source: string): string {
  if (typeof value !== 'string') die(`${source} "logLevel" must be a string`)
  const v = (value as string).trim().toLowerCase()
  if (!LOG_LEVELS.has(v)) {
    die(`${source} "logLevel" must be one of debug/info/warn/error, got '${value}'`)
  }
  return v
}

function assertApiKey(value: string, source: string): void {
  // 空串 = 不启用兜底（允许）；非空必须符合 user_ base64url 格式，否则 die
  //（早失败，避免带错 key 启动后全量 401/上游拒收）。
  if (value === '') return
  if (!API_KEY_PATTERN.test(value.trim())) {
    die(`${source} "CC_API_KEY/apiKey" has invalid format: expected "user_" + base64url, got '${String(value).slice(0, 16)}…'`)
  }
}

async function loadConfig(): Promise<AppConfig> {
  // Builtin defaults. These match the tracked config.json (which is baked into
  // Docker images / Release binaries), so every distribution shares one truth.
  const config: AppConfig = {
    port: 3050,
    host: '0.0.0.0',
    apiBase: 'https://api.commandcode.ai',
    apiKey: '',
    corsAllowOrigin: '',
    logFile: '',
    logLevel: 'info',
    useProviderModels: true,
    modelRefreshIntervalMs: 5 * 60 * 1000,
    zdr: false,
    maxConcurrencyPerKey: 16,
    maxQueuePerKey: 64,
    queueTimeoutMs: 60_000,
    retryMax: 3,
    retryBaseMs: 1_000,
    retryCapMs: 30_000,
    emptySystemPlaceholder: true,
  }

  const fileConfig = await findConfigJson()
  if (fileConfig) {
    applyFileConfig(config, fileConfig)
  } else {
    // 缺文件才用默认：info 一条，避免与“解析失败 die”混淆。
    console.info('[config] config.json not found, using builtins + env')
  }

  if (!Number.isFinite(config.port) || config.port <= 0) {
    die('config.json "port" must be a positive number')
  }
  if (!Number.isFinite(config.modelRefreshIntervalMs) || config.modelRefreshIntervalMs < 0) {
    die('config.json "modelRefreshIntervalMs" must be a non-negative number')
  }
  const mustBePositiveInt = (name: keyof AppConfig, value: number) => {
    if (!Number.isFinite(value) || value <= 0) die(`config.json "${name}" must be a positive number`)
  }
  mustBePositiveInt('maxConcurrencyPerKey', config.maxConcurrencyPerKey)
  mustBePositiveInt('maxQueuePerKey', config.maxQueuePerKey)
  mustBePositiveInt('queueTimeoutMs', config.queueTimeoutMs)
  if (!Number.isFinite(config.retryMax) || config.retryMax < 0) {
    die('config.json "retryMax" must be a non-negative number')
  }
  mustBePositiveInt('retryBaseMs', config.retryBaseMs)
  mustBePositiveInt('retryCapMs', config.retryCapMs)

  // ── env 覆盖（0/空语义逐项注释；空/未设置一律保留当前值） ──
  // PORT: 空→保留；0/越界/非整数→die（1-65535）。
  const envPort = envNumber('PORT')
  if (envPort !== undefined) {
    assertPort(envPort, 'env')
    config.port = envPort
  }
  // HOST: 空→保留；空白串→die（HOST 非空）。
  if (envString('HOST') !== undefined) {
    const h = envString('HOST')!
    assertHost(h, 'env')
    config.host = h
  }
  // CC_API_BASE: 空→保留；非法 URL/非 http(s)→die；归一化去尾斜杠。
  if (envString('CC_API_BASE') !== undefined) {
    config.apiBase = normalizeApiBase(envString('CC_API_BASE')!, 'env')
  }
  // CC_API_KEY: 空→保留（''=无兜底，允许）；非空非法格式→die。
  if (envString('CC_API_KEY') !== undefined) {
    const k = envString('CC_API_KEY')!
    assertApiKey(k, 'env')
    config.apiKey = k
  }
  // CORS_ALLOW_ORIGIN: 空→保留（''=按有无兜底自动策略）；非空原样接受。
  if (envString('CORS_ALLOW_ORIGIN') !== undefined) config.corsAllowOrigin = envString('CORS_ALLOW_ORIGIN')!
  // LOG_FILE: 空→保留（''=仅控制台）；非空为路径原样接受。
  if (envString('LOG_FILE') !== undefined) config.logFile = envString('LOG_FILE')!
  // LOG_LEVEL: 空→保留；非法→die（白名单 debug/info/warn/error，大小写不敏感归一小写）。
  if (envString('LOG_LEVEL') !== undefined) config.logLevel = normalizeLogLevel(envString('LOG_LEVEL')!, 'env')
  // CC_USE_PROVIDER_MODELS: 空→保留默认 true；严格 bool，非法 die。
  if (envBool('CC_USE_PROVIDER_MODELS') !== undefined) config.useProviderModels = envBool('CC_USE_PROVIDER_MODELS')!
  // CC_MODEL_REFRESH_INTERVAL_MS: 空→保留；0 允许（=每次都拉取）；负数→die。
  if (envNumber('CC_MODEL_REFRESH_INTERVAL_MS') !== undefined) {
    const v = envNumber('CC_MODEL_REFRESH_INTERVAL_MS')!
    if (v < 0) die(`Invalid value for CC_MODEL_REFRESH_INTERVAL_MS: must be non-negative, got '${process.env.CC_MODEL_REFRESH_INTERVAL_MS}'`)
    config.modelRefreshIntervalMs = v
  }
  // CMD_ZDR: 空→保留默认 false；严格 bool，非法 die。
  if (envBool('CMD_ZDR') !== undefined) config.zdr = envBool('CMD_ZDR')!
  // CC_EMPTY_SYSTEM_PLACEHOLDER: 空→保留默认 true；严格 bool，非法 die。
  if (envBool('CC_EMPTY_SYSTEM_PLACEHOLDER') !== undefined) config.emptySystemPlaceholder = envBool('CC_EMPTY_SYSTEM_PLACEHOLDER')!
  // CC_MAX_CONCURRENCY_PER_KEY: 空→保留；0/负数→die（必须为正）。
  if (envNumber('CC_MAX_CONCURRENCY_PER_KEY') !== undefined) {
    const v = envNumber('CC_MAX_CONCURRENCY_PER_KEY')!
    if (v <= 0) die(`Invalid value for CC_MAX_CONCURRENCY_PER_KEY: must be positive, got '${process.env.CC_MAX_CONCURRENCY_PER_KEY}'`)
    config.maxConcurrencyPerKey = v
  }
  // CC_MAX_QUEUE_PER_KEY: 空→保留；0/负数→die（必须为正；0 队列=直接拒绝，请显式配小值而非 0）。
  if (envNumber('CC_MAX_QUEUE_PER_KEY') !== undefined) {
    const v = envNumber('CC_MAX_QUEUE_PER_KEY')!
    if (v <= 0) die(`Invalid value for CC_MAX_QUEUE_PER_KEY: must be positive, got '${process.env.CC_MAX_QUEUE_PER_KEY}'`)
    config.maxQueuePerKey = v
  }
  // CC_QUEUE_TIMEOUT_MS: 空→保留；0/负数→die（必须为正）。
  if (envNumber('CC_QUEUE_TIMEOUT_MS') !== undefined) {
    const v = envNumber('CC_QUEUE_TIMEOUT_MS')!
    if (v <= 0) die(`Invalid value for CC_QUEUE_TIMEOUT_MS: must be positive, got '${process.env.CC_QUEUE_TIMEOUT_MS}'`)
    config.queueTimeoutMs = v
  }
  // CC_RETRY_MAX: 空→保留；0 允许（=不重试）；负数→die；向下取整。
  if (envNumber('CC_RETRY_MAX') !== undefined) {
    const v = envNumber('CC_RETRY_MAX')!
    if (v < 0) die(`Invalid value for CC_RETRY_MAX: must be non-negative, got '${process.env.CC_RETRY_MAX}'`)
    config.retryMax = Math.floor(v)
  }
  // CC_RETRY_BASE_MS: 空→保留；0/负数→die（必须为正）。
  if (envNumber('CC_RETRY_BASE_MS') !== undefined) {
    const v = envNumber('CC_RETRY_BASE_MS')!
    if (v <= 0) die(`Invalid value for CC_RETRY_BASE_MS: must be positive, got '${process.env.CC_RETRY_BASE_MS}'`)
    config.retryBaseMs = v
  }
  // CC_RETRY_CAP_MS: 空→保留；0/负数→die（必须为正）。
  if (envNumber('CC_RETRY_CAP_MS') !== undefined) {
    const v = envNumber('CC_RETRY_CAP_MS')!
    if (v <= 0) die(`Invalid value for CC_RETRY_CAP_MS: must be positive, got '${process.env.CC_RETRY_CAP_MS}'`)
    config.retryCapMs = v
  }

  // ── 合并后最终校验（文件+env 统一收口；非法 die） ──
  assertPort(config.port, 'config')
  assertHost(config.host, 'config')
  config.apiBase = normalizeApiBase(config.apiBase, 'config')
  config.logLevel = normalizeLogLevel(config.logLevel, 'config')
  assertApiKey(config.apiKey, 'config')

  return config
}

export const CFG = await loadConfig()

export const MAX_BODY_SIZE = (() => {
  // 快照时机：模块加载时读取一次（CFG 已顶层 await 就绪之后）。0/空/负→默认 100MB；
  // 非数字由 envNumber die。运行时改 env 不生效，需重启。
  const mb = envNumber('CC_MAX_BODY_MB')
  return mb !== undefined && mb > 0 ? mb * 1024 * 1024 : 100 * 1024 * 1024
})()

export const STREAM_IDLE_TIMEOUT_MS = (() => {
  // 0/空/负→默认 30s；非数字 die。0 不代表“无限”，统一回默认。
  const v = envNumber('CC_STREAM_IDLE_MS')
  return v !== undefined && v > 0 ? v : 30_000
})()
export const NONSTREAM_IDLE_TIMEOUT_MS = (() => {
  // 0/空/负→默认 90s；非数字 die。
  const v = envNumber('CC_NONSTREAM_IDLE_MS')
  return v !== undefined && v > 0 ? v : 90_000
})()
// 容忍 reasoning 长 prefill / 首 token 停顿，默认 120s；设 0/空回默认，非法数字沿用 die()。
export const THINKING_IDLE_TIMEOUT_MS = (() => {
  const v = envNumber('CC_THINKING_IDLE_MS')
  return v !== undefined && v > 0 ? v : 120_000
})()
