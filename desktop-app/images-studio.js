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
 *   • 🧩 Add-ons (sd-addons.js in main): what is installed in Forge / A1111 / SD.Next / ComfyUI, the useful ones
 *     with Install / Update / Remove, install from a GitHub link (after "only install add-ons you trust"),
 *     🔁 Restart Forge now, 📂 choose the app's folder, and its own Extensions page in a window. The #120
 *     "ADetailer … was left out" warning gets a 🧩 Install it button that opens it on that add-on.
 *   • the Generate form's collapsible "more settings": Hires fix, Refiner,
 *     img2img / Inpaint (with a mask brush), ControlNet units, ADetailer,
 *     Upscale, Advanced (clip skip, restore faces, tiling, styles, scripts,
 *     override settings, extra fields JSON, read/set any settings-menu option),
 *     ComfyUI workflow picker. All off by default — the plain form is unchanged.
 *   • Engine: Stable Diffusion / ChatGPT (its own image generation, in its logged-in
 *     pane — chatgpt-image.js) / Auto; "ChatGPT is drawing… 45 s" while it works;
 *   • Reference views: a character lock or a typed appearance → a portrait, any of
 *     the ten full-body views, all ten in one series, or one turnaround sheet
 *     (the same path as Akọwe's POST /image/request).
 *   • PR #128 quality + a compact form (window.sdQuality = sd-quality.js): the checkpoint's model family
 *     (SDXL / SD1.5 / Pony / Flux …) picks the size (Portrait / Square / Landscape map to its own sizes;
 *     Custom shows the exact sliders), steps and CFG (until you move them), the sampler shown for
 *     "(default)" and the default negative prompt; Style chips (Photo-real · Cinematic · Illustration ·
 *     Anime · Painting); a very long prompt gets "📝 Shortened for the model"; 🧩 LoRAs opens a small
 *     LoRA browser (search, All / Fits this model / Recent / ★, cards with preview, base and trigger
 *     words) and chosen LoRAs are rows with a weight slider, 🔑 trigger words and ✕; ⚙ More settings
 *     holds sampler / steps / CFG / batch / seed / VAE / "📖 Book pictures use". Open/closed sections
 *     are remembered (localStorage).
 * Talks only to window.api.sd (preload.js). If that is missing the tab says so.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const api = (window.api && window.api.sd) || null;
  if (!$('images-tab')) return;
  const Q = window.sdQuality || null; // sd-quality.js (absent in old test pages: the form then works as before)
  function lsGet(k, d) { try { const v = window.localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (_) {} }

  const st = {
    connected: false, status: null, lists: null, loras: [], locks: [], lib: null, libSel: null, lockSel: null,
    chips: [], generating: false, pollTimer: null, lastSeed: null, current: null, libItemsById: new Map(), loaded: false,
    extras: null, i2i: null, maskDirty: false, cnUnits: [], fail: null,
    engine: 'sd', jobEngine: 'sd', rvStop: false, rvSeries: '',
    family: '', style: '', aspect: '', short: null, ldFilter: 'all', recent: [], quality: { bookCheckpoint: '' },
  };
  st.style = Q && Q.STYLES[lsGet('sd-style', '')] ? lsGet('sd-style', '') : '';
  st.aspect = ['portrait', 'square', 'landscape', 'custom'].includes(lsGet('sd-aspect', '')) ? lsGet('sd-aspect', '') : '';
  try { st.recent = JSON.parse(lsGet('sd-lora-recent', '[]')).filter((x) => typeof x === 'string').slice(0, 24); } catch (_) { st.recent = []; }

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
    for (const id of ['tab-app-main', 'tab-app-akowe', 'tab-app-video']) if ($(id)) $(id).setAttribute('aria-selected', 'false');
    $('tab-app-images').setAttribute('aria-selected', 'true');
    if ($('akowe-tab')) $('akowe-tab').hidden = true;
    if ($('video-tab')) $('video-tab').hidden = true;
    $('images-tab').hidden = false;
    try { if (window.api && window.api.akoweTab) window.api.akoweTab(false); } catch (_) {}
    if (!st.loaded) { st.loaded = true; init(); }
  }
  function hideTab() { $('images-tab').hidden = true; if ($('tab-app-images')) $('tab-app-images').setAttribute('aria-selected', 'false'); }
  window.sdShowImagesTab = showTab;
  $('tab-app-images').addEventListener('click', showTab);
  for (const id of ['tab-app-main', 'tab-app-akowe', 'tab-app-video']) if ($(id)) $(id).addEventListener('click', () => {
    hideTab();
    if (document.body.dataset.appTab === 'images' && id !== 'tab-app-video') document.body.dataset.appTab = id === 'tab-app-akowe' ? 'akowe' : 'main';
  });

  function subTab(which) {
    for (const w of ['generate', 'library', 'locks', 'setup', 'addons']) {
      if (!$(`sd-sub-${w}`) || !$(`sd-view-${w}`)) continue;
      $(`sd-sub-${w}`).setAttribute('aria-selected', String(w === which));
      $(`sd-view-${w}`).hidden = w !== which;
    }
    if (which === 'addons') addonsRefresh();
    if (which === 'library') refreshLibrary();
    if (which === 'locks') refreshLocks();
    if (which === 'setup') { refreshTargets(); installCheck(); loadOtherServer(); }
  }
  if ($('sd-sub-setup')) $('sd-sub-setup').onclick = () => subTab('setup');
  if ($('sd-sub-addons')) $('sd-sub-addons').onclick = () => { st.aoFocus = null; subTab('addons'); };
  $('sd-sub-generate').onclick = () => subTab('generate');
  $('sd-sub-library').onclick = () => subTab('library');
  $('sd-sub-locks').onclick = () => subTab('locks');

  // ------------------------------------------------------------ connection
  function renderStatus(s, note) {
    st.status = s || st.status;
    const on = !!(s && s.enabled && s.endpoint);
    const was = st.connected;
    st.connected = on;
    // The Engine line under it ("not connected yet…") follows the connection.
    if (was !== on && st.engine) engineNote();
    // Connected but with no picture model (PC test: "Connected ✓" while every picture failed): amber, and said plainly.
    const noModels = !!(on && s && s.noModels);
    const dot = on ? (noModels ? 'warn' : 'ok') : 'off';
    $('sd-dot').dataset.tone = dot; if ($('sd-tab-dot')) $('sd-tab-dot').dataset.tone = dot;
    let port = ''; try { port = s && s.base ? new URL(s.base).port : ''; } catch (_) {}
    const model = s && (s.checkpoint || s.model);
    const who = s ? (s.label || (s.backend === 'comfy' ? 'ComfyUI' : 'Stable Diffusion')) : '';
    const text = noModels && (!note || /^✔/.test(note)) ? `⚠ Connected, but ${who} has no picture model loaded`
      : note || (on ? `✔ Connected to ${who}${port ? ` on :${port}` : ''}${model ? ` — model ${model}` : ''}` : 'Not connected');
    setText('sd-status-text', text);
    $('sd-status').title = text;
    if (s && s.base && !$('sd-url').value) $('sd-url').value = s.base;
  }

  function showFound(r) {
    if (!r) return;
    if (r.ok && r.noModels) {
      // what to do, with the folder the library found the models in, and (when it can) a one-click restart
      hint(`⚠ ${r.message || 'Connected, but it has no picture model loaded.'}\n${r.fix || ''}`.trim(), 'warn');
      renderStatus(r.status);
      showError({ code: 'NO_MODEL', message: r.message, fix: r.fix, actions: (r.help && r.help.actions) || [] }, { isTest: true });
      return;
    }
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
    // Still connected to the one typed in? Then say nothing new was found, but keep the connected line.
    hint(st.connected ? `${d.message} (Still connected to the address above.)` : d.message, st.connected ? 'warn' : 'error');
    renderStatus(st.status, st.connected ? null : '✖ No SD app found');
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
    markVaes();
    fillSelect('sd-sampler', l.samplers, s.sampler || '', '(default)');
    fillSelect('sd-scheduler', l.schedulers, s.scheduler || '', '(default)');
    fillSelect('sd-lk-checkpoint', l.checkpoints.map((c) => ({ value: c.name, label: c.title || c.name })), null, '(whatever is chosen)');
    st.loras = l.loras;
    const dl = $('sd-lk-lora-names'); if (dl) { dl.textContent = ''; for (const x of l.loras) { const o = document.createElement('option'); o.value = `${x.alias || x.name}:0.8`; dl.appendChild(o); } }
    fillSelect('sd-rf-checkpoint', l.checkpoints.map((c) => ({ value: c.name, label: c.title || c.name })), null, '(choose)');
    fillBookSelect();
    bookNote();
    qualityRefresh();
    checkCompat();
    await loadExtras();
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
  $('sd-size-preset').onchange = (e) => { const v = e.target.value; if (!v) return; const [w, h] = v.split('x'); setSlider('sd-width', w); setSlider('sd-height', h); aspectFromSize(w, h); e.target.value = ''; };
  $('sd-checkpoint').onchange = () => { qualityRefresh(); checkCompat(); refreshLibraryData().then(() => qualityRefresh()).catch(() => {}); };
  // ------------------------------------------------------------ quality defaults (sd-quality.js, PR #128)
  // The checkpoint's family → its own sizes, steps / CFG (until the user moves them), the sampler "(default)"
  // stands for, the default negative prompt; the Style chips; the size picker; "📝 Shortened for the model".
  function ckName() { return $('sd-checkpoint').value || (st.status && (st.status.checkpoint || st.status.model)) || (st.lists && st.lists.current && st.lists.current.checkpoint) || ''; }
  function currentFamily() {
    if (!Q) return '';
    const ck = ckName(); if (!ck) return '';
    const it = st.libItemsById.get(libIdOf('checkpoint', ck));
    return Q.familyOf(ck, { base: it && it.base, size: it && it.size });
  }
  function sliderNum(id) { return Number($(id).value); }
  function setAspectButtons() {
    for (const b of document.querySelectorAll('#sd-size-row [data-aspect]')) b.setAttribute('aria-pressed', String(b.dataset.aspect === st.aspect));
    $('sd-size-custom').hidden = st.aspect !== 'custom';
  }
  function setAspect(a, fromUser) {
    if (!Q) return;
    st.aspect = a;
    if (fromUser) lsSet('sd-aspect', a);
    if (a !== 'custom') { const sz = Q.sizeFor(st.family, a); setSlider('sd-width', sz.width); setSlider('sd-height', sz.height); }
    setAspectButtons(); sizeNote();
  }
  // a size put in from outside (Remake, the size list, a lock's "Try it"): the matching button, else Custom
  function aspectFromSize(w, h) {
    if (!Q) return;
    const a = Q.aspectOf(w, h); const sz = Q.sizeFor(st.family, a);
    st.aspect = sz.width === Number(w) && sz.height === Number(h) ? a : 'custom';
    setAspectButtons(); sizeNote();
  }
  function sizeNote() {
    if (!Q) return;
    const w = sliderNum('sd-width'), h = sliderNum('sd-height');
    setText('sd-size-readout', `${w}×${h}`);
    for (const b of document.querySelectorAll('#sd-size-row [data-aspect]')) {
      if (b.dataset.aspect === 'custom') continue;
      const sz = Q.sizeFor(st.family, b.dataset.aspect); b.title = `${sz.width}×${sz.height} — ${Q.familyLabel(st.family)}'s own size`;
    }
    const warn = Q.sizeWarning(st.family, w, h);
    $('sd-size-warn').hidden = !warn; setText('sd-size-warn', warn ? `⚠ ${warn}` : '');
    const sd15 = st.family === 'SD1.5' || st.family === 'SD2';
    $('sd-size-hires-wrap').hidden = !sd15;
    $('sd-size-hires').checked = $('sd-hr-on').checked;
  }
  function familyDefaults() {
    const d = Q.defaultsFor(st.family);
    const pk = st.lists ? Q.pickSampler(st.family, st.lists) : null;
    return { d, pk };
  }
  function moreSummary() {
    if (!Q) return;
    const { pk } = familyDefaults();
    const smp = $('sd-sampler').value || (pk ? `${pk.sampler}${pk.scheduler ? ` · ${pk.scheduler}` : ''}` : 'default sampler');
    const sch = $('sd-sampler').value && $('sd-scheduler').value ? ` · ${$('sd-scheduler').value}` : '';
    const seed = Number($('sd-seed').value) >= 0 ? `seed ${$('sd-seed').value}` : 'random seed';
    const b = sliderNum('sd-batch');
    setText('sd-more-sum', `${smp}${sch} · ${$('sd-steps').value} steps · CFG ${$('sd-cfg').value} · ${seed}${b > 1 ? ` · ×${b}` : ''}`);
    const first = $('sd-sampler').options[0];
    if (first && !first.value) first.textContent = pk ? `(default → ${pk.sampler})` : '(default)';
    const sfirst = $('sd-scheduler').options[0];
    if (sfirst && !sfirst.value) sfirst.textContent = pk && pk.scheduler && !$('sd-sampler').value ? `(default → ${pk.scheduler})` : '(default)';
    const d = Q.defaultsFor(st.family);
    setText('sd-more-note', st.family ? `${Q.familyLabel(st.family)}: about ${d.steps} steps, CFG ${d.cfgScale}${d.distilledCfg ? ` (distilled CFG ${d.distilledCfg} is Forge's own default)` : ''}${pk ? `, ${pk.sampler}${pk.scheduler ? ` + ${pk.scheduler}` : ''}` : ''}.` : 'Pick a checkpoint to get its best settings.');
  }
  function negNote() {
    if (!Q) return;
    const user = $('sd-negative').value.trim();
    const def = Q.defaultNegative(st.family, st.style);
    $('sd-negative').placeholder = def ? `empty = the default: ${def}` : 'Flux ignores the negative prompt';
    setText('sd-neg-preview', user ? user : def ? `default: ${def}` : '(none — Flux ignores it)');
    setText('sd-neg-note', def ? `Empty = the default for ${Q.familyLabel(st.family)}${st.style ? ` + ${Q.STYLES[st.style].label}` : ''}. Your own words replace it${st.style ? ` (the style's terms are still added)` : ''}.` : '');
  }
  function styleButtons() { for (const b of document.querySelectorAll('#sd-style-row [data-style]')) b.setAttribute('aria-pressed', String(b.dataset.style === st.style)); }
  function stepsTouched() { return lsGet('sd-q-touched', '') === '1'; }
  // Called when the checkpoint (or what the library knows about it) changes.
  function qualityRefresh() {
    if (!Q) return;
    const fam = currentFamily();
    const changed = fam !== st.family;
    st.family = fam;
    const badge = $('sd-family');
    badge.hidden = !fam; badge.textContent = fam || ''; if (fam) badge.dataset.base = fam; else delete badge.dataset.base;
    if (!st.aspect) st.aspect = Q.aspectOf(sliderNum('sd-width'), sliderNum('sd-height'));
    if (st.aspect !== 'custom') { const sz = Q.sizeFor(fam, st.aspect); setSlider('sd-width', sz.width); setSlider('sd-height', sz.height); }
    if (changed && !stepsTouched() && st.lists) { const d = Q.defaultsFor(fam); setSlider('sd-steps', d.steps); setSlider('sd-cfg', d.cfgScale); }
    setAspectButtons(); sizeNote(); moreSummary(); negNote();
    if ($('sd-ld-f-match')) $('sd-ld-f-match').textContent = fam ? `Fits ${fam === 'Pony' || fam === 'Illustrious' || fam === 'NoobAI' ? `${fam}/SDXL` : fam}` : 'Fits this model';
    if (!$('sd-lora-drawer').hidden) renderDrawer();
    updateFinalPrompt();
  }
  function promptShortCheck() {
    if (!Q) return;
    const v = $('sd-prompt').value;
    const n = Q.estimateTokens(v);
    const el = $('sd-prompt-tokens');
    el.textContent = v.trim() ? `≈${n} tokens${n > 75 ? ` · ${Math.ceil(n / 75)} chunks` : ''}` : '';
    el.dataset.level = n > 150 ? 'warn' : '';
    const c = n > 150 ? Q.condensePrompt(v, { maxTokens: 150 }) : null;
    st.short = c && c.condensed ? c : null;
    $('sd-prompt-short').hidden = !st.short;
    if (st.short) {
      setText('sd-prompt-short-msg', `📝 Shortened for the model (≈${c.tokensBefore} → ${c.tokensAfter} tokens): the looks first, the story left out.`);
      setText('sd-prompt-short-text', c.prompt);
    }
    updateFinalPrompt();
  }
  let shortTimer = null;
  $('sd-prompt').addEventListener('input', () => { clearTimeout(shortTimer); shortTimer = setTimeout(promptShortCheck, 200); });
  $('btn-sd-prompt-full').onclick = () => {
    const box = $('sd-prompt-short-text'); box.hidden = !box.hidden;
    $('btn-sd-prompt-full').setAttribute('aria-expanded', String(!box.hidden));
    $('btn-sd-prompt-full').textContent = box.hidden ? 'show what is sent' : 'hide';
  };
  $('sd-prompt-short-on').onchange = updateFinalPrompt;
  for (const b of document.querySelectorAll('#sd-style-row [data-style]')) b.onclick = () => {
    st.style = st.style === b.dataset.style ? '' : b.dataset.style;
    lsSet('sd-style', st.style); styleButtons(); negNote(); updateFinalPrompt();
  };
  for (const b of document.querySelectorAll('#sd-size-row [data-aspect]')) b.onclick = () => setAspect(b.dataset.aspect, true);
  $('sd-size-hires').onchange = (e) => {
    $('sd-hr-on').checked = e.target.checked;
    if (e.target.checked && Number($('sd-hr-scale').value) === 2) $('sd-hr-scale').value = '1.5';
    updateBadges();
  };
  $('sd-hr-on').addEventListener('change', () => { if ($('sd-size-hires')) $('sd-size-hires').checked = $('sd-hr-on').checked; });
  for (const id of ['sd-steps', 'sd-cfg']) $(id).addEventListener('input', () => { lsSet('sd-q-touched', '1'); moreSummary(); });
  for (const id of ['sd-batch', 'sd-seed', 'sd-sampler', 'sd-scheduler']) { $(id).addEventListener('input', moreSummary); $(id).addEventListener('change', moreSummary); }
  for (const id of ['sd-width', 'sd-height']) $(id).addEventListener('input', () => { st.aspect = 'custom'; lsSet('sd-aspect', 'custom'); setAspectButtons(); sizeNote(); });
  $('sd-negative').addEventListener('input', negNote);
  // The prompt / negative actually sent: the shortened prompt (when on), the style's words, Pony's score tags.
  function finalPrompt(raw) {
    let prompt = raw;
    let fullPrompt;
    if (Q && st.short && $('sd-prompt-short-on').checked && raw === $('sd-prompt').value) { fullPrompt = raw; prompt = st.short.prompt; }
    if (Q) prompt = Q.applyStyle(prompt, st.style, st.family).prompt;
    return { prompt, fullPrompt };
  }
  function finalNegative() {
    const user = $('sd-negative').value.trim();
    if (!Q) return $('sd-negative').value;
    if (user) return st.style ? Q.mergeTerms(user, Q.STYLES[st.style].negative) : user;
    return Q.defaultNegative(st.family, st.style);
  }
  // Remember which sections are open (Negative, More settings, Hires fix, …).
  for (const d of document.querySelectorAll('#sd-view-generate details[id]')) {
    if (lsGet(`sd-open:${d.id}`, '') === '1') d.open = true;
    d.addEventListener('toggle', () => lsSet(`sd-open:${d.id}`, d.open ? '1' : '0'));
  }
  styleButtons();
  // 📖 Book pictures use: <checkpoint> (Akọwe's pictures; nothing is switched without it)
  async function loadQuality() {
    const r = await call('quality');
    if (r && r.ok) st.quality = { bookCheckpoint: r.bookCheckpoint || '', bookRecipe: r.bookRecipe || '' };
    bookNote();
  }
  // 📖 Book pictures use: <checkpoint or recipe> — the checkpoints, then the recipes (value "recipe:<id>")
  function fillBookSelect() {
    const sel = $('sd-book-checkpoint'); if (!sel) return;
    sel.textContent = '';
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '(whatever is loaded)'; sel.appendChild(o0);
    for (const c of (st.lists && st.lists.checkpoints) || []) { const o = document.createElement('option'); o.value = c.name; o.textContent = c.title || c.name; sel.appendChild(o); }
    if (st.recipes && st.recipes.length) {
      const g = document.createElement('optgroup'); g.label = 'Recipes (all their settings)';
      for (const r of st.recipes) { const o = document.createElement('option'); o.value = `recipe:${r.id}`; o.textContent = `💾 ${r.name}`; g.appendChild(o); }
      sel.appendChild(g);
    }
  }
  function bookNote() {
    const sel = $('sd-book-checkpoint');
    const rid = st.quality.bookRecipe || '';
    const v = rid ? `recipe:${rid}` : (st.quality.bookCheckpoint || '');
    if (v && ![...sel.options].some((o) => o.value === v)) { const o = document.createElement('option'); o.value = v; o.textContent = rid ? `💾 ${rid}` : v; sel.appendChild(o); }
    sel.value = v;
    const rname = rid ? ((st.recipes || []).find((x) => x.id === rid) || { name: rid }).name : '';
    setText('sd-book-note', rid ? `📖 Akọwe's book pictures use the recipe “${rname}” (its model, size, sampler, LoRAs …).` : st.quality.bookCheckpoint ? `📖 Akọwe's book pictures are made with ${st.quality.bookCheckpoint} (a character lock's own checkpoint still wins).` : '📖 Akọwe\'s book pictures use whatever checkpoint is loaded. For realistic portraits pick a realistic checkpoint — or a recipe — here.');
  }
  $('sd-book-checkpoint').onchange = async (e) => {
    const v = e.target.value;
    const r = await call('quality', /^recipe:/.test(v) ? { bookRecipe: v.slice(7) } : { bookCheckpoint: v, bookRecipe: '' });
    if (r && (r.ok || r.bookCheckpoint !== undefined)) st.quality = { bookCheckpoint: r.bookCheckpoint || '', bookRecipe: r.bookRecipe || '' };
    if (r && r.ok === false && r.message) msg(`✖ ${r.message}`);
    bookNote();
  };


  function formRequest() {
    const num = (id) => Number($(id).value);
    // a recipe's prompt template wraps the typed words ({subject})
    const typedRaw = $('sd-prompt').value;
    const fp = finalPrompt(st.recipeTemplate && typedRaw.trim() && /\{subject\}/.test(st.recipeTemplate) ? st.recipeTemplate.replace(/\{subject\}/g, typedRaw.trim()) : typedRaw);
    return {
      prompt: fp.prompt, negativePrompt: finalNegative(), fullPrompt: fp.fullPrompt, style: (Q && st.style) || undefined,
      steps: num('sd-steps'), cfgScale: num('sd-cfg'), width: num('sd-width'), height: num('sd-height'), batchSize: num('sd-batch'),
      seed: Number.isFinite(num('sd-seed')) ? num('sd-seed') : -1,
      checkpoint: $('sd-checkpoint').value, vae: $('sd-vae').value, sampler: $('sd-sampler').value, scheduler: $('sd-scheduler').value,
      loras: st.chips.map((c) => ({ name: c.name, weight: c.weight })),
      characterLock: $('sd-lock-pick').value || undefined,
      // for the picture's sidecar: what was typed, and the LoRA trigger words that are in it
      promptTyped: $('sd-prompt').value, recipeUsed: st.recipeSel || undefined,
      triggers: st.chips.flatMap((c) => c.triggers || []).filter((t) => t && $('sd-prompt').value.toLowerCase().includes(String(t).toLowerCase())),
    };
  }
  // The collapsible sections → advanced request fields. Throws Error(message) on bad JSON.
  function advancedRequest() {
    const num = (id) => { const v = $(id).value; return v === '' ? undefined : Number(v); };
    const json = (id, label, want) => {
      const t = $(id).value.trim(); if (!t) return undefined;
      let v; try { v = JSON.parse(t); } catch (e) { throw new Error(`${label}: that isn't valid JSON (${e.message}).`); }
      if (want === 'array' ? !Array.isArray(v) : (!v || typeof v !== 'object' || Array.isArray(v))) throw new Error(`${label} must be ${want === 'array' ? 'a JSON list [ … ]' : 'a JSON object { … }'}.`);
      return v;
    };
    const a1111 = !st.status || st.status.backend !== 'comfy';
    const out = {};
    if ($('sd-hr-on').checked) out.hires = { scale: num('sd-hr-scale'), upscaler: $('sd-hr-upscaler').value || undefined, secondPassSteps: num('sd-hr-steps'), denoise: num('sd-hr-denoise') };
    if ($('sd-rf-on').checked && $('sd-rf-checkpoint').value) out.refiner = { checkpoint: $('sd-rf-checkpoint').value, switchAt: num('sd-rf-switch') };
    const mode = $('sd-i2i-mode').value;
    if (mode) {
      if (!st.i2i) throw new Error('Choose the start picture first (img2img / Inpaint → Choose file, or Use result).');
      out.initImage = st.i2i.path || st.i2i.dataUrl;
      out.denoise = num('sd-i2i-denoise');
      if ($('sd-i2i-resize').value) out.resizeMode = $('sd-i2i-resize').value;
      if (mode === 'inpaint') {
        if (!st.maskDirty) throw new Error('Brush over the part to repaint first (img2img / Inpaint → the picture).');
        out.mask = maskDataUrl();
        out.inpaint = { fill: $('sd-ip-fill').value, maskBlur: num('sd-ip-blur'), invertMask: $('sd-ip-invert').checked || undefined };
        if ($('sd-ip-only').checked) { out.inpaint.onlyMasked = true; out.inpaint.padding = num('sd-ip-pad'); }
      }
    }
    const units = st.cnUnits.filter((u) => u.image || out.initImage).map((u) => ({ image: u.image ? (u.image.path || u.image.dataUrl) : undefined, module: u.el.querySelector('.cn-module').value || 'none', model: u.el.querySelector('.cn-model').value, weight: Number(u.el.querySelector('.cn-weight').value), guidanceStart: Number(u.el.querySelector('.cn-start').value), guidanceEnd: Number(u.el.querySelector('.cn-end').value), controlMode: u.el.querySelector('.cn-mode').value, pixelPerfect: u.el.querySelector('.cn-pp').checked }));
    if (st.cnUnits.length && units.length < st.cnUnits.length) throw new Error('Each ControlNet unit needs a control picture.');
    if (units.length) out.controlnet = units;
    if (a1111 && $('sd-ad-on').checked) out.adetailer = [{ model: $('sd-ad-model').value, prompt: $('sd-ad-prompt').value || undefined, confidence: num('sd-ad-conf'), denoise: num('sd-ad-denoise') }];
    const cs = num('sd-adv-clipskip'); if (cs && cs > 1) out.clipSkip = cs;
    if (a1111) {
      if ($('sd-adv-restore').checked) out.restoreFaces = true;
      if ($('sd-adv-tiling').checked) out.tiling = true;
      const styles = [...$('sd-adv-styles').selectedOptions].map((o) => o.value); if (styles.length) out.styles = styles;
      if ($('sd-adv-script').value) out.script = { name: $('sd-adv-script').value, args: json('sd-adv-script-args', 'Script args', 'array') || [] };
      const ov = json('sd-adv-override', 'Override settings'); if (ov) out.overrideSettings = ov;
      const ex = json('sd-adv-extra', 'Extra fields'); if (ex) out.extra = ex;
    }
    return out;
  }
  function updateBadges() {
    setText('sd-hr-badge', $('sd-hr-on').checked ? `on ×${$('sd-hr-scale').value}` : '');
    setText('sd-rf-badge', $('sd-rf-on').checked && $('sd-rf-checkpoint').value ? 'on' : '');
    setText('sd-i2i-badge', $('sd-i2i-mode').value ? $('sd-i2i-mode').value : '');
    setText('sd-cn-badge', st.cnUnits.length ? `${st.cnUnits.length} unit${st.cnUnits.length > 1 ? 's' : ''}` : '');
    setText('sd-ad-badge', $('sd-ad-on').checked ? 'on' : '');
    const adv = [$('sd-adv-clipskip').value > 1 ? `clip skip ${$('sd-adv-clipskip').value}` : '', $('sd-adv-restore').checked ? 'faces' : '', $('sd-adv-tiling').checked ? 'tiling' : '', $('sd-adv-styles').selectedOptions.length ? 'styles' : '', $('sd-adv-script').value ? 'script' : '', $('sd-adv-override').value.trim() ? 'override' : '', $('sd-adv-extra').value.trim() ? 'extra' : ''].filter(Boolean);
    setText('sd-adv-badge', adv.join(' · '));
  }
  for (const id of ['sd-hr-on', 'sd-hr-scale', 'sd-rf-on', 'sd-rf-checkpoint', 'sd-ad-on', 'sd-adv-clipskip', 'sd-adv-restore', 'sd-adv-tiling', 'sd-adv-styles', 'sd-adv-script', 'sd-adv-override', 'sd-adv-extra']) { const e = $(id); if (e) { e.addEventListener('change', updateBadges); e.addEventListener('input', updateBadges); } }

  // ------------------------------------------------------------ advanced lists + backend notes
  async function loadExtras() {
    const x = await call('extras');
    if (!x || !x.ok) return;
    st.extras = x;
    const comfy = x.backend === 'comfy';
    for (const e of document.querySelectorAll('#sd-advanced [data-backend]')) e.hidden = e.dataset.backend !== x.backend;
    fillSelect('sd-hr-upscaler', x.upscalers.filter((u) => !/^latent$/i.test(u)), null, 'Latent');
    fillSelect('sd-up-upscaler', comfy ? (x.upscaleModels.length ? x.upscaleModels : ['lanczos']).concat(x.upscaleModels.length ? ['lanczos'] : []) : x.upscaleModels.filter((u) => !/^none$/i.test(u)), null, '(default)');
    if (x.adetailer) fillSelect('sd-ad-model', x.adetailer.models, $('sd-ad-model').value || 'face_yolov8n.pt', '(choose)');
    setText('sd-ad-note', x.adetailer ? '' : 'ADetailer isn\'t installed in this WebUI yet.');
    if ($('btn-sd-ad-install')) $('btn-sd-ad-install').hidden = !!x.adetailer || comfy;
    const sty = $('sd-adv-styles'); sty.textContent = ''; for (const n of x.styles) { const o = document.createElement('option'); o.value = n; o.textContent = n; sty.appendChild(o); }
    fillSelect('sd-adv-script', x.scripts ? x.scripts.txt2img : [], null, 'None');
    const dl = $('sd-opt-keys'); dl.textContent = ''; for (const k of x.optionKeys) { const o = document.createElement('option'); o.value = k; dl.appendChild(o); }
    // Saved workflows + the .json files in "stuff and thing"/workflows (📁; a normal-format one can only be opened in ComfyUI).
    fillSelect('sd-wf-pick', x.workflows.map((w) => ({ value: w.id, label: w.folder ? `📁 ${w.name}${w.ui ? ' (ComfyUI format — open it in ComfyUI)' : w.runnable === false ? ' (not readable)' : ''}` : w.name })), null, x.workflows.length ? '(choose)' : '(none saved yet)');
    const nFolder = x.workflows.filter((w) => w.folder).length;
    setText('sd-wf-folder-note', x.workflowsFolder ? `📁 = a file in "stuff and thing"/workflows (${nFolder} found). Put ComfyUI workflow .json files there.` : '');
    renderWfParams();
    setText('sd-cn-note', x.controlnet ? (comfy && x.controlnet.modules.length <= 1 ? 'ComfyUI: use an already-processed control picture (preprocessor "none"), or install comfyui_controlnet_aux for preprocessors.' : '') : (comfy ? 'This ComfyUI has no ControlNet models (models/controlnet).' : 'ControlNet isn\'t installed in this WebUI (Forge has it built in; A1111: install sd-webui-controlnet).'));
    $('btn-sd-cn-add').disabled = !x.controlnet;
    for (const u of st.cnUnits) fillUnitLists(u);
    setText('sd-i2i-note', comfy ? 'ComfyUI: “only masked” is not available; mask blur grows the mask.' : '');
  }

  // ------------------------------------------------------------ img2img / inpaint + the mask brush
  function setI2i(img) {
    st.i2i = img;
    const im = $('sd-i2i-img');
    $('sd-mask-wrap').hidden = !img;
    if (!img) return;
    im.onload = () => {
      const c = $('sd-mask-canvas');
      c.width = im.naturalWidth || 512; c.height = im.naturalHeight || 512;
      clearMask();
    };
    im.src = img.url || img.dataUrl;
    updateI2iMode();
  }
  function ctx2d() { const c = $('sd-mask-canvas'); try { return c.getContext ? c.getContext('2d') : null; } catch (_) { return null; } }
  function clearMask() { const g = ctx2d(); if (g) g.clearRect(0, 0, $('sd-mask-canvas').width, $('sd-mask-canvas').height); st.maskDirty = false; }
  // White strokes on black, the size of the picture — what A1111 and ComfyUI expect.
  function maskDataUrl() {
    const c = $('sd-mask-canvas');
    const out = document.createElement('canvas'); out.width = c.width; out.height = c.height;
    const g = out.getContext && out.getContext('2d');
    if (!g) return c.toDataURL('image/png');
    g.fillStyle = '#000'; g.fillRect(0, 0, out.width, out.height); g.drawImage(c, 0, 0);
    return out.toDataURL('image/png');
  }
  function updateI2iMode() {
    const m = $('sd-i2i-mode').value;
    $('sd-inpaint-opts').hidden = m !== 'inpaint';
    $('sd-mask-tools').hidden = m !== 'inpaint' || !st.i2i;
    $('sd-mask-canvas').style.display = m === 'inpaint' ? '' : 'none';
    $('btn-sd-generate').textContent = m === 'inpaint' ? '🎨 Inpaint' : m === 'img2img' ? '🎨 Generate (img2img)' : '🎨 Generate';
    updateBadges();
  }
  $('sd-i2i-mode').onchange = updateI2iMode;
  $('btn-sd-i2i-current').onclick = () => { if (st.current && st.current.path) setI2i({ path: st.current.path, url: st.current.url }); else msg('Make or pick a picture first (it shows under Result).'); };
  function readFile(input, cb) {
    const f = input.files && input.files[0]; if (!f) return;
    const fr = new FileReader(); fr.onload = () => cb({ dataUrl: String(fr.result), name: f.name }); fr.readAsDataURL(f);
  }
  $('sd-i2i-file').onchange = (e) => readFile(e.target, (img) => setI2i(img));
  (function brush() {
    const c = $('sd-mask-canvas'); let down = false; let lastPt = null;
    const pt = (e) => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * (c.width / (r.width || 1)), y: (e.clientY - r.top) * (c.height / (r.height || 1)) }; };
    const draw = (p) => {
      const g = ctx2d(); if (!g) return;
      const r = c.getBoundingClientRect();
      const size = Number($('sd-mask-brush').value) * (c.width / (r.width || c.width || 1));
      g.globalCompositeOperation = $('sd-mask-erase').checked ? 'destination-out' : 'source-over';
      g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = size; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); if (lastPt) { g.moveTo(lastPt.x, lastPt.y); g.lineTo(p.x, p.y); g.stroke(); } else { g.arc(p.x, p.y, size / 2, 0, Math.PI * 2); g.fill(); }
      lastPt = p; if (!$('sd-mask-erase').checked) st.maskDirty = true;
    };
    c.addEventListener('pointerdown', (e) => { down = true; lastPt = null; try { c.setPointerCapture(e.pointerId); } catch (_) {} draw(pt(e)); });
    c.addEventListener('pointermove', (e) => { if (down) draw(pt(e)); });
    const up = () => { down = false; lastPt = null; };
    c.addEventListener('pointerup', up); c.addEventListener('pointerleave', up); c.addEventListener('pointercancel', up);
  })();
  $('btn-sd-mask-clear').onclick = clearMask;

  // ------------------------------------------------------------ ControlNet units
  function fillUnitLists(u) {
    const cn = st.extras && st.extras.controlnet;
    const mod = u.el.querySelector('.cn-module'); const mdl = u.el.querySelector('.cn-model');
    const keepM = mod.value; const keepD = mdl.value;
    mod.textContent = ''; for (const n of (cn ? cn.modules : ['none'])) { const o = document.createElement('option'); o.value = n; o.textContent = n; mod.appendChild(o); }
    mdl.textContent = ''; for (const n of (cn ? cn.models : [])) { const o = document.createElement('option'); o.value = n; o.textContent = n; mdl.appendChild(o); }
    if ([...mod.options].some((o) => o.value === keepM)) mod.value = keepM;
    if ([...mdl.options].some((o) => o.value === keepD)) mdl.value = keepD;
    u.el.querySelector('.cn-mode').disabled = !!(st.extras && st.extras.backend === 'comfy');
  }
  function addUnit() {
    const el = document.createElement('div'); el.className = 'sd-cn-unit';
    el.innerHTML = `<div class="sd-row"><input type="file" class="cn-file" accept="image/png,image/jpeg,image/webp" aria-label="Control picture"><button class="sd-fixed cn-current" title="Use the picture under Result">Use result</button><button class="sd-fixed cn-remove" title="Remove this unit" aria-label="Remove this unit">×</button></div>
      <span class="sd-small cn-img">no control picture yet${st.i2i ? ' — img2img picture is used' : ''}</span>
      <div class="sd-row"><div><label class="sd-l">Preprocessor</label><select class="cn-module"></select></div><div><label class="sd-l">Model</label><select class="cn-model"></select></div></div>
      <div class="sd-row"><div><label class="sd-l">Weight</label><input type="number" class="cn-weight" min="0" max="2" step="0.05" value="1"></div><div><label class="sd-l">Start</label><input type="number" class="cn-start" min="0" max="1" step="0.05" value="0"></div><div><label class="sd-l">End</label><input type="number" class="cn-end" min="0" max="1" step="0.05" value="1"></div></div>
      <div class="sd-row"><div><label class="sd-l">Control mode</label><select class="cn-mode"><option>Balanced</option><option>My prompt is more important</option><option>ControlNet is more important</option></select></div><label class="sd-fixed" style="font-size:12px;"><input type="checkbox" class="cn-pp"> Pixel perfect</label></div>`;
    const u = { el, image: null };
    const setImg = (img) => { u.image = img; el.querySelector('.cn-img').textContent = `control picture: ${img.name || (img.path ? img.path.split(/[\\/]/).pop() : 'set')}`; };
    el.querySelector('.cn-file').onchange = (e) => readFile(e.target, setImg);
    el.querySelector('.cn-current').onclick = () => { if (st.current && st.current.path) setImg({ path: st.current.path, name: st.current.path.split(/[\\/]/).pop() }); };
    el.querySelector('.cn-remove').onclick = () => { st.cnUnits = st.cnUnits.filter((x) => x !== u); el.remove(); updateBadges(); };
    st.cnUnits.push(u); $('sd-cn-units').appendChild(el); fillUnitLists(u); updateBadges();
    return u;
  }
  $('btn-sd-cn-add').onclick = () => addUnit();

  // ------------------------------------------------------------ upscale / options / workflows
  $('btn-sd-upscale').onclick = async () => {
    if (!st.current || !st.current.path || st.generating) return;
    setBusy(true); msg('⤢ Upscaling…'); startPolling();
    const r = await call('upscale', { image: st.current.path, upscaler: $('sd-up-upscaler').value || undefined, factor: Number($('sd-up-factor').value) || 2 });
    setBusy(false);
    if (!r || !r.ok) { msg(`✖ ${(r && (r.message + (r.hint ? ` ${r.hint}` : ''))) || 'Upscale failed.'}`); return; }
    msg(`✔ Upscaled picture saved`);
    showImage({ path: r.images[0].path, url: r.images[0].url, record: r.settings });
    refreshGallery();
  };
  function parseValue(t) { const s = String(t).trim(); try { return JSON.parse(s); } catch (_) { return s; } }
  $('btn-sd-opt-get').onclick = async () => {
    const k = $('sd-opt-key').value.trim(); if (!k) { setText('sd-opt-msg', 'Type an option key (the list suggests them).'); return; }
    const r = await call('optionsGet', [k]);
    if (!r || !r.ok) { setText('sd-opt-msg', `✖ ${(r && r.message) || 'failed'} ${(r && r.hint) || ''}`); return; }
    $('sd-opt-value').value = JSON.stringify(r.options[k]); setText('sd-opt-msg', `${k} = ${JSON.stringify(r.options[k])}`);
  };
  $('btn-sd-opt-set').onclick = async () => {
    const k = $('sd-opt-key').value.trim(); if (!k) { setText('sd-opt-msg', 'Type an option key first.'); return; }
    const r = await call('optionsSet', { [k]: parseValue($('sd-opt-value').value) });
    setText('sd-opt-msg', r && r.ok ? `✔ ${k} is now ${$('sd-opt-value').value} (saved in your WebUI's settings)` : `✖ ${(r && r.message) || 'failed'} ${(r && r.hint) || ''}`);
  };
  function renderWfParams() {
    const id = $('sd-wf-pick').value;
    const w = st.extras && st.extras.workflows.find((x) => x.id === id);
    setText('sd-wf-params-list', w ? (w.folder && w.runnable === false ? w.description : `Parameters: ${w.params.join(', ') || '(none — use "<node id>.<input>")'}`) : '');
  }
  if ($('btn-sd-wf-folder')) $('btn-sd-wf-folder').onclick = async () => { const r = await call('openWorkflowsFolder'); if (r && !r.ok) setText('sd-wf-msg', `✖ ${r.message || r.error || 'Could not open the folder.'}`); };
  $('sd-wf-pick').onchange = renderWfParams;
  $('btn-sd-wf-save').onclick = async () => {
    let wf; try { wf = JSON.parse($('sd-wf-json').value); } catch (e) { setText('sd-wf-msg', `✖ That isn't valid JSON (${e.message}).`); return; }
    const r = await call('workflowSave', { name: $('sd-wf-name').value.trim(), workflow: wf });
    if (!r || !r.ok) { setText('sd-wf-msg', `✖ ${(r && r.message) || 'failed'} ${(r && r.hint) || ''}`); return; }
    setText('sd-wf-msg', `✔ Saved “${r.workflow.name}” — parameters: ${r.workflow.params.join(', ')}`);
    $('sd-wf-json').value = '';
    await loadExtras(); $('sd-wf-pick').value = r.workflow.id; renderWfParams();
  };
  $('btn-sd-wf-run').onclick = async () => {
    const id = $('sd-wf-pick').value; if (!id) { setText('sd-wf-msg', 'Choose a saved workflow (or paste one and press Save workflow).'); return; }
    let params = {};
    const t = $('sd-wf-params').value.trim();
    if (t) { try { params = JSON.parse(t); } catch (e) { setText('sd-wf-msg', `✖ Parameters: not valid JSON (${e.message}).`); return; } }
    const w = st.extras && st.extras.workflows.find((x) => x.id === id);
    if (params.prompt == null && $('sd-prompt').value.trim() && w && w.params.includes('prompt')) params.prompt = $('sd-prompt').value.trim();
    if (st.generating) return;
    setBusy(true); msg('▶ Running the workflow…'); startPolling();
    const r = await call('workflowRun', { id, params });
    setBusy(false);
    if (!r || !r.ok) { msg(`✖ ${(r && (r.message + (r.hint ? ` ${r.hint}` : ''))) || 'The workflow failed.'}`); setText('sd-wf-msg', ''); return; }
    msg(`✔ ${r.images.length} picture${r.images.length > 1 ? 's' : ''} saved from the workflow`);
    if (r.images[0]) showImage({ path: r.images[0].path, url: r.images[0].url, record: r.settings });
    refreshGallery();
  };
  function fillForm(rec, keepSeed) {
    if (!rec) return;
    // What was typed comes back (with its style chip and character lock, so the same words are sent again); an old
    // picture without promptTyped: the full description (a shortened prompt is shortened again) or what was sent.
    const lockId = rec.characterLock && rec.characterLock.id && [...$('sd-lock-pick').options].some((o) => o.value === rec.characterLock.id) ? rec.characterLock.id : '';
    const typed = rec.promptTyped != null && (lockId || !rec.characterLock) ? rec.promptTyped : null;
    $('sd-prompt').value = typed != null ? typed : (rec.fullPrompt || rec.prompt || '');
    $('sd-negative').value = rec.negativeAuto ? '' : (rec.negativePrompt || '');
    setSlider('sd-steps', rec.steps); setSlider('sd-cfg', rec.cfgScale); setSlider('sd-width', rec.width); setSlider('sd-height', rec.height);
    if (rec.steps != null || rec.cfgScale != null) lsSet('sd-q-touched', '1');
    if (rec.style && Q && Q.STYLES[rec.style]) { st.style = typed != null ? rec.style : ''; lsSet('sd-style', st.style); styleButtons(); } // typed words: the style chip adds its words again; else they are already in the prompt
    $('sd-seed').value = keepSeed && rec.seed != null ? String(rec.seed) : '-1';
    for (const [sel, v] of [['sd-checkpoint', rec.checkpoint], ['sd-vae', rec.vae], ['sd-sampler', rec.sampler], ['sd-scheduler', rec.scheduler]]) {
      const e = $(sel); if (!e || v == null) continue;
      if (v && ![...e.options].some((o) => o.value === v)) { const o = document.createElement('option'); o.value = v; o.textContent = v; e.appendChild(o); }
      e.value = v || '';
    }
    $('sd-lock-pick').value = typed != null ? lockId : ''; // with the typed words the lock adds its bits again; else they are already inside the recorded prompt
    const h = rec.hires; $('sd-hr-on').checked = !!h;
    if (h) { if (h.scale != null) $('sd-hr-scale').value = h.scale; if (h.secondPassSteps != null) $('sd-hr-steps').value = h.secondPassSteps; if (h.denoise != null) $('sd-hr-denoise').value = h.denoise; if (h.upscaler && [...$('sd-hr-upscaler').options].some((o) => o.value === h.upscaler)) $('sd-hr-upscaler').value = h.upscaler; }
    $('sd-rf-on').checked = !!(rec.refiner && rec.refiner.checkpoint);
    if (rec.refiner && rec.refiner.checkpoint) { if (![...$('sd-rf-checkpoint').options].some((o) => o.value === rec.refiner.checkpoint)) { const o = document.createElement('option'); o.value = rec.refiner.checkpoint; o.textContent = rec.refiner.checkpoint; $('sd-rf-checkpoint').appendChild(o); } $('sd-rf-checkpoint').value = rec.refiner.checkpoint; if (rec.refiner.switchAt != null) $('sd-rf-switch').value = rec.refiner.switchAt; }
    $('sd-adv-clipskip').value = rec.clipSkip ? String(rec.clipSkip) : '';
    $('sd-adv-restore').checked = !!rec.restoreFaces; $('sd-adv-tiling').checked = !!rec.tiling;
    $('sd-ad-on').checked = !!(rec.adetailer && rec.adetailer.length);
    if (rec.adetailer && rec.adetailer[0]) { const u = rec.adetailer[0]; if (u.model) { if (![...$('sd-ad-model').options].some((o) => o.value === u.model)) { const o = document.createElement('option'); o.value = u.model; o.textContent = u.model; $('sd-ad-model').appendChild(o); } $('sd-ad-model').value = u.model; } if (u.confidence != null) $('sd-ad-conf').value = u.confidence; if (u.denoise != null) $('sd-ad-denoise').value = u.denoise; $('sd-ad-prompt').value = u.prompt || ''; }
    updateBadges();
    st.chips = (rec.loras || []).map((l) => {
      const name = String(l.name).replace(/\\/g, '/').split('/').pop().replace(/\.(safetensors|ckpt|pt)$/i, '');
      const it = allLoras().find((x) => x.name.toLowerCase() === name.toLowerCase()) || {};
      return { name, weight: Number(l.weight) || 0.8, triggers: (it.triggerWords || []).filter(Boolean), dataset: (it.datasetTags || []).slice(0, 3), base: it.base || '' };
    });
    renderChips(); checkCompat();
    if (rec.width && rec.height) aspectFromSize(rec.width, rec.height);
    qualityRefresh(); promptShortCheck();
    subTab('generate');
  }

  // ------------------------------------------------------------ LoRA picker
  // Every LoRA we know: the library's (scanned folders — "stuff and thing"/models/lora, Stability Matrix,
  // the SD app's own folder — with previews, base model, trigger words, ★) plus what the SD app lists
  // (its metadata read with sd-quality's loraInfo when the library doesn't have the file).
  function allLoras() {
    const libLoras = st.lib ? st.lib.items.filter((x) => x.kind === 'lora') : [];
    const byId = new Map();
    for (const x of libLoras) byId.set(x.name.toLowerCase(), x);
    for (const l of st.loras || []) {
      const n = String(l.alias || l.name).replace(/\\/g, '/').split('/').pop().replace(/\.(safetensors|ckpt|pt)$/i, '');
      const have = byId.get(n.toLowerCase());
      const info = Q && l.metadata ? Q.loraInfo(l.metadata) : null;
      if (!have) byId.set(n.toLowerCase(), { name: n, kind: 'lora', base: info ? info.base : '', triggerWords: info ? info.triggers : [], datasetTags: info ? info.datasetTags : [], tags: [], collections: [], inBackend: true });
      else if (info && !have.base && info.base) byId.set(n.toLowerCase(), Object.assign({}, have, { base: info.base }));
    }
    return [...byId.values()];
  }
  function loraMatches(x, words) { const hay = [x.name, x.title, x.base, ...(x.tags || []), ...(x.collections || []), ...(x.triggerWords || []), ...(x.datasetTags || [])].join(' ').toLowerCase(); return words.every((w) => hay.includes(w)); }
  function loraCandidates(q) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    let all = allLoras();
    if (words.length) all = all.filter((x) => loraMatches(x, words));
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

  function triggersOf(it) { const t = (it && it.triggerWords || []).filter(Boolean); return t.length ? t : ((it && it.datasetTags) || []).slice(0, 3); }
  function insertWords(words, name) {
    const p = $('sd-prompt');
    const missing = (words || []).filter((t) => t && !p.value.toLowerCase().includes(String(t).toLowerCase()));
    if (missing.length) { p.value = p.value.trim() ? `${p.value.trim().replace(/,\s*$/, '')}, ${missing.join(', ')}` : missing.join(', '); msg(`Added ${name}'s trigger words: ${missing.join(', ')}`); promptShortCheck(); }
    return missing;
  }
  function addChip(it) {
    const name = it.name;
    if (!st.chips.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      const w = it.defaultWeight != null ? Number(it.defaultWeight) : 0.8;
      st.chips.push({ name, weight: Number.isFinite(w) ? w : 0.8, triggers: (it.triggerWords || []).filter(Boolean), dataset: (it.datasetTags || []).slice(0, 3), base: it.base || '' });
      // Put its trigger words in the prompt so the LoRA actually shows up.
      insertWords((it.triggerWords || []).filter(Boolean), name);
      st.recent = [name, ...st.recent.filter((n) => n.toLowerCase() !== name.toLowerCase())].slice(0, 24);
      lsSet('sd-lora-recent', JSON.stringify(st.recent));
    }
    $('sd-lora-search').value = ''; $('sd-lora-list').hidden = true;
    renderChips(); checkCompat();
    if (!$('sd-lora-drawer').hidden) renderDrawer();
  }
  function fmtW(n) { return (Math.round(n * 100) / 100).toFixed(2).replace(/0$/, ''); }
  function renderChips() {
    const box = $('sd-lora-chips');
    box.textContent = '';
    for (const c of st.chips) {
      const chip = document.createElement('div');
      chip.className = 'sd-chip'; chip.dataset.name = c.name; if (c.compat) chip.dataset.compat = c.compat;
      chip.title = c.compatMsg || '';
      const lbl = document.createElement('span'); lbl.className = 'sd-chip-name'; lbl.textContent = `🧩 ${c.name}`; lbl.title = c.name;
      // the weight: a slider −1 … 2 (step 0.05) and its number
      const w = document.createElement('input'); w.type = 'range'; w.step = '0.05'; w.min = '-1'; w.max = '2'; w.value = String(c.weight); w.setAttribute('aria-label', `${c.name} weight`);
      const wv = document.createElement('span'); wv.className = 'sd-chip-w'; wv.textContent = fmtW(c.weight);
      w.oninput = () => { const n = Number(w.value); if (Number.isFinite(n)) { c.weight = n; wv.textContent = fmtW(n); } updateFinalPrompt(); };
      const words = (c.triggers && c.triggers.length ? c.triggers : c.dataset) || [];
      const tb = document.createElement('button'); tb.type = 'button'; tb.textContent = '🔑'; tb.className = 'sd-chip-trig';
      tb.title = words.length ? `Put its trigger words in the prompt: ${words.join(', ')}` : 'No trigger words known for this LoRA'; tb.setAttribute('aria-label', `Insert ${c.name}'s trigger words`);
      tb.hidden = !words.length;
      tb.onclick = () => { if (!insertWords(words, c.name).length) msg(`${c.name}'s trigger words are already in the prompt.`); };
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.title = 'Remove'; x.setAttribute('aria-label', `Remove ${c.name}`);
      x.onclick = () => { st.chips = st.chips.filter((k) => k !== c); renderChips(); checkCompat(); if (!$('sd-lora-drawer').hidden) renderDrawer(); };
      chip.append(lbl, w, wv, tb, x);
      box.appendChild(chip);
    }
    setText('sd-lora-count', st.chips.length ? String(st.chips.length) : '');
    updateFinalPrompt();
  }
  function updateFinalPrompt() {
    const backend = st.status && st.status.backend;
    const lines = [];
    if (Q && $('sd-prompt').value.trim()) {
      const fp = finalPrompt($('sd-prompt').value);
      if (fp.prompt.trim() !== $('sd-prompt').value.trim()) lines.push(`Sent: ${fp.prompt.length > 320 ? `${fp.prompt.slice(0, 320)}…` : fp.prompt}`);
    }
    if (st.chips.length) {
      const tags = st.chips.map((c) => `<lora:${c.name}:${Math.round(c.weight * 100) / 100}>`).join(' ');
      lines.push(backend === 'comfy' ? `ComfyUI gets ${st.chips.length} LoRA loader node(s): ${st.chips.map((c) => `${c.name} ×${c.weight}`).join(', ')}` : `Sent to the WebUI as: … ${tags}`);
    }
    setText('sd-final-prompt', lines.join('\n'));
  }
  async function checkCompat() {
    const box = $('sd-warnings'); if (!box) return;
    box.textContent = '';
    for (const c of st.chips) { delete c.compat; delete c.compatMsg; }
    if (!st.chips.length) { renderChipsFlags(); return; }
    const ck = ckName();
    const r = await call('check', st.chips.map((c) => ({ name: c.name, weight: c.weight })), ck);
    const warned = new Set();
    const show = (name, level, message) => {
      const c = st.chips.find((k) => k.name.toLowerCase() === String(name).toLowerCase());
      if (c) { c.compat = level; c.compatMsg = message; }
      warned.add(String(name).toLowerCase());
      const d = document.createElement('div'); d.className = 'sd-warn'; d.dataset.level = level; d.textContent = `${level === 'hard' ? '⛔' : '⚠'} ${message}`;
      box.appendChild(d);
    };
    if (r && r.ok) for (const w of r.warnings || []) show(w.name, w.level, w.message);
    // what the library didn't know (a LoRA only the SD app lists): its metadata's base against the checkpoint's family
    if (Q && st.family) for (const c of st.chips) {
      if (warned.has(c.name.toLowerCase()) || !c.base) continue;
      const m = Q.baseMatch(c.base, st.family);
      if (m === 'hard') show(c.name, 'hard', `“${c.name}” was made for ${c.base}, but the checkpoint is ${st.family} — it won't work (no effect, garbage, or an error). Pick a ${c.base} checkpoint or a ${st.family} LoRA.`);
    }
    renderChipsFlags();
  }
  function renderChipsFlags() { for (const chip of document.querySelectorAll('#sd-lora-chips .sd-chip')) { const c = st.chips.find((k) => k.name === chip.dataset.name); if (c && c.compat) { chip.dataset.compat = c.compat; chip.title = c.compatMsg || ''; } else { delete chip.dataset.compat; chip.title = ''; } } }

  // ---- 🧩 the LoRA browser (a small drawer under the LoRA row, like the SD app's Lora tab)
  function openDrawer(open) {
    const d = $('sd-lora-drawer');
    d.hidden = !open;
    $('btn-sd-lora-browser').setAttribute('aria-expanded', String(open));
    if (open) { renderDrawer(); try { $('sd-ld-q').focus(); } catch (_) {} }
  }
  $('btn-sd-lora-browser').onclick = () => openDrawer($('sd-lora-drawer').hidden);
  $('btn-sd-ld-close').onclick = () => { openDrawer(false); try { $('btn-sd-lora-browser').focus(); } catch (_) {} };
  $('sd-lora-drawer').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); openDrawer(false); try { $('btn-sd-lora-browser').focus(); } catch (_) {} } });
  let ldTimer = null;
  $('sd-ld-q').addEventListener('input', () => { clearTimeout(ldTimer); ldTimer = setTimeout(renderDrawer, 120); });
  for (const b of document.querySelectorAll('#sd-lora-drawer [data-ldf]')) b.onclick = () => {
    st.ldFilter = b.dataset.ldf;
    for (const x of document.querySelectorAll('#sd-lora-drawer [data-ldf]')) x.setAttribute('aria-pressed', String(x === b));
    renderDrawer();
  };
  $('btn-sd-ld-refresh').onclick = async () => {
    const b = $('btn-sd-ld-refresh'); b.disabled = true; setText('sd-ld-count', 'looking for new LoRAs…');
    if (st.connected) { await call('refresh', 'loras'); await loadLists(); }
    await call('libScan');
    await refreshLibraryData();
    b.disabled = false; renderDrawer();
  };
  function compatOf(it) {
    if (it.compat && it.compat.level && it.compat.level !== 'unknown') return it.compat.level;
    return Q && it.base && st.family ? Q.baseMatch(it.base, st.family) : 'unknown';
  }
  function renderDrawer() {
    const grid = $('sd-ld-grid'); if (!grid) return;
    const words = String($('sd-ld-q').value || '').toLowerCase().split(/\s+/).filter(Boolean);
    let all = allLoras();
    const total = all.length;
    if (words.length) all = all.filter((x) => loraMatches(x, words));
    const f = st.ldFilter;
    if (f === 'match') all = all.filter((x) => ['ok', 'soft'].includes(compatOf(x)));
    if (f === 'fav') all = all.filter((x) => x.favorite);
    if (f === 'recent') { const rank = new Map(st.recent.map((n, i) => [n.toLowerCase(), i])); all = all.filter((x) => rank.has(x.name.toLowerCase())).sort((a, b) => rank.get(a.name.toLowerCase()) - rank.get(b.name.toLowerCase())); }
    else all.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || (compatOf(a) === 'hard' ? 1 : 0) - (compatOf(b) === 'hard' ? 1 : 0) || a.name.localeCompare(b.name));
    grid.textContent = '';
    const added = new Set(st.chips.map((c) => c.name.toLowerCase()));
    for (const it of all.slice(0, 200)) {
      const card = document.createElement('div');
      card.className = 'sd-ldcard'; card.tabIndex = 0; card.setAttribute('role', 'option'); card.dataset.name = it.name;
      const cp = compatOf(it); if (cp !== 'unknown') card.dataset.compat = cp;
      const isAdded = added.has(it.name.toLowerCase()); if (isAdded) card.dataset.added = '1';
      card.setAttribute('aria-selected', String(isAdded));
      const trig = triggersOf(it);
      const initials = it.name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '🧩';
      card.title = `${it.name}${it.base ? ` · ${it.base}` : ''}${cp === 'hard' ? ` · ⛔ not for ${st.family}` : cp === 'soft' ? ' · may look off on this checkpoint' : ''}${trig.length ? `\nTrigger words: ${trig.join(', ')}` : ''}\nClick to add${isAdded ? ' (already added)' : ''}`;
      card.innerHTML = `<div class="sd-ld-thumb">${it.previewUrl ? `<img src="${esc(it.previewUrl)}" alt="" loading="lazy">` : esc(initials)}</div>
        ${it.id ? `<button type="button" class="sd-ld-fav" aria-label="${it.favorite ? 'Remove from' : 'Add to'} favourites" aria-pressed="${it.favorite ? 'true' : 'false'}">${it.favorite ? '★' : '☆'}</button>` : ''}
        <div class="sd-ld-name">${esc(it.name)}</div>
        <div class="sd-ld-meta">${it.base ? `<span class="sd-badge" data-base="${esc(it.base)}">${esc(it.base)}</span>` : '<span class="sd-badge">base ?</span>'}${isAdded ? '<span class="sd-ld-added">✓ added</span>' : ''}</div>
        <div class="sd-ld-trig">${trig.length ? `🔑 ${esc(trig.join(', '))}` : '&nbsp;'}</div>`;
      const fav = card.querySelector('.sd-ld-fav');
      if (fav) fav.onclick = async (e) => { e.stopPropagation(); await call('libUpdate', it.id, { favorite: !it.favorite }); await refreshLibraryData(); renderDrawer(); };
      card.onclick = () => addChip(it);
      card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addChip(it); } };
      grid.appendChild(card);
    }
    const empty = $('sd-ld-empty');
    empty.hidden = all.length > 0;
    if (!all.length) empty.textContent = !total ? 'No LoRAs found yet. Put .safetensors LoRAs in "stuff and thing"/models/lora or your SD app\'s Lora folder, then press ↻.' : f === 'recent' ? 'No LoRAs used yet.' : f === 'fav' ? 'No favourites yet — press ☆ on a card.' : f === 'match' ? `None of your LoRAs is known to fit ${st.family || 'this checkpoint'}.` : 'Nothing matches.';
    setText('sd-ld-count', `${all.length} of ${total}`);
  }

  // ------------------------------------------------------------ generate
  function setBusy(on) {
    st.generating = on;
    $('btn-sd-generate').disabled = on; $('btn-sd-test').disabled = on; $('btn-sd-stop').disabled = !on;
    if (!on) { clearInterval(st.pollTimer); st.pollTimer = null; }
  }
  const CG_PHASE = { checking: 'checking ChatGPT…', waiting: 'waiting for ChatGPT to be free…', 'new-chat': 'opening a new ChatGPT chat…', sending: 'typing the request into ChatGPT…', drawing: 'ChatGPT is drawing…', finishing: 'ChatGPT is finishing the picture…', saving: 'saving the picture…' };
  function chatgptLine(p, prefix) {
    const secs = Math.round(((p && (p.drawingMs || p.elapsedMs)) || 0) / 1000);
    return `🎨 ${prefix || ''}${(p && CG_PHASE[p.phase]) || 'ChatGPT is drawing…'}${secs ? ` ${secs} s` : ''}${p && p.queue ? ` (${p.queue} more waiting)` : ''}`;
  }
  function startPolling() {
    clearInterval(st.pollTimer);
    st.pollTimer = setInterval(async () => {
      if (st.jobEngine === 'chatgpt') {
        const p = await call('chatgptStatus');
        if (!st.generating || !p || !p.busy) return;
        const frac = Math.min(0.95, ((p.drawingMs || 0) / 1000) / 90);
        $('sd-progress-bar').style.width = `${Math.round(frac * 100)}%`;
        msg(chatgptLine(p, st.jobPrefix || ''));
        return;
      }
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
  // ---- failures: a red box with the plain cause, the fix, one-click fix buttons
  // and the server's own words under "details" (sd-errors.js did the reading).
  function hideError() { const b = $('sd-error'); if (b) b.hidden = true; }
  function showError(r, ctx) {
    const b = $('sd-error'); if (!b) return;
    setText('sd-error-msg', `✖ ${(r && r.message) || (r && r.error) || 'Failed.'}`);
    const fix = (r && (r.fix || r.hint)) || '';
    setText('sd-error-fix', fix ? `How to fix: ${fix}` : ''); $('sd-error-fix').hidden = !fix;
    const acts = $('sd-error-actions'); acts.textContent = '';
    // A fix that was just tried (and failed again) is not offered a second time.
    for (const a of (r && r.actions) || []) {
      if (r.retried && r.fixed === a.id) continue;
      const btn = document.createElement('button'); btn.className = 'primary'; btn.dataset.fix = a.id; btn.textContent = a.label || a.id;
      btn.onclick = () => applyFix(a.id, ctx);
      acts.appendChild(btn);
    }
    acts.hidden = !acts.children.length;
    const raw = (r && r.serverError) || '';
    setText('sd-error-raw', raw.slice(0, 600)); $('sd-error-details').hidden = !raw; $('sd-error-details').open = false;
    b.hidden = false;
    try { b.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
  }
  async function applyFix(id, ctx) {
    if (st.generating) return;
    if (id === 'restart-with-models') {
      for (const btn of document.querySelectorAll('#sd-error-actions button')) btn.disabled = true;
      msg('↻ Restarting with your models… (loading a model can take a minute or two)');
      const r = await call('restartWithModels');
      msg(r.ok ? r.message : `✖ ${r.message || 'Could not restart it.'}`);
      for (const btn of document.querySelectorAll('#sd-error-actions button')) btn.disabled = false;
      if (r.ok) { hideError(); hint('', ''); const s = await call('status'); if (s && s.ok) renderStatus(s); await loadLists(); }
      return;
    }
    if (id === 'vae-automatic') { $('sd-vae').value = ''; vaeWarn(); }
    for (const btn of document.querySelectorAll('#sd-error-actions button')) btn.disabled = true;
    const req = ctx && ctx.isTest ? { test: true } : Object.assign({}, (ctx && ctx.req) || {}, id === 'vae-automatic' ? { vae: 'Automatic' } : {});
    await render(() => call('fixAndRetry', id, req), ctx && ctx.isTest, req, '🔧 Fixed — trying again once…');
  }
  // The repeat guard: the same error code twice in a row with the same settings
  // → the next Generate asks first instead of hammering the SD app again.
  function settingsKey(r0, isTest) { try { return isTest ? 'test' : JSON.stringify(r0); } catch (_) { return String(Math.random()); } }
  function noteResult(r, key) {
    if (r && r.ok) { st.fail = null; return; }
    const code = (r && (r.code || r.error)) || 'FAILED';
    if (code === 'CANCELLED') return;
    if (st.fail && st.fail.code === code && st.fail.key === key) { st.fail.count++; st.fail.message = (r && r.message) || code; }
    else st.fail = { code, key, count: 1, message: (r && r.message) || code };
  }

  async function runGenerate(req, isTest) {
    if (st.generating) return;
    let r0 = req || formRequest();
    if (!req && !isTest) {
      try { r0 = Object.assign(r0, advancedRequest()); } catch (e) { msg(`✖ ${e.message}`); return; }
    }
    if (!isTest && !String(req ? r0.prompt || '' : $('sd-prompt').value).trim() && !r0.characterLock && !r0.initImage) { msg('Type a prompt first.'); $('sd-prompt').focus(); return; }
    // ChatGPT (or Auto with no SD app connected): the two-engine path, only the words go to ChatGPT.
    if (!isTest && !req && (st.engine === 'chatgpt' || (st.engine === 'auto' && !st.connected))) {
      const body = { engine: st.engine, prompt: r0.fullPrompt || r0.prompt, characterLock: r0.characterLock };
      st.jobEngine = 'chatgpt'; st.jobPrefix = '';
      await render(() => call('request', body), false, body, st.engine === 'chatgpt' ? '🎨 Asking ChatGPT for the picture… (it usually takes 30–180 s)' : '🎨 No Stable Diffusion app is connected — asking ChatGPT…');
      return;
    }
    st.jobEngine = 'sd';
    if (!st.connected) { msg('Connecting first…'); await find(); if (!st.connected) { msg('No Stable Diffusion app is connected — see the note above.'); return; } }
    const key = settingsKey(r0, isTest);
    if (st.fail && st.fail.count >= 2 && st.fail.key === key) {
      let go = false;
      try { go = window.confirm(`This failed twice with the same error: ${st.fail.message}\n\nTry again anyway?`); } catch (_) { go = false; }
      if (!go) { msg('Not sent — change a setting (or use the fix above) first.'); return; }
    }
    if (!isTest && !req && $('sd-make-best') && $('sd-make-best').checked && !r0.initImage) { await runMakeBest(r0); return; }
    await render(() => (isTest ? call('test') : call(r0.mask ? 'inpaint' : r0.initImage ? 'img2img' : 'generate', r0)), isTest, r0);
  }

  // Run one render call with the busy state / progress, then show the result or the error box.
  async function render(fn, isTest, r0, startText) {
    if (st.generating) return;
    setBusy(true);
    hideError();
    addonLinks(null);
    $('sd-progress-bar').style.width = '0%';
    msg(startText || (isTest ? '🧪 Making a 512×512 test picture… (the first one after starting can take a minute while the model loads)' : '🎨 Making your picture…'));
    startPolling();
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, error: String(e), message: String((e && e.message) || e) }; }
    setBusy(false);
    $('sd-progress-bar').style.width = r && r.ok ? '100%' : '0%';
    noteResult(r, settingsKey(r0, isTest));
    if (!r || !r.ok) {
      if (r && r.error === 'CANCELLED') { msg('Stopped.'); return; }
      msg('✖ The picture failed — see the red box below.');
      showError(r, { req: r0, isTest });
      if (r && (r.error === 'NO_API' || /--api/.test(r.message || ''))) hint(r.message, 'warn');
      return;
    }
    st.lastSeed = r.seed;
    const warn = (r.warnings || []).map((w) => `⚠ ${w.message}`).join('\n');
    const by = r.engine === 'chatgpt' ? ` — drawn by ChatGPT${r.settings && r.settings.seconds ? ` in ${r.settings.seconds} s` : ''}` : ` (seed ${r.seed})`;
    msg(`✔ ${r.images.length} picture${r.images.length > 1 ? 's' : ''} saved${isTest ? ' — Stable Diffusion works!' : ''}${r.retried && r.fixed === 'vae-automatic' ? ' — VAE is now Automatic' : ''}${by}${warn ? `\n${warn}` : ''}`);
    addonLinks(r.warnings);
    if (r.images[0]) showImage({ path: r.images[0].path, url: r.images[0].url, record: Object.assign({}, r.settings, { seed: r.images[0].seed }) });
    refreshGallery();
  }
  $('btn-sd-generate').onclick = () => runGenerate();
  $('sd-prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runGenerate(); } });
  $('btn-sd-stop').onclick = async () => { msg('Stopping…'); st.rvStop = true; if (st.jobEngine !== 'sd') await call('chatgptCancel'); await call('cancel'); };

  // ------------------------------------------------------------ engine choice
  function loadEngine() { let v = 'sd'; try { v = window.localStorage.getItem('sd-engine') || 'sd'; } catch (_) {} return ['sd', 'chatgpt', 'auto'].includes(v) ? v : 'sd'; }
  st.engine = loadEngine();
  if ($('sd-engine')) {
    $('sd-engine').value = st.engine;
    $('sd-engine').onchange = (e) => { st.engine = e.target.value; try { window.localStorage.setItem('sd-engine', st.engine); } catch (_) {} engineNote(); };
  }
  async function engineNote() {
    const n = $('sd-engine-note'); if (!n) return;
    if (st.engine === 'sd') { n.textContent = st.connected ? '' : 'Stable Diffusion is not connected yet (see above) — or choose ChatGPT.'; n.dataset.tone = st.connected ? '' : 'warn'; return; }
    const c = await call('chatgptStatus');
    if (st.engine === 'auto' && st.connected) { n.textContent = 'Auto: Stable Diffusion is connected, so it draws.'; n.dataset.tone = ''; return; }
    if (c && c.ok && c.ready) { n.textContent = c.busy ? chatgptLine(c) : '✔ ChatGPT is ready — pictures take about 30–180 s.'; n.dataset.tone = ''; }
    else { n.textContent = `⚠ ChatGPT can't draw right now: ${(c && (c.why || c.message)) || 'its pane is not ready'}.`; n.dataset.tone = 'warn'; }
    if ($('sd-rv-fresh') && c && c.ok && typeof c.freshChatPerSeries === 'boolean') $('sd-rv-fresh').checked = c.freshChatPerSeries;
  }
  if (api && api.onChatgptImage) api.onChatgptImage(() => { if (!st.generating) engineNote(); });

  // ------------------------------------------------------------ reference views (portrait · 10 views · sheet)
  const RV_VIEWS = ['front', 'three_quarter_front', 'side', 'three_quarter_back', 'back', 'idle', 'draw', 'attack', 'dash', 'defend'];
  const RV_LABEL = { front: 'front', three_quarter_front: '¾ front', side: 'side', three_quarter_back: '¾ back', back: 'back', idle: 'idle', draw: 'draw', attack: 'attack', dash: 'dash', defend: 'defend' };
  function rvBase() {
    const lock = $('sd-rv-lock') ? $('sd-rv-lock').value : '';
    const appearance = $('sd-rv-appearance') ? $('sd-rv-appearance').value.trim() : '';
    return { lock, appearance };
  }
  function rvEngine() { return st.engine === 'sd' ? 'sd' : st.engine === 'chatgpt' ? 'chatgpt' : (st.connected ? 'sd' : 'auto'); }
  function rvBody(purpose, view, extra) {
    const b = rvBase();
    const body = Object.assign({ engine: rvEngine(), purpose }, extra || {});
    if (view) body.view = view;
    if (b.lock) body.characterLock = b.lock;
    if (b.appearance) body.appearance = b.appearance;
    return body;
  }
  function rvReady() {
    const b = rvBase();
    if (!b.lock && !b.appearance) { msg('Choose a character lock or describe what they look like first.'); if ($('sd-rv-appearance')) $('sd-rv-appearance').focus(); return false; }
    if (rvEngine() === 'sd' && !st.connected) { msg('No Stable Diffusion app is connected — connect one above, or choose Engine: ChatGPT.'); return false; }
    return true;
  }
  // One reference picture; resolves with the result (errors go to the red box).
  async function rvOne(body, label, prefix) {
    st.jobEngine = body.engine === 'sd' ? 'sd' : 'chatgpt'; st.jobPrefix = prefix || '';
    let out = null;
    await render(async () => { out = await call('request', body); return out; }, false, body, `🎨 ${prefix || ''}Making the ${label}${body.engine === 'sd' ? '' : ' — ChatGPT usually takes 30–180 s'}…`);
    return out;
  }
  async function rvSingle(purpose, view) {
    if (st.generating || !rvReady()) return;
    const b = rvBase();
    const series = `rv:${b.lock || b.appearance.slice(0, 60)}`;
    const extra = { series };
    if (rvEngine() !== 'sd' && $('sd-rv-fresh') && $('sd-rv-fresh').checked && st.rvSeries !== series) extra.newChat = true;
    st.rvSeries = series;
    await rvOne(rvBody(purpose, view, extra), purpose === 'sheet' ? 'turnaround sheet' : purpose === 'portrait' ? 'portrait' : `${RV_LABEL[view]} view`);
  }
  async function rvAll() {
    if (st.generating || !rvReady()) return;
    st.rvStop = false;
    const b = rvBase();
    const series = `rv:${b.lock || b.appearance.slice(0, 60)}:${Date.now()}`;
    st.rvSeries = series;
    let seed = null; let made = 0;
    for (let i = 0; i < RV_VIEWS.length; i++) {
      if (st.rvStop) { msg(`Stopped after ${made} of ${RV_VIEWS.length} views.`); return; }
      const v = RV_VIEWS[i];
      const extra = { series };
      if (seed != null) { extra.seed = seed; extra.keepSeed = false; }
      if (i === 0 && rvEngine() !== 'sd' && $('sd-rv-fresh') && $('sd-rv-fresh').checked) extra.newChat = true;
      const r = await rvOne(rvBody('view', v, extra), `${RV_LABEL[v]} view`, `View ${i + 1}/${RV_VIEWS.length} (${RV_LABEL[v]}): `);
      if (!r || !r.ok) { if (r && r.error !== 'CANCELLED') msg(`✖ View ${i + 1}/${RV_VIEWS.length} (${RV_LABEL[v]}) failed — see the red box. ${made} saved.`); return; }
      made++;
      if (seed == null && r.engine === 'sd' && Number.isFinite(Number(r.seed))) seed = Number(r.seed);
    }
    msg(`✔ All ${made} reference views saved${seed != null ? ` (one seed: ${seed})` : ' (one ChatGPT conversation)'}.`);
  }
  for (const btn of document.querySelectorAll('#sd-rv-buttons button[data-view]')) btn.onclick = () => rvSingle('view', btn.dataset.view);
  if ($('btn-sd-rv-portrait')) $('btn-sd-rv-portrait').onclick = () => rvSingle('portrait');
  if ($('btn-sd-rv-sheet')) $('btn-sd-rv-sheet').onclick = () => rvSingle('sheet');
  if ($('btn-sd-rv-all')) $('btn-sd-rv-all').onclick = () => rvAll();
  if ($('sd-rv-fresh')) $('sd-rv-fresh').onchange = (e) => { call('chatgptSettings', { freshChatPerSeries: !!e.target.checked }); };

  function showImage(g) {
    st.current = g;
    const img = $('sd-preview');
    img.src = g.url; img.hidden = false;
    $('sd-preview-empty').hidden = true;
    const r = g.record || {};
    const lines = [];
    if (r.prompt) lines.push(r.prompt);
    if (r.negativePrompt) lines.push(`Negative: ${r.negativePrompt}`);
    if (r.fullPrompt) lines.push(`📝 Shortened for the model — the full description is kept in the picture's .json (${r.fullPrompt.length} characters).`);
    const kv = [r.width && r.height ? `${r.width}×${r.height}` : '', r.steps ? `${r.steps} steps` : '', r.cfgScale ? `CFG ${r.cfgScale}` : '', r.sampler ? `${r.sampler}${r.scheduler ? ` ${r.scheduler}` : ''}` : '', r.seed != null ? `seed ${r.seed}` : '', r.label || r.backend || ''].filter(Boolean);
    if (kv.length) lines.push(kv.join(' · '));
    // which checkpoint made it (and its family), always on a line of its own
    if (r.checkpoint || r.family) lines.push(`🧠 ${r.checkpoint ? `model ${r.checkpoint}` : 'model: whatever was loaded'}${r.family ? ` (${r.family})` : ''}${r.bookCheckpoint ? ' — the "Book pictures use" checkpoint' : ''}${r.style && Q && Q.STYLES[r.style] ? ` · style ${Q.STYLES[r.style].label}` : ''}`);
    if (r.loras && r.loras.length) lines.push(`LoRAs: ${r.loras.map((l) => `${l.name} ${l.weight}`).join(', ')}`);
    if (r.characterLock) lines.push(`Character lock: ${r.characterLock.character}`);
    const extra = [r.hires ? `hires ×${r.hires.scale || 2}${r.hires.upscaler ? ` ${r.hires.upscaler}` : ''}` : '', r.refiner && r.refiner.checkpoint ? `refiner ${r.refiner.checkpoint}` : '', r.initImage ? (r.mask ? 'inpaint' : `img2img ${r.denoise != null ? r.denoise : ''}`) : '', r.controlnet ? `ControlNet ×${r.controlnet.length}` : '', r.adetailer ? 'ADetailer' : '', r.clipSkip ? `clip skip ${r.clipSkip}` : '', r.kind === 'upscale' ? `upscaled ×${r.factor || 2} ${r.upscaler || ''}` : '', r.kind === 'workflow' ? `workflow ${r.workflowName}` : ''].filter(Boolean);
    if (extra.length) lines.push(extra.join(' · '));
    setText('sd-preview-info', lines.join('\n') || g.name || '');
    for (const b of ['btn-sd-remake', 'btn-sd-variation']) $(b).disabled = !g.record;
    for (const b of ['btn-sd-judge', 'btn-sd-improve', 'btn-sd-save-recipe']) if ($(b)) $(b).disabled = !g.record || !g.path || st.judging;
    renderUsed(r);
    renderJudge(r.judge || null);
    $('btn-sd-showfile').disabled = !g.path;
    $('btn-sd-upscale').disabled = !g.path;
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
      im.src = g.url; im.alt = (g.record && g.record.prompt) ? g.record.prompt.slice(0, 80) : g.name; im.tabIndex = 0; im.loading = 'lazy';
      const rc = g.record || {};
      im.title = `${im.alt}${rc.checkpoint ? `\n🧠 ${rc.checkpoint}${rc.family ? ` (${rc.family})` : ''}` : ''}${rc.from && /^bridge:|^api:/.test(rc.from) ? `\nasked by ${rc.from.replace(/^bridge:|^api:/, '')}` : ''}`;
      im.onclick = () => showImage(g);
      im.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showImage(g); } };
      box.appendChild(im);
    }
  }

  // ------------------------------------------------------------ library
  // VAE dropdown + the library's header check: files that aren't a full VAE are
  // greyed and labelled; a VAE for another model family gets a ⚠.
  function libIdOf(kind, name) { return `${kind}:${String(name || '').replace(/\\/g, '/').split('/').pop().replace(/\s*\[[0-9a-f]{6,}\]$/i, '').replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, '').toLowerCase()}`; }
  function vaeItem(name) { return name ? st.libItemsById.get(libIdOf('vae', name)) || null : null; }
  function markVaes() {
    const sel = $('sd-vae'); if (!sel) return;
    for (const o of sel.options) {
      if (!o.value) continue;
      if (!o.dataset.name) o.dataset.name = o.textContent;
      const it = vaeItem(o.value);
      delete o.dataset.bad; delete o.dataset.warn;
      let label = o.dataset.name;
      if (it && it.vae && it.vae.full === false) { o.dataset.bad = '1'; label = `⛔ ${o.dataset.name} — not a full VAE`; }
      else if (it && it.compat && (it.compat.level === 'hard' || it.compat.level === 'soft')) { o.dataset.warn = it.compat.level; label = `⚠ ${o.dataset.name} — may not fit this checkpoint`; }
      o.textContent = label;
    }
    vaeWarn();
  }
  function vaeWarn() {
    const w = $('sd-vae-warn'); if (!w) return;
    const it = vaeItem($('sd-vae').value);
    const bad = it && it.vae && it.vae.full === false;
    const m = bad ? `⛔ “${it.name}” can't be used as a VAE: ${it.vae.problem}. Generating will fail — pick Automatic.` : it && it.compat && (it.compat.level === 'hard' || it.compat.level === 'soft') ? `${it.compat.level === 'hard' ? '⛔' : '⚠'} ${it.compat.message}` : '';
    w.textContent = m; w.hidden = !m; w.dataset.level = bad ? 'hard' : (it && it.compat && it.compat.level) || '';
  }
  $('sd-vae').addEventListener('change', vaeWarn);

  async function refreshLibraryData() {
    const f = { q: $('sd-lib-q').value, kind: $('sd-lib-kind').value, base: $('sd-lib-base').value, collection: $('sd-lib-coll').value, favorite: $('sd-lib-fav').checked, checkpoint: $('sd-checkpoint').value || (st.status && st.status.checkpoint) || (st.lists && st.lists.current && st.lists.current.checkpoint) || '' };
    const all = await call('libList', { checkpoint: f.checkpoint });
    if (all && all.ok) { st.lib = all; st.libItemsById = new Map(all.items.map((x) => [x.id, x])); markVaes(); if (st.lists) qualityRefresh(); }
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
        ${it.kind === 'vae' && it.vae && it.vae.full === false ? `<div class="sd-warn" data-level="hard" title="${esc(it.vae.problem)}">⛔ not a full VAE</div>` : it.compat && (it.compat.level === 'hard' || it.compat.level === 'soft') ? `<div class="sd-warn" data-level="${it.compat.level}">${it.compat.level === 'hard' ? '⛔ wrong base for this checkpoint' : '⚠ may look off on this checkpoint'}</div>` : ''}`;
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
    const rv = $('sd-rv-lock');
    if (rv) {
      const rvCur = rv.value; rv.textContent = '';
      const r0 = document.createElement('option'); r0.value = ''; r0.textContent = '— no lock: describe them below —'; rv.appendChild(r0);
      for (const l of st.locks) { const o = document.createElement('option'); o.value = l.id; o.textContent = `${l.character}${l.book ? ` (${l.book})` : ''}`; rv.appendChild(o); }
      rv.value = st.locks.some((l) => l.id === rvCur) ? rvCur : '';
    }
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
    st.lockSel = r.lock.id;
    await refreshLocks(r.lock.id); // (re-selecting it clears the message line, so the ✔ comes after)
    setText('sd-lk-msg', `✔ Saved “${r.lock.character}”.`);
  };
  $('btn-sd-lk-delete').onclick = async () => {
    if (!st.lockSel) { setText('sd-lk-msg', 'Choose a saved lock on the left first.'); return; }
    const l = st.locks.find((x) => x.id === st.lockSel);
    await call('deleteLock', st.lockSel); st.lockSel = null; editLock(null); await refreshLocks();
    setText('sd-lk-msg', `🗑 Deleted${l ? ` “${l.character}”` : ''}.`);
  };
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

  // ------------------------------------------------------------ 🧩 Add-ons (sd-addons.js via main)
  // PR #120: "ADetailer … was left out … install ADetailer" gets a "🧩 Install it" link that opens this panel on it.
  const ADDON_FOR_FIELD = { adetailer: 'adetailer', controlnet: 'controlnet' };
  function addonLinks(warnings) {
    const box = $('sd-msg-addons'); if (!box) return;
    box.textContent = '';
    const ids = [...new Set((warnings || []).filter((w) => w && w.kind === 'skipped' && ADDON_FOR_FIELD[w.field]).map((w) => ADDON_FOR_FIELD[w.field]))];
    for (const id of ids) {
      const b = document.createElement('button');
      b.className = 'sd-fixed sd-ao-link'; b.dataset.addon = id;
      b.textContent = `🧩 Install it (${id === 'adetailer' ? 'ADetailer' : 'ControlNet'})`;
      b.onclick = () => openAddons(id);
      box.appendChild(b);
    }
    box.hidden = !ids.length;
  }
  function openAddons(id) { st.aoFocus = id || null; subTab('addons'); }
  window.sdOpenAddons = openAddons;
  if ($('btn-sd-ad-install')) $('btn-sd-ad-install').onclick = () => openAddons('adetailer');
  function aoMsg(t, tone) { const e = $('sd-ao-msg'); if (!e) return; e.textContent = t || ''; e.dataset.tone = tone || ''; }
  const AO_STATE = { installed: '✔ installed', on: '✔ on', builtin: '✔ built in', restart: '⏳ restart to turn on', off: 'turned off', missing: 'not installed', 'not-for': 'not for this app' };
  function aoButton(label, fn, title) { const b = document.createElement('button'); b.className = 'sd-fixed'; b.textContent = label; if (title) b.title = title; b.onclick = fn; return b; }
  function renderAddons(ov) {
    if (!ov || !ov.ok) { aoMsg((ov && ov.message) || 'Could not read the add-ons.', 'error'); return; }
    st.addons = ov;
    const app = ov.app || 'your SD app';
    setText('sd-ao-app', app);
    const comfy = ov.kind === 'comfy';
    if ($('btn-sd-ao-openpage')) { $('btn-sd-ao-openpage').textContent = comfy ? 'Open ComfyUI (Manager) ↗' : `Open ${app}'s own Extensions page ↗`; $('btn-sd-ao-openpage').disabled = !ov.connected; $('btn-sd-ao-openpage').title = ov.connected ? 'Opens its own page in a window here and switches to its Extensions tab' : 'Connect to your SD app first'; }
    if ($('btn-sd-ao-restart')) $('btn-sd-ao-restart').textContent = `🔁 Restart ${app} now`;
    const where = $('sd-ao-where');
    if (ov.install) {
      where.textContent = `${ov.install.label}'s add-ons folder: ${ov.install.extDir}\n(${ov.install.chosen ? 'the folder you chose' : `found: ${ov.install.source}`}${ov.install.others && ov.install.others.length ? ` — also on this PC: ${ov.install.others.map((o) => o.label).join(', ')}; press 📂 Choose the folder… to use another` : ''})${ov.git ? '' : '\nGit is not on this PC, so add-ons are downloaded as zip files from GitHub instead (Update gets a fresh copy).'}`;
    } else where.textContent = '';
    const np = $('sd-ao-nopath');
    if (np) { np.hidden = !!ov.install; np.textContent = ov.install ? '' : `⚠ ${(ov.help && ov.help.message) || ''}\n${(ov.help && ov.help.fix) || ''}`.trim(); }
    if ($('btn-sd-ao-openfolder')) $('btn-sd-ao-openfolder').hidden = !ov.install;
    if ($('btn-sd-ao-folder')) $('btn-sd-ao-folder').textContent = ov.install ? '📂 Use another folder…' : `📂 Choose ${app}'s folder…`;
    // the curated list
    const cat = $('sd-ao-catalog'); cat.textContent = '';
    for (const c of ov.catalog || []) {
      const row = document.createElement('div'); row.className = 'sd-ao-item'; row.dataset.id = c.id; row.dataset.state = c.state;
      if (st.aoFocus === c.id) row.dataset.focus = '1';
      const main = document.createElement('div'); main.className = 'sd-ao-main';
      const nm = document.createElement('div'); nm.className = 'sd-ao-name'; nm.textContent = c.name;
      const badge = document.createElement('span'); badge.className = 'sd-ao-state'; badge.dataset.state = c.state; badge.textContent = c.state === 'restart' ? `⏳ restart ${app} to turn it on` : (AO_STATE[c.state] || c.state); nm.appendChild(badge);
      const what = document.createElement('div'); what.className = 'sd-ao-what'; what.textContent = c.note ? `${c.what} — ${c.note}` : c.what;
      main.appendChild(nm); main.appendChild(what); row.appendChild(main);
      const btns = document.createElement('div'); btns.className = 'sd-ao-btns';
      if (c.state === 'missing') { const b = aoButton('⬇ Install', () => aoInstall({ id: c.id }, c), `Puts ${c.name} into ${app}'s add-ons folder`); b.dataset.install = c.id; b.disabled = !ov.install || !!ov.busy; btns.appendChild(b); }
      if ((c.state === 'installed' || c.state === 'restart' || c.state === 'off') && c.folder && c.onDisk) { btns.appendChild(aoButton('↻ Update', () => aoUpdate(c.folder))); btns.appendChild(aoButton('🗑 Remove', () => aoRemove(c.folder, c.name))); }
      row.appendChild(btns);
      cat.appendChild(row);
    }
    // everything installed
    const ins = $('sd-ao-installed'); ins.textContent = '';
    if (!(ov.installed || []).length) { const d = document.createElement('div'); d.className = 'sd-small'; d.textContent = ov.install || ov.connected ? 'No add-ons installed yet.' : 'Connect to your SD app, or choose its folder, to see what is installed.'; ins.appendChild(d); }
    for (const it of ov.installed || []) {
      const row = document.createElement('div'); row.className = 'sd-ao-item'; row.dataset.name = it.name; row.dataset.state = it.state;
      const main = document.createElement('div'); main.className = 'sd-ao-main';
      const nm = document.createElement('div'); nm.className = 'sd-ao-name'; nm.textContent = it.title === it.name ? it.name : `${it.title} (${it.name})`;
      const badge = document.createElement('span'); badge.className = 'sd-ao-state'; badge.dataset.state = it.state; badge.textContent = it.state === 'restart' ? `⏳ restart ${app} to turn it on` : (AO_STATE[it.state] || it.state); nm.appendChild(badge);
      const what = document.createElement('div'); what.className = 'sd-ao-what'; what.textContent = it.url || (it.onDisk ? 'installed by hand' : `listed by ${app}`);
      main.appendChild(nm); main.appendChild(what); row.appendChild(main);
      const btns = document.createElement('div'); btns.className = 'sd-ao-btns';
      if (it.canUpdate) btns.appendChild(aoButton('↻ Update', () => aoUpdate(it.name)));
      if (it.canRemove) btns.appendChild(aoButton('🗑 Remove', () => aoRemove(it.name, it.title)));
      row.appendChild(btns);
      ins.appendChild(row);
    }
    aoRestartBox(ov.restartNeeded || st.aoNeedRestart, ov);
    if (st.aoFocus) {
      const f = cat.querySelector(`.sd-ao-item[data-id="${st.aoFocus}"]`);
      if (f) { try { f.scrollIntoView({ block: 'center' }); } catch (_) {} const c = (ov.catalog || []).find((x) => x.id === st.aoFocus); if (c && !st.aoBusy && !$('sd-ao-msg').textContent) aoMsg(c.state === 'missing' ? `${c.name}: press ⬇ Install, then restart ${app}.` : c.state === 'builtin' ? `${c.name}: ${c.note}` : `${c.name}: ${AO_STATE[c.state] || c.state}.`, ''); }
    }
  }
  function aoRestartBox(need, ov) {
    const box = $('sd-ao-restart'); if (!box) return;
    box.hidden = !need;
    const app = (ov && ov.app) || 'Forge';
    setText('sd-ao-restart-note', ov && ov.canRestart ? `AutoInjector started ${app}, so it can restart it for you.` : `${app} was started outside AutoInjector — restart it in Stability Matrix (Stop, then Launch), then press ↻ Check again.`);
    if ($('btn-sd-ao-restart')) $('btn-sd-ao-restart').hidden = !(ov && ov.canRestart);
  }
  async function addonsRefresh() {
    if (!st.aoBusy) aoMsg('Looking at what is installed…', '');
    const ov = await call('addons');
    if (!st.aoBusy) aoMsg('', '');
    renderAddons(ov);
    return ov;
  }
  function aoProgress(p) {
    const bar = $('sd-ao-bar'); const box = $('sd-ao-progress'); if (!bar || !box) return;
    if (!p || p.phase !== 'working') { box.hidden = true; bar.style.width = '0%'; return; }
    box.hidden = false;
    bar.style.width = `${Math.round(Math.max(0.03, Math.min(1, p.pct || 0)) * 100)}%`;
    aoMsg(`${p.op === 'update' ? 'Updating' : p.op === 'remove' ? 'Removing' : 'Installing'} ${p.title || p.name || ''}… ${p.step || ''}${p.pct ? ` ${Math.round(p.pct * 100)}%` : ''}`, '');
  }
  async function aoRun(fn, args, okNote) {
    if (st.aoBusy) { aoMsg('Still working on the last one — one moment.', 'warn'); return null; }
    st.aoBusy = true;
    for (const b of document.querySelectorAll('#sd-view-addons button')) b.disabled = true;
    let r;
    try { r = await call(fn, ...args); } finally { st.aoBusy = false; for (const b of document.querySelectorAll('#sd-view-addons button')) b.disabled = false; aoProgress(null); }
    if (r && r.overview) renderAddons(r.overview); else await addonsRefresh();
    if (r && r.ok) { if (r.restartNeeded) st.aoNeedRestart = true; aoMsg(r.message || okNote || 'Done.', 'ok'); aoRestartBox(st.aoNeedRestart, st.addons); }
    else if (r && r.error !== 'CANCELLED') aoMsg(`✖ ${(r && r.message) || 'It didn\'t work.'}${r && r.fix ? `\n${r.fix}` : ''}`, 'error');
    return r;
  }
  async function aoInstall(what, c) {
    if (c && c.consent && !window.confirm(`${c.name} swaps faces.\n\nOnly use it with pictures of people who agreed — never to fake, embarrass or impersonate anyone.\n\nInstall it?`)) return;
    return aoRun('addonsInstall', [what]);
  }
  async function aoInstallLink() {
    const url = ($('sd-ao-url').value || '').trim();
    if (!url) { aoMsg('Paste the add-on\'s GitHub link first (for example https://github.com/Bing-su/adetailer).', 'warn'); return; }
    const m = url.match(/^https:\/\/(?:www\.)?(github\.com|gitlab\.com)\/([^/\s]+\/[^/\s]+)/i);
    if (!m) { aoMsg('✖ Only https://github.com/… or https://gitlab.com/… links can be installed here.', 'error'); return; }
    if (!window.confirm(`Install the add-on ${m[2].replace(/\.git$/, '')} from ${m[1]}?\n\nOnly install add-ons you trust. An add-on runs inside ${(st.addons && st.addons.app) || 'your SD app'} with full access to your PC and files.`)) return;
    const r = await aoRun('addonsInstall', [{ url }]);
    if (r && r.ok) $('sd-ao-url').value = '';
  }
  async function aoUpdate(name) { return aoRun('addonsUpdate', [name]); }
  async function aoRemove(name, title) {
    if (!window.confirm(`Remove ${title || name}?\n\nIt is moved to the _removed folder next to the add-ons folder — nothing is deleted, so it can be put back.`)) return;
    return aoRun('addonsRemove', [name]);
  }
  if ($('btn-sd-ao-refresh')) $('btn-sd-ao-refresh').onclick = () => { st.aoNeedRestart = false; addonsRefresh(); };
  if ($('btn-sd-ao-url')) $('btn-sd-ao-url').onclick = aoInstallLink;
  if ($('sd-ao-url')) $('sd-ao-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') aoInstallLink(); });
  if ($('btn-sd-ao-folder')) $('btn-sd-ao-folder').onclick = async () => {
    const r = await call('addonsFolder');
    if (r && r.error === 'CANCELLED') return;
    if (r && r.overview) renderAddons(r.overview);
    aoMsg(r && r.ok ? r.message : `✖ ${(r && r.message) || 'That folder can\'t be used.'}`, r && r.ok ? 'ok' : 'error');
  };
  if ($('btn-sd-ao-openfolder')) $('btn-sd-ao-openfolder').onclick = async () => { const r = await call('addonsOpenFolder'); if (r && !r.ok && r.message) aoMsg(r.message, 'error'); };
  if ($('btn-sd-ao-openpage')) $('btn-sd-ao-openpage').onclick = async () => {
    aoMsg('Opening its own page…', '');
    const r = await call('addonsOpenPage');
    aoMsg(r && r.ok ? r.message : `✖ ${(r && r.message) || 'Connect to your SD app first.'}`, r && r.ok ? 'ok' : 'error');
  };
  if ($('btn-sd-ao-restart')) $('btn-sd-ao-restart').onclick = async () => {
    const app = (st.addons && st.addons.app) || 'Forge';
    $('btn-sd-ao-restart').disabled = true;
    aoMsg(`🔁 Restarting ${app}… the first start after an install can take a few minutes while it sets the add-on up.`, '');
    const r = await call('addonsRestart');
    $('btn-sd-ao-restart').disabled = false;
    if (r && r.ok) { st.aoNeedRestart = false; if (r.overview) renderAddons(r.overview); aoMsg(r.message, 'ok'); const s = await call('status'); if (s && s.ok) renderStatus(s); await loadLists(); }
    else aoMsg(`✖ ${(r && r.message) || 'It could not be restarted.'}`, 'error');
  };
  if (api && typeof api.onAddons === 'function') api.onAddons((p) => { if (p && p.phase === 'working') aoProgress(p); });

  // ------------------------------------------------------------ run + install (sd-runner / sd-installer)
  // Start buttons: "Starting…" and disabled while a start (or the wait for the install) runs.
  function runButtons(busy, running, waiting) {
    for (const id of ['btn-sd-run', 'btn-sd-run2']) {
      const b = $(id); if (!b) continue;
      if (!b.dataset.label) b.dataset.label = b.textContent;
      b.textContent = busy ? (waiting ? '⏳ Waiting for the install…' : '⏳ Starting…') : b.dataset.label;
      b.disabled = busy || (id === 'btn-sd-run2' && running);
    }
  }
  function renderRunner(r) {
    if (!r) return;
    st.runner = r;
    const t = r.target;
    const txt = r.phase === 'running' ? (r.message || `✔ ${t ? t.label : 'Stable Diffusion'} running on :${r.port}${r.owned ? ' (managed)' : ''}`)
      : r.phase === 'starting' || r.phase === 'restarting' || r.phase === 'waiting' ? `⏳ ${r.message || 'Starting…'}`
      : r.phase === 'failed' ? `✖ ${r.message || 'Could not start.'}` : r.phase === 'stopped' ? '⏹ Stopped' : 'Not started';
    setText('sd-run-state', txt);
    const waiting = r.phase === 'waiting';
    const busy = r.phase === 'starting' || r.phase === 'restarting' || waiting;
    const running = r.phase === 'running';
    if ($('btn-sd-halt')) $('btn-sd-halt').hidden = !(running && r.owned) && !busy;
    if ($('btn-sd-run') && running) $('btn-sd-run').hidden = true;
    runButtons(busy, running, waiting);
    if ($('btn-sd-halt2')) $('btn-sd-halt2').disabled = !(running || busy);
    // Why it crashed (the important line is in the message), the fix, what it printed, and what to try.
    const showWhy = (r.phase === 'failed' || r.phase === 'restarting') && (r.fix || r.lastOutput);
    if ($('sd-run-why')) { $('sd-run-why').hidden = !(showWhy && r.fix); $('sd-run-why').textContent = showWhy && r.fix ? `How to fix it: ${r.fix}` : ''; }
    if ($('sd-run-tail-box')) { $('sd-run-tail-box').hidden = !(showWhy && r.lastOutput); setText('sd-run-tail', showWhy ? (r.lastOutput || '') : ''); }
    const acts = r.phase === 'failed' && Array.isArray(r.actions) ? r.actions : [];
    const cpuAct = acts.find((a) => a.id === 'sd-start-cpu');
    const otherAct = acts.find((a) => a.id === 'sd-other-build');
    if ($('btn-sd-run-cpu')) { $('btn-sd-run-cpu').hidden = !cpuAct; $('btn-sd-run-cpu').disabled = busy; }
    if ($('btn-sd-other-build')) { $('btn-sd-other-build').hidden = !otherAct; $('btn-sd-other-build').disabled = busy; if (otherAct) $('btn-sd-other-build').textContent = `🔁 ${otherAct.label}`; }
    if ($('sd-run-fixes')) $('sd-run-fixes').hidden = !(cpuAct || otherAct);
    if (busy) renderStatus(st.status, `⏳ ${r.message || 'Starting Stable Diffusion…'}`);
    if (r.phase === 'failed') hint(`${r.message}${r.fix ? ` ${r.fix}` : ''}`, 'error');
    else if (waiting) hint(r.message, 'warn');
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
    const label = pick ? `▶ Start ${pick.label}${pick.kind === 'comfy' ? '' : ' with API'}` : '▶ Start';
    if (b) { b.hidden = !pick || (st.runner && st.runner.phase === 'running') || st.connected; b.dataset.label = label; b.textContent = label; }
    $('btn-sd-run2').dataset.label = label; $('btn-sd-run2').textContent = label;
    $('sd-install-card').dataset.hasTargets = String(r.targets.some((t) => t.supported));
    renderRunner(r.runner);
    if (r.install) renderInstall(r.install);
  }
  // Start (or, with cpu, start on the processor). Pressing it again while it starts does nothing new.
  async function runStart(how) {
    const cur = st.runner && st.runner.phase;
    if (cur === 'starting' || cur === 'restarting' || cur === 'waiting') { hint(cur === 'waiting' ? st.runner.message : 'Stable Diffusion is already starting — one moment.', 'warn'); return; }
    const id = $('sd-run-target').value;
    const cpu = how === 'cpu';
    renderRunner({ phase: 'starting', message: cpu ? 'Starting ComfyUI on the processor… slow, but works on any PC.' : 'Starting Stable Diffusion… the first start can take several minutes.' });
    const r = cpu ? await call('startCpu', id) : await call('start', id);
    if (r && r.runner) renderRunner(r.runner);
    if (r && r.ok) { hint('', ''); const s = await call('status'); renderStatus(s); await loadLists(); }
    else if (r && r.waiting) hint(r.message, 'warn');
    else if (r && r.message) hint(`${r.message}${r.fix && !(r.runner && r.runner.fix) ? ` ${r.fix}` : ''}`, 'error');
  }
  async function useOtherBuild() {
    if ($('btn-sd-other-build')) $('btn-sd-other-build').disabled = true;
    hint('Switching to the other ComfyUI build… (it is downloaded first if it isn\'t there yet; your models are shared)', 'warn');
    const r = await call('useOtherBuild');
    if (r && r.runner) renderRunner(r.runner);
    if (r && r.ok) { hint('', ''); await refreshTargets(); const s = await call('status'); renderStatus(s); await loadLists(); }
    else hint((r && r.message) || 'Could not switch the ComfyUI build.', 'error');
    if ($('btn-sd-other-build')) $('btn-sd-other-build').disabled = false;
  }
  function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(1)} GB` : '?'; }
  function renderInstall(i) {
    if (!i) return;
    const pct = Math.round((i.pct || 0) * 100);
    $('sd-install-bar').style.width = `${i.busy || i.phase === 'installed' ? pct : 0}%`;
    if ($('sd-install-progress')) $('sd-install-progress').hidden = !(i.busy || (i.phase === 'installed' && pct > 0)); // no empty bar while idle
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
  if ($('btn-sd-run')) $('btn-sd-run').onclick = () => runStart();
  if ($('btn-sd-run2')) $('btn-sd-run2').onclick = () => runStart();
  if ($('btn-sd-run-cpu')) $('btn-sd-run-cpu').onclick = () => runStart('cpu');
  if ($('btn-sd-other-build')) $('btn-sd-other-build').onclick = useOtherBuild;
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
    $('btn-sd-install').disabled = true; $('btn-sd-install-cancel').disabled = false; $('sd-install-progress').hidden = false;
    const r = await call('install', {});
    setText('sd-install-msg', r && r.ok ? (r.already ? '✔ ComfyUI is already installed.' : `✔ ComfyUI is installed${r.verified ? ' (checksum verified)' : ''}. Now pick a starter model below, then press Start.`) : `✖ ${(r && r.message) || 'Install failed.'}`);
    await installCheck(); await refreshTargets();
  };
  if ($('btn-sd-install-cancel')) $('btn-sd-install-cancel').onclick = () => call('installCancel');
  if ($('btn-sd-install-folder')) $('btn-sd-install-folder').onclick = () => call('openInstallFolder');
  if ($('btn-sd-model')) $('btn-sd-model').onclick = async () => {
    const id = (document.querySelector('input[name="sd-model"]:checked') || {}).value || 'sd15';
    $('btn-sd-install-cancel').disabled = false; $('sd-install-progress').hidden = false;
    const r = await call('installModel', id);
    setText('sd-install-msg', r && r.ok ? `✔ Model ready. Press ▶ Start, then Generate.` : `✖ ${(r && r.message) || 'Download failed.'}`);
    $('btn-sd-install-cancel').disabled = true;
  };
  if (api && api.onRunner) api.onRunner((r) => renderRunner(r));
  if (api && api.onInstall) api.onInstall((i) => { st.installState = i; renderInstall(i); });
  if (api && api.onConnected) api.onConnected((r) => { if (r && r.status) renderStatus(r.status, r.ok ? `✔ ${r.message || 'Connected'}` : null); if (r && r.ok && st.loaded) loadLists(); });

  // ------------------------------------------------------------ start
  // ------------------------------------------------------------ ⚙ Advanced: another server
  // (moved here from the old Image Generation panel): a list of common addresses, 🔍 auto-detect,
  // "✓ Check it answers" and the on/off switch — the same image:configure / endpoints:* calls.
  const wapi = () => window.api || {};
  function epMsg(t) { setText('sd-ep-msg', t || ''); }
  let presetsLoaded = false;
  async function loadOtherServer() {
    const w = wapi();
    if (!presetsLoaded && typeof w.endpointPresets === 'function') {
      presetsLoaded = true;
      try {
        const r = await w.endpointPresets('image');
        if (r && r.ok) for (const p of r.presets) { const o = document.createElement('option'); o.value = p.endpoint; o.textContent = p.label; $('sd-ep-preset').appendChild(o); }
      } catch (_) {}
    }
    if (typeof w.imageStatus === 'function') {
      try { const s = await w.imageStatus(); if (s) { $('sd-ep-enabled').checked = !!s.enabled; if (!$('sd-ep-url').value) $('sd-ep-url').value = s.endpoint || ''; } } catch (_) {}
    }
  }
  if ($('sd-adv-server')) {
    $('sd-ep-preset').onchange = () => { const v = $('sd-ep-preset').value; if (v) { $('sd-ep-url').value = v; epMsg('Filled in — press ✓ Check it answers, then Save.'); } };
    $('btn-sd-ep-detect').onclick = async () => {
      const w = wapi(); if (typeof w.detectEndpoints !== 'function') return;
      epMsg('🔍 Looking on this PC…');
      let r; try { r = await w.detectEndpoints('image'); } catch (_) { r = null; }
      const reach = (r && r.reachable) || [];
      if (!reach.length) { epMsg('Nothing found running. Start your Stable Diffusion app with its API on (--api), or pick one from the list.'); return; }
      $('sd-ep-url').value = reach[0].endpoint; $('sd-ep-preset').value = reach[0].endpoint;
      epMsg(`Found: ${reach[0].label} ✓ — press Save.${reach.length > 1 ? ` (+${reach.length - 1} more)` : ''}`);
    };
    $('btn-sd-ep-test').onclick = async () => {
      const w = wapi(); if (typeof w.testEndpoint !== 'function') return;
      const url = $('sd-ep-url').value.trim();
      if (!url) { epMsg('Type an address or pick one from the list first.'); return; }
      epMsg('Checking…');
      let r; try { r = await w.testEndpoint(url); } catch (_) { r = null; }
      epMsg(r && r.reachable ? 'It answers ✓ — press Save to use it.' : 'No answer — is the app running with its API turned on (--api)? Check the address.');
    };
    $('btn-sd-ep-save').onclick = async () => {
      const w = wapi(); if (typeof w.configureImage !== 'function') return;
      let r; try { r = await w.configureImage({ enabled: $('sd-ep-enabled').checked, endpoint: $('sd-ep-url').value.trim() }); } catch (e) { r = { ok: false, message: String(e) }; }
      epMsg(r && r.ok ? (r.enabled ? 'Saved — image generation is on with this address.' : 'Saved — image generation is off.') : `✖ ${(r && (r.message || r.error)) || 'Not saved.'} Try again.`);
      if (r && r.ok) { const s = await call('status'); if (s && s.ok) renderStatus(s); }
    };
  }

  // ------------------------------------------------------------ 💾 recipes · 🧑‍⚖️ AI judge · 🔁 Make it better (PR #TBD)
  // A recipe = saved settings (sd-recipes.js in main). The picker at the top loads one into the form; 💾 saves the
  // form; ✏ / 🗑 / ⭐ rename, delete, make default (loaded when the tab opens). Every picture shows "Settings used"
  // (window.sdRecord = sd-record.js) and has 🧑‍⚖️ Judge, 🔁 Make it better and 💾 Save as recipe.
  const R = window.sdRecord || null;
  st.recipes = []; st.recipeSel = ''; st.recipeTemplate = ''; st.defaultRecipe = ''; st.judging = false; st.nameMode = null; st.strip = null; st.judgeSet = null;
  function recipeNote(t, tone) { const e = $('sd-recipe-note'); if (!e) return; e.hidden = !t; e.textContent = t || ''; e.dataset.tone = tone || ''; }
  async function loadRecipes(first) {
    const r = await call('recipes', 'list');
    if (!r || !r.ok || !Array.isArray(r.recipes)) { st.recipes = []; renderRecipeSelect(); return; }
    st.recipes = r.recipes; st.defaultRecipe = r.defaultId || '';
    renderRecipeSelect(); fillBookSelect(); bookNote();
    if (first && st.defaultRecipe && !st.recipeSel) await useRecipe(st.defaultRecipe, true);
  }
  function renderRecipeSelect() {
    const sel = $('sd-recipe'); if (!sel) return;
    sel.textContent = '';
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '— my own settings —'; sel.appendChild(o0);
    for (const [label, list] of [['My recipes', st.recipes.filter((x) => !x.starter)], ['Starter recipes (a good beginning)', st.recipes.filter((x) => x.starter)]]) {
      if (!list.length) continue;
      const g = document.createElement('optgroup'); g.label = label;
      for (const x of list) { const o = document.createElement('option'); o.value = x.id; o.textContent = `${x.id === st.defaultRecipe ? '⭐ ' : ''}${x.name}`; o.title = [x.description, x.short].filter(Boolean).join(' — '); g.appendChild(o); }
      sel.appendChild(g);
    }
    sel.value = st.recipes.some((x) => x.id === st.recipeSel) ? st.recipeSel : '';
    const cur = st.recipes.find((x) => x.id === sel.value);
    $('btn-sd-recipe-rename').disabled = !cur || cur.starter;
    $('btn-sd-recipe-delete').disabled = !cur;
    $('btn-sd-recipe-default').disabled = !cur;
    $('btn-sd-recipe-default').setAttribute('aria-pressed', String(!!cur && cur.id === st.defaultRecipe));
  }
  async function useRecipe(id, quiet) {
    const r = await call('recipes', 'get', { id });
    if (!r || !r.ok) { recipeNote(`✖ ${(r && r.message) || 'That recipe could not be loaded.'}`, 'warn'); return; }
    applyFormPatch(Object.assign({}, r.recipe.settings, { recipeId: r.recipe.id }), 'recipe');
    st.recipeSel = r.recipe.id; st.recipeTemplate = r.recipe.promptTemplate || '';
    renderRecipeSelect();
    const fam = r.recipe.family; const now = st.family;
    const mismatch = fam && now && !r.recipe.settings.checkpoint && fam !== now ? ` ⚠ It is made for ${fam} checkpoints, but ${now} is loaded — choose a ${fam} checkpoint above.` : '';
    recipeNote(`${quiet ? '⭐ Default recipe: ' : '✔ Loaded '}“${r.recipe.name}”.${st.recipeTemplate ? ` Your words go into its template: ${st.recipeTemplate}` : ''}${mismatch}`, mismatch ? 'warn' : '');
  }
  $('sd-recipe').onchange = (e) => { const v = e.target.value; if (!v) { st.recipeSel = ''; st.recipeTemplate = ''; renderRecipeSelect(); recipeNote(''); return; } useRecipe(v); };
  // The settings in the form → a recipe's settings (no prompt text: the typed negative only when it isn't the automatic one).
  function formSettings() {
    const f = formRequest();
    let adv = {}; try { adv = advancedRequest(); } catch (_) { adv = {}; }
    const neg = $('sd-negative').value.trim();
    return {
      checkpoint: f.checkpoint || undefined, vae: f.vae || undefined, sampler: f.sampler || undefined, scheduler: f.scheduler || undefined,
      steps: f.steps, cfgScale: f.cfgScale, width: f.width, height: f.height, style: st.style || undefined,
      negativeMode: neg ? 'replace' : 'auto', negativePrompt: neg || undefined, loras: f.loras,
      hires: adv.hires, refiner: adv.refiner, adetailer: adv.adetailer, clipSkip: adv.clipSkip, restoreFaces: adv.restoreFaces,
    };
  }
  function openNameRow(kind, extra) {
    st.nameMode = Object.assign({ kind }, extra || {});
    $('sd-recipe-name-row').hidden = false;
    const cur = st.recipes.find((x) => x.id === st.recipeSel);
    $('sd-recipe-name').value = kind === 'rename' && cur ? cur.name : (extra && extra.name) || '';
    $('sd-recipe-template').hidden = kind === 'rename';
    $('sd-recipe-template').value = kind === 'save' ? st.recipeTemplate : '';
    $('btn-sd-recipe-name-ok').textContent = kind === 'rename' ? 'Rename' : 'Save';
    try { $('sd-recipe-name').focus(); } catch (_) {}
    recipeNote(kind === 'rename' ? 'Type the new name.' : kind === 'save' ? 'Name these settings (model, size, sampler, steps, CFG, LoRAs, hires fix …). The prompt is not saved — only the template, if you type one.' : 'Name these settings — the picture\'s model, size, sampler, steps, CFG and LoRAs.');
  }
  function closeNameRow() { st.nameMode = null; $('sd-recipe-name-row').hidden = true; }
  $('btn-sd-recipe-save').onclick = () => openNameRow('save', { name: st.family ? `${st.family} — ${st.style && Q ? Q.STYLES[st.style].label : 'my settings'}` : '' });
  $('btn-sd-recipe-rename').onclick = () => { if (st.recipeSel) openNameRow('rename'); };
  $('btn-sd-recipe-name-cancel').onclick = () => { closeNameRow(); recipeNote(''); };
  $('sd-recipe-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('btn-sd-recipe-name-ok').click(); } else if (e.key === 'Escape') $('btn-sd-recipe-name-cancel').click(); });
  $('btn-sd-recipe-name-ok').onclick = async () => {
    const m = st.nameMode; if (!m) return;
    const name = $('sd-recipe-name').value.trim();
    if (!name) { recipeNote('Type a name first.', 'warn'); return; }
    let r;
    if (m.kind === 'rename') r = await call('recipes', 'rename', { id: st.recipeSel, name });
    else if (m.kind === 'picture') r = await call('recipes', 'fromPicture', { path: m.path, name });
    else r = await call('recipes', 'save', { recipe: { name, settings: formSettings(), promptTemplate: $('sd-recipe-template').value.trim() || undefined, replace: true } });
    if (!r || !r.ok) { recipeNote(`✖ ${(r && r.message) || 'It could not be saved.'}`, 'warn'); return; }
    closeNameRow();
    st.recipeSel = r.recipe.id; st.recipeTemplate = r.recipe.promptTemplate || '';
    await loadRecipes(false);
    recipeNote(`✔ ${m.kind === 'rename' ? 'Renamed to' : 'Saved the recipe'} “${r.recipe.name}”. Pick it in Recipe to use these settings again.`);
  };
  $('btn-sd-recipe-delete').onclick = async () => {
    const cur = st.recipes.find((x) => x.id === st.recipeSel); if (!cur) return;
    let go = false; try { go = window.confirm(cur.starter ? `Hide the starter recipe “${cur.name}”?` : `Delete the recipe “${cur.name}”? Pictures made with it keep their settings.`); } catch (_) { go = true; }
    if (!go) return;
    const r = await call('recipes', 'delete', { id: cur.id });
    if (!r || !r.ok) { recipeNote(`✖ ${(r && r.message) || 'It could not be deleted.'}`, 'warn'); return; }
    st.recipeSel = ''; st.recipeTemplate = '';
    await loadRecipes(false);
    recipeNote(`🗑 ${r.starterHidden ? 'Hid' : 'Deleted'} “${cur.name}”.`);
  };
  $('btn-sd-recipe-default').onclick = async () => {
    const cur = st.recipes.find((x) => x.id === st.recipeSel); if (!cur) return;
    const off = cur.id === st.defaultRecipe;
    const r = await call('recipes', 'setDefault', { id: off ? '' : cur.id });
    if (!r || !r.ok) { recipeNote(`✖ ${(r && r.message) || 'It could not be set.'}`, 'warn'); return; }
    await loadRecipes(false);
    recipeNote(off ? `No default recipe now.` : `⭐ “${cur.name}” is the default: it is loaded when the Images tab opens.`);
  };

  // ---- the form as one object: applied from a recipe or by 🎩 Alfred (sd-form-apply), read by Alfred (sd:form-report)
  function selectValue(id, v) {
    const e = $(id); if (!e || v == null) return;
    if (v && ![...e.options].some((o) => o.value === v)) { const o = document.createElement('option'); o.value = v; o.textContent = v; e.appendChild(o); }
    e.value = v || '';
  }
  function applyFormPatch(p0, how) {
    const p = p0 || {};
    const done = [];
    if (p.engine && $('sd-engine') && ['sd', 'chatgpt', 'auto'].includes(p.engine)) { $('sd-engine').value = p.engine; st.engine = p.engine; lsSet('sd-engine', p.engine); engineNote(); done.push('engine'); }
    if (p.checkpoint !== undefined) { selectValue('sd-checkpoint', p.checkpoint || ''); qualityRefresh(); checkCompat(); done.push('checkpoint'); }
    if (p.prompt !== undefined) { $('sd-prompt').value = String(p.prompt || ''); promptShortCheck(); done.push('prompt'); }
    if (p.negativeMode === 'auto' || p.negativeMode === 'none') { $('sd-negative').value = ''; done.push('negative (automatic)'); }
    if (p.negativePrompt !== undefined && p.negativeMode !== 'auto') { $('sd-negative').value = String(p.negativePrompt || ''); done.push('negative'); }
    if (p.style !== undefined && (!p.style || (Q && Q.STYLES[p.style]))) { st.style = p.style || ''; lsSet('sd-style', st.style); styleButtons(); done.push('style'); }
    else if (how === 'recipe' && p.style === undefined) { st.style = ''; styleButtons(); }
    if (p.aspect && ['portrait', 'square', 'landscape', 'custom'].includes(p.aspect)) { setAspect(p.aspect, true); done.push('size'); }
    if (p.width != null || p.height != null) { setSlider('sd-width', p.width != null ? p.width : $('sd-width').value); setSlider('sd-height', p.height != null ? p.height : $('sd-height').value); aspectFromSize($('sd-width').value, $('sd-height').value); lsSet('sd-aspect', st.aspect); done.push('size'); }
    for (const [k, id] of [['vae', 'sd-vae'], ['sampler', 'sd-sampler'], ['scheduler', 'sd-scheduler']]) if (p[k] !== undefined) { selectValue(id, p[k] || ''); done.push(k); }
    else if (how === 'recipe' && k !== 'vae') selectValue(id, '');
    if (p.steps != null) { setSlider('sd-steps', p.steps); lsSet('sd-q-touched', '1'); done.push('steps'); }
    if (p.cfgScale != null) { setSlider('sd-cfg', p.cfgScale); lsSet('sd-q-touched', '1'); done.push('CFG'); }
    if (p.batchSize != null) { setSlider('sd-batch', p.batchSize); done.push('batch'); }
    if (p.seed != null) { $('sd-seed').value = String(p.seed); done.push('seed'); }
    if (p.characterLock !== undefined) { selectValue('sd-lock-pick', p.characterLock || ''); done.push('character'); }
    if (Array.isArray(p.loras) || (how === 'recipe' && !p.loras)) {
      st.chips = (p.loras || []).filter((l) => l && l.name).map((l) => {
        const name = String(l.name).replace(/\\/g, '/').split('/').pop().replace(/\.(safetensors|ckpt|pt)$/i, '');
        const it = allLoras().find((x) => x.name.toLowerCase() === name.toLowerCase()) || {};
        return { name, weight: Number.isFinite(Number(l.weight)) ? Number(l.weight) : 0.8, triggers: (it.triggerWords || []).filter(Boolean), dataset: (it.datasetTags || []).slice(0, 3), base: it.base || '' };
      });
      renderChips(); checkCompat(); if (Array.isArray(p.loras)) done.push('LoRAs');
    }
    if (p.hires !== undefined || how === 'recipe') {
      const h = p.hires; $('sd-hr-on').checked = !!h;
      if (h) { if (h.scale != null) $('sd-hr-scale').value = h.scale; if (h.secondPassSteps != null) $('sd-hr-steps').value = h.secondPassSteps; if (h.denoise != null) $('sd-hr-denoise').value = h.denoise; if (h.upscaler) selectValue('sd-hr-upscaler', h.upscaler); }
      if (p.hires !== undefined) done.push('hires fix');
    }
    if (p.refiner !== undefined || how === 'recipe') {
      const rf = p.refiner; $('sd-rf-on').checked = !!(rf && rf.checkpoint);
      if (rf && rf.checkpoint) { selectValue('sd-rf-checkpoint', rf.checkpoint); if (rf.switchAt != null) $('sd-rf-switch').value = rf.switchAt; }
      if (p.refiner !== undefined) done.push('refiner');
    }
    if (p.adetailer !== undefined || how === 'recipe') {
      const u = Array.isArray(p.adetailer) ? p.adetailer[0] : null; $('sd-ad-on').checked = !!u;
      if (u) { if (u.model) selectValue('sd-ad-model', u.model); if (u.confidence != null) $('sd-ad-conf').value = u.confidence; if (u.denoise != null) $('sd-ad-denoise').value = u.denoise; $('sd-ad-prompt').value = u.prompt || ''; }
      if (p.adetailer !== undefined) done.push('ADetailer');
    }
    if (p.clipSkip !== undefined || how === 'recipe') { $('sd-adv-clipskip').value = p.clipSkip > 1 ? String(p.clipSkip) : ''; if (p.clipSkip !== undefined) done.push('CLIP skip'); }
    if (p.restoreFaces !== undefined) { $('sd-adv-restore').checked = !!p.restoreFaces; done.push('restore faces'); }
    if (p.tiling !== undefined) { $('sd-adv-tiling').checked = !!p.tiling; done.push('tiling'); }
    if (p.makeBest !== undefined && $('sd-make-best')) { $('sd-make-best').checked = !!p.makeBest; done.push('make 4, pick the best'); }
    if (p.recipeId !== undefined && how !== 'recipe') { st.recipeSel = p.recipeId || ''; renderRecipeSelect(); }
    updateBadges(); qualityRefresh(); promptShortCheck(); moreSummary(); negNote();
    subTab('generate');
    reportForm();
    return done;
  }
  function formSnapshot() {
    const f = formRequest();
    let adv = {}; try { adv = advancedRequest(); } catch (_) { adv = {}; }
    delete adv.initImage; delete adv.mask; delete adv.controlnet;
    return Object.assign({}, f, adv, { prompt: $('sd-prompt').value, negativePrompt: $('sd-negative').value, negativeSent: f.negativePrompt, promptSent: f.prompt, aspect: st.aspect, family: st.family, engine: st.engine, makeBest: !!($('sd-make-best') && $('sd-make-best').checked), recipe: st.recipeSel || '', triggers: undefined, promptTyped: undefined });
  }
  let reportTimer = null;
  function reportForm() { clearTimeout(reportTimer); reportTimer = setTimeout(() => { try { call('formReport', formSnapshot()); } catch (_) {} }, 400); }
  for (const ev of ['input', 'change']) $('sd-form').addEventListener(ev, () => reportForm());
  if (api && typeof api.onFormApply === 'function') api.onFormApply((ev) => {
    if (!ev || !ev.patch) return;
    if (!st.loaded) { st.loaded = true; init().then(() => applyFromAlfred(ev)); return; }
    applyFromAlfred(ev);
  });
  function applyFromAlfred(ev) {
    if (ev.how === 'recipe' && ev.patch.recipeId) { useRecipe(ev.patch.recipeId).then(() => msg(`🎩 Alfred loaded the recipe “${ev.patch.recipeName || ev.patch.recipeId}” into the form — press Generate when you're ready.`)); return; }
    const done = applyFormPatch(ev.patch, ev.how);
    msg(`🎩 Alfred changed the form: ${done.join(', ') || 'nothing'} — press Generate when you're ready.`);
  }

  // ---- Settings used (every setting in plain words) and the judge's verdict
  function renderUsed(rec) {
    const dl = $('sd-used-list'); if (!dl) return;
    dl.textContent = '';
    const rows = R && rec ? R.settingsUsed(rec) : [];
    $('sd-used').hidden = !rows.length;
    for (const row of rows) { const dt = document.createElement('dt'); dt.textContent = row.label; const dd = document.createElement('dd'); dd.textContent = row.value; dl.append(dt, dd); }
  }
  const SCORE_WORDS = { prompt: 'Matches the prompt', quality: 'Realism / style', anatomy: 'Hands, faces, eyes, limbs', artifacts: 'No blur, noise, text, extra limbs', composition: 'Composition and light', character: 'Looks like the character' };
  const VERDICT_WORDS = { keep: '✔ Keep it', fix: '🔧 Good start — fix it', redo: '↺ Make it again' };
  function fixWords(f) {
    const w = { steps: () => `steps ${f.delta > 0 ? '+' : ''}${f.delta != null ? f.delta : f.value}`, cfg: () => `CFG ${f.delta > 0 ? '+' : ''}${f.delta != null ? f.delta : f.value}`, sampler: () => `sampler ${f.name}`, scheduler: () => `scheduler ${f.name}`, size: () => `${f.aspect || 'its own'} size`, hires: () => `hires fix ${f.on === false ? 'off' : 'on'}`, adetailer: () => `fix the ${f.target || 'face'} (ADetailer)`, negative_add: () => `avoid: ${(f.terms || []).join(', ')}`, lora_weight: () => `LoRA ${f.name} → ${f.weight}`, checkpoint: () => `use ${f.name}`, seed: () => 'another seed', img2img: () => 'redo it lightly', inpaint: () => `repaint the ${f.region || 'region'}` };
    return `${(w[f.type] || (() => f.type))()}${f.why ? ` — ${f.why}` : ''}`;
  }
  function renderJudge(j) {
    const box = $('sd-judge-box'); if (!box) return;
    if (!j || !j.scores) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false; box.textContent = '';
    const head = document.createElement('div');
    const v = document.createElement('span'); v.className = 'sd-jv'; v.dataset.v = j.verdict; v.textContent = `${VERDICT_WORDS[j.verdict] || j.verdict} · ${j.overall}/10`;
    head.appendChild(v);
    const by = document.createElement('div'); by.className = 'sd-jby'; by.textContent = `🧑‍⚖️ judged by ${j.byLabel || j.by}${j.weaker ? ' (a local model — weaker)' : ''}${j.seconds ? ` in ${j.seconds} s` : ''}${j.selfConflict ? ' · its verdict didn\'t match its own scores, so the scores decided' : ''}`;
    head.appendChild(by); box.appendChild(head);
    const sc = document.createElement('div'); sc.className = 'sd-jscores';
    for (const k of Object.keys(SCORE_WORDS)) {
      const n = j.scores[k]; if (typeof n !== 'number') continue;
      const l = document.createElement('span'); l.textContent = SCORE_WORDS[k];
      const bar = document.createElement('span'); bar.className = 'sd-jbar'; const i = document.createElement('i'); i.style.width = `${n * 10}%`; bar.appendChild(i);
      const nv = document.createElement('span'); nv.textContent = String(n);
      sc.append(l, bar, nv);
    }
    box.appendChild(sc);
    for (const [label, list] of [['Good', j.good], ['Not so good', j.bad], ['What to change', (j.fixes || []).map(fixWords).concat(j.promptEdits && j.promptEdits.add && j.promptEdits.add.length ? [`add to the prompt: ${j.promptEdits.add.join(', ')}`] : [], j.promptEdits && j.promptEdits.remove && j.promptEdits.remove.length ? [`take out: ${j.promptEdits.remove.join(', ')}`] : [])]]) {
      if (!list || !list.length) continue;
      const b = document.createElement('b'); b.textContent = label; box.appendChild(b);
      const ul = document.createElement('ul'); ul.className = 'sd-jlist';
      for (const t of list.slice(0, 8)) { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }
      box.appendChild(ul);
    }
  }
  function judgeButtons() { const has = !!(st.current && st.current.record && st.current.path); for (const b of ['btn-sd-judge', 'btn-sd-improve', 'btn-sd-save-recipe']) if ($(b)) $(b).disabled = !has || st.judging; }
  async function judgeCurrent() {
    const g = st.current; if (!g || !g.path || st.judging) return;
    st.judging = true; judgeButtons(); setBusy(true);
    msg('🧑‍⚖️ Asking the AI judge to look at the picture… (uses one AI answer; Claude Code takes about 20–60 s)');
    const r = await call('judge', g.path);
    st.judging = false; setBusy(false); judgeButtons();
    if (!r || !r.ok) { msg(`✖ ${(r && r.message) || 'The judge could not answer.'}${r && r.hint ? `\n${r.hint}` : ''}`); return; }
    g.record = Object.assign({}, g.record, { judge: r.judge });
    renderJudge(r.judge); renderUsed(g.record);
    msg(`🧑‍⚖️ ${r.say}`);
  }
  $('btn-sd-judge').onclick = judgeCurrent;
  $('btn-sd-save-recipe').onclick = () => { if (st.current && st.current.path) openNameRow('picture', { path: st.current.path, name: R && st.current.record ? '' : '' }); };

  // ---- 🔁 Make it better / Make 4 and pick the best: a strip of rounds with scores
  function stripMsg(t) { setText('sd-improve-msg', t || ''); }
  function renderStrip() {
    const box = $('sd-improve-strip'); if (!box || !st.strip) return;
    box.textContent = '';
    st.strip.items.forEach((it, i) => {
      const c = document.createElement('div'); c.className = 'sd-round'; c.setAttribute('role', 'option'); c.tabIndex = 0;
      c.dataset.best = String(i === st.strip.best ? 1 : 0); c.setAttribute('aria-selected', String(i === st.strip.sel));
      if (it.url) { const im = document.createElement('img'); im.src = it.url; im.alt = `${st.strip.kind === 'best' ? 'Picture' : 'Round'} ${it.label}`; c.appendChild(im); }
      const s1 = document.createElement('div'); s1.className = 'sd-rs';
      s1.textContent = `${st.strip.kind === 'best' ? 'Picture' : 'Round'} ${it.label}: ${it.overall != null ? `${it.overall}/10` : it.error ? '✖' : '…'}${it.verdict ? ` ${it.verdict === 'keep' ? '✔' : it.verdict === 'redo' ? '↺' : '🔧'}` : ''}${i === st.strip.best ? ' ★ best' : ''}`;
      const s2 = document.createElement('div'); s2.className = 'sd-rc';
      s2.textContent = it.error ? it.error : it.changed && it.changed.length ? `changed: ${it.changed.join('; ')}` : st.strip.kind === 'best' ? `seed ${it.seed != null ? it.seed : '?'}` : 'the start';
      c.append(s1, s2);
      const pick = () => { st.strip.sel = i; renderStrip(); if (it.path) showImage({ path: it.path, url: it.url, record: Object.assign({}, it.record || {}, it.judge ? { judge: it.judge } : {}) }); };
      c.onclick = pick; c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
      box.appendChild(c);
    });
    $('sd-improve-actions').hidden = !st.strip.done || !st.strip.items.some((x) => x.path);
  }
  function openStrip(kind, items) {
    st.strip = { kind, items: items || [], best: -1, sel: -1, done: false };
    $('sd-improve-box').hidden = false; $('btn-sd-improve-stop').hidden = false;
    renderStrip();
  }
  if (api && typeof api.onJudge === 'function') api.onJudge((e) => {
    if (!e || !st.strip || e.kind !== st.strip.kind) return;
    if (e.kind === 'improve') {
      if (e.phase === 'making') stripMsg(`🔁 Round ${e.round} of ${e.rounds}: making the picture again${e.changed && e.changed.length ? ` (${e.changed.slice(0, 3).join('; ')})` : ''}…`);
      else if (e.phase === 'judging') stripMsg(`🧑‍⚖️ Round ${e.round} of ${e.rounds}: the judge is looking…`);
      else if (e.phase === 'judged' && e.result) {
        const it = { label: e.result.round, path: e.result.path, url: e.result.url, overall: e.result.overall, verdict: e.result.verdict, changed: e.result.changed, judge: e.result.judge, seed: e.result.seed, error: e.result.error };
        const k = st.strip.items.findIndex((x) => x.label === it.label); if (k >= 0) st.strip.items[k] = it; else st.strip.items.push(it);
        renderStrip();
      }
    } else if (e.kind === 'best') {
      if (e.phase === 'making') stripMsg(`🎨 Making ${e.count} pictures with different seeds…`);
      else if (e.phase === 'judging') stripMsg(`🧑‍⚖️ The judge is looking at picture ${e.index + 1} of ${e.count}…`);
    }
  });
  async function improveCurrent() {
    const g = st.current; if (!g || !g.path || st.judging) return;
    const rounds = Number($('sd-judge-rounds') && $('sd-judge-rounds').value) || 3;
    st.judging = true; judgeButtons(); setBusy(true);
    openStrip('improve', []);
    stripMsg(`🧑‍⚖️ Round 1 of ${rounds}: the judge is looking at this picture… (each round uses one AI answer; your defaults are not changed)`);
    msg('🔁 Making it better…');
    const r = await call('improve', g.path, rounds);
    st.judging = false; setBusy(false); judgeButtons(); $('btn-sd-improve-stop').hidden = true;
    if (!r || !r.ok) { stripMsg(`✖ ${(r && r.message) || 'It could not run.'}`); msg(`✖ ${(r && r.message) || 'Make it better could not run.'}`); if (r && r.rounds && r.rounds.length) { st.strip.items = r.rounds.map((x) => ({ label: x.round, path: x.path, url: x.url, overall: x.overall, verdict: x.verdict, changed: x.changed, judge: x.judge, error: x.error })); st.strip.done = true; renderStrip(); } return; }
    st.strip.items = r.rounds.map((x) => ({ label: x.round, path: x.path, url: x.url, overall: x.overall, verdict: x.verdict, changed: x.changed, judge: x.judge, seed: x.seed, error: x.error }));
    st.strip.best = r.best; st.strip.sel = r.best; st.strip.done = true;
    renderStrip();
    stripMsg(`🔁 ${r.say} Pick a round to see it.`);
    msg(`🔁 ${r.say}`);
    const b = r.rounds[r.best];
    if (b && b.path) showImage({ path: b.path, url: b.url, record: Object.assign({}, b.judge ? { judge: b.judge } : {}) });
    refreshGallery();
    if (b && b.path) { const rr = await call('record', b.path); if (rr && rr.ok && st.current && st.current.path === b.path) { st.current.record = rr.record; renderUsed(rr.record); renderJudge(rr.record.judge); judgeButtons(); } }
  }
  $('btn-sd-improve').onclick = improveCurrent;
  $('btn-sd-improve-stop').onclick = async () => { stripMsg('Stopping…'); await call('improveStop'); };
  $('btn-sd-improve-keep').onclick = () => {
    if (!st.strip) return;
    const it = st.strip.items[st.strip.sel >= 0 ? st.strip.sel : st.strip.best]; if (!it || !it.path) return;
    call('record', it.path).then((rr) => { showImage({ path: it.path, url: it.url, record: rr && rr.ok ? rr.record : (it.judge ? { judge: it.judge } : null) }); msg(`✔ Kept ${st.strip.kind === 'best' ? 'picture' : 'round'} ${it.label} — it is the result now (the others stay in the gallery).`); });
  };
  $('btn-sd-improve-recipe').onclick = () => {
    if (!st.strip) return;
    const it = st.strip.items[st.strip.sel >= 0 ? st.strip.sel : st.strip.best]; if (!it || !it.path) return;
    openNameRow('picture', { path: it.path });
  };
  async function runMakeBest(r0) {
    if (st.judging) return;
    st.judging = true; judgeButtons(); setBusy(true); hideError();
    openStrip('best', []);
    stripMsg('🎨 Making 4 pictures with different seeds, then the judge looks at each (4 AI answers)…');
    msg('🎨 Making 4 and picking the best…');
    const req = Object.assign({}, r0); delete req.batchSize;
    const r = await call('makeBest', req, 4);
    st.judging = false; setBusy(false); judgeButtons(); $('btn-sd-improve-stop').hidden = true;
    if (!r || !r.ok) { stripMsg(`✖ ${(r && r.message) || 'It could not run.'}`); msg('✖ The pictures failed — see the red box below.'); showError(r, { req: r0 }); return; }
    st.strip.items = r.images.map((x, i) => ({ label: i + 1, path: x.path, url: x.url, overall: x.overall, verdict: x.judge && x.judge.verdict, judge: x.judge, seed: x.seed, error: x.error }));
    st.strip.best = r.best; st.strip.sel = r.best >= 0 ? r.best : 0; st.strip.done = true;
    renderStrip();
    stripMsg(r.say); msg(`✔ ${r.say}`);
    const b = r.images[r.best >= 0 ? r.best : 0];
    if (b) { const rr = await call('record', b.path); showImage({ path: b.path, url: b.url, record: rr && rr.ok ? rr.record : null }); }
    refreshGallery();
  }
  $('btn-sd-stop').addEventListener('click', () => { if (st.judging) call('improveStop'); });

  // ---- 🧑‍⚖️ judge settings: order, on/off, which pane, rounds, pass mark, book pictures
  const JUDGE_LABEL = { 'claude-code': 'Claude Code (on this PC)', pane: 'Web AI pane (Claude / ChatGPT)', local: 'Local vision model (Ollama, offline — weaker)' };
  async function loadJudgeSettings() {
    const r = await call('judgeSettings');
    if (!r || !r.ok || !Array.isArray(r.order)) { if ($('sd-sec-judge')) $('sd-sec-judge').hidden = !!(r && r.error === 'NO_API'); return; }
    st.judgeSet = r; renderJudgeSettings();
  }
  function renderJudgeSettings() {
    const s = st.judgeSet; const box = $('sd-judge-order'); if (!s || !box || !Array.isArray(s.order)) return;
    s.enabled = s.enabled || {};
    box.textContent = '';
    s.order.forEach((id, i) => {
      const row = document.createElement('div'); row.className = 'sd-row'; row.setAttribute('role', 'listitem');
      const lab = document.createElement('label'); lab.className = 'sd-fixed';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = s.enabled[id] !== false; cb.dataset.judge = id;
      cb.onchange = () => saveJudge({ enabled: { [id]: cb.checked } });
      lab.append(cb, document.createTextNode(` ${i + 1}. ${JUDGE_LABEL[id]}`));
      row.appendChild(lab);
      if (i > 0) { const up = document.createElement('button'); up.type = 'button'; up.className = 'sd-mini'; up.textContent = '▲'; up.title = 'Try this one earlier'; up.setAttribute('aria-label', `Move ${JUDGE_LABEL[id]} up`); up.onclick = () => { const o = s.order.slice(); o.splice(i, 1); o.splice(i - 1, 0, id); saveJudge({ order: o }); }; row.appendChild(up); }
      box.appendChild(row);
    });
    $('sd-judge-pane').value = s.paneSite || 'claude';
    $('sd-judge-rounds').value = s.rounds; $('sd-judge-bar').value = s.bar; $('sd-judge-autobook').checked = !!s.autoBook; if ($('sd-judge-attachcheck')) $('sd-judge-attachcheck').checked = s.attachCheck !== false;
    setText('sd-judge-badge', `${s.order.filter((x) => s.enabled[x] !== false).length} on${s.autoBook ? ' · book pictures' : ''}`);
  }
  async function saveJudge(patch) { const r = await call('judgeSettings', patch); if (r && r.ok && Array.isArray(r.order)) { st.judgeSet = r; renderJudgeSettings(); judgeStatusLine(); } }
  $('sd-judge-pane').onchange = (e) => saveJudge({ paneSite: e.target.value });
  $('sd-judge-rounds').onchange = (e) => saveJudge({ rounds: Number(e.target.value) });
  $('sd-judge-bar').onchange = (e) => saveJudge({ bar: Number(e.target.value) });
  $('sd-judge-autobook').onchange = (e) => saveJudge({ autoBook: !!e.target.checked });
  if ($('sd-judge-attachcheck')) $('sd-judge-attachcheck').onchange = (e) => saveJudge({ attachCheck: !!e.target.checked });
  async function judgeStatusLine() {
    const r = await call('judgeStatus');
    if (!r || !r.ok || !r.judges) { setText('sd-judge-status', ''); return; }
    const parts = Object.entries(r.judges).map(([id, j]) => `${j.ok ? '✔' : '✖'} ${JUDGE_LABEL[id].split(' (')[0]}${j.ok ? '' : `: ${j.why || j.state}`}`);
    setText('sd-judge-status', `${r.next ? `Next judge: ${r.nextLabel}.` : 'No judge is ready right now.'}\n${parts.join('\n')}`);
  }
  if ($('sd-sec-judge')) $('sd-sec-judge').addEventListener('toggle', () => { if ($('sd-sec-judge').open) { loadJudgeSettings(); judgeStatusLine(); } });
  async function init() {
    if (!api) { hint('The Images tab needs a newer AutoInjector (preload is missing window.api.sd). Restart the app.', 'error'); return; }
    const s = await call('status');
    await loadQuality();
    if (s && s.ok) {
      renderStatus(s);
      setSlider('sd-steps', s.steps); setSlider('sd-cfg', s.cfgScale); setSlider('sd-width', s.width); setSlider('sd-height', s.height); setSlider('sd-batch', s.batchSize);
      qualityRefresh();
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
    qualityRefresh(); promptShortCheck();
    refreshLocks();
    refreshGallery();
    refreshTargets();
    engineNote();
    await loadRecipes(true);
    loadJudgeSettings();
    reportForm();
  }
  // Keep the dot honest without opening the tab: a cheap status read at start.
  if (api) call('status').then((s) => { if (s && s.ok && s.enabled && s.endpoint && $('sd-tab-dot')) $('sd-tab-dot').dataset.tone = s.noModels ? 'warn' : 'ok'; });
})();
