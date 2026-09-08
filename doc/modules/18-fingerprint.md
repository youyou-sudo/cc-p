# 模块报告：src/fingerprint.ts（指纹与生命周期上报）

| 属性 | 值 |
|---|---|
| 路径 | `src/fingerprint.ts` |
| 行数 | 190 |
| 层级 | 上游对接 |
| 依赖 | config、logger、util(pick/randHex/sha256hex)、version(CC_VERSION) |
| 被依赖 | proxy-handler（callUpstream 前置 ensureInitialized）、session（keyStateStore 联动清理） |

## 职责

在真实业务请求前，向 CC 上游伪造「真实 CLI 客户端」的设备指纹与生命周期事件，使上游将其识别为正常 CLI 会话；按 key 维度缓存指纹并周期性（8h+抖动）刷新。

## 代码段映射

| 行号 | 符号 | 说明 |
|---|---|---|
| 6-22 | `FINGERPRINT_CPUS` | 15 种 CPU 型号+核心数（Intel 12/13/14 代、Ultra 7/9、AMD Ryzen 7000/5000 系列） |
| 24 | `FINGERPRINT_MEMS` | [8,16,24,32,48,64] GiB |
| 26-31 | `FINGERPRINT_TZS` | 15 个 IANA 时区（美洲/欧洲/亚太） |
| 33 | `FINGERPRINT_MAC_COUNT_RANGE` | [2,3,4,5] |
| 35-54 | `Fingerprint` | thumbmark + components（machineIdHash、macHashes[]、osUserHash、hostnameHash、gitEmailHash、platform/arch/osRelease、cpuModel/cpuCount、memGiB、isContainer、timezone、runtime、collectorVersion） |
| 56-93 | `generateFingerprint()` | 随机 macCount 条 MAC 哈希 + 四类身份哈希（各 sha256hex(randHex)）→ thumbmark = sha256(哈希管道拼接)；平台字段**固定** win32 / x64 / 10.0.22631 / isContainer:false / runtime:'cli' / collectorVersion:1 |
| 95-98 | `KeyState` | `{fingerprint, nextInitAt}` |
| 100 | `keyStateStore` | `Map<apiKey, KeyState>`（export，session 清理联动） |
| 102-113 | `getOrCreateKeyState(apiKey)` | 懒创建；首见时 `log('info','Fingerprint generated for key',{keyPrefix: 前 8 位})` |
| 115-116 | `INIT_REFRESH_MS` / `INIT_JITTER_MS` | 8h / 2h |
| 118 | `inFlightInit` | `Map<apiKey, Promise<void>>`——并发请求共享同一次 init，防止重复上报 |
| 120-141 | `ensureInitialized(apiKey, signal)` | `now < nextInitAt` → 直接返回；有 in-flight → 复用；否则发起 doInit；失败仅 warn（AbortError 静默）不阻塞业务；finally 摘除 in-flight |
| 143-190 | `doInit(apiKey, state, signal)` | 并发两个 POST（均带 Bearer + CC 版本头 + 可选 x-cmd-zdr）：① `/alpha/fingerprint/record`，body=指纹 JSON；② `/alpha/lifecycle-events`，body=`{eventType:'cli_session_exists', metadata:{sessionId: sess_{randHex(8)}, cliVersion, mode:'interactive', os: platform-arch}}`。每个请求独立 .then/.catch（非 ok 仅 warn，不抛）；`await Promise.all` 后 `nextInitAt = now + 8h + random(0~2h)`，并日志下次刷新时点 |

## 失败语义（对业务的影响）

init 失败**不抛出**：key 保持旧状态，下一次请求会再次尝试（ensureInitialized 的 nextInitAt 未推进）。业务请求在 init 期间被 `await`，最坏情况阻塞至两个上报完成（受传入 signal 控制，客户端断连即取消）。
