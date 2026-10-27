// alfred-panel.js — 🎩 Alfred's panel UI: chat, "I will" cards, what Alfred did, status line, settings,
// quick buttons and the saved set-up switcher. ONE piece of UI code that renders in either place:
//   • his floating side panel — alfred-window.html (<body data-alfred-host="window">), its own small
//     window that floats over the whole app (alfred-window.js). The default ("Floating").
//   • the drawer in the control panel (controls.html) — "Docked (beside)", exactly as before: it
//     reserves its width on the right so the native AI panes and the Akọwe page are laid out beside it.
// In controls.html the "🎩 Alfred: Off" switch in the title bar is all there is until he is turned on.
// All state lives in main (alfred-main.js); both places get the same events. Talks to main only
// through window.api.alfred* (preload.js / alfred-window-preload.js).
(function () {
  'use strict';
  const api = window.api || {};
  if (typeof api.alfredStatus !== 'function') return;
  const IN_WINDOW = !!(document.body && document.body.dataset && document.body.dataset.alfredHost === 'window');
  const sw = IN_WINDOW ? null : document.getElementById('btn-alfred-switch');
  if (!IN_WINDOW && !sw) return;

  const W = 390;
  const ROOT = IN_WINDOW ? 'alfred-window' : 'alfred-drawer';
  let built = false;     // the panel UI exists in this document
  let open = true;       // the docked drawer is shown (control panel only)
  let last = null;
  let sending = false;
  const $ = (id) => document.getElementById(id);
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }
  const sync = () => { if (IN_WINDOW) return; try { requestAnimationFrame(() => { const p = api.syncPanes && api.syncPanes(); if (p && p.catch) p.catch(() => {}); }); } catch (_) {} };
  // Where his panel lives. A main without the setting (older build) means the drawer.
  const panelOf = (st) => (st && st.settings && st.settings.panel) || null;
  const floating = (st) => { const p = panelOf(st); return !!(p && p.mode === 'floating'); };
  const persona = (st) => (st && st.settings && st.settings.personality) || { name: 'Alfred' };
  const isMac = /Mac/i.test((navigator && (navigator.platform || navigator.userAgent)) || '');
  const SHORTCUT = isMac ? 'Cmd+Shift+A' : 'Ctrl+Shift+A';

  function css() {
    if ($('alfred-style')) return;
    const s = document.createElement('style');
    s.id = 'alfred-style';
    s.textContent = `
      body.alfred-open #wrap, body.alfred-open #akowe-tab, body.alfred-open #images-tab, body.alfred-open #video-tab { margin-right:${W}px; }
      .al-root { display:flex; flex-direction:column; background:#0d0f14; color:#e8ecf5; font-size:13px; }
      #alfred-drawer { position:fixed; top:38px; right:0; bottom:0; width:${W}px; z-index:50; border-left:1px solid #2b3550; }
      #alfred-window { position:fixed; inset:0; border:1px solid #2b3550; box-sizing:border-box; }
      .al-root[hidden] { display:none; }
      .al-root header { display:flex; align-items:center; gap:6px; padding:8px 10px; border-bottom:1px solid #222a3d; background:#121726; }
      #alfred-window header { -webkit-app-region:drag; cursor:move; user-select:none; }
      #alfred-window header button, #alfred-window header select, #alfred-window header input { -webkit-app-region:no-drag; cursor:pointer; }
      .al-root header h2 { margin:0; font-size:14px; flex:1 1 auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .al-root button { font-size:12px; padding:3px 9px; border-radius:6px; border:1px solid #334064; background:#161d30; color:#e8ecf5; cursor:pointer; }
      .al-root button.primary { background:#2c4a8a; border-color:#4a6fc0; }
      .al-root button:disabled { opacity:.5; cursor:default; }
      #alfred-profile { max-width:120px; font-size:11.5px; background:#0b0e16; color:#e8ecf5; border:1px solid #2b3550; border-radius:5px; padding:2px 3px; }
      #alfred-profile-row { display:flex; gap:6px; padding:6px 10px; border-bottom:1px solid #1b2236; background:#10141f; }
      #alfred-profile-row[hidden] { display:none; }
      #alfred-profile-row input { flex:1 1 auto; background:#0b0e16; color:#e8ecf5; border:1px solid #2b3550; border-radius:5px; padding:3px 5px; font-size:12px; }
      #alfred-quick { display:flex; flex-wrap:wrap; gap:5px; padding:6px 10px; border-bottom:1px solid #1b2236; }
      #alfred-quick button { font-size:11.5px; padding:2px 7px; }
      #alfred-quick-msg { padding:0 10px 6px; font-size:11.5px; color:#aab5cf; white-space:pre-wrap; }
      #alfred-quick-msg:empty { display:none; }
      #alfred-statusline { padding:5px 10px; font-size:11.5px; color:#aab5cf; border-bottom:1px solid #1b2236; line-height:1.4; }
      #alfred-statusline .bad { color:#f0a35e; } #alfred-statusline .good { color:#7fd99a; }
      #alfred-settings { padding:8px 10px; border-bottom:1px solid #1b2236; background:#10141f; font-size:12px; display:grid; grid-template-columns:auto 1fr; gap:6px 8px; align-items:center; overflow:auto; max-height:55vh; }
      #alfred-settings[hidden] { display:none; }
      #alfred-settings input[type=text], #alfred-settings input[type=number], #alfred-settings select { width:100%; background:#0b0e16; color:#e8ecf5; border:1px solid #2b3550; border-radius:5px; padding:3px 5px; font-size:12px; box-sizing:border-box; }
      #alfred-settings .full { grid-column:1 / -1; }
      #alfred-settings .warn { color:#f0a35e; font-size:11px; }
      #alfred-chat { flex:1 1 auto; overflow-y:auto; padding:8px 10px; display:flex; flex-direction:column; gap:6px; }
      #alfred-chat:empty::before { content:"🎩 Good day. Ask me anything about your books, images or AIs — e.g. “what's the status of my book?” or “make an image of a lighthouse”. I ask before I change anything."; color:#8792ad; font-size:12px; white-space:pre-wrap; }
      .al-msg { padding:6px 9px; border-radius:9px; max-width:94%; white-space:pre-wrap; word-wrap:break-word; line-height:1.45; }
      .al-you { align-self:flex-end; background:#1e2a47; }
      .al-alfred { align-self:flex-start; background:#171b26; border:1px solid #262e44; }
      .al-notice { align-self:stretch; background:#1c1a10; border:1px solid #4a4220; color:#f1e3b0; font-size:12px; }
      .al-msg img { display:block; max-width:100%; max-height:180px; margin-top:6px; border-radius:6px; }
      #alfred-card { margin:0 10px 8px; padding:9px 10px; border:1px solid #c79a3a; background:#1d1709; border-radius:10px; overflow:auto; max-height:50vh; }
      #alfred-card[hidden] { display:none; }
      #alfred-card h3 { margin:0 0 6px; font-size:13px; color:#f3d488; }
      #alfred-card ol { margin:0 0 8px; padding-left:20px; }
      #alfred-card li { margin-bottom:6px; white-space:pre-wrap; }
      #alfred-card pre { background:#0b0e16; border:1px solid #333; padding:6px; border-radius:6px; overflow:auto; max-height:160px; font-size:11.5px; white-space:pre; }
      #alfred-card label { display:block; font-size:11.5px; color:#cbb98a; margin-top:2px; }
      #alfred-card .al-actions { display:flex; gap:8px; }
      #alfred-busy { padding:4px 10px; font-size:12px; color:#9fb2e0; display:flex; align-items:center; gap:8px; }
      #alfred-busy[hidden] { display:none; }
      #alfred-compose { display:flex; gap:6px; padding:8px 10px; border-top:1px solid #222a3d; }
      #alfred-input { flex:1 1 auto; resize:none; height:52px; background:#0b0e16; color:#e8ecf5; border:1px solid #2b3550; border-radius:7px; padding:5px 7px; font:inherit; font-size:13px; }
      #alfred-did { border-top:1px solid #222a3d; padding:6px 10px 8px; font-size:12px; max-height:24vh; overflow:auto; }
      #alfred-did summary { cursor:pointer; color:#aab5cf; }
      #alfred-did ul { margin:5px 0 0; padding-left:18px; }
      #alfred-did li.fail { color:#f0a35e; }
      #btn-alfred-switch[aria-checked="true"] { background:#1f2a44 !important; border-color:#4a6fc0 !important; color:#eef3ff !important; }
      .al-flash { outline:2px solid #4a6fc0 !important; outline-offset:2px; transition:outline-color .6s; }
    `;
    document.head.appendChild(s);
  }

  // ---- the toggle in the control panel's title bar ("◂ Panel" / "▸ Panel", or "🗗 Panel" when floating)
  function ensureToggle() {
    if (IN_WINDOW || $('btn-alfred-drawer')) return;
    const toggle = h('button', { id: 'btn-alfred-drawer', type: 'button', title: 'Show or hide Alfred\'s panel', style: 'font-size:12px;padding:3px 8px;margin-right:8px;border-radius:7px;border:1px solid #334064;background:#161d30;color:#e8ecf5;cursor:pointer;', onclick: () => {
      if (floating(last)) { Promise.resolve(api.alfredPanelToggle && api.alfredPanelToggle()).catch(() => {}); return; }
      setOpen(!open);
    } }, '◂ Panel');
    sw.after(toggle);
  }
  function paintToggle() {
    const t = $('btn-alfred-drawer'); if (!t) return;
    if (floating(last)) {
      const p = panelOf(last);
      t.textContent = '🗗 Panel';
      t.title = `Show or hide Alfred's floating panel (${SHORTCUT})`;
      t.setAttribute('aria-pressed', String(!!(p && p.open)));
    } else {
      t.textContent = open ? '▸ Panel' : '◂ Panel';
      t.title = `Show or hide Alfred's panel (${SHORTCUT})`;
      t.removeAttribute('aria-pressed');
    }
  }

  function build() {
    if (built) return;
    built = true;
    css();
    const root = h(IN_WINDOW ? 'div' : 'aside', { id: ROOT, class: 'al-root', role: 'complementary', 'aria-label': 'Alfred' },
      h('header', null,
        h('h2', { id: 'alfred-title' }, '🎩 Alfred'),
        h('select', { id: 'alfred-profile', title: 'Saved set-ups — switch his AI, model and personality in one go', 'aria-label': 'Saved set-up', onchange: (e) => useProfile(e.target.value) }),
        h('button', { id: 'alfred-btn-profile-save', type: 'button', title: 'Save the current set-up as…', onclick: () => { const r = $('alfred-profile-row'); r.hidden = !r.hidden; if (!r.hidden) { const i = $('alfred-profile-name'); i.value = (last && last.settings && last.settings.activeProfile) || ''; i.focus(); } } }, '💾'),
        h('button', { id: 'alfred-btn-settings', type: 'button', title: 'Alfred\'s settings', onclick: () => { const s = $('alfred-settings'); s.hidden = !s.hidden; if (!s.hidden) fillSettings(); } }, '⚙'),
        h('button', { id: 'alfred-btn-clear', type: 'button', title: 'Start a new conversation', onclick: () => api.alfredClear() }, '🧹'),
        h('button', { id: 'alfred-btn-hide', type: 'button', title: IN_WINDOW ? `Hide the panel — Alfred stays on (${SHORTCUT} brings it back)` : 'Hide the panel (Alfred stays on)', onclick: () => hidePanel() }, '×')),
      h('div', { id: 'alfred-profile-row', hidden: true },
        h('input', { id: 'alfred-profile-name', type: 'text', maxlength: '40', placeholder: 'Name this set-up, e.g. "Fast local"', 'aria-label': 'Set-up name', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); saveProfile(); } } }),
        h('button', { id: 'alfred-profile-save', type: 'button', class: 'primary', onclick: saveProfile }, 'Save')),
      h('div', { id: 'alfred-statusline', role: 'status', 'aria-live': 'polite' }, '…'),
      h('div', { id: 'alfred-quick', role: 'toolbar', 'aria-label': 'Quick actions' },
        h('button', { id: 'alfred-q-status', type: 'button', title: 'Ask him for the status of everything', onclick: () => quickAsk("What's the status of everything — my book, the AIs and the image generator?") }, '📊 Status'),
        h('button', { id: 'alfred-q-check', type: 'button', title: 'Check that his AI is installed, running and answering', onclick: checkAi }, '🩺 Check his AI'),
        h('button', { id: 'alfred-q-picture', type: 'button', title: 'Start a request for a picture', onclick: () => { const i = $('alfred-input'); i.value = 'Make a picture of '; i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch (_) {} } }, '🎨 Make a picture'),
        h('button', { id: 'alfred-q-book', type: 'button', title: 'Ask about your book', onclick: () => quickAsk("What's the status of my book?") }, '📖 My book'),
        h('button', { id: 'alfred-q-setup', type: 'button', title: 'Open the 🤵 Butler section where his AI is set up', onclick: () => { if (IN_WINDOW) Promise.resolve(api.alfredShowButler && api.alfredShowButler()).catch(() => {}); else showButler(); } }, '⚙ Set up his AI')),
      h('div', { id: 'alfred-quick-msg', role: 'status', 'aria-live': 'polite' }),
      settingsBox(),
      h('div', { id: 'alfred-chat', 'aria-live': 'polite' }),
      h('div', { id: 'alfred-card', hidden: true, role: 'dialog', 'aria-label': 'Alfred asks before he does this' }),
      h('div', { id: 'alfred-busy', hidden: true }, h('span', { id: 'alfred-busy-text' }, '🎩 Working on it…'), h('button', { id: 'alfred-stop', type: 'button', onclick: () => api.alfredCancel() }, '■ Stop')),
      h('div', { id: 'alfred-compose' },
        h('textarea', { id: 'alfred-input', placeholder: 'Ask Alfred…  (Enter to send, Shift+Enter for a new line)', 'aria-label': 'Message to Alfred' }),
        h('button', { id: 'alfred-send', type: 'button', class: 'primary', onclick: () => send() }, 'Send')),
      h('details', { id: 'alfred-did' }, h('summary', null, 'What Alfred did ', h('span', { id: 'alfred-did-count' }, '(0)')), h('ul', { id: 'alfred-did-list' })));
    document.body.appendChild(root);
    $('alfred-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  }
  function settingsBox() {
    const opt = (v, t) => h('option', { value: v }, t);
    return h('div', { id: 'alfred-settings', hidden: true },
      h('label', { for: 'alfred-set-brain' }, 'His AI'),
      h('select', { id: 'alfred-set-brain' }, opt('auto', 'Automatic (local model, else the connected AI)'), opt('local', 'Local model (Ollama)'), opt('api', 'The connected AI (manager / API)'), opt('pane', 'A web AI pane')),
      h('label', { for: 'alfred-set-endpoint' }, 'Ollama address'),
      h('input', { id: 'alfred-set-endpoint', type: 'text', placeholder: 'http://127.0.0.1:11434/v1' }),
      h('label', { for: 'alfred-set-model' }, 'Model'),
      h('input', { id: 'alfred-set-model', type: 'text', list: 'alfred-models', placeholder: 'qwen2.5:7b' }),
      h('datalist', { id: 'alfred-models' }),
      h('label', { for: 'alfred-set-pane' }, 'Web AI'),
      h('select', { id: 'alfred-set-pane' }, opt('chatgpt', 'ChatGPT'), opt('claude', 'Claude'), opt('gemini', 'Gemini')),
      h('label', { for: 'alfred-set-steps' }, 'Max steps'),
      h('input', { id: 'alfred-set-steps', type: 'number', min: '1', max: '20' }),
      h('label', { for: 'alfred-set-mode' }, 'His panel'),
      h('select', { id: 'alfred-set-mode', onchange: () => { const r = $('alfred-set-ontop-row'); if (r) r.hidden = $('alfred-set-mode').value !== 'floating'; } }, opt('docked', 'Side panel (moves the app over)'), opt('floating', 'Separate window (over the app)')),
      h('label', { class: 'full', id: 'alfred-set-ontop-row', hidden: true }, h('input', { id: 'alfred-set-ontop', type: 'checkbox' }), ' Keep the window on top of other programs too'),
      h('label', { class: 'full' }, h('input', { id: 'alfred-set-notices', type: 'checkbox' }), ' Tell me when something happens (AI fixed, book paused/finished, image ready)'),
      h('label', { class: 'full' }, h('input', { id: 'alfred-set-interpreter', type: 'checkbox' }), ' Allow Open Interpreter (runs code on this computer — he always shows the exact code and asks first)'),
      h('div', { class: 'full warn' }, 'Open Interpreter stays off unless you tick it, and is never used when a direct tool exists.'),
      h('div', { class: 'full', style: 'display:flex;gap:6px;flex-wrap:wrap' },
        h('button', { id: 'alfred-set-save', type: 'button', class: 'primary', onclick: saveSettings }, 'Save'),
        h('button', { id: 'alfred-set-test', type: 'button', onclick: testAi }, 'Test my AI'),
        h('button', { id: 'alfred-set-reset-allow', type: 'button', title: 'Ask again before every change', onclick: resetAllow }, 'Forget "always allow"')),
      h('div', { id: 'alfred-set-msg', class: 'full', style: 'font-size:11.5px;color:#aab5cf' }));
  }
  function fillSettings() {
    const s = last && last.settings; if (!s) return;
    $('alfred-set-brain').value = s.brain; $('alfred-set-endpoint').value = s.local.endpoint || ''; $('alfred-set-model').value = s.local.model || '';
    $('alfred-set-pane').value = s.pane.site; $('alfred-set-steps').value = String(s.maxSteps);
    $('alfred-set-notices').checked = !!s.notices; $('alfred-set-interpreter').checked = !!s.interpreter;
    const p = s.panel || { mode: 'docked', otherApps: false };
    $('alfred-set-mode').value = p.mode === 'floating' ? 'floating' : 'docked'; $('alfred-set-ontop').checked = !!p.otherApps;
    $('alfred-set-ontop-row').hidden = p.mode !== 'floating';
    Promise.resolve(api.alfredModels && api.alfredModels()).then((r) => {
      const dl = $('alfred-models'); if (!dl || !r || !Array.isArray(r.models)) return;
      dl.textContent = ''; for (const m of r.models) dl.append(h('option', { value: m }));
      if (r.ok && r.models.length) $('alfred-set-msg').textContent = `Ollama has: ${r.models.slice(0, 6).join(', ')}`;
    }).catch(() => {});
  }
  async function saveSettings() {
    const patch = { brain: $('alfred-set-brain').value, local: { endpoint: $('alfred-set-endpoint').value.trim(), model: $('alfred-set-model').value.trim() }, pane: { site: $('alfred-set-pane').value }, maxSteps: Number($('alfred-set-steps').value) || 8, notices: $('alfred-set-notices').checked, interpreter: $('alfred-set-interpreter').checked };
    await api.alfredSettings(patch);
    const p = (last && last.settings && last.settings.panel) || null;
    const mode = $('alfred-set-mode').value; const otherApps = $('alfred-set-ontop').checked;
    if (typeof api.alfredPanel === 'function' && (!p || p.mode !== mode || !!p.otherApps !== otherApps)) {
      try { await api.alfredPanel({ mode, otherApps }); } catch (_) {}
    }
    const m = $('alfred-set-msg'); if (m) m.textContent = 'Saved.';
  }
  async function testAi() {
    const box = $('alfred-set-msg');
    box.textContent = 'Checking…';
    let r = null; try { r = await api.alfredTestAi(); } catch (_) { r = null; }
    box.textContent = (r && r.message) || (r && r.ok ? 'OK' : 'Not reachable');
    // The model isn't installed: one click picks an installed one and saves.
    if (r && !r.ok && Array.isArray(r.installed) && r.installed.length) {
      const row = h('div', { class: 'alfred-pick-model', style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px' });
      for (const m of r.installed.slice(0, 6)) {
        row.append(h('button', { type: 'button', onclick: async () => { $('alfred-set-model').value = m; await saveSettings(); testAi(); } }, `Use ${m}`));
      }
      box.append(row);
    }
  }
  async function resetAllow() {
    const s = last && last.settings; if (!s) return;
    const off = {}; for (const k of Object.keys(s.alwaysAllow || {})) off[k] = false;
    // setSettings merges, so clear by sending false for each
    await api.alfredSettings({ alwaysAllow: off });
    $('alfred-set-msg').textContent = 'He will ask again before every change.';
  }

  // ---- quick buttons + saved set-ups
  function quickMsg(t) { const q = $('alfred-quick-msg'); if (q) q.textContent = t || ''; }
  function quickAsk(text) {
    if (last && (last.busy || last.card)) { quickMsg(last.card ? 'Please answer the card first (✔ Do it or ✖ No).' : 'He is still working — press ■ Stop to cancel.'); return; }
    send(text);
  }
  async function checkAi() {
    quickMsg('🩺 Checking his AI…');
    let r = null;
    if (typeof api.llmCheck === 'function') { try { r = await api.llmCheck(); } catch (_) { r = null; } }
    if (r && Array.isArray(r.rows)) {
      const icon = (ok) => (ok === true ? '✔' : ok === false ? '✖' : '⚠');
      quickMsg([r.summary || (r.ok ? 'Everything is ready.' : 'Something needs fixing — ⚙ Set up his AI.')].concat(r.rows.slice(0, 10).map((x) => `${icon(x.ok)} ${x.label}${x.detail ? ` — ${x.detail}` : ''}`)).join('\n'));
      return;
    }
    try { r = await api.alfredTestAi(); } catch (_) { r = null; }
    quickMsg(`${r && r.ok ? '✔' : '✖'} ${(r && r.message) || (r && r.ok ? 'His AI answers.' : 'His AI is not reachable.')}${r && !r.ok ? ' — ⚙ Set up his AI.' : ''}`);
  }
  function paintProfiles(s) {
    const sel = $('alfred-profile'); if (!sel) return;
    const list = (s && Array.isArray(s.profiles)) ? s.profiles : [];
    const active = (s && s.activeProfile) || '';
    sel.textContent = '';
    sel.append(h('option', { value: '' }, list.length ? (active ? '— set-ups —' : '(no set-up)') : '(no saved set-ups)'));
    for (const p of list) sel.append(h('option', { value: p.name }, p.name));
    sel.value = active;
    sel.disabled = !list.length;
  }
  async function useProfile(name) {
    if (!name || typeof api.alfredUseProfile !== 'function') return;
    let r = null; try { r = await api.alfredUseProfile(name); } catch (_) {}
    quickMsg((r && r.message) || '');
  }
  async function saveProfile() {
    const i = $('alfred-profile-name'); if (!i || typeof api.alfredSaveProfile !== 'function') return;
    let r = null; try { r = await api.alfredSaveProfile(i.value.trim()); } catch (_) {}
    quickMsg((r && r.message) || 'Could not save that set-up.');
    if (r && r.ok) $('alfred-profile-row').hidden = true;
  }

  // ---- showing / hiding
  function hidePanel() {
    if (IN_WINDOW) { Promise.resolve(api.alfredPanelToggle && api.alfredPanelToggle(false)).catch(() => {}); return; }
    setOpen(false);
  }
  function setOpen(v) {
    open = !!v;
    const d = $('alfred-drawer'); if (d) d.hidden = !open;
    document.body.classList.toggle('alfred-open', open && !!(last && last.enabled) && built);
    paintToggle();
    try { localStorage.setItem('alfredOpen', open ? '1' : '0'); } catch (_) {}
    sync();
  }
  function removePanel() {
    const d = $(ROOT); if (d) d.remove();
    if (!IN_WINDOW) document.body.classList.remove('alfred-open');
    built = false;
    sync();
  }
  function teardown() {
    removePanel();
    const t = $('btn-alfred-drawer'); if (t) t.remove();
  }
  /** "⚙ Set up his AI": bring the 🤵 Butler section into view (expanded), on the main tab. */
  function showButler() {
    try { const tab = $('tab-app-main'); if (tab && !tab.classList.contains('active')) tab.click(); } catch (_) {}
    try { const t = $('tab-systemai'); if (t) t.click(); } catch (_) {}
    const target = $('llm-setup') || $('alfred-persona') || $('col-systemai');
    if (!target) return;
    try { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { try { target.scrollIntoView(); } catch (_) {} }
    target.classList.add('al-flash');
    setTimeout(() => target.classList.remove('al-flash'), 1600);
  }

  function aiWord(s) {
    if (s.brain === 'pane') return `${{ chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' }[s.pane.site]} (web pane)`;
    if (s.brain === 'api') return 'the connected AI';
    if (s.brain === 'local') return `Ollama · ${s.local.model}`;
    return `automatic (Ollama · ${s.local.model}, else the connected AI)`;
  }
  // What Alfred did also goes into the 🎩 Butler section's activity log (control panel only), once each.
  let mirroredTs = null;
  function mirrorActivity(st) {
    if (IN_WINDOW || typeof window.appendButlerLine !== 'function') return;
    const acts = Array.isArray(st.activity) ? st.activity : [];
    if (mirroredTs == null) { mirroredTs = acts.reduce((m, a) => Math.max(m, a.ts || 0), 0); return; } // history stays in his panel
    for (const a of acts) {
      if (!a || !(a.ts > mirroredTs)) continue;
      try { window.appendButlerLine({ cls: 'bl-butler', who: '🎩 Alfred', text: `${a.ok ? '✔' : '✖'} ${a.text}${a.ok ? '' : ` — ${a.message || ''}`}` }); } catch (_) {}
    }
    mirroredTs = acts.reduce((m, a) => Math.max(m, a.ts || 0), mirroredTs);
  }
  function render(st) {
    if (!st) return;
    last = st;
    mirrorActivity(st);
    if (sw) {
      sw.setAttribute('aria-checked', String(!!st.enabled));
      sw.textContent = st.enabled ? '🎩 Alfred: On' : '🎩 Alfred: Off';
    }
    if (!st.enabled) {
      if (IN_WINDOW) { if (!built) { css(); } document.body.textContent = ''; built = false; document.body.append(h('div', { id: 'alfred-off', style: 'padding:16px;color:#8792ad;font-size:13px' }, '🎩 Alfred is off. Turn him on with the 🎩 switch in the control panel.')); return; }
      teardown(); return;
    }
    if (IN_WINDOW) { const o = $('alfred-off'); if (o) o.remove(); }
    // The control panel draws the drawer only when he is Docked; when Floating, his own window does.
    if (!IN_WINDOW) {
      ensureToggle();
      if (floating(st)) {
        if (built) removePanel();
        paintToggle();
        return;
      }
      if (!built) { build(); let o = '1'; try { o = localStorage.getItem('alfredOpen') || '1'; } catch (_) {} setOpen(o !== '0'); }
      else document.body.classList.toggle('alfred-open', open);
      paintToggle();
    } else if (!built) build();
    // title + set-ups
    const ps = persona(st);
    $('alfred-title').textContent = `🎩 ${ps.name || 'Alfred'}`;
    if (IN_WINDOW) { try { document.title = `🎩 ${ps.name || 'Alfred'}`; } catch (_) {} }
    paintProfiles(st.settings);
    // status line
    const sl = $('alfred-statusline'); sl.textContent = '';
    const ai = st.ai || {};
    sl.append(`His AI: ${aiWord(st.settings)} `);
    if (ai.at) sl.append(h('span', { class: ai.ok ? 'good' : 'bad' }, ai.ok ? '✓ answering' : '✗ not reachable'));
    const c = st.connected || {};
    sl.append(h('br'), 'Tools: ',
      h('span', { class: c.akowe ? 'good' : 'bad' }, `📖 Akọwe ${c.akowe ? '✓' : '✗'}`), ' · ',
      h('span', { class: c.images ? 'good' : 'bad' }, `🎨 images ${c.images ? '✓' : '✗'}`), ' · ',
      h('span', { class: c.video ? 'good' : 'bad' }, `🎬 video ${c.video ? '✓' : 'not yet'}`), ' · ',
      `💬 AIs ${c.panes || 0}/3`, st.settings.interpreter ? ` · 🧪 Open Interpreter ${c.interpreter ? '✓' : '(not set up)'}` : '');
    // chat
    const chat = $('alfred-chat');
    const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
    chat.textContent = '';
    for (const m of st.chat || []) chat.append(msgEl(m));
    if (atBottom || sending) chat.scrollTop = chat.scrollHeight;
    // card
    renderCard(st.card);
    // busy
    $('alfred-busy').hidden = !st.busy;
    $('alfred-send').disabled = !!st.busy || !!st.card;
    for (const id of ['alfred-q-status', 'alfred-q-book']) { const b = $(id); if (b) b.disabled = !!st.busy || !!st.card; }
    // what Alfred did
    const list = $('alfred-did-list'); list.textContent = '';
    const acts = (st.activity || []).slice().reverse();
    $('alfred-did-count').textContent = `(${acts.length})`;
    for (const a of acts) list.append(h('li', { class: a.ok ? '' : 'fail', title: a.message || '' }, `${new Date(a.ts).toLocaleTimeString()} ${a.ok ? '✔' : '✖'} ${a.text}${a.auto ? ' (always allowed)' : ''}${a.ok ? '' : ` — ${a.message}`}`));
  }
  function fileUrl(p) { return 'file:///' + String(p).replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/'); }
  function msgEl(m) {
    const e = h('div', { class: `al-msg al-${m.role}`, 'data-role': m.role }, m.text);
    if (m.image) e.append(h('img', { src: fileUrl(m.image), alt: 'the image Alfred made' }));
    return e;
  }
  function renderCard(card) {
    const box = $('alfred-card');
    // the same card re-rendered: keep the user's ticks (a state update must not undo them)
    const ticked = box.dataset.id && card && box.dataset.id === card.id ? Array.from(box.querySelectorAll('input.al-always:checked')).map((x) => x.dataset.tool) : [];
    box.textContent = '';
    if (!card) { box.hidden = true; delete box.dataset.id; return; }
    box.hidden = false;
    box.dataset.id = card.id;
    box.append(h('h3', null, '🎩 I will:'));
    if (card.intro) box.append(h('p', { style: 'margin:0 0 6px;font-size:12px;color:#cbb98a' }, card.intro));
    const ol = h('ol');
    for (const s of card.steps) {
      const li = h('li', { 'data-tool': s.tool }, s.code ? `${s.title} — here is the exact ${s.code.language} code:` : s.text);
      if (s.code) li.append(h('pre', null, s.code.code));
      if (s.allowAlways) li.append(h('label', null, h('input', { type: 'checkbox', class: 'al-always', 'data-tool': s.allowKey || s.tool, checked: ticked.includes(s.allowKey || s.tool) }), s.allowKey && s.allowKey.includes(':') ? ' Always allow this without asking' : ` Always allow "${s.title}" without asking`));
      ol.append(li);
    }
    box.append(ol, h('div', { class: 'al-actions' },
      h('button', { id: 'alfred-do-it', type: 'button', class: 'primary', onclick: () => decide(true) }, '✔ Do it'),
      h('button', { id: 'alfred-no', type: 'button', onclick: () => decide(false) }, '✖ No')));
  }
  async function decide(yes) {
    const box = $('alfred-card'); const id = box.dataset.id;
    for (const b of box.querySelectorAll('button')) b.disabled = true;
    if (yes) {
      const allow = Array.from(box.querySelectorAll('input.al-always:checked')).map((x) => x.dataset.tool);
      box.hidden = true;
      $('alfred-busy').hidden = false;
      await api.alfredConfirm(id, allow);
    } else await api.alfredReject(id);
  }
  async function send(preset) {
    const input = $('alfred-input');
    const text = (typeof preset === 'string' ? preset : input.value).trim();
    if (!text || sending) return;
    sending = true;
    if (typeof preset !== 'string') input.value = '';
    $('alfred-busy').hidden = false;
    try {
      const r = await api.alfredAsk(text);
      if (r && r.ok === false && r.message) { const chat = $('alfred-chat'); chat.append(msgEl({ role: 'alfred', text: r.message })); chat.scrollTop = chat.scrollHeight; if ((r.error === 'EMPTY' || r.error === 'BUSY') && typeof preset !== 'string') input.value = text; }
    } finally { sending = false; }
  }

  if (sw) {
    sw.addEventListener('click', async () => {
      const on = !(last && last.enabled);
      sw.disabled = true;
      try { render(await api.alfredSetEnabled(on)); } finally { sw.disabled = false; }
    });
  }
  // Ctrl/Cmd+Shift+A: main catches it on every page of the app (before-input-event) and the page never
  // sees it. This is the fallback for a key that reached the page anyway (e.g. synthetic input).
  document.addEventListener('keydown', (e) => {
    if (e.repeat || !e.shiftKey || e.altKey || String(e.key || '').toLowerCase() !== 'a') return;
    if (!(isMac ? e.metaKey : (e.ctrlKey && !e.metaKey))) return;
    if (!(last && last.enabled) || typeof api.alfredPanelToggle !== 'function') return;
    e.preventDefault();
    Promise.resolve(api.alfredPanelToggle()).catch(() => {});
  }, true);
  // The floating window: Escape hides it — but never while a card is waiting for your answer.
  if (IN_WINDOW) {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const card = $('alfred-card');
      if ((card && !card.hidden) || (last && last.card)) return;
      const s = $('alfred-settings'); if (s && !s.hidden) { s.hidden = true; return; }
      hidePanel();
    });
  }
  if (typeof api.onAlfred === 'function') {
    api.onAlfred((p) => {
      if (!p) return;
      if (p.type === 'show-tab') { if (!IN_WINDOW && p.tab) { const b = document.getElementById(`tab-app-${p.tab}`); if (b) b.click(); } return; }
      if (p.type === 'show-butler') { if (!IN_WINDOW) showButler(); return; }
      if (p.type === 'toggle-panel') { if (!IN_WINDOW && built && !floating(last)) setOpen(typeof p.open === 'boolean' ? p.open : !open); return; }
      if (p.type === 'state' && p.state) render(p.state);
      else if (last && last.enabled && built) {
        // message / card / activity events: refresh from a fresh status (cheap, no AI call)
        Promise.resolve(api.alfredStatus()).then(render).catch(() => {});
      }
    });
  }
  Promise.resolve(api.alfredStatus()).then(render).catch(() => {});
})();
