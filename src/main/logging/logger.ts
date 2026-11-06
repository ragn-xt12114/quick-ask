/**
 * Rolling structured file logger (plan Task 17 / NFR-10).
 *
 * Format: one JSON object per line (JSONL)
 *   {"ts":"2026-11-05T…Z","level":"info","event":"app_ready",…fields}
 *
 * Rotation policy (documented explicitly):
 *   - `quickask.log` is the active file, hard cap 5 MiB (default).
 *   - `quickask.log.1` and `quickask.log.2` are backups: 3 files total.
 *   - Rotation happens *before* appending a line that would exceed `maxBytes`
 *     so the current line is always written in full (a single line larger
 *     than the cap is written to an empty file rather than dropped).
 *
 * Privacy:
 *   - Every event name and field string passes through `redact()` (Task 11).
 *   - Content-like fields (prompt / response / body / headers / content /
 *     message / query / secrets) are never serialized as values.
 *   - Error-ish fields are capped at 300 characters via `redactSummary`.
 *
 * Failure behaviour: all filesystem operations are guarded; a read-only or
 * full disk can never crash the app. Write failures are counted for tests.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { redact, redactSummary } from '../secrets/redact'

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
/** Active file + `.1` + `.2` = 3 files total. */
export const DEFAULT_KEEP_FILES = 3
export const DEFAULT_FILE_NAME = 'quickask.log'

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

export type LogFieldValue = string | number | boolean | null | undefined
export type LogFields = Record<string, unknown>

export interface Logger {
  readonly logDir: string
  readonly filePath: string
  readonly level: LogLevel
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
  /** Human line compatibility shim used by existing modules. */
  line(level: LogLevel, line: string): void
  /** Existing files, active first (for tests/diagnostics). */
  getFiles(): string[]
  /** Number of failed filesystem operations (never throws). */
  getWriteFailures(): number
}

export interface LoggerFs {
  existsSync(path: string): boolean
  mkdirSync(path: string, options: { recursive: true; mode: number }): void
  statSync(path: string): { size: number }
  appendFileSync(path: string, data: string, options: { mode: number }): void
  renameSync(from: string, to: string): void
  unlinkSync(path: string): void
}

export interface LoggerOptions {
  logDir: string
  fileName?: string
  level?: LogLevel | string
  maxBytes?: number
  keepFiles?: number
  now?: () => number
  fs?: LoggerFs
  /**
   * Mirror `line()` output to stdout. Enabled in the Electron main process so
   * existing e2e assertions on `[lifecycle] …` keep working.
   */
  mirrorToConsole?: boolean
  /** Default cap for non-error string fields (errors are capped at 300). */
  maxFieldChars?: number
}

const defaultFs: LoggerFs = {
  existsSync: (path) => existsSync(path),
  mkdirSync: (path, options) => mkdirSync(path, options),
  statSync: (path) => statSync(path),
  appendFileSync: (path, data, options) => appendFileSync(path, data, options),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (path) => unlinkSync(path)
}

export function resolveLogLevel(
  value: string | undefined | null,
  fallback: LogLevel = 'info'
): LogLevel {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  return (LOG_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as LogLevel)
    : fallback
}

/** Field names whose *values* must never reach the log file. */
const FORBIDDEN_EXACT = new Set([
  'prompt',
  'response',
  'body',
  'requestbody',
  'responsebody',
  'headers',
  'header',
  'content',
  'text',
  'message',
  'messages',
  'answer',
  'delta',
  'query',
  'search',
  'authorization',
  'cookie',
  'cookies',
  'apikey',
  'api_key',
  'key',
  'secret',
  'token',
  'password',
  'passwd'
])

const FORBIDDEN_SUFFIX =
  /(?:prompt|response|body|headers?|content|message|answer|query|cookie|authorization|apikey|api_key|secret|token)(?:text|data|json|value)$/i

const ERRORISH_KEY = /(?:error|detail|reason|message)/i

/** Drop the entire query string from http(s) URLs before any log write. */
export function stripUrlQueries(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s"'<>]*\?[^\s"'<>]*/gi, (match) => {
    const index = match.indexOf('?')
    return index === -1 ? match : match.slice(0, index)
  })
}

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '')
}

function isForbiddenField(name: string): boolean {
  const normalized = normalizeFieldName(name)
  return FORBIDDEN_EXACT.has(normalized) || FORBIDDEN_SUFFIX.test(normalized)
}

function sanitizeValue(name: string, value: unknown, maxFieldChars: number): LogFieldValue {
  if (value === undefined) return undefined
  if (value === null) return null
  if (isForbiddenField(name)) return '[OMITTED]'
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) {
    return redactSummary(value.message || value.name, 300)
  }
  if (typeof value === 'string') {
    const stripped = stripUrlQueries(value)
    if (ERRORISH_KEY.test(name)) return redactSummary(stripped, 300)
    const redacted = redact(stripped)
    return redacted.length > maxFieldChars
      ? `${redacted.slice(0, Math.max(0, maxFieldChars - 3))}...`
      : redacted
  }
  // Objects/arrays are intentionally not traversed: they often contain
  // request bodies or header maps. Keep a placeholder only.
  return '[OBJECT]'
}

export function sanitizeLogFields(
  fields: LogFields | undefined,
  maxFieldChars = 1000
): Record<string, LogFieldValue> {
  if (!fields || typeof fields !== 'object') return {}
  const safe: Record<string, LogFieldValue> = {}
  for (const [name, value] of Object.entries(fields)) {
    if (name === 'ts' || name === 'level' || name === 'event') continue
    const sanitized = sanitizeValue(name, value, maxFieldChars)
    if (sanitized !== undefined) safe[name] = sanitized
  }
  return safe
}

function deriveLineEvent(line: string): string {
  const match = /^\[([A-Za-z0-9_-]+)\]\s*/.exec(line)
  if (match) return `${match[1]!.toLowerCase()}_log`
  return 'log'
}

class RollingLogger implements Logger {
  readonly logDir: string
  readonly filePath: string
  readonly level: LogLevel

  private readonly fileName: string
  private readonly maxBytes: number
  private readonly keepFiles: number
  private readonly now: () => number
  private readonly fs: LoggerFs
  private readonly mirrorToConsole: boolean
  private readonly maxFieldChars: number
  private writeFailures = 0
  private dirReady = false

  constructor(options: LoggerOptions) {
    this.logDir = options.logDir
    this.fileName = options.fileName ?? DEFAULT_FILE_NAME
    this.filePath = join(this.logDir, this.fileName)
    this.level = resolveLogLevel(options.level)
    this.maxBytes = Math.max(64, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES))
    this.keepFiles = Math.max(1, Math.floor(options.keepFiles ?? DEFAULT_KEEP_FILES))
    this.now = options.now ?? Date.now
    this.fs = options.fs ?? defaultFs
    this.mirrorToConsole = options.mirrorToConsole === true
    this.maxFieldChars = Math.max(80, Math.floor(options.maxFieldChars ?? 1000))
  }

  debug(event: string, fields?: LogFields): void {
    this.write('debug', event, fields)
  }

  info(event: string, fields?: LogFields): void {
    this.write('info', event, fields)
  }

  warn(event: string, fields?: LogFields): void {
    this.write('warn', event, fields)
  }

  error(event: string, fields?: LogFields): void {
    this.write('error', event, fields)
  }

  line(level: LogLevel, line: string): void {
    if (!this.enabled(level)) return
    const safe = redact(stripUrlQueries(typeof line === 'string' ? line : String(line)))
    this.write(level, deriveLineEvent(safe), { detail: safe })
    this.mirror(safe)
  }

  getFiles(): string[] {
    const files: string[] = []
    for (let index = 0; index < this.keepFiles; index += 1) {
      const path = index === 0 ? this.filePath : `${this.filePath}.${index}`
      try {
        if (this.fs.existsSync(path)) files.push(path)
      } catch {
        // ignore
      }
    }
    return files
  }

  getWriteFailures(): number {
    return this.writeFailures
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.level]
  }

  private write(level: LogLevel, event: string, fields?: LogFields): void {
    if (!this.enabled(level)) return
    const safeEvent = redact(typeof event === 'string' && event.length > 0 ? event : 'log')
    const payload: Record<string, unknown> = {
      ts: new Date(this.now()).toISOString(),
      level,
      event: safeEvent,
      ...sanitizeLogFields(fields, this.maxFieldChars)
    }

    let serialized: string
    try {
      serialized = JSON.stringify(payload)
    } catch {
      serialized = JSON.stringify({
        ts: new Date(this.now()).toISOString(),
        level,
        event: safeEvent,
        serialization_error: true
      })
    }
    this.append(serialized)
  }

  private mirror(line: string): void {
    if (!this.mirrorToConsole) return
    try {
      if (typeof process.stdout?.write === 'function') {
        process.stdout.write(`${line}\n`)
      }
    } catch {
      // stdout may be gone (packaged GUI process); never crash.
    }
  }

  private ensureDir(): void {
    if (this.dirReady) return
    this.fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 })
    this.dirReady = true
  }

  private size(): number {
    try {
      return this.fs.statSync(this.filePath).size
    } catch {
      return 0
    }
  }

  private append(serialized: string): void {
    const bytes = Buffer.byteLength(serialized, 'utf8') + 1
    try {
      this.ensureDir()
      const current = this.size()
      if (current > 0 && current + bytes > this.maxBytes) {
        this.rotate()
      }
      this.fs.appendFileSync(this.filePath, `${serialized}\n`, { mode: 0o600 })
    } catch {
      this.writeFailures += 1
    }
  }

  private rotate(): void {
    try {
      if (this.keepFiles <= 1) {
        if (this.fs.existsSync(this.filePath)) this.fs.unlinkSync(this.filePath)
        return
      }

      const oldest = `${this.filePath}.${this.keepFiles - 1}`
      if (this.fs.existsSync(oldest)) this.fs.unlinkSync(oldest)

      for (let index = this.keepFiles - 2; index >= 1; index -= 1) {
        const from = `${this.filePath}.${index}`
        const to = `${this.filePath}.${index + 1}`
        if (this.fs.existsSync(from)) this.fs.renameSync(from, to)
      }

      if (this.fs.existsSync(this.filePath)) {
        this.fs.renameSync(this.filePath, `${this.filePath}.1`)
      }
    } catch {
      this.writeFailures += 1
    }
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new RollingLogger(options)
}
