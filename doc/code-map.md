# 完整代码段映射报告（Code Map）

> 扫描范围：`src/` 40 个源文件（`shared/` 9、`infra/` 6、`modules/` 19、`plugins/` 4，外加 `app.ts` + `index.ts`）+ `test/` 4 个测试；共 44 个 TS 文件、约 4 518 行（源码约 3 718 + 测试约 800 行）。
> 行号基于当前工作区文件内容；「可见性」中 `E`=export、`P`=模块私有。
> 分层：入口（index/app）→ 插件（plugins）→ 协议模块（modules）→ 共享管道/上游对接（infra）/ 基础设施（shared）。

---

## src/index.ts（79 行 · 入口层）

服务启动入口：拉起后台任务、创建并监听 Elysia app、提供 `healthcheck` CLI 与 `unhandledRejection` 兜底。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-6 | — | import | — | `./shared/config`(CFG) `./shared/logger`(log) `./modules/models/catalog`(MODELS) `./infra/session`(startSessionCleanup) `./shared/version`(startVersionRefresh) `./app`(createApp) |
| 8-37 | `startServer` | 函数 | E | 启动 `startVersionRefresh`/`startSessionCleanup`，`createApp().listen()`，打印启动日志与无 Key 告警 |
| 39-61 | `healthcheck` | 异步函数 | E | GET `127.0.0.1:{PORT\|CFG.port}/health`，5s 超时，要求 `body.ok===true`；成功 `exit(0)` 否则 `exit(1)` |
| 63-72 | unhandledRejection 监听 | 逻辑 | P | `AbortError`/`ABORT_ERR` 记 info，其余记 error |
| 74-79 | CLI 分派 | 逻辑 | P | `argv[2]==='healthcheck'` → `healthcheck()`，否则 `startServer()` |

依赖：`./shared/config` `./shared/logger` `./modules/models/catalog` `./infra/session` `./shared/version` `./app`

---

## src/app.ts（21 行 · 入口层）

组装 Elysia 应用，按固定顺序注册 4 个插件与 4 个 controller，返回未 listen 的实例。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-9 | — | import | — | `elysia`(Elysia)；`./plugins/cors` `./plugins/errors` `./plugins/body` `./plugins/auth`；`./modules/health/index` `./modules/models/index` `./modules/chat/index` `./modules/messages/index` |
| 11-21 | `createApp` | 函数 | E | `new Elysia().use(...)` 装配顺序：cors → errors → bodyLimit → auth → health → models → chat → messages |
| 13-16 | └ 插件注册 | 插件 | P | cors / errors / bodyLimit / auth |
| 17-20 | └ controller 注册 | 路由 | P | health / models / chat / messages |

依赖：`elysia` `./plugins/cors` `./plugins/errors` `./plugins/body` `./plugins/auth` `./modules/health/index` `./modules/models/index` `./modules/chat/index` `./modules/messages/index`

---

## src/plugins/cors.ts（16 行 · 插件层）

每请求注入 CORS 头并对 OPTIONS 短路 204；`@elysiajs/cors` 的替代 shim。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | import | — | `elysia`(Elysia) `../shared/http`(CORS_HEADERS) |
| 10 | `corsPlugin` | 常量/插件 | E | `new Elysia({ name: 'cors' })` |
| 11-15 | └ `onRequest` 钩子 | 中间件 | P | `Object.assign(set.headers, CORS_HEADERS)`；`OPTIONS` → `204` + CORS_HEADERS |

依赖：`elysia` `../shared/http`

---

## src/plugins/errors.ts（60 行 · 插件层）

scoped `onError`：404 / 413 / PARSE / VALIDATION / 500 归一化，`/v1/messages` 用 Anthropic 形状。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | import | — | `elysia`(Elysia) `../shared/config`(MAX_BODY_SIZE) |
| 15-20 | `jsonResponse` | 函数 | P | 构造 JSON `Response` |
| 22-30 | `isStatusResponse` | 函数 | P | 判定 `ElysiaCustomStatusResponse` |
| 32 | `errorsPlugin` | 常量/插件 | E | `new Elysia({ name: 'errors' })` |
| 38-59 | └ `onError`（scoped） | 中间件 | P | 401 穿透；NOT_FOUND→404；413/PARSE/VALIDATION→413 或 400 双形；其余→500 |

依赖：`elysia` `../shared/config`

---

## src/plugins/body.ts（77 行 · 插件层）

单次限流 JSON 解析插件：`onParse` 复用 `readJsonBody`，`onTransform` 抛 `Error(status=413)` 桥接 413 双形。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | import | — | `elysia`(Elysia) `../shared/http`(readJsonBody, BodyTooLargeError) |
| 43 | `tooLargeByRequest` | 常量/字段 | P | `WeakMap<Request,string>` 暂存超限 message |
| 44 | `TOO_LARGE_BODY` | 常量 | P | 占位对象，短路默认解析 |
| 46 | `bodyLimitPlugin` | 常量/插件 | E | `new Elysia({ name: 'body-limit' })` |
| 47-66 | └ `onParse`（scoped） | 中间件 | P | 仅 JSON 拦截；GET/HEAD 放行；`BodyTooLargeError` → stash+占位，其余透传 |
| 67-77 | └ `onTransform`（scoped） | 中间件 | P | 命中 stash → 抛普通 `Error` 并置 `status=413` |

依赖：`elysia` `../shared/http`

---

## src/plugins/auth.ts（70 行 · 插件层）

鉴权 shim：decorate `getApiKey` + opt-in `requireAuth` macro，导出双协议 401 body 与 `createAuthPreCheck` 预检工厂。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | import | — | `elysia`(Elysia) `../shared/auth`(authErrorMessage, getApiKey) |
| 15-23 | `authErrorBody` | 函数 | E | 合并形状 401 body（macro 用，双协议并存） |
| 25-35 | `authPlugin` | 常量/插件 | E | `new Elysia({ name: 'auth' })`；decorate `getApiKey`，macro `requireAuth` |
| 40 | `openAI401Body` | 函数 | E | OpenAI 401 字面量 `{ error:{ message, type:'auth_error' } }` |
| 41-44 | `anthropic401Body` | 函数 | E | Anthropic 401 字面量 `{ type:'error', error:{ type:'authentication_error', message } }` |
| 55-69 | `createAuthPreCheck` | 函数 | E | 返回 `onTransform`/`derive` 预检回调：无 key → `status(401, …)` |

依赖：`elysia` `../shared/auth`

---

## src/shared/config.ts（148 行 · 基础设施层）

三层覆盖（默认值 → config.json → 环境变量）的全局配置单例与请求体/空闲超时常量。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-13 | `AppConfig` | interface | E | 11 字段配置接口 |
| 15-18 | `die` | 函数 | P | `[config]` 报错 + `exit(1)` |
| 20-37 | `candidateDirs` | 函数 | P | 独立二进制与源码两种目录探测顺序 |
| 39-52 | `findConfigJson` | 函数 | P | 逐目录查找并解析 config.json，损坏返回 null |
| 54-56 | `AppConfigWithSource` | interface | E | 追加可选 `configPath` |
| 58-61 | `envString` | 函数 | P | 空串视为未设置 |
| 63-69 | `envNumber` | 函数 | P | 非有限数字 `die()` |
| 71-75 | `envBool` | 函数 | P | 仅 `1`/`true` 为真 |
| 77-83 | `envBoolDefaultTrue` | 函数 | P | 仅 `false`/`0`/`no` 为假 |
| 85-127 | `loadConfig` | 函数 | P | 默认值 + 文件合并 + 校验 + 11 项 env 覆盖 |
| 129 | `CFG` | 常量 | E | 顶层 await 得到的配置单例 |
| 131-134 | `MAX_BODY_SIZE` | 常量 | E | `CC_MAX_BODY_MB`，默认 100MiB |
| 136-139 | `STREAM_IDLE_TIMEOUT_MS` | 常量 | E | `CC_STREAM_IDLE_MS`，默认 30_000 |
| 140-143 | `NONSTREAM_IDLE_TIMEOUT_MS` | 常量 | E | `CC_NONSTREAM_IDLE_MS`，默认 90_000 |
| 144-148 | `THINKING_IDLE_TIMEOUT_MS` | 常量 | E | `CC_THINKING_IDLE_MS`，默认 120_000 |

依赖：无（Bun 全局/process）

---

## src/shared/logger.ts（16 行 · 基础设施层）

按 `CFG.logLevel` 过滤的全局日志，同时写控制台与可选日志文件。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | import | — | `CFG`（./config）、`appendFile`（node:fs/promises） |
| 4 | `LogLevel` | type | E | `info` \| `warn` \| `error` |
| 6 | `LEVEL_RANK` | 常量 | P | `debug:0,info:1,warn:2,error:3` |
| 8-16 | `log` | 函数 | E | 阈值过滤、格式化、双通道输出 |

依赖：`./config` `node:fs/promises`

---

## src/shared/util.ts（75 行 · 基础设施层）

无状态工具：哈希、Base64、随机/UUID、时间、宽松 JSON 解析与指纹辅助字符串。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-3 | `sha256hex` | 函数 | E | SHA-256 十六进制 |
| 5-7 | `sha256bytes` | 函数 | E | SHA-256 `Uint8Array` |
| 9-16 | `bytesToBase64` | 函数 | E | 分块 0x8000 后 `btoa` |
| 18-22 | `randHex` | 函数 | E | 随机字节转十六进制 |
| 24-26 | `uuid` | 函数 | E | `crypto.randomUUID()` |
| 28-30 | `pick` | 函数 | E | 随机取数组项 |
| 32-34 | `nowUnix` | 函数 | E | Unix 秒 |
| 36-38 | `getDateStr` | 函数 | E | `YYYY-MM-DD` |
| 40-42 | `getEnvironment` | 函数 | E | 硬编码指纹 `win32-x64, Node.js 22.10.0` |
| 44-50 | `tryParseJSON` | 函数 | E | 失败返回 `{}` |
| 52-54 | `generateTraceparent` | 函数 | E | W3C `00-<16字节>-<8字节>-01` |
| 56-75 | `fakeProjectSlug` | 函数 | E | 确定性模拟项目路径 slug |

依赖：无（Bun 全局/Web crypto）

---

## src/shared/runtime.ts（139 行 · 基础设施层）

按 (apiKey, session) 隔离的连续空闲超时计数，并选择 per-read 超时预算。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 9 | 重导出 | import | E | 从 ./config 重导出三个超时常量 |
| 10 | — | import | — | 本地导入三个超时常量 |
| 11 | `TIMEOUT_REDUCE_CONTEXT_THRESHOLD` | 常量 | E | 连续 3 次触发缩减上下文提示 |
| 12-13 | `TIMEOUT_LARGE_CONTEXT_TOKENS` | 常量 | E | 80_000 |
| 15-16 | `TIMEOUT_STATE_TTL_MS` | 常量 | P | 30 分钟懒清理 |
| 18-21 | `TimeoutEntry` | interface | P | 计数 + 时间戳 |
| 23 | `timeoutStates` | 字段 | P | 模块级 Map 状态 |
| 25-29 | `scopeKey` | 函数 | E | `${apiKey}::${sessionId \|\| 'default'}` |
| 31-35 | `legacyKey` | 函数 | P | 裸 apiKey 旧键兜底 |
| 37-41 | `pruneStale` | 函数 | P | 删除过期条目 |
| 43-47 | `freshCount` | 函数 | P | 缺失/过期返回 0 |
| 49-56 | `entryFor` | 函数 | P | 取或新建条目 |
| 58-65 | `recordTimeout` | 函数 | E | 先清理再自增计数 |
| 67-74 | `recordTimeoutSuccess` | 函数 | E | 删除 scoped 与（无 session 时）legacy 键 |
| 76-84 | `consecutiveTimeouts` | 函数 | E | 无 session 时取 scoped/legacy 最大 |
| 86-90 | `TimeoutMessageOptions` | interface | E | inputTokens/timeoutMs/sessionId |
| 92-104 | `timeoutMessage` | 函数 | E | 三次以上给上游慢/减上下文提示 |
| 106-109 | `TimeoutDetailsOptions` | interface | E | timeoutMs/sessionId |
| 111-121 | `timeoutDetails` | 函数 | E | 机器可读诊断字段 |
| 123-131 | `isThinkingWait` | 函数 | E | start/start-step/reasoning-start/reasoning-delta |
| 133-138 | `idleTimeoutFor` | 函数 | E | thinking 用长窗口，否则按 streaming 选默认 |

依赖：`./config`

---

## src/shared/http.ts（126 行 · 基础设施层）

CORS/SSE 头常量、JSON 与 Anthropic 错误响应构造器、带限制与超时的请求体解析。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | — | import | — | `CFG`、`MAX_BODY_SIZE`（./config） |
| 9-12 | `corsAllowOrigin` | 函数 | P | 显式值优先；有兜底 key 时为 `null`，否则 `*` |
| 14-18 | `CORS_HEADERS` | 常量 | E | 允许 Origin/Methods/Headers |
| 20-25 | `SSE_HEADERS` | 常量 | E | event-stream 全套头 |
| 27-33 | `sendJSON` | 函数 | E | 附带 `retry_after` → `Retry-After` |
| 35-50 | `sendAnthropicError` | 函数 | E | `{type:'error',error:{type,message}}`，支持 headerOnly |
| 52-56 | `BodyTooLargeError` | class | E | 消息含 MB 上限 |
| 58 | `DRAIN_LIMIT` | 常量 | P | 32MiB 排水上限 |
| 59 | `sharedDecoder` | 常量 | P | 复用 TextDecoder |
| 61-112 | `readJsonBody` | 函数 | E | 长度预检 + 超时读取 + 超限排水 + 解析 |
| 114-126 | `readWithTimeout` | 函数 | E | `Promise.race` 超时并以 tag 拒绝 |

依赖：`./config`

---

## src/shared/auth.ts（43 行 · 基础设施层）

API Key 提取与鉴权错误文案，格式校验为 `user_` 前缀 + base64url 字符集。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-1 | — | import | — | `./config`(CFG) |
| 3 | `KEY_PATTERN` | 常量 | E | `/user_[a-zA-Z0-9_-]+/`，非锚定，取首个匹配 |
| 5-9 | `extractKey` | 函数 | P | 从字符串中提取合法 Key；无值/无匹配 → null |
| 11-22 | `getApiKey` | 函数 | E | 优先级：`Authorization: Bearer` → `x-api-key` → `CFG.apiKey` 兜底；皆无 → null |
| 24-34 | `keyFormatError` | 函数 | E | 客户端主动带 Key 但格式非法 → 错误文案（前 12 字符预览）；未带/合法 → null |
| 36-42 | `authErrorMessage` | 函数 | E | 格式错误文案优先；否则按是否有兜底 Key 区分两种 401 文案 |

依赖：`./config`(CFG)

---

## src/shared/cc-types.ts（39 行 · 基础设施层 · 纯类型）

Command Code 上游 NDJSON 线协议类型定义，无运行时代码。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 4-9 | `CcUsage` | interface | E | inputTokens/outputTokens/cachedInputTokens/inputTokenDetails.cacheWriteTokens |
| 13 | `CcStartEvent` | interface | E | `{type:'start'}` |
| 14 | `CcStartStepEvent` | interface | E | `{type:'start-step'}` |
| 15 | `CcReasoningStartEvent` | interface | E | `{type:'reasoning-start'}` |
| 16 | `CcTextStartEvent` | interface | E | `{type:'text-start'}` |
| 17 | `CcTextEndEvent` | interface | E | `{type:'text-end'}` |
| 18 | `CcReasoningEndEvent` | interface | E | `{type:'reasoning-end'}` |
| 19 | `CcToolInputStartEvent` | interface | E | `{type:'tool-input-start'}` |
| 20 | `CcToolInputDeltaEvent` | interface | E | `{type:'tool-input-delta'}` |
| 21 | `CcToolInputEndEvent` | interface | E | `{type:'tool-input-end'}` |
| 22 | `CcToolErrorEvent` | interface | E | `{type:'tool-error'}` |
| 23 | `CcProviderMetadataEvent` | interface | E | `{type:'provider-metadata'}` |
| 25 | `CcTextDeltaEvent` | interface | E | `{type:'text-delta'; text?/delta?}` 双字段兼容 |
| 26 | `CcReasoningDeltaEvent` | interface | E | `{type:'reasoning-delta'; text?}` |
| 27 | `CcToolCallEvent` | interface | E | `{type:'tool-call'; toolCallId?/toolName?/input?}` |
| 28 | `CcFinishStepEvent` | interface | E | `{type:'finish-step'; finishReason?/usage?}` |
| 29 | `CcFinishEvent` | interface | E | `{type:'finish'; finishReason?/totalUsage?/usage?}` |
| 30 | `CcErrorEvent` | interface | E | `{type:'error'; error?{message,type}/message?/retry_after?}` |
| 32-37 | `CcStreamEvent` | type（联合） | E | 全部 17 个事件的判别联合 |
| 39 | `CcEventType` | type | E | `CcStreamEvent['type']` 事件名字面量联合 |

依赖：无

---

## src/shared/errors.ts（109 行 · 基础设施层）

CC 上游错误 → 目标协议错误体、finish reason 与 usage 的归一化映射；超长错误优先归 400。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-12 | `CC_STATUS_MAP` | 常量 | E | 400/422→400 invalid_request；401/403→401 authentication；402→402 payment_required；404→404 not_found；429→429 rate_limit；500/502→502 upstream；503→503 temporarily_unavailable |
| 14-17 | `MappedError` | interface | E | `{status, body}`，body 为目标协议错误形状 |
| 19-20 | `CONTEXT_WINDOW_EXCEEDED_PATTERN` | 常量 | E | 超长识别正则（prompt/context/max tokens/input/message 等） |
| 22-24 | `isContextWindowExceeded` | 函数 | E | 正则测试 message，空串 → false |
| 26 | `CONTEXT_WINDOW_ERROR` | 常量 | E | `{status:400, type:'context_window_exceeded'}` |
| 28-61 | `mapCcError` | 函数 | E | 非 2xx 响应体 → MappedError；解析 message；**超长优先 400**（L43-48）→ 429 附 retry_after:30（L50-58）→ 默认映射（L60） |
| 63-84 | `mapCcEventError` | 函数 | E | 流内 error 事件：**超长优先 400**（L66-71）→ 解析消息前缀 `<NNN>`（缺省 502）→ 429 附 retry_after:30 |
| 86-93 | `mapFinishReason` | 函数 | E | `tool-calls→tool_calls`；length/stop 原样；空值 → stop |
| 95-100 | `normalizeUsage` | 函数 | E | 当前为**空操作**（no-op），usage 口径原样透传上游 |
| 102-109 | `mapAnthropicStopReason` | 函数 | E | `tool_calls→tool_use`、`length→max_tokens`、`stop→end_turn`、缺省 end_turn |

依赖：无

---

## src/shared/version.ts（25 行 · 基础设施层）

CC CLI 版本号维护：初值 `0.32.3`，每 24h 从 npm registry 拉取 `command-code` 最新版本刷新。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-1 | — | import | — | `./logger`(log) |
| 3 | `CC_VERSION` | 变量(let) | E | 当前版本（可变，被 cc/fingerprint/models 引用写入请求头） |
| 4 | `CC_VERSION_REFRESH_MS` | 常量 | P | 24h |
| 6-20 | `refreshCCVersion` | 异步函数 | E | GET `registry.npmjs.org/command-code/latest`（10s 超时）；成功改写 CC_VERSION，失败 warn 保留现值 |
| 22-25 | `startVersionRefresh` | 函数 | E | 启动即刷新 + setInterval(24h)，不阻塞启动 |

依赖：`./logger`(log)

---

## src/infra/cc-events.ts（101 行 · 共享管道层）

CC NDJSON → 事件分发的共用解析器，负责缓冲分行、JSON 解析、未知事件告警与错误事件记账。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 9-10 | — | import | — | `../shared/logger`(log)；`../shared/cc-types`(type CcErrorEvent, CcEventType) |
| 15-24 | `CC_EVENT_TYPES` | 常量 | E | 上游全部 17 种合法事件类型集合，未知类型才告警 |
| 26 | `CcEventHook` | type | E | `(event) => string[] \| string \| void` |
| 27-29 | `CcEventHooks` | type | E | 事件名→钩子表 + `default(type,event)` 兜底 |
| 31-101 | `CcStreamParser` | class | E | NDJSON 流式解析器 |
| 32 | `lastCcEvent` | 字段 | P | 最近事件类型（诊断） |
| 33 | `errorEvent` | 字段 | P | 最近 error 事件记账 |
| 34 | `unknownEvent` | 字段 | P | 最近未知事件类型 |
| 36 | `buffer` | 字段 | P | 未完整行缓冲 |
| 37 | `MAX_LINE_LENGTH` | 字段 | P | 单行上限 64KB，超过清空 |
| 39 | `constructor` | 方法 | P | 注入 TextDecoder |
| 43-54 | `push` | 方法 | P | 解码切行并逐行分发 |
| 57-64 | `flush` | 方法 | P | 冲刷尾部残行 |
| 66-100 | `handleLine` | 方法 | P | 跳过空/`[DONE]`/注释行；error 优先；未知走 default 或 warn |

依赖：`../shared/logger` `../shared/cc-types`

---

## src/infra/cc.ts（216 行 · 上游对接层）

OpenAI 中间格式 → CC 请求体构建（含 cache_control 白名单），以及向 `/alpha/generate` 的伪 CLI 头部转发。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-4 | — | import | — | `../shared/config`(CFG)；`./session`(getSessionId)；`../shared/version`(CC_VERSION)；`../shared/util`(fakeProjectSlug, generateTraceparent, getDateStr, getEnvironment, tryParseJSON) |
| 6-8 | `isEphemeralCacheControl` | 函数 | P | 判断 `{type:'ephemeral'}` |
| 10-12 | `pickEphemeralCacheControl` | 函数 | P | 命中返回归一化 ephemeral，否则 undefined |
| 14-22 | `stripNonEphemeralCacheControl` | 函数 | P | 白名单剥离，仅保留 ephemeral（避 422→400） |
| 24-182 | `buildCcRequest` | 函数 | E | OpenAI 请求 → CC body |
| 25 | └ 参数解构 | 逻辑 | P | model/messages/…/seed |
| 27-33 | └ system 提取 | 逻辑 | P | system/developer 拼 systemPrompt |
| 35-44 | └ toolNameMap | 逻辑 | P | tool_call id→function.name |
| 46-99 | └ 消息转换 | 逻辑 | P | user/assistant/tool 三种角色转换 + image_url |
| 101-107 | └ 缓存标记 | 逻辑 | P | 有 prompt_cache_key 且无标记时注入首条 user 末 text |
| 109-131 | └ body 骨架 | 逻辑 | P | config/memory/taste/skills/permissionMode/params |
| 133-140 | └ system 占位 | 逻辑 | P | 空系统提示且开关开启时发单空格 |
| 141-179 | └ 可选参数透传 | 逻辑 | P | temperature/reasoning_effort/tools/tool_choice/… |
| 184-216 | `forwardToCC` | 异步函数 | E | POST `/alpha/generate` + 伪 CLI 头（session/slug/traceparent/ZDR） |

依赖：`../shared/config` `./session` `../shared/version` `../shared/util`

---

## src/infra/sse.ts（138 行 · 共享管道层）

协议无关的 SSE 发送管道与空闲心跳；OpenAI 翻译器已移至 modules/chat/translator.ts。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 8 | `SSE_HEARTBEAT_INTERVAL_MS` | 常量 | E | 5s |
| 9 | `SSE_HEARTBEAT_IDLE_MS` | 常量 | E | 15s |
| 10 | `SSE_PING_EVENT` | 常量 | E | Anthropic ping 事件帧 |
| 11 | `SSE_KEEPALIVE_COMMENT` | 常量 | E | `: keepalive\n\n` |
| 13-118 | `SsePipeline` | class | E | 可控 ReadableStream 封装 |
| 14-27 | └ 字段 | 字段 | P | encoder/controller/buffered/stream/firstOutput/terminal/started/closed/keepaliveCount/pingCount/lastSentAt |
| 29-35 | └ `constructor` | 方法 | P | autoStart + 两个 Promise + stream |
| 37-42 | └ `enqueue` | 方法 | P | 编码入队并更新 lastSentAt |
| 44-51 | └ `emit` | 方法 | P | 未开播进缓冲，autoStart 自动 start |
| 53-69 | └ `emitAnthropic` | 方法 | P | content_block_* 才开播，保留零输出重试 |
| 71-75 | └ `emitKeepalive` | 方法 | P | 发送 keepalive 注释帧 |
| 77-86 | └ `sendPing` | 方法 | P | 空闲 ping（可被覆盖事件） |
| 88-90 | └ `writeNow` | 方法 | P | 绕过缓冲直写 |
| 92-98 | └ `start` | 方法 | P | 冲刷缓冲并 resolve firstOutput |
| 100-107 | └ `close` | 方法 | P | 关流并 resolve terminal |
| 109-117 | └ `terminateWith` | 方法 | P | 冲刷 + 终止事件 + close |
| 120-138 | `startSseHeartbeat` | 函数 | E | 间隔/idle 可配，静默超时发 ping |

依赖：无

---

## src/infra/proxy-handler.ts（97 行 · 共享管道层）

两个协议处理器共享的请求体解析、客户端断连级联取消与上游调用前置。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 6-11 | — | import | — | `./cc`(forwardToCC)；`../shared/errors`(mapCcError, type MappedError)；`./fingerprint`(ensureInitialized)；`../shared/http`(BodyTooLargeError, readJsonBody)；`../shared/logger`(log) |
| 13 | `JsonParseErrorKind` | type | E | `'too-large' \| 'invalid'` |
| 15-29 | `readRequestJson` | 异步函数 | E | 包 readJsonBody，按错误种类回调 buildError |
| 31-46 | `UpstreamFlow` | interface | E | signal/controller/aborted/setGracefulClose/abort |
| 48-64 | `createUpstreamFlow` | 函数 | E | once abort：置 aborted → gracefulClose → controller.abort() |
| 66-76 | `UpstreamCallArgs` | interface | E | apiKey/headers/ccBody/signal/promptCacheKey/label/onCcError |
| 78-97 | `callUpstream` | 异步函数 | E | ensureInitialized → forwardToCC → 非 2xx 映射日志与错误体 |

依赖：`./cc` `../shared/errors` `./fingerprint` `../shared/http` `../shared/logger`

---

## src/infra/session.ts（60 行 · 上游对接层）

按 API key 管理稳定上游会话 ID，透传优先、12h+抖动缓存、每小时清理并联动指纹。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-3 | — | import | — | `../shared/logger`(log)；`../shared/util`(uuid)；`./fingerprint`(keyStateStore) |
| 5 | `SESSION_DURATION_MS` | 常量 | P | 12h |
| 6 | `SESSION_JITTER_MS` | 常量 | P | 1h |
| 8-11 | `SessionEntry` | interface | P | `{sessionId, expiresAt}` |
| 13 | `sessionStore` | 常量 | P | `Map<apiKey, SessionEntry>` |
| 15-28 | `ensureSession` | 函数 | E | 未过期复用，否则 uuid 新建并记日志 |
| 30-45 | `getSessionId` | 函数 | E | 透传优先级 + 长度≥8，否则 ensureSession |
| 47-59 | `startSessionCleanup` | 函数 | E | 每小时清理过期会话并联动 keyStateStore |

依赖：`../shared/logger` `../shared/util` `./fingerprint`

---

## src/infra/fingerprint.ts（190 行 · 上游对接层）

为每把 key 伪造稳定设备指纹并上报（record + lifecycle-events），8h+抖动刷新，init 并发去重。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-4 | — | import | — | `../shared/config`(CFG)；`../shared/logger`(log)；`../shared/util`(pick, randHex, sha256hex)；`../shared/version`(CC_VERSION) |
| 6-22 | `FINGERPRINT_CPUS` | 常量 | P | 15 种伪造 CPU |
| 24 | `FINGERPRINT_MEMS` | 常量 | P | 内存档位 8-64 GiB |
| 26-31 | `FINGERPRINT_TZS` | 常量 | P | 15 个时区 |
| 33 | `FINGERPRINT_MAC_COUNT_RANGE` | 常量 | P | MAC 数量 2-5 |
| 35-54 | `Fingerprint` | interface | E | thumbmark + components 各哈希/字段 |
| 56-93 | `generateFingerprint` | 函数 | E | 随机拼装，固定 win32/x64/cli，thumbmark=sha256 |
| 95-98 | `KeyState` | interface | E | `{fingerprint, nextInitAt}` |
| 100 | `keyStateStore` | 常量 | E | `Map<apiKey, KeyState>` |
| 102-113 | `getOrCreateKeyState` | 函数 | E | 懒创建并记 keyPrefix |
| 115 | `INIT_REFRESH_MS` | 常量 | P | 8h |
| 116 | `INIT_JITTER_MS` | 常量 | P | 2h |
| 118 | `inFlightInit` | 常量 | P | init 去重 Map |
| 120-141 | `ensureInitialized` | 异步函数 | E | 未到期返回；in-flight 复用；失败仅告警下次重试 |
| 143-190 | `doInit` | 异步函数 | P | 并发 POST fingerprint/record 与 lifecycle-events，成功后安排 nextInitAt |

依赖：`../shared/config` `../shared/logger` `../shared/util` `../shared/version`

---

## src/modules/chat/index.ts（18 行 · 协议层）

chat 模块入口：创建 Elysia 控制器，装配 body schema 与 401 鉴权前置，挂载 `POST /v1/chat/completions`。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-4 | — | import | — | elysia；./model；./service；../../plugins/auth |
| 6-14 | `chatController` | 常量 | E | `new Elysia({name:'chat', prefix:'/v1'})` |
| 7 | `.use(chatModelPlugin)` | 插件 | P | 注册 `'chat.body'` |
| 13 | `.onTransform({as:'local'}, createAuthPreCheck(false))` | 插件 | P | 无 key → 401，短路 validation |
| 14 | `.post('/chat/completions', …)` | 路由 | P | 调 `ChatService.handleBody(body, headers, request.signal)` |
| 16-18 | `ChatService` / `chatBody` / `chatModel` / `ChatBody` | 重导出 | E | 公共入口再导出 |

依赖：`elysia` `./model` `./service` `../../plugins/auth`

---

## src/modules/chat/model.ts（35 行 · 协议层）

OpenAI chat body 的 Elysia schema：宽松校验，未知字段透传。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | — | import | — | elysia(Elysia, t) |
| 5-29 | `chatBody` | 常量 | E | `t.Object({…}, {additionalProperties:true})` |
| 8-14 | └ `messages` | 逻辑 | P | `t.Array({role, content?}, {additionalProperties:true})`，`minItems:1` |
| 31 | `ChatBody` | type | E | `typeof chatBody.static` |
| 33-35 | `chatModelPlugin` | 常量 | E | 注册 model `'chat.body'` |

依赖：`elysia`

---

## src/modules/chat/service.ts（17 行 · 协议层）

Strangler 门面：`ChatService` 静态方法惰性委托 `./protocol`，不复制状态机。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-4 | — | 注释 | — | 分层说明 |
| 5 | `buildCcRequest` | 重导出 | E | re-export from `../../infra/cc` |
| 7-17 | `ChatService` | 抽象类 | E | 纯静态 |
| 8-11 | └ `handle` | 方法 | E | 动态取 `handleChatCompletions` |
| 13-16 | └ `handleBody` | 方法 | E | 动态取 `handleChatCompletionsBody` |

依赖：`../../infra/cc`（re-export） `./protocol`（动态）

---

## src/modules/chat/protocol.ts（5 行 · 协议层）

公共 re-export 门面：聚合 handler / translator / aggregator 的导出符号。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | `handleChatCompletions`、`handleChatCompletionsBody` | 重导出 | E | from `./handler` |
| 2-3 | `createSseTranslator`、`zeroUsageChunk`、`ChatStreamTranslator`(type) | 重导出 | E | from `./translator` |
| 4-5 | `createChatAggregator`、`buildChatCompletion`、`rawUsageFromCcUsage`、`ChatAggregate`(type) | 重导出 | E | from `./aggregator` |

依赖：`./handler` `./translator` `./aggregator`

---

## src/modules/chat/handler.ts（374 行 · 协议层）

`POST /v1/chat/completions` 请求/响应生命周期：流式（SSE）与非流式（JSON）双路径状态机。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-12 | — | import | — | shared/auth；infra/cc；shared/http；shared/logger；infra/proxy-handler；shared/runtime；infra/session；infra/sse；shared/util；./translator；./aggregator |
| 14-20 | `TerminalState` | interface | P | upstreamError/timedOut/timedOutMs/zeroOutput/errorMsg |
| 22-26 | `buildError` | 函数 | P | JsonParseErrorKind → 413/400 |
| 28-32 | `handleChatCompletions` | 异步函数 | E | `readRequestJson` → 委托 body 处理器 |
| 34-374 | `handleChatCompletionsBody` | 异步函数 | E | 主处理器 |
| 35-38 | └ 鉴权 | 逻辑 | P | 无 key → 401 |
| 40-56 | └ 元信息/会话/流控 | 逻辑 | P | model 缺省、completionId、created、buildCcRequest、getSessionId、createUpstreamFlow |
| 59-69 | └ 上游调用 | 逻辑 | P | callUpstream，onCcError → sendJSON |
| 71-243 | └ 流式分支 | 逻辑 | P | translator + SsePipeline(true) + heartbeat |
| 77-97 |   └ onClientAbort | 逻辑 | P | 断连分类 + terminateWith([zeroUsageChunk, [DONE]]) |
| 99-194 |   └ pump | 逻辑 | P | 读循环 / flush / 终态 / catch / finally |
| 102-116 |     └ 读取循环 | 逻辑 | P | readWithTimeout → parseChunk → emit / emitKeepalive |
| 118-140 |     └ 流尽终态 | 逻辑 | P | upstreamError / zeroOutput / 成功（recordTimeoutSuccess + [DONE]） |
| 141-189 |     └ catch | 逻辑 | P | aborted / STREAM_IDLE_TIMEOUT(429) / 其他(proxy_error) |
| 198-201 |   └ 竞速 | 逻辑 | P | race(firstOutput→started, terminal→terminal) |
| 203-240 |   └ terminal 分支 | 逻辑 | P | 按 state 返回映射 JSON / 429 / 502 |
| 242 |   └ started 返回 | 逻辑 | P | 200 + SSE_HEADERS |
| 245-260 | └ 非流式装配 | 逻辑 | P | createChatAggregator({onEventError}) |
| 262-274 | └ 非流式读取 | 逻辑 | P | readWithTimeout → push → flush |
| 275-314 | └ 非流式 catch | 逻辑 | P | 499 / 429(idle) / 502 |
| 320-346 | └ 聚合终态 | 逻辑 | P | upstreamError / zero-output 429 |
| 348-360 | └ 成功响应 | 逻辑 | P | buildChatCompletion → sendJSON(200) |
| 361-373 | └ 外层 catch | 逻辑 | P | 499 / 502 |

依赖：`../../shared/auth` `../../infra/cc` `../../shared/http` `../../shared/logger` `../../infra/proxy-handler` `../../shared/runtime` `../../infra/session` `../../infra/sse` `../../shared/util` `./translator` `./aggregator`

---

## src/modules/chat/translator.ts（170 行 · 协议层）

CC NDJSON → OpenAI `chat.completion.chunk` SSE 帧的纯流式翻译器。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-7 | — | import | — | errors；logger；infra/cc-events |
| 9-18 | `zeroUsageChunk` | 函数 | E | 零 usage + finish_reason:stop 终止 chunk |
| 20-30 | `makeChunk` | 函数 | P | 组装 `data: …\n\n` |
| 32-168 | `createSseTranslator` | 工厂函数 | E | 闭包 + CcStreamParser + hooks |
| 47-122 | └ hooks | 逻辑 | P | text/reasoning/tool-call/finish-step/finish/error |
| 124-167 | └ 返回对象 | API | P | getter 与 parseChunk/flush/getDoneEvent |
| 170 | `ChatStreamTranslator` | type | E | ReturnType 别名 |

依赖：`../../shared/errors` `../../shared/logger` `../../infra/cc-events`

---

## src/modules/chat/aggregator.ts（110 行 · 协议层）

非流式聚合与 `chat.completion` 响应构造，纯函数无 I/O。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-6 | — | import | — | errors；infra/cc-events；shared/util |
| 9-19 | `rawUsageFromCcUsage` | 函数 | E | CC usage → rawUsage 三字段 |
| 21-28 | `ChatAggregate` | interface | E | 聚合结果形状 |
| 30-82 | `createChatAggregator` | 工厂函数 | E | 闭包 + hooks + push/flush/result |
| 43-66 | └ hooks | 逻辑 | P | text/reasoning/tool-call/finish/error |
| 84-110 | `buildChatCompletion` | 函数 | E | 组装 `chat.completion` 体 |

依赖：`../../shared/errors` `../../infra/cc-events` `../../shared/util`

---

## src/modules/messages/index.ts（18 行 · 协议层）

`/v1/messages` 控制器：挂载 body schema、局部前置 Anthropic 鉴权、re-export 门面。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-4 | — | import | — | elysia + ./model + ./service + ../../plugins/auth(createAuthPreCheck) |
| 6-14 | `messagesController` | 常量 | E | `new Elysia({name:'messages',prefix:'/v1'}).use(messagesModelPlugin)` |
| 8-12 | 顺序注释 | 逻辑 | P | onParse(bodyLimit)→onTransform(413)→onTransform(auth 401)→validation(400)→handler；local 不上浮 |
| 13 | `.onTransform({as:'local'}, createAuthPreCheck(true))` | 插件 | E | 本实例局部鉴权，无 Key 时 401 短路 validation |
| 14 | `.post('/messages', …)` | 路由 | E | `MessagesService.handleBody(body,headers,request.signal)`，schema `'messages.body'` |
| 16-18 | `MessagesService`/`messagesBody`/`messagesModelPlugin as messagesModel`/`MessagesBody` | 导出 | E | 从 ./service、./model re-export |

依赖：`elysia` `./model` `./service` `../../plugins/auth`

---

## src/modules/messages/model.ts（33 行 · 协议层）

Anthropic 请求体 Elysia schema：`model` 必填、`messages` minItems 1、其余宽松可选。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | — | import | — | elysia(Elysia,t) |
| 3-4 | 注释 | 逻辑 | P | 显式声明已知字段，未知靠 additionalProperties，联合靠 t.Any()，绝不 422 |
| 5-27 | `messagesBody` | 常量 | E | `t.Object({…},{additionalProperties:true})` |
| 7 | └ `model` | 字段 | E | `t.String()` 必填 |
| 8-14 | └ `messages` | 字段 | E | `t.Array({role,content?},{minItems:1})`，item additionalProperties true |
| 15-24 | └ 可选字段 | 字段 | E | system/max_tokens/stream/thinking/tools/tool_choice/top_p/stop_sequences/metadata/prompt_cache_key |
| 26 | └ `additionalProperties` | 字段 | E | 顶层 true |
| 29 | `MessagesBody` | 类型 | E | `typeof messagesBody.static` |
| 31-33 | `messagesModelPlugin` | 常量 | E | `Elysia({name:'messages.model'}).model({'messages.body':messagesBody})` |

依赖：`elysia`

---

## src/modules/messages/service.ts（27 行 · 协议层）

Strangler 门面：控制器只依赖 `MessagesService`，动态 import protocol 委托生命周期。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-7 | 分层注释 | 逻辑 | P | handler→translator/aggregator；protocol 仅 re-export；SSE Pipeline(false) 缓冲头；chat 用 autoStart:true 不对称 |
| 8-15 | re-export | 导出 | E | buildAnthropicResponse/convertAnthropicToOpenAI/createAnthropicSseTranslator/fakeThinkingSignature/handleMessages/handleMessagesBody ← ./protocol |
| 16 | `AnthropicStreamContext` | 类型 | E | type-only ← ./protocol |
| 18-27 | `MessagesService` | 类 | E | abstract，仅静态方法 |
| 19-22 | └ `handle` | 方法 | E | 动态 import ./protocol → handleMessages(request,headers) |
| 23-26 | └ `handleBody` | 方法 | E | 动态 import ./protocol → handleMessagesBody(body,headers,signal) |

依赖：`./protocol`

---

## src/modules/messages/protocol.ts（5 行 · 协议层）

纯 re-export 门面：handler/translator/aggregator 的统一出口，无运行时逻辑。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | handleMessages/handleMessagesBody | 导出 | E | ← ./handler |
| 2 | convertAnthropicToOpenAI/createAnthropicSseTranslator/fakeThinkingSignature | 导出 | E | ← ./translator |
| 3 | `AnthropicStreamContext` | 类型 | E | type-only ← ./translator |
| 4 | buildAnthropicResponse/createMessagesAggregator/rawUsageFromCcUsageAnthropic | 导出 | E | ← ./aggregator |
| 5 | `MessagesAggregate` | 类型 | E | type-only ← ./aggregator |

依赖：`./handler` `./translator` `./aggregator`

---

## src/modules/messages/handler.ts（414 行 · 协议层）

`/v1/messages` 请求/响应生命周期：鉴权、两跳转换、流式（pump+竞速+断连）与非流式聚合。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-14 | — | import | — | auth/cc/errors/http/logger/proxy-handler/runtime/session/sse/util + ./translator + ./aggregator |
| 16-20 | `anthropicRetryOpts` | 函数 | P | 从错误体取 retry_after |
| 22-36 | `sendAnthropicErrorWithRawUsage` | 函数 | P | 带 `error.rawUsage` 的 Anthropic 错误响应，可选 Retry-After |
| 38-40 | `buildAnthropicError` | 函数 | P | too-large→413，其余→400 invalid_request_error |
| 42-46 | `handleMessages` | 异步函数 | E | readRequestJson → handleMessagesBody |
| 48-414 | `handleMessagesBody` | 异步函数 | E | 主处理器 |
| 49-52 | └ 鉴权 | 逻辑 | P | getApiKey 缺失 401 authentication_error |
| 54-59 | └ 元信息+两跳转换 | 逻辑 | P | stream/model；convertAnthropicToOpenAI→prompt_cache_key→buildCcRequest |
| 62 | └ session | 逻辑 | P | getSessionId(headers,apiKey,prompt_cache_key) |
| 64-69 | └ 运行态 | 逻辑 | P | createUpstreamFlow/abortController/aborted()/startTime/messageId/bytesReceived |
| 71-82 | └ 上游调用 | 逻辑 | P | callUpstream(label 'CC API error (Anthropic)', onCcError→sendAnthropicError) |
| 84-271 | └ 流式分支 | 逻辑 | P | SsePipeline(false)+ctx+state |
| 85-87 |   └ pipeline/ctx/state | 逻辑 | P | SsePipeline(false)；AnthropicStreamContext；state{upstreamError,timedOut,zeroOutput,errorMsg} |
| 89-111 |   └ onClientAbort | 逻辑 | P | terminateWith(message_delta end_turn usage0 + message_stop)，记 warn |
| 112-114 |   └ gracefulClose+heartbeat | 逻辑 | P | flow.setGracefulClose；startSseHeartbeat |
| 115-195 |   └ pump | 异步函数 | P | 流式主循环 |
| 116-120 |     └ reader/翻译器初始化 | 逻辑 | P | reader；messageId=msg_{uuid12}；translator.startEvents() |
| 121-127 |     └ 读取循环 | 逻辑 | P | aborted()；readWithTimeout(idleTimeoutFor(lastCcEvent,true))；parseChunk |
| 129-141 |     └ 收尾/开播 | 逻辑 | P | flush+finishEvents；recordTimeoutSuccess；upstreamError→state；零输出→state+abort；否则 pipeline.start() |
| 142-189 |     └ pump catch | 逻辑 | P | 断连静默；STREAM_IDLE_TIMEOUT→429 帧；其他→internal_error 帧 |
| 190-194 |     └ pump finally | 逻辑 | P | reader.cancel + clearInterval(heartbeat) + pipeline.close |
| 197 | └ `void pump()` | 逻辑 | P | 后台启动 |
| 199-202 | └ 竞速 | 逻辑 | P | Promise.race(firstOutput→started, terminal→terminal) |
| 204-268 | └ terminal 未开播 | 逻辑 | P | upstreamError→timedOut 429→zeroOutput 429→errorMsg 502→兜底 429 |
| 270 | └ 流式成功 | 逻辑 | P | Response(pipeline.stream, 200, SSE_HEADERS) |
| 273-288 | └ 非流式聚合器 | 逻辑 | P | createMessagesAggregator({onEventError}) |
| 292-301 | └ 读取循环 | 逻辑 | P | idleTimeoutFor(...,false/90s)；bytesReceived+=；aggregator.push/flush |
| 302-345 | └ 非流式 catch | 逻辑 | P | aborted→499；STREAM_IDLE_TIMEOUT→429(retry_after 5)；其他→502 |
| 347-349 | └ abort 检查 | 逻辑 | P | 中止→499 |
| 351-367 | └ upstreamError | 逻辑 | P | 优先透传上游映射错误 |
| 369-382 | └ 零输出 | 逻辑 | P | !fullText&&!thinkingText&&!toolCalls→abort+429 rawUsage |
| 384-400 | └ 成功 | 逻辑 | P | recordTimeoutSuccess→normalizeUsage→log→sendJSON(200,buildAnthropicResponse(...)) |
| 401-413 | └ 外层 catch | 逻辑 | P | 断连→499；否则 abort+502 proxy_error |

依赖：`../../shared/auth` `../../infra/cc` `../../shared/errors` `../../shared/http` `../../shared/logger` `../../infra/proxy-handler` `../../shared/runtime` `../../infra/session` `../../infra/sse` `../../shared/util` `./translator` `./aggregator`

---

## src/modules/messages/translator.ts（333 行 · 协议层）

Anthropic↔OpenAI 转换、fakeThinkingSignature、CC→Anthropic SSE 翻译器（闭包工厂）。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-5 | — | import | — | cc-events/errors/logger/util |
| 7-11 | `fakeThinkingSignature` | 函数 | E | sha256→[0x12,len,...seed]→base64 伪签名 |
| 13-145 | `convertAnthropicToOpenAI` | 函数 | E | Anthropic→OpenAI 中间格式 |
| 14-31 | └ system | 逻辑 | P | 字符串或 [{type:'text'}] 数组拼接，push system 消息 |
| 34-56 | └ assistant | 逻辑 | P | text 累积；tool_use→tool_calls（登记 id→name） |
| 57-92 | └ user | 逻辑 | P | text + tool_result→role:'tool'（按映射回填 name），文本单独成 user |
| 95-129 | └ 顶层字段 | 逻辑 | P | model/max_tokens(64000)/stream/tools→parameters/tool_choice/temperature/top_p/stop/user |
| 131-142 | └ thinking | 逻辑 | P | disabled/none 忽略；adaptive→effort；budget_tokens 分档→reasoning_effort |
| 147-155 | `AnthropicStreamContext` | interface | E | bytesReceived/lastCcEvent/tokens×4/upstreamError |
| 157-333 | `createAnthropicSseTranslator` | 函数 | E | 闭包状态机，返回 {startEvents,parseChunk,flush,finishEvents} |
| 162-172 | └ 闭包状态 | 字段 | P | 块索引/类型/blockStarted/tokens/stopReason/hasError/currentThinkingText |
| 174-188 | └ `closeBlock` | 函数 | P | thinking 块补 signature_delta 后再 content_block_stop |
| 190-199 | └ `startBlock` | 函数 | P | 类型切换自动关旧块并 content_block_start |
| 201-207 | └ 便捷封装 | 函数 | P | startTextBlock/startThinkingBlock |
| 209-219 | └ message_start | 常量 | P | 首帧 message 骨架 |
| 221 | └ parser | 常量 | P | new CcStreamParser() |
| 223-277 | └ hooks | 逻辑 | P | reasoning-delta→thinking_delta；text-delta→text_delta(+1)；tool-call→三连帧(+20)；finish→handleFinishStep；error→ctx.upstreamError+error 帧 |
| 279-293 | └ `handleFinishStep` | 函数 | P | stopReason 映射 + usage 归一化回写 ctx |
| 296-298 | └ `startEvents` | 方法 | P | [messageStartFrame] |
| 300-305 | └ `parseChunk` | 方法 | P | 累 ctx.bytesReceived；parser.push；同步 lastCcEvent |
| 307-311 | └ `flush` | 方法 | P | parser.flush；同步 lastCcEvent |
| 313-331 | └ `finishEvents` | 方法 | P | hasError→[]；关块；零输出→error 帧；否则 message_delta+message_stop |

依赖：`../../infra/cc-events` `../../shared/errors` `../../shared/logger` `../../shared/util`

---

## src/modules/messages/aggregator.ts（117 行 · 协议层）

非流式聚合器 + `buildAnthropicResponse` + rawUsage 归一化。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-5 | — | import | — | cc-events/errors/uuid/./translator |
| 7-18 | `rawUsageFromCcUsageAnthropic` | 函数 | E | CC usage→{input_tokens,output_tokens,cached_tokens}，toNum 容错 |
| 20-50 | `buildAnthropicResponse` | 函数 | E | 组装 Anthropic message |
| 21-30 | └ content | 逻辑 | P | thinking(带签名)→text→tool_use（arguments 反序列化回退 {}） |
| 31-49 | └ 骨架+usage | 逻辑 | P | id=msg_{uuid12}；stop_reason 映射；usage 四元组（IIFE normalizeUsage） |
| 52-59 | `MessagesAggregate` | interface | E | fullText/thinkingText/toolCalls/finishReason/usage/upstreamError |
| 61-117 | `createMessagesAggregator` | 函数 | E | 工厂，返回 {lastCcEvent,push,flush,result} |
| 67-74 | └ 状态+parser | 字段 | P | 聚合状态；new CcStreamParser() |
| 75-98 | └ hooks | 逻辑 | P | text/reasoning-delta 累加；tool-call→OpenAI 形状；finish→reason+usage；error→upstreamError+回调 |
| 101-103 | └ `lastCcEvent` | 方法 | P | getter 转发 parser.lastCcEvent |
| 105-111 | └ `push`/`flush` | 方法 | P | 仅聚合状态，丢弃逐帧返回值 |
| 113-115 | └ `result` | 方法 | P | 返回 MessagesAggregate 快照 |

依赖：`../../infra/cc-events` `../../shared/errors` `../../shared/util` `./translator`

---

## src/modules/models/index.ts（13 行 · 协议层）

`/v1/models` 控制器：注册模型插件并把 GET 请求转交 `ModelsService.list`。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 3-5 | — | import | — | `elysia` / `./model` / `./service` |
| 7-9 | `modelsController` | 插件 | E | `Elysia({ name: 'models', prefix: '/v1/models' })`，`.use(modelsModelPlugin)` 后挂 `GET /` |
| 9 | `ModelsService.list(headers)` | 路由 | P | 路由处理器，仅透传 headers |
| 11 | `ModelsService` | 再导出 | E | 转发 `./service` |
| 12 | `listQuery` / `modelEntry` / `listResponse` / `modelsModel` | 再导出 | E | 转发 `./model`（`modelsModelPlugin` 重命名为 `modelsModel`） |
| 13 | `ModelsModel` | 再导出(type) | E | 转发 `./model` |

依赖：`elysia` `./model` `./service`

---

## src/modules/models/model.ts（33 行 · 协议层）

`/v1/models` 的 JSON Schema 单一真相源，注册 `models.entry`/`models.list` 具名模型。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | — | import | — | `elysia` |
| 4 | `listQuery` | 常量 | E | `t.Object({})` 空 query 占位 |
| 6-15 | `modelEntry` | 常量 | E | 条目 schema，`id` 必填，其余可选，`additionalProperties: true` |
| 17-23 | `listResponse` | 常量 | E | `{ object: Literal('list'), data: Array(modelEntry) }`，`additionalProperties: true` |
| 25-28 | `ModelsModel` | type | E | `UnwrapSchema` 推导的 entry/list 类型 |
| 30-33 | `modelsModelPlugin` | 插件 | E | 注册 `models.entry` / `models.list` |

依赖：`elysia`

---

## src/modules/models/service.ts（15 行 · 协议层）

Strangler 服务门面，动态 import 委托 catalog，避免单例分裂。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | — | import | — | `./catalog`（type `ModelEntry`） |
| 5-15 | `ModelsService` | class | E | `abstract class`，仅静态方法 |
| 6-9 | └ `list` | 方法 | E | 动态引入 `handleModels` 并委托（返回 `Response`） |
| 11-14 | └ `fetch` | 方法 | E | 动态引入 `fetchModels` 并委托（返回 `ModelEntry[]`） |

依赖：`./catalog`

---

## src/modules/models/catalog.ts（124 行 · 协议层）

内置模型清单 + Provider API 动态拉取（TTL 缓存，失败回退）。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-6 | — | import | — | `../../shared/config`/`logger`/`version`/`auth`/`util`/`http` |
| 8-13 | `ModelEntry` | interface | E | `{ id, name, context_window?, max_output_tokens? }` |
| 15-43 | `MODELS` | 常量 | E | 内置模型 26 项（Claude/GPT/DeepSeek/Kimi/GLM/MiniMax/Qwen/Step/MiMo/Gemini） |
| 45-49 | `toOptionalNumber` | 函数 | P | 非法值归一为 `undefined` |
| 51-53 | `pickContextWindow` | 函数 | P | `context_window`/`context_length`/`max_context_tokens` 归一 |
| 55-57 | `pickMaxOutputTokens` | 函数 | P | `max_output_tokens`/`max_tokens` 归一 |
| 59-61 | `STATIC_WINDOW_BY_ID` | 常量 | P | `MODELS` 中已声明窗口项的 `Map<id, number>` |
| 63-64 | `dynamicModels` / `modelsLastFetch` | 字段 | P | 模块级缓存与拉取时间戳 |
| 66-108 | `fetchModels` | 异步函数 | E | TTL 缓存 → 上游 GET（10s 超时）→ 映射写缓存；失败回退 `MODELS` |
| 67-70 | └ 缓存判定 | 逻辑 | P | 未过期直接返回缓存 |
| 72-73 | └ 禁用守卫 | 逻辑 | P | 无 key 或 `!CFG.useProviderModels` 抛错回退 |
| 75-82 | └ 上游请求 | 逻辑 | P | GET `${apiBase}/provider/v1/models`，Bearer + CC 头，`AbortSignal.timeout(10000)` |
| 87-95 | └ 条目映射 | 逻辑 | P | `id`/`name` 取 `m.id`；窗口上游优先否则静态；`max_output_tokens` 有值才写 |
| 96-99 | └ 写缓存 | 逻辑 | P | 更新 `dynamicModels`/`modelsLastFetch` 并 log info |
| 102-107 | └ 失败回退 | 逻辑 | P | log warn 并返回 `MODELS` |
| 110-123 | `handleModels` | 异步函数 | E | getApiKey → fetchModels → OpenAI list 形状 `sendJSON(200, ...)` |

依赖：`../../shared/config` `../../shared/logger` `../../shared/version` `../../shared/auth` `../../shared/util` `../../shared/http`

---

## src/modules/health/index.ts（12 行 · 协议层）

健康检查控制器：`/` 纯文本、`/health` JSON `{ok:true}`。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | — | import | — | `elysia` |
| 3-8 | `jsonResponse` | 函数 | P | 本地 JSON Response 构造 |
| 10-12 | `healthController` | 插件 | E | `Elysia({ name: 'health', prefix: '' })` |
| 11 | └ `GET /` | 路由 | P | 返回 `Response('OK', text/plain)` |
| 12 | └ `GET /health` | 路由 | P | `jsonResponse(200, { ok: true })` |

依赖：`elysia`

---

## test/e2e.ts（486 行 · 测试）

端到端测试：进程内起 mock CC 上游 `:4100`，动态 import 真实被测服务 `:4200`，覆盖双协议全部主路径与错误路径。

| 行号 | 符号/段落 | 类别 | 说明 |
|---|---|---|---|
| 1-5 | env 注入 | env | `PORT=4200`/`HOST=127.0.0.1`/`CC_API_BASE=http://127.0.0.1:4100`/`CC_MAX_BODY_MB=1`/`CC_API_KEY=''`，先于 import |
| 7 | `enc` | 工具 | `TextEncoder` 单例 |
| 9-15 | `stats` | 状态 | mock 计数 generate/fingerprint/lifecycle + lastGenerateHeaders/lastGenerateBody |
| 17-24 | `ndjson(events)` | 工具 | 事件数组 → NDJSON ReadableStream |
| 26-38 | `slowNdjson()` | 工具 | 慢速流（两次 sleep300），供断连 |
| 40 | `usage` | 状态 | 标准 usage 样本 {100,20,50} |
| 42-105 | mock `Bun.serve(:4100)` | mock | 上游桩服务 |
| 46 | `/_stats` | mock | 返回 stats |
| 49 | `/alpha/fingerprint/record` | mock | fingerprint++ 返回 {} |
| 50 | `/alpha/lifecycle-events` | mock | lifecycle++ 返回 {} |
| 51-53 | `/provider/v1/models` | mock | mock-model-a(context_window)/mock-model-b(context_length)/claude-sonnet-4-6 |
| 54-102 | `/alpha/generate` | mock | 记录头/体，按 params.model 分支 |
| 61-67 | `mock/reason` | mock | reasoning-delta+text-delta+finish |
| 68-72 | `mock/zero` | mock | start+finish，outputTokens 0 |
| 73-74 | `mock/slow` | mock | slowNdjson 流 |
| 75-76 | `mock/upstream-429` | mock | JSON 429 `rate limited upstream` |
| 77-80 | `mock/event-error` | mock | 流内 error 事件 `<429> slow down` |
| 81-86 | `mock/midstream-error` | mock | partial→error→finish |
| 87-92 | `mock/params` | mock | start+`params-ok`+finish |
| 93-101 | 默认分支 | mock | Hello world + tool-call get_weather + finish tool-calls |
| 103 | 兜底 404 | mock | 返回 `nf` |
| 107-108 | 启动 | 基建 | import `../src/index.ts` + sleep500 |
| 110-111 | `BASE`/`KEY` | 状态 | :4200 基址 + 测试 Key |
| 113-117 | `check` | 断言 | PASS/FAIL 计数 |
| 119-122 | `statsFetch` | 工具 | 拉取 mock `/_stats` |
| 124-144 | basic endpoints | 用例组 | /health 200+CORS、/ 返回 OK、OPTIONS 204、404 JSON |
| 146-186 | auth / parse errors | 用例组 | 双协议 401、无效 JSON 400、>1MB 413、无 Key models 200 |
| 188-196 | models | 用例组 | 动态列表、context_window 透传、context_length 别名、静态兜底 |
| 198-247 | openai 非流式 | 用例组 | 内容/工具调用/usage/id；上游头；上游体；init 幂等 |
| 249-266 | openai 流式 | 用例组 | event-stream、[DONE]、role、tool_calls chunk、finish+usage |
| 268-277 | openai reasoning | 用例组 | reasoning_content + content 并存、finish stop |
| 279-323 | 参数透传 | 用例组 | top_p/stop/user/seed 与 anthropic 对应字段 |
| 325-369 | 零输出 / 上游错误 | 用例组 | 429 各分支与流中 error 保持 SSE |
| 371-411 | anthropic 非流式 | 用例组 | msg_/tool_use/stop_reason/usage、thinking 伪签名、reasoning_effort |
| 413-438 | anthropic 流式 | 用例组 | 事件序列、text_delta、tool_use、message_delta |
| 440-465 | anthropic 零输出 / 上游错误 | 用例组 | 429 与流前 error → JSON 429 |
| 467-481 | 客户端断连 | 用例组 | abort 后服务存活 |
| 483-486 | 结果 / 导出 | 输出 | RESULT 行、fail>0 exit1、export {} |

依赖：`../src/index.ts`（动态 import） Bun 全局（Bun.serve/fetch/ReadableStream/TextEncoder/Bun.sleep）

---

## test/heartbeat.ts（89 行 · 测试）

SSE 心跳单元测试：验证 `startSseHeartbeat` 的四种状态闸门与两种 ping 帧形状。

| 行号 | 符号/段落 | 类别 | 说明 |
|---|---|---|---|
| 1 | import | import | `SSE_PING_EVENT`/`SsePipeline`/`startSseHeartbeat` from `../src/infra/sse.ts` |
| 3-7 | `check` | 断言 | PASS/FAIL 计数 |
| 9 | `dec` | 工具 | TextDecoder 单例 |
| 11-23 | `readOne(p, timeoutMs=200)` | 工具 | 竞速读取一帧，超时返回 ''，finally 释放锁 |
| 25-30 | 保活语义注释 | 输出 | 心跳只保下游不续租上游 |
| 31-43 | 用例组① idle → ping | 用例组 | 已开播+空闲 → `event: ping`/`"type":"ping"`、pingCount>0、默认帧形状 |
| 44-52 | 用例组② unstarted → no ping | 用例组 | 未 start → pingCount 0 |
| 53-62 | 用例组③ closed → no ping | 用例组 | close 后 → pingCount 0 |
| 63-74 | 用例组④ custom pingEvent | 用例组 | `: keepalive` 注释帧、不含 event: ping、计数>0 |
| 75-84 | 用例组⑤ no idle → no ping | 用例组 | idleMs=10000 窗口内不发 |
| 86-89 | 结果 / 导出 | 输出 | RESULT 行、exit、export {} |

依赖：`../src/infra/sse.ts`

---

## test/idle-timeout-env.ts（111 行 · 测试）

`CC_*_IDLE_MS` 环境变量解析契约的快速子进程测试，无 30s 真实等待。

| 行号 | 符号/段落 | 类别 | 说明 |
|---|---|---|---|
| 1-7 | 头注释 | 输出 | env 契约与分工说明 |
| 9 | `ROOT` | 状态 | 子进程 cwd |
| 10 | `PROBE` | 状态 | 探测脚本：import config 三常量并打印 JSON |
| 12 | `dec` | 工具 | TextDecoder 单例 |
| 14-18 | `ProbeResult` | 状态 | `{code,out,err}` |
| 20-39 | `runProbe(overrides)` | 工具 | 复制 env、undefined 删除 key、Bun.spawnSync 跑探测 |
| 41-47 | `parseOut` | 工具 | JSON 解析，失败 null |
| 49-59 | `check` | 断言 | PASS/FAIL 计数 |
| 61-66 | (a) unset | 用例组 | code 0 且 30000/90000/120000 |
| 68-73 | (b) custom | 用例组 | 60000/120000，thinking 默认 120000 |
| 75-80 | (b2) thinking custom | 用例组 | thinking 180000，stream/non-stream 默认 |
| 82-87 | (c) stream 0 | 用例组 | 0 → 默认 30000 |
| 89-94 | (c2) thinking 0 | 用例组 | 0 → 默认 120000 |
| 96-100 | (d) stream abc | 用例组 | 非数字 → 子进程非零退出 |
| 102-106 | (d2) thinking abc | 用例组 | 非数字 → 子进程非零退出 |
| 108-111 | 结果 / 导出 | 输出 | RESULT 行、exit、export {} |

依赖：`./src/shared/config.ts`（子进程内探测） Bun.spawnSync

---

## test/timeouts.ts（114 行 · 测试）

真实时间超时专项（约 30s）：mock 上游零字节挂起，验证 30s 空闲超时、上游取消与断连级联取消。

| 行号 | 符号/段落 | 类别 | 说明 |
|---|---|---|---|
| 1-4 | env 注入 | env | `PORT=4210`/`HOST=127.0.0.1`/`CC_API_BASE=http://127.0.0.1:4110`/`CC_API_KEY=''` |
| 6 | `enc` | 工具 | TextEncoder 单例 |
| 7 | `generateCancelled` | 状态 | 上游是否被取消 |
| 9-33 | mock `Bun.serve(:4110)` | mock | 上游桩服务，idleTimeout:120 |
| 14 | `/alpha/fingerprint/record` | mock | 返回 {} |
| 15 | `/alpha/lifecycle-events` | mock | 返回 {} |
| 16 | `/provider/v1/models` | mock | `{data:[{id:'m'}]}` |
| 17-30 | `/alpha/generate` | mock | abort 监听置位 + 零字节挂起 120s + cancel 回调置位 |
| 31 | 兜底 404 | mock | 返回 `nf` |
| 35-36 | 启动 | 基建 | import `../src/index.ts` + sleep300 |
| 38-39 | `BASE`/`KEY` | 状态 | :4210 基址 + 测试 Key |
| 41-45 | `check` | 断言 | PASS/FAIL 计数 |
| 47-65 | 用例组① stream idle timeout | 用例组 | 429 rate_limit_error(retry_after 5)、耗时 28-35s、上游已取消 |
| 67-83 | 用例组② anthropic 断连 | 用例组 | abort 后上游取消、/health 200 |
| 85 | 结果 | 输出 | RESULT 行 |
| 87-111 | ENABLE_THINKING_ASSERT 门控 | 用例组 | 纯函数断言 isThinkingWait/idleTimeoutFor 映射，默认跳过 |
| 112-114 | 退出 / 导出 | 输出 | fail>0 exit1、export {} |

依赖：`../src/index.ts`（动态 import） `../src/shared/runtime.ts`（门控动态 import）

---

## 模块依赖矩阵

### 外部依赖

- `elysia`：`src/app.ts`、`src/plugins/*`、各 `src/modules/*/index.ts` 与 `src/modules/*/model.ts`。
- `node:fs/promises`：仅 `src/shared/logger.ts`（`appendFile`）。
- 其余运行时能力均为 Bun/Web 全局 API：`Bun.serve`/`Bun.spawnSync`/`Bun.sleep`、`fetch`、`ReadableStream`、`TextEncoder`/`TextDecoder`、`crypto`。

### 按目录/层级的依赖矩阵

行=依赖方目录，列=被依赖目录；✔=存在 import。`入口`=index/app（含 index→app 的内部接线）。

| 依赖方 \ 被依赖 | 入口 | 插件 | shared | infra | chat | messages | models | health |
|---|---|---|---|---|---|---|---|---|
| 入口 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 插件 |  |  | ✔ |  |  |  |  |  |
| shared |  |  | ✔ |  |  |  |  |  |
| infra |  |  | ✔ | ✔ |  |  |  |  |
| modules-chat |  | ✔ | ✔ | ✔ | ✔ |  |  |  |
| modules-messages |  | ✔ | ✔ | ✔ |  | ✔ |  |  |
| modules-models |  |  | ✔ |  |  |  | ✔ |  |
| modules-health |  |  |  |  |  |  |  |  |

### 核心度（被依赖次数）排序

| 排名 | 模块 | 被依赖次数 | 主要依赖方 |
|---|---|---|---|
| 1 | `shared/logger.ts` | 11 | index、version、cc-events、proxy-handler、session、fingerprint、chat/messages 的 handler+translator、models/catalog |
| 2 | `shared/config.ts` | 9 | index、logger、runtime、http、auth、plugins/errors、infra/cc、infra/fingerprint、models/catalog |
| 3 | `shared/util.ts` | 9 | infra/cc、infra/session、infra/fingerprint、chat handler/aggregator、messages handler/translator/aggregator、models/catalog |
| 4 | `shared/errors.ts` | 6 | infra/proxy-handler、chat translator/aggregator、messages handler/translator/aggregator |
| 5 | `shared/http.ts` | 6 | plugins/cors、plugins/body、infra/proxy-handler、chat handler、messages handler、models/catalog |
| 6 | `shared/version.ts` | 4 | index、infra/cc、infra/fingerprint、models/catalog |
| 7 | `shared/auth.ts` | 4 | plugins/auth、chat handler、messages handler、models/catalog |
| 8 | `infra/cc.ts` | 4 | proxy-handler、chat/service(re-export)、chat handler、messages handler |
| 9 | `infra/session.ts` | 4 | index、infra/cc、chat handler、messages handler |
| 10 | `infra/cc-events.ts` | 4 | chat translator/aggregator、messages translator/aggregator |

> 统计口径：仅计 `src/` 内 import；`test/` 另行依赖 `src/index.ts`、`src/infra/sse.ts`、`src/shared/config.ts`、`src/shared/runtime.ts`。

### 观察要点

1. `shared/` 是典型高扇入地基：`logger`(11)、`config`(9)、`util`(9)、`errors`(6)、`http`(6) 构成全仓最底层，且 shared 内部仅指向 `config`/`logger`，无回边。
2. `infra/` 承担上游对接与共享管道：`cc`+`session`+`fingerprint` 管请求构建与会话/指纹，`proxy-handler` 抽出双协议共用的读体、断连级联与上游调用，`cc-events` 统一 NDJSON 解析。
3. 分层方向清晰为 入口 → 插件/协议模块 → infra → shared，矩阵中无反向依赖、无环；`plugins` 只依赖 `shared`，`health` 为仅依赖 `elysia` 的叶子。
4. chat 与 messages 的 `handler/translator/aggregator` 结构对称，差异集中在传输层：chat 的 `SsePipeline(true)` 用 `autoStart=true`，messages 用 `SsePipeline(false)` 缓冲头部并走 `emitAnthropic` + 两跳 Anthropic↔OpenAI 转换。
5. `models/catalog` 是唯一同时依赖 `config/logger/version/auth/util/http` 六个 shared 模块的聚合点，也是连通 `shared` 与 `modules-models` 的关键。

*本报告由全量源码扫描生成；行号对应当前工作区版本。*
