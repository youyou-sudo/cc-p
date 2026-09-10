import { Elysia, t } from 'elysia'

// 收紧但仍宽松：显式声明已知透传字段便于提示/文档，未知未来字段靠 additionalProperties:true，
// tools/tool_choice/reasoning_effort 等联合写不全的靠 t.Any()，绝不能 422 误杀。
export const chatBody = t.Object(
  {
    model: t.Optional(t.String()),
    messages: t.Array(
      t.Object(
        { role: t.String(), content: t.Optional(t.Any()) },
        { additionalProperties: true },
      ),
      { minItems: 1 },
    ),
    stream: t.Optional(t.Boolean()),
    max_tokens: t.Optional(t.Number()),
    temperature: t.Optional(t.Number()),
    top_p: t.Optional(t.Number()),
    seed: t.Optional(t.Number()),
    stop: t.Optional(t.Union([t.String(), t.Array(t.String())])),
    user: t.Optional(t.String()),
    parallel_tool_calls: t.Optional(t.Boolean()),
    prompt_cache_key: t.Optional(t.String()),
    tools: t.Optional(t.Any()),
    tool_choice: t.Optional(t.Any()),
    reasoning_effort: t.Optional(t.Any()),
  },
  { additionalProperties: true },
)

export type ChatBody = typeof chatBody.static

export const chatModelPlugin = new Elysia({ name: 'chat.model' }).model({
  'chat.body': chatBody,
})
