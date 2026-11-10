// 🏆 Who writes best (writer_record.py) and 🤫 Hide the twist better (twist_guard.py): the Settings › AI cards.
// app.js passes its helpers in (s7c()), so this module never reaches into app.js. DOM APIs only (never innerHTML).

const WHERE = { step: 'Settings › AI' };

function fresh(c, box, ...kids) { c.clear(box); for (const k of kids) if (k) box.appendChild(k); }

/** 🏆 One plain line per AI (its chapters' average score) and the switch "Let the best writer write more". */
export function writerCard(c) {
  const { h, api, toast, problemBox, toProblem } = c;
  const box = h('div', { 'aria-live': 'polite' });
  const card = h('section', { class: 'card wr-record', 'aria-labelledby': 'wr-record-h', 'data-testid': 'wr-record' },
    h('h2', { id: 'wr-record-h' }, '🏆 Who writes best'), box);
  const draw = d => {
    const on = h('input', { type: 'checkbox', id: 'wr-pick-on', 'data-testid': 'wr-pick-on', checked: !!d.enabled });
    on.addEventListener('change', async () => {
      try { draw(await api('PUT', '/settings/writer-pick', { body: { enabled: on.checked } })); toast('Saved'); }
      catch (e) { box.appendChild(problemBox(toProblem(e, WHERE))); }
    });
    fresh(c, box, h('p', { class: 'small' }, d.about),
      h('ul', { class: 'plain-list wr-rows' }, (d.ais || []).map(a => h('li', { class: `wr-row${a.enough ? '' : ' ck-small'}`, 'data-family': a.family, 'data-testid': 'wr-record-row' }, h('strong', null, a.words)))),
      h('p', { class: 'small muted', 'data-testid': 'wr-record-order' }, d.order_words),
      h('div', { class: 'check-row field' }, on, h('label', { for: 'wr-pick-on' }, h('strong', null, 'Let the AI whose chapters score best write most chapters'))));
  };
  (async () => {
    try { draw(await api('GET', '/writers/record')); } catch (e) { fresh(c, box, problemBox(toProblem(e, WHERE))); }
  })();
  return card;
}

/** 🤫 The switch for the twist-hiding planning rules. */
export function twistCard(c) {
  const { h, api, toast, problemBox, toProblem } = c;
  const box = h('div', { 'aria-live': 'polite' });
  const card = h('section', { class: 'card', 'aria-labelledby': 'tg-h', 'data-testid': 'tg-card' }, h('h2', { id: 'tg-h' }, '🤫 Hide the twist better'), box);
  (async () => {
    let cur;
    try { cur = await api('GET', '/settings/twist-guard'); } catch (e) { fresh(c, box, problemBox(toProblem(e, WHERE))); return; }
    const on = h('input', { type: 'checkbox', id: 'tg-on', 'data-testid': 'tg-on', checked: !!cur.enabled });
    on.addEventListener('change', async () => {
      try { await api('PUT', '/settings/twist-guard', { body: { enabled: on.checked } }); toast('Saved'); }
      catch (e) { box.appendChild(problemBox(toProblem(e, WHERE))); }
    });
    fresh(c, box, h('p', { class: 'small' }, 'When the plan is made, every clue to a secret also gets an innocent explanation, there is at least one fair red herring, and readers should not be able to work out the twist before about two-thirds of the book. The chapters before that point are told not to confirm or hint too hard at the secret. No extra AI work.'),
      h('div', { class: 'check-row field' }, on, h('label', { for: 'tg-on' }, h('strong', null, 'Hide twists and secrets better when planning'))));
  })();
  return card;
}
