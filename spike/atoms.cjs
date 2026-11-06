'use strict';

/*
 * QuickAsk M0 spike — Task 7 G4 minimal window for real KWin Alt+Tab testing.
 *
 * Sets WM_CLASS=quickask and the four skip/top atoms BEFORE the first map,
 * re-asserts them after show, dumps xprop both times, then stays alive while
 * the external driver performs 5 real Alt+Tab cycles and screenshots.
 *
 * Launch:
 *   source scripts/env.sh
 *   ./node_modules/.bin/electron spike/atoms.cjs
 *
 * Evidence written by the app:
 *   .omo/evidence/task-7-xprop.txt       (pre-show then after-show)
 *   .omo/evidence/task-7-atoms-wid.txt
 *   .omo/evidence/task-7-atoms-ready.json
 *   .omo/evidence/task-7-atoms-app.log
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EVID = path.join(ROOT, '.omo', 'evidence');
const HELPER = path.join(ROOT, 'native', 'quickask-x11');
const HTML = path.join(__dirname, 'atoms.html');
const XPROP_FILE = path.join(EVID, 'task-7-xprop.txt');
const WID_FILE = path.join(EVID, 'task-7-atoms-wid.txt');
const READY_FILE = path.join(EVID, 'task-7-atoms-ready.json');
const APP_LOG = path.join(EVID, 'task-7-atoms-app.log');

fs.mkdirSync(EVID, { recursive: true });
fs.writeFileSync(XPROP_FILE, '');
fs.writeFileSync(APP_LOG, '');

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  fs.appendFileSync(APP_LOG, text);
  process.stdout.write(`ATOMS ${text}`);
}

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('ozone-platform', 'x11');
app.commandLine.appendSwitch('class', 'quickask');
app.commandLine.appendSwitch('name', 'quickask');
app.setName('quickask');
app.setPath('userData', path.join(ROOT, '.cache', 'spike-userdata-atoms'));

let win = null;
let wid = 0;
let shuttingDown = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getWid(target) {
  try {
    const buf = target.getNativeWindowHandle();
    if (!buf || buf.length < 4) return 0;
    if (buf.length >= 8) return Number(buf.readBigUInt64LE(0) & 0xffffffffn);
    return buf.readUInt32LE(0);
  } catch (error) {
    log(`getNativeWindowHandle failed: ${error.message}`);
    return 0;
  }
}

function hexWid(value) {
  return `0x${Number(value).toString(16)}`;
}

function runTool(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' }
  });
}

function runHelper(args) {
  if (!fs.existsSync(HELPER)) {
    log(`helper MISSING at ${HELPER}`);
    return;
  }
  const result = runTool(HELPER, args);
  log(`helper ${args.join(' ')} -> exit ${result.status} out=${(result.stdout || '').trim()} err=${(result.stderr || '').trim()}`);
}

function xpropDump(label) {
  if (!wid) return;
  const hex = hexWid(wid);
  const jobs = [
    [
      'xprop',
      [
        '-id',
        hex,
        '_NET_WM_STATE',
        'WM_CLASS',
        '_NET_WM_WINDOW_TYPE',
        '_NET_WM_NAME',
        'WM_NAME',
        'WM_HINTS'
      ]
    ],
    ['xwininfo', ['-id', hex]],
    ['wmctrl', ['-l']]
  ];
  const parts = [`\n===== ${label} | ${new Date().toISOString()} | wid=${hex} =====\n`];
  for (const [command, args] of jobs) {
    const result = runTool(command, args);
    parts.push(`--- ${command} ${args.join(' ')} (exit ${result.status}) ---\n`);
    parts.push(result.stdout || '');
    if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
  }
  fs.appendFileSync(XPROP_FILE, parts.join(''));
  log(`xprop dump (${label}) appended to ${XPROP_FILE}`);
}

function applyAtoms(label) {
  if (!wid) return;
  const hex = hexWid(wid);
  runHelper(['set-wm-class', hex, 'quickask', 'quickask']);
  runHelper(['set-states', hex]);
  log(`atoms applied (${label}) wid=${hex}`);
}

function writeReady(stage) {
  fs.writeFileSync(
    READY_FILE,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        stage,
        pid: process.pid,
        wid: wid ? hexWid(wid) : null,
        wid_decimal: wid || null,
        title: win ? win.getTitle() : null,
        xprop_file: XPROP_FILE,
        app_log: APP_LOG
      },
      null,
      2
    )}\n`
  );
  log(`READY stage=${stage} wid=${wid ? hexWid(wid) : '?'} ready_file=${READY_FILE}`);
}

const rawArgs = process.argv.slice(1);
const HOLD_BEFORE_SHOW_MS = Number(argValue('--hold-before-show-ms') || 0);

function argValue(name) {
  const i = rawArgs.indexOf(name);
  return i >= 0 ? rawArgs[i + 1] : undefined;
}

function remapViaX11(action) {
  if (!wid) return;
  const hex = hexWid(wid);
  const result = runTool('xdotool', [`window${action}`, hex]);
  log(`xdotool window${action} ${hex} -> exit ${result.status} err=${(result.stderr || '').trim()}`);
}

async function boot() {
  win = new BrowserWindow({
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    useContentSize: true,
    width: 760,
    height: 128,
    x: 100,
    y: 100,
    title: 'QAATOMSG4',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  win.setAlwaysOnTop(true);

  // IMPORTANT: BrowserWindow creation gives us an unmapped XID, while
  // loadFile() triggers the first MapRequest. KWin reads _NET_WM_STATE
  // during manage(), so the four atoms must be written now -- before loadFile.
  wid = getWid(win);
  if (!wid) throw new Error('no native window id');
  fs.writeFileSync(WID_FILE, `${hexWid(wid)}\n`);
  log(`created window wid=${hexWid(wid)} title=${win.getTitle()}`);

  applyAtoms('post-create/pre-map');
  xpropDump('post-create/pre-map');

  await new Promise((resolve) => {
    let settled = false;
    const done = (why) => {
      if (settled) return;
      settled = true;
      log(`load settled (${why})`);
      resolve();
    };
    win.webContents.once('did-finish-load', () => done('did-finish-load'));
    setTimeout(() => done('timeout'), 6000);
    win.loadFile(HTML);
  });

  await sleep(300);

  // KWin 6.3.6 reads skipSwitcher/skipTaskbar/skipPager only during manage()
  // and ignores later _NET_WM_STATE PropertyNotify changes. Electron's own
  // map path rewrites _NET_WM_STATE, clobbering atoms set before show(). The
  // reliable sequence is: map (Electron), unmap via X11 (KWin releases the
  // client), set atoms while unmapped, X11 map (KWin re-manages and reads the
  // atoms). xdotool is used here only for the spike; Task 12 should add an
  // equivalent XMapWindow/XUnmapWindow step to the native helper.
  win.setOpacity(0);
  win.show();
  win.focus();
  await sleep(200);
  remapViaX11('unmap');
  await sleep(350);

  applyAtoms('pre-show');
  xpropDump('pre-show');
  if (HOLD_BEFORE_SHOW_MS > 0) {
    log(`holding ${HOLD_BEFORE_SHOW_MS}ms before final map`);
    writeReady('holding-before-show');
    await sleep(HOLD_BEFORE_SHOW_MS);
  }

  remapViaX11('map');
  await sleep(400);
  win.setOpacity(1);
  win.focus();
  await sleep(150);

  // KWin/Chromium may add FOCUSED/STAYS_ON_TOP; re-assert and keep extras.
  applyAtoms('after-show');
  xpropDump('after-show');
  writeReady('shown');
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch {
    /* ignore */
  }
  app.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

app.whenReady().then(async () => {
  try {
    await boot();
  } catch (error) {
    log(`FATAL ${error && error.stack ? error.stack : error}`);
    try {
      writeReady('fatal');
    } catch {
      /* ignore */
    }
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  if (!shuttingDown) shutdown('window-all-closed');
});
