import { Elysia, t, type UnwrapSchema } from 'elysia'

// GET /v1/models 无 body/params，query 为空占位，保持 model.ts 单一真相源形状。
// 注：Claude Code 会带 `?limit=1000`（网关模型发现）与 `?beta=true`，
// `additionalProperties: true` 保证这些未知 query 不被 422 误杀。
export const listQuery = t.Object({}, { additionalProperties: true })

export const modelEntry = t.Object(
  {
    id: t.String(),
    object: t.Optional(t.String()),
    created: t.Optional(t.Number()),
    owned_by: t.Optional(t.String()),
    // 人类可读名（Anthropic 形必需；OpenAI 形一并给出，客户端可选用）。
    display_name: t.Optional(t.String()),
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

// ── Anthropic 形（同一路径，按 anthropic-version 头分流）────────────────
// Anthropic ModelInfo：type/id/display_name/created_at（ISO8601）+ 可选 description。
// 不带 object/created（那是 OpenAI 形），避免把两种契约混在一份 body 里。
export const anthropicModelInfo = t.Object(
  {
    type: t.Literal('model'),
    id: t.String(),
    display_name: t.String(),
    created_at: t.String(),
    description: t.Optional(t.String()),
  },
  { additionalProperties: true },
)

// 分页三件套是 Anthropic list 契约的一部分（SDK 的 hasNextPage/nextPageRequestOptions
// 读 has_more/last_id/first_id），缺了会让 after_id 分页拿不到游标。
export const anthropicListResponse = t.Object(
  {
    data: t.Array(anthropicModelInfo),
    has_more: t.Boolean(),
    first_id: t.Union([t.String(), t.Null()]),
    last_id: t.Union([t.String(), t.Null()]),
  },
  { additionalProperties: true },
)

export type ModelsModel = {
  entry: UnwrapSchema<typeof modelEntry>
  list: UnwrapSchema<typeof listResponse>
  anthropicEntry: UnwrapSchema<typeof anthropicModelInfo>
  anthropicList: UnwrapSchema<typeof anthropicListResponse>
}

export const modelsModelPlugin = new Elysia({ name: 'models.model' }).model({
  'models.entry': modelEntry,
  'models.list': listResponse,
  'models.anthropicEntry': anthropicModelInfo,
  'models.anthropicList': anthropicListResponse,
})
