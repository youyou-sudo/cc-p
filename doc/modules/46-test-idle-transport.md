# 模块报告：test/idle-transport.ts

| 属性 | 值 |
|---|---|
| 路径 | `test/idle-transport.ts` |
| 行数 | 66 |
| 层级 | 测试 |
| 依赖 | `elysia`（Elysia）；`../src/index.ts`（动态 import，取 `LISTEN_OPTIONS`） |
| 被依赖 | 无（独立入口脚本） |

## 职责

- 回归传输层空闲上限：Elysia 的 Bun adapter 写死 `idleTimeout: 30`，会掐断无 body、无 SSE 心跳的慢 GET，使项目 `runtime.ts` 的非流式 90s / 思考期 120s 预算永远走不到。
- 复用生产同一份 `LISTEN_OPTIONS`（`src/index.ts` 导出）启动一个含 32s 慢 GET 的临时服务器，断言响应越过旧 30s 上限仍返回 200；删掉 / 改回 `idleTimeout` 即失败。

## 代码段映射

| 行号 | 符号/段落 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 9-12 | env 注入 | env | — | `PORT=4231`、`HOST=127.0.0.1`、`CC_API_BASE=http://127.0.0.1:4130`、`CC_API_KEY=''`；先于 import 设置 |
| 14 | `elysia` import | import | — | `Elysia` |
| 18-19 | 生产入口动态 import | 基建 | P | 用上面的 `PORT` 启动真实服务器（无慢路由，不受影响），取回 `LISTEN_OPTIONS`；sleep300 待就绪 |
| 21-22 | `PORT` / `SLOW_MS` | 状态 | P | 临时服务器端口 4230、慢 GET 延时 32000ms |
| 24-30 | 临时服务器 | 基建 | P | `new Elysia().get('/slow', …sleep32s…).listen({ ...LISTEN_OPTIONS, port: 4230 })` |
| 32-36 | `check(name, cond, extra?)` | 断言 | P | PASS/FAIL 计数 |
| 38 | 断言 `idleTimeout: 0` | 断言 | P | `LISTEN_OPTIONS.idleTimeout === 0`（配置层守护） |
| 40-56 | 慢 GET 存活用例 | 用例组 | P | fetch `/slow`（超时 40s）；断言 200 `ok` 且耗时 > 30000ms（行为层守护） |
| 58-59 | 结果 / 退出 | 输出 | P | 打印 `RESULT`，`app.stop(true)`，`fail>0` → `process.exit(1)` |

## 关键行为

- **为什么必须真实等待**：旧上限是固定 30s，无法缩短，故用例本身约 33s（与 `test/timeouts.ts` 同量级）。不能用更短的 idleTimeout 代替——那测的就不是生产值。
- **负向对照**（已人工验证）：把 `LISTEN_OPTIONS.idleTimeout` 改回 `30`，慢 GET 在 ~32s 抛 `TypeError`（连接被掐），两条断言均 FAIL；改回 `0` 通过。
- 运行方式：`bun run test:idle-transport`（等价 `bun run test/idle-transport.ts`）。
