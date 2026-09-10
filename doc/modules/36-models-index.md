# 模块报告：src/modules/models/index.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/models/index.ts` |
| 行数 | 13 |
| 层级 | 协议层 |
| 依赖 | `elysia`、`./model`、`./service` |
| 被依赖 | `src/app.ts` |

## 职责

- `/v1/models` 控制器（模块入口）：注册 `modelsModelPlugin` 并挂载 `GET /` 路由。
- 将 `GET /v1/models` 委托给 `ModelsService.list(headers)`，只解构 headers，不传 Elysia Context。
- 统一再导出 model.ts 的校验模型与 service.ts 的 `ModelsService`，作为模块对外面。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 3-5 | — | import | — | `elysia` / `./model` / `./service` |
| 7-9 | `modelsController` | 插件 | E | `new Elysia({ name: 'models', prefix: '/v1/models' })`，`.use(modelsModelPlugin)` 后挂 `GET /` |
| 9 | `ModelsService.list(headers)` | 路由 | P | 路由处理器：`({ headers }) => ModelsService.list(headers)`，仅透传请求头 |
| 11 | `ModelsService` | 再导出 | E | 转发 `./service` |
| 12 | `listQuery` / `modelEntry` / `listResponse` / `modelsModel` | 再导出 | E | 转发 `./model`（`modelsModelPlugin` 重命名为 `modelsModel`） |
| 13 | `ModelsModel` | 再导出(type) | E | 转发 `./model` 的类型 |

## 关键行为

- 顶部注释（1-2）声明本层为「薄转发」：不加 response 校验、不用 guard，先保证行为一致；且只解构 headers 传给 Service，不传 Context（避免协议层与框架上下文耦合）。
- `prefix: '/v1/models'` 与 `.get('/')` 组合得到 `GET /v1/models`；`app.ts:18` 通过 `.use(modelsController)` 挂载。
- 再导出（11-13）使 `src` 其他位置可从模块入口取到 `ModelsService` 与校验模型，无需深入子文件。
