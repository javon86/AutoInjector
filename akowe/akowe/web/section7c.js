// Section 7c of the improvement plan: 📖 P23 beta reader (a card on the 📊 report page) and ✒️ P25 your writing
// style (the #/style page and the per-book switch). app.js passes its helpers in (s7c()), so this module never
// reaches into app.js. All data is rendered with DOM APIs (never innerHTML with server data).

const KIND_WORD = { confused: '😕 Confused', bored: '🥱 Bored', guessed: '🔮 Guessed it', hooked: '🪝 Hooked', moved: '💗 Moved', doubted: '🤨 Didn’t believe it' };
const SEV = { major: '⚠️ ', minor: '', info: 'ⓘ ' };

/* ======================================================================= ⚡ Make a book: two optional switches */
export async function makeSetupExtras(c) {
  const { h } = c;
  let card = null;
  try { card = (await c.api('GET', '/style-card')).card; } catch { card = null; }
  const hasCard = !!(card && card.stats && card.stats.words);
  const beta = h('input', { type: 'checkbox', id: 'mb-beta', 'data-testid': 'mb-beta' });
  // 👥 idea #14: one reader (as before) or a panel of 2-3 readers, each a different AI
  const count = h('select', { id: 'mb-beta-n', 'data-testid': 'mb-beta-n', 'aria-label': 'How many beta readers', onchange: () => { if (count.value !== '1') beta.checked = true; } },
    h('option', { value: '1' }, '1 reader'), h('option', { value: '2' }, '2 readers (a panel)'), h('option', { value: '3' }, '3 readers (a panel)'));
  const style = h('input', { type: 'checkbox', id: 'mb-style', 'data-testid': 'mb-style', disabled: !hasCard, checked: hasCard });
  const el = h('fieldset', { class: 'field s7-make' }, h('legend', null, 'Extras (optional)'),
    h('div', { class: 'check-row' }, beta, h('label', { for: 'mb-beta' }, h('strong', null, '📖 Beta reader at the end'),
      h('span', { class: 'hint' }, ' — another AI reads the finished book as its target reader and marks where it got confused, bored or guessed a twist (one extra AI answer per reader). With 2 or 3 readers, each is a different AI playing a different kind of reader, and Akọwe shows where they agree.')),
      h('label', { class: 'small', for: 'mb-beta-n' }, ' How many: '), count),
    h('div', { class: 'check-row' }, style, h('label', { for: 'mb-style' }, h('strong', null, '✒️ Write in my style'),
      h('span', { class: 'hint' }, hasCard ? ' — the narration follows your style card (✒️ My writing style).' : ' — make your style card first: ',
        hasCard ? null : h('a', { href: '#/style' }, '✒️ My writing style')))));
  return { el, apply(body) {
    if (beta.checked) { body.beta_reader = true; if (count.value !== '1') body.beta_readers = Number(count.value); }
    if (style.checked && !style.disabled) body.my_style = true;
  } };
}

/* ======================================================================= 📖 P23 beta reader card (report page) */
export function betaCard(c) {
  const { h, clear } = c;
  const body = h('div', { 'aria-live': 'polite' }, c.loadingState('Loading the beta reader…'));
  const sec = h('section', { class: 'card s7-beta', 'data-testid': 'beta-card', 'aria-labelledby': 'beta-h' },
    h('h2', { id: 'beta-h' }, '📖 Beta readers'), body);
  const load = async () => {
    let ov;
    try { ov = await c.api('GET', c.bpath('/beta')); } catch (e) { clear(body).appendChild(c.problemBox(c.toProblem(e, { step: 'Beta reader' }), { retry: load })); return; }
    draw(ov);
  };
  const ask = async (req, btn, prog) => {
    btn.disabled = true;
    try {
      const j = await c.api('POST', c.bpath('/beta'), { body: req });
      const end = await c.pollQualityJob(c.bpath(`/beta/job/${encodeURIComponent(j.id)}`), prog);
      if (end.status !== 'done') { clear(prog).appendChild(c.problemBox({ code: (end.error || {}).code || 'BETA_FAILED', message: (end.error || {}).message || end.phase, where: { step: 'Beta reader' } }, { retry: () => ask(req, btn, prog) })); btn.disabled = false; return; }
      const msg = (j.size || 1) > 1 ? 'The beta readers have finished' : 'The beta reader has finished';
      c.toast(msg); c.announce(msg);
      await load();
    } catch (e) { clear(prog).appendChild(c.problemBox(c.toProblem(e, { step: 'Beta reader' }))); btn.disabled = false; }
  };
  function setupForm(ov, r, prog) {
    // 👥 idea #14: how many readers (1-3), and per reader the AI and who it plays (editable, with a default)
    const panel = ov.panel || { size: 1, max: 3, readers: [] };
    const readers = (ov.readers || []).filter(o => o.working);
    const size = h('select', { id: 'beta-size', 'data-testid': 'beta-size', 'aria-label': 'How many beta readers' },
      [1, 2, 3].map(n => h('option', { value: String(n), selected: n === panel.size }, n === 1 ? '1 reader' : `${n} readers (a panel)`)));
    const rows = (panel.readers || []).map((p, i) => {
      const sel = h('select', { id: i === 0 ? 'beta-slot' : `beta-slot-${i + 1}`, 'data-testid': `beta-slot-${i + 1}`, 'aria-label': `Which AI is reader ${i + 1}` },
        h('option', { value: '' }, 'Automatic — an AI that did not write the book'),
        readers.map(o => h('option', { value: o.slot_id, selected: o.slot_id === p.slot_id }, `${o.name}${o.wrote_most ? ' (wrote most of it ⚠️)' : ''}`)));
      const txt = h('textarea', { rows: '2', maxlength: '600', 'data-testid': `beta-persona-${i + 1}`, 'aria-label': `Who reader ${i + 1} is` });
      txt.value = p.persona || p.default || '';
      const reset = h('button', { type: 'button', class: 'small', onclick: () => { txt.value = p.default || ''; } }, '↺ Default');
      const row = h('div', { class: 's7-reader', 'data-testid': `beta-reader-${i + 1}` },
        h('div', { class: 'row' }, h('strong', null, `Reader ${i + 1}`), h('span', { class: 'small muted' }, ` — ${p.persona ? 'your description' : `by default ${p.label}`}`), sel, reset), txt);
      return { row, sel, txt, p };
    });
    const show = () => { const n = Number(size.value); rows.forEach((x, i) => { x.row.hidden = i >= n; }); btn.textContent = label(); };
    const label = () => {
      const n = Number(size.value);
      if (n === 1) return r ? '📖 Ask the beta reader again' : '📖 Ask a beta reader';
      return `👥 Ask the panel of ${n} readers`;
    };
    const req = () => {
      const n = Number(size.value);
      return { size: n, readers: rows.slice(0, n).map(x => ({ slot_id: x.sel.value || null, persona: x.txt.value.trim() && x.txt.value.trim() !== (x.p.default || '').trim() ? x.txt.value.trim() : null })) };
    };
    const btn = h('button', { type: 'button', class: r ? '' : 'primary', 'data-testid': 'beta-ask', disabled: !ov.written, onclick: () => ask(req(), btn, prog) }, '');
    size.addEventListener('change', show);
    const form = h('div', { class: 's7-panel-setup', 'data-testid': 'beta-setup' },
      h('div', { class: 'row' }, h('label', { for: 'beta-size' }, 'How many readers: '), size, btn),
      // who the readers are: open until a read exists, then folded (the panel's answers are what you came for)
      h('details', { class: 's7-who', open: !r, 'data-testid': 'beta-who-edit' }, h('summary', null, '✏️ Who the readers are (change them)'),
        h('p', { class: 'small muted' }, 'Each reader is a different AI playing a different kind of reader. You can change who they are. An AI that is not working is skipped with a note.'),
        rows.map(x => x.row)));
    show();
    return form;
  }
  function draw(ov) {
    clear(body);
    const r = ov.latest;
    body.appendChild(h('p', { class: 'small' }, `An AI reads the whole book as ${ov.persona ? (ov.persona.a_label || `a ${ov.persona.label}`) : 'its target reader'} — for pleasure, not as an editor — and marks where it got confused, bored or guessed a twist. Ask up to three readers to see where they agree. Every quote is checked against the book. They never see your outline or story rules.`));
    const prog = h('div', { class: 'rp-progress' });
    body.appendChild(setupForm(ov, r, prog));
    if (ov.can_resume && r) {
      const go = h('button', { type: 'button', 'data-testid': 'beta-resume', onclick: () => ask({ resume: r.id }, go, prog) }, '▶ Continue the panel');
      body.appendChild(h('p', { class: 'small words-warn', role: 'note' }, `⚠️ The last panel stopped after ${(r.readers || []).length} of ${(r.plan || []).length} readers. `, go));
    }
    body.appendChild(prog);
    if (ov.job) c.pollQualityJob(c.bpath(`/beta/job/${encodeURIComponent(ov.job.id)}`), prog).then(load).catch(() => {});
    if (!r) { body.appendChild(h('p', { class: 'small muted' }, 'No beta read yet.')); return; }
    if (ov.stale) body.appendChild(h('p', { class: 'words-warn small', role: 'note' }, '⚠️ This read is for an earlier version of the book: a chapter changed since.'));
    if (r.kind === 'panel') { drawPanel(r); return; }
    if (r.status !== 'done') {
      body.appendChild(c.problemBox({ code: r.error || 'BETA_FAILED', message: r.message || 'The beta reader could not read the book.', where: { step: 'Beta reader' } }));
      return;
    }
    drawRead(r, body, true);
  }
  function drawRead(r, into, withWho) {
    const rd = r.reader || {};
    if (withWho) {
      into.appendChild(h('p', { class: 'small', 'data-testid': 'beta-who' }, h('strong', null, rd.name || 'An AI'), ` read it as ${r.persona.a_label || `a ${r.persona.label}`} ·${fmt(c, r.at)}`,
        rd.independent ? '' : h('span', { class: 'words-warn' }, ' ⚠️ not independent (it wrote most of the book)'),
        r.average_interest != null ? ` · interest ${r.average_interest}/10 on average` : '',
        r.overall && r.overall.score ? ` · score ${r.overall.score}/10` : '',
        r.stop && !r.stop.would_finish ? h('span', { class: 'words-warn' }, ` · ⚠️ would stop${r.stop.chapter ? ` in chapter ${r.stop.chapter}` : ''}`) : ' · would finish the book'));
    }
    if (r.summary) into.appendChild(h('blockquote', { class: 's7-say' }, r.summary));
    into.appendChild((r.findings || []).length
      ? h('ul', { class: 'small', 'data-testid': 'beta-findings' }, r.findings.map(f => h('li', null, `${SEV[f.severity] || ''}${f.label}: ${f.detail} `, h('span', { class: 'muted' }, f.advice))))
      : h('p', { class: 'small' }, '✔ The reader did not get lost, bored or ahead of the story.'));
    const interest = r.interest || [];
    if (interest.length) {
      into.appendChild(h('div', { class: 's7-meter', role: 'img', 'aria-label': `Interest per chapter: ${interest.map(i => `chapter ${i.chapter} ${i.score}`).join(', ')}` },
        interest.map(i => h('span', { class: `s7-bar${i.score <= 5 ? ' low' : ''}`, title: `Chapter ${i.chapter}: ${i.score}/10${i.would_keep_reading ? '' : ' — would not turn the page'}`, style: `height:${8 + i.score * 4}px` }, String(i.chapter)))));
    }
    if ((r.reactions || []).length) {
      into.appendChild(h('details', { 'data-testid': 'beta-reactions' }, h('summary', null, `What the reader felt, chapter by chapter (${r.reactions.length})`),
        h('ul', { class: 'small' }, r.reactions.slice().sort((a, b) => a.chapter - b.chapter).map(x => h('li', null, h('strong', null, `Chapter ${x.chapter} · ${KIND_WORD[x.kind] || x.kind}`), ': ', x.note, quote(x))))));
    }
    if ((r.guesses || []).length) {
      into.appendChild(h('details', null, h('summary', null, `What the reader guessed (${r.guesses.length})`),
        h('ul', { class: 'small' }, r.guesses.map(g => h('li', null, `🔮 “${g.guess}” — guessed in chapter ${g.guessed_in_chapter}`,
          g.revealed_in_chapter ? `, revealed in chapter ${g.revealed_in_chapter}` : ', never revealed', ` · came true: ${g.came_true}`, quote(g))))));
    }
  }
  const quote = x => x.quote ? [' — ', h('q', null, x.quote), x.verified ? (x.in_chapter ? null : h('span', { class: 'small muted' }, ' (found in another chapter)')) : [' ', c.hazard({ code: 'QUOTE_NOT_FOUND' }, {}, { small: true })]] : null;
  const yes = v => v == null ? '–' : v ? '✔ yes' : '✖ no';
  function drawPanel(r) {
    const cmp = r.comparison || {};
    const wrap = h('div', { 'data-testid': 'beta-panel' });
    body.appendChild(wrap);
    if (r.status === 'incomplete') wrap.appendChild(h('p', { class: 'small muted' }, `Reading… ${(r.readers || []).length} of ${(r.plan || []).length} readers have finished.`));
    if ((r.skipped || []).length) {
      wrap.appendChild(h('ul', { class: 'small', 'data-testid': 'beta-skipped' }, r.skipped.map(s => h('li', { class: 'words-warn' },
        `⚠️ Reader ${s.n} (${(s.persona || {}).label || 'reader'}) was skipped: ${s.why}`))));
    }
    if (r.status === 'failed') {
      wrap.appendChild(c.problemBox({ code: r.error || 'BETA_FAILED', message: r.message || 'No beta reader could read the book.', where: { step: 'Beta reader' } }));
      return;
    }
    if (r.status !== 'done') return;
    wrap.appendChild(h('p', { 'data-testid': 'beta-headline' }, h('strong', null, '👥 ' + (cmp.headline || '')), h('span', { class: 'small muted' }, ` ·${fmt(c, r.at)}`)));
    const vs = cmp.verdicts || [];
    wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'small s7-verdicts', 'data-testid': 'beta-verdicts' },
      h('caption', { class: 'visually-hidden' }, 'What each reader thought'),
      h('thead', null, h('tr', null, ['Reader', 'Read it as', 'Score', 'Would finish', 'Would recommend', 'Favourite character', 'Best chapter', 'Worst chapter'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', null, vs.map(v => h('tr', null, h('th', { scope: 'row' }, v.name, v.independent === false ? h('span', { class: 'words-warn', title: 'It wrote most of the book' }, ' ⚠️') : ''),
        h('td', null, v.label), h('td', { class: 'num' }, v.score ? `${v.score}/10` : '–'), h('td', null, yes(v.would_finish)), h('td', null, yes(v.would_recommend)),
        h('td', null, v.favourite || '–', v.favourite && v.favourite_in_book === false ? h('span', { class: 'small muted' }, ' (not a name in the book)') : ''),
        h('td', { class: 'num' }, v.best ? String(v.best) : '–'), h('td', { class: 'num' }, v.worst ? String(v.worst) : '–')))))));
    const strong = (cmp.agree || []).filter(g => !g.positive);
    const loved = (cmp.agree || []).filter(g => g.positive);
    const sample = g => { const q = (g.quotes || []).find(x => x.quote && x.verified !== false) || (g.quotes || []).find(x => x.quote); return q ? [' — ', h('q', null, q.quote), h('span', { class: 'muted' }, ` (${q.reader})${q.verified === false ? ' (not found word for word)' : ''}`)] : null; };
    wrap.appendChild(h('h3', null, 'Where the readers agree'));
    wrap.appendChild(strong.length || loved.length
      ? h('ul', { class: 'small', 'data-testid': 'beta-agree' },
        strong.map(g => h('li', null, h('strong', { class: 'words-warn' }, '💪 Strong signal: '), g.text, ` (${g.names.join(', ')})`, sample(g))),
        loved.map(g => h('li', null, '💚 ', g.text, ` (${g.names.join(', ')})`, sample(g))))
      : h('p', { class: 'small', 'data-testid': 'beta-agree' }, 'The readers did not flag the same chapter for the same thing.'));
    wrap.appendChild(h('h3', null, 'Where they disagree'));
    wrap.appendChild((cmp.disagree || []).length
      ? h('ul', { class: 'small', 'data-testid': 'beta-disagree' }, cmp.disagree.map(d => h('li', null, d.text)))
      : h('p', { class: 'small', 'data-testid': 'beta-disagree' }, 'No real disagreement.'));
    const heat = cmp.heat || [];
    if (heat.length) {
      const n = vs.length || 1;
      const cell = (k, label) => h('td', { class: `num s7-heat-${Math.min(3, Math.round(3 * k / n))}`, title: `${k} of ${n} readers ${label}` }, k ? `${k}/${n}` : '');
      wrap.appendChild(h('h3', null, 'Chapter by chapter'));
      wrap.appendChild(h('p', { class: 'small muted' }, 'How many readers got lost or bored in each chapter (darker = more readers), and each reader’s interest out of 10.'));
      wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'small s7-heat', 'data-testid': 'beta-heat' },
        h('caption', { class: 'visually-hidden' }, 'Lost and bored readers per chapter'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Chapter'), heat.map(x => h('th', { scope: 'col', class: 'num' }, String(x.chapter))))),
        h('tbody', null,
          h('tr', null, h('th', { scope: 'row' }, '😕 Got lost'), heat.map(x => cell(x.confused, 'got lost'))),
          h('tr', null, h('th', { scope: 'row' }, '🥱 Bored or slow'), heat.map(x => cell(x.bored, 'lost interest'))),
          vs.map((v, i) => h('tr', null, h('th', { scope: 'row', class: 'muted' }, `${v.name}: interest`),
            heat.map(x => { const s = (x.cells[i] || {}).interest; return h('td', { class: `num${s != null && s <= 5 ? ' words-warn' : ''}` }, s == null ? '–' : String(s)); })))))));
    }
    wrap.appendChild(h('h3', null, 'What to fix first'));
    wrap.appendChild((cmp.fixes || []).length
      ? h('ol', { class: 'small', 'data-testid': 'beta-fixes' }, cmp.fixes.map(f => h('li', null, f.strong ? h('strong', null, '💪 ') : '', f.text, f.quote ? [' — ', h('q', null, f.quote), f.quote_verified === false ? h('span', { class: 'small muted' }, ' (not found word for word)') : null] : null)))
      : h('p', { class: 'small', 'data-testid': 'beta-fixes' }, '✔ Nothing the readers would fix.'));
    (r.readers || []).filter(x => x.status === 'done').forEach(x => {
      const d = h('details', { 'data-testid': `beta-reader-read-${x.n}` }, h('summary', null, `Reader ${x.n}: ${(x.reader || {}).name || 'An AI'} as ${(x.persona || {}).a_label || 'a reader'}`));
      drawRead(x, d, false);
      wrap.appendChild(d);
    });
  }
  load();
  return sec;
}

function fmt(c, iso) { try { return c.fmtTime(iso); } catch { return iso || ''; } }

/* ======================================================================= ✒️ P25 your writing style (#/style) */
export async function viewStyle(main, c) {
  const { h, clear } = c;
  main.appendChild(h('div', { class: 'page-head' }, h('div', null, c.crumbs(['My books', '#/'], 'My writing style'), h('h1', null, '✒️ My writing style'))));
  const holder = h('div', { 'aria-live': 'polite' }, c.loadingState('Loading your style card…'));
  main.appendChild(holder);
  let st;
  const load = async () => {
    try { st = await c.api('GET', '/style-card'); } catch (e) { clear(holder).appendChild(c.problemBox(c.toProblem(e, { step: 'My writing style' }), { retry: load })); return; }
    draw();
    if (st.card && st.card.status === 'learning') setTimeout(() => { if (holder.isConnected) load(); }, 1200);
  };
  function sampleBox(s, list) {
    const name = h('input', { type: 'text', maxlength: '80', value: s.name || '', placeholder: 'Name (optional)', 'aria-label': 'Sample name' });
    const text = h('textarea', { rows: '8', 'aria-label': 'Sample text', placeholder: 'Paste a passage you wrote yourself (narration, a few hundred words or more)' });
    text.value = s.text || '';
    const count = h('span', { class: 'small muted' });
    const upd = () => { const n = (text.value.match(/[A-Za-z0-9’']+/g) || []).length; count.textContent = `${n.toLocaleString()} words`; };
    text.addEventListener('input', upd); upd();
    const box = h('div', { class: 'card s7-sample' }, h('div', { class: 'row' }, name, count,
      h('button', { type: 'button', class: 'small', onclick: () => { box.remove(); } }, '✖ Remove')), text);
    box._get = () => ({ name: name.value.trim(), text: text.value });
    list.appendChild(box);
    return box;
  }
  function draw() {
    clear(holder);
    const card = st.card;
    const lim = st.limits || {};
    holder.appendChild(h('p', null, 'Paste or upload a few samples of your own writing. Akọwe counts how you write (sentence length, rhythm, person and tense, dialogue, punctuation habits) and an AI describes your narrating voice. Books that use your style get this card in every chapter prompt, and the editor flags narration that drifts from it. Dialogue still follows each character’s own voice card.'));
    holder.appendChild(h('p', { class: 'small muted' }, `Up to ${lim.samples || 10} samples, at least ${lim.min_words || 150} words together (1 000–3 000 words of narration work best). Your samples stay on this computer and are only sent to the AI when you press ✨ Learn my style.`));
    const list = h('div', { class: 's7-samples', 'data-testid': 'style-samples' });
    for (const s of (card && card.samples) || []) sampleBox(s, list);
    if (!list.children.length) sampleBox({}, list);
    const file = h('input', { type: 'file', accept: '.txt,.md,text/plain,text/markdown', multiple: true, class: 'visually-hidden', 'aria-label': 'Upload text files', 'data-testid': 'style-file' });
    file.addEventListener('change', async () => {
      for (const f of file.files) {
        if (f.size > 200000) { c.toast(`${f.name} is too big (keep samples under 30 000 characters)`); continue; }
        const text = await f.text();
        const empty = [...list.children].find(b => !b._get().text.trim());
        if (empty) empty.remove();
        sampleBox({ name: f.name.replace(/\.(txt|md)$/i, ''), text }, list);
      }
      file.value = '';
    });
    const msg = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'button', class: 'primary', 'data-testid': 'style-save', onclick: async () => {
      clear(msg); save.disabled = true;
      const samples = [...list.children].map(b => b._get()).filter(s => s.text.trim());
      try { st = await c.api('PUT', '/style-card', { body: { samples } }); c.toast('Your samples are saved and counted'); draw(); }
      catch (e) { msg.appendChild(c.problemBox(c.toProblem(e, { step: 'Save my samples' }))); save.disabled = false; }
    } }, '💾 Save and count');
    const learn = h('button', { type: 'button', 'data-testid': 'style-learn', disabled: !card || card.status === 'learning', onclick: async () => {
      clear(msg); learn.disabled = true;
      try { st = await c.api('POST', '/style-card/learn', { body: {} }); draw(); setTimeout(load, 900); }
      catch (e) { msg.appendChild(c.problemBox(c.toProblem(e, { step: 'Learn my style' }))); learn.disabled = false; }
    } }, '✨ Learn my style with AI');
    const del = card ? h('button', { type: 'button', class: 'danger', onclick: async () => {
      if (!window.confirm('Delete your style card and samples? Books keep the copy they already use.')) return;
      try { st = await c.api('DELETE', '/style-card'); draw(); } catch (e) { msg.appendChild(c.problemBox(c.toProblem(e, { step: 'Delete my style card' }))); }
    } }, '🗑 Delete') : null;
    holder.appendChild(h('section', { class: 'card' }, h('h2', null, 'Your samples'), list,
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => sampleBox({}, list) }, '+ Add a sample'), h('label', { class: 'btn small' }, '⬆ Upload .txt / .md ', file)),
      h('div', { class: 'form-actions' }, save, learn, del), msg));
    if (card) holder.appendChild(cardView(c, card));
    if (card) holder.appendChild(booksView(c, st.books || [], card, load));
  }
  await load();
}

function cardView(c, card) {
  const { h } = c;
  const s = card.stats || {};
  const ai = card.ai;
  const sec = h('section', { class: 'card', 'data-testid': 'style-card' }, h('h2', null, `Your style card (version ${card.version})`));
  if (card.status === 'learning') sec.appendChild(h('p', { class: 'small' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' The AI is reading your samples…'));
  if (card.status === 'failed' && card.error) sec.appendChild(c.problemBox({ code: card.error.code || 'STYLE_FAILED', message: card.error.message || 'The AI could not describe your style.', where: { step: 'Learn my style' } }));
  sec.appendChild(h('h3', null, 'Counted from your samples (no AI)'));
  sec.appendChild(h('ul', { class: 'small', 'data-testid': 'style-numbers' }, (card.in_words || []).map(x => h('li', null, x))));
  sec.appendChild(h('p', { class: 'small muted' }, `${(s.words || 0).toLocaleString()} words · reading grade ${s.grade ?? '–'} · ${s.contractions_per_1000} contractions, ${s.ly_adverbs_per_1000} -ly adverbs, ${s.semicolons_per_1000} semicolons, ${s.dashes_per_1000} dashes per 1 000 words`));
  if (ai) {
    sec.appendChild(h('h3', null, 'Your narrating voice (AI)', card.ai_by && card.ai_by.name ? h('span', { class: 'small muted' }, ` — described by ${card.ai_by.name}`) : null));
    sec.appendChild(h('dl', { class: 's7-dl', 'data-testid': 'style-ai' }, [['Voice', ai.voice_summary], ['Rhythm', ai.rhythm], ['Words', ai.diction], ['Images', ai.imagery], ['Narration', ai.narration]]
      .filter(([, v]) => v).map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
    const two = h('div', { class: 'grid-2' });
    if ((ai.do || []).length) two.appendChild(h('div', null, h('strong', null, '✔ Do'), h('ul', { class: 'small' }, ai.do.map(x => h('li', null, x)))));
    if ((ai.avoid || []).length) two.appendChild(h('div', null, h('strong', null, '✖ Avoid'), h('ul', { class: 'small' }, ai.avoid.map(x => h('li', null, x)))));
    sec.appendChild(two);
    if ((ai.example_moves || []).length) sec.appendChild(h('ul', { class: 'small' }, ai.example_moves.map(m => h('li', null, m.move, ' — ', h('q', null, m.quote),
      m.verified ? null : [' ', c.hazard({ code: 'QUOTE_NOT_FOUND' }, {}, { small: true }), h('span', { class: 'muted' }, ' (not used)')]))));
  } else if (card.status !== 'learning') {
    sec.appendChild(h('p', { class: 'small muted' }, 'Press ✨ Learn my style with AI for a description of your voice (the numbers above already work without it).'));
  }
  return sec;
}

function booksView(c, books, card, reload) {
  const { h } = c;
  const sec = h('section', { class: 'card', 'data-testid': 'style-books' }, h('h2', null, 'Books that write in your style'),
    h('p', { class: 'small' }, 'A book keeps a copy of the card from when you switched it on (so later edits never change a book silently). New ⚡ Make-a-book runs ask you with “✒️ Write in my style”.'));
  if (!books.length) { sec.appendChild(h('p', { class: 'small muted' }, 'No books yet.')); return sec; }
  sec.appendChild(h('ul', { class: 's7-books' }, books.map(b => {
    const id = `style-book-${b.project_id}`;
    const cb = h('input', { type: 'checkbox', id, checked: b.on, 'data-pid': b.project_id });
    const put = async on => {
      cb.disabled = true;
      try { await c.api('PUT', `/projects/${encodeURIComponent(b.project_id)}/branches/main/style`, { body: { on } }); c.toast(on ? `“${b.name}” writes in your style` : `“${b.name}” no longer uses your style`); await reload(); }
      catch (e) { c.toast(c.toProblem(e).message || 'Could not change it'); cb.checked = !on; cb.disabled = false; }
    };
    cb.addEventListener('change', () => put(cb.checked));
    return h('li', { class: 'check-row' }, cb, h('label', { for: id }, b.name),
      b.outdated ? [h('span', { class: 'small words-warn' }, ` uses version ${b.from_version} `), h('button', { type: 'button', class: 'small', onclick: () => put(true) }, `↻ Use version ${card.version}`)] : null);
  })));
  return sec;
}
