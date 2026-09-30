# 模块报告：src/shared/model-windows.ts

| 项 | 值 |
|---|---|
| 文件 | `src/shared/model-windows.ts` |
| 行数 | 69 |
| 层级 | 基础设施层（数据表；**已被线上路径引用**） |
| 导入 | 无（零依赖） |
| 导入方 | `src/modules/models/catalog.ts`（**线上**，`/v1/models` 静态兜底）、`src/shared/context.ts`（未接线） |

## 职责

模型 ID → 上下文窗口大小的**唯一权威表**。`catalog.ts` 从此导入，
`context.ts` 查表，两条消费路径不可能再互相矛盾。

## 关键实现

| 行号 | 符号 | 可见性 | 说明 |
|---|---|---|---|
| 1-28 | 模块头注释 | 逻辑 | — | 为何是唯一表、被合并前的具体冲突、数值政策、1M 声明未经核实 |
| 30-62 | `MODEL_CONTEXT_WINDOWS` | **E** | `Record<string, number \| null>`。分两段：① 已通过 `/v1/models` 暴露的 12 个（数值逐字保留）② 此前未暴露的 14 个 |
| 64-65 | └ 数值政策注释 | 逻辑 | — | 切勿添加臆测值：过大的窗口会静默关闭护栏，比未知更糟 |
| 67-69 | `contextWindowFor` | **E** | 查表：命中返回窗口；未命中返回 `null`，调用方据此放行而非报错 |

## 此前存在的缺陷（已修）

本表与 `catalog.ts` 各自维护一份 `context_window`，且 **12 个共有 id 全部冲突**：

| 模型 | catalog（曾对外提供） | 本表（曾为 1M 声明） |
|---|---|---|
| `claude-sonnet-4-6` | 200000 | 1000000 |
| `gpt-5.5` / `5.4` / `5.4-mini` | 400000 | 1000000 |
| `deepseek/deepseek-v4-flash` | 65536 | 128000 |

这不是美观问题：`/v1/models` 把 catalog 的值告诉客户端，而基于本表的护栏会拿
**大 5 倍**的窗口去算利用率 —— `checkContextWindow` 永远不会触发。也就是说，
按原样接入 `context.ts` 等于加一个**永不生效**的检查。

现在数值只存在于本表，`catalog.ts` 仅保留「哪些 id 够确认、可以对外暴露」的窄名单
（`EXPOSED_WINDOW_IDS`）。

## 数值政策

- **12 个对外 id**：逐字保留原 catalog 值。它们是客户端已经拿到的数字，
  改动即构成可观测的 API 变更。
- **14 个未暴露 id**：沿用旧表数值。旧表引用的是 Command Code 文档的
  「Context window up to 1M」措辞。
- **1M 声明未采信**：对已暴露 id，旧表的 1M 与实际提供的值矛盾，故不采用。
  文件头明确记录这一点，以及运行期 provider 响应仍然优先
  （`catalog.ts` 的 `upstreamWindow ?? staticFallback`）。
- **未知即 `null`**：绝不用默认窗口兜底。过大的值会静默关闭护栏，
  比「不知道」更危险。

## 与 `/v1/models` 的关系

不再是「第三条独立路径」，而是**同一份数据的两个出口**：

```
                    shared/model-windows.ts   ← 唯一数值来源
                            │
        ┌───────────────────┴───────────────────┐
        ↓                                       ↓
catalog.ts（线上）                       context.ts（未接线）
  provider 透传 ?? 本表                    护栏预判
  再按 EXPOSED_WINDOW_IDS 过滤暴露
```

provider 可达时仍以上游为准；本表只在 provider 不可用或未返回该字段时兜底。

## 未接线部分

`context.ts` 侧仍未接入（见 [46-context.md](46-context.md)），链路是
`model-windows → context →（断）`。但本表**已不再是死代码** ——
`catalog.ts` 是它的线上消费方。接入 `context.ts` 时窗口预算将自动与
客户端看到的一致，这是本次合并的主要收益。

## 覆盖测试

`test/logging.ts` 第 8 组（`models:` 前缀，10 项断言）固定：26 个条目、恰好 12 个
暴露、对外数值逐字未变、对外值与护栏表**完全一致**、id 与顺序未变、未暴露 id
仍省略该字段且护栏表仍可解析、未知 id 返回 `null`、表覆盖全部 catalog id。
