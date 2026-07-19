// Wires one pane's xterm.js Terminal to its pty over the cockpit preload bridge.
// Raw passthrough only: term.onData -> pty.write, pty onData -> term.write. No key interception
// (spec §4.1). Resize propagation: ResizeObserver -> fitAddon.fit() -> term.onResize -> pty.resize (TD-5).
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PaneIndex } from '@shared/ipc'

export interface UsePtyPaneResult {
  containerRef: RefObject<HTMLDivElement>
  running: boolean
  error: string | null
  /** M4: the caller supplies *which* IPC action actually launches the pty (`paneLaunch.start` for the
   * "新規セッション" dialog flow, `paneLaunch.resume` for the "再開" flow, spec §4.2/§4.6) -- this hook
   * only owns the xterm.js wiring/resize/focus dance that's identical either way. */
  start: (spawnFn: () => Promise<{ pid: number }>) => Promise<void>
  stop: () => Promise<void>
  /** M5 (AC "キーボードでのペイン間フォーカス移動"): moves DOM focus to this pane's xterm.js terminal
   * (its hidden textarea) regardless of whether a pty is currently running -- the terminal instance is
   * mounted for the pane's whole lifetime (see the mount effect below), so this works even before the
   * first "新規セッション"/"再開". A stable identity across re-renders (only depends on `paneIndex`,
   * closing over the ref rather than its current value) so callers can register it once. */
  focus: () => void
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

  useEffect(() => {
    runningRef.current = running
  }, [running])

  // Mount the terminal once per pane and keep it alive across layout visibility toggles.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", monospace'
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()
    termRef.current = term
    fitAddonRef.current = fitAddon

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

    const resizeObserver = new ResizeObserver(() => fitAddon.fit())
    resizeObserver.observe(container)

    return () => {
      dataDisposable.dispose()
      resizeDisposable.dispose()
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [paneIndex])

  // Subscribe to this pane's pty output/exit events pushed from main.
  useEffect(() => {
    const unsubData = window.cockpit.pty.onData((event) => {
      if (event.pane === paneIndex) termRef.current?.write(event.data)
    })
    const unsubExit = window.cockpit.pty.onExit((event) => {
      if (event.pane !== paneIndex) return
      setRunning(false)
      termRef.current?.writeln(`\r\n[claude exited: code=${event.exitCode}]`)
    })
    return () => {
      unsubData()
      unsubExit()
    }
  }, [paneIndex])

  const start = useCallback(
    async (spawnFn: () => Promise<{ pid: number }>) => {
      setError(null)
      try {
        await spawnFn()
        setRunning(true)
        const term = termRef.current
        const fitAddon = fitAddonRef.current
        if (term && fitAddon) {
          fitAddon.fit()
          await window.cockpit.pty.resize({ pane: paneIndex, cols: term.cols, rows: term.rows })
        }
        term?.focus()
      } catch (err) {
        setError(describeError(err))
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

  const focus = useCallback(() => {
    termRef.current?.focus()
  }, [])

  return { containerRef, running, error, start, stop, focus }
}
