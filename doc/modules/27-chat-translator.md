# 模块报告：src/modules/chat/translator.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/chat/translator.ts` |
| 行数 | 170 |
| 层级 | 协议层 |
| 依赖 | `../../shared/errors`、`../../shared/logger`、`../../infra/cc-events` |
| 被依赖 | `src/modules/chat/protocol.ts`（re-export）、`src/modules/chat/handler.ts`（流式分支） |

## 职责

- 把 CC NDJSON 事件流翻译成 OpenAI `chat.completion.chunk` SSE 帧。
- 纯流式翻译，无 I/O：由 `CcStreamParser` 驱动，hooks 返回待发送字符串。
- 记录 usage / finishReason / upstreamError 供 handler 决策。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | 注释 | — | CC NDJSON → `chat.completion.chunk`；纯流式无 I/O |
| 4-7 | — | import | — | errors(mapCcEventError, mapFinishReason, normalizeUsage)；logger(log)；infra/cc-events(CcStreamParser, type CcEventHooks) |
| 9-18 | `zeroUsageChunk` | 函数 | E | 断连终止 chunk：空 delta + `finish_reason:'stop'` + 全零 usage |
| 20-30 | `makeChunk` | 函数 | P | 构造 `data: <chunk>\n\n`，usage 存在时附带 |
| 32-168 | `createSseTranslator` | 工厂函数 | E | 闭包状态 + 内嵌 `CcStreamParser` + hooks，返回翻译器对象 |
| 33-36 | └ chunkIndex/finishReason/usage/toolCallIndex | 字段 | P | 翻译器状态 |
| 38-45 | └ parser/state/tokens/bytesReceived | 字段 | P | `CcStreamParser`、upstreamError、input/output/cachedInputTokens、bytesReceived |
| 47-122 | └ `hooks` | 逻辑 | P | 事件→chunk 映射表 |
| 48-54 |   └ `text-delta` | 逻辑 | P | 首块带 `role:'assistant'`；text 取 `event.text ?? event.delta` |
| 55-61 |   └ `reasoning-delta` | 逻辑 | P | 首块带 role，产出 `reasoning_content` 增量 |
| 62-73 |   └ `tool-call` | 逻辑 | P | 组装 `tool_calls[0]`（index/id/type/function{name,arguments}）；**先取回 `pendingToolInput` 的 id/name 再清空**，空名兜底 `UNKNOWN_TOOL_NAME`；arguments 非字符串则 JSON.stringify |
| 74-82 |   └ `tool-input-start` | 逻辑 | P | 缓存 `{id,name,json}`（`ccToolCallId`/`ccToolName`，回退旧 pending） |
| 83-92 |   └ `tool-input-delta` | 逻辑 | P | 累积增量 JSON；缺失时新建 pending，已有的只覆盖非空 id/name |
| 93-101 |   └ `tool-input-end` | 逻辑 | P | 完整 input 优先，否则用累积 json；清 pending 后经 emit 兜底发射 |
| 102-110 |   └ `finish-step` | 逻辑 | P | 记录 `finishReason`（mapFinishReason）与 usage / token 计数 |
| 111-134 |   └ `finish` | 逻辑 | P | `normalizeUsage` 后组装 openaiUsage，log `'OpenAI stream finish'`，产出终结 chunk |
| 135-149 |   └ `error` | 逻辑 | P | `mapCcEventError` → state.upstreamError，log `'CC stream error'` |
| 124-167 | └ 返回对象 | API | P | getter + 方法（下详） |
| 125-142 |   └ getter | 字段 | P | lastCcEvent/upstreamError/inputTokens/outputTokens/cachedInputTokens/bytesReceived |
| 143-153 |   └ `rawUsage` | 字段 | P | 归一到 `{input_tokens, output_tokens, cached_tokens}`，非有限数取 0 |
| 155-158 |   └ `parseChunk` | 方法 | P | 累加 bytesReceived → `parser.push(bytes, hooks)` |
| 160-162 |   └ `flush` | 方法 | P | `parser.flush(hooks)` |
| 164-166 |   └ `getDoneEvent` | 方法 | P | 返回 `'data: [DONE]\n\n'` |
| 170 | `ChatStreamTranslator` | type | E | `ReturnType<typeof createSseTranslator>` |

## 关键行为

- 首个内容帧才带 `role:'assistant'`（51、58、67）：以 `chunkIndex === 0` 判定，保证 OpenAI 客户端首块含角色。
- usage 只在 `finish` 帧附带（90-105）；`normalizeUsage` 当前为空操作（no-op），usage 口径原样透传，input/cached 不会因零 outputTokens 被清零。
- `error` 事件不直接产出帧（107-121），只记录 `state.upstreamError`，由 handler 决定写内嵌错误帧还是返回映射 JSON。
- `tool-call` 的 `toolCallIndex` 独立自增（原 71 附近），与 `chunkIndex` 解耦。
- **空名红线**：`tool-call` 钩子必须在清空 `pendingToolInput` **之前**取回其 id/name（`ccToolCallId`/`ccToolName`），并在 `emitToolCallChunk` 内对空名兜底 `UNKNOWN_TOOL_NAME` 并 log warn。上游先发 `tool-input-start{toolName}` 再发只带 `input` 的 `tool-call` 是真实形态（生产日志实证）；若先清空就会下发 `function.name:""`，opencode 的 `ToolStream.appendOrStart` 判空即抛 "OpenAI Chat tool call delta is missing id or name"，整条流失败，且空名会被回放进下一轮的 `function_call`。
