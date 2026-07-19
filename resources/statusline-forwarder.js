'use strict'
/* eslint-disable no-undef, @typescript-eslint/no-require-imports --
   This is a standalone Node CJS script invoked directly via `node <path>` (TD-4), not bundled/typed by
   the project's TS build graph, so the project's TS-oriented no-require-imports rule does not apply,
   and Node globals (require/process/Buffer/setTimeout/clearTimeout) are legitimately undeclared here
   rather than being an actual undefined-variable bug. */
// Statusline forwarder resource script (spec §4.3, TD-4). Registered by the app as the `statusLine`
// command in a per-pane, per-launch generated settings.json (see main/telemetry/settingsWriter.ts).
// Claude Code invokes this script fresh, once per UI render, piping a JSON payload to stdin. This
// script:
//   1. Forwards that payload (with `pane` injected) to the cockpit app over a Windows named pipe,
//      fire-and-forget, bounded by a 200ms connect timeout.
//   2. If the user already had their own statusLine command configured, chains to it with the same
//      stdin and passes its stdout straight through, so the terminal's own status line keeps working.
// This script must NEVER block or crash claude: every operation here is best-effort and time-bounded,
// and the process always exits (see main()'s .then/.catch below).
//
// NOTE: this file is intentionally excluded from the TypeScript build (it is invoked directly via
// `node <path>`, not bundled) and from ESLint's TS-specific rule set (see eslint.config.js's
// `resources/**` ignore) -- it is still linted as plain JS via eslint:recommended.

const net = require('node:net')
const { spawn } = require('node:child_process')

const PIPE_CONNECT_TIMEOUT_MS = 200
// TD-4 "絶対にブロックしない" (M2 FIX minor #5): the user's own chained statusLine command is an
// arbitrary external program we do not control -- bound how long we wait for it to close so a hung
// chained command can never block claude's statusLine render indefinitely. Killed after this, and we
// still resolve (best-effort, matching the pipe-forwarding half's own bounded timeout above).
const CHAIN_TIMEOUT_MS = 5000

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    process.stdin.on('error', () => resolve(''))
  })
}

/** Fire-and-forget send over the named pipe. Never rejects; resolves once done, timed out, or failed. */
function forwardToPipe(pipeName, payload) {
  return new Promise((resolve) => {
    if (!pipeName) {
      resolve()
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }

    const socket = net.createConnection(pipeName)
    const timer = setTimeout(() => {
      socket.destroy()
      finish()
    }, PIPE_CONNECT_TIMEOUT_MS)

    socket.once('connect', () => {
      clearTimeout(timer)
      socket.write(payload + '\n', () => {
        socket.end()
        finish()
      })
    })

    socket.once('error', () => {
      clearTimeout(timer)
      socket.destroy()
      finish()
    })
  })
}

/** Chain to the user's original statusLine command, if any, piping the same stdin through and passing
 * its stdout through unmodified so the terminal keeps showing the user's own status line (spec §4.3:
 * "ユーザが既に独自のstatuslineスクリプトを設定している場合、フォワーダからチェーン呼び出しして端末内
 * の表示を維持する"). */
function chainToOriginalCommand(command, stdinPayload) {
  return new Promise((resolve) => {
    if (!command) {
      resolve()
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    let timer
    try {
      const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] })
      timer = setTimeout(() => {
        child.kill()
        finish()
      }, CHAIN_TIMEOUT_MS)
      child.on('error', finish)
      child.on('close', finish)
      child.stdin.on('error', () => {
        // The original command may not read stdin at all; ignore EPIPE-style errors.
      })
      child.stdin.write(stdinPayload)
      child.stdin.end()
    } catch {
      finish()
    }
  })
}

async function main() {
  const stdinPayload = await readStdin()

  const pane = process.env.COCKPIT_PANE
  const pipeName = process.env.COCKPIT_PIPE_NAME
  const chainedCommand = process.env.COCKPIT_CHAINED_STATUSLINE_COMMAND

  let forwardPayload = stdinPayload
  try {
    const parsed = JSON.parse(stdinPayload)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (pane !== undefined) parsed.pane = Number(pane)
      forwardPayload = JSON.stringify(parsed)
    }
  } catch {
    // stdin wasn't valid JSON; forward the raw bytes as-is (the receiving parser tolerates this).
  }

  await Promise.all([
    forwardToPipe(pipeName, forwardPayload),
    chainToOriginalCommand(chainedCommand, stdinPayload)
  ])
}

main()
  .then(() => process.exit(0))
  .catch(() => {
    // Never let an unexpected error propagate and block/crash claude.
    process.exit(0)
  })
