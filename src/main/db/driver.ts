/**
 * Thin, synchronous wrapper over `node:sqlite` (SQLite 3.53 bundled by
 * Electron's Node 24). No ORM, no async, POSITIONAL parameters only.
 *
 * Every driver entry point maps raw SQLite errors to `DbError` so callers
 * never see driver internals or SQL text.
 */

import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { DbError, toDbError } from './errors'

export type DbRow = Record<string, unknown>

export interface DbStatement {
  run(...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint }
  get(...params: SQLInputValue[]): DbRow | undefined
  all(...params: SQLInputValue[]): DbRow[]
}

export interface DbDriver {
  exec(sql: string): void
  prepare(sql: string): DbStatement
  transaction<T>(fn: () => T): T
  close(): void
}

class SqliteStatement implements DbStatement {
  constructor(private readonly statement: StatementSync) {}

  run(...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint } {
    try {
      const result = this.statement.run(...params)
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }
    } catch (error) {
      throw toDbError(error)
    }
  }

  get(...params: SQLInputValue[]): DbRow | undefined {
    try {
      return this.statement.get(...params) as DbRow | undefined
    } catch (error) {
      throw toDbError(error)
    }
  }

  all(...params: SQLInputValue[]): DbRow[] {
    try {
      return this.statement.all(...params) as DbRow[]
    } catch (error) {
      throw toDbError(error)
    }
  }
}

export class SqliteDriver implements DbDriver {
  private depth = 0
  private closed = false

  constructor(private readonly database: DatabaseSync) {}

  exec(sql: string): void {
    this.assertOpen()
    try {
      this.database.exec(sql)
    } catch (error) {
      throw toDbError(error)
    }
  }

  prepare(sql: string): DbStatement {
    this.assertOpen()
    try {
      return new SqliteStatement(this.database.prepare(sql))
    } catch (error) {
      throw toDbError(error)
    }
  }

  /**
   * Run `fn` inside BEGIN IMMEDIATE … COMMIT. Nested calls use SAVEPOINTs so
   * repository-level transactions compose safely.
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen()
    const nested = this.depth > 0
    const savepoint = `quickask_sp_${this.depth}`

    try {
      if (nested) {
        this.database.exec(`SAVEPOINT ${savepoint}`)
      } else {
        this.database.exec('BEGIN IMMEDIATE')
      }
    } catch (error) {
      throw toDbError(error)
    }
    this.depth += 1

    try {
      const result = fn()
      if (nested) {
        this.database.exec(`RELEASE SAVEPOINT ${savepoint}`)
      } else {
        this.database.exec('COMMIT')
      }
      return result
    } catch (error) {
      try {
        if (nested) {
          this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          this.database.exec(`RELEASE SAVEPOINT ${savepoint}`)
        } else {
          this.database.exec('ROLLBACK')
        }
      } catch {
        // The original error is more useful than a rollback failure.
      }
      throw toDbError(error)
    } finally {
      this.depth -= 1
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.database.close()
    } catch (error) {
      throw toDbError(error)
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DbError('DB_WRITE', 'Database handle is closed')
    }
  }
}
