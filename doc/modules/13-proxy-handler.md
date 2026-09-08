# 模块报告：src/proxy-handler.ts（共享管道）

| 属性 | 值 |
|---|---|
| 路径 | `src/proxy-handler.ts` |
| 行数 | 91 |
| 层级 | 共享管道 |
| 依赖 | `./cc`(forwardToCC)、`./errors`(mapCcError/MappedError)、`./fingerprint`(ensureInitialized)、`./http`(BodyTooLargeError/readJsonBody)、`./logger` |
| 被依赖 | openai、anthropic |

## 职责

两个协议处理器（openai/anthropic）的**共同前奏与共同上游调用**：请求 JSON 解析（错误形状由协议方定制）、客户端断连的级联取消、指纹初始化 + 上游转发 + 非 2xx 映射。各 handler 仍独占自己的线格式与流/非流状态机。

## 代码段映射

| 行号 | 符号 | 说明 |
|---|---|---|
| 13 | `JsonParseErrorKind` | `'too-large' \| 'invalid'` |
| 17-29 | `readRequestJson<T>(request, buildError)` | 包 `readJsonBody`：`BodyTooLargeError` → `buildError('too-large', msg)`；其他异常 → `buildError('invalid', 'Invalid JSON body')`。返回判别联合：`{ok:true,value}` / `{ok:false,response}`——调用方一行 `if (!parsed.ok) return parsed.response` |
| 40-46 | `UpstreamFlow` | 接口：`signal`/`controller`/`aborted`/`setGracefulClose(fn\|null)`/`abort()` |
| 48-64 | `createUpstreamFlow(request)` | 核心：对 `request.signal` 注册 **once** abort 监听 → 置 `aborted=true` → 先执行 `gracefulClose?.()`（优雅收尾：SSE 管道写终止帧）→ 再 `controller.abort()`（掐断上游 fetch，停止计费）。监听器先于一切 phase 钩子注册，保证顺序恒定 |
| 66-76 | `UpstreamCallArgs<T>` | `apiKey/headers/ccBody/signal/promptCacheKey?/label/onCcError`——label 用于启动日志（'CC API error' vs 'CC API error (Anthropic)'），onCcError 把 MappedError 转成本协议 Response |
| 79-91 | `callUpstream<T>(args)` | `await ensureInitialized(apiKey, signal)`（指纹+生命周期，失败不阻塞）→ `forwardToCC(...)` → `!ok`：读错误文本（失败静默）、`log('error', label, {status})`、返回 `{ok:false, value: onCcError(mapCcError(status, text))}`；ok → `{ok:true, response}` |

## 断连时序（设计要点）

```
客户端 abort
  → (once listener) aborted=true
  → gracefulClose()        ← 流式：pipeline.terminateWith([...终止帧])，客户端拿到合法 SSE 结尾
  → controller.abort()     ← forwardToCC 的 fetch 被取消 → 上游流终结/计费停止
handler 内循环 `if (aborted()) break` 退出 pump
```

响应进入终态（terminal）后 handler 调 `setGracefulClose(null)` 摘除钩子，防止终止帧覆盖真实错误响应。
