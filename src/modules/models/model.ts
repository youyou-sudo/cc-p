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
