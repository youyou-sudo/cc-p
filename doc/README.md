# Command Code Proxy 项目文档

> 生成时间：2026-09-10 · 基于工作区全量扫描（`src/` 40 个源文件、`test/` 4 个测试，共约 4 518 行 TypeScript）

## 1. 项目简介

**Command Code Proxy**（`commandcode-proxy-elysia`）是一个基于 **Bun + Elysia** 的 API 代理服务，将 **OpenAI** 与 **Anthropic** 两种协议的请求转换为 Command Code（CC）上游的 `/alpha/generate` NDJSON 流式协议，并把上游事件流实时翻译回各自的 SSE / JSON 格式。

- 运行时：Bun（`bun run src/index.ts`），可编译为单文件二进制（Docker distroless）
- 唯一运行时依赖：`elysia ^1.4.30`（其余全部为标准库 / Bun 全局 API）
- 端口：默认 `3050`，监听地址 `0.0.0.0`（`config.json` / 环境变量可覆盖）

## 2. HTTP 路由一览

| 方法 | 路径 | 处理入口 | 协议 | 源文件 |
|---|---|---|---|---|
| GET | `/` | `healthController` | 健康探针（文本 `OK`） | `src/modules/health/index.ts` |
| GET | `/health` | `healthController` | 健康探针（JSON `{ok:true}`） | `src/modules/health/index.ts` |
| GET | `/v1/models` | `modelsController` → `ModelsService.list` | OpenAI Models API | `src/modules/models/catalog.ts`（`handleModels`） |
| POST | `/v1/chat/completions` | `chatController` → `ChatService.handleBody` | OpenAI Chat Completions（SSE / JSON） | `src/modules/chat/handler.ts`（`handleChatCompletionsBody`） |
| POST | `/v1/messages` | `messagesController` → `MessagesService.handleBody` | Anthropic Messages（SSE / JSON） | `src/modules/messages/handler.ts`（`handleMessagesBody`） |
| OPTIONS | 任意 | `corsPlugin.onRequest`（204） | CORS 预检 | `src/plugins/cors.ts` |

另有 CLI 子命令：`server healthcheck`（`src/index.ts`），供 Docker HEALTHCHECK 使用。

## 3. 架构分层

```
┌──────────────────────────────────────────────────────────────────────┐
│  入口层      src/index.ts        启动 + healthcheck CLI + unhandledRejection │
│             src/app.ts          Elysia 组装：use cors/errors/body/auth 插件    │
│                                 + 4 个 controller                          │
├──────────────────────────────────────────────────────────────────────┤
│  插件层      src/plugins/cors.ts     onRequest 打 CORS 头 / OPTIONS 204     │
│             src/plugins/errors.ts   onError：404/413/PARSE/VALIDATION→双协议 │
│             src/plugins/body.ts     onParse 单次限流 JSON 解析 + 413 哨兵    │
│             src/plugins/auth.ts     getApiKey decorate / requireAuth macro  │
├──────────────────────────────────────────────────────────────────────┤
│  协议层      src/modules/chat/      OpenAI /v1/chat/completions              │
│             src/modules/messages/   Anthropic /v1/messages                   │
│             src/modules/models/     /v1/models                               │
│             src/modules/health/     / 与 /health                             │
├──────────────────────────────────────────────────────────────────────┤
│  共享管道层  src/infra/cc-events.ts     CC NDJSON 解析器（事件分发）        │
│             src/infra/sse.ts           协议无关 SsePipeline + 空闲心跳       │
│             src/infra/proxy-handler.ts 请求前导 / 断连 / 上游调用编排        │
├──────────────────────────────────────────────────────────────────────┤
│  上游对接层  src/infra/cc.ts            请求体构建 + HTTP 转发                │
│             src/infra/fingerprint.ts   指纹伪造 + 生命周期上报               │
│             src/infra/session.ts       会话 ID 管理（12h + 抖动）            │
├──────────────────────────────────────────────────────────────────────┤
│  基础设施层  src/shared/config.ts  src/shared/http.ts  src/shared/auth.ts   │
│             src/shared/logger.ts  src/shared/util.ts  src/shared/runtime.ts │
│             src/shared/errors.ts  src/shared/version.ts                     │
│             src/shared/cc-types.ts（纯类型）                                 │
└──────────────────────────────────────────────────────────────────────┘
```

## 4. 请求流转（核心数据流）

以 `/v1/messages` 与 `/v1/chat/completions` 为例，两条路径共用同一套前缀与上游编排，仅协议转换 / 翻译层不同：

```
createApp                     (src/app.ts)
  → corsPlugin.onRequest       (src/plugins/cors.ts，打 CORS 头 / OPTIONS 204)
  → bodyLimitPlugin.onParse    (src/plugins/body.ts，readJsonBody 单次限流解析)
      └ 超限 → onTransform 抛普通 Error(status=413) 哨兵
  → errorsPlugin.onError       (src/plugins/errors.ts，401/404/413/PARSE/VALIDATION 双协议体)
  → messagesController / chatController
                              (src/modules/*/index.ts)
      └ onTransform: createAuthPreCheck(isAnthropic)  ← auth 前置，无 key 时短路 validation
  → body schema 校验           (body: 'messages.body' / 'chat.body')
      └ 失败 → validation 400
  → MessagesService.handleBody / ChatService.handleBody
                              (src/modules/*/service.ts → handler.ts)
  → getApiKey                  (src/shared/auth.ts，Bearer / x-api-key / CC_API_KEY 兜底，401)
  → convertAnthropicToOpenAI   (仅 messages：src/modules/messages/translator.ts)
  → buildCcRequest             (src/infra/cc.ts，OpenAI → CC 请求体)
  → createUpstreamFlow         (src/infra/proxy-handler.ts，客户端断连 → 级联 abort)
  → callUpstream               (src/infra/proxy-handler.ts)
       → ensureInitialized     (src/infra/fingerprint.ts，指纹上报 + 生命周期事件，8h 缓存)
       → forwardToCC           (src/infra/cc.ts)
                                  POST {CC_API_BASE}/alpha/generate → NDJSON
  ├─ stream=true：
  │    chat：createSseTranslator   (src/modules/chat/translator.ts)
  │          + SsePipeline(true)   (src/infra/sse.ts, autoStart)
  │          + startSseHeartbeat(pingEvent=SSE_KEEPALIVE_COMMENT)
  │    messages：createAnthropicSseTranslator (src/modules/messages/translator.ts)
  │          + SsePipeline(false) + emitAnthropic（缓冲 message_start，
  │            首个 content_block_* 才 flush 头）
  │    → CcStreamParser (src/infra/cc-events.ts) 逐行解析 NDJSON
  │    → new Response(pipeline.stream, SSE_HEADERS)
  └─ stream=false：
       CcStreamParser 聚合 → createChatAggregator / createMessagesAggregator
       → buildChatCompletion / buildAnthropicResponse
       → sendJSON / sendAnthropicError (src/shared/http.ts) → JSON
```

**流式与非流式的差异**

- chat 流式：`SsePipeline(true)`（`autoStart=true`）+ 工厂函数翻译器 `createSseTranslator`，心跳用 SSE 注释帧 `SSE_KEEPALIVE_COMMENT`（OpenAI SDK 只认 `data:` 行）。
- messages 流式：`SsePipeline(false)` + `emitAnthropic` 缓冲，闭包工厂函数 `createAnthropicSseTranslator`（返回 `{startEvents,parseChunk,flush,finishEvents}`，非 AsyncGenerator）；`message_start` 保持缓冲，仅首个 `content_block_*` 才 `start()` flush 头，保证空回包走 JSON 429 而非 SSE 200；心跳默认 Anthropic 原生 `ping` 事件。
- 两者非流式均走聚合器 + `SsePipeline` 之外的 JSON 响应构建；零输出统一归 `429 retry_after:10`。

## 5. 模块清单与文档索引

### 模块报告（doc/modules/）

| # | 报告 | 源文件 | 行数 | 层级 |
|---|---|---|---|---|
| 01 | [01-index.md](modules/01-index.md) | `src/index.ts` | 79 | 入口层 |
| 02 | [02-app.md](modules/02-app.md) | `src/app.ts` | 21 | 入口层 |
| 03 | [03-plugins-cors.md](modules/03-plugins-cors.md) | `src/plugins/cors.ts` | 16 | 插件层 |
| 04 | [04-plugins-errors.md](modules/04-plugins-errors.md) | `src/plugins/errors.ts` | 60 | 插件层 |
| 05 | [05-plugins-body.md](modules/05-plugins-body.md) | `src/plugins/body.ts` | 77 | 插件层 |
| 06 | [06-plugins-auth.md](modules/06-plugins-auth.md) | `src/plugins/auth.ts` | 70 | 插件层 |
| 07 | [07-config.md](modules/07-config.md) | `src/shared/config.ts` | 148 | 基础设施层 |
| 08 | [08-logger.md](modules/08-logger.md) | `src/shared/logger.ts` | 16 | 基础设施层 |
| 09 | [09-util.md](modules/09-util.md) | `src/shared/util.ts` | 75 | 基础设施层 |
| 10 | [10-runtime.md](modules/10-runtime.md) | `src/shared/runtime.ts` | 139 | 基础设施层 |
| 11 | [11-http.md](modules/11-http.md) | `src/shared/http.ts` | 126 | 基础设施层 |
| 12 | [12-auth.md](modules/12-auth.md) | `src/shared/auth.ts` | 43 | 基础设施层 |
| 13 | [13-cc-types.md](modules/13-cc-types.md) | `src/shared/cc-types.ts` | 39 | 基础设施层 |
| 14 | [14-errors.md](modules/14-errors.md) | `src/shared/errors.ts` | 109 | 基础设施层 |
| 15 | [15-version.md](modules/15-version.md) | `src/shared/version.ts` | 25 | 基础设施层 |
| 16 | [16-cc-events.md](modules/16-cc-events.md) | `src/infra/cc-events.ts` | 101 | 共享管道层 |
| 17 | [17-cc.md](modules/17-cc.md) | `src/infra/cc.ts` | 216 | 上游对接层 |
| 18 | [18-sse.md](modules/18-sse.md) | `src/infra/sse.ts` | 138 | 共享管道层 |
| 19 | [19-proxy-handler.md](modules/19-proxy-handler.md) | `src/infra/proxy-handler.ts` | 97 | 共享管道层 |
| 20 | [20-session.md](modules/20-session.md) | `src/infra/session.ts` | 60 | 上游对接层 |
| 21 | [21-fingerprint.md](modules/21-fingerprint.md) | `src/infra/fingerprint.ts` | 190 | 上游对接层 |
| 22 | [22-chat-index.md](modules/22-chat-index.md) | `src/modules/chat/index.ts` | 18 | 协议层 |
| 23 | [23-chat-model.md](modules/23-chat-model.md) | `src/modules/chat/model.ts` | 35 | 协议层 |
| 24 | [24-chat-service.md](modules/24-chat-service.md) | `src/modules/chat/service.ts` | 17 | 协议层 |
| 25 | [25-chat-protocol.md](modules/25-chat-protocol.md) | `src/modules/chat/protocol.ts` | 5 | 协议层 |
| 26 | [26-chat-handler.md](modules/26-chat-handler.md) | `src/modules/chat/handler.ts` | 374 | 协议层 |
| 27 | [27-chat-translator.md](modules/27-chat-translator.md) | `src/modules/chat/translator.ts` | 170 | 协议层 |
| 28 | [28-chat-aggregator.md](modules/28-chat-aggregator.md) | `src/modules/chat/aggregator.ts` | 110 | 协议层 |
| 29 | [29-messages-index.md](modules/29-messages-index.md) | `src/modules/messages/index.ts` | 18 | 协议层 |
| 30 | [30-messages-model.md](modules/30-messages-model.md) | `src/modules/messages/model.ts` | 33 | 协议层 |
| 31 | [31-messages-service.md](modules/31-messages-service.md) | `src/modules/messages/service.ts` | 27 | 协议层 |
| 32 | [32-messages-protocol.md](modules/32-messages-protocol.md) | `src/modules/messages/protocol.ts` | 5 | 协议层 |
| 33 | [33-messages-handler.md](modules/33-messages-handler.md) | `src/modules/messages/handler.ts` | 414 | 协议层 |
| 34 | [34-messages-translator.md](modules/34-messages-translator.md) | `src/modules/messages/translator.ts` | 333 | 协议层 |
| 35 | [35-messages-aggregator.md](modules/35-messages-aggregator.md) | `src/modules/messages/aggregator.ts` | 117 | 协议层 |
| 36 | [36-models-index.md](modules/36-models-index.md) | `src/modules/models/index.ts` | 13 | 协议层 |
| 37 | [37-models-model.md](modules/37-models-model.md) | `src/modules/models/model.ts` | 33 | 协议层 |
| 38 | [38-models-service.md](modules/38-models-service.md) | `src/modules/models/service.ts` | 15 | 协议层 |
| 39 | [39-models-catalog.md](modules/39-models-catalog.md) | `src/modules/models/catalog.ts` | 124 | 协议层 |
| 40 | [40-health.md](modules/40-health.md) | `src/modules/health/index.ts` | 12 | 协议层 |
| 41 | [41-test-e2e.md](modules/41-test-e2e.md) | `test/e2e.ts` | 486 | 测试 |
| 42 | [42-test-heartbeat.md](modules/42-test-heartbeat.md) | `test/heartbeat.ts` | 89 | 测试 |
| 43 | [43-test-idle-timeout-env.md](modules/43-test-idle-timeout-env.md) | `test/idle-timeout-env.ts` | 111 | 测试 |
| 44 | [44-test-timeouts.md](modules/44-test-timeouts.md) | `test/timeouts.ts` | 114 | 测试 |

### 总报告

| 文档 | 内容 |
|---|---|
| [code-map.md](code-map.md) | 全部 44 个文件（src 40 + test 4）符号级映射 + 依赖矩阵 |

## 6. 关键运行参数（速查）

| 常量 | 值 | 定义处 |
|---|---|---|
| 流式空闲超时 `STREAM_IDLE_TIMEOUT_MS` | 30 000 ms（`CC_STREAM_IDLE_MS` 可覆盖，默认不变） | `src/shared/config.ts:136-139` |
| 非流式空闲超时 `NONSTREAM_IDLE_TIMEOUT_MS` | 90 000 ms（`CC_NONSTREAM_IDLE_MS` 可覆盖，默认不变） | `src/shared/config.ts:140-143` |
| thinking 空闲宽限 `THINKING_IDLE_TIMEOUT_MS` | 120 000 ms（`CC_THINKING_IDLE_MS` 可覆盖，默认不变） | `src/shared/config.ts:145-148` |
| 上述超时常量重导出 | — | `src/shared/runtime.ts:9` |
| 连续超时降级阈值 | 3 次 → 提示缩减上下文 | `src/shared/runtime.ts:11` |
| 大上下文阈值 `TIMEOUT_LARGE_CONTEXT_TOKENS` | 80 000 tokens | `src/shared/runtime.ts:13` |
| 超时状态 TTL `TIMEOUT_STATE_TTL_MS` | 30 min | `src/shared/runtime.ts:16` |
| 空闲预算选择 `idleTimeoutFor` | thinking→120s；否则 streaming?30s:90s | `src/shared/runtime.ts:136-139` |
| 会话有效期 | 12 h + ≤1 h 抖动，按 API key | `src/infra/session.ts:5-6` |
| 指纹/生命周期刷新 | 8 h + ≤2 h 抖动，按 API key | `src/infra/fingerprint.ts:115-116` |
| CC 版本刷新 | 24 h（npm registry） | `src/shared/version.ts:4` |
| 模型列表刷新 | 300 000 ms（`CC_MODEL_REFRESH_INTERVAL_MS` 可配） | `src/shared/config.ts:97` |
| 请求体上限 `MAX_BODY_SIZE` | 100 MB（`CC_MAX_BODY_MB` 可配） | `src/shared/config.ts:131-134` |
| 超限排水上限 `DRAIN_LIMIT` | 32 MB（防慢速攻击） | `src/shared/http.ts:58` |
| SSE 心跳 interval | 5 s | `src/infra/sse.ts:8` |
| SSE 心跳 idle | 15 s | `src/infra/sse.ts:9` |
| 监听端口/地址 | 3050 / 0.0.0.0 | `src/shared/config.ts:89-90` |

## 7. 长会话 / 上下文管理（客户端止血习惯）

> 代理无状态：`src/infra/cc.ts` 的 `buildCcRequest` 每请求全量透传完整历史，不做
> prune / trim / compact。历史膨胀在调用方。超时：流式 30s / 非流式 90s / thinking
> 120s（可用 `CC_STREAM_IDLE_MS` / `CC_NONSTREAM_IDLE_MS` / `CC_THINKING_IDLE_MS`
> 覆盖，默认不变；`src/shared/runtime.ts` 按 Key 记连续超时，≥3 次提示压缩上下文）；
> 包体上限 100MB（`CC_MAX_BODY_MB`）；超长在 HTTP 与流内 error 事件统一归一化为
> `400 context_window_exceeded`（`src/shared/errors.ts`，关键词优先、即使误标
> `<429>`）；session 按 Key 12h + ≤1h 抖动（`src/infra/session.ts`），换 Key 或
> 新会话即清零；`GET /v1/models` 已带 `context_window`（provider 透传 +
> `src/modules/models/catalog.ts` 静态兜底）。详见 `README.md#long-sessions--context-management`
> 与 `README_zh.md#长会话--上下文管理context`。

1. 传文件路径，不粘贴全文（粘贴永不被修剪）。
2. 子代理职责收窄 + 只读工具集。
3. 控制单条 tool 结果体积（截断/总结后再回传）。
4. 任务边界开新会话（等价 `/clear`；换 Key 亦可；想干净起点就别带
   `x-session-id` / `prompt_cache_key`）。
5. 上下文敏感任务查 `GET /v1/models` 的 `context_window` 后 pin 大窗口模型。
6. 看 `finish` 终包 `usage` 趋势（`prompt_tokens` / `inputTokens` 逐轮爬升即告警）。
7. 报错速查：`400 context_window_exceeded`→裁剪/新会话勿重试；
   `429 retry_after:10`=零输出、`retry_after:5`=空闲超时、`retry_after:30`=真限流
   （看 `message` + `retry_after` / `Retry-After` 区分）；
    超长不再是 `502`（已归一化为 `400`），其余 `502/503` 才重试/退避。

## 8. 测试与运行

| 命令 | 说明 |
|---|---|
| `bun run start` | 生产启动（`src/index.ts`） |
| `bun run dev` | watch 模式启动（`src/index.ts`） |
| `bun run build` | 编译单文件二进制 `server` |
| `bun run test` | e2e：`test/e2e.ts`，mock 上游(4100) + 被测服务(4200) |
| `bun run test:timeouts` | 真实时间验证流式空闲超时 / 断连取消 / 服务存活（`test/timeouts.ts`） |
| `bun run test:heartbeat` | SSE 心跳行为验证（`test/heartbeat.ts`） |
| `bun run test/idle-timeout-env.ts` | 空闲超时环境变量验证（`package.json` 无该 script，直接运行） |
