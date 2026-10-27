'use strict';
/*
 * llm-models-ui.js — "🔎 Find a model" for Alfred's AI, in the 🤵 Butler section
 * (<div id="llm-models">). Search the Ollama library and Hugging Face, see how
 * each model fits THIS PC (★★★ great / ★★ good / ★ slow / ✖ too big, with a
 * plain-English reason), filter for 🔓 uncensored or 🛠 can-use-tools models, pick
 * a size (the best one that fits is chosen for you) and ⬇ Download it — the
 * button is disabled, with the reason, when a model is too big. Optional
 * Hugging Face token for gated models.
 * Talks only to window.api.llmSearch / llmCurated / llmHfFiles / llmHardware /
 * llmPull / llmSetHfToken / onLlm (preload.js). Anything missing → it says so
 * in plain words and keeps working with what's there. If llm-hardware.js is
 * loaded first (window.LlmHardware) it rates sizes the main process didn't.
 */
(function () {
  const root = document.getElementById('llm-models');
  if (!root) return;
  const api = window.api || {};
  const has = (fn) => typeof api[fn] === 'function';
  const HW = window.LlmHardware || null;

  const st = {
    hw: null, models: [], errors: [], mode: 'curated', busy: false, query: '',
    sources: { ollama: true, hf: true }, uncensored: false, toolsOnly: false,
    pulls: {}, // pullName → { state:'running'|'done'|'error', percent, text }
    choice: {}, // model id → chosen variant tag
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtSize(n) { if (!n) return ''; const g = n / (1024 * 1024 * 1024); return g >= 1 ? `${g >= 10 ? Math.round(g) : g.toFixed(1)} GB` : `${Math.round(n / (1024 * 1024))} MB`; }
  function fmtCount(n) { if (n == null) return ''; if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`; if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`; if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`; return String(n); }
  async function call(fn, ...args) {
    if (!has(fn)) return { ok: false, error: 'NO_API', message: 'This part of the app isn\'t available yet (update or restart AutoInjector).' };
    try { const r = await api[fn](...args); return r == null ? { ok: false, message: 'No answer.' } : r; }
    catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
  }
  const $ = (sel) => root.querySelector(sel);

  // ------------------------------------------------------------------ skeleton
  if (!document.getElementById('llmm-style')) {
    const style = document.createElement('style');
    style.id = 'llmm-style';
    style.textContent = [
      '#llm-models{border:1px solid #1c2a20;border-radius:8px;padding:8px 10px;margin:6px 0;background:#0b110d;font-size:12px;}',
      '#llm-models .llmm-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '#llm-models h3{margin:0;font-size:13px;}',
      '#llm-models .llmm-hw{opacity:.8;font-size:11.5px;}',
      '#llm-models .llmm-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0;}',
      '#llm-models input[type=search],#llm-models input[type=password]{flex:1 1 160px;min-width:0;}',
      '#llm-models .llmm-chip[aria-pressed=true]{background:#1f3a29;border-color:#3f7a55;}',
      '#llm-models .llmm-msg{min-height:14px;opacity:.85;font-size:11.5px;}',
      '#llm-models .llmm-err{color:#f0b08e;}',
      '#llm-models .llmm-results{display:flex;flex-direction:column;gap:6px;max-height:520px;overflow:auto;}',
      '#llm-models .llmm-card{border:1px solid #23362a;border-radius:7px;padding:6px 8px;background:#0d150f;}',
      '#llm-models .llmm-card[data-rating="too-big"]{opacity:.75;}',
      '#llm-models .llmm-title{font-weight:600;}',
      '#llm-models .llmm-badge{display:inline-block;font-size:10.5px;border:1px solid #2c4434;border-radius:9px;padding:0 6px;margin-left:4px;}',
      '#llm-models .llmm-desc{opacity:.75;font-size:11px;margin:2px 0;}',
      '#llm-models .llmm-fit{font-weight:600;}',
      '#llm-models .llmm-fit[data-rating=great]{color:#8ef0b0;}#llm-models .llmm-fit[data-rating=good]{color:#c8f08e;}',
      '#llm-models .llmm-fit[data-rating=slow]{color:#f0d88e;}#llm-models .llmm-fit[data-rating="too-big"]{color:#f09a8e;}',
      '#llm-models .llmm-reason{opacity:.8;font-size:11px;}',
      '#llm-models .llmm-prog{font-size:11px;opacity:.9;}',
    ].join('\n');
    (document.head || document.body).appendChild(style);
  }

  root.innerHTML = `
    <div class="llmm-head"><h3>🔎 Find a model</h3><span class="llmm-hw" id="llmm-hw">Checking this PC…</span></div>
    <div class="llmm-row">
      <input type="search" id="llmm-q" placeholder="Search models, e.g. qwen, llama, hermes, coder" aria-label="Search models">
      <button id="llmm-go" class="primary">Search</button>
      <button id="llmm-curated" title="Hand-picked models that work well with Alfred, rated for this PC (works offline)">⭐ Recommended</button>
    </div>
    <div class="llmm-row" role="group" aria-label="Where to search and filters">
      <button class="llmm-chip" id="llmm-src-ollama" aria-pressed="true" title="Search the Ollama library">Ollama library</button>
      <button class="llmm-chip" id="llmm-src-hf" aria-pressed="true" title="Search Hugging Face (GGUF models Ollama can download)">Hugging Face</button>
      <button class="llmm-chip" id="llmm-unc" aria-pressed="false" title="Show uncensored models first (abliterated, Dolphin, Hermes…)">🔓 Uncensored</button>
      <button class="llmm-chip" id="llmm-tools" aria-pressed="false" title="Only models that can use tools (Alfred works best with these)">🛠 Can use tools</button>
    </div>
    <div class="llmm-msg" id="llmm-msg" aria-live="polite"></div>
    <div class="llmm-results" id="llmm-results"></div>
    <details class="llmm-hf" id="llmm-hf">
      <summary>Hugging Face token (optional)</summary>
      <p class="llmm-desc">Only needed for "gated" models (🔒) that ask you to accept their terms first. Make a free <b>read</b> token on huggingface.co → Settings → Access Tokens and paste it here. It's stored safely on this PC and never shown in logs.</p>
      <div class="llmm-row">
        <input type="password" id="llmm-hf-token" placeholder="hf_…" autocomplete="off" aria-label="Hugging Face token">
        <button id="llmm-hf-save">Connect</button>
        <button id="llmm-hf-clear">Disconnect</button>
      </div>
      <div class="llmm-msg" id="llmm-hf-msg"></div>
    </details>`;

  function msg(text, isErr) { const m = $('#llmm-msg'); m.textContent = text || ''; m.classList[isErr ? 'add' : 'remove']('llmm-err'); }

  // ------------------------------------------------------------------ hardware
  function describe(hw) {
    if (HW && HW.describeHardware) return HW.describeHardware(hw);
    if (!hw) return 'Could not check this PC';
    const g = (hw.gpus || []).slice().sort((a, b) => (b.vramMB || 0) - (a.vramMB || 0))[0];
    const gb = (mb) => `${Math.round(mb / 1024)} GB`;
    return [g ? `${g.name}${g.vramMB ? ` ${gb(g.vramMB)}` : ''}` : 'No graphics card', hw.ramMB ? `${gb(hw.ramMB)} RAM` : ''].filter(Boolean).join(' · ');
  }
  async function loadHardware() {
    const r = await call('llmHardware');
    if (r && r.ok !== false) {
      st.hw = r.hardware || r;
      $('#llmm-hw').textContent = `Your PC: ${describe(st.hw)}`;
      const notes = (st.hw.notes || []).join(' ');
      if (notes) $('#llmm-hw').title = notes;
    } else $('#llmm-hw').textContent = r.error === 'NO_API' ? 'Your PC: (can\'t check yet)' : `Your PC: couldn't check (${r.message || r.error || 'unknown'})`;
  }

  // ------------------------------------------------------------------ fit helpers
  function fitOf(v) {
    if (v && v.fit) return v.fit;
    if (HW && v && v.sizeBytes && st.hw) return HW.rateFit(v.sizeBytes, st.hw);
    return { rating: 'unknown', stars: 0, label: '? Fit unknown', reason: 'We can\'t tell how well this runs here yet.' };
  }
  function chosenVariant(m) {
    const vs = m.variants || [];
    const tag = st.choice[m.id] || m.pick;
    return vs.find((v) => v.tag === tag) || vs.find((v) => v.pullName === m.pullName) || vs[0] || null;
  }

  // ------------------------------------------------------------------ rendering
  function badges(m) {
    const b = [];
    if (m.uncensored) b.push('<span class="llmm-badge" data-badge="uncensored" title="Uncensored: fewer refusals">🔓 uncensored</span>');
    if (m.tools === true) b.push('<span class="llmm-badge" data-badge="tools" title="Can use tools (Alfred works best with these)">🛠 tools</span>');
    if (m.vision) b.push('<span class="llmm-badge" data-badge="vision" title="Can look at pictures">👁 vision</span>');
    if (m.thinking) b.push('<span class="llmm-badge" data-badge="thinking" title="Thinks before answering">💭 thinking</span>');
    if (m.gated) b.push('<span class="llmm-badge" data-badge="gated" title="You must accept its terms on Hugging Face and connect your token">🔒 gated</span>');
    const src = m.source === 'hf' ? 'Hugging Face' : (m.source === 'ollama' ? 'Ollama' : 'Recommended');
    b.push(`<span class="llmm-badge" data-badge="source">${src}</span>`);
    return b.join('');
  }
  function variantLabel(v) {
    const f = fitOf(v);
    const name = v.tag && v.tag.includes(':') ? v.tag.split(':').pop() : (v.tag || v.quant || 'default');
    const extra = v.quant && !String(name).toUpperCase().includes(String(v.quant).toUpperCase()) ? ` ${v.quant}` : '';
    return `${name}${extra} — ${v.sizeBytes ? `${v.estimated ? '~' : ''}${fmtSize(v.sizeBytes)}` : 'size ?'} — ${f.label}`;
  }
  function cardHtml(m, i) {
    const v = chosenVariant(m);
    const f = fitOf(v);
    const pull = v ? st.pulls[v.pullName] : null;
    const tooBig = f.rating === 'too-big';
    const running = pull && pull.state === 'running';
    const opts = (m.variants || []).map((x) => `<option value="${esc(x.tag)}"${v && x.tag === v.tag ? ' selected' : ''}>${esc(variantLabel(x))}</option>`).join('');
    const stats = [m.downloads != null ? `⬇ ${fmtCount(m.downloads)}` : '', m.likes != null ? `♥ ${fmtCount(m.likes)}` : ''].filter(Boolean).join(' · ');
    const size = v && v.sizeBytes ? `${v.estimated ? 'about ' : ''}${fmtSize(v.sizeBytes)} download` : 'size unknown';
    return `<div class="llmm-card" data-i="${i}" data-id="${esc(m.id)}" data-rating="${esc(f.rating)}" data-uncensored="${m.uncensored ? 1 : 0}">
      <div><span class="llmm-title">${esc(m.title || m.name)}</span>${badges(m)}
        ${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener" class="llmm-link" style="font-size:10.5px;margin-left:6px;">page ↗</a>` : ''}</div>
      ${m.description ? `<div class="llmm-desc">${esc(m.description)}</div>` : ''}
      <div><span class="llmm-fit" data-rating="${esc(f.rating)}">${esc(f.label)}</span> <span class="llmm-size" style="opacity:.75;">· ${esc(size)}${stats ? ` · ${esc(stats)}` : ''}</span></div>
      <div class="llmm-reason">${esc(f.reason || '')}</div>
      <div class="llmm-row">
        ${opts ? `<select class="llmm-variant" aria-label="Size">${opts}</select>` : ''}
        ${m.source === 'hf' && !m.filesLoaded ? '<button class="llmm-files" title="Look up the exact files and sizes on Hugging Face">📂 Exact sizes</button>' : ''}
        <button class="llmm-dl primary"${tooBig || running || !v ? ' disabled' : ''} title="${esc(tooBig ? `Can't download: ${f.reason}` : (v ? `Download ${v.pullName}` : 'Nothing to download'))}">${running ? '⏳ Downloading…' : (pull && pull.state === 'done' ? '✔ Downloaded' : '⬇ Download')}</button>
        ${tooBig ? '<span class="llmm-why" style="font-size:11px;color:#f09a8e;">Too big for this PC — pick a smaller size.</span>' : ''}
      </div>
      ${pull ? `<div class="llmm-prog"${pull.state === 'error' ? ' style="color:#f0b08e"' : ''}>${esc(pull.text || '')}</div>` : ''}
      ${m.note ? `<div class="llmm-desc">${esc(m.note)}</div>` : ''}
    </div>`;
  }
  function visibleModels() {
    let list = st.models.slice();
    if (st.toolsOnly) list = list.filter((m) => m.tools === true);
    if (st.uncensored) list.sort((a, b) => (b.uncensored ? 1 : 0) - (a.uncensored ? 1 : 0)); // stable: keeps rank inside each group
    return list;
  }
  function render() {
    const list = visibleModels();
    const box = $('#llmm-results');
    if (!list.length) {
      box.innerHTML = st.busy ? '' : `<div class="llmm-desc">${st.mode === 'search' ? 'No models found. Try another word, or press ⭐ Recommended.' : 'No models to show yet.'}</div>`;
      return;
    }
    box.innerHTML = list.map((m) => cardHtml(m, st.models.indexOf(m))).join('');
  }

  // ------------------------------------------------------------------ loading
  function toArray(r) { if (Array.isArray(r)) return r; if (r && Array.isArray(r.models)) return r.models; return []; }
  async function loadCurated() {
    st.mode = 'curated'; st.busy = true; msg('Loading recommended models…'); render();
    const r = await call('llmCurated', { uncensored: st.uncensored, toolsOnly: st.toolsOnly });
    st.busy = false;
    if (r && r.error === 'NO_API') { st.models = []; render(); msg(r.message, true); return; }
    st.models = toArray(r);
    if (!st.models.length && r && r.ok === false) msg(r.message || r.error || 'Couldn\'t load the recommended models.', true);
    else msg(`Recommended for Alfred, rated for this PC${st.uncensored ? ' — 🔓 uncensored first' : ''}.`);
    render();
  }
  async function doSearch() {
    const q = $('#llmm-q').value.trim();
    const sources = Object.keys(st.sources).filter((k) => st.sources[k]);
    if (!sources.length) { msg('Pick at least one place to search: Ollama library or Hugging Face.', true); return; }
    if (!q && !st.uncensored) { loadCurated(); return; }
    st.mode = 'search'; st.query = q; st.busy = true;
    msg(`Searching ${sources.map((s) => (s === 'hf' ? 'Hugging Face' : 'the Ollama library')).join(' and ')}…`); render();
    $('#llmm-go').disabled = true;
    const r = await call('llmSearch', q, { sources, uncensored: st.uncensored, toolsOnly: st.toolsOnly });
    $('#llmm-go').disabled = false;
    st.busy = false;
    if (r && r.error === 'NO_API') { msg(r.message, true); render(); return; }
    st.models = toArray(r);
    st.errors = (r && r.errors) || [];
    const errText = st.errors.map((e) => e.message).filter(Boolean).join(' ');
    if (!st.models.length && (r.ok === false || errText)) msg(`${errText || r.message || r.error || 'Search failed.'} You can still use ⭐ Recommended (works offline).`, true);
    else msg(`${st.models.length} model${st.models.length === 1 ? '' : 's'} found${errText ? ` — ${errText}` : ''}.`, !!errText);
    render();
  }

  async function loadFiles(m) {
    const r = await call('llmHfFiles', m.repo || String(m.name || '').replace(/^hf:/, ''));
    if (!r || r.ok === false || !Array.isArray(r.variants) || !r.variants.length) {
      m.note = (r && (r.error && r.error !== 'NO_API' ? r.error : r.message)) || 'Couldn\'t load the file list.';
      if (r && r.gated) m.gated = true;
      return false;
    }
    m.variants = r.variants.map((v) => Object.assign({}, v, { fit: v.fit || fitOf(v) }));
    m.filesLoaded = true;
    if (r.tools != null) m.tools = r.tools;
    if (r.vision) m.vision = true;
    if (r.gated != null) m.gated = !!r.gated || m.gated;
    if (r.uncensored) m.uncensored = true;
    m.note = r.note || '';
    let pick = r.pick ? m.variants.find((v) => v.tag === r.pick) : null;
    if (!pick && HW && st.hw) { const p = HW.pickVariant(m.variants, st.hw); pick = p ? m.variants.find((v) => v.pullName === p.pullName) : null; }
    if (!pick) pick = m.variants[0];
    m.pick = pick.tag; delete st.choice[m.id];
    m.fit = fitOf(pick); m.pullName = pick.pullName; m.sizeBytes = pick.sizeBytes;
    return true;
  }

  async function download(m) {
    if (m.source === 'hf' && !m.filesLoaded) {
      msg('Checking the exact files on Hugging Face…');
      const ok = await loadFiles(m);
      render();
      if (!ok) { msg(m.note, true); return; }
    }
    const v = chosenVariant(m);
    if (!v) { msg('Nothing to download for this model.', true); return; }
    const f = fitOf(v);
    if (f.rating === 'too-big') { msg(`Not downloading ${v.pullName}: ${f.reason}`, true); render(); return; }
    if (!has('llmPull')) { msg('Downloading isn\'t available yet (update or restart AutoInjector).', true); return; }
    st.pulls[v.pullName] = { state: 'running', percent: 0, text: `Starting download of ${v.pullName}…` };
    render();
    const r = await call('llmPull', v.pullName, { sizeBytes: v.sizeBytes || null });
    const ok = r && r.ok !== false;
    st.pulls[v.pullName] = ok
      ? { state: 'done', percent: 100, text: `✔ Downloaded ${v.pullName}. You can now pick it for Alfred.` }
      : { state: 'error', text: `✖ ${r.message || r.error || 'The download failed.'}` };
    msg(st.pulls[v.pullName].text, !ok);
    render();
  }

  // Progress from main (channel "llm"): any event naming a model we're pulling.
  if (has('onLlm')) {
    try {
      api.onLlm((ev) => {
        const e = ev || {};
        const name = e.pullName || e.model || e.name;
        if (!name || !st.pulls[name] || st.pulls[name].state !== 'running') return;
        const pct = Number.isFinite(Number(e.percent)) ? Math.round(Number(e.percent)) : null;
        const extra = [e.speed || (e.mbps ? `${Number(e.mbps).toFixed(1)} MB/s` : ''), e.eta ? `about ${e.eta} left` : ''].filter(Boolean).join(' · ');
        const text = `${pct != null ? `${pct}% · ` : ''}${e.status || e.message || 'downloading…'}${extra ? ` · ${extra}` : ''}`;
        st.pulls[name] = Object.assign({}, st.pulls[name], { percent: pct, text });
        const card = [...root.querySelectorAll('.llmm-card')].find((c) => {
          const m = st.models[Number(c.dataset.i)]; const v = m && chosenVariant(m); return v && v.pullName === name;
        });
        const p = card && card.querySelector('.llmm-prog');
        if (p) p.textContent = text; else render();
      });
    } catch (_) {}
  }

  // ------------------------------------------------------------------ wiring
  function toggle(btn, on) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  $('#llmm-go').addEventListener('click', doSearch);
  $('#llmm-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault && e.preventDefault(); doSearch(); } });
  $('#llmm-curated').addEventListener('click', () => { $('#llmm-q').value = ''; loadCurated(); });
  for (const src of ['ollama', 'hf']) {
    const b = $(`#llmm-src-${src}`);
    b.addEventListener('click', () => { st.sources[src] = !st.sources[src]; toggle(b, st.sources[src]); });
  }
  $('#llmm-unc').addEventListener('click', () => {
    st.uncensored = !st.uncensored; toggle($('#llmm-unc'), st.uncensored);
    if (st.mode === 'curated') loadCurated(); else if (st.uncensored) doSearch(); else render();
  });
  $('#llmm-tools').addEventListener('click', () => {
    st.toolsOnly = !st.toolsOnly; toggle($('#llmm-tools'), st.toolsOnly);
    render();
  });
  $('#llmm-results').addEventListener('click', async (e) => {
    const t = e.target;
    const card = t && t.closest ? t.closest('.llmm-card') : null;
    if (!card) return;
    const m = st.models[Number(card.dataset.i)];
    if (!m) return;
    if (t.classList.contains('llmm-dl')) { if (!t.disabled) await download(m); }
    else if (t.classList.contains('llmm-files')) { t.disabled = true; t.textContent = 'Looking…'; await loadFiles(m); render(); }
  });
  $('#llmm-results').addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.classList || !t.classList.contains('llmm-variant')) return;
    const card = t.closest('.llmm-card');
    const m = card && st.models[Number(card.dataset.i)];
    if (!m) return;
    st.choice[m.id] = t.value;
    render();
  });
  $('#llmm-hf-save').addEventListener('click', async () => {
    const input = $('#llmm-hf-token');
    const tok = String(input.value || '').trim();
    if (!tok) { $('#llmm-hf-msg').textContent = 'Paste your Hugging Face token first (it starts with "hf_").'; return; }
    const r = await call('llmSetHfToken', tok);
    input.value = ''; // never keep the token in the page
    $('#llmm-hf-msg').textContent = r && r.ok !== false ? '✔ Hugging Face connected. Gated models you\'ve accepted can now be downloaded.' : `✖ ${r.message || r.error || 'Couldn\'t save the token.'}`;
  });
  $('#llmm-hf-clear').addEventListener('click', async () => {
    const r = await call('llmSetHfToken', '');
    $('#llmm-hf-msg').textContent = r && r.ok !== false ? 'Hugging Face disconnected.' : `✖ ${r.message || r.error || 'Couldn\'t remove the token.'}`;
  });

  // ------------------------------------------------------------------ start
  const ready = (async () => {
    const missing = ['llmSearch', 'llmCurated', 'llmHardware', 'llmPull'].filter((f) => !has(f));
    await loadHardware();
    await loadCurated();
    if (missing.length === 4) msg('The model finder isn\'t connected yet (update or restart AutoInjector).', true);
  })();

  window.llmModelsUI = { state: st, ready, render, search: doSearch, curated: loadCurated, loadHardware };
})();
