# 模块报告：src/app.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/app.ts` |
| 行数 | 21 |
| 层级 | 入口层 |
| 依赖 | `elysia`(Elysia) `./plugins/cors`(corsPlugin) `./plugins/errors`(errorsPlugin) `./plugins/body`(bodyLimitPlugin) `./plugins/auth`(authPlugin) `./modules/health/index`(healthController) `./modules/models/index`(modelsController) `./modules/chat/index`(chatController) `./modules/messages/index`(messagesController) |
| 被依赖 | `src/index.ts` |

## 职责

- 组装 Elysia 应用：按固定顺序 `.use()` 注册 4 个插件与 4 个 controller。
- 返回尚未 `.listen()` 的 app 实例，监听职责留给 `src/index.ts`。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-9 | — | import | — | `elysia`(Elysia)；`./plugins/cors`(corsPlugin) `./plugins/errors`(errorsPlugin) `./plugins/body`(bodyLimitPlugin) `./plugins/auth`(authPlugin)；`./modules/health/index`(healthController) `./modules/models/index`(modelsController) `./modules/chat/index`(chatController) `./modules/messages/index`(messagesController) |
| 11-21 | `createApp` | 函数 | E | 创建并返回装配完毕的 Elysia 实例（未 listen） |
| 12 | └ `new Elysia()` | 逻辑 | P | 应用根实例 |
| 13 | └ `.use(corsPlugin)` | 插件 | P | 最外层 CORS 处理 |
| 14 | └ `.use(errorsPlugin)` | 插件 | P | 注册 scoped `onError`（对之后注册的路由生效） |
| 15 | └ `.use(bodyLimitPlugin)` | 插件 | P | 注册 scoped `onParse`/`onTransform` 单次限流解析 |
| 16 | └ `.use(authPlugin)` | 插件 | P | 提供 `getApiKey` decorate 与 `requireAuth` macro |
| 17 | └ `.use(healthController)` | 路由 | P | 健康检查路由 |
| 18 | └ `.use(modelsController)` | 路由 | P | `/v1/models` 路由 |
| 19 | └ `.use(chatController)` | 路由 | P | `/v1/chat/completions` 路由 |
| 20 | └ `.use(messagesController)` | 路由 | P | `/v1/messages` 路由 |

## 关键行为

- **顺序即契约**（L13-20）：插件先于 controller 注册；`errorsPlugin`/`bodyLimitPlugin` 均为 `as: 'scoped'`，只对在其后注册的路由生效，因此必须排在 controller 之前。
- **auth 插件只提供能力**（L16）：`authPlugin` 不强制鉴权，仅 decorate `getApiKey` 并暴露 `requireAuth` macro；真正鉴权由各 controller 自行选择（`chat`/`messages` 用 `createAuthPreCheck`）。
- **无副作用**：`createApp` 不启动服务、不监听端口，可被测试安全复用。
