import { CFG } from './config'
import { log } from './logger'
import { CC_VERSION } from './version'
import { getApiKey } from './auth'
import { nowUnix } from './util'
import { sendJSON } from './http'

export interface ModelEntry {
  id: string
  name: string
  context_window?: number
  max_output_tokens?: number
}

export const MODELS: ModelEntry[] = [
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', context_window: 200000 },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', context_window: 200000 },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', context_window: 200000 },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', context_window: 200000 },
  { id: 'gpt-5.5', name: 'GPT-5.5', context_window: 400000 },
  { id: 'gpt-5.4', name: 'GPT-5.4', context_window: 400000 },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', context_window: 400000 },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', context_window: 400000 },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', context_window: 131072 },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', context_window: 65536 },
  // TODO(confirm): 以下模型公开 context_window 待确认，暂不填确定值
  { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6' },
  { id: 'moonshotai/Kimi-K2.5', name: 'Kimi K2.5' },
  { id: 'zai-org/GLM-5.1', name: 'GLM 5.1' },
  { id: 'zai-org/GLM-5', name: 'GLM 5' },
  { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3' },
  { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7' },
  { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5' },
  { id: 'Qwen/Qwen3.6-Max-Preview', name: 'Qwen 3.6 Max Preview' },
  { id: 'Qwen/Qwen3.6-Plus', name: 'Qwen 3.6 Plus' },
  { id: 'Qwen/Qwen3.7-Max', name: 'Qwen 3.7 Max' },
  { id: 'stepfun/Step-3.7-Flash', name: 'Step 3.7 Flash' },
  { id: 'stepfun/Step-3.5-Flash', name: 'Step 3.5 Flash' },
  { id: 'xiaomi/mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
  { id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5' },
  { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash', context_window: 1048576 },
  { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', context_window: 1048576 },
]

function toOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function pickContextWindow(m: any): number | undefined {
  return toOptionalNumber(m.context_window ?? m.context_length ?? m.max_context_tokens)
}

function pickMaxOutputTokens(m: any): number | undefined {
  return toOptionalNumber(m.max_output_tokens ?? m.max_tokens)
}

const STATIC_WINDOW_BY_ID = new Map<string, number>(
  MODELS.filter((m) => m.context_window !== undefined).map((m) => [m.id, m.context_window as number]),
)

let dynamicModels: ModelEntry[] | null = null
let modelsLastFetch = 0

export async function fetchModels(apiKey?: string | null): Promise<ModelEntry[]> {
  const now = Date.now()
  if (dynamicModels && now - modelsLastFetch < CFG.modelRefreshIntervalMs) {
    return dynamicModels
  }

  try {
    if (!apiKey || !CFG.useProviderModels) throw new Error('Provider models disabled')

    const response = await fetch(`${CFG.apiBase}/provider/v1/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'x-cli-environment': 'production',
        'x-command-code-version': CC_VERSION,
      },
      signal: AbortSignal.timeout(10000),
    })

    if (response.ok) {
      const data: any = await response.json()
      if (Array.isArray(data.data)) {
        const models: ModelEntry[] = data.data.map((m: any) => {
          const entry: ModelEntry = { id: m.id, name: m.id }
          const upstreamWindow = pickContextWindow(m)
          entry.context_window = upstreamWindow ?? STATIC_WINDOW_BY_ID.get(m.id)
          const maxOut = pickMaxOutputTokens(m)
          if (maxOut !== undefined) entry.max_output_tokens = maxOut
          if (entry.context_window === undefined) delete entry.context_window
          return entry
        })
        dynamicModels = models
        modelsLastFetch = now
        log('info', 'Fetched models from Provider API', { count: models.length })
        return models
      }
    }
    log('warn', 'Provider models fetch failed, using hardcoded list', { status: response.status })
  } catch (e: any) {
    log('warn', 'Provider models fetch error, using hardcoded list', { error: e.message })
  }

  return MODELS
}

export async function handleModels(headers: Record<string, string | undefined>): Promise<Response> {
  const apiKey = getApiKey(headers)
  const models = await fetchModels(apiKey)
  const now = nowUnix()
  return sendJSON(200, {
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      created: now,
      owned_by: 'command-code',
      ...(m.context_window !== undefined ? { context_window: m.context_window } : {}),
    })),
  })
}
