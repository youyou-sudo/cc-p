# 模块报告：src/modules/models/catalog.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/models/catalog.ts` |
| 行数 | 159 |
| 层级 | 协议层 |
| 依赖 | `../../shared/config`、`../../shared/logger`、`../../shared/version`、`../../shared/auth`、`../../shared/util`、`../../shared/http` |
| 被依赖 | `src/modules/models/service.ts`、`src/index.ts` |

## 职责

- 维护内置模型清单 `MODELS`（26 项）及其静态 `context_window` 索引。
- `fetchModels`：带 TTL 缓存，优先从 Provider API 动态拉取模型，失败回退内置列表。
- `handleModels`：把模型列表组装为 OpenAI list 形状的 `GET /v1/models` 响应。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-7 | — | import | — | `../../shared/config`(CFG) / `logger`(log) / `version`(CC_VERSION) / `auth`(getApiKey) / `util`(nowUnix) / `http`(sendJSON) / `model-windows`(contextWindowFor) |
| 9-14 | `ModelEntry` | interface | E | `{ id, name, context_window?, max_output_tokens? }` |
| 20-25 | `EXPOSED_WINDOW_IDS` | 常量 | P | 记录哪些 id 的 `context_window` 够确认、可以对外暴露（12 个）。**只管暴露与否，数值在 `shared/model-windows.ts`** |
| 27-51 | `MODELS_BASE` | 常量 | E | 内置模型 26 项（不含 `context_window`）：Claude Sonnet 4.6/Opus 4.8/4.7/Haiku 4.5；GPT-5.5/5.4/5.4-mini/5.3-codex；DeepSeek V4 Pro/Flash；Kimi K2.6/2.5；GLM 5.1/5；MiniMax M3/M2.7/M2.5；Qwen3.6-Max-Preview/3.6-Plus/3.7-Max；Step3.7/3.5 Flash；MiMo V2.5 Pro/V2.5；Gemini 3.5 Flash/3.1 Flash Lite |
| 55-63 | `MODELS` | 常量 | E | `MODELS_BASE` 映射：对 `EXPOSED_WINDOW_IDS` 中的 id 从 `contextWindowFor()` 取值挂上，其余省略该字段。**id 与顺序不变，对外输出与此前逐字一致** |
| 65-69 | `toOptionalNumber` | 函数 | P | 把 `undefined`/`null`/`''` 归一为 `undefined`，否则 `Number`，非有限数返回 `undefined` |
| 71-73 | `pickContextWindow` | 函数 | P | 依次取 `context_window` → `context_length` → `max_context_tokens` |
| 75-77 | `pickMaxOutputTokens` | 函数 | P | 依次取 `max_output_tokens` → `max_tokens` |
| 79-81 | `STATIC_WINDOW_BY_ID` | 常量 | P | 由 `MODELS` 中已声明 `context_window` 的项构建的 `Map<id, number>`（即 12 个暴露项的快照） |
| 83-84 | `dynamicModels` / `modelsLastFetch` | 字段 | P | 模块级缓存（初始 null）与上次拉取时间戳 |
| 86-128 | `fetchModels` | 异步函数 | E | 见关键行为 |
| 87-90 | └ 缓存判定 | 逻辑 | P | `dynamicModels` 存在且 `now - modelsLastFetch < CFG.modelRefreshIntervalMs` → 直接返回缓存 |
| 92-93 | └ 禁用守卫 | 逻辑 | P | 无 `apiKey` 或 `!CFG.useProviderModels` → 抛错进入回退，不发请求 |
| 95-102 | └ 上游请求 | 逻辑 | P | GET `${CFG.apiBase}/provider/v1/models`；头 `Authorization: Bearer <key>`、`x-cli-environment: production`、`x-command-code-version: CC_VERSION`；`AbortSignal.timeout(10000)` |
| 84-100 | └ 成功映射 | 逻辑 | P | `response.ok` 且 `data.data` 为数组时逐项映射 |
| 107-115 |   └ 条目构造 | 逻辑 | P | `id`/`name` 均取 `m.id`；`context_window` 优先上游值，缺省查 `STATIC_WINDOW_BY_ID`；`max_output_tokens` 有值才写入；仍为 `undefined` 的 `context_window` 删除 |
| 116-119 |   └ 写缓存 | 逻辑 | P | 写入 `dynamicModels`/`modelsLastFetch` 并 `log('info', ...)` |
| 122-125 | └ 失败回退 | 逻辑 | P | 非 ok 或异常 → `log('warn', ...)`，落入返回内置列表 |
| 127 | └ 返回值 | 逻辑 | P | 回退返回 `MODELS` |
| 130-159 | `handleModels` | 异步函数 | E | `getApiKey(headers)` → 判定来源 → `await fetchModels(apiKey)` → `sendJSON(200, ...)` |
| 133 | └ 来源判定 | 逻辑 | P | 在 await **之前** 记 `hadCache`；`models === MODELS` → `'fallback'`，否则 `hadCache` → `'cache'`，否则 `'provider'` |
| 138-147 | └ 落日志 | 逻辑 | P | `log('info', 'Models list served', { source, count, keyPrefix, cacheAgeMs })` |

## 关键行为

- **`context_window` 已并入唯一权威表**（20-25、55-63）：本文件此前自己维护一份数值，
  与 `shared/model-windows.ts` 在 12 个共有 id 上**全部冲突**。现在数值只在
  `model-windows.ts`，本文件的 `EXPOSED_WINDOW_IDS` 只决定「哪些 id 够确认、可以暴露」。
  **对外输出逐字未变**（12 个暴露项、id 与顺序均不变），由 `test/logging.ts` 第 8 组固定。
- 缓存 TTL 判定在 88 行；缓存 key 不区分 `apiKey`，首个成功拉取的结果在 TTL 内对全体请求共享。
- 上游请求使用 `AbortSignal.timeout(10000)`（101 行），10s 超时即回退。这也是
  `/v1/models` 不受传输层 `idleTimeout` 影响的原��。
- 上游字段别名兼容：`context_length`/`max_context_tokens`（72 行）、`max_tokens`（76 行）会被归一。
- 映射时静态窗口只作兜底：上游有值优先，否则查 `STATIC_WINDOW_BY_ID`；仍无值则删除字段（110、113 行）。
- **来源可观测**（133-147）：此前缓存命中直接 return 无日志，唯一的信号是 `fetchModels` 内部两条 warn —— 而缓存命中会跳过它们。客户端报「我的模型不见了」时，无法区分是缓存过期还是真没有。现每次服务都记 `provider`/`cache`/`fallback` 与 `cacheAgeMs`。
  - 判定必须在 await 前取 `hadCache`：fallback 路径返回的就是 `MODELS` 本身，事后做引用比较会把「首次 fallback」误判为 cache（这是实现时踩到的坑）
  - `cacheAgeMs` 用 `Date.now()` 而非 `nowUnix()`：后者返回整秒，混用单位会得到负值
- `handleModels` 响应形状（149-158）：`{ object: 'list', data: [{ id, object: 'model', created: nowUnix(), owned_by: 'command-code', ...(context_window 有值时带) }] }`。
- 该端点不强制鉴权：未带 key 时 `fetchModels` 抛错回退内置列表，仍返回 200，供客户端发现模型。
