import type { ModelEntry } from './catalog'

// Strangler 包装：绝不重写缓存/dynamicModels 单例逻辑，直接委托同目录 catalog.ts。
// 用动态 import 避免单例分裂、保持零回归。
export abstract class ModelsService {
  static async list(headers: Record<string, string | undefined>): Promise<Response> {
    const { handleModels } = await import('./catalog')
    return handleModels(headers)
  }

  static async fetch(apiKey?: string | null): Promise<ModelEntry[]> {
    const { fetchModels } = await import('./catalog')
    return fetchModels(apiKey)
  }
}
