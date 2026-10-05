# 模块报告：src/shared/logger.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/shared/logger.ts` |
| 行数 | 60 |
| 层级 | 基础设施层 |
| 依赖 | `./config`、`node:fs/promises` |
| 被依赖 | `src/index.ts`、`src/app.ts`（经 `plugins/access.ts`）、`src/infra/session.ts`、`src/infra/proxy-handler.ts`、`src/infra/fingerprint.ts`、`src/infra/cc-events.ts`、`src/shared/http.ts`、`src/shared/runtime.ts`、`src/plugins/access.ts`、`src/plugins/auth.ts`、`src/plugins/body.ts`、`src/modules/chat/handler.ts`、`src/modules/chat/translator.ts`、`src/modules/models/catalog.ts`、`src/modules/messages/handler.ts`、`src/modules/messages/translator.ts` |

## 职责

- 提供全局 `log(level, msg, data?)`，按 `CFG.logLevel` 阈值过滤后输出。
- 输出格式固定为 `[ISO 时间] [level] msg {JSON}`，同时写控制台与可选的日志文件。
- 级别仅支持 `info` / `warn` / `error`，内部另建 debug=0 的 rank 以支持阈值比较。
- **文件写入失败必须可见**：限频上报到 `console.error`，避免日志静默消失。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | import | — | `CFG`（`./config`）；`appendFile`（`node:fs/promises`） |
| 4 | `LogLevel` | type | E | `'info' \| 'warn' \| 'error'` 三级别联合 |
| 6 | `LEVEL_RANK` | 常量 | P | `{ debug:0, info:1, warn:2, error:3 }`，供阈值过滤 |
| 8-11 | — | 逻辑 | — | 注释：为何限频（不限频则上报本身成为洪流）、为何状态是模块级（描述目的地而非请求） |
| 12 | `WRITE_ERROR_REPORT_MS` | 常量 | P | 60000 —— 写失败上报的限频窗口 |
| 13-16 | 写失败模块级状态 | 状态 | P | `lastWriteErrorAt` / `lastWriteError` / `writeErrorSuppressed` / `totalWriteErrors` |
| 18-40 | `reportWriteFailure` | 函数 | P | 限频上报：窗口内只累加，窗口外打印一条并带上累计总数与被抑制数 |
| 42-44 | `logFileWriteError` | 函数 | E | 返回 `{message, suppressed, total}`，供诊断与测试 |
| 46-60 | `log` | 函数 | E | 见关键行为 |

## 关键行为

- **阈值过滤**（47-48）：`threshold = LEVEL_RANK[CFG.logLevel] ?? LEVEL_RANK.info`；`LEVEL_RANK[level] < threshold` 直接 return。
- **行格式**（44）：`[${new Date().toISOString()}] [${level}] ${msg}`，`data` 存在时追加 `' ' + JSON.stringify(data)`。
- **双通道输出**（50、52-59）：始终 `console.log(line)`；`CFG.logFile` 非空时异步 `appendFile(..., 'utf-8')` 追加换行，不阻塞调用方。
- **写失败上报**（18-40）：`appendFile` 失败此前被 `.catch(() => {})` 吞掉 —— 磁盘满、权限撤销或路径错误会让每一行日志无声消失，恰好在你依赖它排查时不可见。现改为：
  - 走 `console.error` 而**非** `log()`：经 `log()` 会重入正在失败的 `appendFile`；console 是已知可用的唯一出口
  - 60s 限频并附累计总数：不限频则每一行日志都产生一次新失败，上报本身成为它本要诊断的洪流
  - 写入成功时清零 `writeErrorSuppressed`（55-57），使后续不同的失败能报告各自积压量
- **易错点**：文件写入仍是 fire-and-forget（52），进程异常退出可能丢尾部日志；`LogLevel` 不含 debug 但阈值表含 debug，配置 `LOG_LEVEL=debug` 可放行全部级别。

## 覆盖测试

`test/logging.ts` 第 6 组（`logfile:` 前缀，8 项断言），写失败场景在子进程 `test/_logging-writefail-child.ts` 中验证 —— `CFG.logFile` 在 config 加载时快照，进程内无法更改。
