import { CFG } from './config'
import { appendFile } from 'node:fs/promises'

export type LogLevel = 'info' | 'warn' | 'error'

export function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`
  console.log(line)
  if (CFG.logFile) {
    appendFile(CFG.logFile, line + '\n', 'utf-8').catch(() => {})
  }
}
