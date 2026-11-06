#!/usr/bin/env node
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EVID = path.join(ROOT, '.omo', 'evidence', 'm1')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const RUNTIME = path.join(ROOT, '.runtime', `nfr-m1-${STAMP}`)
const ELECTRON_BIN = path.join(ROOT, 'node_modules', '.bin', 'electron')
const DISPLAY = ':0'
const CACHE_HOME = path.join(ROOT, '.cache', 'xdg')
const FOCUS_RUNS = 20
const SHOW_RUNS = 20
const COLD_RUNS = 10
const FOCUS_THRESHOLD_MS = 150
const COLD_THRESHOLD_MS = 2000
const SHOW_THRESHOLD_MS = 50
const SAMPLE_TIMEOUT_MS = 5000
const COLD_TIMEOUT_MS = 15000

fs.mkdirSync(EVID, { recursive: true })
fs.mkdirSync(RUNTIME, { recursive: true })
fs.mkdirSync(CACHE_HOME, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function percentile(values, p) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (clean.length === 0) return null
  const rank = Math.ceil((p / 100) * clean.length)
  return clean[Math.min(clean.length - 1, Math.max(0, rank - 1))]
}

function stats(values) {
  const clean = values.filter((value) => Number.isFinite(value))
  if (clean.length === 0) return { n: 0, p50: null, p95: null, max: null, min: null, mean: null }
  const total = clean.reduce((sum, value) => sum + value, 0)
  return {
    n: clean.length,
    p50: percentile(clean, 50),
    p95: percentile(clean, 95),
    max: Math.max(...clean),
    min: Math.min(...clean),
    mean: Math.round((total / clean.length) * 100) / 100
  }
}

function rel(file) {
  return path.relative(ROOT, file)
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function mkdirs(base) {
  for (const name of ['config', 'data', 'data/quickask-db', 'state']) {
    fs.mkdirSync(path.join(base, name), { recursive: true })
  }
}

function envFor(base) {
  return {
    ...process.env,
    DISPLAY,
    XDG_CONFIG_HOME: path.join(base, 'config'),
    XDG_DATA_HOME: path.join(base, 'data'),
    XDG_STATE_HOME: path.join(base, 'state'),
    XDG_CACHE_HOME: CACHE_HOME,
    QUICKASK_DATA_DIR: path.join(base, 'data', 'quickask-db'),
    QUICKASK_DISABLE_ONBOARDING: '1'
  }
}

function logPathFor(env) {
  return path.join(env.XDG_STATE_HOME, 'quickask', 'logs', 'quickask.log')
}

function runXdotool(keys) {
  return execFileSync('xdotool', ['key', '--clearmodifiers', keys], {
    env: { ...process.env, DISPLAY },
    encoding: 'utf8',
    timeout: SAMPLE_TIMEOUT_MS
  })
}

function readLogRecords(logPath) {
  let text
  try {
    text = fs.readFileSync(logPath, 'utf8')
  } catch {
    return []
  }
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      continue
    }
  }
  return records
}

function readLogChunk(logPath, offset) {
  let buffer
  try {
    buffer = fs.readFileSync(logPath)
  } catch {
    return { records: [], offset: 0 }
  }
  const start = buffer.length < offset ? 0 : offset
  const text = buffer.subarray(start).toString('utf8')
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      continue
    }
  }
  return { records, offset: buffer.length }
}

function isoMs(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function delta(later, earlier) {
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return null
  return Math.round((later - earlier) * 1000) / 1000
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`)
}

async function waitMode(page, mode, timeout = SAMPLE_TIMEOUT_MS) {
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
      expected,
    mode,
    { timeout }
  )
}

async function installProbe(page) {
  await page.evaluate(() => {
    window.__qaFocus = null
    document.addEventListener(
      'focusin',
      (event) => {
        const target = event.target
        if (
          !(target instanceof HTMLElement) ||
          !target.closest('[data-testid="composer"]')
        ) {
          return
        }
        const record = { focusTs: Date.now(), rafTs: null, rafPerfTs: null }
        window.__qaFocus = record
        requestAnimationFrame((perfTs) => {
          record.rafPerfTs = perfTs
          record.rafTs = Date.now()
        })
      },
      true
    )
  })
}

async function clearProbe(page) {
  await page.evaluate(() => {
    window.__qaFocus = null
  })
}

async function probeValue(page) {
  const handle = await page.waitForFunction(
    () => (window.__qaFocus && window.__qaFocus.rafTs ? window.__qaFocus : null),
    undefined,
    { timeout: SAMPLE_TIMEOUT_MS }
  )
  return handle.jsonValue()
}

async function activeTestId(page) {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)
}

async function hideFallback(page) {
  try {
    await page.evaluate(() => window.quickask?.window.hide())
  } catch {
    return false
  }
  try {
    await waitMode(page, 'S0', SAMPLE_TIMEOUT_MS)
    return true
  } catch {
    return false
  }
}

async function cycle(page, logPath, phase, run) {
  let hotkeyError = null
  let hideError = null
  let s1Seen = null
  let focus = null
  let active = null
  let appRecords = []

  await waitMode(page, 'S0')
  await sleep(120)
  await clearProbe(page)

  const logOffset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0
  const t0 = Date.now()
  const xdotoolStart = Date.now()
  try {
    runXdotool('ctrl+alt+space')
  } catch (error) {
    hotkeyError = error instanceof Error ? error.message : String(error)
  }
  const xdotoolEnd = Date.now()

  if (hotkeyError === null) {
    try {
      await waitMode(page, 'S1')
      s1Seen = Date.now()
      focus = await probeValue(page)
      active = await activeTestId(page)
    } catch (error) {
      hotkeyError = error instanceof Error ? error.message : String(error)
    }
  }

  const chunk = readLogChunk(logPath, logOffset)
  appRecords = chunk.records
  const hotkeyRecord = [...appRecords].reverse().find((record) => record.event === 'hotkey_received')
  const hotkeyTs = hotkeyRecord ? isoMs(hotkeyRecord.ts) : null
  const stateRecord = hotkeyTs
    ? appRecords.find(
        (record) =>
          record.event === 'window_state' &&
          record.mode === 'S1' &&
          record.visible === true &&
          isoMs(record.ts) !== null &&
          isoMs(record.ts) >= hotkeyTs
      )
    : null
  const stateTs = stateRecord ? isoMs(stateRecord.ts) : null

  let hideSeen = null
  try {
    runXdotool('Escape')
    await waitMode(page, 'S0')
    hideSeen = Date.now()
  } catch (error) {
    hideError = error instanceof Error ? error.message : String(error)
    const recovered = await hideFallback(page)
    if (!recovered) hideError += ' (fallback hide failed)'
  }
  await sleep(60)

  const sample = {
    phase,
    run,
    t0_ms: t0,
    xdotool_duration_ms: delta(xdotoolEnd, xdotoolStart),
    driver_s1_ms: delta(s1Seen, t0),
    driver_focus_ms: focus ? delta(focus.focusTs, t0) : null,
    driver_raf_ms: focus ? delta(focus.rafTs, t0) : null,
    app_hotkey_received_ts: hotkeyRecord?.ts ?? null,
    app_window_state_s1_ts: stateRecord?.ts ?? null,
    app_show_state_ms: delta(stateTs, hotkeyTs),
    app_focus_ms: focus ? delta(focus.focusTs, hotkeyTs) : null,
    app_raf_ms: focus ? delta(focus.rafTs, hotkeyTs) : null,
    focus_ts: focus?.focusTs ?? null,
    raf_ts: focus?.rafTs ?? null,
    raf_perf_ts: focus?.rafPerfTs ?? null,
    active_testid: active,
    focus_ok: Boolean(focus && focus.rafTs && active === 'composer'),
    hide_ms: delta(hideSeen, xdotoolEnd),
    hotkey_error: hotkeyError,
    hide_error: hideError,
    app_events: appRecords.map((record) => record.event)
  }
  return sample
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function copyFile(from, to) {
  try {
    fs.copyFileSync(from, to)
  } catch {
    fs.writeFileSync(to, '')
  }
}

async function closeApp(app) {
  const proc = app.process()
  try {
    await Promise.race([app.close(), sleep(8000)])
  } catch {
    void 0
  }
  if (proc.exitCode === null) {
    try {
      proc.kill('SIGTERM')
    } catch {
      void 0
    }
    await sleep(1000)
  }
  if (proc.exitCode === null) {
    try {
      proc.kill('SIGKILL')
    } catch {
      void 0
    }
  }
}

function electronPids() {
  const result = spawnSync('pgrep', ['-x', 'electron'], { encoding: 'utf8' })
  return (result.stdout || '').trim().split('\n').filter(Boolean)
}

async function waitForNoElectron(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let pids = electronPids()
  while (pids.length > 0 && Date.now() < deadline) {
    await sleep(100)
    pids = electronPids()
  }
  return pids
}

function killGroup(child) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  const pid = child.pid
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      void 0
    }
  }
  return new Promise((resolve) => {
    const deadline = Date.now() + 3000
    const timer = setInterval(() => {
      if (child.exitCode !== null || Date.now() >= deadline) {
        clearInterval(timer)
        if (child.exitCode === null) {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            try {
              child.kill('SIGKILL')
            } catch {
              void 0
            }
          }
        }
        setTimeout(resolve, 200)
      }
    }, 50)
  })
}

async function runColdStart(run) {
  const tag = pad2(run)
  const base = path.join(RUNTIME, `cold-${tag}`)
  mkdirs(base)
  const env = envFor(base)
  const logPath = logPathFor(env)
  const stdoutRuntime = path.join(base, 'stdout.log')
  const stdoutOut = fs.createWriteStream(stdoutRuntime, { flags: 'w' })

  let trayTs = null
  let hotkeyTs = null
  let readyObserved = null
  let error = null
  const t0 = Date.now()
  const child = spawn(ELECTRON_BIN, ['.'], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => stdoutOut.write(chunk))
  child.stderr.on('data', (chunk) => stdoutOut.write(chunk))
  child.on('error', (spawnError) => {
    error = spawnError.message
  })

  while (Date.now() - t0 < COLD_TIMEOUT_MS) {
    const records = readLogRecords(logPath)
    for (const record of records) {
      const ts = isoMs(record.ts)
      if (ts === null) continue
      if (record.event === 'tray_created' && trayTs === null) trayTs = ts
      if (record.event === 'hotkey_status' && record.registered === true && hotkeyTs === null) {
        hotkeyTs = ts
      }
    }
    if (trayTs !== null && hotkeyTs !== null) {
      readyObserved = Date.now()
      break
    }
    if (child.exitCode !== null) {
      error = `app exited before ready code=${child.exitCode}`
      break
    }
    await sleep(10)
  }

  if (error === null && trayTs === null) error = `tray_created not logged within ${COLD_TIMEOUT_MS}ms`
  if (error === null && hotkeyTs === null) error = `hotkey_registered not logged within ${COLD_TIMEOUT_MS}ms`

  await killGroup(child)
  stdoutOut.end()

  const appLogOut = path.join(EVID, `nfr03-cold-${tag}-app.log`)
  const stdoutLogOut = path.join(EVID, `nfr03-cold-${tag}-stdout.log`)
  copyFile(logPath, appLogOut)
  copyFile(stdoutRuntime, stdoutLogOut)

  const sample = {
    run,
    spawn_ms: t0,
    tray_created_ms: trayTs === null ? null : Math.round(trayTs - t0),
    hotkey_registered_ms: hotkeyTs === null ? null : Math.round(hotkeyTs - t0),
    ready_ms:
      trayTs === null || hotkeyTs === null ? null : Math.round(Math.max(trayTs, hotkeyTs) - t0),
    ready_observed_ms: readyObserved === null ? null : readyObserved - t0,
    error,
    app_log: rel(appLogOut),
    stdout_log: rel(stdoutLogOut)
  }
  await sleep(250)
  return sample
}

async function main() {
  const startedAt = new Date().toISOString()
  console.log(`[nfr-m1] runtime=${rel(RUNTIME)}`)
  console.log(`[nfr-m1] evidence=${rel(EVID)}`)

  const coldSamples = []
  const coldJsonl = path.join(EVID, 'nfr03-cold-samples.jsonl')
  fs.writeFileSync(coldJsonl, '')
  for (let run = 1; run <= COLD_RUNS; run += 1) {
    const sample = await runColdStart(run)
    coldSamples.push(sample)
    appendJsonl(coldJsonl, sample)
    console.log(
      `[cold ${pad2(run)}] tray=${sample.tray_created_ms}ms hotkey=${sample.hotkey_registered_ms}ms ready=${sample.ready_ms}ms error=${sample.error ?? 'none'}`
    )
  }
  const coldTray = stats(coldSamples.map((sample) => sample.tray_created_ms))
  const coldReady = stats(coldSamples.map((sample) => sample.ready_ms))
  const coldSuccess = coldSamples.filter(
    (sample) =>
      sample.error === null &&
      Number.isFinite(sample.tray_created_ms) &&
      sample.tray_created_ms <= COLD_THRESHOLD_MS
  ).length
  const coldPass = coldSuccess === COLD_RUNS && coldTray.p95 <= COLD_THRESHOLD_MS

  const showBase = path.join(RUNTIME, 'show')
  mkdirs(showBase)
  const showEnv = envFor(showBase)
  const showLogPath = logPathFor(showEnv)
  const showStdout = []
  const app = await electron.launch({ args: ['.'], cwd: ROOT, env: showEnv, timeout: 60000 })
  const proc = app.process()
  proc.stdout?.on('data', (chunk) => showStdout.push(chunk.toString()))
  proc.stderr?.on('data', (chunk) => showStdout.push(chunk.toString()))
  const page = await app.firstWindow({ timeout: 30000 })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.quickask))

  const initial = await page.evaluate(async () => {
    const state = await window.quickask.window.getState()
    const bootstrap = await window.quickask.app.bootstrap()
    return {
      state: state.ok ? state.data : null,
      onboarding: bootstrap.ok ? bootstrap.data.onboarding : null
    }
  })
  if (!initial.state || initial.state.mode !== 'S0' || initial.state.visible !== false) {
    throw new Error(`app did not start hidden: ${JSON.stringify(initial.state)}`)
  }
  if (initial.onboarding && initial.onboarding.required) {
    throw new Error(`onboarding unexpectedly required: ${JSON.stringify(initial.onboarding)}`)
  }
  console.log(
    `[show] pid=${proc.pid} initial_mode=${initial.state.mode} visible=${initial.state.visible} onboarding_required=${initial.onboarding?.required ?? 'unknown'}`
  )

  await installProbe(page)

  const focusSamples = []
  const focusJsonl = path.join(EVID, 'nfr01-samples.jsonl')
  fs.writeFileSync(focusJsonl, '')
  for (let run = 1; run <= FOCUS_RUNS; run += 1) {
    const sample = await cycle(page, showLogPath, 'nfr01', run)
    focusSamples.push(sample)
    appendJsonl(focusJsonl, sample)
    console.log(
      `[nfr01 ${pad2(run)}] driver_focus=${sample.driver_focus_ms}ms driver_raf=${sample.driver_raf_ms}ms app_focus=${sample.app_focus_ms}ms app_raf=${sample.app_raf_ms}ms focus_ok=${sample.focus_ok} error=${sample.hotkey_error ?? sample.hide_error ?? 'none'}`
    )
  }
  const nfr01Log = path.join(EVID, 'nfr01-app.log')
  copyFile(showLogPath, nfr01Log)

  const showSamples = []
  const showJsonl = path.join(EVID, 'nfr03-show-samples.jsonl')
  fs.writeFileSync(showJsonl, '')
  for (let run = 1; run <= SHOW_RUNS; run += 1) {
    const sample = await cycle(page, showLogPath, 'nfr03-show', run)
    showSamples.push(sample)
    appendJsonl(showJsonl, sample)
    console.log(
      `[nfr03-show ${pad2(run)}] driver_s1=${sample.driver_s1_ms}ms driver_raf=${sample.driver_raf_ms}ms app_show=${sample.app_show_state_ms}ms app_raf=${sample.app_raf_ms}ms error=${sample.hotkey_error ?? sample.hide_error ?? 'none'}`
    )
  }
  const nfr03ShowLog = path.join(EVID, 'nfr03-show-app.log')
  copyFile(showLogPath, nfr03ShowLog)
  fs.writeFileSync(path.join(EVID, 'nfr-m1-playwright-stdout.log'), showStdout.join(''))

  const focusSuccess = focusSamples.filter((sample) => sample.focus_ok).length
  const appFocus = stats(focusSamples.map((sample) => sample.app_focus_ms))
  const appRaf = stats(focusSamples.map((sample) => sample.app_raf_ms))
  const driverFocus = stats(focusSamples.map((sample) => sample.driver_focus_ms))
  const driverRaf = stats(focusSamples.map((sample) => sample.driver_raf_ms))
  const xdotoolStats = stats(focusSamples.map((sample) => sample.xdotool_duration_ms))
  const nfr01Pass =
    focusSuccess === FOCUS_RUNS &&
    Number.isFinite(appFocus.p95) &&
    appFocus.p95 <= FOCUS_THRESHOLD_MS

  const nfr01 = {
    nfr: 'NFR-01',
    generated_at: new Date().toISOString(),
    environment: {
      display: DISPLAY,
      app_entry: rel(ROOT) || '.',
      electron: rel(ELECTRON_BIN),
      runtime: rel(RUNTIME),
      onboarding_disabled: 'QUICKASK_DISABLE_ONBOARDING=1',
      threshold_ms: FOCUS_THRESHOLD_MS
    },
    runs: FOCUS_RUNS,
    focus_success: focusSuccess,
    focus_success_ratio: `${focusSuccess}/${FOCUS_RUNS}`,
    focus_p50_ms: appFocus.p50,
    focus_p95_ms: appFocus.p95,
    focus_max_ms: appFocus.max,
    raf_p95_ms: appRaf.p95,
    driver_focus_p95_ms: driverFocus.p95,
    driver_raf_p95_ms: driverRaf.p95,
    xdotool_p95_ms: xdotoolStats.p95,
    stats: { app_focus: appFocus, app_raf: appRaf, driver_focus: driverFocus, driver_raf: driverRaf },
    metric:
      'app-side: hotkey_received log ts -> renderer composer focusin (ms) and next requestAnimationFrame epoch ts; driver-side t0 immediately before xdotool -> same renderer timestamps is reported separately',
    pass: nfr01Pass,
    samples: focusSamples
  }
  writeJson(path.join(EVID, 'nfr01.json'), nfr01)

  const appShow = stats(showSamples.map((sample) => sample.app_show_state_ms))
  const showAppRaf = stats(showSamples.map((sample) => sample.app_raf_ms))
  const driverShowS1 = stats(showSamples.map((sample) => sample.driver_s1_ms))
  const showDriverRaf = stats(showSamples.map((sample) => sample.driver_raf_ms))
  const showValid = showSamples.filter(
    (sample) => sample.hotkey_error === null && sample.focus_ok
  ).length
  const showPass =
    showValid === SHOW_RUNS &&
    Number.isFinite(appShow.p95) &&
    appShow.p95 <= SHOW_THRESHOLD_MS

  const nfr03 = {
    nfr: 'NFR-03',
    generated_at: new Date().toISOString(),
    environment: {
      display: DISPLAY,
      app_entry: rel(ROOT) || '.',
      electron: rel(ELECTRON_BIN),
      runtime: rel(RUNTIME),
      onboarding_disabled: 'QUICKASK_DISABLE_ONBOARDING=1',
      cold_threshold_ms: COLD_THRESHOLD_MS,
      show_threshold_ms: SHOW_THRESHOLD_MS
    },
    cold_start: {
      runs: COLD_RUNS,
      p50_ms: coldTray.p50,
      p95_ms: coldTray.p95,
      max_ms: coldTray.max,
      min_ms: coldTray.min,
      ready_p95_ms: coldReady.p95,
      success: coldSuccess,
      success_ratio: `${coldSuccess}/${COLD_RUNS}`,
      threshold_ms: COLD_THRESHOLD_MS,
      metric:
        'spawn(node_modules/.bin/electron .) wall clock start -> $XDG_STATE_HOME/quickask/logs/quickask.log tray_created ts; ready also requires hotkey_status.registered=true',
      pass: coldPass,
      samples: coldSamples
    },
    show: {
      runs: SHOW_RUNS,
      p50_ms: appShow.p50,
      p95_ms: appShow.p95,
      max_ms: appShow.max,
      min_ms: appShow.min,
      app_raf_p95_ms: showAppRaf.p95,
      driver_s1_p95_ms: driverShowS1.p95,
      driver_raf_p95_ms: showDriverRaf.p95,
      threshold_ms: SHOW_THRESHOLD_MS,
      metric:
        'app-side: hotkey_received log ts -> first window_state S1 visible log ts (opacity 1 already set; no fixed settle delay, states+input shape combined in one helper call, decorative X11 deferred until after emit); renderer rAF and driver t0->S1 are reported separately',
      pass: showPass,
      samples: showSamples
    },
    pass: coldPass && showPass
  }
  writeJson(path.join(EVID, 'nfr03.json'), nfr03)

  await closeApp(app)
  const playwrightLog = path.join(EVID, 'nfr-m1-playwright-stdout.log')
  fs.appendFileSync(playwrightLog, showStdout.join(''))

  const leftovers = await waitForNoElectron(5000)

  const summary = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    runtime: rel(RUNTIME),
    nfr01: {
      pass: nfr01.pass,
      focus_success: nfr01.focus_success_ratio,
      focus_p95_ms: nfr01.focus_p95_ms,
      raf_p95_ms: nfr01.raf_p95_ms,
      driver_focus_p95_ms: nfr01.driver_focus_p95_ms
    },
    nfr03: {
      pass: nfr03.pass,
      cold_p95_ms: nfr03.cold_start.p95_ms,
      cold_success: nfr03.cold_start.success_ratio,
      cold_pass: nfr03.cold_start.pass,
      show_p95_ms: nfr03.show.p95_ms,
      show_driver_s1_p95_ms: nfr03.show.driver_s1_p95_ms,
      show_pass: nfr03.show.pass
    },
    leftover_electron_pids: leftovers
  }
  writeJson(path.join(EVID, 'nfr-m1-summary.json'), summary)

  console.log('[nfr-m1] summary')
  console.log(JSON.stringify(summary, null, 2))
  console.log(
    `[nfr-m1] NFR-01 ${nfr01.pass ? 'PASS' : 'FAIL'} focus ${nfr01.focus_success_ratio} p95=${nfr01.focus_p95_ms}ms raf_p95=${nfr01.raf_p95_ms}ms`
  )
  console.log(
    `[nfr-m1] NFR-03 cold ${nfr03.cold_start.pass ? 'PASS' : 'FAIL'} ${nfr03.cold_start.success_ratio} p95=${nfr03.cold_start.p95_ms}ms; show ${nfr03.show.pass ? 'PASS' : 'FAIL'} p95=${nfr03.show.p95_ms}ms driver=${nfr03.show.driver_s1_p95_ms}ms`
  )
  if (leftovers.length > 0) {
    console.log(`[nfr-m1] WARNING leftover electron pids: ${leftovers.join(',')}`)
  } else {
    console.log('[nfr-m1] no leftover electron processes')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
