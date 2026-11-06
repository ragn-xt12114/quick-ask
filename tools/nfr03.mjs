#!/usr/bin/env node
/*
 * NFR-03 / G3 driver — cold start and hidden → show latency.
 *
 * Dependency-free (Node 24). Real XTEST key events via xdotool; driver-side
 * MapNotify evidence via `xwininfo -id <WID>` polling plus the app's own
 * renderer rAF timings from the JSONL sample stream.
 *
 * READY DEFINITION (spike): app ready + window created + renderer
 * did-finish-load + global hotkey registered + X11 props applied. There is no
 * tray in the M0 spike, so "tray ready" does not exist yet; Task 6/28 must
 * re-measure cold start to tray-ready using the real app entry (--app).
 *
 * Usage:
 *   source scripts/env.sh
 *   node tools/nfr03.mjs --cold-runs 10 --show-runs 20 \
 *     --out .omo/evidence/task-4-nfr03.json
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

const COLD_RUNS = Number(argValue('--cold-runs', '10'));
const SHOW_RUNS = Number(argValue('--show-runs', '20'));
const STRATEGY = argValue('--strategy', 'show-focus');
const OUT = path.resolve(argValue('--out', path.join(EVID, 'task-4-nfr03.json')));
const APP = path.resolve(argValue('--app', path.join(ROOT, 'spike', 'hotkey.cjs')));
const ELECTRON = path.resolve(argValue('--electron', path.join(ROOT, 'node_modules', '.bin', 'electron')));
const SAMPLES_OUT = path.resolve(
  argValue('--samples-out', path.join(EVID, 'task-4-nfr03-samples.jsonl'))
);
const SHOW_LOG = path.resolve(argValue('--show-log', path.join(EVID, 'task-4-nfr03-show.log')));
const COLD_LOG_PREFIX = path.resolve(
  argValue('--cold-log-prefix', path.join(EVID, 'task-4-nfr03-cold'))
);
const HOTKEY_XDOTOOL = argValue('--hotkey-xdotool', 'ctrl+alt+space');
const COLD_TIMEOUT_MS = Number(argValue('--cold-timeout-ms', '30000'));
const STARTUP_TIMEOUT_MS = Number(argValue('--startup-timeout-ms', '30000'));
const SAMPLE_TIMEOUT_MS = Number(argValue('--sample-timeout-ms', '5000'));
const SETTLE_MS = Number(argValue('--settle-ms', '500'));
const BETWEEN_MS = Number(argValue('--between-ms', '150'));
const COLD_PASS_MS = 2000;
const SHOW_PASS_MS = 50;
const DISPLAY = process.env.DISPLAY || ':0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
function stats(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return { n: 0, p50: null, p95: null, max: null, min: null, mean: null };
  return {
    n: clean.length,
    p50: percentile(clean, 50),
    p95: percentile(clean, 95),
    max: Math.max(...clean),
    min: Math.min(...clean),
    mean: Math.round((clean.reduce((a, b) => a + b, 0) / clean.length) * 1000) / 1000,
  };
}
function hexWid(wid) {
  return '0x' + Number(wid).toString(16);
}
function run(cmd, args, timeout = 5000) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY },
    timeout,
  });
}

// ---------------------------------------------------------------- process wrapper
class AppProc {
  constructor(logFile, sampleFile) {
    this.logFile = logFile;
    this.sampleFile = sampleFile;
    this.child = null;
    this.buffer = '';
    this.lines = [];
    this.hiddenCount = 0;
    this.exited = false;
    this.sampleCount = 0;
    this.logStream = null;
    this.waiters = [];
  }

  start(extraArgs) {
    fs.writeFileSync(this.logFile, '');
    fs.writeFileSync(this.sampleFile, '');
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    const args = [
      APP,
      '--strategy', STRATEGY,
      '--samples-out', this.sampleFile,
      '--idle-timeout-ms', '120000',
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
    this.child.on('exit', (code) => {
      this.exited = true;
      for (const w of this.waiters.slice()) w.reject(new Error(`app exited code=${code}`));
      this.waiters = [];
    });
    this.child.on('error', (e) => {
      this.exited = true;
      for (const w of this.waiters.slice()) w.reject(e);
      this.waiters = [];
    });
    return this;
  }

  waitForLine(predicate, timeoutMs, label) {
    for (const line of this.lines) if (predicate(line)) return Promise.resolve(line);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout waiting for ${label} after ${timeoutMs}ms`));
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

  waitForMarker(marker, timeoutMs) {
    return this.waitForLine((l) => l.trim() === marker, timeoutMs, marker);
  }

  readNewSamples() {
    let text;
    try {
      text = fs.readFileSync(this.sampleFile, 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n');
    if (!text.endsWith('\n')) lines.pop();
    const fresh = lines.slice(this.sampleCount);
    const parsed = [];
    for (const line of fresh) {
      if (!line.trim()) continue;
      try {
        parsed.push(JSON.parse(line));
      } catch {
        break;
      }
    }
    this.sampleCount += parsed.length;
    return parsed;
  }

  async waitForSample(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const got = this.readNewSamples();
      if (got.length) return got[0];
      await sleep(5);
    }
    throw new Error(`timeout waiting for sample after ${timeoutMs}ms`);
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

function getWid(lines) {
  for (const line of lines) {
    const m = /^WID=(0x[0-9a-fA-F]+)\s*$/.exec(line.trim());
    if (m) return Number.parseInt(m[1], 16);
  }
  return 0;
}
function mapState(wid) {
  const r = run('xwininfo', ['-id', hexWid(wid)]);
  const m = /Map State:\s*(\w+)/.exec(r.stdout || '');
  return m ? m[1] : 'unknown';
}
async function waitForMapState(wid, wanted, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = mapState(wid);
    if (state === wanted) return { ok: true, state, ms: Date.now() - start };
    await sleep(10);
  }
  return { ok: false, state: mapState(wid), ms: Date.now() - start };
}

// ---------------------------------------------------------------- phases
async function coldStartPhase() {
  const samples = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    const logFile = `${COLD_LOG_PREFIX}-${String(i + 1).padStart(2, '0')}.log`;
    const app = new AppProc(logFile, path.join(EVID, `.task-4-nfr03-cold-${i + 1}.jsonl`)).start([
      '--max-samples', '0',
    ]);
    const t0 = Date.now();
    let sample;
    try {
      await app.waitForMarker('APP_READY', COLD_TIMEOUT_MS);
      const readyMs = Date.now() - t0;
      const wid = getWid(app.lines);
      const hotkeyLine = app.lines.find((l) => /^HOTKEY_REGISTERED=/.test(l.trim()));
      sample = {
        run: i + 1,
        spawn_ms: t0,
        app_ready_ms: readyMs,
        wid: hexWid(wid),
        hotkey_registered: hotkeyLine ? hotkeyLine.trim().endsWith('true') : false,
        ready_definition:
          'app ready + window created + renderer did-finish-load + hotkey registered + X11 props applied',
        log: path.relative(ROOT, logFile),
        error: null,
      };
    } catch (e) {
      sample = {
        run: i + 1,
        spawn_ms: t0,
        app_ready_ms: null,
        wid: '0x0',
        hotkey_registered: false,
        ready_definition: null,
        log: path.relative(ROOT, logFile),
        error: e.message,
      };
    }
    await app.stop();
    samples.push(sample);
    await sleep(300);
  }

  const times = samples.map((s) => s.app_ready_ms).filter((v) => v != null);
  const st = stats(times);
  return {
    runs: COLD_RUNS,
    samples,
    stats: st,
    ready_definition:
      'app ready + window created + renderer did-finish-load + hotkey registered + X11 props applied (no tray yet)',
    tray_ready_note:
      'M0 spike has no tray; "tray ready" will be re-measured on the real app entry in Task 6/28.',
    threshold_ms: COLD_PASS_MS,
    pass: times.length === COLD_RUNS && st.max != null && st.max <= COLD_PASS_MS,
    p95_pass: times.length === COLD_RUNS && st.p95 != null && st.p95 <= COLD_PASS_MS,
  };
}

async function showPhase() {
  const app = new AppProc(SHOW_LOG, SAMPLES_OUT).start([
    '--max-samples', String(SHOW_RUNS),
  ]);
  const t0 = Date.now();
  await app.waitForMarker('APP_READY', STARTUP_TIMEOUT_MS);
  const appReadyMs = Date.now() - t0;
  const wid = getWid(app.lines);
  if (!wid) throw new Error('APP_READY printed but no WID found');
  await sleep(SETTLE_MS);

  const samples = [];
  for (let i = 0; i < SHOW_RUNS; i++) {
    // Ensure the window is really unmapped before sending the next hotkey.
    const preUnmap = await waitForMapState(wid, 'IsUnMapped', 1000);
    if (!preUnmap.ok) {
      console.error(`WARN run=${i + 1} pre-show map state=${preUnmap.state} (expected IsUnMapped)`);
    }
    const hiddenBefore = app.hiddenCount;
    const tSend = Date.now();
    const key = run('xdotool', ['key', '--clearmodifiers', HOTKEY_XDOTOOL]);
    const tKeyReturn = Date.now();
    let mapMs = null;
    let tMap = null;
    const mapStart = Date.now();
    while (Date.now() - mapStart < 2000) {
      if (mapState(wid) === 'IsViewable') {
        tMap = Date.now();
        mapMs = tMap - tSend;
        break;
      }
      await sleep(5);
    }
    let raw = null;
    let error = null;
    try {
      raw = await app.waitForSample(SAMPLE_TIMEOUT_MS);
      await app.waitForLine(() => app.hiddenCount > hiddenBefore, SAMPLE_TIMEOUT_MS, 'HIDDEN');
    } catch (e) {
      error = e.message;
    }
    await sleep(BETWEEN_MS);
    const rafLatency = raw && raw.raf2_ms != null ? raw.raf2_ms - raw.hotkey_ms : null;
    const raf1Latency = raw && raw.raf1_ms != null ? raw.raf1_ms - raw.hotkey_ms : null;
    const focusLatency = raw && raw.focus_ms != null ? raw.focus_ms - raw.hotkey_ms : null;
    samples.push({
      run: i + 1,
      seq: raw ? raw.seq : null,
      hotkey_ms: raw ? raw.hotkey_ms : null,
      map_viewable_ms: mapMs,
      driver_show_latency_ms: mapMs,
      xdotool_duration_ms: tKeyReturn - tSend,
      map_after_key_return_ms: tMap != null ? tMap - tKeyReturn : null,
      driver_map_state_poll_ms: 5,
      pre_show_map_state: preUnmap.state,
      focus_latency_ms: focusLatency,
      raf1_latency_ms: raf1Latency,
      raf_latency_ms: rafLatency,
      app_show_latency_ms: rafLatency,
      x_focus_ok: raw ? raw.x_focus_ok : null,
      x_map_state: raw ? raw.x_map_state : null,
      key_exit: key.status,
      complete: raw ? raw.complete : false,
      error,
      raw,
    });
  }
  await app.stop();

  const appTimes = samples.map((s) => s.app_show_latency_ms).filter((v) => v != null);
  const driverTimes = samples.map((s) => s.driver_show_latency_ms).filter((v) => v != null);
  const afterKeyTimes = samples.map((s) => s.map_after_key_return_ms).filter((v) => v != null);
  const xdotoolTimes = samples.map((s) => s.xdotool_duration_ms).filter((v) => v != null);
  const appStats = stats(appTimes);
  const driverStats = stats(driverTimes);
  return {
    runs: SHOW_RUNS,
    wid: hexWid(wid),
    app_ready_ms: appReadyMs,
    log: path.relative(ROOT, SHOW_LOG),
    samples_out: path.relative(ROOT, SAMPLES_OUT),
    samples,
    app_raf_latency: appStats,
    driver_map_latency: driverStats,
    driver_map_after_key_return_latency: stats(afterKeyTimes),
    xdotool_duration: stats(xdotoolTimes),
    stats: appStats,
    driver_stats: driverStats,
    threshold_ms: SHOW_PASS_MS,
    pass: appTimes.length === SHOW_RUNS && appStats.p95 != null && appStats.p95 <= SHOW_PASS_MS,
    driver_p95_pass:
      driverTimes.length === SHOW_RUNS && driverStats.p95 != null && driverStats.p95 <= SHOW_PASS_MS,
    method_note:
      'app latency = renderer raf2_ms - main hotkey_ms. driver_map_latency = IsViewable time - t_send (includes xdotool process startup). driver_map_after_key_return_latency = IsViewable time - xdotool return (excludes most xdotool startup; may be negative if already mapped when xdotool returns). xdotool_duration quantifies driver overhead.',
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`NFR-03 cold start: ${COLD_RUNS} runs`);
  const cold = await coldStartPhase();
  console.log(
    `cold p50=${cold.stats.p50} p95=${cold.stats.p95} max=${cold.stats.max} ms pass=${cold.pass}`
  );

  console.log(`NFR-03 hidden→show: ${SHOW_RUNS} runs`);
  const show = await showPhase();
  console.log(
    `show app raf p50=${show.app_raf_latency.p50} p95=${show.app_raf_latency.p95}` +
      ` max=${show.app_raf_latency.max} ms pass=${show.pass}`
  );
  console.log(
    `show driver map p50=${show.driver_map_latency.p50}` +
      ` p95=${show.driver_map_latency.p95} max=${show.driver_map_latency.max} ms`
  );

  const report = {
    generated_at: startedAt,
    finished_at: new Date().toISOString(),
    nfr: 'NFR-03',
    gate: 'G3',
    strategy: STRATEGY,
    environment: {
      DISPLAY,
      electron: ELECTRON,
      app: path.relative(ROOT, APP),
      hotkey_xdotool: HOTKEY_XDOTOOL,
      cold_threshold_ms: COLD_PASS_MS,
      show_threshold_ms: SHOW_PASS_MS,
    },
    cold_start: cold,
    show,
    pass: cold.pass && show.pass,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log(`OUT=${path.relative(ROOT, OUT)}`);
  process.exitCode = report.pass ? 0 : 1;
}

main().catch(async (e) => {
  console.error(`FATAL: ${e && e.stack ? e.stack : e}`);
  process.exit(2);
});
