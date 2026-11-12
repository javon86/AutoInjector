// cli-mode-ui.js — ⌨ Command-line mode (try it first) in AutoInjector's window (the renderer side).
//
// Akọwe can run an AI's own command-line tool on this PC instead of typing into its web window: Claude → Claude Code,
// ChatGPT → Codex (akowe/akowe/cli_mode.py). There is no web page to watch then, so AutoInjector shows:
//   • in the 📚 Akọwe panel, a "⌨ Command-line AIs" card: for each AI slot "Web window" or "Command line" (the SAME
//     setting as Akọwe's ⚙️ Settings — changing it here changes it there), whether Claude Code / Codex are installed
//     and signed in, the "Two AIs: Claude + ChatGPT on command line, Gemini off" preset, and a 📜 conversation: what
//     Akọwe asked (a one-line summary) and the start of each answer;
//   • in the pane of an AI that is on the command line, a plain status card instead of the website (main.js moves
//     that web page out of sight; the web pane code itself is unchanged).
// The data is the status snapshot's `cliMode` (cli-mode-watch.js). Plain data in, DOM out (textContent only, never parsed
// as HTML). cardModel() / paneCard() are plain functions, unit-tested in node; render() fills the DOM.
(function (root) {
  'use strict';
  const SITE_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
  const TOOL_OF = { claude: 'claude', chatgpt: 'codex' };
  const TOOL_LABELS = { claude: 'Claude Code', codex: 'Codex' };
  const OK_STATES = ['ready'];

  function toolLine(view, tool) {
    const t = (view && view.tools && view.tools[tool]) || {};
    return { state: t.state || 'checking', words: t.words || `Checking ${TOOL_LABELS[tool]}…`, ok: OK_STATES.includes(t.state) };
  }

  function clock(at) {
    if (typeof at !== 'number') return '';
    try { return new Date(at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; }
  }

  const OUTCOME_WORDS = { ok: '✔', SCHEMA: '↻ asked again (the answer had the wrong shape)', USAGE_LIMIT: '⏳ at the plan’s usage limit', NOT_LOGGED_IN: '🔑 signed out', TIMEOUT: '⌛ took too long', CANCELLED: '■ stopped', NO_PICTURES: '🖼 can’t look at pictures' };

  /** The card's content: rows per slot, tool lines, the conversation (newest first). Null: nothing to show. */
  function cardModel(view) {
    if (!view || !Array.isArray(view.slots)) return null;
    const rows = view.slots.map((s) => {
      const tool = TOOL_OF[s.site];
      const t = tool ? toolLine(view, tool) : null;
      return {
        slot_id: s.slot_id, site: s.site, label: `${s.slot_id} · ${SITE_LABELS[s.site] || (s.adapter_id === 'none' ? 'off' : s.adapter_id || 'not set up')}`,
        mode: s.cli ? 'cli' : 'web', canCli: !!s.can_cli,
        note: !s.site ? 'Not using AutoInjector' : !s.can_cli ? (s.site === 'gemini' ? 'Web window only (no command-line mode for Gemini yet)' : 'Web window only') : s.cli ? `${TOOL_LABELS[tool]}: ${t.words}` : '',
        tone: s.cli ? (t.ok ? 'ok' : t.state === 'checking' ? 'info' : 'warn') : 'off',
      };
    });
    const anyCli = rows.some((r) => r.mode === 'cli');
    const exchanges = (view.exchanges || []).slice().reverse().map((e) => ({
      id: e.id, when: clock(e.at), who: `${SITE_LABELS[e.site] || e.site || 'AI'} (${TOOL_LABELS[e.tool] || e.tool})`,
      task: e.task || '(a request from Akọwe)', answer: e.answer || '', outcome: OUTCOME_WORDS[e.outcome] || (e.outcome ? `✖ ${e.outcome}` : ''),
      secs: typeof e.seconds === 'number' ? `${Math.round(e.seconds)} s` : '', pictures: e.pictures || 0,
    }));
    const isPreset = rows.length === 3 && rows[0].mode === 'cli' && rows[0].site === 'claude' && rows[1].mode === 'cli' && rows[1].site === 'chatgpt' && !rows[2].site;
    return { rows, anyCli, exchanges, isPreset, running: view.running || 0,
      tools: { claude: toolLine(view, 'claude'), codex: toolLine(view, 'codex') } };
  }

  /** The status card for an AI pane that is on the command line, or null (the web page shows as usual). */
  function paneCard(view, site) {
    const slot = view && Array.isArray(view.slots) ? view.slots.find((s) => s.site === site && s.cli) : null;
    if (!slot) return null;
    const tool = TOOL_OF[site];
    const t = toolLine(view, tool);
    const last = (view.exchanges || []).filter((e) => e.site === site).slice(-1)[0];
    return {
      title: `⌨ ${SITE_LABELS[site]} is on the command line`,
      text: `Akọwe asks ${TOOL_LABELS[tool]} on this computer instead of this web window (${slot.slot_id}).`,
      status: `${TOOL_LABELS[tool]}: ${t.words}`,
      tone: t.ok ? 'ok' : t.state === 'checking' ? 'info' : 'warn',
      last: last ? `Last answer${last.at ? ` at ${clock(last.at)}` : ''}: ${OUTCOME_WORDS[last.outcome] || last.outcome}` : 'No answers yet.',
      hint: 'The conversation is in the 📚 Akọwe panel → ⌨ Command-line AIs. To use this web page again, choose “Web window” there.',
    };
  }

  function node(doc, tag, attrs, ...kids) {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids) if (k != null) e.appendChild(typeof k === 'string' ? doc.createTextNode(k) : k);
    return e;
  }

  let openConv = false;
  function renderCard(doc, view, api, msg) {
    const body = doc.getElementById('akowe-body');
    if (!body) return null;
    let card = doc.getElementById('cli-card');
    const m = cardModel(view);
    if (!m) { if (card) card.hidden = true; return card; }
    const key = JSON.stringify(m) + (msg || '');
    if (card && card.dataset.key === key) { card.hidden = false; return card; }
    if (!card) {
      card = node(doc, 'section', { id: 'cli-card', class: 'bf-card', 'aria-labelledby': 'cli-card-h', 'data-testid': 'cli-card' });
      body.appendChild(card);
    }
    const conv = card.querySelector('details');
    if (conv) openConv = conv.open;
    card.hidden = false;
    card.dataset.key = key;
    card.textContent = '';
    const say = (t) => { const p = card.querySelector('.cli-msg'); if (p) p.textContent = t; };
    card.appendChild(node(doc, 'h3', { id: 'cli-card-h' }, '⌨ Command-line AIs (try it first)'));
    card.appendChild(node(doc, 'p', { class: 'cli-about', text: 'Command line: Akọwe runs the AI’s own command-line tool on this computer (Claude Code for Claude, Codex for ChatGPT) instead of typing into its web window. It uses the same plan you sign in with.' }));
    const list = node(doc, 'div', { class: 'cli-rows' });
    for (const r of m.rows) {
      const row = node(doc, 'div', { class: 'cli-row', 'data-slot': r.slot_id, 'data-tone': r.tone });
      row.appendChild(node(doc, 'span', { class: 'cli-slot', text: r.label }));
      if (r.canCli) {
        const sel = node(doc, 'select', { 'aria-label': `How ${r.label} talks to the AI`, 'data-testid': `cli-mode-${r.slot_id}` },
          node(doc, 'option', { value: 'web', text: 'Web window' }), node(doc, 'option', { value: 'cli', text: 'Command line' }));
        sel.value = r.mode;
        sel.addEventListener('change', async () => {
          sel.disabled = true;
          const res = api && api.akoweCliSetMode ? await api.akoweCliSetMode(r.slot_id, sel.value) : null;
          if (!res || !res.ok) { say((res && res.message) || 'Akọwe did not save it — is Akọwe running?'); sel.value = r.mode; }
          else render(doc, res.view, api, `${r.slot_id} now uses the ${sel.value === 'cli' ? 'command line' : 'web window'}.`);
          sel.disabled = false;
        });
        row.appendChild(sel);
      }
      if (r.note) row.appendChild(node(doc, 'span', { class: 'cli-note', text: r.note }));
      list.appendChild(row);
    }
    card.appendChild(list);
    const actions = node(doc, 'div', { class: 'cli-actions' });
    const preset = (name, label, testid) => node(doc, 'button', { type: 'button', 'data-testid': testid, onclick: async (ev) => {
      ev.currentTarget.disabled = true;
      const res = api && api.akoweCliPreset ? await api.akoweCliPreset(name) : null;
      if (!res || !res.ok) say((res && res.message) || 'Akọwe did not save it — is Akọwe running?');
      else render(doc, res.view, api, name === 'two_cli' ? 'Claude and ChatGPT now use the command line; Gemini is off.' : 'All three AIs use their web windows again.');
    } }, label);
    if (!m.isPreset) actions.appendChild(preset('two_cli', '⌨ Two AIs: Claude + ChatGPT on command line, Gemini off', 'cli-preset'));
    if (m.anyCli) actions.appendChild(preset('web', '🌐 All back to web windows', 'cli-preset-web'));
    card.appendChild(actions);
    card.appendChild(node(doc, 'p', { class: 'cli-msg', role: 'status', 'aria-live': 'polite', text: msg || '' }));
    const det = node(doc, 'details', { class: 'cli-conv', 'data-testid': 'cli-conv' });
    det.open = openConv;
    det.appendChild(node(doc, 'summary', { text: `📜 Conversation (${m.exchanges.length} answer${m.exchanges.length === 1 ? '' : 's'}${m.running ? `, ${m.running} working now` : ''})` }));
    if (!m.exchanges.length) det.appendChild(node(doc, 'p', { class: 'cli-empty', text: 'Nothing yet. When Akọwe asks a command-line AI something, the question (in one line) and the answer show here.' }));
    const ol = node(doc, 'ol', { class: 'cli-ex' });
    for (const e of m.exchanges) {
      const li = node(doc, 'li', { 'data-id': String(e.id) });
      li.appendChild(node(doc, 'div', { class: 'cli-ex-head', text: [e.when, e.who, e.outcome, e.secs, e.pictures ? `🖼 ${e.pictures}` : ''].filter(Boolean).join(' · ') }));
      li.appendChild(node(doc, 'div', { class: 'cli-ex-task', text: `Asked: ${e.task}` }));
      if (e.answer) li.appendChild(node(doc, 'pre', { class: 'cli-ex-answer', text: e.answer }));
      ol.appendChild(li);
    }
    det.appendChild(ol);
    card.appendChild(det);
    return card;
  }

  function renderPanes(doc, view) {
    for (const site of Object.keys(SITE_LABELS)) {
      const slot = doc.getElementById(`pane-slot-${site}`);
      if (!slot) continue;
      const c = paneCard(view, site);
      let box = slot.querySelector('.cli-pane-card');
      if (!c) { if (box) box.remove(); continue; }
      const key = JSON.stringify(c);
      if (box && box.dataset.key === key) continue;
      if (!box) { box = node(doc, 'div', { class: 'cli-pane-card', role: 'status', 'data-testid': `cli-pane-${site}` }); slot.appendChild(box); }
      box.dataset.key = key;
      box.dataset.tone = c.tone;
      box.textContent = '';
      box.appendChild(node(doc, 'h3', { text: c.title }));
      box.appendChild(node(doc, 'p', { text: c.text }));
      box.appendChild(node(doc, 'p', { class: 'cli-pane-status', text: c.status }));
      box.appendChild(node(doc, 'p', { class: 'cli-pane-last', text: c.last }));
      box.appendChild(node(doc, 'p', { class: 'cli-pane-hint', text: c.hint }));
    }
  }

  function render(doc, view, api, msg) {
    try { renderCard(doc, view, api, msg); renderPanes(doc, view); } catch (_) { /* never break the panel */ }
  }

  const out = { cardModel, paneCard, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = out;
  if (root) root.CliModeUi = out;
})(typeof window !== 'undefined' ? window : null);
