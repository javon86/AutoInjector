'use strict';
// phone-pc.js — 📱🖥 the whole AutoInjector control panel on the phone (a remote control for everything).
//
// The phone loads the PC's own control panel page (controls.html and its scripts, unchanged). Instead of Electron's
// preload bridge, a small shim gives the page the SAME `window.api` by running the PC's own preload.js with a
// stand-in `require("electron")`:
//   ipcRenderer.invoke(channel, …args) → POST /api/ipc {channel, args}  → the PC runs the same handler the panel uses
//   ipcRenderer.on(channel, fn)         ← GET /api/ipc/events?since=…   (long-poll; the PC's live updates)
// So every button the Windows panel has works on the phone, and nothing new can be done: only the channels the
// panel's own preload.js uses are accepted (channelsOf).
//
// Pure helpers (no Electron), tested by test/phone-pc.test.js:
//   channelsOf(preloadSource)        → { invoke: Set, on: Set }
//   createEventQueue({max, now})     → { push(channel, payload), since(n), wait(n, ms) }
//   pcPage(controlsHtml)             → the panel page for the phone (viewport, shim, phone bar)
//   shimSource()                     → the shim's JavaScript
//   jsonSafe(value)                  → a JSON-safe copy (no functions, cycles, huge strings)

const MAX_EVENTS = 400;
const MAX_WAIT_MS = 25000;
const MAX_STRING = 2 * 1024 * 1024;

function channelsOf(src) {
  const s = String(src || '');
  const invoke = new Set();
  const on = new Set();
  for (const m of s.matchAll(/ipcRenderer\.invoke\(\s*["'`]([A-Za-z0-9:_.\-]{1,80})["'`]/g)) invoke.add(m[1]);
  for (const m of s.matchAll(/ipcRenderer\.on\(\s*["'`]([A-Za-z0-9:_.\-]{1,80})["'`]/g)) on.add(m[1]);
  return { invoke, on };
}

function createEventQueue(opts) {
  const o = opts || {};
  const max = o.max || MAX_EVENTS;
  const now = o.now || (() => Date.now());
  const list = [];
  let seq = 0;
  const waiters = new Set();
  function push(channel, payload) {
    seq += 1;
    list.push({ seq, channel: String(channel), payload: jsonSafe(payload), at: now() });
    if (list.length > max) list.splice(0, list.length - max);
    for (const w of [...waiters]) w();
    return seq;
  }
  function since(n) {
    const k = Number(n) || 0;
    const first = list.length ? list[0].seq : seq + 1;
    // fell behind (more than `max` events since its last look): it must reload the panel's state
    const gap = k > 0 && k < first - 1;
    return { seq, gap, events: list.filter((e) => e.seq > k) };
  }
  function wait(n, ms) {
    const r = since(n);
    if (r.events.length || r.gap) return Promise.resolve(r);
    const t = Math.max(0, Math.min(MAX_WAIT_MS, Number(ms) || 0));
    if (!t) return Promise.resolve(r);
    return new Promise((resolve) => {
      let timer = null;
      const done = () => { waiters.delete(done); clearTimeout(timer); resolve(since(n)); };
      waiters.add(done);
      timer = setTimeout(done, t);
    });
  }
  return { push, since, wait, size: () => list.length, waiting: () => waiters.size, last: () => seq };
}

/** A JSON-safe copy: functions dropped, cycles cut, Buffers as {type:'Buffer', bytes}, very long text clipped. */
function jsonSafe(v, seen = new WeakSet(), depth = 0) {
  if (v == null || typeof v === 'boolean' || typeof v === 'number') return Number.isFinite(v) || typeof v !== 'number' ? v : null;
  if (typeof v === 'string') return v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'function' || typeof v === 'symbol') return undefined;
  if (depth > 40) return null;
  if (Buffer.isBuffer(v)) return { type: 'Buffer', bytes: v.length };
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Error) return { message: String(v.message || v) };
  if (typeof v === 'object') {
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => { const y = jsonSafe(x, seen, depth + 1); return y === undefined ? null : y; });
    if (v instanceof Map) return jsonSafe(Object.fromEntries(v), seen, depth + 1);
    if (v instanceof Set) return jsonSafe([...v], seen, depth + 1);
    const out = {};
    for (const k of Object.keys(v)) { const y = jsonSafe(v[k], seen, depth + 1); if (y !== undefined) out[k] = y; }
    return out;
  }
  return null;
}

/** The shim: the page's `require("electron")` before the PC's own preload.js runs. */
function shimSource() {
  return `'use strict';
// 📱🖥 AutoInjector's control panel on the phone: the PC's own preload.js runs with this stand-in for Electron.
(function () {
  var key = '';
  var m = /(?:^#|[&#])k=([^&]+)/.exec(location.hash || '');
  if (m) { key = decodeURIComponent(m[1]); try { localStorage.setItem('autoinjector.phone.key', key); } catch (_) {} history.replaceState(null, '', location.pathname + location.search); }
  if (!key) { try { key = localStorage.getItem('autoinjector.phone.key') || ''; } catch (_) {} } // the phone app's own key (same address)
  var handlers = {};
  var since = 0;
  var bar = null;
  function say(t, bad) { try { if (!bar) return; var s = bar.querySelector('.st'); s.textContent = t; s.className = 'st' + (bad ? ' bad' : ''); } catch (_) {} }
  function post(channel, args) {
    return fetch('/api/ipc', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: channel, args: args }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, words: 'The PC sent an odd answer.' }; }).then(function (j) { if (r.status === 401) { say('Not paired — open this from the phone app', true); } return j; }); })
      .then(function (j) { if (!j || j.ok === false) { var e = new Error((j && (j.words || j.error)) || 'The PC said no.'); e.code = j && j.error; throw e; } return j.value; });
  }
  var ipcRenderer = {
    invoke: function (channel) { return post(channel, Array.prototype.slice.call(arguments, 1)); },
    send: function (channel) { post(channel, Array.prototype.slice.call(arguments, 1)).catch(function () {}); },
    on: function (channel, fn) { (handlers[channel] = handlers[channel] || []).push(fn); return ipcRenderer; },
    once: function (channel, fn) { var w = function () { ipcRenderer.removeListener(channel, w); fn.apply(null, arguments); }; return ipcRenderer.on(channel, w); },
    removeListener: function (channel, fn) { handlers[channel] = (handlers[channel] || []).filter(function (x) { return x !== fn; }); return ipcRenderer; },
    removeAllListeners: function (channel) { delete handlers[channel]; return ipcRenderer; },
  };
  window.__aiPhone = { key: function () { return key; }, ipcRenderer: ipcRenderer };
  window.require = function (name) {
    if (name === 'electron') return { contextBridge: { exposeInMainWorld: function (n, api) { window[n] = api; } }, ipcRenderer: ipcRenderer, webUtils: { getPathForFile: function () { return ''; } } };
    throw new Error('Not on the phone: ' + name);
  };
  var fails = 0;
  function poll() {
    fetch('/api/ipc/events?since=' + since + '&wait=25000', { headers: { 'Authorization': 'Bearer ' + key }, cache: 'no-store' })
      .then(function (r) { if (r.status === 401) { throw Object.assign(new Error('not paired'), { unpaired: true }); } return r.json(); })
      .then(function (j) {
        fails = 0;
        say('🟢 Connected to the PC');
        if (j && j.gap) { location.reload(); return; }
        (j && j.events || []).forEach(function (ev) {
          since = Math.max(since, ev.seq);
          (handlers[ev.channel] || []).slice().forEach(function (fn) { try { fn({ sender: null }, ev.payload); } catch (e) { console.error(e); } });
        });
        if (j && typeof j.seq === 'number' && since === 0) since = j.seq;
        setTimeout(poll, 50);
      })
      .catch(function (e) { fails += 1; say(e && e.unpaired ? 'Not paired — open this from the phone app' : '🔴 Can\\'t reach the PC — trying again', true); setTimeout(poll, e && e.unpaired ? 15000 : Math.min(15000, 1000 * fails)); });
  }
  // 📖 Akọwe: on the PC that tab shows Akọwe's window inside AutoInjector; on the phone it opens the book app itself
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('#tab-app-akowe');
    if (!t) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    say('Opening the book app…');
    fetch('/api/akowe/link', { headers: { 'Authorization': 'Bearer ' + key }, cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok && j.url) location.href = j.url; else say((j && j.words) || 'The book app can’t be opened now.', true); })
      .catch(function () { say('🔴 Can’t reach the PC', true); });
  }, true);
  document.addEventListener('DOMContentLoaded', function () {
    bar = document.createElement('div');
    bar.id = 'ai-phone-bar';
    bar.innerHTML = '<a href="/" class="back">⬅ Phone app</a><span class="st">Connecting…</span>';
    document.body.insertBefore(bar, document.body.firstChild);
    // the first look tells the current seq (older events are not replayed: the panel reads the state itself)
    fetch('/api/ipc/events?since=0&wait=0', { headers: { 'Authorization': 'Bearer ' + key }, cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { since = (j && j.seq) || 0; poll(); }).catch(function () { poll(); });
  });
})();
`;
}

const PHONE_CSS = `
#ai-phone-bar{position:sticky;top:0;z-index:2147483000;display:flex;gap:10px;align-items:center;padding:8px 12px;background:#1f2a24;color:#fff;font:14px system-ui,sans-serif}
#ai-phone-bar a.back{color:#fff;text-decoration:none;font-weight:600;padding:6px 10px;border:1px solid #fff6;border-radius:8px}
#ai-phone-bar .st{margin-left:auto;font-size:12px}#ai-phone-bar .st.bad{color:#ffb4a8}
@media (max-width: 760px){html,body{max-width:100vw;overflow-x:hidden}body{font-size:15px}
#window-titlebar{flex-wrap:wrap;height:auto!important;row-gap:6px}#window-titlebar .wt-name{display:none}
#app-tabs{display:flex;flex-wrap:nowrap;overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch;scrollbar-width:none}
#app-tabs .app-tab{flex:0 0 auto}
button,select,input[type=button]{min-height:40px}input,textarea,select{font-size:16px!important}
img,video,canvas,table{max-width:100%}}`;

/** The control panel page for the phone: a mobile viewport, the shim and the PC's preload.js before its scripts. */
function pcPage(html) {
  let s = String(html || '');
  const head = `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><base href="/pc/">`
    + `<style>${PHONE_CSS}</style>`;
  s = /<head[^>]*>/i.test(s) ? s.replace(/<head[^>]*>/i, (h) => `${h}${head}`) : head + s;
  const boot = '<script src="/pc/__shim.js"></script><script src="/pc/__preload.js"></script>';
  const at = s.search(/<script\b/i);
  s = at >= 0 ? s.slice(0, at) + boot + s.slice(at) : s.replace(/<\/body>/i, `${boot}</body>`);
  return s;
}

/** The script files controls.html loads (the only files /pc/ serves, besides the shim and preload.js). */
function pageScripts(html) {
  const out = new Set();
  for (const m of String(html || '').matchAll(/<script[^>]*\bsrc="([A-Za-z0-9_\-]+\.js)"/gi)) out.add(m[1]);
  return out;
}

module.exports = { channelsOf, createEventQueue, jsonSafe, shimSource, pcPage, pageScripts, MAX_EVENTS, MAX_WAIT_MS };
