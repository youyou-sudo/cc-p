# 完整代码段映射报告（Code Map）

> 扫描范围：`src/` 19 个模块 + `test/` 2 个测试，共 21 个 TS 文件、约 3 235 行。
> 行号基于当前工作区文件内容；「可见性」中 `E`=export、`P`=模块私有。

---

## src/index.ts（117 行 · 入口层）

服务启动入口：注册 Elysia 路由、CORS、全局错误处理，并提供 `healthcheck` CLI 子命令。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-9 | — | import | — | elysia + config/http/logger/anthropic/models/openai/session/version |
| 11-16 | `jsonResponse` | 函数 | P | 简易 JSON Response 构造（仅错误路径使用） |
| 18-75 | `startServer` | 函数 | E | 创建 Elysia app 并监听 `CFG.port/CFG.host` |
| 23-28 | └ onRequest 钩子 | 路由中间件 | P | 注入 CORS_HEADERS；OPTIONS → 204 |
| 29-33 | └ 路由注册 | 路由 | P | `/`、`/health`、`/v1/models`、`/v1/chat/completions`、`/v1/messages` |
| 34-51 | └ onError 处理 | 错误处理 | P | 404 / 413 / PARSE / VALIDATION → 协议化错误体（messages 路径用 Anthropic 错误形状） |
| 54-72 | └ 启动日志 | 日志 | P | 打印 url/api/models 数量/CORS 策略/会话策略/ZDR/日志文件；无兜底 Key 时告警 |
| 77-99 | `healthcheck` | 异步函数 | E | GET `/health`，期望 `{ok:true}`，失败 `process.exit(1)`；Docker HEALTHCHECK 入口 |
| 101-110 | unhandledRejection | 全局钩子 | P | AbortError 静默，其余记 error 日志 |
| 112-117 | CLI 分派 | 入口 | P | `argv[2]==='healthcheck'` → healthcheck()，否则 startServer() |

依赖：`./config`(CFG,MAX_BODY_SIZE) → `./http`(CORS_HEADERS) → `./logger`(log) → `./anthropic`(handleMessages) → `./models`(handleModels,MODELS) → `./openai`(handleChatCompletions) → `./session`(startSessionCleanup) → `./version`(startVersionRefresh)

---

## src/config.ts（123 行 · 基础设施）

配置加载：内置默认值 → config.json → 环境变量，三层覆盖；顶层 `await` 一次加载。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-12 | `AppConfig` | interface | E | port/host/apiBase/apiKey/corsAllowOrigin/logFile/logLevel/useProviderModels/modelRefreshIntervalMs/zdr |
| 14-17 | `die` | 函数 | P | 打印 `[config]` 错误并 `process.exit(1)` |
| 19-36 | `candidateDirs` | 函数 | P | 独立二进制：cwd → $bunfs；源码运行：`src/..` → cwd（兼容 Docker/Release） |
| 38-51 | `findConfigJson` | 异步函数 | P | 按候选目录查找并解析 config.json，解析失败返回 null |
| 53-55 | `AppConfigWithSource` | interface | E | AppConfig + `configPath?`（当前未被使用，预留） |
| 57-60 | `envString` | 函数 | P | 环境变量读取，空串视为未设置 |
| 62-68 | `envNumber` | 函数 | P | 非法数字 → die |
| 70-74 | `envBool` | 函数 | P | `'1'`/`'true'`（大小写不敏感）→ true |
| 76-116 | `loadConfig` | 异步函数 | P | 默认值(L79-90) → fileConfig 合并(L92-95) → 端口/刷新间隔校验(L97-102) → 环境变量覆盖(L104-113)：PORT/HOST/CC_API_BASE/CC_API_KEY/CORS_ALLOW_ORIGIN/LOG_FILE/LOG_LEVEL/CC_USE_PROVIDER_MODELS/CC_MODEL_REFRESH_INTERVAL_MS/CMD_ZDR |
| 118 | `CFG` | const | E | `await loadConfig()` 的单例配置 |
| 120-123 | `MAX_BODY_SIZE` | const | E | `CC_MAX_BODY_MB`（默认 100MB），仅接受 >0 |

---

## src/logger.ts（16 行 · 基础设施）

分级日志：console 输出 + 可选文件追加（异步、失败静默）。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 4 | `LogLevel` | type | E | `'info' \| 'warn' \| 'error'` |
| 6 | `LEVEL_RANK` | const | P | debug:0 / info:1 / warn:2 / error:3（含 debug 供阈值比较） |
| 8-16 | `log` | 函数 | E | 低于 `CFG.logLevel` 阈值则丢弃；格式 `[ISO时间] [level] msg {json}`；logFile 存在时 appendFile 追加 |

---

## src/util.ts（75 行 · 基础设施）

无依赖工具集：哈希、随机、时间、JSON、伪造指纹辅助。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-3 | `sha256hex` | 函数 | E | Bun.CryptoHasher → hex 摘要 |
| 5-7 | `sha256bytes` | 函数 | E | 同上，返回原始字节 |
| 9-16 | `bytesToBase64` | 函数 | E | 分块(0x8000) String.fromCharCode + btoa |
| 18-22 | `randHex` | 函数 | E | crypto.getRandomValues → hex 串 |
| 24-26 | `uuid` | 函数 | E | crypto.randomUUID |
| 28-30 | `pick` | 函数 | E | 随机取数组元素 |
| 32-34 | `nowUnix` | 函数 | E | 秒级时间戳 |
| 36-38 | `getDateStr` | 函数 | E | `YYYY-MM-DD`（ISO 截取） |
| 40-42 | `getEnvironment` | 函数 | E | `'win32-x64, Node.js 22.10.0'` 与 fingerprint.ts 保持一致，避免被检测为机器人 |
| 44-50 | `tryParseJSON` | 函数 | E | 解析失败返回 `{}` |
| 52-54 | `generateTraceparent` | 函数 | E | W3C traceparent：`00-{32hex}-{16hex}-01` |
| 56-75 | `fakeProjectSlug` | 函数 | E | 由 sessionId 确定性生成 `users-dev-projects-<name>-<suffix>` 形态 slug |

---

## src/runtime.ts（13 行 · 基础设施）

超时常量与进程级超时计数（连续超时 N 次后向客户端建议缩减上下文）。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | `STREAM_IDLE_TIMEOUT_MS` | const | E | 30 000，流式响应读空闲上限 |
| 2 | `NONSTREAM_IDLE_TIMEOUT_MS` | const | E | 90 000，非流式聚合读空闲上限 |
| 3 | `TIMEOUT_REDUCE_CONTEXT_THRESHOLD` | const | E | 3 |
| 5-7 | `runtimeState` | const | E | `{ consecutiveTimeouts: 0 }`，成功响应后归零（openai.ts:286 / anthropic.ts:435,591） |
| 9-13 | `timeoutMessage` | 函数 | E | ≥3 次连续超时 → 提示缩减上下文文案，否则普通超时文案 |
14 | `TIMEOUT_STATE_TTL_MS` | 30 分钟：条目空闲超此时间后被清除 |
16-19 | `TimeoutEntry` | 接口 | P | `{ consecutiveTimeouts, lastUpdatedAt }` 每个 API key 独立的超时状态 |
21 | `timeoutStates` | Map | P | 按 API key 隔离的超时状态存储 |
23-27 | `pruneStale` | 函数 | P | 清理超过 TTL 的过期条目 |
29-36 | `entryFor` | 函数 | P | 获取或创建指定 key 的条目 |
39-45 | `recordTimeout` | 函数 | E | 指定 key 超时计数 +1 |
48-50 | `recordTimeoutSuccess` | 函数 | E | 指定 key 成功时删除其状态 |
53-57 | `consecutiveTimeouts` | 函数 | E | 获取指定 key 的当前连续超时次数 |
59-63 | `timeoutMessage` | 函数 | E | ≥3 次连续超时 → 提示缩减上下文文案 |

---

## src/http.ts（135 行 · 基础设施）

HTTP 层工具：CORS/SSE 头、JSON/Anthropic 错误响应、带排水保护和全局读超时的请求体读取、Promise 超时竞速。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 9-12 | `corsAllowOrigin` | 函数 | P | 显式配置优先；否则有兜底 Key → `'null'`（拒绝浏览器跨域），无 → `'*'` |
| 14-18 | `CORS_HEADERS` | const | E | Allow-Origin / Methods(`GET, POST, OPTIONS`) / Headers(`*`) |
| 20-25 | `SSE_HEADERS` | const | E | text/event-stream + no-cache + keep-alive + X-Accel-Buffering:no |
| 27-33 | `sendJSON` | 函数 | E | JSON 响应；body 含 `retry_after` 时自动加 `Retry-After` 头 |
| 35-50 | `sendAnthropicError` | 函数 | E | `{type:'error',error:{type,message}}` 形状；`headerOnly` 选项只发头不带 body.retry_after |
| 52-56 | `BodyTooLargeError` | class | E | 超 MAX_BODY_SIZE 抛出（消息含 MB 数） |
| 58 | `DRAIN_LIMIT` | const | P | 32 MB：超限后最多再排水 32MB 即取消 reader（防慢速攻击占内存） |
| 59 | `sharedDecoder` | const | P | 模块级共享 TextDecoder |
| 61-121 | `readJsonBody(request, timeoutMs=30000)` | 异步函数 | E | content-length 预检 → 分块读取；超限置 tooLarge 并排水；使用 `readWithTimeout` 实现全局读超时（默认 30s），超时自动 cancel reader；最终 JSON.parse（失败抛 Invalid JSON） |
| 75-80 | `readWithTimeout` | 内部函数 | P | Promise.race 超时包装；超时 reject `new Error('READ_TIMEOUT')`；防止 Slowloris 攻击 |
| 123-135 | `readWithTimeout` | 异步函数 | E | `Promise.race` 包超时；超时 reject `new Error(tag)`（tag 约定为 `'STREAM_IDLE_TIMEOUT'`，被上层按 message 匹配）；finally 清定时器 |

---

## src/auth.ts（43 行 · 基础设施）

API Key 提取与鉴权错误文案（格式校验：`user_` 前缀 + base64url 字符集）。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 3 | `KEY_PATTERN` | const | E | `/user_[a-zA-Z0-9_-]+/`（非锚定，取首个匹配） |
| 5-9 | `extractKey` | 函数 | P | 从字符串中提取符合 KEY_PATTERN 的 Key |
| 11-22 | `getApiKey` | 函数 | E | 优先级：`Authorization: Bearer user_xxx` → `x-api-key` → `CFG.apiKey` 兜底；三者皆无 → null |
| 24-34 | `keyFormatError` | 函数 | E | 客户端**带了** Key 但格式非法时返回错误文案（截取前 12 字符），合法/未带 → null |
| 36-42 | `authErrorMessage` | 函数 | E | 格式错误文案优先；否则区分「有兜底 Key（提示可设 CC_API_KEY）」与「无兜底」两种 401 文案 |

---

## src/cc-types.ts（39 行 · 基础设施 · 纯类型）

Command Code 上游 NDJSON 线协议类型定义，无运行时代码。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 4-9 | `CcUsage` | interface | E | inputTokens/outputTokens/cachedInputTokens/inputTokenDetails.cacheWriteTokens |
| 13-30 | 17 个事件接口 | interface | E | `CcStartEvent`(13) `CcStartStepEvent`(14) `CcReasoningStartEvent`(15) `CcTextStartEvent`(16) `CcTextEndEvent`(17) `CcReasoningEndEvent`(18) `CcToolInputStartEvent`(19) `CcToolInputDeltaEvent`(20) `CcToolInputEndEvent`(21) `CcToolErrorEvent`(22) `CcProviderMetadataEvent`(23) `CcTextDeltaEvent`(25, text/delta 双字段) `CcReasoningDeltaEvent`(26) `CcToolCallEvent`(27) `CcFinishStepEvent`(28) `CcFinishEvent`(29, totalUsage/usage) `CcErrorEvent`(30, error/message/retry_after) |
| 32-37 | `CcStreamEvent` | type(union) | E | 上述全部事件的判别联合 |
| 39 | `CcEventType` | type | E | `CcStreamEvent['type']` 事件名字面量联合 |

---

## src/cc-events.ts（96 行 · 共享管道）

CC NDJSON → 事件分发的共用解析器。各协议文件注册 `CcEventHooks`，本模块负责缓冲分行、JSON 解析、未知事件告警与错误事件记账。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 15-24 | `CC_EVENT_TYPES` | const Set | E | 上游可能出现的全部 17 种事件类型；解析器仅对**不在集合内**的类型告警，新增上游事件只需在此补一行 |
| 26 | `CcEventHook` | type | E | `(event) => string[] \| string \| void`，返回值作为待发送 SSE 片段 |
| 27-29 | `CcEventHooks` | type | E | 按事件类型的钩子表 + `default(type,event)` 兜底 |
| 31-101 | `CcStreamParser` | class | E | 核心解析器 |
| 32 | └ `lastCcEvent` | 字段 | P | 最近一次收到的事件类型（供超时/断连诊断日志） |
| 33 | └ `errorEvent` | 字段 | P | 最近一次 `type:'error'` 事件 |
| 34 | └ `unknownEvent` | 字段 | P | 最近一次未知事件类型 |
| 36-37 | └ `buffer` / `MAX_LINE_LENGTH` | 字段 | P | 行缓冲；单行上限 64KB，超过自动清空（防止内存攻击） |
| 43-54 | └ `push` | 方法 | P | 流式解码 → 检查行长度限制 → 按 `\n` 切行（最后一段留缓冲）→ 逐行 handleLine，收集输出片段 |
| 52-59 | └ `flush` | 方法 | P | 流结束时冲刷尾行 |
| 61-95 | └ `handleLine` | 方法 | P | 空行/`[DONE]`/SSE 注释行跳过；JSON 解析失败静默；无 type 跳过；`error` 事件优先记账并调用 hooks.error；未知类型 → hooks.default 或 log warn |

---

## src/cc.ts（190 行 · 上游对接）

OpenAI 中间格式 → CC 请求体构建，以及向 `{CC_API_BASE}/alpha/generate` 的 HTTP 转发（含伪 CLI 头部）。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 6-156 | `buildCcRequest` | 函数 | E | OpenAI 请求 → CC body |
| 9-15 | └ system 提取 | 逻辑 | P | `system`/`developer` 角色消息拼接为 systemPrompt（数组内容按 text 逐段拼接） |
| 17-26 | └ toolNameMap | 逻辑 | P | assistant `tool_calls[].id → function.name` 映射（供 tool 结果回填工具名） |
| 28-78 | └ 消息转换 | 逻辑 | P | user：字符串→`[{type:'text'}]`、`image_url`→`{type:'image',image:url}`；assistant：text 片段 + `tool_calls`→`{type:'tool-call',toolCallId,toolName,input}`（arguments 字符串 tryParseJSON）；tool → `{type:'tool-result',toolCallId,toolName(msg.name 优先，查表次之),output:{type:'text',value}}`；其余角色兜底为 user 文本 |
| 80-86 | └ 缓存标记 | 逻辑 | P | 有 `prompt_cache_key` 且消息无 cache_control 时，在首条 user 消息最后一个 text 片段注入 `cache_control:{type:'ephemeral'}` |
| 88-110 | └ body 骨架 | 逻辑 | P | `config`（workingDir/date/environment/伪 git 状态）、`memory/taste/skills`、`permissionMode:'standard'`、`params{model(默认 deepseek/deepseek-v4-flash),messages,max_tokens(min(x,200000),默认64000),stream:true}` |
| 112-153 | └ 可选参数透传 | 逻辑 | P | system/temperature/reasoning_effort/tools(→name+input_schema)/tool_choice(auto,none,required→any;function→tool)/parallel_tool_calls/top_p/stop/user/seed |
| 158-190 | `forwardToCC` | 异步函数 | E | POST `${CFG.apiBase}/alpha/generate`；头：Content-Type、Authorization Bearer、x-cli-environment:production、x-command-code-version、x-session-id(getSessionId)、x-co-flag:false、x-taste-learning:false、x-project-slug(fakeProjectSlug)、traceparent；`CFG.zdr` 或请求头 `x-cmd-zdr:1` 时加 `x-cmd-zdr:1`；透传 AbortSignal |

依赖：`./config`(CFG) `./session`(getSessionId) `./version`(CC_VERSION) `./util`(fakeProjectSlug,generateTraceparent,getDateStr,getEnvironment,tryParseJSON)

---

## src/sse.ts（194 行 · 共享管道）

SSE 发送管道（缓冲/保活/终止语义）+ OpenAI 协议的 CC→SSE 流式翻译器。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 6-79 | `SsePipeline` | class | E | 可控 ReadableStream 封装 |
| 13-18 | └ 字段 | 字段 | P | `stream`(ReadableStream)、`firstOutput`/`terminal` Promise、`started`/`closed`/`keepaliveCount` |
| 20-26 | └ 构造器 | 方法 | P | autoStart 参数决定 emit 是否自动开播 |
| 28-32 | └ `enqueue` | 方法 | P | TextEncoder 编码入队，controller 已关闭时静默 |
| 34-41 | └ `emit` | 方法 | P | 未开播则入 buffered；autoStart=true 时自动 start |
| 43-47 | └ `emitKeepalive` | 方法 | P | 发送 `: keepalive\n\n` 注释帧并计数（仅在已开播且未关闭） |
| 49-51 | └ `writeNow` | 方法 | P | 绕过缓冲直接写（用于错误事件） |
| 53-59 | └ `start` | 方法 | P | 冲刷缓冲 → resolve firstOutput |
| 61-68 | └ `close` | 方法 | P | 关流 → resolve terminal |
| 70-78 | └ `terminateWith` | 方法 | P | 冲刷缓冲 + 写入终止事件序列 + close（客户端断连时的优雅收尾） |
| 81-91 | `makeChunk` | 函数 | P | OpenAI `chat.completion.chunk` SSE 帧；usage 存在时附带 |
| 93-194 | `createSseTranslator` | 工厂函数 | E | 闭包状态：chunkIndex/finishReason/usage/toolCallIndex + 内嵌 CcStreamParser |
| 107-163 | └ hooks | 逻辑 | P | `text-delta`→content chunk（首块带 role）；`reasoning-delta`→reasoning_content chunk；`tool-call`→tool_calls delta（id 缺省 `call_{ts}_{i}`）；`finish-step`→记账 usage/finishReason；`finish`→最终带 usage 的空 delta chunk；`error`→记 upstreamError(mapCcEventError) |
| 165-193 | └ 返回对象 | API | P | getter：lastCcEvent/upstreamError/inputTokens/outputTokens/cachedInputTokens；方法：parseChunk/flush/getDoneEvent(`data: [DONE]\n\n`) |

---

## src/errors.ts（86 行 · 共享管道）

CC 上游错误 → 两种协议错误体、finish reason 与 usage 的归一化映射。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-12 | `CC_STATUS_MAP` | const | E | CC 状态→(status,type)：400/422→400 invalid_request、401/403→401 authentication、402→402 payment_required、404→404 not_found、429→429 rate_limit、500/502→502 upstream、503→503 temporarily_unavailable |
| 14-17 | `MappedError` | interface | E | `{status, body}` |
| 19-43 | `mapCcError` | 函数 | E | 非 2xx 响应体 → MappedError；优先取 body.error.message/body.message，解析失败截前 200 字符；429 特判附 `retry_after:30` |
| 45-59 | `mapCcEventError` | 函数 | E | 流内 `type:'error'` 事件 → MappedError；从消息前缀 `<NNN>` 提取状态码（缺省 502）；429 同样附 retry_after:30 |
| 61-68 | `mapFinishReason` | 函数 | E | CC `tool-calls`→OpenAI `tool_calls`；`length`/`stop` 原样；缺省 `stop` |
| 70-77 | `normalizeUsage` | 函数 | E | outputTokens 缺失/0 时强制 inputTokens、cachedInputTokens 归零（上游口径一致性） |
| 79-86 | `mapAnthropicStopReason` | 函数 | E | OpenAI finish→Anthropic stop_reason：tool_calls→tool_use、length→max_tokens、stop→end_turn、缺省 end_turn |

---

## src/proxy-handler.ts（91 行 · 共享管道）

两个协议处理器共享的管道：请求体解析、客户端断连级联取消（UpstreamFlow）、上游调用前置（指纹初始化 + 转发 + 非 2xx 映射）。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 13 | `JsonParseErrorKind` | type | E | `'too-large' \| 'invalid'` |
| 17-29 | `readRequestJson<T>` | 异步函数 | E | 包 `readJsonBody`：BodyTooLargeError → `buildError('too-large')`，其余 → `buildError('invalid','Invalid JSON body')`；返回 discriminated union `{ok:true,value}` / `{ok:false,response}` |
| 40-46 | `UpstreamFlow` | interface | E | signal/controller/aborted/setGracefulClose/abort |
| 48-64 | `createUpstreamFlow` | 函数 | E | 注册 `request.signal` 的 once abort 监听：置 aborted → 先执行 gracefulClose（优雅收尾）→ 再 `controller.abort()`（掐断上游 fetch/计费） |
| 66-76 | `UpstreamCallArgs<T>` | interface | E | apiKey/headers/ccBody/signal/promptCacheKey/label/onCcError（协议化错误构造器） |
| 79-91 | `callUpstream<T>` | 异步函数 | E | `ensureInitialized` → `forwardToCC` → 非 ok：读错误文本 → `log('error',label,{status})` → 返回 `{ok:false,value:onCcError(mapCcError(...))}`；ok 返回 `{ok:true,response}` |

---

## src/openai.ts（325 行 · 协议层）

`POST /v1/chat/completions` 处理器：OpenAI 请求 → CC，流式（SSE）与非流式（JSON）双路径状态机。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 14-19 | `TerminalState` | interface | P | upstreamError/timedOut/zeroOutput/errorMsg 终态记账 |
| 21-25 | `buildError` | 函数 | P | JsonParseErrorKind → 413/400 OpenAI 错误体 |
| 27-36 | `zeroUsageChunk` | 函数 | P | 断连时的终止 chunk（全零 usage + finish_reason:stop） |
| 38-325 | `handleChatCompletions` | 异步函数 | E | 主处理器 |
| 39-46 | └ 解析与鉴权 | 逻辑 | P | readRequestJson → getApiKey（缺失 401 auth_error） |
| 48-59 | └ 请求元信息 | 逻辑 | P | stream/model(默认 deepseek/deepseek-v4-flash)/completionId(`chatcmpl-{uuid12}`)/created/buildCcRequest/createUpstreamFlow |
| 62-73 | └ 上游调用 | 逻辑 | P | callUpstream（prompt_cache_key 透传，label 'CC API error'，onCcError → sendJSON） |
| 75-200 | └ 流式分支 | 逻辑 | P | `SsePipeline(true)` + `createSseTranslator` |
| 80-99 |   └ onClientAbort | 逻辑 | P | 断连原因分类：tool-input 开头→tool-input-silent-timeout；含 delta→streaming-active-disconnect；否则 client-hangup；`terminateWith([zeroUsageChunk, [DONE]])` |
| 101-178 |   └ pump | 逻辑 | P | 循环 readWithTimeout(30s) 读上游 → translator.parseChunk → pipeline.emit；空闲时 emitKeepalive；结束 flush；upstreamError/zeroOutput 分支写错误帧；catch：断连静默 / STREAM_IDLE_TIMEOUT（recordTimeout(apiKey)、已开播则写 429 错误帧）/ 其他错误（写 proxy_error 帧）；finally close |
| 180-199 |   └ 竞速与返回 | 逻辑 | P | `Promise.race(firstOutput→'started', terminal→'terminal')`；terminal 未开播则按 state 返回协议化 JSON 错误（429/502）；started 则 `Response(pipeline.stream, SSE_HEADERS)` |
| 202-311 | └ 非流式分支 | 逻辑 | P | CcStreamParser+hooks 聚合（text-delta/reasoning-delta/tool-call/finish/error）→ readWithTimeout(90s) 循环 → 零输出 429 upstream_error / idle timeout 429(retry_after 5) / 502 / 成功聚合 `chat.completion`（usage: prompt_tokens/completion_tokens/total/cached_tokens） |
| 312-324 | └ 外层 catch | 逻辑 | P | 断连→499；否则 502 proxy_error |

---

## src/anthropic.ts（606 行 · 协议层）

`POST /v1/messages` 处理器 + Anthropic↔OpenAI 转换 + CC→Anthropic SSE 流式翻译器（AsyncGenerator）。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 14-18 | `fakeThinkingSignature` | 函数 | E | 由 thinking 文本 sha256 构造 `[0x12,len,...seed]` 的 base64 伪签名（满足 Anthropic 客户端格式校验） |
| 20-145 | `convertAnthropicToOpenAI` | 函数 | E | Anthropic → OpenAI 中间格式 |
| 21-31 |   └ system | 逻辑 | P | 字符串或 `[{type:'text'}]` 数组拼接 |
| 41-93 |   └ 消息 | 逻辑 | P | assistant：text + `tool_use`→`tool_calls`（记录 id→name）；user：text + `tool_result`→`role:'tool'` 消息（数组 content 拼接文本） |
| 95-129 |   └ 顶层字段 | 逻辑 | P | model(默认 claude-sonnet-4-6)/max_tokens(默认64000)/stream/tools(→function.parameters)/tool_choice(auto/any→required/tool→function/none)/temperature/top_p/stop_sequences→stop/metadata.user_id→user |
| 131-142 |   └ thinking | 逻辑 | P | disabled/none→忽略；adaptive→effort；budget_tokens≥10000→high、≥5000→medium、≥2000→low、其余 low |
| 147-177 | `buildAnthropicResponse` | 函数 | E | 非流式聚合：thinking 块（带伪签名）→ text 块 → tool_use 块（arguments 反序列化为 input）；stop_reason 映射；usage 映射（含 cache_creation/read tokens） |
| 179-186 | `AnthropicStreamContext` | interface | E | 流式翻译的跨层状态：bytesReceived/lastCcEvent/inputTokens/outputTokens/cachedInputTokens/upstreamError |
| 188-350 | `createAnthropicSseTranslator` | 异步生成器 | E | CC 响应 → Anthropic SSE 事件序列 |
| 194-204 |   └ 状态 | 逻辑 | P | 块索引/当前块类型/tokens/stopReason/hasError/currentThinkingText |
| 206-231 |   └ closeBlock/startBlock | 内部函数 | P | 块生命周期：thinking 块关闭时补 `signature_delta`（伪签名）；类型切换自动关旧开新 |
| 241-251 |   └ message_start | 逻辑 | P | 首事件：message 骨架（id/type/role/model/usage） |
| 256-298 |   └ hooks | 逻辑 | P | `reasoning-delta`→thinking 块+thinking_delta；`text-delta`→text 块+text_delta（outputTokens+1）；`tool-call`→一次性 tool_use 块（start+input_json_delta+stop，outputTokens+20）；`finish-step`/`finish`→handleFinishStep；`error`→ctx.upstreamError + `event: error` 帧 |
| 300-318 |   └ handleFinishStep | 内部函数 | P | stopReason 映射；usage 归一化（含 cacheWriteTokens）；有 totalUsage/usage 则累记，否则全零 |
| 320-350 |   └ 主循环 | 逻辑 | P | readWithTimeout(30s) → parser.push → 逐条 yield；结束后 flush；无错误时关块 + zeroOutput 检查（yield error 帧）或 message_delta(usage)+message_stop；finally reader.cancel |
| 352-354 | `buildAnthropicError` | 函数 | P | JsonParseErrorKind → 413/400 Anthropic invalid_request_error |
| 356-606 | `handleMessages` | 异步函数 | E | 主处理器（结构对应 openai.handleChatCompletions） |
| 357-370 |   └ 解析/鉴权/转换 | 逻辑 | P | readRequestJson → getApiKey(401) → convertAnthropicToOpenAI → buildCcRequest |
| 382-391 |   └ 上游调用 | 逻辑 | P | callUpstream（label 'CC API error (Anthropic)'，onCcError → sendAnthropicError） |
| 393-505 |   └ 流式分支 | 逻辑 | P | `SsePipeline(false)` + ctx/state |
| 398-416 |     └ onClientAbort | 逻辑 | P | 优雅终止：message_delta(end_turn)+message_stop |
| 418-478 |     └ pump | 逻辑 | P | 生成器逐事件：未开播时仅当事件含 `"text_delta"`/`"tool_use"`/`"thinking_delta"` 才 start（避免把 message_start 冲给 race，thinking_delta 也触发开播避免首包假死）；writeNow 已开播流；错误分支与 openai 相同（timeout→429 帧 + recordTimeout(apiKey)） |
| 482-504 |     └ 竞速与返回 | 逻辑 | P | terminal 且未开播 → 按 state 返回 429/502 Anthropic 错误；否则 200 + SSE 流 |
| 507-592 |   └ 非流式分支 | 逻辑 | P | 同 openai 非流式结构，但 hooks 多 `reasoning-delta` 聚合；零输出 → 429 upstream_error；成功走 buildAnthropicResponse；idle timeout → 429 + headerOnly Retry-After |
| 593-605 |   └ 外层 catch | 逻辑 | P | 断连→499；否则 502 proxy_error |

---

## src/models.ts（94 行 · 协议层）

`GET /v1/models`：优先从 Provider API 动态拉取模型列表（带 TTL 缓存），失败回退内置 27 项列表。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 8-11 | `ModelEntry` | interface | E | `{id,name}` |
| 13-40 | `MODELS` | const | E | 内置模型列表 27 项（Claude/GPT/DeepSeek/Kimi/GLM/MiniMax/Qwen/Step/MiMo/Gemini 系列） |
| 42-43 | `dynamicModels`/`modelsLastFetch` | 变量 | P | 缓存与上次拉取时间 |
| 45-79 | `fetchModels` | 异步函数 | E | 缓存未过期直接返回；无 Key 或 useProviderModels=false 抛错走回退；GET `${apiBase}/provider/v1/models`（10s 超时，带 CC 版本头）；成功则刷新缓存；失败 log warn 并回退 MODELS |
| 81-94 | `handleModels` | 异步函数 | E | getApiKey → fetchModels → OpenAI list 形状（object:list，owned_by:'command-code'） |

---

## src/session.ts（60 行 · 上游对接）

按 API key 的会话 ID 管理：优先透传客户端会话头，否则生成并缓存（12h + ≤1h 抖动），每小时清理过期会话。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 5-6 | `SESSION_DURATION_MS`/`SESSION_JITTER_MS` | const | P | 12h / 1h |
| 8-11 | `SessionEntry` | interface | P | `{sessionId, expiresAt}` |
| 13 | `sessionStore` | const | P | `Map<apiKey, SessionEntry>` |
| 15-28 | `ensureSession` | 函数 | E | 未过期复用；否则新建 uuid 会话并记日志 |
| 30-45 | `getSessionId` | 函数 | E | 候选优先级：`x-session-id` → `x-claude-code-session-id` → `session_id` → `prompt_cache_key`（长度≥8 才采纳）；否则 ensureSession |
| 47-60 | `startSessionCleanup` | 函数 | E | 每小时遍历删除过期条目，同时清理 `keyStateStore`（fingerprint 状态联动）；有清理才记日志 |

---

## src/fingerprint.ts（190 行 · 上游对接）

为每个 API key 伪造稳定的设备指纹并向上游上报（fingerprint/record + lifecycle-events），8h + ≤2h 抖动刷新；init 请求去重（in-flight 合并）。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 6-22 | `FINGERPRINT_CPUS` | const | P | 15 种伪造 CPU 型号/核心数（Intel 12-14 代 / Ultra / AMD Ryzen） |
| 24 | `FINGERPRINT_MEMS` | const | P | 内存档位 8/16/24/32/48/64 GiB |
| 26-31 | `FINGERPRINT_TZS` | const | P | 15 个时区 |
| 33 | `FINGERPRINT_MAC_COUNT_RANGE` | const | P | MAC 数量 2-5 |
| 35-54 | `Fingerprint` | interface | E | thumbmark + components（machineIdHash/macHashes/osUserHash/hostnameHash/gitEmailHash/platform/arch/osRelease/cpuModel/cpuCount/memGiB/isContainer/timezone/runtime/collectorVersion） |
| 56-93 | `generateFingerprint` | 函数 | E | 随机拼装（平台固定 win32/x64/10.0.22631/isContainer:false/runtime:'cli'）；thumbmark = sha256(各哈希拼接) |
| 95-98 | `KeyState` | interface | E | `{fingerprint, nextInitAt}` |
| 100 | `keyStateStore` | const | E | `Map<apiKey, KeyState>`（session 清理时联动删除） |
| 102-113 | `getOrCreateKeyState` | 函数 | E | 懒创建并 log `keyPrefix` |
| 115-116 | `INIT_REFRESH_MS`/`INIT_JITTER_MS` | const | P | 8h / 2h |
| 118 | `inFlightInit` | const | P | `Map<apiKey, Promise<void>>` init 去重 |
| 120-141 | `ensureInitialized` | 异步函数 | E | 未到期直接返回；有 in-flight 复用；否则 doInit，失败仅告警（key 保持旧值，下次请求重试），AbortError 静默；finally 清 in-flight |
| 143-190 | `doInit` | 异步函数 | P | 并发两个 POST：`/alpha/fingerprint/record`（指纹体）与 `/alpha/lifecycle-events`（eventType:'cli_session_exists' + 伪 sessionId/cliVersion/mode:'interactive'/os）；均 10s 信号外控、非 ok 仅 warn；成功后安排 nextInitAt = now + 8h + jitter |

---

## src/version.ts（25 行 · 上游对接）

CC CLI 版本号维护：默认 `0.32.3`，每 24h 从 npm registry 拉取 `command-code` 最新版本刷新。

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 3 | `CC_VERSION` | let | E | 当前版本（可变，被 cc/fingerprint/models 引用写入请求头） |
| 4 | `CC_VERSION_REFRESH_MS` | const | P | 24h |
| 6-20 | `refreshCCVersion` | 异步函数 | E | GET `registry.npmjs.org/command-code/latest`（10s 超时）；成功改写 CC_VERSION；失败 warn 保留现值 |
| 22-25 | `startVersionRefresh` | 函数 | E | 启动即刷新 + setInterval(24h) |

---

## test/e2e.ts（456 行 · 测试）

端到端测试：内置 mock CC 上游（端口 4100）+ 真实被测服务（端口 4200，env 注入隔离配置）。

| 行号 | 符号/段落 | 类别 | 说明 |
|---|---|---|---|
| 1-5 | env 注入 | 配置 | PORT=4200 / HOST=127.0.0.1 / CC_API_BASE=4100 / CC_MAX_BODY_MB=1 / 无兜底 Key |
| 9-15 | `stats` | 状态 | mock 上游计数：generate/fingerprint/lifecycle + 最后一次请求头/体 |
| 17-24 | `ndjson` | 工具 | 事件数组 → NDJSON ReadableStream |
| 26-38 | `slowNdjson` | 工具 | 慢速流（两次 Bun.sleep(300)），供断连测试 |
| 42-105 | mock Bun.serve | 桩服务 | `/_stats`、`/alpha/fingerprint/record`、`/alpha/lifecycle-events`、`/provider/v1/models`（mock-model-a/b）、`/alpha/generate`（按 model 分支：mock/reason、mock/zero、mock/slow、mock/upstream-429、mock/event-error、mock/midstream-error、mock/params、默认含 tool-call） |
| 107-122 | 启动与工具 | 基建 | 动态 import 被测 app；`check` 断言器；`statsFetch` |
| 124-144 | basic endpoints | 用例组 | /health（含 CORS `*`）、/、OPTIONS 204+CORS、404 JSON |
| 146-176 | auth / parse errors | 用例组 | 双协议 401、无效 JSON 400、413（体上限 1MB） |
| 178-244 | openai 非流式 | 用例组 | 文本/工具调用/finish_reason/usage/id 格式；上游头校验（bearer、x-session-id、x-project-slug、traceparent、版本头、co/taste flag）；body 校验（stream:true、system 提取、tools→input_schema、user 包装、cache_control 注入、无 system 角色）；init 不重复、generate 递增 |
| 246-263 | openai 流式 | 用例组 | content-type、[DONE]、首块 role、后续块无 role、tool_calls chunk、finish 带 usage |
| 265-274 | openai reasoning | 用例组 | reasoning_content + content 并存、finish stop |
| 276-320 | param passthrough | 用例组 | top_p/stop/user/seed 透传（双协议） |
| 322-366 | zero output / errors | 用例组 | 零输出 429(retry_after 10)、上游 429 → 映射(retry_after 30)、流前错误事件→429、流中错误→保持 200 SSE 且含 error 帧无 [DONE] |
| 368-408 | anthropic 非流式/thinking | 用例组 | msg_id、text+tool_use 块、stop_reason、usage；thinking 块+伪签名、budget_tokens 12000→reasoning_effort high |
| 410-435 | anthropic 流式 | 用例组 | 事件顺序 message_start→…→message_stop、text_delta、tool_use/input_json_delta、message_delta(stop_reason+usage) |
| 437-451 | client disconnect | 用例组 | 断连后服务存活（/health 200） |
| 453-455 | 结果 | 输出 | `RESULT: N passed, M failed`，失败 exit 1 |

## test/timeouts.ts（81 行 · 测试）

真实时间流逝的超时专项测试（约 30s）：mock 上游挂起 120s。

| 行号 | 符号/段落 | 类别 | 说明 |
|---|---|---|---|
| 1-4 | env 注入 | 配置 | PORT=4210 / CC_API_BASE=4110 / 无兜底 Key |
| 7 | `generateCancelled` | 状态 | 上游 /alpha/generate 是否被取消（abort 事件 + cancel 回调双标记） |
| 9-31 | mock Bun.serve | 桩服务 | idleTimeout:120；/alpha/generate 返回只发 `start` 后挂起 120s 的流 |
| 33-43 | 启动与工具 | 基建 | import 被测 app；`check` 断言器 |
| 45-58 | stream idle timeout | 用例组 | 流式挂起 → 恰在 28-35s 内返回 429 rate_limit_error(retry_after 5)；且上游 generateCancelled=true |
| 60-76 | anthropic disconnect | 用例组 | /v1/messages 流式中途 abort → 上游被取消；服务存活 |
| 78-81 | 结果 | 输出 | 同 e2e 输出格式 |

---

## 模块依赖矩阵（import 方向：行 = 依赖方，列 = 被依赖方）

外部依赖：`elysia`（仅 index.ts）、`node:fs/promises`（仅 logger.ts）、Bun 全局 API（Bun.CryptoHasher / Bun.file / Bun.isStandaloneExecutable / crypto / fetch / ReadableStream 等）。

| 模块 | config | logger | util | http | auth | runtime | cc-types | cc-events | cc | sse | errors | proxy-handler | models | session | fingerprint | version | elysia |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| index | ✔ | ✔ | | ✔ | | | | | | | | | ✔ | ✔ | | ✔ | ✔ |
| config | — | | | | | | | | | | | | | | | | |
| logger | ✔ | — | | | | | | | | | | | | | | | |
| util | | | — | | | | | | | | | | | | | | |
| runtime | | | | | | — | | | | | | | | | | | |
| http | ✔ | | | — | | | | | | | | | | | | | |
| auth | ✔ | | | | — | | | | | | | | | | | | |
| cc-types | | | | | | | — | | | | | | | | | | |
| cc-events | | ✔ | | | | | ✔ | — | | | | | | | | | |
| cc | ✔ | | ✔ | | | | | | — | | | | | ✔ | | ✔ | |
| sse | | ✔ | | | | | | ✔ | | — | ✔ | | | | | | |
| errors | | | | | | | | | | | — | | | | | | |
| proxy-handler | | ✔ | | ✔ | | | | | ✔ | | ✔ | — | | | ✔ | | |
| openai | | ✔ | ✔ | ✔ | ✔ | ✔ | | ✔ | ✔ | ✔ | ✔ | ✔ | | | | | |
| anthropic | | ✔ | ✔ | ✔ | ✔ | ✔ | | ✔ | ✔ | ✔ | ✔ | ✔ | | | | | |
| models | ✔ | ✔ | ✔ | ✔ | ✔ | | | | | | | | — | | | ✔ | |
| session | | ✔ | ✔ | | | | | | | | | | | — | ✔ | | |
| fingerprint | ✔ | ✔ | ✔ | | | | | | | | | | | | — | ✔ | |
| version | | ✔ | | | | | | | | | | | | | | — | |

被依赖次数（反向入度，衡量核心度）：config×6 · logger×10 · util×6 · http×5 · errors×4 · cc×3 · cc-events×3 · sse×2 · proxy-handler×2 · version×4 · fingerprint×2 · session×2 · auth×3 · runtime×2 · models×1 · cc-types×1。

> 观察要点：
> 1. `config` / `logger` / `util` 为全局地基，被广泛引用；
> 2. `cc-types` 与 `errors` 是零依赖叶子，适合单独测试；
> 3. `openai.ts` 与 `anthropic.ts` 的导入面几乎相同（10 个共享模块），仅 anthropic 额外承担协议转换；
> 4. 无循环依赖：依赖方向严格按 入口 → 协议 → 管道 → 上游 → 基础设施 分层。

---

*本报告由全量源码扫描生成；行号对应当前工作区版本。*





