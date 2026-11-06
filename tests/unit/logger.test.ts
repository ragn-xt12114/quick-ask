import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLogger,
  DEFAULT_KEEP_FILES,
  resolveLogLevel,
  sanitizeLogFields,
  stripUrlQueries,
  type LoggerFs
} from '../../src/main/logging/logger'
import { registerSecretValue } from '../../src/main/secrets/redact'

const tempDirs: string[] = []

function tempLogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quickask-logger-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function readFiles(files: string[]): string {
  return files.map((file) => readFileSync(file, 'utf8')).join('')
}

describe('rolling structured logger', () => {
  it('writes JSONL with ts/level/event and redacts secrets incl. URL query', () => {
    const dir = tempLogDir()
    registerSecretValue('custom-header-value-987654')
    const log = createLogger({
      logDir: dir,
      level: 'debug',
      now: () => Date.UTC(2026, 10, 5, 12, 0, 0)
    })

    log.info('provider_request_end', {
      requestId: 'req-1',
      detail:
        'Authorization: Bearer sk-live-1234567890 https://api.test/v1?key=mykey&token=mytoken&safe=1',
      custom: 'custom-header-value-987654'
    })

    const text = readFiles(log.getFiles())
    const line = JSON.parse(text.trim()) as Record<string, unknown>
    expect(line['ts']).toBe('2026-11-05T12:00:00.000Z')
    expect(line['level']).toBe('info')
    expect(line['event']).toBe('provider_request_end')
    expect(line['requestId']).toBe('req-1')
    expect(text).not.toContain('sk-live-1234567890')
    expect(text).not.toContain('mykey')
    expect(text).not.toContain('mytoken')
    expect(text).not.toContain('custom-header-value-987654')
    expect(text).not.toContain('safe=1')
    expect(text).toContain('[REDACTED]')
  })

  it('never serializes prompt/response/body/header/content/text values', () => {
    const dir = tempLogDir()
    const log = createLogger({ logDir: dir })
    log.info('should_not_leak', {
      prompt: 'PROMPT_SECRET',
      response: 'RESPONSE_SECRET',
      body: 'BODY_SECRET',
      headers: { Authorization: 'Bearer HEADER_SECRET' },
      content: 'CONTENT_SECRET',
      text: 'TEXT_SECRET',
      message: 'MESSAGE_SECRET',
      answer: 'ANSWER_SECRET',
      query: 'QUERY_SECRET'
    })

    const text = readFiles(log.getFiles())
    expect(text).toContain('[OMITTED]')
    for (const secret of [
      'PROMPT_SECRET',
      'RESPONSE_SECRET',
      'BODY_SECRET',
      'HEADER_SECRET',
      'CONTENT_SECRET',
      'TEXT_SECRET',
      'MESSAGE_SECRET',
      'ANSWER_SECRET',
      'QUERY_SECRET'
    ]) {
      expect(text).not.toContain(secret)
    }
  })

  it('caps error-ish field details at 300 characters after redaction', () => {
    const dir = tempLogDir()
    const log = createLogger({ logDir: dir })
    log.error('boom', { detail: `Authorization: Bearer abc ${'x'.repeat(1000)}` })

    const line = JSON.parse(readFiles(log.getFiles()).trim()) as { detail: string }
    expect(line.detail.length).toBeLessThanOrEqual(300)
    expect(line.detail).not.toContain('abc')
  })

  it('filters levels and honours QUICKASK_LOG_LEVEL parsing', () => {
    const dir = tempLogDir()
    const log = createLogger({ logDir: dir, level: 'warn' })
    log.debug('debug_only_event')
    log.info('info_only_event')
    log.warn('warn_only_event')
    log.error('error_only_event')

    const text = readFiles(log.getFiles())
    expect(text).not.toContain('debug_only_event')
    expect(text).not.toContain('info_only_event')
    expect(text).toContain('warn_only_event')
    expect(text).toContain('error_only_event')
    expect(resolveLogLevel('DEBUG')).toBe('debug')
    expect(resolveLogLevel('nonsense')).toBe('info')
    expect(resolveLogLevel(undefined)).toBe('info')
  })

  it('rotates at the size threshold keeping current + 2 backups and never loses a line', () => {
    const dir = tempLogDir()
    const maxBytes = 520
    const log = createLogger({ logDir: dir, maxBytes, keepFiles: DEFAULT_KEEP_FILES, level: 'info' })

    const total = 9
    for (let index = 0; index < total; index += 1) {
      log.info('rotation_event', { sequence: index, padding: 'x'.repeat(30) })
    }

    const files = log.getFiles()
    expect(files).toHaveLength(3)
    expect(existsSync(join(dir, 'quickask.log.1'))).toBe(true)
    expect(existsSync(join(dir, 'quickask.log.2'))).toBe(true)
    expect(existsSync(join(dir, 'quickask.log.3'))).toBe(false)
    for (const file of files) {
      expect(statSync(file).size).toBeLessThanOrEqual(maxBytes)
    }

    const text = readFiles(files)
    for (let index = 0; index < total; index += 1) {
      expect(text).toContain(`"sequence":${index}`)
    }
    // The newest line lives in the active file.
    const active = readFileSync(join(dir, 'quickask.log'), 'utf8')
    expect(active).toContain('"sequence":8')
  })

  it('does not throw when the filesystem rejects every write', () => {
    const dir = tempLogDir()
    const failingFs: LoggerFs = {
      existsSync: () => true,
      mkdirSync: () => undefined,
      statSync: () => ({ size: 0 }),
      appendFileSync: () => {
        throw new Error('EACCES')
      },
      renameSync: () => undefined,
      unlinkSync: () => undefined
    }
    const log = createLogger({ logDir: dir, fs: failingFs })

    expect(() => log.info('write_failure_event')).not.toThrow()
    expect(log.getWriteFailures()).toBeGreaterThan(0)
  })

  it('strips the entire URL query string before logging', () => {
    expect(stripUrlQueries('GET https://x.test/v1?a=1&b=2 now')).toBe(
      'GET https://x.test/v1 now'
    )
  })

  it('sanitizeLogFields is usable directly and drops reserved keys', () => {
    const fields = sanitizeLogFields({
      ts: 'evil',
      level: 'evil',
      event: 'evil',
      requestId: 'abc',
      password: 'hunter2',
      prompt: 'hello'
    })
    expect(fields['ts']).toBeUndefined()
    expect(fields['level']).toBeUndefined()
    expect(fields['event']).toBeUndefined()
    expect(fields['requestId']).toBe('abc')
    expect(fields['password']).toBe('[OMITTED]')
    expect(fields['prompt']).toBe('[OMITTED]')
  })
})
