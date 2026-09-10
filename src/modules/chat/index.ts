import { Elysia } from 'elysia'
import { chatModelPlugin } from './model'
import { ChatService } from './service'
import { createAuthPreCheck } from '../../plugins/auth'

export const chatController = new Elysia({ name: 'chat', prefix: '/v1' })
  .use(chatModelPlugin)
  // 顺序：onParse(bodyLimit 单次限流解析) → onTransform(413 哨兵抛错) →
  // onTransform(auth 401 前置，无 key 时 return status 短路 validation) →
  // validation(400 body:'chat.body') → handler。local 只作用本实例本路由，
  // 不上浮到 parent app，避免 scoped 污染兄弟路由（messages 误回 chat 形）
  // POST /v1/chat/completions，不影响 health/models。
  .onTransform({ as: 'local' }, createAuthPreCheck(false))
  .post('/chat/completions', ({ body, headers, request }) => ChatService.handleBody(body, headers, request.signal), { body: 'chat.body' })

export { ChatService } from './service'
export { chatBody, chatModelPlugin as chatModel } from './model'
export type { ChatBody } from './model'
