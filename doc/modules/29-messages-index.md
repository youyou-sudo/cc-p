# 模块报告：src/modules/messages/index.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/messages/index.ts` |
| 行数 | 18 |
| 层级 | 协议层 |
| 依赖 | `elysia`、`./model`、`./service`、`../../plugins/auth` |
| 被依赖 | `src/app.ts` |

## 职责

- 组装 `/v1/messages` 控制器：`prefix:'/v1'` + `POST /messages`，挂载 body schema 插件。
- 在本实例局部（`as:'local'`）前置 Anthropic 鉴权，缺失 Key 直接 401 短路后续 validation。
- 对外 re-export service/model，供 `app.ts` 与单测引用，保持模块入口门面。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-4 | — | import | — | `elysia`；`./model`(messagesModelPlugin)；`./service`(MessagesService)；`../../plugins/auth`(createAuthPreCheck) |
| 6-14 | `messagesController` | 常量 | E | `new Elysia({name:'messages', prefix:'/v1'}).use(messagesModelPlugin)`，实际路由为 `/v1/messages` |
| 8-12 | 顺序注释 | 逻辑 | P | 说明 onParse(bodyLimit) → onTransform(413 哨兵) → onTransform(auth 401) → validation(400) → handler；并解释 `local` 不上浮避免污染兄弟路由 |
| 13 | `.onTransform({ as:'local' }, createAuthPreCheck(true))` | 插件 | E | 仅本实例本路由的 Anthropic 鉴权前置；无 Key 时 return status 短路 validation（返回 401 而非 400） |
| 14 | `.post('/messages', …)` | 路由 | E | handler 调 `MessagesService.handleBody(body, headers, request.signal)`，body schema 名 `'messages.body'` |
| 16 | `MessagesService` | 导出 | E | 从 `./service` re-export |
| 17 | `messagesBody`、`messagesModelPlugin as messagesModel` | 导出 | E | 从 `./model` re-export |
| 18 | `MessagesBody` | 类型 | E | 从 `./model` re-export（type-only） |

## 关键行为

- 中间件顺序即注释 8-12：`bodyLimit`（onParse）→ 413 哨兵（onTransform）→ 鉴权（onTransform）→ schema validation → handler；鉴权在 validation 之前，因此无 Key 的畸形体返回 401 而非 400。
- `as:'local'`（13）是关键作用域选择：local 只作用本实例本路由，不上浮 parent app，避免覆盖 chat 等兄弟路由的 401 行为。
- `prefix:'/v1'`（6）决定最终路径为 `POST /v1/messages`，不影响 health/models。
