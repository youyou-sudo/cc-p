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
      { type: 'web_search' },
    ],
    tool_choice: { type: 'function', name: 'f' },
  })
  check('responses convert system', req.messages[0].role === 'system' && req.messages[0].content === 'be nice', req.messages[0])
  check('responses convert user parts', req.messages[1].role === 'user' && req.messages[1].content[0].type === 'text' && req.messages[1].content[0].text === 'hi' && req.messages[1].content[1].type === 'image_url' && req.messages[1].content[1].image_url.url === 'https://img/1.png', req.messages[1])
  check('responses convert function_call', req.messages[2].role === 'assistant' && req.messages[2].tool_calls[0].id === 'call_9' && req.messages[2].tool_calls[0].function.arguments === '{"a":1}', req.messages[2])
  check('responses convert function_call_output', req.messages[3].role === 'tool' && req.messages[3].tool_call_id === 'call_9' && req.messages[3].content === 'ok', req.messages[3])
  check('responses convert drops reasoning item', req.messages.length === 4, req.messages.length)
  check('responses convert tools nested + non-function dropped', req.tools?.length === 1 && req.tools[0].function.name === 'f' && req.tools[0].function.strict === true, req.tools)
  check('responses convert tool_choice', req.tool_choice?.type === 'function' && req.tool_choice?.function?.name === 'f', req.tool_choice)
  check('responses convert scalars', req.max_tokens === 321 && req.top_p === 0.8 && req.temperature === 0.2 && req.parallel_tool_calls === false && req.reasoning_effort === 'high' && req.user === 'u_1' && req.prompt_cache_key === 'pk', req)
  check('responses convert ignores stateless fields', req.store === undefined && req.previous_response_id === undefined && req.include === undefined, req)

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

  const out = buildResponsesObject('m2', 'resp_x', 123, {
    fullText: 'hello',
    reasoningContent: 'think',
    toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
    finishReason: 'tool_calls',
    usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 },
    upstreamError: null,
  })
  check('responses object shape', out.id === 'resp_x' && out.object === 'response' && out.status === 'completed' && out.created_at === 123, out)
  check('responses object reasoning first', out.output[0].type === 'reasoning' && out.output[0].summary[0].text === 'think', out.output)
  check('responses object message', out.output[1].type === 'message' && out.output[1].content[0].type === 'output_text' && out.output[1].content[0].text === 'hello', out.output[1])
  check('responses object function_call', out.output[2].type === 'function_call' && out.output[2].call_id === 'call_1' && out.output[2].arguments === '{"a":1}', out.output[2])
  check('responses object usage', out.usage.input_tokens === 7 && out.usage.output_tokens === 3 && out.usage.total_tokens === 10 && out.usage.input_tokens_details.cached_tokens === 2, out.usage)

  const incomplete = buildResponsesObject('m2', 'resp_y', 1, { fullText: 'x', reasoningContent: '', toolCalls: null, finishReason: 'length', usage: null, upstreamError: null })
  check('responses object length => incomplete', incomplete.status === 'incomplete' && incomplete.incomplete_details?.reason === 'max_output_tokens', incomplete)

  const tr = createResponsesSseTranslator('m3', 'resp_s', 5)
  const start = tr.startEvents()
  check('responses sse created+in_progress', start.length === 2 && start[0].startsWith('event: response.created') && start[1].startsWith('event: response.in_progress'), start)
  const enc = new TextEncoder()
  const deltas = tr.parseChunk(enc.encode(JSON.stringify({ type: 'text-delta', text: 'Hi' }) + '\n'))
  check('responses sse text delta', deltas.some((e) => e.startsWith('event: response.output_item.added')) && deltas.some((e) => e.includes('"delta":"Hi"')), deltas)
  const fin = tr.finishEvents()
  check('responses sse completed terminal, no [DONE]', fin.at(-1)?.startsWith('event: response.completed') === true && !fin.join('').includes('[DONE]'), fin)
  check('responses sse sawContent', tr.sawContent === true)
}

console.log(`\nUNIT RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
