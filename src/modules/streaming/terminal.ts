// modules/streaming/terminal.ts — 终端 JSON 分流协议无关骨架。
//
// 只抽判定顺序，五个分支的具体 Response 组装由各协议 handler 以闭包传入
// （chat 侧用 sendJSON 直拼，messages 侧用 sendAnthropicError*，绝不统一）。
// 暂缓高风险项：不提供完整泛型 runPump（Explore 结论）。

import type { TerminalState } from './pump'

/** 五分支终端 runners：调用方按各自协议闭包实现，骨架只负责按序挑一个执行。 */
export interface TerminalRunners {
  upstreamError: () => Response
  timedOut: () => Response
  zeroOutput: () => Response
  errorMsg: () => Response
  empty: () => Response
}

// 判定顺序 upstreamError → timedOut → zeroOutput → errorMsg → empty，
// 与双 handler 终端分支对称（chat/handler.ts:261-300 对称 messages/handler.ts:265-314）。
//  - upstreamError 优先：上游已给映射错误时其他标记不可覆盖它。
//  - timedOut 次之：超时 429 优先于零输出/泛错。
//  - zeroOutput → errorMsg → empty 显式三段：旧 `zeroOutput || !errorMsg` 恒真写法
//    会让 502 永不可达，此处必须拆开。
// 前提不变量：SsePipeline.close() 绝不 resolve firstOutput（见 infra/sse.ts:168-180），
// 所以 race 落到 'terminal' 才走本函数（终端 JSON）；'started' 分支走 SSE 200，绝不进此函数。
export function resolveTerminal(s: TerminalState, r: TerminalRunners): Response {
  if (s.upstreamError) return r.upstreamError()
  if (s.timedOut) return r.timedOut()
  if (s.zeroOutput) return r.zeroOutput()
  if (s.errorMsg) return r.errorMsg()
  return r.empty()
}
