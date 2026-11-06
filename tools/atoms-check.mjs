#!/usr/bin/env node
/**
 * Task 7 G4 driver — real KWin Alt+Tab checks for the QAATOMSG4 window.
 *
 * Runs N real Alt+Tab cycles (Alt keydown -> Tab -> 0.4s -> spectacle -> Alt
 * keyup), OCRs each switcher screenshot, and writes a summary. It restores the
 * user's previous focus and always releases Alt in a finally block.
 *
 * Usage:
 *   source scripts/env.sh
 *   node tools/atoms-check.mjs [--wid 0x1780003] [--runs 5]
 *        [--restore-wid 16777240]
 *
 * Without --wid it starts spike/atoms.cjs itself and stops it afterwards.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EVID = path.join(ROOT, '.omo', 'evidence')
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron')
const DISPLAY = process.env.DISPLAY || ':0'
const READY_FILE = path.join(EVID, 'task-7-atoms-ready.json')
const XPROP_FILE = path.join(EVID, 'task-7-xprop.txt')
const WMCTRL_FILE = path.join(EVID, 'task-7-wmctrl.txt')
const TARGET_TITLE = 'QAALTABTARGET'
const ATOM_NAMES = [
  '_NET_WM_STATE_SKIP_TASKBAR',
  '_NET_WM_STATE_SKIP_PAGER',
  '_KDE_NET_WM_STATE_SKIP_SWITCHER',
  '_NET_WM_STATE_ABOVE'
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function sh(command, args, { timeout = 15000 } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, DISPLAY }
  })
  return {
    code: result.status === null ? -1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null
  }
}

function xdo(...args) {
  return sh('xdotool', args.map(String))
}
function toDec(value) {
  if (typeof value === 'number') return value
  return value.startsWith('0x') ? parseInt(value, 16) : parseInt(value, 10)
}
function toHex(value) {
  return `0x${Number(value).toString(16)}`
}
function focusOf() {
  const r = xdo('getwindowfocus')
  const n = Number(String(r.stdout).trim())
  return Number.isFinite(n) && n > 0 ? n : 0
}

async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await sleep(intervalMs)
  }
  return false
}

async function startAtomsApp() {
  fs.rmSync(READY_FILE, { force: true })
  const child = spawn(ELECTRON, [path.join('spike', 'atoms.cjs')], {
    cwd: ROOT,
    env: { ...process.env, DISPLAY },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const ok = await waitFor(() => fs.existsSync(READY_FILE), 20000, 150)
  if (!ok) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      /* ignore */
    }
    throw new Error(`atoms app did not become ready; stdout=${stdout} stderr=${stderr}`)
  }
  const ready = readJson(READY_FILE)
  return {
    child,
    ready,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null) return
      const closed = new Promise((resolve) => child.once('close', resolve))
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* ignore */
      }
      await Promise.race([closed, sleep(2500)])
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* ignore */
        }
        await Promise.race([closed, sleep(1000)])
      }
    }
  }
}

async function startTarget() {
  const child = spawn('xmessage', ['-title', TARGET_TITLE, '-buttons', 'OK:0', '-center', 'AltTab target'], {
    cwd: ROOT,
    env: { ...process.env, DISPLAY },
    detached: true,
    stdio: 'ignore'
  })
  const ok = await waitFor(() => {
    const r = xdo('search', '--name', `^${TARGET_TITLE}$`)
    return String(r.stdout).trim().length > 0
  }, 8000, 120)
  if (!ok) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      /* ignore */
    }
    throw new Error('xmessage target window did not appear')
  }
  const wid = Number(String(xdo('search', '--name', `^${TARGET_TITLE}$`).stdout).trim().split('\n')[0])
  return {
    child,
    wid,
    stop: async () => {
      if (child.exitCode !== null) return
      const closed = new Promise((resolve) => child.once('close', resolve))
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* ignore */
      }
      await Promise.race([closed, sleep(1500)])
    }
  }
}

async function activateAndVerify(wid, attempts = 10) {
  const dec = toDec(wid)
  for (let i = 0; i < attempts; i += 1) {
    xdo('windowactivate', toHex(dec))
    xdo('windowfocus', toHex(dec))
    await sleep(120)
    if (focusOf() === dec) return true
  }
  return false
}

function parseAtoms(xpropText) {
  const snapshots = []
  let current = null
  for (const line of xpropText.split('\n')) {
    const header = /^===== (.+?) \| .* \| wid=(0x[0-9a-f]+) =====/.exec(line)
    if (header) {
      current = { label: header[1], wid: header[2], state_line: null, atoms: {} }
      snapshots.push(current)
      continue
    }
    if (current && line.startsWith('_NET_WM_STATE(ATOM)')) {
      current.state_line = line
      for (const atom of ATOM_NAMES) {
        current.atoms[atom] = line.includes(atom)
      }
    }
  }
  return snapshots
}

async function main() {
  fs.mkdirSync(EVID, { recursive: true })
  const runs = Number(argValue('--runs') || 5)
  const existingWid = argValue('--wid')
  const restoreWidArg = argValue('--restore-wid')
  const originalActive = restoreWidArg
    ? toDec(restoreWidArg)
    : focusOf()
  const originalName = originalActive ? String(xdo('getwindowname', toHex(originalActive)).stdout).trim() : null

  let atomsApp = null
  let target = null
  let wid = existingWid ? toDec(existingWid) : 0
  const summary = {
    generated_at: new Date().toISOString(),
    display: DISPLAY,
    runs_requested: runs,
    wid: existingWid || null,
    target_wid: null,
    original_active_wid: originalActive || null,
    original_active_name: originalName,
    xprop: { path: XPROP_FILE, snapshots: [], atoms_all_present: false },
    wmctrl: { path: WMCTRL_FILE, lines: [], quickask_listed: null },
    kwin_introspection: readJson(path.join(EVID, 'task-7-kwin-introspection.json')),
    alt_tab: [],
    pass: false,
    cleanup: {}
  }

  try {
    if (!wid) {
      atomsApp = await startAtomsApp()
      summary.wid = atomsApp.ready.wid
      wid = toDec(atomsApp.ready.wid)
      summary.atoms_app_pid = atomsApp.ready.pid
      summary.atoms_app_log = atomsApp.ready.app_log
    }

    target = await startTarget()
    summary.target_wid = toHex(target.wid)

    // Bring QuickAsk forward once so the first switcher entry is predictable.
    await activateAndVerify(wid)
    await sleep(250)

    // --- xprop evidence (the app already wrote pre/post snapshots).
    if (!fs.existsSync(XPROP_FILE)) {
      sh('xprop', ['-id', toHex(wid), '_NET_WM_STATE', 'WM_CLASS', '_NET_WM_WINDOW_TYPE', '_NET_WM_NAME', 'WM_NAME'])
    }
    // Append a driver-side read after the app snapshots.
    const driverSnapshot = sh('xprop', ['-id', toHex(wid), '_NET_WM_STATE', 'WM_CLASS', '_NET_WM_WINDOW_TYPE', '_NET_WM_NAME'])
    fs.appendFileSync(
      XPROP_FILE,
      `\n===== driver-read | ${new Date().toISOString()} | wid=${toHex(wid)} =====\n` +
        `--- xprop -id ${toHex(wid)} _NET_WM_STATE WM_CLASS _NET_WM_WINDOW_TYPE _NET_WM_NAME (exit ${driverSnapshot.code}) ---\n` +
        (driverSnapshot.stdout || '') +
        (driverSnapshot.stderr ? `[stderr] ${driverSnapshot.stderr}` : '')
    )
    summary.xprop.snapshots = parseAtoms(readText(XPROP_FILE))
    summary.xprop.atoms_all_present = summary.xprop.snapshots.some((snapshot) =>
      ATOM_NAMES.every((atom) => snapshot.atoms[atom] === true)
    )

    // --- wmctrl evidence.
    const wm = sh('wmctrl', ['-l'])
    const wmLines = String(wm.stdout || '').split('\n').filter(Boolean)
    fs.writeFileSync(WMCTRL_FILE, `${wm.stdout || ''}`)
    summary.wmctrl.lines = wmLines
    summary.wmctrl.quickask_listed = wmLines.some((line) => line.includes('QAATOMSG4'))
    summary.wmctrl.note =
      'KWin still lists the window in _NET_CLIENT_LIST (wmctrl -l). ' +
      'SKIP_TASKBAR/SKIP_PAGER affect taskbar/pager; the Alt+Tab assertion ' +
      'is the switcher screenshots plus KWin skipSwitcher introspection.'

    // --- N real Alt+Tab cycles.
    for (let n = 1; n <= runs; n += 1) {
      const run = { n, screenshot: path.join(EVID, `task-7-alt-tab-${n}.png`), ocr: path.join(EVID, `task-7-alt-tab-${n}.ocr.txt`) }
      run.quickask_focus = await activateAndVerify(wid)
      run.target_focus = await activateAndVerify(target.wid)
      let altDown = false
      try {
        xdo('keydown', 'alt')
        altDown = true
        xdo('key', 'Tab')
        await sleep(400)
        const shot = sh('spectacle', ['-b', '-n', '-f', '-o', run.screenshot], { timeout: 20000 })
        run.spectacle_exit = shot.code
        run.spectacle_stderr = shot.stderr.trim()
        const ocr = sh('tesseract', [run.screenshot, 'stdout'], { timeout: 20000 })
        run.ocr_exit = ocr.code
        run.ocr_text = ocr.stdout
        fs.writeFileSync(run.ocr, ocr.stdout || '')
        run.qaatom_visible_in_switcher = /QAATOMSG4/i.test(ocr.stdout)
        run.ocr_mentions_opencode = /opencode/i.test(ocr.stdout)
      } catch (error) {
        run.error = error.message
      } finally {
        if (altDown) xdo('keyup', 'alt')
        run.alt_released = true
      }
      await sleep(250)
      run.focus_after = focusOf()
      run.focus_after_hex = toHex(run.focus_after)
      summary.alt_tab.push(run)
    }

    summary.pass = summary.alt_tab.length === runs && summary.alt_tab.every((run) => run.qaatom_visible_in_switcher === false)
    summary.pass = summary.pass && summary.xprop.atoms_all_present === true
  } catch (error) {
    summary.error = error.message
  } finally {
    // Always release Alt, restore focus, and stop only the processes we started.
    xdo('keyup', 'alt')
    if (originalActive) {
      const restored = await activateAndVerify(originalActive, 6)
      summary.cleanup.focus_restored = restored
      summary.cleanup.focus_after_restore = focusOf()
    }
    summary.cleanup.alt_released = true
    if (target) {
      await target.stop()
      summary.cleanup.target_stopped = true
    }
    if (atomsApp) {
      await atomsApp.stop()
      summary.cleanup.atoms_app_stopped = true
    }
    const electronLeft = sh('pgrep', ['-x', 'electron'])
    summary.cleanup.electron_leftover_pids = String(electronLeft.stdout || '').trim()
    summary.cleanup.finished_at = new Date().toISOString()
  }

  const outPath = argValue('--out') || path.join(EVID, 'task-7-alt-tab-summary.json')
  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`[atoms-check] runs=${summary.alt_tab.length} pass=${summary.pass} out=${outPath}\n`)
  for (const run of summary.alt_tab) {
    process.stdout.write(
      `[atoms-check] run ${run.n}: quickask_focus=${run.quickask_focus} target_focus=${run.target_focus} ` +
        `qaatom_in_switcher=${run.qaatom_visible_in_switcher} screenshot=${run.screenshot}\n`
    )
  }
  process.stdout.write(`[atoms-check] focus_restored=${summary.cleanup.focus_restored}\n`)
}

main().catch((error) => {
  process.stderr.write(`[atoms-check] FATAL ${error && error.stack ? error.stack : error}\n`)
  process.exit(1)
})
