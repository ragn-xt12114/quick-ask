#!/usr/bin/env node
/* Minimal Electron tray spike for G7 (Task 6).
 *
 * Goals:
 *  - 32x32 PNG tray icon generated locally from assets/tray-spike.svg
 *  - tooltip + exactly five context-menu items
 *  - log every tray event / menu activation with timestamps to
 *    .omo/evidence/task-6-tray-events.json
 *  - log TRAY_READY, app PID and the SNI item name when derivable
 *
 * This file is a spike only; it does not import anything from src/.
 */
'use strict';

const { app, Tray, Menu, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = path.join(ROOT, '.omo', 'evidence');
const LOG_FILE = path.join(EVIDENCE_DIR, 'task-6-tray-events.json');
const ICON_FILE = path.join(ROOT, 'assets', 'tray-spike-32.png');
const TOOLTIP = 'QuickAsk test tray';
const MENU_LABELS = ['显示/隐藏', '新建会话', '历史', '设置', '退出'];

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const state = {
  schema_version: 1,
  spike: 'G7 tray',
  pid: process.pid,
  started_at: new Date().toISOString(),
  electron: process.versions.electron,
  node: process.versions.node,
  platform: process.platform,
  display: process.env.DISPLAY || null,
  icon_file: ICON_FILE,
  tooltip: TOOLTIP,
  menu_items: MENU_LABELS.slice(),
  sni: {
    item: null,
    id: null,
    title: null,
    registered_count: null,
    lookup_error: null,
  },
  events: [],
};

function writeState() {
  // Atomic replace: a SIGTERM during a write must never leave a 0-byte event
  // log (observed once when Electron was killed mid-write).
  const tmp = LOG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, LOG_FILE);
}

function logEvent(type, detail = {}) {
  const event = {
    ts: new Date().toISOString(),
    ts_ms: Date.now(),
    type,
    ...detail,
  };
  state.events.push(event);
  try {
    writeState();
  } catch (err) {
    console.error('[tray-spike] failed to write event log:', err && err.message);
  }
  console.log(`[tray-spike] ${event.ts} ${type} ${JSON.stringify(detail)}`);
}

function safeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const { x, y, width, height } = bounds;
  return { x, y, width, height };
}

function parseGdbusString(raw) {
  const matches = raw.match(/'((?:[^'\\]|\\.)*)'/g) || [];
  for (const quoted of matches) {
    const value = quoted.slice(1, -1).replace(/\\'/g, "'");
    if (value) return value;
  }
  return null;
}

function dbusCall(bin, args, done) {
  execFile(bin, args, { timeout: 3000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    done(err, String(stdout || ''), String(stderr || ''));
  });
}

function querySniItems(done) {
  // Best-effort and ASYNC: synchronous DBus calls in the Electron main process
  // can block tray event delivery (observed with 21 spawnSync calls -> 75 s).
  // We first ask the watcher for items, then find our own bus connection by
  // comparing GetConnectionUnixProcessID with process.pid.  Only the matching
  // item is queried, so other (possibly unresponsive) SNI owners cannot stall us.
  const result = {
    item: null,
    id: null,
    title: null,
    registered_count: null,
    lookup_error: null,
  };
  dbusCall(
    'qdbus6',
    [
      'org.kde.StatusNotifierWatcher',
      '/StatusNotifierWatcher',
      'org.kde.StatusNotifierWatcher.RegisteredStatusNotifierItems',
    ],
    (err, stdout, stderr) => {
      if (err) {
        result.lookup_error = stderr.trim() || err.message || 'watcher query failed';
        done(result);
        return;
      }
      const items = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      result.registered_count = items.length;

      let index = 0;
      const tryNext = () => {
        if (index >= items.length) {
          done(result);
          return;
        }
        const item = items[index++];
        const slash = item.indexOf('/');
        if (slash <= 0) {
          tryNext();
          return;
        }
        const service = item.slice(0, slash);
        const objectPath = item.slice(slash);
        dbusCall(
          'qdbus6',
          [
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus.GetConnectionUnixProcessID',
            service,
          ],
          (pidErr, pidOut) => {
            if (pidErr || pidOut.trim() !== String(process.pid)) {
              tryNext();
              return;
            }
            const getProp = (prop, cb) => {
              dbusCall(
                'gdbus',
                [
                  'call',
                  '--session',
                  '--dest',
                  service,
                  '--object-path',
                  objectPath,
                  '--method',
                  'org.freedesktop.DBus.Properties.Get',
                  'org.kde.StatusNotifierItem',
                  prop,
                ],
                (propErr, propOut) => cb(propErr ? '' : parseGdbusString(propOut.trim()) || '')
              );
            };
            getProp('Id', (idOut) => {
              getProp('ToolTip', (tooltipOut) => {
                result.item = item;
                result.id = idOut || null;
                result.title = null;
                result.tooltip = tooltipOut || null;
                done(result);
              });
            });
          }
        );
      };
      tryNext();
    }
  );
}

app.setName('quickask-tray-spike');

app.on('before-quit', () => {
  logEvent('BEFORE_QUIT');
});
app.on('will-quit', () => {
  logEvent('WILL_QUIT');
});
app.on('quit', () => {
  logEvent('QUIT');
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    logEvent('SIGNAL', { signal });
    app.quit();
  });
}

process.on('uncaughtException', (err) => {
  logEvent('UNCAUGHT_EXCEPTION', { message: err && err.message, stack: err && err.stack });
  app.exit(1);
});

app.whenReady().then(() => {
  const image = nativeImage.createFromPath(ICON_FILE);
  const imageSize = image.getSize();

  const tray = new Tray(image);
  tray.setToolTip(TOOLTIP);

  const menu = Menu.buildFromTemplate(
    MENU_LABELS.map((label, index) => ({
      label,
      id: `quickask-tray-item-${index + 1}`,
      click: () => {
        logEvent('MENU_CLICK', {
          item: label,
          index: index + 1,
          checked: false,
        });
        if (label === '退出') {
          setTimeout(() => app.quit(), 50);
        }
      },
    }))
  );
  tray.setContextMenu(menu);

  // Every event Electron exposes for Tray.  Unsupported events simply never
  // fire on Linux; recording listeners here proves what the platform emits.
  const trayEvents = [
    'click',
    'right-click',
    'double-click',
    'mouse-down',
    'mouse-up',
    'mouse-enter',
    'mouse-leave',
    'balloon-show',
    'balloon-click',
    'balloon-close',
    'drop-files',
    'drop-text',
    'drag-enter',
    'drag-leave',
    'drag-end',
  ];
  for (const eventName of trayEvents) {
    tray.on(eventName, (...args) => {
      const detail = {};
      const [event, bounds, position] = args;
      if (bounds && typeof bounds === 'object') detail.bounds = safeBounds(bounds);
      if (position && typeof position === 'object') detail.position = safeBounds(position);
      if (event && typeof event === 'object') {
        detail.event_type = event.type || null;
        detail.event_modifiers = Array.isArray(event.modifiers) ? event.modifiers : null;
      }
      logEvent(eventName, detail);
    });
  }

  const trayBounds = safeBounds(tray.getBounds());
  logEvent('TRAY_READY', {
    pid: process.pid,
    tooltip: TOOLTIP,
    icon_file: ICON_FILE,
    icon_size: imageSize,
    image_empty: image.isEmpty(),
    tray_bounds: trayBounds,
    menu_items: MENU_LABELS,
    app_name: app.getName(),
    app_version: app.getVersion(),
  });

  // Look up the SNI item after Plasma had a moment to register it.  Do not
  // block TRAY_READY on this; the driver waits for TRAY_READY and then reads
  // the watcher list itself.
  setTimeout(() => {
    querySniItems((sni) => {
      state.sni = sni;
      logEvent('SNI_LOOKUP', {
        sni,
        derived: Boolean(sni.item),
      });
      writeState();
    });
  }, 900);
});
