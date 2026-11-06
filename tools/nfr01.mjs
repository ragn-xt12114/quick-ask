#!/usr/bin/env node
/*
 * NFR-01 / G2 driver — hotkey → input focus / rAF latency, plus focus return.
 *
 * Dependency-free (Node 24). Drives a real Electron app with real XTEST key
 * events via xdotool; never calls win.show() from the driver.
 *
 * Usage:
 *   source scripts/env.sh
 *   node tools/nfr01.mjs --runs 20 --strategy show-focus \
 *     --out .omo/evidence/task-4-nfr01-showfocus.json
 *
 * Options:
 *   --runs N               latency samples (default 20)
 *   --strategy NAME        show-focus | helper-activate | helper-grab
 *   --out FILE             JSON output (default .omo/evidence/task-4-nfr01-<strategy>.json)
 *   --samples-out FILE     app JSONL (default .omo/evidence/task-4-samples-<strategy>.jsonl)
 *   --log FILE             app stdout/stderr log (default .omo/evidence/task-4-nfr01-<strategy>.log)
 *   --app PATH             app entry (default spike/hotkey.cjs) — reusable for the real app
 *   --electron PATH        electron binary/wrapper (default node_modules/.bin/electron)
 *   --hotkey-xdotool KEYS  xdotool key spec (default ctrl+alt+space)
 *   --focus-return-runs N  focus-return attempts (default 20; 0 disables)
 *   --focus-return-out F   report file (default .omo/evidence/task-4-focus-return.txt)
 *   --skip-focus-return    disable focus-return phase
 *   --startup-timeout-ms N APP_READY timeout (default 10000)
 *   --sample-timeout-ms N  per sample timeout (default 5000)
 *   --settle-ms N          sleep after APP_READY / HIDDEN (default 500 / 150)
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const EVID = path.join(ROOT, '.omo', 'evidence');
fs.mkdirSync(EVID, { recursive: true });

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1);
  }
  return fallback;
}
function hasFlag(name) {
  return argv.includes(name);
}

const RUNS = Number(argValue('--runs', '20'));
const STRATEGY = argValue('--strategy', 'show-focus');
const OUT = path.resolve(argValue('--out', path.join(EVID, `task-4-nfr01-${STRATEGY}.json`)));
const SAMPLES_OUT = path.resolve(
  argValue('--samples-out', path.join(EVID, `task-4-samples-${STRATEGY}.jsonl`))
);
const LOG = path.resolve(argValue('--log', path.join(EVID, `task-4-nfr01-${STRATEGY}.log`)));
const APP = path.resolve(argValue('--app', path.join(ROOT, 'spike', 'hotkey.cjs')));
const ELECTRON = path.resolve(argValue('--electron', path.join(ROOT, 'node_modules', '.bin', 'electron')));
const HOTKEY_XDOTOOL = argValue('--hotkey-xdotool', 'ctrl+alt+space');
const SKIP_FOCUS_RETURN = hasFlag('--skip-focus-return');
const FOCUS_RETURN_RUNS = Number(argValue('--focus-return-runs', '20'));
const FOCUS_RETURN_OUT = path.resolve(
  argValue('--focus-return-out', path.join(EVID, 'task-4-focus-return.txt'))
);
const STARTUP_TIMEOUT_MS = Number(argValue('--startup-timeout-ms', '10000'));
const SAMPLE_TIMEOUT_MS = Number(argValue('--sample-timeout-ms', '5000'));
const SETTLE_MS = Number(argValue('--settle-ms', '500'));
const BETWEEN_MS = Number(argValue('--between-ms', '150'));
const DISPLAY = process.env.DISPLAY || ':0';
const PASS_P95_MS = 150;

const focusReturnAttempts = SKIP_FOCUS_RETURN ? 0 : FOCUS_RETURN_RUNS;
const maxSamples = RUNS + focusReturnAttempts;

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}
function stats(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return { n: 0, p50: null, p95: null, max: null, min: null, mean: null };
  const sum = clean.reduce((a, b) => a + b, 0);
  return {
    n: clean.length,
    p50: percentile(clean, 50),
    p95: percentile(clean, 95),
    max: Math.max(...clean),
    min: Math.min(...clean),
    mean: Math.round((sum / clean.length) * 1000) / 1000,
  };
}
function hexWid(wid) {
  return '0x' + Number(wid).toString(16);
}
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY },
    timeout: opts.timeout || 5000,
  });
}

// ---------------------------------------------------------------- app process
class AppRun {
  constructor(tag) {
    this.tag = tag;
    this.child = null;
    this.buffer = '';
    this.lines = [];
    this.hiddenCount = 0;
    this.exited = false;
    this.exitInfo = null;
    this.logStream = null;
    this.sampleState = { count: 0 };
    this.waiters = [];
  }

  start(extraArgs) {
    fs.writeFileSync(LOG, '');
    this.logStream = fs.createWriteStream(LOG, { flags: 'a' });
    const args = [
      APP,
      '--strategy', STRATEGY,
      '--samples-out', SAMPLES_OUT,
      '--max-samples', String(maxSamples),
      '--idle-timeout-ms', String(120000),
      ...extraArgs,
    ];
    this.child = spawn(ELECTRON, args, {
      cwd: ROOT,
      detached: true,
      env: { ...process.env, DISPLAY },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const handle = (chunk) => {
      this.logStream.write(chunk);
      this.buffer += chunk.toString();
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.lines.push(line);
        if (line.trim() === 'HIDDEN') this.hiddenCount += 1;
        for (const w of this.waiters.slice()) {
          if (w.predicate(line)) {
            w.resolve(line);
            this.waiters.splice(this.waiters.indexOf(w), 1);
          }
        }
      }
    };
    this.child.stdout.on('data', handle);
    this.child.stderr.on('data', handle);
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      for (const w of this.waiters.slice()) w.reject(new Error(`app exited code=${code} signal=${signal}`));
      this.waiters = [];
    });
    return this;
  }

  waitForLine(predicate, timeoutMs, label) {
    for (const line of this.lines) {
      if (predicate(line)) return Promise.resolve(line);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout waiting for ${label || 'line'} after ${timeoutMs}ms; recent=${this.lines.slice(-6).join(' | ')}`));
      }, timeoutMs);
      const entry = {
        predicate,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.waiters.push(entry);
    });
  }

  async waitForMarker(marker, timeoutMs) {
    return this.waitForLine((l) => l.trim() === marker, timeoutMs, marker);
  }

  readNewSamples() {
    let text;
    try {
      text = fs.readFileSync(SAMPLES_OUT, 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n');
    // Only consume complete lines.
    if (!text.endsWith('\n')) lines.pop();
    const fresh = lines.slice(this.sampleState.count);
    const parsed = [];
    for (const line of fresh) {
      if (!line.trim()) continue;
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // A partial/truncated line means the writer is mid-append; stop here.
        break;
      }
    }
    this.sampleState.count += parsed.length;
    return parsed;
  }

  async waitForSamples(n, timeoutMs) {
    const start = Date.now();
    let got = [];
    while (Date.now() - start < timeoutMs) {
      got = got.concat(this.readNewSamples());
      if (got.length >= n) return got;
      await sleep(5);
    }
    throw new Error(`timeout waiting for ${n} sample(s) after ${timeoutMs}ms (got ${got.length})`);
  }

  async stop() {
    if (!this.child || this.exited) {
      this.closeLog();
      return;
    }
    const pid = this.child.pid;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    const deadline = Date.now() + 3000;
    while (!this.exited && Date.now() < deadline) await sleep(50);
    if (!this.exited) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      await sleep(200);
    }
    this.closeLog();
  }

  closeLog() {
    if (this.logStream) {
      try {
        this.logStream.end();
      } catch {
        /* ignore */
      }
      this.logStream = null;
    }
  }
}

// ---------------------------------------------------------------- x11 helpers
function getWidFromLines(lines) {
  for (const line of lines) {
    const m = /^WID=(0x[0-9a-fA-F]+)\s*$/.exec(line.trim());
    if (m) return Number.parseInt(m[1], 16);
  }
  return 0;
}
function currentFocus() {
  const r = run('xdotool', ['getwindowfocus']);
  if (r.status !== 0) return 0;
  const n = Number.parseInt((r.stdout || '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}
function windowExists(wid) {
  if (!wid) return false;
  return run('xwininfo', ['-id', hexWid(wid)]).status === 0;
}
function activateWindow(wid) {
  return run('xdotool', ['windowactivate', hexWid(wid)]);
}
function acceptsInputFocus(wid) {
  const r = run('xprop', ['-id', hexWid(wid), 'WM_HINTS']);
  const text = r.stdout || '';
  if (/accepts input or input focus:\s*False/.test(text)) return false;
  if (/accepts input or input focus:\s*True/.test(text)) return true;
  return null;
}
function mousePosition() {
  const r = run('xdotool', ['getmouselocation', '--shell']);
  const out = r.stdout || '';
  const x = /(?:^|\n)X=(\d+)/.exec(out);
  const y = /(?:^|\n)Y=(\d+)/.exec(out);
  return x && y ? { x: Number(x[1]), y: Number(y[1]) } : null;
}
// KWin ignores EWMH activation for windows that declare "accepts input or
// input focus: False" (xclock does). As a last resort, raise the window and
// synthesize a real click on it — a genuine user interaction KWin must honour.
function forceFocus(wid) {
  const hex = hexWid(wid);
  for (let i = 0; i < 5; i++) {
    activateWindow(wid);
    spawnSync('sleep', ['0.06']);
    if (currentFocus() === wid) return { ok: true, method: 'windowactivate', focus: wid };
  }
  const info = run('xwininfo', ['-id', hex]);
  const ax = /Absolute upper-left X:\s*(-?\d+)/.exec(info.stdout || '');
  const ay = /Absolute upper-left Y:\s*(-?\d+)/.exec(info.stdout || '');
  const w = /Width:\s*(\d+)/.exec(info.stdout || '');
  const h = /Height:\s*(\d+)/.exec(info.stdout || '');
  if (ax && ay && w && h) {
    const savedMouse = mousePosition();
    run('wmctrl', ['-i', '-r', hex, '-b', 'add,above']);
    run('xdotool', ['mousemove', String(Number(ax[1]) + Math.floor(Number(w[1]) / 2)), String(Number(ay[1]) + Math.floor(Number(h[1]) / 2))]);
    run('xdotool', ['click', '1']);
    spawnSync('sleep', ['0.1']);
    if (savedMouse) run('xdotool', ['mousemove', String(savedMouse.x), String(savedMouse.y)]);
    if (currentFocus() === wid) return { ok: true, method: 'click', focus: wid };
  }
  return { ok: false, method: 'none', focus: currentFocus() };
}

// ---------------------------------------------------------------- phases
async function latencyPhase(app, wid) {
  const samples = [];
  const log = [];
  await sleep(SETTLE_MS);

  for (let i = 0; i < RUNS; i++) {
    const hiddenBefore = app.hiddenCount;
    const tSend = Date.now();
    const key = run('xdotool', ['key', '--clearmodifiers', HOTKEY_XDOTOOL]);
    if (key.status !== 0) {
      log.push(`run=${i + 1} xdotool_failed exit=${key.status} err=${(key.stderr || '').trim()}`);
    }
    let raw = null;
    try {
      const batch = await app.waitForSamples(1, SAMPLE_TIMEOUT_MS);
      raw = batch[0];
    } catch (e) {
      samples.push({
        run: i + 1,
        t_send_ms: tSend,
        missing: true,
        error: e.message,
      });
      log.push(`run=${i + 1} MISSING_SAMPLE ${e.message}`);
      continue;
    }

    // Verify real X focus while the window is still visible (600ms window).
    const driverFocus = currentFocus();
    const focusLatency = raw.focus_ms != null ? raw.focus_ms - raw.hotkey_ms : null;
    const raf1Latency = raw.raf1_ms != null ? raw.raf1_ms - raw.hotkey_ms : null;
    const raf2Latency = raw.raf2_ms != null ? raw.raf2_ms - raw.hotkey_ms : null;
    const focusOk =
      raw.complete === true &&
      raw.focus_active_element === 'composer' &&
      raw.x_focus_ok === true &&
      driverFocus === wid;

    const sample = {
      run: i + 1,
      seq: raw.seq,
      strategy: raw.strategy,
      wid: raw.wid,
      hotkey_ms: raw.hotkey_ms,
      focus_ms: raw.focus_ms,
      raf1_ms: raw.raf1_ms,
      raf2_ms: raw.raf2_ms,
      focus_latency_ms: focusLatency,
      raf1_latency_ms: raf1Latency,
      raf_latency_ms: raf2Latency,
      focus_active_element: raw.focus_active_element,
      focus_source: raw.focus_source,
      x_focus_wid: raw.x_focus_wid,
      x_focus_ok: raw.x_focus_ok,
      driver_x_focus_wid: driverFocus,
      driver_x_focus_hex: hexWid(driverFocus),
      driver_x_focus_ok: driverFocus === wid,
      complete: raw.complete,
      focus_ok: focusOk,
      x_map_state: raw.x_map_state,
      finalized_reason: raw.finalized_reason,
      raf1_delta_ms: raw.raf1_delta_ms,
      raf2_delta_ms: raw.raf2_delta_ms,
      t_send_ms: tSend,
      raw,
    };
    samples.push(sample);
    log.push(
      `run=${i + 1} hotkey_ms=${raw.hotkey_ms} focus_ms=${raw.focus_ms} raf2_ms=${raw.raf2_ms}` +
        ` focus_latency=${focusLatency} raf_latency=${raf2Latency}` +
        ` active=${raw.focus_active_element} x_focus_ok=${raw.x_focus_ok}` +
        ` driver_focus=${hexWid(driverFocus)} ok=${focusOk}`
    );

    await app.waitForLine(() => app.hiddenCount > hiddenBefore, SAMPLE_TIMEOUT_MS, `HIDDEN #${i + 1}`);
    await sleep(BETWEEN_MS);
  }

  const focusLatencies = samples.map((s) => s.focus_latency_ms).filter((v) => v != null);
  const rafLatencies = samples.map((s) => s.raf_latency_ms).filter((v) => v != null);
  const raf1Latencies = samples.map((s) => s.raf1_latency_ms).filter((v) => v != null);
  const focusSuccess = samples.filter((s) => s.focus_ok).length;
  const completeCount = samples.filter((s) => s.complete).length;
  const latStats = stats(focusLatencies);
  const rafStats = stats(rafLatencies);

  return {
    runs: RUNS,
    samples,
    focus_success: focusSuccess,
    complete_samples: completeCount,
    missing_samples: samples.filter((s) => s.missing).length,
    focus_latency: latStats,
    raf_latency: rafStats,
    raf1_latency: stats(raf1Latencies),
    pass:
      samples.length === RUNS &&
      focusSuccess === RUNS &&
      latStats.p95 != null &&
      latStats.p95 <= PASS_P95_MS,
    logs: log,
  };
}

async function focusReturnPhase(app, wid, previousFocus) {
  const attempts = [];
  const lines = [];
  fs.writeFileSync(FOCUS_RETURN_OUT, '');

  // Previous window: xclock first (as specified), fall back to xmessage when
  // xclock declares "accepts input or input focus: False" (this KWin refuses
  // to focus such windows) or when xclock cannot be found.
  let prevProc = null;
  let prevName = 'qa-focus-return';
  let prevWid = 0;
  let fallbackReason = null;

  const findWindow = async (name, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      const r = run('xdotool', ['search', '--name', name]);
      const ids = (r.stdout || '').trim().split('\n').filter(Boolean);
      if (ids.length) {
        const id = Number.parseInt(ids[ids.length - 1], 10);
        if (windowExists(id)) return id;
      }
      await sleep(50);
    }
    return 0;
  };
  const spawnHelper = (cmd, args) => {
    const proc = spawn(cmd, args, {
      env: { ...process.env, DISPLAY },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.on('error', (e) => lines.push(`NOTE: ${cmd} spawn error: ${e.message}`));
    return proc;
  };

  prevProc = spawnHelper('xclock', [
    '-digital', '-geometry', '240x80+1400+700', '-bg', '#202224', '-fg', '#ffffff', '-title', prevName,
  ]);
  prevWid = await findWindow(prevName, 100);
  if (prevWid && acceptsInputFocus(prevWid) === false) {
    fallbackReason = 'xclock WM_HINTS says "accepts input or input focus: False"; KWin cannot focus it';
  } else if (!prevWid) {
    fallbackReason = 'xclock window not found within 5s';
  }
  if (fallbackReason) {
    try {
      prevProc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    prevWid = 0;
    prevName = 'qa-focus-return-msg';
    prevProc = spawnHelper('xmessage', [
      '-title', prevName, '-geometry', '300x120+1000+400', 'focus return probe (previous window)',
    ]);
    prevWid = await findWindow(prevName, 100);
    if (!prevWid) fallbackReason += '; xmessage also not found';
  }

  lines.push(`# Task 4 focus-return: hotkey show → hide; expect focus back to the previous window`);
  if (fallbackReason) {
    lines.push(`# previous-window fallback: xclock -> xmessage (${fallbackReason})`);
  }
  lines.push(`# app_wid=${hexWid(wid)} previous_window=${prevName} previous_wid=${prevWid ? hexWid(prevWid) : '0x0'}`);
  lines.push(`# generated_at=${new Date().toISOString()}`);
  lines.push(`# format: attempt seq previous_wid pre_focus after_focus success`);

  let successes = 0;
  const returnSamples = [];
  for (let i = 0; i < focusReturnAttempts; i++) {
    // Put focus on the previous window before every attempt.
    const forced = prevWid ? forceFocus(prevWid) : { ok: false, method: 'none', focus: 0 };
    const preFocus = forced.focus;

    const hiddenBefore = app.hiddenCount;
    const tSend = Date.now();
    const key = run('xdotool', ['key', '--clearmodifiers', HOTKEY_XDOTOOL]);
    let sample = null;
    let err = null;
    try {
      const batch = await app.waitForSamples(1, SAMPLE_TIMEOUT_MS);
      sample = batch[0];
      await app.waitForLine(() => app.hiddenCount > hiddenBefore, SAMPLE_TIMEOUT_MS, 'HIDDEN');
    } catch (e) {
      err = e.message;
    }
    // KWin restores focus on unmap; give it a couple of frames.
    await sleep(120);
    const afterFocus = currentFocus();
    const success = sample != null && afterFocus === prevWid;
    if (success) successes += 1;
    attempts.push({
      attempt: i + 1,
      seq: sample ? sample.seq : null,
      t_send_ms: tSend,
      key_exit: key.status,
      pre_focus_wid: preFocus,
      pre_focus_hex: hexWid(preFocus),
      after_focus_wid: afterFocus,
      after_focus_hex: hexWid(afterFocus),
      previous_wid: prevWid,
      previous_hex: hexWid(prevWid),
      previous_focus_ok: preFocus === prevWid,
      previous_focus_method: forced.method,
      sample: sample
        ? {
            seq: sample.seq,
            hotkey_ms: sample.hotkey_ms,
            focus_ms: sample.focus_ms,
            raf1_ms: sample.raf1_ms,
            raf2_ms: sample.raf2_ms,
            focus_latency_ms: sample.focus_ms != null ? sample.focus_ms - sample.hotkey_ms : null,
            raf_latency_ms: sample.raf2_ms != null ? sample.raf2_ms - sample.hotkey_ms : null,
            x_focus_ok: sample.x_focus_ok,
            focus_active_element: sample.focus_active_element,
            complete: sample.complete,
          }
        : null,
      success,
      error: err,
    });
    if (sample) returnSamples.push(sample);
    lines.push(
      `attempt=${String(i + 1).padStart(2)} seq=${sample ? sample.seq : 'MISSING'}` +
        ` previous_wid=${hexWid(prevWid)} pre_focus=${hexWid(preFocus)}` +
        ` after_focus=${hexWid(afterFocus)} success=${success}` +
        (err ? ` error=${JSON.stringify(err)}` : '')
    );
    await sleep(BETWEEN_MS);
  }

  lines.push('');
  lines.push(`# successes=${successes}/${focusReturnAttempts} pass=${successes >= 18}/${focusReturnAttempts}`);
  if (fallbackReason) lines.push(`# fallback_reason=${fallbackReason}`);
  fs.writeFileSync(FOCUS_RETURN_OUT, lines.join('\n') + '\n');

  // Cleanup previous-window helper; restore the user's original focus if safe.
  try {
    prevProc.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  if (previousFocus && previousFocus !== wid && windowExists(previousFocus)) {
    activateWindow(previousFocus);
  }

  return {
    attempts,
    samples: returnSamples,
    samples_out: path.relative(ROOT, SAMPLES_OUT),
    previous_window: prevName,
    previous_wid: hexWid(prevWid),
    previous_window_fallback_reason: fallbackReason,
    attempts_count: focusReturnAttempts,
    successes,
    pass: successes >= Math.min(18, focusReturnAttempts),
    evidence: path.relative(ROOT, FOCUS_RETURN_OUT),
  };
}

// ---------------------------------------------------------------- main
async function main() {
  const originalFocus = currentFocus();
  const app = new AppRun(STRATEGY).start([]);

  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let appReadyMs = null;
  let wid = 0;
  try {
    await app.waitForMarker('APP_READY', STARTUP_TIMEOUT_MS);
    appReadyMs = Date.now() - startedAtMs;
    wid = getWidFromLines(app.lines);
    if (!wid) throw new Error('APP_READY printed without WID');
  } catch (e) {
    await app.stop();
    const report = {
      generated_at: startedAt,
      strategy: STRATEGY,
      fatal: e.message,
      app_ready: false,
      log: path.relative(ROOT, LOG),
    };
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
    console.error(`FATAL: ${e.message}`);
    process.exit(2);
  }

  console.log(`APP_READY in ${appReadyMs}ms wid=${hexWid(wid)} strategy=${STRATEGY}`);

  let latency = null;
  let focusReturn = null;
  try {
    latency = await latencyPhase(app, wid);
    if (focusReturnAttempts > 0) {
      focusReturn = await focusReturnPhase(app, wid, originalFocus);
    }
  } finally {
    await app.stop();
  }

  const report = {
    generated_at: startedAt,
    finished_at: new Date().toISOString(),
    nfr: 'NFR-01',
    gate: 'G2',
    strategy: STRATEGY,
    environment: {
      DISPLAY,
      electron: ELECTRON,
      app: path.relative(ROOT, APP),
      hotkey_xdotool: HOTKEY_XDOTOOL,
      pass_threshold_ms: PASS_P95_MS,
      started_at: startedAt,
      app_ready_ms: appReadyMs,
      wid: hexWid(wid),
      log: path.relative(ROOT, LOG),
      samples_out: path.relative(ROOT, SAMPLES_OUT),
    },
    runs: RUNS,
    samples: latency.samples,
    focus_success: latency.focus_success,
    complete_samples: latency.complete_samples,
    missing_samples: latency.missing_samples,
    focus_latency: latency.focus_latency,
    raf_latency: latency.raf_latency,
    raf1_latency: latency.raf1_latency,
    pass: latency.pass,
    focus_return: focusReturn,
    logs: latency.logs,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');

  for (const line of latency.logs) console.log(line);
  console.log(
    `n=${latency.focus_latency.n} focus_success=${latency.focus_success}/${RUNS}` +
      ` focus p50=${latency.focus_latency.p50} p95=${latency.focus_latency.p95}` +
      ` max=${latency.focus_latency.max} ms` +
      ` raf p50=${latency.raf_latency.p50} p95=${latency.raf_latency.p95}` +
      ` max=${latency.raf_latency.max} ms pass=${latency.pass}`
  );
  if (focusReturn) {
    console.log(
      `focus_return=${focusReturn.successes}/${focusReturn.attempts_count}` +
        ` pass=${focusReturn.pass} evidence=${focusReturn.evidence}`
    );
  }
  console.log(`OUT=${path.relative(ROOT, OUT)}`);

  process.exitCode = latency.pass ? 0 : 1;
}

main().catch(async (e) => {
  console.error(`FATAL: ${e && e.stack ? e.stack : e}`);
  process.exit(2);
});
