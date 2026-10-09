// infra/tool-loop.ts — 上游流 + 代理侧工具执行的合并循环。
//
// 为什么拦截放在这一层：代理侧代执行的工具（目前是 CC 的 web 搜索）对客户端必须
// **完全不可见** —— Responses 的 web_search 是 provider-executed 内置工具，客户端
// 自己没有实现，把 tool-call 透下去它只会报「未知工具」。所以在这一层改写上游
// NDJSON：
//   1. 吞掉被代执行调用的 tool-* 事件，以及这一轮的 start/start-step/finish；
//   2. 自己执行工具（见 web-tools.ts）；
//   3. 把 assistant tool-call + tool 结果追加进上游 params.messages；
//   4. 再发一次 /alpha/generate（同一 session/threadId，保住 prompt cache）；
//   5. 把多段上游流拼成**一条连续 NDJSON** 交给下游。
//
// 好处：translator / stream-handler / non-stream-handler 完全不需要知道这件事 ——
// 它们看到的仍是一条「正常」的上游流（多段 start/finish 本来就被当作多步支持）。
//
// 红线：客户端断连（本流的 cancel 或 opts.signal）必须立刻停掉内层 fetch，绝不留下
// 还在计费的上游请求。

import { CFG } from '../shared/config'
import { buildCliHeaders } from './cc'
import { getSessionContext } from './session'
import { ccToolCallId, ccToolName } from '../shared/cc-types'
import { log } from '../shared/logger'

/** 代理侧工具执行器：拿模型入参，返回回填给模型的工具结果文本（不抛）。 */
export type ToolExecutor = (input: any, ctx: ToolExecutorContext) => Promise<string>

export interface ToolExecutorContext {
  apiKey: string
  /** 大小写归一后的入站头（buildCliHeaders 需要其中的 x-cmd-zdr）。 */
  headers: Record<string, string | undefined>
  sessionId: string
  signal: AbortSignal
}

export interface ToolLoopOptions {
  apiKey: string
  incomingHeaders: Record<string, string | undefined>
  /** 可变：内层轮次会往 params.messages 追加 assistant tool-call + tool 结果。 */
  ccBody: any
  signal: AbortSignal
  promptCacheKey?: string
  /** 工具名（CC 名，与授予给模型的 tools[].name 一致）→ 执行器。 */
  executors: Record<string, ToolExecutor>
  /** 上游 /alpha/generate 的最大轮数（1 轮 = 一次生成）。 */
  maxRounds?: number
  /** 日志用协议标签。 */
  path?: string
}

function normalizeHeaders(headers: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...headers }
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase()
    if (out[lower] === undefined) out[lower] = headers[k]
  }
  return out
}

function toObjectInput(args: any, fallback: any): any {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  return fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {}
}

function randCallId(): string {
  return `call_${Math.random().toString(36).slice(2, 12)}`
}

/**
 * 把一条上游 finish 行改写为「非工具」收尾（只动 finishReason / finish_reason）。
 *
 * 用在轮数用尽且仍有被吞掉的代执行调用时：留着 `tool-calls` 会让客户端拿到
 * `stop_reason: tool_use` 却看不到任何 tool_use 块（调用已被代理吞掉），协议自相
 * 矛盾。只替换该字段，usage 等其余内容逐字保留；解析失败则原样返回（宁可保持
 * 上游原样，也不篡改无法识别的行）。
 */
function rewriteFinishAsStop(line: string): string {
  const trimmed = line.trim()
  if (!trimmed) return line
  try {
    const ev = JSON.parse(trimmed)
    if (ev?.type !== 'finish' && ev?.type !== 'finish-step') return line
    if (ev.finishReason !== undefined) ev.finishReason = 'stop'
    if (ev.finish_reason !== undefined) ev.finish_reason = 'stop'
    return `${JSON.stringify(ev)}\n`
  } catch {
    return line
  }
}

interface PendingCall {
  id: string
  name: string
  json: string
  lines: string[]
}

/**
 * 把 first（/alpha/generate 的首轮响应）包成一条会自己「执行工具 → 续跑」的
 * NDJSON 流。executors 为空时原样返回 first（零开销）。
 */
export function wrapUpstreamWithToolLoop(first: Response, opts: ToolLoopOptions): Response {
  const executors = opts.executors || {}
  if (Object.keys(executors).length === 0) return first

  const encoder = new TextEncoder()
  const maxRounds = Math.max(1, opts.maxRounds ?? 4)
  const inbound = normalizeHeaders(opts.incomingHeaders)
  const { sessionId, threadId } = getSessionContext(inbound, opts.apiKey, opts.promptCacheKey)
  const generateUrl = `${CFG.apiBase}/alpha/generate`
  const ctx: ToolExecutorContext = { apiKey: opts.apiKey, headers: inbound, sessionId, signal: opts.signal }
  const path = opts.path || '/v1/responses'
  // 客户端断连时同时掐掉内层 fetch；与 opts.signal 取并集。
  const innerAbort = new AbortController()
  const linkOuter = (): void => { try { innerAbort.abort() } catch {} }
  if (opts.signal.aborted) linkOuter()
  else { try { opts.signal.addEventListener('abort', linkOuter, { once: true }) } catch {} }

  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const emit = (text: string): void => { if (!closed) { try { controller.enqueue(encoder.encode(text)) } catch { closed = true } } }
      const finish = (): void => { if (!closed) { closed = true; try { controller.close() } catch {} } }

      try {
        let response: Response = first
        for (let round = 1; round <= maxRounds; round++) {
          if (opts.signal.aborted || innerAbort.signal.aborted) { finish(); return }
          const reader = response.body!.getReader()
          currentReader = reader
          const decoder = new TextDecoder()
          let buffer = ''
          let text = ''
          let reasoning = ''
          const heldFinish: string[] = []
          const calls: Array<{ id: string; name: string; args: string; input: any }> = []
          let pending: PendingCall | null = null

          const flushPending = (): void => {
            if (!pending) return
            for (const l of pending.lines) emit(l)
            pending = null
          }

          const handleLine = (line: string): void => {
            const trimmed = line.trim()
            if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) { flushPending(); emit(`${line}\n`); return }
            let ev: any
            try { ev = JSON.parse(trimmed) } catch { flushPending(); emit(`${line}\n`); return }
            const type = ev?.type
            if (!type) { flushPending(); emit(`${line}\n`); return }

            if (type === 'text-delta') text += (ev.text ?? ev.delta ?? '')
            else if (type === 'reasoning-delta') reasoning += (ev.text ?? ev.delta ?? '')

            switch (type) {
              case 'tool-input-start':
                flushPending()
                pending = { id: ccToolCallId(ev), name: ccToolName(ev), json: '', lines: [`${line}\n`] }
                return
              case 'tool-input-delta': {
                if (!pending) pending = { id: ccToolCallId(ev), name: ccToolName(ev), json: '', lines: [] }
                pending.lines.push(`${line}\n`)
                const id = ccToolCallId(ev); if (id) pending.id = id
                const nm = ccToolName(ev); if (nm) pending.name = nm
                const d = ev.delta ?? ev.text ?? ev.partial_json ?? ev.partialJson
                  ?? ev.data ?? ev.json ?? ev.value ?? ev.input ?? ''
                if (typeof d === 'string') pending.json += d
                return
              }
              case 'tool-input-end':
              case 'tool-call': {
                const id = ccToolCallId(ev) || pending?.id || ''
                const name = ccToolName(ev) || pending?.name || ''
                const full = ev.type === 'tool-call' ? ev.input : (ev.input ?? ev.json)
                const args = full !== undefined && full !== null
                  ? (typeof full === 'string' ? full : JSON.stringify(full))
                  : (pending?.json || '')
                if (name && executors[name]) {
                  // 代执行：吞掉这一轮的工具事件，绝不下发未实现的调用。
                  calls.push({ id, name, args, input: toObjectInput(args, full) })
                  pending = null
                  return
                }
                flushPending()
                emit(`${line}\n`)
                return
              }
              case 'start':
              case 'start-step':
                flushPending()
                return
              case 'finish':
              case 'finish-step':
                heldFinish.push(`${line}\n`)
                return
              default:
                flushPending()
                emit(`${line}\n`)
                return
            }
          }

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const l of lines) handleLine(l)
          }
          if (buffer.trim()) handleLine(buffer)

          if (calls.length === 0 || round >= maxRounds) {
            flushPending()
            if (calls.length > 0) {
              // 轮数用尽但这一轮仍有代执行调用：这些调用已被吞掉，若把上游 finish
              // 原样下发，客户端会拿到 stop_reason=tool_use 却没有任何 tool_use 块
              // —— 协议自相矛盾（Claude Code 会当未知工具/空调用处理，甚至报错）。
              // 改成非 tool 的收尾：轮数用尽时上游最后的可见产出（文本/思考）已拼接
              // 完毕，按 end_turn 收尾才与客户端看到的内容一致。
              log('warn', 'Proxy tool loop exhausted rounds with pending calls; emitting non-tool finish', {
                path, round, maxRounds, tools: calls.map((c) => c.name),
              })
              for (const l of heldFinish) emit(rewriteFinishAsStop(l))
            } else {
              // 无代执行（正常收尾）：这一轮的 finish 原样交给下游。
              for (const l of heldFinish) emit(l)
            }
            finish()
            return
          }

          // ── 代执行 + 回填上游消息 + 续跑 ────────────────────────────────
          flushPending()
          const finalCalls = calls.map((c) => ({ ...c, id: c.id || randCallId() }))
          const messages: any[] = opts.ccBody?.params?.messages
          if (!Array.isArray(messages)) {
            log('warn', 'Tool loop: upstream messages missing, stopping', { path, round })
            for (const l of heldFinish) emit(l)
            finish()
            return
          }
          log('info', 'Proxy-executed tool round', {
            path, round, sessionId, tools: finalCalls.map((c) => c.name),
          })
          const parts: any[] = []
          if (reasoning.trim()) parts.push({ type: 'reasoning', text: reasoning.trim() })
          if (text) parts.push({ type: 'text', text })
          for (const c of finalCalls) {
            parts.push({ type: 'tool-call', toolCallId: c.id, toolName: c.name, input: c.input })
          }
          messages.push({ role: 'assistant', content: parts })
          for (const c of finalCalls) {
            const result = await executors[c.name]!(c.input, ctx)
            messages.push({
              role: 'tool',
              content: [{ type: 'tool-result', toolCallId: c.id, toolName: c.name, output: { type: 'text', value: result } }],
            })
          }

          opts.ccBody.threadId = threadId
          const timeoutSignal = AbortSignal.timeout(300_000)
          const combined = typeof (AbortSignal as any).any === 'function'
            ? (AbortSignal as any).any([innerAbort.signal, timeoutSignal])
            : innerAbort.signal
          const next = await fetch(generateUrl, {
            method: 'POST',
            headers: buildCliHeaders(opts.apiKey, sessionId, inbound),
            body: JSON.stringify(opts.ccBody),
            signal: combined,
          })
          if (!next.ok) {
            const snippet = await next.text().catch(() => '')
            log('error', 'Tool loop upstream error', { path, round, status: next.status, bodySnippet: snippet.slice(0, 200) })
            emit(`{"type":"error","error":{"message":"Upstream ${next.status} during tool round","statusCode":${next.status}}}\n`)
            finish()
            return
          }
          response = next
        }
        finish()
      } catch (e: any) {
        if (opts.signal.aborted || innerAbort.signal.aborted) { finish(); return }
        log('error', 'Tool loop failed', { path, message: e?.message ?? String(e) })
        // 已产出的字节保留；补一个上游错误帧让 translator 走错误尾，而不是静默断开。
        emit(`{"type":"error","error":{"message":"${String(e?.message ?? 'tool loop failed').replace(/["\\]/g, '')}"}}\n`)
        finish()
      }
    },
    cancel() {
      try { innerAbort.abort() } catch {}
      try { currentReader?.cancel().catch(() => {}) } catch {}
    },
  })

  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}
