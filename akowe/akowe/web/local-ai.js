/* 🖥 Settings › Local AI backup (plan item 5c, local_ai.py): while ChatGPT, Claude and Gemini are all at their usage
   limits, Alfred's local model (Ollama, on this PC) does the checks instead of Akọwe waiting for hours. The card says
   whether Ollama is found, which model, whether it is good enough (7B or bigger recommended, plus Alfred's fit
   rating for this PC), and has the switches: On/Off (automatic: on when a 7B+ model is installed), the private
   fourth reviewer, and "Let the local AI write when all online AIs are limited" (off, with a plain warning).
   API: GET/PUT /settings/local-ai, POST /settings/local-ai/check. The helpers of app.js are passed in. */

export function localAiCard(x) {
  const { h, api, clear, toast, problemBox, toProblem } = x;
  const step = { step: 'Settings › Local AI backup' };
  const box = h('div', { 'data-testid': 'la-body' }, x.loadingState ? x.loadingState('Looking for the local AI…') : 'Looking for the local AI…');
  const card = h('section', { class: 'card', 'aria-labelledby': 'la-h', 'data-testid': 'local-ai-card' },
    h('h2', { id: 'la-h' }, '🖥 Local AI backup'),
    h('p', { class: 'small' }, 'When ChatGPT, Claude and Gemini have all hit their usage limits, the AI on this PC (the one AutoInjector’s 🎩 Alfred uses) does the checks — chapter consistency, the running notes, the story map, the “sounds like AI” read and tidying research notes — instead of Akọwe waiting for hours. Its results are marked 🖥 Local AI. It never writes chapters unless you allow it below.'),
    box);
  const draw = (st) => {
    clear(box);
    const s = st.settings || {};
    const yes = (b) => (b ? '✔' : '✖');
    const size = st.params_b ? ` (${st.params_b}B)` : '';
    const fit = st.fit && st.fit.label ? ` · ${st.fit.label}` : '';
    box.appendChild(h('p', { 'data-testid': 'la-status', class: st.good_enough ? 'state ok' : 'state blocked' }, st.words));
    box.appendChild(h('ul', { class: 'small', 'data-testid': 'la-facts' },
      h('li', null, `${yes(st.found)} Ollama: `, st.found ? `found (${st.source === 'autoinjector' ? 'through AutoInjector' : 'on this PC'})` : 'not found'),
      h('li', null, `${yes(!!st.model)} Model: `, st.model ? `${st.model}${size}${fit}` : 'none installed'),
      h('li', null, `${yes(st.good_enough)} Good enough for the checks: `, st.good_enough ? 'yes' : `no — ${st.min_params_b || 7}B or bigger is recommended`)));
    const on = h('input', { type: 'checkbox', id: 'la-on', 'data-testid': 'la-enabled', checked: !!st.enabled, disabled: !st.model });
    const fourth = h('input', { type: 'checkbox', id: 'la-fourth', 'data-testid': 'la-fourth', checked: !!s.fourth_reviewer });
    const write = h('input', { type: 'checkbox', id: 'la-write', 'data-testid': 'la-write', checked: !!s.allow_write });
    const out = h('div', { 'aria-live': 'polite' });
    const save = async (patch) => {
      clear(out);
      try { draw(await api('PUT', '/settings/local-ai', { body: patch })); toast('Saved'); }
      catch (e) { out.appendChild(problemBox(toProblem(e, step))); }
    };
    on.addEventListener('change', () => save({ enabled: on.checked }));
    fourth.addEventListener('change', () => save({ fourth_reviewer: fourth.checked }));
    write.addEventListener('change', async () => {
      if (!write.checked) { save({ allow_write: false }); return; }
      const ok = await x.choiceDialog('Let the local AI write?', h('p', null, st.write_warning), [{ id: 'yes', label: 'Yes, let it write' }]);
      if (ok !== 'yes') { write.checked = false; return; }
      save({ allow_write: true, author_confirms: true });
    });
    const again = h('button', { type: 'button', class: 'small', 'data-testid': 'la-check', onclick: async () => {
      clear(out);
      try { draw(await api('POST', '/settings/local-ai/check')); } catch (e) { out.appendChild(problemBox(toProblem(e, step))); }
    } }, '🔄 Look again');
    box.append(
      h('div', { class: 'check-row field' }, on, h('label', { for: 'la-on' }, 'Use the local AI for the checks while the online AIs are limited'),
        h('span', { class: 'hint' }, st.settings && st.settings.enabled === null ? ' (automatic: on when a 7B or bigger model is installed)' : '')),
      h('div', { class: 'check-row field' }, fourth, h('label', { for: 'la-fourth' }, 'A private fourth reviewer: the local AI also reads each chapter (its opinion is shown next to the review and never changes it)')),
      h('div', { class: 'check-row field' }, write, h('label', { for: 'la-write' }, 'Let the local AI write when all online AIs are limited')),
      h('p', { class: 'small muted', 'data-testid': 'la-write-warning' }, '⚠️ ', st.write_warning),
      h('div', { class: 'row' }, again), out);
  };
  (async () => {
    try { draw(await api('GET', '/settings/local-ai')); }
    catch (e) { clear(box).appendChild(problemBox(toProblem(e, step))); }
  })();
  return card;
}
