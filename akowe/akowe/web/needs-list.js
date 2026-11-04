/* 🧠 Smart memory: a chapter's needs list (needs_list.py) as a readable line, every code hoverable (its plain name and
   the details it covers) and the whole list expandable. Used by the chapter page (app.js, ✅ Planned to page) and the
   Book Bible's chapter page (binder.js). `info` = needs_list.page_info: {needs: {line, things, notes, earlier,
   dropped}, smart_memory: {chars, old_chars, saved_pct, line}, not_planned: [plain]}. */

const tipOf = s => `${s.code} ${s.label}${s.about ? ` (about ${s.about})` : ''}: ${(s.fields || []).map(([c, l]) => `${c} ${l}`).join(' · ')}`;

/** A hoverable / focusable code: "C11" with "C11 Looks: C1a Overall look · C1b …" as its tooltip. */
function codeEl(h, s) {
  return h('abbr', { class: 'nl-code', tabindex: '0', title: tipOf(s), 'data-code': s.code }, s.code, s.about ? `(${s.about})` : '');
}

function joined(h, secs) {
  const out = [];
  secs.forEach((s, i) => { if (i) out.push(', '); out.push(codeEl(h, s)); });
  return out;
}

/** The 🧠 box, or null when the chapter has neither a needs list nor numbers. */
export function needsBox(h, info, { number = null, testid = 'needs-list' } = {}) {
  if (!info || (!info.needs && !info.smart_memory)) return null;
  const n = info.needs;
  const box = h('div', { class: 'needs-box small', 'data-testid': testid });
  if (n) {
    const bits = [];
    (n.things || []).forEach(t => bits.push([h('strong', null, t.short || t.thing), ' ', ...joined(h, t.sections || [])]));
    if ((n.notes || []).length) bits.push([h('strong', null, 'Notes'), ' ', ...joined(h, n.notes)]);
    if ((n.earlier || []).length) bits.push([h('strong', null, 'Earlier:'), ' ', n.earlier.map(e => `chapter ${e.chapter} (${e.moment})`).join('; ')]);
    const line = [];
    bits.forEach((b, i) => { if (i) line.push(' · '); line.push(...b); });
    box.appendChild(h('p', { class: 'nl-line', 'data-testid': `${testid}-line` }, h('span', { 'aria-hidden': 'true' }, '🧠 '),
      number ? `Chapter ${number} needs: ` : 'This chapter needs: ', ...line));
    box.appendChild(h('details', { class: 'nl-details' }, h('summary', null, 'What these codes mean'),
      h('ul', { class: 'plain-list' }, [
        ...(n.things || []).map(t => h('li', null, h('strong', null, t.thing), t.note ? h('span', { class: 'muted' }, ` — ${t.note}`) : null,
          h('ul', null, (t.sections || []).map(s => h('li', null, h('code', null, s.code), ` ${s.label}${s.about ? ` (about ${s.about})` : ''}: `,
            h('span', { class: 'muted' }, (s.fields || []).map(([c, l]) => `${c} ${l}`).join(' · '))))))),
        ...((n.notes || []).length ? [h('li', null, h('strong', null, 'Running notes'), h('ul', null, n.notes.map(s => h('li', null, h('code', null, s.code), ` ${s.label}${s.about ? ` (about ${s.about})` : ''}`))))] : []),
      ]),
      (n.dropped || []).length ? h('p', { class: 'muted' }, 'Left out of the plan’s list: ' + n.dropped.join(' · ')) : null));
  }
  if (info.smart_memory && info.smart_memory.old_chars) {
    box.appendChild(h('p', { class: 'muted', 'data-testid': `${testid}-saved` }, `${info.smart_memory.line} for this chapter (${Number(info.smart_memory.chars).toLocaleString()} characters of instructions instead of ${Number(info.smart_memory.old_chars).toLocaleString()}).`));
  }
  if ((info.not_planned || []).length) {
    box.appendChild(h('p', { class: 'muted', 'data-testid': `${testid}-unplanned` }, 'Also used: ' +info.not_planned.join(' · ')));
  }
  return box;
}
