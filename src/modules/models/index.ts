// 薄转发：不加 response 校验（先保证行为一致，后续再收紧），不用 guard。
// 只解构 headers 传给 Service，不传 Context。
import { Elysia } from 'elysia'
import { modelsModelPlugin } from './model'
import { ModelsService } from './service'

export const modelsController = new Elysia({ name: 'models', prefix: '/v1/models' })
  .use(modelsModelPlugin)
  .get('/', ({ headers }) => ModelsService.list(headers))

export { ModelsService } from './service'
export { listQuery, modelEntry, listResponse, modelsModelPlugin as modelsModel } from './model'
export type { ModelsModel } from './model'
