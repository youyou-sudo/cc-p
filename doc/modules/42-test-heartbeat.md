# 模块报告：test/heartbeat.ts

| 属性 | 值 |
|---|---|
| 路径 | `test/heartbeat.ts` |
| 行数 | 89 |
| 层级 | 测试 |
| 依赖 | `../src/infra/sse.ts`（`SSE_PING_EVENT`/`SsePipeline`/`startSseHeartbeat`） |
| 被依赖 | 无（独立入口脚本） |

## 职责

- 单元验证 `startSseHeartbeat` 的心跳发送条件：仅向客户端 SSE 写 ping，不触碰上游空闲计时。
- 覆盖四种状态闸门：已开播且空闲才发、未开播不发、已关闭不发、未到 idle 窗口不发。
- 验证 Anthropic 默认 ping 帧（`event: ping`）与 OpenAI 自定义 ping 帧（注释 `: keepalive`）的形状与计数。
- 用真实计时器（`intervalMs:20`/`idleMs:50`）在毫秒级快速跑完，无需网络。

## 代码段映射

| 行号 | 符号/段落 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | import | import | — | 从 `../src/infra/sse.ts` 引入 `SSE_PING_EVENT`、`SsePipeline`、`startSseHeartbeat` |
| 3-7 | `check(name, cond, extra?)` | 断言 | P | PASS/FAIL 计数，失败时打印 JSON 化 extra |
| 9 | `dec` | 工具 | P | 模块级 `TextDecoder` 单例 |
| 11-23 | `readOne(p, timeoutMs=200)` | 工具 | P | 读取 SSE 流的一帧，`Promise.race` 与 `Bun.sleep` 竞速超时返回 `''`，finally 释放 reader 锁 |
| 25-30 | 心跳保活语义注释 | 输出 | — | 说明心跳只保下游不续租上游：思考期仍由 `CC_THINKING_IDLE_MS`（默认 120s）裁决 |
| 31-43 | 用例组①：idle → ping | 用例组 | P | `SsePipeline(false)` + `start()` + 心跳（20/50）sleep160 → 断言帧含 `event: ping` 与 `"type":"ping"`、`pingCount>0`、`SSE_PING_EVENT` 默认形状 |
| 44-52 | 用例组②：unstarted → no ping | 用例组 | P | 不调 `start()`，sleep140 → `pingCount===0`（zero-output 可重试不变式：缓冲期保 JSON） |
| 53-62 | 用例组③：closed → no ping | 用例组 | P | `start()` 后立即 `close()`，sleep140 → `pingCount===0` |
| 63-74 | 用例组④：custom pingEvent | 用例组 | P | `pingEvent:': keepalive\n\n'`，sleep160 → 帧含 `: keepalive` 且不含 `event: ping`、`pingCount>0` |
| 75-84 | 用例组⑤：no idle → no ping | 用例组 | P | `idleMs:10_000`，sleep120 → `pingCount===0`（刚写入后 `lastSentAt` 刷新，窗口内不发） |
| 86-89 | 结果 / 导出 | 输出 | E | `RESULT: N passed, M failed`；`fail>0` → `process.exit(1)`；`export {}` |

## 关键行为

- 每个用例的 SsePipeline 独立创建/关闭，避免计时器跨用例干扰；`clearInterval(hb)` 显式停止心跳。
- 用例③断言 `close()` 后心跳闸门关闭，用例⑤断言 `lastSentAt` 更新会推迟 ping，二者共同约束「仅在已开播且持续空闲达到 `idleMs` 时才发」。
- `readOne` 的 200ms 默认超时大于所有用例的 busy 等待，保证能读到已入队帧。
- 运行方式：`bun run test:heartbeat`（等价 `bun run test/heartbeat.ts`）。
