# 模块报告：test/timeouts.ts（超时专项测试）

| 属性 | 值 |
|---|---|
| 路径 | `test/timeouts.ts` |
| 行数 | 81 |
| 运行 | `bun run test:timeouts` |
| 特点 | **真实时间流逝**（约 30s），验证 runtime.ts 的 STREAM_IDLE_TIMEOUT_MS 路径与断连级联取消；思考期宽限由 `test/idle-timeout-env.ts` 的 THINKING env 用例 + `ENABLE_THINKING_ASSERT=1` 门控纯函数断言覆盖（无 120s 真等待） |
| 拓扑 | mock 挂起上游 :4110 ← 被测服务 :4210 |

## 隔离与基建

| 行号 | 段落 | 说明 |
|---|---|---|
| 1-4 | env 注入 | `PORT=4210`、`HOST=127.0.0.1`、`CC_API_BASE=http://127.0.0.1:4110`、无兜底 Key（先于 import 设置） |
| 7 | `generateCancelled` | 布尔标记：mock /alpha/generate 是否被取消——`req.signal` abort 事件 **与** ReadableStream `cancel()` 回调双重置位（任一触发即视为取消） |
| 9-31 | mock Bun.serve(:4110) | `idleTimeout:120`（Bun 侧自身不先断）；/alpha/generate 返回只发一行 `start` 后 `Bun.sleep(120000)` 挂起的流；其余端点返回空 JSON |
| 33-43 | 启动与工具 | `await import('../src/index.ts')` + sleep 300；`check()` 计数器 |

## 用例

### ① stream idle timeout（L45-58，等待 ~30s）

- 请求 `/v1/chat/completions`（stream:true, model 任意 → 命中挂起流）。
- 断言：总耗时在 **28s~35s** 之间（证明 30s 空闲超时真实生效，而非立即失败或等到上游 120s）；响应 429 + `error.type==='rate_limit_error'` + `retry_after===5`。
- 断言：`generateCancelled === true`——超时后 proxy 主动 abort 上游（openai pump 的 STREAM_IDLE_TIMEOUT 分支 `abortController.abort()`）。
- ⚠️ 新契约下此断言过时：mock 只发一行 `start` 后挂起 120s，命中思考期
  （`isThinkingWait('start')===true`），`idleTimeoutFor` 应返回 120s 而非 30s；
  在 src 落定前不要改成真实等待 120s 的用例。30s 快速失败路径归属“连接期零事件
  （空 `lastCcEvent`）仍走 30s”；思考期映射由文件末尾 `ENABLE_THINKING_ASSERT=1`
  门控纯函数块断言（`isThinkingWait` 四事件 true、空串/`content-delta` false、
  thinking 窗口 > stream 窗口），默认跳过。

### ② anthropic client disconnect mid-stream（L60-76）

- `/v1/messages`（stream:true）读取首块后 `ac.abort()`，sleep 600ms。
- 断言：`generateCancelled === true`（UpstreamFlow 级联取消生效：gracefulClose → controller.abort → 上游 fetch/流取消）。
- 断言：`/health` 仍 200（断连不击穿服务）。

### 收尾（L78-81）

`RESULT: N passed, M failed`；fail>0 → exit 1。

## 与 e2e 的分工

e2e 用慢速流（300ms 级）覆盖**功能正确性**；本文件用 120s 挂起流覆盖**时间常量与资源清理**（runtime.ts 的 30s 常量、proxy-handler 的取消链路）。两文件互补，且都对「上游必须被取消」做了显式断言——这是代理类服务最容易泄漏的地方（不取消 = 持续计费 + 连接泄漏）。

## 与排障文档的关系

- 本文件断言的 `retry_after===5` 即用户侧“空闲超时”那一种 429（另两种：`10`=零输出、`30`=真限流，见 `12-errors.md` 速查）。
- 调大 `CC_STREAM_IDLE_MS` / `CC_NONSTREAM_IDLE_MS` 后，本用例的 28-35s 断言窗口需同步调整——这是 `.env.example` 中 trade-off 注释的来源（容忍慢上游 vs 延迟失败感知）。
- `CC_THINKING_IDLE_MS`（默认 120s，深度推理建议 180000）只影响思考期
  （`start`/`start-step`/`reasoning-start`/`reasoning-delta`）；心跳 ping 只保下游
  不续租上游（见 `test/heartbeat.ts` 头注释），“客户端连接存活”不等于“上游有字节”。
