# 模块报告：src/plugins/auth.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/plugins/auth.ts` |
| 行数 | 70 |
| 层级 | 插件层 |
| 依赖 | `elysia`(Elysia) `../shared/auth`(authErrorMessage, getApiKey) |
| 被依赖 | `src/app.ts`、`src/modules/chat/index.ts`、`src/modules/messages/index.ts` |

## 职责

- 旧纯鉴权 helpers（`src/shared/auth.ts`）的 shim：`authPlugin` 只 decorate `getApiKey` 并提供一个 opt-in 的 `requireAuth` macro，默认不强制鉴权。
- 导出双协议 401 body 字面量（`openAI401Body`/`anthropic401Body`）与合并形状 `authErrorBody`。
- 提供 `createAuthPreCheck(isAnthropic)` 工厂，用于 `onTransform`/`derive` 阶段的鉴权前置检查。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | import | — | `elysia`(Elysia) `../shared/auth`(authErrorMessage, getApiKey) |
| 4-14 | — | 逻辑 | — | 注释：shim 背景、双协议说明、resolve 失败用 `status(401,…)` 而非 `new Response` |
| 15-23 | `authErrorBody` | 函数 | E | 合并形状：`{ error:{message,type:'auth_error'}, type:'error' }`，401 同时携带 OpenAI 与 Anthropic 形状 |
| 25-35 | `authPlugin` | 常量/插件 | E | `new Elysia({ name: 'auth' })` |
| 26 | └ `.decorate('getApiKey', getApiKey)` | 方法 | P | 将 `getApiKey` 注册为 decorator |
| 27-34 | └ `.macro({ requireAuth })` | 宏 | P | opt-in 鉴权宏，未 opt-in 的路由不受影响 |
| 29-33 | └ `resolve` | 方法 | P | 取 `getApiKey(headers)`；为空则 `throw status(401, authErrorBody(headers))`，否则返回 `{ apiKey }` |
| 37-39 | — | 逻辑 | — | 注释：per-protocol 401 字面量与旧 handler 逐字节一致，`authErrorBody` 不可在此复用 |
| 40 | `openAI401Body` | 函数 | E | `(msg) => ({ error: { message: msg, type: 'auth_error' } })` |
| 41-44 | `anthropic401Body` | 函数 | E | `(msg) => ({ type:'error', error:{ type:'authentication_error', message: msg } })` |
| 46-54 | — | 逻辑 | — | 注释：为何用 `return status` 而非 throw、为何 per-isAnthropic 字面量、为何不用 onParse/new Response/普通 Error |
| 55-69 | `createAuthPreCheck` | 函数 | E | 接收 `isAnthropic`，返回 `onTransform`/`derive` 用回调 |
| 56-69 | └ 返回回调 | 函数 | P | `({request,headers,status}) => …` |
| 65-68 | └ 判定逻辑 | 逻辑 | P | `getApiKey(h)` 存在则 `undefined`；否则 `status(401, isAnthropic ? anthropic401Body(msg) : openAI401Body(msg))` |

## 关键行为

- **默认不强制**（L25-27）：仅 decorate `getApiKey` 与声明 `requireAuth` macro，路由须显式 opt-in。
- **宏失败用抛出 `status(401,…)`**（L31）：`resolve` 抛出映射为短路响应，禁用 `new Response`。
- **合并形状 `authErrorBody` 只给 macro 用**（L15-23、L38-39）：`openAI401Body`/`anthropic401Body` 逐字节复刻旧 handler 字面量，二者不可互换。
- **预检返回而非抛出 `status`**（L46-54、L68）：Elysia 1.4.30 AoT 顺序为 parse → transform/derive → validation → beforeHandle/resolve；`onTransform`/`derive` 返回 `status(401,…)` 能抢在 validation 前短路，规避“无 key + 非法 schema”导致的 401→400 回归。
- **不引入 onParse/new Response/普通 Error**（L53-54）：`onParse` 返回值会变成 `c.body`，抛出的 `Error` 会被框架包成 `PARSE`。
