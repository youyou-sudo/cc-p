# 模块报告：src/logger.ts（日志）

| 属性 | 值 |
|---|---|
| 路径 | `src/logger.ts` |
| 行数 | 16 |
| 层级 | 基础设施 |
| 依赖 | `./config`(CFG)；`node:fs/promises`(appendFile) |
| 被依赖 | cc-events、sse、proxy-handler、openai、anthropic、models、session、fingerprint、version、index（全项目日志统一出口，10 个消费方） |

## 代码段映射

| 行号 | 符号 | 说明 |
|---|---|---|
| 4 | `LogLevel` | 对外允许 `'info' \| 'warn' \| 'error'`（debug 仅供内部阈值表使用） |
| 6 | `LEVEL_RANK` | debug:0 < info:1 < warn:2 < error:3 |
| 8-16 | `log(level, msg, data?)` | 见下 |

## log() 行为细节

1. **阈值过滤**：`LEVEL_RANK[level] < LEVEL_RANK[CFG.logLevel]`（未知级别回退 info）即丢弃。
2. **行格式**：`[ISO8601] [level] msg {data-json}`；data 为 `Record<string, unknown>` 可选。
3. **双写**：console.log + 可选文件追加。
4. **文件写失败静默**：`appendFile(...).catch(() => {})`——日志永不让请求失败。

## 使用约定（全项目）

- `log('warn', ...)` 用于可恢复异常：上游 fetch 失败、指纹上报失败、未知事件类型、客户端断连、空闲超时。
- `log('error', ...)` 用于流式/请求级失败：CC API 非 2xx、上游异常。
- `log('info', ...)` 用于启动信息、会话创建、清理统计、版本刷新成功等。
- 诊断字段命名惯例：`path / model / elapsedMs / bytesReceived / lastCcEvent / timeoutMs` 等，见各 handler 超时与断连日志。
