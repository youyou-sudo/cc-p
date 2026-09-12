// Strangler 包装：绝不复制 SSE 状态机，只委托同目录 handler.ts。
// 分层：handler(请求/响应生命周期) → translator(流式帧) / aggregator(非流式聚合)；
// protocol.ts 仅作公共 re-export 门面。
// 纯函数如需复用，请 re-export ../../infra/cc 的 buildCcRequest，禁止复制实现。
export { buildCcRequest } from '../../infra/cc'

export abstract class ChatService {
  static async handleBody(body: unknown, headers: Record<string, string | undefined>, signal?: AbortSignal): Promise<Response> {
    const { handleChatCompletionsBody } = await import('./protocol')
    return handleChatCompletionsBody(body, headers, signal)
  }
}
