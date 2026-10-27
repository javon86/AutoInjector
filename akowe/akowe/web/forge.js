/* 🗂 Character Forge (plan item B5): the dossier list (#/p/<pid>/<b>/forge) and one character's dossier
   (#/p/<pid>/<b>/forge/<record_id>) in the look of the author's Moki Vey sample: hero portrait, gold name, teal
   tagline, the 🎬 motion study under the portrait, the ten-view plate, numbered section cards with category letters. Proposed fields carry a "proposed"
   badge with ✔ Approve / ✎ Edit; protected fields a 🔒. The helpers of app.js are passed in (no state of its own).
   API: /forge/… (forge.py, docs/CHARACTER_FORGE.md). All styles are scoped under .forge (style.css). */

const LETTER_WORDS = { C: 'Canon', P: 'Personality', V: 'Voice', A: 'Appearance', F: 'Fighting', M: 'Magic', K: 'Knowledge/skills', R: 'Relationships', S: 'Story development', E: 'Essential on-page detail' };
const STATUS_WORDS = { supplied: 'yours', proposed: 'proposed', approved: 'approved' };
const ENGINE_WORDS = { sd: 'Stable Diffusion', chatgpt: 'ChatGPT', auto: 'the picture maker' };
const VIEWS = [['front', 'FRONT'], ['three_quarter_front', '3/4 FRONT'], ['side', 'SIDE'], ['three_quarter_back', '3/4 BACK'], ['back', 'BACK'],
  ['idle', 'IDLE'], ['draw', 'DRAW / TOOL REACH'], ['attack', 'ATTACK / EMPTY HAND'], ['dash', 'DASH'], ['defend', 'DEFEND']].map(([key, label]) => ({ key, label }));
const SOURCE_WORDS = { canon: 'from the character record', sheet: 'shared with the character sheet', voice: 'shared with the voice card' };

const CLIP_MAX_MB = 40;   // forge.MAX_CLIP_BYTES
const CLIP_TYPES = ['video/mp4', 'video/webm'];

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

/* ======================================================================= the list */
export async function viewForgeList(main, x) {
  const { h, clear, api, bpath, plink, S } = x;
  const where = { book: S.project.name, step: 'Character Forge' };
  const wrap = h('div', { class: 'forge forge-list-page', 'data-testid': 'forge-list' });
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    x.crumbs(['Your books', '#/'], [S.project.name, plink()], 'Character Forge'),
    h('h1', null, '🗂 Character Forge')),
  h('div', { class: 'row' }, x.infoTip('Character Forge',
    h('p', null, 'A deep dossier for every character, in 14 numbered sections: record, inner life, relationships, voice, detailed appearance, fighting, weapons, powers, skills, physical limits, knowledge, backstory, storyline and continuity.'),
    h('p', null, 'Every entry carries category letters (C Canon · P Personality · V Voice · A Appearance · F Fighting · M Magic · K Knowledge · R Relationships · S Story · E Essential on-page detail), so each chapter only gets the details it needs.'),
    h('p', null, '✨ Invent the rest: your AI fills the empty fields as proposals. Nothing it invents is used until you approve it. Your own text and protected fields are never changed.')))));
  main.appendChild(wrap);
  const msg = h('div', { 'aria-live': 'polite' });
  const body = h('div', null, x.loadingState('Loading the dossiers…'));
  wrap.append(msg, body);
  const loadExample = async btn => {
    btn.disabled = true; clear(msg);
    try {
      const out = await api('POST', bpath('/forge/example'), { body: {} });
      x.toast(out.message || 'Example loaded');
      location.hash = plink('forge', out.record_id);
    } catch (e) { btn.disabled = false; msg.appendChild(x.problemBox(x.toProblem(e, where), {}, 'The example could not be loaded')); }
  };
  let info;
  try { info = await api('GET', bpath('/forge/characters')); }
  catch (e) { clear(body).appendChild(x.problemBox(x.toProblem(e, where), { retry: () => x.route() }, 'Could not open the Character Forge')); return; }
  clear(body);
  const exampleBtn = h('button', { type: 'button', class: 'forge-btn ghost', 'data-testid': 'forge-example', onclick: ev => loadExample(ev.currentTarget) }, '🧪 Load the Moki Vey example');
  const chars = info.characters || [];
  if (!chars.length) {
    body.appendChild(h('section', { class: 'forge-empty' },
      h('div', { class: 'forge-empty-glyph', 'aria-hidden': 'true' }, '🗂'),
      h('h2', null, 'No characters yet'),
      h('p', null, 'Make your characters first (Make my book → characters, or the Bible Builder). Every character then gets a dossier here.'),
      h('p', null, 'Want to see what a finished dossier looks like? Load the example: a complete dossier with a portrait and ten reference views.'),
      h('div', { class: 'forge-actions' }, exampleBtn, h('a', { class: 'forge-btn ghost', href: plink('book') }, '📘 Make my book'))));
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
  body.append(grid);
  if (!chars.some(c => c.name.toLowerCase() === 'moki vey')) body.appendChild(h('div', { class: 'forge-actions forge-foot' }, exampleBtn));
}

/* ======================================================================= one dossier */
export async function viewForge(main, rid, x) {
  const { h, clear, api, bpath, plink, S } = x;
  const where = { book: S.project.name, step: 'Character Forge' };
  const path = `/forge/characters/${encodeURIComponent(rid)}`;
  let d;
  const filter = new Set();
  let showEmpty = true;
  let editing = null;   // field key being edited
  const load = async () => { d = await api('GET', bpath(path)); };
  try { await load(); }
  catch (e) { main.appendChild(x.problemBox(x.toProblem(e, where), { retry: () => x.route() }, 'Could not open this dossier')); return; }
  main.appendChild(x.crumbs(['Your books', '#/'], [S.project.name, plink()], ['Character Forge', plink('forge')], d.name));
  const page = h('div', { class: 'forge forge-page', 'data-testid': 'forge-page' });
  main.appendChild(page);
  const msg = h('div', { class: 'forge-msg', 'aria-live': 'polite' });
  const prog = h('div', { class: 'forge-prog', 'aria-live': 'polite' });
  const clipMsg = h('div', { class: 'forge-msg', 'aria-live': 'polite' });
  const clipProg = h('div', { class: 'forge-prog', 'aria-live': 'polite', 'data-testid': 'clip-progress' });
  const fail = (e, title) => { clear(msg).appendChild(x.problemBox(x.toProblem(e, where), {}, title)); };
  const reload = async () => { try { await load(); } catch (e) { fail(e, 'Could not reload the dossier'); } render(); };
  const slotSel = h('select', { class: 'forge-select', 'aria-label': 'Which AI invents', 'data-testid': 'forge-slot' },
    h('option', { value: '' }, 'AI: automatic (AI-1 first)'), ['AI-1', 'AI-2', 'AI-3'].map(s => h('option', { value: s }, s)));

  const job = async (sub, body, label, where = prog) => {
    clear(msg);
    const j = await x.runAiJob(`${path}/${sub}`, body, where, label);
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
    const ok = await x.choiceDialog('Approve every proposal?', h('p', null, `${d.counts.proposed} invented field(s) become part of ${d.name}’s approved dossier. Approved voice and inner-life details go into the character sheet and voice card, which the writer uses.`), [{ id: 'yes', label: '✔ Approve all' }]);
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
      const a = h('a', { href: url, download: `${d.code} ${d.name} - Character Forge dossier.pdf` }); document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { fail(e, 'The dossier PDF could not be made'); }
    btn.disabled = false;
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
    const purpose = slot === 'portrait' ? { what: 'portrait' } : slot === 'sheet' ? { what: 'sheet' } : { what: 'views', views: [slot] };
    return h('div', { class: 'forge-slot-actions' },
      h('button', { type: 'button', class: 'forge-mini', title: `Make the ${label} with Stable Diffusion`, 'data-testid': `art-sd-${slot}`, onclick: () => art(Object.assign({ engine: 'sd' }, purpose), `Making the ${label} with Stable Diffusion`) }, '🎨 Stable Diffusion'),
      h('button', { type: 'button', class: 'forge-mini', title: `Make the ${label} with ChatGPT`, 'data-testid': `art-gpt-${slot}`, onclick: () => art(Object.assign({ engine: 'chatgpt' }, purpose), `Making the ${label} with ChatGPT`) }, '💬 ChatGPT'),
      h('button', { type: 'button', class: 'forge-mini', title: `Upload your own ${label}`, 'data-testid': `art-up-${slot}`, onclick: () => upload(slot) }, '⬆ Upload'));
  };
  // 🎬 the motion clip: made from the portrait (or the front view) by AutoInjector's video maker, or uploaded
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
    const source = d.art.portrait ? 'portrait' : d.art.views.front ? 'front view' : null;
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
        h('span', null, source ? 'No clip yet' : 'Needs a portrait first')));
    }
    const meta = c ? [c.seconds ? `${c.seconds} s loop` : 'loop', c.source === 'upload' ? 'your clip' : (c.model || c.engine || null)].filter(Boolean).join(' · ') : '';
    return h('section', { class: 'forge-motion', 'aria-labelledby': 'forge-motion-h', 'data-testid': 'forge-motion' },
      h('div', { class: 'forge-motion-head' }, h('h3', { id: 'forge-motion-h' }, '🎬 Motion study'), meta ? h('span', { class: 'forge-motion-meta' }, meta) : null),
      frame,
      h('div', { class: 'forge-slot-actions' },
        h('button', { type: 'button', class: 'forge-mini', 'data-testid': 'clip-make', disabled: !source,
          title: source ? `A 4-second idle-motion clip made from the ${source} (AutoInjector → 🎬 Video)` : 'Make or upload the portrait first: the clip is made from it',
          onclick: makeClip }, c ? '🎬 Make the motion clip again' : '🎬 Make the motion clip'),
        h('button', { type: 'button', class: 'forge-mini', 'data-testid': 'clip-upload', title: `Upload your own MP4 or WebM clip (up to ${CLIP_MAX_MB} MB)`, onclick: uploadClip }, '⬆ Upload a clip')),
      clipMsg, clipProg);
  };
  const picture = (holder, artItem, alt) => {
    if (!artItem) return;
    blobOf(artItem).then(u => { if (u) { clear(holder).appendChild(h('img', { src: u, alt })); holder.classList.add('has-img'); } }).catch(() => { /* the empty slot stays */ });
  };

  // ------------------------------------------------------------------ pieces
  const hero = () => {
    const frame = h('div', { class: 'forge-portrait', 'data-testid': 'forge-portrait' },
      h('div', { class: 'forge-slot-empty' }, h('span', { class: 'forge-initials big' }, initials(d.name)), h('span', null, 'No portrait yet')));
    picture(frame, d.art.portrait, `${d.name}, portrait`);
    const ready = d.readiness === 'ready';
    const sub = [d.tagline ? d.tagline.toUpperCase() : null, 'CHARACTER FORGE'].filter(Boolean).join('  /  ');
    const cover = h('div', { class: 'forge-cover' },
      h('div', { class: 'forge-code', 'data-testid': 'forge-code' }, `${d.code} · REV ${d.revision} · `, h('span', { class: `forge-ready ${d.readiness}`, 'data-testid': 'forge-readiness' }, ready ? 'READY' : 'DRAFT')),
      h('h1', { class: 'forge-name' }, d.name),
      h('p', { class: 'forge-tagline' }, sub),
      (d.summary || []).length ? h('ul', { class: 'forge-summary' }, d.summary.map(s => h('li', null, s))) : h('p', { class: 'forge-summary muted' }, 'No cover lines yet — ✨ Invent the rest writes them, or ✎ edit the cover.'),
      h('div', { class: 'forge-stats' },
        stat(d.counts.filled, `of ${d.counts.fields} fields`), stat(d.counts.proposed, 'proposed', d.counts.proposed ? 'warn' : ''),
        stat(d.counts.protected, 'protected'), stat(d.counts.views_done, 'of 10 views')),
      h('div', { class: 'forge-actions' },
        h('button', { type: 'button', class: 'forge-btn gold', 'data-testid': 'forge-invent', onclick: invent }, '✨ Invent the rest'),
        h('button', { type: 'button', class: 'forge-btn teal', 'data-testid': 'forge-approve-all', disabled: !d.counts.proposed, onclick: approveAll }, '✔ Approve all proposals'),
        h('button', { type: 'button', class: 'forge-btn ghost', 'data-testid': 'forge-pdf', onclick: ev => pdf(ev.currentTarget) }, '⬇ Dossier PDF'),
        h('button', { type: 'button', class: 'forge-btn ghost', 'data-testid': 'forge-edit-cover', onclick: editCover }, '✎ Edit the cover')),
      h('div', { class: 'forge-actions small' }, slotSel,
        !d.approved_character ? h('span', { class: 'forge-note' }, 'The character itself is still a draft.') : null),
      msg, prog);
    return h('section', { class: 'forge-hero', 'aria-label': 'Cover' },
      h('div', { class: 'forge-portrait-col' }, frame, artButtons('portrait', 'portrait'), motion()), cover);
  };
  const stat = (n, label, cls = '') => h('div', { class: `forge-stat ${cls}` }, h('strong', null, String(n)), h('span', null, label));
  const editCover = async () => {
    const tag = h('input', { type: 'text', maxlength: '90', value: d.tagline || '', 'aria-label': 'Tagline' });
    const sum = h('textarea', { rows: '3', 'aria-label': 'Three cover lines' }); sum.value = (d.summary || []).join('\n');
    const ok = await x.choiceDialog('The cover', h('div', { class: 'stack' }, h('label', null, 'Tagline (e.g. “The man who holds the line”)', tag), h('label', null, 'Three short cover lines, one per line', sum)), [{ id: 'save', label: '💾 Save' }]);
    if (ok !== 'save') return;
    await save({}, { tagline: tag.value, summary: sum.value.split('\n') });
  };
  const plate = () => {
    const grid = h('div', { class: 'forge-views', 'data-testid': 'forge-views' });
    for (const v of VIEWS) {
      const it = d.art.views[v.key];
      const box = h('div', { class: 'forge-view-img' }, h('div', { class: 'forge-slot-empty' }, h('span', { class: 'forge-silhouette', 'aria-hidden': 'true' }), h('span', null, 'empty')));
      picture(box, it, `${d.name}, ${v.label.toLowerCase()} view`);
      grid.appendChild(h('figure', { class: `forge-view${it ? ' done' : ''}`, 'data-view': v.key },
        box, h('figcaption', null, v.label), artButtons(v.key, `${v.label.toLowerCase()} view`)));
    }
    const sheet = d.art.sheet ? h('div', { class: 'forge-sheet' }) : null;
    if (sheet) picture(sheet, d.art.sheet, `${d.name}, turnaround sheet`);
    return h('section', { class: 'forge-plate', 'aria-labelledby': 'forge-plate-h' },
      h('div', { class: 'forge-plate-head' }, h('h2', { id: 'forge-plate-h' }, `${d.name.toUpperCase()} / TEN-VIEW REFERENCE`),
        h('div', { class: 'forge-actions small' },
          h('button', { type: 'button', class: 'forge-mini', 'data-testid': 'art-views-sd', onclick: () => art({ what: 'views', engine: 'sd' }, 'Making the ten views with Stable Diffusion') }, '🎨 All ten with Stable Diffusion'),
          h('button', { type: 'button', class: 'forge-mini', 'data-testid': 'art-views-gpt', onclick: () => art({ what: 'views', engine: 'chatgpt' }, 'Making the ten views with ChatGPT') }, '💬 All ten with ChatGPT'),
          h('button', { type: 'button', class: 'forge-mini', 'data-testid': 'art-sheet-gpt', onclick: () => art({ what: 'sheet', engine: 'chatgpt' }, 'Making a turnaround sheet with ChatGPT') }, '🧾 One turnaround sheet (ChatGPT)'),
          h('button', { type: 'button', class: 'forge-mini', onclick: () => upload('sheet') }, '⬆ Upload a sheet'))),
      sheet, grid);
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
    if (f.text && f.status === 'proposed') badges.push(h('span', { class: 'forge-badge proposed' }, 'proposed'));
    else if (f.text && f.status === 'approved') badges.push(h('span', { class: 'forge-badge approved' }, '✔ approved'));
    if (f.protected) badges.push(h('span', { class: 'forge-badge lock', title: f.readonly ? 'From the character record: change it on the character page' : 'Protected: the AI never changes it' }, '🔒'));
    if (f.source && SOURCE_WORDS[f.source] && f.text) badges.push(h('span', { class: 'forge-badge src', title: SOURCE_WORDS[f.source] }, f.source === 'canon' ? '📘' : f.source === 'voice' ? '🗣' : '🎭'));
    const card = h('article', { class: `forge-card st-${f.text ? f.status : 'empty'}${f.protected ? ' locked' : ''}`, 'data-key': f.key, 'data-testid': 'forge-card', 'data-status': f.text ? f.status : 'empty' });
    if (editing === f.key) { card.appendChild(editor(sec, f)); return card; }
    const actions = h('div', { class: 'forge-card-actions' });
    if (f.text && f.status === 'proposed') actions.appendChild(h('button', { type: 'button', class: 'forge-mini ok', 'data-testid': 'approve-one', onclick: () => approve({ fields: [f.key] }) }, '✔ Approve'));
    if (!f.readonly) actions.appendChild(h('button', { type: 'button', class: 'forge-mini', 'data-testid': 'edit-one', onclick: () => { editing = f.key; render(); } }, f.text ? '✎ Edit' : '✎ Write it'));
    else actions.appendChild(h('a', { class: 'forge-mini', href: plink('rec', rid) }, '📘 Character page'));
    const text = f.text ? f.text.split('\n').map((ln, i) => [i ? h('br') : null, ln]) : h('span', { class: 'forge-empty-text' }, 'Empty');
    card.append(h('div', { class: 'forge-card-head' }, h('p', { class: 'forge-card-text' }, tags, ' ', h('strong', null, `${f.label}:`), ' ', text), h('div', { class: 'forge-badges' }, badges)), actions);
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
    clear(page).append(hero(), plate(), letterBar(), sections(), legend());
    window.scrollTo(0, y);
  };
  render();
}
