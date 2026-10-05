# 模块报告：src/shared/runtime.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/shared/runtime.ts` |
| 行数 | 165 |
| 层级 | 基础设施层 |
| 依赖 | `./config`、`./logger` |
| 被依赖 | `src/modules/chat/handler.ts`、`src/modules/messages/handler.ts` |

## 职责

- 维护**按 (apiKey, session) 隔离**的连续空闲超时计数，避免一个客户端/会话的慢请求影响另一个客户端的超时提示。
- 从 `./config` 重导出三个空闲超时常量，并实现按 CC 事件类型与流式与否选择 per-read 超时预算。
- 生成人类可读的超时消息与机器可读的超时诊断字段。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-8 | 模块头注释 | 逻辑 | — | 说明隔离语义、成功即删、TTL 懒清理、map 有界 |
| 10 | 重导出 | import | E | `export { NONSTREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, THINKING_IDLE_TIMEOUT_MS } from './config'`，保持旧导入路径兼容 |
| 10 | — | import | — | 本地再 import 三个超时常量供 `idleTimeoutFor` 使用 |
| 12 | `TIMEOUT_REDUCE_CONTEXT_THRESHOLD` | 常量 | E | 连续超时达到 3 次时提示可能需减少上下文 |
| 13-14 | `TIMEOUT_LARGE_CONTEXT_TOKENS` | 常量 | E | 80_000；仅当实际知道输入很大时才建议缩减上下文 |
| 16-17 | `TIMEOUT_STATE_TTL_MS` | 常量 | P | 30 分钟；超过未更新的条目被清理或视为重置 |
| 19-22 | `TimeoutEntry` | interface | P | `{ consecutiveTimeouts: number; lastUpdatedAt: number }` |
| 24 | `timeoutStates` | 字段 | P | `Map<string, TimeoutEntry>`，模块级单例状态 |
| 26-32 | `scopeKey` | 函数 | E | 作用域键：`` `${apiKey}::${sessionId \|\| 'default'}` ``；缺省 session 落入 `default` 桶 |
| 34-36 | `legacyKey` | 函数 | P | 返回裸 `apiKey`，作为升级前旧键的读取兜底 |
| 38-42 | `pruneStale` | 函数 | P | 遍历 map，删除 `now - lastUpdatedAt > TTL` 的条目（懒清理） |
| 44-48 | `freshCount` | 函数 | P | 取条目的 `consecutiveTimeouts`；缺失或过期返回 0 |
| 50-62 | `entryFor` | 函数 | P | 取或新建条目（缺失/过期则以 `{consecutiveTimeouts:0, lastUpdatedAt:now}` 覆盖写入） |
| 64-82 | `recordTimeout` | 函数 | E | 命中空闲超时：`timeoutStates.size > 0` 时先 `pruneStale`，取 `entryFor(scopeKey(...))` 后自增并刷新时间戳 |
| 84-101 | `recordTimeoutSuccess` | 函数 | E | 成功完成：删除 `scopeKey` 条目；`sessionId === undefined` 时额外删除裸 `legacyKey` 旧条目 |
| 103-110 | `consecutiveTimeouts` | 函数 | E | 返回作用域计数；有 session 时只读 scoped；无 session 时取 `max(scoped, legacy)` 以兼容滚动升级 |
| 112-116 | `TimeoutMessageOptions` | interface | E | `{ inputTokens?: number; timeoutMs?: number; sessionId?: string }` |
| 118-130 | `timeoutMessage` | 函数 | E | 见关键行为 |
| 132-136 | `TimeoutDetailsOptions` | interface | E | `{ timeoutMs?: number; sessionId?: string }` |
| 138-150 | `timeoutDetails` | 函数 | E | 返回 `{ consecutiveTimeouts, timeoutMs? }`，仅当 `timeoutMs != null` 时带上该字段 |
| 152-160 | `isThinkingWait` | 函数 | E | `lastCcEvent` 属于 `start` / `start-step` / `reasoning-start` / `reasoning-delta` 时返回 true；空串返回 false（连接期挂起仍走 30s 快速失败） |
| 162-165 | `idleTimeoutFor` | 函数 | E | thinking 阶段返回 `THINKING_IDLE_TIMEOUT_MS`；否则按 `streaming` 返回 `STREAM_IDLE_TIMEOUT_MS` 或 `NONSTREAM_IDLE_TIMEOUT_MS` |

## 关键行为

- **作用域隔离不变式**：所有读写都经 `scopeKey(apiKey, sessionId)`（64-101）；成功请求只清自己的桶，不影响其他 key/会话。
- **TTL 懒清理**：无定时器，`recordTimeout` 触发 `pruneStale`（67），`freshCount`/`entryFor` 也把过期条目当 0/新建，保证 map 有界。
- **计数跃迁可观测**（72-81、96-100）：`recordTimeout` 每次自增都记 `Timeout recorded`（含 key 前缀、session 桶、当前连续次数、阈值、是否会触发缩减上下文提示、桶总数）；`recordTimeoutSuccess` 仅在确有计数可清时记 `Timeout counter cleared`。计数是 `timeoutMessage` 中 `consecutive_timeouts` 字段的来源，此前无法看到它何时越过阈值、由哪个会话桶累积。
- **`timeoutMessage` 分支**（118-130）：连续次数 `< 3` 返回 `'Response timeout - request timed out'`；`>= 3` 且 `inputTokens > 80_000` 返回 `'Response timeout - try reducing context length (summarize earlier messages)'`；否则返回含连续次数与可选 `of <timeoutMs>ms` 窗口的 `Response timeout (upstream slow, <n> consecutive idle timeouts...) - retry or try a fresh session/key`。
- **升级兼容**：`legacyKey`（34-36）与 `consecutiveTimeouts` 的无 session 分支（106-109）读取旧裸 key，`recordTimeoutSuccess` 在无 session 时清理旧键（86-92）。
- **易错点**：`consecutiveTimeouts` 只有在 `sessionId` 为 `undefined` 时才读 legacy；显式传 `'default'` 不会读旧键。
