// Strangler 包装：绝不复制 SSE 状态机，只委托旧 src/anthropic.ts。
// SSE 用 SsePipeline(false)+emitAnthropic“message_start 缓冲，仅首个
// content_block_* 才 start() flush 头”，保证空回包走 JSON 429 而非 SSE 200。
// openai.ts 用 autoStart:true，两者不对称勿统一。
// re-export 旧 convert/build 函数供单测，不复制转换逻辑。
export {
  buildAnthropicResponse,
  convertAnthropicToOpenAI,
  createAnthropicSseTranslator,
  fakeThinkingSignature,
  handleMessages,
  handleMessagesBody,
} from '../../anthropic'
export type { AnthropicStreamContext } from '../../anthropic'

export abstract class MessagesService {
  static async handle(request: Request, headers: Record<string, string | undefined>): Promise<Response> {
    const { handleMessages } = await import('../../anthropic')
    return handleMessages(request, headers)
  }
  static async handleBody(body: any, headers: Record<string, string | undefined>, signal?: AbortSignal): Promise<Response> {
    const { handleMessagesBody } = await import('../../anthropic')
    return handleMessagesBody(body, headers, signal)
  }
}
