// alfred-panel.js — 🎩 Alfred's TALK panel: his side panel, docked on the right of the control panel
// (controls.html). It reserves its width, so the native AI panes, the 📖 Akọwe page, 🎨 Images and 🎬 Video
// are laid out BESIDE it on every tab — it never covers anything. Ctrl/Cmd+Shift+A shows / hides it from
// anywhere in the app (main catches the key on every page: alfred-main.js).
//   • 8 big action buttons that do something real through Alfred (a tiny form first when he needs a detail)
//   • "❓ Everything I can do": a searchable list of all he can do (alfred:catalog), ▶ Try it fills the box
//   • chat, the "I will" cards, what Alfred did, his status line, ⚙ settings and the saved set-ups
// His SETUP panel (one-button setup, check, models, personality, activity log) is the 🎩 Butler section of
// the control panel (#col-systemai). In controls.html the "🎩 Alfred: Off" switch in the title bar is all
// there is until he is turned on. All state lives in main (alfred-main.js); talks to main only through
// window.api.alfred* (preload.js).
(function () {
  'use strict';
  const api = window.api || {};
  if (typeof api.alfredStatus !== 'function') return;
  const sw = document.getElementById('btn-alfred-switch');
  if (!sw) return;

  // His width: 320px on a small or laptop screen, up to 440px on a big one (the page is laid out beside it,
  // so on a 1024–1280px window the app keeps enough room for the User Panel and the three AI windows).
  const W = 'clamp(320px, 22.5vw, 440px)';
  let built = false;     // the panel UI exists in this document
  let open = true;       // the drawer is shown
  let last = null;
  let sending = false;
  let catalog = null;    // the "❓ Everything I can do" list, once loaded
  let formKind = null;   // which big button's form is open
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
  const sync = () => { try { requestAnimationFrame(() => { const p = api.syncPanes && api.syncPanes(); if (p && p.catch) p.catch(() => {}); }); } catch (_) {} };
  const persona = (st) => (st && st.settings && st.settings.personality) || { name: 'Alfred' };
  const isMac = /Mac/i.test((navigator && (navigator.platform || navigator.userAgent)) || '');
  const SHORTCUT = isMac ? 'Cmd+Shift+A' : 'Ctrl+Shift+A';

  function css() {
    if ($('alfred-style')) return;
    const s = document.createElement('style');
    s.id = 'alfred-style';
    s.textContent = `
      body.alfred-open #wrap, body.alfred-open #akowe-tab, body.alfred-open #images-tab, body.alfred-open #video-tab { margin-right:${W}; }
      .al-root { display:flex; flex-direction:column; background:#0d0f14; color:#e8ecf5; font-size:13px; }
      #alfred-drawer { position:fixed; top:38px; right:0; bottom:0; width:${W}; z-index:50; border-left:1px solid #2b3550; }
      .al-root[hidden] { display:none; }
      .al-root header { display:flex; align-items:center; gap:6px; padding:8px 10px; border-bottom:1px solid #222a3d; background:#121726; }
      .al-root header h2 { margin:0; font-size:14px; flex:1 1 auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .al-root button { font-size:12px; padding:3px 9px; border-radius:6px; border:1px solid #334064; background:#161d30; color:#e8ecf5; cursor:pointer; }
      .al-root button.primary { background:#2c4a8a; border-color:#4a6fc0; }
      .al-root button:disabled { opacity:.5; cursor:default; }
      #alfred-profile[hidden] { display:none; }
      .al-root header button { min-width:30px; }
      #alfred-profile { max-width:130px; font-size:11.5px; background:#0b0e16; color:#e8ecf5; border:1px solid #2b3550; border-radius:5px; padding:2px 3px; }
      #alfred-profile-row { display:flex; gap:6px; padding:6px 10px; border-bottom:1px solid #1b2236; background:#10141f; }
      #alfred-profile-row[hidden] { display:none; }
      #alfred-profile-row input { flex:1 1 auto; background:#0b0e16; color:#e8ecf5; border:1px solid #2b3550; border-radius:5px; padding:3px 5px; font-size:12px; }
      #alfred-actions { flex:0 0 auto; display:grid; grid-template-columns:1fr 1fr; grid-auto-rows:1fr; gap:6px; padding:8px 10px; border-bottom:1px solid #1b2236; }
      #alfred-actions button { display:flex; align-items:center; gap:7px; min-height:40px; padding:6px 9px; font-size:12.5px; font-weight:600; text-align:left; border-radius:9px; background:#141b2e; border-color:#2f3d63; line-height:1.2; }
      #alfred-actions button .al-ic { font-size:19px; flex:0 0 auto; }
      #alfred-actions button:hover:not(:disabled) { background:#1b2540; border-color:#4a6fc0; }
      #alfred-actions button[aria-pressed="true"] { background:#22325a; border-color:#6f93e0; }
      #alfred-form { flex:0 0 auto; margin:0 10px 8px; padding:8px 9px; border:1px solid #2f3d63; background:#10162a; border-radius:9px; display:flex; flex-direction:column; gap:6px; }
      #alfred-form[hidden] { display:none; }
      #alfred-form h3 { margin:0; font-size:12.5px; color:#cfe0ff; }
      #alfred-form label { font-size:11.5px; color:#aab5cf; display:flex; flex-direction:column; gap:3px; }
      #alfred-form input, #alfred-form textarea { background:#0b0e16; color:#e8ecf5; border:1px solid #2b3550; border-radius:6px; padding:4px 6px; font:inherit; font-size:12.5px; }
      #alfred-form textarea { resize:vertical; min-height:40px; }
      #alfred-form .al-row { display:flex; gap:6px; }
      #alfred-form .al-note { font-size:11px; color:#8792ad; }
      #alfred-quick { position:relative; flex:0 0 auto; }
      #alfred-quick-msg { padding:6px 34px 6px 10px; font-size:11.5px; color:#cdd6ee; white-space:pre-wrap; border-bottom:1px solid #1b2236; max-height:30vh; overflow:auto; line-height:1.45; }
      #alfred-quick-msg:empty, #alfred-quick-msg:empty + #alfred-quick-close { display:none; }
      #alfred-quick-close { position:absolute; top:4px; right:16px; padding:0 6px; font-size:12px; line-height:18px; min-width:0; }
      #alfred-quick-msg .al-fix { margin:3px 0 0 14px; font-size:11px; padding:1px 8px; }
      #alfred-catalog { flex:1 1 auto; overflow:hidden; display:flex; flex-direction:column; border-bottom:1px solid #1b2236; min-height:0; }
      #alfred-catalog[hidden] { display:none; }
      #alfred-catalog .al-cat-head { display:flex; gap:6px; align-items:center; padding:6px 10px; }
      #alfred-catalog-search { flex:1 1 auto; background:#0b0e16; color:#e8ecf5; border:1px solid #2b3550; border-radius:6px; padding:4px 7px; font-size:12.5px; }
      #alfred-catalog-list { overflow-y:auto; padding:0 10px 8px; flex:1 1 auto; }
      #alfred-catalog-list h4 { margin:10px 0 4px; font-size:12.5px; color:#cfe0ff; position:sticky; top:0; background:#0d0f14; padding:2px 0; }
      .al-cat-item { display:flex; gap:8px; align-items:flex-start; padding:5px 0; border-top:1px solid #171d2c; }
      .al-cat-item .al-cat-text { flex:1 1 auto; min-width:0; }
      .al-cat-item b { font-size:12px; font-weight:600; }
      .al-cat-item .al-cat-say { font-size:11.5px; color:#9aa6c3; line-height:1.35; }
      .al-cat-item .al-asks { font-size:10.5px; color:#d9b25e; margin-left:4px; font-weight:400; }
      .al-cat-item button { flex:0 0 auto; font-size:11px; padding:2px 7px; }
      #alfred-catalog-empty { padding:10px; font-size:12px; color:#8792ad; }
      #alfred-statusline { flex:0 0 auto; padding:5px 10px; font-size:11.5px; color:#aab5cf; border-bottom:1px solid #1b2236; line-height:1.4; }
      #alfred-statusline .bad { color:#f0a35e; } #alfred-statusline .good { color:#7fd99a; }
      #alfred-settings { padding:10px; border-bottom:1px solid #1b2236; background:#10141f; font-size:12px; display:grid; grid-template-columns:auto 1fr; gap:8px; align-items:center; align-content:start; overflow:auto; flex:1 1 auto; min-height:0; }
      .al-root.al-set-open #alfred-chat { display:none; }
      #alfred-settings[hidden] { display:none; }
      #alfred-settings input[type=text], #alfred-settings input[type=number], #alfred-settings select { width:100%; background:#0b0e16; color:#e8ecf5; border:1px solid #2b3550; border-radius:5px; padding:3px 5px; font-size:12px; box-sizing:border-box; }
      #alfred-settings .full { grid-column:1 / -1; }
      #alfred-settings .al-set-head { display:flex; align-items:center; justify-content:space-between; font-size:12.5px; color:#cfe0ff; }
      #alfred-settings label.full { display:flex; gap:6px; align-items:flex-start; line-height:1.4; }
      #alfred-settings .warn { color:#f0a35e; font-size:11px; }
      #alfred-chat { flex:1 1 0; overflow-y:auto; padding:8px 10px; display:flex; flex-direction:column; gap:8px; min-height:96px; }
      #alfred-chat:empty::before { content:"🎩 Good day. Press a button above, or ask me anything about your books, pictures or AIs — e.g. “what's the status of my book?”. Type “what can you do?” for the full list. I ask before I change anything."; color:#8792ad; font-size:12px; white-space:pre-wrap; }
      .al-root.al-cat-open #alfred-chat { display:none; }
      .al-msg { padding:6px 9px; border-radius:9px; max-width:94%; white-space:pre-wrap; word-wrap:break-word; line-height:1.45; }
      .al-you { align-self:flex-end; background:#1e2a47; }
      .al-alfred { align-self:flex-start; background:#171b26; border:1px solid #262e44; }
      .al-notice { align-self:stretch; background:#1c1a10; border:1px solid #4a4220; color:#f1e3b0; font-size:12px; }
      .al-notice .al-fix { margin-top:6px; font-size:12px; padding:2px 10px; } .al-notice .al-fix-note { margin-top:4px; color:#e8a0a0; }
      .al-rich p { margin:0 0 5px; } .al-rich p:last-child { margin-bottom:0; } .al-rich ul, .al-rich ol { margin:2px 0 5px; padding-left:20px; white-space:normal; } .al-rich li { margin:1px 0; white-space:pre-wrap; }
      .al-rich code { background:#0b0e16; border:1px solid #2b3550; border-radius:4px; padding:0 3px; font-size:11.5px; } .al-rich pre { background:#0b0e16; border:1px solid #2b3550; border-radius:6px; padding:5px 7px; margin:3px 0; overflow:auto; white-space:pre; font-size:11.5px; } .al-rich .al-h { margin:2px 0 4px; }
      .al-outdated { opacity:.62; } .al-outdated .al-rich { text-decoration:line-through; text-decoration-color:rgba(241,227,176,.45); } .al-old { font-size:11px; color:#cfe0ff; margin-bottom:3px; text-decoration:none; }
      .al-msg img { display:block; max-width:100%; max-height:180px; margin-top:6px; border-radius:6px; }
      #alfred-card { flex:0 0 auto; margin:8px 10px; padding:9px 10px; border:1px solid #c79a3a; background:#1d1709; border-radius:10px; max-height:52vh; display:flex; flex-direction:column; min-height:0; box-shadow:0 -4px 14px rgba(0,0,0,.35); }
      #alfred-card[hidden] { display:none; }
      #alfred-card .al-card-body { overflow:auto; min-height:0; flex:1 1 auto; }
      #alfred-card h3 { margin:0 0 6px; font-size:13px; color:#f3d488; }
      #alfred-card ol { margin:0 0 4px; padding-left:20px; }
      #alfred-card li { margin-bottom:6px; white-space:pre-wrap; }
      #alfred-card pre { background:#0b0e16; border:1px solid #333; padding:6px; border-radius:6px; overflow:auto; max-height:160px; font-size:11.5px; white-space:pre; }
      #alfred-card label { display:block; font-size:11.5px; color:#cbb98a; margin-top:2px; }
      #alfred-card .al-actions { display:flex; gap:8px; padding-top:8px; border-top:1px solid #3a3018; flex:0 0 auto; }
      #alfred-card .al-actions button { padding:5px 14px; font-size:12.5px; }
      #alfred-busy { flex:0 0 auto; padding:4px 10px; font-size:12px; color:#9fb2e0; display:flex; align-items:center; gap:8px; }
      #alfred-busy[hidden] { display:none; }
      #alfred-compose { flex:0 0 auto; display:flex; gap:6px; padding:8px 10px; border-top:1px solid #222a3d; }
      #alfred-send { padding:0 14px; }
      #alfred-input { flex:1 1 auto; resize:none; height:52px; background:#0b0e16; color:#e8ecf5; border:1px solid #2b3550; border-radius:7px; padding:5px 7px; font:inherit; font-size:13px; }
      #alfred-did { flex:0 0 auto; border-top:1px solid #222a3d; padding:6px 10px 8px; font-size:12px; max-height:24vh; overflow:auto; }
      #alfred-did summary { cursor:pointer; color:#aab5cf; }
      #alfred-did ul { margin:5px 0 0; padding-left:18px; }
      #alfred-did li.fail { color:#f0a35e; }
      #btn-alfred-switch[aria-checked="true"] { background:#1f2a44 !important; border-color:#4a6fc0 !important; color:#eef3ff !important; }
      .al-flash { outline:2px solid #4a6fc0 !important; outline-offset:2px; transition:outline-color .6s; }
    `;
    document.head.appendChild(s);
  }

  // ---- the toggle in the control panel's title bar ("◂ Panel" / "▸ Panel")
  function ensureToggle() {
    if ($('btn-alfred-drawer')) return;
    const toggle = h('button', { id: 'btn-alfred-drawer', type: 'button', title: `Show or hide Alfred's panel (${SHORTCUT})`, style: 'font-size:12px;padding:3px 8px;margin-right:8px;border-radius:7px;border:1px solid #334064;background:#161d30;color:#e8ecf5;cursor:pointer;', onclick: () => setOpen(!open) }, '◂ Panel');
    sw.after(toggle);
  }
  function paintToggle() {
    const t = $('btn-alfred-drawer'); if (!t) return;
    t.textContent = open ? '▸ Panel' : '◂ Panel';
    t.title = `Show or hide Alfred's panel (${SHORTCUT})`;
  }

  // ---- the 8 big buttons: each does something real through Alfred
  const ACTIONS = [
    { id: 'character', ic: '🧑', label: 'Make a character', tip: 'A new character for your book: Alfred starts their dossier in the Character Forge and invents the rest (you approve it).' },
    { id: 'picture', ic: '🎨', label: 'Make a picture', tip: 'Say what the picture should show; Alfred makes it (he asks first).' },
    { id: 'video', ic: '🎬', label: 'Make a video', tip: 'Say what the short video should show; Alfred makes it with the 🎬 Video module (he asks first).' },
    { id: 'cover', ic: '🖼', label: 'Design a cover', tip: 'Alfred designs your book\'s cover and makes the cover art (he asks first).' },
    { id: 'book', ic: '📖', label: 'My book', tip: 'Where your book is: the checklist, the "Make a book for me" run, any problems.' },
    { id: 'continue', ic: '✍', label: 'Continue / make my book', tip: 'Carry on with your book (resume the "Make a book for me" run), or start a new book from your idea.' },
    { id: 'check', ic: '🩺', label: 'Check everything', tip: 'Checks his AI and the whole app (no AI needed) and shows what to fix.' },
    { id: 'catalog', ic: '❓', label: 'Everything I can do', tip: 'A searchable list of everything Alfred can do, with ▶ Try it.' },
  ];
  const WORK = new Set(['character', 'picture', 'video', 'cover', 'book', 'continue']); // these send to Alfred

  function build() {
    if (built) return;
    built = true;
    css();
    const root = h('aside', { id: 'alfred-drawer', class: 'al-root', role: 'complementary', 'aria-label': 'Alfred' },
      h('header', null,
        h('h2', { id: 'alfred-title' }, '🎩 Alfred'),
        h('select', { id: 'alfred-profile', title: 'Saved set-ups — switch his AI, model and personality in one go', 'aria-label': 'Saved set-up', onchange: (e) => useProfile(e.target.value) }),
        h('button', { id: 'alfred-btn-profile-save', type: 'button', title: 'Save the current set-up as…', onclick: () => { const r = $('alfred-profile-row'); r.hidden = !r.hidden; if (!r.hidden) { const i = $('alfred-profile-name'); i.value = (last && last.settings && last.settings.activeProfile) || ''; i.focus(); } } }, '💾'),
        h('button', { id: 'alfred-btn-settings', type: 'button', title: 'Alfred\'s settings', onclick: () => showSettings($('alfred-settings').hidden) }, '⚙'),
        h('button', { id: 'alfred-btn-clear', type: 'button', title: 'Start a new conversation', onclick: () => api.alfredClear() }, '🧹'),
        h('button', { id: 'alfred-btn-hide', type: 'button', title: `Hide the panel — Alfred stays on (${SHORTCUT} brings it back)`, onclick: () => setOpen(false) }, '×')),
      h('div', { id: 'alfred-profile-row', hidden: true },
        h('input', { id: 'alfred-profile-name', type: 'text', maxlength: '40', placeholder: 'Name this set-up, e.g. "Fast local"', 'aria-label': 'Set-up name', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); saveProfile(); } } }),
        h('button', { id: 'alfred-profile-save', type: 'button', class: 'primary', onclick: saveProfile }, 'Save')),
      h('div', { id: 'alfred-statusline', role: 'status', 'aria-live': 'polite' }, '…'),
      h('div', { id: 'alfred-actions', role: 'toolbar', 'aria-label': 'What Alfred can do for you' },
        ACTIONS.map((a) => h('button', { id: `alfred-a-${a.id}`, type: 'button', title: a.tip, 'data-action': a.id, onclick: () => doAction(a.id) }, h('span', { class: 'al-ic', 'aria-hidden': 'true' }, a.ic), h('span', null, a.label)))),
      h('form', { id: 'alfred-form', hidden: true, 'aria-label': 'A detail Alfred needs', onsubmit: (e) => { e.preventDefault(); submitForm(); } }),
      h('div', { id: 'alfred-quick' }, h('div', { id: 'alfred-quick-msg', role: 'status', 'aria-live': 'polite' }), h('button', { id: 'alfred-quick-close', type: 'button', title: 'Hide this note', 'aria-label': 'Hide this note', onclick: () => quickMsg('') }, '✕')),
      catalogBox(),
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
    return h('div', { id: 'alfred-settings', hidden: true, role: 'region', 'aria-label': 'Alfred\'s settings' },
      h('div', { class: 'full al-set-head' }, h('b', null, '⚙ His settings'), h('button', { id: 'alfred-set-close', type: 'button', title: 'Back to the chat', onclick: () => showSettings(false) }, '✕')),
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
      h('label', { class: 'full' }, h('input', { id: 'alfred-set-notices', type: 'checkbox' }), ' Tell me when something happens (AI fixed, book paused/finished, image ready)'),
      h('label', { class: 'full' }, h('input', { id: 'alfred-set-interpreter', type: 'checkbox' }), ' Allow Open Interpreter (runs code on this computer — he always shows the exact code and asks first)'),
      h('div', { class: 'full warn' }, 'Open Interpreter stays off unless you tick it, and is never used when a direct tool exists.'),
      h('div', { class: 'full', style: 'display:flex;gap:6px;flex-wrap:wrap' },
        h('button', { id: 'alfred-set-save', type: 'button', class: 'primary', onclick: saveSettings }, 'Save'),
        h('button', { id: 'alfred-set-test', type: 'button', onclick: testAi }, 'Test my AI'),
        h('button', { id: 'alfred-set-reset-allow', type: 'button', title: 'Ask again before every change', onclick: resetAllow }, 'Forget "always allow"'),
        h('button', { id: 'alfred-set-butler', type: 'button', title: 'One-button setup, the full check, models and his personality — the 🎩 Butler section', onclick: showButler }, '🛠 Set up his AI')),
      h('div', { id: 'alfred-set-msg', class: 'full', style: 'font-size:11.5px;color:#aab5cf' }));
  }
  /** ⚙ his settings take the chat's place (✕ / ⚙ again goes back to the chat). */
  function showSettings(on) {
    const s = $('alfred-settings'); const root = $('alfred-drawer'); if (!s) return;
    if (on) showCatalog(false);
    s.hidden = !on;
    if (root) root.classList.toggle('al-set-open', !!on);
    const b = $('alfred-btn-settings'); if (b) b.setAttribute('aria-pressed', String(!!on));
    if (on) fillSettings();
  }
  function fillSettings() {
    const s = last && last.settings; if (!s) return;
    $('alfred-set-brain').value = s.brain; $('alfred-set-endpoint').value = s.local.endpoint || ''; $('alfred-set-model').value = s.local.model || '';
    $('alfred-set-pane').value = s.pane.site; $('alfred-set-steps').value = String(s.maxSteps);
    $('alfred-set-notices').checked = !!s.notices; $('alfred-set-interpreter').checked = !!s.interpreter;
    Promise.resolve(api.alfredModels && api.alfredModels()).then((r) => {
      const dl = $('alfred-models'); if (!dl || !r || !Array.isArray(r.models)) return;
      dl.textContent = ''; for (const m of r.models) dl.append(h('option', { value: m }));
      if (r.ok && r.models.length) $('alfred-set-msg').textContent = `Ollama has: ${r.models.slice(0, 6).join(', ')}`;
    }).catch(() => {});
  }
  async function saveSettings() {
    const patch = { brain: $('alfred-set-brain').value, local: { endpoint: $('alfred-set-endpoint').value.trim(), model: $('alfred-set-model').value.trim() }, pane: { site: $('alfred-set-pane').value }, maxSteps: Number($('alfred-set-steps').value) || 8, notices: $('alfred-set-notices').checked, interpreter: $('alfred-set-interpreter').checked };
    await api.alfredSettings(patch);
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

  // ---- what the big buttons do
  function quickMsg(t) { const q = $('alfred-quick-msg'); if (q) q.textContent = t || ''; }
  function busyNote() {
    if (last && last.card) return 'Please answer the card first (✔ Do it or ✖ No).';
    if (last && last.busy) return 'He is still working — press ■ Stop to cancel.';
    return null;
  }
  function quickAsk(text) {
    const b = busyNote(); if (b) { quickMsg(b); return; }
    quickMsg('');
    send(text);
  }
  /** Akọwe's books, or a plain sentence why there are none. Old builds without alfred:books: assume ok. */
  async function books() {
    if (typeof api.alfredBooks !== 'function') return { ok: true, akowe: true, books: [{}], unknown: true };
    let r = null; try { r = await api.alfredBooks(); } catch (_) { r = null; }
    return r || { ok: false, books: [], message: 'I could not ask Akọwe just now — try again in a moment.' };
  }
  const NO_BOOK = 'Akọwe has no book yet. Press ✍ Continue / make my book to start one from your idea — then I can add characters and a cover to it.';
  async function needBook() {
    const r = await books();
    if (!r.ok || r.akowe === false) { quickMsg(`📖 ${r.message || 'Akọwe (the book app) is not running yet — open the 📖 Akọwe tab first.'}`); return null; }
    if (!r.books.length) { quickMsg(`📖 ${NO_BOOK}`); return null; }
    return r;
  }
  function pressed(kind) { for (const b of document.querySelectorAll('#alfred-actions button')) b.setAttribute('aria-pressed', String(b.dataset.action === kind)); }
  function closeForm() { const f = $('alfred-form'); if (f) { f.hidden = true; f.textContent = ''; } formKind = null; pressed(null); }
  /** A tiny form before a request: fields [{ name, label, placeholder, long, required }]. */
  function openForm(kind, title, fields, note) {
    const f = $('alfred-form'); if (!f) return;
    showCatalog(false);
    formKind = kind; pressed(kind);
    f.textContent = '';
    f.dataset.kind = kind;
    f.append(h('h3', null, title));
    for (const x of fields) {
      const attrs = { id: `alfred-f-${x.name}`, name: x.name, placeholder: x.placeholder || '', maxlength: x.long ? '1500' : '120', required: !!x.required };
      f.append(h('label', null, x.label, x.long ? h('textarea', attrs) : h('input', Object.assign({ type: 'text' }, attrs))));
    }
    if (note) f.append(h('div', { class: 'al-note' }, note));
    f.append(h('div', { class: 'al-row' }, h('button', { id: 'alfred-f-go', type: 'submit', class: 'primary' }, 'Ask Alfred'), h('button', { id: 'alfred-f-cancel', type: 'button', onclick: closeForm }, 'Cancel')));
    f.hidden = false;
    const first = f.querySelector('input, textarea'); if (first) { try { first.focus(); } catch (_) {} }
  }
  const val = (n) => { const e = $(`alfred-f-${n}`); return e ? e.value.replace(/\s+/g, ' ').trim() : ''; };
  const REQUEST = {
    // forge_character fills a book character's dossier; a name the book doesn't have yet is added first with
    // create_dossier kind 'characters' (Akọwe POST /forge/characters — a draft the author approves).
    character: () => { const n = val('name'); if (!n) return null; const a = val('about'); return `Make a character for my book: “${n}”${a ? ` — ${a}` : ''}. Open their Character Forge dossier and invent the rest as proposals for me to approve${a ? ', with what I said about them' : ''}. If they are not in my book yet, add them as a new character first.`; },
    picture: () => { const w = val('what'); return w ? `Make a picture of ${w}.` : null; },
    video: () => { const w = val('what'); return w ? `Make a short video of ${w}.` : null; },
    cover: () => { const w = val('what'); return `Design the cover for my book and make the cover art${w ? ` showing ${w}` : ''}.`; },
    newbook: () => { const i = val('idea'); if (!i) return null; const g = val('genre'); return `Make a book for me: ${i}${g ? ` (genre: ${g})` : ''}.`; },
  };
  function submitForm() {
    const kind = formKind; if (!kind || !REQUEST[kind]) return;
    const text = REQUEST[kind]();
    if (!text) { const f = $('alfred-form').querySelector('[required]'); if (f) { try { f.focus(); } catch (_) {} } quickMsg('Please fill in the first box.'); return; }
    const b = busyNote(); if (b) { quickMsg(b); return; }
    closeForm();
    quickAsk(text);
  }
  async function doAction(kind) {
    if (formKind === kind) { closeForm(); return; } // a second press closes its form
    if (WORK.has(kind)) { const b = busyNote(); if (b) { quickMsg(b); return; } }
    quickMsg('');
    if (kind === 'catalog') { closeForm(); showCatalog(!catalogShown()); return; }
    if (kind === 'check') { closeForm(); showCatalog(false); checkEverything(); return; }
    if (kind === 'picture') return openForm('picture', '🎨 What should the picture show?', [{ name: 'what', label: 'The picture', placeholder: 'a lighthouse on a cliff at dusk', long: true, required: true }]);
    if (kind === 'video') return openForm('video', '🎬 What should the video show?', [{ name: 'what', label: 'The video', placeholder: 'waves crashing against a lighthouse', long: true, required: true }], 'Needs the 🎬 Video tab set up — he tells you plainly if it is not.');
    closeForm(); showCatalog(false);
    if (kind === 'character') { if (await needBook()) openForm('character', '🧑 A new character for your book', [{ name: 'name', label: 'Their name', placeholder: 'Mara', required: true }, { name: 'about', label: 'A line about them (optional)', placeholder: 'the lighthouse keeper who hates the sea', long: true }], 'He starts the dossier and invents the rest as proposals — you approve them.'); return; }
    if (kind === 'cover') { if (await needBook()) openForm('cover', '🖼 Design the cover', [{ name: 'what', label: 'What the cover picture should show (optional)', placeholder: 'a lighthouse in a storm', long: true }]); return; }
    if (kind === 'book') { if (await needBook()) quickAsk("What's the status of my book?"); return; }
    if (kind === 'continue') {
      const r = await books();
      if (!r.ok || r.akowe === false) { quickMsg(`📖 ${r.message || 'Akọwe (the book app) is not running yet — open the 📖 Akọwe tab first.'}`); return; }
      if (!r.books.length) { openForm('newbook', '✍ Akọwe has no book yet — what is your book about?', [{ name: 'idea', label: 'Your idea, in a few sentences', placeholder: 'A lighthouse keeper finds a door under the sea…', long: true, required: true }, { name: 'genre', label: 'Genre (optional)', placeholder: 'cosy mystery' }], 'He starts Akọwe\'s “⚡ Make a book for me” run — you say ✔ Do it first.'); return; }
      quickAsk('Continue my book: resume the “Make a book for me” run if it is paused, or tell me what it is waiting for. If no run is going, tell me the next step.');
    }
  }

  // ---- 🩺 Check everything: his AI (llm:check) + the whole app (health:status) — no AI needed
  async function checkEverything() {
    const box = $('alfred-quick-msg'); if (!box) return;
    box.textContent = '🩺 Checking everything…';
    const icon = (ok) => (ok === true ? '✔' : ok === false ? '✖' : '⚠');
    const lines = []; const fixes = [];
    let r = null;
    if (typeof api.llmCheck === 'function') { try { r = await api.llmCheck(); } catch (_) { r = null; } }
    if (r && Array.isArray(r.rows)) {
      lines.push(`🧠 His AI: ${r.summary || (r.ok ? 'ready.' : 'something needs fixing.')}`);
      for (const x of r.rows.slice(0, 10)) lines.push(`  ${icon(x.ok)} ${x.label}${x.detail ? ` — ${x.detail}` : ''}`);
    } else {
      let t = null; try { t = await api.alfredTestAi(); } catch (_) { t = null; }
      lines.push(`🧠 His AI: ${t && t.ok ? '✔' : '✖'} ${(t && t.message) || (t && t.ok ? 'it answers.' : 'it is not reachable.')}`);
    }
    let hs = null;
    if (typeof api.healthStatus === 'function') { try { hs = await api.healthStatus({ fresh: true }); } catch (_) { hs = null; } }
    if (hs && Array.isArray(hs.problems)) {
      if (!hs.problems.length) lines.push('🩺 The app: ✔ nothing wrong found (disk space, Stable Diffusion, Akọwe, the AI panes, the logs folder).');
      else {
        lines.push(`🩺 The app: ${hs.problems.length} thing${hs.problems.length === 1 ? '' : 's'} to look at:`);
        for (const p of hs.problems.slice(0, 8)) { lines.push(`  ${p.severity === 'error' ? '✖' : '⚠'} ${p.text}`); if (p.fix && p.code) fixes.push(p); }
      }
    } else if (hs && hs.ok === false) lines.push(`🩺 The app: ${hs.error || 'the health check did not answer.'}`);
    const c = last && last.connected;
    if (c) lines.push(`🧰 Connected: 📖 Akọwe ${c.akowe ? '✔' : '✖'} · 🎨 pictures ${c.images ? '✔' : '✖'} · 🎬 video ${c.video ? '✔' : 'not yet'} · 💬 AIs ${c.panes || 0}/3`);
    box.textContent = lines.join('\n');
    for (const p of fixes) {
      const b = h('button', { class: 'al-fix', type: 'button', 'data-code': p.code }, p.fix.label || 'Fix it');
      b.addEventListener('click', async () => {
        if (typeof api.healthFix !== 'function') return;
        b.disabled = true; let x = null; try { x = await api.healthFix(p.code); } catch (_) { x = null; }
        b.textContent = x && x.ok ? '✔ Done' : `✖ ${(x && (x.message || x.error)) || 'did not work'}`.slice(0, 120);
      });
      box.append('\n', b);
    }
    if (r && r.ok === false) box.append('\n', h('button', { class: 'al-fix', type: 'button', id: 'alfred-check-setup', onclick: showButler }, '🛠 Set up his AI'));
  }

  // ---- ❓ Everything I can do (alfred:catalog), searchable, ▶ Try it fills his input box
  function catalogBox() {
    return h('div', { id: 'alfred-catalog', hidden: true, role: 'region', 'aria-label': 'Everything Alfred can do' },
      h('div', { class: 'al-cat-head' },
        h('input', { id: 'alfred-catalog-search', type: 'search', placeholder: 'Search, e.g. cover, character, video…', 'aria-label': 'Search what Alfred can do', oninput: paintCatalog }),
        h('button', { id: 'alfred-catalog-close', type: 'button', title: 'Back to the chat', onclick: () => showCatalog(false) }, '✕')),
      h('div', { id: 'alfred-catalog-list' }));
  }
  const catalogShown = () => { const c = $('alfred-catalog'); return !!(c && !c.hidden); };
  async function loadCatalog() {
    if (catalog) return catalog;
    let r = null;
    if (typeof api.alfredCatalog === 'function') { try { r = await api.alfredCatalog(); } catch (_) { r = null; } }
    if (!r || !Array.isArray(r.groups)) { // older main: his own tool list, grouped as the registry groups them
      const tools = (last && last.tools) || [];
      const names = { books: '📖 Books', images: '🎨 Pictures', video: '🎬 Video', ais: '💬 The three AIs', files: '📁 Files', app: '⚙ The app', code: '🧪 Code' };
      const gs = {};
      for (const t of tools) (gs[t.group] = gs[t.group] || []).push({ id: t.name, title: t.title, say: t.title, example: `${t.title}.`, changes: t.changes });
      r = { ok: true, groups: Object.keys(gs).map((g) => ({ id: g, icon: '', title: names[g] || g, items: gs[g] })) };
    }
    catalog = r;
    return r;
  }
  async function showCatalog(on) {
    const c = $('alfred-catalog'); const root = $('alfred-drawer'); if (!c) return;
    if (on && $('alfred-settings') && !$('alfred-settings').hidden) showSettings(false);
    c.hidden = !on;
    if (root) root.classList.toggle('al-cat-open', !!on);
    const b = $('alfred-a-catalog'); if (b) b.setAttribute('aria-pressed', String(!!on));
    if (!on) return;
    $('alfred-catalog-list').textContent = 'Loading…';
    await loadCatalog();
    paintCatalog();
    try { $('alfred-catalog-search').focus(); } catch (_) {}
  }
  function paintCatalog() {
    const list = $('alfred-catalog-list'); if (!list || !catalog) return;
    const q = String(($('alfred-catalog-search') || {}).value || '').toLowerCase().trim();
    const words = q.split(/\s+/).filter(Boolean);
    list.textContent = '';
    let shown = 0;
    for (const g of catalog.groups) {
      const head = `${g.icon ? `${g.icon} ` : ''}${g.title}`;
      const items = g.items.filter((i) => { const hay = `${i.title} ${i.say} ${i.example}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
      if (!items.length) continue;
      list.append(h('h4', { 'data-group': g.id }, `${head} (${items.length})`));
      for (const i of items) {
        shown++;
        list.append(h('div', { class: 'al-cat-item', 'data-id': i.id },
          h('div', { class: 'al-cat-text' }, h('b', null, i.title), i.changes ? h('span', { class: 'al-asks', title: 'He shows an "I will" card and asks before he does it' }, 'asks first') : null, h('div', { class: 'al-cat-say' }, i.say)),
          h('button', { type: 'button', class: 'al-try', title: `Put an example in the box: ${i.example}`, onclick: () => tryIt(i.example) }, '▶ Try it')));
      }
    }
    if (!shown) list.append(h('div', { id: 'alfred-catalog-empty' }, 'Nothing matches — try other words, or just ask me in your own words.'));
  }
  function tryIt(example) {
    showCatalog(false);
    const i = $('alfred-input'); if (!i) return;
    i.value = example;
    try { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } catch (_) {}
    quickMsg('▶ Change the words if you like, then press Send.');
  }
  const WHAT_CAN_YOU_DO = /^\s*(what\s+(else\s+)?can\s+(you|alfred|he)\s+do|what\s+do\s+you\s+do|what\s+can\s+i\s+ask(\s+you)?|help|❓)\s*[?.!]*\s*$/i;

  function paintProfiles(s) {
    const sel = $('alfred-profile'); if (!sel) return;
    const list = (s && Array.isArray(s.profiles)) ? s.profiles : [];
    const active = (s && s.activeProfile) || '';
    sel.textContent = '';
    sel.append(h('option', { value: '' }, list.length ? (active ? '— set-ups —' : '(no set-up)') : '(no saved set-ups)'));
    for (const p of list) sel.append(h('option', { value: p.name }, p.name));
    sel.value = active;
    sel.disabled = !list.length;
    sel.hidden = !list.length; // nothing saved yet: no empty drop-down (💾 saves the first one)
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
  function setOpen(v) {
    open = !!v;
    const d = $('alfred-drawer'); if (d) d.hidden = !open;
    document.body.classList.toggle('alfred-open', open && !!(last && last.enabled) && built);
    paintToggle();
    try { localStorage.setItem('alfredOpen', open ? '1' : '0'); } catch (_) {}
    sync();
  }
  function teardown() {
    const d = $('alfred-drawer'); if (d) d.remove();
    document.body.classList.remove('alfred-open');
    built = false; formKind = null;
    const t = $('btn-alfred-drawer'); if (t) t.remove();
    sync();
  }
  /** "🛠 Set up his AI": bring the 🎩 Butler section (his SETUP panel) into view, on the main tab. */
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
  // What Alfred did also goes into the 🎩 Butler section's activity log, once each.
  let mirroredTs = null;
  function mirrorActivity(st) {
    if (typeof window.appendButlerLine !== 'function') return;
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
    sw.setAttribute('aria-checked', String(!!st.enabled));
    sw.textContent = st.enabled ? '🎩 Alfred: On' : '🎩 Alfred: Off';
    if (!st.enabled) { teardown(); return; }
    ensureToggle();
    if (!built) { build(); let o = '1'; try { o = localStorage.getItem('alfredOpen') || '1'; } catch (_) {} setOpen(o !== '0'); }
    else document.body.classList.toggle('alfred-open', open);
    paintToggle();
    // title + set-ups
    const ps = persona(st);
    $('alfred-title').textContent = `🎩 ${ps.name || 'Alfred'}`;
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
    // busy: the buttons that send wait; 🩺 and ❓ always work
    $('alfred-busy').hidden = !st.busy;
    busyTicker(st);
    $('alfred-send').disabled = !!st.busy || !!st.card;
    for (const id of WORK) { const b = $(`alfred-a-${id}`); if (b) b.disabled = !!st.busy || !!st.card; }
    const go = $('alfred-f-go'); if (go) go.disabled = !!st.busy || !!st.card;
    // what Alfred did
    const list = $('alfred-did-list'); list.textContent = '';
    const acts = (st.activity || []).slice().reverse();
    $('alfred-did-count').textContent = `(${acts.length})`;
    for (const a of acts) list.append(h('li', { class: a.ok ? '' : 'fail', title: a.message || '' }, `${new Date(a.ts).toLocaleTimeString()} ${a.ok ? '✔' : '✖'} ${a.text}${a.auto ? ' (always allowed)' : ''}${a.ok ? '' : ` — ${a.message}`}`));
  }
  // "🎩 Thinking… 12 s" — a local model can take a minute; the seconds show he is not stuck.
  let busyTimer = null; let busyFrom = 0; let busyWhat = null;
  function busyLine() {
    const t = $('alfred-busy-text'); if (!t) return;
    const sec = Math.max(0, Math.round((Date.now() - busyFrom) / 1000));
    const p = busyWhat || {};
    const what = p.doing === 'tool' && p.tool ? `Using “${p.tool}”…` : 'Thinking…';
    const slow = sec >= 20 && p.doing !== 'tool' ? (p.brain === 'local' ? ' (a local model can take a minute)' : ' (still waiting for my AI)') : '';
    t.textContent = `🎩 ${what} ${sec} s${slow}`;
  }
  function busyTicker(st) {
    const on = !!(st && st.busy);
    if (!on) { if (busyTimer) clearInterval(busyTimer); busyTimer = null; const t = $('alfred-busy-text'); if (t) t.textContent = '🎩 Working on it…'; return; }
    busyWhat = st.progress || null;
    const from = Date.now() - ((busyWhat && busyWhat.elapsedMs) || 0);
    if (!busyTimer || Math.abs(from - busyFrom) > 1500) busyFrom = from;
    busyLine();
    if (!busyTimer) busyTimer = setInterval(busyLine, 1000);
  }
  function fileUrl(p) { return 'file:///' + String(p).replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/'); }
  // His words as simple formatting (bold, lists, code) — built from alfred-format.js blocks with text nodes
  // only, never innerHTML, so nothing a model writes can inject HTML. Your own words stay plain text.
  const FMT = window.AlfredFormat || null;
  function spansEl(spans) {
    const out = [];
    for (const sp of spans || []) {
      if (sp.t === 'b') out.push(h('strong', null, sp.v));
      else if (sp.t === 'i') out.push(h('em', null, sp.v));
      else if (sp.t === 'code') out.push(h('code', null, sp.v));
      else out.push(document.createTextNode(sp.v));
    }
    return out;
  }
  function richEl(text) {
    const box = h('div', { class: 'al-rich' });
    if (!FMT || typeof FMT.toBlocks !== 'function') { box.append(String(text || '')); return box; }
    for (const b of FMT.toBlocks(text)) {
      if (b.type === 'code') box.append(h('pre', null, b.text));
      else if (b.type === 'ul' || b.type === 'ol') box.append(h(b.type, b.type === 'ol' && b.start > 1 ? { start: b.start } : null, b.items.map((it) => h('li', null, spansEl(it)))));
      else if (b.type === 'h') box.append(h('div', { class: 'al-h' }, h('strong', null, spansEl(b.spans))));
      else box.append(h('p', null, spansEl(b.spans)));
    }
    return box;
  }
  function msgEl(m) {
    const rich = m.role === 'alfred' || m.role === 'notice';
    const e = h('div', { class: `al-msg al-${m.role}${m.outdated ? ' al-outdated' : ''}`, 'data-role': m.role }, rich ? richEl(m.text) : m.text);
    // a note about something that has changed since (a book run resumed / finished, a problem fixed)
    if (m.outdated) e.prepend(h('div', { class: 'al-old' }, `Old news${m.nowText ? ` — now: ${m.nowText}` : ''}`));
    if (m.image) e.append(h('img', { src: fileUrl(m.image), alt: 'the image Alfred made' }));
    // 🩺 a health notice with a one-click fix (health-watch.js → health:fix)
    if (m.action && m.action.code && typeof api.healthFix === 'function') {
      const b = h('button', { class: 'al-fix', type: 'button', 'data-code': m.action.code }, m.action.label || 'Fix it');
      b.addEventListener('click', async () => {
        b.disabled = true; const was = b.textContent; b.textContent = '…';
        let r = null;
        try { r = await api.healthFix(m.action.code); } catch (_) { r = null; }
        b.textContent = r && r.ok ? (r.fixed ? '✔ Fixed' : '✔ Done') : was;
        b.disabled = !!(r && r.ok);
        const note = r && !r.ok && (r.message || r.error);
        if (note) e.append(h('div', { class: 'al-fix-note' }, String(note).slice(0, 200)));
      });
      e.append(h('div', null, b));
    }
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
    const body = h('div', { class: 'al-card-body' }, h('h3', null, '🎩 I will:'));
    if (card.intro) body.append(h('p', { style: 'margin:0 0 6px;font-size:12px;color:#cbb98a' }, card.intro));
    const ol = h('ol');
    for (const s of card.steps) {
      const li = h('li', { 'data-tool': s.tool }, s.code ? `${s.title} — here is the exact ${s.code.language} code:` : s.text);
      if (s.code) li.append(h('pre', null, s.code.code));
      if (s.allowAlways) li.append(h('label', null, h('input', { type: 'checkbox', class: 'al-always', 'data-tool': s.allowKey || s.tool, checked: ticked.includes(s.allowKey || s.tool) }), s.allowKey && s.allowKey.includes(':') ? ' Always allow this without asking' : ` Always allow "${s.title}" without asking`));
      ol.append(li);
    }
    body.append(ol);
    box.append(body, h('div', { class: 'al-actions' },
      h('button', { id: 'alfred-do-it', type: 'button', class: 'primary', onclick: () => decide(true) }, '✔ Do it'),
      h('button', { id: 'alfred-no', type: 'button', onclick: () => decide(false) }, '✖ No')));
    if (catalogShown()) showCatalog(false); // the card must be seen
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
    // "what can you do?" → the list right here (no AI call needed)
    if (WHAT_CAN_YOU_DO.test(text)) { if (typeof preset !== 'string') input.value = ''; closeForm(); showCatalog(true); return; }
    sending = true;
    if (typeof preset !== 'string') input.value = '';
    if (catalogShown()) showCatalog(false);
    $('alfred-busy').hidden = false;
    try {
      const r = await api.alfredAsk(text);
      if (r && r.ok === false && r.message) { const chat = $('alfred-chat'); chat.append(msgEl({ role: 'alfred', text: r.message })); chat.scrollTop = chat.scrollHeight; if ((r.error === 'EMPTY' || r.error === 'BUSY') && typeof preset !== 'string') input.value = text; }
    } finally { sending = false; if (!(last && last.busy)) { const b = $('alfred-busy'); if (b) b.hidden = true; } }
  }

  sw.dataset.alfredWired = 'yes'; // the User Panel's 🎩 Alfred: On/Off button clicks this switch
  sw.addEventListener('click', async () => {
    const on = !(last && last.enabled);
    sw.disabled = true;
    try { render(await api.alfredSetEnabled(on)); } finally { sw.disabled = false; }
  });
  // Ctrl/Cmd+Shift+A: main catches it on every page of the app (before-input-event) and the page never
  // sees it. This is the fallback for a key that reached the page anyway (e.g. synthetic input).
  document.addEventListener('keydown', (e) => {
    if (e.repeat || !e.shiftKey || e.altKey || String(e.key || '').toLowerCase() !== 'a') return;
    if (!(isMac ? e.metaKey : (e.ctrlKey && !e.metaKey))) return;
    if (!(last && last.enabled) || !built) return;
    e.preventDefault();
    setOpen(!open);
  }, true);
  if (typeof api.onAlfred === 'function') {
    api.onAlfred((p) => {
      if (!p) return;
      if (p.type === 'show-tab') { if (p.tab) { const b = document.getElementById(`tab-app-${p.tab}`); if (b) b.click(); } return; }
      if (p.type === 'show-butler') { showButler(); return; }
      if (p.type === 'toggle-panel') { if (built) setOpen(typeof p.open === 'boolean' ? p.open : !open); return; }
      if (p.type === 'state' && p.state) render(p.state);
      else if (last && last.enabled && built) {
        // message / card / activity events: refresh from a fresh status (cheap, no AI call)
        Promise.resolve(api.alfredStatus()).then(render).catch(() => {});
      }
    });
  }
  Promise.resolve(api.alfredStatus()).then(render).catch(() => {});
})();
