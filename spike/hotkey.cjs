'use strict';

/*
 * QuickAsk M0 spike — G2/G3 hotkey → input latency + hidden → show latency.
 *
 * Throwaway measurement harness. Does NOT touch src/ business code.
 *
 * Launch (driver does this):
 *   source scripts/env.sh
 *   ./node_modules/.bin/electron spike/hotkey.cjs \
 *     --strategy show-focus|helper-activate|helper-grab \
 *     --samples-out .omo/evidence/task-4-samples.jsonl \
 *     --max-samples 20
 *
 * Strategy semantics
 *   show-focus       win.show(); win.focus(); arm renderer
 *   helper-activate  win.show(); native/quickask-x11 activate <wid>; win.focus(); arm
 *   helper-grab      native/quickask-x11 grab-hotkey ctrl+alt+space holds the XGrabKey,
 *                    emits KEYPRESS=<xkey.time>; main uses that timestamp for activate
 *
 * Contract with tools/nfr01.mjs / tools/nfr03.mjs
 *   stdout lines: HOTKEY_REGISTERED=true|false, APP_READY, WID=0x..., SAMPLE {...},
 *                 HIDDEN, MAX_SAMPLES_REACHED, IDLE_TIMEOUT
 *   samples file: one JSON object per line, appended atomically
 */

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EVID = path.join(ROOT, '.omo', 'evidence');
const HELPER = path.join(ROOT, 'native', 'quickask-x11');
const INDEX = path.join(__dirname, 'hotkey.html');
const PRELOAD = path.join(__dirname, 'hotkey-preload.cjs');

fs.mkdirSync(EVID, { recursive: true });

// ---------------------------------------------------------------- CLI parsing
const rawArgs = process.argv.slice(1);
function argValue(name) {
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === name) return rawArgs[i + 1];
    if (a.startsWith(name + '=')) return a.slice(name.length + 1);
  }
  return undefined;
}
function hasFlag(name) {
  return rawArgs.includes(name);
}

const STRATEGY = argValue('--strategy') || 'show-focus';
const SAMPLES_OUT = path.resolve(argValue('--samples-out') || path.join(EVID, 'task-4-hotkey-samples.jsonl'));
const MAX_SAMPLES = Number(argValue('--max-samples') || 0);
const IDLE_TIMEOUT_MS = Number(argValue('--idle-timeout-ms') || 90000);
const HOTKEY = argValue('--hotkey') || 'Control+Alt+Space';
const HOTKEY_XDOTOOL = argValue('--hotkey-xdotool') || 'ctrl+alt+space';
const HIDE_DELAY_MS = Number(argValue('--hide-delay-ms') || 600);
const processStartMs = Date.now();
let bootT0 = processStartMs;

const WIN_X = 100;
const WIN_Y = 100;
const WIN_W = 760;
const WIN_H = 128;
const CARD_CSS = { x: 40, y: 28, w: 680, h: 48 };

// ---------------------------------------------------------------- app setup
const SPIKE_USERDATA = path.join(ROOT, '.cache', 'spike-hotkey-userdata');
fs.mkdirSync(SPIKE_USERDATA, { recursive: true });
app.setPath('userData', SPIKE_USERDATA);

app.commandLine.appendSwitch('class', 'quickask');
app.commandLine.appendSwitch('name', 'quickask');
app.setName('quickask');
if (process.platform === 'linux' && process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// ---------------------------------------------------------------- logging
function out(line) {
  process.stdout.write(line + '\n');
}
function log(line) {
  out(`[${new Date().toISOString()}] ${line}`);
}
function hexWid(wid) {
  return '0x' + Number(wid).toString(16);
}

// ---------------------------------------------------------------- native helper
function runHelper(args, label) {
  if (!fs.existsSync(HELPER)) {
    log(`helper MISSING at ${HELPER}`);
    return { status: 127, stdout: '', stderr: 'missing helper' };
  }
  const t0 = Date.now();
  const r = spawnSync(HELPER, args.map(String), {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
    timeout: 5000,
  });
  const detail = `helper[${label}] ${args.join(' ')} -> exit ${r.status} took=${Date.now() - t0}ms` +
    ` out=${(r.stdout || '').trim()} err=${(r.stderr || '').trim()}`;
  log(detail);
  return r;
}
function runXdotool(args, label) {
  const r = spawnSync('xdotool', args.map(String), {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
    timeout: 5000,
  });
  if (r.status !== 0) {
    log(`xdotool[${label}] ${args.join(' ')} -> exit ${r.status} err=${(r.stderr || '').trim()}`);
  }
  return r;
}

// ---------------------------------------------------------------- geometry
let scaleFactor = 1;
let cardDev = { ...CARD_CSS };

function initGeometry() {
  const d = screen.getPrimaryDisplay();
  scaleFactor = d.scaleFactor || 1;
  cardDev = {
    x: Math.round(CARD_CSS.x * scaleFactor),
    y: Math.round(CARD_CSS.y * scaleFactor),
    w: Math.round(CARD_CSS.w * scaleFactor),
    h: Math.round(CARD_CSS.h * scaleFactor),
  };
  log(
    `geometry display=${d.bounds.width}x${d.bounds.height} scale=${scaleFactor} card=` +
      `${cardDev.x},${cardDev.y},${cardDev.w},${cardDev.h}`
  );
}

// ---------------------------------------------------------------- X11
function getWid(win) {
  try {
    const buf = win.getNativeWindowHandle();
    if (!buf || buf.length < 4) return 0;
    if (buf.length >= 8) return Number(buf.readBigUInt64LE(0) & 0xffffffffn);
    return buf.readUInt32LE(0);
  } catch (e) {
    log(`getNativeWindowHandle failed: ${e.message}`);
    return 0;
  }
}

let wid = 0;

function helperRect() {
  return `${cardDev.x},${cardDev.y},${cardDev.w},${cardDev.h}`;
}

function applyX11Full(label) {
  if (!wid) {
    log(`applyX11Full(${label}): missing WID`);
    return;
  }
  const hex = hexWid(wid);
  // Electron 45 keeps WM_CLASS=electron for BrowserWindows (Task 3 finding);
  // set it explicitly before the first map so xdotool --class quickask finds us.
  runHelper(['set-wm-class', hex, 'quickask', 'quickask'], label);
  runHelper(['set-states', hex], label);
  runHelper(['set-blur', hex, helperRect()], label);
  runHelper(['set-input-shape', hex, helperRect()], label);
}

function applyX11StatesAfterShow(label) {
  if (!wid) return;
  const hex = hexWid(wid);
  runHelper(['set-states', hex], label);
  runHelper(['set-blur', hex, helperRect()], label);
  runHelper(['set-input-shape', hex, helperRect()], label);
}

function xFocusWid() {
  const r = runXdotool(['getwindowfocus'], 'getwindowfocus');
  if (r.status !== 0) return { dec: 0, hex: '0x0', error: (r.stderr || '').trim() };
  const text = (r.stdout || '').trim();
  const dec = Number.parseInt(text, 10);
  return { dec: Number.isFinite(dec) ? dec : 0, hex: Number.isFinite(dec) ? hexWid(dec) : '0x0' };
}

function xMapState() {
  if (!wid) return 'no-wid';
  const r = spawnSync('xwininfo', ['-id', hexWid(wid)], {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
    timeout: 5000,
  });
  const m = /Map State:\s*(\w+)/.exec(r.stdout || '');
  return m ? m[1] : 'unknown';
}

// ---------------------------------------------------------------- window
let win = null;
const pendingSamples = new Map(); // seq -> partial sample
let currentSeq = 0;
let currentSample = null;
let samplesWritten = 0;
let shuttingDown = false;
let idleTimer = null;
let hideTimer = null;

function armSample(seq, hotkey_ms) {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  currentSample = {
    seq,
    hotkey_ms,
    strategy: STRATEGY,
    wid: hexWid(wid),
    focus_ms: null,
    raf1_ms: null,
    raf2_ms: null,
    focus_active_element: null,
    focus_source: null,
    raf1_delta_ms: null,
    raf2_delta_ms: null,
    perf: {},
    received_at_ms: Date.now(),
  };
  pendingSamples.set(seq, currentSample);
  currentSeq = seq;
  // Incomplete samples (e.g. renderer never painted) must still be recorded,
  // never silently dropped.
  currentSample.hardTimer = setTimeout(() => {
    if (pendingSamples.has(seq)) finalizeSample(currentSample, 'timeout');
  }, 1500);
}

function finalizeSample(sample, reason) {
  if (!sample || sample.finalized) return;
  sample.finalized = true;
  sample.finalized_reason = reason;
  if (sample.hardTimer) {
    clearTimeout(sample.hardTimer);
    sample.hardTimer = null;
  }

  // Focus evidence at sample time: renderer activeElement + real X focus.
  const xf = xFocusWid();
  sample.x_focus_wid = xf.dec;
  sample.x_focus_hex = xf.hex;
  sample.x_focus_ok = xf.dec === wid;
  sample.x_map_state = xMapState();
  sample.complete = sample.focus_ms != null && sample.raf1_ms != null && sample.raf2_ms != null;

  // Latencies are derived in the driver from wall-clock fields, but keep the
  // mapped performance.now() anchors in the raw record for auditability.
  if (sample.focus_ms != null) sample.focus_latency_ms = sample.focus_ms - sample.hotkey_ms;
  if (sample.raf1_ms != null) sample.raf1_latency_ms = sample.raf1_ms - sample.hotkey_ms;
  if (sample.raf2_ms != null) sample.raf2_latency_ms = sample.raf2_ms - sample.hotkey_ms;

  try {
    fs.appendFileSync(SAMPLES_OUT, JSON.stringify(sample) + '\n');
    samplesWritten += 1;
  } catch (e) {
    log(`failed to append sample: ${e.message}`);
  }
  pendingSamples.delete(sample.seq);
  log(
    `SAMPLE ${JSON.stringify({
      seq: sample.seq,
      hotkey_ms: sample.hotkey_ms,
      focus_ms: sample.focus_ms,
      raf1_ms: sample.raf1_ms,
      raf2_ms: sample.raf2_ms,
      focus_latency_ms: sample.focus_latency_ms,
      raf_latency_ms: sample.raf2_latency_ms,
      x_focus_ok: sample.x_focus_ok,
      active: sample.focus_active_element,
      complete: sample.complete,
    })}`
  );
  log(
    `FOCUS_CHECK seq=${sample.seq} renderer_active_element=${sample.focus_active_element}` +
      ` x_focus=${sample.x_focus_hex} app_wid=${hexWid(wid)} match=${sample.x_focus_ok}` +
      ` map_state=${sample.x_map_state}`
  );

  const finish = () => {
    if (shuttingDown) return;
    win.hide();
    out('HIDDEN');
    if (currentSample === sample) currentSample = null;
    if (MAX_SAMPLES > 0 && samplesWritten >= MAX_SAMPLES) {
      out('MAX_SAMPLES_REACHED');
      setTimeout(() => quitCleanly('max-samples'), 50);
    }
  };
  hideTimer = setTimeout(finish, HIDE_DELAY_MS);
}

function maybeFinalize(sample) {
  if (sample.focus_ms != null && sample.raf1_ms != null && sample.raf2_ms != null) {
    finalizeSample(sample, 'complete');
  }
}

ipcMain.on('renderer:timing', (_event, data) => {
  if (!data || typeof data !== 'object') return;
  const seq = data.seq;
  const sample = pendingSamples.get(seq);
  if (!sample) return;
  const kind = data.kind;
  const wall = Number.isFinite(data.wall_ms) ? data.wall_ms : Date.now();

  if (kind === 'focus') {
    if (sample.focus_ms == null) {
      sample.focus_ms = wall;
      sample.focus_source = data.source || null;
      sample.focus_active_element = data.active_element || null;
      sample.perf.focus_perf_now_ms = data.perf_now_ms;
      sample.perf.focus_arm_perf_ms = data.arm_perf_ms ?? null;
      sample.perf.focus_arm_wall_ms = data.arm_wall_ms ?? null;
      if (Number.isFinite(data.arm_perf_ms) && Number.isFinite(data.arm_wall_ms)) {
        sample.perf.focus_mapped_wall_ms =
          data.arm_wall_ms + (data.perf_now_ms - data.arm_perf_ms);
      }
    }
  } else if (kind === 'raf1') {
    if (sample.raf1_ms == null) {
      sample.raf1_ms = wall;
      sample.raf1_delta_ms = data.raf_delta_ms ?? null;
      sample.perf.raf1_perf_now_ms = data.perf_now_ms;
      sample.perf.raf1_delta_ms = data.raf_delta_ms ?? null;
    }
  } else if (kind === 'raf2') {
    if (sample.raf2_ms == null) {
      sample.raf2_ms = wall;
      sample.raf2_delta_ms = data.raf_delta_ms ?? null;
      sample.perf.raf2_perf_now_ms = data.perf_now_ms;
      sample.perf.raf2_delta_ms = data.raf_delta_ms ?? null;
    }
  }
  maybeFinalize(sample);
});

function triggerShow(seq, hotkey_ms) {
  currentSample.received_at_ms = Date.now();
  log(`hotkey fired seq=${seq} strategy=${STRATEGY} hotkey_ms=${hotkey_ms}`);

  if (STRATEGY === 'show-focus') {
    win.show();
    win.focus();
  } else if (STRATEGY === 'helper-activate') {
    win.show();
    runHelper(['activate', hexWid(wid)], `activate-${seq}`);
    win.focus();
  } else if (STRATEGY === 'helper-grab') {
    // Held by the helper; KEYPRESS timestamp is delivered via stdout.
    win.show();
    // focus happens in onHelperKeypress() once the real xkey.time arrives.
  } else {
    log(`unknown strategy '${STRATEGY}', falling back to show-focus`);
    win.show();
    win.focus();
  }

  // Arm the renderer before re-asserting X11 properties so the measured
  // hotkey→input latency is not inflated by helper process spawns.
  win.webContents.send('renderer:arm', { seq, arm_wall_ms: Date.now() });

  // Re-assert atoms/blur/shape after the show (Task 2/3 pattern); KWin may
  // rewrite _NET_WM_STATE during mapping.
  applyX11StatesAfterShow(`post-show-${seq}`);
}

// ---------------------------------------------------------------- helper-grab fallback
let grabProcess = null;

function startHelperGrab() {
  if (!fs.existsSync(HELPER)) {
    log('helper-grab: helper missing');
    return false;
  }
  grabProcess = spawn(HELPER, ['grab-hotkey', HOTKEY_XDOTOOL], {
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  grabProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      log(`helper-grab stdout: ${line}`);
      const m = /^KEYPRESS=(\d+)/.exec(line);
      if (m) onHelperKeypress(Number(m[1]));
      if (/^GRABBED=/.test(line)) out(line);
    }
  });
  grabProcess.stderr.on('data', (c) => log(`helper-grab stderr: ${c.toString().trim()}`));
  grabProcess.on('exit', (code, signal) => log(`helper-grab exited code=${code} signal=${signal}`));
  return true;
}

function onHelperKeypress(xkeyTime) {
  if (!currentSample) return;
  const seq = currentSample.seq;
  runHelper(['activate', hexWid(wid), String(xkeyTime)], `grab-activate-${seq}`);
  win.focus();
  win.webContents.send('renderer:arm', { seq, arm_wall_ms: Date.now() });
}

// ---------------------------------------------------------------- hotkey
function onHotkey() {
  if (shuttingDown) return;
  if (currentSample) {
    log('HOTKEY_IGNORED while sample pending');
    return;
  }
  resetIdleTimer();
  const seq = ++currentSeq;
  const hotkey_ms = Date.now();
  armSample(seq, hotkey_ms);
  triggerShow(seq, hotkey_ms);
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (shuttingDown) return;
    out('IDLE_TIMEOUT');
    log(`no samples for ${IDLE_TIMEOUT_MS}ms, quitting`);
    quitCleanly('idle-timeout');
  }, IDLE_TIMEOUT_MS);
}

// ---------------------------------------------------------------- lifecycle
function quitCleanly(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`quit (${reason})`);
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
  if (idleTimer) clearTimeout(idleTimer);
  if (hideTimer) clearTimeout(hideTimer);
  if (grabProcess) {
    try {
      grabProcess.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(exitCode);
}

process.on('SIGTERM', () => quitCleanly('SIGTERM'));
process.on('SIGINT', () => quitCleanly('SIGINT'));

app.on('window-all-closed', () => {
  // The spike owns the lifecycle; never auto-quit on window close.
});

app.whenReady().then(async () => {
  fs.writeFileSync(SAMPLES_OUT, '');
  bootT0 = Date.now();
  log(`boot: app-ready after ${bootT0 - processStartMs}ms (process start)`);
  if (hasFlag('--debug-heartbeat')) {
    setInterval(() => log(`HB +${Date.now() - processStartMs}`), 400);
  }
  initGeometry();

  log(
    `start strategy=${STRATEGY} samples_out=${SAMPLES_OUT} max_samples=${MAX_SAMPLES}` +
      ` idle_timeout_ms=${IDLE_TIMEOUT_MS} hotkey=${HOTKEY}`
  );
  log(`DISPLAY=${process.env.DISPLAY} electron=${process.versions.electron} chrome=${process.versions.chrome}`);

  win = new BrowserWindow({
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    useContentSize: true,
    width: WIN_W,
    height: WIN_H,
    x: WIN_X,
    y: WIN_Y,
    title: 'QuickAsk G2 spike',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setBackgroundColor('#00000000');
  log(`boot: window created at +${Date.now() - bootT0}ms`);

  const loadStart = Date.now();
  // loadFile() resolves after did-finish-load; do not add a second waiter
  // here (a late-attached did-finish-load listener used to cost 8s per start).
  await win.loadFile(INDEX);
  log(`boot: loadFile done at +${Date.now() - bootT0}ms (load ${Date.now() - loadStart}ms)`);

  const widT0 = Date.now();
  wid = getWid(win);
  log(`boot: getWid took ${Date.now() - widT0}ms -> ${wid ? hexWid(wid) : '0'}`);
  if (!wid) {
    out('FATAL=NO_WID');
    quitCleanly('no-wid');
    return;
  }

  // Props must be applied before the first map (WM_CLASS is the big one).
  applyX11Full('pre-show');

  let registered = false;
  if (STRATEGY === 'helper-grab') {
    registered = startHelperGrab();
    out(`HOTKEY_REGISTERED=${registered}`);
  } else {
    registered = globalShortcut.register(HOTKEY, onHotkey);
    out(`HOTKEY_REGISTERED=${registered}`);
    if (!registered) {
      log(`globalShortcut.register('${HOTKEY}') returned false`);
    }
  }
  if (!registered) {
    quitCleanly('hotkey-register-failed', 1);
    return;
  }

  out(`WID=${hexWid(wid)}`);
  log(`boot: APP_READY at +${Date.now() - processStartMs}ms from process start`);
  out('APP_READY');
  resetIdleTimer();
}).catch((e) => {
  out(`FATAL=${e && e.stack ? e.stack : e}`);
  quitCleanly('fatal');
});
