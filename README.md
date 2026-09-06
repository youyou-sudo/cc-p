# cc-p — Command Code Proxy

> [中文文档](README_zh.md)

A reverse proxy that exposes the Command Code API as **OpenAI Chat Completions** and **Anthropic Messages** compatible endpoints.

Built by observing official CLI traffic to faithfully replicate the upstream protocol — device fingerprint, lifecycle events, session headers, versioning, and tracing.

Stack: **Bun + Elysia + TypeScript**. Single-file binary via `bun build --compile`, distroless Docker image.

## Features

- **Dual protocol**: `POST /v1/chat/completions` (OpenAI) + `POST /v1/messages` (Anthropic)
- **Streaming & non-streaming**, tool calling, multimodal images, `reasoning_effort` / `thinking`
- **Dynamic models**: `GET /v1/models` from Provider API (5 min cache) with builtin fallback
- **CLI emulation**: per-key device fingerprint (8h + 2h jitter), lifecycle `cli_session_exists`, per-key session (12h + 1h jitter), `x-command-code-version` from npm (24h refresh), `traceparent`, `x-project-slug`
- **Resilience**: zero-output → `429` retryable, idle timeout (30s stream / 90s non-stream) → `429`, disconnect aborts upstream
- **Auth flexibility**: per-request `Bearer user_*` / `x-api-key`, optional `CC_API_KEY` fallback for self-host
- **Ops ready**: `GET /health`, `server healthcheck` CLI, Docker HEALTHCHECK, privacy-aware logs (no keys, bodies, or stacks)

## Quick Start

No runtime needed — download the single-file binary for your platform from
[GitHub Releases](https://github.com/youyou-sudo/cc-p/releases) and run it:

| OS | Arch | Asset |
|----|------|-------|
| Linux | x64 / arm64 | `cc-p-linux-x64`, `cc-p-linux-arm64` |
| Windows | x64 / arm64 | `cc-p-windows-x64.exe`, `cc-p-windows-arm64.exe` |
| macOS | x64 / arm64 | `cc-p-darwin-x64`, `cc-p-darwin-arm64` |

```bash
# Linux / macOS
chmod +x cc-p-linux-x64
CC_API_KEY=user_xxxxxxxxx ./cc-p-linux-x64   # listens on http://0.0.0.0:3050
```

```powershell
# Windows (PowerShell)
$env:CC_API_KEY="user_xxxxxxxxx"; .\cc-p-windows-x64.exe
```

Prefer a file over env vars? Put a `config.json` / `.env` next to the binary
(see [Configuration](#configuration)) — the binary reads them from its working
directory on top of the embedded defaults. Verify with:

```bash
curl http://127.0.0.1:3050/health
# {"ok":true}

curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

> `CC_API_KEY` is optional: it acts as a fallback when a request carries no key
> (handy for self-host). Omit it and every request must send its own
> `Authorization: Bearer user_xxx` / `x-api-key`. Details in [API key](#api-key).

### Use with SDKs

```python
# OpenAI SDK
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:3050/v1", api_key="user_xxxxxxxxx")
resp = client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "hi"}],
    stream=True,
)
```

```python
# Anthropic SDK
import anthropic
client = anthropic.Anthropic(base_url="http://127.0.0.1:3050", api_key="user_xxxxxxxxx")
msg = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "hi"}],
)
```

Any OpenAI-compatible tool (Claude Code, Cline, Roo, NextChat, etc.) works by pointing `base_url` at `/v1` and using a `user_*` key.

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | `OK` (plain text) |
| `GET` | `/health` | `{"ok":true}` |
| `GET` | `/v1/models` | OpenAI-style model list |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/messages` | Anthropic Messages |

### `POST /v1/chat/completions`

Standard OpenAI schema. `stream: true` returns SSE (`data: {...}` chunks + `data: [DONE]`); otherwise a full `chat.completion` object with `prompt_tokens_details.cached_tokens`. Images via `content: [{type:"image_url", image_url:{url}}]` are forwarded as CC `image` parts. `reasoning_effort` is passed through; reasoning also surfaces as `reasoning_content` deltas.

### `POST /v1/messages`

Anthropic schema with automatic conversion:

| Anthropic | Handling |
|-----------|----------|
| `system` (string / blocks) | → OpenAI `system` message |
| `tool_result` in `user` blocks | → `role: "tool"` messages |
| `tools[].input_schema` | → `parameters` |
| `tool_choice: auto / any / tool / none` | → `auto / required / {function} / none` |
| `thinking.budget_tokens` | → `reasoning_effort` (≥10000 high, ≥5000 medium, ≥2000 low) |
| `thinking.type: adaptive` | → `reasoning_effort: effort` |
| CC `finishReason` | → `end_turn / max_tokens / tool_use` |

Streaming emits `message_start / content_block_* / message_delta / message_stop`; `thinking` blocks get a synthetic `signature` so strict SDKs validate.

### `GET /v1/models`

Tries `GET {CC_API_BASE}/provider/v1/models` with your key (10s timeout); caches for `CC_MODEL_REFRESH_INTERVAL_MS`. Falls back to the builtin list in `src/models.ts` on any failure. Set `CC_USE_PROVIDER_MODELS=false` to always use the builtin list.

## Configuration

Precedence (low → high): **builtin defaults → `config.json` → `.env` / environment**. Bun auto-loads `.env`. An empty value means "keep `config.json`"; real shell vars beat `.env`.

`config.json` holds non-sensitive defaults (tracked in git). `.env` holds secrets (git-ignored).

| Variable | `config.json` key | Default |
|----------|-------------------|---------|
| `PORT` | `port` | `3050` |
| `HOST` | `host` | `0.0.0.0` |
| `CC_API_BASE` | `apiBase` | `https://api.commandcode.ai` |
| `CC_API_KEY` | `apiKey` | `""` (no fallback) |
| `PROJECT_SLUG` | `projectSlug` | `cc-proxy` |
| `LOG_FILE` | `logFile` | `""` (console only) |
| `LOG_LEVEL` | `logLevel` | `info` |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels` | `true` |
| `CC_MODEL_REFRESH_INTERVAL_MS` | `modelRefreshIntervalMs` | `300000` |
| `CMD_ZDR` | `zdr` | `false` |
| `CC_MAX_BODY_MB` | — (env only) | `100` |

### API key

Per-request key first: `Authorization: Bearer user_xxx` or `x-api-key: user_xxx` (must match `user_[A-Za-z0-9_-]+`). If missing/invalid, the proxy falls back to `CC_API_KEY`:

```bash
CC_API_KEY=user_xxxxxxxxx ./cc-p-linux-x64
```

Leave it empty to disable the fallback — keyless requests get `401`. A client-supplied key always wins. Per-request `x-cmd-zdr: 1` header enables the ZDR route for that call even when `CMD_ZDR` is off.

Oversized bodies (> `CC_MAX_BODY_MB`) are rejected with `413`.

## Errors & Retries

| Status | When | Client action |
|--------|------|---------------|
| `400` | Bad JSON / invalid request shape | Fix request |
| `401` | Missing key, bad `user_` format, or upstream 401/403 | Check key |
| `413` | Body over size limit | Shrink payload |
| `429` | Zero output tokens (`retry_after: 10`), idle timeout (`retry_after: 5`) | SDK auto-retries via `Retry-After`; after 3 consecutive timeouts the message suggests reducing context |
| `502/503` | Upstream CC error (mapped from CC status/event) | Retry / backoff |

Upstream mapping (`src/errors.ts`): CC `402/429` → `429`, `401/403` → `401`, `400/422` → `400`, `500/502` → `502`, `503` → `503`. CC `tool-calls` is normalized to OpenAI `tool_calls` and Anthropic `tool_use` on both stream and non-stream paths.

Client disconnects (`request.signal`) abort the upstream `fetch` immediately; unfinished streams are closed without leaking sockets.

## How It Emulates the CLI

Per API key, before the first upstream call (and every ~8h after):

1. `POST /alpha/fingerprint/record` — random but plausible fingerprint (SHA-256 hashed machine/MAC/user/hostname IDs, CPU pool, memory, timezone, `win32/x64`), bound to the key.
2. `POST /alpha/lifecycle-events` (`cli_session_exists`) — sent in parallel with the fingerprint.

Each `POST /alpha/generate` then carries `Authorization`, `x-cli-environment: production`, `x-command-code-version` (npm `command-code@latest`, refreshed daily), `x-session-id` (12h per-key session, reusable via `x-session-id` / `prompt_cache_key` headers), `x-project-slug`, `traceparent` (W3C), and optional `x-cmd-zdr: 1`.

## Project Structure

```
.
├── config.json            # Non-sensitive defaults (tracked)
├── .env.example           # Template for local secrets (copy to .env)
├── src/
│   ├── index.ts           # Routes, CORS, error mapping, startup, healthcheck CLI
│   ├── config.ts          # config.json + env resolution, body-limit
│   ├── openai.ts          # POST /v1/chat/completions (stream + non-stream)
│   ├── anthropic.ts       # POST /v1/messages + Anthropic↔OpenAI conversion
│   ├── cc.ts              # CC request building + forwarding (/alpha/generate)
│   ├── sse.ts             # SSE pipeline + CC NDJSON → OpenAI chunks
│   ├── fingerprint.ts     # Fingerprint pool + init pre-requests (per key)
│   ├── session.ts         # Per-key sessions + hourly cleanup
│   ├── models.ts          # Model list + Provider API cache
│   ├── errors.ts          # Status/error/finish-reason/usage mapping
│   ├── http.ts            # JSON/SSE helpers, body reader, timeout reader
│   ├── auth.ts            # Bearer / x-api-key extraction + fallback
│   ├── runtime.ts         # Idle timeouts + consecutive-timeout counter
│   ├── version.ts         # CC version from npm registry
│   ├── util.ts            # IDs, hashing, slug, traceparent
│   └── logger.ts          # Console (+ optional file) logger
├── test/
│   ├── e2e.ts             # Integration suite against a mock upstream
│   └── timeouts.ts        # Idle-timeout + disconnect suite (~35s)
├── Dockerfile             # bun --compile → distroless
├── docker-compose.yml     # Local run (uses .env)
├── docker-compose.prod.yml# Prod run (ghcr.io image, env-driven)
└── .github/workflows/
    ├── release.yml        # Tag + cross-compile 6 binaries → draft Release
    └── deploy.yml         # Prod deploy
```

## Docker

Prefer containers? The image is the same single binary on distroless (no shell).
Only `config.json` is baked in; secrets come from the environment:

```bash
# Local container (injects ./.env via env_file)
docker compose up -d
PROXY_PORT=13050 docker compose up -d

# Manual
docker build -t commandcode-proxy:latest .
docker run -d -p 3050:3050 --env-file .env commandcode-proxy:latest
```

Health check runs the embedded CLI (`exit 0` iff `GET /health` → `{"ok":true}`):

```bash
/app/server healthcheck
```

## Development

Requires [Bun](https://bun.sh) 1.1+. Source runs and tests use `bun run` scripts:

```bash
bun install
cp .env.example .env   # fill in CC_API_KEY (optional)
bun start              # run from source → http://0.0.0.0:3050
bun run dev            # watch mode (auto-reload)
```

Mock upstream — no real API calls:

```bash
bun run test            # e2e suite (protocol, streaming, errors)
bun run test:timeouts   # idle timeout + client disconnect
bunx tsc --noEmit       # typecheck (also runs in CI)
```

Build the binary yourself:

```bash
bun build ./src/index.ts --compile --minify --outfile server && ./server
./server healthcheck
```

Pushes to `master` (non-doc changes) trigger the **Release** workflow: typecheck +
e2e tests, patch-bump from the latest `v*.*.*` tag, cross-compile the 6
platform binaries, and draft a GitHub Release with SHA-256 checksums. Manual
`minor` / `major` / `custom` bumps via **Actions → Release → Run workflow**.

## Disclaimer

For **educational and research purposes** only. Not affiliated with Command Code. You are responsible for complying with the [Command Code Terms of Service](https://commandcode.ai/tos). Keys are sent per request via headers and never logged. Keep call frequency within normal CLI usage to avoid risk controls.
