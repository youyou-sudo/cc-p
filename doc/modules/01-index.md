# 模块报告：src/index.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/index.ts` |
| 行数 | 79 |
| 层级 | 入口层 |
| 依赖 | `./shared/config`(CFG) `./shared/logger`(log) `./modules/models/catalog`(MODELS) `./infra/session`(startSessionCleanup) `./shared/version`(startVersionRefresh) `./app`(createApp) |
| 被依赖 | `test/e2e.ts`、`test/timeouts.ts`（`await import('../src/index.ts')`）；另外 `package.json` 的 `start`/`dev`/`build` 脚本以此为入口 |

## 职责

- 启动两个后台任务：`startVersionRefresh()`（CC 版本刷新）与 `startSessionCleanup()`（会话清理）。
- 通过 `createApp()` 组装应用并 `.listen()` 在 `CFG.port`/`CFG.host` 上。
- 打印启动日志、以及未配置兜底 Key（`CC_API_KEY`）时的告警。
- 提供 `healthcheck` CLI 子命令（GET `/health` 自检）与进程级 `unhandledRejection` 兜底。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-6 | — | import | — | `./shared/config`(CFG) `./shared/logger`(log) `./modules/models/catalog`(MODELS) `./infra/session`(startSessionCleanup) `./shared/version`(startVersionRefresh) `./app`(createApp) |
| 8-37 | `startServer` | 函数 | E | 启动主流程：拉起后台任务、创建并监听 app、输出启动日志 |
| 9 | └ `startVersionRefresh()` | 逻辑 | P | 启动 CC 版本刷新后台任务 |
| 10 | └ `startSessionCleanup()` | 逻辑 | P | 启动会话清理后台任务 |
| 12-13 | └ `createApp().listen()` | 逻辑 | P | 监听 `{ port: CFG.port, hostname: CFG.host }` |
| 15-30 | └ 启动日志 | 逻辑 | P | 打印 url/api/models 数量/CORS 策略/session/ZDR/emptySystemPlaceholder/logFile |
| 32-34 | └ 无兜底 Key 告警 | 逻辑 | P | `CFG.apiKey` 为空时提示请求须带 `Authorization: Bearer` 或 `x-api-key` |
| 39-61 | `healthcheck` | 异步函数 | E | GET `http://127.0.0.1:{PORT\|CFG.port}/health`，5s 超时；失败 `process.exit(1)`，成功 `exit(0)` |
| 63-72 | unhandledRejection 监听 | 逻辑 | P | `AbortError`/`ABORT_ERR` 记 info；其余记 error（message+stack 首行） |
| 74-79 | CLI 分派 | 逻辑 | P | `process.argv[2]==='healthcheck'` → `healthcheck()`，否则 `startServer()` |

## 关键行为

- **启动顺序固定**（L9-13）：先拉起 `startVersionRefresh`/`startSessionCleanup`，再 `createApp().listen()`；app 单独由 `src/app.ts` 组装。
- **端口解析**（L40）：`healthcheck` 用 `Number(process.env.PORT) || CFG.port`，与 listen 的 `CFG.port` 可能因环境变量而不同，但默认一致。
- **健康判定严格**（L49-53）：不仅要求 `res.ok`，还要求响应体 `body.ok === true`，否则 exit(1)。
- **CORS 三态日志**（L19-23）：有 `CFG.apiKey` 时描述为受限（浏览器仅来自 `CFG.corsAllowOrigin`，未设则禁用 CORS）；无 Key 且有 origin 为允许该 origin；其余为 open。
- **入口副作用**（L74-79）：模块被 import 即执行 CLI 分派并启动服务；测试通过 `await import('../src/index.ts')` 启动。
