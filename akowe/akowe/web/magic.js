/* ✨ Magic rules that are kept (magic_rules.py): the structured fields of an ability / spell / device rule in the
   Story rules form, a one-line summary under the rule, and the "Magic rules" card of the Story rules page — the
   abilities, the use ledger per chapter, the broken rules and the deliberate twists the author allows.
   The helpers of app.js are passed in (this module has no state of its own). API: /review/magic. */

const FIELD_KEYS = ['name', 'does', 'requires', 'limits', 'price', 'who', 'exceptions', 'start', 'words'];
const MULTI = { requires: true, limits: true };

/** The ✨ fields inside one rule of the Story rules form. Returns { el, collect() } (collect: null when no name). */
export function magicFields(x, rule, fields) {
  const { h, uid, tipLabel } = x;
  const mg = (rule || {}).magic || {};
  const F = Object.fromEntries((fields || []).map(f => [f.key, f]));
  const k = uid('mg');
  const inputs = {};
  const rows = FIELD_KEYS.filter(key => F[key]).map(key => {
    const id = `${k}-${key}`;
    const el = MULTI[key] ? h('textarea', { id, rows: '3', 'data-mk': key }) : h('input', { type: 'text', id, 'data-mk': key });
    const v = mg[key];
    el.value = Array.isArray(v) ? v.join('\n') : (v || '');
    if (key === 'exceptions') el.placeholder = 'none';
    if (key === 'requires') el.placeholder = '2 anchor stones\nline of sight\nat night only';
    if (key === 'limits') el.placeholder = '3 times a day\ncooldown 1 hour';
    inputs[key] = el;
    return h('div', { class: 'field' }, tipLabel(id, F[key].label, F[key].help), el);
  });
  const el = h('details', { class: 'magic-fields', 'data-testid': 'magic-fields', open: mg.name ? true : null },
    h('summary', null, '✨ This rule is an ability, spell or magical device'),
    h('p', { class: 'small muted' }, 'Fill this in and Akọwe checks every use in every chapter: what it needs is there and used up, it stays inside its limits and its price is paid. Leave the name empty for an ordinary rule.'),
    ...rows);
  const collect = () => {
    const out = Object.fromEntries(Object.entries(inputs).map(([key, i]) => [key, MULTI[key] ? i.value.split('\n').map(s => s.trim()).filter(Boolean) : i.value.trim()]));
    return out.name ? out : null;
  };
  return { el, collect };
}

/** One short line under a rule that carries ✨ structured fields. */
export function magicSummary(h, mg) {
  if (!mg || !mg.name) return null;
  const bits = [];
  if ((mg.requires || []).length) bits.push(`needs ${mg.requires.join(', ')}`);
  if ((mg.limits || []).length) bits.push(`limits: ${mg.limits.join(', ')}`);
  if (mg.price) bits.push(`price: ${mg.price}`);
  if (mg.who) bits.push(`only ${mg.who}`);
  bits.push(mg.exceptions ? `exceptions: ${mg.exceptions}` : 'no exceptions');
  return h('p', { class: 'small', 'data-testid': 'magic-summary' }, h('span', { class: 'muted' }, `✨ ${mg.name}: `), bits.join(' · '));
}

/** The ✨ Magic rules card of the Story rules page. Returns { el, refresh }. */
export function magicCard(x) {
  const { h, clear, api, bpath, toast, infoTip } = x;
  const box = h('section', { class: 'card world-card', 'aria-labelledby': 'mg-h', 'data-testid': 'magic-card' });
  const where = { book: x.S.project.name, step: 'Magic rules' };
  const refresh = async () => {
    let info;
    try { info = await api('GET', bpath('/review/magic')); }
    catch (e) { clear(box).appendChild(x.problemBox(x.toProblem(e, where), { retry: refresh }, 'Could not load the magic rules')); return; }
    clear(box).appendChild(h('div', { class: 'row space' }, h('h2', { id: 'mg-h' }, '✨ Magic rules'),
      infoTip('Magic rules',
        h('p', null, 'For every ability, spell or device in your story rules (✨ in the rule form), Akọwe reads each chapter and keeps a ledger: who used what, what it cost, what people still hold.'),
        h('p', null, 'A use that breaks its rule (not enough of what it needs, the wrong time, too often, someone who cannot use it) is a must-fix note for the editor before the chapter is approved.'),
        h('p', null, 'A rule-break you want on purpose: write “deliberate twist” in that chapter’s outline, or add it below.'))));
    const toggleId = x.uid('mg-on');
    const toggle = h('input', { type: 'checkbox', id: toggleId, checked: info.enabled ? true : null, 'data-testid': 'magic-enabled' });
    toggle.addEventListener('change', async () => {
      try { const out = await api('PUT', bpath('/review/magic/settings'), { body: { enabled: toggle.checked } }); toast(out.message); await refresh(); }
      catch (e) { toggle.checked = !toggle.checked; box.appendChild(x.problemBox(x.toProblem(e, where), {}, 'Not saved')); }
    });
    box.appendChild(h('p', { class: 'small' }, toggle, ' ', h('label', { for: toggleId }, 'Check the magic rules in every chapter')));
    if (!info.enabled) { box.appendChild(h('p', { class: 'small muted' }, info.line)); return; }
    if (!(info.abilities || []).length) {
      box.appendChild(x.stateBox('empty', 'No magic rule yet', h('p', null, 'Change the story rules and tick “✨ This rule is an ability, spell or magical device” — e.g. Teleportation needs 2 anchor stones, at night only, 3 times a day.')));
      return;
    }
    box.appendChild(h('p', { 'data-testid': 'magic-line' }, h('strong', null, info.line)));
    box.appendChild(h('ul', { class: 'rule-list' }, info.abilities.map(a => h('li', { 'data-ability': a.name },
      h('p', null, h('strong', null, a.name), a.does ? ` — ${a.does}` : '', a.read_from_text ? h('span', { class: 'small muted' }, ' (read from the rule’s text)') : null),
      h('p', { class: 'small' }, h('span', { class: 'muted' }, 'Needs: '), (a.needs || []).join(', ') || 'nothing counted',
        h('span', { class: 'muted' }, ' · Limits: '), (a.limits || []).join(', ') || 'none stated',
        a.price ? [h('span', { class: 'muted' }, ' · Price: '), a.price] : null, a.who ? [h('span', { class: 'muted' }, ' · Who: '), a.who] : null,
        h('span', { class: 'muted' }, ' · Exceptions: '), a.exceptions || 'none')))));
    if ((info.state || []).length) box.appendChild(h('div', { 'data-testid': 'magic-state' }, h('h3', null, '🎒 What people hold now'), h('ul', null, info.state.map(s => h('li', { class: 'small' }, s)))));
    const rows = (info.chapters || []).filter(c => (c.uses || []).length || (c.gains || []).length);
    if (rows.length) {
      box.appendChild(h('h3', null, '📒 Uses chapter by chapter'));
      box.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'rp-table', 'data-testid': 'magic-ledger' },
        h('thead', null, h('tr', null, h('th', null, 'Chapter'), h('th', null, 'Who'), h('th', null, 'Used'), h('th', null, 'Paid'), h('th', null, 'Rule'))),
        h('tbody', null, rows.flatMap(c => (c.uses || []).map(u => h('tr', { class: u.ok ? '' : 'low' },
          h('td', { class: 'num' }, String(c.number)), h('td', null, u.who || '?'), h('td', null, u.ability),
          h('td', { class: 'small' }, (u.paid || []).join(', ') || '–'),
          h('td', null, u.ok ? (u.deliberate ? '🎭 deliberate twist' : '✔ kept') : '✕ broken'))))))));
    }
    const probs = info.problems || [];
    if (probs.length) {
      box.appendChild(h('h3', null, '⚠️ What to fix'));
      box.appendChild(h('ul', { 'data-testid': 'magic-problems' }, probs.map(p => h('li', { class: 'small' },
        p.allowed ? '🎭 ' : p.severity === 'major' ? '✕ ' : '• ', h('strong', null, `${p.label}: `), p.message,
        p.allowed ? h('span', { class: 'muted' }, ` (allowed: ${p.allowed})`) : null,
        p.quote ? h('span', { class: 'muted' }, ` — “${p.quote}”`) : null))));
    }
    box.appendChild(breaksForm(x, info, refresh, where));
  };
  box.appendChild(x.loadingState('Loading the magic rules…'));
  return { el: box, refresh };
}

function breaksForm(x, info, refresh, where) {
  const { h, clear, api, bpath, toast } = x;
  const list = h('div');
  const row = b => {
    const n = h('input', { type: 'number', min: '1', 'aria-label': 'Chapter', value: (b || {}).chapter || '', class: 'num-input' });
    const ab = h('select', { 'aria-label': 'Ability' }, h('option', { value: '' }, 'any ability'), (info.abilities || []).map(a => h('option', { value: a.name, selected: (b || {}).ability === a.name ? true : null }, a.name)));
    const why = h('input', { type: 'text', 'aria-label': 'Why', placeholder: 'why (e.g. the twist: the stones were fake)', value: (b || {}).why || '' });
    const r = h('div', { class: 'row', 'data-testid': 'magic-break' }, h('span', { class: 'small' }, 'Chapter'), n, ab, why, h('button', { type: 'button', class: 'small link', onclick: () => r.remove() }, 'Remove'));
    r.collect = () => ({ chapter: parseInt(n.value, 10), ability: ab.value, why: why.value.trim() });
    list.appendChild(r);
  };
  (info.allowed_breaks || []).forEach(row);
  const msg = h('div', { 'aria-live': 'polite' });
  return h('details', { class: 'magic-breaks' }, h('summary', null, `🎭 Deliberate rule-breaks (${(info.allowed_breaks || []).length})`),
    h('p', { class: 'small muted' }, 'A rule broken on purpose is allowed in these chapters (it is still shown, as a deliberate twist).'),
    list, h('div', { class: 'row' }, h('button', { type: 'button', class: 'small', onclick: () => row({}) }, '+ Add one'),
      h('button', { type: 'button', class: 'small primary', 'data-testid': 'magic-breaks-save', onclick: async () => {
        clear(msg);
        const breaks = [...list.children].map(r => r.collect()).filter(b => b.chapter > 0);
        try { const out = await api('PUT', bpath('/review/magic/settings'), { body: { allowed_breaks: breaks } }); toast(out.message); await refresh(); }
        catch (e) { msg.appendChild(x.problemBox(x.toProblem(e, where), {}, 'Not saved')); }
      } }, '💾 Save')), msg);
}
