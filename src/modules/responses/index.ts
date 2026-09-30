import { Elysia } from 'elysia'
import { responsesModelPlugin } from './model'
import { ResponsesService } from './service'
import { createAuthPreCheck } from '../../plugins/auth'

export const responsesController = new Elysia({ name: 'responses', prefix: '/v1' })
  .use(responsesModelPlugin)
  // 顺序：onParse(bodyLimit 单次限流解析) → onTransform(413 哨兵抛错) →
  // onTransform(auth 401 前置，无 key 时 return status 短路 validation) →
  // validation(400 body:'responses.body') → handler。local 只作用本实例本路由，
  // 不上浮到 parent app，避免 scoped 污染兄弟路由（chat/messages 误回 responses 形）。
  // POST /v1/responses，不影响 health/models。
  .onTransform({ as: 'local' }, createAuthPreCheck(false))
  .post('/responses', ({ body, headers, request }) => ResponsesService.handleBody(body, headers, request.signal), { body: 'responses.body' })

export { ResponsesService } from './service'
export { responsesBody, responsesModelPlugin as responsesModel } from './model'
export type { ResponsesBody } from './model'
