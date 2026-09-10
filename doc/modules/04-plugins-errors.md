# 模块报告：src/plugins/errors.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/plugins/errors.ts` |
| 行数 | 60 |
| 层级 | 插件层 |
| 依赖 | `elysia`(Elysia) `../shared/config`(MAX_BODY_SIZE) |
| 被依赖 | `src/app.ts` |

## 职责

- 复用 `src/index.ts` 旧有 `onError` 分支：`NOT_FOUND`(404) / `413` / `PARSE` / `VALIDATION` / 500 兜底。
- 按路径选择错误形状：`/v1/messages` 用 Anthropic `{ type:'error', error:… }`，其余用 OpenAI `{ error:… }`。
- 以 `as:'scoped'` 注册，只作用于 `app.use(errorsPlugin)` 之后注册的路由。
- 对 `status()` 抛出的 `ElysiaCustomStatusResponse` 放行，交还 Elysia 默认映射。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | import | — | `elysia`(Elysia) `../shared/config`(MAX_BODY_SIZE) |
| 4-14 | — | 逻辑 | — | 注释：说明复用 onError 分支、双协议形状、`status()` 错误穿透、不新增 response schema |
| 15-20 | `jsonResponse` | 函数 | P | 以 `JSON.stringify` 构造带 `Content-Type: application/json` 的 `Response` |
| 22-30 | `isStatusResponse` | 函数 | P | 判断 `error` 是否为 `ElysiaCustomStatusResponse`（含 `code`/`response` 字段且构造器名匹配） |
| 32 | `errorsPlugin` | 常量/插件 | E | `new Elysia({ name: 'errors' })` |
| 38-59 | └ `onError`（`as:'scoped'`） | 中间件 | P | 错误归一化主逻辑 |
| 39 | └ 穿透分支 | 逻辑 | P | `isStatusResponse(error)` → 返回 `undefined`，交 Elysia 默认映射 |
| 41-43 | └ `NOT_FOUND` → 404 | 逻辑 | P | `{ error: { message:'Not found', type:'not_found' } }` |
| 44-57 | └ 413 / PARSE / VALIDATION | 逻辑 | P | 按 `status === 413` 或 `code === 'PARSE'`/`'VALIDATION'` 分派 |
| 45-52 | └ 413 双形 | 逻辑 | P | 计算 MB 提示；`/v1/messages` 返回 Anthropic 形，否则 OpenAI 形 |
| 53-56 | └ 400 双形 | 逻辑 | P | 非 413 时 message 固定 `'Invalid JSON body'`，按路径选形状 |
| 58-59 | └ 500 兜底 | 逻辑 | P | `error.message ?? 'Internal error'`，返回 `internal_error` |

## 关键行为

- **scoped 而非 local/global**（L33-37 注释、L38）：`local` 漏掉 `NOT_FOUND`，`global` 会劫持更早注册的路由；scoped 恰好覆盖其后的 controller。
- **`status()` 错误穿透**（L39）：`requireAuth` 宏或 `createAuthPreCheck` 抛出的 401 由 Elysia 默认渲染，不被此处改写。
- **双协议分支仅按 URL pathname**（L45、L48、L53）：`path === '/v1/messages'` 时用 Anthropic 顶层 `{type:'error'}`；否则 OpenAI `{error:{…}}`。
- **PARSE/VALIDATION 强制归一为 400**（L44-56）：对外永不漏 422；原始 message 保留在 cause 链（由框架包装）。
- **500 透传 message**（L58-59）：非上述情况统一 `internal_error`，message 取 `error.message` 或 `'Internal error'`。
