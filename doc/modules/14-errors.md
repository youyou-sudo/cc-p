# 模块报告：src/shared/errors.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/shared/errors.ts` |
| 行数 | 109 |
| 层级 | 基础设施层 |
| 依赖 | 无（零依赖叶子模块） |
| 被依赖 | `src/infra/proxy-handler.ts`、`src/modules/chat/aggregator.ts`、`src/modules/chat/translator.ts`、`src/modules/messages/aggregator.ts`、`src/modules/messages/handler.ts`、`src/modules/messages/translator.ts` |

## 职责

- 将 Command Code 上游的 HTTP 状态码与流内错误事件，统一映射为目标协议（OpenAI / Anthropic）的 `{status, body}` 错误形状。
- 识别「上下文超长」类错误，优先归为 `400 context_window_exceeded`（不可重试），避免 SDK 对 429 的自动重试。
- 归一化 finish reason 与 usage（OpenAI ⇄ Anthropic 语义转换）。
- 定义可直接被 `src/infra/proxy-handler.ts` 消费的 `MappedError` 契约。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-12 | `CC_STATUS_MAP` | 常量 | E | 上游状态 → `{ status, type }`：`400→400 invalid_request_error`；`401→401 authentication_error`；`402→402 payment_required`；`403→401 authentication_error`；`404→404 not_found`；`422→400 invalid_request_error`；`429→429 rate_limit_error`；`500,502→502 upstream_error`；`503→503 temporarily_unavailable`。查不到的键 → 调用方回退 `{502, upstream_error}` |
| 14-17 | `MappedError` | interface | E | `{ status: number; body: any }`，body 已是目标协议错误形状（`{ error: { message, type } }`，429 另带 `retry_after`） |
| 19-20 | `CONTEXT_WINDOW_EXCEEDED_PATTERN` | 常量 | E | 超长识别正则：`/prompt.*too long\|context.*(too long\|exceed\|limit\|length)\|max.*tokens\|input.*too (long\|large)\|message.*too long/i` |
| 22-24 | `isContextWindowExceeded` | 函数 | E | `CONTEXT_WINDOW_EXCEEDED_PATTERN.test(message \|\| '')`，空消息 → `false` |
| 26 | `CONTEXT_WINDOW_ERROR` | 常量 | E | `{ status: 400, type: 'context_window_exceeded' }`（仅状态与类型，message 用上游原文） |
| 28-61 | `mapCcError` | 函数 | E | HTTP 非 2xx 响应体 → `MappedError`；先取映射（L29，缺省 502 upstream_error），解析 body 取 message（L32-39），再走超长/429/默认三分支 |
| 32-39 | └ 消息解析 | 逻辑 | P | `JSON.parse(ccBody)` → `parsed.error?.message \|\| parsed.message`；解析失败 → `ccBody.slice(0,200)`；均无 → 默认 `CC API error (${ccStatus})` |
| 41-48 | └ 超长优先 | 逻辑 | P | `isContextWindowExceeded(message)` 命中即返回 `{status:400, body:{error:{message, type:'context_window_exceeded'}}}`，**先于** 429 判断（即使上游报 429 也归 400） |
| 50-58 | └ 429 分支 | 逻辑 | P | `ccStatus===429` → `{status:429, body:{error:{message,type:'rate_limit_error'}, retry_after:30}}` |
| 60 | └ 默认返回 | 逻辑 | P | `{ status: mapped.status, body: { error: { message, type: mapped.type } } }` |
| 63-84 | `mapCcEventError` | 函数 | E | 流内 `type:'error'` 事件 → `MappedError`；message 取 `event.error?.message \|\| event.message \|\| 'Unknown CC error'` |
| 65-71 | └ 超长优先 | 逻辑 | P | 同 mapCcError，超长命中即返回 400 `context_window_exceeded`，**先于** `<NNN>` 状态码解析 |
| 72-74 | └ 状态码提取 | 逻辑 | P | 消息前缀正则 `/^<(\d{3})>/` 取三位码；无匹配默认 `502`；再查 `CC_STATUS_MAP`，缺省 `{502, upstream_error}` |
| 76-83 | └ 429 / 默认 | 逻辑 | P | `mapped.status===429` → 附 `retry_after:30`；否则返回 `{status, body:{error:{message,type}}}` |
| 86-93 | `mapFinishReason` | 函数 | E | CC finish → OpenAI finish_reason：`tool-calls→tool_calls`、`length→length`、`stop→stop`、其余原样、空值兜底 `stop` |
| 95-100 | `normalizeUsage` | 函数 | E | 当前为**纯空操作**：`if (!u) return` 后直接 `return`（保留上游真实 usage 口径，outputTokens 缺失/0 也不清零 inputTokens/cachedInputTokens；调用方需容忍 `undefined`/`NaN`） |
| 102-109 | `mapAnthropicStopReason` | 函数 | E | OpenAI finish → Anthropic stop_reason：`tool_calls→tool_use`、`length→max_tokens`、`stop→end_turn`、缺省兜底 `end_turn` |

## 关键行为

- **超长优先归 400 是核心不变式**：`mapCcError`（L43-48）与 `mapCcEventError`（L66-71）均在 429 判断与 `<NNN>` 解析**之前**调用 `isContextWindowExceeded`，把上下文超长强制映射为 `400 context_window_exceeded`——因为 SDK 会自动重试 429，而超长重试必然失败。
- **429 重试提示**：两路都注入 `retry_after: 30`（L55、L79），区别于其它错误；未知上游状态一律降级 `502 upstream_error`（L29、L74）。
- **错误消息来源**：HTTP 路径优先结构化 `error.message`/`message`，退化为原文前 200 字符（L37）；事件路径消息自带 `<NNN>` 前缀（L72）。
- `CC_STATUS_MAP` 做了两处状态重写：`403` 收敛为 401、`500`/`422` 收敛为 400/502，保证下游协议错误码语义正确。
- `normalizeUsage` 已从旧版「output 缺失即清零 input」改为 no-op（L97-100），usage 数值直接透传上游。
