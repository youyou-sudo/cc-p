# Command Code Proxy（Elysia + Bun 版）

commandcode-proxy 的 Elysia/Bun 移植版 —— 将 Command Code API 转换为 OpenAI / Anthropic 兼容接口的反向代理。

基于对官方 CLI 网络流量的抓包分析构建，精确复刻 Command Code API 请求协议，包括设备指纹与生命周期预请求。

**功能**：OpenAI Chat Completions + Anthropic Messages API | 流式 / 非流式 | 工具调用（tool_use） | 多模态图片输入 | reasoning effort | 动态模型列表 | 缓存命中统计 | 设备指纹伪装（按 Key 绑定、自动刷新） | `x-api-key` 认证（Anthropic SDK） | 客户端断连检测并中止上游 | 零输出 → 429 自动重试 | 连续超时 → 429 自动重试 | 隐私安全日志

## 快速开始

需要 [Bun](https://bun.sh) 1.1+。

```bash
bun install
bun start        # 启动（按 .env / config.json 监听，默认 http://0.0.0.0:3050）
bun run dev      # 监听模式（文件变更自动重载）
```

参数在 `.env` 中配置（见[配置](#配置)）：在此填写你的 `CC_API_KEY`，或按请求传入。

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

## 文件结构

```
elysia/
├── .env                   # 本地配置与密钥（已 git 忽略，CC_API_KEY 写这里）
├── config.json           # 非敏感默认值（入库跟踪）
├── package.json          # bun start / bun run dev / 测试脚本
├── src/
│   ├── index.ts          # Elysia 应用：路由、CORS、错误映射、启动
│   ├── config.ts         # Bun.file + 环境变量覆写（Bun 自动加载 .env）、请求体上限
│   ├── logger.ts         # 日志（控制台 + 可选文件）
│   ├── util.ts           # 哈希、ID、项目 slug、traceparent
│   ├── http.ts           # JSON/SSE 响应工具、请求体限长读取
│   ├── runtime.ts        # 超时常量 + 连续超时计数
│   ├── version.ts        # 从 npm registry 拉取 CC 版本号
│   ├── session.ts        # 按 Key 会话（12h + 1h 抖动）
│   ├── fingerprint.ts    # 设备指纹池 + 初始化预请求
│   ├── auth.ts           # API Key 提取（Bearer / x-api-key）+ CC_API_KEY 兜底
│   ├── errors.ts         # CC 状态码/错误映射、finish reason、usage
│   ├── models.ts         # 模型列表 + Provider API 缓存
│   ├── cc.ts             # CC 请求体构建 + 转发
│   ├── sse.ts            # SSE 管道 + CC NDJSON → OpenAI chunk
│   ├── openai.ts         # POST /v1/chat/completions
│   └── anthropic.ts      # POST /v1/messages（协议转换）
├── test/
│   ├── e2e.ts            # 66 项断言的集成测试（mock 上游）
│   └── timeouts.ts       # 空闲超时 + 客户端断连测试
├── Dockerfile            # 构建：bun --compile 单二进制 → distroless 运行
├── docker-compose.yml    # 容器编排
└── tsconfig.json
```

## 配置

配置按以下优先级（低 → 高）读取：

1. 内置默认值
2. `config.json`（非敏感默认值，入库跟踪）
3. **`.env`**（随仓库附带的模板）或真实 shell 环境变量

`.env` 会在启动时由 Bun 自动加载（`bun run` 与编译后的二进制均如此），已被 git 忽略，因此是放 `CC_API_KEY` 等密钥的正确位置。仓库已附带一个带注释、可直接填写的 `.env`：

```bash
# 编辑 .env，例如：
#   CC_API_KEY=user_xxxxxxxxx
bun start
```

`.env` 中留空的项 = 采用 config.json 默认值；填写的项（或 shell 中 export 的变量）覆盖 config.json。真实 shell 环境变量优先级高于 `.env` 文件。

### 环境变量

| 变量 | 覆写 config.json |
|------|------------------|
| `PORT` | `port`（仓库 config.json 自带 `3050`） |
| `HOST` | `host`（`0.0.0.0`） |
| `CC_API_BASE` | `apiBase`（`https://api.commandcode.ai`） |
| `CC_API_KEY` | `apiKey` —— **兜底 CC API Key** |
| `PROJECT_SLUG` | `projectSlug`（`cc-proxy`） |
| `LOG_FILE` | `logFile`（空 = 仅控制台） |
| `LOG_LEVEL` | `logLevel`（`info`） |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels`（`true`） |
| `CC_MODEL_REFRESH_INTERVAL_MS` | `modelRefreshIntervalMs`（`300000`） |
| `CMD_ZDR` | `zdr`（`1`/`true` 启用） |
| `CC_MAX_BODY_MB` | 请求体上限（MB，默认 `100`），超限返回 `HTTP 413` |

### API Key

API Key 通常随每个请求通过 `Authorization: Bearer user_xxx`（OpenAI SDK）或 `x-api-key`（Anthropic SDK）传入，且必须以 `user_` 开头。

若请求未携带可用 Key，代理会回退到 `CC_API_KEY`（`.env`）中配置的 Key —— 便于本地/自托管使用。填入真实 Key 后客户端无需再传：

```bash
CC_API_KEY=user_xxxxxxxxx bun start
```

`CC_API_KEY=` 留空 = 不启用兜底，无 Key 的请求返回 `401`。请求自带的 Key 始终优先于兜底 Key。

## API 端点

### `POST /v1/chat/completions`

OpenAI Chat Completions 兼容。支持流式、非流式、工具调用、多模态图片输入、reasoning effort。

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true
}
```

流式响应为 SSE（`data: {...}` chunk，携带 `finish_reason` + `usage`，以 `data: [DONE]` 结束）。非流式返回完整 `chat.completion` 对象，`prompt_tokens_details.cached_tokens` 反映缓存命中。

### `POST /v1/messages`

Anthropic Messages API 兼容端点。支持流式（message_start / content_block_* / message_delta / message_stop）、非流式、工具调用、带签名的 `thinking` 块。

| 概念 | Anthropic 格式 | 转换 |
|------|----------------|------|
| 系统提示 | 顶层 `system` 字段 | 自动转为 OpenAI `system` 消息 |
| 工具结果 | `user` 消息中的 `tool_result` 块 | 自动转为 `role: "tool"` |
| 工具定义 | `input_schema` | 自动映射为 `parameters` |
| `tool_choice` | `{type:"auto"/"any"/"tool"}` | `any`→`required`，`tool`→function 对象 |
| 推理 | `thinking.budget_tokens` | 自动映射 `reasoning_effort`（≥10000→high，≥5000→medium，≥2000→low） |
| 停止原因 | `end_turn`/`max_tokens`/`tool_use` | 由 CC finish reason 映射 |

### `GET /v1/models`

返回可用模型列表。优先从 Provider API 动态获取（5 分钟缓存），失败时回退到内置列表。

### `GET /health`

健康检查，返回 JSON `{"ok":true}`（供内置 `server healthcheck` CLI / Docker HEALTHCHECK 使用）。

## 错误码

| HTTP 状态码 | 说明 |
|-------------|------|
| 400 | 请求格式错误 |
| 401 | API Key 缺失 / 格式非法 / 被拒绝（需 `user_` 前缀） |
| 413 | 请求体超过大小上限 |
| 429 | 零输出 token 或空闲超时（流式 30s / 非流式 90s）——SDK 会按 `Retry-After` 自动重试；连续 3 次超时后返回"压缩上下文"提示 |
| 502 | CC 上游错误 |

## Docker 部署

应用会先被 `bun build --compile` 编译成**单个可执行文件**，再在 distroless 基础镜像上运行（无 shell、无包管理器）。内置 `healthcheck` CLI 子命令用于容器健康检查。

镜像内不内置 `.env` 文件。`docker compose` 通过 `env_file` 注入你本地的 `.env`（兜底 Key 等参数从容器环境读取），或显式传参：

```bash
docker compose up -d                # 监听 0.0.0.0:3050
PROXY_PORT=13050 docker compose up -d
```

或手动构建（密钥用 `-e`/`--env-file` 传入，切勿打进镜像）：

```bash
docker build -t commandcode-proxy-elysia:latest .
docker run -d -p 3050:3050 --env-file .env commandcode-proxy-elysia:latest
```

容器内只提供 `config.json`（`.env` 留在宿主机 / 通过环境变量注入）。运行时配置从 `process.cwd()`（`/app`）解析——见 `src/config.ts` 的 `candidateDirs`。

### 单二进制 / healthcheck

脱离 Docker 直接运行或构建：

```bash
bun run src/index.ts              # 启动（开发用 bun run dev 监听）
bun build ./src/index.ts --compile --minify --outfile server
./server                          # 启动
./server healthcheck              # /health 返回 {"ok":true} 时退出码 0，否则 1
```

`/health` 返回 `{"ok":true}`，因此 `server healthcheck` 可在 distroless 中充当 Docker HEALTHCHECK。

### GitHub Releases / 预编译二进制

每次推送到 `master`（非文档改动）都会触发 **Release** 工作流（`.github/workflows/release.yml`）：自动将最新的 `v*.*.*` tag 递增**补丁版本**（`v1.0.0` → `v1.0.1` → …），用 Bun 的 `--target` 交叉编译 6 个平台的单文件二进制，并生成一个 GitHub Release 草稿：

| 平台 | 产物 |
|------|------|
| Linux x64 | `cc-p-linux-x64` |
| Linux arm64 | `cc-p-linux-arm64` |
| Windows x64 | `cc-p-windows-x64.exe` |
| Windows arm64 | `cc-p-windows-arm64.exe` |
| macOS x64 | `cc-p-darwin-x64` |
| macOS arm64 | `cc-p-darwin-arm64` |

每个二进制都内置了仓库的 `config.json` 作为默认配置，开箱即监听 `0.0.0.0:3050`；如需覆盖，请把你的 `config.json` / `.env` 放到**可执行文件同目录**（或直接导出环境变量）。

**版本管理：**

- **补丁（自动）：** 推送代码到 `master` → 自动打 `v1.2.3` → `v1.2.4` tag 并发布。纯文档提交（`*.md`、`docs/`）跳过。
- **次要/主版本（手动）：** 打开 **Actions → Release → Run workflow**，选择 `minor`（`v1.2.3` → `v1.3.0`）或 `major`（`v1.2.3` → `v2.0.0`）。
- **指定版本：** 选择 `custom` 并输入精确版本，如 `2.0.0`。
- 在已存在的 tag 上重新运行工作流，会向该 tag 的 Release 重新上传产物，而不是创建重复 Release。

本地构建同样的 6 个二进制：

```bash
for t in bun-linux-x64 bun-linux-arm64 bun-windows-x64 bun-windows-arm64 bun-darwin-x64 bun-darwin-arm64; do
  bun build ./src/index.ts --compile --production --minify \
    --target "$t" --asset config.json --outfile "dist/cc-p-${t#bun-}"
done
```

## 测试

测试套件会启动一个模拟 Command Code 上游（不产生真实 API 调用），覆盖协议转换、流式、错误映射、超时与断连处理：

```bash
bun test                 # 66 项断言的 e2e 套件
bun run test:timeouts    # 空闲超时（约 35 秒）+ 断连套件
```

## 移植说明（相对 Node 单文件原版）

- 2000 行单文件 `proxy.mjs` 拆分为 `src/` 下的职责单一模块。
- `http.createServer` + 手写路由 → Elysia 路由；Node `res` 流式写 → `ReadableStream` 响应 + 延迟发头管道（尚未输出内容时仍可返回 JSON 错误让 SDK 重试）。
- 客户端断连检测使用 Bun 的 `request.signal`（挂断时触发），替代 `res.on('close')`。
- 请求体限长在 `readJsonBody` 重新实现（content-length 快速路径 + 流式计数 + keep-alive 排空，保持原 413 行为）。
- Node `crypto`/`fs` 替换为 `Bun.CryptoHasher`/Web Crypto/`node:fs/promises`。
- **Bug 修复**：原版 Anthropic *流式* 路径把 CC 的连字符 `tool-calls` finish reason 直接传给 `mapAnthropicStopReason`（其只识别 `tool_calls`），导致流式工具调用上报 `stop_reason: end_turn`。移植版先做归一化（`tool-calls` → `tool_calls` → `tool_use`），与文档及非流式路径一致。

## 免责声明

本项目仅供**学习和研究**用途。

- **非官方**：本项目与 Command Code 无任何关联。
- **个人使用**：使用者自行承担所有责任，请遵守 [Command Code 服务条款](https://commandcode.ai/tos)。
- **API Key**：本项目不收集、不上传、不泄露你的 API Key。Key 通过 `Authorization: Bearer <key>` 或 `x-api-key` 请求头按请求传入，不会被记录日志。
- **合规性**：协议基于对本地 CLI 网络流量的被动观察，未对服务器进行任何未授权访问、破解或篡改。
- **账号风险**：请保持与正常 CLI 使用一致的调用频率，极高并发可能触发风控。
