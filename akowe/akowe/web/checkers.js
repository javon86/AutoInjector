// 📊 How good is each checker (checker_record.py), 🔢 which AI checks first / never checks (checker_order.py) and 🧑‍⚖️
// the stand-in decider (stand_in.py): the Settings cards, the Make-a-book field, the run window's notes with ↩ Undo,
// the run report card and Book home's list. app.js passes its helpers in (s7c()), so this module never reaches into
// app.js. All data is rendered with DOM APIs (never innerHTML).

const WHERE = { step: 'Settings › AI' };

function fresh(c, box, ...kids) { c.clear(box); for (const k of kids) if (k) box.appendChild(k); }

/** 📊 "How good is each checker": one plain line per AI, small samples labelled. opts.compact: a folded card. */
export function recordCard(c, opts = {}) {
  const { h, api, problemBox, toProblem } = c;
  const box = h('div', { 'aria-live': 'polite' });
  const testid = opts.testid || 'ck-record';
  const card = opts.compact
    ? h('details', { class: 'ck-record small', 'data-testid': testid }, h('summary', null, '📊 How good is each checker'), box)
    : h('section', { class: 'card ck-record', 'aria-labelledby': `${testid}-h`, 'data-testid': testid },
      h('h2', { id: `${testid}-h` }, '📊 How good is each checker'), box);
  (async () => {
    let d;
    try { d = await api('GET', '/checkers/record'); } catch (e) { fresh(c, box, problemBox(toProblem(e, WHERE))); return; }
    const rows = (d.ais || []).map(a => h('li', { class: `ck-row${a.enough ? '' : ' ck-small'}`, 'data-family': a.family, 'data-testid': 'ck-record-row' },
      h('strong', null, a.words),
      Object.keys(a.kinds || {}).length ? h('ul', { class: 'plain-list small muted' }, Object.entries(a.kinds).map(([, k]) => h('li', null, k.words))) : null));
    fresh(c, box, h('p', { class: 'small' }, d.about),
      h('ul', { class: 'plain-list ck-rows' }, rows),
      h('p', { class: 'small muted', 'data-testid': 'ck-record-order' }, d.order_words));
  })();
  return card;
}

/** 🔢 The order editor (Settings and the Make-a-book screen): mode, the order (↑ ↓), and "don't use for checks". */
function orderEditor(c, prefix, cur, families, onChange) {
  const { h } = c;
  const state = { mode: cur.mode || 'auto', order: (cur.order || []).slice(), off: (cur.off || []).slice() };
  const all = families.map(f => f.family);
  for (const f of all) if (!state.order.includes(f)) state.order.push(f);
  state.order = state.order.filter(f => all.includes(f));
  const nameOf = f => (families.find(x => x.family === f) || { name: f }).name;
  const wrap = h('div', { class: 'ck-editor' });
  const draw = () => {
    c.clear(wrap);
    const mode = h('select', { id: `${prefix}-ck-mode`, 'data-testid': `${prefix}-ck-mode` },
      h('option', { value: 'auto' }, 'Automatic: best track record first'), h('option', { value: 'manual' }, 'My own order'));
    mode.value = state.mode;
    mode.addEventListener('change', () => { state.mode = mode.value; draw(); onChange(state); });
    const list = h('ol', { class: 'ck-order', 'data-testid': `${prefix}-ck-order` }, state.order.map((f, i) => {
      const off = state.off.includes(f);
      const box = h('input', { type: 'checkbox', id: `${prefix}-ck-off-${f}`, 'data-testid': `${prefix}-ck-off-${f}`, checked: off });
      box.addEventListener('change', () => { state.off = box.checked ? state.off.concat([f]) : state.off.filter(x => x !== f); draw(); onChange(state); });
      const up = h('button', { type: 'button', class: 'small', 'aria-label': `Move ${nameOf(f)} up`, 'data-testid': `${prefix}-ck-up-${f}`, disabled: state.mode !== 'manual' || i === 0,
        onclick: () => { state.order.splice(i - 1, 0, state.order.splice(i, 1)[0]); draw(); onChange(state); } }, '↑');
      const down = h('button', { type: 'button', class: 'small', 'aria-label': `Move ${nameOf(f)} down`, disabled: state.mode !== 'manual' || i === state.order.length - 1,
        onclick: () => { state.order.splice(i + 1, 0, state.order.splice(i, 1)[0]); draw(); onChange(state); } }, '↓');
      return h('li', { class: `ck-item${off ? ' ck-off' : ''}`, 'data-family': f },
        h('span', { class: 'ck-name' }, nameOf(f)), state.mode === 'manual' ? [' ', up, down] : null, ' ',
        h('span', { class: 'check-row ck-off-row' }, box, h('label', { for: `${prefix}-ck-off-${f}` }, 'Don’t use for checks')));
    }));
    wrap.append(h('div', { class: 'field' }, h('label', { for: `${prefix}-ck-mode` }, 'Who checks first'), mode),
      state.mode === 'manual' ? h('p', { class: 'hint' }, 'The first one checks first. Use ↑ and ↓ to change the order.') : h('p', { class: 'hint' }, 'The AI whose corrections held up best checks first — once there is enough data. Until then Akọwe keeps its usual order.'),
      list);
  };
  draw();
  return { el: wrap, get: () => ({ mode: state.mode, order: state.mode === 'manual' ? state.order.slice() : [], off: state.off.slice() }) };
}

/** Settings › AI: 🔢 the checker order card. */
export function orderCard(c) {
  const { h, api, toast, problemBox, toProblem } = c;
  const box = h('div', { 'aria-live': 'polite' });
  const card = h('section', { class: 'card', 'aria-labelledby': 'ck-order-h', 'data-testid': 'ck-order-card' }, h('h2', { id: 'ck-order-h' }, '🔢 Which AI checks first'),
    h('p', { class: 'small' }, 'The AI that writes a draft never checks it while another AI can. Here you choose which of the others checks first, and which AIs never check (they can still write). If switching one off leaves too few checkers, Akọwe says so plainly and carries on with the ones left.'), box);
  (async () => {
    let cur;
    try { cur = await api('GET', '/settings/checkers'); } catch (e) { fresh(c, box, problemBox(toProblem(e, WHERE))); return; }
    const line = h('p', { class: 'small', 'data-testid': 'ck-order-line' });
    const say = p => { c.clear(line).append(`Order now: ${p.order_words || '—'}`, p.off_words ? ` · Never checks: ${p.off_words}` : '', p.shortfall ? h('span', { class: 'words-warn ck-short' }, ` ⚠️ ${p.shortfall}`) : ''); };
    say(cur);
    const ed = orderEditor(c, 'st', cur.policy, cur.families, () => {});
    const save = h('button', { type: 'button', class: 'small primary', 'data-testid': 'ck-order-save', onclick: async () => {
      try { const p = await api('PUT', '/settings/checkers', { body: ed.get() }); say(p); toast('Saved'); }
      catch (e) { box.appendChild(problemBox(toProblem(e, WHERE))); }
    } }, 'Save');
    fresh(c, box, ed.el, line, h('div', { class: 'row' }, save));
  })();
  return card;
}

/** Settings › AI: 🧑‍⚖️ the stand-in decider card. */
export function standInCard(c) {
  const { h, api, toast, problemBox, toProblem } = c;
  const box = h('div', { 'aria-live': 'polite' });
  const card = h('section', { class: 'card', 'aria-labelledby': 'si-h', 'data-testid': 'si-card' }, h('h2', { id: 'si-h' }, '🧑‍⚖️ Stand-in when I don’t answer'), box);
  (async () => {
    let cur;
    try { cur = await api('GET', '/settings/stand-in'); } catch (e) { fresh(c, box, problemBox(toProblem(e, WHERE))); return; }
    const on = h('input', { type: 'checkbox', id: 'si-on', 'data-testid': 'si-on', checked: !!cur.enabled });
    const wait = h('select', { id: 'si-wait', 'data-testid': 'si-wait' }, (cur.waits || [10, 20, 30, 60]).map(m => h('option', { value: String(m) }, `${m} minutes`)));
    wait.value = String(cur.wait_min);
    const max = h('input', { type: 'number', id: 'si-max', min: '1', max: '20', value: String(cur.max_per_run), class: 'wz-num' });
    const cps = h('input', { type: 'checkbox', id: 'si-cp', 'data-testid': 'si-cp', checked: cur.checkpoints !== false });
    // 🗳 when something goes wrong, let the AIs vote instead of stopping (stand_in_errors.py) — off by default
    const err = h('input', { type: 'checkbox', id: 'si-err', 'data-testid': 'si-err', checked: !!cur.errors });
    const when = h('select', { id: 'si-err-when', 'data-testid': 'si-err-when' },
      h('option', { value: 'now' }, 'Right away'), h('option', { value: 'wait' }, 'After the usual wait time'));
    when.value = cur.errors_when === 'now' ? 'now' : 'wait';
    const [ccLo, ccHi] = cur.cc_voters_range || [0, 3];
    const cc = h('select', { id: 'si-err-cc', 'data-testid': 'si-err-cc' },
      Array.from({ length: ccHi - ccLo + 1 }, (_x, i) => ccLo + i).map(n => h('option', { value: String(n) }, n === 0 ? 'None' : `${n} Claude Code helper${n > 1 ? 's' : ''}`)));
    cc.value = String(cur.cc_voters ?? 1);
    const errMore = h('div', { 'data-testid': 'si-err-more', hidden: !err.checked },
      h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', { for: 'si-err-when' }, 'When the AIs vote'), when),
        h('div', { class: 'field' }, h('label', { for: 'si-err-cc' }, 'Claude’s agents vote too (extra voters)'), cc)),
      h('p', { class: 'hint', 'data-testid': 'si-err-hint' }, 'Every voter must agree, so an extra Claude Code helper can only stop a decision, never force one. Each helper votes on its own, with its own reviewer persona.'));
    err.addEventListener('change', () => { errMore.hidden = !err.checked; });
    let maxTouched = false;
    max.addEventListener('input', () => { maxTouched = true; });
    const save = h('button', { type: 'button', class: 'small primary', 'data-testid': 'si-save', onclick: async () => {
      try {
        const body = { enabled: on.checked, wait_min: Number(wait.value), checkpoints: cps.checked, errors: err.checked, errors_when: when.value, cc_voters: Number(cc.value) };
        if (maxTouched || cur.max_set) body.max_per_run = Number(max.value) || 5;  // else 🗳 raises the cap to 10 by itself
        const out = await api('PUT', '/settings/stand-in', { body });
        if (out && out.max_per_run) max.value = String(out.max_per_run);
        toast('Saved');
      } catch (e) { box.appendChild(problemBox(toProblem(e, WHERE))); }
    } }, 'Save');
    fresh(c, box, h('p', { class: 'small' }, cur.about),
      h('div', { class: 'check-row field' }, on, h('label', { for: 'si-on' }, h('strong', null, 'Let the AIs decide a disagreement when I don’t answer — only if they all agree'))),
      h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', { for: 'si-wait' }, 'Wait for me first'), wait),
        h('div', { class: 'field' }, h('label', { for: 'si-max' }, 'At most this many stand-in decisions per book run'), max)),
      h('div', { class: 'check-row field' }, cps, h('label', { for: 'si-cp' }, 'Also the 🧭 story checks (continuity checkpoints): leave a problem as it is for now, or make the small fix offered — only if every problem can be voted on and they all agree')),
      h('p', { class: 'hint' }, 'Two AIs working: both must agree. Three AIs working: all three must agree. Only one AI working, or any AI disagrees or is unsure: it waits for you.'),
      h('div', { class: 'check-row field' }, err, h('label', { for: 'si-err' }, h('strong', null, '🗳 When something goes wrong, let the AIs vote instead of stopping'))),
      h('p', { class: 'small', 'data-testid': 'si-err-about' }, cur.errors_about || ''),
      errMore,
      h('div', { class: 'row' }, save));
  })();
  return card;
}

/** ⚡ Make a book: one compact line ("Checkers: Automatic · Gemini never checks [Change]") that opens the editor. */
export function makeSetupField(c) {
  const { h, api } = c;
  const line = h('span', { class: 'small', 'data-testid': 'mb-ck-line' }, 'Checkers: …');
  const holder = h('div', { hidden: true, 'data-testid': 'mb-ck-editor' });
  let ed = null; let base = null; let dirty = false; let prev = null;
  const words = (pol, p) => {
    const names = Object.fromEntries((p.families || []).map(f => [f.family, f.name]));
    const order = pol.mode === 'manual' && pol.order.length ? pol.order.filter(f => !pol.off.includes(f)).map(f => names[f] || f).join(' → ') : 'Automatic (best track record first)';
    const off = pol.off.map(f => names[f] || f);
    return `Checkers: ${order}${off.length ? ` · ${off.join(' and ')} never check${off.length === 1 ? 's' : ''}` : ''}`;
  };
  const btn = h('button', { type: 'button', class: 'small', 'data-testid': 'mb-ck-change', 'aria-expanded': 'false', onclick: () => {
    holder.hidden = !holder.hidden; btn.setAttribute('aria-expanded', String(!holder.hidden)); btn.textContent = holder.hidden ? 'Change' : 'Done';
  } }, 'Change');
  const short = h('p', { class: 'words-warn small', hidden: true, 'data-testid': 'mb-ck-short' });
  const el = h('div', { class: 'field ck-make' }, h('div', { class: 'row' }, line, btn), short, holder);
  (async () => {
    try { prev = await api('GET', '/settings/checkers'); } catch { c.clear(line).append('Checkers: automatic'); btn.hidden = true; return; }
    base = prev.policy;
    c.clear(line).append(words(base, prev));
    if (prev.shortfall) { short.hidden = false; short.textContent = `⚠️ ${prev.shortfall}`; }
    ed = orderEditor(c, 'mb', base, prev.families, pol => { dirty = true; c.clear(line).append(words(pol, prev)); short.hidden = true; });
    holder.appendChild(ed.el);
    holder.appendChild(h('p', { class: 'hint' }, 'For this book only. Settings › 🔢 Which AI checks first keeps your usual choice.'));
  })();
  return { el, apply(body) { if (dirty && ed) body.checker_order = ed.get(); } };
}

/** The run window and Book home: one note per stand-in decision ("ChatGPT and Gemini both agreed to … Why: …") with ↩ Undo. */
export function decisionList(c, decisions, runIdOf, after, testid = 'si-note') {
  const { h, api, toast, problemBox, toProblem } = c;
  if (!(decisions || []).length) return null;
  const err = h('div', { 'aria-live': 'polite' });
  return h('div', { class: 'si-notes', 'data-testid': `${testid}s` }, decisions.map(d => h('p', { class: `small si-note${d.undone ? ' si-undone' : ''}`, 'data-testid': testid, 'data-decision': d.id },
    h('span', { 'aria-hidden': 'true' }, `${d.icon || '🧑‍⚖️'} `), d.line, ' ',
    d.undone ? h('em', { class: 'muted' }, d.undone_words || '(undone — the other option waits for your approval)')
      : h('button', { type: 'button', class: 'small', 'data-testid': `${testid}-undo`, onclick: async ev => {
        ev.currentTarget.disabled = true;
        try { const out = await api('POST', `/autobook/${encodeURIComponent(runIdOf(d))}/stand-in-undo`, { body: { decision_id: d.id } }); toast(out.message || 'Undone'); if (after) after(out); }
        catch (e) { err.appendChild(problemBox(toProblem(e, { step: 'Undo the stand-in’s decision' }))); ev.currentTarget.disabled = false; }
      } }, '↩ Undo'))), err);
}

/** The run window: the stand-in's decisions of this run, and while it waits, when a stand-in steps in. */
export function runNotes(c, r, after) {
  const { h } = c;
  const si = r && r.stand_in;
  if (!si) return null;
  const list = decisionList(c, si.decisions, () => r.id, after);
  const pend = si.pending && si.pending.words && ['waiting', 'waits', 'cap'].includes(si.pending.state)
    ? h('p', { class: 'small muted', 'data-testid': 'si-pending' }, '🧑‍⚖️ ', si.pending.words) : null;
  if (!list && !pend) return null;
  return h('div', { class: 'si-run' }, pend, list);
}

/** 🏠 Book home: the stand-in decisions of this book. */
export function bookNotes(c, items, after) {
  const { h } = c;
  const list = decisionList(c, items, d => d.run_id, after, 'si-book-note');
  if (!list) return null;
  return h('section', { class: 'card si-book', 'data-testid': 'si-book', 'aria-label': 'Decided by a stand-in' },
    h('h2', null, '🧑‍⚖️ Decided for you while you were away'), list);
}
