// Retry helpers: parse Retry-After, exponential backoff + jitter, abort-aware sleep.

export function parseRetryAfter(header: string | undefined | null): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) {
    const sec = Number(trimmed)
    return Number.isFinite(sec) && sec >= 0 ? sec : null
  }
  const d = new Date(trimmed)
  if (!isNaN(d.getTime())) {
    const diff = d.getTime() - Date.now()
    return diff > 0 ? Math.ceil(diff / 1000) : 0
  }
  return null
}

export function backoffDelay(attempt: number, baseMs: number, capMs: number, jitterRate: number = 0.25): number {
  const factor = Math.pow(2, attempt)
  const delay = Math.min(capMs, baseMs * factor)
  const jitter = (Math.random() * 2 - 1) * jitterRate * delay
  return Math.max(1, delay + jitter)
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(id)
      reject(new Error('ABORT_ERR'))
    }, { once: true })
  })
}
