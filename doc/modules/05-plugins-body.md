# 模块报告：src/plugins/body.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/plugins/body.ts` |
| 行数 | 88 |
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
| 1-4 | — | import | — | `elysia`(Elysia) `../shared/http`(readJsonBody, BodyTooLargeError) `../shared/config`(MAX_BODY_SIZE) `../shared/logger`(log) |
| 5-43 | — | 逻辑 | — | 注释：机制说明——单次解析、短路默认 json()、413 为何走 onTransform、为何不用 `status()`、错误归一策略 |
| 45 | `tooLargeByRequest` | | 常量/字段 | P | `WeakMap<Request, string>`，暂存超限 message 供 onTransform 读取 |
| 46 | `TOO_LARGE_BODY` | | 常量 | P | `{ __bodyLimitTooLarge: true }` 占位对象，短路默认解析 |
| 48-88 | `bodyLimitPlugin` | | 常量/插件 | E | `new Elysia({ name: 'body-limit' })` |
| 49-68 | └ `onParse`（`as:'scoped'`） | 中间件 | P | 单次限流 JSON 解析 |
| 50 | └ content-type 读取 | 逻辑 | P | `ct = request.headers.get('content-type') ?? ''` |
| 51-52 | └ 非 JSON 放行 | 逻辑 | P | `ct` 非空且不含 `json`/`+json` → 返回 `undefined` |
| 53 | └ GET/HEAD 放行 | 逻辑 | P | `request.method === 'GET' \|\| 'HEAD'` → `undefined` |
| 54-67 | └ try `readJsonBody` | 逻辑 | P | 成功返回已解析对象；拒绝原因已由 `readJsonBody` 自身记录 |
| 58-63 | └ `BodyTooLargeError` 处理 | 逻辑 | P | `tooLargeByRequest.set(request, e.message)` 并返回 `TOO_LARGE_BODY` 占位 |
| 64-66 | └ 其他错误透传 | 逻辑 | P | `throw e`（Invalid JSON / timeout / 空流） |
| 71-88 | └ `onTransform`（`as:'scoped'`） | 中间件 | P | 读取 stash 的超限消息 |
| 72-86 | └ 记日志并抛 `Error(status=413)` | 逻辑 | P | 先记 `Body limit enforced`（path/method/limitBytes），再 delete 并抛普通 `Error(msg)`，`err.status = 413` |

## 关键行为

- **双解析消除**（L54）：`onParse` 返回非 `undefined` 即短路 Elysia 默认 `json()`，成功对象供后续 `body` 解构命中。
- **413 可达性桥接**（L58-62、L72-86）：`BodyTooLargeError` 不在此直抛（会被 compose 包成 `ParseError`，status=400），而是 stash 后在 `onTransform` 抛普通 `Error(status=413)`——此时 `code==='UNKNOWN'`，`errorsPlugin` 的 `status === 413` 分支可达。
- **刻意不用 `status(413,…)`**（L84-85）：`status()` 构造 `ElysiaCustomStatusResponse` 会被 `errorsPlugin` 的 `isStatusResponse` 穿透，绕过 413 双形。
- **执法点记录 path**（L75-79）：`readJsonBody` 只知道 method 与 `content-length`，无法定位是哪个端点被灌大包；此处补记 path 才能把客户端 bug 与定向攻击区分开。两侧互补：`readJsonBody` 记拒绝原因（预检 / 流式超限 / 排水中止），本插件记来源端点。
- **非 JSON / GET / HEAD 不误抛**（L51-53）：避免对无 body 请求抛出 `'Invalid JSON'`。
- **单次限流边界复用**（L42-43、L54）：超限阈值与 drain/超时不变式由 `shared/http` 的 `readJsonBody` 提供（`MAX_BODY_SIZE` 默认 100MB，经 `CC_MAX_BODY_MB` 覆写），本插件不重载。
