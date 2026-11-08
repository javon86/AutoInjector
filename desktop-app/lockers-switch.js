'use strict';
// lockers-switch.js — the on/off switch for the 📁 AI lockers (ai-lockers.js).
//
// The lockers are HIDDEN by default: switched off, out of sight, but the code is
// all still there and comes back exactly as before when the switch is turned on
// (⚙ More settings → ⚙ Advanced → "AI lockers (advanced, off)", or the env var
// AUTOINJECTOR_LOCKERS=1 for one run).
//
// Saved in the app's state file as { lockers: { enabled: true|false } }. A state
// file saved by an older build has no "lockers" key, so it reads as OFF — that IS
// the migration: everyone starts with the lockers hidden, by the user's choice.
//
// While off:
//   - no Locker tab in the AI columns, no ai-lockers folders are made;
//   - the lockers:* IPC calls answer OFF_RESULT (lockers:status still answers);
//   - an AI's [TO: TERMINAL] block is NOT run. It is logged, and that AI gets ONE
//     short plain notice per app run (createNoticeGate) — never more, so it can't
//     turn into a loop of notice → reply → notice;
//   - the routing explainer / butler intro don't teach [TO: TERMINAL] or the
//     locker commands (stripLockerTeaching for a user-edited copy).
// Electron-free, so it is unit-tested on its own (test/lockers-switch.test.js).

const ENV_VAR = 'AUTOINJECTOR_LOCKERS';
const OFF_MESSAGE = 'AI lockers are switched off (⚙ Advanced → AI lockers).';
const OFF_NOTICE = 'File commands are switched off in AutoInjector, so the commands in your [TO: TERMINAL] message were not run. ' +
  'Please don\'t use [TO: TERMINAL]; address [TO: USER], one of the other AIs, [TO: ALL] or [TO: NONE] instead. ' +
  'No need to reply to this (you won\'t be told again).';

/** true / false when the env var forces the switch for this run, null when it doesn't. */
function envOverride(env) {
  const v = String(((env || {})[ENV_VAR]) == null ? '' : (env || {})[ENV_VAR]).trim().toLowerCase();
  if (/^(1|true|on|yes)$/.test(v)) return true;
  if (/^(0|false|off|no)$/.test(v)) return false;
  return null;
}
/** The saved setting from a state-file snapshot. Missing (an older build's file) → off. */
function fromSnapshot(snap) {
  return !!(snap && snap.lockers && typeof snap.lockers === 'object' && snap.lockers.enabled === true);
}
/** What the snapshot stores. */
function toSnapshot(enabled) { return { enabled: enabled === true }; }
/** The switch as it applies right now: the env var wins over the saved setting. */
function effective(saved, env) {
  const o = envOverride(env);
  return o == null ? saved === true : o;
}
/** What every lockers:* call (except lockers:status) answers while the lockers are off. */
function offResult() { return { ok: false, error: 'LOCKERS_OFF', message: OFF_MESSAGE }; }

/** One notice per AI until reset() (app start / the switch flipped): first(site) → true only the first time. */
function createNoticeGate() {
  const told = new Set();
  return {
    first(site) { const k = String(site || ''); if (told.has(k)) return false; told.add(k); return true; },
    told(site) { return told.has(String(site || '')); },
    reset() { told.clear(); },
  };
}

// The locker teaching as main.js's built-in texts word it, so a saved / user-edited
// copy of the routing prompt can be cleaned while the lockers are off.
const GUIDE_RE = /\n*YOUR LOCKER \(your own private folder on this PC\):[\s\S]*?Results come back to you as a \[FROM: TERMINAL\] message\./g;
const ROUTING_CLAUSE_RE = /,? your own private folder \("locker"\) on the human's PC, through a command prompt that only works inside it \([\s\S]*?passes a file to another of us\),/g;
/** The same text without the [TO: TERMINAL] / locker instructions. */
function stripLockerTeaching(text) {
  let t = String(text == null ? '' : text);
  t = t.replace(GUIDE_RE, '');
  t = t.replace(ROUTING_CLAUSE_RE, ',');
  // In a list of tags ("[TO: USER], [TO: TERMINAL], or [TO: NONE]" / "… / [TO: TERMINAL] / …") just the tag goes.
  t = t.replace(/(\[TO: [A-Z]+\],\s*)\[TO: TERMINAL\],\s*/g, '$1').replace(/ \/ \[TO: TERMINAL\](?= \/)/g, '');
  // Anything still teaching the terminal (a line the user wrote themselves) goes as a whole line.
  t = t.split('\n').filter((line) => !/\bTO: TERMINAL\b|\bFROM: TERMINAL\b|\bYOUR LOCKER\b/.test(line)).join('\n');
  return t;
}

module.exports = { ENV_VAR, OFF_MESSAGE, OFF_NOTICE, envOverride, fromSnapshot, toSnapshot, effective, offResult, createNoticeGate, stripLockerTeaching };
