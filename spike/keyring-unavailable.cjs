#!/usr/bin/env node
/* Task 6 / G8 — isolate the "Secret Service unavailable" path.
 *
 * Run with system Node and a deliberately invalid DBUS_SESSION_BUS_ADDRESS.
 * The Entry is pinned to the secret-service store so @napi-rs/keyring cannot
 * silently fall back to the in-memory kernel keyutils store.
 *
 * The random secret is used only to force a setPassword call; it is never
 * printed or written.
 */
'use strict';

const nodeCrypto = require('node:crypto');

let Entry;
try {
  ({ Entry } = require('@napi-rs/keyring'));
} catch (err) {
  console.log(JSON.stringify({
    unexpected_success: false,
    stage: 'module_load',
    error_name: err && err.name,
    error_code: err && err.code,
    error_message: String(err && err.message ? err.message : err).slice(0, 500),
  }));
  process.exit(3);
}

const secret = nodeCrypto.randomBytes(24).toString('hex');

try {
  const entry = new Entry('quickask-test', 'provider:test:api_key', {
    linux: { store: 'secret-service' },
  });
  entry.setPassword(secret);
  // Should never be reached when DBUS is unavailable.
  console.log(JSON.stringify({ unexpected_success: true, stage: 'setPassword' }));
  try {
    entry.deletePassword();
  } catch {
    // ignore
  }
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({
    unexpected_success: false,
    stage: 'secret-service',
    error_name: err && err.name ? err.name : 'Error',
    error_code: err && err.code ? err.code : null,
    error_message: String(err && err.message ? err.message : err).slice(0, 500),
    dbus_session_bus_address: process.env.DBUS_SESSION_BUS_ADDRESS || null,
  }));
  process.exit(2);
}
