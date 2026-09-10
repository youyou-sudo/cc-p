# 模块报告：src/modules/models/service.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/modules/models/service.ts` |
| 行数 | 15 |
| 层级 | 协议层 |
| 依赖 | `./catalog`（type `ModelEntry`；运行时动态 `import('./catalog')`） |
| 被依赖 | `src/modules/models/index.ts` |

## 职责

- `/v1/models` 的服务门面，采用 Strangler 包装：绝不重写缓存/`dynamicModels` 单例逻辑。
- 通过动态 `import('./catalog')` 委托，避免模块单例分裂，保证零回归。
- 对外暴露 `list`（返回 HTTP `Response`）与 `fetch`（返回 `ModelEntry[]`）两个静态方法。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1 | — | import | — | `./catalog`（仅类型 `ModelEntry`） |
| 5-15 | `ModelsService` | class | E | `abstract class`，仅承载静态方法 |
| 6-9 | └ `list` | 方法 | E | `static async list(headers)`：动态引入 `handleModels` 并直接委托 |
| 11-14 | └ `fetch` | 方法 | E | `static async fetch(apiKey?)`：动态引入 `fetchModels` 并委托 |

## 关键行为

- 用动态 `import`（7、12 行）而非顶层 import，确保 `catalog.ts` 模块级缓存/`dynamicModels` 单例在运行时只加载一份，避免 ESM 与打包路径差异导致的单例分裂。
- 顶部注释（3-4）明确这是过渡期的 Strangler 包装，catalog.ts 仍是逻辑真相源。
- `fetch`（11-14）在任何外部代码中未见调用，属预留的对外读取模型能力。
