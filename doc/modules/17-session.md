# 模块报告：src/session.ts（会话管理）

| 属性 | 值 |
|---|---|
| 路径 | `src/session.ts` |
| 行数 | 60 |
| 层级 | 上游对接 |
| 依赖 | logger、util(uuid)、fingerprint(keyStateStore) |
| 被依赖 | cc（forwardToCC 取会话头）、index（启动清理任务） |

## 代码段映射

| 行号 | 符号 | 说明 |
|---|---|---|
| 5-6 | `SESSION_DURATION_MS` / `SESSION_JITTER_MS` | 12h / 1h——过期时间 = now + 12h + random(0~1h) |
| 8-11 | `SessionEntry` | `{sessionId, expiresAt}`（模块私有） |
| 13 | `sessionStore` | `Map<apiKey, SessionEntry>`——每把 key 一个会话 |
| 15-28 | `ensureSession(apiKey)` | 未过期 → 复用 sessionId；否则新建 uuid 会话并 `log('info','Session created',{sessionId 前 8 位, storeSize})` |
| 30-45 | `getSessionId(incomingHeaders, apiKey, promptCacheKey?)` | 客户端会话透传优先级：`x-session-id` → `x-claude-code-session-id` → `session_id` → `prompt_cache_key`（任一存在且长度 ≥8 即采纳）→ 否则 ensureSession |
| 47-60 | `startSessionCleanup()` | setInterval 每小时：删除过期条目，并联动删除 `keyStateStore`（指纹状态）同 key 条目；仅在有清理时记日志（cleaned/remaining） |

## 设计语义

- **会话粘性**：同一把 key 在 12~13h 窗口内对上游呈现稳定 `x-session-id`，模拟真实 CLI 会话连续性。
- **透传优先**：客户端自带会话头时直接沿用（多轮对话上游可关联），prompt_cache_key 也参与（与 cc.ts 的缓存标记呼应）。
- **联动清理**：session 过期 ⇒ 指纹状态一并过期，下个请求会重新生成指纹并上报（fingerprint.ensureInitialized 的 nextInitAt 逻辑不受影响，但 store 里不再有旧指纹）。
