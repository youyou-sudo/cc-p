// Known per-model context windows in tokens. null = unknown / varies.
// Sources: Command Code docs (pricing + models pages: "Context window up to 1M"),
// provider docs; update when a model id is confirmed. Never guess: when in
// doubt leave null so clients treat the budget as unknown.

export const MODEL_CONTEXT_WINDOWS: Record<string, number | null> = {
  'claude-sonnet-4-6': 1000000,
  'claude-opus-4-8': 1000000,
  'claude-opus-4-7': 1000000,
  'claude-haiku-4-5-20251001': 1000000,
  'gpt-5.5': 1000000,
  'gpt-5.4': 1000000,
  'gpt-5.4-mini': 1000000,
  'gpt-5.3-codex': 1000000,
  'deepseek/deepseek-v4-pro': 128000,
  'deepseek/deepseek-v4-flash': 128000,
  'moonshotai/Kimi-K2.6': 256000,
  'moonshotai/Kimi-K2.5': 256000,
  'zai-org/GLM-5.1': 200000,
  'zai-org/GLM-5': 200000,
  'MiniMaxAI/MiniMax-M3': 200000,
  'MiniMaxAI/MiniMax-M2.7': 200000,
  'MiniMaxAI/MiniMax-M2.5': 200000,
  'Qwen/Qwen3.6-Max-Preview': 256000,
  'Qwen/Qwen3.6-Plus': 256000,
  'Qwen/Qwen3.7-Max': 256000,
  'stepfun/Step-3.7-Flash': 200000,
  'stepfun/Step-3.5-Flash': 200000,
  'xiaomi/mimo-v2.5-pro': 256000,
  'xiaomi/mimo-v2.5': 256000,
  'google/gemini-3.5-flash': 1000000,
  'google/gemini-3.1-flash-lite': 1000000,
}

export function contextWindowFor(id: string): number | null {
  return MODEL_CONTEXT_WINDOWS[id] ?? null
}
