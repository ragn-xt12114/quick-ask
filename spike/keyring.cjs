#!/usr/bin/env node
/* Task 6 / G8 — Secret Service + Electron safeStorage spike.
 *
 * - Uses @napi-rs/keyring pinned to the Secret Service store (no silent
 *   fallback to kernel keyutils).
 * - Generates a random secret in memory only; logs sha256:<first 12 hex>.
 * - 5x set/get/compare/delete/get-null round-trip.
 * - Reports safeStorage.isEncryptionAvailable() + getSelectedStorageBackend()
 *   and asserts backend != "basic_text".
 * - Spawns a system-Node child with a non-existent DBUS bus to prove the
 *   unavailable-Secret-Service path is a clean typed error (no plaintext).
 * - Scans project text files for the full secret without printing it.
 * - Deletes the test entry and verifies it is gone.
 *
 * Run under Electron (main process), normally with the real Plasma session
 * environment (XDG_CURRENT_DESKTOP=KDE), because Electron without that env
 * falls back to the "basic_text" password store.
 */
'use strict';

const { app, safeStorage } = require('electron');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EVID = path.join(ROOT, '.omo', 'evidence');
const OUT_JSON = path.join(EVID, 'task-6-keyring.json');
const UNAVAILABLE_LOG = path.join(EVID, 'task-6-keyring-unavailable.log');
const BARE_SAFE_LOG = path.join(EVID, 'task-6-safe-storage-default-bare.log');
const SERVICE = 'quickask-test';
const ACCOUNT = 'provider:test:api_key';
const STORE_OPTIONS = { linux: { store: 'secret-service' } };
const ENTRY_OPTIONS_TEXT = '{ linux: { store: "secret-service" } }';

fs.mkdirSync(EVID, { recursive: true });

function log(message) {
  const line = `[keyring-spike] ${new Date().toISOString()} ${message}`;
  console.log(line);
}

function fingerprint(secret) {
  return 'sha256:' + nodeCrypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

function writeJson(data) {
  const tmp = OUT_JSON + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, OUT_JSON);
}

function describeError(err) {
  if (!err) return null;
  return {
    name: err.name || 'Error',
    code: err.code || null,
    message: String(err.message || err).slice(0, 500),
  };
}

function safeStorageInfo() {
  const info = {
    is_encryption_available: null,
    selected_backend: null,
    error: null,
  };
  try {
    info.is_encryption_available = safeStorage.isEncryptionAvailable();
  } catch (err) {
    info.error = describeError(err);
  }
  try {
    info.selected_backend = safeStorage.getSelectedStorageBackend();
  } catch (err) {
    info.error = info.error || describeError(err);
  }
  return info;
}

function parseBareSafeStorageLog() {
  if (!fs.existsSync(BARE_SAFE_LOG)) return null;
  const text = fs.readFileSync(BARE_SAFE_LOG, 'utf8');
  const backend = /SAFE_STORAGE_BACKEND=([^\s]+)/.exec(text);
  const available = /SAFE_STORAGE_AVAILABLE=(true|false)/.exec(text);
  return {
    evidence: path.relative(ROOT, BARE_SAFE_LOG),
    selected_backend: backend ? backend[1] : null,
    is_encryption_available: available ? available[1] === 'true' : null,
  };
}

function readPkgVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@napi-rs', 'keyring', 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

function collectTextFiles() {
  const roots = ['package.json', 'scripts', 'docs', 'spike', 'tools', '.omo/evidence'];
  const skipDirs = new Set(['node_modules', '.cache', 'out', '.git', 'test-results', 'release', 'frames-blur', 'frames-cycle-gpu-off', 'frames-cycle-gpu-on', 'frames-cycle-transparent-visuals', 'frames-g5', 'frames-opaque', 'frames-sizes']);
  const textExt = new Set(['.json', '.log', '.txt', '.md', '.cjs', '.mjs', '.js', '.ts', '.tsx', '.jsx', '.css', '.html', '.svg', '.sh', '.yml', '.yaml', '.toml', '.ini', '.conf']);
  const files = [];
  function walk(target) {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      const base = path.basename(target);
      if (skipDirs.has(base)) return;
      let entries;
      try {
        entries = fs.readdirSync(target);
      } catch {
        return;
      }
      for (const entry of entries) walk(path.join(target, entry));
      return;
    }
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return;
    if (!textExt.has(path.extname(target).toLowerCase())) return;
    files.push(target);
  }
  for (const root of roots) walk(path.join(ROOT, root));
  return files;
}

function scanForSecret(secret) {
  const files = collectTextFiles();
  const hits = [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (content.includes(secret)) hits.push(path.relative(ROOT, file));
  }
  return {
    files_scanned: files.length,
    hits,
    no_plaintext: hits.length === 0,
  };
}

function runUnavailableChild() {
  const childPath = path.join(ROOT, 'spike', 'keyring-unavailable.cjs');
  const nodeBin = process.env.QUICKASK_NODE_BIN || 'node';
  const nodeVersion = spawnSync(nodeBin, ['-v'], { encoding: 'utf8' });
  const env = {
    ...process.env,
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/quickask-nonexistent-bus',
  };
  delete env.XDG_CURRENT_DESKTOP;
  const result = spawnSync(nodeBin, [childPath], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(stdout.split(/\r?\n/).filter(Boolean).pop());
  } catch {
    parsed = null;
  }
  const errorText = parsed && parsed.error_message
    ? parsed.error_message
    : (stderr || stdout || 'no error output');
  const logText = [
    '# Task 6 / G8 — Secret Service unavailable path',
    `# generated: ${new Date().toISOString()}`,
    `# command: DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/quickask-nonexistent-bus ${nodeBin} ${childPath}`,
    `# node: ${(nodeVersion.stdout || '').trim()}`,
    `# exit: ${result.status}`,
    `# signal: ${result.signal || 'none'}`,
    '',
    '## stdout',
    stdout,
    '',
    '## stderr',
    stderr,
    '',
  ].join('\n');
  fs.writeFileSync(UNAVAILABLE_LOG, logText, 'utf8');
  return {
    command: `DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/quickask-nonexistent-bus ${nodeBin} ${childPath}`,
    node_bin: nodeBin,
    node_version: (nodeVersion.stdout || '').trim(),
    exit: result.status,
    signal: result.signal || null,
    stdout,
    stderr,
    parsed,
    error: errorText,
    error_code: parsed ? parsed.error_code : null,
    error_name: parsed ? parsed.error_name : null,
    log: path.relative(ROOT, UNAVAILABLE_LOG),
    clean_nonzero: result.status !== 0 && result.status !== null,
  };
}

const safeStorageOnly = process.argv.includes('--safe-storage-only');

app.setName('quickask-keyring-spike');

app.whenReady().then(() => {
  const info = safeStorageInfo();
  if (safeStorageOnly) {
    console.log(`SAFE_STORAGE_AVAILABLE=${info.is_encryption_available}`);
    console.log(`SAFE_STORAGE_BACKEND=${info.selected_backend}`);
    console.log(`XDG_CURRENT_DESKTOP=${process.env.XDG_CURRENT_DESKTOP || ''}`);
    app.quit();
    return;
  }

  const secret = nodeCrypto.randomBytes(32).toString('hex');
  const fp = fingerprint(secret);
  const startedAt = new Date().toISOString();
  const moduleVersion = readPkgVersion();
  const bareSafe = parseBareSafeStorageLog();
  const assertBackend = info.selected_backend && info.selected_backend !== 'basic_text';

  let modulePath;
  try {
    modulePath = require.resolve('@napi-rs/keyring');
  } catch {
    modulePath = null;
  }

  const result = {
    schema_version: 1,
    generated_at: startedAt,
    spike: 'G8 Secret Service',
    module: '@napi-rs/keyring',
    module_version: moduleVersion,
    module_path: modulePath,
    electron_version: process.versions.electron,
    node_version_electron: process.versions.node,
    entry: {
      service: SERVICE,
      account: ACCOUNT,
      store: 'secret-service',
      options: ENTRY_OPTIONS_TEXT,
    },
    secret_fingerprint: fp,
    backend: info.selected_backend,
    encryption_available: info.is_encryption_available,
    safe_storage: {
      selected_backend: info.selected_backend,
      is_encryption_available: info.is_encryption_available,
      is_basic_text: info.selected_backend === 'basic_text',
      assertion_backend_not_basic_text: Boolean(assertBackend),
      persisted_via_safe_storage: false,
      xdg_current_desktop: process.env.XDG_CURRENT_DESKTOP || null,
      desktop_session: process.env.DESKTOP_SESSION || null,
      kde_full_session: process.env.KDE_FULL_SESSION || null,
      kde_session_version: process.env.KDE_SESSION_VERSION || null,
      error: info.error,
      bare_shell_default: bareSafe,
    },
    roundtrip: {
      attempts: 5,
      success: 0,
      entry_holds_secret: false,
      details: [],
    },
    unavailable: null,
    deleted: false,
    final_get_after_delete: null,
    no_plaintext: false,
    no_plaintext_scan: null,
    locked_state_tested: false,
    limitations: [
      'The live locked keyring state was not exercised to avoid disrupting the session; the unavailable path was tested in isolation with a non-existent DBUS bus.',
      'Electron safeStorage without XDG_CURRENT_DESKTOP falls back to basic_text on this machine; the recorded run uses the real Plasma session env (XDG_CURRENT_DESKTOP=KDE), which selects kwallet6.',
    ],
    evidence: [
      '.omo/evidence/task-6-keyring.json',
      '.omo/evidence/task-6-keyring.log',
      '.omo/evidence/task-6-keyring-unavailable.log',
      '.omo/evidence/task-6-keyring-install.log',
      '.omo/evidence/task-6-keyring-env.txt',
      '.omo/evidence/task-6-keyring-session-env.txt',
      '.omo/evidence/task-6-keyring-driver.log',
      '.omo/evidence/task-6-keyring-node-sanity.log',
      '.omo/evidence/task-6-grep.txt',
      '.omo/evidence/task-6-safe-storage-default-bare.log',
      '.omo/evidence/task-6-safe-storage-actual-env.log',
    ],
    status: 'FAIL',
  };

  let Entry;
  try {
    ({ Entry } = require('@napi-rs/keyring'));
  } catch (err) {
    result.fatal_error = describeError(err);
    result.status = 'FAIL';
    result.summary = { module_load: false };
    try {
      writeJson(result);
    } catch {
      // ignore secondary write failure
    }
    log(`FATAL keyring module load failed in Electron: ${result.fatal_error.name}: ${result.fatal_error.message}`);
    setTimeout(() => app.quit(), 100);
    return;
  }

  let entry = null;
  try {
    entry = new Entry(SERVICE, ACCOUNT, STORE_OPTIONS);
    log(`module ${moduleVersion} loaded from ${modulePath}`);
    log(`safeStorage backend=${info.selected_backend} encryptionAvailable=${info.is_encryption_available}`);
    log(`secret fingerprint ${fp} (secret itself is never printed/written)`);

    // Remove any stale test credential before starting.
    try {
      entry.deletePassword();
    } catch (err) {
      log(`pre-clean note: ${describeError(err).message}`);
    }

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const detail = {
        attempt,
        set_ok: false,
        get_matches: false,
        delete_returned: null,
        after_delete_null: false,
        after_delete_error: null,
      };
      try {
        entry.setPassword(secret);
        detail.set_ok = true;
        const got = entry.getPassword();
        detail.get_matches = got === secret;
        detail.delete_returned = entry.deletePassword();
        try {
          const after = entry.getPassword();
          detail.after_delete_null = after === null;
        } catch (err) {
          // Task allows null or a clean error after deletion.
          detail.after_delete_null = true;
          detail.after_delete_error = describeError(err);
        }
        if (detail.get_matches && detail.delete_returned !== false && detail.after_delete_null) {
          result.roundtrip.success += 1;
        }
      } catch (err) {
        detail.error = describeError(err);
      }
      result.roundtrip.details.push(detail);
      log(`roundtrip ${attempt}/5 set=${detail.set_ok} match=${detail.get_matches} delete=${detail.delete_returned} after_null=${detail.after_delete_null}`);
    }

    // One extra set keeps the entry present for the no-plaintext inspection
    // and for a final delete/get-null verification.  It is not part of 5/5.
    entry.setPassword(secret);
    result.roundtrip.entry_holds_secret = entry.getPassword() === secret;
    result.no_plaintext_scan = scanForSecret(secret);
    result.no_plaintext = result.no_plaintext_scan.no_plaintext;
    log(`entry_holds_secret=${result.roundtrip.entry_holds_secret} no_plaintext=${result.no_plaintext} files_scanned=${result.no_plaintext_scan.files_scanned} hits=${result.no_plaintext_scan.hits.length}`);

    result.unavailable = runUnavailableChild();
    log(`unavailable path exit=${result.unavailable.exit} error=${result.unavailable.error.slice(0, 180)}`);
  } catch (err) {
    result.fatal_error = describeError(err);
    log(`FATAL ${result.fatal_error.name}: ${result.fatal_error.message}`);
  } finally {
    // Final cleanup and verification: delete + get must be null/error.
    try {
      if (entry) {
        result.final_delete_returned = entry.deletePassword();
        try {
          result.final_get_after_delete = entry.getPassword();
        } catch (err) {
          result.final_get_after_delete = null;
          result.final_get_after_delete_error = describeError(err);
        }
      }
    } catch (err) {
      result.cleanup_error = describeError(err);
    }
    result.deleted = result.final_get_after_delete === null;
    result.roundtrip.attempts = 5;
    result.roundtrip.success = Math.min(result.roundtrip.success, 5);
    const keyringOk = result.roundtrip.success === 5;
    const safeOk = Boolean(assertBackend);
    const unavailableOk = Boolean(result.unavailable && result.unavailable.clean_nonzero);
    const cleanupOk = result.deleted === true;
    const noPlaintextOk = result.no_plaintext === true;
    result.status = keyringOk && safeOk && unavailableOk && cleanupOk && noPlaintextOk ? 'PASS' : 'PARTIAL';
    result.summary = {
      keyring_5_of_5: keyringOk,
      safe_storage_backend_not_basic_text: safeOk,
      unavailable_clean_nonzero: unavailableOk,
      entry_deleted: cleanupOk,
      no_plaintext: noPlaintextOk,
    };
    try {
      writeJson(result);
      log(`wrote ${OUT_JSON} status=${result.status}`);
    } catch (err) {
      log(`failed to write ${OUT_JSON}: ${describeError(err).message}`);
    }
    setTimeout(() => app.quit(), 100);
  }
});
