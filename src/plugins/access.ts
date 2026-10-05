import { Elysia } from 'elysia'
import { log } from '../shared/logger'

// Access log: one line per completed request, so an incident can be
// reconstructed as a timeline instead of inferred from error lines alone.
//
// Why a plugin rather than handler-level logging: handlers already log their
// own outcomes, but they time from `startTime` inside handleXxxBody — body
// read, auth and schema validation all happen BEFORE that and were
// invisible. This plugin starts timing in onRequest, the first hook to run,
// so `elapsedMs` covers the whole server-side request.
//
// Why `onAfterResponse` and not `onAfterHandle`/`mapResponse`: those two miss
// real outcomes in this app. Verified against Elysia 1.4.30:
//   - 404 from an unrouted path never reaches them
//   - the 401 that plugins/auth.ts short-circuits with `return status(401)`
//     in onTransform (deliberately, so it beats body validation) skips
//     afterHandle entirely
//   - `set.status` is unset on the parse-phase 413 sentinel, which would
//     report a wrong 200
// onAfterResponse is the only hook that observes the final status for every
// outcome, and it fires after the response object is built.
//
// Scoped: fires only for routes registered after this .use(). Registered
// first in src/app.ts, so it covers all four controllers. Unrouted paths and
// short-circuited requests are still covered because they are resolved by
// the app-level error path, not a route.
//
// Keyed by the Request object rather than a module-level slot: a slot would
// be clobbered by concurrent requests (verified with 3 in parallel).
const startedAt = new WeakMap<Request, number>()
// Status observed in onError, for outcomes where afterResponse has neither a
// Response nor a usable set.status. The 413 sentinel from plugins/body.ts is
// the case that needs this: it is a plain Error carrying `status = 413`, thrown
// from the parse phase, so Elysia reports code 'UNKNOWN' and afterResponse
// sees no response at all — without the stash it would be logged as a 500.
const errorStatus = new WeakMap<Request, number>()

export const accessLogPlugin = new Elysia({ name: 'access-log' })
  .onRequest(({ request }) => {
    startedAt.set(request, Date.now())
  })
  .onError({ as: 'scoped' }, ({ request, error }) => {
    const st = (error as { status?: unknown })?.status
    if (typeof st === 'number') errorStatus.set(request, st)
  })
  // `code` is not on the afterResponse context type in Elysia 1.4.30 (it is
  // on onError's), so read it defensively.
  .onAfterResponse({ as: 'scoped' }, ({ request, set, response, ...rest }) => {
    const start = startedAt.get(request)
    const stashedError = errorStatus.get(request)
    startedAt.delete(request)
    errorStatus.delete(request)
    if (request.method === 'OPTIONS') return

    let path = '(unknown)'
    let url = ''
    try {
      url = request.url
      path = new URL(url).pathname
    } catch {
      // Elysia can hand afterResponse a request whose url is an empty string
      // on the 404 path; keep the raw value so the line is still greppable.
      path = `(unresolvable url=${JSON.stringify(url)})`
    }

    const code = (rest as { code?: string }).code
    const fromResponse = (response as Response | undefined)?.status
    const fromSet = (set as { status?: unknown })?.status

    // Sources in order of trustworthiness:
    //  1. `response.status` — present for every outcome a handler or plugin
    //     produced a Response for (200, 400, 401, 429, 502, ...).
    //  2. the status carried by the thrown Error, stashed in onError. Needed
    //     for the 413 sentinel from plugins/body.ts.
    //  3. Elysia's error `code`, for an unrouted path: plugins/errors.ts
    //     RETURNS a Response there instead of setting set.status, so
    //     set.status is still the default 200 and trusting it would log a 404
    //     as a success. Must stay in step with plugins/errors.ts.
    //  4. 500, so an unknown outcome is never recorded as a success.
    const CODE_STATUS: Record<string, number> = { NOT_FOUND: 404, VALIDATION: 400, PARSE: 400 }
    const status = typeof fromResponse === 'number' ? fromResponse
      : stashedError !== undefined ? stashedError
      : code !== undefined ? (CODE_STATUS[code] ?? 500)
      : typeof fromSet === 'number' ? fromSet
      : 500

    const data: Record<string, unknown> = {
      path,
      method: request.method,
      status,
      elapsedMs: start === undefined ? undefined : Date.now() - start,
      outcome: code ? `error:${code}` : 'handled',
    }

    if (status >= 500) log('error', 'Request failed', data)
    else if (status >= 400) log('warn', 'Request rejected', data)
    else log('info', 'Request completed', data)
  })
