'use strict'

/**
 * Task 8 / G10 — Electron app-path redirection spike.
 *
 * Proves that userData, sessionData, logs and crashDumps can all be redirected
 * into a project-local directory (QUICKASK_DATA_DIR) before `app.ready`, and
 * that each path really receives a marker file. Exits 0 on success.
 *
 * Usage:
 *   ./node_modules/.bin/electron spike/paths.cjs
 *   QUICKASK_DATA_DIR=/tmp/quickask-paths ./node_modules/.bin/electron spike/paths.cjs
 */

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const names = ['userData', 'sessionData', 'logs', 'crashDumps']
const dataDir = process.env.QUICKASK_DATA_DIR
  ? path.resolve(process.env.QUICKASK_DATA_DIR)
  : path.join(process.cwd(), '.runtime', 'data')

function safeGet(name) {
  try {
    return { ok: true, value: app.getPath(name) }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

const defaults = {}
for (const name of names) defaults[name] = safeGet(name)
const cacheDefault = safeGet('cache')

const targets = {
  userData: path.join(dataDir, 'userData'),
  sessionData: path.join(dataDir, 'sessionData'),
  logs: path.join(dataDir, 'logs'),
  crashDumps: path.join(dataDir, 'crashDumps')
}

for (const [name, dir] of Object.entries(targets)) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  app.setPath(name, dir)
}

const result = {
  task: 8,
  spike: 'electron-app-paths',
  pid: process.pid,
  cwd: process.cwd(),
  dataDir,
  env: {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || null,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME || null,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || null
  },
  defaults,
  cacheDefault,
  requested: targets,
  actual: {},
  markers: {},
  ok: false
}

app.whenReady().then(() => {
  try {
    for (const name of names) {
      result.actual[name] = safeGet(name)
    }
    result.actual.cache = safeGet('cache')

    for (const [name, dir] of Object.entries(targets)) {
      const marker = path.join(dir, `marker-${process.pid}.txt`)
      fs.writeFileSync(
        marker,
        `quickask paths spike pid=${process.pid} name=${name} dir=${dir} ts=${new Date().toISOString()}\n`,
        { mode: 0o600 }
      )
      result.markers[name] = { path: marker, exists: fs.existsSync(marker) }
    }

    const redirected = names.every((name) => {
      const actual = result.actual[name]
      return actual && actual.ok && path.resolve(actual.value) === path.resolve(targets[name])
    })
    const markersWritten = Object.values(result.markers).every((m) => m.exists)
    result.ok = redirected && markersWritten

    const outPath = process.env.QUICKASK_PATHS_OUT
      ? path.resolve(process.env.QUICKASK_PATHS_OUT)
      : null
    const text = JSON.stringify(result, null, 2) + '\n'
    if (outPath) fs.writeFileSync(outPath, text)
    process.stdout.write(text)
    app.exit(result.ok ? 0 : 1)
  } catch (error) {
    result.error = String(error && error.stack ? error.stack : error)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    app.exit(2)
  }
})

// Defensive: if app.ready never fires (headless misconfiguration), fail loudly.
setTimeout(() => {
  process.stderr.write('paths spike: timed out waiting for app.ready\n')
  app.exit(3)
}, 15000).unref()
