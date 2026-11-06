#!/usr/bin/env node
/**
 * Independent SQL timing for the 1000-session acceptance run.
 *
 * Opens the seeded DB through the production `openDbService` path (real
 * SessionsRepository / SearchRepository, same SQL as the app) and records raw
 * per-iteration milliseconds for:
 *   - list 50 sessions (ORDER BY updated_at DESC)
 *   - 2-char LIKE search ("报错")
 *   - 4-char FTS5 trigram search ("虚拟列表")
 *
 * Usage:
 *   node tools/measure-history-1000.mjs [dataDir] [outJson]
 *
 * Defaults:
 *   dataDir = .omo/evidence/m1/history-1000-data
 *   outJson = .omo/evidence/m1/history-1000-sql.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

function suppressExperimentalWarnings() {
  const original = process.emitWarning
  process.emitWarning = function (warning, ...args) {
    const text = typeof warning === 'string' ? warning : warning?.message
    if (
      typeof text === 'string' &&
      (text.includes('SQLite is an experimental feature') ||
        text.includes('MODULE_TYPELESS_PACKAGE_JSON') ||
        text.includes('Reparsing as ES module'))
    ) {
      return
    }
    return original.call(this, warning, ...args)
  }
}

suppressExperimentalWarnings()

const dataDir = resolve(process.argv[2] ?? '.omo/evidence/m1/history-1000-data')
const outJson = resolve(process.argv[3] ?? '.omo/evidence/m1/history-1000-sql.json')
const WARMUP = 3
const ITERATIONS = 30

// Vite resolves the production TS modules (extensionless imports included).
const { createServer } = await import('vite')
const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  configFile: false,
  logLevel: 'error'
})
const { openDbService } = await vite.ssrLoadModule('/src/main/db/index.ts')

function percentile(sorted, value) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0
}

function round(value) {
  return Number(value.toFixed(4))
}

function measure(label, fn, iterations = ITERATIONS) {
  for (let i = 0; i < WARMUP; i += 1) fn()
  const rawMs = []
  let lastRows
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint()
    lastRows = fn()
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    rawMs.push(round(ms))
  }
  const sorted = [...rawMs].sort((a, b) => a - b)
  return {
    label,
    iterations,
    rawMs,
    minMs: round(sorted[0] ?? 0),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    rows: Array.isArray(lastRows) ? lastRows.length : null
  }
}

const startedAt = new Date().toISOString()
const service = openDbService({ dataDir, recover: false })

try {
  const counts = service.counts()
  const ftsCheck = service.driver
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_search'")
    .get()

  const list50 = measure('list50', () => service.listSessions({ limit: 50 }))
  const like2char = measure('like2char_报错_limit50', () => service.searchSessions('报错', 50))
  const fts4char = measure('fts4char_虚拟列表_limit50', () => service.searchSessions('虚拟列表', 50))

  // Same queries at the E2E limit (1000) so the SQL numbers can be compared
  // with the renderer-side dbMs in search-cjk.json.
  const like2char1000 = measure('like2char_报错_limit1000', () =>
    service.searchSessions('报错', 1000)
  )
  const fts4char1000 = measure('fts4char_虚拟列表_limit1000', () =>
    service.searchSessions('虚拟列表', 1000)
  )

  const listPlan = service.driver
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT id, title, updated_at, last_message_at, model
         FROM sessions
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ? OFFSET ?`
    )
    .all(50, 0)
  const likePlan = service.driver
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT s.id, s.title, s.updated_at, s.last_message_at, s.model
         FROM sessions s
        WHERE s.title LIKE ? ESCAPE '\\'
           OR EXISTS (
                SELECT 1
                  FROM messages m
                 WHERE m.session_id = s.id
                   AND m.content LIKE ? ESCAPE '\\'
              )
        ORDER BY s.updated_at DESC, s.created_at DESC
        LIMIT ? OFFSET ?`
    )
    .all('%报错%', '%报错%', 50, 0)
  const ftsPlan = service.driver
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT s.id, s.title, s.updated_at, s.last_message_at, s.model
         FROM session_search f
         JOIN sessions s ON s.id = f.session_id
        WHERE session_search MATCH ?
        ORDER BY s.updated_at DESC, s.created_at DESC
        LIMIT ? OFFSET ?`
    )
    .all('"虚拟列表"', 50, 0)

  const evidence = {
    tool: 'measure-history-1000',
    startedAt,
    dataDir,
    db: `${dataDir}/quickask.db`,
    counts,
    ftsTable: ftsCheck ? String(ftsCheck.sql ?? '') : null,
    warmupIterations: WARMUP,
    measuredIterations: ITERATIONS,
    list50,
    like2char,
    fts4char,
    'like2char_limit1000': like2char1000,
    'fts4char_limit1000': fts4char1000,
    budgetsMs: { listSessions50: 150, like2char: 150, fts4char: 100 },
    verdicts: {
      listSessions50: list50.p95Ms < 150 ? 'PASS' : 'FAIL',
      like2char: like2char.p95Ms < 150 ? 'PASS' : 'FAIL',
      fts4char: fts4char.p95Ms < 100 ? 'PASS' : 'FAIL'
    },
    queryPlans: {
      list50: listPlan,
      like2char: likePlan,
      fts4char: ftsPlan
    }
  }

  mkdirSync(dirname(outJson), { recursive: true })
  writeFileSync(outJson, `${JSON.stringify(evidence, null, 2)}\n`)

  console.log(`db: ${evidence.db}`)
  console.log(`counts: ${JSON.stringify(counts)}`)
  for (const sample of [list50, like2char, fts4char, like2char1000, fts4char1000]) {
    console.log(
      `${sample.label}: n=${sample.rows} p50=${sample.p50Ms}ms p95=${sample.p95Ms}ms max=${sample.maxMs}ms raw=${JSON.stringify(sample.rawMs)}`
    )
  }
  console.log(`verdicts: ${JSON.stringify(evidence.verdicts)}`)
  console.log(`wrote ${outJson}`)
} finally {
  service.close()
  await vite.close()
}
