import { Elysia, t } from 'elysia'

// 收紧但仍宽松：显式声明已知字段便于提示/文档，未知未来字段靠
// additionalProperties:true；input/tools/reasoning 等联合写不全的靠 t.Any()，
// 绝不能 422 误杀（model 保持可选：缺省时 handler 回落默认模型，与 chat 一致）。
export const responsesBody = t.Object(
  {
    model: t.Optional(t.String()),
    input: t.Optional(t.Any()),
    instructions: t.Optional(t.Any()),
    stream: t.Optional(t.Boolean()),
    max_output_tokens: t.Optional(t.Number()),
    temperature: t.Optional(t.Number()),
    top_p: t.Optional(t.Number()),
    seed: t.Optional(t.Number()),
    user: t.Optional(t.String()),
    parallel_tool_calls: t.Optional(t.Boolean()),
    prompt_cache_key: t.Optional(t.String()),
    tools: t.Optional(t.Any()),
    tool_choice: t.Optional(t.Any()),
    reasoning: t.Optional(t.Any()),
    reasoning_effort: t.Optional(t.Any()),
    metadata: t.Optional(t.Any()),
    store: t.Optional(t.Boolean()),
    previous_response_id: t.Optional(t.Any()),
    truncation: t.Optional(t.Any()),
    text: t.Optional(t.Any()),
    include: t.Optional(t.Any()),
  },
  { additionalProperties: true },
)

export type ResponsesBody = typeof responsesBody.static

export const responsesModelPlugin = new Elysia({ name: 'responses.model' }).model({
  'responses.body': responsesBody,
})
