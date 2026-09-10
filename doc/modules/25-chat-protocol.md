# 模块报告：src/modules/chat/protocol.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/chat/protocol.ts` |
| 行数 | 5 |
| 层级 | 协议层 |
| 依赖 | `./handler`、`./translator`、`./aggregator` |
| 被依赖 | `src/modules/chat/service.ts`（动态 `import('./protocol')`） |

## 职责

- 公共 re-export 门面：把 handler / translator / aggregator 的对外符号聚合为单一入口。
- 为 `ChatService` 的动态导入提供稳定模块边界。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | `handleChatCompletions`、`handleChatCompletionsBody` | 重导出 | E | from `./handler` |
| 2 | `createSseTranslator`、`zeroUsageChunk` | 重导出 | E | from `./translator` |
| 3 | `ChatStreamTranslator` | 重导出(type) | E | from `./translator` |
| 4 | `createChatAggregator`、`buildChatCompletion`、`rawUsageFromCcUsage` | 重导出 | E | from `./aggregator` |
| 5 | `ChatAggregate` | 重导出(type) | E | from `./aggregator` |

## 关键行为

- 纯门面，无自有运行时逻辑：不改写、不包装、不新增实现。
- `service.ts` 只从本文件取 `handleChatCompletions` / `handleChatCompletionsBody` 两个函数。
