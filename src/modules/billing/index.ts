import { Elysia } from 'elysia'
import { billingModelPlugin } from './model'
import { BillingService } from './service'
import { createAuthPreCheck } from '../../plugins/auth'

// POST 之外的只读 GET：与 chat 同用 auth 前置（无 key → OpenAI 形 401），
// 但 as:'local' 只作用于本实例，不上浮污染兄弟路由。
// prefix '/v1' + 完整 OpenAI billing 路径，客户端换 base_url 即可直接调用。
export const billingController = new Elysia({ name: 'billing', prefix: '/v1' })
  .use(billingModelPlugin)
  .onTransform({ as: 'local' }, createAuthPreCheck(false))
  .get('/dashboard/billing/credit_grants', ({ headers }) => BillingService.creditSummary(headers))

export { BillingService, buildCreditSummary } from './service'
export { creditGrant, creditSummary, billingModelPlugin as billingModel } from './model'
export type { BillingModel } from './model'
export type { CreditSummary } from './service'
