# 模块报告：src/runtime.ts（超时与运行态）

| 属性 | 值 |
|---|---|
| 路径 | `src/runtime.ts` |
| 行数 | 63 |
| 层级 | 基础设施 |
| 依赖 | 无 |
| 被依赖 | openai、anthropic |

## 代码段映射

| 行号 | 符号 | 值/说明 |
|---|---|---|
| 9 | `STREAM_IDLE_TIMEOUT_MS` | 30 000 ms（`CC_STREAM_IDLE_MS` 可覆盖，默认不变）：流式响应中两次上游数据之间的最大间隔（经 `readWithTimeout` 应用于每次 `reader.read()`）；思考期不走此值 |
| 10 | `NONSTREAM_IDLE_TIMEOUT_MS` | 90 000 ms（`CC_NONSTREAM_IDLE_MS` 可覆盖，默认不变）：非流式聚合读取的空闲上限；思考期不走此值 |
| 10b | `THINKING_IDLE_TIMEOUT_MS` | 120 000 ms（`CC_THINKING_IDLE_MS` 可覆盖，默认不变）：思考期单次 read 空闲预算；`isThinkingWait(lastCcEvent)` 为 true（`start`/`start-step`/`reasoning-start`/`reasoning-delta`）时 `idleTimeoutFor` 返回此值，否则流式 30s/非流式 90s；日志带 `thinkingPhase` + 实际 `timeoutMs`；响应仍 `429 rate_limit_error retry_after:5` |
| 11 | `TIMEOUT_REDUCE_CONTEXT_THRESHOLD` | 3：连续超时达到该值后，超时文案切换为「建议缩减上下文」 |
| 14 | `TIMEOUT_STATE_TTL_MS` | 30 分钟：条目空闲超此时间后被清除，防止内存泄漏 |
| 16-19 | `TimeoutEntry` | `{ consecutiveTimeouts, lastUpdatedAt }` 每个 API key 独立的超时状态 |
| 21 | `timeoutStates` | `Map<string, TimeoutEntry>` 按 API key 隔离的超时状态存储 |
| 23-27 | `pruneStale(now)` | 清理超过 TTL 的过期条目 |
| 29-36 | `entryFor(apiKey, now)` | 获取或创建指定 key 的条目（过期则重置） |
| 39-45 | `recordTimeout(apiKey)` | 指定 key 超时计数 +1 |
| 48-50 | `recordTimeoutSuccess(apiKey)` | 指定 key 成功时删除其状态 |
| 53-57 | `consecutiveTimeouts(apiKey)` | 获取指定 key 的当前连续超时次数 |
| 59-63 | `timeoutMessage(apiKey)` | ≥3 次连续超时 → `Response timeout - try reducing context length...`；否则 `Response timeout - request timed out` |

## 状态机生命周期

- **递增**：任何路径出现 `STREAM_IDLE_TIMEOUT` 时调用 `recordTimeout(apiKey)`，该 key 的计数器 +1。
- **归零**：任一请求**成功完成**输出时调用 `recordTimeoutSuccess(apiKey)`，删除该 key 的状态。
- **隔离**：状态按 API key 隔离，一个客户端的超时不会影响其他客户端。
- **有界**：条目在 30 分钟无活动后自动清除，防止内存泄漏。
- **消费**：`timeoutMessage(apiKey)` 决定 429 响应体的文案；间接影响客户端重试行为。

## 排障备注（小上下文也报 reduce context；思考期走 120s 宽限）

- 根因链：思考期 `reasoning-start` 后 30s+ 上游零字节 → 旧 `readWithTimeout` 误杀 →
  Opencode 包装 `failed to send message`；与上下文大小无关（流式超时 `inputTokens` 恒 0，不能判大小）。
- 自证三件套（思考超时）：`lastCcEvent=reasoning-start`/`start` 无 delta +
  `bytesReceived` 几十字节 + `elapsedMs` 顶格阈值；`retry_after:5` 区别于零输出 10/真限流 30。
- 思考时报错：日志 `thinkingPhase=true` + 上述三件套 → 调大 `CC_THINKING_IDLE_MS`
  （深度推理/高 `reasoning_effort` 建议 180000），不要压缩上下文；仍顶格则继续加或拆任务/降 `reasoning_effort`；真 hang 代价是失败感知延迟到阈值。

- `timeoutMessage` 在同 Key 连续超时 ≥3 次后对**所有**后续空闲超时都返回
  `try reducing context length` 文案——小请求也会中招，属按 Key 累计污染（TTL 30min，成功清零），不是当前 prompt 太大。
- 主+子代理同 Key 默认还共享上游 `x-session-id`（12h，`src/session.ts`），计数器与会话双重污染：3 次慢子代理 fan-out 即可污染第 4 次小请求。
- 定性看日志 `Stream idle timeout`：`inputTokens` 小 + `lastCcEvent` 无 delta + `bytesReceived≈0` = 上游慢；`inputTokens` 逐轮爬升 = 真膨胀。
- 止血：子代理独立 Key、新任务换 session（omit `x-session-id`/`prompt_cache_key`）、降并发、截断 `tool_result`、上游确实慢则调大 `CC_STREAM_IDLE_MS=60000` / `CC_NONSTREAM_IDLE_MS=120000`（延迟失败感知）。
