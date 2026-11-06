/**
 * Typed database errors.
 *
 * Repositories and the open/migration layer never leak raw SQLite error
 * objects or SQL text to callers. The IPC layer can map `DbError.code` to a
 * user-visible error without inspecting driver internals.
 */

export const DB_ERROR_CODES = [
  'DB_OPEN_FAILED',
  'DB_VERSION_TOO_NEW',
  'DB_CORRUPT',
  'DB_READONLY',
  'SQLITE_FULL',
  'DB_BUSY',
  'DB_CONSTRAINT',
  'DB_WRITE',
  'DB_NOT_FOUND',
  'DB_MIGRATION_FAILED',
  'DB_BACKUP_FAILED'
] as const

export type DbErrorCode = (typeof DB_ERROR_CODES)[number]

export interface DbErrorOptions {
  /** Raw SQLite extended result code (for diagnostics only). */
  sqliteCode?: number
  cause?: unknown
}

export class DbError extends Error {
  readonly code: DbErrorCode
  readonly sqliteCode?: number

  constructor(code: DbErrorCode, message: string, options: DbErrorOptions = {}) {
    super(message)
    this.name = 'DbError'
    this.code = code
    this.sqliteCode = options.sqliteCode
    if (options.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }
}

export function isDbError(value: unknown): value is DbError {
  return value instanceof DbError
}

function sqliteCodeOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const value = (error as { errcode?: unknown }).errcode
    if (typeof value === 'number') return value
  }
  return undefined
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const value = (error as { code?: unknown }).code
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * Map a thrown node:sqlite/fs error to a typed DbError.
 *
 * SQLite primary result codes used here:
 *   5  SQLITE_BUSY
 *   8  SQLITE_READONLY
 *   11 SQLITE_CORRUPT
 *   13 SQLITE_FULL
 *   19 SQLITE_CONSTRAINT
 *   26 SQLITE_NOTADB
 */
export function toDbError(error: unknown): DbError {
  if (isDbError(error)) return error

  const sqliteCode = sqliteCodeOf(error)
  const message = error instanceof Error ? error.message : 'database operation failed'

  if (sqliteCode !== undefined) {
    const primary = sqliteCode & 0xff
    switch (primary) {
      case 5:
        return new DbError('DB_BUSY', 'Database is busy', { sqliteCode, cause: error })
      case 8:
        return new DbError('DB_READONLY', 'Database is read-only', {
          sqliteCode,
          cause: error
        })
      case 11:
      case 26:
        return new DbError('DB_CORRUPT', 'Database file is corrupt or not a database', {
          sqliteCode,
          cause: error
        })
      case 13:
        return new DbError('SQLITE_FULL', 'Database or disk is full', {
          sqliteCode,
          cause: error
        })
      case 19:
        return new DbError('DB_CONSTRAINT', 'Database constraint failed', {
          sqliteCode,
          cause: error
        })
      default:
        return new DbError('DB_WRITE', `Database error (sqlite ${sqliteCode})`, {
          sqliteCode,
          cause: error
        })
    }
  }

  const errno = errnoOf(error)
  if (errno === 'EACCES' || errno === 'EPERM' || errno === 'EROFS') {
    return new DbError('DB_READONLY', message, { cause: error })
  }
  if (errno === 'ENOSPC' || errno === 'EDQUOT') {
    return new DbError('SQLITE_FULL', 'Database or disk is full', { cause: error })
  }
  if (message.includes('file is not a database') || message.includes('database disk image is malformed')) {
    return new DbError('DB_CORRUPT', message, { cause: error })
  }
  if (message.includes('readonly') || message.includes('read-only')) {
    return new DbError('DB_READONLY', message, { cause: error })
  }
  if (message.includes('database or disk is full')) {
    return new DbError('SQLITE_FULL', message, { cause: error })
  }

  return new DbError('DB_WRITE', message, { cause: error })
}
