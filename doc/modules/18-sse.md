# 模块报告：src/infra/sse.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/infra/sse.ts` |
| 行数 | 138 |
| 层级 | 共享管道层 |
| 依赖 | 无（本文件不 import 任何模块） |
| 被依赖 | `src/modules/chat/handler.ts`、`src/modules/messages/handler.ts`、`test/heartbeat.ts` |

## 职责

- 提供协议无关的 `SsePipeline`：封装可写 `ReadableStream<Uint8Array>` 的缓冲、开播、保活、终止语义。
- 提供共享的空闲心跳定时器 `startSseHeartbeat`：流静默超过 `idleMs` 时发送 ping。
- 导出心跳相关常量（间隔、空闲阈值、ping 事件、keepalive 注释）。
- 协议专用翻译器不在此处：OpenAI 的 `chat.completion.chunk` 翻译器已移至 `src/modules/chat/translator.ts`。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 8 | `SSE_HEARTBEAT_INTERVAL_MS` | 常量 | E | `5_000`，心跳检查间隔 5s |
| 9 | `SSE_HEARTBEAT_IDLE_MS` | 常量 | E | `15_000`，静默超过 15s 才发 ping |
| 10 | `SSE_PING_EVENT` | 常量 | E | `event: ping\ndata: {"type":"ping"}\n\n`，Anthropic 原生 ping |
| 11 | `SSE_KEEPALIVE_COMMENT` | 常量 | E | `: keepalive\n\n`，OpenAI 路径使用的 SSE 注释心跳 |
| 13-118 | `SsePipeline` | class | E | 可控 SSE 发送管道 |
| 14 | └ `encoder` | 字段 | P | `TextEncoder` 实例 |
| 15 | └ `controller` | 字段 | P | `ReadableStreamDefaultController<Uint8Array>`，`start` 时注入 |
| 16 | └ `buffered` | 字段 | P | 开播前的事件缓冲 |
| 17 | └ `firstOutputResolve` | 字段 | P | `firstOutput` Promise 的 resolve |
| 18 | └ `terminalResolve` | 字段 | P | `terminal` Promise 的 resolve |
| 20 | └ `stream` | 字段 | P | 对外暴露的 `ReadableStream<Uint8Array>`（readonly） |
| 21 | └ `firstOutput` | 字段 | P | 首次真正写出（start）时 resolve |
| 22 | └ `terminal` | 字段 | P | 关闭（close）时 resolve |
| 23 | └ `started` | 字段 | P | 是否已开播 |
| 24 | └ `closed` | 字段 | P | 是否已关闭 |
| 25 | └ `keepaliveCount` | 字段 | P | keepalive 注释帧计数 |
| 26 | └ `pingCount` | 字段 | P | ping 帧计数 |
| 27 | └ `lastSentAt` | 字段 | P | 最近写出时间戳，心跳据此判断空闲 |
| 29-35 | └ `constructor(autoStart)` | 方法 | P | 建立两个 Promise 与 ReadableStream（`start` 注入 controller） |
| 37-42 | └ `enqueue(text)` | 方法 | P | 编码入队并更新 `lastSentAt`；controller 关闭时静默吞异常 |
| 44-51 | └ `emit(events)` | 方法 | P | 已开播则即时入队，否则压入 `buffered`；`autoStart` 时自动 `start()` |
| 53-69 | └ `emitAnthropic(events)` | 方法 | P | Anthropic 早冲刷：`message_start` 等保持缓冲以保留零输出重试能力；仅当事件以 `event: content_block_` 开头才 `start()`（注释见 53-58） |
| 71-75 | └ `emitKeepalive()` | 方法 | P | 仅在已开播且未关闭时发送 `SSE_KEEPALIVE_COMMENT` 并计数 |
| 77-86 | └ `sendPing(event=SSE_PING_EVENT)` | 方法 | P | 空闲心跳 ping，计数；注释说明 OpenAI 路径会覆盖为注释帧（77-81） |
| 88-90 | └ `writeNow(event)` | 方法 | P | 绕过缓冲直接 `enqueue`（错误帧等场景） |
| 92-98 | └ `start()` | 方法 | P | 置 `started`，冲刷 `buffered`，resolve `firstOutput`；已开播/已关闭则直接返回 |
| 100-107 | └ `close()` | 方法 | P | 置 `closed`，关 controller，resolve `terminal` |
| 109-117 | └ `terminateWith(events)` | 方法 | P | 置 `started` → 冲刷缓冲 → 写出终止事件 → resolve `firstOutput` → `close()`（客户端断连优雅收尾） |
| 120-138 | `startSseHeartbeat(pipeline, opts?)` | 函数 | E | 定时器：已关闭/未开播则跳过，`Date.now()-lastSentAt > idleMs` 时 `sendPing(pingEvent)`；间隔/空闲/ping 事件可被 `opts` 覆盖 |

## 关键行为

- 缓冲语义：未 `start` 前所有事件进入 `buffered`，`start()` 时按序冲刷（95-96），因此零输出错误可在未开播时用 `terminateWith` 返回 JSON 而非 SSE 200。
- `emitAnthropic` 与 `emit` 的差别仅在自动开播条件：前者只在 `content_block_*` 事件时开播（66），保证空响应 error 事件不误开流。
- `startSseHeartbeat` 只在已开播后才可能发 ping（133-134），且在管线关闭后停止（133）。
- 调用方负责在 `finally` 中 `clearInterval` 该定时器。
