// 薄转发：不加 response 校验（先保证行为一致，后续再收紧），不用 guard。
// 只解构 headers 传给 Service，不传 Context。
//
// 双协议同一路径：Claude Code 用 Anthropic 形（`/v1/models?limit=1000` 做网关
// 模型发现，读 `data[].{id,display_name,description}`），OpenAI 系客户端用
// `{object:'list',data:[...]}`。两者形状不兼容，故按请求头分流（ProtocolSplit），
// 默认 OpenAI 形 —— 未声明 `anthropic-version` 的既有调用方行为完全不变。
import { Elysia } from 'elysia'
import { modelsModelPlugin } from './model'
import { ModelsService } from './service'

export const modelsController = new Elysia({ name: 'models', prefix: '/v1/models' })
  .use(modelsModelPlugin)
  .get('/', ({ headers }) => ModelsService.list(headers))

export { ModelsService } from './service'
export { listQuery, modelEntry, listResponse, anthropicModelInfo, anthropicListResponse, modelsModelPlugin as modelsModel } from './model'
export type { ModelsModel } from './model'
