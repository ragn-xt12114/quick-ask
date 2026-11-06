#!/usr/bin/env node
/**
 * Read-only SQLite inspector for QuickAsk acceptance checks.
 *
 * Uses Node's built-in node:sqlite (DatabaseSync) because there is no sqlite3
 * CLI in this environment and the app deliberately avoids better-sqlite3.
 *
 * Usage:
 *   node tools/db-query.mjs --db <path> --count-user-messages
 *   node tools/db-query.mjs --db <path> --last-status
 *   node tools/db-query.mjs --db <path> --integrity
 *   node tools/db-query.mjs --db <path> --count-sessions
 *   node tools/db-query.mjs --db <path> --list-sessions [--limit 20]
 *   node tools/db-query.mjs --db <path> --recover-check
 *   node tools/db-query.mjs --db <path> --fts-check
 *   node tools/db-query.mjs --db <path> --schema-version
 *   node tools/db-query.mjs --help
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const HELP = `Usage: node tools/db-query.mjs --db <path> <action> [<action>...]

Read-only SQLite inspector for QuickAsk databases (node:sqlite).

Actions:
  --count-user-messages   Print the number of messages with role='user'.
  --last-status           Print the newest message row as JSON.
  --integrity             Run PRAGMA integrity_check; exit 1 unless it returns "ok".
  --count-sessions        Print the number of sessions.
  --list-sessions         Print recent sessions as a JSON array.
  --recover-check         Count streaming/interrupted messages as JSON; exit 1 if streaming>0.
  --fts-check             Print FTS5/trigram/table status as JSON.
  --schema-version        Print PRAGMA user_version.
  -h, --help              Show this help and exit.

Options:
  --db <path>             Path to quickask.db (required).
  --limit <n>             Max rows for --list-sessions (default 20).

Exit codes: 0 success, 1 query/integrity/check failure, 2 missing/unopenable DB.
`

function fail(message) {
  process.stderr.write(`db-query: ${message}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const opts = {
    db: null,
    limit: 20,
    countUserMessages: false,
    lastStatus: false,
    integrity: false,
    countSessions: false,
    listSessions: false,
    recoverCheck: false,
    ftsCheck: false,
    schemaVersion: false,
    help: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true
        break
      case '--db':
        i += 1
        if (i >= argv.length || argv[i].startsWith('-')) fail('--db requires a path')
        opts.db = argv[i]
        break
      case '--limit':
        i += 1
        if (i >= argv.length || !/^\d+$/.test(argv[i])) fail('--limit requires an integer')
        opts.limit = Number(argv[i])
        break
      case '--count-user-messages':
        opts.countUserMessages = true
        break
      case '--last-status':
        opts.lastStatus = true
        break
      case '--integrity':
        opts.integrity = true
        break
      case '--count-sessions':
        opts.countSessions = true
        break
      case '--list-sessions':
        opts.listSessions = true
        break
      case '--recover-check':
        opts.recoverCheck = true
        break
      case '--fts-check':
        opts.ftsCheck = true
        break
      case '--schema-version':
        opts.schemaVersion = true
        break
      default:
        fail(`unknown argument: ${arg}`)
    }
  }

  return opts
}

function printHelp() {
  process.stdout.write(HELP)
}

const ACTIONS = [
  'countUserMessages',
  'lastStatus',
  'integrity',
  'countSessions',
  'listSessions',
  'recoverCheck',
  'ftsCheck',
  'schemaVersion'
]

function countUserMessages(db) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'user'").get()
  process.stdout.write(`${Number(row.count)}\n`)
}

function lastStatus(db) {
  const row = db
    .prepare(
      `SELECT id, session_id, seq, role, status, error_code, error_detail, created_at, updated_at
         FROM messages
        ORDER BY created_at DESC, seq DESC
        LIMIT 1`
    )
    .get()

  if (!row) {
    process.stdout.write('NO_MESSAGES\n')
    return
  }

  process.stdout.write(`${JSON.stringify(row)}\n`)
}

function integrityCheck(db) {
  const rows = db.prepare('PRAGMA integrity_check').all()
  const results = rows.map((row) => String(Object.values(row)[0]))
  process.stdout.write(`${results.join('\n')}\n`)
  if (!(results.length === 1 && results[0] === 'ok')) {
    process.exitCode = 1
  }
}

function countSessions(db) {
  const row = db.prepare('SELECT COUNT(*) AS count FROM sessions').get()
  process.stdout.write(`${Number(row.count)}\n`)
}

function listSessions(db, limit) {
  const rows = db
    .prepare(
      `SELECT id, title, updated_at, last_message_at, model
         FROM sessions
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?`
    )
    .all(limit)
  const sessions = rows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: Number(row.updated_at),
    lastMessageAt: row.last_message_at === null ? null : Number(row.last_message_at),
    model: row.model ?? null
  }))
  process.stdout.write(`${JSON.stringify(sessions)}\n`)
}

function recoverCheck(db) {
  const streaming = Number(
    db.prepare("SELECT COUNT(*) AS count FROM messages WHERE status = 'streaming'").get().count
  )
  const interrupted = Number(
    db.prepare("SELECT COUNT(*) AS count FROM messages WHERE status = 'interrupted'").get().count
  )
  process.stdout.write(`${JSON.stringify({ streaming, interrupted })}\n`)
  if (streaming > 0) process.exitCode = 1
}

function ftsCheck(db) {
  const compileOptions = db
    .prepare('PRAGMA compile_options')
    .all()
    .map((row) => String(Object.values(row)[0]))
  const fts5 = compileOptions.some((option) => option.toUpperCase() === 'ENABLE_FTS5')

  let trigram = false
  try {
    db.exec("CREATE VIRTUAL TABLE temp.__dbq_fts_probe USING fts5(x, tokenize='trigram')")
    db.exec('DROP TABLE IF EXISTS temp.__dbq_fts_probe')
    trigram = true
  } catch {
    try {
      db.exec('DROP TABLE IF EXISTS temp.__dbq_fts_probe')
    } catch {
      // ignore
    }
  }

  const tableRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_search'")
    .get()
  const table = tableRow !== undefined
  const tableSql = tableRow ? String(tableRow.sql ?? '') : ''
  const tableTrigram = /tokenize\s*=\s*['"]trigram['"]/i.test(tableSql)

  const result = {
    fts5,
    trigram: trigram || tableTrigram,
    table,
    tableTokenize: tableTrigram ? 'trigram' : null
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.fts5 || !result.trigram || !result.table) {
    process.exitCode = 1
  }
}

function schemaVersion(db) {
  const row = db.prepare('PRAGMA user_version').get()
  process.stdout.write(`${Number(Object.values(row)[0])}\n`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.help) {
    printHelp()
    return
  }

  if (!opts.db) fail('--db <path> is required (see --help)')
  if (!ACTIONS.some((action) => opts[action])) {
    fail('no action specified (see --help)')
  }

  const dbPath = resolve(opts.db)
  if (!existsSync(dbPath)) {
    process.stderr.write(`db-query: DB_NOT_FOUND: ${dbPath}\n`)
    process.exit(2)
  }

  const originalEmitWarning = process.emitWarning
  process.emitWarning = function (warning, ...args) {
    const text = typeof warning === 'string' ? warning : warning?.message
    if (typeof text === 'string' && text.includes('SQLite is an experimental feature')) return
    return originalEmitWarning.call(this, warning, ...args)
  }

  const { DatabaseSync } = await import('node:sqlite')

  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    process.stderr.write(`db-query: DB_OPEN_FAILED: ${dbPath}: ${error.message}\n`)
    process.exit(2)
  }

  try {
    if (opts.countUserMessages) countUserMessages(db)
    if (opts.lastStatus) lastStatus(db)
    if (opts.integrity) integrityCheck(db)
    if (opts.countSessions) countSessions(db)
    if (opts.listSessions) listSessions(db, Math.max(1, opts.limit))
    if (opts.recoverCheck) recoverCheck(db)
    if (opts.ftsCheck) ftsCheck(db)
    if (opts.schemaVersion) schemaVersion(db)
  } catch (error) {
    process.stderr.write(`db-query: QUERY_FAILED: ${error.message}\n`)
    process.exitCode = 1
  } finally {
    db.close()
  }
}

await main()
