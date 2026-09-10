import { CFG } from './config'
import { appendFile } from 'node:fs/promises'

export type LogLevel = 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  const threshold = LEVEL_RANK[CFG.logLevel] ?? LEVEL_RANK.info
  if (LEVEL_RANK[level] < threshold) return
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`
  console.log(line)
  if (CFG.logFile) {
    appendFile(CFG.logFile, line + '\n', 'utf-8').catch(() => {})
  }
}
