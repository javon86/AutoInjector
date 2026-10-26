'use strict';
/*
 * log-extract.js — P16: "⤓ Extract" with a scope, so a book's writing log can be
 * shared without the rest of the app's history (older, unrelated or private
 * conversations). PURE NODE (no Electron): main.js feeds it the transcript, the
 * activity log and the Relay Trace; it decides what goes in, writes a header
 * that says exactly what is in the file, and redacts secrets and private paths.
 *
 * Three scopes:
 *   book       "This Akọwe book only": only AI replies the Akọwe bridge
 *              owned for requests made while that book was Akọwe's current
 *              project, the activity events of those requests (by request_id /
 *              [MSG #] number) and other akowe-* events inside the book's run
 *              window(s), and the Relay Trace for those [MSG #] numbers.
 *   time       a from/to range (presets: last hour, today, last 24 h).
 *   everything the whole history (the dialog warns: includes all conversations,
 *              including older private ones, and asks a second time naming what is
 *              in it — everythingSummary(); main refuses it without that confirmation).
 *
 * The book tracker (createBookTracker) remembers, per Akọwe project
 * ({id, title} from POST /v1/status), which bridge request_ids happened while it
 * was current, when, on which AI, and their [MSG #] numbers. It holds NO prompt
 * or reply text and is persisted as a small JSON file next to the app state.
 */
const fs = require('fs');
const path = require('path');
const legacy = require('./akowe-legacy'); // logs written before the rename BookForge -> Akọwe hold "bookforge-*" events

const HOUR = 60 * 60 * 1000;
const RUN_GAP_MS = 30 * 60 * 1000;      // a pause longer than this starts a new run window
const WINDOW_SLACK_MS = 2 * 60 * 1000;  // events just around a window still belong to it
const UNKNOWN_PROJECT = '(unnamed)';
const SELFTEST_PREFIX = 'selftest-';
const PREVIEW_LINES = 40;

// --- the book tracker ---------------------------------------------------------
function createBookTracker(opts) {
  const o = opts || {};
  const file = o.file || null;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const maxProjects = o.maxProjects || 40;
  const maxRequests = o.maxRequestsPerProject || 4000;
  const saveDelayMs = o.saveDelayMs == null ? 400 : o.saveDelayMs;
  let data = { v: 1, current: null, projects: {} };
  let timer = null;

  const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

  function load() {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || !raw.projects || typeof raw.projects !== 'object') return;
      const projects = {};
      for (const [id, p] of Object.entries(raw.projects)) {
        if (!p || typeof p !== 'object') continue;
        const requests = {};
        for (const [rid, r] of Object.entries(p.requests || {})) {
          if (!r || typeof r !== 'object' || !Number.isFinite(r.at)) continue;
          requests[str(rid, 128)] = { site: str(r.site, 20) || null, at: r.at, lastAt: Number.isFinite(r.lastAt) ? r.lastAt : r.at, seqs: Array.isArray(r.seqs) ? r.seqs.map((s) => str(s, 12)).filter(Boolean).slice(0, 20) : [] };
        }
        projects[str(id, 100)] = { id: str(id, 100), title: str(p.title, 200) || null, firstAt: Number.isFinite(p.firstAt) ? p.firstAt : null, lastAt: Number.isFinite(p.lastAt) ? p.lastAt : null, requests };
      }
      const c = raw.current && typeof raw.current === 'object' && projects[str(raw.current.id, 100)] ? { id: str(raw.current.id, 100), title: str(raw.current.title, 200) || null, since: Number(raw.current.since) || null } : null;
      data = { v: 1, current: c, projects };
    } catch (_) { /* missing or unreadable: start empty */ }
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (_) { /* best effort */ }
  }
  function saveSoon() {
    if (!file) return;
    if (saveDelayMs <= 0) return flush();
    if (timer) return;
    timer = setTimeout(flush, saveDelayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function ensureProject(id, title) {
    let p = data.projects[id];
    if (!p) {
      p = data.projects[id] = { id, title: title || null, firstAt: null, lastAt: null, requests: {} };
      const ids = Object.keys(data.projects);
      if (ids.length > maxProjects) {
        // drop the project with the oldest activity (never the current one)
        const victims = ids.filter((x) => !data.current || x !== data.current.id)
          .sort((a, b) => (data.projects[a].lastAt || 0) - (data.projects[b].lastAt || 0));
        if (victims.length) delete data.projects[victims[0]];
      }
    }
    if (title) p.title = title;
    return p;
  }
  // Akọwe said which book it is working on (POST /v1/status -> project).
  function noteStatus(project, at) {
    if (!project || typeof project !== 'object') return;
    const id = str(project.id, 100);
    if (!id) return;
    const title = str(project.title, 200) || null;
    const t = Number.isFinite(at) ? at : now();
    const changed = !data.current || data.current.id !== id || (title && data.current.title !== title);
    ensureProject(id, title);
    if (!data.current || data.current.id !== id) data.current = { id, title, since: t };
    else if (title) data.current.title = title;
    if (changed) saveSoon();
  }
  function findRequest(rid) {
    for (const p of Object.values(data.projects)) if (p.requests[rid]) return { project: p, req: p.requests[rid] };
    return null;
  }
  // A bridge request started: it belongs to the book that is current right now.
  function noteRequest(rid, site, at) {
    rid = str(rid, 128);
    if (!rid || rid.startsWith(SELFTEST_PREFIX)) return null;
    const t = Number.isFinite(at) ? at : now();
    const found = findRequest(rid);
    if (found) { found.req.lastAt = Math.max(found.req.lastAt || 0, t); found.project.lastAt = Math.max(found.project.lastAt || 0, t); saveSoon(); return found.project.id; }
    const id = data.current ? data.current.id : UNKNOWN_PROJECT;
    const p = ensureProject(id, data.current ? data.current.title : null);
    p.requests[rid] = { site: str(site, 20) || null, at: t, lastAt: t, seqs: [] };
    if (p.firstAt == null || t < p.firstAt) p.firstAt = t;
    p.lastAt = Math.max(p.lastAt || 0, t);
    const rids = Object.keys(p.requests);
    if (rids.length > maxRequests) {
      rids.sort((a, b) => p.requests[a].at - p.requests[b].at);
      for (const x of rids.slice(0, rids.length - maxRequests)) delete p.requests[x];
    }
    saveSoon();
    return id;
  }
  // Any later event of that request (outcome, join, a late reply) extends its window.
  function noteActivity(rid, at) {
    rid = str(rid, 128);
    if (!rid || rid.startsWith(SELFTEST_PREFIX)) return;
    const found = findRequest(rid);
    if (!found) { noteRequest(rid, null, at); return; }
    const t = Number.isFinite(at) ? at : now();
    found.req.lastAt = Math.max(found.req.lastAt || 0, t);
    found.project.lastAt = Math.max(found.project.lastAt || 0, t);
    saveSoon();
  }
  // The [MSG #] number the request's prompt was typed as.
  function noteSeq(rid, seq) {
    rid = str(rid, 128);
    const s = str(seq, 12);
    if (!rid || !s) return;
    const found = findRequest(rid);
    if (!found) return;
    if (!found.req.seqs.includes(s)) { found.req.seqs.push(s); if (found.req.seqs.length > 20) found.req.seqs.shift(); saveSoon(); }
  }
  function requestBySeq(seq) {
    const s = str(seq, 12);
    if (!s) return null;
    let best = null;
    for (const p of Object.values(data.projects)) {
      for (const [rid, r] of Object.entries(p.requests)) {
        if (r.seqs.includes(s) && (!best || r.at > best.at)) best = { requestId: rid, projectId: p.id, at: r.at };
      }
    }
    return best;
  }
  function projectOfRequest(rid) { const f = findRequest(str(rid, 128)); return f ? f.project.id : null; }
  // A book's run windows: its requests clustered by time (a gap > RUN_GAP_MS starts a new one).
  function windows(id, gapMs) {
    const p = data.projects[id];
    if (!p) return [];
    const gap = gapMs || RUN_GAP_MS;
    const reqs = Object.values(p.requests).sort((a, b) => a.at - b.at);
    const out = [];
    for (const r of reqs) {
      const last = out[out.length - 1];
      if (last && r.at - last[1] <= gap) last[1] = Math.max(last[1], r.lastAt || r.at);
      else out.push([r.at, r.lastAt || r.at]);
    }
    return out;
  }
  function book(id) {
    const p = data.projects[id];
    if (!p) return null;
    const requestIds = new Set(Object.keys(p.requests));
    const seqs = new Set();
    for (const r of Object.values(p.requests)) for (const s of r.seqs) seqs.add(s);
    return { id: p.id, title: p.title || (p.id === UNKNOWN_PROJECT ? 'Akọwe book (no title reported)' : p.id), requestIds, seqs, windows: windows(id), firstAt: p.firstAt, lastAt: p.lastAt };
  }
  function books() {
    return Object.values(data.projects)
      .map((p) => ({ id: p.id, title: p.title || (p.id === UNKNOWN_PROJECT ? 'Akọwe book (no title reported)' : p.id), requests: Object.keys(p.requests).length, firstAt: p.firstAt, lastAt: p.lastAt, current: !!(data.current && data.current.id === p.id) }))
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  }
  function current() { return data.current ? Object.assign({}, data.current) : null; }
  function snapshot() { return JSON.parse(JSON.stringify(data)); }

  load();
  return { noteStatus, noteRequest, noteActivity, noteSeq, requestBySeq, projectOfRequest, windows, book, books, current, flush, snapshot, file };
}

// --- scope resolution --------------------------------------------------------
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function presetRange(preset, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  if (preset === 'hour') return { from: t - HOUR, to: t, label: 'the last hour' };
  if (preset === 'today') return { from: startOfDay(t), to: t, label: 'today' };
  if (preset === 'day') return { from: t - 24 * HOUR, to: t, label: 'the last 24 hours' };
  return null;
}
// The safe one-click default: the Akọwe book when one is known (Akọwe is
// connected, or the book was active in the last 24 h); otherwise the last 24 hours.
// Never "everything".
function defaultScope({ connected, books, now } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const list = Array.isArray(books) ? books.filter((b) => b && b.requests > 0) : [];
  const cur = list.find((b) => b.current) || list[0];
  if (cur && (connected || (cur.lastAt && t - cur.lastAt < 24 * HOUR))) return { scope: 'book', bookId: cur.id };
  return { scope: 'time', preset: 'day' };
}

function inWindows(ts, wins) {
  for (const [a, b] of wins) if (ts >= a - WINDOW_SLACK_MS && ts <= b + WINDOW_SLACK_MS) return true;
  return false;
}
function detailOf(e) { return e && e.detail && typeof e.detail === 'object' ? e.detail : null; }

// Picks what goes into the file. Returns { turns, events, seqs (Set|null), from, to }.
function selectEntries({ scope, from, to, book, transcript, log }) {
  const turns = Array.isArray(transcript) ? transcript : [];
  const events = Array.isArray(log) ? log : [];
  if (scope === 'everything') return { turns: turns.slice(), events: events.slice(), seqs: null, from: null, to: null };
  if (scope === 'time') {
    const a = Number(from), b = Number(to);
    const inR = (ts) => Number.isFinite(ts) && ts >= a && ts <= b;
    return { turns: turns.filter((t) => inR(t.ts)), events: events.filter((e) => inR(e.ts)), seqs: null, from: a, to: b };
  }
  // book
  if (!book) return { turns: [], events: [], seqs: new Set(), from: null, to: null };
  const wins = book.windows || [];
  const owned = (t) => !!(t && t.bf && (t.bf.projectId === book.id || (t.bf.requestId && book.requestIds.has(t.bf.requestId))));
  const evOk = (e) => {
    const d = detailOf(e);
    const rid = d && typeof d.request_id === 'string' ? d.request_id : null;
    if (rid) return book.requestIds.has(rid);
    if (d && d.seq != null && book.seqs.has(String(d.seq))) return true;
    return legacy.isAkoweEventKind(e.kind) && Number.isFinite(e.ts) && inWindows(e.ts, wins);
  };
  const first = wins.length ? wins[0][0] : null;
  const last = wins.length ? wins[wins.length - 1][1] : null;
  return { turns: turns.filter(owned), events: events.filter(evOk), seqs: new Set(book.seqs), from: first, to: last };
}

// --- redaction ------------------------------------------------------------------
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const KEYWORD_RE = /(?:api[_ -]?key|connection key|access[_ -]?key|secret|token|password|passwd|passphrase|authorization|bearer|pairing code|\bkey\b|\bcode\b)/i;

// Redacts (in this order): the exact known secrets the app holds (connection key,
// bridge tokens, pairing codes, API keys), well-known API-key shapes (sk-…, AIza…,
// ghp_…, xoxb-…, hf_…, AKIA…), Bearer values, values of key=/token=/code= in URLs,
// long hex/base64-like strings that follow a key/token/secret/password word, then
// paths: your home folder becomes ~, the app's own folders stay (as ~/…), and any
// other path under a home folder is replaced by [private path].
// Returns { text, count }.
function redact(input, opts) {
  const o = opts || {};
  let text = String(input == null ? '' : input);
  let count = 0;
  const sub = (re, fn) => { text = text.replace(re, (...a) => { count++; return typeof fn === 'function' ? fn(...a) : fn; }); };

  // 1. exact known secrets
  const secrets = Array.from(new Set((o.secrets || []).filter((s) => typeof s === 'string' && s.trim().length >= 6).map((s) => s.trim()))).sort((a, b) => b.length - a.length);
  for (const s of secrets) sub(new RegExp(escRe(s), 'g'), '[REDACTED secret]');
  // 2. API-key shapes
  sub(/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED key]');
  sub(/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED key]');
  sub(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED key]');
  sub(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED key]');
  sub(/\bhf_[A-Za-z0-9]{20,}/g, '[REDACTED key]');
  sub(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED key]');
  // 3. Bearer values and secret-looking URL parameters
  sub(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, b) => `${b} [REDACTED]`);
  sub(/([?&#](?:code|token|key|api_key|apikey|secret|password)=)[^&\s#"'<>]+/gi, (_m, p) => `${p}[REDACTED]`);
  // 4. "pairing code: Ab3dE…" / "key = 9f0c…" / "token": "…" — a long secret-looking value after a keyword
  sub(/((?:pairing code|connection key|api[_ -]?key|access[_ -]?key|secret|token|password|passwd|passphrase|\bkey\b|\bcode\b)["']?\s*(?:[:=]|\bis\b|\bwas\b)\s*["']?)([A-Za-z0-9_\-+/.=]{12,})/gi, (m, pre, val) => {
    if (!/[0-9]/.test(val) || !/[A-Za-z]/.test(val) || val.startsWith('[')) { count--; return m; }
    return `${pre}[REDACTED]`;
  });
  // 5. long hex / base64 strings within 40 characters after a keyword
  text = text.replace(/[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{32,}={0,2}/g, (m, offset, whole) => {
    if (!/[0-9]/.test(m) || !/[A-Za-z]/.test(m)) return m;
    const before = whole.slice(Math.max(0, offset - 40), offset);
    if (!KEYWORD_RE.test(before)) return m;
    count++;
    return '[REDACTED]';
  });

  // 6. paths
  const homes = [];
  if (o.home && String(o.home).length > 1) homes.push(String(o.home).replace(/[\\/]+$/, ''));
  const appDirs = (o.appDirs || []).filter((d) => typeof d === 'string' && d.length > 1).map((d) => d.replace(/[\\/]+$/, '')).sort((a, b) => b.length - a.length);
  const variants = (p) => { const v = [p]; if (p.includes('\\')) v.push(p.replace(/\\/g, '\\\\')); return v; };
  const tildeOf = (p) => {
    for (const h of homes) if (p.toLowerCase().startsWith(h.toLowerCase())) return '~' + p.slice(h.length);
    return p;
  };
  // protect the app's own folders (shown as ~/…) from the private-path pass
  const protectedVals = [];
  for (const d of appDirs) {
    for (const v of variants(d)) {
      text = text.replace(new RegExp(escRe(v), 'gi'), () => { protectedVals.push(tildeOf(v)); return `\u0000APP${protectedVals.length - 1}\u0000`; });
    }
  }
  for (const h of homes) for (const v of variants(h)) text = text.replace(new RegExp(escRe(v) + '(?![A-Za-z0-9_.-])', 'gi'), '~');
  // anything else under a home folder (this user's ~, or /home/x, /Users/x, C:\Users\x)
  const seg = "[^\\s\"'<>|`,;)\\]]*";
  const more = `(?: [^\\s"'<>|\`/\\\\]+(?:[/\\\\]${seg}|\\.[A-Za-z0-9]{1,5}\\b))*`;
  const pathRe = new RegExp(`(?:~(?=[/\\\\])|/home/[A-Za-z0-9._-]+|/Users/[A-Za-z0-9._ -]+?(?=[/\\\\])|/root(?=[/\\\\])|[A-Za-z]:(?:\\\\\\\\|\\\\)Users(?:\\\\\\\\|\\\\)[A-Za-z0-9._ -]+?(?=\\\\))(?:[/\\\\]${seg})?${more}`, 'g');
  text = text.replace(pathRe, (m) => {
    if (/^~[/\\]?$/.test(m)) return m;
    count++;
    return '[private path]';
  });
  text = text.replace(/\u0000APP(\d+)\u0000/g, (_m, i) => protectedVals[Number(i)] || '');
  return { text, count };
}

// --- text + file name ---------------------------------------------------------------
function fmtTs(ms) { try { return new Date(ms).toLocaleString(); } catch (_) { return String(ms); } }
function safeTitle(t) {
  const s = String(t == null ? '' : t).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\.{2,}/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80).trim();
  return s || 'Untitled book';
}
function stamp(d) {
  const x = d instanceof Date ? d : new Date(Number.isFinite(d) ? d : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}_${p(x.getHours())}-${p(x.getMinutes())}-${p(x.getSeconds())}`;
}
function scopeLabel(sel) {
  if (sel.scope === 'book') return `This Akọwe book only — "${sel.book ? sel.book.title : '?'}"`;
  if (sel.scope === 'time') return `Time range — ${sel.rangeLabel || `${fmtTs(sel.from)} to ${fmtTs(sel.to)}`}`;
  return 'Everything — includes all conversations, including older private ones';
}
function fileName(sel, now) {
  const st = stamp(now);
  if (sel.scope === 'book') return `${safeTitle(sel.book && sel.book.title)} - AutoInjector log - ${st}.txt`;
  if (sel.scope === 'time') {
    const p = sel.preset === 'hour' ? 'last hour' : sel.preset === 'today' ? 'today' : sel.preset === 'day' ? 'last 24 h' : 'time range';
    return `AutoInjector log - ${p} - ${st}.txt`;
  }
  return `AutoInjector log - everything - ${st}.txt`;
}

// The earliest timestamp among the chosen messages/events (null when none).
function oldestOf(turns, events) {
  let min = null;
  for (const list of [turns || [], events || []]) for (const x of list) { const t = x && Number(x.ts); if (Number.isFinite(t) && (min == null || t < min)) min = t; }
  return min;
}
function fmtDate(ms) { try { return new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }); } catch (_) { return String(ms); } }
// What "Everything" really contains, in words — the second confirmation names it:
// "1,204 messages going back to March 3, 2026, including older private conversations".
function everythingSummary({ transcript, log } = {}) {
  const turns = Array.isArray(transcript) ? transcript : [];
  const events = Array.isArray(log) ? log : [];
  const oldestAt = oldestOf(turns, events);
  const n = turns.length;
  const text = `${n.toLocaleString('en-US')} message${n === 1 ? '' : 's'}${oldestAt != null ? ` going back to ${fmtDate(oldestAt)}` : ''}, including older private conversations`;
  return { messages: n, events: events.length, oldestAt, text };
}

/*
 * buildExtract(params) -> { text, counts, fileName, redactions, preview }
 * params: { scope:'book'|'time'|'everything', preset?, from?, to?, book (from tracker.book()),
 *   transcript, log, include: { conversation, activity, relay },
 *   relayReport(filter) -> text   (main.js: Relay Trace formatted for { seqs, from, to }),
 *   siteLabel(site), buildLine, now, redaction: { secrets, home, appDirs } }
 */
function buildExtract(p) {
  const now = Number.isFinite(p.now) ? p.now : Date.now();
  const include = Object.assign({ conversation: true, activity: true, relay: true }, p.include || {});
  let scope = p.scope === 'book' || p.scope === 'everything' ? p.scope : 'time';
  let from = p.from, to = p.to, rangeLabel = null;
  if (scope === 'time') {
    const pr = presetRange(p.preset, now);
    if (pr) { from = pr.from; to = pr.to; rangeLabel = pr.label; }
    from = Number(from); to = Number(to);
    if (!Number.isFinite(from)) from = now - 24 * HOUR;
    if (!Number.isFinite(to)) to = now;
    if (to < from) { const x = from; from = to; to = x; }
    if (!rangeLabel) rangeLabel = `${fmtTs(from)} to ${fmtTs(to)}`;
  }
  const sel = selectEntries({ scope, from, to, book: p.book, transcript: p.transcript, log: p.log });
  const info = { scope, book: p.book || null, from: sel.from, to: sel.to, rangeLabel, preset: p.preset };
  const label = typeof p.siteLabel === 'function' ? p.siteLabel : (s) => s;

  let relayText = '';
  let relayCount = null;
  if (include.relay) {
    try {
      const r = typeof p.relayReport === 'function' ? p.relayReport({ seqs: sel.seqs, from: scope === 'everything' ? null : sel.from, to: scope === 'everything' ? null : sel.to }) : null;
      if (r && typeof r === 'object') { relayText = r.text || ''; relayCount = r.messages; } else relayText = String(r || '');
    } catch (e) { relayText = `(relay trace unavailable: ${e})`; }
  }

  const L = [];
  L.push(`AutoInjector — Extract (${scope === 'book' ? 'this Akọwe book only' : scope === 'time' ? 'time range' : 'EVERYTHING'})`);
  L.push(`Generated: ${fmtTs(now)}`);
  if (p.buildLine) L.push(String(p.buildLine));
  L.push('');
  L.push('WHAT IS IN THIS FILE (nothing else from the app\'s history is included)');
  L.push(`  Scope:            ${scopeLabel(info)}`);
  if (scope === 'book') {
    const wins = (p.book && p.book.windows) || [];
    L.push(`  Book:             "${p.book ? p.book.title : '?'}"${p.book && p.book.id ? ` (Akọwe project ${p.book.id})` : ''}`);
    L.push(`  Time range:       ${wins.length ? `${fmtTs(sel.from)} to ${fmtTs(sel.to)}` : '(no Akọwe requests recorded for this book)'}`);
    L.push(`  Run windows:      ${wins.length ? wins.map(([a, b]) => `${fmtTs(a)} – ${fmtTs(b)}`).join('; ') : 'none'}`);
    { const n = p.book ? p.book.requestIds.size : 0; L.push(`  Requests:         ${n} Akọwe request${n === 1 ? '' : 's'} for this book`); }
    L.push('  Included only:    the AIs\' replies to Akọwe\'s requests for this book, those requests\' activity events and Relay Trace lines, and Akọwe bridge events inside the run windows. Your own conversations with the AIs are NOT included.');
  } else if (scope === 'time') {
    L.push(`  Time range:       ${fmtTs(sel.from)} to ${fmtTs(sel.to)} (${rangeLabel})`);
  } else {
    L.push('  Time range:       all of the app\'s saved history');
    L.push('  WARNING:          this includes ALL conversations, including older private ones.');
  }
  L.push(`  AI conversation:  ${include.conversation ? `${sel.turns.length} message${sel.turns.length === 1 ? '' : 's'}` : 'not included'}`);
  L.push(`  Activity log:     ${include.activity ? `${sel.events.length} event${sel.events.length === 1 ? '' : 's'}` : 'not included'}`);
  L.push(`  Relay trace:      ${include.relay ? (relayCount != null ? `${relayCount} message${relayCount === 1 ? '' : 's'} traced` : 'included') : 'not included'}`);
  L.push('  Redaction:        connection keys, pairing codes, API keys and tokens are removed; your home folder is shown as ~; other private file paths are shown as [private path].');
  const headerEnd = L.length;
  L.push('');
  L.push('========================================');
  L.push('AI CONVERSATION (what the language models said)');
  L.push('========================================');
  if (!include.conversation) L.push('(not included in this extract)');
  else if (!sel.turns.length) L.push('(no messages in this scope)');
  else for (const t of sel.turns) {
    const who = t.label || (t.site ? label(t.site) : 'AI');
    const tags = [];
    if (t.bf && t.bf.requestId) tags.push(`Akọwe request ${t.bf.requestId}`);
    if (t.roundtableTag) tags.push(`TO:${t.roundtableTag}`);
    if (t.isRateLimited) tags.push('RATE-LIMITED');
    if (t.isVerdict) tags.push('VERDICT');
    L.push(`[${fmtTs(t.ts)}] ${who}${tags.length ? ' (' + tags.join(', ') + ')' : ''}:`);
    L.push(String(t.text == null ? '' : t.text));
    L.push('');
  }
  L.push('========================================');
  L.push('RELAY TRACE (where every message went — see TR-13)');
  L.push('========================================');
  L.push(include.relay ? (relayText || '(nothing traced in this scope)') : '(not included in this extract)');
  L.push('');
  L.push('========================================');
  L.push('ACTIVITY / TROUBLESHOOTING (errors and events)');
  L.push('========================================');
  if (!include.activity) L.push('(not included in this extract)');
  else if (!sel.events.length) L.push('(no activity in this scope)');
  else for (const e of sel.events) {
    let detail = '';
    try { detail = e.detail == null ? '' : (typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)); } catch (_) { detail = String(e.detail); }
    L.push(`[${fmtTs(e.ts)}] ${e.kind}${detail ? ' — ' + detail : ''}`);
  }
  L.push('');
  const r = redact(L.join('\n'), p.redaction || {});
  const lines = r.text.split('\n');
  const oldestAt = oldestOf(include.conversation ? sel.turns : [], include.activity ? sel.events : []);
  return {
    oldestAt,
    text: r.text,
    redactions: r.count,
    counts: { messages: include.conversation ? sel.turns.length : 0, events: include.activity ? sel.events.length : 0, relayMessages: include.relay ? relayCount : null },
    scope, from: sel.from, to: sel.to, rangeLabel,
    book: p.book ? { id: p.book.id, title: p.book.title } : null,
    fileName: fileName(info, now),
    header: lines.slice(0, headerEnd).join('\n'),
    preview: lines.slice(0, PREVIEW_LINES).join('\n') + (lines.length > PREVIEW_LINES ? `\n… (${lines.length - PREVIEW_LINES} more lines)` : '')
  };
}

module.exports = { createBookTracker, defaultScope, presetRange, selectEntries, redact, buildExtract, everythingSummary, fileName, safeTitle, stamp, RUN_GAP_MS, UNKNOWN_PROJECT, PREVIEW_LINES };
