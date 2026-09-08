# 模块报告：src/anthropic.ts（/v1/messages）

| 属性 | 值 |
|---|---|
| 路径 | `src/anthropic.ts` |
| 行数 | 606（全项目最大模块） |
| 层级 | 协议层 |
| 依赖 | auth、cc、cc-events、errors、http、logger、proxy-handler、runtime、sse、util（10 个） |
| 被依赖 | index（路由挂载） |

## 职责

1. Anthropic → OpenAI 中间格式的协议转换；
2. CC NDJSON → Anthropic SSE 的流式翻译（含 thinking 块与伪签名）；
3. 非流式聚合响应构建；
4. `/v1/messages` 主处理器（结构镜像 openai.handleChatCompletions，但错误形状与块生命周期为 Anthropic 专属）。

## 代码段映射

| 行号 | 符号/段落 | 说明 |
|---|---|---|
| 14-18 | `fakeThinkingSignature(thinkingText)` | `sha256bytes(text \|\| 'dsh-proxy-thinking')` 前 64 字节 → `Uint8Array([0x12, len, ...seed])` → base64。格式上模拟 Anthropic 签名容器，令客户端 SDK 不拒绝 thinking 块 |
| 20-145 | `convertAnthropicToOpenAI(anthropicReq)` | system（字符串/`[{type:'text'}]` 数组拼接）→ system 消息；assistant：text 累积 + `tool_use`→OpenAI `tool_calls`（记录 id→name 映射）；user：text + `tool_result`→`role:'tool'` 消息（content 数组时拼接各 `.text`，name 由映射回填）；顶层：model(默认 claude-sonnet-4-6)/max_tokens(64000)/stream/tools→function 形状/tool_choice（auto/undefined→auto、any→required、tool→{type:'function'}、none→none）/temperature/top_p/stop_sequences→stop/metadata.user_id→user |
| 131-142 | thinking 映射 | `disabled/none`→不设置；`adaptive`→`reasoning_effort = effort ?? 'medium'`；`budget_tokens`：≥10000→high、≥5000→medium、≥2000→low、其余 low |
| 147-177 | `buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText)` | content 顺序：thinking 块（带伪签名）→ text 块 → tool_use 块（arguments JSON.parse 失败回退 `{}`）；`id = msg_{uuid12}`；stop_reason = mapAnthropicStopReason；usage：input/output/cache_creation_input_tokens(cacheWriteTokens，可 null)/cache_read_input_tokens |
| 179-186 | `AnthropicStreamContext` | 跨层状态：bytesReceived/lastCcEvent/tokens×3/upstreamError——供 pump 的超时日志与终态判断 |
| 188-350 | `createAnthropicSseTranslator(response, model, messageId, ctx)` | AsyncGenerator<string>，产出 Anthropic SSE 帧（下详） |
| 194-204 | 生成器状态 | nextBlockIndex/currentBlockIndex/currentBlockType/blockStarted/tokens×4/stopReason/hasError/currentThinkingText |
| 206-220 | `closeBlock()` | 关闭当前块；thinking 块需先补 `signature_delta`（伪签名）再 `content_block_stop` |
| 222-231 | `startBlock(type, contentBlock)` | 类型切换时自动 close 旧块并 `content_block_start` 新块 |
| 233-239 | `startTextBlock/startThinkingBlock` | 便捷封装 |
| 241-251 | message_start | 首帧：`{message:{id,type:'message',role:'assistant',content:[],model,usage:{0,0}}}` |
| 256-298 | hooks | `reasoning-delta`→开启 thinking 块 + `thinking_delta` 帧；`text-delta`→开启 text 块 + `text_delta` 帧（outputTokens+1）；`tool-call`→关当前块 + 一次性三连帧（tool_use start / input_json_delta / stop，outputTokens+20）；`finish-step`/`finish`→handleFinishStep；`error`→hasError + ctx.upstreamError + `event: error` 帧 |
| 300-318 | `handleFinishStep(event)` | stopReason 映射；usage 取 totalUsage\|\|usage 并 normalizeUsage（含 cacheWriteTokens）；无 usage 则全零记账 |
| 320-350 | 主循环 | `readWithTimeout(reader.read(), 30s)` → `parser.push` → 逐条 yield；结束后 flush；`!hasError` 时：关块 → outputTokens===0 则 yield error 帧（zeroOutput 语义交由 pump/state）→ 否则 `message_delta`（stop_reason + usage 四元组）+ `message_stop`；finally reader.cancel |
| 352-354 | `buildAnthropicError(kind, message)` | 413/400 + `invalid_request_error` |
| 356-606 | `handleMessages(request, headers)` | 主处理器（下详） |
| 357-364 | 解析与鉴权 | readRequestJson → getApiKey 缺失 401（`authentication_error`） |
| 366-370 | 转换链 | `convertAnthropicToOpenAI` → `buildCcRequest`（两跳转换） |
| 382-391 | 上游调用 | callUpstream（label 'CC API error (Anthropic)'；onCcError → sendAnthropicError） |
| 393-396 | 流式装配 | `SsePipeline(false)`（手动 start）+ ctx + state |
| 398-416 | onClientAbort | `terminateWith([message_delta(end_turn, usage 0), message_stop])`——断连也输出合法 SSE 结尾 |
| 418-478 | pump | messageId 生成 → 生成器逐帧：未开播时 emit 后仅当帧含 `"text_delta"`/`"tool_use"`/`"thinking_delta"` 才 `pipeline.start()`（防止 message_start/content_block_start 触发提前 200，thinking_delta 也触发开播避免首包假死）；已开播 writeNow；catch 分支同 openai（idle timeout → 已开播写 429 帧 + recordTimeout(apiKey)） |
| 482-504 | 竞速返回 | terminal 胜出且未开播：按 state 顺序返回 upstreamError→429(timeout)→429(zeroOutput)→502(errorMsg)→兜底 429；started：200 + SSE |
| 507-512 | 非流式状态 | finishReason/usage/toolCalls/thinkingText/upstreamError |
| 518-541 | 非流式 hooks | 同 openai 非流式 + `reasoning-delta`→thinkingText 聚合 |
| 543-576 | 非流式循环 | 90s idle 上限；timeout → 429 + `sendAnthropicError(..., {retryAfter:5, headerOnly:true})`；502 |
| 578-592 | 非流式终态 | 零输出 → 429 upstream_error retryAfter 10；成功 → buildAnthropicResponse |
| 593-605 | 外层 catch | 断连 499 / 502 proxy_error |

## 与 openai.ts 的结构对照

| 环节 | openai.ts | anthropic.ts |
|---|---|---|
| 协议转换 | 无 | convertAnthropicToOpenAI（两跳） |
| 流式翻译 | createSseTranslator（工厂钩子） | createAnthropicSseTranslator（AsyncGenerator + 块状态机） |
| 开播条件 | autoStart=true（首事件即开） | 手动：仅 text_delta/tool_use 帧触发 start |
| 断连收尾 | zeroUsageChunk + [DONE] | message_delta(end_turn) + message_stop |
| thinking | reasoning_content 字段 | thinking 块 + 伪 signature |
