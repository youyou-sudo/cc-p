import { authErrorMessage, getApiKey } from '../../shared/auth'
import { log } from '../../shared/logger'
import { sendJSON, sendAnthropicError } from '../../shared/http'

// Anthropic 客户端在「缓存保活」模式下发起的端点：官方 Claude Code 在
// `allow_cache_keepalive` 打开时每 30s POST 一次 /v1/messages/cache_touch，
// body `{request_id: <上一个 assistant message id>}`，用来把已写入的 prompt cache
// 续命（避免用户思考/离开时缓存过期，下一轮全量重算）。
//
// 为什么本地此前是 404：路由未注册 → Elysia NOT_FOUND → 客户端在每个保活周期都
// 收一次 404（保活静默失效 + 日志噪声；客户端会把它当错误路径处理）。
//
// 为什么返回 200 空对象而不是代理到上游：CC 上游没有对应的保活路由，而「保活」
// 本身在本代理里天然成立 —— 上游是按 session/threadId 认缓存，代理又对每个
// apiKey 维持 12h 的稳定 session（infra/session.ts），缓存不随客户端静默而失效。
// 返回 200 表示「已受理」在语义上是真的，绝不能为了让响应「看起来有事发生」而
// 伪造 usage 或向上游发一次真实计费请求（那会凭空消耗额度）。
//
// 形状：官方端点返回 `{type:'cache_touch', request_id, ...}`；这里用最小稳定形状
// `{type:'cache_touch'}`，客户端只判 2xx，不解析额外字段。
export async function handleCacheTouch(
  body: any,
  headers: Record<string, string | undefined>,
): Promise<Response> {
  // 与其他 Anthropic 路由同口径的鉴权前置：无 key → Anthropic 形 401。
  const apiKey = getApiKey(headers)
  if (!apiKey) {
    return sendAnthropicError(401, 'authentication_error', authErrorMessage(headers))
  }
  const requestId = typeof body?.request_id === 'string' ? body.request_id : ''
  log('debug', 'cache_touch accepted (no-op; upstream cache is session-scoped)', {
    path: '/v1/messages/cache_touch',
    // message id 不是机密，但保持与其他日志一致只记长度/前缀，避免把会话内容串进日志。
    requestId: requestId ? requestId.slice(0, 32) : '(none)',
  })
  return sendJSON(200, { type: 'cache_touch' })
}
