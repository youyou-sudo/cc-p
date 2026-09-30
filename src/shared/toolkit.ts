// Layer: toolkit（零依赖叶，谁都可依赖，谁都不依赖）
// - 成员：util + cc-types，纯重导出，不搬文件、不改逻辑。
// - 零依赖：util / cc-types 均无跨 shared import（util 纯 Bun/crypto 工具，
//   cc-types 纯 NDJSON 类型），天然成叶。
// - api-keys 已删（Wave2）：零运行时调用 + 配了不生效误导，见删除记录，残留 export 已清理，禁止加回。
// - 禁止新建统一 src/shared/index.ts：STREAM / NONSTREAM / THINKING 三常量在 config 与
//   runtime（重导出 config 垫片）中同名，统一 index 下 export * 会歧义静默剔除，最阴险。
//   保持 kernel / domain / toolkit 三 barrel 分立，调用方按层按需 import。
export * from './util'
export * from './cc-types'
