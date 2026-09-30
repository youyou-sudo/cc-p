// Layer: domain（可依赖 kernel / toolkit，不可被 kernel 依赖）
// - 成员：errors + limit + retry + runtime + concurrency，纯重导出，不搬文件、不改逻辑。
// - errors → limit 单向：errors import { classifyUpstreamLimit } from './limit'，
//   limit 不反引 errors。limit 内 CONTEXT_OVERFLOW_PATTERN 系故意重复
//   （与 errors.CONTEXT_WINDOW_EXCEEDED_PATTERN 保持同步），为防 errors ↔ limit
//   import 环，禁止“去重”合并，禁止 limit 反引 errors。
// - runtime 重导出 config 垫片勿删：export { NONSTREAM/STREAM/THINKING_IDLE_TIMEOUT_MS }
//   from './config' 是兼容垫片，老调用方可从 runtime 拿超时常量，删则 breaking。
// - session 保持动态 import runtime：session → runtime 若改静态 import 则与
//   runtime 叶定位冲突（pruneTimeoutStates 注释：动态 import 防 cycle），禁止改静态。
export * from './errors'
export * from './limit'
export * from './retry'
export * from './runtime'
export * from './concurrency'
