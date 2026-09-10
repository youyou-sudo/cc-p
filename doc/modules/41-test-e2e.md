# 模块报告：test/e2e.ts

| 属性 | 值 |
|---|---|
| 路径 | `test/e2e.ts` |
| 行数 | 486 |
| 层级 | 测试 |
| 依赖 | `../src/index.ts`（动态 import）；Bun 全局（`Bun.serve`/`fetch`/`ReadableStream`/`TextEncoder`/`Bun.sleep`） |
| 被依赖 | 无（独立入口脚本） |

## 职责

- 端到端验证代理两大协议路由（OpenAI `/v1/chat/completions`、Anthropic `/v1/messages`）的完整请求/响应转换。
- 在进程内起一个 mock CC 上游（`:4100`），捕获并被测服务（`:4200`）转发的上游请求头与请求体，逐项断言。
- 覆盖基本路由/CORS、鉴权与解析错误、模型列表、流式与非流式、reasoning、参数透传、零输出与上游错误、客户端断连等路径。
- 通过计数器证明 fingerprint/lifecycle 初始化请求幂等、generate 请求按预期递增。

## 代码段映射

| 行号 | 符号/段落 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-5 | env 注入 | env | — | `PORT=4200`、`HOST=127.0.0.1`、`CC_API_BASE=http://127.0.0.1:4100`、`CC_MAX_BODY_MB=1`（专测 413）、`CC_API_KEY=''`；必须先于被测 app 的 import |
| 7 | `enc` | 工具 | P | 模块级 `TextEncoder` 单例 |
| 9-15 | `stats` | 状态 | P | mock 上游计数器 `generate`/`fingerprint`/`lifecycle` + `lastGenerateHeaders`/`lastGenerateBody`（供头/体断言） |
| 17-24 | `ndjson(events)` | 工具 | P | 事件数组 → NDJSON `ReadableStream<Uint8Array>`（逐行 `JSON.stringify + '\n'`） |
| 26-38 | `slowNdjson()` | 工具 | P | 慢速流：`start` → sleep300 → `slow` → sleep300 → ` end` + `finish`，供断连测试 |
| 40 | `usage` | 状态 | P | 标准 usage 样本 `{inputTokens:100, outputTokens:20, cachedInputTokens:50}` |
| 42-105 | mock `Bun.serve(:4100)` | mock | P | 上游桩服务总入口 |
| 46 | └ `/_stats` | mock | P | 返回 `stats` JSON，供 `statsFetch` 读取 |
| 47 | └ 头捕获 | mock | P | 每次请求把 headers 转对象，供 `/alpha/generate` 记录 |
| 49 | └ `/alpha/fingerprint/record` | mock | P | `stats.fingerprint++` 后返回 `{}` |
| 50 | └ `/alpha/lifecycle-events` | mock | P | `stats.lifecycle++` 后返回 `{}` |
| 51-53 | └ `/provider/v1/models` | mock | P | 返回 `mock-model-a`（含 `context_window:128000`）、`mock-model-b`（含 `context_length:64000`）、`claude-sonnet-4-6` |
| 54-102 | └ `/alpha/generate` | mock | P | 计数并记录头/体，按 `body.params.model` 分支 |
| 61-67 | └ `mock/reason` | mock | P | `start` + `reasoning-delta:'thinking hard'` + `text-delta:'Answer'` + `finish:stop` |
| 68-72 | └ `mock/zero` | mock | P | `start` + `finish`（零文本、`outputTokens:0`） |
| 73-74 | └ `mock/slow` | mock | P | 返回 `slowNdjson()` 慢速流 |
| 75-76 | └ `mock/upstream-429` | mock | P | 直接 `Response.json` 429 `{error:{message:'rate limited upstream'}}` |
| 77-80 | └ `mock/event-error` | mock | P | 流内 `type:'error'` 事件 `'<429> slow down'` |
| 81-86 | └ `mock/midstream-error` | mock | P | `text-delta:'partial'` → `error` → `finish`（已开播后报错） |
| 87-92 | └ `mock/params` | mock | P | `start` + `text-delta:'params-ok'` + `finish`，供参数透传观测 |
| 93-101 | └ 默认分支 | mock | P | `start` + `Hello` + ` world` + `tool-call`（`get_weather`/`call_1`）+ `finish:tool-calls` + `usage` |
| 103 | └ 兜底 | mock | P | 其余路径返回 404 `nf` |
| 107-108 | 启动 | 基建 | P | `await import('../src/index.ts')` 后 `Bun.sleep(500)` 等待监听就绪 |
| 110-111 | `BASE` / `KEY` | 状态 | P | 被测基址 `http://127.0.0.1:4200`、测试 Key `user_testkey123` |
| 113-117 | `check(name, cond, extra?)` | 断言 | P | PASS/FAIL 计数，失败时打印 JSON 化的 extra |
| 119-122 | `statsFetch()` | 工具 | P | 拉取 mock 上游 `/_stats` |
| 124-144 | basic endpoints | 用例组 | P | `/health` 200+`{ok:true}`+CORS `*`；`/` 返回 `OK`；`OPTIONS` 204+CORS 方法头；未知路径 404 `{error.type:'not_found'}` |
| 146-186 | auth / parse errors | 用例组 | P | 缺 Key 双协议 401（`auth_error` / `authentication_error`）；无效 JSON 400（含 Anthropic 形状）；体 >1MB → 413（消息含 `1MB`）；无 Key 时 `/v1/models` 仍 200 |
| 188-196 | models | 用例组 | P | 动态列表 `object:'list'`、`data.length===3`；`context_window` 透传、`context_length` 别名映射、静态兜底窗口 200000 |
| 198-247 | openai 非流式 | 用例组 | P | 内容合并 `Hello world`、`tool_calls` 映射、`finish_reason:tool_calls`、usage(100/20/120/cached 50)、`chatcmpl-` id；上游头（Bearer、x-session-id≥8、x-project-slug 格式、traceparent、版本头、co/taste flag）；上游体（`params.stream===true`、system 提取、tools→input_schema、user 包装、cache_control 注入、无 system 角色）；init 不重复 + generate 递增 |
| 249-266 | openai 流式 | 用例组 | P | `text/event-stream`、末行 `data: [DONE]`、首块带 role、次块仅 content、tool_calls chunk（arguments `{"city":"SF"}`）、finish chunk 带 usage |
| 268-277 | openai reasoning | 用例组 | P | `reasoning_content==='thinking hard'` 与 `content==='Answer'` 并存、`finish_reason:stop` |
| 279-323 | 参数透传 | 用例组 | P | OpenAI：`top_p`/`stop`(数组)/`user`/`seed`；Anthropic：`top_p`、`stop_sequences`→`stop`、`metadata.user_id`→`user` |
| 325-369 | 零输出 / 上游错误 | 用例组 | P | 零输出非流式 429 + `retry_after:10` + `Retry-After` 头；上游 429 映射 `retry_after:30`；流前 error 事件 → JSON 429；非流式 error 事件 → 429；流中 error → 保持 200 SSE、含 partial chunk、末帧为 error 且无 `[DONE]` |
| 371-411 | anthropic 非流式 | 用例组 | P | `msg_` id、text+tool_use 块、`stop_reason:tool_use`、usage(100/20/read 50)；上游体消息转换（tool-call/tool-result 形状）；thinking 块 + 伪签名以 `E` 开头；`budget_tokens:12000`→`reasoning_effort:high` |
| 413-438 | anthropic 流式 | 用例组 | P | 事件序列 `message_start`→`content_block_*`→`message_delta`→`message_stop`；`text_delta` 文本；`tool_use` 块名 + `input_json_delta` 原样；`message_delta` 的 `stop_reason` + `usage.output_tokens` |
| 440-465 | anthropic 零输出 / 上游错误 | 用例组 | P | 零输出 429（Anthropic error 形状 + `retry_after:10` + 头）；上游 429 映射 429 + `retry_after:30`；流前 error → JSON 429（非 event-stream） |
| 467-481 | 客户端断连 | 用例组 | P | `AbortController` 读取一块后 abort，sleep 600 后 `/health` 仍 200（服务未被断连击穿） |
| 483-486 | 结果 / 导出 | 输出 | E | 打印 `RESULT: N passed, M failed`；`fail>0` → `process.exit(1)`；`export {}` 使文件成为模块 |

## 关键行为

- 单进程监听两个端口（mock `:4100` + 被测 `:4200`），无外部依赖，秒级完成（`slowNdjson` 两次 300ms 与启动 sleep 为主要等待）。
- env 注入必须在 L107 动态 import 之前完成（L1-5），否则 config 顶层读取到错误值。
- `stats` 计数器是幂等性断言的依据：L239-246 证明第二次请求 fingerprint/lifecycle 不增、generate +1。
- 上游请求体断言依赖 mock 在 L57-58 保存的 `lastGenerateBody`，覆盖 system 提取、工具映射与 cache_control 注入。
- 错误路径区分「开播前」（可返回协议化 JSON 错误）与「开播后」（保持 200 SSE 并内嵌 error 帧），见 L342-369。
- 运行方式：`bun run test`（等价 `bun run test/e2e.ts`）。
