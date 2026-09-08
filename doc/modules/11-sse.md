# 模块报告：src/sse.ts（SSE 管道与 OpenAI 翻译器）

| 属性 | 值 |
|---|---|
| 路径 | `src/sse.ts` |
| 行数 | 194 |
| 层级 | 共享管道 |
| 依赖 | `./logger`、`./errors`(mapCcEventError/mapFinishReason/normalizeUsage)、`./cc-events`(CcStreamParser/CcEventHooks) |
| 被依赖 | openai（两者都用）、anthropic（仅 SsePipeline） |

## SsePipeline（L6-79）：可控 SSE 发送流

| 行号 | 成员 | 说明 |
|---|---|---|
| 13-18 | 字段 | `stream`（ReadableStream<Uint8Array>）、`firstOutput`/`terminal`（Promise，供 handler 竞速）、`started`/`closed`/`keepaliveCount` |
| 20-26 | `constructor(autoStart)` | autoStart=true：emit 即开播（OpenAI 路径，收到首事件立即 200）；false：需显式 start（Anthropic 路径，只有 text/tool 事件才开播，保证 race 不被 message_start 误触发） |
| 28-32 | `enqueue(text)` | 编码入队；controller 失效（客户端断连后）静默吞错 |
| 34-41 | `emit(events)` | 未开播 → 入 `buffered`；开播 → 直写；autoStart 时自动 start |
| 43-47 | `emitKeepalive()` | 写 `: keepalive\n\n` 注释帧（SSE 规范允许，客户端忽略），防止代理层空闲断连；keepaliveCount 供日志 |
| 49-51 | `writeNow(event)` | 绕过缓冲直写（错误事件/已开播后的必达写入） |
| 53-59 | `start()` | 冲刷 buffered → resolve firstOutput（handler 的 race 得到 'started' → 返回 200 SSE 响应） |
| 61-68 | `close()` | 关 controller → resolve terminal |
| 70-78 | `terminateWith(events)` | 客户端断连的优雅收尾：冲刷 + 写终止事件（zeroUsageChunk/[DONE] 或 message_delta+message_stop）+ close |

**关键语义**：handler 在 `void pump()` 后 `Promise.race(firstOutput, terminal)`——若 pump 在产生任何输出前就终结（错误/超时/零输出），可改为返回协议化 JSON 错误而非 200+SSE；一旦 `firstOutput` 胜出，只能以 SSE 继续并内嵌错误帧。

## createSseTranslator（L93-194）：CC → OpenAI chunk 翻译器

| 行号 | 部分 | 说明 |
|---|---|---|
| 94-105 | 闭包状态 | chunkIndex（首块带 role）/finishReason/usage/toolCallIndex/内嵌 CcStreamParser/tokens 容器 |
| 107-163 | hooks | `text-delta`→`{content}`（首块 `{role:'assistant',content}`，空文本跳过）；`reasoning-delta`→`{reasoning_content}`；`tool-call`→`{tool_calls:[{index,id,type:'function',function:{name,arguments}}]}`（id 缺省 `call_{Date.now()}_{i}`，arguments 非字符串则 stringify）；`finish-step`→更新 finishReason+usage；`finish`→最终空 delta chunk 附 OpenAI usage（prompt/completion/total/cached_tokens）并定稿 finishReason；`error`→记 upstreamError（不产 chunk） |
| 165-193 | 返回 API | getter：lastCcEvent/upstreamError/inputTokens/outputTokens/cachedInputTokens；`parseChunk(bytes)`/`flush()`/`getDoneEvent()`（`data: [DONE]\n\n`） |

## makeChunk（L81-91）

`data: {id,object:'chat.completion.chunk',created,model,choices:[{index:0,delta,finish_reason}]}\n\n`；usage 非空时附加。

## 对比：anthropic 的翻译器为何不同？

Anthropic 协议需要**跨事件的有状态块管理**（content_block_start/delta/stop + thinking 签名），无法写成纯函数钩子，因此 anthropic.ts 用 AsyncGenerator 实现（见 15-anthropic.md）；而 OpenAI chunk 天然无状态，适合本文件的工厂函数。
