# 模块报告：src/openai.ts（/v1/chat/completions）

| 属性 | 值 |
|---|---|
| 路径 | `src/openai.ts` |
| 行数 | 325 |
| 层级 | 协议层 |
| 依赖 | auth、cc、cc-events、errors、http、logger、proxy-handler、runtime、sse、util（10 个） |
| 被依赖 | index（路由挂载） |

## 代码段映射

| 行号 | 符号/段落 | 说明 |
|---|---|---|
| 14-19 | `TerminalState` | 终态记账：upstreamError / timedOut / zeroOutput / errorMsg |
| 21-25 | `buildError(kind, message)` | 请求解析错误 → 413（too-large）或 400（invalid）OpenAI 形状 |
| 27-36 | `zeroUsageChunk(id, created, model)` | 断连终止 chunk：空 delta + finish_reason:stop + 全零 usage |
| 38-325 | `handleChatCompletions(request, headers)` | 主处理器 |
| 39-41 | 解析 | `readRequestJson`（413/400） |
| 43-46 | 鉴权 | `getApiKey` 缺失 → 401 `{type:'auth_error'}` |
| 48-51 | 元信息 | `stream`（=== true 才流式）、`model`（默认 `deepseek/deepseek-v4-flash`）、`completionId = chatcmpl-{uuid 前 12}`、`created = nowUnix()` |
| 53-59 | 构建与流控 | `buildCcRequest(openaiReq)` → `createUpstreamFlow(request)` |
| 63-72 | 上游调用 | `callUpstream`（prompt_cache_key 透传 → CC 缓存标记；label 'CC API error'；onCcError → sendJSON） |
| 75-78 | 流式装配 | `createSseTranslator` + `SsePipeline(true)`（autoStart） |
| 80-99 | onClientAbort | 断连原因分类（lastCcEvent 以 tool-input 开头 → tool-input-silent-timeout；含 delta → streaming-active-disconnect；否则 client-hangup）→ `terminateWith([zeroUsageChunk, 'data: [DONE]\n\n'])` |
| 101-178 | pump | 循环：`readWithTimeout(reader.read(), 30s)` → `translator.parseChunk` → `pipeline.emit`；无事件时 `emitKeepalive`；流尽后 `flush`；终态分支：upstreamError（已开播则 writeNow 错误帧）/ outputTokens===0（zeroOutput + abort 上游）/ 成功（consecutiveTimeouts 清零 + emit [DONE]）；catch：断连→cancel；`STREAM_IDLE_TIMEOUT`→ consecutiveTimeouts++ + 已开播写 429 帧；其他→写 proxy_error 帧；finally `pipeline.close()` |
| 180-199 | 竞速返回 | `Promise.race(firstOutput→'started', terminal→'terminal')`；terminal 胜出：按 state 返回 429（timeout/zeroOutput）或 502（errorMsg）JSON；started 胜出：`new Response(pipeline.stream, {status:200, headers:SSE_HEADERS})` |
| 202-231 | 非流式聚合 | CcStreamParser + hooks（text-delta→fullText；reasoning-delta→reasoningContent；tool-call→toolCalls 数组；finish→finishReason+usage；error→state.upstreamError） |
| 233-271 | 非流式循环 | `readWithTimeout(..., 90s)` 聚合 → `parser.flush`；catch：断连 499 / idle timeout 429(retry_after 5) / 502 proxy_error |
| 273-284 | 非流式终态 | aborted→499；upstreamError→按映射返回；零输出→429 upstream_error retry_after 10（并 abort 上游） |
| 286-311 | 成功响应 | `chat.completion` 体：choices[0].message（content/tool_calls/reasoning_content 按需合并）+ finish_reason + usage（prompt/completion/total + prompt_tokens_details.cached_tokens），`normalizeUsage` 后取值 |
| 312-324 | 外层 catch | 断连 → 499 空响应；否则 502 proxy_error（retry_after 10） |

## HTTP 状态约定

| 场景 | 状态 | body |
|---|---|---|
| 缺 Key | 401 | `{error:{message,type:'auth_error'}}` |
| JSON 非法 / 超限 | 400 / 413 | `{error:{message,type:'invalid_request_error'}}` |
| 上游 4xx/5xx | 映射（errors.CC_STATUS_MAP） | `{error:{...}, retry_after?}` |
| 流式已开播后出错 | 200（SSE 内嵌） | `data: {error:{...}}\n\n`，无 [DONE] |
| 空闲超时（未开播） | 429 | `retry_after: 5` |
| 零输出 | 429 | `retry_after: 10` |
| 客户端断连 | 499（非标准，内部语义） | 空 |
