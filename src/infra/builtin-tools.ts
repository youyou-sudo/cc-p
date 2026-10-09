// infra/builtin-tools.ts — CC 侧内置工具声明 + 客户端服务端工具（server tool）映射。
//
// 为什么单独成文件：Responses 与 Anthropic 两条协议都要把「客户端声明的 provider
// 内置工具」落到同一个 CC function tool 上（web_search）。两边各写一份必然漂移
// （改了一边忘了另一边，schema/描述就不一致），所以声明与映射只留这一份，
// 两个 translator 各自 import。
//
// 层的归属：infra（CC 对接面）。只依赖 shared，不被 shared 依赖；modules 可以引它。

import { log } from '../shared/logger'

/** CC 侧普通 function tool 的声明形（name / description / input_schema 语义）。 */
export interface CcBuiltinTool {
  name: string
  description: string
  parameters: any
}

/** CC 侧 web_search（CC docs/reference/tools 的客户端执行普通工具）。
 *
 *  为什么代理要认识它：Anthropic 的 `web_search_20250305` 是 **provider-executed**
 *  内置工具 —— 客户端只声明 `{type, name}`，自己没有实现。CC 上游没有 provider 内置
 *  执行（模型只会回一个 tool-call），所以必须由代理代执行（见 infra/web-tools.ts 的
 *  executeWebSearch + infra/tool-loop.ts 的续跑）。 */
export const CC_WEB_SEARCH_TOOL: CcBuiltinTool = {
  name: 'web_search',
  description: 'Search the web and return ranked results.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (>= 2 chars)' },
      numResults: { type: 'number', description: 'Results (default 5, max 10)' },
      allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only these domains' },
      blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Never these domains' },
    },
    required: ['query'],
  },
}

/** Anthropic 服务端工具 type → 授予的 CC 工具。按 type 前缀匹配（各版本快照
 *  `web_search_20250305` / `web_search_20260209` 走同一实现）。
 *
 *  为什么按前缀而不是穷举快照名：Anthropic 每发一个带日期的快照名（-20250305 等）
 *  语义都不变，穷举会让新版快照静默落到「无对应能力 → 丢弃」分支，客户端以为搜索
 *  可用、实际拿到未实现调用。前缀匹配对新旧快照都成立。
 *
 *  未收录（computer / text_editor / code_execution / memory / tool_search / mcp 等）
 *  在 CC 侧没有对应能力，硬映射会误导模型，仍丢弃并 warn。 */
const ANTHROPIC_SERVER_TOOL_MAP: Array<{ prefix: string; tool: CcBuiltinTool }> = [
  { prefix: 'web_search_preview', tool: CC_WEB_SEARCH_TOOL },
  { prefix: 'web_search', tool: CC_WEB_SEARCH_TOOL },
]

function readStringArray(v: any): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((s: any) => typeof s === 'string' && s.trim()).map((s: string) => s.trim())
}

/**
 * 把 Anthropic 的服务端工具声明映射成要授予的 CC function tool。
 *
 * 返回 undefined = 不是已知服务端工具（调用方按客户端 function 工具处理）。
 *
 * 约束不静默丢：`allowed_domains` / `blocked_domains` 落进 schema 的 `items.enum`
 * 与描述（否则调用方以为已限域、模型却能搜全网）。`max_uses` / `user_location`
 * 代理侧暂不强制，warn 说明，绝不假装生效。
 */
export function mapAnthropicServerTool(t: any): { tool: CcBuiltinTool; declaredType: string; declaredName: string } | undefined {
  const type = typeof t?.type === 'string' ? t.type : ''
  if (!type) return undefined
  const entry = ANTHROPIC_SERVER_TOOL_MAP.find((e) => type === e.prefix || type.startsWith(`${e.prefix}_`))
  if (!entry) return undefined

  const declaredName = typeof t?.name === 'string' && t.name ? t.name : entry.tool.name
  const allowed = readStringArray(t?.allowed_domains)
  const blocked = readStringArray(t?.blocked_domains)
  if (t?.max_uses !== undefined) {
    log('warn', 'anthropic server tool max_uses not enforced by proxy', { type, max_uses: t.max_uses })
  }
  if (t?.user_location !== undefined) {
    log('warn', 'anthropic server tool user_location not enforced by proxy', { type })
  }

  // 无域约束：直接用 canonical 声明（description 保证非空 —— 上游要求工具描述非空）。
  if (allowed.length === 0 && blocked.length === 0) {
    return { tool: entry.tool, declaredType: type, declaredName }
  }

  const scope: string[] = []
  if (allowed.length > 0) scope.push(`only these domains: ${allowed.join(', ')}`)
  if (blocked.length > 0) scope.push(`never these domains: ${blocked.join(', ')}`)
  const parameters = JSON.parse(JSON.stringify(entry.tool.parameters))
  // 限域表达不确定性：allowed 用 enum（硬约束），blocked 只能进描述（CC 服务路由
  // 支持 blockedDomains，但模型仍可能搜到再被过滤，描述里说清即可）。
  if (allowed.length > 0 && parameters?.properties?.allowed_domains) {
    parameters.properties.allowed_domains.items = { type: 'string', enum: allowed }
    parameters.properties.allowed_domains.description = `Only these domains: ${allowed.join(', ')}`
  }
  if (blocked.length > 0 && parameters?.properties?.blocked_domains) {
    parameters.properties.blocked_domains.description = `Never these domains: ${blocked.join(', ')}`
  }
  return {
    tool: {
      name: entry.tool.name,
      description: `${entry.tool.description} Restricted to ${scope.join('; ')}.`,
      parameters,
    },
    declaredType: type,
    declaredName,
  }
}
