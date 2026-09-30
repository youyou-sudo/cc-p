import { CFG } from './config'
import { appendFile } from 'node:fs/promises'

export type LogLevel = 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }

// File-write failures are reported at most once per interval. Without this a
// full disk or a revoked file permission turns every single log line into a
// fresh failure, and the reporter itself becomes the flood. The state is
// module-level on purpose: it describes the destination, not a request.
const WRITE_ERROR_REPORT_MS = 60_000
let lastWriteErrorAt = 0
let lastWriteError: string | null = null
let writeErrorSuppressed = 0
let totalWriteErrors = 0

function reportWriteFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  totalWriteErrors++
  const now = Date.now()
  if (now - lastWriteErrorAt < WRITE_ERROR_REPORT_MS) {
    writeErrorSuppressed++
    return
  }
  const suppressed = writeErrorSuppressed
  writeErrorSuppressed = 0
  lastWriteErrorAt = now
  lastWriteError = message
  // Deliberately console.error and not log(): routing this through log() would
  // re-enter the failing appendFile on every attempt. The console is the one
  // sink that is known to work, so it is the only safe place to report that
  // the file sink is broken.
  console.error(
    `[err] [logger] log file write failed: ${message}` +
    ` file=${CFG.logFile} totalFailures=${totalWriteErrors}` +
    (suppressed > 0 ? ` suppressedSinceLastReport=${suppressed}` : ''),
  )
}

/** Last file-write failure, for diagnostics and tests. */
export function logFileWriteError(): { message: string | null; suppressed: number; total: number } {
  return { message: lastWriteError, suppressed: writeErrorSuppressed, total: totalWriteErrors }
}

export function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  const threshold = LEVEL_RANK[CFG.logLevel] ?? LEVEL_RANK.info
  if (LEVEL_RANK[level] < threshold) return
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`
  console.log(line)
  if (CFG.logFile) {
    appendFile(CFG.logFile, line + '\n', 'utf-8')
      .then(() => {
        // A success clears the suppressed count so a later distinct failure
        // reports its own backlog size.
        if (writeErrorSuppressed > 0) writeErrorSuppressed = 0
      })
      .catch(reportWriteFailure)
  }
}
