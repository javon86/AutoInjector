'use strict';
/*
 * videos-trailer.js — the 🎞 Trailer section of the 🎬 Video tab (the engine is video-trailer.js in main).
 *   • the book; its saved plan (↺ Load saved plan); the parts in order: shots (what happens, or a picture to
 *     bring to life, seconds, character lock) and title cards (text, subtitle, seconds), each with ↑ ↓ ✕;
 *   • music (optional), the trailer size, fades, the music volume;
 *   • 🎞 Make trailer / ⏹ Stop with each part's state (⏳ making, ✔ made, ♻ kept from before), the progress bar,
 *     the red error box (which shot, why, what to do), the <video> player and the saved trailers.
 * Talks only to window.api.video.trailer* (+ window.api.sd.locks for the character-lock list).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const api = (window.api && window.api.video) || null;
  const sdApi = (window.api && window.api.sd) || null;
  if (!$('vd-view-trailer')) return;

  const st = { items: [], loaded: false, timer: null, running: false, locks: [], current: null };
  const setText = (id, t) => { const e = $(id); if (e) e.textContent = t; };
  async function call(fn, ...args) {
    if (!api || typeof api[fn] !== 'function') return { ok: false, error: 'NO_API', message: 'This part of the app is not available (restart AutoInjector).' };
    try { return (await api[fn](...args)) || { ok: false }; } catch (e) { return { ok: false, error: String(e), message: String((e && e.message) || e) }; }
  }
  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e[k] = v; else e.setAttribute(k, v === true ? '' : String(v)); }
    for (const k of kids) if (k != null) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    return e;
  };

  const newShot = (o = {}) => ({ type: 'shot', prompt: '', image: '', seconds: 4, characterLock: '', ...o });
  const newCard = (o = {}) => ({ type: 'card', text: '', subtitle: '', seconds: 3, ...o });
  function defaults() {
    const book = $('vd-tr-book').value.trim();
    return [newCard({ text: book || 'Your book', subtitle: '' }), newShot(), newShot(), newShot(), newCard({ text: book || 'Your book', subtitle: 'Coming soon' })];
  }

  // ------------------------------------------------------------ the list of parts
  const STATE_WORDS = { waiting: '', ready: '', rendering: '⏳ making…', done: '✔ made', reused: '♻ kept from before', failed: '✖ failed', stopped: '⏹ stopped' };
  function total() { return st.items.reduce((n, x) => n + (Number(x.seconds) || 0), 0); }
  function render() {
    const ol = $('vd-tr-items'); ol.textContent = '';
    let shotNo = 0;
    st.items.forEach((it, i) => {
      const li = el('li', { class: 'vd-tr-item', 'data-type': it.type, 'data-index': i, 'data-status': it.status || '' });
      const title = it.type === 'shot' ? `🎬 Shot ${++shotNo}` : '🔤 Title card';
      const head = el('div', { class: 'vd-tr-head' }, el('b', { text: title }), el('span', { class: 'vd-tr-state', text: STATE_WORDS[it.status] || '' }));
      const mv = (d) => () => { const j = i + d; if (j < 0 || j >= st.items.length) return; const [x] = st.items.splice(i, 1); st.items.splice(j, 0, x); render(); };
      head.append(
        el('button', { title: 'Move up', 'aria-label': `Move ${title} up`, disabled: i === 0 || st.running, onclick: mv(-1) }, '↑'),
        el('button', { title: 'Move down', 'aria-label': `Move ${title} down`, disabled: i === st.items.length - 1 || st.running, onclick: mv(1) }, '↓'),
        el('button', { title: 'Remove', 'aria-label': `Remove ${title}`, class: 'vd-tr-remove', disabled: st.running, onclick: () => { st.items.splice(i, 1); render(); } }, '✕'));
      li.appendChild(head);
      const secs = el('input', { type: 'number', min: 1, max: it.type === 'shot' ? 5 : 10, step: 0.5, value: it.seconds, class: 'vd-tr-seconds', 'aria-label': `${title}: seconds`, style: 'width:64px;' });
      secs.oninput = () => { it.seconds = Number(secs.value) || 0; setTotal(); };
      if (it.type === 'shot') {
        const ta = el('textarea', { class: 'vd-tr-prompt', 'aria-label': `${title}: what happens`, placeholder: it.image ? 'How it moves (optional)… e.g. she turns towards the sea, wind in her hair' : 'What happens… e.g. a ferry crosses a dark sea at dawn, slow camera push' });
        ta.value = it.prompt || ''; ta.oninput = () => { it.prompt = ta.value; };
        const pic = el('span', { class: 'vd-tr-pic', text: it.image ? `🖼 ${String(it.image).split(/[\\/]/).pop()}` : '' });
        const choose = el('button', { class: 'sd-fixed', title: 'Bring a picture to life instead of describing the shot', onclick: async () => { const r = await call('trailerPickFile', 'image'); if (r && r.ok) { it.image = r.path; render(); } } }, it.image ? '🖼 Change picture' : '🖼 Use a picture…');
        const clearPic = it.image ? el('button', { class: 'sd-fixed', title: 'No picture (make the shot from the words)', onclick: () => { it.image = ''; render(); } }, '✕ picture') : null;
        const lock = el('select', { class: 'vd-tr-lock', 'aria-label': `${title}: character lock` }, el('option', { value: '' }, '— no character lock —'));
        for (const l of st.locks) lock.appendChild(el('option', { value: l.id, selected: it.characterLock === l.id || it.characterLock === l.character }, `${l.character}${l.book ? ` (${l.book})` : ''}`));
        if (it.characterLock && ![...lock.options].some((o) => o.selected)) lock.appendChild(el('option', { value: it.characterLock, selected: true }, it.characterLock));
        lock.onchange = () => { it.characterLock = lock.value; };
        li.append(ta, el('div', { class: 'sd-row', style: 'margin-top:4px;' }, el('label', { class: 'sd-fixed' }, 'Seconds ', secs), lock, choose, clearPic), pic);
      } else {
        const tx = el('input', { type: 'text', class: 'vd-tr-text', maxlength: 120, placeholder: 'Big line — e.g. the title', 'aria-label': `${title}: text` }); tx.value = it.text || ''; tx.oninput = () => { it.text = tx.value; };
        const sub = el('input', { type: 'text', class: 'vd-tr-subtitle', maxlength: 160, placeholder: 'Small line (optional) — e.g. Coming soon', 'aria-label': `${title}: subtitle` }); sub.value = it.subtitle || ''; sub.oninput = () => { it.subtitle = sub.value; };
        li.append(tx, sub, el('div', { class: 'sd-row', style: 'margin-top:4px;' }, el('label', { class: 'sd-fixed' }, 'Seconds ', secs)));
      }
      if (it.error) li.appendChild(el('div', { class: 'vd-tr-state', style: 'color:#ff9c9c;', text: it.error }));
      ol.appendChild(li);
    });
    setTotal();
    $('btn-vd-tr-add-shot').disabled = st.running; $('btn-vd-tr-add-card').disabled = st.running;
  }
  function setTotal() { const s = st.items.filter((x) => x.type === 'shot').length; setText('vd-tr-total', `${s} shot(s), ${st.items.length - s} card(s) · ${Math.round(total() * 10) / 10} s in all`); }
  $('btn-vd-tr-add-shot').onclick = () => { st.items.push(newShot()); render(); };
  $('btn-vd-tr-add-card').onclick = () => { st.items.push(newCard({ text: $('vd-tr-book').value.trim() })); render(); };

  // ------------------------------------------------------------ music + options
  $('btn-vd-tr-music').onclick = async () => { const r = await call('trailerPickFile', 'music'); if (r && r.ok) $('vd-tr-music').value = r.path; };
  $('btn-vd-tr-music-clear').onclick = () => { $('vd-tr-music').value = ''; };

  function request() {
    const [w, h] = $('vd-tr-size').value.split('x').map(Number);
    const book = $('vd-tr-book').value.trim();
    const items = st.items.map((x) => (x.type === 'card'
      ? { type: 'card', text: (x.text || '').trim(), subtitle: (x.subtitle || '').trim() || undefined, seconds: Number(x.seconds) || 3 }
      : { type: 'shot', prompt: (x.prompt || '').trim() || undefined, image: x.image || undefined, seconds: Number(x.seconds) || 4, characterLock: x.characterLock || undefined }));
    const r = { book: book || undefined, items, width: w, height: h, fade: Number($('vd-tr-fade').value), musicVolume: Number($('vd-tr-volume').value) };
    if ($('vd-tr-music').value.trim()) r.music = $('vd-tr-music').value.trim();
    return r;
  }

  // ------------------------------------------------------------ errors / progress
  function hideError() { $('vd-tr-error').hidden = true; }
  function showError(r) {
    setText('vd-tr-error-msg', `✖ ${(r && r.message) || (r && r.error) || 'The trailer could not be made.'}`);
    const fix = (r && (r.fix || r.hint)) || '';
    setText('vd-tr-error-fix', fix ? `How to fix: ${fix}` : ''); $('vd-tr-error-fix').hidden = !fix;
    $('vd-tr-error').hidden = false;
  }
  function busy(on) {
    st.running = on;
    $('btn-vd-tr-make').disabled = on; $('btn-vd-tr-stop').disabled = !on;
    $('btn-vd-tr-make').textContent = on ? '⏳ Making the trailer…' : '🎞 Make trailer';
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    if (on) st.timer = setInterval(poll, 1000);
    render();
  }
  function applyStatus(s) {
    if (!s) return;
    (s.items || []).forEach((x, i) => { if (st.items[i]) { st.items[i].status = x.status; st.items[i].error = x.error ? x.error.message : ''; } });
    $('vd-tr-progress-bar').style.width = `${Math.round((s.pct || 0) * 100)}%`;
    const phase = { shots: s.shots ? `shot ${Math.min(s.shot, s.shots)} of ${s.shots}` : 'shots', joining: 'joining the parts', mp4: 'making the .mp4 copy', done: 'done', starting: 'starting' }[s.phase] || s.phase;
    if (s.busy) setText('vd-tr-msg', `🎞 ${phase} · ${s.seconds} s so far\n${s.message || ''}`);
    render();
  }
  async function poll() {
    const r = await call('trailerStatus');
    if (!r || !r.ok) return;
    if (r.status) applyStatus(r.status);
    if (r.status && !r.status.busy && st.running) finished(r.result || (r.status && r.status.result));
  }
  function finished(r) {
    busy(false);
    if (!r) { setText('vd-tr-msg', ''); return; }
    if (!r.ok) { setText('vd-tr-msg', ''); if (r.error !== 'VIDEO_CANCELLED') showError(r); else setText('vd-tr-msg', `⏹ Stopped. ${r.fix || ''}`); return; }
    const warn = (r.warnings || []).map((w) => `⚠ ${w.message}`).join('\n');
    setText('vd-tr-msg', `✔ Trailer saved: ${r.seconds} s${r.mp4 ? ' (.webm + .mp4)' : ' (.webm)'}${r.reused ? ` — ${r.reused} shot(s) kept from before` : ''}${warn ? `\n${warn}` : ''}`);
    $('vd-tr-progress-bar').style.width = '100%';
    play(r);
    loadList();
  }
  function play(r) {
    st.current = r;
    const v = $('vd-tr-player');
    v.src = `${r.url}${r.url && r.url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    v.hidden = false; $('vd-tr-empty').hidden = true;
    setText('vd-tr-info', [r.book ? `“${r.book}”` : '', [r.seconds != null && `${r.seconds} s`, r.width && `${r.width}×${r.height}`, r.mp4 ? 'trailer.webm + trailer.mp4' : 'trailer.webm'].filter(Boolean).join(' · '), r.dir || ''].filter(Boolean).join('\n'));
    $('btn-vd-tr-showfile').disabled = !r.path;
  }
  $('btn-vd-tr-showfile').onclick = () => { if (st.current && st.current.path) call('showFile', st.current.mp4 || st.current.path); };

  async function make() {
    if (st.running) return;
    hideError();
    for (const x of st.items) { x.status = ''; x.error = ''; }
    const req = request();
    if (!req.items.length) { showError({ message: 'Add at least one shot or title card.' }); return; }
    const empty = req.items.findIndex((x) => (x.type === 'shot' ? !x.prompt && !x.image && !x.characterLock : !x.text));
    if (empty >= 0) { showError({ message: `Part ${empty + 1} is empty: ${req.items[empty].type === 'shot' ? 'describe the shot or choose a picture' : 'write the title card\'s text'}.` }); return; }
    setText('vd-tr-msg', '🎞 Starting…');
    const r = await call('trailerMake', req);
    if (!r || !r.ok) { setText('vd-tr-msg', ''); showError(r); return; }
    if (r.status) applyStatus(r.status);
    busy(true);
  }
  $('btn-vd-tr-make').onclick = make;
  $('btn-vd-tr-stop').onclick = async () => { $('btn-vd-tr-stop').disabled = true; setText('vd-tr-msg', '⏹ Stopping…'); await call('trailerCancel'); };

  // ------------------------------------------------------------ saved plans / trailers
  async function loadPlan(book) {
    const r = await call('trailerPlan', book);
    const p = r && r.ok && r.plan;
    if (!p) { setText('vd-tr-msg', `No saved trailer plan for “${book}” yet.`); return false; }
    st.items = (p.items || []).map((x) => (x.type === 'card' ? newCard(x) : newShot(x)));
    if (p.music) $('vd-tr-music').value = p.music;
    if (p.width && p.height && [...$('vd-tr-size').options].some((o) => o.value === `${p.width}x${p.height}`)) $('vd-tr-size').value = `${p.width}x${p.height}`;
    if (p.fade != null) $('vd-tr-fade').value = String(p.fade);
    if (p.musicVolume != null) $('vd-tr-volume').value = String(p.musicVolume);
    render();
    setText('vd-tr-msg', `Loaded the saved plan of “${p.book || book}”.`);
    return true;
  }
  $('btn-vd-tr-load').onclick = () => { const b = $('vd-tr-book').value.trim(); if (b) loadPlan(b); else setText('vd-tr-msg', 'Type the book\'s title first.'); };
  async function loadList() {
    const r = await call('trailerList');
    const box = $('vd-tr-list'); box.textContent = '';
    const dl = $('vd-tr-books'); dl.textContent = '';
    for (const it of (r && r.items) || []) {
      dl.appendChild(el('option', { value: it.book }));
      box.appendChild(el('div', { class: 'vd-tr-saved' }, el('span', { text: `${it.book}${it.seconds ? ` · ${it.seconds} s` : ''}${it.mp4 ? ' · .mp4' : ''}` }),
        el('button', { class: 'sd-fixed', onclick: () => play(Object.assign({}, it, { width: it.plan && it.plan.width, height: it.plan && it.plan.height })) }, '▶ Play'),
        el('button', { class: 'sd-fixed', onclick: () => { $('vd-tr-book').value = it.book; loadPlan(it.book); } }, '✎ Edit')));
    }
    if (!box.children.length) box.textContent = 'No trailers yet.';
  }
  async function loadLocks() {
    if (!sdApi || typeof sdApi.locks !== 'function') return;
    try { const r = await sdApi.locks(); st.locks = (r && r.locks) || []; } catch (_) { st.locks = []; }
  }
  async function init() {
    st.loaded = true;
    await loadLocks();
    if (!st.items.length) st.items = defaults();
    render();
    loadList();
    // a trailer already being made (e.g. asked for by Akọwe or 🎩 Alfred): follow it
    const r = await call('trailerStatus');
    if (r && r.ok && r.busy && r.status) {
      st.items = r.status.items.map((x) => (x.type === 'card' ? newCard({ text: String(x.label || '').replace(/^Card: /, '') }) : newShot({ prompt: String(x.label || '').replace(/^Shot \d+: /, '') })));
      applyStatus(r.status); busy(true);
    }
  }
  document.addEventListener('vd-subtab', (e) => { if (e.detail === 'trailer' && !st.loaded) init(); });
  window.vdTrailer = { state: st, render, request, loadPlan };
})();
