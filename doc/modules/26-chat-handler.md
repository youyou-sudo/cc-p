# 模块报告：src/modules/chat/handler.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/chat/handler.ts` |
| 行数 | 374 |
| 层级 | 协议层 |
| 依赖 | `../../shared/auth`、`../../infra/cc`、`../../shared/http`、`../../shared/logger`、`../../infra/proxy-handler`、`../../shared/runtime`、`../../infra/session`、`../../infra/sse`、`../../shared/util`、`./translator`、`./aggregator` |
| 被依赖 | `src/modules/chat/protocol.ts`（re-export） |

## 职责

- `POST /v1/chat/completions` 的请求 / 响应生命周期：解析、鉴权、构建 CC 请求、调用上游。
- 流式路径：驱动 `SsePipeline` + `createSseTranslator`，处理空闲超时、零输出、断连、错误帧。
- 非流式路径：用 `createChatAggregator` 聚合上游 NDJSON，构造 `chat.completion` 响应。
- 统一的超时记账（`recordTimeout` / `recordTimeoutSuccess`）与会话级隔离。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-12 | — | import | — | shared/auth；infra/cc；shared/http；shared/logger；infra/proxy-handler；shared/runtime；infra/session；infra/sse；shared/util；./translator；./aggregator |
| 14-20 | `TerminalState` | interface | P | 终态记账：upstreamError / timedOut / timedOutMs? / zeroOutput / errorMsg |
| 22-26 | `buildError` | 函数 | P | `JsonParseErrorKind` → 413(too-large)/400 OpenAI `invalid_request_error` |
| 28-32 | `handleChatCompletions` | 异步函数 | E | `readRequestJson` 解析后委托 `handleChatCompletionsBody`，透传 `request.signal` |
| 34-374 | `handleChatCompletionsBody` | 异步函数 | E | 主处理器：流式 / 非流式双路径状态机 |
| 35-38 | └ 鉴权 | 逻辑 | P | `getApiKey(headers)` 缺失 → 401 `{type:'auth_error'}` |
| 40-43 | └ 请求元信息 | 逻辑 | P | `stream===true` 才流式；model 缺省 `deepseek/deepseek-v4-flash`；`completionId = chatcmpl-{uuid 前 12}`；`created = nowUnix()` |
| 45 | └ 构建 CC 体 | 逻辑 | P | `buildCcRequest(openaiReq)` |
| 50-53 | └ 会话与流控 | 逻辑 | P | `getSessionId(...)`；`createUpstreamFlow` 取 `flow.controller` / `flow.signal` / `flow.aborted` |
| 54-56 | └ 计时与游标 | 字段 | P | `startTime`、`bytesReceived`、`lastCcEvent` |
| 59-69 | └ 调用上游 | 逻辑 | P | `callUpstream`（prompt_cache_key 透传，label `'CC API error'`，`onCcError → sendJSON`）；非 ok 直接返回 |
| 71-243 | └ 流式分支 | 逻辑 | P | `createSseTranslator` + `SsePipeline(true)` + `startSseHeartbeat` + `TerminalState` |
| 77-96 |   └ `onClientAbort` | 逻辑 | P | 断连原因分类（`tool-input*` → tool-input-silent-timeout；含 `delta` → streaming-active-disconnect；否则 client-hangup），log 后 `terminateWith([zeroUsageChunk, 'data: [DONE]\n\n'])` |
| 97 |   └ `flow.setGracefulClose(onClientAbort)` | 逻辑 | P | 注册客户端断连的优雅收尾 |
| 99-194 |   └ `pump` | 逻辑 | P | 上游读取循环（下详） |
| 100-101 |     └ reader | 逻辑 | P | `ccResponse.body!.getReader()` |
| 102-116 |     └ 读取循环 | 逻辑 | P | `aborted()` 跳出；`idleTimeoutFor(lastCcEvent,true)` 超时读；`parseChunk` → `lastCcEvent` 更新 → `pipeline.emit(events)`，无事件则 `emitKeepalive` |
| 118-140 |     └ 流尽终态 | 逻辑 | P | `flush()`；upstreamError → 已开播写错误帧；`outputTokens===0` → 置 zeroOutput + abort + 已开播写零输出帧；否则 `recordTimeoutSuccess` + `emit(getDoneEvent())` |
| 141-189 |     └ pump catch | 逻辑 | P | aborted → `reader.cancel()`；`STREAM_IDLE_TIMEOUT` → log + cancel + abort + `recordTimeout` + 置 timedOut + 已开播写 429 帧；其他 → 置 errorMsg + abort + 已开播写 proxy_error 帧 |
| 190-193 |     └ pump finally | 逻辑 | P | `clearInterval(heartbeat)` + `pipeline.close()` |
| 196 |   └ `void pump()` | 逻辑 | P | 后台启动读取，不 await |
| 198-201 |   └ 竞速返回 | 逻辑 | P | `Promise.race(firstOutput→'started', terminal→'terminal')` |
| 203-240 |   └ terminal 分支 | 逻辑 | P | 按 state 返回：upstreamError → 映射 JSON；timedOut → 429；zeroOutput/无 errorMsg → 429；否则 502 |
| 242 |   └ started 返回 | 逻辑 | P | `new Response(pipeline.stream, {status:200, headers:SSE_HEADERS})` |
| 245-260 | └ 非流式聚合装配 | 逻辑 | P | `createChatAggregator({ onEventError })`，错误仅 log |
| 262-273 | └ 非流式读取循环 | 逻辑 | P | `idleTimeoutFor(lastCcEvent,false)` 读；`aggregator.push` → `lastCcEvent` 更新 |
| 274 | └ flush | 逻辑 | P | `aggregator.flush()` |
| 275-314 | └ 非流式 catch | 逻辑 | P | aborted → 499；`STREAM_IDLE_TIMEOUT` → log + cancel + abort + `recordTimeout` + 429(retry_after 5, input_tokens:0)；其他 → abort + 502 |
| 316-318 | └ aborted 兜底 | 逻辑 | P | 循环后仍 aborted → 499 空响应 |
| 320-346 | └ 聚合终态 | 逻辑 | P | `aggregator.result()`；upstreamError → 映射 JSON；outputTokens===0 → abort + 429 zero-output(retry_after 10) |
| 348-360 | └ 成功响应 | 逻辑 | P | `recordTimeoutSuccess` + log `'OpenAI non-stream finish'` + `sendJSON(200, buildChatCompletion(...))` |
| 361-373 | └ 外层 catch | 逻辑 | P | aborted/controller.aborted → 499；否则 abort + 502 proxy_error |

## 关键行为

- 流式先 `void pump()`（196）启动后台读取，再 `Promise.race`（198-201）：`terminal` 胜出意味着「上游未开播即终态」，此时不返回 SSE 流而按 state 返回协议化 JSON；`started` 胜出才返回 200 SSE 流（242）。
- `onClientAbort`（77-96）在 `pipeline.closed` 时提前返回；否则按 `lastCcEvent` 归纳断连原因，并以 `terminateWith([zeroUsageChunk, 'data: [DONE]\n\n'])` 收尾。
- 空闲超时统一由 `readWithTimeout(..., idleMs, 'STREAM_IDLE_TIMEOUT')` 抛出（105、268），catch 分支靠 `e.message` 匹配；流式超时会写 429 错误帧或返回 429 JSON，非流式超时文案刻意不带 inputTokens（注释 296-298，避免错误宣称「缩减上下文」）。
- 零输出判定在流式用 `translator.outputTokens === 0`（130），非流式用 `(usage?.outputTokens ?? 0) === 0`（327）；两处都会 `abortController.abort()` 掐断上游。
- 会话按 `getSessionId(headers, apiKey, prompt_cache_key)`（50）隔离超时桶，主会话挂起不会误导同 key 的小 sub-agent。
- 外层 catch（361-373）兜底：客户端断连 → 499 空响应，其余 → 502 `proxy_error` 且 `retry_after:10`。
