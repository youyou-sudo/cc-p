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
| 9 | `STREAM_IDLE_TIMEOUT_MS` | 30 000 ms：流式响应中两次上游数据之间的最大间隔（经 `readWithTimeout` 应用于每次 `reader.read()`） |
| 10 | `NONSTREAM_IDLE_TIMEOUT_MS` | 90 000 ms：非流式聚合读取的空闲上限 |
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
