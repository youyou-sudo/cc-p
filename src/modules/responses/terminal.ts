// modules/responses/terminal.ts — Responses 终端 JSON 组装（stream / non-stream 共用）。
//
// 走 streaming/resolveTerminal 五段骨架：upstreamError → timedOut → zeroOutput →
// errorMsg → empty，与 chat 侧对称（Responses 外层错误形与 OpenAI 一致）。
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

export interface ResponsesTerminalContext {
  apiKey: string
  sessionId: string | undefined
  lastCcEvent: string
  streaming: boolean
  /** 流式=effectiveInputTokens(translator.inputTokens)；非流=estimatedInputTokens。 */
  inputTokens: number
  /** 流式=translator.rawUsage；非流=rawUsageFromCcUsage(usage)。 */
  rawUsage: { input_tokens: number; output_tokens: number; cached_tokens: number }
}

export function assembleResponsesTerminal(state: TerminalState, ctx: ResponsesTerminalContext): Response {
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
