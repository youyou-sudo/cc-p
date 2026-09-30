# 模块报告：src/shared/http.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/shared/http.ts` |
| 行数 | 183 |
| 层级 | 基础设施层 |
| 依赖 | `./config` |
| 被依赖 | `src/infra/proxy-handler.ts`、`src/plugins/cors.ts`、`src/plugins/body.ts`、`src/modules/models/catalog.ts`、`src/modules/chat/handler.ts`、`src/modules/messages/handler.ts` |

## 职责

- 定义 CORS 与 SSE 响应头常量，供插件与处理器复用。
- 提供 JSON / Anthropic 错误响应构造器（`sendJSON`、`sendAnthropicError`）。
- 提供带大小限制与读取超时的请求体解析 `readJsonBody`，以及通用 Promise 超时包装 `readWithTimeout`。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | import | — | `CFG`、`MAX_BODY_SIZE`（`./config`）；`log`（`./logger`） |
| 3-9 | 模块头注释 | 逻辑 | — | 说明 CORS 策略：配了兜底 `CC_API_KEY` 时代理对无 key 浏览器请求全开放，故默认拒绝跨域 |
| 10-13 | `corsAllowOrigin` | 函数 | P | `CFG.corsAllowOrigin` 优先；否则 `CFG.apiKey ? 'null' : '*'`（有兜底 key 时拒绝浏览器跨域，curl/SDK 无 Origin 不受影响） |
| 15-19 | `CORS_HEADERS` | 常量 | E | `Access-Control-Allow-Origin`（调 `corsAllowOrigin()`）、`-Methods:'GET, POST, OPTIONS'`、`-Headers:'*'` |
| 21-26 | `SSE_HEADERS` | 常量 | E | `text/event-stream`、`no-cache`、`keep-alive`、`X-Accel-Buffering: no` |
| 28-33 | `sendJSON` | 函数 | E | `JSON.stringify(data)`；若 `data.retry_after` 存在则同步写 `Retry-After` 头 |
| 36-51 | `sendAnthropicError` | 函数 | E | 构造 `{type:'error', error:{type,message}}`；`opts.retryAfter` 存在且非 headerOnly 时写入 body.retry_after 与头，headerOnly 时只写头 |
| 53-57 | `BodyTooLargeError` | class | E | `extends Error`，消息含按 MB 取整的 `MAX_BODY_SIZE` 上限 |
| 59 | `DRAIN_LIMIT` | 常量 | P | 32MiB；超限请求被放弃读取前最多排空此字节数 |
| 60 | `sharedDecoder` | 常量 | P | 复用单一 `TextDecoder` 实例 |
| 73-169 | `readJsonBody` | 函数 | E | 见关键行为 |
| 171-183 | `readWithTimeout` | 函数 | E | `Promise.race` 与 `setTimeout`，超时以 `new Error(tag)` 拒绝；`finally` 清理定时器 |

## 关键行为

- **Content-Length 预检**（77-86）：头部可解析且超过 `MAX_BODY_SIZE` 立即抛 `BodyTooLargeError`，不读 body。
- **流式读取与超时**（88-133）：无 body reader 抛 `'Invalid JSON'`；每次 `reader.read()` 经 `readWithTimeout(..., timeoutMs, 'READ_BODY_TIMEOUT')`（默认 `30000`），超时则 `reader.cancel()` 并抛 `'Request read timeout'`；逐块累加 `totalSize`。
- **超限后排水**（88-101）：一旦 `totalSize > MAX_BODY_SIZE`，清空 `chunks` 并置 `tooLarge`，后续块只累加 `drained`，超过 `DRAIN_LIMIT`（32MiB）即 `reader.cancel()` 并 break，循环结束后抛 `BodyTooLargeError`——即先尽量排空以复用连接，再统一报错。
- **解码与解析**（154-166）：按顺序 `decode(c, {stream:true})` 再收尾 `decode()`，`JSON.parse` 失败抛 `'Invalid JSON'`（不返回空对象）。
- **五条拒绝路径全部记日志**（77-86、96-100、109-124、143-152、162-166）：`readJsonBody` 是两条入口路径（`src/plugins/body.ts` onParse 与 `src/infra/proxy-handler.ts` 的 `readRequestJson`）的唯一汇聚点，此前五种拒绝都无日志，只能从客户端收到的状态码倒推。字段设计使两种超限可区分：
  - `rejectedEarly: true` —— 声明的 `content-length` 超限，未读 body（便宜，攻击者无法借此让代理缓冲）
  - `rejectedEarly: false` —— 流式传输（chunked，无 `content-length`）中途越界，这是预检抓不到的情况
  - 排水中止 —— 已知超限后停止读取，这正是防止大包占用内存的动作，所以停止本身值得记录
  - 读超时，用 `stalledMidBody` 区分 slow-loris 与完全未发数据
  - JSON 不可解析
  - 另有「body 不是可读流」（`request.body` 为 null）一条
- **易错点**：`readJsonBody` 在超限时返回的是异常而非响应，响应转换由上层 `BodyTooLargeError` 处理（`src/plugins/errors.ts` 消费 `MAX_BODY_SIZE`）；`readWithTimeout` 不取消底层 promise，仅放弃等待。`src/plugins/body.ts` 在执法 413 时额外记录 path —— `readJsonBody` 只知道 method 与 `content-length`，无法定位是哪个端点被灌包。
