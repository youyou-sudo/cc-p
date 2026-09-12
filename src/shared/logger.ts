// Layer: kernel（底层，可被所有人依赖，自己只依赖 kernel）
import { CFG } from './config'
import { appendFile } from 'node:fs/promises'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }

// JSON.stringify 容错：循环引用→'[Circular]'，BigInt→字符串，
// 其他抛错→降级为 String(value)。日志永不因序列化抛错而丢行。
export function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet<object>()
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return `${val.toString()}n`
      if (val !== null && typeof val === 'object') {
        if (seen.has(val)) return '[Circular]'
        seen.add(val)
      }
      return val
    }) ?? String(value)
  } catch {
    try {
      return String(value)
    } catch {
      return '[Unserializable]'
    }
  }
}

let appendFailedLogged = false

export function log(level: LogLevel, msg: string, data?: Record<string, unknown>, requestId?: string): void {
  const threshold = LEVEL_RANK[CFG.logLevel] ?? LEVEL_RANK.info
  if ((LEVEL_RANK[level] ?? LEVEL_RANK.info) < threshold) return
  const reqPrefix = requestId ? ` [req:${requestId}]` : ''
  const line = `[${new Date().toISOString()}] [${level}]${reqPrefix} ${msg}${data !== undefined ? ' ' + safeStringify(data) : ''}`
  console.log(line)
  if (CFG.logFile) {
    appendFile(CFG.logFile, line + '\n', 'utf-8').catch((e: any) => {
      // 不吞错：只记一次 console.error，避免每次请求刷屏；后续仍尝试写文件。
      if (!appendFailedLogged) {
        appendFailedLogged = true
        console.error(`[logger] Failed to append to LOG_FILE='${CFG.logFile}': ${e?.message ?? String(e)}`)
      }
    })
  }
}
