'use strict';
/*
 * run-guard.js — looks after a long book run (or a video / picture job) while it works for hours:
 *
 *   1. KEEP THE PC AWAKE. Windows goes to sleep after 15–30 minutes without you touching it, and a 20–50 hour book
 *      run then dies mid-answer. While something is working, Electron's powerSaveBlocker
 *      ('prevent-app-suspension') stops the PC from sleeping (the screen may still turn off). It is released two
 *      minutes after everything is idle again.
 *   2. CLOSING THE WINDOW. Closing used to quit everything with no question. While something is working, the app now
 *      asks: keep it running in the background (a small icon by the clock opens it again), stop it and quit, or
 *      cancel.
 *   3. TELL YOU WHEN A RUN NEEDS YOU. A Windows notification, the taskbar button flashing until you come back, and a
 *      sound if you want one — when the book run pauses or needs your decision, when an AI's window is broken or
 *      needs you, or when every AI has hit its usage limit. Once per event; again after 30 minutes if it is still
 *      waiting.
 *
 * Electron-free: main.js passes powerSaveBlocker, a show(notification) function and a flash(on) function. Pure
 * logic, unit-tested in test/run-guard.test.js.
 */
const zlib = require('zlib');

const LIVE_RUN = new Set(['writing', 'waiting', 'pausing']);
const RUN_NEEDS_YOU = { needs_you: 'needs your decision', paused: 'is paused', problem: 'stopped because of a problem' };

/** What is working right now, from what main.js knows. -> { busy, run, inFlight, media: [..], why: [plain words] } */
function activityOf(a = {}) {
  const run = a.run && typeof a.run === 'object' ? a.run : null;
  const runLive = !!(run && !run.stale && (run.live || LIVE_RUN.has(run.state)));
  const inFlight = Math.max(0, Number(a.inFlight) || 0);
  const media = (Array.isArray(a.media) ? a.media : []).filter(Boolean);
  // files an AI is giving you (ai-downloads.js busyWhy(): "a download is still coming in (Claude: report.zip)")
  const downloads = (Array.isArray(a.downloads) ? a.downloads : []).filter(Boolean);
  const why = [];
  if (runLive) why.push('a book is being written');
  else if (inFlight) why.push('Akọwe is waiting for an AI answer');
  for (const m of media) why.push(m);
  for (const d of downloads) why.push(d);
  return { busy: runLive || inFlight > 0 || media.length > 0 || downloads.length > 0, runLive, inFlight, media, downloads, why };
}

/**
 * The keep-awake lock. update(activity) after each look (every ~15 s).
 *   blocker: Electron's powerSaveBlocker ({ start(type) -> id, stop(id), isStarted(id) }) or null (tests / no Electron)
 */
function createWakeLock(opts = {}) {
  const blocker = opts.blocker && typeof opts.blocker.start === 'function' ? opts.blocker : null;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const idleGraceMs = Number(opts.idleGraceMs) >= 0 ? Number(opts.idleGraceMs) : 120000;
  let id = null;
  let lastBusyAt = 0;
  let last = activityOf({});
  let lastSaid = '';
  function update(activity) {
    const a = activity && typeof activity.busy === 'boolean' ? activity : activityOf(activity);
    last = a;
    if (a.busy) {
      lastBusyAt = now();
      if (id == null && blocker) {
        try { id = blocker.start('prevent-app-suspension'); } catch (e) { id = null; log('keep-awake', { on: false, error: String(e && e.message || e), severity: 'warn' }); }
        if (id != null) { lastSaid = a.why[0] || ''; log('keep-awake', { on: true, why: a.why.join(', '), say: `Keeping the PC awake while ${a.why[0] || 'something works'} (the screen may still turn off)` }); }
      } else if (id != null && (a.why[0] || '') !== lastSaid) {
        // still awake, but for a different main reason (e.g. a picture job ended and a book run goes on): say so once
        lastSaid = a.why[0] || '';
        log('keep-awake', { on: true, still: true, why: a.why.join(', '), say: `Keeping the PC awake while ${a.why[0] || 'something works'} (the screen may still turn off)` });
      }
    } else if (id != null && now() - lastBusyAt >= idleGraceMs) {
      try { blocker.stop(id); } catch (_) {}
      id = null;
      lastSaid = '';
      log('keep-awake', { on: false, say: 'Nothing is working any more: the PC may sleep again as usual' });
    }
    return { busy: a.busy, awake: id != null, why: a.why.slice() };
  }
  function release() { if (id != null && blocker) { try { blocker.stop(id); } catch (_) {} } id = null; }
  return { update, release, awake: () => id != null, busy: () => !!last.busy, activity: () => Object.assign({}, last, { why: last.why.slice() }) };
}

/** The question asked when the window is closed while something works (null = nothing works: just close). */
function closeQuestion(activity) {
  const a = activity || {};
  if (!a.busy) return null;
  const dl = Array.isArray(a.downloads) ? a.downloads.filter(Boolean) : [];
  const others = (a.why || []).filter((w) => !dl.includes(w));
  let what = a.runLive ? 'A book is being written.' : a.inFlight ? 'Akọwe is waiting for an AI to answer.'
    : others.length ? `Something is still working (${others.join(', ')}).` : dl.length ? '' : `Something is still working (${(a.why || []).join(', ') || 'a job'}).`;
  // a file an AI is giving you: quitting now would throw the unfinished download away
  if (dl.length) what = `${what ? `${what} ` : ''}${dl.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join('. ')}.`;
  return {
    type: 'question',
    title: 'Keep it running?',
    message: `${what} Keep it running in the background, or stop it?`,
    detail: 'Keep running: the window hides and the work carries on. Click the AutoInjector icon by the clock (bottom right of the screen) to open it again. Your PC is kept awake while it works.\n\nStop and quit: everything stops now. A book run can be carried on later with ▶ Resume.' + (dl.length ? ' A download that has not finished is lost (click it in the AI\'s pane again later).' : ''),
    buttons: ['Keep running in the background', 'Stop it and quit', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  };
}
function closeChoice(response) { return response === 0 ? 'background' : response === 1 ? 'quit' : 'cancel'; }

// 🔔 Notification text limits (Windows shows about two lines of title and four of body; macOS cuts longer text).
const TITLE_MAX = 96;
const BODY_MAX = 200;
function clipText(t, n) {
  const x = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  if (x.length <= n) return x;
  const cut = x.slice(0, n - 1); const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`;
}
function shortHash(s) { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(36); }
/**
 * 🔔 A book run that waits for the user, from Akọwe's alert (category, what, wrong, why): the notification title
 * "📖 <book>: 🧑 Character issue (step 3 of 19)" and a short body "what: what is wrong. why it stopped" — both
 * within TITLE_MAX / BODY_MAX. -> { title, body } or null (no alert: the older words are used).
 */
function alertNotice(run) {
  const a = run && run.alert;
  if (!a || !a.label) return null;
  const step = run.total && run.at ? ` (step ${run.at} of ${run.total})` : '';
  const head = `${a.icon ? `${a.icon} ` : ''}${a.label}${step}`;
  const room = Math.max(12, TITLE_MAX - head.length - 6); // "📖 " and ": " (the emoji is two code units)
  const book = clipText(run.title || 'Your book', room);
  const title = clipText(`📖 ${book}: ${head}`, TITLE_MAX);
  const why = clipText(a.why || '', 90);
  const what = clipText(a.what || '', 60);
  const roomWrong = Math.max(30, BODY_MAX - why.length - what.length - 3);
  const wrong = clipText(a.wrong || '', roomWrong);
  const body = clipText([what && wrong ? `${what}: ${wrong}` : what || wrong, why].filter(Boolean).join(' '), BODY_MAX);
  return { title, body };
}

/**
 * What needs the user right now. -> [{ key, title, body, target: 'akowe' | 'pane', site?, category? }]
 *   run:   the run summary (akowe-run.js summarizeRun shape) or null
 *   sites: { site: { label, active, health: { state, problem } } }
 *   watching: a book run is going (or Akọwe used the AIs recently) — pane problems only count then
 */
function conditionsFrom({ run, sites, watching } = {}) {
  const out = [];
  if (run && !run.stale && RUN_NEEDS_YOU[run.state]) {
    const title = run.state === 'needs_you' ? 'Your book needs you' : run.state === 'problem' ? 'Your book run stopped' : 'Your book run is paused';
    const name = run.title ? `“${String(run.title).slice(0, 80)}”` : 'The book';
    const step = run.total && run.at ? ` (step ${run.at} of ${run.total})` : '';
    const what = run.state === 'needs_you' ? 'Open Akọwe to decide, then it carries on.' : 'Open Akọwe and press ▶ Resume when you are ready.';
    const al = alertNotice(run);
    const key = `run:${run.id || '?'}:${run.state}${al && run.alert.key ? `:${shortHash(run.alert.key)}` : ''}`;
    if (al) out.push({ key, title: al.title, body: al.body, target: 'akowe', category: run.alert.category || '', code: run.alert.code || '' });
    else out.push({ key, title, body: `${name} ${RUN_NEEDS_YOU[run.state]}${step}. ${what}`, target: 'akowe' });
  }
  // 🧑‍⚖️ a stand-in decided for the user (they did not answer in time): said once, with how to undo it
  if (run && !run.stale && run.notice && run.notice.key) {
    out.push({ key: `decided:${run.id || '?'}:${shortHash(run.notice.key)}`, title: clipText(run.notice.title, TITLE_MAX), body: clipText(run.notice.body, BODY_MAX), target: 'akowe', category: 'decided', code: 'STAND_IN_DECIDED' });
  }
  const runGoing = !!(run && !run.stale && (LIVE_RUN.has(run.state) || RUN_NEEDS_YOU[run.state]));
  if (!(watching || runGoing)) return out;
  const list = Object.entries(sites || {}).filter(([, x]) => x && x.active);
  const limited = list.filter(([, x]) => x.health && x.health.problem === 'USAGE_LIMIT');
  if (list.length && limited.length === list.length) {
    const names = list.map(([, x]) => x.label).join(', ');
    out.push({ key: 'all-limited', title: 'Every AI has hit its usage limit', body: `${names} all say you have reached the usage limit. The book waits until a limit resets — or switch an AI to another account.`, target: 'pane' });
  } else {
    for (const [s, x] of list) {
      const st = x.health && x.health.state;
      if (st !== 'broken' && st !== 'needs_user') continue;
      const why = x.health.problem === 'LOGGED_OUT' ? 'is logged out' : x.health.problem === 'CAPTCHA' ? 'shows an “are you a human?” check' : x.health.problem === 'USAGE_LIMIT' ? 'has hit its usage limit' : 'has stopped working and AutoInjector could not fix it';
      out.push({ key: `pane:${s}:${st}:${x.health.problem || ''}`, title: `${x.label} needs you`, body: `${x.label} ${why}. Open AutoInjector and look at ${x.label}'s pane.`, target: 'pane', site: s });
    }
  }
  return out;
}

/**
 * Says each condition ONCE (a notification + the taskbar flashing), and again after renotifyMs (30 min) if it is
 * still there. A condition that goes away is forgotten (it is said again if it comes back).
 *   show({ key, title, body, target, site, silent }) / flash(on) / getSettings() -> { on, sound }
 */
function createNotifier(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const show = typeof opts.show === 'function' ? opts.show : () => {};
  const flash = typeof opts.flash === 'function' ? opts.flash : () => {};
  const getSettings = typeof opts.getSettings === 'function' ? opts.getSettings : () => ({ on: true, sound: true });
  const renotifyMs = Number(opts.renotifyMs) > 0 ? Number(opts.renotifyMs) : 30 * 60000;
  const told = new Map(); // key -> when it was last said
  let flashing = false;
  function update(conditions) {
    const list = Array.isArray(conditions) ? conditions.filter((c) => c && c.key) : [];
    const keys = new Set(list.map((c) => c.key));
    for (const k of Array.from(told.keys())) if (!keys.has(k)) told.delete(k);
    const set = getSettings() || {};
    const said = [];
    if (set.on === false) return said;
    for (const c of list) {
      const at = told.get(c.key);
      if (at != null && now() - at < renotifyMs) continue;
      told.set(c.key, now());
      try { show(Object.assign({}, c, { silent: set.sound === false, again: at != null })); } catch (_) {}
      said.push(c.key);
    }
    if (said.length && !flashing) { flashing = true; try { flash(true); } catch (_) {} }
    return said;
  }
  /** The user came back to the window: stop flashing (the conditions stay remembered — no repeat for 30 min). */
  function seen() { if (flashing) { flashing = false; try { flash(false); } catch (_) {} } }
  return { update, seen, told: () => Array.from(told.keys()), flashing: () => flashing };
}

// ---- a small icon for the tray and notifications, drawn here (the app ships no image files) ----
function crc32(buf) {
  let c; const table = crc32.t || (crc32.t = Array.from({ length: 256 }, (_, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A size×size PNG: a rounded blue square with an open white book. */
function makeIconPng(size = 32) {
  const n = Math.max(16, Math.min(256, Math.round(size)));
  const raw = Buffer.alloc((n * 4 + 1) * n);
  const r = n * 0.22;
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0;
    for (let x = 0; x < n; x++) {
      const o = y * (n * 4 + 1) + 1 + x * 4;
      const cx = Math.max(r - x, 0, x - (n - 1 - r)); const cy = Math.max(r - y, 0, y - (n - 1 - r));
      const inside = cx * cx + cy * cy <= r * r;
      if (!inside) { raw[o + 3] = 0; continue; }
      // the book: two white pages from 22% to 78% across, 28% to 74% down, with a blue spine in the middle
      const u = x / n; const v = y / n;
      const page = u > 0.2 && u < 0.8 && v > 0.28 && v < 0.74 + Math.abs(u - 0.5) * 0.12 && Math.abs(u - 0.5) > 0.03;
      const [R, G, B] = page ? [255, 255, 255] : [37, 99, 235];
      raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

module.exports = { activityOf, createWakeLock, closeQuestion, closeChoice, conditionsFrom, alertNotice, createNotifier, makeIconPng, LIVE_RUN, TITLE_MAX, BODY_MAX };
