# 模块报告：src/plugins/body.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/plugins/body.ts` |
| 行数 | 77 |
| 层级 | 插件层 |
| 依赖 | `elysia`(Elysia) `../shared/http`(readJsonBody, BodyTooLargeError) |
| 被依赖 | `src/app.ts` |

## 职责

- 单次限流 JSON 解析：复用 `readJsonBody` 不变式，消除 Elysia 内建解析与 `readJsonBody` 的双解析冲突。
- 只在 `onParse` 阶段拦截 JSON（含 `+json`）请求；非 JSON、无 content-type、GET/HEAD 一律放行默认解析。
- 通过 `onParse` 哨兵 stash + `onTransform` 抛普通 `Error(status=413)` 的可达路径，让 `errorsPlugin` 的 413 双形分支生效。
- 将 Invalid JSON / 超时 / 空流错误透传为普通 `Error`，由框架包成 `PARSE` 后归一为 400。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | import | — | `elysia`(Elysia) `../shared/http`(readJsonBody, BodyTooLargeError) |
| 4-42 | — | 逻辑 | — | 注释：机制说明——单次解析、短路默认 json()、413 为何走 onTransform、为何不用 `status()`、错误归一策略 |
| 43 | `tooLargeByRequest` | 常量/字段 | P | `WeakMap<Request, string>`，暂存超限 message 供 onTransform 读取 |
| 44 | `TOO_LARGE_BODY` | 常量 | P | `{ __bodyLimitTooLarge: true }` 占位对象，短路默认解析 |
| 46 | `bodyLimitPlugin` | 常量/插件 | E | `new Elysia({ name: 'body-limit' })` |
| 47-66 | └ `onParse`（`as:'scoped'`） | 中间件 | P | 单次限流 JSON 解析 |
| 48 | └ content-type 读取 | 逻辑 | P | `ct = request.headers.get('content-type') ?? ''` |
| 49-50 | └ 非 JSON 放行 | 逻辑 | P | `ct` 非空且不含 `json`/`+json` → 返回 `undefined` |
| 52 | └ GET/HEAD 放行 | 逻辑 | P | `request.method === 'GET' \|\| 'HEAD'` → `undefined` |
| 53-65 | └ try `readJsonBody` | 逻辑 | P | 成功返回已解析对象（命中缓存） |
| 56-61 | └ `BodyTooLargeError` 处理 | 逻辑 | P | `tooLargeByRequest.set(request, e.message)` 并返回 `TOO_LARGE_BODY` 占位 |
| 62-64 | └ 其他错误透传 | 逻辑 | P | `throw e`（Invalid JSON / timeout / 空流） |
| 67-77 | └ `onTransform`（`as:'scoped'`） | 中间件 | P | 读取 stash 的超限消息 |
| 68-76 | └ 抛 `Error(status=413)` | 逻辑 | P | 命中则 delete 并抛普通 `Error(msg)`，`err.status = 413` |

## 关键行为

- **双解析消除**（L53-54）：`onParse` 返回非 `undefined` 即短路 Elysia 默认 `json()`，成功对象供后续 `body` 解构命中。
- **413 可达性桥接**（L56-60、L67-76）：`BodyTooLargeError` 不在此直抛（会被 compose 包成 `ParseError`，status=400），而是 stash 后在 `onTransform` 抛普通 `Error(status=413)`——此时 `code==='UNKNOWN'`，`errorsPlugin` 的 `status === 413` 分支可达。
- **刻意不用 `status(413,…)`**（L71-72）：`status()` 构造 `ElysiaCustomStatusResponse` 会被 `errorsPlugin` 的 `isStatusResponse` 穿透，绕过 413 双形。
- **非 JSON / GET / HEAD 不误抛**（L49-52）：避免对无 body 请求抛出 `'Invalid JSON'`。
- **单次限流边界复用**（L41-42、L54）：超限阈值与 drain/超时不变式由 `shared/http` 的 `readJsonBody` 提供（`MAX_BODY_SIZE` 默认 100MB，经 `CC_MAX_BODY_MB` 覆写），本插件不重载。
