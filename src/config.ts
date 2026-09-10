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
    // Source runs (bun run / bun test): project root sits one level above src/.
    if (import.meta.dir && !import.meta.dir.includes('$bunfs')) {
      dirs.push(import.meta.dir + '/..')
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
        console.error('[config] Failed to parse config.json:', e.message)
        return null
      }
    }
  }
  return null
}

export interface AppConfigWithSource extends AppConfig {
  configPath?: string
}

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

const envBool = (key: string): boolean | undefined => {
  const value = envString(key)
  if (value === undefined) return undefined
  return value === '1' || value.toLowerCase() === 'true'
}

const envBoolDefaultTrue = (key: string): boolean | undefined => {
  const value = envString(key)
  if (value === undefined) return undefined
  const v = value.toLowerCase()
  if (v === 'false' || v === '0' || v === 'no') return false
  return true
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
    emptySystemPlaceholder: true,
  }

  const fileConfig = await findConfigJson()
  if (fileConfig) {
    Object.assign(config, fileConfig)
  }

  if (!Number.isFinite(config.port) || config.port <= 0) {
    die('config.json "port" must be a positive number')
  }
  if (!Number.isFinite(config.modelRefreshIntervalMs) || config.modelRefreshIntervalMs < 0) {
    die('config.json "modelRefreshIntervalMs" must be a non-negative number')
  }

  if (envNumber('PORT') !== undefined) config.port = envNumber('PORT')!
  if (envString('HOST') !== undefined) config.host = envString('HOST')!
  if (envString('CC_API_BASE') !== undefined) config.apiBase = envString('CC_API_BASE')!
  if (envString('CC_API_KEY') !== undefined) config.apiKey = envString('CC_API_KEY')!
  if (envString('CORS_ALLOW_ORIGIN') !== undefined) config.corsAllowOrigin = envString('CORS_ALLOW_ORIGIN')!
  if (envString('LOG_FILE') !== undefined) config.logFile = envString('LOG_FILE')!
  if (envString('LOG_LEVEL') !== undefined) config.logLevel = envString('LOG_LEVEL')!
  if (envBool('CC_USE_PROVIDER_MODELS') !== undefined) config.useProviderModels = envBool('CC_USE_PROVIDER_MODELS')!
  if (envNumber('CC_MODEL_REFRESH_INTERVAL_MS') !== undefined) config.modelRefreshIntervalMs = envNumber('CC_MODEL_REFRESH_INTERVAL_MS')!
  if (envBool('CMD_ZDR') !== undefined) config.zdr = envBool('CMD_ZDR')!
  if (envBoolDefaultTrue('CC_EMPTY_SYSTEM_PLACEHOLDER') !== undefined) config.emptySystemPlaceholder = envBoolDefaultTrue('CC_EMPTY_SYSTEM_PLACEHOLDER')!

  return config
}

export const CFG = await loadConfig()

export const MAX_BODY_SIZE = (() => {
  const mb = envNumber('CC_MAX_BODY_MB')
  return mb !== undefined && mb > 0 ? mb * 1024 * 1024 : 100 * 1024 * 1024
})()

export const STREAM_IDLE_TIMEOUT_MS = (() => {
  const v = envNumber('CC_STREAM_IDLE_MS')
  return v !== undefined && v > 0 ? v : 30_000
})()
export const NONSTREAM_IDLE_TIMEOUT_MS = (() => {
  const v = envNumber('CC_NONSTREAM_IDLE_MS')
  return v !== undefined && v > 0 ? v : 90_000
})()
