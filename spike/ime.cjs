'use strict';

/*
 * QuickAsk M0 spike — G6 fcitx5 Chinese IME / candidate window / composing
 * Enter+Esc spike.
 *
 * Throwaway harness. Does NOT touch src/ business code.
 *
 * Launch (tools/fcitx-check.sh does this):
 *   source scripts/env.sh
 *   XMODIFIERS=@im=fcitx GTK_IM_MODULE=fcitx QT_IM_MODULE=fcitx \
 *   QUICKASK_TEST_BASE_URL=http://127.0.0.1:18080/v1 \
 *   ./node_modules/.bin/electron spike/ime.cjs --idle-timeout-ms 600000
 *
 * stdout contract
 *   APP_READY
 *   WID=0x...
 *   INPUT_RECT_SCREEN={"x":...,"y":...,"width":...,"height":...}
 *   SEND_REQUESTED count=N
 *   WINDOW_HIDDEN
 *   SHORTCUT_IGNORED_COMPOSING name=...
 *   SHORTCUT_TRIGGERED name=...
 *
 * Evidence files (always .omo/evidence/, even if --out is used by driver)
 *   task-5-ime-state.json       latest state snapshot (rewritten per event)
 *   task-5-events.jsonl         one JSON object per forwarded DOM event
 *   task-5-shortcuts.jsonl      one JSON object per shortcut decision
 */

const { app, BrowserWindow, ipcMain, screen: electronScreen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'native', 'quickask-x11');
const INDEX = path.join(__dirname, 'ime.html');
const PRELOAD = path.join(__dirname, 'ime-preload.cjs');

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

const EVID = path.resolve(argValue('--evidence-dir') || path.join(ROOT, '.omo', 'evidence'));
const STATE_FILE = path.join(EVID, 'task-5-ime-state.json');
const EVENTS_FILE = path.join(EVID, 'task-5-events.jsonl');
const SHORTCUTS_FILE = path.join(EVID, 'task-5-shortcuts.jsonl');
fs.mkdirSync(EVID, { recursive: true });

const IDLE_TIMEOUT_MS = Number(argValue('--idle-timeout-ms') || 120000);
const AUTO_QUIT_MS = Number(argValue('--auto-quit-ms') || 0);
const BASE_URL = (process.env.QUICKASK_TEST_BASE_URL || 'http://127.0.0.1:18080/v1').replace(/\/+$/, '');
const POST_URL = `${BASE_URL}/chat/completions`;

const WIN_X = 100;
const WIN_Y = 100;
const WIN_W = 760;
const WIN_H = 160;
const CARD_CSS = { x: 40, y: 28, w: 680, h: 48 };

// ---------------------------------------------------------------- app setup
const SPIKE_USERDATA = path.join(ROOT, '.cache', 'spike-ime-userdata');
fs.mkdirSync(SPIKE_USERDATA, { recursive: true });
app.setPath('userData', SPIKE_USERDATA);

// G6 must run on X11. Never let Chromium pick Wayland even if a compositor
// session also exports WAYLAND_DISPLAY.
app.commandLine.appendSwitch('ozone-platform', 'x11');
app.commandLine.appendSwitch('class', 'quickask');
app.commandLine.appendSwitch('name', 'quickask');
app.setName('quickask');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// ---------------------------------------------------------------- logging
const processStartMs = Date.now();
function out(line) {
  process.stdout.write(line + '\n');
}
function log(line) {
  out(`[${new Date().toISOString()}] ${line}`);
}
function hexWid(wid) {
  return '0x' + Number(wid).toString(16);
}
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message ? e.message : e) });
  }
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
  log(
    `helper[${label}] ${args.join(' ')} -> exit ${r.status} took=${Date.now() - t0}ms` +
      ` out=${(r.stdout || '').trim()} err=${(r.stderr || '').trim()}`
  );
  return r;
}

// ---------------------------------------------------------------- geometry
let scaleFactor = 1;
let cardDev = { ...CARD_CSS };
let inputRectCss = null;
let wid = 0;

function initGeometry() {
  const d = electronScreen.getPrimaryDisplay();
  scaleFactor = d.scaleFactor || 1;
  cardDev = {
    x: Math.round(CARD_CSS.x * scaleFactor),
    y: Math.round(CARD_CSS.y * scaleFactor),
    w: Math.round(CARD_CSS.w * scaleFactor),
    h: Math.round(CARD_CSS.h * scaleFactor),
  };
  log(
    `geometry display=${d.bounds.width}x${d.bounds.height} scale=${scaleFactor}` +
      ` card=${cardDev.x},${cardDev.y},${cardDev.w},${cardDev.h}`
  );
}

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

function helperRect() {
  return `${cardDev.x},${cardDev.y},${cardDev.w},${cardDev.h}`;
}

function applyX11PreShow(label) {
  if (!wid) return;
  const hex = hexWid(wid);
  // Electron 45 keeps WM_CLASS=electron for BrowserWindows (Task 3 finding);
  // set it explicitly before the first map.
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

function windowBounds() {
  if (!win || win.isDestroyed()) return { x: WIN_X, y: WIN_Y, width: WIN_W, height: WIN_H };
  const b = win.getContentBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function inputRectScreen() {
  if (!inputRectCss) return null;
  const b = windowBounds();
  return {
    x: Math.round(b.x + inputRectCss.x),
    y: Math.round(b.y + inputRectCss.y),
    width: Math.round(inputRectCss.width),
    height: Math.round(inputRectCss.height),
  };
}

function mapState() {
  if (!wid) return 'no-wid';
  const r = spawnSync('xwininfo', ['-id', hexWid(wid)], {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
    timeout: 5000,
  });
  const m = /Map State:\s*(\w+)/.exec(r.stdout || '');
  return m ? m[1] : 'unknown';
}

// ---------------------------------------------------------------- state/evidence
let sendCount = 0;
let eventSeq = 0;
let lastEvents = [];
let latestValue = '';
let latestComposing = false;
let latestFocused = false;
let shuttingDown = false;

function writeState() {
  const state = {
    value: latestValue,
    composing: latestComposing,
    last_events: lastEvents.slice(-12),
    input_rect_css: inputRectCss,
    input_rect_screen: inputRectScreen(),
    window_bounds: windowBounds(),
    sends: sendCount,
    input_focused: latestFocused,
    map_state: mapState(),
    updated_at: new Date().toISOString(),
  };
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    log(`state write failed: ${e.message}`);
  }
  return state;
}

function appendJsonl(file, obj) {
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (e) {
    log(`append ${path.basename(file)} failed: ${e.message}`);
  }
}

function compactEvent(e) {
  return {
    seq: e.seq,
    event: e.event,
    key: e.key,
    keyCode: e.keyCode,
    isComposing: e.isComposing,
    inputType: e.inputType,
    data: e.data,
    value: e.value,
    timestamp: e.timestamp,
    composing_at_key: e.composing_at_key,
  };
}

// ---------------------------------------------------------------- window
let win = null;
let idleTimer = null;
let rectWaiters = [];

function resetIdleTimer() {
  if (!(IDLE_TIMEOUT_MS > 0)) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (shuttingDown) return;
    out('IDLE_TIMEOUT');
    quitCleanly('idle-timeout');
  }, IDLE_TIMEOUT_MS);
}

function quitCleanly(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`quit (${reason})`);
  if (idleTimer) clearTimeout(idleTimer);
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(exitCode);
}

// ---------------------------------------------------------------- network
let sendInFlight = false;

async function sendRequest(value) {
  sendCount += 1;
  const myCount = sendCount;
  const body = {
    model: 'mock',
    messages: [
      { role: 'user', content: value },
    ],
    stream: true,
  };
  log(`SEND_REQUESTED count=${myCount} value=${safeJson(value)} url=${POST_URL}`);
  writeState();
  // No auto-retry, ever. One logical send == exactly one fetch attempt.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(POST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    log(`SEND_RESPONSE count=${myCount} status=${res.status}`);
    let chunks = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
        chunks += 1;
      }
    }
    clearTimeout(timeout);
    log(`SEND_SSE_CONSUMED count=${myCount} chunks=${chunks}`);
  } catch (e) {
    log(`SEND_FAILED count=${myCount} error=${e && e.message ? e.message : String(e)}`);
  } finally {
    sendInFlight = false;
    writeState();
  }
}

// ---------------------------------------------------------------- IPC
ipcMain.on('ime:rect', (_event, data) => {
  if (data && data.input_rect_css) {
    inputRectCss = data.input_rect_css;
    latestValue = data.value || '';
    latestComposing = !!data.composing;
    latestFocused = !!data.input_focused;
    log(`INPUT_RECT_CSS=${safeJson(inputRectCss)} value=${safeJson(latestValue)}`);
    writeState();
    const waiters = rectWaiters;
    rectWaiters = [];
    for (const resolve of waiters) resolve(true);
  }
});

ipcMain.on('ime:event', (_event, data) => {
  if (!data || typeof data !== 'object') return;
  eventSeq += 1;
  const rec = {
    ...data,
    seq: eventSeq,
    rect_css: data.input_rect_css || null,
    rect_screen: inputRectScreen(),
    window_bounds: windowBounds(),
    sends: sendCount,
  };
  latestValue = typeof data.value === 'string' ? data.value : latestValue;
  latestComposing = !!data.composing;
  latestFocused = !!data.input_focused;
  lastEvents.push(compactEvent(rec));
  if (lastEvents.length > 24) lastEvents = lastEvents.slice(-24);
  appendJsonl(EVENTS_FILE, rec);
  writeState();
  resetIdleTimer();
  log(
    `EVENT seq=${rec.seq} type=${rec.event} key=${safeJson(rec.key)} keyCode=${rec.keyCode}` +
      ` isComposing=${rec.isComposing} composing=${data.composing} value=${safeJson(data.value)}`
  );
});

ipcMain.on('ime:send', (_event, value) => {
  resetIdleTimer();
  if (typeof value !== 'string') value = String(value ?? '');
  log(`SEND_KEY value=${safeJson(value)} composing=${latestComposing}`);
  if (sendInFlight) {
    log('SEND_IGNORED_INFLIGHT');
    return;
  }
  sendInFlight = true;
  void sendRequest(value);
});

ipcMain.on('ime:escape', () => {
  resetIdleTimer();
  log('WINDOW_HIDDEN');
  if (win && !win.isDestroyed()) win.hide();
  writeState();
});

ipcMain.on('ime:shortcut', (_event, data) => {
  resetIdleTimer();
  const name = (data && data.name) || 'unknown';
  const composing = !!(data && data.composing);
  const rec = {
    name,
    composing,
    ts: new Date().toISOString(),
    value: latestValue,
    sends: sendCount,
  };
  appendJsonl(SHORTCUTS_FILE, rec);
  if (composing) {
    log(`SHORTCUT_IGNORED_COMPOSING name=${name}`);
  } else {
    log(`SHORTCUT_TRIGGERED name=${name}`);
  }
  writeState();
});

// ---------------------------------------------------------------- bootstrap
process.on('SIGTERM', () => quitCleanly('SIGTERM'));
process.on('SIGINT', () => quitCleanly('SIGINT'));

app.on('window-all-closed', () => {
  // The spike owns the lifecycle; never auto-quit on window close.
});

function waitForRect(timeoutMs) {
  if (inputRectCss) return Promise.resolve(true);
  return new Promise((resolve) => {
    rectWaiters.push(resolve);
    setTimeout(() => {
      const idx = rectWaiters.indexOf(resolve);
      if (idx >= 0) rectWaiters.splice(idx, 1);
      resolve(!!inputRectCss);
    }, timeoutMs);
  });
}

app.whenReady().then(async () => {
  fs.writeFileSync(EVENTS_FILE, '');
  fs.writeFileSync(SHORTCUTS_FILE, '');
  initGeometry();
  log(
    `start ozone=x11 base_url=${BASE_URL} idle_timeout_ms=${IDLE_TIMEOUT_MS}` +
      ` auto_quit_ms=${AUTO_QUIT_MS}`
  );
  log(
    `env DISPLAY=${process.env.DISPLAY || ''} XMODIFIERS=${process.env.XMODIFIERS || ''}` +
      ` GTK_IM_MODULE=${process.env.GTK_IM_MODULE || ''}` +
      ` QT_IM_MODULE=${process.env.QT_IM_MODULE || ''}` +
      ` electron=${process.versions.electron} chrome=${process.versions.chrome}`
  );

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
    title: 'QuickAsk G6 IME spike',
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

  await win.loadFile(INDEX);
  await waitForRect(5000);
  if (!inputRectCss) log('WARN: input rect not reported by preload');

  wid = getWid(win);
  log(`boot: wid=${hexWid(wid)} after ${Date.now() - processStartMs}ms`);

  applyX11PreShow('pre-show');
  win.show();
  win.focus();
  runHelper(['activate', hexWid(wid)], 'activate');
  win.focus();
  applyX11StatesAfterShow('post-show');

  writeState();

  const rectScreen = inputRectScreen();
  log(`boot: map_state=${mapState()} bounds=${safeJson(windowBounds())}`);
  out('APP_READY');
  out(`WID=${hexWid(wid)}`);
  out(`INPUT_RECT_SCREEN=${safeJson(rectScreen)}`);

  resetIdleTimer();
  if (AUTO_QUIT_MS > 0) {
    setTimeout(() => quitCleanly('auto-quit'), AUTO_QUIT_MS);
  }
});
