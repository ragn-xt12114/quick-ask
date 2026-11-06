/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const READY = path.join(ROOT, '.omo', 'evidence', 'task-12-helper-window.json');
const USER_DATA = path.join(ROOT, '.runtime', 'task12-helper-userdata');

fs.mkdirSync(path.dirname(READY), { recursive: true });
fs.mkdirSync(USER_DATA, { recursive: true });
app.setPath('userData', USER_DATA);
app.commandLine.appendSwitch('ozone-platform', 'x11');

let win = null;

function windowId(target) {
  const buffer = target.getNativeWindowHandle();
  if (!buffer || buffer.length < 4) return 0;
  if (buffer.length >= 8) return Number(buffer.readBigUInt64LE(0) & 0xffffffffn);
  return buffer.readUInt32LE(0);
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 760,
    height: 128,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    title: 'QAHELPER12',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.loadURL('data:text/html,<body style="background:transparent"></body>');
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    const wid = windowId(win);
    const info = { pid: process.pid, wid, widHex: `0x${wid.toString(16)}` };
    fs.writeFileSync(READY, `${JSON.stringify(info)}\n`);
    process.stdout.write(`READY ${JSON.stringify(info)}\n`);
  });
});

app.on('window-all-closed', () => app.quit());
