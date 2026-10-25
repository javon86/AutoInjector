/* 🧭 Continuity page (Section 7: P32–P35): tracked physical and character state per scene, the two-readings test of
   the protected mysteries and the version ledger of a rerun / variant. The helpers of app.js are passed in (this
   module has no state of its own). API: /review/continuity (continuity.py). */

const STATUS_WORDS = { holds: '✔ holds', contradicted: '✕ contradicted on the page', unsupported: '⚠️ no support on the page' };
const DECISION_WORDS = { unresolved: 'Not decided', deliberate: 'Keep the new version (deliberate)', restore: 'Bring the old version back' };

export async function viewContinuity(main, x) {
  const { h, clear, api, bpath, plink, S } = x;
  const where = { book: S.project.name, step: 'Continuity' };
  let info;
  const load = async () => { info = await api('GET', bpath('/review/continuity')); };
  try { await load(); }
  catch (e) { main.appendChild(x.problemBox(x.toProblem(e, where), { retry: () => x.route() }, 'Could not open the continuity page')); return; }
  main.appendChild(h('div', { class: 'page-head' }, h('div', null,
    x.crumbs(['Your books', '#/'], [S.project.name, plink()], ['Make my book', plink('book')], 'Continuity'),
    h('h1', null, '🧭 Continuity')),
  h('div', { class: 'row' }, x.infoTip('Continuity',
    h('p', null, '🌊 Physical state: for every scene the time, light, tide, weather, footing, hazards and running counts (a lamp count, the clock, a gauge) — so the next chapter starts where the last one ended and early hazards still matter later.'),
    h('p', null, '🫀 Character state: for every character in a scene how strongly duty, guilt, fear of exposure, desire for contact (or your own list) pull on them, what they can see, what they wrongly assume, and one thing they do for their OWN goal.'),
    h('p', null, '🪞 Two readings: each protected mystery must keep two possible explanations; the test shows which one the book quietly leans away from.'),
    h('p', null, '🧾 Version ledger (reruns and variants): what was kept, replaced or removed against the earlier book, so nobody “fixes” a deliberate change back.'),
    h('p', null, 'Only approved state reaches the writer of the next chapter. Make a book for me tracks and approves it by itself (your run consent).')))));
  const msg = h('div', { 'aria-live': 'polite' });
  const prog = h('div', { 'aria-live': 'polite' });
  const body = h('div', { 'data-testid': 'continuity' });
  main.append(msg, prog, body);
  const fail = (e, title) => clear(msg).appendChild(x.problemBox(x.toProblem(e, where), {}, title));
  const reload = async () => { try { await load(); } catch (e) { fail(e, 'Could not reload'); } render(); };
  const job = async (path, bodyArgs, label) => {
    clear(msg);
    const j = await x.runAiJob(path, bodyArgs, prog, label);
    if (j) { const r = (j.results || []).slice(-1)[0] || {}; x.toast(r.message || 'Done'); await reload(); }
  };
  const post = async (method, path, b, title) => {
    clear(msg);
    try { const out = await api(method, bpath(path), { body: b }); if (out && out.message) x.toast(out.message); await reload(); return out; }
    catch (e) { fail(e, title); return null; }
  };

  function sceneLine(s) {
    const bits = [];
    for (const f of info.fields.fields) if (s[f.key]) bits.push(`${f.label.toLowerCase()}: ${s[f.key]}`);
    return h('li', null, h('strong', null, `Scene ${s.scene}: `), bits.join(' · ') || '—',
      (s.hazards || []).length ? h('ul', { class: 'small' }, s.hazards.map(z => h('li', null, z.status === 'open' ? '⚠️ ' : '✔ ', `${z.what} (${z.status})`, z.effect ? h('span', { class: 'muted' }, ` — ${z.effect}`) : null))) : null,
      (s.counts || []).length ? h('p', { class: 'small' }, '🔢 ', s.counts.map(c => `${c.name} ${c.value}${c.running ? ' (running)' : ''}`).join(' · ')) : null);
  }
  function peopleLine(s) {
    return h('li', null, h('strong', null, `Scene ${s.scene}: `), h('ul', { class: 'small' }, s.characters.map(c => h('li', null,
      h('strong', null, c.name), ' ', Object.entries(c.values || {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · '),
      c.observes ? h('div', null, '👁 sees: ', c.observes) : null,
      c.assumes ? h('div', null, '❓ wrongly assumes: ', c.assumes) : null,
      c.own_action ? h('div', null, c.serves === 'own_goal' ? '🎯 own goal: ' : '🎭 for the theme: ', c.own_action) : null))));
  }
  function editBox(r) {
    const ta = h('textarea', { rows: 10, class: 'mono', 'aria-label': `Tracked state of chapter ${r.number} (JSON)` },
      JSON.stringify({ physical: r.physical ? { version: r.physical.version, scenes: r.physical.scenes } : undefined,
        characters: r.characters ? { version: r.characters.version, scenes: r.characters.scenes } : undefined }, null, 2));
    return h('details', { class: 'small' }, h('summary', null, '✏️ Edit by hand'),
      h('p', { class: 'muted' }, 'Change the values and press Save (a new version; approve it afterwards).'), ta,
      h('p', null, h('button', { type: 'button', class: 'small', onclick: async () => {
        let b; try { b = JSON.parse(ta.value); } catch { x.toast('That is not valid JSON'); return; }
        await post('PUT', `/review/continuity/chapter/${encodeURIComponent(r.chapter_id)}`, b, 'Not saved');
      } }, 'Save')));
  }
  function chapterCard(r) {
    const card = h('section', { class: 'card', 'data-testid': `cont-ch-${r.chapter_id}` });
    const p = r.physical; const q = r.characters;
    const stale = (p && p.out_of_date) || (q && q.out_of_date);
    card.appendChild(h('h3', null, `Chapter ${r.number}`, r.title ? ` — ${r.title}` : ''));
    card.appendChild(h('p', { class: 'row small' },
      !r.tracked ? h('span', { class: 'muted' }, 'Not tracked yet') :
        r.state_approved ? h('span', null, '✔ approved', (p || q).approved && (p || q).approved.how === 'run_consent' ? ' (Make-a-book consent)' : ' (by you)') : h('span', { class: 'words-warn' }, '⚠️ not approved yet — the writer does not use it'),
      stale ? h('span', { class: 'words-warn' }, ' · ⚠️ the chapter changed since it was tracked') : null,
      p && p.made_by ? h('span', { class: 'muted' }, ` · read by ${p.made_by.ai ? 'an AI' : p.made_by.kind === 'author' ? 'you' : 'Akọwe (no AI)'}`) : null));
    if (p && (p.scenes || []).length) card.appendChild(h('div', null, h('h4', null, '🌊 Physical state'), h('ul', { class: 'small' }, p.scenes.map(sceneLine))));
    if (q && (q.scenes || []).length) card.appendChild(h('div', null, h('h4', null, '🫀 Characters'), h('ul', { class: 'small' }, q.scenes.map(peopleLine))));
    else if (r.tracked) card.appendChild(h('p', { class: 'small muted' }, '🫀 No character state: it needs an AI (or your own values).'));
    card.appendChild(h('p', { class: 'row' },
      h('button', { type: 'button', class: 'small', onclick: () => job('/review/continuity/track', { chapter_ids: [r.chapter_id] }, `Tracking chapter ${r.number}`) }, r.tracked ? '🧭 Track again with AI' : '🧭 Track with AI'),
      r.tracked && !r.state_approved ? h('button', { type: 'button', class: 'small primary', onclick: async () => {
        const ok = await x.choiceDialog('Approve this state?', h('p', null, `The writer of the next chapters continues from the tracked state of chapter ${r.number}.`), [{ id: 'yes', label: '✔ Yes, I approve' }]);
        if (ok !== 'yes') return;
        await post('POST', `/review/continuity/chapter/${encodeURIComponent(r.chapter_id)}/approve`, { author_confirms: true, versions: { physical: p ? p.version : undefined, characters: q ? q.version : undefined } }, 'Not approved');
      } }, '✔ Approve') : null));
    if (r.tracked) card.appendChild(editBox(r));
    return card;
  }
  function checksCard() {
    const all = [...(info.checks.physical || []), ...(info.checks.characters || [])];
    return h('section', { class: 'card', 'data-testid': 'cont-checks' }, h('h2', null, '🔎 Questions from Akọwe’s checks'),
      all.length ? h('ul', { class: 'small' }, all.map(p => h('li', null, p.severity === 'major' ? '⚠️ ' : '• ', p.number ? `Chapter ${p.number}${p.scene ? `, scene ${p.scene}` : ''}: ` : '', p.message)))
        : h('p', { class: 'small muted' }, 'No questions: counts go one way, the clock does not run backwards, every hazard matters later and every main character acts for their own goal.'));
  }
  function variablesCard() {
    const inp = h('input', { type: 'text', value: info.variables.map(v => v.replace(/_/g, ' ')).join(', '), 'aria-label': 'Character state variables', size: 60 });
    return h('section', { class: 'card' }, h('h2', null, '🫀 What is tracked for each character'),
      h('p', { class: 'small' }, 'Up to 8, separated by commas (0 = not at all, 10 = it drives them). Default: ', info.default_variables.map(v => v.replace(/_/g, ' ')).join(', '), '.'),
      h('p', { class: 'row' }, inp, h('button', { type: 'button', class: 'small', onclick: () => post('PUT', '/review/continuity/variables', { variables: inp.value.split(',') }, 'Not saved') }, 'Save')),
      info.mains.length ? h('p', { class: 'small muted' }, `Main characters (each needs an action for their own goal): ${info.mains.join(', ')}`) : null);
  }
  function readingsCard() {
    const a = info.ambiguity; const e = a.entry || {}; const items = e.items || [];
    const res = {}; for (const r of ((e.test || {}).results || [])) res[r.id] = r;
    const box = h('section', { class: 'card', 'data-testid': 'cont-readings' }, h('h2', null, '🪞 Two readings of each protected mystery'));
    if (!a.mysteries.length) { box.appendChild(h('p', { class: 'small muted' }, 'No protected mystery in the story rules yet (🌍 Story rules and world → category “Protected mystery”).')); return box; }
    const sm = a.summary;
    box.appendChild(h('p', { class: 'small' }, `${sm.with_readings} of ${sm.mysteries} mystery(ies) have two readings`, sm.tested ? ` · tested: ${sm.passed} hold both, ${sm.weak} lean to one` : ''));
    const forms = [];
    for (const m of a.mysteries) {
      const it = items.find(i => i.id === m.id) || { readings: [] };
      const r = res[m.id];
      const fields = [0, 1].map(i => {
        const rd = it.readings[i] || { label: '', text: '' };
        const st = r ? (r.readings.find(z => z.label === rd.label) || {}) : {};
        return { lab: h('input', { type: 'text', value: rd.label, placeholder: `Reading ${'AB'[i]}`, 'aria-label': `Label of reading ${'AB'[i]}`, size: 18 }),
          txt: h('input', { type: 'text', value: rd.text, placeholder: 'One sentence: what really happened in this reading', 'aria-label': `Reading ${'AB'[i]}`, size: 60 }), st };
      });
      forms.push({ id: m.id, fields });
      box.appendChild(h('div', { class: `rv-box ${r ? (r.verdict === 'PASS' ? 'ok' : 'warn') : ''}` },
        h('p', null, h('strong', null, m.text), r ? h('span', { class: 'small' }, r.verdict === 'PASS' ? ' — ✔ both readings hold' : ` — ⚠️ weaker reading: ${r.weaker}`) : null),
        fields.map(f => h('div', null, h('p', { class: 'row small' }, f.lab, f.txt, f.st.status ? h('span', null, STATUS_WORDS[f.st.status] || f.st.status) : null),
          f.st.status ? h('ul', { class: 'small' }, [...(f.st.supports || []).map(q => h('li', null, q.found ? '✔ supports' : '· (not found word for word)', ` (chapter ${q.chapter || '?'}): “${q.quote}”`)),
            ...(f.st.contradictions || []).map(q => h('li', null, q.found ? '✕ contradicts' : '· (not found word for word)', ` (chapter ${q.chapter || '?'}): “${q.quote}”`, q.why ? ` — ${q.why}` : ''))]) : null))));
    }
    box.appendChild(h('p', { class: 'row' },
      h('button', { type: 'button', class: 'small', onclick: () => post('PUT', '/review/continuity/readings', { version: e.version || undefined,
        items: forms.map(f => ({ id: f.id, readings: f.fields.map(z => ({ label: z.lab.value, text: z.txt.value })) })).filter(i => i.readings.every(z => z.text.trim())) }, 'Not saved') }, 'Save readings'),
      h('button', { type: 'button', class: 'small', onclick: () => job('/review/continuity/readings/ai', {}, 'Writing two readings') }, '✨ Suggest readings with AI'),
      items.length ? h('button', { type: 'button', class: 'small primary', onclick: () => job('/review/continuity/readings/test', {}, 'Testing both readings') }, '🔎 Run the two-readings test') : null));
    return box;
  }
  function ledgerCard() {
    const l = info.ledger;
    if (!l) return null;
    const c = l.counts || {}; const dec = l.decisions || {};
    const changed = (l.items || []).filter(i => i.kind !== 'retained');
    const sels = {};
    const box = h('section', { class: 'card', 'data-testid': 'cont-ledger' }, h('h2', null, '🧾 Version ledger'),
      h('p', null, `Against the ${(l.source || {}).kind || 'earlier'} of “${(l.source || {}).title || '?'}”: `,
        h('strong', null, `${c.retained || 0} retained · ${c.replaced || 0} replaced · ${c.removed || 0} removed · ${c.unresolved || 0} unresolved`), c.restore ? ` · ${c.restore} to restore` : ''),
      (l.old_on_page || []).length ? h('p', { class: 'small words-warn' }, '⚠️ Old names still in this book: ', l.old_on_page.map(o => `${o.name} (chapter ${o.chapters.join(', ')})`).join('; ')) : null);
    if (changed.length) {
      box.appendChild(h('ul', { class: 'small' }, changed.slice(0, 80).map(i => {
        const sel = h('select', { 'aria-label': `Decision for ${i.label}` }, Object.entries(DECISION_WORDS).map(([k, v]) => h('option', { value: k, selected: ((dec[i.id] || {}).status || 'unresolved') === k }, v)));
        sels[i.id] = sel;
        return h('li', null, h('strong', null, `${i.label}: `), i.kind === 'removed' ? `removed (was: ${i.old})` : i.kind === 'added' ? `new — ${i.new}` : `now “${i.new}” (was “${i.old}”)`, ' ', sel);
      })));
      box.appendChild(h('p', { class: 'row' }, h('button', { type: 'button', class: 'small primary', onclick: () => {
        const d = {}; for (const [k, s] of Object.entries(sels)) if (s.value !== ((dec[k] || {}).status || 'unresolved')) d[k] = s.value;
        if (!Object.keys(d).length) { x.toast('Nothing changed'); return; }
        post('POST', '/review/continuity/ledger/decide', { author_confirms: true, version: l.version, decisions: d }, 'Not saved');
      } }, 'Save decisions'), h('button', { type: 'button', class: 'small', onclick: () => post('POST', '/review/continuity/ledger', {}, 'Could not compare') }, '🔄 Compare again')));
    } else box.appendChild(h('p', { class: 'small muted' }, 'Nothing changed against the earlier version.'));
    return box;
  }
  function render() {
    clear(body);
    const rows = info.chapters || [];
    body.appendChild(h('p', { class: 'row' },
      rows.length ? h('button', { type: 'button', class: 'primary', onclick: () => job('/review/continuity/track', {}, 'Tracking the chapters') }, '🧭 Track the chapters with AI') : null,
      rows.length ? h('button', { type: 'button', onclick: () => post('POST', '/review/continuity/track', { ai: false }, 'Could not read the chapters') }, '⚡ Quick read (no AI)') : null,
      !rows.length ? h('span', { class: 'muted' }, 'No chapter is written yet: the state is tracked from the written chapters.') : null));
    const led = ledgerCard();
    if (led) body.appendChild(led);
    body.appendChild(checksCard());
    for (const r of rows) body.appendChild(chapterCard(r));
    body.appendChild(variablesCard());
    body.appendChild(readingsCard());
  }
  render();
}
