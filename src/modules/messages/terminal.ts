import { resolveTerminal } from '../streaming/terminal'
import type { TerminalState } from '../streaming/pump'
import { idleTimeoutFor, timeoutDetails, timeoutMessage } from '../../shared/runtime'
import { log } from '../../shared/logger'
import { sendAnthropicError } from '../../shared/http'
import {
  anthropicRetryOpts,
  buildAnthropicProxyError,
  buildAnthropicTimeoutResponse,
  buildAnthropicUpstreamClosedResponse,
  buildAnthropicZeroResponse,
} from './handler-errors'

export interface MessagesTerminalInput {
  state: TerminalState
  ctx: { bytesReceived: number; lastCcEvent: string; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  apiKey: string
  sessionId: string | undefined
  model: string
  messageId: string
  streaming: boolean
  started: boolean
  effectiveInputTokens: (known: number) => number
}

/** 流终端 JSON 组装（messages 协议回调），骨架走共享 resolveTerminal。 */
export function assemble(state: TerminalState, input: MessagesTerminalInput): Response {
  const { ctx, apiKey, sessionId, model, messageId, streaming, started, effectiveInputTokens } = input
  return resolveTerminal(state, {
    upstreamError: () => {
      const ue = state.upstreamError!
      log('warn', 'CC stream error (terminal JSON)', {
        path: '/v1/messages',
        model,
        messageId,
        streaming,
        message: ue.body?.error?.message,
        mappedStatus: ue.status,
        mappedType: ue.body?.error?.type,
        lastCcEvent: ctx.lastCcEvent || '(none)',
        bytesReceived: ctx.bytesReceived,
        inputTokens: ctx.inputTokens,
        outputTokens: ctx.outputTokens,
        cachedInputTokens: ctx.cachedInputTokens,
        started,
      })
      return sendAnthropicError(ue.status, ue.body.error.type, ue.body.error.message, anthropicRetryOpts(ue.body))
    },
    timedOut: () => {
      const terminalMs = state.timedOutMs ?? idleTimeoutFor(ctx.lastCcEvent, true)
      const msg = timeoutMessage(apiKey, { sessionId, inputTokens: effectiveInputTokens(ctx.inputTokens), timeoutMs: terminalMs })
      const details = timeoutDetails(apiKey, { sessionId, timeoutMs: terminalMs })
      return buildAnthropicTimeoutResponse(msg, details)
    },
    zeroOutput: () => {
      const rawUsage = {
        input_tokens: ctx.inputTokens,
        output_tokens: ctx.outputTokens,
        cached_tokens: ctx.cachedInputTokens,
      }
      log('warn', 'Zero-output 429 (stream terminal)', {
        path: '/v1/messages',
        model,
        messageId,
        streaming,
        bytesReceived: ctx.bytesReceived,
        lastCcEvent: ctx.lastCcEvent || '(none)',
        rawUsage,
        started,
      })
      return buildAnthropicZeroResponse(rawUsage)
    },
    errorMsg: () => buildAnthropicProxyError(state.errorMsg),
    empty: () => buildAnthropicUpstreamClosedResponse(),
  })
}
