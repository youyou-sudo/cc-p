# 模块报告：src/infra/cc-events.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/infra/cc-events.ts` |
| 行数 | 101 |
| 层级 | 共享管道层 |
| 依赖 | `../shared/logger`(log)；`../shared/cc-types`(type CcErrorEvent, CcEventType) |
| 被依赖 | `src/modules/chat/aggregator.ts`、`src/modules/chat/translator.ts`、`src/modules/messages/aggregator.ts`、`src/modules/messages/translator.ts` |

## 职责

- 上游 `/alpha/generate` 返回逐行 JSON（NDJSON），本模块是唯一的缓冲分行 / `JSON.parse` / 事件分发实现，消除各协议文件里重复的事件 switch。
- 各协议只注册 `CcEventHooks`：返回字符串则为待发送的 SSE 片段（翻译模式），返回 void 则仅做闭包聚合（聚合模式）。
- 维护「未知事件类型」告警与「收到 error 事件」的记账，供断连 / 超时诊断复用。
- 提供上游全部合法事件名的只读集合 `CC_EVENT_TYPES`，新增上游事件只需在此补一行。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 9-10 | — | import | — | `../shared/logger`(log)；`../shared/cc-types`(type CcErrorEvent, CcEventType) |
| 15-24 | `CC_EVENT_TYPES` | 常量 | E | 上游可发出的 17 种事件类型集合：`start`/`start-step`、`reasoning-*`、`text-*`、`tool-call`、`finish-step`/`finish`、`tool-input-*`/`tool-error`、`provider-metadata`、`error` |
| 26 | `CcEventHook` | type | E | `(event: any) => string[] \| string \| void`，返回值即待发送片段 |
| 27-29 | `CcEventHooks` | type | E | 按事件类型索引的钩子表；`default(type, event)` 为未知类型兜底 |
| 31-101 | `CcStreamParser` | class | E | NDJSON 流式解析器 |
| 32 | `lastCcEvent` | 字段 | P | 最近一次事件类型，供诊断日志与断连原因分类 |
| 33 | `errorEvent` | 字段 | P | 最近一次 `type:'error'` 事件记账 |
| 34 | `unknownEvent` | 字段 | P | 最近一次未知事件类型 |
| 36 | `buffer` | 字段 | P | 未完整行的缓冲区 |
| 37 | `MAX_LINE_LENGTH` | 字段 | P | 单行上限 `64 * 1024`（64KB），超过则清空缓冲防内存攻击 |
| 39 | `constructor` | 方法 | P | 注入 `TextDecoder`（默认实例） |
| 43-54 | `push(bytes, hooks)` | 方法 | P | 流式 decode → 超长清空 → 按 `\n` 切行，末段留 buffer → 逐行 `handleLine` → 返回输出片段数组 |
| 57-64 | `flush(hooks)` | 方法 | P | 流结束时冲刷残余行（`trim()` 为空则跳过） |
| 66-100 | `handleLine(line, hooks, out)` | 方法 | P | 核心分发逻辑（见关键行为） |

## 关键行为

- `handleLine` 顺序（66-100）：① `trim()` 后为空、`[DONE]`、`:` 开头（SSE 注释）→ 跳过（68）；② `JSON.parse` 失败 → 静默跳过（70-74）；③ 无 `type` → 跳过（75）；④ 更新 `lastCcEvent`（76）；⑤ `type === 'error'` 优先记账到 `errorEvent` 并调用 `hooks.error`，然后 `return`，不参与普通分发（78-86）；⑥ 命中普通钩子则调用并按 `Array.isArray` 收集返回片段（88-91）；⑦ 类型在 `CC_EVENT_TYPES` 内但无钩子 → 安全 no-op（92-94）；⑧ 完全未知 → 记 `unknownEvent`，优先 `hooks.default(type, event)`，否则 `log('warn', 'Unknown CC event type', ...)`（94-99）。
- `push` 在缓冲超 64KB 时直接 `buffer=''` 并返回空数组（45-48），会丢弃该批数据，属有意防护。
- 钩子返回可以是单条字符串或数组，统一由 `out.push(...)` 展开（83、91）；返回假值（空串/undefined）不产生输出。
