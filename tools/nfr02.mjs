#!/usr/bin/env node
/*
 * NFR-02 — real-app expansion motion evidence.
 *
 * Drives the built app with Playwright `_electron` (args: ['.']) and samples
 * `getBoundingClientRect()` on every requestAnimationFrame while S1 expands to
 * S2 (panel height) and S3 (sidebar width). The OS window jumps to its final
 * bounds once; only CSS inside the window animates (plan B.9 / §3.9).
 *
 * ffmpeg x11grab cannot capture KWin-composited windows on this machine
 * (Task 3), so rAF timing plus Playwright screenshots are the primary
 * evidence. Frames are saved as PNG at mid-animation and at rest.
 *
 * Usage:
 *   source scripts/env.sh
 *   node tools/nfr02.mjs [--runs 20] [--out .omo/evidence/m1/nfr02.json]
 */

import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EVID = path.join(ROOT, '.omo', 'evidence', 'm1')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const RUNTIME = path.join(ROOT, '.runtime', `nfr02-${STAMP}`)
const CACHE_HOME = path.join(ROOT, '.cache', 'xdg')
const DISPLAY = process.env.DISPLAY || ':0'
const argv = process.argv.slice(2)
function argValue(name, fallback) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1]
    if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1)
  }
  return fallback
}
const RUNS = Number(argValue('--runs', '20'))
const OUT = path.resolve(argValue('--out', path.join(EVID, 'nfr02.json')))
const THRESHOLD_MIN_MS = 120
const THRESHOLD_MAX_MS = 180
const DRIFT_MAX_PX = 1
const REDUCED_MAX_MS = 16
const SETTLE_MS = 180
const SAMPLE_TIMEOUT_MS = 1200

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
  if (clean.length === 0) return { n: 0, p50: null, p95: null, max: null, min: null }
  return {
    n: clean.length,
    p50: percentile(clean, 50),
    p95: percentile(clean, 95),
    max: Math.max(...clean),
    min: Math.min(...clean)
  }
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : value
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

async function waitMode(page, mode, timeout = 5000) {
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
      expected,
    mode,
    { timeout }
  )
}

async function ensureS1(page) {
  await page.evaluate(() => window.quickask.window.setMode('S1'))
  await waitMode(page, 'S1')
  await page.waitForFunction(
    () =>
      !document.querySelector('[data-testid="panel"]') &&
      !document.querySelector('[data-testid="sidebar"]'),
    undefined,
    { timeout: 5000 }
  )
  await sleep(SETTLE_MS)
}

async function sampleTransition(page, { mode, selector, property, animationName }) {
  return page.evaluate(
    async ({ mode, selector, property, animationName, timeoutMs }) => {
      const started = performance.now()
      const samples = []
      const events = []
      let stop = false
      const onStart = (event) => {
        if (event.animationName !== animationName) return
        events.push({
          type: 'start',
          name: event.animationName,
          ts: event.timeStamp,
          elapsed: event.elapsedTime
        })
      }
      const onEnd = (event) => {
        if (event.animationName !== animationName) return
        events.push({
          type: 'end',
          name: event.animationName,
          ts: event.timeStamp,
          elapsed: event.elapsedTime
        })
      }
      document.addEventListener('animationstart', onStart, true)
      document.addEventListener('animationend', onEnd, true)

      const tick = () => {
        const element = document.querySelector(selector)
        const bar = document.querySelector('[data-testid="bar"]')
        const barRect = bar ? bar.getBoundingClientRect() : null
        samples.push({
          t: performance.now() - started,
          value: element ? element.getBoundingClientRect()[property] : null,
          animationName: element ? getComputedStyle(element).animationName : null,
          animationDuration: element ? getComputedStyle(element).animationDuration : null,
          barX: barRect ? barRect.x : null,
          barY: barRect ? barRect.y : null,
          screenX: window.screenX,
          screenY: window.screenY,
          mode: document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode')
        })
        if (!stop) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)

      const trigger = performance.now()
      await window.quickask.window.setMode(mode)
      while (performance.now() - started < timeoutMs) {
        const end = events.find((event) => event.type === 'end')
        if (end && performance.now() - end.ts >= 24) break
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      await new Promise((resolve) => requestAnimationFrame(resolve))
      stop = true
      document.removeEventListener('animationstart', onStart, true)
      document.removeEventListener('animationend', onEnd, true)
      return { started, trigger, samples, events }
    },
    { mode, selector, property, animationName, timeoutMs: SAMPLE_TIMEOUT_MS }
  )
}

function analyzeRun(raw) {
  const samples = raw.samples
  const mounted = samples.filter((sample) => sample.value !== null)
  const finalValue = mounted.length > 0 ? mounted[mounted.length - 1].value : null
  const firstNonEmpty = mounted.find((sample) => sample.value > 0.5) ?? null
  let stable = null
  for (let i = 0; i < mounted.length - 2; i++) {
    if (
      Math.abs(mounted[i].value - finalValue) <= 0.5 &&
      Math.abs(mounted[i + 1].value - finalValue) <= 0.5 &&
      Math.abs(mounted[i + 2].value - finalValue) <= 0.5
    ) {
      stable = mounted[i]
      break
    }
  }
  const intermediateCount = mounted.filter(
    (sample) => sample.value > 0.5 && sample.value < finalValue - 0.5
  ).length
  const startEvent = raw.events.find((event) => event.type === 'start') ?? null
  const endEvent = raw.events.find((event) => event.type === 'end') ?? null

  const baseline = mounted.length > 0 ? mounted[0] : null
  const baseX = baseline ? baseline.screenX + baseline.barX : null
  const baseY = baseline ? baseline.screenY + baseline.barY : null
  let drift = 0
  let driftSample = null
  for (const sample of mounted) {
    const dx = Math.abs(sample.screenX + sample.barX - baseX)
    const dy = Math.abs(sample.screenY + sample.barY - baseY)
    const value = Math.max(dx, dy)
    if (value > drift) {
      drift = value
      driftSample = sample
    }
  }
  const after = mounted.length > 0 ? mounted[mounted.length - 1] : null

  return {
    finalValue,
    firstNonEmptyT: firstNonEmpty ? round(firstNonEmpty.t) : null,
    stableT: stable ? round(stable.t) : null,
    durationFirstChangeToStableMs:
      firstNonEmpty && stable ? round(stable.t - firstNonEmpty.t) : null,
    durationTriggerToStableMs:
      stable && raw.trigger ? round(stable.t - (raw.trigger - raw.started)) : null,
    durationAnimationStartToEndMs:
      startEvent && endEvent ? round(endEvent.ts - startEvent.ts) : null,
    animationElapsedMs: endEvent ? round(endEvent.elapsed * 1000) : null,
    animationEndDelayMs:
      endEvent && stable ? round(stable.t - (endEvent.ts - raw.started)) : null,
    intermediateCount,
    computedAnimationDuration:
      mounted.length > 0 ? mounted[0].animationDuration : null,
    computedAnimationName: mounted.length > 0 ? mounted[0].animationName : null,
    barScreenBefore: { x: round(baseX, 0), y: round(baseY, 0) },
    barScreenAfter: after
      ? { x: round(after.screenX + after.barX, 0), y: round(after.screenY + after.barY, 0) }
      : null,
    barDriftPx: round(drift),
    driftSample: driftSample
      ? {
          t: round(driftSample.t),
          barX: round(driftSample.screenX + driftSample.barX, 0),
          barY: round(driftSample.screenY + driftSample.barY, 0)
        }
      : null,
    samples: samples.map((sample) => ({
      t: round(sample.t),
      v: sample.value === null ? null : round(sample.value),
      ax: round(sample.barX),
      ay: round(sample.barY),
      sx: sample.screenX,
      sy: sample.screenY,
      anim: sample.animationName,
      ad: sample.animationDuration,
      mode: sample.mode
    })),
    events: raw.events.map((event) => ({
      type: event.type,
      name: event.name,
      ts: round(event.ts),
      elapsed: event.elapsed
    }))
  }
}

async function timingRun(page, options) {
  await ensureS1(page)
  const raw = await sampleTransition(page, options)
  return analyzeRun(raw)
}

async function visualRun(page, { mode, name, selector, property, value }) {
  await ensureS1(page)
  const pending = page.evaluate((nextMode) => window.quickask.window.setMode(nextMode), mode)
  await page.waitForFunction(
    (target) => document.querySelector(target) !== null,
    selector,
    { timeout: 5000 }
  )
  await sleep(45)
  const midPath = path.join(EVID, `nfr02-${name}-mid.png`)
  await page.screenshot({ path: midPath, omitBackground: true })
  await pending
  await page.waitForTimeout(300)
  const finalPath = path.join(EVID, `nfr02-${name}-final.png`)
  await page.screenshot({ path: finalPath, omitBackground: true })
  const rect = await page.evaluate(
    ({ selector, property }) => {
      const element = document.querySelector(selector)
      return element ? element.getBoundingClientRect()[property] : null
    },
    { selector, property }
  )
  return { midPath: path.relative(ROOT, midPath), finalPath: path.relative(ROOT, finalPath), rect, expected: value }
}

async function inputRun(page) {
  await ensureS1(page)
  const composer = page.locator('[data-testid="composer"]')
  await composer.click()
  await composer.fill('')
  const text = 'abcdefghij'
  const pending = page.evaluate(() => window.quickask.window.setMode('S2'))
  const t0 = Date.now()
  await page.keyboard.type(text, { delay: 0 })
  const typedMs = Date.now() - t0
  await pending
  await page.waitForTimeout(260)
  const value = await composer.inputValue()
  const active = await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid') ?? null
  )
  const mode = await page.evaluate(
    () => document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ?? null
  )
  return {
    typedText: text,
    composerValue: value,
    typedCount: value.length,
    allLanded: value === text,
    typedMs,
    activeTestId: active,
    mode
  }
}

function summarizePhase(label, runs) {
  const firstChange = runs.map((run) => run.durationFirstChangeToStableMs)
  const animation = runs.map((run) => run.durationAnimationStartToEndMs)
  const trigger = runs.map((run) => run.durationTriggerToStableMs)
  const drift = runs.map((run) => run.barDriftPx)
  const intermediate = runs.map((run) => run.intermediateCount)
  const firstStats = stats(firstChange)
  const animationStats = stats(animation)
  const triggerStats = stats(trigger)
  const driftStats = stats(drift)
  return {
    label,
    runs: runs.length,
    durationFirstChangeToStableMs: firstStats,
    durationAnimationStartToEndMs: animationStats,
    durationTriggerToStableMs: triggerStats,
    barDriftPx: driftStats,
    intermediateSamples: stats(intermediate),
    computedAnimationDuration: runs[0]?.computedAnimationDuration ?? null,
    computedAnimationName: runs[0]?.computedAnimationName ?? null,
    samples: runs
  }
}

function phasePass(phase) {
  const p95 = phase.durationAnimationStartToEndMs.p95
  const firstP95 = phase.durationFirstChangeToStableMs.p95
  return {
    animationDurationInRange:
      p95 !== null && p95 >= THRESHOLD_MIN_MS && p95 <= THRESHOLD_MAX_MS,
    firstChangeToStableInRange:
      firstP95 !== null && firstP95 >= THRESHOLD_MIN_MS && firstP95 <= THRESHOLD_MAX_MS,
    barDriftWithin1px: phase.barDriftPx.max !== null && phase.barDriftPx.max <= DRIFT_MAX_PX,
    animatedNotJumped: phase.intermediateSamples.min !== null && phase.intermediateSamples.min >= 3
  }
}

async function main() {
  mkdirs(RUNTIME)
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: envFor(RUNTIME),
    timeout: 30000
  })
  const page = await app.firstWindow({ timeout: 30000 })
  await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 })
  await waitMode(page, 'S0')
  await page.evaluate(() => window.quickask.window.setMode('S1'))
  await waitMode(page, 'S1')

  const s2Runs = []
  const s3Runs = []
  try {
    for (let run = 1; run <= RUNS; run++) {
      s2Runs.push(
        await timingRun(page, {
          mode: 'S2',
          selector: '[data-testid="panel"]',
          property: 'height',
          animationName: 'qa-panel-expand'
        })
      )
    }
    for (let run = 1; run <= RUNS; run++) {
      s3Runs.push(
        await timingRun(page, {
          mode: 'S3',
          selector: '[data-testid="sidebar"]',
          property: 'width',
          animationName: 'qa-sidebar-expand'
        })
      )
    }

    const input = await inputRun(page)
    const s2Visual = await visualRun(page, {
      mode: 'S2',
      name: 's2',
      selector: '[data-testid="panel"]',
      property: 'height',
      value: 120
    })
    const s3Visual = await visualRun(page, {
      mode: 'S3',
      name: 's3',
      selector: '[data-testid="sidebar"]',
      property: 'width',
      value: 260
    })

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForFunction(
      () => document.documentElement.dataset.reducedMotion === '1',
      undefined,
      { timeout: 5000 }
    )
    const reducedRun = await timingRun(page, {
      mode: 'S2',
      selector: '[data-testid="panel"]',
      property: 'height',
      animationName: 'qa-panel-expand'
    })
    const reducedComputed = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="panel"]')
      const root = document.documentElement
      return {
        reducedMotion: root.dataset.reducedMotion ?? null,
        mediaMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        animationDuration: panel ? getComputedStyle(panel).animationDuration : null,
        animationName: panel ? getComputedStyle(panel).animationName : null,
        height: panel ? panel.getBoundingClientRect().height : null
      }
    })
    await page.screenshot({
      path: path.join(EVID, 'nfr02-reduced-motion.png'),
      omitBackground: true
    })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.waitForFunction(
      () => document.documentElement.dataset.reducedMotion === '0',
      undefined,
      { timeout: 5000 }
    )

    await ensureS1(page)

    const s2 = summarizePhase('S2 panel height', s2Runs)
    const s3 = summarizePhase('S3 sidebar width', s3Runs)
    const s2Checks = phasePass(s2)
    const s3Checks = phasePass(s3)
    const inputCheck = input.allLanded && input.mode === 'S2'
    const reducedDurationMs = reducedRun.durationFirstChangeToStableMs
    const reducedCheck =
      reducedComputed.reducedMotion === '1' &&
      reducedComputed.mediaMatches === true &&
      reducedComputed.animationDuration === '0s' &&
      reducedDurationMs !== null &&
      reducedDurationMs <= REDUCED_MAX_MS &&
      reducedRun.intermediateCount === 0
    const checks = {
      s2: { ...s2Checks, pass: Object.values(s2Checks).every(Boolean) },
      s3: { ...s3Checks, pass: Object.values(s3Checks).every(Boolean) },
      inputNotBlocked: {
        pass: inputCheck,
        typedCount: input.typedCount,
        allLanded: input.allLanded,
        activeTestId: input.activeTestId
      },
      reducedMotion: {
        pass: reducedCheck,
        durationFirstChangeToStableMs: reducedDurationMs,
        intermediateCount: reducedRun.intermediateCount,
        ...reducedComputed
      }
    }
    const pass = checks.s2.pass && checks.s3.pass && checks.inputNotBlocked.pass && checks.reducedMotion.pass

    const evidence = {
      nfr: 'NFR-02',
      generated_at: new Date().toISOString(),
      method:
        'Playwright _electron launched the built app (args:["."]) with a fresh XDG sandbox. rAF samples of panel height / sidebar width and bar getBoundingClientRect + window.screenX/Y while S1 expands. animationstart/animationend events give the CSS duration; visual frames are Playwright screenshots. ffmpeg x11grab is not used because it cannot capture KWin-composited windows on this machine (Task 3).',
      environment: {
        display: DISPLAY,
        runtime: path.relative(ROOT, RUNTIME),
        app_entry: '.',
        onboarding_disabled: 'QUICKASK_DISABLE_ONBOARDING=1',
        runs_per_phase: RUNS,
        thresholds: {
          duration_min_ms: THRESHOLD_MIN_MS,
          duration_max_ms: THRESHOLD_MAX_MS,
          bar_drift_max_px: DRIFT_MAX_PX,
          reduced_motion_max_ms: REDUCED_MAX_MS
        },
        display_refresh_note: 'rAF cadence observed in raw samples; timings use the page time origin'
      },
      css: {
        panel: 'qa-panel-expand height 0 -> inline height, opacity 0 -> 1',
        sidebar: 'qa-sidebar-expand width 0 -> 260, opacity 0 -> 1',
        token: '--motion-panel: 160ms',
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
        reduced_motion:
          'tokens.css disables all animations/transitions when html[data-reduced-motion="1"] or prefers-reduced-motion: reduce'
      },
      s2,
      s3,
      input,
      reducedMotion: {
        run: reducedRun,
        computed: reducedComputed
      },
      visualFrames: {
        s2: s2Visual,
        s3: s3Visual,
        reducedMotion: path.join('.omo', 'evidence', 'm1', 'nfr02-reduced-motion.png')
      },
      checks,
      verdict: pass ? 'PASS' : 'FAIL'
    }
    fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2))
    console.log(
      JSON.stringify(
        {
          out: path.relative(ROOT, OUT),
          verdict: evidence.verdict,
          s2: {
            animation_p50: s2.durationAnimationStartToEndMs.p50,
            animation_p95: s2.durationAnimationStartToEndMs.p95,
            first_change_p50: s2.durationFirstChangeToStableMs.p50,
            first_change_p95: s2.durationFirstChangeToStableMs.p95,
            drift_max: s2.barDriftPx.max,
            intermediate_min: s2.intermediateSamples.min
          },
          s3: {
            animation_p50: s3.durationAnimationStartToEndMs.p50,
            animation_p95: s3.durationAnimationStartToEndMs.p95,
            first_change_p50: s3.durationFirstChangeToStableMs.p50,
            first_change_p95: s3.durationFirstChangeToStableMs.p95,
            drift_max: s3.barDriftPx.max,
            intermediate_min: s3.intermediateSamples.min
          },
          input,
          reducedMotion: checks.reducedMotion,
          visualFrames: evidence.visualFrames
        },
        null,
        2
      )
    )
    if (!pass) process.exitCode = 1
  } finally {
    try {
      await app.close()
    } catch {
      try {
        app.process()?.kill('SIGTERM')
      } catch {
        /* best effort */
      }
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
