'use strict';
// phone-core.js — 📱 the phone app, the plain parts (no Electron, no network): unit-tested.
//
// The phone app is a web page AutoInjector serves on the home Wi-Fi (phone-server.js) once you turn it on in the
// 📱 Phone window. The PC does all the work; the phone shows what is happening and can only:
//   • send a message to ChatGPT / Claude / Gemini, and ⏹ Stop them;
//   • ⏸ Pause / ▶ Continue the book run and answer its questions (the same choices as the run window);
//   • read the chapters;
//   • talk to Alfred (anything he wants to DO still waits for your OK on the PC).
// It can't open, change or delete files, run commands, or change settings.

const crypto = require('crypto');

const SITES = ['chatgpt', 'claude', 'gemini'];
const SITE_LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };
// The book's answers the phone may give (Akọwe's decide / resume). "I edited it" needs the PC (the editing happens there).
const PHONE_ACTIONS = ['resume', 'retry', 'approve_anyway', 'accept_change', 'keep_original'];
const NEEDS_CONFIRM = ['approve_anyway'];
const DEFAULT_PORT = 47800;

const clip = (s, n) => { s = String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A new pairing key: 32 url-safe characters. Changing it un-pairs every phone. */
function newToken(rand = crypto.randomBytes) {
  return rand(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Equal without leaking the length of the match (timing-safe). */
function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (!x.length || x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (_) { return false; }
}

/** The PC's addresses a phone on the same Wi-Fi can reach, best first (private IPv4, real adapters before virtual ones). */
function lanAddresses(ifaces) {
  const virtual = /(vethernet|virtualbox|vmware|hyper-v|wsl|docker|vbox|loopback|tailscale|zerotier|hamachi|bluetooth)/i;
  const priv = (a) => /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const ni of list || []) {
      if (!ni || ni.internal || (ni.family !== 'IPv4' && ni.family !== 4) || !ni.address || !priv(ni.address)) continue;
      const score = (virtual.test(name) ? 10 : 0) + (/^192\.168\./.test(ni.address) ? 0 : /^10\./.test(ni.address) ? 1 : 2) + (/wi-?fi|wlan|wireless/i.test(name) ? -1 : 0);
      out.push({ name, address: ni.address, score });
    }
  }
  return out.sort((a, b) => a.score - b.score).map(({ name, address }) => ({ name, address }));
}

/** The link the phone opens (the key rides in the #fragment: it never reaches a server log or the browser history's URL). */
function pairUrl(address, port, token) {
  return `http://${address}:${port}/#k=${encodeURIComponent(token)}`;
}

/** The book card: the run that matters now (Akọwe's GET /api/autobook "current"), shaped for the phone. */
function bookView(current) {
  const r = current && typeof current === 'object' ? current : null;
  if (!r || !r.id) return null;
  const alert = r.alert && typeof r.alert === 'object' ? r.alert : null;
  const choices = alert && Array.isArray(alert.choices) ? alert.choices : [];
  const phoneChoices = choices.filter((c) => c && PHONE_ACTIONS.includes(c.action)).map((c) => ({ action: c.action, label: clip(c.label || c.action, 60), confirm: NEEDS_CONFIRM.includes(c.action) }));
  const pcOnly = choices.some((c) => c && (c.action === 'edited' || c.action === 'edit'));
  const state = String(r.state || r.status || '');
  const done = num(r.steps_done);
  const total = num(r.steps_total);
  const live = !!r.alive && ['working', 'waiting', 'pausing', 'queued', 'running'].includes(state);
  let percent = num(r.percent);
  if (percent == null && done != null && total) percent = Math.round((100 * done) / total);
  return {
    id: String(r.id), projectId: r.project_id ? String(r.project_id) : null,
    title: clip(r.title || 'Your book', 120), state, stateWords: clip(r.state_words || state, 160),
    step: clip(r.step_label || (r.progress && r.progress.step_label) || r.phase || '', 160),
    done, total, percent: percent == null ? null : Math.max(0, Math.min(100, Math.round(percent))),
    leftS: num(r.left_s) != null ? r.left_s : (r.progress && num(r.progress.left_s)),
    finishAt: r.finish_at || (r.progress && r.progress.finish_at) || null,
    live, canPause: live && state !== 'pausing', canContinue: !live && ['paused', 'interrupted'].includes(state) && !phoneChoices.length,
    needsYou: !!r.needs_you,
    question: alert ? {
      key: clip(alert.key || '', 200), icon: clip(alert.icon || '🔔', 8), label: clip(alert.label || '', 60), what: clip(alert.what, 120),
      wrong: clip(alert.wrong, 300), why: clip(alert.why, 200), next: clip(alert.next, 320),
      change: alert.change ? clip(typeof alert.change === 'string' ? alert.change : JSON.stringify(alert.change), 600) : '',
      choices: phoneChoices, pcOnly,
    } : null,
    finished: ['done', 'cancelled'].includes(state),
  };
}

/** What the phone sends to Akọwe for an answer: { path, body } or { error }. */
function answerRequest(runId, action, confirmed) {
  if (!runId || !/^[\w.-]{1,80}$/.test(String(runId))) return { error: 'NO_RUN' };
  if (!PHONE_ACTIONS.includes(action)) return { error: 'NOT_ON_PHONE' };
  const base = `/api/autobook/${encodeURIComponent(runId)}`;
  if (action === 'resume') return { path: `${base}/resume`, body: {} };
  if (NEEDS_CONFIRM.includes(action) && confirmed !== true) return { error: 'CONFIRM_NEEDED' };
  return { path: `${base}/decide`, body: action === 'approve_anyway' ? { action, author_confirms: true } : { action } };
}

/** The chat: the AIs' replies (AutoInjector's transcript) and what you sent, oldest first. */
function chatView(replies, sent, limit = 60) {
  const a = (replies || []).filter((r) => r && SITES.includes(r.site)).map((r) => ({ id: `r${r.id}`, who: r.site, label: SITE_LABELS[r.site], text: clip(r.text, 8000), ts: Number(r.ts) || 0 }));
  const b = (sent || []).map((m) => ({ id: m.id, who: 'me', label: 'You', to: m.to, text: clip(m.text, 4000), ts: Number(m.ts) || 0 }));
  return a.concat(b).sort((x, y) => x.ts - y.ts).slice(-limit);
}

/** Who the AIs are and whether they can take a message. */
function aisView(participants) {
  return (participants || []).filter((p) => p && SITES.includes(p.id)).map((p) => ({
    id: p.id, label: SITE_LABELS[p.id], on: !!p.enabled, ready: !!p.ready, busy: !!p.generating,
    words: !p.enabled ? 'Off' : !p.ready ? 'Not ready' : p.generating ? 'Writing…' : 'Ready',
  }));
}

/** Who a phone message goes to: the ones you ticked that are on, or every AI that is on. */
function targets(to, ais) {
  const on = (ais || []).filter((a) => a.on).map((a) => a.id);
  const want = Array.isArray(to) ? to.filter((t) => SITES.includes(t)) : [];
  const picked = want.length ? want.filter((t) => on.includes(t)) : on;
  return [...new Set(picked)];
}

/** Alfred, for the phone: his last messages; a card he wants to run waits for the PC. */
function alfredView(st) {
  const s = st && typeof st === 'object' ? st : {};
  return {
    on: !!s.enabled, busy: !!s.busy,
    chat: (s.chat || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'alfred')).slice(-40)
      .map((m) => ({ who: m.role === 'user' ? 'me' : 'alfred', text: clip(m.text, 6000), ts: Number(m.ts) || 0 })),
    waitingOnPc: s.card ? clip(s.card.title || s.card.summary || 'Alfred wants to do something', 200) : '',
  };
}

/** A bounded list of alerts (desktop notices + the book's question + Alfred waiting), newest first. */
function createAlerts(max = 50) {
  const list = [];
  let seq = 0;
  return {
    add(a, now) {
      const key = String((a && a.key) || '');
      if (key && list.some((x) => x.key === key && !x.seen)) return null; // already waiting
      const item = { id: `a${now.toString(36)}${(++seq).toString(36)}`, key, kind: clip((a && a.kind) || 'note', 20), title: clip(a && a.title, 140), body: clip(a && a.body, 400), at: now, seen: false };
      list.unshift(item);
      if (list.length > max) list.length = max;
      return item;
    },
    seen(id) { let n = 0; for (const x of list) if (!x.seen && (id === 'all' || x.id === id)) { x.seen = true; n++; } return n; },
    view() { return list.slice(); },
    unseen() { return list.filter((x) => !x.seen).length; },
  };
}

/** A few bad keys in a row from one address → wait a minute (stops guessing). */
function createGuard({ limit = 10, windowMs = 60000 } = {}) {
  const bad = new Map();
  return {
    blocked(ip, now) { const b = bad.get(ip); return !!(b && b.n >= limit && now - b.at < windowMs); },
    fail(ip, now) { const b = bad.get(ip); if (!b || now - b.at >= windowMs) bad.set(ip, { n: 1, at: now }); else b.n++; },
    ok(ip) { bad.delete(ip); },
  };
}

module.exports = {
  SITES, SITE_LABELS, PHONE_ACTIONS, NEEDS_CONFIRM, DEFAULT_PORT,
  newToken, sameToken, lanAddresses, pairUrl, bookView, answerRequest, chatView, aisView, targets, alfredView, createAlerts, createGuard, clip,
};
