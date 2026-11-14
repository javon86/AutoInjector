// 📖 Grow my start into a novel (grow_novel.py): #/grow (paste or upload the opening, check the chapters Akọwe found,
// choose how long the finished book is) and the book's page #/p/<pid>/<branch>/grow (the AI reads the chapters → ONE
// screen "Here's what I understood from your chapters — fix anything" → ✔ Use this → plan the rest → ✔ Use this plan
// → ⚡ Write the rest). app.js passes its helpers in (growUI()), so this module never reaches into app.js. All data
// is rendered with DOM APIs (never innerHTML with server data).

const ACCEPT = '.docx,.odt,.pdf,.txt,.md,.markdown,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.oasis.opendocument.text';
const MAX_MB = 40;
const LENGTHS = [['short_story', 'Short story', 3], ['novelette', 'Novelette', 6], ['novella', 'Novella', 12], ['novel', 'Novel', 25]];
const ROLES = ['protagonist', 'deuteragonist', 'love_interest', 'antagonist', 'henchman', 'rival', 'mentor', 'sidekick', 'ally', 'family', 'supporting', 'minor', 'extra'];
const RULE_CATS = [['hard_rule', 'Hard rule'], ['seen', 'Seen to happen'], ['belief', 'Belief'], ['mystery', 'Protected mystery']];
const KINDS = [['', '(let the plan decide)'], ['monster', 'Overcoming the monster'], ['rags_to_riches', 'Rags to riches'], ['quest', 'The quest'], ['voyage_return', 'Voyage and return'], ['comedy', 'Comedy'], ['tragedy', 'Tragedy'], ['rebirth', 'Rebirth']];

/** append children, skipping null / false (Element.append would print "null") */
function add(el, ...kids) { for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k); return el; }
function n(x) { return (x || 0).toLocaleString('en-US'); }
const words = s => String(s || '').trim();

/* ======================================================================= #/grow */
export function viewGrowStart(main, c) {
  const { h, clear, api, crumbs, problemBox, toProblem, go } = c;
  const where = { step: 'Grow my start into a novel' };
  main.appendChild(h('div', { class: 'page-head' }, h('div', null, crumbs(['My books', '#/'], 'Grow my start into a novel'),
    h('h1', null, '📖 Grow my start into a novel'))));
  const body = h('div', { 'aria-live': 'polite' });
  const file = h('input', { type: 'file', id: 'gr-file', accept: ACCEPT, 'data-testid': 'gr-file' });
  const paste = h('textarea', { id: 'gr-paste', rows: '10', 'data-testid': 'gr-paste', placeholder: 'Or paste your chapters (or a few pages) here…' });
  const msg = h('div', { 'aria-live': 'polite' });
  const readBtn = h('button', { type: 'button', class: 'primary big', 'data-testid': 'gr-read' }, '📖 Read my chapters');
  const card = h('section', { class: 'card', 'data-testid': 'gr-start', 'aria-labelledby': 'gr-h' },
    h('h2', { id: 'gr-h' }, 'Your opening'),
    h('p', null, 'Give Akọwe the chapters you wrote — one to a dozen, or just a few pages. The AI reads them, fills the Book Bible (your characters and how they talk, your places, your world and its rules — magic included — your style), plans the rest and writes on from where you stopped. Your chapters stay exactly as you wrote them.'),
    h('div', { class: 'field' }, h('label', { for: 'gr-file' }, 'A Word file (.docx), PDF, OpenDocument (.odt), text (.txt) or Markdown (.md) file'), file,
      h('span', { class: 'hint' }, 'Headings (“Chapter 1”, Heading 1 …) show where chapters start; with no heading it is chapter 1.')),
    h('div', { class: 'field' }, h('label', { for: 'gr-paste' }, 'Or paste the text'), paste),
    h('div', { class: 'row' }, readBtn), msg);
  main.appendChild(card);
  main.appendChild(body);
  readBtn.addEventListener('click', async () => {
    clear(msg);
    const f = file.files && file.files[0];
    if (!f && !paste.value.trim()) { msg.appendChild(h('p', { class: 'small words-warn' }, 'Choose a file or paste your chapters first.')); return; }
    if (f && f.size > MAX_MB * 1024 * 1024) { msg.appendChild(problemBox(toProblem({ code: 'IMPORT_TOO_LARGE', message: `the file is ${Math.round(f.size / 1048576)} MB` }, where))); return; }
    readBtn.disabled = true;
    msg.appendChild(c.loadingState('Reading your chapters…'));
    try {
      let d;
      if (f) {
        const buf = await f.arrayBuffer();
        const safe = f.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'opening';
        d = await api('POST', '/import/read', { raw: buf, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': safe } });
      } else d = await api('POST', '/import/read', { body: { text: paste.value, name: 'pasted text' } });
      clear(msg);
      card.hidden = true;
      drawFound(body, c, d);
    } catch (e) { clear(msg).appendChild(problemBox(toProblem(e, where))); }
    readBtn.disabled = false;
  });

  function drawFound(holder, c2, d) {
    clear(holder);
    const inc = d.chapters.filter(x => x.include);
    const title = h('input', { id: 'gr-title', type: 'text', value: d.title_guess || '', 'data-testid': 'gr-title' });
    const author = h('input', { id: 'gr-author', type: 'text', value: '', 'data-testid': 'gr-author' });
    const len = h('select', { id: 'gr-length', 'data-testid': 'gr-length' }, LENGTHS.map(([k, l, ch]) => h('option', { value: k, selected: k === 'novel' }, `${l} (about ${ch} chapters)`)));
    const total = h('input', { id: 'gr-total', type: 'number', min: String(inc.length + 1), max: '60', value: String(Math.max(25, inc.length + 1)), 'data-testid': 'gr-total' });
    len.addEventListener('change', () => { const p = LENGTHS.find(x => x[0] === len.value); total.value = String(Math.max(p[2], inc.length + 1)); });
    const go2 = h('button', { type: 'button', class: 'primary big', 'data-testid': 'gr-create' }, '📖 Start my book from these chapters');
    const m2 = h('div', { 'aria-live': 'polite' });
    holder.appendChild(h('section', { class: 'card', 'data-testid': 'gr-found', 'aria-labelledby': 'gr-f-h' },
      h('h2', { id: 'gr-f-h' }, `Akọwe found ${inc.length} chapter${inc.length === 1 ? '' : 's'} (${n(d.words)} words)`),
      (d.warnings || []).length ? h('ul', { class: 'small plain-list' }, d.warnings.map(w => h('li', null, '⚠️ ', w))) : null,
      h('ol', { class: 'plain-list', 'data-testid': 'gr-chapters' }, inc.map(ch => h('li', null, h('strong', null, ch.title), ` — ${n(ch.words)} words · `, h('span', { class: 'muted small' }, ch.preview)))),
      h('p', { class: 'small muted' }, 'These are your chapters: they are kept word for word, approved, and never rewritten by the AI.'),
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', { for: 'gr-title' }, 'Book title'), title),
        h('div', { class: 'field' }, h('label', { for: 'gr-author' }, 'Pen name (optional)'), author),
        h('div', { class: 'field' }, h('label', { for: 'gr-length' }, 'How long should the finished book be?'), len),
        h('div', { class: 'field' }, h('label', { for: 'gr-total' }, 'Chapters in the finished book'), total,
          h('span', { class: 'hint' }, `Yours are chapters 1–${inc.length}; the AI writes the rest.`))),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', onclick: () => { clear(holder); card.hidden = false; } }, '◀ Back'), go2), m2));
    go2.addEventListener('click', async () => {
      clear(m2); go2.disabled = true;
      try {
        const out = await api('POST', '/grow/start', { body: { draft_id: d.draft_id, title: title.value, author: author.value, author_confirms: true, target: { length: len.value, chapters: parseInt(total.value, 10) } } });
        if (c2.loadProjects) await c2.loadProjects();
        go(`#/p/${encodeURIComponent(out.project_id)}/${encodeURIComponent(out.branch_id)}/grow`);
      } catch (e) { m2.appendChild(problemBox(toProblem(e, where))); go2.disabled = false; }
    });
  }
}

/* ======================================================================= #/p/<pid>/<b>/grow */
export async function viewGrow(main, c) {
  const { h, clear, api, bpath, crumbs, problemBox, toProblem, stateBox, runAiJob, toast, route, openMakeBook, plink } = c;
  const where = { book: c.S.project && c.S.project.name, step: 'Grow my start into a novel' };
  main.appendChild(h('div', { class: 'page-head' }, h('div', null, crumbs(['My books', '#/'], [c.S.project ? c.S.project.name : 'Book', plink('book')], 'Grow my start'),
    h('h1', null, '📖 Grow my start into a novel'))));
  let st;
  try { st = await api('GET', bpath('/grow')); } catch (e) { main.appendChild(problemBox(toProblem(e, where))); return; }
  const stages = [['imported', 'Your chapters'], ['understood', 'What I understood'], ['accepted', 'Plan the rest'], ['planned', 'Your plan'], ['ready', 'Write the rest']];
  const order = { imported: 0, understanding: 0, understood: 1, accepting: 1, accepted: 2, planning: 2, planned: 3, using: 3, ready: 4, writing: 4 };
  const at = order[st.stage] || 0;
  main.appendChild(h('ol', { class: 'wz-steps step-rail', 'aria-label': 'Steps', 'data-testid': 'gr-rail' }, stages.map(([, label], i) =>
    h('li', { class: i === at ? 'cur here rail-needs_you' : i < at ? 'done rail-done' : 'rail-blocked', 'aria-current': i === at ? 'step' : null },
      h('span', { class: 'rail-in' }, h('span', { class: 'wz-n rail-dot' }, i < at ? '✔' : String(i + 1)), h('span', { class: 'rail-lab' }, label))))));
  const box = h('section', { class: 'card', 'data-testid': `gr-stage-${st.stage}` });
  const msg = h('div', { 'aria-live': 'polite' });
  main.appendChild(box);
  main.appendChild(msg);
  const yours = (st.chapters || []).length;
  const reload = () => route();

  if (['imported', 'understanding'].includes(st.stage)) {
    const btn = h('button', { type: 'button', class: 'primary big', 'data-testid': 'gr-understand' }, '✨ Read my chapters and fill the Book Bible');
    const prog = h('div', { 'aria-live': 'polite' });
    add(box, h('h2', null, `Your ${yours} chapter${yours === 1 ? '' : 's'}`),
      h('ol', { class: 'plain-list' }, (st.chapters || []).map(ch => h('li', null, `${ch.title} — ${n(ch.words)} words`))),
      h('p', null, 'The AI reads them (two requests) and fills the Book Bible: your characters with how each one really talks, your places and world, the story rules — every magic or special system with exactly what it needs, its limits and its price — your writing style, the premise and the questions your chapters leave open. You check it all on one screen before anything is used.'),
      st.error ? h('p', { class: 'small words-warn' }, `⚠️ The last try stopped (${st.error}). Press the button again.`) : null,
      h('div', { class: 'row' }, btn), prog);
    btn.addEventListener('click', async () => { btn.disabled = true; const j = await runAiJob('/grow/understand', {}, prog, 'Reading your chapters'); btn.disabled = false; if (j) reload(); });
    return;
  }

  if (['understood', 'accepting'].includes(st.stage)) { drawUnderstood(box, c, st, msg, reload); return; }

  if (['accepted', 'planning'].includes(st.stage)) {
    const t = st.target || {};
    const len = h('select', { id: 'gr-plan-length', 'data-testid': 'gr-plan-length' }, LENGTHS.map(([k, l, ch]) => h('option', { value: k, selected: k === t.length }, `${l} (about ${ch} chapters)`)));
    const total = h('input', { id: 'gr-plan-total', type: 'number', min: String(yours + 1), max: '60', value: String(t.chapters || yours + 1), 'data-testid': 'gr-plan-total' });
    const note = h('textarea', { id: 'gr-plan-note', rows: '3', 'data-testid': 'gr-plan-note', placeholder: 'Optional: where should it go? (a twist you want, the ending you see…)' });
    const btn = h('button', { type: 'button', class: 'primary big', 'data-testid': 'gr-plan' }, '🗺 Plan the rest of my book');
    const prog = h('div', { 'aria-live': 'polite' });
    const a = st.accepted || {};
    add(box, h('h2', null, 'Plan the rest'),
      h('p', { 'data-testid': 'gr-accepted' }, `✔ Your Book Bible has ${a.characters || 0} character(s), ${a.places || 0} place(s) and ${a.rules || 0} story rule(s)` + (a.magic ? `, including ${a.magic} magic rule(s) every chapter is checked against` : '') + (a.style ? ', and your writing style.' : '.')),
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', { for: 'gr-plan-length' }, 'Length'), len),
        h('div', { class: 'field' }, h('label', { for: 'gr-plan-total' }, 'Chapters in the finished book'), total,
          h('span', { class: 'hint' }, `The AI plans chapters ${yours + 1} onward, going on from exactly where you stopped.`))),
      h('div', { class: 'field' }, h('label', { for: 'gr-plan-note' }, 'A note for the plan'), note),
      h('div', { class: 'row' }, btn), prog);
    len.addEventListener('change', () => { const p = LENGTHS.find(x => x[0] === len.value); total.value = String(Math.max(p[2], yours + 1)); });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const j = await runAiJob('/grow/plan', { target: { length: len.value, chapters: parseInt(total.value, 10) }, note: note.value || null }, prog, 'Planning the rest of your book');
      btn.disabled = false; if (j) reload();
    });
    return;
  }

  if (['planned', 'using'].includes(st.stage)) { drawPlan(box, c, st, msg, reload); return; }

  // ready / writing
  const run = st.run;
  const write = h('button', { type: 'button', class: 'primary big mab-cta', 'data-testid': 'gr-write' }, run ? '⚡ Open the run' : '⚡ Write the rest of my book');
  add(box, h('h2', null, run ? 'The AI is writing the rest' : 'Ready to write the rest'),
    h('p', null, `The book has ${st.total || '?'} chapters: your ${yours}, then the AI's. Pressing ⚡ is your consent for this run: the AI writes chapters ${yours + 1} onward in your voice — with your characters' voice cards, your world's rules (the magic is checked chapter by chapter) and the continuity of your chapters — and every check of a normal run. The story doctor scores the plan first. Your own chapters are never changed.`),
    run ? h('p', { 'data-testid': 'gr-run' }, `Run: ${run.status} — ${run.phase || ''}`) : null,
    h('div', { class: 'row' }, write, h('a', { class: 'btn', href: plink('book') }, '🏠 Book home'), h('a', { class: 'btn', href: plink('bible') }, '📖 Book Bible')));
  write.addEventListener('click', async ev => {
    if (run) { openMakeBook(ev.currentTarget, { runId: run.id }); return; }
    write.disabled = true; clear(msg);
    try {
      const r = await api('POST', bpath('/grow/write'), { body: { author_confirms: true } });
      toast('The AI is writing the rest of your book');
      openMakeBook(null, { runId: r.id });
    } catch (e) { msg.appendChild(problemBox(toProblem(e, where))); write.disabled = false; }
  });
  void stateBox;
}

function drawUnderstood(box, c, st, msg, reload) {
  const { h, clear, api, bpath, problemBox, toProblem, toast } = c;
  const where = { book: c.S.project && c.S.project.name, step: 'What I understood' };
  const u = JSON.parse(JSON.stringify(st.understood || {}));
  const inp = (obj, key, label, attrs = {}) => {
    const id = attrs.id || `gr-u-${key}-${Math.random().toString(36).slice(2, 7)}`;
    const el = h(attrs.area ? 'textarea' : 'input', Object.assign({ id, type: attrs.area ? null : 'text', value: obj[key] || '', rows: attrs.area ? String(attrs.area) : null, 'data-testid': attrs.testid || null }));
    el.addEventListener('input', () => { obj[key] = el.value; });
    return h('div', { class: 'field' }, h('label', { for: id }, label), el);
  };
  const sel = (obj, key, label, opts, testid) => {
    const id = `gr-u-${key}-${Math.random().toString(36).slice(2, 7)}`;
    const el = h('select', { id, 'data-testid': testid || null }, opts.map(([v, l]) => h('option', { value: v, selected: (obj[key] || '') === v }, l)));
    el.addEventListener('change', () => { obj[key] = el.value; });
    return h('div', { class: 'field' }, h('label', { for: id }, label), el);
  };
  const lines = (obj, key, label, testid) => {
    const id = `gr-u-${key}-${Math.random().toString(36).slice(2, 7)}`;
    const el = h('textarea', { id, rows: '3', value: (obj[key] || []).join('\n'), 'data-testid': testid || null });
    el.addEventListener('input', () => { obj[key] = el.value.split('\n').map(s => s.trim()).filter(Boolean); });
    return h('div', { class: 'field' }, h('label', { for: id }, label), el, h('span', { class: 'hint' }, 'One per line.'));
  };
  add(box, h('h2', { 'data-testid': 'gr-understood-h' }, 'Here’s what I understood from your chapters — fix anything'),
    h('p', { class: 'muted' }, 'Nothing goes into your book until you press ✔ Use this. Quotes marked ✔ are word for word from your chapters.'));
  // the story
  add(box, h('h3', null, '📚 The story'), h('div', { class: 'grid-2' },
    inp(u, 'title', 'Title', { testid: 'gr-u-title' }), inp(u, 'genre', 'Genre'), inp(u, 'audience', 'Readers'), inp(u, 'tone', 'Tone'),
    sel(u, 'story_kind', 'Kind of story', KINDS, 'gr-u-kind'),
    sel(u, 'pov', 'Told in', [['third', 'Third person'], ['first', 'First person']]),
    sel(u, 'tense', 'Tense', [['past', 'Past'], ['present', 'Present']])),
  inp(u, 'premise', 'Premise', { area: 3, testid: 'gr-u-premise' }), inp(u, 'dramatic_question', 'The question the book must answer', { testid: 'gr-u-question' }),
  h('h4', null, 'Your chapters'), h('ol', { class: 'plain-list small' }, (u.chapter_summaries || []).map(s => {
    const el = h('textarea', { rows: '2', value: s.summary || '', 'aria-label': `What happens in chapter ${s.number}` });
    el.addEventListener('input', () => { s.summary = el.value; });
    return h('li', null, h('strong', null, s.title || `Chapter ${s.number}`), el);
  })));
  // the people
  add(box, h('h3', null, '🎭 The people'));
  const cl = h('div', { 'data-testid': 'gr-u-characters' });
  const drawChars = () => {
    clear(cl);
    (u.characters || []).forEach((ch, i) => {
      ch.voice = ch.voice || {};
      const looks = Object.entries(ch.looks || {}).filter(([, v]) => v && v.value).map(([k, v]) => h('li', null, `${k}: ${v.value}`, v.on_page ? h('span', { class: 'small', title: v.quote }, ' ✔ on the page') : null));
      cl.appendChild(h('fieldset', { class: 'card gr-char', 'data-testid': 'gr-u-char' }, h('legend', null, ch.name || 'New character'),
        h('div', { class: 'grid-2' }, inp(ch, 'name', 'Name'), sel(ch, 'story_role', 'Role in the story', ROLES.map(r => [r, r.replace('_', ' ')]))),
        inp(ch, 'about', 'Who they are', { area: 2 }),
        h('div', { class: 'grid-2' }, inp(ch, 'wants', 'What they want'), inp(ch, 'fear', 'What they fear'), inp(ch, 'secret', 'What they hide')),
        looks.length ? h('ul', { class: 'small plain-list' }, looks) : null,
        h('h4', null, '🗣 How they talk'),
        (ch.lines || []).length ? h('p', { class: 'small muted' }, 'Their lines in your chapters: ', (ch.lines || []).map(x => `“${x}”`).join(' · ')) : h('p', { class: 'small muted' }, 'They have no lines in your chapters yet.'),
        h('div', { class: 'grid-2' }, inp(ch.voice, 'rhythm', 'Rhythm'), inp(ch.voice, 'register', 'Register')),
        lines(ch.voice, 'samples', 'Sample lines'),
        h('button', { type: 'button', class: 'small', onclick: () => { u.characters.splice(i, 1); drawChars(); } }, '✖ Not a character')));
    });
  };
  drawChars();
  add(box, cl, h('button', { type: 'button', class: 'small', 'data-testid': 'gr-u-add-char', onclick: () => { u.characters = (u.characters || []).concat([{ name: '', story_role: 'supporting', looks: {}, voice: {} }]); drawChars(); } }, '➕ Add a character'));
  // places and world
  add(box, h('h3', null, '🗺 Places and the world'));
  const pl = h('div');
  const drawPlaces = () => { clear(pl); (u.places || []).forEach((p, i) => pl.appendChild(h('div', { class: 'grid-2' }, inp(p, 'name', `Place ${i + 1}`), inp(p, 'about', 'What it is')))); };
  drawPlaces();
  u.world = u.world || {};
  add(box, pl, h('button', { type: 'button', class: 'small', onclick: () => { u.places = (u.places || []).concat([{ name: '', about: '' }]); drawPlaces(); } }, '➕ Add a place'),
    h('div', { class: 'grid-2' }, inp(u.world, 'name', 'The world'), inp(u.world, 'about', 'What kind of world')));
  // rules and magic
  add(box, h('h3', null, '📏 Story rules and magic'),
    h('p', { class: 'small muted' }, 'A magic rule says exactly what each use needs (with numbers when it is used up), its limits, its price and who holds what now. Every new chapter is checked against it.'));
  const rl = h('div', { 'data-testid': 'gr-u-rules' });
  const drawRules = () => {
    clear(rl);
    (u.rules || []).forEach((r, i) => {
      const mg = r.magic;
      const kids = [h('div', { class: 'grid-2' }, sel(r, 'category', 'Kind of rule', RULE_CATS), inp(r, 'text', 'The rule')), inp(r, 'scope', 'Scope and limits')];
      if (mg) {
        kids.push(h('div', { class: 'gr-magic', 'data-testid': 'gr-u-magic' }, h('h4', null, `✨ ${mg.name || 'Magic'}`),
          h('div', { class: 'grid-2' }, inp(mg, 'name', 'Name'), inp(mg, 'does', 'What it does'), inp(mg, 'price', 'Price'), inp(mg, 'who', 'Who can use it'), inp(mg, 'start', 'Who holds what now')),
          lines(mg, 'requires', 'What it needs', 'gr-u-magic-needs'), lines(mg, 'limits', 'Limits')));
      } else kids.push(h('button', { type: 'button', class: 'small', onclick: () => { r.magic = { name: '', requires: [], limits: [] }; drawRules(); } }, '✨ This is magic: add its needs and limits'));
      kids.push(h('button', { type: 'button', class: 'small', onclick: () => { u.rules.splice(i, 1); drawRules(); } }, '✖ Remove'));
      rl.appendChild(h('fieldset', { class: 'card' }, h('legend', null, (RULE_CATS.find(x => x[0] === r.category) || ['', 'Rule'])[1]), kids));
    });
  };
  drawRules();
  add(box, rl, h('button', { type: 'button', class: 'small', onclick: () => { u.rules = (u.rules || []).concat([{ category: 'hard_rule', text: '', scope: '' }]); drawRules(); } }, '➕ Add a rule'),
    lines(u, 'open_threads', '❓ Questions your chapters leave open', 'gr-u-threads'));
  // style
  u.style = u.style || {};
  add(box, h('h3', null, '✒️ Your writing style'),
    u.numbers ? h('p', { class: 'small muted' }, `About ${u.numbers.avg_sentence || '?'} words per sentence · ${Math.round((u.numbers.dialogue_share || 0) * 100)}% dialogue · ${u.numbers.person || ''} person, ${u.numbers.tense || ''} tense`) : null,
    inp(u.style, 'voice_summary', 'Your voice', { area: 2, testid: 'gr-u-style' }), lines(u.style, 'do', 'Do'), lines(u.style, 'avoid', 'Avoid'));
  const save = h('button', { type: 'button', 'data-testid': 'gr-u-save' }, '💾 Save my changes');
  const use = h('button', { type: 'button', class: 'primary big', 'data-testid': 'gr-u-use' }, '✔ Use this');
  add(box, h('div', { class: 'form-actions' }, save, use));
  let version = st.understood_version;
  const doSave = async () => { const out = await api('PUT', bpath('/grow/understood'), { body: { understood: u, version } }); version = out.understood_version; return out; };
  save.addEventListener('click', async () => { clear(msg); save.disabled = true; try { await doSave(); toast('Your changes are saved'); } catch (e) { msg.appendChild(problemBox(toProblem(e, where))); } save.disabled = false; });
  use.addEventListener('click', async () => {
    clear(msg); use.disabled = true;
    try { await doSave(); const out = await api('POST', bpath('/grow/accept'), { body: { author_confirms: true } }); toast(out.message || 'Used'); reload(); }
    catch (e) { msg.appendChild(problemBox(toProblem(e, where))); use.disabled = false; }
  });
  void words;
}

function drawPlan(box, c, st, msg, reload) {
  const { h, clear, api, bpath, problemBox, toProblem, toast } = c;
  const where = { book: c.S.project && c.S.project.name, step: 'Your plan' };
  const p = JSON.parse(JSON.stringify(st.plan || {}));
  const yours = (st.chapters || []).length;
  const field = (obj, key, label, area, testid) => {
    const id = `gr-p-${key}-${Math.random().toString(36).slice(2, 7)}`;
    const el = h(area ? 'textarea' : 'input', { id, type: area ? null : 'text', rows: area ? String(area) : null, value: obj[key] || '', 'data-testid': testid || null });
    el.addEventListener('input', () => { obj[key] = el.value; });
    return h('div', { class: 'field' }, h('label', { for: id }, label), el);
  };
  add(box, h('h2', null, 'Your plan for the rest'),
    field(p, 'premise', 'Premise', 2), field(p, 'dramatic_question', 'The question the book answers'),
    field(p, 'main_plot', 'The main plot', 4, 'gr-p-plot'), field(p, 'ending', 'The ending', 2));
  const list = h('ol', { class: 'plain-list', 'data-testid': 'gr-p-chapters', start: String(yours + 1) });
  const draw = () => {
    clear(list);
    (p.chapters || []).forEach((ch, i) => list.appendChild(h('li', { 'data-testid': 'gr-p-chapter' },
      h('div', { class: 'grid-2' }, field(ch, 'title', `Chapter ${yours + i + 1}`), field(ch, 'pov', 'Told by')),
      field(ch, 'objective', 'What happens', 2),
      h('button', { type: 'button', class: 'small', onclick: () => { p.chapters.splice(i, 1); draw(); } }, '✖ Remove'))));
  };
  draw();
  add(box, h('h3', null, `Chapters ${yours + 1}–${yours + (p.chapters || []).length} (yours are 1–${yours})`), list,
    h('button', { type: 'button', class: 'small', onclick: () => { p.chapters = (p.chapters || []).concat([{ title: '', objective: '', pov: '', place: '' }]); draw(); } }, '➕ Add a chapter'));
  const use = h('button', { type: 'button', class: 'primary big', 'data-testid': 'gr-p-use' }, '✔ Use this plan');
  const again = h('button', { type: 'button', 'data-testid': 'gr-p-again' }, '🔁 Plan again');
  add(box, h('div', { class: 'form-actions' }, again, use));
  let version = st.plan_version;
  use.addEventListener('click', async () => {
    clear(msg); use.disabled = true;
    try {
      const s2 = await api('PUT', bpath('/grow/plan'), { body: { plan: p, version } }); version = s2.plan_version;
      const out = await api('POST', bpath('/grow/plan/use'), { body: { author_confirms: true } });
      toast(out.message || 'Plan used'); reload();
    } catch (e) { msg.appendChild(problemBox(toProblem(e, where))); use.disabled = false; }
  });
  again.addEventListener('click', async () => {
    clear(msg); again.disabled = true;
    const j = await c.runAiJob('/grow/plan', { target: st.target }, msg, 'Planning the rest of your book');
    again.disabled = false; if (j) reload();
  });
}
