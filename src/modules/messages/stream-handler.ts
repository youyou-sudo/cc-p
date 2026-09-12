import { SsePipeline, startSseHeartbeat } from '../../infra/sse'
import type { UpstreamFlow } from '../../infra/proxy-handler'
import { log } from '../../shared/logger'
import { idleTimeoutFor, isThinkingWait, recordTimeout, recordTimeoutSuccess, timeoutDetails, timeoutMessage } from '../../shared/runtime'
import { readWithTimeout } from '../../shared/http'
import { SSE_HEADERS } from '../../shared/http'
import { uuid } from '../../shared/util'
import { awaitStreamOutcome, finalizePump } from '../streaming/pump'
import type { TerminalState } from '../streaming/pump'
import { createAnthropicSseTranslator } from './translator'
import type { AnthropicStreamContext } from './translator'
import { assemble } from './terminal'
import { buildAnthropicErrorFrame, buildAnthropicTimeoutFrame } from './handler-errors'

export interface MessagesStreamDeps {
  ccResponse: Response
  apiKey: string
  sessionId: string | undefined
  model: string
  estimatedInputTokens: number
  startTime: number
  flow: UpstreamFlow
  abortController: AbortController
  aborted: () => boolean
  releaseUpstream: () => void
  /** 可变回写：pump 内分配 messageId 后同步回门面，供外层 catch 日志用。 */
  messageIdHolder: { current: string }
}

/** 流式分支（原 handler.ts L116-317 纯搬运，race/finally 走共享，终端走 assemble）。 */
export async function handleMessagesStream(deps: MessagesStreamDeps): Promise<Response> {
  const { ccResponse, apiKey, sessionId, model, estimatedInputTokens, startTime, flow, abortController, aborted, releaseUpstream, messageIdHolder } = deps
  const pipeline = new SsePipeline(false)
  const ctx: AnthropicStreamContext = { bytesReceived: 0, lastCcEvent: '', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, upstreamError: null }
  const state: TerminalState = { upstreamError: null, timedOut: false, timedOutMs: undefined, zeroOutput: false, errorMsg: '' }
  // zero 口径统一：文本 / thinking / tool 任一即非零。
  // ctx.outputTokens 只统计 text（+1）/ tool（+20），reasoning-delta 不计入，
  // 故在 handler 侧累计 SSE 内容标记，避免 reasoning-only 被误判为零输出。
  let sawText = false
  let sawReasoning = false
  let sawTool = false
  const markOutput = (events: string[]): void => {
    for (const e of events) {
      if (e.includes('thinking_delta') || e.includes('"type":"thinking"') || e.includes('signature_delta')) sawReasoning = true
      else if (e.includes('input_json_delta') || e.includes('tool_use')) sawTool = true
      else if (e.includes('text_delta') || e.includes('"type":"text"')) sawText = true
    }
  }
  const effectiveInputTokens = (known: number): number => (known > 0 ? known : estimatedInputTokens)

  const onClientAbort = () => {
    if (pipeline.closed) return
    log('warn', 'Client disconnected', {
      path: '/v1/messages',
      model,
      messageId: messageIdHolder.current,
      streaming: true,
      elapsedMs: Date.now() - startTime,
      bytesReceived: ctx.bytesReceived,
      lastCcEvent: ctx.lastCcEvent || '(none)',
      inputTokens: ctx.inputTokens,
      outputTokens: ctx.outputTokens,
      cachedInputTokens: ctx.cachedInputTokens,
    })
    // 流中 abort → 静默 close（见 handler 门面 499 语义注释），不再伪造零 usage 成功帧。
    pipeline.cancel()
    pipeline.close()
  }
  flow.setGracefulClose(onClientAbort)

  const heartbeat = startSseHeartbeat(pipeline)
  const pump = async (): Promise<void> => {
    const reader = ccResponse.body!.getReader()
    pipeline.attachReader(reader)
    try {
      const messageId = 'msg_' + uuid().slice(0, 12)
      messageIdHolder.current = messageId
      const translator = createAnthropicSseTranslator(model, messageId, ctx)
      const startEvents = translator.startEvents()
      markOutput(startEvents)
      pipeline.emitAnthropic(startEvents)
      while (true) {
        if (aborted()) break
        const idleMs = idleTimeoutFor(ctx.lastCcEvent, true)
        const { done, value } = await readWithTimeout(reader.read(), idleMs, 'STREAM_IDLE_TIMEOUT')
        if (done) break
        const parsed = translator.parseChunk(value)
        markOutput(parsed)
        pipeline.emitAnthropic(parsed)
      }

      if (!aborted()) {
        const flushed = translator.flush()
        markOutput(flushed)
        pipeline.emitAnthropic(flushed)
        const finished = translator.finishEvents()
        markOutput(finished)
        pipeline.emitAnthropic(finished)
        recordTimeoutSuccess(apiKey, sessionId)
        if (ctx.upstreamError) {
          state.upstreamError = ctx.upstreamError
        } else if (!(sawText || sawReasoning || sawTool || ctx.outputTokens > 0)) {
          state.zeroOutput = true
          try { abortController.abort() } catch {}
        } else {
          pipeline.start()
        }
      }
    } catch (e: any) {
      if (aborted()) {
        // abort 路径统一取消上游拉取（与 chat 一致），流中不再伪造成功帧。
        pipeline.cancel()
      } else if (e?.message === 'STREAM_IDLE_TIMEOUT') {
        const idleMs = idleTimeoutFor(ctx.lastCcEvent, true)
        log('warn', 'Stream idle timeout', {
          path: '/v1/messages',
          model,
          messageId: messageIdHolder.current,
          streaming: true,
          timeoutMs: idleMs,
          thinkingPhase: isThinkingWait(ctx.lastCcEvent),
          elapsedMs: Date.now() - startTime,
          id: messageIdHolder.current,
          bytesReceived: ctx.bytesReceived,
          lastCcEvent: ctx.lastCcEvent || '(none)',
          inputTokens: ctx.inputTokens,
          outputTokens: ctx.outputTokens,
          cachedInputTokens: ctx.cachedInputTokens,
        })
        pipeline.cancel()
        try { abortController.abort() } catch {}
        recordTimeout(apiKey, sessionId)
        state.timedOut = true
        state.timedOutMs = idleMs
        if (pipeline.started) {
          const msg = timeoutMessage(apiKey, { sessionId, inputTokens: effectiveInputTokens(ctx.inputTokens), timeoutMs: idleMs })
          const details = timeoutDetails(apiKey, { sessionId, timeoutMs: idleMs })
          pipeline.writeNow(buildAnthropicTimeoutFrame(msg, details))
        }
      } else {
        state.errorMsg = e?.message ?? String(e)
        log('error', 'Anthropic stream error', {
          path: '/v1/messages',
          model,
          messageId: messageIdHolder.current,
          streaming: true,
          message: state.errorMsg,
          lastCcEvent: ctx.lastCcEvent || '(none)',
          bytesReceived: ctx.bytesReceived,
          inputTokens: ctx.inputTokens,
          outputTokens: ctx.outputTokens,
          cachedInputTokens: ctx.cachedInputTokens,
          elapsedMs: Date.now() - startTime,
        })
        try { abortController.abort() } catch {}
        if (pipeline.started) {
          pipeline.writeNow(buildAnthropicErrorFrame(state.errorMsg))
        }
      }
    } finally {
      // 终态统一：取消上游 + 清计时器 + 关下游 + 释放 gate（可选链兼容旧签名）。
      finalizePump(pipeline, heartbeat, releaseUpstream)
    }
  }

  void pump()

  const outcome = await awaitStreamOutcome(pipeline)

  // ── 5. 终态（流终端分支显式拆分） ─────────────────────────────────
  if (outcome === 'terminal') {
    flow.setGracefulClose(null)
    // 终端 JSON 返回前显式放 gate：pump-finally 也会放（幂等），此处先放
    // 避免 close→terminal race 时槽位多持有一个 tick。成功流分支不放。
    try { releaseUpstream() } catch {}
    return assemble(state, {
      state,
      ctx,
      apiKey,
      sessionId,
      model,
      messageId: messageIdHolder.current,
      streaming: true,
      started: pipeline.started,
      effectiveInputTokens,
    })
  }

  return new Response(pipeline.stream, { status: 200, headers: SSE_HEADERS })
}
