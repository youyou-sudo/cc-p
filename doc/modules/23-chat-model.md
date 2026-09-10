# 模块报告：src/modules/chat/model.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/chat/model.ts` |
| 行数 | 35 |
| 层级 | 协议层 |
| 依赖 | `elysia` |
| 被依赖 | `src/modules/chat/index.ts`（`chatModelPlugin`、`chatBody`、`ChatBody`） |

## 职责

- 定义 `POST /v1/chat/completions` 的 Elysia body schema `chatBody`。
- 宽松校验：显式声明已知透传字段，未知未来字段靠 `additionalProperties:true`，绝不因 schema 不全而 422 误杀。
- 以 Elysia model 插件注册命名模型 `'chat.body'`。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | — | import | — | `elysia`(Elysia, t) |
| 5-29 | `chatBody` | 常量 | E | `t.Object({…}, { additionalProperties: true })` body schema |
| 7-26 | └ 字段声明 | 逻辑 | P | model/messages/stream/max_tokens/temperature/top_p/seed/stop/user/parallel_tool_calls/prompt_cache_key 显式声明；tools/tool_choice/reasoning_effort 用 `t.Any()` |
| 8-14 | └ `messages` | 逻辑 | P | `t.Array(t.Object({role, content?}, {additionalProperties:true}), {minItems:1})` |
| 31 | `ChatBody` | type | E | `typeof chatBody.static` |
| 33-35 | `chatModelPlugin` | 常量 | E | `new Elysia({name:'chat.model'}).model({'chat.body': chatBody})` |

## 关键行为

- `additionalProperties:true` 在对象层与 messages 项层双保险（11、28），保证未知字段透传不报错。
- `messages` 至少 1 项（`minItems:1`）；`role` 必填、`content` 可选（允许仅含 `tool_calls` 的 assistant 消息）。
- 未声明字段一律放行，实际取值由 `../../infra/cc` 的 `buildCcRequest` 按需读取。
