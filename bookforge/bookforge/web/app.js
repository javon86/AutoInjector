// Bookforge browser workspace. Vanilla ES module, no network access beyond this local server.
// All data is rendered with DOM APIs (never innerHTML with server data).
import { configureClipboard, copyText, readText } from './clipboard.js';
import { problemFor } from './problems.js';

/* ======================================================================= constants */
// Fallback names; the full guide (purpose, build order, featured actions) comes from GET /api/sets.
const SETS = {
  A: ['Universe & Characters', 'Your story bible: characters, places, worlds, cultures and the rules of your world.', '🌍'],
  B: ['Story Planning', 'Premise, genre and tone, main plot, character arcs, structure and the chapter outline.', '🗺️'],
  C: ['Writing', 'Turns the outline into chapter and scene prose — written by your AI or by you.', '✍️'],
  D: ['Art & Maps', 'Visual style, character references, illustrations, cover art and maps.', '🎨'],
  E: ['Story State & Continuity', 'What is true at each point of the story: places, knowledge, injuries, items, threads.', '🧭'],
  F: ['Editing', 'Reviews and suggested edits; changes reach the manuscript only through Writing.', '✂️'],
  G: ['Assemble & Export', 'Orders the approved chapters, lays out the book and exports PDF, EPUB and DOCX.', '📚'],
  H: ['Quality Checks', 'Checks the finished book and its files and says whether it is ready to release.', '✅'],
  I: ['Storage & Context', 'Behind the scenes: imports, schemas, search, context packages, approvals and history.', '🗄️'],
  J: ['Fix Contradictions', 'Finds facts that disagree and helps you fix them with the smallest change.', '⚖️'],
  K: ['Project Control', 'Scheduling, the job queue, approvals, pause/resume, AI selection and cost control.', '⚙️'],
};
const FEATURES = [
  ['artwork', 'Artwork', 'Enables set D (art) and artwork checks.'],
  ['magic', 'Magic / power systems', 'Enables A09 and E08.'],
  ['mystery', 'Mystery / reveals', 'Enables B08.'],
  ['foreshadowing', 'Foreshadowing', 'Enables B09.'],
  ['character_arcs', 'Character arcs', 'Character arc planning and checks.'],
];
const PROFILES = [
  ['MANUSCRIPT_PDF', 'Manuscript PDF'],
  ['PRINT_INTERIOR', 'Print interior'],
  ['PRINT_WRAP_COVER', 'Print wrap cover'],
  ['EPUB_REFLOWABLE', 'EPUB (reflowable)'],
  ['EDITABLE_DOCX', 'Editable DOCX'],
];
const REF_KEYS = ['project_id', 'branch_id', 'owner', 'module_id', 'record_id', 'version', 'content_hash'];
const LIFECYCLE = {
  DRAFT: ['✎', 'Draft', 'b-info'],
  VALIDATED: ['✓', 'Validated', 'b-info'],
  APPROVED: ['✔', 'Approved', 'b-ok'],
  LOCKED: ['■', 'Locked', 'b-ok'],
  SUPERSEDED: ['↷', 'Superseded', 'b-muted'],
  REJECTED: ['✕', 'Rejected', 'b-bad'],
};
const STATUS = {
  DRAFT: ['✎', 'Draft', 'b-info'],
  VALIDATED: ['✓', 'Validated', 'b-info'],
  APPROVED: ['✔', 'Approved', 'b-ok'],
  BLOCKED: ['⏸︎', 'Blocked', 'b-warn'],
  REJECTED: ['✕', 'Rejected', 'b-bad'],
  PARTIAL: ['◑', 'Partial', 'b-warn'],
  NOT_APPLICABLE: ['–', 'Not applicable', 'b-muted'],
  FAILED: ['✕', 'Failed', 'b-bad'],
  LOADING: ['…', 'Working', 'b-info'],
};
const SEVERITY = { INFO: 'b-muted', MINOR: 'b-info', MAJOR: 'b-warn', BLOCKING: 'b-bad' };
const LONG_TEXT = /(^|_)(text|instruction|instructions|summary|concept|premise|description|brief|notes?|reason|idea|question|background|appearance|traits|constraints|identity|prose|synopsis|content|body|rationale|explanation|goal|goals|message|outline|passage|dialogue|scene_description|cover_brief|panel_brief|composition_brief|scene_brief|rewrite_goal|transition_goal|style_goal|concept_summary|dramatic_question)$/;
const PROSE_KEYS = /(^|_)(text|summary|premise|concept|description|concept_summary|prose|body|synopsis|content|passage)$/;

/* ======================================================================= state */
const S = {
  token: null,
  ops: [], opsById: {}, schemas: {}, details: {},
  projects: [], pid: null, branch: null, project: null, manifest: null,
  records: [], uploadLabels: {},
  leaveHooks: [], blobUrls: [],
  navOpen: loadJSON('bf:navOpen', {}),
  assistForms: {}, skipSaveKeys: new Set(), slotCache: null,
  authFailed: false,
  guide: null,             // GET /api/sets for the open project (sets, counts, "what's next")
  prefill: new Map(),      // draft key -> form values handed to the next render (copy, paste, AI)
  pendingFocus: null,      // 'new': focus the New form after the next route
  task: null,              // GET .../review/summary: current task + approvals count for the open project
  pairing: null,           // {code, bridge} read once from #/pair?… (never kept in the address)
  pendingBookStep: null,   // a "Make my book" step to run when the book page opens (Current task)
};

/* ======================================================================= small utils */
function loadJSON(key, dflt) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : dflt; } catch { return dflt; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
function removeKey(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }

let uidCounter = 0;
const uid = (p = 'id') => `${p}-${++uidCounter}`;

function randomKey() {
  try { if (crypto.randomUUID) return 'ui-' + crypto.randomUUID(); } catch { /* fall through */ }
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return 'ui-' + Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

/** h('div', {class:'x', onclick: fn}, child, 'text', [more]) */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'selected') el.selected = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
const $ = (sel, root = document) => root.querySelector(sel);

function humanize(key) {
  if (!key) return '';
  const s = String(key).replace(/_refs$/, ' references').replace(/_ref$/, ' reference').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function fmtTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function shortHash(h) { return h ? h.slice(0, 10) + '…' : ''; }
function announce(msg) {
  const live = $('#live'); live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 30);
}
let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
function badge(icon, label, cls, title) {
  return h('span', { class: `badge ${cls}`, title },
    h('span', { class: 'ico', 'aria-hidden': 'true' }, icon), label);
}
function lifecycleBadge(lc) { const b = LIFECYCLE[lc] || ['?', lc, 'b-muted']; return badge(b[0], b[1], b[2]); }
function statusBadge(st) { const b = STATUS[st] || ['?', st, 'b-muted']; return badge(b[0], b[1], b[2]); }
function staleBadge(reason) { return badge('⚠︎', 'Stale', 'b-warn', reason || 'An input changed'); }
function isRefValue(v) { return v && typeof v === 'object' && !Array.isArray(v) && REF_KEYS.every(k => k in v); }
function isRefSchema(s) {
  return !!(s && typeof s === 'object' && s.properties && REF_KEYS.every(k => k in s.properties));
}
function ptrTemplate(ptr) { return ptr.split('/').filter(p => !/^\d+$/.test(p)).join('/'); }
function opLabel(id) { const o = S.opsById[id]; return o ? `${id} ${o.name}` : id; }

/* ======================================================================= API */
class ApiError extends Error {
  constructor(status, body) {
    const errs = (body && Array.isArray(body.errors)) ? body.errors : [];
    super(errs.length ? errs.map(e => e.message).join('; ') : `HTTP ${status}`);
    this.status = status; this.errors = errs; this.body = body;
  }
}
class NetworkError extends Error {}

async function api(method, path, opts = {}) {
  const headers = Object.assign({ Authorization: 'Bearer ' + (S.token || '') }, opts.headers || {});
  let body;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  let res;
  try {
    res = await fetch('/api' + path, { method, headers, body, signal: opts.signal, cache: 'no-store',
      credentials: 'same-origin' });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    noteClientError('NETWORK', `${method} ${path.split('?')[0]}`, 'BookForge did not answer');
    throw new NetworkError('Could not reach the Bookforge server. Check that it is still running, then retry.');
  }
  if (res.status === 401) { showAuthProblem('The access token was missing or not accepted.'); throw new ApiError(401, null); }
  if (opts.blob) {
    if (!res.ok) { let b = null; try { b = await res.json(); } catch { /* binary */ } throw new ApiError(res.status, b); }
    return res.blob();
  }
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = null; }
  if (!res.ok) {
    const x = (data && Array.isArray(data.errors) && data.errors[0]) || {};
    noteClientError(x.code || `HTTP_${res.status}`, `${method} ${path.split('?')[0]}${x.path ? ` ${x.path}` : ''}`, x.message || `HTTP ${res.status}`);
    throw new ApiError(res.status, data);
  }
  return data;
}
const bpath = (rest = '') => `/projects/${encodeURIComponent(S.pid)}/branches/${encodeURIComponent(S.branch)}${rest}`;

/* ======================================================================= auth */
function initToken() {
  const m = location.hash.match(/(?:^#|[&#])token=([^&]+)/);
  if (m) {
    S.token = decodeURIComponent(m[1]);
    try { sessionStorage.setItem('bf_token', S.token); } catch { /* private mode: keep in memory */ }
    // Also remembered on this computer (this address only), so a tab AutoInjector opens (#/pair, the
    // current task, the approval list) works without the start link. Cleared when the token is refused.
    try { localStorage.setItem('bf_token', S.token); } catch { /* ignore */ }
    history.replaceState(null, '', location.pathname + location.search + '#/');
  } else {
    try { S.token = sessionStorage.getItem('bf_token'); } catch { S.token = null; }
    if (!S.token) {
      try { S.token = localStorage.getItem('bf_token'); if (S.token) sessionStorage.setItem('bf_token', S.token); } catch { /* ignore */ }
    }
  }
}
/** #/pair?code=…&bridge=… from AutoInjector: read it once, then remove it from the address right away. */
function consumePairFragment() {
  const m = /^#\/pair\?(.*)$/.exec(location.hash || '');
  if (!m) return false;
  let params;
  try { params = new URLSearchParams(m[1]); } catch { params = new URLSearchParams(''); }
  history.replaceState(null, '', location.pathname + location.search + '#/pair');
  S.pairing = { code: (params.get('code') || '').trim(), bridge: (params.get('bridge') || '').trim() || BRIDGE_DEFAULT };
  return true;
}
function showAuthProblem(detail) {
  S.authFailed = true;
  try { sessionStorage.removeItem('bf_token'); } catch { /* ignore */ }
  try { localStorage.removeItem('bf_token'); } catch { /* ignore */ }
  clear($('#sidenav'));
  clear($('#top-links'));
  clear($('#context-bar'));
  const main = clear($('#main'));
  main.appendChild(h('section', { class: 'state failed', 'aria-labelledby': 'auth-h' },
    h('h1', { id: 'auth-h' }, 'Open Bookforge from its start link'),
    h('p', null, detail || 'This page has no access token.'),
    h('p', null, 'For privacy, the workspace only answers requests that carry the private token created when Bookforge starts. ' +
      'Open the full link printed in the Bookforge console window or launcher (it looks like ',
    h('code', null, 'http://127.0.0.1:8780/#token=…'), ').'),
    h('p', null, 'The token is kept only for this browser tab. If you opened a new tab or restarted Bookforge, use the link again.')));
  main.focus();
}

/* ======================================================================= data loading */
async function loadOps() {
  if (S.ops.length) return;
  S.ops = await api('GET', '/operations');
  for (const o of S.ops) S.opsById[o.id] = o;
}
async function getSchema(op) {
  if (!S.schemas[op]) S.schemas[op] = await api('GET', `/operations/${op}/schema`);
  return S.schemas[op];
}
async function loadProjects() { S.projects = await api('GET', '/projects'); return S.projects; }

async function ensureProject(pid, branch) {
  if (S.pid === pid && S.branch === branch && S.project) return;
  const proj = await api('GET', `/projects/${encodeURIComponent(pid)}`);
  if (!proj.branches.includes(branch)) {
    throw new ApiError(404, { errors: [{ code: 'NOT_FOUND', path: '/branch_id', message: `Branch "${branch}" does not exist in this project.` }] });
  }
  S.project = proj; S.pid = pid; S.branch = branch; S.details = {};
  saveJSON('bf:last', { pid, branch });
  await Promise.all([refreshRecords(), refreshManifest()]);
}
async function refreshManifest() {
  try { S.manifest = await api('GET', bpath('/manifest')); } catch { S.manifest = null; }
}
async function refreshRecords() {
  S.records = await api('GET', bpath('/records'));
  if (S.records.some(r => r.module_id === 'I01' && r.title === r.record_id)) {
    try {
      const act = await api('GET', bpath('/activity'));
      for (const e of act.events || []) {
        if (e.event_type === 'file.imported' && e.payload && e.payload.ref) {
          S.uploadLabels[e.payload.ref.record_id] = `${e.payload.label} (${e.payload.mime_type})`;
        }
      }
    } catch { /* labels are cosmetic */ }
  }
  renderNav();
  if (S.guide && S.guide.project_id === S.pid) loadGuide().then(() => { if (S.onGuideChanged) { try { S.onGuideChanged(); } catch { /* cosmetic */ } } });
  if (S.onRecordsChanged) { try { S.onRecordsChanged(); } catch { /* view-local refresh */ } }
  refreshTask();
}
/** Set guide for the open project: names, purposes, op order, featured actions, "what's next". */
async function loadGuide() {
  if (!S.pid) { S.guide = null; return null; }
  try {
    S.guide = await api('GET', `/sets?project_id=${encodeURIComponent(S.pid)}&branch_id=${encodeURIComponent(S.branch)}`);
  } catch (e) {
    if (!(S.guide && S.guide.project_id === S.pid && S.guide.branch_id === S.branch)) S.guide = null;
  }
  return S.guide;
}
function guideSet(letter) {
  return S.guide && S.guide.sets ? S.guide.sets.find(x => x.set_id === letter) || null : null;
}
function setInfo(letter) {
  const g = guideSet(letter);
  const f = SETS[letter] || [letter, '', '🧩'];
  return { id: letter, name: g ? g.name : f[0], purpose: g ? g.purpose : f[1], icon: g ? g.icon : f[2], guide: g };
}
/** Operations of a set in the order they are normally worked through (spec stage order). */
function opOrder(letter) {
  const g = guideSet(letter);
  if (g) return g.operations.map(o => o.op_id).filter(id => S.opsById[id]);
  return S.ops.filter(o => o.set === letter).map(o => o.id);
}
function recordTitle(r) {
  if (r.module_id === 'I01' && S.uploadLabels[r.record_id]) return S.uploadLabels[r.record_id];
  return r.title || r.record_id;
}
function recordById(rid) { return S.records.find(r => r.record_id === rid); }
async function recordDetail(rid, force) {
  if (force || !S.details[rid]) S.details[rid] = await api('GET', bpath(`/records/${encodeURIComponent(rid)}`));
  return S.details[rid];
}
function opStats(opId) {
  const recs = S.records.filter(r => r.module_id === opId);
  const st = { count: recs.length, approved: 0, stale: 0, draft: 0 };
  for (const r of recs) {
    if (r.approved_version) st.approved++;
    if (r.stale) st.stale++;
    if (r.lifecycle === 'DRAFT' || r.lifecycle === 'VALIDATED') st.draft++;
  }
  return st;
}
function isRequired(opId) { return !!(S.manifest && (S.manifest.required_operations || []).includes(opId)); }
function opStateBadge(opId) {
  const st = opStats(opId);
  if (!st.count) return isRequired(opId) ? badge('○', 'Empty', 'b-muted') : badge('–', 'Not required', 'b-muted');
  if (st.stale) return badge('⚠︎', `${st.stale} stale`, 'b-warn');
  if (st.approved === st.count) return badge('✔', 'Approved', 'b-ok');
  if (st.approved) return badge('◑', `${st.approved}/${st.count} approved`, 'b-info');
  return badge('✎', 'Draft', 'b-info');
}
function opStateText(opId) {
  const st = opStats(opId);
  if (!st.count) return isRequired(opId) ? 'empty' : 'not required';
  const parts = [`${st.count} rec`];
  if (st.approved) parts.push(`✔${st.approved} approved`);
  if (st.stale) parts.push(`⚠︎${st.stale} stale`);
  if (!st.approved && !st.stale) parts.push('draft');
  return parts.join(' · ');
}

/* ======================================================================= routing */
function link(...parts) { return '#/' + parts.map(p => encodeURIComponent(p)).join('/'); }
function plink(...rest) { return link('p', S.pid, S.branch, ...rest); }
function recLink(ref) {
  if (!ref) return '#/';
  return link('p', ref.project_id || S.pid, ref.branch_id || S.branch, 'rec', ref.record_id, String(ref.version));
}
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  return raw.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
}

let routeSeq = 0;
async function route() {
  if (S.authFailed) return;
  // Leaving the previous view: flush drafts, release blob URLs.
  for (const fn of S.leaveHooks.splice(0)) { try { fn(); } catch { /* keep going */ } }
  for (const u of S.blobUrls.splice(0)) URL.revokeObjectURL(u);
  closeNav();
  closePops();
  closeJump();
  consumePairFragment();
  const seq = ++routeSeq;
  const parts = parseRoute();
  const main = $('#main');
  try {
    await loadOps();
    if (parts[0] === 'p' && parts.length >= 3) {
      await ensureProject(parts[1], parts[2]);
      await loadGuide();
      refreshTask();
    } else if (parts[0] !== 'settings') {
      // Home: keep the context of the last project only for the top bar.
    }
    if (seq !== routeSeq) return;
    renderTop(parts);
    renderNav();
    const view = await pickView(parts);
    if (seq !== routeSeq) return;
    clear(main);
    await view(main);
  } catch (e) {
    if (seq !== routeSeq || S.authFailed) return;
    renderTop(parts); renderNav();
    clear(main).appendChild(failedState('Could not load this page', e,
      h('p', null, h('a', { href: '#/' }, 'Back to projects'))));
  }
  if (seq === routeSeq && !S.authFailed) {
    // ✨ Fill with AI panels belong to their operation's form: on any other page they fold to their header
    const here = parts[0] === 'p' && parts[3] === 'op' ? `${parts[1]}|${parts[2]}|${parts[4]}` : null;
    for (const [key, p] of AP.panels) if (key !== here && !p.min) p.setMin(true);
    const h1 = main.querySelector('h1');
    document.title = h1 ? `${h1.textContent} – Bookforge` : 'Bookforge';
    if (!main.contains(document.activeElement) || document.activeElement === document.body) main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    if (S.pendingFocus === 'new') {
      S.pendingFocus = null;
      setTimeout(() => {
        const hd = $('#new-h');
        if (hd) { hd.setAttribute('tabindex', '-1'); hd.focus({ preventScroll: true }); hd.scrollIntoView({ block: 'start' }); }
      }, 60);
    }
  } else if (seq === routeSeq) S.pendingFocus = null;
}

async function pickView(parts) {
  if (!parts.length) return viewHome;
  if (parts[0] === 'settings') return viewSettings;
  if (parts[0] === 'start') return viewStart;
  if (parts[0] === 'pair') return viewPair;
  if (parts[0] === 'shelf') return viewShelf;
  if (parts[0] === 'p') {
    const rest = parts.slice(3);
    if (!rest.length) return viewOverview;
    if (rest[0] === 'set' && SETS[rest[1]]) return m => viewSet(m, rest[1]);
    if (rest[0] === 'op' && S.opsById[rest[1]]) return m => viewOperation(m, rest[1]);
    if (rest[0] === 'rec' && rest[1]) return m => viewRecord(m, rest[1], rest[2] ? parseInt(rest[2], 10) : null);
    if (rest[0] === 'edit' && rest[1]) return m => viewEdit(m, rest[1]);
    if (rest[0] === 'manifest') return viewManifest;
    if (rest[0] === 'activity') return viewActivity;
    if (rest[0] === 'progress') return viewProgress;
    if (rest[0] === 'book') return viewBook;
    if (rest[0] === 'journal' || (rest[0] || '').startsWith('journal?')) return viewJournal;
    if (rest[0] === 'review') return m => viewReview(m, rest[1] === 'step', rest[2] || null);
  }
  return m => { m.appendChild(h('h1', null, 'Page not found')); m.appendChild(h('p', null, h('a', { href: '#/' }, 'Go to projects'))); };
}

/* ======================================================================= chrome */
function renderTop(parts) {
  const bar = clear($('#context-bar'));
  const inProject = parts[0] === 'p' && S.project;
  if (S.projects.length || inProject) {
    const pSel = h('select', { id: 'project-select', onchange: e => {
      const pid = e.target.value; if (!pid) { go('#/'); return; }
      go(link('p', pid, 'main'));
    } }, h('option', { value: '' }, '— Projects —'));
    const list = S.projects.length ? S.projects : [S.project];
    for (const p of list) pSel.appendChild(h('option', { value: p.project_id, selected: inProject && p.project_id === S.pid }, p.name));
    bar.appendChild(h('label', { for: 'project-select' }, 'Project'));
    bar.appendChild(pSel);
  }
  if (inProject) {
    const bSel = h('select', { id: 'branch-select', onchange: e => {
      const rest = parseRoute().slice(3);
      const keep = rest[0] === 'op' || rest[0] === 'set' || ['manifest', 'activity', 'progress'].includes(rest[0]) ? rest : [];
      go(link('p', S.pid, e.target.value, ...keep));
    } });
    for (const b of S.project.branches) bSel.appendChild(h('option', { value: b, selected: b === S.branch }, b));
    bar.appendChild(h('label', { for: 'branch-select' }, 'Branch'));
    bar.appendChild(bSel);
  }
  const links = clear($('#top-links'));
  const here = location.hash || '#/';
  const add = (el, href, text) => el.appendChild(h('a', { href, 'aria-current': here === href ? 'page' : null }, text));
  links.appendChild(h('a', { href: '#/start', class: 'tb-new', 'aria-current': here === '#/start' ? 'page' : null, title: 'Start a new book (step by step)' }, '🚀 New book'));
  links.appendChild(h('a', { href: '#/', class: inProject ? 'tb-books in-project' : 'tb-books', 'aria-current': here === '#/' ? 'page' : null }, 'Books'));
  if (inProject) {
    add(links, link('p', S.pid, S.branch), 'Overview');
    links.appendChild(h('a', { href: link('p', S.pid, S.branch, 'book'), 'aria-current': here === link('p', S.pid, S.branch, 'book') ? 'page' : null }, '📘 Make my book'));
  }
  links.appendChild(h('a', { href: '#/settings', class: 'tb-settings', title: 'Settings', 'aria-current': here === '#/settings' ? 'page' : null },
    h('span', { class: 'tb-set-ico', 'aria-hidden': 'true' }, '⚙️ '), h('span', { class: 'tb-label' }, 'Settings')));
  // Less frequent pages live in the "More" menu so the bar stays on one line.
  const more = clear($('#more-links'));
  add(more, '#/shelf', '📚 My finished books');
  if (inProject) {
    add(more, link('p', S.pid, S.branch, 'journal'), '📜 Book journal');
    add(more, link('p', S.pid, S.branch, 'progress'), '📊 Progress');
    add(more, link('p', S.pid, S.branch, 'activity'), '🕘 Activity');
    add(more, link('p', S.pid, S.branch, 'manifest'), '🎛️ Book features');
  } else {
    more.appendChild(h('p', { class: 'small muted more-note' }, 'Open a project for Progress, Activity and the feature manifest.'));
  }
}

function renderNav() {
  const nav = clear($('#sidenav'));
  if (!S.project || parseRoute()[0] !== 'p') {
    nav.appendChild(h('h2', null, 'Operation sets'));
    nav.appendChild(h('p', { class: 'muted small', style: 'padding: 0 8px' },
      'Open or create a project to work in the 11 operation sets.'));
    for (const [letter, [name]] of Object.entries(SETS)) {
      nav.appendChild(h('div', { class: `set-toggle set-${letter}`, 'aria-disabled': 'true' },
        h('span', { class: `set-letter set-${letter}` }, letter), h('span', { class: 'set-name' }, name)));
    }
    return;
  }
  const parts = parseRoute();
  nav.appendChild(h('div', { id: 'nav-task', class: 'nav-task' }, taskCard('nav'), approvalsButton()));
  const curOp = parts[3] === 'op' ? parts[4] : (parts[3] === 'rec' || parts[3] === 'edit') ? (recordById(parts[4]) || {}).module_id : null;
  const curSet = parts[3] === 'set' ? parts[4] : curOp ? curOp[0] : null;
  nav.appendChild(h('h2', { id: 'nav-h' }, 'Operation sets'));
  for (const [letter, [name]] of Object.entries(SETS)) {
    const ops = S.ops.filter(o => o.set === letter);
    const listId = `nav-set-${letter}`;
    const open = S.navOpen[letter] ?? (letter === curSet);
    const total = S.records.filter(r => r.module_id[0] === letter).length;
    const ul = h('ul', { class: 'set-links', id: listId, hidden: !open });
    ul.appendChild(h('li', null, h('a', { href: link('p', S.pid, S.branch, 'set', letter), class: 'set-overview-link',
      'aria-current': parts[3] === 'set' && parts[4] === letter ? 'page' : null }, `${name} workspace`)));
    let staleSet = 0;
    for (const o of ops) {
      const st = opStats(o.id);
      staleSet += st.stale;
      ul.appendChild(h('li', { class: st.stale ? 'has-hazard' : null }, h('a', { href: link('p', S.pid, S.branch, 'op', o.id),
        'aria-current': curOp === o.id ? 'page' : null },
      h('span', { class: 'op-id' }, o.id), h('span', { class: 'op-name' }, o.name),
      h('span', { class: 'op-meta' }, opStateText(o.id))),
      st.stale ? hazard({ code: 'STALE', message: `${st.stale} record(s) of this step are out of date.`, where: { book: profileOf().title || S.project.name, set: letter, step: o.name, op: o.id } },
        { open: link('p', S.pid, S.branch, 'op', o.id), openLabel: 'Open the step' }, { small: true }) : null));
    }
    const btn = h('button', { type: 'button', class: 'set-toggle', 'aria-expanded': String(!!open), 'aria-controls': listId,
      onclick: () => {
        const now = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', String(now)); ul.hidden = !now;
        S.navOpen[letter] = now; saveJSON('bf:navOpen', S.navOpen);
      } },
    h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸'),
    h('span', { class: `set-letter set-${letter}` }, letter), h('span', { class: 'set-name' }, name),
    staleSet ? h('span', { class: 'set-warn', title: `${staleSet} out-of-date record(s)` }, '⚠️') : null,
    h('span', { class: 'set-count' }, `${total} rec`));
    nav.appendChild(h('div', { class: `set-group set-${letter}${letter === curSet ? ' here' : ''}` }, btn, ul));
  }
}
function closeNav() {
  const nav = $('#sidenav'); nav.classList.remove('open');
  $('#nav-toggle').setAttribute('aria-expanded', 'false');
}

/* ======================================================================= common states */
function stateBox(kind, title, ...body) {
  const icons = { empty: '○', loading: '…', blocked: '⏸︎', failed: '✕', stale: '⚠︎', ok: '✔', draft: '✎' };
  // The hidden word a screen reader says first: 'ok' is any success (not necessarily an approval).
  const words = { empty: 'Empty', loading: 'Loading', blocked: 'Blocked', failed: 'Failed', stale: 'Stale', ok: 'Done', draft: 'Draft' };
  return h('section', { class: `state ${kind}`, role: kind === 'failed' ? 'alert' : null },
    h('h3', null, h('span', { 'aria-hidden': 'true' }, icons[kind] || ''),
      h('span', { class: 'visually-hidden' }, `${words[kind] || kind}: `), title), ...body);
}
function errorItems(errs) {
  return h('ul', { class: 'error-list' }, errs.map(e => h('li', null,
    h('code', null, e.code), e.path ? [' at ', h('code', null, e.path)] : '', ' — ', e.message || '')));
}
function failedState(title, e, ...extra) {
  const p = toProblem(e);
  const body = [h('p', { class: 'fs-plain' }, hazard(p, { retry: p.action === 'reload' ? () => route() : null, retryLabel: '🔁 Reload' }), ' ', h('strong', null, p.title), ' — ', p.what),
    h('p', { class: 'small' }, h('strong', null, 'How to fix it: '), p.fix)];
  if (e instanceof ApiError && e.errors.length) body.push(h('details', { class: 'hz-tech small' }, h('summary', null, 'Technical details'), errorItems(e.errors)));
  else body.push(h('p', { class: 'small muted' }, (e && e.message) || String(e)));
  return stateBox('failed', title, ...body, ...extra);
}
function loadingState(text) { return stateBox('loading', h('span', null, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', text)); }

/* ======================================================================= views: home */
async function viewHome(main) {
  await loadProjects();
  renderTop([]);
  if (!S.projects.length) { await viewStart(main); return; }
  main.appendChild(h('div', { class: 'page-head' }, h('h1', null, 'Your books'),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary big mab-cta', onclick: ev => openMakeBook(ev.currentTarget) }, '⚡ Make a book for me'),
      h('a', { class: 'btn big', href: '#/start' }, '🚀 Start a new book'), h('a', { class: 'btn big', href: '#/shelf' }, '📚 My finished books'))));
  const listCard = h('section', { class: 'card', 'aria-labelledby': 'proj-list-h' }, h('h2', { id: 'proj-list-h' }, 'Your projects'));
  if (!S.projects.length) {
    listCard.appendChild(stateBox('empty', 'No projects yet',
      h('p', null, 'Create your first project below. The only required input is a project name; features and release profiles can be changed later in the feature manifest.')));
  } else {
    const ul = h('ul', { class: 'record-list' });
    for (const p of S.projects.filter(x => !x.test_book)) {
      const n = Object.values(p.record_counts || {}).reduce((a, b) => a + b, 0);
      ul.appendChild(h('li', { class: 'record-item' },
        h('div', { class: 'r-main' }, h('a', { class: 'r-title', href: link('p', p.project_id, 'main') }, p.name),
          h('div', { class: 'r-meta' }, `${p.project_id} · created ${fmtTime(p.created_at)} · branches: ${p.branches.join(', ')}`)),
        h('div', { class: 'r-badges' }, badge('▤', `${n} records on main`, 'b-muted'), bookActions(p))));
    }
    listCard.appendChild(ul);
    const tests = S.projects.filter(x => x.test_book);
    if (tests.length) {
      listCard.appendChild(h('details', { class: 'test-books' }, h('summary', null, `🧪 Test books (${tests.length}) — made by Test everything / Test workflow, not your real books`),
        h('ul', { class: 'record-list' }, tests.map(p => h('li', { class: 'record-item' },
          h('div', { class: 'r-main' }, h('a', { class: 'r-title', href: link('p', p.project_id, 'main') }, p.name),
            h('div', { class: 'r-meta' }, `created ${fmtTime(p.created_at)}`)), h('div', { class: 'r-badges' }, bookActions(p)))))));
    }
  }
  listCard.appendChild(archivedBooks());
  main.appendChild(listCard);
  main.appendChild(h('details', { class: 'card' }, h('summary', null, 'Advanced: create an empty project with chosen features'), projectCreateForm()));
}

/* BF-19: archive (hide, kept and backed up) or permanently delete a book from the book list. */
function bookActions(p, archived) {
  const arch = h('button', { type: 'button', class: 'small', title: archived ? 'Show this book in your list again' : 'Hide this book from your list (it is kept and backed up)',
    onclick: async ev => {
      const b = ev.currentTarget;
      if (!archived && !confirm(`Archive “${p.name}”? It disappears from your book list but is kept (and backed up). You can bring it back under 🗄 Archived books.`)) return;
      b.disabled = true;
      try { const r = await api('POST', `/projects/${encodeURIComponent(p.project_id)}/archive`, { body: { archived: !archived } }); toast(r.message); route(); }
      catch (e) { const pr = toProblem(e); toast(`${pr.title}: ${pr.message}`); b.disabled = false; }
    } }, archived ? '↩ Unarchive' : '🗄 Archive');
  const del = h('button', { type: 'button', class: 'small danger', onclick: () => deleteBook(p) }, '🗑 Delete…');
  return h('span', { class: 'row' }, arch, del);
}
function archivedBooks() {
  const box = h('div');
  const det = h('details', { class: 'archived-books' }, h('summary', null, '🗄 Archived books'), box);
  det.addEventListener('toggle', async () => {
    if (!det.open) return;
    clear(box).appendChild(loadingState('Loading archived books…'));
    try {
      const list = await api('GET', '/projects?archived=1');
      clear(box).appendChild(list.length ? h('ul', { class: 'record-list' }, list.map(p => h('li', { class: 'record-item' },
        h('div', { class: 'r-main' }, h('span', { class: 'r-title' }, p.name), h('div', { class: 'r-meta' }, `created ${fmtTime(p.created_at)}`)),
        h('div', { class: 'r-badges' }, bookActions(p, true))))) : h('p', { class: 'small muted' }, 'No archived books.'));
    } catch (e) { clear(box).appendChild(failedState('Could not load archived books', e)); }
  });
  return det;
}
function deleteBook(p) {
  modal('🗑 Delete a book', close => {
    const word = h('input', { type: 'text', id: uid('del'), autocomplete: 'off', spellcheck: 'false' });
    const out = h('div', { 'aria-live': 'polite' });
    const go2 = h('button', { type: 'submit', class: 'danger' }, '🗑 Delete this book for good');
    return h('form', { novalidate: true, onsubmit: async ev => {
      ev.preventDefault(); clear(out); clearFieldProblems(ev.currentTarget);
      if (word.value.trim() !== p.name.trim()) { markFieldProblem(word, { code: 'MISSING_INPUT', message: 'Type the book\'s name exactly.' }, { step: 'Delete a book', field: 'Book name' }); word.focus(); return; }
      go2.disabled = true; out.appendChild(loadingState('Deleting… (a safety backup is made first)'));
      try {
        const r = await api('POST', `/projects/${encodeURIComponent(p.project_id)}/delete`, { body: { author_confirms: true, confirm: word.value.trim() } });
        close(); toast(r.message); S.project = null; await loadProjects(); route();
      } catch (e) { clear(out).appendChild(problemBox(toProblem(e, { step: 'Delete a book' }))); go2.disabled = false; }
    } },
    h('div', { class: 'state blocked' }, h('h3', null, `⚠️ This deletes “${p.name}” and everything in it`),
      h('p', null, 'The book disappears from BookForge. A safety backup is made first; until the automatic backups rotate it out, restoring that backup brings the book back. To only hide a book, use 🗄 Archive instead.')),
    h('div', { class: 'field' }, h('label', { for: word.id }, 'Type the book\'s name to confirm'), word),
    out, h('div', { class: 'form-actions' }, go2, h('button', { type: 'button', onclick: close }, 'Cancel')));
  });
}

function projectCreateForm() {
  const errBox = h('div');
  const name = h('input', { id: 'np-name', type: 'text', required: true, autocomplete: 'off', 'aria-describedby': 'np-name-hint' });
  const feats = FEATURES.map(([k, label, hint]) => {
    const id = `np-f-${k}`;
    return { k, el: h('input', { type: 'checkbox', id, checked: k === 'character_arcs', 'aria-describedby': id + '-h' }), label, hint, id };
  });
  const profs = PROFILES.map(([k, label]) => ({ k, el: h('input', { type: 'checkbox', id: `np-p-${k}`, checked: k === 'MANUSCRIPT_PDF' }), label }));
  const unit = h('input', { id: 'np-unit', type: 'text', value: 'seconds', 'aria-describedby': 'np-unit-h' });
  const cur = h('input', { id: 'np-cur', type: 'text', value: 'USD', maxlength: '3', 'aria-describedby': 'np-cur-h' });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Create project');
  const form = h('form', { class: 'card', 'aria-labelledby': 'np-h', novalidate: true, onsubmit: async ev => {
    ev.preventDefault(); clear(errBox);
    const body = { name: name.value.trim(), features: {}, release_profiles: profs.filter(p => p.el.checked).map(p => p.k),
      story_time_unit: unit.value.trim() || 'seconds', currency: (cur.value.trim() || 'USD').toUpperCase() };
    for (const f of feats) body.features[f.k] = f.el.checked;
    if (!body.name) { errBox.appendChild(stateBox('failed', 'Project name is required')); name.setAttribute('aria-invalid', 'true'); name.focus(); return; }
    if (!body.release_profiles.length) { errBox.appendChild(stateBox('failed', 'Choose at least one release profile')); return; }
    submit.disabled = true;
    try {
      const p = await api('POST', '/projects', { body });
      toast(`Project "${p.name}" created`);
      await loadProjects();
      go(link('p', p.project_id, 'main'));
    } catch (e) { errBox.appendChild(failedState('Project was not created', e)); submit.disabled = false; }
  } },
  h('h2', { id: 'np-h' }, 'Create a project'),
  errBox,
  h('div', { class: 'field' }, h('label', { for: 'np-name' }, 'Project name', h('span', { class: 'req-tag required' }, 'Required')), name,
    h('span', { class: 'hint', id: 'np-name-hint' }, 'Working title or any name you will recognise. Projects are private to this computer.')),
  h('fieldset', { class: 'field' }, h('legend', null, 'Features'),
    h('div', { class: 'check-grid' }, feats.map(f => h('div', { class: 'check-row' }, f.el,
      h('label', { for: f.id }, f.label, h('span', { class: 'hint', id: f.id + '-h' }, f.hint)))))),
  h('fieldset', { class: 'field' }, h('legend', null, 'Release profiles (at least one)'),
    h('div', { class: 'check-grid' }, profs.map(p => h('div', { class: 'check-row' }, p.el, h('label', { for: `np-p-${p.k}` }, p.label))))),
  h('div', { class: 'grid-2' },
    h('div', { class: 'field' }, h('label', { for: 'np-unit' }, 'Story time unit'), unit,
      h('span', { class: 'hint', id: 'np-unit-h' }, 'Story time is stored as integer ticks of this unit (default seconds).')),
    h('div', { class: 'field' }, h('label', { for: 'np-cur' }, 'Currency'), cur,
      h('span', { class: 'hint', id: 'np-cur-h' }, 'Three-letter code used for cost quotas (integer minor units).'))),
  h('div', { class: 'form-actions' }, submit));
  return form;
}

/* ======================================================================= views: project overview */
async function viewOverview(main) {
  const p = S.project;
  const totals = S.records.length;
  main.appendChild(h('div', { class: 'page-head' },
    h('div', null, crumbs(['Your books', '#/'], p.name), h('h1', null, p.name)),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', 'aria-haspopup': 'dialog', onclick: ev => openJump(ev.currentTarget) }, '🔍 Jump to…'),
      h('a', { class: 'btn', href: plink('manifest'), title: 'The feature manifest: which parts of BookForge this book uses' }, '🎛️ Book features'),
      h('a', { class: 'btn', href: plink('progress') }, 'Progress'))));
  main.appendChild(h('div', { class: 'task-slot', 'data-where': 'page' }, taskCard('page')));
  const next = h('div');
  const drawNext = () => clear(next).appendChild(whatsNextCard(null));
  drawNext();
  S.onGuideChanged = drawNext;
  S.leaveHooks.push(() => { S.onGuideChanged = null; });
  main.appendChild(next);
  const t0 = myTask();
  main.appendChild(h('section', { class: 'card book-cta' },
    h('div', { class: 'bc-text' }, h('h2', null, '📘 Make my book'), h('p', { class: 'small' }, 'One guided checklist from characters to a downloadable PDF, EPUB and Word file. It shows what is done, what needs you and what your AI can do.'),
      h('div', { class: 'ov-words' }, t0 && t0.book ? wordsLine(t0.book.words) : null)),
    h('div', { class: 'row' }, h('a', { class: 'btn primary big', href: plink('book') }, '▶ Open Make my book'),
      h('a', { class: 'btn', href: plink('journal') }, '📜 Book journal'), h('a', { class: 'btn', href: '#/shelf' }, '📚 Finished books'))));
  main.appendChild(h('section', { class: 'card mab-card' },
    h('div', null, h('h2', null, '⚡ Make a book for me'), h('p', { class: 'small' }, 'Let your AI make a whole NEW book in one go — you watch every step, can pause or cancel, and get PDF, EPUB and Word at the end. This book is not touched.')),
    h('button', { type: 'button', class: 'primary big mab-cta', onclick: ev => openMakeBook(ev.currentTarget) }, '⚡ Make a book for me')));
  main.appendChild(profileCard());
  if (!totals) {
    main.appendChild(stateBox('empty', 'This branch has no records yet',
      h('p', null, 'Start with Set A: open “Universe & Characters” below and press “Make up characters for me”, or ',
        h('button', { type: 'button', class: 'link', onclick: ev => openBible(ev.currentTarget) }, 'build a starter story bible'),
        '. You can also write a premise yourself in ', h('a', { href: plink('op', 'B01') }, 'B01 Premise/Concept Builder'), '.')));
  }
  main.appendChild(h('section', { class: 'launcher', 'aria-labelledby': 'sets-h' },
    h('div', { class: 'launcher-head' }, h('h2', { id: 'sets-h' }, '🧩 Module sets'),
      h('p', { class: 'small muted' }, 'Each set is one part of making the book. Open a set for what it does, its steps and quick actions. Main path: A → B → C → E → F → G → H.')),
    setTiles('tile')));
  main.appendChild(h('details', { class: 'card', 'aria-labelledby': 'ov-h' }, h('summary', { id: 'ov-h' }, 'Project details'),
    h('dl', { class: 'kv' },
      h('dt', null, 'Project ID'), h('dd', null, h('code', null, p.project_id)),
      h('dt', null, 'Branch'), h('dd', null, S.branch),
      h('dt', null, 'Created'), h('dd', null, fmtTime(p.created_at)),
      h('dt', null, 'Story time unit'), h('dd', null, p.story_time_unit),
      h('dt', null, 'Currency'), h('dd', null, p.currency),
      h('dt', null, 'Phase'), h('dd', null, S.manifest ? S.manifest.phase : 'unknown'),
      h('dt', null, 'Features'), h('dd', null, S.manifest ? FEATURES.map(([k, l]) =>
        `${l}: ${S.manifest.features[k] ? 'on' : 'off'}`).join(' · ') : 'no manifest'),
      h('dt', null, 'Release profiles'), h('dd', null, S.manifest ? S.manifest.release_profiles.join(', ') : '—'),
      h('dt', null, 'Required operations'), h('dd', null, S.manifest ? String(S.manifest.required_operations.length) : '—'))));
  main.appendChild(branchForm());
}

function branchForm() {
  const out = h('div', { 'aria-live': 'polite' });
  const bid = h('input', { id: 'nb-id', type: 'text', autocomplete: 'off', pattern: '[A-Za-z0-9._-]{1,64}', 'aria-describedby': 'nb-id-h' });
  const parent = h('select', { id: 'nb-parent' }, S.project.branches.map(b => h('option', { value: b, selected: b === S.branch }, b)));
  return h('form', { class: 'card', 'aria-labelledby': 'nb-h', novalidate: true, onsubmit: async ev => {
    ev.preventDefault(); clear(out);
    const id = bid.value.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      bid.setAttribute('aria-invalid', 'true');
      out.appendChild(stateBox('failed', 'Branch ID: letters, digits, dot, underscore or dash (max 64).')); bid.focus(); return;
    }
    try {
      S.project = await api('POST', `/projects/${encodeURIComponent(S.pid)}/branches`, { body: { branch_id: id, parent_branch_id: parent.value } });
      toast(`Branch "${id}" created`);
      S.project = null; go(link('p', S.pid, id));
    } catch (e) { out.appendChild(failedState('Branch was not created', e)); }
  } },
  h('h2', { id: 'nb-h' }, 'Create a branch'),
  h('p', { class: 'muted small' }, 'A branch is an isolated line of work (for example an alternate ending). It starts with a copy of the parent’s feature manifest; records stay pinned to their own branch.'),
  h('div', { class: 'grid-2' },
    h('div', { class: 'field' }, h('label', { for: 'nb-id' }, 'New branch ID', h('span', { class: 'req-tag required' }, 'Required')), bid,
      h('span', { class: 'hint', id: 'nb-id-h' }, 'Letters, digits, . _ - (max 64).')),
    h('div', { class: 'field' }, h('label', { for: 'nb-parent' }, 'Parent branch'), parent)),
  out, h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Create branch')));
}

/* ======================================================================= views: set workspace */
function viewSet(main, letter) {
  const info = setInfo(letter);
  const g = info.guide;
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [S.project.name, plink()], `${letter} · ${info.name}`),
    h('h1', null, h('span', { 'aria-hidden': 'true' }, `${info.icon} `), `${letter} · ${info.name}`), h('p', { class: 'muted' }, info.purpose)),
  h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', 'aria-haspopup': 'dialog', onclick: ev => openSetPanel(letter, ev.currentTarget) }, '🧩 Open the set panel'))));
  if (g) {
    main.appendChild(h('section', { class: 'card', 'aria-labelledby': 'set-about' }, h('h2', { id: 'set-about' }, 'What this set is for'),
      h('p', null, g.about), h('p', { class: 'small' }, h('strong', null, 'Where it fits: '), g.stage),
      g.featured_actions.length ? h('div', { class: 'featured-row' }, g.featured_actions.map(f => featuredButton(letter, f, false))) : null));
  }
  const cards = h('div', { class: 'op-cards' });
  for (const id of opOrder(letter)) {
    const o = S.opsById[id];
    const st = opStats(o.id);
    cards.appendChild(h('a', { class: 'op-card', href: plink('op', o.id) },
      h('h3', null, `${o.id} ${o.name}`),
      h('p', null, o.purpose.length > 160 ? o.purpose.slice(0, 157) + '…' : o.purpose),
      h('div', { class: 'row' }, opStateBadge(o.id), badge('▤', `${st.count} records`, 'b-muted'),
        badge(o.execution.includes('AI') || o.execution.includes('HYBRID') ? '✦' : '⚙︎', o.execution, 'b-muted'),
        isRequired(o.id) ? null : badge('–', 'not in manifest', 'b-muted'))));
  }
  if (letter === 'A') {
    main.appendChild(h('section', { class: 'card bible-cta', 'aria-labelledby': 'bb-cta-h' },
      h('h2', { id: 'bb-cta-h' }, h('span', { 'aria-hidden': 'true' }, '📖 '), 'Start your story bible with AI'),
      h('p', null, 'The Bible Builder drafts the starter set you need to begin the book — characters, places, the world, a culture, a government or faction and a magic or technology system — from your book idea. You pick which sections and how many, run them one by one or all together, then keep the ones you like as drafts.'),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', 'aria-haspopup': 'dialog', onclick: ev => openBible(ev.currentTarget) }, '📖 Open the Bible Builder'),
        infoTip('What is the Bible Builder?', ...TIP_BIBLE()))));
  }
  main.appendChild(h('section', { 'aria-label': `${info.name} operations` }, h('h2', null, 'Steps in this set'), cards));
}

/* ======================================================================= views: operation */
function isCreative(op) { return /AI|HYBRID/.test(op.execution); }

async function viewOperation(main, opId) {
  const op = S.opsById[opId];
  const schema = await getSchema(opId);
  const sInfo = setInfo(op.set);
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [S.project.name, plink()], [`${op.set} · ${sInfo.name}`, plink('set', op.set)], `${op.id} ${op.name}`),
    h('h1', null, `${op.id} ${op.name}`)),
  h('div', { class: 'row' }, h('span', { class: 'op-state-slot' }, opStateBadge(opId)), badge(isCreative(op) ? '✦' : '⚙︎', op.execution, 'b-muted'),
    badge('▦', op.ui_type, 'b-muted'))));
  main.appendChild(stepNav(opId));
  const nextBox = h('div');
  const drawNext = () => clear(nextBox).appendChild(whatsNextCard(opId));
  drawNext();
  S.onGuideChanged = drawNext;
  S.leaveHooks.push(() => { S.onGuideChanged = null; });
  main.appendChild(nextBox);

  const notRequired = S.manifest && !isRequired(opId);
  main.appendChild(h('section', { class: 'card', 'aria-labelledby': 'op-about' }, h('h2', { id: 'op-about' }, 'About this operation'),
    h('dl', { class: 'kv' },
      h('dt', null, 'Purpose'), h('dd', null, op.purpose),
      h('dt', null, 'Execution'), h('dd', null, op.execution),
      h('dt', null, 'AI policy'), h('dd', null, op.ai || '—'),
      h('dt', null, 'Routes'), h('dd', null, op.routes || '—'),
      h('dt', null, 'Minimum first input'), h('dd', null, (op.create_requires || []).length ? op.create_requires.map(x => h('code', null, x)).reduce((a, x) => a.concat(a.length ? [', ', x] : [x]), []) : 'none'),
      h('dt', null, 'Accepts references from'), h('dd', null, schema.bindings.length ? schema.bindings.map(b =>
        h('div', null, h('code', null, b.input_path.replace('/payload/', '')), ': ', b.allowed_producers.length > 6
          ? `${b.allowed_producers.slice(0, 6).join(', ')} … (${b.allowed_producers.length})` : b.allowed_producers.join(', '),
        b.required_at_create ? ' (required)' : '')) : 'none'),
      h('dt', null, 'Manifest'), h('dd', null, S.manifest ? (isRequired(opId) ? 'Required in this branch’s feature manifest' : 'Not in required_operations for this branch') : 'unknown'),
      h('dt', null, 'Specification'), h('dd', null, h('code', null, op.specification || '')))));
  if (notRequired && ['B08', 'B09', 'E08', 'A09'].includes(opId) || (notRequired && op.set === 'D')) {
    main.appendChild(stateBox('blocked', 'This operation may be disabled by a feature toggle',
      h('p', null, 'Requests can return NOT_APPLICABLE until the matching feature is enabled. ',
        h('a', { href: plink('manifest') }, 'Open the feature manifest'), '.')));
  }

  // Records
  const recCard = h('section', { class: 'card', 'aria-labelledby': 'op-recs' });
  const renderRecs = () => {
    const recs = S.records.filter(r => r.module_id === opId);
    clear(recCard).appendChild(h('h2', { id: 'op-recs' }, `Records (${recs.length})`));
    if (!recs.length) {
      recCard.appendChild(stateBox('empty', `No ${op.id} records on branch ${S.branch}`,
        h('p', null, 'Minimum first input: ', (op.create_requires || []).length
          ? op.create_requires.map(x => h('code', null, x)).reduce((a, x) => a.concat(a.length ? [', ', x] : [x]), [])
          : 'see the required fields below', '. Fill the form below and choose Create.')));
    } else {
      recCard.appendChild(recordList(recs));
    }
  };
  renderRecs();
  // the page header's state badge follows the records too (it said "Empty" after a record was created here)
  S.onRecordsChanged = () => { renderRecs(); const slot = main.querySelector('.op-state-slot'); if (slot) clear(slot).appendChild(opStateBadge(opId)); };
  S.leaveHooks.push(() => { S.onRecordsChanged = null; });
  main.appendChild(recCard);

  if (opId === 'I01') main.appendChild(h('section', { class: 'card', 'aria-labelledby': 'up-h' },
    h('h2', { id: 'up-h' }, 'Import a file'), uploadWidget(null)));

  main.appendChild(await createSection(op, schema));
}

function recordList(recs) {
  const ul = h('ul', { class: 'record-list' });
  for (const r of recs) {
    ul.appendChild(h('li', { class: 'record-item' },
      h('div', { class: 'r-main' },
        h('a', { class: 'r-title', href: plink('rec', r.record_id) }, recordTitle(r)),
        h('div', { class: 'r-meta' }, `${r.record_id} · v${r.version}`,
          r.approved_version ? ` · approved v${r.approved_version}` : '', ` · ${r.record_kind}`,
          r.mime_type ? ` · ${r.mime_type}` : '', ` · ${fmtTime(r.created_at)}`),
        r.stale ? h('div', { class: 'r-meta' }, '⚠︎ Stale: ', r.stale_reason || 'an input changed') : null),
      h('div', { class: 'r-badges' }, lifecycleBadge(r.lifecycle), r.stale ? staleBadge(r.stale_reason) : null)));
  }
  return ul;
}

/* ----------------------------------------------------------------------- create section */
async function createSection(op, schema) {
  const draftKey = `bf:draft:${S.pid}:${S.branch}:${op.id}:new`;
  const draft = takePrefill(draftKey) || loadJSON(draftKey, null);
  if (S.skipSaveKeys) S.skipSaveKeys.delete(draftKey);
  const card = h('section', { class: 'card', 'aria-labelledby': 'new-h' });
  let payloadNode = null;
  const aiBtn = op.assist ? h('button', { type: 'button', class: 'ai-btn', 'aria-haspopup': 'dialog',
    'aria-describedby': 'ai-btn-h', onclick: ev => openAssistPanel(op.id, ev.currentTarget) },
  h('span', { 'aria-hidden': 'true' }, '✨'), ' Fill with AI') : null;
  const pasteBtn = h('button', { type: 'button', class: 'paste-btn', title: 'Paste JSON (fills matching fields) or text (goes into the main text field)',
    onclick: () => pasteIntoForm({
      op, props: (schema.create_payload && schema.create_payload.properties) || {},
      current: () => (payloadNode ? payloadNode.get(null) : {}) || {},
      apply: (values, info) => {
        S.skipSaveKeys.add(draftKey);
        const d = { payload: values, manualOn: !!(manualToggle && manualToggle.checked), manual: manualNode ? manualNode.get(null) : undefined,
          pending: {}, saved_at: new Date().toISOString(), from_paste: info };
        S.prefill.set(draftKey, d); saveJSON(draftKey, d); route();
      },
      onGuidance: op.assist ? text => { openAssistPanel(op.id, pasteBtn); const p = AP.panels.get(`${S.pid}|${S.branch}|${op.id}`); if (p && p.setPrompt) p.setPrompt(text); } : null,
    }) }, h('span', { 'aria-hidden': 'true' }, '📥'), ' Paste');
  card.appendChild(h('div', { class: 'new-head' }, h('h2', { id: 'new-h' }, `New ${op.id} record`), pasteBtn, aiBtn,
    aiBtn ? infoTip('What does Fill with AI do?', ...TIP_ASSIST(op)) : null));
  if (aiBtn) card.appendChild(h('p', { class: 'small muted', id: 'ai-btn-h' }, 'Fill with AI: type what you want and one of your AIs fills this form for you to review. Nothing is saved until you press Create.'));
  card.appendChild(h('p', { class: 'muted small' }, 'Fields marked Required must be filled. Optional fields left empty are not sent (absent means “not supplied”).'));
  if (draft && draft.from_book) {
    card.appendChild(stateBox('draft', 'Prepared by “Make my book” — write it, then press Create',
      h('p', null, draft.from_book.message || '', ' The links to earlier steps are already filled in. ',
        h('a', { href: plink('book') }, 'Back to Make my book'))));
  } else if (draft && (draft.from_copy || draft.from_paste)) {
    const c = draft.from_copy; const pz = draft.from_paste || {};
    const skipped = (c ? c.skipped : pz.skipped) || [];
    card.appendChild(stateBox('draft', c ? `Copied from ${c.record_id} v${c.version}${c.title ? ` “${c.title}”` : ''} — please review`
      : `Pasted into the form${(pz.filled || []).length ? `: ${pz.filled.map(humanize).join(', ')}` : ''} — please review`,
    h('p', null, 'Nothing has been saved yet. Check the fields, change anything you like, then press Create. ',
      c && c.manual ? 'The complete copied record is also in “Manual candidate” below (tick it to use it as-is). ' : '',
      skipped.length ? `Skipped (not fields of this form): ${skipped.join(', ')}. ` : '',
      h('button', { type: 'button', class: 'link', onclick: () => {
        if (confirm('Clear the form?')) { removeKey(draftKey); route(); }
      } }, 'Clear the form'))));
  } else if (draft && draft.from_ai) {
    card.appendChild(stateBox('draft', `Filled by AI (${draft.from_ai.label || draft.from_ai.slot || 'AI'}) — please review`,
      h('p', null, 'Check every field below and change anything you like, then press Create. Nothing has been saved yet. ',
        h('button', { type: 'button', class: 'link', onclick: () => {
          if (confirm('Clear the AI proposal from this form?')) { removeKey(draftKey); route(); }
        } }, 'Clear the form'))));
  } else if (draft) {
    card.appendChild(stateBox('draft', `Restored your unsaved draft from ${fmtTime(draft.saved_at)}`,
      h('p', null, 'Nothing has been submitted yet. ', h('button', { type: 'button', class: 'link', onclick: () => {
        if (confirm('Discard this unsaved draft? This cannot be undone.')) { removeKey(draftKey); route(); }
      } }, 'Discard draft'))));
  }
  const ctx = new FormCtx('new', schema.bindings);
  const formEl = h('form', { novalidate: true });
  const summary = h('div');
  formEl.appendChild(summary);
  payloadNode = buildNode(schema.create_payload, draft ? draft.payload : undefined, '/payload', '', true, ctx, 0, { root: true });
  formEl.appendChild(payloadNode.el);
  // The Fill-with-AI panel reads what is already typed ("Keep what I already typed").
  S.assistForms[`${S.pid}|${S.branch}|${op.id}`] = () => payloadNode.get(null) || {};
  S.leaveHooks.push(() => { delete S.assistForms[`${S.pid}|${S.branch}|${op.id}`]; });

  // Manual candidate (AI / HYBRID operations)
  let manualNode = null; let manualToggle = null; const manualWrap = h('div');
  const mctx = new FormCtx('manual', []);
  if (isCreative(op)) {
    const tid = uid('manual');
    manualToggle = h('input', { type: 'checkbox', id: tid, checked: !!(draft && draft.manualOn), 'aria-controls': tid + '-body', 'aria-describedby': tid + '-h' });
    const body = h('div', { id: tid + '-body', hidden: !(draft && draft.manualOn) });
    manualNode = buildNode(schema.output, draft ? draft.manual : undefined, '/manual_candidate', '', true, mctx, 0, { root: true });
    body.appendChild(manualNode.el);
    manualToggle.addEventListener('change', () => { body.hidden = !manualToggle.checked; });
    manualWrap.appendChild(h('fieldset', { class: 'field' }, h('legend', null, 'Manual candidate'),
      h('div', { class: 'check-row' }, manualToggle, h('label', { for: tid }, 'Write the output myself (manual candidate)')),
      h('span', { class: 'hint', id: tid + '-h' }, 'Use this when no AI slot is connected or you want to supply your own text. The output form below is sent as manual_candidate and validated against the operation’s output schema. Nothing is sent to any AI provider in manual mode.'),
      body));
    formEl.appendChild(manualWrap);
  }

  const draftState = h('span', { class: 'draft-state', role: 'status' }, draft ? 'Draft restored' : '');
  const submitBtn = h('button', { type: 'submit', class: 'primary' }, 'Create');
  const panel = h('div', { class: 'result-holder' });
  formEl.appendChild(h('div', { class: 'form-actions' }, submitBtn, draftState));
  formEl.appendChild(panel);
  card.appendChild(formEl);

  const keyStore = (draft && draft.pending) || {};
  const collect = () => ({ payload: payloadNode.get(null), manualOn: !!(manualToggle && manualToggle.checked),
    manual: manualNode ? manualNode.get(null) : undefined, pending: keyStore, saved_at: new Date().toISOString() });
  const autosave = attachAutosave(formEl, draftKey, collect, draftState);

  formEl.addEventListener('submit', async ev => {
    ev.preventDefault();
    const errs = [];
    const payload = payloadNode.get(errs) || {};
    const useManual = !!(manualToggle && manualToggle.checked);
    const manual = useManual ? (manualNode.get(errs) || {}) : undefined;
    ctx.clearErrors(); mctx.clearErrors(); clear(summary);
    if (errs.length) { showFormErrors(errs, [ctx, mctx], summary); autosave.flush(); return; }
    await runDispatch({
      op, action: 'CREATE', payload, baseRef: null, manual, panel, keyStore, button: submitBtn,
      forms: [ctx, mctx], summary, schema,
      onManual: manualToggle ? () => { manualToggle.checked = true; manualToggle.dispatchEvent(new Event('change', { bubbles: true })); manualToggle.focus(); } : null,
      onSuccess: () => { autosave.clear(); },
      onKeep: () => autosave.flush(),
    });
  });
  return card;
}

/* ----------------------------------------------------------------------- dispatch runner */
async function runDispatch(o) {
  const { op, action, payload, baseRef, manual, panel, keyStore, button } = o;
  const sig = JSON.stringify({ op: op.id, action, payload, baseRef, manual: manual === undefined ? null : manual });
  if (keyStore.sig === sig && keyStore.retryable && keyStore.key) {
    keyStore.attempts = (keyStore.attempts || 1) + 1;
  } else {
    keyStore.sig = sig; keyStore.key = randomKey(); keyStore.attempts = 1;
  }
  keyStore.retryable = true; // until a definitive answer arrives
  if (o.onKeep) o.onKeep();
  const ctrl = new AbortController();
  clear(panel);
  const cancel = h('button', { type: 'button', onclick: () => ctrl.abort() }, 'Cancel');
  panel.appendChild(h('div', { class: 'result-panel' }, loadingState(`Sending ${action} to ${op.id} — attempt ${keyStore.attempts}`),
    h('p', { class: 'small muted' }, `Idempotency key ${keyStore.key}. `, keyStore.attempts > 1
      ? 'This is a retry of the same submission with the same key, so it cannot create a duplicate.' : ''),
    cancel));
  announce(`Sending ${action} to ${op.id}`);
  if (button) button.disabled = true;
  const body = { request: { project_id: S.pid, branch_id: S.branch, target_operation: op.id, action, payload,
    base_ref: baseRef || null, input_refs: [], idempotency_key: keyStore.key } };
  if (manual !== undefined) body.manual_candidate = manual;
  let resp = null;
  try {
    const out = await api('POST', '/dispatch', { body, signal: ctrl.signal });
    resp = out.response;
  } catch (e) {
    if (button) button.disabled = false;
    clear(panel);
    if (e && e.name === 'AbortError') {
      panel.appendChild(h('div', { class: 'result-panel' }, stateBox('failed', 'Cancelled in this browser',
        h('p', null, 'The request was cancelled before an answer arrived. The server may still have finished it. Your input is kept; submitting the same content again reuses the same idempotency key, so it will not be applied twice.'))));
      announce('Request cancelled');
    } else if (e instanceof ApiError) {
      keyStore.retryable = e.status >= 500;
      panel.appendChild(h('div', { class: 'result-panel' }, failedState(`Request refused (HTTP ${e.status})`, e)));
      if (o.forms) showFormErrors(e.errors, o.forms, o.summary);
      announce('Request refused');
    } else {
      panel.appendChild(h('div', { class: 'result-panel' }, stateBox('failed', 'No response from the server',
        h('p', null, e.message), h('p', null, 'Your input is kept. Submit again to retry safely: the same idempotency key is reused for identical content.'))));
      announce('Network failure; your input is kept');
    }
    if (o.onKeep) o.onKeep();
    return null;
  }
  if (button) button.disabled = false;
  keyStore.retryable = (resp.errors || []).some(e => e.retryable);
  const ok = ['DRAFT', 'VALIDATED', 'APPROVED', 'PARTIAL'].includes(resp.status) && !(resp.errors || []).length;
  clear(panel);
  panel.appendChild(renderResponse(resp, { op, action, forms: o.forms, onManual: o.onManual, schema: o.schema }));
  if (o.forms && (resp.errors || []).length) showFormErrors(resp.errors, o.forms, o.summary);
  if (ok && o.onSuccess) o.onSuccess(resp);
  else if (o.onKeep) o.onKeep();
  try { await refreshRecords(); } catch { /* list refresh is best effort */ }
  const head = panel.querySelector('h3'); if (head) { head.setAttribute('tabindex', '-1'); head.focus(); }
  announce(`${op.id} ${action}: ${STATUS[resp.status] ? STATUS[resp.status][1] : resp.status}`);
  return resp;
}

function responsibleLinks(path, schema) {
  if (!path) return null;
  const tmpl = ptrTemplate(path).replace(/\/(module_id|content_hash|owner|version|record_id|project_id|branch_id)$/, '');
  if (/^\/feature_manifest/.test(tmpl)) return h('a', { href: plink('manifest') }, 'Open the feature manifest');
  const b = schema && (schema.bindings || []).find(x => x.input_path === tmpl);
  if (!b) return null;
  const prods = b.allowed_producers.slice(0, 4);
  return h('span', null, 'Responsible module: ', prods.map((p, i) => [i ? ', ' : '', h('a', { href: plink('op', p) }, opLabel(p))]),
    b.allowed_producers.length > 4 ? ` and ${b.allowed_producers.length - 4} more` : '');
}

function renderResponse(resp, { op, action, forms, onManual, schema }) {
  const st = resp.status;
  const box = h('div', { class: 'result-panel', role: 'region', 'aria-label': `${op.id} ${action} result` });
  box.appendChild(h('h3', null, statusBadge(st), `${op.id} ${action}`, h('span', { class: 'small muted' }, `attempt ${resp.attempt_id || ''}`)));
  const explain = {
    DRAFT: 'Saved as a draft revision. Draft is not approval: validate and accept it to approve.',
    VALIDATED: 'Validation passed. The revision still needs Accept to become approved.',
    APPROVED: 'Approved. The exact approved revision is listed under output references.',
    BLOCKED: 'Blocked — nothing was published. Resolve the items below, then submit again.',
    REJECTED: 'Rejected — the input is invalid; nothing was published. Fix the fields listed below.',
    PARTIAL: 'Partially complete. Durable checkpoints were kept; this is not approval.',
    NOT_APPLICABLE: 'Not applicable for this branch’s feature manifest; nothing was published.',
  };
  box.appendChild(h('p', null, explain[st] || st));
  if (st === 'NOT_APPLICABLE') {
    const reason = (resp.findings || []).map(f => f.message).join(' ');
    box.appendChild(h('dl', { class: 'kv' }, h('dt', null, 'Selection rule'), h('dd', null, h('code', null, resp.selection_rule_id || '—')),
      h('dt', null, 'Reason'), h('dd', null, reason || '—')));
    box.appendChild(h('p', null, h('a', { href: plink('manifest') }, 'Change features in the feature manifest')));
  }
  const errs = resp.errors || [];
  if (errs.length) {
    box.appendChild(h('h4', null, 'Errors'));
    const ul = h('ul', { class: 'error-list' });
    for (const e of errs) {
      const fieldLink = findFieldLink(e.path, forms);
      const li = h('li', null, badge('✕', e.code, e.code === 'CAPABILITY_UNAVAILABLE' || e.code === 'APPROVAL_REQUIRED' ? 'b-warn' : 'b-bad'), ' ',
        e.path ? (fieldLink || h('code', null, e.path)) : null, ' — ', e.message, e.retryable ? ' (retryable: submit again)' : '');
      const resp2 = responsibleLinks(e.path, schema);
      if (resp2) li.appendChild(h('div', { class: 'small' }, resp2));
      if (e.code === 'CAPABILITY_UNAVAILABLE') {
        li.appendChild(h('div', { class: 'row', style: 'margin-top:6px' },
          onManual ? h('button', { type: 'button', class: 'primary small', onclick: onManual }, 'Fill in a manual candidate') : null,
          h('a', { class: 'btn small', href: '#/settings' }, 'Configure an AI slot')));
      }
      if (e.code === 'LOCKED_FACT' || e.code === 'APPROVAL_REQUIRED') {
        li.appendChild(h('div', { class: 'small' }, 'Approvals come from ', h('a', { href: plink('op', 'K09') }, 'K09 Approval Checkpoints'), ' or ',
          h('a', { href: plink('op', 'I10') }, 'I10 Canon Approval/Lock Manager'), '.'));
      }
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  const unresolved = resp.unresolved_requests || [];
  if (unresolved.length) {
    box.appendChild(h('h4', null, 'Unresolved requests'));
    box.appendChild(h('ul', null, unresolved.map(u => {
      const m = /^([A-K]\d\d):(.*)$/.exec(u);
      if (m && S.opsById[m[1]]) {
        if (m[2] === 'manual_candidate' && onManual) return h('li', null, h('code', null, u), ' — ', h('button', { type: 'button', class: 'link', onclick: onManual }, 'fill the manual candidate'));
        return h('li', null, h('code', null, u), ' — ', h('a', { href: plink('op', m[1]) }, opLabel(m[1])));
      }
      return h('li', null, h('code', null, u));
    })));
  }
  if ((resp.findings || []).length) {
    box.appendChild(h('h4', null, 'Findings'));
    box.appendChild(findingList(resp.findings));
  }
  if ((resp.output_refs || []).length) {
    box.appendChild(h('h4', null, 'Output references'));
    box.appendChild(h('ul', { class: 'ref-list' }, resp.output_refs.map(r => h('li', null, refChip(r), h('span', { class: 'small muted mono' }, shortHash(r.content_hash))))));
  }
  if ((resp.source_refs || []).length) {
    box.appendChild(h('details', null, h('summary', null, `Source references (${resp.source_refs.length})`),
      h('ul', { class: 'ref-list' }, resp.source_refs.map(r => h('li', null, refChip(r))))));
  }
  if (resp.result && typeof resp.result === 'object') {
    box.appendChild(h('details', { class: 'json' }, h('summary', null, st === 'DRAFT' ? 'Draft output preview' : 'Result'),
      h('div', { class: 'data-view' }, renderData(resp.result, '')),
      h('details', null, h('summary', null, 'JSON'), h('pre', null, JSON.stringify(resp.result, null, 2)))));
  }
  return box;
}

function findingList(findings) {
  return h('ul', { class: 'finding-list' }, findings.map(f => h('li', null,
    badge(f.severity === 'BLOCKING' ? '✕' : f.severity === 'MAJOR' ? '⚠︎' : 'ℹ︎', f.severity, SEVERITY[f.severity] || 'b-muted'), ' ',
    badge(f.decision === 'PASS' ? '✔' : f.decision === 'FAIL' ? '✕' : '?', f.decision, f.decision === 'PASS' ? 'b-ok' : f.decision === 'FAIL' ? 'b-bad' : 'b-muted'), ' ',
    h('code', null, f.rule_id), ' — ', f.message,
    (f.evidence || []).length ? h('span', { class: 'small muted' }, ` (${f.evidence.length} evidence span${f.evidence.length > 1 ? 's' : ''})`) : '',
    (f.source_refs || []).length ? h('div', { class: 'row small' }, 'Sources: ', f.source_refs.map(refChip)) : null)));
}

function refChip(ref) {
  if (!ref || typeof ref !== 'object') return h('span', null, String(ref));
  const rec = recordById(ref.record_id);
  const title = rec ? recordTitle(rec) : ref.record_id;
  const same = (!ref.project_id || ref.project_id === S.pid) && (!ref.branch_id || ref.branch_id === S.branch);
  const label = `${ref.module_id} · ${title.length > 60 ? title.slice(0, 57) + '…' : title} · v${ref.version}`;
  return h('span', { class: 'ref-chip', title: `${ref.record_id} v${ref.version} ${ref.content_hash || ''}` },
    same ? h('a', { href: recLink(ref) }, label) : h('span', null, `${label} (${ref.project_id}/${ref.branch_id})`));
}

/* ----------------------------------------------------------------------- autosave */
function attachAutosave(container, key, collect, statusEl) {
  let timer = null; let dirty = false;
  const save = () => {
    clearTimeout(timer); timer = null;
    if (S.skipSaveKeys && S.skipSaveKeys.has(key)) { dirty = false; return; }  // an AI proposal replaces this draft
    if (!dirty) return;
    const ok = saveJSON(key, collect());
    statusEl.classList.toggle('error', !ok);
    statusEl.textContent = ok ? `Draft saved ${new Date().toLocaleTimeString()}` : 'Save failed — browser storage is unavailable; keep this tab open until you submit.';
    if (ok) dirty = false;
  };
  const onEdit = () => {
    dirty = true; statusEl.classList.remove('error'); statusEl.textContent = 'Unsaved changes…';
    clearTimeout(timer); timer = setTimeout(save, 500);
  };
  container.addEventListener('input', onEdit);
  container.addEventListener('change', onEdit);
  S.leaveHooks.push(save);
  const beforeUnload = () => save();
  window.addEventListener('pagehide', beforeUnload);
  S.leaveHooks.push(() => window.removeEventListener('pagehide', beforeUnload));
  return {
    flush: () => { dirty = true; save(); },
    clear: () => { clearTimeout(timer); dirty = false; removeKey(key); statusEl.classList.remove('error'); statusEl.textContent = 'Submitted — draft cleared'; },
  };
}

/* ======================================================================= form engine */
class FormCtx {
  constructor(prefix, bindings) {
    this.prefix = prefix + '-' + (++uidCounter);
    this.fields = new Map();
    this.bindings = new Map((bindings || []).map(b => [b.input_path, b.allowed_producers]));
    this.errored = [];
  }
  id(ptr) { return `${this.prefix}${ptr.replace(/[^A-Za-z0-9]/g, '_')}`; }
  register(ptr, info) {
    this.fields.set(ptr, info);
    if (info.control && !info._clr) {
      info._clr = true;
      info.control.addEventListener('input', () => { if (this.errored.includes(info)) { this.clearOne(info); } });
    }
  }
  clearOne(f) {
    clear(f.errEl); f.errEl.hidden = true; f.wrap.classList.remove('has-error');
    if (f.control) {
      f.control.removeAttribute('aria-invalid');
      const d = (f.control.getAttribute('aria-describedby') || '').split(' ').filter(x => x && x !== f.errEl.id);
      if (d.length) f.control.setAttribute('aria-describedby', d.join(' ')); else f.control.removeAttribute('aria-describedby');
    }
    this.errored = this.errored.filter(x => x !== f);
  }
  unregisterUnder(ptr) { for (const k of [...this.fields.keys()]) if (k.startsWith(ptr + '/')) this.fields.delete(k); }
  lookup(path) {
    let p = path;
    while (p) {
      if (this.fields.has(p)) return this.fields.get(p);
      p = p.slice(0, p.lastIndexOf('/'));
    }
    return this.fields.get(path) || null;
  }
  clearErrors() {
    for (const f of this.errored) {
      clear(f.errEl); f.errEl.hidden = true; f.wrap.classList.remove('has-error');
      if (f.control) {
        f.control.removeAttribute('aria-invalid');
        const d = (f.control.getAttribute('aria-describedby') || '').split(' ').filter(x => x && x !== f.errEl.id);
        if (d.length) f.control.setAttribute('aria-describedby', d.join(' ')); else f.control.removeAttribute('aria-describedby');
      }
    }
    this.errored = [];
  }
  markError(f, msg) {
    if (!f.errEl) return;
    const code = (/\(([A-Z_]+)\)\s*$/.exec(msg) || [])[1] || 'INVALID_INPUT';
    const where = { book: (profileOf().title || (S.project || {}).name), field: f.label || f.ptr };
    f.errEl.hidden = false;
    f.errEl.appendChild(h('span', { style: 'display:block' }, hazard({ code, message: msg.replace(/\s*\([A-Z_]+\)\s*$/, ''), path: f.ptr, where }, { form: () => focusField(f) }, { small: true }), ' ', msg));
    f.wrap.classList.add('has-error');
    if (f.control) {
      f.control.setAttribute('aria-invalid', 'true');
      const d = (f.control.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
      if (!d.includes(f.errEl.id)) d.push(f.errEl.id);
      f.control.setAttribute('aria-describedby', d.join(' '));
    }
    if (!this.errored.includes(f)) this.errored.push(f);
  }
}

function locateField(path, forms) {
  if (!path || !forms) return null;
  for (const ctx of forms) {
    if (!ctx) continue;
    let f = null;
    if (path.startsWith('/payload') || path.startsWith('/manual_candidate')) f = ctx.lookup(path);
    // Older engines prefix only the first manual-candidate error path; try the manual form too.
    if (!f && !path.startsWith('/payload') && !path.startsWith('/manual_candidate') && path !== '/' && ctx.prefix.startsWith('manual')) {
      f = ctx.lookup('/manual_candidate' + path);
    }
    if (f && f.ptr !== '/payload' && f.ptr !== '/manual_candidate') return f;
    if (f) return f;
  }
  return null;
}
function findFieldLink(path, forms) {
  const f = locateField(path, forms);
  if (!f || !f.control) return null;
  return h('a', { href: '#' + f.control.id, onclick: ev => { ev.preventDefault(); focusField(f); } }, h('code', null, path));
}
function focusField(f) {
  let el = f.wrap;
  while (el) {
    if (el.hidden) {
      el.hidden = false;
      // Keep "include" / "manual candidate" toggles in sync with what is now visible.
      const t = el.id && document.querySelector(`input[type="checkbox"][aria-controls="${el.id}"]`);
      if (t && !t.checked) t.checked = true;
    }
    if (el.tagName === 'DETAILS') el.open = true;
    el = el.parentElement;
  }
  f.control.focus(); f.control.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function showFormErrors(errs, forms, summaryEl) {
  if (!errs || !errs.length) return;
  const items = [];
  for (const e of errs) {
    const f = locateField(e.path, forms);
    const ctx = f && forms.find(c => c && [...c.fields.values()].includes(f));
    if (f && ctx) ctx.markError(f, `${e.message}${e.code ? ` (${e.code})` : ''}`);
    items.push(h('li', null, f && f.control
      ? h('a', { href: '#' + f.control.id, onclick: ev => { ev.preventDefault(); focusField(f); } }, f.label || e.path)
      : h('code', null, e.path || '(request)'), ': ', e.message));
  }
  if (summaryEl) {
    clear(summaryEl).appendChild(h('div', { class: 'error-summary', role: 'alert', tabindex: '-1' },
      h('h3', null, `${errs.length} problem${errs.length > 1 ? 's' : ''} to fix`), h('ul', null, items)));
  }
}

function fieldShell(ctx, ptr, label, required, opts = {}) {
  const id = ctx.id(ptr);
  const hintId = id + '-hint'; const errId = id + '-err';
  const key = ptr.split('/').pop();
  const hintParts = [];
  if (opts.hint) hintParts.push(opts.hint);
  if (key && !/^\d+$/.test(key) && key !== 'payload' && key !== 'manual_candidate') hintParts.push(`Field ${key}`);
  const hint = hintParts.length ? h('span', { class: 'hint', id: hintId }, hintParts.join(' · ')) : null;
  const err = h('span', { class: 'field-error', id: errId, hidden: true });
  const reqTag = opts.noTag ? null : h('span', { class: `req-tag${required ? ' required' : ''}` }, required ? 'Required' : 'Optional');
  return { id, hintId: hint ? hintId : null, hint, err, reqTag };
}

function describe(control, ...ids) {
  const d = ids.filter(Boolean);
  if (d.length) control.setAttribute('aria-describedby', d.join(' '));
}

function schemaTypes(s) {
  if (!s) return [];
  if (Array.isArray(s.type)) return s.type;
  if (s.type) return [s.type];
  if (s.properties) return ['object'];
  if (s.enum) return ['enum'];
  if ('const' in s) return ['const'];
  return [];
}
function isScalarSchema(s) {
  if (!s) return false;
  if (s.type === 'array') return s.items && isScalarSchema(s.items);
  const t = schemaTypes(s);
  return t.length > 0 && t.every(x => ['string', 'number', 'integer', 'boolean', 'null'].includes(x));
}
function nullRefOneOf(s) {
  if (!Array.isArray(s.oneOf) || s.oneOf.length !== 2) return null;
  const ref = s.oneOf.find(isRefSchema); const nul = s.oneOf.find(x => x && x.type === 'null');
  return ref && nul ? ref : null;
}
function looksLikeFact(s) { return s.properties && 'subject_id' in s.properties && 'predicate' in s.properties && 'assertion_type' in s.properties; }

/**
 * Build a form node for a JSON Schema.
 * Returns {el, get(errs)} where get returns the value or undefined (omit).
 * errs (array or null) collects client-side parse problems.
 */
function buildNode(schema, value, ptr, name, required, ctx, depth, opts = {}) {
  schema = schema || {};
  const label = opts.label || humanize(name) || 'Value';
  // Reference (possibly nullable)
  const nullRef = nullRefOneOf(schema);
  if (isRefSchema(schema) || nullRef) return buildRefField(nullRef || schema, value, ptr, label, required, ctx, !!nullRef);
  if (Array.isArray(schema.oneOf)) {
    if (schema.oneOf.every(isScalarSchema)) return buildScalarAny(schema.oneOf, value, ptr, label, required, ctx);
    return buildVariant(schema, value, ptr, label, required, ctx, depth);
  }
  if ('const' in schema) return buildConst(schema, ptr, label, ctx);
  const types = schemaTypes(schema);
  const nonNull = types.filter(t => t !== 'null');
  const nullable = types.includes('null');
  if (schema.enum) return buildEnum(schema, value, ptr, label, required, ctx);
  if (nonNull.length > 1) {
    const alts = nonNull.map(t => ({ type: t })); if (nullable) alts.push({ type: 'null' });
    return buildScalarAny(alts, value, ptr, label, required, ctx);
  }
  const t = nonNull[0];
  if (t === 'string') return buildString(schema, value, ptr, name, label, required, nullable, ctx);
  if (t === 'integer' || t === 'number') return buildNumber(schema, value, ptr, label, required, nullable, ctx, t === 'integer');
  if (t === 'boolean') return buildBoolean(value, ptr, label, required, nullable, ctx);
  if (t === 'object' && schema.properties && Object.keys(schema.properties).length) return buildObject(schema, value, ptr, label, required, ctx, depth, opts);
  if (t === 'array') return buildArray(schema, value, ptr, name, label, required, ctx, depth);
  return buildJson(value, ptr, label, required, ctx, t === 'object' ? 'Free-form object as JSON' : 'JSON value');
}

function buildString(schema, value, ptr, name, label, required, nullable, ctx) {
  const sh = fieldShell(ctx, ptr, label, required, {
    hint: [schema.format === 'date-time' ? 'Date-time, RFC3339 UTC, e.g. 2026-01-31T12:00:00Z' : null,
      schema.pattern ? `Format ${schema.pattern}` : null, schema.maxLength ? `max ${schema.maxLength} characters` : null,
      nullable ? 'Leave empty for null (unknown / not applicable)' : null].filter(Boolean).join(' · ') });
  const long = LONG_TEXT.test(name || '') && !(schema.maxLength && schema.maxLength <= 200) && !/_id$/.test(name || '');
  const control = long
    ? h('textarea', { id: sh.id, rows: /^(text|prose|body|passage)$/.test(name) ? 12 : 4, class: /^(text|prose|body|passage)$/.test(name) ? 'prose' : null, spellcheck: 'true' })
    : h('input', { id: sh.id, type: 'text', autocomplete: 'off', spellcheck: 'false' });
  if (schema.maxLength) control.setAttribute('maxlength', schema.maxLength);
  if (required) control.setAttribute('aria-required', 'true');
  if (typeof value === 'string') control.value = value;
  describe(control, sh.hintId);
  const wrap = h('div', { class: 'field' + (long ? ' wide' : '') }, h('label', { for: sh.id }, label, sh.reqTag), control, sh.hint, sh.err);
  ctx.register(ptr, { ptr, wrap, control, errEl: sh.err, label });
  return { el: wrap, get: errs => {
    const v = control.value;
    if (v !== '' && v.trim() === '') {
      // only spaces/new lines: that is not a value (a blank name or title would be saved otherwise)
      if (required && !nullable) {
        if (errs) errs.push({ path: ptr, code: 'MISSING_INPUT', message: 'required: write something here (only spaces were entered)' });
        return undefined;
      }
      return nullable && required ? null : undefined;
    }
    if (v === '') return nullable ? (required ? null : undefined) : (required ? '' : undefined);
    return v;
  } };
}

function buildNumber(schema, value, ptr, label, required, nullable, ctx, integer) {
  const bounds = [schema.minimum !== undefined ? `min ${schema.minimum}` : null, schema.maximum !== undefined ? `max ${schema.maximum}` : null,
    integer ? 'whole number' : 'number', nullable ? 'leave empty for null' : null].filter(Boolean).join(' · ');
  const sh = fieldShell(ctx, ptr, label, required, { hint: bounds });
  const control = h('input', { id: sh.id, type: 'number', step: integer ? '1' : 'any', inputmode: integer ? 'numeric' : 'decimal' });
  if (schema.minimum !== undefined) control.min = schema.minimum;
  if (schema.maximum !== undefined) control.max = schema.maximum;
  if (typeof value === 'number') control.value = String(value);
  describe(control, sh.hintId);
  const wrap = h('div', { class: 'field' }, h('label', { for: sh.id }, label, sh.reqTag), control, sh.hint, sh.err);
  const info = { ptr, wrap, control, errEl: sh.err, label };
  ctx.register(ptr, info);
  return { el: wrap, get: errs => {
    const raw = control.value.trim();
    if (raw === '') {
      if (control.validity && control.validity.badInput && errs) errs.push({ path: ptr, message: 'not a valid number', code: 'INVALID_INPUT' });
      return nullable ? (required ? null : undefined) : undefined;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) {
      if (errs) errs.push({ path: ptr, message: integer ? 'must be a whole number' : 'must be a number', code: 'INVALID_INPUT' });
      return undefined;
    }
    return n;
  } };
}

function buildBoolean(value, ptr, label, required, nullable, ctx) {
  const sh = fieldShell(ctx, ptr, label, required);
  if (required && !nullable) {
    const control = h('input', { type: 'checkbox', id: sh.id, checked: value === true });
    describe(control, sh.hintId);
    const wrap = h('div', { class: 'field' }, h('div', { class: 'check-row' }, control, h('label', { for: sh.id }, label, sh.reqTag)), sh.hint, sh.err);
    ctx.register(ptr, { ptr, wrap, control, errEl: sh.err, label });
    return { el: wrap, get: () => control.checked };
  }
  const control = h('select', { id: sh.id },
    h('option', { value: '' }, nullable ? '— null (unknown) —' : '— not set —'),
    h('option', { value: 'true', selected: value === true }, 'Yes (true)'),
    h('option', { value: 'false', selected: value === false }, 'No (false)'));
  describe(control, sh.hintId);
  const wrap = h('div', { class: 'field' }, h('label', { for: sh.id }, label, sh.reqTag), control, sh.hint, sh.err);
  ctx.register(ptr, { ptr, wrap, control, errEl: sh.err, label });
  return { el: wrap, get: () => control.value === '' ? (nullable ? null : undefined) : control.value === 'true' };
}

function buildEnum(schema, value, ptr, label, required, ctx) {
  const sh = fieldShell(ctx, ptr, label, required);
  const control = h('select', { id: sh.id });
  const hasNull = schema.enum.includes(null);
  control.appendChild(h('option', { value: '' }, required ? '— choose —' : '— not set —'));
  for (const v of schema.enum) {
    control.appendChild(h('option', { value: JSON.stringify(v), selected: value !== undefined && JSON.stringify(value) === JSON.stringify(v) },
      v === null ? 'null (unknown)' : String(v)));
  }
  if (required) control.setAttribute('aria-required', 'true');
  describe(control, sh.hintId);
  const wrap = h('div', { class: 'field' }, h('label', { for: sh.id }, label, sh.reqTag), control, sh.hint, sh.err);
  ctx.register(ptr, { ptr, wrap, control, errEl: sh.err, label });
  return { el: wrap, get: () => control.value === '' ? (hasNull && required ? undefined : undefined) : JSON.parse(control.value) };
}

function buildConst(schema, ptr, label, ctx) {
  const id = ctx.id(ptr);
  const wrap = h('div', { class: 'field' }, h('span', { class: 'field-label', id }, label),
    h('code', null, JSON.stringify(schema.const)), h('span', { class: 'hint' }, 'Fixed value'));
  ctx.register(ptr, { ptr, wrap, control: null, errEl: null, label });
  return { el: wrap, get: () => schema.const };
}

function buildJson(value, ptr, label, required, ctx, hintText) {
  const sh = fieldShell(ctx, ptr, label, required, { hint: hintText });
  const control = h('textarea', { id: sh.id, rows: 4, class: 'mono', spellcheck: 'false' });
  if (value !== undefined) control.value = JSON.stringify(value, null, 2);
  describe(control, sh.hintId);
  const wrap = h('div', { class: 'field' }, h('label', { for: sh.id }, label, sh.reqTag), control, sh.hint, sh.err);
  ctx.register(ptr, { ptr, wrap, control, errEl: sh.err, label });
  return { el: wrap, get: errs => {
    const raw = control.value.trim();
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch {
      if (errs) errs.push({ path: ptr, message: 'is not valid JSON', code: 'INVALID_INPUT' });
      return undefined;
    }
  } };
}

/** Value for SemanticRecord facts and other scalar-or-list unions. */
function buildScalarAny(alts, value, ptr, label, required, ctx) {
  const kinds = [];
  for (const a of alts) {
    const ts = a.type === 'array' ? ['list'] : schemaTypes(a);
    for (const t of ts) {
      const k = t === 'integer' ? 'number' : t;
      if (!kinds.includes(k)) kinds.push(k);
    }
  }
  const names = { string: 'Text', number: 'Number', boolean: 'True / false', null: 'Null (unknown)', list: 'List' };
  const sh = fieldShell(ctx, ptr, label, required, { hint: 'Choose the value type, then enter the value. List: one item per line.' });
  const typeSel = h('select', { id: sh.id + '-type', 'aria-label': `${label}: value type` });
  for (const k of kinds) typeSel.appendChild(h('option', { value: k }, names[k] || k));
  let initKind = 'string';
  if (value === null) initKind = 'null'; else if (Array.isArray(value)) initKind = 'list';
  else if (typeof value === 'number') initKind = 'number'; else if (typeof value === 'boolean') initKind = 'boolean';
  if (!kinds.includes(initKind)) initKind = kinds[0];
  typeSel.value = initKind;
  const slot = h('div');
  let control = null;
  const render = (k, v) => {
    clear(slot);
    if (k === 'string') control = h('input', { id: sh.id, type: 'text', value: typeof v === 'string' ? v : '' });
    else if (k === 'number') control = h('input', { id: sh.id, type: 'number', step: 'any', value: typeof v === 'number' ? String(v) : '' });
    else if (k === 'boolean') control = h('select', { id: sh.id }, h('option', { value: 'true', selected: v === true }, 'true'), h('option', { value: 'false', selected: v === false }, 'false'));
    else if (k === 'list') {
      control = h('textarea', { id: sh.id, rows: 3 });
      if (Array.isArray(v)) control.value = v.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n');
    } else control = h('input', { id: sh.id, type: 'text', value: 'null', readonly: true });
    describe(control, sh.hintId);
    info.control = control;
    slot.appendChild(control);
  };
  const wrap = h('div', { class: 'field' }, h('label', { for: sh.id }, label, sh.reqTag), h('div', { class: 'scalar-any' }, typeSel, slot), sh.hint, sh.err);
  const info = { ptr, wrap, control: null, errEl: sh.err, label };
  render(initKind, value);
  typeSel.addEventListener('change', () => render(typeSel.value, undefined));
  ctx.register(ptr, info);
  return { el: wrap, get: errs => {
    const k = typeSel.value;
    if (k === 'null') return null;
    if (k === 'string') return control.value === '' && !required ? undefined : control.value;
    if (k === 'boolean') return control.value === 'true';
    if (k === 'number') {
      if (control.value.trim() === '') return required ? undefined : undefined;
      const n = Number(control.value); if (!Number.isFinite(n)) { if (errs) errs.push({ path: ptr, message: 'must be a number' }); return undefined; }
      return n;
    }
    return control.value.split('\n').map(s => s.trim()).filter(Boolean).map(s => {
      if (/^(-?\d+(\.\d+)?|true|false|null)$/.test(s)) return JSON.parse(s);
      if (/^".*"$/.test(s)) { try { return JSON.parse(s); } catch { return s; } }
      return s;
    });
  } };
}

function variantName(v, i) {
  if (v.title) return v.title;
  if (v.properties) {
    for (const [k, p] of Object.entries(v.properties)) if (p && 'const' in p) return `${k} = ${p.const}`;
    return `Object (${Object.keys(v.properties).slice(0, 3).join(', ')}…)`;
  }
  return schemaTypes(v).join('/') || `Option ${i + 1}`;
}
function variantMatches(v, value) {
  if (value === null) return schemaTypes(v).includes('null');
  if (value === undefined) return false;
  if (v.properties && value && typeof value === 'object') {
    for (const [k, p] of Object.entries(v.properties)) if (p && 'const' in p && value[k] !== p.const) return false;
    return true;
  }
  return false;
}
function buildVariant(schema, value, ptr, label, required, ctx, depth) {
  const sh = fieldShell(ctx, ptr, label, required, { hint: 'Choose which form of this field to fill' });
  const sel = h('select', { id: sh.id });
  if (!required) sel.appendChild(h('option', { value: '' }, '— not set —'));
  schema.oneOf.forEach((v, i) => sel.appendChild(h('option', { value: String(i) }, variantName(v, i))));
  let idx = schema.oneOf.findIndex(v => variantMatches(v, value));
  if (idx < 0 && required) idx = 0;
  sel.value = idx < 0 ? '' : String(idx);
  const body = h('div');
  let node = null;
  const render = (v) => {
    clear(body); ctx.unregisterUnder(ptr); node = null;
    if (sel.value === '') return;
    const sub = schema.oneOf[+sel.value];
    if (sub.type === 'null') return;
    node = buildNode(sub, v, ptr, '', true, ctx, depth + 1, { label: variantName(sub, +sel.value), nested: true });
    body.appendChild(node.el);
    ctx.register(ptr, info);
  };
  describe(sel, sh.hintId);
  const wrap = h('fieldset', { class: 'field' }, h('legend', null, label, sh.reqTag), h('label', { for: sh.id, class: 'visually-hidden' }, `${label} form`), sel, sh.hint, sh.err, body);
  const info = { ptr, wrap, control: sel, errEl: sh.err, label };
  sel.addEventListener('change', () => render(undefined));
  render(value);
  ctx.register(ptr, info);
  return { el: wrap, get: errs => {
    if (sel.value === '') return undefined;
    const sub = schema.oneOf[+sel.value];
    if (sub.type === 'null') return null;
    return node ? node.get(errs) : undefined;
  } };
}

function buildObject(schema, value, ptr, label, required, ctx, depth, opts) {
  const props = schema.properties || {};
  const req = new Set(schema.required || []);
  const id = ctx.id(ptr);
  const err = h('span', { class: 'field-error', id: id + '-err', hidden: true });
  const body = h('div', { class: looksLikeFact(schema) ? 'fact-grid' : null, id: id + '-body' });
  const children = [];
  for (const [k, sub] of Object.entries(props)) {
    const node = buildNode(sub, value && typeof value === 'object' ? value[k] : undefined, `${ptr}/${k}`, k, req.has(k), ctx, depth + 1);
    if (looksLikeFact(schema) && ['value', 'source_refs', 'summary'].includes(k)) node.el.classList.add('wide');
    children.push([k, node]); body.appendChild(node.el);
  }
  if (opts.root || opts.bare) {
    const wrap = h('div', { class: 'object-root' }, err, body);
    ctx.register(ptr, { ptr, wrap, control: null, errEl: err, label });
    return { el: wrap, get: errs => collectObject(children, errs) };
  }
  const optionalToggle = !required && depth > 0;
  let include = null;
  const legend = h('legend', { id: id + '-legend' }, label, h('span', { class: `req-tag${required ? ' required' : ''}` }, required ? 'Required' : 'Optional'));
  const wrap = h('fieldset', { class: 'field', 'aria-describedby': id + '-err' }, legend);
  if (optionalToggle) {
    include = h('input', { type: 'checkbox', id: id + '-inc', 'aria-controls': id + '-body', checked: value !== undefined && value !== null });
    wrap.appendChild(h('div', { class: 'check-row' }, include, h('label', { for: id + '-inc' }, `Provide ${label.toLowerCase()}`)));
    body.hidden = !include.checked;
    include.addEventListener('change', () => { body.hidden = !include.checked; });
  }
  wrap.appendChild(err); wrap.appendChild(body);
  ctx.register(ptr, { ptr, wrap, control: include || firstFocusable(body), errEl: err, label });
  return { el: wrap, get: errs => {
    if (include && !include.checked) return undefined;
    return collectObject(children, errs);
  } };
}
function firstFocusable(el) { return el.querySelector('input, select, textarea, button'); }
function collectObject(children, errs) {
  const out = {};
  for (const [k, node] of children) { const v = node.get(errs); if (v !== undefined) out[k] = v; }
  return out;
}

function buildArray(schema, value, ptr, name, label, required, ctx, depth) {
  const items = schema.items || {};
  if (isRefSchema(items)) return buildRefArray(items, value, ptr, label, required, ctx);
  const id = ctx.id(ptr);
  const err = h('span', { class: 'field-error', id: id + '-err', hidden: true });
  const reqTag = h('span', { class: `req-tag${required ? ' required' : ''}` }, required ? 'Required' : 'Optional');
  const hintTxt = [schema.minItems ? `at least ${schema.minItems}` : null, schema.maxItems ? `at most ${schema.maxItems}` : null].filter(Boolean).join(', ');
  // enum items -> checkbox group
  if (items.enum && items.enum.length <= 40) {
    const boxes = items.enum.map((v, i) => {
      const cid = `${id}-o${i}`;
      return { v, el: h('input', { type: 'checkbox', id: cid, checked: Array.isArray(value) && value.includes(v) }), cid };
    });
    const wrap = h('fieldset', { class: 'field', 'aria-describedby': id + '-err' }, h('legend', null, label, reqTag),
      hintTxt ? h('span', { class: 'hint' }, hintTxt) : null, err,
      h('div', { class: 'check-grid' }, boxes.map(b => h('div', { class: 'check-row' }, b.el, h('label', { for: b.cid }, String(b.v))))));
    ctx.register(ptr, { ptr, wrap, control: boxes[0] && boxes[0].el, errEl: err, label });
    return { el: wrap, get: () => {
      const vals = boxes.filter(b => b.el.checked).map(b => b.v);
      return vals.length || required ? vals : undefined;
    } };
  }
  const scalar = isScalarSchema(items) && items.type !== 'array';
  const list = h('ul', { class: 'array-items' });
  const nodes = [];
  const singular = humanize((name || 'item').replace(/ies$/, 'y').replace(/s$/, '').replace(/_refs?$/, ''));
  const addBtn = h('button', { type: 'button', class: 'small' }, `+ Add ${singular.toLowerCase()}`);
  const wrap = h('fieldset', { class: 'field', 'aria-describedby': id + '-err' }, h('legend', null, label, reqTag),
    hintTxt ? h('span', { class: 'hint' }, hintTxt) : null, err, list, addBtn);
  const info = { ptr, wrap, control: addBtn, errEl: err, label };
  const rebuild = (vals) => {
    clear(list); nodes.length = 0; ctx.unregisterUnder(ptr);
    vals.forEach((v, i) => addItem(v, i, false));
    ctx.register(ptr, info);
  };
  const addItem = (v, i, focus) => {
    const iptr = `${ptr}/${i}`;
    const node = buildNode(items, v, iptr, '', true, ctx, depth + 1, { label: `${singular} ${i + 1}`, bare: !scalar });
    nodes.push(node);
    const rm = h('button', { type: 'button', class: 'small', 'aria-label': `Remove ${singular.toLowerCase()} ${i + 1}`, onclick: () => {
      const vals = nodes.map(n => n.get(null)); vals.splice(i, 1); rebuild(vals);
      list.dispatchEvent(new Event('change', { bubbles: true }));
      (list.querySelector('button') || addBtn).focus();
    } }, 'Remove');
    let li;
    if (scalar) li = h('li', { class: 'array-item' }, h('div', { class: 'array-body' }, node.el), rm);
    else li = h('li', { class: 'array-item object-item' }, h('div', { class: 'item-head' }, h('strong', null, `${singular} ${i + 1}`), rm), h('div', { class: 'array-body' }, node.el));
    list.appendChild(li);
    if (focus) { const f = firstFocusable(node.el); if (f) f.focus(); }
  };
  addBtn.addEventListener('click', () => { addItem(undefined, nodes.length, true); list.dispatchEvent(new Event('change', { bubbles: true })); });
  rebuild(Array.isArray(value) ? value : []);
  return { el: wrap, get: errs => {
    const vals = [];
    for (const n of nodes) { const v = n.get(errs); if (v !== undefined && !(scalar && v === '')) vals.push(v); }
    return vals.length || required ? vals : undefined;
  } };
}

/* ----------------------------------------------------------------------- reference picker */
function allowedModules(refSchema, ptr, ctx) {
  const bound = ctx.bindings.get(ptrTemplate(ptr));
  if (bound && bound.length) return { list: bound, source: 'binding' };
  const en = refSchema.properties.module_id && refSchema.properties.module_id.enum;
  if (en && en.length < S.ops.length) return { list: en, source: 'schema' };
  return { list: null, source: 'all' };
}
function candidateRecords(allowed) {
  return S.records.filter(r => (r.record_kind === 'OUTPUT' || r.record_kind === 'IMPORT' || r.representation === 'BINARY_ARTIFACT' || !allowed)
    && (!allowed || allowed.includes(r.module_id)));
}
function refKey(ref) { return `${ref.record_id}@${ref.version}`; }

async function approvedRef(r) {
  if (!r.approved_version || r.approved_version === r.version) return null;
  try {
    const d = await recordDetail(r.record_id);
    const v = d.versions.find(x => x.version === r.approved_version);
    return v ? v.ref : null;
  } catch { return null; }
}

/** Populates a <select> with eligible records; returns map key -> ref. */
function fillRefSelect(select, allowed, { nullable, required, current }) {
  const map = new Map();
  clear(select);
  if (nullable) select.appendChild(h('option', { value: '__null' }, '— none (null) —'));
  select.appendChild(h('option', { value: '' }, required && !nullable ? '— choose a record —' : '— not set —'));
  const recs = candidateRecords(allowed.list);
  const groups = new Map();
  for (const r of recs) { if (!groups.has(r.module_id)) groups.set(r.module_id, []); groups.get(r.module_id).push(r); }
  const pending = [];
  for (const [mod, rs] of groups) {
    const og = h('optgroup', { label: opLabel(mod) });
    for (const r of rs) {
      // Approved versions are preferred: list them first when they differ from the latest draft.
      if (r.approved_version && r.approved_version !== r.version) {
        const opt = h('option', { value: `${r.record_id}@${r.approved_version}`, disabled: true }, `${recordTitle(r)} — v${r.approved_version} ✔ approved (loading…)`);
        og.appendChild(opt);
        pending.push(approvedRef(r).then(ref => {
          if (ref) { map.set(refKey(ref), ref); opt.disabled = false; opt.textContent = `${recordTitle(r)} — v${ref.version} ✔ approved (recommended)`; }
          else opt.remove();
        }));
      }
      const lc = LIFECYCLE[r.lifecycle] ? LIFECYCLE[r.lifecycle][1] : r.lifecycle;
      const tag = r.approved_version === r.version ? '✔ approved (recommended)' : `${lc}${r.stale ? ', ⚠ stale' : ''}`;
      map.set(refKey(r.ref), r.ref);
      og.appendChild(h('option', { value: refKey(r.ref) }, `${recordTitle(r)} — v${r.version} ${tag}`));
    }
    select.appendChild(og);
  }
  if (current && isRefValue(current) && !map.has(refKey(current))) {
    map.set(refKey(current), current);
    select.appendChild(h('option', { value: refKey(current) }, `${current.module_id} ${current.record_id} — v${current.version} (current pin)`));
  }
  if (current === null && nullable) select.value = '__null';
  else if (current && isRefValue(current)) select.value = refKey(current);
  else select.value = '';
  Promise.all(pending).then(() => {
    if (current && isRefValue(current) && map.has(refKey(current))) select.value = refKey(current);
  });
  return { map, count: recs.length };
}

function producerHelp(allowed) {
  if (!allowed.list) return null;
  const ops = allowed.list.slice(0, 5);
  return h('span', null, 'Create one in ', ops.map((p, i) => [i ? ', ' : '', h('a', { href: plink('op', p) }, opLabel(p))]),
    allowed.list.length > 5 ? ` or ${allowed.list.length - 5} other modules` : '', '.');
}

function buildRefField(refSchema, value, ptr, label, required, ctx, nullable) {
  const allowed = allowedModules(refSchema, ptr, ctx);
  const sh = fieldShell(ctx, ptr, label, required, { hint: allowed.list
    ? `Accepts records from ${allowed.list.length > 6 ? allowed.list.slice(0, 6).join(', ') + ' …' : allowed.list.join(', ')}`
    : 'Accepts any record in this branch' });
  const select = h('select', { id: sh.id });
  if (required) select.setAttribute('aria-required', 'true');
  describe(select, sh.hintId);
  let filled = fillRefSelect(select, allowed, { nullable, required, current: value });
  const openLink = h('a', { class: 'small', href: '#' }, 'Open selected');
  const updateOpen = () => {
    const ref = filled.map.get(select.value);
    openLink.hidden = !ref; if (ref) openLink.href = recLink(ref);
  };
  select.addEventListener('change', updateOpen);
  const emptyNote = h('div', { class: 'small muted' });
  const refreshEmpty = () => { clear(emptyNote); if (!filled.count) emptyNote.append('No eligible records yet. ', producerHelp(allowed) || ''); };
  refreshEmpty();
  const extra = [];
  if (!allowed.list || allowed.list.includes('I01')) {
    extra.push(h('details', { class: 'small' }, h('summary', null, 'Upload a file for this field'), uploadWidget(async res => {
      filled = fillRefSelect(select, allowed, { nullable, required, current: res.ref });
      select.value = refKey(res.ref); updateOpen(); refreshEmpty();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })));
  }
  const wrap = h('div', { class: 'field' }, h('label', { for: sh.id }, label, sh.reqTag),
    h('div', { class: 'ref-picker' }, h('div', { class: 'ref-choice' }, select, openLink), emptyNote, extra), sh.hint, sh.err);
  updateOpen();
  ctx.register(ptr, { ptr, wrap, control: select, errEl: sh.err, label });
  return { el: wrap, get: () => {
    if (select.value === '__null') return null;
    if (select.value === '') return nullable && required ? null : undefined;
    return filled.map.get(select.value);
  } };
}

function buildRefArray(refSchema, value, ptr, label, required, ctx) {
  const allowed = allowedModules(refSchema, ptr, ctx);
  const sh = fieldShell(ctx, ptr, label, required, { hint: allowed.list
    ? `Accepts records from ${allowed.list.length > 6 ? allowed.list.slice(0, 6).join(', ') + ' …' : allowed.list.join(', ')}`
    : 'Accepts any record in this branch' });
  const chosen = Array.isArray(value) ? value.filter(isRefValue) : [];
  const listEl = h('ul', { class: 'ref-list' });
  const select = h('select', { id: sh.id, 'aria-label': `${label}: record to add` });
  describe(select, sh.hintId);
  let filled = fillRefSelect(select, allowed, { nullable: false, required: false, current: undefined });
  const addBtn = h('button', { type: 'button', class: 'small' }, 'Add');
  const renderList = () => {
    clear(listEl);
    if (!chosen.length) listEl.appendChild(h('li', { class: 'small muted' }, 'None selected (sent as an empty list when required).'));
    chosen.forEach((ref, i) => listEl.appendChild(h('li', null, refChip(ref),
      h('button', { type: 'button', class: 'small', 'aria-label': `Remove ${ref.record_id} v${ref.version}`, onclick: () => {
        chosen.splice(i, 1); renderList(); listEl.dispatchEvent(new Event('change', { bubbles: true })); select.focus();
      } }, 'Remove'))));
  };
  addBtn.addEventListener('click', () => {
    const ref = filled.map.get(select.value);
    if (!ref) { select.focus(); return; }
    if (!chosen.some(c => refKey(c) === refKey(ref))) chosen.push(ref);
    renderList(); listEl.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const emptyNote = h('div', { class: 'small muted' });
  if (!filled.count) emptyNote.append('No eligible records yet. ', producerHelp(allowed) || '');
  const extra = [];
  if (!allowed.list || allowed.list.includes('I01')) {
    extra.push(h('details', { class: 'small' }, h('summary', null, 'Upload a file and add it'), uploadWidget(async res => {
      filled = fillRefSelect(select, allowed, { nullable: false, required: false, current: undefined });
      chosen.push(res.ref); renderList(); clear(emptyNote);
      listEl.dispatchEvent(new Event('change', { bubbles: true }));
    })));
  }
  renderList();
  const wrap = h('fieldset', { class: 'field', 'aria-describedby': sh.err.id }, h('legend', null, label, sh.reqTag), sh.err,
    h('div', { class: 'ref-picker' }, listEl, h('div', { class: 'ref-choice', style: 'margin-top:8px' }, select, addBtn), emptyNote, extra), sh.hint);
  ctx.register(ptr, { ptr, wrap, control: select, errEl: sh.err, label });
  return { el: wrap, get: () => (chosen.length || required ? chosen.slice() : undefined) };
}

/* ----------------------------------------------------------------------- upload */
function uploadWidget(onDone) {
  const id = uid('upload');
  const input = h('input', { type: 'file', id, 'aria-describedby': id + '-h' });
  const out = h('div', { role: 'status' });
  const btn = h('button', { type: 'button', class: 'small' }, 'Upload');
  btn.addEventListener('click', async () => {
    const f = input.files && input.files[0];
    clear(out);
    if (!f) { out.appendChild(h('span', { class: 'field-error' }, 'Choose a file first.')); input.focus(); return; }
    btn.disabled = true;
    out.appendChild(h('span', null, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` Uploading ${f.name}…`));
    try {
      const buf = await f.arrayBuffer();
      const safeName = /^[\x20-\x7E]*$/.test(f.name) ? f.name : encodeURIComponent(f.name);
      const res = await api('POST', bpath('/uploads'), { raw: buf, headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': safeName } });
      S.uploadLabels[res.ref.record_id] = `${f.name} (${res.mime_type})`;
      await refreshRecords();
      clear(out).append('Uploaded ', h('a', { href: recLink(res.ref) }, `${f.name} → ${res.ref.record_id} v${res.ref.version}`), ` (${res.mime_type}, ${res.byte_length} bytes).`);
      announce(`Uploaded ${f.name}`);
      if (onDone) await onDone(res);
    } catch (e) {
      clear(out).appendChild(failedState('Upload failed', e));
    } finally { btn.disabled = false; }
  });
  return h('div', { class: 'stack' },
    h('div', { class: 'field' }, h('label', { for: id }, 'File'), input,
      h('span', { class: 'hint', id: id + '-h' }, 'Stored locally as an I01 import record (exact bytes, versioned, with provenance). Imported content is treated as data only.')),
    h('div', { class: 'row' }, btn), out);
}

/* ======================================================================= views: record */
async function viewRecord(main, rid, ver) {
  const d = await recordDetail(rid, true);
  const versions = d.versions;
  if (!versions.length) throw new Error('Record has no versions');
  const latest = versions[versions.length - 1];
  const cur = versions.find(v => v.version === ver) || latest;
  const op = S.opsById[cur.module_id] || { id: cur.module_id, name: '', set: cur.module_id[0], execution: '' };
  const setName = SETS[op.set] ? setInfo(op.set).name : '';
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [S.project.name, plink()], [`${op.set} · ${setName}`, plink('set', op.set)],
      [`${op.id} ${op.name}`, plink('op', op.id)], `${rid} v${cur.version}`),
    h('h1', { class: 'wrap-anywhere' }, recordTitle(cur))),
  h('div', { class: 'row' }, lifecycleBadge(cur.lifecycle), cur.stale ? staleBadge(cur.stale_reason) : null, badge('#', `v${cur.version} of ${latest.version}`, 'b-muted'))));

  // Versions
  main.appendChild(h('nav', { class: 'card', 'aria-label': 'Version history' }, h('h2', null, 'Version history'),
    h('ul', { class: 'version-list' }, versions.map(v => h('li', null, h('a', { href: plink('rec', rid, String(v.version)), 'aria-current': v.version === cur.version ? 'true' : null },
      `v${v.version}`, h('span', { class: 'small' }, `${LIFECYCLE[v.lifecycle] ? LIFECYCLE[v.lifecycle][0] : ''} ${LIFECYCLE[v.lifecycle] ? LIFECYCLE[v.lifecycle][1] : v.lifecycle}`),
      v.stale ? h('span', { class: 'small' }, '⚠︎ stale') : null))))));

  // State explanations
  if (cur.version !== latest.version) main.appendChild(stateBox('draft', `You are viewing historical revision v${cur.version}`,
    h('p', null, 'Revisions are immutable. ', h('a', { href: plink('rec', rid, String(latest.version)) }, `Go to the latest revision v${latest.version}`), '.')));
  if (cur.stale) main.appendChild(stateBox('stale', 'This revision is stale',
    h('p', null, cur.stale_reason || 'An input it was built from has changed.'),
    h('p', null, 'Its pinned inputs no longer match the current approved versions. Validation will report it as blocking; create a replacement (Edit) against the current approved inputs.')));
  if (cur.lifecycle === 'APPROVED' || cur.lifecycle === 'LOCKED') main.appendChild(stateBox('ok', `Approved revision v${cur.version}`,
    h('p', { class: 'wrap-anywhere' }, `Record ${cur.record_id} v${cur.version}, content hash `, h('code', null, cur.ref.content_hash),
      cur.approval_ids && cur.approval_ids.length ? ` · approval ${cur.approval_ids.join(', ')}` : '')));
  else if (cur.approved_version && cur.approved_version !== cur.version) main.appendChild(h('p', { class: 'notice' },
    `The approved head of this record is v${cur.approved_version}. `, h('a', { href: plink('rec', rid, String(cur.approved_version)) }, 'View approved revision'), '.'));

  // Actions
  let panel = h('div');
  if (S.flash && S.flash.rid === rid) { panel = S.flash.el; }
  S.flash = null;
  if (S.opsById[op.id]) await getSchema(op.id);
  const actions = h('section', { class: 'card', 'aria-labelledby': 'act-h' }, h('h2', { id: 'act-h' }, 'Actions'));
  const isLatest = cur.version === latest.version;
  const keyStores = { VALIDATE: {}, ACCEPT: {}, READ: {} };
  const rerender = async resp => {
    if (!resp) return;
    S.details[rid] = null;
    S.flash = { rid, el: panel };
    await route();
    const head = panel.querySelector('h3'); if (head) { head.setAttribute('tabindex', '-1'); head.focus(); }
  };
  const doAction = async (action, payload, btn) => {
    const resp = await runDispatch({ op, action, payload, baseRef: cur.ref, manual: undefined, panel, keyStore: keyStores[action], button: btn,
      schema: S.schemas[op.id], forms: null });
    if (action !== 'READ') await rerender(resp);
  };
  const row = h('div', { class: 'row' });
  if (isLatest && S.opsById[op.id]) {
    const vBtn = h('button', { type: 'button' }, '✓ Validate');
    vBtn.addEventListener('click', () => doAction('VALIDATE', { candidate_ref: cur.ref }, vBtn));
    row.appendChild(vBtn);
    if (cur.record_kind === 'OUTPUT') row.appendChild(h('a', { class: 'btn', href: plink('edit', rid) }, '✎ Edit (new revision)'));
  }
  if (S.opsById[op.id]) {
    const rBtn = h('button', { type: 'button' }, 'Read (audited)');
    rBtn.addEventListener('click', () => doAction('READ', {}, rBtn));
    row.appendChild(rBtn);
  }
  actions.appendChild(row);
  const isJson = !(cur.representation === 'BINARY_ARTIFACT' || cur.binary);
  actions.appendChild(h('div', { class: 'row copy-row', role: 'group', 'aria-label': 'Copy and duplicate' },
    isJson ? h('button', { type: 'button', onclick: () => copyText(recordText(cur, op), 'Copied the record as text') }, '📋 Copy text') : null,
    isJson ? h('button', { type: 'button', onclick: () => copyText(JSON.stringify(cur.data, null, 2), 'Copied the record data as JSON') }, '📋 Copy JSON') : null,
    h('button', { type: 'button', onclick: () => copyText(`${cur.record_id} v${cur.version} ${cur.ref.content_hash}`, 'Copied the record ID') }, '📋 Copy ID'),
    isJson && S.opsById[op.id] && cur.record_kind === 'OUTPUT'
      ? h('button', { type: 'button', title: 'Opens the New form for this module filled with this record’s data; you review it and press Create.',
        onclick: () => duplicateRecord(cur, op).catch(e => toast(`Could not duplicate: ${(e && e.message) || e}`)) }, '⧉ Duplicate as new draft') : null));
  if (isLatest && S.opsById[op.id] && !['APPROVED', 'LOCKED', 'SUPERSEDED', 'REJECTED'].includes(cur.lifecycle)) {
    const actx = new FormCtx('accept', [{ input_path: '/payload/approval_ref', allowed_producers: ['K09', 'I10'] }]);
    const apNode = buildRefField({ properties: Object.fromEntries(REF_KEYS.map(k => [k, {}])) }, undefined, '/payload/approval_ref', 'Approval record (optional)', false, actx, false);
    const aBtn = h('button', { type: 'submit', class: 'primary' }, '✔ Accept (approve this revision)');
    const asum = h('div');
    actions.appendChild(h('form', { novalidate: true, style: 'margin-top:12px', onsubmit: ev => {
      ev.preventDefault(); actx.clearErrors(); clear(asum);
      const ap = apNode.get(null);
      const payload = { candidate_ref: cur.ref }; if (ap) payload.approval_ref = ap;
      runDispatch({ op, action: 'ACCEPT', payload, baseRef: cur.ref, manual: undefined, panel, keyStore: keyStores.ACCEPT, button: aBtn,
        schema: S.schemas[op.id], forms: [actx], summary: asum }).then(resp => {
        if (resp && !(resp.errors || []).length) rerender(resp);
      });
    } }, h('h3', null, 'Accept'),
    h('p', { class: 'small muted' }, 'Accept re-runs validation and, if nothing blocks, approves exactly this revision (v', String(cur.version), '). Some operations need an explicit approval record from K09 Approval Checkpoints or I10 Canon Approval/Lock Manager.'),
    asum, apNode.el, h('div', { class: 'form-actions' }, aBtn)));
  }
  actions.appendChild(panel);
  main.appendChild(actions);
  if (isLatest && S.opsById[op.id] && ['DRAFT', 'VALIDATED'].includes(cur.lifecycle) && cur.record_kind === 'OUTPUT') {
    main.appendChild(recordReviewCard(cur));
  }

  // Content
  const content = h('section', { class: 'card', 'aria-labelledby': 'content-h' }, h('h2', { id: 'content-h' }, 'Content'));
  if (cur.representation === 'BINARY_ARTIFACT' || cur.binary) {
    content.appendChild(assetView(cur));
  } else {
    content.appendChild(h('div', { class: 'data-view' }, renderData(cur.data, '')));
    content.appendChild(h('details', { class: 'json' }, h('summary', null, 'Raw JSON'), h('pre', null, JSON.stringify(cur.data, null, 2))));
  }
  main.appendChild(content);

  if ((cur.findings || []).length) main.appendChild(h('section', { class: 'card', 'aria-labelledby': 'fd-h' }, h('h2', { id: 'fd-h' }, `Findings (${cur.findings.length})`), findingList(cur.findings)));

  // Sources and dependencies
  const deps = h('section', { class: 'card', 'aria-labelledby': 'dep-h' }, h('h2', { id: 'dep-h' }, 'Sources and dependencies'));
  deps.appendChild(h('h3', null, 'Source references (pinned inputs)'));
  deps.appendChild((cur.source_refs || []).length ? h('ul', { class: 'ref-list' }, cur.source_refs.map(r => h('li', null, refChip(r))))
    : h('p', { class: 'muted' }, 'None — this revision was built without linked source records.'));
  deps.appendChild(h('h3', null, 'Dependency edges'));
  if (d.edges.length) {
    deps.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' },
      h('thead', null, h('tr', null, ['Producer', 'Consumer', 'Kind', 'Stage', 'Paths'].map(x => h('th', { scope: 'col' }, x)))),
      h('tbody', null, d.edges.map(e => h('tr', null,
        h('td', { 'data-label': 'Producer' }, h('a', { href: plink('rec', e.producer_record_id, String(e.producer_version)) }, `${e.producer_module || ''} ${e.producer_record_id} v${e.producer_version}`)),
        h('td', { 'data-label': 'Consumer' }, h('a', { href: plink('rec', e.consumer_record_id, String(e.consumer_version)) }, `${e.consumer_operation} ${e.consumer_record_id} v${e.consumer_version}`)),
        h('td', { 'data-label': 'Kind' }, e.kind), h('td', { 'data-label': 'Stage' }, e.stage),
        h('td', { 'data-label': 'Paths' }, (e.paths || []).map(p => p === '' ? '(whole record)' : p).join(', '))))))));
  } else deps.appendChild(h('p', { class: 'muted' }, 'No dependency edges.'));
  main.appendChild(deps);

  // Provenance
  const prov = d.provenance.filter(p => p.version === cur.version);
  const pc = h('section', { class: 'card', 'aria-labelledby': 'prov-h' }, h('h2', { id: 'prov-h' }, 'Provenance'));
  if (!prov.length) pc.appendChild(h('p', { class: 'muted' }, 'No provenance entry for this revision (imports and staged records may not carry one).'));
  for (const p of prov) {
    const r = p.resource || {};
    pc.appendChild(h('dl', { class: 'kv' },
      h('dt', null, 'Transform'), h('dd', null, p.transform === 'LOGIC' ? 'LOGIC (deterministic code, no AI)' : p.transform === 'MANUAL' ? 'MANUAL (author-supplied candidate)' : p.transform),
      h('dt', null, 'Operation'), h('dd', null, opLabel(p.operation_id)),
      h('dt', null, 'Principal'), h('dd', null, p.principal_id),
      h('dt', null, 'Request / attempt'), h('dd', { class: 'mono small' }, `${p.request_id} / ${p.attempt_id}`),
      h('dt', null, 'Recorded'), h('dd', null, fmtTime(p.created_at)),
      p.resource ? [h('dt', null, 'AI slot'), h('dd', null, r.slot_id || r.slot || '—'),
        h('dt', null, 'Model'), h('dd', null, r.model || '—'),
        h('dt', null, 'Tokens'), h('dd', null, `${r.input_tokens ?? '?'} in / ${r.output_tokens ?? '?'} out`),
        h('dt', null, 'Resource detail'), h('dd', null, h('details', null, h('summary', null, 'Show'), h('pre', null, JSON.stringify(r, null, 2))))] : null,
      h('dt', null, 'Inputs'), h('dd', null, (p.input_refs || []).length ? h('div', { class: 'row' }, p.input_refs.map(refChip)) : 'none')));
  }
  main.appendChild(pc);
}

function assetView(v) {
  const box = h('div', { class: 'asset-view stack' });
  const mime = (v.binary && v.binary.mime_type) || v.mime_type || 'application/octet-stream';
  box.appendChild(h('p', { class: 'small muted' }, `${mime}${v.binary && v.binary.byte_length ? ` · ${v.binary.byte_length} bytes` : ''}`));
  const holder = h('div', null, loadingState('Loading file…'));
  box.appendChild(holder);
  const ext = { 'application/pdf': 'pdf', 'application/epub+zip': 'epub', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'text/plain': 'txt', 'application/json': 'json' }[mime] || 'bin';
  const name = `${v.record_id}-v${v.version}.${ext}`;
  api('GET', bpath(`/assets/${encodeURIComponent(v.record_id)}/${v.version}`), { blob: true }).then(async blob => {
    const typed = blob.type ? blob : new Blob([blob], { type: mime });
    const url = URL.createObjectURL(typed); S.blobUrls.push(url);
    clear(holder);
    const dl = h('a', { class: 'btn', href: url, download: name }, `Download ${ext.toUpperCase()}`);
    if (mime.startsWith('image/')) holder.appendChild(h('img', { src: url, alt: `Image asset ${v.record_id} v${v.version}` }));
    else if (mime === 'application/pdf') holder.appendChild(h('object', { data: url, type: 'application/pdf', 'aria-label': `PDF ${v.record_id}` },
      h('p', null, 'This browser cannot show the PDF inline. ', h('a', { href: url, download: name }, 'Download it'), '.')));
    else if (mime.startsWith('text/') || mime === 'application/json') {
      const txt = await typed.text();
      holder.appendChild(h('pre', null, txt.length > 200000 ? txt.slice(0, 200000) + '\n… (truncated; download for the full file)' : txt));
    } else holder.appendChild(h('p', null, mime.includes('epub') ? 'EPUB files open in an e-book reader.' : mime.includes('word') ? 'DOCX files open in a word processor.' : 'Preview is not available for this file type.'));
    holder.appendChild(h('p', null, dl));
  }).catch(e => { clear(holder).appendChild(failedState('Could not load the file', e)); });
  return box;
}

/* ----------------------------------------------------------------------- data rendering */
function isSemantic(v) { return v && typeof v === 'object' && !Array.isArray(v) && 'summary' in v && Array.isArray(v.facts) && Array.isArray(v.links); }
function proseBlock(text) {
  const div = h('div', { class: 'prose' });
  for (const para of String(text).split(/\n{2,}/)) {
    const p = h('p');
    para.split('\n').forEach((line, i) => { if (i) p.appendChild(h('br')); p.appendChild(document.createTextNode(line)); });
    div.appendChild(p);
  }
  return div;
}
function scalarText(v) {
  if (v === null) return h('span', { class: 'null' }, 'null (unknown / not applicable)');
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}
function factsTable(facts) {
  if (!facts.length) return h('p', { class: 'muted small' }, 'No facts.');
  return h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' },
    h('thead', null, h('tr', null, ['Subject', 'Predicate', 'Value', 'Type', 'Effective', 'Sources'].map(x => h('th', { scope: 'col' }, x)))),
    h('tbody', null, facts.map(f => h('tr', null,
      h('td', { 'data-label': 'Subject' }, f.subject_id), h('td', { 'data-label': 'Predicate' }, f.predicate),
      h('td', { 'data-label': 'Value' }, Array.isArray(f.value) ? f.value.map(x => x === null ? 'null' : String(x)).join(', ') : scalarText(f.value)),
      h('td', { 'data-label': 'Type' }, f.assertion_type === 'FACT' ? f.assertion_type : `${f.assertion_type} (not canon)`),
      h('td', { 'data-label': 'Effective' }, `[${f.effective_from ?? '−∞'}, ${f.effective_to ?? '+∞'})`),
      h('td', { 'data-label': 'Sources' }, (f.source_refs || []).length ? h('div', { class: 'row' }, f.source_refs.map(refChip)) : '—'))))));
}
function renderData(v, key) {
  if (v === null || v === undefined) return scalarText(null);
  if (typeof v === 'string') {
    if (v.length > 140 || v.includes('\n') || PROSE_KEYS.test(key || '')) return proseBlock(v);
    return h('span', null, v);
  }
  if (typeof v !== 'object') return scalarText(v);
  if (isRefValue(v)) return refChip(v);
  if (Array.isArray(v)) {
    if (!v.length) return h('span', { class: 'muted' }, '(empty list)');
    if (v.every(isRefValue)) return h('div', { class: 'row' }, v.map(refChip));
    if (v.every(x => x && typeof x === 'object' && 'subject_id' in x && 'predicate' in x)) return factsTable(v);
    if (v.every(x => x === null || typeof x !== 'object')) return h('ul', null, v.map(x => h('li', null, renderData(x, key))));
    return h('ol', null, v.map(x => h('li', null, renderData(x, key))));
  }
  if (isSemantic(v)) {
    return h('div', null, v.summary ? proseBlock(v.summary) : h('p', { class: 'muted' }, '(no summary)'),
      factsTable(v.facts), v.links.length ? h('div', { class: 'row small' }, 'Links: ', v.links.map(refChip)) : null,
      Object.keys(v).filter(k => !['summary', 'facts', 'links'].includes(k)).length
        ? renderData(Object.fromEntries(Object.entries(v).filter(([k]) => !['summary', 'facts', 'links'].includes(k))), '') : null);
  }
  const keys = Object.keys(v);
  if (!keys.length) return h('span', { class: 'muted' }, '(empty)');
  const dl = h('dl');
  for (const k of keys) { dl.appendChild(h('dt', null, humanize(k))); dl.appendChild(h('dd', null, renderData(v[k], k))); }
  return dl;
}

/* ======================================================================= views: edit (UPDATE) */
async function viewEdit(main, rid) {
  const d = await recordDetail(rid, true);
  const latest = d.versions[d.versions.length - 1];
  const op = S.opsById[latest.module_id];
  const schema = await getSchema(op.id);
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [S.project.name, plink()], [`${op.set} · ${setInfo(op.set).name}`, plink('set', op.set)],
      [`${op.id} ${op.name}`, plink('op', op.id)], [rid, plink('rec', rid)], 'Edit'),
    h('h1', { class: 'wrap-anywhere' }, `Edit ${recordTitle(latest)}`)),
  h('div', { class: 'row' }, lifecycleBadge(latest.lifecycle), badge('#', `based on v${latest.version}`, 'b-muted'))));
  if (latest.record_kind !== 'OUTPUT') {
    main.appendChild(stateBox('blocked', 'This record cannot be edited',
      h('p', null, `UPDATE replaces ${op.id} OUTPUT records only; this is a ${latest.record_kind} record.`)));
    return;
  }
  const card = h('section', { class: 'card', 'aria-labelledby': 'ed-h' }, h('h2', { id: 'ed-h' }, 'Full replacement'),
    h('p', { class: 'small muted' }, `Saving creates revision v${latest.version + 1} as a new DRAFT. The approved head stays as it is until the new revision is validated and accepted. Every field is sent: this is a full replacement, not a patch.`));
  if (latest.lifecycle === 'LOCKED') card.appendChild(stateBox('blocked', 'This record is LOCKED',
    h('p', null, 'An UPDATE needs a protected-change authorization (an I10 or K09 approval with scope ', h('code', null, `${op.id}:protected_change`), ').')));
  const draftKey = `bf:draft:${S.pid}:${S.branch}:${op.id}:edit:${rid}`;
  const draft = takePrefill(draftKey) || loadJSON(draftKey, null);
  if (S.skipSaveKeys) S.skipSaveKeys.delete(draftKey);
  if (draft && draft.from_paste) {
    const pz = draft.from_paste;
    card.appendChild(stateBox('draft', `Pasted into the form${(pz.filled || []).length ? `: ${pz.filled.map(humanize).join(', ')}` : ''} — please review`,
      h('p', null, 'Nothing has been saved yet. ', (pz.skipped || []).length ? `Skipped (not fields of this record): ${pz.skipped.join(', ')}.` : '')));
  }
  if (draft) {
    card.appendChild(stateBox(draft.base_version === latest.version ? 'draft' : 'stale',
      draft.base_version === latest.version ? `Restored your unsaved edits from ${fmtTime(draft.saved_at)}` : `Your saved edits were based on v${draft.base_version}; the record is now v${latest.version}`,
      draft.base_version === latest.version ? null : h('p', null, 'Submitting will replace the newer revision with your edits. Review the content, or discard the draft to start from the latest revision.'),
      h('p', null, h('button', { type: 'button', class: 'link', onclick: () => { if (confirm('Discard your unsaved edits? This cannot be undone.')) { removeKey(draftKey); route(); } } }, 'Discard draft and reload latest'))));
  }
  const ctx = new FormCtx('edit', []);
  // UPDATE payload has the OUTPUT shape; bindings for nested refs are not declared, so pickers list all records.
  const summary = h('div');
  const node = buildNode(schema.output, draft ? draft.payload : latest.data, '/payload', '', true, ctx, 0, { root: true });
  const status = h('span', { class: 'draft-state', role: 'status' }, draft ? 'Draft restored' : '');
  const btn = h('button', { type: 'submit', class: 'primary' }, `Save as v${latest.version + 1}`);
  const panel = h('div');
  const keyStore = (draft && draft.pending) || {};
  const pasteBtn = h('button', { type: 'button', class: 'paste-btn', onclick: () => pasteIntoForm({
    op, props: (schema.output && schema.output.properties) || {}, current: () => node.get(null) || {},
    apply: (values, info) => {
      S.skipSaveKeys.add(draftKey);
      const d = { payload: values, base_version: latest.version, pending: keyStore, saved_at: new Date().toISOString(), from_paste: info };
      S.prefill.set(draftKey, d); saveJSON(draftKey, d); route();
    } }) }, h('span', { 'aria-hidden': 'true' }, '📥'), ' Paste');
  card.appendChild(h('div', { class: 'row' }, pasteBtn, h('span', { class: 'small muted' }, 'Paste JSON to replace matching fields, or text for the main text field.')));
  const form = h('form', { novalidate: true }, summary, node.el, h('div', { class: 'form-actions' }, btn,
    h('a', { class: 'btn', href: plink('rec', rid) }, 'Back to record'), status), panel);
  const autosave = attachAutosave(form, draftKey, () => ({ payload: node.get(null), base_version: latest.version, pending: keyStore, saved_at: new Date().toISOString() }), status);
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const errs = []; const payload = node.get(errs) || {};
    ctx.clearErrors(); clear(summary);
    if (errs.length) { showFormErrors(errs, [ctx], summary); autosave.flush(); return; }
    const resp = await runDispatch({ op, action: 'UPDATE', payload, baseRef: latest.ref, manual: undefined, panel, keyStore, button: btn,
      forms: [ctx], summary, schema, onSuccess: () => autosave.clear(), onKeep: () => autosave.flush() });
    if (resp && resp.output_refs && resp.output_refs[0] && !(resp.errors || []).length) {
      S.details[rid] = null;
      panel.appendChild(h('p', null, h('a', { class: 'btn primary', href: recLink(resp.output_refs[0]) }, `Open v${resp.output_refs[0].version}`)));
    }
  });
  card.appendChild(form);
  main.appendChild(card);
}

/* ======================================================================= views: manifest */
async function viewManifest(main) {
  const m = await api('GET', bpath('/manifest'));
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [S.project.name, plink()], 'Feature manifest'),
    h('h1', null, `Book features (feature manifest) — ${S.branch}`))));
  if (!m) { main.appendChild(stateBox('empty', 'This branch has no feature manifest yet', h('p', null, 'Fill the form below to create one.'))); }
  const cur = m || { phase: 'PLANNING', features: { artwork: false, magic: false, mystery: false, foreshadowing: false, character_arcs: true },
    release_profiles: ['MANUSCRIPT_PDF'], required_operations: [], required_output_refs: [], allow_empty_phase: false };
  main.appendChild(h('p', { class: 'muted' }, 'The manifest decides which operations are required on this branch and which features are selected. Disabled features make their operations answer NOT_APPLICABLE. ',
    m ? `Current revision ${m.revision}.` : ''));
  const out = h('div', { 'aria-live': 'polite' });
  const phase = h('input', { id: 'mf-phase', type: 'text', value: cur.phase || '' });
  const feats = FEATURES.map(([k, l, hint]) => ({ k, el: h('input', { type: 'checkbox', id: `mf-f-${k}`, checked: !!cur.features[k] }), l, hint }));
  const profs = PROFILES.map(([k, l]) => ({ k, el: h('input', { type: 'checkbox', id: `mf-p-${k}`, checked: (cur.release_profiles || []).includes(k) }), l }));
  const allowEmpty = h('input', { type: 'checkbox', id: 'mf-empty', checked: !!cur.allow_empty_phase });
  const opBoxes = {};
  const setsEl = h('div');
  for (const [letter, [name]] of Object.entries(SETS)) {
    const ops = S.ops.filter(o => o.set === letter);
    const boxes = ops.map(o => { const b = h('input', { type: 'checkbox', id: `mf-op-${o.id}`, checked: (cur.required_operations || []).includes(o.id) }); opBoxes[o.id] = b; return [o, b]; });
    const countEl = h('span', { class: 'small muted' });
    const upd = () => { countEl.textContent = ` (${boxes.filter(([, b]) => b.checked).length}/${boxes.length} required)`; };
    boxes.forEach(([, b]) => b.addEventListener('change', upd)); upd();
    setsEl.appendChild(h('details', { class: 'card', open: letter === 'A' },
      h('summary', null, `${letter} · ${name}`, countEl),
      h('div', { class: 'row', style: 'margin:8px 0' },
        h('button', { type: 'button', class: 'small', onclick: () => { boxes.forEach(([, b]) => { b.checked = true; }); upd(); } }, `Require all ${letter}`),
        h('button', { type: 'button', class: 'small', onclick: () => { boxes.forEach(([, b]) => { b.checked = false; }); upd(); } }, `Clear ${letter}`)),
      h('div', { class: 'check-grid' }, boxes.map(([o, b]) => h('div', { class: 'check-row' }, b, h('label', { for: b.id }, `${o.id} ${o.name}`))))));
  }
  const save = h('button', { type: 'submit', class: 'primary' }, 'Save manifest');
  const form = h('form', { novalidate: true, onsubmit: async ev => {
    ev.preventDefault(); clear(out);
    const body = Object.assign({}, cur, {
      phase: phase.value.trim(), allow_empty_phase: allowEmpty.checked,
      features: Object.fromEntries(feats.map(f => [f.k, f.el.checked])),
      release_profiles: profs.filter(p => p.el.checked).map(p => p.k),
      required_operations: S.ops.map(o => o.id).filter(id => opBoxes[id].checked),
      required_output_refs: cur.required_output_refs || [],
    });
    if (!body.phase) { out.appendChild(stateBox('failed', 'Phase is required')); phase.focus(); return; }
    if (!body.release_profiles.length) { out.appendChild(stateBox('failed', 'Choose at least one release profile')); return; }
    save.disabled = true;
    try {
      const stored = await api('PUT', bpath('/manifest'), { body });
      S.manifest = stored; renderNav();
      out.appendChild(stateBox('ok', `Manifest saved (revision ${stored.revision})`, h('p', null, `${stored.required_operations.length} required operations.`)));
      announce('Manifest saved');
    } catch (e) { out.appendChild(failedState('Manifest was not saved', e)); }
    save.disabled = false;
  } },
  h('section', { class: 'card' }, h('h2', null, 'Phase and features'),
    h('div', { class: 'field' }, h('label', { for: 'mf-phase' }, 'Phase', h('span', { class: 'req-tag required' }, 'Required')), phase,
      h('span', { class: 'hint' }, 'Free text such as PLANNING, DRAFTING, EDITING, PRODUCTION.')),
    h('fieldset', { class: 'field' }, h('legend', null, 'Features'), h('div', { class: 'check-grid' },
      feats.map(f => h('div', { class: 'check-row' }, f.el, h('label', { for: f.el.id }, f.l, h('span', { class: 'hint' }, f.hint)))))),
    h('fieldset', { class: 'field' }, h('legend', null, 'Release profiles'), h('div', { class: 'check-grid' },
      profs.map(p => h('div', { class: 'check-row' }, p.el, h('label', { for: p.el.id }, p.l))))),
    h('div', { class: 'check-row' }, allowEmpty, h('label', { for: 'mf-empty' }, 'Allow an empty phase'))),
  h('h2', null, 'Required operations'),
  h('p', { class: 'small muted' }, 'Membership here is the scheduling predicate: progress and readiness count only these operations.'),
  setsEl, out, h('div', { class: 'form-actions' }, save));
  main.appendChild(form);
}

/* ======================================================================= views: progress */
async function viewProgress(main) {
  const pr = await api('GET', bpath('/progress'));
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [S.project.name, plink()], 'Progress'),
    h('h1', null, `Progress — ${S.branch}`))));
  main.appendChild(h('p', { class: 'notice' }, 'These are record counts, not approval evidence. Approval is decided per record revision; open a record to see its exact approved revision.'));
  const blockers = [];
  for (const op of pr.required_operations) {
    const st = pr.per_operation[op] || { records: 0, approved: 0, stale: 0, draft: 0 };
    if (!st.records) blockers.push([op, `no records yet — minimum first input: ${(S.opsById[op] && S.opsById[op].create_requires || []).join(', ') || 'see form'}`]);
    else if (st.stale) blockers.push([op, `${st.stale} stale record${st.stale > 1 ? 's' : ''} need replacement`]);
    else if (!st.approved) blockers.push([op, `${st.records} record${st.records > 1 ? 's' : ''}, none approved`]);
  }
  const done = pr.required_operations.length - blockers.length;
  main.appendChild(h('section', { class: 'card', 'aria-labelledby': 'pg-sum' }, h('h2', { id: 'pg-sum' }, 'Summary'),
    h('dl', { class: 'kv' }, h('dt', null, 'Required operations'), h('dd', null, String(pr.required_operations.length)),
      h('dt', null, 'With an approved record and nothing stale'), h('dd', null, String(done)),
      h('dt', null, 'Needing attention'), h('dd', null, String(blockers.length)),
      h('dt', null, 'Release profiles'), h('dd', null, (pr.release_profiles || []).join(', ')))));
  const tools = h('section', { class: 'card', 'aria-labelledby': 'pg-tools' }, h('h2', { id: 'pg-tools' }, 'Export and backup'));
  const out = h('div', { 'aria-live': 'polite' });
  const exp = h('button', { type: 'button' }, 'Export project JSON');
  exp.addEventListener('click', async () => {
    clear(out); exp.disabled = true;
    try {
      const data = await api('GET', bpath('/export'));
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = h('a', { href: url, download: `${S.pid}-${S.branch}-export.json` }); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      out.appendChild(stateBox('ok', `Exported ${data.records.length} record revisions`, h('p', null, 'The file contains project data only; AI credentials are never included.')));
    } catch (e) { out.appendChild(failedState('Export failed', e)); }
    exp.disabled = false;
  });
  const bk = h('button', { type: 'button' }, 'Back up now');
  bk.addEventListener('click', async () => {
    clear(out); bk.disabled = true; out.appendChild(loadingState('Creating and verifying backup…'));
    try {
      const r = await api('POST', `/projects/${encodeURIComponent(S.pid)}/backup`);
      clear(out).appendChild(r.verified
        ? stateBox('ok', 'Backup created and verified', h('p', { class: 'wrap-anywhere' }, 'Location: ', h('code', null, r.path)))
        : stateBox('failed', 'Backup created but verification found problems', h('p', { class: 'wrap-anywhere' }, 'Location: ', h('code', null, r.path)),
          h('ul', null, (r.problems || []).map(p => h('li', null, typeof p === 'string' ? p : JSON.stringify(p))))));
    } catch (e) { clear(out).appendChild(failedState('Backup failed', e)); }
    bk.disabled = false;
  });
  tools.appendChild(h('div', { class: 'row' }, exp, bk)); tools.appendChild(out);
  main.appendChild(tools);
  if (blockers.length) {
    main.appendChild(h('section', { class: 'card', 'aria-labelledby': 'pg-bl' }, h('h2', { id: 'pg-bl' }, `Needs attention (${blockers.length})`),
      h('ul', null, blockers.map(([op, why]) => h('li', null, h('a', { href: plink('op', op) }, opLabel(op)), ' — ', why)))));
  }
  const rows = pr.required_operations.map(op => {
    const st = pr.per_operation[op] || { records: 0, approved: 0, stale: 0, draft: 0 };
    const state = !st.records ? ['○', 'Empty', 'b-muted'] : st.stale ? ['⚠︎', 'Stale', 'b-warn'] : st.approved ? ['✔', 'Has approved', 'b-ok'] : ['✎', 'Draft only', 'b-info'];
    return h('tr', null, h('td', { 'data-label': 'Operation' }, h('a', { href: plink('op', op) }, opLabel(op))),
      h('td', { 'data-label': 'Records' }, String(st.records)), h('td', { 'data-label': 'Approved' }, String(st.approved)),
      h('td', { 'data-label': 'Draft' }, String(st.draft)), h('td', { 'data-label': 'Stale' }, String(st.stale)),
      h('td', { 'data-label': 'State' }, badge(...state)));
  });
  main.appendChild(h('section', { class: 'card', 'aria-labelledby': 'pg-t' }, h('h2', { id: 'pg-t' }, 'Required operations'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' },
      h('thead', null, h('tr', null, ['Operation', 'Records', 'Approved', 'Draft', 'Stale', 'State'].map(x => h('th', { scope: 'col' }, x)))),
      h('tbody', null, rows)))));
}

/* ======================================================================= views: activity */
async function viewActivity(main) {
  const act = await api('GET', bpath('/activity'));
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [S.project.name, plink()], 'Activity'),
    h('h1', null, `Activity — ${S.branch}`)),
  h('button', { type: 'button', onclick: () => route() }, 'Refresh')));
  const audit = h('section', { class: 'card', 'aria-labelledby': 'ac-a' }, h('h2', { id: 'ac-a' }, `Audit log (${act.audit.length})`));
  if (!act.audit.length) audit.appendChild(stateBox('empty', 'No audited actions yet'));
  else audit.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'responsive' },
    h('thead', null, h('tr', null, ['Time', 'Operation', 'Action', 'Outcome', 'Evidence', 'Outputs'].map(x => h('th', { scope: 'col' }, x)))),
    h('tbody', null, act.audit.map(a => h('tr', null,
      h('td', { 'data-label': 'Time' }, fmtTime(a.recorded_at)),
      h('td', { 'data-label': 'Operation' }, S.opsById[a.operation_id] ? h('a', { href: plink('op', a.operation_id) }, opLabel(a.operation_id)) : a.operation_id),
      h('td', { 'data-label': 'Action' }, a.action),
      h('td', { 'data-label': 'Outcome' }, badge(a.outcome === 'SUCCESS' ? '✔' : a.outcome === 'NOT_APPLICABLE' ? '–' : '✕', a.outcome,
        a.outcome === 'SUCCESS' ? 'b-ok' : a.outcome === 'NOT_APPLICABLE' ? 'b-muted' : 'b-bad')),
      h('td', { 'data-label': 'Evidence' }, a.evidence_type),
      h('td', { 'data-label': 'Outputs' }, (a.output_refs || []).length ? h('div', { class: 'row' }, a.output_refs.map(refChip)) : '—')))))));
  main.appendChild(audit);
  const ev = h('section', { class: 'card', 'aria-labelledby': 'ac-e' }, h('h2', { id: 'ac-e' }, `Events (${act.events.length})`));
  if (!act.events.length) ev.appendChild(stateBox('empty', 'No events yet'));
  else ev.appendChild(h('ul', { class: 'record-list' }, act.events.map(e => h('li', { class: 'record-item' },
    h('div', { class: 'r-main' }, h('div', { class: 'r-title' }, e.event_type), h('div', { class: 'r-meta' }, `${fmtTime(e.created_at)} · ${e.event_id}`),
      eventSummary(e)),
    h('details', { class: 'small' }, h('summary', null, 'Payload'), h('pre', null, JSON.stringify(e.payload, null, 2)))))));
  main.appendChild(ev);
}
function eventSummary(e) {
  const p = e.payload || {};
  const refs = [].concat(p.output_refs || [], p.ref ? [p.ref] : [], p.producer ? [p.producer] : []);
  const parts = [];
  if (p.operation_id) parts.push(opLabel(p.operation_id));
  if (p.label) parts.push(`file ${p.label}`);
  if (p.stale && p.stale.length) parts.push(`${p.stale.length} consumer(s) marked stale`);
  return h('div', { class: 'small' }, parts.join(' · '), refs.length ? h('div', { class: 'row' }, refs.map(refChip)) : null);
}

/* ======================================================================= views: settings */
const AI_SITES = [['claude', 'Claude'], ['chatgpt', 'ChatGPT'], ['gemini', 'Gemini']];
const BRIDGE_DEFAULT = 'http://127.0.0.1:17891';
const TOS_CAUTION = 'Experimental: automating the ChatGPT, Claude and Gemini web interfaces may be against those sites’ terms of service. Use it at your own risk.';

async function viewSettings(main) {
  const slots = await api('GET', '/slots');
  main.appendChild(h('div', { class: 'page-head' }, h('h1', null, 'Settings: AI slots')));
  main.appendChild(h('section', { class: 'card', 'aria-labelledby': 'priv-h' }, h('h2', { id: 'priv-h' }, 'How AI slots are used'),
    h('ul', null,
      h('li', null, 'Bookforge has exactly three AI slots: AI-1, AI-2 and AI-3. All are optional.'),
      h('li', null, 'When a creative operation runs, its context package (only the records that operation needs from the current project) is sent to the one slot selected for that job — never to the other slots, and never with secrets or unrelated projects.'),
      h('li', null, 'Without a connected slot, creative operations answer CAPABILITY_UNAVAILABLE and accept a manual candidate instead: you write the output in the form and Bookforge validates and stores it. Nothing leaves this computer in manual mode.'),
      h('li', null, 'Deterministic (LOGIC) operations never use an AI slot.'),
      h('li', null, 'Roles route work: when a connected slot lists an operation ID (C02) or set letter (B) in its roles, that work goes only to such slots.'),
      h('li', null, 'API keys and AutoInjector connection keys are stored in the local secrets file on this computer, never in project data, exports, reports or logs. Key fields are write-only: a saved key is never shown again.'),
      h('li', null, 'Not sure everything works? Press “🧪 Test everything” at the top: it builds a small test book in a separate project and writes a report.'))));
  main.appendChild(autoInjectorCard(main));
  for (const s of slots) main.appendChild(slotForm(s));
  main.appendChild(retryCard());
  main.appendChild(backupsCard());
  main.appendChild(helpCard());
}

function autoInjectorCard(main) {
  const p = 'ai-bridge';
  const out = h('div', { 'aria-live': 'polite' });
  const url = h('input', { type: 'url', id: `${p}-url`, value: BRIDGE_DEFAULT, spellcheck: 'false', 'aria-describedby': `${p}-url-h` });
  const token = h('input', { type: 'password', id: `${p}-token`, autocomplete: 'new-password', spellcheck: 'false', 'aria-describedby': `${p}-token-h`, 'aria-required': 'true' });
  const btn = h('button', { type: 'submit', class: 'primary' }, 'Connect AutoInjector (all three slots)');
  return h('form', { class: 'card', 'aria-labelledby': `${p}-h`, novalidate: true, onsubmit: async ev => {
    ev.preventDefault(); clear(out);
    if (!token.value.trim()) {
      token.setAttribute('aria-invalid', 'true');
      out.appendChild(stateBox('failed', 'Paste the connection key first', h('p', null, 'In AutoInjector: BookForge bridge panel → Copy connection key. Then paste it here.')));
      token.focus(); return;
    }
    token.removeAttribute('aria-invalid');
    btn.disabled = true;
    try {
      await api('POST', '/slots/connect-autoinjector', { body: { bridge_url: url.value.trim() || BRIDGE_DEFAULT, token: token.value.trim() } });
      token.value = '';
      announce('Connection key saved for AI-1, AI-2 and AI-3. Checking the connection now.');
      toast('Connection key saved: AI-1 Claude, AI-2 ChatGPT, AI-3 Gemini — see each slot’s status below');
      clear(main); await viewSettings(main);
      return;
    } catch (e) { out.appendChild(failedState('AutoInjector was not connected', e)); }
    btn.disabled = false;
  } },
  h('h2', { id: `${p}-h` }, 'Connect AutoInjector (experimental) ', infoTip('What is AutoInjector?', ...TIP_AUTOINJECTOR())),
  h('p', { class: 'notice', role: 'note' }, h('span', { 'aria-hidden': 'true' }, '⚠︎ '), TOS_CAUTION),
  h('p', null, 'Use the ChatGPT, Claude and Gemini sessions you are logged in to inside the AutoInjector desktop app — no API keys needed.'),
  h('ol', { class: 'steps-list' },
    h('li', null, 'Start the AutoInjector desktop app and log in to ChatGPT, Claude and/or Gemini there.'),
    h('li', null, 'In AutoInjector: BookForge bridge panel → switch the bridge on → ', h('strong', null, 'Copy connection key'), '.'),
    h('li', null, 'Paste the key below and press ', h('strong', null, 'Connect AutoInjector'), '. This sets AI-1 = Claude, AI-2 = ChatGPT and AI-3 = Gemini (you can change each slot below).'),
    h('li', null, 'Each slot below then shows where it’s at and the next step. Press ', h('strong', null, 'Test connection'), ' on a slot any time.')),
  h('div', { class: 'grid-2' },
    h('div', { class: 'field' }, h('span', { class: 'label-row' }, h('label', { for: token.id }, 'Connection key'), infoTip('What is the connection key?', ...TIP_KEY())), token,
      h('span', { class: 'hint', id: `${p}-token-h` }, 'From AutoInjector: BookForge bridge panel → Copy connection key. Saved privately on this computer for all three slots; never shown again.')),
    h('div', { class: 'field' }, h('span', { class: 'label-row' }, h('label', { for: url.id }, 'AutoInjector address'), infoTip('What is the AutoInjector address?', ...TIP_URL())), url,
      h('span', { class: 'hint', id: `${p}-url-h` }, 'Only http://127.0.0.1 or http://localhost is accepted. Default ' + BRIDGE_DEFAULT + '.'))),
  out, h('div', { class: 'form-actions' }, btn));
}

function healthResult(r) {
  const sites = r.sites || {};
  const names = Object.keys(sites);
  return h('div', null,
    h('p', null, r.message || (r.ok ? 'Bridge reachable' : 'Bridge not reachable')),
    names.length ? h('ul', { class: 'plain-list', 'aria-label': 'Sites reported by the bridge' }, names.map(n => {
      const st = sites[n] || {};
      return h('li', { class: 'row' }, h('strong', null, n),
        st.ready ? badge('✔', 'Ready', 'b-ok') : badge('✕', 'Not ready', 'b-bad'),
        st.busy ? badge('…', 'Busy', 'b-warn') : badge('○', 'Idle', 'b-muted'),
        n === r.site ? h('span', { class: 'small muted' }, '(this slot)') : null);
    })) : null);
}

function slotForm(s) {
  const p = `slot-${s.slot_id}`;
  const out = h('div', { 'aria-live': 'polite' });
  const f = (key, label, control, hint) => {
    control.id = `${p}-${key}`;
    if (hint) control.setAttribute('aria-describedby', `${p}-${key}-h`);
    return h('div', { class: 'field' }, h('label', { for: control.id }, label), control, hint ? h('span', { class: 'hint', id: `${p}-${key}-h` }, hint) : null);
  };
  const adapter = h('select', null, [['none', 'None (not connected)'], ['anthropic', 'Anthropic API'], ['manual', 'Manual (author writes candidates)'],
    ['autoinjector', 'autoinjector (experimental, uses your logged-in web sessions)']]
    .map(([v, l]) => h('option', { value: v, selected: s.adapter_id === v }, l)));
  const model = h('input', { type: 'text', value: s.model || 'claude-opus-5-5' });
  const effort = h('select', null, ['low', 'medium', 'high', 'xhigh', 'max'].map(v => h('option', { value: v, selected: s.effort === v }, v)));
  const caps = h('input', { type: 'text', value: (s.capabilities || []).join(', ') });
  const ctxLimit = h('input', { type: 'number', min: '0', step: '1', value: String(s.context_limit_tokens ?? '') });
  const maxOut = h('input', { type: 'number', min: '0', step: '1', value: String(s.max_output_tokens ?? '') });
  const maxConc = h('input', { type: 'number', min: '0', step: '1', value: String(s.max_concurrent ?? '') });
  const inCost = h('input', { type: 'number', min: '0', step: '1', value: String(s.input_cost_minor_per_mtok ?? '') });
  const outCost = h('input', { type: 'number', min: '0', step: '1', value: String(s.output_cost_minor_per_mtok ?? '') });
  const currency = h('input', { type: 'text', value: s.currency || 'USD', maxlength: '3' });
  const roles = h('input', { type: 'text', value: (s.roles || []).join(', '), spellcheck: 'false' });
  const bridgeUrl = h('input', { type: 'url', value: s.bridge_url || BRIDGE_DEFAULT, spellcheck: 'false' });
  const site = h('select', null, h('option', { value: '', selected: !s.site }, 'Choose a site'),
    AI_SITES.map(([v, l]) => h('option', { value: v, selected: s.site === v }, l)));
  const key = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: s.has_credentials ? 'Stored — leave blank to keep' : 'Not set' });
  const removeKeyBox = h('input', { type: 'checkbox', id: `${p}-rmkey` });
  const isAuto = () => adapter.value === 'autoinjector';
  const strip = slotStatusStrip(s);
  const status = h('p', { class: 'row' },
    s.connected ? badge('✔', 'Adapter set', 'b-ok') : badge('○', 'Not set up', 'b-muted'),
    s.adapter_id === 'autoinjector'
      ? (s.has_credentials ? badge('⚿︎', 'Connection key saved', 'b-ok') : badge('–', 'No connection key', 'b-muted'))
      : (s.has_credentials ? badge('⚿︎', 'API key available', 'b-ok') : badge('–', 'No API key', 'b-muted')),
    s.adapter_id === 'autoinjector' && s.site ? badge('◆', `Web: ${s.site}`, 'b-info') : null,
    (s.roles || []).length ? badge('→', `Roles: ${s.roles.join(', ')}`, 'b-info') : null,
    s.healthy === false ? badge('⚠︎', 'Unhealthy', 'b-warn') : null,
    badge('…', `${s.active_jobs || 0} active job(s)`, 'b-muted'));
  const healthOut = h('div', { 'aria-live': 'polite' });
  const testBtn = h('button', { type: 'button', disabled: s.adapter_id !== 'autoinjector', 'aria-describedby': `${p}-test-h` }, `Test connection (${s.slot_id})`);
  testBtn.addEventListener('click', async () => {
    clear(healthOut); healthOut.appendChild(loadingState('Checking the AutoInjector bridge…'));
    testBtn.disabled = true;
    try {
      const r = await api('GET', `/slots/${encodeURIComponent(s.slot_id)}/health`);
      strip.redraw(r);
      clear(healthOut);
      healthOut.appendChild(r.ok ? stateBox('ok', `${s.slot_id}: connection works`, healthResult(r))
        : stateBox('failed', `${s.slot_id}: connection problem`, r.error ? h('p', null, h('code', null, r.error)) : null, healthResult(r)));
      announce(r.ok ? `${s.slot_id} connection works` : `${s.slot_id} connection problem: ${r.message || ''}`);
    } catch (e) { clear(healthOut); healthOut.appendChild(failedState(`${s.slot_id}: test failed`, e)); }
    testBtn.disabled = false;
  });
  const autoGroup = h('fieldset', { class: 'field', hidden: !isAuto() },
    h('legend', null, 'AutoInjector connection'),
    h('p', { class: 'small', role: 'note' }, h('span', { 'aria-hidden': 'true' }, '⚠︎ '), TOS_CAUTION),
    h('div', { class: 'grid-2' },
      f('bridge', 'AutoInjector address', bridgeUrl, 'http://127.0.0.1 or http://localhost only. Default ' + BRIDGE_DEFAULT + '.'),
      f('site', 'Web site', site, 'Which logged-in AutoInjector pane this slot uses.')),
    h('div', { class: 'row' }, testBtn, infoTip('What does Test connection do?', ...TIP_TEST()),
      h('span', { class: 'hint', id: `${p}-test-h` }, 'Checks the saved settings (save first). Sends no book content.')),
    healthOut);
  const keyLegend = h('legend', null, isAuto() ? 'Connection key (write-only)' : 'API key (write-only)');
  const keyLabelText = () => isAuto() ? 'New connection key' : 'New API key';
  const keyField = f('key', keyLabelText(), key, s.has_credentials ? 'A secret is stored for this slot (or ANTHROPIC_API_KEY is set). Leave blank to keep it.' : 'Paste it to store it locally for this slot.');
  adapter.addEventListener('change', () => {
    autoGroup.hidden = !isAuto();
    keyLegend.textContent = isAuto() ? 'Connection key (write-only)' : 'API key (write-only)';
    keyField.querySelector('label').textContent = keyLabelText();
  });
  const btn = h('button', { type: 'submit', class: 'primary' }, `Save ${s.slot_id}`);
  return h('form', { class: 'card', 'aria-labelledby': `${p}-h`, novalidate: true, onsubmit: async ev => {
    ev.preventDefault(); clear(out);
    const ints = { context_limit_tokens: ctxLimit, max_output_tokens: maxOut, max_concurrent: maxConc,
      input_cost_minor_per_mtok: inCost, output_cost_minor_per_mtok: outCost };
    const body = { adapter_id: adapter.value, model: model.value.trim() || 'claude-opus-5-5', effort: effort.value,
      capabilities: caps.value.split(',').map(x => x.trim()).filter(Boolean), currency: (currency.value.trim() || 'USD').toUpperCase(),
      roles: roles.value.split(',').map(x => x.trim().toUpperCase()).filter(Boolean) };
    for (const [k, el] of Object.entries(ints)) {
      const v = el.value.trim();
      if (v === '') continue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) { el.setAttribute('aria-invalid', 'true'); out.appendChild(stateBox('failed', `${humanize(k)} must be a whole number of 0 or more`)); el.focus(); return; }
      el.removeAttribute('aria-invalid'); body[k] = n;
    }
    const badRole = body.roles.find(r => !/^[A-K]([0-9]{2})?$/.test(r));
    if (badRole) { roles.setAttribute('aria-invalid', 'true'); out.appendChild(stateBox('failed', `Role “${badRole}” is not an operation ID like C02 or a set letter A–K`)); roles.focus(); return; }
    roles.removeAttribute('aria-invalid');
    if (isAuto()) {
      if (!site.value) { site.setAttribute('aria-invalid', 'true'); out.appendChild(stateBox('failed', 'Choose the web site this slot uses')); site.focus(); return; }
      site.removeAttribute('aria-invalid');
      body.site = site.value; body.bridge_url = bridgeUrl.value.trim() || BRIDGE_DEFAULT;
    }
    if (removeKeyBox.checked) body.api_key = null;
    else if (key.value) body.api_key = key.value;
    btn.disabled = true;
    try {
      const saved = await api('PUT', `/slots/${s.slot_id}`, { body });
      key.value = ''; removeKeyBox.checked = false;
      testBtn.disabled = saved.adapter_id !== 'autoinjector';
      const secret = saved.adapter_id === 'autoinjector' ? 'Connection key' : 'API key';
      const what = saved.adapter_id === 'autoinjector' ? `web site ${saved.site}` : `model ${saved.model}`;
      out.appendChild(stateBox('ok', `${s.slot_id} saved`, h('p', null, `Adapter ${saved.adapter_id}, ${what}. ${secret} ${saved.has_credentials ? 'available' : 'not set'}.`)));
      Object.assign(s, saved); strip.recheck();
      announce(`${s.slot_id} saved`);
    } catch (e) { out.appendChild(failedState(`${s.slot_id} was not saved`, e)); }
    btn.disabled = false;
  } },
  h('h2', { id: `${p}-h` }, s.slot_id), strip, status,
  h('div', { class: 'grid-2' },
    f('adapter', 'Adapter', adapter, 'None keeps the slot disconnected; creative work then uses manual candidates.'),
    f('model', 'Model', model, 'Default claude-opus-5-5. Ignored by autoinjector slots (the web site picks its model).'),
    f('effort', 'Effort', effort, 'Higher effort is slower and uses more tokens.'),
    f('caps', 'Capabilities', caps, 'Comma separated, e.g. text, json.'),
    f('roles', 'Roles', roles, 'Optional, comma separated operation IDs or set letters, e.g. B, C02. Matching work goes only to slots with that role.'),
    f('ctx', 'Context limit (tokens)', ctxLimit, 'Larger mandatory context is split or blocked with CONTEXT_TOO_LARGE.'),
    f('maxout', 'Max output (tokens)', maxOut),
    f('conc', 'Max concurrent jobs', maxConc, 'Autoinjector slots always run one job at a time.'),
    f('cur', 'Currency', currency),
    f('incost', 'Input cost per million tokens (minor units)', inCost, 'Integer minor units, e.g. cents. Used to rank slots by cost. Autoinjector slots cost 0.'),
    f('outcost', 'Output cost per million tokens (minor units)', outCost, 'Integer minor units.')),
  autoGroup,
  h('fieldset', { class: 'field' }, keyLegend, keyField,
    h('div', { class: 'check-row' }, removeKeyBox, h('label', { for: removeKeyBox.id }, 'Remove the stored secret for this slot'))),
  out, h('div', { class: 'form-actions' }, btn));
}

/* ======================================================================= Test everything (self-test) */
const ST_ICON = { PASS: ['✔', 'Passed', 'b-ok'], FAIL: ['✕', 'Failed', 'b-bad'], SKIPPED: ['–', 'Skipped', 'b-muted'] };
const ST = { dialog: null, timer: null, view: 'intro', startedAt: null, opener: null, prog: null };

function stBadge(status) { const b = ST_ICON[status] || ['…', 'Running', 'b-info']; return badge(b[0], b[1], b[2]); }
function fmtMs(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`; }

async function openSelfTest() {
  const d = $('#selftest-dialog');
  ST.dialog = d; ST.opener = visibleOpener(document.activeElement); ST.view = null; ST.prog = null;
  let st = null;
  try { st = await api('GET', '/selftest'); } catch (e) { if (S.authFailed) return; }
  if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  if (st && st.running) renderSelfTestProgress(st); else renderSelfTestIntro(st);
}
function closeSelfTest() {
  const d = ST.dialog; if (!d) return;
  stopSelfTestPolling();
  if (d.open) { if (d.close) d.close(); else d.removeAttribute('open'); }
  if (ST.opener && ST.opener.focus) ST.opener.focus();
}
function stopSelfTestPolling() { clearTimeout(ST.timer); ST.timer = null; }

function stShell(title, ...body) {
  const d = clear(ST.dialog);
  if (title !== 'Testing everything…') ST.prog = null;
  d.appendChild(h('div', { class: 'st-head' },
    h('h2', { id: 'selftest-title' }, h('span', { 'aria-hidden': 'true' }, '🧪 '), title),
    h('button', { type: 'button', class: 'small', 'aria-label': 'Close the test window', onclick: closeSelfTest }, '✕ Close')));
  append(d, body);
  return d;
}

function renderSelfTestIntro(st) {
  ST.view = 'intro';
  const aiBox = h('input', { type: 'checkbox', id: 'st-use-ai', 'aria-describedby': 'st-use-ai-h' });
  const out = h('div', { 'aria-live': 'polite' });
  const start = h('button', { type: 'button', class: 'primary', onclick: async () => {
    start.disabled = true; clear(out);
    try {
      const s = await api('POST', '/selftest', { body: { use_ai: aiBox.checked } });
      ST.startedAt = Date.now();
      announce('Test started');
      renderSelfTestProgress(s);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { const s = await api('GET', '/selftest'); renderSelfTestProgress(s); return; }
      out.appendChild(failedState('The test could not start', e)); start.disabled = false;
    }
  } }, 'Start the test');
  const last = st && st.last_report;
  const d = stShell('Test everything',
    h('p', null, 'BookForge will make a small two-chapter book from start to finish, exactly the way you would: create a character and a place, plan the story, write two chapters, track what happens, fix a typo through an edit pass, lay out the book, export a PDF, EPUB and Word file, re-read those files, run the quality checks and approve the release.'),
    h('ul', null,
      h('li', null, h('strong', null, 'Your projects are not touched. '), 'Everything goes into a new, separate project called “Self-test <date time>”. You can open it afterwards and look at every record it made, or ignore it.'),
      h('li', null, h('strong', null, 'It takes about 5 seconds '), 'without AI. Each step is shown as it finishes, with ✔ Passed, ✕ Failed or – Skipped and what to do if something fails.'),
      h('li', null, h('strong', null, 'You get a written report '), '(Markdown and JSON) saved in the “reports” folder next to your BookForge data. It never contains keys, passwords or AI conversations.')),
    h('div', { class: 'check-row st-ai' }, aiBox,
      h('label', { for: 'st-use-ai' }, 'Use my AI slots too')),
    h('p', { class: 'hint', id: 'st-use-ai-h' }, 'Off: nothing is sent anywhere — the creative steps use fixed text (“MANUAL (no AI)”). On: BookForge first checks each connected AI slot, then really sends two small prompts (a story premise and a short chapter, plus one “find the events” request) to your connected AI — for example ChatGPT, Claude or Gemini through AutoInjector, or the Anthropic API. Web sessions can take a minute or more per prompt. If no AI is ready, those steps are skipped with the reason and the rest still runs.'),
    last ? h('p', { class: 'small muted' }, 'Last test: ', stBadge(last.verdict === 'PASS' ? 'PASS' : 'FAIL'), ` ${last.counts.PASS} passed, ${last.counts.FAIL} failed, ${last.counts.SKIPPED} skipped · ${fmtTime(last.finished_at)} `,
      h('button', { type: 'button', class: 'link', onclick: () => renderSelfTestDone({ last_report: last, progress: null }) }, 'Show last result')) : null,
    out,
    h('div', { class: 'form-actions' }, start, h('button', { type: 'button', onclick: closeSelfTest }, 'Cancel')));
  aiBox.focus();
  return d;
}

function stStepItem(s) {
  return h('li', { class: `st-step st-${(s.status || 'run').toLowerCase()}` },
    h('div', { class: 'row' }, stBadge(s.status), h('strong', null, s.id), h('span', null, s.title),
      s.elapsed_ms != null ? h('span', { class: 'small muted' }, fmtMs(s.elapsed_ms)) : null,
      s.records != null && (Array.isArray(s.records) ? s.records.length : s.records) ?
        h('span', { class: 'small muted' }, `${Array.isArray(s.records) ? s.records.length : s.records} record(s)`) : null),
    h('p', { class: 'small st-detail' }, s.detail || ''),
    s.fix && s.status !== 'PASS' ? h('p', { class: 'small st-fix' }, h('strong', null, s.status === 'FAIL' ? 'What to do: ' : 'Tip: '), s.fix) : null);
}

function renderSelfTestProgress(st) {
  const p = st.progress || { steps: [], pending: [], done: 0, total: 0 };
  if (!ST.startedAt) ST.startedAt = p.started_at ? Date.parse(p.started_at) : Date.now();
  if (ST.view !== 'progress' || !ST.prog) {
    // Build once; later polls only update the parts, so keyboard focus is never lost.
    ST.view = 'progress';
    const P = ST.prog = {
      count: h('strong'), elapsed: h('span', { class: 'muted' }), mode: h('span'),
      bar: h('progress', { max: '1', value: '0', 'aria-label': 'Test progress' }),
      now: h('strong'), project: h('p', { class: 'small muted' }),
      list: h('ol', { class: 'st-steps', 'aria-label': 'Finished steps' }),
      pendingSummary: h('summary'), pendingList: h('ul', { class: 'small' }), shown: 0,
    };
    P.pending = h('details', null, P.pendingSummary, P.pendingList);
    stShell('Testing everything…',
      h('p', { class: 'row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), P.count, P.elapsed, P.mode),
      P.bar, h('p', null, 'Now: ', P.now), P.project, P.list, P.pending,
      h('div', { class: 'form-actions' }, h('button', { type: 'button', onclick: closeSelfTest }, 'Hide (the test keeps running)')));
    ST.dialog.querySelector('.form-actions button').focus();
  }
  const P = ST.prog;
  P.count.textContent = `${p.done} of ${p.total} steps done`;
  P.elapsed.textContent = `· ${Math.max(0, Math.round((Date.now() - ST.startedAt) / 1000))} s`;
  clear(P.mode).appendChild(p.use_ai ? badge('◆', 'Using your AI slots', 'b-info') : badge('✎', 'MANUAL (no AI)', 'b-muted'));
  P.bar.max = p.total || 1; P.bar.value = p.done || 0;
  P.now.textContent = p.current_step || 'finishing…';
  P.project.textContent = p.project_name ? `Working in the project “${p.project_name}”.` : '';
  const steps = p.steps || [];
  for (const sItem of steps.slice(P.shown)) P.list.appendChild(stStepItem(sItem));
  if (steps.length > P.shown) {
    const last = steps[steps.length - 1];
    announce(`Step ${last.id} ${(ST_ICON[last.status] || [])[1] || last.status}: ${last.title}`);
  }
  P.shown = Math.max(P.shown, steps.length);
  const pend = p.pending || [];
  P.pending.hidden = !pend.length;
  P.pendingSummary.textContent = `${pend.length} step(s) still to run`;
  clear(P.pendingList); for (const x of pend) P.pendingList.appendChild(h('li', null, `${x.id} ${x.title}`));
  stopSelfTestPolling();
  ST.timer = setTimeout(pollSelfTest, 700);
}

async function pollSelfTest() {
  if (!ST.dialog || !ST.dialog.open) return;
  let st;
  try { st = await api('GET', '/selftest'); } catch (e) { ST.timer = setTimeout(pollSelfTest, 2000); return; }
  if (st.running) renderSelfTestProgress(st);
  else { ST.startedAt = null; renderSelfTestDone(st); }
}

function renderSelfTestDone(st) {
  ST.view = 'done'; stopSelfTestPolling();
  const rep = st.last_report;
  if (!rep) {
    const err = st.progress && st.progress.error;
    return stShell('The test stopped', stateBox('failed', 'The test did not finish', h('p', null, err || 'No report was written. Run it again; if it keeps happening, check the BookForge console window.')),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'primary', onclick: () => renderSelfTestIntro(null) }, 'Try again')));
  }
  const ok = rep.verdict === 'PASS';
  const failed = rep.steps.filter(s => s.status === 'FAIL');
  const viewOut = h('div', { 'aria-live': 'polite' });
  const pid = rep.project && rep.project.project_id;
  const d = stShell(ok ? 'Everything works' : 'Some steps failed',
    stateBox(ok ? 'ok' : 'failed', ok ? `All ${rep.counts.PASS} checked steps passed` : `${failed.length} step(s) failed`,
      h('p', null, `${rep.counts.PASS} passed, ${rep.counts.FAIL} failed, ${rep.counts.SKIPPED} skipped in ${fmtMs(rep.elapsed_ms || 0)} · ${rep.mode === 'AI' ? 'with your AI slots' : 'MANUAL (no AI): nothing was sent to any AI'}.`),
      failed.length ? h('p', null, 'Each failed step below says what to do. Steps that needed a failed step were skipped.') : null),
    h('div', { class: 'form-actions' },
      pid ? h('a', { class: 'btn primary', href: link('p', pid, 'main'), onclick: () => closeSelfTest() }, 'Open the Self-test project') : null,
      h('button', { type: 'button', onclick: async () => {
        clear(viewOut).appendChild(loadingState('Loading the report…'));
        try {
          const blob = await api('GET', '/selftest/report?format=md', { blob: true });
          const text = await blob.text();
          clear(viewOut).appendChild(h('section', { 'aria-label': 'Self-test report' }, h('pre', { class: 'st-report', tabindex: '0' }, text)));
          viewOut.querySelector('pre').focus();
        } catch (e) { clear(viewOut).appendChild(failedState('The report could not be loaded', e)); }
      } }, 'View report'),
      h('button', { type: 'button', onclick: async () => {
        try {
          const blob = await api('GET', '/selftest/report?format=md&download=1', { blob: true });
          const url = URL.createObjectURL(blob);
          const a = h('a', { href: url, download: (rep.files && rep.files.markdown) || 'bookforge-selftest.md' });
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          announce('Report downloaded');
        } catch (e) { clear(viewOut).appendChild(failedState('The report could not be downloaded', e)); }
      } }, 'Download report (.md)'),
      h('button', { type: 'button', onclick: () => renderSelfTestIntro(st) }, 'Run again')),
    rep.files && rep.files.markdown ? h('p', { class: 'small muted' }, `Saved as ${rep.files.markdown} and ${rep.files.json} in the “reports” folder of your BookForge data.`) : null,
    viewOut,
    h('h3', null, 'Steps'),
    h('ol', { class: 'st-steps' }, rep.steps.map(stStepItem)));
  announce(ok ? 'Test finished: everything passed' : `Test finished: ${failed.length} step(s) failed`);
  const first = d.querySelector('.form-actions a, .form-actions button');
  if (first) first.focus();
  return d;
}

async function refreshSelfTestButton() {
  const el = $('#selftest-btn-state'); if (!el) return;
  try {
    const st = await api('GET', '/selftest');
    el.textContent = st.running && st.progress ? ` (${st.progress.done}/${st.progress.total})` : '';
    const dot = $('#more-dot'); if (dot) dot.hidden = !st.running;
    if (st.running && !(ST.dialog && ST.dialog.open)) setTimeout(refreshSelfTestButton, 2000);
  } catch { el.textContent = ''; }
}

function initSelfTestButton() {
  const btn = $('#selftest-btn'); if (!btn) return;
  btn.addEventListener('click', openSelfTest);
  const d = $('#selftest-dialog');
  d.addEventListener('cancel', ev => { ev.preventDefault(); closeSelfTest(); });  // Esc
  d.addEventListener('close', () => { stopSelfTestPolling(); refreshSelfTestButton(); });
}

/* ======================================================================= info pop-ups */
let openTip = null;
function infoTip(label, ...content) {
  const id = uid('tip');
  const pop = h('div', { class: 'info-pop', id, role: 'note', hidden: true }, h('strong', { class: 'info-title' }, label), ...content);
  const btn = h('button', { type: 'button', class: 'info-btn', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': `What is this: ${label}` }, 'ⓘ');
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (openTip === close) openTip = null; };
  btn.addEventListener('click', ev => {
    ev.preventDefault(); ev.stopPropagation();
    const show = pop.hidden;
    if (openTip) openTip();
    if (show) { pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); openTip = close; }
  });
  pop.addEventListener('keydown', ev => { if (ev.key === 'Escape') { close(); btn.focus(); } });
  btn.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !pop.hidden) { ev.stopPropagation(); close(); } });
  return h('span', { class: 'info-wrap' }, btn, pop);
}
document.addEventListener('click', ev => { if (openTip && !ev.target.closest('.info-wrap')) openTip(); });
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && openTip) openTip(); });

const TIP_AUTOINJECTOR = () => [
  h('p', null, 'AutoInjector is a separate desktop app on this computer. You log in to ChatGPT, Claude and Gemini inside it, the same way you would in a browser.'),
  h('p', null, 'When its “BookForge bridge” is switched on, BookForge can hand it a writing job; AutoInjector types it into the logged-in site and passes the answer back. No API key or extra subscription is needed.'),
  h('p', null, 'Both apps talk only on this computer (127.0.0.1); nothing is opened to the internet.')];
const TIP_KEY = () => [
  h('p', null, 'The connection key is a private password that AutoInjector makes so that only your BookForge can use it. It is not your ChatGPT, Claude or Gemini password.'),
  h('p', null, h('strong', null, 'Where to find it: '), 'In AutoInjector: BookForge bridge panel → Copy connection key. Then paste it here and press Connect.'),
  h('p', null, 'BookForge saves it in a private file on this computer (never in your projects, exports or reports) and never shows it again. If AutoInjector makes a new key, paste the new one here.')];
const TIP_TEST = () => [
  h('p', null, 'Test connection asks AutoInjector “are you there, and is this site logged in and free?”. It sends no book content and costs nothing.'),
  h('p', null, 'It tells you where things stand — not set up, ready, busy, or the exact problem — and what to do next.')];
const TIP_URL = () => [
  h('p', null, 'The address where AutoInjector listens on this computer. Leave it at ' + BRIDGE_DEFAULT + ' unless AutoInjector shows a different one.')];

/* slot status strip: where it's at -> what to do next */
function slotStage(s, health) {
  const site = s.site ? (AI_SITES.find(x => x[0] === s.site) || [s.site, s.site])[1] : 'the site';
  if (s.adapter_id === 'none') return { icon: '○', word: 'Not set up', cls: 'b-muted', now: 'This slot is off. Creative steps use text you write yourself.', next: 'To use AI here: press “Connect AutoInjector” above (with the connection key), or choose an adapter below and save.' };
  if (s.adapter_id === 'manual') return { icon: '✎', word: 'Manual', cls: 'b-muted', now: 'You write the candidates yourself; no AI is used.', next: 'Nothing to do. Choose another adapter if you want AI help.' };
  if (s.adapter_id === 'anthropic') {
    return s.has_credentials
      ? { icon: '✔', word: 'Ready', cls: 'b-ok', now: `Uses the Anthropic API (model ${s.model}). An API key is available.`, next: 'Nothing to do. Use “Test everything” with “Use my AI slots too” for a real end-to-end check.' }
      : { icon: '⚠︎', word: 'Needs API key', cls: 'b-warn', now: 'Set to the Anthropic API, but no API key is saved.', next: 'Paste an API key in “New API key” below and save.' };
  }
  if (!s.has_credentials) return { icon: '⚠︎', word: 'Needs connection key', cls: 'b-warn', now: `Set to use ${site} through AutoInjector, but no connection key is saved.`, next: 'In AutoInjector: BookForge bridge panel → Copy connection key, then paste it into “Connect AutoInjector” above.' };
  if (!health) return { icon: '…', word: 'Checking', cls: 'b-info', now: 'Asking AutoInjector whether it is running…', next: 'Wait a moment.' };
  if (health.ok && (health.site_busy || s.active_jobs > 0)) return { icon: '◔', word: 'Busy', cls: 'b-warn', now: `Connected. ${site} is working on another request right now.`, next: 'Nothing to fix — wait for it to finish. BookForge sends one request at a time per site.' };
  if (health.ok) return { icon: '✔', word: 'Connected · Ready', cls: 'b-ok', now: `Connected to AutoInjector. ${site} is logged in and free.`, next: 'Ready to use. Try “Test everything” with “Use my AI slots too”.' };
  const err = health.error;
  let next = 'Press Test connection again. If it keeps failing, restart the AutoInjector desktop app.';
  let now = health.message || 'The connection check failed.';
  if (err === 'UPSTREAM_UNAVAILABLE') { now = `AutoInjector is not answering at ${s.bridge_url}.`; next = 'Start the AutoInjector desktop app and switch on its BookForge bridge, then press Test connection.'; }
  else if (err === 'CAPABILITY_UNAVAILABLE') { now = 'AutoInjector did not accept the saved connection key (or does not offer this site).'; next = 'In AutoInjector: BookForge bridge panel → Copy connection key, paste it into “Connect AutoInjector” above, then Test connection.'; }
  else if (err === 'TIMEOUT') { now = 'AutoInjector did not answer in time.'; next = 'Check that the AutoInjector desktop app is running and not stuck, then Test connection.'; }
  else if (health.site_ready === false) { now = `AutoInjector is running, but the ${site} pane is not ready.`; next = `In AutoInjector, open the ${site} pane and log in, then Test connection.`; }
  return { icon: '✕', word: 'Error', cls: 'b-bad', now, next };
}
function slotStatusStrip(s) {
  const box = h('div', { class: 'slot-strip', role: 'status', 'aria-live': 'polite' });
  const draw = health => {
    const st = slotStage(s, health);
    clear(box).appendChild(h('div', { class: 'row' }, badge(st.icon, st.word, st.cls),
      ['b-bad', 'b-warn'].includes(st.cls) ? hazard({ code: (health && health.error) || 'CAPABILITY_UNAVAILABLE', message: st.now, fix: st.next, where: { step: `Settings › AI slot ${s.slot_id}` } }, { retry: () => check(), retryLabel: '🔁 Test connection', settings: false }) : null,
      h('span', null, h('strong', null, 'Where it’s at: '), st.now)));
    box.appendChild(h('p', { class: 'small slot-next' }, h('strong', null, 'Next step: '), st.next));
  };
  const check = async () => {
    if (s.adapter_id !== 'autoinjector' || !s.has_credentials) { draw(null); return; }
    draw(null);
    try { draw(await api('GET', `/slots/${encodeURIComponent(s.slot_id)}/health`)); }
    catch (e) { draw({ ok: false, error: 'CHECK_FAILED', message: (e && e.message) || 'check failed' }); }
  };
  box.recheck = check;
  box.redraw = draw;
  check();
  return box;
}

/* ======================================================================= AI pickers (shared) */
const SITE_NAME = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
const PLACEHOLDER = {
  A01: 'a grumpy lighthouse keeper who hides a secret', A02: 'a tide-dwelling species that sings to navigate',
  A03: 'a storm-wrapped archipelago world with two moons', A04: 'a fog-bound harbor town built on stilts',
  A05: 'a council of harbor masters that rules by tide law', A06: 'a smugglers’ guild hiding in plain sight',
  A07: 'a fishing culture that names its boats after the dead', A08: 'a faith that worships the lighthouse flame',
  A09: 'magic paid for with memories, limited by moonlight', A10: 'clockwork lanterns that store sunlight',
  A11: 'harpoon duelling with strict honour rules', A12: 'a brass key that opens any lock exactly once',
  A13: 'the night the great lighthouse went dark', A14: 'the order of the founding events',
  A15: 'naming rules for island families', A16: 'an economy built on salt and lamp oil',
  A17: 'laws about salvage from shipwrecks', A18: 'two rival keepers who were once best friends',
  B01: 'a lighthouse keeper’s apprentice searches for her missing master',
};
const SECTION_LABEL = {
  A01: 'Characters', A02: 'Species', A03: 'Worlds', A04: 'Locations', A05: 'Governments', A06: 'Factions & organizations',
  A07: 'Cultures', A08: 'Religions', A09: 'Magic / power systems', A10: 'Technology', A11: 'Weapons & combat',
  A12: 'Items & artifacts', A13: 'History & events', A14: 'Timeline', A15: 'Languages & names', A16: 'Economy',
  A17: 'Laws', A18: 'Relationships',
};
const BIBLE_STARTER = { A01: 4, A04: 3, A03: 1, A07: 1, A05: 1, A09: 1, A10: 1 };

function slotName(s) {
  if (s.adapter_id === 'autoinjector') return `${SITE_NAME[s.site] || s.site || 'web'} (AutoInjector)`;
  if (s.adapter_id === 'anthropic') return 'Claude (Anthropic API)';
  if (s.adapter_id === 'manual') return 'Manual (no AI)';
  return 'not set up';
}
async function loadSlotChoices(force) {
  if (!force && S.slotCache && Date.now() - S.slotCache.at < 30000) return S.slotCache.list;
  const slots = await api('GET', '/slots');
  const list = slots.map(s => ({ s, health: null }));
  await Promise.all(list.map(async x => {
    if (x.s.adapter_id !== 'autoinjector' || !x.s.has_credentials) return;
    try { x.health = await api('GET', `/slots/${encodeURIComponent(x.s.slot_id)}/health`); }
    catch (e) { x.health = { ok: false, error: 'CHECK_FAILED', message: (e && e.message) || 'check failed' }; }
  }));
  S.slotCache = { at: Date.now(), list };
  return list;
}
/** "Which AI" select: Auto + AI-1..AI-3 with each slot's current state in words. */
function aiPicker(id, initial) {
  const sel = h('select', { id, 'aria-describedby': `${id}-h` }, h('option', { value: '' }, 'Auto — the best ready AI'));
  const hint = h('span', { class: 'hint', id: `${id}-h` }, 'Checking your AI slots…');
  const field = h('div', { class: 'field' },
    h('span', { class: 'label-row' }, h('label', { for: id }, 'Which AI'), infoTip('Which AI should I pick?', ...TIP_PICKER())),
    sel, hint);
  (async () => {
    try {
      const list = await loadSlotChoices();
      let ready = 0;
      for (const { s, health } of list) {
        const st = slotStage(s, health);
        const usable = !['none', 'manual'].includes(s.adapter_id);
        if (usable && st.cls !== 'b-bad') ready++;
        sel.appendChild(h('option', { value: s.slot_id, disabled: !usable, selected: initial === s.slot_id },
          `${s.slot_id} · ${slotName(s)} — ${st.icon} ${st.word}`));
      }
      hint.textContent = ready
        ? 'Auto uses the cheapest ready slot (and any slot whose roles name this module). Web AIs answer one request at a time.'
        : 'No AI is ready yet. Open Settings to connect AutoInjector or add an API key — or write the entry yourself.';
      if (!ready) hint.appendChild(h('span', null, ' ', h('a', { href: '#/settings' }, 'Open Settings')));
    } catch (e) { hint.textContent = 'Could not read your AI slots; Auto will still try.'; }
  })();
  return { field, sel, value: () => sel.value || null };
}
function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function errorWithFix(title, err, retry) {
  err = err || {};
  const pr = toProblem({ code: err.code, message: err.message, fix: err.fix, path: err.path });
  return stateBox('failed', title,
    h('p', null, hazard(pr, { retry: retry || null }), ' ', h('strong', null, pr.title), ' — ', err.message || 'Something went wrong.'),
    err.fix ? h('p', null, h('strong', null, 'What to do: '), err.fix) : null,
    h('div', { class: 'row' },
      retry ? h('button', { type: 'button', class: 'primary small', onclick: retry }, 'Try again') : null,
      ['CAPABILITY_UNAVAILABLE', 'UPSTREAM_UNAVAILABLE', 'TIMEOUT'].includes(err.code) || !err.code
        ? h('a', { class: 'btn small', href: '#/settings' }, 'Open Settings') : null,
      err.code ? h('code', { class: 'small muted' }, err.code) : null));
}
function apiErrInfo(e) {
  const x = (e instanceof ApiError && e.errors[0]) || {};
  return { code: x.code || 'NETWORK', message: x.message || (e && e.message) || String(e), fix: x.fix || (e instanceof NetworkError ? 'Check that BookForge is still running, then try again.' : '') };
}

/* ======================================================================= Fill with AI panels */
const AP = { panels: new Map() };

function openAssistPanel(opId, opener) {
  const key = `${S.pid}|${S.branch}|${opId}`;
  let p = AP.panels.get(key);
  if (!p) { p = buildAssistPanel(opId, S.pid, S.branch, S.project ? S.project.name : ''); AP.panels.set(key, p); $('#ai-dock').appendChild(p.el); }
  p.opener = opener || null;
  p.setMin(false);
  syncDock();
  p.focusFirst();
}
/** While a panel is open the dock is a column beside the page (wide screens) or a short sheet (narrow ones), and
 *  the page makes room for it, so the panel never covers the form it fills. */
function syncDock() {
  const panels = [...AP.panels.values()];
  $('#ai-dock').classList.toggle('has-panels', panels.length > 0);
  document.body.classList.toggle('ai-docked', panels.some(p => !p.min));
}

function buildAssistPanel(opId, pid, branch, projectName) {
  const op = S.opsById[opId];
  const id = uid('ap');
  const p = { op: opId, pid, branch, job: null, timer: null, poll: null, startedAt: 0, opener: null, last: null, min: false };
  const statusBadge = h('span', { class: 'ap-state' }, badge('○', 'Ready', 'b-muted'));
  const body = h('div', { class: 'ap-body', id: `${id}-body` });
  const minBtn = h('button', { type: 'button', class: 'small', 'aria-expanded': 'true', 'aria-controls': `${id}-body`,
    onclick: () => p.setMin(!p.min) }, 'Minimize');
  const closeBtn = h('button', { type: 'button', class: 'small', 'aria-label': `Close Fill with AI for ${opId}`, onclick: () => p.close() }, '✕');
  const el = h('section', { class: 'ap', role: 'region', 'aria-labelledby': `${id}-t` },
    h('header', { class: 'ap-head' },
      h('h2', { id: `${id}-t` }, h('span', { 'aria-hidden': 'true' }, '✨ '), `${opId} ${op ? op.name : ''}`,
        h('span', { class: 'small muted ap-proj' }, ` · ${projectName}${branch !== 'main' ? ' / ' + branch : ''}`)),
      statusBadge, h('div', { class: 'ap-tools' }, minBtn, closeBtn)),
    body);
  el.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !ev.target.closest('.info-wrap')) { ev.stopPropagation(); p.setMin(true); if (p.opener && document.contains(p.opener)) p.opener.focus(); }
  });
  p.el = el;
  p.setMin = min => {
    p.min = min; body.hidden = min; el.classList.toggle('min', min);
    minBtn.textContent = min ? 'Show' : 'Minimize'; minBtn.setAttribute('aria-expanded', String(!min));
    syncDock();
  };
  p.close = () => {
    if (p.job && ['queued', 'running'].includes(p.job.status) && !confirm('The AI is still working on this. Stop it and close the panel?')) return;
    if (p.job && ['queued', 'running'].includes(p.job.status)) api('POST', `/assist/${encodeURIComponent(p.job.job_id)}/cancel`).catch(() => {});
    clearInterval(p.timer); clearTimeout(p.poll);
    el.remove(); AP.panels.delete(`${pid}|${branch}|${opId}`);
    syncDock();
    if (p.opener && document.contains(p.opener)) p.opener.focus();
  };
  p.setState = (icon, word, cls) => clear(statusBadge).appendChild(badge(icon, word, cls));

  // ---- form
  const prompt = h('textarea', { id: `${id}-prompt`, rows: '3', placeholder: `e.g. ${PLACEHOLDER[opId] || 'describe what you want'}`, 'aria-describedby': `${id}-prompt-h` });
  const picker = aiPicker(`${id}-slot`);
  const keep = h('input', { type: 'checkbox', id: `${id}-keep`, checked: true, 'aria-describedby': `${id}-keep-h` });
  const ctxBox = h('div', { class: 'ap-ctx-list' });
  const ctxSummary = h('summary', null, 'Use existing records as context (optional)');
  const ctxDetails = h('details', { class: 'ap-ctx' }, ctxSummary,
    h('p', { class: 'hint' }, 'Approved Set A records are always sent as a short summary so the new entry fits your world. Tick records here to send them in full (up to 20).'), ctxBox);
  const fillCtx = () => {
    clear(ctxBox);
    const recs = (S.pid === pid && S.branch === branch ? S.records : []).filter(r => r.record_kind === 'OUTPUT' && (r.module_id[0] === 'A' || r.module_id === 'B01'));
    if (!recs.length) { ctxBox.appendChild(h('p', { class: 'small muted' }, 'No universe records on this branch yet.')); return; }
    for (const r of recs.slice(0, 200)) {
      const cid = uid('ctx');
      ctxBox.appendChild(h('div', { class: 'check-row' }, h('input', { type: 'checkbox', id: cid, 'data-rid': r.record_id }),
        h('label', { for: cid }, `${r.module_id} · ${recordTitle(r)}`, h('span', { class: 'small muted' }, ` (${LIFECYCLE[r.lifecycle] ? LIFECYCLE[r.lifecycle][1] : r.lifecycle})`))));
    }
  };
  ctxDetails.addEventListener('toggle', () => { if (ctxDetails.open) fillCtx(); });
  ctxBox.addEventListener('change', () => {
    const n = ctxBox.querySelectorAll('input:checked').length;
    ctxSummary.textContent = `Use existing records as context (optional)${n ? ` — ${n} picked` : ''}`;
  });
  const genBtn = h('button', { type: 'button', class: 'primary' }, '✨ Generate');
  const out = h('div', { class: 'ap-out', 'aria-live': 'polite' });
  const formErr = h('div');
  const formPart = h('div', { class: 'ap-form' });
  const reqText = h('q');
  const reqLine = h('p', { class: 'ap-req small', hidden: true }, h('strong', null, 'Your request:'), reqText,
    h('button', { type: 'button', class: 'link', onclick: () => { formPart.hidden = false; reqLine.hidden = true; prompt.focus(); } }, 'Change request'));
  body.appendChild(reqLine);
  body.appendChild(formPart);
  const body0 = body;
  { const body = formPart;
  body.appendChild(h('p', { class: 'small' }, `Describe the ${op ? op.name.toLowerCase() : 'entry'} you want. The AI fills the ${opId} form; you review it and press Create yourself. Nothing is saved before that.`));
  body.appendChild(h('div', { class: 'field' }, h('label', { for: prompt.id }, 'What should the AI create?'), prompt,
    h('span', { class: 'hint', id: `${id}-prompt-h` }, 'A sentence or two is enough. Name anything that must be true.')));
  body.appendChild(picker.field);
  body.appendChild(ctxDetails);
  body.appendChild(h('div', { class: 'check-row' }, keep, h('label', { for: keep.id }, 'Keep what I already typed in the form')));
  body.appendChild(h('p', { class: 'hint', id: `${id}-keep-h` }, 'On: the AI only fills the empty fields. Off: it may rewrite the text fields (your links and protected-fact choices are always kept).'));
  body.appendChild(formErr);
  body.appendChild(h('div', { class: 'form-actions' }, genBtn));
  }
  body0.appendChild(out);
  p.setPrompt = text => {
    if (p.job && ['queued', 'running'].includes(p.job.status)) { toast('This panel is still working; wait for it, then paste again.'); return; }
    formPart.hidden = false; reqLine.hidden = true;
    prompt.value = String(text).slice(0, 8000); prompt.focus();
    toast('Pasted as the request — press Generate');
  };
  p.focusFirst = () => { if (!p.min) (p.job && p.job.status === 'done' ? (out.querySelector('button') || prompt) : prompt).focus(); };

  const pickedRefs = () => Array.from(ctxBox.querySelectorAll('input:checked')).map(i => recordById(i.dataset.rid)).filter(Boolean).map(r => r.ref).slice(0, 20);
  const currentValues = () => { const f = S.assistForms[`${pid}|${branch}|${opId}`]; try { return f ? f() : {}; } catch { return {}; } };

  const start = async () => {
    clear(formErr);
    if (!prompt.value.trim()) {
      prompt.setAttribute('aria-invalid', 'true');
      formErr.appendChild(stateBox('failed', 'Type what you want first', h('p', null, `For example: “${PLACEHOLDER[opId] || 'a short description'}”.`)));
      prompt.focus(); return;
    }
    prompt.removeAttribute('aria-invalid');
    genBtn.disabled = true;
    const cv = currentValues();
    try {
      p.job = await api('POST', '/assist', { body: { project_id: pid, branch_id: branch, target_operation: opId, prompt: prompt.value.trim(),
        slot_id: picker.value(), context_refs: pickedRefs(), current_values: cv, keep_values: keep.checked } });
      p.startedAt = Date.now();
      reqText.textContent = prompt.value.trim().length > 140 ? prompt.value.trim().slice(0, 137) + '…' : prompt.value.trim();
      formPart.hidden = true; reqLine.hidden = false;
      renderRunning();
      announce(`${opId}: asking the AI`);
      pollJob();
    } catch (e) {
      genBtn.disabled = false;
      clear(out).appendChild(errorWithFix('The AI was not asked', apiErrInfo(e), start));
      p.setState('✕', 'Error', 'b-bad');
    }
  };
  genBtn.addEventListener('click', start);
  prompt.addEventListener('keydown', ev => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) start(); });

  const runLine = h('strong'); const clock = h('span', { class: 'mono' });
  const renderRunning = () => {
    p.setState('◔', 'Working', 'b-info');
    clear(out).appendChild(h('div', { class: 'state loading', role: 'status' },
      h('p', { class: 'row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), runLine, clock),
      h('p', { class: 'small' }, 'Web AIs (ChatGPT, Claude, Gemini through AutoInjector) can take a few minutes. You can keep working or open other panels — this one keeps running.'),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'small', onclick: cancel }, 'Cancel'))));
    tick();
    clearInterval(p.timer); p.timer = setInterval(tick, 1000);
  };
  const tick = () => {
    const j = p.job || {};
    const phase = j.phase && j.phase !== 'Waiting to start' ? j.phase : 'Starting';
    runLine.textContent = `${phase}… `;
    clock.textContent = fmtClock(Date.now() - p.startedAt);
  };
  const cancel = async () => {
    if (!p.job) return;
    try { p.job = await api('POST', `/assist/${encodeURIComponent(p.job.job_id)}/cancel`); } catch { /* the poll shows the outcome */ }
    runLine.textContent = 'Cancelling… ';
  };
  const pollJob = async () => {
    clearTimeout(p.poll);
    if (!p.job) return;
    try { p.job = await api('GET', `/assist/${encodeURIComponent(p.job.job_id)}`); }
    catch (e) { p.poll = setTimeout(pollJob, 2500); return; }
    if (['queued', 'running'].includes(p.job.status)) { tick(); p.poll = setTimeout(pollJob, 1000); return; }
    clearInterval(p.timer); genBtn.disabled = false;
    if (p.job.status === 'done') renderDone(p.job);
    else if (p.job.status === 'cancelled') {
      p.setState('–', 'Cancelled', 'b-muted');
      clear(out).appendChild(stateBox('empty', 'Cancelled', h('p', null, 'Nothing was saved. Press Generate to try again.')));
      announce(`${opId}: cancelled`);
    } else {
      p.setState('✕', 'Error', 'b-bad');
      clear(out).appendChild(errorWithFix('The AI could not fill the form', p.job.error, start));
      announce(`${opId}: the AI could not fill the form. ${(p.job.error || {}).fix || ''}`);
    }
  };
  const renderDone = j => {
    const blocking = (j.findings || []).filter(f => f.severity === 'BLOCKING' && f.decision !== 'PASS');
    p.setState('✔', 'Proposal ready', 'b-ok');
    const preview = h('div', { class: 'data-view ap-preview' }, renderData(j.proposal, ''));
    const useBtn = h('button', { type: 'button', class: 'primary', onclick: () => useProposal(p, j) }, 'Use this in the form');
    const copyBtn = h('button', { type: 'button', onclick: () => copyText(JSON.stringify(j.proposal, null, 2), 'Proposal copied as JSON') }, '📋 Copy');
    const regen = h('button', { type: 'button', onclick: start }, 'Regenerate');
    clear(out).appendChild(h('div', { class: 'ap-done' },
      stateBox('ok', `Proposal ready from ${j.slot || 'AI'}${j.slot_label ? ' · ' + j.slot_label : ''} in ${fmtClock(j.elapsed_ms || 0)}`,
        h('p', null, 'Not saved yet. ', (j.filled_fields || []).length ? `AI filled: ${j.filled_fields.map(humanize).join(', ')}. ` : '',
          (j.kept_fields || []).length ? `Kept yours: ${j.kept_fields.map(humanize).join(', ')}.` : ''),
        blocking.length ? h('p', null, h('strong', null, `${blocking.length} problem(s) to fix before approval — see Checks below. `), 'You can still use it in the form and fix them there.') : null),
      h('div', { class: 'row' }, useBtn, regen, copyBtn),
      (j.removed_refs || []).length ? stateBox('stale', `Removed ${j.removed_refs.length} link(s) the AI made up`,
        h('ul', null, j.removed_refs.map(r => h('li', null, `${r.module_id || '?'} ${r.record_id || ''} at ${r.path}: ${r.reason}`))),
        h('p', { class: 'small' }, 'Links are only kept when they point to real records in this project. Add the right ones in the form.')) : null,
      h('h3', null, 'Preview'), preview,
      (j.findings || []).length ? h('details', { open: blocking.length > 0 }, h('summary', null, `Checks (${j.findings.length})`), findingList(j.findings)) : h('p', { class: 'small muted' }, '✔ No problems found by the checks.'),
      h('details', null, h('summary', null, 'JSON'), h('pre', null, JSON.stringify(j.proposal, null, 2)))));
    announce(`${opId}: proposal ready. Use this in the form, Regenerate or Copy.`);
    if (!p.min && el.contains(document.activeElement)) useBtn.focus();
  };
  return p;
}

function useProposal(p, j) {
  p.setMin(true);
  fillNewForm(p.pid, p.branch, p.op, j.proposal,
    { from_ai: { slot: j.slot, label: `${j.slot || ''}${j.slot_label ? ' · ' + j.slot_label : ''}`, job_id: j.job_id } },
    `${p.op} form filled from the AI proposal — review it and press Create`);
}

/**
 * Open the New form of an operation pre-filled with `payload` (nothing is submitted).
 * extra: {from_ai|from_copy|from_paste: {...}, manual, manualOn} shown as a notice above the form.
 */
function fillNewForm(pid, branch, opId, payload, extra = {}, message = null) {
  const draftKey = `bf:draft:${pid}:${branch}:${opId}:new`;
  const draft = Object.assign({ payload: payload || {}, manualOn: false, pending: {}, saved_at: new Date().toISOString() }, extra);
  S.skipSaveKeys.add(draftKey);         // the view being left must not overwrite this draft
  S.prefill.set(draftKey, draft);       // works even when browser storage is unavailable
  saveJSON(draftKey, draft);            // best effort: survives a reload
  S.pendingFocus = 'new';
  const target = link('p', pid, branch, 'op', opId);
  if (location.hash === target) route(); else location.hash = target;
  const msg = message || `${opId} form filled — review it and press Create`;
  toast(msg);
  announce(`${msg}. Nothing has been saved yet.`);
}
function takePrefill(key) {
  if (!S.prefill.has(key)) return null;
  const d = S.prefill.get(key); S.prefill.delete(key);
  return d;
}

/* ======================================================================= Bible Builder */
const BB = { dialog: null, opener: null, session: null, poll: null, keep: {}, edits: {}, editing: null, sig: '', rows: {}, sectionsInfo: null, created: null, idea: null, picker: null, view: null };

function initBibleButton() {
  const btn = $('#bible-btn'); if (!btn) return;
  btn.addEventListener('click', ev => openBible(ev.currentTarget));
  const d = $('#bible-dialog');
  d.addEventListener('cancel', ev => { ev.preventDefault(); if (!ev.target.closest || !ev.target.closest('.info-wrap')) closeBible(); });
  d.addEventListener('close', () => { clearTimeout(BB.poll); });
}
async function openBible(opener) {
  const d = $('#bible-dialog');
  BB.dialog = d; BB.opener = visibleOpener(opener || document.activeElement);
  if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  clear(d);
  if (!S.pid || parseRoute()[0] !== 'p') {
    bbShell(h('p', null, 'Open a project first: the Bible Builder adds drafts to the project and branch you are working in.'),
      h('div', { class: 'form-actions' }, h('a', { class: 'btn primary', href: '#/', onclick: closeBible }, 'Go to projects')));
    return;
  }
  bbShell(loadingState('Loading the Bible Builder…'));
  try {
    const r = await api('GET', `/bible-builder?project_id=${encodeURIComponent(S.pid)}&branch_id=${encodeURIComponent(S.branch)}`);
    BB.sectionsInfo = r.sections;
    if (!BB.session || BB.session.project_id !== S.pid || BB.session.branch_id !== S.branch) {
      BB.session = r.session; BB.keep = {}; BB.edits = {}; BB.created = null; BB.sig = '';
    } else if (r.session && r.session.session_id === BB.session.session_id) BB.session = r.session;
    renderBible();
    if (BB.session && BB.session.busy) bbPoll();
  } catch (e) { bbShell(failedState('The Bible Builder could not open', e)); }
}
function closeBible() {
  const d = BB.dialog; if (!d) return;
  clearTimeout(BB.poll);
  if (d.open) { if (d.close) d.close(); else d.removeAttribute('open'); }
  if (BB.opener && document.contains(BB.opener)) BB.opener.focus();
}
function bbShell(...body) {
  const d = clear(BB.dialog);
  d.appendChild(h('div', { class: 'st-head' },
    h('h2', { id: 'bible-title' }, h('span', { 'aria-hidden': 'true' }, '📖 '), 'Bible Builder', h('span', { class: 'small muted' }, S.project ? ` · ${S.project.name}${S.branch !== 'main' ? ' / ' + S.branch : ''}` : '')),
    h('button', { type: 'button', class: 'small', 'aria-label': 'Close the Bible Builder (running work continues)', onclick: closeBible }, '✕ Close')));
  append(d, body);
  return d;
}
function bbItems() { return (BB.session && BB.session.items) || []; }
function bbSig(s) { return s ? JSON.stringify([s.items.map(i => [i.key, i.status, i.name, !!i.created_ref, i.elapsed_ms]), (s.report || {}).markdown]) : ''; }

function renderBible() {
  const s = BB.session;
  const sections = (s && s.available_sections) || BB.sectionsInfo || [];
  const ideaId = 'bb-idea';
  const idea = h('textarea', { id: ideaId, rows: '3', placeholder: 'e.g. A lighthouse keeper’s apprentice searches a stormy archipelago for her missing master, and finds the islands’ magic is fading.', 'aria-describedby': `${ideaId}-h` });
  idea.value = (s && s.idea) || BB.idea || loadJSON(`bf:bb-idea:${S.pid}`, '') || '';
  idea.addEventListener('input', () => { BB.idea = idea.value; saveJSON(`bf:bb-idea:${S.pid}`, idea.value); });
  BB.ideaEl = idea;
  BB.picker = aiPicker('bb-slot', s && s.slot_pref);
  const err = h('div', { 'aria-live': 'polite' });
  BB.err = err;
  // sections list
  const list = h('ul', { class: 'bb-sections', 'aria-label': 'Bible sections' });
  BB.rows = {};
  const secState = {};
  for (const x of (s && s.sections) || []) secState[x.op] = x;
  for (const sec of sections) {
    const rid = `bb-${sec.op}`;
    const tick = h('input', { type: 'checkbox', id: `${rid}-on`, disabled: !sec.enabled });
    const count = h('input', { type: 'number', id: `${rid}-n`, min: '0', max: '12', step: '1', value: String(BIBLE_STARTER[sec.op] && sec.enabled ? BIBLE_STARTER[sec.op] : 1), disabled: !sec.enabled, 'aria-label': `How many ${SECTION_LABEL[sec.op] || sec.name} to generate (0 = skip)`, class: 'bb-count' });
    const status = h('span', { class: 'bb-status small', id: `${rid}-st` });
    const go = h('button', { type: 'button', class: 'small', disabled: !sec.enabled, 'aria-describedby': `${rid}-st`, onclick: () => bbRun({ [sec.op]: parseInt(count.value, 10) || 0 }, tick) }, 'Generate');
    count.addEventListener('input', () => { if ((parseInt(count.value, 10) || 0) > 0 && !tick.checked && document.activeElement === count) tick.checked = true; });
    BB.rows[sec.op] = { tick, count, status, go };
    list.appendChild(h('li', { class: `bb-row${sec.enabled ? '' : ' off'}` },
      h('div', { class: 'check-row bb-name' }, tick, h('label', { for: tick.id }, h('strong', null, SECTION_LABEL[sec.op] || sec.name), h('span', { class: 'small muted' }, ` ${sec.op} ${sec.name}`))),
      h('div', { class: 'bb-ctl' }, h('label', { for: count.id, class: 'small muted' }, 'How many'), count, go),
      sec.enabled ? status : h('span', { class: 'bb-status small' }, '– Off: ', sec.reason || 'disabled', ' · ', h('a', { href: plink('manifest'), onclick: closeBible }, 'turn magic on'))));
    bbSectionStatus(sec.op, secState[sec.op]);
  }
  const allBtn = h('button', { type: 'button', class: 'primary', onclick: () => {
    const counts = {};
    for (const [op, r] of Object.entries(BB.rows)) if (r.tick.checked && !r.tick.disabled) counts[op] = parseInt(r.count.value, 10) || 0;
    bbRun(counts);
  } }, 'Generate all ticked');
  const starter = h('button', { type: 'button', onclick: () => {
    const magic = BB.rows.A09 && !BB.rows.A09.tick.disabled;
    for (const [op, r] of Object.entries(BB.rows)) {
      const want = op === 'A09' ? magic : op === 'A10' ? !magic : op in BIBLE_STARTER;
      if (!r.tick.disabled) { r.tick.checked = want; if (want) r.count.value = String(BIBLE_STARTER[op]); }
    }
    announce('Starter set ticked: 4 characters, 3 places, a world, a culture, a government and a magic or technology system. Change anything, then Generate all ticked.');
  } }, 'Tick the starter set');
  const cancelBtn = h('button', { type: 'button', onclick: async () => {
    if (!BB.session) return;
    try { BB.session = await api('POST', `/bible-builder/${encodeURIComponent(BB.session.session_id)}/cancel`); bbUpdate(); } catch (e) { clear(err).appendChild(failedState('Could not cancel', e)); }
  } }, 'Stop after the current item');
  BB.cancelBtn = cancelBtn;
  BB.now = h('div', { class: 'bb-now', role: 'status' });
  BB.results = h('div', { class: 'bb-results' });
  BB.report = h('div', { class: 'bb-report' });
  bbShell(
    h('p', null, 'Have your AI draft the story bible: tick the sections you want and how many of each, then generate them one section at a time or all together. Later sections use the earlier ones (for example, characters made after places can live in them). You choose which entries to keep; they are saved as ', h('strong', null, 'drafts'), ' only when you press “Create selected as drafts”.'),
    h('div', { class: 'field' }, h('span', { class: 'label-row' }, h('label', { for: ideaId }, 'Your book idea'), infoTip('Why the idea?', ...TIP_BIBLE())), idea,
      h('span', { class: 'hint', id: `${ideaId}-h` }, 'A few sentences: who, where, what goes wrong. Every section is built to fit it.')),
    BB.picker.field,
    h('h3', null, 'Sections'),
    h('p', { class: 'small muted' }, 'Nothing is generated unless you tick it (or press its own Generate). 0 = skip.'),
    h('div', { class: 'row' }, starter, h('button', { type: 'button', onclick: () => { for (const r of Object.values(BB.rows)) r.tick.checked = false; } }, 'Untick all')),
    list, err,
    h('div', { class: 'form-actions bb-actions' }, allBtn, cancelBtn),
    BB.now, BB.results, BB.report);
  BB.sig = '';
  bbUpdate();
  if (!s || !s.items.length) idea.focus();
}

function bbSectionStatus(op, x) {
  const r = BB.rows[op]; if (!r) return;
  const st = x ? x.status : 'idle';
  const map = { idle: ['', '', ''], queued: ['…', 'Queued', 'b-muted'], running: ['◔', 'Working', 'b-info'], done: ['✔', 'Done', 'b-ok'],
    partial: ['◑', 'Partly done', 'b-warn'], error: ['✕', 'Error', 'b-bad'], cancelled: ['–', 'Stopped', 'b-muted'], skipped: ['–', 'Skipped', 'b-muted'] };
  const b = map[st] || ['?', st, 'b-muted'];
  clear(r.status);
  if (!x || st === 'idle') return;
  r.status.appendChild(badge(b[0], b[1], b[2]));
  r.status.appendChild(document.createTextNode(' ' + (x.message || '')));
  if (x.error && (st === 'error' || st === 'partial')) {
    r.status.appendChild(h('span', { class: 'bb-fix' }, ' What to do: ', x.error.fix || '', ' ',
      ['CAPABILITY_UNAVAILABLE', 'UPSTREAM_UNAVAILABLE', 'TIMEOUT'].includes(x.error.code) ? h('a', { href: '#/settings', onclick: closeBible }, 'Open Settings') : null));
  }
  r.go.disabled = r.tick.disabled || st === 'queued' || st === 'running';
}

async function bbRun(counts, tickEl) {
  const err = BB.err; clear(err);
  const idea = (BB.ideaEl.value || '').trim();
  if (!idea) {
    BB.ideaEl.setAttribute('aria-invalid', 'true');
    err.appendChild(stateBox('failed', 'Describe your book idea first', h('p', null, 'Every section is generated to fit it.'))); BB.ideaEl.focus(); return;
  }
  BB.ideaEl.removeAttribute('aria-invalid');
  const picked = Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
  if (!Object.keys(picked).length) {
    err.appendChild(stateBox('failed', 'Nothing to generate', h('p', null, 'Tick at least one section and set “How many” to 1 or more.'))); return;
  }
  try {
    const slot = BB.picker.value();
    if (!BB.session || BB.session.project_id !== S.pid || BB.session.branch_id !== S.branch) {
      BB.session = await api('POST', '/bible-builder', { body: { project_id: S.pid, branch_id: S.branch, idea, counts: picked, slot_id: slot } });
    } else {
      BB.session = await api('POST', `/bible-builder/${encodeURIComponent(BB.session.session_id)}/run`, { body: { sections: picked, slot_id: slot, idea } });
    }
    BB.startedAt = Date.now();
    for (const op of Object.keys(picked)) if (BB.rows[op]) BB.rows[op].tick.checked = false;  // started: not re-run by "all ticked"
    announce(`Generating ${Object.entries(picked).map(([op, n]) => `${n} ${SECTION_LABEL[op] || op}`).join(', ')}`);
    bbUpdate(); bbPoll();
  } catch (e) { err.appendChild(errorWithFix('Could not start', apiErrInfo(e))); }
}

async function bbPoll() {
  clearTimeout(BB.poll);
  if (!BB.session || !BB.dialog || !BB.dialog.open) return;
  try { BB.session = await api('GET', `/bible-builder/${encodeURIComponent(BB.session.session_id)}`); }
  catch (e) { if (e instanceof ApiError && e.status === 404) { BB.session = null; renderBible(); return; } BB.poll = setTimeout(bbPoll, 2500); return; }
  const wasBusy = BB.wasBusy; BB.wasBusy = BB.session.busy;
  bbUpdate();
  if (BB.session.busy) BB.poll = setTimeout(bbPoll, 1000);
  else if (wasBusy) announce('Bible Builder: generation finished. Review the entries and choose which to create.');
}

function bbUpdate() {
  const s = BB.session;
  for (const x of (s && s.sections) || []) bbSectionStatus(x.op, x);
  if (BB.cancelBtn) BB.cancelBtn.hidden = !(s && s.busy);
  // live line
  clear(BB.now);
  if (s && s.busy && s.current) {
    BB.now.appendChild(h('div', { class: 'state loading' },
      h('p', { class: 'row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('strong', null, `${s.current.phase || 'Working'}…`),
        h('span', { class: 'mono' }, fmtClock(s.current.elapsed_ms || 0)),
        s.current.slot_label ? h('span', { class: 'small muted' }, `(${s.current.slot} · ${s.current.slot_label})`) : null),
      h('p', { class: 'small' }, 'Web AIs can take a few minutes per entry. You can close this window — the work continues; open the Bible Builder again to see it.'),
      s.queued_runs.length ? h('p', { class: 'small muted' }, `${s.queued_runs.length} more run(s) waiting.`) : null));
  }
  const sig = bbSig(s);
  if (sig !== BB.sig && !BB.editing) { BB.sig = sig; bbRenderResults(); bbRenderReport(); }
}

function bbRenderResults() {
  const box = clear(BB.results);
  const items = bbItems();
  if (!items.length) return;
  box.appendChild(h('h3', null, 'Generated entries'));
  box.appendChild(h('p', { class: 'small muted' }, 'Tick the entries to keep. Edit changes the proposal before it is saved. Links to other entries become real links when both are created.'));
  const byKey = Object.fromEntries(items.map(i => [i.key, i]));
  const order = Object.keys(SECTION_LABEL);
  for (const op of order) {
    const its = items.filter(i => i.op === op);
    if (!its.length) continue;
    const grid = h('ul', { class: 'bb-cards' });
    for (const it of its) grid.appendChild(bbCard(it, byKey));
    box.appendChild(h('section', { class: 'bb-group', 'aria-label': SECTION_LABEL[op] }, h('h4', null, `${SECTION_LABEL[op]} (${op})`), grid));
  }
  const selectable = items.filter(i => i.status === 'done' && !i.created_ref);
  const createBtn = h('button', { type: 'button', class: 'primary', disabled: !selectable.length || (BB.session && BB.session.busy) }, `Create selected as drafts`);
  const createOut = h('div', { 'aria-live': 'polite' });
  createBtn.addEventListener('click', async () => {
    const keys = selectable.filter(i => BB.keep[i.key] !== false).map(i => i.key);
    if (!keys.length) { clear(createOut).appendChild(stateBox('failed', 'Nothing selected', h('p', null, 'Tick at least one entry to keep.'))); return; }
    createBtn.disabled = true; clear(createOut).appendChild(loadingState(`Creating ${keys.length} draft(s)…`));
    try {
      const edits = Object.fromEntries(Object.entries(BB.edits).filter(([k]) => keys.includes(k)));
      const r = await api('POST', `/bible-builder/${encodeURIComponent(BB.session.session_id)}/create`, { body: { items: keys, edits } });
      BB.session = r.session; BB.created = r;
      try { await refreshRecords(); } catch { /* best effort */ }
      BB.sig = ''; bbUpdate();
      announce(`${r.created.length} draft(s) created${r.errors.length ? `, ${r.errors.length} failed` : ''}`);
      const h3 = BB.results.querySelector('.bb-created h3'); if (h3) { h3.setAttribute('tabindex', '-1'); h3.focus(); }
    } catch (e) { createBtn.disabled = false; clear(createOut).appendChild(errorWithFix('Nothing was created', apiErrInfo(e))); }
  });
  const nSel = selectable.filter(i => BB.keep[i.key] !== false).length;
  box.appendChild(h('div', { class: 'form-actions' }, createBtn,
    h('span', { class: 'small muted', id: 'bb-sel-count' }, `${nSel} of ${selectable.length} ready entr${selectable.length === 1 ? 'y' : 'ies'} selected`)));
  box.appendChild(createOut);
  if (BB.created) box.appendChild(bbCreatedSummary(BB.created));
}

function bbCard(it, byKey) {
  const cb = h('input', { type: 'checkbox', id: `bb-keep-${it.key}`, checked: BB.keep[it.key] !== false && it.status === 'done', disabled: it.status !== 'done' || !!it.created_ref });
  cb.addEventListener('change', () => {
    BB.keep[it.key] = cb.checked;
    const all = bbItems().filter(i => i.status === 'done' && !i.created_ref);
    const el = $('#bb-sel-count'); if (el) el.textContent = `${all.filter(i => BB.keep[i.key] !== false).length} of ${all.length} ready entr${all.length === 1 ? 'y' : 'ies'} selected`;
  });
  const st = { done: ['✔', 'Ready', 'b-ok'], running: ['◔', 'Generating', 'b-info'], pending: ['…', 'Waiting', 'b-muted'], queued: ['…', 'Queued', 'b-muted'],
    error: ['✕', 'Failed', 'b-bad'], cancelled: ['–', 'Stopped', 'b-muted'] }[it.status] || ['?', it.status, 'b-muted'];
  const prop = BB.edits[it.key] || it.proposal;
  const sum = it.summary || {};
  const blocking = (it.findings || []).filter(f => f.severity === 'BLOCKING' && f.decision !== 'PASS').length;
  const editBox = h('div', { class: 'bb-edit' });
  const links = (it.links || []).map(k => byKey[k]).filter(Boolean);
  const li = h('li', { class: `bb-card st-${it.status}` },
    h('div', { class: 'bb-card-head' },
      h('div', { class: 'check-row' }, cb, h('label', { for: cb.id }, h('strong', null, (prop && prop.concept) || it.name))),
      badge(st[0], st[1], st[2]), it.created_ref ? badge('✎', 'Draft created', 'b-info') : null, BB.edits[it.key] ? badge('✎', 'Edited', 'b-muted') : null),
    h('p', { class: 'small muted' }, `${it.key} · subject “${it.subject_id}”${it.elapsed_ms ? ` · ${fmtClock(it.elapsed_ms)}` : ''}${it.slot ? ` · ${it.slot}` : ''}`),
    it.role ? h('p', { class: 'small' }, it.role) : null,
    sum.summary ? h('p', { class: 'bb-summary' }, sum.summary.length > 220 ? sum.summary.slice(0, 217) + '…' : sum.summary) : null,
    (sum.key_facts || []).length ? h('ul', { class: 'bb-facts small' }, sum.key_facts.slice(0, 4).map(f => h('li', null, f))) : null,
    links.length ? h('p', { class: 'small' }, '↔ Links: ', links.map((l, i) => [i ? ', ' : '', `${l.name} (${l.key})`])) : null,
    blocking ? h('p', { class: 'small' }, badge('⚠︎', `${blocking} check(s) to fix before approval`, 'b-warn')) : null,
    (it.removed_refs || []).length ? h('p', { class: 'small' }, `⚠︎ Removed ${it.removed_refs.length} made-up link(s).`) : null,
    it.error ? h('p', { class: 'small bb-fix' }, h('strong', null, 'Why: '), it.error.message, it.error.fix ? [' — ', it.error.fix] : '') : null,
    it.created_ref ? h('p', { class: 'small' }, h('a', { href: recLink(it.created_ref), onclick: closeBible }, `Open draft ${it.created_ref.record_id}`)) : null,
    h('div', { class: 'row' },
      it.proposal && !it.created_ref ? h('button', { type: 'button', class: 'small', onclick: () => bbEdit(it, editBox) }, 'Edit') : null,
      it.proposal ? h('button', { type: 'button', class: 'small', onclick: () => copyText(JSON.stringify(prop, null, 2), 'Proposal copied as JSON') }, '📋 Copy') : null,
      !it.created_ref && ['done', 'error', 'cancelled'].includes(it.status) ? h('button', { type: 'button', class: 'small', onclick: () => bbRegenerate(it) }, 'Regenerate this one') : null,
      it.proposal ? h('details', { class: 'bb-json' }, h('summary', { class: 'small' }, 'Details'), h('div', { class: 'data-view small' }, renderData(prop, ''))) : null),
    editBox);
  return li;
}

async function bbEdit(it, box) {
  if (BB.editing && BB.editing !== it.key) { toast('Save or cancel the other edit first'); return; }
  BB.editing = it.key;
  const schema = await getSchema(it.op);
  const ctx = new FormCtx(`bbe-${it.key}`, schema.bindings);
  const node = buildNode(schema.create_payload, BB.edits[it.key] || it.proposal, '/payload', '', true, ctx, 0, { root: true });
  const summary = h('div');
  const done = () => { BB.editing = null; BB.sig = ''; bbUpdate(); const b = $(`#bb-keep-${it.key}`); if (b) b.focus(); };
  clear(box).appendChild(h('form', { class: 'bb-edit-form', novalidate: true, onsubmit: ev => {
    ev.preventDefault();
    const errs = []; const v = node.get(errs) || {};
    ctx.clearErrors(); clear(summary);
    if (errs.length) { showFormErrors(errs, [ctx], summary); return; }
    BB.edits[it.key] = v; announce(`${it.key} edits kept; they are used when you create the draft`); done();
  } }, h('h5', null, `Edit ${it.key}`), summary, node.el,
  h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary small' }, 'Keep these edits'),
    h('button', { type: 'button', class: 'small', onclick: done }, 'Cancel'),
    BB.edits[it.key] ? h('button', { type: 'button', class: 'small', onclick: () => { delete BB.edits[it.key]; done(); } }, 'Undo my edits') : null)));
  const f = firstFocusable(box); if (f) f.focus();
}

async function bbRegenerate(it) {
  const note = window.prompt(`Regenerate “${it.name}”. Optional: what should change? (leave empty to just try again)`, '');
  if (note === null) return;
  try {
    delete BB.edits[it.key];
    BB.session = await api('POST', `/bible-builder/${encodeURIComponent(BB.session.session_id)}/regenerate`, { body: { item: it.key, prompt: note || undefined, slot_id: BB.picker.value() } });
    announce(`Regenerating ${it.key}`); bbUpdate(); bbPoll();
  } catch (e) { clear(BB.err).appendChild(errorWithFix('Could not regenerate', apiErrInfo(e))); }
}

function bbCreatedSummary(r) {
  return h('section', { class: 'bb-created' },
    stateBox(r.errors.length ? 'stale' : 'ok', `${r.created.length} draft(s) created${r.errors.length ? `, ${r.errors.length} failed` : ''}`,
      r.created.length ? h('ul', null, r.created.map(c => h('li', null, h('a', { href: recLink(c.ref), onclick: closeBible }, `${c.op} · ${c.name}`), ` (${c.ref.record_id})`,
        c.links_made.length ? h('span', { class: 'small muted' }, ` — linked to ${c.links_made.map(l => l.name).join(', ')}`) : null,
        c.removed_refs.length ? h('span', { class: 'small muted' }, ` — ${c.removed_refs.length} made-up link(s) removed`) : null))) : null,
      r.errors.length ? h('ul', { class: 'error-list' }, r.errors.map(e => h('li', null, h('code', null, e.key), ' — ', e.message, e.fix ? ` What to do: ${e.fix}` : ''))) : null),
    h('h3', null, 'Next steps'),
    h('ol', { class: 'steps-list' },
      h('li', null, 'Open each new draft, read it, and press ', h('strong', null, 'Validate'), ' then ', h('strong', null, 'Accept'), ' to make it canon. Drafts are not approved yet.'),
      h('li', null, 'Then plan the book: ', h('a', { href: plink('op', 'B01'), onclick: closeBible }, 'B01 Premise/Concept Builder'), ' (it can use these records as canon references).')));
}

function bbRenderReport() {
  const box = clear(BB.report);
  const s = BB.session;
  if (!s || !s.report) return;
  const counts = { gen: 0, fail: 0, made: 0 };
  for (const i of s.items) { if (i.status === 'done') counts.gen++; if (i.status === 'error') counts.fail++; if (i.created_ref) counts.made++; }
  const out = h('div', { 'aria-live': 'polite' });
  box.appendChild(h('h3', null, 'Report'));
  box.appendChild(h('p', { class: 'small' }, `${s.runs.length} run(s): ${counts.gen} generated, ${counts.fail} failed, ${counts.made} created as drafts, ${counts.gen - counts.made} not created. Saved as ${s.report.markdown} in the “reports” folder of your BookForge data (no prompts, replies or keys).`));
  box.appendChild(h('div', { class: 'row' },
    h('button', { type: 'button', class: 'small', onclick: async () => {
      clear(out).appendChild(loadingState('Loading the report…'));
      try {
        const blob = await api('GET', `/bible-builder/${encodeURIComponent(s.session_id)}/report?format=md`, { blob: true });
        clear(out).appendChild(h('pre', { class: 'st-report', tabindex: '0', 'aria-label': 'Bible Builder report' }, await blob.text()));
        out.querySelector('pre').focus();
      } catch (e) { clear(out).appendChild(failedState('The report could not be loaded', e)); }
    } }, 'View report'),
    h('button', { type: 'button', class: 'small', onclick: async () => {
      try {
        const blob = await api('GET', `/bible-builder/${encodeURIComponent(s.session_id)}/report?format=md&download=1`, { blob: true });
        const url = URL.createObjectURL(blob);
        const a = h('a', { href: url, download: s.report.markdown }); document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000); announce('Report downloaded');
      } catch (e) { clear(out).appendChild(failedState('The report could not be downloaded', e)); }
    } }, 'Download report (.md)')));
  box.appendChild(out);
}

const TIP_ASSIST = op => [
  h('p', null, `Type a short description and one of your AIs fills the ${op.id} form: every field, plus facts that fit your existing world.`),
  h('p', null, 'It opens in its own panel, so you can run several at once (for example a character and a place) while you keep working.'),
  h('p', null, 'Nothing is saved until you press “Use this in the form” and then Create. Links the AI makes up are removed; only real records stay linked.')];
const TIP_PICKER = () => [
  h('p', null, 'Auto picks the cheapest ready AI slot. Or pick one: AI-1, AI-2 and AI-3 are set up in Settings (for example Claude, ChatGPT and Gemini through AutoInjector, or the Anthropic API).'),
  h('p', null, 'The word after each slot says where it’s at right now — Ready, Busy, Not set up or Error.')];
const TIP_BIBLE = () => [
  h('p', null, 'The Bible Builder drafts your story bible from a book idea: first a short “world sketch” with names and roles, then each entry in full, so names stay consistent and entries link to each other.'),
  h('p', null, 'Run one section or many, as often as you like; later runs build on earlier ones. You keep only what you tick, and it is saved as drafts for you to validate and accept.'),
  h('p', null, 'A report of every run (which AI, what was made, what was kept) is saved in your BookForge reports folder.')];

/* ======================================================================= navigation helpers */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Breadcrumb trail: items are [label, href] (clickable) or a plain label (the current page). */
function crumbs(...items) {
  const ol = h('ol', { class: 'crumbs-list' });
  items.forEach((it, i) => {
    const last = i === items.length - 1;
    const [label, href] = Array.isArray(it) ? it : [it, null];
    const m = typeof label === 'string' ? /^([A-K]) · /.exec(label) : null;
    const cls = m ? `crumb-set set-${m[1]}` : null;
    ol.appendChild(h('li', null, href && !last ? h('a', { href, class: cls }, label) : h('span', { 'aria-current': last ? 'page' : null, class: cls }, label)));
  });
  return h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, ol);
}

/** ◀ Previous / Next ▶ through a set's steps (crossing into the neighbouring set at the ends). */
function stepNav(opId) {
  const letters = Object.keys(SETS);
  const order = opOrder(opId[0]);
  const i = order.indexOf(opId);
  let prev = order[i - 1]; let next = order[i + 1];
  const li = letters.indexOf(opId[0]);
  if (!prev && li > 0) { const o = opOrder(letters[li - 1]); prev = o[o.length - 1]; }
  if (!next && li < letters.length - 1) next = opOrder(letters[li + 1])[0];
  const lab = id => `${id} ${(S.opsById[id] || {}).name || ''}`;
  return h('nav', { class: 'step-nav', 'aria-label': 'Previous and next step' },
    prev ? h('a', { class: 'btn small', href: plink('op', prev), rel: 'prev', title: lab(prev) }, '◀ ', h('span', { class: 'step-lab' }, `Previous: ${lab(prev)}`)) : h('span'),
    h('span', { class: 'small muted step-pos' }, `Step ${i + 1} of ${order.length} in ${opId[0]} · ${setInfo(opId[0]).name}`),
    next ? h('a', { class: 'btn small', href: plink('op', next), rel: 'next', title: lab(next) }, h('span', { class: 'step-lab' }, `Next: ${lab(next)}`), ' ▶') : h('span'));
}

/** "What's next" along the main path A→B→C→E→F→G→H (from GET /api/sets). */
function whatsNextCard(currentOp) {
  const g = S.guide;
  if (!g || g.project_id !== S.pid) return h('div');
  const n = g.next_step;
  const t = myTask();
  S.lastMade = !!(t && t.current_task && t.current_task.state === 'done');
  if (S.lastMade) {
    // The book is made (the Current task says so): the main-path guide must not contradict it with leftovers such as
    // chapter context drafts, which the book path never needs approved.
    return h('section', { class: 'card next-card done', 'aria-label': 'What’s next' },
      h('p', null, h('strong', null, '🎉 Your book is made. '), 'Download it from ', h('a', { href: plink('book') }, 'Make my book'),
        '. Everything else in the sets is optional; ', h('a', { href: plink('progress') }, 'Progress'), ' shows what more you can add.'));
  }
  if (!n) {
    return h('section', { class: 'card next-card done', 'aria-label': 'What’s next' },
      h('p', null, h('strong', null, '🎉 Every step of the main path has an approved record. '),
        'See ', h('a', { href: plink('progress') }, 'Progress'), ' for the remaining required steps, or ',
        h('a', { href: plink('book') }, 'Make my book'), ' to export it.'));
  }
  const op = S.opsById[n.op_id] || { assist: false, name: n.title };
  const here = currentOp === n.op_id;
  return h('section', { class: 'card next-card', 'aria-label': 'What’s next' },
    h('div', { class: 'next-row' },
      h('div', null, h('strong', null, here ? '👉 This is your next step: ' : '👉 What’s next: '),
        here ? `${n.op_id} ${n.title}` : h('a', { href: plink('op', n.op_id) }, `${n.op_id} ${n.title}`),
        h('span', { class: 'muted' }, ` — ${n.reason}`)),
      h('div', { class: 'row' },
        here ? null : h('a', { class: 'btn small', href: plink('op', n.op_id) }, 'Open'),
        h('button', { type: 'button', class: 'small', onclick: () => goNew(n.op_id) }, 'New'),
        op.assist ? h('button', { type: 'button', class: 'small ai-btn', onclick: ev => openMakeDialog(n.op_id, null, ev.currentTarget) }, '✨ Make some for me') : null,
        h('a', { class: 'btn small', href: plink('book') }, '📘 Make my book'))));
}

function goNew(opId) {
  S.pendingFocus = 'new';
  const target = plink('op', opId);
  if (location.hash === target) route(); else location.hash = target;
}

/** Tiles for the 11 sets: 'tile' (big, overview) or 'mini' (Sets popover). Clicking opens the set panel. */
function setTiles(kind) {
  const grid = h('div', { class: kind === 'tile' ? 'set-tiles' : 'set-minis' });
  for (const letter of Object.keys(SETS)) {
    const info = setInfo(letter);
    const ops = opOrder(letter);
    const recs = S.records.filter(r => r.module_id[0] === letter);
    const approvedOps = ops.filter(id => opStats(id).approved > 0).length;
    const g = info.guide;
    const stale = recs.filter(r => r.stale).length;
    const wrap = h('div', { class: `tile-wrap set-${letter}` });
    grid.appendChild(wrap);
    if (stale) {
      wrap.appendChild(hazard({ code: 'STALE', message: `${stale} record(s) in this set are out of date.`, where: { book: profileOf().title || (S.project || {}).name, set: letter } },
        { extra: [{ label: '🧩 Open the set', fn: () => openSetPanel(letter, null) }] }, { small: true }));
    }
    wrap.appendChild(h('button', { type: 'button', class: `${kind === 'tile' ? 'set-tile' : 'set-mini'} set-${letter}`, 'aria-haspopup': 'dialog',
      'data-set': letter, onclick: ev => { closePops(); openSetPanel(letter, ev.currentTarget); } },
    h('span', { class: 'st-icon', 'aria-hidden': 'true' }, info.icon),
    h('span', { class: 'st-text' },
      h('span', { class: 'st-name' }, h('span', { class: 'st-letter' }, letter), ' ', info.name),
      kind === 'tile' ? h('span', { class: 'st-purpose' }, info.purpose) : null,
      h('span', { class: 'st-prog' }, `${recs.length} record${recs.length === 1 ? '' : 's'} · ${approvedOps}/${ops.length} steps approved`),
      kind === 'tile' && g ? h('span', { class: 'st-stage' }, g.stage) : null)));
  }
  return grid;
}

/** One featured action button for a set (types from GET /api/sets). */
function featuredButton(letter, f, inPanel) {
  const label = h('span', null, h('span', { 'aria-hidden': 'true' }, `${f.icon || '•'} `), f.label);
  const act = ev => {
    const opener = ev.currentTarget;
    if (f.type === 'make') { openMakeDialog(f.op, f, opener); return; }
    if (inPanel) closeSetPanel(false);
    if (f.type === 'bible') openBible(opener);
    else if (f.type === 'new') goNew(f.op);
    else if (f.type === 'open') go(plink('op', f.op));
    else if (f.type === 'page') go(plink(f.page));
  };
  return h('button', { type: 'button', class: `featured-btn${f.type === 'make' ? ' make' : ''}`, onclick: act, title: f.description || '' },
    label, f.description ? h('span', { class: 'fb-desc' }, f.description) : null);
}

/* ======================================================================= top-bar popovers */
const POPS = [];
function popMenu(btn, pop, onOpen) {
  const close = (focusBtn) => {
    if (pop.hidden) return;
    pop.hidden = true; btn.setAttribute('aria-expanded', 'false');
    if (focusBtn) btn.focus();
  };
  btn.addEventListener('click', ev => {
    ev.stopPropagation();
    const show = pop.hidden;
    closePops();
    if (show) {
      try { if (onOpen) onOpen(); } catch (e) { toast(`Could not open this menu: ${(e && e.message) || e}`); }
      pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
      const f = pop.querySelector('a, button'); if (f) f.focus();
    }
  });
  pop.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.stopPropagation(); close(true); } });
  pop.addEventListener('click', ev => { if (ev.target.closest('a, button') && !ev.target.closest('.no-close')) close(false); });
  POPS.push(close);
}
function closePops() { for (const c of POPS) c(false); }
document.addEventListener('click', ev => { if (!ev.target.closest('.tb-menu')) closePops(); });

function renderSetsPop() {
  const pop = clear($('#sets-pop'));
  if (!S.project || parseRoute()[0] !== 'p') {
    pop.appendChild(h('p', { class: 'small' }, 'Open or create a book first, then each module set opens here.'));
    pop.appendChild(h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#/' }, 'Your books'), h('a', { class: 'btn small primary', href: '#/start' }, '🚀 Start a new book')));
    return;
  }
  pop.appendChild(h('p', { class: 'small muted pop-title' }, 'Module sets — open one for its options'));
  pop.appendChild(setTiles('mini'));
  pop.appendChild(h('div', { class: 'row pop-foot' }, h('a', { class: 'btn small', href: plink() }, 'Overview'), h('a', { class: 'btn small', href: plink('book') }, '📘 Make my book')));
}

/* ======================================================================= set panel */
const SP = { opener: null, letter: null };
function openSetPanel(letter, opener) {
  if (!S.project || !SETS[letter]) { toast('Open a book first'); return; }
  const d = $('#set-dialog');
  SP.opener = opener && document.contains(opener) ? opener : document.activeElement;
  SP.letter = letter;
  try {
    renderSetPanel(letter);
    if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
    const f = d.querySelector('.featured-btn, .sp-op a, button'); if (f) f.focus();
  } catch (e) { toast(`Could not open the set panel: ${(e && e.message) || e}`); }
}
function closeSetPanel(restoreFocus = true) {
  const d = $('#set-dialog');
  if (d.open) { if (d.close) d.close(); else d.removeAttribute('open'); }
  if (restoreFocus && SP.opener && document.contains(SP.opener) && SP.opener.offsetParent !== null) SP.opener.focus();
}
function renderSetPanel(letter) {
  const d = clear($('#set-dialog'));
  const info = setInfo(letter);
  const g = info.guide;
  const usedBy = Object.keys(SETS).filter(x => { const gx = guideSet(x); return gx && gx.depends_on.includes(letter); });
  d.appendChild(h('div', { class: 'sp-head' },
    h('h2', { id: 'set-panel-title' }, h('span', { 'aria-hidden': 'true' }, `${info.icon} `), `${letter} · ${info.name}`),
    h('button', { type: 'button', class: 'small', 'aria-label': `Close the ${info.name} panel`, onclick: () => closeSetPanel() }, '✕ Close')));
  d.appendChild(h('p', { class: 'sp-lead' }, info.purpose));
  if (g && g.featured_actions.length) {
    d.appendChild(h('section', { class: 'sp-featured', 'aria-label': 'Quick actions' },
      g.featured_actions.map(f => featuredButton(letter, f, true))));
  }
  const body = h('div', { class: 'sp-body' });
  if (g) {
    body.appendChild(h('section', { class: 'sp-about', 'aria-labelledby': 'sp-about-h' }, h('h3', { id: 'sp-about-h' }, 'What it’s for'),
      h('p', null, g.about),
      h('p', { class: 'small' }, h('strong', null, 'Where it fits: '), g.stage),
      h('p', { class: 'small row' }, h('strong', null, 'Needs: '), g.depends_on.length ? g.depends_on.map(x => h('button', { type: 'button', class: 'chip', onclick: () => renderSetPanel(x) }, `${setInfo(x).icon} ${x} · ${setInfo(x).name}`)) : 'nothing — you can start here'),
      usedBy.length ? h('p', { class: 'small row' }, h('strong', null, 'Used by: '), usedBy.map(x => h('button', { type: 'button', class: 'chip', onclick: () => renderSetPanel(x) }, `${setInfo(x).icon} ${x} · ${setInfo(x).name}`))) : null));
  }
  // operations
  const ops = h('ul', { class: 'sp-ops' });
  for (const id of opOrder(letter)) {
    const o = S.opsById[id];
    const st = opStats(id);
    const gop = g ? g.operations.find(x => x.op_id === id) : null;
    const latest = S.records.filter(r => r.module_id === id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    ops.appendChild(h('li', { class: 'sp-op' },
      h('div', { class: 'sp-op-main' },
        h('a', { href: plink('op', id), onclick: () => closeSetPanel(false) }, h('span', { class: 'op-id' }, id), ' ', o.name),
        h('div', { class: 'small muted sp-op-purpose' }, o.purpose.length > 140 ? o.purpose.slice(0, 137) + '…' : o.purpose),
        h('div', { class: 'row small' }, badge('▤', `${st.count} record${st.count === 1 ? '' : 's'}`, 'b-muted'),
          latest ? lifecycleBadge(latest.lifecycle) : null, st.stale ? staleBadge() : null,
          gop && gop.required === false ? badge('–', 'not needed for this book', 'b-muted') : null,
          badge(isCreative(o) ? '✦' : '⚙︎', isCreative(o) ? 'AI or you' : 'automatic', 'b-muted'))),
      h('div', { class: 'sp-op-actions' },
        h('a', { class: 'btn small', href: plink('op', id), onclick: () => closeSetPanel(false) }, 'Open'),
        h('button', { type: 'button', class: 'small', onclick: () => { closeSetPanel(false); goNew(id); } }, 'New'),
        o.assist ? h('button', { type: 'button', class: 'small ai-btn', onclick: ev => openMakeDialog(id, null, ev.currentTarget) }, '✨ Make some for me') : null)));
  }
  body.appendChild(h('section', { 'aria-labelledby': 'sp-ops-h' }, h('h3', { id: 'sp-ops-h' }, `Steps (${opOrder(letter).length})`), ops));
  // recent records
  const recent = S.records.filter(r => r.module_id[0] === letter).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 8);
  body.appendChild(h('section', { 'aria-labelledby': 'sp-rec-h' }, h('h3', { id: 'sp-rec-h' }, 'Recent records'),
    recent.length ? h('ul', { class: 'record-list' }, recent.map(r => h('li', { class: 'record-item' },
      h('div', { class: 'r-main' }, h('a', { class: 'r-title', href: plink('rec', r.record_id), onclick: () => closeSetPanel(false) }, recordTitle(r)),
        h('div', { class: 'r-meta' }, `${r.module_id} · v${r.version} · ${fmtTime(r.created_at)}`)),
      h('div', { class: 'r-badges' }, lifecycleBadge(r.lifecycle),
        h('button', { type: 'button', class: 'small', onclick: () => copyRecord(r, 'text') }, '📋 Copy'),
        h('a', { class: 'btn small', href: plink('rec', r.record_id), onclick: () => closeSetPanel(false) }, 'Open')))))
      : h('p', { class: 'muted small' }, 'Nothing here yet. Use a quick action above or “New” on a step.')));
  d.appendChild(body);
  d.appendChild(h('div', { class: 'sp-foot row' }, h('a', { class: 'btn', href: plink('set', letter), onclick: () => closeSetPanel(false) }, `Open the full ${letter} page`),
    h('button', { type: 'button', onclick: () => closeSetPanel() }, 'Close')));
}

/* ======================================================================= "Make some for me" */
const MK = { states: new Map(), cur: null, opener: null };
function makeNoun(opId) {
  const op = S.opsById[opId];
  if (SECTION_LABEL[opId]) return SECTION_LABEL[opId].toLowerCase();
  return op ? `${op.name.toLowerCase()} options` : 'entries';
}
function profileOf() { return (S.project && S.project.profile) || {}; }

function openMakeDialog(opId, feature, opener) {
  const op = S.opsById[opId];
  if (!S.pid || !op) { toast('Open a book first'); return; }
  if (!op.assist) { toast(`${opId} is not something an AI proposes; open it and use the form.`); return; }
  const key = `${S.pid}|${S.branch}|${opId}`;
  let st = MK.states.get(key);
  if (!st) {
    const gs = guideSet(opId[0]);
    const f = feature || (gs ? gs.featured_actions.find(x => x.type === 'make' && x.op === opId) : null);
    st = { key, op: opId, pid: S.pid, branch: S.branch, mode: opId[0] === 'A' ? 'bible' : 'assist', feature: f || null,
      jobs: [], items: [], before: null, running: false, created: null, sid: null, cancelled: false,
      form: { count: (f && f.count) || (opId[0] === 'A' ? 3 : 2), hints: '', guidance: '', idea: '' } };
    MK.states.set(key, st);
  } else if (feature) st.feature = feature;
  const d = $('#make-dialog');
  MK.opener = opener && document.contains(opener) ? opener : document.activeElement;
  MK.cur = st;
  try {
    renderMake(st);
    if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
    const first = d.querySelector('textarea, input, select'); if (first) first.focus();
  } catch (e) { toast(`Could not open: ${(e && e.message) || e}`); }
}
function closeMake() {
  const d = $('#make-dialog');
  if (d.open) { if (d.close) d.close(); else d.removeAttribute('open'); }
  MK.cur = null;
  if (MK.opener && document.contains(MK.opener) && MK.opener.offsetParent !== null) MK.opener.focus();
}

function renderMake(st) {
  const d = clear($('#make-dialog'));
  const op = S.opsById[st.op];
  const f = st.feature;
  const title = f ? f.label : `Make some ${makeNoun(st.op)} for me`;
  const prof = profileOf();
  d.appendChild(h('div', { class: 'st-head' },
    h('h2', { id: 'make-title' }, h('span', { 'aria-hidden': 'true' }, '✨ '), title, h('span', { class: 'small muted' }, ` · ${st.op} ${op.name}`)),
    h('button', { type: 'button', class: 'small', 'aria-label': 'Close (running work continues)', onclick: closeMake }, '✕ Close')));
  d.appendChild(h('p', null, (f && f.description) || `Your AI proposes ${makeNoun(st.op)} for this book. You review each one; nothing is saved until you choose to.`));
  const ids = { idea: uid('mk'), count: uid('mk'), hints: uid('mk'), guide: uid('mk') };
  const idea = h('textarea', { id: ids.idea, rows: '3', placeholder: 'e.g. A lighthouse keeper’s apprentice searches a stormy archipelago for her missing master.' });
  idea.value = st.form.idea || (BB.session && BB.session.project_id === st.pid ? BB.session.idea : '') || loadJSON(`bf:bb-idea:${st.pid}`, '') || prof.idea || '';
  const count = h('select', { id: ids.count }, Array.from({ length: 10 }, (_, i) => h('option', { value: String(i + 1), selected: st.form.count === i + 1 }, String(i + 1))));
  const hints = h('input', { id: ids.hints, type: 'text', value: st.form.hints, placeholder: f && f.hints ? f.hints.slice(0, 3).join(', ') : '', autocomplete: 'off' });
  const guide = h('textarea', { id: ids.guide, rows: st.mode === 'assist' ? '3' : '2' });
  guide.value = st.form.guidance || (st.mode === 'assist' && st.op === 'B01' ? (prof.idea || '') : '');
  const chips = f && f.hints ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Quick picks' }, f.hints.map(x => {
    const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false' }, x);
    const sync = () => { const cur = hints.value.split(',').map(s => s.trim()).filter(Boolean); b.setAttribute('aria-pressed', String(cur.includes(x))); };
    b.addEventListener('click', () => {
      let cur = hints.value.split(',').map(s => s.trim()).filter(Boolean);
      cur = cur.includes(x) ? cur.filter(y => y !== x) : cur.concat(x);
      hints.value = cur.join(', '); sync(); hints.dispatchEvent(new Event('input'));
    });
    hints.addEventListener('input', sync); sync();
    return b;
  })) : null;
  const pickSlot = ['AI-1', 'AI-2', 'AI-3'].includes(prof.ai_slot) ? prof.ai_slot : (st.form.slot || null);
  const picker = aiPicker(uid('mk-slot'), pickSlot);
  const err = h('div', { 'aria-live': 'polite' });
  const genBtn = h('button', { type: 'button', class: 'primary' }, '✨ Generate');
  const cancelBtn = h('button', { type: 'button', hidden: !st.running }, 'Stop');
  const readVals = () => ({ idea: idea.value.trim(), count: parseInt(count.value, 10) || 1, hints: hints.value.trim(), guidance: guide.value.trim(), slot: picker.value() });
  const persist = () => { const v = readVals(); Object.assign(st.form, { idea: v.idea, count: v.count, hints: v.hints, guidance: v.guidance, slot: v.slot }); };
  [idea, count, hints, guide].forEach(el => el.addEventListener('input', persist));
  genBtn.addEventListener('click', async () => {
    clear(err); persist();
    const v = readVals();
    genBtn.disabled = true;
    try {
      if (st.mode === 'bible') await mkStartBible(st, v, err);
      else await mkStartAssist(st, v, err);
    } catch (e) { err.appendChild(errorWithFix('Could not start', apiErrInfo(e))); }
    finally { genBtn.disabled = false; }
  });
  cancelBtn.addEventListener('click', () => mkCancel(st));
  const form = h('div', { class: 'mk-form' },
    st.mode === 'bible' ? h('div', { class: 'field' }, h('label', { for: ids.idea }, 'Your book idea'), idea,
      h('span', { class: 'hint' }, 'A sentence or two. Everything is made to fit it (and your book profile).')) : null,
    h('div', { class: 'grid-2' },
      h('div', { class: 'field' }, h('label', { for: ids.count }, `How many ${st.mode === 'assist' ? 'options' : makeNoun(st.op)}?`), count,
        h('span', { class: 'hint' }, st.mode === 'assist' ? 'Each option is a separate proposal to choose from.' : 'Made together so names and links stay consistent.')),
      picker.field),
    f && f.hints ? h('div', { class: 'field' }, h('label', { for: ids.hints }, st.op === 'A01' ? 'Roles to include (optional)' : 'Kinds to include (optional)'), chips, hints) : null,
    h('div', { class: 'field' }, h('label', { for: ids.guide }, st.mode === 'assist' ? 'What do you want?' : 'Anything else the AI should know? (optional)'), guide,
      h('span', { class: 'hint' }, st.mode === 'assist' ? `For example: “${PLACEHOLDER[st.op] || 'a short description of what you want'}”.` : 'For example: “one of them secretly works for the villain”.')),
    err,
    h('div', { class: 'form-actions' }, genBtn, cancelBtn,
      st.mode === 'bible' ? h('button', { type: 'button', class: 'link', onclick: ev => { closeMake(); openBible(ev.currentTarget); } }, 'Open the full Bible Builder') : null));
  d.appendChild(form);
  st.cancelBtn = cancelBtn;
  st.resultsEl = h('div', { class: 'mk-results', 'aria-live': 'polite' });
  d.appendChild(st.resultsEl);
  renderMakeResults(st);
}

async function mkStartBible(st, v, err) {
  const guidance = [v.hints ? `Roles or kinds to cover: ${v.hints}.` : '', v.guidance].filter(Boolean).join(' ');
  const idea = v.idea || v.guidance || v.hints;
  if (!idea) { err.appendChild(stateBox('failed', 'Describe your book idea first', h('p', null, 'Everything is made to fit it.'))); return; }
  if (v.idea) saveJSON(`bf:bb-idea:${st.pid}`, v.idea);
  const counts = { [st.op]: v.count };
  const sameSession = BB.session && BB.session.project_id === st.pid && BB.session.branch_id === st.branch;
  st.before = new Set(sameSession ? (BB.session.items || []).map(i => i.key) : []);
  st.created = null; st.cancelled = false;
  let r = null;
  if (sameSession) {
    try {
      r = await api('POST', `/bible-builder/${encodeURIComponent(BB.session.session_id)}/run`,
        { body: { sections: counts, slot_id: v.slot, idea: v.idea || undefined, guidance: guidance || undefined } });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
      BB.session = null; st.before = new Set();
    }
  }
  if (!r) r = await api('POST', '/bible-builder', { body: { project_id: st.pid, branch_id: st.branch, idea, counts, slot_id: v.slot, guidance: guidance || undefined } });
  BB.session = r; st.sid = r.session_id; st.running = true;
  announce(`Making ${v.count} ${makeNoun(st.op)}…`);
  renderMakeResults(st);
  mkPollBible(st);
}
async function mkPollBible(st) {
  clearTimeout(st.poll);
  if (!st.sid) return;
  let s;
  try { s = await api('GET', `/bible-builder/${encodeURIComponent(st.sid)}`); }
  catch (e) {
    if (e instanceof ApiError && e.status === 404) { st.running = false; st.sid = null; st.lost = true; renderMakeResults(st); return; }
    st.poll = setTimeout(() => mkPollBible(st), 2500); return;
  }
  if (BB.session && BB.session.session_id === s.session_id) BB.session = s; else if (!BB.session) BB.session = s;
  st.items = (s.items || []).filter(i => i.op === st.op && !(st.before && st.before.has(i.key)));
  st.section = (s.sections || []).find(x => x.op === st.op) || null;
  st.current = s.current; st.running = !!s.busy;
  renderMakeResults(st);
  if (s.busy) st.poll = setTimeout(() => mkPollBible(st), 1000);
  else announce(`${makeNoun(st.op)}: ready to review.`);
}

async function mkStartAssist(st, v, err) {
  const text = [v.guidance, v.hints ? `Kinds to cover: ${v.hints}.` : ''].filter(Boolean).join('\n');
  if (!text) { err.appendChild(stateBox('failed', 'Type what you want first', h('p', null, `For example: “${PLACEHOLDER[st.op] || 'a short description'}”.`))); return; }
  if (st.running) { err.appendChild(stateBox('blocked', 'Still working', h('p', null, 'Wait for the current proposals, or press Stop.'))); return; }
  const n = v.count;
  st.cancelled = false; st.running = true;
  st.jobs = Array.from({ length: n }, (_, i) => ({ i, status: 'queued', job: null, error: null, startedAt: 0 }));
  renderMakeResults(st);
  const prompt = i => (n > 1 ? `${text}\n\n(Option ${i + 1} of ${n}: make this option clearly different from the others.)` : text);
  let next = 0;
  const worker = async () => {
    while (next < n && !st.cancelled) { const j = st.jobs[next++]; await mkRunJob(st, j, prompt(j.i), v.slot); }
  };
  try { await Promise.all([worker(), worker()]); }
  finally {
    for (const j of st.jobs) if (j.status === 'queued') j.status = 'cancelled';
    st.running = false; renderMakeResults(st);
    announce(`${st.op}: proposals ready to review.`);
  }
}
async function mkRunJob(st, j, prompt, slot) {
  for (let tries = 0; ; tries++) {
    try {
      j.job = await api('POST', '/assist', { body: { project_id: st.pid, branch_id: st.branch, target_operation: st.op, prompt,
        slot_id: slot, context_refs: [], current_values: {}, keep_values: true } });
      break;
    } catch (e) {
      if (e instanceof ApiError && e.status === 429 && tries < 60 && !st.cancelled) { await sleep(3000); continue; }
      j.status = 'error'; j.error = apiErrInfo(e); renderMakeResults(st); return;
    }
  }
  j.status = 'running'; j.startedAt = Date.now(); renderMakeResults(st);
  let misses = 0;
  while (['queued', 'running'].includes(j.job.status)) {
    await sleep(1000);
    if (st.cancelled && !j.cancelSent) { j.cancelSent = true; api('POST', `/assist/${encodeURIComponent(j.job.job_id)}/cancel`).catch(() => {}); }
    try { j.job = await api('GET', `/assist/${encodeURIComponent(j.job.job_id)}`); misses = 0; }
    catch (e) {
      if (++misses > 20 || (e instanceof ApiError && e.status === 404)) { j.status = 'error'; j.error = apiErrInfo(e); renderMakeResults(st); return; }
    }
    renderMakeResults(st);
  }
  j.status = j.job.status === 'done' ? 'done' : j.job.status === 'cancelled' ? 'cancelled' : 'error';
  j.error = j.job.error;
  renderMakeResults(st);
}
async function mkCancel(st) {
  st.cancelled = true;
  if (st.mode === 'bible' && st.sid) {
    try { BB.session = await api('POST', `/bible-builder/${encodeURIComponent(st.sid)}/cancel`); toast('Stopping after the current item'); }
    catch (e) { toast(`Could not stop: ${apiErrInfo(e).message}`); }
  } else toast('Stopping…');
}

function proposalTitle(p) {
  if (!p || typeof p !== 'object') return 'Proposal';
  for (const k of ['concept', 'premise', 'idea', 'title', 'style_name', 'scene_description', 'instruction', 'story_goal', 'cover_brief', 'panel_brief']) {
    if (typeof p[k] === 'string' && p[k].trim()) return p[k].length > 120 ? p[k].slice(0, 117) + '…' : p[k];
  }
  const s = Object.values(p).find(x => typeof x === 'string' && x.trim());
  return s ? (s.length > 120 ? s.slice(0, 117) + '…' : s) : 'Proposal';
}
function slotLine(slot, label, model) {
  if (!slot && !label) return null;
  return h('span', { class: 'small muted by-ai' }, `by ${[slot, label].filter(Boolean).join(' · ')}${model ? ` (${model})` : ''}`);
}

function renderMakeResults(st) {
  if (MK.cur !== st || !st.resultsEl || !document.contains(st.resultsEl)) return;
  const box = clear(st.resultsEl);
  if (st.cancelBtn) st.cancelBtn.hidden = !st.running;
  if (st.lost) box.appendChild(stateBox('stale', 'The previous run expired', h('p', null, 'Press Generate to start again.')));
  if (st.mode === 'bible') {
    if (st.running) {
      const sec = st.section; const cur = st.current;
      box.appendChild(h('div', { class: 'state loading', role: 'status' },
        h('p', { class: 'row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('strong', null, (cur && cur.phase) || (sec && sec.message) || 'Working…'),
          cur ? h('span', { class: 'mono' }, fmtClock(cur.elapsed_ms || 0)) : null, cur && cur.slot ? slotLine(cur.slot, cur.slot_label) : null),
        h('p', { class: 'small' }, 'Web AIs can take a few minutes per entry. You can close this window; the work continues.')));
    } else if (st.section && ['error', 'partial'].includes(st.section.status) && st.section.error) {
      box.appendChild(errorWithFix(st.section.message || 'The AI could not finish', st.section.error));
    }
    if (!st.items.length) return;
    const ready = st.items.filter(i => i.status === 'done' && !i.created_ref);
    const keep = st.keep || (st.keep = {});
    const grid = h('ul', { class: 'mk-cards' });
    for (const it of st.items) {
      const cb = h('input', { type: 'checkbox', id: `mk-${it.key}`, checked: keep[it.key] !== false && it.status === 'done' && !it.created_ref, disabled: it.status !== 'done' || !!it.created_ref });
      cb.addEventListener('change', () => { keep[it.key] = cb.checked; });
      const sum = it.summary || {};
      grid.appendChild(h('li', { class: `mk-card st-${it.status}` },
        h('div', { class: 'check-row' }, cb, h('label', { for: cb.id }, h('strong', null, (it.proposal && it.proposal.concept) || it.name))),
        h('div', { class: 'row small' }, badge(it.status === 'done' ? '✔' : it.status === 'error' ? '✕' : '…', it.status === 'done' ? 'Ready' : it.status === 'error' ? 'Failed' : 'Working', it.status === 'done' ? 'b-ok' : it.status === 'error' ? 'b-bad' : 'b-info'),
          it.created_ref ? badge('✎', 'Saved as draft', 'b-info') : null, slotLine(it.slot, null, it.model)),
        it.role ? h('p', { class: 'small' }, it.role) : null,
        sum.summary ? h('p', { class: 'small mk-sum' }, sum.summary.length > 240 ? sum.summary.slice(0, 237) + '…' : sum.summary) : null,
        it.error ? h('p', { class: 'small' }, h('strong', null, 'Why: '), it.error.message, it.error.fix ? ` — ${it.error.fix}` : '') : null,
        h('div', { class: 'row' },
          it.proposal ? h('button', { type: 'button', class: 'small', onclick: () => copyText(JSON.stringify(it.proposal, null, 2), 'Proposal copied as JSON') }, '📋 Copy') : null,
          it.proposal && !it.created_ref ? h('button', { type: 'button', class: 'small', onclick: () => { closeMake(); closeSetPanel(false); fillNewForm(st.pid, st.branch, st.op, it.proposal, { from_ai: { slot: it.slot, label: `${it.slot || 'AI'}${it.model ? ' · ' + it.model : ''}` } }); } }, 'Use in the form') : null,
          it.created_ref ? h('a', { class: 'btn small', href: recLink(it.created_ref), onclick: () => { closeMake(); closeSetPanel(false); } }, 'Open draft') : null)));
    }
    box.appendChild(h('h3', null, `Proposals (${st.items.length})`));
    box.appendChild(grid);
    const out = h('div', { 'aria-live': 'polite' });
    const createBtn = h('button', { type: 'button', class: 'primary', disabled: st.running || !ready.length }, 'Save the ticked ones as drafts');
    createBtn.addEventListener('click', async () => {
      const keys = ready.filter(i => keep[i.key] !== false).map(i => i.key);
      if (!keys.length) { clear(out).appendChild(stateBox('failed', 'Nothing ticked', h('p', null, 'Tick at least one to keep.'))); return; }
      createBtn.disabled = true; clear(out).appendChild(loadingState(`Saving ${keys.length} draft(s)…`));
      try {
        const r = await api('POST', `/bible-builder/${encodeURIComponent(st.sid)}/create`, { body: { items: keys } });
        BB.session = r.session;
        st.items = (r.session.items || []).filter(i => i.op === st.op && !(st.before && st.before.has(i.key)));
        try { await refreshRecords(); } catch { /* best effort */ }
        await loadGuide();
        toast(`${r.created.length} draft(s) saved${r.errors.length ? `, ${r.errors.length} failed` : ''}`);
        renderMakeResults(st);
      } catch (e) { createBtn.disabled = false; clear(out).appendChild(errorWithFix('Nothing was saved', apiErrInfo(e))); }
    });
    box.appendChild(h('div', { class: 'form-actions' }, createBtn, h('span', { class: 'small muted' }, 'Drafts are not approved: open each one, read it, then Validate and Accept it.')));
    box.appendChild(out);
    return;
  }
  // assist mode
  if (!st.jobs.length) return;
  box.appendChild(h('h3', null, `Proposals (${st.jobs.length})`));
  const list = h('ul', { class: 'mk-cards' });
  for (const j of st.jobs) {
    const job = j.job || {};
    const head = h('div', { class: 'row' }, h('strong', null, `Option ${j.i + 1}`),
      j.status === 'done' ? badge('✔', 'Ready', 'b-ok') : j.status === 'error' ? badge('✕', 'Failed', 'b-bad')
        : j.status === 'cancelled' ? badge('–', 'Stopped', 'b-muted') : badge('◔', j.status === 'queued' ? 'Waiting' : 'Working', 'b-info'),
      slotLine(job.slot, job.slot_label, job.model));
    const li = h('li', { class: `mk-card st-${j.status}` }, head);
    if (j.status === 'running' || j.status === 'queued') {
      li.appendChild(h('p', { class: 'small row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), `${job.phase || 'Waiting'}… ${j.startedAt ? fmtClock(Date.now() - j.startedAt) : ''}`));
    } else if (j.status === 'done' && job.proposal) {
      const blocking = (job.findings || []).filter(f => f.severity === 'BLOCKING' && f.decision !== 'PASS').length;
      li.appendChild(h('p', { class: 'mk-sum' }, proposalTitle(job.proposal)));
      if (blocking) li.appendChild(h('p', { class: 'small' }, badge('⚠︎', `${blocking} thing(s) to fix in the form`, 'b-warn')));
      li.appendChild(h('details', null, h('summary', { class: 'small' }, 'Show everything'), h('div', { class: 'data-view small' }, renderData(job.proposal, ''))));
      li.appendChild(h('div', { class: 'row' },
        h('button', { type: 'button', class: 'small primary', onclick: () => { closeMake(); closeSetPanel(false); fillNewForm(st.pid, st.branch, st.op, job.proposal, { from_ai: { slot: job.slot, label: `${job.slot || ''}${job.slot_label ? ' · ' + job.slot_label : ''}`, job_id: job.job_id } }); } }, 'Use this in the form'),
        h('button', { type: 'button', class: 'small', onclick: () => copyText(JSON.stringify(job.proposal, null, 2), 'Proposal copied as JSON') }, '📋 Copy')));
    } else if (j.status === 'error') {
      const e = j.error || {};
      li.appendChild(h('p', { class: 'small' }, e.message || 'Failed', e.fix ? h('span', null, h('br'), h('strong', null, 'What to do: '), e.fix) : null));
      if (['CAPABILITY_UNAVAILABLE', 'UPSTREAM_UNAVAILABLE', 'TIMEOUT'].includes(e.code)) li.appendChild(h('a', { class: 'btn small', href: '#/settings', onclick: closeMake }, 'Open Settings'));
    }
    list.appendChild(li);
  }
  box.appendChild(list);
}

/* ======================================================================= quick jump (Ctrl+K or /) */
const JP = { opener: null, items: [], shown: [], idx: 0 };
function jumpEntries() {
  const out = [];
  const inP = !!(S.project && parseRoute()[0] === 'p');
  out.push({ label: 'Your books', sub: 'Projects', href: '#/', kind: 'page' });
  out.push({ label: '🚀 Start a new book', sub: 'Step-by-step', href: '#/start', kind: 'page' });
  out.push({ label: 'Settings', sub: 'AI slots', href: '#/settings', kind: 'page' });
  if (!inP) return out;
  out.push({ label: 'Overview', sub: S.project.name, href: plink(), kind: 'page' });
  out.push({ label: '📘 Make my book', sub: 'Guided path', href: plink('book'), kind: 'page' });
  out.push({ label: 'Progress', sub: 'Page', href: plink('progress'), kind: 'page' });
  out.push({ label: 'Activity', sub: 'Page', href: plink('activity'), kind: 'page' });
  out.push({ label: 'Book features', sub: 'Feature manifest', href: plink('manifest'), kind: 'page' });
  for (const letter of Object.keys(SETS)) {
    const info = setInfo(letter);
    out.push({ label: `${info.icon} ${letter} · ${info.name}`, sub: 'Open the set panel', set: letter, kind: 'set', key: `set ${letter} ${info.name}` });
  }
  for (const o of S.ops) out.push({ label: `${o.id} ${o.name}`, sub: setInfo(o.set).name, href: plink('op', o.id), kind: 'op', key: `${o.id} ${o.name} ${setInfo(o.set).name}`, id: o.id });
  for (const r of S.records.slice(-300)) out.push({ label: recordTitle(r), sub: `${r.module_id} record · ${r.record_id}`, href: plink('rec', r.record_id), kind: 'rec', key: `${recordTitle(r)} ${r.record_id} ${r.module_id}` });
  return out;
}
function jumpFilter(q) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return JP.items.filter(x => x.kind !== 'rec' && x.kind !== 'op').concat(JP.items.filter(x => x.kind === 'op').slice(0, 10));
  const scored = [];
  for (const it of JP.items) {
    const hay = `${it.key || it.label} ${it.sub || ''}`.toLowerCase();
    if (!toks.every(t => hay.includes(t))) continue;
    let s = 0;
    if (it.id && it.id.toLowerCase() === toks[0]) s -= 100;
    else if (it.id && it.id.toLowerCase().startsWith(toks[0])) s -= 50;
    if (it.label.toLowerCase().startsWith(toks[0])) s -= 20;
    s += { page: 0, set: 1, op: 2, rec: 5 }[it.kind] || 0;
    scored.push([s, it]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, 40).map(x => x[1]);
}
function openJump(opener) {
  const d = $('#jump-dialog');
  JP.opener = opener && document.contains(opener) ? opener : document.activeElement;
  JP.items = jumpEntries();
  clear(d);
  const input = h('input', { id: 'jump-input', type: 'search', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'jump-list',
    'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false', placeholder: 'Type a step (A01, characters, premise…), a set, a page or a record' });
  const list = h('ul', { id: 'jump-list', role: 'listbox', class: 'jump-list', 'aria-label': 'Matches' });
  const draw = () => {
    JP.shown = jumpFilter(input.value);
    JP.idx = Math.min(JP.idx, Math.max(0, JP.shown.length - 1));
    clear(list);
    if (!JP.shown.length) list.appendChild(h('li', { class: 'muted small jump-empty' }, 'No matches.'));
    JP.shown.forEach((it, i) => list.appendChild(h('li', { id: `jump-opt-${i}`, role: 'option', 'aria-selected': String(i === JP.idx), class: 'jump-opt',
      onclick: () => jumpTo(it), onmousemove: () => { if (JP.idx !== i) { JP.idx = i; mark(); } } },
    h('span', { class: 'jo-label' }, it.label), h('span', { class: 'jo-sub small muted' }, it.sub || ''))));
    mark();
  };
  const mark = () => {
    list.querySelectorAll('[role=option]').forEach((el, i) => el.setAttribute('aria-selected', String(i === JP.idx)));
    const cur = list.querySelector(`#jump-opt-${JP.idx}`);
    if (cur) { input.setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  };
  input.addEventListener('input', () => { JP.idx = 0; draw(); });
  input.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); JP.idx = Math.min(JP.idx + 1, JP.shown.length - 1); mark(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); JP.idx = Math.max(JP.idx - 1, 0); mark(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); const it = JP.shown[JP.idx]; if (it) jumpTo(it); }
  });
  d.appendChild(h('div', { class: 'jump-head' }, h('h2', { id: 'jump-title', class: 'visually-hidden' }, 'Jump to'),
    h('label', { for: 'jump-input', class: 'visually-hidden' }, 'Jump to'), input,
    h('button', { type: 'button', class: 'small', 'aria-label': 'Close', onclick: () => closeJump(true) }, 'Esc')));
  d.appendChild(list);
  d.appendChild(h('p', { class: 'small muted jump-help' }, '↑ ↓ to move · Enter to open · Esc to close. Shortcut: Ctrl+K or /'));
  if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  JP.idx = 0; draw(); input.focus();
}
function closeJump(restore) {
  const d = $('#jump-dialog');
  if (!d || !d.open) return;
  if (d.close) d.close(); else d.removeAttribute('open');
  if (restore && JP.opener && document.contains(JP.opener) && JP.opener.offsetParent !== null) JP.opener.focus();
}
function jumpTo(it) {
  closeJump(false);
  if (it.kind === 'set') { openSetPanel(it.set, $('#sets-btn')); return; }
  if (it.href) go(it.href);
}

/* ======================================================================= copy, duplicate, paste */
function refText(v) {
  const rec = recordById(v.record_id);
  return `${v.module_id} ${rec ? recordTitle(rec) : v.record_id} (${v.record_id} v${v.version})`;
}
function dataText(v, indent = '') {
  if (v === null || v === undefined) return 'unknown';
  if (typeof v !== 'object') return String(v);
  if (isRefValue(v)) return refText(v);
  const pad = indent + '  ';
  if (Array.isArray(v)) {
    if (!v.length) return '(none)';
    return '\n' + v.map(x => {
      if (x && typeof x === 'object' && 'subject_id' in x && 'predicate' in x) {
        const val = Array.isArray(x.value) ? x.value.join(', ') : x.value === null ? 'unknown' : String(x.value);
        return `${pad}- ${x.subject_id} · ${x.predicate} = ${val}${x.assertion_type && x.assertion_type !== 'FACT' ? ` [${x.assertion_type}]` : ''}`;
      }
      const t = dataText(x, pad);
      return `${pad}- ${t.startsWith('\n') ? t.trimStart() : t}`;
    }).join('\n');
  }
  const keys = Object.keys(v);
  if (!keys.length) return '(empty)';
  return '\n' + keys.map(k => {
    const t = dataText(v[k], pad);
    return `${pad}${humanize(k)}: ${t.includes('\n') && !t.startsWith('\n') ? '\n' + pad + '  ' + t.split('\n').join('\n' + pad + '  ') : t}`;
  }).join('\n');
}
/** Human-readable summary of one record revision (Copy text). */
function recordText(cur, op) {
  const title = recordTitle(cur);
  const lc = LIFECYCLE[cur.lifecycle] ? LIFECYCLE[cur.lifecycle][1] : cur.lifecycle;
  return `${title}\n${op.id} ${op.name || ''} · ${cur.record_id} v${cur.version} · ${lc}\n${dataText(cur.data, '').replace(/^\n/, '')}\n`;
}
async function copyRecord(r, how) {
  try {
    const d = await recordDetail(r.record_id);
    const v = d.versions.find(x => x.version === r.version) || d.versions[d.versions.length - 1];
    const op = S.opsById[v.module_id] || { id: v.module_id, name: '' };
    if (how === 'json') await copyText(JSON.stringify(v.data, null, 2), 'Copied as JSON');
    else await copyText(recordText(v, op), 'Copied as text');
  } catch (e) { toast(`Could not copy: ${apiErrInfo(e).message}`); }
}
/** ⧉ Duplicate as new draft: the New form of the same step, filled from this record (nothing is created). */
async function duplicateRecord(cur, op) {
  const schema = await getSchema(op.id);
  const props = (schema.create_payload && schema.create_payload.properties) || {};
  const data = cur.data && typeof cur.data === 'object' ? cur.data : {};
  const payload = {}; const skipped = [];
  for (const [k, v] of Object.entries(data)) { if (k in props) payload[k] = v; else skipped.push(k); }
  const manual = isCreative(op) ? data : undefined;
  fillNewForm(S.pid, S.branch, op.id, payload,
    { manual, manualOn: false, from_copy: { record_id: cur.record_id, version: cur.version, title: recordTitle(cur), skipped: manual ? [] : skipped, manual: !!manual } },
    `${op.id} form filled from ${cur.record_id} — review it and press Create`);
}
function mainTextField(props) {
  const entries = Object.entries(props || {});
  const isStr = s => s && (s.type === 'string' || (Array.isArray(s.type) && s.type.includes('string')));
  const hit = entries.find(([k, s]) => isStr(s) && LONG_TEXT.test(k) && !/_id$/.test(k));
  if (hit) return hit[0];
  const any = entries.find(([k, s]) => isStr(s) && !/_id$/.test(k) && !s.enum);
  return any ? any[0] : null;
}
/** Small modal with buttons; resolves to the chosen id, or null. */
function choiceDialog(title, message, choices) {
  return new Promise(resolve => {
    const prev = document.activeElement;
    const d = h('dialog', { class: 'selftest-dialog choice-dialog', 'aria-labelledby': 'choice-title' });
    let done = false;
    const finish = v => { if (done) return; done = true; try { if (d.open) d.close(); } catch { /* ignore */ } d.remove(); if (prev && prev.focus) { try { prev.focus(); } catch { /* ignore */ } } resolve(v); };
    d.appendChild(h('h2', { id: 'choice-title' }, title));
    if (message) d.appendChild(typeof message === 'string' ? h('p', null, message) : message);
    d.appendChild(h('div', { class: 'form-actions' }, choices.map((c, i) => h('button', { type: 'button', class: i === 0 ? 'primary' : null, onclick: () => finish(c.id) }, c.label)),
      h('button', { type: 'button', onclick: () => finish(null) }, 'Cancel')));
    d.addEventListener('cancel', ev => { ev.preventDefault(); finish(null); });
    document.body.appendChild(d);
    try { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); } catch { d.setAttribute('open', ''); }
    const b = d.querySelector('button'); if (b) b.focus();
  });
}
/**
 * 📥 Paste: JSON whose fields match the form fills them (others are skipped and listed); plain text goes
 * into the main text field, or becomes the request for ✨ Fill with AI. Nothing is submitted.
 */
async function pasteIntoForm({ op, props, current, apply, onGuidance }) {
  let text;
  try { text = await readText('Text or JSON to paste into this form'); } catch { text = null; }
  if (text === null || text === undefined) return;
  const trimmed = String(text).trim();
  if (!trimmed) { toast('Nothing to paste'); return; }
  let obj = null;
  if (/^[[{]/.test(trimmed)) { try { obj = JSON.parse(trimmed); } catch { obj = null; } }
  let cur = {};
  try { cur = current() || {}; } catch { cur = {}; }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (obj.data && typeof obj.data === 'object' && obj.module_id) obj = obj.data;
    else if (obj.proposal && typeof obj.proposal === 'object') obj = obj.proposal;
    const filled = []; const skipped = [];
    const merged = Object.assign({}, cur);
    for (const [k, v] of Object.entries(obj)) { if (k in props) { merged[k] = v; filled.push(k); } else skipped.push(k); }
    if (!filled.length) {
      toast(`None of the pasted fields belong to this form${skipped.length ? ` (skipped: ${skipped.slice(0, 6).join(', ')})` : ''}.`);
      return;
    }
    apply(merged, { filled, skipped });
    toast(`Pasted ${filled.length} field(s)${skipped.length ? `; skipped ${skipped.length}` : ''}`);
    return;
  }
  const field = mainTextField(props);
  const choices = [];
  if (field) choices.push({ id: 'field', label: `Put it into “${humanize(field)}”` });
  if (onGuidance) choices.push({ id: 'ai', label: '✨ Use it as the request for Fill with AI' });
  if (!choices.length) { toast('This form has no text field for plain text; paste JSON instead.'); return; }
  const preview = trimmed.length > 160 ? trimmed.slice(0, 157) + '…' : trimmed;
  const pick = choices.length === 1 && field ? 'field' : await choiceDialog('Paste text', h('p', null, 'Where should this text go?', h('br'), h('q', { class: 'small' }, preview)), choices);
  if (pick === 'field') apply(Object.assign({}, cur, { [field]: trimmed }), { filled: [field], skipped: [] });
  else if (pick === 'ai' && onGuidance) onGuidance(trimmed);
}

/* ======================================================================= generic modal */
function modal(title, build, { wide = false } = {}) {
  const prev = document.activeElement;
  const id = uid('modal');
  const d = h('dialog', { class: `selftest-dialog${wide ? ' wide-dialog' : ''}`, 'aria-labelledby': `${id}-t` });
  const close = () => { try { if (d.open) d.close(); } catch { /* ignore */ } d.remove(); if (prev && document.contains(prev) && prev.focus) { try { prev.focus(); } catch { /* ignore */ } } };
  d.appendChild(h('div', { class: 'st-head' }, h('h2', { id: `${id}-t` }, title), h('button', { type: 'button', class: 'small', 'aria-label': 'Close', onclick: close }, '✕ Close')));
  d.addEventListener('cancel', ev => { ev.preventDefault(); close(); });
  document.body.appendChild(d);
  append(d, [build(close)]);
  try { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); } catch { d.setAttribute('open', ''); }
  const f = d.querySelector('input, textarea, select'); if (f) f.focus();
  return { d, close };
}

/* ======================================================================= book profile */
const AUDIENCES = ['Children (5-8)', 'Middle grade (8-12)', 'Young adult (12-18)', 'Adult', 'Everyone'];
const GENRES = ['Fantasy', 'Science fiction', 'Mystery', 'Thriller', 'Romance', 'Horror', 'Historical', 'Literary', 'Adventure', 'Comedy', 'Children’s picture book'];
const TONES = ['Cozy and warm', 'Dark and tense', 'Funny', 'Epic', 'Hopeful', 'Bittersweet', 'Spooky'];
const LENGTH_INFO = { short_story: ['Short story', 'about 1-3 chapters'], novella: ['Novella', 'about 6-10 chapters'], novel: ['Novel', 'about 20-30 chapters'] };
const PROFILE_HELP = {
  title: 'The working title. You can change it any time.', author: 'Your name or pen name, printed on the title page.',
  genre: 'What kind of story it is — it guides the AI’s choices.', audience: 'Who will read it; the AI matches the words and themes to them.',
  length: 'How long the book should be; it sets how many chapters are planned.', tone: 'How it should feel to read.',
  idea: 'Your story in a few sentences: who, where, and what goes wrong. Everything is built to fit this.',
};

/** The profile fields as a form; returns {el, get()} */
function profileFields(prof, prefix) {
  const f = {};
  const field = (key, label, control, extra) => {
    control.id = `${prefix}-${key}`;
    control.setAttribute('aria-describedby', `${prefix}-${key}-h`);
    f[key] = control;
    return h('div', { class: 'field' + (key === 'idea' ? ' wide' : '') }, h('label', { for: control.id }, label), control, extra || null,
      h('span', { class: 'hint', id: `${prefix}-${key}-h` }, PROFILE_HELP[key] || ''));
  };
  const dl = (id, vals) => h('datalist', { id }, vals.map(v => h('option', { value: v })));
  const lengthSel = h('select', null, h('option', { value: '' }, '— choose —'), Object.entries(LENGTH_INFO).map(([k, [l, d]]) => h('option', { value: k, selected: prof.length === k }, `${l} (${d})`)));
  const aud = h('select', null, h('option', { value: '' }, '— choose —'), AUDIENCES.map(a => h('option', { value: a, selected: prof.audience === a }, a)));
  if (prof.audience && !AUDIENCES.includes(prof.audience)) aud.appendChild(h('option', { value: prof.audience, selected: true }, prof.audience));
  const el = h('div', { class: 'grid-2 profile-grid' },
    field('title', 'Book title', h('input', { type: 'text', value: prof.title || '', maxlength: '200', autocomplete: 'off' })),
    field('author', 'Author or pen name', h('input', { type: 'text', value: prof.author || '', maxlength: '200' })),
    field('genre', 'Genre', h('input', { type: 'text', value: prof.genre || '', list: `${prefix}-genres`, maxlength: '120' }), dl(`${prefix}-genres`, GENRES)),
    field('audience', 'Who is it for?', aud),
    field('length', 'Length', lengthSel),
    field('tone', 'Tone', h('input', { type: 'text', value: prof.tone || '', list: `${prefix}-tones`, maxlength: '200' }), dl(`${prefix}-tones`, TONES)),
    field('idea', 'Your idea in a paragraph', h('textarea', { rows: '4', maxlength: '4000' }, prof.idea || '')));
  f.idea.value = prof.idea || '';
  return { el, get: () => Object.fromEntries(Object.entries(f).map(([k, c]) => [k, c.value.trim()])), f };
}
function openProfileDialog(onSaved) {
  if (!S.project) return;
  const prof = profileOf();
  modal('📝 Book profile', close => {
    const pf = profileFields(prof, uid('pf'));
    const out = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'primary' }, 'Save profile');
    return h('form', { novalidate: true, onsubmit: async ev => {
      ev.preventDefault(); clear(out); clearFieldProblems(pf.el);
      const body = pf.get();
      if (!String(body.title || '').trim()) {   // the book needs a title (the server refuses an empty one too)
        markFieldProblem(pf.f.title, { code: 'MISSING_INPUT', path: '/title', message: 'Give your book a title (a working title is fine).' },
          { book: prof.title || S.project.name, step: 'Book profile', field: 'Title' });
        pf.f.title.focus();
        return;
      }
      save.disabled = true;
      try {
        const saved = await api('PUT', `/projects/${encodeURIComponent(S.pid)}/profile`, { body });
        S.project.profile = saved;
        toast('Book profile saved'); close();
        if (onSaved) onSaved(saved); else route();
      } catch (e) {
        clearFieldProblems(pf.el);
        const rest = showFieldErrors(e, pf.f, { book: prof.title || S.project.name, step: 'Book profile' });
        if (rest.length || !(e instanceof ApiError)) out.appendChild(failedState('The profile was not saved', e));
        save.disabled = false;
      }
    } }, h('p', { class: 'small muted' }, 'This is what your book is. The AI reads it every time it helps, and the title and author go on the title page and into the exported files.'),
    pf.el, out, h('div', { class: 'form-actions' }, save));
  }, { wide: true });
}
function profileCard() {
  const prof = profileOf();
  const row = (label, v) => [h('dt', null, label), h('dd', null, v || h('span', { class: 'muted' }, 'not set'))];
  return h('section', { class: 'card profile-card', 'aria-labelledby': 'prof-h' },
    h('div', { class: 'row space' }, h('h2', { id: 'prof-h' }, '📝 Book profile'),
      h('button', { type: 'button', onclick: () => openProfileDialog() }, 'Edit')),
    h('p', { class: 'small muted' }, 'What your book is. The AI reads this every time it helps; the title and author go on the title page and into the files.'),
    h('dl', { class: 'kv' },
      row('Title', prof.title), row('Author', prof.author), row('Genre', prof.genre), row('For', prof.audience),
      row('Length', prof.length ? `${LENGTH_INFO[prof.length][0]} (${LENGTH_INFO[prof.length][1]})` : ''),
      row('Tone', prof.tone), row('Idea', prof.idea),
      row('AI', prof.ai_slot === 'manual' ? 'I write it myself (no AI)' : prof.ai_slot ? prof.ai_slot : 'Automatic — the best ready AI')));
}

/* ======================================================================= start wizard */
const WZ_KEY = 'bf:wizard';
function wizardState() {
  const w = loadJSON(WZ_KEY, null);
  return w && typeof w === 'object' ? w : { step: 1, profile: { length: 'novella' }, ai: '', make: { A01: 4, A04: 2, A03: 1, premise: true, outline: true } };
}
async function viewStart(main) {
  const w = wizardState();
  const save = () => saveJSON(WZ_KEY, w);
  main.appendChild(h('div', { class: 'page-head' }, h('div', null, crumbs(['Your books', '#/'], 'Start a new book'), h('h1', null, '🚀 Start a new book'))));
  const steps = ['Your book', 'Your AI', 'What to make', 'Review and go'];
  main.appendChild(h('ol', { class: 'wz-steps step-rail', 'aria-label': 'Steps' }, steps.map((s, i) => h('li', { class: i + 1 === w.step ? 'cur here rail-needs_you' : i + 1 < w.step ? 'done rail-done' : 'rail-blocked', 'aria-current': i + 1 === w.step ? 'step' : null },
    h('span', { class: 'rail-in' }, h('span', { class: 'wz-n rail-dot' }, i + 1 < w.step ? '✔' : String(i + 1)), h('span', { class: 'rail-lab' }, s))))));
  const card = h('section', { class: 'card wz-card', 'aria-labelledby': 'wz-h' });
  main.appendChild(card);
  const err = h('div', { 'aria-live': 'polite' });
  const nav = (back, next, nextLabel = 'Next ▶') => h('div', { class: 'form-actions' },
    back ? h('button', { type: 'button', onclick: back }, '◀ Back') : null,
    h('button', { type: 'button', class: 'primary', onclick: next }, nextLabel));
  const goStep = n => { w.step = n; save(); route(); };
  if (w.step === 1) {
    const pf = profileFields(w.profile, 'wz');
    const keep = () => { w.profile = Object.assign(w.profile, pf.get()); save(); };
    pf.el.addEventListener('input', keep); pf.el.addEventListener('change', keep);
    card.append(h('h2', { id: 'wz-h' }, '1. Tell me about your book'),
      h('p', { class: 'muted' }, 'Only the title is needed now; everything can be changed later.'), pf.el, err,
      nav(null, () => {
        keep(); clear(err);
        if (!w.profile.title) { err.appendChild(stateBox('failed', 'Give your book a title (a working title is fine)')); pf.f.title.focus(); return; }
        goStep(2);
      }));
    pf.f.title.focus();
  } else if (w.step === 2) {
    const list = h('div', { class: 'wz-ai', role: 'radiogroup', 'aria-labelledby': 'wz-h' });
    const opt = (value, label, detail, disabled) => {
      const id = uid('wzai');
      return h('div', { class: 'check-row wz-opt' }, h('input', { type: 'radio', name: 'wz-ai', id, value, checked: (w.ai || '') === value, disabled, onchange: () => { w.ai = value; save(); } }),
        h('label', { for: id }, h('strong', null, label), detail ? h('span', { class: 'hint' }, detail) : null));
    };
    list.appendChild(opt('', 'Automatic', 'Use the best AI that is ready each time.'));
    list.appendChild(h('p', { class: 'small muted' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Checking your AI slots…'));
    card.append(h('h2', { id: 'wz-h' }, '2. Which AI should help?'),
      h('p', { class: 'muted' }, 'BookForge can use up to three AIs (set them up in Settings). You can also write everything yourself.'), list,
      h('p', { class: 'small' }, 'No AI yet? ', h('a', { href: '#/settings' }, 'Open Settings'), ' to connect AutoInjector or add an API key — your answers here are kept.'), err,
      nav(() => goStep(1), () => goStep(3)));
    try {
      const slots = await loadSlotChoices(true);
      list.lastChild.remove();
      let ready = 0;
      for (const { s, health } of slots) {
        const st = slotStage(s, health);
        const usable = !['none', 'manual'].includes(s.adapter_id);
        if (usable && st.cls !== 'b-bad') ready++;
        list.appendChild(opt(s.slot_id, `${s.slot_id} · ${slotName(s)}`, `${st.icon} ${st.word} — ${st.now}`, !usable));
      }
      if (!ready) list.appendChild(h('p', { class: 'notice small' }, 'No AI is ready right now. You can still start: the book path will fill in forms for you to write, and you can connect an AI later.'));
    } catch (e) { list.lastChild.replaceWith(h('p', { class: 'small' }, 'Could not check the AI slots (they can be set up later).')); }
    list.appendChild(opt('manual', 'Manual — I’ll write it myself', 'No AI is used; BookForge prepares each form for you to fill in.'));
  } else if (w.step === 3) {
    const ai = w.ai !== 'manual';
    const num = (key, label, max, hint) => {
      const id = uid('wzn');
      const inp = h('input', { type: 'number', id, min: '0', max: String(max), step: '1', value: String(w.make[key] ?? 0), class: 'wz-num', onchange: () => { w.make[key] = Math.max(0, Math.min(max, parseInt(inp.value, 10) || 0)); save(); } });
      return h('div', { class: 'wz-make-row' }, h('label', { for: id }, h('strong', null, label), h('span', { class: 'hint' }, hint)), inp);
    };
    const tick = (key, label, hint) => {
      const id = uid('wzt');
      return h('div', { class: 'check-row wz-opt' }, h('input', { type: 'checkbox', id, checked: !!w.make[key], onchange: ev => { w.make[key] = ev.target.checked; save(); } }),
        h('label', { for: id }, h('strong', null, label), h('span', { class: 'hint' }, hint)));
    };
    card.append(h('h2', { id: 'wz-h' }, '3. What do you want me to make?'),
      h('p', { class: 'muted' }, ai ? 'Your AI drafts these; you read and approve each one. Nothing becomes part of the book until you approve it.'
        : 'You chose to write it yourself, so these become ready-to-fill forms in “Make my book”.'),
      num('A01', 'Characters', 10, 'Main cast, made to fit your idea (0 = none now).'),
      num('A04', 'Places', 10, 'Towns, rooms, landmarks.'),
      num('A03', 'World', 1, 'The world or setting as a whole (0 or 1).'),
      tick('premise', 'Premise', 'What the book is about, from your idea.'),
      tick('outline', 'Plot and chapter outline', 'The main plot and a chapter-by-chapter plan.'),
      h('p', { class: 'small muted' }, 'Chapters are written one at a time in “📘 Make my book”, after you approve the outline.'), err,
      nav(() => goStep(2), () => goStep(4)));
  } else {
    const p = w.profile;
    const aiLabel = w.ai === 'manual' ? 'I write it myself (no AI)' : w.ai || 'Automatic';
    const makeList = [w.make.A01 ? `${w.make.A01} character(s)` : null, w.make.A04 ? `${w.make.A04} place(s)` : null, w.make.A03 ? 'the world' : null,
      w.make.premise ? 'a premise' : null, w.make.outline ? 'the plot and chapter outline' : null].filter(Boolean);
    const go4 = h('button', { type: 'button', class: 'primary big' }, '🚀 Create my book');
    card.append(h('h2', { id: 'wz-h' }, '4. Ready?'),
      h('dl', { class: 'kv' }, h('dt', null, 'Title'), h('dd', null, p.title || '—'), h('dt', null, 'Author'), h('dd', null, p.author || '—'),
        h('dt', null, 'Genre / for'), h('dd', null, [p.genre, p.audience].filter(Boolean).join(' · ') || '—'),
        h('dt', null, 'Length'), h('dd', null, p.length ? LENGTH_INFO[p.length][0] : '—'), h('dt', null, 'Tone'), h('dd', null, p.tone || '—'),
        h('dt', null, 'Idea'), h('dd', null, p.idea || '—'), h('dt', null, 'AI'), h('dd', null, aiLabel),
        h('dt', null, 'To make'), h('dd', null, makeList.join(', ') || 'nothing yet')),
      h('p', { class: 'small muted' }, 'This creates the book with PDF, EPUB and Word (DOCX) output, then opens “📘 Make my book”, which walks you through every step.'),
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', onclick: () => goStep(3) }, '◀ Back'), go4));
    go4.addEventListener('click', async () => {
      clear(err); go4.disabled = true;
      err.appendChild(loadingState('Creating your book…'));
      try {
        const profile = Object.assign({}, p, { ai_slot: w.ai || '' });
        const proj = await api('POST', '/projects', { body: { name: p.title, profile, features: { character_arcs: true },
          release_profiles: ['MANUSCRIPT_PDF', 'EPUB_REFLOWABLE', 'EDITABLE_DOCX'] } });
        const counts = {};
        for (const k of ['A01', 'A04', 'A03']) if (w.make[k] > 0) counts[k] = w.make[k];
        if (w.ai !== 'manual' && Object.keys(counts).length && (p.idea || p.title)) {
          try {
            BB.session = await api('POST', '/bible-builder', { body: { project_id: proj.project_id, branch_id: 'main', idea: p.idea || p.title, counts,
              slot_id: ['AI-1', 'AI-2', 'AI-3'].includes(w.ai) ? w.ai : null } });
            toast('Book created — your AI is drafting the characters and places now');
          } catch (e) { toast(`Book created. The AI could not start yet: ${apiErrInfo(e).message}`); }
        } else toast('Book created');
        saveJSON(`bf:want:${proj.project_id}`, w.make);
        if (p.idea) saveJSON(`bf:bb-idea:${proj.project_id}`, p.idea);
        removeKey(WZ_KEY);
        await loadProjects();
        go(link('p', proj.project_id, 'main', 'book'));
      } catch (e) { clear(err).appendChild(failedState('The book was not created', e)); go4.disabled = false; }
    });
  }
}

/* ======================================================================= Make my book */
const BOOK_STATE = {
  done: ['✔', 'Done', 'b-ok'], needs_you: ['👋', 'Needs you', 'b-warn'], ai_can: ['✨', 'AI can do it', 'b-info'],
  ready: ['▶', 'Ready', 'b-info'], blocked: ['⏳', 'Waiting', 'b-muted'],
};
const STEP_WAIT = { B01: 'the premise', B03: 'the main plot', B11: 'the chapter outline', profile: 'the book profile', chapters: 'all chapters approved', format: 'the book format', assemble: 'the assembled book' };
async function viewBook(main) {
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [S.project.name, plink()], 'Make my book'), h('h1', null, '📘 Make my book')),
  h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => openProfileDialog(() => drawBook()) }, '📝 Book profile'),
    h('a', { class: 'btn', href: plink('journal') }, '📜 Journal'),
    h('button', { type: 'button', class: 'mab-cta', onclick: ev => openMakeBook(ev.currentTarget), title: 'Let the AI make a whole new book (this one is not touched)' }, '⚡ Make a book for me'))));
  const holder = h('div', null, loadingState('Checking where your book is…'));
  main.appendChild(holder);
  let book = null;
  const drawBook = async () => {
    try { book = await api('GET', bpath('/book')); }
    catch (e) { clear(holder).appendChild(failedState('Could not load the book path', e, h('p', null, h('button', { type: 'button', onclick: drawBook }, 'Try again')))); return; }
    renderBook(holder, book, drawBook);
  };
  await drawBook();
  S.onRecordsChanged = null;
}

const BOOK_ERR = {};   // step id -> the problem of the last attempt on this page (shown as ⚠️ on that step)
const RAIL_WORD = { done: 'done', needs_you: 'needs you', ai_can: 'AI can do it', ready: 'ready', blocked: 'waiting', problem: 'problem' };
function renderBook(holder, book, redraw) {
  clear(holder);
  const pct = Math.round((book.done_count / book.total) * 100);
  const msg = h('div', { 'aria-live': 'polite', class: 'book-msg' });
  let curStep = null;
  const run = async (fn, busyText, stepId) => {
    curStep = stepId || null;
    if (stepId) delete BOOK_ERR[`${S.pid}:${stepId}`];
    clear(msg).appendChild(loadingState(busyText || 'Working…'));
    try {
      const out = await fn();
      clear(msg);
      if (out && out.needs_manual) {
        fillNewForm(S.pid, S.branch, out.op, out.payload, { manualOn: true, from_book: { message: out.message } }, 'The form is ready — write it, then press Create');
        return;
      }
      if (out && !out.ok && curStep) BOOK_ERR[`${S.pid}:${curStep}`] = { code: out.code || 'FAILED', message: out.message, details: out.problems || null };
      const refused = (out && out.results || []).filter(r => !r.ok);
      const note = out ? stateBox(out.ok ? 'ok' : 'failed', out.message || (out.ok ? 'Done' : 'Not done'),
        (out.problems || []).length ? h('ul', null, out.problems.map(p => h('li', null, p))) : null,
        refused.length ? h('ul', null, refused.map(r => h('li', null, `${r.record_id}: ${(r.problems || []).join('; ')}`))) : null,
        refused.length ? h('p', { class: 'small' }, h('strong', null, 'How to fix it: '), refused[0].fix || 'Edit it so the checks pass.') : null,
        refused.length ? redoBox(refused.map(r => Object.assign({ title: '' }, r))) : null) : null;
      try { await refreshRecords(); } catch { /* best effort */ }
      if (out && out.book) renderBook(holder, out.book, redraw); else await redraw();
      // the message goes into the freshly drawn page, after the steps are up to date
      const nm = holder.querySelector('.book-msg'); if (nm && note) { clear(nm).appendChild(note); announce(out.message || ''); }
    } catch (e) {
      const st = book.steps.find(x => x.id === curStep);
      const p = toProblem(e, { book: profileOf().title || S.project.name, step: st ? st.title : 'Make my book', set: st && st.op ? st.op[0] : null, op: st ? st.op : null });
      if (curStep) BOOK_ERR[`${S.pid}:${curStep}`] = p;
      clear(msg).appendChild(problemBox(p, { retry: st ? () => doStep(st) : null }, 'That step did not work'));
      const li = holder.querySelector(`[data-book-step="${curStep}"] .bs-head`);
      if (li && !li.querySelector('.hazard')) li.appendChild(hazard(p, { retry: st ? () => doStep(st) : null }));
    }
  };
  const post = (action, body) => api('POST', bpath(`/book/${action}`), { body: body || {} });
  const approve = async (items, what) => {
    if (!items.length) return;
    const names = items.map(i => `• ${i.module_id} ${i.title}`).join('\n');
    const ok = await choiceDialog('Approve as the author?', h('div', null,
      h('p', null, `You are approving ${what}. Approving makes it part of the book; later steps build on it. If you change it later, the steps built on it are marked to redo.`),
      h('pre', { class: 'small' }, names),
      h('p', { class: 'small muted' }, 'Some steps need an explicit approval record; BookForge records one for exactly these versions because you confirm here.')),
    [{ id: 'yes', label: '✔ Yes, I approve' }]);
    if (ok !== 'yes') return;
    await run(() => post('approve', { record_ids: items.map(i => i.record_id), author_confirms: true }), 'Approving…', (book.steps.find(s => (s.approve || []).some(a => items.some(i => i.record_id === a.record_id))) || {}).id);
  };
  let bbPendingP = null;   // the wizard's Bible Builder entries not saved yet (canon step), when there are any
  const redoBox = (items) => {
    // A draft BookForge's checks refuse cannot be approved by pressing approve again: offer to redo or edit it.
    const box = h('div', { class: 'refused-box' });
    for (const i of items) {
      const redo = i.redo;
      box.appendChild(h('div', { class: 'row' }, h('span', { class: 'small' }, `${i.module_id} · ${i.title || i.record_id}: `),
        redo && book.ai_ready ? h('button', { type: 'button', class: 'small ai-btn', onclick: () => run(() => post(redo.action, Object.assign({}, redo, { action: undefined, redo: true })),
          'Your AI is writing it again… (web AIs can take a few minutes)', (book.steps.find(st => (st.approve || []).some(a => a.record_id === i.record_id)) || {}).id) }, '🔁 Redo with AI') : null,
        h('a', { class: 'btn small', href: plink('rec', i.record_id) }, '✏️ Edit it')));
    }
    return box;
  };
  const doStep = async s => {
    if (!s) return;
    if (s.id === 'profile') { openProfileDialog(() => redraw()); return; }
    if (s.approve && s.approve.length) {
      const ok = s.approve.filter(i => !(i.problems || []).length);
      if (!ok.length) {   // every waiting draft is refused by BookForge's checks: approving again cannot help
        clear(msg).appendChild(stateBox('failed', `BookForge’s checks found problems in the ${s.title.toLowerCase()}: let the AI write it again, or edit it`,
          h('ul', null, s.approve.flatMap(i => (i.problems || []).slice(0, 4).map(p => h('li', null, p)))), redoBox(s.approve),
          h('p', { class: 'small muted' }, 'Changed something it depends on since? ',
            h('button', { type: 'button', class: 'small', onclick: () => approve(s.approve, s.title.toLowerCase()) }, '✔ Check again and approve'))));
        msg.querySelector('button') && msg.querySelector('button').focus();
        return;
      }
      await approve(ok, s.title.toLowerCase()); return;
    }
    if (s.state === 'blocked') { toast(`Waiting for ${STEP_WAIT[s.waiting_for] || s.waiting_for}`); return; }
    if (s.id === 'canon') {
      // characters/places the 🚀 wizard asked the AI for and that are not saved yet: review and save those first
      const pend = bbPendingP ? await bbPendingP : null;
      if (pend && (pend.items.length || pend.busy)) { openBible(holder.querySelector('#step-canon .bb-wizard button')); return; }
      if (book.ai_ready) openMakeDialog('A01', null, null); else goNew('A01');
      return;
    }
    if (['premise', 'plot', 'outline'].includes(s.id)) { await run(() => post('create', { op: s.op }), book.ai_ready ? 'Your AI is writing… (web AIs can take a few minutes)' : 'Preparing the form…', s.id); return; }
    if (s.id === 'chapters') {
      const c = (s.chapters || []).find(x => x.state !== 'done' && !(x.prose && ['DRAFT', 'VALIDATED'].includes(x.prose.lifecycle)));
      if (c) await run(() => post('write_chapter', { chapter_id: c.chapter_id }), book.ai_ready ? `Your AI is writing chapter ${c.chapter_id}…` : 'Preparing the chapter form…', s.id);
      return;
    }
    if (s.action && ['setup_format', 'assemble', 'export', 'check'].includes(s.action)) await run(() => post(s.action), 'Working…', s.id);
  };
  const nextStep = book.steps.find(s => s.id === book.next);
  holder.appendChild(h('section', { class: 'card book-top' },
    h('div', { class: 'row space' }, h('div', null, h('strong', null, `${book.done_count} of ${book.total} steps done`),
      h('div', { class: 'small muted' }, book.ai_ready ? '✨ Your AI is connected: steps marked “AI can do it” are drafted for you.'
        : 'No AI connected (or you chose to write it yourself): creative steps open a ready-made form for you. ', book.ai_ready ? null : h('a', { href: '#/settings' }, 'Connect an AI in Settings'))),
    nextStep ? h('button', { type: 'button', class: 'primary big', onclick: () => doStep(nextStep) }, `▶ Do the next step: ${nextStep.title}`)
      : h('span', { class: 'badge b-ok' }, '🎉 Your book is made')),
    h('progress', { max: '100', value: String(pct), 'aria-label': `${pct}% done` }), wordsLine(book.words), msg));
  holder.appendChild(stepRail(book.steps.map(s => ({ id: s.id, title: s.title, state: BOOK_ERR[`${S.pid}:${s.id}`] ? 'problem' : s.state, word: RAIL_WORD[s.state] })),
    { label: 'Make my book: all steps', current: book.next }));
  const ol = h('ol', { class: 'book-steps' });
  const wordsBy = {};
  for (const c of ((book.words || {}).chapters || [])) wordsBy[c.chapter_id] = c;
  for (const s of book.steps) {
    const b = BOOK_STATE[s.state] || ['?', s.state, 'b-muted'];
    const err = BOOK_ERR[`${S.pid}:${s.id}`];
    const li = h('li', { class: `book-step bs-${s.state}${s.id === book.next ? ' current' : ''}${err ? ' bs-problem' : ''}`, id: `step-${s.id}`, tabindex: '-1', 'data-book-step': s.id },
      h('div', { class: 'row space bs-head' }, h('h3', null, s.title, s.id === book.next ? h('span', { class: 'here-tag' }, '👉 You are here') : null),
        h('span', { class: 'row' }, s.op ? setChip(s.op[0], s.op) : null, badge(b[0], b[1], b[2]),
          err ? hazard(Object.assign({}, toProblem(err), { where: { book: profileOf().title || S.project.name, step: s.title, set: s.op ? s.op[0] : null, op: s.op } }), { retry: () => doStep(s) }) : null)),
      h('p', { class: 'small' }, s.about));
    if (s.state === 'blocked' && s.waiting_for) li.appendChild(h('p', { class: 'small muted' }, `Waiting for ${STEP_WAIT[s.waiting_for] || s.waiting_for}.`));
    if (s.approve && s.approve.length) {
      li.appendChild(h('ul', { class: 'book-items' }, s.approve.map(i => h('li', null, h('a', { href: plink('rec', i.record_id) }, `${i.module_id} · ${i.title}`), ' ', lifecycleBadge(i.lifecycle),
        (i.problems || []).length ? [badge('⚠️', 'The checks found problems', 'b-bad'), ' ', redoBox([i])] : null,
        h('button', { type: 'button', class: 'small', onclick: () => approve([i], `“${i.title}”`) }, '✔ Approve')))));
    }
    const acts = h('div', { class: 'row' });
    if (s.id === 'profile') acts.appendChild(h('button', { type: 'button', class: 'small', onclick: () => openProfileDialog(() => redraw()) }, s.state === 'done' ? 'Edit' : 'Fill in'));
    if (s.id === 'canon') {
      acts.appendChild(h('button', { type: 'button', class: 'small ai-btn', disabled: !book.ai_ready, onclick: ev => openMakeDialog('A01', null, ev.currentTarget) }, '✨ Make up characters'));
      acts.appendChild(h('button', { type: 'button', class: 'small', onclick: () => goNew('A01') }, '✍️ Write one myself'));
      acts.appendChild(h('button', { type: 'button', class: 'small', onclick: ev => openBible(ev.currentTarget) }, '📖 Bible Builder'));
      if (s.state !== 'done') {
        const note = h('div', { class: 'bb-wizard', 'aria-live': 'polite' });
        li.appendChild(note);
        bbPendingP = wizardCanon(note);
      }
    }
    if (['premise', 'plot', 'outline'].includes(s.id) && s.state !== 'done' && s.state !== 'blocked') {
      if (book.ai_ready) acts.appendChild(h('button', { type: 'button', class: 'small ai-btn', onclick: () => run(() => post('create', { op: s.op }), 'Your AI is writing…') }, '✨ Let my AI draft it'));
      acts.appendChild(h('button', { type: 'button', class: 'small', onclick: () => run(() => post('create', { op: s.op, manual: true }), 'Preparing the form…') }, '✍️ Write it myself'));
      acts.appendChild(h('a', { class: 'btn small', href: plink('op', s.op) }, `Open ${s.op}`));
    }
    if (s.id === 'chapters' && (s.chapters || []).length) {
      li.appendChild(h('ul', { class: 'book-items' }, s.chapters.map(c => {
        const cb = BOOK_STATE[c.state] || BOOK_STATE.blocked;
        const wc = wordsBy[c.chapter_id];
        return h('li', null, h('strong', null, c.chapter_id), ` — ${c.objective || c.summary}`, ' ', badge(cb[0], cb[1], cb[2]),
          wc && (wc.approved_words || wc.draft_words) ? h('span', { class: 'small muted' }, ` ${Math.max(wc.approved_words, wc.draft_words)} words `) : ' ',
          c.prose ? h('a', { class: 'btn small', href: plink('rec', c.prose.record_id) }, 'Read') : null,
          c.state !== 'done' && !(c.prose && ['DRAFT', 'VALIDATED'].includes(c.prose.lifecycle))
            ? [book.ai_ready ? h('button', { type: 'button', class: 'small ai-btn', onclick: () => run(() => post('write_chapter', { chapter_id: c.chapter_id }), `Your AI is writing ${c.chapter_id}… (web AIs can take a few minutes)`) }, '✨ Write it with AI') : null,
              h('button', { type: 'button', class: 'small', onclick: () => run(() => post('write_chapter', { chapter_id: c.chapter_id, manual: true }), 'Preparing the chapter form…') }, '✍️ Write it myself')] : null);
      })));
    }
    if (s.id === 'chapters' && book.ai_ready && (s.chapters || []).some(c => c.state !== 'done' && !c.prose)) {
      const wa = writeAllBox(book, redraw);
      acts.appendChild(h('button', { type: 'button', class: 'small ai-btn', 'data-testid': 'write-all', onclick: () => wa.start() }, '✍ Write all chapters'));
      li.appendChild(wa);
    } else if (s.id === 'chapters' && (s.chapters || []).length) {
      li.appendChild(writeAllBox(book, redraw));
    }
    if (['setup_format', 'assemble', 'export', 'check'].includes(s.action)) {
      const label = s.action === 'setup_format' && s.out_of_date ? '⚙️ Make the format again (new title/author)'
        : s.action === 'export' && (s.files || []).some(f => f.out_of_date) ? '📦 Export my book again'
        : { setup_format: '⚙️ Set up the book format', assemble: '🧩 Put the book together', export: '📦 Export my book', check: '🔎 Check the book' }[s.action];
      acts.appendChild(h('button', { type: 'button', class: 'small primary', onclick: () => run(() => post(s.action), 'Working…', s.id) }, label));
    }
    if (s.approve && s.approve.length > 1) acts.appendChild(h('button', { type: 'button', class: 'small', onclick: () => approve(s.approve, `${s.approve.length} items`) }, `✔ Approve all ${s.approve.length}`));
    if (s.id === 'check' && s.result) li.appendChild(h('p', { class: 'small' }, 'Result: ', badge(s.result === 'PASS' ? '✔' : '✕', s.result, s.result === 'PASS' ? 'b-ok' : 'b-bad')));
    if (s.id === 'export' && (s.files || []).length) {
      li.appendChild(h('div', { class: 'downloads' }, h('strong', null, '⬇ Download my book: '),
        s.files.map(f => h('button', { type: 'button', class: f.out_of_date ? 'small' : 'primary small', title: f.out_of_date ? `Made with the old title “${f.title || ''}”: export again for the new one` : null,
          onclick: () => downloadAsset(f) }, f.format, f.out_of_date ? ' (out of date)' : '')),
        s.files.some(f => f.out_of_date) ? h('p', { class: 'small notice' }, '⚠️ These files still carry the old title/author. Make the book format again and export again to update them.') : null));
    }
    if (acts.childNodes.length) li.appendChild(acts);
    ol.appendChild(li);
  }
  holder.appendChild(ol);
  if (S.pendingBookStep) {
    const want = S.pendingBookStep; S.pendingBookStep = null;
    const st = book.steps.find(x => x.id === want.id);
    if (st && st.state !== 'done') setTimeout(() => doStep(st), 0);
  }
  holder.appendChild(h('p', { class: 'small muted' }, 'Behind the scenes this uses the real steps: A01 → B01 → B03 → B11 → C01/C02 → book format (I01) → G02/G01/G05/G04/G07 → G11/G12/G13 → H05. Full release readiness (H10) is in the Quality Checks set.'));
}

async function wizardCanon(note) {
  // The 🚀 wizard asks the AI for characters/places in a Bible Builder session; show them here until they are saved.
  try {
    const r = await api('GET', `/bible-builder?project_id=${encodeURIComponent(S.pid)}&branch_id=${encodeURIComponent(S.branch)}`);
    const sess = r && r.session;
    if (!sess) return null;
    const items = (sess.items || []).filter(i => i.status === 'done' && !i.created_ref && i.valid !== false);
    if (!items.length && !sess.busy) return null;
    clear(note).append(h('p', { class: 'small notice' },
      sess.busy && !items.length ? '⏳ Your AI is still making the characters and places you asked for in the wizard…'
        : `✨ Your AI made these for you (not saved yet): ${items.map(i => `${i.name} (${i.op})`).join(', ')}. `,
      h('button', { type: 'button', class: 'small primary', onclick: ev => openBible(ev.currentTarget) }, '📖 Review and save them')));
    return { busy: !!sess.busy, items };
  } catch { return null; }   // the book page works without it
}

async function downloadAsset(f) {
  try {
    const blob = await api('GET', bpath(`/assets/${encodeURIComponent(f.record_id)}/${f.version}`), { blob: true });
    // Named after the title the file carries (a file made before the title changed keeps its old name).
    const name = downloadName(f.title || profileOf().title || S.project.name, f.format);
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`Downloading ${name}`);
  } catch (e) { toast(`Download failed: ${apiErrInfo(e).message}`); }
}

/* ======================================================================= Current task + approvals count */
const TASK_ICON = { needs_you: '👋', ai_can: '✨', working: '⏳', blocked: '⏸︎', done: '🎉' };
function taskRef(t) {
  if (!t) return '';
  if (!t.op) return 'Book profile';
  return `Set ${t.set} · ${t.op}`;
}
function myTask() { return S.task && S.task.project_id === S.pid && S.task.branch_id === S.branch ? S.task : null; }
/** "▶ Current task": one big button to exactly the next thing the book needs. */
function taskCard(where) {
  const t = myTask();
  const box = h('section', { class: `task-card task-${where}`, 'aria-labelledby': `task-h-${where}` },
    h('h2', { id: `task-h-${where}` }, '▶ Current task'));
  if (!t) { box.appendChild(h('p', { class: 'small muted' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Checking what is next…')); return box; }
  const ct = t.current_task || {};
  box.appendChild(h('button', { type: 'button', class: `primary big task-btn ts-${ct.state}`, 'data-action': ct.action || '',
    onclick: ev => runTask(ct, ev.currentTarget) }, h('span', { 'aria-hidden': 'true' }, `${TASK_ICON[ct.state] || '▶'} `), ct.title || 'Open Make my book'));
  if (ct.message) box.appendChild(h('p', { class: 'small task-msg' }, ct.message));
  if (t.working_on) box.appendChild(h('p', { class: 'small task-working' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` ${t.working_on.title}…`));
  if (t.book && t.book.words && t.book.words.words) {
    const w = t.book.words;
    box.appendChild(h('div', { class: 'task-words small' }, `📝 ${w.words.toLocaleString()} / ~${w.target_words.toLocaleString()} words`,
      h('progress', { max: '100', value: String(w.percent || 0), 'aria-label': `${w.percent || 0}% of the word target` })));
  }
  box.appendChild(h('p', { class: 'small muted task-ref' }, taskRef(ct)));
  return box;
}
function approvalsButton() {
  const t = myTask();
  const n = t ? t.count : null;
  const here = parseRoute()[3] === 'review';
  return h('a', { class: `btn approvals-btn${n ? ' has-items' : ''}`, href: plink('review'), 'aria-current': here ? 'page' : null },
    h('span', { 'aria-hidden': 'true' }, '📝 '), 'Needs your approval ', h('span', { class: 'count-badge', 'aria-label': n == null ? 'counting' : `${n} waiting` }, n == null ? '(…)' : `(${n})`));
}
function updateTaskUI() {
  const nav = document.getElementById('nav-task');
  if (nav) { clear(nav); nav.appendChild(taskCard('nav')); nav.appendChild(approvalsButton()); }
  for (const slot of document.querySelectorAll('.task-slot')) { clear(slot).appendChild(taskCard(slot.dataset.where || 'page')); }
  if (S.onTaskChanged) { try { S.onTaskChanged(); } catch { /* cosmetic */ } }
  const made = !!(myTask() && myTask().current_task && myTask().current_task.state === 'done');
  if (made !== S.lastMade) {   // "What's next" follows the Current task (redrawn only when "made" changes)
    S.lastMade = made;
    if (S.onGuideChanged) { try { S.onGuideChanged(); } catch { /* cosmetic */ } }
  }
}
let taskBusy = false; let taskAgain = false;
/** Refresh the current task and the approvals count (after every action, and every 10 s while the tab is visible). */
async function refreshTask() {
  if (!S.pid || S.authFailed || parseRoute()[0] !== 'p') return;
  if (taskBusy) { taskAgain = true; return; }
  taskBusy = true;
  const pid = S.pid; const branch = S.branch;
  try {
    const s = await api('GET', bpath('/review/summary'));
    if (pid === S.pid && branch === S.branch) { S.task = s; updateTaskUI(); }
  } catch { /* keep the last known state; the next refresh tries again */ }
  finally {
    taskBusy = false;
    if (taskAgain) { taskAgain = false; refreshTask(); }
  }
}
function initTaskTimer() {
  setInterval(() => { if (document.visibilityState === 'visible') refreshTask(); }, 10000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshTask(); });
}
/** Do what the current task says: open the review queue at the first draft, the step, the chapter, the form… */
function runTask(ct, opener) {
  if (!ct) return;
  const onBook = parseRoute()[3] === 'book';
  switch (ct.action) {
    case 'review': go(plink('review', 'step', ct.record_id)); break;
    case 'make': openMakeDialog(ct.op || 'A01', null, opener); break;
    case 'new': goNew(ct.op || 'A01'); break;
    case 'profile':
      if (onBook) { openProfileDialog(() => route()); break; }
      S.pendingBookStep = { id: 'profile' }; go(plink('book')); break;
    case 'book_step':
      S.pendingBookStep = { id: ct.step, chapter_id: ct.chapter_id };
      if (onBook) route(); else go(plink('book'));
      break;
    default: go(plink('book'));
  }
}
/** From pages outside a book (e.g. after pairing): open the last book and do its current task. */
async function goCurrentTask({ run = true } = {}) {
  try { await loadProjects(); } catch { /* handled below */ }
  const real = S.projects.filter(p => !p.test_book);
  const last = loadJSON('bf:last', null);
  const pick = (last && real.find(p => p.project_id === last.pid)) ? { pid: last.pid, branch: last.branch || 'main' }
    : real.length ? { pid: real[real.length - 1].project_id, branch: 'main' } : null;
  if (!pick) { go('#/start'); return; }
  try {
    await ensureProject(pick.pid, pick.branch);
    S.task = await api('GET', bpath('/review/summary'));
    if (!run) { go(plink('book')); return; }  // e.g. after pairing: show the book, let the author press the next step
    runTask(S.task.current_task, null);
  } catch { go(link('p', pick.pid, pick.branch)); }
}

/* ======================================================================= review queue (#/p/…/review) */
const VERDICT = { APPROVE: ['✔', 'AI: approve', 'b-ok'], REVISE: ['✎', 'AI: revise', 'b-warn'], REJECT: ['✕', 'AI: reject', 'b-bad'] };
const RV = { skipped: new Set(), slot: '', seq: 0 };
function verdictBadge(rv) {
  if (!rv) return null;
  const b = VERDICT[rv.verdict] || ['?', rv.verdict, 'b-muted'];
  return badge(b[0], b[1], b[2], rv.slot_label ? `Reviewed by ${rv.slot_label}` : null);
}
function reviewFromQueue(q) {
  S.task = Object.assign({}, S.task && S.task.project_id === S.pid ? S.task : {}, {
    project_id: S.pid, branch_id: S.branch, count: q.count, current_task: q.current_task, book: q.book });
  updateTaskUI();
}
function verdictBox(rv, item, { onFix, onEdit } = {}) {
  if (!rv) return null;
  const kind = rv.verdict === 'APPROVE' ? 'ok' : rv.verdict === 'REVISE' ? 'stale' : 'failed';
  const words = { APPROVE: 'The AI reviewer would approve this draft', REVISE: 'The AI reviewer suggests changes', REJECT: 'The AI reviewer would not approve this draft' }[rv.verdict] || 'AI review';
  return stateBox(kind, words,
    h('p', { class: 'small muted' }, `${rv.slot_label || rv.slot || 'AI'}${typeof rv.confidence === 'number' ? ` · confidence ${Math.round(rv.confidence * 100)}%` : ''} · ${fmtTime(rv.at)} · this is advice; only you approve.`),
    (rv.reasons || []).length ? [h('strong', null, 'Why:'), h('ul', null, rv.reasons.map(r => h('li', null, r)))] : null,
    (rv.suggested_changes || []).length ? [h('strong', null, 'Suggested changes:'), h('ul', null, rv.suggested_changes.map(r => h('li', null, r)))] : null,
    rv.verdict !== 'APPROVE' && (onFix || onEdit) ? h('div', { class: 'row' },
      onFix ? h('button', { type: 'button', class: 'primary', onclick: onFix }, '🤖 Ask AI to fix it') : null,
      onEdit ? h('button', { type: 'button', onclick: onEdit }, '✏️ Edit myself') : null) : null);
}
async function approveIds(items, how) {
  return api('POST', bpath('/review/approve'), { body: {
    record_ids: items.map(i => i.record_id), versions: Object.fromEntries(items.map(i => [i.record_id, i.version])),
    author_confirms: true, how } });
}
function approveReport(out, items) {
  const byId = Object.fromEntries(items.map(i => [i.record_id, i]));
  const failed = (out.results || []).filter(r => !r.ok);
  return stateBox(failed.length ? 'failed' : 'ok', out.message || (failed.length ? 'Some drafts were not approved' : 'Approved'),
    failed.length ? h('ul', null, failed.map(r => h('li', null, h('strong', null, (byId[r.record_id] || {}).title || r.record_id), ' — ', r.message || 'not approved'))) : null);
}
async function runReviewJob(start, progressEl, { label } = {}) {
  const seq = RV.seq;
  let job;
  try { job = await start(); } catch (e) { clear(progressEl).appendChild(errorWithFix('The AI review could not start', apiErrInfo(e))); return null; }
  const cancel = h('button', { type: 'button', class: 'small', onclick: async () => {
    cancel.disabled = true;
    try { await api('POST', bpath(`/review/ai/${encodeURIComponent(job.job_id)}/cancel`)); } catch { /* the job ends anyway */ }
  } }, 'Stop');
  const line = h('span');
  const bar = h('progress', { max: String(job.total || 1), value: '0', 'aria-label': 'AI review progress' });
  clear(progressEl).appendChild(h('div', { class: 'state loading' }, h('p', { class: 'row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), line, cancel), bar));
  const show = j => {
    line.textContent = `${label || 'AI review'}: ${j.done} of ${j.total} done · ${j.phase || ''} · ${fmtClock(j.elapsed_ms || 0)}`;
    bar.max = j.total || 1; bar.value = j.done || 0;
  };
  show(job);
  while (!['done', 'error', 'cancelled'].includes(job.status)) {
    await sleep(1000);
    if (seq !== RV.seq) return null;  // the page changed; the job keeps running on the server
    try { job = await api('GET', bpath(`/review/ai/${encodeURIComponent(job.job_id)}`)); } catch { continue; }
    show(job);
  }
  clear(progressEl);
  return job;
}
function jobSummary(job) {
  if (!job) return null;
  if (job.status === 'error') return errorWithFix('The AI review did not work', job.error || {});
  const res = job.results || [];
  const okRes = res.filter(r => r.ok && r.review);
  const n = v => okRes.filter(r => r.review.verdict === v).length;
  const auto = res.filter(r => r.auto_approved).length;
  const bad = res.filter(r => !r.ok);
  return stateBox(bad.length ? 'failed' : 'ok', job.status === 'cancelled' ? `Stopped after ${res.length} of ${job.total}` : `AI reviewed ${okRes.length} draft(s)`,
    h('p', null, `${n('APPROVE')} approve · ${n('REVISE')} revise · ${n('REJECT')} reject`, auto ? ` · ${auto} approved automatically under your auto-approve setting` : ''),
    bad.length ? h('ul', null, bad.map(r => h('li', null, `${r.record_id}: ${(r.error || {}).message || 'failed'}`, (r.error || {}).fix ? h('div', { class: 'small' }, (r.error || {}).fix) : null))) : null);
}
function autoApproveCard(q, reload) {
  const st = q.settings || {};
  const id = uid('auto');
  const box = h('input', { type: 'checkbox', id, checked: !!st.auto_approve, 'aria-describedby': `${id}-h` });
  const out = h('div', { 'aria-live': 'polite' });
  box.addEventListener('change', async () => {
    const on = box.checked;
    if (on) {
      const ok = await choiceDialog('Turn on auto-approve?', h('div', null,
        h('p', { class: 'notice' }, h('strong', null, '⚠︎ '), st.warning || ''),
        h('p', null, 'This is your standing permission for this book. BookForge records who turned it on and when, and every automatic approval appears in Activity.')),
      [{ id: 'yes', label: '✔ Yes, auto-approve drafts that pass the AI review' }]);
      if (ok !== 'yes') { box.checked = false; return; }
    }
    box.disabled = true;
    try {
      await api('PUT', bpath('/review/settings'), { body: on ? { auto_approve: true, author_confirms: true } : { auto_approve: false } });
      toast(on ? 'Auto-approve is on for this book' : 'Auto-approve is off');
      await reload();
    } catch (e) { box.checked = !on; clear(out).appendChild(errorWithFix('The setting was not changed', apiErrInfo(e))); }
    box.disabled = false;
  });
  return h('section', { class: `card auto-card${st.auto_approve ? ' on' : ''}`, 'aria-labelledby': `${id}-t` },
    h('h2', { id: `${id}-t` }, '⚙️ Auto-approve (optional, off unless you turn it on)'),
    h('div', { class: 'check-row' }, box, h('label', { for: id }, h('strong', null, 'Auto-approve drafts that pass the AI review'))),
    h('p', { class: 'small', id: `${id}-h` }, st.warning || ''),
    st.auto_approve && st.consent ? h('p', { class: 'small muted' }, `Turned on by ${st.consent.by} on ${fmtTime(st.consent.at)}.`) : null, out);
}
async function viewReview(main, step, startId) {
  S.slotCache = null;  // AI slots may have been connected in another tab (pairing)
  RV.seq++;
  const mySeq = RV.seq;
  S.leaveHooks.push(() => { if (RV.seq === mySeq) RV.seq++; });
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [S.project.name, plink()], step ? ['Needs your approval', plink('review')] : 'Needs your approval', ...(step ? ['One by one'] : [])),
    h('h1', null, step ? '📝 Approve one by one' : '📝 Needs your approval')),
  h('div', { class: 'row' }, step ? h('a', { class: 'btn', href: plink('review') }, '☰ Back to the list') : null,
    h('a', { class: 'btn', href: plink('book') }, '📘 Make my book'))));
  const holder = h('div', null, loadingState('Loading the drafts waiting for you…'));
  main.appendChild(holder);
  const load = async () => { const q = await api('GET', bpath('/review')); reviewFromQueue(q); return q; };
  let q;
  try { q = await load(); } catch (e) {
    clear(holder).appendChild(failedState('Could not load the drafts waiting for you', e, h('p', null, h('button', { type: 'button', onclick: () => route() }, 'Try again'))));
    return;
  }
  if (step) renderReviewStep(holder, q, startId, load); else renderReviewList(holder, q, load);
}
function allCaughtUp(holder, q) {
  holder.appendChild(h('section', { class: 'card caught-up' },
    h('h2', null, '🎉 All caught up'),
    h('p', null, 'Nothing is waiting for your approval right now.'),
    h('div', { class: 'task-slot', 'data-where': 'page' }, taskCard('page'))));
}
function renderReviewList(holder, q, load) {
  clear(holder);
  const msg = h('div', { 'aria-live': 'polite' });
  const prog = h('div', { 'aria-live': 'polite' });
  const reload = async (keepMsg) => {
    let nq; try { nq = await load(); } catch (e) { clear(msg).appendChild(failedState('Could not refresh the list', e)); return; }
    const m = keepMsg ? Array.from(msg.childNodes) : [];
    renderReviewList(holder, nq, load);
    const nm = holder.querySelector('.rv-msg'); if (nm && m.length) append(nm, m);
    try { await refreshRecords(); } catch { /* best effort */ }
  };
  msg.className = 'rv-msg';
  const shown = q.items.filter(i => !RV.skipped.has(i.record_id));
  const skipped = q.items.filter(i => RV.skipped.has(i.record_id));
  const picker = aiPicker(uid('rv-ai'), RV.slot);
  picker.sel.addEventListener('change', () => { RV.slot = picker.sel.value; });
  const approveAll = h('button', { type: 'button', class: 'primary', disabled: !shown.length, onclick: async () => {
    const ok = await choiceDialog(`Approve all ${shown.length} as the author?`, h('div', null,
      h('p', null, 'You are approving these drafts. Approving makes them part of the book; later steps build on them. BookForge adds an extra approval record for exactly these versions where a step needs one, because you confirm here.'),
      h('ul', { class: 'small approve-list' }, shown.map(i => h('li', null, `${i.module_id} · ${i.title}`, i.review ? ` (AI: ${i.review.verdict.toLowerCase()})` : '')))),
    [{ id: 'yes', label: `✅ Yes, approve all ${shown.length}` }]);
    if (ok !== 'yes') return;
    approveAll.disabled = true;
    clear(msg).appendChild(loadingState(`Approving ${shown.length} draft(s)…`));
    try { const out = await approveIds(shown, 'all'); clear(msg).appendChild(approveReport(out, shown)); announce(out.message); }
    catch (e) { clear(msg).appendChild(errorWithFix('Nothing was approved', apiErrInfo(e))); }
    await reload(true);
  } }, `✅ Approve all shown (${shown.length})`);
  const reviewAll = h('button', { type: 'button', disabled: !shown.length, onclick: async () => {
    reviewAll.disabled = true; clear(msg);
    const job = await runReviewJob(() => api('POST', bpath('/review/ai'), { body: { record_ids: shown.slice(0, 40).map(i => i.record_id), slot_id: picker.value() } }), prog, { label: 'Reviewing with AI' });
    if (job) { clear(msg).appendChild(jobSummary(job)); await reload(true); }
  } }, '🤖 Review all with AI');
  holder.appendChild(h('section', { class: 'card rv-top' },
    h('p', null, h('strong', null, shown.length ? `${shown.length} draft(s) are waiting for you` : 'Nothing is waiting for you'),
      skipped.length ? h('span', { class: 'muted' }, ` · ${skipped.length} skipped for now`) : null,
      h('span', { class: 'muted small' }, ' · in book order: characters and places → planning → chapters → book format → assembly')),
    h('div', { class: 'row rv-actions' },
      h('a', { class: `btn big${shown.length ? ' primary' : ''}`, href: plink('review', 'step'), 'aria-disabled': shown.length ? null : 'true' }, '▶ Step through them one by one'),
      approveAll, reviewAll),
    h('div', { class: 'rv-ai-pick' }, picker.field), prog, msg));
  if (!shown.length && !skipped.length) { allCaughtUp(holder, q); holder.appendChild(autoApproveCard(q, () => reload(false))); return; }
  let group = null; let ul = null;
  for (const it of shown) {
    if (it.group !== group) {
      group = it.group;
      ul = h('ul', { class: 'record-list rv-list' });
      holder.appendChild(h('section', { class: 'card rv-group', 'aria-label': group }, h('h2', null, group), ul));
    }
    ul.appendChild(reviewRow(it, { reload, msg, prog, picker }));
  }
  if (!shown.length) allCaughtUp(holder, q);
  if (skipped.length) {
    holder.appendChild(h('details', { class: 'card' }, h('summary', null, `⏭ Skipped for now (${skipped.length})`),
      h('ul', { class: 'record-list' }, skipped.map(it => h('li', { class: 'record-item' }, h('div', { class: 'r-main' }, h('a', { class: 'r-title', href: plink('rec', it.record_id) }, it.title), h('div', { class: 'r-meta' }, `${it.module_id} · v${it.version}`))))),
      h('button', { type: 'button', onclick: () => { RV.skipped.clear(); renderReviewList(holder, q, load); } }, 'Show them again')));
  }
  holder.appendChild(autoApproveCard(q, () => reload(false)));
}
function reviewRow(it, { reload, msg, prog, picker }) {
  const details = it.review && ((it.review.reasons || []).length || (it.review.suggested_changes || []).length)
    ? h('details', { class: 'small rv-why' }, h('summary', null, 'Why the AI said that'),
      h('ul', null, (it.review.reasons || []).map(r => h('li', null, r))),
      (it.review.suggested_changes || []).length ? h('p', null, h('strong', null, 'Suggested: '), it.review.suggested_changes.join(' · ')) : null) : null;
  const approveBtn = h('button', { type: 'button', class: 'small primary', onclick: async () => {
    approveBtn.disabled = true; clear(msg).appendChild(loadingState(`Approving “${it.title}”…`));
    try { const out = await approveIds([it], 'one'); clear(msg).appendChild(approveReport(out, [it])); announce(out.message); }
    catch (e) { clear(msg).appendChild(errorWithFix('It was not approved', apiErrInfo(e))); }
    await reload(true);
  } }, '✅ Approve');
  const aiBtn = h('button', { type: 'button', class: 'small', onclick: async () => {
    aiBtn.disabled = true; clear(msg);
    const job = await runReviewJob(() => api('POST', bpath('/review/ai'), { body: { record_ids: [it.record_id], slot_id: picker.value() } }), prog, { label: `Reviewing “${it.title}”` });
    if (job) { clear(msg).appendChild(jobSummary(job)); await reload(true); } else aiBtn.disabled = false;
  } }, '🤖 AI review');
  return h('li', { class: 'record-item rv-item', 'data-record': it.record_id },
    h('div', { class: 'r-main' },
      h('a', { class: 'r-title', href: plink('rec', it.record_id) }, it.title),
      h('div', { class: 'r-meta' }, `${it.module_id} ${it.op_name} · v${it.version} · made by ${it.made_by.label} · ${fmtTime(it.created_at)}`),
      details),
    h('div', { class: 'r-badges' }, lifecycleBadge(it.lifecycle), verdictBadge(it.review)),
    h('div', { class: 'row rv-buttons' },
      h('a', { class: 'btn small', href: plink('review', 'step', it.record_id) }, 'Open'),
      approveBtn,
      h('a', { class: 'btn small', href: plink('edit', it.record_id) }, '✏️ Edit'),
      h('button', { type: 'button', class: 'small', onclick: () => { RV.skipped.add(it.record_id); reload(false); } }, '⏭ Skip'),
      aiBtn));
}
async function renderReviewStep(holder, q, startId, load) {
  clear(holder);
  const shown = q.items.filter(i => !RV.skipped.has(i.record_id));
  if (!shown.length) {
    allCaughtUp(holder, q);
    if (q.items.length) holder.appendChild(h('p', null, h('button', { type: 'button', onclick: () => { RV.skipped.clear(); renderReviewStep(holder, q, null, load); } }, `Show the ${q.items.length} skipped draft(s) again`)));
    return;
  }
  const it = shown.find(i => i.record_id === startId) || shown[0];
  const idx = shown.indexOf(it);
  const want = plink('review', 'step', it.record_id);
  if (location.hash !== want) history.replaceState(null, '', want);
  const msg = h('div', { 'aria-live': 'polite', class: 'rv-msg' });
  const prog = h('div', { 'aria-live': 'polite' });
  const nextAfter = (nq, curId) => {
    const order = q.items.map(i => i.record_id);
    const pos = order.indexOf(curId);
    const remaining = nq.items.filter(i => !RV.skipped.has(i.record_id));
    return remaining.find(i => order.indexOf(i.record_id) > pos) || remaining[0] || null;
  };
  const go2 = async (curId, keep) => {
    let nq; try { nq = await load(); } catch (e) { clear(msg).appendChild(failedState('Could not load the next draft', e)); return; }
    const nx = nextAfter(nq, curId);
    const keepNodes = keep ? Array.from(msg.childNodes) : [];
    await renderReviewStep(holder, nq, nx ? nx.record_id : null, load);
    const nm = holder.querySelector('.rv-msg'); if (nm && keepNodes.length) append(nm, keepNodes);
    const hd = holder.querySelector('h2'); if (hd) { hd.setAttribute('tabindex', '-1'); hd.focus({ preventScroll: false }); }
    try { await refreshRecords(); } catch { /* best effort */ }
  };
  const stay = async (rid) => {
    let nq; try { nq = await load(); } catch (e) { clear(msg).appendChild(failedState('Could not refresh', e)); return; }
    const keepNodes = Array.from(msg.childNodes);
    await renderReviewStep(holder, nq, rid, load);
    const nm = holder.querySelector('.rv-msg'); if (nm && keepNodes.length) append(nm, keepNodes);
    try { await refreshRecords(); } catch { /* best effort */ }
  };
  const picker = aiPicker(uid('st-ai'), RV.slot);
  picker.sel.addEventListener('change', () => { RV.slot = picker.sel.value; });
  const fix = async () => {
    clear(msg);
    const job = await runReviewJob(() => api('POST', bpath('/review/fix'), { body: { record_id: it.record_id, slot_id: picker.value() } }), prog, { label: 'The AI is revising this draft' });
    if (!job) return;
    if (job.status === 'done' && (job.results || [])[0]) { clear(msg).appendChild(stateBox('ok', job.results[0].message)); S.details[it.record_id] = null; await stay(it.record_id); }
    else clear(msg).appendChild(errorWithFix('The AI could not revise it', job.error || {}));
  };
  const approveBtn = h('button', { type: 'button', class: 'primary big', onclick: async () => {
    approveBtn.disabled = true; clear(msg).appendChild(loadingState('Approving…'));
    let out = null;
    try { out = await approveIds([it], 'step'); } catch (e) { clear(msg).appendChild(errorWithFix('It was not approved', apiErrInfo(e))); approveBtn.disabled = false; return; }
    clear(msg).appendChild(approveReport(out, [it]));
    announce(out.message);
    if (out.ok) await go2(it.record_id, true); else { approveBtn.disabled = false; await stay(it.record_id); }
  } }, '✅ Approve & next');
  const aiBtn = h('button', { type: 'button', class: 'big', onclick: async () => {
    aiBtn.disabled = true; clear(msg);
    const job = await runReviewJob(() => api('POST', bpath('/review/ai'), { body: { record_ids: [it.record_id], slot_id: picker.value() } }), prog, { label: 'AI review' });
    if (!job) { aiBtn.disabled = false; return; }
    clear(msg).appendChild(jobSummary(job));
    const r0 = (job.results || [])[0];
    if (r0 && r0.auto_approved) await go2(it.record_id, true); else await stay(it.record_id);
  } }, '🤖 Ask AI to review');
  const content = h('div', { class: 'data-view' }, loadingState('Loading the draft…'));
  holder.appendChild(h('section', { class: 'card rv-step', 'aria-labelledby': 'rv-step-h' },
    h('p', { class: 'small muted' }, `Draft ${idx + 1} of ${shown.length} · ${it.group}`),
    h('h2', { id: 'rv-step-h', class: 'wrap-anywhere' }, it.title),
    h('p', { class: 'row small' }, lifecycleBadge(it.lifecycle), verdictBadge(it.review), ` ${it.module_id} ${it.op_name} · v${it.version} · made by ${it.made_by.label} · ${fmtTime(it.created_at)}`),
    h('div', { class: 'row rv-big' }, approveBtn,
      h('button', { type: 'button', class: 'big', onclick: () => { RV.skipped.add(it.record_id); go2(it.record_id, false); } }, '⏭ Skip'),
      h('a', { class: 'btn big', href: plink('edit', it.record_id) }, '✏️ Edit'),
      aiBtn),
    h('div', { class: 'rv-ai-pick' }, picker.field), prog, msg,
    verdictBox(it.review, it, { onFix: fix, onEdit: () => go(plink('edit', it.record_id)) }),
    h('h3', null, 'What it says'), content,
    h('p', { class: 'small' }, h('a', { href: plink('rec', it.record_id) }, 'Open the full record page (history, sources, findings)'))));
  try {
    const d = await recordDetail(it.record_id, true);
    const v = d.versions.find(x => x.version === it.version) || d.versions[d.versions.length - 1];
    clear(content).appendChild((v.representation === 'BINARY_ARTIFACT' || v.binary) ? assetView(v) : renderData(v.data, ''));
  } catch (e) { clear(content).appendChild(failedState('Could not load the draft', e)); }
}
/** Record page: the AI reviewer's advice for this exact version and a button to ask for it. */
function recordReviewCard(cur) {
  const box = h('section', { class: 'card', 'aria-labelledby': 'rvc-h' }, h('h2', { id: 'rvc-h' }, '🤖 AI review'));
  const body = h('div', null, loadingState('Checking for an AI review…'));
  const prog = h('div', { 'aria-live': 'polite' });
  const msg = h('div', { 'aria-live': 'polite' });
  box.appendChild(body); box.appendChild(prog); box.appendChild(msg);
  const draw = async () => {
    let info;
    try { info = await api('GET', bpath(`/review/record/${encodeURIComponent(cur.record_id)}`)); }
    catch (e) { clear(body).appendChild(h('p', { class: 'small muted' }, 'The AI review is not available right now.')); return; }
    const rv = (info.reviews || {})[String(cur.version)];
    clear(body);
    if (rv) body.appendChild(verdictBox(rv, cur, { onEdit: () => go(plink('edit', cur.record_id)),
      onFix: info.in_queue ? async () => {
        const job = await runReviewJob(() => api('POST', bpath('/review/fix'), { body: { record_id: cur.record_id } }), prog, { label: 'The AI is revising this draft' });
        if (job && job.status === 'done') { S.details[cur.record_id] = null; go(plink('rec', cur.record_id)); route(); }
        else if (job) clear(msg).appendChild(errorWithFix('The AI could not revise it', job.error || {}));
      } : null }));
    else body.appendChild(h('p', { class: 'small' }, 'Ask one of your AIs to read this draft like a strict editor: it answers approve, revise or reject with reasons. It is advice only — you decide.'));
    body.appendChild(h('div', { class: 'row' },
      h('button', { type: 'button', onclick: async ev => {
        ev.currentTarget.disabled = true;
        const job = await runReviewJob(() => api('POST', bpath('/review/ai'), { body: { record_ids: [cur.record_id] } }), prog, { label: 'AI review' });
        if (job) { clear(msg).appendChild(jobSummary(job)); S.details[cur.record_id] = null; if ((job.results || []).some(r => r.auto_approved)) route(); else draw(); }
      } }, rv ? '🔁 Review again with AI' : '🤖 Ask AI to review'),
      info.in_queue ? h('a', { class: 'btn', href: plink('review', 'step', cur.record_id) }, '📝 Open in “Needs your approval”') : null));
  };
  draw();
  return box;
}

/* ======================================================================= one-button pairing (#/pair) */
async function viewPair(main) {
  const info = S.pairing; S.pairing = null;
  main.appendChild(h('div', { class: 'page-head' }, h('h1', null, '🔗 Connect to AutoInjector')));
  if (!info || !info.code) {
    main.appendChild(stateBox('empty', 'No pairing code here',
      h('p', null, 'Press “Connect” in the AutoInjector desktop app: it opens this page with a one-time code and BookForge connects by itself. The code works once and only for about 2 minutes.'),
      h('p', null, 'You can also paste a connection key in ', h('a', { href: '#/settings' }, 'Settings'), '.')));
    return;
  }
  const holder = h('div', { 'aria-live': 'polite' }, loadingState('Connecting to AutoInjector…'));
  main.appendChild(holder);
  let out;
  try { out = await api('POST', '/slots/pair-autoinjector', { body: { code: info.code, bridge_url: info.bridge } }); }
  catch (e) {
    const err = apiErrInfo(e);
    clear(holder).appendChild(stateBox('failed', 'AutoInjector was not connected',
      h('p', null, err.message),
      h('p', null, h('strong', null, 'What to do: '), err.code === 'EXPIRED_APPROVAL' || err.code === 'INVALID_INPUT'
        ? 'Press Connect again in AutoInjector. A new code is made each time.'
        : 'Make sure the AutoInjector desktop app is running and its BookForge bridge is switched on, then press Connect again in AutoInjector.'),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/settings' }, 'Open Settings (connect with a key instead)'),
        h('button', { type: 'button', onclick: () => goCurrentTask() }, '▶ Go to my current task'))));
    return;
  }
  S.slotCache = null;
  const allOk = (out.slots || []).length && out.slots.every(s => s.ok);
  const countdown = h('span', { class: 'small muted' });
  let timer = null; let left = 6;
  const stopTimer = () => { clearInterval(timer); timer = null; countdown.textContent = ''; };
  S.leaveHooks.push(stopTimer);
  clear(holder).appendChild(stateBox(allOk ? 'ok' : 'blocked', allOk ? 'Connected to AutoInjector' : 'Connected — some AIs are not ready yet',
    h('p', null, out.message || ''),
    h('ul', { class: 'plain-list pair-list' }, (out.slots || []).map(s => h('li', { class: 'row' },
      h('strong', null, `${s.slot_id} · ${SITE_NAME[s.site] || s.site}`),
      s.ok ? badge('✔', 'Ready', 'b-ok') : badge('✕', 'Not ready', 'b-bad'),
      h('span', { class: 'small' }, s.ok ? 'ready to write' : (s.message || 'not ready') + ' — open and log in to it in AutoInjector')))),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary big', onclick: () => { stopTimer(); goCurrentTask(); } }, '▶ Continue to my current task'),
      allOk ? h('button', { type: 'button', onclick: stopTimer }, 'Stay here') : null, countdown)));
  announce(allOk ? 'Connected to AutoInjector' : 'Connected; some AIs are not ready yet');
  if (allOk) {
    countdown.textContent = `Going to your current task in ${left} s…`;
    timer = setInterval(() => {
      left -= 1;
      if (left <= 0) { stopTimer(); if (parseRoute()[0] === 'pair') goCurrentTask({ run: false }); return; }
      countdown.textContent = `Going to your current task in ${left} s…`;
    }, 1000);
  }
}

/* ======================================================================= 🧪 Test workflow drawer */
const WF = { open: false, timer: null, data: null, opener: null, built: false, el: {} };
const WF_BADGE = { not_run: ['○', 'Not run', 'b-muted'], running: ['…', 'Running', 'b-info'], PASS: ['✔', 'Pass', 'b-ok'], FAIL: ['✕', 'Fail', 'b-bad'], SKIPPED: ['–', 'Skipped', 'b-muted'] };
function initWorkflowDrawer() {
  const btn = $('#wf-btn'); const d = $('#wf-drawer');
  if (!btn || !d) return;
  btn.addEventListener('click', () => toggleWorkflow(!WF.open, btn));
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape' || !WF.open || document.querySelector('dialog[open]')) return;
    if ($('#sidenav').classList.contains('open') && !d.contains(ev.target)) return;
    toggleWorkflow(false);
  });
}
function toggleWorkflow(open, opener) {
  const d = $('#wf-drawer'); const btn = $('#wf-btn');
  WF.open = open;
  d.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('wf-open', open);
  clearTimeout(WF.timer);
  if (open) {
    WF.opener = opener || btn;
    if (!WF.built) buildWorkflow();
    refreshWorkflow();
    setTimeout(() => { const f = d.querySelector('button'); if (f) f.focus(); }, 0);
  } else if (WF.opener && WF.opener.focus) WF.opener.focus();
}
function buildWorkflow() {
  const d = clear($('#wf-drawer'));
  const E = WF.el = {};
  E.runAll = h('button', { type: 'button', class: 'primary', onclick: () => wfStart({ rows: 'all' }) }, '▶ Run all');
  E.stop = h('button', { type: 'button', onclick: async () => { try { WF.data = await api('POST', '/workflow-test/stop'); wfRender(); } catch (e) { toast(apiErrInfo(e).message); } } }, '■ Stop');
  E.report = h('button', { type: 'button', onclick: wfReport }, '📄 Open report');
  E.project = h('a', { class: 'btn', href: '#/' }, '📂 Open the test book');
  E.status = h('p', { class: 'small wf-status', 'aria-live': 'polite' });
  E.msg = h('div', { 'aria-live': 'polite' });
  E.rows = {};
  const list = h('ol', { class: 'wf-rows' });
  d.appendChild(h('div', { class: 'wf-head' }, h('h2', { id: 'wf-title' }, '🧪 Test workflow'),
    h('button', { type: 'button', class: 'small', 'aria-label': 'Close the test workflow panel', onclick: () => toggleWorkflow(false) }, '✕')));
  d.appendChild(h('p', { class: 'small' }, 'Test each part of making a book with your real AI — as often as you like. Everything happens in a separate test book (“🧪 Workflow test …”); your books are never touched. Approvals in the test book are made by the test runner because you press Run.'));
  d.appendChild(h('div', { class: 'row wf-controls' }, E.runAll, E.stop, E.report, E.project));
  d.appendChild(E.status); d.appendChild(E.msg); d.appendChild(list);
  WF.list = list;
  WF.built = true;
}
function wfRowEl(r) {
  const E = WF.el;
  if (E.rows[r.id]) return E.rows[r.id];
  const x = {};
  x.badge = h('span'); x.time = h('span', { class: 'small muted' }); x.last = h('span', { class: 'small muted' });
  x.btn = h('button', { type: 'button', class: 'small', onclick: () => wfStart({ rows: [r.id] }) }, '▶ Run');
  x.detail = h('p', { class: 'small wf-detail' }); x.fix = h('p', { class: 'small wf-fix' }); x.excerpt = h('p', { class: 'small muted' });
  x.mode = h('p', { class: 'small muted' });
  x.li = h('li', { class: 'wf-row', 'data-row': r.id },
    h('div', { class: 'row wf-row-head' }, h('strong', { class: 'wf-title' }, r.title), x.badge, x.time, x.btn),
    x.last,
    h('details', { class: 'wf-more' }, h('summary', null, 'details'),
      h('p', { class: 'small' }, h('strong', null, 'What it checks: '), r.about), x.detail, x.mode, x.excerpt, x.fix));
  WF.list.appendChild(x.li);
  E.rows[r.id] = x;
  return x;
}
function wfRender() {
  const st = WF.data; if (!st || !WF.built) return;
  const E = WF.el;
  E.runAll.disabled = st.running; E.stop.disabled = !st.running;
  E.report.disabled = !st.report;
  E.project.hidden = !(st.project && st.project.id);
  if (st.project && st.project.id) E.project.href = link('p', st.project.id, 'main');
  const cur = st.rows.find(r => r.id === st.current);
  E.status.textContent = st.running ? (st.stopping ? 'Stopping after the current row…' : `Running: ${cur ? cur.title : '…'}`)
    : st.report ? `Last run: ${st.report.counts.PASS} pass · ${st.report.counts.FAIL} fail · ${st.report.counts.SKIPPED} skipped · ${fmtTime(st.report.finished_at)}`
      : 'Not run yet. Press ▶ Run all (a few seconds without AI; web AIs can take a few minutes).';
  for (const r of st.rows) {
    const x = wfRowEl(r);
    const b = WF_BADGE[r.status] || ['?', r.status, 'b-muted'];
    clear(x.badge).appendChild(r.status === 'running' ? h('span', { class: 'badge b-info' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Running') : badge(b[0], b[1], b[2]));
    if (r.status === 'FAIL') x.badge.appendChild(hazard({ code: 'FAILED', message: r.detail || 'This test row failed.', fix: r.fix, where: { step: `Test workflow › ${r.title}` } }, { retry: () => wfStart({ rows: [r.id] }), retryLabel: '🔁 Re-run this row' }, { small: true }));
    x.time.textContent = r.elapsed_ms != null ? fmtMs(r.elapsed_ms) : '';
    x.last.textContent = r.last_run_at ? `Last run ${fmtTime(r.last_run_at)}` : 'Not run yet';
    x.btn.textContent = r.last_run_at ? '🔁 Re-run' : '▶ Run';
    x.btn.disabled = st.running;
    x.li.className = `wf-row wf-${String(r.status).toLowerCase()}`;
    x.detail.textContent = r.detail ? `What happened: ${r.detail}` : '';
    x.mode.textContent = r.mode ? (r.mode === 'AI' ? 'Used your AI.' : 'Used a fixed test text (no AI).') : '';
    x.excerpt.textContent = r.excerpt ? `Short excerpt: “${r.excerpt}”` : '';
    x.fix.textContent = r.fix && r.status !== 'PASS' ? `What to do: ${r.fix}` : '';
  }
}
async function refreshWorkflow() {
  clearTimeout(WF.timer);
  try { WF.data = await api('GET', '/workflow-test'); wfRender(); }
  catch (e) { if (WF.el.msg) clear(WF.el.msg).appendChild(errorWithFix('Could not read the test status', apiErrInfo(e))); }
  if (WF.open && WF.data && WF.data.running) WF.timer = setTimeout(refreshWorkflow, 1000);
  else if (WF.data && !WF.data.running && WF.wasRunning) { WF.wasRunning = false; loadProjects().catch(() => {}); }
}
async function wfStart(body) {
  if (WF.el.msg) clear(WF.el.msg);
  try { WF.data = await api('POST', '/workflow-test/run', { body }); WF.wasRunning = true; wfRender(); announce('Workflow test started'); }
  catch (e) {
    if (e instanceof ApiError && e.status === 409) toast('A test is already running');
    else clear(WF.el.msg).appendChild(errorWithFix('The test could not start', apiErrInfo(e)));
  }
  refreshWorkflow();
}
async function wfReport() {
  try {
    const blob = await api('GET', '/workflow-test/report?format=md', { blob: true });
    const text = await blob.text();
    const name = (WF.data && WF.data.report && WF.data.report.markdown) || 'workflow-test.md';
    modal('📄 Workflow test report', close => h('div', null,
      h('p', { class: 'small muted' }, `Saved as ${name} in the “reports” folder of your BookForge data. No keys or prompts are in it.`),
      h('pre', { class: 'st-report', tabindex: '0' }, text),
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', onclick: () => {
          const url = URL.createObjectURL(blob); const a = h('a', { href: url, download: name });
          document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
        } }, '⬇ Download (.md)'), h('button', { type: 'button', onclick: close }, 'Close'))), { wide: true });
  } catch (e) { toast(`The report could not be opened: ${apiErrInfo(e).message}`); }
}

/* ======================================================================= ⚠️ problems where they are (R1-R3, S20) */
// Every problem is shown ON the element that has it: a yellow ⚠️ button that opens a small popover with
// WHERE (book › set › step › field), WHAT (plain words, technical code folded away), HOW TO FIX, and a
// 🔁 "Try again" / "Open the form" / "Open Settings" button plus 📋 Copy diagnostics.
/** el.append() that skips null/false children (h()-style). */
function put(el, ...kids) { return append(el, kids); }
const CLIENT_ERRORS = [];   // recent problems this page saw (codes, paths, short messages) for 📋 Copy diagnostics
function noteClientError(code, where, message) {
  CLIENT_ERRORS.push({ at: new Date().toISOString(), code: String(code || ''), where: String(where || '').slice(0, 120), message: String(message || '').slice(0, 200) });
  if (CLIENT_ERRORS.length > 30) CLIENT_ERRORS.shift();
}
/** A problem object from anything that went wrong: ApiError, NetworkError, a job/run error {code, message, fix}, or an Error. */
function toProblem(e, where) {
  if (e && e.__problem) return where ? Object.assign({}, e, { where: Object.assign({}, e.where || {}, where) }) : e;
  let code; let message; let path = ''; let fix = null; let status = null;
  if (e instanceof ApiError) {
    const x = e.errors[0] || {};
    code = x.code || `HTTP_${e.status}`; message = x.message || `HTTP ${e.status}`; path = x.path || ''; fix = x.fix || null; status = e.status;
  } else if (e instanceof NetworkError) { code = 'NETWORK'; message = e.message; }
  else if (e && typeof e === 'object' && !(e instanceof Error) && (e.code || e.message)) { code = e.code; message = e.message; path = e.path || ''; fix = e.fix || null; }
  else { code = 'BROWSER'; message = (e && e.message) || String(e); }
  const p = problemFor(code, status);
  return { __problem: true, code: code || 'UNKNOWN', status, message: message || '', path, title: p.title, what: p.what,
    fix: fix || p.fix, action: p.action, where: Object.assign({}, (e && e.where) || {}, where || {}),
    options: (e && e.options) || null, details: (e && e.details) || null, raw: e };
}
function whereText(w, { book = true } = {}) {
  w = w || {};
  const parts = [];
  if (w.book && book) parts.push(w.book);
  if (w.set) parts.push(`${w.set} · ${w.set_name || setInfo(w.set).name}`);
  if (w.step) parts.push(w.step + (w.op && !String(w.step).includes(w.op) ? ` (${w.op})` : ''));
  else if (w.op) parts.push(opLabel(w.op));
  if (w.chapter) parts.push(`Chapter ${w.chapter}`);
  if (w.field) parts.push(`field “${w.field}”`);
  return parts.join(' › ') || 'This page';
}
let HZ = null;
function closeHazard(restore = true) {
  if (!HZ) return;
  const { pop, anchor, onDoc, onKey } = HZ; HZ = null;
  document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true);
  pop.remove();
  if (restore && anchor && document.contains(anchor)) { try { anchor.focus(); } catch { /* ignore */ } }
}
/** actions: {retry: fn, retryLabel, form: fn, open: href, openLabel, settings: true, extra: [{label, fn, cls}]} */
function openHazard(anchor, prob, actions = {}) {
  closeHazard(false);
  const p = toProblem(prob);
  const busy = h('span', { class: 'small muted', 'aria-live': 'polite' });
  const act = (label, fn, cls) => h('button', { type: 'button', class: `small ${cls || ''}`, onclick: async ev => {
    const b = ev.currentTarget; b.disabled = true; put(clear(busy), 'Working…');
    try { await fn(); closeHazard(false); } catch (e) { put(clear(busy), `Did not work: ${toProblem(e).title}`); b.disabled = false; }
  } }, label);
  const buttons = [];
  if (actions.retry) buttons.push(act(actions.retryLabel || '🔁 Try again', actions.retry, 'primary'));
  for (const x of actions.extra || []) buttons.push(act(x.label, x.fn, x.cls));
  if (actions.form) buttons.push(act('✏️ Open the form', actions.form));
  if (actions.open) buttons.push(h('a', { class: 'btn small', href: actions.open, onclick: () => closeHazard(false) }, actions.openLabel || 'Open it'));
  if (actions.settings || (p.action === 'settings' && actions.settings !== false)) buttons.push(h('a', { class: 'btn small', href: '#/settings', onclick: () => closeHazard(false) }, '⚙️ Open Settings'));
  buttons.push(h('button', { type: 'button', class: 'small', onclick: () => copyDiagnostics() }, '📋 Copy diagnostics'));
  const id = uid('hz');
  const pop = h('div', { class: 'hz-pop', role: 'dialog', 'aria-labelledby': `${id}-t`, tabindex: '-1' },
    h('div', { class: 'hz-head' }, h('strong', { id: `${id}-t` }, h('span', { 'aria-hidden': 'true' }, '⚠️ '), p.title),
      h('button', { type: 'button', class: 'small', 'aria-label': 'Close', onclick: () => closeHazard() }, '✕')),
    h('dl', { class: 'hz-dl' },
      h('dt', null, 'Where'), h('dd', null, whereText(p.where)),
      h('dt', null, 'What happened'), h('dd', null, p.what, p.message && p.message !== p.what ? h('span', { class: 'hz-msg' }, ` ${p.message}`) : null,
        (p.details || []).length ? h('ul', { class: 'small' }, p.details.slice(0, 6).map(d => h('li', null, String(d)))) : null),
      h('dt', null, 'How to fix it'), h('dd', null, p.fix)),
    h('details', { class: 'hz-tech' }, h('summary', null, 'Technical details'),
      h('p', { class: 'small' }, h('code', null, p.code), p.path ? [' at ', h('code', null, p.path)] : null, p.status ? ` · HTTP ${p.status}` : null)),
    h('div', { class: 'row hz-actions' }, buttons), busy);
  // Inside a modal dialog only the dialog is interactive (top layer), so the popover goes into it.
  (anchor.closest('dialog[open]') || document.body).appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const w = Math.min(440, window.innerWidth - 16);
  pop.style.width = `${w}px`;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  const ph = pop.offsetHeight;
  if (top + ph > window.innerHeight - 8) top = r.top - ph - 6 > 8 ? r.top - ph - 6 : window.innerHeight - ph - 8;
  pop.style.left = `${left}px`; pop.style.top = `${Math.max(8, top)}px`;
  const onDoc = ev => { if (!pop.contains(ev.target) && ev.target !== anchor && !anchor.contains(ev.target)) closeHazard(false); };
  const onKey = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); closeHazard(); } };
  document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true);
  HZ = { pop, anchor, onDoc, onKey };
  const first = pop.querySelector('.hz-actions button, .hz-actions a'); (first || pop).focus();
  noteClientError(p.code, whereText(p.where, { book: false }), p.message);
}
/** The ⚠️ marker: put it on the exact element that has the problem. */
function hazard(prob, actions = {}, { label = null, small = false } = {}) {
  const p = toProblem(prob);
  return h('button', { type: 'button', class: `hazard${small ? ' hz-small' : ''}`, 'aria-haspopup': 'dialog', title: `${p.title} — click for details`,
    'aria-label': `Problem: ${p.title}. Show where, what and how to fix it`, 'data-code': p.code,
    onclick: ev => { ev.preventDefault(); ev.stopPropagation(); openHazard(ev.currentTarget, p, actions); } },
  h('span', { 'aria-hidden': 'true' }, '⚠️'), label ? h('span', { class: 'hz-label' }, label) : null);
}
/** A plain-language problem box (big) with the ⚠️ marker, the fix and the right buttons. */
function problemBox(prob, actions = {}, title = null) {
  const p = toProblem(prob);
  const buttons = [];
  if (actions.retry) buttons.push(h('button', { type: 'button', class: 'primary small', onclick: actions.retry }, actions.retryLabel || '🔁 Try again'));
  for (const x of actions.extra || []) buttons.push(h('button', { type: 'button', class: `small ${x.cls || ''}`, onclick: x.fn }, x.label));
  if (actions.form) buttons.push(h('button', { type: 'button', class: 'small', onclick: actions.form }, '✏️ Open the form'));
  if (actions.open) buttons.push(h('a', { class: 'btn small', href: actions.open }, actions.openLabel || 'Open it'));
  if (actions.settings || p.action === 'settings') buttons.push(h('a', { class: 'btn small', href: '#/settings' }, '⚙️ Open Settings'));
  buttons.push(h('button', { type: 'button', class: 'small', onclick: () => copyDiagnostics() }, '📋 Copy diagnostics'));
  return h('section', { class: 'state problem', role: 'alert' },
    h('h3', null, hazard(p, actions), h('span', null, title || p.title)),
    h('p', null, p.what, p.message && p.message !== p.what ? h('span', { class: 'muted' }, ` (${p.message})`) : null),
    (p.details || []).length ? h('ul', { class: 'small' }, p.details.slice(0, 6).map(d => h('li', null, String(d)))) : null,
    h('p', null, h('strong', null, 'How to fix it: '), p.fix),
    h('details', { class: 'hz-tech small' }, h('summary', null, 'Technical details'), h('code', null, p.code), p.path ? [' at ', h('code', null, p.path)] : null),
    h('div', { class: 'row' }, buttons));
}
/** Field-level problem for forms outside the schema form engine (profile, ⚡ settings, backups…). */
function markFieldProblem(control, prob, where) {
  if (!control) return;
  const wrap = control.closest('.field') || control.parentElement;
  const p = toProblem(prob, where);
  let err = wrap.querySelector(':scope > .field-error');
  if (!err) { err = h('span', { class: 'field-error', id: uid('ferr') }); wrap.appendChild(err); }
  put(clear(err), hazard(p, { form: () => { control.focus(); } }, { small: true }), ' ', p.message || p.title);
  err.hidden = false;
  wrap.classList.add('has-error');
  control.setAttribute('aria-invalid', 'true');
  const d = (control.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
  if (!d.includes(err.id)) d.push(err.id);
  control.setAttribute('aria-describedby', d.join(' '));
}
function clearFieldProblems(root) {
  for (const w of root.querySelectorAll('.has-error')) w.classList.remove('has-error');
  for (const e of root.querySelectorAll('.field-error')) { clear(e); e.hidden = true; }
  for (const c of root.querySelectorAll('[aria-invalid="true"]')) c.removeAttribute('aria-invalid');
}
/** Server errors (JSON pointers) → the matching controls; returns the errors that had no field. */
function showFieldErrors(e, fields, where) {
  const errs = e instanceof ApiError ? e.errors : [];
  const rest = [];
  for (const x of errs) {
    const key = String(x.path || '').replace(/^\/(payload|profile)?\/?/, '').split('/')[0];
    const ctl = fields[key];
    if (ctl) markFieldProblem(ctl, x, Object.assign({}, where, { field: (ctl.labels && ctl.labels[0] ? ctl.labels[0].textContent : key) }));
    else rest.push(x);
  }
  return rest;
}

/** 📋 Copy diagnostics: a safe report (no keys, prompts or book text) from the server, plus this page's recent problems. */
async function copyDiagnostics({ download = false } = {}) {
  const client = { user_agent: navigator.userAgent, screen: `${window.innerWidth}x${window.innerHeight}`,
    page: (location.hash || '#/').split('/').slice(0, 2).join('/'), errors: CLIENT_ERRORS.slice(-15) };
  let text;
  try {
    const rep = await api('POST', '/diagnostics', { body: { client } });
    const full = Object.assign({}, rep); delete full.text;
    text = `${rep.text}\n${JSON.stringify(full, null, 2)}`;
  } catch (e) {
    text = ['BookForge diagnostics (the BookForge program did not answer, so only this page\'s view is included)',
      `Generated: ${new Date().toISOString()}`, `Browser: ${client.user_agent}`, `Screen: ${client.screen}`,
      `Problem reaching BookForge: ${toProblem(e).code}`, 'Recent problems on this page:',
      ...CLIENT_ERRORS.slice(-15).map(x => `  ${x.at} ${x.code} ${x.where} ${x.message}`)].join('\n');
  }
  if (download) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = h('a', { href: url, download: 'bookforge-diagnostics.txt' }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('Diagnostics downloaded (no keys, prompts or book text)');
    return text;
  }
  await copyText(text, 'Diagnostics copied (no keys, prompts or book text) — paste it into your message');
  return text;
}
/** The global safety net: anything unexpected becomes a ⚠️ bar with details and Copy diagnostics (never silent). */
function showGlobalProblem(prob) {
  const p = toProblem(prob, { step: (document.querySelector('main h1') || {}).textContent || 'This page' });
  noteClientError(p.code, whereText(p.where, { book: false }), p.message);
  let bar = document.getElementById('global-problem');
  if (!bar) bar = h('div', { id: 'global-problem', class: 'global-problem', role: 'alert' });
  const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;  // stay visible above an open dialog
  if (bar.parentElement !== host) host.appendChild(bar);
  put(clear(bar), hazard(p, { retry: p.action === 'reload' ? () => location.reload() : null, retryLabel: '🔁 Reload the page' }),
    h('span', { class: 'gp-text' }, h('strong', null, p.title), ' — ', p.message.length > 140 ? p.message.slice(0, 137) + '…' : p.message),
    h('button', { type: 'button', class: 'small', onclick: () => copyDiagnostics() }, '📋 Copy diagnostics'),
    h('button', { type: 'button', class: 'small', 'aria-label': 'Dismiss', onclick: () => bar.remove() }, '✕'));
}

/* ======================================================================= shared: downloads, set chips, clocks */
// A file name from a book title: every letter and digit of any script is kept (Café Ñandú, Война и мир, 雪国);
// only characters file systems refuse or treat specially are dropped.
function safeFileStem(title) {
  return String(title || '').normalize('NFC').replace(/[^\p{L}\p{M}\p{N}\-_ '’.,()&!]+/gu, ' ')
    .replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120).trim();
}
function downloadName(title, format) {
  const ext = { PDF: 'pdf', EPUB: 'epub', DOCX: 'docx' }[format] || 'bin';
  return `${safeFileStem(title) || 'book'}.${ext}`;
}
async function downloadFile(pid, branch, f, title) {
  try {
    const blob = await api('GET', `/projects/${encodeURIComponent(pid)}/branches/${encodeURIComponent(branch)}/assets/${encodeURIComponent(f.record_id)}/${f.version}`, { blob: true });
    const name = downloadName(f.title || title, f.format);
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`Downloading ${name}`);
  } catch (e) { showGlobalProblem(toProblem(e, { step: `Download ${f.format}` })); }
}
function setChip(letter, op) {
  if (!letter) return null;
  return h('span', { class: `set-chip set-${letter}`, title: `Set ${letter} · ${setInfo(letter).name}${op ? ` · ${opLabel(op)}` : ''}` },
    h('span', { class: 'sc-l' }, letter), op ? h('span', { class: 'sc-op' }, op) : null);
}
function fmtElapsed(ms) {
  if (!ms || ms < 0) return '0 s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
function sinceMs(iso, endIso) {
  if (!iso) return 0;
  const a = Date.parse(iso); const b = endIso ? Date.parse(endIso) : Date.now();
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : 0;
}
function wordsLine(w) {
  if (!w || !w.target_words) return null;
  const pct = Math.max(0, Math.min(100, w.percent || 0));
  return h('div', { class: 'words-line' },
    h('div', { class: 'row space' }, h('span', null, h('span', { 'aria-hidden': 'true' }, '📝 '), h('strong', null, `${(w.words || 0).toLocaleString()} words`),
      h('span', { class: 'muted' }, ` of about ${w.target_words.toLocaleString()}`)),
    h('span', { class: 'small muted' }, w.draft_words ? `${(w.approved_words || 0).toLocaleString()} approved · ${w.draft_words.toLocaleString()} more in drafts`
      : `${(w.approved_words || 0).toLocaleString()} approved`)),
    h('progress', { class: 'words-bar', max: '100', value: String(pct), 'aria-label': `Words: ${pct}% of the target` }),
    w.short && w.warning ? h('p', { class: 'words-warn small', role: 'note' }, h('span', { 'aria-hidden': 'true' }, '⚠️ '), w.warning) : null);
}

/* ======================================================================= ⚡ Make a book for me (R14, S21) */
const MB = { dialog: null, run: null, poll: null, tick: null, opener: null, latest: null, view: 'setup', sig: '' };
const RUN_WORD = { queued: ['…', 'Starting', 'b-info'], running: ['⏳', 'Working', 'b-ai'], waiting: ['⏳', 'Waiting for the AI', 'b-warn'],
  pausing: ['⏸', 'Pausing…', 'b-warn'], paused: ['⏸', 'Paused', 'b-warn'], done: ['✔', 'Done', 'b-ok'], cancelled: ['✖', 'Cancelled', 'b-muted'],
  interrupted: ['⚠️', 'Interrupted', 'b-warn'] };
const STEP_ICON = { pending: '○', running: '⏳', waiting: '⏳', done: '✔', failed: '⚠️', paused: '⏸', cancelled: '✖', skipped: '–' };
function initMakeBook() {
  const btn = $('#mab-btn');
  if (btn) btn.addEventListener('click', ev => openMakeBook(ev.currentTarget));
  const d = $('#mab-dialog');
  d.addEventListener('cancel', ev => { ev.preventDefault(); if (!HZ) closeMakeBook(); });
  refreshRunChip();
  setInterval(() => { if (document.visibilityState === 'visible' && !S.authFailed) refreshRunChip(); }, 5000);
}
async function refreshRunChip() {
  if (!S.token || S.authFailed) return;
  let out;
  try { out = await api('GET', '/autobook'); } catch { return; }
  const live = (out.active || [])[0];
  const pend = (out.runs || []).find(r => ['paused', 'interrupted', 'pausing'].includes(r.status));
  MB.latest = live || pend || null;
  const btn = $('#mab-btn'); if (!btn) return;
  const lab = btn.querySelector('.tb-label');
  btn.classList.toggle('running', !!live);
  btn.classList.toggle('needs-you', !live && !!pend);
  if (live) {
    const done = live.steps.filter(s => s.state === 'done').length;
    lab.textContent = live.status === 'waiting' ? `Waiting… ${done}/${live.steps.length}` : `Making… ${done}/${live.steps.length}`;
    btn.setAttribute('aria-label', `Make a book for me: working, ${done} of ${live.steps.length} steps done. Open the progress window`);
  } else if (pend) {
    lab.textContent = pend.status === 'interrupted' ? 'Interrupted' : 'Paused';
    btn.setAttribute('aria-label', 'Make a book for me: paused, needs you. Open the progress window');
  } else { lab.textContent = 'Make a book'; btn.setAttribute('aria-label', 'Make a book for me'); }
}
async function openMakeBook(opener, { runId = null, fresh = false } = {}) {
  MB.opener = opener || null;
  const d = $('#mab-dialog'); MB.dialog = d;
  if (!d.open) { try { d.showModal(); } catch { d.setAttribute('open', ''); } }
  let run = null;
  try {
    if (runId) run = await api('GET', `/autobook/${encodeURIComponent(runId)}`);
    else if (!fresh) { await refreshRunChip(); if (MB.latest) run = await api('GET', `/autobook/${encodeURIComponent(MB.latest.id)}`); }
  } catch (e) { run = null; }
  if (run) { MB.run = run; MB.view = 'progress'; renderRun(); startRunPolling(); }
  else { MB.view = 'setup'; renderMakeSetup(); }
}
function closeMakeBook() {
  stopRunPolling();
  const d = MB.dialog || $('#mab-dialog');
  try { if (d.open) d.close(); } catch { /* ignore */ }
  const o = MB.opener && document.contains(MB.opener) ? visibleOpener(MB.opener) : $('#mab-btn');
  if (o && o.focus) { try { o.focus(); } catch { /* ignore */ } }
  refreshRunChip();
}
function mbShell(title, ...body) {
  const d = MB.dialog;
  put(clear(d), h('div', { class: 'st-head' }, h('h2', { id: 'mab-title' }, title),
    h('button', { type: 'button', class: 'small', onclick: closeMakeBook, 'aria-label': 'Close (the run keeps going in the background)' }, '✕ Close')), ...body);
}
async function renderMakeSetup() {
  const fields = {};
  const err = h('div', { 'aria-live': 'polite' });
  const genre = h('input', { type: 'text', id: 'mb-genre', list: 'mb-genres', maxlength: '120', placeholder: 'Let the AI choose', autocomplete: 'off' });
  const idea = h('textarea', { id: 'mb-idea', rows: '3', maxlength: '2000', placeholder: 'Let the AI choose (or write one sentence: who, where, what goes wrong)' });
  const lengths = Object.entries(LENGTH_INFO).map(([k, [l, dsc]]) => {
    const id = `mb-len-${k}`;
    return h('div', { class: 'check-row wz-opt' }, h('input', { type: 'radio', name: 'mb-len', id, value: k, checked: k === 'short_story' }),
      h('label', { for: id }, h('strong', null, l), h('span', { class: 'hint' }, dsc + (k === 'short_story' ? ' — quickest (recommended for a first try)' : ''))));
  });
  const slot = h('select', { id: 'mb-slot' }, h('option', { value: '' }, 'Automatic — the best ready AI'));
  fields.genre = genre; fields.idea = idea; fields.slot_id = slot;
  const lengthBox = h('fieldset', { class: 'field', id: 'mb-length' }, h('legend', null, 'Length'), lengths);
  fields.length = lengthBox.querySelector('input');
  const startAll = h('button', { type: 'button', class: 'primary big mab-go', 'data-testid': 'mb-start-auto' }, '⚡ Start — let the AI choose everything');
  const startSet = h('button', { type: 'submit', class: 'big', 'data-testid': 'mb-start' }, '⚡ Start with these settings');
  const form = h('form', { novalidate: true, class: 'mb-setup', onsubmit: ev => { ev.preventDefault(); go(false); } },
    h('p', { class: 'lead' }, 'BookForge makes a whole new book for you with your AI — characters, plot, every chapter — and gives you a PDF, EPUB and Word file at the end. You can watch every step, pause or cancel any time.'),
    h('div', { class: 'consent-box', role: 'note' }, h('strong', null, '✋ Your consent for this run: '),
      'pressing Start lets the AI reviewer approve the drafts it checks and passes — for this one new book, in this run only. Drafts it does not pass are fixed by the AI (up to twice) or wait for your decision. Your other books are never touched. A backup is made first.'),
    h('details', { class: 'mb-quick', open: true }, h('summary', null, 'Quick settings (all optional)'),
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', { for: 'mb-genre' }, 'Genre'), genre, h('datalist', { id: 'mb-genres' }, GENRES.map(g => h('option', { value: g }))), h('span', { class: 'hint' }, 'Empty = the AI chooses.')),
        h('div', { class: 'field' }, h('label', { for: 'mb-slot' }, 'Which AI'), slot, h('span', { class: 'hint' }, 'Automatic uses whichever AI is ready.'))),
      lengthBox,
      h('div', { class: 'field' }, h('label', { for: 'mb-idea' }, 'Your idea (optional)'), idea)),
    err, h('div', { class: 'form-actions' }, startAll, startSet));
  mbShell('⚡ Make a book for me', form);
  startAll.addEventListener('click', () => go(true));
  try {
    for (const { s, health } of await loadSlotChoices(false)) {
      if (['none', 'manual'].includes(s.adapter_id)) continue;
      const st = slotStage(s, health);
      slot.appendChild(h('option', { value: s.slot_id }, `${s.slot_id} · ${slotName(s)} — ${st.word}`));
    }
  } catch { /* automatic still works */ }
  async function go(auto) {
    clear(err); clearFieldProblems(form);
    const body = { author_confirms: true };
    if (!auto) {
      body.genre = genre.value.trim(); body.idea = idea.value.trim(); body.slot_id = slot.value || null;
      const l = form.querySelector('input[name="mb-len"]:checked'); body.length = l ? l.value : 'short_story';
    }
    startAll.disabled = startSet.disabled = true;
    err.appendChild(loadingState('Starting…'));
    try {
      const run = await api('POST', '/autobook', { body });
      MB.run = run; MB.view = 'progress'; renderRun(); startRunPolling(); refreshRunChip();
      announce('Make a book for me started');
    } catch (e) {
      clear(err);
      const rest = showFieldErrors(e, fields, { book: 'New book', step: 'Make a book for me' });
      if (rest.length || !(e instanceof ApiError)) err.appendChild(problemBox(toProblem(rest[0] ? new ApiError(e.status, { errors: rest }) : e, { step: 'Make a book for me' }), { retry: () => go(auto) }));
      startAll.disabled = startSet.disabled = false;
    }
  }
}
function startRunPolling() {
  stopRunPolling();
  const tick = async () => {
    if (!MB.run || !MB.dialog || !MB.dialog.open) return;
    try {
      const r = await api('GET', `/autobook/${encodeURIComponent(MB.run.id)}`);
      const was = MB.run.status;
      MB.run = r; renderRun();
      if (r.status !== was && ['done', 'paused', 'cancelled'].includes(r.status)) { refreshRunChip(); if (S.pid === r.project_id) refreshRecords().catch(() => {}); }
    } catch (e) { noteClientError(toProblem(e).code, 'Make a book progress', toProblem(e).message); }
    if (MB.run && (MB.run.alive || ['running', 'waiting', 'queued', 'pausing'].includes(MB.run.status))) MB.poll = setTimeout(tick, 1200);
  };
  MB.poll = setTimeout(tick, 600);
  MB.tick = setInterval(() => { if (MB.dialog && MB.dialog.open) updateRunClocks(); }, 1000);
}
function stopRunPolling() { clearTimeout(MB.poll); MB.poll = null; clearInterval(MB.tick); MB.tick = null; }
function updateRunClocks() {
  const r = MB.run; if (!r || !MB.dialog) return;
  const el = MB.dialog.querySelector('.mb-elapsed');
  if (el) el.textContent = fmtElapsed(sinceMs(r.started_at, r.finished_at));
  for (const s of r.steps) {
    const t = MB.dialog.querySelector(`[data-step="${s.id}"] .mb-time`);
    if (t && s.started_at) t.textContent = fmtElapsed(sinceMs(s.started_at, s.finished_at));
  }
  const w = MB.dialog.querySelector('.mb-wait-in');
  if (w && r.waiting && r.waiting.retry_at) {
    const left = Math.max(0, Math.round((Date.parse(r.waiting.retry_at) - Date.now()) / 1000));
    w.textContent = `retrying in ${left} s`;
  }
}
async function runAction(path, body, label) {
  try {
    const r = await api('POST', `/autobook/${encodeURIComponent(MB.run.id)}/${path}`, { body: body || {} });
    MB.run = r; renderRun(); startRunPolling(); refreshRunChip();
    if (label) announce(label);
  } catch (e) { const box = MB.dialog.querySelector('.mb-msg'); if (box) clear(box).appendChild(problemBox(toProblem(e, { step: 'Make a book for me' }))); }
}
function runDecision(prob) {
  const r = MB.run;
  const extra = [];
  const opts = prob.options || [];
  if (opts.includes('approve_anyway')) {
    extra.push({ label: '✔ Approve anyway', cls: 'primary', fn: async () => {
      const ok = await choiceDialog('Approve as the author?', h('div', null,
        h('p', null, 'The AI reviewer did not pass this draft. Approving it anyway is YOUR approval (it is logged as yours), and the run continues.'),
        prob.reasons && prob.reasons.length ? h('ul', null, prob.reasons.map(x => h('li', null, x))) : null), [{ id: 'yes', label: '✔ Yes, I approve it' }]);
      if (ok === 'yes') await runAction('decide', { action: 'approve_anyway', author_confirms: true }, 'Approved; continuing');
    } });
  }
  if (opts.includes('edit') && prob.record_id) {
    extra.push({ label: '✏️ Edit it myself', fn: () => { closeMakeBook(); go(link('p', r.project_id, r.branch_id || 'main', 'edit', prob.record_id)); toast('Edit and save it, then open ⚡ and press “I edited it — continue”'); } });
    extra.push({ label: '▶ I edited it — continue', fn: () => runAction('decide', { action: 'edited' }, 'Continuing') });
  }
  return extra;
}
function renderRun() {
  const r = MB.run; if (!r || !MB.dialog) return;
  const sig = JSON.stringify([r.status, r.phase, r.current, r.problem && r.problem.code, (r.waiting || {}).retry_at, r.steps.map(s => [s.state, s.message, (s.items || []).map(i => i.state)]), (r.files || []).length]);
  if (sig === MB.sig && MB.dialog.querySelector('.mb-steps')) { updateRunClocks(); return; }
  MB.sig = sig;
  const w = RUN_WORD[r.status] || ['?', r.status, 'b-muted'];
  const done = r.steps.filter(s => s.state === 'done').length;
  const head = h('div', { class: 'mb-head' },
    h('div', null, h('p', { class: 'mb-book' }, r.title ? `“${r.title}”` : 'A new book', r.settings && r.settings.length ? h('span', { class: 'muted small' }, ` · ${(LENGTH_INFO[r.settings.length] || [''])[0]}`) : null),
      h('div', { class: 'row' }, badge(w[0], w[1], w[2]), h('span', { class: 'small' }, `${done} of ${r.steps.length} steps`), h('span', { class: 'small muted' }, '⏱ ', h('span', { class: 'mb-elapsed' }, fmtElapsed(sinceMs(r.started_at, r.finished_at)))))),
    h('progress', { class: 'mb-bar', max: String(r.steps.length), value: String(done), 'aria-label': `${done} of ${r.steps.length} steps done` }));
  const phase = h('p', { class: `mb-phase ${r.status}`, 'aria-live': 'polite' },
    ['running', 'queued'].includes(r.status) ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null, ' ',
    r.waiting ? [h('strong', null, r.waiting.message.replace(/ — retrying in \d+ s$/, '')), ' — ', h('span', { class: 'mb-wait-in' }, `retrying in ${r.waiting.retry_in_s} s`)] : r.phase);
  const ol = h('ol', { class: 'mb-steps', 'aria-label': 'Steps of this run' });
  for (const s of r.steps) {
    const icon = (s.state === 'running' && r.status === 'waiting') ? '⏳' : (STEP_ICON[s.state] || '○');
    const li = h('li', { class: `mb-step st-${s.state}${s.id === r.current && !['done', 'cancelled'].includes(r.status) ? ' current' : ''}`, 'data-step': s.id, 'aria-current': s.id === r.current && r.status !== 'done' ? 'step' : null },
      h('span', { class: 'mb-ico', 'aria-hidden': 'true' }, s.state === 'running' && r.status === 'running' ? h('span', { class: 'spinner' }) : icon),
      h('div', { class: 'mb-main' },
        h('div', { class: 'row mb-title-row' }, h('strong', null, s.title), setChip(s.set, s.op),
          h('span', { class: 'small muted mb-time' }, s.started_at ? fmtElapsed(sinceMs(s.started_at, s.finished_at)) : ''),
          s.problem ? hazard(Object.assign({}, s.problem), { retry: () => runAction('resume', {}, 'Trying again'), retryLabel: '🔁 Try again', extra: runDecision(s.problem),
            settings: ['CAPABILITY_UNAVAILABLE', 'UPSTREAM_UNAVAILABLE'].includes(s.problem.code) }) : null),
        h('p', { class: 'small mb-msg-line' }, s.message || s.about),
        (s.items || []).length ? h('ul', { class: 'mb-items' }, s.items.map(i => h('li', { class: `st-${i.state}` },
          h('span', { 'aria-hidden': 'true' }, STEP_ICON[i.state] || '○'), ' ', i.label, i.words ? h('span', { class: 'muted' }, ` · ${i.words} words`) : null))) : null));
    ol.appendChild(li);
  }
  const msg = h('div', { class: 'mb-msg', 'aria-live': 'polite' });
  if (r.problem && r.status === 'paused') {
    msg.appendChild(problemBox(r.problem, { retry: () => runAction('resume', {}, 'Trying again'), retryLabel: r.problem.code === 'REVIEW_NOT_PASSED' ? '🔁 Try again (2 more AI fixes)' : '🔁 Try again',
      extra: runDecision(r.problem), settings: ['CAPABILITY_UNAVAILABLE', 'UPSTREAM_UNAVAILABLE'].includes(r.problem.code) },
    `${r.problem.where ? r.problem.where.step : 'A step'} needs you`));
    if (r.problem.code === 'REVIEW_NOT_PASSED' && r.problem.reasons && r.problem.reasons.length) {
      msg.appendChild(h('div', { class: 'small rv-why' }, h('strong', null, 'What the AI reviewer said: '), h('ul', null, r.problem.reasons.map(x => h('li', null, x)))));
    }
  } else if (r.status === 'interrupted') {
    msg.appendChild(problemBox({ code: 'INTERRUPTED', message: r.phase }, { retry: () => runAction('resume', {}, 'Resumed'), retryLabel: '▶ Resume' }));
  }
  const ctl = h('div', { class: 'form-actions mb-controls' });
  if (['running', 'waiting', 'queued'].includes(r.status)) ctl.appendChild(h('button', { type: 'button', class: 'big', 'data-testid': 'mb-pause', onclick: () => runAction('pause', {}, 'Pausing') }, '⏸ Pause'));
  if (['paused', 'interrupted'].includes(r.status) || (r.status === 'pausing' && !r.alive)) ctl.appendChild(h('button', { type: 'button', class: 'primary big', 'data-testid': 'mb-resume', onclick: () => runAction('resume', {}, 'Resumed') }, '▶ Resume'));
  if (!['done', 'cancelled'].includes(r.status)) {
    ctl.appendChild(h('button', { type: 'button', class: 'danger', 'data-testid': 'mb-cancel', onclick: async () => {
      const ok = await choiceDialog('Cancel this run?', 'The book made so far stays in Your books (you can finish it by hand in Make my book). This cannot be resumed.', [{ id: 'yes', label: '✖ Yes, cancel it' }]);
      if (ok === 'yes') runAction('cancel', {}, 'Cancelled');
    } }, '✖ Cancel'));
  }
  if (['done', 'cancelled'].includes(r.status)) ctl.appendChild(h('button', { type: 'button', onclick: () => { MB.run = null; MB.view = 'setup'; stopRunPolling(); renderMakeSetup(); } }, '⚡ Make another book'));
  let doneBox = null;
  if (r.status === 'done') {
    doneBox = h('section', { class: 'mb-done state ok' }, h('h3', null, '🎉 Your book is made'),
      h('p', null, 'Every step is done: written, reviewed, put together and checked.'),
      r.problem && r.problem.severity === 'warning'
        ? h('p', { class: 'words-warn', role: 'note' }, h('span', { 'aria-hidden': 'true' }, '⚠️ '), r.problem.message, r.problem.fix ? h('span', { class: 'small' }, ` ${r.problem.fix}`) : null) : null,
      h('div', { class: 'downloads' }, h('strong', null, '⬇ Download: '), (r.files || []).map(f => h('button', { type: 'button', class: 'primary', 'data-format': f.format, onclick: () => downloadFile(r.project_id, r.branch_id || 'main', f, r.title) }, `${f.format}`))),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: link('p', r.project_id, r.branch_id || 'main', 'book'), onclick: () => closeMakeBook() }, '📘 Open the book'),
        h('a', { class: 'btn', href: link('p', r.project_id, r.branch_id || 'main', 'journal'), onclick: () => closeMakeBook() }, '📜 Book journal'),
        h('a', { class: 'btn', href: '#/shelf', onclick: () => closeMakeBook() }, '📚 My finished books')));
  }
  const consent = h('p', { class: 'small muted mb-consent' }, `Approvals in this run are made by the AI reviewer under your consent (run ${r.id}, ${fmtTime(r.consent && r.consent.at)}). Every one is in the book journal.`);
  mbShell('⚡ Make a book for me', head, phase, doneBox, msg, ol, ctl, consent,
    r.project_id && r.status !== 'done' ? h('p', { class: 'small' }, h('a', { href: link('p', r.project_id, r.branch_id || 'main', 'book'), onclick: () => closeMakeBook() }, 'Open the book being made')) : null);
  updateRunClocks();
}

/* ======================================================================= ✍ Write all chapters (S2) */
const WA = { job: null, poll: null };
function writeAllBox(book, redraw) {
  const box = h('div', { class: 'wa-box', 'aria-live': 'polite' });
  const draw = () => {
    const j = WA.job;
    clear(box);
    if (!j || j.project_id !== S.pid) return;
    const running = j.alive || j.status === 'running';
    put(box, h('div', { class: 'row space' }, h('strong', null, running ? '✍ Writing all chapters…' : j.status === 'done' ? '✍ All chapters are written' : j.status === 'error' ? '✍ Writing stopped' : '✍ Write all chapters: stopped'),
      h('span', { class: 'small muted' }, `${j.done} of ${j.total} · ${fmtElapsed(j.elapsed_ms)}`)),
    h('progress', { max: String(j.total || 1), value: String(j.done || 0), 'aria-label': `${j.done} of ${j.total} chapters written` }),
    j.waiting ? h('p', { class: 'small' }, '⏳ ', j.waiting.message) : h('p', { class: 'small muted' }, j.phase || ''),
    h('ul', { class: 'mb-items' }, j.items.map(i => h('li', { class: `st-${i.state}` }, h('span', { 'aria-hidden': 'true' }, STEP_ICON[i.state] || '○'), ' ', i.label,
      i.words ? h('span', { class: 'muted' }, ` · ${i.words} words`) : null, i.note ? h('span', { class: 'muted small' }, ` — ${i.note}`) : null,
      i.state === 'failed' && j.problem ? [' ', hazard(Object.assign({}, j.problem, { where: Object.assign({ book: profileOf().title || S.project.name }, j.problem.where || {}) }), { retry: () => waAct('resume') })] : null))),
    j.status === 'error' && j.problem ? problemBox(j.problem, { retry: () => waAct('resume') }) : null,
    h('div', { class: 'row' }, running ? h('button', { type: 'button', class: 'small danger', onclick: () => waAct('cancel') }, '✖ Stop after this chapter') : null,
      j.status === 'done' ? h('a', { class: 'btn small primary', href: plink('review') }, '📝 Read and approve them') : null));
  };
  const poll = async () => {
    clearTimeout(WA.poll);
    if (!WA.job) return;
    try { WA.job = await api('GET', bpath(`/book/write-all/${encodeURIComponent(WA.job.id)}`)); } catch (e) { noteClientError(toProblem(e).code, 'Write all chapters', toProblem(e).message); }
    if (!document.contains(box)) return;
    draw();
    if (WA.job.alive || WA.job.status === 'running') WA.poll = setTimeout(poll, 1500);
    else { try { await refreshRecords(); } catch { /* ignore */ } redraw(); }
  };
  const waAct = async what => {
    try { WA.job = await api('POST', bpath(`/book/write-all/${encodeURIComponent(WA.job.id)}/${what}`)); draw(); poll(); }
    catch (e) { box.appendChild(problemBox(toProblem(e, { step: 'Write all chapters', set: 'C', op: 'C02' }))); }
  };
  box.start = async () => {
    try { WA.job = await api('POST', bpath('/book/write-all')); draw(); poll(); }
    catch (e) { clear(box).appendChild(problemBox(toProblem(e, { book: profileOf().title || S.project.name, set: 'C', step: 'Write all chapters', op: 'C02' }), { settings: true })); }
  };
  (async () => {
    if (!WA.job || WA.job.project_id !== S.pid) {
      try { const out = await api('GET', bpath('/book/write-all')); WA.job = out.job; } catch { WA.job = null; }
    }
    if (WA.job && WA.job.project_id === S.pid && (WA.job.alive || ['running', 'error'].includes(WA.job.status))) { draw(); if (WA.job.alive) poll(); }
  })();
  return box;
}

/* ======================================================================= ❤️ health (R12) + background work (S11) */
const HL = { last: null, open: false };
function initHealth() {
  const btn = $('#health-btn');
  if (!btn) return;
  btn.addEventListener('click', ev => openHealth(ev.currentTarget));
  const d = $('#health-dialog');
  d.addEventListener('cancel', ev => { ev.preventDefault(); if (!HZ) closeHealth(); });
  setTimeout(() => refreshHealth(false), 1500);
  setInterval(() => { if (document.visibilityState === 'visible' && !S.authFailed) refreshHealth(false); }, 60000);
}
async function refreshHealth(force) {
  if (!S.token || S.authFailed) return HL.last;
  try { HL.last = await api('GET', `/health${force ? '?force=1' : ''}`); }
  catch (e) {
    const p = toProblem(e);
    HL.last = { overall: 'problem', checked_at: new Date().toISOString(), checks: [{ id: 'server', title: 'The BookForge program', status: 'problem', code: p.code, detail: p.what, fix: p.fix }] };
  }
  updateHealthBtn();
  if (HL.open) renderHealth();
  return HL.last;
}
function updateHealthBtn() {
  const btn = $('#health-btn'); if (!btn || !HL.last) return;
  const o = HL.last.overall;
  btn.dataset.state = o;
  const n = (HL.last.checks || []).filter(c => ['warn', 'problem'].includes(c.status)).length;
  btn.querySelector('.hb-ico').textContent = o === 'ok' ? '❤️' : o === 'warn' ? '💛' : '⚠️';
  btn.setAttribute('aria-label', o === 'ok' ? 'Health: everything is fine. Open the health panel' : `Health: ${n} thing(s) need attention. Open the health panel`);
  btn.title = o === 'ok' ? 'Health: everything is fine' : `Health: ${n} thing(s) need attention`;
}
function openHealth(opener) {
  HL.opener = opener; HL.open = true;
  const d = $('#health-dialog');
  if (!d.open) { try { d.showModal(); } catch { d.setAttribute('open', ''); } }
  renderHealth(); refreshHealth(true); loadJobs();
}
function closeHealth() {
  HL.open = false;
  const d = $('#health-dialog'); try { if (d.open) d.close(); } catch { /* ignore */ }
  if (HL.opener && HL.opener.focus) { try { HL.opener.focus(); } catch { /* ignore */ } }
}
function healthAction(c) {
  if (c.action === 'settings') return { settings: true };
  if (c.action === 'backup') return { retry: async () => { await api('POST', '/backups'); toast('Backup saved'); await refreshHealth(true); }, retryLabel: '💾 Back up now' };
  if (c.action === 'book' && c.project_id) return { open: link('p', c.project_id, 'main', 'book'), openLabel: '📘 Open the book' };
  if (c.action === 'jobs') return { extra: [{ label: '⬇ Show background work', fn: () => { const el = document.getElementById('jobs-h'); if (el) el.scrollIntoView({ block: 'start' }); } }] };
  return { retry: () => refreshHealth(true), retryLabel: '🔁 Check again' };
}
function renderHealth() {
  const d = $('#health-dialog'); const res = HL.last;
  const jobsBox = d.querySelector('#jobs-box') || h('div', { id: 'jobs-box' });
  put(clear(d), h('div', { class: 'st-head' }, h('h2', { id: 'health-title' }, '❤️ Health'), h('button', { type: 'button', class: 'small', onclick: closeHealth }, '✕ Close')));
  if (!res) { d.appendChild(loadingState('Checking…')); d.appendChild(jobsBox); return; }
  const word = { ok: 'Everything looks fine.', warn: 'Mostly fine — something needs a look.', problem: 'Something needs fixing.' }[res.overall] || '';
  put(d, h('p', { class: `hl-sum hl-${res.overall}` }, h('strong', null, word), h('span', { class: 'small muted' }, ` Checked ${fmtTime(res.checked_at)}. BookForge checks again every minute while this page is open.`)),
    h('ul', { class: 'hl-list' }, (res.checks || []).map(c => h('li', { class: `hl-row hl-${c.status}`, 'data-check': c.id },
      h('span', { class: 'hl-ico', 'aria-hidden': 'true' }, { ok: '✔', info: 'ℹ', warn: '⚠️', problem: '⚠️' }[c.status] || '•'),
      h('div', { class: 'hl-main' }, h('div', { class: 'row' }, h('strong', null, c.title),
        ['warn', 'problem'].includes(c.status) ? hazard({ code: c.code || (c.status === 'problem' ? 'FAILED' : 'BLOCKED'), message: c.detail, fix: c.fix, where: { step: `Health › ${c.title}` } }, healthAction(c)) : null),
      h('p', { class: 'small' }, c.detail), c.fix ? h('p', { class: 'small' }, h('strong', null, 'How to fix it: '), c.fix) : null)))),
    h('div', { class: 'row form-actions' }, h('button', { type: 'button', class: 'primary', onclick: () => refreshHealth(true) }, '🔁 Run checks now'),
      h('button', { type: 'button', 'data-testid': 'copy-diag', onclick: () => copyDiagnostics() }, '📋 Copy diagnostics'),
      h('button', { type: 'button', onclick: () => copyDiagnostics({ download: true }) }, '⬇ Download diagnostics')),
    h('p', { class: 'small muted' }, 'Diagnostics never contain your keys, prompts or book text — safe to send when asking for help.'),
    jobsBox);
}
const JOB_KIND = { autobook: '⚡ Make a book for me', write_all: '✍ Write all chapters', assist: '✨ Fill with AI', review_review: '🧐 AI review', review_fix: '🛠 AI fix', bible: '📖 Bible Builder' };
async function loadJobs() {
  const box = document.getElementById('jobs-box') || h('div', { id: 'jobs-box' });
  let out;
  try { out = await api('GET', '/jobs'); } catch (e) { clear(box).appendChild(problemBox(toProblem(e, { step: 'Background work' }), { retry: loadJobs })); return; }
  const items = out.jobs.slice(0, 15);
  put(clear(box), h('h3', { id: 'jobs-h' }, '🧵 Background work'),
    items.length ? h('ul', { class: 'hl-list' }, items.map(j => h('li', { class: `hl-row hl-${['interrupted', 'error'].includes(j.status) ? 'warn' : j.status === 'done' ? 'ok' : 'info'}` },
      h('span', { class: 'hl-ico', 'aria-hidden': 'true' }, ['interrupted', 'error', 'paused'].includes(j.status) ? '⚠️' : j.status === 'done' ? '✔' : '⏳'),
      h('div', { class: 'hl-main' }, h('div', { class: 'row' }, h('strong', null, JOB_KIND[j.kind] || j.kind), badge('•', j.status, j.status === 'done' ? 'b-ok' : ['interrupted', 'error', 'paused'].includes(j.status) ? 'b-warn' : 'b-info'),
        j.op ? setChip(j.op[0], j.op) : null, j.steps_total ? h('span', { class: 'small muted' }, `${j.steps_done}/${j.steps_total} steps`) : null,
        j.total ? h('span', { class: 'small muted' }, `${j.done}/${j.total}`) : null),
      h('p', { class: 'small' }, j.phase || ''),
      h('div', { class: 'row' },
        j.kind === 'autobook' ? h('button', { type: 'button', class: 'small', onclick: () => { closeHealth(); openMakeBook(null, { runId: j.id }); } }, 'Open') : null,
        j.resumable ? h('button', { type: 'button', class: 'small primary', onclick: async ev => {
          ev.currentTarget.disabled = true;
          try { const r = await api('POST', `/jobs/${encodeURIComponent(j.id)}/resume`); toast(`${JOB_KIND[j.kind] || 'Job'} resumed`); if (j.kind === 'autobook') { closeHealth(); openMakeBook(null, { runId: j.id }); } else loadJobs(); return r; }
          catch (e) { showGlobalProblem(toProblem(e, { step: 'Resume background work' })); ev.currentTarget.disabled = false; }
        } }, '▶ Resume') : null,
        ['interrupted', 'error', 'cancelled', 'done', 'paused'].includes(j.status) && j.kind !== 'autobook' ? h('button', { type: 'button', class: 'small', onclick: async () => { try { await api('POST', `/jobs/${encodeURIComponent(j.id)}/dismiss`); loadJobs(); } catch (e) { showGlobalProblem(e); } } }, 'Dismiss') : null))))) :
      h('p', { class: 'small muted' }, 'No background work yet.'));
}

/* ======================================================================= 📜 book journal (R11) */
const JR_ICON = { ai: '🤖', ai_review: '🧐', ai_fix: '🛠', approval: '✅', problem: '⚠️', retry: '⏳', pause: '⏸', resume: '▶', backup: '💾', export: '📦', run: '⚡', step: '•', setting: '⚙️', import: '📥', cancel: '✖', note: 'ℹ' };
const APPROVAL_LABEL = { author: 'by you', standing_auto_approve: 'auto-approve (your setting)', run_consent: 'Make-a-book consent', workflow_test: 'workflow test' };
async function viewJournal(main) {
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  main.appendChild(h('div', { class: 'page-head' }, h('div', null, crumbs(['Your books', '#/'], [S.project.name, plink()], 'Book journal'), h('h1', null, '📜 Book journal')),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: plink('book') }, '📘 Make my book'))));
  main.appendChild(h('p', { class: 'muted' }, 'Everything that happened to this book, in order: who did what, which AI, approvals and their kind, retries, pauses, problems and exports. It never shows keys, prompts or your text.'));
  const step = h('select', { id: 'jr-step' }, h('option', { value: '' }, 'All steps'), Object.keys(SETS).map(l => h('option', { value: l }, `Set ${l} · ${setInfo(l).name}`)));
  const probs = h('input', { type: 'checkbox', id: 'jr-probs' });
  const list = h('div', null, loadingState('Reading the journal…'));
  const dl = h('button', { type: 'button', onclick: async () => {
    try {
      const qs = new URLSearchParams({ format: 'md', download: '1' }); if (step.value) qs.set('step', step.value); if (probs.checked) qs.set('problems', '1');
      const blob = await api('GET', bpath(`/journal?${qs}`), { blob: true });
      const url = URL.createObjectURL(blob); const a = h('a', { href: url, download: `book-journal-${safeFileStem(profileOf().title || S.project.name) || 'book'}.md` });
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); toast('Journal downloaded');
    } catch (e) { showGlobalProblem(toProblem(e, { step: 'Book journal' })); }
  } }, '⬇ Download (.md)');
  main.appendChild(h('div', { class: 'card row jr-filters' }, h('label', { for: 'jr-step' }, 'Show'), step, h('span', { class: 'check-row' }, probs, h('label', { for: 'jr-probs' }, '⚠️ Problems only')), dl));
  main.appendChild(list);
  const load = async () => {
    clear(list).appendChild(loadingState('Reading the journal…'));
    const qs = new URLSearchParams(); if (step.value) qs.set('step', step.value); if (probs.checked) qs.set('problems', '1');
    let j;
    try { j = await api('GET', bpath(`/journal?${qs}`)); } catch (e) { clear(list).appendChild(problemBox(toProblem(e, { book: S.project.name, step: 'Book journal' }), { retry: load })); return; }
    clear(list);
    if (!j.entries.length) { list.appendChild(stateBox('empty', probs.checked ? 'No problems recorded — good news.' : 'Nothing recorded yet for this filter.')); return; }
    const ol = h('ol', { class: 'journal' });
    for (const e of j.entries.slice().reverse()) {
      const st = e.step || {};
      ol.appendChild(h('li', { class: `jr-item jr-${e.kind}${e.problem ? ' has-problem' : ''}` },
        h('span', { class: 'jr-ico', 'aria-hidden': 'true' }, JR_ICON[e.kind] || '•'),
        h('div', { class: 'jr-main' }, h('div', { class: 'row' }, h('span', null, e.what),
          e.problem ? hazard({ code: e.problem.code || 'FAILED', message: e.problem.message || e.what, where: { book: j.title, set: st.set, step: st.name, op: st.op } }, { open: st.op ? plink('op', st.op) : null, openLabel: 'Open the step' }, { small: true }) : null),
        h('div', { class: 'row small muted' }, h('time', { datetime: e.at }, fmtTime(e.at)), setChip(st.set, st.op), h('span', null, e.who || ''),
          e.ai && e.ai.slot ? h('span', null, `AI ${e.ai.slot}${e.ai.model ? ` · ${e.ai.model}` : ''}`) : null,
          e.approval ? badge('✔', APPROVAL_LABEL[e.approval] || e.approval, 'b-ok') : null,
          e.outcome && !['SUCCESS'].includes(e.outcome) && !e.approval ? badge('•', e.outcome, /APPROVE|done/.test(e.outcome) ? 'b-ok' : /REVISE|REJECT|PROBLEM|REJECTED|error/.test(e.outcome) ? 'b-warn' : 'b-muted') : null))));
    }
    put(list, h('p', { class: 'small muted' }, `${j.count} entr${j.count === 1 ? 'y' : 'ies'}, newest first.`), ol);
  };
  step.addEventListener('change', load); probs.addEventListener('change', load);
  if (q.get('problems') === '1') probs.checked = true;
  await load();
}

/* ======================================================================= 📚 my finished books (S22) */
async function viewShelf(main) {
  main.appendChild(h('div', { class: 'page-head' }, h('div', null, crumbs(['Your books', '#/'], 'My finished books'), h('h1', null, '📚 My finished books')),
    h('button', { type: 'button', class: 'primary', onclick: ev => openMakeBook(ev.currentTarget) }, '⚡ Make a book for me')));
  main.appendChild(h('p', { class: 'muted' }, 'Every book you exported, newest first. Each file is checked against its fingerprint before you download it.'));
  const holder = h('div', null, loadingState('Checking your finished books…'));
  main.appendChild(holder);
  let out;
  try { out = await api('GET', '/shelf'); } catch (e) { clear(holder).appendChild(problemBox(toProblem(e, { step: 'My finished books' }), { retry: () => route() })); return; }
  clear(holder);
  if (!out.books.length) {
    holder.appendChild(stateBox('empty', 'No finished book yet', h('p', null, 'Export a book from 📘 Make my book, or press ⚡ Make a book for me and let the AI make one.')));
    return;
  }
  const grid = h('ul', { class: 'shelf' });
  for (const b of out.books) {
    grid.appendChild(h('li', { class: `shelf-book${b.all_verified ? '' : ' damaged'}` },
      h('div', { class: 'sb-cover', 'aria-hidden': 'true' }, h('span', null, (b.title || '?').slice(0, 1))),
      h('div', { class: 'sb-main' }, h('h2', null, b.title), h('p', { class: 'small muted' }, [b.author, b.genre].filter(Boolean).join(' · ') || ' '),
        h('p', { class: 'small' }, `Exported ${fmtTime(b.exported_at)}`, b.made_by_run ? h('span', { class: 'muted' }, ' · made with ⚡') : null),
        h('div', { class: 'downloads' }, b.files.map(f => f.verified
          ? h('button', { type: 'button', class: 'primary small', 'data-format': f.format, onclick: () => downloadFile(b.project_id, b.branch_id, f, b.title) }, `⬇ ${f.format}`, h('span', { class: 'sr-ok', title: 'Fingerprint checked' }, ' ✔'))
          : h('span', { class: 'row' }, h('button', { type: 'button', class: 'small', disabled: true }, f.format), hazard({ code: 'HASH_MISMATCH', message: `The ${f.format} file is missing or changed.`, where: { book: b.title, set: 'G', step: 'Export my book', op: f.op } }, { open: link('p', b.project_id, b.branch_id, 'book'), openLabel: '📘 Export again' }, { small: true })))),
        h('a', { class: 'small', href: link('p', b.project_id, b.branch_id, 'book') }, 'Open the book'))));
  }
  holder.appendChild(grid);
}

/* ======================================================================= Settings: backups (S9), AI retry (S10), diagnostics (S8) */
function backupsCard() {
  const box = h('div', { 'aria-live': 'polite' });
  const card = h('section', { class: 'card', 'aria-labelledby': 'bk-h' }, h('h2', { id: 'bk-h' }, '💾 Backups'),
    h('p', { class: 'small' }, 'BookForge backs up all your books automatically: once a day, before ⚡ Make a book for me, before putting a book together and before exporting. Only the newest ones are kept. Keys are never part of a backup.'), box);
  const load = async () => {
    let out;
    try { out = await api('GET', '/backups'); } catch (e) { clear(box).appendChild(problemBox(toProblem(e, { step: 'Settings › Backups' }), { retry: load })); return; }
    const keep = h('input', { type: 'number', id: 'bk-keep', min: '1', max: '100', value: String(out.keep), class: 'wz-num' });
    const now = h('button', { type: 'button', class: 'primary', onclick: async ev => {
      ev.currentTarget.disabled = true;
      try { await api('POST', '/backups'); toast('Backup saved and verified'); load(); refreshHealth(true); } catch (e) { box.prepend(problemBox(toProblem(e, { step: 'Settings › Backups' }))); ev.currentTarget.disabled = false; }
    } }, '💾 Back up now');
    const saveKeep = h('button', { type: 'button', class: 'small', onclick: async () => {
      clearFieldProblems(card);
      try { await api('PUT', '/backups/settings', { body: { keep: parseInt(keep.value, 10) } }); toast('Saved'); load(); }
      catch (e) { showFieldErrors(e, { keep }, { step: 'Settings › Backups' }); }
    } }, 'Save');
    put(clear(box), h('div', { class: 'row' }, now, h('div', { class: 'field row bk-keep' }, h('label', { for: 'bk-keep' }, 'Keep the newest'), keep, saveKeep)),
      out.last_error ? problemBox({ code: 'INTERNAL_ERROR', message: 'The last automatic backup failed.', fix: 'Press 💾 Back up now; if it fails, check the free disk space.' }) : null,
      out.backups.length ? h('ul', { class: 'record-list bk-list' }, out.backups.map(b => h('li', { class: 'record-item' },
        h('div', { class: 'r-main' }, h('span', { class: 'r-title' }, fmtTime(b.created_at)), h('div', { class: 'r-meta' }, `${b.label || b.reason || 'Backup'} · ${(b.bytes / 1024 / 1024).toFixed(1)} MB`)),
        h('div', { class: 'r-badges' }, b.verified ? badge('✔', 'Verified', 'b-ok') : hazard({ code: 'HASH_MISMATCH', message: 'This backup did not verify.', where: { step: 'Settings › Backups' } }, {}, { small: true }),
          h('button', { type: 'button', class: 'small danger', onclick: () => restoreBackup(b, load) }, '↩ Restore'))))) : stateBox('empty', 'No backup yet'));
  };
  load();
  return card;
}
function restoreBackup(b, reload) {
  modal('↩ Restore a backup', close => {
    const word = h('input', { type: 'text', id: uid('rs'), autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'rs-h' });
    const tick = h('input', { type: 'checkbox', id: uid('rs-ok') });
    const out = h('div', { 'aria-live': 'polite' });
    const go2 = h('button', { type: 'submit', class: 'danger' }, '↩ Restore this backup');
    return h('form', { novalidate: true, onsubmit: async ev => {
      ev.preventDefault(); clear(out); clearFieldProblems(ev.currentTarget);
      if (!tick.checked) { markFieldProblem(tick, { code: 'APPROVAL_REQUIRED', message: 'Tick the box to confirm.' }, { step: 'Restore a backup' }); return; }
      if (word.value.trim().toUpperCase() !== 'RESTORE') { markFieldProblem(word, { code: 'MISSING_INPUT', message: 'Type the word RESTORE.' }, { step: 'Restore a backup', field: 'Type RESTORE' }); word.focus(); return; }
      go2.disabled = true; out.appendChild(loadingState('Restoring… (a safety backup is made first)'));
      try {
        const r = await api('POST', `/backups/${encodeURIComponent(b.name)}/restore`, { body: { author_confirms: true, confirm: word.value.trim() } });
        close(); toast(r.message); S.project = null; await loadProjects(); reload(); route();
      } catch (e) { clear(out).appendChild(problemBox(toProblem(e, { step: 'Restore a backup' }))); go2.disabled = false; }
    } },
    h('div', { class: 'state blocked' }, h('h3', null, '⚠️ This replaces ALL your books'), h('p', null, `Every book goes back to how it was on ${fmtTime(b.created_at)}. Work done after that is replaced. BookForge first saves a safety backup of how things are now, so you can undo this by restoring that safety backup.`)),
    h('div', { class: 'check-row field' }, tick, h('label', { for: tick.id }, 'I understand that all my books go back to this backup.')),
    h('div', { class: 'field' }, h('label', { for: word.id }, 'Type RESTORE to confirm'), word, h('span', { class: 'hint', id: 'rs-h' }, 'This extra step prevents accidents.')),
    out, h('div', { class: 'form-actions' }, go2, h('button', { type: 'button', onclick: close }, 'Cancel')));
  });
}
function retryCard() {
  const box = h('div');
  const card = h('section', { class: 'card', 'aria-labelledby': 'rt-h' }, h('h2', { id: 'rt-h' }, '⏳ When the AI is busy'),
    h('p', { class: 'small' }, 'If the AI is busy or cannot be reached, BookForge waits and tries again on its own, and shows “waiting for Claude (busy) — retrying in 30 s”. A slow answer (time-out) is never retried automatically, because the first answer may still arrive; you press 🔁 Try again.'), box);
  (async () => {
    let cur;
    try { cur = await api('GET', '/settings/ai-retry'); } catch (e) { box.appendChild(problemBox(toProblem(e, { step: 'Settings › When the AI is busy' }))); return; }
    const on = h('input', { type: 'checkbox', id: 'rt-on', checked: cur.enabled });
    const delays = h('input', { type: 'text', id: 'rt-delays', value: cur.delays_s.join(', '), 'aria-describedby': 'rt-d-h' });
    const total = h('input', { type: 'number', id: 'rt-total', min: '10', max: '3600', value: String(cur.max_total_s), class: 'wz-num' });
    const save = h('button', { type: 'button', class: 'small primary', onclick: async () => {
      clearFieldProblems(card);
      const ds = delays.value.split(/[,\s]+/).filter(Boolean).map(x => parseInt(x, 10));
      if (ds.some(x => !Number.isFinite(x))) { markFieldProblem(delays, { code: 'INVALID_INPUT', message: 'Whole numbers of seconds, separated by commas.' }, { step: 'Settings › When the AI is busy', field: 'Waiting times' }); return; }
      try { await api('PUT', '/settings/ai-retry', { body: { enabled: on.checked, delays_s: ds, max_total_s: parseInt(total.value, 10) } }); toast('Saved'); }
      catch (e) { const rest = showFieldErrors(e, { delays_s: delays, max_total_s: total, enabled: on }, { step: 'Settings › When the AI is busy' }); if (rest.length) box.appendChild(problemBox(e)); }
    } }, 'Save');
    put(box, h('div', { class: 'check-row field' }, on, h('label', { for: 'rt-on' }, 'Wait and retry when the AI is busy')),
      h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', { for: 'rt-delays' }, 'Waiting times (seconds)'), delays, h('span', { class: 'hint', id: 'rt-d-h' }, 'For example 15, 30, 60, 120 — the last one repeats.')),
        h('div', { class: 'field' }, h('label', { for: 'rt-total' }, 'Give up after (seconds)'), total)), h('div', { class: 'row' }, save));
  })();
  return card;
}
function helpCard() {
  return h('section', { class: 'card', 'aria-labelledby': 'hp-h' }, h('h2', { id: 'hp-h' }, '🩺 Help and diagnostics'),
    h('p', { class: 'small' }, 'When something does not work, 📋 Copy diagnostics and paste it into your message. It contains versions, health results, recent error codes and job states — never your keys, prompts or book text.'),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => copyDiagnostics() }, '📋 Copy diagnostics'),
      h('button', { type: 'button', onclick: () => copyDiagnostics({ download: true }) }, '⬇ Download diagnostics'),
      h('button', { type: 'button', onclick: ev => openHealth(ev.currentTarget) }, '❤️ Open the health panel')));
}
/** Book-path step rail: the whole flow at a glance (done / needs you / AI can / working / waiting / problem). */
function stepRail(items, { label = 'Progress', current = null } = {}) {
  return h('ol', { class: 'step-rail', 'aria-label': label }, items.map((it, i) => h('li', { class: `rail-${it.state}${it.id === current ? ' here' : ''}`, 'aria-current': it.id === current ? 'step' : null },
    h('a', { href: it.href || `#rail-${it.id}`, onclick: it.href ? null : ev => { ev.preventDefault(); const t = document.getElementById(`step-${it.id}`); if (t) { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.focus({ preventScroll: true }); } } },
      h('span', { class: 'rail-dot', 'aria-hidden': 'true' }, it.state === 'done' ? '✔' : it.state === 'problem' ? '!' : String(i + 1)),
      h('span', { class: 'rail-lab' }, it.title, h('span', { class: 'visually-hidden' }, ` — ${it.word || it.state}${it.id === current ? ' (you are here)' : ''}`))))));
}

/* ======================================================================= boot */
/** Focus target after a dialog closes: items inside a closed top-bar menu fall back to the menu button. */
function visibleOpener(el) {
  const pop = el && el.closest && el.closest('.tb-pop');
  if (pop) { const btn = pop.parentElement && pop.parentElement.querySelector('.tb-btn'); if (btn) return btn; }
  return el;
}
function initNavigation() {
  configureClipboard({ toast });
  popMenu($('#sets-btn'), $('#sets-pop'), renderSetsPop);
  popMenu($('#more-btn'), $('#more-pop'));
  $('#jump-btn').addEventListener('click', ev => openJump(ev.currentTarget));
  const sd = $('#set-dialog');
  sd.addEventListener('cancel', ev => { ev.preventDefault(); closeSetPanel(); });
  sd.addEventListener('click', ev => { if (ev.target === sd) closeSetPanel(); });  // backdrop click
  const md = $('#make-dialog');
  md.addEventListener('cancel', ev => { ev.preventDefault(); if (!ev.target.closest || !ev.target.closest('.info-wrap')) closeMake(); });
  const jd = $('#jump-dialog');
  jd.addEventListener('cancel', ev => { ev.preventDefault(); closeJump(true); });
  jd.addEventListener('click', ev => { if (ev.target === jd) closeJump(true); });
  document.addEventListener('keydown', ev => {
    if (S.authFailed) return;
    const typing = ev.target && (ev.target.closest && ev.target.closest('input, textarea, select, [contenteditable="true"]'));
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'k' || ev.key === 'K')) { ev.preventDefault(); openJump(document.activeElement); return; }
    if (ev.key === '/' && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !document.querySelector('dialog[open]')) { ev.preventDefault(); openJump(document.activeElement); }
  });
  // Safety net: any promise nobody handled becomes a friendly message instead of a silent failure.
  window.addEventListener('unhandledrejection', ev => {
    ev.preventDefault();
    const r = ev.reason;
    if (r && r.name === 'AbortError') return;
    if (r instanceof ApiError && r.status === 401) return;  // the "open from the start link" page explains it
    showGlobalProblem(r);
    try { console.warn('Bookforge: unhandled problem', r); } catch { /* ignore */ }
  });
  window.addEventListener('error', ev => {
    if (!ev || (!ev.error && !ev.message)) return;
    showGlobalProblem({ code: 'BROWSER', message: (ev.error && ev.error.message) || ev.message });
  });
}

function boot() {
  consumePairFragment();
  initToken();
  initSelfTestButton();
  initWorkflowDrawer();
  initTaskTimer();
  initBibleButton();
  initNavigation();
  initMakeBook();
  initHealth();
  const toggle = $('#nav-toggle');
  toggle.addEventListener('click', () => {
    const nav = $('#sidenav'); const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open); toggle.setAttribute('aria-expanded', String(open));
    if (open) { const f = nav.querySelector('a, button'); if (f) f.focus(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('#sidenav').classList.contains('open')) { closeNav(); toggle.focus(); }
  });
  if (!S.token) {
    showAuthProblem(S.pairing
      ? 'To finish connecting AutoInjector, BookForge needs to be opened from its start link once on this computer. Open BookForge from its window or desktop shortcut, then press Connect in AutoInjector again.'
      : 'No access token was found in the address.');
    return;
  }
  window.addEventListener('hashchange', route);
  (async () => {
    try {
      await api('GET', '/session');
      await loadProjects();
    } catch (e) {
      if (S.authFailed) return;
    }
    if (!location.hash || location.hash === '#' || location.hash === '#/') {
      const last = loadJSON('bf:last', null);
      if (last && S.projects.some(p => p.project_id === last.pid)) { location.replace(link('p', last.pid, last.branch || 'main')); return; }
    }
    route();
  })();
}
boot();
