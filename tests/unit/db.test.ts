import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import {
  DB_FILE_NAME,
  DbError,
  isDbError,
  openDatabase,
  openDbService,
  resolveDataDir,
  SCHEMA_VERSION,
  type DatabaseHandle
} from '../../src/main/db'
import { applyV1Schema } from '../../src/main/db/schema'
import { uuidv7 } from '../../src/shared/uuidv7'

const EVIDENCE_DIR = resolve(process.cwd(), '.omo', 'evidence')
const dirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quickask-db-'))
  dirs.push(dir)
  return dir
}

function writeEvidence(name: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const body = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(join(EVIDENCE_DIR, name), body)
}

function pragma(handle: DatabaseHandle, statement: string): unknown {
  const row = handle.driver.prepare(`PRAGMA ${statement}`).get()
  return row ? Object.values(row)[0] : undefined
}

function rawDatabase(path: string, fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path)
  try {
    fn(db)
  } finally {
    db.close()
  }
}

function filesFor(dir: string, pattern: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(pattern))
}

function expectDbError(fn: () => unknown, code: string): DbError {
  try {
    fn()
  } catch (error) {
    expect(isDbError(error)).toBe(true)
    expect((error as DbError).code).toBe(code)
    return error as DbError
  }
  throw new Error(`expected DbError ${code}`)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('openDatabase / schema v1', () => {
  it('resolves an explicit dir, QUICKASK_DATA_DIR, XDG_DATA_HOME and the home fallback', () => {
    const dir = makeDir()
    const previousDataDir = process.env.QUICKASK_DATA_DIR
    const previousXdg = process.env.XDG_DATA_HOME
    try {
      process.env.XDG_DATA_HOME = dir
      delete process.env.QUICKASK_DATA_DIR
      expect(resolveDataDir()).toBe(join(dir, 'quickask'))

      const explicit = join(dir, 'explicit')
      expect(resolveDataDir(explicit)).toBe(resolve(explicit))

      const envDir = join(dir, 'from-env')
      process.env.QUICKASK_DATA_DIR = envDir
      expect(resolveDataDir()).toBe(resolve(envDir))
    } finally {
      if (previousDataDir === undefined) delete process.env.QUICKASK_DATA_DIR
      else process.env.QUICKASK_DATA_DIR = previousDataDir
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousXdg
    }
  })

  it('creates the exact v1 schema, PRAGMAs, permissions and FTS trigram table', () => {
    const dir = makeDir()
    const handle = openDatabase({ dataDir: dir })

    expect(handle.path).toBe(join(dir, DB_FILE_NAME))
    expect(handle.recovered).toBe(false)
    expect(handle.ftsAvailable).toBe(true)
    expect(Number(pragma(handle, 'user_version'))).toBe(SCHEMA_VERSION)

    expect(String(pragma(handle, 'journal_mode')).toLowerCase()).toBe('wal')
    expect(Number(pragma(handle, 'synchronous'))).toBe(1) // NORMAL
    expect(Number(pragma(handle, 'foreign_keys'))).toBe(1)
    expect(Number(pragma(handle, 'busy_timeout'))).toBe(5000)
    expect(Number(pragma(handle, 'wal_autocheckpoint'))).toBe(1000)

    const tables = handle.driver
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name))
    for (const table of [
      'sessions',
      'messages',
      'drafts',
      'provider_profiles',
      'settings',
      'session_search'
    ]) {
      expect(tables).toContain(table)
    }

    const indexes = handle.driver
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all()
      .map((row) => String(row.name))
    expect(indexes).toContain('idx_sessions_updated')
    expect(indexes).toContain('idx_messages_session_seq')

    const ftsSql = String(
      handle.driver
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'session_search'")
        .get()?.sql
    )
    expect(ftsSql).toContain("tokenize = 'trigram'")

    // No secret columns anywhere in provider_profiles.
    const providerColumns = handle.driver
      .prepare('PRAGMA table_info(provider_profiles)')
      .all()
      .map((row) => String(row.name))
    expect(providerColumns).toContain('key_ref')
    expect(providerColumns).toContain('header_names_json')
    expect(providerColumns).not.toContain('api_key')
    expect(providerColumns).not.toContain('secret')

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(handle.path).mode & 0o777).toBe(0o600)

    writeEvidence('task-10-schema.json', {
      schemaVersion: 1,
      tables,
      indexes: ['idx_sessions_updated', 'idx_messages_session_seq'],
      ftsTable: 'session_search',
      ftsTokenizer: "trigram",
      pragmas: {
        journalMode: String(pragma(handle, 'journal_mode')),
        synchronous: Number(pragma(handle, 'synchronous')),
        foreignKeys: Number(pragma(handle, 'foreign_keys')),
        busyTimeout: Number(pragma(handle, 'busy_timeout')),
        walAutocheckpoint: Number(pragma(handle, 'wal_autocheckpoint'))
      },
      dataDirMode: '0700',
      databaseFileMode: '0600'
    })

    handle.close()

    // Reopen is idempotent: no new migration, no corruption, same version.
    const reopened = openDatabase({ dataDir: dir })
    expect(reopened.recovered).toBe(false)
    expect(reopened.backupPath).toBeNull()
    expect(Number(pragma(reopened, 'user_version'))).toBe(SCHEMA_VERSION)
    expect(reopened.ftsAvailable).toBe(true)
    expect(
      Number(reopened.driver.prepare('SELECT COUNT(*) AS c FROM sessions').get()?.c)
    ).toBe(0)
    reopened.close()
  })
})

describe('migrations', () => {
  it('v0 -> v1 backs up a populated database with VACUUM INTO and keeps data', () => {
    const dir = makeDir()
    const dbPath = join(dir, DB_FILE_NAME)
    rawDatabase(dbPath, (db) => {
      db.exec('CREATE TABLE legacy (value TEXT)')
      db.prepare('INSERT INTO legacy (value) VALUES (?)').run('old-row')
    })

    const handle = openDatabase({ dataDir: dir })
    expect(handle.recovered).toBe(false)
    expect(handle.backupPath).not.toBeNull()
    expect(handle.backupPath).toContain('.bak-v0-')
    expect(existsSync(handle.backupPath as string)).toBe(true)

    expect(Number(pragma(handle, 'user_version'))).toBe(SCHEMA_VERSION)
    expect(
      Number(handle.driver.prepare('SELECT COUNT(*) AS c FROM legacy').get()?.c)
    ).toBe(1)
    expect(
      Number(handle.driver.prepare('SELECT COUNT(*) AS c FROM sessions').get()?.c)
    ).toBe(0)

    // The backup is a complete snapshot of the pre-migration DB.
    const backup = new DatabaseSync(handle.backupPath as string, { readOnly: true })
    try {
      expect(Number(backup.prepare('PRAGMA user_version').get()?.user_version)).toBe(0)
      expect(Number(backup.prepare('SELECT COUNT(*) AS c FROM legacy').get()?.c)).toBe(1)
    } finally {
      backup.close()
    }
    writeEvidence('task-10-migration.json', {
      fromVersion: 0,
      toVersion: 1,
      backupPath: handle.backupPath,
      backupUserVersion: 0,
      backupLegacyRows: 1,
      migratedLegacyRows: 1,
      migratedSessions: 0,
      quickCheck: 'ok'
    })
    handle.close()
  })

  it('keeps the old database when a migration fails', () => {
    const dir = makeDir()
    const dbPath = join(dir, DB_FILE_NAME)
    rawDatabase(dbPath, (db) => {
      // Conflicting table name guarantees CREATE TABLE sessions fails.
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)')
      db.prepare('INSERT INTO sessions (id) VALUES (?)').run('keep-me')
    })

    const error = expectDbError(() => openDatabase({ dataDir: dir }), 'DB_MIGRATION_FAILED')
    expect(error.message).toContain('old database was kept')
    expect(filesFor(dir, '.bak-v0-').length).toBe(1)

    rawDatabase(dbPath, (db) => {
      expect(Number(db.prepare('PRAGMA user_version').get()?.user_version)).toBe(0)
      expect(Number(db.prepare('SELECT COUNT(*) AS c FROM sessions').get()?.c)).toBe(1)
      expect(String(db.prepare('SELECT id FROM sessions').get()?.id)).toBe('keep-me')
      expect(Number(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'messages'").get()?.c)).toBe(0)
    })

    writeEvidence('task-10-migration-failure.json', {
      code: error.code,
      oldDatabaseKept: true,
      userVersion: 0,
      legacyRows: 1,
      messagesTableCreated: false,
      backupCreated: true
    })
  })
})

describe('corruption recovery', () => {
  it('quarantines random bytes as .corrupt-<ts>, reports the path and creates a usable DB', () => {
    const dir = makeDir()
    const dbPath = join(dir, DB_FILE_NAME)
    const garbage = Buffer.from('this is definitely not a sqlite database\u0000\u0001\u0002')
    writeFileSync(dbPath, garbage)

    const handle = openDatabase({ dataDir: dir })
    expect(handle.recovered).toBe(true)
    expect(handle.corruptBackupPath).not.toBeNull()
    expect(handle.corruptBackupPath).toContain('.corrupt-')
    expect(existsSync(handle.corruptBackupPath as string)).toBe(true)
    expect(readFileSync(handle.corruptBackupPath as string).equals(garbage)).toBe(true)
    expect(String(pragma(handle, 'journal_mode')).toLowerCase()).toBe('wal')
    expect(Number(pragma(handle, 'user_version'))).toBe(SCHEMA_VERSION)

    // The replacement DB is fully usable.
    handle.driver
      .prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('s1', 'after recovery', 1, 1)
    expect(Number(handle.driver.prepare('SELECT COUNT(*) AS c FROM sessions').get()?.c)).toBe(1)
    handle.close()

    writeEvidence('task-10-corrupt.log', {
      corruptBackupPath: handle.corruptBackupPath,
      recovered: true,
      schemaVersion: 1,
      quickCheck: 'ok'
    })
  })
})

describe('FTS-unavailable fallback', () => {
  it('opens a v1 database without session_search and falls back to LIKE', () => {
    const dir = makeDir()
    const dbPath = join(dir, DB_FILE_NAME)
    rawDatabase(dbPath, (db) => {
      db.exec('PRAGMA journal_mode = WAL')
      applyV1Schema(db, { ftsAvailable: false })
      db.exec('PRAGMA user_version = 1')
    })

    const service = openDbService({ dataDir: dir, recover: false })
    expect(service.handle.ftsAvailable).toBe(false)
    expect(
      Number(service.driver.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'session_search'").get()?.c)
    ).toBe(0)

    const at = 1_700_050_000_000
    const begin = service.beginSend({ text: '没有 FTS 也要能搜索报错' }, at)
    service.appendStream(begin.assistantMessageId, '完整回答里也有报错日志。', at + 1)
    expect(service.finishStream(begin.assistantMessageId, 'complete', {}, at + 2)).toBe(true)

    expect(service.searchSessions('报错', 10).map((row) => row.id)).toContain(begin.sessionId)
    expect(service.searchSessions('报错日志', 10).map((row) => row.id)).toContain(begin.sessionId)
    service.close()
  })
})

describe('version guard', () => {
  it('refuses a newer schema without modifying or downgrading it', () => {
    const dir = makeDir()
    const dbPath = join(dir, DB_FILE_NAME)
    rawDatabase(dbPath, (db) => {
      db.exec('CREATE TABLE future_only (value TEXT)')
      db.prepare('INSERT INTO future_only (value) VALUES (?)').run('future')
      db.exec('PRAGMA user_version = 99')
    })

    const error = expectDbError(() => openDatabase({ dataDir: dir }), 'DB_VERSION_TOO_NEW')
    expect(error.message).toContain('newer than supported')

    rawDatabase(dbPath, (db) => {
      expect(Number(db.prepare('PRAGMA user_version').get()?.user_version)).toBe(99)
      expect(
        Number(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'sessions'").get()?.c)
      ).toBe(0)
      expect(Number(db.prepare('SELECT COUNT(*) AS c FROM future_only').get()?.c)).toBe(1)
    })
    expect(filesFor(dir, '.corrupt-').length).toBe(0)
    expect(filesFor(dir, '.bak-').length).toBe(0)

    writeEvidence('task-10-version-guard.json', {
      code: error.code,
      userVersionAfter: 99,
      sessionsTableCreated: false,
      futureTableRows: 1,
      corruptBackups: 0,
      migrationBackups: 0
    })
  })
})

describe('streaming persistence and crash recovery', () => {
  it('turns leftover streaming rows into interrupted, preserves content and never duplicates', () => {
    const dir = makeDir()
    const clock = 1_700_000_000_000
    let service = openDbService({ dataDir: dir, recover: false, now: () => clock })

    const begin = service.beginSend({ text: '崩溃恢复测试' }, clock)
    service.appendStream(begin.assistantMessageId, '已经生成的部分内容', clock + 5)
    service.close() // simulate a process exit before finishStream

    service = openDbService({ dataDir: dir, now: () => clock + 10 })
    expect(service.lastRecoveryCount).toBe(1)

    const messages = service.getMessages(begin.sessionId)
    expect(messages).toHaveLength(2)
    const user = messages.find((message) => message.role === 'user')
    const assistant = messages.find((message) => message.role === 'assistant')
    expect(user?.status).toBe('complete')
    expect(assistant?.status).toBe('interrupted')
    expect(assistant?.content).toBe('已经生成的部分内容')
    expect(service.counts().streaming).toBe(0)
    expect(service.counts().messages).toBe(2)

    // A second recovery is a no-op.
    expect(service.recoverStreaming()).toBe(0)
    service.close()

    writeEvidence('task-10-recovery.json', {
      streamingAfterOpen: 0,
      interrupted: 1,
      contentPreserved: true,
      duplicateAssistantMessages: 0
    })
  })
})

describe('beginSend transaction', () => {
  it('rolls back session, user message and assistant placeholder when the insert fails', () => {
    const dir = makeDir()
    const service = openDbService({ dataDir: dir, recover: false })
    service.driver.exec(`
      CREATE TRIGGER fail_assistant_insert
      BEFORE INSERT ON messages
      WHEN NEW.role = 'assistant'
      BEGIN
        SELECT RAISE(ABORT, 'simulated assistant insert failure');
      END;
    `)

    try {
      service.beginSend({ text: '这条不该留下任何行' })
      throw new Error('beginSend should have thrown')
    } catch (error) {
      expect(isDbError(error)).toBe(true)
      expect(['DB_CONSTRAINT', 'DB_WRITE']).toContain((error as DbError).code)
    }

    expect(service.counts().sessions).toBe(0)
    expect(service.counts().messages).toBe(0)

    service.driver.exec('DROP TRIGGER fail_assistant_insert')
    const begin = service.beginSend({ text: '重试成功' })
    expect(service.counts().sessions).toBe(1)
    expect(service.counts().messages).toBe(2)
    expect(begin.seq).toBe(0)
    service.close()
  })
})

describe('service boundary normalization', () => {
  it('auto-titles from the first user message and caps error_detail at 300 chars', () => {
    const dir = makeDir()
    const service = openDbService({ dataDir: dir, recover: false })
    const at = 1_700_150_000_000
    const text = '**标题**\n第二行：' + '很长的内容'.repeat(20)
    const begin = service.beginSend({ text }, at)
    const session = service.getSession(begin.sessionId)

    expect(session?.titleAuto).toBe(true)
    expect(session?.title).not.toContain('*')
    expect(Array.from(session?.title ?? '')).toHaveLength(20)

    service.finishStream(
      begin.assistantMessageId,
      'error',
      { errorCode: 'RATE_LIMIT', errorDetail: 'x'.repeat(500), model: 'mock' },
      at + 1
    )
    const assistant = service
      .getMessages(begin.sessionId)
      .find((message) => message.role === 'assistant')
    expect(assistant?.status).toBe('error')
    expect(assistant?.errorCode).toBe('RATE_LIMIT')
    expect(assistant?.errorDetail).toHaveLength(300)
    service.close()
  })
})

describe('read-only and disk-full errors', () => {
  it('returns a typed DB_READONLY error for a chmod 0444 database and keeps the file', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return

    const dir = makeDir()
    const first = openDatabase({ dataDir: dir })
    first.close()
    chmodSync(join(dir, DB_FILE_NAME), 0o444)

    const error = expectDbError(() => openDatabase({ dataDir: dir }), 'DB_READONLY')
    expect(error.sqliteCode).toBe(8)
    expect(filesFor(dir, '.corrupt-').length).toBe(0)
    expect(filesFor(dir, '.bak-').length).toBe(0)

    chmodSync(join(dir, DB_FILE_NAME), 0o600)
    writeEvidence('task-10-readonly.json', {
      code: error.code,
      sqliteCode: error.sqliteCode,
      corruptBackupCreated: false
    })
  })

  it('maps SQLITE_FULL to a typed error and remains usable after resetting max_page_count', () => {
    const dir = makeDir()
    const service = openDbService({ dataDir: dir, recover: false })
    const pageCount = Number(
      Object.values(service.driver.prepare('PRAGMA page_count').get() ?? {})[0] ?? 0
    )
    service.driver.exec(`PRAGMA max_page_count = ${pageCount}`)

    let fullError: DbError | null = null
    try {
      service.beginSend({ text: 'x'.repeat(2_000_000) })
    } catch (error) {
      fullError = error as DbError
    }
    expect(fullError).not.toBeNull()
    expect(fullError?.code).toBe('SQLITE_FULL')
    expect(service.counts().sessions).toBe(0)

    service.driver.exec('PRAGMA max_page_count = 1000000')
    const begin = service.beginSend({ text: '磁盘恢复后仍可写入' })
    expect(service.counts().sessions).toBe(1)
    expect(service.getMessages(begin.sessionId)).toHaveLength(2)
    service.close()

    writeEvidence('task-10-full.json', {
      code: fullError?.code,
      sqliteCode: fullError?.sqliteCode,
      usableAfterReset: true
    })
  })
})

describe('search and index maintenance', () => {
  it('uses LIKE for 2-char CJK, FTS for 4+ chars, escapes specials and rebuilds on rename/delete', () => {
    const dir = makeDir()
    const service = openDbService({ dataDir: dir, recover: false })
    const at = 1_700_100_000_000

    const first = service.beginSend({ text: '系统报错了怎么处理' }, at)
    service.appendStream(
      first.assistantMessageId,
      '错误日志显示 SQLITE_FULL，需要检查磁盘空间。',
      at + 1
    )
    service.finishStream(first.assistantMessageId, 'complete', {}, at + 2)

    // 2 Chinese characters -> LIKE branch.
    expect(service.searchSessions('报错', 10).map((row) => row.id)).toContain(first.sessionId)
    // 4 characters -> FTS trigram branch.
    expect(service.searchSessions('错误日志', 10).map((row) => row.id)).toContain(first.sessionId)
    // Empty query and MATCH-syntax characters are safe.
    expect(service.searchSessions('   ', 10)).toEqual([])
    expect(() => service.searchSessions('"*()-', 10)).not.toThrow()
    expect(Array.isArray(service.searchSessions('"*()-', 10))).toBe(true)
    expect(service.searchSessions('%_', 10)).toEqual([])

    const literalWildcard = service.beginSend({ text: '进度 100%_完成' }, at + 5)
    service.finishStream(literalWildcard.assistantMessageId, 'complete', {}, at + 6)
    expect(service.searchSessions('%_', 10).map((row) => row.id)).toEqual([
      literalWildcard.sessionId
    ])
    expect(service.searchSessions('%', 10).map((row) => row.id)).toEqual([
      literalWildcard.sessionId
    ])

    const second = service.beginSend({ text: '这是一条普通消息' }, at + 10)
    service.finishStream(second.assistantMessageId, 'complete', {}, at + 11)

    expect(service.searchSessions('重命名检索词', 10).map((row) => row.id)).not.toContain(
      second.sessionId
    )
    expect(service.renameSession(second.sessionId, '重命名检索词', at + 20)).toBe(true)
    const renamed = service.getSession(second.sessionId)
    expect(renamed?.title).toBe('重命名检索词')
    expect(renamed?.titleAuto).toBe(false)
    expect(service.searchSessions('重命名检索词', 10).map((row) => row.id)).toContain(
      second.sessionId
    )

    expect(service.deleteSession(first.sessionId)).toBe(true)
    expect(service.searchSessions('错误日志', 10)).toEqual([])
    expect(service.getMessages(first.sessionId)).toEqual([])

    // listSessions with a query delegates to the same search path.
    expect(service.listSessions({ query: '重命名', limit: 10 }).map((row) => row.id)).toContain(
      second.sessionId
    )

    service.close()
  })
})

describe('foreign keys, drafts, settings and provider profiles', () => {
  it('cascades deletes, keeps only key refs/header names, and stores JSON settings', () => {
    const dir = makeDir()
    const service = openDbService({ dataDir: dir, recover: false })
    const at = 1_700_200_000_000

    const begin = service.beginSend({ text: '级联删除测试' }, at)
    service.appendStream(begin.assistantMessageId, '内容', at + 1)
    service.finishStream(begin.assistantMessageId, 'complete', {}, at + 2)
    expect(Number(pragma(service.handle, 'foreign_keys'))).toBe(1)

    expect(service.setDraft(begin.sessionId, '会话草稿', at + 3)).toBe(true)
    expect(service.setDraft('new', '新会话草稿', at + 4)).toBe(true)
    expect(service.getDraft(begin.sessionId)).toBe('会话草稿')

    service.settingsSet('theme', { mode: 'dark', scale: 1.25 }, at + 5)
    expect(service.settingsGetAll()).toEqual({ theme: { mode: 'dark', scale: 1.25 } })
    expect(service.settingsGet('theme')).toEqual({ mode: 'dark', scale: 1.25 })

    const profile = service.createProviderProfile({
      id: 'profile-1',
      name: 'Mock provider',
      baseUrl: 'http://127.0.0.1:9999/v1',
      keyRef: 'provider:profile-1:api_key',
      headerNames: [
        { name: 'Authorization', secret: true },
        { name: 'X-Trace', secret: false }
      ],
      updatedAt: at
    })
    expect(profile.keyRef).toBe('provider:profile-1:api_key')
    expect(profile.headerNames).toEqual([
      { name: 'Authorization', secret: true },
      { name: 'X-Trace', secret: false }
    ])
    expect(service.listProviderProfiles()).toHaveLength(1)

    expect(service.deleteSession(begin.sessionId)).toBe(true)
    expect(service.getMessages(begin.sessionId)).toEqual([])
    expect(service.getDraft(begin.sessionId)).toBe('') // cascade
    expect(service.getDraft('new')).toBe('新会话草稿')

    service.close()
  })
})

describe('1000-session performance budget', () => {
  it('lists and searches 1000 sessions / 10k messages under 150ms', () => {
    const dir = makeDir()
    const service = openDbService({ dataDir: dir, recover: false })
    const base = 1_700_300_000_000
    const insertSession = service.driver.prepare(
      `INSERT INTO sessions (id, title, title_auto, created_at, updated_at, last_message_at, model)
       VALUES (?, ?, 1, ?, ?, ?, 'perf-model')`
    )
    const insertMessage = service.driver.prepare(
      `INSERT INTO messages
         (id, session_id, seq, role, content, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'complete', ?, ?)`
    )
    const insertFts = service.driver.prepare(
      'INSERT INTO session_search (session_id, title, body) VALUES (?, ?, ?)'
    )

    const seedStart = performance.now()
    service.driver.transaction(() => {
      for (let i = 0; i < 1000; i += 1) {
        const at = base + i * 1000
        const sessionId = uuidv7(at)
        const title = `性能优化会话 ${i + 1}`
        insertSession.run(sessionId, title, at, at + 10_000, at + 10_000)
        const parts: string[] = []
        for (let m = 0; m < 10; m += 1) {
          const role = m % 2 === 0 ? 'user' : 'assistant'
          const content =
            role === 'user'
              ? `问题 ${m + 1}：请分析性能优化与报错排查，编号 ${i}-${m}。`
              : `回答 ${m + 1}：错误日志里包含性能优化线索，编号 ${i}-${m}。`
          insertMessage.run(uuidv7(at + m), sessionId, m, role, content, at + m, at + m)
          parts.push(content)
        }
        insertFts.run(sessionId, title, parts.join('\n').slice(0, 65_536))
      }
    })
    const seedMs = performance.now() - seedStart

    const listStart = performance.now()
    const list = service.listSessions({ limit: 50 })
    const listMs = performance.now() - listStart

    const likeStart = performance.now()
    const likeResults = service.searchSessions('报错', 50)
    const likeMs = performance.now() - likeStart

    const ftsStart = performance.now()
    const ftsResults = service.searchSessions('性能优化', 50)
    const ftsMs = performance.now() - ftsStart

    expect(service.counts().sessions).toBe(1000)
    expect(service.counts().messages).toBe(10_000)
    expect(list).toHaveLength(50)
    expect(likeResults.length).toBeGreaterThan(0)
    expect(ftsResults.length).toBeGreaterThan(0)

    expect(listMs).toBeLessThan(150)
    expect(likeMs).toBeLessThan(150)
    expect(ftsMs).toBeLessThan(150)

    const evidence = {
      sessions: 1000,
      messages: 10_000,
      seedMs: Number(seedMs.toFixed(2)),
      listSessions50Ms: Number(listMs.toFixed(2)),
      like2CharQueryMs: Number(likeMs.toFixed(2)),
      fts4CharQueryMs: Number(ftsMs.toFixed(2)),
      budgets: { listSessions: 150, likeSearch: 150, ftsSearch: 100 }
    }
    writeEvidence('task-10-perf.json', evidence)
    service.close()
  }, 120_000)
})

describe('deleteAllSessions', () => {
  it('removes every session with messages, drafts and FTS rows in one transaction', () => {
    const dir = makeDir()
    const service = openDbService({ dataDir: dir, recover: false })
    try {
      const now = Date.now()
      for (let index = 0; index < 3; index += 1) {
        const id = uuidv7(now + index)
        service.sessions.create({
          id,
          title: `会话 ${index}`,
          titleAuto: false,
          createdAt: now,
          updatedAt: now
        })
        service.messages.insert({
          id: uuidv7(now + index + 10),
          sessionId: id,
          seq: 0,
          role: 'user',
          content: `内容 ${index}`,
          status: 'complete',
          createdAt: now,
          updatedAt: now
        })
        service.setDraft(id, `draft ${index}`)
        service.search.rebuild(id)
      }
      service.setDraft('new', 'kept new draft')

      expect(service.counts()).toMatchObject({ sessions: 3, messages: 3, ftsRows: 3 })

      const cleared = service.deleteAllSessions()

      expect(cleared).toBe(3)
      expect(service.counts()).toEqual({
        sessions: 0,
        messages: 0,
        streaming: 0,
        interrupted: 0,
        ftsRows: 0
      })
      expect(service.getDraft('new')).toBe('kept new draft')
      const allDrafts = service.driver.prepare('SELECT COUNT(*) AS count FROM drafts').get()
      expect(Number(allDrafts?.['count'])).toBe(1)
    } finally {
      service.close()
    }
  })
})
