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
      return Response.json({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] })
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
}

console.log('--- auth / parse errors ---')
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x', messages: [] }),
  })
  const body = await r.json()
  check('missing key 401', r.status === 401 && body.error.type === 'auth_error')
}
{
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })
  const body = await r.json()
  check('messages missing key 401', r.status === 401 && body.error.type === 'authentication_error')
}
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer user_ok_1' }, body: 'not-json',
  })
  const body = await r.json()
  check('invalid JSON 400', r.status === 400 && body.error.message === 'Invalid JSON body')
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
}
{
  const r = await fetch(BASE + '/v1/models')
  check('models without key still lists (fallback path allowed)', r.status === 200)
}

console.log('--- models ---')
{
  const r = await fetch(BASE + '/v1/models', { headers: { authorization: `Bearer ${KEY}` } })
  const body = await r.json()
  check('models from provider API', r.status === 200 && body.object === 'list' && body.data.length === 2 && body.data[0].id === 'mock-model-a', body)
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
  check('session header present', !!h['x-session-id'] && h['x-session-id'].length >= 8)
  check('project slug format', /^-?[a-z0-9-]+$/.test(h['x-project-slug'] || ''), h['x-project-slug'])
  check('traceparent format', /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(h['traceparent'] || ''), h['traceparent'])
  check('cli version header', !!h['x-command-code-version'])
  check('co/taste flags', h['x-co-flag'] === 'false' && h['x-taste-learning'] === 'false')

  const b = s.lastGenerateBody
  check('params.stream always true', b.params.stream === true)
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
  const b = s.lastGenerateBody
  check('top_p passed through', b.params.top_p === 0.9, b.params)
  check('stop passed through as array', Array.isArray(b.params.stop) && b.params.stop[0] === 'END' && b.params.stop[1] === '\n\n', b.params.stop)
  check('user passed through', b.params.user === 'u_abc', b.params.user)
  check('seed passed through', b.params.seed === 42, b.params.seed)
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
  check('anthropic top_p → CC top_p', b.params.top_p === 0.5, b.params)
  check('anthropic stop_sequences → CC stop', Array.isArray(b.params.stop) && b.params.stop[0] === 'STOP', b.params.stop)
  check('anthropic metadata.user_id → CC user', b.params.user === 'u_xyz', b.params.user)
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
  check('upstream 429 mapped', r.status === 429 && body.error.message === 'rate limited upstream' && body.retry_after === 30, body)
}
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/event-error', stream: true, messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  check('stream error event before output → JSON 429', r.status === 429 && body.error.type === 'rate_limit_error' && body.retry_after === 30, body)
}
{
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'mock/event-error', messages: [{ role: 'user', content: 'q' }] }),
  })
  const body = await r.json()
  check('non-stream error event → JSON 429', r.status === 429 && body.error.type === 'rate_limit_error' && body.retry_after === 30, body)
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
  check('anthropic thinking block', body.content?.[0]?.type === 'thinking' && body.content?.[0]?.thinking === 'thinking hard' && typeof body.content?.[0]?.signature === 'string' && body.content?.[0]?.signature.startsWith('E'), body.content)
  const s = await statsFetch()
  check('thinking → reasoning_effort high', s.lastGenerateBody.params.reasoning_effort === 'high', s.lastGenerateBody.params)
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

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)

export {}
