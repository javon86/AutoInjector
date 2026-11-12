'use strict';
/*
 * cli-mode-watch.js — ⌨ Command-line mode (try it first), AutoInjector's side.
 *
 * In Akọwe each AI slot can be a "Web window" (AutoInjector types into the web page, as always) or "Command line"
 * (Akọwe runs Claude Code / Codex on this PC itself: akowe/akowe/cli_mode.py). Akọwe owns that choice; this module
 * MIRRORS it for AutoInjector's 📚 Akọwe panel:
 *   • it reads Akọwe's GET /api/cli-mode (which slot is on the command line, whether Claude Code / Codex are installed
 *     and signed in, and the last command-line exchanges — a short summary of what was asked and the answer's start),
 *     at most every `minGapMs`, and keeps a bounded, cleaned copy for the panel (`peek()`);
 *   • the panel's "Web window / Command line" choice and the "Two AIs on command line" preset are sent back to Akọwe
 *     (PUT /api/slots/<id> {mode}, POST /api/cli-mode/preset), so both programs always show the same thing;
 *   • `cliSites()` says which AI panes are on the command line: main.js moves those web panes out of sight and the
 *     panel shows a plain status card there instead (the web pane code itself is untouched).
 *
 * Electron-free: createCliWatch({ api(method, path, body) -> {status, json}, now, minGapMs }). Never throws. The
 * exchanges are kept in memory only and never logged (codes and counts only).
 */

const SITES = ['claude', 'chatgpt', 'gemini'];
const CLI_SITES = new Set(['claude', 'chatgpt']);
const STATES = new Set(['ready', 'not_installed', 'signed_out', 'limited', 'failing', 'off', 'checking']);
const MAX_EXCHANGES = 40;

const str = (v, n) => (v == null ? '' : String(v)).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, n || 200);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Akọwe's /api/cli-mode answer → a bounded, cleaned view (or null when it is not one). */
function viewOf(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.slots)) return null;
  const slots = json.slots.filter((s) => s && typeof s === 'object' && /^AI-[123]$/.test(String(s.slot_id))).slice(0, 3).map((s) => {
    const site = SITES.includes(s.site) ? s.site : null;
    const cli = !!(s.cli && site && CLI_SITES.has(site));
    return { slot_id: String(s.slot_id), site, adapter_id: str(s.adapter_id, 20), mode: cli ? 'cli' : 'web', cli, can_cli: !!(s.can_cli && site && CLI_SITES.has(site)) };
  });
  const tools = {};
  for (const t of ['claude', 'codex']) {
    const x = (json.tools && json.tools[t]) || {};
    tools[t] = { state: STATES.has(x.state) ? x.state : 'checking', words: str(x.words, 240), version: str(x.version, 30), name: t === 'claude' ? 'Claude Code' : 'Codex' };
  }
  const exchanges = (Array.isArray(json.exchanges) ? json.exchanges : []).filter((e) => e && typeof e === 'object' && Number.isInteger(e.id)).slice(-MAX_EXCHANGES).map((e) => ({
    id: e.id, at: num(e.at), slot_id: str(e.slot_id, 8), site: SITES.includes(e.site) ? e.site : null, tool: e.tool === 'codex' ? 'codex' : 'claude',
    task: str(e.task, 260), answer: str(e.answer, 1500), outcome: str(e.outcome, 40), seconds: num(e.seconds), pictures: Number.isInteger(e.pictures) ? e.pictures : 0,
  }));
  return { slots, tools, exchanges, running: Number.isInteger(json.running) ? json.running : 0 };
}

/** The sites whose AI runs on the command line (their web panes are not used by Akọwe). */
function cliSitesOf(view) {
  const out = new Set();
  for (const s of (view && view.slots) || []) if (s.cli && s.site) out.add(s.site);
  return out;
}

function createCliWatch(d) {
  const api = d.api;
  const now = d.now || (() => Date.now());
  const minGapMs = d.minGapMs == null ? 4000 : d.minGapMs;
  let view = null;
  let at = 0;
  let busy = null;
  let lastId = 0;
  let exchanges = [];

  function take(json) {
    const v = viewOf(json);
    if (!v) return null;
    // the exchanges come in pieces (?after=<last id>): keep the newest MAX_EXCHANGES
    if (Number.isInteger(json.last_id) && json.last_id < lastId) { lastId = 0; exchanges = []; } // Akọwe restarted
    const fresh = v.exchanges.filter((e) => e.id > lastId);
    exchanges = exchanges.concat(fresh).slice(-MAX_EXCHANGES);
    if (fresh.length) lastId = fresh[fresh.length - 1].id;
    view = Object.assign({}, v, { exchanges: exchanges.slice() });
    at = now();
    return view;
  }

  async function refresh(force) {
    if (busy) return busy;
    if (!force && view && now() - at < minGapMs) return view;
    busy = (async () => {
      try {
        const r = await api('GET', `/api/cli-mode?after=${lastId}`);
        if (r && r.status === 200) take(r.json);
        else if (r && r.status === 0) { view = null; }
      } catch (_) { /* Akọwe not running: nothing to mirror */ }
      finally { busy = null; }
      return view;
    })();
    return busy;
  }

  async function setMode(slotId, mode) {
    if (!/^AI-[123]$/.test(String(slotId)) || !['web', 'cli'].includes(mode)) return { ok: false, error: 'INVALID_INPUT' };
    const r = await api('PUT', `/api/slots/${slotId}`, { mode }).catch(() => null);
    if (!r || r.status !== 200) return { ok: false, error: (r && r.json && r.json.errors && r.json.errors[0] && str(r.json.errors[0].code, 40)) || 'NOT_SAVED', message: (r && r.json && r.json.errors && r.json.errors[0] && str(r.json.errors[0].message, 240)) || 'Akọwe did not save it.' };
    await refresh(true);
    return { ok: true, view };
  }

  async function preset(name) {
    if (!['two_cli', 'web'].includes(name)) return { ok: false, error: 'INVALID_INPUT' };
    const r = await api('POST', '/api/cli-mode/preset', { preset: name }).catch(() => null);
    if (!r || r.status !== 200) return { ok: false, error: 'NOT_SAVED', message: 'Akọwe did not save it (is Akọwe running?).' };
    take(r.json);
    return { ok: true, view };
  }

  return {
    peek: () => view,
    refresh,
    setMode,
    preset,
    cliSites: () => cliSitesOf(view),
  };
}

module.exports = { createCliWatch, viewOf, cliSitesOf, CLI_SITES };
