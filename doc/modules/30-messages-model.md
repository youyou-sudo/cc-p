# 模块报告：src/modules/messages/model.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/messages/model.ts` |
| 行数 | 33 |
| 层级 | 协议层 |
| 依赖 | `elysia` |
| 被依赖 | `src/modules/messages/index.ts` |

## 职责

- 定义 Anthropic `/v1/messages` 请求体的 Elysia schema（`messagesBody`）：`model` 必填、`messages` 至少 1 项，其余字段宽松可选。
- 用 `additionalProperties:true` + `t.Any()` 保证未知/联合字段不触发 422 误杀。
- 将 schema 注册为 `.model({'messages.body': …})` 插件，供路由以字符串名引用。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | — | import | — | `elysia`（Elysia、t） |
| 3-4 | 收紧说明注释 | 逻辑 | P | 显式声明已知透传字段，未知字段靠 additionalProperties，联合写不全的靠 t.Any()，绝不 422 |
| 5-27 | `messagesBody` | 常量 | E | `t.Object({…}, { additionalProperties: true })` |
| 7 | └ `model` | 字段 | E | `t.String()`，必填（对齐 Anthropic 规范） |
| 8-14 | └ `messages` | 字段 | E | `t.Array(item, { minItems: 1 })`；item 为 `{ role: t.String(), content: t.Optional(t.Any()) }` 且 `additionalProperties:true` |
| 15-24 | └ 可选字段 | 字段 | E | `system`(Any)/`max_tokens`(Number)/`stream`(Boolean)/`thinking`(Any)/`tools`(Any)/`tool_choice`(Any)/`top_p`(Number)/`stop_sequences`(Any)/`metadata`(Any)/`prompt_cache_key`(String) |
| 26 | └ `additionalProperties` | 字段 | E | 顶层 `true`，未来字段直通 |
| 29 | `MessagesBody` | 类型 | E | `typeof messagesBody.static` |
| 31-33 | `messagesModelPlugin` | 常量 | E | `new Elysia({name:'messages.model'}).model({'messages.body': messagesBody})` |

## 关键行为

- `model` 必填（7）但 handler.ts:55 仍以 `anthropicReq.model || 'claude-sonnet-4-6'` 兜底，二者不冲突：validation 已挡缺失，兜底只防绕过路由的直调。
- `messages` 的 `minItems:1`（13）让空数组体在 validation 阶段被拒（400）。
- `additionalProperties:true`（11、26）是「绝不误杀未知透传字段」的实现核心，勿收紧为显式严格对象；`thinking`/`tools`/`tool_choice` 等联合类型统一用 `t.Any()`（18-20）同理。
