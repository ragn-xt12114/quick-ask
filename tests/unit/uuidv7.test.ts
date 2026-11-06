import { describe, expect, it } from 'vitest'
import { isUuidV7, uuidv7, uuidv7Timestamp } from '../../src/shared/uuidv7'

describe('UUIDv7', () => {
  it('produces RFC 9562 version/variant and preserves the millisecond timestamp', () => {
    const timestamp = 1_700_000_123_456
    const id = uuidv7(timestamp)

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(id[14]).toBe('7')
    expect(['8', '9', 'a', 'b']).toContain(id[19])
    expect(uuidv7Timestamp(id)).toBe(timestamp)
    expect(isUuidV7(id)).toBe(true)
    expect(isUuidV7('01890a5d-ac96-774b-bcce-b302099a8057')).toBe(true)
    expect(isUuidV7('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(false)
    expect(isUuidV7('not-a-uuid')).toBe(false)
  })

  it('is lexicographically increasing for ids generated in the same millisecond', () => {
    const timestamp = 1_800_000_000_000
    let previous = ''
    for (let i = 0; i < 2000; i += 1) {
      const id = uuidv7(timestamp)
      expect(isUuidV7(id)).toBe(true)
      expect(id > previous).toBe(true)
      previous = id
    }
    expect(uuidv7Timestamp(previous)).toBe(timestamp)
  })

  it('never goes backwards when the wall clock steps back', () => {
    const first = uuidv7(2_000_000_000_000)
    const second = uuidv7(1_900_000_000_000)
    expect(second > first).toBe(true)
    expect(uuidv7Timestamp(second)).toBeGreaterThanOrEqual(2_000_000_000_000)
  })
})
