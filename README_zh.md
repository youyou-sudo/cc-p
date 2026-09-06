# cc-p — Command Code Proxy

> [English](README.md)

把 Command Code API 暴露为 **OpenAI Chat Completions** 与 **Anthropic Messages** 兼容接口的反向代理。

通过观察官方 CLI 流量，忠实复刻上游协议——设备指纹、生命周期事件、会话头、版本号与链路追踪。

技术栈：**Bun + Elysia + TypeScript**。`bun build --compile` 打出单文件二进制，Docker 用 distroless 镜像。

## 功能

- **双协议**：`POST /v1/chat/completions`（OpenAI）+ `POST /v1/messages`（Anthropic）
- **流式 / 非流式**、工具调用、多模态图片、`reasoning_effort` / `thinking`
- **动态模型**：`GET /v1/models` 从 Provider API 获取（5 分钟缓存），失败回退内置列表
- **CLI 仿真**：按 Key 的设备指纹（8h + 2h 抖动）、`cli_session_exists` 生命周期事件、按 Key 会话（12h + 1h 抖动）、`x-command-code-version` 取自 npm（每天刷新）、`traceparent`、`x-project-slug`
- **容错**：零输出 → 可重试 `429`，空闲超时（流式 30s / 非流式 90s）→ `429`，断连立刻中止上游
- **认证灵活**：按请求的 `Bearer user_*` / `x-api-key`，自托管可选 `CC_API_KEY` 兜底
- **开箱可运维**：`GET /health`、`server healthcheck` CLI、Docker HEALTHCHECK、隐私日志（不记 Key、包体与堆栈）

## 快速开始

无需安装运行时——去 [GitHub Releases](https://github.com/youyou-sudo/cc-p/releases) 下载对应平台的单文件二进制，直接运行：

| 系统 | 架构 | 文件名 |
|------|------|--------|
| Linux | x64 / arm64 | `cc-p-linux-x64`、`cc-p-linux-arm64` |
| Windows | x64 / arm64 | `cc-p-windows-x64.exe`、`cc-p-windows-arm64.exe` |
| macOS | x64 / arm64 | `cc-p-darwin-x64`、`cc-p-darwin-arm64` |

```bash
# Linux / macOS
chmod +x cc-p-linux-x64
CC_API_KEY=user_xxxxxxxxx ./cc-p-linux-x64   # 监听 http://0.0.0.0:3050
```

```powershell
# Windows (PowerShell)
$env:CC_API_KEY="user_xxxxxxxxx"; .\cc-p-windows-x64.exe
```

不想用环境变量？把 `config.json` / `.env` 放到二进制**同目录**即可
（见[配置](#配置)）——二进制会在内嵌默认值之上读取它们。验证：

```bash
curl http://127.0.0.1:3050/health
# {"ok":true}

curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

> `CC_API_KEY` 可选：仅在请求没带 Key 时兜底（自托管省事）。不填则每个请求
> 都必须自带 `Authorization: Bearer user_xxx` / `x-api-key`。详见 [API Key](#api-key)。

### 接入 SDK

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

任何 OpenAI 兼容客户端（Claude Code、Cline、Roo、NextChat 等）只要把 `base_url`
指向 `/v1` 并使用 `user_*` Key 即可。

## API 参考

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | `OK`（纯文本） |
| `GET` | `/health` | `{"ok":true}` |
| `GET` | `/v1/models` | OpenAI 风格模型列表 |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/messages` | Anthropic Messages |

### `POST /v1/chat/completions`

标准 OpenAI 结构。`stream: true` 返回 SSE（`data: {...}` + `data: [DONE]`），否则返回完整
`chat.completion` 对象（含 `prompt_tokens_details.cached_tokens`）。图片经
`content: [{type:"image_url", image_url:{url}}]` 以 CC `image` 分片转发。
`reasoning_effort` 透传，推理内容同时以 `reasoning_content` 增量下发。

### `POST /v1/messages`

Anthropic 结构，自动转换：

| Anthropic | 处理 |
|-----------|------|
| `system`（字符串 / blocks） | → OpenAI `system` 消息 |
| `user` 块中的 `tool_result` | → `role: "tool"` 消息 |
| `tools[].input_schema` | → `parameters` |
| `tool_choice: auto / any / tool / none` | → `auto / required / {function} / none` |
| `thinking.budget_tokens` | → `reasoning_effort`（≥10000 high，≥5000 medium，≥2000 low） |
| `thinking.type: adaptive` | → `reasoning_effort: effort` |
| CC `finishReason` | → `end_turn / max_tokens / tool_use` |

流式输出 `message_start / content_block_* / message_delta / message_stop`；
`thinking` 块会带一个合成 `signature`，满足严格 SDK 的校验。

### `GET /v1/models`

用你的 Key 请求 `GET {CC_API_BASE}/provider/v1/models`（10s 超时），按
`CC_MODEL_REFRESH_INTERVAL_MS` 缓存。任何失败都回退到 `src/models.ts` 内置列表。
`CC_USE_PROVIDER_MODELS=false` 则始终用内置列表。

## 配置

优先级（低 → 高）：**内置默认值 → `config.json` → `.env` / 环境变量**。
Bun 启动时自动加载 `.env`。空值 = 沿用 `config.json`；真实 shell 变量优先于 `.env`。

`config.json` 放非敏感默认值（入库跟踪），`.env` 放密钥（git 忽略）。

| 变量 | `config.json` 键 | 默认值 |
|------|------------------|--------|
| `PORT` | `port` | `3050` |
| `HOST` | `host` | `0.0.0.0` |
| `CC_API_BASE` | `apiBase` | `https://api.commandcode.ai` |
| `CC_API_KEY` | `apiKey` | `""`（无兜底） |
| `PROJECT_SLUG` | `projectSlug` | `cc-proxy` |
| `LOG_FILE` | `logFile` | `""`（仅控制台） |
| `LOG_LEVEL` | `logLevel` | `info` |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels` | `true` |
| `CC_MODEL_REFRESH_INTERVAL_MS` | `modelRefreshIntervalMs` | `300000` |
| `CMD_ZDR` | `zdr` | `false` |
| `CC_MAX_BODY_MB` | ——（仅环境变量） | `100` |

### API Key

优先用请求自带的 Key：`Authorization: Bearer user_xxx` 或 `x-api-key: user_xxx`
（须匹配 `user_[A-Za-z0-9_-]+`）。缺失/非法时回退到 `CC_API_KEY`：

```bash
CC_API_KEY=user_xxxxxxxxx ./cc-p-linux-x64
```

留空 = 关闭兜底，无 Key 请求返回 `401`。请求自带的 Key 永远优先。
即使 `CMD_ZDR` 未开启，单个请求带 `x-cmd-zdr: 1` 头也可走 ZDR 路由。

超限包体（> `CC_MAX_BODY_MB`）直接 `413` 拒绝。

## 错误与重试

| 状态码 | 场景 | 客户端动作 |
|--------|------|------------|
| `400` | JSON 非法 / 请求结构错误 | 修正请求 |
| `401` | 缺 Key、`user_` 格式错误、上游 401/403 | 检查 Key |
| `413` | 包体超限 | 缩小请求体 |
| `429` | 零输出（`retry_after: 10`）、空闲超时（`retry_after: 5`） | SDK 按 `Retry-After` 自动重试；连续 3 次超时后提示压缩上下文 |
| `502/503` | CC 上游错误（由 CC 状态/事件映射） | 重试 / 退避 |

上游映射（`src/errors.ts`）：CC `402/429` → `429`，`401/403` → `401`，
`400/422` → `400`，`500/502` → `502`，`503` → `503`。CC 的 `tool-calls`
在流式与非流式路径统一归一化为 OpenAI `tool_calls` / Anthropic `tool_use`。

客户端断开（`request.signal`）会立刻 abort 上游 `fetch`，未完成的流直接关闭，不泄漏连接。

## CLI 仿真原理

按 API Key，在首次调用上游前（之后约每 8h）执行：

1. `POST /alpha/fingerprint/record` ——随机但合理的可信指纹（SHA-256 哈希的机器/MAC/用户/主机名、CPU 池、内存、时区、`win32/x64`），与 Key 绑定。
2. `POST /alpha/lifecycle-events`（`cli_session_exists`）——与指纹并行发送。

每次 `POST /alpha/generate` 携带 `Authorization`、`x-cli-environment: production`、
`x-command-code-version`（npm `command-code@latest`，每天刷新）、`x-session-id`
（按 Key 12h 会话，可经 `x-session-id` / `prompt_cache_key` 复用）、`x-project-slug`、
`traceparent`（W3C），以及可选的 `x-cmd-zdr: 1`。

## 项目结构

```
.
├── config.json            # 非敏感默认值（入库跟踪）
├── .env.example           # 本地密钥模板（复制为 .env）
├── src/
│   ├── index.ts           # 路由、CORS、错误映射、启动、healthcheck CLI
│   ├── config.ts          # config.json + 环境变量解析、包体上限
│   ├── openai.ts          # POST /v1/chat/completions（流式 + 非流式）
│   ├── anthropic.ts       # POST /v1/messages + Anthropic↔OpenAI 转换
│   ├── cc.ts              # CC 请求构建 + 转发（/alpha/generate）
│   ├── sse.ts             # SSE 管道 + CC NDJSON → OpenAI chunk
│   ├── fingerprint.ts     # 指纹池 + 初始化预请求（按 Key）
│   ├── session.ts         # 按 Key 会话 + 每小时清理
│   ├── models.ts          # 模型列表 + Provider API 缓存
│   ├── errors.ts          # 状态码/错误/finish reason/usage 映射
│   ├── http.ts            # JSON/SSE 工具、包体读取、超时读取
│   ├── auth.ts            # Bearer / x-api-key 提取 + 兜底
│   ├── runtime.ts         # 空闲超时 + 连续超时计数
│   ├── version.ts         # 从 npm registry 取 CC 版本号
│   ├── util.ts            # ID、哈希、slug、traceparent
│   └── logger.ts          # 控制台（+ 可选文件）日志
├── test/
│   ├── e2e.ts             # 对 mock 上游的集成测试
│   └── timeouts.ts        # 空闲超时 + 断连测试（约 35s）
├── Dockerfile             # bun --compile → distroless
├── docker-compose.yml     # 本地运行（用 .env）
├── docker-compose.prod.yml# 生产运行（ghcr.io 镜像，环境变量驱动）
└── .github/workflows/
    ├── release.yml        # 打 tag + 交叉编译 6 个二进制 → Release 草稿
    └── deploy.yml         # 生产部署
```

## Docker

想用容器？镜像就是跑在 distroless 上的同一个单二进制（无 shell）。
只内置 `config.json`，密钥全部走环境变量：

```bash
# 本地容器（通过 env_file 注入 ./.env）
docker compose up -d
PROXY_PORT=13050 docker compose up -d

# 手动
docker build -t commandcode-proxy:latest .
docker run -d -p 3050:3050 --env-file .env commandcode-proxy:latest
```

健康检查用内嵌 CLI（`GET /health` 返回 `{"ok":true}` 时退出码为 0）：

```bash
/app/server healthcheck
```

## 开发

需要 [Bun](https://bun.sh) 1.1+。源码运行与测试才用 `bun run` 脚本：

```bash
bun install
cp .env.example .env   # 填入 CC_API_KEY（可选）
bun start              # 从源码运行 → http://0.0.0.0:3050
bun run dev            # 监听模式（自动重载）
```

Mock 上游，无真实 API 调用：

```bash
bun run test            # e2e（协议、流式、错误）
bun run test:timeouts   # 空闲超时 + 客户端断连
bunx tsc --noEmit       # 类型检查（CI 同样会跑）
```

自己打二进制：

```bash
bun build ./src/index.ts --compile --minify --outfile server && ./server
./server healthcheck
```

推送到 `master`（非文档改动）会触发 **Release** 工作流：类型检查 + e2e 测试、
按最新 `v*.*.*` tag 递增补丁版本、交叉编译 6 个平台二进制、生成带 SHA-256
校验的 GitHub Release 草稿。`minor` / `major` / `custom` 通过
**Actions → Release → Run workflow** 手动触发。

## 免责声明

本项目仅供**学习和研究**用途，与 Command Code 无任何关联。使用即表示你会遵守
[Command Code 服务条款](https://commandcode.ai/tos)。Key 经请求头按次传入，
不会被记录日志。请保持与正常 CLI 一致的调用频率，避免触发风控。
