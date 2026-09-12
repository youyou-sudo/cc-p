// Layer: kernel（底层，可被所有人依赖，自己只依赖 kernel）
// - 成员：config + logger + version + http + auth，纯重导出，不搬文件、不改逻辑。
// - auth 归 kernel：getApiKey / keyFormatError / authErrorMessage 活读 CFG（请求期每次读），
//   与 logger 读 CFG.logLevel 同构，不构成上层依赖，故留在底层。
// - 禁止 kernel → domain（errors/limit/retry/runtime/concurrency）：底层不可反向依赖上层，防环。
// - 快照语义不可动：CORS_HEADERS（buildCorsHeaders 模块加载时快照）、DRAIN_LIMIT、
//   MAX_BODY_SIZE / STREAM/NONSTREAM/THINKING_IDLE_TIMEOUT_MS 均为模块加载时 IIFE 快照，
//   运行时改 env 不生效，需重启。任何“改为活读”都是行为变更，禁止。
// - config 顶层 await（export const CFG = await loadConfig()）+ import.meta.dir 深度不可动：
//   物理移动文件会改变 import.meta.dir 解析出的 config.json 查找深度，高危零收益，故只建 barrel。
// - 禁止新建统一 src/shared/index.ts：STREAM / NONSTREAM / THINKING 三常量在 config 与
//   runtime（重导出 config 垫片）中同名，统一 index 下 export * 会歧义静默剔除，最阴险。
//   保持 kernel / domain / toolkit 三 barrel 分立，调用方按层按需 import。
export * from './config'
export * from './logger'
export * from './version'
export * from './http'
export * from './auth'
