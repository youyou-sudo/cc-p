# 模块报告：src/infra/proxy-handler.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/infra/proxy-handler.ts` |
| 行数 | 119 |
| 层级 | 共享管道层 |
| 依赖 | `./cc`(forwardToCC)；`../shared/errors`(mapCcError, type MappedError)；`./fingerprint`(ensureInitialized)；`../shared/http`(BodyTooLargeError, readJsonBody)；`../shared/logger`(log) |
| 被依赖 | `src/modules/chat/handler.ts`、`src/modules/messages/handler.ts` |

## 职责

- 两个协议处理器（`/v1/chat/completions` 与 `/v1/messages`）共享的请求前处理与上游调用样板。
- 解析请求 JSON 体，并把 `BodyTooLargeError`/非法 JSON 交由协议自有的 `buildError` 生成对应错误体。
- 统一客户端断连处理：先执行优雅收尾钩子，再 abort 上游 `fetch`（掐断计费）。
- 「指纹初始化 → 转发 `/alpha/generate` → 非 2xx 映射」的上游调用前置。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 6-11 | — | import | — | `./cc`(forwardToCC)；`../shared/errors`(mapCcError, type MappedError)；`./fingerprint`(ensureInitialized)；`../shared/http`(BodyTooLargeError, readJsonBody)；`../shared/logger`(log) |
| 13 | `JsonParseErrorKind` | type | E | `'too-large' \| 'invalid'` |
| 15-29 | `readRequestJson<T>(request, buildError)` | 异步函数 | E | 包 `readJsonBody`；`BodyTooLargeError` → `buildError('too-large', e.message)`，其余异常 → `buildError('invalid', 'Invalid JSON body')`；返回 `{ok:true,value}` / `{ok:false,response}` |
| 31-46 | `UpstreamFlow` | interface | E | `signal`(只读)、`controller`(只读)、`aborted`(只读)、`setGracefulClose(fn\|null)`、`abort()` |
| 48-64 | `createUpstreamFlow(request)` | 函数 | E | 创建 `AbortController`；注册 `request.signal` 的 once `abort` 监听（见关键行为）；返回带 getter 的 flow 对象 |
| 66-89 | `UpstreamCallArgs<T>` | interface | E | apiKey、headers、ccBody、signal、promptCacheKey?、label（启动日志标签）、onCcError（协议化错误构造器）、**clientDeadlineAt?**（可选，见关键行为） |
| 79-88 | └ `clientDeadlineAt` 注释 | 逻辑 | — | 为何需要：退避超过调用方的等待上限就是一次无意义的重试；对非幂等端点还等于白生成一次并计费 |
| 92-98 | `clientDeadlineFrom(headers)` | 函数 | E | 从 `x-request-timeout-ms` / `x-timeout-ms` 读客户端声明的 deadline（epoch ms）；缺失/非数字/非正数一律返回 `undefined` |
| 101-119 | `callUpstream<T>(args)` | 异步函数 | E | `ensureInitialized` → `forwardToCC` → 非 2xx 时读错误文本、截前 200 字、记录 model 与 apiKey 后 4 位、`log('error', label, ...)` 并返回 `{ok:false,value:onCcError(mapCcError(status,text))}`；2xx 返回 `{ok:true,response}` |

## 关键行为

- 断连级联顺序（52-56）：`abort` 监听里先置 `aborted=true` → 执行 `gracefulClose?.()`（如 SSE 的 `terminateWith`）→ `try { controller.abort() }`（停止上游 fetch / 计费）。监听用 `{once:true}`，且最先注册，保证先于后续阶段钩子运行。
- 响应进入终态后由调用方 `setGracefulClose(null)` 卸下优雅钩子，避免重复收尾（见 31-39 注释）。
- `callUpstream` 把 `model` 从 `ccBody.params.model ?? ccBody.model` 尽力取出用于日志（112），失败不影响主流程；apiKey 仅记录末 4 位（114），不泄露完整密钥。
- 非 2xx 的错误体文本只截取 200 字符进入日志（109）。
- **`clientDeadlineAt` 是可选且只被 `proxy-slot` 消费**：本文件的 `callUpstream`
  **不重试**，所以完全忽略该字段；`callUpstreamWithSlots`（未接线）用它截断退避。
- **deadline 必须来自客户端而非猜测**（92-98）：`clientDeadlineFrom` 只接受
  `x-request-timeout-ms`，不设即返回 `undefined`（即不启用截断）。自行给一个
  默认值可能砍掉本会成功的重试。覆盖测试见 `test/logging.ts` 的 `deadline:` 前缀断言。
