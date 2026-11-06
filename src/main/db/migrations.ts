/**
 * Forward-only migrations. Each migration runs in its own
 * BEGIN IMMEDIATE … COMMIT; a failure rolls back and leaves the old DB intact.
 */

import type { DbDriver } from './driver'
import { DbError } from './errors'
import {
  applyV1Schema,
  FTS_PROBE_CREATE_SQL,
  FTS_PROBE_DROP_SQL,
  V2_MIGRATION_DDL
} from './schema'
import { SCHEMA_VERSION } from './version'

export { SCHEMA_VERSION }

export interface MigrationContext {
  ftsAvailable: boolean
}

export interface Migration {
  version: number
  up: (driver: DbDriver, context: MigrationContext) => void
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(driver, context) {
      applyV1Schema(driver, { ftsAvailable: context.ftsAvailable })
    }
  },
  {
    version: 2,
    up(driver) {
      driver.exec(V2_MIGRATION_DDL)
    }
  }
]

export function pendingMigrations(fromVersion: number): Migration[] {
  return MIGRATIONS.filter((migration) => migration.version > fromVersion).sort(
    (a, b) => a.version - b.version
  )
}

/**
 * Probe the actual SQLite build for FTS5 + the trigram tokenizer. The probe
 * uses a TEMP virtual table, so it never touches the main database.
 */
export function detectFtsSupport(driver: DbDriver): boolean {
  try {
    driver.exec(FTS_PROBE_DROP_SQL)
    driver.exec(FTS_PROBE_CREATE_SQL)
    driver.exec(FTS_PROBE_DROP_SQL)
    return true
  } catch {
    try {
      driver.exec(FTS_PROBE_DROP_SQL)
    } catch {
      // ignore cleanup failure
    }
    return false
  }
}

export function runMigrations(
  driver: DbDriver,
  fromVersion: number,
  context: MigrationContext
): void {
  for (const migration of pendingMigrations(fromVersion)) {
    try {
      driver.transaction(() => {
        migration.up(driver, context)
        // The version is a compile-time constant from our own migration list.
        driver.exec(`PRAGMA user_version = ${migration.version}`)
      })
    } catch (error) {
      throw new DbError(
        'DB_MIGRATION_FAILED',
        `Migration v${migration.version} failed; old database was kept`,
        { cause: error }
      )
    }
  }
}
