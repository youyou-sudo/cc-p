# 模块报告：src/modules/responses/（OpenAI Responses 协议）

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/responses/`（11 文件） |
| 层级 | 协议层 |
| 入口 | `POST /v1/responses`（`index.ts` → `ResponsesService.handleBody`） |
| 上游 | `POST {CC_API_BASE}/alpha/generate`（复用 `src/infra/cc.ts` 的 `buildCcRequest` / `forwardToCC`） |
| 被依赖 | `src/app.ts`（`import { responsesController }`） |

## 职责

- 把 OpenAI Responses API 的请求转换为内部 OpenAI chat 形（`convertResponsesToOpenAI`），
  再交给 `buildCcRequest` 生成 CC CLI 仿真请求体；响应侧把 CC NDJSON 事件流翻译成
  Responses 对象 / SSE 事件。
- 与 `modules/chat/`（OpenAI chat）同构，仅请求转换与响应翻译不同；上游编排、gate、
  重试、会话/指纹全部复用 `infra/`，不重复实现。

## 文件清单

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.ts` | 18 | 控制器：`name:'responses'`、`prefix:'/v1'`、`onTransform(createAuthPreCheck(false))`（OpenAI 形 401 前置）、`POST /responses`（`body:'responses.body'`） |
| `model.ts` | 37 | `responsesBody` 宽松 schema（`additionalProperties:true`，联合字段 `t.Any()`，绝不 422 误杀） |
| `service.ts` | 12 | Strangler 包装：`ResponsesService.handleBody` 动态 import `./protocol` |
| `protocol.ts` | 5 | re-export 门面（handler / translator / aggregator 纯函数） |
| `handler.ts` | 113 | 请求门面：401 前检 → `convertResponsesToOpenAI` → `buildCcRequest` → `callUpstream` → 流式/非流分流；499/502 语义 |
| `translator.ts` | 686 | 请求转换 `convertResponsesToOpenAI` + 流式翻译 `createResponsesSseTranslator`（CC NDJSON → Responses SSE） |
| `aggregator.ts` | 263 | 非流聚合 `createResponsesAggregator` + `buildResponsesObject` + `rawUsageFromCcUsage` |
| `stream-handler.ts` | 230 | 流式分支：`SsePipeline(false)` + 首个 `response.output_item.added` 才 `start()`；心跳/空闲超时/499/终端 JSON |
| `non-stream-handler.ts` | 183 | 非流分支：聚合 + 零判定三元组 + 终端组装 + `buildResponsesObject` |
| `errors.ts` | 51 | 终端错误形：`upstreamErrorResponse` / `timeout429Response` / `zeroOutput429Response` / `proxy502Response` |
| `terminal.ts` | 47 | 终端 JSON 组装：走 `streaming/resolveTerminal` 五段（upstreamError → timedOut → zeroOutput → errorMsg → empty） |

## 请求转换（`convertResponsesToOpenAI`）

| Responses | 内部 OpenAI 形 / CC |
|---|---|
| `instructions`（string / blocks） | → `system` 消息（blocks 取 `text` 拼接） |
| `input` 字符串 | → `user` 消息 |
| `input[].{role,content}` 分片 `input_text` / `output_text` / `text` | → `text` |
| `input_image` / `image_url` / `image` | → `image_url`（data URL 兼容） |
| `input[].type: function_call` | → assistant `tool_calls`（`id=call_id`）；连续多个（并行调用）合并进同一条 assistant 消息，保证 tool 结果紧邻 |
| `input[].type: function_call_output` | → `role:'tool'`（`tool_call_id=call_id`，output 字符串化） |
| `input[].type: reasoning` / `item_reference` / mcp_* | 忽略 + debug 日志（无 CC 对应） |
| `input_file` / `refusal` | 文本占位符，不静默丢 |
| `tools[]` 扁平 `{type,name,description,parameters,strict}` | → 嵌套 `{type:'function',function:{…}}`；非 function 工具（web_search 等）warn + 丢弃 |
| `tool_choice` `auto/none/required` / `{type:'function',name}` | 字符串直传；function 形 → `{type:'function',function:{name}}`；未知对象整体透传 |
| `reasoning.effort` / 顶层 `reasoning_effort` | → `reasoning_effort` |
| `max_output_tokens` | → `max_tokens` |
| `temperature` / `top_p` / `parallel_tool_calls` / `prompt_cache_key` / `seed` / `user` | 同名透传 |
| `metadata.user_id` | → `user` |
| `store` / `previous_response_id` / `include` / `truncation` / `text` 等 | 忽略 + debug 日志（无状态代理，不假装支持续接） |

## 响应侧

- **非流**：`buildResponsesObject` 产出 `{id:'resp_…',object:'response',status,output:[reasoning?,message?,function_call…],usage:{input_tokens,input_tokens_details.cached_tokens,output_tokens,output_tokens_details.reasoning_tokens,total_tokens}}`；
  `finishReason: 'length'` → `status:'incomplete'` + `incomplete_details.reason:'max_output_tokens'`。
- **流式**：`response.created` / `response.in_progress` 先缓冲，首个 `response.output_item.added`
  才 `start()`（零输出可回落 429 JSON）；文本走 `content_part.added` + `output_text.delta` + `done`；
  工具走 `function_call_arguments.delta/done`；推理走 `reasoning_summary_part.added` +
  `reasoning_summary_text.delta/done`；终帧 `response.completed`（或 `response.incomplete`），
  **不发 `[DONE]`**（Responses SDK 以 `response.completed` 终止）。
- `error` 事件帧为 `{type:'error',code,message,param,sequence_number}`；所有事件带连续
  `sequence_number`（0 起递增）。

## 红线不变量

- 零输出（无 text/reasoning/tool 且 outputTokens=0）→ `429 retry_after:10`，流式未 start 时不得翻转成 SSE 200。
- 流前/非流 abort → 499 无 body；流中 abort → 静默 close，绝不伪造 `response.completed` 成功帧。
- 502 统一不带 `retry_after` / `Retry-After`；上游映射错误（429 等）原样透传。
- `STREAM_IDLE_TIMEOUT` tag 不可改（catch 侧字符串匹配分流）；thinking 期走 120s 宽限。
- gate 槽位释放幂等（`finalizePump` 顺序 cancel → clearInterval → close → release）。
- 401/400/413 复用 `plugins/auth.ts` / `plugins/errors.ts` 的非 `/v1/messages` 分支（OpenAI `{error:{…}}` 形）。
