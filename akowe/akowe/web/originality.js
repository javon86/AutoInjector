// ✨ #20 Originality and "sounds like AI" check: a card on the 📊 report page. Akọwe's own check (no AI: clichés,
// AI-sounding phrases, long dashes, "It wasn't X. It was Y." …) per chapter with quotes and plain reasons, and an
// optional AI pass that rates passages 1-5 for "sounds machine-written" (every quote checked against the book).
// app.js passes its helpers in (the same ones as section7c.js), so this module never reaches into app.js.
// All data is rendered with DOM APIs (never innerHTML with server data). Advice only: it never blocks the book.

const SEV = { major: '⚠️ ', minor: '', info: 'ⓘ ' };
const MACHINE_WORD = { 1: 'sounds like a person', 2: 'mostly a person', 3: 'could be either', 4: 'sounds machine-made', 5: 'clearly machine-made' };

export function originalityCard(c) {
  const { h, clear } = c;
  const body = h('div', { 'aria-live': 'polite' }, c.loadingState('Loading the originality check…'));
  const sec = h('section', { class: 'card s7-orig', 'data-testid': 'orig-card', 'aria-labelledby': 'orig-h' },
    h('h2', { id: 'orig-h' }, '✨ Originality check'), body);
  let dialogue = false;
  const load = async () => {
    let ov;
    try { ov = await c.api('GET', c.bpath('/originality') + (dialogue ? '?dialogue=1' : '')); } catch (e) { clear(body).appendChild(c.problemBox(c.toProblem(e, { step: 'Originality check' }), { retry: load })); return; }
    draw(ov);
  };
  const ask = async (slot, btn, prog) => {
    btn.disabled = true;
    try {
      const j = await c.api('POST', c.bpath('/originality'), { body: slot ? { slot_id: slot } : {} });
      const end = await c.pollQualityJob(c.bpath(`/originality/job/${encodeURIComponent(j.id)}`), prog);
      if (end.status !== 'done') { clear(prog).appendChild(c.problemBox({ code: (end.error || {}).code || 'ORIGINALITY_FAILED', message: (end.error || {}).message || end.phase, where: { step: 'Originality check' } }, { retry: () => ask(slot, btn, prog) })); btn.disabled = false; return; }
      c.toast('The AI has rated the passages'); c.announce('The AI has rated the passages');
      await load();
    } catch (e) { clear(prog).appendChild(c.problemBox(c.toProblem(e, { step: 'Originality check' }))); btn.disabled = false; }
  };
  function draw(ov) {
    clear(body);
    const rep = ov.report || {};
    body.appendChild(h('p', { class: 'small' }, 'Before you publish: Akọwe looks for clichés and for phrases and habits that make prose sound machine-written (“a testament to”, “a breath she didn’t know she was holding”, “It wasn’t fear. It was…”, long dashes everywhere). It counts them per 1 000 words, chapter by chapter. Dialogue is left out unless you tick the box: characters may talk in clichés. This is advice only — it never stops the book. ',
      h('span', { class: 'muted' }, `Lists: ${(rep.lists || {}).ai_phrases || 0} AI-sounding phrases, ${(rep.lists || {}).cliches || 0} clichés.`)));
    const box = h('input', { type: 'checkbox', id: 'orig-dialogue', 'data-testid': 'orig-dialogue', checked: dialogue, onchange: () => { dialogue = box.checked; load(); } });
    body.appendChild(h('div', { class: 'check-row small' }, box, h('label', { for: 'orig-dialogue' }, 'Count dialogue too')));
    if (!ov.written) { body.appendChild(h('p', { class: 'small muted' }, 'No chapters written yet.')); return; }
    body.appendChild(h('p', { class: 'small', 'data-testid': 'orig-line' }, h('strong', null, rep.line || '')));
    const rows = rep.chapters || [];
    if (rows.length) {
      body.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'rp-table', 'data-testid': 'orig-chapters' },
        h('thead', null, h('tr', null, ['Chapter', 'Score', 'How it sounds', 'AI-sounding spots', 'What stands out'].map(x => h('th', null, x)))),
        h('tbody', null, rows.map(r => h('tr', { class: r.score < 60 ? 'low' : '' },
          h('th', { scope: 'row' }, `${r.number}${r.title ? ` · ${r.title}` : ''}`), h('td', { class: 'num' }, `${r.score}/100`),
          h('td', null, r.rating), h('td', { class: 'num' }, `${r.spots} (${r.per_1000} per 1 000 words)`),
          h('td', { class: 'small' }, (r.flags || []).join(' · ') || '–')))))));
    }
    const fs = rep.findings || [];
    if (fs.length) {
      const strong = fs.filter(f => f.severity !== 'info').length;
      body.appendChild(h('details', { 'data-testid': 'orig-findings', open: strong > 0 && fs.length <= 12 },
        h('summary', null, `What Akọwe found (${fs.length}${strong ? `, ${strong} worth fixing` : ''})`),
        h('ul', { class: 'small' }, fs.map(f => h('li', null, `${SEV[f.severity] || ''}`, h('strong', null, `Chapter ${f.number} · ${f.label}`), ': ', h('q', null, f.quote), ' — ', f.reason, ' ', h('span', { class: 'muted' }, f.advice))))));
    } else {
      body.appendChild(h('p', { class: 'small' }, '✔ No clichés or AI-sounding phrases found.'));
    }
    const checks = (rep.checks || []).filter(x => x.count);
    if (checks.length) {
      body.appendChild(h('details', null, h('summary', null, 'The counts, per 1 000 words'),
        h('ul', { class: 'small' }, checks.map(x => h('li', null, `${SEV[x.severity] || ''}${x.label}: ${x.count} (${x.per_1000} per 1 000 words${x.threshold ? `; a problem from ${x.threshold.minor}` : ''})`)))));
    }
    aiPart(ov);
  }
  function aiPart(ov) {
    const r = ov.latest;
    body.appendChild(h('h3', null, 'Ask an AI'));
    body.appendChild(h('p', { class: 'small' }, 'An AI that did not write those chapters reads the flagged passages and one sample from each chapter, and rates each from 1 (sounds like a person) to 5 (sounds machine-written), with reasons and a suggested rewrite. Every quote is checked against the book. Nothing in the book is changed.'));
    const readers = (ov.readers || []).filter(o => o.working);
    const sel = h('select', { id: 'orig-slot', 'aria-label': 'Which AI reads' }, h('option', { value: '' }, 'Automatic — an AI that did not write the book'),
      readers.map(o => h('option', { value: o.slot_id }, `${o.name}${o.wrote_most ? ' (wrote most of it ⚠️)' : ''}`)));
    const prog = h('div', { class: 'rp-progress' });
    const btn = h('button', { type: 'button', class: r ? '' : 'primary', 'data-testid': 'orig-ask', disabled: !ov.written, onclick: () => ask(sel.value || null, btn, prog) }, r ? '✨ Ask the AI again' : '✨ Ask an AI: does it sound machine-written?');
    body.appendChild(h('div', { class: 'row' }, sel, btn));
    body.appendChild(prog);
    if (ov.job) c.pollQualityJob(c.bpath(`/originality/job/${encodeURIComponent(ov.job.id)}`), prog).then(load).catch(() => {});
    if (!r) { body.appendChild(h('p', { class: 'small muted' }, 'No AI has rated the passages yet.')); return; }
    if (ov.stale) body.appendChild(h('p', { class: 'words-warn small', role: 'note' }, '⚠️ These ratings are for an earlier version of the book: a chapter changed since.'));
    if (r.status !== 'done') {
      body.appendChild(c.problemBox({ code: r.error || 'ORIGINALITY_FAILED', message: r.message || 'The AI could not rate the passages.', where: { step: 'Originality check' } }));
      return;
    }
    const rd = r.reader || {}; const t = r.totals || {};
    body.appendChild(h('p', { class: 'small', 'data-testid': 'orig-ai-who' }, h('strong', null, rd.name || 'An AI'), ` rated ${(r.ratings || []).length} passage(s) ·${fmt(c, r.at)}`,
      t.average != null ? ` · ${t.average}/5 on average (${MACHINE_WORD[Math.round(t.average)] || ''})` : '',
      t.machine_like ? h('span', { class: 'words-warn' }, ` · ⚠️ ${t.machine_like} sound machine-made`) : '',
      rd.independent ? '' : h('span', { class: 'words-warn' }, ` · ⚠️ ${rd.own_passages || 'some'} passage(s) are from chapters this AI wrote`)));
    if (r.summary) body.appendChild(h('blockquote', { class: 's7-say' }, r.summary));
    const quote = x => x.quote ? [' — ', h('q', null, x.quote), x.in_chapter ? null : [' ', c.hazard({ code: 'QUOTE_NOT_FOUND' }, {}, { small: true })]] : null;
    body.appendChild(h('ul', { class: 'small', 'data-testid': 'orig-ai' }, (r.ratings || []).slice().sort((a, b) => b.machine_score - a.machine_score || a.chapter - b.chapter).map(x => h('li', null,
      h('strong', null, `Chapter ${x.chapter} · ${x.machine_score}/5 ${MACHINE_WORD[x.machine_score] || ''}`), x.flagged ? ' (flagged by Akọwe)' : ' (sample)',
      (x.reasons || []).length ? `: ${x.reasons.join('; ')}` : '', quote(x),
      x.rewrite ? h('div', { class: 'muted' }, 'Suggested: ', h('q', null, x.rewrite)) : null))));
  }
  load();
  return sec;
}

function fmt(c, iso) { try { return ` ${c.fmtTime(iso)}`; } catch { return iso ? ` ${iso}` : ''; } }
