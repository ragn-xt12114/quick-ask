#!/usr/bin/env node
/**
 * Task 11 — real OS-keyring round-trip evidence.
 *
 * Uses @napi-rs/keyring pinned to the Secret Service store (no silent
 * keyutils fallback). Runs set/get/delete N times (default 5), verifies the
 * entry is gone afterwards, and writes a JSON report containing only SHA-256
 * fingerprints — never the secret itself.
 *
 * Usage:
 *   node tools/keyring-check.mjs --runs 5 --out .omo/evidence/task-11-keyring.json
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { runs: 5, out: resolve(projectRoot, '.omo/evidence/task-11-keyring.json') }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--runs') args.runs = Number(argv[++i])
    else if (argv[i] === '--out') args.out = resolve(projectRoot, argv[++i])
    else if (argv[i] === '--help') {
      console.log('usage: node tools/keyring-check.mjs [--runs N] [--out PATH]')
      process.exit(0)
    }
  }
  if (!Number.isInteger(args.runs) || args.runs < 1 || args.runs > 20) {
    throw new Error('--runs must be an integer 1..20')
  }
  return args
}

function fingerprint(secret) {
  return `sha256:${createHash('sha256').update(secret).digest('hex')}`
}

function describeError(error) {
  if (!error) return null
  return {
    name: error.name ?? 'Error',
    code: error.code ?? null,
    message: String(error.message ?? error).replace(/\s+/g, ' ').slice(0, 200)
  }
}

function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

const SERVICE = 'quickask-task11-test'
const ACCOUNT = 'provider:task11:api_key'
const ENTRY_OPTIONS = { linux: { store: 'secret-service' } }

const args = parseArgs(process.argv.slice(2))
const startedAt = new Date().toISOString()

let Entry
let moduleVersion = null
try {
  ;({ Entry } = require('@napi-rs/keyring'))
  moduleVersion = require('@napi-rs/keyring/package.json').version
} catch (error) {
  const report = {
    schema_version: 1,
    generated_at: startedAt,
    task: 'task-11',
    status: 'FAIL',
    error: describeError(error)
  }
  writeJsonAtomic(args.out, report)
  console.error(JSON.stringify(report))
  process.exit(2)
}

const report = {
  schema_version: 1,
  generated_at: startedAt,
  task: 'task-11',
  module: '@napi-rs/keyring',
  module_version: moduleVersion,
  node_version: process.versions.node,
  electron_version: process.versions.electron ?? null,
  service: SERVICE,
  account: ACCOUNT,
  entry_options: ENTRY_OPTIONS,
  dbus_session_bus_present: Boolean(process.env.DBUS_SESSION_BUS_ADDRESS),
  xdg_current_desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
  runs_requested: args.runs,
  success: 0,
  rounds: [],
  fingerprints: [],
  final_delete_returned: null,
  final_get_after_delete: null,
  cleanup_error: null,
  status: 'FAIL'
}

let entry = null
try {
  entry = new Entry(SERVICE, ACCOUNT, ENTRY_OPTIONS)
  try {
    entry.deletePassword()
  } catch {
    // stale entry cleanup is best-effort
  }

  for (let round = 1; round <= args.runs; round += 1) {
    const secret = randomBytes(32).toString('hex')
    const detail = {
      round,
      fingerprint: fingerprint(secret),
      set_ok: false,
      get_matches: false,
      delete_returned: null,
      after_delete_null: false,
      error: null
    }

    try {
      entry.setPassword(secret)
      detail.set_ok = true
      const value = entry.getPassword()
      detail.get_matches = value === secret
      detail.delete_returned = entry.deletePassword()
      try {
        detail.after_delete_null = entry.getPassword() === null
      } catch {
        detail.after_delete_null = true
      }
      if (detail.set_ok && detail.get_matches && detail.after_delete_null) {
        report.success += 1
      }
    } catch (error) {
      detail.error = describeError(error)
    }

    report.rounds.push(detail)
    report.fingerprints.push(detail.fingerprint)
  }
} catch (error) {
  report.fatal_error = describeError(error)
} finally {
  try {
    if (entry) {
      report.final_delete_returned = entry.deletePassword()
      try {
        report.final_get_after_delete = entry.getPassword()
      } catch {
        report.final_get_after_delete = null
      }
    }
  } catch (error) {
    report.cleanup_error = describeError(error)
  }
}

const cleanupOk = report.final_get_after_delete === null
report.success = Math.min(report.success, args.runs)
report.status = report.success === args.runs && cleanupOk ? 'PASS' : 'FAIL'
report.summary = {
  keyring_round_trip: `${report.success}/${args.runs}`,
  entry_deleted: cleanupOk
}
report.finished_at = new Date().toISOString()

writeJsonAtomic(args.out, report)
console.log(
  JSON.stringify({
    status: report.status,
    keyring_round_trip: report.summary.keyring_round_trip,
    entry_deleted: cleanupOk,
    out: args.out
  })
)
process.exit(report.status === 'PASS' ? 0 : 1)
