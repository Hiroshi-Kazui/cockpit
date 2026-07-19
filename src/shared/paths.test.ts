// Unit tests for the pure root-containment helper (M2 FIX iteration 2, security).
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveContainedPath } from './paths'

describe('resolveContainedPath', () => {
  const root = 'C:\\Users\\me\\AppData\\Roaming\\cockpit\\archive'

  it('joins a plain segment and returns the resolved path', () => {
    expect(resolveContainedPath(root, 'sess-123')).toBe(path.resolve(root, 'sess-123'))
  })

  it('rejects a segment that escapes the root via ..', () => {
    expect(resolveContainedPath(root, '..\\..\\evil')).toBeNull()
    expect(resolveContainedPath(root, '../../evil')).toBeNull()
  })

  it('rejects a segment that is itself an absolute/drive-qualified path', () => {
    expect(resolveContainedPath(root, 'D:\\evil')).toBeNull()
  })

  it('treats a segment resolving to the root itself as contained (edge case)', () => {
    // A segment of '.' resolves to root itself; considered contained (not an escape), though callers
    // should never pass an empty/'.' session_id in practice (isValidSessionId already rejects empty
    // strings upstream).
    expect(resolveContainedPath(root, '.')).toBe(path.resolve(root))
  })

  it('accepts a segment containing dots that does not escape (e.g. a UUID-like id)', () => {
    const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    expect(resolveContainedPath(root, id)).toBe(path.resolve(root, id))
  })
})
