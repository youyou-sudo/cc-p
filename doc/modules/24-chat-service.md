# 模块报告：src/modules/chat/service.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/chat/service.ts` |
| 行数 | 17 |
| 层级 | 协议层 |
| 依赖 | `../../infra/cc`（`buildCcRequest`，re-export）、动态 `./protocol` |
| 被依赖 | `src/modules/chat/index.ts`（`ChatService`，含重导出） |

## 职责

- Strangler 包装层：`ChatService` 只委托同目录 `handler.ts`，绝不复制 SSE 状态机。
- 以纯静态方法为控制器提供稳定调用面（`handle` / `handleBody`）。
- 惰性 `await import('./protocol')`，降低静态加载耦合。
- 作为纯函数复用入口，re-export `buildCcRequest`。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-4 | — | 注释 | — | Strangler 分层说明：handler → translator/aggregator；protocol 仅为门面 |
| 5 | `buildCcRequest` | 重导出 | E | `export { buildCcRequest } from '../../infra/cc'` |
| 7-17 | `ChatService` | 抽象类 | E | 纯静态门面，`abstract` 禁止实例化 |
| 8-11 | └ `handle` | 方法 | E | 动态取 `./protocol` 的 `handleChatCompletions(request, headers)` |
| 13-16 | └ `handleBody` | 方法 | E | 动态取 `./protocol` 的 `handleChatCompletionsBody(body, headers, signal)` |

## 关键行为

- 两个方法均用 `await import('./protocol')`（9、14）惰性加载，只取所需函数后立即委托。
- 构造函数被 `abstract` 禁止，调用方一律走 `ChatService.xxx` 静态入口。
- 注释（1-4）明令：不得在本文件复制状态机；纯函数（如 `buildCcRequest`）从 `../../infra/cc` re-export，禁止复制实现。
