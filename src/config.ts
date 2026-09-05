export interface AppConfig {
  port: number
  host: string
  apiBase: string
  projectSlug: string
  apiKey: string
  logFile: string
  logLevel: string
  useProviderModels: boolean
  modelRefreshIntervalMs: number
  zdr: boolean
}

function candidateDirs(): string[] {
  const dirs: string[] = []
  if (import.meta.dir && !import.meta.dir.includes('$bunfs')) {
    dirs.push(import.meta.dir + '/..')
  }
  dirs.push(process.cwd())
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
  return value === undefined ? undefined : Number(value)
}

const envBool = (key: string): boolean | undefined => {
  const value = envString(key)
  if (value === undefined) return undefined
  return value === '1' || value.toLowerCase() === 'true'
}

async function loadConfig(): Promise<AppConfig> {
  const config: AppConfig = {
    port: 3000,
    host: 'localhost',
    apiBase: 'https://api.commandcode.ai',
    projectSlug: 'TMP',
    apiKey: '',
    logFile: '',
    logLevel: 'info',
    useProviderModels: true,
    modelRefreshIntervalMs: 5 * 60 * 1000,
    zdr: false,
  }

  const fileConfig = await findConfigJson()
  if (fileConfig) {
    Object.assign(config, fileConfig)
  }

  if (envNumber('PORT') !== undefined) config.port = envNumber('PORT')!
  if (envString('HOST') !== undefined) config.host = envString('HOST')!
  if (envString('CC_API_BASE') !== undefined) config.apiBase = envString('CC_API_BASE')!
  if (envString('CC_API_KEY') !== undefined) config.apiKey = envString('CC_API_KEY')!
  if (envString('PROJECT_SLUG') !== undefined) config.projectSlug = envString('PROJECT_SLUG')!
  if (envString('LOG_FILE') !== undefined) config.logFile = envString('LOG_FILE')!
  if (envString('LOG_LEVEL') !== undefined) config.logLevel = envString('LOG_LEVEL')!
  if (envBool('CC_USE_PROVIDER_MODELS') !== undefined) config.useProviderModels = envBool('CC_USE_PROVIDER_MODELS')!
  if (envNumber('CC_MODEL_REFRESH_INTERVAL_MS') !== undefined) config.modelRefreshIntervalMs = envNumber('CC_MODEL_REFRESH_INTERVAL_MS')!
  if (envBool('CMD_ZDR') !== undefined) config.zdr = envBool('CMD_ZDR')!

  return config
}

export const CFG = await loadConfig()

export const MAX_BODY_SIZE = (() => {
  const mb = envNumber('CC_MAX_BODY_MB')
  return mb !== undefined && mb > 0 ? mb * 1024 * 1024 : 100 * 1024 * 1024
})()
