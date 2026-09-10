# 模块报告：src/shared/auth.ts

| 属性 | 值 |
|---|---|
| 路径 | `src/shared/auth.ts` |
| 行数 | 43 |
| 层级 | 基础设施层 |
| 依赖 | `./config`（`CFG.apiKey`） |
| 被依赖 | `src/plugins/auth.ts`、`src/modules/chat/handler.ts`、`src/modules/messages/handler.ts`、`src/modules/models/catalog.ts` |

## 职责

- 从请求头中提取 Command Code API Key，并按优先级回退到配置的兜底 Key。
- 校验客户端主动携带的 Key 格式（`user_` 前缀 + base64url 字符集），生成格式错误文案。
- 生成 401 鉴权失败的用户可读文案，区分「格式错误」「有兜底 Key」「无兜底 Key」三种情形。

## 代码段映射

| 行号 | 符号 | 类别 | 可见性 | 说明 |
|---|---|---|---|---|
| 1-1 | — | import | — | `./config`(CFG) |
| 3 | `KEY_PATTERN` | 常量 | E | `/user_[a-zA-Z0-9_-]+/`，非锚定正则，容忍前后噪声、取首个匹配 |
| 5-9 | `extractKey` | 函数 | P | 从任意字符串中提取首个符合 `KEY_PATTERN` 的子串；空值/无匹配 → `null` |
| 11-22 | `getApiKey` | 函数 | E | 提取优先级：① `authorization`/`Authorization` 的 `Bearer ` 后段 → ② `x-api-key`/`X-Api-Key` → ③ `CFG.apiKey` 兜底；三处皆无 → `null` |
| 24-34 | `keyFormatError` | 函数 | E | 客户端**主动**带了 Key（Bearer 或 `x-api-key`）但内容不匹配 `KEY_PATTERN` 时返回错误文案（含前 12 字符预览，超长追加 `…`）；未带或合法 → `null`。兜底 `CFG.apiKey` 不参与格式报错 |
| 36-42 | `authErrorMessage` | 函数 | E | 401 文案：格式错误文案优先（L37-38）；否则按 `CFG.apiKey` 是否存在区分——有则提示可设 `CC_API_KEY`，无则仅提示请求头 |

## 关键行为

- **提取顺序**（L11-22）：每个候选先经 `extractKey`，命中即返回，最终才回退 `CFG.apiKey`；`auth.startsWith('Bearer ')` 判断大小写敏感，但头名同时兼容 `authorization` 与 `Authorization`、`x-api-key` 与 `X-Api-Key`。
- **格式报错与兜底解耦**（L24-34）：`keyFormatError` 只看客户端提供的头（L25-27），因此配了兜底 Key 时，客户端发来非法 Key 仍会报格式错误，而不是静默使用兜底。
- **不做真实性校验**：本模块只做格式与存在性判断，Key 是否有效由上游 `/alpha/generate` 返回的 401/403 经 `mapCcError` 反映。
- 空串处理：`extractKey` 对 `undefined`/空串返回 `null`；`keyFormatError` 对空 `presented` 返回 `null`（L28）。
