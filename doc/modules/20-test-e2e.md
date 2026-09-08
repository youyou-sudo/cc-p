# 模块报告：test/e2e.ts（端到端测试）

| 属性 | 值 |
|---|---|
| 路径 | `test/e2e.ts` |
| 行数 | 456 |
| 运行 | `bun run test`（package.json scripts.test） |
| 拓扑 | mock CC 上游 :4100 ← 被测服务 :4200 ← fetch 断言 |

## 隔离与基建

| 行号 | 段落 | 说明 |
|---|---|---|
| 1-5 | env 注入 | `PORT=4200`、`HOST=127.0.0.1`、`CC_API_BASE=http://127.0.0.1:4100`、`CC_MAX_BODY_MB=1`（专测 413）、无兜底 Key——**必须在 import 被测 app 之前设置**（config 顶层加载） |
| 9-15 | `stats` | mock 上游计数器：generate/fingerprint/lifecycle + lastGenerateHeaders/lastGenerateBody（供请求头/体断言） |
| 17-24 | `ndjson(events)` | 事件数组 → NDJSON ReadableStream（逐行 `JSON.stringify + '\n'`） |
| 26-38 | `slowNdjson()` | 慢速流：start → sleep300 → 'slow' → sleep300 → ' end' + finish——供客户端断连测试 |
| 40 | `usage` | 标准 usage 样本 {input:100, output:20, cached:50} |
| 42-105 | mock Bun.serve(:4100) | 路由：`/_stats`、`/alpha/fingerprint/record`、`/alpha/lifecycle-events`、`/provider/v1/models`（返回 mock-model-a/b）、`/alpha/generate` 按 `params.model` 分支：`mock/reason`（reasoning-delta+text）、`mock/zero`（零输出）、`mock/slow`、`mock/upstream-429`（JSON 429）、`mock/event-error`（流内 `<429>` 错误事件）、`mock/midstream-error`（先 partial 后 error）、`mock/params`（参数透传观测）、默认（Hello world + tool-call get_weather） |
| 107-108 | 启动 | `await import('../src/index.ts')` + sleep 500 |
| 113-122 | 断言工具 | `check(name, cond, extra?)` 计数 PASS/FAIL；`statsFetch()` 读 mock 统计 |

## 用例组与覆盖

| 行号 | 组 | 断言要点 |
|---|---|---|
| 124-144 | basic endpoints | /health `{ok:true}` + CORS `*`；/ `OK`；OPTIONS 204 + Allow-Methods；404 `{error.type:'not_found'}` |
| 146-176 | auth / parse | 缺 Key 双协议 401（auth_error / authentication_error）；无效 JSON 400；body >1MB → 413 |
| 178-244 | openai 非流式 | 内容/`tool_calls`(call_1, get_weather)/finish_reason:tool_calls/usage(100/20/120/cached 50)/`chatcmpl-` 前缀；**上游头**：Bearer 透传、x-session-id≥8、x-project-slug 格式、traceparent `00-{32}-{16}-01`、版本头、x-co-flag/x-taste-learning=false；**上游体**：params.stream===true、system 提取、tools→input_schema、user 消息包装、cache_control 注入末个 text、无 system 角色；**init 幂等**：fingerprint/lifecycle 计数不增，generate +1 |
| 246-263 | openai 流式 | content-type event-stream、末行 `data: [DONE]`、首块含 role、次块仅 content、tool_calls chunk（arguments 原样 JSON 串）、finish chunk 带 usage+finish_reason |
| 265-274 | reasoning | `reasoning_content==='thinking hard'` 与 `content==='Answer'` 并存；finish stop |
| 276-320 | 参数透传 | OpenAI：top_p/stop(数组)/user/seed；Anthropic：top_p、stop_sequences→stop、metadata.user_id→user |
| 322-366 | 零输出与错误 | 零输出非流式 429 + retry_after 10 + Retry-After 头；上游 429 → 429 + retry_after 30；流前 error 事件（未开播）→ JSON 429；流中 error（已开播）→ 仍 200 SSE、含 partial chunk、末帧为 error 且无 [DONE] |
| 368-398 | anthropic 非流式 | `msg_` id、text+tool_use 块、stop_reason:tool_use、usage(100/20/read 50)；上游体：system 提取、tool-call/tool-result 消息形状、tools.name |
| 399-408 | thinking | thinking 块内容 + signature 以 'E' 开头（base64 0x12 前缀）；budget_tokens 12000 → reasoning_effort:high |
| 410-435 | anthropic 流式 | 事件序列 message_start→content_block_*→message_delta→message_stop；text_delta 文本；tool_use 块名 + input_json_delta 原样；message_delta stop_reason:tool_use + usage.output_tokens=20 |
| 437-451 | 断连 | 流式读取一块后 abort → sleep 600 → /health 仍 200（服务未被断连击穿） |
| 453-455 | 收尾 | `RESULT: N passed, M failed`；fail>0 → exit 1 |

## 运行特征

单进程内三个监听端（4200/4100），无外部依赖，秒级完成（除 slow 流 600ms 等待）；适合 CI。
