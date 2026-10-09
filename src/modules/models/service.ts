import type { ModelEntry } from './catalog'

// Strangler 包装：绝不重写缓存/dynamicModels 单例逻辑，直接委托同目录 catalog.ts。
// 用动态 import 避免单例分裂、保持零回归。
//
// 双协议分流：Claude Code（Anthropic SDK）发 `anthropic-version` 头，要求
// `{data:[ModelInfo], has_more, first_id, last_id}`；OpenAI 系客户端不带该头，
// 要求 `{object:'list', data:[...]}`。默认 OpenAI 形 —— 未带该头的既有调用方
// 行为逐字节不变（含 object/created/owned_by/vision 全别名）。
export abstract class ModelsService {
  static async list(headers: Record<string, string | undefined>): Promise<Response> {
    const { handleModels, handleAnthropicModels } = await import('./catalog')
    if (wantsAnthropicShape(headers)) return handleAnthropicModels(headers)
    return handleModels(headers)
  }

  static async fetch(apiKey?: string | null): Promise<ModelEntry[]> {
    const { fetchModels } = await import('./catalog')
    return fetchModels(apiKey)
  }
}

/** Anthropic 形判定：带 `anthropic-version`（SDK 必带）或显式 `?beta=true`
 *  （官方 beta 路径 `client.beta.models.list()`）。大小写不敏感，兼容框架未归一。 */
export function wantsAnthropicShape(headers: Record<string, string | undefined>): boolean {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'anthropic-version' && headers[k]) return true
  }
  return false
}
