// Context estimation and window checks for subagent guardrails.
// Rough token estimation: ~4 chars per token + per-message overhead.
// This is intentionally conservative (over-estimates) so warnings fire early
// but never block a legit request.

import { contextWindowFor } from './model-windows'

const CHARS_PER_TOKEN = 4
const TOKENS_PER_MESSAGE_OVERHEAD = 4

function charsToTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function estimateTextTokens(text: string): number {
  if (!text) return 0
  return charsToTokens(text.length)
}

function estimatePartTokens(part: any): number {
  if (!part || typeof part !== 'object') return 0
  if (part.type === 'text' && typeof part.text === 'string') {
    return estimateTextTokens(part.text)
  }
  if (part.type === 'image') return 1000 // rough placeholder per image
  if (part.type === 'tool-call') {
    const name = part.toolName || ''
    const input = typeof part.input === 'string' ? part.input : JSON.stringify(part.input || {})
    return estimateTextTokens(name) + estimateTextTokens(input) + 10
  }
  if (part.type === 'tool-result') {
    const output = part.output?.value || part.output?.text || ''
    const val = typeof output === 'string' ? output : JSON.stringify(output)
    return estimateTextTokens(String(val)) + 10
  }
  // fallback: stringify
  try {
    return estimateTextTokens(JSON.stringify(part))
  } catch { return 0 }
}

export function estimateTokensForCcMessages(ccMessages: any[]): number {
  let total = 0
  for (const msg of ccMessages) {
    total += TOKENS_PER_MESSAGE_OVERHEAD
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) total += estimatePartTokens(part)
    } else if (typeof msg.content === 'string') {
      total += estimateTextTokens(msg.content)
    }
    if (msg.role) total += 2 // role overhead
  }
  return total
}

export function estimateTokensForOpenAIMessages(messages: any[]): number {
  let total = 0
  for (const msg of messages) {
    total += TOKENS_PER_MESSAGE_OVERHEAD
    if (typeof msg.content === 'string') {
      total += estimateTextTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') total += estimateTextTokens(part.text || '')
        else if (part.type === 'image_url') total += 1000
        else total += estimateTextTokens(JSON.stringify(part))
      }
    }
    // tool_calls and tool results
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTextTokens(tc.function?.name || '')
        total += estimateTextTokens(typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}))
        total += 10
      }
    }
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      total += estimateTextTokens(msg.content)
    }
  }
  return total
}

export interface ContextCheck {
  estimatedTokens: number
  window: number | null
  utilization: number | null // 0-1, null if window unknown
  nearLimit: boolean
  wouldExceed: boolean
}

const WARN_THRESHOLD = 0.85
const EXCEED_THRESHOLD = 0.98

export function checkContextWindow(model: string, estimatedTokens: number): ContextCheck {
  const window = contextWindowFor(model)
  if (window == null || window <= 0) {
    return { estimatedTokens, window: null, utilization: null, nearLimit: false, wouldExceed: false }
  }
  const utilization = estimatedTokens / window
  return {
    estimatedTokens,
    window,
    utilization,
    nearLimit: utilization >= WARN_THRESHOLD,
    wouldExceed: utilization >= EXCEED_THRESHOLD,
  }
}

// Truncate helper for large tool outputs (subagent guardrail).
// DEFAULT_MAX_TOOL_CHARS ~ 30k chars (~7.5k tokens) — large enough for normal
// tool results but caps runaway file dumps that would otherwise re-feed every turn.

export const DEFAULT_MAX_TOOL_CHARS = 30_000

export function truncateToolOutput(text: string, maxChars: number = DEFAULT_MAX_TOOL_CHARS): { text: string; truncated: boolean; originalLength: number } {
  if (text.length <= maxChars) return { text, truncated: false, originalLength: text.length }
  const truncated = text.slice(0, maxChars)
  return {
    text: truncated + `\n\n[truncated: output was ${text.length} chars, showing first ${maxChars} chars — use offset/limit to read more]`,
    truncated: true,
    originalLength: text.length,
  }
}
