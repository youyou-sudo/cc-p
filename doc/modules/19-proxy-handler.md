# 模块报告：src/infra/proxy-handler.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/infra/proxy-handler.ts` |
| 行数 | 97 |
| 层级 | 共享管道层 |
| 依赖 | `./cc`(forwardToCC)；`../shared/errors`(mapCcError, type MappedError)；`./fingerprint`(ensureInitialized)；`../shared/http`(BodyTooLargeError, readJsonBody)；`../shared/logger`(log)；`../shared/config`(CFG)；`../shared/concurrency`(ConcurrencyGate)；`../shared/limit`(limitMeta)；`../shared/retry`(backoffDelay, parseRetryAfter) |
| 被依赖 | `src/modules/chat/handler.ts`、`src/modules/messages/handler.ts` |

## 职责

- 两个协议处理器（`/v1/chat/completions` 与 `/v1/messages`）共享的请求前处理与上游调用样板。
- 解析请求 JSON 体，并把 `BodyTooLargeError`/非法 JSON 交由协议自有的 `buildError` 生成对应错误体。
- 统一客户端断连处理：先执行优雅收尾钩子，再 abort 上游 `fetch`（掐断计费）。
- 「指纹初始化 → 门控 → 转发 `/alpha/generate`（纯 rate_limit 重试）→ 非 2xx 映射」的上游调用前置。
- 并发门控：进程级 `ConcurrencyGate` 单例，按有效上游 Key（= `getApiKey` 结果，与 session/fingerprint/runtime 同键）分桶；队列满 429 `retry_after:1`，排队超时 429 `retry_after:2`。
- 429 重试：仅 `limitMeta.retryable`（纯 rate_limit）重试，最多 `CFG.retryMax`（默认 3）次；上游 `Retry-After` 原样透传（ceil 到秒），否则 1s 起步指数退避+抖动（`retryBaseMs`/`retryCapMs`）；`retryAfter > retryCapMs` 时本地放弃重试但回客户端仍透传原值（不撒谎）。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 6-15 | — | import | — | `./cc`(forwardToCC)；`../shared/errors`(mapCcError, type MappedError)；`./fingerprint`(ensureInitialized)；`../shared/http`(BodyTooLargeError, readJsonBody)；`../shared/logger`(log)；`../shared/config`(CFG)；`../shared/concurrency`(ConcurrencyGate, RoomFull, Timeout)；`../shared/limit`(limitMeta)；`../shared/retry`(backoffDelay, parseRetryAfter) |
| 13 | `JsonParseErrorKind` | type | E | `'too-large' \| 'invalid'` |
| 15-29 | `readRequestJson<T>(request, buildError)` | 异步函数 | E | 包 `readJsonBody`；`BodyTooLargeError` → `buildError('too-large', e.message)`，其余异常 → `buildError('invalid', 'Invalid JSON body')`；返回 `{ok:true,value}` / `{ok:false,response}` |
| 31-46 | `UpstreamFlow` | interface | E | `signal`(只读)、`controller`(只读)、`aborted`(只读)、`setGracefulClose(fn\|null)`、`abort()` |
| 48-64 | `createUpstreamFlow(request)` | 函数 | E | 创建 `AbortController`；注册 `request.signal` 的 once `abort` 监听（见关键行为）；返回带 getter 的 flow 对象 |
| 66-76 | `UpstreamCallArgs<T>` | interface | E | apiKey、headers、ccBody、signal、promptCacheKey?、label（启动日志标签）、onCcError（协议化错误构造器） |
| 113-163 | `callUpstream<T>(args)` | 异步函数 | E | `ensureInitialized` → `gate.acquire(apiKey)`（满/超时 fail-fast 429）→ 循环 `forwardToCC`：2xx 直接返回；非 2xx 读错误文本+`Retry-After` 头 → `limitMeta` 分类 → 不可重试/`attempt>=retryMax`/已 abort 则 `mapCcError(status,text,retryAfterMs)` 透传；可重试则等 `retryAfterMs ?? backoffDelay`（abort-aware sleep）再发；`release()` 在 finally 中归还槽位 |

## 关键行为

- 断连级联顺序（52-56）：`abort` 监听里先置 `aborted=true` → 执行 `gracefulClose?.()`（如 SSE 的 `terminateWith`）→ `try { controller.abort() }`（停止上游 fetch / 计费）。监听用 `{once:true}`，且最先注册，保证先于后续阶段钩子运行。
- 响应进入终态后由调用方 `setGracefulClose(null)` 卸下优雅钩子，避免重复收尾（见 31-39 注释）。
- `callUpstream` 把 `model` 从 `ccBody.params.model ?? ccBody.model` 尽力取出用于日志（90），失败不影响主流程；apiKey 仅记录末 4 位（92），不泄露完整密钥。
- 非 2xx 的错误体文本只截取 200 字符进入日志（87）。
