'use strict';

/*
 * QuickAsk M0 spike — G1 (transparency/rounded/shadow) + G5 (compositor degrade).
 *
 * Throwaway probe. Does NOT touch src/ business code.
 *
 * Launch:
 *   source scripts/env.sh && ./node_modules/.bin/electron spike/main.cjs
 *
 * Self-tests:
 *   --self-test cycle  100x show/hide (250ms shown / 150ms hidden)
 *   --self-test sizes  10 rounds S1 760x128 <-> S2 760x400 <-> S3 1024x400
 *   --self-test blur   10x set-blur/clear-blur (full rect / inset 2px)
 *   --self-test opaque non-transparent fallback window (compositor-off probe)
 *   --self-test g5     transparent phase then opaque phase (driven by capture script)
 *
 * Extra flags:
 *   --variant <name>          evidence tag for cycle runs
 *   --disable-gpu             pass through to Chromium
 *   --enable-transparent-visuals
 */

const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EVID = path.join(ROOT, '.omo', 'evidence');
const HELPER = path.join(ROOT, 'native', 'quickask-x11');
const SHAPE_QUERY = path.join(EVID, 'x11-shape-query');
const PYTHON = process.env['PYTHON'] ?? 'python3';
const FIND_COMPOSITOR = path.join(ROOT, 'tools', 'find-compositor-window.py');
const COMPOSITOR_WID_FILE = path.join(EVID, 'task-3-compositor-window.txt');
const XWD_ALPHA = path.join(ROOT, 'tools', 'xwd-alpha.py');
const INDEX = path.join(__dirname, 'index.html');

fs.mkdirSync(EVID, { recursive: true });

// ---------------------------------------------------------------- CLI parsing
const rawArgs = process.argv.slice(1);
function argValue(name) {
  const i = rawArgs.indexOf(name);
  return i >= 0 ? rawArgs[i + 1] : undefined;
}
function hasFlag(name) {
  return rawArgs.includes(name);
}

const selfTest = argValue('--self-test') || 'manual';
const gpuOff = hasFlag('--disable-gpu');
const transparentVisuals = hasFlag('--enable-transparent-visuals');
let variant = argValue('--variant');
if (!variant) {
  if (transparentVisuals) variant = 'transparent-visuals';
  else if (gpuOff) variant = 'gpu-off';
  else variant = 'gpu-on';
}

const CYCLE_COUNT = Number(argValue('--cycles') || 100);
const MODE = selfTest;
const TAG =
  MODE === 'cycle' ? `cycle-${variant}` :
  MODE === 'sizes' ? 'sizes' :
  MODE === 'blur' ? 'blur' :
  MODE === 'opaque' ? 'opaque' :
  MODE === 'g5' ? 'g5' :
  'manual';

const RUN_LOG = path.join(EVID, `task-3-${TAG}.log`);
const INFO_FILE = path.join(EVID, 'task-3-spike-info.json');
const TAG_INFO_FILE = path.join(EVID, `task-3-${TAG}-info.json`);

// ---------------------------------------------------------------- Chromium switches (before ready)
// Isolate spike Chromium state from the user's real QuickAsk profile and $HOME.
const SPIKE_USERDATA = path.join(ROOT, '.cache', 'spike-userdata');
fs.mkdirSync(SPIKE_USERDATA, { recursive: true });
app.setPath('userData', SPIKE_USERDATA);

app.commandLine.appendSwitch('class', 'quickask');
app.commandLine.appendSwitch('name', 'quickask');
app.setName('quickask');
if (process.platform === 'linux' && process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  // Force X11 so getNativeWindowHandle() is an XID for native/quickask-x11.
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}
if (gpuOff) app.commandLine.appendSwitch('disable-gpu');
if (transparentVisuals) app.commandLine.appendSwitch('enable-transparent-visuals');

// ---------------------------------------------------------------- logging utils
function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  fs.appendFileSync(RUN_LOG, text);
  process.stdout.write(text);
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}
function collectGpuStatus(file) {
  let status = {};
  try {
    status = app.getGPUFeatureStatus();
  } catch (e) {
    status = { error: String(e && e.message ? e.message : e) };
  }
  writeJson(file, {
    generated_at: new Date().toISOString(),
    mode: MODE,
    variant,
    gpu_feature_status: status,
    argv: process.argv,
  });
  log(`gpuFeatureStatus=${JSON.stringify(status)}`);
  return status;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sleepUntil(ts) {
  const d = ts - Date.now();
  if (d > 0) await sleep(d);
}
function hexWid(wid) {
  return '0x' + Number(wid).toString(16);
}

// ---------------------------------------------------------------- geometry
const WIN_X = 100;
const WIN_Y = 100;
const WIN_W = 760;
const WIN_H = 128;
const CARD_CSS = { x: 40, y: 28, w: 680, h: 48 };
let scaleFactor = 1;
let cardDev = { x: 40, y: 28, w: 680, h: 48 };
let displayInfo = null;

function initGeometry() {
  const d = screen.getPrimaryDisplay();
  scaleFactor = d.scaleFactor || 1;
  cardDev = {
    x: Math.round(CARD_CSS.x * scaleFactor),
    y: Math.round(CARD_CSS.y * scaleFactor),
    w: Math.round(CARD_CSS.w * scaleFactor),
    h: Math.round(CARD_CSS.h * scaleFactor),
  };
  displayInfo = {
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
    size: d.size,
  };
  const info = {
    generated_at: new Date().toISOString(),
    mode: MODE,
    variant,
    tag: TAG,
    pid: process.pid,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    argv: process.argv,
    env: {
      DISPLAY: process.env.DISPLAY || null,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || null,
      XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE || null,
      XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP || null,
    },
    gpu_off: gpuOff,
    transparent_visuals: transparentVisuals,
    window_dip: { x: WIN_X, y: WIN_Y, width: WIN_W, height: WIN_H },
    card_css: CARD_CSS,
    card_device: cardDev,
    scale_factor: scaleFactor,
    display: displayInfo,
    screen: {
      width: d.bounds.width,
      height: d.bounds.height,
      scaleFactor: d.scaleFactor,
    },
  };
  writeJson(INFO_FILE, info);
  writeJson(TAG_INFO_FILE, info);
  return info;
}

function helperRect() {
  return `${cardDev.x},${cardDev.y},${cardDev.w},${cardDev.h}`;
}

// ---------------------------------------------------------------- native helper
function runHelper(args, label) {
  if (!fs.existsSync(HELPER)) {
    log(`helper MISSING at ${HELPER}`);
    return { status: 127, stdout: '', stderr: 'missing helper' };
  }
  const r = spawnSync(HELPER, args.map(String), {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
  });
  log(
    `helper[${label}] ${args.join(' ')} -> exit ${r.status}` +
      ` out=${(r.stdout || '').trim()} err=${(r.stderr || '').trim()}`
  );
  return r;
}

function applyX11(win, label, setClass = false) {
  const wid = getWid(win);
  if (!wid) {
    log(`applyX11(${label}): missing WID`);
    return 0;
  }
  const hex = hexWid(wid);
  // Electron keeps WM_CLASS = "electron","electron" for BrowserWindows even
  // with app.setName()/--class. Set it explicitly so xdotool search works.
  if (setClass) runHelper(['set-wm-class', hex, 'quickask', 'quickask'], label);
  runHelper(['set-states', hex], label);
  runHelper(['set-blur', hex, helperRect()], label);
  runHelper(['set-input-shape', hex, helperRect()], label);
  log(`applyX11(${label}) wid=${hex} rect=${helperRect()} scale=${scaleFactor}`);
  return wid;
}

function setWmClass(win, label) {
  const wid = getWid(win);
  if (wid) {
    runHelper(['set-wm-class', hexWid(wid), 'quickask', 'quickask'], label);
  } else {
    log(`setWmClass(${label}): missing WID`);
  }
  return wid;
}

function getWid(win) {
  try {
    const buf = win.getNativeWindowHandle();
    if (!buf || buf.length < 4) return 0;
    if (buf.length >= 8) {
      return Number(buf.readBigUInt64LE(0) & 0xffffffffn);
    }
    return buf.readUInt32LE(0);
  } catch (e) {
    log(`getNativeWindowHandle failed: ${e.message}`);
    return 0;
  }
}

function runCmd(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
  });
  return r;
}

function xpropDump(wid, file, label) {
  if (!wid) return;
  const hex = hexWid(wid);
  const parts = [];
  parts.push(`\n===== ${label} | ${new Date().toISOString()} | wid=${hex} =====\n`);
  const jobs = [
    [
      'xprop',
      [
        '-id', hex,
        '_NET_WM_STATE',
        '_KDE_NET_WM_BLUR_BEHIND_REGION',
        '_NET_WM_NAME',
        'WM_CLASS',
        '_NET_WM_WINDOW_TYPE',
        'WM_HINTS',
      ],
    ],
    ['xwininfo', ['-id', hex]],
  ];
  if (fs.existsSync(SHAPE_QUERY)) {
    jobs.push([SHAPE_QUERY, [hex]]);
  } else {
    parts.push(`--- ${SHAPE_QUERY} missing (ShapeInput not queried) ---\n`);
  }
  for (const [cmd, args] of jobs) {
    const r = runCmd(cmd, args);
    parts.push(`--- ${cmd} ${args.join(' ')} (exit ${r.status}) ---\n`);
    parts.push(r.stdout || '');
    if (r.stderr) parts.push(`[stderr] ${r.stderr}`);
  }
  fs.appendFileSync(file, parts.join(''));
}

function kwinStateDump(file) {
  const lines = [];
  const jobs = [
    ['qdbus6', ['org.kde.KWin', '/Compositor', 'org.kde.kwin.Compositing.active']],
    ['qdbus6', ['org.kde.KWin', '/Compositor', 'org.kde.kwin.Compositing.compositingType']],
    ['qdbus6', ['org.kde.KWin', '/Compositor', 'org.kde.kwin.Compositing.platformRequiresCompositing']],
    ['qdbus6', ['org.kde.KWin', '/Effects', 'org.kde.kwin.Effects.isEffectLoaded', 'blur']],
    ['qdbus6', ['org.kde.KWin', '/Effects', 'org.kde.kwin.Effects.activeEffects']],
    ['kreadconfig6', ['--file', 'kwinrc', '--group', 'Plugins', '--key', 'blurEnabled']],
    ['kreadconfig6', ['--file', 'kwinrc', '--group', 'Compositing', '--key', 'Enabled']],
    ['kreadconfig6', ['--file', 'kwinrc', '--group', 'Compositing', '--key', 'Backend']],
  ];
  for (const [cmd, args] of jobs) {
    const r = runCmd(cmd, args);
    lines.push(`$ ${cmd} ${args.join(' ')}\n[exit ${r.status}]`);
    lines.push(`stdout: ${(r.stdout || '').trim()}`);
    lines.push(`stderr: ${(r.stderr || '').trim()}`);
    lines.push('');
  }
  fs.writeFileSync(file, lines.join('\n'));
}

let captureWid = 0;

function isValidXWindow(wid) {
  if (!wid) return false;
  const r = runCmd('xwininfo', ['-id', hexWid(wid)]);
  return r.status === 0;
}

function getCaptureWid() {
  if (captureWid && isValidXWindow(captureWid)) return captureWid;
  captureWid = 0;
  const envWid = process.env.QUICKASK_CAPTURE_WID;
  if (envWid) {
    const parsed = envWid.startsWith('0x') ? parseInt(envWid, 16) : parseInt(envWid, 10);
    if (Number.isFinite(parsed) && parsed > 0 && isValidXWindow(parsed)) {
      captureWid = parsed;
      log(`captureWid from env=${hexWid(captureWid)}`);
      return captureWid;
    }
  }
  if (fs.existsSync(COMPOSITOR_WID_FILE)) {
    const text = fs.readFileSync(COMPOSITOR_WID_FILE, 'utf8').trim();
    const m = /^0x[0-9a-f]+/i.exec(text);
    if (m && isValidXWindow(parseInt(m[0], 16))) {
      captureWid = parseInt(m[0], 16);
      log(`captureWid from file=${hexWid(captureWid)}`);
      return captureWid;
    }
  }
  if (fs.existsSync(FIND_COMPOSITOR)) {
    const r = spawnSync(PYTHON, [FIND_COMPOSITOR], {
      encoding: 'utf8',
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
    });
    const m = /^0x[0-9a-f]+/im.exec(r.stdout || '');
    if (r.status === 0 && m) {
      captureWid = parseInt(m[0], 16);
      fs.writeFileSync(COMPOSITOR_WID_FILE, hexWid(captureWid) + '\n');
      log(`captureWid from helper=${hexWid(captureWid)}`);
      return captureWid;
    }
    log(`find-compositor-window failed exit=${r.status} out=${(r.stdout || '').trim()} err=${(r.stderr || '').trim()}`);
  }
  log('WARN: no compositor window; falling back to root capture');
  return 0;
}

function displayCaptureTarget() {
  const wid = getCaptureWid();
  return wid ? hexWid(wid) : 'root';
}

function importRoot(file) {
  // IMPORTANT: import -window root only captures the root pixmap and misses all
  // KWin-composited windows on this machine. Capture KWin's workspace window
  // (found via tools/find-compositor-window.py) instead.
  const target = displayCaptureTarget();
  const r = runCmd('import', ['-window', target, file]);
  if (r.status !== 0) {
    log(`import -window ${target} ${file} FAILED exit=${r.status} err=${(r.stderr || '').trim()}`);
  } else {
    log(`import -window ${target} ${path.basename(file)} ok`);
  }
  return r.status === 0;
}

function runCmdTimeout(cmd, args, timeoutMs) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
  });
}

function captureScreen(file) {
  const methodFile = `${file}.method`;
  const captureMode = process.env.QUICKASK_SCREEN_CAPTURE || '';
  if (captureMode === 'root') {
    // With the compositor suspended, windows are drawn straight to the root
    // window, so a root capture DOES include them (unlike composited mode).
    const r = runCmd('import', ['-window', 'root', file]);
    if (r.status === 0 && fs.existsSync(file) && fs.statSync(file).size > 1000) {
      fs.writeFileSync(methodFile, 'root\n');
      log(`root capture ${path.basename(file)} ok (compositor-off raw screen)`);
      return true;
    }
    log(`root capture ${path.basename(file)} FAILED exit=${r.status}; falling back`);
    const ok = importRoot(file);
    fs.writeFileSync(methodFile, 'workspace\n');
    return ok;
  }
  const forceWorkspace = captureMode === 'workspace';
  if (!forceWorkspace) {
    // KWin's ScreenShot2 (used by spectacle) returns the real composited frame,
    // including always-on-top windows. It only works while the session is
    // unlocked; fall back to the workspace window capture otherwise.
    const r = runCmdTimeout('spectacle', ['-b', '-n', '-f', '-o', file], 6000);
    try {
      if (r.status === 0 && fs.existsSync(file) && fs.statSync(file).size > 1000) {
        fs.writeFileSync(methodFile, 'spectacle\n');
        log(`spectacle ${path.basename(file)} ok`);
        return true;
      }
    } catch {
      /* ignore */
    }
    log(
      `spectacle ${path.basename(file)} FAILED exit=${r.status} signal=${r.signal || ''}` +
        ` err=${(r.stderr || '').trim()}; falling back to workspace capture`
    );
  }
  const ok = importRoot(file);
  fs.writeFileSync(methodFile, 'workspace\n');
  return ok;
}

function captureWindow(wid, file) {
  if (!wid) {
    log(`captureWindow(${file}): missing WID`);
    return false;
  }
  const r = runCmd('import', ['-window', hexWid(wid), file]);
  if (r.status !== 0) {
    log(`import -window ${hexWid(wid)} ${file} FAILED exit=${r.status} err=${(r.stderr || '').trim()}`);
    return false;
  }
  log(`window capture ${path.basename(file)} ok`);
  return true;
}

function captureWindowAlpha(wid, pngFile, jsonFile) {
  if (!wid || !fs.existsSync(XWD_ALPHA)) {
    log(`captureWindowAlpha(${pngFile}): missing WID or tool`);
    return false;
  }
  const r = spawnSync(PYTHON, [XWD_ALPHA, '--wid', hexWid(wid), '--png', pngFile], {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
  });
  if (jsonFile) fs.writeFileSync(jsonFile, (r.stdout || '') + (r.stderr ? `\n[stderr] ${r.stderr}` : '') + '\n');
  if (r.status !== 0) {
    log(`xwd-alpha ${hexWid(wid)} FAILED exit=${r.status} err=${(r.stderr || '').trim()}`);
    return false;
  }
  log(`xwd-alpha ${path.basename(pngFile)} ok out=${(r.stdout || '').trim()}`);
  return true;
}

function captureSpikePair(wid, basePath) {
  captureWindow(wid, `${basePath}-window.png`);
  captureWindowAlpha(wid, `${basePath}-window-alpha.png`, `${basePath}-alpha.json`);
}

function x11MapState(wid) {
  if (!wid) return 'no-wid';
  const r = runCmd('xwininfo', ['-id', hexWid(wid)]);
  const m = /Map State:\s*(\w+)/.exec(r.stdout || '');
  return m ? m[1] : 'unknown';
}

async function waitForMapState(wid, state = 'IsViewable', timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (x11MapState(wid) === state) return true;
    await sleep(50);
  }
  log(`waitForMapState(${state}) timeout wid=${hexWid(wid)} actual=${x11MapState(wid)}`);
  return false;
}

async function waitForWindowSize(wid, width, height, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = runCmd('xwininfo', ['-id', hexWid(wid)]);
    const mw = /Width:\s*(\d+)/.exec(r.stdout || '');
    const mh = /Height:\s*(\d+)/.exec(r.stdout || '');
    if (mw && mh && Number(mw[1]) === width && Number(mh[1]) === height) {
      return true;
    }
    await sleep(50);
  }
  log(`waitForWindowSize(${width}x${height}) timeout wid=${hexWid(wid)}`);
  return false;
}

// ---------------------------------------------------------------- windows
const WEB_PREFS = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: false,
  backgroundThrottling: false,
};

function baseWindowOptions() {
  return {
    frame: false,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    useContentSize: true,
    width: WIN_W,
    height: WIN_H,
    x: WIN_X,
    y: WIN_Y,
    webPreferences: WEB_PREFS,
  };
}

function createTransparentWindow() {
  const win = new BrowserWindow({
    ...baseWindowOptions(),
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    title: 'QuickAsk G1 spike',
  });
  win.setBackgroundColor('#00000000');
  win.setAlwaysOnTop(true);
  win.loadFile(INDEX);
  log(`created transparent window wid=${hexWid(getWid(win))}`);
  return win;
}

function createOpaqueWindow() {
  const win = new BrowserWindow({
    ...baseWindowOptions(),
    transparent: false,
    backgroundColor: '#1c1e20',
    hasShadow: false,
    title: 'QuickAsk G5 opaque',
  });
  win.setAlwaysOnTop(true);
  win.loadFile(INDEX, { query: { opaque: '1' } });
  log(`created opaque window wid=${hexWid(getWid(win))}`);
  return win;
}

function waitReady(win, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (why) => {
      if (settled) return;
      settled = true;
      log(`window ready (${why})`);
      resolve(why);
    };
    win.once('ready-to-show', () => done('ready-to-show'));
    win.webContents.once('did-finish-load', () => done('did-finish-load'));
    setTimeout(() => done('timeout'), timeoutMs);
  });
}

async function waitForFile(file, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) return true;
    await sleep(50);
  }
  return false;
}

// ---------------------------------------------------------------- self-tests
async function runCycle(win) {
  const timingsFile = path.join(EVID, `task-3-cycle-timestamps-${variant}.json`);
  const canonicalTimings = path.join(EVID, 'task-3-cycle-timestamps.json');
  const xpropFile = path.join(EVID, `task-3-xprop-${variant}.txt`);
  const baselinePng = path.join(EVID, `task-3-cycle-${variant}-baseline.png`);
  const visiblePng = path.join(EVID, `task-3-cycle-${variant}-visible.png`);
  const visibleMidPng = path.join(EVID, `task-3-cycle-${variant}-visible-mid.png`);
  const hiddenPng = path.join(EVID, `task-3-cycle-${variant}-hidden.png`);
  const windowVisibleBase = path.join(EVID, `task-3-cycle-${variant}-visible`);
  const windowMidBase = path.join(EVID, `task-3-cycle-${variant}-visible-mid`);
  const windowHiddenBase = path.join(EVID, `task-3-cycle-${variant}-hidden`);

  fs.writeFileSync(xpropFile, '');
  kwinStateDump(path.join(EVID, `task-3-${TAG}-kwin-state.txt`));

  // Props are set after window creation, before the first map.
  const wid = applyX11(win, 'pre-show', true);
  fs.writeFileSync(path.join(EVID, `task-3-${TAG}-wid.txt`), hexWid(wid) + '\n');
  xpropDump(wid, xpropFile, `pre-show ${variant}`);

  // Let ffmpeg collect a background baseline; window is still unmapped.
  await sleep(700);
  captureScreen(baselinePng);
  await sleep(500);

  const cycles = [];
  let firstShowMs = 0;
  for (let i = 0; i < CYCLE_COUNT; i++) {
    const showMs = Date.now();
    if (i === 0) firstShowMs = showMs;
    win.show();
    win.focus();
    // Re-assert atoms/blur/shape after every show (KWin/Chromium may reset).
    await sleep(25);
    applyX11(win, `show-${i}`);
    const mapStateAfterShow = x11MapState(wid);
    if (i === 0 || i === CYCLE_COUNT - 1) {
      xpropDump(wid, xpropFile, `after-show-${i}`);
    }
    if (i === 0) {
      await sleepUntil(showMs + 120);
      await waitForMapState(wid);
      captureScreen(visiblePng);
      captureSpikePair(wid, windowVisibleBase);
    } else if (i === Math.floor(CYCLE_COUNT / 2)) {
      await sleepUntil(showMs + 120);
      captureScreen(visibleMidPng);
      captureSpikePair(wid, windowMidBase);
    } else {
      await sleepUntil(showMs + 250);
    }
    await sleepUntil(showMs + 250);
    const hideMs = Date.now();
    win.hide();
    if (i === 0) {
      await sleep(40);
      captureScreen(hiddenPng);
      captureWindow(wid, `${windowHiddenBase}-window.png`);
    }
    await sleepUntil(hideMs + 150);
    const mapStateAfterHide = x11MapState(wid);
    cycles.push({
      cycle: i,
      show_ms: showMs,
      hide_ms: hideMs,
      hide_to_next_show_ms: Date.now() - hideMs,
      map_state_after_show: mapStateAfterShow,
      map_state_after_hide: mapStateAfterHide,
    });
  }

  const payload = {
    generated_at: new Date().toISOString(),
    variant,
    gpu_off: gpuOff,
    transparent_visuals: transparentVisuals,
    mode: 'cycle',
    wid: hexWid(wid),
    scale_factor: scaleFactor,
    card_device: cardDev,
    window_dip: { x: WIN_X, y: WIN_Y, width: WIN_W, height: WIN_H },
    first_show_ms: firstShowMs,
    last_hide_ms: cycles[cycles.length - 1].hide_ms,
    cycle_count: cycles.length,
    cycles,
  };
  writeJson(timingsFile, payload);
  if (variant === 'gpu-on') {
    writeJson(canonicalTimings, payload);
  }

  // Final readback after the last hide.
  xpropDump(wid, xpropFile, 'final-after-last-hide');
  collectGpuStatus(path.join(EVID, `task-3-${TAG}-gpu.json`));
  log(`cycle done: ${cycles.length} cycles, wid=${hexWid(wid)}`);
  win.destroy();
  app.quit();
}

async function runSizes(win) {
  const boundsFile = path.join(EVID, 'task-3-sizes-bounds.json');
  const xpropFile = path.join(EVID, 'task-3-xprop-sizes.txt');
  fs.writeFileSync(xpropFile, '');
  kwinStateDump(path.join(EVID, `task-3-${TAG}-kwin-state.txt`));

  const wid = applyX11(win, 'pre-show', true);
  fs.writeFileSync(path.join(EVID, `task-3-${TAG}-wid.txt`), hexWid(wid) + '\n');
  xpropDump(wid, xpropFile, 'pre-show sizes');

  win.show();
  win.focus();
  await waitForMapState(wid);
  await sleep(30);
  applyX11(win, 'show-0');
  await waitForWindowSize(wid, WIN_W, WIN_H);
  await sleep(500);
  captureScreen(path.join(EVID, 'task-3-sizes-S1.png'));
  captureSpikePair(wid, path.join(EVID, 'task-3-sizes-S1'));

  const states = {
    S1: { width: 760, height: 128 },
    S2: { width: 760, height: 400 },
    S3: { width: 1024, height: 400 },
  };
  const order = [
    ['S1', 'S2'],
    ['S2', 'S3'],
    ['S3', 'S1'],
  ];
  const entries = [];
  for (let round = 0; round < 10; round++) {
    for (const [from, to] of order) {
      const target = states[to];
      const setMs = Date.now();
      win.setBounds({
        x: WIN_X,
        y: WIN_Y,
        width: target.width,
        height: target.height,
      });
      await sleep(30);
      applyX11(win, `size-${from}->${to}-r${round}`);
      await sleepUntil(setMs + 300);
      const actual = win.getBounds();
      entries.push({
        round,
        from,
        to,
        set_ms: setMs,
        bounds_dip: actual,
        bounds_device: {
          x: Math.round(actual.x * scaleFactor),
          y: Math.round(actual.y * scaleFactor),
          width: Math.round(actual.width * scaleFactor),
          height: Math.round(actual.height * scaleFactor),
        },
      });
      if (round === 0 && to !== 'S1') {
        await waitForWindowSize(wid, target.width, target.height);
        await sleep(400);
        captureScreen(path.join(EVID, `task-3-sizes-${to}.png`));
        captureSpikePair(wid, path.join(EVID, `task-3-sizes-${to}`));
      }
      if (round === 9 && to === 'S1') {
        xpropDump(wid, xpropFile, 'after-10-rounds');
      }
    }
  }

  // Restore S1 for the final readback.
  win.setBounds({ x: WIN_X, y: WIN_Y, width: WIN_W, height: WIN_H });
  await sleep(300);

  writeJson(boundsFile, {
    generated_at: new Date().toISOString(),
    mode: 'sizes',
    rounds: 10,
    transitions_per_round: order.length,
    total_transitions: entries.length,
    pause_ms: 300,
    scale_factor: scaleFactor,
    states,
    entries,
  });
  xpropDump(wid, xpropFile, 'final');
  collectGpuStatus(path.join(EVID, `task-3-${TAG}-gpu.json`));
  log(`sizes done: ${entries.length} transitions`);
  win.destroy();
  app.quit();
}

async function runBlur(win) {
  const xpropFile = path.join(EVID, 'task-3-blur-xprop.txt');
  const kwinFile = path.join(EVID, 'task-3-blur-kwin-state.txt');
  fs.writeFileSync(xpropFile, '');
  kwinStateDump(kwinFile);

  const wid = applyX11(win, 'pre-show', true);
  fs.writeFileSync(path.join(EVID, `task-3-${TAG}-wid.txt`), hexWid(wid) + '\n');
  xpropDump(wid, xpropFile, 'pre-show blur');
  win.show();
  win.focus();
  await waitForMapState(wid);
  await sleep(30);
  applyX11(win, 'show-0');
  await sleep(400);

  const full = { ...cardDev };
  const inset = {
    x: cardDev.x + 2,
    y: cardDev.y + 2,
    w: Math.max(1, cardDev.w - 4),
    h: Math.max(1, cardDev.h - 4),
  };
  const entries = [];

  for (let i = 0; i < 10; i++) {
    const useInset = i % 2 === 1;
    const rect = useInset ? inset : full;
    const setMs = Date.now();
    runHelper(['set-blur', hexWid(wid), `${rect.x},${rect.y},${rect.w},${rect.h}`], `blur-set-${i}`);
    xpropDump(wid, xpropFile, `blur-set-${i}-${useInset ? 'inset2' : 'full'}`);
    await sleep(150);
    captureScreen(path.join(EVID, `task-3-blur-set-${i}-${useInset ? 'inset' : 'full'}.png`));
    captureSpikePair(wid, path.join(EVID, `task-3-blur-set-${i}-${useInset ? 'inset' : 'full'}`));
    await sleepUntil(setMs + 300);

    const clearMs = Date.now();
    runHelper(['clear-blur', hexWid(wid)], `blur-clear-${i}`);
    xpropDump(wid, xpropFile, `blur-clear-${i}`);
    await sleep(150);
    captureScreen(path.join(EVID, `task-3-blur-clear-${i}.png`));
    captureSpikePair(wid, path.join(EVID, `task-3-blur-clear-${i}`));
    await sleepUntil(clearMs + 300);

    entries.push({
      iteration: i,
      rect_kind: useInset ? 'inset2' : 'full',
      rect_device: rect,
      set_ms: setMs,
      clear_ms: clearMs,
    });
  }

  // Leave blur set on the final full rect for a readback, then clear on exit.
  runHelper(['set-blur', hexWid(wid), `${full.x},${full.y},${full.w},${full.h}`], 'blur-final-set');
  xpropDump(wid, xpropFile, 'final-full-rect');
  writeJson(path.join(EVID, 'task-3-blur-toggles.json'), {
    generated_at: new Date().toISOString(),
    mode: 'blur',
    toggles: entries.length,
    full_rect_device: full,
    inset2_rect_device: inset,
    entries,
  });
  runHelper(['clear-blur', hexWid(wid)], 'blur-exit-clear');
  collectGpuStatus(path.join(EVID, `task-3-${TAG}-gpu.json`));
  log(`blur done: ${entries.length} set/clear toggles`);
  win.destroy();
  app.quit();
}

async function showOpaqueProbe(win, modeName) {
  const readyFile = path.join(EVID, `task-3-${modeName}-ready.json`);
  const goFile = path.join(EVID, `task-3-${modeName}-go`);
  try {
    fs.unlinkSync(goFile);
  } catch {
    /* ignore */
  }
  writeJson(readyFile, {
    generated_at: new Date().toISOString(),
    mode: modeName,
    wid: hexWid(getWid(win)),
    pid: process.pid,
    window_dip: { x: WIN_X, y: WIN_Y, width: WIN_W, height: WIN_H },
    card_device: cardDev,
    scale_factor: scaleFactor,
  });
  log(`waiting for ${goFile}`);
  const ok = await waitForFile(goFile, 15000);
  log(`go file ${ok ? 'seen' : 'TIMEOUT'}`);

  const showMs = Date.now();
  win.show();
  win.focus();
  const probeWid = getWid(win);
  fs.writeFileSync(path.join(EVID, `task-3-${modeName}-wid.txt`), hexWid(probeWid) + '\n');
  await waitForMapState(probeWid);
  await sleep(1000);
  const shot = path.join(EVID, `task-3-${modeName}.png`);
  captureScreen(shot);
  captureWindow(probeWid, path.join(EVID, `task-3-${modeName}-window.png`));
  await sleep(1000);
  win.hide();
  writeJson(path.join(EVID, `task-3-${modeName}-phases.json`), {
    generated_at: new Date().toISOString(),
    mode: modeName,
    go_seen: ok,
    show_ms: showMs,
    hide_ms: Date.now(),
    screenshot: shot,
  });
  log(`${modeName} probe done`);
  win.destroy();
  app.quit();
}

async function runOpaque() {
  kwinStateDump(path.join(EVID, 'task-3-opaque-kwin-state.txt'));
  const win = createOpaqueWindow();
  await waitReady(win);
  await sleep(300);
  setWmClass(win, 'opaque-class');
  collectGpuStatus(path.join(EVID, `task-3-${TAG}-gpu.json`));
  await showOpaqueProbe(win, 'opaque');
}

async function runG5() {
  kwinStateDump(path.join(EVID, 'task-3-g5-kwin-state.txt'));
  const transparent = createTransparentWindow();
  const opaque = createOpaqueWindow();
  await Promise.all([waitReady(transparent), waitReady(opaque)]);
  await sleep(300);
  setWmClass(transparent, 'g5-transparent-class');
  setWmClass(opaque, 'g5-opaque-class');
  collectGpuStatus(path.join(EVID, `task-3-${TAG}-gpu.json`));

  const readyFile = path.join(EVID, 'task-3-g5-ready.json');
  const goFile = path.join(EVID, 'task-3-g5-go');
  try {
    fs.unlinkSync(goFile);
  } catch {
    /* ignore */
  }
  writeJson(readyFile, {
    generated_at: new Date().toISOString(),
    mode: 'g5',
    transparent_wid: hexWid(getWid(transparent)),
    opaque_wid: hexWid(getWid(opaque)),
    pid: process.pid,
    window_dip: { x: WIN_X, y: WIN_Y, width: WIN_W, height: WIN_H },
    card_device: cardDev,
    scale_factor: scaleFactor,
  });
  log(`waiting for ${goFile}`);
  const ok = await waitForFile(goFile, 15000);
  log(`go file ${ok ? 'seen' : 'TIMEOUT'}`);

  const t0 = Date.now();
  transparent.show();
  transparent.focus();
  await waitForMapState(getWid(transparent));
  await sleep(40);
  applyX11(transparent, 'g5-transparent-show', true);
  const transparentWid = getWid(transparent);
  const opaqueWid = getWid(opaque);
  fs.writeFileSync(path.join(EVID, 'task-3-g5-transparent-wid.txt'), hexWid(transparentWid) + '\n');
  fs.writeFileSync(path.join(EVID, 'task-3-g5-opaque-wid.txt'), hexWid(opaqueWid) + '\n');
  await sleep(1160);
  captureScreen(path.join(EVID, 'task-3-g5-transparent.png'));
  captureSpikePair(transparentWid, path.join(EVID, 'task-3-g5-transparent'));
  await sleepUntil(t0 + 2500);
  transparent.hide();

  await sleep(250);
  const t1 = Date.now();
  opaque.show();
  opaque.focus();
  await waitForMapState(opaqueWid);
  await sleep(1160);
  captureScreen(path.join(EVID, 'task-3-g5-opaque.png'));
  captureWindow(opaqueWid, path.join(EVID, 'task-3-g5-opaque-window.png'));
  await sleepUntil(t1 + 2500);
  opaque.hide();
  await sleep(200);

  writeJson(path.join(EVID, 'task-3-g5-phases.json'), {
    generated_at: new Date().toISOString(),
    mode: 'g5',
    go_seen: ok,
    transparent_start_ms: t0,
    transparent_end_ms: t0 + 2500,
    opaque_start_ms: t1,
    opaque_end_ms: t1 + 2500,
    total_visible_ms: t1 + 2500 - t0,
    screenshots: {
      transparent: path.join(EVID, 'task-3-g5-transparent.png'),
      opaque: path.join(EVID, 'task-3-g5-opaque.png'),
    },
  });
  log('g5 phases done');
  transparent.destroy();
  opaque.destroy();
  app.quit();
}

async function runManual() {
  kwinStateDump(path.join(EVID, 'task-3-manual-kwin-state.txt'));
  const win = createTransparentWindow();
  await waitReady(win);
  await sleep(300);
  const wid = applyX11(win, 'manual-show', true);
  xpropDump(wid, path.join(EVID, 'task-3-manual-xprop.txt'), 'manual-show');
  win.show();
  win.focus();
  await sleep(50);
  applyX11(win, 'manual-after-show');
  await sleep(600);
  try {
    const dom = await win.webContents.executeJavaScript(`(() => {
      const card = document.getElementById('card');
      return {
        readyState: document.readyState,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
        cardExists: !!card,
        cardBackground: card ? getComputedStyle(card).backgroundColor : null,
        cardRect: card ? card.getBoundingClientRect().toJSON() : null,
        cardText: card ? card.innerText : null,
        devicePixelRatio: window.devicePixelRatio,
      };
    })()`);
    log(`DOM=${JSON.stringify(dom)}`);
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(EVID, 'task-3-manual-capture.png'), shot.toPNG());
    log(`capturePage saved task-3-manual-capture.png size=${JSON.stringify(shot.getSize())}`);
  } catch (e) {
    log(`DOM/capture debug failed: ${e.message}`);
  }
  collectGpuStatus(path.join(EVID, `task-3-${TAG}-gpu.json`));
  log(`manual window shown wid=${hexWid(wid)} (close window to exit)`);
}

// ---------------------------------------------------------------- bootstrap
app.on('window-all-closed', () => {
  if (MODE === 'manual') app.quit();
});

app.whenReady().then(async () => {
  fs.writeFileSync(RUN_LOG, '');
  initGeometry();
  log(`start mode=${MODE} tag=${TAG} variant=${variant} gpuOff=${gpuOff} transparentVisuals=${transparentVisuals}`);
  log(`scaleFactor=${scaleFactor} cardDev=${JSON.stringify(cardDev)}`);
  log(`captureTarget=${displayCaptureTarget()}`);
  log(`DISPLAY=${process.env.DISPLAY} WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY}`);
  log(`electron=${process.versions.electron} chrome=${process.versions.chrome}`);
  log(`app.getName()=${app.getName()} app.name=${app.name}`);

  try {
    if (MODE === 'cycle') {
      const win = createTransparentWindow();
      await waitReady(win);
      await sleep(300);
      await runCycle(win);
    } else if (MODE === 'sizes') {
      const win = createTransparentWindow();
      await waitReady(win);
      await sleep(300);
      await runSizes(win);
    } else if (MODE === 'blur') {
      const win = createTransparentWindow();
      await waitReady(win);
      await sleep(300);
      await runBlur(win);
    } else if (MODE === 'opaque') {
      await runOpaque();
    } else if (MODE === 'g5') {
      await runG5();
    } else {
      await runManual();
    }
  } catch (e) {
    log(`FATAL ${e && e.stack ? e.stack : e}`);
    app.exit(1);
  }
}).catch((e) => {
  fs.appendFileSync(RUN_LOG, `whenReady FATAL ${e && e.stack ? e.stack : e}\n`);
  app.exit(1);
});
