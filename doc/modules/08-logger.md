# 模块报告：src/shared/logger.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/shared/logger.ts` |
| 行数 | 16 |
| 层级 | 基础设施层 |
| 依赖 | `./config`、`node:fs/promises` |
| 被依赖 | `src/index.ts`、`src/infra/session.ts`、`src/infra/proxy-handler.ts`、`src/infra/fingerprint.ts`、`src/infra/cc-events.ts`、`src/modules/chat/handler.ts`、`src/modules/chat/translator.ts`、`src/modules/models/catalog.ts`、`src/modules/messages/handler.ts`、`src/modules/messages/translator.ts` |

## 职责

- 提供全局 `log(level, msg, data?)`，按 `CFG.logLevel` 阈值过滤后输出。
- 输出格式固定为 `[ISO 时间] [level] msg {JSON}`，同时写控制台与可选的日志文件。
- 级别仅支持 `info` / `warn` / `error`，内部另建 debug=0 的 rank 以支持阈值比较。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | import | — | `CFG`（`./config`）；`appendFile`（`node:fs/promises`） |
| 4 | `LogLevel` | type | E | `'info' \| 'warn' \| 'error'` 三级别联合 |
| 6 | `LEVEL_RANK` | 常量 | P | `{ debug:0, info:1, warn:2, error:3 }`，供阈值过滤，debug 可用于调低 `LOG_LEVEL` |
| 8-16 | `log` | 函数 | E | 见关键行为 |

## 关键行为

- **阈值过滤**（9-10）：`threshold = LEVEL_RANK[CFG.logLevel] ?? LEVEL_RANK.info`；`LEVEL_RANK[level] < threshold` 直接 return。
- **行格式**（11）：`[${new Date().toISOString()}] [${level}] ${msg}`，`data` 存在时追加 `' ' + JSON.stringify(data)`。
- **双通道输出**（12-15）：始终 `console.log(line)`；`CFG.logFile` 非空时异步 `appendFile(..., 'utf-8')` 追加换行，错误被 `.catch(() => {})` 吞掉，不阻塞调用方。
- **易错点**：文件写入是 fire-and-forget（第 14 行），进程异常退出时可能丢尾部日志；`LogLevel` 类型不含 debug，但阈值表含 debug，配置 `LOG_LEVEL=debug` 可放行全部级别。
