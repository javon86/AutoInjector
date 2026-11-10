/* ⚡ Make a book: planning before the start (3d, 3e, 6c).
 *  - planBox: ⏱ the estimate (time range, answers per AI, will a usage limit pause it and when) — POST /api/estimate
 *  - meterBox: 📊 the usage meter per AI (answers today, last limit hit, reset time, a colour) — GET /api/usage-meter
 *  - startLaterField / scheduledView: ⏰ start the run at a time (run_schedule.py) with a countdown and Cancel
 *  - pasteButton: 📋 Paste starter sheet — POST /api/starter-sheet/parse, a summary, then the caller fills the form
 * Plain words; no book text is ever logged. */

const COLOUR_WORD = { red: 'At its limit', amber: 'Close / hit lately', green: 'Fine', grey: 'Not connected' };

function minutesWords(m) {
  m = Math.max(1, Math.round(Number(m) || 0));
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
function clockOf(epochS) {
  try { return new Date(epochS * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
}
function dayWord(epochS) {
  const d = new Date(epochS * 1000), now = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, now)) return 'today';
  const t = new Date(now); t.setDate(now.getDate() + 1);
  if (same(d, t)) return 'tomorrow';
  try { return d.toLocaleDateString([], { weekday: 'long' }); } catch { return ''; }
}
export function countdownWords(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(sec).padStart(2, '0')} s`;
  return `${sec} s`;
}

/* ======================================================================= ⏱ 3d the estimate */
/** {el, refresh}: the estimate for the body getBody() returns (the same body Start sends). */
export function planBox(c, getBody) {
  const { h, api, clear } = c;
  const el = h('div', { class: 'small mb-estimate mb-plan', 'data-testid': 'mb-estimate', 'aria-live': 'polite' }, '⏱ Estimating…');
  let seq = 0, timer = null;
  const draw = e => {
    const m = e.minutes, k = e.calls;
    const per = e.chapters ? Math.round(e.words / e.chapters) : 0;
    const main = h('p', { class: 'mb-est-main' }, h('span', { 'aria-hidden': 'true' }, '⏱ '), h('strong', null, 'Estimate: '),
      `this run will probably take ${e.time_words || `about ${minutesWords(m.low)}–${minutesWords(m.high)}`} · ${k.low}–${k.high} AI answers`,
      h('span', { class: 'muted' }, ` (${e.chapters} chapters of ~${per.toLocaleString()} words${e.scene_by_scene ? ', written scene by scene' : ''}).`));
    const ais = (e.ais || []).length ? h('ul', { class: 'plain-list mb-est-ais', 'data-testid': 'mb-est-ais', 'aria-label': 'AI answers per AI' },
      e.ais.map(a => h('li', { class: `mb-est-ai st-${a.status}`, 'data-status': a.status, 'data-family': a.family || '' },
        h('span', { 'aria-hidden': 'true' }, a.status === 'limit' ? '⚠️ ' : a.status === 'close' ? '🟠 ' : '✔ '), a.line))) : null;
    const lim = (e.limits || []).length
      ? h('p', { class: 'words-warn mb-est-limits', 'data-testid': 'mb-est-limits', role: 'note' }, h('span', { 'aria-hidden': 'true' }, '⏳ '),
        `Usage limits: ${e.limits.join('. ')}.${e.wait_minutes ? ` That adds about ${minutesWords(e.wait_minutes)} of waiting (included above). The run waits and goes on by itself.` : ''}`)
      : h('p', { class: 'mb-est-limits ok', 'data-testid': 'mb-est-limits' }, '✔ No AI should hit its usage limit on this run.');
    const about = h('p', { class: 'muted mb-est-about' }, `It is an estimate: fixes, retries and busy AIs make runs longer. ${e.about || ''}${e.ais_assumed ? ' (No AI is connected yet: Claude, ChatGPT and Gemini assumed.)' : ''}`);
    const pn = e.pen_name || {};  // ✒️ which pen name the book gets, and a ⚠️ when it is a character's name
    const pen = h('p', { class: 'mb-est-pen', 'data-testid': 'mb-est-pen' }, '✒️ ', pn.name ? `Pen name: ${pn.name}${pn.from === 'saved' ? ' (your saved pen name)' : ''}.` : 'No pen name: type yours above (the AI never makes one up).');
    const warns = (e.warnings || []).map(w => h('p', { class: 'words-warn', role: 'note', 'data-testid': 'mb-est-warning' }, w));
    const st = e.style_tip;  // ✒️ an empty writing style card: one plain tip with a link (never blocks the start)
    const tip = st && st.text ? h('p', { class: 'small mb-style-tip', 'data-testid': 'mb-style-tip', role: 'note' },
      h('span', { 'aria-hidden': 'true' }, '💡 '), st.before || '',
      h('a', { href: st.href || '#/style', 'data-testid': 'mb-style-tip-link' }, st.link || 'My writing style'),
      `${st.after || ''} `,
      h('button', { type: 'button', class: 'link small', 'data-testid': 'mb-style-tip-hide', onclick: async ev => {
        ev.target.closest('p').remove();
        try { await api('PUT', '/settings/style-tip', { body: { enabled: false } }); } catch { /* a tip: nothing to do */ }
      } }, 'Don’t show again')) : null;
    clear(el).append(main, ais || '', lim, pen, ...warns, tip || '', about);
  };
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {  // a few changes in a row ask once
      const mine = ++seq;
      let e;
      try { e = await api('POST', '/estimate', { body: getBody() || {} }); } catch { if (mine === seq) clear(el).appendChild(document.createTextNode('⏱ No estimate right now.')); return; }
      if (mine === seq) draw(e);
    }, 150);
  };
  return { el, refresh };
}

/* ======================================================================= 📊 3e the usage meter */
/** {el, refresh}: one small row per AI. ``compact``: one line per AI (the run window). */
export function meterBox(c, { compact = false } = {}) {
  const { h, api, clear } = c;
  const list = h('ul', { class: 'plain-list um-list', 'aria-label': 'Usage of each AI' });
  const note = h('p', { class: 'small muted um-about' });
  const btn = h('button', { type: 'button', class: 'small', 'aria-label': 'Check the usage again', onclick: () => refresh() }, '↻');
  const el = h('div', { class: `usage-meter${compact ? ' compact' : ''}`, 'data-testid': 'usage-meter' },
    h('p', { class: 'small um-head' }, h('strong', null, '📊 How much your AIs have been used'), ' ', btn), list, compact ? null : note);
  let timer = null;
  const draw = m => {
    clear(list);
    if (!(m.ais || []).length) { list.appendChild(h('li', { class: 'small muted' }, 'No AI is connected yet.')); return; }
    for (const a of m.ais) {
      const share = a.share == null ? null : Math.round(a.share * 100);
      list.appendChild(h('li', { class: `um-row um-${a.colour}`, 'data-testid': 'um-row', 'data-colour': a.colour, 'data-key': a.key, title: a.about },
        h('span', { class: 'um-dot', 'aria-hidden': 'true' }), h('strong', null, a.name), ' — ',
        h('span', { class: 'um-word' }, `${COLOUR_WORD[a.colour] || a.word}: `), h('span', { class: 'um-line' }, a.line),
        share != null && !compact ? h('span', { class: 'um-bar', role: 'img', 'aria-label': `about ${share}% of what its plan usually allows in its window (a guess)` },
          h('span', { class: 'um-fill', style: `width:${share}%` })) : null,
        share != null && !compact ? h('span', { class: 'small muted' }, ` ${a.in_window} of ~${a.typical} in its window${a.typical_learned ? ' (seen on this PC)' : ' (a guess)'}`) : null));
    }
    note.textContent = m.about || '';
  };
  const refresh = async () => {
    clearTimeout(timer);
    try { draw(await api('GET', '/usage-meter')); } catch { clear(list).appendChild(h('li', { class: 'small muted' }, 'The usage could not be read right now.')); }
    if (el.isConnected || !timer) timer = setTimeout(() => { if (el.isConnected) refresh(); }, 60000);
  };
  return { el, refresh };
}

/* ======================================================================= ⏰ 3e start later */
/** {el, get(): {iso, epoch, words} | null}: "Start later, at [23:00]". */
export function startLaterField(c, onChange) {
  const { h } = c;
  const on = h('input', { type: 'checkbox', id: 'mb-later-on', 'data-testid': 'mb-later-on', 'aria-describedby': 'mb-later-hint' });
  const time = h('input', { type: 'time', id: 'mb-start-at', 'data-testid': 'mb-start-at', value: '23:00', 'aria-label': 'Start time' });
  const when = h('span', { class: 'small muted', 'data-testid': 'mb-later-when' });
  const get = () => {
    if (!on.checked) return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(time.value || '');
    if (!m) return { error: 'Pick a start time.' };
    const d = new Date(); d.setSeconds(0, 0); d.setHours(Number(m[1]), Number(m[2]));
    if (d.getTime() <= Date.now() + 60000) d.setDate(d.getDate() + 1);  // that time today has passed: tomorrow
    const epoch = Math.round(d.getTime() / 1000);
    return { iso: d.toISOString(), epoch, words: `${clockOf(epoch)} ${dayWord(epoch)}` };
  };
  const show = () => { const g = get(); when.textContent = g && !g.error ? ` — starts ${g.words}` : ''; time.disabled = !on.checked; if (onChange) onChange(g); };
  on.addEventListener('change', show); time.addEventListener('change', show); time.addEventListener('input', show);
  const el = h('fieldset', { class: 'field mb-later', 'data-testid': 'mb-later' }, h('legend', null, '⏰ When to start'),
    h('div', { class: 'check-row' }, on, h('label', { for: 'mb-later-on' }, h('strong', null, 'Start later, at')), ' ', time, when),
    h('p', { class: 'hint', id: 'mb-later-hint' }, 'For example 11 pm, so the AIs work through the night. The run waits and starts by itself at that time while AutoInjector and Akọwe are running; AutoInjector keeps your PC awake while it waits. If Akọwe was closed at that time and it is more than 2 hours late, Akọwe asks you before it starts.'));
  time.disabled = true;
  return { el, get, show };
}

/** The scheduled run in the Make-a-book window: countdown, ▶ Start now, ✖ Cancel (and the "too late — ask" case). */
export function scheduledView(c, s, { onStarted, onCancelled, onSetup, meter } = {}) {
  const { h, api, clear, toast, announce, problemBox, toProblem } = c;
  const box = h('div', { class: 'mb-scheduled', 'data-testid': 'mb-scheduled', 'data-state': s.state });
  const msg = h('div', { 'aria-live': 'polite' });
  let tick = null, poll = null;
  const stop = () => { clearInterval(tick); clearTimeout(poll); };
  const act = async (path, label) => {
    clear(msg);
    try {
      const out = await api('POST', `/autobook/schedule/${path}`, { body: {} });
      stop();
      if (path === 'start-now') {
        if (out.state === 'started' && out.run_id) { announce(label); onStarted && onStarted(out.run_id); return; }
        draw(out); return;
      }
      toast(label); announce(label); onCancelled && onCancelled(out);
    } catch (e) { msg.appendChild(problemBox(toProblem(e, { step: 'The scheduled book' }))); }
  };
  const draw = cur => {
    stop();
    s = cur;
    box.dataset.state = s.state;
    const at = s.at_epoch ? `${clockOf(s.at_epoch)} ${dayWord(s.at_epoch)}` : '';
    const now = h('button', { type: 'button', class: 'primary big', 'data-testid': 'mb-sched-now', onclick: () => act('start-now', 'The book started') }, '▶ Start now');
    const cancel = h('button', { type: 'button', class: 'danger', 'data-testid': 'mb-sched-cancel', onclick: () => act('cancel', 'The scheduled start is cancelled') }, '✖ Cancel the scheduled start');
    const what = s.what ? h('p', { class: 'small muted' }, `${s.what.length ? s.what.length.replace(/_/g, ' ') : 'short story'}${s.what.genre ? ` · ${s.what.genre}` : ''} · your settings and consent are kept until then.`) : null;
    if (s.state === 'waiting') {
      const cd = h('strong', { 'data-testid': 'mb-countdown' }, countdownWords(s.seconds_left));
      const t0 = Date.now(), left0 = s.seconds_left;
      tick = setInterval(() => {
        if (!box.isConnected) { stop(); return; }
        const left = Math.max(0, left0 - Math.round((Date.now() - t0) / 1000));
        cd.textContent = countdownWords(left);
      }, 1000);
      const check = async () => {
        if (!box.isConnected) return;
        try {
          const cur2 = await api('GET', '/autobook/schedule');
          if (cur2.state === 'started' && cur2.run_id) { stop(); onStarted && onStarted(cur2.run_id); return; }
          if (cur2.state !== 'waiting') { draw(cur2); return; }
        } catch { /* try again */ }
        poll = setTimeout(check, Math.min(15000, Math.max(2000, (s.seconds_left - Math.round((Date.now() - t0) / 1000)) * 1000 + 1500)));
      };
      poll = setTimeout(check, Math.min(15000, s.seconds_left * 1000 + 1500));
      clear(box).append(
        h('p', { class: 'lead' }, h('span', { 'aria-hidden': 'true' }, '⏰ '), `Your book is scheduled to start at ${at}.`),
        h('p', null, 'Starts in ', cd, '.'), what,
        h('p', { class: 'small' }, 'Keep AutoInjector and Akọwe running (you can close this window). AutoInjector keeps your PC awake while it waits. If Akọwe is closed at that time, it starts when Akọwe opens again — or, if that is more than 2 hours late, Akọwe asks you first.'),
        meter ? meter.el : '', msg, h('div', { class: 'form-actions' }, now, cancel));
      if (meter) meter.refresh();
    } else if (s.state === 'ask') {
      clear(box).append(
        h('p', { class: 'lead words-warn', role: 'alert' }, h('span', { 'aria-hidden': 'true' }, '⏰ '), `This book was meant to start at ${at}, but Akọwe was not running then. Start it now?`),
        what, msg, h('div', { class: 'form-actions' }, now, cancel));
    } else if (s.state === 'failed') {
      now.textContent = '▶ Try again now';
      clear(box).append(
        h('p', { class: 'words-warn', role: 'alert' }, h('span', { 'aria-hidden': 'true' }, '⚠️ '), `The scheduled book did not start. ${s.message || ''}`),
        msg, h('div', { class: 'form-actions' }, now, cancel,
          h('button', { type: 'button', 'data-testid': 'mb-sched-setup', onclick: async () => { try { await api('POST', '/autobook/schedule/dismiss', { body: {} }); } catch { /* the setup still opens */ } onSetup && onSetup(); } }, 'Change the settings')));
    } else {
      onSetup && onSetup();
    }
  };
  draw(s);
  return box;
}

/* ======================================================================= 📋 6c paste starter sheet */
/** The "📋 Paste starter sheet" button: opens a box, reads the pasted answer, shows what it understood, then
 * apply(result, {trim}) fills the form. */
export function pasteButton(c, apply) {
  const { h, api, clear, problemBox, toProblem, announce } = c;
  const open = btn => {
    const prev = btn;
    const d = h('dialog', { class: 'selftest-dialog choice-dialog paste-dialog', 'aria-labelledby': 'ps-title', 'data-testid': 'paste-dialog' });
    const text = h('textarea', { id: 'ps-text', rows: '12', 'data-testid': 'mb-paste-text', placeholder: 'Paste the AI’s whole answer here — everything, including the part that starts with “AKỌWE STARTER SHEET”.', spellcheck: 'false' });
    const out = h('div', { 'aria-live': 'polite' });
    const close = () => { try { if (d.open) d.close(); } catch { /* ignore */ } d.remove(); try { prev.focus(); } catch { /* ignore */ } };
    const read = h('button', { type: 'button', class: 'primary', 'data-testid': 'mb-paste-read' }, '🔍 Read it');
    const cancel = h('button', { type: 'button', 'data-testid': 'mb-paste-cancel', onclick: close }, 'Cancel');
    read.addEventListener('click', async () => {
      clear(out);
      if (!text.value.trim()) { out.appendChild(h('p', { class: 'words-warn', role: 'alert' }, 'Paste the AI’s answer first.')); text.focus(); return; }
      read.disabled = true;
      let res;
      try { res = await api('POST', '/starter-sheet/parse', { body: { text: text.value } }); }
      catch (e) { read.disabled = false; out.appendChild(problemBox(toProblem(e, { step: 'Paste starter sheet' }))); return; }
      read.disabled = false;
      if (!res.ok) { out.appendChild(h('p', { class: 'words-warn', role: 'alert', 'data-testid': 'mb-paste-none' }, res.message)); return; }
      const trims = (res.too_long || []).map(t => {
        const box = h('input', { type: 'checkbox', id: `ps-trim-${t.key}`, checked: true, 'data-testid': `mb-paste-trim-${t.key}` });
        return { t, box, el: h('div', { class: 'check-row words-warn' }, box, h('label', { for: `ps-trim-${t.key}` },
          `${t.label} is ${t.length.toLocaleString()} characters; the limit is ${t.max.toLocaleString()}. ✂ Shorten it to ${t.trimmed.length.toLocaleString()} characters (cut at the end of a sentence)`)) };
      });
      const use = h('button', { type: 'button', class: 'primary', 'data-testid': 'mb-paste-apply' }, '✔ Fill the form');
      use.addEventListener('click', () => {
        const trim = {}; for (const x of trims) trim[x.t.key] = x.box.checked ? x.t.trimmed : null;
        apply(res, { trim });
        close();
        announce(`Filled ${res.filled.length} setting(s) from your starter sheet`);
      });
      clear(out).append(h('div', { class: 'paste-summary', 'data-testid': 'mb-paste-summary' },
        h('p', null, h('strong', null, `✔ Akọwe understood ${res.filled.length} setting(s):`)),
        h('ul', { class: 'plain-list small', 'data-testid': 'mb-paste-filled' }, res.filled.map(f => h('li', null, h('strong', null, `${f.label}: `), f.value))),
        (res.not_understood || []).length ? [h('p', null, h('strong', null, '❔ Not understood (left as they are — set them yourself):')),
          h('ul', { class: 'plain-list small', 'data-testid': 'mb-paste-unclear' }, res.not_understood.map(f => h('li', null, h('strong', null, `${f.label}: `), `“${f.text}”`)))] : null,
        (res.missing || []).length ? h('p', { class: 'small muted', 'data-testid': 'mb-paste-missing' }, `Not in the sheet (left as they are): ${res.missing.join(', ')}.`) : null,
        trims.map(x => x.el),
        (res.fields.locks || []).length ? h('p', { class: 'small', 'data-testid': 'mb-paste-locks' }, `🔒 ${res.fields.locks.length} lock-list fact(s). ${res.locks_where}`) : null,
        h('div', { class: 'form-actions' }, use, h('button', { type: 'button', onclick: close }, 'Cancel'))));
      try { use.focus(); } catch { /* ignore */ }
    });
    d.addEventListener('cancel', ev => { ev.preventDefault(); close(); });
    d.append(h('h2', { id: 'ps-title' }, '📋 Paste starter sheet'),
      h('p', { class: 'small' }, 'Paste the whole answer your planning AI gave you. Akọwe finds the “AKỌWE STARTER SHEET” in it, fills the settings below, and shows you what it understood before anything changes.'),
      h('label', { for: 'ps-text', class: 'sr-only' }, 'The AI’s answer'), text, out, h('div', { class: 'form-actions' }, read, cancel));
    document.body.appendChild(d);
    try { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); } catch { d.setAttribute('open', ''); }
    text.focus();
  };
  return h('button', { type: 'button', class: 'mb-paste-btn', 'data-testid': 'mb-paste', onclick: ev => open(ev.currentTarget) }, '📋 Paste starter sheet');
}
