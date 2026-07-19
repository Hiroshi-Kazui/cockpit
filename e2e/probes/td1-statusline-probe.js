'use strict'
/* eslint-disable no-undef, @typescript-eslint/no-require-imports --
   Standalone Node CJS script, same rationale as resources/statusline-forwarder.js and
   e2e/fixtures/fake-claude.js (see their header comments) -- not bundled/typed by the project's TS build
   graph, Node globals are legitimately undeclared ambient globals here. */
//
// TD-1 empirical probe (M5, opt-in, NOT part of `npm run test:e2e` or any CI gate): answers the open
// question from technical-decisions.md's TD-1 -- "does the real Claude Code TUI's statusLine command fire
// before the user's first interaction, or only after?" -- against the *real* claude CLI binary found on
// this machine's PATH, rather than the E2E suite's fake-claude.js stand-in (which cannot answer this
// question: it is scripted to fire statusLine immediately by construction, so using it here would just
// prove the fake works, not what real Claude Code actually does).
//
// SAFETY / WHAT THIS DOES AND DOES NOT DO:
//   - Spawns the real `claude` binary with a scratch, empty, throwaway cwd and a generated --settings
//     file registering a minimal statusLine command (a tiny logger, not the app's real forwarder).
//   - NEVER writes anything to the pty's stdin. Zero keystrokes are sent, ever -- no chat message is
//     submitted, so this should not consume chat/completion API tokens or cause claude to take any
//     agentic action. (Whatever lightweight local auth/version-check activity real claude does on its own
//     at bare startup, if any, is unavoidable and identical to a human running `claude` and immediately
//     pressing Ctrl+C -- this script does not control or amplify that.)
//   - Passively observes for up to PROBE_WINDOW_MS whether the statusLine command is ever invoked, and if
//     so, how many milliseconds after spawn -- then kills the process. No files are written outside a
//     disposable temp directory removed at the end of this script's run.
//   - Requires node-pty, whose native binary in this repo is built for *Electron's* Node ABI (not plain
//     Node's) -- must be run via `ELECTRON_RUN_AS_NODE=1 <path-to-electron> e2e/probes/td1-statusline-probe.js`
//     (see README note alongside this file), not `node e2e/probes/td1-statusline-probe.js` directly.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const pty = require('node-pty')

const PROBE_WINDOW_MS = 15_000
const POLL_INTERVAL_MS = 100

function findClaudeOnPath() {
  const { execFileSync } = require('node:child_process')
  try {
    const output = execFileSync('where', ['claude'], { encoding: 'utf-8' })
    const lines = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    return lines.find((l) => l.toLowerCase().endsWith('.exe')) ?? lines[0] ?? null
  } catch {
    return null
  }
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex -- deliberately matching ANSI escape sequences.
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
}

async function main() {
  const claudePath = findClaudeOnPath()
  if (!claudePath) {
    console.log(
      '[td1-probe] RESULT: inconclusive -- no `claude` executable found on PATH (where claude).'
    )
    process.exit(0)
  }
  console.log('[td1-probe] using claude at:', claudePath)

  // Self-record the observed binary's version so that any TD-1 claim of "real claude CLI vX" made from
  // this probe's output is independently verifiable from the probe's own RESULT block, without relying on
  // a separate manual `claude --version` transcript. This is a plain --version invocation, not a chat
  // message -- it does not touch the pty/TUI session spawned below.
  let claudeVersion = 'unknown'
  try {
    const { execFileSync } = require('node:child_process')
    claudeVersion = execFileSync(claudePath, ['--version'], { encoding: 'utf-8' }).trim()
  } catch (err) {
    claudeVersion = `unknown (--version failed: ${err.message})`
  }
  console.log('[td1-probe] observed claude --version:', claudeVersion)

  // Self-record the *other* version source too (M5 FIX, deferred item 4): docs/technical-decisions.md's
  // TD-1 "バージョン源についての注記" distinguishes the executed-binary version above (`claude --version`)
  // from the schema-validation version cited elsewhere (shared/statusline.ts), which comes from whatever
  // build last wrote a payload to `~/.claude/statusline-cache.json`. Reading that file's own "version"
  // field here (read-only; this script never writes to it) makes both version sources independently
  // verifiable from a single probe run's RESULT block, without relying on a separately-captured file
  // snapshot. Never silently swallowed: absence/parse failure is reported as an explicit "unavailable"
  // reason, not omitted.
  let cacheVersion = 'unavailable (not checked yet)'
  try {
    const cachePath = path.join(os.homedir(), '.claude', 'statusline-cache.json')
    const cacheRaw = fs.readFileSync(cachePath, 'utf-8')
    const cacheParsed = JSON.parse(cacheRaw)
    if (cacheParsed && typeof cacheParsed === 'object' && typeof cacheParsed.version === 'string') {
      cacheVersion = cacheParsed.version
    } else {
      cacheVersion = 'unavailable (cache file has no string "version" field)'
    }
  } catch (err) {
    cacheVersion =
      err.code === 'ENOENT'
        ? 'unavailable (no ~/.claude/statusline-cache.json on this machine)'
        : `unavailable (${err.message})`
  }
  console.log('[td1-probe] ~/.claude/statusline-cache.json version:', cacheVersion)

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-td1-probe-'))
  const logPath = path.join(scratchDir, 'statusline-events.log')
  fs.writeFileSync(logPath, '')

  const loggerScriptPath = path.join(scratchDir, 'logger.js')
  fs.writeFileSync(
    loggerScriptPath,
    [
      "const fs = require('node:fs');",
      "let data = '';",
      "process.stdin.on('data', (c) => { data += c; });",
      "process.stdin.on('end', () => {",
      `  fs.appendFileSync(${JSON.stringify(logPath)}, Date.now() + ' ' + data.replace(/\\n/g, ' ') + '\\n');`,
      '  process.exit(0);',
      '});',
      "process.stdin.on('error', () => process.exit(0));"
    ].join('\n'),
    'utf-8'
  )

  const settingsPath = path.join(scratchDir, 'settings.json')
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      statusLine: { type: 'command', command: `node ${JSON.stringify(loggerScriptPath)}` }
    })
  )

  console.log('[td1-probe] scratch cwd:', scratchDir)
  console.log('[td1-probe] spawning claude --settings', settingsPath)
  console.log('[td1-probe] sending ZERO keystrokes; observing for', PROBE_WINDOW_MS, 'ms...')

  const spawnedAtMs = Date.now()
  let outputBuffer = ''
  const proc = pty.spawn(claudePath, ['--settings', settingsPath], {
    name: 'xterm-color',
    cols: 100,
    rows: 30,
    cwd: scratchDir,
    env: process.env
  })
  proc.onData((data) => {
    outputBuffer += data
  })
  let exited = false
  proc.onExit(({ exitCode, signal }) => {
    exited = true
    console.log('[td1-probe] claude process exited early:', { exitCode, signal })
  })

  function readLogFireMs() {
    const content = fs.readFileSync(logPath, 'utf-8').trim()
    if (content.length === 0) return null
    const ts = Number(content.split('\n')[0].split(' ')[0])
    return Number.isFinite(ts) ? ts : null
  }

  // Phase 1: zero keystrokes, up to PRE_INTERACTION_WINDOW_MS -- the real TD-1 question (does statusLine
  // fire before *any* interaction at all).
  const PRE_INTERACTION_WINDOW_MS = 5_000
  let firedPreInteractionAtMs = null
  let trustPromptSeen = false
  const phase1Deadline = spawnedAtMs + PRE_INTERACTION_WINDOW_MS
  while (Date.now() < phase1Deadline && !exited) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    firedPreInteractionAtMs = readLogFireMs()
    if (firedPreInteractionAtMs !== null) break
    // NOTE: claude's ink-based TUI renders text via cursor-positioning escape sequences rather than
    // literal runs of spaces, so naive ANSI-stripping collapses "trust this folder" into
    // "trustthisfolder" (observed empirically) -- strip whitespace from both sides before matching.
    if (/trustthisfolder/i.test(stripAnsi(outputBuffer).replace(/\s+/g, ''))) trustPromptSeen = true
  }

  // Phase 2 (only if a local first-run "trust this folder?" gate is blocking progress, and statusLine has
  // not already fired): accepting it is a local Y/N confirmation, not a chat message -- it reaches
  // claude's API/model layer, so this does not send anything to the model or consume completion tokens.
  // This measures the realistic common case for TD-1 (a pane's configured "デフォルトフォルダ" a real user
  // has already launched claude in before, where this gate has already been cleared on a prior run).
  let acceptedTrust = false
  if (firedPreInteractionAtMs === null && trustPromptSeen && !exited) {
    console.log(
      '[td1-probe] trust-folder gate detected; accepting it (local Y/N confirmation, not a chat message) to observe the main TUI screen...'
    )
    proc.write('1\r')
    acceptedTrust = true
  }

  let firedAtMs = firedPreInteractionAtMs
  const overallDeadline = spawnedAtMs + PROBE_WINDOW_MS
  while (firedAtMs === null && Date.now() < overallDeadline && !exited) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    firedAtMs = readLogFireMs()
  }

  if (!exited) {
    proc.kill()
  }

  console.log('\n[td1-probe] ---- RESULT ----')
  console.log('[td1-probe] claude --version:', claudeVersion)
  console.log('[td1-probe] statusline-cache.json version:', cacheVersion)
  if (firedPreInteractionAtMs !== null) {
    console.log(
      `[td1-probe] statusLine command WAS invoked ${firedPreInteractionAtMs - spawnedAtMs}ms after spawn, with ZERO keystrokes sent (no trust gate was in the way).`
    )
    console.log(
      '[td1-probe] -> TD-1 primary signal (statusLine fires pre-interaction) is CONFIRMED for this claude version, in an already-trusted folder.'
    )
  } else if (acceptedTrust && firedAtMs !== null) {
    console.log(
      `[td1-probe] statusLine did NOT fire before any interaction (blocked by the one-time "trust this folder?" gate).`
    )
    console.log(
      `[td1-probe] After accepting that local gate (not a chat message), statusLine fired ${firedAtMs - spawnedAtMs}ms after spawn.`
    )
    console.log(
      "[td1-probe] -> TD-1 primary signal fires pre-*chat*-interaction, but NOT pre-*any*-interaction: a brand-new/never-trusted folder blocks it behind a one-time local Y/N gate. Once a folder is trusted (the realistic common case for a pane's already-used デフォルトフォルダ), the primary signal should fire promptly on subsequent launches without needing this workaround."
    )
  } else {
    console.log(
      `[td1-probe] statusLine command was NOT invoked within ${PROBE_WINDOW_MS}ms of spawn (trust gate seen: ${trustPromptSeen}).`
    )
    console.log(
      '[td1-probe] -> TD-1 primary signal did NOT fire in this run; the 700ms-quiet/10s-timeout fallback would carry the launch instead.'
    )
  }
  console.log(
    '\n[td1-probe] last ~2000 chars of pty output observed (ANSI-stripped, for context on what screen claude was showing):'
  )
  const cleaned = stripAnsi(outputBuffer)
  console.log(cleaned.slice(-2000))

  // The killed claude process can hold a brief OS-level lock on its own cwd after proc.kill() returns
  // (observed empirically); give it a moment before cleanup, and don't let a leftover-lock cleanup
  // failure obscure the actual measurement result above.
  await new Promise((resolve) => setTimeout(resolve, 500))
  try {
    fs.rmSync(scratchDir, { recursive: true, force: true })
  } catch (err) {
    console.log('[td1-probe] (non-fatal) could not remove scratch dir immediately:', err.message)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('[td1-probe] FAILED:', err)
  process.exit(1)
})
