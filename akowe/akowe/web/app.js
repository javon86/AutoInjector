// Akọwe browser workspace. Vanilla ES module, no network access beyond this local server.
// All data is rendered with DOM APIs (never innerHTML with server data).
import { configureClipboard, copyText, readText } from './clipboard.js';
import { AI_STATE, plainCheck, problemFor, siteProblemWords, slugName } from './problems.js';
import { viewContinuity } from './continuity.js';   // 🧭 Section 7 (P32–P35)
import { estimateBox, runCostLine, viewCosts, viewSceneGrid } from './grid.js';  // 🗂 P27 · ⏱ P28
import * as S7C from './section7c.js';  // P23 beta reader + P25 your writing style (Section 7c)
import { forgeRoute } from './forge.js';  // 🗂 B5 Character Forge dossiers (characters, items, places, magic)
import { viewPictures } from './pictures.js';  // 🖼 B3 chapter/scene pictures and the map
import { viewTrailer } from './trailer.js';  // 🎞 B2 the book trailer (AutoInjector 🎬 Video)
import { viewCover } from './cover.js';  // 🎨 B3 book covers

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
/* ======================================================================= plain words (BF-11)
 * One place for the words authors see instead of contract jargon (execution kinds, field keys, formats,
 * error codes). The technical details stay in the page inside .tech elements and show only while
 * "🔧 Details" is switched on (html.show-tech, remembered in this browser) — for power users.
 */
const PLAIN_EXEC = {
  LOGIC: 'Akọwe does it (no AI)',
  HYBRID: 'Your AI drafts it, or you write it yourself',
  AI: 'Your AI drafts it (you can also write it yourself)',
  'LOGIC/HYBRID': 'Akọwe does it, with your AI or you filling in the creative parts',
  'AI/HYBRID': 'Your AI drafts it, or you write it yourself',
};
function plainExecution(ex) { return PLAIN_EXEC[ex] || 'Akọwe does it'; }
/** One-line hints for the fields authors meet most; others get a hint from their name and kind (fieldHint). */
const FIELD_HINT = {
  concept: 'Who or what this is, in a sentence or two (a name and a short description is enough).',
  instruction: 'What you want done, in your own words.',
  idea: 'Your book idea in a few sentences.',
  premise: 'What the book is about, in a few sentences.',
  reason: 'Why, in a sentence.',
  goals: 'What this should achieve.',
  constraints: 'Anything it must or must not do.',
  preferences: 'How you would like it done.',
  mode: 'Choose how this should run.',
  events: 'The events, one per item, in story order.',
  span_ids: 'Which passages of the text this is about.',
  source_refs: 'The records this is based on.',
  manuscript_ref: 'Pick the manuscript (your chapters) to work on.',
  main_plot_ref: 'Pick the main plot.',
  style_ref: 'Pick the writing style to follow.',
  outline_ref: 'Pick the chapter outline.',
  premise_ref: 'Pick the premise.',
  job_id: 'A short name for this job, e.g. job-1.',
  character_id: 'Which character (as named in your story bible).',
  chapter_id: 'Which chapter, e.g. ch-1.',
  scene_id: 'Which scene, e.g. s-1.',
  chapter_position: 'Where this chapter sits in the book.',
  language_tag: 'The language, e.g. en or en-GB.',
  title: 'The title.',
  name: 'The name.',
  summary: 'A short summary.',
  text: 'The text itself.',
  rewrite_goal: 'What the rewrite should change.',
  transition_goal: 'What the transition should do.',
  style_goal: 'How the style should change.',
  style_name: 'A name for this style.',
  style_rules: 'The rules of this style, one per item.',
  feature_selected: 'Tick if this book uses this feature.',
  phase: 'Which stage this belongs to.',
  project_metadata: 'The book’s details.',
};
/** A plain one-line hint: the table above, else (required fields only) one made from the field's name and kind. */
function fieldHint(key, kind, required) {
  if (!key || /^\d+$/.test(key) || key === 'payload' || key === 'manual_candidate') return '';
  if (FIELD_HINT[key]) return FIELD_HINT[key];
  if (!required) return '';
  const thing = humanize(key.replace(/_(refs?|ids?)$/, '')).toLowerCase();
  if (/_ref$/.test(key) || kind === 'ref') return `Pick the ${thing} this builds on.`;
  if (/_refs$/.test(key) || kind === 'refs') return `Pick the ${thing} records this uses (one or more).`;
  if (/_ids$/.test(key)) return `Which ${thing}s (their ids, as shown on their records).`;
  if (/_id$/.test(key)) return `Which ${thing} (its id, as shown on its record).`;
  if (kind === 'choice') return 'Choose one of the options.';
  if (kind === 'bool') return 'Tick for yes.';
  if (kind === 'number') return 'A number.';
  if (kind === 'list') return 'Add at least one with the Add button.';
  if (kind === 'group') return 'Fill in the parts below.';
  return `Write the ${thing} in your own words.`;
}
/** Plain names for the drafts the book path lists (their stored titles are often just record ids). */
const ITEM_NAME = { A01: 'Character', A03: 'World', A04: 'Place', B01: 'Premise', B03: 'Main plot', B11: 'Chapter outline', C02: 'Chapter',
  G02: 'Chapter order', G06: 'Chapter headings', G08: 'Title page', G01: 'Manuscript (all chapters together)', G05: 'Typography',
  G04: 'Page layout', G07: 'Table of contents', H05: 'Book check', I01: 'Book format' };
const AUX_NAME = { PAGE_PROFILE: 'page size', FONT_PROFILE: 'font', ASSET_MANIFEST: 'font file', PUBLICATION_METADATA: 'title and author',
  TOC_STYLE: 'contents style', OUTPUT_PROFILE: 'file settings', MANUSCRIPT_PDF: 'PDF settings', EPUB_REFLOWABLE: 'EPUB settings', EDITABLE_DOCX: 'Word (DOCX) settings' };
/** What approving a step's drafts means, as the object of "You are approving …". */
const STEP_NOUN = { canon: 'these characters and places', premise: 'the premise', plot: 'the main plot', outline: 'the chapter outline',
  chapters: 'these chapters', format: 'the book format', assemble: 'the put-together book' };
const ITEM_NAMES = {};   // record id -> plain name found in its data (book-format settings)
function isIdTitle(t, rid) { return !t || t === rid || /^[A-K]\d\d(?:-[0-9a-f]{6,})?$/i.test(String(t).trim()); }
/** A draft's name for the author: chapter label, a real title, or what kind of thing it is ("Title page"). */
function itemName(i) {
  if (!i) return '';
  if (ITEM_NAMES[i.record_id]) return ITEM_NAMES[i.record_id];
  if (i.chapter_name) return i.chapter_name;
  const t = String(i.title || '').replace(/^#\s+/, '').split('\n')[0].trim();
  if (!isIdTitle(t, i.record_id)) return plainText(t);
  return ITEM_NAME[i.module_id] || 'Draft';
}
/** Book-format settings carry their kind only in their data: look it up once ("Book format: page size"). */
async function loadItemName(i) {
  if (!i || i.module_id !== 'I01' || ITEM_NAMES[i.record_id] || !isIdTitle(i.title, i.record_id)) return itemName(i);
  try {
    const d = await recordDetail(i.record_id);
    const data = (d.versions[d.versions.length - 1] || {}).data || {};
    const aux = data.auxiliary_record || {};
    const kind = (aux.data && AUX_NAME[aux.data.profile_type]) || AUX_NAME[aux.record_kind];
    if (kind) ITEM_NAMES[i.record_id] = `Book format: ${kind}`;
  } catch { /* the generic name stays */ }
  return itemName(i);
}
/** "Chapter 1" for an outline chapter: its position in the outline (chapter ids like "ch1" are internal). */
function chapterName(c, idx) { return `Chapter ${idx + 1}`; }
/** Server-made titles and messages in the author's words ("Chapter ch1" -> "Chapter 1"). */
function plainText(s) {
  return String(s ?? '').replace(/\b([Cc]hapter) ch-?(\d+)\b/g, '$1 $2')
    .replace(/ \((?:Set [A-K]|[A-K]\d\d(?:\/[A-K]\d\d)*)\)/g, '');   // step codes in passing: "(H05)", "(Set A)"
}
/** A check problem ("RULE: message") as plain words, the rule text behind 🔧 Details. */
function checkItem(p) {
  const c = plainCheck(p);
  return h('li', null, c.text, c.raw ? tech(h('code', null, c.raw)) : null);
}
/** Technical detail (field key, format, error code…): in the page, shown only with 🔧 Details on. */
function tech(...children) { return h('span', { class: 'tech' }, ' ', ...children); }
function techBlock(...children) { return h('div', { class: 'tech tech-block' }, ...children); }
/** An element's words without its 🔧 technical details (for the screen-reader announcement). */
function spokenText(el) {
  const c = el.cloneNode(true);
  for (const t of c.querySelectorAll('.tech')) t.remove();
  return (c.textContent || '').replace(/\s+/g, ' ').trim();
}
function techOn() { return document.documentElement.classList.contains('show-tech'); }
function setTech(on) {
  document.documentElement.classList.toggle('show-tech', !!on);
  saveJSON('bf:show-tech', !!on);
  for (const b of document.querySelectorAll('.tech-toggle')) b.setAttribute('aria-pressed', String(!!on));
}
function techToggle() {
  return h('button', { type: 'button', class: 'small tech-toggle', 'aria-pressed': String(techOn()),
    title: 'Show or hide technical details (field keys, formats, operation codes, error codes) — for power users',
    onclick: () => setTech(!techOn()) }, h('span', { 'aria-hidden': 'true' }, '🔧'), ' Details');
}
if (loadJSON('bf:show-tech', false)) document.documentElement.classList.add('show-tech');
const PLAIN_ERR = {
  MISSING_INPUT: 'Please fill this in.',
  NOT_FOUND: 'The record this points to was not found (it may have been removed). Pick another one.',
  PERMISSION_DENIED: 'You are not allowed to change this.',
  LOCKED_FACT: 'This record is locked: it needs an approval before it can change.',
  APPROVAL_REQUIRED: 'This needs your approval first.',
  CAPABILITY_UNAVAILABLE: 'No AI is ready for this. Connect one in Settings, or write it yourself.',
  HASH_MISMATCH: 'A linked record changed since it was picked. Pick it again.',
  LEASE_EXPIRED: 'This took too long and was stopped. Try again.',
  TIMEOUT: 'This took too long. Try again.',
  QUOTA_EXCEEDED: 'The AI is over its limit right now. Try again later.',
  UPSTREAM_UNAVAILABLE: 'The AI did not answer. Try again in a moment.',
  UNSUPPORTED_CONTRACT: 'This version of Akọwe does not understand that request.',
  INTERNAL_ERROR: 'Akọwe hit an unexpected problem. Try again; if it keeps happening, use 📋 Copy diagnostics.',
};
/** Plain words for an error from the server (client-side form errors are already plain and kept as they are). */
/** A backup whose files Windows would not flush to disk: it reads back right, but a power cut could still lose it. */
const BEST_EFFORT_SAY = 'Flushed to disk: best effort. The copy reads back correctly, but the system did not confirm it reached the disk, so a power cut right now could still lose it. Make another backup later, or keep a copy elsewhere.';
function plainError(e) {
  if (!e || typeof e !== 'object') return String(e || '');
  if (!('retryable' in e)) return e.message || '';
  const m = String(e.message || '');
  if (e.code === 'VERSION_CONFLICT') {
    const v = /stale base (?:version )?v?(\d+); head is v?(\d+)/.exec(m);
    return v ? `Someone saved a newer version of this record (v${v[2]}) while you were editing v${v[1]}. Reload it, then make your change again.`
      : 'This changed while you were working on it. Reload, then try again.';
  }
  if (e.code === 'INVALID_INPUT') {
    if (/is empty|should be non-empty|is too short/.test(m) && !/\[/.test(m)) return 'This is empty: please type some text (spaces alone don’t count).';
    if (/unsupported field/.test(m)) return 'This field does not belong here.';
    if (/is not one of|const/.test(m)) return 'Choose one of the offered options.';
    if (/does not match|is not a '/.test(m)) return 'This is not in the expected format.';
    if (/is too long/.test(m)) return 'This is too long.';
    if (/is not of type/.test(m)) return 'This is the wrong kind of value.';
    return m.length < 120 && !/[{}[\]'/]/.test(m) ? m : 'This value is not accepted.';
  }
  return PLAIN_ERR[e.code] || m;
}
/** "(CODE at /path: raw message)" for the 🔧 Details view of a server error. */
function errTech(e) {
  return tech(h('code', null, [e.code, e.path ? `at ${e.path}` : null].filter(Boolean).join(' ')), e.message && plainError(e) !== e.message ? ` — ${e.message}` : '');
}
function fmtTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
/** "23 October 2026, 20:03" (local time) for messages; fmtTime stays the compact form for lists. */
function fmtWhen(iso) {
  if (!iso) return 'an earlier time';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'an earlier time';
  try { return d.toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return d.toLocaleString(); }
}
function shortHash(h) { return h ? h.slice(0, 10) + '…' : ''; }
function announce(msg) {
  const live = $('#live'); live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 30);
}
let toastTimer = null;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
/** "⚡ label" for the yellow ⚡ buttons: the bolt sits in a dark disc, else a yellow emoji vanishes on the yellow button. */
function boltLabel(label) {
  return [h('span', { class: 'mab-cta-bolt', 'aria-hidden': 'true' }, '⚡'), ' ', label];
}
function badge(icon, label, cls, title) {
  return h('span', { class: `badge ${cls}`, title },
    h('span', { class: 'ico', 'aria-hidden': 'true' }, icon), label);
}
/** Which AIs work right now (P18.9): ✔ working · 🔧 being repaired · ⚠️ needs you / not working · ⏳ being checked. */
function aiStrip(ais, label = 'AIs') {
  if (!ais || !ais.length) return null;
  return h('div', { class: 'ai-strip', role: 'status', 'aria-label': 'Which AIs work right now', 'data-testid': 'ai-strip' },
    h('strong', null, `${label}: `),
    ais.map(a => {
      const w = AI_STATE[a.state] || AI_STATE.unknown;
      const why = a.problem && !a.working ? siteProblemWords(a.problem) : '';
      return h('span', { class: `ai-chip badge ${w[2]}`, 'data-ai': a.slot_id, 'data-state': a.state, title: why ? `${a.name} ${why}` : null },
        h('span', { class: 'ico', 'aria-hidden': 'true' }, w[0]), `${a.name} — ${a.word || w[1]}`,
        why ? h('span', { class: 'ai-why' }, ` (${a.problem}: ${why})`) : null);
    }));
}
const NOT_INDEPENDENT = 'Reviews are not independent — the same AI wrote and reviewed this';
/** "written by AI-1 · Claude · reviewed by AI-2 · ChatGPT", with ⚠️ when the same AI did both (P3.1 / P3.2). */
function reviewWho(rv, madeBy) {
  if (!rv) return null;
  const writer = rv.writer || (madeBy && madeBy.label) || 'the author';
  const reviewer = rv.reviewer || rv.slot_label || rv.slot || 'the AI';
  return h('p', { class: `small rv-who${rv.independent === false ? ' not-independent' : ''}`, 'data-testid': 'rv-who' },
    `✍ written by ${writer} · 🧐 reviewed by ${reviewer}`,
    rv.independent === false ? h('span', { class: 'rv-warn', role: 'note' }, h('span', { 'aria-hidden': 'true' }, ' ⚠️ '), rv.warning || NOT_INDEPENDENT) : null);
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
    noteClientError('NETWORK', `${method} ${path.split('?')[0]}`, 'Akọwe did not answer');
    throw new NetworkError('Could not reach the Akọwe server. Check that it is still running, then retry.');
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
    h('h1', { id: 'auth-h' }, 'Open Akọwe from its start link'),
    h('p', null, detail || 'This page has no access token.'),
    h('p', null, 'For privacy, the workspace only answers requests that carry the private token created when Akọwe starts. ' +
      'Open the full link printed in the Akọwe console window or launcher (it looks like ',
    h('code', null, 'http://127.0.0.1:8780/#token=…'), ').'),
    h('p', null, 'The token is kept only for this browser tab. If you opened a new tab or restarted Akọwe, use the link again.')));
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
  // staleUsed: approved records that are out of date. Out-of-date working drafts nobody approved (helper drafts such as
  // the plain first compile or chapter contexts, drafts replaced by a redo) don't need the author: the sidebar skips them.
  const st = { count: recs.length, approved: 0, stale: 0, staleUsed: 0, draft: 0 };
  for (const r of recs) {
    if (r.approved_version) st.approved++;
    if (r.stale) st.stale++;
    if (r.stale && r.approved_version) st.staleUsed++;
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
  if (st.staleUsed) parts.push(`⚠︎${st.staleUsed} out of date`);
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
      await loadChoicesInfo();   // labels of the ending and style choices (profile card, book page); cached, never throws
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
    document.title = h1 ? `${h1.textContent} – Akọwe` : 'Akọwe';
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
  if (parts[0] === 'style') return m => S7C.viewStyle(m, s7c());  // ✒️ P25
  if ((parts[0] || '').split('?')[0] === 'compare') return m => viewCompare(m, parts[1] ? parts[1].split('?')[0] : null);
  if (parts[0] === 'p') {
    const rest = parts.slice(3);
    if (!rest.length) return viewOverview;
    if (rest[0] === 'set' && SETS[rest[1]]) return m => viewSet(m, rest[1]);
    if (rest[0] === 'op' && S.opsById[rest[1]]) return m => viewOperation(m, rest[1]);
    if (rest[0] === 'rec' && rest[1]) return m => viewRecord(m, rest[1], rest[2] ? parseInt(rest[2], 10) : null);
    if (rest[0] === 'edit' && rest[1]) return m => viewEdit(m, rest[1]);
    if (rest[0] === 'write' && rest[1]) return m => viewWrite(m, rest[1], rest[2] || null);
    if (rest[0] === 'scenes' && rest[1]) return m => viewScenes(m, rest[1]);
    if (rest[0] === 'world') return viewWorld;
    if (rest[0] === 'continuity') return m => viewContinuity(m, { h, clear, api, bpath, plink, S, crumbs, problemBox, toProblem, runAiJob, choiceDialog, toast, infoTip, route });
    if (rest[0] === 'report') return viewReport;
    if (rest[0] === 'forge') return m => forgeRoute(m, rest.slice(1), forgeUI());  // 🗂 B5 (…/forge/<rid>, …/forge/items/<rid>)
    if (rest[0] === 'pictures') return m => viewPictures(m, forgeUI());  // 🖼 B3
    if (rest[0] === 'trailer') return m => viewTrailer(m, Object.assign(forgeUI(), { fmtClock }));  // 🎞 B2
    if (rest[0] === 'cover') return m => viewCover(m, forgeUI());  // 🎨 B3 cover designer
    if (rest[0] === 'manifest') return viewManifest;
    if (rest[0] === 'activity') return viewActivity;
    if (rest[0] === 'progress') return viewProgress;
    if (rest[0] === 'book') return viewBook;
    if (rest[0] === 'journal' || (rest[0] || '').startsWith('journal?')) return viewJournal;
    if (rest[0] === 'grid') return m => viewSceneGrid(m, gridUI());  // 🗂 P27
    if (rest[0] === 'costs') return m => viewCosts(m, gridUI());     // ⏱ P28
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
  links.appendChild(h('a', { href: '#/start', class: inProject ? 'tb-new in-project' : 'tb-new', 'aria-current': here === '#/start' ? 'page' : null, title: 'Start a new book (step by step)' }, '🚀 New book'));
  links.appendChild(h('a', { href: '#/', class: inProject ? 'tb-books in-project' : 'tb-books', 'aria-current': here === '#/' ? 'page' : null }, 'Books'));
  if (inProject) {
    add(links, link('p', S.pid, S.branch), 'Overview');
    links.appendChild(h('a', { href: link('p', S.pid, S.branch, 'book'), 'aria-current': here === link('p', S.pid, S.branch, 'book') ? 'page' : null }, '📘 Make my book'));
    links.appendChild(h('button', { type: 'button', class: 'tb-btn tb-save', 'data-testid': 'tb-save', title: '💾 Save this book into its folder in your books folder', 'aria-label': 'Save this book', onclick: ev => quickSave(ev.currentTarget) },
      h('span', { 'aria-hidden': 'true' }, '💾'), h('span', { class: 'tb-label' }, ' Save')));
  }
  links.appendChild(h('button', { type: 'button', class: 'tb-btn tb-open', 'data-testid': 'tb-open', title: '📂 Open a saved book (from your books folder or a file)', 'aria-label': 'Open a saved book', onclick: ev => openSavedBookDialog(ev.currentTarget) },
    h('span', { 'aria-hidden': 'true' }, '📂'), h('span', { class: 'tb-label' }, ' Open')));
  links.appendChild(h('a', { href: '#/settings', class: 'tb-settings', title: 'Settings', 'aria-current': here === '#/settings' ? 'page' : null },
    h('span', { class: 'tb-set-ico', 'aria-hidden': 'true' }, '⚙️ '), h('span', { class: 'tb-label' }, 'Settings')));
  // Less frequent pages live in the "More" menu so the bar stays on one line.
  const more = clear($('#more-links'));
  // inside a book the bar is full at laptop width: "🚀 New book" moves into this menu there (CSS shows one or the other)
  if (inProject) more.appendChild(h('a', { href: '#/start', class: 'more-new', 'aria-current': here === '#/start' ? 'page' : null }, '🚀 Start a new book'));
  add(more, '#/shelf', '📚 My finished books');
  add(more, '#/style', '✒️ My writing style');  // P25 (Section 7c)
  if (inProject) {
    add(more, link('p', S.pid, S.branch, 'journal'), '📜 Book journal');
    add(more, link('p', S.pid, S.branch, 'grid'), '🗂 Scene grid');
    add(more, link('p', S.pid, S.branch, 'costs'), '⏱ Time and AI use');
    add(more, link('p', S.pid, S.branch, 'world'), '🌍 Story rules and world');
    add(more, link('p', S.pid, S.branch, 'continuity'), '🧭 Continuity');
    add(more, link('p', S.pid, S.branch, 'forge'), '🗂 Character Forge');
    add(more, link('p', S.pid, S.branch, 'pictures'), '🖼 Pictures');
    add(more, link('p', S.pid, S.branch, 'cover'), '🎨 Cover');
    add(more, link('p', S.pid, S.branch, 'trailer'), '🎞 Trailer');
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
      staleSet += st.staleUsed;
      ul.appendChild(h('li', { class: st.staleUsed ? 'has-hazard' : null }, h('a', { href: link('p', S.pid, S.branch, 'op', o.id),
        'aria-current': curOp === o.id ? 'page' : null },
      h('span', { class: 'op-id' }, o.id), h('span', { class: 'op-name' }, o.name),
      h('span', { class: 'op-meta' }, opStateText(o.id))),
      st.staleUsed ? hazard({ code: 'STALE', message: `${st.staleUsed} approved part(s) of this step were made from something that changed since.`, where: { book: profileOf().title || S.project.name, set: letter, step: o.name, op: o.id } },
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
    staleSet ? h('span', { class: 'set-warn', title: `${staleSet} approved part(s) here were made from something that changed since (for example a chapter you edited). 📘 Make my book shows what to redo.`, 'aria-label': `${staleSet} out of date` }, '⚠️') : null,
    h('span', { class: 'set-count', title: `${total} saved record(s) in this set` }, String(total), h('span', { class: 'visually-hidden' }, ' records')));
    nav.appendChild(h('div', { class: `set-group set-${letter}${letter === curSet ? ' here' : ''}` }, btn, ul));
  }
}
function closeNav() {
  const nav = $('#sidenav'); nav.classList.remove('open');
  $('#nav-toggle').setAttribute('aria-expanded', 'false');
}

/* ======================================================================= common states */
function stateBox(kind, title, ...body) {
  const icons = { empty: '○', loading: '…', blocked: '⏸︎', failed: '✕', stale: '⚠︎', ok: '✔', draft: '✎', ask: '❓', fix: '⚠️' };
  // The hidden word a screen reader says first: 'ok' is any success (not necessarily an approval); 'ask' is a question
  // for the author, 'fix' something made that still needs fixing (amber, not an error).
  const words = { empty: 'Empty', loading: 'Loading', blocked: 'Blocked', failed: 'Failed', stale: 'Stale', ok: 'Done', draft: 'Draft', ask: 'Please confirm', fix: 'Needs fixing' };
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
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary big mab-cta', onclick: ev => openMakeBook(ev.currentTarget) }, boltLabel('Make a book for me')),
      h('a', { class: 'btn big', href: '#/start' }, '🚀 Start a new book'), h('a', { class: 'btn big', href: '#/shelf' }, '📚 My finished books'),
      h('button', { type: 'button', class: 'big', 'data-testid': 'home-open', onclick: ev => openSavedBookDialog(ev.currentTarget) }, '📂 Open a saved book'))));
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
      h('p', null, 'The book disappears from Akọwe. A safety backup is made first and kept (it is never rotated out); restoring that backup brings the book back. To only hide a book, use 🗄 Archive instead.')),
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
      h('a', { class: 'btn', href: plink('manifest'), title: 'The feature manifest: which parts of Akọwe this book uses' }, '🎛️ Book features'),
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
      h('a', { class: 'btn', href: plink('journal') }, '📜 Book journal'), h('a', { class: 'btn', href: '#/shelf' }, '📚 Finished books'),
      // the 🔎 Timeline card lives at the bottom of Make my book: this opens that page and scrolls down to it
      h('a', { class: 'btn', href: plink('book'), 'data-testid': 'ov-timeline-link', title: 'At the bottom of 📘 Make my book (after the characters and places are done)',
        onclick: () => { S.scrollToFacts = true; } }, '🔎 Timeline, trade facts and repeats'))));
  main.appendChild(h('section', { class: 'card mab-card' },
    h('div', null, h('h2', null, '⚡ Make a book for me'), h('p', { class: 'small' }, 'Let your AI make a whole NEW book in one go — you watch every step, can pause or cancel, and get PDF, EPUB and Word at the end. This book is not touched.')),
    h('button', { type: 'button', class: 'primary big mab-cta', onclick: ev => openMakeBook(ev.currentTarget) }, boltLabel('Make a book for me'))));
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
        badge(o.execution.includes('AI') || o.execution.includes('HYBRID') ? '✦' : '⚙︎', isCreative(o) ? 'AI or you' : 'Automatic', 'b-muted', plainExecution(o.execution)),
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
  h('div', { class: 'row' }, h('span', { class: 'op-state-slot' }, opStateBadge(opId)), badge(isCreative(op) ? '✦' : '⚙︎', plainExecution(op.execution), 'b-muted'),
    tech(badge('▦', op.ui_type, 'b-muted')), techToggle())));
  main.appendChild(stepNav(opId));
  const nextBox = h('div');
  const drawNext = () => clear(nextBox).appendChild(whatsNextCard(opId));
  drawNext();
  S.onGuideChanged = drawNext;
  S.leaveHooks.push(() => { S.onGuideChanged = null; });
  main.appendChild(nextBox);

  const notRequired = S.manifest && !isRequired(opId);
  const needs = (op.create_requires || []).map(x => humanize(x.replace(/^\/?payload\//, '').split('/')[0]));
  main.appendChild(h('section', { class: 'card', 'aria-labelledby': 'op-about' }, h('h2', { id: 'op-about' }, 'About this step'),
    h('dl', { class: 'kv' },
      h('dt', null, 'What it is for'), h('dd', null, op.purpose),
      h('dt', null, 'Who does it'), h('dd', null, plainExecution(op.execution)),
      h('dt', null, 'To start, fill in'), h('dd', null, needs.length ? [...new Set(needs)].join(', ') : 'nothing special')),
    techBlock(h('dl', { class: 'kv' },
      h('dt', null, 'Execution'), h('dd', null, op.execution),
      h('dt', null, 'UI type'), h('dd', null, op.ui_type || '—'),
      h('dt', null, 'AI policy'), h('dd', null, op.ai || '—'),
      h('dt', null, 'Routes'), h('dd', null, op.routes || '—'),
      h('dt', null, 'Minimum first input'), h('dd', null, (op.create_requires || []).length ? op.create_requires.map(x => h('code', null, x)).reduce((a, x) => a.concat(a.length ? [', ', x] : [x]), []) : 'none'),
      h('dt', null, 'Accepts references from'), h('dd', null, schema.bindings.length ? schema.bindings.map(b =>
        h('div', null, h('code', null, b.input_path.replace('/payload/', '')), ': ', b.allowed_producers.length > 6
          ? `${b.allowed_producers.slice(0, 6).join(', ')} … (${b.allowed_producers.length})` : b.allowed_producers.join(', '),
        b.required_at_create ? ' (required)' : '')) : 'none'),
      h('dt', null, 'Manifest'), h('dd', null, S.manifest ? (isRequired(opId) ? 'Required in this branch’s feature manifest' : 'Not in required_operations for this branch') : 'unknown'),
      h('dt', null, 'Specification'), h('dd', null, h('code', null, op.specification || ''))))));
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
      recCard.appendChild(stateBox('empty', `Nothing here yet`,
        h('p', null, 'Fill in the form below (the fields marked Required) and press Create.',
          tech(`No ${op.id} records on branch ${S.branch}. Minimum first input: `, (op.create_requires || []).join(', ') || 'none', '.'))));
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
  card.appendChild(h('div', { class: 'new-head' }, h('h2', { id: 'new-h' }, `New: ${op.name}`, tech(`(${op.id})`)), pasteBtn, aiBtn,
    aiBtn ? infoTip('What does Fill with AI do?', ...TIP_ASSIST(op)) : null));
  if (aiBtn) card.appendChild(h('p', { class: 'small muted', id: 'ai-btn-h' }, 'Fill with AI: type what you want and one of your AIs fills this form for you to review. Nothing is saved until you press Create.'));
  card.appendChild(h('p', { class: 'muted small' }, 'Fill in the fields marked Required; leave the others empty if you like. ', techToggle(),
    tech('Optional fields left empty are not sent (absent means “not supplied”).')));
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
      c && c.manual ? 'The complete copied record is also in “Write it myself” below (tick it to use it as-is). ' : '',
      skipped.length ? `Skipped (not fields of this form): ${skipped.join(', ')}. ` : '',
      h('button', { type: 'button', class: 'link', onclick: () => {
        if (confirm('Clear the form?')) { removeKey(draftKey); route(); }
      } }, 'Clear the form'))));
  } else if (draft && draft.from_ai) {
    card.appendChild(stateBox('draft', `Filled by AI (${draft.from_ai.label || draft.from_ai.slot || 'AI'}) — please review`,
      h('p', null, 'Check every field below and change anything you like, then press Create. Nothing has been saved yet. ',
        draft.companion ? '🎭 The AI’s character sheet and voice card are saved with the character when you press Create. ' : '',
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
    manualWrap.appendChild(h('fieldset', { class: 'field' }, h('legend', null, 'Write it myself'),
      h('div', { class: 'check-row' }, manualToggle, h('label', { for: tid }, 'Write the finished result myself (no AI)')),
      h('span', { class: 'hint', id: tid + '-h' }, 'Tick this when no AI is connected, or when you want to write the result yourself. Nothing is sent to an AI.',
        tech('The form below is sent as manual_candidate and checked against the operation’s OUTPUT schema.')),
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
      onSuccess: resp => {
        autosave.clear();
        const comp = draft && draft.companion;
        const ref = resp && (resp.output_refs || [])[0];
        if (op.id === 'A01' && comp && comp.character_sheet && ref) {   // P7/P17: the sheet belongs to the new character
          api('PUT', bpath(`/review/characters/${encodeURIComponent(ref.record_id)}`), { body: { sheet: comp.character_sheet, voice: comp.voice_card || {}, from_ai: true, slot: (draft.from_ai || {}).slot } })
            .then(() => toast('The character sheet and voice card were saved with the character'))
            .catch(e => toast(`The character sheet could not be saved: ${(e && e.message) || e}`));
        }
      },
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
  panel.appendChild(h('div', { class: 'result-panel' }, loadingState(action === 'CREATE' ? 'Saving…' : action === 'UPDATE' ? 'Saving the new version…' : 'Working…'),
    h('p', { class: 'small muted' }, keyStore.attempts > 1 ? 'Trying again with the same content: it cannot be saved twice.' : '',
      tech(`${action} ${op.id}, attempt ${keyStore.attempts}, idempotency key ${keyStore.key}`)),
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
  box.appendChild(h('h3', null, statusBadge(st), ` ${op.name}`, tech(h('span', { class: 'small muted' }, `${op.id} ${action} · attempt ${resp.attempt_id || ''}`))));
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
    box.appendChild(h('h4', null, 'What to fix'));
    const ul = h('ul', { class: 'error-list' });
    for (const e of errs) {
      const fieldLink = findFieldLink(e.path, forms);
      const li = h('li', null, h('span', { 'aria-hidden': 'true' }, e.code === 'CAPABILITY_UNAVAILABLE' || e.code === 'APPROVAL_REQUIRED' ? '⚠️ ' : '✕ '),
        fieldLink ? [fieldLink, ': '] : null, plainError(e), e.retryable ? ' You can press the button again.' : '', errTech(e));
      const resp2 = responsibleLinks(e.path, schema);
      if (resp2) li.appendChild(h('div', { class: 'small' }, resp2));
      if (e.code === 'CAPABILITY_UNAVAILABLE') {
        li.appendChild(h('div', { class: 'row', style: 'margin-top:6px' },
          onManual ? h('button', { type: 'button', class: 'primary small', onclick: onManual }, '✍️ Write it myself') : null,
          h('a', { class: 'btn small', href: '#/settings' }, 'Connect an AI')));
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
        if (m[2] === 'manual_candidate' && onManual) return h('li', null, 'No AI wrote this: ', h('button', { type: 'button', class: 'link', onclick: onManual }, 'write it yourself'), tech(h('code', null, u)));
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
  const label = `${ref.module_id} · ${clipWords(title, 60)} · v${ref.version}`;
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
  markError(f, msg, raw) {
    if (!f.errEl) return;
    const code = (raw && raw.code) || (/\(([A-Z_]+)\)\s*$/.exec(msg) || [])[1] || 'INVALID_INPUT';
    const plain = msg.replace(/\s*\([A-Z_]+\)\s*$/, '');
    const where = { book: (profileOf().title || (S.project || {}).name), field: f.label || f.ptr };
    f.errEl.hidden = false;
    f.errEl.appendChild(h('span', { style: 'display:block' }, hazard({ code, message: plain, path: f.ptr, where }, { form: () => focusField(f) }, { small: true }), ' ', plain,
      raw && 'retryable' in raw ? errTech(raw) : null));
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
    if (f && ctx) ctx.markError(f, plainError(e), e);
    items.push(h('li', null, f && f.control
      ? h('a', { href: '#' + f.control.id, onclick: ev => { ev.preventDefault(); focusField(f); } }, f.label || humanize(String(e.path || '').split('/').pop()))
      : (f && f.label) || 'The form', ': ', plainError(e), 'retryable' in e ? errTech(e) : null));
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
  // plain words first (a one-line hint for every required field), technical bits behind 🔧 Details
  const hintParts = [fieldHint(key, opts.kind, required), opts.hint].filter(Boolean);
  const techParts = [...(opts.tech || [])];
  if (key && !/^\d+$/.test(key) && key !== 'payload' && key !== 'manual_candidate') techParts.unshift(`Field ${key}`);
  const hint = hintParts.length || techParts.length ? h('span', { class: 'hint', id: hintId }, hintParts.join(' · '),
    techParts.length ? tech(`(${techParts.join(' · ')})`) : null) : null;
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
  return buildJson(value, ptr, label, required, ctx, t === 'object' ? 'Advanced: written as JSON, e.g. {"key": "value"}' : 'Advanced: written as JSON (text in "quotes")');
}

function buildString(schema, value, ptr, name, label, required, nullable, ctx) {
  const sh = fieldShell(ctx, ptr, label, required, { kind: 'text',
    hint: [schema.format === 'date-time' ? 'A date and time, e.g. 2026-01-31T12:00:00Z' : null,
      schema.maxLength ? `up to ${schema.maxLength} characters` : null,
      nullable ? 'Leave empty if unknown or not applicable' : null].filter(Boolean).join(' · '),
    tech: [schema.format === 'date-time' ? 'RFC3339 UTC' : null, schema.pattern ? `pattern ${schema.pattern}` : null,
      nullable ? 'empty = null' : null].filter(Boolean) });
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
    integer ? 'whole number' : 'number', nullable ? 'leave empty if unknown' : null].filter(Boolean).join(' · ');
  const sh = fieldShell(ctx, ptr, label, required, { hint: bounds, kind: 'number', tech: nullable ? ['empty = null'] : [] });
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
  const sh = fieldShell(ctx, ptr, label, required, { kind: 'bool' });
  if (required && !nullable) {
    const control = h('input', { type: 'checkbox', id: sh.id, checked: value === true });
    describe(control, sh.hintId);
    const wrap = h('div', { class: 'field' }, h('div', { class: 'check-row' }, control, h('label', { for: sh.id }, label, sh.reqTag)), sh.hint, sh.err);
    ctx.register(ptr, { ptr, wrap, control, errEl: sh.err, label });
    return { el: wrap, get: () => control.checked };
  }
  const control = h('select', { id: sh.id },
    h('option', { value: '' }, nullable ? '— unknown —' : '— not set —'),
    h('option', { value: 'true', selected: value === true }, 'Yes'),
    h('option', { value: 'false', selected: value === false }, 'No'));
  describe(control, sh.hintId);
  const wrap = h('div', { class: 'field' }, h('label', { for: sh.id }, label, sh.reqTag), control, sh.hint, sh.err);
  ctx.register(ptr, { ptr, wrap, control, errEl: sh.err, label });
  return { el: wrap, get: () => control.value === '' ? (nullable ? null : undefined) : control.value === 'true' };
}

function buildEnum(schema, value, ptr, label, required, ctx) {
  const sh = fieldShell(ctx, ptr, label, required, { kind: 'choice' });
  const control = h('select', { id: sh.id });
  const hasNull = schema.enum.includes(null);
  control.appendChild(h('option', { value: '' }, required ? '— choose —' : '— not set —'));
  for (const v of schema.enum) {
    control.appendChild(h('option', { value: JSON.stringify(v), selected: value !== undefined && JSON.stringify(value) === JSON.stringify(v) },
      v === null ? 'unknown' : String(v)));
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
    h('code', null, JSON.stringify(schema.const)), h('span', { class: 'hint' }, 'Set by Akọwe (you cannot change it)'));
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
  const names = { string: 'Text', number: 'Number', boolean: 'Yes / no', null: 'Unknown', list: 'List' };
  const sh = fieldShell(ctx, ptr, label, required, { hint: 'Choose what kind of value it is, then enter it. List: one item per line.' });
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
  const sh = fieldShell(ctx, ptr, label, required, { hint: 'Choose which kind to fill in', kind: 'choice' });
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
  const gHint = fieldHint(ptr.split('/').pop(), 'group', required);
  if (gHint) wrap.appendChild(h('span', { class: 'hint' }, gHint));
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
  const hintTxt = [fieldHint(name, items.enum ? 'choice' : 'list', required), schema.minItems ? `at least ${schema.minItems}` : null, schema.maxItems ? `at most ${schema.maxItems}` : null].filter(Boolean).join(' · ');
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
  if (nullable) select.appendChild(h('option', { value: '__null' }, '— none —'));
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
    allowed.list.length > 5 ? ` or ${allowed.list.length - 5} other steps` : '', '.');
}

/** Hint for a record picker: what kind of record, in words; the operation codes go behind 🔧 Details. */
function refHintOpts(allowed, kind) {
  if (!allowed.list) return { kind, hint: 'Pick a record from this book.', tech: ['accepts any record in this branch'] };
  const names = allowed.list.slice(0, 3).map(m => (S.opsById[m] ? S.opsById[m].name : m));
  return { kind, hint: `Pick from: ${names.join(', ')}${allowed.list.length > 3 ? ' and more' : ''}.`,
    tech: [`accepts ${allowed.list.length > 6 ? allowed.list.slice(0, 6).join(', ') + ' …' : allowed.list.join(', ')}`] };
}
function buildRefField(refSchema, value, ptr, label, required, ctx, nullable) {
  const allowed = allowedModules(refSchema, ptr, ctx);
  const sh = fieldShell(ctx, ptr, label, required, refHintOpts(allowed, 'ref'));
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
  const sh = fieldShell(ctx, ptr, label, required, refHintOpts(allowed, 'refs'));
  const chosen = Array.isArray(value) ? value.filter(isRefValue) : [];
  const listEl = h('ul', { class: 'ref-list' });
  const select = h('select', { id: sh.id, 'aria-label': `${label}: record to add` });
  describe(select, sh.hintId);
  let filled = fillRefSelect(select, allowed, { nullable: false, required: false, current: undefined });
  const addBtn = h('button', { type: 'button', class: 'small' }, 'Add');
  const renderList = () => {
    clear(listEl);
    if (!chosen.length) listEl.appendChild(h('li', { class: 'small muted' }, 'None picked yet.'));
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
  if (isLatest && ['C02', 'B01', 'B03', 'B11'].includes(op.id) && cur.record_kind === 'OUTPUT') main.appendChild(editorCard(cur));
  if (op.id === 'A01' && cur.record_kind === 'OUTPUT') main.appendChild(characterCard(cur));

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
  const card = h('section', { class: 'card', 'aria-labelledby': 'ed-h' }, h('h2', { id: 'ed-h' }, 'Edit'),
    h('p', { class: 'small muted' }, `Saving makes version ${latest.version + 1} as a draft. The approved version stays in the book until you approve the new one. `, techToggle(),
      tech('Every field is sent: this is a full replacement (UPDATE), not a patch.')));
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

/* ======================================================================= views: read / change a chapter or the outline
 * The guided path's reader and editor for the two things authors change most: a chapter's text (title + prose) and the
 * chapter outline (per chapter: what happens, whose eyes, where). Saving makes a new draft version (UPDATE); the
 * approved one stays in the book until the author approves the new one. The developer record view (versions,
 * checks, sources, every field) stays one click away behind 🔧 Details.
 */
const SIMPLE_OPS = ['C02', 'B11'];
/** Where a draft opens for the author: the simple reader for chapters and the outline, the record view otherwise. */
function simpleHref(i) { return SIMPLE_OPS.includes(i.module_id) ? plink('write', i.record_id) : plink('rec', i.record_id); }
/** Where "✏️ Edit" goes: the simple editor for chapters and the outline, the full form otherwise. */
function simpleEditHref(i) { return SIMPLE_OPS.includes(i.module_id) ? plink('write', i.record_id, 'edit') : plink('edit', i.record_id); }
/** "# Title\n\nText…" -> { title, body }. The same rule as the exporter (exporters/book.py): the first non-blank line
 * names the chapter when, trimmed, it starts with "# " and has more after it. A line of only "#" is a scene break,
 * never a title, so a chapter that opens with one is left exactly as written. */
function splitChapter(text) {
  const s = String(text || '');
  const m = /^(?:[^\S\r\n]*(?:\r\n|\r|\n))*([^\r\n]*)(?:\r\n|\r|\n|$)/.exec(s);
  const line = m ? m[1].trim() : '';
  if (!line.startsWith('# ') || line.length <= 2) return { title: '', body: s };
  return { title: line.slice(2).trim(), body: s.slice(m[0].length).replace(/^(?:[^\S\r\n]*(?:\r\n|\r|\n))+/, '') };
}
function joinChapter(title, body) {
  const t = title.trim(); const b = body.replace(/\s+$/, '');
  return t ? `# ${t}\n\n${b}` : b;
}
const PLAN_FIELD = { what: 'plan.objective', pov: 'plan.pov_id', place: 'plan.location_id' };
function planFact(item, pred) { return (item.facts || []).find(f => f && f.predicate === pred) || null; }
/** The book's characters or places for a picker: [{ id, name }] (id = the name id the outline uses). */
async function canonChoices(op) {
  const recs = S.records.filter(r => r.module_id === op && r.record_kind === 'OUTPUT' && !['REJECTED', 'SUPERSEDED'].includes(r.lifecycle));
  const out = [];
  for (const r of recs) {
    let id = r.record_id;
    try {
      const d = await recordDetail(r.record_id);
      const v = d.versions.find(x => x.version === (r.approved_version || r.latest_version)) || d.versions[d.versions.length - 1];
      const f = ((v && v.data && v.data.facts) || []).find(x => x.predicate === 'entity.name') || ((v && v.data && v.data.facts) || [])[0];
      if (f && f.subject_id) id = f.subject_id;
    } catch { /* the record id works too */ }
    out.push({ id, rid: r.record_id, name: recordTitle(r) + (r.approved_version ? '' : ' (not approved yet)') });
  }
  return out;
}
function choiceSelect(id, choices, current, noneLabel, what) {
  const sel = h('select', { id });
  sel.appendChild(h('option', { value: '' }, noneLabel));
  let found = current == null || current === '';
  for (const c of choices) {
    const on = c.id === current || c.rid === current;
    if (on) found = true;
    sel.appendChild(h('option', { value: c.id, selected: on }, c.name));
  }
  if (!found) sel.appendChild(h('option', { value: String(current), selected: true }, `“${slugName(current)}” (not one of your ${what})`));
  return sel;
}

async function viewWrite(main, rid, mode) {
  const d = await recordDetail(rid, true);
  const latest = d.versions[d.versions.length - 1];
  if (!SIMPLE_OPS.includes(latest.module_id) || latest.record_kind !== 'OUTPUT') { await viewRecord(main, rid, null); return; }
  const isChapter = latest.module_id === 'C02';
  let label = isChapter ? 'Chapter' : 'Chapter outline';
  let chapterRow = null;
  if (isChapter) {
    try {
      const book = await api('GET', bpath('/book'));
      const st = book.steps.find(x => x.id === 'chapters');
      const i = ((st && st.chapters) || []).findIndex(c => [c.prose, c.approved].some(r => r && r.record_id === rid));
      if (i >= 0) { label = chapterName(st.chapters[i], i); chapterRow = st.chapters[i]; }
    } catch { /* "Chapter" is enough */ }
  }
  // the outline names characters and places by id: show and pick them by name
  const [people, places] = isChapter ? [[], []] : await Promise.all([canonChoices('A01'), canonChoices('A04')]);
  const nameOf = (list, v) => { const c = list.find(x => x.id === v || x.rid === v); return c ? c.name.replace(/ \(not approved yet\)$/, '') : slugName(v); };
  const approvedV = latest.approved_version;
  const waiting = ['DRAFT', 'VALIDATED'].includes(latest.lifecycle);
  const title = h('h1', { class: 'wrap-anywhere' }, isChapter ? `📖 ${label}` : '📖 Chapter outline');
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [S.project.name, plink()], ['Make my book', plink('book')], label), title),
  h('div', { class: 'row' }, waiting ? badge('✎', approvedV ? 'New version, waiting for your approval' : 'Draft, waiting for your approval', 'b-warn')
    : latest.lifecycle === 'APPROVED' || latest.lifecycle === 'LOCKED' ? badge('✔', 'Approved', 'b-ok') : lifecycleBadge(latest.lifecycle),
  techToggle(), h('a', { class: 'btn small tech', href: plink('rec', rid) }, '🔧 Developer view (versions, checks, sources)'))));
  const msg = h('div', { 'aria-live': 'polite' });
  main.appendChild(msg);
  if (waiting && approvedV) main.appendChild(h('p', { class: 'notice small' }, `This is a newer version. The approved one (version ${approvedV}) stays in the book until you approve this one.`));
  const blocking = (latest.findings || []).filter(f => f.severity === 'BLOCKING' && ['FAIL', 'UNKNOWN'].includes(f.decision));
  if (waiting && blocking.length) {
    main.appendChild(stateBox('fix', 'Akọwe’s checks found problems: change it below, or let the AI write it again',
      h('ul', null, blocking.slice(0, 6).map(f => checkItem(`${f.rule_id}: ${f.message}`)))));
  }
  const card = h('section', { class: 'card simple-doc', 'aria-labelledby': 'sd-h' });
  main.appendChild(card);
  // 🖋 the editor's craft notes for exactly this version (P4/P5/P6), below the text
  const edSlot = h('div');
  main.appendChild(edSlot);
  // 🎬 the scene cards this chapter was (or will be) written from (P8)
  if (chapterRow) main.appendChild(scenesMini(chapterRow.chapter_id, chapterRow.scenes));
  const back = () => h('a', { class: 'btn', href: plink('book') }, '◀ Back to Make my book');
  const approveBtn = () => waiting ? h('button', { type: 'button', class: 'primary', onclick: () => approveThis() }, '✔ Approve this version') : null;

  const approveThis = async () => {
    const ok = await choiceDialog('Approve as the author?', h('p', null, `You are approving this version of ${isChapter ? label : 'the chapter outline'}. It becomes part of the book; later steps built on the old version are marked to redo.`),
      [{ id: 'yes', label: '✔ Yes, I approve' }]);
    if (ok !== 'yes') return;
    clear(msg).appendChild(loadingState('Approving…'));
    try {
      const out = await api('POST', bpath('/book/approve'), { body: { record_ids: [rid], versions: { [rid]: latest.version }, author_confirms: true } });
      const r = (out.results || [])[0] || {};
      if (r.ok) { toast(`${isChapter ? label : 'The chapter outline'} is approved`); S.details[rid] = null; try { await refreshRecords(); } catch { /* best effort */ } go(plink('book')); return; }
      clear(msg).appendChild(stateBox('fix', 'Not approved yet: Akọwe’s checks found problems', h('ul', null, (r.problems || []).map(checkItem)),
        h('p', { class: 'small' }, h('strong', null, 'What to do: '), 'press ✏️ Change it and fix what the list says.')));
    } catch (e) { clear(msg).appendChild(problemBox(toProblem(e, { book: S.project.name, step: label }), { retry: approveThis })); }
  };

  const reader = () => {
    clear(card);
    card.appendChild(h('h2', { id: 'sd-h', class: 'visually-hidden' }, isChapter ? 'The chapter' : 'The chapters, one by one'));
    if (isChapter) {
      const { title: t, body } = splitChapter(latest.data.text);
      if (t) card.append(h('h2', { class: 'chapter-title' }, t));
      card.append(proseBlock(body || '(This chapter has no text yet.)'));
    } else {
      const ol = h('ol', { class: 'outline-read' });
      for (const [i, it] of (latest.data.chapters || []).entries()) {
        const what = (planFact(it, PLAN_FIELD.what) || {}).value || it.summary || '';
        const pov = (planFact(it, PLAN_FIELD.pov) || {}).value; const place = (planFact(it, PLAN_FIELD.place) || {}).value;
        ol.appendChild(h('li', null, h('strong', null, `Chapter ${i + 1}`), ' — ', plainText(String(what).replace(/^ch-?\d+:\s*/, '')),
          h('div', { class: 'small muted' }, `Told by: ${pov ? nameOf(people, pov) : 'not decided yet'} · Where: ${place ? nameOf(places, place) : 'not decided yet'}`)));
      }
      card.appendChild(ol);
    }
    card.appendChild(h('div', { class: 'form-actions' }, approveBtn(),
      h('button', { type: 'button', onclick: () => editor() }, '✏️ Change it'), back()));
  };

  const draftKey = `bf:simple:${S.pid}:${S.branch}:${rid}`;
  const editor = async () => {
    clear(card);
    const saved = loadJSON(draftKey, null);
    // Unsaved changes are never thrown away: changes made on an older version (someone, an AI job or another window
    // saved a newer one meanwhile) come back on top of the newest version, with a notice.
    const draft = saved && saved.v ? saved : null;
    const older = draft && draft.base_version !== latest.version ? draft.base_version : null;
    const err = h('div', { 'aria-live': 'polite' });
    const status = h('span', { class: 'draft-state small muted', role: 'status' }, draft ? 'Your unsaved changes are back.' : '');
    const save = h('button', { type: 'submit', class: 'primary' }, '💾 Save as a new version');
    let collect;
    const form = h('form', { novalidate: true });
    card.append(h('h2', { id: 'sd-h' }, isChapter ? `Change ${label}` : 'Change the chapter outline'),
      h('p', { class: 'small muted' }, 'Saving makes a new version for you to approve. ', approvedV ? 'The approved version stays in the book until then.' : ''),
      older != null ? stateBox('fix', 'Your unsaved changes are back, on top of the newest version',
        h('p', null, `You were changing version ${older}; version ${latest.version} was saved since (in another window, by an AI job, or by someone else). `
          + `Your text is in the boxes below and saving makes it the next version. Check that it still has what changed in version ${latest.version} `
          + '(🔧 Developer view shows every version).'),
        h('button', { type: 'button', class: 'small', 'data-discard-draft': '1', onclick: () => { removeKey(draftKey); editor(); } }, 'Discard my changes and show the newest version')) : '',
      form);  // '' not null: the DOM's own append() would print a null as the word "null
    if (isChapter) {
      const parts = draft ? draft.v : splitChapter(latest.data.text);
      const tIn = h('input', { type: 'text', id: 'sd-title', value: parts.title || '', 'aria-describedby': 'sd-title-h' });
      const bIn = h('textarea', { id: 'sd-text', rows: '18', 'aria-describedby': 'sd-text-h', class: 'prose-edit' });
      bIn.value = parts.body || '';
      form.append(h('div', { class: 'field' }, h('label', { for: tIn.id }, 'Chapter title'), tIn, h('span', { class: 'hint', id: 'sd-title-h' }, 'Optional. Shown as “' + label + ': title”.')),
        h('div', { class: 'field' }, h('label', { for: bIn.id }, 'The chapter text'), bIn, h('span', { class: 'hint', id: 'sd-text-h' }, 'Leave an empty line between paragraphs.')));
      collect = () => ({ v: { title: tIn.value, body: bIn.value }, data: Object.assign({}, latest.data, { text: joinChapter(tIn.value, bIn.value) }),
        empty: !bIn.value.trim() ? bIn : null });
      bIn.focus();
    } else {
      const rows = [];
      for (const [i, it] of (latest.data.chapters || []).entries()) {
        const dv = draft && draft.v[i];
        const what = dv ? dv.what : String((planFact(it, PLAN_FIELD.what) || {}).value || it.summary || '').replace(/^ch-?\d+:\s*/, '');
        const pov = dv ? dv.pov : (planFact(it, PLAN_FIELD.pov) || {}).value;
        const place = dv ? dv.place : (planFact(it, PLAN_FIELD.place) || {}).value;
        const wIn = h('textarea', { id: `sd-what-${i}`, rows: '2' }); wIn.value = what;
        const pSel = choiceSelect(`sd-pov-${i}`, people, pov, '— Not decided yet —', 'characters');
        const lSel = choiceSelect(`sd-place-${i}`, places, place, places.length ? '— Not decided yet —' : '— No place (the book has no places yet) —', 'places');
        rows.push({ it, wIn, pSel, lSel });
        form.appendChild(h('fieldset', { class: 'field outline-chapter' }, h('legend', null, `Chapter ${i + 1}`),
          h('div', { class: 'field' }, h('label', { for: wIn.id }, 'What happens'), wIn),
          h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', { for: pSel.id }, 'Told through the eyes of'), pSel),
            h('div', { class: 'field' }, h('label', { for: lSel.id }, 'Where it happens'), lSel))));
      }
      collect = () => {
        const chapters = rows.map(({ it, wIn, pSel, lSel }) => {
          const c = JSON.parse(JSON.stringify(it));
          const id = (planFact(c, 'plan.item_id') || {}).value || ((c.facts || [])[0] || {}).subject_id;
          const setFact = (pred, value) => {
            const f = planFact(c, pred);
            if (f) f.value = value;
            else if (id) (c.facts = c.facts || []).push({ assertion_type: 'PLAN', effective_from: null, effective_to: null, predicate: pred, source_refs: [], subject_id: id, value });
          };
          setFact(PLAN_FIELD.what, wIn.value.trim());
          setFact(PLAN_FIELD.pov, pSel.value || null);
          setFact(PLAN_FIELD.place, lSel.value || null);
          c.summary = /^ch-?\d+:\s/.test(it.summary || '') && id ? `${id}: ${wIn.value.trim()}` : wIn.value.trim();
          return c;
        });
        return { v: rows.map(r => ({ what: r.wIn.value, pov: r.pSel.value, place: r.lSel.value })),
          data: Object.assign({}, latest.data, { chapters }), empty: (rows.find(r => !r.wIn.value.trim()) || {}).wIn || null };
      };
      if (rows[0]) rows[0].wIn.focus();
    }
    form.append(err, h('div', { class: 'form-actions' }, save, h('button', { type: 'button', onclick: () => { removeKey(draftKey); reader(); } }, 'Cancel'), back(), status));
    form.addEventListener('input', () => { saveJSON(draftKey, { base_version: latest.version, v: collect().v }); status.textContent = 'Changes kept in this browser until you save.'; });
    form.addEventListener('change', () => saveJSON(draftKey, { base_version: latest.version, v: collect().v }));
    let key = null; let keySig = '';
    form.addEventListener('submit', async ev => {
      ev.preventDefault(); clear(err);
      const c = collect();
      if (c.empty) { err.appendChild(stateBox('failed', 'Something is empty', h('p', null, isChapter ? 'Write the chapter text (spaces alone don’t count).' : 'Write a sentence for every chapter: what happens in it.'))); c.empty.focus(); return; }
      const sig = JSON.stringify(c.data);
      if (sig !== keySig) { key = randomKey(); keySig = sig; }   // the same content resent reuses its key: never saved twice
      save.disabled = true; err.appendChild(loadingState('Saving…'));
      try {
        const out = await api('POST', '/dispatch', { body: { request: { project_id: S.pid, branch_id: S.branch, target_operation: latest.module_id, action: 'UPDATE',
          payload: c.data, base_ref: latest.ref, input_refs: [], idempotency_key: key } } });
        const resp = out.response || {};
        clear(err);
        if ((resp.errors || []).some(e => e && e.code === 'VERSION_CONFLICT')) { conflict(c); return; }
        if ((resp.errors || []).length || !(resp.output_refs || []).length) {
          err.appendChild(stateBox('failed', 'Not saved', h('ul', null, (resp.errors || []).map(e => h('li', null, plainError(e), errTech(e)))),
            h('p', { class: 'small' }, 'Your changes are kept here: fix them and save again.')));
          save.disabled = false; return;
        }
        removeKey(draftKey);
        S.details[rid] = null;
        try { await refreshRecords(); } catch { /* best effort */ }
        toast(`Saved as version ${resp.output_refs[0].version}: approve it to put it in the book`);
        go(plink('write', rid));   // the reader, showing the new version (and its checks)
      } catch (e) {
        if (e instanceof ApiError && (e.errors || []).some(x => x && x.code === 'VERSION_CONFLICT')) { conflict(c); return; }
        clear(err).appendChild(problemBox(toProblem(e, { book: S.project.name, step: label }), {}));
        save.disabled = false;
      }
    });
    // A newer version was saved while the author was typing: keep their text and put it on top of the newest version.
    const conflict = c => {
      saveJSON(draftKey, { base_version: latest.version, v: c.v });
      clear(err).appendChild(stateBox('fix', 'Not saved yet: a newer version was saved while you were changing this',
        h('p', null, 'Your changes are kept. Load the newest version: your text comes back on top of it, so you can check it and save again.'),
        h('button', { type: 'button', class: 'primary small', 'data-load-newest': '1', onclick: () => { S.details[rid] = null; go(plink('write', rid, 'edit')); } },
          '🔄 Load the newest version (keeps your changes)')));
      save.disabled = false;
      const b = err.querySelector('button'); if (b) b.focus();
    };
  };
  const stored = loadJSON(draftKey, null);
  if (mode === 'edit' || (stored && stored.v)) await editor(); else reader();
  edSlot.appendChild(editorCard(latest, { onSaved: () => { S.details[rid] = null; go(plink('write', rid)); } }));
  // ✅ planned to page (P11): what the plan says must be in this chapter, and whether it is
  if (isChapter && chapterRow) edSlot.appendChild(plannedCard(rid, { onSaved: () => { S.details[rid] = null; go(plink('write', rid)); } }));
  // 🔎 timeline, trade facts and repeats (P26/P30/P31)
  if (isChapter && chapterRow) edSlot.appendChild(factsCard(rid, { onSaved: () => { S.details[rid] = null; go(plink('write', rid)); } }));
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
        ? stateBox('ok', 'Backup created and verified', h('p', { class: 'wrap-anywhere' }, 'Location: ', h('code', null, r.path)), r.flushed === 'best effort' ? h('p', { class: 'small' }, BEST_EFFORT_SAY) : null)
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
  // the background notes are folded away, so the page opens on what you can do (connect AutoInjector, the three slots)
  main.appendChild(h('details', { class: 'card settings-about' }, h('summary', { id: 'priv-h' }, 'ⓘ How AI slots are used (and what stays on this computer)'),
    h('ul', null,
      h('li', null, 'Akọwe has exactly three AI slots: AI-1, AI-2 and AI-3. All are optional.'),
      h('li', null, 'When a creative operation runs, its context package (only the records that operation needs from the current project) is sent to the one slot selected for that job — never to the other slots, and never with secrets or unrelated projects.'),
      h('li', null, 'Without a connected slot, the creative steps can’t use an AI: Akọwe opens the form for you to write that part yourself, then checks and stores it. Nothing leaves this computer when you write it yourself.', tech(h('code', null, 'CAPABILITY_UNAVAILABLE'), ' + manual candidate')),
      h('li', null, 'Deterministic (LOGIC) operations never use an AI slot.'),
      h('li', null, 'Roles route work: when a connected slot lists an operation ID (C02) or set letter (B) in its roles, that work goes only to such slots.'),
      h('li', null, 'API keys and AutoInjector connection keys are stored in the local secrets file on this computer, never in project data, exports, reports or logs. Key fields are write-only: a saved key is never shown again.'),
      h('li', null, 'Not sure everything works? Open “More ▾” at the top and press “🧪 Test everything”: it builds a small test book in a separate project and writes a report.'))));
  main.appendChild(autoInjectorCard(main));
  for (const s of slots) main.appendChild(slotForm(s));
  main.appendChild(retryCard());
  main.appendChild(reviewerCard());
  main.appendChild(editorSettingsCard());
  main.appendChild(lengthSettingsCard());
  main.appendChild(booksFolderCard());
  main.appendChild(pictureBridgeCard());  // 🗂 B5: where AutoInjector makes the Character Forge pictures
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
      out.appendChild(stateBox('failed', 'Paste the connection key first', h('p', null, 'In AutoInjector: Akọwe bridge panel → Copy connection key. Then paste it here.')));
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
    h('li', null, 'In AutoInjector: Akọwe bridge panel → switch the bridge on → ', h('strong', null, 'Copy connection key'), '.'),
    h('li', null, 'Paste the key below and press ', h('strong', null, 'Connect AutoInjector'), '. This sets AI-1 = Claude, AI-2 = ChatGPT and AI-3 = Gemini (you can change each slot below).'),
    h('li', null, 'Each slot below then shows where it’s at and the next step. Press ', h('strong', null, 'Test connection'), ' on a slot any time.')),
  h('div', { class: 'grid-2' },
    h('div', { class: 'field' }, h('span', { class: 'label-row' }, h('label', { for: token.id }, 'Connection key'), infoTip('What is the connection key?', ...TIP_KEY())), token,
      h('span', { class: 'hint', id: `${p}-token-h` }, 'From AutoInjector: Akọwe bridge panel → Copy connection key. Saved privately on this computer for all three slots; never shown again.')),
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
    f('ctx', 'Context limit (tokens)', ctxLimit, 'How much this AI can read at once. Larger required material is split, or the step stops and says it is too much for this AI.'),
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
    h('p', null, 'Akọwe will make a small two-chapter book from start to finish, exactly the way you would: create a character and a place, plan the story, write two chapters, track what happens, fix a typo through an edit pass, lay out the book, export a PDF, EPUB and Word file, re-read those files, run the quality checks and approve the release.'),
    h('ul', null,
      h('li', null, h('strong', null, 'Your projects are not touched. '), 'Everything goes into a new, separate project called “Self-test <date time>”. You can open it afterwards and look at every record it made, or ignore it.'),
      h('li', null, h('strong', null, 'It takes about 5 seconds '), 'without AI. Each step is shown as it finishes, with ✔ Passed, ✕ Failed or – Skipped and what to do if something fails.'),
      h('li', null, h('strong', null, 'You get a written report '), '(Markdown and JSON) saved in the “reports” folder next to your Akọwe data. It never contains keys, passwords or AI conversations.')),
    h('div', { class: 'check-row st-ai' }, aiBox,
      h('label', { for: 'st-use-ai' }, 'Use my AI slots too')),
    h('p', { class: 'hint', id: 'st-use-ai-h' }, 'Off: nothing is sent anywhere — the creative steps use fixed text (“MANUAL (no AI)”). On: Akọwe first checks each connected AI slot, then really sends two small prompts (a story premise and a short chapter, plus one “find the events” request) to your connected AI — for example ChatGPT, Claude or Gemini through AutoInjector, or the Anthropic API. Web sessions can take a minute or more per prompt. If no AI is ready, those steps are skipped with the reason and the rest still runs.'),
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
    return stShell('The test stopped', stateBox('failed', 'The test did not finish', h('p', null, err || 'No report was written. Run it again; if it keeps happening, check the Akọwe console window.')),
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
          const a = h('a', { href: url, download: (rep.files && rep.files.markdown) || 'akowe-selftest.md' });
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          announce('Report downloaded');
        } catch (e) { clear(viewOut).appendChild(failedState('The report could not be downloaded', e)); }
      } }, 'Download report (.md)'),
      h('button', { type: 'button', onclick: () => renderSelfTestIntro(st) }, 'Run again')),
    rep.files && rep.files.markdown ? h('p', { class: 'small muted' }, `Saved as ${rep.files.markdown} and ${rep.files.json} in the “reports” folder of your Akọwe data.`) : null,
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
  h('p', null, 'When its “Akọwe bridge” is switched on, Akọwe can hand it a writing job; AutoInjector types it into the logged-in site and passes the answer back. No API key or extra subscription is needed.'),
  h('p', null, 'Both apps talk only on this computer (127.0.0.1); nothing is opened to the internet.')];
const TIP_KEY = () => [
  h('p', null, 'The connection key is a private password that AutoInjector makes so that only your Akọwe can use it. It is not your ChatGPT, Claude or Gemini password.'),
  h('p', null, h('strong', null, 'Where to find it: '), 'In AutoInjector: Akọwe bridge panel → Copy connection key. Then paste it here and press Connect.'),
  h('p', null, 'Akọwe saves it in a private file on this computer (never in your projects, exports or reports) and never shows it again. If AutoInjector makes a new key, paste the new one here.')];
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
  if (!s.has_credentials) return { icon: '⚠︎', word: 'Needs connection key', cls: 'b-warn', now: `Set to use ${site} through AutoInjector, but no connection key is saved.`, next: 'In AutoInjector: Akọwe bridge panel → Copy connection key, then paste it into “Connect AutoInjector” above.' };
  if (!health) return { icon: '…', word: 'Checking', cls: 'b-info', now: 'Asking AutoInjector whether it is running…', next: 'Wait a moment.' };
  if (['repairing', 'needs_user', 'broken'].includes(health.state)) {
    const why = health.problem ? ` (${health.problem}: ${siteProblemWords(health.problem)})` : '';
    if (health.state === 'repairing') return { icon: '🔧', word: 'Being repaired', cls: 'b-warn', now: `AutoInjector says ${site} is not working right now and is fixing it by itself${why}.`, next: 'Nothing to do. Meanwhile Akọwe sends the work to the AIs that work, and uses this one again when it is fixed.' };
    if (health.state === 'needs_user') return { icon: '⚠︎', word: 'Needs you', cls: 'b-bad', now: `AutoInjector says ${site} needs you${why}.`, next: `Open AutoInjector and look at the ${site} window. Akọwe uses the other AIs meanwhile and checks again by itself.` };
    return { icon: '✕', word: 'Not working', cls: 'b-bad', now: `AutoInjector says ${site} is not working${why}.`, next: `Open AutoInjector and check the ${site} window (or use its repair/teach button). Akọwe uses the other AIs meanwhile.` };
  }
  if (health.ok && (health.site_busy || s.active_jobs > 0)) return { icon: '◔', word: 'Busy', cls: 'b-warn', now: `Connected. ${site} is working on another request right now.`, next: 'Nothing to fix — wait for it to finish. Akọwe sends one request at a time per site.' };
  if (health.ok) return { icon: '✔', word: 'Connected · Ready', cls: 'b-ok', now: `Connected to AutoInjector. ${site} is logged in and free.`, next: 'Ready to use. Try “Test everything” with “Use my AI slots too”.' };
  const err = health.error;
  let next = 'Press Test connection again. If it keeps failing, restart the AutoInjector desktop app.';
  let now = health.message || 'The connection check failed.';
  if (err === 'UPSTREAM_UNAVAILABLE') { now = `AutoInjector is not answering at ${s.bridge_url}.`; next = 'Start the AutoInjector desktop app and switch on its Akọwe bridge, then press Test connection.'; }
  else if (err === 'CAPABILITY_UNAVAILABLE') { now = 'AutoInjector did not accept the saved connection key (or does not offer this site).'; next = 'In AutoInjector: Akọwe bridge panel → Copy connection key, paste it into “Connect AutoInjector” above, then Test connection.'; }
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
  return { code: x.code || 'NETWORK', message: x.message || (e && e.message) || String(e), fix: x.fix || (e instanceof NetworkError ? 'Check that Akọwe is still running, then try again.' : '') };
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
      reqText.textContent = clipWords(prompt.value.trim(), 140);
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
      j.companion ? h('p', { class: 'small', 'data-testid': 'ap-companion' }, '🎭 The AI also wrote a character sheet and a voice card. They are saved with the character when you press Create (you can change them on the character’s page).') : null,
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
    { from_ai: { slot: j.slot, label: `${j.slot || ''}${j.slot_label ? ' · ' + j.slot_label : ''}`, job_id: j.job_id }, companion: j.companion || null },
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
  d.addEventListener('close', () => { clearTimeout(BB.poll); afterWorkDialog(); });
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
/** A dialog that saves drafts (📖 Bible Builder, ✨ Make up characters) closed: the page behind it and the sidebar
 * show what changed now, not after a reload (the book page redraws; other pages refresh their record lists). */
async function afterWorkDialog() {
  try { await refreshRecords(); } catch { /* best effort */ }
  if (!S.bookRedraw) return;
  await S.bookRedraw();
  const f = document.activeElement;
  if (!f || f === document.body || !document.contains(f)) { const b = document.querySelector('#main .book-top button.primary'); if (b) b.focus(); }
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
    it.companion ? h('p', { class: 'small', 'data-testid': 'bb-companion' }, '🎭 With a character sheet and a voice card',
      (it.companion.voice_card && it.companion.voice_card.rhythm) ? h('span', { class: 'muted' }, ` — talks: ${it.companion.voice_card.rhythm}`) : null, ' (saved with the character)') : null,
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
  box.appendChild(h('p', { class: 'small' }, `${s.runs.length} run(s): ${counts.gen} generated, ${counts.fail} failed, ${counts.made} created as drafts, ${counts.gen - counts.made} not created. Saved as ${s.report.markdown} in the “reports” folder of your Akọwe data (no prompts, replies or keys).`));
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
  h('p', null, 'A report of every run (which AI, what was made, what was kept) is saved in your Akọwe reports folder.')];

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
// P15 length presets (lengths.py holds the same numbers; GET /api/lengths)
const LENGTH_INFO = { short_story: ['Short story', 'about 3,000–5,000 words, 3–5 chapters'], novelette: ['Novelette', 'about 10,000–15,000 words, 5–8 chapters'],
  novella: ['Novella', 'about 20,000–40,000 words, 8–15 chapters'], novel: ['Novel', 'about 60,000–90,000 words, 20–35 chapters'] };
const LENGTH_TIP = () => [h('p', null, 'The length sets how many chapters the outline plans and how many words each chapter and scene should have. The writer gets the target in every chapter prompt.'),
  h('p', null, 'Long chapters (more than about 2,500 words — a novel’s) are written scene by scene, one AI answer per scene, so web AIs never hit their reply limit. A chapter that comes back far too short is continued once within its scene plan — never padded: the editor still checks it.'),
  h('p', null, 'A novel takes many AI answers (about 25 chapters × scenes, reviews and the editor): the run window shows how long it will still take.')];
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
    field('length', 'Length', lengthSel, infoTip('Length', ...LENGTH_TIP())),
    field('tone', 'Tone', h('input', { type: 'text', value: prof.tone || '', list: `${prefix}-tones`, maxlength: '200' }), dl(`${prefix}-tones`, TONES)),
    field('idea', 'Your idea in a paragraph', h('textarea', { rows: '4', maxlength: '4000' }, prof.idea || '')));
  f.idea.value = prof.idea || '';
  return { el, get: () => Object.fromEntries(Object.entries(f).map(([k, c]) => [k, c.value.trim()])), f };
}
async function openProfileDialog(onSaved) {
  if (!S.project) return;
  await loadChoicesInfo();
  const prof = profileOf();
  modal('📝 Book profile', close => {
    const pf = profileFields(prof, uid('pf'));
    const cf = choicesFields(prof.choices, 'pfc');
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
      if (CH.info) body.choices = cf.get();
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
    pf.el, cf.el, out, h('div', { class: 'form-actions' }, save));
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
      row('AI', prof.ai_slot === 'manual' ? 'I write it myself (no AI)' : prof.ai_slot ? prof.ai_slot : 'Automatic — the best ready AI'),
      row('Ending and style', choicesSummary(prof.choices).length ? h('ul', { class: 'small plain-list', 'data-testid': 'profile-choices' }, choicesSummary(prof.choices).map(x => h('li', null, x))) : 'Let the AI choose')),
    Object.keys(effectiveMatrix(prof.choices || {})).length ? h('details', { class: 'small more-ending' }, h('summary', null, 'More ending options'),
      h('dl', { class: 'kv' }, Object.entries(effectiveMatrix(prof.choices)).map(([r, v]) => [h('dt', null, r.replace(/_/g, ' ')), h('dd', null, v)])),
      h('button', { type: 'button', class: 'small', onclick: () => openProfileDialog() }, 'Change them')) : null);
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
    await loadChoicesInfo();
    const pf = profileFields(w.profile, 'wz');
    const cf = choicesFields(w.profile.choices, 'wz');
    const keep = () => { w.profile = Object.assign(w.profile, pf.get()); if (CH.info) w.profile.choices = cf.get(); save(); };
    pf.el.addEventListener('input', keep); pf.el.addEventListener('change', keep); cf.el.addEventListener('change', keep);
    card.append(h('h2', { id: 'wz-h' }, '1. Tell me about your book'),
      h('p', { class: 'muted' }, 'Only the title is needed now; everything can be changed later.'), pf.el, cf.el, err,
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
      return h('div', { class: 'check-row wz-opt' }, h('input', { type: 'radio', name: 'wz-ai', id, value, checked: (w.ai || '') === value, disabled, onchange: () => { w.ai = value; w.aiPicked = true; save(); } }),
        h('label', { for: id }, h('strong', null, label), detail ? h('span', { class: 'hint' }, detail) : null));
    };
    list.appendChild(opt('', 'Automatic', 'Use the best AI that is ready each time.'));
    list.appendChild(h('p', { class: 'small muted' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Checking your AI slots…'));
    card.append(h('h2', { id: 'wz-h' }, '2. Which AI should help?'),
      h('p', { class: 'muted' }, 'Akọwe can use up to three AIs (set them up in Settings). You can also write everything yourself.'), list,
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
      if (!ready) {
        // BF-14: with no AI ready, "Automatic" would only fail later; preselect Manual (unless the author picked)
        if (!w.aiPicked && (w.ai || '') === '') { w.ai = 'manual'; save(); const auto = list.querySelector('input[value=""]'); if (auto) auto.checked = false; }
        list.appendChild(h('p', { class: 'notice small' }, 'No AI is ready right now, so “Manual” is selected: you write each part yourself, and you can connect an AI later (Settings). Choose “Automatic” only if you will connect an AI before you start.'));
      }
    } catch (e) { list.lastChild.replaceWith(h('p', { class: 'small' }, 'Could not check the AI slots (they can be set up later).')); }
    list.appendChild(opt('manual', 'Manual — I’ll write it myself', 'No AI is used; “📘 Make my book” opens an empty form for each step for you to fill in.'));
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
    if (!ai) {
      // BF-14: manual mode makes nothing up front, so don't ask for counts it would ignore; say what happens instead
      card.append(h('h2', { id: 'wz-h' }, '3. What happens next'),
        h('p', null, 'You chose to write it yourself, so nothing is made for you now.'),
        h('p', null, '“📘 Make my book” walks you through the book one step at a time: your characters and places, the premise, the plot, the chapter outline, then each chapter. Press “Do the next step” and it opens an empty form for that step; you write it, save it and approve it.'),
        h('p', { class: 'small muted' }, 'You can connect an AI at any time in Settings and let it help with the remaining steps.'), err,
        nav(() => goStep(2), () => goStep(4)));
      return;
    }
    card.append(h('h2', { id: 'wz-h' }, '3. What do you want me to make?'),
      h('p', { class: 'muted' }, 'Your AI drafts these; you read and approve each one. Nothing becomes part of the book until you approve it.'),
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
    const makeList = w.ai === 'manual' ? ['nothing now: you write each step yourself in “📘 Make my book”']
      : [w.make.A01 ? `${w.make.A01} character(s)` : null, w.make.A04 ? `${w.make.A04} place(s)` : null, w.make.A03 ? 'the world' : null,
        w.make.premise ? 'a premise' : null, w.make.outline ? 'the plot and chapter outline' : null].filter(Boolean);
    const go4 = h('button', { type: 'button', class: 'primary big' }, '🚀 Create my book');
    card.append(h('h2', { id: 'wz-h' }, '4. Ready?'),
      h('dl', { class: 'kv' }, h('dt', null, 'Title'), h('dd', null, p.title || '—'), h('dt', null, 'Author'), h('dd', null, p.author || '—'),
        h('dt', null, 'Genre / for'), h('dd', null, [p.genre, p.audience].filter(Boolean).join(' · ') || '—'),
        h('dt', null, 'Length'), h('dd', null, p.length ? LENGTH_INFO[p.length][0] : '—'), h('dt', null, 'Tone'), h('dd', null, p.tone || '—'),
        h('dt', null, 'Idea'), h('dd', null, p.idea || '—'), h('dt', null, 'AI'), h('dd', null, aiLabel),
        h('dt', null, 'Ending and style'), h('dd', { 'data-testid': 'wz-choices' }, choicesSummary(p.choices).join(' · ') || 'Let the AI choose'),
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
    h('a', { class: 'btn', href: plink('grid'), 'data-testid': 'bk-grid' }, '🗂 Scene grid'),
    h('button', { type: 'button', class: 'mab-cta', onclick: ev => openMakeBook(ev.currentTarget), title: 'Let the AI make a whole new book (this one is not touched)' }, boltLabel('Make a book for me')))));
  main.appendChild(bookSaveCard());
  const holder = h('div', null, loadingState('Checking where your book is…'));
  main.appendChild(holder);
  let book = null;
  const drawBook = async () => {
    try { book = await api('GET', bpath('/book')); }
    catch (e) { clear(holder).appendChild(failedState('Could not load the book path', e, h('p', null, h('button', { type: 'button', onclick: drawBook }, 'Try again')))); return; }
    if (!document.contains(holder)) return;   // the author moved on meanwhile
    renderBook(holder, book, drawBook);
    refreshTask();   // the sidebar's Current task follows the page right away (not on its next 10 s tick)
  };
  // Dialogs that save drafts (Bible Builder, ✨ Make up characters) redraw this page when they close.
  S.bookRedraw = drawBook;
  S.leaveHooks.push(() => { if (S.bookRedraw === drawBook) S.bookRedraw = null; });
  await drawBook();
  S.onRecordsChanged = null;
}

const BOOK_ERR = {};   // step id -> the problem of the last attempt on this page (shown as ⚠️ on that step)
const RAIL_WORD = { done: 'done', needs_you: 'needs you', ai_can: 'AI can do it', ready: 'ready', blocked: 'waiting', problem: 'problem' };
/** The newest revision of an approved chapter when it is a draft waiting for approval (the author or the AI changed it). */
function waitingRevision(c) {
  const p = c.prose; const a = c.approved;
  if (!p || !a || !['DRAFT', 'VALIDATED'].includes(p.lifecycle)) return null;
  return p.record_id !== a.record_id || p.version > a.version ? p : null;
}
/** Plain words for a step's own message ("B11 could not be created (BLOCKED)." is how the server says it). */
function stepMessage(out, noun) {
  const m = plainText(out.message || '');
  if (/^[A-K]\d\d could not be created/.test(m)) return [`The ${noun || 'draft'} could not be made: Akọwe’s checks did not accept it.`, tech(h('code', null, m))];
  return [m || (out.ok ? 'Done' : 'Not done')];
}
function renderBook(holder, book, redraw) {
  clear(holder);
  const pct = Math.round((book.done_count / book.total) * 100);
  const msg = h('div', { 'aria-live': 'polite', class: 'book-msg' });
  // Plain names: chapters by their place in the outline, other drafts by what they are.
  const chapStep = book.steps.find(x => x.id === 'chapters');
  const chapOf = {};
  ((chapStep && chapStep.chapters) || []).forEach((c, i) => {
    c.name = chapterName(c, i);
    for (const r of [c.prose, c.approved]) if (r) { r.chapter_name = c.name; chapOf[r.record_id] = c.name; }
  });
  for (const st of book.steps) for (const i of st.approve || []) if (chapOf[i.record_id]) i.chapter_name = chapOf[i.record_id];
  const stepOfRecord = rid => book.steps.find(st => (st.approve || []).some(a => a.record_id === rid)
    || (st.chapters || []).some(c => [c.prose, c.approved].some(r => r && r.record_id === rid))) || null;
  const nameEl = i => h('span', { 'data-item-name': i.record_id }, itemName(i));
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
      const noun = STEP_NOUN[curStep] || '';
      // A new draft the checks refuse is not "done": say it needs fixing (amber) and offer the ways forward.
      const fresh = out && out.ok && out.created && out.book ? out.book.steps.flatMap(st => st.approve || []).find(i => i.record_id === out.created.record_id) : null;
      let note = null;
      if (fresh && (fresh.problems || []).length) {
        note = stateBox('fix', `Your AI wrote a new version of the ${noun.replace(/^(the|these) /, '') || 'draft'}, but it needs fixing before you can approve it`,
          h('ul', null, fresh.problems.slice(0, 4).map(checkItem)),
          h('p', { class: 'small' }, h('strong', null, 'What to do: '), 'let the AI write it again, or edit it yourself.'),
          redoBox([fresh]));
      } else if (out) {
        note = stateBox(out.ok ? 'ok' : 'failed', ...stepMessage(out, noun.replace(/^(the|these) /, '')),
          (out.problems || []).length ? h('ul', null, out.problems.map(checkItem)) : null,
          refused.length ? h('ul', null, refused.map(r => h('li', null, h('strong', null, itemName(Object.assign({ module_id: r.module_id, title: '' }, r, { chapter_name: chapOf[r.record_id] }))), ': ',
            h('ul', null, (r.problems || []).map(checkItem))))) : null,
          refused.length ? h('p', { class: 'small' }, h('strong', null, 'How to fix it: '), refused[0].fix || 'Edit it so the checks pass.') : null,
          refused.length ? redoBox(refused.map(r => Object.assign({ title: '' }, r, { chapter_name: chapOf[r.record_id] }))) : null);
      }
      try { await refreshRecords(); } catch { /* best effort */ }
      if (out && out.book) { renderBook(holder, out.book, redraw); refreshTask(); } else await redraw();
      // the message goes into the freshly drawn page, after the steps are up to date
      const nm = holder.querySelector('.book-msg'); if (nm && note) { clear(nm).appendChild(note); announce(spokenText(note)); }
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
    await Promise.all(items.map(loadItemName));
    const names = items.map(i => `• ${itemName(i)}`).join('\n');
    const ok = await choiceDialog('Approve as the author?', h('div', null,
      h('p', null, `You are approving ${what}. Approving makes it part of the book; later steps build on it. If you change it later, the steps built on it are marked to redo.`),
      h('pre', { class: 'small' }, names),
      h('p', { class: 'small muted' }, 'Some steps need an explicit approval record; Akọwe records one for exactly these versions because you confirm here.')),
    [{ id: 'yes', label: '✔ Yes, I approve' }]);
    if (ok !== 'yes') return;
    const versions = Object.fromEntries(items.filter(i => Number.isInteger(i.version)).map(i => [i.record_id, i.version]));
    await run(() => post('approve', { record_ids: items.map(i => i.record_id), versions, author_confirms: true }), 'Approving…', (stepOfRecord(items[0].record_id) || {}).id);
  };
  let bbPending = null; let bbFirst = null;   // the wizard's Bible Builder entries not saved yet (canon step), when there are any
  const redoBox = (items) => {
    // A draft Akọwe's checks refuse cannot be approved by pressing approve again: offer to redo or edit it.
    const box = h('div', { class: 'refused-box' });
    for (const i of items) {
      const redo = i.redo;
      box.appendChild(h('div', { class: 'row' }, h('span', { class: 'small' }, itemName(i), ': '),
        redo && book.ai_ready ? h('button', { type: 'button', class: 'small ai-btn', onclick: () => run(() => post(redo.action, Object.assign({}, redo, { action: undefined, redo: true })),
          'Your AI is writing it again… (web AIs can take a few minutes)', (stepOfRecord(i.record_id) || {}).id) }, '🔁 Redo with AI') : null,
        h('a', { class: 'btn small', href: simpleEditHref(i) }, '✏️ Edit it')));
    }
    return box;
  };
  const doStep = async s => {
    if (!s) return;
    if (s.id === 'profile') { openProfileDialog(() => redraw()); return; }
    if (s.approve && s.approve.length) {
      const ok = s.approve.filter(i => !(i.problems || []).length);
      if (!ok.length) {   // every waiting draft is refused by Akọwe's checks: approving again cannot help
        clear(msg).appendChild(stateBox('failed', `Akọwe’s checks found problems in ${STEP_NOUN[s.id] || s.title.toLowerCase()}: let the AI write it again, or edit it`,
          h('ul', null, s.approve.flatMap(i => (i.problems || []).slice(0, 4).map(checkItem))), redoBox(s.approve),
          h('p', { class: 'small muted' }, 'Changed something it depends on since? ',
            h('button', { type: 'button', class: 'small', onclick: () => approve(s.approve, STEP_NOUN[s.id] || 'these drafts') }, '✔ Check again and approve'))));
        msg.querySelector('button') && msg.querySelector('button').focus();
        return;
      }
      await approve(ok, STEP_NOUN[s.id] || 'these drafts'); return;
    }
    if (s.state === 'blocked') { toast(`Waiting for ${STEP_WAIT[s.waiting_for] || s.waiting_for}`); return; }
    if (s.id === 'canon') {
      // characters/places the 🚀 wizard asked the AI for and that are not saved yet: review and save those first
      const pend = bbPending || (bbFirst ? await bbFirst : null);
      if (pend && (pend.items.length || pend.busy)) { openBible(holder.querySelector('#step-canon .bb-wizard button')); return; }
      if (book.ai_ready) openMakeDialog('A01', null, null); else goNew('A01');
      return;
    }
    if (['premise', 'plot', 'outline'].includes(s.id)) { await run(() => post('create', { op: s.op }), book.ai_ready ? 'Your AI is writing… (web AIs can take a few minutes)' : 'Preparing the form…', s.id); return; }
    if (s.id === 'chapters') {
      const c = (s.chapters || []).find(x => x.state !== 'done' && !(x.prose && ['DRAFT', 'VALIDATED'].includes(x.prose.lifecycle)));
      if (c) await run(() => post('write_chapter', { chapter_id: c.chapter_id }), book.ai_ready ? `Your AI is writing ${c.name}…` : 'Preparing the chapter form…', s.id);
      return;
    }
    if (s.action && ['setup_format', 'assemble', 'export', 'check'].includes(s.action)) await run(() => post(s.action), 'Working…', s.id);
  };
  const nextStep = book.steps.find(s => s.id === book.next);
  // the 💾 card's "not finished — next step" note was read when the page opened: keep it in step with the book
  const opened = document.querySelector('#main [data-testid="opened-box"]');
  if (opened && !nextStep) clear(opened);
  else if (opened && opened.querySelector('[data-testid="opened-next"]')) opened.querySelector('[data-testid="opened-next"]').textContent = nextStep.title;
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
      h('p', { class: 'small' }, plainText(s.about)));
    if (s.state === 'blocked' && s.waiting_for) li.appendChild(h('p', { class: 'small muted' }, `Waiting for ${STEP_WAIT[s.waiting_for] || s.waiting_for}.`));
    if (s.id === 'outline' && (s.missing_characters || []).length) {
      // ⚠️ a main character (named in the idea, proposed as main, or a viewpoint the outline needs) is not approved canon
      li.appendChild(h('div', { class: 'refused-box', 'data-testid': 'missing-characters' },
        h('p', { class: 'small' }, hazard({ code: 'PROTAGONIST_MISSING' }, {}, { small: true }), ' ',
          'Not in your approved characters yet — the chapter outline cannot give them their chapters:'),
        h('ul', { class: 'book-items' }, s.missing_characters.map(m => h('li', { 'data-character': m.name },
          h('strong', null, m.name), h('span', { class: 'small muted' }, ` (${m.why})`), ' ',
          m.draft ? h('button', { type: 'button', class: 'small primary', onclick: () => approve([m.draft], `“${m.draft.title || m.name}”`) }, `✔ Approve “${m.draft.title || m.name}”`)
            : book.ai_ready ? h('button', { type: 'button', class: 'small ai-btn', 'data-testid': 'make-character',
              onclick: () => run(() => post('make_character', { name: m.name }), `Your AI is making “${m.name}”… (web AIs can take a few minutes)`, 'canon') }, `✨ Make “${m.name}”`)
              : h('button', { type: 'button', class: 'small', onclick: () => goNew('A01') }, '✍️ Write it myself'),
          (m.refused || []).length ? h('ul', { class: 'small' }, m.refused.map(checkItem)) : null)))));
    }
    if (s.approve && s.approve.length) {
      li.appendChild(h('ul', { class: 'book-items' }, s.approve.map(i => h('li', null, h('a', { href: simpleHref(i) }, nameEl(i)), ' ', lifecycleBadge(i.lifecycle),
        (i.problems || []).length ? [badge('⚠️', 'The checks found problems', 'b-bad'), ' ', redoBox([i])] : null,
        h('button', { type: 'button', class: 'small', onclick: () => approve([i], `“${itemName(i)}”`) }, '✔ Approve')))));
    }
    const acts = h('div', { class: 'row' });
    if (s.id === 'profile') acts.appendChild(h('button', { type: 'button', class: 'small', onclick: () => openProfileDialog(() => redraw()) }, s.state === 'done' ? 'Edit' : 'Fill in'));
    if (s.id === 'canon') {
      if (s.sheets && s.sheets.total) li.appendChild(h('p', { class: 'small', 'data-testid': 'canon-sheets' }, `🎭 ${s.sheets.complete} of ${s.sheets.total} approved character${s.sheets.total === 1 ? '' : 's'} have a character sheet and a voice card`,
        s.sheets.complete < s.sheets.total ? [' ', hazard({ code: 'CHARACTER_SHEET_MISSING' }, {}, { small: true }), ' ', h('a', { href: plink('op', 'A01') }, 'Open the characters')] : null,
        ' ', infoTip('Character sheets and voice cards', ...TIP_SHEET())));
      acts.appendChild(h('button', { type: 'button', class: 'small ai-btn', disabled: !book.ai_ready, onclick: ev => openMakeDialog('A01', null, ev.currentTarget) }, '✨ Make up characters'));
      acts.appendChild(h('button', { type: 'button', class: 'small', onclick: () => goNew('A01') }, '✍️ Write one myself'));
      acts.appendChild(h('button', { type: 'button', class: 'small', onclick: ev => openBible(ev.currentTarget) }, '📖 Bible Builder'));
      if (s.state !== 'done') {
        const note = h('div', { class: 'bb-wizard', 'aria-live': 'polite' });
        li.appendChild(note);
        bbFirst = wizardCanon(note, v => { bbPending = v; }, redraw);
      }
    }
    if (['premise', 'plot', 'outline'].includes(s.id) && s.state !== 'done' && s.state !== 'blocked') {
      if (book.ai_ready) acts.appendChild(h('button', { type: 'button', class: 'small ai-btn', onclick: () => run(() => post('create', { op: s.op }), 'Your AI is writing…', s.id) }, '✨ Let my AI draft it'));
      acts.appendChild(h('button', { type: 'button', class: 'small', onclick: () => run(() => post('create', { op: s.op, manual: true }), 'Preparing the form…', s.id) }, '✍️ Write it myself'));
      acts.appendChild(h('a', { class: 'btn small tech', href: plink('op', s.op) }, `Open ${s.op} (all fields)`));
    }
    if (s.id === 'outline' && s.state === 'done') {
      const o = S.records.find(r => r.module_id === 'B11' && r.approved_version);
      if (o) acts.appendChild(h('a', { class: 'btn small', href: plink('write', o.record_id) }, '📖 Read or change the outline'));
      if (o && o.latest_version > o.approved_version && ['DRAFT', 'VALIDATED'].includes(o.lifecycle)) {
        const w = { record_id: o.record_id, version: o.latest_version, module_id: 'B11', title: '', lifecycle: o.lifecycle };
        li.appendChild(h('div', { class: 'chapter-revision' }, badge('✎', 'Your changes wait for approval', 'b-warn'), ' ',
          h('a', { class: 'btn small', href: plink('write', o.record_id) }, '📖 Read the new version'), ' ',
          h('button', { type: 'button', class: 'small primary', onclick: () => approve([w], 'the new version of the chapter outline') }, '✔ Approve the new version')));
      }
    }
    if (s.id === 'chapters' && (s.chapters || []).length) {
      li.appendChild(h('ul', { class: 'book-items' }, s.chapters.map(c => {
        const cb = BOOK_STATE[c.state] || BOOK_STATE.blocked;
        const wc = wordsBy[c.chapter_id];
        const w = waitingRevision(c);
        return h('li', { 'data-chapter': c.chapter_id }, h('strong', null, c.name), ` — ${c.objective || c.summary}`, ' ', badge(cb[0], cb[1], cb[2]),
          wc && (wc.approved_words || wc.draft_words) ? h('span', { class: 'small muted' }, ` ${Math.max(wc.approved_words, wc.draft_words)} words `) : ' ',
          c.prose ? h('a', { class: 'btn small', href: plink('write', (w ? c.approved : c.prose).record_id) }, '📖 Read') : null,
          h('a', { class: 'btn small scenes-link', href: plink('scenes', c.chapter_id), 'data-testid': 'chapter-scenes', title: 'What each scene of this chapter is for: goals, an obstacle from the world, what stays unsaid' },
            scenesBadge(c.scenes)),
          c.scenes && (c.scenes.out_of_date || c.scenes.flagged) ? hazard({ code: c.scenes.out_of_date ? 'SCENES_OUT_OF_DATE' : 'SCENES_NOTES' }, {}, { small: true }) : null,
          w ? h('div', { class: 'chapter-revision' }, badge('✎', 'Your changes wait for approval', 'b-warn'), ' ',
            (w.problems || []).length ? [badge('⚠️', 'The checks found problems', 'b-bad'), h('ul', { class: 'small' }, w.problems.slice(0, 3).map(checkItem)), redoBox([w])] : null,
            h('a', { class: 'btn small', href: plink('write', w.record_id) }, '📖 Read the new version'), ' ',
            h('button', { type: 'button', class: 'small primary', onclick: () => approve([w], `the new version of ${c.name}`) }, '✔ Approve the new version')) : null,
          c.state !== 'done' && !(c.prose && ['DRAFT', 'VALIDATED'].includes(c.prose.lifecycle))
            ? [book.ai_ready ? h('button', { type: 'button', class: 'small ai-btn', onclick: () => run(() => planScenesThenWrite(c, post), !c.scenes || c.scenes.out_of_date ? `Your AI plans the scenes of ${c.name}, then writes it… (web AIs can take a few minutes)` : `Your AI is writing ${c.name}… (web AIs can take a few minutes)`, 'chapters') }, '✨ Write it with AI') : null,
              h('button', { type: 'button', class: 'small', onclick: () => run(() => post('write_chapter', { chapter_id: c.chapter_id, manual: true }), 'Preparing the chapter form…', 'chapters') }, '✍️ Write it myself')] : null);
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
    if (s.approve && s.approve.length > 1) acts.appendChild(h('button', { type: 'button', class: 'small', onclick: () => approve(s.approve, `these ${s.approve.length} drafts`) }, `✔ Approve all ${s.approve.length}`));
    if (s.id === 'check' && s.result) li.appendChild(h('p', { class: 'small' }, 'Result: ', badge(s.result === 'PASS' ? '✔' : '✕', s.result === 'PASS' ? 'Passed' : 'Problems found', s.result === 'PASS' ? 'b-ok' : 'b-bad')));
    if (s.id === 'export' && (s.files || []).length) {
      li.appendChild(h('div', { class: 'downloads' }, h('strong', null, '⬇ Download my book: '),
        s.files.map(f => h('button', { type: 'button', class: f.out_of_date ? 'small' : 'primary small', title: f.out_of_date ? `Made with the old title “${f.title || ''}”: export again for the new one` : null,
          onclick: () => downloadAsset(f) }, f.format, f.out_of_date ? ' (out of date)' : '')),
        s.files.some(f => f.out_of_date) ? h('p', { class: 'small notice' }, '⚠️ These files still carry the old title/author. Make the book format again and export again to update them.') : null,
        h('p', { class: 'small' }, h('a', { href: link('p', S.pid, S.branch, 'cover'), 'data-testid': 'book-cover-link' }, '🎨 Design the cover'), ' — the ebook and print covers, and these files with the cover.')));
    }
    if (acts.childNodes.length) li.appendChild(acts);
    ol.appendChild(li);
  }
  holder.appendChild(ol);
  if (book.steps.some(x => x.id === 'canon' && x.state === 'done')) holder.appendChild(bookSection4Card());
  if (book.steps.some(x => x.id === 'canon' && x.state === 'done')) holder.appendChild(bookFactsCard()); // 🔎 P26/P30/P31
  if (S.scrollToFacts) {  // the book's overview page → 🔎 Timeline, trade facts and repeats
    S.scrollToFacts = false;
    const fc = holder.querySelector('[data-testid="book-facts"]');
    if (fc) setTimeout(() => fc.scrollIntoView({ block: 'start' }), 0);
    else toast('🔎 Timeline, trade facts and repeats appears at the bottom of this page once the characters and places are done.', 6000);
  }
  holder.appendChild(bookSection5Card(book));
  if (S.pendingBookStep) {
    const want = S.pendingBookStep; S.pendingBookStep = null;
    const st = book.steps.find(x => x.id === want.id);
    if (st && st.state !== 'done') setTimeout(() => doStep(st), 0);
  }
  holder.appendChild(h('div', { class: 'row small muted book-tech' }, techToggle(),
    techBlock('Behind the scenes this uses the real steps: A01 → B01 → B03 → B11 → C01/C02 → book format (I01) → G02/G01/G05/G04/G07 → G11/G12/G13 → H05. Full release readiness (H10) is in the Quality Checks set.')));
  // book-format settings name their kind only in their data: fill those names in once known
  for (const el of holder.querySelectorAll('[data-item-name]')) {
    const i = book.steps.flatMap(st => st.approve || []).find(x => x.record_id === el.dataset.itemName);
    if (i && i.module_id === 'I01') loadItemName(i).then(n => { el.textContent = n; });
  }
}

/** The 🚀 wizard asks the AI for characters/places in a Bible Builder session: show them here until they are saved,
 * and keep watching while the AI is still busy (the note changes to "made these" by itself). onChange gets each state;
 * the returned promise is the first one. */
function wizardCanon(note, onChange, redraw) {
  let wasBusy = false;
  const check = async () => {
    let st = null;
    try {
      const r = await api('GET', `/bible-builder?project_id=${encodeURIComponent(S.pid)}&branch_id=${encodeURIComponent(S.branch)}`);
      const sess = r && r.session;
      if (sess) {
        const items = (sess.items || []).filter(i => i.status === 'done' && !i.created_ref && i.valid !== false);
        if (items.length || sess.busy) st = { busy: !!sess.busy, items };
      }
    } catch { st = wasBusy ? { busy: true, items: [] } : null; }   // the book page works without it; retry while busy
    if (!document.contains(note) && wasBusy) return st;   // the page was redrawn or left: that page watches now
    clear(note);
    if (st) {
      note.append(h('p', { class: 'small notice' },
        st.busy && !st.items.length ? [h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Your AI is still making the characters and places you asked for in the wizard…']
          : `✨ Your AI made these for you (not saved yet): ${st.items.map(i => `${i.name} (${(ITEM_NAME[i.op] || 'entry').toLowerCase()})`).join(', ')}. `,
        h('button', { type: 'button', class: 'small primary', onclick: ev => openBible(ev.currentTarget) }, '📖 Review and save them')));
    }
    if (onChange) onChange(st);
    if (st && st.busy) { wasBusy = true; setTimeout(() => { if (document.contains(note)) check(); }, 2000); }
    else if (wasBusy && !st && redraw && document.contains(note)) redraw();   // made and already saved elsewhere
    return st;
  };
  return check();
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
    onclick: ev => runTask(ct, ev.currentTarget) }, h('span', { 'aria-hidden': 'true' }, `${TASK_ICON[ct.state] || '▶'} `), plainText(ct.title) || 'Open Make my book'));
  if (ct.message) box.appendChild(h('p', { class: 'small task-msg' }, plainText(ct.message)));
  if (t.working_on) box.appendChild(h('p', { class: 'small task-working' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` ${plainText(t.working_on.title)}…`));
  if (t.book && t.book.words && t.book.words.words) {
    const w = t.book.words;
    box.appendChild(h('div', { class: 'task-words small' }, `📝 ${w.words.toLocaleString()} / ~${w.target_words.toLocaleString()} words`,
      h('progress', { max: '100', value: String(w.percent || 0), 'aria-label': `${w.percent || 0}% of the word target` })));
  }
  box.appendChild(h('p', { class: 'small muted task-ref tech' }, taskRef(ct)));
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
  return badge(b[0], b[1], b[2], rv.slot_label ? `Reviewed by ${rv.reviewer || rv.slot_label}${rv.writer ? ` · written by ${rv.writer}` : ''}${rv.independent === false ? ` — ${NOT_INDEPENDENT}` : ''}` : null);
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
        h('p', null, 'This is your standing permission for this book. Akọwe records who turned it on and when, and every automatic approval appears in Activity.')),
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
      h('p', null, 'You are approving these drafts. Approving makes them part of the book; later steps build on them. Akọwe adds an extra approval record for exactly these versions where a step needs one, because you confirm here.'),
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
  const edBtn = it.editable ? h('button', { type: 'button', class: 'small', 'data-testid': 'rv-editor', onclick: async () => {
    edBtn.disabled = true; clear(msg);
    const job = await runReviewJob(() => api('POST', bpath('/review/editor'), { body: { record_id: it.record_id } }), prog, { label: `The editor is reading “${it.title}”` });
    if (!job) { edBtn.disabled = false; return; }
    if (job.status === 'error') clear(msg).appendChild(problemBox(toProblem(job.error || { code: 'FAILED' }, { step: 'Editor review' })));
    else { const c = ((job.results || [])[0] || {}).craft; if (c) clear(msg).appendChild(stateBox(c.verdict === 'PASS' ? 'ok' : 'stale', `Editor: ${c.verdict === 'PASS' ? 'pass' : 'revise'} — ${(c.counts || {}).major || 0} major / ${(c.counts || {}).minor || 0} minor note(s)`, h('p', { class: 'small' }, h('a', { href: plink('review', 'step', it.record_id) }, 'Open it to see the notes and the editor’s fixes')))); }
    await reload(true);
  } }, '🖋 Editor review') : null;
  return h('li', { class: 'record-item rv-item', 'data-record': it.record_id },
    h('div', { class: 'r-main' },
      h('a', { class: 'r-title', href: simpleHref(it) }, plainText(it.title)),
      h('div', { class: 'r-meta' }, `${it.module_id} ${it.op_name} · v${it.version} · made by ${it.made_by.label} · ${fmtTime(it.created_at)}`),
      reviewWho(it.review, it.made_by),
      details),
    h('div', { class: 'r-badges' }, lifecycleBadge(it.lifecycle), verdictBadge(it.review), craftBadge(it.craft)),
    h('div', { class: 'row rv-buttons' },
      h('a', { class: 'btn small', href: plink('review', 'step', it.record_id) }, 'Open'),
      approveBtn,
      h('a', { class: 'btn small', href: simpleEditHref(it) }, '✏️ Edit'),
      h('button', { type: 'button', class: 'small', onclick: () => { RV.skipped.add(it.record_id); reload(false); } }, '⏭ Skip'),
      aiBtn, edBtn));
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
    h('h2', { id: 'rv-step-h', class: 'wrap-anywhere' }, plainText(it.title)),
    h('p', { class: 'row small' }, lifecycleBadge(it.lifecycle), verdictBadge(it.review), ` ${it.module_id} ${it.op_name} · v${it.version} · made by ${it.made_by.label} · ${fmtTime(it.created_at)}`),
    reviewWho(it.review, it.made_by),
    h('div', { class: 'row rv-big' }, approveBtn,
      h('button', { type: 'button', class: 'big', onclick: () => { RV.skipped.add(it.record_id); go2(it.record_id, false); } }, '⏭ Skip'),
      h('a', { class: 'btn big', href: simpleEditHref(it) }, '✏️ Edit'),
      aiBtn),
    h('div', { class: 'rv-ai-pick' }, picker.field), prog, msg,
    verdictBox(it.review, it, { onFix: fix, onEdit: () => go(simpleEditHref(it)) }),
    it.editable ? editorCard(it, { onSaved: () => stay(it.record_id) }) : null,
    h('h3', null, 'What it says'), content,
    h('p', { class: 'small' }, h('a', { href: plink('rec', it.record_id) }, 'Open the full record page (history, sources, findings)'))));
  try {
    const d = await recordDetail(it.record_id, true);
    const v = d.versions.find(x => x.version === it.version) || d.versions[d.versions.length - 1];
    const chap = v.module_id === 'C02' && v.data && typeof v.data.text === 'string' ? splitChapter(v.data.text) : null;
    clear(content).appendChild((v.representation === 'BINARY_ARTIFACT' || v.binary) ? assetView(v)
      : chap ? h('div', null, chap.title ? h('h3', null, chap.title) : null, proseBlock(chap.body)) : renderData(v.data, ''));
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
    if (rv) body.appendChild(verdictBox(rv, cur, { onEdit: () => go(simpleEditHref(cur)),
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

/* ======================================================================= 🖋 the AI editor (P4 craft review, P5 fixes, P6 patterns) */
const ED_DIMS = { subtext: 'Subtext', character_agency: 'Characters with their own goals', voice_distinction: 'Distinct voices',
  world_friction: 'Obstacles from the world', theme_restraint: 'Theme carried, not stated', prose_variety: 'Varied prose, no tics',
  tension_stakes: 'Real stakes', ending_openness: 'An ending that is earned', protected_mysteries: 'Protected mysteries kept', scene_plan: 'Scene plan kept',
  story_rules: 'Story rules kept', rules_bounded: 'Story rules bounded', planned_to_page: 'Planned but not on the page',
  trade_terms: 'Right trade and period terms', cause_effect: 'Cause and effect', timeline: 'Time, ages and order', other: 'Other' };
const ED_MIN = { gentle: 5, normal: 6, strict: 7 };
function craftBadge(c) {
  if (!c) return null;
  const pass = c.verdict === 'PASS';
  const n = (c.counts || {});
  return h('span', { 'data-testid': 'rv-craft' }, badge(pass ? '🖋' : '✎', `Editor: ${pass ? 'pass' : 'revise'}${typeof c.avg_score === 'number' ? ` · avg ${c.avg_score}` : ''}`,
    pass ? 'b-ok' : 'b-warn', `${n.major || 0} major / ${n.minor || 0} minor note(s)${c.reviewer ? ` · editor ${c.reviewer}` : ''}${c.independent === false ? ` — ${NOT_INDEPENDENT}` : ''}`));
}
function scoreBars(c) {
  const min = ED_MIN[c.strictness] || 6;
  return h('div', { class: 'ed-scores', 'data-testid': 'ed-scores', role: 'list', 'aria-label': 'Editor scores from 1 to 10' },
    Object.entries(c.scores || {}).map(([k, v]) => h('div', { class: `ed-score${v < min ? ' low' : ''}`, role: 'listitem' },
      h('span', { class: 'ed-dim' }, ED_DIMS[k] || k),
      h('span', { class: 'ed-bar', 'aria-hidden': 'true' }, h('span', { class: 'ed-fill', style: `width:${Math.max(0, Math.min(10, v)) * 10}%` })),
      h('span', { class: 'ed-num' }, `${v}/10`, v < min ? h('span', { class: 'visually-hidden' }, ' (low)') : null))));
}
function findingItem(f) {
  return h('li', { class: `ed-finding sev-${f.severity}`, 'data-finding': f.id },
    h('div', { class: 'row' }, badge(f.severity === 'major' ? '⚠️' : '•', f.severity === 'major' ? 'major' : 'minor', f.severity === 'major' ? 'b-warn' : 'b-muted'),
      h('strong', null, f.label || ED_DIMS[f.dimension] || f.dimension), tech(`#${f.id}`)),
    f.passage ? h('blockquote', { class: 'ed-quote' }, quoted(f.passage), f.found === false ? h('span', { class: 'small muted' }, ' (not found word for word in the text)') : null) : null,
    f.why ? h('p', { class: 'small' }, h('strong', null, 'Why: '), f.why) : null,
    f.suggestion ? h('p', { class: 'small' }, h('strong', null, 'Try: '), f.suggestion) : null,
    (f.keep_nearby || []).length ? h('p', { class: 'small muted' }, 'Keep nearby: ', f.keep_nearby.map(k => quoted(k)).join(' · ')) : null);
}
function patternBox(p, open = false) {
  if (!p) return null;
  const s = p.summary || {};
  const shown = (p.findings || []).filter(f => f.severity !== 'info').slice(0, 10);
  return h('details', { class: 'ed-pattern', 'data-testid': 'ed-pattern', open },
    h('summary', null, `🔎 Pattern check (no AI): ${s.major || 0} major · ${s.minor || 0} minor · ${p.words} words`),
    shown.length ? h('ul', { class: 'small' }, shown.map(f => h('li', null, badge(f.severity === 'major' ? '⚠️' : '•', f.severity, f.severity === 'major' ? 'b-warn' : 'b-muted'), ' ',
      h('strong', null, f.label), ` — ${f.detail || `${f.count}×`}`,
      (f.passages || []).length ? h('ul', null, f.passages.slice(0, 3).map(x => h('li', { class: 'muted' }, `¶${x.paragraph}: ${quoted(x.excerpt)}`))) : null,
      h('div', { class: 'muted' }, f.advice)))) : h('p', { class: 'small muted' }, 'No repeated tics above the thresholds.'));
}
function craftView(c, settings) {
  const pass = c.verdict === 'PASS';
  return h('div', { class: 'ed-craft', 'data-testid': 'ed-craft' },
    h('p', { class: 'row' }, craftBadge(c), h('span', { class: 'small muted' }, `version ${c.version} · ${fmtTime(c.at)} · strictness ${c.strictness}`)),
    h('p', { class: `small rv-who${c.independent === false ? ' not-independent' : ''}` }, `🖋 editor ${c.reviewer || c.slot_label || 'AI'}`, c.writer ? ` · written by ${c.writer}` : '',
      c.independent === false ? [' ', h('strong', { class: 'rv-warn' }, `⚠️ ${NOT_INDEPENDENT}`)] : null),
    !pass && (c.verdict_why || []).length ? h('p', { class: 'small' }, h('strong', null, 'Why it needs another look: '), c.verdict_why.join('; ')) : null,
    scoreBars(c),
    calibrationBox(c),
    (c.findings || []).length ? [h('h3', null, `What the editor would change (${c.findings.length})`), h('ol', { class: 'ed-findings', 'data-testid': 'ed-findings' }, c.findings.map(findingItem))]
      : h('p', { class: 'small' }, 'The editor has no notes on this version.'),
    (c.keep || []).length ? h('div', { class: 'ed-keep' }, h('strong', null, '✔ Keep (works well): '), h('ul', { class: 'small' }, c.keep.map(k => h('li', null, k)))) : null,
    settings && !settings.enabled ? h('p', { class: 'small muted' }, 'The editor is switched off in Settings for Make-a-book runs; you can still ask it here.') : null);
}
/** P36: how far the editor's review was trusted — re-asked, capped, two editors (lower score counts), leniency. */
function calibrationBox(c) {
  const cal = c.calibration;
  const revs = c.reviewers || [];
  if (!cal || (!(cal.notes || []).length && revs.length < 2)) return null;
  return h('div', { class: cal.flagged ? 'words-warn ed-cal' : 'small ed-cal', role: 'note', 'data-testid': 'ed-calibration' },
    h('p', null, h('strong', null, cal.flagged ? '⚠️ The editor’s review was too clean to trust' : revs.length > 1 ? `🎯 Two editors read it (${revs.map(r => r.reviewer).join(' and ')})` : '🎯 The editor was asked for proof')),
    (cal.notes || []).length ? h('ul', { class: 'small' }, cal.notes.map(n => h('li', null, n))) : null,
    revs.length ? h('details', { class: 'small' }, h('summary', null, 'Each editor’s own scores'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'rp-table' },
        h('thead', null, h('tr', null, h('th', null, 'Point'), revs.map(r => h('th', null, r.reviewer, r.flagged ? ' ⚠️' : '')),
          h('th', null, 'Counts'))),
        h('tbody', null, Object.keys(c.scores || {}).map(k => h('tr', null, h('th', { scope: 'row' }, ED_DIMS[k] || k),
          revs.map(r => h('td', { class: 'num' }, r.scores && r.scores[k] != null ? String(r.scores[k]) : '–', r.adjusted && r.scores && r.adjusted[k] !== r.scores[k] ? ` → ${r.adjusted[k]}` : '')),
          h('td', { class: 'num' }, h('strong', null, String(c.scores[k]))))))))) : null,
    revs.some(r => (r.weakest || []).length) ? h('details', { class: 'small' }, h('summary', null, 'Weakest passages the editors named'),
      h('ul', null, revs.flatMap(r => (r.weakest || []).map(w => h('li', null, quoted(w.passage), w.why ? ` — ${w.why}` : '', w.found ? '' : h('span', { class: 'muted' }, ' (not found word for word)'), h('span', { class: 'muted' }, ` (${r.reviewer})`)))))) : null);
}
/** Chapter page / review step: the editor's scores and notes for exactly this version, and its fixes. */
function editorCard(cur, { onSaved } = {}) {
  const box = h('section', { class: 'card ed-card', 'aria-labelledby': `ed-h-${cur.record_id}`, 'data-testid': 'editor-card' },
    h('h2', { id: `ed-h-${cur.record_id}` }, '🖋 Editor'));
  const body = h('div', null, loadingState('Looking for the editor’s notes…'));
  const prog = h('div', { 'aria-live': 'polite' });
  const msg = h('div', { 'aria-live': 'polite' });
  put(box, body, prog, msg);
  const draw = async () => {
    let info;
    try { info = await api('GET', bpath(`/review/editor/${encodeURIComponent(cur.record_id)}`)); }
    catch (e) { clear(body).appendChild(problemBox(toProblem(e, { book: S.project.name, step: 'Editor' }), { retry: draw })); return; }
    clear(body);
    const latest = info.latest_version;
    const c = (info.craft || {})[String(latest)];
    const startReview = async ev => {
      if (ev && ev.currentTarget) ev.currentTarget.disabled = true;
      clear(msg);
      const job = await runReviewJob(() => api('POST', bpath('/review/editor'), { body: { record_id: cur.record_id } }), prog, { label: 'The editor is reading' });
      if (!job) return;
      if (job.status === 'error') clear(msg).appendChild(problemBox(toProblem(job.error || { code: 'FAILED', message: 'The editor review did not finish' }, { book: S.project.name, step: 'Editor review' }), { retry: startReview }));
      draw();
    };
    const getFixes = async ev => {
      if (ev && ev.currentTarget) ev.currentTarget.disabled = true;
      clear(msg);
      const job = await runReviewJob(() => api('POST', bpath('/review/editor/fix'), { body: { record_id: cur.record_id } }), prog, { label: 'The writer is reworking the flagged passages' });
      if (!job) return;
      if (job.status === 'error') clear(msg).appendChild(problemBox(toProblem(job.error || { code: 'FAILED', message: 'The writer could not rework the passages' }, { book: S.project.name, step: 'Editor’s fixes' }), { retry: getFixes }));
      draw();
    };
    if (info.rewrite) body.appendChild(h('p', { class: 'notice small', 'data-testid': 'ed-made-from' }, `✍ Made from version ${info.rewrite.from_version} with the editor’s fixes (${(info.rewrite.applied || []).length} passage(s) rewritten${(info.rewrite.unresolved || []).length ? `, ${(info.rewrite.unresolved || []).length} not` : ''}).`));
    if (c) body.appendChild(craftView(c, info.settings));
    else {
      const older = Object.keys(info.craft || {}).map(Number).filter(v => v < latest).sort((a, b) => b - a)[0];
      body.appendChild(h('p', { class: 'small' }, info.editable
        ? 'A second reader for craft, not only consistency: subtext, characters with their own goals, distinct voices, obstacles from the world, theme, repeated tics, stakes and the ending. Each note quotes the exact passage. It is advice — you decide.'
        : 'The editor reads chapters, the premise, the main plot and the chapter outline.'));
      if (older) body.appendChild(h('p', { class: 'small muted' }, `The editor read version ${older}; this is version ${latest}.`));
    }
    body.appendChild(patternBox(info.pattern));
    const prop = info.proposal;
    if (prop && c) body.appendChild(fixesBox(prop, info, msg, () => draw(), onSaved));
    if (info.editable) {
      body.appendChild(h('div', { class: 'row' },
        h('button', { type: 'button', class: c ? '' : 'primary', 'data-testid': 'ed-review', onclick: startReview }, c ? '🔁 Editor review again' : '🖋 Editor review'),
        info.fixable && c && (c.findings || []).length && !prop ? h('button', { type: 'button', class: 'primary', 'data-testid': 'ed-fix', onclick: getFixes }, '✍ Apply editor’s fixes') : null,
        info.fixable && c && prop ? h('button', { type: 'button', class: 'small', onclick: getFixes }, '🔁 Ask the writer again') : null));
    }
  };
  draw();
  return box;
}
/** The writer's replacements, before → after per passage; the author ticks the ones to use. */
function fixesBox(prop, info, msg, redraw, onSaved) {
  const ok = (prop.items || []).filter(i => i.ok);
  const bad = (prop.items || []).filter(i => !i.ok);
  const boxes = {};
  const save = h('button', { type: 'button', class: 'primary', 'data-testid': 'ed-apply', disabled: !ok.length }, `💾 Save the chosen changes as a new version`);
  const sec = h('section', { class: 'ed-fixes', 'data-testid': 'ed-fixes', 'aria-label': 'The editor’s fixes' },
    h('h3', null, (prop.items || []).length && (prop.items || []).every(i => i.dimension === 'planned_to_page')
      ? `✍ Planned items worked in (by ${prop.writer || prop.slot_label || 'the writer'})` : `✍ The editor’s fixes (by ${prop.writer || prop.slot_label || 'the writer'})`),
    h('p', { class: 'small muted' }, 'Only the flagged passages change. Untick a change you do not want. Saving makes a new version for you to approve; nothing else in the chapter changes.'),
    ok.length ? h('ol', { class: 'ed-diffs' }, ok.map(i => {
      const id = uid('edfx');
      boxes[i.finding_id] = h('input', { type: 'checkbox', id, checked: true, 'data-finding': i.finding_id });
      return h('li', { class: 'ed-diff' },
        h('div', { class: 'check-row' }, boxes[i.finding_id], h('label', { for: id }, h('strong', null, `Use this change`), ` — ${ED_DIMS[i.dimension] || i.dimension || ''}${i.why ? `: ${i.why}` : ''}`)),
        h('div', { class: 'ed-before' }, h('span', { class: 'ed-tag' }, 'Before'), h('del', null, i.original)),
        h('div', { class: 'ed-after' }, h('span', { class: 'ed-tag' }, 'After'), h('ins', null, i.replacement)));
    })) : null,
    bad.length ? h('div', { class: 'words-warn', role: 'note', 'data-testid': 'ed-unresolved' }, h('span', { 'aria-hidden': 'true' }, '⚠️ '),
      h('strong', null, `${bad.length} note(s) could not be fixed word for word, so nothing was guessed there:`),
      h('ul', { class: 'small' }, bad.map(i => h('li', null, `${ED_DIMS[i.dimension] || 'Note'}${i.passage ? ` (${quoted(clipWords(i.passage, 80))})` : ''}: ${i.message || i.reason}`)))) : null,
    h('div', { class: 'row' }, save));
  save.addEventListener('click', async () => {
    const accept = Object.entries(boxes).filter(([, b]) => b.checked).map(([k]) => k);
    if (!accept.length) { clear(msg).appendChild(stateBox('failed', 'No change is ticked', h('p', null, 'Tick at least one change, or leave the chapter as it is.'))); return; }
    save.disabled = true; clear(msg).appendChild(loadingState('Saving the new version…'));
    try {
      const out = await api('POST', bpath('/review/editor/apply'), { body: { record_id: info.record_id, version: info.latest_version, accept } });
      clear(msg).appendChild(stateBox('ok', out.message, (out.keep_lost || []).length ? h('p', { class: 'words-warn' }, `⚠️ ${out.keep_lost.length} passage(s) the editor said to keep are gone.`) : null));
      toast(`Saved as version ${out.version}`);
      S.details[info.record_id] = null;
      try { await refreshRecords(); } catch { /* best effort */ }
      if (onSaved) onSaved(out); else redraw();
    } catch (e) { clear(msg).appendChild(problemBox(toProblem(e, { book: S.project.name, step: 'Editor’s fixes' }), {})); save.disabled = false; }
  });
  return sec;
}

/* ======================================================================= one-button pairing (#/pair) */
/* ======================================================================= 🎭 character sheets + voice cards (P7/P17), 🎬 scene cards (P8)
 * Companion data of a character (A01) and of an outline chapter: the server keeps them per book (review/characters,
 * review/scenes). The AI fills them; the author reads them as a card and changes them in plain forms (ⓘ explains
 * every field). Nothing here changes the character or the chapter records themselves. */
function linesOf(s) { return String(s || '').split('\n').map(x => x.trim()).filter(Boolean); }
function tipLabel(forId, label, help) {
  return h('div', { class: 'lbl-row' }, h('label', { for: forId }, label), help ? infoTip(label, h('p', null, help)) : null);
}
function madeByLine(mb, version, at) {
  if (!mb) return null;
  const who = mb.kind === 'ai' ? `your AI${mb.slot ? ` (${mb.slot})` : ''}` : mb.kind === 'ai_fix' ? 'your AI (reworked)' : 'you';
  return h('p', { class: 'small muted' }, `Version ${version || 1} · made by ${who}${at || mb.at ? ` · ${fmtWhen(at || mb.at)}` : ''}`);
}
/** Run an AI job of the review service (characters / scenes) and wait for it; returns the finished job or null. */
async function runAiJob(path, body, progressEl, label) {
  let job;
  try { job = await api('POST', bpath(path), { body: body || {} }); }
  catch (e) { clear(progressEl).appendChild(problemBox(toProblem(e, { book: S.project && S.project.name, step: label }), {}, `${label}: it could not start`)); return null; }
  const line = h('span');
  const stop = h('button', { type: 'button', class: 'small', onclick: async () => {
    stop.disabled = true; try { await api('POST', bpath(`/review/ai/${encodeURIComponent(job.job_id)}/cancel`)); } catch { /* it ends anyway */ }
  } }, 'Stop');
  clear(progressEl).appendChild(h('div', { class: 'state loading', role: 'status' }, h('p', { class: 'row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), line, stop),
    h('p', { class: 'small' }, 'Web AIs can take a few minutes. You can keep working; this keeps running.')));
  const show = j => { line.textContent = `${j.phase || label}… ${fmtClock(j.elapsed_ms || 0)}`; };
  show(job);
  while (!['done', 'error', 'cancelled'].includes(job.status)) {
    await sleep(1000);
    if (!document.contains(progressEl)) return null;   // the page changed: the job keeps running on the server
    try { job = await api('GET', bpath(`/review/ai/${encodeURIComponent(job.job_id)}`)); } catch { continue; }
    show(job);
  }
  clear(progressEl);
  if (job.status === 'error') progressEl.appendChild(problemBox(toProblem(job.error || {}, { book: S.project && S.project.name, step: label }), {}, `${label}: it did not work`));
  else if (job.status === 'cancelled') progressEl.appendChild(stateBox('empty', 'Stopped', h('p', null, 'Nothing was changed.')));
  return job.status === 'done' ? job : null;
}

const TIP_SHEET = () => [
  h('p', null, 'The character sheet says what this person wants, really needs, fears, hides and wrongly believes, what they do under pressure and what they would never say out loud.'),
  h('p', null, 'The voice card says how they talk: rhythm, register, their own words, favourite phrases, words they would never use, habits, and how their speech changes under fear, anger or grief.'),
  h('p', null, 'The writer gets the voice cards of the characters in each chapter, and the editor checks that every character sounds like themselves. Changing them here does not change the character’s approved record.')];

/** What the 🗂 Character Forge pages (forge.js) need from this file. */
function forgeUI() {
  return { h, clear, api, bpath, plink, S, crumbs, problemBox, toProblem, runAiJob, choiceDialog, toast, infoTip, route, loadingState, stateBox };
}

function characterCard(cur) {
  const rid = cur.record_id;
  const body = h('div', null, loadingState('Loading the character sheet…'));
  const msg = h('div', { 'aria-live': 'polite' });
  const prog = h('div', { 'aria-live': 'polite' });
  const card = h('section', { class: 'card char-card', 'aria-labelledby': 'cc-h', 'data-testid': 'character-card' },
    h('div', { class: 'row space' }, h('h2', { id: 'cc-h' }, '🎭 Who they are and how they talk'),
      h('div', { class: 'row' }, h('a', { class: 'btn small forge-entry', href: plink('forge', rid), 'data-testid': 'open-forge', title: 'The full Character Forge dossier: 14 sections, letters, portrait and ten reference views' }, '🗂 Character Forge'),
        infoTip('Character sheet and voice card', ...TIP_SHEET()))),
    msg, prog, body);
  let info = null;
  const load = async () => {
    try { info = await api('GET', bpath(`/review/characters/${encodeURIComponent(rid)}`)); }
    catch (e) { clear(body).appendChild(problemBox(toProblem(e, { book: S.project.name, step: 'Character sheet' }), { retry: load })); return; }
    reader();
  };
  const val = v => (v && String(v).trim()) ? v : h('span', { class: 'muted' }, '—');
  const askAI = async () => {
    if (info && info.entry) {
      const ok = await choiceDialog('Write them again with AI?', h('p', null, 'Your AI writes a new character sheet and voice card for this character. The current ones are kept in the history (the last 5 versions).'), [{ id: 'yes', label: '✨ Yes, write them again' }]);
      if (ok !== 'yes') return;
    }
    clear(msg);
    const j = await runAiJob(`/review/characters/${encodeURIComponent(rid)}/ai`, {}, prog, 'Writing the sheet and voice');
    if (j) { toast('The AI wrote the character sheet and voice card'); await load(); }
  };
  const reader = () => {
    clear(body);
    const e = info.entry;
    const F = info.fields;
    if (!e) {
      body.appendChild(stateBox('empty', 'No character sheet or voice card yet',
        h('p', null, hazard({ code: 'CHARACTER_SHEET_MISSING' }), ' Without them the writer cannot give this character their own way of talking.')));
    } else {
      const sheet = e.sheet || {}; const voice = e.voice || {};
      const sDl = h('dl', { class: 'kv char-dl' }, h('dt', null, 'Main or side character'), h('dd', null, sheet.role === 'side' ? 'Side character' : sheet.role === 'main' ? 'Main character' : val('')));
      for (const f of F.sheet) {
        if (f.key === 'own_wish' && sheet.role !== 'side' && !sheet.own_wish) continue;
        sDl.append(h('dt', null, f.label), h('dd', null, val(sheet[f.key])));
      }
      const rels = sheet.relationships || [];
      if (F.must_show) sDl.append(h('dt', null, F.must_show.label), h('dd', { 'data-testid': 'char-must-show' }, (sheet.must_show || []).length ? h('ul', { class: 'chips' }, sheet.must_show.map(x => h('li', null, x))) : val('')));
      const vDl = h('dl', { class: 'kv char-dl' });
      for (const f of F.voice_text) vDl.append(h('dt', null, f.label), h('dd', null, val(voice[f.key])));
      for (const f of F.voice_lists) {
        const items = voice[f.key] || [];
        vDl.append(h('dt', null, f.label), h('dd', null, items.length ? (f.key === 'samples'
          ? h('ul', { class: 'samples' }, items.map(x => h('li', null, h('q', null, x))))
          : h('ul', { class: 'chips' }, items.map(x => h('li', null, x)))) : val('')));
      }
      put(body, madeByLine(e.made_by, e.version, e.updated_at),
        !info.complete ? h('p', { class: 'small notice' }, hazard({ code: 'CHARACTER_SHEET_MISSING' }, {}, { small: true }), ` Still empty: ${(info.missing || []).join(', ')}.`) : null,
        h('div', { class: 'grid-2 char-grid' },
          h('section', { 'aria-label': 'Character sheet' }, h('h3', null, 'Character sheet'), sDl,
            rels.length ? [h('h4', null, 'With the other characters'), h('ul', { class: 'small rel-list' }, rels.map(r => h('li', null, h('strong', null, r.with), r.tension ? ` — tension: ${r.tension}` : '', r.history ? ` · history: ${r.history}` : '')))] : null),
          h('section', { 'aria-label': 'Voice card' }, h('h3', null, 'Voice card'), vDl)));
    }
    body.appendChild(h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: 'primary', 'data-testid': 'char-edit', onclick: editor }, info.entry ? '✏️ Change them' : '✍️ Fill them in myself'),
      h('button', { type: 'button', class: 'ai-btn', 'data-testid': 'char-ai', onclick: askAI }, info.entry ? '✨ Write them again with AI' : '✨ Write the sheet and voice with AI')));
  };
  const editor = () => {
    clear(body); clear(msg);
    const e = info.entry || {}; const sheet = e.sheet || {}; const voice = e.voice || {};
    const F = info.fields;
    const form = h('form', { novalidate: true, class: 'char-form' });
    const role = h('select', { id: 'cc-role' }, h('option', { value: '' }, '— Not decided —'),
      h('option', { value: 'main', selected: sheet.role === 'main' }, 'Main character'), h('option', { value: 'side', selected: sheet.role === 'side' }, 'Side character'));
    const ins = {};
    const fs1 = h('fieldset', { class: 'field' }, h('legend', null, 'Character sheet'),
      h('div', { class: 'field' }, tipLabel('cc-role', 'Main or side character', 'A side character gets a wish of their own that is not about the main character.'), role));
    for (const f of F.sheet) {
      const t = h('textarea', { id: `cc-s-${f.key}`, rows: '2', 'data-key': f.key }); t.value = sheet[f.key] || '';
      ins[`s:${f.key}`] = t;
      fs1.appendChild(h('div', { class: 'field' }, tipLabel(t.id, f.label, f.help), t));
    }
    let mustShow = null;
    if (F.must_show) {
      mustShow = h('textarea', { id: 'cc-s-must_show', rows: '2', 'aria-describedby': 'cc-s-must_show-h' }); mustShow.value = (sheet.must_show || []).join('\n');
      fs1.appendChild(h('div', { class: 'field' }, tipLabel(mustShow.id, F.must_show.label, F.must_show.help), mustShow, h('span', { class: 'hint', id: 'cc-s-must_show-h' }, `One per line (up to ${F.must_show.max}).`)));
    }
    const relBox = h('div', { class: 'rel-rows' });
    const relRow = r => {
      const row = h('div', { class: 'grid-3 rel-row' });
      const inputs = F.relationship.map(x => { const i = h('input', { type: 'text', 'aria-label': x.label, placeholder: x.label, 'data-k': x.key }); i.value = (r && r[x.key]) || ''; return i; });
      row.append(...inputs, h('button', { type: 'button', class: 'small link', onclick: () => row.remove() }, 'Remove'));
      relBox.appendChild(row);
    };
    (sheet.relationships || []).forEach(relRow);
    fs1.appendChild(h('div', { class: 'field' }, h('div', { class: 'lbl-row' }, h('strong', null, 'With the other main characters'),
      infoTip('Relationships', h('p', null, 'One row per other main character: their name, the tension between them, and their history.'))), relBox,
    h('button', { type: 'button', class: 'small', onclick: () => relRow(null) }, '+ Add a relationship')));
    const fs2 = h('fieldset', { class: 'field' }, h('legend', null, 'Voice card'));
    for (const f of F.voice_text) {
      const t = h('textarea', { id: `cc-v-${f.key}`, rows: '2' }); t.value = voice[f.key] || '';
      ins[`v:${f.key}`] = t;
      fs2.appendChild(h('div', { class: 'field' }, tipLabel(t.id, f.label, f.help), t));
    }
    for (const f of F.voice_lists) {
      const t = h('textarea', { id: `cc-v-${f.key}`, rows: f.key === 'samples' ? '3' : '2', 'aria-describedby': `cc-v-${f.key}-h` }); t.value = (voice[f.key] || []).join('\n');
      ins[`l:${f.key}`] = t;
      fs2.appendChild(h('div', { class: 'field' }, tipLabel(t.id, f.label, f.help), t, h('span', { class: 'hint', id: `cc-v-${f.key}-h` }, `One per line (up to ${f.max}).`)));
    }
    const err = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'primary', 'data-testid': 'char-save' }, '💾 Save');
    form.append(fs1, fs2, err, h('div', { class: 'form-actions' }, save, h('button', { type: 'button', onclick: reader }, 'Cancel')));
    form.addEventListener('submit', async ev => {
      ev.preventDefault(); clear(err);
      const s = { role: role.value };
      for (const f of F.sheet) s[f.key] = ins[`s:${f.key}`].value.trim();
      if (mustShow) s.must_show = linesOf(mustShow.value).slice(0, F.must_show.max);
      s.relationships = [...relBox.querySelectorAll('.rel-row')].map(row => Object.fromEntries([...row.querySelectorAll('input')].map(i => [i.dataset.k, i.value.trim()]))).filter(r => r.with);
      const v = {};
      for (const f of F.voice_text) v[f.key] = ins[`v:${f.key}`].value.trim();
      for (const f of F.voice_lists) v[f.key] = linesOf(ins[`l:${f.key}`].value).slice(0, f.max);
      save.disabled = true; err.appendChild(loadingState('Saving…'));
      try {
        const out = await api('PUT', bpath(`/review/characters/${encodeURIComponent(rid)}`), { body: { sheet: s, voice: v, version: e.version || 0 } });
        info.entry = out.entry; info.missing = out.missing; info.complete = out.complete;
        toast(out.message || 'Saved'); reader();
        clear(msg).appendChild(stateBox('ok', 'Saved', h('p', null, out.message || '')));
      } catch (x) {
        save.disabled = false;
        clear(err).appendChild(problemBox(toProblem(x, { book: S.project.name, step: 'Character sheet' }), {}, 'Not saved — your text is kept in the form'));
      }
    });
    body.appendChild(form);
    role.focus();
  };
  load();
  return card;
}

/* ----------------------------------------------------------------------- 🎬 scene cards */
const SOURCE_WORD = { weather: 'weather', place: 'the place', equipment: 'equipment', institution: 'an institution', rule: 'a rule', money: 'money', work: 'work', person: 'another person', other: 'other' };
function scenesBadge(sc) {
  if (!sc) return badge('🎬', 'No scene cards yet', 'b-muted');
  if (sc.out_of_date) return badge('⚠️', 'Scene cards out of date', 'b-warn');
  const n = `${sc.scenes} scene${sc.scenes === 1 ? '' : 's'}`;
  if (sc.status === 'approved') return badge('🎬', `${n} · approved${sc.flagged ? ' (checker had notes)' : ''}`, sc.flagged ? 'b-warn' : 'b-ok');
  if (sc.verdict === 'REVISE') return badge('🎬', `${n} · checker has notes`, 'b-warn');
  if (sc.verdict === 'PASS') return badge('🎬', `${n} · checked, waits for approval`, 'b-info');
  return badge('🎬', `${n} · draft, not checked`, 'b-muted');
}
function sceneCardView(c, i) {
  const goals = c.goals || [];
  return h('li', { class: 'scene-card', 'data-scene': String(i + 1) },
    h('h3', null, `Scene ${i + 1}`, c.place || c.time ? h('span', { class: 'muted small' }, ` — ${[c.place, c.time].filter(Boolean).join(', ')}`) : null),
    h('dl', { class: 'kv' },
      h('dt', null, 'Who is there'), h('dd', null, (c.characters || []).join(', ') || '—'),
      h('dt', null, 'What each one wants here'), h('dd', null, goals.length ? h('ul', null, goals.map(g => h('li', null, h('strong', null, g.character), `: ${g.goal || '—'}`,
        g.hidden_agenda ? h('span', { class: 'muted' }, ` (hides: ${g.hidden_agenda})`) : null))) : '—'),
      h('dt', null, 'What gets in the way'), h('dd', null, c.obstacle || '—', c.obstacle_source ? h('span', { class: 'muted small' }, ` (from ${SOURCE_WORD[c.obstacle_source] || c.obstacle_source})`) : null),
      h('dt', null, 'What changes by the end'), h('dd', null, c.change || '—'),
      h('dt', null, 'What stays unsaid'), h('dd', null, c.unsaid || '—'),
      h('dt', null, 'Outline beat it serves'), h('dd', null, c.beat || '—')));
}
/** The chapter page's short view of its scene cards (the full page is #/p/…/scenes/<chapter>). */
function scenesMini(cid, sc) {
  return h('section', { class: 'card scenes-mini', 'aria-labelledby': 'scm-h', 'data-testid': 'scenes-mini' },
    h('div', { class: 'row space' }, h('h2', { id: 'scm-h' }, '🎬 Scene cards'), scenesBadge(sc)),
    h('p', { class: 'small' }, sc ? 'The plan of this chapter’s scenes the writer followed: goals, an obstacle from the world, what changes and what stays unsaid. The editor checks the chapter against it.'
      : 'This chapter has no scene cards yet. Plan them before the chapter is written (again), so every character pushes for their own goal and something from the world gets in the way.'),
    sc && sc.out_of_date ? h('p', { class: 'small' }, hazard({ code: 'SCENES_OUT_OF_DATE' }, {}, { small: true }), ' Made for an older version of the outline.') : null,
    h('a', { class: 'btn small', href: plink('scenes', cid) }, sc ? '🎬 Open the scene cards' : '🎬 Plan the scenes'));
}

async function viewScenes(main, cid) {
  let info;
  try { info = await api('GET', bpath(`/review/scenes/${encodeURIComponent(cid)}`)); }
  catch (e) { main.appendChild(problemBox(toProblem(e, { book: S.project.name, step: 'Scene cards' }), { retry: () => route() }, 'Could not open the scene cards')); return; }
  const ch = info.chapter || {};
  const label = `Chapter ${ch.number || cid}`;
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [S.project.name, plink()], ['Make my book', plink('book')], `${label}: scene cards`),
    h('h1', null, `🎬 Scene cards — ${label}`)),
  h('div', { class: 'row' }, h('a', { class: 'btn small', href: plink('pictures'), 'data-testid': 'scenes-illustrate', title: 'Make a picture of this chapter or one of its scenes (🖼 Pictures)' }, '🖼 Illustrate'), infoTip('Scene cards', h('p', null, 'Before a chapter is written, its scenes are planned: for each scene the place and time, who is there, what each one wants (and hides), an obstacle from the book’s world, what changes and what stays unsaid.'),
    h('p', null, 'The chapter outline stays the plan of the whole chapter; scene cards refine it. The writer follows them and the editor checks the chapter against them.')))));
  main.appendChild(h('p', { class: 'notice small' }, h('strong', null, 'The outline says: '), plainText(ch.objective || ch.summary || '')));
  const msg = h('div', { 'aria-live': 'polite' });
  const prog = h('div', { 'aria-live': 'polite' });
  const body = h('section', { class: 'card scenes-card', 'aria-label': 'Scene cards', 'data-testid': 'scene-cards' });
  main.append(msg, prog, body);
  const reload = async () => { try { info = await api('GET', bpath(`/review/scenes/${encodeURIComponent(cid)}`)); } catch { /* keep the old view */ } reader(); };
  const plan = async revise => {
    clear(msg);
    const j = await runAiJob(`/review/scenes/${encodeURIComponent(cid)}/ai`, { revise: !!revise }, prog, revise ? 'Reworking the scenes' : 'Planning the scenes');
    if (j) { const r = (j.results || [])[0] || {}; toast(r.message || 'Scene cards made'); await reload(); }
  };
  const check = async () => {
    clear(msg);
    const j = await runAiJob(`/review/scenes/${encodeURIComponent(cid)}/check`, {}, prog, 'Checking the scenes');
    if (j) { await reload(); }
  };
  const approve = async () => {
    const e = info.entry;
    const ok = await choiceDialog('Approve these scene cards?', h('p', null, `You approve version ${e.version} of the scene cards of ${label}. The writer follows them when the chapter is written.`), [{ id: 'yes', label: '✔ Yes, I approve' }]);
    if (ok !== 'yes') return;
    try {
      const out = await api('POST', bpath(`/review/scenes/${encodeURIComponent(cid)}/approve`), { body: { author_confirms: true, version: e.version } });
      toast(out.message); await reload();
    } catch (x) { clear(msg).appendChild(problemBox(toProblem(x, { book: S.project.name, step: 'Scene cards' }), {}, 'Not approved')); }
  };
  const reader = () => {
    clear(body);
    const e = info.entry; const sm = info.summary;
    if (!e) {
      body.appendChild(stateBox('empty', 'No scene cards yet', h('p', null, 'Let your AI plan the scenes of this chapter (an independent AI then checks them), or write them yourself.')));
    } else {
      const rv = e.review && e.review.version === e.version ? e.review : null;
      put(body, h('div', { class: 'row' }, scenesBadge(sm),
        e.status === 'approved' ? h('span', { class: 'small muted' }, (e.approved || {}).how === 'run_consent' ? (e.approved.label || 'Approved under your Make-a-book consent') : 'Approved by you') : null,
        sm && sm.out_of_date ? hazard({ code: 'SCENES_OUT_OF_DATE' }) : null,
        e.flagged ? hazard({ code: 'SCENES_NOTES' }) : null),
      madeByLine(e.made_by, e.version, e.updated_at));
      if (rv) {
        body.appendChild(h('div', { class: `rv-box ${rv.verdict === 'PASS' ? 'ok' : 'warn'}`, 'data-testid': 'scene-review' },
          h('p', null, h('strong', null, rv.verdict === 'PASS' ? '✔ Checked: every scene has goals, a real obstacle and something unsaid' : '⚠️ The checker has notes'),
            h('span', { class: 'small muted' }, ` · by ${rv.reviewer || rv.slot || 'an AI'}`), rv.independent === false ? h('span', { class: 'small words-warn' }, ` ⚠️ ${rv.warning || 'the same AI planned and checked them'}`) : null),
          h('ul', { class: 'small' }, rv.scenes.map(s => h('li', null, `Scene ${s.scene}: `, s.goal ? '✔ goals' : '✕ goals', ' · ', s.obstacle_from_world ? '✔ obstacle from the world' : '✕ obstacle from the world', ' · ', s.unsaid ? '✔ something unsaid' : '✕ something unsaid',
            s.note ? h('span', { class: 'muted' }, ` — ${s.note}`) : null))),
          (rv.notes || []).length ? h('ul', { class: 'small' }, rv.notes.map(n => h('li', null, n))) : null));
      }
      if ((info.lint || []).length) body.appendChild(h('details', { class: 'small', open: info.lint.some(p => p.severity === 'major') }, h('summary', null, `Akọwe’s own check (${info.lint.length})`),
        h('ul', null, info.lint.map(p => h('li', null, p.severity === 'major' ? '⚠️ ' : '', `Scene ${p.scene}: ${p.message}`)))));
      body.appendChild(h('ol', { class: 'scene-list' }, e.cards.map(sceneCardView)));
    }
    const rvNow = e && e.review && e.review.version === e.version ? e.review : null;
    body.appendChild(h('div', { class: 'form-actions' },
      e && e.status !== 'approved' ? h('button', { type: 'button', class: 'primary', 'data-testid': 'scenes-approve', onclick: approve }, '✔ Approve these scene cards') : null,
      h('button', { type: 'button', 'data-testid': 'scenes-edit', onclick: editor }, e ? '✏️ Change them' : '✍️ Write them myself'),
      h('button', { type: 'button', class: 'ai-btn', 'data-testid': 'scenes-ai', onclick: () => plan(false) }, e ? '✨ Plan again with AI' : '✨ Plan the scenes with AI'),
      rvNow && rvNow.verdict === 'REVISE' ? h('button', { type: 'button', class: 'ai-btn', onclick: () => plan(true) }, '✨ Rework with the checker’s notes') : null,
      e ? h('button', { type: 'button', 'data-testid': 'scenes-check', onclick: check }, '🔎 Check with AI') : null,
      h('a', { class: 'btn', href: plink('book') }, '◀ Back to Make my book')));
  };
  const editor = () => {
    clear(body); clear(msg);
    const e = info.entry;
    const cards = e ? JSON.parse(JSON.stringify(e.cards)) : [{ place: '', time: '', characters: [], goals: [], obstacle: '', obstacle_source: '', change: '', unsaid: '', beat: '' }];
    const form = h('form', { novalidate: true, class: 'scenes-form' });
    const list = h('div');
    const F = Object.fromEntries((info.fields.card || []).map(f => [f.key, f]));
    const tl = (id, key) => tipLabel(id, F[key].label, F[key].help);
    const sceneBox = (c, idx) => {
      const k = `sc${idx}-${Math.random().toString(36).slice(2, 7)}`;
      const inp = (key, rows) => { const el = rows ? h('textarea', { id: `${k}-${key}`, rows: String(rows), 'data-key': key }) : h('input', { type: 'text', id: `${k}-${key}`, 'data-key': key }); el.value = c[key] || ''; return el; };
      const place = inp('place'); const time = inp('time'); const who = h('input', { type: 'text', id: `${k}-characters`, 'data-key': 'characters', list: 'scene-people' }); who.value = (c.characters || []).join(', ');
      const obstacle = inp('obstacle', 2); const change = inp('change', 2); const unsaid = inp('unsaid', 2); const beat = inp('beat', 2);
      const src = h('select', { id: `${k}-source`, 'data-key': 'obstacle_source' }, h('option', { value: '' }, '— choose —'), (info.fields.sources || []).map(s => h('option', { value: s, selected: c.obstacle_source === s }, SOURCE_WORD[s] || s)));
      const goalsBox = h('div', { class: 'goal-rows' });
      const goalRow = g => {
        const row = h('div', { class: 'grid-3 goal-row' });
        const a = h('input', { type: 'text', 'aria-label': 'Character', placeholder: 'Character', 'data-k': 'character', list: 'scene-people' }); a.value = (g && g.character) || '';
        const b = h('input', { type: 'text', 'aria-label': 'Their goal in this scene', placeholder: 'Their goal here', 'data-k': 'goal' }); b.value = (g && g.goal) || '';
        const cc = h('input', { type: 'text', 'aria-label': 'Hidden agenda', placeholder: 'What they hide / really want', 'data-k': 'hidden_agenda' }); cc.value = (g && g.hidden_agenda) || '';
        row.append(a, b, cc, h('button', { type: 'button', class: 'small link', onclick: () => row.remove() }, 'Remove'));
        goalsBox.appendChild(row);
      };
      (c.goals || []).forEach(goalRow);
      if (!(c.goals || []).length) goalRow(null);
      const fs = h('fieldset', { class: 'field scene-edit' }, h('legend', null, `Scene ${idx + 1}`),
        h('div', { class: 'grid-2' }, h('div', { class: 'field' }, tl(place.id, 'place'), place), h('div', { class: 'field' }, tl(time.id, 'time'), time)),
        h('div', { class: 'field' }, tl(who.id, 'characters'), who, h('span', { class: 'hint' }, 'Names, separated by commas.')),
        h('div', { class: 'field' }, h('div', { class: 'lbl-row' }, h('strong', null, F.goals.label), infoTip(F.goals.label, h('p', null, F.goals.help))), goalsBox,
          h('button', { type: 'button', class: 'small', onclick: () => goalRow(null) }, '+ Add a character’s goal')),
        h('div', { class: 'field' }, tl(obstacle.id, 'obstacle'), obstacle), h('div', { class: 'field' }, tl(src.id, 'obstacle_source'), src),
        h('div', { class: 'field' }, tl(change.id, 'change'), change), h('div', { class: 'field' }, tl(unsaid.id, 'unsaid'), unsaid),
        h('div', { class: 'field' }, tl(beat.id, 'beat'), beat),
        h('button', { type: 'button', class: 'small link', onclick: () => { fs.remove(); renumber(); } }, 'Remove this scene'));
      fs.collect = () => ({ place: place.value.trim(), time: time.value.trim(), characters: who.value.split(',').map(x => x.trim()).filter(Boolean),
        goals: [...goalsBox.querySelectorAll('.goal-row')].map(r => Object.fromEntries([...r.querySelectorAll('input')].map(i => [i.dataset.k, i.value.trim()]))).filter(g => g.character && (g.goal || g.hidden_agenda)),
        obstacle: obstacle.value.trim(), obstacle_source: src.value, change: change.value.trim(), unsaid: unsaid.value.trim(), beat: beat.value.trim() });
      return fs;
    };
    const renumber = () => [...list.children].forEach((fs, i) => { const lg = fs.querySelector('legend'); if (lg) lg.textContent = `Scene ${i + 1}`; });
    cards.forEach((c, i) => list.appendChild(sceneBox(c, i)));
    const err = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'primary', 'data-testid': 'scenes-save' }, '💾 Save the scene cards');
    form.append(h('datalist', { id: 'scene-people' }, (info.characters || []).map(n => h('option', { value: n }))), list,
      h('button', { type: 'button', class: 'small', onclick: () => { if (list.children.length >= 6) { toast('At most 6 scenes'); return; } list.appendChild(sceneBox({}, list.children.length)); } }, '+ Add a scene'),
      err, h('div', { class: 'form-actions' }, save, h('button', { type: 'button', onclick: reader }, 'Cancel')));
    form.addEventListener('submit', async ev => {
      ev.preventDefault(); clear(err);
      const out = [...list.children].map(fs => fs.collect());
      if (!out.length) { err.appendChild(stateBox('failed', 'No scene', h('p', null, 'Add at least one scene.'))); return; }
      save.disabled = true; err.appendChild(loadingState('Saving…'));
      try {
        const r = await api('PUT', bpath(`/review/scenes/${encodeURIComponent(cid)}`), { body: { cards: out, version: e ? e.version : 0 } });
        toast(r.message); await reload();
      } catch (x) { save.disabled = false; clear(err).appendChild(problemBox(toProblem(x, { book: S.project.name, step: 'Scene cards' }), {}, 'Not saved — your text is kept in the form')); }
    });
    body.appendChild(form);
    const f = firstFocusable(form); if (f) f.focus();
  };
  reader();
}
/** Book page: plan the chapter's scenes with the AI first (no check), then write it. A plan that fails never stops
 * the chapter: it is written from the outline. */
async function planScenesThenWrite(c, post) {
  if (!c.scenes || c.scenes.out_of_date) {
    try {
      let job = await api('POST', bpath(`/review/scenes/${encodeURIComponent(c.chapter_id)}/ai`), { body: { check: false } });
      while (!['done', 'error', 'cancelled'].includes(job.status)) {
        await sleep(1000);
        try { job = await api('GET', bpath(`/review/ai/${encodeURIComponent(job.job_id)}`)); } catch { /* try again */ }
      }
      if (job.status !== 'done') noteClientError((job.error || {}).code || 'SCENES_FAILED', 'scene cards', (job.error || {}).message || 'not planned');
    } catch (e) { noteClientError('SCENES_FAILED', 'scene cards', (e && e.message) || String(e)); }
  }
  return post('write_chapter', { chapter_id: c.chapter_id });
}

/* ======================================================================= Section 4: 🎚️ ending and style (P12),
 * 📏 story rules (P9), 🧺 world texture (P10), ✅ planned to page (P11).
 * Choices live in the book profile; rules, texture and planned checks are companion data of the book on the server
 * (review/world, review/planned). The AI drafts; the author reads, changes, accepts or rejects. */
const CH = { info: null };
async function loadChoicesInfo() {
  if (!CH.info) { try { CH.info = await api('GET', '/story-choices'); } catch { CH.info = null; } }
  return CH.info;
}
function choiceWord(key, value) {
  const c = ((CH.info || {}).choices || []).find(x => x.key === key);
  const o = c && c.options.find(x => x.value === value);
  return o ? o.label : value;
}
/** The effective ending-state matrix of a choice set (same rules as story_choices.matrix on the server). */
function effectiveMatrix(ch) {
  const info = CH.info; if (!info || !ch) return {};
  const out = Object.assign({}, (info.presets || {})[ch.ending] || {});
  if (ch.explain) out.mystery = (info.explain_to_mystery || {})[ch.explain];
  Object.assign(out, ch.matrix || {});
  return out;
}
function choicesSummary(ch) {
  ch = ch || {};
  const info = CH.info;
  const out = [];
  for (const c of (info && info.choices) || []) if (ch[c.key]) out.push(`${c.label}: ${choiceWord(c.key, ch[c.key])}`);
  if (!info) for (const [k, v] of Object.entries(ch)) if (typeof v === 'string') out.push(`${k}: ${v}`);
  if (ch.matrix && Object.keys(ch.matrix).length) out.push(`Ending options changed: ${Object.entries(ch.matrix).map(([r, v]) => `${r.replace(/_/g, ' ')} ${v}`).join(', ')}`);
  return out;
}
/** Ending and style choices as form fields (🚀 wizard, profile dialog, ⚡ quick settings). Everything defaults to
 * "Let the AI choose"; "More ending options" edits single rows of the ending-state matrix. */
function choicesFields(cur, prefix) {
  cur = cur || {};
  const info = CH.info;
  if (!info) return { el: h('p', { class: 'small muted' }, 'The ending and style choices could not be loaded (reload the page to try again).'), get: () => cur };
  const sel = {};
  const field = c => {
    const id = `${prefix}-ch-${c.key}`;
    const s = h('select', { id, 'data-choice': c.key }, h('option', { value: '' }, 'Let the AI choose'),
      c.options.map(o => h('option', { value: o.value, selected: cur[c.key] === o.value }, o.label)));
    sel[c.key] = s;
    return h('div', { class: 'field' }, tipLabel(id, c.label, `${c.help} ${c.options.map(o => `${o.label}: ${o.about}.`).join(' ')}`), s);
  };
  const main = info.choices.slice(0, 3).map(field);
  const style = info.choices.slice(3).map(field);
  const mx = {};
  const preview = h('p', { class: 'small muted', 'data-testid': `${prefix}-matrix-preview` });
  const mrows = info.matrix.map(r => {
    const id = `${prefix}-mx-${r.key}`;
    const s = h('select', { id, 'data-row': r.key }, h('option', { value: '' }, 'From the ending choice'),
      r.values.map(v => h('option', { value: v, selected: (cur.matrix || {})[r.key] === v }, v)));
    mx[r.key] = s;
    return h('div', { class: 'field' }, tipLabel(id, r.label, r.help), s);
  });
  const get = () => {
    const out = {};
    for (const [k, s] of Object.entries(sel)) if (s.value) out[k] = s.value;
    const m = {};
    for (const [k, s] of Object.entries(mx)) if (s.value) m[k] = s.value;
    if (Object.keys(m).length) out.matrix = m;
    return out;
  };
  const showPreview = () => {
    const m = effectiveMatrix(get());
    preview.textContent = Object.keys(m).length ? `The ending will be: ${Object.entries(m).map(([r, v]) => `${r.replace(/_/g, ' ')} ${v}`).join(' · ')}`
      : 'No ending chosen: the AI decides how the story ends.';
  };
  const el = h('fieldset', { class: 'field choices-box', 'data-testid': `${prefix}-choices` },
    h('legend', null, '🎚️ Ending and style (optional)'),
    h('p', { class: 'small muted' }, 'All optional — “Let the AI choose” leaves it to the story. The AI follows what you choose when it plans and writes, and the editor checks the ending against it.'),
    h('div', { class: 'grid-3' }, main),
    h('details', { class: 'style-knobs' }, h('summary', null, 'Style: dialogue, pace, humor'), h('div', { class: 'grid-3' }, style)),
    h('details', { class: 'more-ending', 'data-testid': `${prefix}-more-ending` }, h('summary', null, 'More ending options'),
      h('p', { class: 'small muted' }, 'How the ending leaves each part of the story. Each simple choice above sets these; change a single row here if you want something else.'),
      h('div', { class: 'grid-3' }, mrows), preview));
  el.addEventListener('change', showPreview);
  showPreview();
  return { el, get };
}

/* ----------------------------------------------------------------------- 📏 story rules + 🧺 world texture page */
const RULE_ICON = { hard_rule: '⚖️', seen: '👁️', belief: '🙏', mystery: '❔' };
const KIND_ICON = { work: '🛠️', weather: '🌊', institution: '🏛️', people: '🧑', economy: '💰' };
const CAUSE_WORD = { obstacle: 'gets in the way', skill: 'shows skill', cost: 'costs something' };
async function viewWorld(main) {
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [S.project.name, plink()], ['Make my book', plink('book')], 'Story rules and world'),
    h('h1', null, '🌍 Story rules and world')),
  h('div', { class: 'row' }, infoTip('Story rules and world',
    h('p', null, 'The story rules say what is law in this book’s world (a hard rule), what people have only seen happen, what characters believe, and which mysteries must stay unexplained — each with its limits.'),
    h('p', null, 'The world texture lists concrete details of work, weather, institutions, local people and money, each with what it can cause. Scene plans take their obstacles from it; a detail is used only if it causes something, shows skill or gets in the way.'),
    h('p', null, 'The writer, the editor and the reviewers get them. Changing them here never changes your approved records.')))));
  const msg = h('div', { 'aria-live': 'polite' });
  const prog = h('div', { 'aria-live': 'polite' });
  const rulesBox = h('section', { class: 'card world-card', 'aria-labelledby': 'wr-h', 'data-testid': 'rules-card' });
  const texBox = h('section', { class: 'card world-card', 'aria-labelledby': 'wt-h', 'data-testid': 'texture-card' });
  main.append(msg, prog, rulesBox, texBox);
  let info;
  const where = { book: S.project.name, step: 'Story rules and world' };
  const load = async () => {
    try { info = await api('GET', bpath('/review/world')); }
    catch (e) { clear(msg).appendChild(problemBox(toProblem(e, where), { retry: load }, 'Could not load the story rules')); return; }
    drawRules(); drawTexture();
  };
  const ai = async (what, body, label) => {
    clear(msg);
    const j = await runAiJob(`/review/world/${what}/ai`, body || {}, prog, label);
    if (j) { toast(((j.results || [])[0] || {}).message || 'Done'); await load(); }
  };
  /* --- rules */
  const drawRules = () => {
    const e = info.rules; const F = info.fields.rules;
    const catLabel = Object.fromEntries(F.categories.map(c => [c.key, c.label]));
    const lintBy = {};
    for (const p of info.rules_lint || []) (lintBy[p.rule] = lintBy[p.rule] || []).push(p);
    clear(rulesBox).appendChild(h('div', { class: 'row space' }, h('h2', { id: 'wr-h' }, '📏 Story rules'),
      infoTip('Story rules', ...F.categories.map(c => h('p', null, h('strong', null, `${RULE_ICON[c.key]} ${c.label}: `), c.help)))));
    if (!e) {
      rulesBox.appendChild(stateBox('empty', 'No story rules yet', h('p', null, 'Let your AI draft them from your characters, places and plan, or write them yourself.')));
    } else {
      rulesBox.appendChild(madeByLine(e.made_by, e.version, e.updated_at));
      if ((info.rules_changed || []).length) rulesBox.appendChild(h('p', { class: 'notice small', 'data-testid': 'rules-changed' }, hazard({ code: 'RULES_OUT_OF_DATE' }, {}, { small: true }),
        ` Changed since they were made: ${info.rules_changed.join(', ')}. `, info.ai_ready ? h('button', { type: 'button', class: 'small ai-btn', onclick: () => ai('rules', { update: true }, 'Suggesting updates') }, '✨ Suggest updates') : null));
      if (info.mystery_mode) rulesBox.appendChild(h('p', { class: 'small muted' }, `Your book profile says the mysteries are ${info.mystery_mode === 'protected' ? 'left unexplained (protected)' : info.mystery_mode === 'explained' ? 'explained by the end' : 'hinted at, never fully explained'}.`));
      for (const c of F.categories) {
        const rs = (e.rules || []).filter(r => r.category === c.key);
        if (!rs.length) continue;
        rulesBox.appendChild(h('h3', { class: 'rule-cat' }, `${RULE_ICON[c.key]} ${c.label}`, ' ', infoTip(c.label, h('p', null, c.help))));
        rulesBox.appendChild(h('ul', { class: 'rule-list' }, rs.map(r => h('li', { class: `rule rule-${r.category}${r.status === 'retired' ? ' retired' : ''}`, 'data-rule': r.id },
          h('p', null, h('strong', null, r.text), r.status === 'retired' ? h('span', { class: 'muted small' }, ' (retired)') : null,
            (lintBy[r.id] || []).map(p => [' ', hazard({ code: 'RULE_NOT_BOUNDED', message: p.message }, {}, { small: true })])),
          h('p', { class: 'small' }, h('span', { class: 'muted' }, 'Limits: '), r.scope || h('em', { class: 'muted' }, 'none stated'),
            r.stated_by ? [h('span', { class: 'muted' }, ' · stated by '), r.stated_by] : null, r.source ? [h('span', { class: 'muted' }, ' · from '), r.source] : null)))));
      }
      const props = (e.proposals || {}).items || [];
      if (props.length) rulesBox.appendChild(proposalBox(e, props, catLabel));
    }
    rulesBox.appendChild(h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: e ? '' : 'primary', 'data-testid': 'rules-edit', onclick: rulesForm }, e ? '✏️ Change them' : '✍️ Write them myself'),
      info.ai_ready ? h('button', { type: 'button', class: 'ai-btn', 'data-testid': 'rules-ai', onclick: () => ai('rules', { update: !!e }, e ? 'Suggesting updates' : 'Drafting the story rules') }, e ? '✨ Suggest updates with AI' : '✨ Draft with AI') : null));
  };
  const proposalBox = (e, props, catLabel) => {
    const boxes = {};
    const act = { add: '➕ New rule', change: '✏️ Change', retire: '🗄 Retire' };
    const box = h('section', { class: 'rule-proposals', 'data-testid': 'rule-proposals' }, h('h3', null, `✨ Suggested updates (${props.length})`),
      h('p', { class: 'small muted' }, 'The AI compared the rules with your current characters and plan. Tick what to use; nothing changes until you press the button.'),
      h('ol', null, props.map(p => {
        const id = uid('rp');
        boxes[p.id] = h('input', { type: 'checkbox', id, checked: true, 'data-proposal': p.id });
        return h('li', { class: 'check-row' }, boxes[p.id], h('label', { for: id }, h('strong', null, act[p.action] || p.action), ` · ${catLabel[p.rule.category] || p.rule.category}: ${p.rule.text}`,
          p.rule.scope ? h('span', { class: 'small muted' }, ` (limits: ${p.rule.scope})`) : null));
      })));
    const decide = async all => {
      const ids = Object.entries(boxes).filter(([, b]) => all === false ? false : b.checked).map(([k]) => k);
      try {
        const out = await api('POST', bpath('/review/world/rules/proposals'), { body: { author_confirms: true, version: e.version, accept: ids, reject: Object.keys(boxes).filter(k => !ids.includes(k)) } });
        toast(out.message); await load();
      } catch (x) { clear(msg).appendChild(problemBox(toProblem(x, where), {}, 'Not changed')); }
    };
    box.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary small', 'data-testid': 'rules-accept', onclick: () => decide(true) }, '✔ Use the ticked suggestions'),
      h('button', { type: 'button', class: 'small', onclick: () => decide(false) }, '✖ Reject them all')));
    return box;
  };
  const rulesForm = () => {
    const e = info.rules; const F = info.fields.rules;
    clear(rulesBox).appendChild(h('h2', { id: 'wr-h' }, '📏 Story rules — change them'));
    const list = h('div', { class: 'rule-rows' });
    const FL = Object.fromEntries(F.fields.map(f => [f.key, f]));
    const row = r => {
      const k = uid('rr');
      const cat = h('select', { id: `${k}-cat`, 'data-k': 'category' }, F.categories.map(c => h('option', { value: c.key, selected: (r || {}).category === c.key }, `${RULE_ICON[c.key]} ${c.label}`)));
      const t = h('textarea', { id: `${k}-text`, rows: '2', 'data-k': 'text' }); t.value = (r || {}).text || '';
      const sc = h('textarea', { id: `${k}-scope`, rows: '2', 'data-k': 'scope' }); sc.value = (r || {}).scope || '';
      const so = h('input', { type: 'text', id: `${k}-source`, 'data-k': 'source' }); so.value = (r || {}).source || '';
      const sb = h('input', { type: 'text', id: `${k}-stated_by`, 'data-k': 'stated_by' }); sb.value = (r || {}).stated_by || '';
      const st = h('select', { id: `${k}-status`, 'data-k': 'status' }, h('option', { value: 'active', selected: (r || {}).status !== 'retired' }, 'In use'), h('option', { value: 'retired', selected: (r || {}).status === 'retired' }, 'Retired (kept for history)'));
      const fs = h('fieldset', { class: 'field rule-edit', 'data-id': (r || {}).id || '' }, h('legend', null, 'Rule'),
        h('div', { class: 'grid-2' }, h('div', { class: 'field' }, tipLabel(cat.id, 'Kind of rule', F.categories.map(c => `${c.label}: ${c.help}`).join(' ')), cat),
          h('div', { class: 'field' }, tipLabel(st.id, 'Status', 'Retired rules are kept for history but not used.'), st)),
        h('div', { class: 'field' }, tipLabel(t.id, FL.text.label, FL.text.help), t),
        h('div', { class: 'field' }, tipLabel(sc.id, FL.scope.label, FL.scope.help), sc),
        h('div', { class: 'grid-2' }, h('div', { class: 'field' }, tipLabel(so.id, FL.source.label, FL.source.help), so),
          h('div', { class: 'field' }, tipLabel(sb.id, FL.stated_by.label, FL.stated_by.help), sb)),
        h('button', { type: 'button', class: 'small link', onclick: () => fs.remove() }, 'Remove this rule'));
      fs.collect = () => Object.assign({ id: fs.dataset.id }, Object.fromEntries([...fs.querySelectorAll('[data-k]')].map(x => [x.dataset.k, x.value.trim()])));
      list.appendChild(fs);
    };
    ((e && e.rules) || []).forEach(row);
    if (!list.children.length) row({ category: 'hard_rule' });
    const err = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'primary', 'data-testid': 'rules-save' }, '💾 Save the story rules');
    const form = h('form', { novalidate: true }, list, h('button', { type: 'button', class: 'small', onclick: () => row({ category: 'hard_rule' }) }, '+ Add a rule'), err,
      h('div', { class: 'form-actions' }, save, h('button', { type: 'button', onclick: drawRules }, 'Cancel')));
    form.addEventListener('submit', async ev => {
      ev.preventDefault(); clear(err);
      const rules = [...list.children].map(fs => fs.collect()).filter(r => r.text);
      if (!rules.length) { err.appendChild(stateBox('failed', 'No rule', h('p', null, 'Write at least one rule.'))); return; }
      save.disabled = true; err.appendChild(loadingState('Saving…'));
      try { const out = await api('PUT', bpath('/review/world/rules'), { body: { rules, version: e ? e.version : 0 } }); toast(out.message); await load(); }
      catch (x) { save.disabled = false; clear(err).appendChild(problemBox(toProblem(x, where), {}, 'Not saved — your text is kept in the form')); }
    });
    rulesBox.appendChild(form);
    const f = firstFocusable(form); if (f) f.focus();
  };
  /* --- texture */
  const drawTexture = () => {
    const e = info.texture; const F = info.fields.texture;
    const usage = {}; for (const u of ((info.texture_usage || {}).items || [])) usage[u.id] = u;
    const probs = {}; for (const p of info.texture_problems || []) probs[p.item] = p;
    clear(texBox).appendChild(h('div', { class: 'row space' }, h('h2', { id: 'wt-h' }, '🧺 World texture'),
      infoTip('World texture', h('p', null, 'Concrete details of this world, each with what it can cause: an obstacle (it gets in the way), a skill moment, or a cost.'),
        h('p', null, 'Scene plans take their obstacles from this list; the writer gets a few per chapter; Akọwe counts how often each detail is on the page.'))));
    if (!e) {
      texBox.appendChild(stateBox('empty', 'No world details yet', h('p', null, 'Let your AI draft them from your places, world and characters, or add them yourself.')));
    } else {
      const tu = info.texture_usage;
      put(texBox, madeByLine(e.made_by, e.version, e.updated_at),
        tu ? h('p', { class: 'small', 'data-testid': 'texture-usage' }, `In the chapters so far: ${tu.used} of ${tu.items.length} detail(s) used`, tu.unused ? `, ${tu.unused} never used` : '', tu.overused ? `, ⚠️ ${tu.overused} used too often` : '', '.') : null);
      for (const k of F.kinds) {
        const items = (e.items || []).filter(i => i.kind === k.key);
        if (!items.length) continue;
        texBox.appendChild(h('h3', null, `${KIND_ICON[k.key] || '•'} ${k.label}`, ' ', infoTip(k.label, h('p', null, k.help))));
        texBox.appendChild(h('ul', { class: 'texture-list' }, items.map(i => {
          const u = usage[i.id];
          return h('li', { 'data-item': i.id }, h('strong', null, i.detail), ' ', badge(i.causes === 'obstacle' ? '🚧' : i.causes === 'skill' ? '🛠️' : '💸', CAUSE_WORD[i.causes] || i.causes, 'b-info'),
            i.effect ? h('span', { class: 'small' }, ` — ${i.effect}`) : null,
            probs[i.id] ? [' ', hazard({ code: 'INVALID_INPUT', message: probs[i.id].message }, {}, { small: true })] : null,
            u ? h('span', { class: 'small muted' }, u.used ? ` · on the page ${u.count}× (${u.chapters.join(', ')})` : ' · not used yet') : null,
            u && !u.used && tu && tu.words > 0 ? [' ', hazard({ code: 'TEXTURE_UNUSED' }, {}, { small: true })] : null,
            u && u.overused ? [' ', hazard({ code: 'TEXTURE_OVERUSED' }, {}, { small: true })] : null);
        })));
      }
    }
    texBox.appendChild(h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: e ? '' : 'primary', 'data-testid': 'texture-edit', onclick: textureForm }, e ? '✏️ Change them' : '✍️ Add them myself'),
      info.ai_ready ? h('button', { type: 'button', class: 'ai-btn', 'data-testid': 'texture-ai', onclick: () => ai('texture', {}, 'Drafting the world texture') }, e ? '✨ Draft again with AI' : '✨ Draft with AI') : null));
  };
  const textureForm = () => {
    const e = info.texture; const F = info.fields.texture;
    const FL = Object.fromEntries(F.fields.map(f => [f.key, f]));
    clear(texBox).appendChild(h('h2', { id: 'wt-h' }, '🧺 World texture — change it'));
    const list = h('div');
    const row = it => {
      const k = uid('tx');
      const kind = h('select', { id: `${k}-kind`, 'data-k': 'kind' }, F.kinds.map(x => h('option', { value: x.key, selected: (it || {}).kind === x.key }, `${KIND_ICON[x.key]} ${x.label}`)));
      const causes = h('select', { id: `${k}-causes`, 'data-k': 'causes' }, F.causes.map(x => h('option', { value: x.key, selected: (it || {}).causes === x.key }, x.label)));
      const d = h('textarea', { id: `${k}-detail`, rows: '2', 'data-k': 'detail' }); d.value = (it || {}).detail || '';
      const ef = h('textarea', { id: `${k}-effect`, rows: '2', 'data-k': 'effect' }); ef.value = (it || {}).effect || '';
      const w = h('input', { type: 'text', id: `${k}-words`, 'data-k': 'words' }); w.value = ((it || {}).words || []).join(', ');
      const fs = h('fieldset', { class: 'field texture-edit', 'data-id': (it || {}).id || '' }, h('legend', null, 'Detail'),
        h('div', { class: 'grid-2' }, h('div', { class: 'field' }, tipLabel(kind.id, 'Kind', F.kinds.map(x => `${x.label}: ${x.help}`).join(' ')), kind),
          h('div', { class: 'field' }, tipLabel(causes.id, 'What it does in a scene', 'Gets in the way (an obstacle), shows someone’s skill, or costs something (time, money, pride, a relationship).'), causes)),
        h('div', { class: 'field' }, tipLabel(d.id, FL.detail.label, FL.detail.help), d),
        h('div', { class: 'field' }, tipLabel(ef.id, FL.effect.label, FL.effect.help), ef),
        h('div', { class: 'field' }, tipLabel(w.id, FL.words.label, FL.words.help), w),
        h('button', { type: 'button', class: 'small link', onclick: () => fs.remove() }, 'Remove this detail'));
      fs.collect = () => { const o = Object.fromEntries([...fs.querySelectorAll('[data-k]')].map(x => [x.dataset.k, x.value.trim()])); o.words = o.words.split(',').map(x => x.trim()).filter(Boolean); o.id = fs.dataset.id; return o; };
      list.appendChild(fs);
    };
    ((e && e.items) || []).forEach(row);
    if (!list.children.length) row({ kind: 'work', causes: 'obstacle' });
    const err = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'primary', 'data-testid': 'texture-save' }, '💾 Save the world texture');
    const form = h('form', { novalidate: true }, list, h('button', { type: 'button', class: 'small', onclick: () => row({ kind: 'work', causes: 'obstacle' }) }, '+ Add a detail'), err,
      h('div', { class: 'form-actions' }, save, h('button', { type: 'button', onclick: drawTexture }, 'Cancel')));
    form.addEventListener('submit', async ev => {
      ev.preventDefault(); clear(err);
      const items = [...list.children].map(fs => fs.collect()).filter(i => i.detail);
      if (!items.length) { err.appendChild(stateBox('failed', 'No detail', h('p', null, 'Add at least one detail.'))); return; }
      save.disabled = true; err.appendChild(loadingState('Saving…'));
      try { const out = await api('PUT', bpath('/review/world/texture'), { body: { items, version: e ? e.version : 0 } }); toast(out.message); await load(); }
      catch (x) { save.disabled = false; clear(err).appendChild(problemBox(toProblem(x, where), {}, 'Not saved — your text is kept in the form')); }
    });
    texBox.appendChild(form);
    const f = firstFocusable(form); if (f) f.focus();
  };
  rulesBox.appendChild(loadingState('Loading the story rules…'));
  await load();
}

/* ----------------------------------------------------------------------- ✅ planned to page */
const PLANNED_ICON = { on_page: '✔', unclear: '❓', missing: '⚠️' };
/** The chapter page's checklist: what the plan says must reach the page, and whether it did. */
function plannedCard(rid, { onSaved } = {}) {
  const box = h('section', { class: 'card planned-card', 'aria-labelledby': `pl-h-${rid}`, 'data-testid': 'planned-card' },
    h('div', { class: 'row space' }, h('h2', { id: `pl-h-${rid}` }, '✅ Planned to page'),
      infoTip('Planned to page', h('p', null, 'What the plan says must reach the reader in this chapter: the outline beat, each scene’s obstacle and change, the point-of-view character’s name (in their first chapter) and the “must show” details of the character sheets.'),
        h('p', null, 'Akọwe first looks for the words; then an AI that did not write the chapter checks what is unclear. ✨ Fix with AI asks the writer to work only the missing items into the right passages — you choose what to keep.'))));
  const body = h('div', null, loadingState('Checking what was planned…'));
  const prog = h('div', { 'aria-live': 'polite' });
  const msg = h('div', { 'aria-live': 'polite' });
  put(box, body, prog, msg);
  const where = { book: S.project.name, step: 'Planned to page' };
  const draw = async () => {
    let info;
    try { info = await api('GET', bpath(`/review/planned/${encodeURIComponent(rid)}`)); }
    catch (e) { clear(body).appendChild(problemBox(toProblem(e, where), { retry: draw })); return; }
    const items = (info.stored && info.stored.items) || info.items;
    const c = (info.stored && info.stored.counts) || info.counts;
    const open = items.filter(i => i.required && i.status !== 'on_page');
    clear(body).appendChild(h('p', { class: 'small', 'data-testid': 'planned-summary' }, open.length
      ? [hazard({ code: 'PLANNED_MISSING' }, {}, { small: true }), ` ${open.length} planned item(s) are not on the page (version ${info.version}).`]
      : `✔ Everything required is on the page (${c.on_page} of ${c.items} item(s) found).`,
    info.stored && info.stored.ai ? h('span', { class: 'muted' }, ` Checked by ${info.stored.ai.reviewer || 'an AI'}.`) : h('span', { class: 'muted' }, ' Akọwe’s word check (no AI yet).'),
    info.stored && info.stored.ai && info.stored.ai.independent === false ? h('span', { class: 'words-warn' }, ` ⚠️ ${info.stored.ai.warning}`) : null));
    body.appendChild(h('ul', { class: 'planned-list' }, items.map(i => h('li', { class: `pl-${i.status}${i.required ? '' : ' optional'}`, 'data-status': i.status },
      h('span', { 'aria-hidden': 'true' }, PLANNED_ICON[i.status] || '•'), ' ', i.label,
      i.required ? null : h('span', { class: 'small muted' }, ' (nice to have)'),
      i.status !== 'on_page' && i.required ? [' ', hazard({ code: 'PLANNED_MISSING', message: i.label }, {}, { small: true })] : null,
      i.quote ? h('span', { class: 'small muted' }, ` — ${quoted(clipWords(i.quote, 90))}`) : null))));
    let edInfo = null;
    try { edInfo = await api('GET', bpath(`/review/editor/${encodeURIComponent(rid)}`)); } catch { /* no fixes to show */ }
    const prop = edInfo && edInfo.proposal && (edInfo.proposal.items || []).some(x => x.dimension === 'planned_to_page') ? edInfo.proposal : null;
    if (prop && (prop.items || []).some(x => x.ok)) body.appendChild(fixesBox(prop, edInfo, msg, () => draw(), onSaved));
    else if (prop) body.appendChild(h('p', { class: 'small muted', 'data-testid': 'planned-last-try' }, hazard({ code: 'PLANNED_UNRESOLVED' }, {}, { small: true }),
      ` The writer’s last attempt (${fmtWhen(prop.at)}) could not be placed word for word, so nothing was changed. Press ✨ Fix with AI to ask again.`));
    body.appendChild(h('div', { class: 'row' },
      h('button', { type: 'button', 'data-testid': 'planned-check', onclick: async () => {
        clear(msg); const j = await runAiJob(`/review/planned/${encodeURIComponent(rid)}/check`, {}, prog, 'Checking the planned items');
        if (j) { toast(((j.results || [])[0] || {}).message || 'Checked'); draw(); }
      } }, '🔎 Check again with AI'),
      open.length ? h('button', { type: 'button', class: 'primary ai-btn', 'data-testid': 'planned-fix', onclick: async () => {
        clear(msg); const j = await runAiJob(`/review/planned/${encodeURIComponent(rid)}/fix`, {}, prog, 'The writer is working the planned items in');
        if (j) { toast(((j.results || [])[0] || {}).message || 'Done'); draw(); }
      } }, '✨ Fix with AI') : null));
  };
  draw();
  return box;
}
/** Book page: the story rules / world card and the whole book's planned-to-page list. */
function bookSection4Card() {
  const box = h('section', { class: 'card s4-card', 'aria-labelledby': 's4-h', 'data-testid': 'book-s4' },
    h('h2', { id: 's4-h' }, '🌍 Rules, world and the plan on the page'));
  const body = h('div', null, loadingState('Loading…'));
  box.appendChild(body);
  (async () => {
    let w = null; let p = null;
    try { [w, p] = await Promise.all([api('GET', bpath('/review/world')), api('GET', bpath('/review/planned'))]); }
    catch (e) { clear(body).appendChild(problemBox(toProblem(e, { book: S.project.name, step: 'Story rules and world' }), {})); return; }
    const nRules = w.rules ? (w.rules.rules || []).filter(r => r.status !== 'retired').length : 0;
    const nTex = w.texture ? (w.texture.items || []).length : 0;
    const unbounded = (w.rules_lint || []).filter(x => ['UNBOUNDED_EXCEPTION', 'NO_LIMITS'].includes(x.code)).length;
    clear(body).appendChild(h('p', null, h('a', { class: 'btn small', href: plink('world'), 'data-testid': 'open-world' }, '🌍 Story rules and world'), ' ',
      `${nRules} story rule(s), ${nTex} world detail(s)`,
      unbounded ? [' ', hazard({ code: 'RULE_NOT_BOUNDED', message: `${unbounded} rule(s) have no limits` }, { open: plink('world'), openLabel: 'Open the rules' }, { small: true })] : null,
      (w.rules_changed || []).length ? [' ', hazard({ code: 'RULES_OUT_OF_DATE' }, { open: plink('world'), openLabel: 'Open the rules' }, { small: true })] : null,
      !w.rules ? h('span', { class: 'small muted' }, ' — no rules yet') : null));
    const ch = choicesSummary(profileOf().choices);
    body.appendChild(h('p', { class: 'small' }, h('strong', null, '🎚️ Ending and style: '), ch.length ? ch.join(' · ') : 'Let the AI choose', ' ',
      h('button', { type: 'button', class: 'small link', onclick: () => openProfileDialog() }, 'Change')));
    const written = (p.chapters || []).filter(r => r.written);
    if (!written.length) { body.appendChild(h('p', { class: 'small muted' }, '✅ Planned to page: no chapter is written yet.')); return; }
    const miss = p.missing || [];
    body.appendChild(h('div', { 'data-testid': 'book-planned' },
      h('p', { class: 'small' }, miss.length || (p.names_never_on_page || []).length ? [hazard({ code: 'PLANNED_MISSING' }, {}, { small: true }), ` Planned but not on the page: ${miss.length} item(s) in ${new Set(miss.map(m => m.chapter_id)).size} chapter(s).`]
        : `✅ Everything planned is on the page in the ${written.length} written chapter(s).`),
      (p.names_never_on_page || []).length ? h('p', { class: 'small words-warn' }, `⚠️ Never named in the book: ${p.names_never_on_page.join(', ')}`) : null,
      miss.length ? h('ul', { class: 'small planned-list' }, miss.slice(0, 12).map(m => h('li', null, '⚠️ ', h('a', { href: plink('write', m.record_id) }, `Chapter ${m.number}`), `: ${m.label}`))) : null));
  })();
  return box;
}
/** Run window: what the planned-to-page check found in this run. */
function plannedRunSummary(r) {
  const ps = r.planned_summary;
  if (!ps || !ps.checked) return null;
  const fl = ps.flagged || [];
  const book = ps.book || {};
  return h('div', { class: fl.length ? 'words-warn' : 'small', 'data-testid': 'mb-planned-summary' },
    h('p', null, fl.length ? h('span', { 'aria-hidden': 'true' }, '⚠️ ') : '✅ ',
      `Planned to page: ${ps.checked} chapter(s) checked, ${ps.fixed || 0} fix(es) kept.`),
    fl.length ? [h('p', null, h('strong', null, 'Planned but not on the page: '), 'these chapters were approved under your run consent anyway. Open each one and use ✅ Planned to page → ✨ Fix with AI.'),
      h('ul', { class: 'small' }, fl.map(f => h('li', null, h('strong', null, f.label || f.chapter_id), (f.missing || []).length ? `: ${f.missing.slice(0, 4).join('; ')}` : '')))] : null,
    (book.names || []).length ? h('p', { class: 'small' }, `⚠️ Never named in the book: ${book.names.join(', ')}`) : null);
}

async function viewPair(main) {
  const info = S.pairing; S.pairing = null;
  main.appendChild(h('div', { class: 'page-head' }, h('h1', null, '🔗 Connect to AutoInjector')));
  if (!info || !info.code) {
    main.appendChild(stateBox('empty', 'No pairing code here',
      h('p', null, 'Press “Connect” in the AutoInjector desktop app: it opens this page with a one-time code and Akọwe connects by itself. The code works once and only for about 2 minutes.'),
      h('p', null, 'You can also paste a connection key in ', h('a', { href: '#/settings' }, 'Settings'), '.')));
    return;
  }
  // BF-07: a link can be opened by any web page, so never pair from the address alone: only a bridge on
  // this computer, and only after the author confirms (with a warning when it is not AutoInjector's usual port).
  const bm = /^http:\/\/(127\.0\.0\.1|localhost)(?::(\d{1,5}))?\/?$/.exec(info.bridge || '');
  if (!bm) {
    main.appendChild(stateBox('failed', 'This connection link is not from AutoInjector',
      h('p', null, 'It points Akọwe at an address that is not on this computer, so Akọwe did not connect.'),
      h('p', null, h('strong', null, 'What to do: '), 'Press Connect in the AutoInjector desktop app to get a new link.')));
    return;
  }
  const bridgeUrl = `http://${bm[1]}:${bm[2] || '80'}`;
  const usualPort = bridgeUrl === BRIDGE_DEFAULT || bridgeUrl === BRIDGE_DEFAULT.replace('127.0.0.1', 'localhost');
  const holder = h('div', { 'aria-live': 'polite' });
  main.appendChild(holder);
  const confirmed = await new Promise(resolve => {
    const yes = h('button', { type: 'button', class: 'primary big', onclick: () => resolve(true) },
      usualPort ? 'Connect to AutoInjector' : `Connect to port ${bm[2] || '80'} anyway`);
    holder.appendChild(stateBox('ask', 'Connect Akọwe to AutoInjector?',
      h('p', null, 'Only continue if you just pressed “Connect” in the AutoInjector desktop app. Akọwe will then send its AI requests through AutoInjector.'),
      usualPort ? null : h('p', null, h('strong', null, 'Check first: '), `this link points at port ${bm[2] || '80'} on this computer, not AutoInjector's usual port (17891). Continue only if you changed AutoInjector's bridge port yourself.`),
      h('div', { class: 'row' }, yes, h('button', { type: 'button', onclick: () => resolve(false) }, 'Cancel'))));
    S.leaveHooks.push(() => resolve(false));
    yes.focus();
  });
  if (!confirmed) {
    if (parseRoute()[0] !== 'pair') return;
    clear(holder).appendChild(stateBox('empty', 'Not connected',
      h('p', null, 'Nothing was changed. To connect, press Connect in the AutoInjector desktop app again.')));
    return;
  }
  clear(holder).appendChild(loadingState('Connecting to AutoInjector…'));
  let out;
  try { out = await api('POST', '/slots/pair-autoinjector', { body: { code: info.code, bridge_url: bridgeUrl } }); }
  catch (e) {
    const err = apiErrInfo(e);
    clear(holder).appendChild(stateBox('failed', 'AutoInjector was not connected',
      h('p', null, err.message),
      h('p', null, h('strong', null, 'What to do: '), err.code === 'EXPIRED_APPROVAL' || err.code === 'INVALID_INPUT'
        ? 'Press Connect again in AutoInjector. A new code is made each time.'
        : 'Make sure the AutoInjector desktop app is running and its Akọwe bridge is switched on, then press Connect again in AutoInjector.'),
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
  clear(holder).appendChild(stateBox(allOk ? 'ok' : 'fix', allOk ? 'Connected to AutoInjector' : 'Connected — some AIs are not ready yet',
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
      h('p', { class: 'small muted' }, `Saved as ${name} in the “reports” folder of your Akọwe data. No keys or prompts are in it.`),
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
    code = x.problem || x.code || `HTTP_${e.status}`; message = x.message || `HTTP ${e.status}`; path = x.path || ''; fix = x.fix || null; status = e.status;
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
    text = ['Akọwe diagnostics (the Akọwe program did not answer, so only this page\'s view is included)',
      `Generated: ${new Date().toISOString()}`, `Browser: ${client.user_agent}`, `Screen: ${client.screen}`,
      `Problem reaching Akọwe: ${toProblem(e).code}`, 'Recent problems on this page:',
      ...CLIENT_ERRORS.slice(-15).map(x => `  ${x.at} ${x.code} ${x.where} ${x.message}`)].join('\n');
  }
  if (download) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = h('a', { href: url, download: 'akowe-diagnostics.txt' }); document.body.appendChild(a); a.click(); a.remove();
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
    h('span', { class: 'gp-text' }, h('strong', null, p.title), ' — ', clipWords(p.message, 140)),
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
/* ======================================================================= 🩺 P37.5 before a run: which AIs work, and how to fix the others */
/**
 * Before a book run starts: Akọwe asks AutoInjector (/v1/health) about every AI the run will use. When all work it
 * returns at once ({skipped: []}). Otherwise a notice says which AI, what is wrong and how to fix it, with
 * 🔁 I fixed it — check again / ▶ Start without it / ✖ Cancel. Resolves {skipped: [slot ids]} or null (cancelled).
 */
async function aiPreflight({ slotId = null, what = 'the book' } = {}) {
  let res;
  try { res = await api('GET', `/ai-check${slotId ? `?slot_id=${encodeURIComponent(slotId)}` : ''}`); }
  catch (e) { noteClientError(toProblem(e).code, 'AI check', toProblem(e).message); return { skipped: [] }; } // a help only: the start itself still reports problems
  if (!res || res.ok || !(res.ais || []).length) return { skipped: [] };
  return new Promise(resolve => {
    const prev = document.activeElement;
    const d = h('dialog', { class: 'selftest-dialog choice-dialog ai-check-dialog', 'aria-labelledby': 'aic-title', 'data-testid': 'ai-check-dialog' });
    let done = false;
    const finish = v => { if (done) return; done = true; try { if (d.open) d.close(); } catch { /* ignore */ } d.remove(); if (prev && prev.focus) { try { prev.focus(); } catch { /* ignore */ } } resolve(v); };
    const draw = (r, busy = false) => {
      clear(d);
      const bad = (r.ais || []).filter(a => !a.ok);
      d.appendChild(h('h2', { id: 'aic-title' }, bad.length === 1 ? `⚠️ ${bad[0].title}` : `⚠️ ${bad.length} of your AIs aren’t working`));
      d.appendChild(h('p', null, `Before ${what} starts, Akọwe checked every AI the run will use (for writing, reviewing and editing).`));
      d.appendChild(h('ul', { class: 'aic-list' }, (r.ais || []).map(a => h('li', { class: a.ok ? 'aic-ok' : 'aic-bad', 'data-slot': a.slot_id, 'data-testid': a.ok ? 'aic-ok' : 'aic-bad' },
        a.ok ? [h('strong', null, `✔ ${a.ai}`), ' works.']
          : [h('strong', null, `⚠️ ${a.title}`), h('p', { class: 'aic-what' }, a.what),
            (a.fix || []).length ? h('div', { class: 'small aic-fix' }, h('strong', null, 'How to fix it:'), h('ol', null, a.fix.map(f => h('li', null, f)))) : null]))));
      d.appendChild(h('p', { class: r.any_working ? 'small' : 'words-warn', role: 'note', 'data-testid': 'aic-if-skipped' }, r.any_working ? r.if_skipped : r.message));
      if (busy) d.appendChild(loadingState('Checking again… AutoInjector checks in with each AI (up to a minute).'));
      const again = h('button', { type: 'button', class: 'primary', 'data-testid': 'aic-recheck', disabled: busy, onclick: recheck }, '🔁 I fixed it — check again');
      const skip = h('button', { type: 'button', 'data-testid': 'aic-skip', disabled: busy || !r.any_working, onclick: () => finish({ skipped: bad.map(a => a.slot_id) }) },
        bad.length === 1 ? `▶ Start without ${bad[0].ai}` : '▶ Start without them');
      d.appendChild(h('div', { class: 'form-actions' }, again, skip, h('button', { type: 'button', 'data-testid': 'aic-cancel', onclick: () => finish(null) }, '✖ Cancel')));
      const f = d.querySelector('button:not([disabled])'); if (f && !busy) f.focus();
    };
    const recheck = async () => {
      draw(res, true);
      try { res = await api('POST', '/ai-check', { body: { probe: true, slot_id: slotId } }); }
      catch (e) { draw(res); d.appendChild(problemBox(toProblem(e, { step: 'Check the AIs again' }))); return; }
      if (res.ok) { toast(`All your AIs work: ${res.working.join(', ')}`); finish({ skipped: [] }); return; }
      draw(res);
      announce(res.message || 'Some AIs still aren’t working');
    };
    d.addEventListener('cancel', ev => { ev.preventDefault(); finish(null); });
    document.body.appendChild(d);
    try { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); } catch { d.setAttribute('open', ''); }
    draw(res);
  });
}
/** Start body + the AI check: null when the author cancelled; the body (with ai_check when AIs are skipped) otherwise. */
async function withAiCheck(body, what) {
  const pf = await aiPreflight({ slotId: body.slot_id || null, what });
  if (!pf) return null;
  if (pf.skipped.length) body.ai_check = { skipped: pf.skipped };
  return body;
}

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
  // a run a newer run of the same book replaced (replaced_by) never makes the button say Paused / Interrupted
  const pend = (out.runs || []).find(r => ['paused', 'interrupted', 'pausing'].includes(r.status) && !r.replaced_by);
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
    lab.textContent = pend.state === 'needs_decision' ? 'Needs you' : (pend.state === 'interrupted' || pend.status === 'interrupted') ? 'Interrupted' : 'Paused';
    btn.setAttribute('aria-label', `Make a book for me${pend.title ? ` (“${pend.title}”)` : ''}: ${pend.state_words || 'paused, needs you.'} Open the progress window`);
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
  const lengthBox = h('fieldset', { class: 'field', id: 'mb-length' }, h('legend', null, 'Length ', infoTip('Length', ...LENGTH_TIP())), lengths);
  const pipe = await pipelineFields('mb');
  await loadChoicesInfo();
  const cf = choicesFields({}, 'mb');
  const s7 = await S7C.makeSetupExtras(s7c());  // P23 / P25 (Section 7c)
  fields.length = lengthBox.querySelector('input');
  const startAll = h('button', { type: 'button', class: 'primary big mab-go', 'data-testid': 'mb-start-auto' }, '⚡ Start — let the AI choose everything');
  const startSet = h('button', { type: 'submit', class: 'big', 'data-testid': 'mb-start' }, '⚡ Start with these settings');
  const form = h('form', { novalidate: true, class: 'mb-setup', onsubmit: ev => { ev.preventDefault(); go(false); } },
    h('p', { class: 'lead' }, 'Akọwe makes a whole new book for you with your AI — characters, plot, every chapter — and gives you a PDF, EPUB and Word file at the end. You can watch every step, pause or cancel any time.'),
    h('div', { class: 'consent-box', role: 'note' }, h('strong', null, '✋ Your consent for this run: '),
      'pressing Start lets the AI reviewer approve the drafts it checks and passes — for this one new book, in this run only. Drafts it does not pass are fixed by the AI (up to twice) or wait for your decision. Your other books are never touched. A backup is made first.'),
    h('details', { class: 'mb-quick', open: true }, h('summary', null, 'Quick settings (all optional)'),
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', { for: 'mb-genre' }, 'Genre'), genre, h('datalist', { id: 'mb-genres' }, GENRES.map(g => h('option', { value: g }))), h('span', { class: 'hint' }, 'Empty = the AI chooses.')),
        h('div', { class: 'field' }, h('label', { for: 'mb-slot' }, 'Which AI'), slot, h('span', { class: 'hint' }, 'Automatic uses whichever AI is ready.'))),
      lengthBox,
      h('div', { class: 'field' }, h('label', { for: 'mb-idea' }, 'Your idea (optional)'), idea), cf.el, pipe.el, s7.el),
    err, h('div', { class: 'form-actions' }, startAll, startSet));
  const est = estimateBox(gridUI(), () => {  // ⏱ P28: AI answers and minutes before the run starts
    const l = form.querySelector('input[name="mb-len"]:checked'); const pl = pipe.get();
    return Object.assign({ length: l ? l.value : 'short_story' }, pl ? { pipeline: pl } : {});
  });
  form.insertBefore(est.el, err); form.addEventListener('change', () => est.refresh()); est.refresh();
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
      if (CH.info) body.choices = cf.get();
      const pl = pipe.get(); if (pl) body.pipeline = pl;
    }
    s7.apply(body);  // P23 / P25 (Section 7c): beta reader and "write in my style"
    startAll.disabled = startSet.disabled = true;
    err.appendChild(loadingState('Checking your AIs…'));
    if (!(await withAiCheck(body, 'the book'))) { clear(err); startAll.disabled = startSet.disabled = false; return; }
    clear(err).appendChild(loadingState('Starting…'));
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
/** A quoted line of the book: “…” added only when the text is not already in quote marks (no ""…"" doubles). */
function quoted(t) {
  const x = String(t == null ? '' : t).trim();
  if (!x) return '';
  return /^["“”‘’'«]/.test(x) || /["“”’'»]$/.test(x) ? x : `“${x}”`;
}
/** Text cut to at most n characters at a word boundary, with … when it was cut (never mid-word). */
function clipWords(t, n) {
  const x = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  if (x.length <= n) return x;
  const cut = x.slice(0, n - 1); const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`;
}
/** Who read a chapter in the book report: the name, “(read version N)” when an earlier version was read, or “not read”. */
function whoRead(u, who, at) {
  if (!u[who]) return 'not read';
  return u[at] && u.version && u[at] !== u.version ? `${u[who]} (read version ${u[at]})` : u[who];
}
function renderRun() {
  const r = MB.run; if (!r || !MB.dialog) return;
  const sig = JSON.stringify([r.status, r.phase, r.current, r.problem && r.problem.code, (r.waiting || {}).retry_at, r.steps.map(s => [s.state, s.message, s.review_note, s.editor_note, (s.items || []).map(i => [i.state, i.editor, i.scenes, i.phase, i.note, i.planned, i.length]), s.planned_note]), (r.files || []).length, r.ais, r.ai_alerts, r.review_summary, r.editor_summary, r.planned_summary, r.eta, r.report, r.save, r.costs && [r.costs.calls, r.costs.ais]]);
  if (sig === MB.sig && MB.dialog.querySelector('.mb-steps')) { updateRunClocks(); return; }
  MB.sig = sig;
  const w = r.state === 'replaced' ? ['↪', 'Replaced by a newer run', 'b-muted'] : r.state === 'interrupted' ? RUN_WORD.interrupted
    : r.state === 'needs_decision' ? ['⏸', 'Paused — needs your decision', 'b-warn'] : RUN_WORD[r.status] || ['?', r.status, 'b-muted'];
  const done = r.steps.filter(s => s.state === 'done').length;
  const head = h('div', { class: 'mb-head' },
    h('div', null, h('p', { class: 'mb-book' }, r.title ? `“${r.title}”` : 'A new book', r.settings && r.settings.length ? h('span', { class: 'muted small' }, ` · ${(LENGTH_INFO[r.settings.length] || [''])[0]}`) : null),
      h('div', { class: 'row' }, badge(w[0], w[1], w[2]), h('span', { class: 'small' }, `${done} of ${r.steps.length} steps`), h('span', { class: 'small muted' }, '⏱ ', h('span', { class: 'mb-elapsed' }, fmtElapsed(sinceMs(r.started_at, r.finished_at)))),
        r.eta && ['running', 'waiting', 'queued', 'pausing'].includes(r.status) ? h('span', { class: 'small mb-eta', 'data-testid': 'mb-eta', title: `Estimated from this run's measured times: ${r.eta.per_chapter_s} s per chapter, ${r.eta.calls} AI answers so far (${r.eta.avg_call_s} s each on average)` },
          `⏳ ${etaWords(r.eta.seconds_left)} left · ${r.eta.chapters_left} chapter(s) to go`) : null),
      runVariantLine(r), runCostLine(gridUI(), r)),
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
        s.review_note ? h('p', { class: `small mb-review-note${s.review_independent === false ? ' not-independent' : ''}`, 'data-testid': 'mb-review-note' }, '🧐 ', s.review_note) : null,
        s.editor_note ? h('p', { class: `small mb-review-note${/⚠️/.test(s.editor_note) ? ' not-independent' : ''}`, 'data-testid': 'mb-editor-note' }, '🖋 ', s.editor_note) : null,
        s.planned_note ? h('p', { class: `small mb-review-note${/⚠️/.test(s.planned_note) ? ' not-independent' : ''}`, 'data-testid': 'mb-planned-note' }, '✅ ', s.planned_note) : null,
        (s.items || []).length ? h('ul', { class: 'mb-items' }, s.items.map(i => h('li', { class: `st-${i.state}` },
          h('span', { 'aria-hidden': 'true' }, STEP_ICON[i.state] || '○'), ' ', i.label, i.words ? h('span', { class: 'muted' }, ` · ${i.words} words`) : null,
          i.phase ? h('span', { class: 'small muted', 'data-testid': 'mb-item-phase' }, ` · ${i.phase}…`) : null,
          i.note && s.id === 'characters' ? h('span', { class: 'small muted' }, ` · ${i.note === 'made now' || i.note === 'made with the character' ? `sheet and voice ${i.note}` : `⚠️ ${i.note}`}`) : null,
          i.scenes ? h('span', { class: `small mb-sc${i.scenes.flagged || i.scenes.failed ? ' flagged' : ''}`, 'data-testid': 'mb-item-scenes' },
            i.scenes.failed ? ` · ⚠️ scenes not planned (${i.scenes.failed})` : ` · 🎬 ${i.scenes.scenes} scene${i.scenes.scenes === 1 ? '' : 's'}`
              + (i.scenes.flagged ? ' ⚠️ checker had notes' : i.scenes.verdict === 'PASS' ? ' ✔ checked' : '')
              + (i.scenes.status === 'approved' ? ' · approved' : '')) : null,
          i.editor ? h('span', { class: `small mb-ed${i.editor.flagged ? ' flagged' : ''}`, 'data-testid': 'mb-item-editor' },
            i.editor.flagged ? ' · ⚠️ editor still had notes' : ` · 🖋 editor: ${String(i.editor.verdict || '').toLowerCase()}`,
            i.editor.rounds ? ` (${i.editor.rounds} rewrite round${i.editor.rounds === 1 ? '' : 's'})` : '',
            typeof i.editor.avg === 'number' ? ` · avg ${i.editor.avg}` : '') : null,
          i.note && ['world', 'planned'].includes(s.id) ? h('span', { class: 'small muted' }, ` · ${i.state === 'failed' ? '⚠️ ' : ''}${i.note}`) : null,
          i.length ? h('span', { class: 'small muted', 'data-testid': 'mb-item-length' }, i.length.mode === 'scene_by_scene' ? ` · 📏 written scene by scene (${i.length.scenes})` : '',
            i.length.target ? ` · target ~${Number(i.length.target).toLocaleString()}` : '', i.length.expanded ? ` · continued +${i.length.expanded} words` : '',
            i.length.target && i.words && i.words < i.length.target * 0.6 ? [' ', hazard({ code: 'CHAPTER_UNDER_TARGET', message: `${i.words} of about ${i.length.target} words` }, {}, { small: true })] : null) : null,
          i.planned ? h('span', { class: `small mb-pl${i.planned.flagged ? ' flagged' : ''}`, 'data-testid': 'mb-item-planned' },
            i.planned.flagged ? ` · ⚠️ ${i.planned.missing} planned item(s) not on the page` : ' · ✅ plan on the page',
            i.planned.fixed ? ` (${i.planned.fixed} fix kept)` : '') : null))) : null));
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
        h('a', { class: 'btn', href: '#/shelf', onclick: () => closeMakeBook() }, '📚 My finished books')),
      runReportBox(r));
  }
  const rs = r.review_summary || {};
  const ais = aiStrip(r.ais, r.probe && r.probe.state === 'running' ? 'Checking the AIs' : 'AIs');
  const working = (r.ais || []).filter(a => a.working);
  const alerts = runAiAlerts(r);
  const indep = rs.same_ai || (r.ais && r.ais.length && working.length === 1 && !(r.probe && r.probe.state === 'running') && !['done', 'cancelled'].includes(r.status))
    ? h('p', { class: 'words-warn mb-indep', role: 'note', 'data-testid': 'mb-not-independent' }, h('span', { 'aria-hidden': 'true' }, '⚠️ '),
      rs.same_ai ? `${NOT_INDEPENDENT} (${rs.same_ai} of ${rs.same_ai + (rs.independent || 0)} reviews so far).` : `Only ${working[0].name} works right now, so it will review its own writing: reviews are not independent (the same AI writes and reviews).`,
      h('span', { class: 'small' }, ' When another AI works again, it reviews instead.')) : null;
  if (doneBox && (rs.independent || rs.same_ai)) {
    doneBox.appendChild(h('p', { class: rs.same_ai ? 'words-warn' : 'small', 'data-testid': 'mb-review-summary' }, rs.same_ai ? h('span', { 'aria-hidden': 'true' }, '⚠️ ') : '🧐 ',
      `AI reviews: ${rs.independent || 0} by a different AI than the writer` + (rs.same_ai ? `, ${rs.same_ai} by the same AI. ${NOT_INDEPENDENT}.` : '.')));
  }
  const edBox = editorRunSummary(r);
  if (doneBox && edBox) doneBox.appendChild(edBox);
  const plBox = plannedRunSummary(r);
  if (doneBox && plBox) doneBox.appendChild(plBox);
  const fcBox = factsRunSummary(r); // 🔎 P26/P30/P31
  if (doneBox && fcBox) doneBox.appendChild(fcBox);
  const consent = h('p', { class: 'small muted mb-consent' }, `Approvals in this run are made by the AI reviewer under your consent (run ${r.id}, ${fmtTime(r.consent && r.consent.at)}). Every one is in the book journal.`);
  mbShell('⚡ Make a book for me', head, runBibleLine(r), phase, ais, alerts, indep, doneBox, doneBox ? null : edBox, runSaveLine(r), msg, ol, ctl, consent,
    r.project_id && r.status !== 'done' ? h('p', { class: 'small' }, h('a', { href: link('p', r.project_id, r.branch_id || 'main', 'book'), onclick: () => closeMakeBook() }, 'Open the book being made')) : null);
  updateRunClocks();
}

/** P37.5 run window: a visible notice for every AI that is not working right now (what is wrong, how to fix it). */
function runAiAlerts(r) {
  const list = r.ai_alerts || [];
  if (!list.length || ['done', 'cancelled'].includes(r.status)) return null;
  return h('div', { class: 'mb-ai-alerts', role: 'status', 'data-testid': 'mb-ai-alerts' }, list.map(a => h('div', { class: 'words-warn mb-ai-alert', 'data-slot': a.slot_id },
    h('p', null, h('strong', null, `⚠️ ${a.title}`), ' ', a.what || '', ' ',
      a.chosen ? 'You chose to start without it. ' : '',
      (a.takes_over || []).length ? `Its work goes to ${a.takes_over.join(' and ')} meanwhile.` : 'No other AI works, so the work waits for one.'),
    (a.fix || []).length ? h('details', { class: 'small' }, h('summary', null, 'How to fix it'), h('ol', null, a.fix.map(f => h('li', null, f)))) : null)));
}
function etaWords(sec) {
  if (sec == null) return '';
  if (sec < 90) return `about ${Math.max(1, Math.round(sec))} s`;
  const m = Math.round(sec / 60);
  return m < 90 ? `about ${m} min` : `about ${Math.floor(m / 60)} h ${m % 60} min`;
}
/** Run window: the pipeline switches (P14) and "variant of" when the run is not the default full pipeline. */
function runVariantLine(r) {
  const p = (r.settings || {}).pipeline;
  const v = (r.settings || {}).variant_of;
  if ((!p || p.preset === 'full') && !v) return null;
  return h('p', { class: 'small mb-variant', 'data-testid': 'mb-variant' }, '🧪 ',
    p && p.preset !== 'full' ? `${p.preset === 'baseline' ? 'Baseline pipeline' : 'Custom pipeline'}: ${Object.entries(p.flags || {}).filter(([, on]) => !on).map(([k]) => PIPE_WORD[k] || k).join(', ')} off` : 'Full pipeline',
    v ? ` · a variant of “${v.title || 'another book'}” (same profile, idea and choices)` : '');
}
const PIPE_WORD = { editor: 'editor', scenes: 'scene cards', voices: 'voice cards', rules: 'story rules', planned: 'planned check' };
/** Run window, when done: the book report made at the end of the run (P13). */
function runReportBox(r) {
  const rp = r.report;
  if (!r.project_id) return null;
  const href = link('p', r.project_id, r.branch_id || 'main', 'report');
  return h('div', { class: rp && rp.reviewers ? 'small' : 'words-warn', 'data-testid': 'mb-report' },
    h('p', null, '📊 ', rp && rp.reviewers ? `Book report: ${rp.reviewers} AI(s) read the whole book${rp.independent < rp.reviewers ? ` (${rp.reviewers - rp.independent} not independent ⚠️)` : ''} — overall ${rp.overall}/10.`
      : 'Book report made without an AI review (no independent AI was working).',
    (rp && (rp.disagreements || []).length) ? ` ⚠️ They disagree on ${rp.disagreements.join(', ')}.` : '', ' ',
    h('a', { class: 'btn small primary', href, onclick: () => closeMakeBook() }, '📊 Open the book report')));
}
/** 🧪 Pipeline switches (P14): preset + the five switches, each with ⓘ. get() -> null (full, the default) or {preset, flags}. */
const PIPE = { info: null };
async function pipelineFields(prefix, cur = null) {
  if (!PIPE.info) { try { PIPE.info = await api('GET', '/pipeline'); } catch { PIPE.info = null; } }
  const info = PIPE.info;
  if (!info) return { el: h('p', { class: 'small muted' }, 'The pipeline switches could not be loaded.'), get: () => null };
  const flags = Object.assign({}, info.presets.full.flags, (cur && cur.flags) || {});
  const preset = h('select', { id: `${prefix}-pipe-preset`, 'data-testid': `${prefix}-pipe-preset` },
    ['full', 'baseline', 'custom'].map(k => h('option', { value: k }, (info.presets[k] || { label: 'Custom — choose below' }).label)));
  const boxes = {};
  const rows = info.flags.map(f => {
    const id = `${prefix}-pipe-${f.key}`;
    boxes[f.key] = h('input', { type: 'checkbox', id, checked: !!flags[f.key], 'data-flag': f.key });
    return h('div', { class: 'check-row' }, boxes[f.key], h('label', { for: id }, f.label), infoTip(f.label, h('p', null, f.help)));
  });
  const sync = () => { const p = preset.value; if (p !== 'custom') for (const [k, b] of Object.entries(boxes)) b.checked = info.presets[p].flags[k]; };
  const guess = () => { const on = Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, b.checked]));
    preset.value = Object.values(on).every(Boolean) ? 'full' : Object.values(on).every(x => !x) ? 'baseline' : 'custom'; };
  preset.addEventListener('change', sync);
  for (const b of Object.values(boxes)) b.addEventListener('change', guess);
  guess();
  const el = h('details', { class: 'field pipe-box', 'data-testid': `${prefix}-pipeline` }, h('summary', null, '🧪 Pipeline (advanced, for comparing versions)'),
    h('p', { class: 'small muted' }, 'Everything is on by default. Switch parts off to make a “baseline” version and then ⚖️ compare it blind with a full one.'),
    h('div', { class: 'field' }, h('label', { for: `${prefix}-pipe-preset` }, 'Preset ', infoTip('Pipeline presets', h('p', null, 'Full: every part of Akọwe’s writing pipeline. Baseline: the editor, scene cards, voice cards, story rules and the planned-to-page check are off — the writer gets the outline, the context and your ending and style choices only (like the first automatic book).'))), preset),
    h('div', { class: 'pipe-flags' }, rows));
  return { el, get: () => {
    const f = Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, b.checked]));
    return Object.values(f).every(Boolean) ? null : { flags: f };
  } };
}

/** Run window: what the editor did in this run; ⚠️ chapters it still had notes on (approved under the run consent). */
function editorRunSummary(r) {
  const es = r.editor_summary;
  if (!es || !es.reviewed) return null;
  const fl = es.flagged || [];
  return h('div', { class: fl.length ? 'words-warn' : 'small', 'data-testid': 'mb-editor-summary' },
    h('p', null, fl.length ? h('span', { 'aria-hidden': 'true' }, '⚠️ ') : '🖋 ',
      `Editor: ${es.reviewed} chapter(s) read, ${es.passed} passed, ${es.rounds} rewrite round(s), ${es.kept} rewrite(s) kept, ${es.rejected} not kept.`),
    fl.length ? [h('p', null, h('strong', null, 'The editor still had notes on: '), 'these chapters were approved under your run consent anyway (the book was not held up). Open each one to read the notes and use 🖋 Editor / ✍ Apply editor’s fixes if you like.'),
      h('ul', { class: 'small' }, fl.map(f => h('li', null, h('strong', null, f.label || f.chapter_id), f.reason ? ` — ${f.reason}` : '',
        (f.notes || []).length ? h('ul', null, f.notes.slice(0, 4).map(n => h('li', null, `${n.severity === 'major' ? '⚠️ ' : ''}${n.label || ''}${n.passage ? ` (${quoted(n.passage)})` : ''}${n.why ? `: ${n.why}` : ''}`))) : null)))] : null);
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
    running ? aiStrip(j.ais) : null,
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
    if (!(await aiPreflight({ what: 'Write all chapters' }))) return; // P37.5: say which AI isn't working first
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
    HL.last = { overall: 'problem', checked_at: new Date().toISOString(), checks: [{ id: 'server', title: 'The Akọwe program', status: 'problem', code: p.code, detail: p.what, fix: p.fix }] };
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
  put(d, h('p', { class: `hl-sum hl-${res.overall}` }, h('strong', null, word), h('span', { class: 'small muted' }, ` Checked ${fmtTime(res.checked_at)}. Akọwe checks again every minute while this page is open.`)),
    h('ul', { class: 'hl-list' }, (res.checks || []).map(c => h('li', { class: `hl-row hl-${c.status}`, 'data-check': c.id },
      h('span', { class: 'hl-ico', 'aria-hidden': 'true' }, { ok: '✔', info: 'ℹ', warn: '⚠️', problem: '⚠️' }[c.status] || '•'),
      h('div', { class: 'hl-main' }, h('div', { class: 'row' }, h('strong', null, c.title),
        ['warn', 'problem'].includes(c.status) ? hazard({ code: c.code || (c.status === 'problem' ? 'FAILED' : 'BLOCKED'), message: c.detail, fix: c.fix, where: { step: `Health › ${c.title}` } }, healthAction(c)) : null),
      h('p', { class: 'small' }, c.detail), c.fix ? h('p', { class: 'small' }, h('strong', null, c.status === 'info' ? 'Tip: ' : 'How to fix it: '), c.fix) : null)))),
    h('div', { class: 'row form-actions' }, h('button', { type: 'button', class: 'primary', onclick: () => refreshHealth(true) }, '🔁 Run checks now'),
      h('button', { type: 'button', 'data-testid': 'copy-diag', onclick: () => copyDiagnostics() }, '📋 Copy diagnostics'),
      h('button', { type: 'button', onclick: () => copyDiagnostics({ download: true }) }, '⬇ Download diagnostics')),
    h('p', { class: 'small muted' }, 'Diagnostics never contain your keys, prompts or book text — safe to send when asking for help.'),
    jobsBox);
}
const JOB_KIND = { autobook: '⚡ Make a book for me', write_all: '✍ Write all chapters', assist: '✨ Fill with AI', review_review: '🧐 AI review', review_fix: '🛠 AI fix', bible: '📖 Bible Builder',
  book_review: '📊 Book report', compare: '⚖️ Compare versions' };
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
const JR_ICON = { ai: '🤖', ai_review: '🧐', ai_fix: '🛠', editor: '🖋', approval: '✅', problem: '⚠️', retry: '⏳', pause: '⏸', resume: '▶', backup: '💾', export: '📦', run: '⚡', step: '•', setting: '⚙️', import: '📥', cancel: '✖', note: 'ℹ' };
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

/* ======================================================================= 🗂 P27 scene grid · ⏱ P28 time and AI use (web/grid.js) */
function gridUI() {
  return { h, api, bpath, plink, link, clear, crumbs, stateBox, loadingState, problemBox, toProblem, infoTip, toast, fmtTime, badge,
    safeFileStem, showGlobalProblem, profileOf, route, closeMakeBook, project: () => S.project };
}

/* ======================================================================= 📚 my finished books (S22) */
async function viewShelf(main) {
  main.appendChild(h('div', { class: 'page-head' }, h('div', null, crumbs(['Your books', '#/'], 'My finished books'), h('h1', null, '📚 My finished books')),
    h('button', { type: 'button', class: 'primary', onclick: ev => openMakeBook(ev.currentTarget) }, '⚡ Make a book for me')));
  main.appendChild(h('p', { class: 'muted' }, 'Every book you exported, newest first. Each file is checked against its fingerprint before you download it. 📊 Each book has a quality report; ⚖️ compare two books blind (for example a book and its 🧪 variant).'));
  const holder = h('div', null, loadingState('Checking your finished books…'));
  main.appendChild(holder);
  let out;
  try { out = await api('GET', '/shelf'); } catch (e) { clear(holder).appendChild(problemBox(toProblem(e, { step: 'My finished books' }), { retry: () => route() })); return; }
  clear(holder);
  const archived = out.archived || [];
  if (!out.books.length && !archived.length) {
    holder.appendChild(stateBox('empty', 'No finished book yet', h('p', null, 'Export a book from 📘 Make my book, or press ⚡ Make a book for me and let the AI make one.')));
    return;
  }
  if (out.books.length) holder.appendChild(h('ul', { class: 'shelf' }, out.books.map(shelfBook)));
  else holder.appendChild(h('p', { class: 'muted' }, 'No finished book in your book list: the ones below are archived.'));
  if (archived.length) {
    holder.appendChild(h('h2', { id: 'shelf-archived' }, '🗄 Archived'));
    holder.appendChild(h('p', { class: 'small muted' }, 'Books you archived are hidden from your book list, but their files stay here to download.'));
    holder.appendChild(h('ul', { class: 'shelf', 'aria-labelledby': 'shelf-archived' }, archived.map(shelfBook)));
  }
}

function shelfBook(b) {
  return h('li', { class: `shelf-book${b.all_verified ? '' : ' damaged'}${b.archived ? ' archived' : ''}` },
      h('div', { class: 'sb-cover', 'aria-hidden': 'true' }, h('span', null, (b.title || '?').slice(0, 1))),
      h('div', { class: 'sb-main' }, h('h2', null, b.title), h('p', { class: 'small muted' }, [b.author, b.genre].filter(Boolean).join(' · ') || ' '),
        h('p', { class: 'small' }, `Exported ${fmtTime(b.exported_at)}`, b.made_by_run ? h('span', { class: 'muted' }, ' · made with ⚡') : null,
          b.pipeline && b.pipeline.preset !== 'full' ? h('span', { class: 'muted', 'data-testid': 'sb-pipeline' }, ` · 🧪 ${b.pipeline.label}`) : null,
          b.variant_of ? h('span', { class: 'muted' }, ' · a variant') : null),
        h('p', { class: 'small sb-report', 'data-testid': 'sb-report' }, b.report ? `📊 Report: overall ${b.report.overall ?? '–'}/10 · ${b.report.reviewers || 0} AI reviewer(s) · ${(b.report.words || 0).toLocaleString()} words` : '📊 No report yet', ' ',
          h('a', { class: 'btn small', href: link('p', b.project_id, b.branch_id, 'report') }, b.report ? '📊 Open the report' : '📊 Make the report'), ' ',
          h('a', { class: 'btn small', href: `#/compare?a=${encodeURIComponent(b.project_id)}` }, '⚖️ Compare'), ' ',
          h('button', { type: 'button', class: 'small', onclick: ev => openVariantDialog(b.project_id, b.title, ev.currentTarget) }, '🧪 Variant'), ' ',
          h('button', { type: 'button', class: 'small', 'data-testid': 'sb-rerun', onclick: ev => openRerunDialog({ project_id: b.project_id, branch_id: b.branch_id }, b.title, ev.currentTarget) }, '🔁 Rerun')),
        h('p', { class: 'small sb-save' }, saveBox(b.project_id, b.branch_id, { testid: 'sb-save' })),
        h('div', { class: 'downloads' }, b.files.map(f => f.verified
          ? h('button', { type: 'button', class: 'primary small', 'data-format': f.format, onclick: () => downloadFile(b.project_id, b.branch_id, f, b.title) }, `⬇ ${f.format}`, h('span', { class: 'sr-ok', title: 'Fingerprint checked' }, ' ✔'))
          : h('span', { class: 'row' }, h('button', { type: 'button', class: 'small', disabled: true }, f.format), hazard({ code: 'HASH_MISMATCH', message: `The ${f.format} file is missing or changed.`, where: { book: b.title, set: 'G', step: 'Export my book', op: f.op } }, { open: link('p', b.project_id, b.branch_id, 'book'), openLabel: '📘 Export again' }, { small: true })))),
        h('a', { class: 'small', href: link('p', b.project_id, b.branch_id, 'book') }, 'Open the book')));
}

/* ======================================================================= 📊 P13 book report, ⚖️ P14 compare, 🧪 variants */
const TIP_REPORT = () => [h('p', null, 'When a book is finished Akọwe makes a quality report: scores per dimension, strengths and weaknesses with quotes from the book, what the editor, the planned-to-page check and the pattern check found across all chapters, word counts against the length, which AI wrote and reviewed what, and what to try next.'),
  h('p', null, 'The whole book is read by every working AI that did not write most of it (an independent opinion). Akọwe takes the middle score (median) of the reviewers per dimension and marks ⚠️ where they are 3 or more points apart. A short book is sent whole; a long one as a digest of every chapter (its opening, a middle passage and its ending).')];
async function downloadReport(pid, branch, rep, fmt) {
  try {
    const blob = await api('GET', `/projects/${encodeURIComponent(pid)}/branches/${encodeURIComponent(branch)}/report/${encodeURIComponent(rep.id)}?format=${fmt}&download=1`, { blob: true });
    const name = `${safeFileStem(rep.title) || 'Book'} - Akọwe report - ${(rep.at || '').slice(0, 10)}.${fmt}`;
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`Downloading ${name}`);
  } catch (e) { showGlobalProblem(toProblem(e, { step: `Download the report (${fmt.toUpperCase()})` })); }
}
async function pollQualityJob(path, progressEl) {
  for (;;) {
    let j;
    try { j = await api('GET', path); } catch (e) { throw e; }
    if (progressEl) clear(progressEl).appendChild(h('p', { class: 'small' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', j.phase || 'Working…',
      j.total ? h('span', { class: 'muted' }, ` (${j.done || 0} of ${j.total})`) : null));
    if (!['queued', 'running'].includes(j.status)) return j;
    await new Promise(r => setTimeout(r, 900));
  }
}
function scoreCell(v, cls = '') { return h('td', { class: `num ${cls}` }, v == null ? '–' : String(v)); }
/** The helpers section7c.js (P23 beta reader, P25 writing style) uses — passed in, so that module stays separate. */
function s7c() {
  return { h, api, bpath, plink, link, clear, crumbs, toast, announce, problemBox, toProblem, stateBox, loadingState,
    fmtTime, pollQualityJob, infoTip, hazard, S };
}
async function viewReport(main) {
  const title = profileOf().title || S.project.name;
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    crumbs(['Your books', '#/'], [S.project.name, plink()], ['Make my book', plink('book')], 'Book report'),
    h('h1', null, '📊 Book report')), h('div', { class: 'row' }, infoTip('Book report', ...TIP_REPORT()))));
  const holder = h('div', { 'aria-live': 'polite' }, loadingState('Loading the report…'));
  main.appendChild(holder);
  let ov;
  const load = async () => {
    try { ov = await api('GET', bpath('/report')); } catch (e) { clear(holder).appendChild(problemBox(toProblem(e, { book: title, step: 'Book report' }), { retry: load })); return; }
    draw();
  };
  const run = async (body, btn) => {
    const prog = holder.querySelector('.rp-progress') || h('div', { class: 'rp-progress' });
    if (btn) btn.disabled = true;
    try {
      const j = await api('POST', bpath('/report'), { body });
      const end = await pollQualityJob(bpath(`/report/job/${encodeURIComponent(j.id)}`), prog);
      if (end.status !== 'done') { clear(prog).appendChild(problemBox(Object.assign({ code: (end.error || {}).code || 'INTERNAL_ERROR', message: (end.error || {}).message || end.phase }, { where: { book: title, step: 'Book report' } }), { retry: () => run(body) })); return; }
      toast('The report is ready'); announce('The report is ready');
      await load();
    } catch (e) { clear(prog).appendChild(problemBox(toProblem(e, { book: title, step: 'Book report' }), { retry: () => run(body) })); }
    finally { if (btn) btn.disabled = false; }
  };
  function askBox(rep) {
    const opts = ov.reviewers || [];
    const boxes = opts.map(o => {
      const id = `rp-ai-${o.slot_id}`;
      const cb = h('input', { type: 'checkbox', id, value: o.slot_id, checked: o.working && o.independent, disabled: !o.working });
      return h('div', { class: 'check-row' }, cb, h('label', { for: id }, h('strong', null, o.name), ` — ${o.working ? o.word || 'working' : o.word || 'not working'}`,
        o.wrote_most ? h('span', { class: 'small words-warn' }, ' ⚠️ wrote most of this book: not independent') : null));
    });
    const prog = h('div', { class: 'rp-progress' });
    const btn = h('button', { type: 'button', class: 'primary', 'data-testid': 'rp-ask', onclick: () => {
      const slots = boxes.map(b => b.querySelector('input')).filter(c => c.checked).map(c => c.value);
      if (!slots.length) { clear(prog).appendChild(problemBox({ code: 'MISSING_INPUT', message: 'Choose at least one AI.', where: { book: title, step: 'Ask the other AIs' } })); return; }
      run({ slots, report_id: rep && !ov.stale ? rep.id : undefined }, btn);
    } }, '📨 Ask the other AIs to review this book');
    return h('section', { class: 'card', 'aria-labelledby': 'rp-ask-h', 'data-testid': 'rp-ask-card' }, h('h2', { id: 'rp-ask-h' }, '📨 Ask the other AIs'),
      h('p', { class: 'small' }, 'Each chosen AI reads the whole book (or, for a long book, a digest of every chapter) and scores it. Ticked by default: the working AIs that did not write most of the book.'),
      opts.length ? h('div', { class: 'rp-ais' }, boxes) : h('p', { class: 'small muted' }, 'No AI is connected (Settings).'), h('div', { class: 'row' }, btn), prog);
  }
  function draw() {
    clear(holder);
    const rep = ov.latest;
    const actions = h('div', { class: 'row rp-actions' },
      h('button', { type: 'button', class: rep ? '' : 'primary', 'data-testid': 'rp-make', disabled: !ov.written, onclick: ev => run({ ai: true }, ev.currentTarget) }, rep ? '📊 Make a new report' : '📊 Make the report'),
      rep ? h('button', { type: 'button', 'data-testid': 'rp-md', onclick: () => downloadReport(S.pid, S.branch, rep, 'md') }, '⬇ Markdown') : null,
      rep ? h('button', { type: 'button', 'data-testid': 'rp-pdf', onclick: () => downloadReport(S.pid, S.branch, rep, 'pdf') }, '⬇ PDF') : null,
      h('button', { type: 'button', onclick: ev => openVariantDialog(S.pid, title, ev.currentTarget) }, '🧪 Make a variant'),
      h('a', { class: 'btn', href: `#/compare?a=${encodeURIComponent(S.pid)}` }, '⚖️ Compare with another book'));
    holder.appendChild(actions);
    holder.appendChild(h('div', { class: 'rp-progress' }));
    if (ov.job) { const prog = holder.querySelector('.rp-progress'); pollQualityJob(bpath(`/report/job/${encodeURIComponent(ov.job.id)}`), prog).then(load).catch(() => {}); }
    if (!ov.written) { holder.appendChild(stateBox('empty', 'No chapter is written yet', h('p', null, 'Write the chapters first (📘 Make my book), then make the report.'))); return; }
    if (!rep) { holder.appendChild(stateBox('empty', 'No report yet', h('p', null, 'Press 📊 Make the report: Akọwe counts and checks the book and asks the AIs that did not write it to read it.'))); holder.appendChild(askBox(null)); return; }
    if (ov.stale) holder.appendChild(h('p', { class: 'words-warn', role: 'note', 'data-testid': 'rp-stale' }, hazard({ code: 'REPORT_STALE' }, { retry: () => run({ ai: true }), retryLabel: '📊 Make a new report' }, { small: true }), ' This report is for an earlier version of the book: a chapter changed since.'));
    for (const w of rep.warnings || []) holder.appendChild(h('p', { class: /⚠️/.test(w) ? 'words-warn' : 'small muted', role: 'note' }, w));
    const agg = rep.aggregate || {};
    const wd = rep.words || {};
    const reviews = (rep.reviews || []).filter(r => r.status === 'done');
    holder.appendChild(h('section', { class: 'card rp-summary', 'data-testid': 'rp-summary' }, h('h2', null, `“${rep.title}”`),
      h('p', { class: 'small muted' }, `Made ${fmtTime(rep.at)} · ${rep.version.chapters.length} chapter(s) · ${rep.book_mode === 'digest' ? 'sent to the AIs as a per-chapter digest' : 'sent to the AIs whole'}${rep.run_id ? ` · Make-a-book run ${rep.run_id}` : ''}`),
      h('div', { class: 'rp-kpis' },
        h('div', { class: 'kpi' }, h('strong', null, agg.overall != null ? `${agg.overall}/10` : '–'), h('span', { class: 'small' }, 'overall (median of each dimension, averaged)')),
        h('div', { class: 'kpi' }, h('strong', null, `${agg.reviewers || 0}`), h('span', { class: 'small' }, `AI reviewer(s), ${agg.independent || 0} independent`)),
        h('div', { class: 'kpi' }, h('strong', null, `${(wd.total || 0).toLocaleString()}`), h('span', { class: 'small' }, `words of about ${(wd.target || 0).toLocaleString()} (${wd.length || ''})`)))));
    if ((agg.dimensions || []).some(d => d.n)) {
      const t = h('table', { class: 'rp-table', 'data-testid': 'rp-scores' }, h('caption', { class: 'small' }, 'Scores from 1 to 10. Median = the middle score of the reviewers. ⚠️ = they are 3 or more points apart.'),
        h('thead', null, h('tr', null, h('th', null, 'Dimension'), h('th', null, 'Median'), h('th', null, 'Range'), reviews.map(r => h('th', null, r.name, r.independent && !(r.calibration || {}).flagged ? '' : ' ⚠️')))),
        h('tbody', null, agg.dimensions.filter(d => d.n).map(d => h('tr', { class: d.median <= 5 ? 'low' : d.median >= 8 ? 'high' : '' },
          h('th', { scope: 'row' }, d.label, d.disagree ? [' ', hazard({ code: 'REPORT_DISAGREE', message: `${d.label}: from ${d.min} to ${d.max}` }, {}, { small: true })] : null),
          scoreCell(d.median, 'strong'), h('td', { class: 'num small' }, `${d.min}–${d.max}`), reviews.map(r => scoreCell((d.by || {})[r.slot]))))));
      holder.appendChild(h('section', { class: 'card' }, h('h2', null, 'Scores (whole book)'), h('div', { class: 'table-wrap' }, t)));
    }
    const pts = kind => reviews.flatMap(r => (r[kind] || []).map(p => h('li', null, p.point, p.quote ? [' — ', h('span', { class: 'rp-quote' }, quoted(p.quote)), p.verified ? null : [' ', hazard({ code: 'QUOTE_NOT_FOUND' }, {}, { small: true })]] : null, h('span', { class: 'small muted' }, ` (${r.name})`))));
    if (reviews.length) {
      holder.appendChild(h('div', { class: 'grid-2' },
        h('section', { class: 'card', 'data-testid': 'rp-strengths' }, h('h2', null, '👍 Strengths'), h('ul', null, pts('strengths'))),
        h('section', { class: 'card', 'data-testid': 'rp-weaknesses' }, h('h2', null, '👎 Weaknesses'), h('ul', null, pts('weaknesses')))));
      // 🎯 P36: under each reviewer, how far its review was trusted (re-asked, ⚠️ flagged and capped, lowered) and how generous it is
      holder.appendChild(h('section', { class: 'card', 'data-testid': 'rp-reviewers' }, h('h2', null, 'What the reviewers said'), reviews.map(r => h('div', { class: 'rp-reviewer', 'data-slot': r.slot },
        h('p', null, h('strong', null, r.name), r.independent ? '' : h('span', { class: 'words-warn small' }, ' ⚠️ not independent'), (r.calibration || {}).flagged ? h('span', { class: 'words-warn small', 'data-testid': 'rp-flagged' }, ' ⚠️ not backed by quotes') : '', ': ', r.summary || ''),
        (r.trust_notes || []).length ? h('ul', { class: 'small', 'data-testid': 'rp-trust' }, r.trust_notes.map(n => h('li', { class: /^⚠️/.test(n) ? 'words-warn' : 'muted' }, n))) : null))));
    }
    holder.appendChild(h('section', { class: 'card', 'data-testid': 'rp-next' }, h('h2', null, '🧭 What to try next'),
      (rep.try_next || []).length ? h('ul', null, rep.try_next.map(t => h('li', null, t.text, h('span', { class: 'small muted' }, ` (${t.from})`)))) : h('p', { class: 'small muted' }, 'Nothing stands out. Try ⚖️ comparing a variant to see what the pipeline changes.')));
    const ed = rep.editor || {}; const pl = rep.planned || {}; const pa = rep.patterns || {};
    holder.appendChild(h('div', { class: 'grid-2' },
      h('section', { class: 'card', 'data-testid': 'rp-editor' }, h('h2', null, '🖋 Editor across the chapters'),
        ed.read ? [h('p', { class: 'small' }, `${ed.read} of ${ed.of} chapter(s) read · ${ed.major} major / ${ed.minor} minor note(s)`, (ed.flagged_chapters || []).length ? ` · ⚠️ still had notes on chapter(s) ${ed.flagged_chapters.join(', ')}` : ''),
          h('ul', { class: 'small' }, (ed.dimensions || []).map(d => h('li', null, `${d.label}: ${d.average}/10`))),
          (ed.earlier || []).length || (ed.unread || []).length ? h('ul', { class: 'small muted', 'data-testid': 'rp-editor-versions' },
            (ed.earlier || []).map(e => h('li', null, `Chapter ${e.chapter}: the editor read version ${e.read_version}; version ${e.version} (the planned details worked in, or earlier text put back) was not read again.`)),
            (ed.unread || []).length ? h('li', null, `Not read by the editor: chapter(s) ${ed.unread.join(', ')}.`) : null) : null,
          (ed.notes || []).length ? h('details', null, h('summary', null, 'Notes'), h('ul', { class: 'small' }, ed.notes.map(n => h('li', null, `Chapter ${n.chapter}: ${quoted(n.passage)} — ${n.why}`)))) : null]
          : h('p', { class: 'small muted' }, 'The editor did not read these chapter versions (the editor was off, or it could not read them: see the run’s notes).')),
      h('section', { class: 'card', 'data-testid': 'rp-planned' }, h('h2', null, '✅ Planned to page and 🔎 patterns'),
        h('p', { class: 'small' }, pl.missing ? [hazard({ code: 'PLANNED_MISSING' }, { open: plink('book'), openLabel: '📘 Open the book' }, { small: true }), ` ${pl.missing} planned item(s) not on the page`] : '✔ Everything planned is on the page.'),
        (pl.items || []).length ? h('ul', { class: 'small' }, pl.items.map(m => h('li', null, `Chapter ${m.number || m.chapter_id}: ${m.label}`))) : null,
        (pa.findings || []).length ? h('ul', { class: 'small' }, pa.findings.map(f => h('li', null, `${f.label}: ${f.count} (${f.per_1000} per 1 000 words)`, f.example ? h('span', { class: 'muted' }, ` — ${quoted(f.example)}`) : null))) : h('p', { class: 'small muted' }, 'No strong repeated habits.'))));
    const rd = rep.readability || {}; const rt = rd.totals || {};  // P24 readability and pacing (no AI)
    if (rt.grade != null) {
      const au = rd.audience || { label: 'Adult', grade: [5, 10] }; const pct = x => `${Math.round(100 * (x || 0))}%`;
      const sevIcon = { major: '⚠️ ', info: 'ⓘ ' };
      holder.appendChild(h('section', { class: 'card', 'data-testid': 'rp-readability' }, h('h2', null, '📖 Readability and pacing'),
        h('p', { class: 'small' }, `Reading level about grade ${rt.grade} (ease ${rt.ease}/100) · usual for ${au.label.toLowerCase()} readers: grade ${au.grade[0]}–${au.grade[1]}.`),
        h('p', { class: 'small' }, `${rt.avg_sentence} words per sentence · ${pct(rt.dialogue_share)} dialogue · ${rt.scenes} scene(s), about ${(rt.avg_scene || 0).toLocaleString()} words each · pace: ${rt.pace}.`),
        (rd.findings || []).length ? h('ul', { class: 'small', 'data-testid': 'rp-readability-findings' }, rd.findings.map(f => h('li', null, `${sevIcon[f.severity] || ''}${f.label}: ${f.detail} `, h('span', { class: 'muted' }, f.advice))))
          : h('p', { class: 'small muted' }, '✔ Reading level and pacing fit the audience.'),
        (rd.chapters || []).length > 1 ? h('details', null, h('summary', null, 'Per chapter'), h('div', { class: 'table-wrap' }, h('table', { class: 'rp-table' },
          h('thead', null, h('tr', null, ['Chapter', 'Grade', 'Words / sentence', 'Dialogue', 'Scenes', 'Pace'].map(x => h('th', null, x)))),
          h('tbody', null, rd.chapters.map(c => h('tr', null, h('th', { scope: 'row' }, String(c.number)), h('td', { class: 'num' }, c.grade ?? '–'),
            h('td', { class: 'num' }, c.avg_sentence || '–'), h('td', { class: 'num' }, pct(c.dialogue_share)), h('td', { class: 'num' }, String(c.scenes || 0)), h('td', null, c.pace || '–'))))))) : null));
    }
    const us = rep.usage || {};
    holder.appendChild(h('section', { class: 'card', 'data-testid': 'rp-words' }, h('h2', null, '📝 Words and 🤖 who did what'),
      h('p', { class: 'small' }, `Most of the book was written by ${us.writer || 'the author'}.`, us.same_ai_reviews ? h('span', { class: 'words-warn' }, ` ⚠️ ${us.same_ai_reviews} chapter review(s) by the writer itself.`) : null),
      h('div', { class: 'table-wrap' }, h('table', { class: 'rp-table' }, h('thead', null, h('tr', null, ['Chapter', 'Words', 'Written by', 'Reviewed by', 'Editor'].map(x => h('th', null, x)))),
        h('tbody', null, (wd.chapters || []).map((c, i) => { const u = (us.chapters || [])[i] || {};
          return h('tr', null, h('th', { scope: 'row' }, `${c.number}${c.title ? ` · ${c.title}` : ''}`), h('td', { class: 'num' }, c.words.toLocaleString(), c.under ? [' ', hazard({ code: 'CHAPTER_UNDER_TARGET', message: `${c.words} of about ${wd.per_chapter_target} words` }, {}, { small: true })] : null),
            h('td', null, u.writer || '–'), h('td', null, whoRead(u, 'reviewer', 'reviewed_version'), u.review_independent === false ? ' ⚠️' : ''), h('td', null, whoRead(u, 'editor', 'editor_version'), u.editor_independent === false ? ' ⚠️' : '')); }))))));
    const len = leniencyCard(ov.leniency, ov.calibration);
    if (len) holder.appendChild(len);
    holder.appendChild(askBox(rep));
    holder.appendChild(S7C.betaCard(s7c()));  // 📖 P23 beta reader (Section 7c)
    if ((ov.reports || []).length > 1) holder.appendChild(h('details', { class: 'card' }, h('summary', null, `Earlier reports (${ov.reports.length - 1})`),
      h('ul', { class: 'small' }, ov.reports.slice(1).map(r => h('li', null, `${fmtTime(r.at)} · overall ${r.overall ?? '–'} · ${r.reviewers || 0} reviewer(s)`)))));
  }
  await load();
}

/** P36: how generous each AI reviewer has been over time (vs the other reviewer and vs Akọwe's pattern check). */
function leniencyCard(rows, about) {
  if (!(rows || []).length) return null;
  const sign = v => (v == null ? '–' : `${v > 0 ? '+' : ''}${v}`);
  return h('section', { class: 'card', 'data-testid': 'rp-leniency', 'aria-labelledby': 'rp-len-h' },
    h('h2', { id: 'rp-len-h' }, '🎯 How generous each AI reviewer is'),
    h('p', { class: 'small' }, 'Points above (+) or below (−) the other reviewer of the same chapter or book, and above what Akọwe’s own pattern check allows. Measured over all your books. ', about || ''),
    h('div', { class: 'table-wrap' }, h('table', { class: 'rp-table' },
      h('thead', null, h('tr', null, ['AI', 'Reviews', 'Generosity', 'vs other reviewer', 'vs pattern check', 'Too-clean reviews', 'Scores lowered by'].map(x => h('th', null, x)))),
      h('tbody', null, rows.map(r => h('tr', { class: r.discount ? 'low' : '', 'data-family': r.family },
        h('th', { scope: 'row' }, r.name), h('td', { class: 'num' }, String(r.reviews)),
        h('td', null, `${sign(r.leniency)} · ${r.words}`), h('td', { class: 'num' }, sign(r.vs_other)), h('td', { class: 'num' }, sign(r.vs_audit)),
        h('td', { class: 'num' }, `${r.flagged}${r.reasked ? ` (${r.reasked} asked again)` : ''}`),
        h('td', { class: 'num' }, r.discount ? `${r.discount} point(s) ⚠️` : '–')))))));
}
/** 🧪 Make a variant: the same book (profile, idea, choices) made again with other pipeline switches. */
async function openVariantDialog(pid, title, opener) {
  const pf = await pipelineFields('var', { flags: (PIPE.info || { presets: { baseline: { flags: {} } } }).presets.baseline.flags });
  modal('🧪 Make a variant of this book', close => {
    const err = h('div', { 'aria-live': 'polite' });
    const go = h('button', { type: 'button', class: 'primary', 'data-testid': 'var-start', onclick: async () => {
      clear(err); go.disabled = true;
      const p = pf.get();
      try {
        const vb = await withAiCheck({ author_confirms: true, variant_of: { project_id: pid }, pipeline: p || { preset: 'full' } }, 'the variant');
        if (!vb) { go.disabled = false; return; }
        const run = await api('POST', '/autobook', { body: vb });
        close(); MB.run = run; await openMakeBook(opener, { runId: run.id });
      } catch (e) { err.appendChild(problemBox(toProblem(e, { book: title, step: 'Make a variant' }))); go.disabled = false; }
    } }, '⚡ Make the variant');
    const box = h('div', null, h('p', null, `A new, separate book made from the same profile, idea and ending choices as “${title}”, with the pipeline switches you choose below. Then ⚖️ compare the two blind.`),
      h('div', { class: 'consent-box', role: 'note' }, h('strong', null, '✋ Your consent for this run: '), 'pressing Make the variant starts a ⚡ Make a book for me run — the AI reviewer may approve the drafts it passes, for this one new book only. Your other books are never touched.'),
      pf.el, err, h('div', { class: 'form-actions' }, go));
    const d = pf.el; if (d.tagName === 'DETAILS') d.open = true;
    return box;
  });
}

const CMP = { books: null };
async function viewCompare(main, cid) {
  main.appendChild(h('div', { class: 'page-head' }, h('div', null, crumbs(['Your books', '#/'], ['My finished books', '#/shelf'], cid ? ['Compare versions', '#/compare'] : 'Compare versions', ...(cid ? ['Result'] : [])),
    h('h1', null, '⚖️ Compare versions')), h('div', { class: 'row' }, infoTip('Compare versions',
    h('p', null, 'Two books (for example a book and its 🧪 variant made with another pipeline) or two versions of a chapter are read by your AIs “blind”: each AI sees them as Version 1 and Version 2 in a random order and never learns which is which. Each scores both on the dimensions and picks the one it prefers.'),
    h('p', null, 'Afterwards Akọwe reveals which version was which and shows the median scores and the winner per dimension. An AI that wrote one of the versions is marked ⚠️ not independent.')))));
  const holder = h('div', { 'aria-live': 'polite' });
  main.appendChild(holder);
  if (cid) return compareResult(holder, cid);
  let shelf, list;
  try { [shelf, list] = await Promise.all([api('GET', '/shelf'), api('GET', '/compare')]); } catch (e) { holder.appendChild(problemBox(toProblem(e, { step: 'Compare versions' }), { retry: () => route() })); return; }
  const books = shelf.books || [];
  const q = new URLSearchParams((location.hash.split('?')[1] || ''));
  const opt = (sel, pick) => { for (const b of books) sel.appendChild(h('option', { value: b.project_id, selected: b.project_id === pick }, `${b.title}${b.pipeline && b.pipeline.preset && b.pipeline.preset !== 'full' ? ` (${b.pipeline.preset})` : ''} — ${fmtTime(b.exported_at)}`)); return sel; };
  const selA = opt(h('select', { id: 'cmp-a' }), q.get('a') || (books[0] || {}).project_id);
  const selB = opt(h('select', { id: 'cmp-b' }), q.get('b') || (books.find(b => b.project_id !== (q.get('a') || (books[0] || {}).project_id)) || {}).project_id);
  const scope = h('select', { id: 'cmp-scope' }, h('option', { value: 'book' }, 'The whole books'), h('option', { value: 'chapter' }, 'One chapter of each'));
  const chA = h('select', { id: 'cmp-cha' }); const chB = h('select', { id: 'cmp-chb' });
  const chRow = h('div', { class: 'grid-2', hidden: true }, h('div', { class: 'field' }, h('label', { for: 'cmp-cha' }, 'Chapter of A'), chA), h('div', { class: 'field' }, h('label', { for: 'cmp-chb' }, 'Chapter of B'), chB));
  const fillCh = async (sel, pid) => {
    clear(sel);
    try { const b = await api('GET', `/projects/${encodeURIComponent(pid)}/branches/main/book`);
      for (const c of ((b.steps || []).find(s => s.id === 'chapters') || {}).chapters || []) {
        const r = c.approved || c.prose; if (!r) continue;
        sel.appendChild(h('option', { value: `${r.record_id}@${r.version}` }, `${c.label || `Chapter ${c.chapter_id}`} (version ${r.version})`)); }
    } catch { /* the chapter list is optional */ }
  };
  scope.addEventListener('change', async () => { chRow.hidden = scope.value !== 'chapter'; if (!chRow.hidden) { await fillCh(chA, selA.value); await fillCh(chB, selB.value); } });
  selA.addEventListener('change', () => { if (!chRow.hidden) fillCh(chA, selA.value); });
  selB.addEventListener('change', () => { if (!chRow.hidden) fillCh(chB, selB.value); });
  const err = h('div', { 'aria-live': 'polite' });
  const prog = h('div');
  const go = h('button', { type: 'button', class: 'primary', 'data-testid': 'cmp-start', onclick: async () => {
    clear(err); clearFieldProblems(form);
    const body = { scope: scope.value, a: { project_id: selA.value }, b: { project_id: selB.value } };
    if (scope.value === 'chapter') {
      const [ra, va] = (chA.value || '').split('@'); const [rb, vb] = (chB.value || '').split('@');
      body.a.record_id = ra; body.a.version = va ? parseInt(va, 10) : undefined; body.b.record_id = rb; body.b.version = vb ? parseInt(vb, 10) : undefined;
    }
    go.disabled = true;
    try {
      const j = await api('POST', '/compare', { body });
      const end = await pollQualityJob(`/compare/job/${encodeURIComponent(j.id)}`, prog);
      if (end.status !== 'done') { clear(prog).appendChild(problemBox({ code: (end.error || {}).code || 'COMPARE_FAILED', message: (end.error || {}).message || end.phase, where: { step: 'Compare versions' } }, { retry: () => go.click() })); return; }
      go2(`#/compare/${encodeURIComponent(end.comparison_id)}`);
    } catch (e) {
      const rest = showFieldErrors(e, { a: selA, b: selB, scope }, { step: 'Compare versions' });
      if (rest.length || !(e instanceof ApiError)) err.appendChild(problemBox(toProblem(e, { step: 'Compare versions' })));
    } finally { go.disabled = false; }
  } }, '⚖️ Compare blind');
  const go2 = hash => { location.hash = hash; };
  const form = h('section', { class: 'card', 'data-testid': 'cmp-form' }, h('h2', null, 'Compare two versions'),
    books.length < 2 && !books.length ? h('p', { class: 'small muted' }, 'You need finished books to compare. Make one with ⚡, then a 🧪 variant of it.') : null,
    h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', { for: 'cmp-a' }, 'Version A'), selA), h('div', { class: 'field' }, h('label', { for: 'cmp-b' }, 'Version B'), selB)),
    h('div', { class: 'field' }, h('label', { for: 'cmp-scope' }, 'What to compare'), scope), chRow,
    h('p', { class: 'small muted' }, 'The AIs that did not write either version are asked first (up to three). They only see “Version 1” and “Version 2”.'),
    err, h('div', { class: 'row' }, go), prog);
  holder.appendChild(form);
  if ((list.items || []).length) holder.appendChild(h('section', { class: 'card' }, h('h2', null, 'Earlier comparisons'),
    h('ul', { class: 'small', 'data-testid': 'cmp-list' }, list.items.map(x => h('li', null, h('a', { href: `#/compare/${encodeURIComponent(x.id)}` }, `${x.a.title} vs ${x.b.title}`), ` · ${x.scope} · ${fmtTime(x.at)} · winner: ${x.winner === 'tie' ? 'tie' : x.winner === 'A' ? x.a.title : x.winner === 'B' ? x.b.title : '–'}`)))));
}
async function compareResult(holder, cid) {
  let r;
  try { r = await api('GET', `/compare/${encodeURIComponent(cid)}`); } catch (e) { holder.appendChild(problemBox(toProblem(e, { step: 'Compare versions' }), { retry: () => route() })); return; }
  const ag = r.aggregate || {};
  const name = side => `${side} · “${r[side.toLowerCase()].title}”`;
  const win = ag.winner === 'tie' ? 'A tie' : ag.winner ? `${name(ag.winner)} wins` : 'No result';
  holder.appendChild(h('section', { class: 'card cmp-head', 'data-testid': 'cmp-result' }, h('h2', null, `🏆 ${win}`),
    h('p', { class: 'small muted' }, `${r.scope === 'book' ? 'Whole books' : 'One chapter each'} · ${fmtTime(r.at)} · ${ag.reviewers || 0} AI reviewer(s), ${ag.independent || 0} independent`),
    h('div', { class: 'grid-2' }, ['A', 'B'].map(sd => { const x = r[sd.toLowerCase()]; return h('div', { class: `cmp-side cmp-${sd}` }, h('strong', null, name(sd)), h('p', { class: 'small' }, `🧪 ${x.pipeline || ''}`), h('p', { class: 'small muted' }, `${(x.words || 0).toLocaleString()} words · median average ${(ag.average || {})[sd] ?? '–'}/10 · preferred by ${(ag.votes || {})[sd] || 0}`), x.project_id ? h('a', { class: 'small', href: link('p', x.project_id, x.branch_id || 'main', 'report') }, '📊 its report') : null); }))));
  for (const w of r.warnings || []) holder.appendChild(h('p', { class: /⚠️/.test(w) ? 'words-warn' : 'small muted', role: 'note' }, /independent/.test(w) ? [hazard({ code: 'COMPARE_NOT_INDEPENDENT', message: w }, {}, { small: true }), ' '] : null, w));
  const t = h('table', { class: 'rp-table', 'data-testid': 'cmp-table' }, h('caption', { class: 'small' }, 'Median scores of the reviewers (1-10) and the winner per dimension.'),
    h('thead', null, h('tr', null, h('th', null, 'Dimension'), h('th', null, 'A'), h('th', null, 'B'), h('th', null, 'Winner'))),
    h('tbody', null, (ag.dimensions || []).filter(d => d.n).map(d => h('tr', { class: `win-${d.winner}` }, h('th', { scope: 'row' }, d.label), scoreCell(d.a, d.winner === 'A' ? 'strong' : ''), scoreCell(d.b, d.winner === 'B' ? 'strong' : ''),
      h('td', null, d.winner === 'tie' ? '= tie' : `${d.winner} (+${Math.abs(d.diff)})`)))));
  holder.appendChild(h('section', { class: 'card' }, h('h2', null, 'Per dimension'), h('div', { class: 'table-wrap' }, t),
    h('p', { class: 'small' }, `Dimensions won: A ${(ag.wins || {}).A || 0} · B ${(ag.wins || {}).B || 0} · tie ${(ag.wins || {}).tie || 0}`)));
  holder.appendChild(h('section', { class: 'card', 'data-testid': 'cmp-reveal' }, h('h2', null, '🔓 Who saw what (revealed)'),
    h('ul', null, (r.reviews || []).map(x => h('li', null, h('strong', null, x.name), x.status !== 'done' ? [' — ', hazard({ code: 'COMPARE_FAILED', message: `${x.name}: ${x.error}` }, {}, { small: true }), ` could not compare (${x.error})`]
      : [` saw Version 1 = ${x.mapping.version_1}, Version 2 = ${x.mapping.version_2}; preferred ${x.revealed.preferred === 'tie' ? 'neither (tie)' : x.revealed.preferred || '–'}`, x.independent ? '' : ` ⚠️ wrote ${(x.wrote || []).join(' and ')}`,
        (x.answer.reasons || []).length ? h('ul', { class: 'small' }, x.answer.reasons.map(t2 => h('li', null, t2))) : null])))));
  holder.appendChild(h('p', null, h('a', { class: 'btn', href: '#/compare' }, '⚖️ Another comparison')));
}

/** Book page: 📊 report, 🧪 variant, ⚖️ compare (P13/P14) and 📏 length (P15). */
function bookSection5Card(book) {
  const title = profileOf().title || S.project.name;
  const box = h('section', { class: 'card s5-card', 'aria-labelledby': 's5-h', 'data-testid': 'book-s5' },
    h('h2', { id: 's5-h' }, '📊 Report, variants and length ', infoTip('Book report', ...TIP_REPORT())));
  const prof = profileOf();
  const L = LENGTH_INFO[prof.length || 'short_story'] || LENGTH_INFO.short_story;
  box.appendChild(h('p', { class: 'small' }, h('strong', null, '📏 Length: '), `${L[0]} — ${L[1]}`, ' ', infoTip('Length', ...LENGTH_TIP())));
  const body = h('div', null);
  box.appendChild(body);
  (async () => {
    let ov = null;
    try { ov = await api('GET', bpath('/report')); } catch { ov = null; }
    const rep = ov && ov.latest;
    put(body, h('p', { class: 'small' }, rep ? [`Latest report ${fmtTime(rep.at)}: overall ${rep.aggregate.overall ?? '–'}/10 from ${rep.aggregate.reviewers || 0} AI reviewer(s)`, ov.stale ? [' ', hazard({ code: 'REPORT_STALE' }, { open: plink('report'), openLabel: '📊 Open the report' }, { small: true })] : null] : 'No report yet.'),
      h('div', { class: 'row' }, h('a', { class: 'btn small primary', href: plink('report'), 'data-testid': 'open-report' }, rep ? '📊 Book report' : '📊 Make the book report'),
        h('button', { type: 'button', class: 'small', 'data-testid': 'make-variant', onclick: ev => openVariantDialog(S.pid, title, ev.currentTarget) }, '🧪 Make a variant'),
        h('a', { class: 'btn small', href: `#/compare?a=${encodeURIComponent(S.pid)}` }, '⚖️ Compare')));
  })();
  return box;
}

/* ======================================================================= 💾 P20 save the book, 📂 P21 open a saved book / 🔁 rerun */
const TIP_SAVE = () => [h('p', null, 'Akọwe keeps every book inside itself. 💾 Save also writes a copy into your books folder: one folder per book with the finished book (PDF, EPUB, Word), every chapter as a text file, the book bible, the reports and the book’s log.'),
  h('p', null, 'The file book.akowe in that folder is the whole book in one file: 📂 Open a saved book brings it back as a new book (also on another computer), and 🔁 Rerun makes a new book from its book bible.'),
  h('p', null, 'With auto-save on, Akọwe saves by itself while a book is being made (at most every 2 minutes, and after each step) and when it is finished, paused or stopped.')];
const TIP_RERUN = () => [h('p', null, 'The book bible is everything a book is built on: the book profile, the ending and style choices, the characters with their character sheets and voice cards, the places and world, the story rules and world texture, and the premise, main plot, chapter outline and scene cards.'),
  h('p', null, '🔁 Rerun makes a NEW book from it: the same characters, world and (if you keep it) plan, with new chapters written by the AI. The book it came from is never changed.')];
const BIBLE_PATH = (pid, branch) => `/projects/${encodeURIComponent(pid)}/branches/${encodeURIComponent(branch || 'main')}`;
/** A save that partly worked (newer servers): `warning` (plain words) and/or `skipped` (file names that were not written).
 *  Returns "⚠ Saved, except Book/Title.pdf (open in another program — close it and save again)" or '' when all went well. */
function saveWarningText(last) {
  if (!last) return '';
  const skipped = Array.isArray(last.skipped) ? last.skipped.filter(x => typeof x === 'string' && x) : [];
  const warning = typeof last.warning === 'string' ? last.warning.trim() : '';
  if (!skipped.length && !warning) return '';
  const names = skipped.length > 4 ? `${skipped.slice(0, 4).join(', ')} and ${skipped.length - 4} more` : skipped.join(', ');
  if (names) return `⚠ Saved, except ${names}${warning ? ` (${warning})` : ''}`;
  return `⚠ Saved, but: ${warning}`;
}
/** “Saved to …” (or ⚠️ not saved) for the last save of a book. */
function savedLine(st, { pid, branch } = {}) {
  const last = st && st.last;
  const job = st && st.job && st.job.state === 'running' ? st.job : null;
  if (job) return h('span', { class: 'small', 'data-testid': 'saved-line' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` 💾 Saving… ${job.phase || ''}`);
  if (!last) return h('span', { class: 'small muted', 'data-testid': 'saved-line' }, '💾 Not saved to your books folder yet.');
  if (!last.ok) {
    return h('span', { class: 'small', 'data-testid': 'saved-line' }, hazard(Object.assign({ where: { step: '💾 Save the book' } }, last.problem || { code: 'SAVE_FAILED' }), { retry: pid ? () => runSave(pid, branch) : null, retryLabel: '💾 Save again', settings: true }, { small: true }),
      ` Not saved at ${fmtTime(last.at)}: ${(last.problem && last.problem.message) || 'the save failed'}.`);
  }
  const warn = saveWarningText(last);
  return h('span', { class: 'small', 'data-testid': 'saved-line' }, `💾 Saved to `, h('code', { class: 'save-path' }, last.path), ` · ${fmtTime(last.at)}${last.kind === 'auto' ? ' (automatic)' : ''}${last.finished ? '' : ' · progress (not finished)'}`,
    warn ? h('span', { class: 'save-warn', role: 'status', 'data-testid': 'save-warning' }, warn) : null);
}
/** 📂 Show the folder (this computer) or 📋 copy its path (another device). */
function folderButton(path, local, pid, branch) {
  if (!path) return null;
  if (local === false) return h('button', { type: 'button', class: 'small', onclick: () => copyText(path, 'Folder path copied') }, '📋 Copy the folder path');
  return h('button', { type: 'button', class: 'small', 'data-testid': 'show-folder', onclick: async ev => {
    const b = ev.currentTarget; b.disabled = true;
    try { const r = await api('POST', '/books-folder/show', { body: pid ? { project_id: pid, branch_id: branch || 'main' } : {} }); toast(`Opened ${r.path}`); }
    catch (e) { const p = toProblem(e, { step: '📂 Show the folder' }); toast(`${p.title}: ${p.message}`); }
    b.disabled = false;
  } }, '📂 Open folder');
}
/** Save now and wait for it (at most 3 minutes); resolves with the save status. */
async function runSave(pid, branch, onState) {
  const path = `${BIBLE_PATH(pid, branch)}/save`;
  const job = await api('POST', path);
  const since = (job && job.started_at) || '';
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < 180000) {
    await new Promise(r => setTimeout(r, 400));
    st = await api('GET', path);
    if (onState) onState(st);
    // done when no save is running AND the result is this save's (not the one from before the press)
    if ((!st.job || st.job.state !== 'running') && (!since || (st.last && String(st.last.at || '') >= since))) break;
  }
  return st;
}
/** The words of a finished save that stay on screen next to the 💾 button (the toast alone was easy to miss). */
function savedNowText(last) {
  const n = last.files ? `${last.files} file(s)` : 'the book';
  return `✔ Saved ${n} just now (${fmtTime(last.at)})${last.warning ? ` — ${last.warning}` : ''}`;
}
/** The 💾 Save button with its “Saved to …” line (book page, run window, shelf). */
function saveBox(pid, branch, { label = '💾 Save', primary = false, testid = 'save-btn' } = {}) {
  const line = h('span', { class: 'save-line', 'aria-live': 'polite' });
  const extra = h('span', { class: 'row save-extra' });
  const done = h('span', { class: 'save-done small', role: 'status', 'aria-live': 'polite', 'data-testid': 'save-done' });
  const show = st => { put(clear(line), savedLine(st, { pid, branch })); put(clear(extra), st && st.last && st.last.ok ? folderButton(st.last.path, st.local, pid, branch) : null); };
  const btn = h('button', { type: 'button', class: `small${primary ? ' primary' : ''}`, 'data-testid': testid, title: 'Save this book into its folder in your books folder (Settings › 📁 Where books are saved)', onclick: async () => {
    btn.disabled = true; btn.textContent = '💾 Saving…'; clear(done);
    try {
      const st = await runSave(pid, branch, show);
      show(st);
      if (st && st.last && st.last.ok) {
        done.textContent = savedNowText(st.last);
        toast(saveWarningText(st.last) || `💾 Saved to ${st.last.path}`, 6000);
      }
    } catch (e) { put(clear(line), problemBox(toProblem(e, { step: '💾 Save the book' }), { settings: true })); }
    btn.disabled = false; btn.textContent = label;
  } }, label);
  (async () => { try { show(await api('GET', `${BIBLE_PATH(pid, branch)}/save`)); } catch { /* the line stays empty */ } })();
  return h('span', { class: 'save-box row', 'data-testid': 'save-box' }, btn, done, line, extra);
}
/** Top bar 💾: save the open book, report in a toast (a problem opens a box). */
async function quickSave(btn) {
  if (!S.pid) return;
  btn.disabled = true; toast('💾 Saving the book…');
  try {
    const st = await runSave(S.pid, S.branch);
    if (st && st.last && st.last.ok) toast(saveWarningText(st.last) || `${savedNowText(st.last)} — ${st.last.path}`, 6000);
    else modal('💾 The book was not saved', () => problemBox(toProblem(Object.assign({ where: { book: profileOf().title || S.project.name, step: '💾 Save the book' } }, (st && st.last && st.last.problem) || { code: 'SAVE_FAILED' })), { settings: true }));
  } catch (e) { modal('💾 The book was not saved', () => problemBox(toProblem(e, { step: '💾 Save the book' }), { settings: true })); }
  btn.disabled = false;
}
/** Settings › 📁 Where books are saved. */
function booksFolderCard() {
  const box = h('div', { 'aria-live': 'polite' });
  const card = h('section', { class: 'card', 'aria-labelledby': 'bf-h', 'data-testid': 'books-folder' }, h('h2', { id: 'bf-h' }, '📁 Where books are saved ', infoTip('Saving books', ...TIP_SAVE())),
    h('p', { class: 'small' }, 'Every book gets its own folder here: the finished book, the chapters, the book bible, the reports and the log. Pick a folder you back up (for example in Documents).'), box);
  const load = async () => {
    let cur;
    try { cur = await api('GET', '/settings/books-folder'); } catch (e) { put(clear(box), problemBox(toProblem(e, { step: 'Settings › Where books are saved' }), { retry: load })); return; }
    const path = h('input', { type: 'text', id: 'bf-path', value: cur.path, spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'bf-path-h', class: 'bf-path' });
    const auto = h('input', { type: 'checkbox', id: 'bf-auto', checked: !!cur.auto_save });
    const out = h('div', { 'aria-live': 'polite' });
    const save = async body => {
      clearFieldProblems(card); clear(out);
      try { await api('PUT', '/settings/books-folder', { body }); toast('Saved'); load(); }
      catch (e) { const rest = showFieldErrors(e, { path, auto_save: auto }, { step: 'Settings › Where books are saved' }); if (rest.length) out.appendChild(problemBox(toProblem(e, { step: 'Settings › Where books are saved' }))); }
    };
    put(clear(box),
      h('div', { class: 'field' }, h('label', { for: 'bf-path' }, 'Books folder'), path,
        h('span', { class: 'hint', id: 'bf-path-h' }, `The full path of a folder on this computer. Default: ${cur.default_path}`)),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'small primary', 'data-testid': 'bf-save', onclick: () => save({ path: path.value.trim() }) }, 'Save'),
        cur.custom ? h('button', { type: 'button', class: 'small', onclick: () => save({ path: '' }) }, '↩ Use the default folder') : null,
        cur.local ? folderButton(cur.path, true) : h('button', { type: 'button', class: 'small', onclick: () => copyText(cur.path, 'Folder path copied') }, '📋 Copy the folder path')),
      cur.writable ? h('p', { class: 'small', 'data-testid': 'bf-ok' }, '✔ Akọwe can write there.') : h('div', null, problemBox(cur.problem || { code: 'SAVE_FOLDER_NOT_WRITABLE' })),
      h('div', { class: 'field row' }, auto, h('label', { for: 'bf-auto' }, ' Save books automatically (on by default): after each finished step, when a book is finished, and every 10 minutes when a book changed'),
        h('button', { type: 'button', class: 'small', onclick: () => save({ auto_save: auto.checked }) }, 'Save')),
      cur.local ? null : h('p', { class: 'small muted' }, '⚠️ You use Akọwe from another device: folders can only be opened on the computer Akọwe runs on.'),
      out);
  };
  load();
  return card;
}
/** 🎨 Pictures (Character Forge): AutoInjector's bridge address and token for POST /image/request. */
function pictureBridgeCard() {
  const box = h('div', { 'aria-live': 'polite' });
  const card = h('section', { class: 'card', 'aria-labelledby': 'pb-h', 'data-testid': 'picture-bridge' }, h('h2', { id: 'pb-h' }, '🎨 Pictures (Character Forge)'),
    h('p', { class: 'small' }, 'Portraits and the ten reference views are made by AutoInjector (Stable Diffusion or ChatGPT). Leave the address empty to use the default; paste AutoInjector’s bridge token if it uses one.'), box);
  const load = async () => {
    let cur;
    try { cur = await api('GET', '/settings/image-bridge'); } catch (e) { put(clear(box), problemBox(toProblem(e, { step: 'Settings › Pictures' }), { retry: load })); return; }
    const url = h('input', { type: 'text', id: 'pb-url', value: cur.url || '', placeholder: cur.default_url, spellcheck: 'false', autocomplete: 'off' });
    const tok = h('input', { type: 'password', id: 'pb-token', value: '', placeholder: cur.has_token ? '•••••• (saved)' : 'bridge token (optional)', autocomplete: 'off' });
    const out = h('div', { 'aria-live': 'polite' });
    const save = async () => {
      clear(out);
      const body = { url: url.value.trim() };
      if (tok.value.trim()) body.token = tok.value.trim();
      try { await api('PUT', '/settings/image-bridge', { body }); toast('Saved'); load(); }
      catch (e) { out.appendChild(problemBox(toProblem(e, { step: 'Settings › Pictures' }))); }
    };
    put(clear(box),
      h('div', { class: 'field' }, h('label', { for: 'pb-url' }, 'AutoInjector bridge address'), url, h('span', { class: 'hint' }, `Only this computer (127.0.0.1 / localhost). Akọwe asks: ${(cur.uses || []).join(', ') || cur.default_url}`)),
      h('div', { class: 'field' }, h('label', { for: 'pb-token' }, 'Bridge token'), tok),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'small primary', 'data-testid': 'pb-save', onclick: save }, 'Save'),
        cur.has_token ? h('button', { type: 'button', class: 'small', onclick: async () => { try { await api('PUT', '/settings/image-bridge', { body: { token: null } }); toast('Token removed'); load(); } catch (e) { out.appendChild(problemBox(toProblem(e))); } } }, 'Remove the token') : null),
      out);
  };
  load();
  return card;
}
/** Book page: 💾 saved copy, 📖 book bible, 🔁 rerun, and for an opened book ▶ continue / resume. */
function bookSaveCard(redraw) {
  const pid = S.pid; const branch = S.branch;
  const title = profileOf().title || S.project.name;
  const opened = h('div', { 'data-testid': 'opened-box' });
  const card = h('section', { class: 'card save-card', 'aria-labelledby': 'sv-h', 'data-testid': 'book-save' },
    h('h2', { id: 'sv-h' }, '💾 Saved copy and book bible ', infoTip('Saving books', ...TIP_SAVE())),
    h('div', { class: 'row' }, saveBox(pid, branch, { primary: true, testid: 'book-save-btn' })),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'small', 'data-testid': 'rerun-btn', onclick: ev => openRerunDialog({ project_id: pid, branch_id: branch }, title, ev.currentTarget) }, '🔁 Rerun from the book bible'), infoTip('Rerun from the book bible', ...TIP_RERUN()),
      h('button', { type: 'button', class: 'small', onclick: () => downloadBible(pid, branch, 'json', title) }, '⬇ book-bible.json'),
      h('button', { type: 'button', class: 'small', onclick: () => downloadBible(pid, branch, 'md', title) }, '⬇ book-bible.md')),
    opened);
  (async () => {
    let st;
    try { st = await api('GET', `${BIBLE_PATH(pid, branch)}/save`); } catch { return; }
    const o = st.opened || {};
    if (o.finished) return;
    const run = o.resumable_run;
    put(clear(opened), h('div', { class: 'state ask opened-note' },
      h('p', null, run ? `▶ This book’s Make-a-book run stopped (${run.phase || run.status}).` : ['This book is not finished', o.next_step ? [' — next step: ', h('span', { 'data-testid': 'opened-next' }, o.next_step)] : null, '.']),
      h('div', { class: 'row' },
        run ? h('button', { type: 'button', class: 'small', 'data-testid': 'resume-saved-run', onclick: async ev => {
          ev.currentTarget.disabled = true;
          try { const r = await api('POST', `/autobook/${encodeURIComponent(run.id)}/resume`); openMakeBook(ev.currentTarget, { runId: r.id }); }
          catch (e) { opened.appendChild(problemBox(toProblem(e, { step: 'Resume the saved run' }))); }
        } }, '▶ Resume the saved run') : null,
        h('button', { type: 'button', class: 'small primary', 'data-testid': 'continue-book', onclick: ev => continueBook(pid, title, ev.currentTarget) }, '▶ Continue making this book'),
        infoTip('Continue making this book', h('p', null, 'The AI does the steps that are left (reviewed and approved under your consent for that run). Everything already done — characters, plan, approved chapters — is kept and skipped.')))));
  })();
  return card;
}
async function downloadBible(pid, branch, fmt, title) {
  try {
    const blob = await api('GET', `${BIBLE_PATH(pid, branch)}/bible?format=${fmt}&download=1`, { blob: true });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `${safeFileStem(title) || 'Book'} - book-bible.${fmt}` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) { const p = toProblem(e, { step: '📖 Book bible' }); toast(`${p.title}: ${p.message}`); }
}
async function continueBook(pid, title, opener) {
  const ok = await choiceDialog('▶ Continue making this book?', h('div', null,
    h('p', null, `The AI does the steps of “${title}” that are left. Pressing Continue is your consent for this run: the AI reviewer approves the drafts it passes, for this book and this run only (every approval is in the book journal).`),
    h('p', { class: 'small' }, 'What is already done is kept and skipped.')), [{ id: 'go', label: '▶ Continue' }]);
  if (ok !== 'go') return;
  try {
    const cb = await withAiCheck({ author_confirms: true, continue_project: pid }, 'the run');
    if (!cb) return;
    const r = await api('POST', '/autobook', { body: cb });
    openMakeBook(opener, { runId: r.id });
  } catch (e) { modal('▶ Continue making this book', () => problemBox(toProblem(e, { book: title, step: 'Continue making this book' }))); }
}
/** 🔁 Rerun from the book bible: what is reused, keep the plan?, consent, start. spec: {project_id}|{folder}|{bible_id}. */
function openRerunDialog(spec, title, opener, summary = null) {
  modal('🔁 Make a new book from the book bible', close => {
    const body = h('div', { 'data-testid': 'rerun-dialog' }, loadingState('Reading the book bible…'));
    const keep = h('input', { type: 'checkbox', id: 'rr-keep', checked: true });
    const msg = h('div', { 'aria-live': 'polite' });
    const draw = sm => {
      put(clear(body),
        h('p', null, `A NEW book is made from the book bible of “${sm.title || title || 'your book'}”. The book it comes from is not changed.`, ' ', infoTip('Rerun from the book bible', ...TIP_RERUN())),
        h('ul', { class: 'small rr-what' },
          h('li', null, `🎭 ${sm.characters.length} character(s)${sm.characters.length ? `: ${sm.characters.join(', ')}` : ''} — with ${sm.sheets} character sheet(s) and voice card(s)`),
          h('li', null, `🌍 ${sm.canon} place(s) and world entr${sm.canon === 1 ? 'y' : 'ies'}, ${sm.story_rules} story rule(s), ${sm.world_texture} world detail(s)`),
          h('li', null, sm.plan.length ? `🧭 The plan: ${sm.plan.map(p => ({ premise: 'premise', main_plot: 'main plot', outline: 'chapter outline' }[p] || p)).join(', ')}${sm.chapters ? ` (${sm.chapters} chapters)` : ''}${sm.scene_cards ? `, scene cards of ${sm.scene_cards} chapter(s)` : ''}` : '🧭 No plan saved: the AI writes a new premise, plot and outline'),
          h('li', null, `📏 ${(LENGTH_INFO[sm.length] || [sm.length || 'Short story'])[0]}${sm.genre ? ` · ${sm.genre}` : ''}`)),
        sm.plan.length ? h('div', { class: 'field row' }, keep, h('label', { for: 'rr-keep' }, ' Keep the same plan (premise, main plot, chapter outline and scene cards)'),
          h('span', { class: 'hint' }, 'Untick it to let the AI write a new premise, plot and outline for the same characters and world.')) : null,
        h('p', { class: 'small mb-consent' }, 'Pressing 🔁 Start is your consent for this run: the saved characters, places and plan come into the new book as drafts and the AI reviewer approves each one there under this consent (every approval is in the book journal). The chapters are written new.'),
        msg,
        h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'primary', 'data-testid': 'rerun-start', onclick: async ev => {
          const btn = ev.currentTarget; btn.disabled = true; clear(msg);
          try {
            const rb = await withAiCheck({ author_confirms: true, from_bible: spec, reuse_plan: !!(sm.plan.length && keep.checked) }, 'the rerun');
            if (!rb) { btn.disabled = false; return; }
            const r = await api('POST', '/autobook', { body: rb });
            close(); openMakeBook(opener, { runId: r.id });
          } catch (e) { msg.appendChild(problemBox(toProblem(e, { step: '🔁 Rerun from the book bible' }))); btn.disabled = false; }
        } }, '🔁 Start'), h('button', { type: 'button', onclick: close }, 'Cancel')));
    };
    (async () => {
      if (summary) { draw(summary); return; }
      try {
        const r = spec.project_id ? await api('GET', `${BIBLE_PATH(spec.project_id, spec.branch_id)}/bible`)
          : spec.folder ? await api('GET', `/books-folder/bible?folder=${encodeURIComponent(spec.folder)}`)
            : await api('GET', `/books/bible/${encodeURIComponent(spec.bible_id)}`);
        draw(r.summary);
      } catch (e) { put(clear(body), problemBox(toProblem(e, { step: '🔁 Rerun from the book bible' }))); }
    })();
    return body;
  });
}
/** 📂 Open a saved book: the books folder list (this computer) and an upload (.akowe or book-bible.json). */
function openSavedBookDialog(opener) {
  modal('📂 Open a saved book', close => {
    const list = h('div', { 'data-testid': 'open-list' }, loadingState('Looking in your books folder…'));
    const msg = h('div', { 'aria-live': 'polite' });
    // again(mode) repeats the same open with mode 'update' | 'copy' (the book is already on this computer)
    const afterOpen = async (r, again) => {
      if (r && r.needs_choice && again) {
        const ex = r.existing || {}; const sv = r.saved || {};
        const pick = await choiceDialog('This book is already in Your books', h('div', { 'data-testid': 'open-choice' },
          h('p', null, `“${ex.name}” is already on this computer. Update it to the saved book, or open the saved book as a copy next to it?`),
          h('ul', { class: 'small' },
            h('li', null, `The saved book: ${sv.saved_at ? `saved ${fmtTime(sv.saved_at)}` : 'saved'}`),
            h('li', null, `The one you have: ${ex.updated_at ? `last changed ${fmtTime(ex.updated_at)}` : 'on this computer'}`)),
          h('p', { class: 'small muted' }, '⟳ Update replaces the book you have with the saved one (same book, same folder). 📄 A copy leaves the book you have as it is.')),
        [{ id: 'update', label: '⟳ Update the one I have' }, { id: 'copy', label: '📄 Open as a copy' }]);
        if (pick !== 'update' && pick !== 'copy') return;
        try { put(clear(msg), loadingState(pick === 'update' ? 'Updating the book…' : 'Opening a copy…')); await afterOpen(await again(pick)); }
        catch (e) { put(clear(msg), problemBox(toProblem(e, { step: '📂 Open a saved book' }))); }
        return;
      }
      close();
      if (r.kind === 'bible') { openRerunDialog({ bible_id: r.bible_id }, r.summary.title, opener, r.summary); return; }
      toast(r.message || 'Opened');
      go(link('p', r.project_id, r.branch_id || 'main', 'book'));
    };
    let maxUpload = 64 * 1024 * 1024;
    const load = async () => {
      put(clear(list), loadingState('Looking in your books folder…'));
      let out;
      try { out = await api('GET', '/books-folder'); }
      catch (e) { put(clear(list), problemBox(toProblem(e, { step: '📂 Open a saved book' }), { retry: load })); return; }
      const rows = out.folders || [];
      if (out.max_upload) maxUpload = out.max_upload;
      put(clear(list), h('p', { class: 'small' }, 'Books folder: ', h('code', null, out.path), ' ', h('button', { type: 'button', class: 'small', onclick: load }, '🔄 Refresh')),
        rows.length ? h('ul', { class: 'record-list open-list' }, rows.map(f => h('li', { class: 'record-item', 'data-folder': f.name },
          h('div', { class: 'r-main' }, h('span', { class: 'r-title' }, f.title),
            h('div', { class: 'r-meta' }, `${f.saved_at ? `saved ${fmtTime(f.saved_at)}` : 'saved'} · ${f.finished ? '✔ finished' : '⏳ not finished'}${f.chapters ? ` · ${f.chapters} chapter(s)` : ''}${f.in_library ? ' · this book is also in Your books' : ''}`)),
          h('div', { class: 'r-badges' },
            f.has_package ? h('button', { type: 'button', class: 'small primary', 'data-testid': 'open-folder-btn', onclick: async ev => {
              const b = ev.currentTarget; b.disabled = true; clear(msg);
              const openIt = mode => api('POST', '/books-folder/open', { body: Object.assign({ folder: f.name }, mode ? { mode } : {}) });
              try { await afterOpen(await openIt(), openIt); }
              catch (e) { msg.appendChild(problemBox(toProblem(e, { book: f.title, step: '📂 Open a saved book' }))); b.disabled = false; }
            } }, '📂 Open') : null,
            f.has_bible ? h('button', { type: 'button', class: 'small', 'data-testid': 'rerun-folder-btn', onclick: () => { close(); openRerunDialog({ folder: f.name }, f.title, opener); } }, '🔁 Rerun') : null))))
          : stateBox('empty', 'No saved book in this folder yet', h('p', null, '💾 Save a book first, or upload a book.akowe file below.')));
    };
    const file = h('input', { type: 'file', id: 'open-file', accept: '.akowe,.bookforge,.json,application/zip,application/json', 'data-testid': 'open-file' });
    const up = h('button', { type: 'button', class: 'primary small', 'data-testid': 'open-upload', onclick: async () => {
      clear(msg);
      const f = file.files && file.files[0];
      if (!f) { markFieldProblem(file, { code: 'MISSING_INPUT', message: 'Choose a book.akowe or book-bible.json file first.' }, { step: '📂 Open a saved book', field: 'File' }); return; }
      if (f.size > maxUpload) { markFieldProblem(file, { code: 'OPEN_TOO_LARGE', message: `This file is larger than ${Math.round(maxUpload / 1048576)} MB, too big to upload. Open it from its folder instead (below): type or choose the book's folder.` }, { step: '📂 Open a saved book', field: 'File' }); pathIn.focus(); return; }
      up.disabled = true; put(msg, loadingState(`Opening ${f.name}…`));
      const send = mode => { const fd = new FormData(); fd.append('file', f, f.name); return api('POST', `/books/open${mode ? `?mode=${mode}` : ''}`, { raw: fd }); };
      try { const r = await send(); clear(msg); await afterOpen(r, send); up.disabled = false; }
      catch (e) { put(clear(msg), problemBox(toProblem(e, { step: '📂 Open a saved book', field: f.name }))); up.disabled = false; }
    } }, '📂 Open this file');
    // 📂 a book straight from its folder on this computer (no upload: for books bigger than the upload limit)
    const pathIn = h('input', { type: 'text', id: 'open-path', spellcheck: 'false', autocomplete: 'off', class: 'bf-path', 'data-testid': 'open-path', placeholder: 'D:\\Books\\My book (ab12cd)  or  …/book.akowe' });
    const byPath = h('button', { type: 'button', class: 'small primary', 'data-testid': 'open-path-btn', onclick: async () => {
      clear(msg);
      const p = pathIn.value.trim();
      if (!p) { markFieldProblem(pathIn, { code: 'MISSING_INPUT', message: 'Type the full path of the book\'s folder, or press 📁 Choose the folder.' }, { step: '📂 Open a saved book', field: 'Folder' }); return; }
      byPath.disabled = true; put(msg, loadingState('Opening the book from its folder…'));
      const openIt = mode => api('POST', '/books/open-path', { body: Object.assign({ path: p }, mode ? { mode } : {}) });
      try { const r = await openIt(); clear(msg); await afterOpen(r, openIt); }
      catch (e) { put(clear(msg), problemBox(toProblem(e, { step: '📂 Open a saved book', field: 'Folder' }))); }
      byPath.disabled = false;
    } }, '📂 Open from this folder');
    const choose = h('button', { type: 'button', class: 'small', 'data-testid': 'open-choose', onclick: async () => {
      clear(msg); choose.disabled = true;
      try { const r = await api('POST', '/books/choose-path', { body: {} }); if (r && r.path) { pathIn.value = r.path; byPath.focus(); } }
      catch (e) { msg.appendChild(problemBox(toProblem(e, { step: '📂 Choose the folder' }))); }
      choose.disabled = false;
    } }, '📁 Choose the folder (AutoInjector)');
    load();
    return h('div', { 'data-testid': 'open-dialog' },
      h('p', null, 'A saved book opens as a new book. When the same book is already in Your books, Akọwe asks: update the one you have, or open a copy. An unfinished book can be continued. ', infoTip('Opening saved books', ...TIP_SAVE())),
      h('h3', null, 'From your books folder'), list,
      h('h3', null, 'From a file'),
      h('div', { class: 'field' }, h('label', { for: 'open-file' }, 'A book.akowe file (the whole book) or a book-bible.json (to make a new book from it)'), file),
      h('div', { class: 'row' }, up),
      h('h3', null, 'From a folder on this computer'),
      h('div', { class: 'field' }, h('label', { for: 'open-path' }, 'The saved book\'s folder (or its book.akowe file): no upload, so books of any size open'), pathIn),
      h('div', { class: 'row' }, byPath, choose), msg);
  }, { wide: true });
}
/** Run window: 💾 where the book is saved (auto-save), with Save now. */
function runSaveLine(r) {
  if (!r.project_id) return null;
  const sv = r.save || {};
  return h('div', { class: 'small mb-save row', 'data-testid': 'mb-save' }, savedLine(sv, { pid: r.project_id, branch: r.branch_id || 'main' }),
    sv.auto_save === false ? h('span', { class: 'muted' }, ' · auto-save is off (Settings › 📁 Where books are saved)') : (sv.last ? null : h('span', { class: 'muted' }, ' · saved automatically as it goes')),
    h('button', { type: 'button', class: 'small', 'data-testid': 'mb-save-btn', onclick: async ev => {
      const b = ev.currentTarget; b.disabled = true;
      try { const st = await runSave(r.project_id, r.branch_id || 'main'); if (st && st.last && st.last.ok) toast(saveWarningText(st.last) || `Saved to ${st.last.path}`); }
      catch (e) { const p = toProblem(e, { step: '💾 Save the book' }); toast(`${p.title}: ${p.message}`); }
      b.disabled = false;
    } }, '💾 Save now'));
}
/** Run window: a rerun from a book bible / continuing a book. */
function runBibleLine(r) {
  const s = r.settings || {};
  if (s.bible) return h('p', { class: 'small mb-variant', 'data-testid': 'mb-bible' }, `🔁 A new book from the book bible of ${s.bible.source}${s.bible.reuse_plan ? ' (same plan)' : ' (new plan)'}: its canon is approved in the new book under your consent for this run.`);
  if (s.continue) return h('p', { class: 'small mb-variant', 'data-testid': 'mb-continue' }, `▶ Continuing “${s.continue.title}”: the steps already done are kept.`);
  return null;
}

/** Settings: long chapters (P15). */
function lengthSettingsCard() {
  const box = h('div');
  const card = h('section', { class: 'card', 'aria-labelledby': 'lns-h', 'data-testid': 'length-settings' }, h('h2', { id: 'lns-h' }, '📏 Long chapters ', infoTip('Long chapters', ...LENGTH_TIP())),
    h('p', { class: 'small' }, 'How Akọwe writes chapters longer than one AI answer, and what it does when a chapter comes back far too short.'), box);
  (async () => {
    let cur;
    try { cur = await api('GET', '/settings/length'); } catch (e) { box.appendChild(problemBox(toProblem(e, { step: 'Settings › Long chapters' }))); return; }
    const per = h('input', { type: 'number', id: 'lns-per', min: '300', max: '8000', step: '100', value: String(cur.per_call_words), 'aria-describedby': 'lns-per-h' });
    const rounds = h('select', { id: 'lns-rounds', 'aria-describedby': 'lns-r-h' }, [0, 1, 2, 3].map(n => h('option', { value: String(n), selected: n === cur.expand_rounds }, n === 0 ? '0 — never continue' : `${n}${n === 1 ? ' (default)' : ''}`)));
    const share = h('select', { id: 'lns-share', 'aria-describedby': 'lns-s-h' }, [0.4, 0.5, 0.6, 0.7, 0.8].map(v => h('option', { value: String(v), selected: Math.abs(v - cur.under_share) < 0.001 }, `${Math.round(v * 100)} %${v === 0.6 ? ' (default)' : ''}`)));
    const out = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'button', class: 'small primary', 'data-testid': 'lns-save', onclick: async () => {
      clearFieldProblems(card); clear(out);
      try { await api('PUT', '/settings/length', { body: { per_call_words: parseInt(per.value, 10), expand_rounds: parseInt(rounds.value, 10), under_share: parseFloat(share.value) } }); toast('Saved'); }
      catch (e) { const rest = showFieldErrors(e, { per_call_words: per, expand_rounds: rounds, under_share: share }, { step: 'Settings › Long chapters' }); if (rest.length) out.appendChild(problemBox(e)); }
    } }, 'Save');
    put(box, h('div', { class: 'grid-3' },
      h('div', { class: 'field' }, h('label', { for: 'lns-per' }, 'Words per AI answer'), per, h('span', { class: 'hint', id: 'lns-per-h' }, 'A chapter longer than this is written scene by scene (one answer per scene). Web AIs write about 2,500 words reliably.')),
      h('div', { class: 'field' }, h('label', { for: 'lns-rounds' }, 'Continue a short chapter'), rounds, h('span', { class: 'hint', id: 'lns-r-h' }, 'How many times the writer may continue a chapter that came back far too short (within its scene plan, never padding).')),
      h('div', { class: 'field' }, h('label', { for: 'lns-share' }, '“Far too short” means below'), share, h('span', { class: 'hint', id: 'lns-s-h' }, 'Of the chapter’s word target.'))),
    h('div', { class: 'row' }, save), out);
  })();
  return card;
}

/* ======================================================================= Settings: backups (S9), AI retry (S10), diagnostics (S8) */
function backupsCard() {
  const box = h('div', { 'aria-live': 'polite' });
  const card = h('section', { class: 'card', 'aria-labelledby': 'bk-h' }, h('h2', { id: 'bk-h' }, '💾 Backups'),
    h('p', { class: 'small' }, 'Akọwe backs up all your books automatically: once a day, before ⚡ Make a book for me, before putting a book together and before exporting. Only the newest ones are kept. Keys are never part of a backup.'), box);
  const load = async () => {
    let out;
    try { out = await api('GET', '/backups'); } catch (e) { clear(box).appendChild(problemBox(toProblem(e, { step: 'Settings › Backups' }), { retry: load })); return; }
    const keep = h('input', { type: 'number', id: 'bk-keep', min: '1', max: '100', value: String(out.keep), class: 'wz-num' });
    const now = h('button', { type: 'button', class: 'primary', onclick: async ev => {
      ev.currentTarget.disabled = true;
      try { const r = await api('POST', '/backups'); toast(r && r.flushed === 'best effort' ? 'Backup saved and verified (flushed to disk: best effort)' : 'Backup saved and verified'); load(); refreshHealth(true); } catch (e) { box.prepend(problemBox(toProblem(e, { step: 'Settings › Backups' }))); ev.currentTarget.disabled = false; }
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
        h('div', { class: 'r-badges' }, b.verified ? (b.flushed === 'best effort' ? h('span', { title: BEST_EFFORT_SAY }, badge('✔', 'Verified · flushed: best effort', 'b-warn')) : badge('✔', 'Verified', 'b-ok')) : hazard({ code: 'HASH_MISMATCH', message: 'This backup did not verify.', where: { step: 'Settings › Backups' } }, {}, { small: true }),
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
        close(); toast(`Your books were restored from the backup of ${fmtWhen(b.created_at)} (${b.label || 'Backup'}). A safety backup of how things were just before is listed under Backups.`); S.project = null; await loadProjects(); reload(); route();
      } catch (e) { clear(out).appendChild(problemBox(toProblem(e, { step: 'Restore a backup' }))); go2.disabled = false; }
    } },
    h('div', { class: 'state blocked' }, h('h3', null, '⚠️ This replaces ALL your books'), h('p', null, `Every book goes back to how it was on ${fmtTime(b.created_at)}. Work done after that is replaced. Akọwe first saves a safety backup of how things are now, so you can undo this by restoring that safety backup.`)),
    h('div', { class: 'check-row field' }, tick, h('label', { for: tick.id }, 'I understand that all my books go back to this backup.')),
    h('div', { class: 'field' }, h('label', { for: word.id }, 'Type RESTORE to confirm'), word, h('span', { class: 'hint', id: 'rs-h' }, 'This extra step prevents accidents.')),
    out, h('div', { class: 'form-actions' }, go2, h('button', { type: 'button', onclick: close }, 'Cancel')));
  });
}
function retryCard() {
  const box = h('div');
  const card = h('section', { class: 'card', 'aria-labelledby': 'rt-h' }, h('h2', { id: 'rt-h' }, '⏳ When the AI is busy'),
    h('p', { class: 'small' }, 'If the AI is busy or cannot be reached, Akọwe waits and tries again on its own, and shows “waiting for Claude (busy) — retrying in 30 s”. A slow answer (time-out) is never retried automatically, because the first answer may still arrive; you press 🔁 Try again.'), box);
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
/** Settings › Reviewer AI (P3.1): automatic = always a different AI from the one that wrote the draft. */
function reviewerCard() {
  const box = h('div');
  const card = h('section', { class: 'card', 'aria-labelledby': 'rva-h' }, h('h2', { id: 'rva-h' }, '🧐 Reviewer AI'),
    h('p', { class: 'small' }, 'The AI reviewer reads each draft before it is approved. A different AI from the one that wrote it notices more, so Akọwe picks another AI that works. When only one AI works, it reviews its own writing and Akọwe shows ⚠️ “reviews are not independent”.'), box);
  (async () => {
    let cur;
    try { cur = await api('GET', '/settings/reviewer-ai'); } catch (e) { box.appendChild(problemBox(toProblem(e, { step: 'Settings › Reviewer AI' }))); return; }
    const sel = h('select', { id: 'rva-slot', 'aria-describedby': 'rva-hint' },
      h('option', { value: 'auto' }, 'Automatic (a different AI from the writer)'),
      ['AI-1', 'AI-2', 'AI-3'].map(x => h('option', { value: x }, `${x} when it did not write the draft`)));
    sel.value = cur.slot || 'auto';
    const save = h('button', { type: 'button', class: 'small primary', onclick: async () => {
      try { await api('PUT', '/settings/reviewer-ai', { body: { slot: sel.value } }); toast('Saved'); }
      catch (e) { box.appendChild(problemBox(toProblem(e, { step: 'Settings › Reviewer AI' }))); }
    } }, 'Save');
    put(box, h('div', { class: 'field' }, h('label', { for: 'rva-slot' }, 'Reviewer AI'), sel,
      h('span', { class: 'hint', id: 'rva-hint' }, 'A chosen AI is used only when it did not write the draft and works right now; otherwise Akọwe picks another one automatically.')),
    h('div', { class: 'row' }, save));
  })();
  return card;
}
/** Settings › Editor (P4/P5): on/off, rewrite rounds 0-3, strictness. */
function editorSettingsCard() {
  const box = h('div');
  const card = h('section', { class: 'card', 'aria-labelledby': 'eds-h', 'data-testid': 'editor-settings' }, h('h2', { id: 'eds-h' }, '🖋 Editor'),
    h('p', { class: 'small' }, 'After the AI reviewer checked that a chapter fits the plan, a second AI — never the one that wrote it, when another AI works — reads it like an editor: subtext, characters with their own goals, distinct voices, obstacles from the world, theme, repeated tics (counted by Akọwe without AI), stakes and the ending. In ⚡ Make a book for me the writer then reworks only the flagged passages; a rewrite is kept only when nothing got worse. The editor never holds up the book: when its rounds are used up, the chapter is approved under your run consent and marked ⚠️.'), box);
  (async () => {
    let cur;
    try { cur = await api('GET', '/settings/editor'); } catch (e) { box.appendChild(problemBox(toProblem(e, { step: 'Settings › Editor' }))); return; }
    const on = h('input', { type: 'checkbox', id: 'eds-on', checked: !!cur.enabled });
    const rounds = h('select', { id: 'eds-rounds', 'aria-describedby': 'eds-r-h' }, [0, 1, 2, 3].map(n => h('option', { value: String(n) }, n === 0 ? '0 — notes only, no rewrites' : `${n} round${n === 1 ? '' : 's'}${n === 2 ? ' (default)' : ''}`)));
    rounds.value = String(cur.rounds);
    const strict = h('select', { id: 'eds-strict', 'aria-describedby': 'eds-s-h' }, Object.entries(cur.strictness_choices || { gentle: '', normal: '', strict: '' }).map(([k, about]) => h('option', { value: k }, `${k[0].toUpperCase()}${k.slice(1)}${k === 'normal' ? ' (default)' : ''} — ${about}`)));
    strict.value = cur.strictness;
    const two = h('input', { type: 'checkbox', id: 'eds-two', checked: cur.two_reviewers !== false, 'aria-describedby': 'eds-two-h' });
    const out = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'button', class: 'small primary', 'data-testid': 'eds-save', onclick: async () => {
      clearFieldProblems(card); clear(out);
      try { await api('PUT', '/settings/editor', { body: { enabled: on.checked, rounds: parseInt(rounds.value, 10), strictness: strict.value, two_reviewers: two.checked } }); toast('Saved'); }
      catch (e) { const rest = showFieldErrors(e, { enabled: on, rounds, strictness: strict, two_reviewers: two }, { step: 'Settings › Editor' }); if (rest.length) out.appendChild(problemBox(e)); }
    } }, 'Save');
    put(box, h('div', { class: 'check-row field' }, on, h('label', { for: 'eds-on' }, h('strong', null, 'Editor on'), ' (in Make a book for me; the 🖋 Editor review button always works)')),
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', { for: 'eds-rounds' }, 'Editor rounds per chapter'), rounds, h('span', { class: 'hint', id: 'eds-r-h' }, 'How many times the writer may rework the editor’s notes in a run.')),
        h('div', { class: 'field' }, h('label', { for: 'eds-strict' }, 'Strictness'), strict, h('span', { class: 'hint', id: 'eds-s-h' }, 'When the editor’s scores and notes count as “revise”.'))),
      h('div', { class: 'check-row field' }, two, h('label', { for: 'eds-two' }, h('strong', null, 'Two editors when two other AIs work'), h('span', { class: 'hint', id: 'eds-two-h' }, ' The lower score counts on each point (costs one more AI answer per chapter).'))),
      cur.calibration ? h('p', { class: 'small muted' }, '🎯 ', cur.calibration) : null,
      h('div', { class: 'row' }, save), out);
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
  md.addEventListener('close', afterWorkDialog);
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
    try { console.warn('Akọwe: unhandled problem', r); } catch { /* ignore */ }
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
      ? 'To finish connecting AutoInjector, Akọwe needs to be opened from its start link once on this computer. Open Akọwe from its window or desktop shortcut, then press Connect in AutoInjector again.'
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
/* ======================================================================= 🔎 fact checks (Section 7a: P26 / P30 / P31)
 * Timeline + terminology check, the trade-facts list ("research needed" until you verify a term) and the repetition
 * sorter (voice / motif / filler / accidental — only accidental repeats and the excess of the others are trimmed).
 * Server: /review/facts… (fact_checks.py). Kept in one block so it merges easily. */
Object.assign(ED_DIMS, { terminology: 'Trade fact or term', repetition: 'Repeat to trim' });
const FACT_CLASS = { voice: ['🗣️', 'Voice — kept'], motif: ['🔁', 'Motif — kept'], filler: ['🧹', 'Filler — trim the excess'], accident: ['✂️', 'Accidental — trim'] };
const TERM_STATUS = { research_needed: ['🔬', 'Research needed'], verified: ['✔', 'Verified'], wrong: ['✕', 'Wrong — do not use'] };
const factWhere = { step: 'Fact checks' };

/** ✔ Verified / ✕ Wrong / ↩ for one term: an inline confirm row (the author's own check; never the AI's). */
function termVerifyRow(term, after) {
  const row = h('span', { class: 'fact-verify' });
  const open = status => {
    const inp = h('input', { type: 'text', class: 'small', 'aria-label': status === 'wrong' ? 'What to write instead' : 'What you checked',
      placeholder: status === 'wrong' ? 'What to write instead (optional)' : 'What you checked (optional)' });
    const msg = h('span', { 'aria-live': 'polite' });
    const ok = h('button', { type: 'button', class: 'small primary', onclick: async () => {
      ok.disabled = true;
      try {
        await api('POST', bpath('/review/facts/terms/verify'), { body: { ids: [term.id], status, author_confirms: true,
          note: status === 'verified' ? inp.value : '', use_instead: status === 'wrong' ? inp.value : '' } });
        toast(status === 'verified' ? `“${term.term}” marked verified` : status === 'wrong' ? `“${term.term}” marked wrong` : `“${term.term}” needs research again`);
        if (after) after();
      } catch (e) { clear(msg).appendChild(problemBox(toProblem(e, factWhere), {})); ok.disabled = false; }
    } }, 'Confirm');
    clear(row).appendChild(h('span', { class: 'row' }, status === 'research_needed' ? null : inp, ok,
      h('button', { type: 'button', class: 'small', onclick: () => draw() }, 'Cancel'), msg));
    inp.focus && status !== 'research_needed' && inp.focus();
  };
  const draw = () => clear(row).appendChild(h('span', null,
    term.status !== 'verified' ? h('button', { type: 'button', class: 'small', 'data-testid': 'term-verified', onclick: () => open('verified') }, '✔ Verified') : null, ' ',
    term.status !== 'wrong' ? h('button', { type: 'button', class: 'small', 'data-testid': 'term-wrong', onclick: () => open('wrong') }, '✕ Wrong') : null, ' ',
    term.status !== 'research_needed' ? h('button', { type: 'button', class: 'small link', onclick: () => open('research_needed') }, '↩ Needs research') : null));
  draw();
  return row;
}
/** A select to relabel one repeated phrase (the author's label always wins). */
function repeatLabel(r, version, after) {
  const sel = h('select', { class: 'small', 'aria-label': `Kind of repeat: ${r.phrase}` },
    h('option', { value: '' }, 'Let Akọwe decide'),
    Object.entries(FACT_CLASS).map(([k, [ic, l]]) => h('option', { value: k, selected: r.source === 'author' && r.class === k }, `${ic} ${l}`)));
  sel.addEventListener('change', async () => {
    try {
      await api('PUT', bpath('/review/facts/repeats'), { body: { labels: { [r.key === 'counting' ? 'counting' : r.phrase]: sel.value }, version } });
      toast('Label saved'); if (after) after();
    } catch (e) { toast(toProblem(e, factWhere).title); }
  });
  return sel;
}
function factFindingList(fs, testid) {
  return h('ul', { class: 'small fact-list', 'data-testid': testid }, fs.map(f => h('li', { class: `fact-${f.severity}` },
    f.severity === 'major' ? '⚠️ ' : '• ', h('strong', null, f.label), `: ${f.detail}`,
    (f.passages || []).slice(0, 2).map(p => h('div', { class: 'muted' }, p.number ? `Chapter ${p.number}: ` : '', `“${(p.sentence || p.excerpt || '').slice(0, 140)}”`)))));
}

/** Chapter page: timeline, trade facts and repeats of this chapter, with ✨ fixes through the editor's rewrite. */
function factsCard(rid, { onSaved } = {}) {
  const box = h('section', { class: 'card facts-card', 'aria-labelledby': `fc-h-${rid}`, 'data-testid': 'facts-card' },
    h('div', { class: 'row space' }, h('h2', { id: `fc-h-${rid}` }, '🔎 Timeline, trade facts and repeats'),
      infoTip('Fact checks', h('p', null, 'Akọwe reads the ages and years in the book and checks that they add up (born in 1850 + forty years old should be the story’s year).'),
        h('p', null, 'Trade facts: equipment, procedures and period words stay “research needed” until you mark them ✔ Verified or ✕ Wrong. An AI may suggest an answer, but only you can verify. A wick on a gas lamp is flagged on sight.'),
        h('p', null, 'Repeats are sorted before anything is cut: a character’s way of talking (voice) and motifs are kept; only accidental repeats and the excess of the others may be trimmed.'))));
  const body = h('div', null, loadingState('Checking ages, years, terms and repeats…'));
  const prog = h('div', { 'aria-live': 'polite' });
  const msg = h('div', { 'aria-live': 'polite' });
  put(box, body, prog, msg);
  const draw = async () => {
    let info;
    try { info = await api('GET', bpath(`/review/facts/${encodeURIComponent(rid)}`)); }
    catch (e) { clear(body).appendChild(problemBox(toProblem(e, factWhere), { retry: draw })); return; }
    clear(body);
    // 🕰️ timeline
    const tf = info.timeline.findings || [];
    const ages = Object.entries(info.timeline.ages || {}).map(([n, rows]) => `${n} ${[...new Set(rows.filter(r => !r.past).map(r => r.age))].join(', ')}`).filter(x => /\d/.test(x));
    body.appendChild(h('h3', null, '🕰️ Timeline'));
    body.appendChild(h('p', { class: 'small', 'data-testid': 'facts-timeline' }, tf.length ? `⚠️ ${tf.length} place(s) where ages or years do not add up.` : '✔ No timeline problems found.',
      info.story_year ? ` Story year: ${info.story_year}${info.story_year_set ? '' : ' (read from the text)'}.` : '', ages.length ? ` Ages on this page: ${ages.join('; ')}.` : ''));
    if (tf.length) body.appendChild(factFindingList(tf, 'facts-timeline-list'));
    // 🔧 trade facts
    const tc = info.terms;
    const hard = (tc.findings || []).filter(f => f.check !== 'term_unverified');
    const open = (tc.findings || []).filter(f => f.check === 'term_unverified');
    body.appendChild(h('h3', null, '🔧 Trade facts'));
    body.appendChild(h('p', { class: 'small', 'data-testid': 'facts-terms' }, hard.length ? `⚠️ ${hard.length} wrong or out-of-place term(s).` : '✔ No wrong terms found.',
      open.length ? ` 🔬 ${open.length} term(s) here still need research.` : ''));
    if (hard.length) body.appendChild(factFindingList(hard, 'facts-terms-list'));
    if (open.length) body.appendChild(h('ul', { class: 'small fact-list' }, open.map(f => h('li', null, '🔬 ', f.detail, ' ', f.term ? termVerifyRow({ id: f.term, term: (f.passages[0] || {}).match || '', status: 'research_needed' }, draw) : null))));
    if ((tc.candidates || []).length) body.appendChild(h('p', { class: 'small' }, `Found ${tc.candidates.length} term(s) to check: ${tc.candidates.map(c => c.term).join(', ')} `,
      h('button', { type: 'button', class: 'small', 'data-testid': 'facts-scan', onclick: async () => {
        try { const out = await api('POST', bpath('/review/facts/terms/scan'), { body: { record_id: rid } }); toast(`${out.added} term(s) added as research needed`); draw(); }
        catch (e) { clear(msg).appendChild(problemBox(toProblem(e, factWhere), {})); }
      } }, '➕ Add them as research needed')));
    // 🔁 repeats
    const reps = info.repetition.repeats || [];
    const keep = reps.filter(r => r.class === 'voice' || r.class === 'motif');
    const trim = reps.filter(r => r.trim_here);
    body.appendChild(h('h3', null, '🔁 Repeats'));
    body.appendChild(h('p', { class: 'small', 'data-testid': 'facts-repeats' }, trim.length ? `${trim.length} repeat(s) could be trimmed here.` : '✔ Nothing to trim.',
      keep.length ? ` ${keep.length} voice or motif repeat(s) are kept on purpose.` : ''));
    if (reps.length) body.appendChild(h('ul', { class: 'small fact-list' }, reps.slice(0, 12).map(r => h('li', { 'data-class': r.class },
      `${(FACT_CLASS[r.class] || ['•'])[0]} ${quoted(clipWords(r.phrase, 60))} — ${(FACT_CLASS[r.class] || ['', r.class])[1]} (${r.why}; ${r.here} here${r.trim_here ? `, ${r.trim_here} to trim` : ''}) `,
      repeatLabel(r, info.repetition.labels_version, draw)))));
    // ✨ fixes (proposal shown with the editor's fixes box when it is ours)
    let edInfo = null;
    try { edInfo = await api('GET', bpath(`/review/editor/${encodeURIComponent(rid)}`)); } catch { /* no fixes to show */ }
    const prop = edInfo && edInfo.proposal && (edInfo.proposal.items || []).length && edInfo.proposal.items.every(x => ['terminology', 'repetition'].includes(x.dimension)) ? edInfo.proposal : null;
    if (prop && prop.items.some(x => x.ok)) body.appendChild(fixesBox(prop, edInfo, msg, () => draw(), onSaved));
    body.appendChild(h('div', { class: 'row' },
      h('button', { type: 'button', 'data-testid': 'facts-find', onclick: async () => {
        clear(msg); const j = await runAiJob(`/review/facts/${encodeURIComponent(rid)}/find`, {}, prog, 'Finding the trade facts');
        if (j) { toast(((j.results || [])[0] || {}).message || 'Done'); draw(); }
      } }, '🤖 Find trade facts with AI'),
      info.fix.terms ? h('button', { type: 'button', class: 'primary ai-btn', 'data-testid': 'facts-fix-terms', onclick: async () => {
        clear(msg); const j = await runAiJob(`/review/facts/${encodeURIComponent(rid)}/fix`, { kind: 'terms' }, prog, 'The writer is fixing the wrong terms');
        if (j) { toast(((j.results || [])[0] || {}).message || 'Done'); draw(); }
      } }, '✨ Fix the wrong terms with AI') : null,
      info.fix.repeats ? h('button', { type: 'button', class: 'primary ai-btn', 'data-testid': 'facts-fix-repeats', onclick: async () => {
        clear(msg); const j = await runAiJob(`/review/facts/${encodeURIComponent(rid)}/fix`, { kind: 'repeats' }, prog, 'The writer is trimming the accidental repeats');
        if (j) { toast(((j.results || [])[0] || {}).message || 'Done'); draw(); }
      } }, '✨ Trim accidental repeats with AI') : null));
  };
  draw();
  return box;
}

/** Book page: the trade-facts list (verify here), the story year, the book's timeline and its repeats. */
function bookFactsCard() {
  const box = h('section', { class: 'card facts-card', 'aria-labelledby': 'bfc-h', 'data-testid': 'book-facts' },
    h('h2', { id: 'bfc-h' }, '🔎 Timeline, trade facts and repeats'));
  const body = h('div', null, loadingState('Loading…'));
  const prog = h('div', { 'aria-live': 'polite' });
  const msg = h('div', { 'aria-live': 'polite' });
  put(box, body, prog, msg);
  const draw = async () => {
    let bk;
    try { bk = await api('GET', bpath('/review/facts')); }
    catch (e) { clear(body).appendChild(problemBox(toProblem(e, factWhere), { retry: draw })); return; }
    clear(body);
    if (!bk.chapters) { body.appendChild(h('p', { class: 'small muted' }, 'No chapter is written yet.')); return; }
    const year = h('input', { type: 'number', min: 1000, max: 2200, class: 'small', value: bk.story_year_set ? bk.story_year : '', 'aria-label': 'Story year', placeholder: bk.story_year ? String(bk.story_year) : 'e.g. 1887' });
    body.appendChild(h('p', { class: 'small row' }, h('strong', null, 'Story year: '), year,
      h('button', { type: 'button', class: 'small', onclick: async () => {
        try { await api('PUT', bpath('/review/facts/terms'), { body: { items: bk.terms.items, version: bk.terms.version, story_year: year.value ? Number(year.value) : null } }); toast('Story year saved'); draw(); }
        catch (e) { clear(msg).appendChild(problemBox(toProblem(e, factWhere), { retry: draw })); }
      } }, 'Save'), h('span', { class: 'muted' }, ' Used for the age arithmetic and for words from a later time.')));
    const tf = bk.timeline.findings || [];
    body.appendChild(h('p', { class: 'small', 'data-testid': 'book-facts-timeline' }, h('strong', null, '🕰️ Timeline: '),
      tf.length ? `⚠️ ${tf.length} place(s) where ages or years do not add up.` : '✔ Ages and years add up.'));
    if (tf.length) body.appendChild(factFindingList(tf.slice(0, 8), 'book-facts-timeline-list'));
    const c = bk.terms.counts;
    body.appendChild(h('p', { class: 'small', 'data-testid': 'book-facts-terms' }, h('strong', null, '🔧 Trade facts: '),
      `🔬 ${c.research_needed} need research · ✔ ${c.verified} verified · ✕ ${c.wrong} wrong`,
      (bk.terms.flagged || []).length ? ` · ⚠️ ${bk.terms.flagged.length} wrong or out-of-place use(s) in the chapters` : ''));
    if ((bk.terms.items || []).length) body.appendChild(h('ul', { class: 'small fact-list', 'data-testid': 'book-terms' }, bk.terms.items.map(t => h('li', { 'data-status': t.status },
      `${(TERM_STATUS[t.status] || ['•'])[0]} `, h('strong', null, t.term), ` — ${(TERM_STATUS[t.status] || ['', t.status])[1]}`,
      t.uses ? h('span', { class: 'muted' }, ` (used ${t.uses}× in chapter ${t.in_chapters.join(', ')})`) : h('span', { class: 'muted' }, ' (not used)'),
      t.question ? h('div', { class: 'muted' }, `❓ ${t.question}`) : null,
      t.note ? h('div', null, `📝 ${t.note}`) : null,
      t.use_instead && t.status === 'wrong' ? h('div', null, `→ write: ${t.use_instead}`) : null,
      t.ai_note ? h('div', { class: 'muted' }, `🤖 ${t.ai_note.reviewer || 'An AI'} says (${t.ai_note.verdict}, advice only): ${t.ai_note.answer}${t.ai_note.use_instead ? ` — suggests “${t.ai_note.use_instead}”` : ''}`) : null,
      termVerifyRow(t, draw)))));
    body.appendChild(h('div', { class: 'row' },
      h('button', { type: 'button', class: 'small', 'data-testid': 'book-terms-scan', onclick: async () => {
        try { const out = await api('POST', bpath('/review/facts/terms/scan'), { body: {} }); toast(`${out.added} term(s) added as research needed`); draw(); }
        catch (e) { clear(msg).appendChild(problemBox(toProblem(e, factWhere), {})); }
      } }, '➕ Scan the book for terms'),
      c.research_needed ? h('button', { type: 'button', class: 'small ai-btn', 'data-testid': 'book-terms-research', onclick: async () => {
        clear(msg); const j = await runAiJob('/review/facts/terms/ai', {}, prog, 'An AI is researching the trade facts');
        if (j) { toast(((j.results || [])[0] || {}).message || 'Done'); draw(); }
      } }, '🤖 Ask an AI to research the open questions') : null));
    const rc = bk.repetition.counts;
    const trim = (bk.repetition.repeats || []).filter(r => r.trim_count);
    body.appendChild(h('p', { class: 'small', 'data-testid': 'book-facts-repeats' }, h('strong', null, '🔁 Repeats: '),
      `🗣️ ${rc.voice} voice · 🔁 ${rc.motif} motif (kept) · 🧹 ${rc.filler} filler · ✂️ ${rc.accident} accidental — ${rc.trim} use(s) could be trimmed`));
    if (trim.length) body.appendChild(h('ul', { class: 'small fact-list' }, trim.slice(0, 10).map(r => h('li', null,
      `${(FACT_CLASS[r.class] || ['•'])[0]} ${quoted(clipWords(r.phrase, 60))} (${r.why}) — `,
      r.occurrences.filter(o => o.trim && o.record_id).slice(0, 3).map(o => [h('a', { href: plink('write', o.record_id) }, `chapter ${o.number}`), ' ']),
      repeatLabel(r, bk.repetition.labels_version, draw)))));
  };
  draw();
  return box;
}

/** Run window: what the fact checks found (P26/P30/P31). */
function factsRunSummary(r) {
  const fs = r.facts_summary;
  if (!fs || !fs.chapters) return null;
  const notes = fs.notes || [];
  return h('div', { class: notes.some(n => n.code !== 'REPEATS_TO_TRIM') ? 'words-warn' : 'small', 'data-testid': 'mb-facts-summary' },
    h('p', null, notes.length ? '🔎 ' : '✅ ', `Fact checks: ${fs.terms_added || 0} trade term(s) added as “research needed”, ${fs.timeline ? fs.timeline.major : 0} timeline problem(s), ${fs.trim || 0} repeat(s) that could be trimmed.`),
    notes.length ? h('ul', { class: 'small' }, notes.map(n => h('li', null, n.message))) : null,
    h('p', { class: 'small muted' }, 'A run never verifies a trade fact: open the book page → 🔎 Timeline, trade facts and repeats to check them.'));
}

boot();
