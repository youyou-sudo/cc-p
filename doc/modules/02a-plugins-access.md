# 模块报告：src/plugins/access.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/plugins/access.ts` |
| 行数 | 99 |
| 层级 | 插件层 |
| 依赖 | `elysia`(Elysia)、`../shared/logger`(log) |
| 被依赖 | `src/app.ts` |

## 职责

- **访问日志**：每个请求一行，含 method / path / status / elapsedMs / outcome，使一次事故能作为时间线重建，而不是只能从错误行反推。
- 级别随状态：5xx → `error`，4xx → `warn`，其余 → `info`。
- 跳过 `OPTIONS`（CORS 预检，纯噪音，会让浏览器来源请求的日志行数翻倍）。

## 为何必须是插件而非 handler 内日志

handler 本就记录自己的结局，但它们从 `handleXxxBody` 内部的 `startTime` 起算 —— 读体、鉴权、schema 校验全部发生在**那之前**，完全不可见。本插件从 `onRequest`（首个执行的钩子）开始计时，`elapsedMs` 覆盖整个服务端请求。

## 钩子选择（经实测排除前两个）

| 钩子 | 结果 |
|---|---|
| `onAfterHandle` | 未注册路径到不了；`plugins/auth.ts` 用 `return status(401)` 从 onTransform 短路（刻意设计，要抢在 body 校验前）**完全跳过** afterHandle |
| `mapResponse` | 同上 404 不可达；且 `plugins/body.ts` 的 413 哨兵在 parse 阶段抛出，`set.status` 未被设置 |
| **`onAfterResponse`** | **采用** —— 唯一对所有结局都能观测到最终状态的钩子，且在响应对象构造完成后触发 |

## 状态取值的四级回退

1. `response.status` —— handler 或插件产出 Response 的所有结局（200 / 400 / 401 / 429 / 502 / 413 …）
2. onError 中暂存的「抛出的 Error 自带的 `status`」—— `plugins/body.ts` 的 413 哨兵需要，Elysia 报为 `code: 'UNKNOWN'` 且 afterResponse 看不到任何 Response
3. `code` → status 映射（`NOT_FOUND`→404、`VALIDATION`→400、`PARSE`→400）—— 未注册路径由 `plugins/errors.ts` **return 一个 Response** 而非设置 `set.status`，此时 `set.status` 仍是默认 200，信任它会把 404 记成成功
4. 兜底 500 —— 未知结局绝不被记成成功

第 3 级必须与 `plugins/errors.ts` 保持同步。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | import | — | `elysia`(Elysia)；`../shared/logger`(log) |
| 4-24 | — | 逻辑 | — | 注释：为何需要访问日志、为何选 `onAfterResponse`、状态四级回退、为何按 Request 对象而非模块级槽做键 |
| 31 | `startedAt` | 字段 | P | `WeakMap<Request, number>`，onRequest 记起点 |
| 32-36 | └ `errorStatus` 注释 | 逻辑 | — | 说明为何需要暂存：413 哨兵在 parse 阶段抛出、Elysia 报 `code='UNKNOWN'`、afterResponse 看不到 Response |
| 37 | `errorStatus` | 字段 | P | `WeakMap<Request, number>`，onError 暂存 Error 自带 status |
| 39-99 | `accessLogPlugin` | 常量/插件 | E | `new Elysia({ name: 'access-log' })` 链式定义 |
| 40-42 | └ `onRequest` | 钩子 | P | 记起点 |
| 43-45 | └ `onError` | 钩子 | P | `error.status` 为数字时暂存 |
| 46-99 | └ `onAfterResponse` | 钩子 | P | 清理 WeakMap → OPTIONS 短路 → path 解析 → 四级状态判定 → 按级别落日志 |
| 50-52 |   └ 清理 | 逻辑 | P | 读后即删两个 WeakMap 条目 |
| 53 |   └ OPTIONS 短路 | 逻辑 | P | 预检不记 |
| 55-63 |   └ path 解析 | 逻辑 | P | `new URL(request.url).pathname`；空 url 时降级为可 grep 的占位 |
| 65-86 |   └ 状态判定 | 逻辑 | P | 四级回退（注释 66-80 逐条说明） |
| 81 |   └ `CODE_STATUS` | 常量 | P | `NOT_FOUND`→404、`VALIDATION`→400、`PARSE`→400 |
| 88-94 |   └ 组装 data | 逻辑 | P | `{path, method, status, elapsedMs, outcome}` |
| 96-98 |   └ 按级别落日志 | 逻辑 | P | ≥500 error / ≥400 warn / 其余 info |

## 关键行为

- **按键而非按槽**（31、37）：并发测试证明模块级单槽会被重叠请求互相冲掉。`WeakMap<Request, …>` 以请求对象为键，无此问题。
- **状态 3 的存在理由**（76-78）：`plugins/errors.ts` 对 404 是 **return Response**，`set.status` 保持默认 200。这是最容易把失败记成成功的一处。
- **outcome 语义**（84）：`code` 存在即 `error:<code>`，否则 `handled`。`handled` 不代表「成功」—— 2xx-with-error-body（零输出 429、上游 429 映射）由 handler 自行记录，此处只体现状态码。
- **`code` 不在类型上**（46）：Elysia 1.4.30 的 afterResponse context 类型没有 `code`（onError 才有），故用 `...rest` 取。

## 覆盖测试

`test/logging.ts` 第 1 组（`access log:` 前缀，11 项断言）：200/201/4xx 级别、未注册 404、抛错 500、error 自带 413 的恢复、499 记为 rejection 而非 success、三并发各一行。

## 装配位置

在 `src/app.ts` 中**第一个** `.use()`。它只贡献钩子、不注册路由，所以位置不影响行为、只影响钩子优先级；排最前使其 scoped 钩子覆盖下面全部 4 个 controller。
