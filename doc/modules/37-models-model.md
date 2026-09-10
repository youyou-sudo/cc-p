# 模块报告：src/modules/models/model.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/models/model.ts` |
| 行数 | 33 |
| 层级 | 协议层 |
| 依赖 | `elysia` |
| 被依赖 | `src/modules/models/index.ts` |

## 职责

- 定义 `/v1/models` 的 query/response JSON Schema（单一真相源）。
- 通过 `modelsModelPlugin` 注册 `models.entry` / `models.list` 具名模型，供 Elysia 校验复用。
- 导出 `ModelsModel` 类型（由 `UnwrapSchema` 推导），供类型层消费。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | — | import | — | `elysia`（`Elysia`、`t`、`UnwrapSchema`） |
| 4 | `listQuery` | 常量 | E | `t.Object({})`，GET 无 body/params，query 为空占位 |
| 6-15 | `modelEntry` | 常量 | E | 模型条目 schema：`id` 必填 String；`object`/`created`/`owned_by`/`context_window` 可选；`additionalProperties: true` |
| 17-23 | `listResponse` | 常量 | E | `object: t.Literal('list')` + `data: t.Array(modelEntry)`，`additionalProperties: true` |
| 25-28 | `ModelsModel` | type | E | `{ entry: UnwrapSchema<typeof modelEntry>; list: UnwrapSchema<typeof listResponse> }` |
| 30-33 | `modelsModelPlugin` | 插件 | E | `new Elysia({ name: 'models.model' }).model({ 'models.entry': modelEntry, 'models.list': listResponse })` |

## 关键行为

- `modelEntry` 与 `listResponse` 都设 `additionalProperties: true`（14、22 行），允许上游返回未声明字段而不被拒绝。
- `id` 是唯一必填字段；其余字段均由 catalog 的 `handleModels` 按需填充。
- 插件仅做 schema 注册，不定义路由；由 `index.ts:8` 的 `.use(modelsModelPlugin)` 引入。
