# 模块报告：src/index.ts（服务入口）

| 属性 | 值 |
|---|---|
| 路径 | `src/index.ts` |
| 行数 | 117 |
| 层级 | 入口层 |
| 依赖 | elysia；`./config` `./http` `./logger` `./anthropic` `./models` `./openai` `./session` `./version` |
| 被依赖 | 无（唯一入口；Docker CMD 与测试均从这里启动） |

## 职责

1. 启动时先拉起两个后台任务：`startVersionRefresh()`（CC 版本 24h 刷新）与 `startSessionCleanup()`（会话每小时清理）。
2. 创建 Elysia 应用并注册全部路由与全局错误处理。
3. 提供 `healthcheck` CLI 子命令（Docker HEALTHCHECK 调用）。
4. 进程级 `unhandledRejection` 兜底。

## 代码段映射

| 行号 | 符号/段落 | 说明 |
|---|---|---|
| 11-16 | `jsonResponse(status, body)` | 私有辅助：JSON Response |
| 18-75 | `startServer()` | 主启动流程（下详） |
| 23-28 | onRequest 钩子 | 所有请求注入 CORS_HEADERS；OPTIONS 直接 204（配合 SSE_HEADERS 覆盖下游） |
| 29 | GET `/` | 文本 `OK` 探针 |
| 30 | GET `/health` | `{ok:true}`（healthcheck 子命令消费） |
| 31 | GET `/v1/models` | → `handleModels(headers)` |
| 32 | POST `/v1/chat/completions` | → `handleChatCompletions(request, headers)` |
| 33 | POST `/v1/messages` | → `handleMessages(request, headers)` |
| 34-51 | onError | 404 → not_found；413/PARSE/VALIDATION → 413 或 400（`/v1/messages` 用 Anthropic 错误形状 `{type:'error',...}`，其余用 OpenAI 形状）；其余 → 500 internal_error（透传 error.status/message） |
| 52 | `.listen()` | `{port: CFG.port, hostname: CFG.host}` |
| 54-68 | 启动日志 | url/api/models 数量/CORS 策略描述/会话策略（12h+1h jitter）/ZDR 状态/日志文件 |
| 70-72 | 无兜底 Key 告警 | 未设 CC_API_KEY 时提示必须按请求携带 Key |
| 77-99 | `healthcheck()` | GET `http://127.0.0.1:{PORT|CFG.port}/health`，5s 超时；非 ok / body.ok!==true → exit(1)，成功 exit(0) |
| 101-110 | unhandledRejection | AbortError/ABORT_ERR → info「已清理」；其余 error 日志（message+stack 首行） |
| 112-117 | CLI 分派 | `argv[2]==='healthcheck'` → healthcheck；否则 startServer |

## 关键行为

- **CORS 双态**：见 `doc/modules/06-http.md`——无兜底 Key 时 `*`，有兜底 Key 且未显式配置时 `'null'`（拒绝浏览器跨域）。
- **错误形状自适应**：`/v1/messages` 路径的解析类错误返回 Anthropic 顶层 `{type:'error'}`，其余返回 OpenAI `{error:{...}}`，保证客户端 SDK 能正确解析。
- **顶层 await 可行性**：`./config` 使用顶层 `await loadConfig()`，Bun 原生支持，因此 CFG 在任何路由前已就绪。
