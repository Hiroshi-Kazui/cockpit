// Wires one pane's xterm.js Terminal to its pty over the cockpit preload bridge.
// Raw passthrough only: term.onData -> pty.write, pty onData -> term.write. No key interception
// (spec §4.1). Resize propagation: ResizeObserver -> fitAddon.fit() -> term.onResize -> pty.resize (TD-5).
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CanvasAddon } from '@xterm/addon-canvas'
import type { PaneIndex } from '@shared/ipc'
import { registerPaneTerminal } from '../testing/terminalProbe'

export interface UsePtyPaneResult {
  containerRef: RefObject<HTMLDivElement>
  running: boolean
  error: string | null
  /** M4: the caller supplies *which* IPC action actually launches the pty (`paneLaunch.start` for the
   * "新規セッション" dialog flow, `paneLaunch.resume` for the "再開" flow, spec §4.2/§4.6) -- this hook
   * only owns the xterm.js wiring/resize/focus dance that's identical either way.
   * M11: returns the resolved launch result (previously discarded) so Pane.tsx can read `paneLaunch.start`'s
   * `repoSync` outcome (spec §4.2 addendum) -- `null` if the IPC call itself rejected (error is still
   * recorded via `error` above either way). FIX B3 (review iter1): `pid` may itself be `null` within a
   * *resolved* result (paneLaunch.start's discriminated union, shared/ipc.ts's PaneLaunchStartResult) when
   * the git sync ran but the spawn afterward failed -- `running`/resize/focus are only applied when
   * `pid !== null`, but the whole result (including `repoSync`) still reaches the caller either way. */
  start: <T extends { pid: number | null }>(spawnFn: () => Promise<T>) => Promise<T | null>
  stop: () => Promise<void>
  /** M5 (AC "キーボードでのペイン間フォーカス移動"): moves DOM focus to this pane's xterm.js terminal
   * (its hidden textarea) regardless of whether a pty is currently running -- the terminal instance is
   * mounted for the pane's whole lifetime (see the mount effect below), so this works even before the
   * first "新規セッション"/"再開". A stable identity across re-renders (only depends on `paneIndex`,
   * closing over the ref rather than its current value) so callers can register it once. */
  focus: () => void
  /** M13 (ADR-0015 D-1/D-5): sends `text` to this pane's pty through the *same* Terminal instance the
   * xterm.js input passthrough already uses -- `term.paste(text)`, then (when `submit` is true)
   * `term.input('\r')` for the Enter keystroke. Both calls run through xterm.js's own `onData` trigger,
   * which is what `dataDisposable` above forwards to `window.cockpit.pty.write`; this function never calls
   * that IPC method itself, and never builds bracketed-paste escape sequences (`ESC[200~`/`ESC[201~`) --
   * that decision belongs to xterm.js's `paste()`, which already knows whether DECSET 2004 is active for
   * this session (ADR-0015 D-1). A no-op while `running` is false, so a caller cannot lose typed text into
   * a pty that was never told to run (R-7: the UI's own `disabled` is not the only guard). */
  sendText: (text: string, submit: boolean) => void
  /** M14 (R-1/R-3, ADR-0016 D-2/D-3): empties this pane's terminal (buffer *and* scrollback) and clears
   * any pty error, for the "completed purpose -> 停止" cleanup in Pane.tsx. Also suppresses whatever the
   * just-killed pty still has in flight -- late `pty:data` and the `[claude exited: code=N]` notice would
   * otherwise land on the freshly emptied screen, since `pty.kill`'s resolution and the exit event race --
   * *and* whatever it already delivered but xterm.js has not parsed yet (see the implementation: `write()`
   * is queued, not synchronous, so one `reset()` alone gets repainted over).
   * The suppression is lifted by the next `start`. Never resizes the terminal (R-4): `reset()` keeps the
   * current cols/rows, so ConPTY's own idea of the screen is untouched (ADR-0014). */
  cleanup: () => void
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function usePtyPane(paneIndex: PaneIndex): UsePtyPaneResult {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [running, setRunning] = useState(false)
  const runningRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  // M14 (ADR-0016 D-3): true from a `cleanup()` call until the next `start()` -- while set, nothing the
  // dying pty still emits (output already in flight, the exit event) is written to the terminal.
  const cleanedRef = useRef(false)

  useEffect(() => {
    runningRef.current = running
  }, [running])

  // Mount the terminal once per pane and keep it alive across layout visibility toggles.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // No `convertEol`. A pty stream is not text: ConPTY repaints the screen with a bare LF used as an
    // *index* (move down one row, keep the column), e.g. `ESC[3;3H ESC[K <text> LF <text>` -- the second
    // line is meant to land at column 2, and columns 0-1 are deliberately left alone because ConPTY knows
    // they already hold what it wants. `convertEol: true` adds a carriage return to that LF, so the text
    // lands at column 0 instead and the cells ConPTY never re-sends survive at the left edge. That is the
    // reported "スクロールすると左端の文字が1文字分左にずれ、行頭に前の行の文字が残る" artifact: measured
    // against a real ConPTY driving the real claude CLI's scrollback viewer, 36+ corrupted rows per scroll
    // session with it on and none with it off, no resize involved. Anything cockpit writes to the terminal
    // itself (the exit notice below) uses an explicit CRLF, so nothing depends on the conversion.
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", monospace'
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    termRef.current = term
    fitAddonRef.current = fitAddon

    // Tell xterm.js that its pty is hosted by ConPTY/winpty. Without this it applies its non-Windows
    // row-growth behavior, and "not having this behavior can result in missing data as the rows get
    // replaced" (@xterm/xterm ITerminalOptions.windowsPty) -- cockpit grows/shrinks a pane's row count
    // while claude is running every time a pane-header row appears or disappears (.pane-purpose /
    // .pane-telemetry / .pane-repo-sync, all of which show up seconds into a session), which is exactly
    // that path. Set asynchronously (the value comes from Main, which owns the pty) but never late in
    // practice: nothing can be written to this terminal until the user starts a session, which needs at
    // least one round-trip of their own. `disposed` keeps a resolved fetch off an already-disposed
    // terminal when a pane unmounts mid-flight.
    let disposed = false
    void window.cockpit.pty
      .hostInfo()
      .then((info) => {
        if (disposed || info === null) return
        term.options.windowsPty = info
      })
      .catch((err: unknown) => {
        setError(describeError(err))
      })

    // E2E-only observation point (no production behavior change) -- registers this pane's live xterm.js
    // Terminal instance with the central per-pane test-probe registry, mirroring Pane.tsx's
    // register/`null`-unregister pattern for onRegisterFocus (see testing/terminalProbe.ts for why this
    // exists and how Playwright reads it back). Unregistered in this effect's cleanup below.
    registerPaneTerminal(paneIndex, term)

    // The canvas renderer (loaded lazily below) measures the terminal's pixel dimensions when it
    // activates; activating it -- or calling fit() -- while the container still has zero layout size
    // leaves the render service without `dimensions`, so a later scroll/resize/write throws
    // "Cannot read properties of undefined (reading 'dimensions')" from Viewport.syncScrollArea.
    // Defer both the CanvasAddon load and every fit() until the container actually has a non-zero
    // size (the ResizeObserver below drives this); this also correctly delays them for a pane that
    // starts hidden in a split layout until it first becomes visible.
    let canvasAddon: CanvasAddon | null = null
    const ensureRendererAndFit = (): void => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      if (!canvasAddon) {
        // Canvas rather than the default DOM renderer, for painting throughput on busy output.
        // It is *not* a fix for the "leftmost cell keeps a stale glyph after scrolling" artifact it was
        // originally introduced for (e0780da): that is not renderer damage tracking at all -- xterm.js
        // repaints the entire viewport on every scroll under either renderer (Terminal.scrollLines ->
        // refresh(0, rows - 1)), so a glyph that survives a scroll survives in the *buffer*. See the
        // windowsPty note above for the buffer-level Windows path that can misalign rows.
        canvasAddon = new CanvasAddon()
        term.loadAddon(canvasAddon)
      }
      fitAddon.fit()
    }

    const dataDisposable = term.onData((data) => {
      if (!runningRef.current) return
      window.cockpit.pty.write({ pane: paneIndex, data }).catch((err: unknown) => {
        setError(describeError(err))
      })
    })

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (!runningRef.current) return
      window.cockpit.pty.resize({ pane: paneIndex, cols, rows }).catch((err: unknown) => {
        setError(describeError(err))
      })
    })

    const resizeObserver = new ResizeObserver(() => ensureRendererAndFit())
    resizeObserver.observe(container)

    return () => {
      disposed = true
      dataDisposable.dispose()
      resizeDisposable.dispose()
      resizeObserver.disconnect()
      registerPaneTerminal(paneIndex, null)
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [paneIndex])

  // Subscribe to this pane's pty output/exit events pushed from main.
  useEffect(() => {
    const unsubData = window.cockpit.pty.onData((event) => {
      if (event.pane !== paneIndex) return
      // M14 (R-3): a pane cleaned up after "完了 -> 停止" no longer belongs to the pty being torn down.
      // PtyManager.kill() deliberately keeps forwarding that process's remaining onData/onExit (see its
      // generation-guard comment), and ConPTY hands node-pty whatever it had already buffered *after* the
      // child is gone -- so without this guard the previous screen is repainted onto the terminal the app
      // has just emptied, which is the reported "過去ログが表示されたまま". Lifted by the next `start`.
      if (cleanedRef.current) return
      termRef.current?.write(event.data)
    })
    const unsubExit = window.cockpit.pty.onExit((event) => {
      if (event.pane !== paneIndex) return
      setRunning(false)
      // Same suppression as above -- `pty.kill`'s resolution (which drives the cleanup) and this exit
      // event race each other, so the notice must not be printed onto an already-emptied pane.
      // `setRunning(false)` stays unconditional: it is pane state, not screen content.
      if (cleanedRef.current) return
      termRef.current?.writeln(`\r\n[claude exited: code=${event.exitCode}]`)
    })
    return () => {
      unsubData()
      unsubExit()
    }
  }, [paneIndex])

  const start = useCallback(
    async <T extends { pid: number | null }>(spawnFn: () => Promise<T>): Promise<T | null> => {
      setError(null)
      cleanedRef.current = false // M14 (R-3): a new launch owns the terminal again
      try {
        const result = await spawnFn()
        // FIX B3 (review iter1): `pid === null` is a resolved (not thrown) "did not actually launch"
        // result (paneLaunch.start's discriminated union) -- the caller still gets the full result back
        // (so it can show `repoSync`/`message`), but the terminal must not be marked running/focused for a
        // pty that was never actually spawned.
        if (result.pid !== null) {
          setRunning(true)
          const term = termRef.current
          const fitAddon = fitAddonRef.current
          if (term && fitAddon) {
            fitAddon.fit()
            await window.cockpit.pty.resize({ pane: paneIndex, cols: term.cols, rows: term.rows })
          }
          term?.focus()
        }
        return result
      } catch (err) {
        setError(describeError(err))
        return null
      }
    },
    [paneIndex]
  )

  const stop = useCallback(async () => {
    try {
      await window.cockpit.pty.kill({ pane: paneIndex })
    } catch (err) {
      setError(describeError(err))
    } finally {
      setRunning(false)
    }
  }, [paneIndex])

  const cleanup = useCallback(() => {
    cleanedRef.current = true
    setError(null)
    const term = termRef.current
    if (!term) return
    // Clearing twice is not redundant. xterm.js does not parse `write()` synchronously -- it queues the
    // data and drains the queue in chunks across later task/frame boundaries -- so everything the pty
    // emitted in the moments before the kill is typically still *unparsed* when we get here, and a plain
    // `reset()` only empties the buffer that queue is about to repaint into. Measured against a pty
    // flooding the pane (e2e/fixtures/fake-claude.js `#spew`): ~600 lines reappeared after the reset, which
    // is the reported "過去ログが表示されたまま". So: reset now (the screen clears immediately in the common
    // case), and reset again once the queue has drained past this point -- `write('', cb)` fires `cb`
    // after the parser has consumed everything queued ahead of it, and the onData subscriber above stops
    // enqueueing as soon as `cleanedRef` is set, so nothing can be queued behind it. `cleanedRef` is
    // re-checked in the callback because `start` clears it: a pane the user has already relaunched owns
    // its terminal again, and this late continuation must not wipe the new session's first output.
    term.reset()
    term.write('', () => {
      if (!cleanedRef.current) return
      termRef.current?.reset()
    })
  }, [])

  const focus = useCallback(() => {
    termRef.current?.focus()
  }, [])

  const sendText = useCallback((text: string, submit: boolean) => {
    if (!runningRef.current) return
    const term = termRef.current
    if (!term) return
    term.paste(text)
    if (submit) term.input('\r')
  }, [])

  return { containerRef, running, error, start, stop, focus, sendText, cleanup }
}
