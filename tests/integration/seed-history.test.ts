import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../../src/main/db/version'
import { MIGRATIONS } from '../../src/main/db/migrations'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('seed-history schema version', () => {
  it('keeps the version constant in sync with the latest migration', () => {
    expect(SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version)
  })

  it('writes the current schema version so the app does not re-run v1 on an existing DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quickask-seed-version-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'quickask.db')

    execFileSync(
      process.execPath,
      [
        'tools/seed-history.mjs',
        '--sessions',
        '2',
        '--messages',
        '1',
        '--fts',
        '--db',
        dbPath
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 }
    )

    const db = new DatabaseSync(dbPath)
    try {
      const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(Number(row.user_version)).toBe(SCHEMA_VERSION)
      expect(Number(row.user_version)).toBeGreaterThan(0)
      const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{
        name: string
      }>
      expect(columns.map((column) => column.name)).toContain('images_json')
    } finally {
      db.close()
    }
  })
})
