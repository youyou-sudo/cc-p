# Command Code Proxy (Elysia + Bun)

> [中文文档](README_zh.md)

Elysia/Bun port of [commandcode-proxy](../commandcode-proxy) — a reverse proxy that converts the Command Code API into OpenAI / Anthropic compatible endpoints.

Built by analyzing official CLI network traffic to accurately replicate the Command Code API request protocol, including device-fingerprint and lifecycle pre-requests.

**Features**: OpenAI Chat Completions + Anthropic Messages API | Streaming & non-streaming | Tool calling (tool_use) | Multimodal image input | Reasoning effort | Dynamic model list | Cache hit metrics | Device fingerprint disguise (per-key, auto-refresh) | `x-api-key` auth (Anthropic SDK) | Client disconnect detection with upstream abort | Zero-output → 429 auto-retry | Consecutive timeout → 429 auto-retry | Privacy-aware logging

## Quick Start

Requires [Bun](https://bun.sh) 1.1+.

```bash
bun install
bun start        # Start (listens on http://0.0.0.0:3050 per .env / config.json)
bun run dev      # Watch mode (auto-reload on file changes)
```

Settings live in `.env` (see [Configuration](#configuration)); fill in your `CC_API_KEY` there or pass it per request.

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

## File Structure

```
elysia/
├── .env                   # Local settings & secrets (git-ignored, CC_API_KEY here)
├── config.json            # Non-sensitive defaults (tracked)
├── package.json           # bun start / bun run dev / tests
├── src/
│   ├── index.ts           # Elysia app: routes, CORS, error mapping, startup
│   ├── config.ts         # Bun.file + env overrides (Bun auto-loads .env), body limit
│   ├── logger.ts         # Log helper (console + optional file)
│   ├── util.ts           # Hashing, ids, project slug, traceparent
│   ├── http.ts           # JSON/SSE response helpers, body limit reader
│   ├── runtime.ts        # Timeout constants + consecutive timeout state
│   ├── version.ts        # Dynamic CC version from npm registry
│   ├── session.ts        # Per-key sessions (12h + 1h jitter)
│   ├── fingerprint.ts    # Device fingerprint pool + init pre-requests
│   ├── auth.ts           # API key extraction (Bearer / x-api-key) + CC_API_KEY fallback
│   ├── errors.ts         # CC status/error mapping, finish reasons, usage
│   ├── models.ts         # Model list + Provider API cache
│   ├── cc.ts             # CC request building + forwarding
│   ├── sse.ts            # SSE pipeline + CC NDJSON → OpenAI chunks
│   ├── openai.ts         # POST /v1/chat/completions
│   └── anthropic.ts      # POST /v1/messages (protocol conversion)
├── test/
│   ├── e2e.ts            # 66-assertion integration suite (mock upstream)
│   └── timeouts.ts       # Idle timeout + client disconnect suite
├── Dockerfile            # Build: bun --compile single binary → distroless runtime
├── docker-compose.yml    # Container orchestration
└── tsconfig.json
```

## Configuration

Configuration is read from three sources, lowest to highest precedence:

1. built-in defaults
2. `config.json` (non-sensitive defaults, tracked in git)
3. **`.env`** (created from the shipped template) or real shell environment variables

`.env` is loaded automatically by Bun at startup (both `bun run` and the compiled binary). It is git-ignored, so it is the right place for secrets like `CC_API_KEY`. A `.env` file is included with every option commented and ready to fill in:

```bash
cp .env .env.example    # (optional) keep a template
# edit .env, e.g.
#   CC_API_KEY=user_xxxxxxxxx
bun start
```

An empty value in `.env` means "keep the default from config.json"; values set here (or exported in the shell) override `config.json`. Real shell variables always win over the `.env` file.

### Environment Variables

| Variable | Overrides `config.json` |
|----------|--------------------------|
| `PORT` | `port` (repo config.json ships with `3050`) |
| `HOST` | `host` (`0.0.0.0`) |
| `CC_API_BASE` | `apiBase` (`https://api.commandcode.ai`) |
| `CC_API_KEY` | `apiKey` — **fallback CC API key** |
| `PROJECT_SLUG` | `projectSlug` (`cc-proxy`) |
| `LOG_FILE` | `logFile` (empty = console only) |
| `LOG_LEVEL` | `logLevel` (`info`) |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels` (`true`) |
| `CC_MODEL_REFRESH_INTERVAL_MS` | `modelRefreshIntervalMs` (`300000`) |
| `CMD_ZDR` | `zdr` (`1`/`true` to enable) |
| `CC_MAX_BODY_MB` | Request body limit in MB (default `100`); oversized requests are rejected with `HTTP 413` |

### API Key

An API key is normally sent **per request** via `Authorization: Bearer user_xxx` (OpenAI SDKs) or `x-api-key` (Anthropic SDKs). Keys must start with `user_`.

If a request carries no usable key, the proxy falls back to the key configured in `CC_API_KEY` (`.env`) — a convenience for local/self-hosted use. Set it to a real key and clients no longer need to pass one:

```bash
CC_API_KEY=user_xxxxxxxxx bun start
```

Leaving `CC_API_KEY=` empty disables the fallback and requests without a key are rejected with `401`. A client-supplied key always takes precedence over the fallback.

## API Endpoints

### `POST /v1/chat/completions`

OpenAI Chat Completions compatible. Supports streaming, non-streaming, tool calling, multimodal image input, and reasoning effort.

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true
}
```

Streaming responses are SSE (`data: {...}` chunks with `finish_reason` + `usage`, terminated by `data: [DONE]`). Non-streaming responses return a full `chat.completion` object with `prompt_tokens_details.cached_tokens`.

### `POST /v1/messages`

Anthropic Messages API compatible endpoint. Supports streaming (message_start / content_block_* / message_delta / message_stop), non-streaming, tool calling, and `thinking` blocks with signatures.

| Concept | Anthropic Format | Conversion |
|---------|-----------------|------------|
| System prompt | Top-level `system` field | Auto-converted to OpenAI `system` message |
| Tool results | `tool_result` blocks in `user` messages | Auto-converted to `role: "tool"` |
| Tool definitions | `input_schema` | Auto-mapped to `parameters` |
| `tool_choice` | `{type:"auto"/"any"/"tool"}` | `any`→`required`, `tool`→function object |
| Reasoning | `thinking.budget_tokens` | Auto-mapped to `reasoning_effort` (≥10000→high, ≥5000→medium, ≥2000→low) |
| Stop reason | `end_turn`/`max_tokens`/`tool_use` | Auto-mapped from CC finish reasons |

### `GET /v1/models`

Returns available model list. Fetched dynamically from Provider API (5 min cache), falls back to hardcoded list on failure.

### `GET /health`

Health check. Returns JSON `{"ok":true}` (consumed by the bundled `server healthcheck` CLI / Docker HEALTHCHECK).

## Error Codes

| HTTP Status | Description |
|-------------|-------------|
| 400 | Invalid request format |
| 401 | API Key missing / invalid format / rejected (`user_` prefix required) |
| 413 | Request body exceeds the size limit |
| 429 | Zero output tokens, or idle timeout (30s streaming / 90s non-streaming) — SDK auto-retry with `Retry-After`; after 3 consecutive timeouts a "reduce context" hint is returned |
| 502 | CC upstream error |

## Anti-Detection

Same mechanisms as the original, re-implemented on Bun:

| Mechanism | Implementation |
|-----------|---------------|
| **Device Fingerprint** | `POST /alpha/fingerprint/record` before first request per key; random fingerprint pool, SHA-256 hashed, per-key binding, refreshed every 8h + 2h jitter |
| **Lifecycle Events** | `POST /alpha/lifecycle-events` (`cli_session_exists`) sent in parallel with fingerprint on session init |
| **Per-Key Session** | One session per API key, 12h expiry + 1h random jitter |
| **Version** | `x-command-code-version` auto-fetched from npm registry (24h refresh) |
| **CLI Envelope** | config/memory/taste/skills/permissionMode/params |
| **OpenTelemetry** | `traceparent` (W3C Trace Context) |
| **Project Slug** | `x-project-slug` generated from session ID (CLI-compatible format) |
| **Zero-Output Guard** | outputTokens=0 → 429 `rate_limit_error` (SDK auto-retry, anti false billing) |
| **Upstream Abort** | `AbortController` wired to the client `Request` signal + all error paths |
| **Privacy Logging** | No API key fragments, no error bodies, no stack traces in logs |

## Docker Deployment

The app is compiled into a **single executable** (`bun build --compile`) and runs on a distroless base image (no shell, no package manager). It exposes a `healthcheck` CLI subcommand for container health checks.

The image does not bake in a `.env` file. `docker compose` injects your local `.env` via `env_file` (fallback key and other settings are read from the container environment), or pass variables explicitly:

```bash
docker compose up -d                # listens on 0.0.0.0:3050
PROXY_PORT=13050 docker compose up -d
```

Or build manually (pass secrets with `-e`/`--env-file`, never bake them into the image):

```bash
docker build -t commandcode-proxy-elysia:latest .
docker run -d -p 3050:3050 --env-file .env commandcode-proxy-elysia:latest
```

Inside the container only `config.json` is provided (`.env` stays on the host / is injected as environment variables). Runtime config is resolved from `process.cwd()` (`/app`) — see `src/config.ts` `candidateDirs`.

### Single binary / healthcheck

Run or build the app standalone without Docker:

```bash
bun run src/index.ts              # start (dev, watch via bun run dev)
bun build ./src/index.ts --compile --minify --outfile server
./server                          # start
./server healthcheck              # exit 0 if /health returns {"ok":true}, exit 1 otherwise
```

`/health` returns `{"ok":true}` so `server healthcheck` works as a Docker HEALTHCHECK inside distroless.

## Testing

The test suites spin up a mock Command Code upstream (no real API calls) and assert protocol conversion, streaming, error mapping, timeouts, and disconnect handling:

```bash
bun test            # 66-assertion e2e suite
bun run test:timeouts   # idle timeout (takes ~35s) + disconnect suite
```

## Porting Notes (vs. Node single-file original)

- Single 2000-line `proxy.mjs` split into focused modules under `src/`.
- `http.createServer` + manual routing → Elysia routes; Node `res` streaming → `ReadableStream` responses with a deferred-headers pipeline (JSON errors are still returned when nothing was streamed yet).
- Client disconnect detection uses Bun's `request.signal` (fires on hangup) instead of `res.on('close')`.
- Body-size limiting re-implemented in `readJsonBody` (content-length fast path + streamed counting with keep-alive drain, matching the original 413 behavior).
- Node `crypto`/`fs` replaced with `Bun.CryptoHasher`/Web Crypto/`node:fs/promises`.
- **Bug fix**: the original's Anthropic *streaming* path mapped CC's hyphenated `tool-calls` finish reason straight to `mapAnthropicStopReason` (which only knows `tool_calls`), so streaming tool calls reported `stop_reason: end_turn`. The port normalizes the reason first (`tool-calls` → `tool_calls` → `tool_use`), matching the documented behavior and the non-streaming path.

## Disclaimer

This project is for **educational and research purposes** only.

- **Unofficial**: This project is not affiliated with Command Code in any way.
- **Personal Use**: Users assume all responsibility. Please comply with the [Command Code Terms of Service](https://commandcode.ai/tos).
- **API Key**: This project does not collect, upload, or leak your API Key. The key is sent per request via the `Authorization: Bearer <key>` or `x-api-key` header and is never logged.
- **Compliance**: The protocol is based on passive observation of local CLI network traffic.
- **Account Risk**: Keep usage frequency consistent with normal CLI usage. Extremely high concurrent calls may trigger risk controls.
