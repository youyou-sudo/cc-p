// Single source of truth for per-model context windows, in tokens.
// null / absent = unknown, so callers treat the budget as unbounded rather
// than guessing (see the note on the value policy below).
//
// WHY THIS FILE IS THE ONLY TABLE
// It previously duplicated the `context_window` values already declared in
// src/modules/models/catalog.ts, and the two disagreed on all 12 shared ids
// (e.g. claude-sonnet-4-6: 200000 here vs 1000000 there). That is not a latent
// cosmetic issue: `/v1/models` serves the catalog values to clients, so a
// guardrail built on this table would have compared the same model against a
// budget 5x larger than the one the client was told about — the check could
// never fire. catalog.ts now imports from here, so the two cannot drift again.
//
// VALUE POLICY — reconcile before trusting a number here
// Values for the 12 ids that `/v1/models` already exposed are the ones clients
// have been served, and are preserved verbatim: changing them would be an
// observable API change. The remaining ids were previously invisible to
// clients (catalog omitted the field entirely) and keep the figures from the
// earlier table, which cited Command Code's "context window up to 1M" wording.
//
// The 1M claims are UNVERIFIED against the provider and are knowingly not
// adopted for the exposed ids, because the served values already say otherwise.
// An operator who confirms the real limits should update this file alone; the
// provider response, when reachable, still wins at runtime (catalog.ts prefers
// `upstreamWindow ?? staticFallback`).
//
// Do not add speculative values: an over-large window silently disables the
// guardrail, which is worse than an unknown one.

export const MODEL_CONTEXT_WINDOWS: Record<string, number | null> = {
  // ── exposed via /v1/models (values preserved from the previous catalog) ──
  'claude-sonnet-4-6': 200000,
  'claude-opus-4-8': 200000,
  'claude-opus-4-7': 200000,
  'claude-haiku-4-5-20251001': 200000,
  'gpt-5.5': 400000,
  'gpt-5.4': 400000,
  'gpt-5.4-mini': 400000,
  'gpt-5.3-codex': 400000,
  'deepseek/deepseek-v4-pro': 131072,
  'deepseek/deepseek-v4-flash': 65536,
  'google/gemini-3.5-flash': 1048576,
  'google/gemini-3.1-flash-lite': 1048576,

  // ── not previously exposed; kept from the earlier table, needs confirmation ──
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
}

/**
 * Context window for a model id, or null when unknown.
 * Unknown is deliberately not an error: callers must treat it as "no budget
 * signal available" and skip any check rather than assume a default.
 */
export function contextWindowFor(id: string): number | null {
  return MODEL_CONTEXT_WINDOWS[id] ?? null
}
