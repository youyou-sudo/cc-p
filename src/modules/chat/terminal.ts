// modules/chat/terminal.ts — chat 终端 JSON 组装（stream / non-stream 共用）。
//
// 用 streaming/resolveTerminal 骨架 + errors.ts 回调组装五段：
// upstreamError → timedOut → zeroOutput → errorMsg → empty，
// 与双 handler 终端分支对称。纯 Response 组装，不打日志（调用方在外层按原语义记账）。
// 前提不变量：SsePipeline.close() 绝不 resolve firstOutput，race 落到 'terminal' 才进此函数。

import { idleTimeoutFor, timeoutDetails, timeoutMessage } from '../../shared/runtime'
import type { TerminalState } from '../streaming/pump'
import { resolveTerminal } from '../streaming/terminal'
import {
  proxy502Response,
  timeout429Response,
  upstreamErrorResponse,
  zeroOutput429Response,
} from './errors'

export type { TerminalState }

export interface ChatTerminalContext {
  apiKey: string
  sessionId: string
  lastCcEvent: string
  streaming: boolean
  /** 流式=effectiveInputTokens(translator.inputTokens)；非流=estimatedInputTokens。 */
  inputTokens: number
  /** 流式=translator.rawUsage；非流=rawUsageFromCcUsage(usage)。 */
  rawUsage: { input_tokens: number; output_tokens: number; cached_tokens: number }
}

export function assemble(state: TerminalState, ctx: ChatTerminalContext): Response {
  return resolveTerminal(state, {
    upstreamError: () => upstreamErrorResponse(state.upstreamError!.status, state.upstreamError!.body),
    timedOut: () => {
      const terminalMs = state.timedOutMs ?? idleTimeoutFor(ctx.lastCcEvent, ctx.streaming)
      const msg = timeoutMessage(ctx.apiKey, {
        sessionId: ctx.sessionId,
        inputTokens: ctx.inputTokens,
        timeoutMs: terminalMs,
      })
      const details = timeoutDetails(ctx.apiKey, { sessionId: ctx.sessionId, timeoutMs: terminalMs })
      return timeout429Response(msg, details, ctx.inputTokens)
    },
    zeroOutput: () => zeroOutput429Response(ctx.rawUsage),
    errorMsg: () => proxy502Response(`Upstream error: ${state.errorMsg}`, ctx.inputTokens),
    empty: () => proxy502Response('Upstream closed without output', ctx.inputTokens),
  })
}

/** 别名：assembleChatTerminal === assemble（与 messages 侧 assemble 对称命名）。 */
export const assembleChatTerminal = assemble
