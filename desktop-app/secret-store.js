'use strict';
/*
 * secret-store.js — seal/open small secrets (API keys) with the OS keychain via
 * Electron's safeStorage, the same mechanism saved-login passwords already use
 * (AI-001). Requiring Electron is wrapped in try/catch so this module also loads
 * in plain Node (unit tests): there, encryption is simply "unavailable" and
 * seal() returns null — callers then persist NO key rather than plaintext.
 *
 * Contract: seal(plaintext) -> base64 ciphertext or null; open(base64) ->
 * plaintext or ''. A sealed value is never plaintext, so nothing here ever
 * writes a readable key to disk.
 */
let _safeStorage = null;
try { _safeStorage = require('electron').safeStorage; } catch (_) { _safeStorage = null; }

function available() {
  try { return !!(_safeStorage && _safeStorage.isEncryptionAvailable()); } catch (_) { return false; }
}
function seal(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  if (!available()) return null;
  try { return _safeStorage.encryptString(String(plaintext)).toString('base64'); } catch (_) { return null; }
}
function open(b64) {
  if (!b64) return '';
  if (!available()) return '';
  try { return _safeStorage.decryptString(Buffer.from(String(b64), 'base64')); } catch (_) { return ''; }
}

module.exports = { available, seal, open };
