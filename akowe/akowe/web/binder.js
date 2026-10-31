/* 📖 Book Bible binder (the author's "Book Bible Visual Template Studio" design, ported): #/p/<pid>/<b>/bible[/<page_id>].
   Reads GET …/binder (contract in pc-work/binder/PLAN.md): one page object per template instance (Cover, Contents, At a
   glance, Cast, Character × N, Relationship map, Place × N, World 8A/8B/8C × N, Map, Story plan, Chapter × N, Rules &
   facts), every schema field id present ({value, status, source, edit}), repeating sections as `rows`, pictures in `pics`.
   Each template is one render function that draws the studio's boxes from that page object; empty fields show a
   placeholder, never a broken page. Seven genre LOOKS are CSS-variable themes (binder.css) with small inline SVG
   ornaments; system fonts only. Print gives clean pages (light paper for every look). Everything is drawn with DOM APIs
   (no innerHTML with book data); the ornaments are constant SVG strings of this file. Styles are scoped under .bnd. */
import { SCHEMA } from './binder-schema.js';
import { problemFor } from './problems.js';

/* ======================================================================= constants */
export const LOOKS = {
  classic: ['Classic', '📜', 'Cream paper, deep green, gold rules'],
  fantasy: ['Fantasy', '🐉', 'Parchment, burgundy and antique gold'],
  scifi: ['Science fiction', '🛰', 'Dark slate, cyan and violet lines'],
  noir: ['Noir case file', '🕵', 'Off-white file, charcoal and red'],
  romance: ['Romance', '🌹', 'Blush and ivory, rose and muted gold'],
  horror: ['Horror', '🕯', 'Near-black, blood red, bone white'],
  playful: ['Playful', '🎈', 'Bright, rounded and friendly'],
};
const GENRE_LOOK = [
  [/fantasy|adventure|myth|fairy/, 'fantasy'], [/sci|space|cyber|dystop/, 'scifi'], [/myster|thriller|crime|detective|noir|suspense/, 'noir'],
  [/romanc|love/, 'romance'], [/horror|gothic|ghost/, 'horror'], [/comed|humou?r|child|picture|kid/, 'playful'], [/literary|historical/, 'classic'],
];
export function lookForGenre(genre) {
  const g = String(genre || '').toLowerCase().replace(/[’']/g, '');
  for (const [re, look] of GENRE_LOOK) if (re.test(g)) return look;
  return 'classic';
}
// template id -> [rail icon, rail name (plural for repeating pages), eyebrow, tagline]
const TPL = {
  1: ['📕', 'Cover', 'A writing and worldbuilding reference', 'Book Bible'],
  2: ['☰', 'Contents', 'Akọwe · the novel reference', 'A clickable guide to the complete story world'],
  3: ['👁', 'At a glance', 'Akọwe · the novel reference', 'The whole novel, understood on one page'],
  4: ['👥', 'Cast list', 'Akọwe · the novel reference', 'Portraits, roles and profiles at a glance'],
  5: ['👤', 'Characters', 'Character', 'One consistent identity across every chapter'],
  6: ['🕸', 'Relationship map', 'Akọwe · the novel reference', 'Family, love, rivalry, alliances and conflicts'],
  7: ['🏙', 'Places', 'Place', 'An immersive place dossier'],
  '8A': ['✨', 'Magic systems', 'Magic system', 'Rules, costs and continuity of a power'],
  '8B': ['🗝', 'Items', 'Item', 'Rules, details and continuity for your story world'],
  '8C': ['🏛', 'World, groups & beliefs', 'World entry', 'Rules, details and continuity for your story world'],
  9: ['🗺', 'Map', 'Akọwe · the novel reference', 'The geography of your novel, with its key'],
  10: ['📈', 'Story plan', 'Akọwe · the novel reference', 'Premise · pivotal scenes · conflict · resolution'],
  11: ['📄', 'Chapters', 'Chapter', 'A visual plan for each chapter'],
  12: ['⚖', 'Rules & facts', 'Akọwe · the novel reference', 'The locked facts, rules and style of your book'],
};
const ENTITY = new Set(['5', '7', '8A', '8B', '8C', '11']);
const REL_TYPES = [['family', 'Family', /famil|brother|sister|mother|father|parent|sibling|son|daughter|cousin|aunt|uncle|grand/],
  ['love', 'Love', /love|roman|partner|crush|spouse|wife|husband|lover/], ['ally', 'Allies', /all(y|ies)|friend|companion/],
  ['rival', 'Rivals', /rival/], ['enemy', 'Enemies', /enem|foe|nemesis|antagon/], ['mentor', 'Mentor / student', /mentor|student|teacher|apprentice|master|pupil/]];
// fields whose value names another page (→ link in the spec)
const LINKY = new Set(['2.2.1', '2.2.2', '2.2.3', '3.6.2', '4.2.2', '5.2.13', '5.8.2', '5.9.5', '5.10.1', '5.14.13', '7.7.7', '7.9.2', '7.10.4', '7.10.13',
  '8A.8.1', '8B.2.4', '8B.7.1', '8B.8.11', '8C.3.4', '8C.5.1', '8C.5.2', '8C.5.3', '8C.6.4', '9.2.2', '10.3.1', '11.2.1', '11.2.2', '11.5.1', '12.1.2']);
const CHIPPY = new Set(['5.4.1', '5.14.2', '5.14.13', '7.10.4', '7.10.13', '8A.8.1', '8B.8.11', '8C.5.1', '8C.5.2', '8C.5.3', '8C.6.4', '7.7.7']);
const EMPTY = Object.freeze({ value: '', status: 'empty' });

/* ======================================================================= schema index */
const META = {};   // field id -> {label, short, pic, auto, nw, sec, tid}
const SECS = {};   // section code -> {name, repeat, ids, tid}
for (const [tid, [, secs]] of Object.entries(SCHEMA)) {
  for (const [code, name, repeat, fl] of secs) {
    SECS[code] = { name, repeat, ids: fl.map(f => f[0]), tid };
    for (const [id, label, flags = ''] of fl) {
      META[id] = { label, short: shortLabel(label), pic: flags.includes('p'), auto: flags.includes('a'), nw: flags.includes('n'), sec: code, tid };
    }
  }
}
function shortLabel(l) { const s = String(l).replace(/\s*\([^)]*\)/g, '').replace(/"/g, '').trim(); return s || l; }
const secOf = id => id.slice(0, id.lastIndexOf('.'));

/* ======================================================================= value helpers */
function txt(f) {
  if (!f) return '';
  const v = f.value;
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(x => (x && typeof x === 'object') ? (x.name || x.title || x.text || '') : String(x)).filter(Boolean).join(', ');
  if (typeof v === 'object') return String(v.text || v.name || v.title || '');
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v);
}
function list(f) {
  if (f && Array.isArray(f.value)) return f.value.map(x => (x && typeof x === 'object') ? (x.name || x.title || x.text || '') : String(x)).filter(s => s && s.trim());
  const t = txt(f).trim();
  if (!t) return [];
  return t.split(/\s*(?:·|;|\n|,(?![^(]*\)))\s*/).filter(Boolean);
}
const empty = f => !txt(f).trim();
const num = (s) => { const m = String(s || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; };
const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const STATUS_WORDS = { approved: ['✔', 'Approved', 'ok'], draft: ['✎', 'Draft', 'draft'], needs_you: ['⚠', 'Needs you', 'needs'],
  proposed: ['✎', 'Draft', 'draft'], planned: ['✎', 'Draft', 'draft'], written: ['✎', 'Draft', 'draft'] };
function statusWord(s) { return STATUS_WORDS[String(s || '').toLowerCase().replace(/[\s-]+/g, '_')] || STATUS_WORDS.draft; }

/* ======================================================================= SVG helpers */
const SVGNS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
// constant ornament markup (this file's own strings, never book data) -> an inline <svg>
const ORN_CACHE = {};
function orn(markup, cls) {
  if (!ORN_CACHE[markup]) ORN_CACHE[markup] = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
  const el = document.importNode(ORN_CACHE[markup], true);
  el.setAttribute('class', cls); el.setAttribute('aria-hidden', 'true'); el.setAttribute('focusable', 'false');
  return el;
}
const S0 = '<svg xmlns="http://www.w3.org/2000/svg" ';
const ORN = {
  rule: {   // divider under a page title
    classic: S0 + 'viewBox="0 0 240 16"><path d="M0 8h104M136 8h104" stroke="currentColor" stroke-width=".8"/><path d="M120 1l7 7-7 7-7-7z" fill="currentColor"/></svg>',
    fantasy: S0 + 'viewBox="0 0 240 24"><path d="M10 12h80M150 12h80" stroke="currentColor"/><path d="M120 3c8 0 12 5 12 9s-4 9-12 9-12-5-12-9 4-9 12-9zM92 12c6-6 12-6 16 0-4 6-10 6-16 0zM148 12c-6-6-12-6-16 0 4 6 10 6 16 0z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="120" cy="12" r="3" fill="currentColor"/></svg>',
    scifi: S0 + 'viewBox="0 0 240 16"><path d="M0 8h96l6-6h36l6 6h96" fill="none" stroke="currentColor"/><circle cx="96" cy="8" r="2.5" fill="currentColor"/><circle cx="144" cy="8" r="2.5" fill="currentColor"/><path d="M110 8h20" stroke="currentColor" stroke-width="3"/></svg>',
    noir: S0 + 'viewBox="0 0 240 12"><path d="M0 6h240" stroke="currentColor" stroke-dasharray="10 6"/></svg>',
    romance: S0 + 'viewBox="0 0 240 24"><path d="M0 12c40-10 70 10 104 0M240 12c-40-10-70 10-104 0" fill="none" stroke="currentColor"/><path d="M120 20c-10-7-14-11-14-15a6 6 0 0 1 14-2 6 6 0 0 1 14 2c0 4-4 8-14 15z" fill="currentColor"/></svg>',
    horror: S0 + 'viewBox="0 0 240 26"><path d="M0 4h240" stroke="currentColor" stroke-width="3"/><path d="M40 4v8a3 3 0 0 0 6 0V4M92 4v15a3 3 0 0 0 6 0V4M150 4v5a3 3 0 0 0 6 0V4M196 4v11a3 3 0 0 0 6 0V4" fill="currentColor"/></svg>',
    playful: S0 + 'viewBox="0 0 240 16"><path d="M0 8l10-6 10 6 10-6 10 6 10-6 10 6 10-6 10 6 10-6 10 6 10-6 10 6 10-6 10 6 10-6 10 6 10-6 10 6 10-6 10 6 10-6 10 6 10-6 10 6" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>',
  },
  corner: {  // top-left page corner (mirrored by CSS for the others)
    classic: S0 + 'viewBox="0 0 60 60"><path d="M4 30V4h26" fill="none" stroke="currentColor"/><path d="M10 10l5 5-5 5-5-5z" fill="currentColor"/></svg>',
    fantasy: S0 + 'viewBox="0 0 80 80"><path d="M6 74V30C6 16 16 6 30 6h44" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 66V34c0-11 9-20 20-20h32" fill="none" stroke="currentColor" stroke-width=".8"/><path d="M30 30c0-10 14-10 14 0s-14 10-14 0zM22 22c-8-8 4-16 8-6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="37" cy="30" r="3" fill="currentColor"/></svg>',
    scifi: S0 + 'viewBox="0 0 60 60"><path d="M2 40V2h38" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 26V10h16" fill="none" stroke="currentColor"/><circle cx="40" cy="2" r="2.5" fill="currentColor"/><circle cx="2" cy="40" r="2.5" fill="currentColor"/></svg>',
    noir: S0 + 'viewBox="0 0 40 90"><path d="M14 84V18a8 8 0 0 1 16 0v58a5 5 0 0 1-10 0V24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
    romance: S0 + 'viewBox="0 0 70 70"><path d="M4 66C4 30 30 4 66 4" fill="none" stroke="currentColor"/><path d="M20 30c-6-2-8-8-4-12s10-2 12 4c-2-6 2-12 8-10s6 10 0 14c4-2 10 0 10 6s-8 8-12 2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="26" cy="26" r="3" fill="currentColor"/></svg>',
    horror: S0 + 'viewBox="0 0 70 70"><path d="M6 8l26 30M14 4l24 26M4 18l22 24" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    playful: S0 + 'viewBox="0 0 70 70"><path d="M18 4l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z" fill="currentColor"/><circle cx="46" cy="14" r="4" fill="currentColor" opacity=".55"/><circle cx="12" cy="46" r="5" fill="currentColor" opacity=".35"/><circle cx="40" cy="38" r="3" fill="currentColor" opacity=".7"/></svg>',
  },
  stamp: S0 + 'viewBox="0 0 150 54"><rect x="3" y="3" width="144" height="48" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><rect x="9" y="9" width="132" height="36" rx="2" fill="none" stroke="currentColor"/><text x="75" y="34" text-anchor="middle" font-family="Courier New, monospace" font-weight="700" font-size="17" letter-spacing="3" fill="currentColor">CASE FILE</text></svg>',
  emblem: {  // the big emblem of the cover fallback ("a styled title page in the genre colours")
    classic: S0 + 'viewBox="0 0 200 200"><circle cx="100" cy="100" r="86" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="100" cy="100" r="78" fill="none" stroke="currentColor" stroke-width=".6"/><path d="M100 36l14 50 50 14-50 14-14 50-14-50-50-14 50-14z" fill="currentColor" opacity=".85"/></svg>',
    fantasy: S0 + 'viewBox="0 0 200 200"><path d="M100 14l22 30 36-4-8 36 30 24-34 14 4 36-36-10-14 34-14-34-36 10 4-36-34-14 30-24-8-36 36 4z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="100" cy="100" r="40" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M100 70c14 20 20 30 20 40a20 20 0 0 1-40 0c0-10 6-20 20-40z" fill="currentColor"/></svg>',
    scifi: S0 + 'viewBox="0 0 200 200"><circle cx="100" cy="100" r="80" fill="none" stroke="currentColor" stroke-dasharray="4 6"/><ellipse cx="100" cy="100" rx="90" ry="30" fill="none" stroke="currentColor" transform="rotate(-20 100 100)"/><circle cx="100" cy="100" r="34" fill="currentColor" opacity=".25"/><circle cx="100" cy="100" r="34" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="178" cy="72" r="6" fill="currentColor"/></svg>',
    noir: S0 + 'viewBox="0 0 200 200"><circle cx="86" cy="86" r="50" fill="none" stroke="currentColor" stroke-width="8"/><path d="M122 122l52 52" stroke="currentColor" stroke-width="14" stroke-linecap="round"/></svg>',
    romance: S0 + 'viewBox="0 0 200 200"><path d="M100 170c-50-34-74-58-74-90a40 40 0 0 1 74-20 40 40 0 0 1 74 20c0 32-24 56-74 90z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M100 140c-30-22-44-36-44-56a24 24 0 0 1 44-12 24 24 0 0 1 44 12c0 20-14 34-44 56z" fill="currentColor" opacity=".5"/></svg>',
    horror: S0 + 'viewBox="0 0 200 200"><path d="M60 20h80v8c0 6-6 6-6 14v40c0 6 6 6 6 14v76H60V96c0-8 6-8 6-14V42c0-8-6-8-6-14z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M100 30c10 14 12 22 12 28a12 12 0 0 1-24 0c0-6 2-14 12-28z" fill="currentColor"/><path d="M76 120v26a4 4 0 0 0 8 0v-26M116 120v40a4 4 0 0 0 8 0v-40" fill="currentColor"/></svg>',
    playful: S0 + 'viewBox="0 0 200 200"><path d="M100 18l22 46 50 6-36 34 10 50-46-24-46 24 10-50-36-34 50-6z" fill="currentColor"/><circle cx="34" cy="160" r="12" fill="currentColor" opacity=".4"/><circle cx="170" cy="150" r="8" fill="currentColor" opacity=".6"/></svg>',
  },
  compass: S0 + 'viewBox="0 0 60 60"><circle cx="30" cy="30" r="26" fill="none" stroke="currentColor"/><path d="M30 4l6 26-6 26-6-26z" fill="currentColor" opacity=".35"/><path d="M30 4l6 26h-12z" fill="currentColor"/><text x="30" y="16" text-anchor="middle" font-size="9" font-weight="700" fill="var(--bnd-paper)">N</text></svg>',
};

/* ======================================================================= the view */
export async function viewBinder(main, x, rest = []) {
  const { h, clear, api, bpath, plink, S } = x;
  const where = { book: S.project.name, step: '📖 Book Bible' };
  document.body.classList.add('bnd-on');
  main.appendChild(h('div', { class: 'page-head bnd-apphead no-print' }, h('div', null,
    x.crumbs(['Your books', '#/'], [S.project.name, plink()], 'Book Bible'), h('h1', null, '📖 Book Bible'))));
  const root = h('div', { class: 'bnd', 'data-testid': 'binder', 'data-look': 'classic', 'data-fids': 'off', 'data-mode': 'one' });
  main.appendChild(root);
  root.appendChild(x.loadingState('Opening the Book Bible…'));
  const printStyle = h('style', { id: 'bnd-print-style' });
  document.head.appendChild(printStyle);
  const imgCache = new Map();
  const cleanup = [];
  S.leaveHooks.push(() => {
    document.body.classList.remove('bnd-on');
    printStyle.remove();
    for (const fn of cleanup) { try { fn(); } catch { /* ignore */ } }
  });

  let data;
  try { data = await api('GET', bpath('/binder')); }
  catch (e) {
    clear(root);
    if (e && e.status === 404) {
      root.appendChild(x.stateBox('empty', 'The Book Bible binder is not ready in this Akọwe yet',
        h('p', null, 'This version of Akọwe cannot build the binder pages yet. Your book bible is still saved with the book: ',
          h('a', { href: plink('book') }, '📘 Make my book'), ' has ⬇ book-bible.md and ⬇ book-bible.json.')));
    } else root.appendChild(x.problemBox(x.toProblem(e, where), { retry: () => x.route() }, 'Could not open the Book Bible'));
    return;
  }
  let pages = []; let book = {}; let byId = new Map(); let byName = new Map(); let firstNames = new Map(); let characters = [];
  let lastUpdated = ''; let fieldsInfo = {};
  /** (re)index a binder document: page numbers, name lookups (the first load and every reload after an edit) */
  function setData(d) {
    data = d || {};
    pages = Array.isArray(data.pages) ? data.pages.filter(p => p && SCHEMA[String(p.template)]) : [];
    book = Object.assign({ title: S.project.name, author: '', genre: '', look: '' }, data.book || {});
    fieldsInfo = data.fields_info || {};
    pages.forEach((p, i) => {
      p.template = String(p.template); p._n = i + 1; p.page_id = p.page_id || `page-${i + 1}`;
      for (const sec of Object.values(p.sections || {})) (sec && Array.isArray(sec.rows) ? sec.rows : []).forEach((r, j) => { if (r && typeof r === 'object') r._i = j; });
    });
    byId = new Map(pages.map(p => [p.page_id, p]));
    byName = new Map();
    const addName = (n, p) => { const k = fold(n).trim(); if (k && !byName.has(k)) byName.set(k, p); };
    for (const p of pages) {
      if (p.template === '1' || p.template === '2') continue;
      addName(p.title, p);
      const tf = { 5: '5.1.2', 7: '7.1.2', '8A': '8A.1.2', '8B': '8B.1.2', '8C': '8C.1.2', 11: '11.1.2' }[p.template];
      if (tf) addName(txt(fld(p, tf)).split(/\s*[("]/)[0], p);
    }
    firstNames = new Map();
    for (const p of pages.filter(q => q.template === '5')) {
      const f = fold(p.title).split(/\s+/)[0];
      if (f) firstNames.set(f, firstNames.has(f) ? null : p);
    }
    characters = pages.filter(p => p.template === '5');
    const dt = data.updated_at || data.generated_at ? new Date(data.updated_at || data.generated_at) : null;
    lastUpdated = dt && !isNaN(dt) ? dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  }
  setData(data);
  if (!pages.length) {
    clear(root).appendChild(x.stateBox('empty', 'The Book Bible has no pages yet',
      h('p', null, 'Start the book first (a book profile and some characters), then come back: the binder fills itself from the book.')));
    return;
  }
  function findPage(name) {
    const k = fold(name).replace(/^(the|a)\s+/, '').replace(/\s*\/\s*[A-Z]{2}-\d+$/i, '').trim();
    if (!k) return null;
    return byName.get(fold(name).trim()) || byName.get(k) || byName.get('the ' + k) || firstNames.get(k) || null;
  }
  const pageTitle = p => (p.template === '1' ? 'Cover' : p.title) || (SCHEMA[p.template] || [''])[0];

  // ------------------------------------------------------------------ state
  const lsKey = `bf:binder:${S.pid}:${S.branch}`;
  const saved = (() => { try { return JSON.parse(localStorage.getItem(lsKey) || '{}') || {}; } catch { return {}; } })();
  const persist = () => { try { localStorage.setItem(lsKey, JSON.stringify(st.keep)); } catch { /* private mode */ } };
  const autoLook = LOOKS[book.look_default] ? book.look_default : lookForGenre(book.genre);
  const st = {
    look: LOOKS[book.look_stored] ? book.look_stored : LOOKS[saved.look] ? saved.look : LOOKS[book.look] ? book.look : autoLook,
    mode: saved.mode === 'all' ? 'all' : 'one',
    fids: !!saved.fids,
    idx: Math.max(0, pages.findIndex(p => p.page_id === rest[0])),
    keep: saved,
  };
  if (rest[0] && !byId.has(rest[0])) st.idx = 0;

  /* ================================================================== field rendering */
  function fld(p, id) {
    const sec = (p.sections || {})[secOf(id)];
    return (sec && sec.fields && sec.fields[id]) || EMPTY;
  }
  function rowsOf(p, code) {
    const sec = (p.sections || {})[code];
    const rs = sec && Array.isArray(sec.rows) ? sec.rows : [];
    return rs.filter(r => r && Object.entries(r).some(([k, f]) => !k.startsWith('_') && !empty(f)));
  }
  const rf = (row, id) => (row && !String(id).startsWith('_') && row[id]) || EMPTY;
  const rowMeta = r => (r && r._meta && typeof r._meta === 'object') ? r._meta : {};
  const rowPage = r => byId.get(rowMeta(r).page_id) || null;
  /** a row's picture: pics["<id>#<row number>"], or a picture url in the field itself */
  const rowPic = (p, id, r) => ((p.pics || {})[`${id}#${(r && r._i !== undefined ? r._i : 0) + 1}`]) || asPic(rf(r, id));
  const asPic = f => (f && f.url) ? f : (/^(\/api\/|data:image\/)/.test(txt(f)) ? { url: txt(f) } : null);
  const isFieldEntry = ([k, f]) => !k.startsWith('_') && f && typeof f === 'object' && !f.repeat;
  const pageEdit = p => {
    for (const sec of Object.values(p.sections || {})) {
      if (sec && sec.edit && sec.edit.route) return sec.edit.route;
      for (const f of Object.values((sec && sec.fields) || {})) if (f && f.edit && f.edit.route) return f.edit.route;
      for (const r of (sec && sec.rows) || []) for (const f of Object.values(r || {})) if (f && f.edit && f.edit.route) return f.edit.route;
    }
    return null;
  };
  const secEdit = (p, code) => {
    const sec = (p.sections || {})[code] || {};
    if (sec.edit && sec.edit.route) return sec.edit.route;
    for (const f of Object.values(sec.fields || {})) if (f && f.edit && f.edit.route) return f.edit.route;
    for (const r of sec.rows || []) for (const f of Object.values(r || {})) if (f && f.edit && f.edit.route) return f.edit.route;
    return pageEdit(p);
  };
  const safeRoute = r => (typeof r === 'string' && r.startsWith('#/')) ? r : null;

  function pageLink(target, label, cls) {
    return h('a', { href: plink('bible', target.page_id), class: cls || 'bnd-link', 'data-goto': target.page_id,
      onclick: ev => { ev.preventDefault(); goto(target.page_id); } }, label);
  }
  function linkify(id, text) {
    if (!LINKY.has(id)) return text;
    const whole = findPage(text);
    if (whole) return pageLink(whole, text);
    const parts = String(text).split(/(\s*(?:,|·|;|\band\b)\s*)/);
    if (parts.length < 3 || !parts.some((s, i) => i % 2 === 0 && findPage(s.replace(/\s*\(.*\)$/, '')))) return text;
    return parts.map((s, i) => { if (i % 2) return s; const t = findPage(s.replace(/\s*\(.*\)$/, '')); return t ? pageLink(t, s) : s; });
  }
  function placeholder(p, id, f, kind = 'text', row = null) {
    const route = safeRoute(f.edit && f.edit.route) || safeRoute(pageEdit(p));
    const m = META[id] || {};
    if (f && f.unavailable) {   // nothing in Akọwe stores this yet: a quiet note, no button
      return h('span', { class: 'bnd-empty bnd-unavail', title: typeof f.unavailable === 'string' ? f.unavailable : (f.reason || '') }, 'Not stored yet');
    }
    if (kind === 'pic') {
      const what = /portrait|character/i.test(m.label || '') || (m.sec || '').startsWith('5.') ? 'No portrait yet' : 'No picture yet';
      return h('span', { class: 'bnd-empty bnd-empty-pic' }, what, h('span', { class: 'bnd-act' }, ' — ',
        route ? h('a', { href: route, 'data-field': id }, '🎨 Make one') : '🎨 Make one'));
    }
    const spec = editSpec(p, id, f, row);
    if (m.auto && !spec) return h('span', { class: 'bnd-empty' }, 'Not worked out yet');
    return h('span', { class: 'bnd-empty' }, 'Not filled yet', h('span', { class: 'bnd-act' }, ' — ',
      spec ? h('button', { type: 'button', class: 'bnd-fill bnd-linkbtn', 'data-field': id, 'data-target': spec.target,
        onclick: ev => runFill([spec.target], ev.currentTarget) }, '✨ Fill from the book')
        : route ? h('a', { href: route, 'data-field': id, class: 'bnd-fill' }, '✨ Fill from the book') : '✨ Fill from the book'));
  }
  /** the value of a field: text (line breaks kept), page links, chips for lists, a placeholder when empty */
  function val(p, id, f = fld(p, id), opts = {}) {
    if (empty(f)) return placeholder(p, id, f, 'text', opts.row || null);
    const linked = typeof f.link === 'string' ? byId.get(f.link) : null;
    if (opts.chips || CHIPPY.has(id) || Array.isArray(f.value)) {
      const items = list(f);
      return h('span', { class: 'bnd-chips' }, items.map(s => {
        const t = LINKY.has(id) || CHIPPY.has(id) ? findPage(s.replace(/\s*\(.*\)$/, '')) : null;
        return t ? pageLink(t, s, 'bnd-chip bnd-link') : h('span', { class: 'bnd-chip' }, s);
      }));
    }
    if (linked) return h('span', { class: 'bnd-text' }, pageLink(linked, txt(f)));
    return h('span', { class: 'bnd-text' }, linkify(id, txt(f)));
  }

  /* ------------------------------------------------------------------ 🆕 fields: inline editor, approve / dismiss */
  const BOOK_SOURCES = { 'auto:series_line': ['series', 'series_number'], 'auto:themes': ['themes'], 'auto:theme_1': ['themes'],
    'auto:theme_2': ['themes'], 'auto:theme_3': ['themes'] };
  /** what the binder can store for a field ({target, kind, keys, info}), or null when it is edited elsewhere */
  function editSpec(p, id, f, row) {
    if (!f || f.unavailable || f.repeat) return null;
    const src = String(f.source || '');
    let target = (f.edit && f.edit.target) || (row && rowMeta(row).target) || null;
    let keys = null;
    if (f.edit && f.edit.target && f.edit.field) keys = [f.edit.field];
    else if (src.startsWith('new:')) keys = [src.slice(4)];
    else if (src === 'row:type') keys = ['type'];
    else if (BOOK_SOURCES[src]) { keys = BOOK_SOURCES[src]; target = 'book'; }
    if (!keys) return null;
    if (!target) target = p.target || (['1', '2', '3', '4', '10', '12'].includes(p.template) ? 'book' : null);
    if (!target) return null;
    const kind = String(target).split(':')[0];
    const info = fieldsInfo[kind] || {};
    if (!keys.every(k => info[k])) return null;
    return { target, kind, keys, info };
  }
  function editBtn(p, id, f, row) {
    const spec = editSpec(p, id, f, row);
    if (!spec) return null;
    const label = (META[id] || {}).short || id;
    return h('button', { type: 'button', class: 'bnd-fedit no-print', 'data-edit': id, 'aria-label': `Edit ${label}`, title: `Edit ${label}`,
      onclick: ev => openEditor(p, id, spec, ev.currentTarget) }, '✏️');
  }
  async function openEditor(p, id, spec, btn) {
    const box = btn.closest('[data-fid]') || btn.parentElement;
    const old = box.querySelector(':scope > .bnd-editor');
    if (old) { old.remove(); return; }
    const form = h('form', { class: 'bnd-editor no-print', 'data-testid': 'binder-editor', novalidate: true }, x.loadingState('Opening…'));
    box.appendChild(form);
    let cur;
    try { cur = await api('GET', bpath(`/binder/fields?target=${encodeURIComponent(spec.target)}`)); }
    catch (e) { clear(form).appendChild(h('p', { class: 'bnd-err-inline', role: 'alert' }, plainError(e))); return; }
    const vals = (cur && cur.fields) || {};
    const inputs = {};
    clear(form);
    for (const k of spec.keys) {
      const rule = spec.info[k] || {}; const v = (vals[k] || {}).value;
      const iid = `bnd-ed-${p.page_id}-${id}-${k}`.replace(/[^\w-]/g, '-');
      let inp;
      if (rule.type === 'int') inp = h('input', { type: 'number', id: iid, min: rule.min, max: rule.max, step: '1', value: v === null || v === undefined ? '' : String(v) });
      else if (rule.type === 'list') inp = h('input', { type: 'text', id: iid, value: Array.isArray(v) ? v.join(', ') : (v || ''), placeholder: `up to ${rule.max_items || 3}, separated by commas` });
      else if ((rule.max || 0) > 200) inp = h('textarea', { id: iid, rows: '3', maxlength: rule.max }, v || '');
      else inp = h('input', { type: 'text', id: iid, maxlength: rule.max || null, value: v || '' });
      if (Array.isArray(rule.choices)) inp.setAttribute('list', `${iid}-l`);
      inputs[k] = inp;
      form.appendChild(h('div', { class: 'bnd-ed-row' }, h('label', { for: iid }, rule.label || k, (vals[k] || {}).status === 'proposed' ? h('span', { class: 'bnd-prop' }, ' ✎ proposed') : null),
        inp, Array.isArray(rule.choices) ? h('datalist', { id: `${iid}-l` }, rule.choices.map(c => h('option', { value: c }))) : null,
        rule.hint ? h('small', null, rule.hint) : rule.type === 'int' ? h('small', null, `${rule.min}–${rule.max}`) : null));
    }
    const out = h('p', { class: 'bnd-ed-msg', 'aria-live': 'polite' });
    const proposed = spec.keys.filter(k => (vals[k] || {}).status === 'proposed');
    const done = async (what, call) => {
      for (const b of form.querySelectorAll('button')) b.disabled = true;
      try { await call(); x.toast(what); await reloadData(); }
      catch (e) { out.textContent = plainError(e); for (const b of form.querySelectorAll('button')) b.disabled = false; }
    };
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const fields = {};
      for (const k of spec.keys) {
        const rule = spec.info[k] || {}; const raw = inputs[k].value.trim();
        if (!raw) { fields[k] = null; continue; }
        if (rule.type === 'int') {
          const n = Number(raw);
          if (!Number.isInteger(n) || (rule.min !== undefined && n < rule.min) || (rule.max !== undefined && n > rule.max)) {
            out.textContent = `${rule.label || k}: a whole number from ${rule.min} to ${rule.max}.`; inputs[k].focus(); return;
          }
          fields[k] = n;
        } else if (rule.type === 'list') fields[k] = raw.split(/\s*[,·]\s*/).filter(Boolean).slice(0, rule.max_items || 3);
        else fields[k] = raw;
      }
      done('Saved', () => api('PUT', bpath('/binder/fields'), { body: { target: spec.target, fields } }));
    });
    form.appendChild(out);
    form.appendChild(h('div', { class: 'bnd-ed-btns' },
      h('button', { type: 'submit', class: 'primary', 'data-testid': 'binder-ed-save' }, '💾 Save'),
      proposed.length ? h('button', { type: 'button', 'data-testid': 'binder-ed-approve', onclick: () => done('Approved', () => api('POST', bpath('/binder/fields/approve'), { body: { target: spec.target, fields: proposed } })) }, '✔ Approve') : null,
      proposed.length ? h('button', { type: 'button', 'data-testid': 'binder-ed-dismiss', onclick: () => done('Proposal dismissed', () => api('POST', bpath('/binder/fields/dismiss'), { body: { target: spec.target, fields: proposed } })) }, '✕ Dismiss') : null,
      h('button', { type: 'button', onclick: () => form.remove() }, 'Cancel')));
    const first = Object.values(inputs)[0]; if (first) first.focus();
  }
  /** the proposals of 🆕 fields on a page that ✔ Approve all can accept: {target: [keys]} */
  function pageProposals(p) {
    const out = {};
    for (const sec of Object.values(p.sections || {})) {
      const entries = [...Object.entries((sec && sec.fields) || {}).map(e => [e, null]),
        ...((sec && sec.rows) || []).flatMap(r => Object.entries(r || {}).map(e => [e, r]))];
      for (const [[id, f], r] of entries) {
        if (id.startsWith('_') || !f || f.status !== 'proposed') continue;
        const spec = editSpec(p, id, f, r);
        if (spec) for (const k of spec.keys) (out[spec.target] = out[spec.target] || new Set()).add(k);
      }
    }
    return Object.fromEntries(Object.entries(out).map(([t, ks]) => [t, [...ks]]));
  }
  function plainError(e) {
    const err = (e && e.body && Array.isArray(e.body.errors) && e.body.errors[0]) || {};
    const words = problemFor(err.problem || err.code, e && e.status);
    return [err.message || words.what, err.fix || words.fix].filter(Boolean).join(' — ');
  }
  function fidTag(id) {
    const m = META[id] || {};
    return [h('span', { class: 'bnd-fid' }, id), m.nw ? h('span', { class: 'bnd-tag bnd-fid' }, 'NEW') : null, m.auto ? h('span', { class: 'bnd-tag bnd-fid' }, 'AUTO') : null];
  }
  function proposedMark(f) {
    return f && (f.status === 'proposed' || f.draft === true) ? h('span', { class: 'bnd-prop', title: 'Proposed — waiting for your approval' }, '✎', h('span', { class: 'bnd-sr' }, ' proposed')) : null;
  }
  /** one labelled field box */
  function field(p, id, opts = {}) {
    const f = opts.f || fld(p, id);
    const m = META[id] || { short: id };
    return h(opts.tag || 'div', { class: `bnd-f${opts.cls ? ' ' + opts.cls : ''}${empty(f) ? ' is-empty' : ''}${f.status === 'proposed' ? ' is-proposed' : ''}`,
      'data-fid': id, 'data-st': f.status || 'empty' },
    h('div', { class: 'bnd-k' }, fidTag(id), h('span', { class: 'bnd-kl', title: m.label }, opts.label || m.short), proposedMark(f), editBtn(p, id, f)),
    h('div', { class: 'bnd-v' }, opts.render ? opts.render(f) : val(p, id, f, opts)));
  }
  const grid = (p, ids, cls = '') => h('div', { class: `bnd-grid ${cls}` }, ids.map(id => field(p, id, { cls: /\.(1|2)$/.test(id) && cls.includes('lead') ? 'bnd-wide' : '' })));
  /** the boxed fact sheet (Quick stats / Quick facts) */
  function facts(p, ids, special = {}) {
    return h('dl', { class: 'bnd-facts' }, ids.map(id => {
      const f = fld(p, id); const m = META[id];
      return h('div', { class: `bnd-fact${empty(f) ? ' is-empty' : ''}${f.status === 'proposed' ? ' is-proposed' : ''}`, 'data-fid': id, 'data-st': f.status || 'empty' },
        h('dt', null, fidTag(id), h('span', { title: m.label }, m.short), proposedMark(f), editBtn(p, id, f)),
        h('dd', null, special[id] ? special[id](f) : val(p, id, f)));
    }));
  }
  function chipsOf(p, ids) {
    return h('div', { class: 'bnd-factchips' }, ids.map(id => {
      const f = fld(p, id);
      return h('div', { class: `bnd-fchip${empty(f) ? ' is-empty' : ''}`, 'data-fid': id, 'data-st': f.status || 'empty' },
        h('small', null, fidTag(id), META[id].short, proposedMark(f), editBtn(p, id, f)), h('b', null, val(p, id, f)));
    }));
  }
  function quote(p, id, cls = '') {
    const f = fld(p, id);
    return h('figure', { class: `bnd-quote ${cls}${empty(f) ? ' is-empty' : ''}`, 'data-fid': id, 'data-st': f.status || 'empty' },
      h('figcaption', null, fidTag(id), META[id].short, proposedMark(f), editBtn(p, id, f)), h('blockquote', null, val(p, id, f)));
  }
  function bars(p, ids, max = 10) {
    return h('div', { class: 'bnd-bars' }, ids.map(id => {
      const f = fld(p, id); const n = num(txt(f));
      const v = n === null ? null : Math.max(0, Math.min(max, Math.round(n)));
      return h('div', { class: `bnd-bar${v === null ? ' is-empty' : ''}${f.status === 'proposed' ? ' is-proposed' : ''}`, 'data-fid': id, 'data-st': f.status || 'empty' },
        h('span', { class: 'bnd-bar-l' }, fidTag(id), META[id].short, proposedMark(f), editBtn(p, id, f)),
        h('span', { class: 'bnd-bar-track', role: 'img', 'aria-label': v === null ? `${META[id].short}: not filled yet` : `${META[id].short}: ${v} of ${max}` },
          Array.from({ length: max }, (_, i) => h('i', { class: v !== null && i < v ? 'on' : null }))),
        h('span', { class: 'bnd-bar-n' }, v === null ? placeholder(p, id, f) : `${v}/${max}`));
    }));
  }
  function pips(f, max = 5) {
    const n = num(txt(f)); const v = n === null ? 0 : Math.max(0, Math.min(max, Math.round(n)));
    return h('span', { class: 'bnd-pips', role: 'img', 'aria-label': `Danger ${v} of ${max}` },
      Array.from({ length: max }, (_, i) => h('i', { class: i < v ? 'on' : null })), h('b', null, ` ${v}/${max}`));
  }

  /* ------------------------------------------------------------------ pictures */
  function loadImg(url) {
    if (!url || typeof url !== 'string') return Promise.resolve(null);
    if (url.startsWith('data:image/') || url.startsWith('blob:')) return Promise.resolve(url);
    if (!url.startsWith('/')) return Promise.resolve(null);   // no network: only this server's own files
    if (!imgCache.has(url)) {
      const pr = url.startsWith('/api/')
        ? api('GET', url.slice(4), { blob: true }).then(b => { const u = URL.createObjectURL(b); S.blobUrls.push(u); return u; }).catch(() => null)
        : Promise.resolve(url);
      imgCache.set(url, pr);
    }
    return imgCache.get(url);
  }
  function picOf(p, id) { const pic = (p && p.pics || {})[id]; return pic && pic.url ? pic : null; }
  /** a picture slot: the image, or a placeholder that says what is missing */
  function pic(p, id, opts = {}) {
    const pc = opts.pic !== undefined ? opts.pic : picOf(p, id);
    const f = fld(p, id);
    const box = h('figure', { class: `bnd-pic ${opts.cls || ''}`, 'data-fid': id, 'data-shape': opts.shape || 'wide' },
      opts.caption === false ? null : h('figcaption', null, fidTag(id), opts.label || META[id].short));
    const ph = h('div', { class: 'bnd-pic-ph' }, h('span', { class: 'bnd-pic-ico', 'aria-hidden': 'true' }, opts.icon || '🖼'), placeholder(p, id, f, 'pic'));
    box.appendChild(ph);
    if (pc && pc.url) {
      box.setAttribute('data-img-loading', '1');
      loadImg(pc.url).then(u => {
        box.removeAttribute('data-img-loading');
        if (!u) return;
        const img = h('img', { src: u, alt: pc.alt || `${opts.label || META[id].short} — ${pageTitle(p)}`, loading: 'eager', decoding: 'async' });
        ph.replaceWith(img);
      });
    }
    // a slot with several pictures (expression sheet, extra views): the others as a strip of thumbnails
    const more = pc && Array.isArray(pc.items) ? pc.items.filter(it => it && it.url && it.url !== pc.url).slice(0, 8) : [];
    if (more.length) {
      const strip = h('div', { class: 'bnd-pic-more' });
      for (const it of more) {
        const th = h('span', { class: 'bnd-pic-th' });
        strip.appendChild(th);
        loadImg(it.url).then(u => { if (u) th.appendChild(h('img', { src: u, alt: it.alt || '' })); });
      }
      box.appendChild(strip);
    }
    // the motion clip: ▶ plays it here (screen only)
    if (pc && pc.video) {
      const play = h('button', { type: 'button', class: 'bnd-play no-print', 'data-testid': 'binder-play' }, '▶ Play the clip');
      play.addEventListener('click', async () => {
        play.disabled = true;
        try {
          const u = pc.video.startsWith('/api/') ? URL.createObjectURL(await api('GET', pc.video.slice(4), { blob: true })) : pc.video;
          if (u.startsWith('blob:')) S.blobUrls.push(u);
          play.replaceWith(h('video', { src: u, controls: true, autoplay: true, muted: true, loop: true, playsinline: true, class: 'bnd-video', 'aria-label': `${META[id].short} — ${pageTitle(p)}` }));
        } catch (e) { play.disabled = false; play.textContent = '▶ The clip could not be loaded — try again'; }
      });
      box.appendChild(play);
    }
    return box;
  }
  /** a round portrait bubble for a person (their own page's main portrait), initials when there is none */
  function bubble(name, size = 'm', row = null) {
    const t = findPage(String(name || '').replace(/\s*\/\s*[A-Z]{2}-\d+$/, ''));
    const pc = (row && row.url) ? row : t ? picOf(t, { 5: '5.1.1', 7: '7.1.1', '8A': '8A.1.1', '8B': '8B.1.1', '8C': '8C.1.1', 11: '11.1.3' }[t.template]) : null;
    const initials = String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase();
    const el = h('span', { class: `bnd-bubble bnd-bubble-${size}`, 'aria-hidden': 'true' }, h('span', null, initials || '?'));
    if (pc) loadImg(pc.url).then(u => { if (u) { clear(el).appendChild(h('img', { src: u, alt: '' })); } });
    return el;
  }

  /* ------------------------------------------------------------------ sections */
  function secStatus(p, code) {
    const sec = (p.sections || {})[code] || {};
    if (sec.status) return sec.status;
    const all = [...Object.entries(sec.fields || {}), ...(sec.rows || []).flatMap(r => Object.entries(r || {}))].filter(isFieldEntry).map(e => e[1]).filter(f => !f.unavailable);
    const filled = all.filter(f => !empty(f));
    if (!filled.length) return all.length ? 'needs_you' : 'approved';
    if (filled.some(f => f.status === 'proposed' || f.status === 'draft')) return 'draft';
    return 'approved';
  }
  function badge(s, small) {
    const [i, w, c] = statusWord(s);
    return h('span', { class: `bnd-badge bnd-badge-${c}${small ? ' bnd-badge-s' : ''}` }, h('span', { 'aria-hidden': 'true' }, i), ` ${w}`);
  }
  function sec(p, code, body, opts = {}) {
    const s = SECS[code] || { name: code };
    const route = safeRoute(secEdit(p, code));
    return h('section', { class: `bnd-sec ${opts.cls || ''}`, 'data-sec': code, id: `bbs-${p.page_id}-${code}`, 'aria-labelledby': `bbh-${p.page_id}-${code}` },
      h('header', { class: 'bnd-sec-h' },
        h('span', { class: 'bnd-sid bnd-fid' }, code),
        h('h3', { id: `bbh-${p.page_id}-${code}` }, opts.title || s.name),
        h('span', { class: 'bnd-sec-tools' }, badge(secStatus(p, code), true),
          route ? h('a', { class: 'bnd-edit no-print', href: route, title: `Edit “${s.name}” in Akọwe` }, '✏ Edit') : null)),
      body);
  }
  const rowsEmpty = (p, code, what) => h('p', { class: 'bnd-empty bnd-rows-empty' }, `No ${what} yet`, h('span', { class: 'bnd-act' }, ' — ',
    safeRoute(secEdit(p, code)) ? h('a', { href: secEdit(p, code), class: 'bnd-fill' }, '✨ Fill from the book') : '✨ Fill from the book'));
  /** a repeating section as a table (one row per entry) */
  function rowTable(p, code, ids, what, cells = {}) {
    const rs = rowsOf(p, code);
    if (!rs.length) return rowsEmpty(p, code, what);
    return h('div', { class: 'bnd-tablewrap' }, h('table', { class: 'bnd-table' },
      h('thead', null, h('tr', null, ids.map(id => h('th', { scope: 'col' }, fidTag(id), META[id].short)))),
      h('tbody', null, rs.map(r => h('tr', null, ids.map(id => {
        const f = rf(r, id);
        return h('td', { 'data-label': META[id].short, 'data-fid': id, class: empty(f) ? 'is-empty' : null }, cells[id] ? cells[id](f, r) : (empty(f) ? h('span', { class: 'bnd-dash' }, '—') : val(p, id, f)));
      }))))));
  }

  /* ------------------------------------------------------------------ the header band of entity pages */
  function band(p, picId, titleId, otherIds, opts = {}) {
    const f = fld(p, titleId);
    const name = opts.name || pageTitle(p) || txt(f);
    if (!empty(f) && fold(txt(f)).trim() !== fold(name).trim()) otherIds = [titleId, ...otherIds];
    return sec(p, secOf(titleId), h('div', { class: `bnd-band${opts.cls ? ' ' + opts.cls : ''}` },
      picId ? pic(p, picId, { cls: 'bnd-band-pic', shape: opts.shape || 'portrait', icon: opts.icon, caption: false }) : null,
      h('div', { class: 'bnd-band-body' },
        h('div', { class: 'bnd-eyebrow' }, opts.eyebrow || TPL[p.template][2]),
        h('h2', { class: 'bnd-name' }, name),
        opts.lead ? opts.lead : null,
        h('div', { class: 'bnd-band-fields' }, otherIds.map(id => field(p, id))))), { cls: 'bnd-sec-band', title: SECS[secOf(titleId)].name });
  }

  /* ================================================================== the 12 templates (+8A/8B/8C) */
  const T = {};
  // 1 · Cover
  T[1] = p => {
    const title = txt(fld(p, '1.1.1')) || book.title;
    const art = picOf(p, '1.2.1');
    const mast = h('div', { class: 'bnd-cover-mast', 'data-fid': '1.2.1' });
    const fallback = h('div', { class: 'bnd-cover-fallback' }, orn(ORN.emblem[st.look] || ORN.emblem.classic, 'bnd-emblem'),
      h('span', { class: 'bnd-cover-fb-note' }, placeholder(p, '1.2.1', fld(p, '1.2.1'), 'pic')));
    mast.appendChild(fallback);
    if (art) {
      mast.setAttribute('data-img-loading', '1');
      loadImg(art.url).then(u => { mast.removeAttribute('data-img-loading'); if (u) fallback.replaceWith(h('img', { src: u, alt: art.alt || `Cover art of ${title}` })); });
    }
    const pct = Math.max(0, Math.min(100, num(txt(fld(p, '1.4.1'))) || 0));
    return [
      h('div', { class: 'bnd-cover' },
        h('div', { class: 'bnd-eyebrow' }, txt(fld(p, '1.3.1')) || 'Book Bible'),
        sec(p, '1.2', h('div', null, mast, h('p', { class: 'bnd-credit' }, fidTag('1.2.2'), 'Art: ', val(p, '1.2.2'))), { cls: 'bnd-sec-plain bnd-sec-art' }),
        h('div', { class: 'bnd-plaque' },
          h('div', { class: 'bnd-plaque-title', 'data-fid': '1.1.1' }, title),
          empty(fld(p, '1.1.2')) ? null : h('div', { class: 'bnd-plaque-sub', 'data-fid': '1.1.2' }, txt(fld(p, '1.1.2'))),
          h('div', { class: 'bnd-plaque-tiny' }, 'B O O K   B I B L E')),
        h('div', { class: 'bnd-coverstats' },
          [['1.3.5', 'chapters'], ['1.4.2', 'drafts waiting'], ['1.4.3', 'missing pictures'], ['1.4.1', 'approved']].map(([id, w]) => {
            const f = fld(p, id);
            return h('div', { class: 'bnd-statbox', 'data-fid': id }, h('strong', null, empty(f) ? '—' : txt(f) + (id === '1.4.1' && !/%/.test(txt(f)) ? '%' : '')), h('small', null, w));
          })),
        h('div', { class: 'bnd-progress', role: 'progressbar', 'aria-label': 'Approved', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('div', { style: `width:${pct}%` }))),
      sec(p, '1.1', grid(p, ['1.1.1', '1.1.2', '1.1.3', '1.1.4'])),
      sec(p, '1.3', chipsOf(p, ['1.3.1', '1.3.2', '1.3.3', '1.3.4', '1.3.5'])),
      h('div', { class: 'bnd-two' },
        sec(p, '1.4', facts(p, ['1.4.1', '1.4.2', '1.4.3', '1.4.4'], { '1.4.1': f => empty(f) ? placeholder(p, '1.4.1', f) : `${txt(f)}${/%/.test(txt(f)) ? '' : '%'}` })),
        sec(p, '1.5', facts(p, ['1.5.1', '1.5.2', '1.5.3']))),
    ];
  };
  // 2 · Contents
  T[2] = p => {
    const rows = rowsOf(p, '2.1');
    const toc = (Array.isArray(data.contents) && data.contents.length ? data.contents.map(c => ({
      icon: c.icon || (TPL[c.template] || ['•'])[0], name: c.title || (TPL[c.template] || ['', c.template])[1], count: c.count, page: c.page, page_id: c.page_id,
    })) : rows.map(r => ({ icon: '', name: txt(rf(r, '2.1.1')), countText: txt(rf(r, '2.1.2')), page: num(txt(rf(r, '2.1.3'))) })));
    const entriesWord = (c) => c.countText || (c.count > 1 ? `${c.count} pages` : c.count === 1 ? '1 page' : '');
    const tocEl = toc.length ? h('ol', { class: 'bnd-toc' }, toc.map((c, i) => {
      const target = (c.page_id && byId.get(c.page_id)) || pages[(c.page || 0) - 1];
      const inner = [h('span', { class: 'bnd-toc-n' }, String(i + 1)), h('span', { class: 'bnd-toc-i', 'aria-hidden': 'true' }, c.icon),
        h('span', { class: 'bnd-toc-t' }, c.name), h('span', { class: 'bnd-toc-c' }, entriesWord(c)),
        h('span', { class: 'bnd-toc-p' }, c.page ? `p. ${String(c.page).padStart(2, '0')}` : '')];
      return h('li', { 'data-fid': '2.1.1' }, target ? pageLink(target, inner, 'bnd-toc-row') : h('span', { class: 'bnd-toc-row' }, inner));
    })) : rowsEmpty(p, '2.1', 'sections');
    // quick-jump tiles: characters, places and world entries with their pictures
    const tiles = [];
    for (const r of rowsOf(p, '2.2')) for (const id of ['2.2.1', '2.2.2', '2.2.3']) if (!empty(rf(r, id)) && !asPic(rf(r, id))) tiles.push([txt(rf(r, id)), rowPic(p, id, r), rf(r, id).link]);
    const tileNames = tiles.length ? tiles : pages.filter(q => ['5', '7', '8A', '8B', '8C'].includes(q.template)).map(q => [pageTitle(q), null, q.page_id]);
    const grid2 = tileNames.length ? h('div', { class: 'bnd-tiles' }, tileNames.map(([n, pc, link]) => {
      const t = (link && byId.get(link)) || findPage(n);
      const inner = [bubble(n, 's', pc), h('span', null, h('b', null, n), h('small', null, t ? `${TPL[t.template][2]} · p. ${t._n}` : ''))];
      return t ? pageLink(t, inner, 'bnd-tile') : h('span', { class: 'bnd-tile' }, inner);
    })) : rowsEmpty(p, '2.2', 'entries');
    const todoRows = rowsOf(p, '2.3');
    const todo = todoRows.length ? todoRows.map(r => ({ what: txt(rf(r, '2.3.1')), where: txt(rf(r, '2.3.2')), action: txt(rf(r, '2.3.3')) }))
      : (Array.isArray(data.todo) ? data.todo.map(t => ({ what: t.what, where: (byId.get(t.page_id) || {}).title || '', page_id: t.page_id, page: t.page, action: t.action })) : []);
    const todoEl = todo.length ? h('ul', { class: 'bnd-todo' }, todo.slice(0, 10).map(t => {
      const target = (t.page_id && byId.get(t.page_id)) || (t.page && pages[t.page - 1]) || findPage(t.where);
      return h('li', null, h('span', { class: 'bnd-todo-w' }, t.what),
        h('span', { class: 'bnd-todo-p' }, target ? pageLink(target, `${pageTitle(target)} · p. ${target._n}`) : t.where),
        target ? (/approve/i.test(t.action || '') ? pageLink(target, actionWord(t.action), 'bnd-todo-a no-print')
          : h('a', { class: 'bnd-todo-a no-print', href: safeRoute(pageEdit(target)) || plink('bible', target.page_id) }, t.action ? actionWord(t.action) : '✏ Fix')) : null);
    })) : h('p', { class: 'bnd-done' }, '✔ Nothing waiting — every page is approved.');
    return [sec(p, '2.1', tocEl), sec(p, '2.2', grid2), sec(p, '2.3', todoEl, { cls: 'bnd-sec-hl' })];
  };
  const actionWord = a => ({ approve: '✔ Approve', picture: '🎨 Make picture', fix: '✏ Fix', fill: '✨ Fill' }[String(a).toLowerCase()] || String(a));
  // 3 · At a glance
  T[3] = p => [
    sec(p, '3.1', h('div', null, quote(p, '3.1.1', 'bnd-quote-s'), h('p', { class: 'bnd-meta-line' }, field(p, '3.1.2', { cls: 'bnd-inline' })))),
    sec(p, '3.2', quote(p, '3.2.1', 'bnd-quote-big'), { cls: 'bnd-sec-hl' }),
    sec(p, '3.3', field(p, '3.3.1', { cls: 'bnd-prose' })),
    sec(p, '3.4', chipsOf(p, ['3.4.1', '3.4.2', '3.4.3', '3.4.4', '3.4.5', '3.4.6', '3.4.7', '3.4.8', '3.4.9'])),
    sec(p, '3.5', grid(p, ['3.5.1', '3.5.2', '3.5.3', '3.5.4'])),
    sec(p, '3.6', castStrip(p)),
    sec(p, '3.7', h('div', null,
      placeStrip(p),
      h('div', { class: 'bnd-themes' }, ['3.7.2', '3.7.3', '3.7.4'].map(id => field(p, id, { cls: 'bnd-theme' }))),
      quote(p, '3.7.5', 'bnd-quote-q'))),
  ];
  function castStrip(p) {
    const rs = rowsOf(p, '3.6');
    if (!rs.length) return rowsEmpty(p, '3.6', 'main characters');
    return h('div', { class: 'bnd-cast-strip' }, rs.map(r => {
      const name = txt(rf(r, '3.6.2')); const t = rowPage(r) || findPage(name);
      return h('div', { class: 'bnd-mini-card' }, bubble(name, 'l', rowPic(p, '3.6.1', r)),
        h('div', null, h('b', null, t ? pageLink(t, name) : name || '—'), h('small', { class: 'bnd-role' }, txt(rf(r, '3.6.3'))),
          h('p', null, empty(rf(r, '3.6.4')) ? placeholder(p, '3.6.4', rf(r, '3.6.4')) : txt(rf(r, '3.6.4')))));
    }));
  }
  function placeStrip(p) {
    const f = fld(p, '3.7.1');
    let names = list(f);
    if (!names.length) names = pages.filter(q => q.template === '7').slice(0, 4).map(pageTitle);
    return h('div', { class: 'bnd-place-strip', 'data-fid': '3.7.1' }, h('div', { class: 'bnd-k' }, fidTag('3.7.1'), h('span', { class: 'bnd-kl' }, 'Key places')),
      names.length ? h('div', { class: 'bnd-thumbs' }, names.map(n => { const t = findPage(n); return thumb(t, n); })) : placeholder(p, '3.7.1', f, 'pic'));
  }
  function thumb(t, n) {
    const id = t ? { 5: '5.1.1', 7: '7.1.1', '8A': '8A.1.1', '8B': '8B.1.1', '8C': '8C.1.1' }[t.template] : null;
    const box = h('span', { class: 'bnd-thumb' });
    const pc = t && id ? picOf(t, id) : null;
    box.appendChild(h('span', { class: 'bnd-thumb-ph', 'aria-hidden': 'true' }, t ? TPL[t.template][0] : '🖼'));
    if (pc) loadImg(pc.url).then(u => { if (u) clear(box).appendChild(h('img', { src: u, alt: '' })); });
    const inner = [box, h('span', { class: 'bnd-thumb-n' }, n)];
    return t ? pageLink(t, inner, 'bnd-thumb-card') : h('span', { class: 'bnd-thumb-card' }, inner);
  }
  // 4 · Cast list
  T[4] = p => {
    const rs = rowsOf(p, '4.2');
    const groupOf = r => {
      if (rowMeta(r).group) return String(rowMeta(r).group);
      const g = txt(rf(r, '4.1.1')).trim(); if (g && !/·/.test(g)) return g;
      const role = fold(txt(rf(r, '4.2.4')));
      if (/protag|antag|main|lead|hero|villain/.test(role)) return 'Main';
      if (/minor|cameo|extra/.test(role)) return 'Minor';
      return 'Supporting';
    };
    const groups = [];
    for (const r of rs) { const g = groupOf(r); let e = groups.find(x => x[0] === g); if (!e) groups.push(e = [g, []]); e[1].push(r); }
    const roleSel = h('select', { id: `bnd-cast-role-${p.page_id}`, class: 'bnd-filter' }, h('option', { value: '' }, 'Every role'), groups.map(([g]) => h('option', { value: g }, g)));
    const statSel = h('select', { id: `bnd-cast-st-${p.page_id}`, class: 'bnd-filter' }, h('option', { value: '' }, 'Every status'),
      [['approved', '✔ Approved'], ['draft', '✎ Draft'], ['needs_you', '⚠ Needs you']].map(([v, l]) => h('option', { value: v }, l)));
    const noPic = h('input', { type: 'checkbox', id: `bnd-cast-np-${p.page_id}` });
    const body = h('div', { class: 'bnd-cast' });
    const draw = () => {
      clear(body);
      if (!rs.length) { body.appendChild(rowsEmpty(p, '4.2', 'characters')); return; }
      for (const [g, list_] of groups) {
        const shown = list_.filter(r => {
          const name = txt(rf(r, '4.2.2')); const t = rowPage(r) || findPage(name);
          const s = String(txt(rf(r, '4.2.8')) || (t && t.status) || 'draft').toLowerCase().replace(/\s+/g, '_');
          if (roleSel.value && roleSel.value !== g) return false;
          if (statSel.value && statWord(s) !== statSel.value) return false;
          if (noPic.checked && (rowPic(p, '4.2.1', r) || (t && picOf(t, '5.1.1')))) return false;
          return true;
        });
        if (!shown.length) continue;
        body.appendChild(h('div', { class: 'bnd-group-h', 'data-fid': '4.1.1' }, h('span', { class: 'bnd-fid' }, '4.1.1'), `${g} characters `, h('small', { 'data-fid': '4.1.2' }, `(${shown.length})`)));
        body.appendChild(h('div', { class: 'bnd-cards' }, shown.map(r => castCard(p, r))));
      }
      if (!body.querySelector('.bnd-card')) body.appendChild(h('p', { class: 'bnd-empty' }, 'No character matches these filters.'));
    };
    const statWord = s => (/approved/.test(s) ? 'approved' : /need/.test(s) ? 'needs_you' : 'draft');
    for (const el of [roleSel, statSel, noPic]) el.addEventListener('change', draw);
    draw();
    return [
      sec(p, '4.1', h('div', { class: 'bnd-groups' }, groups.length ? groups.map(([g, l]) => h('span', { class: 'bnd-chip bnd-chip-count' }, h('b', null, g), ` ${l.length}`)) : val(p, '4.1.1'))),
      sec(p, '4.2', body),
      sec(p, '4.3', h('div', { class: 'bnd-filters' },
        h('label', { for: roleSel.id }, 'Role '), roleSel, h('label', { for: statSel.id }, 'Status '), statSel,
        h('label', { class: 'bnd-check' }, noPic, ' No portrait yet')), { cls: 'no-print' }),
    ];
  };
  function castCard(p, r) {
    const name = txt(rf(r, '4.2.2')); const t = rowPage(r) || findPage(name);
    const s = txt(rf(r, '4.2.8')) || (t && t.status) || 'draft';
    const pc = rowPic(p, '4.2.1', r) || (t ? picOf(t, '5.1.1') : null);
    const ph = h('div', { class: 'bnd-card-pic' }, h('span', { class: 'bnd-empty bnd-empty-pic' }, 'No portrait yet', h('span', { class: 'bnd-act' }, ' — ',
      t && safeRoute(pageEdit(t)) ? h('a', { href: pageEdit(t) }, '🎨 Make one') : '🎨 Make one')));
    if (pc) loadImg(pc.url).then(u => { if (u) clear(ph).appendChild(h('img', { src: u, alt: `Portrait of ${name}` })); });
    return h('article', { class: 'bnd-card', 'data-name': name },
      ph, h('div', { class: 'bnd-card-b' },
        h('div', { class: 'bnd-code' }, [txt(rf(r, '4.2.3')), empty(rf(r, '4.2.6')) ? null : `age ${txt(rf(r, '4.2.6'))}`].filter(Boolean).join(' · ')),
        h('h4', null, t ? pageLink(t, name) : name),
        h('div', { class: 'bnd-role' }, txt(rf(r, '4.2.4'))),
        h('p', null, empty(rf(r, '4.2.5')) ? placeholder(p, '4.2.5', rf(r, '4.2.5')) : txt(rf(r, '4.2.5'))),
        h('div', { class: 'bnd-card-foot' }, empty(rf(r, '4.2.7')) ? null : h('small', null, `First seen ${txt(rf(r, '4.2.7'))}`), badge(s, true))));
  }
  // 5 · Character page
  T[5] = p => [
    band(p, '5.1.1', '5.1.2', ['5.1.3', '5.1.4', '5.1.5', '5.1.6'], { eyebrow: `${txt(fld(p, '5.1.4')).split('·')[0].trim() || 'Character'} · story reference` }),
    sec(p, '5.2', facts(p, ['5.2.1', '5.2.2', '5.2.3', '5.2.4', '5.2.5', '5.2.6', '5.2.7', '5.2.8', '5.2.9', '5.2.10', '5.2.11', '5.2.12', '5.2.13', '5.2.14', '5.2.15', '5.2.16']), { cls: 'bnd-sec-facts' }),
    sec(p, '5.3', h('div', { class: 'bnd-pics' }, ['5.3.1', '5.3.2', '5.3.3', '5.3.4', '5.3.5', '5.3.6'].map(id => pic(p, id, { shape: id === '5.3.1' ? 'wide' : 'portrait', icon: id === '5.3.6' ? '▶' : '🖼' })))),
    sec(p, '5.4', h('div', null, field(p, '5.4.1', { cls: 'bnd-wide', chips: true }), grid(p, ['5.4.2', '5.4.3', '5.4.4', '5.4.5', '5.4.6', '5.4.7', '5.4.8', '5.4.9', '5.4.10', '5.4.11', '5.4.12']))),
    sec(p, '5.5', h('div', { class: 'bnd-quad' }, ['5.5.1', '5.5.2', '5.5.3', '5.5.4'].map(id => field(p, id, { cls: 'bnd-box' })))),
    sec(p, '5.6', h('div', null, field(p, '5.6.1', { cls: 'bnd-prose' }), grid(p, ['5.6.2', '5.6.3', '5.6.4', '5.6.5', '5.6.6', '5.6.7', '5.6.8', '5.6.9', '5.6.10']))),
    sec(p, '5.7', h('div', null, h('div', { class: 'bnd-quotes' }, quote(p, '5.7.11'), quote(p, '5.7.12')),
      grid(p, ['5.7.1', '5.7.2', '5.7.3', '5.7.4', '5.7.5', '5.7.6', '5.7.7', '5.7.8', '5.7.9', '5.7.10']))),
    sec(p, '5.8', relRows(p)),
    sec(p, '5.9', h('div', null, bars(p, ['5.9.7', '5.9.8', '5.9.9', '5.9.10', '5.9.11']), grid(p, ['5.9.1', '5.9.2', '5.9.3', '5.9.4', '5.9.5', '5.9.6', '5.9.12', '5.9.13', '5.9.14']))),
    sec(p, '5.10', grid(p, ['5.10.1', '5.10.2', '5.10.3', '5.10.4', '5.10.5'])),
    sec(p, '5.11', grid(p, ['5.11.1', '5.11.2', '5.11.3', '5.11.4', '5.11.5', '5.11.6'])),
    sec(p, '5.12', timeline(p, '5.12', '5.12.1', '5.12.2', 'backstory events')),
    sec(p, '5.13', arcSteps(p, ['5.13.1', '5.13.2', '5.13.3', '5.13.4', '5.13.5', '5.13.6', '5.13.7', '5.13.8', '5.13.9', '5.13.10'])),
    sec(p, '5.14', h('div', null, h('div', { class: 'bnd-two' }, field(p, '5.14.1'), field(p, '5.14.2', { chips: true })),
      mustReach(p, ['5.14.3', '5.14.4', '5.14.5', '5.14.6', '5.14.7']),
      grid(p, ['5.14.8', '5.14.9', '5.14.10', '5.14.11', '5.14.12']), field(p, '5.14.13', { cls: 'bnd-wide', chips: true }))),
  ];
  function relType(t) { const s = fold(t); if (s === 'other') return 'other'; for (const [k, , re] of REL_TYPES) if (re.test(s)) return k; return 'other'; }
  function relRows(p) {
    const rs = rowsOf(p, '5.8');
    if (!rs.length) return rowsEmpty(p, '5.8', 'relationships');
    return h('ul', { class: 'bnd-rels' }, rs.map(r => {
      const name = txt(rf(r, '5.8.2')).replace(/\s*\/\s*[A-Z]{2}-\d+$/, ''); const nf = rf(r, '5.8.2');
      const t = (typeof nf.link === 'string' && byId.get(nf.link)) || findPage(name); const typ = rf(r, '5.8.3'); const k = relType(txt(typ));
      return h('li', { class: `bnd-rel bnd-rel-${k}` }, bubble(name, 'm', rowPic(p, '5.8.1', r)),
        h('div', { class: 'bnd-rel-b' }, h('b', { 'data-fid': '5.8.2' }, t ? pageLink(t, name) : name || '—'),
          empty(typ) ? h('span', { class: 'bnd-reltype bnd-rel-other', 'data-fid': '5.8.3' }, placeholder(p, '5.8.3', typ, 'text', r), editBtn(p, '5.8.3', typ, r)) :
            h('span', { class: `bnd-reltype bnd-rt-${k}`, 'data-fid': '5.8.3', 'data-st': typ.status }, txt(typ), proposedMark(typ), editBtn(p, '5.8.3', typ, r)),
          h('p', { 'data-fid': '5.8.4' }, empty(rf(r, '5.8.4')) ? placeholder(p, '5.8.4', rf(r, '5.8.4')) : txt(rf(r, '5.8.4')))));
    }));
  }
  function timeline(p, code, dateId, whatId, what) {
    const rs = rowsOf(p, code);
    if (!rs.length) return rowsEmpty(p, code, what);
    return h('ol', { class: 'bnd-timeline' }, rs.map(r => h('li', null,
      h('span', { class: 'bnd-tl-dot', 'aria-hidden': 'true' }),
      h('b', { 'data-fid': dateId }, txt(rf(r, dateId)) || '—'),
      h('p', { 'data-fid': whatId }, empty(rf(r, whatId)) ? placeholder(p, whatId, rf(r, whatId)) : txt(rf(r, whatId))))));
  }
  function arcSteps(p, ids) {
    return h('ol', { class: 'bnd-arc' }, ids.map((id, i) => {
      const f = fld(p, id);
      return h('li', { class: empty(f) ? 'is-empty' : null, 'data-fid': id, 'data-st': f.status || 'empty' },
        h('span', { class: 'bnd-arc-n', 'aria-hidden': 'true' }, String(i + 1)),
        h('div', null, h('b', null, fidTag(id), META[id].short, proposedMark(f)), h('p', null, val(p, id, f))));
    }));
  }
  function mustReach(p, ids) {
    const filled = ids.filter(id => !empty(fld(p, id)));
    return h('div', { class: 'bnd-must' }, h('div', { class: 'bnd-k' }, h('span', { class: 'bnd-kl' }, '📌 Must reach the page')),
      filled.length ? h('ul', null, filled.map(id => h('li', { 'data-fid': id }, h('span', { class: 'bnd-fid' }, id), val(p, id))))
        : placeholder(p, ids[0], fld(p, ids[0])));
  }
  // 6 · Relationship map
  T[6] = p => {
    const ties = rowsOf(p, '6.3');
    const legendNames = { family: '6.2.1', love: '6.2.2', ally: '6.2.3', rival: '6.2.4', enemy: '6.2.5', mentor: '6.2.6' };
    return [
      sec(p, '6.1', relMap(p), { cls: 'bnd-sec-map' }),
      sec(p, '6.2', h('ul', { class: 'bnd-legend' }, REL_TYPES.map(([k, w]) => h('li', { 'data-fid': legendNames[k] },
        h('i', { class: `bnd-ln bnd-ln-${k}`, 'aria-hidden': 'true' }), txt(fld(p, legendNames[k])) || w)))),
      sec(p, '6.3', ties.length ? h('ol', { class: 'bnd-ties' }, ties.map(r => h('li', { 'data-fid': '6.3.1' }, linkTies(txt(rf(r, '6.3.1')))))) : derivedTies(p)),
      sec(p, '6.4', rowsOf(p, '6.4').length ? h('div', { class: 'bnd-chips' }, rowsOf(p, '6.4').map(r => {
        const n = txt(rf(r, '6.4.1')); const t = findPage(n); return t ? pageLink(t, n, 'bnd-chip bnd-link') : h('span', { class: 'bnd-chip' }, n);
      })) : rowsEmpty(p, '6.4', 'groups')),
    ];
  };
  function linkTies(s) {
    const m = /^(.*?)\s*↔\s*(.*?)(\s+—\s+.*)?$/.exec(s);
    if (!m) return s;
    const a = findPage(m[1]); const b = findPage(m[2]);
    return [a ? pageLink(a, m[1]) : m[1], ' ↔ ', b ? pageLink(b, m[2]) : m[2], m[3] || ''];
  }
  /** the relationship graph: the binder's own (template 6 `graph`: centre, nodes, edges) or, without one, the 5.8 rows */
  function graphOf(p) {
    const g = p && p.graph;
    if (!g || !Array.isArray(g.nodes)) return null;
    const name = new Map(g.nodes.map(n => [n.id, n.name]));
    const es = (g.edges || []).filter(e => name.has(e.from) && name.has(e.to)).map(e => ({ a: name.get(e.from), b: name.get(e.to),
      type: relType(e.type || 'other'), label: e.type || '', note: e.note || '' }));
    return { centre: name.get(g.centre) || null, names: g.nodes.map(n => n.name), edges: es,
      portraits: new Map(g.nodes.filter(n => n.portrait).map(n => [n.name, n.portrait])),
      pages: new Map(g.nodes.filter(n => n.page_id).map(n => [n.name, n.page_id])) };
  }
  function edges() {
    const gp = graphOf(pages.find(q => q.template === '6'));
    if (gp) return gp.edges;
    const out = []; const seen = new Set();
    for (const c of characters) {
      for (const r of rowsOf(c, '5.8')) {
        const other = findPage(txt(rf(r, '5.8.2')));
        const name = other ? pageTitle(other) : txt(rf(r, '5.8.2')).trim();
        if (!name) continue;
        const key = [pageTitle(c), name].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ a: pageTitle(c), b: name, type: relType(txt(rf(r, '5.8.3'))), label: txt(rf(r, '5.8.3')), note: txt(rf(r, '5.8.4')) });
      }
    }
    return out;
  }
  function derivedTies() {
    const es = edges().filter(e => e.note).slice(0, 5);
    if (!es.length) return h('p', { class: 'bnd-empty' }, 'Not filled yet — the strongest ties come from the Relationships section of each character.');
    return h('ol', { class: 'bnd-ties' }, es.map(e => h('li', null, linkTies(`${e.a} ↔ ${e.b}`), ` — ${e.note}`)));
  }
  /** the map: main character in the centre, the others on rings (closer = more ties), one typed line per relationship */
  function relMap(p) {
    const gp = graphOf(p);
    const es = gp ? gp.edges : edges();
    const names = []; const add = n => { if (n && !names.includes(n)) names.push(n); };
    if (gp && gp.centre) add(gp.centre);
    (gp ? gp.names : characters.map(pageTitle)).forEach(add); es.forEach(e => { add(e.a); add(e.b); });
    const nodePage = n => (gp && gp.pages.has(n) && byId.get(gp.pages.get(n))) || findPage(n);
    if (!names.length) return h('p', { class: 'bnd-empty' }, 'Not filled yet — add characters and their relationships first.');
    const centreName = (() => {
      if (gp && gp.centre) return gp.centre;
      const want = txt(fld(p, '6.1.3')); const t = want ? findPage(want) : null;
      if (t) return pageTitle(t);
      const prot = characters.find(c => /protag|main|hero/i.test(txt(fld(c, '5.1.5'))));
      return prot ? pageTitle(prot) : names[0];
    })();
    const deg = n => es.filter(e => e.a === n || e.b === n).length;
    const narrow = !!(window.matchMedia && window.matchMedia('(max-width: 640px)').matches);
    const W = narrow ? 480 : 900; const H = narrow ? 640 : 560; const cx = W / 2; const cy = H / 2;
    const others = names.filter(n => n !== centreName).sort((a, b) => deg(b) - deg(a)).slice(0, 14);
    const linked = (a, b) => es.some(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
    // neighbours on a ring sit next to each other, so their lines run round the edge instead of through the centre
    const chain = arr => { const left = arr.slice(); const out = []; while (left.length) { const last = out[out.length - 1]; let i = last ? left.findIndex(n => linked(last, n)) : 0; if (i < 0) i = 0; out.push(left.splice(i, 1)[0]); } return out; };
    const tied = chain(others.filter(n => linked(centreName, n)));
    const far = chain(others.filter(n => !tied.includes(n)));
    const pos = { [centreName]: [cx, cy] };
    const ring = (arr, rx, ry, off) => arr.forEach((n, i) => {
      const a = -Math.PI / 2 + off + (i / Math.max(arr.length, 1)) * Math.PI * 2;
      pos[n] = [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
    });
    ring(tied, W * (far.length ? 0.26 : 0.33), H * (far.length ? 0.27 : 0.33), -Math.PI / Math.max(tied.length, 2));
    ring(far, W * 0.41, H * 0.4, Math.PI / Math.max(far.length, 2));
    const svg = sv('svg', { class: `bnd-relmap${narrow ? ' is-narrow' : ''}`, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-labelledby': `bbrm-${p.page_id}` },
      sv('title', { id: `bbrm-${p.page_id}` }, `Relationship map: ${centreName} in the centre, ${es.length} relationships between ${Object.keys(pos).length} characters`));
    const defs = sv('defs');
    svg.appendChild(defs);
    const lines = sv('g', { class: 'bnd-rm-lines' });
    const labels = sv('g', { class: 'bnd-rm-labels' });
    svg.appendChild(lines); svg.appendChild(labels);
    es.forEach((e, i) => {
      const A = pos[e.a]; const B = pos[e.b];
      if (!A || !B) return;
      // a slight curve so two lines between neighbours never sit on top of each other
      const mx = (A[0] + B[0]) / 2; const my = (A[1] + B[1]) / 2;
      const dx = B[0] - A[0]; const dy = B[1] - A[1]; const len = Math.hypot(dx, dy) || 1;
      const bend = (i % 2 ? 1 : -1) * Math.min(28, len * 0.08);
      const qx = mx - dy / len * bend; const qy = my + dx / len * bend;
      lines.appendChild(sv('path', { d: `M${A[0].toFixed(1)} ${A[1].toFixed(1)}Q${qx.toFixed(1)} ${qy.toFixed(1)} ${B[0].toFixed(1)} ${B[1].toFixed(1)}`,
        class: `bnd-rm-line bnd-ln-${e.type}`, 'data-a': e.a, 'data-b': e.b, 'data-type': e.type },
      sv('title', null, `${e.a} ↔ ${e.b}: ${e.label || 'tie'}${e.note ? ' — ' + e.note : ''}`)));
      if (e.label) {
        const lx = (A[0] + 2 * qx + B[0]) / 4; const ly = (A[1] + 2 * qy + B[1]) / 4;
        const w = Math.min(140, 12 + e.label.length * (narrow ? 7.8 : 6.4));
        labels.appendChild(sv('g', { class: `bnd-rm-tag bnd-rt-${e.type}`, transform: `translate(${lx.toFixed(1)} ${ly.toFixed(1)})` },
          sv('rect', { x: -w / 2, y: -10, width: w, height: 20, rx: 10 }), sv('text', { y: 4, 'text-anchor': 'middle' }, e.label.slice(0, 18))));
      }
    });
    const nodes = sv('g', { class: 'bnd-rm-nodes' });
    svg.appendChild(nodes);
    Object.entries(pos).forEach(([n, [x0, y0]], i) => {
      const main_ = n === centreName; const r = (main_ ? 54 : 38) * (narrow ? 0.9 : 1);
      const t = nodePage(n);
      const clipId = `bbclip-${p.page_id}-${i}`;
      defs.appendChild(sv('clipPath', { id: clipId }, sv('circle', { cx: x0, cy: y0, r: r - 4 })));
      const g = sv('g', { class: `bnd-rm-node${main_ ? ' is-main' : ''}`, 'data-name': n, tabindex: t ? '0' : null, role: t ? 'link' : null, 'aria-label': t ? `${n} — open page ${t._n}` : null });
      g.appendChild(sv('circle', { cx: x0, cy: y0, r, class: 'bnd-rm-ring' }));
      const ini = String(n).split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase();
      g.appendChild(sv('text', { x: x0, y: y0 + (main_ ? 10 : 7), 'text-anchor': 'middle', class: 'bnd-rm-ini' }, ini));
      const pc = (gp && gp.portraits.has(n)) ? { url: gp.portraits.get(n) } : t ? picOf(t, '5.1.1') : null;
      if (pc) loadImg(pc.url).then(u => { if (u) g.insertBefore(sv('image', { href: u, x: x0 - r + 4, y: y0 - r + 4, width: 2 * r - 8, height: 2 * r - 8, 'clip-path': `url(#${clipId})`, preserveAspectRatio: 'xMidYMid slice' }), g.childNodes[2] || null); });
      const lw = Math.max(70, n.length * (narrow ? 10.4 : 8.4) + 18);
      const nh = narrow ? 30 : 24;
      g.appendChild(sv('rect', { x: Math.max(2, Math.min(W - lw - 2, x0 - lw / 2)), y: y0 + r + 6, width: lw, height: nh, rx: nh / 2, class: 'bnd-rm-name-bg' }));
      g.appendChild(sv('text', { x: Math.max(2 + lw / 2, Math.min(W - lw / 2 - 2, x0)), y: y0 + r + 6 + nh * 0.7, 'text-anchor': 'middle', class: 'bnd-rm-name' }, n));
      if (main_) {
        g.appendChild(sv('circle', { cx: x0 + r * 0.72, cy: y0 - r * 0.72, r: 13, class: 'bnd-rm-star-bg' }));
        g.appendChild(sv('text', { x: x0 + r * 0.72, y: y0 - r * 0.72 + 5, 'text-anchor': 'middle', class: 'bnd-rm-star' }, '★', sv('title', null, 'Main character')));
      }
      if (t) {
        g.addEventListener('click', () => goto(t.page_id));
        g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); goto(t.page_id); } });
      }
      nodes.appendChild(g);
    });
    return h('div', { class: 'bnd-rm-wrap' }, svg,
      h('p', { class: 'bnd-note' }, fidTag('6.1.2'), `Lines come from the ❤ Relationships section of each character page (${es.length}). The main character is in the centre; characters with more ties sit closer.`));
  }
  // 7 · Place page
  T[7] = p => [
    band(p, '7.1.1', '7.1.2', ['7.1.3', '7.1.4', '7.1.5', '7.1.6'], { shape: 'wide', cls: 'bnd-band-wide', eyebrow: `${txt(fld(p, '7.1.3')) || 'Place'} · story reference`, icon: '🏙' }),
    sec(p, '7.2', facts(p, ['7.2.1', '7.2.2', '7.2.3', '7.2.4', '7.2.5', '7.2.6', '7.2.7', '7.2.8'], { '7.2.7': f => empty(f) ? placeholder(p, '7.2.7', f) : pips(f) }), { cls: 'bnd-sec-facts' }),
    sec(p, '7.3', h('div', { class: 'bnd-pics bnd-pics-3' }, ['7.3.1', '7.3.2', '7.3.3'].map(id => pic(p, id, { shape: 'wide' })))),
    sec(p, '7.4', h('div', null, grid(p, ['7.4.1', '7.4.2', '7.4.3', '7.4.4', '7.4.5', '7.4.6', '7.4.7', '7.4.8']), field(p, '7.4.9', { cls: 'bnd-callout' }))),
    sec(p, '7.5', h('div', { class: 'bnd-side' }, grid(p, ['7.5.1', '7.5.2', '7.5.3', '7.5.4', '7.5.5', '7.5.6']), pic(p, '7.5.7', { shape: 'square', icon: '🗺' }))),
    sec(p, '7.6', grid(p, ['7.6.1', '7.6.2', '7.6.3', '7.6.4', '7.6.5', '7.6.6', '7.6.7'])),
    sec(p, '7.7', grid(p, ['7.7.1', '7.7.2', '7.7.3', '7.7.4', '7.7.5', '7.7.6', '7.7.7', '7.7.8'])),
    sec(p, '7.8', grid(p, ['7.8.1', '7.8.2', '7.8.3', '7.8.4', '7.8.5', '7.8.6', '7.8.7']), { cls: 'bnd-sec-rules' }),
    sec(p, '7.9', grid(p, ['7.9.1', '7.9.2', '7.9.3', '7.9.4', '7.9.5', '7.9.6'])),
    sec(p, '7.10', h('div', null, grid(p, ['7.10.1', '7.10.2', '7.10.3', '7.10.4', '7.10.5']), mustReach(p, ['7.10.6', '7.10.7', '7.10.8']),
      grid(p, ['7.10.9', '7.10.10', '7.10.11', '7.10.12']), field(p, '7.10.13', { cls: 'bnd-wide', chips: true }))),
  ];
  // 8A · Magic system
  T['8A'] = p => [
    band(p, '8A.1.1', '8A.1.2', ['8A.1.3', '8A.1.4', '8A.1.5'], { shape: 'square', icon: '✨', eyebrow: `${txt(fld(p, '8A.1.3')) || 'Magic'} · magic system` }),
    sec(p, '8A.2', facts(p, ['8A.2.1', '8A.2.2', '8A.2.3', '8A.2.4', '8A.2.5']), { cls: 'bnd-sec-facts' }),
    sec(p, '8A.3', grid(p, ['8A.3.1', '8A.3.2', '8A.3.3', '8A.3.4', '8A.3.5', '8A.3.6', '8A.3.7']), { cls: 'bnd-sec-rules' }),
    sec(p, '8A.4', powerCards(p)),
    sec(p, '8A.5', grid(p, ['8A.5.1', '8A.5.2', '8A.5.3', '8A.5.4'])),
    sec(p, '8A.6', grid(p, ['8A.6.1', '8A.6.2', '8A.6.3', '8A.6.4', '8A.6.5'])),
    sec(p, '8A.7', grid(p, ['8A.7.1', '8A.7.2', '8A.7.3', '8A.7.4', '8A.7.5']), { cls: 'bnd-sec-warn' }),
    sec(p, '8A.8', grid(p, ['8A.8.1', '8A.8.2', '8A.8.3', '8A.8.4', '8A.8.5'])),
    sec(p, '8A.9', grid(p, ['8A.9.1', '8A.9.2', '8A.9.3', '8A.9.4'])),
    sec(p, '8A.10', grid(p, ['8A.10.1', '8A.10.2', '8A.10.3', '8A.10.4'])),
    sec(p, '8A.11', h('div', { class: 'bnd-side' }, grid(p, ['8A.11.2', '8A.11.3', '8A.11.4', '8A.11.5', '8A.11.6']), pic(p, '8A.11.1', { shape: 'wide' }))),
  ];
  function powerCards(p) {
    const rs = rowsOf(p, '8A.4');
    if (!rs.length) return rowsEmpty(p, '8A.4', 'named powers');
    return h('div', { class: 'bnd-powers' }, rs.map((r, i) => h('article', { class: 'bnd-power' },
      h('span', { class: 'bnd-power-n', 'aria-hidden': 'true' }, '⚡'),
      h('h4', { 'data-fid': '8A.4.1' }, txt(rf(r, '8A.4.1')) || `Power ${i + 1}`),
      h('p', { 'data-fid': '8A.4.2' }, empty(rf(r, '8A.4.2')) ? placeholder(p, '8A.4.2', rf(r, '8A.4.2')) : txt(rf(r, '8A.4.2'))),
      h('small', { 'data-fid': '8A.4.3' }, 'Used by: ', empty(rf(r, '8A.4.3')) ? '—' : linkify('8A.8.1', txt(rf(r, '8A.4.3')))))));
  }
  // 8B · Item
  T['8B'] = p => [
    band(p, '8B.1.1', '8B.1.2', ['8B.1.3', '8B.1.4', '8B.1.5'], { shape: 'square', icon: '🗝', eyebrow: `${txt(fld(p, '8B.1.3')) || 'Item'} · item dossier` }),
    sec(p, '8B.2', facts(p, ['8B.2.1', '8B.2.2', '8B.2.3', '8B.2.4', '8B.2.5', '8B.2.6']), { cls: 'bnd-sec-facts' }),
    sec(p, '8B.3', h('div', { class: 'bnd-pics bnd-pics-4' }, ['8B.3.1', '8B.3.2', '8B.3.3', '8B.3.4'].map(id => pic(p, id, { shape: 'square' })))),
    sec(p, '8B.4', grid(p, ['8B.4.1', '8B.4.2', '8B.4.3', '8B.4.4', '8B.4.5', '8B.4.6', '8B.4.7']), { cls: 'bnd-sec-rules' }),
    sec(p, '8B.5', grid(p, ['8B.5.1', '8B.5.2', '8B.5.3', '8B.5.4', '8B.5.5'])),
    sec(p, '8B.6', grid(p, ['8B.6.1', '8B.6.2', '8B.6.3', '8B.6.4', '8B.6.5', '8B.6.6'])),
    sec(p, '8B.7', grid(p, ['8B.7.1', '8B.7.2', '8B.7.3', '8B.7.4', '8B.7.5', '8B.7.6'])),
    sec(p, '8B.8', h('div', null, grid(p, ['8B.8.1', '8B.8.2', '8B.8.3', '8B.8.4', '8B.8.5']),
      field(p, '8B.8.6', { cls: 'bnd-wide', render: f => empty(f) ? placeholder(p, '8B.8.6', f) : h('ol', { class: 'bnd-strip' }, list({ value: txt(f).split(/\s*→\s*/) }).map(s => h('li', null, s))) }),
      grid(p, ['8B.8.7', '8B.8.8', '8B.8.9', '8B.8.10']), field(p, '8B.8.11', { cls: 'bnd-wide', chips: true }))),
  ];
  // 8C · Other world entry
  T['8C'] = p => [
    band(p, '8C.1.1', '8C.1.2', ['8C.1.3', '8C.1.4'], { shape: 'square', icon: '🏛', eyebrow: `${txt(fld(p, '8C.1.3')) || 'World'} · world entry` }),
    sec(p, '8C.2', field(p, '8C.2.1', { cls: 'bnd-prose' })),
    sec(p, '8C.3', facts(p, ['8C.3.1', '8C.3.2', '8C.3.3', '8C.3.4', '8C.3.5'], { '8C.3.5': f => empty(f) ? placeholder(p, '8C.3.5', f) : swatches(txt(f)) }), { cls: 'bnd-sec-facts' }),
    sec(p, '8C.4', grid(p, ['8C.4.1', '8C.4.2', '8C.4.3']), { cls: 'bnd-sec-rules' }),
    sec(p, '8C.5', grid(p, ['8C.5.1', '8C.5.2', '8C.5.3'])),
    sec(p, '8C.6', grid(p, ['8C.6.1', '8C.6.2', '8C.6.3', '8C.6.4'])),
  ];
  function swatches(s) {
    const cols = (s.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) || []).slice(0, 6);
    return h('span', null, cols.map(c => h('i', { class: 'bnd-swatch', style: `background:${c}`, title: c })), ' ', s);
  }
  // 9 · Map page
  T[9] = p => {
    const keys = rowsOf(p, '9.2');
    return [
      sec(p, '9.1', mapBox(p, keys), { cls: 'bnd-sec-map' }),
      sec(p, '9.2', keys.length ? h('ol', { class: 'bnd-mapkey' }, keys.map((r, i) => {
        const n = txt(rf(r, '9.2.1')) || String(i + 1); const name = txt(rf(r, '9.2.2')); const t = rowPage(r) || findPage(name) || pages[(num(txt(rf(r, '9.2.3'))) || 0) - 1];
        return h('li', null, h('span', { class: 'bnd-marker', 'data-fid': '9.2.1' }, n), h('span', { 'data-fid': '9.2.2' }, t ? pageLink(t, name || pageTitle(t)) : name),
          h('small', { 'data-fid': '9.2.3' }, t ? `p. ${t._n}` : txt(rf(r, '9.2.3')) ? `p. ${txt(rf(r, '9.2.3'))}` : ''));
      })) : rowsEmpty(p, '9.2', 'markers')),
      sec(p, '9.3', rowTable(p, '9.3', ['9.3.1', '9.3.2', '9.3.3'], 'distances')),
      sec(p, '9.4', h('div', { class: 'bnd-compass-row' }, orn(ORN.compass, 'bnd-compass'),
        facts(p, ['9.4.1', '9.4.2']))),
    ];
  };
  function mapBox(p, keys) {
    const pc = picOf(p, '9.1.1') || (p.map && p.map.png_url ? { url: p.map.png_url, alt: `Map of ${book.title}` } : null);
    const wrap = h('div', { class: 'bnd-map', 'data-fid': '9.1.1' });
    // marker positions: the row's _meta x/y (or the field's), in the map's own units -> 12–88 % of the picture
    const raw = keys.map(r => { const f = rf(r, '9.2.1'); const m = rowMeta(r);
      const x0 = typeof m.x === 'number' ? m.x : typeof f.x === 'number' ? f.x : Array.isArray(f.pos) ? f.pos[0] : null;
      const y0 = typeof m.y === 'number' ? m.y : typeof f.y === 'number' ? f.y : Array.isArray(f.pos) ? f.pos[1] : null;
      return x0 === null || y0 === null ? null : [x0, y0]; });
    const known = raw.filter(Boolean);
    const unit = known.length && known.every(([a, b]) => a >= 0 && a <= 1 && b >= 0 && b <= 1) && known.some(([a, b]) => a > 0 || b > 0);
    const [x1, x2] = [Math.min(...known.map(q => q[0])), Math.max(...known.map(q => q[0]))];
    const [y1, y2] = [Math.min(...known.map(q => q[1])), Math.max(...known.map(q => q[1]))];
    const place = (q, i) => {
      if (!q) return [0.15 + ((i * 0.31) % 0.7), 0.2 + ((i * 0.23) % 0.6)];
      if (unit) return q;
      return [x2 > x1 ? 0.12 + 0.76 * (q[0] - x1) / (x2 - x1) : 0.5, y2 > y1 ? 0.18 + 0.64 * (q[1] - y1) / (y2 - y1) : 0.5];
    };
    const art = h('div', { class: 'bnd-map-art' });
    wrap.appendChild(art);
    const drawFallback = () => {
      art.appendChild(orn(S0 + 'viewBox="0 0 800 520"><rect width="800" height="520" fill="var(--bnd-card-2)"/><g fill="var(--bnd-paper)" stroke="var(--bnd-line)" stroke-width="3"><path d="M60 80c120-40 240-20 320 40s40 160-20 220-200 130-260 60S-20 120 60 80z"/><path d="M500 90c100-30 200 0 240 80s-20 200-120 230-180-60-170-150 0-140 50-160z"/></g><path d="M40 330c120-40 220 30 330-10s180-80 400-20" fill="none" stroke="var(--bnd-line)" stroke-width="12" stroke-linecap="round"/></svg>', 'bnd-map-svg'));
      art.appendChild(h('p', { class: 'bnd-map-ph' }, placeholder(p, '9.1.1', fld(p, '9.1.1'), 'pic')));
    };
    if (pc) {
      wrap.setAttribute('data-img-loading', '1');
      loadImg(pc.url).then(u => { wrap.removeAttribute('data-img-loading'); if (u) art.appendChild(h('img', { src: u, alt: pc.alt || `Map of ${book.title}` })); else drawFallback(); });
    } else drawFallback();
    keys.forEach((r, i) => {
      const f = rf(r, '9.2.1'); const n = txt(f) || String(i + 1);
      const [x0, y0] = place(raw[i], i);
      const name = txt(rf(r, '9.2.2')); const t = rowPage(r) || findPage(name);
      const pin = h(t ? 'a' : 'span', { class: 'bnd-pin', style: `left:${(x0 * 100).toFixed(1)}%;top:${(y0 * 100).toFixed(1)}%`,
        href: t ? plink('bible', t.page_id) : null, title: name, 'aria-label': `${n} · ${name}` }, h('b', null, n), h('span', { class: 'bnd-pin-n' }, name));
      if (t) pin.addEventListener('click', ev => { ev.preventDefault(); goto(t.page_id); });
      wrap.appendChild(pin);
    });
    wrap.appendChild(orn(ORN.compass, 'bnd-map-compass'));
    if (!empty(fld(p, '9.4.2'))) wrap.appendChild(h('span', { class: 'bnd-map-scale' }, h('i'), txt(fld(p, '9.4.2'))));
    return wrap;
  }
  // 10 · Story plan
  T[10] = p => [
    sec(p, '10.1', h('div', null, field(p, '10.1.1', { cls: 'bnd-prose' }), field(p, '10.1.2', { cls: 'bnd-callout' }))),
    sec(p, '10.2', plotLine(p), { cls: 'bnd-sec-plot' }),
    sec(p, '10.3', arcCards(p)),
    sec(p, '10.4', rowTable(p, '10.4', ['10.4.1', '10.4.2', '10.4.3'], 'subplots')),
    sec(p, '10.5', h('div', null, field(p, '10.5.1', { chips: true, cls: 'bnd-wide' }), grid(p, ['10.5.2', '10.5.3']), quote(p, '10.5.4', 'bnd-quote-q'))),
    sec(p, '10.6', h('div', { class: 'bnd-quad' }, ['10.6.1', '10.6.2', '10.6.3', '10.6.4'].map(id => field(p, id, { cls: 'bnd-box' })))),
  ];
  function chapterOf(f) {
    if (f && (typeof f.chapter === 'number' || typeof f.chapter === 'string') && String(f.chapter).trim()) return String(f.chapter).replace(/^ch(apter)?\.?\s*/i, '');
    const m = /^\s*(?:ch(?:apter)?\.?\s*)(\d+)\s*[—:–-]?\s*/i.exec(txt(f));
    return m ? m[1] : '';
  }
  function noteOf(f) { return txt(f).replace(/^\s*(?:ch(?:apter)?\.?\s*)\d+\s*[—:–-]?\s*/i, ''); }
  function plotLine(p) {
    const ids = ['10.2.1', '10.2.2', '10.2.3', '10.2.4', '10.2.5', '10.2.6', '10.2.7', '10.2.8'];
    const ys = [0.86, 0.76, 0.6, 0.47, 0.36, 0.1, 0.55, 0.84];
    const W = 900; const H = 250; const pad = 46;
    const pts = ids.map((id, i) => [pad + i * (W - 2 * pad) / 7, 18 + ys[i] * (H - 60)]);
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) { const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i]; const mx = (x0 + x1) / 2; d += ` C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`; }
    const svg = sv('svg', { class: 'bnd-plot', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Plot line: the eight turning points of the story' },
      sv('path', { d: `M${pad} ${H - 34}H${W - pad}`, class: 'bnd-plot-axis' }),
      sv('path', { d, class: 'bnd-plot-line' }),
      pts.map(([x0, y0], i) => sv('g', { class: `bnd-plot-pt${empty(fld(p, ids[i])) ? ' is-empty' : ''}` },
        sv('path', { d: `M${x0} ${y0}V${H - 34}`, class: 'bnd-plot-drop' }),
        sv('circle', { cx: x0, cy: y0, r: 8 }),
        sv('text', { x: x0, y: y0 - 16, 'text-anchor': 'middle', class: 'bnd-plot-lab' }, META[ids[i]].short.replace(' / all is lost', '')),
        chapterOf(fld(p, ids[i])) ? sv('text', { x: x0, y: H - 14, 'text-anchor': 'middle', class: 'bnd-plot-ch' }, `Ch ${chapterOf(fld(p, ids[i]))}`) : null)));
    return h('div', null, h('div', { class: 'bnd-plot-wrap' }, svg),
      h('ol', { class: 'bnd-beats' }, ids.map((id, i) => {
        const f = fld(p, id);
        return h('li', { class: empty(f) ? 'is-empty' : null, 'data-fid': id, 'data-st': f.status || 'empty' },
          h('span', { class: 'bnd-beat-n', 'aria-hidden': 'true' }, String(i + 1)),
          h('div', null, h('b', null, fidTag(id), META[id].short, chapterOf(f) ? h('span', { class: 'bnd-beat-ch' }, ` · Ch ${chapterOf(f)}`) : null, proposedMark(f)),
            h('p', null, empty(f) ? placeholder(p, id, f) : linkify(id, noteOf(f)))));
      })));
  }
  function arcCards(p) {
    const rs = rowsOf(p, '10.3');
    if (!rs.length) return rowsEmpty(p, '10.3', 'character arcs');
    return h('div', { class: 'bnd-arcs' }, rs.map(r => {
      const name = txt(rf(r, '10.3.1')); const t = findPage(name);
      return h('article', { class: 'bnd-arccard' }, bubble(name, 'm'), h('div', null, h('b', null, t ? pageLink(t, name) : name),
        h('p', { class: 'bnd-fromto' }, h('span', { 'data-fid': '10.3.2' }, txt(rf(r, '10.3.2')) || '—'), h('span', { class: 'bnd-arrow', 'aria-label': 'becomes' }, ' → '),
          h('span', { 'data-fid': '10.3.3' }, txt(rf(r, '10.3.3')) || '—'))));
    }));
  }
  // 11 · Chapter page
  T[11] = p => {
    const wc = num(txt(fld(p, '11.1.5'))); const tgt = num(txt(fld(p, '11.1.6')));
    const pct = wc !== null && tgt ? Math.min(100, Math.round(wc / tgt * 100)) : 0;
    const chNo = txt(fld(p, '11.1.1'));
    return [
      band(p, '11.1.3', '11.1.2', [], { shape: 'wide', cls: 'bnd-band-wide bnd-band-ch', eyebrow: `Chapter ${chNo || p._n}`, icon: '📄', name: txt(fld(p, '11.1.2')) || pageTitle(p),
        lead: h('div', { class: 'bnd-ch-lead' },
          h('span', { class: 'bnd-ch-num', 'data-fid': '11.1.1' }, h('span', { class: 'bnd-fid' }, '11.1.1'), chNo || '—'),
          h('div', { class: 'bnd-ch-meta' },
            h('span', { 'data-fid': '11.1.4' }, h('span', { class: 'bnd-fid' }, '11.1.4'), badge(/approved/i.test(txt(fld(p, '11.1.4'))) ? 'approved' : /plan/i.test(txt(fld(p, '11.1.4'))) ? 'needs_you' : 'draft'),
              /approved/i.test(txt(fld(p, '11.1.4'))) ? null : ` ${txt(fld(p, '11.1.4')) || 'Not started'}`),
            h('div', { class: 'bnd-wc', 'data-fid': '11.1.5' }, h('span', null, h('span', { class: 'bnd-fid' }, '11.1.5 / 11.1.6 '),
              wc !== null ? `${txt(fld(p, '11.1.5'))} words` : 'No words yet', tgt ? ` of ${txt(fld(p, '11.1.6'))}` : ''),
            h('div', { class: 'bnd-progress', role: 'progressbar', 'aria-label': 'Words written', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('div', { style: `width:${pct}%` }))))) }),
      sec(p, '11.2', facts(p, ['11.2.1', '11.2.2', '11.2.3', '11.2.4'], {
        '11.2.1': f => empty(f) ? placeholder(p, '11.2.1', f) : h('span', { class: 'bnd-who' }, bubble(txt(f), 's'), linkify('11.2.1', txt(f))),
        '11.2.2': f => empty(f) ? placeholder(p, '11.2.2', f) : h('span', { class: 'bnd-who' }, bubble(txt(f), 's'), linkify('11.2.2', txt(f))),
      }), { cls: 'bnd-sec-facts' }),
      sec(p, '11.3', h('div', null, field(p, '11.3.1', { cls: 'bnd-prose' }), field(p, '11.3.2', { cls: 'bnd-callout' }))),
      sec(p, '11.4', sceneCards(p)),
      sec(p, '11.5', (() => { const rs = rowsOf(p, '11.5'); return rs.length ? h('div', { class: 'bnd-who-row' }, rs.map(r => { const n = txt(rf(r, '11.5.1')); const t = (typeof rf(r, '11.5.1').link === 'string' && byId.get(rf(r, '11.5.1').link)) || rowPage(r) || findPage(n); return h('span', { class: 'bnd-who-card' }, bubble(n, 'm', rowPic(p, '11.5.1', r)), t ? pageLink(t, n) : n); })) : rowsEmpty(p, '11.5', 'characters'); })()),
      sec(p, '11.6', (() => { const rs = rowsOf(p, '11.6'); return rs.length ? h('ul', { class: 'bnd-checklist' }, rs.map(r => {
        const ok = /✔|on the page|yes|done/i.test(txt(rf(r, '11.6.2'))); const known = !empty(rf(r, '11.6.2'));
        return h('li', { class: known ? (ok ? 'is-ok' : 'is-miss') : null }, h('span', { class: 'bnd-ck', 'aria-hidden': 'true' }, known ? (ok ? '✔' : '⚠') : '○'),
          h('span', { 'data-fid': '11.6.1' }, txt(rf(r, '11.6.1'))), h('small', { 'data-fid': '11.6.2' }, known ? (ok ? 'on the page' : 'missing') : 'not checked yet'));
      })) : rowsEmpty(p, '11.6', 'planned details'); })()),
      sec(p, '11.7', grid(p, ['11.7.1', '11.7.2'])),
      sec(p, '11.8', h('div', { class: 'bnd-checks' }, ['11.8.1', '11.8.2', '11.8.3', '11.8.4'].map(id => {
        const f = fld(p, id);
        return h('div', { class: `bnd-statbox${id === '11.8.4' && (num(txt(f)) || 0) > 0 ? ' is-warn' : ''}`, 'data-fid': id },
          h('strong', null, empty(f) ? '—' : txt(f)), h('small', null, fidTag(id), META[id].short));
      }))),
    ];
  };
  function sceneCards(p) {
    const rs = rowsOf(p, '11.4');
    if (!rs.length) return rowsEmpty(p, '11.4', 'scenes');
    return h('div', { class: 'bnd-scenes' }, rs.map((r, i) => h('article', { class: 'bnd-scene' },
      h('header', null, h('span', { class: 'bnd-scene-n', 'data-fid': '11.4.1' }, `Scene ${txt(rf(r, '11.4.1')) || i + 1}`),
        h('small', { 'data-fid': '11.4.6' }, txt(rf(r, '11.4.6')))),
      h('dl', null, [['11.4.2', 'Goal'], ['11.4.3', 'Conflict'], ['11.4.4', 'Outcome'], ['11.4.5', 'Who']].map(([id, w]) =>
        h('div', { 'data-fid': id }, h('dt', null, w), h('dd', null, empty(rf(r, id)) ? h('span', { class: 'bnd-dash' }, '—') : txt(rf(r, id)))))))));
  }
  // 12 · Rules & facts
  T[12] = p => [
    sec(p, '12.1', (() => { const rs = rowsOf(p, '12.1'); return rs.length ? h('div', { class: 'bnd-locks' }, rs.map(r => h('article', { class: 'bnd-lock' },
      h('span', { class: 'bnd-lock-i', 'aria-hidden': 'true' }, '🔒'),
      h('div', null, h('b', { 'data-fid': '12.1.1' }, txt(rf(r, '12.1.1'))),
        h('small', { 'data-fid': '12.1.2' }, 'About: ', empty(rf(r, '12.1.2')) ? '—' : linkify('12.1.2', txt(rf(r, '12.1.2')))),
        h('p', { 'data-fid': '12.1.3' }, txt(rf(r, '12.1.3'))))))) : rowsEmpty(p, '12.1', 'protected facts'); })(), { cls: 'bnd-sec-hl' }),
    sec(p, '12.2', h('div', null, field(p, '12.2.1', { cls: 'bnd-rulebox' }), grid(p, ['12.2.2', '12.2.3', '12.2.4']))),
    sec(p, '12.3', rowTable(p, '12.3', ['12.3.1', '12.3.2', '12.3.3', '12.3.4'], 'timeline events', {
      '12.3.3': f => empty(f) ? h('span', { class: 'bnd-dash' }, '—') : `Ch ${txt(f).replace(/^ch\s*/i, '')}`,
      '12.3.4': f => empty(f) ? h('span', { class: 'bnd-ok' }, '✔ no clash') : h('span', { class: 'bnd-clash' }, txt(f)),
    })),
    sec(p, '12.4', rowTable(p, '12.4', ['12.4.1', '12.4.2', '12.4.3', '12.4.4'], 'names or terms')),
    sec(p, '12.5', rowTable(p, '12.5', ['12.5.1', '12.5.2'], 'world details')),
    sec(p, '12.6', facts(p, ['12.6.1', '12.6.2', '12.6.3', '12.6.4', '12.6.5', '12.6.6', '12.6.7']), { cls: 'bnd-sec-facts' }),
    sec(p, '12.7', (() => { const rs = rowsOf(p, '12.7'); return rs.length ? h('div', { class: 'bnd-chips' }, rs.map(r => {
      const prot = /protect|catch/i.test(txt(rf(r, '12.7.2')));
      return h('span', { class: `bnd-chip${prot ? ' bnd-chip-lock' : ' bnd-chip-warn'}`, title: txt(rf(r, '12.7.2')) }, prot ? '🔒 ' : '🔁 ', `“${txt(rf(r, '12.7.1'))}”`, h('small', null, ` ${txt(rf(r, '12.7.2'))}`));
    })) : rowsEmpty(p, '12.7', 'repeats'); })()),
  ];

  /* ================================================================== page frame */
  function renderPage(p) {
    const tid = p.template; const [icon, , eyebrow, tagline] = TPL[tid];
    let content;
    try { content = T[tid](p); }
    catch (e) {   // one broken page never takes the binder down
      content = [h('section', { class: 'bnd-sec' }, h('p', { class: 'bnd-empty' }, 'This page could not be drawn: ', String(e && e.message || e)))];
    }
    const corners = ['tl', 'tr', 'bl', 'br'].map(c => orn(ORN.corner[st.look] || ORN.corner.classic, `bnd-corner bnd-corner-${c}`));
    const head = tid === '1' ? null : h('div', { class: 'bnd-pagehead' },
      h('div', { class: 'bnd-eyebrow' }, ENTITY.has(tid) ? `${eyebrow} · ${book.title}` : eyebrow),
      ENTITY.has(tid) ? null : h('h2', { class: 'bnd-title' }, pageTitle(p)),
      orn(ORN.rule[st.look] || ORN.rule.classic, 'bnd-rule'),
      h('div', { class: 'bnd-subhead' }, tagline));
    return h('article', { class: 'bnd-page', 'data-template': tid, 'data-page-id': p.page_id, id: `bbp-${p.page_id}`, 'aria-label': `Page ${p._n}: ${pageTitle(p)}` },
      corners,
      st.look === 'noir' ? orn(ORN.stamp, 'bnd-stamp') : null,
      h('div', { class: 'bnd-runhead' }, h('span', null, book.title), h('span', { 'aria-hidden': 'true' }, ` ${icon} `), h('span', null, pageTitle(p)), badge(p.status)),
      pageTools(p),
      head,
      h('div', { class: 'bnd-body' }, content),
      h('footer', { class: 'bnd-foot' }, h('span', null, book.title), h('span', null, `Book Bible${lastUpdated ? ' · updated ' + lastUpdated : ''}`), h('span', { class: 'bnd-pno' }, `Page ${p._n} of ${pages.length}`)));
  }

  /* ================================================================== chrome: toolbar, rail, pager */
  const msg = h('div', { class: 'bnd-msg', 'aria-live': 'polite', 'data-testid': 'binder-msg' });
  /** on screen, under the header strip: ✨ Fill this page from the book · ✔ Approve the proposals of its 🆕 fields */
  function pageTools(p) {
    const targets = new Set();
    for (const sec of Object.values(p.sections || {})) {
      for (const [id, f] of Object.entries((sec && sec.fields) || {})) { const sp = editSpec(p, id, f, null); if (sp) targets.add(sp.target); }
      for (const r of (sec && sec.rows) || []) for (const [id, f] of Object.entries(r || {})) { if (id.startsWith('_')) continue; const sp = editSpec(p, id, f, r); if (sp && sp.kind !== 'relationship') targets.add(sp.target); }
    }
    if (p.target) targets.add(p.target);
    const props = pageProposals(p);
    const n = Object.values(props).reduce((a, ks) => a + ks.length, 0);
    const fillTargets = [...targets].filter(t => fieldsInfo[String(t).split(':')[0]]);
    if (!fillTargets.length && !n) return null;
    return h('div', { class: 'bnd-pagetools no-print' },
      fillTargets.length ? h('button', { type: 'button', 'data-testid': 'binder-fill-page', title: 'The AI reads the book and proposes the 🆕 quick facts of this page. Nothing you wrote is replaced; you approve each proposal.',
        onclick: ev => runFill(fillTargets, ev.currentTarget) }, '✨ Fill this page from the book') : null,
      n ? h('button', { type: 'button', 'data-testid': 'binder-approve-page', onclick: ev => approveAll(props, ev.currentTarget) }, `✔ Approve ${n} proposal${n > 1 ? 's' : ''}`) : null,
      n ? h('button', { type: 'button', 'data-testid': 'binder-dismiss-page', onclick: ev => dismissAll(props, ev.currentTarget) }, '✕ Dismiss them') : null);
  }
  async function approveAll(props, btn) {
    btn.disabled = true;
    try {
      for (const [target, fields] of Object.entries(props)) await api('POST', bpath('/binder/fields/approve'), { body: { target, fields } });
      x.toast('Approved'); await reloadData();
    } catch (e) { btn.disabled = false; showMsg('bnd-err', '✔ Approve did not work: ', plainError(e)); }
  }
  async function dismissAll(props, btn) {
    const ok = await x.choiceDialog('Dismiss these proposals?', h('p', null, 'The values the AI proposed for this page are removed. Values you wrote or approved stay.'), [{ id: 'yes', label: '✕ Dismiss them' }]);
    if (ok !== 'yes') return;
    btn.disabled = true;
    try {
      for (const [target, fields] of Object.entries(props)) await api('POST', bpath('/binder/fields/dismiss'), { body: { target, fields } });
      x.toast('Proposals dismissed'); await reloadData();
    } catch (e) { btn.disabled = false; showMsg('bnd-err', '✕ Dismiss did not work: ', plainError(e)); }
  }
  function showMsg(cls, lead, text, ...more) {
    clear(msg).appendChild(h('div', { class: cls, role: cls === 'bnd-err' ? 'alert' : null }, h('p', null, h('b', null, lead), text), ...more));
  }
  /** ✨ Fill from the book: POST …/binder/fill (a job), its progress here, then the page again with the proposals */
  let filling = false;
  async function runFill(targets, btn) {
    if (filling) return;
    filling = true;
    if (btn) btn.disabled = true;
    let job;
    try { job = await api('POST', bpath('/binder/fill'), { body: targets && targets.length ? { targets } : {} }); }
    catch (e) { filling = false; if (btn) btn.disabled = false; showMsg('bnd-err', '✨ Fill from the book did not start: ', plainError(e)); return; }
    const line = h('span', null, '✨ Reading the book…');
    const bar = h('progress', { max: String(job.total || 1), value: '0', 'aria-label': 'Fill from the book progress' });
    const stop = h('button', { type: 'button', class: 'bnd-inline-btn', onclick: async () => {
      stop.disabled = true;
      try { await api('POST', bpath(`/review/ai/${encodeURIComponent(job.job_id)}/cancel`)); } catch { /* it ends anyway */ }
    } }, 'Stop');
    clear(msg).appendChild(h('div', { class: 'bnd-progress-line', 'data-testid': 'binder-fill-progress' }, line, bar, stop));
    const show = j => { line.textContent = `✨ ${j.phase || 'Reading the book'} — ${j.done || 0} of ${j.total || 1}`; bar.max = j.total || 1; bar.value = j.done || 0; };
    show(job);
    while (!['done', 'error', 'cancelled'].includes(job.status)) {
      await new Promise(r => setTimeout(r, 900));
      if (!document.body.contains(root)) { filling = false; return; }   // the page changed; the job keeps going
      try { job = await api('GET', bpath(`/review/ai/${encodeURIComponent(job.job_id)}`)); } catch { continue; }
      show(job);
    }
    filling = false;
    if (btn) btn.disabled = false;
    if (job.status === 'error') { showMsg('bnd-err', '✨ Fill from the book did not work: ', plainError({ body: { errors: [job.error || {}] } })); return; }
    const last = (job.results || []).slice(-1)[0] || {};
    await reloadData();
    showMsg('bnd-ok-msg', job.status === 'cancelled' ? 'Stopped. ' : '✔ ', last.message || 'Done. The proposals are marked ✎ — ✔ approve them or ✏ edit them.');
  }
  /** after an edit, an approval or a fill: the binder again, on the same page */
  async function reloadData() {
    const keep = (pages[st.idx] || {}).page_id;
    let d;
    try { d = await api('GET', bpath('/binder')); } catch (e) { showMsg('bnd-err', 'The Book Bible could not be reloaded: ', plainError(e)); return; }
    const y = window.scrollY;
    setData(d); buildIndex();
    st.idx = Math.max(0, pages.findIndex(q => q.page_id === keep));
    drawContents(); drawPager(); drawStage();
    window.scrollTo(0, y);
  }
  const lookSel = h('select', { id: 'bnd-look', 'data-testid': 'binder-look' },
    Object.entries(LOOKS).map(([k, [w, ic]]) => h('option', { value: k, selected: k === st.look }, `${ic} ${w}${k === autoLook ? ' (auto)' : ''}`)));
  lookSel.addEventListener('change', () => setLook(lookSel.value));
  const btnOne = h('button', { type: 'button', class: 'bnd-seg', 'aria-pressed': 'false', 'data-testid': 'binder-one', onclick: () => setMode('one') }, '📄 One page');
  const btnAll = h('button', { type: 'button', class: 'bnd-seg', 'aria-pressed': 'false', 'data-testid': 'binder-all', onclick: () => setMode('all') }, '📚 All pages');
  const fidBox = h('input', { type: 'checkbox', id: 'bnd-fids', 'data-testid': 'binder-fids', checked: st.fids });
  fidBox.addEventListener('change', () => { st.fids = fidBox.checked; st.keep.fids = st.fids; persist(); root.setAttribute('data-fids', st.fids ? 'on' : 'off'); });
  const toolbar = h('div', { class: 'bnd-toolbar no-print', role: 'toolbar', 'aria-label': 'Book Bible tools' },
    h('label', { class: 'bnd-lookpick', for: 'bnd-look' }, h('span', null, '🎨 Look'), lookSel),
    h('span', { class: 'bnd-segs', role: 'group', 'aria-label': 'How many pages to show' }, btnOne, btnAll),
    h('label', { class: 'bnd-check', for: 'bnd-fids' }, fidBox, ' Show field numbers'),
    h('span', { class: 'bnd-tb-gap' }),
    h('button', { type: 'button', 'data-testid': 'binder-fill', title: 'The AI reads the book and proposes the 🆕 quick facts (heights, stat bars, relationship types, danger levels…). Nothing you wrote is replaced; you approve each proposal.',
      onclick: ev => runFill(null, ev.currentTarget) }, '✨ Fill from the book'),
    h('button', { type: 'button', 'data-testid': 'binder-print', onclick: () => printBinder() }, '🖨 Print'),
    h('button', { type: 'button', 'data-testid': 'binder-pdf', onclick: ev => exportAs('pdf', ev.currentTarget) }, '⬇ PDF'),
    h('button', { type: 'button', 'data-testid': 'binder-docx', onclick: ev => exportAs('docx', ev.currentTarget) }, '⬇ Word'));

  // rail: search + contents
  const search = h('input', { type: 'search', id: 'bnd-search', placeholder: 'Search names, places, facts…', autocomplete: 'off', 'data-testid': 'binder-search' });
  const results = h('div', { class: 'bnd-results', 'aria-live': 'polite', 'data-testid': 'binder-results' });
  const contentsNav = h('nav', { class: 'bnd-contents', 'aria-label': 'Book Bible contents' });
  const tocDetails = h('details', { class: 'bnd-toc-box', open: true }, h('summary', null, '☰ Contents'), contentsNav);
  const rail = h('aside', { class: 'bnd-rail no-print', 'aria-label': 'Book Bible contents and search' },
    h('div', { class: 'bnd-rail-brand' }, h('span', { class: 'bnd-brandmark', 'aria-hidden': 'true' }, '❦'),
      h('span', null, h('b', null, book.title), h('small', null, `${pages.length} pages · ${LOOKS[st.look][0]}`))),
    h('div', { class: 'bnd-searchbox' }, h('label', { for: 'bnd-search', class: 'bnd-sr' }, 'Search the Book Bible'), search), results, tocDetails);
  const pager = h('div', { class: 'bnd-pager no-print' });
  const stage = h('div', { class: 'bnd-stage' });
  const layout = h('div', { class: 'bnd-layout' }, rail, h('div', { class: 'bnd-main' }, toolbar, msg, pager, stage, h('div', { class: 'bnd-pager bnd-pager-bottom no-print' })));
  clear(root).appendChild(layout);
  if (window.matchMedia && window.matchMedia('(max-width: 800px)').matches) tocDetails.open = false;

  function drawContents() {
    clear(contentsNav);
    const groups = [];
    pages.forEach(p => { const g = groups[groups.length - 1]; if (g && g.tid === p.template) g.pages.push(p); else groups.push({ tid: p.template, pages: [p] }); });
    contentsNav.appendChild(h('ol', null, groups.map(g => {
      const [icon, name] = TPL[g.tid];
      const cur = g.pages.includes(pages[st.idx]);
      const head = pageLink(g.pages[0], [h('span', { class: 'bnd-ci', 'aria-hidden': 'true' }, icon), h('span', { class: 'bnd-cn' }, g.pages.length > 1 || ENTITY.has(g.tid) ? name : pageTitle(g.pages[0])),
        h('span', { class: 'bnd-cc', title: `${g.pages.length} page(s)` }, String(g.pages.length))], 'bnd-c-link');
      if (cur && g.pages.length === 1 && !ENTITY.has(g.tid) && st.mode === 'one') head.setAttribute('aria-current', 'page');
      return h('li', { class: cur ? 'is-here' : null }, head, g.pages.length > 1 || ENTITY.has(g.tid) ? h('ol', { class: 'bnd-c-sub' }, g.pages.map(p => {
        const a = pageLink(p, [h('span', null, pageTitle(p)), h('span', { class: `bnd-dot bnd-dot-${statusWord(p.status)[2]}`, title: statusWord(p.status)[1] })], 'bnd-c-link');
        if (p === pages[st.idx] && st.mode === 'one') a.setAttribute('aria-current', 'page');
        return h('li', null, a);
      })) : null);
    })));
  }
  function drawPager() {
    for (const el of root.querySelectorAll('.bnd-pager')) {
      clear(el);
      const p = pages[st.idx]; const prev = pages[st.idx - 1]; const next = pages[st.idx + 1];
      el.appendChild(h('button', { type: 'button', class: 'bnd-prev', disabled: !prev, 'data-testid': 'binder-prev', onclick: () => prev && goto(prev.page_id) }, '‹ Previous'));
      el.appendChild(h('span', { class: 'bnd-where' }, st.mode === 'all' ? `All ${pages.length} pages` : `Page ${p._n} of ${pages.length} · ${pageTitle(p)}`));
      el.appendChild(h('button', { type: 'button', class: 'bnd-next', disabled: !next, 'data-testid': 'binder-next', onclick: () => next && goto(next.page_id) }, 'Next ›'));
    }
  }
  function drawStage() {
    clear(stage);
    const list_ = st.mode === 'all' ? pages : [pages[st.idx]];
    for (const p of list_) stage.appendChild(renderPage(p));
  }
  function draw() {
    root.setAttribute('data-look', st.look);
    root.setAttribute('data-mode', st.mode);
    root.setAttribute('data-fids', st.fids ? 'on' : 'off');
    btnOne.setAttribute('aria-pressed', String(st.mode === 'one'));
    btnAll.setAttribute('aria-pressed', String(st.mode === 'all'));
    printStyle.textContent = pageCss();
    drawContents(); drawPager(); drawStage();
  }
  function goto(pid, fid) {
    const i = pages.findIndex(p => p.page_id === pid);
    if (i < 0) return;
    st.idx = i;
    try { history.replaceState(null, '', plink('bible', pid)); } catch { /* ignore */ }
    if (st.mode === 'one') { drawContents(); drawPager(); drawStage(); window.scrollTo(0, 0); }
    else { drawContents(); drawPager(); }
    const pageEl = stage.querySelector(`#bbp-${CSS.escape(pid)}`);
    const target = (fid && pageEl && pageEl.querySelector(`[data-fid="${CSS.escape(fid)}"]`)) || pageEl;
    if (target) {
      if (st.mode === 'all' || fid) target.scrollIntoView({ block: fid ? 'center' : 'start' });
      if (fid) { target.classList.add('bnd-flash'); setTimeout(() => target.classList.remove('bnd-flash'), 2400); }
    }
  }
  function setMode(m) { st.mode = m; st.keep.mode = m; persist(); draw(); if (m === 'all') goto(pages[st.idx].page_id); }
  async function setLook(l) {
    if (!LOOKS[l]) return;
    st.look = l; st.keep.look = l; persist(); draw();
    const brand = rail.querySelector('.bnd-rail-brand small'); if (brand) brand.textContent = `${pages.length} pages · ${LOOKS[l][0]}`;
    // stored with the book (null = the genre's look again); kept on this computer too in case the server cannot
    try { await api('PUT', bpath('/binder/look'), { body: { look: l === autoLook ? null : l } }); book.look_stored = l === autoLook ? null : l; } catch { /* the choice stays on this computer */ }
  }
  /** the print page box: header (book title) and footer (page number) in the page margins */
  function pageCss() {
    const q = s => '"' + String(s).replace(/[\\"]/g, '\\$&').replace(/[\n\r]/g, ' ') + '"';
    return `@media print { @page { size: A4; margin: 15mm 13mm 16mm;
      @top-left { content: ${q(book.title)}; font: 9pt Georgia, serif; color: #555; }
      @top-right { content: "Book Bible"; font: 8pt system-ui, sans-serif; letter-spacing: .12em; color: #777; }
      @bottom-left { content: ${q(book.author ? 'by ' + book.author : '')}; font: 8pt system-ui, sans-serif; color: #777; }
      @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt system-ui, sans-serif; color: #555; } } }`;
  }
  async function printBinder() {
    let what = 'all';
    if (st.mode === 'one') {
      what = await x.choiceDialog('🖨 Print the Book Bible', h('p', null, 'Print just this page, or the whole binder (every page starts on a new sheet)? Your browser’s print window can also save it as a PDF.'),
        [{ id: 'one', label: '📄 This page' }, { id: 'all', label: '📚 The whole binder' }]);
      if (!what) return;
    }
    const before = st.mode;
    if (what === 'all' && before === 'one') { st.mode = 'all'; draw(); }
    await whenImagesReady();
    window.print();
    if (before !== st.mode) { st.mode = before; draw(); }
  }
  function whenImagesReady(ms = 4000) {
    const t0 = Date.now();
    return new Promise(res => { const tick = () => (!root.querySelector('[data-img-loading]') || Date.now() - t0 > ms) ? res() : setTimeout(tick, 60); tick(); });
  }
  async function exportAs(fmt, btn) {
    clear(msg);
    btn.disabled = true;
    const word = fmt === 'pdf' ? 'PDF' : 'Word';
    try {
      const blob = await api('GET', bpath(`/binder/export?format=${fmt}`), { blob: true });
      const url = URL.createObjectURL(blob); S.blobUrls.push(url);
      const a = h('a', { href: url, download: `${String(book.title || 'Book').replace(/[^\p{L}\p{N} _'-]+/gu, '').trim().slice(0, 60) || 'Book'} - Book Bible.${fmt}` });
      document.body.appendChild(a); a.click(); a.remove();
      msg.appendChild(h('p', { class: 'bnd-ok-msg' }, `✔ Book Bible (${word}) downloaded.`));
    } catch (e) {
      const err = (e && e.body && Array.isArray(e.body.errors) && e.body.errors[0]) || {};
      const code = err.problem || err.code;
      const words = problemFor(code, e && e.status);
      const notWired = /RENDER_|TOO_BIG/.test(err.problem || '') || err.code === 'RENDER_NOT_WIRED' || (e && e.status === 404);
      const plain = err.message || (e && e.status === 404 ? `Downloading the Book Bible as ${word} is not available in this Akọwe yet.` : words.what || (e && e.message) || 'The download did not work.');
      const fix = err.fix || (code && problemFor(code) !== problemFor('') ? words.fix : '');
      const sameFix = !fix || fold(fix).replace(/\W+/g, '') === fold(plain).replace(/\W+/g, '');
      msg.appendChild(h('div', { class: 'bnd-err', role: 'alert', 'data-problem': code || null },
        h('p', null, h('b', null, `⬇ ${word} did not work: `), plain),
        sameFix ? null : h('p', null, fix),
        fmt === 'pdf' || notWired ? h('p', null, 'You can still get a PDF now: press ', h('button', { type: 'button', class: 'bnd-inline-btn', onclick: () => printBinder() }, '🖨 Print'),
          ' and choose “Save as PDF” as the printer.') : null));
    } finally { btn.disabled = false; }
  }

  /* ------------------------------------------------------------------ search across every page */
  let index = [];
  function buildIndex() {
    index = [];
    const ok = ([id, f]) => isFieldEntry([id, f]) && !empty(f) && !(META[id] || {}).pic && !/^(\/api\/|data:)/.test(txt(f));
    for (const p of pages) {
      index.push({ p, fid: null, label: TPL[p.template][2], text: pageTitle(p) });
      for (const [code, secObj] of Object.entries(p.sections || {})) {
        for (const [id, f] of Object.entries((secObj && secObj.fields) || {}).filter(ok)) index.push({ p, fid: id, label: (META[id] || {}).short || id, text: txt(f) });
        for (const r of (secObj && secObj.rows) || []) for (const [id, f] of Object.entries(r || {}).filter(ok)) index.push({ p, fid: id, label: (META[id] || {}).short || (SECS[code] || {}).name || id, text: txt(f) });
      }
    }
    index.forEach(e => { e.k = fold(e.text); });
  }
  buildIndex();
  let searchTimer = null;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); });
  search.addEventListener('keydown', ev => { if (ev.key === 'Escape') { search.value = ''; runSearch(); } });
  function runSearch() {
    clear(results);
    const q = fold(search.value).trim();
    if (q.length < 2) return;
    const words = q.split(/\s+/);
    const hits = index.filter(e => words.every(w => e.k.includes(w)));
    // the page itself first (its title), then one hit per page and field
    hits.sort((a, b) => (a.fid ? 1 : 0) - (b.fid ? 1 : 0) || a.p._n - b.p._n);
    const seen = new Set(); const shown = [];
    for (const e of hits) { const k = e.p.page_id + '|' + (e.fid || ''); if (seen.has(k)) continue; seen.add(k); shown.push(e); if (shown.length >= 30) break; }
    if (!shown.length) { results.appendChild(h('p', { class: 'bnd-noresult' }, `Nothing found for “${search.value.trim()}”.`)); return; }
    results.appendChild(h('p', { class: 'bnd-rescount' }, `${hits.length > 30 ? '30+' : shown.length} found`));
    results.appendChild(h('ul', null, shown.map(e => h('li', null, h('a', { href: plink('bible', e.p.page_id), class: 'bnd-hit', 'data-page': e.p.page_id,
      onclick: ev => { ev.preventDefault(); goto(e.p.page_id, e.fid); } },
    h('b', null, TPL[e.p.template][0], ' ', pageTitle(e.p)), h('small', null, e.fid ? e.label : `page ${e.p._n}`), e.fid ? h('span', { class: 'bnd-snip' }, snippet(e.text, words[0])) : null)))));
  }
  function snippet(text, w) {
    const k = fold(text); const i = k.indexOf(w);
    if (i < 0) return text.slice(0, 80);
    const s = Math.max(0, i - 30); const e = Math.min(text.length, i + w.length + 50);
    return [s > 0 ? '…' : '', text.slice(s, i), h('mark', null, text.slice(i, i + w.length)), text.slice(i + w.length, e), e < text.length ? '…' : ''];
  }

  // keyboard: ← / → turn the pages (not while typing)
  const onKey = ev => {
    if (!document.body.contains(root) || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const tag = (ev.target && ev.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (ev.target && ev.target.isContentEditable) || st.mode !== 'one') return;
    if (ev.key === 'ArrowRight' && pages[st.idx + 1]) goto(pages[st.idx + 1].page_id);
    if (ev.key === 'ArrowLeft' && pages[st.idx - 1]) goto(pages[st.idx - 1].page_id);
  };
  document.addEventListener('keydown', onKey);
  cleanup.push(() => document.removeEventListener('keydown', onKey));

  draw();
  if (st.mode === 'all' && rest[0] && byId.has(rest[0])) goto(rest[0]);
}
