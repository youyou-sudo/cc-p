# 模块报告：src/version.ts（CC 版本维护）

| 属性 | 值 |
|---|---|
| 路径 | `src/version.ts` |
| 行数 | 25 |
| 层级 | 上游对接 |
| 依赖 | logger |
| 被依赖 | cc、fingerprint、models、index（启动任务） |

## 代码段映射

| 行号 | 符号 | 说明 |
|---|---|---|
| 3 | `CC_VERSION = '0.32.3'` | `export let`——**可变**绑定；消费方（cc/fingerprint/models）在构造请求头时读取当前值 |
| 4 | `CC_VERSION_REFRESH_MS` | 24h |
| 6-20 | `refreshCCVersion()` | GET `https://registry.npmjs.org/command-code/latest`（10s 超时）；`pkg.version` 为合法字符串则改写 CC_VERSION 并 `log('info')`；任何失败 `log('warn', ..., {当前版本})` 并保留现值 |
| 22-25 | `startVersionRefresh()` | 启动即刷新一次 + `setInterval` 每 24h；返回前不 await（void，不阻塞启动） |

## 作用

`x-command-code-version` 请求头（forwardToCC / fingerprint.record / lifecycle / provider models 拉取）携带与官方 CLI 一致的版本号；npm 定期刷新保证随上游 CLI 升级自动跟进，无需发版。失败降级为继续使用最近成功值（初始 0.32.3）。
