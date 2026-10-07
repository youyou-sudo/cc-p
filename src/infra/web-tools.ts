// infra/web-tools.ts — 代理侧代执行 CC 的 web 工具。
//
// 为什么由代理执行：OpenAI Responses 的 `web_search` 是 **provider-executed** 内置
// 工具，客户端自己没有实现（它只声明 `{type:'web_search'}`），CC 侧也没有 provider
// 内置执行。但 CC 有**服务路由** `/alpha/web-search`（CLI bundle 实测：`POST
// {query,numResults,allowedDomains?,blockedDomains?}`，与 /alpha/generate 共用同一套
// 指纹头）。所以正确做法是代执行：模型调 web_search → 代理取结果 → 回填成 tool
// 结果继续生成。这样 opencode / codex 一行都不用改就能拿到 web 能力。
//
// 失败绝不抛给客户端：一律回一条文本结果，让模型自己决定下一步。

import { CFG } from '../shared/config'
import { buildCliHeaders } from './cc'
import { log } from '../shared/logger'

/** 与 CC 官方 CLI 同档的参数边界（bundle: sg=5 / ig=10 / ag=2）。 */
const NUM_RESULTS_DEFAULT = 5
const NUM_RESULTS_MAX = 10
const QUERY_MIN_CHARS = 2
/** 回填正文上限：一次搜索是排名结果，不该顶爆上下文；超限截断。 */
const MAX_RESULT_CHARS = 20_000
const REQUEST_TIMEOUT_MS = 20_000

export interface WebToolContext {
  apiKey: string
  /** 已按大小写归一/含 x-cmd-zdr 的入站头。 */
  headers: Record<string, string | undefined>
  sessionId: string
  signal: AbortSignal
}

function readStringArray(v: any): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((s: any) => typeof s === 'string' && s.trim()).map((s: string) => s.trim())
}

/** 子域匹配（与 CLI 的 urlMatchesAnyDomain 同义）。 */
function hostMatches(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    const d = domain.toLowerCase().replace(/^\./, '')
    return host === d || host.endsWith(`.${d}`)
  } catch {
    return false
  }
}

/** 排名结果 → 文本（CLI 也是把 results 渲染成条目文本给模型）。 */
function formatResults(results: any[], query: string): string {
  const lines = results.map((r: any) => {
    const title = typeof r?.title === 'string' ? r.title : ''
    const url = typeof r?.url === 'string' ? r.url : ''
    const desc = typeof r?.description === 'string' ? r.description : (typeof r?.snippet === 'string' ? r.snippet : '')
    if (!title && !url) return ''
    const head = title && url ? `${title} — ${url}` : (title || url)
    return desc ? `- ${head}\n  ${desc}` : `- ${head}`
  }).filter(Boolean)
  if (lines.length === 0) return `No results found for: ${query}\n\nTry a broader or differently-worded query.`
  return lines.join('\n\n')
}

/** 执行一次 web_search（CC 服务路由）。返回给模型的工具结果文本（永不抛）。 */
export async function executeWebSearch(input: any, ctx: WebToolContext): Promise<string> {
  const query = typeof input?.query === 'string' ? input.query.trim() : ''
  if (query.length < QUERY_MIN_CHARS) {
    return `web_search failed: "query" is required (at least ${QUERY_MIN_CHARS} characters).`
  }
  const allowed = readStringArray(input?.allowed_domains)
  const blocked = readStringArray(input?.blocked_domains)
  if (allowed.length > 0 && blocked.length > 0) {
    return 'web_search failed: pass either "allowed_domains" or "blocked_domains", not both.'
  }
  const rawNum = Number(input?.numResults)
  const numResults = Number.isFinite(rawNum)
    ? Math.min(NUM_RESULTS_MAX, Math.max(1, Math.floor(rawNum)))
    : NUM_RESULTS_DEFAULT

  const body: Record<string, any> = { query, numResults }
  if (allowed.length > 0) body.allowedDomains = allowed
  if (blocked.length > 0) body.blockedDomains = blocked

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = typeof (AbortSignal as any).any === 'function'
    ? (AbortSignal as any).any([ctx.signal, timeout])
    : ctx.signal

  try {
    const res = await fetch(`${CFG.apiBase}/alpha/web-search`, {
      method: 'POST',
      headers: buildCliHeaders(ctx.apiKey, ctx.sessionId, ctx.headers),
      body: JSON.stringify(body),
      signal: combined,
    })
    if (!res.ok) {
      const snippet = await res.text().catch(() => '')
      log('warn', 'CC web-search failed', { status: res.status, bodySnippet: snippet.slice(0, 200), query: query.slice(0, 120) })
      return `web_search failed: upstream ${res.status}`
    }
    const json: any = await res.json().catch(() => null)
    if (json == null) return 'web_search failed: malformed upstream response'

    // 与 CLI 一致：域过滤在本地再严格执行一次（硬约束，不能只信上游）。
    if (!Array.isArray(json.results)) {
      const formatted = typeof json.formatted === 'string' ? json.formatted : ''
      return (formatted || `No results found for: ${query}`).slice(0, MAX_RESULT_CHARS)
    }
    const filtered = json.results.filter((r: any) => {
      const url = typeof r?.url === 'string' ? r.url : ''
      if (!url) return false
      if (allowed.length > 0) return allowed.some((d) => hostMatches(url, d))
      if (blocked.length > 0) return !blocked.some((d) => hostMatches(url, d))
      return true
    }).slice(0, numResults)
    log('info', 'CC web-search done', { query: query.slice(0, 120), results: filtered.length })
    return formatResults(filtered, query).slice(0, MAX_RESULT_CHARS)
  } catch (e: any) {
    // 客户端断连必须透传 Abort（上层停泵），其余一律降级成文本结果。
    if (ctx.signal.aborted) throw e
    log('warn', 'CC web-search error', { message: e?.message ?? String(e), query: query.slice(0, 120) })
    return 'web_search failed: upstream unreachable'
  }
}
