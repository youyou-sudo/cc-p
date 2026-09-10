# 模块报告：src/modules/messages/service.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/messages/service.ts` |
| 行数 | 27 |
| 层级 | 协议层 |
| 依赖 | `./protocol` |
| 被依赖 | `src/modules/messages/index.ts` |

## 职责

- Strangler 门面：控制器只依赖 `MessagesService`，实现细节留在 `handler`/`translator`/`aggregator`。
- 以动态 `import('./protocol')` 委托请求/响应生命周期，绝不复制 SSE 状态机或转换逻辑。
- re-export 旧 `convert/build` 函数与类型，供单测与旧调用点使用。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-7 | 分层注释 | 逻辑 | P | handler→translator/aggregator；protocol 仅 re-export；SSE `SsePipeline(false)` + emitAnthropic「message_start 缓冲，首个 content_block_* 才 flush」；chat/translator 用 autoStart:true，两者不对称 |
| 8-15 | re-export | 导出 | E | `buildAnthropicResponse`、`convertAnthropicToOpenAI`、`createAnthropicSseTranslator`、`fakeThinkingSignature`、`handleMessages`、`handleMessagesBody` ← `./protocol` |
| 16 | `AnthropicStreamContext` | 类型 | E | 从 `./protocol` 作 type-only re-export |
| 18-27 | `MessagesService` | 类 | E | `abstract`，仅含静态方法 |
| 19-22 | `MessagesService.handle` | 方法 | E | 动态 import `./protocol` 后调 `handleMessages(request, headers)` |
| 23-26 | `MessagesService.handleBody` | 方法 | E | 动态 import `./protocol` 后调 `handleMessagesBody(body, headers, signal)` |

## 关键行为

- 运行时 `await import('./protocol')`（20、24）延迟解析，避免控制器加载期把整条协议链拉入；index.ts:14 实际走的是 `handleBody`。
- re-export 的 `handleMessages` 是旧签名入口（读原始 Request），`handleBody` 是新增的「body 已解析」直填入口，二者最终都落到 handler.ts 对应函数。
- 本文件行 1-7 的注释是 SSE 头缓冲策略的权威说明：空回包要能退化回 JSON 429，而非提前 flush 成 SSE 200。
