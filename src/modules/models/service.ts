import type { ModelEntry } from '../../models'

// Strangler 包装：绝不重写缓存/dynamicModels 单例逻辑，直接委托旧 src/models.ts。
// 用动态 import 避免单例分裂、保持零回归。
export abstract class ModelsService {
  static async list(headers: Record<string, string | undefined>): Promise<Response> {
    const { handleModels } = await import('../../models')
    return handleModels(headers)
  }

  static async fetch(apiKey?: string | null): Promise<ModelEntry[]> {
    const { fetchModels } = await import('../../models')
    return fetchModels(apiKey)
  }
}
