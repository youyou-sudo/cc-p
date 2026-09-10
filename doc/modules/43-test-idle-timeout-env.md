# 模块报告：test/idle-timeout-env.ts

| 属性 | 值 |
|---|---|
| 路径 | `test/idle-timeout-env.ts` |
| 行数 | 111 |
| 层级 | 测试 |
| 依赖 | `./src/shared/config.ts`（子进程内探测 `STREAM_IDLE_TIMEOUT_MS`/`NONSTREAM_IDLE_TIMEOUT_MS`/`THINKING_IDLE_TIMEOUT_MS`）；`Bun.spawnSync` |
| 被依赖 | 无（独立入口脚本） |

## 职责

- 快速验证 `CC_*_IDLE_MS` 环境变量的解析契约，不进行任何 30s 真实等待（总耗时 <15s）。
- 契约：`CC_STREAM_IDLE_MS` 默认 30000、`CC_NONSTREAM_IDLE_MS` 默认 90000、`CC_THINKING_IDLE_MS` 默认 120000；unset/空串 → 默认；非数字 → 进程 `exit(1)`；`<=0` → 回默认。
- 每个用例在独立子进程中 `import src/shared/config.ts` 并打印三个常量，实现 env 继承隔离，避免默认值断言被外部 env 污染。
- 思考期宽限的默认行为由 `test/timeouts.ts` 保持覆盖，本文件只做 env 解析穷举。

## 代码段映射

| 行号 | 符号/段落 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-7 | 头注释 | 输出 | — | 声明 env 契约、子进程隔离策略、与 `test/timeouts.ts` 的分工 |
| 9 | `ROOT` | 状态 | P | `import.meta.dir + '/..'`，作为子进程 cwd |
| 10 | `PROBE` | 状态 | P | 探测脚本字符串：import config 的三个常量并 `console.log(JSON.stringify({s,n,t}))` |
| 12 | `dec` | 工具 | P | `TextDecoder` 单例 |
| 14-18 | `ProbeResult` | 状态 | P | `{code, out, err}` 接口 |
| 20-39 | `runProbe(overrides)` | 工具 | P | 复制 `process.env`，`undefined` 覆盖项删除该 key（继承隔离），`Bun.spawnSync` 跑 `PROBE` 并解码 stdout/stderr |
| 41-47 | `parseOut(out)` | 工具 | P | `JSON.parse` 探测输出，失败返回 `null` |
| 49-59 | `check(name, cond, extra?)` | 断言 | P | PASS/FAIL 计数，失败打印 JSON 化 extra |
| 61-66 | 用例 (a) unset | 用例组 | P | 三 key 均 `undefined` → `code===0` 且 `30000/90000/120000` |
| 68-73 | 用例 (b) custom | 用例组 | P | `CC_STREAM_IDLE_MS=60000`、`CC_NONSTREAM_IDLE_MS=120000` → `60000/120000`，thinking 保持默认 `120000` |
| 75-80 | 用例 (b2) thinking custom | 用例组 | P | `CC_THINKING_IDLE_MS=180000` → thinking `180000`，stream/non-stream 保持 `30000/90000` |
| 82-87 | 用例 (c) stream 0 | 用例组 | P | `CC_STREAM_IDLE_MS=0` → 回默认 `30000` |
| 89-94 | 用例 (c2) thinking 0 | 用例组 | P | `CC_THINKING_IDLE_MS=0` → 回默认 `120000` |
| 96-100 | 用例 (d) stream abc | 用例组 | P | `CC_STREAM_IDLE_MS=abc` → 子进程非零退出 |
| 102-106 | 用例 (d2) thinking abc | 用例组 | P | `CC_THINKING_IDLE_MS=abc` → 子进程非零退出 |
| 108-111 | 结果 / 导出 | 输出 | E | `RESULT: N passed, M failed`；`fail>0` → `process.exit(1)`；`export {}` |

## 关键行为

- 用例间通过 `Bun.spawnSync` 的独立子进程隔离 env；每个用例显式传入 `undefined` 删除不需覆写的 key（L26-27），确保默认值断言不被父进程 env 污染。
- 非数字用例（d/d2）以子进程非零退出码为断言，验证 config 的 `die` 行为；其余用例断言 `code===0`。
- 不触网、不监听端口，读三个常量即可，是最快的回归测试。
- 运行方式：`bun run test/idle-timeout-env.ts`（`package.json` 未提供专用 script）。
