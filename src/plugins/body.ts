import { Elysia } from 'elysia'
import { readJsonBody, BodyTooLargeError } from '../shared/http'

// 单次限流 JSON 解析插件：复用 readJsonBody 不变式，消除 Elysia 内建解析与
// readJsonBody 双解析冲突。
//
// 背景：旧 handler 经 readJsonBody 自解析（含 content-length 预检 >MAX_BODY_SIZE
// 直接抛 BodyTooLargeError；分块读超限转排水 DRAIN_LIMIT=32MB；每次 reader.read()
// 经 readWithTimeout 30s 超时转 Error('Request read timeout')；JSON.parse 失败 /
// 无 body 抛 Error('Invalid JSON')）。若路由再挂 body schema 或默认 json() 解析，
// 流会被读两次 / 绕过上述不变式。
//
// 机制：
// - Elysia 按路由是否有 body 引用来决定是否解析。当前路由刻意只用
//   ({request,headers}) 避开 sucrose 推断，所以默认 hasBody=false、不读流。
//   未来路由一旦解构 body（或挂 body schema），内建解析就会读流——本插件的
//   onParse 返回非 undefined 即短路默认 json() 解析（used=true，无双读），
//   成功时返回已解析对象，后续解构 body 即命中该缓存。
// - content-type 大小写不敏感：HTTP 头值大小写无关（Application/JSON 合法），
//   故统一 toLowerCase 后再匹配 json / +json 后缀。
// - 非 JSON（含无 content-type、表单、多段、纯文本）同样执行限流拦截：
//   未知类型按 MAX_BODY_SIZE 拦——先读流经 readJsonBody 做长度预检+分块限流，
//   若超限同样走 413 哨兵；若解析失败则按非 JSON 放行（返回 undefined），
//   把“类型校验”留给路由层，避免误伤 GET/空/表单等合法请求。
//   （旧行为“非 JSON 直接放行”会绕过限流：攻击者用 text/plain 带超大 body
//   即可跳过 MAX_BODY_SIZE 检查，故改为先限流后放行。）
// - GET/HEAD 显式放行，避免对无 body 请求误抛 'Invalid JSON'。
// - 哨兵顺序（onParse → onTransform），注释如下：
//   ① onParse：读流+限流。超限不直抛，只 stash 到 tooLargeByRequest 并返回
//      TOO_LARGE_BODY 占位短路默认解析；Invalid JSON / timeout / 空流直接透传 Error。
//   ② onTransform（在 parse 的 try/catch 之外）：取出 stash 并抛普通 Error(status=413)。
//      顺序不可颠倒——onParse 直抛 413 会被 compose 包成 ParseError（status=400）。
// - 413 走 onTransform 抛普通 Error 而非 onParse 直抛：Elysia compose 把整个
//   parse 阶段包在 try/catch 里，直抛会被包成 new ParseError（message 固定
//   'Bad Request'、status=400，原始 status=413 只留在 .cause 上），errorsPlugin
//   看到的 code 永远是 'PARSE'，413 双形分支永不可达。onParse 只做哨兵 stash
//   （WeakMap<Request,msg> + 返回占位对象短路默认解析），真正抛 413 的时机挪到
//   onTransform（在 parse 的 try/catch 之外），此时 code==='UNKNOWN'、
//   error.status===413，errorsPlugin 的 `status === 413` 分支可达。
// - 为什么不用 status(413,…)？status() 构造的是 ElysiaCustomStatusResponse，
//   会被 errorsPlugin 的 isStatusResponse 穿透分支直接 return undefined，绕过
//   413 双形分支（path === '/v1/messages' 分 Anthropic 形否则 OpenAI 形），
//   回退到 Elysia 默认渲染。普通 Error + status=413 才能命中该分支。
// - Invalid JSON / timeout / 空流：onParse 内直接透传普通 Error。Elysia 包成
//   code==='PARSE'，errorsPlugin 的 PARSE/VALIDATION 分支强制归一为 400 双形
//   （对外永不漏 422），message 归一为 'Invalid JSON body'，但原始 message
//   （含 'Invalid JSON'）仍保留在 cause 链供日志。
// - 不在此做 schema 校验：那是 controller 的 body:'chat.body' 职责，本插件只做
//   单次限流解析。注意挂 body schema 后 VALIDATION 仍可能对畸形 payload 报 400
//   双形，这是 schema 层的归一行为，与本插件无关。
// - 401 vs 413 顺序说明：app.ts 插件顺序是 bodyLimit(onParse) → auth(createAuthPreCheck
//   onTransform，local)。同为 onTransform 时，scoped（body 插件）先于 local（路由级
//   auth 前置）执行，故无 key + 超大 body 会先 413 后 401（信息泄露面：未鉴权即可探
//   出 MAX 大小）。理想顺序是 auth 先于 body 限流；但 Elysia scoped/global/local
//   执行序由框架固定，body 插件改为 local 会漏掉其他实例路由。当前保持顺序不变，
//   特此注释：如需“无 key 一律先 401”，需把 body 限流移到各路由 auth 之后显式调用
//   readJsonBody（旧 readRequestJson 已删，统一走 bodyLimitPlugin），或接受 413 先行的现状。
//
// 注意：无顶层 await；MAX_BODY_SIZE 快照复用 http.ts（经 config.ts CC_MAX_BODY_MB
// 覆写，默认 100MB），不要在此重载。
const tooLargeByRequest = new WeakMap<Request, string>()
const TOO_LARGE_BODY = { __bodyLimitTooLarge: true } as const

export const bodyLimitPlugin = new Elysia({ name: 'body-limit' })
  .onParse({ as: 'scoped' }, async ({ request }) => {
    const ct = (request.headers.get('content-type') ?? '').toLowerCase()
    const isJson = !ct || ct.includes('json') || ct.includes('+json')
    // GET/HEAD 默认不解析，直接放行
    if (request.method === 'GET' || request.method === 'HEAD') return undefined
    try {
      return await readJsonBody(request)
    } catch (e: any) {
      if (e instanceof BodyTooLargeError) {
        // 不在此直抛：会被 compose 包成 ParseError（status=400），413 分支不可达。
        // stash 到 onTransform 再抛普通 Error(status=413)，走 errorsPlugin 413 双形。
        tooLargeByRequest.set(request, e.message)
        return TOO_LARGE_BODY as any
      }
      // 非 JSON 体的解析失败（Invalid JSON）：非 JSON 类型不归本插件管，
      // 放行默认解析（返回 undefined），把类型校验留给路由层。
      // 限流已在 readJsonBody 内完成（超限走上面的 413 哨兵），此处放行不绕限流。
      if (!isJson) return undefined
      // Invalid JSON / timeout / 空流：抛普通 Error，让 Elysia 包成 PARSE →
      // errorsPlugin 400 双形。保留原始 message（含 'Invalid JSON'）供日志。
      throw e
    }
  })
  .onTransform({ as: 'scoped' }, ({ request }) => {
    const msg = tooLargeByRequest.get(request)
    if (msg !== undefined) {
      tooLargeByRequest.delete(request)
      // 普通 Error + status=413（不要用 status()，否则被 errorsPlugin 穿透），
      // 让 errorsPlugin 走 413 双形分支（/v1/messages 分 Anthropic 形否则 OpenAI 形）
      const err: any = new Error(msg)
      err.status = 413
      throw err
    }
  })
