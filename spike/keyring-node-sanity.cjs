#!/usr/bin/env node
/* System-Node sanity check for @napi-rs/keyring (same Secret Service entry).
 * The random secret is never printed or written; only booleans/fingerprint.
 */
'use strict';
const nodeCrypto = require('node:crypto');
const { Entry } = require('@napi-rs/keyring');
const secret = nodeCrypto.randomBytes(24).toString('hex');
const fingerprint = 'sha256:' + nodeCrypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
const entry = new Entry('quickask-test', 'provider:test:api_key', { linux: { store: 'secret-service' } });
let out = { fingerprint, module: require.resolve('@napi-rs/keyring'), set: false, match: false, delete: null, after_null: false };
try {
  entry.setPassword(secret);
  out.set = true;
  out.match = entry.getPassword() === secret;
  out.delete = entry.deletePassword();
  out.after_null = entry.getPassword() === null;
} catch (err) {
  out.error = { name: err.name, code: err.code || null, message: String(err.message || err).slice(0, 400) };
} finally {
  try { entry.deletePassword(); } catch { /* ignore */ }
}
console.log(JSON.stringify(out));
process.exit(out.set && out.match && out.delete !== false && out.after_null ? 0 : 1);
