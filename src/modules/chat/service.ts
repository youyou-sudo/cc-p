// Strangler 包装：绝不复制 SSE 状态机，只委托旧 src/openai.ts。
// 纯函数如需复用，请 re-export ../../cc 的 buildCcRequest，禁止复制实现。
export { buildCcRequest } from '../../cc'

export abstract class ChatService {
  static async handle(request: Request, headers: Record<string, string | undefined>): Promise<Response> {
    const { handleChatCompletions } = await import('../../openai')
    return handleChatCompletions(request, headers)
  }

  static async handleBody(body: unknown, headers: Record<string, string | undefined>, signal?: AbortSignal): Promise<Response> {
    const { handleChatCompletionsBody } = await import('../../openai')
    return handleChatCompletionsBody(body, headers, signal)
  }
}
