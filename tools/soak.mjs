#!/usr/bin/env node
/**
 * QuickAsk soak/resource sampler.
 *
 * Launches the built app (release/linux-unpacked/quickask by default), cycles
 * window show/hide through the real preload API, and samples process-tree
 * VmRSS/PSS, CPU and file descriptors every interval. Writes JSON + CSV.
 *
 * Usage:
 *   node tools/soak.mjs --minutes 10 --interval 30 \
 *     --out .omo/evidence/m2/release/task-36-soak.json
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_APP = path.join(ROOT, 'release', 'linux-unpacked', 'quickask')
const DEFAULT_OUT = path.join(ROOT, '.omo', 'evidence', 'm2', 'release', 'task-36-soak.json')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const HZ = 100

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

function flag(name) {
  return process.argv.includes(name)
}

const minutes = Number(arg('--minutes', '10'))
const secondsArg = Number(arg('--seconds', '0'))
const durationSeconds = secondsArg > 0 ? secondsArg : Math.max(1, Math.round(minutes * 60))
const intervalSeconds = Math.max(5, Number(arg('--interval', '30')))
const cyclesPerSample = Math.max(1, Number(arg('--cycles', '1')))
const warmupSeconds = Math.max(0, Number(arg('--warmup', '8')))
const appPath = path.resolve(arg('--app', DEFAULT_APP))
const outPath = path.resolve(arg('--out', DEFAULT_OUT))
const csvPath = outPath.replace(/\.json$/i, '') + '.csv'
const display = arg('--display', process.env.DISPLAY || ':0')
const cycleHoldMs = Math.max(200, Number(arg('--cycle-hold-ms', '700')))
const settleMs = Math.max(0, Number(arg('--settle-ms', '1500')))
const fdJitterLimit = Math.max(0, Number(arg('--fd-jitter', '2')))
const pssGrowthLimitPercent = 5
const quiet = flag('--quiet')

const runtime = path.join(ROOT, '.runtime', `task-36-soak-${STAMP}`)
const env = {
  ...process.env,
  DISPLAY: display,
  TMPDIR: path.join(ROOT, '.cache', 'tmp'),
  XDG_CONFIG_HOME: path.join(runtime, 'config'),
  XDG_DATA_HOME: path.join(runtime, 'data'),
  XDG_STATE_HOME: path.join(runtime, 'state'),
  XDG_CACHE_HOME: path.join(ROOT, '.cache', 'xdg'),
  QUICKASK_DATA_DIR: path.join(runtime, 'data', 'quickask-db'),
  QUICKASK_DISABLE_ONBOARDING: '1'
}

function log(...args) {
  if (!quiet) console.log(...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null
}

function readPackage() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

function readProcStat(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = text.lastIndexOf(')')
    if (close < 0) return null
    const fields = text.slice(close + 2).trim().split(/\s+/)
    const ppid = Number(fields[1])
    const utime = Number(fields[11])
    const stime = Number(fields[12])
    if (![ppid, utime, stime].every(Number.isFinite)) return null
    return { ppid, ticks: utime + stime }
  } catch {
    return null
  }
}

function processTable() {
  const table = new Map()
  let entries
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return table
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const stat = readProcStat(entry)
    if (stat) table.set(Number(entry), stat)
  }
  return table
}

function descendants(rootPid) {
  const table = processTable()
  const selected = new Set()
  if (!table.has(rootPid)) return selected
  selected.add(rootPid)
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, stat] of table) {
      if (selected.has(pid)) continue
      if (selected.has(stat.ppid)) {
        selected.add(pid)
        changed = true
      }
    }
  }
  return selected
}

function readMemory(pid) {
  let rssKb = 0
  let pssKb = 0
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)
    if (m) rssKb = Number(m[1])
  } catch {
    // process may exit between enumeration and read
  }
  try {
    const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
    const m = /^Pss:\s+(\d+)\s+kB/m.exec(rollup)
    if (m) pssKb = Number(m[1])
  } catch {
    // smaps_rollup is optional
  }
  return { rssKb, pssKb }
}

function readFdCount(pid) {
  try {
    return fs.readdirSync(`/proc/${pid}/fd`).length
  } catch {
    return 0
  }
}

function readCpuTicks(pid) {
  const stat = readProcStat(pid)
  return stat ? stat.ticks : null
}

function sampleTree(rootPid, previousCpuByPid, elapsedSec) {
  const pids = [...descendants(rootPid)].sort((a, b) => a - b)
  const processes = []
  let totalRssKb = 0
  let totalPssKb = 0
  let totalFds = 0
  let cpuTicks = 0
  let cpuTicksDelta = 0
  for (const pid of pids) {
    const memory = readMemory(pid)
    const fds = readFdCount(pid)
    const ticks = readCpuTicks(pid)
    if (ticks !== null) cpuTicks += ticks
    totalRssKb += memory.rssKb
    totalPssKb += memory.pssKb
    totalFds += fds
    const prev = previousCpuByPid.get(pid)
    const deltaTicks = ticks !== null && prev !== undefined ? Math.max(0, ticks - prev) : 0
    cpuTicksDelta += deltaTicks
    processes.push({
      pid,
      rssKb: memory.rssKb,
      pssKb: memory.pssKb,
      fds,
      cpuTicksDelta: deltaTicks,
      cpuPercent: elapsedSec > 0 ? round((deltaTicks / HZ / elapsedSec) * 100) : null
    })
  }
  const cpuPercent = elapsedSec > 0 ? round((cpuTicksDelta / HZ / elapsedSec) * 100) : null
  return {
    processes,
    totalRssKb,
    totalPssKb,
    totalFds,
    cpuTicks,
    cpuTicksDelta,
    cpuPercent,
    cpuPercentOfMachine:
      cpuPercent === null ? null : round(cpuPercent / Math.max(1, os.cpus().length))
  }
}

function writeCsv(samples) {
  const header = [
    'elapsed_s',
    'total_rss_kb',
    'total_pss_kb',
    'total_fds',
    'cpu_percent',
    'process_count',
    'show_ok',
    'hide_ok',
    'page_errors',
    'console_errors'
  ]
  const lines = [header.join(',')]
  for (const sample of samples) {
    lines.push(
      [
        sample.elapsedSec,
        sample.totalRssKb,
        sample.totalPssKb,
        sample.totalFds,
        sample.cpuPercent ?? '',
        sample.processCount,
        sample.cycles?.showOk ?? '',
        sample.cycles?.hideOk ?? '',
        sample.pageErrors ?? 0,
        sample.consoleErrors ?? 0
      ].join(',')
    )
  }
  fs.mkdirSync(path.dirname(csvPath), { recursive: true })
  fs.writeFileSync(csvPath, `${lines.join('\n')}\n`)
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value))
  if (clean.length === 0) return null
  return clean.reduce((sum, value) => sum + value, 0) / clean.length
}

function baselineSlice(samples) {
  return samples.slice(0, Math.min(3, samples.length))
}

function finalSlice(samples) {
  return samples.slice(Math.max(0, samples.length - 3))
}

async function cycleWindow(page, count) {
  let showOk = 0
  let hideOk = 0
  const errors = []
  for (let i = 0; i < count; i += 1) {
    try {
      const show = await page.evaluate(async () => {
        const result = await window.quickask.window.show()
        return result.ok ? result.data : { error: result.error }
      })
      if (show?.visible === true) showOk += 1
      else errors.push(`show returned ${JSON.stringify(show)}`)
      await sleep(cycleHoldMs)
      const hide = await page.evaluate(async () => {
        const result = await window.quickask.window.hide()
        return result.ok ? result.data : { error: result.error }
      })
      if (hide?.visible === false) hideOk += 1
      else errors.push(`hide returned ${JSON.stringify(hide)}`)
      await sleep(Math.max(100, Math.round(cycleHoldMs / 2)))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { showOk, hideOk, errors }
}

async function main() {
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.mkdirSync(runtime, { recursive: true })
  fs.mkdirSync(env.TMPDIR, { recursive: true })
  if (!fs.existsSync(appPath)) throw new Error(`app not found: ${appPath}`)

  const pkg = readPackage()
  log(`[soak] app=${path.relative(ROOT, appPath)} version=${pkg.version ?? '?'}`)
  log(`[soak] duration=${durationSeconds}s interval=${intervalSeconds}s cycles/sample=${cyclesPerSample}`)
  log(`[soak] out=${path.relative(ROOT, outPath)} runtime=${path.relative(ROOT, runtime)}`)

  const pageErrors = []
  const consoleErrors = []
  const appLog = []
  let app = null
  let rootPid = null
  let page = null
  let cycles = 0
  let cycleFailures = 0
  const samples = []
  const previousCpuByPid = new Map()
  let lastSampleMs = null

  try {
    app = await electron.launch({
      executablePath: appPath,
      args: [],
      cwd: ROOT,
      env,
      timeout: 60000
    })
    rootPid = app.process().pid
    app.process().stdout?.on('data', (chunk) => appLog.push(chunk.toString()))
    app.process().stderr?.on('data', (chunk) => appLog.push(chunk.toString()))
    page = await app.firstWindow({ timeout: 30000 })
    page.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 500)))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500))
    })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.quickask), null, { timeout: 15000 })
    log(`[soak] launched pid=${rootPid}`)

    if (warmupSeconds > 0) {
      await cycleWindow(page, 1)
      await sleep(warmupSeconds * 1000)
    }

    const schedule = []
    for (let elapsed = 0; elapsed <= durationSeconds; elapsed += intervalSeconds) {
      schedule.push(elapsed)
    }
    if (schedule[schedule.length - 1] !== durationSeconds) schedule.push(durationSeconds)

    let result = null
    for (let index = 0; index < schedule.length; index += 1) {
      const elapsedTarget = schedule[index]
      const waitMs = elapsedTarget * 1000 - (Date.now() - startedMs)
      if (waitMs > 0) await sleep(waitMs)
      if (index > 0) {
        result = await cycleWindow(page, cyclesPerSample)
        cycles += cyclesPerSample
        cycleFailures += result.errors.length
        if (result.errors.length > 0) {
          log(`[soak] cycle errors at ${elapsedTarget}s: ${result.errors.slice(0, 3).join(' | ')}`)
        }
        if (settleMs > 0) await sleep(settleMs)
      }
      const now = Date.now()
      const sinceLast = lastSampleMs === null ? 0 : (now - lastSampleMs) / 1000
      const metricSample = sampleTree(rootPid, previousCpuByPid, sinceLast)
      for (const proc of metricSample.processes) {
        previousCpuByPid.set(proc.pid, cpuTicksFor(proc.pid))
      }
      previousCpuByPid.set(rootPid, cpuTicksFor(rootPid))
      const sample = {
        index,
        elapsedSec: elapsedTarget,
        sampledAt: new Date(now).toISOString(),
        totalRssKb: metricSample.totalRssKb,
        totalPssKb: metricSample.totalPssKb,
        totalFds: metricSample.totalFds,
        cpuPercent: metricSample.cpuPercent,
        cpuPercentOfMachine: metricSample.cpuPercentOfMachine,
        processCount: metricSample.processes.length,
        processes: metricSample.processes,
        cycles: result ?? null,
        pageErrors: pageErrors.length,
        consoleErrors: consoleErrors.length
      }
      samples.push(sample)
      lastSampleMs = now
      log(
        `[soak ${String(elapsedTarget).padStart(4, '0')}s] pss=${(sample.totalPssKb / 1024).toFixed(1)}MiB rss=${(sample.totalRssKb / 1024).toFixed(1)}MiB fds=${sample.totalFds} cpu=${sample.cpuPercent ?? '?'}% procs=${sample.processCount} cycles=${result ? `${result.showOk}/${cyclesPerSample}` : '-'}`
      )
      writeCsv(samples)
    }

    const baseline = baselineSlice(samples)
    const final = finalSlice(samples)
    const baselinePss = average(baseline.map((s) => s.totalPssKb))
    const finalPss = average(final.map((s) => s.totalPssKb))
    const maxPss = Math.max(...samples.map((s) => s.totalPssKb))
    const minPss = Math.min(...samples.map((s) => s.totalPssKb))
    const baselineFds = average(baseline.map((s) => s.totalFds))
    const finalFds = average(final.map((s) => s.totalFds))
    const maxFds = Math.max(...samples.map((s) => s.totalFds))
    const pssGrowthPercent = baselinePss > 0 ? ((finalPss - baselinePss) / baselinePss) * 100 : null
    const fdGrowth = finalFds === null || baselineFds === null ? null : finalFds - baselineFds
    const pssOk = pssGrowthPercent !== null && pssGrowthPercent <= pssGrowthLimitPercent
    const fdsOk = fdGrowth !== null && fdGrowth <= fdJitterLimit
    const pageErrorsOk = pageErrors.length === 0
    const cyclesOk = cycleFailures === 0 && cycles > 0
    const verdict = pssOk && fdsOk && pageErrorsOk && cyclesOk ? 'PASS' : 'FAIL'

    const evidence = {
      tool: 'tools/soak.mjs',
      task: 36,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationSeconds,
      intervalSeconds,
      warmupSeconds,
      settleMs,
      cyclesPerSample,
      cycles,
      cycleFailures,
      environment: {
        app: path.relative(ROOT, appPath),
        appVersion: pkg.version ?? null,
        electron: pkg.devDependencies?.electron ?? null,
        display,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        kernel: os.release(),
        cpuCount: os.cpus().length,
        totalMemMiB: Math.round(os.totalmem() / 1024 / 1024),
        runtime: path.relative(ROOT, runtime)
      },
      thresholds: {
        pssGrowthLimitPercent,
        fdGrowthLimit: fdJitterLimit,
        pageErrors: 0
      },
      summary: {
        baselinePssKb: Math.round(baselinePss ?? 0),
        finalPssKb: Math.round(finalPss ?? 0),
        baselinePssMiB: round((baselinePss ?? 0) / 1024, 2),
        finalPssMiB: round((finalPss ?? 0) / 1024, 2),
        minPssMiB: round(minPss / 1024, 2),
        maxPssMiB: round(maxPss / 1024, 2),
        pssGrowthPercent: round(pssGrowthPercent),
        baselineRssMiB: round((average(baseline.map((s) => s.totalRssKb)) ?? 0) / 1024, 2),
        finalRssMiB: round((average(final.map((s) => s.totalRssKb)) ?? 0) / 1024, 2),
        baselineFds: round(baselineFds, 1),
        finalFds: round(finalFds, 1),
        maxFds,
        fdGrowth: round(fdGrowth, 1),
        fdJitterLimit,
        avgCpuPercent: round(average(samples.slice(1).map((s) => s.cpuPercent))),
        maxCpuPercent: round(Math.max(...samples.slice(1).map((s) => s.cpuPercent ?? 0))),
        pageErrors: pageErrors.length,
        consoleErrors: consoleErrors.length
      },
      checks: {
        pssGrowthWithin5Percent: pssOk,
        noFdGrowth: fdsOk,
        noPageErrors: pageErrorsOk,
        allCyclesValid: cyclesOk
      },
      verdict,
      pageErrorDetails: pageErrors,
      consoleErrorDetails: consoleErrors.slice(0, 20),
      samples,
      artifacts: {
        json: path.relative(ROOT, outPath),
        csv: path.relative(ROOT, csvPath),
        appLog: null
      }
    }

    const appLogPath = path.join(runtime, 'stdout.log')
    try {
      fs.writeFileSync(appLogPath, appLog.join(''))
      evidence.artifacts.appLog = path.relative(ROOT, appLogPath)
    } catch {
      // stdout capture is optional
    }

    fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`)
    log(
      `[soak] verdict=${verdict} pss=${evidence.summary.baselinePssMiB}->${evidence.summary.finalPssMiB}MiB (${evidence.summary.pssGrowthPercent}%) fds=${evidence.summary.baselineFds}->${evidence.summary.finalFds}`
    )
    log(`[soak] wrote ${path.relative(ROOT, outPath)} and ${path.relative(ROOT, csvPath)}`)
    process.exitCode = verdict === 'PASS' ? 0 : 1
  } catch (error) {
    const evidence = {
      tool: 'tools/soak.mjs',
      task: 36,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationSeconds,
      intervalSeconds,
      warmupSeconds,
      settleMs,
      cyclesPerSample,
      cycles,
      cycleFailures,
      verdict: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
      environment: {
        app: path.relative(ROOT, appPath),
        display,
        platform: process.platform,
        node: process.version
      },
      samples,
      pageErrors,
      consoleErrors,
      artifacts: { json: path.relative(ROOT, outPath), csv: path.relative(ROOT, csvPath) }
    }
    fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`)
    writeCsv(samples)
    console.error(`[soak] FAILED: ${evidence.error}`)
    process.exitCode = 1
  } finally {
    if (app) {
      try {
        await Promise.race([app.close(), sleep(8000)])
      } catch {
        // fall through to signal-based cleanup
      }
    }
    if (rootPid !== null) {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const alive = [...descendants(rootPid)].some((pid) => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        })
        if (!alive) break
        await sleep(200)
      }
      if ([...descendants(rootPid)].length > 0) {
        try {
          process.kill(rootPid, 'SIGTERM')
        } catch {
          // already gone
        }
        await sleep(1000)
        try {
          process.kill(rootPid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
    log(`[soak] finished elapsed=${Math.round((Date.now() - startedMs) / 1000)}s`)
  }
}

function cpuTicksFor(pid) {
  return readCpuTicks(pid) ?? 0
}

await main()
