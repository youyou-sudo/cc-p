# 模块报告：src/cc-events.ts（CC NDJSON 解析器）

| 属性 | 值 |
|---|---|
| 路径 | `src/cc-events.ts` |
| 行数 | 96 |
| 层级 | 共享管道 |
| 依赖 | `./logger`(log)；`./cc-types`(CcErrorEvent, CcEventType) |
| 被依赖 | openai（非流式分支）、anthropic（非流式 + 流式翻译器）、sse（流式翻译器） |

## 职责

上游 `/alpha/generate` 返回的是逐行 JSON（NDJSON）。本模块是**唯一的行切分 / JSON 解析 / 事件分发实现**，消除了原本四个协议文件里重复的事件 switch；协议层只需注册 `CcEventHooks`。

## 代码段映射

| 行号 | 符号 | 说明 |
|---|---|---|
| 15-24 | `CC_EVENT_TYPES` | 17 种合法事件名集合。解析器只对**不在集合内**的类型告警——上游新增事件类型时在此补一行即可，无需改四个消费方 |
| 26 | `CcEventHook` | `(event) => string[] \| string \| void`：返回值即待发送的 SSE 片段（翻译器模式）或 void（纯聚合模式） |
| 27-29 | `CcEventHooks` | 事件名→钩子 表；`default(type,event)` 为未知类型兜底 |
| 31-101 | `CcStreamParser` | 解析器类（下详） |
| 32 | `.lastCcEvent` | 最近事件类型：用于断连/超时日志的 `lastCcEvent` 诊断字段，及 openai 断连原因分类（tool-input*/含 delta） |
| 33 | `.errorEvent` | 最近一次 error 事件记账 |
| 34 | `.unknownEvent` | 最近未知类型记账 |
| 36-37 | `.buffer` / `MAX_LINE_LENGTH` | 行缓冲区；单行上限 64KB，超过自动清空（防止内存攻击） |
| 43-54 | `.push(bytes, hooks)` | TextDecoder 流式解码 → 检查行长度限制 → 按 `\n` 切行（残余留 buffer）→ 逐行 handleLine → 返回输出片段数组 |
| 52-59 | `.flush(hooks)` | 流末尾冲刷残余行 |
| 61-95 | `.handleLine(line, hooks, out)` | 核心分发（下详） |

## handleLine 处理顺序

1. 空行 / `[DONE]` / `:` 开头（SSE 注释）→ 跳过；
2. `JSON.parse` 失败 → 静默跳过（容忍上游噪声）；
3. 无 `type` 字段 → 跳过；更新 `lastCcEvent`；
4. `type === 'error'` → 记入 `errorEvent` 并调用 `hooks.error`（**优先**，错误事件不参与普通分发）；
5. 有注册钩子 → 调用并收集返回片段；
6. 无钩子但在 `CC_EVENT_TYPES` 内 → 安全 no-op；
7. 完全未知 → 记 `unknownEvent`，调用 `hooks.default` 或 `log('warn','Unknown CC event type')`。

## 两种消费模式

- **聚合模式**（openai/anthropic 非流式）：钩子返回 void，闭包变量累积文本/usage，最终一次性产出响应体。
- **翻译模式**（sse.createSseTranslator / anthropic.createAnthropicSseTranslator）：钩子返回 SSE 字符串（或数组），由 parser 收集后交给发送管道。
