// Listens on a Windows named pipe (TD-4; CLAUDE.md: this environment uses named pipes, not Unix
// sockets) for JSON-Lines messages sent by the statusline forwarder resource script
// (resources/statusline-forwarder.js). The only module that touches the raw pipe transport; message
// interpretation is delegated to the caller via onMessage(raw: unknown) -- shared/statusline.ts owns
// parsing, kept here as `unknown` to avoid this transport module depending on that schema.
import net from 'node:net'

/** Pure: TD-4's `\\.\pipe\cockpit-<app instance id>` naming convention. Exported for unit testing. */
export function buildPipeName(instanceId: string): string {
  return `\\\\.\\pipe\\cockpit-${instanceId}`
}

/** A single statusLine JSON message should never remotely approach this size; it exists purely to
 * bound memory use (M2 FIX major #2: OOM guard) against a misbehaving/malicious pipe client that sends
 * bytes without ever a newline. */
export const MAX_PIPE_MESSAGE_BYTES = 1 * 1024 * 1024

/**
 * Accumulates raw chunks into newline-delimited lines with a bounded buffer. Pure/stateful but has no
 * I/O of its own, so it is unit-testable independent of a real net.Socket (M2 FIX major #2).
 */
export class PipeLineBuffer {
  private buffer = ''

  constructor(private readonly maxBytes: number = MAX_PIPE_MESSAGE_BYTES) {}

  /**
   * Feed a chunk of received text. Returns any complete (newline-terminated) lines extracted so far. If
   * the accumulated buffer exceeds `maxBytes` without a newline, it is discarded entirely and
   * `overflowed` is true for that call (the caller is expected to log this).
   */
  push(chunk: string): { lines: string[]; overflowed: boolean } {
    this.buffer += chunk
    const lines: string[] = []
    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
      lines.push(this.buffer.slice(0, newlineIndex))
      this.buffer = this.buffer.slice(newlineIndex + 1)
    }
    let overflowed = false
    if (this.buffer.length > this.maxBytes) {
      this.buffer = ''
      overflowed = true
    }
    return { lines, overflowed }
  }
}

export class TelemetryPipeServer {
  private server: net.Server | null = null

  constructor(
    private readonly pipeName: string,
    private readonly onMessage: (raw: unknown) => void
  ) {}

  start(): void {
    const server = net.createServer((socket) => {
      const lineBuffer = new PipeLineBuffer()
      socket.on('data', (chunk: Buffer) => {
        const { lines, overflowed } = lineBuffer.push(chunk.toString('utf-8'))
        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (line.length === 0) continue
          try {
            this.onMessage(JSON.parse(line))
          } catch (err) {
            console.error('[telemetry] failed to parse pipe message as JSON', err)
          }
        }
        if (overflowed) {
          console.error(
            `[telemetry] discarding oversized pipe message buffer (no newline within ${MAX_PIPE_MESSAGE_BYTES} bytes)`
          )
        }
      })
      socket.on('error', (err) => {
        console.error('[telemetry] pipe socket error', err)
      })
    })
    server.on('error', (err) => {
      console.error('[telemetry] pipe server error', err)
    })
    server.listen(this.pipeName)
    this.server = server
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }
}
