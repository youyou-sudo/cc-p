process.env.PORT = '4200'
process.env.HOST = '127.0.0.1'
process.env.CC_API_BASE = 'http://127.0.0.1:4100'
process.env.CC_MAX_BODY_MB = '1'
process.env.CC_API_KEY = ''

const enc = new TextEncoder()

const stats = {
  generate: 0,
  fingerprint: 0,
  lifecycle: 0,
  lastGenerateHeaders: {} as Record<string, string>,
  lastGenerateBody: null as any,
}

function ndjson(events: any[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(JSON.stringify(e) + '\n'))
      c.close()
    },
  })
}

function slowNdjson(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(c) {
      c.enqueue(enc.encode(JSON.stringify({ type: 'start' }) + '\n'))
      await Bun.sleep(300)
      c.enqueue(enc.encode(JSON.stringify({ type: 'text-delta', text: 'slow' }) + '\n'))
      await Bun.sleep(300)
      c.enqueue(enc.encode(JSON.stringify({ type: 'text-delta', text: ' end' }) + '\n'))
      c.enqueue(enc.encode(JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 3, cachedInputTokens: 1 } }) + '\n'))
      c.close()
    },
  })
}

const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 50 }

Bun.serve({
  port: 4100,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/_stats') return Response.json(stats)
    const headers = Object.fromEntries(req.headers.entries())

    if (url.pathname === '/alpha/fingerprint/record') { stats.fingerprint++; return Response.json({}) }
    if (url.pathname === '/alpha/lifecycle-events') { stats.lifecycle++; return Response.json({}) }
    if (url.pathname === '/provider/v1/models') {
      return Response.json({ data: [{ id: 'mock-model-a', context_window: 128000, max_output_tokens: 4096 }, { id: 'mock-model-b', context_length: 64000 }, { id: 'claude-sonnet-4-6' }] })
    }
    if (url.pathname === '/alpha/generate') {
      stats.generate++
      stats.lastGenerateHeaders = headers
      const body: any = await req.json()
      stats.lastGenerateBody = body
      const model = body.params.model
      switch (model) {
        case 'mock/reason':
          return new Response(ndjson([
            { type: 'start' },
            { type: 'reasoning-delta', text: 'thinking hard' },
            { type: 'text-delta', text: 'Answer' },
            { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 } },
          ]), { headers: { 'content-type': 'application/x-ndjson' } })
        case 'mock/zero':
          return new Response(ndjson([
            { type: 'start' },
            { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 7, outputTokens: 0, cachedInputTokens: 0 } },
          ]), { headers: { 'content-type': 'application/x-ndjson' } })
        case 'mock/slow':
          return new Response(slowNdjson(), { headers: { 'content-type': 'application/x-ndjson' } })
        case 'mock/upstream-429':
          return Response.json({ error: { message: 'rate limited upstream' } }, { status: 429 })
        case 'mock/event-error':
          return new Response(ndjson([
            { type: 'error', error: { message: '<429> slow down' } },
          ]), { headers: { 'content-type': 'application/x-ndjson' } })
        case 'mock/midstream-error':
          return new Response(ndjson([
            { type: 'text-delta', text: 'partial' },
            { type: 'error', error: { message: '<429> slow down' } },
            { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } },
          ]), { headers: { 'content-type': 'application/x-ndjson' } })
        case 'mock/params':
          return new Response(ndjson([
            { type: 'start' },
            { type: 'text-delta', text: 'params-ok' },
            { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } },
          ]), { headers: { 'content-type': 'application/x-ndjson' } })
        case 'mock/realshape':
          // 真实上游 usage 形状：cache 计数在 inputTokenDetails 里（含 1h 写入）；
          // 并夹带 tool-result / abort 事件，验证不再被判为 unknown。
          return new Response(ndjson([
            { type: 'start' },
            { type: 'text-delta', text: 'real' },
            { type: 'tool-result', toolCallId: 'srv_1', toolName: 'web_search', providerExecuted: true, output: { type: 'text', value: 'x' } },
            { type: 'abort' },
            { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 200, outputTokens: 30, inputTokenDetails: { cacheReadTokens: 120, cacheWriteTokens: 40, cacheWriteTokens1h: 10 } } },
          ]), { headers: { 'content-type': 'application/x-ndjson' } })
        case 'mock/dup-tool':
          // 上游对同一个 tool call 重复投递：权威的 tool-call 之后又跟一份
          // tool-input-* 携带同一 id（真实上游如此，cmdcode2api 也为此做了去重）。
          return new Response(ndjson([
            { type: 'start' },
            { type: 'text-delta', text: 'go' },
            { type: 'tool-call', toolCallId: 'call_dup_1', toolName: 'get_weather', input: { city: 'SF' } },
            { type: 'tool-input-start', toolCallId: 'call_dup_1', toolName: 'get_weather' },
            { type: 'tool-input-delta', toolCallId: 'call_dup_1', delta: '{"city":"SF"}' },
            { type: 'tool-input-end', toolCallId: 'call_dup_1', input: { city: 'SF' } },
            { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 5, outputTokens: 3, cachedInputTokens: 0 } },
          ]), { headers: { 'content-type': 'application/x-ndjson' } })
        case 'mock/structured-error':
          // 官方 1.62.1 流式错误形状（statusCode/isRetryable）+ 终局标记。
          return new Response(ndjson([
            { type: 'error', error: { message: 'premium credits exhausted', statusCode: 402, isRetryable: false } },
          ]), { headers: { 'content-type': 'application/x-ndjson' } })
        case 'mock/model-not-in-plan':
          return new Response(ndjson([
            { type: 'error', error: { message: 'Model not in plan: claude-opus-5', statusCode: 403, isRetryable: false } },
          ]), { headers: { 'content-type': 'application/x-ndjson' } })
        default:
          return new Response(ndjson([
            { type: 'start' },
            { type: 'text-delta', text: 'Hello' },
            { type: 'text-delta', text: ' world' },
            { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'SF' } },
            { type: 'finish', finishReason: 'tool-calls', totalUsage: usage },
          ]), { headers: { 'content-type': 'application/x-ndjson' } })
      }
    }
    return new Response('nf', { status: 404 })
  },
})

await import('../src/index.ts')
await Bun.sleep(500)

const BASE = 'http://127.0.0.1:4200'
const KEY = 'user_testkey123'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra?: any) {
  if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : '') }
}

async function statsFetch() {
  const r = await fetch('http://127.0.0.1:4100/_stats')
  return await r.json() as typeof stats
}

console.log('--- basic endpoints ---')
{
  const r = await fetch(BASE + '/health')
  const healthBody = await r.json()
  check('health 200 + {ok:true}', r.status === 200 && healthBody.ok === true, healthBody)
  check('health CORS', r.headers.get('access-control-allow-origin') === '*')
  check('health CORS never null', r.headers.get('access-control-allow-origin') !== 'null', r.headers.get('access-control-allow-origin'))
  check('health Vary: Origin', (r.headers.get('vary') || '').includes('Origin'), r.headers.get('vary'))
}
{
  const r = await fetch(BASE + '/readyz')
  const raw = await r.text()
  let readyzBody: any = null
  try { readyzBody = JSON.parse(raw) } catch { readyzBody = null }
  check('readyz 200 + {ok:true}', r.status === 200 && readyzBody?.ok === true, readyzBody)
  check('readyz content-type json', (r.headers.get('content-type') || '').includes('application/json'), r.headers.get('content-type'))
  check('readyz CORS *', r.headers.get('access-control-allow-origin') === '*', r.headers.get('access-control-allow-origin'))
  check('readyz CORS never null', r.headers.get('access-control-allow-origin') !== 'null', r.headers.get('access-control-allow-origin'))
  check('readyz Vary: Origin', (r.headers.get('vary') || '').includes('Origin'), r.headers.get('vary'))
  const readyzGate = readyzBody?.gate
  check('readyz gate fields + limits are numbers', readyzGate != null && typeof readyzGate === 'object'
    && typeof readyzGate.inFlight === 'number' && typeof readyzGate.queued === 'number' && typeof readyzGate.keys === 'number'
    && typeof readyzGate.maxInFlightPerKey === 'number' && typeof readyzGate.maxQueuePerKey === 'number' && typeof readyzGate.queueTimeoutMs === 'number', readyzGate)
  check('readyz idle gate zero 0/0/0', readyzGate?.inFlight === 0 && readyzGate?.queued === 0 && readyzGate?.keys === 0, readyzGate)
  check('readyz uptimeSeconds integer', typeof readyzBody?.uptimeSeconds === 'number' && Number.isInteger(readyzBody.uptimeSeconds) && readyzBody.uptimeSeconds >= 0, readyzBody?.uptimeSeconds)
  const readyzMem = readyzBody?.memory
  check('readyz memory rss/heapUsed/heapTotal numbers', readyzMem != null && typeof readyzMem === 'object'
    && typeof readyzMem.rss === 'number' && Number.isFinite(readyzMem.rss) && readyzMem.rss > 0
    && typeof readyzMem.heapUsed === 'number' && Number.isFinite(readyzMem.heapUsed) && readyzMem.heapUsed > 0
    && typeof readyzMem.heapTotal === 'number' && Number.isFinite(readyzMem.heapTotal) && readyzMem.heapTotal > 0, readyzMem)
  check('readyz JSON no placeholder', readyzBody !== null && !/n\/a|unknown|todo|tbd|placeholder|xxx/i.test(raw), raw.slice(0, 300))
  try {
    const gateMod = await import('../src/infra/proxy-handler.ts') as any
    const direct = gateMod.getGateStats()
    check('readyz gate equals getGateStats()', readyzGate?.inFlight === direct?.inFlight && readyzGate?.queued === direct?.queued && readyzGate?.keys === direct?.keys
      && readyzGate?.maxInFlightPerKey === direct?.maxInFlightPerKey && readyzGate?.maxQueuePerKey === direct?.maxQueuePerKey && readyzGate?.queueTimeoutMs === direct?.queueTimeoutMs, { gate: readyzGate, direct })
  } catch (e: any) {
    check('readyz gate equals getGateStats()', false, String(e?.message ?? e))
  }
}
{
  const r = await fetch(BASE + '/')
  check('root 200 OK', r.status === 200 && (await r.text()) === 'OK')
}
{
  const r = await fetch(BASE + '/v1/chat/completions', { method: 'OPTIONS' })
  check('OPTIONS 204', r.status === 204)
  check('OPTIONS CORS headers', r.headers.get('access-control-allow-methods') === 'GET, POST, OPTIONS')
}
{
  const r = await fetch(BASE + '/nope')
  const body = await r.json()
  check('404 JSON', r.status === 404 && body.error.type === 'not_found')
  check('404 CORS never null', r.headers.get('access-control-allow-origin') !== 'null', r.headers.get('access-control-allow-origin'))
  check('404 Vary: Origin', (r.headers.get('vary') || '').includes('Origin'), r.headers.get('vary'))
}
{
  try {
    const r = await fetch(BASE + '/v1/messages/xxx')
    const body = await r.json()
    check('404 /v1/messages/xxx always OpenAI shape', r.status === 404 && body.error?.type === 'not_found' && (body as any).type === undefined, body)
    check('404 /v1/messages/xxx CORS never null', r.headers.get('access-control-allow-origin') !== 'null', r.headers.get('access-control-allow-origin'))
    check('404 /v1/messages/xxx Vary: Origin', (r.headers.get('vary') || '').includes('Origin'), r.headers.get('vary'))
  } catch (e: any) {
    check('404 /v1/messages/xxx always OpenAI shape', false, String(e?.message ?? e))
  }
}

console.log('--- auth / parse errors ---')
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x', messages: [] }),
  })
  const body = await r.json()
  check('missing key 401', r.status === 401 && body.error.type === 'auth_error')
  check('401 openai CORS never null', r.headers.get('access-control-allow-origin') !== 'null', r.headers.get('access-control-allow-origin'))
  check('401 openai Vary: Origin', (r.headers.get('vary') || '').includes('Origin'), r.headers.get('vary'))
}
{
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })
  const body = await r.json()
  check('messages missing key 401', r.status === 401 && body.error.type === 'authentication_error')
  check('401 anthropic CORS never null', r.headers.get('access-control-allow-origin') !== 'null', r.headers.get('access-control-allow-origin'))
  check('401 anthropic Vary: Origin', (r.headers.get('vary') || '').includes('Origin'), r.headers.get('vary'))
}
{
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })
  const body = await r.json()
  check('responses missing key 401 (OpenAI shape)', r.status === 401 && body.error.type === 'auth_error' && (body as any).type === undefined, body)
  check('401 responses CORS never null', r.headers.get('access-control-allow-origin') !== 'null', r.headers.get('access-control-allow-origin'))
  check('401 responses Vary: Origin', (r.headers.get('vary') || '').includes('Origin'), r.headers.get('vary'))
}
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer user_ok_1' }, body: 'not-json',
  })
  const body = await r.json()
  check('invalid JSON 400', r.status === 400 && body.error.message === 'Invalid JSON body')
}
{
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer user_ok_1' }, body: 'not-json',
  })
  const body = await r.json()
  check('responses invalid JSON 400 openai shape', r.status === 400 && body.error.message === 'Invalid JSON body' && (body as any).type === undefined, body)
}
{
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer user_ok_1' }, body: 'not-json',
  })
  const body = await r.json()
  check('invalid JSON 400 anthropic shape', r.status === 400 && body.type === 'error' && body.error.type === 'invalid_request_error')
}
{
  const big = 'x'.repeat(2 * 1024 * 1024)
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer user_ok_1' }, body: JSON.stringify({ model: 'm', messages: [], pad: big }),
  })
  const body = await r.json()
  check('413 body too large', r.status === 413 && body.error.message.includes('1MB'), body)
  check('413 CORS never null', r.headers.get('access-control-allow-origin') !== 'null', r.headers.get('access-control-allow-origin'))
  check('413 Vary: Origin', (r.headers.get('vary') || '').includes('Origin'), r.headers.get('vary'))
}
{
  try {
    const big = 'x'.repeat(2 * 1024 * 1024)
    const r = await fetch(BASE + '/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }], pad: big }),
    })
    const body = await r.json()
    check('413 anthropic shape', r.status === 413 && body.type === 'error' && body.error.type === 'invalid_request_error', body)
    check('413 anthropic CORS never null', r.headers.get('access-control-allow-origin') !== 'null', r.headers.get('access-control-allow-origin'))
    check('413 anthropic Vary: Origin', (r.headers.get('vary') || '').includes('Origin'), r.headers.get('vary'))
  } catch (e: any) {
    check('413 anthropic shape', false, String(e?.message ?? e))
  }
}
{
  const r = await fetch(BASE + '/v1/models')
  check('models without key still lists (fallback path allowed)', r.status === 200)
}

console.log('--- models ---')
{
  const r = await fetch(BASE + '/v1/models', { headers: { authorization: `Bearer ${KEY}` } })
  const body = await r.json()
  check('models from provider API', r.status === 200 && body.object === 'list' && body.data.length === 3 && body.data[0].id === 'mock-model-a', body)
  check('models passthrough context_window', body.data[0]?.context_window === 128000, body.data?.[0])
  check('models alias context_length → context_window', body.data[1]?.context_window === 64000, body.data?.[1])
  check('models static fallback window', body.data[2]?.id === 'claude-sonnet-4-6' && body.data[2]?.context_window === 1048576, body.data?.[2])
  check('models vision default modalities', body.data.every((m: any) => Array.isArray(m.modalities) && m.modalities.includes('image')) && body.data[0]?.supports_vision === true && body.data[0]?.vision === true, body.data?.[0])
}

console.log('--- openai non-stream ---')
{
  const before = (await statsFetch()).generate
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'mock/model', prompt_cache_key: 'cache-key-001',
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } } }],
    }),
  })
  const body = await r.json()
  check('completion 200', r.status === 200, body)
  check('content joined', body.choices?.[0]?.message?.content === 'Hello world', body.choices?.[0])
  check('tool_calls mapped', body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === 'get_weather' && body.choices?.[0]?.message?.tool_calls?.[0]?.id === 'call_1', body.choices?.[0]?.message?.tool_calls)
  check('finish_reason tool_calls', body.choices?.[0]?.finish_reason === 'tool_calls')
  check('usage mapped', body.usage?.prompt_tokens === 100 && body.usage?.completion_tokens === 20 && body.usage?.total_tokens === 120 && body.usage?.prompt_tokens_details?.cached_tokens === 50, body.usage)
  check('id format', typeof body.id === 'string' && body.id.startsWith('chatcmpl-') && body.object === 'chat.completion')

  const s = await statsFetch()
  check('upstream generate called once', s.generate === before + 1, s.generate)
  const h = s.lastGenerateHeaders
  check('bearer forwarded', h['authorization'] === `Bearer ${KEY}`)
  check('official User-Agent: cli', h['user-agent'] === 'cli', h['user-agent'])
  check('prompt_cache_key overrides session id', h['x-session-id'] === 'cache-key-001', h['x-session-id'])
  check('project slug format', /^-?[a-z0-9-]+$/.test(h['x-project-slug'] || ''), h['x-project-slug'])
  check('traceparent format', /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(h['traceparent'] || ''), h['traceparent'])
  check('cli version header', !!h['x-command-code-version'])
  check('x-co-flag removed (absent from official 1.62.1)', h['x-co-flag'] === undefined, h['x-co-flag'])
  check('taste flag present', h['x-taste-learning'] === 'false')

  const b = s.lastGenerateBody
  check('params.stream always true', b.params.stream === true)
  check('body threadId is a v4 UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(b.threadId || ''), b.threadId)
  check('skills is null (official shape)', b.skills === null, b.skills)
  check('system extracted', b.params.system === 'be nice', b.params.system)
  check('tools mapped to input_schema', b.params.tools?.[0]?.name === 'get_weather' && !!b.params.tools?.[0]?.input_schema, b.params.tools)
  check('user msg wrapped', b.params.messages[0].role === 'user' && b.params.messages[0].content[0].type === 'text' && b.params.messages[0].content[0].text === 'hi')
  check('cache_control injected', b.params.messages[0].content.at(-1).cache_control?.type === 'ephemeral', b.params.messages[0].content)
  check('no system role in messages', !b.params.messages.some((m: any) => m.role === 'system'))

  const before2 = (await statsFetch())
  await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/model', messages: [{ role: 'user', content: 'again' }] }),
  })
  const after2 = await statsFetch()
  check('init requests not repeated', after2.fingerprint === before2.fingerprint && after2.lifecycle === before2.lifecycle)
  check('generate incremented again', after2.generate === before2.generate + 1)
}

console.log('--- openai stream ---')
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('stream content-type', (r.headers.get('content-type') || '').includes('text/event-stream'))
  const text = await r.text()
  const lines = text.split('\n').filter((l) => l.startsWith('data: '))
  check('stream has [DONE]', lines.at(-1) === 'data: [DONE]', lines.at(-1))
  const chunks = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)))
  check('first chunk has role', chunks[0]?.choices?.[0]?.delta?.role === 'assistant' && chunks[0]?.choices?.[0]?.delta?.content === 'Hello')
  check('second chunk content only', chunks[1]?.choices?.[0]?.delta?.content === ' world' && !chunks[1]?.choices?.[0]?.delta?.role)
  check('tool_calls chunk', chunks[2]?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === 'get_weather' && chunks[2]?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments === '{"city":"SF"}', chunks[2])
  const finish = chunks.at(-1)
  check('finish chunk w/ usage', finish?.choices?.[0]?.finish_reason === 'tool_calls' && finish?.usage?.prompt_tokens === 100 && finish?.usage?.total_tokens === 120, finish)
}

console.log('--- openai reasoning ---')
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/reason', messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  check('reasoning_content captured', body.choices?.[0]?.message?.reasoning_content === 'thinking hard' && body.choices?.[0]?.message?.content === 'Answer', body.choices?.[0]?.message)
  check('stop finish', body.choices?.[0]?.finish_reason === 'stop')
}

console.log('--- param passthrough ---')
{
  const before = (await statsFetch()).generate
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'mock/params',
      messages: [{ role: 'user', content: 'hi' }],
      top_p: 0.9,
      stop: ['END', '\n\n'],
      user: 'u_abc',
      seed: 42,
    }),
  })
  const body = await r.json()
  check('params passthrough 200', r.status === 200 && body.choices?.[0]?.message?.content === 'params-ok', body)
  const s = await statsFetch()
  check('generate incremented', s.generate === before + 1)
  check('generated session id is sess_ + 16 hex', /^sess_[0-9a-f]{16}$/.test(s.lastGenerateHeaders['x-session-id'] || ''), s.lastGenerateHeaders['x-session-id'])
  const b = s.lastGenerateBody
  check('top_p withheld from CLI wire', b.params.top_p === undefined, b.params)
  check('stop withheld from CLI wire', b.params.stop === undefined, b.params.stop)
  check('user withheld from CLI wire', b.params.user === undefined, b.params.user)
  check('seed withheld from CLI wire', b.params.seed === undefined, b.params.seed)
  check('empty system placeholder injected', b.params.system === ' ', b.params.system)
}
{
  const before = (await statsFetch()).generate
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({
      model: 'mock/params', max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      top_p: 0.5,
      stop_sequences: ['STOP'],
      metadata: { user_id: 'u_xyz' },
    }),
  })
  const body = await r.json()
  check('anthropic params passthrough 200', r.status === 200, body)
  const s = await statsFetch()
  check('anthropic generate incremented', s.generate === before + 1)
  const b = s.lastGenerateBody
  check('anthropic top_p withheld from CLI wire', b.params.top_p === undefined, b.params)
  check('anthropic stop_sequences withheld from CLI wire', b.params.stop === undefined, b.params.stop)
  check('anthropic metadata.user_id withheld from CLI wire', b.params.user === undefined, b.params.user)
}

console.log('--- upstream wire shape: usage / tool-result / abort / structured error ---')
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/realshape', messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  check('real-shape usage: inputTokenDetails.cacheReadTokens → cached_tokens', body.usage?.prompt_tokens_details?.cached_tokens === 120, body.usage)
  check('real-shape usage: completion mapped', body.usage?.completion_tokens === 30, body.usage)
  check('tool-result/abort tolerated (200 + content)', r.status === 200 && body.choices?.[0]?.message?.content === 'real', body)
}
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/structured-error', messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  check('premium credits exhausted → 402 payment_required', r.status === 402 && body.error?.type === 'payment_required', body)
  check('premium credits not retryable (no retry_after)', body.retry_after === undefined, body)
}
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/model-not-in-plan', messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  check('model not in plan → 403 model_not_in_plan', r.status === 403 && body.error?.type === 'model_not_in_plan', body)
}
{
  // 思考历史回灌：OpenAI assistant.reasoning_content → CC {type:'reasoning'}
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'mock/params',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1', reasoning_content: 'because reasons' },
        { role: 'user', content: 'q2' },
      ],
    }),
  })
  await r.json()
  const s = await statsFetch()
  const assistantMsg = s.lastGenerateBody.params.messages.find((m: any) => m.role === 'assistant')
  check('thinking history replayed as {type:reasoning}', assistantMsg?.content?.[0]?.type === 'reasoning' && assistantMsg.content[0].text === 'because reasons', assistantMsg)
}

console.log('--- duplicate tool_call_id: response-side dedupe + request-side repair ---')
{
  // 非流式：上游重复投递同一 call，客户端只能看到一条
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/dup-tool', messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  const tcs = body.choices?.[0]?.message?.tool_calls
  check('dup tool-call deduped (non-stream)', Array.isArray(tcs) && tcs.length === 1 && tcs[0].id === 'call_dup_1', tcs)
}
{
  // 流式：tool-call 之后不得再为同一 id 补发一条 tool_calls chunk
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/dup-tool', stream: true, messages: [{ role: 'user', content: 'q' }] }),
  })
  const text = await r.text()
  const chunks = text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)))
  const emitted = chunks.flatMap((c: any) => c.choices?.[0]?.delta?.tool_calls ?? [])
  check('dup tool-call deduped (stream)', emitted.length === 1 && emitted[0].id === 'call_dup_1', emitted)
}
{
  // Anthropic 侧同一去重：只能出现一个 tool_use 块
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ model: 'mock/dup-tool', max_tokens: 100, messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  const uses = (body.content ?? []).filter((b: any) => b.type === 'tool_use')
  check('dup tool-call deduped (anthropic)', uses.length === 1 && uses[0].id === 'call_dup_1', body.content)
}
{
  // 请求侧修复：历史里已沉淀重复 id（客户端曾收到重复 call 后回传），
  // 代理必须换发唯一 id 并按序重新配对 tool-result，而不是把 400 透传给用户。
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'mock/params',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_dup_hist', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
            { id: 'call_dup_hist', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NY"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_dup_hist', name: 'get_weather', content: 'SF sunny' },
        { role: 'tool', tool_call_id: 'call_dup_hist', name: 'get_weather', content: 'NY rain' },
        { role: 'user', content: 'and?' },
      ],
    }),
  })
  await r.json()
  const s = await statsFetch()
  const msgs = s.lastGenerateBody.params.messages
  const parts = msgs.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
  const callIds = parts.filter((p: any) => p.type === 'tool-call').map((p: any) => p.toolCallId)
  const resultIds = parts.filter((p: any) => p.type === 'tool-result').map((p: any) => p.toolCallId)
  check('history dup tool_call_id repaired to unique', callIds.length === 2 && new Set(callIds).size === 2, callIds)
  check('history tool results re-paired in order', resultIds.length === 2 && resultIds[0] === callIds[0] && resultIds[1] === callIds[1], { callIds, resultIds })
}

console.log('--- zero output / upstream errors ---')
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/zero', messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  check('zero output 429 non-stream', r.status === 429 && body.error.type === 'rate_limit_error' && body.retry_after === 10 && r.headers.get('retry-after') === '10', body)
}
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/upstream-429', messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  check('upstream 429 mapped (no fabricated retry_after)', r.status === 429 && body.error.message === 'rate limited upstream' && body.retry_after === undefined, body)
}
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/event-error', stream: true, messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  check('stream error event before output → JSON 429', r.status === 429 && body.error.type === 'rate_limit_error' && body.retry_after === undefined, body)
}
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/event-error', messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  check('non-stream error event → JSON 429', r.status === 429 && body.error.type === 'rate_limit_error' && body.retry_after === undefined, body)
}
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/midstream-error', stream: true, messages: [{ role: 'user', content: 'q' }] }),
  })
  const text = await r.text()
  const lines = text.split('\n').filter((l) => l.startsWith('data: '))
  const last = lines.at(-1)
  check('midstream error keeps SSE 200', r.status === 200 && (r.headers.get('content-type') || '').includes('text/event-stream'), r.status)
  check('midstream error content chunk present', lines.some((l) => l.includes('"content":"partial"')))
  check('midstream error data event, no [DONE]', last?.includes('"error"') === true && last !== 'data: [DONE]', last)
}

console.log('--- anthropic non-stream ---')
{
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({
      model: 'mock/model',
      max_tokens: 1000,
      system: 'be brief',
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'sunny 20C' }] },
      ],
    }),
  })
  const body = await r.json()
  check('anthropic 200', r.status === 200, body)
  check('anthropic msg id', typeof body.id === 'string' && body.id.startsWith('msg_') && body.type === 'message' && body.role === 'assistant')
  check('anthropic text + tool_use blocks', body.content?.[0]?.type === 'text' && body.content?.[0]?.text === 'Hello world' && body.content?.[1]?.type === 'tool_use' && body.content?.[1]?.input?.city === 'SF', body.content)
  check('anthropic stop_reason tool_use', body.stop_reason === 'tool_use' && body.stop_sequence === null)
  check('anthropic usage', body.usage?.input_tokens === 100 && body.usage?.output_tokens === 20 && body.usage?.cache_read_input_tokens === 50, body.usage)

  const s = await statsFetch()
  const b = s.lastGenerateBody
  check('anthropic system extracted', b.params.system === 'be brief')
  check('anthropic messages converted', b.params.messages[0].role === 'user' && b.params.messages[1].role === 'assistant' && b.params.messages[1].content[0].type === 'tool-call' && b.params.messages[2].role === 'tool' && b.params.messages[2].content[0].toolCallId === 'call_1' && b.params.messages[2].content[0].output.value === 'sunny 20C', b.params.messages)
  check('anthropic tools mapped', b.params.tools?.[0]?.name === 'get_weather')
  check('x-api-key auth worked', s.lastGenerateHeaders['authorization'] === `Bearer ${KEY}`)
}
{
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ model: 'mock/reason', max_tokens: 100, messages: [{ role: 'user', content: 'q' }], thinking: { type: 'enabled', budget_tokens: 12000 } }),
  })
  const body = await r.json()
  check('anthropic thinking block (empty official signature)', body.content?.[0]?.type === 'thinking' && body.content?.[0]?.thinking === 'thinking hard' && body.content?.[0]?.signature === '', body.content)
  const s = await statsFetch()
  check('thinking budget 12000 → reasoning_effort high', s.lastGenerateBody.params.reasoning_effort === 'high', s.lastGenerateBody.params)
}

console.log('--- anthropic stream ---')
{
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ model: 'mock/model', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('anthropic stream content-type', (r.headers.get('content-type') || '').includes('text/event-stream'))
  const text = await r.text()
  const events = text.split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n')
    const eventName = lines.find((l) => l.startsWith('event: '))?.slice(7)
    const dataLine = lines.find((l) => l.startsWith('data: '))?.slice(6)
    return { eventName, data: dataLine ? JSON.parse(dataLine) : null }
  })
  const names = events.map((e) => e.eventName)
  check('anthropic stream event order', names[0] === 'message_start'
    && names.includes('content_block_start') && names.includes('content_block_delta')
    && names.includes('content_block_stop') && names.includes('message_delta') && names.at(-1) === 'message_stop', names)
  const textDelta = events.find((e) => e.data?.delta?.type === 'text_delta')
  check('anthropic text_delta', textDelta?.data?.delta?.text === 'Hello')
  const toolStart = events.find((e) => e.data?.content_block?.type === 'tool_use')
  const toolJson = events.find((e) => e.data?.delta?.type === 'input_json_delta')
  check('anthropic tool_use block', toolStart?.data?.content_block?.name === 'get_weather' && toolJson?.data?.delta?.partial_json === '{"city":"SF"}', toolStart)
  const msgDelta = events.find((e) => e.eventName === 'message_delta')
  check('anthropic message_delta stop_reason + usage', msgDelta?.data?.delta?.stop_reason === 'tool_use' && msgDelta?.data?.usage?.output_tokens === 20, msgDelta)
}

console.log('--- anthropic zero output / upstream errors ---')
{
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ model: 'mock/zero', max_tokens: 100, messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  check('anthropic zero output 429 non-stream', r.status === 429 && body.type === 'error' && body.error.type === 'rate_limit_error' && body.retry_after === 10 && r.headers.get('retry-after') === '10', body)
}
{
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ model: 'mock/upstream-429', max_tokens: 100, messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  check('anthropic upstream 429 mapped (no fabricated retry_after)', r.status === 429 && body.type === 'error' && body.error.type === 'rate_limit_error' && body.retry_after === undefined && r.headers.get('retry-after') === null, body)
}
{
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ model: 'mock/event-error', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'q' }] }),
  })
  const ct = r.headers.get('content-type') || ''
  const body = await r.json()
  check('anthropic stream error before output → JSON 429', r.status === 429 && ct.includes('json') && !ct.includes('event-stream') && body.type === 'error' && body.error.type === 'rate_limit_error' && body.retry_after === undefined, { ct, body })
}

console.log('--- responses non-stream ---')
{
  const before = (await statsFetch()).generate
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'mock/model',
      instructions: 'be brief',
      prompt_cache_key: 'resp-cache-001',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny 20C' },
      ],
      tools: [{ type: 'function', name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } }],
    }),
  })
  const body = await r.json()
  check('responses 200', r.status === 200, body)
  check('responses object shape', body.object === 'response' && typeof body.id === 'string' && body.id.startsWith('resp_') && body.status === 'completed', body)
  check('responses output text item', body.output?.[0]?.type === 'message' && body.output?.[0]?.role === 'assistant' && body.output?.[0]?.content?.[0]?.type === 'output_text' && body.output?.[0]?.content?.[0]?.text === 'Hello world', body.output)
  check('responses function_call item', body.output?.[1]?.type === 'function_call' && body.output?.[1]?.call_id === 'call_1' && body.output?.[1]?.name === 'get_weather' && body.output?.[1]?.arguments === '{"city":"SF"}', body.output)
  check('responses usage mapped', body.usage?.input_tokens === 100 && body.usage?.output_tokens === 20 && body.usage?.total_tokens === 120 && body.usage?.input_tokens_details?.cached_tokens === 50, body.usage)

  const s = await statsFetch()
  check('responses generate incremented', s.generate === before + 1)
  const b = s.lastGenerateBody
  check('responses instructions → CC system', b.params.system === 'be brief', b.params.system)
  check('responses input text wrapped', b.params.messages[0].role === 'user' && b.params.messages[0].content[0].text === 'weather?', b.params.messages[0])
  check('responses function_call → CC tool-call', b.params.messages[1].role === 'assistant' && b.params.messages[1].content[0].type === 'tool-call' && b.params.messages[1].content[0].toolCallId === 'call_1', b.params.messages[1])
  check('responses function_call_output → CC tool result', b.params.messages[2].role === 'tool' && b.params.messages[2].content[0].output.value === 'sunny 20C', b.params.messages[2])
  check('responses flat tool → CC input_schema', b.params.tools?.[0]?.name === 'get_weather' && !!b.params.tools?.[0]?.input_schema, b.params.tools)
  check('responses cache_control injected', b.params.messages[0].content.at(-1).cache_control?.type === 'ephemeral', b.params.messages[0].content)
}

console.log('--- responses parallel tool calls ---')
{
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'mock/model',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'both?' }] },
        { type: 'function_call', call_id: 'call_a', name: 'get_weather', arguments: '{"city":"SF"}' },
        { type: 'function_call', call_id: 'call_b', name: 'get_time', arguments: '{"tz":"UTC"}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'sunny' },
        { type: 'function_call_output', call_id: 'call_b', output: '12:00' },
      ],
    }),
  })
  check('responses parallel 200', r.status === 200, r.status)
  const b = (await statsFetch()).lastGenerateBody
  check('responses parallel one assistant tool-call msg', b.params.messages[1].role === 'assistant' && b.params.messages[1].content.length === 2 && b.params.messages[1].content[0].type === 'tool-call' && b.params.messages[1].content[1].type === 'tool-call', b.params.messages[1])
  check('responses parallel tool ids preserved', b.params.messages[1].content[0].toolCallId === 'call_a' && b.params.messages[1].content[1].toolCallId === 'call_b', b.params.messages[1])
  check('responses parallel tool results adjacent', b.params.messages[2].role === 'tool' && b.params.messages[2].content[0].toolCallId === 'call_a' && b.params.messages[3].role === 'tool' && b.params.messages[3].content[0].toolCallId === 'call_b', b.params.messages)
}

console.log('--- responses reasoning ---')
{
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/reason', input: 'q' }),
  })
  const body = await r.json()
  check('responses reasoning item', body.output?.[0]?.type === 'reasoning' && body.output?.[0]?.summary?.[0]?.text === 'thinking hard', body.output)
  check('responses text after reasoning', body.output?.[1]?.type === 'message' && body.output?.[1]?.content?.[0]?.text === 'Answer', body.output)
}

console.log('--- responses params passthrough ---')
{
  const before = (await statsFetch()).generate
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'mock/params',
      input: 'hi',
      max_output_tokens: 123,
      top_p: 0.7,
      reasoning: { effort: 'high', summary: 'auto' },
      tool_choice: { type: 'function', name: 'get_weather' },
      metadata: { user_id: 'u_resp' },
      store: true,
      previous_response_id: 'resp_old',
      include: ['reasoning.encrypted_content'],
    }),
  })
  const body = await r.json()
  check('responses params 200', r.status === 200 && body.output?.[0]?.content?.[0]?.text === 'params-ok', body)
  const s = await statsFetch()
  check('responses generate incremented (params)', s.generate === before + 1)
  const b = s.lastGenerateBody
  check('responses max_output_tokens → max_tokens', b.params.max_tokens === 123, b.params)
  check('responses top_p withheld from CLI wire', b.params.top_p === undefined, b.params)
  check('responses reasoning.effort → reasoning_effort', b.params.reasoning_effort === 'high', b.params)
  check('responses metadata.user_id withheld from CLI wire', b.params.user === undefined, b.params.user)
  check('responses tool_choice forwarded (tool semantics never dropped)', b.params.tool_choice?.type === 'tool' && b.params.tool_choice?.name === 'get_weather', b.params.tool_choice)
  check('responses stateless fields ignored', b.params.store === undefined && b.params.previous_response_id === undefined && b.params.include === undefined, b.params)
}

console.log('--- responses stream ---')
{
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/model', stream: true, input: 'hi' }),
  })
  check('responses stream content-type', (r.headers.get('content-type') || '').includes('text/event-stream'))
  const text = await r.text()
  const events = text.split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n')
    const eventName = lines.find((l) => l.startsWith('event: '))?.slice(7)
    const dataLine = lines.find((l) => l.startsWith('data: '))?.slice(6)
    return { eventName, data: dataLine ? JSON.parse(dataLine) : null }
  })
  const names = events.map((e) => e.eventName)
  check('responses stream event order', names[0] === 'response.created' && names[1] === 'response.in_progress'
    && names.includes('response.output_item.added') && names.includes('response.content_part.added')
    && names.includes('response.output_text.delta') && names.includes('response.function_call_arguments.done')
    && names.at(-1) === 'response.completed', names)
  check('responses stream no [DONE]', !text.includes('[DONE]'), text.slice(-80))
  const deltas = events.filter((e) => e.eventName === 'response.output_text.delta').map((e) => e.data?.delta).join('')
  check('responses stream text joined', deltas === 'Hello world', deltas)
  const fcDone = events.find((e) => e.eventName === 'response.function_call_arguments.done')
  check('responses stream function args', fcDone?.data?.arguments === '{"city":"SF"}', fcDone)
  const completed = events.at(-1)
  check('responses stream completed usage', completed?.data?.response?.status === 'completed' && completed?.data?.response?.usage?.input_tokens === 100 && completed?.data?.response?.usage?.output_tokens === 20, completed?.data?.response?.usage)
  check('responses stream sequence numbers', events.every((e, i) => e.data?.sequence_number === i), events.map((e) => e.data?.sequence_number))
}

console.log('--- responses zero output / upstream errors ---')
{
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/zero', input: 'q' }),
  })
  const body = await r.json()
  check('responses zero output 429 non-stream', r.status === 429 && body.error.type === 'rate_limit_error' && body.retry_after === 10 && r.headers.get('retry-after') === '10', body)
}
{
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/zero', stream: true, input: 'q' }),
  })
  const ct = r.headers.get('content-type') || ''
  const body = await r.json()
  check('responses zero stream → JSON 429 (not SSE 200)', r.status === 429 && ct.includes('json') && !ct.includes('event-stream') && body.error.type === 'rate_limit_error' && body.retry_after === 10, { ct, body })
}
{
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/upstream-429', input: 'q' }),
  })
  const body = await r.json()
  check('responses upstream 429 mapped', r.status === 429 && body.error.type === 'rate_limit_error' && body.retry_after === undefined, body)
}
{
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/event-error', stream: true, input: 'q' }),
  })
  const ct = r.headers.get('content-type') || ''
  const body = await r.json()
  check('responses stream error before output → JSON 429', r.status === 429 && ct.includes('json') && !ct.includes('event-stream') && body.error.type === 'rate_limit_error', { ct, body })
}
{
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/midstream-error', stream: true, input: 'q' }),
  })
  const text = await r.text()
  check('responses midstream error keeps SSE 200', r.status === 200 && (r.headers.get('content-type') || '').includes('text/event-stream'), r.status)
  check('responses midstream error has partial + error event', text.includes('"delta":"partial"') && text.includes('event: error') && !text.includes('response.completed'), text.slice(-200))
}

console.log('--- client disconnect ---')
{
  const ac = new AbortController()
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/slow', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    signal: ac.signal,
  })
  const reader = r.body!.getReader()
  await reader.read()
  ac.abort()
  await Bun.sleep(600)
  const health = await fetch(BASE + '/health')
  check('server alive after disconnect', health.status === 200)
}
{
  const ac = new AbortController()
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/slow', stream: true, input: 'hi' }),
    signal: ac.signal,
  })
  const reader = r.body!.getReader()
  await reader.read()
  ac.abort()
  await Bun.sleep(600)
  const health = await fetch(BASE + '/health')
  check('server alive after responses disconnect', health.status === 200)
  const readyz = await (await fetch(BASE + '/readyz')).json()
  check('responses disconnect released gate slot', readyz.gate?.inFlight === 0 && readyz.gate?.queued === 0, readyz.gate)
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)

export {}
