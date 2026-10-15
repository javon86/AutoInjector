// Bookforge browser workspace. Vanilla ES module, no network access beyond this local server.
// All data is rendered with DOM APIs (never innerHTML with server data).

/* ======================================================================= constants */
const SETS = {
  A: ['Universe', 'Foundational canon: characters, worlds, cultures, systems and their facts.'],
  B: ['Planning', 'Premise, plot, structure, outlines and scene plans.'],
  C: ['Writing', 'Canonical manuscript prose: chapters, scenes and passages.'],
  D: ['Art', 'Visual style, character references, illustrations, covers and maps.'],
  E: ['State', 'Accepted story events and temporal state tracking.'],
  F: ['Editing', 'Editing proposals and review evidence that feed prose changes back to Writing.'],
  G: ['Assembly/Export', 'Compiling, layout, typography and PDF/EPUB/DOCX exports.'],
  H: ['Quality', 'Quality-control reports and readiness checks.'],
  I: ['Storage/Context', 'Imports, schemas, provenance, approvals, locks and context packages.'],
  J: ['Reconciliation', 'Contradiction detection, repair proposals and decision records.'],
  K: ['Orchestration', 'Projects, scheduling, queue attempts, approvals and resources.'],
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
  authFailed: false,
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
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
const bpath = (rest = '') => `/projects/${encodeURIComponent(S.pid)}/branches/${encodeURIComponent(S.branch)}${rest}`;

/* ======================================================================= auth */
function initToken() {
  const m = location.hash.match(/(?:^#|[&#])token=([^&]+)/);
  if (m) {
    S.token = decodeURIComponent(m[1]);
    try { sessionStorage.setItem('bf_token', S.token); } catch { /* private mode: keep in memory */ }
    history.replaceState(null, '', location.pathname + location.search + '#/');
  } else {
    try { S.token = sessionStorage.getItem('bf_token'); } catch { S.token = null; }
  }
}
function showAuthProblem(detail) {
  S.authFailed = true;
  try { sessionStorage.removeItem('bf_token'); } catch { /* ignore */ }
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
  if (S.onRecordsChanged) { try { S.onRecordsChanged(); } catch { /* view-local refresh */ } }
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
  const seq = ++routeSeq;
  const parts = parseRoute();
  const main = $('#main');
  try {
    await loadOps();
    if (parts[0] === 'p' && parts.length >= 3) {
      await ensureProject(parts[1], parts[2]);
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
    const h1 = main.querySelector('h1');
    document.title = h1 ? `${h1.textContent} – Bookforge` : 'Bookforge';
    if (!main.contains(document.activeElement) || document.activeElement === document.body) main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

async function pickView(parts) {
  if (!parts.length) return viewHome;
  if (parts[0] === 'settings') return viewSettings;
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
  const add = (href, text) => links.appendChild(h('a', { href, 'aria-current': here === href ? 'page' : null }, text));
  add('#/', 'Projects');
  if (inProject) {
    add(link('p', S.pid, S.branch), 'Overview');
    add(link('p', S.pid, S.branch, 'progress'), 'Progress');
    add(link('p', S.pid, S.branch, 'activity'), 'Activity');
  }
  add('#/settings', 'Settings');
}

function renderNav() {
  const nav = clear($('#sidenav'));
  if (!S.project || parseRoute()[0] !== 'p') {
    nav.appendChild(h('h2', null, 'Operation sets'));
    nav.appendChild(h('p', { class: 'muted small', style: 'padding: 0 8px' },
      'Open or create a project to work in the 11 operation sets.'));
    for (const [letter, [name]] of Object.entries(SETS)) {
      nav.appendChild(h('div', { class: 'set-toggle', 'aria-disabled': 'true' },
        h('span', { class: 'set-letter' }, letter), h('span', { class: 'set-name' }, name)));
    }
    return;
  }
  const parts = parseRoute();
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
    for (const o of ops) {
      ul.appendChild(h('li', null, h('a', { href: link('p', S.pid, S.branch, 'op', o.id),
        'aria-current': curOp === o.id ? 'page' : null },
      h('span', { class: 'op-id' }, o.id), h('span', { class: 'op-name' }, o.name),
      h('span', { class: 'op-meta' }, opStateText(o.id)))));
    }
    const btn = h('button', { type: 'button', class: 'set-toggle', 'aria-expanded': String(!!open), 'aria-controls': listId,
      onclick: () => {
        const now = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', String(now)); ul.hidden = !now;
        S.navOpen[letter] = now; saveJSON('bf:navOpen', S.navOpen);
      } },
    h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸'),
    h('span', { class: 'set-letter' }, letter), h('span', { class: 'set-name' }, name),
    h('span', { class: 'set-count' }, `${total} rec`));
    nav.appendChild(h('div', { class: 'set-group' }, btn, ul));
  }
}
function closeNav() {
  const nav = $('#sidenav'); nav.classList.remove('open');
  $('#nav-toggle').setAttribute('aria-expanded', 'false');
}

/* ======================================================================= common states */
function stateBox(kind, title, ...body) {
  const icons = { empty: '○', loading: '…', blocked: '⏸︎', failed: '✕', stale: '⚠︎', ok: '✔', draft: '✎' };
  const words = { empty: 'Empty', loading: 'Loading', blocked: 'Blocked', failed: 'Failed', stale: 'Stale', ok: 'Approved', draft: 'Draft' };
  return h('section', { class: `state ${kind}`, role: kind === 'failed' ? 'alert' : null },
    h('h3', null, h('span', { 'aria-hidden': 'true' }, icons[kind] || ''),
      h('span', { class: 'visually-hidden' }, `${words[kind] || kind}: `), title), ...body);
}
function errorItems(errs) {
  return h('ul', { class: 'error-list' }, errs.map(e => h('li', null,
    h('code', null, e.code), e.path ? [' at ', h('code', null, e.path)] : '', ' — ', e.message || '')));
}
function failedState(title, e, ...extra) {
  const body = [];
  if (e instanceof ApiError && e.errors.length) body.push(errorItems(e.errors));
  else body.push(h('p', null, (e && e.message) || String(e)));
  return stateBox('failed', title, ...body, ...extra);
}
function loadingState(text) { return stateBox('loading', h('span', null, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', text)); }

/* ======================================================================= views: home */
async function viewHome(main) {
  await loadProjects();
  renderTop([]);
  main.appendChild(h('div', { class: 'page-head' }, h('h1', null, 'Projects')));
  const listCard = h('section', { class: 'card', 'aria-labelledby': 'proj-list-h' }, h('h2', { id: 'proj-list-h' }, 'Your projects'));
  if (!S.projects.length) {
    listCard.appendChild(stateBox('empty', 'No projects yet',
      h('p', null, 'Create your first project below. The only required input is a project name; features and release profiles can be changed later in the feature manifest.')));
  } else {
    const ul = h('ul', { class: 'record-list' });
    for (const p of S.projects) {
      const n = Object.values(p.record_counts || {}).reduce((a, b) => a + b, 0);
      ul.appendChild(h('li', { class: 'record-item' },
        h('div', { class: 'r-main' }, h('a', { class: 'r-title', href: link('p', p.project_id, 'main') }, p.name),
          h('div', { class: 'r-meta' }, `${p.project_id} · created ${fmtTime(p.created_at)} · branches: ${p.branches.join(', ')}`)),
        h('div', { class: 'r-badges' }, badge('▤', `${n} records on main`, 'b-muted'))));
    }
    listCard.appendChild(ul);
  }
  main.appendChild(listCard);
  main.appendChild(projectCreateForm());
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
    h('div', null, h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Projects'), ' › ', p.name),
      h('h1', null, p.name)),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: plink('manifest') }, 'Edit feature manifest'),
      h('a', { class: 'btn', href: plink('progress') }, 'Progress'))));
  main.appendChild(h('section', { class: 'card', 'aria-labelledby': 'ov-h' }, h('h2', { id: 'ov-h' }, 'Project'),
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
  if (!totals) {
    main.appendChild(stateBox('empty', 'This branch has no records yet',
      h('p', null, 'A good first step is a premise or a piece of canon:'),
      h('ul', null,
        h('li', null, h('a', { href: plink('op', 'B01') }, 'B01 Premise/Concept Builder'), ' — needs an idea and goals (an AI slot or a manual candidate writes the premise).'),
        h('li', null, h('a', { href: plink('op', 'A01') }, 'A01 Character Builder'), ' — needs only a concept.'),
        h('li', null, h('a', { href: plink('op', 'A03') }, 'A03 World/Planet Builder'), ' — needs only a concept.'))));
  }
  const sets = h('div', { class: 'op-cards' });
  for (const [letter, [name, desc]] of Object.entries(SETS)) {
    const ops = S.ops.filter(o => o.set === letter);
    const recs = S.records.filter(r => r.module_id[0] === letter);
    const withApproved = ops.filter(o => opStats(o.id).approved > 0).length;
    const stale = recs.filter(r => r.stale).length;
    sets.appendChild(h('a', { class: 'op-card', href: plink('set', letter) },
      h('h3', null, `${letter} · ${name}`), h('p', null, desc),
      h('div', { class: 'row' }, badge('▤', `${recs.length} records`, 'b-muted'),
        badge('✔', `${withApproved}/${ops.length} ops with approved`, withApproved ? 'b-ok' : 'b-muted'),
        stale ? badge('⚠︎', `${stale} stale`, 'b-warn') : null)));
  }
  main.appendChild(h('section', { 'aria-labelledby': 'sets-h' }, h('h2', { id: 'sets-h' }, 'Set workspaces'), sets));
  main.appendChild(h('div', { style: 'height:16px' }));
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
  const [name, desc] = SETS[letter];
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    h('div', { class: 'crumbs' }, h('a', { href: plink() }, S.project.name), ' › ', `Set ${letter}`),
    h('h1', null, `${letter} · ${name} workspace`), h('p', { class: 'muted' }, desc))));
  const cards = h('div', { class: 'op-cards' });
  for (const o of S.ops.filter(x => x.set === letter)) {
    const st = opStats(o.id);
    cards.appendChild(h('a', { class: 'op-card', href: plink('op', o.id) },
      h('h3', null, `${o.id} ${o.name}`),
      h('p', null, o.purpose.length > 160 ? o.purpose.slice(0, 157) + '…' : o.purpose),
      h('div', { class: 'row' }, opStateBadge(o.id), badge('▤', `${st.count} records`, 'b-muted'),
        badge(o.execution.includes('AI') || o.execution.includes('HYBRID') ? '✦' : '⚙︎', o.execution, 'b-muted'),
        isRequired(o.id) ? null : badge('–', 'not in manifest', 'b-muted'))));
  }
  main.appendChild(h('section', { 'aria-label': `${name} operations` }, cards));
}

/* ======================================================================= views: operation */
function isCreative(op) { return /AI|HYBRID/.test(op.execution); }

async function viewOperation(main, opId) {
  const op = S.opsById[opId];
  const schema = await getSchema(opId);
  const [setName] = SETS[op.set];
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    h('div', { class: 'crumbs' }, h('a', { href: plink() }, S.project.name), ' › ',
      h('a', { href: plink('set', op.set) }, `${op.set} ${setName}`), ' › ', op.id),
    h('h1', null, `${op.id} ${op.name}`)),
  h('div', { class: 'row' }, opStateBadge(opId), badge(isCreative(op) ? '✦' : '⚙︎', op.execution, 'b-muted'),
    badge('▦', op.ui_type, 'b-muted'))));

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
  S.onRecordsChanged = renderRecs;
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
  const draft = loadJSON(draftKey, null);
  const card = h('section', { class: 'card', 'aria-labelledby': 'new-h' });
  card.appendChild(h('h2', { id: 'new-h' }, `New ${op.id} record`));
  card.appendChild(h('p', { class: 'muted small' }, 'Fields marked Required must be filled. Optional fields left empty are not sent (absent means “not supplied”).'));
  if (draft) {
    card.appendChild(stateBox('draft', `Restored your unsaved draft from ${fmtTime(draft.saved_at)}`,
      h('p', null, 'Nothing has been submitted yet. ', h('button', { type: 'button', class: 'link', onclick: () => {
        if (confirm('Discard this unsaved draft? This cannot be undone.')) { removeKey(draftKey); route(); }
      } }, 'Discard draft'))));
  }
  const ctx = new FormCtx('new', schema.bindings);
  const formEl = h('form', { novalidate: true });
  const summary = h('div');
  formEl.appendChild(summary);
  const payloadNode = buildNode(schema.create_payload, draft ? draft.payload : undefined, '/payload', '', true, ctx, 0, { root: true });
  formEl.appendChild(payloadNode.el);

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
    f.errEl.hidden = false; f.errEl.appendChild(h('span', { style: 'display:block' }, msg));
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
  return { el: wrap, get: () => {
    const v = control.value;
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
  const [setName] = SETS[op.set] || [''];
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    h('div', { class: 'crumbs' }, h('a', { href: plink() }, S.project.name), ' › ',
      h('a', { href: plink('set', op.set) }, `${op.set} ${setName}`), ' › ', h('a', { href: plink('op', op.id) }, `${op.id} ${op.name}`), ' › ', rid),
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
    h('div', { class: 'crumbs' }, h('a', { href: plink() }, S.project.name), ' › ', h('a', { href: plink('op', op.id) }, `${op.id} ${op.name}`),
      ' › ', h('a', { href: plink('rec', rid) }, rid), ' › Edit'),
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
  const draft = loadJSON(draftKey, null);
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
    h('div', { class: 'crumbs' }, h('a', { href: plink() }, S.project.name), ' › Feature manifest'),
    h('h1', null, `Feature manifest — ${S.branch}`))));
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
    h('div', { class: 'crumbs' }, h('a', { href: plink() }, S.project.name), ' › Progress'),
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
    h('div', { class: 'crumbs' }, h('a', { href: plink() }, S.project.name), ' › Activity'),
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
  ST.dialog = d; ST.opener = document.activeElement; ST.view = null; ST.prog = null;
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
    clear(box).appendChild(h('div', { class: 'row' }, badge(st.icon, st.word, st.cls), h('span', null, h('strong', null, 'Where it’s at: '), st.now)));
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

/* ======================================================================= boot */
function boot() {
  initToken();
  initSelfTestButton();
  const toggle = $('#nav-toggle');
  toggle.addEventListener('click', () => {
    const nav = $('#sidenav'); const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open); toggle.setAttribute('aria-expanded', String(open));
    if (open) { const f = nav.querySelector('a, button'); if (f) f.focus(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('#sidenav').classList.contains('open')) { closeNav(); toggle.focus(); }
  });
  if (!S.token) { showAuthProblem('No access token was found in the address.'); return; }
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
