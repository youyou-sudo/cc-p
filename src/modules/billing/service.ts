import { CFG } from '../../shared/config'
import { log } from '../../shared/logger'
import { sendJSON } from '../../shared/http'
import { getApiKey } from '../../shared/auth'
import { CC_VERSION } from '../../shared/version'

// CC 上游余额端点：GET {CC_API_BASE}/alpha/billing/credits（与官方 CLI 同路径）。
// 返回形状（社区实测，见 README 引用）：
//   { windowLimits: { fiveHour: {used,cap,exceeded,resetAt}, weekly: {...} },
//     credits: { monthlyCredits, monthlyCreditsGranted, purchasedCredits?, ... } }
// monthlyCredits = 本月剩余额度；monthlyCreditsGranted = 本月授予总额；
// 额外购买额度 purchasedCredits 不过期、可叠加使用。
// 本模块只把「月度余额」映射成 OpenAI credit_summary；5h/周窗口按设计不透出。
export const BILLING_CREDITS_PATH = '/alpha/billing/credits'

// 与 models 拉取同级的 10s 预算，避免余额查询长时间挂住客户端。
const BILLING_TIMEOUT_MS = 10_000

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// 上游非 2xx：转成 OpenAI 错误信封（余额端点属 OpenAI 命名空间，
// 客户端按 /v1 惯用形状解析；绝不透传上游原始 body，防泄露账号细节）。
function upstreamError(status: number, message: string): Response {
  const type =
    status === 401 || status === 403
      ? 'authentication_error'
      : status === 429
        ? 'rate_limit_error'
        : status >= 500
          ? 'api_error'
          : 'invalid_request_error'
  return sendJSON(status, { error: { message, type } })
}

export interface CreditSummary {
  object: 'credit_summary'
  total_granted: number
  total_used: number
  total_available: number
  grants: {
    object: 'list'
    data: Array<{
      object: 'credit_grant'
      id: string
      grant_amount: number
      used_amount: number
      effective_at: number | null
      expires_at: number | null
    }>
  }
}

// 纯函数：上游 credits payload → OpenAI credit_summary。单测覆盖，无副作用。
export function buildCreditSummary(data: any): CreditSummary {
  const credits =
    data && typeof data === 'object' && data.credits && typeof data.credits === 'object' ? data.credits : {}

  const grantedRaw = toNumber(credits.monthlyCreditsGranted)
  const remainingRaw = toNumber(credits.monthlyCredits)
  const purchased = toNumber(credits.purchasedCredits) ?? 0

  // 缺 granted 时用 remaining 兜底（视作未消费），缺 remaining 时视作全额未用。
  const granted = grantedRaw ?? remainingRaw ?? 0
  const remaining = remainingRaw ?? granted
  const used = Math.max(0, granted - remaining)
  const available = remaining + purchased

  return {
    object: 'credit_summary',
    total_granted: round2(granted),
    total_used: round2(used),
    total_available: round2(available),
    grants: {
      object: 'list',
      data: [
        {
          object: 'credit_grant',
          id: 'grant_monthly',
          grant_amount: round2(granted),
          used_amount: round2(used),
          effective_at: null,
          expires_at: null,
        },
      ],
    },
  }
}

export abstract class BillingService {
  static async creditSummary(headers: Record<string, string | undefined>): Promise<Response> {
    const apiKey = getApiKey(headers)
    // controller 的 onTransform 已前置 401；这里兜底，保证 service 可独立调用。
    if (!apiKey) return upstreamError(401, 'Missing API key')

    let response: Response
    try {
      response = await fetch(`${CFG.apiBase}${BILLING_CREDITS_PATH}`, {
        method: 'GET',
        headers: {
          // 与 models / generate 一致：官方 REST 客户端同带 UA: cli 与版本头。
          'User-Agent': 'cli',
          'Authorization': `Bearer ${apiKey}`,
          'x-cli-environment': 'production',
          'x-command-code-version': CC_VERSION,
          ...(CFG.zdr ? { 'x-cmd-zdr': '1' } : {}),
        },
        signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
      })
    } catch (e: any) {
      log('error', 'Billing credits fetch failed', { error: e?.message })
      return sendJSON(502, { error: { message: 'Failed to fetch billing summary', type: 'api_error' } })
    }

    if (!response.ok) {
      // 丢弃 body 以便复用连接；原始内容只进日志（脱敏口径与 errors.ts 500 分支一致）。
      const raw = await response.text().catch(() => '')
      log('warn', 'Billing credits upstream non-2xx', {
        status: response.status,
        body: raw.slice(0, 200) || undefined,
      })
      return upstreamError(response.status, 'Failed to fetch billing summary')
    }

    let data: any
    try {
      data = await response.json()
    } catch {
      return sendJSON(502, { error: { message: 'Invalid billing response from upstream', type: 'api_error' } })
    }

    return sendJSON(200, buildCreditSummary(data))
  }
}
