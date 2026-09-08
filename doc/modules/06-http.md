# 模块报告：src/http.ts（HTTP 工具）

| 属性 | 值 |
|---|---|
| 路径 | `src/http.ts` |
| 行数 | 116 |
| 层级 | 基础设施 |
| 依赖 | `./config`(CFG, MAX_BODY_SIZE) |
| 被依赖 | index、openai、anthropic、models、proxy-handler |

## 代码段映射

| 行号 | 符号 | 说明 |
|---|---|---|
| 9-12 | `corsAllowOrigin()` | 私有策略函数（见下） |
| 14-18 | `CORS_HEADERS` | 模块加载期求值一次：`Access-Control-Allow-Origin` / `Allow-Methods: GET, POST, OPTIONS` / `Allow-Headers: *` |
| 20-25 | `SSE_HEADERS` | `text/event-stream`、`no-cache`、`keep-alive`、`X-Accel-Buffering: no`（禁 nginx 缓冲） |
| 27-33 | `sendJSON(status, data)` | JSON 响应；`data.retry_after` 存在时自动映射为 `Retry-After` 响应头（OpenAI 路径 429/502 全部经此） |
| 35-50 | `sendAnthropicError(status, type, message, opts?)` | Anthropic 错误体 `{type:'error',error:{type,message}}`；`opts.retryAfter` 默认同时写入 body.retry_after 与响应头；`opts.headerOnly=true` 时只写响应头（anthropic 非流式 idle timeout 用） |
| 52-56 | `BodyTooLargeError` | Error 子类，消息含 MB 上限；proxy-handler 据此区分 413/400 |
| 58 | `DRAIN_LIMIT = 32MB` | 超限后继续排水（消费流但不存）最多 32MB，然后 cancel reader——防止恶意超大 body 拖垮带宽/内存 |
| 59 | `sharedDecoder` | 模块级共享 TextDecoder（分块 decode 拼接） |
| 61-121 | `readJsonBody(request, timeoutMs=30000)` | 1) Content-Length 预检超限直接抛；2) 无 body 抛 Invalid JSON；3) 分块读取累计，超 MAX_BODY_SIZE 时清空 chunks 并转排水模式；4) 使用 `readWithTimeout` 实现全局读超时（默认 30s），超时自动 cancel reader 并抛 'Request read timeout'；5) 结束后 JSON.parse，失败抛 Invalid JSON |
| 75-80 | `readWithTimeout()` | 内部 Promise.race 超时包装；超时 reject `new Error('READ_TIMEOUT')`；防止 Slowloris 攻击 |
| 104-116 | `readWithTimeout(promise, timeoutMs, tag)` | Promise.race 超时包装；超时 reject `new Error(tag)`；项目内 tag 固定 `'STREAM_IDLE_TIMEOUT'`，上层按 `e.message` 识别；finally 清理定时器（成功路径无泄漏） |

## CORS 策略（安全设计）

| 条件 | Allow-Origin |
|---|---|
| `CORS_ALLOW_ORIGIN` 已配置 | 该值（单 origin 或列表，原样透传） |
| 未配置 + 无兜底 Key | `*`（任意网页可调，但必须自带 Key） |
| 未配置 + 有兜底 Key | `null`（浏览器跨域一律拒绝，防任意网页无 Key 白嫖兜底额度；curl/SDK 不发 Origin 不受影响） |

## 边界行为

- 请求体超限返回 HTTP 413（index.onError 统一构造消息）。
- 排水模式保证上游连接被干净终止（drain 后 cancel）。
- `readWithTimeout` 的 reject 值是 `Error(tag)` 而非专用类型——调用方靠 message 字符串匹配，这是本项目刻意的轻量约定。
