# 模块报告：src/infra/proxy-slot.ts

| 项 | 值 |
|---|---|
| 文件 | `src/infra/proxy-slot.ts` |
| 行数 | 164 |
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
| 78-163 | `callUpstreamWithSlots<T>` | **E** | 主入口：取 Key → 抢并发位 → `ensureInitialized` → `forwardToCC` → 非 2xx 走 `mapCcError` + `limitMeta` + 指数退避重试 |
| 108 | — | P | 实际转发，签名比 `proxy-handler` 多一个 `upstreamKey` 参数 |
| 114-115 | — | P | 读取 `Retry-After` 头并交给 `mapCcError` |
| 119-137 | — | P | 从映射结果取 `error.category`，喂给 `limitMeta` 判定限流语义 |
| 138-142 | — | P | `parseRetryAfter` 优先，其次 `backoffDelay` 指数退避，`Math.max` 取较大等待 |

## 未接线原因

`modules/chat/handler.ts:51` 与 `modules/messages/handler.ts:64` 直接调用
`infra/proxy-handler.ts` 的 `createUpstreamFlow` / `callUpstream`，
**绕过本模块**。因此以下能力在生产路径上全部未生效：

- 多 Key 轮询 / 亲和（`CC_KEY_SELECTION_STRATEGY`、`CC_API_KEYS` 池）
- 每 Key 并发上限与排队（`CFG.maxConcurrencyPerKey` / `maxQueuePerKey` / `queueTimeoutMs`）
- 上游限流退避重试（`CFG.retryMax` / `retryBaseMs` / `retryCapMs`）

**连带影响**：`shared/api-keys.ts`(75L)、`shared/concurrency.ts`(220L)、
`shared/limit.ts`(177L)、`shared/retry.ts`(33L) 四个文件**仅**被本模块引用，
因此随本模块一同未接线。它们的行为由 `test/unit.ts` 的 41 项断言覆盖（全部通过），
但生产运行时不会加载。

## 接入建议

1. 在两个 handler 中把 `createUpstreamFlow` + `callUpstream` 的组合替换为
   `callUpstreamWithSlots`，透传 `UpstreamCallArgs`。
2. 在 handler 入口按 `CFG.maxConcurrencyPerKey` 语义补 429 返回（`queue_full` /
   `ConcurrencyTimeout` 两种分类需分别映射到对外状态码）。
3. 启动日志接入 `upstreamPoolInfo()`，避免池为空时静默。
4. 接入后需重跑 `test/e2e.ts`（当前 e2e 走 `src/index.ts`，会覆盖新路径）。
