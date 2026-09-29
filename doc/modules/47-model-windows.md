# 模块报告：src/shared/model-windows.ts

| 项 | 值 |
|---|---|
| 文件 | `src/shared/model-windows.ts` |
| 行数 | 37 |
| 层级 | 基础设施层（⚠ **已实现未接线**） |
| 导入 | 无（零依赖） |
| 导入方 | **无**。仅 `src/shared/context.ts:6` 引用 `contextWindowFor`，而 context 本身亦未接线。 |

## 职责

模型 ID → 上下文窗口大小的静态映射表。纯数据 + 一个查表函数，
是 `shared/context.ts` 的唯一依赖。因 context 未接入，本模块同样未接入。

## 关键实现

| 行号 | 符号 | 可见性 | 说明 |
|---|---|---|---|
| 6-33 | `MODEL_CONTEXT_WINDOWS` | **E** | `Record<string, number \| null>`。键为模型标识，值为上下文窗口 token 数；`null` 表示「窗口未知 / 不做判定」 |
| 35-37 | `contextWindowFor` | **E** | 查表：命中返回窗口；未命中返回 `null`，调用方据此放行而非报错 |

## 设计取舍

- **未命中不猜**：返回 `null` 而非一个默认窗口，避免把大窗口模型（小窗口表命中缺失）
  误判为超限。这让「表不全」退化为「不告警」而非「误杀」。
- **与 `/v1/models` 的 `context_window` 并存但不重复**：README §7 提到
  `GET /v1/models` 已带 `context_window`（provider 透传 +
  `modules/models/catalog.ts` 静态兜底）。本表是第三条独立路径，
  服务于无网络请求、纯本地的预估场景。

## 未接线原因

`contextWindowFor` 唯一调用点是 `shared/context.ts:96`，而 context 模块
无任何 import 方（详见 [46-context.md](46-context.md)）。链路是
`model-windows → context → （断）`。

## 接入建议

随 `context.ts` 一同接入（步骤见 46-context.md）。若只想低成本利用本表，
可在 `modules/models/catalog.ts` 的静态兜底中改为复用
`contextWindowFor(modelId) ?? <现有兜底常量>`，消除两处重复的模型窗口数据。
