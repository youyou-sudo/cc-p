import { Elysia, t } from 'elysia'

// 收紧但仍宽松：显式声明已知透传字段便于提示/文档，未知未来字段靠 additionalProperties:true，
// thinking/tools 等联合写不全的靠 t.Any()，绝不能 422 误杀。model 保持必填（对齐 Anthropic 规范）。
export const messagesBody = t.Object(
  {
    model: t.String(),
    messages: t.Array(
      t.Object(
        { role: t.String(), content: t.Optional(t.Any()) },
        { additionalProperties: true },
      ),
      { minItems: 1 },
    ),
    system: t.Optional(t.Any()),
    max_tokens: t.Optional(t.Number()),
    stream: t.Optional(t.Boolean()),
    thinking: t.Optional(t.Any()),
    tools: t.Optional(t.Any()),
    tool_choice: t.Optional(t.Any()),
    top_p: t.Optional(t.Number()),
    stop_sequences: t.Optional(t.Any()),
    metadata: t.Optional(t.Any()),
    prompt_cache_key: t.Optional(t.String()),
  },
  { additionalProperties: true },
)

export type MessagesBody = typeof messagesBody.static

export const messagesModelPlugin = new Elysia({ name: 'messages.model' }).model({
  'messages.body': messagesBody,
})
