# 模块报告：src/cc-types.ts（CC 线协议类型）

| 属性 | 值 |
|---|---|
| 路径 | `src/cc-types.ts` |
| 行数 | 39 |
| 层级 | 基础设施（纯类型，无运行时代码） |
| 依赖 | 无 |
| 被依赖 | cc-events |

## 代码段映射

| 行号 | 符号 | 字段要点 |
|---|---|---|
| 4-9 | `CcUsage` | `inputTokens?` / `outputTokens?` / `cachedInputTokens?` / `inputTokenDetails?.cacheWriteTokens?` |
| 13 | `CcStartEvent` | `{type:'start'}` |
| 14 | `CcStartStepEvent` | `{type:'start-step'}` |
| 15 | `CcReasoningStartEvent` | `{type:'reasoning-start'}` |
| 16 | `CcTextStartEvent` | `{type:'text-start'}` |
| 17 | `CcTextEndEvent` | `{type:'text-end'}` |
| 18 | `CcReasoningEndEvent` | `{type:'reasoning-end'}` |
| 19 | `CcToolInputStartEvent` | `{type:'tool-input-start'}` |
| 20 | `CcToolInputDeltaEvent` | `{type:'tool-input-delta'}` |
| 21 | `CcToolInputEndEvent` | `{type:'tool-input-end'}` |
| 22 | `CcToolErrorEvent` | `{type:'tool-error'}` |
| 23 | `CcProviderMetadataEvent` | `{type:'provider-metadata'}` |
| 25 | `CcTextDeltaEvent` | `{type:'text-delta'; text?/delta?}`——双字段兼容上游历史格式 |
| 26 | `CcReasoningDeltaEvent` | `{type:'reasoning-delta'; text?}` |
| 27 | `CcToolCallEvent` | `{type:'tool-call'; toolCallId?/toolName?/input?}`——input 可能是对象或字符串 |
| 28 | `CcFinishStepEvent` | `{type:'finish-step'; finishReason?/usage?}` |
| 29 | `CcFinishEvent` | `{type:'finish'; finishReason?/totalUsage?/usage?}` |
| 30 | `CcErrorEvent` | `{type:'error'; error?{message,type}/message?/retry_after?}`——错误消息可能带 `<NNN>` 状态码前缀 |
| 32-37 | `CcStreamEvent` | 全部事件判别联合 |
| 39 | `CcEventType` | `CcStreamEvent['type']`——驱动 `CC_EVENT_TYPES` 集合与 hooks 表类型 |

## 设计说明

- 事件类型命名与上游 NDJSON 的 `type` 字段一一对应；协议层（openai/anthropic/sse）只注册自己关心的钩子，其余事件由 `CcStreamParser` 按 `CC_EVENT_TYPES` 白名单静默吞掉。
- `error` 事件的消息前缀 `<429>` 等是上游把 HTTP 状态编码进流内的约定，由 `errors.mapCcEventError` 解析。
