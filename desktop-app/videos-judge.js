'use strict';
/*
 * videos-judge.js — the 🎬 Video tab's 💾 recipes, 🧑‍⚖️ judge, 🔁 Make it better (quick previews + one full video),
 * "Make N, pick the best", "Settings used" and the trailer's recipe / auto-judge switch. The engine is video-improve.js
 * in main (window.api.video.*); the shared parts of the tab come from videos-studio.js (window.vdHooks) and the saved
 * settings in plain words from video-record.js (window.videoRecord). Every judgement uses ONE AI answer (the tooltips say so).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const api = (window.api && window.api.video) || null;
  const H = window.vdHooks;
  const VR = window.videoRecord || null;
  if (!$('video-tab') || !H) return;
  const SCORE_WORDS = { prompt: 'Matches the prompt', quality: 'Picture quality', consistency: 'Stays the same across frames', motion: 'Natural motion (no melting)', flicker: 'No flicker or jumps', faithful: 'Faithful to the starting picture' };
  const st = { recipes: [], recipeSel: '', recipeTemplate: '', defaultRecipe: '', nameMode: null, cur: null, rec: null, busy: false, strip: null, settings: null, firstRecipes: true };
  async function call(fn, ...args) {
    if (!api || typeof api[fn] !== 'function') return { ok: false, error: 'NO_API', message: 'This part of the app is not available (restart AutoInjector).' };
    try { return (await api[fn](...args)) || { ok: false }; } catch (e) { return { ok: false, error: String(e), message: String((e && e.message) || e) }; }
  }
  function setText(id, t) { const e = $(id); if (e) e.textContent = t; }
  function el(tag, attrs, text) { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null) continue; if (k === 'class') e.className = v; else e.setAttribute(k, v); } if (text != null) e.textContent = text; return e; }
  function note(t, tone) { const e = $('vd-recipe-note'); if (!e) return; e.hidden = !t; e.textContent = t || ''; e.dataset.tone = tone || ''; }
  function minutes(s) { const n = Math.max(1, Math.round(Number(s) || 0)); return n < 90 ? `about ${n} s` : `about ${Math.round(n / 60)} min`; }

  // ------------------------------------------------------------ 💾 recipes
  async function loadRecipes() {
    const r = await call('recipes', 'list');
    st.recipes = r && r.ok && Array.isArray(r.recipes) ? r.recipes : []; st.defaultRecipe = (r && r.defaultId) || '';
    renderSelect(); renderTrailerSelect();
    if (st.firstRecipes) { st.firstRecipes = false; if (st.defaultRecipe && !st.recipeSel) await useRecipe(st.defaultRecipe, true); }
  }
  function renderSelect() {
    const sel = $('vd-recipe'); if (!sel) return;
    sel.textContent = '';
    sel.appendChild(el('option', { value: '' }, '— my own settings —'));
    for (const [label, list] of [['My recipes', st.recipes.filter((x) => !x.starter)], ['Starter recipes (a good beginning)', st.recipes.filter((x) => x.starter)]]) {
      if (!list.length) continue;
      const g = el('optgroup', { label });
      for (const x of list) { const o = el('option', { value: x.id, title: x.short || x.description || '' }, `${x.id === st.defaultRecipe ? '⭐ ' : ''}${x.name}`); g.appendChild(o); }
      sel.appendChild(g);
    }
    sel.value = st.recipes.some((x) => x.id === st.recipeSel) ? st.recipeSel : '';
    const cur = st.recipes.find((x) => x.id === sel.value);
    $('btn-vd-recipe-rename').disabled = !cur || cur.starter; $('btn-vd-recipe-delete').disabled = !cur; $('btn-vd-recipe-default').disabled = !cur;
    $('btn-vd-recipe-default').setAttribute('aria-pressed', String(!!cur && cur.id === st.defaultRecipe));
  }
  function renderTrailerSelect() {
    const sel = $('vd-tr-recipe'); if (!sel) return;
    const keep = sel.value; sel.textContent = '';
    sel.appendChild(el('option', { value: '' }, '— the 🎬 Video settings —'));
    for (const x of st.recipes) sel.appendChild(el('option', { value: x.id }, `💾 ${x.name}`));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
  function applyRecipe(rc) {
    const s = rc.settings || {};
    const fp = s.engine === 'framepack';
    if ($('vd-engine')) { $('vd-engine').value = fp ? 'framepack' : s.engine === 'comfy-wan' ? 'comfy-wan' : 'auto'; $('vd-engine').dispatchEvent(new Event('change')); }
    if (!fp && s.model && [...$('vd-model').options].some((o) => o.value === s.model)) { $('vd-model').value = s.model; H.applyModelLimits(false); }
    if (fp) {
      if (s.seconds != null) H.setSlider('vd-fp-seconds', s.seconds);
      if (s.steps != null) H.setSlider('vd-fp-steps', s.steps);
      if (s.gpuMemoryPreservation != null) H.setSlider('vd-fp-gpu', s.gpuMemoryPreservation);
      if (s.teacache != null) $('vd-fp-teacache').checked = !!s.teacache;
    } else {
      for (const [id, k] of [['vd-seconds', 'seconds'], ['vd-fps', 'fps'], ['vd-width', 'width'], ['vd-height', 'height'], ['vd-steps', 'steps'], ['vd-cfg', 'cfgScale'], ['vd-shift', 'shift']]) if (s[k] != null) H.setSlider(id, s[k]);
      if (s.sampler) $('vd-sampler').value = s.sampler;
      if (s.scheduler) $('vd-scheduler').value = s.scheduler;
    }
    $('vd-negative').value = s.negativeMode === 'replace' && s.negativePrompt ? s.negativePrompt : '';
    if (rc.mode === 'i2v' && H.mode() !== 'i2v') H.setMode('i2v');
    H.applyEngine(); H.framesNote();
  }
  async function useRecipe(id, quiet) {
    const r = await call('recipes', 'get', { id });
    if (!r || !r.ok) { note(`✖ ${(r && r.message) || 'That recipe could not be loaded.'}`, 'warn'); return; }
    applyRecipe(r.recipe);
    st.recipeSel = r.recipe.id; st.recipeTemplate = r.recipe.promptTemplate || ''; st.recipeName = r.recipe.name;
    renderSelect();
    note(`${quiet ? '⭐ Default recipe: ' : '✔ Loaded '}“${r.recipe.name}”.${st.recipeTemplate ? ` Your words go into its template: ${st.recipeTemplate}` : ''}`);
  }
  $('vd-recipe').onchange = (e) => { const v = e.target.value; if (!v) { st.recipeSel = ''; st.recipeTemplate = ''; renderSelect(); note(''); return; } useRecipe(v); };
  function formSettings() {
    const f = H.formRequest();
    const fp = f.backend === 'framepack';
    const s = fp ? { engine: 'framepack', seconds: f.seconds, steps: f.steps, teacache: f.teacache, gpuMemoryPreservation: f.gpuMemoryPreservation }
      : { engine: 'comfy-wan', model: f.model, seconds: f.seconds, fps: f.fps, steps: f.steps, cfgScale: f.cfgScale, shift: f.shift, sampler: f.sampler, scheduler: f.scheduler };
    if (!fp && H.mode() !== 'i2v') { s.width = f.width; s.height = f.height; }
    if (f.negativePrompt) { s.negativePrompt = f.negativePrompt; s.negativeMode = 'replace'; } else s.negativeMode = 'auto';
    return s;
  }
  function openNameRow(kind, extra) {
    st.nameMode = Object.assign({ kind }, extra || {});
    $('vd-recipe-name-row').hidden = false;
    const cur = st.recipes.find((x) => x.id === st.recipeSel);
    $('vd-recipe-name').value = kind === 'rename' && cur ? cur.name : (extra && extra.name) || '';
    $('vd-recipe-template').hidden = kind !== 'save';
    $('vd-recipe-template').value = kind === 'save' ? st.recipeTemplate : '';
    $('btn-vd-recipe-name-ok').textContent = kind === 'rename' ? 'Rename' : 'Save';
    try { $('vd-recipe-name').focus(); } catch (_) {}
    note(kind === 'rename' ? 'Type the new name.' : kind === 'save' ? 'Name these settings (engine, model, length, size, steps, CFG …). The prompt is not saved — only the template, if you type one.' : 'Name these settings — the video\'s engine, model, length, size, steps and CFG.');
  }
  function closeNameRow() { st.nameMode = null; $('vd-recipe-name-row').hidden = true; }
  $('btn-vd-recipe-save').onclick = () => openNameRow('save', { name: '' });
  $('btn-vd-recipe-rename').onclick = () => { if (st.recipeSel) openNameRow('rename'); };
  $('btn-vd-recipe-name-cancel').onclick = () => { closeNameRow(); note(''); };
  $('vd-recipe-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('btn-vd-recipe-name-ok').click(); } else if (e.key === 'Escape') $('btn-vd-recipe-name-cancel').click(); });
  $('btn-vd-recipe-name-ok').onclick = async () => {
    const m = st.nameMode; if (!m) return;
    const name = $('vd-recipe-name').value.trim();
    if (!name) { note('Type a name first.', 'warn'); return; }
    let r;
    if (m.kind === 'rename') r = await call('recipes', 'rename', { id: st.recipeSel, name });
    else if (m.kind === 'video') r = await call('recipes', 'fromVideo', { path: m.path, name });
    else if (m.kind === 'round') r = await call('recipes', 'fromSettings', { settings: m.settings, name });
    else r = await call('recipes', 'save', { recipe: { name, settings: formSettings(), promptTemplate: $('vd-recipe-template').value.trim() || undefined, replace: true, mode: H.mode() } });
    if (!r || !r.ok) { note(`✖ ${(r && r.message) || 'It could not be saved.'}`, 'warn'); return; }
    closeNameRow();
    st.recipeSel = r.recipe.id; st.recipeTemplate = r.recipe.promptTemplate || '';
    await loadRecipes();
    note(`✔ ${m.kind === 'rename' ? 'Renamed to' : 'Saved the recipe'} “${r.recipe.name}”. Pick it in Recipe to use these settings again.`);
  };
  $('btn-vd-recipe-delete').onclick = async () => {
    const cur = st.recipes.find((x) => x.id === st.recipeSel); if (!cur) return;
    let go = false; try { go = window.confirm(cur.starter ? `Hide the starter recipe “${cur.name}”?` : `Delete the recipe “${cur.name}”? Videos made with it keep their settings.`); } catch (_) { go = true; }
    if (!go) return;
    const r = await call('recipes', 'delete', { id: cur.id });
    if (!r || !r.ok) { note(`✖ ${(r && r.message) || 'It could not be deleted.'}`, 'warn'); return; }
    st.recipeSel = ''; st.recipeTemplate = '';
    await loadRecipes();
    note(`🗑 ${r.starterHidden ? 'Hid' : 'Deleted'} “${cur.name}”.`);
  };
  $('btn-vd-recipe-default').onclick = async () => {
    const cur = st.recipes.find((x) => x.id === st.recipeSel); if (!cur) return;
    const off = cur.id === st.defaultRecipe;
    const r = await call('recipes', 'setDefault', { id: off ? '' : cur.id });
    if (!r || !r.ok) { note(`✖ ${(r && r.message) || 'It could not be set.'}`, 'warn'); return; }
    await loadRecipes();
    note(off ? 'No default recipe now.' : `⭐ “${cur.name}” is the default: it is loaded when the Video tab opens.`);
  };
  if (api && api.onFormApply) api.onFormApply((ev) => { if (ev && ev.how === 'recipe' && ev.patch && ev.patch.recipeId) useRecipe(ev.patch.recipeId).then(() => H.msg(`🎩 Alfred loaded the recipe “${ev.patch.recipeName || ev.patch.recipeId}” into the form — press Make video when you're ready.`)); });

  // ------------------------------------------------------------ decorate a request · Make N, pick the best
  function decorate(req) {
    if (!st.recipeSel) return req;
    req.recipeUsed = { id: st.recipeSel, name: st.recipeName || st.recipeSel };
    if (st.recipeTemplate && req.prompt && /\{subject\}/.test(st.recipeTemplate)) { req.promptTyped = req.prompt; req.prompt = st.recipeTemplate.replace(/\{subject\}/g, req.prompt); }
    return req;
  }
  function wantBest() { return !!($('vd-make-best') && $('vd-make-best').checked); }
  async function bestEstimate() {
    if (!wantBest()) { setText('vd-best-est', ''); return; }
    const r = await call('estimate', decorate(H.formRequest()));
    setText('vd-best-est', r && r.ok ? ` — ${minutes(r.seconds)} each, ${minutes(r.seconds * Number($('vd-best-count').value))} in all` : '');
  }
  $('vd-make-best').addEventListener('change', bestEstimate);
  $('vd-best-count').addEventListener('change', bestEstimate);
  async function makeBest(req) {
    const count = Number($('vd-best-count').value) || 2;
    openStrip('best');
    stripMsg(`🎬 Making ${count} videos with different seeds, then the AI judge looks at each (one AI answer per video)…`);
    st.busy = true; buttons();
    const r = await call('makeBest', req, count);
    st.busy = false; buttons(); $('btn-vd-improve-stop').hidden = true;
    if (!r || !r.ok) { stripMsg(`✖ ${(r && r.message) || 'It could not run.'}`); return r; }
    st.strip.items = r.videos.filter((x) => x.path).map((x, i) => ({ label: `Video ${i + 1}`, path: x.path, url: x.url, posterUrl: x.posterUrl, overall: x.overall, judge: x.judge, seed: x.seed, error: x.error }));
    st.strip.best = r.best; st.strip.sel = r.best >= 0 ? r.best : 0; st.strip.done = true;
    renderStrip(); stripMsg(r.say || 'Done.'); H.msg(`✔ ${r.say || 'Done.'}`);
    const b = st.strip.items[st.strip.sel]; if (b) showRound(b);
    return r;
  }

  // ------------------------------------------------------------ the current video: Settings used + the verdict
  function buttons() {
    const has = !!(st.cur && st.cur.path && st.rec);
    for (const b of ['btn-vd-judge', 'btn-vd-improve', 'btn-vd-save-recipe']) if ($(b)) $(b).disabled = !has || st.busy;
  }
  function sheetUrlOf(it, rec) { const s = rec && rec.judge && rec.judge.sheet; if (!s || !it || !it.url) return ''; return it.url.replace(/[^/]+$/, encodeURIComponent(s)); }
  function renderUsed(rec) {
    const dl = $('vd-used-list'); if (!dl) return; dl.textContent = '';
    const rows = VR && rec ? VR.settingsUsed(rec) : [];
    for (const x of rows) { dl.appendChild(el('dt', {}, x.label)); dl.appendChild(el('dd', {}, x.value)); }
    $('vd-used').hidden = !rows.length;
  }
  function renderJudge(j, sheetUrl, check) {
    const box = $('vd-judge-box'); if (!box) return;
    box.textContent = '';
    if (!j) { box.hidden = true; return; }
    box.hidden = false;
    const v = el('div', { class: 'sd-jv', 'data-v': j.verdict }, `${j.verdict === 'keep' ? '✔ Keep it' : j.verdict === 'redo' ? '✖ Make it again' : '✎ A good start — needs changes'} · ${j.overall}/10`);
    box.appendChild(v);
    if (sheetUrl) { const im = el('img', { id: 'vd-judge-sheet', src: sheetUrl, alt: 'The contact sheet the judge looked at (frames in time order)', title: 'The contact sheet the judge looked at: frames in time order with their numbers. Click to make it bigger.' }); im.onclick = () => im.classList.toggle('vd-big'); box.appendChild(im); }
    const grid = el('div', { class: 'sd-jscores' });
    for (const k of Object.keys(SCORE_WORDS)) {
      const n = j.scores ? j.scores[k] : null; if (n == null) continue;
      grid.appendChild(el('span', {}, SCORE_WORDS[k]));
      const bar = el('div', { class: 'sd-jbar' }); const i = el('i'); i.style.width = `${n * 10}%`; bar.appendChild(i); grid.appendChild(bar);
      grid.appendChild(el('span', {}, String(n)));
    }
    box.appendChild(grid);
    const ck = check || (j.flickerCheck != null ? { score: j.flickerCheck, words: j.checkWords } : null);
    if (ck && ck.score != null) box.appendChild(el('div', { class: 'sd-jby' }, `🔎 Frame check (no AI): ${(ck.words || []).join('; ')} — ${ck.score}/10${j.flickerAi != null ? ` (the AI said ${j.flickerAi}; both count)` : ''}`));
    for (const [t, list] of [['Good', j.good], ['Not so good', j.bad]]) {
      if (!list || !list.length) continue;
      box.appendChild(el('div', {}, `${t}:`)); const ul = el('ul', { class: 'sd-jlist' }); for (const x of list) ul.appendChild(el('li', {}, x)); box.appendChild(ul);
    }
    if (j.fixes && j.fixes.length) { box.appendChild(el('div', {}, 'Suggested changes:')); const ul = el('ul', { class: 'sd-jlist' }); for (const f of j.fixes) ul.appendChild(el('li', {}, `${f.type.replace(/_/g, ' ')}${f.delta != null ? ` ${f.delta > 0 ? '+' : ''}${f.delta}` : ''}${f.aspect ? ` ${f.aspect}` : ''}${f.amount ? ` ${f.amount}` : ''}${f.to ? ` → ${f.to}` : ''}${f.terms ? `: ${f.terms.join(', ')}` : ''}${f.why ? ` — ${f.why}` : ''}${f.type === 'better_picture' ? ' (🎨 Images → 🔁 Make it better on the starting picture)' : ''}`)); box.appendChild(ul); }
    box.appendChild(el('div', { class: 'sd-jby' }, `🧑‍⚖️ judged by ${j.byLabel || j.by} from a contact sheet of the frames — one AI answer${j.weaker ? ' (a local model — weaker)' : ''}${j.seconds ? `, ${j.seconds} s` : ''}${j.selfConflict ? ' · its verdict didn\'t match its own scores, so the scores decided' : ''}`));
  }
  document.addEventListener('vd-current', async (e) => {
    const it = e.detail; st.cur = it; st.rec = null; buttons();
    renderJudge(null); renderUsed(null);
    if (!it || !it.path) return;
    const r = await call('record', it.path);
    if (st.cur !== it) return;
    st.rec = r && r.ok ? r.record : null;
    renderUsed(st.rec);
    if (st.rec && st.rec.judge && st.rec.judge.kind === 'video') renderJudge(st.rec.judge, sheetUrlOf(it, st.rec));
    buttons();
  });

  // ------------------------------------------------------------ 🧑‍⚖️ Judge
  $('btn-vd-judge').onclick = async () => {
    const it = st.cur; if (!it || !it.path || st.busy) return;
    st.busy = true; buttons();
    H.msg('🧑‍⚖️ Making a contact sheet of the frames, then asking the AI judge… (one AI answer; Claude Code takes about 20–60 s)');
    const r = await call('judge', it.path);
    st.busy = false; buttons();
    if (!r || !r.ok) { H.msg(`✖ ${(r && r.message) || 'The judge could not answer.'}${r && r.hint ? `\n${r.hint}` : ''}`); if (r && r.sheetUrl) renderJudge(null); return; }
    st.rec = Object.assign({}, st.rec || {}, { judge: r.judge });
    renderJudge(r.judge, r.sheetUrl, r.check); renderUsed(st.rec);
    H.msg(`🧑‍⚖️ ${r.say}`);
  };
  $('btn-vd-save-recipe').onclick = () => { if (st.cur && st.cur.path) openNameRow('video', { path: st.cur.path }); };

  // ------------------------------------------------------------ 🔁 Make it better (the strip)
  function stripMsg(t) { setText('vd-improve-msg', t || ''); }
  function openStrip(kind) {
    st.strip = { kind, items: [], sel: -1, best: -1, done: false };
    $('vd-improve-box').hidden = false; $('btn-vd-improve-stop').hidden = false; $('vd-final-row').hidden = true; $('vd-improve-actions').hidden = true;
    renderStrip();
  }
  function showRound(it) { if (it && it.path) H.play({ path: it.path, url: it.url, posterUrl: it.posterUrl, record: Object.assign({}, it.judge ? { judge: it.judge } : {}) }); }
  function renderStrip() {
    const box = $('vd-improve-strip'); if (!box || !st.strip) return;
    box.textContent = '';
    st.strip.items.forEach((it, i) => {
      const d = el('div', { class: 'vd-round', role: 'option', tabindex: '0', 'aria-selected': String(i === st.strip.sel), 'data-best': i === st.strip.best ? '1' : '0', 'data-round': String(it.label || i) });
      if (it.url) {
        const v = el('video', { muted: '', loop: '', playsinline: '', preload: 'metadata', poster: it.posterUrl || null, src: it.url, title: 'Point at it to play' });
        v.muted = true; d.addEventListener('mouseenter', () => { try { v.play(); } catch (_) {} }); d.addEventListener('mouseleave', () => { try { v.pause(); } catch (_) {} });
        d.appendChild(v);
      }
      d.appendChild(el('div', { class: 'sd-rs' }, `${it.label}${it.overall != null ? ` · ${it.overall}/10` : it.error ? ' · ✖' : ''}${i === st.strip.best ? ' ★' : ''}`));
      d.appendChild(el('div', { class: 'sd-rc' }, it.error ? it.error : it.changed && it.changed.length ? it.changed.join('; ') : it.label === 'Your video' ? 'as it is' : it.seed != null ? `seed ${it.seed}` : ''));
      const pick = () => { st.strip.sel = i; renderStrip(); showRound(it); };
      d.onclick = pick; d.onkeydown = (e) => { if (e.key === 'Enter') pick(); };
      box.appendChild(d);
    });
    $('vd-improve-actions').hidden = !st.strip.done || !st.strip.items.some((x) => x.path);
  }
  function itemOf(x) { return { label: x.label || (x.final ? 'Final' : x.round === 0 ? 'Your video' : `Preview ${x.round}`), path: x.path, url: x.url, posterUrl: x.posterUrl, overall: x.overall, verdict: x.verdict, changed: x.changed, judge: x.judge, seed: x.seed, error: x.error, settings: x.settings, preview: x.preview, final: x.final }; }
  if (api && api.onJudge) api.onJudge((e) => {
    if (!e || !st.strip) return;
    if (e.kind === 'improve') {
      if (e.phase === 'making') stripMsg(`🎬 Preview ${e.round} of ${e.rounds}: a short, small test video${e.estimate ? ` (${minutes(e.estimate)})` : ''} — changed: ${(e.changed || []).join('; ') || 'nothing'}`);
      else if (e.phase === 'judging') stripMsg(e.round === 0 ? '🧑‍⚖️ The judge is looking at your video (a contact sheet of its frames)…' : `🧑‍⚖️ Preview ${e.round} of ${e.rounds}: the judge is looking…`);
      else if (e.phase === 'judged' && e.result) { const it = itemOf(e.result); const k = st.strip.items.findIndex((x) => x.label === it.label); if (k >= 0) st.strip.items[k] = it; else st.strip.items.push(it); renderStrip(); }
      else if (e.phase === 'final') stripMsg(`🎬 Making the full video with the best settings (${minutes(e.estimate)})… ⏹ Stop works.`);
      else if (e.phase === 'judging-final') stripMsg('🧑‍⚖️ The judge is looking at the full video…');
    } else if (e.kind === 'best') {
      if (e.phase === 'making') stripMsg(`🎬 Making video ${e.index + 1} of ${e.count}…`);
      else if (e.phase === 'judging') stripMsg(`🧑‍⚖️ The judge is looking at video ${e.index + 1} of ${e.count}…`);
      else if (e.phase === 'judged' && e.result && e.result.path) { st.strip.items.push(itemOf(Object.assign({ label: `Video ${e.index + 1}` }, e.result))); renderStrip(); }
    }
  });
  async function improveCurrent() {
    const it = st.cur; if (!it || !it.path || st.busy || H.isBusy()) return;
    const rounds = Number($('vd-judge-rounds').value) || 3;
    openStrip('improve');
    stripMsg(`🧑‍⚖️ Round 0: the judge looks at your video… then up to ${rounds} quick previews (short and small, one AI answer each). Your defaults are not changed.`);
    st.busy = true; buttons();
    const r = await call('improve', it.path, rounds, 'confirm');
    st.busy = false; buttons();
    if (!r || !r.ok) { $('btn-vd-improve-stop').hidden = true; stripMsg(`✖ ${(r && r.message) || 'It could not run.'}`); if (r && r.rounds && r.rounds.length) { st.strip.items = r.rounds.map(itemOf); st.strip.done = true; renderStrip(); } return; }
    st.strip.id = r.id; st.strip.items = r.rounds.map(itemOf); st.strip.best = r.best; st.strip.sel = r.best; st.strip.done = true;
    renderStrip(); stripMsg(r.say);
    if (r.awaitingFinal && r.final) {
      $('vd-final-row').hidden = false;
      setText('vd-final-msg', `The best settings are ready. The full-length, full-size video takes ${r.final.say}${r.final.changed && r.final.changed.length ? ` (changed: ${r.final.changed.join('; ')})` : ''}.`);
    } else $('btn-vd-improve-stop').hidden = true;
  }
  $('btn-vd-improve').onclick = improveCurrent;
  $('btn-vd-final').onclick = async () => {
    if (!st.strip || !st.strip.id || st.busy) return;
    $('vd-final-row').hidden = true; $('btn-vd-improve-stop').hidden = false;
    st.busy = true; buttons(); H.busy(true);
    const r = await call('improveFinal', st.strip.id);
    H.busy(false); st.busy = false; buttons(); $('btn-vd-improve-stop').hidden = true;
    H.msg(r && r.ok ? `✔ ${r.say}` : `✖ ${(r && r.message) || 'The full video could not be made.'}`);
    if (!r || !r.ok) { stripMsg(`✖ ${(r && r.message) || 'The full video could not be made.'}`); if (r && r.error === 'VIDEO_CANCELLED') $('vd-final-row').hidden = false; return; }
    st.strip.items.push(itemOf(r.final)); st.strip.sel = st.strip.items.length - 1; renderStrip();
    stripMsg(`✔ ${r.say}`); showRound(st.strip.items[st.strip.sel]); H.loadGallery();
  };
  $('btn-vd-final-skip').onclick = () => { $('vd-final-row').hidden = true; $('btn-vd-improve-stop').hidden = true; stripMsg('The previews stay in the gallery; nothing else is made.'); };
  $('btn-vd-improve-stop').onclick = async () => { stripMsg('⏹ Stopping…'); await call('improveStop'); };
  $('btn-vd-improve-keep').onclick = () => { const it = st.strip && st.strip.items[st.strip.sel]; if (it) { showRound(it); H.msg(`✔ Kept ${it.label}${it.overall != null ? ` (${it.overall}/10)` : ''}. The others stay in the gallery.`); } };
  $('btn-vd-improve-recipe').onclick = () => {
    const it = st.strip && st.strip.items[st.strip.sel]; if (!it) return;
    if (it.settings) openNameRow('round', { settings: it.settings, name: '' }); else if (it.path) openNameRow('video', { path: it.path });
  };

  // ------------------------------------------------------------ judge settings · the trailer's switch
  async function loadSettings() {
    const r = await call('judgeSettings'); if (!r || !r.ok) return;
    st.settings = r.settings;
    $('vd-judge-rounds').value = String(r.settings.rounds); $('vd-judge-preview').value = String(r.settings.previewSeconds); $('vd-best-count').value = String(r.settings.bestCount);
    if ($('vd-tr-judge')) $('vd-tr-judge').checked = !!r.settings.autoTrailer;
  }
  for (const [id, key] of [['vd-judge-rounds', 'rounds'], ['vd-judge-preview', 'previewSeconds'], ['vd-best-count', 'bestCount']]) $(id).addEventListener('change', () => call('judgeSettings', { [key]: Number($(id).value) }));
  if ($('vd-tr-judge')) $('vd-tr-judge').addEventListener('change', () => call('judgeSettings', { autoTrailer: !!$('vd-tr-judge').checked }));

  let started = false;
  function start() { if (started) return; started = true; loadRecipes(); loadSettings(); }
  $('tab-app-video').addEventListener('click', () => setTimeout(start, 50));
  if (!$('video-tab').hidden) start();
  window.vdJudge = { decorate, wantBest, makeBest, reloadRecipes: loadRecipes, useRecipe };
})();
