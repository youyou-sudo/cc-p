# 模块报告：src/modules/models/catalog.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/models/catalog.ts` |
| 行数 | 124 |
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
| 1-6 | — | import | — | `../../shared/config`(CFG) / `logger`(log) / `version`(CC_VERSION) / `auth`(getApiKey) / `util`(nowUnix) / `http`(sendJSON) |
| 8-13 | `ModelEntry` | interface | E | `{ id, name, context_window?, max_output_tokens? }` |
| 15-43 | `MODELS` | 常量 | E | 内置模型 26 项：Claude Sonnet 4.6/Opus 4.8/4.7/Haiku 4.5；GPT-5.5/5.4/5.4-mini/5.3-codex；DeepSeek V4 Pro/Flash；Kimi K2.6/2.5；GLM 5.1/5；MiniMax M3/M2.7/M2.5；Qwen3.6-Max-Preview/3.6-Plus/3.7-Max；Step3.7/3.5 Flash；MiMo V2.5 Pro/V2.5；Gemini 3.5 Flash/3.1 Flash Lite。26 行 TODO 注记部分模型公开 context_window 待确认 |
| 45-49 | `toOptionalNumber` | 函数 | P | 把 `undefined`/`null`/`''` 归一为 `undefined`，否则 `Number`，非有限数返回 `undefined` |
| 51-53 | `pickContextWindow` | 函数 | P | 依次取 `context_window` → `context_length` → `max_context_tokens` |
| 55-57 | `pickMaxOutputTokens` | 函数 | P | 依次取 `max_output_tokens` → `max_tokens` |
| 59-61 | `STATIC_WINDOW_BY_ID` | 常量 | P | 由 `MODELS` 中已声明 `context_window` 的项构建的 `Map<id, number>` |
| 63-64 | `dynamicModels` / `modelsLastFetch` | 字段 | P | 模块级缓存（初始 null）与上次拉取时间戳 |
| 66-108 | `fetchModels` | 异步函数 | E | 见关键行为 |
| 67-70 | └ 缓存判定 | 逻辑 | P | `dynamicModels` 存在且 `now - modelsLastFetch < CFG.modelRefreshIntervalMs` → 直接返回缓存 |
| 72-73 | └ 禁用守卫 | 逻辑 | P | 无 `apiKey` 或 `!CFG.useProviderModels` → 抛错进入回退，不发请求 |
| 75-82 | └ 上游请求 | 逻辑 | P | GET `${CFG.apiBase}/provider/v1/models`；头 `Authorization: Bearer <key>`、`x-cli-environment: production`、`x-command-code-version: CC_VERSION`；`AbortSignal.timeout(10000)` |
| 84-100 | └ 成功映射 | 逻辑 | P | `response.ok` 且 `data.data` 为数组时逐项映射 |
| 87-95 |   └ 条目构造 | 逻辑 | P | `id`/`name` 均取 `m.id`；`context_window` 优先上游值，缺省查 `STATIC_WINDOW_BY_ID`；`max_output_tokens` 有值才写入；仍为 `undefined` 的 `context_window` 删除 |
| 96-99 |   └ 写缓存 | 逻辑 | P | 写入 `dynamicModels`/`modelsLastFetch` 并 `log('info', ...)` |
| 102-105 | └ 失败回退 | 逻辑 | P | 非 ok 或异常 → `log('warn', ...)`，落入返回内置列表 |
| 107 | └ 返回值 | 逻辑 | P | 回退返回 `MODELS` |
| 110-123 | `handleModels` | 异步函数 | E | `getApiKey(headers)` → `await fetchModels(apiKey)` → `sendJSON(200, ...)` |

## 关键行为

- 缓存 TTL 判定在 68 行；缓存 key 不区分 `apiKey`，首个成功拉取的结果在 TTL 内对全体请求共享。
- 上游请求使用 `AbortSignal.timeout(10000)`（81 行），10s 超时即回退。
- 上游字段别名兼容：`context_length`/`max_context_tokens`（52 行）、`max_tokens`（56 行）会被归一。
- 映射时静态窗口只作兜底：上游有值优先，否则查 `STATIC_WINDOW_BY_ID`；仍无值则删除字段（90、93 行）。
- `handleModels` 响应形状（114-123）：`{ object: 'list', data: [{ id, object: 'model', created: nowUnix(), owned_by: 'command-code', ...(context_window 有值时带) }] }`。
- 该端点不强制鉴权：未带 key 时 `fetchModels` 抛错回退内置列表，仍返回 200，供客户端发现模型。
