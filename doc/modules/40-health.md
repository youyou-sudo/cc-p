# 模块报告：src/modules/health/index.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/health/index.ts` |
| 行数 | 12 |
| 层级 | 协议层 |
| 依赖 | `elysia` |
| 被依赖 | `src/app.ts` |

## 职责

- 提供根路径 `GET /`，返回纯文本 `OK`。
- 提供 `GET /health`，返回 JSON `{ ok: true }`，供启动 `healthcheck` 与容器探活使用。
- 内置本地 `jsonResponse` 辅助函数（不复用 `shared/http` 的 `sendJSON`）。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | — | import | — | `elysia` |
| 3-8 | `jsonResponse` | 函数 | P | `new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })` |
| 10-12 | `healthController` | 插件 | E | `new Elysia({ name: 'health', prefix: '' })` |
| 11 | └ `GET /` | 路由 | P | 返回 `new Response('OK', { headers: { 'Content-Type': 'text/plain' } })` |
| 12 | └ `GET /health` | 路由 | P | 返回 `jsonResponse(200, { ok: true })` |

## 关键行为

- `prefix: ''`（10 行）表示路由按绝对路径注册，`/` 与 `/health` 直接命中。
- `app.ts:17` 通过 `.use(healthController)` 挂载；`test/e2e.ts` 与 `test/timeouts.ts` 以 HTTP 请求方式验证 `/health`（200 + `{ok:true}`，服务存活探针）。
- `src/index.ts` 的 `healthcheck()` CLI 子命令请求 `/health` 并校验 `body.ok === true`，故该响应体形状是运维契约。
