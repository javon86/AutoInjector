'use strict';
/*
 * llm-models-ui.js — "🔎 Find a model" for Alfred's AI, in the 🤵 Butler section
 * (<div id="llm-models">). Search the Ollama library and Hugging Face, see how
 * each model fits THIS PC (★★★ Excellent / ★★ Good / ★ OK / 🐢 Slow / ✖ too big, with
 * a plain-English reason), about how fast it answers here (an estimate, or the speed
 * Alfred measured), and whether it is a good pick for Alfred (✔ / ◐ / ✖). The list
 * is ordered: good picks first, then fit, then speed. 🔓 Uncensored lists
 * ONLY uncensored models (live Ollama library + Hugging Face, exact sizes → the
 * quant that fits; offline → the last list saved on this PC or the built-in one),
 * each with what "uncensored" means and a 🛠 tool-use hint; models on this PC get a
 * 🧪 "What will it write?" test (llm-write-test-ui.js). 🛠 = can-use-tools only. Pick
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
    speeds: {}, // model name → tokens/second Alfred measured on this PC (from main)
    installed: new Set(), // names Ollama has now (lower case, ":latest" added)
    wt: {}, // pullName → 🧪 test state {state, step, of, result, error}
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
      '#llm-models{border:1px solid #1c2a20;border-radius:8px;padding:6px 10px;margin:0;background:#0b110d;font-size:12px;}',
      '#llm-models .llmm-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '#llm-models .llmm-fold>summary{cursor:pointer;list-style:none;}#llm-models .llmm-fold>summary::-webkit-details-marker{display:none;}',
      '#llm-models .llmm-fold>summary h3::before{content:"▸ ";}#llm-models .llmm-fold[open]>summary h3::before{content:"▾ ";}',
      '#llm-models .llmm-fold[open]>summary{margin-bottom:4px;}',
      '#llm-models h3{margin:0;font-size:13px;}',
      '#llm-models .llmm-hw{opacity:.8;font-size:11.5px;}',
      '#llm-models .llmm-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0;}',
      '#llm-models input[type=search],#llm-models input[type=password]{flex:1 1 160px;min-width:0;}',
      '#llm-models .llmm-chip[aria-pressed=true]{background:#1f3a29;border-color:#3f7a55;}',
      '#llm-models .llmm-msg{min-height:14px;opacity:.85;font-size:11.5px;}',
      '#llm-models .llmm-err{color:#f0b08e;}',
      '#llm-models .llmm-results{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px;max-height:560px;overflow:auto;align-content:start;}',
      '#llm-models .llmm-results>.llmm-desc{grid-column:1/-1;}',
      '#llm-models .llmm-card{border:1px solid #23362a;border-radius:8px;padding:7px 8px;background:#0d150f;display:flex;flex-direction:column;gap:3px;min-width:0;}',
      '#llm-models .llmm-card .llmm-desc,#llm-models .llmm-card .llmm-reason{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '#llm-models .llmm-card .llmm-row{margin:auto 0 0;padding-top:4px;}',
      '#llm-models .llmm-card .llmm-variant{flex:1 1 100%;min-width:0;max-width:100%;}',
      '#llm-models .llmm-card .llmm-dl{flex:1 1 auto;}',
      '#llm-models .llmm-card[data-rating="too-big"]{opacity:.75;}',
      '#llm-models .llmm-title{font-weight:600;}',
      '#llm-models .llmm-badge{display:inline-block;font-size:10.5px;border:1px solid #2c4434;border-radius:9px;padding:0 6px;margin-left:4px;}',
      '#llm-models .llmm-desc{opacity:.75;font-size:11px;margin:2px 0;}',
      '#llm-models .llmm-fit{font-weight:600;}',
      '#llm-models .llmm-fit[data-rating=excellent]{color:#8ef0b0;}#llm-models .llmm-fit[data-rating=good]{color:#c8f08e;}#llm-models .llmm-fit[data-rating=ok]{color:#e4f08e;}',
      '#llm-models .llmm-fit[data-rating=slow]{color:#f0d88e;}#llm-models .llmm-fit[data-rating="too-big"]{color:#f09a8e;}',
      '#llm-models .llmm-speed{font-size:11px;opacity:.9;}#llm-models .llmm-speed[data-measured="1"]{color:#8fd3ff;}',
      '#llm-models .llmm-verdict{font-size:11.5px;font-weight:600;}',
      '#llm-models .llmm-verdict[data-verdict=good]{color:#8ef0b0;}#llm-models .llmm-verdict[data-verdict=mixed]{color:#f0d88e;}#llm-models .llmm-verdict[data-verdict=bad]{color:#f09a8e;}',
      '#llm-models .llmm-reason{opacity:.8;font-size:11px;}',
      '#llm-models .llmm-link{color:#8fb3ff;white-space:nowrap;}',
      '#llm-models .llmm-prog{font-size:11px;opacity:.9;}',
      '#llm-models .llmm-spec{font-size:11px;opacity:.85;}',
      '#llm-models .llmm-unc-line{font-size:11px;color:#d6c3ff;}',
      '#llm-models .llmm-tool-hint{font-size:11px;}#llm-models .llmm-tool-hint[data-good="1"]{color:#8ef0b0;}#llm-models .llmm-tool-hint[data-good="0"]{color:#f0d88e;}',
      '#llm-models .llmm-unc-note{border:1px solid #3d3360;background:#120f1c;border-radius:7px;padding:5px 8px;font-size:11.5px;margin:4px 0;}',
      '#llm-models .llmm-unc-note[hidden]{display:none;}',
      '#llm-models .llmm-card .llmm-wt{flex:1 1 100%;}',
    ].join('\n');
    (document.head || document.body).appendChild(style);
  }

  root.innerHTML = `
    <details class="llmm-fold" id="llmm-fold">
    <summary class="llmm-head"><h3>🔎 Find &amp; download more models</h3><span class="llmm-hw" id="llmm-hw">Checking this PC…</span></summary>
    <div class="llmm-row">
      <input type="search" id="llmm-q" placeholder="Search models, e.g. qwen, llama, hermes, coder" aria-label="Search models">
      <button id="llmm-go" class="primary">Search</button>
      <button id="llmm-curated" title="Hand-picked models that work well with Alfred, rated for this PC (works offline)">⭐ Recommended</button>
    </div>
    <div class="llmm-row" role="group" aria-label="Where to search and filters">
      <button class="llmm-chip" id="llmm-src-ollama" aria-pressed="true" title="Search the Ollama library">Ollama library</button>
      <button class="llmm-chip" id="llmm-src-hf" aria-pressed="true" title="Search Hugging Face (GGUF models Ollama can download)">Hugging Face</button>
      <button class="llmm-chip" id="llmm-unc" aria-pressed="false" title="Only uncensored models (abliterated, Dolphin, Hermes…) from the Ollama library and Hugging Face, rated for this PC">🔓 Uncensored</button>
      <button class="llmm-chip" id="llmm-tools" aria-pressed="false" title="Only models that can use tools (Alfred works best with these)">🛠 Can use tools</button>
    </div>
    <div class="llmm-unc-note" id="llmm-unc-note" hidden>🔓 <b>Uncensored models</b> won't refuse dark or adult fiction, but they are <b>not smarter</b> than the model they come from — the quality varies from one to another, so try the 🧪 <b>What will it write?</b> test once it's downloaded. Everything runs on this PC. You are responsible for what you publish.</div>
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
    </details>
    </details>`;

  // Folded by default (it is long); remembers your choice.
  const fold = root.querySelector('#llmm-fold');
  try { if (window.localStorage && window.localStorage.getItem('llmm-open') === '1') fold.open = true; } catch (_) {}
  fold.addEventListener('toggle', () => { try { if (window.localStorage) window.localStorage.setItem('llmm-open', fold.open ? '1' : '0'); } catch (_) {} });
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
  function speedKey(name) { const n = String(name || '').trim().toLowerCase(); return !n ? '' : /:[^/]+$/.test(n) ? n : `${n}:latest`; }
  /** tokens/second Alfred measured for this download, or null. */
  function measuredFor(pullName) {
    const want = speedKey(pullName);
    if (!want) return null;
    for (const k of Object.keys(st.speeds || {})) {
      if (speedKey(k) !== want) continue;
      const v = st.speeds[k]; const t = Number(v && typeof v === 'object' ? v.tokensPerSec : v);
      return Number.isFinite(t) && t > 0 ? t : null;
    }
    return null;
  }
  /** About how fast it answers here: the measured speed when Alfred has used it, else the estimate. */
  function speedOf(m, v) {
    if (HW && HW.estimateSpeed && v && (st.hw || measuredFor(v.pullName))) return HW.estimateSpeed(v.sizeBytes, st.hw, { fit: fitOf(v), measured: measuredFor(v.pullName) });
    return (v && v.speed) || (m && m.speed) || null;
  }
  /** ✔ Good pick for Alfred / ◐ Works, but … / ✖ Not a good pick: … */
  function verdictOf(m, v) {
    const f = fitOf(v);
    if (HW && HW.verdictFor) return HW.verdictFor(m, f, v);
    if (m && m.verdict && (!v || v.pullName === m.pullName)) return m.verdict;
    if (f.rating === 'too-big') return { kind: 'bad', label: '✖ Not a good pick: it is too big for this PC' };
    return { kind: 'mixed', label: '◐ Works, but we couldn\'t check everything about it here' };
  }
  /** Good picks first, then fit, then speed (🔓 order goes on top when it is on). Done once per load — never while you pick a size. */
  function sortModels() {
    if (!HW || !HW.compareChoice) return;
    const info = new Map(st.models.map((m, i) => { const v = chosenVariant(m); return [m, { i, verdict: verdictOf(m, v), fit: fitOf(v), speed: speedOf(m, v) }]; }));
    const bad = (x) => (x.verdict && x.verdict.kind === 'bad' ? 1 : 0);
    st.models.sort((a, b) => { const A = info.get(a), B = info.get(b); return (bad(A) - bad(B)) || HW.compareChoice(A, B) || (A.i - B.i); });
  }
  function chosenVariant(m) {
    const vs = m.variants || [];
    const tag = st.choice[m.id] || m.pick;
    return vs.find((v) => v.tag === tag) || vs.find((v) => v.pullName === m.pullName) || vs[0] || null;
  }

  // ------------------------------------------------------------------ on this PC + 🧪
  function isInstalled(pullName) {
    const k = speedKey(pullName);
    return !!k && (st.installed.has(k) || !!(st.pulls[pullName] && st.pulls[pullName].state === 'done'));
  }
  function setInstalled(names) {
    st.installed = new Set((Array.isArray(names) ? names : []).map((n) => speedKey(n && typeof n === 'object' ? n.name : n)).filter(Boolean));
    render();
  }
  const WT = () => window.LlmWriteTestUI || null;
  async function runWriteTest(pullName) {
    if (!WT()) { msg('The writing test isn\'t available yet (update or restart AutoInjector).', true); return; }
    await WT().run(pullName, (state) => { st.wt[pullName] = state; render(); });
  }
  function toolHintOf(m) {
    if (m.toolHint && m.toolHint.label) return m.toolHint;
    return m.tools === true ? { good: true, label: '🛠 good for Alfred\'s tools' } : { good: false, label: '⚠ may not use tools well' };
  }
  function uncLineOf(m) {
    if (m.uncensoredLine) return m.uncensoredLine;
    return /abliterat|heretic|obliterat/i.test(`${m.name} ${m.title}`) ? 'Uncensored: refusals removed (abliterated) — knowledge and skill same as the base model' : 'Uncensored: re-trained to follow instructions without refusing — knowledge and skill close to the base model';
  }
  function specOf(m, v) {
    const p = (v && v.params) || m.params;
    const q = (v && v.quant) || m.quant;
    const size = v && v.sizeBytes ? `${v.estimated ? '~' : ''}${fmtSize(v.sizeBytes)}` : '';
    return [p ? `${Math.round(p * 10) / 10}B parameters` : '', q || '', size].filter(Boolean).join(' · ');
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
    const sp = speedOf(null, v);
    return `${name}${extra} — ${v.sizeBytes ? `${v.estimated ? '~' : ''}${fmtSize(v.sizeBytes)}` : 'size ?'} — ${f.label}${sp && sp.tokensPerSec ? ` — ${sp.short}` : ''}`;
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
    const sp = speedOf(m, v);
    const vd = verdictOf(m, v);
    const here = v && isInstalled(v.pullName);
    const th = toolHintOf(m);
    const wt = v ? st.wt[v.pullName] : null;
    const showUnc = m.uncensored && (st.uncensored || m.uncensoredLine);
    return `<div class="llmm-card" data-i="${i}" data-id="${esc(m.id)}" data-rating="${esc(f.rating)}" data-verdict="${esc(vd.kind)}" data-uncensored="${m.uncensored ? 1 : 0}" data-installed="${here ? 1 : 0}">
      <div><span class="llmm-title">${esc(m.title || m.name)}</span>${badges(m)}
        ${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener" class="llmm-link" style="font-size:10.5px;margin-left:6px;">page ↗</a>` : ''}</div>
      ${m.description ? `<div class="llmm-desc" title="${esc(m.description)}">${esc(m.description)}</div>` : ''}
      ${specOf(m, v) ? `<div class="llmm-spec">${esc(specOf(m, v))}${here ? ' · <b>✔ on this PC</b>' : ''}</div>` : ''}
      ${showUnc ? `<div class="llmm-unc-line">${esc(uncLineOf(m))}</div>` : ''}
      ${showUnc || m.toolHint ? `<div class="llmm-tool-hint" data-good="${th.good ? 1 : 0}">${esc(th.label)}</div>` : ''}
      <div><span class="llmm-fit" data-rating="${esc(f.rating)}">${esc(f.label)}</span> <span class="llmm-size" style="opacity:.75;">· ${esc(size)}${stats ? ` · ${esc(stats)}` : ''}</span></div>
      <div class="llmm-reason" title="${esc(f.reason || '')}">${esc(f.reason || '')}</div>
      ${sp ? `<div class="llmm-speed" data-measured="${sp.measured ? 1 : 0}" title="${esc(sp.measured ? 'How fast Alfred really answered with this model on this PC.' : 'An estimate from the model\'s size and how fast this PC\'s graphics card and memory are. It can be off by half either way.')}">${esc(sp.text)}</div>` : ''}
      <div class="llmm-verdict" data-verdict="${esc(vd.kind)}" title="${esc(vd.label)}">${esc(vd.label)}</div>
      <div class="llmm-row">
        ${opts ? `<select class="llmm-variant" aria-label="Size">${opts}</select>` : ''}
        ${m.source === 'hf' && !m.filesLoaded ? '<button class="llmm-files" title="Look up the exact files and sizes on Hugging Face">📂 Exact sizes</button>' : ''}
        <button class="llmm-dl primary"${tooBig || running || !v ? ' disabled' : ''} title="${esc(tooBig ? `Can't download: ${f.reason}` : (v ? `Download ${v.pullName}` : 'Nothing to download'))}">${running ? '⏳ Downloading…' : (pull && pull.state === 'done' ? '✔ Downloaded' : '⬇ Download')}</button>
        ${tooBig ? '<span class="llmm-why" style="font-size:11px;color:#f09a8e;">Too big for this PC — pick a smaller size.</span>' : ''}
        ${here ? `<button class="llmm-wt" title="Six short fiction requests run on this PC: what it writes, softens or refuses"${wt && wt.state === 'running' ? ' disabled' : ''}>${wt && wt.state === 'running' ? '🧪 Testing…' : (wt && wt.state === 'done' ? '🧪 Test again' : '🧪 What will it write?')}</button>` : ''}
      </div>
      ${wt && WT() ? WT().html(wt) : ''}
      ${pull ? `<div class="llmm-prog"${pull.state === 'error' ? ' style="color:#f0b08e"' : ''}>${esc(pull.text || '')}</div>` : ''}
      ${m.note ? `<div class="llmm-desc">${esc(m.note)}</div>` : ''}
    </div>`;
  }
  function visibleModels() {
    let list = st.models.slice();
    if (st.toolsOnly) list = list.filter((m) => m.tools === true);
    // 🔓 on: only the uncensored models (in the good-pick / fit / speed order)
    if (st.uncensored) list = list.filter((m) => m.uncensored);
    return list;
  }
  function render() {
    const list = visibleModels();
    const box = $('#llmm-results');
    if (!list.length) {
      box.innerHTML = st.busy ? '' : `<div class="llmm-desc">${st.mode === 'search' ? `No ${st.uncensored ? 'uncensored ' : ''}models found. Try another word, or press ⭐ Recommended.` : 'No models to show yet.'}</div>`;
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
    if (r && r.speeds && typeof r.speeds === 'object') st.speeds = r.speeds;
    sortModels();
    if (!st.models.length && r && r.ok === false) msg(r.message || r.error || 'Couldn\'t load the recommended models.', true);
    else msg(`Recommended for Alfred, rated for this PC${st.uncensored ? ' — 🔓 uncensored only' : ''}.`);
    render();
  }
  /** 🔓 the uncensored finder (live sources → saved list → built-in list). */
  async function loadUncensored() {
    if (!has('llmUncensored')) { await loadCurated(); return; }
    const sources = Object.keys(st.sources).filter((k) => st.sources[k]);
    st.mode = 'uncensored'; st.busy = true;
    msg(`Looking for uncensored models on ${(sources.length ? sources : ['ollama', 'hf']).map((x) => (x === 'hf' ? 'Hugging Face' : 'the Ollama library')).join(' and ')}…`); render();
    const r = await call('llmUncensored', { sources: sources.length ? sources : undefined });
    st.busy = false;
    if (!st.uncensored) return; // switched off while it looked
    if (r && r.error === 'NO_API') { msg(r.message, true); render(); return; }
    st.models = toArray(r).map((m) => Object.assign({}, m, { uncensored: true }));
    if (r && r.speeds && typeof r.speeds === 'object') st.speeds = r.speeds;
    if (r && Array.isArray(r.installed)) st.installed = new Set(r.installed.map(speedKey).filter(Boolean));
    sortModels();
    const errText = ((r && r.errors) || []).map((e) => e.message).filter(Boolean).join(' ');
    if (!st.models.length) msg((r && (r.message || r.error)) || errText || 'No uncensored models found right now. Try again later.', true);
    else if (r && (r.fromCache || r.offline)) msg(r.message || 'Showing a saved list.', true);
    else msg(`🔓 ${st.models.length} uncensored model${st.models.length === 1 ? '' : 's'}, rated for this PC${errText ? ` — ${errText}` : ''}.`, !!errText);
    render();
  }
  async function doSearch() {
    const q = $('#llmm-q').value.trim();
    const sources = Object.keys(st.sources).filter((k) => st.sources[k]);
    if (!sources.length) { msg('Pick at least one place to search: Ollama library or Hugging Face.', true); return; }
    if (!q) { if (st.uncensored && has('llmUncensored')) loadUncensored(); else loadCurated(); return; }
    st.mode = 'search'; st.query = q; st.busy = true;
    msg(`Searching ${sources.map((s) => (s === 'hf' ? 'Hugging Face' : 'the Ollama library')).join(' and ')}…`); render();
    $('#llmm-go').disabled = true;
    const r = await call('llmSearch', q, { sources, uncensored: st.uncensored, toolsOnly: st.toolsOnly });
    $('#llmm-go').disabled = false;
    st.busy = false;
    if (r && r.error === 'NO_API') { msg(r.message, true); render(); return; }
    st.models = toArray(r);
    if (r && r.speeds && typeof r.speeds === 'object') st.speeds = r.speeds;
    sortModels();
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
    if (ok) st.installed.add(speedKey(v.pullName));
    st.pulls[v.pullName] = ok
      ? { state: 'done', percent: 100, text: `✔ Downloaded ${v.pullName}. You can now pick it for Alfred${m.uncensored ? ', or press 🧪 What will it write?' : ''}.` }
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
    $('#llmm-unc-note').hidden = !st.uncensored;
    const q = $('#llmm-q').value.trim();
    if (st.uncensored) { if (q && st.mode === 'search') doSearch(); else loadUncensored(); }
    else if (st.mode === 'uncensored' || st.mode === 'curated') loadCurated();
    else render();
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
    else if (t.classList.contains('llmm-wt')) { const v = chosenVariant(m); if (v && !t.disabled) await runWriteTest(v.pullName); }
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
    try { const s = window.llmSetupUI && window.llmSetupUI.status && window.llmSetupUI.status(); if (s && Array.isArray(s.models)) st.installed = new Set(s.models.map((x) => speedKey(x.name)).filter(Boolean)); } catch (_) {}
    await loadCurated();
    if (missing.length === 4) msg('The model finder isn\'t connected yet (update or restart AutoInjector).', true);
  })();

  window.llmModelsUI = { open: (v) => { fold.open = v !== false; }, state: st, ready, render, search: doSearch, curated: loadCurated, uncensored: loadUncensored, loadHardware, setInstalled };
})();
