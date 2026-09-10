# 模块报告：test/timeouts.ts

| 属性 | 值 |
|---|---|
| 路径 | `test/timeouts.ts` |
| 行数 | 114 |
| 层级 | 测试 |
| 依赖 | `../src/index.ts`（动态 import）；`../src/shared/runtime.ts`（`ENABLE_THINKING_ASSERT=1` 时门控动态 import） |
| 被依赖 | 无（独立入口脚本） |

## 职责

- 以真实时间流逝（约 30s）验证流式空闲超时路径：mock 上游零字节挂起，被测服务应在 28–35s 内返回 429 并主动取消上游。
- 验证 Anthropic 客户端中途断连时上游被级联取消且服务存活。
- 提供 `ENABLE_THINKING_ASSERT=1` 门控的纯函数单测（无真实等待），断言 `isThinkingWait`/`idleTimeoutFor` 的思考期映射。
- 与 `test/idle-timeout-env.ts` 分工：本文件覆盖非思考期 30s 快速失败与取消链路，env 解析归后者，不在此真实等待 120s。

## 代码段映射

| 行号 | 符号/段落 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-4 | env 注入 | env | — | `PORT=4210`、`HOST=127.0.0.1`、`CC_API_BASE=http://127.0.0.1:4110`、`CC_API_KEY=''`；先于 import 设置 |
| 6 | `enc` | 工具 | P | `TextEncoder` 单例 |
| 7 | `generateCancelled` | 状态 | P | 上游 `/alpha/generate` 是否被取消的布尔标记 |
| 9-33 | mock `Bun.serve(:4110)` | mock | P | 上游桩服务，`idleTimeout:120` |
| 14 | └ `/alpha/fingerprint/record` | mock | P | 返回 `{}` |
| 15 | └ `/alpha/lifecycle-events` | mock | P | 返回 `{}` |
| 16 | └ `/provider/v1/models` | mock | P | 返回 `{data:[{id:'m'}]}` |
| 17-30 | └ `/alpha/generate` | mock | P | 注册 `req.signal` abort → 置位；零字节挂起 `Bun.sleep(120000)` 后 close；`cancel()` 回调也置位；返回 NDJSON 流 |
| 31 | └ 兜底 | mock | P | 其余路径 404 `nf` |
| 35-36 | 启动 | 基建 | P | `await import('../src/index.ts')` + `Bun.sleep(300)` |
| 38-39 | `BASE` / `KEY` | 状态 | P | 被测基址 `http://127.0.0.1:4210`、测试 Key `user_timeout_test` |
| 41-45 | `check(name, cond, extra?)` | 断言 | P | PASS/FAIL 计数 |
| 47-65 | 用例组① stream idle timeout | 用例组 | P | 请求流式 `mock/hang`（零字节挂起）；断言 429 + `rate_limit_error` + `retry_after:5`、耗时 28–35s、`generateCancelled===true`（超时后上游被 abort） |
| 67-83 | 用例组② anthropic 中途断连 | 用例组 | P | `/v1/messages` 流式读首块后 `ac.abort()`，sleep600；断言 `generateCancelled===true`、`/health` 仍 200 |
| 85 | 结果 | 输出 | P | 打印 `RESULT: N passed, M failed` |
| 87-111 | `ENABLE_THINKING_ASSERT` 门控块 | 用例组 | P | 仅 env 为 `'1'` 时执行：动态 import runtime，若导出 `isThinkingWait`/`idleTimeoutFor` 则断言 `start`/`start-step`/`reasoning-start`/`reasoning-delta` → true、`''`/`content-delta` → false、思考窗口 > 流窗口；否则打印 SKIP |
| 112-114 | 退出 / 导出 | 输出 | E | `fail>0` → `process.exit(1)`；`export {}` |

## 关键行为

- mock `/alpha/generate` 不发任何行即挂起（L22-28），使 `lastCcEvent` 保持 `''`，命中非思考期 → 仍走 30s 流式快速失败预算；这与旧文档「先发 start 再挂起」不同，当前实现是零事件。
- `generateCancelled` 由 `req.signal` 的 abort 事件（L18）与 ReadableStream `cancel()` 回调（L27）双重置位，任一触发即视为上游被取消。
- 思考期（`start`/`reasoning-start` 等后挂起）期望 120s，`CC_THINKING_IDLE_MS` 只做纯函数断言、不做真实等待；ENABLE_THINKING_ASSERT 块因 src 可能并行修改而默认跳过。
- 运行方式：`bun run test:timeouts`（等价 `bun run test/timeouts.ts`）；启用思考映射断言：`ENABLE_THINKING_ASSERT=1 bun test/timeouts.ts`。
