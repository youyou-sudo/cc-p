import { Elysia } from 'elysia'
import { MAX_BODY_SIZE } from '../shared/config'
import { log } from '../shared/logger'

// Reusable copy of the src/index.ts onError branches (NOT_FOUND / 413 /
// PARSE / VALIDATION + 500 fallback). Kept byte-identical in shape:
// OpenAI routes get { error: … }, /v1/messages gets the Anthropic
// { type: 'error', error: … } wrapper. No response-schema validation is
// added — handlers return raw Responses. Standalone: no routes added, so
// app.use(errorsPlugin) only contributes the onError hook.
//
// Errors thrown via status() (ElysiaCustomStatusResponse: resolve/macro
// auth failures) pass through untouched — returning undefined lets Elysia's
// default mapping render them. Only plain Errors / framework codes are
// normalized here.
function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function isStatusResponse(error: any): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    'response' in error &&
    (error as any)?.constructor?.name === 'ElysiaCustomStatusResponse'
  )
}

// 哨兵顺序说明（与 body.ts 对应）：本 onError 先判 CcBadRequestError（cc.ts
// buildCcRequest 参数校验抛的 400，由上层统一转 invalid_request_error 双形，
// 与 VALIDATION 分支同形按 path 区分），再判 status===413（body 限流哨兵，
// onTransform 抛的普通 Error），再判 PARSE/VALIDATION（JSON 解析/schema 失败→400
// 双形），最后 500 兜底。413 分支必须在 PARSE 之前——否则被包成 ParseError 的超大
// 体会被误判 400。若未来新增 401 分支，注意 body 插件 scoped onTransform 先于路由
// 级 auth local 执行，无 key+超大体会先命中 413（见 body.ts 末段注释）。
// CcBadRequestError 判定用 name 字符串而非静态 import：避免 plugins/errors →
// infra/cc 硬依赖形成循环（infra/cc 未来若引 shared/errors 即成环），且对
// 跨包复用/动态 import 的同名错误同样可达。
export const errorsPlugin = new Elysia({ name: 'errors' })
  // scoped (not local): fires for routes registered on the app AFTER
  // app.use(errorsPlugin): local misses NOT_FOUND entirely, global would
  // also hijack routes registered before .use(). Scoped + returning
  // undefined on foreign error classes (status()-thrown Elysia responds,
  // e.g. macro auth failures) lets Elysia's default mapping render them.
  .onError({ as: 'scoped' }, ({ code, error, request }) => {
    if (isStatusResponse(error)) return undefined
    const status = (error as any)?.status
    // cc.ts 参数校验失败（CcBadRequestError / BAD_REQUEST）：400 双形，
    // 与 VALIDATION 分支一致按 path 区分 OpenAI/Anthropic 形。
    if ((error as any)?.name === 'CcBadRequestError' || ((error as any)?.code === 'BAD_REQUEST' && status === 400)) {
      const path = new URL(request.url).pathname
      const msg = (error as any)?.message ?? 'Invalid request'
      if (path === '/v1/messages') {
        return jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: msg } })
      }
      return jsonResponse(400, { error: { message: msg, type: 'invalid_request_error' } })
    }
    if (code === 'NOT_FOUND') {
      return jsonResponse(404, { error: { message: 'Not found', type: 'not_found' } })
    }
    if (status === 413 || code === 'PARSE' || code === 'VALIDATION') {
      const path = new URL(request.url).pathname
      if (status === 413) {
        const msg = `Request body exceeds ${Math.round(MAX_BODY_SIZE / 1024 / 1024)}MB limit`
        if (path === '/v1/messages') {
          return jsonResponse(413, { type: 'error', error: { type: 'invalid_request_error', message: msg } })
        }
        return jsonResponse(413, { error: { message: msg, type: 'invalid_request_error' } })
      }
      if (path === '/v1/messages') {
        return jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } })
      }
      return jsonResponse(400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } })
    }
    // 500 固定外发 'Internal error'：原始 message/stack 只记日志，永不外泄
    //（防路径/密钥/上游细节泄露；客户端排障靠 requestId + 服务端日志关联）。
    const rawMessage = (error as any)?.message ?? 'Internal error'
    const rawStack = (error as any)?.stack
    try {
      log('error', 'Unhandled error', { message: rawMessage, stack: typeof rawStack === 'string' ? rawStack.slice(0, 2000) : undefined, code })
    } catch {
      // 日志失败不影响错误响应
    }
    return jsonResponse(500, { error: { message: 'Internal error', type: 'internal_error' } })
  })
