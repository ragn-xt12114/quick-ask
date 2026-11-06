'use strict';

/*
 * QuickAsk M0 G2/G3 spike preload — sandbox-safe timing probe.
 *
 * Runs with contextIsolation: true, sandbox: true, nodeIntegration: false.
 * Only ipcRenderer is used; no Node API is exposed to the page and no
 * contextBridge surface is created.
 *
 * On `renderer:arm` (sent by the main process right after a show/focus
 * strategy) it:
 *   1. focuses <input id="composer">,
 *   2. reports a `focus` timing (with performance.now() and Date.now()),
 *   3. reports `raf1` / `raf2` on the next two animation frames.
 *
 * It also reports a `focus` timing whenever the input receives a real DOM
 * focus event while a sample is armed.
 */

const { ipcRenderer } = require('electron');

let armedSeq = null;

function activeElementId() {
  const el = document.activeElement;
  if (!el) return null;
  return el.id || el.tagName || null;
}

function setState(text) {
  const badge = document.getElementById('state');
  if (badge) badge.textContent = text;
}

function send(kind, extra) {
  const payload = {
    kind,
    seq: armedSeq,
    perf_now_ms: performance.now(),
    wall_ms: Date.now(),
    active_element: activeElementId(),
    visibility: document.visibilityState,
    ...extra,
  };
  try {
    ipcRenderer.send('renderer:timing', payload);
  } catch {
    /* renderer is tearing down */
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('composer');
  if (!input) return;

  input.addEventListener('focus', () => {
    if (armedSeq == null) return;
    setState('focused');
    send('focus', { source: 'dom-focus' });
  });

  input.addEventListener('blur', () => {
    if (armedSeq == null) return;
    setState('blurred');
  });

  ipcRenderer.on('renderer:arm', (_event, data) => {
    armedSeq = data && Number.isFinite(data.seq) ? data.seq : -1;
    const armPerf = performance.now();
    const armWall = data && Number.isFinite(data.arm_wall_ms) ? data.arm_wall_ms : Date.now();

    setState('armed');
    input.focus();

    // Report focus immediately after the explicit focus() call: this is the
    // moment the composer is ready to accept keystrokes, regardless of whether
    // the DOM fired a fresh focus event (focus persists across hide/show).
    send('focus', {
      source: 'arm',
      arm_perf_ms: armPerf,
      arm_wall_ms: armWall,
    });

    requestAnimationFrame(() => {
      const p1 = performance.now();
      send('raf1', {
        arm_perf_ms: armPerf,
        arm_wall_ms: armWall,
        raf_delta_ms: p1 - armPerf,
      });
      requestAnimationFrame(() => {
        const p2 = performance.now();
        send('raf2', {
          arm_perf_ms: armPerf,
          arm_wall_ms: armWall,
          raf_delta_ms: p2 - armPerf,
        });
        setState('ready');
        armedSeq = null;
      });
    });
  });
});
