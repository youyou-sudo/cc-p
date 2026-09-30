# 模块报告：src/infra/proxy-slot.ts

| 项 | 值 |
|---|---|
| 文件 | `src/infra/proxy-slot.ts` |
| 行数 | 219 |
| 层级 | 共享管道层（⚠ **已实现未接线**） |
| 导入 | `../shared/config`(CFG) `../shared/concurrency`(ConcurrencyGate, ConcurrencyRoomFull, ConcurrencyTimeout) `../shared/api-keys`(parseApiKeyEnv, resolveUpstreamKey, setPoolStrategy, ApiKeyPool) `../shared/limit`(limitMeta) `../shared/retry`(parseRetryAfter, backoffDelay, sleep) `./cc`(forwardToCC) `../shared/errors`(mapCcError, MappedError) `./fingerprint`(ensureInitialized) `../shared/logger`(log) `./proxy-handler`(UpstreamCallArgs 类型) |
| 导入方 | **无**。全仓无任何文件 import 本模块。 |

## 职责

为 `/alpha/generate` 上游调用提供**多 API Key 池化 + 并发闸门 + 限流退避**的封装，
是 `infra/proxy-handler.ts` 的增强替代路径。当前生产代码未使用（见「未接线原因」）。

## 关键实现

| 行号 | 符号 | 可见性 | 说明 |
|---|---|---|---|
| 16-20 | `gate` | P | 模块级 `ConcurrencyGate` 单例，按 `CFG.maxConcurrencyPerKey` / `maxQueuePerKey` / `queueTimeoutMs` 构造 |
| 22-27 | `keyPool` | P | `ApiKeyPool` 实例，策略取自 `CFG.keySelectionStrategy`（`roundRobin` / `affinity`），来源 `parseApiKeyEnv` |
| 29-33 | `upstreamKeyFor` | **E** | `resolveUpstreamKey(clientKey, keyPool)`：把客户端 Key 映射为上游 Key |
| 35-37 | `upstreamPoolInfo` | **E** | 返回 `{keys, strategy}`，供启动日志 / `/health` 观测池规模 |
| 39-76 | `concurrencyErrorToMapped` | P | 把 `ConcurrencyRoomFull` / `ConcurrencyTimeout` 归一化为 `MappedError`（`queue_full` / `timeout` 分类） |
| 78-108 | `isSafeToRetry` | P | **重试幂等性护栏**：只重试可证明「上游未接受」的失败（429 / 401 / 402）；**5xx 一律不重试** |
| 109-111 | `isSafeToRetryForTest` | **E** | 测试用再导出，使决策表无需拉起整条上游链路即可断言 |
| 113-218 | `callUpstreamWithSlots<T>` | **E** | 主入口：取 Key → 抢并发位 → `ensureInitialized` → `forwardToCC` → 非 2xx 走 `mapCcError` + `limitMeta` + 退避重试（受幂等性护栏约束） |
| 143 | — | P | 实际转发，签名比 `proxy-handler` 多一个 `upstreamKey` 参数 |
| 149-150 | — | P | 读取 `Retry-After` 头并交给 `mapCcError` |
| 154-159 | — | P | 从映射结果取 `error.category`，喂给 `limitMeta` 判定限流语义 |
| 160-169 | — | P | 日志同时给出 `retryable`（是否瞬时）与 `safeToRetry`（是否可重复），二者语义不同 |
| 175-177 | — | P | 决策点：不可安全重试 / 超 `retryMax` / 已 abort → 直接返回错误 |
| 179-196 | — | P | 退避时长：`parseRetryAfter` 优先、其次 `backoffDelay`，再被 `clientDeadlineAt` 剩余时间截断 |
| 187-195 | — | P | deadline 已过 → 不再重试（避免重试活得比请求方更久，对非幂等端点等于白生成一次） |

## 未接线原因

`modules/chat/handler.ts:62` 与 `modules/messages/handler.ts:74` 直接调用
`infra/proxy-handler.ts` 的 `createUpstreamFlow` / `callUpstream`，
**绕过本模块**。因此以下能力在生产路径上全部未生效：

- 多 Key 轮询 / 亲和（`CC_KEY_SELECTION_STRATEGY`、`CC_API_KEYS` 池）
- 每 Key 并发上限与排队（`CFG.maxConcurrencyPerKey` / `maxQueuePerKey` / `queueTimeoutMs`）
- 上游限流退避重试（`CFG.retryMax` / `retryBaseMs` / `retryCapMs`）

**连带影响**：`shared/api-keys.ts`(75L)、`shared/concurrency.ts`(220L)、
`shared/limit.ts`(177L)、`shared/retry.ts`(33L) 四个文件**仅**被本模块引用，
因此随本模块一同未接线。它们的行为由 `test/unit.ts` 的 41 项断言覆盖（全部通过），
但生产运行时不会加载。

## 接入前必须已解决（均已落地）

### 1. 重试幂等性 —— 已加护栏

`/alpha/generate` **非幂等**：`ccBody` 由 `buildCcRequest` 从完整对话历史构建，重试即重发整个会话。原先的决策依据是 `limitMeta(...).retryable`，它回答的是「失败是否瞬时」，**不是**「工作是否已经发生」。

`isSafeToRetry`（78-108）把规则收窄到可证明未被接受的失败：

| 状态 | 是否重试 | 理由 |
|---|---|---|
| 429 | ✅ | 在准入阶段被拒，未开始生成 |
| 401 / 402 | ✅ | 同样在生成前被拒 |
| 5xx | ❌ | 上游可能已接受并计费后才响应失败，重发即双倍计费 |
| 4xx 其他 | ❌ | 非瞬时 |

**这是收窄而非替换** `limitMeta`。若将来上游对某状态码明确保证幂等，只需改这一处。

日志同时输出 `retryable` 与 `safeToRetry`，因为二者语义不同 —— 排查时需要能看出「被判为瞬时但因不安全而未重试」。

### 2. 客户端 deadline —— 已加

新增可选 `UpstreamCallArgs.clientDeadlineAt` 与 `clientDeadlineFrom(headers)`（读取 `x-request-timeout-ms`）。退避时长被剩余时间截断（179-196），deadline 已过则不重试。

**该 header 不设即不启用截断** —— 不猜测默认值，因为猜测可能砍掉本会成功的重试。

## 接入建议

1. 在两个 handler 中把 `createUpstreamFlow` + `callUpstream` 的组合替换为
   `callUpstreamWithSlots`，透传 `UpstreamCallArgs`。
2. 在 handler 入口按 `CFG.maxConcurrencyPerKey` 语义补 429 返回（`queue_full` /
   `ConcurrencyTimeout` 两种分类需分别映射到对外状态码）。
3. 启动日志接入 `upstreamPoolInfo()`，避免池为空时静默。
4. 接入后需重跑 `test/e2e.ts`（当前 e2e 走 `src/index.ts`，会覆盖新路径）。
5. 注意 `config.json` 当前**并未声明**这 7 项配置（`maxConcurrencyPerKey` 等），
   它们只有 `shared/config.ts` 里的内置默认值，需先写入 config.json 才会生效。

## 覆盖测试

`test/logging.ts` 第 7 组（`retry:` / `deadline:` 前缀，11 项断言）经
`isSafeToRetryForTest` 与 `clientDeadlineFrom` 验证决策表，无需拉起上游链路。
