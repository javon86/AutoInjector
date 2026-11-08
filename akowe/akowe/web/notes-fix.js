// BACK BURNER (parked 2026-11-08 by the user's request): not loaded by the app; see docs/AKOWE_IMPROVEMENT_PLAN.md back-burner list.
// 📝 Fix it with my notes (notes_fix.py): #/p/<pid>/<branch>/notes. The author writes notes, one per line; Akọwe shows
// which chapters and passages each note is about (to confirm or change), then proposes before/after changes, checked
// by an independent AI; the author ticks the ones to use — they become a new draft of each chapter to approve. app.js
// passes its helpers in (importUI()); all data is rendered with DOM APIs (never innerHTML with server data).

export function viewNotesFix(main, c) {
  const { h, clear, api, bpath, plink, crumbs, problemBox, toProblem, S } = c;
  const where = { book: S.project && S.project.name, step: 'Fix it with my notes' };
  main.appendChild(h('div', { class: 'page-head' }, h('div', null, crumbs(['My books', '#/'], [S.project.name, plink('book')], 'Fix it with my notes'),
    h('h1', null, '📝 Fix it with my notes'))));
  const holder = h('div', { 'aria-live': 'polite' }, c.loadingState('Loading…'));
  main.appendChild(holder);
  let timer = null;
  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
  S.leaveHooks.push(stop);
  let lastNotes = null;
  const load = async () => {
    stop();
    let st;
    try { st = await api('GET', bpath('/notes-fix')); } catch (e) { clear(holder).appendChild(problemBox(toProblem(e, where), { retry: load })); return; }
    if (!holder.isConnected) return;
    draw(st);
    if (st.running) timer = setTimeout(load, 1200);
  };
  const act = async (fn, msg) => {
    clear(msg);
    try { await fn(); await load(); } catch (e) { msg.appendChild(problemBox(toProblem(e, where))); }
  };
  const draw = st => {
    clear(holder);
    const msg = h('div', { 'aria-live': 'polite' });
    // 1. the notes box (always there: a new set of notes starts again)
    const box = h('textarea', { id: 'nf-notes', rows: '7', 'data-testid': 'nf-notes', placeholder: 'One note per line, in your own words:\nChapter 7 drags\nmake Mara angrier in the market scene\ncut the dream in ch 3\nthe ending needs more payoff for the locket' });
    box.value = lastNotes != null ? lastNotes : (st.notes || []).map(x => x.text).join('\n');
    const mapBtn = h('button', { type: 'button', class: 'primary', 'data-testid': 'nf-map', disabled: st.running, onclick: () => {
      lastNotes = box.value;
      act(() => api('POST', bpath('/notes-fix/map'), { body: { notes: box.value } }), msg);
    } }, '🔎 Find what my notes are about');
    holder.appendChild(h('section', { class: 'card', 'data-testid': 'nf-start' }, h('h2', null, 'Your notes'),
      h('p', { class: 'small' }, 'Write what you want changed, one note per line, the way you would tell an editor. Akọwe shows you which chapters each note is about before anything is written, and every change waits for your OK.'),
      h('div', { class: 'field' }, h('label', { for: 'nf-notes' }, 'Notes'), box), h('div', { class: 'row' }, mapBtn), msg));
    if (st.status === 'idle') return;
    const stateLine = h('p', { 'data-testid': 'nf-state', 'data-state': st.status, class: ['failed', 'interrupted'].includes(st.status) ? 'words-warn' : '' },
      st.running ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null, st.running ? ' ' : '', st.message || '');
    const prog = st.progress && st.running && st.status === 'revising' ? h('p', { class: 'small muted' }, `${st.progress.done} of ${st.progress.total} note/chapter pairs`) : null;
    holder.appendChild(h('div', null, stateLine, prog));
    if (st.status === 'mapping') return;
    // 2. the mapping, to confirm
    const maxCh = Math.max(1, ...(st.notes || []).flatMap(x => x.chapters || []));
    const rows = (st.notes || []).map(x => {
      const tick = h('input', { type: 'checkbox', checked: !!x.confirmed, 'aria-label': `Use note: ${x.text}`, 'data-testid': 'nf-confirm' });
      const chs = h('input', { type: 'text', value: (x.chapters || []).join(', '), class: 'nf-chs', 'aria-label': `Chapters for note: ${x.text}`, 'data-testid': 'nf-chapters', placeholder: 'e.g. 3, 4' });
      const how = { ai: 'matched by the AI', named: 'the chapter you named', names: 'chapters where these characters are', words: 'chapters that use these words', 'the ending': 'the last chapters', 'the opening': 'chapter 1', you: 'your choice' }[x.how] || (x.chapters && x.chapters.length ? 'Akọwe’s guess' : 'not found — choose the chapters');
      const li = h('li', { class: 'nf-note', 'data-testid': 'nf-note', 'data-id': x.id }, h('div', { class: 'row' }, tick, h('strong', null, x.text)),
        h('div', { class: 'row small' }, h('span', null, 'Chapters:'), chs, h('span', { class: 'muted' }, how)),
        (x.passages || []).length ? h('ul', { class: 'small plain-list' }, x.passages.map(p => h('li', null, `Ch ${p.chapter}: “${p.quote}”`))) : null);
      li._get = () => ({ id: x.id, confirmed: tick.checked, chapters: chs.value.split(/[^0-9]+/).filter(Boolean).map(Number) });
      return li;
    });
    const list = h('ol', { class: 'plain-list nf-list' }, rows);
    const msg2 = h('div', { 'aria-live': 'polite' });
    const save = () => api('PUT', bpath('/notes-fix/mapping'), { body: { notes: rows.map(r => r._get()) } });
    const revise = h('button', { type: 'button', class: 'primary', 'data-testid': 'nf-revise', disabled: st.running, onclick: () => act(async () => { await save(); await api('POST', bpath('/notes-fix/revise'), { body: {} }); }, msg2) }, '✍ Propose the changes');
    holder.appendChild(h('section', { class: 'card', 'data-testid': 'nf-mapping' }, h('h2', null, 'What each note is about'),
      h('p', { class: 'small' }, `Check the chapters (numbers 1–${Math.max(maxCh, 1)}+, separated by commas). Untick a note to leave it out.`), list, h('div', { class: 'row' }, revise), msg2));
    // 3. the proposed changes
    const changes = st.changes || [];
    if (!changes.length) {
      if (st.status === 'proposed') holder.appendChild(c.stateBox('empty', 'No change was proposed', h('p', null, 'The AI found nothing to change for these notes. Try saying more precisely what you want, or name the chapter.')));
      return;
    }
    const ck = st.checks || {};
    const checkLine = ck.independent ? `Checked by ${ck.checker}, an AI that did not write the changes.` : (ck.note || '');
    const ticks = [];
    const byNote = {};
    for (const ch of changes) (byNote[ch.note] = byNote[ch.note] || []).push(ch);
    const groups = Object.entries(byNote).map(([nid, chs]) => h('li', { class: 'nf-group' }, h('p', null, h('strong', null, `“${chs[0].note_text}”`)),
      h('ul', { class: 'plain-list' }, chs.map(ch => {
        const id = `nf-x-${ch.id}`;
        const waiting = ch.status === 'proposed';
        const b = h('input', { type: 'checkbox', id, value: ch.id, checked: waiting && !ch.conflict, disabled: !waiting, 'data-conflict': ch.conflict ? '1' : '' });
        if (waiting) ticks.push(b);
        const status = { accepted: '✔ used', rejected: '✖ left out', not_applied: '⚠ could not be applied' }[ch.status];
        return h('li', { class: `nf-change${ch.conflict ? ' nf-conflict' : ''}`, 'data-testid': 'nf-change', 'data-status': ch.status },
          h('div', { class: 'check-row' }, b, h('label', { for: id }, h('span', { class: 'muted' }, `Chapter ${ch.number}: `),
            h('del', null, ch.original), ' → ', ch.replacement ? h('ins', null, ch.replacement) : h('em', null, '(cut)'))),
          ch.why ? h('p', { class: 'small muted' }, ch.why) : null,
          ch.conflict ? h('p', { class: 'small words-warn', 'data-testid': 'nf-conflict' }, '🔒 ', ch.conflict, ' — not ticked: tick it only if you really want to change it.') : null,
          (ch.checks || []).map(k => h('p', { class: 'small words-warn', 'data-testid': 'nf-check' }, `⚠️ ${k.by}: ${k.problem}`)),
          status ? h('p', { class: 'small' }, status) : null);
      }))));
    const msg3 = h('div', { 'aria-live': 'polite' });
    const use = h('button', { type: 'button', class: 'primary', 'data-testid': 'nf-use', disabled: !ticks.length || st.running, onclick: () => act(async () => {
      const accept = ticks.filter(t => t.checked).map(t => t.value);
      const reject = ticks.filter(t => !t.checked && !t.dataset.conflict).map(t => t.value);
      const body = { accept, reject };
      if (ticks.some(t => t.checked && t.dataset.conflict)) body.accept_conflicts = true;
      const out = await api('POST', bpath('/notes-fix/decide'), { body });
      c.toast(out.summary);
    }, msg3) }, '✔ Use the ticked changes');
    holder.appendChild(h('section', { class: 'card', 'data-testid': 'nf-changes' }, h('h2', null, 'Proposed changes'),
      h('p', { class: 'small', 'data-testid': 'nf-summary' }, h('strong', null, st.summary)),
      checkLine ? h('p', { class: 'small muted', 'data-testid': 'nf-checker' }, checkLine) : null,
      h('ol', { class: 'plain-list' }, groups), msg3,
      h('div', { class: 'row' }, use, h('a', { class: 'btn', href: plink('review') }, '✔ Waiting for your OK')),
      h('p', { class: 'small muted' }, 'The ticked changes of each chapter become a new draft of it: read it and approve it on “Waiting for your OK”. Nothing changes in your approved chapters before that.')));
  };
  load();
}
