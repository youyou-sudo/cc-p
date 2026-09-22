// modules/responses/stream-handler.ts — Responses 流式分支。
//
// 红线不变量：
//  - SsePipeline(false)：response.created/in_progress 只缓冲，首个内容事件
//    （response.output_item.added）才 start() —— 空回包保持 buffered 以回落
//    429 JSON（与 messages 侧 message_start 缓冲语义一致）。
//  - 心跳用 SSE comment（SSE_KEEPALIVE_COMMENT）：Responses SDK 只解析
//    event:/data: 行，注释帧是 spec-safe 保活。
//  - 零判定谓词：translator.sawContent（text/reasoning/tool 任一）或
//    outputTokens>0 即非零。
//  - race 用 streaming/awaitStreamOutcome，finally 用 streaming/finalizePump
//    （顺序 cancel → clearInterval → close → release）。
//  - 终端 JSON 用 responses/terminal.assemble（resolveTerminal 五段）。
//  - 超时 tag 'STREAM_IDLE_TIMEOUT' 不可改（catch 侧字符串匹配分流）。
//  - 流中 abort → 静默 close，绝不伪造 response.completed 成功帧。

import { SSE_HEADERS, readWithTimeout } from '../../shared/http'
import { log } from '../../shared/logger'
import {
  idleTimeoutFor,
  isThinkingWait,
  recordTimeout,
  recordTimeoutSuccess,
  timeoutDetails,
  timeoutMessage,
} from '../../shared/runtime'
import { SSE_KEEPALIVE_COMMENT, SsePipeline, startSseHeartbeat } from '../../infra/sse'
import type { UpstreamFlow } from '../../infra/proxy-handler'
import { awaitStreamOutcome, finalizePump } from '../streaming/pump'
import type { TerminalState } from '../streaming/pump'
import { createResponsesSseTranslator } from './translator'
import { assembleResponsesTerminal } from './terminal'

export interface ResponsesStreamDeps {
  ccResponse: Response
  apiKey: string
  sessionId: string | undefined
  model: string
  responseId: string
  createdAt: number
  estimatedInputTokens: number
  flow: UpstreamFlow
  releaseUpstream: () => void
}

export async function handleResponsesStream(deps: ResponsesStreamDeps): Promise<Response> {
  const { ccResponse, apiKey, sessionId, model, responseId, createdAt, estimatedInputTokens, flow, releaseUpstream } = deps

  const abortController = flow.controller
  const aborted = () => flow.aborted
  const startTime = Date.now()
  let bytesReceived = 0
  let lastCcEvent = ''

  const translator = createResponsesSseTranslator(model, responseId, createdAt)
  const pipeline = new SsePipeline(false)
  const heartbeat = startSseHeartbeat(pipeline, { pingEvent: SSE_KEEPALIVE_COMMENT })
  const state: TerminalState = { upstreamError: null, timedOut: false, timedOutMs: undefined, zeroOutput: false, errorMsg: '' }
  const effectiveInputTokens = (known: number): number => (known > 0 ? known : estimatedInputTokens)

  /** 缓冲 emit；首个 output_item.added 才刷响应头（零输出不变量见文件头）。 */
  const emit = (events: string[]): void => {
    if (!events.length) return
    pipeline.emit(events)
    if (!pipeline.started && events.some((e) => e.startsWith('event: response.output_item.added'))) {
      pipeline.start()
    }
  }

  const onClientAbort = () => {
    if (pipeline.closed) return
    const reason = lastCcEvent.startsWith('tool-input') ? 'tool-input-silent-timeout'
      : lastCcEvent.includes('delta') ? 'streaming-active-disconnect'
      : 'client-hangup'
    log('warn', 'Client disconnected', {
      path: '/v1/responses',
      model,
      responseId,
      reason,
      streaming: true,
      elapsedMs: Date.now() - startTime,
      bytesReceived,
      lastCcEvent: lastCcEvent || '(none)',
      keepaliveCount: pipeline.keepaliveCount,
      pingCount: pipeline.pingCount,
      inputTokens: translator.inputTokens,
      outputTokens: translator.outputTokens,
      cachedInputTokens: translator.cachedInputTokens,
    })
    // 流中 abort → 静默 close（见 handler 门面 499 语义注释）。
    pipeline.cancel()
    pipeline.close()
  }
  flow.setGracefulClose(onClientAbort)

  const pump = async (): Promise<void> => {
    const reader = ccResponse.body!.getReader()
    pipeline.attachReader(reader)
    try {
      pipeline.emit(translator.startEvents())
      while (true) {
        if (aborted()) break
        const idleMs = idleTimeoutFor(lastCcEvent, true)
        const { done, value } = await readWithTimeout(reader.read(), idleMs, 'STREAM_IDLE_TIMEOUT')
        if (done) break
        bytesReceived += value.byteLength
        const parsed = translator.parseChunk(value)
        if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent
        emit(parsed)
      }

      if (!aborted()) {
        const flushed = translator.flush()
        if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent
        emit(flushed)
        if (translator.upstreamError) {
          // 错误帧由 translator 的 error hook 产出；未 start 时留在 buffered，
          // close() 清空后走终端 JSON，绝不翻转成 SSE 200。
          state.upstreamError = translator.upstreamError
        } else if (!(translator.sawContent || translator.outputTokens > 0)) {
          state.zeroOutput = true
          try { if (!abortController.signal.aborted) abortController.abort() } catch {}
        } else {
          // 内容已确认：确保已刷头（usage-only 无 delta 的边界），再发终帧。
          pipeline.start()
          emit(translator.finishEvents())
          recordTimeoutSuccess(apiKey, sessionId)
        }
      }
    } catch (e: any) {
      if (aborted()) {
        // abort 路径统一取消上游拉取，流中不再伪造成功帧。
        pipeline.cancel()
      } else if (e?.message === 'STREAM_IDLE_TIMEOUT') {
        const idleMs = idleTimeoutFor(lastCcEvent, true)
        log('warn', 'Stream idle timeout', {
          path: '/v1/responses',
          model,
          responseId,
          streaming: true,
          timeoutMs: idleMs,
          thinkingPhase: isThinkingWait(lastCcEvent),
          elapsedMs: Date.now() - startTime,
          id: responseId,
          bytesReceived,
          lastCcEvent: lastCcEvent || '(none)',
          inputTokens: translator.inputTokens,
          outputTokens: translator.outputTokens,
          cachedInputTokens: translator.cachedInputTokens,
        })
        pipeline.cancel()
        try { abortController.abort() } catch {}
        recordTimeout(apiKey, sessionId)
        state.timedOut = true
        state.timedOutMs = idleMs
        if (pipeline.started) {
          const msg = timeoutMessage(apiKey, { sessionId, inputTokens: effectiveInputTokens(translator.inputTokens), timeoutMs: idleMs })
          const details = timeoutDetails(apiKey, { sessionId, timeoutMs: idleMs })
          pipeline.writeNow(translator.errorFrame('stream_idle_timeout', msg, {
            consecutive_timeouts: details.consecutiveTimeouts,
            timeout_ms: details.timeoutMs,
            retry_after: 5,
          }))
        }
      } else {
        state.errorMsg = e?.message ?? String(e)
        log('error', 'Stream error', {
          path: '/v1/responses',
          model,
          responseId,
          streaming: true,
          message: state.errorMsg,
          lastCcEvent: lastCcEvent || '(none)',
          bytesReceived,
          inputTokens: translator.inputTokens,
          outputTokens: translator.outputTokens,
          cachedInputTokens: translator.cachedInputTokens,
          elapsedMs: Date.now() - startTime,
        })
        try { abortController.abort() } catch {}
        if (pipeline.started) {
          pipeline.writeNow(translator.errorFrame('proxy_error', state.errorMsg))
        }
      }
    } finally {
      // 终态统一：取消上游 + 清计时器 + 关下游 + 释放 gate（幂等）。
      finalizePump(pipeline, heartbeat, releaseUpstream)
    }
  }

  void pump()

  const outcome = await awaitStreamOutcome(pipeline)

  // ── 5. 终态（流终端分支显式拆分，经 responses/terminal 五段） ─────────
  if (outcome === 'terminal') {
    flow.setGracefulClose(null)
    // 终端 JSON 返回前显式放 gate：pump-finally 也会放（幂等），此处先放
    // 避免 close→terminal race 时槽位多持有一个 tick。成功流分支不放。
    try { releaseUpstream() } catch {}
    if (state.upstreamError) {
      log('warn', 'CC stream error (terminal JSON)', {
        path: '/v1/responses',
        model,
        responseId,
        streaming: true,
        message: state.upstreamError.body?.error?.message,
        mappedStatus: state.upstreamError.status,
        mappedType: state.upstreamError.body?.error?.type,
        lastCcEvent: lastCcEvent || '(none)',
        bytesReceived,
        inputTokens: translator.inputTokens,
        outputTokens: translator.outputTokens,
        cachedInputTokens: translator.cachedInputTokens,
        started: pipeline.started,
      })
    }
    return assembleResponsesTerminal(state, {
      apiKey,
      sessionId,
      lastCcEvent,
      streaming: true,
      inputTokens: effectiveInputTokens(translator.inputTokens),
      rawUsage: translator.rawUsage,
    })
  }

  return new Response(pipeline.stream, { status: 200, headers: SSE_HEADERS })
}
