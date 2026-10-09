// Unit tests for the resilience modules (no network; run with `bun run test/unit.ts`).
// Covers: upstream-limit classification, retry/backoff math, the per-key
// concurrency gate, errors.ts integration (incl. Retry-After passthrough),
// and the responses protocol pure functions (request conversion / response
// object / SSE terminal).

// 本文件导入 responses 翻译层，会经 logger 传递加载 src/shared/config.ts；
// 固定一个合法 PORT，避免调用方环境里的非法 PORT（如 PORT=0）触发 config
// die() 让纯函数断言尚未执行就退出（其余测试脚本同样在顶部固定 env）。
if (!/^\d+$/.test(process.env.PORT ?? '') || Number(process.env.PORT) < 1) process.env.PORT = '3050'

import { classifyUpstreamLimit, limitMeta } from '../src/shared/limit'
import { parseRetryAfter, backoffDelay } from '../src/shared/retry'
import { ConcurrencyGate, ConcurrencyAborted, ConcurrencyRoomFull, ConcurrencyTimeout } from '../src/shared/concurrency'
import { mapCcError, mapCcEventError, toRetryAfterSeconds } from '../src/shared/errors'
import { normalizeCcUsage, ccToolName, ccToolCallId, ccToolArgsToString, createToolCallIdGuard, UNKNOWN_TOOL_NAME } from '../src/shared/cc-types'
import { generateSessionId, uuidFromSeed } from '../src/shared/util'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++
    console.log(`PASS ${name}`)
  } else {
    failed++
    console.log(`FAIL ${name}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`)
  }
}

// limit classification
{
  check('429 rate limit', classifyUpstreamLimit(429, 'Rate limit exceeded. Please wait') === 'rate_limit')
  check('429 5-hour usage window', classifyUpstreamLimit(429, "You've reached your 5-hour usage limit") === 'usage_window_5h')
  check('429 weekly usage window', classifyUpstreamLimit(429, 'You hit the weekly cap. Resets in 2d') === 'usage_window_weekly')
  check('400 prompt too long', classifyUpstreamLimit(400, 'prompt is too long') === 'context_overflow')
  check('400 context overflow', classifyUpstreamLimit(400, 'input is too large') === 'context_overflow')
  check('402 payment', classifyUpstreamLimit(402, 'no credits') === 'payment_required')
  check('403 session refused', classifyUpstreamLimit(403, 'session invalid') === 'authed_session_refused')
  check('500 unknown', classifyUpstreamLimit(500, 'boom') === 'unknown')

  const rl = limitMeta(429, 'rate limit exceeded', null)
  check('rate_limit retryable', rl.retryable === true)
  check('rate_limit absent Retry-After -> null (backoff decides)', rl.retryAfterMs === null, rl)

  const w = limitMeta(429, "You've reached your 5-hour usage limit", null)
  check('usage window NOT retryable', w.retryable === false)

  const co = limitMeta(400, 'prompt too long', null)
  check('context overflow NOT retryable', co.retryable === false)

  const rlHeader = limitMeta(429, 'rate limit', 5)
  check('rate_limit honors Retry-After header', rlHeader.retryAfterMs === 5000)

  // HTTP 层 5xx / 408 可重试（对齐官方 CLI 的 isRetryableStatus）；业务终局类
  // 即使挂 5xx 状态也不重试（classify 已把它们归到各自 kind）。
  check('500 retryable', limitMeta(500, 'boom', null).retryable === true)
  check('502 retryable', limitMeta(502, 'bad gateway', null).retryable === true)
  check('503 retryable', limitMeta(503, 'unavailable', null).retryable === true)
  check('504 retryable', limitMeta(504, 'gateway timeout', null).retryable === true)
  check('408 retryable', limitMeta(408, 'request timeout', null).retryable === true)
  check('5xx payment wording stays non-retryable', limitMeta(503, 'insufficient credits', null).retryable === false)
  check('401 not retryable', limitMeta(401, 'unauthorized', null).retryable === false)
  check('403 not retryable', limitMeta(403, 'forbidden', null).retryable === false)
  check('402 payment not retryable', limitMeta(402, 'no credits', null).retryable === false)
}

// official 1.62.1 wire shape: terminal markers / structured error / usage fields
{
  check('model_not_in_plan terminal', classifyUpstreamLimit(403, 'Model not in plan: claude-opus-5') === 'model_not_in_plan')
  check('model_not_in_plan marker snake_case', classifyUpstreamLimit(400, 'model_not_in_plan') === 'model_not_in_plan')
  check('model_not_in_plan not retryable', limitMeta(403, 'Model not in plan: x', null).retryable === false)
  check('premium credits exhausted → payment', classifyUpstreamLimit(400, 'Premium credits exhausted') === 'payment_required')
  check('premium_credits_exhausted marker → payment', classifyUpstreamLimit(400, 'premium_credits_exhausted') === 'payment_required')
  check('insufficient credits → payment', classifyUpstreamLimit(400, 'You have insufficient credits') === 'payment_required')

  const evPlan = mapCcEventError({ type: 'error', error: { message: 'Model not in plan: claude-opus-5', statusCode: 403, isRetryable: false } })
  check('event model_not_in_plan → 403', evPlan.status === 403 && evPlan.body.error.type === 'model_not_in_plan')
  const evPay = mapCcEventError({ type: 'error', error: { message: 'premium_credits_exhausted', statusCode: 402, isRetryable: false } })
  check('event premium credits → 402 no retry_after', evPay.status === 402 && evPay.body.error.type === 'payment_required' && evPay.body.retry_after === undefined, evPay)
  // structured statusCode wins over the legacy <NNN> prefix; isRetryable=false blocks the 429 retry path
  const evNoRetry = mapCcEventError({ type: 'error', error: { message: 'slow down', statusCode: 429, isRetryable: false } })
  check('event isRetryable=false suppresses retryable 429', evNoRetry.status === 429 && evNoRetry.body.retry_after === undefined, evNoRetry)
  const evRetry = mapCcEventError({ type: 'error', error: { message: 'slow down', statusCode: 429 }, retry_after: 7 })
  check('event retryable 429 keeps retry_after', evRetry.status === 429 && evRetry.body.retry_after === 7, evRetry)

  const u = normalizeCcUsage({ inputTokens: 200, outputTokens: 30, inputTokenDetails: { cacheReadTokens: 120, cacheWriteTokens: 40, cacheWriteTokens1h: 10 } })
  check('normalizeCcUsage reads cacheReadTokens', u?.cachedInputTokens === 120 && u?.inputTokens === 200 && u?.outputTokens === 30, u)
  check('normalizeCcUsage carries cacheWrite + 1h', u?.inputTokenDetails?.cacheWriteTokens === 40 && u?.inputTokenDetails?.cacheWriteTokens1h === 10, u)
  const uLegacy = normalizeCcUsage({ inputTokens: 5, cachedInputTokens: 3 })
  check('normalizeCcUsage tolerates legacy flat shape', uLegacy?.cachedInputTokens === 3, uLegacy)
  check('normalizeCcUsage undefined for garbage', normalizeCcUsage(null) === undefined)

  const sid = generateSessionId()
  check('generateSessionId sess_ + 16 hex', sid.length === 21 && sid.startsWith('sess_') && /^[0-9a-f]+$/.test(sid.slice(5)))
  const tid = uuidFromSeed('sess_0123456789abcdef')
  check('uuidFromSeed deterministic v4 shape', tid.length === 36 && tid === uuidFromSeed('sess_0123456789abcdef') && tid[14] === '4' && '89ab'.includes(tid[19]), tid)

  const guard = createToolCallIdGuard()
  check('tool-call guard: first id passes', guard('call_a') === false)
  check('tool-call guard: repeat id suppressed', guard('call_a') === true)
  check('tool-call guard: other id passes', guard('call_b') === false)
  check('tool-call guard: empty id always passes', guard('') === false && guard('') === false)

  // 工具身份提取：六个钩子统一读法，覆盖上游各字段拼写。
  check('ccToolName reads toolName', ccToolName({ toolName: 'bash' }) === 'bash')
  check('ccToolName reads name', ccToolName({ name: 'bash' }) === 'bash')
  check('ccToolName reads nested tool.name', ccToolName({ tool: { name: 'bash' } }) === 'bash')
  check('ccToolName prefers toolName', ccToolName({ toolName: 'a', name: 'b' }) === 'a')
  check('ccToolName trims / empty-safe', ccToolName({ toolName: '  ' }) === '' && ccToolName(null) === '')
  check('ccToolCallId reads toolCallId', ccToolCallId({ toolCallId: 'call_1' }) === 'call_1')
  check('ccToolCallId reads id', ccToolCallId({ id: 'call_1' }) === 'call_1')
  check('ccToolCallId reads toolUseId', ccToolCallId({ toolUseId: 'call_1' }) === 'call_1')
  check('ccToolCallId prefers toolCallId', ccToolCallId({ toolCallId: 'a', id: 'b' }) === 'a')
  check('ccToolCallId empty-safe', ccToolCallId({ id: '' }) === '' && ccToolCallId(undefined) === '')
  check('ccToolCallId reads call_id / callId', ccToolCallId({ call_id: 'call_1' }) === 'call_1' && ccToolCallId({ callId: 'call_2' }) === 'call_2')
  check('ccToolName reads tool_name (snake_case)', ccToolName({ tool_name: 'bash' }) === 'bash')
  check('UNKNOWN_TOOL_NAME non-empty', UNKNOWN_TOOL_NAME === 'unknown_tool')

  // 空参数工具调用必须序列化成合法 JSON：空串不是合法 JSON，客户端解析失败会丢掉
  // 这次调用，写进历史回放后变成 arguments:""（生产日志 cc tool arguments parse failed）。
  check('ccToolArgsToString empty/blank → {}', ccToolArgsToString('') === '{}' && ccToolArgsToString('   ') === '{}')
  check('ccToolArgsToString keeps json string', ccToolArgsToString('{"a":1}') === '{"a":1}')
  check('ccToolArgsToString object → json', ccToolArgsToString({ a: 1 }) === '{"a":1}')
  check('ccToolArgsToString null/undefined → {}', ccToolArgsToString(null) === '{}' && ccToolArgsToString(undefined) === '{}')
}

// inline data-URL redaction (the screenshot-causes-compaction fix)
{
  const { redactLargeDataUrls, shortUrl } = await import('../src/shared/util')
  const big = 'data:image/png;base64,' + 'A'.repeat(5000)
  const small = 'data:image/png;base64,' + 'A'.repeat(64)
  const redacted = redactLargeDataUrls(`before ${big} after`)
  check('redacts oversized inline data URL', !redacted.includes(big) && redacted.includes('chars omitted'), redacted.slice(0, 80))
  check('redaction preserves surrounding text', redacted.startsWith('before ') && redacted.endsWith(' after'), redacted.slice(0, 60))
  check('redaction keeps mime marker', redacted.includes('data:image/png;base64'), redacted.slice(0, 60))
  check('keeps small inline data URL intact', redactLargeDataUrls(`x ${small} y`).includes(small))
  check('no-op on plain text', redactLargeDataUrls('just text') === 'just text')
  check('shortUrl summarizes data URL', shortUrl(big).includes('omitted') && shortUrl(big).length < 200, shortUrl(big).length)
  check('shortUrl keeps short url', shortUrl('https://x/y.png') === 'https://x/y.png')
}

// retry / backoff
{
  check('parseRetryAfter seconds', parseRetryAfter('15') === 15)
  check('parseRetryAfter empty null', parseRetryAfter('') === null)
  check('parseRetryAfter zero null', parseRetryAfter('0') === null)
  check('parseRetryAfter garbage null', parseRetryAfter('not-a-date') === null)
  const d = new Date(Date.now() + 10_000).toUTCString()
  const delta = parseRetryAfter(d)
  check('parseRetryAfter HTTP-date >0', delta !== null && delta! > 0)
  check('backoff attempt0 ~800ms', backoffDelay(0, 800, 15000) >= 600 && backoffDelay(0, 800, 15000) <= 1000)
  check('backoff attempt2 capped no-jitter', backoffDelay(10, 800, 15000, 0) === 15000)
  check('backoff monotonic base', backoffDelay(0, 800, 15000, 0) < backoffDelay(1, 800, 15000, 0))
}

// concurrency gate
{
  const gate = new ConcurrencyGate({ maxInFlightPerKey: 2, maxQueuePerKey: 2, queueTimeoutMs: 300 })
  const ac = new AbortController()
  const releases: (() => void)[] = []

  releases.push(await gate.acquire('k', { signal: ac.signal })) // slot 1
  releases.push(await gate.acquire('k', { signal: ac.signal })) // slot 2 (in-flight full)
  const queued = gate.acquire('k', { signal: ac.signal }) // queued, waits
  check('snapshot inFlight=2', gate.snapshot().inFlight === 2)
  check('per-key snapshot isolates buckets', gate.snapshot('other').inFlight === 0 && gate.snapshot('other').queued === 0)
  releases[0]!() // free slot 1 -> queued waiter promoted
  const r3 = await queued
  check('queued waiter resolves on release', typeof r3 === 'function')
  releases.push(r3)
  check('inFlight back to 2 after promote', gate.snapshot().inFlight === 2)
  check('snapshot queued=0', gate.snapshot().queued === 0)

  // queue full fast-fail
  const gate2 = new ConcurrencyGate({ maxInFlightPerKey: 1, maxQueuePerKey: 0, queueTimeoutMs: 300 })
  const ac2 = new AbortController()
  const slot1 = await gate2.acquire('k2', { signal: ac2.signal })
  let fullRejected = false
  await gate2.acquire('k2', { signal: ac2.signal }).catch(() => { fullRejected = true })
  check('queue full rejects with ConcurrencyRoomFull-like error', fullRejected)
  slot1()

  releases.forEach(r => r())
}

// concurrency gate: deadline timer / abort / queue-full boundary
{
  const g1 = new ConcurrencyGate({ maxInFlightPerKey: 1, maxQueuePerKey: 8, queueTimeoutMs: 250 })
  const ac1 = new AbortController()
  const held1 = await g1.acquire('kt', { signal: ac1.signal })
  const t0 = Date.now()
  let timedOut = false
  await g1.acquire('kt', { signal: ac1.signal }).catch((e: unknown) => { timedOut = e instanceof ConcurrencyTimeout })
  check('queue deadline timer fires ConcurrencyTimeout', timedOut && Date.now() - t0 < 2000, Date.now() - t0)
  held1()

  const g2 = new ConcurrencyGate({ maxInFlightPerKey: 1, maxQueuePerKey: 8, queueTimeoutMs: 5000 })
  const ac2 = new AbortController()
  const held2 = await g2.acquire('ka', { signal: ac2.signal })
  const queued2 = g2.acquire('ka', { signal: ac2.signal })
  ac2.abort()
  let abortedRejected = false
  try { await queued2 } catch (e: unknown) { abortedRejected = e instanceof ConcurrencyAborted }
  check('abort of queued waiter rejects ConcurrencyAborted', abortedRejected)
  held2()

  const g3 = new ConcurrencyGate({ maxInFlightPerKey: 2, maxQueuePerKey: 1, queueTimeoutMs: 5000 })
  const ac3 = new AbortController()
  const h1 = await g3.acquire('kb', { signal: ac3.signal })
  const h2 = await g3.acquire('kb', { signal: ac3.signal })
  const q1 = g3.acquire('kb', { signal: ac3.signal }) // fills the single queue room
  let roomFull = false
  try { await g3.acquire('kb', { signal: ac3.signal }) } catch (e: unknown) { roomFull = e instanceof ConcurrencyRoomFull }
  check('queue-full boundary rejects ConcurrencyRoomFull', roomFull, g3.snapshot())
  h1()
  const r1 = await q1
  check('queued within room still admitted', typeof r1 === 'function')
  h2(); r1()
  check('boundary gate fully drained', g3.snapshot().inFlight === 0 && g3.snapshot().queued === 0, g3.snapshot())

  const g4 = new ConcurrencyGate({ queueTimeoutMs: 1000 })
  const ac4 = new AbortController()
  ac4.abort()
  let immediateAbort = false
  try { await g4.acquire('kc', { signal: ac4.signal }) } catch (e: unknown) { immediateAbort = e instanceof ConcurrencyAborted }
  check('already-aborted signal rejects immediately', immediateAbort)
}

// error mapping (errors.ts + limit.ts integration)
{
  const plain400 = mapCcError(400, JSON.stringify({ error: { message: 'invalid params' } }))
  check('plain 400 keeps invalid_request_error', plain400.status === 400 && plain400.body.error.type === 'invalid_request_error', plain400)

  const overflow = mapCcError(400, JSON.stringify({ error: { message: 'prompt is too long: 300000 tokens > 200000' } }))
  check('400 overflow => context_window_exceeded', overflow.status === 400 && overflow.body.error.type === 'context_window_exceeded', overflow)

  const p402 = mapCcError(402, JSON.stringify({ error: { message: 'no credits' } }))
  check('402 => payment_required', p402.status === 402 && p402.body.error.type === 'payment_required', p402)

  const p404 = mapCcError(404, '')
  check('404 keeps not_found', p404.status === 404 && p404.body.error.type === 'not_found', p404)

  const p429 = mapCcError(429, JSON.stringify({ error: { message: 'rate limit exceeded' } }))
  check('429 without Retry-After omits retry_after', p429.status === 429 && p429.body.error.type === 'rate_limit_error' && p429.body.retry_after === undefined, p429)

  const p429passthrough = mapCcError(429, JSON.stringify({ error: { message: 'slow down' } }), 120_000)
  check('429 passes upstream Retry-After through (never lies)', p429passthrough.body.retry_after === 120, p429passthrough)

  check('toRetryAfterSeconds ceils sub-second windows', toRetryAfterSeconds(500) === 1)
  check('toRetryAfterSeconds absent -> null (omit field)', toRetryAfterSeconds(null) === null && toRetryAfterSeconds(undefined) === null)

  const p500 = mapCcError(500, '')
  check('500 => 502 upstream_error', p500.status === 502 && p500.body.error.type === 'upstream_error', p500)

  const ev = mapCcEventError({ error: { message: '<429> slow down' } })
  check('event <429> without retry_after omits retry_after', ev.status === 429 && ev.body.error.type === 'rate_limit_error' && ev.body.retry_after === undefined, ev)
  const evPassthrough = mapCcEventError({ error: { message: '<429> slow down' }, retry_after: 45 })
  check('event <429> passes event.retry_after through', evPassthrough.status === 429 && evPassthrough.body.retry_after === 45, evPassthrough)
}

// responses protocol: request conversion + response object + SSE terminal (pure)
{
  const { convertResponsesToOpenAI, createResponsesSseTranslator } = await import('../src/modules/responses/translator')
  const { buildResponsesObject } = await import('../src/modules/responses/aggregator')

  const req = convertResponsesToOpenAI({
    model: 'm1',
    instructions: 'be nice',
    max_output_tokens: 321,
    top_p: 0.8,
    temperature: 0.2,
    parallel_tool_calls: false,
    prompt_cache_key: 'pk',
    metadata: { user_id: 'u_1' },
    reasoning: { effort: 'high', summary: 'auto' },
    store: true,
    previous_response_id: 'resp_old',
    include: ['reasoning.encrypted_content'],
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'https://img/1.png' }] },
      { type: 'function_call', call_id: 'call_9', name: 'f', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'call_9', output: [{ type: 'output_text', text: 'ok' }] },
      { type: 'reasoning', summary: [] },
    ],
    tools: [
      { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: true },
      { type: 'computer_use_preview' },
    ],
    tool_choice: { type: 'function', name: 'f' },
  })
  check('responses convert system', req.messages[0].role === 'system' && req.messages[0].content === 'be nice', req.messages[0])
  check('responses convert user parts', req.messages[1].role === 'user' && req.messages[1].content[0].type === 'text' && req.messages[1].content[0].text === 'hi' && req.messages[1].content[1].type === 'image_url' && req.messages[1].content[1].image_url.url === 'https://img/1.png', req.messages[1])
  check('responses convert function_call', req.messages[2].role === 'assistant' && req.messages[2].tool_calls[0].id === 'call_9' && req.messages[2].tool_calls[0].function.arguments === '{"a":1}', req.messages[2])
  check('responses convert function_call_output', req.messages[3].role === 'tool' && req.messages[3].tool_call_id === 'call_9' && req.messages[3].content === 'ok', req.messages[3])
  check('responses convert empty reasoning item adds no message', req.messages.length === 4, req.messages.length)
  check('responses convert tools nested + unmapped built-in dropped', req.tools?.length === 1 && req.tools[0].function.name === 'f' && req.tools[0].function.strict === true, req.tools)
  check('responses convert tool_choice', req.tool_choice?.type === 'function' && req.tool_choice?.function?.name === 'f', req.tool_choice)
  check('responses convert scalars', req.max_tokens === 321 && req.top_p === 0.8 && req.temperature === 0.2 && req.parallel_tool_calls === false && req.reasoning_effort === 'high' && req.user === 'u_1' && req.prompt_cache_key === 'pk', req)
  check('responses convert ignores stateless fields', req.store === undefined && req.previous_response_id === undefined && req.include === undefined, req)

  // 内置工具映射：CC 的 web/shell 都是普通 function tool（不是 provider 内置执行），
  // 有对应就授予 CC 同名工具，无对应（computer/code_interpreter…）仍丢弃。
  const builtins = convertResponsesToOpenAI({
    input: 'hi',
    tools: [
      { type: 'web_search_preview', filters: { allowed_domains: ['a.com', 'b.com'] } },
      { type: 'web_search' },
      { type: 'local_shell' },
      { type: 'shell' },
      { type: 'file_search' },
      { type: 'computer_use_preview' },
      { type: 'code_interpreter' },
    ],
  })
  const bt = builtins.tools || []
  const names = bt.map((t: any) => t.function?.name)
  check('responses built-in web_search → CC web_search function tool', names[0] === 'web_search' && bt[0].function.parameters.required?.includes('query'), bt)
  check('responses web_search allowed_domains honored (never silently widened)', JSON.stringify(bt).includes('"enum":["a.com","b.com"]'), bt[0].function.parameters)
  check('responses local_shell/shell → CC shell_command (deduped)', names.includes('shell_command') && names.filter((n: string) => n === 'shell_command').length === 1, names)
  check('responses file_search degraded to local grep + glob', names.includes('grep') && names.includes('glob'), names)
  check('responses unmapped built-ins dropped (computer/code_interpreter)', names.length === 4 && !names.includes('computer_use_preview') && !names.includes('code_interpreter'), names)
  check('responses builtin reverse map recorded (CC name → declared type)', builtins._builtinToolNames?.shell_command === 'local_shell' && builtins._builtinToolNames?.grep === 'file_search', builtins._builtinToolNames)

  // 反向还原：模型调 CC 工具名（shell_command），客户端收到的必须是它声明过的内置名
  // （local_shell），否则客户端拿到一个从未声明过的工具名 → 未知工具。
  const restored = buildResponsesObject('m', 'resp_b', 1, {
    fullText: '', reasoningContent: '', finishReason: 'tool_calls', usage: null, upstreamError: null, truncated: false,
    toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'shell_command', arguments: '{"command":"ls"}' } }],
  } as any, {}, { shell_command: 'local_shell' })
  const restoredFc = restored.output.find((o: any) => o.type === 'function_call')
  check('non-stream restores declared built-in name', restoredFc?.name === 'local_shell' && restoredFc?.call_id === 'call_1', restoredFc)

  // Reasoning history must replay as assistant.reasoning_content (cc.ts → upstream
  // {type:'reasoning',text}). Dropping it makes reasoning models lose context across
  // tool-loop turns. An encrypted-only item has no plaintext and must add nothing.
  const rz = convertResponsesToOpenAI({
    input: [
      { role: 'user', content: 'q' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'r1' }] },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'r2' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'reasoning', encrypted_content: 'no-plaintext' },
      { role: 'user', content: 'next' },
    ],
  })
  check('responses reasoning → assistant tool_calls reasoning_content',
    rz.messages[1]?.reasoning_content === 'r1' && rz.messages[1]?.tool_calls?.[0]?.id === 'c1', rz.messages[1])
  check('responses reasoning → assistant message reasoning_content',
    rz.messages[3]?.role === 'assistant' && rz.messages[3]?.reasoning_content === 'r2' && rz.messages[3]?.content?.[0]?.text === 'done', rz.messages[3])
  check('responses encrypted-only reasoning adds no empty reasoning_content',
    rz.messages.length === 5 && !rz.messages.some((m: any) => 'reasoning_content' in m && !m.reasoning_content), rz.messages)

  // Parallel tool calls: consecutive function_call items must collapse into one
  // assistant message so every tool_call_id is immediately followed by its tool
  // result (upstream rejects "insufficient tool messages following tool_calls").
  const par = convertResponsesToOpenAI({
    input: [
      { role: 'user', content: 'go' },
      { type: 'function_call', call_id: 'call_a', name: 'fa', arguments: '{"a":1}' },
      { type: 'function_call', call_id: 'call_b', name: 'fb', arguments: '{"b":2}' },
      { type: 'reasoning', summary: [] },
      { type: 'function_call_output', call_id: 'call_a', output: 'ra' },
      { type: 'function_call_output', call_id: 'call_b', output: 'rb' },
    ],
  })
  check('responses parallel calls grouped into one assistant', par.messages.length === 4 && par.messages[1].role === 'assistant' && par.messages[1].tool_calls?.length === 2, par.messages)
  check('responses parallel calls order preserved', par.messages[1].tool_calls[0].id === 'call_a' && par.messages[1].tool_calls[1].id === 'call_b', par.messages[1])
  check('responses parallel outputs immediately follow', par.messages[2].role === 'tool' && par.messages[2].tool_call_id === 'call_a' && par.messages[3].role === 'tool' && par.messages[3].tool_call_id === 'call_b', par.messages)

  // Sequential calls (output between calls) must stay as separate assistant turns.
  const seq = convertResponsesToOpenAI({
    input: [
      { type: 'function_call', call_id: 'call_x', name: 'fx', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_x', output: 'rx' },
      { type: 'function_call', call_id: 'call_y', name: 'fy', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_y', output: 'ry' },
    ],
  })
  check('responses sequential calls not merged', seq.messages.length === 4 && seq.messages[0].tool_calls.length === 1 && seq.messages[2].tool_calls.length === 1, seq.messages)

  // Screenshot-in-tool-result: a giant inline data: URL must be demoted to a
  // placeholder, never serialized verbatim (that is what blew up the context).
  const bigImage = 'data:image/png;base64,' + 'A'.repeat(5000)
  const imgOut = convertResponsesToOpenAI({
    input: [
      { type: 'function_call', call_id: 'call_img', name: 'read', arguments: '{"path":"x.png"}' },
      { type: 'function_call_output', call_id: 'call_img', output: [{ type: 'input_text', text: 'shot' }, { type: 'file', uri: bigImage, mime: 'image/png', name: 'x.png' }] },
    ],
  })
  const imgText = imgOut.messages[1].content
  check('responses giant inline image demoted, not verbatim', typeof imgText === 'string' && !imgText.includes('A'.repeat(5000)) && imgText.includes('file:'), String(imgText).slice(0, 120))
  check('responses tool text still carries the leading text', imgText.includes('shot'), imgText)

  // ── namespace 工具 + 空名 function_call 回放（生产日志驱动回归） ──────────
  // codex 的 namespace 工具（collaboration / multi_agent_v1）CC 无对应概念，必须
  // 展平成裸名 function；回放调用时空名会让上游 400 "`name` must be non-empty"。
  const nsReq = convertResponsesToOpenAI({
    model: 'm',
    tools: [
      { type: 'namespace', name: 'collaboration', tools: [
        { type: 'function', name: 'spawn_agent', description: 'd', parameters: { type: 'object', properties: {} } },
      ] },
    ],
  })
  check('namespace tool flattened to bare name', nsReq.tools?.length === 1 && nsReq.tools[0].function.name === 'spawn_agent', nsReq.tools)
  check('namespace map forwarded for response restore', nsReq._toolNamespaces?.spawn_agent === 'collaboration', nsReq._toolNamespaces)

  const emptyName = convertResponsesToOpenAI({
    input: [{ type: 'function_call', call_id: 'call_x', namespace: 'collaboration', arguments: '{}' }],
  })
  const emptyCall = emptyName.messages.find((m: any) => Array.isArray(m.tool_calls))
  check('empty function_call name never blank (upstream rejects)', typeof emptyCall?.tool_calls[0]?.function?.name === 'string' && emptyCall.tool_calls[0].function.name !== '', emptyCall)

  const dotted = convertResponsesToOpenAI({
    tools: [{ type: 'namespace', name: 'ns1', tools: [{ type: 'function', name: 'do_it', parameters: { type: 'object' } }] }],
    input: [{ type: 'function_call', call_id: 'call_y', name: 'ns1.do_it', arguments: '{}' }],
  })
  const dottedCall = dotted.messages.find((m: any) => Array.isArray(m.tool_calls))
  check('dotted namespace call normalized to bare name', dottedCall?.tool_calls[0]?.function?.name === 'do_it', dottedCall)

  const outReq = convertResponsesToOpenAI({ input: [{ type: 'function_call_output', call_id: 'call_z', name: 'do_it', output: 'ok' }] })
  check('function_call_output carries name (avoids unknown_tool)', outReq.messages[0].role === 'tool' && outReq.messages[0].name === 'do_it', outReq.messages[0])

  const out = buildResponsesObject('m2', 'resp_x', 123, {
    fullText: 'hello',
    reasoningContent: 'think',
    toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
    finishReason: 'tool_calls',
    usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 },
    upstreamError: null,
    truncated: false,
  })
  check('responses object shape', out.id === 'resp_x' && out.object === 'response' && out.status === 'completed' && out.created_at === 123, out)
  check('responses object reasoning first', out.output[0].type === 'reasoning' && out.output[0].summary[0].text === 'think', out.output)
  check('responses object message', out.output[1].type === 'message' && out.output[1].content[0].type === 'output_text' && out.output[1].content[0].text === 'hello', out.output[1])
  check('responses object function_call', out.output[2].type === 'function_call' && out.output[2].call_id === 'call_1' && out.output[2].arguments === '{"a":1}', out.output[2])

  // 非流式路径同样要还原 namespace：codex-rs 按 (namespace, name) 路由，
  // 缺 namespace 会被判 unsupported call（此前只有流式实现、且未接线）。
  const nsOut = buildResponsesObject('m2', 'resp_ns', 1, {
    fullText: '', reasoningContent: '',
    toolCalls: [{ id: 'call_ns', type: 'function', function: { name: 'spawn_agent', arguments: '{}' } }],
    finishReason: 'tool_calls', usage: null, upstreamError: null, truncated: false,
  }, { spawn_agent: 'collaboration' })
  check('responses object restores namespace (non-stream)', nsOut.output[0].type === 'function_call' && nsOut.output[0].namespace === 'collaboration' && nsOut.output[0].name === 'spawn_agent', nsOut.output[0])
  const nsDotted = buildResponsesObject('m2', 'resp_ns2', 1, {
    fullText: '', reasoningContent: '',
    toolCalls: [{ id: 'call_ns2', type: 'function', function: { name: 'collaboration.spawn_agent', arguments: '{}' } }],
    finishReason: 'tool_calls', usage: null, upstreamError: null, truncated: false,
  }, { spawn_agent: 'collaboration' })
  check('responses object normalizes dotted name + namespace', nsDotted.output[0].name === 'spawn_agent' && nsDotted.output[0].namespace === 'collaboration', nsDotted.output[0])
  check('responses object usage', out.usage.input_tokens === 7 && out.usage.output_tokens === 3 && out.usage.total_tokens === 10 && out.usage.input_tokens_details.cached_tokens === 2, out.usage)

  const incomplete = buildResponsesObject('m2', 'resp_y', 1, { fullText: 'x', reasoningContent: '', toolCalls: null, finishReason: 'length', usage: null, upstreamError: null, truncated: false })
  check('responses object length => incomplete', incomplete.status === 'incomplete' && incomplete.incomplete_details?.reason === 'max_output_tokens', incomplete)

  // 截断：只喂 text-delta、不喂 finish —— 必须落 response.incomplete（而非
  // 伪造 response.completed），且绝不能出现 [DONE]。
  const tr = createResponsesSseTranslator('m3', 'resp_s', 5)
  const start = tr.startEvents()
  check('responses sse created+in_progress', start.length === 2 && start[0].startsWith('event: response.created') && start[1].startsWith('event: response.in_progress'), start)
  const enc = new TextEncoder()
  const deltas = tr.parseChunk(enc.encode(JSON.stringify({ type: 'text-delta', text: 'Hi' }) + '\n'))
  check('responses sse text delta', deltas.some((e) => e.startsWith('event: response.output_item.added')) && deltas.some((e) => e.includes('"delta":"Hi"')), deltas)
  check('responses sse truncation detected', tr.truncated === true)
  const fin = tr.finishEvents()
  check('responses sse truncated → response.incomplete, no [DONE]', fin.at(-1)?.startsWith('event: response.incomplete') === true && fin.join('').includes('upstream_interrupted') && !fin.join('').includes('[DONE]'), fin)
  check('responses sse sawContent', tr.sawContent === true)

  // 正常结束：提供 finish 事件后必须落 response.completed（不得误判为截断）。
  const trOk = createResponsesSseTranslator('m4', 'resp_ok', 6)
  trOk.startEvents()
  trOk.parseChunk(enc.encode(JSON.stringify({ type: 'text-delta', text: 'Hi' }) + '\n'))
  trOk.parseChunk(enc.encode(JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0 } }) + '\n'))
  check('responses sse finish → not truncated', trOk.truncated === false)
  const finOk = trOk.finishEvents()
  check('responses sse completed after finish, no [DONE]', finOk.at(-1)?.startsWith('event: response.completed') === true && !finOk.join('').includes('[DONE]'), finOk)
}

// 无参数 tool call：三协议都必须发合法 JSON '{}'，绝不能发空串
// （空串会让客户端解析失败丢调用，历史回放变成 arguments:""）。
{
  const enc = new TextEncoder()
  const bytes = enc.encode([
    { type: 'start' },
    { type: 'tool-input-start', toolCallId: 'call_z', toolName: 'noargs' },
    { type: 'tool-input-end', toolCallId: 'call_z' },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 1, outputTokens: 1 } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')

  const { createSseTranslator } = await import('../src/modules/chat/translator')
  const chatOut = [...createSseTranslator('m', 'cmp', 1).parseChunk(bytes)]
  const chatTr = createSseTranslator('m', 'cmp2', 1)
  const chatAll = [...chatTr.parseChunk(bytes), ...chatTr.flush()].join('')
  check('chat no-arg tool call → {}', chatOut.join('').includes('"arguments":"{}"') && !chatAll.includes('"arguments":""'), chatOut.join('').slice(0, 200))

  const { createAnthropicSseTranslator } = await import('../src/modules/messages/translator')
  const ctx = { bytesReceived: 0, lastCcEvent: '', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, upstreamError: null }
  const anth = createAnthropicSseTranslator('m', 'msg_s', ctx)
  const anthAll = [...anth.startEvents(), ...anth.parseChunk(bytes), ...anth.flush()].join('')
  check('anthropic no-arg tool call → {}', anthAll.includes('"partial_json":"{}"'), anthAll.slice(0, 300))

  const { createResponsesSseTranslator } = await import('../src/modules/responses/translator')
  const resp = createResponsesSseTranslator('m', 'resp_s', 1)
  const respOut = [...resp.startEvents(), ...resp.parseChunk(bytes), ...resp.flush()]
  const respDone = respOut.find((e) => e.startsWith('event: response.function_call_arguments.done'))
  check('responses no-arg tool call → {}', !!respDone && respDone.includes('"arguments":"{}"'), respDone)

  // 反向还原（流式）：模型调 CC 工具名，客户端收到它声明过的内置名。
  const restoreTr = createResponsesSseTranslator('m', 'resp_rs', 2, {}, { shell_command: 'local_shell' })
  const restoreOut = [
    ...restoreTr.startEvents(),
    ...restoreTr.parseChunk(enc.encode(JSON.stringify({ type: 'tool-call', toolCallId: 'call_rs', toolName: 'shell_command', input: { command: 'ls' } }) + '\n')),
    ...restoreTr.flush(),
  ].join('')
  check('stream restores declared built-in name', restoreOut.includes('"name":"local_shell"') && !restoreOut.includes('"name":"shell_command"'), restoreOut.slice(-320))
}

// billing: upstream credits payload → OpenAI credit_summary (pure)
{
  const { buildCreditSummary } = await import('../src/modules/billing/service')

  const summary = buildCreditSummary({
    windowLimits: {
      fiveHour: { used: 2, cap: 14, exceeded: false, resetAt: Date.now() + 3_600_000 },
      weekly: { used: 5, cap: 35, exceeded: false, resetAt: Date.now() + 86_400_000 },
    },
    credits: { monthlyCredits: 57.5, monthlyCreditsGranted: 70, purchasedCredits: 10 },
  })
  check('billing summary object', summary.object === 'credit_summary', summary)
  check('billing summary totals include purchased', summary.total_granted === 70 && summary.total_used === 12.5 && summary.total_available === 67.5, summary)
  check('billing summary grant entry', summary.grants.object === 'list' && summary.grants.data.length === 1 && summary.grants.data[0].object === 'credit_grant' && summary.grants.data[0].grant_amount === 70 && summary.grants.data[0].used_amount === 12.5 && summary.grants.data[0].expires_at === null, summary.grants)

  const onlyRemaining = buildCreditSummary({ credits: { monthlyCredits: 30 } })
  check('billing summary missing granted → untouched', onlyRemaining.total_granted === 30 && onlyRemaining.total_used === 0 && onlyRemaining.total_available === 30, onlyRemaining)

  const overspent = buildCreditSummary({ credits: { monthlyCredits: 0, monthlyCreditsGranted: 70 } })
  check('billing summary fully spent clamps used', overspent.total_used === 70 && overspent.total_available === 0, overspent)

  const empty = buildCreditSummary(null)
  check('billing summary garbage → zeros, never throws', empty.total_granted === 0 && empty.total_used === 0 && empty.total_available === 0 && empty.grants.data.length === 1, empty)
}

// Anthropic usage 口径：input_tokens 契约上不含缓存读写（含则客户端上下文占用
// 被低估，轮次越多越偏离，最终长会话在真实超限时突然失败）。
{
  const { anthropicUsage } = await import('../src/shared/errors')

  const split = anthropicUsage({ inputTokens: 200, outputTokens: 30, inputTokenDetails: { cacheReadTokens: 120, cacheWriteTokens: 40 } })
  check('anthropic usage subtracts read+write from input_tokens', split.input_tokens === 40 && split.output_tokens === 30 && split.cache_read_input_tokens === 120 && split.cache_creation_input_tokens === 40, split)

  // 旧扁平形（无 inputTokenDetails）同样要能拆：cachedInputTokens 视为缓存读。
  const flat = anthropicUsage({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 50 })
  check('anthropic usage tolerates legacy flat cache shape', flat.input_tokens === 50 && flat.cache_read_input_tokens === 50, flat)

  // 无缓存：input_tokens 原样，缓存两项为 0（不是 undefined —— 客户端会读这两个键）。
  const none = anthropicUsage({ inputTokens: 10, outputTokens: 1 })
  check('anthropic usage no-cache keeps input intact and zeroes cache fields', none.input_tokens === 10 && none.cache_read_input_tokens === 0 && none.cache_creation_input_tokens === 0, none)

  // 上游漏报 inputTokens 但报了缓存（异常口径）：绝不能产出负数。
  const clamped = anthropicUsage({ inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 30 } })
  check('anthropic usage never emits negative input_tokens', clamped.input_tokens === 0, clamped)

  const garbage = anthropicUsage(null)
  check('anthropic usage garbage → zeros, never throws', garbage.input_tokens === 0 && garbage.output_tokens === 0 && garbage.cache_read_input_tokens === 0, garbage)
}

// Anthropic 服务端（provider-executed）工具映射：客户端声明 web_search 但自己不执行，
// 必须映射成 CC 的 web_search 声明交给代理代执行（否则静默失效）。
{
  const { mapAnthropicServerTool } = await import('../src/infra/builtin-tools')

  const base = mapAnthropicServerTool({ type: 'web_search_20250305', name: 'web_search' })
  check('server tool web_search maps to CC web_search', base?.tool.name === 'web_search' && base?.declaredName === 'web_search' && !!base?.tool.parameters?.properties?.query, base)

  // 快照名按前缀匹配：新版本快照名不能落到「无对应能力 → 丢弃」分支。
  const newer = mapAnthropicServerTool({ type: 'web_search_20260209', name: 'web_search' })
  check('server tool newer snapshot still maps (prefix match)', newer?.tool.name === 'web_search', newer)

  const preview = mapAnthropicServerTool({ type: 'web_search_preview' })
  check('server tool preview variant maps + defaults name', preview?.tool.name === 'web_search' && preview?.declaredName === 'web_search', preview)

  // 限域必须落进 schema，绝不静默放宽。
  const scoped = mapAnthropicServerTool({ type: 'web_search_20250305', name: 'web_search', allowed_domains: ['example.com'] })
  check('server tool allowed_domains → schema enum', scoped?.tool.parameters?.properties?.allowed_domains?.items?.enum?.[0] === 'example.com', scoped?.tool.parameters)
  check('server tool allowed_domains → description mentions scope', /example\.com/.test(scoped?.tool.description || ''), scoped?.tool.description)

  // 描述必须非空（上游要求）；else 整轮 400。
  check('server tool description never empty', (base?.tool.description || '').length > 0 && (scoped?.tool.description || '').length > 0)

  // 无 CC 对应能力的服务端工具不映射（调用方按 type 判定后丢弃并 warn）。
  check('server tool without CC counterpart → undefined', mapAnthropicServerTool({ type: 'computer_20251124', name: 'computer' }) === undefined)
  check('server tool code_execution → undefined', mapAnthropicServerTool({ type: 'code_execution_20260120' }) === undefined)
  check('non-server function tool → undefined', mapAnthropicServerTool({ name: 'get_weather', input_schema: { type: 'object' } }) === undefined)
}

console.log(`\nUNIT RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
