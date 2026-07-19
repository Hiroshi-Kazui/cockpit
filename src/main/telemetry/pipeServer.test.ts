// Unit test for the pure Windows named-pipe naming convention (TD-4) and the bounded line-buffering
// logic (M2 FIX major #2: OOM guard). The actual net.Server transport is a thin OS-level side effect
// and is exercised manually/in dev per the completion report, not here.
import { describe, expect, it } from 'vitest'
import { buildPipeName, PipeLineBuffer } from './pipeServer'

describe('buildPipeName', () => {
  it('builds the TD-4 \\\\.\\pipe\\cockpit-<instanceId> convention', () => {
    expect(buildPipeName('12345')).toBe('\\\\.\\pipe\\cockpit-12345')
  })

  it('is stable/deterministic for the same instanceId', () => {
    expect(buildPipeName('abc')).toBe(buildPipeName('abc'))
  })

  it('differs across instance ids (so two concurrently-running app instances do not collide)', () => {
    expect(buildPipeName('1')).not.toBe(buildPipeName('2'))
  })
})

describe('PipeLineBuffer', () => {
  it('extracts a single line delivered in one chunk', () => {
    const buf = new PipeLineBuffer(1024)
    const { lines, overflowed } = buf.push('{"a":1}\n')
    expect(lines).toEqual(['{"a":1}'])
    expect(overflowed).toBe(false)
  })

  it('reconstructs a line split across multiple chunks', () => {
    const buf = new PipeLineBuffer(1024)
    expect(buf.push('{"a":').lines).toEqual([])
    expect(buf.push('1}\n').lines).toEqual(['{"a":1}'])
  })

  it('extracts multiple complete lines delivered in one chunk', () => {
    const buf = new PipeLineBuffer(1024)
    const { lines } = buf.push('line1\nline2\nline3\n')
    expect(lines).toEqual(['line1', 'line2', 'line3'])
  })

  it('retains an incomplete trailing fragment for the next push', () => {
    const buf = new PipeLineBuffer(1024)
    expect(buf.push('line1\npartial').lines).toEqual(['line1'])
    expect(buf.push('-rest\n').lines).toEqual(['partial-rest'])
  })

  it('discards the buffer and reports overflow once it exceeds maxBytes without a newline', () => {
    const buf = new PipeLineBuffer(10)
    const { lines, overflowed } = buf.push('x'.repeat(11))
    expect(lines).toEqual([])
    expect(overflowed).toBe(true)
  })

  it('recovers cleanly after an overflow -- a subsequent well-formed line is parsed normally', () => {
    const buf = new PipeLineBuffer(10)
    buf.push('x'.repeat(11)) // overflow, buffer reset to ''
    const { lines, overflowed } = buf.push('ok\n')
    expect(lines).toEqual(['ok'])
    expect(overflowed).toBe(false)
  })

  it('does not report overflow while the buffer is exactly at the limit', () => {
    const buf = new PipeLineBuffer(10)
    const { overflowed } = buf.push('x'.repeat(10))
    expect(overflowed).toBe(false)
  })
})
