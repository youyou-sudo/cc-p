# 模块报告：src/shared/context.ts

| 项 | 值 |
|---|---|
| 文件 | `src/shared/context.ts` |
| 行数 | 124 |
| 层级 | 基础设施层（⚠ **已实现未接线**） |
| 导入 | `./model-windows`(contextWindowFor) |
| 导入方 | **无**。全仓无任何文件 import 本模块（`model-windows` 亦仅被本模块引用）。 |

## 职责

子代理上下文护栏：粗粒度估算请求体 token 数，对照模型上下文窗口给出
warn / exceed 判定，并提供工具输出截断。刻意**高估**（over-estimate），
使告警提前触发但不会误杀合法请求。

## 关键实现

| 行号 | 符号 | 可见性 | 说明 |
|---|---|---|---|
| 8 | `CHARS_PER_TOKEN` | P | 4 字符 ≈ 1 token |
| 9 | `TOKENS_PER_MESSAGE_OVERHEAD` | P | 每条消息额外 4 token（角色 / 分隔符开销） |
| 11-13 | `charsToTokens` | P | `Math.ceil(chars / 4)` |
| 15-18 | `estimateTextTokens` | P | 空串返回 0，否则 `charsToTokens` |
| 20-40 | `estimatePartTokens` | P | 按 part 分派：`text` 走字符估算；`image` 固定记 1000 token；`tool_use` 记 `toolName` + `JSON.stringify(input)`；`tool_result` 记 `output.value` / `output.text` |
| 42-54 | `estimateTokensForCcMessages` | **E** | 对 CC 形态消息数组求和（`{role, content}`） |
| 56-82 | `estimateTokensForOpenAIMessages` | **E** | 对 OpenAI 形态消息数组求和，content 支持字符串与 part 数组两种形态 |
| 84-90 | `ContextCheck` | **E** | 接口：`{ok, estimatedTokens, window, utilization, level, message}` 一类的判定结果 |
| 92 | `WARN_THRESHOLD` | P | 0.85 —— 利用率超此值发警告 |
| 93 | `EXCEED_THRESHOLD` | P | 0.98 —— 利用率超此值判定超限 |
| 95-112 | `checkContextWindow` | **E** | 主判定：取 `contextWindowFor(model)` 算 `utilization`，按阈值返回 `ContextCheck`；窗口未知（`null`）时放行 |
| 114 | `DEFAULT_MAX_TOOL_CHARS` | **E** | 30 000 —— 单条工具结果默认字符上限 |
| 116-123 | `truncateToolOutput` | **E** | 超长截断，返回 `{text, truncated, originalLength}` |

## 未接线原因

无任何 import 方。`modules/chat/handler.ts` 与 `modules/messages/handler.ts`
在转发前只做鉴权与协议转换，不做上下文预估；超长请求依赖
`shared/errors.ts` 的 `isContextWindowExceeded`（关键词匹配）在**上游返回 400 之后**
才归一化为 `context_window_exceeded`，属于事后补救而非事前拦截。

**连带影响**：`shared/model-windows.ts`(37L) 仅被本模块引用，随本模块一同未接线。

## 与既有机制的关系

README §7 明确说明「代理无状态：`buildCcRequest` 每请求全量透传完整历史，
不做 prune / trim / compact」。本模块正是当时预留但未启用的护栏位——
它只能**告警与截断单条工具输出**，不改变整体透传语义，因此接入风险较低。

## 接入建议

1. 在两个 handler 的 `buildCcRequest` 之前调用
   `estimateTokensForOpenAIMessages` / `estimateTokensForCcMessages`，
   结果交给 `checkContextWindow`。
2. `level === 'exceed'` 时按 `shared/errors.ts` 的 `CONTEXT_WINDOW_ERROR`
   （400 / `context_window_exceeded`）返回，与事后归一化保持同一形状。
3. 对 `tool_result` part 在 `buildCcRequest` 阶段过一遍 `truncateToolOutput`，
   可直接缓解 README §7 第 3 条「控制单条 tool 结果体积」。
4. 阈值 `WARN_THRESHOLD` / `EXCEED_THRESHOLD` 目前是模块内常量，接入后建议提为
   `shared/config.ts` 的可配置项。
