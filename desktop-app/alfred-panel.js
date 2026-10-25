// alfred-panel.js — 🎩 Alfred's drawer in the control panel (works over every tab, incl. 📖 Akọwe).
// Off by default: only the "🎩 Alfred: Off" switch in the title bar exists until he is turned on;
// then the drawer is built (chat, "I will" cards, what Alfred did, status line, settings).
// The drawer reserves its width on the right so the native AI panes and the Akọwe page are laid
// out beside it, never over it. Talks to main only through window.api.alfred* (preload.js).
(function () {
  'use strict';
  const api = window.api || {};
  const sw = document.getElementById('btn-alfred-switch');
  if (!sw || typeof api.alfredStatus !== 'function') return;

  const W = 390;
  let built = false;
  let open = true;
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
  const sync = () => { try { requestAnimationFrame(() => { const p = api.syncPanes && api.syncPanes(); if (p && p.catch) p.catch(() => {}); }); } catch (_) {} };

  function css() {
    if ($('alfred-style')) return;
    const s = document.createElement('style');
    s.id = 'alfred-style';
    s.textContent = `
      body.alfred-open #wrap, body.alfred-open #akowe-tab, body.alfred-open #images-tab { margin-right:${W}px; }
      #alfred-drawer { position:fixed; top:38px; right:0; bottom:0; width:${W}px; z-index:50; display:flex; flex-direction:column; background:#0d0f14; border-left:1px solid #2b3550; color:#e8ecf5; font-size:13px; }
      #alfred-drawer[hidden] { display:none; }
      #alfred-drawer header { display:flex; align-items:center; gap:6px; padding:8px 10px; border-bottom:1px solid #222a3d; background:#121726; }
      #alfred-drawer header h2 { margin:0; font-size:14px; flex:1 1 auto; }
      #alfred-drawer button { font-size:12px; padding:3px 9px; border-radius:6px; border:1px solid #334064; background:#161d30; color:#e8ecf5; cursor:pointer; }
      #alfred-drawer button.primary { background:#2c4a8a; border-color:#4a6fc0; }
      #alfred-drawer button:disabled { opacity:.5; cursor:default; }
      #alfred-statusline { padding:5px 10px; font-size:11.5px; color:#aab5cf; border-bottom:1px solid #1b2236; line-height:1.4; }
      #alfred-statusline .bad { color:#f0a35e; } #alfred-statusline .good { color:#7fd99a; }
      #alfred-settings { padding:8px 10px; border-bottom:1px solid #1b2236; background:#10141f; font-size:12px; display:grid; grid-template-columns:auto 1fr; gap:6px 8px; align-items:center; }
      #alfred-settings[hidden] { display:none; }
      #alfred-settings input[type=text], #alfred-settings input[type=number], #alfred-settings select { width:100%; background:#0b0e16; color:#e8ecf5; border:1px solid #2b3550; border-radius:5px; padding:3px 5px; font-size:12px; }
      #alfred-settings .full { grid-column:1 / -1; }
      #alfred-settings .warn { color:#f0a35e; font-size:11px; }
      #alfred-chat { flex:1 1 auto; overflow-y:auto; padding:8px 10px; display:flex; flex-direction:column; gap:6px; }
      #alfred-chat:empty::before { content:"🎩 Good day. Ask me anything about your books, images or AIs — e.g. “what's the status of my book?” or “make an image of a lighthouse”. I ask before I change anything."; color:#8792ad; font-size:12px; white-space:pre-wrap; }
      .al-msg { padding:6px 9px; border-radius:9px; max-width:94%; white-space:pre-wrap; word-wrap:break-word; line-height:1.45; }
      .al-you { align-self:flex-end; background:#1e2a47; }
      .al-alfred { align-self:flex-start; background:#171b26; border:1px solid #262e44; }
      .al-notice { align-self:stretch; background:#1c1a10; border:1px solid #4a4220; color:#f1e3b0; font-size:12px; }
      .al-msg img { display:block; max-width:100%; max-height:180px; margin-top:6px; border-radius:6px; }
      #alfred-card { margin:0 10px 8px; padding:9px 10px; border:1px solid #c79a3a; background:#1d1709; border-radius:10px; }
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
    `;
    document.head.appendChild(s);
  }

  function build() {
    if (built) return;
    built = true;
    css();
    const toggle = h('button', { id: 'btn-alfred-drawer', type: 'button', title: 'Show or hide Alfred\'s panel', style: 'font-size:12px;padding:3px 8px;margin-right:8px;border-radius:7px;border:1px solid #334064;background:#161d30;color:#e8ecf5;cursor:pointer;', onclick: () => setOpen(!open) }, '◂ Panel');
    sw.after(toggle);
    const drawer = h('aside', { id: 'alfred-drawer', role: 'complementary', 'aria-label': 'Alfred' },
      h('header', null,
        h('h2', null, '🎩 Alfred'),
        h('button', { id: 'alfred-btn-settings', type: 'button', title: 'Alfred\'s settings', onclick: () => { const s = $('alfred-settings'); s.hidden = !s.hidden; if (!s.hidden) fillSettings(); } }, '⚙'),
        h('button', { id: 'alfred-btn-clear', type: 'button', title: 'Start a new conversation', onclick: () => api.alfredClear() }, '🧹'),
        h('button', { id: 'alfred-btn-hide', type: 'button', title: 'Hide the panel (Alfred stays on)', onclick: () => setOpen(false) }, '×')),
      h('div', { id: 'alfred-statusline', role: 'status', 'aria-live': 'polite' }, '…'),
      settingsBox(),
      h('div', { id: 'alfred-chat', 'aria-live': 'polite' }),
      h('div', { id: 'alfred-card', hidden: true, role: 'dialog', 'aria-label': 'Alfred asks before he does this' }),
      h('div', { id: 'alfred-busy', hidden: true }, h('span', { id: 'alfred-busy-text' }, '🎩 Working on it…'), h('button', { id: 'alfred-stop', type: 'button', onclick: () => api.alfredCancel() }, '■ Stop')),
      h('div', { id: 'alfred-compose' },
        h('textarea', { id: 'alfred-input', placeholder: 'Ask Alfred…  (Enter to send, Shift+Enter for a new line)', 'aria-label': 'Message to Alfred' }),
        h('button', { id: 'alfred-send', type: 'button', class: 'primary', onclick: send }, 'Send')),
      h('details', { id: 'alfred-did' }, h('summary', null, 'What Alfred did ', h('span', { id: 'alfred-did-count' }, '(0)')), h('ul', { id: 'alfred-did-list' })));
    document.body.appendChild(drawer);
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
    Promise.resolve(api.alfredModels && api.alfredModels()).then((r) => {
      const dl = $('alfred-models'); if (!dl || !r || !Array.isArray(r.models)) return;
      dl.textContent = ''; for (const m of r.models) dl.append(h('option', { value: m }));
      if (r.ok && r.models.length) $('alfred-set-msg').textContent = `Ollama has: ${r.models.slice(0, 6).join(', ')}`;
    }).catch(() => {});
  }
  async function saveSettings() {
    const patch = { brain: $('alfred-set-brain').value, local: { endpoint: $('alfred-set-endpoint').value.trim(), model: $('alfred-set-model').value.trim() }, pane: { site: $('alfred-set-pane').value }, maxSteps: Number($('alfred-set-steps').value) || 8, notices: $('alfred-set-notices').checked, interpreter: $('alfred-set-interpreter').checked };
    await api.alfredSettings(patch);
    $('alfred-set-msg').textContent = 'Saved.';
  }
  async function testAi() { $('alfred-set-msg').textContent = 'Checking…'; const r = await api.alfredTestAi(); $('alfred-set-msg').textContent = (r && r.message) || (r && r.ok ? 'OK' : 'Not reachable'); }
  async function resetAllow() {
    const s = last && last.settings; if (!s) return;
    const off = {}; for (const k of Object.keys(s.alwaysAllow || {})) off[k] = false;
    // setSettings merges, so clear by sending false for each
    await api.alfredSettings({ alwaysAllow: off });
    $('alfred-set-msg').textContent = 'He will ask again before every change.';
  }

  function setOpen(v) {
    open = !!v;
    const d = $('alfred-drawer'); if (d) d.hidden = !open;
    document.body.classList.toggle('alfred-open', open && !!(last && last.enabled));
    const t = $('btn-alfred-drawer'); if (t) t.textContent = open ? '▸ Panel' : '◂ Panel';
    try { localStorage.setItem('alfredOpen', open ? '1' : '0'); } catch (_) {}
    sync();
  }
  function teardown() {
    const d = $('alfred-drawer'); if (d) d.remove();
    const t = $('btn-alfred-drawer'); if (t) t.remove();
    document.body.classList.remove('alfred-open');
    built = false;
    sync();
  }

  function aiWord(s) {
    if (s.brain === 'pane') return `${{ chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' }[s.pane.site]} (web pane)`;
    if (s.brain === 'api') return 'the connected AI';
    if (s.brain === 'local') return `Ollama · ${s.local.model}`;
    return `automatic (Ollama · ${s.local.model}, else the connected AI)`;
  }
  function render(st) {
    if (!st) return;
    last = st;
    sw.setAttribute('aria-checked', String(!!st.enabled));
    sw.textContent = st.enabled ? '🎩 Alfred: On' : '🎩 Alfred: Off';
    if (!st.enabled) { if (built) teardown(); return; }
    if (!built) { build(); let o = '1'; try { o = localStorage.getItem('alfredOpen') || '1'; } catch (_) {} setOpen(o !== '0'); }
    else document.body.classList.toggle('alfred-open', open);
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
    box.textContent = '';
    if (!card) { box.hidden = true; return; }
    box.hidden = false;
    box.dataset.id = card.id;
    box.append(h('h3', null, '🎩 I will:'));
    if (card.intro) box.append(h('p', { style: 'margin:0 0 6px;font-size:12px;color:#cbb98a' }, card.intro));
    const ol = h('ol');
    for (const s of card.steps) {
      const li = h('li', { 'data-tool': s.tool }, s.code ? `${s.title} — here is the exact ${s.code.language} code:` : s.text);
      if (s.code) li.append(h('pre', null, s.code.code));
      if (s.allowAlways) li.append(h('label', null, h('input', { type: 'checkbox', class: 'al-always', 'data-tool': s.allowKey || s.tool }), s.allowKey && s.allowKey.includes(':') ? ' Always allow this without asking' : ` Always allow "${s.title}" without asking`));
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
  async function send() {
    const input = $('alfred-input');
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true;
    input.value = '';
    $('alfred-busy').hidden = false;
    try {
      const r = await api.alfredAsk(text);
      if (r && r.ok === false && r.message) { const chat = $('alfred-chat'); chat.append(msgEl({ role: 'alfred', text: r.message })); chat.scrollTop = chat.scrollHeight; if (r.error === 'EMPTY' || r.error === 'BUSY') input.value = text; }
    } finally { sending = false; }
  }

  sw.addEventListener('click', async () => {
    const on = !(last && last.enabled);
    sw.disabled = true;
    try { render(await api.alfredSetEnabled(on)); } finally { sw.disabled = false; }
  });
  if (typeof api.onAlfred === 'function') {
    api.onAlfred((p) => {
      if (!p) return;
      if (p.type === 'show-tab' && p.tab) { const b = document.getElementById(`tab-app-${p.tab}`); if (b) b.click(); return; }
      if (p.type === 'state' && p.state) render(p.state);
      else if (last && last.enabled && built) {
        // message / card / activity events: refresh from a fresh status (cheap, no AI call)
        Promise.resolve(api.alfredStatus()).then(render).catch(() => {});
      }
    });
  }
  Promise.resolve(api.alfredStatus()).then(render).catch(() => {});
})();
