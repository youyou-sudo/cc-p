# 模块报告：src/modules/messages/handler.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/messages/handler.ts` |
| 行数 | 414 |
| 层级 | 协议层 |
| 依赖 | `../../shared/auth`、`../../infra/cc`、`../../shared/errors`、`../../shared/http`、`../../shared/logger`、`../../infra/proxy-handler`、`../../shared/runtime`、`../../infra/session`、`../../infra/sse`、`../../shared/util`、`./translator`、`./aggregator` |
| 被依赖 | `src/modules/messages/protocol.ts` |

## 职责

- `/v1/messages` 请求/响应生命周期：鉴权、两跳转换、上游调用、流式与非流式双路径编排。
- 流式：驱动 `createAnthropicSseTranslator` 与 `SsePipeline(false)`，处理断连、空闲超时、零输出与竞速返回。
- 非流式：驱动 `createMessagesAggregator` 聚合并经 `buildAnthropicResponse` 输出 Anthropic JSON。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-14 | — | import | — | shared/auth、infra/cc、shared/errors、shared/http、shared/logger、infra/proxy-handler、shared/runtime、infra/session、infra/sse、shared/util、./translator、./aggregator |
| 16-20 | `anthropicRetryOpts` | 函数 | P | 从错误体取 `retry_after`，存在则返回 `{retryAfter:Number(v)}`，否则 undefined |
| 22-36 | `sendAnthropicErrorWithRawUsage` | 函数 | P | 与 `sendAnthropicError` 同形，额外在 `error.rawUsage` 带 input/output/cached tokens；有 retryAfter 时写 `Retry-After` 头 |
| 38-40 | `buildAnthropicError` | 函数 | P | `JsonParseErrorKind` → `too-large` 413 / 其余 400 的 `invalid_request_error` |
| 42-46 | `handleMessages` | 异步函数 | E | `readRequestJson`（失败返回错误 Response）→ 委托 `handleMessagesBody(parsed.value, headers, request.signal)` |
| 48-414 | `handleMessagesBody` | 异步函数 | E | 主处理器（见下方子段） |
| 49-52 | └ 鉴权 | 逻辑 | P | `getApiKey` 缺失 → 401 `authentication_error`（`authErrorMessage`） |
| 54-55 | └ 请求元信息 | 逻辑 | P | `stream = anthropicReq.stream === true`；`model || 'claude-sonnet-4-6'` |
| 57-59 | └ 两跳转换 | 逻辑 | P | `convertAnthropicToOpenAI` → 透传 `prompt_cache_key`(58) → `buildCcRequest` |
| 62 | └ 会话 | 逻辑 | P | `getSessionId(headers, apiKey, openaiReq.prompt_cache_key)`，按 session 分桶超时 |
| 64-69 | └ 运行态 | 逻辑 | P | `createUpstreamFlow({signal})`、`abortController`、`aborted()`、`startTime`、`messageId`、`bytesReceived` |
| 71-82 | └ 上游调用 | 逻辑 | P | `callUpstream`（label 'CC API error (Anthropic)'，`onCcError → sendAnthropicError`）；非 ok 直接 `return upstream.value` |
| 84-271 | └ 流式分支 | 逻辑 | P | `SsePipeline(false)` + ctx + state |
| 85-87 |   └ pipeline/ctx/state | 逻辑 | P | `SsePipeline(false)`；`AnthropicStreamContext`；`state{upstreamError,timedOut,timedOutMs,zeroOutput,errorMsg}` |
| 89-111 |   └ onClientAbort | 逻辑 | P | pipeline 未关时 `terminateWith([message_delta(end_turn, usage 0), message_stop])`，并记 warn（含 elapsed/bytes/lastCcEvent/tokens） |
| 112 |   └ setGracefulClose | 逻辑 | P | `flow.setGracefulClose(onClientAbort)` |
| 114 |   └ 心跳 | 逻辑 | P | `startSseHeartbeat(pipeline)` |
| 115-195 |   └ pump | 异步函数 | P | 流式主循环 |
| 116 |     └ reader | 逻辑 | P | `ccResponse.body!.getReader()` |
| 118-120 |     └ 翻译器初始化 | 逻辑 | P | `messageId = 'msg_'+uuid12`；`createAnthropicSseTranslator(model,messageId,ctx)`；emit `startEvents()` |
| 121-127 |     └ 读取循环 | 逻辑 | P | `aborted()` 检查 → `readWithTimeout(reader.read(), idleTimeoutFor(lastCcEvent,true),'STREAM_IDLE_TIMEOUT')` → `translator.parseChunk(value)` |
| 129-141 |     └ 收尾与开播判定 | 逻辑 | P | flush + finishEvents；`recordTimeoutSuccess`；`ctx.upstreamError`→state；`outputTokens===0`→state.zeroOutput 并 abort；否则 `pipeline.start()` |
| 142-189 |     └ pump catch | 逻辑 | P | 断连静默(143)；`STREAM_IDLE_TIMEOUT`→abort+recordTimeout+state.timedOut，已开播写 rate_limit_error 帧；其他→state.errorMsg，已开播写 internal_error 帧 |
| 190-194 |     └ pump finally | 逻辑 | P | `reader.cancel()` + `clearInterval(heartbeat)` + `pipeline.close()` |
| 197 |   └ `void pump()` | 逻辑 | P | 后台启动，不 await |
| 199-202 |   └ 竞速 | 逻辑 | P | `Promise.race([pipeline.firstOutput→'started', pipeline.terminal→'terminal'])` |
| 204-268 |   └ terminal 未开播分支 | 逻辑 | P | 按 state 返回终端 JSON 错误 |
| 206-223 |     └ upstreamError | 逻辑 | P | 记 warn 后 `sendAnthropicError(status,type,message,anthropicRetryOpts)` |
| 224-230 |     └ timedOut | 逻辑 | P | 429 `rate_limit_error` + `code:'stream_idle_timeout'` + `retry_after:5` |
| 231-248 |     └ zeroOutput | 逻辑 | P | 429 `rate_limit_error` + `error.rawUsage`，`retry_after:10` |
| 249-251 |     └ errorMsg | 逻辑 | P | 502 `proxy_error` `Upstream error: …`，retryAfter 10 |
| 252-267 |     └ 兜底 | 逻辑 | P | 同样按零输出 429（`rawUsageFallback`）返回 |
| 270 |   └ 流式成功 | 逻辑 | P | `new Response(pipeline.stream, {status:200, headers:SSE_HEADERS})` |
| 273-288 | └ 非流式聚合器 | 逻辑 | P | `createMessagesAggregator({onEventError})`，错误事件记 warn |
| 290 | └ reader | 逻辑 | P | 非流式 reader |
| 292-345 | └ 非流式读取 try/catch | 逻辑 | P | idle 用 `idleTimeoutFor(lastCcEvent,false)`（90s） |
| 293-301 |   └ 读取循环 | 逻辑 | P | `aborted()` → `readWithTimeout` → `bytesReceived += value.byteLength` → `aggregator.push`；结束 `aggregator.flush()` |
| 302-333 |   └ 超时 catch | 逻辑 | P | aborted→499；`STREAM_IDLE_TIMEOUT`→partial usage 回填、429（retry_after 5）；其他→502 |
| 334-345 |   └ 其他错误 | 逻辑 | P | 记 error 后 abort 上游，502 `proxy_error` |
| 347-349 | └ abort 检查 | 逻辑 | P | 中止则 499 |
| 351-367 | └ 非流式 upstreamError | 逻辑 | P | 记 warn 后 `sendAnthropicError` 透传 |
| 369-382 | └ 零输出 | 逻辑 | P | `!fullText && !thinkingText && !toolCalls` → abort + 429（`rawUsageFromCcUsageAnthropic`） |
| 384-400 | └ 成功 | 逻辑 | P | `recordTimeoutSuccess` → `normalizeUsage` → rawUsage → log info → `sendJSON(200, buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText))` |
| 401-413 | └ 外层 catch | 逻辑 | P | `aborted()`/signal.aborted → 499；否则 abort 上游 + 502 `proxy_error` |

## 关键行为

- 鉴权双保险：index.ts:13 的前置 401 之外，handler 49-52 再次 `getApiKey` 兜底，覆盖绕过路由直调 service 的场景。
- 转换链（57-59）：Anthropic→OpenAI→CC 两跳；`prompt_cache_key` 在 58 单独透传，同时进入 62 的 session 分桶。
- 流式开播条件：85 用 `SsePipeline(false)`（不自动开播）；120 先 emit `message_start` 但只进缓冲；仅当 129-141 判定有输出、无 upstreamError、非零输出时才 `pipeline.start()`（139）。因此空回包走 terminal JSON 429，而非提前 flush 成 SSE 200。
- onClientAbort（89-111）：`pipeline.terminateWith` 补 `message_delta(end_turn, usage 0)` + `message_stop`，保证断连也发出合法 SSE 尾帧；`pipeline.closed` 守卫避免重复终止。
- pump 循环（121-127）每轮先查 `aborted()`，空闲上限来自 `idleTimeoutFor(ctx.lastCcEvent, true)`（thinking 阶段放宽，取自 shared/runtime）；`parseChunk` 会自增 `ctx.bytesReceived`。
- 收尾判定（129-141）：先 `flush()`+`finishEvents()`，再 `recordTimeoutSuccess`；`ctx.upstreamError` 优先于零输出分支，零输出（135-137）额外 `abortController.abort()` 掐断上游。
- 竞速（199-202）：`firstOutput` 与 `terminal` 二选一。terminal 胜出再由 204-268 映射为 JSON 错误；started 胜出走 270 的 SSE 200。
- terminal 错误优先级（204-267）：upstreamError → timedOut → zeroOutput → errorMsg → 兜底 429。206 先判 upstreamError，故上游错误体不会落到超时/零输出分支。
- 非流式 idle 用 90s（295），流式用 thinking 感知的 30s（123）；两者由 `idleTimeoutFor(lastCcEvent, isStream)` 区分。
- 断连统一语义：`aborted()`（66）封装 `flow.aborted`，所有路径在 client abort 时以 499 收场（304、348、408）。
- 易错点：`bytesReceived`（69）只在非流式自增（298）；流式字节数记在 `ctx.bytesReceived`（由 translator.parseChunk 累加），日志里同名两值含义不同。
