import { Elysia, t, type UnwrapSchema } from 'elysia'

// GET /v1/models 无 body/params，query 为空占位，保持 model.ts 单一真相源形状。
export const listQuery = t.Object({})

export const modelEntry = t.Object(
  {
    id: t.String(),
    object: t.Optional(t.String()),
    created: t.Optional(t.Number()),
    owned_by: t.Optional(t.String()),
    context_window: t.Optional(t.Number()),
    max_output_tokens: t.Optional(t.Number()),
    // 该模型允许的 reasoning_effort 档位（low|medium|high|xhigh|max 的子集）。
    reasoning_efforts: t.Optional(t.Array(t.String())),
    // vision 声明（多别名兼容各客户端解析器，原有字段不动，additionalProperties 仍 true）。
    modalities: t.Optional(t.Array(t.String())),
    input_modalities: t.Optional(t.Array(t.String())),
    supported_modalities: t.Optional(t.Array(t.String())),
    supports_vision: t.Optional(t.Boolean()),
    vision: t.Optional(t.Boolean()),
    features: t.Optional(t.Array(t.String())),
  },
  { additionalProperties: true },
)

export const listResponse = t.Object(
  {
    object: t.Literal('list'),
    data: t.Array(modelEntry),
  },
  { additionalProperties: true },
)

export type ModelsModel = {
  entry: UnwrapSchema<typeof modelEntry>
  list: UnwrapSchema<typeof listResponse>
}

export const modelsModelPlugin = new Elysia({ name: 'models.model' }).model({
  'models.entry': modelEntry,
  'models.list': listResponse,
})
