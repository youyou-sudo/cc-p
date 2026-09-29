// Multi-key pool for `CC_API_KEYS`. Default strategy is key affinity
// (same upstream key for the same client/API key), with an explicit switch
// point to round-robin in case affinity becomes ineffective (e.g. a single
// key being rate-limited across the board).

export interface ApiKeyPool {
  /** Upstream keys available for load distribution. */
  keys: string[]
  /** Current selection strategy. */
  strategy: 'affinity' | 'roundRobin'
  /** Round-robin cursor (only used when strategy === 'roundRobin'). */
  roundRobinCursor: number
}

export function parseApiKeyEnv(): string[] {
  const single = envOrEmpty('CC_API_KEY')
  const multi = envOrEmpty('CC_API_KEYS')
  const out: string[] = []
  if (single) out.push(...splitComma(single))
  if (multi) {
    for (const k of splitComma(multi)) {
      if (!out.includes(k)) out.push(k)
    }
  }
  return out
}

function envOrEmpty(key: string): string {
  const v = process.env[key]
  return typeof v === 'string' ? v.trim() : ''
}

function splitComma(v: string): string[] {
  return v
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

export function resolveUpstreamKey(
  clientKey: string,
  pool: ApiKeyPool,
  selectFn?: (clientKey: string, pool: ApiKeyPool) => string,
): string {
  // If a custom selector is provided, use it (allows switching strategy
  // without touching this module).
  if (selectFn) return selectFn(clientKey, pool)
  if (pool.keys.length === 0) {
    // Fall back to the legacy single `CC_API_KEY` from config.
    return envOrEmpty('CC_API_KEY') || ''
  }
  if (pool.strategy === 'roundRobin') {
    const key = pool.keys[pool.roundRobinCursor % pool.keys.length]
    pool.roundRobinCursor = (pool.roundRobinCursor + 1) % pool.keys.length
    return key
  }
  // affinity: hash client key to a fixed upstream key
  return pool.keys[keyHash(clientKey) % pool.keys.length]
}

export function setPoolStrategy(pool: ApiKeyPool, strategy: ApiKeyPool['strategy']): void {
  pool.strategy = strategy
  if (strategy === 'roundRobin') {
    pool.roundRobinCursor = 0
  }
}

function keyHash(key: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
