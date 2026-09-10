import { Elysia } from 'elysia'
import { messagesModelPlugin } from './model'
import { MessagesService } from './service'
import { createAuthPreCheck } from '../../plugins/auth'

export const messagesController = new Elysia({ name: 'messages', prefix: '/v1' })
  .use(messagesModelPlugin)
  // 顺序：onParse(bodyLimit 单次限流解析) → onTransform(413 哨兵抛错) →
  // onTransform(auth 401 前置，无 key 时 return status 短路 validation) →
  // validation(400 body:'messages.body') → handler。local 只作用本实例本路由，
  // 不上浮到 parent app，避免 scoped 污染兄弟路由（chat 形覆盖本路由 401）
  // POST /v1/messages，不影响 health/models。
  .onTransform({ as: 'local' }, createAuthPreCheck(true))
  .post('/messages', ({ body, headers, request }) => MessagesService.handleBody(body, headers, request.signal), { body: 'messages.body' })

export { MessagesService } from './service'
export { messagesBody, messagesModelPlugin as messagesModel } from './model'
export type { MessagesBody } from './model'
