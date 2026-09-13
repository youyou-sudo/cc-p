# AGENTS.md

> Stack: **Bun + Elysia + TypeScript**。
> 动 Elysia 代码前先加载 skill: `.agents/skills/elysiajs/SKILL.md`
> (链式/命名实例/scope/model 按名引用等通用写法以 skill 为准,
> 另可查 `https://elysiajs.com/llms.txt`)。
> 本项目特有的约定 (401/413 双形、分层 barrel、防环快照) 不在 skill 里,
> 散在各文件头部“为什么”注释中 — 改哪个文件,先读完哪个文件的头注释。

## 1. 命令 — 只用 bun

```bash
bun install
bun start              # 跑源码 → http://0.0.0.0:3050
bun run dev            # --watch 自动重载
bun run test           # e2e (mock 上游, 无真实 API 调用)
bun run test:unit      # 纯函数单测 (无网络)
bun run test:timeouts  # 空闲超时 + 断开 (~35s)
bun run test:heartbeat
bunx tsc --noEmit      # 类型检查 (CI 同跑)
bun build ./src/index.ts --compile --production --minify --outfile server
```

- 禁止 `npm/node/npx/vitest/jest`。测试是直接 `bun run test/*.ts` 的脚本,
  不是测试框架。
- 配置优先级: 内置默认 → `config.json` → `.env`/环境变量 (Bun 自动加载 `.env`)。
  本地先 `cp .env.example .env`。
- 二进制/容器里配置从 `process.cwd()` 解析,不要指望 `import.meta.dir`。

## 2. 目录结构

```
src/
├── index.ts        # 启动/healthcheck CLI/脱敏, 薄
├── app.ts          # createApp(): 唯一组装点, 只 .use(), 顺序即语义, 不可乱调
├── modules/<feat>/ # chat/ messages/ models/ health/ streaming/: {index,model,service}.ts
├── plugins/        # cors/errors/body/auth: 无路由, 只贡献 hook/decorate
├── infra/          # 上游/会话/指纹/SSE
└── shared/         # kernel.ts / domain.ts / toolkit.ts 三个 barrel + 各层实现
test/               # e2e.ts unit.ts timeouts.ts heartbeat.ts idle-timeout-env.ts
```

`app.ts` 的 `.use()` 顺序即语义:
`cors → errors → bodyLimit → auth(decorate) → health → models → chat → messages`。

## 3. 约定在哪里 (只指路, 不重复写)

- Elysia 通用写法 → `.agents/skills/elysiajs/SKILL.md` (必读)
- 插件顺序/hook 语义 → `src/app.ts`、`src/plugins/*.ts` 头部注释
- Controller/Service/Model 分工、401 前检、413 哨兵、双协议错误形 →
  `src/modules/chat/index.ts`、`src/plugins/auth.ts`、`body.ts`、`errors.ts` 头部注释
- 分层与 barrel 规则 → `src/shared/kernel.ts`、`domain.ts`、`toolkit.ts` 头部
- 配置语义 (die/warn、bool 严格解析、IIFE 快照) → `src/shared/config.ts`
- 安全与日志 (脱敏、key 白名单、Map 上限) →
  `src/shared/errors.ts`、`auth.ts`、`logger.ts`、`src/index.ts`
- 测试写法 → `test/e2e.ts` (mock + `Bun.serve`)、`test/unit.ts` (`check` 计数)
