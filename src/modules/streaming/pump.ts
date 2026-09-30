// modules/streaming/pump.ts — 流式 pump 协议无关骨架（仅 race/finally/idle-read）。
//
// 只抽双 handler（chat/handler.ts 250-253 + messages/handler.ts 254-257、
// finally 239-245/243-249、idle 读 150-151/167-168）逐字同形的三件套。
// translator / 心跳选项 / 零判定 / 终端 JSON 组装等协议相关一律不进此文件。
//
// 依赖白名单：../../infra/sse 仅类型 + ../../shared/http + ../../shared/runtime
// (+ ../../shared/logger 预留)。严禁 import 任何 modules/*（避免重蹈
// infra/stream-pump.ts 的 infra→modules 循环）。

import type { SsePipeline } from '../../infra/sse'
import { readWithTimeout } from '../../shared/http'
import { idleTimeoutFor } from '../../shared/runtime'

/** 终端判定状态。与双 handler 内联 state 同形（chat/handler.ts:19-25 对称 messages/handler.ts:119）。 */
export interface TerminalState {
  upstreamError: { status: number; body: any } | null
  timedOut: boolean
  timedOutMs?: number
  zeroOutput: boolean
  errorMsg: string
}

/** race 结果：'started' = 首帧已刷（走 SSE 200）；'terminal' = 先 close（走终端 JSON）。 */
export type StreamOutcome = 'started' | 'terminal'

/** 与双 handler 逐字同：Promise.race(firstOutput vs terminal)。 */
export function awaitStreamOutcome(p: SsePipeline): Promise<StreamOutcome> {
  return Promise.race([
    p.firstOutput.then(() => 'started' as const),
    p.terminal.then(() => 'terminal' as const),
  ])
}

// 最高危不变量：顺序必须是 cancel → clearInterval → close → release。
//  - cancel 先行：停掉上游 reader（止血/止计费），否则 close 后上游仍推 buffered。
//  - clearInterval 次之：停心跳定时器，避免 close 后再 sendPing。
//  - close 随后：关下游流 + resolve terminal（只 resolve terminal，绝不碰 firstOutput）。
//  - release 最后：放 gate 槽位（幂等）。终端 JSON 分支也会先放一次，此处再放是兜底。
// 与 chat/handler.ts:239-245 及 messages/handler.ts:243-249 逐字同序。
export function finalizePump(
  p: SsePipeline,
  heartbeat: ReturnType<typeof setInterval>,
  release: () => void,
): void {
  p.cancel()
  clearInterval(heartbeat)
  p.close()
  release()
}

// idle 读 = idleTimeoutFor(lastEvent, streaming) 取预算 + readWithTimeout(read, ms, tag)。
// tag 'STREAM_IDLE_TIMEOUT' 不可改：双 handler catch 侧靠 `e?.message === 'STREAM_IDLE_TIMEOUT'`
// 做字符串匹配分流（chat/handler.ts:193、messages/handler.ts:196），改 tag 即断分流。
export function idleRead<T>(read: Promise<T>, lastEvent: string, streaming: boolean): Promise<T> {
  const idleMs = idleTimeoutFor(lastEvent, streaming)
  return readWithTimeout(read, idleMs, 'STREAM_IDLE_TIMEOUT')
}
