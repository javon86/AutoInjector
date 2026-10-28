/* 🗂 Character Forge (plan item B5): the dossier lists (#/p/<pid>/<b>/forge, …/forge/items|places|magic) and one
   dossier (#/p/<pid>/<b>/forge/<record_id> for a character, …/forge/<items|places|magic>/<record_id> otherwise) in the
   look of the author's Moki Vey sample: hero picture, gold name, teal tagline, the 🎬 motion study under a character's
   portrait, the reference plate (ten views / turnaround / mood views / in use), numbered section cards with category
   letters, clickable links to the other dossiers a field names, and 🔎 Check against the book (findings marked Fix /
   Fine / Change dossier). Proposed fields carry a "proposed" badge with ✔ Approve / ✎ Edit; protected fields a 🔒.
   The helpers of app.js are passed in (no state of its own).
   API: /forge/… (forge.py, forge_kinds.py, forge_check.py; docs/CHARACTER_FORGE.md). Styles are scoped under .forge. */

const LETTER_WORDS = { C: 'Canon', P: 'Personality', V: 'Voice', A: 'Appearance', F: 'Fighting', M: 'Magic', K: 'Knowledge/skills', R: 'Relationships', S: 'Story development', E: 'Essential on-page detail' };
const STATUS_WORDS = { supplied: 'yours', proposed: 'proposed', approved: 'approved' };
const ENGINE_WORDS = { sd: 'Stable Diffusion', chatgpt: 'ChatGPT', auto: 'the picture maker' };
const VIEWS = [['front', 'FRONT'], ['three_quarter_front', '3/4 FRONT'], ['side', 'SIDE'], ['three_quarter_back', '3/4 BACK'], ['back', 'BACK'],
  ['idle', 'IDLE'], ['draw', 'DRAW / TOOL REACH'], ['attack', 'ATTACK / EMPTY HAND'], ['dash', 'DASH'], ['defend', 'DEFEND']].map(([key, label]) => ({ key, label }));
const SOURCE_WORDS = { canon: 'from the character record', sheet: 'shared with the character sheet', voice: 'shared with the voice card' };
const VERDICT_WORDS = { fix: 'Fix the book', fine: 'Fine', change_dossier: 'Change dossier' };

/** The four kinds of dossier (forge_kinds_spec.SPECS mirrors the art slots). */
export const FORGE_KINDS = {
  characters: { kind: 'character', word: 'character', Word: 'Character', plural: 'Characters', icon: '👤' },
  items: { kind: 'item', word: 'item', Word: 'Item', plural: 'Items', icon: '🗡', hero: 'portrait', heroLabel: 'item portrait',
    clip: { from: [['portrait', 'item portrait'], ['front', 'front view']], what: 'a slow turntable: the item turning and hovering' },
    views: [['front', 'FRONT'], ['side', 'SIDE'], ['back', 'BACK'], ['detail', 'DETAIL']], plate: 'TURNAROUND REFERENCE', shape: 'square',
    intro: 'Identity, appearance and materials, history, powers and limits, use and care, ownership, where it appears and a continuity ledger.' },
  places: { kind: 'place', word: 'place', Word: 'Place', plural: 'Places', icon: '🏙', hero: 'establishing', heroLabel: 'establishing shot',
    clip: { from: [['establishing', 'establishing shot'], ['day', 'day view']], what: 'a slow establishing pan across the place' },
    views: [['day', 'DAY'], ['night', 'NIGHT'], ['interior', 'INTERIOR / DETAIL']], plate: 'MOOD VIEWS', shape: 'wide',
    intro: 'Overview, geography and layout, atmosphere and senses, history, people and factions, rules and dangers, routes, where it appears and a continuity ledger.' },
  magic: { kind: 'magic', word: 'magic system', Word: 'Magic system', plural: 'Magic systems', icon: '✴', hero: 'sigil', heroLabel: 'sigil',
    clip: { from: [['in_use', 'in-use picture'], ['sigil', 'sigil']], what: 'the effect in use' },
    views: [['in_use', 'IN USE']], plate: 'IN USE', shape: 'square',
    intro: 'Source, access and cost, rules and hard limits, practitioners, named powers, signs, failure, history, society’s view, where it appears and a use ledger.' },
};
const SEG_OF = { character: 'characters', item: 'items', place: 'places', magic: 'magic' };

const CLIP_MAX_MB = 40;   // forge.MAX_CLIP_BYTES
const CLIP_TYPES = ['video/mp4', 'video/webm'];

/** #/p/<pid>/<b>/forge[/…]: the lists and the dossiers of every kind. */
export function forgeRoute(m, rest, x) {
  const seg = rest[0];
  if (seg && FORGE_KINDS[seg]) return rest[1] ? viewForge(m, rest[1], x, seg) : viewForgeList(m, x, seg);
  return seg ? viewForge(m, seg, x) : viewForgeList(m, x);
}
function dossierLink(x, seg, rid) { return seg === 'characters' ? x.plink('forge', rid) : x.plink('forge', seg, rid); }
function listLink(x, seg) { return seg === 'characters' ? x.plink('forge') : x.plink('forge', seg); }

/** The first frame of a clip file as a PNG blob (the poster for the PDF), or null when the browser cannot decode it. */
function posterFromFile(file) {
  return new Promise(resolve => {
    let url = null; let done = false;
    const finish = v => { if (done) return; done = true; try { if (url) URL.revokeObjectURL(url); } catch { /* ignore */ } resolve(v); };
    try {
      url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.addEventListener('error', () => finish(null));
      v.addEventListener('loadeddata', () => { try { v.currentTime = Math.min(0.05, (v.duration || 1) / 2); } catch { finish(null); } });
      v.addEventListener('seeked', () => {
        try {
          const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
          if (!c.width || !c.height) { finish(null); return; }
          c.getContext('2d').drawImage(v, 0, 0);
          c.toBlob(b => finish(b), 'image/png');
        } catch { finish(null); }
      });
      setTimeout(() => finish(null), 8000);
      v.src = url;
    } catch { finish(null); }
  });
}

/** A picture from the book's assets as a blob URL (the asset route needs the access token, so no plain <img src>). */
async function pictureUrl(x, art) {
  if (!art || !art.asset_id) return null;
  const blob = await x.api('GET', x.bpath(`/assets/${encodeURIComponent(art.asset_id)}/${art.version || 1}`), { blob: true });
  const url = URL.createObjectURL(blob); x.S.blobUrls.push(url);
  return url;
}
function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
}

/** Characters · Items · Places · Magic systems. */
function kindTabs(x, seg) {
  const { h } = x;
  return h('nav', { class: 'forge-tabs', 'aria-label': 'Kinds of dossier', 'data-testid': 'forge-tabs' },
    Object.entries(FORGE_KINDS).map(([s, k]) => h('a', { href: listLink(x, s), class: `forge-tab${s === seg ? ' on' : ''}`, 'aria-current': s === seg ? 'page' : null, 'data-seg': s },
      h('span', { 'aria-hidden': 'true' }, k.icon), ` ${k.plural}`)));
}

/* ======================================================================= the lists */
export async function viewForgeList(main, x, seg = 'characters') {
  const { h, clear, api, bpath, plink, S } = x;
  const K = FORGE_KINDS[seg];
  const where = { book: S.project.name, step: 'Character Forge' };
  const wrap = h('div', { class: 'forge forge-list-page', 'data-testid': 'forge-list', 'data-seg': seg });
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    x.crumbs(['Your books', '#/'], [S.project.name, plink()], 'Character Forge'),
    h('h1', null, '🗂 Character Forge')),
  h('div', { class: 'row' }, x.infoTip('Character Forge',
    h('p', null, 'A deep dossier for every character, item, place and magic system. A character has 14 numbered sections: record, inner life, relationships, voice, detailed appearance, fighting, weapons, powers, skills, physical limits, knowledge, backstory, storyline and continuity.'),
    h('p', null, 'Every entry carries category letters (C Canon · P Personality · V Voice · A Appearance · F Fighting · M Magic · K Knowledge · R Relationships · S Story · E Essential on-page detail), so each chapter only gets the details it needs.'),
    h('p', null, '✨ Invent the rest: your AI fills the empty fields as proposals. Nothing it invents is used until you approve it. Your own text and protected fields are never changed.'),
    h('p', null, '🔎 Check against the book: Akọwe compares a dossier with the written chapters and lists what disagrees.')))));
  main.appendChild(wrap);
  wrap.appendChild(kindTabs(x, seg));
  const msg = h('div', { 'aria-live': 'polite' });
  const body = h('div', null, x.loadingState('Loading the dossiers…'));
  wrap.append(msg, body);
  const loadExample = async btn => {
    btn.disabled = true; clear(msg);
    try {
      const out = await api('POST', bpath('/forge/example'), { body: {} });
      x.toast(out.message || 'Example loaded');
      if (seg === 'characters') location.hash = plink('forge', out.record_id);
      else {
        const w = (out.world || []).find(v => SEG_OF[v.kind] === seg);
        location.hash = w ? dossierLink(x, seg, w.record_id) : listLink(x, seg);
      }
    } catch (e) { btn.disabled = false; msg.appendChild(x.problemBox(x.toProblem(e, where), {}, 'The example could not be loaded')); }
  };
  if (seg !== 'characters') { await kindList(x, seg, body, msg, loadExample); return; }
  let info;
  try { info = await api('GET', bpath('/forge/characters')); }
  catch (e) { clear(body).appendChild(x.problemBox(x.toProblem(e, where), { retry: () => x.route() }, 'Could not open the Character Forge')); return; }
  clear(body);
  const exampleBtn = h('button', { type: 'button', class: 'forge-btn ghost', 'data-testid': 'forge-example', onclick: ev => loadExample(ev.currentTarget) }, '🧪 Load the Moki Vey example');
  // 🧑 a new character the book does not have yet (POST /forge/characters): a draft character + its dossier
  const charName = h('input', { type: 'text', maxlength: '80', placeholder: 'e.g. Ada Quill', 'aria-label': 'Name of the new character', 'data-testid': 'forge-new-name' });
  const charRole = h('input', { type: 'text', maxlength: '300', placeholder: 'role (optional), e.g. the harbour master', 'aria-label': 'Role of the new character', 'data-testid': 'forge-new-role' });
  const newChar = h('button', { type: 'button', class: 'forge-btn gold', 'data-testid': 'forge-new', onclick: async ev => {
    if (!charName.value.trim()) { charName.focus(); x.toast('Give the character a name first'); return; }
    const btn = ev.currentTarget; btn.disabled = true; clear(msg);
    try {
      const out = await api('POST', bpath('/forge/characters'), { body: Object.assign({ name: charName.value }, charRole.value.trim() ? { role: charRole.value } : {}) });
      x.toast(out.message || 'Character made');
      location.hash = dossierLink(x, 'characters', out.record_id);
    } catch (e) { btn.disabled = false; msg.appendChild(x.problemBox(x.toProblem(e, where), {}, 'The character could not be made')); }
  } }, '＋ New character');
  charName.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); newChar.click(); } });
  const newRow = h('section', { class: 'forge-new-row', 'aria-label': 'New character' }, h('div', { class: 'forge-actions' }, charName, charRole, newChar),
    h('p', { class: 'forge-note' }, 'A new character starts as a draft (approve it on the 🎭 Characters page); ✨ Invent the rest proposes the details.'));
  const chars = info.characters || [];
  if (!chars.length) {
    body.append(h('section', { class: 'forge-empty' },
      h('div', { class: 'forge-empty-glyph', 'aria-hidden': 'true' }, '🗂'),
      h('h2', null, 'No characters yet'),
      h('p', null, 'Make your characters (Make my book → characters, or the Bible Builder) — or add one below. Every character then gets a dossier here.'),
      h('p', null, 'Want to see what a finished dossier looks like? Load the example: a complete dossier with a portrait and ten reference views, plus a linked item, place and magic system.'),
      h('div', { class: 'forge-actions' }, exampleBtn, h('a', { class: 'forge-btn ghost', href: plink('book') }, '📘 Make my book'))), newRow);
    return;
  }
  const grid = h('div', { class: 'forge-grid', role: 'list' });
  for (const c of chars) {
    const thumb = h('div', { class: 'forge-thumb', 'aria-hidden': 'true' }, h('span', { class: 'forge-initials' }, initials(c.name)));
    if (c.portrait) pictureUrl(x, c.portrait).then(u => { if (u) { clear(thumb).appendChild(h('img', { src: u, alt: '' })); } }).catch(() => { /* keep the initials */ });
    const pct = c.total ? Math.round(100 * c.filled / c.total) : 0;
    grid.appendChild(h('a', { class: 'forge-tile', role: 'listitem', href: plink('forge', c.record_id), 'data-testid': 'forge-tile', 'data-rid': c.record_id },
      thumb,
      h('div', { class: 'forge-tile-body' },
        h('div', { class: 'forge-code' }, `${c.code} · REV ${c.revision || 0} · `, h('span', { class: `forge-ready ${c.readiness}` }, c.readiness === 'ready' ? 'READY' : 'DRAFT')),
        h('div', { class: 'forge-tile-name' }, c.name),
        c.tagline ? h('div', { class: 'forge-tile-tag' }, c.tagline) : null,
        h('div', { class: 'forge-meter', role: 'img', 'aria-label': `${c.filled} of ${c.total} fields filled` }, h('span', { style: `width:${pct}%` })),
        h('div', { class: 'forge-tile-stats' }, `${c.filled}/${c.total} fields`, c.proposed ? ` · ${c.proposed} proposed` : '', ` · ${c.views_done}/10 views`, c.has_portrait ? ' · portrait' : '', c.has_clip ? ' · 🎬 clip' : ''))));
  }
  body.append(grid, newRow);
  if (!chars.some(c => c.name.toLowerCase() === 'moki vey')) body.appendChild(h('div', { class: 'forge-actions forge-foot' }, exampleBtn));
}

/** The list of one kind: tiles, ＋ New, and "From your book" (records that can become a dossier). */
async function kindList(x, seg, body, msg, loadExample) {
  const { h, clear, api, bpath, S } = x;
  const K = FORGE_KINDS[seg];
  const where = { book: S.project.name, step: `Character Forge · ${K.plural}` };
  let info;
  try { info = await api('GET', bpath(`/forge/${seg}`)); }
  catch (e) { clear(body).appendChild(x.problemBox(x.toProblem(e, where), { retry: () => x.route() }, `Could not open the ${K.word} dossiers`)); return; }
  clear(body);
  const create = async (payload, btn) => {
    if (btn) btn.disabled = true;
    clear(msg);
    try {
      const out = await api('POST', bpath(`/forge/${seg}`), { body: payload });
      x.toast(out.message || 'Dossier made');
      location.hash = dossierLink(x, seg, out.record_id);
    } catch (e) { if (btn) btn.disabled = false; msg.appendChild(x.problemBox(x.toProblem(e, where), {}, 'The dossier could not be made')); }
  };
  const nameIn = h('input', { type: 'text', maxlength: '80', placeholder: seg === 'items' ? 'e.g. The brass key' : seg === 'places' ? 'e.g. The lighthouse' : 'e.g. Tide-calling', 'aria-label': `Name of the new ${K.word}`, 'data-testid': 'forge-new-name' });
  const newBtn = h('button', { type: 'button', class: 'forge-btn gold', 'data-testid': 'forge-new', onclick: ev => { if (!nameIn.value.trim()) { nameIn.focus(); x.toast('Give it a name first'); return; } create({ name: nameIn.value }, ev.currentTarget); } }, `＋ New ${K.word}`);
  nameIn.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); newBtn.click(); } });
  const items = info.dossiers || [];
  const cands = info.candidates || [];
  body.appendChild(h('p', { class: 'forge-note forge-kind-intro' }, `${K.icon} ${K.Word} dossiers: ${K.intro}`));
  if (items.length) {
    const grid = h('div', { class: 'forge-grid', role: 'list' });
    for (const c of items) {
      const thumb = h('div', { class: `forge-thumb ${K.shape}`, 'aria-hidden': 'true' }, h('span', { class: 'forge-initials' }, K.icon));
      if (c.hero) pictureUrl(x, c.hero).then(u => { if (u) clear(thumb).appendChild(h('img', { src: u, alt: '' })); }).catch(() => { /* keep the icon */ });
      const pct = c.total ? Math.round(100 * c.filled / c.total) : 0;
      grid.appendChild(h('a', { class: 'forge-tile', role: 'listitem', href: dossierLink(x, seg, c.record_id), 'data-testid': 'forge-tile', 'data-rid': c.record_id },
        thumb,
        h('div', { class: 'forge-tile-body' },
          h('div', { class: 'forge-code' }, `${c.code} · REV ${c.revision || 1} · `, h('span', { class: `forge-ready ${c.readiness}` }, c.readiness === 'ready' ? 'READY' : 'DRAFT')),
          h('div', { class: 'forge-tile-name' }, c.name),
          c.tagline ? h('div', { class: 'forge-tile-tag' }, c.tagline) : null,
          h('div', { class: 'forge-meter', role: 'img', 'aria-label': `${c.filled} of ${c.total} fields filled` }, h('span', { style: `width:${pct}%` })),
          h('div', { class: 'forge-tile-stats' }, `${c.filled}/${c.total} fields`, c.proposed ? ` · ${c.proposed} proposed` : '', ` · ${c.views_done}/${c.views_total} views`, c.hero ? ` · ${K.heroLabel}` : '', c.has_clip ? ' · 🎬 clip' : ''))));
    }
    body.appendChild(grid);
  } else {
    body.appendChild(h('section', { class: 'forge-empty' },
      h('div', { class: 'forge-empty-glyph', 'aria-hidden': 'true' }, K.icon),
      h('h2', null, `No ${K.word} dossiers yet`),
      h('p', null, cands.length ? `Start from what your book already has (below), or make a new ${K.word}.` : `Make a new ${K.word}, or load the example to see a finished one.`)));
  }
  body.appendChild(h('section', { class: 'forge-new-row', 'aria-label': `New ${K.word}` }, h('div', { class: 'forge-actions' }, nameIn, newBtn,
    items.some(c => ['rescue baton', 'nacre', 'biofilament mutation'].includes(c.name.toLowerCase())) ? null :
      h('button', { type: 'button', class: 'forge-btn ghost', 'data-testid': 'forge-example', onclick: ev => loadExample(ev.currentTarget) }, '🧪 Load the Moki Vey example'))));
  if (cands.length) {
    body.appendChild(h('section', { class: 'forge-cands', 'aria-labelledby': 'forge-cands-h', 'data-testid': 'forge-candidates' },
      h('h2', { id: 'forge-cands-h' }, '📘 From your book'),
      h('p', { class: 'forge-note' }, 'Your book already has these. “Create dossier” starts one filled with what the book says (your text, not proposals).'),
      h('ul', { class: 'forge-cand-list' }, cands.map(c => h('li', { class: 'forge-cand', 'data-testid': 'forge-candidate', 'data-source': c.source_id },
        h('div', null, h('strong', null, c.name), h('span', { class: 'forge-note' }, ` · from the ${c.from}`), c.summary ? h('div', { class: 'forge-note' }, c.summary) : null),
        h('button', { type: 'button', class: 'forge-mini ok', 'data-testid': 'forge-create-from', onclick: ev => create({ from: c.source_id }, ev.currentTarget) }, '＋ Create dossier'))))));
  }
}

/* ======================================================================= one dossier */
export async function viewForge(main, rid, x, seg = 'characters') {
  const { h, clear, api, bpath, plink, S } = x;
  const K = FORGE_KINDS[seg];
  const isChar = seg === 'characters';
  const where = { book: S.project.name, step: 'Character Forge' };
  const path = `/forge/${seg}/${encodeURIComponent(rid)}`;
  let d;
  let check = null;        // the last 🔎 check (GET …/check)
  const filter = new Set();
  let showEmpty = true;
  let editing = null;   // field key being edited
  const load = async () => { d = await api('GET', bpath(path)); };
  try { await load(); }
  catch (e) { main.appendChild(x.problemBox(x.toProblem(e, where), { retry: () => x.route() }, 'Could not open this dossier')); return; }
  main.appendChild(x.crumbs(['Your books', '#/'], [S.project.name, plink()], ['Character Forge', plink('forge')], ...(isChar ? [] : [[K.plural, listLink(x, seg)]]), d.name));
  const page = h('div', { class: `forge forge-page${isChar ? '' : ` forge-kind-${K.kind}`}`, 'data-testid': 'forge-page', 'data-kind': K.kind });
  main.appendChild(page);
  const msg = h('div', { class: 'forge-msg', 'aria-live': 'polite' });
  const prog = h('div', { class: 'forge-prog', 'aria-live': 'polite' });
  const clipMsg = h('div', { class: 'forge-msg', 'aria-live': 'polite' });
  const clipProg = h('div', { class: 'forge-prog', 'aria-live': 'polite', 'data-testid': 'clip-progress' });
  const checkMsg = h('div', { class: 'forge-msg', 'aria-live': 'polite' });
  const checkProg = h('div', { class: 'forge-prog', 'aria-live': 'polite', 'data-testid': 'check-progress' });
  const fail = (e, title, box = msg) => { clear(box).appendChild(x.problemBox(x.toProblem(e, where), {}, title)); };
  const reload = async () => { try { await load(); } catch (e) { fail(e, 'Could not reload the dossier'); } render(); };
  const slotSel = h('select', { class: 'forge-select', 'aria-label': 'Which AI invents', 'data-testid': 'forge-slot' },
    h('option', { value: '' }, 'AI: automatic (AI-1 first)'), ['AI-1', 'AI-2', 'AI-3'].map(s => h('option', { value: s }, s)));
  const loadCheck = async () => { try { check = await api('GET', bpath(`${path}/check`)); } catch { check = null; } };

  const job = async (sub, body, label, wherePr = prog) => {
    clear(msg);
    const j = await x.runAiJob(`${path}/${sub}`, body, wherePr, label);
    if (j) { const r = (j.results || []).slice(-1)[0] || {}; x.toast(r.message || 'Done'); }
    await reload();
    return j;
  };
  const invent = async () => {
    const empty = d.counts.fields - d.counts.filled;
    if (!empty) { x.toast('Every field already has text.'); return; }
    await job('forge', slotSel.value ? { slot_id: slotSel.value } : {}, 'Inventing the rest');
  };
  const approveAll = async () => {
    if (!d.counts.proposed) { x.toast('Nothing is waiting for approval.'); return; }
    const what = isChar ? `${d.name}’s approved dossier. Approved voice and inner-life details go into the character sheet and voice card, which the writer uses.` : `${d.name}’s approved dossier.`;
    const ok = await x.choiceDialog('Approve every proposal?', h('p', null, `${d.counts.proposed} invented field(s) become part of ${what}`), [{ id: 'yes', label: '✔ Approve all' }]);
    if (ok !== 'yes') return;
    await approve({ all: true });
  };
  const approve = async body => {
    clear(msg);
    try { const out = await api('POST', bpath(`${path}/approve`), { body }); x.toast(out.message || 'Approved'); d = out.dossier || d; if (!out.dossier) await load(); }
    catch (e) { fail(e, 'Could not approve'); }
    render();
  };
  const save = async (sections, extra = {}) => {
    clear(msg);
    try { d = await api('PUT', bpath(path), { body: Object.assign({ sections, revision: d.revision }, extra) }); x.toast('Saved'); editing = null; render(); return true; }
    catch (e) { fail(e, 'Could not save'); return false; }
  };
  const pdf = async btn => {
    btn.disabled = true;
    try {
      const blob = await api('GET', bpath(`${path}/pdf?download=1`), { blob: true });
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' })); S.blobUrls.push(url);
      const name = isChar ? `${d.code} ${d.name} - Character Forge dossier.pdf` : `${d.code} ${d.name} - ${K.Word} Forge dossier.pdf`;
      const a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { fail(e, 'The dossier PDF could not be made'); }
    btn.disabled = false;
  };
  const remove = async () => {
    const ok = await x.choiceDialog(`Delete ${d.code} ${d.name}?`, h('p', null, `The ${K.word} dossier and its proposals are deleted. Its pictures stay with the book’s files. The book’s own records are not changed.`), [{ id: 'yes', label: '🗑 Delete the dossier' }]);
    if (ok !== 'yes') return;
    try { const out = await api('POST', bpath(`${path}/delete`)); x.toast(out.message || 'Deleted'); location.hash = listLink(x, seg); }
    catch (e) { fail(e, 'Could not delete'); }
  };
  const art = async (body, label) => job('art', body, label);
  const upload = slot => {
    const inp = h('input', { type: 'file', accept: 'image/png,image/jpeg', class: 'visually-hidden' });
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0]; inp.remove();
      if (!f) return;
      clear(msg);
      try { const out = await api('PUT', bpath(`${path}/art/${encodeURIComponent(slot)}`), { raw: f, headers: { 'Content-Type': f.type || 'application/octet-stream' } }); x.toast(out.message || 'Picture saved'); }
      catch (e) { fail(e, 'The picture could not be saved'); }
      await reload();
    });
    document.body.appendChild(inp); inp.click();
  };
  const artButtons = (slot, label) => {
    const purpose = !isChar ? (slot === K.hero ? { what: K.hero } : { what: 'views', views: [slot] })
      : slot === 'portrait' ? { what: 'portrait' } : slot === 'sheet' ? { what: 'sheet' } : { what: 'views', views: [slot] };
    return h('div', { class: 'forge-slot-actions' },
      h('button', { type: 'button', class: 'forge-mini', title: `Make the ${label} with Stable Diffusion`, 'data-testid': `art-sd-${slot}`, onclick: () => art(Object.assign({ engine: 'sd' }, purpose), `Making the ${label} with Stable Diffusion`) }, '🎨 Stable Diffusion'),
      h('button', { type: 'button', class: 'forge-mini', title: `Make the ${label} with ChatGPT`, 'data-testid': `art-gpt-${slot}`, onclick: () => art(Object.assign({ engine: 'chatgpt' }, purpose), `Making the ${label} with ChatGPT`) }, '💬 ChatGPT'),
      h('button', { type: 'button', class: 'forge-mini', title: `Upload your own ${label}`, 'data-testid': `art-up-${slot}`, onclick: () => upload(slot) }, '⬆ Upload'));
  };
  // 🎬 the motion clip: made by AutoInjector's video maker from the portrait / front view (characters), the item portrait
  // (a turntable), the establishing shot (a pan) or the in-use picture (the effect in use) — or uploaded
  const makeClip = async () => {
    clear(clipMsg);
    await job('art', { what: 'clip', engine: 'auto' }, 'Making the motion clip', clipProg);
  };
  const uploadClip = () => {
    const inp = h('input', { type: 'file', accept: CLIP_TYPES.join(','), class: 'visually-hidden' });
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0]; inp.remove();
      if (!f) return;
      clear(clipMsg);
      const bad = (title, text, fix) => clipMsg.appendChild(x.problemBox(x.toProblem({ code: 'INVALID_INPUT', message: text, fix }, where), {}, title));
      if (f.type && !CLIP_TYPES.includes(f.type)) { bad('This clip cannot be used', 'Only MP4 and WebM clips can be used.', 'Pick an .mp4 or .webm file (AutoInjector’s 🎬 Video tab saves MP4).'); return; }
      if (f.size > CLIP_MAX_MB * 1024 * 1024) { bad('This clip is too large', `The clip is larger than ${CLIP_MAX_MB} MB; a 3–5 second clip is usually 1–10 MB.`, 'Shorten the clip or save it smaller, then upload it again.'); return; }
      try {
        const out = await api('PUT', bpath(`${path}/art/clip`), { raw: f, headers: { 'Content-Type': f.type || 'application/octet-stream' } });
        // the first frame becomes the poster (the dossier PDF uses it); best effort, the clip is kept either way
        const poster = await posterFromFile(f);
        if (poster) { try { await api('PUT', bpath(`${path}/art/clip_poster`), { raw: poster, headers: { 'Content-Type': 'image/png' } }); } catch { /* no poster: the PDF leaves the still out */ } }
        x.toast(out.message || 'Clip saved');
      } catch (e) { clipMsg.appendChild(x.problemBox(x.toProblem(e, where), {}, 'The clip could not be saved')); }
      await reload();
    });
    document.body.appendChild(inp); inp.click();
  };
  const urls = new Map();   // asset id -> blob URL (a re-render after a filter click fetches nothing again)
  const blobOf = artItem => {
    const k = `${artItem.asset_id}@${artItem.version || 1}`;
    if (!urls.has(k)) urls.set(k, pictureUrl(x, artItem));
    return urls.get(k);
  };
  const motion = () => {
    const c = d.art.clip;
    const artOf = slot => (isChar ? (slot === 'portrait' ? d.art.portrait : d.art.views[slot]) : (slot === K.hero ? d.art[K.hero] : d.art.views[slot]));
    const from = isChar ? [['portrait', 'portrait'], ['front', 'front view']] : K.clip.from;
    const hit = from.find(([slot]) => artOf(slot));
    const source = hit ? hit[1] : null;
    const motionWords = isChar ? 'idle-motion clip' : `clip (${K.clip.what})`;
    const frame = h('div', { class: `forge-motion-frame${c ? ' has-clip' : ''}` });
    if (c) {
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const vid = h('video', { class: 'forge-clip', 'data-testid': 'forge-clip', loop: true, muted: true, playsinline: true, controls: true, preload: 'metadata', 'aria-label': `${d.name}, motion study` });
      vid.muted = true; vid.loop = true; vid.playsInline = true; vid.controls = true;
      if (!reduce) vid.autoplay = true;
      frame.appendChild(vid);
      if (c.poster) blobOf(c.poster).then(u => { if (u) vid.setAttribute('poster', u); }).catch(() => { /* the first frame shows instead */ });
      blobOf(c).then(u => { if (u) { vid.src = u; vid.addEventListener('error', () => frame.classList.add('no-play'), { once: true }); } }).catch(() => frame.classList.add('no-play'));
    } else {
      frame.appendChild(h('div', { class: 'forge-slot-empty' }, h('span', { class: 'forge-motion-glyph', 'aria-hidden': 'true' }, '🎬'),
        h('span', null, source ? 'No clip yet' : `Needs ${isChar ? 'a portrait' : `the ${from[0][1]}`} first`)));
    }
    const meta = c ? [c.seconds ? `${c.seconds} s loop` : 'loop', c.source === 'upload' ? 'your clip' : (c.model || c.engine || null)].filter(Boolean).join(' · ') : '';
    return h('section', { class: 'forge-motion', 'aria-labelledby': 'forge-motion-h', 'data-testid': 'forge-motion' },
      h('div', { class: 'forge-motion-head' }, h('h3', { id: 'forge-motion-h' }, '🎬 Motion study'), meta ? h('span', { class: 'forge-motion-meta' }, meta) : null),
      frame,
      h('div', { class: 'forge-slot-actions' },
        h('button', { type: 'button', class: 'forge-mini', 'data-testid': 'clip-make', disabled: !source,
          title: source ? `A 4-second ${motionWords} made from the ${source} (AutoInjector → 🎬 Video)` : `Make or upload the ${from[0][1]} first: the clip is made from it`,
          onclick: makeClip }, c ? '🎬 Make the motion clip again' : '🎬 Make the motion clip'),
        h('button', { type: 'button', class: 'forge-mini', 'data-testid': 'clip-upload', title: `Upload your own MP4 or WebM clip (up to ${CLIP_MAX_MB} MB)`, onclick: uploadClip }, '⬆ Upload a clip')),
      clipMsg, clipProg);
  };
  const picture = (holder, artItem, alt) => {
    if (!artItem) return;
    blobOf(artItem).then(u => { if (u) { clear(holder).appendChild(h('img', { src: u, alt })); holder.classList.add('has-img'); } }).catch(() => { /* the empty slot stays */ });
  };
  const linkChip = l => h('a', { class: `forge-link k-${l.kind}`, href: dossierLink(x, l.segment || SEG_OF[l.kind], l.record_id), 'data-testid': 'forge-link', 'data-code': l.code, title: `Open the dossier of ${l.name}` },
    h('b', null, l.code), ` ${l.name}`);

  // ------------------------------------------------------------------ pieces
  const hero = () => {
    const heroKey = isChar ? 'portrait' : K.hero;
    const frame = h('div', { class: `forge-portrait${isChar ? '' : ` forge-hero-${K.shape}`}`, 'data-testid': 'forge-portrait' },
      h('div', { class: 'forge-slot-empty' }, h('span', { class: 'forge-initials big' }, isChar ? initials(d.name) : K.icon), h('span', null, isChar ? 'No portrait yet' : `No ${K.heroLabel} yet`)));
    picture(frame, d.art[heroKey], `${d.name}, ${isChar ? 'portrait' : K.heroLabel}`);
    const ready = d.readiness === 'ready';
    const sub = [d.tagline ? d.tagline.toUpperCase() : null, isChar ? 'CHARACTER FORGE' : `${K.Word.toUpperCase()} FORGE`].filter(Boolean).join('  /  ');
    const viewsTotal = isChar ? 10 : K.views.length;
    const cover = h('div', { class: 'forge-cover' },
      h('div', { class: 'forge-code', 'data-testid': 'forge-code' }, `${d.code} · REV ${d.revision} · `, h('span', { class: `forge-ready ${d.readiness}`, 'data-testid': 'forge-readiness' }, ready ? 'READY' : 'DRAFT')),
      h('h1', { class: 'forge-name' }, d.name),
      h('p', { class: 'forge-tagline' }, sub),
      !isChar && (d.aliases || []).length ? h('p', { class: 'forge-aliases' }, 'Also: ', d.aliases.join(' · ')) : null,
      (d.summary || []).length ? h('ul', { class: 'forge-summary' }, d.summary.map(s => h('li', null, s))) : h('p', { class: 'forge-summary muted' }, 'No cover lines yet — ✨ Invent the rest writes them, or ✎ edit the cover.'),
      h('div', { class: 'forge-stats' },
        stat(d.counts.filled, `of ${d.counts.fields} fields`), stat(d.counts.proposed, 'proposed', d.counts.proposed ? 'warn' : ''),
        stat(d.counts.protected, 'protected'), stat(d.counts.views_done, `of ${viewsTotal} views`)),
      h('div', { class: 'forge-actions' },
        h('button', { type: 'button', class: 'forge-btn gold', 'data-testid': 'forge-invent', onclick: invent }, '✨ Invent the rest'),
        h('button', { type: 'button', class: 'forge-btn teal', 'data-testid': 'forge-approve-all', disabled: !d.counts.proposed, onclick: approveAll }, '✔ Approve all proposals'),
        h('button', { type: 'button', class: 'forge-btn ghost', 'data-testid': 'forge-pdf', onclick: ev => pdf(ev.currentTarget) }, '⬇ Dossier PDF'),
        h('button', { type: 'button', class: 'forge-btn ghost', 'data-testid': 'forge-edit-cover', onclick: editCover }, isChar ? '✎ Edit the cover' : '✎ Name and cover'),
        isChar ? null : h('button', { type: 'button', class: 'forge-btn ghost', 'data-testid': 'forge-delete', onclick: remove }, '🗑 Delete')),
      h('div', { class: 'forge-actions small' }, slotSel,
        isChar && !d.approved_character ? h('span', { class: 'forge-note' }, 'The character itself is still a draft.') : null,
        !isChar && d.source && d.source.source_id ? h('span', { class: 'forge-note' }, '📘 Started from your book’s records.') : null),
      linksPanel(),
      msg, prog);
    return h('section', { class: 'forge-hero', 'aria-label': 'Cover' },
      h('div', { class: 'forge-portrait-col' }, frame, artButtons(heroKey, isChar ? 'portrait' : K.heroLabel), motion()), cover);
  };
  const linksPanel = () => {
    const out = (d.links || []); const back = (d.backlinks || []);
    if (!out.length && !back.length) return null;
    return h('div', { class: 'forge-links', 'data-testid': 'forge-links' },
      out.length ? h('p', null, h('span', { class: 'forge-links-label' }, 'Names'), ' ', out.map(linkChip)) : null,
      back.length ? h('p', null, h('span', { class: 'forge-links-label' }, 'Named by'), ' ', back.map(linkChip)) : null);
  };
  const stat = (n, label, cls = '') => h('div', { class: `forge-stat ${cls}` }, h('strong', null, String(n)), h('span', null, label));
  const editCover = async () => {
    const tag = h('input', { type: 'text', maxlength: '90', value: d.tagline || '', 'aria-label': 'Tagline' });
    const sum = h('textarea', { rows: '3', 'aria-label': 'Three cover lines' }); sum.value = (d.summary || []).join('\n');
    const nm = isChar ? null : h('input', { type: 'text', maxlength: '80', value: d.name, 'aria-label': 'Name', 'data-testid': 'forge-name-in' });
    const al = isChar ? null : h('input', { type: 'text', value: (d.aliases || []).join('; '), 'aria-label': 'Other names', placeholder: 'other names, separated by ;' });
    const ok = await x.choiceDialog(isChar ? 'The cover' : 'Name and cover', h('div', { class: 'stack' },
      nm ? h('label', null, 'Name', nm) : null, al ? h('label', null, 'Other names (the links and the book check look for these too)', al) : null,
      h('label', null, 'Tagline (e.g. “The man who holds the line”)', tag), h('label', null, 'Three short cover lines, one per line', sum)), [{ id: 'save', label: '💾 Save' }]);
    if (ok !== 'save') return;
    const extra = { tagline: tag.value, summary: sum.value.split('\n') };
    if (nm) { extra.name = nm.value; extra.aliases = al.value; }
    await save({}, extra);
  };
  const plate = () => {
    const viewList = isChar ? VIEWS : K.views.map(([key, label]) => ({ key, label }));
    const grid = h('div', { class: `forge-views${isChar ? '' : ` n${viewList.length} ${K.shape}`}`, 'data-testid': 'forge-views' });
    for (const v of viewList) {
      const it = d.art.views[v.key];
      const box = h('div', { class: 'forge-view-img' }, h('div', { class: 'forge-slot-empty' }, isChar ? h('span', { class: 'forge-silhouette', 'aria-hidden': 'true' }) : null, h('span', null, 'empty')));
      picture(box, it, `${d.name}, ${v.label.toLowerCase()} view`);
      grid.appendChild(h('figure', { class: `forge-view${it ? ' done' : ''}`, 'data-view': v.key },
        box, h('figcaption', null, v.label), artButtons(v.key, `${v.label.toLowerCase()} view`)));
    }
    const sheet = isChar && d.art.sheet ? h('div', { class: 'forge-sheet' }) : null;
    if (sheet) picture(sheet, d.art.sheet, `${d.name}, turnaround sheet`);
    const n = viewList.length;
    const allWord = n === 1 ? 'Make it' : `All ${n === 10 ? 'ten' : n}`;
    return h('section', { class: 'forge-plate', 'aria-labelledby': 'forge-plate-h' },
      h('div', { class: 'forge-plate-head' }, h('h2', { id: 'forge-plate-h' }, `${d.name.toUpperCase()} / ${isChar ? 'TEN-VIEW REFERENCE' : K.plate}`),
        h('div', { class: 'forge-actions small' },
          h('button', { type: 'button', class: 'forge-mini', 'data-testid': 'art-views-sd', onclick: () => art({ what: 'views', engine: 'sd' }, `Making the ${isChar ? 'ten views' : 'views'} with Stable Diffusion`) }, `🎨 ${allWord} with Stable Diffusion`),
          h('button', { type: 'button', class: 'forge-mini', 'data-testid': 'art-views-gpt', onclick: () => art({ what: 'views', engine: 'chatgpt' }, `Making the ${isChar ? 'ten views' : 'views'} with ChatGPT`) }, `💬 ${allWord} with ChatGPT`),
          isChar ? h('button', { type: 'button', class: 'forge-mini', 'data-testid': 'art-sheet-gpt', onclick: () => art({ what: 'sheet', engine: 'chatgpt' }, 'Making a turnaround sheet with ChatGPT') }, '🧾 One turnaround sheet (ChatGPT)') : null,
          isChar ? h('button', { type: 'button', class: 'forge-mini', onclick: () => upload('sheet') }, '⬆ Upload a sheet') : null)),
      sheet, grid);
  };
  // ------------------------------------------------------------------ 🔎 check against the book
  const runCheck = async () => {
    clear(checkMsg);
    const j = await x.runAiJob(`${path}/check`, { ai: checkAi.checked }, checkProg, 'Checking against the book');
    if (j) { const r = (j.results || []).slice(-1)[0] || {}; x.toast(r.message || 'Checked'); }
    await loadCheck();
    render();
  };
  const checkAi = h('input', { type: 'checkbox', checked: true, 'data-testid': 'check-ai' });
  const verdict = async (f, v) => {
    clear(checkMsg);
    const body = { verdict: f.verdict === v ? null : v };
    if (v === 'change_dossier' && f.verdict !== v) {
      const card = (d.sections.flatMap(s => s.fields)).find(c => c.key === f.field) || {};
      const ta = h('textarea', { rows: '5', maxlength: '1200', 'aria-label': 'The new dossier text', 'data-testid': 'change-text' }); ta.value = f.dossier_text || card.text || '';
      const ok = await x.choiceDialog('Change the dossier instead?', h('div', { class: 'stack' },
        h('p', null, `The book is right: “${f.field_label || f.field}” gets this text as a proposal. It replaces the approved text only when you ✔ approve it.`),
        h('label', null, `New text for “${f.field_label || f.field}”`, ta)), [{ id: 'yes', label: '✎ Make the proposal' }]);
      if (ok !== 'yes') return;
      body.text = ta.value;
    }
    try {
      const out = await api('PUT', bpath(`${path}/check/${encodeURIComponent(f.id)}`), { body });
      if (out.message) x.toast(out.message);
      if (out.dossier) d = out.dossier;
      await loadCheck();
    } catch (e) { fail(e, 'Could not mark it', checkMsg); }
    render();
  };
  const jumpTo = key => {
    filter.clear(); showEmpty = true; render();
    const el = page.querySelector(`[data-testid=forge-card][data-key="${key}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
  };
  const checkPanel = () => {
    const c = check || { status: 'never', findings: [], counts: { total: 0, open: 0 } };
    const fs = c.findings || [];
    const head = c.status === 'never' ? 'Not checked yet.'
      : c.status === 'running' ? `Checking… ${c.chapters_done || 0} of ${c.chapters_total || '?'} chapter(s).`
        : (c.message || '');
    const list = h('div', { class: 'forge-findings', role: 'list' });
    for (const f of fs) {
      const vbtn = (v, label, cls) => h('button', { type: 'button', class: `forge-mini ${cls}${f.verdict === v ? ' on' : ''}`, 'aria-pressed': String(f.verdict === v), 'data-testid': `verdict-${v}`, onclick: () => verdict(f, v) }, label);
      list.appendChild(h('article', { class: `forge-finding${f.verdict ? ` v-${f.verdict}` : ''}${f.stale ? ' stale' : ''}`, role: 'listitem', 'data-testid': 'finding', 'data-id': f.id, 'data-verdict': f.verdict || '' },
        h('div', { class: 'forge-finding-head' },
          h('span', { class: 'forge-finding-ch' }, `Chapter ${f.chapter}`),
          h('button', { type: 'button', class: 'forge-finding-field', title: 'Show this field', onclick: () => jumpTo(f.field) }, f.field_label || f.field),
          h('span', { class: `forge-badge ${f.source === 'ai' ? 'src-ai' : 'src-rule'}`, title: f.source === 'ai' ? 'Found by your AI (the quote was checked against the chapter)' : 'Found by Akọwe’s own check (no AI)' }, f.source === 'ai' ? 'AI' : 'rule'),
          f.verdict ? h('span', { class: 'forge-badge verdict' }, VERDICT_WORDS[f.verdict]) : null),
        h('blockquote', { class: 'forge-quote' }, `“${f.quote}”`),
        h('p', { class: 'forge-problem' }, f.problem),
        f.fix ? h('p', { class: 'forge-note' }, h('strong', null, 'Fix: '), f.fix) : null,
        f.proposal ? h('p', { class: 'forge-note' }, '✎ A proposal waits in the dossier: ', h('em', null, f.proposal.text)) : null,
        h('div', { class: 'forge-slot-actions' }, vbtn('fix', '🛠 Fix the book', ''), vbtn('fine', '✓ Fine', ''), vbtn('change_dossier', '✎ Change dossier', ''))));
    }
    const counts = c.counts || {};
    return h('section', { class: 'forge-check', 'aria-labelledby': 'forge-check-h', 'data-testid': 'forge-check', 'data-status': c.status },
      h('div', { class: 'forge-plate-head' }, h('h2', { id: 'forge-check-h' }, '🔎 Check against the book'),
        h('div', { class: 'forge-actions small' },
          h('label', { class: 'forge-toggle' }, checkAi, ' Use the AI for the fuzzy parts'),
          h('button', { type: 'button', class: 'forge-btn teal small', 'data-testid': 'check-run', onclick: runCheck }, c.status === 'never' ? '🔎 Check against the book' : '🔎 Check again'))),
      h('p', { class: 'forge-note' }, `Compares the accepted fields of this dossier (never proposals) with the written chapters: numbers, names, dates and stated limits by Akọwe itself, the rest by your AI. Mark each finding Fix, Fine or Change dossier.`),
      h('p', { class: 'forge-check-sum', 'data-testid': 'check-summary' }, head,
        fs.length ? ` ${counts.open || 0} open · ${counts.fix || 0} to fix · ${counts.fine || 0} fine · ${counts.change_dossier || 0} change the dossier.` : ''),
      c.ai_problem ? h('p', { class: 'forge-note' }, c.ai_problem) : null,
      (c.appearances || []).some(a => a.mentions) ? h('p', { class: 'forge-note' }, 'Named in: ', c.appearances.filter(a => a.mentions).map(a => `ch. ${a.chapter} (${a.mentions}×)`).join(', ')) : null,
      checkMsg, checkProg, list);
  };
  const letterBar = () => {
    const bar = h('div', { class: 'forge-letters', role: 'group', 'aria-label': 'Show only these categories', 'data-testid': 'forge-letters' });
    bar.appendChild(h('button', { type: 'button', class: `forge-chip all${filter.size ? '' : ' on'}`, 'aria-pressed': String(!filter.size), onclick: () => { filter.clear(); render(); } }, 'All'));
    for (const [k, w] of Object.entries(LETTER_WORDS)) {
      bar.appendChild(h('button', { type: 'button', class: `forge-chip${filter.has(k) ? ' on' : ''}`, 'aria-pressed': String(filter.has(k)), 'data-letter': k, title: w,
        onclick: () => { if (filter.has(k)) filter.delete(k); else filter.add(k); render(); } }, h('b', null, k), ` ${w}`));
    }
    const empt = h('label', { class: 'forge-toggle' }, h('input', { type: 'checkbox', checked: showEmpty, onchange: e => { showEmpty = e.target.checked; render(); } }), ' Show empty fields');
    return h('div', { class: 'forge-filterbar' }, bar, empt);
  };
  const fieldCard = (sec, f) => {
    const tags = h('span', { class: 'forge-tags', title: f.letters.map(l => LETTER_WORDS[l]).join(', ') }, `[${f.letters.join(',')}]`);
    const badges = [];
    if (f.text && f.status === 'proposed') badges.push(h('span', { class: 'forge-badge proposed' }, f.was !== undefined ? 'change proposed' : 'proposed'));
    else if (f.text && f.status === 'approved') badges.push(h('span', { class: 'forge-badge approved' }, '✔ approved'));
    if (f.protected) badges.push(h('span', { class: 'forge-badge lock', title: f.readonly ? 'From the character record: change it on the character page' : 'Protected: the AI never changes it' }, '🔒'));
    if (f.source && SOURCE_WORDS[f.source] && f.text) badges.push(h('span', { class: 'forge-badge src', title: SOURCE_WORDS[f.source] }, f.source === 'canon' ? '📘' : f.source === 'voice' ? '🗣' : '🎭'));
    if (!isChar && f.by && f.by.kind === 'canon' && f.text) badges.push(h('span', { class: 'forge-badge src', title: 'Filled from your book’s records' }, '📘'));
    const card = h('article', { class: `forge-card st-${f.text ? f.status : 'empty'}${f.protected ? ' locked' : ''}`, 'data-key': f.key, 'data-testid': 'forge-card', 'data-status': f.text ? f.status : 'empty' });
    if (editing === f.key) { card.appendChild(editor(sec, f)); return card; }
    const actions = h('div', { class: 'forge-card-actions' });
    if (f.text && f.status === 'proposed') actions.appendChild(h('button', { type: 'button', class: 'forge-mini ok', 'data-testid': 'approve-one', onclick: () => approve({ fields: [f.key] }) }, '✔ Approve'));
    if (!f.readonly) actions.appendChild(h('button', { type: 'button', class: 'forge-mini', 'data-testid': 'edit-one', onclick: () => { editing = f.key; render(); } }, f.text ? '✎ Edit' : '✎ Write it'));
    else actions.appendChild(h('a', { class: 'forge-mini', href: plink('rec', rid) }, '📘 Character page'));
    const text = f.text ? f.text.split('\n').map((ln, i) => [i ? h('br') : null, ln]) : h('span', { class: 'forge-empty-text' }, 'Empty');
    card.append(...[h('div', { class: 'forge-card-head' }, h('p', { class: 'forge-card-text' }, tags, ' ', h('strong', null, `${f.label}:`), ' ', text), h('div', { class: 'forge-badges' }, badges)),
      f.was !== undefined && f.status === 'proposed' ? h('p', { class: 'forge-was' }, h('span', null, 'Was: '), f.was || '(empty)') : null,
      (f.links || []).length ? h('p', { class: 'forge-card-links' }, '↗ ', f.links.map(linkChip)) : null,
      actions].filter(Boolean));
    return card;
  };
  const editor = (sec, f) => {
    const id = `fe-${f.key}`;
    const ta = h('textarea', { id, rows: String(Math.min(10, Math.max(3, Math.ceil((f.text || '').length / 90)))), maxlength: '1200' }); ta.value = f.text || '';
    const title = f.title !== undefined ? h('input', { type: 'text', maxlength: '80', value: f.title || '', 'aria-label': 'Title (who / when)', placeholder: f.key.startsWith('relationship') ? 'Name / code, e.g. Imani Vey / CH-002' : 'Years / heading, e.g. 2175 / apprenticeship' }) : null;
    const letters = h('input', { type: 'text', value: f.letters.join(','), 'aria-label': 'Letters', class: 'forge-letters-in', title: 'Category letters, e.g. C,A' });
    const prot = h('input', { type: 'checkbox', checked: f.protected });
    const go = async () => {
      const ch = { text: ta.value, letters: letters.value.split(/[ ,]+/).filter(Boolean), protected: prot.checked };
      if (title) ch.title = title.value;
      await save({ [sec.key]: { [f.key]: ch } });
    };
    ta.addEventListener('keydown', ev => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); go(); } if (ev.key === 'Escape') { editing = null; render(); } });
    setTimeout(() => { try { (title && !title.value ? title : ta).focus(); } catch { /* ignore */ } }, 30);
    return h('div', { class: 'forge-editor' },
      h('label', { for: id, class: 'forge-edit-label' }, h('span', { class: 'forge-tags' }, `[${f.letters.join(',')}]`), ` ${f.label}`),
      title, ta,
      h('div', { class: 'forge-edit-row' },
        h('label', null, 'Letters ', letters), h('label', { class: 'forge-toggle' }, prot, ' 🔒 Protected (the AI never changes it)'),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'forge-btn gold small', 'data-testid': 'save-one', onclick: go }, f.status === 'proposed' ? '💾 Save and approve' : '💾 Save'),
        h('button', { type: 'button', class: 'forge-btn ghost small', onclick: () => { editing = null; render(); } }, 'Cancel')),
      f.source && SOURCE_WORDS[f.source] ? h('p', { class: 'forge-note' }, `This field is ${SOURCE_WORDS[f.source]}: saving updates it there too.`) : null);
  };
  const sections = () => {
    const out = h('div', { class: 'forge-sections' });
    const toc = h('nav', { class: 'forge-toc', 'aria-label': 'Sections' });
    for (const s of d.sections) {
      const shown = s.fields.filter(f => (showEmpty || f.text || editing === f.key) && (!filter.size || f.letters.some(l => filter.has(l))));
      const filled = s.fields.filter(f => f.text).length;
      const waiting = s.fields.filter(f => f.text && f.status === 'proposed').length;
      toc.appendChild(h('a', { href: `#forge-s-${s.key}`, onclick: ev => { ev.preventDefault(); const t = document.getElementById(`forge-s-${s.key}`); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
        h('span', { class: 'n' }, String(s.n).padStart(2, '0')), ` ${s.title}`, waiting ? h('span', { class: 'forge-dot', title: `${waiting} proposed` }) : null));
      if (!shown.length) continue;
      out.appendChild(h('section', { class: 'forge-section', id: `forge-s-${s.key}`, 'data-section': s.key },
        h('div', { class: 'forge-section-head' }, h('h2', null, `${String(s.n).padStart(2, '0')} / ${s.title}`),
          h('span', { class: 'forge-section-meta' }, `${filled}/${s.fields.length}`, waiting ? ` · ${waiting} proposed` : ''),
          waiting ? h('button', { type: 'button', class: 'forge-mini ok', onclick: () => approve({ fields: s.fields.filter(f => f.text && f.status === 'proposed').map(f => f.key) }) }, `✔ Approve this section (${waiting})`) : null),
        shown.map(f => fieldCard(s, f))));
    }
    if (!out.children.length) out.appendChild(h('p', { class: 'forge-note' }, 'No field has these letters yet.'));
    return h('div', { class: 'forge-body' }, toc, out);
  };
  const legend = () => h('footer', { class: 'forge-legend' },
    Object.entries(LETTER_WORDS).map(([k, w]) => h('span', null, `${k} ${w}`)),
    h('span', { class: 'forge-legend-code' }, `${d.code} | REV ${d.revision} | ${d.readiness === 'ready' ? 'READY' : 'DRAFT'}`));
  const render = () => {
    const y = window.scrollY;
    clear(page).append(kindTabs(x, seg), hero(), plate(), checkPanel(), letterBar(), sections(), legend());
    window.scrollTo(0, y);
  };
  render();
  loadCheck().then(() => { if (document.contains(page) && check && check.status !== 'never') render(); });
}
