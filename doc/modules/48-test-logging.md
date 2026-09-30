# 模块报告：test/logging.ts

| 属性 | 值 |
|---|---|
| 路径 | `test/logging.ts` |
| 行数 | 399 |
| 层级 | 测试 |
| 依赖 | `elysia`(Elysia)；动态 import `../src/plugins/access`、`../src/plugins/auth`、`../src/modules/chat/index`、`../src/infra/sse`、`../src/shared/runtime`、`../src/shared/http`、`../src/shared/logger`、`../src/shared/config`；子进程 `test/_logging-writefail-child.ts` |
| 运行 | `bun run test:logging`（已在 `package.json` 注册） |

## 职责

为「日志产出」这件事本身提供回归保护。此前所有静默失败路径**无法测试，因为它们不产生任何输出** —— 这正是它们能长期存在的原因。

共 62 项断言，分 6 组。

## 环境依赖（两处踩过的坑）

| 事项 | 说明 |
|---|---|
| `CFG` 在 config 加载时快照 | `LOG_FILE` / `CC_MAX_BODY_MB` 必须在**任何 src 模块被求值前**设好。静态 import 会被提升到语句之前，故 src 模块一律用 `await import()` 动态引入；`elysia` 例外（不读 CFG） |
| Bun 的 `Request` 不从字符串 body 推导 `content-length` | content-length 预检路径**只能**通过显式设置该 header 触达，否则测的是流式路径 |
| `CC_MAX_BODY_MB` 默认 100MB | 不缩小则需要 100MB body 才能测超限；本文件设为 `1` |
| 写失败场景需子进程 | `CFG.logFile` 进程内不可更改 |

## 代码段映射

| 行号 | 段落 | 类别 | 说明 |
|---|---|---|---|
| 1-23 | env 预设 + 动态 import | 基建 | 见上表；`elysia` 静态 import，src 模块动态 |
| 25-43 | 日志捕获 | 工具 | 劫持 `console.log` 并正则解析 `[ts] [level] msg {json}`，从而走真实 `log()` 路径（含级别过滤） |
| 45-131 | 第 1 组：access log | 用例组 | 11 项。200→info 且含 path/method/status/elapsed；201 原值；未注册 404→warn 且状态正确；抛错→500（绝不误记 200）；4xx→warn；**Error 自带 413 被恢复而非记 500**；**499 记为 rejection 且不记为 success**；3 并发各一行 |
| 109-118 | └ 413 哨兵子场景 | 用例组 | 抛错必须在**钩子**里而非 handler：handler 正常返回不会进入 onError，暂存会为空 |
| 120-127 | └ 499 子场景 | 用例组 | 两个 handler 在客户端取消时都返回 499，须既不丢也不误判为成功 |
| 133-192 | 第 2 组：SsePipeline | 用例组 | 15 项。成功写入计数；健康管道无错；**enqueue 失败被计数而非吞掉**；失败写入不虚增 `emittedCount`；**keepalive/ping 仍计数**（这正是「往死连接写」的可证形态）；close 失败计数；`closeReason` 记录；**`terminateWith` 记 `client-abort` 而非 `normal`**；可传显式 reason；二次 `close()` 不覆盖；心跳异常计数；**close 抛错时 `terminal` 仍 resolve** |
| 194-220 | 第 3 组：runtime 计数 | 用例组 | 9 项。`recordTimeout` 每次自增都记；含 session 桶名；含当前计数与阈值；**session 桶互相隔离**；清空有计数时记；清空后计数归零；**兄弟桶不受影响**；**无计数可清时静默**（成功路径不增日志量） |
| 222-314 | 第 4 组：readJsonBody | 用例组 | 15 项。合法 body 不记日志且解析成功；JSON 非法被记且抛错 message 不变；content-length 预检被记 + `rejectedEarly:true` + 抛 `BodyTooLargeError`；**流式越界被记 + `rejectedEarly:false`**（预检抓不到的那一类）+ 抛 `BodyTooLargeError`；body 非可读流被记；读超时被记 + 报告预算 + **`stalledMidBody` 区分 slow-loris** + 抛错 message 不变 |
| 316-362 | 第 5 组：auth pre-check | 用例组 | 8 项。经真实 `authPlugin` + `chatController` 组合：返回 401；**记下原因**；含 path 与协议；含呈现了哪个凭据；访问日志仍记 401；**格式错误 Key 与缺失 Key 产生可区分原因**；格式错误时 `hasXApiKey` 为真 |
| 364-397 | 第 6 组：日志文件写入 | 用例组 | 8 项。行确实落盘；可写文件无失败记录；**写失败被上报**；**上报含出错路径**；**不重入 `log()`**；**5 次失败只出 1 行 stderr**（`total===5` 且 `suppressed===4`）；**文件 sink 坏掉时 console 仍收到每一行**；坏 sink 不致进程崩溃 |
| 399 | 退出 | 输出 | `process.exit(fail > 0 ? 1 : 0)`；清理临时日志文件 |

## 关键行为

- **捕获 console 而非 mock `log`**：直接替换 `log` 会绕过级别过滤与格式化，测的就不是生产路径了。劫持 `console.log` 后仍走真实 `log()`。
- **`settle()` 不可省**（57）：`onAfterResponse` 在响应写出时触发，断言前必须让事件循环转一圈。
- **子进程断言 stdout 与 stderr 分离**（382、390）：既验证只上报一次，也验证 console 通道完好 —— 这正是「上报走 console.error 而非 log()」这一设计的意义。
- **错误类型与 message 均被断言**：新增日志不得改变任何既有契约。

## 关联

- [02a-plugins-access.md](02a-plugins-access.md) —— 第 1 组
- [18-sse.md](18-sse.md) —— 第 2 组
- [10-runtime.md](10-runtime.md) —— 第 3 组
- [11-http.md](11-http.md) —— 第 4 组
- [06-plugins-auth.md](06-plugins-auth.md) —— 第 5 组
- [08-logger.md](08-logger.md) 与 [49-test-logging-child.md](49-test-logging-child.md) —— 第 6 组
