'use strict';
// phone-main.js — 📱 the phone app, AutoInjector's main-process side: on / off, the pairing key and QR code, the
// phone server's answers (the AIs, the book, Alfred, alerts), and the 📱 Phone window's data.
//
// createPhone(deps) takes everything it touches, so test/phone.test.js runs it with fakes:
//   settingsFile          where { enabled, port, key } is kept (AutoInjector's own folder on this PC)
//   participants()        the AIs: [{ id, enabled, ready, generating }]
//   replies({limit})      the AIs' answers (the transcript)
//   sendTo(site, text)    send one AI a message           stopAll()  ⏹ stop the AIs
//   akowe(method, path, body) → { status, json }          Akọwe's own API (the book)
//   alfred(channel, payload)                               Alfred's controls (alfred:status, alfred:ask)
//   qr(text) → svg string · interfaces() · hostname() · log · now · fs

const path = require('path');
const core = require('./phone-core');
const { createPhoneServer } = require('./phone-server');

function createPhone(deps) {
  const fs = deps.fs || require('fs');
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});
  const alerts = core.createAlerts();
  const sent = [];
  let seq = 0;
  let settings = null;
  let bookCache = { at: 0, val: null };

  function load() {
    if (settings) return settings;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(deps.settingsFile, 'utf8')); } catch (_) { raw = null; }
    const port = Number(raw && raw.port);
    settings = {
      enabled: !!(raw && raw.enabled === true),
      port: Number.isInteger(deps.port) && deps.port > 0 ? deps.port : Number.isInteger(port) && port > 1023 && port < 65536 ? port : core.DEFAULT_PORT,
      key: raw && typeof raw.key === 'string' && raw.key.length >= 24 ? raw.key : core.newToken(),
    };
    if (!raw || raw.key !== settings.key) save();
    return settings;
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(deps.settingsFile), { recursive: true });
      fs.writeFileSync(deps.settingsFile, JSON.stringify(settings, null, 2));
    } catch (e) { log('phone-app', { step: 'save-failed', error: String(e.message || e).slice(0, 120) }); }
  }

  // ------------------------------------------------------------------ the book (Akọwe)
  async function current(force) {
    if (!force && bookCache.val !== undefined && now() - bookCache.at < 2000) return bookCache.val;
    let val = null;
    try {
      const r = await deps.akowe('GET', '/api/autobook');
      val = r && r.status === 200 && r.json ? (r.json.current || null) : undefined;
    } catch (_) { val = undefined; }
    bookCache = { at: now(), val };
    return val;
  }
  const NO_BOOK_APP = { ok: false, error: 'NO_BOOK_APP', words: 'The book app (Akọwe) isn\'t running on the PC.' };

  async function bookPause() {
    const c = await current(true);
    if (c === undefined) return NO_BOOK_APP;
    if (!c || !c.id) return { ok: false, error: 'NO_RUN', words: 'No book is being made right now.' };
    const r = await deps.akowe('POST', `/api/autobook/${encodeURIComponent(c.id)}/pause`, {});
    bookCache.at = 0;
    return r && r.status === 200 ? { ok: true, words: 'Pausing — it stops at a safe point.' } : { ok: false, error: 'AKOWE_REFUSED', words: akoweWords(r, 'It could not be paused.') };
  }

  async function bookAnswer(action, confirmed) {
    const c = await current(true);
    if (c === undefined) return NO_BOOK_APP;
    if (!c || !c.id) return { ok: false, error: 'NO_RUN', words: 'No book is being made right now.' };
    const view = core.bookView(c);
    const allowed = action === 'resume' ? (view.canContinue || (view.question && view.question.choices.some((x) => x.action === 'resume'))) : !!(view.question && view.question.choices.some((x) => x.action === action));
    if (!allowed) return { ok: false, error: 'NOT_NOW', words: 'That answer isn\'t on offer now — the book may have moved on.' };
    const req = core.answerRequest(c.id, action, confirmed);
    if (req.error === 'CONFIRM_NEEDED') return { ok: false, error: req.error, words: 'Please confirm that one.' };
    if (req.error) return { ok: false, error: req.error, words: 'That can\'t be done from the phone.' };
    const r = await deps.akowe('POST', req.path, req.body);
    bookCache.at = 0;
    if (!(r && r.status === 200)) return { ok: false, error: 'AKOWE_REFUSED', words: akoweWords(r, 'The book app said no.') };
    log('phone-app', { step: 'book-answer', action });
    return { ok: true, words: action === 'resume' ? 'Carrying on.' : 'Done — the book carries on.' };
  }
  function akoweWords(r, dflt) {
    const j = r && r.json;
    const m = j && (j.message || (j.error && (j.error.message || j.error)));
    return m && typeof m === 'string' ? core.clip(m, 200) : dflt;
  }

  async function chapters() {
    const c = await current(false);
    if (c === undefined) return NO_BOOK_APP;
    if (!c || !c.project_id) return { ok: true, chapters: [] };
    const r = await deps.akowe('GET', `/api/projects/${encodeURIComponent(c.project_id)}/branches/${encodeURIComponent(c.branch_id || 'main')}/chapters`);
    if (!(r && r.status === 200 && r.json)) return { ok: false, error: 'AKOWE_REFUSED', words: 'The chapters can\'t be read now.' };
    return { ok: true, title: core.clip(c.title, 120), chapters: (r.json.chapters || []).slice(0, 400).map((x) => ({ number: x.number, title: core.clip(x.title, 120), words: x.words || 0, approved: !!x.approved })) };
  }
  async function chapter(n) {
    const c = await current(false);
    if (c === undefined) return NO_BOOK_APP;
    if (!c || !c.project_id) return { ok: false, error: 'NO_RUN', words: 'No book.' };
    const r = await deps.akowe('GET', `/api/projects/${encodeURIComponent(c.project_id)}/branches/${encodeURIComponent(c.branch_id || 'main')}/chapters/${n}`);
    if (!(r && r.status === 200 && r.json)) return { ok: false, error: 'NOT_FOUND', words: `Chapter ${n} isn't written yet.` };
    const j = r.json;
    return { ok: true, number: j.number, title: core.clip(j.title, 120), text: String(j.text || '').slice(0, 400000), words: j.words || 0, of: j.of || null, approved: !!j.approved };
  }

  // ------------------------------------------------------------------ Alfred
  async function alfredStatus() {
    try { return await deps.alfred('alfred:status'); } catch (_) { return null; }
  }
  async function alfred() {
    const s = await alfredStatus();
    if (!s) return { ok: true, on: false, busy: false, chat: [], waitingOnPc: '' };
    return Object.assign({ ok: true }, core.alfredView(s));
  }
  async function alfredAsk(text) {
    const s = await alfredStatus();
    if (!s || !s.enabled) return { ok: false, error: 'ALFRED_OFF', words: 'Alfred is off. Turn him on with the 🎩 switch on the PC.' };
    if (s.busy || s.card) return { ok: false, error: 'BUSY', words: s.card ? 'Alfred is waiting for your OK on the PC first.' : 'Alfred is still busy with the last one.' };
    // He can take a while (a local model, tools): the answer shows when the app next looks.
    const p = Promise.resolve().then(() => deps.alfred('alfred:ask', { text })).catch(() => null);
    const quick = await Promise.race([p, new Promise((r) => setTimeout(() => r('__later'), 1500))]);
    log('phone-app', { step: 'alfred-ask', chars: text.length });
    if (quick && quick !== '__later' && quick.ok === false) return { ok: false, error: quick.error || 'ALFRED', words: core.clip(quick.message || 'Alfred could not take that.', 200) };
    return { ok: true, words: 'Alfred is on it.' };
  }

  // ------------------------------------------------------------------ the AIs
  function ais() { try { return core.aisView(deps.participants()); } catch (_) { return []; } }
  async function send({ text, to }) {
    const list = core.targets(to, ais());
    if (!list.length) return { ok: false, error: 'NO_AI', words: 'No AI is on to hear you. Turn one on on the PC.' };
    const results = {};
    for (const s of list) { try { results[s] = await deps.sendTo(s, text); } catch (e) { results[s] = { ok: false, error: String(e.message || e) }; } }
    const okSites = list.filter((s) => results[s] && results[s].ok !== false);
    sent.push({ id: `m${now().toString(36)}${(++seq).toString(36)}`, to: list, text: String(text).slice(0, 4000), ts: now() });
    if (sent.length > 100) sent.splice(0, sent.length - 100);
    log('phone-app', { step: 'send', to: list, ok: okSites.length });
    return okSites.length ? { ok: true, words: `Sent to ${okSites.map((s) => core.SITE_LABELS[s]).join(', ')}.` } : { ok: false, error: 'SEND_FAILED', words: 'It could not be sent — check the AIs on the PC.' };
  }
  function chat() {
    let replies = [];
    try { replies = deps.replies({ limit: 60 }) || []; } catch (_) { replies = []; }
    return { ok: true, messages: core.chatView(replies, sent) };
  }
  async function stop() {
    try { await deps.stopAll(); } catch (_) { return { ok: false, error: 'STOP_FAILED', words: 'Could not stop them.' }; }
    log('phone-app', { step: 'stop' });
    return { ok: true, words: 'Stopped — the AIs won\'t pass messages on until you send again.' };
  }

  // ------------------------------------------------------------------ alerts + the state the app polls
  function notice(n) {
    if (!n) return;
    alerts.add({ key: n.key ? `n:${n.key}` : '', kind: n.target === 'akowe' ? 'book' : 'note', title: n.title || 'AutoInjector', body: n.body || '' }, now());
  }
  async function state() {
    const c = await current(false);
    const book = c === undefined ? null : core.bookView(c);
    if (book && book.question) alerts.add({ key: `book:${book.question.key || book.id}`, kind: 'book', title: `📖 ${book.question.label || 'The book needs you'}`, body: book.question.wrong || book.question.what }, now());
    const al = await alfred();
    if (al.waitingOnPc) alerts.add({ key: `alfred:${al.waitingOnPc}`, kind: 'alfred', title: '🎩 Alfred is waiting for your OK on the PC', body: al.waitingOnPc }, now());
    return {
      ok: true, pc: core.clip(deps.hostname ? deps.hostname() : 'Your PC', 60), ais: ais(), book, bookApp: c !== undefined,
      alfred: { on: al.on, busy: al.busy, waitingOnPc: al.waitingOnPc }, alerts: alerts.view(),
    };
  }
  function alertsSeen(id) { const n = alerts.seen(id === 'all' ? 'all' : id); return { ok: true, marked: n }; }

  // ------------------------------------------------------------------ the server, on / off
  const server = createPhoneServer({
    now, log, token: () => load().key, files: deps.files || {},
    state, chat, send, stop, bookPause, bookAnswer, chapters, chapter, alfred, alfredAsk, alertsSeen,
  });

  async function startServer() {
    const s = load();
    const r = await server.start({ port: s.port, host: deps.host || '0.0.0.0' });
    if (!r.ok) log('phone-app', { step: 'start-failed', error: r.error });
    return r;
  }

  async function setEnabled(on) {
    const s = load();
    s.enabled = !!on;
    save();
    if (s.enabled) {
      const r = await startServer();
      if (!r.ok) { s.enabled = false; save(); return Object.assign(await status(), { ok: false, error: r.error, words: r.words }); }
    } else await server.stop();
    log('phone-app', { step: s.enabled ? 'on' : 'off' });
    return Object.assign(await status(), { ok: true });
  }

  async function newKey() {
    const s = load();
    s.key = core.newToken();
    save();
    server.forgetPhones();
    log('phone-app', { step: 'new-key' });
    return Object.assign(await status(), { ok: true, words: 'Every phone is un-paired. Scan the new code to pair again.' });
  }

  async function status() {
    const s = load();
    const info = server.info();
    const addrs = core.lanAddresses(deps.interfaces ? deps.interfaces() : {});
    const port = info ? info.port : s.port;
    const links = addrs.map((a) => ({ name: a.name, address: a.address, url: core.pairUrl(a.address, port, s.key) }));
    let qr = '';
    if (s.enabled && info && links[0] && deps.qr) { try { qr = await deps.qr(links[0].url); } catch (e) { log('phone-app', { step: 'qr-failed', error: String(e.message || e).slice(0, 120) }); } }
    return {
      enabled: s.enabled, running: server.running(), port, links, qr,
      phones: server.phones().map((p) => ({ ip: p.ip, phone: phoneName(p.agent), lastSeen: p.lastSeen })),
      noWifi: !addrs.length,
    };
  }
  function phoneName(ua) {
    const u = String(ua || '');
    if (/iPhone/i.test(u)) return 'iPhone';
    if (/iPad/i.test(u)) return 'iPad';
    const m = /Android[^;)]*;\s*([^;)]+?)(?:\sBuild|\))/i.exec(u);
    if (m) return core.clip(m[1].trim(), 40) || 'Android phone';
    if (/Android/i.test(u)) return 'Android phone';
    return 'A browser';
  }

  async function startup() { const s = load(); if (s.enabled) await startServer(); }

  return { load, status, setEnabled, newKey, startup, notice, state, chat, send, stop, bookPause, bookAnswer, chapters, chapter, alfred, alfredAsk, alertsSeen, server, phoneName, stopServer: () => server.stop() };
}

module.exports = { createPhone };
