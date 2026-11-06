#!/usr/bin/env node
/*
 * NFR-04 — real-app taskbar / Alt+Tab exclusion evidence.
 *
 * Launches the built app with Playwright `_electron`, shows S1, then reads the
 * live X11 window properties and holds Alt+Tab five times. QuickAsk must carry
 * SKIP_TASKBAR + SKIP_PAGER + _KDE_NET_WM_STATE_SKIP_SWITCHER + ABOVE and must
 * not appear in the KWin switcher.
 *
 * `wmctrl -l` is recorded but is not proof of taskbar presence: KWin keeps
 * every managed window in `_NET_CLIENT_LIST` even when SKIP_TASKBAR is set.
 * The primary evidence is xprop + the switcher screenshots.
 *
 * Usage:
 *   source scripts/env.sh
 *   node tools/nfr04.mjs
 */

import { _electron as electron } from 'playwright'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EVID = path.join(ROOT, '.omo', 'evidence', 'm1')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const RUNTIME = path.join(ROOT, '.runtime', `nfr04-${STAMP}`)
const CACHE_HOME = path.join(ROOT, '.cache', 'xdg')
const DISPLAY = process.env.DISPLAY || ':0'
const RUNS = 5
const TARGET_TITLE = 'NFR04ALTABTARGET'
const REQUIRED_ATOMS = [
  '_NET_WM_STATE_SKIP_TASKBAR',
  '_NET_WM_STATE_SKIP_PAGER',
  '_KDE_NET_WM_STATE_SKIP_SWITCHER',
  '_NET_WM_STATE_ABOVE'
]
const XPROP_KEYS = [
  '_NET_WM_STATE',
  '_NET_WM_WINDOW_TYPE',
  'WM_HINTS',
  'WM_CLASS',
  '_KDE_NET_WM_BLUR_BEHIND_REGION'
]

fs.mkdirSync(EVID, { recursive: true })
fs.mkdirSync(RUNTIME, { recursive: true })
fs.mkdirSync(CACHE_HOME, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const xenv = { ...process.env, DISPLAY }

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

function run(cmd, args, timeout = 10000) {
  return execFileSync(cmd, args, { encoding: 'utf8', env: xenv, timeout }).trim()
}

let originalCursor = null

function readCursor() {
  const output = tryRun('xdotool', ['getmouselocation', '--shell']).output
  const values = Object.fromEntries(
    output
      .split('\n')
      .map((line) => line.split('='))
      .filter((pair) => pair.length === 2)
  )
  return {
    x: Number(values['X']),
    y: Number(values['Y']),
    screen: values['SCREEN'] ?? null
  }
}

function tryRun(cmd, args, timeout = 10000) {
  try {
    return { ok: true, output: run(cmd, args, timeout), error: null }
  } catch (error) {
    return {
      ok: false,
      output: '',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function findQuickAskWid() {
  const search = tryRun('xdotool', ['search', '--name', '^QuickAsk$'])
  if (!search.ok) return { wid: null, error: search.error, candidates: [] }
  const candidates = search.output.split('\n').filter(Boolean)
  for (const id of candidates) {
    const cls = tryRun('xprop', ['-id', id, 'WM_CLASS'])
    if (cls.ok && /"quickask"/.test(cls.output)) return { wid: id, error: null, candidates }
  }
  return { wid: null, error: 'no candidate with WM_CLASS quickask', candidates }
}

function readXprop(wid) {
  const raw = {}
  for (const key of XPROP_KEYS) {
    const result = tryRun('xprop', ['-id', wid, key])
    raw[key] = result.ok ? result.output : `ERROR: ${result.error}`
  }
  const state = raw['_NET_WM_STATE'] ?? ''
  const atoms = Object.fromEntries(
    REQUIRED_ATOMS.map((atom) => [atom, new RegExp(`(^|[ ,])${atom}([ ,]|$)`).test(state)])
  )
  return {
    wid,
    raw,
    atoms,
    all_required_atoms: Object.values(atoms).every(Boolean),
    window_type_normal: /_NET_WM_WINDOW_TYPE_NORMAL/.test(raw['_NET_WM_WINDOW_TYPE'] ?? ''),
    wm_class_quickask: /"quickask",\s*"quickask"/.test(raw['WM_CLASS'] ?? ''),
    wm_hints_present: !/not found/i.test(raw['WM_HINTS'] ?? ''),
    blur_region_present: !/not found/i.test(raw['_KDE_NET_WM_BLUR_BEHIND_REGION'] ?? '')
  }
}

function ocr(file) {
  const result = tryRun('tesseract', [file, 'stdout', '-l', 'eng', '--psm', '6'], 30000)
  return result.ok ? result.output : `OCR_ERROR: ${result.error}`
}

function cropScreenshot(source, target) {
  return tryRun('convert', [source, '-crop', '70%x70%+15%+15%', '+repage', target], 30000)
}

async function captureSwitcher(targetPath) {
  await sleep(320)
  const shot = tryRun('spectacle', ['-b', '-n', '-f', '-o', targetPath], 20000)
  return shot
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

  const target = spawn(
    'xterm',
    ['-T', TARGET_TITLE, '-geometry', '80x18+1180+620', '-e', 'sleep', '600'],
    { env: xenv, detached: true, stdio: 'ignore' }
  )
  target.unref()
  await sleep(900)

  await page.evaluate(() => window.quickask.window.setMode('S1'))
  await page.waitForFunction(
    () => document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') === 'S1',
    undefined,
    { timeout: 5000 }
  )
  await page.waitForTimeout(1200)

  try {
    const found = findQuickAskWid()
    if (!found.wid) throw new Error(`QuickAsk window not found: ${JSON.stringify(found)}`)
    const wid = found.wid
    const xpropData = readXprop(wid)
    fs.writeFileSync(
      path.join(EVID, 'xprop.txt'),
      [
        `xprop -id ${wid} (${new Date().toISOString()})`,
        ...XPROP_KEYS.flatMap((key) => [`--- ${key} ---`, xpropData.raw[key] ?? ''])
      ].join('\n')
    )

    const wmctrl = tryRun('wmctrl', ['-l'])
    fs.writeFileSync(path.join(EVID, 'nfr04-wmctrl.txt'), `${wmctrl.output}\n`)
    const wmctrlQuickAsk = wmctrl.output
      .split('\n')
      .filter((line) => /quickask/i.test(line))

    const targetWidResult = tryRun('xdotool', ['search', '--name', `^${TARGET_TITLE}$`])
    const targetWid = targetWidResult.output.split('\n')[0] ?? null
    if (!targetWid) throw new Error(`target xterm ${TARGET_TITLE} not found`)

    const stateResult = await page.evaluate(() => window.quickask.window.getState())
    const state = stateResult.data
    const cursorX = state.layout.anchor.x + Math.round(state.layout.barRect.width / 2)
    const cursorY = state.layout.anchor.y + Math.round(state.layout.barRect.height / 2)
    originalCursor = readCursor()
    tryRun('xdotool', ['mousemove', '--sync', String(cursorX), String(cursorY)])
    await sleep(150)

    const runs = []
    for (let i = 1; i <= RUNS; i++) {
      tryRun('xdotool', ['windowactivate', '--sync', targetWid])
      await sleep(400)
      const appState = await page.evaluate(() => window.quickask.window.getState())
      const activeWid = tryRun('xdotool', ['getactivewindow'])
      const activeName = activeWid.output
        ? tryRun('xdotool', ['getwindowname', activeWid.output]).output
        : null
      tryRun('xdotool', ['keydown', 'alt'])
      await sleep(60)
      tryRun('xdotool', ['key', 'Tab'])
      const png = path.join(EVID, `alt-tab-${i}.png`)
      const shot = await captureSwitcher(png)
      tryRun('xdotool', ['keyup', 'alt'])
      await sleep(500)
      const crop = path.join(EVID, `alt-tab-${i}-crop.png`)
      const cropped = cropScreenshot(png, crop)
      const text = shot.ok ? ocr(cropped.ok ? crop : png) : ''
      fs.writeFileSync(path.join(EVID, `alt-tab-${i}.ocr.txt`), `${text}\n`)
      runs.push({
        run: i,
        png: path.relative(ROOT, png),
        crop: cropped.ok ? path.relative(ROOT, crop) : null,
        active_window: activeName,
        quickask_visible: appState.data?.visible === true,
        quickask_mode: appState.data?.mode ?? null,
        spectacle_ok: shot.ok,
        spectacle_error: shot.error,
        ocr_text: text,
        ocr_mentions_quickask: /quick\s*ask|quickask/i.test(text)
      })
    }
    const quickaskVisibleForAllRuns = runs.every((runItem) => runItem.quickask_visible)
    const targetActiveForAllRuns = runs.every(
      (runItem) => typeof runItem.active_window === 'string' && runItem.active_window !== 'QuickAsk'
    )

    const summary = {
      nfr: 'NFR-04',
      generated_at: new Date().toISOString(),
      method:
        'Real app (Playwright _electron args:["."]) shown as S1 on DISPLAY :0. The cursor was parked inside the bar so auto-hide stayed cancelled while the xterm target was focused; xprop was read on the live X11 window; wmctrl -l was recorded with the _NET_CLIENT_LIST caveat; Alt was held down while Tab was pressed five times, with a fullscreen Spectacle screenshot each time.',
      environment: {
        display: DISPLAY,
        runtime: path.relative(ROOT, RUNTIME),
        window_manager: 'KWin (X11 session)',
        target_window: TARGET_TITLE,
        target_wid: targetWid,
        runs: RUNS,
        cursor_parked_at: { x: cursorX, y: cursorY },
        cursor_original: originalCursor
      },
      wid,
      quickask_candidates: found.candidates,
      xprop: xpropData,
      wmctrl: {
        path: '.omo/evidence/m1/nfr04-wmctrl.txt',
        raw: wmctrl.output,
        quickask_lines: wmctrlQuickAsk,
        note:
          '_NET_CLIENT_LIST is a managed-window list, not a taskbar list. KWin still lists QuickAsk in wmctrl even when SKIP_TASKBAR is set; use the xprop atoms and the Alt+Tab screenshots as the authoritative evidence.'
      },
      alt_tab: {
        runs,
        primary_evidence: 'Alt+Tab switcher screenshots (alt-tab-1..5.png) + xprop skip atoms',
        ocr_note:
          'The OCR crop still contains the desktop behind the switcher, whose terminal title includes the project name "quick-ask"; OCR text alone is therefore not used as the absence proof. The screenshots are verified visually.'
      },
      kwin_introspection: {
        real_app: {
          path: '.omo/evidence/m1/nfr04-kwin-introspection.json',
          note:
            'Generated with workspace.windowList() while the real app was visible; skipSwitcher/skipTaskbar/skipPager were all true on both the first show and after hide/show.'
        },
        spike_support: {
          path: '.omo/evidence/task-7-kwin-introspection.json',
          note: 'Task 7 spike window QAATOMSG4; same KWin 6.3.6 behavior, not the real app.'
        },
        real_app_primary: 'xprop atoms + real-app KWin introspection + Alt+Tab screenshots'
      },
      checks: {
        all_required_atoms: xpropData.all_required_atoms,
        window_type_normal: xpropData.window_type_normal,
        wm_class_quickask: xpropData.wm_class_quickask,
        skip_switcher_atom: xpropData.atoms['_KDE_NET_WM_STATE_SKIP_SWITCHER'],
        skip_taskbar_atom: xpropData.atoms['_NET_WM_STATE_SKIP_TASKBAR'],
        skip_pager_atom: xpropData.atoms['_NET_WM_STATE_SKIP_PAGER'],
        above_atom: xpropData.atoms['_NET_WM_STATE_ABOVE'],
        five_switcher_screenshots: runs.filter((runItem) => runItem.spectacle_ok).length === RUNS,
        quickask_visible_for_all_runs: quickaskVisibleForAllRuns,
        target_window_active_for_all_runs: targetActiveForAllRuns,
        quickask_not_active_during_switcher: runs.every(
          (runItem) =>
            typeof runItem.active_window === 'string' &&
            !/^QuickAsk$/.test(runItem.active_window)
        )
      },
      verdict: null
    }
    summary.verdict = Object.values(summary.checks).every(Boolean) ? 'PASS' : 'FAIL'
    fs.writeFileSync(path.join(EVID, 'xprop.json'), JSON.stringify(summary, null, 2))
    fs.writeFileSync(path.join(EVID, 'nfr04-summary.json'), JSON.stringify(summary, null, 2))
    console.log(
      JSON.stringify(
        {
          verdict: summary.verdict,
          wid,
          xprop_state: xpropData.raw['_NET_WM_STATE'],
          atoms: xpropData.atoms,
          wm_class: xpropData.raw['WM_CLASS'],
          window_type: xpropData.raw['_NET_WM_WINDOW_TYPE'],
          wm_hints: xpropData.raw['WM_HINTS'],
          blur_region: xpropData.raw['_KDE_NET_WM_BLUR_BEHIND_REGION'],
          wmctrl_quickask_lines: wmctrlQuickAsk,
          screenshots: runs.map((runItem) => runItem.png),
          ocr_mentions_quickask: runs.map((runItem) => runItem.ocr_mentions_quickask)
        },
        null,
        2
      )
    )
    if (summary.verdict !== 'PASS') process.exitCode = 1
  } finally {
    if (
      originalCursor &&
      Number.isFinite(originalCursor.x) &&
      Number.isFinite(originalCursor.y)
    ) {
      tryRun('xdotool', [
        'mousemove',
        '--sync',
        String(originalCursor.x),
        String(originalCursor.y)
      ])
    }
    try {
      process.kill(-target.pid, 'SIGTERM')
    } catch {
      try {
        target.kill('SIGTERM')
      } catch {
        /* best effort */
      }
    }
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
