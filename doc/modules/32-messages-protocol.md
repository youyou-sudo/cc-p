# 模块报告：src/modules/messages/protocol.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/messages/protocol.ts` |
| 行数 | 5 |
| 层级 | 协议层 |
| 依赖 | `./handler`、`./translator`、`./aggregator` |
| 被依赖 | `src/modules/messages/service.ts` |

## 职责

- 纯 re-export 门面：把 handler 的请求生命周期、translator 的协议转换、aggregator 的聚合结果统一从一个入口暴露。
- 不含任何运行时逻辑或状态，供 service 与单测稳定引用路径。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | `handleMessages`、`handleMessagesBody` | 导出 | E | ← `./handler` |
| 2 | `convertAnthropicToOpenAI`、`createAnthropicSseTranslator`、`fakeThinkingSignature` | 导出 | E | ← `./translator` |
| 3 | `AnthropicStreamContext` | 类型 | E | type-only ← `./translator` |
| 4 | `buildAnthropicResponse`、`createMessagesAggregator`、`rawUsageFromCcUsageAnthropic` | 导出 | E | ← `./aggregator` |
| 5 | `MessagesAggregate` | 类型 | E | type-only ← `./aggregator` |

## 关键行为

- 本文件是模块内唯一公共出口；`service.ts:8-16` 与潜在单测均从此取符号，替换实现只需改这里的来源。
- 无副作用、无循环依赖：依赖方向 handler/translator/aggregator → protocol → service → index。
