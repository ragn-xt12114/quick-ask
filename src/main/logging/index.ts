/**
 * Process-wide logger singleton.
 *
 * `src/main/index.ts` initialises it before any subsystem logs. Unit tests
 * that import a module without initialising logging get a silent no-op logger
 * so they never depend on the host filesystem.
 */

import { createLogger, type Logger, type LoggerOptions, type LogLevel } from './logger'

export type { Logger, LoggerOptions, LogFields, LogLevel, LoggerFs } from './logger'
export { createLogger, resolveLogLevel, sanitizeLogFields } from './logger'

const noopLogger: Logger = {
  logDir: '',
  filePath: '',
  level: 'info',
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  line: () => undefined,
  getFiles: () => [],
  getWriteFailures: () => 0
}

let active: Logger = noopLogger

export function initLogging(options: LoggerOptions): Logger {
  active = createLogger(options)
  return active
}

/** Test-only replacement; production always goes through `initLogging`. */
export function setGlobalLogger(logger: Logger): void {
  active = logger
}

export function getLogger(): Logger {
  return active
}

/** Compatibility shim for modules that previously used `console.*`. */
export function logLine(level: LogLevel, line: string): void {
  active.line(level, line)
}
