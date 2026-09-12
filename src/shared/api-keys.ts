// Upstream key-pool selection: affinity (stable per client key) or
// round-robin rotation across the pool. Pure functions + in-place cursor,
// no I/O — covered by test/unit.ts.

export type KeySelectionStrategy = 'affinity' | 'roundRobin'

export interface ApiKeyPool {
  keys: string[]
  strategy: KeySelectionStrategy
  roundRobinCursor: number
}

/** Hash a string to a uint32 (FNV-1a) for stable affinity mapping. */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function setPoolStrategy(pool: ApiKeyPool, strategy: KeySelectionStrategy): void {
  pool.strategy = strategy
}

/** Pick an upstream key for a client key. Affinity is stable per client key;
 *  roundRobin rotates through the pool on every call. Throws on empty pool. */
export function resolveUpstreamKey(clientKey: string, pool: ApiKeyPool): string {
  if (pool.keys.length === 0) throw new Error('ApiKeyPool has no keys')
  if (pool.strategy === 'roundRobin') {
    const key = pool.keys[pool.roundRobinCursor % pool.keys.length]!
    pool.roundRobinCursor = (pool.roundRobinCursor + 1) % Number.MAX_SAFE_INTEGER
    return key
  }
  return pool.keys[hash32(clientKey) % pool.keys.length]!
}
