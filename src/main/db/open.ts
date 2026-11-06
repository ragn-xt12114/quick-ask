/**
 * Database open / recovery / migration entry point.
 *
 * Electron-free: callers pass a data directory (or rely on XDG env vars), so
 * Vitest and the seed tool can use the exact production code path.
 */

import { accessSync, chmodSync, constants, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DbDriver } from './driver'
import { SqliteDriver } from './driver'
import { DbError, isDbError, toDbError } from './errors'
import { detectFtsSupport, runMigrations, SCHEMA_VERSION } from './migrations'
import { resolveHostDataDir } from '../platform/paths'
import {
  FTS_TABLE_NAME,
  REQUIRED_PRAGMAS,
  type SchemaDatabase
} from './schema'

export interface OpenDatabaseOptions {
  /** Explicit data directory (tests). Falls back to QUICKASK_DATA_DIR / XDG. */
  dataDir?: string
  /** Injectable clock for deterministic backup names in tests. */
  now?: () => number
}

export interface DatabaseHandle {
  driver: DbDriver
  path: string
  dataDir: string
  recovered: boolean
  /** Migration backup and/or corrupt-file backup (latest one). */
  backupPath: string | null
  corruptBackupPath: string | null
  ftsAvailable: boolean
  close: () => void
}

export const DB_FILE_NAME = 'quickask.db'

export function resolveDataDir(explicit?: string): string {
  if (explicit && explicit.length > 0) return resolve(explicit)
  return resolveHostDataDir(undefined, process.env)
}

function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dataDir, 0o700)
  } catch {
    // best effort: an existing directory may be owned by another process
  }
}

function rowValue(row: Record<string, unknown> | undefined): unknown {
  if (!row) return undefined
  const values = Object.values(row)
  return values.length > 0 ? values[0] : undefined
}

function quickCheck(driver: DbDriver): { ok: boolean; result: string[] } {
  let rows: Record<string, unknown>[]
  try {
    rows = driver.prepare('PRAGMA quick_check').all()
  } catch (error) {
    const mapped = toDbError(error)
    if (mapped.code === 'DB_CORRUPT') return { ok: false, result: [mapped.message] }
    throw mapped
  }

  const result = rows.map((row) => String(rowValue(row)))
  return { ok: result.length === 1 && result[0] === 'ok', result }
}

function readUserVersion(driver: DbDriver): number {
  const row = driver.prepare('PRAGMA user_version').get()
  const value = rowValue(row)
  const version = Number(value)
  return Number.isFinite(version) ? version : 0
}

function applyPragmas(driver: DbDriver): void {
  for (const pragma of REQUIRED_PRAGMAS) {
    driver.exec(`PRAGMA ${pragma}`)
  }
}

function tableExists(driver: DbDriver, name: string): boolean {
  const row = driver
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get(name)
  return Number(row?.count ?? 0) > 0
}

function hasExistingContent(driver: DbDriver): boolean {
  const row = driver
    .prepare(
      `SELECT COUNT(*) AS count
         FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
          AND type IN ('table','index','view','trigger')`
    )
    .get()
  return Number(row?.count ?? 0) > 0
}

function uniquePath(basePath: string): string {
  if (!existsSync(basePath)) return basePath
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${basePath}-${i}`
    if (!existsSync(candidate)) return candidate
  }
  return `${basePath}-${Date.now()}`
}

function quarantineCorruptFiles(dbPath: string, timestamp: number): string {
  const files = ['', '-wal', '-shm']
  let primaryBackup: string | null = null

  for (const suffix of files) {
    const source = `${dbPath}${suffix}`
    if (!existsSync(source)) continue
    const target = uniquePath(`${source}.corrupt-${timestamp}`)
    renameSync(source, target)
    if (suffix === '' && primaryBackup === null) {
      primaryBackup = target
    }
  }

  if (primaryBackup === null) {
    throw new DbError('DB_CORRUPT', 'Corrupt database disappeared before it could be backed up')
  }
  return primaryBackup
}

function createMigrationBackup(
  driver: DbDriver,
  dbPath: string,
  fromVersion: number,
  timestamp: number
): string {
  const backupPath = uniquePath(`${dbPath}.bak-v${fromVersion}-${timestamp}`)
  try {
    driver.prepare('VACUUM INTO ?').run(backupPath)
  } catch (error) {
    throw new DbError(
      'DB_BACKUP_FAILED',
      `Could not back up database before migration: ${backupPath}`,
      { cause: error }
    )
  }
  try {
    chmodSync(backupPath, 0o600)
  } catch {
    // best effort
  }
  return backupPath
}

function openCheckedDriver(dbPath: string): SqliteDriver {
  let database: DatabaseSync
  try {
    database = new DatabaseSync(dbPath)
  } catch (error) {
    throw toDbError(error)
  }

  const driver = new SqliteDriver(database)
  const check = quickCheck(driver)
  if (!check.ok) {
    try {
      driver.close()
    } catch {
      // ignore
    }
    throw new DbError('DB_CORRUPT', `quick_check failed: ${check.result.join('; ')}`)
  }
  return driver
}

function tryChmodPrivate(path: string): void {
  try {
    chmodSync(path, 0o600)
  } catch {
    // best effort (read-only media, unusual umask, ...)
  }
}

export function openDatabase(options: OpenDatabaseOptions = {}): DatabaseHandle {
  const now = options.now ?? Date.now
  const dataDir = resolveDataDir(options.dataDir)
  ensureDataDir(dataDir)
  const dbPath = join(dataDir, DB_FILE_NAME)

  // A read-only file must surface a typed error instead of silently falling
  // through (SQLite can keep an already-WAL database open without a write).
  if (existsSync(dbPath)) {
    try {
      accessSync(dbPath, constants.W_OK)
    } catch {
      throw new DbError('DB_READONLY', 'Database is read-only', { sqliteCode: 8 })
    }
  }

  let driver: SqliteDriver
  let recovered = false
  let corruptBackupPath: string | null = null

  try {
    driver = openCheckedDriver(dbPath)
  } catch (error) {
    const mapped = isDbError(error) ? error : toDbError(error)
    if (mapped.code !== 'DB_CORRUPT') throw mapped

    // Corrupt / unopenable database: quarantine every related file, then
    // create a fresh database. The backup path is always reported.
    corruptBackupPath = quarantineCorruptFiles(dbPath, now())
    recovered = true
    driver = openCheckedDriver(dbPath)
  }

  let migrationBackupPath: string | null = null

  try {
    // Read the version before any write (WAL activation counts as a write).
    const version = readUserVersion(driver)
    if (version > SCHEMA_VERSION) {
      throw new DbError(
        'DB_VERSION_TOO_NEW',
        `Database schema v${version} is newer than supported v${SCHEMA_VERSION}; upgrade QuickAsk`
      )
    }

    applyPragmas(driver)

    const ftsSupported = detectFtsSupport(driver)
    if (version < SCHEMA_VERSION) {
      if (hasExistingContent(driver)) {
        migrationBackupPath = createMigrationBackup(driver, dbPath, version, now())
      }
      runMigrations(driver, version, { ftsAvailable: ftsSupported })
      const after = quickCheck(driver)
      if (!after.ok) {
        throw new DbError('DB_CORRUPT', `quick_check after migration failed: ${after.result.join('; ')}`)
      }
    }

    tryChmodPrivate(dbPath)

    const ftsAvailable = ftsSupported && tableExists(driver, FTS_TABLE_NAME)

    let closed = false
    const handle: DatabaseHandle = {
      driver,
      path: dbPath,
      dataDir,
      recovered,
      backupPath: corruptBackupPath ?? migrationBackupPath,
      corruptBackupPath,
      ftsAvailable,
      close: () => {
        if (closed) return
        closed = true
        driver.close()
      }
    }
    return handle
  } catch (error) {
    try {
      driver.close()
    } catch {
      // keep the original error
    }
    throw isDbError(error) ? error : toDbError(error)
  }
}

/** Type-only re-export useful to tools that build a minimal schema. */
export type OpenSchemaDatabase = SchemaDatabase
