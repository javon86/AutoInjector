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
 *   • the Generate form's collapsible "more settings": Hires fix, Refiner,
 *     img2img / Inpaint (with a mask brush), ControlNet units, ADetailer,
 *     Upscale, Advanced (clip skip, restore faces, tiling, styles, scripts,
 *     override settings, extra fields JSON, read/set any settings-menu option),
 *     ComfyUI workflow picker. All off by default — the plain form is unchanged.
 * Talks only to window.api.sd (preload.js). If that is missing the tab says so.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const api = (window.api && window.api.sd) || null;
  if (!$('images-tab')) return;

  const st = {
    connected: false, status: null, lists: null, loras: [], locks: [], lib: null, libSel: null, lockSel: null,
    chips: [], generating: false, pollTimer: null, lastSeed: null, current: null, libItemsById: new Map(), loaded: false,
    extras: null, i2i: null, maskDirty: false, cnUnits: [], fail: null,
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
    markVaes();
    fillSelect('sd-sampler', l.samplers, s.sampler || '', '(default)');
    fillSelect('sd-scheduler', l.schedulers, s.scheduler || '', '(default)');
    fillSelect('sd-lk-checkpoint', l.checkpoints.map((c) => ({ value: c.name, label: c.title || c.name })), null, '(whatever is chosen)');
    st.loras = l.loras;
    const dl = $('sd-lk-lora-names'); if (dl) { dl.textContent = ''; for (const x of l.loras) { const o = document.createElement('option'); o.value = `${x.alias || x.name}:0.8`; dl.appendChild(o); } }
    fillSelect('sd-rf-checkpoint', l.checkpoints.map((c) => ({ value: c.name, label: c.title || c.name })), null, '(choose)');
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
  $('sd-size-preset').onchange = (e) => { const v = e.target.value; if (!v) return; const [w, h] = v.split('x'); setSlider('sd-width', w); setSlider('sd-height', h); e.target.value = ''; };
  $('sd-checkpoint').onchange = () => { checkCompat(); refreshLibraryData().catch(() => {}); };

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
    setText('sd-ad-note', x.adetailer ? '' : 'ADetailer isn\'t installed in this WebUI (Extensions → Available → ADetailer).');
    const sty = $('sd-adv-styles'); sty.textContent = ''; for (const n of x.styles) { const o = document.createElement('option'); o.value = n; o.textContent = n; sty.appendChild(o); }
    fillSelect('sd-adv-script', x.scripts ? x.scripts.txt2img : [], null, 'None');
    const dl = $('sd-opt-keys'); dl.textContent = ''; for (const k of x.optionKeys) { const o = document.createElement('option'); o.value = k; dl.appendChild(o); }
    fillSelect('sd-wf-pick', x.workflows.map((w) => ({ value: w.id, label: w.name })), null, x.workflows.length ? '(choose)' : '(none saved yet)');
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
    setText('sd-wf-params-list', w ? `Parameters: ${w.params.join(', ') || '(none — use "<node id>.<input>")'}` : '');
  }
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
    const h = rec.hires; $('sd-hr-on').checked = !!h;
    if (h) { if (h.scale != null) $('sd-hr-scale').value = h.scale; if (h.secondPassSteps != null) $('sd-hr-steps').value = h.secondPassSteps; if (h.denoise != null) $('sd-hr-denoise').value = h.denoise; if (h.upscaler && [...$('sd-hr-upscaler').options].some((o) => o.value === h.upscaler)) $('sd-hr-upscaler').value = h.upscaler; }
    $('sd-rf-on').checked = !!(rec.refiner && rec.refiner.checkpoint);
    if (rec.refiner && rec.refiner.checkpoint) { if (![...$('sd-rf-checkpoint').options].some((o) => o.value === rec.refiner.checkpoint)) { const o = document.createElement('option'); o.value = rec.refiner.checkpoint; o.textContent = rec.refiner.checkpoint; $('sd-rf-checkpoint').appendChild(o); } $('sd-rf-checkpoint').value = rec.refiner.checkpoint; if (rec.refiner.switchAt != null) $('sd-rf-switch').value = rec.refiner.switchAt; }
    $('sd-adv-clipskip').value = rec.clipSkip ? String(rec.clipSkip) : '';
    $('sd-adv-restore').checked = !!rec.restoreFaces; $('sd-adv-tiling').checked = !!rec.tiling;
    $('sd-ad-on').checked = !!(rec.adetailer && rec.adetailer.length);
    updateBadges();
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
    if (!isTest && !String(r0.prompt || '').trim() && !r0.characterLock && !r0.initImage) { msg('Type a prompt first.'); $('sd-prompt').focus(); return; }
    if (!st.connected) { msg('Connecting first…'); await find(); if (!st.connected) { msg('No Stable Diffusion app is connected — see the note above.'); return; } }
    const key = settingsKey(r0, isTest);
    if (st.fail && st.fail.count >= 2 && st.fail.key === key) {
      let go = false;
      try { go = window.confirm(`This failed twice with the same error: ${st.fail.message}\n\nTry again anyway?`); } catch (_) { go = false; }
      if (!go) { msg('Not sent — change a setting (or use the fix above) first.'); return; }
    }
    await render(() => (isTest ? call('test') : call(r0.mask ? 'inpaint' : r0.initImage ? 'img2img' : 'generate', r0)), isTest, r0);
  }

  // Run one render call with the busy state / progress, then show the result or the error box.
  async function render(fn, isTest, r0, startText) {
    if (st.generating) return;
    setBusy(true);
    hideError();
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
    msg(`✔ ${r.images.length} picture${r.images.length > 1 ? 's' : ''} saved${isTest ? ' — Stable Diffusion works!' : ''}${r.retried && r.fixed === 'vae-automatic' ? ' — VAE is now Automatic' : ''} (seed ${r.seed})${warn ? `\n${warn}` : ''}`);
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
    const extra = [r.hires ? `hires ×${r.hires.scale || 2}${r.hires.upscaler ? ` ${r.hires.upscaler}` : ''}` : '', r.refiner && r.refiner.checkpoint ? `refiner ${r.refiner.checkpoint}` : '', r.initImage ? (r.mask ? 'inpaint' : `img2img ${r.denoise != null ? r.denoise : ''}`) : '', r.controlnet ? `ControlNet ×${r.controlnet.length}` : '', r.adetailer ? 'ADetailer' : '', r.clipSkip ? `clip skip ${r.clipSkip}` : '', r.kind === 'upscale' ? `upscaled ×${r.factor || 2} ${r.upscaler || ''}` : '', r.kind === 'workflow' ? `workflow ${r.workflowName}` : ''].filter(Boolean);
    if (extra.length) lines.push(extra.join(' · '));
    setText('sd-preview-info', lines.join('\n') || g.name || '');
    for (const b of ['btn-sd-remake', 'btn-sd-variation']) $(b).disabled = !g.record;
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
      im.src = g.url; im.alt = (g.record && g.record.prompt) ? g.record.prompt.slice(0, 80) : g.name; im.title = im.alt; im.tabIndex = 0; im.loading = 'lazy';
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
    if (all && all.ok) { st.lib = all; st.libItemsById = new Map(all.items.map((x) => [x.id, x])); markVaes(); }
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
