# 模块报告：src/infra/session.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/infra/session.ts` |
| 行数 | 60 |
| 层级 | 上游对接层 |
| 依赖 | `../shared/logger`(log)；`../shared/util`(uuid)；`./fingerprint`(keyStateStore) |
| 被依赖 | `src/index.ts`(startSessionCleanup)、`src/infra/cc.ts`(getSessionId)、`src/modules/chat/handler.ts`(getSessionId)、`src/modules/messages/handler.ts`(getSessionId) |

## 职责

- 按 API key 维护稳定的上游会话 ID，模拟真实 CLI 会话连续性。
- 优先透传客户端自带的会话标识，否则生成并缓存（12h + ≤1h 抖动）。
- 每小时清理过期会话，并联动删除对应的指纹状态。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-3 | — | import | — | `../shared/logger`(log)；`../shared/util`(uuid)；`./fingerprint`(keyStateStore) |
| 5 | `SESSION_DURATION_MS` | 常量 | P | `12 * 60 * 60 * 1000`，会话基础有效期 12h |
| 6 | `SESSION_JITTER_MS` | 常量 | P | `60 * 60 * 1000`，最大抖动 1h |
| 8-11 | `SessionEntry` | interface | P | `{ sessionId: string; expiresAt: number }` |
| 13 | `sessionStore` | 常量 | P | `Map<apiKey, SessionEntry>` |
| 15-28 | `ensureSession(apiKey)` | 函数 | E | 未过期则复用 `sessionId`；否则 `uuid()` 新建，`expiresAt = now + 12h + random(0..1h)`，记 `log('info','Session created',{sessionId 前 8 位, storeSize})` |
| 30-45 | `getSessionId(incomingHeaders, apiKey, promptCacheKey?)` | 函数 | E | 候选优先级 `x-session-id` → `x-claude-code-session-id` → `session_id` → `promptCacheKey`；任一为非空字符串且长度 ≥ 8 即采纳，否则 `ensureSession(apiKey)` |
| 47-59 | `startSessionCleanup()` | 函数 | E | `setInterval` 每小时：删除 `now >= expiresAt` 的条目，同时 `keyStateStore.delete(key)`；仅当 `cleaned > 0` 时记 `log('info','Session cleanup',{cleaned, remaining})` |

## 关键行为

- 会话粘性：同一把 key 在 12~13h 窗口内对上游呈现稳定 `x-session-id`（25）。
- 透传优先：客户端会话头长度门槛为 ≥ 8（42），可避免过短/空值误采纳。
- 联动清理：会话过期时一并删除 `keyStateStore` 同 key 指纹状态（54），下个请求将重新生成指纹（`getOrCreateKeyState` 懒创建）。
