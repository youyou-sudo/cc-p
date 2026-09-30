// Child process for the log-file write-failure assertion in logging.ts.
// CFG.logFile is snapshotted at config load, so the failing path must be set
// via the environment before any import. The parent asserts on stderr.
process.env.LOG_FILE = 'Z:/no-such-drive/deep/nested/proxy.log'

const { log, logFileWriteError } = await import('../src/shared/logger')

for (let i = 0; i < 5; i++) log('info', 'probe child line', { i })
await Bun.sleep(200)

// Report the accumulated state on stdout so the parent can assert that all
// five writes failed while only one line reached stderr.
const state = logFileWriteError()
console.log(`CHILD_STATE ${JSON.stringify(state)}`)

// stdout must still carry the lines: the console sink is independent of the
// file sink, which is exactly why the reporter can use it.
process.exit(0)

export {}

