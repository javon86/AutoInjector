/* 🎧 Make audiobook (plan item 5b, audiobook.py) — a card on the 📤 Export page. The finished book read aloud with
   piper voices on this PC (through AutoInjector's voice engine): a narrator voice the author picks, optional
   character voices for dialogue (a small table: the Book Bible's gender / age hints, the voice chosen automatically,
   ▶ to hear it), one file per chapter (MP3 with ffmpeg, else WAV) plus the whole book and an M4B with chapter marks.
   Progress says "chapter n of N" and the time left; ✕ Cancel stops after the current piece; making it again skips
   the chapters already made. No voice engine → plain words with the setup hint, never a raw error.
   API: /audiobook/… (audiobook.py). The helpers of app.js are passed in. */

export function audiobookCard(x) {
  const { h, clear, api, bpath, toast, problemBox, toProblem } = x;
  const step = { step: '🎧 Make audiobook' };
  const body = h('div', { 'data-testid': 'ab-body' }, x.loadingState('Looking for the voice engine…'));
  const card = h('section', { class: 'card', 'aria-labelledby': 'ab-h', 'data-testid': 'audiobook-card' },
    h('h2', { id: 'ab-h' }, '🎧 Audiobook'),
    h('p', { class: 'small' }, 'Akọwe reads your finished book aloud, chapter by chapter, with the voices installed on this PC (piper, through AutoInjector — nothing goes online). Each chapter becomes one audio file that starts with its title, in your book’s folder.'),
    body);
  let d = null;
  let timer = null;
  const fail = (e, where) => { const p = toProblem(e, Object.assign({}, step, where ? { step: where } : {})); body.prepend(problemBox(p)); };
  const plainProblem = (p) => h('div', { class: 'state problem', role: 'alert', 'data-testid': 'ab-problem' },
    h('strong', null, `⚠️ ${p.title}`), h('p', null, p.fix));
  const voiceSelect = (id, value, testid, label) => {
    const sel = h('select', { id, 'data-testid': testid, 'aria-label': label },
      (d.engine.voices || []).map(v => h('option', { value: v.name }, v.name + (v.gender ? ` (${v.gender})` : ''))));
    sel.value = value || '';
    return sel;
  };
  const play = async (btn, voice, character) => {
    const status = card.querySelector('[data-testid=ab-test-status]');
    btn.disabled = true;
    try {
      const r = await api('POST', bpath('/audiobook/test'), { body: { voice, character: character || null } });
      if (!r.ok) { clear(status).appendChild(plainProblem(r.problem)); return; }
      clear(status).append(`▶ Playing a sample of ${voice}${character ? ` for ${character}` : ''}`);
      const bytes = Uint8Array.from(atob(r.audio_b64), ch => ch.charCodeAt(0));  // a blob: URL (the page's CSP allows blob: media)
      const url = URL.createObjectURL(new Blob([bytes], { type: r.mime || 'audio/wav' }));
      const audio = new Audio(url);
      audio.addEventListener('ended', () => URL.revokeObjectURL(url));
      try { await audio.play(); } catch { /* the browser may block sound until a click; the sample is ready */ }
    } catch (e) { fail(e, '🎧 Test a voice'); } finally { btn.disabled = false; }
  };
  const saveSettings = async (patch) => {
    try { d = await api('PUT', bpath('/audiobook/settings'), { body: patch }); draw(); toast('Saved'); }
    catch (e) { fail(e, '🎧 Audiobook settings'); }
  };
  const progress = (job) => {
    const el = h('div', { 'data-testid': 'ab-progress', 'aria-live': 'polite' });
    if (!job) return el;
    const pct = Math.max(0, Math.min(100, job.percent || 0));
    if (job.status === 'running') {
      el.append(h('p', { 'data-testid': 'ab-phase' }, `${job.phase}${job.chapters ? ` — chapter ${job.chapter} of ${job.chapters}` : ''}${job.time_left ? ` · ${job.time_left}` : ''}`),
        h('progress', { max: '100', value: String(pct), 'aria-label': `Audiobook: ${pct}% read` }),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'small', 'data-testid': 'ab-cancel', onclick: async () => {
          try { await api('POST', bpath('/audiobook/cancel')); toast('Stopping after this piece…'); } catch (e) { fail(e, '🎧 Cancel'); }
        } }, '✕ Cancel')));
    } else if (job.status === 'done') {
      el.append(h('p', { class: 'state ok', 'data-testid': 'ab-done' }, `✔ ${job.phase}`));
    } else if (job.problem) {
      el.append(plainProblem(job.problem));
    }
    for (const n of job.notes || []) el.append(h('p', { class: 'small muted' }, `ⓘ ${n}`));
    return el;
  };
  const poll = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!document.contains(card)) return;
      let j;
      try { j = (await api('GET', bpath('/audiobook/job'))).job; } catch { poll(); return; }
      if (j && j.status === 'running') { const old = card.querySelector('[data-testid=ab-progress]'); if (old) old.replaceWith(progress(j)); poll(); return; }
      await load();
    }, 700);
  };
  const draw = () => {
    clear(body);
    const e = d.engine;
    if (!e.ok) {
      body.append(plainProblem(e.problem));
      body.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'small', 'data-testid': 'ab-retry', onclick: () => load() }, '🔄 Look again')));
      body.append(retail());
      return;
    }
    const s = d.settings;
    body.append(h('p', { class: 'state ok', 'data-testid': 'ab-engine' }, `✔ Voice engine ready: ${e.voices.length} voice${e.voices.length === 1 ? '' : 's'} installed${e.via === 'bridge' ? ' (through AutoInjector)' : ''}.`),
      h('p', { class: 'small', 'data-testid': 'ab-format' }, d.ffmpeg ? '🎵 Files: MP3 (192 kbps) for each chapter, and an M4B audiobook with chapter marks.'
        : '🎵 Files: WAV (ffmpeg is not on this PC — install it to get smaller MP3 files and an M4B audiobook with chapter marks).'));
    const narr = voiceSelect('ab-narr', s.narrator, 'ab-narrator', 'Narrator voice');
    narr.addEventListener('change', () => saveSettings({ narrator: narr.value }));
    const testN = h('button', { type: 'button', class: 'small', 'data-testid': 'ab-test-narrator', 'aria-label': 'Play a sample of the narrator voice', onclick: ev => play(ev.currentTarget, narr.value, null) }, '▶');
    body.append(h('div', { class: 'field' }, h('label', { for: 'ab-narr' }, 'Narrator voice'), h('div', { class: 'row' }, narr, testN)));
    const dlg = h('input', { type: 'checkbox', id: 'ab-dlg', 'data-testid': 'ab-dialogue', checked: !!s.dialogue });
    dlg.addEventListener('change', () => saveSettings({ dialogue: dlg.checked }));
    body.append(h('div', { class: 'check-row field' }, dlg, h('label', { for: 'ab-dlg' }, 'Character voices for dialogue (each character’s spoken lines in their own voice; the narrator reads everything else)')));
    if (s.dialogue) {
      const rows = (d.characters || []).map((c, i) => {
        const sel = voiceSelect(`ab-cv-${i}`, c.voice, 'ab-voice-select', `Voice for ${c.name}`);
        sel.addEventListener('change', () => {
          const cv = Object.assign({}, s.character_voices); cv[c.name] = sel.value;
          saveSettings({ character_voices: cv });
        });
        return h('tr', { 'data-testid': 'ab-voice-row' }, h('th', { scope: 'row' }, c.name), h('td', { class: 'small muted' }, c.hint),
          h('td', null, sel), h('td', null, h('button', { type: 'button', class: 'small', 'data-testid': 'ab-test-voice', 'aria-label': `Play a sample of ${c.name}'s voice`, onclick: ev => play(ev.currentTarget, sel.value, c.name) }, '▶')));
      });
      body.append(rows.length ? h('table', { class: 'small', 'data-testid': 'ab-voices' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Character'), h('th', { scope: 'col' }, 'From the Book Bible'), h('th', { scope: 'col' }, 'Voice'), h('th', { scope: 'col' }, 'Test'))),
        h('tbody', null, rows)) : h('p', { class: 'small muted' }, 'The book has no characters yet, so the narrator reads every line.'));
      body.append(h('p', { class: 'small muted' }, 'Akọwe finds who speaks from the speech tags (“…,” Mara said) and a few careful rules; any line it is unsure about is read by the narrator.'));
    }
    const full = h('input', { type: 'checkbox', id: 'ab-full', 'data-testid': 'ab-full', checked: !!s.full_book });
    full.addEventListener('change', () => saveSettings({ full_book: full.checked }));
    body.append(h('div', { class: 'check-row field' }, full, h('label', { for: 'ab-full' }, 'Also make one file with the whole book')));
    body.append(h('div', { 'data-testid': 'ab-test-status', 'aria-live': 'polite', class: 'small' }));
    const made = d.chapters.filter(c => c.done).length;
    const running = d.job && d.job.status === 'running';
    body.append(h('p', { class: 'small', 'data-testid': 'ab-chapters' }, `${made} of ${d.chapters.length} chapter${d.chapters.length === 1 ? '' : 's'} already made with these voices${made ? ' (making it again only reads the others)' : ''}.`));
    const make = h('button', { type: 'button', class: 'primary', 'data-testid': 'ab-make', disabled: running || !d.chapters.length, onclick: async () => {
      make.disabled = true;
      try {
        const r = await api('POST', bpath('/audiobook/make'), { body: { full_book: full.checked } });
        if (!r.ok) { body.prepend(plainProblem(r.problem)); make.disabled = false; return; }
        const old = card.querySelector('[data-testid=ab-progress]'); if (old) old.replaceWith(progress(r.job));
        poll();
      } catch (e) { fail(e, '🎧 Make audiobook'); make.disabled = false; }
    } }, '🎧 Make audiobook');
    body.append(h('div', { class: 'row' }, make), progress(d.job));
    if (d.files && d.files.length) {
      body.append(h('div', { 'data-testid': 'ab-files' }, h('p', { class: 'small' }, h('strong', null, '📂 In your book’s folder: '), d.folder),
        h('ul', { class: 'small' }, d.files.map(f => h('li', null, f)))));
    }
    body.append(retail());
    if (running) poll();
  };
  const retail = () => h('details', { class: 'small', 'data-testid': 'ab-retail' },
    h('summary', null, 'ⓘ Selling your audiobook (information, not a guarantee)'),
    h('ul', null, (d && d.retail_notes || []).map(n => h('li', null, n))));
  const load = async () => {
    try { d = await api('GET', bpath('/audiobook')); draw(); }
    catch (e) { clear(body).appendChild(problemBox(toProblem(e, step))); }
  };
  load();
  return card;
}
