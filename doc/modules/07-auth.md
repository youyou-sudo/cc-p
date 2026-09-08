# 模块报告：src/auth.ts（鉴权）

| 属性 | 值 |
|---|---|
| 路径 | `src/auth.ts` |
| 行数 | 43 |
| 层级 | 基础设施 |
| 依赖 | `./config`(CFG.apiKey) |
| 被依赖 | openai、anthropic、models |

## 代码段映射

| 行号 | 符号 | 说明 |
|---|---|---|
| 3 | `KEY_PATTERN` | `/user_[a-zA-Z0-9_-]+/`——非锚定正则，取首个匹配（容忍 Bearer 前后噪声） |
| 5-9 | `extractKey(value)` | 从任意字符串中提取合法 Key；无值/无匹配 → null |
| 11-22 | `getApiKey(headers)` | 提取优先级：① `Authorization: Bearer ...` ② `x-api-key` ③ `CFG.apiKey`（服务端兜底）。大小写兼容 `Authorization`/`authorization`、`X-Api-Key`/`x-api-key`。三处皆无 → null（调用方回 401） |
| 24-34 | `keyFormatError(headers)` | 客户端**主动携带**了 Key（Bearer 或 x-api-key 二选一）但内容不符合模式时返回错误文案（含前 12 字符预览）；未带或合法 → null。注意：兜底 Key 不参与格式报错 |
| 36-42 | `authErrorMessage(headers)` | 401 文案生成：格式错误文案优先；否则按是否配置兜底 Key 区分提示（提及 CC_API_KEY 或仅提示请求头） |

## 错误码约定

- **缺 Key** → `401`，OpenAI 路径 `type:'auth_error'`；Anthropic 路径 `type:'authentication_error'`（形状差异由调用方处理）。
- **格式非法** → 同样 401，但 message 来自 `keyFormatError`。
- 本服务不做 Key 有效性验证（格式之外），真实性由上游 `/alpha/generate` 的 401/403 反映并经 `mapCcError` 回传。
