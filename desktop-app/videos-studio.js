'use strict';
/*
 * videos-studio.js — the 🎬 Video tab in the control panel (the engine is video-studio.js in main).
 *   • status bar: "✔ Ready: ComfyUI … with Wan 2.2 5B" / what is missing, in plain words;
 *   • 🎬 Make video: Text → video or Picture → video (drop / choose a picture, or pick one from
 *     the 🎨 gallery), prompt, negative, character lock, purpose, model, every Wan setting
 *     (seconds, fps, size, steps, CFG, shift, sampler, scheduler, seed), Make / Stop with the
 *     seconds so far, the red error box (cause + fix + what ComfyUI said), a <video> player
 *     with the poster, and the gallery of saved videos;
 *   • ⚙ Setup & models: install / start ComfyUI, download each model (size, graphics memory,
 *     progress, pause), settings, a 1-second test, and "Advanced: other video server" (the
 *     old text-to-video endpoint).
 * Talks only to window.api.video (+ window.api.sd for the gallery pictures, locks and Start).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const api = (window.api && window.api.video) || null;
  const sdApi = (window.api && window.api.sd) || null;
  if (!$('video-tab')) return;

  const st = { loaded: false, status: null, mode: 't2v', image: null, imageLabel: '', generating: false, timer: null, lastSeed: null, current: null, models: [], startedAt: 0 };
  function setText(id, t) { const e = $(id); if (e) e.textContent = t; }
  function hint(text, tone) { const h = $('vd-hint'); if (!h) return; if (!text) { h.hidden = true; h.textContent = ''; return; } h.hidden = false; h.dataset.tone = tone || 'warn'; h.textContent = text; }
  function msg(t) { setText('vd-msg', t || ''); }
  async function call(fn, ...args) {
    if (!api || typeof api[fn] !== 'function') return { ok: false, error: 'NO_API', message: 'This part of the app is not available (restart AutoInjector).' };
    try { return (await api[fn](...args)) || { ok: false }; } catch (e) { return { ok: false, error: String(e), message: String((e && e.message) || e) }; }
  }
  async function sdCall(fn, ...args) { if (!sdApi || typeof sdApi[fn] !== 'function') return { ok: false }; try { return (await sdApi[fn](...args)) || { ok: false }; } catch (_) { return { ok: false }; } }

  // ------------------------------------------------------------ the tab
  function showTab() {
    document.body.dataset.appTab = 'video';
    for (const id of ['tab-app-main', 'tab-app-akowe', 'tab-app-images']) if ($(id)) $(id).setAttribute('aria-selected', 'false');
    $('tab-app-video').setAttribute('aria-selected', 'true');
    for (const id of ['akowe-tab', 'images-tab']) if ($(id)) $(id).hidden = true;
    $('video-tab').hidden = false;
    try { if (window.api && window.api.akoweTab) window.api.akoweTab(false); } catch (_) {}
    if (!st.loaded) { st.loaded = true; init(); } else refreshStatus();
  }
  function hideTab() { $('video-tab').hidden = true; if ($('tab-app-video')) $('tab-app-video').setAttribute('aria-selected', 'false'); }
  window.vdShowVideoTab = showTab;
  $('tab-app-video').addEventListener('click', showTab);
  for (const id of ['tab-app-main', 'tab-app-akowe', 'tab-app-images']) if ($(id)) $(id).addEventListener('click', () => {
    hideTab();
    if (document.body.dataset.appTab === 'video') document.body.dataset.appTab = id === 'tab-app-akowe' ? 'akowe' : id === 'tab-app-images' ? 'images' : 'main';
  });
  function subTab(which) {
    for (const w of ['make', 'trailer', 'setup']) { if (!$(`vd-sub-${w}`)) continue; $(`vd-sub-${w}`).setAttribute('aria-selected', String(w === which)); $(`vd-view-${w}`).hidden = w !== which; }
    if (which === 'setup') { refreshSetup(); loadOtherServer(); }
    try { document.dispatchEvent(new CustomEvent('vd-subtab', { detail: which })); } catch (_) {}
  }
  window.vdSubTab = subTab;
  $('vd-sub-make').onclick = () => subTab('make');
  if ($('vd-sub-trailer')) $('vd-sub-trailer').onclick = () => subTab('trailer');
  $('vd-sub-setup').onclick = () => subTab('setup');

  // ------------------------------------------------------------ status
  function renderStatus(s) {
    if (!s || !s.ok) return;
    st.status = s;
    const tone = s.ready ? 'ok' : (s.comfy && s.comfy.connected) || (s.comfy && s.comfy.installed) ? 'busy' : 'off';
    $('vd-dot').dataset.tone = tone; if ($('vd-tab-dot')) $('vd-tab-dot').dataset.tone = tone;
    setText('vd-status-text', s.message || (s.ready ? '✔ Ready' : 'Video is not set up'));
    $('vd-status').title = s.message || '';
    if (!s.ready && !st.generating) hint(`${s.message}\nOpen ⚙ Setup & models to finish (one click).`, 'warn'); else if (s.ready && !st.generating) hint('', '');
    // the model list
    st.models = s.models || [];
    const sel = $('vd-model'); const cur = sel.value || (s.settings && s.settings.model) || s.defaultModel;
    sel.textContent = '';
    for (const m of st.models) {
      const o = document.createElement('option'); o.value = m.id;
      o.textContent = `${m.short || m.label}${m.modes.includes('i2v') ? '' : ' (text only)'}${m.installed ? '' : ' — not downloaded'}`;
      sel.appendChild(o);
    }
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    applyModelLimits(false);
    if (s.settings) {
      $('vd-backend').value = s.settings.backend || 'auto';
      $('vd-comfy-url').value = s.settings.comfyUrl || '';
      $('vd-timeout').value = String(Math.round((s.settings.timeoutMs || 2700000) / 60000));
    }
    if (s.endpoint) { $('vd-ep-enabled').checked = !!s.endpoint.enabled; if (!$('vd-ep-url').value) $('vd-ep-url').value = s.endpoint.endpoint || ''; }
  }
  async function refreshStatus(fresh) { const s = await call('status', !!fresh); renderStatus(s); return s; }

  // ------------------------------------------------------------ the form
  const SLIDERS = ['vd-seconds', 'vd-fps', 'vd-width', 'vd-height', 'vd-steps', 'vd-cfg', 'vd-shift'];
  for (const id of SLIDERS) { const r = $(id); const upd = () => { setText(`${id}-v`, r.value); framesNote(); }; r.addEventListener('input', upd); upd(); }
  function setSlider(id, v) { if (v == null || !$(id)) return; $(id).value = v; setText(`${id}-v`, $(id).value); }
  function model() { return st.models.find((m) => m.id === $('vd-model').value) || null; }
  const DEF = { 'wan22-ti2v-5b': { width: 1280, height: 704, fps: 24, steps: 20, cfgScale: 5, shift: 8, step: 32, max: 1280, maxSec: 5 }, 'wan21-t2v-1.3b': { width: 832, height: 480, fps: 16, steps: 30, cfgScale: 6, shift: 8, step: 16, max: 1024, maxSec: 5 } };
  function applyModelLimits(reset) {
    const m = model(); const d = DEF[m ? m.id : 'wan22-ti2v-5b'] || DEF['wan22-ti2v-5b'];
    for (const id of ['vd-width', 'vd-height']) { $(id).step = String(d.step); $(id).max = String(d.max); }
    if (reset) { setSlider('vd-width', d.width); setSlider('vd-height', d.height); setSlider('vd-fps', d.fps); setSlider('vd-steps', d.steps); setSlider('vd-cfg', d.cfgScale); setSlider('vd-shift', d.shift); }
    if (m && !m.modes.includes('i2v') && st.mode === 'i2v') setNote('vd-image-note', `${m.short} makes video from text only — picture→video uses Wan 2.2 5B.`);
    framesNote();
  }
  function setNote(id, t) { setText(id, t || ''); }
  function framesNote() {
    const fps = Number($('vd-fps').value); const sec = Number($('vd-seconds').value);
    const k = Math.max(1, Math.round((sec * fps) / 4)); const frames = 4 * k + 1;
    setText('vd-frames-note', `${frames} frames at ${fps} fps ≈ ${((frames - 1) / fps).toFixed(1)} s · ${$('vd-width').value}×${$('vd-height').value}. Longer and bigger = slower and more graphics memory.`);
  }
  $('vd-model').onchange = () => applyModelLimits(true);
  $('vd-size-preset').onchange = (e) => { const v = e.target.value; if (!v) return; const [w, h] = v.split('x'); setSlider('vd-width', w); setSlider('vd-height', h); e.target.value = ''; framesNote(); };
  $('vd-purpose').onchange = (e) => { if (e.target.value === 'clip') setSlider('vd-seconds', 4); if (e.target.value === 'trailer_shot') { setSlider('vd-seconds', 5); } framesNote(); };
  $('btn-vd-seed-rand').onclick = () => { $('vd-seed').value = '-1'; };
  $('btn-vd-seed-last').onclick = () => { if (st.lastSeed != null) $('vd-seed').value = String(st.lastSeed); };

  function setMode(m) {
    st.mode = m;
    $('btn-vd-mode-t2v').setAttribute('aria-pressed', String(m === 't2v'));
    $('btn-vd-mode-i2v').setAttribute('aria-pressed', String(m === 'i2v'));
    $('vd-drop').hidden = m !== 'i2v';
    $('vd-prompt').placeholder = m === 'i2v' ? 'How it moves (optional)… e.g. she turns her head and smiles, wind in her hair, camera still' : 'What happens… e.g. a lighthouse keeper climbs the spiral stairs at night, lantern swinging, camera follows';
    if (m === 'i2v') { const mm = model(); if (mm && !mm.modes.includes('i2v')) { const i2v = st.models.find((x) => x.modes.includes('i2v')); if (i2v) { $('vd-model').value = i2v.id; applyModelLimits(true); } } }
  }
  $('btn-vd-mode-t2v').onclick = () => setMode('t2v');
  $('btn-vd-mode-i2v').onclick = () => setMode('i2v');

  // ---- the picture: drop, choose, or the 🎨 gallery
  function useImage(value, label, previewSrc) {
    st.image = value; st.imageLabel = label || '';
    const im = $('vd-image-preview'); im.src = previewSrc || ''; im.hidden = !previewSrc;
    setNote('vd-image-note', label ? `Picture: ${label} — the video keeps its shape.` : '');
  }
  function readFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type || '')) { setNote('vd-image-note', 'Use a PNG, JPEG or WEBP picture.'); return; }
    if (file.size > 25 * 1024 * 1024) { setNote('vd-image-note', 'That picture is too big (over 25 MB).'); return; }
    const rd = new FileReader();
    rd.onload = () => useImage(String(rd.result), file.name, String(rd.result));
    rd.onerror = () => setNote('vd-image-note', 'The picture could not be read.');
    rd.readAsDataURL(file);
  }
  $('vd-file').onchange = (e) => readFile(e.target.files && e.target.files[0]);
  const drop = $('vd-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('vd-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('vd-over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('vd-over'); readFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); });
  $('vd-pick').addEventListener('toggle', async () => {
    if (!$('vd-pick').open) return;
    const g = await sdCall('gallery', 60);
    const box = $('vd-pick-grid'); box.textContent = '';
    const items = (g && g.items) || [];
    if (!items.length) { box.textContent = 'No pictures yet — make some in 🎨 Images.'; return; }
    for (const it of items) {
      const img = document.createElement('img'); img.src = it.url; img.alt = it.prompt || 'picture'; img.title = it.prompt || it.path; img.tabIndex = 0;
      const pick = () => { useImage(it.path, it.path.split(/[\\/]/).pop(), it.url); $('vd-pick').open = false; };
      img.onclick = pick; img.onkeydown = (e) => { if (e.key === 'Enter') pick(); };
      box.appendChild(img);
    }
  });
  async function loadLocks() {
    const r = await sdCall('locks');
    const sel = $('vd-lock'); const cur = sel.value; sel.textContent = '';
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '— none —'; sel.appendChild(o0);
    for (const l of (r && r.locks) || []) { const o = document.createElement('option'); o.value = l.id; o.textContent = `${l.character}${l.book ? ` (${l.book})` : ''}`; sel.appendChild(o); }
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }

  function formRequest() {
    const num = (id) => Number($(id).value);
    const r = {
      prompt: $('vd-prompt').value.trim(), seconds: num('vd-seconds'), fps: num('vd-fps'), width: num('vd-width'), height: num('vd-height'),
      steps: num('vd-steps'), cfgScale: num('vd-cfg'), shift: num('vd-shift'), sampler: $('vd-sampler').value.trim() || undefined, scheduler: $('vd-scheduler').value.trim() || undefined,
      seed: Number.isFinite(num('vd-seed')) ? num('vd-seed') : -1, model: $('vd-model').value || undefined, purpose: $('vd-purpose').value || 'free',
      characterLock: $('vd-lock').value || undefined,
    };
    if ($('vd-negative').value.trim()) r.negativePrompt = $('vd-negative').value.trim();
    if (st.mode === 'i2v') r.image = st.image;
    return r;
  }

  // ---- errors: the same red box as 🎨 Images
  function hideError() { $('vd-error').hidden = true; }
  function showError(r) {
    setText('vd-error-msg', `✖ ${(r && r.message) || (r && r.error) || 'Failed.'}`);
    const fix = (r && (r.fix || r.hint)) || '';
    setText('vd-error-fix', fix ? `How to fix: ${fix}` : ''); $('vd-error-fix').hidden = !fix;
    const acts = $('vd-error-actions'); acts.textContent = '';
    if (r && (r.error === 'VIDEO_MODEL_MISSING' || r.error === 'VIDEO_NOT_SET_UP')) {
      const b = document.createElement('button'); b.className = 'primary';
      b.textContent = r.error === 'VIDEO_MODEL_MISSING' ? `⬇ Download ${r.model || 'the model'}` : '⚙ Open Setup';
      b.onclick = () => { subTab('setup'); if (r.error === 'VIDEO_MODEL_MISSING' && r.model) download(r.model); };
      acts.appendChild(b);
    }
    acts.hidden = !acts.children.length;
    const raw = (r && r.serverError) || '';
    setText('vd-error-raw', raw.slice(0, 600)); $('vd-error-details').hidden = !raw; $('vd-error-details').open = false;
    $('vd-error').hidden = false;
    try { $('vd-error').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
  }

  // ---- making it
  function busy(on) {
    st.generating = on;
    $('btn-vd-generate').disabled = on; $('btn-vd-stop').disabled = !on;
    $('btn-vd-generate').textContent = on ? '⏳ Making…' : '🎬 Make video';
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    if (on) {
      st.startedAt = Date.now();
      const tick = async () => {
        const p = await call('progress');
        const secs = Math.round((Date.now() - st.startedAt) / 1000);
        const bits = [`${secs} s`];
        if (p && p.busy) {
          if (p.phase) bits.push({ queued: 'waiting in ComfyUI\'s queue', uploading: 'sending the picture', sampling: 'making the frames', decoding: 'decoding the frames', saving: 'saving', starting: 'loading the model', rendering: 'rendering' }[p.phase] || p.phase);
          if (p.steps) bits.push(`step ${p.step} of ${p.steps}`);
          $('vd-progress-bar').style.width = `${Math.round((p.pct || 0) * 100)}%`;
        }
        if (st.generating) msg(`🎬 Making your video… ${bits.join(' · ')}\nThe first video loads the model, which takes a while.`);
      };
      st.timer = setInterval(tick, 1000);
      setTimeout(tick, 150);
    } else $('vd-progress-bar').style.width = '0%';
  }
  async function generate() {
    if (st.generating) return;
    hideError();
    const req = formRequest();
    if (st.mode === 'i2v' && !req.image) { showError({ message: 'Choose a picture first (drop one, choose a file, or pick one from the 🎨 gallery).' }); return; }
    if (st.mode === 't2v' && !req.prompt && !req.characterLock) { showError({ message: 'Describe the video first.' }); return; }
    busy(true);
    msg('🎬 Starting…');
    const r = st.mode === 'i2v' ? await call('animate', req) : await call('generate', req);
    busy(false);
    if (!r || !r.ok) { msg(''); showError(r); refreshStatus(); return; }
    st.lastSeed = r.seed;
    const warn = (r.warnings || []).map((w) => `⚠ ${w.message}`).join('\n');
    msg(`✔ Video saved: ${String(r.path || '').split(/[\\/]/).pop()} (${r.seconds} s, ${r.width}×${r.height}, ${r.model})${warn ? `\n${warn}` : ''}`);
    play({ path: r.path, url: r.url, poster: r.poster, posterUrl: r.posterUrl, record: Object.assign({}, req, r, { image: undefined }) });
    loadGallery();
  }
  $('btn-vd-generate').onclick = generate;
  $('btn-vd-stop').onclick = async () => { $('btn-vd-stop').disabled = true; msg('⏹ Stopping…'); await call('cancel'); };

  // ---- player + gallery
  function play(it) {
    st.current = it;
    const v = $('vd-player');
    v.poster = it.posterUrl || '';
    v.src = it.url || '';
    v.hidden = false; $('vd-player-empty').hidden = true;
    const r = it.record || {};
    setText('vd-player-info', [r.prompt ? `“${String(r.prompt).slice(0, 300)}”` : '', [r.model, r.width && `${r.width}×${r.height}`, r.seconds != null && `${r.seconds} s`, r.fps && `${r.fps} fps`, r.seed != null && `seed ${r.seed}`].filter(Boolean).join(' · ')].filter(Boolean).join('\n'));
    $('btn-vd-remake').disabled = !it.record; $('btn-vd-showfile').disabled = !it.path;
  }
  async function loadGallery() {
    const g = await call('gallery', 40);
    const box = $('vd-gallery'); box.textContent = '';
    for (const it of (g && g.items) || []) {
      const d = document.createElement('div'); d.className = 'vd-thumb'; d.tabIndex = 0; d.title = it.prompt || it.path;
      if (it.posterUrl) { const img = document.createElement('img'); img.src = it.posterUrl; img.alt = it.prompt || 'video'; d.appendChild(img); }
      else { const v = document.createElement('video'); v.src = it.url; v.muted = true; v.preload = 'metadata'; d.appendChild(v); }
      if (it.seconds != null) { const s = document.createElement('span'); s.textContent = `${it.seconds} s`; d.appendChild(s); }
      const open = () => play(it);
      d.onclick = open; d.onkeydown = (e) => { if (e.key === 'Enter') open(); };
      box.appendChild(d);
    }
    if (!box.children.length) box.textContent = 'No videos yet.';
  }
  $('btn-vd-remake').onclick = () => {
    const r = st.current && st.current.record; if (!r) return;
    if (r.prompt) $('vd-prompt').value = r.prompt;
    if (r.negativePrompt) $('vd-negative').value = r.negativePrompt;
    if (r.model && [...$('vd-model').options].some((o) => o.value === r.model)) { $('vd-model').value = r.model; applyModelLimits(false); }
    for (const [id, k] of [['vd-width', 'width'], ['vd-height', 'height'], ['vd-fps', 'fps'], ['vd-steps', 'steps'], ['vd-cfg', 'cfgScale'], ['vd-shift', 'shift'], ['vd-seconds', 'seconds']]) if (r[k] != null) setSlider(id, r[k]);
    if (r.seed != null) $('vd-seed').value = String(r.seed);
    if (r.sampler) $('vd-sampler').value = r.sampler;
    if (r.scheduler) $('vd-scheduler').value = r.scheduler;
    setMode(r.mode === 'i2v' ? 'i2v' : 't2v');
    framesNote();
  };
  $('btn-vd-showfile').onclick = () => { if (st.current && st.current.path) call('showFile', st.current.path); };
  $('btn-vd-folder').onclick = () => call('openFolder');

  // ------------------------------------------------------------ setup
  function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(1)} GB` : '?'; }
  async function refreshSetup() {
    const s = await refreshStatus(true);
    const m = await call('models');
    const lines = [];
    if (s && s.comfy && s.comfy.connected) lines.push(`✔ ComfyUI is running at ${s.comfy.base} (${s.comfy.source || 'found'}).${(s.comfy.missingNodes || []).length ? ` ⚠ It is too old for Wan video (missing ${s.comfy.missingNodes.join(', ')}) — update ComfyUI.` : ''}${s.comfy.saveFormat === 'webm' ? ' It saves .webm (update ComfyUI for .mp4).' : ''}`);
    else if (m && m.anyComfy) lines.push(`ComfyUI is installed (${m.roots[0].source}) but not running. Press ▶ Start ComfyUI.`);
    else lines.push('No ComfyUI on this PC yet. “Install ComfyUI + video model” does both in one go (Windows), or install ComfyUI in Stability Matrix and press ↻ Check again.');
    if (m && m.target) lines.push(`Video models go into: ${m.target.path}`);
    if (m && m.freeBytes != null) lines.push(`Free space there: ${fmtGB(m.freeBytes)}.`);
    setText('vd-setup-comfy', lines.join('\n'));
    $('vd-setup-comfy').style.whiteSpace = 'pre-line';
    $('btn-vd-start').hidden = !!(s && s.comfy && s.comfy.connected) || !(m && m.anyComfy);
    $('btn-vd-install-all').hidden = !!(m && m.models && m.models.some((x) => x.installed) && m.anyComfy);
    const box = $('vd-models'); box.textContent = '';
    for (const x of (m && m.models) || []) {
      const d = document.createElement('div'); d.className = 'vd-model'; d.dataset.installed = String(!!x.installed); d.dataset.model = x.id;
      const head = document.createElement('div'); head.className = 'vd-model-head';
      const b = document.createElement('b'); b.textContent = x.label; head.appendChild(b);
      const stt = document.createElement('span'); stt.textContent = x.installed ? '✔ downloaded' : `${x.sizeText} to download${x.missing.length < 3 ? ` (missing ${x.missing.join(', ')})` : ''}`; head.appendChild(stt);
      if (!x.installed) {
        const kept = (x.files || []).reduce((n, f) => n + (f.present ? 0 : (f.partialBytes || 0)), 0);
        const btn = document.createElement('button'); btn.className = 'primary'; btn.id = `btn-vd-dl-${x.id}`; btn.dataset.vdDownload = x.id;
        btn.textContent = kept ? `⬇ Resume download (${fmtGB(kept)} kept)` : '⬇ Download';
        btn.disabled = !(m && m.anyComfy) || dl.busy; btn.onclick = () => download(x.id); head.appendChild(btn);
      }
      d.appendChild(head);
      const n = document.createElement('div'); n.className = 'sd-note'; n.textContent = `${x.vramNote || ''} ${x.modes.includes('i2v') ? 'Text→video and picture→video.' : 'Text→video only.'}`; d.appendChild(n);
      box.appendChild(d);
    }
  }
  // One download at a time: a second press while one runs only says so (the main process refuses it too).
  const dl = { local: false, remote: false, model: null, get busy() { return this.local || this.remote; } };
  function setDownloadButtons(busy) {
    for (const b of document.querySelectorAll('[data-vd-download]')) b.disabled = !!busy;
    if ($('btn-vd-install-all')) $('btn-vd-install-all').disabled = !!busy;
  }
  function renderDownload(i) {
    if (!i) return;
    const pct = Math.round((i.pct || 0) * 100);
    // While it waits to resume after a dropped connection the bar stays where it got to.
    $('vd-dl-bar').style.width = `${i.busy || i.phase === 'installed' || i.canResume ? pct : 0}%`;
    if (i.message) setText('vd-dl-msg', i.message);
    $('btn-vd-dl-cancel').disabled = !i.busy;
    dl.remote = !!i.busy; if (i.busy && i.model) dl.model = i.model;
    const resume = $('btn-vd-dl-resume');
    if (resume) { resume.hidden = !!i.busy || !i.canResume || !i.model; if (i.model) resume.dataset.model = i.model; }
    setDownloadButtons(dl.busy);
  }
  async function download(id) {
    if (dl.busy) { setText('vd-dl-msg', `Already downloading${dl.model && dl.model !== id ? ` another model (${dl.model})` : ''} — this press was ignored. Wait for it, or press ⏸ Pause.`); return; }
    dl.local = true; dl.model = id; setDownloadButtons(true);
    if ($('btn-vd-dl-resume')) $('btn-vd-dl-resume').hidden = true;
    setText('vd-dl-msg', 'Starting the download…'); $('btn-vd-dl-cancel').disabled = false;
    let r;
    try { r = await call('downloadModel', id); } finally { dl.local = false; }
    if (r && r.alreadyDownloading) { setText('vd-dl-msg', r.message); dl.remote = true; return; } // another window's download is running: leave its bar alone
    setText('vd-dl-msg', r && r.ok ? `✔ ${r.already ? 'Already downloaded.' : 'Downloaded.'}` : `✖ ${(r && r.message) || 'The download failed.'}${r && r.fix ? ` ${r.fix}` : ''}`);
    $('btn-vd-dl-cancel').disabled = true;
    if ($('btn-vd-dl-resume')) { $('btn-vd-dl-resume').hidden = !(r && !r.ok && r.canResume); $('btn-vd-dl-resume').dataset.model = id; }
    setDownloadButtons(false);
    refreshSetup();
  }
  if ($('btn-vd-dl-resume')) $('btn-vd-dl-resume').onclick = () => download($('btn-vd-dl-resume').dataset.model || undefined);
  $('btn-vd-dl-cancel').onclick = () => call('installCancel');
  $('btn-vd-install-all').onclick = async () => {
    if (dl.busy) { setText('vd-dl-msg', 'Already downloading — this press was ignored. Wait for it, or press ⏸ Pause.'); return; }
    dl.local = true; setDownloadButtons(true); $('btn-vd-dl-cancel').disabled = false;
    setText('vd-dl-msg', 'Installing… (ComfyUI first if there is none, then the video model)');
    let r;
    try { r = await call('installAll', $('vd-model').value || undefined); } finally { dl.local = false; }
    if (r && (r.alreadyDownloading || r.alreadyRunning)) { setText('vd-dl-msg', r.message); dl.remote = true; return; }
    if ($('btn-vd-dl-resume') && r && !r.ok && r.canResume) { $('btn-vd-dl-resume').hidden = false; $('btn-vd-dl-resume').dataset.model = r.model || ''; }
    setDownloadButtons(false);
    setText('vd-dl-msg', r && r.ok ? '✔ Installed. Press ▶ Start ComfyUI (or just make a video — it starts by itself).' : `✖ ${(r && r.message) || 'The install failed.'}${r && r.fix ? ` ${r.fix}` : ''}`);
    $('btn-vd-install-all').disabled = false; $('btn-vd-dl-cancel').disabled = true;
    refreshSetup();
  };
  // The ComfyUI runner's state (the same one 🎨 Images starts): "Starting…" while it starts,
  // why it crashed (plain words + fix), and what to try next.
  let runnerSt = null;
  function renderRunner(r) {
    if (!r) return;
    const prev = runnerSt && runnerSt.phase;
    runnerSt = r;
    const waiting = r.phase === 'waiting';
    const busy = r.phase === 'starting' || r.phase === 'restarting' || waiting;
    const b = $('btn-vd-start');
    if (b) { if (!b.dataset.label) b.dataset.label = b.textContent; b.textContent = busy ? (waiting ? '⏳ Waiting for the install…' : '⏳ Starting…') : b.dataset.label; b.disabled = busy; }
    const box = $('vd-run-state');
    const show = busy || r.phase === 'failed';
    if (box) { box.hidden = !show; box.textContent = !show ? '' : busy ? `⏳ ${r.message || 'Starting ComfyUI…'}` : `✖ ${r.message || 'ComfyUI could not start.'}${r.fix ? `\nHow to fix it: ${r.fix}` : ''}`; }
    const acts = r.phase === 'failed' && Array.isArray(r.actions) ? r.actions : [];
    const cpuAct = acts.find((a) => a.id === 'sd-start-cpu');
    const otherAct = acts.find((a) => a.id === 'sd-other-build');
    if ($('btn-vd-start-cpu')) { $('btn-vd-start-cpu').hidden = !cpuAct; $('btn-vd-start-cpu').disabled = busy; }
    if ($('btn-vd-other-build')) { $('btn-vd-other-build').hidden = !otherAct; $('btn-vd-other-build').disabled = busy; if (otherAct) $('btn-vd-other-build').textContent = `🔁 ${otherAct.label}`; }
    if (r.phase === 'running' && prev && prev !== 'running' && st.loaded) refreshSetup();
  }
  if (sdApi && typeof sdApi.onRunner === 'function') sdApi.onRunner((r) => renderRunner(r));
  async function startComfy(how) {
    const cur = runnerSt && runnerSt.phase;
    if (cur === 'starting' || cur === 'restarting' || cur === 'waiting') return; // already starting — no second start
    const t = await sdCall('targets');
    if (t && t.runner) renderRunner(t.runner);
    const pick = ((t && t.targets) || []).find((x) => x.kind === 'comfy' && x.supported);
    const installing = !!(t && t.install && t.install.busy);
    if (!pick && !installing) { setText('vd-setup-comfy', 'No ComfyUI was found to start. Install it first.'); return; }
    renderRunner({ phase: 'starting', message: how === 'cpu' ? 'Starting ComfyUI on the processor… slow, but works on any PC.' : 'Starting ComfyUI… the first start can take several minutes.' });
    const r = how === 'cpu' ? await sdCall('startCpu', pick ? pick.id : undefined) : await sdCall('start', pick ? pick.id : undefined);
    if (r && r.runner) renderRunner(r.runner);
    else if (r && !r.ok && r.message) setText('vd-setup-comfy', r.message);
    refreshSetup();
  }
  $('btn-vd-start').onclick = () => startComfy();
  if ($('btn-vd-start-cpu')) $('btn-vd-start-cpu').onclick = () => startComfy('cpu');
  if ($('btn-vd-other-build')) $('btn-vd-other-build').onclick = async () => {
    $('btn-vd-other-build').disabled = true;
    setText('vd-dl-msg', 'Switching to the other ComfyUI build… (downloaded first if it isn\'t there yet; your models are shared)');
    const r = await sdCall('useOtherBuild');
    if (r && r.runner) renderRunner(r.runner);
    setText('vd-dl-msg', r && r.ok ? '✔ ComfyUI is running with the other build.' : `✖ ${(r && r.message) || 'Could not switch the ComfyUI build.'}`);
    $('btn-vd-other-build').disabled = false;
    refreshSetup();
  };
  $('btn-vd-recheck').onclick = () => refreshSetup();
  $('btn-vd-test').onclick = async () => {
    subTab('make'); hideError(); busy(true); msg('🧪 Making a 1-second test video…');
    const r = await call('test');
    busy(false);
    if (!r || !r.ok) { msg(''); showError(r); return; }
    msg(`✔ Test video saved: ${String(r.path || '').split(/[\\/]/).pop()}`);
    play({ path: r.path, url: r.url, posterUrl: r.posterUrl, record: r });
    loadGallery();
  };
  $('btn-vd-save-settings').onclick = async () => {
    const r = await call('settings', { backend: $('vd-backend').value, comfyUrl: $('vd-comfy-url').value.trim(), timeoutMs: Math.max(1, Number($('vd-timeout').value) || 45) * 60000 });
    setText('vd-settings-msg', r && r.ok ? 'Saved.' : `✖ ${(r && r.message) || 'Not saved.'}`);
    refreshStatus(true);
  };
  // Advanced: other video server — also has what the old Video Generation panel offered:
  // a list of common addresses, 🔍 auto-detect, "✓ Check it answers" and this server's clip settings.
  const EP_FIELDS = [['vd-ep-frames', 'frames'], ['vd-ep-fps', 'fps'], ['vd-ep-width', 'width'], ['vd-ep-height', 'height'], ['vd-ep-steps', 'steps'], ['vd-ep-cfg', 'cfgScale'], ['vd-ep-motion', 'motion'], ['vd-ep-seed', 'seed']];
  const wapi = () => window.api || {};
  let epLoaded = false;
  async function loadOtherServer() {
    const w = wapi();
    if (epLoaded) return;
    epLoaded = true;
    if (typeof w.endpointPresets === 'function') {
      try { const r = await w.endpointPresets('video'); if (r && r.ok) for (const p of r.presets) { const o = document.createElement('option'); o.value = p.endpoint; o.textContent = p.label; $('vd-ep-preset').appendChild(o); } } catch (_) {}
    }
    if (typeof w.videoStatus === 'function') {
      try { const s = await w.videoStatus(); if (s) { for (const [id, k] of EP_FIELDS) if (s[k] != null && $(id)) $(id).value = String(s[k]); if (!$('vd-ep-url').value && s.endpoint) $('vd-ep-url').value = s.endpoint; } } catch (_) {}
    }
  }
  $('vd-ep-preset').onchange = () => { const v = $('vd-ep-preset').value; if (v) { $('vd-ep-url').value = v; setText('vd-ep-msg', 'Filled in — press ✓ Check it answers, then Save.'); } };
  $('btn-vd-ep-detect').onclick = async () => {
    const w = wapi(); if (typeof w.detectEndpoints !== 'function') return;
    setText('vd-ep-msg', '🔍 Looking on this PC…');
    let r; try { r = await w.detectEndpoints('video'); } catch (_) { r = null; }
    const reach = (r && r.reachable) || [];
    if (!reach.length) { setText('vd-ep-msg', 'Nothing found running. Start your video server with its API on, or pick one from the list.'); return; }
    $('vd-ep-url').value = reach[0].endpoint; $('vd-ep-preset').value = reach[0].endpoint;
    setText('vd-ep-msg', `Found: ${reach[0].label} ✓ — press Save.${reach.length > 1 ? ` (+${reach.length - 1} more)` : ''}`);
  };
  $('btn-vd-ep-test').onclick = async () => {
    const w = wapi(); if (typeof w.testEndpoint !== 'function') return;
    const url = $('vd-ep-url').value.trim();
    if (!url) { setText('vd-ep-msg', 'Type an address or pick one from the list first.'); return; }
    setText('vd-ep-msg', 'Checking…');
    let r; try { r = await w.testEndpoint(url); } catch (_) { r = null; }
    setText('vd-ep-msg', r && r.reachable ? 'It answers ✓ — press Save to use it.' : 'No answer — is the video server running with its API on? Check the address.');
  };
  $('btn-vd-ep-save').onclick = async () => {
    if (!window.api || typeof window.api.configureVideo !== 'function') return;
    const patch = { enabled: $('vd-ep-enabled').checked, endpoint: $('vd-ep-url').value.trim() };
    for (const [id, k] of EP_FIELDS) { const e = $(id); if (e && String(e.value).trim() !== '') { const n = Number(e.value); if (Number.isFinite(n)) patch[k] = n; } }
    let r; try { r = await window.api.configureVideo(patch); } catch (e) { r = { ok: false, message: String(e) }; }
    setText('vd-ep-msg', r && r.ok ? (r.enabled ? 'Saved — the other video server is on.' : 'Saved — off.') : `✖ ${(r && (r.message || r.error)) || 'Not saved.'} Try again.`);
    refreshStatus(true);
  };
  if (api && api.onInstall) api.onInstall((i) => renderDownload(i));
  if (sdApi && sdApi.onInstall) sdApi.onInstall((i) => { if (i && i.busy) renderDownload(Object.assign({}, i, { message: `ComfyUI: ${i.message || ''}` })); });

  async function init() {
    await refreshStatus();
    const s = st.status;
    if (s && s.settings && s.settings.model) { $('vd-model').value = s.settings.model; applyModelLimits(true); } else applyModelLimits(true);
    loadLocks(); loadGallery();
    if (s && !s.ready) subTab('setup');
  }
  // The tab's dot: ready or not, even before the tab is opened.
  setTimeout(() => { refreshStatus().catch(() => {}); }, 2500);
})();
