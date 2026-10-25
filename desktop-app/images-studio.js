'use strict';
/*
 * images-studio.js — the 🎨 Images tab in the control panel.
 *   • connection bar: Find my SD app / Connect / Test 512px, plain-English status
 *     ("✔ Connected to Forge on :7860 — model X") and the --api fix when needed;
 *   • 🖌 Generate: prompt, negative, character lock, LoRA picker (chips with
 *     weights; sent as <lora:name:w> to Forge/A1111, as LoRA loader nodes to
 *     ComfyUI), checkpoint/VAE/sampler/scheduler, sliders, seed, progress + Stop,
 *     result + gallery with Remake / Variation;
 *   • 📚 Library: the Model & LoRA library (search, filters, previews, base-model
 *     badges + mismatch warnings, your tags / collections / ★ / weight / notes);
 *   • 🔒 Character locks.
 * Talks only to window.api.sd (preload.js). If that is missing the tab says so.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const api = (window.api && window.api.sd) || null;
  if (!$('images-tab')) return;

  const st = {
    connected: false, status: null, lists: null, loras: [], locks: [], lib: null, libSel: null, lockSel: null,
    chips: [], generating: false, pollTimer: null, lastSeed: null, current: null, libItemsById: new Map(), loaded: false,
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function setText(id, t) { const e = $(id); if (e) e.textContent = t; }
  function hint(text, tone) { const h = $('sd-hint'); if (!h) return; if (!text) { h.hidden = true; h.textContent = ''; return; } h.hidden = false; h.dataset.tone = tone || 'warn'; h.textContent = text; }
  function msg(t) { setText('sd-msg', t || ''); }
  function fmtSize(n) { if (!n) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n; while (v >= 1024 && i < 3) { v /= 1024; i++; } return `${v.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`; }
  async function call(fn, ...args) {
    if (!api || typeof api[fn] !== 'function') return { ok: false, error: 'NO_API', message: 'This part of the app is not available (restart AutoInjector).' };
    try { return (await api[fn](...args)) || { ok: false }; } catch (e) { return { ok: false, error: String(e), message: String((e && e.message) || e) }; }
  }

  // ------------------------------------------------------------ the tab itself
  function showTab() {
    document.body.dataset.appTab = 'images';
    for (const id of ['tab-app-main', 'tab-app-akowe']) if ($(id)) $(id).setAttribute('aria-selected', 'false');
    $('tab-app-images').setAttribute('aria-selected', 'true');
    if ($('akowe-tab')) $('akowe-tab').hidden = true;
    $('images-tab').hidden = false;
    try { if (window.api && window.api.akoweTab) window.api.akoweTab(false); } catch (_) {}
    if (!st.loaded) { st.loaded = true; init(); }
  }
  function hideTab() { $('images-tab').hidden = true; if ($('tab-app-images')) $('tab-app-images').setAttribute('aria-selected', 'false'); }
  window.sdShowImagesTab = showTab;
  $('tab-app-images').addEventListener('click', showTab);
  for (const id of ['tab-app-main', 'tab-app-akowe']) if ($(id)) $(id).addEventListener('click', () => {
    hideTab();
    if (document.body.dataset.appTab === 'images') document.body.dataset.appTab = id === 'tab-app-akowe' ? 'akowe' : 'main';
  });

  function subTab(which) {
    for (const w of ['generate', 'library', 'locks', 'setup']) {
      $(`sd-sub-${w}`).setAttribute('aria-selected', String(w === which));
      $(`sd-view-${w}`).hidden = w !== which;
    }
    if (which === 'library') refreshLibrary();
    if (which === 'locks') refreshLocks();
    if (which === 'setup') { refreshTargets(); installCheck(); }
  }
  if ($('sd-sub-setup')) $('sd-sub-setup').onclick = () => subTab('setup');
  $('sd-sub-generate').onclick = () => subTab('generate');
  $('sd-sub-library').onclick = () => subTab('library');
  $('sd-sub-locks').onclick = () => subTab('locks');

  // ------------------------------------------------------------ connection
  function renderStatus(s, note) {
    st.status = s || st.status;
    const on = !!(s && s.enabled && s.endpoint);
    st.connected = on;
    const dot = on ? 'ok' : 'off';
    $('sd-dot').dataset.tone = dot; if ($('sd-tab-dot')) $('sd-tab-dot').dataset.tone = dot;
    let port = ''; try { port = s && s.base ? new URL(s.base).port : ''; } catch (_) {}
    const model = s && (s.checkpoint || s.model);
    const text = note || (on ? `✔ Connected to ${s.label || (s.backend === 'comfy' ? 'ComfyUI' : 'Stable Diffusion')}${port ? ` on :${port}` : ''}${model ? ` — model ${model}` : ''}` : 'Not connected');
    setText('sd-status-text', text);
    $('sd-status').title = text;
    if (s && s.base && !$('sd-url').value) $('sd-url').value = s.base;
  }

  function showFound(r) {
    if (!r) return;
    if (r.ok) {
      hint('', '');
      renderStatus(r.status, r.message ? `✔ ${r.message}${r.model && !/model/.test(r.message) ? ` — model ${r.model}` : ''}` : null);
      return;
    }
    const tone = r.kind === 'webui-no-api' || r.kind === 'fooocus' || r.kind === 'fooocus-api' ? 'warn' : 'error';
    hint(r.message || 'Could not connect.', tone);
    renderStatus(r.status || st.status, r.kind === 'webui-no-api' ? '⚠ Found a WebUI, but its API is off (--api)' : '✖ Not connected');
  }

  async function find() {
    renderStatus(st.status, '🔍 Looking on this PC…');
    const d = await call('detect');
    if (!d || !d.ok) { hint((d && d.message) || 'Could not look for SD apps.', 'error'); renderStatus(st.status); return; }
    if (d.best) {
      $('sd-url').value = d.best.base;
      const others = d.found.slice(1).map((f) => `${f.label} on :${f.port}`);
      const r = await call('connect', d.best.base);
      showFound(r);
      if (r.ok) { if (others.length) hint(`Also found: ${others.join(', ')}. Type its address and press Connect to use it instead.`, 'ok'); await afterConnect(); }
      return;
    }
    if (d.problems && d.problems.length) { $('sd-url').value = d.problems[0].base; showFound(d.problems[0]); return; }
    hint(d.message, 'error');
    renderStatus(st.status, '✖ No SD app found');
  }
  async function connect() {
    const url = $('sd-url').value.trim();
    if (!url) return find();
    renderStatus(st.status, '⏳ Connecting…');
    const r = await call('connect', url);
    showFound(r);
    if (r.ok) await afterConnect();
  }
  async function afterConnect() { await loadLists(); await refreshLibraryData(); }

  function fillSelect(sel, values, keep, firstLabel) {
    const e = $(sel); if (!e) return;
    const cur = keep != null ? keep : e.value;
    e.textContent = '';
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = firstLabel; e.appendChild(o0);
    for (const v of values) { const o = document.createElement('option'); o.value = v.value != null ? v.value : v; o.textContent = v.label || v.value || v; e.appendChild(o); }
    if ([...e.options].some((o) => o.value === cur)) e.value = cur;
  }
  async function loadLists() {
    const l = await call('lists');
    if (!l || !l.ok) { if (l && l.message && st.connected) hint(l.message, 'error'); return; }
    st.lists = l;
    const s = st.status || {};
    fillSelect('sd-checkpoint', l.checkpoints.map((c) => ({ value: c.name, label: c.title || c.name })), s.checkpoint || '', l.backend === 'comfy' ? '(first checkpoint)' : `(loaded: ${l.current.checkpoint || 'whatever is loaded'})`);
    fillSelect('sd-vae', l.vaes.filter((v) => v !== 'Automatic'), s.vae || '', 'Automatic');
    fillSelect('sd-sampler', l.samplers, s.sampler || '', '(default)');
    fillSelect('sd-scheduler', l.schedulers, s.scheduler || '', '(default)');
    fillSelect('sd-lk-checkpoint', l.checkpoints.map((c) => ({ value: c.name, label: c.title || c.name })), null, '(whatever is chosen)');
    st.loras = l.loras;
    const dl = $('sd-lk-lora-names'); if (dl) { dl.textContent = ''; for (const x of l.loras) { const o = document.createElement('option'); o.value = `${x.alias || x.name}:0.8`; dl.appendChild(o); } }
    checkCompat();
  }

  $('btn-sd-find').onclick = find;
  $('btn-sd-connect').onclick = connect;
  $('sd-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  $('btn-sd-openui').onclick = async () => { const r = await call('openUi'); if (!r.ok) hint('Connect to your SD app first.', 'warn'); };
  $('btn-sd-test').onclick = async () => {
    if (!st.connected) { await find(); if (!st.connected) return; }
    await runGenerate(null, true);
  };

  // ------------------------------------------------------------ sliders / form
  const SLIDERS = [['sd-steps', 'steps'], ['sd-cfg', 'cfgScale'], ['sd-width', 'width'], ['sd-height', 'height'], ['sd-batch', 'batchSize']];
  for (const [id] of SLIDERS) { const r = $(id); const upd = () => setText(`${id}-v`, r.value); r.addEventListener('input', upd); upd(); }
  function setSlider(id, v) { if (v == null || !$(id)) return; $(id).value = v; setText(`${id}-v`, $(id).value); }
  $('btn-sd-seed-rand').onclick = () => { $('sd-seed').value = '-1'; };
  $('btn-sd-seed-last').onclick = () => { if (st.lastSeed != null) $('sd-seed').value = String(st.lastSeed); };
  $('sd-size-preset').onchange = (e) => { const v = e.target.value; if (!v) return; const [w, h] = v.split('x'); setSlider('sd-width', w); setSlider('sd-height', h); e.target.value = ''; };
  $('sd-checkpoint').onchange = () => { checkCompat(); };

  function formRequest() {
    const num = (id) => Number($(id).value);
    return {
      prompt: $('sd-prompt').value, negativePrompt: $('sd-negative').value,
      steps: num('sd-steps'), cfgScale: num('sd-cfg'), width: num('sd-width'), height: num('sd-height'), batchSize: num('sd-batch'),
      seed: Number.isFinite(num('sd-seed')) ? num('sd-seed') : -1,
      checkpoint: $('sd-checkpoint').value, vae: $('sd-vae').value, sampler: $('sd-sampler').value, scheduler: $('sd-scheduler').value,
      loras: st.chips.map((c) => ({ name: c.name, weight: c.weight })),
      characterLock: $('sd-lock-pick').value || undefined,
    };
  }
  function fillForm(rec, keepSeed) {
    if (!rec) return;
    $('sd-prompt').value = rec.prompt || '';
    $('sd-negative').value = rec.negativePrompt || '';
    setSlider('sd-steps', rec.steps); setSlider('sd-cfg', rec.cfgScale); setSlider('sd-width', rec.width); setSlider('sd-height', rec.height);
    $('sd-seed').value = keepSeed && rec.seed != null ? String(rec.seed) : '-1';
    for (const [sel, v] of [['sd-checkpoint', rec.checkpoint], ['sd-vae', rec.vae], ['sd-sampler', rec.sampler], ['sd-scheduler', rec.scheduler]]) {
      const e = $(sel); if (!e || v == null) continue;
      if (v && ![...e.options].some((o) => o.value === v)) { const o = document.createElement('option'); o.value = v; o.textContent = v; e.appendChild(o); }
      e.value = v || '';
    }
    $('sd-lock-pick').value = ''; // the lock's bits are already inside the recorded prompt
    st.chips = (rec.loras || []).map((l) => ({ name: String(l.name).replace(/\\/g, '/').split('/').pop().replace(/\.(safetensors|ckpt|pt)$/i, ''), weight: Number(l.weight) || 0.8 }));
    renderChips(); checkCompat();
    subTab('generate');
  }

  // ------------------------------------------------------------ LoRA picker
  function loraCandidates(q) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const libLoras = st.lib ? st.lib.items.filter((x) => x.kind === 'lora') : [];
    const byId = new Map();
    for (const x of libLoras) byId.set(x.name.toLowerCase(), x);
    for (const l of st.loras || []) { const n = String(l.alias || l.name).replace(/\\/g, '/').split('/').pop().replace(/\.(safetensors|ckpt|pt)$/i, ''); if (!byId.has(n.toLowerCase())) byId.set(n.toLowerCase(), { name: n, kind: 'lora', base: '', triggerWords: [], tags: [], collections: [] }); }
    let all = [...byId.values()];
    if (words.length) all = all.filter((x) => { const hay = [x.name, x.title, x.base, ...(x.tags || []), ...(x.collections || []), ...(x.triggerWords || [])].join(' ').toLowerCase(); return words.every((w) => hay.includes(w)); });
    return all.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || a.name.localeCompare(b.name)).slice(0, 40);
  }
  function renderSuggest() {
    const box = $('sd-lora-list');
    const items = loraCandidates($('sd-lora-search').value);
    box.textContent = '';
    if (!items.length) { box.hidden = true; return; }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'sd-sugg'; row.setAttribute('role', 'option'); row.dataset.name = it.name;
      row.innerHTML = `${it.previewUrl ? `<img src="${esc(it.previewUrl)}" alt="">` : '<span class="sd-thumb-ph"></span>'}<span style="flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${it.favorite ? '★ ' : ''}${esc(it.name)}</span>${it.base ? `<span class="sd-badge" data-base="${esc(it.base)}">${esc(it.base)}</span>` : ''}`;
      row.onmousedown = (e) => { e.preventDefault(); addChip(it); };
      box.appendChild(row);
    }
    box.hidden = false;
  }
  $('sd-lora-search').addEventListener('input', renderSuggest);
  $('sd-lora-search').addEventListener('focus', renderSuggest);
  $('sd-lora-search').addEventListener('blur', () => setTimeout(() => { $('sd-lora-list').hidden = true; }, 150));
  $('sd-lora-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = loraCandidates($('sd-lora-search').value)[0]; if (first) { addChip(first); e.preventDefault(); } }
    if (e.key === 'Escape') $('sd-lora-list').hidden = true;
  });

  function addChip(it) {
    const name = it.name;
    if (!st.chips.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      const w = it.defaultWeight != null ? Number(it.defaultWeight) : 0.8;
      st.chips.push({ name, weight: Number.isFinite(w) ? w : 0.8 });
      // Put its trigger words in the prompt so the LoRA actually shows up.
      const trig = (it.triggerWords || []).filter(Boolean);
      const p = $('sd-prompt');
      const missing = trig.filter((t) => !p.value.toLowerCase().includes(t.toLowerCase()));
      if (missing.length) { p.value = p.value.trim() ? `${p.value.trim().replace(/,\s*$/, '')}, ${missing.join(', ')}` : missing.join(', '); msg(`Added ${name}'s trigger words: ${missing.join(', ')}`); }
    }
    $('sd-lora-search').value = ''; $('sd-lora-list').hidden = true;
    renderChips(); checkCompat();
  }
  function renderChips() {
    const box = $('sd-lora-chips');
    box.textContent = '';
    for (const c of st.chips) {
      const chip = document.createElement('span');
      chip.className = 'sd-chip'; chip.dataset.name = c.name; if (c.compat) chip.dataset.compat = c.compat;
      chip.title = c.compatMsg || '';
      const lbl = document.createElement('span'); lbl.textContent = c.name;
      const w = document.createElement('input'); w.type = 'number'; w.step = '0.05'; w.min = '-3'; w.max = '3'; w.value = String(c.weight); w.setAttribute('aria-label', `${c.name} weight`);
      w.oninput = () => { const n = Number(w.value); if (Number.isFinite(n)) c.weight = n; updateFinalPrompt(); };
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = 'Remove'; x.setAttribute('aria-label', `Remove ${c.name}`);
      x.onclick = () => { st.chips = st.chips.filter((k) => k !== c); renderChips(); checkCompat(); };
      chip.append(lbl, w, x);
      box.appendChild(chip);
    }
    updateFinalPrompt();
  }
  function updateFinalPrompt() {
    const backend = st.status && st.status.backend;
    if (!st.chips.length) { setText('sd-final-prompt', ''); return; }
    const tags = st.chips.map((c) => `<lora:${c.name}:${Math.round(c.weight * 100) / 100}>`).join(' ');
    setText('sd-final-prompt', backend === 'comfy' ? `ComfyUI gets ${st.chips.length} LoRA loader node(s): ${st.chips.map((c) => `${c.name} ×${c.weight}`).join(', ')}` : `Sent to the WebUI as: … ${tags}`);
  }
  async function checkCompat() {
    const box = $('sd-warnings'); if (!box) return;
    box.textContent = '';
    for (const c of st.chips) { delete c.compat; delete c.compatMsg; }
    if (!st.chips.length) { renderChipsFlags(); return; }
    const ck = $('sd-checkpoint').value || (st.status && (st.status.checkpoint || st.status.model)) || (st.lists && st.lists.current && st.lists.current.checkpoint) || '';
    const r = await call('check', st.chips.map((c) => ({ name: c.name, weight: c.weight })), ck);
    if (!r || !r.ok) return;
    for (const w of r.warnings || []) {
      const c = st.chips.find((k) => k.name.toLowerCase() === String(w.name).toLowerCase());
      if (c) { c.compat = w.level; c.compatMsg = w.message; }
      const d = document.createElement('div'); d.className = 'sd-warn'; d.dataset.level = w.level; d.textContent = `${w.level === 'hard' ? '⛔' : '⚠'} ${w.message}`;
      box.appendChild(d);
    }
    renderChipsFlags();
  }
  function renderChipsFlags() { for (const chip of document.querySelectorAll('#sd-lora-chips .sd-chip')) { const c = st.chips.find((k) => k.name === chip.dataset.name); if (c && c.compat) { chip.dataset.compat = c.compat; chip.title = c.compatMsg || ''; } else { delete chip.dataset.compat; chip.title = ''; } } }

  // ------------------------------------------------------------ generate
  function setBusy(on) {
    st.generating = on;
    $('btn-sd-generate').disabled = on; $('btn-sd-test').disabled = on; $('btn-sd-stop').disabled = !on;
    if (!on) { clearInterval(st.pollTimer); st.pollTimer = null; }
  }
  function startPolling() {
    clearInterval(st.pollTimer);
    st.pollTimer = setInterval(async () => {
      const p = await call('progress');
      if (!st.generating || !p || !p.busy) return;
      const frac = Math.max(0, Math.min(1, Number(p.progress) || 0));
      $('sd-progress-bar').style.width = `${Math.round(frac * 100)}%`;
      const bits = [];
      if (p.steps) bits.push(`step ${p.step}/${p.steps}`);
      if (p.job && !/^scripts_|^txt2img/.test(p.job)) bits.push(p.job);
      if (p.etaSeconds) bits.push(`about ${Math.ceil(p.etaSeconds)}s left`);
      bits.push(`${Math.round(p.elapsed || 0)}s`);
      msg(`🎨 Making your picture… ${bits.join(' · ')}`);
    }, 500);
  }
  async function runGenerate(req, isTest) {
    if (st.generating) return;
    const r0 = req || formRequest();
    if (!isTest && !String(r0.prompt || '').trim() && !r0.characterLock) { msg('Type a prompt first.'); $('sd-prompt').focus(); return; }
    if (!st.connected) { msg('Connecting first…'); await find(); if (!st.connected) { msg('No Stable Diffusion app is connected — see the note above.'); return; } }
    setBusy(true);
    $('sd-progress-bar').style.width = '0%';
    msg(isTest ? '🧪 Making a 512×512 test picture… (the first one after starting can take a minute while the model loads)' : '🎨 Making your picture…');
    startPolling();
    const r = isTest ? await call('test') : await call('generate', r0);
    setBusy(false);
    $('sd-progress-bar').style.width = r && r.ok ? '100%' : '0%';
    if (!r || !r.ok) {
      msg(`✖ ${(r && r.message) || (r && r.error) || 'Failed.'}`);
      if (r && (r.error === 'NO_API' || /--api/.test(r.message || ''))) hint(r.message, 'warn');
      return;
    }
    st.lastSeed = r.seed;
    const warn = (r.warnings || []).map((w) => `⚠ ${w.message}`).join('\n');
    msg(`✔ ${r.images.length} picture${r.images.length > 1 ? 's' : ''} saved${isTest ? ' — Stable Diffusion works!' : ''} (seed ${r.seed})${warn ? `\n${warn}` : ''}`);
    if (r.images[0]) showImage({ path: r.images[0].path, url: r.images[0].url, record: Object.assign({}, r.settings, { seed: r.images[0].seed }) });
    refreshGallery();
  }
  $('btn-sd-generate').onclick = () => runGenerate();
  $('sd-prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runGenerate(); } });
  $('btn-sd-stop').onclick = async () => { msg('Stopping…'); await call('cancel'); };

  function showImage(g) {
    st.current = g;
    const img = $('sd-preview');
    img.src = g.url; img.hidden = false;
    $('sd-preview-empty').hidden = true;
    const r = g.record || {};
    const lines = [];
    if (r.prompt) lines.push(r.prompt);
    if (r.negativePrompt) lines.push(`Negative: ${r.negativePrompt}`);
    const kv = [r.width && r.height ? `${r.width}×${r.height}` : '', r.steps ? `${r.steps} steps` : '', r.cfgScale ? `CFG ${r.cfgScale}` : '', r.sampler || '', r.seed != null ? `seed ${r.seed}` : '', r.checkpoint ? `model ${r.checkpoint}` : '', r.label || r.backend || ''].filter(Boolean);
    if (kv.length) lines.push(kv.join(' · '));
    if (r.loras && r.loras.length) lines.push(`LoRAs: ${r.loras.map((l) => `${l.name} ${l.weight}`).join(', ')}`);
    if (r.characterLock) lines.push(`Character lock: ${r.characterLock.character}`);
    setText('sd-preview-info', lines.join('\n') || g.name || '');
    for (const b of ['btn-sd-remake', 'btn-sd-variation']) $(b).disabled = !g.record;
    $('btn-sd-showfile').disabled = !g.path;
  }
  $('btn-sd-remake').onclick = () => { if (st.current && st.current.record) { fillForm(st.current.record, true); msg('Settings loaded — press Generate to make it again (same seed = same picture).'); } };
  $('btn-sd-variation').onclick = () => { if (st.current && st.current.record) { fillForm(st.current.record, false); runGenerate(); } };
  $('btn-sd-showfile').onclick = () => { if (st.current && st.current.path) call('showFile', st.current.path); };
  $('btn-sd-folder').onclick = () => call('openImagesFolder');

  async function refreshGallery() {
    const r = await call('gallery', 36);
    const box = $('sd-gallery'); box.textContent = '';
    if (!r || !r.ok) return;
    for (const g of r.items) {
      const im = document.createElement('img');
      im.src = g.url; im.alt = (g.record && g.record.prompt) ? g.record.prompt.slice(0, 80) : g.name; im.title = im.alt; im.tabIndex = 0; im.loading = 'lazy';
      im.onclick = () => showImage(g);
      im.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showImage(g); } };
      box.appendChild(im);
    }
  }

  // ------------------------------------------------------------ library
  async function refreshLibraryData() {
    const f = { q: $('sd-lib-q').value, kind: $('sd-lib-kind').value, base: $('sd-lib-base').value, collection: $('sd-lib-coll').value, favorite: $('sd-lib-fav').checked, checkpoint: $('sd-checkpoint').value || (st.status && st.status.checkpoint) || (st.lists && st.lists.current && st.lists.current.checkpoint) || '' };
    const all = await call('libList', { checkpoint: f.checkpoint });
    if (all && all.ok) { st.lib = all; st.libItemsById = new Map(all.items.map((x) => [x.id, x])); }
    return f;
  }
  async function refreshLibrary() {
    const f = await refreshLibraryData();
    if (!st.lib) { $('sd-lib-empty').hidden = false; setText('sd-lib-empty', 'The library is not available.'); return; }
    const collSel = $('sd-lib-coll'); const cur = collSel.value;
    collSel.textContent = ''; const o0 = document.createElement('option'); o0.value = ''; o0.textContent = 'All collections'; collSel.appendChild(o0);
    for (const c of st.lib.collections) { const o = document.createElement('option'); o.value = c; o.textContent = c; collSel.appendChild(o); }
    collSel.value = cur;
    const r = await call('libList', f);
    const items = r && r.ok ? r.items : [];
    const grid = $('sd-lib-grid'); grid.textContent = '';
    const folders = (r && r.folders) || [];
    const fl = $('sd-lib-folders'); fl.textContent = '';
    for (const x of folders) {
      const li = document.createElement('li');
      li.textContent = `${x.exists ? '📁' : '❔'} ${x.path} — ${x.kind === 'auto' ? 'any' : x.kind} (${x.source})`;
      if (x.source === 'added by you') { const b = document.createElement('button'); b.textContent = 'Remove'; b.style.marginLeft = '6px'; b.onclick = async () => { await call('libRemoveFolder', x.path); refreshLibrary(); }; li.appendChild(b); }
      fl.appendChild(li);
    }
    const ls = r && r.lastScan;
    setText('sd-lib-summary', `${folders.filter((x) => x.exists).length} model folder(s)${ls ? ` · last scan found ${ls.count} file(s)` : ' · not scanned yet — press Rescan'}${r && r.checkpointBase ? ` · checkpoint is ${r.checkpointBase}` : ''}`);
    $('sd-lib-empty').hidden = items.length > 0;
    if (!items.length) setText('sd-lib-empty', ls ? 'Nothing matches. Clear the filters, or add a folder with ＋ Add folder.' : 'No models listed yet. Press ↻ Rescan — AutoInjector looks in Stability Matrix\'s Data\\Models, its own models folder and what your SD app reports. Or press ＋ Add folder.');
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'sd-libcard'; card.tabIndex = 0; card.setAttribute('role', 'option'); card.dataset.id = it.id;
      card.setAttribute('aria-selected', String(st.libSel === it.id));
      if (it.compat && it.compat.level !== 'unknown') card.dataset.compat = it.compat.level;
      const icon = { lora: '🧩', checkpoint: '🧠', embedding: '🔤', vae: '🎛' }[it.kind] || '📦';
      card.innerHTML = `${it.previewUrl ? `<img class="sd-pv" src="${esc(it.previewUrl)}" alt="" loading="lazy">` : `<div class="sd-pv">${icon}</div>`}
        <div class="sd-nm" title="${esc(it.file || it.relPath)}">${it.favorite ? '★ ' : ''}${esc(it.name)}</div>
        <div class="sd-badges"><span class="sd-badge">${esc(it.kind)}</span>${it.base ? `<span class="sd-badge" data-base="${esc(it.base)}">${esc(it.base)}</span>` : '<span class="sd-badge">base ?</span>'}${it.size ? `<span class="sd-small">${fmtSize(it.size)}</span>` : ''}${it.onDisk ? '' : '<span class="sd-small">in SD app only</span>'}</div>
        <div class="sd-tr" title="${esc((it.triggerWords || []).join(', '))}">${it.triggerWords && it.triggerWords.length ? '🔑 ' + esc(it.triggerWords.join(', ')) : ''}</div>
        <div class="sd-tr">${esc([...(it.collections || []), ...(it.tags || []).map((t) => '#' + t)].join(' '))}</div>
        ${it.compat && (it.compat.level === 'hard' || it.compat.level === 'soft') ? `<div class="sd-warn" data-level="${it.compat.level}">${it.compat.level === 'hard' ? '⛔ wrong base for this checkpoint' : '⚠ may look off on this checkpoint'}</div>` : ''}`;
      card.onclick = () => selectLib(it.id);
      card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLib(it.id); } };
      grid.appendChild(card);
    }
    if (st.libSel && !items.some((x) => x.id === st.libSel)) { st.libSel = null; $('sd-lib-editor').hidden = true; }
  }
  let libTimer = null;
  const libRefreshSoon = () => { clearTimeout(libTimer); libTimer = setTimeout(refreshLibrary, 180); };
  for (const id of ['sd-lib-q', 'sd-lib-kind', 'sd-lib-base', 'sd-lib-coll', 'sd-lib-fav']) $(id).addEventListener(id === 'sd-lib-q' ? 'input' : 'change', libRefreshSoon);
  $('btn-sd-lib-scan').onclick = async () => {
    setText('sd-lib-summary', 'Scanning model folders… (only the small file headers are read)');
    if (st.connected) await loadLists();
    const r = await call('libScan');
    if (!r || !r.ok) setText('sd-lib-summary', `Scan failed: ${(r && r.message) || (r && r.error) || 'error'}`);
    await refreshLibrary();
  };
  $('btn-sd-lib-addfolder').onclick = async () => { const r = await call('libAddFolder'); if (r && r.ok) { await call('libScan'); refreshLibrary(); } else if (r && r.error !== 'CANCELLED') setText('sd-lib-summary', r.message || r.error); };
  $('btn-sd-lib-newcoll').onclick = async () => {
    const name = $('sd-lib-newcoll-name').value.trim();
    if (!name) { $('sd-lib-newcoll-name').focus(); setText('sd-lib-summary', 'Type a name for the new collection first.'); return; }
    await call('libCollection', 'add', name);
    $('sd-lib-newcoll-name').value = '';
    refreshLibrary();
  };

  function selectLib(id) {
    st.libSel = id;
    for (const c of document.querySelectorAll('.sd-libcard')) c.setAttribute('aria-selected', String(c.dataset.id === id));
    call('libList', {}).then((r) => {
      const it = r && r.ok ? r.items.find((x) => x.id === id) : null;
      if (!it) return;
      $('sd-lib-editor').hidden = false;
      setText('sd-ed-title', `${it.name}`);
      const facts = [`${it.kind}`, it.base ? `base ${it.base}${it.baseSource ? ` (from ${it.baseSource})` : ''}` : 'base unknown', it.size ? fmtSize(it.size) : '', it.title || '', it.file || `in your SD app as ${it.relPath}`];
      setText('sd-ed-facts', facts.filter(Boolean).join(' · '));
      $('sd-ed-fav').checked = !!it.favorite;
      $('sd-ed-triggers').value = (it.triggerWords || []).join(', ');
      setText('sd-ed-dataset', it.datasetTags && it.datasetTags.length ? `Most used tags in its training set: ${it.datasetTags.join(', ')}` : '');
      $('sd-ed-tags').value = (it.tags || []).join(', ');
      $('sd-ed-weight').value = it.defaultWeight != null ? String(it.defaultWeight) : '';
      $('sd-ed-base').value = it.userBase || '';
      $('sd-ed-notes').value = it.notes || '';
      const cbox = $('sd-ed-colls'); cbox.textContent = '';
      for (const c of r.collections) {
        const lab = document.createElement('label'); lab.className = 'sd-fixed'; lab.style.fontSize = '12px';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = c; cb.checked = (it.collections || []).includes(c);
        lab.append(cb, document.createTextNode(' ' + c)); cbox.appendChild(lab);
      }
      $('btn-sd-ed-use').textContent = it.kind === 'checkpoint' ? '🖌 Use this checkpoint' : it.kind === 'lora' ? '🖌 Add to the generator' : '🖌 Use';
      setText('sd-ed-msg', '');
    });
  }
  $('btn-sd-ed-save').onclick = async () => {
    if (!st.libSel) return;
    const patch = {
      favorite: $('sd-ed-fav').checked, triggerWords: $('sd-ed-triggers').value, tags: $('sd-ed-tags').value,
      defaultWeight: $('sd-ed-weight').value === '' ? null : Number($('sd-ed-weight').value), userBase: $('sd-ed-base').value, notes: $('sd-ed-notes').value,
      collections: [...document.querySelectorAll('#sd-ed-colls input:checked')].map((c) => c.value),
    };
    const r = await call('libUpdate', st.libSel, patch);
    setText('sd-ed-msg', r && r.ok ? '✔ Saved (stored in AutoInjector — your model files are not changed).' : `Save failed: ${(r && r.error) || 'error'}`);
    refreshLibrary();
  };
  $('btn-sd-ed-use').onclick = async () => {
    const r = await call('libList', {});
    const it = r && r.ok ? r.items.find((x) => x.id === st.libSel) : null;
    if (!it) return;
    if (it.kind === 'lora') addChip(it);
    else if (it.kind === 'checkpoint') {
      const sel = $('sd-checkpoint');
      const opt = [...sel.options].find((o) => o.value && (o.value === it.relPath || o.value.replace(/\s*\[[0-9a-f]+\]$/i, '').replace(/\\/g, '/').split('/').pop().replace(/\.(safetensors|ckpt)$/i, '').toLowerCase() === it.name.toLowerCase()));
      if (opt) sel.value = opt.value; else { const o = document.createElement('option'); o.value = it.name; o.textContent = it.name; sel.appendChild(o); sel.value = it.name; }
      checkCompat();
    } else if (it.kind === 'embedding') { const p = $('sd-prompt'); p.value = `${p.value.trim()}${p.value.trim() ? ', ' : ''}${st.status && st.status.backend === 'comfy' ? 'embedding:' : ''}${it.name}`; }
    else if (it.kind === 'vae') { const sel = $('sd-vae'); const opt = [...sel.options].find((o) => o.value.toLowerCase().includes(it.name.toLowerCase())); if (opt) sel.value = opt.value; }
    subTab('generate');
  };

  // ------------------------------------------------------------ character locks
  async function refreshLocks(selectId) {
    const r = await call('locks');
    st.locks = r && r.ok ? r.locks : [];
    const pick = $('sd-lock-pick'); const cur = pick.value;
    pick.textContent = ''; const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '— none —'; pick.appendChild(o0);
    for (const l of st.locks) { const o = document.createElement('option'); o.value = l.id; o.textContent = `${l.character}${l.book ? ` (${l.book})` : ''}`; pick.appendChild(o); }
    pick.value = st.locks.some((l) => l.id === cur) ? cur : '';
    const list = $('sd-lock-list'); list.textContent = '';
    $('sd-lock-empty').hidden = st.locks.length > 0;
    for (const l of st.locks) {
      const d = document.createElement('div'); d.className = 'sd-lockitem'; d.tabIndex = 0; d.dataset.id = l.id;
      d.setAttribute('aria-selected', String(l.id === (selectId || st.lockSel)));
      d.innerHTML = `<b>${esc(l.character)}</b>${l.book ? ` <span class="sd-small">${esc(l.book)}</span>` : ''}<div class="sd-small">${esc((l.loras || []).map((x) => `${x.name} ${x.weight}`).join(', ') || 'no LoRA')}</div>`;
      d.onclick = () => editLock(l.id);
      d.onkeydown = (e) => { if (e.key === 'Enter') editLock(l.id); };
      list.appendChild(d);
    }
    if (selectId) editLock(selectId);
  }
  function editLock(id) {
    const l = st.locks.find((x) => x.id === id) || null;
    st.lockSel = l ? l.id : null;
    for (const d of document.querySelectorAll('.sd-lockitem')) d.setAttribute('aria-selected', String(d.dataset.id === st.lockSel));
    $('sd-lk-character').value = l ? l.character : '';
    $('sd-lk-book').value = l ? l.book || '' : '';
    $('sd-lk-loras').value = l ? (l.loras || []).map((x) => `${x.name}:${x.weight}`).join(', ') : '';
    $('sd-lk-triggers').value = l ? (l.triggerWords || []).join(', ') : '';
    $('sd-lk-prompt').value = l ? l.prompt || '' : '';
    $('sd-lk-negative').value = l ? l.negative || '' : '';
    const ck = $('sd-lk-checkpoint');
    if (l && l.checkpoint && ![...ck.options].some((o) => o.value === l.checkpoint)) { const o = document.createElement('option'); o.value = l.checkpoint; o.textContent = l.checkpoint; ck.appendChild(o); }
    ck.value = l ? l.checkpoint || '' : '';
    $('sd-lk-seed').value = l && l.seed != null ? String(l.seed) : '-1';
    $('sd-lk-notes').value = l ? l.notes || '' : '';
    setText('sd-lk-msg', '');
  }
  function lockFromForm() {
    const loras = $('sd-lk-loras').value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const m = s.match(/^<?(?:lora:)?([^:>]+?)(?::(-?[\d.]+))?>?$/i); return m ? { name: m[1].trim(), weight: m[2] != null ? Number(m[2]) : 0.8 } : null; }).filter(Boolean);
    return { id: st.lockSel || undefined, character: $('sd-lk-character').value, book: $('sd-lk-book').value, loras, triggerWords: $('sd-lk-triggers').value.split(',').map((s) => s.trim()).filter(Boolean), prompt: $('sd-lk-prompt').value, negative: $('sd-lk-negative').value, checkpoint: $('sd-lk-checkpoint').value, seed: Number($('sd-lk-seed').value), notes: $('sd-lk-notes').value };
  }
  $('btn-sd-lock-new').onclick = () => { editLock(null); $('sd-lk-character').focus(); };
  $('btn-sd-lk-save').onclick = async () => {
    const r = await call('saveLock', lockFromForm());
    if (!r || !r.ok) { setText('sd-lk-msg', (r && r.message) || 'Could not save.'); return; }
    setText('sd-lk-msg', `✔ Saved “${r.lock.character}”.`);
    st.lockSel = r.lock.id;
    refreshLocks(r.lock.id);
  };
  $('btn-sd-lk-delete').onclick = async () => { if (!st.lockSel) return; await call('deleteLock', st.lockSel); st.lockSel = null; editLock(null); refreshLocks(); };
  $('btn-sd-lk-try').onclick = async () => {
    const r = await call('saveLock', lockFromForm());
    if (!r || !r.ok) { setText('sd-lk-msg', (r && r.message) || 'Save the lock first.'); return; }
    st.lockSel = r.lock.id;
    await refreshLocks(r.lock.id);
    subTab('generate');
    $('sd-lock-pick').value = r.lock.id;
    if (!$('sd-prompt').value.trim()) $('sd-prompt').value = 'head and shoulders portrait, looking at the viewer, soft light';
    runGenerate(Object.assign(formRequest(), { purpose: 'portrait', width: undefined, height: undefined }));
  };

  // ------------------------------------------------------------ run + install (sd-runner / sd-installer)
  function renderRunner(r) {
    if (!r) return;
    st.runner = r;
    const t = r.target;
    const txt = r.phase === 'running' ? (r.message || `✔ ${t ? t.label : 'Stable Diffusion'} running on :${r.port}${r.owned ? ' (managed)' : ''}`)
      : r.phase === 'starting' || r.phase === 'restarting' ? `⏳ ${r.message || 'Starting…'}`
      : r.phase === 'failed' ? `✖ ${r.message || 'Could not start.'}` : r.phase === 'stopped' ? '⏹ Stopped' : 'Not started';
    setText('sd-run-state', txt);
    const busy = r.phase === 'starting' || r.phase === 'restarting';
    const running = r.phase === 'running';
    if ($('btn-sd-halt')) $('btn-sd-halt').hidden = !(running && r.owned) && !busy;
    if ($('btn-sd-run')) { $('btn-sd-run').disabled = busy; if (running) $('btn-sd-run').hidden = true; }
    if ($('btn-sd-run2')) $('btn-sd-run2').disabled = busy || running;
    if ($('btn-sd-halt2')) $('btn-sd-halt2').disabled = !(running || busy);
    if (busy) renderStatus(st.status, `⏳ ${r.message || 'Starting Stable Diffusion…'}`);
    if (r.phase === 'failed') hint(r.message, 'error');
  }
  async function refreshTargets() {
    const r = await call('targets');
    if (!r || !r.ok) return;
    st.targets = r.targets;
    const sel = $('sd-run-target'); const cur = sel.value || r.targetId;
    sel.textContent = '';
    if (!r.targets.length) { const o = document.createElement('option'); o.value = ''; o.textContent = '(nothing found — install below, or add Forge / ComfyUI in Stability Matrix)'; sel.appendChild(o); }
    for (const t of r.targets) { const o = document.createElement('option'); o.value = t.id; o.disabled = !t.supported; o.textContent = `${t.displayName}${t.displayName === t.label ? '' : ` — ${t.label}`} (${t.source})${t.supported ? '' : ' — not supported'}${t.supported && !t.hasPython ? ' — start it once in Stability Matrix first' : ''}`; sel.appendChild(o); }
    const firstOk = r.targets.find((t) => t.supported);
    sel.value = r.targets.some((t) => t.id === cur && t.supported) ? cur : (firstOk ? firstOk.id : '');
    $('sd-autostart').checked = !!r.startWithApp;
    // The quick button on the bar: "▶ Start Forge with API".
    const pick = r.targets.find((t) => t.id === sel.value);
    const b = $('btn-sd-run');
    if (b) { b.hidden = !pick || (st.runner && st.runner.phase === 'running') || st.connected; b.textContent = pick ? `▶ Start ${pick.label}${pick.kind === 'comfy' ? '' : ' with API'}` : '▶ Start'; }
    $('btn-sd-run2').textContent = pick ? `▶ Start ${pick.label}${pick.kind === 'comfy' ? '' : ' with API'}` : '▶ Start';
    $('sd-install-card').dataset.hasTargets = String(r.targets.some((t) => t.supported));
    renderRunner(r.runner);
    if (r.install) renderInstall(r.install);
  }
  async function runStart() {
    const id = $('sd-run-target').value;
    renderRunner({ phase: 'starting', message: 'Starting Stable Diffusion… the first start can take several minutes.' });
    const r = await call('start', id);
    if (r && r.runner) renderRunner(r.runner);
    if (r && r.ok) { hint('', ''); const s = await call('status'); renderStatus(s); await loadLists(); }
    else if (r && r.message) hint(r.message, 'error');
  }
  function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(1)} GB` : '?'; }
  function renderInstall(i) {
    if (!i) return;
    const pct = Math.round((i.pct || 0) * 100);
    $('sd-install-bar').style.width = `${i.busy || i.phase === 'installed' ? pct : 0}%`;
    if (i.message) setText('sd-install-msg', i.message);
    $('btn-sd-install').disabled = !!i.busy;
    $('btn-sd-install-cancel').disabled = !i.busy;
    $('btn-sd-install').textContent = i.installed ? '✔ Installed' : (i.phase === 'paused' || i.phase === 'failed') ? '⬇ Continue the install' : '⬇ Install Stable Diffusion';
    if (i.installed) $('btn-sd-install').disabled = true;
    $('sd-model-pick').hidden = !i.installed;
  }
  async function installCheck() {
    const c = await call('installCheck');
    if (!c || !c.ok) return;
    st.installInfo = c;
    const lines = [c.gpu && c.gpu.message, c.spaceMessage];
    if (!c.supported) lines.push('The one-click install is for Windows. On this computer install ComfyUI or Forge yourself (see docs/STABLE_DIFFUSION_SETUP.md) and AutoInjector will find it.');
    if (c.enoughSpace === false) lines.push('⚠ Not enough free space on this drive.');
    setText('sd-install-check', lines.filter(Boolean).join('\n'));
    const box = $('sd-model-options'); box.textContent = '';
    for (const m of c.models || []) {
      const lab = document.createElement('label'); lab.style.display = 'block'; lab.style.fontSize = '12px';
      const rb = document.createElement('input'); rb.type = 'radio'; rb.name = 'sd-model'; rb.value = m.id; rb.checked = m.id === 'sd15';
      lab.append(rb, document.createTextNode(` ${m.label}`)); box.appendChild(lab);
    }
    renderInstall(Object.assign({ installed: c.installed }, st.installState || {}, { installed: c.installed }));
    if (!c.supported) $('btn-sd-install').disabled = true;
  }
  if ($('btn-sd-run')) $('btn-sd-run').onclick = runStart;
  if ($('btn-sd-run2')) $('btn-sd-run2').onclick = runStart;
  const halt = async () => { const r = await call('stop'); if (r && r.runner) renderRunner(r.runner); renderStatus(Object.assign({}, st.status, { enabled: false }), '⏹ Stable Diffusion stopped'); };
  if ($('btn-sd-halt')) $('btn-sd-halt').onclick = halt;
  if ($('btn-sd-halt2')) $('btn-sd-halt2').onclick = halt;
  if ($('btn-sd-runlog')) $('btn-sd-runlog').onclick = () => call('openLog');
  if ($('btn-sd-refresh-targets')) $('btn-sd-refresh-targets').onclick = refreshTargets;
  if ($('sd-run-target')) $('sd-run-target').onchange = refreshTargets;
  if ($('sd-autostart')) $('sd-autostart').onchange = (e) => call('setAutostart', !!e.target.checked);
  if ($('btn-sd-install')) $('btn-sd-install').onclick = async () => {
    const c = st.installInfo || await call('installCheck');
    if (c && c.enoughSpace === false) { setText('sd-install-msg', `Not enough free disk space. ${c.spaceMessage}`); return; }
    setText('sd-install-msg', 'Starting the download…');
    $('btn-sd-install').disabled = true; $('btn-sd-install-cancel').disabled = false;
    const r = await call('install', {});
    setText('sd-install-msg', r && r.ok ? (r.already ? '✔ ComfyUI is already installed.' : `✔ ComfyUI is installed${r.verified ? ' (checksum verified)' : ''}. Now pick a starter model below, then press Start.`) : `✖ ${(r && r.message) || 'Install failed.'}`);
    await installCheck(); await refreshTargets();
  };
  if ($('btn-sd-install-cancel')) $('btn-sd-install-cancel').onclick = () => call('installCancel');
  if ($('btn-sd-install-folder')) $('btn-sd-install-folder').onclick = () => call('openInstallFolder');
  if ($('btn-sd-model')) $('btn-sd-model').onclick = async () => {
    const id = (document.querySelector('input[name="sd-model"]:checked') || {}).value || 'sd15';
    $('btn-sd-install-cancel').disabled = false;
    const r = await call('installModel', id);
    setText('sd-install-msg', r && r.ok ? `✔ Model ready. Press ▶ Start, then Generate.` : `✖ ${(r && r.message) || 'Download failed.'}`);
    $('btn-sd-install-cancel').disabled = true;
  };
  if (api && api.onRunner) api.onRunner((r) => renderRunner(r));
  if (api && api.onInstall) api.onInstall((i) => { st.installState = i; renderInstall(i); });
  if (api && api.onConnected) api.onConnected((r) => { if (r && r.status) renderStatus(r.status, r.ok ? `✔ ${r.message || 'Connected'}` : null); if (r && r.ok && st.loaded) loadLists(); });

  // ------------------------------------------------------------ start
  async function init() {
    if (!api) { hint('The Images tab needs a newer AutoInjector (preload is missing window.api.sd). Restart the app.', 'error'); return; }
    const s = await call('status');
    if (s && s.ok) {
      renderStatus(s);
      setSlider('sd-steps', s.steps); setSlider('sd-cfg', s.cfgScale); setSlider('sd-width', s.width); setSlider('sd-height', s.height); setSlider('sd-batch', s.batchSize);
      if (s.seed != null) $('sd-seed').value = String(s.seed);
      if (s.enabled && s.endpoint) {
        // Check it really answers right now (the app may have been closed since).
        const r = await call('connect', s.base);
        showFound(r);
        if (r.ok) await loadLists();
      } else {
        hint('Not connected yet. Press ▶ Start (if AutoInjector found Forge / ComfyUI from Stability Matrix), start your SD app yourself and press 🔍 Find my SD app, or install it under ⚙ Start & install. Setup guide: docs/STABLE_DIFFUSION_SETUP.md', 'warn');
      }
    }
    await refreshLibraryData();
    refreshLocks();
    refreshGallery();
    refreshTargets();
  }
  // Keep the dot honest without opening the tab: a cheap status read at start.
  if (api) call('status').then((s) => { if (s && s.ok && s.enabled && s.endpoint && $('sd-tab-dot')) $('sd-tab-dot').dataset.tone = 'ok'; });
})();
