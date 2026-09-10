// Shared CC NDJSON → SSE workhorse.
//
// The raw upstream stream is a sequence of `{type: ...}` NDJSON objects. Each
// protocol file registers its own handler for the events it cares about; this
// module owns the buffered line splitting, JSON parsing, "unknown type"
// warnings, and the "hit an error event" bookkeeping. That removes the four
// duplicated event switches and gives a single place to add new event types.

import { log } from '../shared/logger'
import type { CcErrorEvent, CcEventType } from '../shared/cc-types'

// Every event type the upstream can emit (union of CcStreamEvent types). A
// parser only warns about a type when it is NOT in this set, so adding a new
// upstream event type is a one-line change here instead of four switches.
export const CC_EVENT_TYPES: ReadonlySet<CcEventType> = new Set<CcEventType>([
  'start', 'start-step',
  'reasoning-start', 'reasoning-end', 'reasoning-delta',
  'text-start', 'text-end', 'text-delta',
  'tool-call',
  'finish-step', 'finish',
  'tool-input-start', 'tool-input-delta', 'tool-input-end', 'tool-error',
  'provider-metadata',
  'error',
])

export type CcEventHook = (event: any) => string[] | string | void
export type CcEventHooks = Partial<Record<CcEventType, CcEventHook>> & {
  default?: (type: string, event: any) => void
}

export class CcStreamParser {
  lastCcEvent = ''
  errorEvent: CcErrorEvent | null = null
  unknownEvent: string | null = null

  private buffer = ''
  private static readonly MAX_LINE_LENGTH = 64 * 1024

  constructor(private readonly decoder = new TextDecoder()) {}

  /** Feed a raw chunk; complete lines are parsed and dispatched, output
   *  fragments (SSE strings / lines) are returned in order. */
  push(bytes: Uint8Array, hooks: CcEventHooks): string[] {
    this.buffer += this.decoder.decode(bytes, { stream: true })
    if (this.buffer.length > CcStreamParser.MAX_LINE_LENGTH) {
      this.buffer = ''
      return []
    }
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''
    const out: string[] = []
    for (const line of lines) this.handleLine(line, hooks, out)
    return out
  }

  /** Flush any trailing partial line (call at stream end). */
  flush(hooks: CcEventHooks): string[] {
    if (!this.buffer.trim()) return []
    const line = this.buffer
    this.buffer = ''
    const out: string[] = []
    this.handleLine(line, hooks, out)
    return out
  }

  private handleLine(line: string, hooks: CcEventHooks, out: string[]): void {
    const trimmed = line.trim()
    if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return
    let event: any
    try {
      event = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!event.type) return
    this.lastCcEvent = event.type

    if (event.type === 'error') {
      this.errorEvent = event as CcErrorEvent
      const handler = hooks.error
      if (handler) {
        const res = handler(event)
        if (res) out.push(...(Array.isArray(res) ? res : [res]))
      }
      return
    }

    const handler = (hooks as Record<string, CcEventHook | undefined>)[event.type]
    if (handler) {
      const res = handler(event)
      if (res) out.push(...(Array.isArray(res) ? res : [res]))
    } else if (CC_EVENT_TYPES.has(event.type as CcEventType)) {
      // Known type with no registered handler here → safe no-op.
    } else {
      this.unknownEvent = event.type
      const fb = hooks.default
      if (fb) fb(event.type, event)
      else log('warn', 'Unknown CC event type', { type: event.type })
    }
  }
}
