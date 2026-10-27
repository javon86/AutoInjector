// alfred-persona-ui.js — 🎩 Alfred's personality + saved set-ups, in the 🤵 Butler section
// (<div id="alfred-persona"> in controls.html). The personality changes his VOICE only (how he words
// things): he still shows every change on an "I will" card and waits for ✔ Do it — that is enforced
// in alfred.js, not by the prompt. Saved set-ups keep his AI, model, web AI, max steps and personality
// under a name; switch, rename and delete them here, or switch from his side panel.
// Talks to main only through window.api.alfredPersonality / alfredProfiles / alfredSaveProfile /
// alfredUseProfile / alfredDeleteProfile (preload.js); degrades to a short note when those are missing.
(function () {
  'use strict';
  const host = document.getElementById('alfred-persona');
  if (!host) return;
  const api = window.api || {};
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
  const CHATTY = { 1: '1 · a few words', 2: '2 · short', 3: '3 · short and clear', 4: '4 · explains a little more', 5: '5 · chatty' };
  const FALLBACK_PRESETS = [
    { id: 'butler', label: '🎩 Butler (polished, courteous)' }, { id: 'friendly', label: '😊 Friendly (warm, casual)' },
    { id: 'brief', label: '⚡ Brief (just the facts)' }, { id: 'witty', label: '😏 Witty (dry humour)' },
    { id: 'coach', label: '🏅 Coach (encouraging, explains why)' }, { id: 'custom', label: '✏️ Custom (your own words)' },
  ];

  if (typeof api.alfredPersonality !== 'function' || typeof api.alfredProfiles !== 'function') {
    host.textContent = '';
    host.append(h('div', { class: 'ap-note', style: 'font-size:11.5px;opacity:.7' }, '🎩 Alfred\'s personality and saved set-ups need a newer build of the app.'));
    return;
  }

  let dirty = false;        // the user is editing the personality: don't overwrite the fields
  let limits = { name: 40, tone: 200, custom: 1500 };
  let confirmDelete = null; // the set-up whose "Delete" was pressed once

  function css() {
    if ($('alfred-persona-style')) return;
    const s = document.createElement('style');
    s.id = 'alfred-persona-style';
    s.textContent = `
      #alfred-persona { flex:1 1 100%; background:#0b0e16; border:1px solid #26304a; border-radius:9px; padding:8px 11px; font-size:12px; color:#e8ecf5; box-sizing:border-box; }
      #alfred-persona h3 { margin:0 0 6px; font-size:13px; }
      #alfred-persona .ap-cols { display:flex; flex-wrap:wrap; gap:12px; }
      #alfred-persona .ap-col { flex:1 1 280px; min-width:240px; }
      #alfred-persona .ap-grid { display:grid; grid-template-columns:auto 1fr; gap:5px 8px; align-items:center; }
      #alfred-persona .ap-grid .full { grid-column:1 / -1; }
      #alfred-persona input[type=text], #alfred-persona select, #alfred-persona textarea { width:100%; box-sizing:border-box; background:#070910; color:#e8ecf5; border:1px solid #2b3550; border-radius:5px; padding:3px 5px; font:inherit; font-size:12px; }
      #alfred-persona textarea { resize:vertical; min-height:52px; }
      #alfred-persona button { font-size:11.5px; padding:2px 8px; border-radius:6px; border:1px solid #334064; background:#161d30; color:#e8ecf5; cursor:pointer; }
      #alfred-persona button.primary { background:#2c4a8a; border-color:#4a6fc0; }
      #alfred-persona .ap-msg { font-size:11.5px; color:#aab5cf; min-height:1em; white-space:pre-wrap; }
      #alfred-persona .ap-hint { font-size:11px; color:#8792ad; }
      #alfred-persona ul { list-style:none; margin:4px 0; padding:0; }
      #alfred-persona li { display:flex; align-items:center; gap:6px; padding:3px 0; border-bottom:1px solid #161c2c; }
      #alfred-persona li .ap-pname { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #alfred-persona li.active .ap-pname { color:#7fd99a; font-weight:600; }
      #alfred-persona .ap-row { display:flex; gap:6px; margin-top:6px; }
    `;
    document.head.appendChild(s);
  }

  function build() {
    css();
    host.textContent = '';
    const opt = (v, t) => h('option', { value: v }, t);
    host.append(
      h('h3', null, '🎩 Alfred\'s personality & saved set-ups'),
      h('div', { class: 'ap-cols' },
        h('div', { class: 'ap-col' },
          h('div', { class: 'ap-grid' },
            h('label', { for: 'ap-preset' }, 'Personality'),
            h('select', { id: 'ap-preset', onchange: () => { dirty = true; paintCustom(); } }, FALLBACK_PRESETS.map((p) => opt(p.id, p.label))),
            h('label', { for: 'ap-name' }, 'His name'),
            h('input', { id: 'ap-name', type: 'text', maxlength: String(limits.name), placeholder: 'Alfred', oninput: () => { dirty = true; } }),
            h('label', { for: 'ap-tone' }, 'Tone'),
            h('input', { id: 'ap-tone', type: 'text', maxlength: String(limits.tone), placeholder: 'e.g. calm, upbeat, a bit formal', oninput: () => { dirty = true; } }),
            h('label', { for: 'ap-chat' }, 'Chattiness'),
            h('div', null, h('input', { id: 'ap-chat', type: 'range', min: '1', max: '5', step: '1', value: '3', oninput: () => { dirty = true; $('ap-chat-label').textContent = CHATTY[$('ap-chat').value] || ''; } }), ' ', h('span', { id: 'ap-chat-label', class: 'ap-hint' }, CHATTY[3])),
            h('label', { for: 'ap-custom', class: 'full' }, 'Your own words (for "Custom") ', h('span', { id: 'ap-custom-count', class: 'ap-hint' }, '')),
            h('textarea', { id: 'ap-custom', class: 'full', maxlength: String(limits.custom), placeholder: 'e.g. Talk like a cheerful ship\'s captain. Call me "Captain".', oninput: () => { dirty = true; paintCount(); } })),
          h('div', { class: 'ap-hint', style: 'margin-top:4px' }, 'This changes how he talks — never what he is allowed to do: he still shows every change on an "I will" card and waits for ✔ Do it.'),
          h('div', { class: 'ap-row' },
            h('button', { id: 'ap-save', type: 'button', class: 'primary', onclick: savePersonality }, 'Save personality'),
            h('button', { id: 'ap-reset', type: 'button', title: 'Back to the polished butler', onclick: () => fillPersonality({ preset: 'butler', name: 'Alfred', tone: '', chattiness: 3, custom: '' }, true) }, 'Reset')),
          h('div', { id: 'ap-msg', class: 'ap-msg', role: 'status', 'aria-live': 'polite' })),
        h('div', { class: 'ap-col' },
          h('div', { style: 'font-weight:600;margin-bottom:2px' }, '💾 Saved set-ups'),
          h('div', { class: 'ap-hint' }, 'A set-up keeps his AI, model, web AI, max steps and personality under one name.'),
          h('ul', { id: 'ap-profiles', 'aria-label': 'Saved set-ups' }),
          h('div', { class: 'ap-row' },
            h('input', { id: 'ap-new-name', type: 'text', maxlength: '40', placeholder: 'Save the current set-up as…', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); saveNew(); } } }),
            h('button', { id: 'ap-new-save', type: 'button', class: 'primary', onclick: saveNew }, 'Save')),
          h('div', { id: 'ap-pmsg', class: 'ap-msg', role: 'status', 'aria-live': 'polite' }))));
    paintCustom(); paintCount();
  }
  function paintCount() { const t = $('ap-custom'); const c = $('ap-custom-count'); if (t && c) c.textContent = `${t.value.length}/${limits.custom}`; }
  function paintCustom() { const t = $('ap-custom'); if (t) t.disabled = $('ap-preset').value !== 'custom'; }
  function fillPersonality(p, markDirty) {
    if (!p) return;
    $('ap-preset').value = p.preset || 'butler';
    $('ap-name').value = p.name || 'Alfred';
    $('ap-tone').value = p.tone || '';
    $('ap-chat').value = String(p.chattiness || 3);
    $('ap-chat-label').textContent = CHATTY[p.chattiness || 3] || '';
    $('ap-custom').value = p.custom || '';
    paintCustom(); paintCount();
    dirty = !!markDirty;
  }
  function paintPresets(list) {
    if (!Array.isArray(list) || !list.length) return;
    const sel = $('ap-preset'); const cur = sel.value;
    sel.textContent = '';
    for (const p of list) sel.append(h('option', { value: p.id }, p.label || p.id));
    sel.value = cur || 'butler';
  }
  async function savePersonality() {
    const patch = { preset: $('ap-preset').value, name: $('ap-name').value, tone: $('ap-tone').value, chattiness: Number($('ap-chat').value), custom: $('ap-custom').value };
    let r = null; try { r = await api.alfredPersonality(patch); } catch (_) { r = null; }
    $('ap-msg').textContent = (r && r.message) || (r && r.ok ? 'Saved.' : 'Could not save the personality.');
    if (r && r.ok && r.personality) fillPersonality(r.personality, false);
    refreshProfiles();
  }

  function paintProfiles(r) {
    const ul = $('ap-profiles'); if (!ul) return;
    ul.textContent = '';
    const list = (r && Array.isArray(r.profiles)) ? r.profiles : [];
    if (!list.length) { ul.append(h('li', { class: 'ap-hint' }, 'None yet — set him up the way you like, then save it here.')); return; }
    for (const p of list) {
      const active = r.activeProfile === p.name;
      const li = h('li', { class: active ? 'active' : '', 'data-name': p.name },
        h('span', { class: 'ap-pname', title: `${p.brain === 'local' ? `Ollama · ${p.local.model}` : p.brain === 'pane' ? `web AI · ${p.pane.site}` : p.brain} · ${p.personality && p.personality.preset}` }, `${active ? '✓ ' : ''}${p.name}${active && r.modified ? ' (changed since)' : ''}`),
        h('button', { type: 'button', class: 'ap-use', title: 'Switch to this set-up', onclick: () => act(() => api.alfredUseProfile(p.name)) }, active ? 'Re-apply' : 'Use'),
        active && r.modified ? h('button', { type: 'button', class: 'ap-update', title: 'Save the current settings into this set-up', onclick: () => act(() => api.alfredSaveProfile(p.name)) }, 'Update') : null,
        h('button', { type: 'button', class: 'ap-rename', title: 'Rename', onclick: () => startRename(li, p.name) }, 'Rename'),
        h('button', { type: 'button', class: 'ap-delete', title: 'Delete this set-up', onclick: (e) => {
          if (confirmDelete !== p.name) { confirmDelete = p.name; e.target.textContent = 'Sure?'; setTimeout(() => { if (confirmDelete === p.name) { confirmDelete = null; e.target.textContent = 'Delete'; } }, 4000); return; }
          confirmDelete = null; act(() => api.alfredDeleteProfile(p.name));
        } }, 'Delete'));
      ul.append(li);
    }
  }
  function startRename(li, oldName) {
    li.textContent = '';
    const input = h('input', { type: 'text', class: 'ap-rename-input', maxlength: '40', value: oldName, 'aria-label': 'New name' });
    const go = () => act(() => api.alfredSaveProfile(input.value, oldName));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } if (e.key === 'Escape') refreshProfiles(); });
    li.append(input, h('button', { type: 'button', class: 'primary ap-rename-ok', onclick: go }, 'OK'), h('button', { type: 'button', onclick: refreshProfiles }, 'Cancel'));
    input.focus(); input.select();
  }
  async function act(fn) {
    let r = null; try { r = await fn(); } catch (_) { r = null; }
    $('ap-pmsg').textContent = (r && r.message) || (r && r.ok ? 'Done.' : 'That did not work.');
    if (r && Array.isArray(r.profiles)) paintProfiles(r); else refreshProfiles();
    if (r && r.ok) refreshPersonality();
    return r;
  }
  async function saveNew() {
    const i = $('ap-new-name');
    const r = await act(() => api.alfredSaveProfile(i.value.trim()));
    if (r && r.ok) i.value = '';
  }
  async function refreshProfiles() { try { paintProfiles(await api.alfredProfiles()); } catch (_) {} }
  async function refreshPersonality() {
    try {
      const r = await api.alfredPersonality();
      if (!r) return;
      if (r.limits) limits = Object.assign(limits, r.limits);
      paintPresets(r.presets);
      if (!dirty) fillPersonality(r.personality, false);
    } catch (_) {}
  }

  build();
  refreshPersonality();
  refreshProfiles();
  // Changes made elsewhere (his side panel's set-up switcher, another window) show up here too.
  if (typeof api.onAlfred === 'function') {
    api.onAlfred((p) => {
      if (!p || p.type !== 'state' || !p.state || !p.state.settings) return;
      const s = p.state.settings;
      if (!dirty && s.personality && !host.contains(document.activeElement)) fillPersonality(s.personality, false);
      if (Array.isArray(s.profiles) && !host.querySelector('.ap-rename-input')) refreshProfiles();
    });
  }
})();
