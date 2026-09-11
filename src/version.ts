import { log } from './logger'

export let CC_VERSION = '0.32.3'
const CC_VERSION_REFRESH_MS = 24 * 60 * 60 * 1000

export async function refreshCCVersion(): Promise<void> {
  try {
    const res = await fetch('https://registry.npmjs.org/command-code/latest', {
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`npm responded with ${res.status}`)
    const pkg: any = await res.json()
    if (pkg.version && typeof pkg.version === 'string') {
      CC_VERSION = pkg.version
      log('info', 'CC Version refreshed from npm', { version: CC_VERSION })
    }
  } catch (e: any) {
    log('warn', 'CC Version fetch failed, using current', { version: CC_VERSION, error: e.message })
  }
}

export function startVersionRefresh(): void {
  void refreshCCVersion()
  setInterval(() => void refreshCCVersion(), CC_VERSION_REFRESH_MS)
}
