# 模块报告：src/shared/version.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/shared/version.ts` |
| 行数 | 25 |
| 层级 | 基础设施层 |
| 依赖 | `./logger`（`log`） |
| 被依赖 | `src/index.ts`、`src/infra/cc.ts`、`src/infra/fingerprint.ts`、`src/modules/models/catalog.ts` |

## 职责

- 维护与官方 Command Code CLI 一致的版本号 `CC_VERSION`，供上游请求头 `x-command-code-version` 使用。
- 每 24 小时从 npm registry 拉取 `command-code` 最新版本并刷新内存中的 `CC_VERSION`。
- 提供启动时立即刷新 + 周期刷新的入口，且不阻塞服务启动。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-1 | — | import | — | `./logger`(log) |
| 3 | `CC_VERSION` | 变量（let） | E | 当前版本，初值 `'0.32.3'`；**可变**绑定，消费方在构造请求头时读取当前值 |
| 4 | `CC_VERSION_REFRESH_MS` | 常量 | P | `24 * 60 * 60 * 1000`（24 小时） |
| 6-20 | `refreshCCVersion` | 异步函数 | E | GET `https://registry.npmjs.org/command-code/latest`（`AbortSignal.timeout(10000)`，10s 超时） |
| 11 | └ 响应校验 | 逻辑 | P | `!res.ok` → 抛错 `npm responded with ${res.status}` |
| 13-16 | └ 成功刷新 | 逻辑 | P | `pkg.version` 为非空字符串时改写 `CC_VERSION` 并 `log('info', 'CC Version refreshed from npm', {version})` |
| 17-19 | └ 失败降级 | 逻辑 | P | 任何异常捕获后 `log('warn', 'CC Version fetch failed, using current', {version, error})`，保留现值 |
| 22-25 | `startVersionRefresh` | 函数 | E | 启动即 `void refreshCCVersion()`，再 `setInterval(..., 24h)`；返回前不 await（不阻塞启动） |

## 关键行为

- `CC_VERSION` 是模块级可变绑定（L3），`CC_VERSION` 的导入方拿到的始终是**最近一次刷新的值**（ESM live binding），无需重启进程即可随官方 CLI 升级跟进。
- 刷新失败（网络、非 200、字段缺失）只 `warn` 并保留最近成功值，初值兜底 `0.32.3`（L17-19）。
- `startVersionRefresh` 内的定时器为长期常驻（L24），进程生命周期内每 24h 刷新一次。
