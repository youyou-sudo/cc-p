# 模块报告：test/_logging-writefail-child.ts

| 属性 | 值 |
|---|---|
| 路径 | `test/_logging-writefail-child.ts` |
| 行数 | 21 |
| 层级 | 测试 |
| 依赖 | 动态 import `../src/shared/logger` |
| 调用方 | `test/logging.ts` 第 6 组（以子进程方式） |

## 职责

为「日志文件写入失败必须被上报」这一行为提供验证载体。之所以必须是独立进程：`CFG.logFile` 在 `shared/config.ts` 求值时快照，进程内无法更改，无法先以可写路径加载再切换到不可写路径。

## 为何需要子进程而非同进程 mock

同进程有两条路都不成立：

1. 直接改 `process.env.LOG_FILE` —— 无效，`CFG` 早已快照
2. mock `appendFile` —— 但 `logger.ts` 在模块加载时就 `import { appendFile }` 绑定了引用，事后无法替换

子进程还顺带验证了两件同进程测不到的事：坏 sink **不致进程崩溃**，以及 stdout 通道与 stderr 上报通道相互独立。

## 代码段映射

| 行号 | 符号/段落 | 类别 | 说明 |
|---|---|---|---|
| 1-3 | 头注释 | 输出 | 说明为何需子进程、父进程断言 stderr |
| 4 | env 设置 | env | `LOG_FILE` 指向 `Z:/no-such-drive/deep/nested/proxy.log`（父目录不存在，`appendFile` 必失败）。**必须在 import 之前** |
| 6 | 动态 import | import | `../src/shared/logger`。用动态 import 而非静态：静态 import 会被提升到第 4 行之前，`CFG` 就会用默认的 `LOG_FILE=''` 加载，上报逻辑根本不会启用 |
| 8 | 5 次 log | 逻辑 | 每次都触发一次失败的 `appendFile` |
| 9 | 等待 | 基建 | `await Bun.sleep(200)` 让 5 次写入全部 settle，否则父进程读到的计数不完整 |
| 11-14 | 上报累计状态 | 输出 | `CHILD_STATE {message,suppressed,total}` 打到 stdout，供父进程断言 `total===5` / `suppressed===4` |
| 16-18 | 退出 | 输出 | `process.exit(0)` —— 断言坏 sink 不会让进程非零退出 |
| 20 | `export {}` | 导出 | 使文件成为 module（顶层 `await` 需要） |

## 关键行为

- **`CHILD_STATE` 走 stdout 而非 stderr**：stderr 已被 `[logger] log file write failed` 占用，父进程需要分别断言「只上报一次」和「累计 5 次」，故状态必须走另一条通道。
- **5 次失败 / 1 行 stderr**：`logger.ts` 的限频窗口是 60s，5 次连续失败全部落在同一窗口内，因此只应输出一条并带上 `totalFailures=5`。这正是「上报本身不能变成洪流」这一设计的可证形态。
- **stdout 仍收齐 5 行**：`log()` 始终先 `console.log`，文件 sink 坏掉只影响文件，不影响控制台 —— 这也是 `reportWriteFailure` 敢用 `console.error` 而非 `log()` 的前提（后者会重入失败的 `appendFile`）。

## 关联

- [08-logger.md](08-logger.md) —— 被测实现
- [48-test-logging.md](48-test-logging.md) —— 父测试，第 6 组
