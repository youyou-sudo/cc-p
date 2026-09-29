import { Elysia, t, type UnwrapSchema } from 'elysia'

// OpenAI `/v1/dashboard/billing/credit_grants` 的 credit_summary 形状。
// 仅作为单一真相源 + OpenAPI 文档存在；路由本身不加 response 校验
// （与 models 一致：handler 直接返回原始 Response，字段收紧后续再做）。
export const creditGrant = t.Object(
  {
    object: t.Literal('credit_grant'),
    id: t.String(),
    grant_amount: t.Number(),
    used_amount: t.Number(),
    // 上游不提供授予时刻/过期时刻：CC 额度不过期、按账单周期刷新，
    // 不臆造时间戳，统一 null。
    effective_at: t.Optional(t.Union([t.Number(), t.Null()])),
    expires_at: t.Optional(t.Union([t.Number(), t.Null()])),
  },
  { additionalProperties: true },
)

export const creditSummary = t.Object(
  {
    object: t.Literal('credit_summary'),
    total_granted: t.Number(),
    total_used: t.Number(),
    total_available: t.Number(),
    grants: t.Object(
      {
        object: t.Literal('list'),
        data: t.Array(creditGrant),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
)

export type BillingModel = {
  grant: UnwrapSchema<typeof creditGrant>
  summary: UnwrapSchema<typeof creditSummary>
}

export const billingModelPlugin = new Elysia({ name: 'billing.model' }).model({
  'billing.creditGrant': creditGrant,
  'billing.creditSummary': creditSummary,
})
