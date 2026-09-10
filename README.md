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
- **Resilience**: zero-output → `429` retryable, idle timeout (30s stream / 90s non-stream, overridable via `CC_STREAM_IDLE_MS` / `CC_NONSTREAM_IDLE_MS`, defaults unchanged; thinking phase `start`/`start-step`/`reasoning-start`/`reasoning-delta` gets a 120s window via `CC_THINKING_IDLE_MS`) → `429`, disconnect aborts upstream
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
| `CORS_ALLOW_ORIGIN` | `corsAllowOrigin` | auto (see below) |
| `LOG_FILE` | `logFile` | `""` (console only) |
| `LOG_LEVEL` | `logLevel` | `info` |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels` | `true` |
| `CC_MODEL_REFRESH_INTERVAL_MS` | `modelRefreshIntervalMs` | `300000` |
| `CMD_ZDR` | `zdr` | `false` |
| `CC_MAX_BODY_MB` | — (env only) | `100` |
| `CC_STREAM_IDLE_MS` | — (env only) | `30000` |
| `CC_NONSTREAM_IDLE_MS` | — (env only) | `90000` |
| `CC_THINKING_IDLE_MS` | — (env only) | `120000` (thinking-phase grace: `start`/`start-step`/`reasoning-start`/`reasoning-delta`; use `180000` for deep reasoning / high `reasoning_effort`; cost of raising is slower failure detection on true hangs) |

> **Note on defaults:** source runs (`bun start`), Docker images, and Release
> binaries all share one set of builtin defaults — `3050` / `0.0.0.0` — matching
> the tracked `config.json`. `PORT` / `HOST` must be positive finite numbers;
> an invalid value aborts startup with a clear error.

### CORS

`Access-Control-Allow-Origin` is auto-derived from whether you configured a
fallback key:

| `CC_API_KEY` | `CORS_ALLOW_ORIGIN` | Effect |
|--------------|---------------------|--------|
| empty | unset | `Allow-Origin: *` — any web page may call, but **must** send its own `user_*` key |
| set | unset | Browser cross-origin calls are refused (returned as `null`) so arbitrary web pages can't silently drain your fallback key's quota; curl / SDKs (no `Origin` header) are unaffected |
| any | e.g. `https://app.example.com` | Allow exactly that origin (comma-separated list also works) |

Set `CORS_ALLOW_ORIGIN=*` explicitly if you truly want open browser access
alongside a fallback key.

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

## Long Sessions / Context Management

> The proxy is stateless: `src/cc.ts` forwards the full message history on
> every request — no prune / trim / compact. History growth lives on the
> caller (Claude Code, Cline, your agent loop), not in the proxy. So context
> hygiene is a **client habit**, not a server setting. Facts that shape the
> habits below: stream idle timeout 30s / non-stream 90s (overridable via `CC_STREAM_IDLE_MS` / `CC_NONSTREAM_IDLE_MS`, defaults unchanged; per-key consecutive
> counter, ≥3 → message tells you to reduce context); body cap 100MB
> (`CC_MAX_BODY_MB`); over-long prompts are normalized to `400`
> `context_window_exceeded` on both HTTP (`mapCcError`) and in-stream error
> events (`mapCcEventError`, keyword match wins even over `<429>`); sessions
> are per-key, 12h + ≤1h jitter — a new key or a new session resets to zero;
> `GET /v1/models` exposes `context_window` (provider passthrough
> `context_window` / `context_length` / `max_context_tokens` + static fallback
> in `src/models.ts`), so pin a large-window model programmatically and fall
> back to manual lookup only for models still without a window.

1. **Pass file paths, don't paste contents.** Anything pasted into `messages`
   is re-sent verbatim on every turn and can never be trimmed by the proxy.
   Prefer `Read`-style tool calls (`/path/to/file`, offset/limit) over
   inlining whole files.
2. **Narrow subagent scope + read-only tools.** One task per subagent, with
   only the tools it needs (e.g. read/grep, no write/edit/exec). A wide
   subagent drags its whole transcript back into your main context.
3. **Cap each tool result.** Truncate / head / grep before returning: large
   `tool_result` blocks are history too and compound every round-trip. If a
   result is huge, summarize it and drop the raw text in the next turn.
4. **New task → new session (≈ `/clear`).** At a task boundary, start a fresh
   conversation instead of reusing a long one. Switching API key (new per-key
   session) has the same reset effect. Reusing `x-session-id` /
   `prompt_cache_key` headers keeps the session — omit them when you want a
   clean slate.
5. **Pin a large-window model for context-heavy work.** `GET /v1/models` now
   carries `context_window` (provider fields `context_window` /
   `context_length` / `max_context_tokens`, static fallback for known ids in
   `src/models.ts`). Query it and hardcode the model id on tasks that need
   long context (repo-wide refactors, big log dives). Manual lookup is only
   needed for ids still without a published window.
6. **Watch `finish` usage, not just errors.** On stream / non-stream paths
   the final chunk carries `usage` (`prompt_tokens` / `inputTokens`
   climbing turn after turn is your early warning). If `inputTokens` keeps
   rising with no task progress, trim or restart before you hit the wall.

### Error cheat sheet (check `message` + `retry_after` / `Retry-After`)

| Signal | Meaning | Do this (don't blind-retry) |
|--------|---------|-----------------------------|
| `400` `context_window_exceeded` | Prompt matched `CONTEXT_WINDOW_EXCEEDED_PATTERN` (`src/errors.ts`) on HTTP or in-stream error — over-long by keyword even if upstream said `429` | Trim history / summarize / start a new session. Retrying the same payload always fails. |
| `429` `Empty response` / zero output, `retry_after: 10` | Upstream returned zero output tokens | Safe to retry once with backoff; if it repeats, shrink context and simplify the last turn. |
| `429` idle timeout, `retry_after: 5` | No upstream bytes for 30s (stream) / 90s (non-stream) (overridable via `CC_STREAM_IDLE_MS` / `CC_NONSTREAM_IDLE_MS`, defaults unchanged); **thinking phase** (`lastCcEvent` in `start`/`start-step`/`reasoning-start`/`reasoning-delta`) gets a 120s window (`CC_THINKING_IDLE_MS`); per-key consecutive counter, ≥3 → message tells you to reduce context **even when the current request is small (idle ≠ large context)** | Don't blind-compress: first check which `429` it is (see below). If `retry_after: 5`, suspect slow upstream / fan-out / huge `tool_result` / reasoning pause; split the task, cap tool results, lower concurrency. If the log shows `thinkingPhase=true` + `lastCcEvent=reasoning-start` + `elapsedMs≈timeoutMs`, raise `CC_THINKING_IDLE_MS` instead (see "Fails while thinking" below). |
| `429` thinking timeout, `retry_after: 5` + `thinkingPhase=true` | `reasoning-start` followed by 30s+ of zero upstream bytes: `readWithTimeout` used to kill it at 30s (before the 120s thinking grace existed). Unrelated to context size — streaming-timeout `inputTokens` is always `0`, so it can't judge size. Self-proof triple: `lastCcEvent=reasoning-start`/`start` with no delta + `bytesReceived` of tens of bytes + `elapsedMs` pinned at the threshold. Opencode wraps it as `failed to send message`. | Don't compress context. Raise `CC_THINKING_IDLE_MS` (e.g. `180000` for deep reasoning), or split the task / lower `reasoning_effort`. True hang cost: failure detection is delayed to the threshold. |
| `429` true rate limit, `retry_after: 30` | Real upstream `402/429` mapped through `src/errors.ts` | Back off and honor `Retry-After`. Trimming won't help — wait, then retry. |
| `502/503` other | Genuine upstream error (`CC_STATUS_MAP`; unlisted → `502 upstream_error`) | Retry / backoff. |

How to tell the three `429`s apart: read the body — `message` text plus the
numeric `retry_after` (`10` = zero-output, `5` = idle timeout, `30` = real
rate limit). `sendJSON` also mirrors `retry_after` as a `Retry-After`
response header, so SDK auto-retry works when the case is actually retryable.
Opencode wraps this proxy's `429` body as `Opencode failed to send message ...
rate_limit_error` — when you see that wrapper, unwrap it and check the inner
`retry_after` before deciding.

### Fails while thinking (deep reasoning / high `reasoning_effort`)?

- **Symptom:** `429` `retry_after: 5` wrapped by Opencode as `failed to send message`,
  right after a long reasoning pause (30s+ with no output).
- **Confirm:** server log line carries `thinkingPhase=true` + `lastCcEvent=reasoning-start`
  (or `start` with no delta) + `elapsedMs` pinned at `timeoutMs` + `bytesReceived` of
  tens of bytes. That triple = thinking timeout, not context bloat. Do **not** compress context.
- **Fix:** raise `CC_THINKING_IDLE_MS` (e.g. `180000`); if still pinned at the threshold,
  keep raising, or split the task / lower `reasoning_effort`. Trade-off: a true hang
  now takes the full threshold to surface.

### Small context but still told to `reduce context`?

`src/runtime.ts:58-62` switches the idle-timeout copy to `try reducing context
length (summarize earlier messages)` once **the same API key** has
**≥3 consecutive timeouts** (TTL 30min, success resets to zero). After that
point **every** idle timeout on that key carries the "reduce context" wording —
even a tiny request. It does **not** mean the current prompt is too large.

- **Idle ≠ large.** Idle timeout fires on *no upstream bytes* for 30s/90s.
  Small context + subagent fan-out, one giant `tool_result`, a long reasoning
  pause, or just a slow upstream all trigger it.
- **Counter is per-key, shared.** Main + subagents using the same key share
  one counter and (by default) one upstream `x-session-id` (12h, `src/session.ts`),
  so they pollute each other: 3 slow subagent calls poison the 4th tiny call.
- **Read the log.** A `Stream idle timeout` line with small `inputTokens` +
  `lastCcEvent` stuck with no delta + `bytesReceived ≈ 0` = upstream was slow,
  not your context. Large `inputTokens` climbing turn after turn = real bloat.
- **Stop the bleed (30s triage):** give subagents their own key; new task →
  new session (omit `x-session-id` / `prompt_cache_key`); lower concurrency
  (one subagent, one task); truncate `tool_result` before returning; if the
  upstream is legitimately slow, raise `CC_STREAM_IDLE_MS=60000` /
  `CC_NONSTREAM_IDLE_MS=120000` (tolerates slow first-token but delays
  failure detection — see `.env.example`).

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
