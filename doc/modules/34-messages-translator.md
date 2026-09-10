# 模块报告：src/modules/messages/translator.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/messages/translator.ts` |
| 行数 | 333 |
| 层级 | 协议层 |
| 依赖 | `../../infra/cc-events`、`../../shared/errors`、`../../shared/logger`、`../../shared/util` |
| 被依赖 | `src/modules/messages/protocol.ts`、`src/modules/messages/handler.ts`、`src/modules/messages/aggregator.ts` |

## 职责

- Anthropic → OpenAI 中间格式的请求转换（`convertAnthropicToOpenAI`）。
- CC NDJSON → Anthropic SSE 的流式翻译（`createAnthropicSseTranslator`，闭包状态机 + `CcStreamParser` 钩子）。
- 为 thinking 块生成满足客户端格式校验的伪签名（`fakeThinkingSignature`）。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-5 | — | import | — | `CcStreamParser`/`CcEventHooks`、errors 映射、logger、util（bytesToBase64/sha256bytes/uuid） |
| 7-11 | `fakeThinkingSignature` | 函数 | E | `sha256bytes(text || 'dsh-proxy-thinking').slice(0,64)` → `Uint8Array([0x12, seed.length, ...seed])` → base64 |
| 13-145 | `convertAnthropicToOpenAI` | 函数 | E | Anthropic 请求 → OpenAI 中间格式 |
| 14-24 | └ system | 逻辑 | P | 字符串直取；数组按 `type==='text'` 过滤后 `join('\n')` |
| 26-27 | └ 局部容器 | 逻辑 | P | `toolNameFromId` 映射 + `openaiMessages` |
| 29-31 | └ system 消息 | 逻辑 | P | 有 systemPrompt 则 push `{role:'system',content}` |
| 34-56 | └ assistant 段 | 逻辑 | P | text 累积；`tool_use`→`tool_calls`（记录 id→name）；`content` 为 text 或空时仍 push |
| 38-53 |   └ 块遍历 | 逻辑 | P | `text`→拼 textContent；`tool_use`→记名并 push `{id,type:'function',function:{name,arguments:JSON.stringify(input)}}` |
| 57-92 | └ user 段 | 逻辑 | P | 文本 + `tool_result`→`role:'tool'` 消息，文本随后单独成 user 消息 |
| 61-74 |   └ 内容收集 | 逻辑 | P | 字符串体；数组体收集 text（记录首个 `cache_control:ephemeral`）与 `tool_result` |
| 75-86 |   └ tool 结果 | 逻辑 | P | content 字符串/数组拼接/String 化；按 `toolNameFromId` 回填 `name` |
| 87-91 |   └ user 文本 | 逻辑 | P | `{role:'user',content:[{type:'text',text}]}`，带 cache_control 时注入 |
| 95-100 | └ body 骨架 | 逻辑 | P | `model || 'deepseek/deepseek-v4-flash'`；`messages`；`max_tokens || 64000`；`stream === true` |
| 102-111 | └ tools | 逻辑 | P | `tools[].input_schema` → `function.parameters`（缺省 `{type:'object',properties:{}}`） |
| 113-124 | └ tool_choice | 逻辑 | P | auto/undefined→`'auto'`；any→`'required'`；tool→`{type:'function',function:{name}}`；none→`'none'` |
| 126-129 | └ 透传字段 | 逻辑 | P | temperature/top_p；`stop_sequences`→`stop`；`metadata.user_id`→`user` |
| 131-142 | └ thinking | 逻辑 | P | disabled/none→忽略；adaptive→`reasoning_effort = effort ?? 'medium'`；budget_tokens≥10000→high、≥5000→medium、≥2000→low、其余 low |
| 144 | └ 返回 | 逻辑 | P | `openaiReq` |
| 147-155 | `AnthropicStreamContext` | interface | E | 跨层状态：bytesReceived/lastCcEvent/inputTokens/outputTokens/cachedInputTokens/cacheWriteTokens/upstreamError |
| 157-333 | `createAnthropicSseTranslator` | 函数 | E | 工厂函数，返回逐帧字符串数组的翻译器对象 |
| 162-172 | └ 闭包状态 | 字段 | P | nextBlockIndex/currentBlockIndex/currentBlockType/blockStarted/tokens×4/stopReason/hasError/currentThinkingText |
| 174-188 | └ `closeBlock` | 函数 | P | thinking 块先补 `signature_delta`（伪签名）再 `content_block_stop`；返回关闭帧 |
| 190-199 | └ `startBlock` | 函数 | P | 类型不同时先 `closeBlock` 再递增索引并 `content_block_start` |
| 201-207 | └ `startTextBlock`/`startThinkingBlock` | 函数 | P | 对 `startBlock` 的便捷封装 |
| 209-219 | └ `messageStartFrame` | 常量 | P | 首帧 message 骨架（id/type/role/content/model/usage 0,0） |
| 221 | └ `parser` | 常量 | P | `new CcStreamParser()` |
| 223-277 | └ `hooks` | 逻辑 | P | 按 CC 事件产 Anthropic SSE 帧 |
| 224-230 |   └ reasoning-delta | 逻辑 | P | 开 thinking 块、累 `currentThinkingText`、产 `thinking_delta` |
| 232-237 |   └ text-delta | 逻辑 | P | 开 text 块、`outputTokens += 1`、产 `text_delta` |
| 239-254 |   └ tool-call | 逻辑 | P | 关当前块；一次性产 tool_use 的 start/input_json_delta/stop；`outputTokens += 20` |
| 256-257 |   └ finish-step/finish | 逻辑 | P | 均指向 `handleFinishStep` |
| 259-276 |   └ error | 逻辑 | P | `hasError=true`；`ctx.upstreamError = mapCcEventError`；log warn；产 `event: error` 帧（带 retry_after） |
| 279-293 | `handleFinishStep` | 函数 | P | 映射 stopReason；取 `totalUsage||usage` normalizeUsage 后记 tokens 四元组并回写 ctx |
| 295-332 | └ 返回对象 | API | P | 翻译器公开方法 |
| 296-298 |   └ `startEvents` | 方法 | P | 返回 `[messageStartFrame]` |
| 300-305 |   └ `parseChunk` | 方法 | P | `ctx.bytesReceived += byteLength`；`parser.push(bytes,hooks)`；同步 `ctx.lastCcEvent` |
| 307-311 |   └ `flush` | 方法 | P | `parser.flush(hooks)`；同步 `ctx.lastCcEvent` |
| 313-331 |   └ `finishEvents` | 方法 | P | `hasError` 返回 `[]`；否则关块；`outputTokens===0` 产 error(upstream_error,retry_after 10)，否则产 `message_delta`+`message_stop` |

## 关键行为

- `fakeThinkingSignature`（7-11）用 `0x12`（TLS-like 容器标记）+ 长度 + sha256 截断构造 base64，只为让 Anthropic 客户端 SDK 接受 thinking 块，并非真实加密签名。
- `convertAnthropicToOpenAI` 的两跳细节：assistant 的 `tool_use` 会先登记 `toolNameFromId`（43），供后续 user 的 `tool_result` 回填 `name`（84）；user 的文本与 tool 结果分属不同消息（tool 在前、user 文本在后）。
- `convertAnthropicToOpenAI` 顶层默认值（96、98）与 model.ts/handler 的默认值独立：此处默认 `deepseek/deepseek-v4-flash`、max_tokens 64000。
- thinking 映射（131-142）只产出 `reasoning_effort`，不产出 Anthropic 侧字段；`disabled`/`none` 显式忽略。
- 块生命周期（174-199）：`startBlock` 在类型切换或未开块时先关旧块；thinking 块关闭必须补 `signature_delta`（180-181），否则客户端会拒收。
- `tool-call`（239-254）不受 `blockStarted` 复用逻辑约束：它关当前块后自增一个独立索引，三帧一次成块，且 `outputTokens += 20` 为估算值。
- `finishEvents`（313-331）：`hasError` 时不补 message_delta/message_stop（错误帧已由 hooks.error 发出）；零输出单独产 error 帧而非正常收尾，交由 handler 决定走 terminal JSON 429。
- `finishEvents` 的 usage 四元组（322-326）：`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`/`input_tokens`，其中 cacheWrite 缺省补 0。
- 注意：本文件的 `createAnthropicSseTranslator` 是返回 `{startEvents,parseChunk,flush,finishEvents}` 的工厂函数，**不是** `AsyncGenerator`；旧文档 15-anthropic.md 的 AsyncGenerator 描述已过时。
