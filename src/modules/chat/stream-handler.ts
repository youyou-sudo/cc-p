// modules/chat/stream-handler.ts — chat 流式分支（原 handler.ts L100-303 搬运）。
//
// 语义逐字保留，红线不变量：
//  - SsePipeline(true)：autoStart true，任意 emit 即 start（首帧即 200）。
//  - 心跳：startSseHeartbeat(pipeline, { pingEvent: SSE_KEEPALIVE_COMMENT })，comment 形
//    （OpenAI SDK 只解析 data: 行，ping JSON 会被误解析为 chunk）。
//  - pump 内 emit / emitKeepalive / getDoneEvent / writeNow 帧语义不变。
//  - 零判定谓词：sawText / sawReasoning / sawTool / outputTokens 任一即非零
//    （reasoning_content / tool_calls 文本嗅探，对称 messages 侧）。
//  - race 用 streaming/awaitStreamOutcome，finally 用 streaming/finalizePump
//    （顺序 cancel → clearInterval → close → release，close 不 resolve firstOutput）。
//  - 终端 JSON 用 chat/terminal.assemble（resolveTerminal 骨架五段顺序）。
//  - 超时 tag 'STREAM_IDLE_TIMEOUT' 不可改（catch 侧字符串匹配分流）。

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
import { createSseTranslator } from './translator'
import { assembleChatTerminal } from './terminal'

export interface ChatStreamDeps {
  ccResponse: Response
  apiKey: string
  sessionId: string
  headers: Record<string, string | undefined>
  model: string
  stream: boolean
  completionId: string
  created: number
  estimatedInputTokens: number
  signal?: AbortSignal
  flow: UpstreamFlow
  releaseUpstream: () => void
}

export async function handleChatStream(deps: ChatStreamDeps): Promise<Response> {
  const {
    ccResponse,
    apiKey,
    sessionId,
    model,
    completionId,
    created,
    estimatedInputTokens,
    flow,
    releaseUpstream,
  } = deps

  const abortController = flow.controller
  const aborted = () => flow.aborted
  const startTime = Date.now()
  let bytesReceived = 0
  let lastCcEvent = ''

  const translator = createSseTranslator(model, completionId, created)
  const pipeline = new SsePipeline(true)
  const heartbeat = startSseHeartbeat(pipeline, { pingEvent: SSE_KEEPALIVE_COMMENT })
  const state: TerminalState = { upstreamError: null, timedOut: false, zeroOutput: false, errorMsg: '' }
  // zero 口径统一：文本 / reasoning / tool 任一即非零。
  // translator 仅暴露 outputTokens（finish usage 到达前恒 0），故在 handler 侧
  // 累计 SSE 内容标记 + outputTokens 双信号，避免 reasoning-only 被误判为零输出。
  let sawText = false
  let sawReasoning = false
  let sawTool = false
  const markOutput = (events: string[]): void => {
    for (const e of events) {
      if (e.includes('reasoning_content')) sawReasoning = true
      else if (e.includes('tool_calls')) sawTool = true
      else if (e.includes('"content"')) sawText = true
    }
  }
  const effectiveInputTokens = (known: number): number => (known > 0 ? known : estimatedInputTokens)

  const onClientAbort = () => {
    if (pipeline.closed) return
    const reason = lastCcEvent.startsWith('tool-input') ? 'tool-input-silent-timeout'
      : lastCcEvent.includes('delta') ? 'streaming-active-disconnect'
      : 'client-hangup'
    log('warn', 'Client disconnected', {
      path: '/v1/chat/completions',
      model, completionId, reason,
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
    // 流中 abort → 静默 close（见 handler 文件头 499 语义注释），不再伪造 zeroUsageChunk 成功帧。
    pipeline.cancel()
    pipeline.close()
  }
  flow.setGracefulClose(onClientAbort)

  const pump = async (): Promise<void> => {
    const reader = ccResponse.body!.getReader()
    pipeline.attachReader(reader)
    try {
      while (true) {
        if (aborted()) break
        const idleMs = idleTimeoutFor(lastCcEvent, true)
        const { done, value } = await readWithTimeout(reader.read(), idleMs, 'STREAM_IDLE_TIMEOUT')
        if (done) break
        bytesReceived += value.byteLength

        const events = translator.parseChunk(value)
        if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent
        markOutput(events)
        if (events.length > 0) {
          pipeline.emit(events)
        } else {
          pipeline.emitKeepalive()
        }
      }

      if (!aborted()) {
        const flushed = translator.flush()
        if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent
        markOutput(flushed)
        if (flushed.length > 0) {
          pipeline.emit(flushed)
        }
        if (translator.upstreamError) {
          state.upstreamError = translator.upstreamError
          if (pipeline.started) {
            const errBody = translator.upstreamError.body
            pipeline.writeNow(`data: ${JSON.stringify({ ...errBody, error: { ...errBody.error, rawUsage: translator.rawUsage } })}\n\n`)
          }
        } else if (!(sawText || sawReasoning || sawTool || translator.outputTokens > 0)) {
          state.zeroOutput = true
          try { if (!abortController.signal.aborted) abortController.abort() } catch {}
          if (pipeline.started) {
            pipeline.writeNow(`data: ${JSON.stringify({ error: { message: 'Empty response from upstream (zero output tokens)', type: 'upstream_error', rawUsage: translator.rawUsage }, retry_after: 10 })}\n\n`)
          }
        } else {
          recordTimeoutSuccess(apiKey, sessionId)
          pipeline.emit([translator.getDoneEvent()])
        }
      }
    } catch (e: any) {
      if (aborted()) {
        // abort 路径统一取消上游拉取（与 messages 一致），流中不再伪造成功帧。
        pipeline.cancel()
      } else if (e?.message === 'STREAM_IDLE_TIMEOUT') {
        const idleMs = idleTimeoutFor(lastCcEvent, true)
        log('warn', 'Stream idle timeout', {
          path: '/v1/chat/completions',
          model,
          streaming: true,
          timeoutMs: idleMs,
          thinkingPhase: isThinkingWait(lastCcEvent),
          elapsedMs: Date.now() - startTime,
          id: completionId,
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
          pipeline.writeNow(`data: ${JSON.stringify({ error: { message: msg, type: 'rate_limit_error', code: 'stream_idle_timeout', consecutive_timeouts: details.consecutiveTimeouts, timeout_ms: details.timeoutMs }, retry_after: 5 })}\n\n`)
        }
      } else {
        state.errorMsg = e?.message ?? String(e)
        log('error', 'Stream error', {
          path: '/v1/chat/completions',
          model,
          completionId,
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
          pipeline.writeNow(`data: ${JSON.stringify({ error: { message: state.errorMsg, type: 'proxy_error' } })}\n\n`)
        }
      }
    } finally {
      // 终态统一：取消上游 + 清计时器 + 关下游 + 释放 gate（可选链兼容旧签名）。
      finalizePump(pipeline, heartbeat, releaseUpstream)
    }
  }

  void pump()

  const outcome = await awaitStreamOutcome(pipeline)

  // ── 5. 终态（流终端分支显式拆分，经 chat/terminal.assemble 五段） ─────────
  if (outcome === 'terminal') {
    flow.setGracefulClose(null)
    // 终端 JSON 返回前显式放 gate：pump-finally 也会放（幂等），此处先放
    // 避免 close→terminal race 时槽位多持有一个 tick。成功流分支不放。
    try { releaseUpstream() } catch {}
    if (state.upstreamError) {
      log('warn', 'CC stream error (terminal JSON)', {
        path: '/v1/chat/completions',
        model,
        completionId,
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
    return assembleChatTerminal(state, {
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
