// 🗳 The three-AI writers' room (writers_room.py): each working AI pitches one idea, then they vote blind on each
// other's pitches; the author sees the pitches, the votes with their reasons and the winner, and uses one (a new
// draft, never an approval), picks another, or asks for another round. app.js passes its helpers in (wrc()), so this
// module never reaches into app.js. All data is rendered with DOM APIs (never innerHTML with server data).

const TOPIC_ORDER = ['plot', 'chapter', 'character', 'question'];
const RANK_WORD = ['', '1st', '2nd', '3rd', '4th', '5th'];

/** The 🗳 button. ``preset``: {topic, chapter_id, record_id} to open the room on that decision. */
export function roomButton(c, preset = {}, { small = false, label = '🗳 Writers’ room' } = {}) {
  return c.h('button', { type: 'button', class: small ? 'small' : '', 'data-testid': 'room-open',
    title: 'Each working AI pitches an idea, then they vote blind on each other’s pitches. You choose what to use.',
    onclick: () => openRoom(c, preset) }, label);
}

/** ⚡ Make a book: "Use the writers' room for the big twists" (run setting writers_room, off by default). */
export function makeSetupSwitch(c) {
  const { h } = c;
  const box = h('input', { type: 'checkbox', role: 'switch', id: 'mb-room', 'data-testid': 'mb-room', 'aria-describedby': 'mb-room-hint' });
  const el = h('fieldset', { class: 'field wr-switch' }, h('legend', null, '🗳 Writers’ room'),
    h('div', { class: 'check-row' }, box, h('label', { for: 'mb-room' }, h('strong', null, 'Use the writers’ room for the big twists'))),
    h('p', { class: 'hint', id: 'mb-room-hint' }, 'Off by default. On: before the main plot, and before the middle chapter and the climax, each working AI pitches an idea and they vote blind. The winner is used under your consent for this run and written in the journal. A few more AI answers each time; it never holds up the book.'));
  return { el, apply(body) { if (box.checked) body.writers_room = true; } };
}

export function openRoom(c, preset = {}) {
  const { h, clear } = c;
  const body = h('div', { class: 'wr-body', 'aria-live': 'polite', 'data-testid': 'room-dialog' }, c.loadingState('Opening the writers’ room…'));
  c.modal('🗳 Writers’ room', () => body, { wide: true });
  let ov = null;
  const load = async () => {
    try { ov = await c.api('GET', c.bpath('/room')); } catch (e) { clear(body).appendChild(c.problemBox(c.toProblem(e, { step: 'Writers’ room' }), { retry: load })); return; }
    if (ov.job) { await follow(ov.job); return; }
    setup();
  };

  // ---------------------------------------------------------------- 1. what is the room about
  function setup() {
    clear(body);
    const working = (ov.ais || []).filter(a => a.working);
    body.appendChild(h('p', null, 'Each working AI pitches one idea. Then they vote blind on each other’s pitches — the pitches are shuffled and labelled A, B, C, and nobody can vote for their own. You see every pitch, every vote with its reason, and the winner, and you choose what to use.'));
    body.appendChild(working.length >= 2
      ? h('p', { class: 'small', 'data-testid': 'room-ais' }, `In the room: ${working.map(a => a.name).join(', ')}.`)
      : h('p', { class: 'words-warn', role: 'note', 'data-testid': 'room-too-few' }, working.length
        ? `Only one AI is working right now (${working[0].name}), so there is no one to vote. You can ask it for three ideas instead and pick one yourself, or connect another AI in Settings.`
        : 'No AI is working right now. Connect an AI in Settings, then try again.'));
    const radios = {};
    const chSel = h('select', { id: 'room-chapter', 'aria-label': 'Which chapter' }, (ov.chapters || []).map(ch => h('option', { value: ch.chapter_id }, `Chapter ${ch.number}${ch.summary ? ` — ${ch.summary.slice(0, 70)}` : ''}`)));
    const chrSel = h('select', { id: 'room-character', 'aria-label': 'Which character' }, (ov.characters || []).map(x => h('option', { value: x.record_id }, x.name)));
    const q = h('textarea', { id: 'room-question', rows: '2', maxlength: '400', placeholder: 'For example: What does the lighthouse keeper hide?', 'aria-label': 'Your question' });
    if (preset.chapter_id) chSel.value = preset.chapter_id;
    if (preset.record_id) chrSel.value = preset.record_id;
    if (preset.question) q.value = preset.question;
    const avail = { plot: !!ov.has_plot, chapter: !!(ov.chapters || []).length, character: !!(ov.characters || []).length, question: true };
    const extra = { chapter: chSel, character: chrSel, question: q };
    const why = { plot: 'Write the premise first.', chapter: 'Make the chapter outline first.', character: 'Make a character first.' };
    const topics = Object.fromEntries((ov.topics || []).map(t => [t.id, t]));
    const first = TOPIC_ORDER.find(t => avail[t]);
    const want = preset.topic && avail[preset.topic] ? preset.topic : first;
    const list = h('fieldset', { class: 'field' }, h('legend', null, 'What should they pitch?'), TOPIC_ORDER.map(t => {
      const id = `room-t-${t}`; const info = topics[t] || { icon: '', label: t };
      radios[t] = h('input', { type: 'radio', name: 'room-topic', id, value: t, checked: t === want, disabled: !avail[t], 'data-testid': id });
      return h('div', { class: 'check-row' }, radios[t], h('label', { for: id }, h('strong', null, `${info.icon} ${info.label}`),
        avail[t] ? null : h('span', { class: 'hint' }, ` — ${why[t]}`)), extra[t] && avail[t] ? h('div', { class: 'wr-extra' }, extra[t]) : null);
    }));
    body.appendChild(list);
    const err = h('div', { 'aria-live': 'polite' });
    const req = solo => {
      const t = TOPIC_ORDER.find(k => radios[k].checked);
      if (!t) return null;
      const b = { topic: t };
      if (t === 'chapter') b.chapter_id = chSel.value;
      if (t === 'character') b.record_id = chrSel.value;
      if (t === 'question') { b.question = q.value.trim(); if (b.question.length < 3) { clear(err).appendChild(c.problemBox({ code: 'MISSING_INPUT', message: 'Type your question first.', where: { step: 'Writers’ room' } })); q.focus(); return null; } }
      if (solo) b.solo = true;
      return b;
    };
    const go = h('button', { type: 'button', class: 'primary', 'data-testid': 'room-start', disabled: working.length < 2, onclick: () => { const b = req(false); if (b) start(b); } }, '🗳 Start the writers’ room');
    const solo = h('button', { type: 'button', class: working.length < 2 ? 'primary' : '', 'data-testid': 'room-solo', disabled: !working.length,
      title: 'One AI gives three different ideas; there is no vote and you pick.', onclick: () => { const b = req(true); if (b) start(b); } }, '💡 Brainstorm with one AI');
    body.appendChild(h('div', { class: 'row' }, go, solo));
    body.appendChild(err);
    if ((ov.rooms || []).length) {
      body.appendChild(h('details', { class: 'small' }, h('summary', null, `Earlier rooms (${ov.rooms.length})`),
        h('ul', null, ov.rooms.slice(0, 10).map(r => h('li', null, h('button', { type: 'button', class: 'link', onclick: () => show(r.id) }, r.label || r.topic),
          h('span', { class: 'muted' }, ` · ${c.fmtTime ? c.fmtTime(r.at) : r.at}${r.made_by === 'run' ? ' · ⚡ run' : ''}${r.decided ? ' · used' : ''}`))))));
    }
  }

  // ---------------------------------------------------------------- 2. meeting
  async function start(b) {
    clear(body).appendChild(c.loadingState('Starting the writers’ room…'));
    let j;
    try { j = await c.api('POST', c.bpath('/room'), { body: b }); } catch (e) { clear(body).appendChild(c.problemBox(c.toProblem(e, { step: 'Writers’ room' }), { retry: () => start(b) })); return; }
    await follow(j);
  }
  async function follow(j) {
    const prog = h('div', { class: 'rp-progress', 'data-testid': 'room-progress' });
    clear(body).append(h('p', { class: 'small' }, 'The AIs are pitching, then voting. Web AIs can take a few minutes; you can close this window and open the writers’ room again later.'), prog);
    let end;
    try { end = await c.pollQualityJob(c.bpath(`/room/job/${encodeURIComponent(j.id)}`), prog); } catch (e) { clear(body).appendChild(c.problemBox(c.toProblem(e, { step: 'Writers’ room' }), { retry: load })); return; }
    if (!document.contains(body)) return;
    if (end.status !== 'done' && !end.room_id) { clear(body).appendChild(c.problemBox({ code: (end.error || {}).code || 'ROOM_FAILED', message: (end.error || {}).message || end.phase, where: { step: 'Writers’ room' } }, { retry: load })); return; }
    c.announce('The writers’ room has finished');
    await show(end.room_id);
  }

  // ---------------------------------------------------------------- 3. results
  async function show(roomId) {
    let room;
    try { room = await c.api('GET', c.bpath(`/room/${encodeURIComponent(roomId)}`)); } catch (e) { clear(body).appendChild(c.problemBox(c.toProblem(e, { step: 'Writers’ room' }), { retry: () => show(roomId) })); return; }
    results(room);
  }
  function results(room) {
    clear(body);
    const t = room.target || {};
    body.appendChild(h('p', { class: 'small muted' }, `${room.mode === 'solo' ? '💡 Brainstorm' : '🗳 Writers’ room'} · ${t.label || ''}${room.round > 1 ? ` · round ${room.round}` : ''}${room.made_by === 'run' ? ' · held by a ⚡ Make-a-book run' : ''}`));
    const pitches = (room.pitches || []).filter(p => p.letter).sort((a, b) => a.letter.localeCompare(b.letter));
    const failed = (room.pitches || []).filter(p => p.status !== 'done');
    const msg = h('div', { 'aria-live': 'polite', 'data-testid': 'room-msg' });
    if (room.status === 'too_few') {
      body.appendChild(h('p', { class: 'words-warn', role: 'note', 'data-testid': 'room-too-few' }, room.message));
      body.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', 'data-testid': 'room-solo', onclick: () => start(Object.assign({}, roomBody(t), { solo: true })) }, '💡 Brainstorm with one AI'),
        h('button', { type: 'button', onclick: setup }, '← Back')));
      return;
    }
    const tally = room.tally || {};
    const rows = Object.fromEntries((tally.rows || []).map(r => [r.letter, r]));
    const win = pitches.find(p => p.letter === room.winner);
    if (win) body.appendChild(h('div', { class: 'notice wr-winner', role: 'status', 'data-testid': 'room-winner' }, h('strong', null, `🏆 The winner: pitch ${win.letter} — “${win.title}”`), ` by ${win.name}. `, h('span', { class: 'small' }, room.message || '')));
    else if (pitches.length) body.appendChild(h('div', { class: 'notice', role: 'status', 'data-testid': 'room-winner' }, h('strong', null, room.mode === 'solo' ? '💡 Choose the idea you like.' : '🤝 No clear winner — you choose. '), h('span', { class: 'small' }, room.message || '')));
    else body.appendChild(h('p', { class: 'words-warn', role: 'note' }, room.message || 'No idea came back.'));
    for (const f of failed) body.appendChild(h('p', { class: 'small words-warn', 'data-testid': 'room-failed' }, `⚠️ ${f.name} ${f.word || 'gave no usable answer'}${f.error === 'TIMEOUT' ? ' — it may still answer in its own pane' : ''}.`));
    const into = t.topic === 'question' ? h('input', { type: 'checkbox', id: 'room-into-plot', 'data-testid': 'room-into-plot' }) : null;
    const decided = (room.decided || {}).letter;
    const cards = h('div', { class: 'wr-pitches' }, pitches.map(p => {
      const r = rows[p.letter];
      const reasons = (room.votes || []).filter(v => v.status === 'done').map(v => {
        const x = (v.ranking || []).find(k => k.letter === p.letter);
        return x ? h('li', null, h('strong', null, `${v.name}: ${RANK_WORD[x.rank] || x.rank}`), x.reason ? ` — ${x.reason}` : '') : null;
      }).filter(Boolean);
      return h('section', { class: `card wr-pitch${p.letter === room.winner ? ' wr-win' : ''}`, 'data-letter': p.letter, 'data-testid': `room-pitch-${p.letter}`, 'aria-labelledby': `wr-p-${p.letter}` },
        h('h3', { id: `wr-p-${p.letter}` }, `${p.letter === room.winner ? '🏆 ' : ''}Pitch ${p.letter} — ${p.title}`),
        h('p', { class: 'small muted' }, `by ${p.name}`, r ? ` · ${r.first} first place(s) · sum of ranks ${r.rank_sum}` : ''),
        h('p', null, p.idea),
        p.why_it_fits ? h('p', { class: 'small' }, h('strong', null, 'Why it fits: '), p.why_it_fits) : null,
        p.changes_later ? h('p', { class: 'small' }, h('strong', null, 'What it changes later: '), p.changes_later) : null,
        reasons.length ? h('details', { open: true }, h('summary', { class: 'small' }, 'How the others ranked it'), h('ul', { class: 'small' }, reasons)) : null,
        h('div', { class: 'row' }, h('button', { type: 'button', class: p.letter === room.winner ? 'primary' : '', 'data-testid': `room-use-${p.letter}`,
          onclick: ev => use(room, p, ev.currentTarget, msg, into) }, p.letter === room.winner ? '✔ Use the winner' : '✔ Use this one'),
        decided === p.letter ? h('span', { class: 'small' }, ' ✔ used') : null));
    }));
    body.appendChild(cards);
    const notIn = (room.votes || []).filter(v => v.status !== 'done');
    for (const v of notIn) body.appendChild(h('p', { class: 'small words-warn' }, `⚠️ ${v.name} ${v.word || 'gave no usable vote'}.`));
    if (into) body.appendChild(h('div', { class: 'check-row' }, into, h('label', { for: 'room-into-plot' }, 'Also write the chosen idea into the main plot (as a new draft)')));
    body.appendChild(msg);
    body.appendChild(h('div', { class: 'row' },
      h('button', { type: 'button', 'data-testid': 'room-again', title: 'The AIs pitch new ideas (not the ones above) and vote again.', onclick: () => again(room) }, '🔁 Another round'),
      h('button', { type: 'button', onclick: setup }, '← Ask something else')));
  }
  function roomBody(t) {
    const b = { topic: t.topic };
    if (t.chapter_id) b.chapter_id = t.chapter_id;
    if (t.topic === 'character') b.record_id = t.record_id;
    if (t.question) b.question = t.question;
    return b;
  }
  async function again(room) {
    clear(body).appendChild(c.loadingState('Starting another round…'));
    let j;
    try { j = await c.api('POST', c.bpath('/room'), { body: room.mode === 'solo' ? { round_of: room.id, solo: true } : { round_of: room.id } }); }
    catch (e) { clear(body).appendChild(c.problemBox(c.toProblem(e, { step: 'Writers’ room' }), { retry: () => again(room) })); return; }
    await follow(j);
  }
  async function use(room, p, btn, msg, into) {
    btn.disabled = true;
    clear(msg).appendChild(c.loadingState('Saving…'));
    try {
      const out = await c.api('POST', c.bpath(`/room/${encodeURIComponent(room.id)}/use`), { body: Object.assign({ letter: p.letter }, into && into.checked ? { into: 'plot' } : {}) });
      const ap = out.applied;
      clear(msg).appendChild(h('p', { class: 'notice', role: 'status', 'data-testid': 'room-used' }, '✔ ', out.message, ' ',
        ap ? h('a', { href: c.plink('rec', ap.record_id, String(ap.version)) }, 'Open the new draft') : null));
      c.toast(ap ? 'Saved as a new draft' : 'Noted');
      if (c.onChanged) c.onChanged();
    } catch (e) { clear(msg).appendChild(c.problemBox(c.toProblem(e, { step: 'Writers’ room' }), { retry: () => use(room, p, btn, msg, into) })); }
    finally { btn.disabled = false; }
  }
  load();
}
