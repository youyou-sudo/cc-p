# 模块报告：src/modules/chat/aggregator.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/chat/aggregator.ts` |
| 行数 | 110 |
| 层级 | 协议层 |
| 依赖 | `../../shared/errors`、`../../infra/cc-events`、`../../shared/util` |
| 被依赖 | `src/modules/chat/protocol.ts`（re-export）、`src/modules/chat/handler.ts`（非流式分支） |

## 职责

- 非流式聚合：把 CC NDJSON 事件流累积为文本 / 推理 / 工具调用 / usage / 错误。
- 构造 OpenAI `chat.completion` 响应体。
- 纯函数无 I/O：仅依赖 `CcStreamParser` 与错误映射工具。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | — | 注释 | — | 非流式聚合 + 响应构造，纯函数无 I/O |
| 3-6 | — | import | — | errors(mapCcEventError, mapFinishReason, normalizeUsage)；infra/cc-events(CcStreamParser, type CcEventHooks)；shared/util(uuid) |
| 9-19 | `rawUsageFromCcUsage` | 函数 | E | CC usage → `{input_tokens, output_tokens, cached_tokens}`，非有限数归 0 |
| 21-28 | `ChatAggregate` | interface | E | fullText/reasoningContent/toolCalls/finishReason/usage/upstreamError |
| 30-82 | `createChatAggregator` | 工厂函数 | E | 闭包聚合器，可选 `onEventError` 回调 |
| 36-41 | └ 聚合状态 | 字段 | P | fullText/reasoningContent/finishReason(初值 `'stop'`)/usage/toolCalls/upstreamError |
| 43-66 | └ parser + hooks | 逻辑 | P | 事件累积（下详） |
| 45 |   └ `text-delta` | 逻辑 | P | `fullText += event.text` |
| 46 |   └ `reasoning-delta` | 逻辑 | P | `reasoningContent += event.text` |
| 47-57 |   └ `tool-call` | 逻辑 | P | 追加到 `toolCalls`（id 缺省 `call_{uuid8}`，arguments 非字符串则 JSON.stringify） |
| 58-61 |   └ `finish` | 逻辑 | P | `mapFinishReason` 赋 finishReason；`totalUsage` 存在则记 usage |
| 62-65 |   └ `error` | 逻辑 | P | `mapCcEventError` → upstreamError，并调用 `onEventError` |
| 68-81 | └ 返回对象 | API | P | getter + push/flush/result |
| 69-71 |   └ `lastCcEvent` | 字段 | P | `parser.lastCcEvent` |
| 72-74 |   └ `push` | 方法 | P | `parser.push(bytes, hooks)` |
| 75-77 |   └ `flush` | 方法 | P | `parser.flush(hooks)` |
| 78-80 |   └ `result` | 方法 | P | 返回 `ChatAggregate` |
| 84-110 | `buildChatCompletion` | 函数 | E | 组装 `chat.completion` 响应体 |

## 关键行为

- 非流式只认 `finish` 事件的 `totalUsage`（60）；缺失时 `buildChatCompletion` 用 `normalizeUsage` 兜底（87）。
- tool-call 无 `toolCallId` 时以 `uuid().slice(0,8)` 生成（50）。
- `message` 字段按需合并（96-100）：`content`（空则 `null`）、`tool_calls`（存在才加）、`reasoning_content`（非空才加）。
- usage 输出口径：`prompt_tokens` / `completion_tokens` / `total_tokens` + `prompt_tokens_details.cached_tokens`，均取自 `rawUsageFromCcUsage`（103-108）。
- `onEventError` 仅供日志，不影响返回状态码分支。
