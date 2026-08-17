'use strict';
/*
 * atelier-governance.js — the opt-in governance layer that sits between a
 * finished AI reply and the rest of AutoInjector (transcript, UI, re-routing).
 *
 * AutoInjector already moves replies between panes. When the operator is using
 * those panes to *build a book project* (the ATELIER workflow), a reply from a
 * given AI is meant to become a specific artifact — a chapter, a bible entry,
 * an audit note. ATELIER's write-authority policy says which role may write
 * which path (deny by default). This module maps each pane to a target artifact
 * path and, when governance is enabled, asks the ATELIER bridge whether that
 * write is permitted. A refused reply is *held*: still shown in the transcript,
 * but not routed onward to the other panes.
 *
 * It is entirely opt-in and self-contained:
 *   - Disabled by default. When disabled, governTurn() is a no-op and the app
 *     behaves exactly as before.
 *   - If Python / the ATELIER package is unavailable, a governed turn is passed
 *     through (never held) and the reason is recorded, so a missing toolkit
 *     degrades to the old behaviour rather than blocking every reply.
 *   - Settings persist to a small JSON file in the app's userData dir.
 */
const fs = require('fs');
const path = require('path');
const bridge = require('./atelier-bridge');

const SITES = ['chatgpt', 'claude', 'gemini'];

const DEFAULTS = {
  enabled: false,
  projectDir: '',
  projectId: 'book',
  specVersion: 'v0.3.3',
  // Per-pane target artifact path, relative to projectDir. Empty = that pane's
  // replies are not governed (passed through untouched).
  targets: { chatgpt: '', claude: '', gemini: '' },
};

let _settingsPath = null;
let _settings = clone(DEFAULTS);

function clone(o) { return JSON.parse(JSON.stringify(o)); }

/** Point persistence at a directory (call once at startup) and load settings. */
function init(dir) {
  try {
    _settingsPath = path.join(dir || __dirname, 'atelier-governance.json');
    if (fs.existsSync(_settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(_settingsPath, 'utf8'));
      _settings = normalize(raw);
    }
  } catch (_) { _settings = clone(DEFAULTS); }
  return getSettings();
}

function normalize(raw) {
  const s = clone(DEFAULTS);
  if (raw && typeof raw === 'object') {
    if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled;
    if (typeof raw.projectDir === 'string') s.projectDir = raw.projectDir;
    if (typeof raw.projectId === 'string' && raw.projectId) s.projectId = raw.projectId;
    if (typeof raw.specVersion === 'string' && raw.specVersion) s.specVersion = raw.specVersion;
    if (raw.targets && typeof raw.targets === 'object') {
      for (const site of SITES) {
        if (typeof raw.targets[site] === 'string') s.targets[site] = raw.targets[site];
      }
    }
  }
  return s;
}

function save() {
  if (!_settingsPath) return;
  try { fs.writeFileSync(_settingsPath, JSON.stringify(_settings, null, 2), 'utf8'); }
  catch (_) { /* best effort; settings still live in memory */ }
}

function getSettings() { return clone(_settings); }

/** Merge a patch into settings, persist, and return the new settings. */
function setSettings(patch) {
  _settings = normalize(Object.assign(clone(_settings), patch || {}, {
    targets: Object.assign({}, _settings.targets, (patch && patch.targets) || {}),
  }));
  save();
  return getSettings();
}

function isEnabled() { return !!_settings.enabled; }

/**
 * Govern one finished reply.
 * @param {{site:string, text:string, id?:(number|string)}} turn
 * @returns {Promise<{governed:boolean, ok?:boolean, held?:boolean, role?:string,
 *                    target?:string, reason?:string, available?:boolean}>}
 */
async function governTurn(turn) {
  if (!_settings.enabled || !turn || !turn.site) return { governed: false };
  const target = _settings.targets[turn.site];
  if (!target) return { governed: false, reason: 'no target artifact mapped for this pane' };

  const role = bridge.roleFor(turn.site) || turn.site;
  const res = bridge.checkAuthority(role, target);

  if (!res.available) {
    // Toolkit missing: record why, but do not hold — fail open to the old
    // pass-through behaviour so an un-provisioned machine still works.
    return { governed: true, available: false, ok: true, held: false, role, target, reason: res.reason };
  }
  return {
    governed: true,
    available: true,
    ok: res.ok,
    held: !res.ok,
    role,
    target,
    reason: res.reason,
  };
}

/**
 * Deliver a reply into the configured project through the ATELIER adapter
 * (CREATE -> ROUTE -> DELIVER). Used by an explicit "commit this reply" action,
 * not the passive per-reply gate. Returns the adapter's verdict.
 */
function deliverTurn(turn, jobId) {
  const target = (turn && turn.site && _settings.targets[turn.site]) || '';
  return bridge.deliver({
    projectDir: _settings.projectDir,
    jobId: jobId || `job-${Date.now()}`,
    role: (turn && turn.site) || 'human',
    content: (turn && turn.text) || '',
    target,
    projectId: _settings.projectId,
    specVersion: _settings.specVersion,
  });
}

module.exports = {
  SITES,
  DEFAULTS,
  init,
  getSettings,
  setSettings,
  isEnabled,
  governTurn,
  deliverTurn,
  // bridge passthroughs for IPC / diagnostics
  detect: (opts) => bridge.detect(opts),
  stages: () => bridge.stages(),
  status: (dir) => bridge.status(dir || _settings.projectDir),
  checkAuthority: (role, p) => bridge.checkAuthority(role, p),
};
