'use strict'
/* eslint-disable no-undef, @typescript-eslint/no-require-imports --
   Standalone Node CJS script invoked directly via `node <path>` / the fake-claude.cmd shim (mirrors
   resources/statusline-forwarder.js's real production counterpart, which uses the identical disable for
   the identical reason), not bundled/typed by the project's TS build graph, so the TS-oriented
   no-require-imports rule does not apply, and Node globals (require/process/Buffer) are legitimately
   undeclared here rather than an actual undefined-variable bug. */
// E2E fixture (M5): a minimal stand-in for the real `claude` CLI, used so the app's main "起動 -> セッ
// ション開始 -> 記録 -> 閲覧" flow can be exercised in CI/dev without an actual Claude Code binary, real
// API calls, or token spend. This is invoked exactly like the real claude executable would be -- through
// the app's own unmodified production code path (resolveClaude / buildSpawnCommand / PtyManager.spawn,
// via app_settings.claude_path set to fake-claude.cmd -- see forwarderPath.ts's dev-mode resolution) --
// so the app-side code under test is completely real; only the external CLI process is faked.
//
// Two modes, matching real claude's actual argv shapes (see main/pty/titleGenerator.ts / ptyManager.ts):
//   1. `-p --model haiku` (headless one-shot title generation): reads the prompt from stdin, prints one
//      short line to stdout, exits. No pty/statusLine/transcript involved (mirrors titleGenerator.ts's
//      own doc comment: "claude's -p reads the prompt from stdin when no positional query argument is
//      given").
//   2. `--settings <path> [--continue]` (interactive pty session): replicates just enough of the real
//      contract this app depends on (spec §4.3, TD-4) to exercise it faithfully:
//        - reads the app-generated `--settings` file to find the registered statusLine command
//          (main/telemetry/settingsWriter.ts's `{statusLine:{command:'node "<forwarderScriptPath>"'}}`),
//        - invokes it the same way the real forwarder's own "chain to the user's original statusLine"
//          does (spawn with shell:true, JSON piped via stdin -- resources/statusline-forwarder.js),
//          once immediately at "startup" (this is the statusLine payload's `session_id`/`transcript_path`
//          that lets sessionCoordinator link a session, and the TD-1 primary-signal event
//          purposeCoordinator is waiting for) and again after each simulated "turn",
//        - writes a synthetic transcript JSONL under `<home>/.claude/projects/cockpit-e2e/<uuid>.jsonl`
//          (must live under `<home>/.claude` -- shared/statusline.ts's isTranscriptPathAllowed rejects
//          anything else) that shared/jsonl.ts's real parser can read like any other claude transcript,
//        - on each line of stdin (one simulated user message per Enter keypress, matching how the app's
//          TD-1 launch-readiness watcher sends the initial prompt as `text + '\r'`), appends a user turn
//          + a canned assistant reply to that transcript and re-invokes statusLine with updated usage.
//
// Deliberately does NOT attempt to answer the still-open "does the real Claude Code TUI's statusLine fire
// before the user's first interaction" question (TD-1) -- see e2e/README.md and the M5 completion report
// for why that requires the *real* claude binary and cannot be validated by this fake.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const argv = process.argv.slice(2)

function argValue(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}

function readAllStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    process.stdin.on('error', () => resolve(''))
  })
}

// ---- Mode 1: headless `-p` one-shot (title generation, M4, OR purpose evaluation, M9) ----
// Both title generation (main/pty/titleGenerator.ts) and evaluation (main/evaluation/evaluationRunner.ts)
// invoke the identical `-p --model <model>` shape and pass their prompt via stdin only (TD-5) -- argv never
// carries which one this is. Distinguished here by sniffing the prompt text itself: buildEvaluationPrompt
// (shared/evaluation.ts) always embeds the literal string "commCost" (part of the JSON schema it demands),
// which buildTitlePrompt (shared/title.ts) never does. `--model e2e-fail-model` (M9 E2E fixture-only
// sentinel; never a real claude model) deliberately returns unparseable output so tests can exercise the
// evaluation error/re-run path deterministically without needing a second fake binary.
async function runHeadlessMode() {
  const model = argValue('--model')
  const stdin = await readAllStdin()

  if (model === 'e2e-fail-model') {
    process.stdout.write('sorry, something went wrong (not valid JSON)\n')
    process.exit(0)
    return
  }

  if (stdin.includes('commCost')) {
    process.stdout.write(
      JSON.stringify({
        smoothness: 82,
        stress: 15,
        commCost: 20,
        summary: 'E2Eフェイク評価: 順調に進みました',
        suggestions: [
          { category: 'user', text: 'E2Eユーザー改善案' },
          { category: 'environment', text: 'E2E環境改善案' }
        ]
      }) + '\n'
    )
    process.exit(0)
    return
  }

  process.stdout.write('E2Eフェイクタイトル\n')
  process.exit(0)
}

// ---- Mode 2: interactive pty session ----
function readStatusLineCommand(settingsPath) {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw)
    const command = parsed && parsed.statusLine && parsed.statusLine.command
    return typeof command === 'string' && command.length > 0 ? command : null
  } catch {
    return null
  }
}

function invokeStatusLine(command, payload) {
  if (!command) return
  try {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', () => {
      // Best-effort, same as the real forwarder chain -- never let this crash the fake CLI.
    })
    child.stdin.on('error', () => {})
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  } catch {
    // Best-effort.
  }
}

function appendTranscriptLine(transcriptPath, entry) {
  fs.appendFileSync(transcriptPath, JSON.stringify(entry) + '\n', 'utf-8')
}

async function runInteractiveMode() {
  const settingsPath = argValue('--settings')
  const statusLineCommand = settingsPath ? readStatusLineCommand(settingsPath) : null

  const sessionId = crypto.randomUUID()
  const model = 'fake-claude-e2e-model'
  const claudeHomeDir = path.join(os.homedir(), '.claude')
  const transcriptDir = path.join(claudeHomeDir, 'projects', 'cockpit-e2e')
  fs.mkdirSync(transcriptDir, { recursive: true })
  const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`)
  fs.writeFileSync(transcriptPath, '', 'utf-8')

  // M10 E2E coverage (spec §4.4/ADR-0011): before any human turn, emit one machine-generated-noise
  // `attachment`/`hook_success` line (a realistic shape: a PostToolUse hook's completion echo) -- one of
  // the shapes shared/archiveRetention.ts's shouldRetainLine discards -- so app.spec.ts can assert the
  // app-managed archive never contains a `hook_success` attachment, distinct from the human/assistant
  // turns below (which the same archive is expected to retain).
  appendTranscriptLine(transcriptPath, {
    type: 'attachment',
    uuid: crypto.randomUUID(),
    attachment: { type: 'hook_success', hookName: 'PostToolUse', durationMs: 12 },
    timestamp: new Date().toISOString()
  })

  // M10 E2E coverage, the retained counterpart to the discarded line above (D-3a): `queued_command` is the
  // one `attachment` type shouldRetainLine deliberately does NOT discard, since it is the only record of a
  // human interrupting a running agent turn. Emitted here so app.spec.ts can assert both directions of the
  // retention policy against one real transcript, not just the discard side.
  appendTranscriptLine(transcriptPath, {
    type: 'attachment',
    uuid: crypto.randomUUID(),
    attachment: { type: 'queued_command', command: '/compact' },
    timestamp: new Date().toISOString()
  })

  function sendStatusLine(usedPercentage) {
    invokeStatusLine(statusLineCommand, {
      session_id: sessionId,
      transcript_path: transcriptPath,
      model,
      context_window: { used_percentage: usedPercentage }
    })
  }

  // TD-1 primary signal: fire immediately, before any user interaction, so the app's launch-readiness
  // watcher can be observed reaching "ready" via reason==='statusline' rather than the 700ms/10s
  // fallbacks (deliberately fast so the E2E suite doesn't need to sit through the fallback windows).
  sendStatusLine(0)
  process.stdout.write('fake-claude ready\r\n> ')

  process.stdin.setEncoding('utf-8')
  let buffer = ''
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let idx
    // CR/LF-delimited line accumulation. The extra parens around the assignment satisfy ESLint's default
    // no-cond-assign "except-parens" option, so no disable directive is needed.
    while ((idx = buffer.search(/[\r\n]/)) !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      const message = line.trim()
      if (message.length === 0) continue

      // E2E (terminal-repaint.spec.ts): repaint the screen the way a TUI frontend (ink) does, so a
      // row-count change mid-session can be checked for buffer misalignment. `#paint <tag> clear|keep`:
      // 'clear' wipes the screen first (the reference frame), 'keep' overwrites only the frame's own rows
      // with ESC[K, exactly as a frontend rewriting its current frame in place would. Not a user turn, so
      // no transcript/statusLine side effects.
      const paint = /^#paint (\S+) (clear|keep)$/.exec(message)
      if (paint) {
        const [, tag, mode] = paint
        const frame = [1, 2, 3].map((n) => `${tag}${n} 行目です\x1b[K`).join('\r\n')
        process.stdout.write((mode === 'clear' ? '\x1b[2J\x1b[H' : '\x1b[H') + frame)
        continue
      }

      // E2E (terminal-repaint.spec.ts): `#frame <tag> <offset>` repaints an indented frame the way a TUI
      // frontend does -- absolute cursor to column 3, erase-to-end, write -- with the content one row lower
      // each time. That "one row goes blank, the next row gains text at the same column" diff is what makes
      // ConPTY compact its update into a bare LF used as an *index* (move down a row, keep the column),
      // which is the sequence a terminal that converts LF to CRLF gets wrong. Every painted row therefore
      // starts at column 2 and columns 0-1 must stay blank forever. Not a user turn -- no transcript or
      // statusLine side effects.
      if (message === '#frames') {
        // Full screen height minus the last two rows: ConPTY only compacts an update into the LF index when
        // the change covers the screen the way a real TUI frame does -- a small island of changed rows gets
        // absolute cursor addressing instead, and so does a frame whose repaints are separated by the
        // terminal's own echo of the next typed command, which is why the whole sequence is self-driven
        // here from one command rather than one command per frame.
        const painted = (process.stdout.rows || 24) - 2
        const draw = (tag, offset) => {
          let out = ''
          for (let r = 1; r <= painted; r += 1) {
            out += `\x1b[${r};3H\x1b[K`
            const i = r - offset
            if (i >= 1 && i % 2 === 1) out += `◆ ${tag}${i} 行目の日本語テキストです`
          }
          return out + `\x1b[${painted + 1};1H\x1b[K`
        }
        // The leading clear wipes this command's own echo too, so the frame starts from the blank
        // columns 0-1 that every repaint below then promises to leave blank.
        process.stdout.write('\x1b[2J' + draw('F1', 0))
        const steps = [
          ['F2', 1],
          ['F3', 0],
          ['F4', 1],
          ['F5', 0]
        ]
        let step = 0
        const timer = setInterval(() => {
          process.stdout.write(draw(steps[step][0], steps[step][1]))
          step += 1
          if (step >= steps.length) clearInterval(timer)
        }, 300)
        continue
      }

      // E2E (terminal-repaint.spec.ts): `#emit <path>` writes a UTF-8 file to the pty verbatim as ordinary
      // scrolling output, so a spec can push its own text material (the caller owns the file; nothing about
      // it is baked in here) through the real ConPTY and then compare xterm.js's buffer against it. Like
      // `#paint` above, not a user turn -- no transcript or statusLine side effects.
      const emit = /^#emit (.+)$/.exec(message)
      if (emit) {
        try {
          process.stdout.write(fs.readFileSync(emit[1], 'utf-8').replace(/\r?\n/g, '\r\n'))
        } catch (err) {
          process.stdout.write(`\r\n#emit failed: ${err.message}\r\n`)
        }
        continue
      }

      const timestamp = new Date().toISOString()
      appendTranscriptLine(transcriptPath, {
        type: 'user',
        message: { role: 'user', content: message },
        origin: { kind: 'human' },
        promptSource: 'typed',
        timestamp
      })

      const reply = `了解しました（フェイク応答）: ${message}`
      process.stdout.write(`\r\n${reply}\r\n> `)
      appendTranscriptLine(transcriptPath, {
        type: 'assistant',
        message: {
          role: 'assistant',
          model,
          content: reply,
          usage: {
            input_tokens: 12,
            output_tokens: 8,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
          }
        },
        timestamp: new Date().toISOString()
      })

      sendStatusLine(5)
    }
  })
  process.stdin.resume()
}

if (argv.includes('-p')) {
  runHeadlessMode()
} else {
  runInteractiveMode()
}
