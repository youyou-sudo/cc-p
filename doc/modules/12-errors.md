# 模块报告：src/errors.ts（错误与语义映射）

| 属性 | 值 |
|---|---|
| 路径 | `src/errors.ts` |
| 行数 | 86 |
| 层级 | 共享管道 |
| 依赖 | 无（零依赖叶子模块） |
| 被依赖 | openai、anthropic、sse、proxy-handler |

## 代码段映射

| 行号 | 符号 | 说明 |
|---|---|---|
| 1-12 | `CC_STATUS_MAP` | CC 上游 HTTP 状态 → (status, type)：`400,422→400 invalid_request_error`；`401,403→401 authentication_error`；`402→402 payment_required`（付款问题正确映射）；`404→404 not_found`；`429→429 rate_limit_error`；`500,502→502 upstream_error`；`503→503 temporarily_unavailable`；未知状态 → 502 upstream_error |
| 14-17 | `MappedError` | `{status, body}`——body 已是目标协议错误形状（`{error:{message,type}}` + 可选 retry_after） |
| 19-43 | `mapCcError(ccStatus, ccBody?)` | 非 2xx 响应体映射：优先 `body.error.message` / `body.message`；JSON 解析失败取前 200 字符；`ccStatus===429` 特判 → 附 `retry_after:30`（body 与头两层） |
| 45-59 | `mapCcEventError(event)` | 流内 error 事件映射：消息可能带 `<NNN>` 状态码前缀（上游把 HTTP 状态编进流），正则 `^<(\d{3})>` 提取，缺省 502；同样走 CC_STATUS_MAP；429 附 retry_after:30 |
| 61-68 | `mapFinishReason(reason)` | CC finish → OpenAI finish_reason：`tool-calls→tool_calls`（CC 用连字符、OpenAI 用下划线）；`length/stop` 原样；空值兜底 `stop` |
| 70-77 | `normalizeUsage(u)` | 口径归一：`outputTokens` 缺失或 0 时强制 `inputTokens=0`、`cachedInputTokens=0`（上游可能只报 output，避免误报输入消耗） |
| 79-86 | `mapAnthropicStopReason(finishReason)` | OpenAI finish → Anthropic stop_reason：`tool_calls→tool_use`、`length→max_tokens`、`stop→end_turn`、其余兜底 `end_turn` |

## 双协议错误流向

- OpenAI：`sendJSON(status, {error:{message,type}, retry_after?})`（http.sendJSON 自动加 Retry-After 头）。
- Anthropic：`sendAnthropicError(status, body.error.type, body.error.message)`——**字段从 MappedError.body 解包重组**，保持 Anthropic 顶层 `{type:'error',error:{...}}` 形状。
- 两处 `retry_after:30` 的 429 均来自 CC_STATUS_MAP 的 rate_limit 分支。
