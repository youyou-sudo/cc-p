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
  // 缓存保活：官方 Claude Code 在 allow_cache_keepalive 下每 30s 调一次，此前未注册
  // 路由 → 每周期 404。无副作用 200（上游缓存按 session 认，见 cache-touch.ts 头注释）。
  // body 不挂 schema：客户端只发 {request_id}，未知字段一律容忍。
  .post('/messages/cache_touch', ({ body, headers }) => MessagesService.handleCacheTouch(body, headers))

export { MessagesService } from './service'
export { messagesBody, messagesModelPlugin as messagesModel } from './model'
export type { MessagesBody } from './model'
