import { CFG } from '../shared/config'
import { getSessionId } from './session'
import { CC_VERSION } from '../shared/version'
import { fakeProjectSlug, generateTraceparent, getDateStr, getEnvironment, tryParseJSONStrict, isJSONParseFailure, randHex } from '../shared/util'
import { log } from '../shared/logger'

/** buildCcRequest 参数非法时抛出的 400 错误，由上层统一转 invalid_request_error。 */
export class CcBadRequestError extends Error {
  status = 400
  code = 'BAD_REQUEST'
  constructor(message: string) {
    super(message)
    this.name = 'CcBadRequestError'
  }
}

function badRequest(message: string): never {
  throw new CcBadRequestError(message)
}

/**
 * 大小写不敏感的头读取 helper。
 * 不依赖框架（Elysia/Bun）是否归一化 header 大小写，统一按小写匹配。
 */
function getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  if (!headers) return undefined
  const lower = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k]
  }
  return undefined
}

/** 未知 role / 未知 content 形状的安全 stringify：数组/对象走 JSON，避免 [object Object]。 */
function stringifyUnknownContent(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content) ?? ''
  } catch {
    return String(content)
  }
}

function isEphemeralCacheControl(v: any): boolean {
  return !!v && v.type === 'ephemeral'
}

function pickEphemeralCacheControl(v: any): { type: 'ephemeral' } | undefined {
  return isEphemeralCacheControl(v) ? { type: 'ephemeral' } : undefined
}

/** 白名单剥离：仅保留 {type:'ephemeral'}，其他 type 一律丢弃（避免上游 422→400）。 */
function stripNonEphemeralCacheControl<T extends Record<string, any>>(part: T): T {
  if (!part || typeof part !== 'object' || !('cache_control' in part)) return part
  if (isEphemeralCacheControl((part as any).cache_control)) {
    return { ...(part as any), cache_control: { type: 'ephemeral' } }
  }
  const { cache_control: _dropped, ...rest } = part as any
  return rest as T
}

const MAX_TOKENS_DEFAULT = 64000
const MAX_TOKENS_HARD_LIMIT = 200000

function resolveMaxTokens(openaiReq: any): number {
  const raw = openaiReq.max_tokens ?? openaiReq.max_completion_tokens
  if (raw === undefined || raw === null || raw === 0 || raw === '') {
    log('debug', 'cc max_tokens default', { reason: 'undefined_or_zero', default: MAX_TOKENS_DEFAULT })
    return MAX_TOKENS_DEFAULT
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    badRequest(`Invalid max_tokens: ${JSON.stringify(raw)} (expected finite number)`)
  }
  if (n < 0) {
    badRequest(`Invalid max_tokens: ${JSON.stringify(raw)} (must be >= 0)`)
  }
  if (n === 0) {
    log('debug', 'cc max_tokens default', { reason: 'zero', default: MAX_TOKENS_DEFAULT })
    return MAX_TOKENS_DEFAULT
  }
  if (n > MAX_TOKENS_HARD_LIMIT) {
    log('warn', 'cc max_tokens clamped', { requested: n, clamped: MAX_TOKENS_HARD_LIMIT })
    return MAX_TOKENS_HARD_LIMIT
  }
  return Math.floor(n)
}

function assertTemperature(v: any): void {
  if (v === undefined) return
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 2) {
    badRequest(`Invalid temperature: ${JSON.stringify(v)} (expected 0..2)`)
  }
}

function assertTopP(v: any): void {
  if (v === undefined) return
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    badRequest(`Invalid top_p: ${JSON.stringify(v)} (expected 0..1)`)
  }
}

function assertSeed(v: any): void {
  if (v === undefined) return
  if (!Number.isInteger(v)) {
    badRequest(`Invalid seed: ${JSON.stringify(v)} (expected integer)`)
  }
}

function normalizeStop(stop: any): any {
  if (stop === undefined) return undefined
  if (typeof stop === 'string') return [stop]
  if (Array.isArray(stop)) {
    for (const s of stop) {
      if (typeof s !== 'string') {
        badRequest(`Invalid stop: expected string|string[], got ${JSON.stringify(stop)}`)
      }
    }
    return stop
  }
  badRequest(`Invalid stop: expected string|string[], got ${JSON.stringify(stop)}`)
}

export function buildCcRequest(openaiReq: any): any {
  const { model, messages, max_tokens, temperature, tools, reasoning_effort, tool_choice, parallel_tool_calls, prompt_cache_key, top_p, stop, user, seed } = openaiReq

  if (!Array.isArray(messages)) {
    badRequest('Invalid messages: expected array')
  }

  // 范围校验：非法直接抛 400，由上层转 invalid_request_error。
  assertTemperature(temperature)
  assertTopP(top_p)
  assertSeed(seed)
  const normalizedStop = normalizeStop(stop)
  const resolvedMaxTokens = resolveMaxTokens(openaiReq)

  const systemMsgs = messages.filter((m: any) => m.role === 'system' || m.role === 'developer')
  const systemPrompt = systemMsgs.map((m: any) => {
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) return m.content.map((c: any) => c?.text ?? c?.content ?? '').join('\n')
    return m.content == null ? '' : stringifyUnknownContent(m.content)
  }).join('\n')
  const chatMessages = messages.filter((m: any) => m.role !== 'system' && m.role !== 'developer')

  const toolNameMap: Record<string, string> = {}
  for (const msg of chatMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          toolNameMap[tc.id] = tc.function?.name || ''
        }
      }
    }
  }

  const ccMessages = chatMessages.map((msg: any) => {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        return { role: 'user', content: [{ type: 'text', text: msg.content }] }
      }
      if (Array.isArray(msg.content)) {
        const parts = msg.content.map((part: any) => {
          if (part.type === 'image_url') {
            const url = part.image_url?.url || ''
            if (!url) {
              log('warn', 'cc image omitted: empty url', {})
              return null
            }
            if (typeof url === 'string' && url.startsWith('data:') && url.length > 10 * 1024 * 1024) {
              log('warn', 'cc image large dataURL', { bytes: url.length })
            }
            const img: any = { type: 'image', image: url }
            const cc = pickEphemeralCacheControl(part?.cache_control)
            if (cc) img.cache_control = cc
            return img
          }
          return stripNonEphemeralCacheControl(part)
        }).filter(Boolean)
        if (parts.length === 0) {
          return { role: 'user', content: [{ type: 'text', text: '[image omitted: empty url]' }] }
        }
        return { role: 'user', content: parts }
      }
      return { role: 'user', content: [{ type: 'text', text: stringifyUnknownContent(msg.content) }] }
    }
    if (msg.role === 'assistant') {
      const parts: any[] = []
      if (msg.content && typeof msg.content === 'string') {
        parts.push({ type: 'text', text: msg.content })
      } else if (msg.content && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') parts.push(stripNonEphemeralCacheControl(part))
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let toolCallId = tc.id
          if (!toolCallId) {
            toolCallId = `call_${randHex(8)}`
            log('warn', 'cc tool_call missing id, generated fallback', { fallback: toolCallId, toolName: tc.function?.name || '' })
          }
          const rawArgs = tc.function?.arguments
          let input: any
          if (typeof rawArgs === 'string') {
            const parsed = tryParseJSONStrict(rawArgs)
            if (isJSONParseFailure(parsed)) {
              log('warn', 'cc tool arguments parse failed, passthrough raw', { raw: rawArgs.slice(0, 200), message: parsed.message })
              input = rawArgs
            } else {
              input = parsed
            }
          } else {
            input = (rawArgs || {})
          }
          parts.push({
            type: 'tool-call',
            toolCallId,
            toolName: tc.function?.name || '',
            input,
          })
        }
      }
      return { role: 'assistant', content: parts }
    }
    if (msg.role === 'tool') {
      const hasExplicitName = !!msg.name
      const mappedName = toolNameMap[msg.tool_call_id]
      const toolName = msg.name || mappedName || msg.tool_call_id || 'unknown_tool'
      if (!hasExplicitName && !mappedName) {
        log('warn', 'cc tool-result unknown_tool fallback', { tool_call_id: msg.tool_call_id || '' })
      }
      return {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: msg.tool_call_id,
          toolName,
          output: { type: 'text', value: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) },
        }],
      }
    }
    log('warn', 'cc unknown role mapped to user', { role: msg.role })
    return { role: 'user', content: [{ type: 'text', text: stringifyUnknownContent(msg.content ?? '') }] }
  })

  const hasMessageCacheMarker = ccMessages.some((msg: any) =>
    Array.isArray(msg.content) && msg.content.some((part: any) => part?.cache_control))
  if (prompt_cache_key && !hasMessageCacheMarker) {
    const firstUserMessage = ccMessages.find((msg: any) => msg.role === 'user' && Array.isArray(msg.content))
    const cacheBoundary = firstUserMessage?.content.findLast((part: any) => part?.type === 'text')
    if (cacheBoundary) cacheBoundary.cache_control = { type: 'ephemeral' }
  } else if (prompt_cache_key && hasMessageCacheMarker) {
    // 双源并存时优先显式 cache_control（已存在标记则不再按 prompt_cache_key 注入）。
    log('debug', 'cc cache prefers explicit cache_control over prompt_cache_key', {})
  }

  const body = {
    config: {
      // workingDir / environment 为 CLI 仿真必需：上游按真实 CLI 请求计费/风控，
      // 缺失或伪造不一致会导致指纹异常；此处保留当前进程值以模拟 CLI 环境。
      workingDir: process.cwd(),
      date: getDateStr(),
      environment: getEnvironment(),
      structure: [] as string[],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [] as string[],
    },
    memory: null,
    taste: null,
    skills: '',
    permissionMode: 'standard',
    params: {
      model: model || 'deepseek/deepseek-v4-flash',
      messages: ccMessages,
      max_tokens: resolvedMaxTokens,
      stream: true,
    },
  }

  // fixes #17: no system/developer prompt -> send single-space placeholder,
  // avoids upstream injecting ~7.5K default prompt (prompt_tokens 7653->85).
  // Disable via config.json emptySystemPlaceholder=false or CC_EMPTY_SYSTEM_PLACEHOLDER=false.
  if (systemPrompt) {
    ;(body.params as any).system = systemPrompt
  } else if (CFG.emptySystemPlaceholder) {
    ;(body.params as any).system = ' '
  }
  if (temperature !== undefined) {
    ;(body.params as any).temperature = temperature
  }
  if (reasoning_effort !== undefined) {
    ;(body.params as any).reasoning_effort = reasoning_effort
  }
  if (tools && tools.length > 0) {
    ;(body.params as any).tools = tools.map((t: any) => {
      const name = t.function?.name || t.name || ''
      if (name === '') {
        badRequest('Invalid tools: function name must not be empty')
      }
      const hasParams = t.function?.parameters !== undefined || t.input_schema !== undefined
      const input_schema = t.function?.parameters ?? t.input_schema ?? { type: 'object', properties: {} }
      if (!hasParams) {
        log('debug', 'cc tools missing parameters, using default', { name })
      }
      const out: any = {
        type: t.type || 'function',
        name,
        description: t.function?.description || t.description || '',
        input_schema,
      }
      const strict = t.function?.strict ?? (t as any)?.strict
      if (strict !== undefined) out.strict = strict
      return out
    })
  }
  if (tool_choice !== undefined) {
    if (typeof tool_choice === 'string') {
      const map: Record<string, string> = { 'auto': 'auto', 'none': 'none', 'required': 'any' }
      ;(body.params as any).tool_choice = { type: map[tool_choice] || 'auto' }
    } else if (tool_choice && tool_choice.type === 'function') {
      const out: any = { type: 'tool', name: tool_choice.function?.name }
      // 显式透传并行/白名单开关，未知键也不丢（避免静默降级）。
      if (tool_choice.allowed_tools !== undefined) out.allowed_tools = tool_choice.allowed_tools
      if (tool_choice.disable_parallel_tool_use !== undefined) out.disable_parallel_tool_use = tool_choice.disable_parallel_tool_use
      for (const k of Object.keys(tool_choice)) {
        if (!(k in out) && k !== 'type' && k !== 'function') out[k] = tool_choice[k]
      }
      ;(body.params as any).tool_choice = out
    } else {
      // 未知对象（含 allowed_tools / disable_parallel_tool_use）整体透传不丢。
      ;(body.params as any).tool_choice = tool_choice
    }
  }
  if (parallel_tool_calls !== undefined) {
    ;(body.params as any).parallel_tool_calls = parallel_tool_calls
  }
  if (top_p !== undefined) {
    ;(body.params as any).top_p = top_p
  }
  if (normalizedStop !== undefined) {
    ;(body.params as any).stop = normalizedStop
  }
  if (user !== undefined) {
    ;(body.params as any).user = user
  }
  if (seed !== undefined) {
    ;(body.params as any).seed = seed
  }
  void max_tokens

  return body
}

export async function forwardToCC(
  body: any,
  apiKey: string,
  incomingHeaders: Record<string, string | undefined>,
  signal: AbortSignal,
  promptCacheKey?: string,
): Promise<Response> {
  const url = `${CFG.apiBase}/alpha/generate`
  // session 查找同样走大小写不敏感归一，避免框架未归一化时取不到显式 session。
  const normalizedForSession: Record<string, string | undefined> = { ...incomingHeaders }
  for (const k of Object.keys(incomingHeaders)) {
    const lower = k.toLowerCase()
    if (normalizedForSession[lower] === undefined) normalizedForSession[lower] = incomingHeaders[k]
  }
  const sessionId = getSessionId(normalizedForSession, apiKey, promptCacheKey)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'x-cli-environment': 'production',
    'x-command-code-version': CC_VERSION,
    'x-session-id': sessionId,
    'x-co-flag': 'false',
    'x-taste-learning': 'false',
    'x-project-slug': fakeProjectSlug(sessionId),
    'traceparent': generateTraceparent(),
  }

  // generate 侧统一 ZDR：CFG.zdr || 请求头 x-cmd-zdr==='1'（大小写不敏感）。
  if (CFG.zdr || getHeader(incomingHeaders, 'x-cmd-zdr') === '1') {
    headers['x-cmd-zdr'] = '1'
  }

  // 总超时 300s，与调用方 signal 级联：任一 abort 即取消 fetch。
  const timeoutSignal = AbortSignal.timeout(300_000)
  const combinedSignal = typeof (AbortSignal as any).any === 'function'
    ? (AbortSignal as any).any([signal, timeoutSignal])
    : signal

  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    })
  } catch (e: any) {
    // 客户端断连必须透传 Abort，由上层转 499/停泵，绝不能变成 502。
    if (signal.aborted) throw e
    if (e?.name === 'AbortError' && signal.aborted) throw e
    const msg = e?.message ?? String(e)
    const causeCode = (e?.cause as any)?.code ? String((e.cause as any).code) : ''
    const hay = `${msg} ${causeCode}`
    const ctx = { apiBase: CFG.apiBase }
    if (timeoutSignal.aborted || e?.name === 'TimeoutError') {
      log('error', 'CC fetch timeout', { ...ctx, message: msg })
    } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(hay)) {
      log('error', 'CC fetch DNS error', { ...ctx, message: msg, code: causeCode || undefined })
    } else if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE/i.test(hay)) {
      log('error', 'CC fetch connection error', { ...ctx, message: msg, code: causeCode || undefined })
    } else {
      log('error', 'CC fetch failed', { ...ctx, message: msg })
    }
    // 固定外发文案，不泄 IP/内网细节；分类细节只进日志。
    throw new Error('Upstream fetch failed')
  }
}
