import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_LOG_VIEW_BYTES, readRecentLogs } from '../../src/main/logs/reader'

describe('recent log viewer', () => {
  it('reads the tail capped at 64KB and redacts secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quickask-logs-'))
    try {
      const big = `${'x'.repeat(70_000)}\nAuthorization: Bearer sk-abcdefgh12345678\ntail-line\n`
      writeFileSync(join(dir, 'quickask.log'), big)
      const recent = readRecentLogs(dir)
      expect(recent.path).toBe(join(dir, 'quickask.log'))
      expect(recent.bytes).toBeLessThanOrEqual(MAX_LOG_VIEW_BYTES)
      expect(recent.bytes).toBeLessThanOrEqual(64 * 1024)
      expect(recent.truncated).toBe(true)
      expect(recent.content).toContain('tail-line')
      expect(recent.content).not.toContain('sk-abcdefgh12345678')
      expect(recent.content.length).toBeLessThanOrEqual(64 * 1024)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns empty content when the log file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quickask-logs-empty-'))
    try {
      const recent = readRecentLogs(dir)
      expect(recent.content).toBe('')
      expect(recent.bytes).toBe(0)
      expect(recent.truncated).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects a smaller maxBytes cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quickask-logs-cap-'))
    try {
      writeFileSync(join(dir, 'quickask.log'), `${'y'.repeat(5000)}\nend\n`)
      const recent = readRecentLogs(dir, 'quickask.log', 100)
      expect(recent.bytes).toBe(100)
      expect(recent.truncated).toBe(true)
      expect(recent.content).toContain('end')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
