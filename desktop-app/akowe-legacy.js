'use strict';
// akowe-legacy.js — backward compatibility with Akọwe's former name, "BookForge"
// (renamed on 2026-10-25). Everything on the desktop side that still knows the
// old name lives here, so an existing install keeps working after the update:
//   * the bridge connection key file userData/bookforge-bridge-token is taken
//     over as userData/akowe-bridge-token (the saved pairing survives);
//   * the saved setting {"bookforge": {"enabled": true}} is still read;
//   * environment variables AUTOINJECTOR_BOOKFORGE_* and BOOKFORGE_PORT are still
//     read when the AUTOINJECTOR_AKOWE_* / AKOWE_PORT one is not set;
//   * an older Akọwe that still calls itself "bookforge" in /api/ping, in its
//     status pushes ({"app": "bookforge", "bookforge_url": ...}) and when pairing
//     ({"client": "bookforge"}) is still recognised;
//   * log events written before the rename ("bookforge-*") still count as Akọwe
//     events for Extract; the Extract book list file is taken over too;
//   * the app folder next to AutoInjector may still be ../bookforge with
//     run-bookforge.bat|.sh in it.
const fs = require('fs');
const path = require('path');

const OLD = 'bookforge';
const APP_IDS = Object.freeze(['akowe', OLD]);
const OLD_TOKEN_FILE = 'bookforge-bridge-token';
const OLD_EXTRACT_BOOKS_FILE = 'bookforge-extract-books.json';
const OLD_SETTINGS_KEY = OLD;
const OLD_EVENT_PREFIX = 'bookforge-';

// AUTOINJECTOR_AKOWE_<name>, else the old AUTOINJECTOR_BOOKFORGE_<name> ('' when neither is set).
function aiEnv(name, env) {
  const e = env || process.env;
  return String(e['AUTOINJECTOR_AKOWE_' + name] || e['AUTOINJECTOR_BOOKFORGE_' + name] || '').trim();
}
// AKOWE_<name> (the variable Akọwe itself reads), else BOOKFORGE_<name>.
function appEnv(name, env) {
  const e = env || process.env;
  return String(e['AKOWE_' + name] || e['BOOKFORGE_' + name] || '').trim();
}
function isAppId(v) { return APP_IDS.includes(v); }
// A log event kind that belongs to Akọwe (new "akowe-*" or old "bookforge-*").
function isAkoweEventKind(kind) {
  return typeof kind === 'string' && (kind.startsWith('akowe-') || kind.startsWith(OLD_EVENT_PREFIX));
}
// Take over a file of the old name in dir as newName (rename; copy when rename
// fails). Never overwrites an existing new file and never throws.
function adoptFile(dir, oldName, newName) {
  const from = path.join(dir, oldName);
  const to = path.join(dir, newName);
  try {
    if (fs.existsSync(to) || !fs.existsSync(from)) return false;
    try { fs.renameSync(from, to); } catch (_) { fs.copyFileSync(from, to); }
    try { fs.chmodSync(to, 0o600); } catch (_) {}
    return true;
  } catch (_) { return false; }
}
// The saved {enabled} setting: the new key, else the one saved before the rename.
function settingsFrom(snap) {
  if (!snap || typeof snap !== 'object') return null;
  for (const k of ['akowe', OLD_SETTINGS_KEY]) if (snap[k] && typeof snap[k] === 'object') return snap[k];
  return null;
}
// The Akọwe folder next to this app and its launcher: ../akowe/run-akowe.*, or
// the ../bookforge/run-bookforge.* of a checkout made before the rename.
function launcherCandidates(baseDir, explicitDir, platform) {
  const win = (platform || process.platform) === 'win32';
  const ext = win ? '.bat' : '.sh';
  const dirs = explicitDir ? [explicitDir] : [path.join(baseDir, '..', 'akowe'), path.join(baseDir, '..', OLD)];
  const out = [];
  for (const d of dirs) for (const n of ['run-akowe', 'run-' + OLD]) out.push(path.join(d, n + ext));
  return out;
}

module.exports = {
  APP_IDS, OLD_TOKEN_FILE, OLD_EXTRACT_BOOKS_FILE, OLD_SETTINGS_KEY, OLD_EVENT_PREFIX,
  aiEnv, appEnv, isAppId, isAkoweEventKind, adoptFile, settingsFrom, launcherCandidates
};
