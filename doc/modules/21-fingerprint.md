# 模块报告：src/infra/fingerprint.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/infra/fingerprint.ts` |
| 行数 | 190 |
| 层级 | 上游对接层 |
| 依赖 | `../shared/config`(CFG)；`../shared/logger`(log)；`../shared/util`(pick, randHex, sha256hex)；`../shared/version`(CC_VERSION) |
| 被依赖 | `src/infra/proxy-handler.ts`(ensureInitialized)、`src/infra/session.ts`(keyStateStore) |

## 职责

- 为每把 API key 生成一份稳定的伪造设备指纹（`Fingerprint` + `thumbmark`）。
- 向上游上报指纹与生命周期事件（`/alpha/fingerprint/record`、`/alpha/lifecycle-events`），刷新周期 8h + ≤2h 抖动。
- 对同一 key 的并发初始化做 in-flight 去重；初始化失败仅告警、不污染调用方，下个请求重试。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-4 | — | import | — | `../shared/config`(CFG)；`../shared/logger`(log)；`../shared/util`(pick, randHex, sha256hex)；`../shared/version`(CC_VERSION) |
| 6-22 | `FINGERPRINT_CPUS` | 常量 | P | 15 种伪造 CPU 型号/核心数（Intel 12-14 代 / Ultra / AMD Ryzen） |
| 24 | `FINGERPRINT_MEMS` | 常量 | P | 内存档位 `[8,16,24,32,48,64]` GiB |
| 26-31 | `FINGERPRINT_TZS` | 常量 | P | 15 个时区（美洲/欧洲/亚洲/大洋洲） |
| 33 | `FINGERPRINT_MAC_COUNT_RANGE` | 常量 | P | MAC 数量范围 `[2,3,4,5]` |
| 35-54 | `Fingerprint` | interface | E | `thumbmark` + `components`（machineIdHash/macHashes/osUserHash/hostnameHash/gitEmailHash/platform/arch/osRelease/cpuModel/cpuCount/memGiB/isContainer/timezone/runtime/collectorVersion） |
| 56-93 | `generateFingerprint()` | 函数 | E | 随机取 CPU/内存/时区/MAC 数量；MAC 与各哈希用 `sha256hex(randHex(...))`；固定 `platform:'win32'`、`arch:'x64'`、`osRelease:'10.0.22631'`、`isContainer:false`、`runtime:'cli'`、`collectorVersion:1`；`thumbmark = sha256hex(各字段以 '\|' 拼接)` |
| 95-98 | `KeyState` | interface | E | `{ fingerprint: Fingerprint; nextInitAt: number }` |
| 100 | `keyStateStore` | 常量 | E | `Map<apiKey, KeyState>`，session 清理时联动删除 |
| 102-113 | `getOrCreateKeyState(apiKey)` | 函数 | E | 懒创建（`generateFingerprint()` + `nextInitAt:0`）并记 `log('info','Fingerprint generated for key',{keyPrefix: 前 8 位})` |
| 115 | `INIT_REFRESH_MS` | 常量 | P | `8 * 60 * 60 * 1000`，刷新周期 8h |
| 116 | `INIT_JITTER_MS` | 常量 | P | `2 * 60 * 60 * 1000`，最大抖动 2h |
| 118 | `inFlightInit` | 常量 | P | `Map<apiKey, Promise<void>>`，init 去重 |
| 120-141 | `ensureInitialized(apiKey, signal)` | 异步函数 | E | 未到期（`now < nextInitAt`）直接返回；有 in-flight 则复用同一 Promise；否则 `doInit`，失败（非 AbortError）仅 `log('warn', ...)`，`finally` 中若仍是当前 Promise 则从 `inFlightInit` 删除 |
| 143-190 | `doInit(apiKey, state, signal)` | 异步函数 | P | 组装头（Content-Type/Authorization/x-cli-environment:production/x-command-code-version:CC_VERSION，`CFG.zdr` 时加 x-cmd-zdr:1）；并发 POST 指纹与生命周期两个请求（见关键行为）；全部完成后设置 `nextInitAt = now + 8h + jitter` |

## 关键行为

- `ensureInitialized` 的早退条件（123）：`nextInitAt` 为 0 时（新 key）立即触发初始化，成功后推到 8h 后。
- 失败不污染：`doInit` 的 catch 只告警，`state.nextInitAt` 不变，故下个请求会重试（129-135）。
- `doInit` 并发两个 POST（153-185）：
  - `/alpha/fingerprint/record`，body 为指纹 JSON；非 ok 记 `Fingerprint record failed`。
  - `/alpha/lifecycle-events`，body `{eventType:'cli_session_exists', metadata:{sessionId:`sess_${randHex(8)}`, cliVersion:CC_VERSION, mode:'interactive', os:platform-arch}}`；非 ok 记 `Lifecycle event failed`。
  - 两者均用同一 `signal` 外控；AbortError 静默，其他错误 warn。
  - `await Promise.all([record, lifecycle])`（185）后才安排下次刷新（187-189）。
- `keyStateStore` 由 `session.startSessionCleanup` 在每个会话过期时联动清理（session.ts:54）。
