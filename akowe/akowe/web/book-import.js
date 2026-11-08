// BACK BURNER (parked 2026-11-08 by the user's request): not loaded by the app; see docs/AKOWE_IMPROVEMENT_PLAN.md back-burner list.
// 📥 Bring in my book (book_import.py): the #/import page (choose a file or paste the text, check and adjust the
// chapters, bring the book in) and the imported book's page #/p/<pid>/<branch>/import (the Book Bible built from the
// text, then three offers: the three-AI checks, the originality report and ✍ Continue the book). app.js passes its
// helpers in (importUI()), so this module never reaches into app.js. All data is rendered with DOM APIs (never
// innerHTML with server data).

const ACCEPT = '.docx,.odt,.txt,.md,.markdown,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.oasis.opendocument.text';
const MAX_MB = 40;

function n(x) { return (x || 0).toLocaleString('en-US'); }

/* ======================================================================= #/import */
export function viewImport(main, c) {
  const { h, clear, api, crumbs, problemBox, toProblem } = c;
  const where = { step: 'Bring in my book' };
  main.appendChild(h('div', { class: 'page-head' }, h('div', null, crumbs(['My books', '#/'], 'Bring in my book'),
    h('h1', null, '📥 Bring in my book'))));
  const body = h('div', { 'aria-live': 'polite' });
  const file = h('input', { type: 'file', id: 'imp-file', accept: ACCEPT, 'data-testid': 'imp-file' });
  const paste = h('textarea', { id: 'imp-paste', rows: '8', 'data-testid': 'imp-paste', placeholder: 'Or paste the whole text of your book here…' });
  const msg = h('div', { 'aria-live': 'polite' });
  const readBtn = h('button', { type: 'button', class: 'primary big', 'data-testid': 'imp-read' }, '📖 Read my book');
  const card = h('section', { class: 'card', 'data-testid': 'imp-start', 'aria-labelledby': 'imp-h' },
    h('h2', { id: 'imp-h' }, 'Your book'),
    h('p', null, 'Bring in a book you already wrote. Akọwe reads it, finds the chapters and shows them to you before anything is made. Your chapters stay exactly as you wrote them — they are yours and approved.'),
    h('div', { class: 'field' }, h('label', { for: 'imp-file' }, 'A Word file (.docx), OpenDocument (.odt), text (.txt) or Markdown (.md) file'), file,
      h('span', { class: 'hint' }, `Up to ${MAX_MB} MB. Headings (“Chapter 1”, Heading 1 …) show Akọwe where chapters start.`)),
    h('div', { class: 'field' }, h('label', { for: 'imp-paste' }, 'Or paste the text'), paste),
    h('div', { class: 'row' }, readBtn), msg);
  main.appendChild(card);
  main.appendChild(body);
  readBtn.addEventListener('click', async () => {
    clear(msg);
    const f = file.files && file.files[0];
    if (!f && !paste.value.trim()) { msg.appendChild(h('p', { class: 'small words-warn' }, 'Choose a file or paste your text first.')); return; }
    if (f && f.size > MAX_MB * 1024 * 1024) { msg.appendChild(problemBox(toProblem({ code: 'IMPORT_TOO_LARGE', message: `the file is ${Math.round(f.size / 1048576)} MB` }, where))); return; }
    readBtn.disabled = true;
    msg.appendChild(c.loadingState('Reading your book…'));
    try {
      let d;
      if (f) {
        const buf = await f.arrayBuffer();
        const safe = f.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'book';
        d = await api('POST', '/import/read', { raw: buf, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': safe } });
      } else d = await api('POST', '/import/read', { body: { text: paste.value, name: 'pasted text' } });
      clear(msg);
      card.hidden = true;
      drawSplit(body, c, d);
    } catch (e) { clear(msg).appendChild(problemBox(toProblem(e, where))); }
    readBtn.disabled = false;
  });
}

function drawSplit(holder, c, d) {
  const { h, clear, api, problemBox, toProblem, toast } = c;
  const where = { step: 'Bring in my book' };
  clear(holder);
  const msg = h('div', { 'aria-live': 'polite' });
  const edit = async (op) => {
    clear(msg);
    try { const nd = await api('PUT', `/import/${encodeURIComponent(d.draft_id)}`, { body: op }); drawSplit(holder, c, Object.assign(nd, { _form: readForm() })); }
    catch (e) { msg.appendChild(problemBox(toProblem(e, where))); }
  };
  const f = d._form || {};
  const inp = (id, label, value, hint) => h('div', { class: 'field' }, h('label', { for: id }, label),
    h('input', { id, type: 'text', value: value || '', 'data-testid': id }), hint ? h('span', { class: 'hint' }, hint) : null);
  const form = h('div', { class: 'grid-2' },
    inp('imp-title', 'Book title', f.title != null ? f.title : d.title_guess),
    inp('imp-author', 'Author name', f.author || ''),
    inp('imp-hero', 'Main character', f.hero != null ? f.hero : (d.guess || {}).main_character, 'Akọwe’s guess from your text — change it if it is wrong.'),
    inp('imp-place', 'Main place', f.place != null ? f.place : (d.guess || {}).main_place, 'Where most of the story happens.'));
  function readForm() {
    const v = id => { const el = holder.querySelector(`#${id}`); return el ? el.value : undefined; };
    return { title: v('imp-title'), author: v('imp-author'), hero: v('imp-hero'), place: v('imp-place') };
  }
  const warn = (d.warnings || []).length ? h('div', { class: 'notice', 'data-testid': 'imp-warnings' }, h('ul', { class: 'small plain-list' }, d.warnings.map(w => h('li', null, '⚠️ ', w)))) : null;
  const rows = d.chapters.map((ch, i) => {
    const tick = h('input', { type: 'checkbox', checked: ch.include, 'aria-label': `Bring in ${ch.title}`, 'data-testid': 'imp-include', onchange: ev => edit({ op: 'include', index: i, include: ev.target.checked }) });
    const title = h('input', { type: 'text', value: ch.title, class: 'imp-title-in', 'aria-label': `Name of chapter ${i + 1}`, 'data-testid': 'imp-ch-title' });
    title.addEventListener('change', () => { if (title.value.trim() && title.value !== ch.title) edit({ op: 'rename', index: i, title: title.value }); });
    const splitBox = h('div', { class: 'imp-split', hidden: true });
    const splitBtn = h('button', { type: 'button', class: 'small', 'data-testid': 'imp-split', disabled: ch.paragraphs < 2, onclick: async () => {
      if (!splitBox.hidden) { splitBox.hidden = true; return; }
      clear(splitBox).appendChild(c.loadingState('Loading the paragraphs…'));
      splitBox.hidden = false;
      try {
        const ps = await api('GET', `/import/${encodeURIComponent(d.draft_id)}/chapter/${i}`);
        const sel = h('select', { 'aria-label': 'The new chapter starts with', 'data-testid': 'imp-split-at' }, ps.paragraphs.slice(1).map(p => h('option', { value: String(p.at) }, `¶ ${p.at + 1}: ${p.start}`)));
        const name = h('input', { type: 'text', placeholder: 'Name of the new chapter', 'aria-label': 'Name of the new chapter', 'data-testid': 'imp-split-title' });
        clear(splitBox).appendChild(h('div', { class: 'row' }, h('span', { class: 'small' }, 'New chapter starts at'), sel, name,
          h('button', { type: 'button', class: 'small primary', 'data-testid': 'imp-split-go', onclick: () => edit({ op: 'split', index: i, at: parseInt(sel.value, 10), title: name.value || undefined }) }, '✂ Split here')));
      } catch (e) { clear(splitBox).appendChild(problemBox(toProblem(e, where))); }
    } }, '✂ Split…');
    const mergeBtn = i + 1 < d.chapters.length ? h('button', { type: 'button', class: 'small', 'data-testid': 'imp-merge', onclick: () => edit({ op: 'merge', index: i }) }, '⤓ Join with the next') : null;
    return h('li', { class: `imp-ch${ch.include ? '' : ' muted'}`, 'data-testid': 'imp-chapter' },
      h('div', { class: 'row' }, tick, h('strong', null, `${i + 1}.`), title, h('span', { class: 'small muted' }, `${n(ch.words)} words · ${ch.how}`)),
      ch.part ? h('p', { class: 'small muted' }, `In: ${ch.part}`) : null,
      h('p', { class: 'small imp-preview' }, ch.preview),
      h('div', { class: 'row' }, mergeBtn, splitBtn), splitBox);
  });
  const go = h('button', { type: 'button', class: 'primary big', 'data-testid': 'imp-create' }, `📥 Bring in ${d.chapter_count} chapter${d.chapter_count === 1 ? '' : 's'}`);
  go.disabled = !d.chapter_count;
  go.addEventListener('click', async () => {
    const v = readForm();
    if (!(v.title || '').trim()) { clear(msg).appendChild(h('p', { class: 'small words-warn' }, 'Give the book a title first.')); return; }
    go.disabled = true;
    clear(msg).appendChild(c.loadingState(`Making your book (${d.chapter_count} chapters)…`));
    try {
      const out = await api('POST', `/import/${encodeURIComponent(d.draft_id)}/create`, { body: { author_confirms: true, title: v.title, author: v.author, main_character: v.hero, main_place: v.place } });
      toast(out.message);
      if (c.loadProjects) { try { await c.loadProjects(); } catch { /* the list reloads on the next page */ } }
      c.go(c.link('p', out.project_id, out.branch_id || 'main', 'import'));
    } catch (e) { clear(msg).appendChild(problemBox(toProblem(e, where))); go.disabled = false; }
  });
  holder.appendChild(h('section', { class: 'card', 'data-testid': 'imp-split-card', 'aria-labelledby': 'imp-s-h' },
    h('h2', { id: 'imp-s-h' }, `Akọwe found ${d.chapter_count} chapter${d.chapter_count === 1 ? '' : 's'} (${n(d.words)} words)`),
    h('p', { class: 'small' }, `From your ${d.kind_words || 'file'} “${d.name}”. Check the chapters below: rename them, join two, split one at a paragraph, or untick what should stay out. Nothing is made until you press the button at the bottom.`),
    form, warn, h('ol', { class: 'plain-list imp-list' }, rows),
    h('p', { class: 'small muted', 'data-testid': 'imp-estimate' }, `After this, the AI reads your book to build the Book Bible: about ${n(d.ai_calls.total)} AI calls (one per chapter, one per main character, one for the rules). You start it on the next page; it can stop and go on.`),
    msg, h('div', { class: 'row' }, go, h('a', { class: 'btn', href: '#/import', onclick: () => api('DELETE', `/import/${encodeURIComponent(d.draft_id)}`).catch(() => {}) }, 'Start again'))));
}

/* ======================================================================= #/p/<pid>/<branch>/import */
export function viewImported(main, c) {
  const { h, clear, api, bpath, plink, crumbs, problemBox, toProblem, S } = c;
  const where = { book: S.project && S.project.name, step: 'Your brought-in book' };
  main.appendChild(h('div', { class: 'page-head' }, h('div', null, crumbs(['My books', '#/'], [S.project.name, plink('book')], 'Your brought-in book'),
    h('h1', null, '📥 Your brought-in book'))));
  const holder = h('div', { 'aria-live': 'polite' }, c.loadingState('Loading…'));
  main.appendChild(holder);
  let timer = null;
  const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  S.leaveHooks.push(stopTimer);
  const load = async () => {
    stopTimer();
    let st;
    try { st = await api('GET', bpath('/import')); } catch (e) { clear(holder).appendChild(problemBox(toProblem(e, where), { retry: load })); return; }
    if (!holder.isConnected) return;
    draw(st);
    if ((st.bible || {}).running || (st.create || {}).running) timer = setTimeout(load, 1500);
  };
  const draw = st => {
    clear(holder);
    if (!st.imported) { holder.appendChild(c.stateBox('empty', 'This book was not brought in', h('p', null, 'Only books brought in with 📥 Bring in my book have this page. ', h('a', { href: '#/import' }, '📥 Bring in a book')))); return; }
    const cr = st.create || {};
    if (cr.status && cr.status !== 'done') {  // the chapters are still being stored (a big book takes minutes)
      const pct = cr.total ? Math.round(100 * (cr.done || 0) / cr.total) : 0;
      const msg = h('div', { 'aria-live': 'polite' });
      const card = h('section', { class: 'card', 'data-testid': 'imp-creating', 'data-state': cr.running ? 'running' : cr.status }, h('h2', null, `Bringing in “${st.title || st.source}”`),
        h('p', null, cr.running ? `⏳ Storing your chapters: ${cr.done || 0} of ${cr.total}. You can leave this page: it keeps going.` : (cr.message || 'Stopped.')),
        h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Chapters brought in' }, h('div', { class: 'bar', style: `width:${pct}%` })), msg);
      if (!cr.running) card.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', 'data-testid': 'imp-create-resume', onclick: async () => {
        try { await api('POST', bpath('/import/create/resume')); load(); } catch (e) { clear(msg).appendChild(problemBox(toProblem(e, where))); }
      } }, '▶ Go on')));
      holder.appendChild(card);
      return;
    }
    holder.appendChild(h('section', { class: 'card', 'data-testid': 'imp-done' }, h('h2', null, 'Your book is in'),
      h('p', null, `${st.chapters.length} chapters, about ${n(st.words)} words, from your ${st.kind_words || 'file'} “${st.source}”. Every chapter is your own approved text: Akọwe never rewrites it without asking.`),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: plink('book') }, '🏠 Book home'), h('a', { class: 'btn', href: plink('bible') }, '📖 Book Bible'), h('a', { class: 'btn', href: plink('notes'), 'data-testid': 'imp-notes-link' }, '📝 Fix it with my notes'))));
    holder.appendChild(bibleCard(c, st, load));
    holder.appendChild(h('h2', { class: 'section-h' }, 'What next?'));
    holder.appendChild(h('p', { class: 'small' }, 'Three things Akọwe can do with your book. Each only suggests: nothing in your chapters changes unless you say so.'));
    if (c.checkNowBox) {
      const box = c.checkNowBox(c, S.pid, S.branch, { testid: 'imp-check-now' });
      const sel = box.querySelector('select');
      if (sel) { sel.value = 'all'; sel.dispatchEvent(new Event('change')); }
      holder.appendChild(h('section', { class: 'card', 'data-testid': 'imp-offer-checks' }, h('h3', null, '🔎 (a) Have three AIs check your chapters'),
        h('p', { class: 'small' }, 'Every working AI reads your chapters for mistakes: names, days, injuries, things that contradict each other. What they find is a suggestion you use or not.'), box));
    }
    if (c.originalityCard) holder.appendChild(h('div', { 'data-testid': 'imp-offer-orig' }, h('h3', null, '✨ (b) Does it sound like AI? Is it original?'), c.originalityCard(c)));
    holder.appendChild(continueCard(c, st, load));
  };
  load();
}

function bibleCard(c, st, reload) {
  const { h, clear, api, bpath, plink, problemBox, toProblem } = c;
  const b = st.bible || {};
  const where = { step: 'Build the Book Bible' };
  const msg = h('div', { 'aria-live': 'polite' });
  const card = h('section', { class: 'card', 'data-testid': 'imp-bible', 'data-state': b.running ? 'running' : (b.status || 'idle') }, h('h2', null, '📖 Build the Book Bible from your text'));
  const start = async (again) => {
    clear(msg);
    try { await api('POST', bpath('/import/bible'), { body: again ? { again: true } : {} }); reload(); }
    catch (e) { msg.appendChild(problemBox(toProblem(e, where))); }
  };
  const est = st.estimate || {};
  if (b.running) {
    const p = b.progress || {};
    const pct = p.total ? Math.round(100 * p.done / p.total) : 0;
    card.appendChild(h('p', { 'data-testid': 'imp-bible-msg' }, '⏳ ', b.message || 'Working…'));
    card.appendChild(h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Chapters read' }, h('div', { class: 'bar', style: `width:${pct}%` })));
    card.appendChild(h('p', { class: 'small muted' }, `${p.done || 0} of ${p.total || st.chapters.length} chapters read · ${b.calls || 0} AI calls so far. You can leave this page: it keeps going.`));
    card.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', 'data-testid': 'imp-bible-stop', onclick: async () => { try { await api('POST', bpath('/import/bible/stop')); reload(); } catch (e) { msg.appendChild(problemBox(toProblem(e, where))); } } }, '■ Stop')));
  } else if (!b.status || b.status === 'idle') {
    card.appendChild(h('p', null, 'The AI reads your book chapter by chapter and writes down who is in it (looks, voice, relationships), the places, things and groups, the rules of your world, the timeline, the running notes and the story map. Everything it writes is a draft you approve — except details that are clearly on your pages, which are locked so later chapters keep them.'));
    card.appendChild(h('p', { class: 'small muted' }, `About ${n(est.total)} AI calls: ${n(est.chapters)} to read the chapters, up to ${n(est.characters)} for the main characters, 1 for the rules. It can stop and go on.`));
    card.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary big', 'data-testid': 'imp-bible-start', onclick: () => start(false) }, '▶ Build the Book Bible')));
  } else {
    if (b.message) card.appendChild(h('p', { 'data-testid': 'imp-bible-msg', class: b.status === 'done' ? '' : 'words-warn' }, b.message));
    const s = b.summary;
    if (s && b.status === 'done') {
      card.appendChild(h('ul', { class: 'small plain-list', 'data-testid': 'imp-bible-summary' },
        h('li', null, `🧭 ${s.chapters_read} chapters read${s.weak ? ` (${s.weak} only by Akọwe: no AI was free)` : ''}, ${s.timeline} with a time in the timeline`),
        h('li', null, `🎭 ${s.characters} new characters, ${s.places} places, ${s.items} items${s.groups ? `, ${s.groups} groups` : ''}`),
        h('li', null, `🗂 ${s.details_proposed} details about the characters (${s.details_locked} 🔒 on your pages)`),
        h('li', null, `🗺 ${s.links} story-map connections (${s.links_locked} 🔒 on your pages)`),
        s.rules ? h('li', null, `📏 ${s.rules} story rules proposed (accept them on 📏 Story rules)`) : null,
        s.flags ? h('li', null, `⚠️ ${s.flags} possible slips Akọwe noticed (see 🧭 Continuity)`) : null));
      card.appendChild(h('div', { class: 'row' }, h('a', { class: 'btn', href: plink('bible') }, '📖 Book Bible'), h('a', { class: 'btn', href: plink('storymap') }, '🗺 Story map'),
        h('a', { class: 'btn', href: plink('world') }, '📏 Story rules'), h('a', { class: 'btn', href: plink('continuity') }, '🧭 Continuity'),
        h('a', { class: 'btn', href: plink('review') }, '✔ Waiting for your OK')));
    }
    const label = b.status === 'done' ? ((b.read_weak || []).length ? '▶ Read the rest with an AI' : '↻ Build it again') : '▶ Go on';
    card.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', class: b.status === 'done' ? '' : 'primary', 'data-testid': 'imp-bible-go', onclick: () => start(b.status === 'done' && !(b.read_weak || []).length) }, label)));
  }
  card.appendChild(msg);
  return card;
}

function continueCard(c, st, reload) {
  const { h, clear, api, bpath, plink, problemBox, toProblem, toast, choiceDialog } = c;
  const where = { step: 'Continue the book' };
  const msg = h('div', { 'aria-live': 'polite' });
  const card = h('section', { class: 'card', 'data-testid': 'imp-offer-continue' }, h('h3', null, '✍ (c) Continue the book'),
    h('p', { class: 'small' }, `Plan the chapters after your chapter ${st.chapters.length} and let the AI write them in your own style. Each new chapter waits for your OK.`));
  const sty = st.style || {};
  const styleBtn = h('button', { type: 'button', 'data-testid': 'imp-style', disabled: sty.book_on, onclick: async () => {
    let replace = false;
    if (sty.has_samples) {
      const ok = await choiceDialog('Use your chapters as your style samples?', 'You already have samples on ✒️ My writing style. Akọwe would replace them with passages of the chapters you brought in.', [{ id: 'yes', label: 'Yes, use my chapters' }]);
      if (ok !== 'yes') return;
      replace = true;
    }
    styleBtn.disabled = true;
    try { const out = await api('POST', bpath('/import/style'), { body: { author_confirms: true, replace } }); toast(out.message); reload(); }
    catch (e) { clear(msg).appendChild(problemBox(toProblem(e, where))); styleBtn.disabled = false; }
  } }, sty.book_on ? '✔ This book writes in your style' : '✒️ Learn my style from my chapters');
  card.appendChild(h('div', { class: 'row' }, styleBtn, h('span', { class: 'small muted' }, 'Akọwe takes passages of your chapters as samples of your writing (only with your OK).')));
  if (st.continued) {
    card.appendChild(h('p', { 'data-testid': 'imp-continued' }, `The chapter list goes to chapter ${st.continued.to}. `));
    const wa = h('button', { type: 'button', class: 'primary', 'data-testid': 'imp-write-all', onclick: async () => {
      wa.disabled = true;
      try { await api('POST', bpath('/book/write-all')); toast('The AI is writing the new chapters: each waits for your OK.'); c.go(plink('book')); }
      catch (e) { clear(msg).appendChild(problemBox(toProblem(e, where))); wa.disabled = false; }
    } }, '✍ Write the new chapters');
    card.appendChild(h('div', { class: 'row' }, wa, h('a', { class: 'btn', href: plink('book') }, '🏠 Book home')));
  }
  if (st.plan && (st.plan.chapters || []).length) {
    const items = st.plan.chapters.map((p, i) => {
      const t = h('input', { type: 'text', value: p.title, 'aria-label': `Title of new chapter ${st.plan.from + i}`, 'data-testid': 'imp-plan-title' });
      const o = h('textarea', { rows: '2', 'aria-label': `What happens in new chapter ${st.plan.from + i}`, 'data-testid': 'imp-plan-obj' }, p.objective);
      return { el: h('li', null, h('strong', null, `Chapter ${st.plan.from + i}`), t, o), t, o };
    });
    const use = h('button', { type: 'button', class: 'primary', 'data-testid': 'imp-plan-use', onclick: async () => {
      use.disabled = true;
      try {
        const out = await api('POST', bpath('/import/continue/use'), { body: { author_confirms: true, chapters: items.map(x => ({ title: x.t.value, objective: x.o.value })) } });
        toast(out.message); reload();
      } catch (e) { clear(msg).appendChild(problemBox(toProblem(e, where))); use.disabled = false; }
    } }, '✔ Use this plan');
    card.appendChild(h('div', { 'data-testid': 'imp-plan' }, h('p', { class: 'small' }, 'The AI’s plan — change anything, then use it:'), h('ol', { class: 'plain-list imp-plan' }, items.map(x => x.el)), h('div', { class: 'row' }, use)));
  }
  const howMany = h('input', { type: 'number', min: '1', max: '30', value: '5', class: 'num', id: 'imp-more', 'data-testid': 'imp-more' });
  const note = h('textarea', { rows: '2', id: 'imp-more-note', 'data-testid': 'imp-more-note', placeholder: 'Optional: where should the story go? (“Mara finds out who the stranger was”)' });
  const plan = h('button', { type: 'button', 'data-testid': 'imp-plan-start', onclick: async () => {
    plan.disabled = true;
    clear(msg).appendChild(c.loadingState('The AI is planning the next chapters…'));
    try {
      const j = await api('POST', bpath('/import/continue/plan'), { body: { chapters: parseInt(howMany.value, 10) || 5, note: note.value || undefined } });
      const end = await c.pollQualityJob(bpath(`/review/ai/${encodeURIComponent(j.job_id)}`), msg);
      if (end.status !== 'done') { clear(msg).appendChild(problemBox({ code: (end.error || {}).code || 'IMPORT_FAILED', message: (end.error || {}).message || end.phase, where })); plan.disabled = false; return; }
      reload();
    } catch (e) { clear(msg).appendChild(problemBox(toProblem(e, where))); plan.disabled = false; }
  } }, '🧭 Plan the next chapters');
  card.appendChild(h('div', { class: 'row' }, h('label', { for: 'imp-more' }, 'How many new chapters'), howMany));
  card.appendChild(h('div', { class: 'field' }, h('label', { for: 'imp-more-note' }, 'Your wishes for the story (optional)'), note));
  card.appendChild(h('div', { class: 'row' }, plan));
  card.appendChild(msg);
  return card;
}
