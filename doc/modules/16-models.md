# 模块报告：src/models.ts（/v1/models）

| 属性 | 值 |
|---|---|
| 路径 | `src/models.ts` |
| 行数 | 94 |
| 层级 | 协议层 |
| 依赖 | config、logger、version、auth、util、http |
| 被依赖 | index（路由挂载；启动日志读取 MODELS.length） |

## 代码段映射

| 行号 | 符号 | 说明 |
|---|---|---|
| 8-11 | `ModelEntry` | `{id, name}` |
| 13-40 | `MODELS` | 内置模型 27 项：Claude Sonnet 4.6 / Opus 4.8 / Opus 4.7 / Haiku 4.5；GPT-5.5 / 5.4 / 5.4-mini / 5.3-codex；DeepSeek V4 Pro/Flash；Kimi K2.6/K2.5；GLM 5.1/5；MiniMax M3/M2.7/M2.5；Qwen3.6-Max-Preview/3.6-Plus/3.7-Max；Step 3.7/3.5 Flash；MiMo V2.5 Pro/V2.5；Gemini 3.5 Flash/3.1 Flash Lite |
| 42-43 | `dynamicModels` / `modelsLastFetch` | 模块级缓存（首次 null）与时间戳 |
| 45-79 | `fetchModels(apiKey?)` | 见下 |
| 81-94 | `handleModels(headers)` | 路由处理器 |

## fetchModels 逻辑

1. 缓存未过期（`now - modelsLastFetch < CFG.modelRefreshIntervalMs`）→ 直接返回缓存。
2. 无 apiKey 或 `CFG.useProviderModels === false` → 抛错进入回退（不发请求）。
3. GET `${CFG.apiBase}/provider/v1/models`，头：Bearer key + `x-cli-environment: production` + `x-command-code-version`；`AbortSignal.timeout(10000)`。
4. 响应 ok 且 `data` 为数组 → `data.data.map(m => ({id: m.id, name: m.id}))` → 写缓存 → 返回。
5. 任何失败（!ok / 异常）→ `log('warn', ...)` → 返回内置 `MODELS`。

## handleModels 逻辑

`getApiKey(headers)` → `fetchModels` → OpenAI list 形状：`{object:'list', data:[{id, object:'model', created: nowUnix(), owned_by:'command-code'}]}`。

## 注意点

- 缓存 key 不区分 apiKey：第一个成功拉取的 key 的结果对全体共享（TTL 内）。
- 该端点不强制鉴权：未带 key 时回退内置列表照样可用（供客户端发现模型）。
- 默认模型回退值 `deepseek/deepseek-v4-flash` 与 cc.ts 中 params.model 缺省一致。
