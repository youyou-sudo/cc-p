# 模块报告：src/shared/util.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/shared/util.ts` |
| 行数 | 75 |
| 层级 | 基础设施层 |
| 依赖 | 无（仅用 Bun 全局 `Bun.CryptoHasher`、Web `crypto`、`btoa`、`Date`） |
| 被依赖 | `src/infra/session.ts`、`src/infra/cc.ts`、`src/infra/fingerprint.ts`、`src/modules/models/catalog.ts`、`src/modules/messages/aggregator.ts`、`src/modules/messages/handler.ts`、`src/modules/messages/translator.ts`、`src/modules/chat/aggregator.ts`、`src/modules/chat/handler.ts` |

## 职责

- 提供无状态工具函数：哈希、Base64 编码、随机数/UUID、时间、JSON 宽松解析。
- 生成请求追踪头 `traceparent` 与模拟项目路径 `fakeProjectSlug`，用于指纹伪装场景。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-3 | `sha256hex` | 函数 | E | `Bun.CryptoHasher('sha256')` 计算，输出十六进制字符串 |
| 5-7 | `sha256bytes` | 函数 | E | 同上，输出原始 `Uint8Array` digest |
| 9-16 | `bytesToBase64` | 函数 | E | 分块（`chunkSize = 0x8000`）`String.fromCharCode` 拼接后 `btoa`，避免大数组 spread 爆栈 |
| 18-22 | `randHex` | 函数 | E | `crypto.getRandomValues` 生成 `byteLength` 字节，每字节 `toString(16).padStart(2,'0')` 拼接 |
| 24-26 | `uuid` | 函数 | E | `crypto.randomUUID()` |
| 28-30 | `pick` | 函数 | E | 从只读数组随机取一项；空数组返回 `undefined`（断言非空） |
| 32-34 | `nowUnix` | 函数 | E | 当前时间的 Unix 秒（`Math.floor(Date.now()/1000)`） |
| 36-38 | `getDateStr` | 函数 | E | ISO 字符串前 10 位，即 `YYYY-MM-DD` |
| 40-42 | `getEnvironment` | 函数 | E | 固定返回 `'win32-x64, Node.js 22.10.0'`（硬编码指纹） |
| 44-50 | `tryParseJSON` | 函数 | E | `JSON.parse` 失败静默返回 `{}`（宽松解析） |
| 52-54 | `generateTraceparent` | 函数 | E | 格式 `00-<16字节hex>-<8字节hex>-01`（W3C traceparent） |
| 56-75 | `fakeProjectSlug` | 函数 | E | 见关键行为 |

## 关键行为

- **`fakeProjectSlug` 确定性**（56-75）：16 个候选名数组；取 `sessionId` 前 4 位作 `head`，`parseInt(head,16)` 得索引；非有限值则用 `h = h*31 + charCode`（`>>>0`）回退哈希；`name = names[idx % 16]`，`suffix = head || '0000'`，拼成 `C:\Users\dev\projects\<name>-<suffix>` 后再走「转小写 → 去掉盘符 → 非字母数字压成 `-` → 去首尾 `-`」，输出稳定可复现的路径 slug。
- **空输入处理**：`String(sessionId || '')`，空串时 `head=''`、`parseInt` 为 `NaN`，进入字符哈希分支，最终 `suffix='0000'`。
- **易错点**：`pick` 对空数组会返回 `undefined` 且带 `!` 断言；`tryParseJSON` 用 `any` 返回，调用方需自行校验结构。
