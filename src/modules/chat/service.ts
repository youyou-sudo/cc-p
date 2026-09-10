// Strangler 包装：绝不复制 SSE 状态机，只委托同目录 protocol.ts。
// 纯函数如需复用，请 re-export ../../infra/cc 的 buildCcRequest，禁止复制实现。
export { buildCcRequest } from '../../infra/cc'

export abstract class ChatService {
  static async handle(request: Request, headers: Record<string, string | undefined>): Promise<Response> {
    const { handleChatCompletions } = await import('./protocol')
    return handleChatCompletions(request, headers)
  }

  static async handleBody(body: unknown, headers: Record<string, string | undefined>, signal?: AbortSignal): Promise<Response> {
    const { handleChatCompletionsBody } = await import('./protocol')
    return handleChatCompletionsBody(body, headers, signal)
  }
}
