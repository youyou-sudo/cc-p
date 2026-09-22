import { CFG } from '../../shared/config'
import { log } from '../../shared/logger'
import { CC_VERSION } from '../../shared/version'
import { getApiKey } from '../../shared/auth'
import { nowUnix } from '../../shared/util'
import { sendJSON } from '../../shared/http'

export interface ModelEntry {
  id: string
  name: string
  context_window?: number
  max_output_tokens?: number
  /** 该模型允许的 reasoning_effort 档位（官方档位全集 low|medium|high|xhigh|max）。
   *  来自官方 models.md 权威表；上游 provider 列表不提供，缺失即不暴露。 */
  reasoning_efforts?: string[]
  // vision 归一化字段：上游透传保留，缺失则默认 text+image（见 VISION_DEFAULT_MODALITIES）。
  modalities?: string[]
  input_modalities?: string[]
  capabilities?: Record<string, unknown> | string[]
}

// 为什么默认全系 vision：上游 CC 的 image 分片是通用透传
// （src/infra/cc.ts image_url→{type:image} 无条件），不按模型名黑白名单卡控。
// 若上游显式声明了 modalities/capabilities 则保留归一，否则默认 text+image。
export const VISION_DEFAULT_MODALITIES = ['text', 'image'] as const

function hasVision(m: any): boolean {
  if (!m || typeof m !== 'object') return false
  const mods: unknown[] = [m.modalities, m.input_modalities, m.supported_modalities, m.output_modalities]
  for (const v of mods) {
    if (Array.isArray(v) && v.map(String).map((s: string) => s.toLowerCase()).includes('image')) return true
  }
  const caps = m.capabilities
  if (Array.isArray(caps) && caps.map(String).map((s: string) => s.toLowerCase()).some((s: string) => s.includes('vision') || s.includes('image'))) return true
  if (caps && typeof caps === 'object' && ((caps as any).vision === true || (caps as any).image === true)) return true
  if (m.supports_vision === true || m.vision === true) return true
  if (Array.isArray(m.features) && m.features.map(String).map((s: string) => s.toLowerCase()).includes('vision')) return true
  return false
}

function pickModalities(m: any): string[] {
  const raw = m.modalities ?? m.input_modalities ?? m.supported_modalities
  if (Array.isArray(raw) && raw.length > 0) {
    const norm = [...new Set(raw.map(String).map((s: string) => s.toLowerCase()))]
    if (!norm.includes('text')) norm.unshift('text')
    // 上游显式声明了 modalities：若含 image/vision 能力则补齐 image，否则原样保留
    //（避免把纯文本模型误标 vision）；上游完全没声明时由调用方默认 text+image。
    if (hasVision(m) && !norm.includes('image')) norm.push('image')
    return norm
  }
  // 上游无声明：默认全系 vision（通用透传）。
  return [...VISION_DEFAULT_MODALITIES]
}

export const MODELS: ModelEntry[] = [
  // 静态回退目录。数值来自官方 CLI 内置的 models.md 权威表（1.62.1 包内
  // dist/bundled/command-code-knowledge/reference/models.md：Context / Efforts /
  // Min plan）。静态值优先于上游 provider 列表（见下文 STATIC_WINDOW_BY_ID），
  // 因此这里填错会直接污染动态目录 —— 修复前 deepseek/claude 系被压到
  // 64K/128K/200K，官方实际是 1M。
  // Anthropic
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-5', name: 'Claude Opus 5', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-fable-5', name: 'Claude Fable 5', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', context_window: 200000 },
  // OpenAI
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', context_window: 1050000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', context_window: 1050000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', context_window: 1050000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', context_window: 1050000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.5', name: 'GPT-5.5', context_window: 400000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.4', name: 'GPT-5.4', context_window: 400000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', context_window: 400000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', context_window: 400000, reasoning_efforts: ['low', 'medium', 'high'] },
  // DeepSeek
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', context_window: 1048576, reasoning_efforts: ['high', 'max'] },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', context_window: 1048576, reasoning_efforts: ['high', 'max'] },
  { id: 'deepseek/deepseek-v4-flash-fast', name: 'DeepSeek V4 Flash Fast', context_window: 1048576, reasoning_efforts: ['low', 'high', 'max'] },
  { id: 'deepseek/deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision (exp)', context_window: 1048576, reasoning_efforts: ['high', 'max'] },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context_window: 1048576, reasoning_efforts: ['low', 'high', 'max'] },
  // Moonshot
  { id: 'moonshotai/Kimi-K3', name: 'Kimi K3', context_window: 1048576, reasoning_efforts: ['low', 'high', 'max'] },
  { id: 'moonshotai/Kimi-K2.7-Code', name: 'Kimi K2.7 Code', context_window: 262144 },
  { id: 'moonshotai/Kimi-K2.7-Code-Highspeed', name: 'Kimi K2.7 Code HighSpeed', context_window: 262144 },
  { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6', context_window: 262144 },
  { id: 'moonshotai/Kimi-K2.5', name: 'Kimi K2.5', context_window: 262144 },
  // GLM
  { id: 'zai-org/GLM-5.3', name: 'GLM-5.3', context_window: 1048576, reasoning_efforts: ['low', 'high', 'max'] },
  { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash', context_window: 1050000, reasoning_efforts: ['low', 'high', 'max'] },
  { id: 'z-ai/glm-5.3-flashx', name: 'GLM-5.3 FlashX', context_window: 1048576, reasoning_efforts: ['low', 'high', 'max'] },
  { id: 'zai-org/GLM-5.2', name: 'GLM-5.2', context_window: 1048576, reasoning_efforts: ['high', 'max'] },
  { id: 'zai-org/GLM-5.2-Fast', name: 'GLM-5.2 Fast', context_window: 1048576 },
  { id: 'zai-org/GLM-5.1', name: 'GLM 5.1' },
  { id: 'zai-org/GLM-5', name: 'GLM 5', context_window: 200000 },
  // MiniMax
  { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high'] },
  { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7' },
  { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5', context_window: 200000 },
  // Xiaomi
  { id: 'xiaomi/mimo-v2.6-pro', name: 'MiMo V2.6 Pro', context_window: 1050000 },
  { id: 'xiaomi/mimo-v2.6-pro-ultraspeed', name: 'MiMo V2.6 Pro UltraSpeed', context_window: 1050000 },
  { id: 'xiaomi/mimo-v2.6-flash', name: 'MiMo V2.6 Flash', context_window: 1050000 },
  { id: 'xiaomi/mimo-v2.5-pro', name: 'MiMo V2.5 Pro', context_window: 1048576 },
  { id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5', context_window: 1048576 },
  // Qwen
  { id: 'Qwen/Qwen3.8-Max', name: 'Qwen 3.8 Max', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'xhigh'] },
  { id: 'Qwen/Qwen3.8-Max-0902', name: 'Qwen 3.8 Max 0902', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'xhigh'] },
  { id: 'Qwen/Qwen3.8-Flash', name: 'Qwen 3.8 Flash', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'xhigh'] },
  { id: 'Qwen/Qwen3.8-27B', name: 'Qwen 3.8 27B', context_window: 262144, reasoning_efforts: ['low', 'medium', 'xhigh'] },
  { id: 'Qwen/Qwen3.8-Omni-Flash', name: 'Qwen 3.8 Omni Flash', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'xhigh'] },
  { id: 'Qwen/Qwen3.7-Max', name: 'Qwen 3.7 Max', context_window: 1048576 },
  { id: 'Qwen/Qwen3.7-Plus', name: 'Qwen 3.7 Plus', context_window: 1048576 },
  { id: 'Qwen/Qwen3.7-Flash', name: 'Qwen 3.7 Flash', context_window: 1048576 },
  { id: 'Qwen/Qwen3.6-Max-Preview', name: 'Qwen 3.6 Max Preview' },
  { id: 'Qwen/Qwen3.6-Plus', name: 'Qwen 3.6 Plus' },
  // Others
  { id: 'meituan/LongCat-2.0', name: 'LongCat 2.0', context_window: 1050000 },
  { id: 'stepfun/Step-5-Preview', name: 'Step 5 Preview', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high'] },
  { id: 'stepfun/Step-3.7-Flash', name: 'Step 3.7 Flash', context_window: 262144 },
  { id: 'stepfun/Step-3.5-Flash', name: 'Step 3.5 Flash', context_window: 1048576 },
  { id: 'tencent/hy4-preview', name: 'Tencent Hy4 Preview', context_window: 1050000, reasoning_efforts: ['low', 'medium', 'high'] },
  { id: 'tencent/hy3-paid', name: 'Tencent Hy3', context_window: 262144 },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra', context_window: 1048576 },
  { id: 'thinkingmachines/inkling', name: 'Inkling', context_window: 262144 },
  { id: 'thinkingmachines/inkling-small', name: 'Inkling Small', context_window: 1048576 },
  { id: 'sakana/fugu-ultra', name: 'Fugu Ultra', context_window: 1048576, reasoning_efforts: ['high', 'xhigh'] },
  { id: 'meta/muse-spark-1.3', name: 'Muse Spark 1.3', context_window: 1050000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'meta/muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor', context_window: 1050000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'meta/muse-spark-1.2', name: 'Muse Spark 1.2', context_window: 1050000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'meta/muse-spark-1.2-contributor', name: 'Muse Spark 1.2 Contributor', context_window: 1050000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'meta/muse-spark-1.1', name: 'Muse Spark 1.1', context_window: 1050000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'xai/grok-4.7', name: 'Grok 4.7', context_window: 500000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'xai/grok-4.6', name: 'Grok 4.6', context_window: 500000, reasoning_efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'xai/grok-4.5', name: 'Grok 4.5', context_window: 500000, reasoning_efforts: ['low', 'medium', 'high'] },
  { id: 'poolside/laguna-s-2.1-free', name: 'Laguna S 2.1', context_window: 262144 },
  { id: 'inclusionai/ling-3.0-flash-sante:free', name: 'Ling 3.0 Flash Sante', context_window: 262144 },
  // Google
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high'] },
  { id: 'google/gemini-3.7-flash', name: 'Gemini 3.7 Flash', context_window: 1050000, reasoning_efforts: ['low', 'medium', 'high'] },
  { id: 'google/gemini-3.6-flash', name: 'Gemini 3.6 Flash', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high'] },
  { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high'] },
  { id: 'google/gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high'] },
  { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', context_window: 1048576, reasoning_efforts: ['low', 'medium', 'high'] },
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

const STATIC_EFFORTS_BY_ID = new Map<string, readonly string[]>(
  MODELS.filter((m) => m.reasoning_efforts !== undefined)
    .map((m) => [m.id, m.reasoning_efforts as readonly string[]]),
)

let dynamicModels: ModelEntry[] | null = null
let modelsLastFetch = 0
// 失败退避：上次失败时刻；30s 内不重试，直接 stale 返回，避免失败惊群打爆上游。
let modelsLastFailureAt = 0
const FETCH_FAIL_BACKOFF_MS = 30_000
// 过期单飞：缓存过期后的并发 fetchModels 共用同一个 in-flight promise 去重，防惊群。
let inFlight: Promise<ModelEntry[]> | null = null

// NOTE（跨 key 复用风险，文档化）：dynamicModels / lastFetch / inFlight 是进程级
// 全局单例，不按 apiKey 分桶。不同客户端 key（getApiKey 结果）会复用同一份缓存：
// key A 触发拉取后，key B 在刷新间隔内直接拿到 A 拉到的列表（含 A 可见模型）。
// 当前上游 /provider/v1/models 返回全局模型目录（与 key 无关），复用可接受；
// 若未来上游按 key 返回差异化模型（订阅/权限隔离），必须改为按 key 分桶
// （Map<keyHash, {models,lastFetch}> + 分桶 inFlight），否则会串权。
// 按 key 分桶本次未做（key 空间无界需 LRU/TTL，复杂度超本次范围），特此记录。

async function doFetchModels(apiKey: string | null | undefined): Promise<ModelEntry[]> {
  // 配置性短路（无 key / 开关关闭）：不是上游失败，不记 failure backoff，
  // 否则一次无 key 请求会毒化随后 30s 内的有 key 拉取（e2e 先调无 key models
  // 再调有 key models，必挂）。有 stale 缓存则保留返回。
  if (!apiKey || !CFG.useProviderModels) {
    if (dynamicModels) return dynamicModels
    return MODELS
  }
  try {

    const response = await fetch(`${CFG.apiBase}/provider/v1/models`, {
      headers: {
        // 官方 CLI 的 REST 客户端同样带 User-Agent: cli（bundle buildCommandApiHeaders）。
        'User-Agent': 'cli',
        'Authorization': `Bearer ${apiKey}`,
        'x-cli-environment': 'production',
        'x-command-code-version': CC_VERSION,
        // ZDR 透传：全局开关开时模型拉取同样走 ZDR 路由，与 cc.ts / fingerprint.ts 一致。
        ...(CFG.zdr ? { 'x-cmd-zdr': '1' } : {}),
      },
      signal: AbortSignal.timeout(10000),
    })

    if (response.ok) {
      const data: any = await response.json()
      if (Array.isArray(data.data)) {
        const models: ModelEntry[] = data.data.map((m: any) => {
          const entry: ModelEntry = { id: m.id, name: m.id }
          const upstreamWindow = pickContextWindow(m)
          // 形状稳定：STATIC 优先（已知 id 用静态 canonical 值，避免上游误报/波动），
          // 缺失才用上游 parsed，再缺失保留 0 而不 delete，保证 dynamic 条目恒带
          // context_window 字段，下游 handleModels / 客户端无需处理“字段时有时无”。
          // 上游 NaN/缺失 → toOptionalNumber 已归一为 undefined，走后备分支。
          entry.context_window = STATIC_WINDOW_BY_ID.get(m.id) ?? upstreamWindow ?? 0
          const maxOut = pickMaxOutputTokens(m)
          if (maxOut !== undefined) entry.max_output_tokens = maxOut
          // reasoning 档位：静态权威表补充（上游不提供），仅在已知时暴露。
          const staticEfforts = STATIC_EFFORTS_BY_ID.get(m.id)
          if (staticEfforts) entry.reasoning_efforts = [...staticEfforts]
          // vision 归一：上游有声明则保留归一，无声明默认 text+image（通用透传）。
          entry.modalities = pickModalities(m)
          entry.input_modalities = [...entry.modalities]
          // 上游 capabilities 若为对象/数组则透传归一，否则默认 vision 标记。
          if (m.capabilities && typeof m.capabilities === 'object') entry.capabilities = m.capabilities
          else entry.capabilities = { vision: true }
          return entry
        })
        dynamicModels = models
        modelsLastFetch = Date.now()
        log('info', 'Fetched models from Provider API', { count: models.length })
        return models
      }
    }
    log('warn', 'Provider models fetch failed, using hardcoded list', { status: response.status })
  } catch (e: any) {
    log('warn', 'Provider models fetch error, using hardcoded list', { error: e.message })
  }

  // 失败路径：不更新 lastFetch（下次按退避窗口决定是否重试），但记录失败时刻；
  // stale-while-revalidate：有旧 dynamicModels 则保留返回，不回退到硬编码 MODELS。
  modelsLastFailureAt = Date.now()
  if (dynamicModels) return dynamicModels
  return MODELS
}

export async function fetchModels(apiKey?: string | null): Promise<ModelEntry[]> {
  const now = Date.now()
  if (dynamicModels && now - modelsLastFetch < CFG.modelRefreshIntervalMs) {
    return dynamicModels
  }
  // 失败退避：30s 内失败过则直接 stale 返回，不再拨上游。
  if (now - modelsLastFailureAt < FETCH_FAIL_BACKOFF_MS) {
    if (dynamicModels) return dynamicModels
    return MODELS
  }
  // 过期单飞：并发过期请求共用一个 promise。
  if (inFlight) return inFlight
  inFlight = doFetchModels(apiKey).finally(() => {
    inFlight = null
  })
  return inFlight
}

export async function handleModels(headers: Record<string, string | undefined>): Promise<Response> {
  const apiKey = getApiKey(headers)
  const models = await fetchModels(apiKey)
  const now = nowUnix()
  return sendJSON(200, {
    object: 'list',
    data: models.map((m) => {
      // 响应层统一 vision 声明：entry 自带则用之，否则默认 text+image。
      // 多别名兼容不同客户端解析器（opencode/OpenAI 生态各取所需），原有字段不动。
      const mods = m.modalities && m.modalities.length > 0 ? m.modalities : [...VISION_DEFAULT_MODALITIES]
      const inMods = m.input_modalities && m.input_modalities.length > 0 ? m.input_modalities : [...mods]
      return {
        id: m.id,
        object: 'model',
        created: now,
        owned_by: 'command-code',
        ...(m.context_window !== undefined ? { context_window: m.context_window } : {}),
        ...(m.max_output_tokens !== undefined ? { max_output_tokens: m.max_output_tokens } : {}),
        ...(m.reasoning_efforts !== undefined ? { reasoning_efforts: m.reasoning_efforts } : {}),
        modalities: mods,
        input_modalities: inMods,
        supported_modalities: [...mods],
        capabilities: m.capabilities ?? { vision: true },
        features: ['vision'],
        supports_vision: true,
        vision: true,
      }
    }),
  })
}
