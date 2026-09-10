import { CFG } from '../shared/config'
import { getSessionId } from './session'
import { CC_VERSION } from '../shared/version'
import { fakeProjectSlug, generateTraceparent, getDateStr, getEnvironment, tryParseJSON } from '../shared/util'

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

export function buildCcRequest(openaiReq: any): any {
  const { model, messages, max_tokens, temperature, tools, reasoning_effort, tool_choice, parallel_tool_calls, prompt_cache_key, top_p, stop, user, seed } = openaiReq

  const systemMsgs = messages.filter((m: any) => m.role === 'system' || m.role === 'developer')
  const systemPrompt = systemMsgs.map((m: any) => {
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) return m.content.map((c: any) => c?.text ?? c?.content ?? '').join('\n')
    return m.content == null ? '' : String(m.content)
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
            const img: any = { type: 'image', image: url }
            const cc = pickEphemeralCacheControl(part?.cache_control)
            if (cc) img.cache_control = cc
            return img
          }
          return stripNonEphemeralCacheControl(part)
        }).filter(Boolean)
        return { role: 'user', content: parts }
      }
      return { role: 'user', content: [{ type: 'text', text: String(msg.content) }] }
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
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function?.name || '',
            input: (typeof tc.function?.arguments === 'string' ? tryParseJSON(tc.function.arguments) : (tc.function?.arguments || {})),
          })
        }
      }
      return { role: 'assistant', content: parts }
    }
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: msg.tool_call_id,
          toolName: msg.name || toolNameMap[msg.tool_call_id] || msg.tool_call_id || 'unknown_tool',
          output: { type: 'text', value: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) },
        }],
      }
    }
    return { role: 'user', content: [{ type: 'text', text: String(msg.content ?? '') }] }
  })

  const hasMessageCacheMarker = ccMessages.some((msg: any) =>
    Array.isArray(msg.content) && msg.content.some((part: any) => part?.cache_control))
  if (prompt_cache_key && !hasMessageCacheMarker) {
    const firstUserMessage = ccMessages.find((msg: any) => msg.role === 'user' && Array.isArray(msg.content))
    const cacheBoundary = firstUserMessage?.content.findLast((part: any) => part?.type === 'text')
    if (cacheBoundary) cacheBoundary.cache_control = { type: 'ephemeral' }
  }

  const body = {
    config: {
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
      max_tokens: Math.min(max_tokens || 64000, 200000),
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
    ;(body.params as any).tools = tools.map((t: any) => ({
      type: t.type || 'function',
      name: t.function?.name || t.name || '',
      description: t.function?.description || t.description || '',
      input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
    }))
  }
  if (tool_choice !== undefined) {
    if (typeof tool_choice === 'string') {
      const map: Record<string, string> = { 'auto': 'auto', 'none': 'none', 'required': 'any' }
      ;(body.params as any).tool_choice = { type: map[tool_choice] || 'auto' }
    } else if (tool_choice.type === 'function') {
      ;(body.params as any).tool_choice = { type: 'tool', name: tool_choice.function?.name }
    } else {
      ;(body.params as any).tool_choice = tool_choice
    }
  }
  if (parallel_tool_calls !== undefined) {
    ;(body.params as any).parallel_tool_calls = parallel_tool_calls
  }
  if (top_p !== undefined) {
    ;(body.params as any).top_p = top_p
  }
  if (stop !== undefined) {
    ;(body.params as any).stop = stop
  }
  if (user !== undefined) {
    ;(body.params as any).user = user
  }
  if (seed !== undefined) {
    ;(body.params as any).seed = seed
  }

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
  const sessionId = getSessionId(incomingHeaders, apiKey, promptCacheKey)

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

  if (CFG.zdr || incomingHeaders['x-cmd-zdr'] === '1') {
    headers['x-cmd-zdr'] = '1'
  }

  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
}
