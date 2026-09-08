# 模块报告：src/config.ts（配置加载）

| 属性 | 值 |
|---|---|
| 路径 | `src/config.ts` |
| 行数 | 123 |
| 层级 | 基础设施 |
| 依赖 | 无（Bun 全局：Bun.isStandaloneExecutable / Bun.file；process） |
| 被依赖 | logger、http、auth、cc、models、fingerprint、index（共 7 个，全局地基） |

## 职责

三层覆盖的配置加载：**内置默认值 → config.json → 环境变量**，模块加载期一次性完成（顶层 `await`），导出只读单例 `CFG` 与 `MAX_BODY_SIZE`。

## 代码段映射

| 行号 | 符号 | 说明 |
|---|---|---|
| 1-12 | `AppConfig` | 10 个配置字段接口 |
| 14-17 | `die(msg)` | `[config]` 前缀报错 + exit(1) |
| 19-36 | `candidateDirs()` | 目录探测顺序：独立二进制 → `process.cwd()` → `import.meta.dir`（$bunfs 内嵌副本）；源码运行 → `src/..`（项目根）→ cwd。注释明确说明 Release/Docker 与 `bun run` 两种形态的解析差异 |
| 38-51 | `findConfigJson()` | 逐目录探测 config.json；存在即解析，JSON 损坏返回 null（不致命） |
| 53-55 | `AppConfigWithSource` | 带 `configPath?` 的扩展接口（当前无消费方，预留） |
| 57-74 | `envString`/`envNumber`/`envBool` | 环境变量读取原语；空串视为未设置；非法数字/布尔不静默（number 直接 die；bool 仅接受 `1`/`true`） |
| 76-116 | `loadConfig()` | 默认值（port 3050 / host 0.0.0.0 / apiBase api.commandcode.ai / useProviderModels true / 刷新 5min / zdr false）→ Object.assign 合并文件配置 → 端口与刷新间隔合法性校验 → 10 个环境变量覆盖（PORT/HOST/CC_API_BASE/CC_API_KEY/CORS_ALLOW_ORIGIN/LOG_FILE/LOG_LEVEL/CC_USE_PROVIDER_MODELS/CC_MODEL_REFRESH_INTERVAL_MS/CMD_ZDR） |
| 118 | `CFG` | 全局配置单例 |
| 120-123 | `MAX_BODY_SIZE` | `CC_MAX_BODY_MB`（MB→字节），仅接受正值，默认 100MB |

## 环境变量速查

| 变量 | 目标字段 | 默认 |
|---|---|---|
| `PORT` / `HOST` | 监听 | 3050 / 0.0.0.0 |
| `CC_API_BASE` | 上游地址 | https://api.commandcode.ai |
| `CC_API_KEY` | 兜底 Key（user_ 前缀） | 空（不兜底） |
| `CORS_ALLOW_ORIGIN` | 显式 CORS 来源 | 空自动策略 |
| `LOG_FILE` / `LOG_LEVEL` | 日志 | 空（仅控制台）/ info |
| `CC_USE_PROVIDER_MODELS` | 动态模型列表 | true |
| `CC_MODEL_REFRESH_INTERVAL_MS` | 列表 TTL | 300000 |
| `CMD_ZDR` | ZDR-only 路由 | false |
| `CC_MAX_BODY_MB` | 请求体上限 | 100 |

## 关键行为

- **单例时序**：CFG 在模块求值期加载完成，任何 import 它的模块拿到的都是终值；env 覆盖不迟到。
- **容错策略**：config.json 缺失/损坏不致命（回退默认+env）；端口与刷新间隔非法则启动即退出（fail-fast）。
- **双形态兼容**：对 `bun build --compile` 产物（Docker distroless / Release）与源码运行分别用不同的目录探测顺序（详见 candidateDirs 注释）。
