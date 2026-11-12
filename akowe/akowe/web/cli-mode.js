// ⌨ Command-line mode (try it first) — cli_mode.py: Settings card and the per-slot "Web window / Command line" choice.
// Claude → Claude Code, ChatGPT → Codex, run on this computer instead of typing into the web window. app.js passes its
// helpers in (s7c()), so this module never reaches into app.js. All data is rendered with DOM APIs (never innerHTML).

const TONE = { ready: 'ok', not_installed: 'off', signed_out: 'warn', limited: 'warn', failing: 'warn', off: 'off', checking: 'off' };
const SITE = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };

/** The "How this AI is reached" select for one slot (only Claude / ChatGPT AutoInjector slots can use the command line). */
export function modeField(c, s, id) {
  const { h } = c;
  const sel = h('select', { id, 'data-testid': `slot-mode-${s.slot_id}` },
    h('option', { value: 'web' }, 'Web window (AutoInjector types into the web page)'),
    h('option', { value: 'cli' }, 'Command line (Claude Code / Codex on this computer — try it first)'));
  sel.value = s.mode === 'cli' ? 'cli' : 'web';
  return sel;
}

/** Settings › ⌨ Command-line mode: the two tools' status, Check again, Open Codex, the preset and the time limit. */
export function cliCard(c) {
  const { h, api, clear, toast, problemBox, toProblem } = c;
  const box = h('div', { 'aria-live': 'polite' });
  const card = h('section', { class: 'card', 'aria-labelledby': 'cli-h', 'data-testid': 'cli-card' },
    h('h2', { id: 'cli-h' }, '⌨ Command-line mode (try it first)'),
    h('p', { class: 'small' }, 'Instead of typing into a web window, Akọwe can ask an AI through its own command-line tool on this computer: Claude through Claude Code, ChatGPT through Codex. It is faster and needs no web page, and it uses the same plan you sign in with (so it shares that plan’s usage limits). Each AI slot below has a choice “Web window” or “Command line”; Web window stays the default. Gemini stays a web window for now.'),
    box);
  const where = { step: 'Settings › Command-line mode' };
  const draw = (cur, msg) => {
    clear(box);
    for (const tool of ['claude', 'codex']) {
      const t = cur.tools[tool] || {};
      const kids = [h('strong', null, `${t.name || tool}: `), t.words || t.state];
      if (t.state === 'not_installed') {
        kids.push(' ', h('a', { href: t.install_url, target: '_blank', rel: 'noopener' }, 'How to install'));
        if (t.install_cmd) kids.push(' — in a command window: ', h('code', null, t.install_cmd));
      }
      box.appendChild(h('p', { class: `small cc-status cc-${TONE[t.state] || 'off'}`, 'data-testid': `cli-status-${tool}`, 'data-state': t.state || '' }, ...kids));
    }
    const rows = (cur.slots || []).map(s => h('li', { 'data-testid': `cli-slot-${s.slot_id}` },
      `${s.slot_id}: ${s.site ? SITE[s.site] || s.site : 'not set up'} — `,
      h('strong', null, s.cli ? 'Command line' : (s.adapter_id === 'none' ? 'off' : 'Web window'))));
    box.appendChild(h('ul', { class: 'small' }, ...rows));
    const msgP = h('p', { class: 'small', 'data-testid': 'cli-msg', role: 'status' }, msg || '');
    const preset = (name, label, testid, cls) => h('button', { type: 'button', class: cls || 'small', 'data-testid': testid, onclick: async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        const out = await api('POST', '/cli-mode/preset', { body: { preset: name } });
        draw(out, name === 'two_cli' ? 'Done: Claude and ChatGPT now use the command line, Gemini is off. Open each slot below to see it.' : 'Done: all three AIs use their web windows again.');
        toast('Saved');
        if (c.onSlots) c.onSlots();
      } catch (e) { box.appendChild(problemBox(toProblem(e, where))); ev.currentTarget.disabled = false; }
    } }, label);
    const recheck = h('button', { type: 'button', class: 'small', 'data-testid': 'cli-recheck', onclick: async () => {
      recheck.disabled = true; msgP.textContent = 'Checking Claude Code and Codex…';
      try { draw(await api('POST', '/cli-mode/check')); } catch (e) { box.appendChild(problemBox(toProblem(e, where))); recheck.disabled = false; }
    } }, '↻ Check again');
    const openCodex = h('button', { type: 'button', class: 'small', 'data-testid': 'cli-open-codex',
      title: 'Opens a command window on this computer running “codex login”, to sign in with your ChatGPT account', onclick: async () => {
        openCodex.disabled = true; msgP.textContent = 'Opening Codex…';
        try { const out = await api('POST', '/cli-mode/window', { body: {} }); msgP.textContent = out.message; }
        catch (e) { msgP.textContent = ''; box.appendChild(problemBox(toProblem(e, where))); }
        finally { setTimeout(() => { openCodex.disabled = false; }, 3000); }
      } }, '⌨ Open Codex (sign in)');
    const isPreset = (cur.slots || []).length === 3 && cur.slots[0].cli && cur.slots[1].cli && cur.slots[2].adapter_id === 'none';
    box.appendChild(h('div', { class: 'row' },
      isPreset ? null : preset('two_cli', '⌨ Two AIs: Claude + ChatGPT on command line, Gemini off', 'cli-preset', 'small primary'),
      (cur.slots || []).some(s => s.cli) ? preset('web', '🌐 All back to web windows', 'cli-preset-web') : null,
      recheck, openCodex));
    box.appendChild(h('p', { class: 'small muted' }, 'To sign Claude Code in, use “⌨ Open Claude Code” in the 🤖 Claude Code helpers card below.'));
    const tmo = h('input', { type: 'number', id: 'cli-timeout', min: '60', max: '3600', value: String(cur.settings.timeout_s), class: 'wz-num', 'data-testid': 'cli-timeout' });
    const n = h('input', { type: 'number', id: 'cli-at-once', min: '1', max: '4', value: String(cur.settings.at_once), class: 'wz-num', 'data-testid': 'cli-at-once' });
    const save = h('button', { type: 'button', class: 'small', 'data-testid': 'cli-save', onclick: async () => {
      try { draw(await api('PUT', '/cli-mode', { body: { timeout_s: parseInt(tmo.value, 10), at_once: parseInt(n.value, 10) } }), 'Saved.'); toast('Saved'); }
      catch (e) { box.appendChild(problemBox(toProblem(e, where))); }
    } }, 'Save');
    box.appendChild(h('details', null, h('summary', null, 'More settings'),
      h('div', { class: 'row' }, h('label', { for: 'cli-timeout' }, 'Longest wait for one answer (seconds)'), tmo),
      h('div', { class: 'row' }, h('label', { for: 'cli-at-once' }, 'Answers at once per tool (1–4)'), n),
      save));
    box.appendChild(msgP);
  };
  box.appendChild(h('p', { class: 'small' }, 'Checking Claude Code and Codex…'));
  api('GET', '/cli-mode').then(draw).catch(e => { clear(box); box.appendChild(problemBox(toProblem(e, where))); });
  return card;
}
