# 模块报告：src/shared/config.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/shared/config.ts` |
| 行数 | 168 |
| 层级 | 基础设施层 |
| 依赖 | `src/shared/api-keys.ts`（仅类型 `ApiKeyPool`）+ Bun 全局 `Bun.isStandaloneExecutable` / `Bun.file` 与 `process`、`console` |
| 被依赖 | `src/shared/logger.ts`、`src/shared/http.ts`、`src/shared/auth.ts`、`src/shared/runtime.ts`、`src/index.ts`、`src/plugins/errors.ts`、`src/infra/fingerprint.ts`、`src/infra/cc.ts`、`src/infra/proxy-slot.ts`（⚠ 未接线）、`src/modules/models/catalog.ts`、`test/idle-timeout-env.ts` |

## 职责

- 三层覆盖的配置加载：**内置默认值 → config.json → 环境变量**，在模块求值期一次性完成（顶层 `await loadConfig()`），导出只读单例 `CFG`。
- 探测 config.json 位置，并兼容两种运行形态：`bun build --compile` 独立二进制（Docker / Release）与源码运行。
- 定义请求体上限 `MAX_BODY_SIZE` 及三种空闲超时常量（stream / nonstream / thinking），供 http、runtime 消费。
- 非法配置 fail-fast（`die()`），缺失或损坏的 config.json 则静默回退。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | — | import | — | `./api-keys`（仅类型 `ApiKeyPool`） |
| 3-22 | `AppConfig` | interface | E | 配置接口，共 18 个字段：`port`、`host`、`apiBase`、`apiKey`、`corsAllowOrigin`、`logFile`、`logLevel`、`useProviderModels`、`modelRefreshIntervalMs`、`zdr`、`maxConcurrencyPerKey`、`maxQueuePerKey`、`queueTimeoutMs`、`keySelectionStrategy`、`retryMax`、`retryBaseMs`、`retryCapMs`、`emptySystemPlaceholder` |
| 24-27 | `die` | 函数 | P | 打印 `[config] <message>` 到 stderr 后 `process.exit(1)`，返回类型 `never` |
| 29-46 | `candidateDirs` | 函数 | P | 目录探测顺序。独立二进制：`process.cwd()` → `import.meta.dir`（内嵌 `--asset config.json` 副本，Linux `/$bunfs/root`、Windows `B:\~BUN\root`）；源码运行：项目根（`import.meta.dir + '/../..'`，`src/shared/` 上两级）→ cwd；`import.meta.dir` 含 `$bunfs` 时跳过项目根 |
| 48-61 | `findConfigJson` | 函数 | P | 按 `candidateDirs()` 逐个查 `<dir>/config.json`（去掉尾部 `\`/`/`），存在即 `JSON.parse`；解析失败打印 `[config] Failed to parse config.json:` 并返回 null |
| 63-65 | `AppConfigWithSource` | interface | E | 扩展接口，追加可选 `configPath?: string`（当前无消费方） |
| 67-70 | `envString` | 函数 | P | 读取环境变量；`undefined` 或空串（`''`）一律视为未设置 |
| 72-78 | `envNumber` | 函数 | P | 基于 `envString`；非有限数字调用 `die('Invalid numeric value for <key>: ...')` |
| 80-84 | `envBool` | 函数 | P | 仅 `'1'` 或大小写不敏感的 `'true'` 判定为 true，其余为 false |
| 86-92 | `envBoolDefaultTrue` | 函数 | P | 默认 true 语义：`'false'`/`'0'`/`'no'`（不区分大小写）为 false，其余为 true |
| 94-147 | `loadConfig` | 函数 | P | 默认值对象（`port:3050`、`host:'0.0.0.0'`、`apiBase:'https://api.commandcode.ai'`、`apiKey:''`、`corsAllowOrigin:''`、`logFile:''`、`logLevel:'info'`、`useProviderModels:true`、`modelRefreshIntervalMs:5*60*1000`、`zdr:false`、`maxConcurrencyPerKey:16`、`maxQueuePerKey:64`、`queueTimeoutMs:60_000`、`keySelectionStrategy:'roundRobin'`、`retryMax:5`、`retryBaseMs:1_000`、`retryCapMs:30_000`、`emptySystemPlaceholder:true`）→ `Object.assign` 合并文件配置 → 校验 port 为正数、modelRefreshIntervalMs 非负 → 环境变量覆盖 |
| 118-121 | 文件合并逻辑 | 逻辑 | P | `findConfigJson()` 结果非空即 `Object.assign(config, fileConfig)`，文件优先于内置默认 |
| 123-128 | 校验逻辑 | 逻辑 | P | port 非有限或 ≤0、modelRefreshIntervalMs 非有限或 <0 均 `die()` |
| 130-144 | 环境变量覆盖 | 逻辑 | P | `PORT`、`HOST`、`CC_API_BASE`、`CC_API_KEY`、`CORS_ALLOW_ORIGIN`、`LOG_FILE`、`LOG_LEVEL`、`CC_USE_PROVIDER_MODELS`、`CC_MODEL_REFRESH_INTERVAL_MS`、`CMD_ZDR`、`CC_KEY_SELECTION_STRATEGY`（`round-robin`/`affinity` 归一化，其余回落 `roundRobin`）、`CC_EMPTY_SYSTEM_PLACEHOLDER`（默认 true 语义） |
| 149 | `CFG` | 常量 | E | 顶层 `await loadConfig()` 得到的全局配置单例 |
| 151-154 | `MAX_BODY_SIZE` | 常量 | E | IIFE；`CC_MAX_BODY_MB` 为正值时 `mb*1024*1024`，否则默认 100MiB |
| 156-159 | `STREAM_IDLE_TIMEOUT_MS` | 常量 | E | IIFE；`CC_STREAM_IDLE_MS` 为正值时采用，否则 30_000 |
| 160-163 | `NONSTREAM_IDLE_TIMEOUT_MS` | 常量 | E | IIFE；`CC_NONSTREAM_IDLE_MS` 为正值时采用，否则 90_000 |
| 165-168 | `THINKING_IDLE_TIMEOUT_MS` | 常量 | E | IIFE；容忍 reasoning 长 prefill / 首 token 停顿，`CC_THINKING_IDLE_MS` 为正值时采用，否则 120_000；0/空回默认，非法数字走 `envNumber` 的 `die()` |

## 关键行为

- **单例时序**：第 149 行顶层 `await`，任何 import 者拿到的都是终值；env 覆盖不会迟到。三个超时常量（151-168）也在此阶段求值完毕。
- **优先级不变式**：默认值 < config.json < 环境变量（118-144）；文件配置整体 `Object.assign`，不逐字段校验类型。
- **容错策略**：config.json 缺失/损坏不致命（返回 null 回退默认+env）；port 与 modelRefreshIntervalMs 非法则启动即退出（fail-fast）。
- **双形态目录探测**：`Bun.isStandaloneExecutable` 为真时 cwd 优先，否则源码形态优先项目根；`candidateDirs()` 注释（31-43）说明 `$bunfs` 内嵌副本与磁盘真实文件的差异。
- **易错点**：`envBool` 与 `envBoolDefaultTrue` 语义相反——前者未列出的值（如 `'yes'`）为 false，后者仅在显式否定时为 false。
- ⚠ **七项配置无消费方**：`maxConcurrencyPerKey`、`maxQueuePerKey`、`queueTimeoutMs`、`keySelectionStrategy`、`retryMax`、`retryBaseMs`、`retryCapMs` 的唯一读取方是 `src/infra/proxy-slot.ts`，而该文件未接线（见 [45-proxy-slot.md](45-proxy-slot.md)）。这七项与 `CC_API_KEYS` / `CC_KEY_SELECTION_STRATEGY` 环境变量目前**可配但无效**。
