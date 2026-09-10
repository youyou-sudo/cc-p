# 模块报告：src/modules/chat/index.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/chat/index.ts` |
| 行数 | 18 |
| 层级 | 协议层 |
| 依赖 | `elysia`、`./model`、`./service`、`../../plugins/auth` |
| 被依赖 | `src/app.ts`（`import { chatController }`） |

## 职责

- chat 模块公共入口：创建 `name:'chat'`、`prefix:'/v1'` 的 Elysia 控制器，挂载唯一路由 `POST /v1/chat/completions`。
- 按固定顺序装配 body schema 校验与鉴权前置，无 key 时在 validation 之前短路返回 401。
- 通过底部 re-export 对外暴露 `ChatService`、`chatBody`、`chatModel`、`ChatBody`。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-4 | — | import | — | `elysia`；`./model`(chatModelPlugin)；`./service`(ChatService)；`../../plugins/auth`(createAuthPreCheck) |
| 6-14 | `chatController` | 常量 | E | Elysia 实例：`name:'chat'`、`prefix:'/v1'`，链式注册插件与路由 |
| 7 | `.use(chatModelPlugin)` | 插件 | P | 注册 `'chat.body'` 校验模型，供下方路由 `body` 引用 |
| 13 | `.onTransform({ as: 'local' }, createAuthPreCheck(false))` | 插件 | P | OpenAI 形态 401 前置：无 key 直接 `status(401)`，短路 validation |
| 14 | `.post('/chat/completions', …)` | 路由 | P | `body:'chat.body'`；处理器调 `ChatService.handleBody(body, headers, request.signal)` |
| 16 | `ChatService` | 重导出 | E | `export { ChatService } from './service'` |
| 17 | `chatBody` / `chatModel` | 重导出 | E | `chatBody` 原样、`chatModelPlugin` 别名 `chatModel` |
| 18 | `ChatBody` | 重导出(type) | E | `export type { ChatBody } from './model'` |

## 关键行为

- 执行顺序由注释 8-12 固定：`onParse`(bodyLimit) → `onTransform`(413) → `onTransform`(auth 401 前置) → validation(400, `body:'chat.body'`) → handler。
- `{ as: 'local' }`（13）只作用本实例本路由，不上浮 parent app，避免 scoped 污染兄弟路由（messages 误回 chat 形状）。
- 鉴权放在 `onTransform` 而非 guard/resolve/macro：Elysia AoT 中 transform 早于 validation，可避免「无 key + 非法 schema」误报 400；插件内用 `return status(401,…)` 短路而非抛出（见 `src/plugins/auth.ts:46-69`）。
- `createAuthPreCheck(false)` 的 `false` 表示 OpenAI 错误体（Anthropic 形态传 `true`）。
