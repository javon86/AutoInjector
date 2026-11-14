// alfred-team-ui.js — 👥 Alfred's team in the control panel (controls.html):
//   • the one-line "team ready" status at the top of the 🤖 AutoInjector tab (#alfred-team-line):
//     "🎩 Alfred's team is connected and working for your book: Butler ✔ · Assistant ✔ · …" — ✔ ready,
//     ⚪ not set (the Butler's model does that job), ⚠ a problem (with a plain fix). While Akọwe writes a book it
//     says the team is standing by for it. Click → his ⚙ settings with the team.
//   • the team panel (one row per role: icon + name, what it is for, the model — DOWNLOADED models only —, its
//     ★1–5 fit for that role with the reasons on hover, and a 💡 better downloaded model with "Use it"; a
//     "✨ Pick the best for each role" button). Mounted in Alfred's ⚙ settings (#alfred-team, alfred-panel.js) and
//     in the 🎩 Butler section (#alfred-team-panel). Nothing is ever downloaded from here.
// Talks to main only through window.api.alfredTeam / alfredTeamSet / alfredTeamBest / alfredStatus / onAlfred.
// Needs alfred-team.js first (window.AlfredTeam: the role names and the star text) — works without it too.
(function () {
  'use strict';
  const api = window.api || {};
  if (typeof api.alfredTeam !== 'function') return;
  const T = window.AlfredTeam || null;
  const POLL_MS = 30000;
  const mounts = new Set();
  let st = null;          // the last alfred:team answer
  let enabled = false;    // Alfred on
  let busy = false;
  let lastAt = 0;
  let timer = null;
  let msg = '';
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
  const stars = (n) => (T && T.starsText ? T.starsText(n) : `${'★'.repeat(n)}${'☆'.repeat(5 - n)}`);
  /** "qwen2.5:14b" → "Qwen2.5 14B", "hf.co/bartowski/Foo-GGUF:Q4_K_M" → "Foo Q4_K_M". */
  function pretty(name) {
    let n = String(name || '').replace(/^hf\.co\/[^/]+\//, '').replace(/-GGUF/i, '');
    const parts = n.split(':'); let base = parts[0]; const tag = parts[1] && parts[1] !== 'latest' ? parts[1] : '';
    base = base.split('/').pop();
    base = base.charAt(0).toUpperCase() + base.slice(1);
    return `${base}${tag ? ` ${/^\d+(?:\.\d+)?[bm]$/i.test(tag) ? tag.toUpperCase() : tag}` : ''}`;
  }
  const MARK = { ok: '✔', unset: '⚪', problem: '⚠' };

  function css() {
    if ($('alfred-team-style')) return;
    const s = document.createElement('style');
    s.id = 'alfred-team-style';
    s.textContent = `
      #alfred-team-line { order:-1; display:flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid #2b3550; border-radius:8px; background:#10162a; color:#dfe7fb; font-size:12.5px; line-height:1.4; cursor:pointer; }
      #alfred-team-line[hidden] { display:none; }
      #alfred-team-line[data-tone="warn"] { border-color:#6b5a2a; background:#221d10; color:#f0dca0; }
      #alfred-team-line .atl-text { flex:1 1 auto; min-width:0; overflow-wrap:anywhere; }
      #alfred-team-line button { flex:0 0 auto; font-size:11.5px; padding:2px 8px; border-radius:6px; border:1px solid #334064; background:#161d30; color:#e8ecf5; cursor:pointer; }
      .at-box { border:1px solid #2b3550; border-radius:9px; padding:8px 10px; background:#0f1424; color:#e8ecf5; font-size:12px; display:flex; flex-direction:column; gap:8px; }
      .at-box h3 { margin:0; font-size:13.5px; color:#cfe0ff; }
      .at-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .at-head .at-sp { flex:1 1 auto; }
      .at-box button { font-size:12px; padding:3px 9px; border-radius:6px; border:1px solid #334064; background:#161d30; color:#e8ecf5; cursor:pointer; }
      .at-box button.primary { background:#2c4a8a; border-color:#4a6fc0; }
      .at-box button:disabled { opacity:.55; cursor:default; }
      .at-note { font-size:11.5px; color:#9aa6c3; }
      .at-msg { font-size:11.5px; color:#bfe3c8; min-height:0; }
      .at-msg:empty { display:none; }
      .at-roles { display:flex; flex-direction:column; gap:7px; }
      .at-role { border:1px solid #232c45; border-radius:8px; padding:7px 9px; background:#121a2e; display:grid; grid-template-columns:auto 1fr; gap:3px 10px; align-items:center; }
      .at-role[data-state="problem"] { border-color:#6b5a2a; }
      .at-ic { grid-row:1 / span 2; font-size:24px; }
      .at-name { font-weight:700; font-size:13px; display:flex; gap:6px; align-items:baseline; flex-wrap:wrap; }
      .at-state { font-weight:400; font-size:11.5px; color:#9aa6c3; }
      .at-state[data-state="ok"] { color:#7fd99a; } .at-state[data-state="problem"] { color:#f0b35e; }
      .at-for { font-size:11.5px; color:#9aa6c3; }
      .at-pick { grid-column:1 / -1; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .at-pick select { flex:1 1 180px; min-width:0; background:#0b0e16; color:#e8ecf5; border:1px solid #2b3550; border-radius:6px; padding:4px 6px; font-size:12.5px; }
      .at-stars { font-size:15px; letter-spacing:1px; color:#f3d488; cursor:help; white-space:nowrap; }
      .at-fix { grid-column:1 / -1; font-size:11.5px; color:#f0b35e; }
      .at-suggest { grid-column:1 / -1; font-size:11.5px; color:#f0dca0; display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
      .at-suggest button { font-size:11px; padding:1px 8px; }
    `;
    document.head.appendChild(s);
  }

  // ------------------------------------------------------------------ the one-line status on the 🤖 AutoInjector tab
  function ensureLine() {
    let line = $('alfred-team-line');
    if (line) return line;
    const wrap = $('wrap');
    if (!wrap) return null;
    css();
    line = h('div', { id: 'alfred-team-line', role: 'status', 'aria-live': 'polite', hidden: true, title: 'Alfred\'s team — click to see each role and its model', onclick: (e) => { if (e.target && e.target.closest && e.target.closest('button')) return; openTeam(); } },
      h('span', { class: 'atl-text' }),
      h('button', { type: 'button', id: 'alfred-team-line-open', onclick: () => openTeam() }, '👥 Team'));
    const anchor = $('col-userpanel');
    if (anchor && anchor.parentNode === wrap) wrap.insertBefore(line, anchor); else wrap.prepend(line);
    return line;
  }
  function paintLine() {
    const line = ensureLine();
    if (!line) return;
    const show = enabled && st && st.ok && st.line && st.line.text;
    const was = line.hidden;
    line.hidden = !show;
    if (show) {
      line.querySelector('.atl-text').textContent = st.line.text;
      line.dataset.tone = st.line.tone || 'ok';
      // hover: each role's model and what to do
      line.title = (st.roles || []).map((r) => `${r.icon} ${r.name}: ${r.model || '—'}${r.state === 'problem' ? ` — ${r.fix}` : r.note ? ` (${r.note})` : ''}`).join('\n');
    }
    if (was !== line.hidden) { try { const p = api.syncPanes && api.syncPanes(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
  }
  function openTeam() {
    if (window.AlfredPanel && typeof window.AlfredPanel.showTeam === 'function') { window.AlfredPanel.showTeam(); return; }
    const t = $('alfred-team-panel');
    if (t) { try { t.scrollIntoView({ block: 'start' }); } catch (_) {} }
  }

  // ------------------------------------------------------------------ the team panel
  function render(box) {
    if (!box || !box.isConnected) { mounts.delete(box); return; }
    css();
    box.classList.add('at-box');
    box.textContent = '';
    const head = h('div', { class: 'at-head' },
      h('h3', null, '👥 Alfred\'s team — one model for each job'), h('span', { class: 'at-sp' }),
      h('button', { type: 'button', class: 'primary at-best', title: 'Gives each role the best-rated model that is already downloaded. Nothing is downloaded.', disabled: busy || !st || !st.local || !(st.models || []).length, onclick: pickBest }, '✨ Pick the best for each role'),
      h('button', { type: 'button', class: 'at-refresh', title: 'Check again', disabled: busy, onclick: () => refresh(true) }, '↻'));
    box.append(head);
    if (!st) { box.append(h('div', { class: 'at-note' }, 'Checking…')); return; }
    if (!st.ok) { box.append(h('div', { class: 'at-note' }, st.message || 'Alfred\'s team isn\'t available right now.')); return; }
    const notes = [];
    if (st.hw && st.hw.vramMB) notes.push(`Your graphics card: ${st.hw.gpu ? `${st.hw.gpu}, ` : ''}${Math.round(st.hw.vramMB / 1024)} GB. Only one big model is kept in it at a time — Alfred makes room before another role answers.`);
    if (!st.local) notes.push(`His AI is ${st.brainWord || 'not a local model'}: every role thinks with it. Choose "Local model (Ollama)" in ⚙ His AI to give each role its own model.`);
    else if (!st.ollama) notes.push('Ollama isn\'t running, so the downloaded models can\'t be listed — press 🛠 Set up his AI.');
    else if (!(st.models || []).length) notes.push('No models are downloaded yet — download one with 🔎 Find a model (in the 🎩 Butler section).');
    notes.push('A role without its own model uses the Butler\'s. Name a role to use it: "bad boy, …", "director, plan …", "assistant, …", "prompt writer, …".');
    for (const n of notes) box.append(h('div', { class: 'at-note' }, n));
    const list = h('div', { class: 'at-roles' });
    for (const r of st.roles || []) list.append(roleRow(r));
    box.append(list, h('div', { class: 'at-msg', role: 'status', 'aria-live': 'polite' }, msg));
  }
  function roleRow(r) {
    const models = st.models || [];
    const sel = h('select', { class: 'at-model', 'data-role': r.id, 'aria-label': `${r.name}'s model`, disabled: busy || !st.local || !models.length });
    const butler = (st.roles || []).find((x) => x.id === 'butler');
    if (r.id !== 'butler') sel.append(h('option', { value: '' }, `— the Butler's model${butler && butler.model ? ` (${pretty(butler.model)})` : ''} —`));
    const chosen = r.chosen || '';
    let found = !chosen;
    for (const m of models) {
      const rt = (r.ratings || {})[m.name];
      const o = h('option', { value: m.name, title: rt ? rt.text : '' }, `${pretty(m.name)}${m.sizeText ? ` · ${m.sizeText}` : ''}${rt ? ` · ${stars(rt.stars)}` : ''}${m.loaded ? ' · in memory' : ''}`);
      if (T && T.sameModel ? T.sameModel(m.name, chosen) : m.name === chosen) { o.selected = true; found = true; }
      sel.append(o);
    }
    if (!found) sel.append(h('option', { value: chosen, selected: true }, `${chosen} (not downloaded)`));
    if (r.id !== 'butler' && !chosen) sel.value = '';
    sel.addEventListener('change', () => setRole(r.id, sel.value));
    const rt = r.rating;
    const starEl = h('span', { class: 'at-stars', tabindex: '0', 'data-stars': rt ? String(rt.stars) : '0', title: rt ? `${stars(rt.stars)} for the ${r.name}: ${rt.text || 'no notes'}` : 'No model', 'aria-label': rt ? `${rt.stars} of 5 stars for the ${r.name}. ${rt.text || ''}` : 'No rating' }, rt ? stars(rt.stars) : '');
    const row = h('div', { class: 'at-role', 'data-role': r.id, 'data-state': r.state },
      h('span', { class: 'at-ic', 'aria-hidden': 'true' }, r.icon),
      h('div', { class: 'at-name' }, r.name, h('span', { class: 'at-state', 'data-state': r.state }, `${MARK[r.state] || '⚪'} ${r.state === 'ok' ? `ready${r.loaded ? ' · in memory' : ''}` : r.state === 'unset' ? 'not set — uses the Butler\'s model' : 'needs a hand'}`)),
      h('div', { class: 'at-for' }, r.for),
      h('div', { class: 'at-pick' }, sel, starEl));
    if (r.state === 'problem' && r.fix) row.append(h('div', { class: 'at-fix' }, `⚠ ${r.fix}`));
    if (r.suggestion && r.suggestion.model) {
      const s = r.suggestion;
      row.append(h('div', { class: 'at-suggest' }, `💡 ${pretty(s.model)} fits the ${r.name} better (★${s.stars} vs ★${s.current}) —`,
        h('button', { type: 'button', class: 'at-use', 'data-model': s.model, disabled: busy, onclick: () => setRole(r.id, s.model) }, 'Use it')));
    }
    return row;
  }
  function paintAll() { for (const b of [...mounts]) render(b); paintLine(); }

  async function setRole(role, model) {
    if (busy || typeof api.alfredTeamSet !== 'function') return;
    busy = true; msg = ''; paintAll();
    let r = null;
    try { r = await api.alfredTeamSet(role, model); } catch (_) { r = null; }
    busy = false;
    if (r && r.roles) st = r;
    msg = (r && r.message) || (r && r.ok === false ? 'That didn\'t work — try again.' : '');
    lastAt = Date.now();
    paintAll();
  }
  async function pickBest() {
    if (busy || typeof api.alfredTeamBest !== 'function') return;
    busy = true; msg = 'Rating the downloaded models…'; paintAll();
    let r = null;
    try { r = await api.alfredTeamBest(); } catch (_) { r = null; }
    busy = false;
    if (r && r.roles) st = r;
    msg = (r && r.message) || 'That didn\'t work — try again.';
    lastAt = Date.now();
    paintAll();
  }
  async function refresh(force) {
    if (!enabled && !force) { paintLine(); return; }
    if (!force && Date.now() - lastAt < 5000) return;
    lastAt = Date.now();
    let r = null;
    try { r = await api.alfredTeam(); } catch (_) { r = null; }
    if (r) st = r;
    if (r && typeof r.enabled === 'boolean') enabled = r.enabled;
    if (force) msg = '';
    paintAll();
  }
  function mount(box) {
    if (!box) return;
    mounts.add(box);
    render(box);
    refresh(true);
  }
  function startPoll() {
    if (timer) return;
    timer = setInterval(() => { if (enabled && (typeof document.hidden !== 'boolean' || !document.hidden)) refresh(false); }, POLL_MS);
  }

  window.AlfredTeamUI = { mount, refresh: () => refresh(true), state: () => st, pretty };
  ensureLine();
  const host = $('alfred-team-panel'); if (host) mounts.add(host);
  if (typeof api.onAlfred === 'function') {
    let pending = null;
    api.onAlfred((p) => {
      if (!p || p.type !== 'state' || !p.state) return;
      const was = enabled; enabled = !!p.state.enabled;
      if (enabled && !was) { refresh(true); return; }
      if (!enabled) { paintLine(); return; }
      if (pending) return; // settings / a request changed: look again soon (at most every few seconds)
      pending = setTimeout(() => { pending = null; refresh(false); }, 3000);
    });
  }
  Promise.resolve(typeof api.alfredStatus === 'function' ? api.alfredStatus() : null).then((s) => {
    enabled = !!(s && s.enabled);
    refresh(true); // the 🎩 Butler section's panel shows the team even while he is off (the line only when he is on)
  }).catch(() => {});
  startPoll();
}());
