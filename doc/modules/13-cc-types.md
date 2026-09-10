# 模块报告：src/shared/cc-types.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/shared/cc-types.ts` |
| 行数 | 39 |
| 层级 | 基础设施层 · 纯类型 |
| 依赖 | 无（零依赖叶子模块） |
| 被依赖 | `src/infra/cc-events.ts` |

## 职责

- 定义 Command Code 上游 `/alpha/generate` 的 NDJSON 流事件线协议类型。
- 定义请求翻译所需的 `CcUsage` 用量形状。
- 提供全部事件接口的判别联合 `CcStreamEvent` 与其名字面量联合 `CcEventType`。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | 注释 | — | 说明本文件为 CC 线协议类型（流事件 + 请求体/usage 形状） |
| 4-9 | `CcUsage` | interface | E | `inputTokens?` / `outputTokens?` / `cachedInputTokens?` / `inputTokenDetails?.cacheWriteTokens?` |
| 11 | — | 注释 | — | `── NDJSON stream events ──` 分隔段 |
| 13 | `CcStartEvent` | interface | E | `{ type: 'start' }` |
| 14 | `CcStartStepEvent` | interface | E | `{ type: 'start-step' }` |
| 15 | `CcReasoningStartEvent` | interface | E | `{ type: 'reasoning-start' }` |
| 16 | `CcTextStartEvent` | interface | E | `{ type: 'text-start' }` |
| 17 | `CcTextEndEvent` | interface | E | `{ type: 'text-end' }` |
| 18 | `CcReasoningEndEvent` | interface | E | `{ type: 'reasoning-end' }` |
| 19 | `CcToolInputStartEvent` | interface | E | `{ type: 'tool-input-start' }` |
| 20 | `CcToolInputDeltaEvent` | interface | E | `{ type: 'tool-input-delta' }` |
| 21 | `CcToolInputEndEvent` | interface | E | `{ type: 'tool-input-end' }` |
| 22 | `CcToolErrorEvent` | interface | E | `{ type: 'tool-error' }` |
| 23 | `CcProviderMetadataEvent` | interface | E | `{ type: 'provider-metadata' }` |
| 25 | `CcTextDeltaEvent` | interface | E | `{ type: 'text-delta'; text?: string; delta?: string }`，双字段兼容上游历史格式 |
| 26 | `CcReasoningDeltaEvent` | interface | E | `{ type: 'reasoning-delta'; text?: string }` |
| 27 | `CcToolCallEvent` | interface | E | `{ type: 'tool-call'; toolCallId?; toolName?; input?: unknown }` |
| 28 | `CcFinishStepEvent` | interface | E | `{ type: 'finish-step'; finishReason?: string; usage?: CcUsage }` |
| 29 | `CcFinishEvent` | interface | E | `{ type: 'finish'; finishReason?: string; totalUsage?: CcUsage; usage?: CcUsage }` |
| 30 | `CcErrorEvent` | interface | E | `{ type: 'error'; error?: { message?; type? }; message?: string; retry_after?: number }` |
| 32-37 | `CcStreamEvent` | type（联合） | E | 上述 17 个事件接口的判别联合 |
| 39 | `CcEventType` | type | E | `CcStreamEvent['type']` 事件名字面量联合 |

## 关键行为

- 纯类型文件，**无运行时代码**，编译后不产生可执行逻辑；消费方一律使用 `import type`。
- 事件类型命名与上游 NDJSON 的 `type` 字段一一对应；协议层仅对关心的事件注册钩子，未知事件由解析器吞掉/告警。
- `CcErrorEvent.message` 可能带 `<NNN>` 状态码前缀（上游把 HTTP 状态编进流内），由 `src/shared/errors.ts` 的 `mapCcEventError` 解析（见 `14-errors.md`）。
- `CcFinishEvent` 同时携带 `totalUsage` 与 `usage`，聚合端需择一或累加，避免重复计数。
