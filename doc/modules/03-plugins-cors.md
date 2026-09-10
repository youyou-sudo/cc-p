# 模块报告：src/plugins/cors.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/plugins/cors.ts` |
| 行数 | 16 |
| 层级 | 插件层 |
| 依赖 | `elysia`(Elysia) `../shared/http`(CORS_HEADERS) |
| 被依赖 | `src/app.ts` |

## 职责

- 以 Elysia 插件形式在**每个请求**上注入 CORS 响应头。
- 对 `OPTIONS` 预检直接短路返回 `204`。
- 替代 `@elysiajs/cors`（语义不同），不添加路由、不做 decorate。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-2 | — | import | — | `elysia`(Elysia) `../shared/http`(CORS_HEADERS) |
| 4-9 | — | 逻辑 | — | 注释：说明这是 `src/shared/http.ts` CORS_HEADERS 的 shim、有意不用 `@elysiajs/cors`、可安全在路由前 `use()` |
| 10 | `corsPlugin` | 常量/插件 | E | `new Elysia({ name: 'cors' })` |
| 11-15 | └ `onRequest` 钩子 | 中间件 | P | 每请求注入 CORS 头；`OPTIONS` → `204` |
| 12 | └ `Object.assign(set.headers, CORS_HEADERS)` | 逻辑 | P | 将 CORS 头合并进响应头 |
| 13-15 | └ OPTIONS 短路 | 逻辑 | P | `request.method === 'OPTIONS'` 时返回 `new Response(null, { status: 204, headers: CORS_HEADERS })` |

## 关键行为

- **CORS_HEADERS 是模块加载期快照**（L2）：由 `corsAllowOrigin()` 计算并固化，导入后配置变更不影响已加载的头。
- **OPTIONS 短路优先于下游**（L13-15）：返回新 Response，携带 CORS_HEADERS，状态 204。
- **无路由、无 decorate**（L10）：插件独立，可在 `app.use()` 链中排在所有路由注册之前。
