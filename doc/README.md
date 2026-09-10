# Command Code Proxy 项目文档

> 生成时间：2026-09-07 · 基于工作区全量扫描（src/ 19 个模块，test/ 2 个测试，共约 3 235 行 TypeScript）

## 1. 项目简介

**Command Code Proxy**（`commandcode-proxy-elysia`）是一个基于 **Bun + Elysia** 的 API 代理服务，将 **OpenAI** 与 **Anthropic** 两种协议的请求转换为 Command Code（CC）上游的 `/alpha/generate` NDJSON 流式协议，并把上游事件流实时翻译回各自的 SSE / JSON 格式。

- 运行时：Bun（`bun run src/index.ts`），可编译为单文件二进制（Docker distroless）
- 唯一运行时依赖：`elysia ^1.4.30`（其余全部为标准库 / Bun 全局 API）
- 端口：默认 `3050`（`config.json` / 环境变量可覆盖）

## 2. HTTP 路由一览

| 方法 | 路径 | 处理函数 | 协议 | 源模块 |
|---|---|---|---|---|
| GET | `/` | 内联 | 健康探针（文本 `OK`） | `src/index.ts:29` |
| GET | `/health` | 内联 | 健康探针（JSON `{ok:true}`） | `src/index.ts:30` |
| GET | `/v1/models` | `handleModels` | OpenAI Models API | `src/models.ts:81` |
| POST | `/v1/chat/completions` | `handleChatCompletions` | OpenAI Chat Completions（SSE / JSON） | `src/openai.ts:38` |
| POST | `/v1/messages` | `handleMessages` | Anthropic Messages（SSE / JSON） | `src/anthropic.ts:356` |
| OPTIONS | 任意 | `onRequest` 钩子 | CORS 预检（204） | `src/index.ts:23-28` |

另有 CLI 子命令：`server healthcheck`（`src/index.ts:77-99`），供 Docker HEALTHCHECK 使用。

## 3. 架构分层

```
┌─────────────────────────────────────────────────────────────┐
│  入口层      src/index.ts        Elysia 路由 / CORS / 错误页 │
├─────────────────────────────────────────────────────────────┤
│  协议层      src/openai.ts       /v1/chat/completions 处理   │
│             src/anthropic.ts    /v1/messages 处理            │
│             src/models.ts       /v1/models 处理              │
├─────────────────────────────────────────────────────────────┤
│  共享管道层  src/proxy-handler.ts  请求解析 / 上游调用 / 断连  │
│             src/sse.ts          SSE 发送管道 + OpenAI 翻译器  │
│             src/cc-events.ts    CC NDJSON 解析器（事件分发）  │
│             src/errors.ts       状态码 / 停止原因 / usage 映射 │
├─────────────────────────────────────────────────────────────┤
│  上游对接层  src/cc.ts             请求体构建 + HTTP 转发      │
│             src/fingerprint.ts   设备指纹伪造 + 生命周期上报   │
│             src/session.ts       会话 ID 管理（12h + 抖动）    │
│             src/version.ts       CC 版本号从 npm 动态刷新      │
├─────────────────────────────────────────────────────────────┤
│  基础设施层  src/config.ts  src/http.ts  src/auth.ts          │
│             src/logger.ts  src/util.ts  src/runtime.ts        │
│             src/cc-types.ts（纯类型）                          │
└─────────────────────────────────────────────────────────────┘
```

## 4. 请求流转（核心数据流）

以 `/v1/messages`（Anthropic 协议）为例：

```
客户端 POST /v1/messages
  → index.ts 路由 → anthropic.handleMessages (L356)
  → readRequestJson      (proxy-handler, 请求体大小/JSON 校验, 413/400)
  → getApiKey            (auth, Bearer / x-api-key / CC_API_KEY 兜底, 401)
  → convertAnthropicToOpenAI (anthropic L20)   ← Anthropic → OpenAI 中间格式
  → buildCcRequest       (cc L6)                ← OpenAI → CC 请求体
  → createUpstreamFlow   (proxy-handler L48)    ← 客户端断连 → 级联 abort
  → callUpstream         (proxy-handler L79)
       → ensureInitialized (fingerprint L120)   ← 指纹上报 + 生命周期事件(8h 缓存)
       → forwardToCC       (cc L158)            ← POST {CC_API_BASE}/alpha/generate
  ├─ stream=true：
  │    createAnthropicSseTranslator (anthropic L188, AsyncGenerator)
  │      内部用 CcStreamParser (cc-events L31) 逐行解析 NDJSON
  │    → SsePipeline (sse L6) 缓冲/keepalive/终止 → Response(SSE)
  └─ stream=false：
       CcStreamParser 聚合 → buildAnthropicResponse (anthropic L147) → JSON
```

OpenAI 路径（`/v1/chat/completions`）结构相同，区别在于：
- 无需协议转换（`buildCcRequest` 直接收 OpenAI 请求）；
- 流式翻译器是工厂函数 `createSseTranslator`（`src/sse.ts:93`）而非 AsyncGenerator；
- 使用 `SsePipeline(autoStart=true)` + keepalive 注释帧。

## 5. 模块清单与文档索引

### 模块报告（doc/modules/）

| # | 报告 | 源文件 | 行数 | 层级 |
|---|---|---|---|---|
| 01 | [index.md](modules/01-index.md) | `src/index.ts` | 117 | 入口层 |
| 02 | [config.md](modules/02-config.md) | `src/config.ts` | 123 | 基础设施 |
| 03 | [logger.md](modules/03-logger.md) | `src/logger.ts` | 16 | 基础设施 |
| 04 | [util.md](modules/04-util.md) | `src/util.ts` | 75 | 基础设施 |
| 05 | [runtime.md](modules/05-runtime.md) | `src/runtime.ts` | 13 | 基础设施 |
| 06 | [http.md](modules/06-http.md) | `src/http.ts` | 116 | 基础设施 |
| 07 | [auth.md](modules/07-auth.md) | `src/auth.ts` | 43 | 基础设施 |
| 08 | [cc-types.md](modules/08-cc-types.md) | `src/cc-types.ts` | 39 | 基础设施 |
| 09 | [cc-events.md](modules/09-cc-events.md) | `src/cc-events.ts` | 96 | 共享管道 |
| 10 | [cc.md](modules/10-cc.md) | `src/cc.ts` | 190 | 上游对接 |
| 11 | [sse.md](modules/11-sse.md) | `src/sse.ts` | 194 | 共享管道 |
| 12 | [errors.md](modules/12-errors.md) | `src/errors.ts` | 86 | 共享管道 |
| 13 | [proxy-handler.md](modules/13-proxy-handler.md) | `src/proxy-handler.ts` | 91 | 共享管道 |
| 14 | [openai.md](modules/14-openai.md) | `src/openai.ts` | 325 | 协议层 |
| 15 | [anthropic.md](modules/15-anthropic.md) | `src/anthropic.ts` | 606 | 协议层 |
| 16 | [models.md](modules/16-models.md) | `src/models.ts` | 94 | 协议层 |
| 17 | [session.md](modules/17-session.md) | `src/session.ts` | 60 | 上游对接 |
| 18 | [fingerprint.md](modules/18-fingerprint.md) | `src/fingerprint.ts` | 190 | 上游对接 |
| 19 | [version.md](modules/19-version.md) | `src/version.ts` | 25 | 上游对接 |
| 20 | [test-e2e.md](modules/20-test-e2e.md) | `test/e2e.ts` | 456 | 测试 |
| 21 | [test-timeouts.md](modules/21-test-timeouts.md) | `test/timeouts.ts` | 81 | 测试 |

### 总报告

| 文档 | 内容 |
|---|---|
| [code-map.md](code-map.md) | 完整代码段映射：全部 21 个文件的符号级映射表（符号/类别/行号/可见性/说明）+ 模块依赖矩阵 |

## 6. 关键运行参数（速查）

| 常量 | 值 | 定义处 |
|---|---|---|
| 流式空闲超时 | 30 000 ms（`CC_STREAM_IDLE_MS` 可覆盖，默认不变） | `src/runtime.ts:1` |
| 非流式空闲超时 | 90 000 ms（`CC_NONSTREAM_IDLE_MS` 可覆盖，默认不变） | `src/runtime.ts:2` |
| 连续超时降级阈值 | 3 次 → 提示缩减上下文 | `src/runtime.ts:3` |
| 会话有效期 | 12 h + ≤1 h 抖动，按 API key | `src/session.ts:5-6` |
| 指纹/生命周期刷新 | 8 h + ≤2 h 抖动，按 API key | `src/fingerprint.ts:115-116` |
| CC 版本刷新 | 24 h（npm registry） | `src/version.ts:4` |
| 模型列表刷新 | 300 000 ms（可配） | `src/config.ts:88` |
| 请求体上限 | 100 MB（`CC_MAX_BODY_MB` 可配） | `src/config.ts:120-123` |
| 超限排水上限 | 32 MB（防慢速攻击） | `src/http.ts:58` |
| 监听端口/地址 | 3050 / 0.0.0.0 | `src/config.ts:80-81` |

## 7. 长会话 / 上下文管理（客户端止血习惯）

> 代理无状态：`src/cc.ts:buildCcRequest` 每请求全量透传完整历史，不做
> prune / trim / compact。历史膨胀在调用方。超时：流式 30s / 非流式 90s
>（可用 `CC_STREAM_IDLE_MS` / `CC_NONSTREAM_IDLE_MS` 覆盖，默认不变；
> `src/runtime.ts`，按 Key 记连续超时，≥3 次提示压缩上下文）；包体上限
> 100MB（`CC_MAX_BODY_MB`）；超长在 HTTP 与流内 error 事件统一归一化为
> `400 context_window_exceeded`（`src/errors.ts`，关键词优先、即使误标
> `<429>`）；session 按 Key 12h + ≤1h 抖动（`src/session.ts`），换 Key 或
> 新会话即清零；`GET /v1/models` 已带 `context_window`（provider 透传 +
> `src/models.ts` 静态兜底）。详见 `README.md#long-sessions--context-management`
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

## 7. 测试与运行

| 命令 | 说明 |
|---|---|
| `bun run start` | 生产启动（`src/index.ts`） |
| `bun run dev` | watch 模式启动 |
| `bun run build` | 编译单文件二进制 `server` |
| `bun run test` | e2e：mock 上游(4100) + 被测服务(4200)，约 70 项断言 |
| `bun run test:timeouts` | 真实时间验证 30s 流式空闲超时 / 断连取消 / 服务存活 |

