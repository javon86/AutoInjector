// 🔎 "Check consistency now" (check_now.py, PR #117): the same all-AI review a checkpoint makes, on demand — on the ⚡
// run window, 🏠 Book home and the 🧭 Continuity page. The author chooses the last 5 chapters (default), chapters X to
// Y, or the whole book so far. During a run it is queued and runs between chapters (fixes under the run consent);
// outside a run it runs on its own and its fixes are proposals (✔ Use these fixes = a new draft to approve). One at a
// time per book: the button is off, with the reason, while one is queued or running. app.js passes its helpers in
// ({h, api, clear, toast, problemBox, toProblem}); all data is rendered with DOM APIs (never innerHTML).

const STATE_WORDS = { queued: 'Consistency check queued — it runs after the chapter being written.',
  running: 'Consistency check running — every working AI is reading the chapters.',
  done: 'Consistency check done.', failed: 'The consistency check could not be finished.' };

/** The 🔎 box: ``pid`` / ``branch`` of the book; ``testid`` prefix keeps several on a page apart. */
export function checkNowBox(c, pid, branch = 'main', { testid = 'check-now', compact = false } = {}) {
  const { h, api, clear } = c;
  const path = `/projects/${encodeURIComponent(pid)}/branches/${encodeURIComponent(branch)}/review/continuity/check-now`;
  const id = `${testid}-${Math.random().toString(36).slice(2, 7)}`;
  const what = h('select', { id: `${id}-what`, 'data-testid': `${testid}-range` },
    h('option', { value: 'last5' }, 'Last 5 chapters'), h('option', { value: 'range' }, 'Chapters X to Y'),
    h('option', { value: 'all' }, 'Whole book so far'));
  const from = h('input', { type: 'number', min: '1', value: '1', id: `${id}-from`, 'data-testid': `${testid}-from`, class: 'num' });
  const to = h('input', { type: 'number', min: '1', value: '1', id: `${id}-to`, 'data-testid': `${testid}-to`, class: 'num' });
  const span = h('span', { class: 'row', hidden: true }, h('label', { for: `${id}-from` }, 'from chapter'), from, h('label', { for: `${id}-to` }, 'to'), to);
  what.addEventListener('change', () => { span.hidden = what.value !== 'range'; });
  const btn = h('button', { type: 'button', class: 'primary', 'data-testid': testid, 'aria-describedby': `${id}-why` }, '🔎 Check consistency now');
  const why = h('p', { class: 'small muted', id: `${id}-why`, 'data-testid': `${testid}-why`, 'aria-live': 'polite' });
  const out = h('div', { 'data-testid': `${testid}-result`, 'aria-live': 'polite' });
  const el = h('section', { class: compact ? 'cn-box' : 'card cn-box', 'data-testid': `${testid}-box` },
    compact ? null : h('h2', null, '🔎 Check consistency now'),
    h('p', { class: 'small muted' }, 'Every working AI reads the chapters and looks for mistakes and drift: injuries, belongings, names, days, characters acting out of character, chapters straying from the plan. What two AIs agree on is fixed. Nothing approved changes outside a ⚡ run: you get the fixes to use or not.'),
    h('div', { class: 'row cn-row' }, h('label', { for: `${id}-what` }, 'Check'), what, span, btn), why, out);
  let timer = null;
  let st = null;
  const show = s => {
    st = s;
    btn.disabled = !s.can_start;
    why.textContent = s.can_start ? (s.in_run ? 'A ⚡ run is working on this book: the check is queued and runs after the chapter being written.' : '') : (s.why_not || '');
    if (s.chapters) { from.max = to.max = String(s.chapters); if (+to.value < 2) to.value = String(s.chapters); }
    clear(out);
    const req = s.request || {};
    if (req.status) out.appendChild(h('p', { class: req.status === 'failed' ? 'small words-warn' : 'small', 'data-testid': `${testid}-state` },
      `${STATE_WORDS[req.status] || req.status}${req.label ? ` (${req.label})` : ''}`, req.message ? ` ${req.message}` : ''));
    const l = s.latest;
    if (l) {
      out.appendChild(h('p', { class: 'small' }, h('strong', null, l.line)));
      const sr = l.stretch;
      if (sr) {
        // the review of those chapters: folded under one line (the page stays short; one click shows it all)
        const rev = h('details', { class: 'cn-review', 'data-testid': `${testid}-review` }, h('summary', null, `📖 ${sr.title}: what each AI thought`));
        rev.appendChild(h('ul', { class: 'small' }, (sr.scores || []).map(x => h('li', null, `${x.label}: ${x.average}/10 (`,
          Object.entries(x.by || {}).map(([n, v]) => `${n} ${v}`).join(', '), x.agree ? ')' : ' — they disagree)'))));
        if ((sr.agree || []).length) rev.appendChild(h('ul', { class: 'small' }, sr.agree.map(a => h('li', null,
          `${a.names.join(' and ')} agree ${a.kind === 'not_working' ? 'this is not working' : 'this works'}: ${a.point}`))));
        rev.appendChild(h('ul', { class: 'small muted' }, (sr.views || []).map(v => h('li', null, h('strong', null, `${v.name}: `),
          [v.pacing, v.arc, v.drift].filter(Boolean).join(' ')))));
        out.appendChild(rev);
      }
      const probs = l.problems || [];
      if (probs.length) out.appendChild(h('ul', { class: 'small' }, probs.map(p => h('li', null, h('strong', null, `Chapter ${p.number}: `), p.problem,
        (p.found_by || []).length ? h('span', { class: 'muted' }, ` — found by ${p.found_by.join(' and ')}`) : null,
        h('span', { class: 'muted' }, ` · ${p.status}`), p.quote ? h('div', { class: 'muted' }, `“${p.quote}”`) : null,
        p.status === 'proposed' && p.original ? h('div', null, `fix: “${p.original}” → “${p.replacement}”`) : null))));
      if (probs.some(p => p.status === 'proposed')) {
        out.appendChild(h('p', { class: 'row' }, h('button', { type: 'button', 'data-testid': `${testid}-apply`, onclick: async () => {
          try { const r = await api('POST', `${path}/apply`, { body: { cp_id: l.id } }); c.toast(r.message || 'Saved as new drafts'); await refresh(); }
          catch (e) { clear(why).appendChild(c.problemBox(c.toProblem(e, { step: 'Check consistency now' }))); }
        } }, '✔ Use these fixes (as new drafts for you to approve)')));
      }
    }
    if (['queued', 'running'].includes(req.status)) { clearTimeout(timer); timer = setTimeout(() => { if (document.contains(el)) refresh(); }, 1500); }
  };
  const refresh = async () => { try { show(await api('GET', path)); } catch (e) { why.textContent = 'Could not read the consistency check.'; } };
  btn.addEventListener('click', async () => {
    const body = { range: what.value };
    if (what.value === 'range') { body.from = parseInt(from.value, 10); body.to = parseInt(to.value, 10); }
    btn.disabled = true;
    try { show(await api('POST', path, { body })); c.toast(st && st.in_run ? 'Consistency check queued' : 'Consistency check started'); }
    catch (e) { btn.disabled = false; clear(out).appendChild(c.problemBox(c.toProblem(e, { step: 'Check consistency now' }))); }
  });
  refresh();
  return el;
}
