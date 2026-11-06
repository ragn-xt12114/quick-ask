/**
 * Dependency-free UUIDv7 (RFC 9562).
 *
 * Layout (big-endian):
 *   48 bits  unix_ts_ms
 *    4 bits  version (7)
 *   12 bits  rand_a (used here as a same-millisecond monotonic counter)
 *    2 bits  variant (binary 10)
 *   62 bits  rand_b
 *
 * The counter keeps ids generated in the same millisecond lexicographically
 * increasing, which makes ids safe as SQLite TEXT primary keys and stable
 * "ORDER BY id" keys. A backwards clock step never produces a smaller id.
 */

import { randomFillSync } from 'node:crypto'

const MAX_COUNTER = 0xfff

let lastMs = -1
let counter = 0

function toHex(byte: number): string {
  return byte.toString(16).padStart(2, '0')
}

/** Generate a time-sortable UUIDv7. */
export function uuidv7(nowMs: number = Date.now()): string {
  let timestamp = Math.floor(nowMs)

  if (timestamp > lastMs) {
    lastMs = timestamp
    counter = 0
  } else {
    // Same millisecond (or a backwards clock step): keep time monotonic.
    timestamp = lastMs
    counter += 1
    if (counter > MAX_COUNTER) {
      // Counter exhausted: borrow one millisecond from the future rather
      // than emitting a smaller/duplicate id.
      lastMs += 1
      timestamp = lastMs
      counter = 0
    }
  }

  const bytes = new Uint8Array(16)
  randomFillSync(bytes)

  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff
  bytes[5] = timestamp & 0xff

  // version 7 + 12-bit monotonic counter in rand_a
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f)
  bytes[7] = counter & 0xff

  // RFC 4122 variant (10xx) in rand_b; random bytes 9..15 stay random.
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, toHex).join('')
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  )
}

/** Read the 48-bit unix millisecond timestamp from a UUIDv7 string. */
export function uuidv7Timestamp(id: string): number {
  const compact = id.replace(/-/g, '')
  if (compact.length !== 32) {
    throw new TypeError('Not a UUID')
  }
  return (
    Number.parseInt(compact.slice(0, 8), 16) * 2 ** 16 +
    Number.parseInt(compact.slice(8, 12), 16)
  )
}

/** True when `id` is a syntactically valid UUIDv7 (version 7, variant 10xx). */
export function isUuidV7(id: string): boolean {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return false
  }
  return true
}
