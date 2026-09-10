# 模块报告：src/modules/messages/aggregator.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/messages/aggregator.ts` |
| 行数 | 117 |
| 层级 | 协议层 |
| 依赖 | `../../infra/cc-events`、`../../shared/errors`、`../../shared/util`、`./translator` |
| 被依赖 | `src/modules/messages/protocol.ts`、`src/modules/messages/handler.ts` |

## 职责

- 非流式聚合：用 `CcStreamParser` + 钩子把 CC NDJSON 汇总为 `MessagesAggregate`（text/thinking/toolCalls/finishReason/usage/upstreamError）。
- 将聚合结果构建为 Anthropic `message` JSON（`buildAnthropicResponse`）。
- 提供 CC usage → `rawUsage` 的归一化口径（`rawUsageFromCcUsageAnthropic`），供零输出/超时日志与错误体使用。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-5 | — | import | — | `CcStreamParser`/`CcEventHooks`、errors 映射、uuid、`./translator`(fakeThinkingSignature) |
| 7-18 | `rawUsageFromCcUsageAnthropic` | 函数 | E | `toNum` 容错（非有限数归 0）；输出 `input_tokens/output_tokens/cached_tokens` |
| 20-50 | `buildAnthropicResponse` | 函数 | E | 组装 Anthropic message 响应 |
| 21-30 | └ content | 逻辑 | P | 顺序：thinking（带签名）→ text → tool_use（`arguments` 反序列化失败回退 `{}`） |
| 31-49 | └ 响应骨架 | 逻辑 | P | `id=msg_{uuid12}`；role assistant；`stop_reason = mapAnthropicStopReason(finishReason||'stop')`；`stop_sequence:null` |
| 39-48 | └ usage | 逻辑 | P | IIFE：`normalizeUsage` 后映射 input/output/cache_creation(cacheWriteTokens)/cache_read |
| 52-59 | `MessagesAggregate` | interface | E | fullText/thinkingText/toolCalls/finishReason/usage/upstreamError |
| 61-117 | `createMessagesAggregator` | 函数 | E | 工厂，返回 `{lastCcEvent,push,flush,result}` |
| 67-72 | └ 闭包状态 | 字段 | P | fullText/thinkingText/toolCalls/finishReason/usage/upstreamError |
| 74 | └ `parser` | 常量 | P | `new CcStreamParser()` |
| 75-98 | └ `hooks` | 逻辑 | P | 按 CC 事件聚合 |
| 76 |   └ text-delta | 逻辑 | P | `fullText += event.text` |
| 77 |   └ reasoning-delta | 逻辑 | P | `thinkingText += event.text` |
| 78-88 |   └ tool-call | 逻辑 | P | push OpenAI 形状 `{id,type:'function',function:{name,arguments}}`；id 缺省 `call_{uuid8}` |
| 89-92 |   └ finish | 逻辑 | P | `finishReason = mapFinishReason(...)`；`usage = totalUsage || usage` |
| 93-97 |   └ error | 逻辑 | P | `mapCcEventError` 存 upstreamError 并回调 `opts.onEventError` |
| 100-116 | └ 返回对象 | API | P | 聚合器公开接口 |
| 101-103 |   └ `lastCcEvent` | 方法 | P | getter 转发 `parser.lastCcEvent` |
| 105-107 |   └ `push` | 方法 | P | `parser.push(bytes,hooks)` |
| 109-111 |   └ `flush` | 方法 | P | `parser.flush(hooks)` |
| 113-115 |   └ `result` | 方法 | P | 返回 `MessagesAggregate` 快照 |

## 关键行为

- `buildAnthropicResponse` 的 content 顺序（22-30）与流式 translation 一致：thinking → text → tool_use；thinking 块复用 `fakeThinkingSignature`（translator.ts:7）保证签名格式合法。
- usage IIFE（39-48）会就地 `normalizeUsage`（outputTokens 缺失/0 时把 input/cached 归零），因此 45-46 的 cache 字段可能在零输出时被清零。
- `createMessagesAggregator` 的 `error` 钩子（93-97）只记录 `upstreamError`，**不**中断后续解析；handler 在 `aggregator.result()` 后据此优先返回上游错误。
- `push`/`flush`（105-111）丢弃 `parser` 返回值，因为非流式只需状态聚合，无需逐帧输出。
- `lastCcEvent`（101-103）供 handler 的空闲超时判定与日志诊断使用。
