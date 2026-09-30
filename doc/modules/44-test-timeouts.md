# 模块报告：test/timeouts.ts

| 属性 | 值 |
|---|---|
| 路径 | `test/timeouts.ts` |
| 行数 | 92 |
| 层级 | 测试 |
| 依赖 | `../src/index.ts`（动态 import） |
| 被依赖 | 无（独立入口脚本） |

## 职责

- 以真实时间流逝（约 30s）验证流式空闲超时路径：mock 上游零字节挂起，被测服务应在 28–35s 内返回 429 并主动取消上游。
- 验证 Anthropic 客户端中途断连时上游被级联取消且服务存活。
- 与 `test/idle-timeout-env.ts` 分工：本文件覆盖非思考期 30s 快速失败与取消链路，env 解析归后者，不在此真实等待 120s。
- ⚠ 本文件**不再包含** `ENABLE_THINKING_ASSERT` 门控块（原 L87-111）。三个空闲超时常量的 env 契约断言由 `test/idle-timeout-env.ts` 以子进程方式覆盖（`STREAM_IDLE_TIMEOUT_MS` / `NONSTREAM_IDLE_TIMEOUT_MS` / `THINKING_IDLE_TIMEOUT_MS` 的默认值、覆盖、`=0`、非数字退出码）。

## 代码段映射

| 行号 | 符号/段落 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-4 | env 注入 | env | — | `PORT=4210`、`HOST=127.0.0.1`、`CC_API_BASE=http://127.0.0.1:4110`、`CC_API_KEY=''`；先于 import 设置 |
| 5-10 | thinking 预算覆盖 | env | — | `CC_THINKING_IDLE_MS='30000'` + 注释：mock 只发 `start`（命中 `isThinkingWait()`），预算取 `THINKING_IDLE_TIMEOUT_MS`，压到 30s 以保持 CI 时长不变 |
| 12 | `enc` | 工具 | P | `TextEncoder` 单例 |
| 13 | `generateCancelled` | 状态 | P | 上游 `/alpha/generate` 是否被取消的布尔标记 |
| 15-42 | mock `Bun.serve(:4110)` | mock | P | 上游桩服务，`idleTimeout:120` |
| 20 | └ `/alpha/fingerprint/record` | mock | P | 返回 `{}` |
| 21 | └ `/alpha/lifecycle-events` | mock | P | 返回 `{}` |
| 22 | └ `/provider/v1/models` | mock | P | 返回 `{data:[{id:'m'}]}` |
| 23-38 | └ `/alpha/generate` | mock | P | 注册 `req.signal` abort → 置位；发单条 `{type:'start'}` 后 `Bun.sleep(120000)` 挂起；`cancel()` 回调也置位；返回 NDJSON 流 |
| 40 | └ 兜底 | mock | P | 其余路径 404 `nf` |
| 44-45 | 启动 | 基建 | P | `await import('../src/index.ts')` + `Bun.sleep(300)` |
| 47-48 | `BASE` / `KEY` | 状态 | P | 被测基址 `http://127.0.0.1:4210`、测试 Key `user_timeout_test` |
| 50-54 | `check(name, cond, extra?)` | 断言 | P | PASS/FAIL 计数 |
| 56-69 | 用例组① stream idle timeout | 用例组 | P | 请求流式 `mock/hang`；断言 429 + `rate_limit_error` + `retry_after:5`、耗时 28–45s、`generateCancelled===true`（超时后上游被 abort） |
| 71-87 | 用例组② anthropic 中途断连 | 用例组 | P | `/v1/messages` 流式读首块后 `ac.abort()`，sleep600；断言 `generateCancelled===true`、`/health` 仍 200 |
| 89 | 结果 | 输出 | P | 打印 `RESULT: N passed, M failed` |
| 90-92 | 退出 / 导出 | 输出 | E | `fail>0` → `process.exit(1)`；`export {}` |

## 关键行为

- **必须发 `{type:'start'}`（L32），不能发零事件也不能发 `text-delta`**：
  - 发 `start`：保持零输出、下游 SSE 头未 flush，故超时后仍能返回 **JSON 429**（用例组①的核心断言）。但 `start` 命中 `isThinkingWait()`，预算取 `THINKING_IDLE_TIMEOUT_MS`，故 L10 用 `CC_THINKING_IDLE_MS=30000` 压回 30s。
  - 发零事件：流以 zero-output 429 立即结束（67ms），**不会**触发空闲超时，用例①失去意义。
  - 发 `text-delta`：`thinkingPhase:false` 且预算正确回到 30s，但 SSE 头已 flush，超时只能得到流内 error 事件，拿不到 JSON 429。
- `generateCancelled` 由 `req.signal` 的 abort 事件（L24）与 ReadableStream `cancel()` 回调（L36）双重置位，任一触发即视为上游被取消。
- thinking 预算的默认值 / 覆盖 / `=0` / 非数字退出码契约由 `test/idle-timeout-env.ts` 以子进程方式覆盖；本文件只验证「超时后返回 JSON 429 + 级联取消上游」。
- 运行方式：`bun run test:timeouts`（等价 `bun run test/timeouts.ts`），真实耗时约 40s。
