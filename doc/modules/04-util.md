# 模块报告：src/util.ts（通用工具）

| 属性 | 值 |
|---|---|
| 路径 | `src/util.ts` |
| 行数 | 75 |
| 层级 | 基础设施 |
| 依赖 | 无（Bun.CryptoHasher、crypto 全局） |
| 被依赖 | cc、openai、anthropic、models、session、fingerprint（6 个） |

## 代码段映射

| 行号 | 符号 | 说明 | 主要消费方 |
|---|---|---|---|
| 1-3 | `sha256hex(input)` | 字符串 → sha256 hex | fingerprint |
| 5-7 | `sha256bytes(input)` | 字符串 → sha256 原始字节 | anthropic（伪 thinking 签名） |
| 9-16 | `bytesToBase64(bytes)` | 分块(0x8000)二进制串接 + btoa，规避调用栈溢出 | anthropic |
| 18-22 | `randHex(byteLength)` | crypto.getRandomValues → hex 串 | fingerprint、util 内部 |
| 24-26 | `uuid()` | crypto.randomUUID | session、anthropic、openai |
| 28-30 | `pick<T>(arr)` | 随机取元素（readonly 数组安全） | fingerprint |
| 32-34 | `nowUnix()` | 秒级时间戳 | openai、models |
| 36-38 | `getDateStr()` | `YYYY-MM-DD`（ISO 截取） | cc（config.date 字段） |
| 40-42 | `getEnvironment()` | `'win32-x64, Node.js 22.10.0'` 与 fingerprint.ts 保持一致，避免被检测为机器人 |
| 44-50 | `tryParseJSON(str)` | 解析失败返回 `{}`（不抛出） | cc（tool_call arguments） |
| 52-54 | `generateTraceparent()` | W3C traceparent `00-{32hex}-{16hex}-01` | cc（traceparent 头） |
| 56-75 | `fakeProjectSlug(sessionId)` | 伪项目路径 slug | cc（x-project-slug 头） |

## fakeProjectSlug 算法

输入 sessionId（uuid），取前 4 个十六进制字符解析为整数 idx；解析失败则用 31 进制滚动哈希；再从 16 个候选词（app/api/backend/bot/cli/core/data/frontend/lib/plugin/proxy/server/service/tool/web/worker）中取 `names[idx % 16]`，拼接后缀 `head`（或 '0000'），生成形如 `C:\Users\dev\projects\proxy-a1b2` 的路径，最后小写、去盘符、非字母数字折叠为 `-`、去首尾 `-`。输出确定性（同一 sessionId 恒定输出）。
