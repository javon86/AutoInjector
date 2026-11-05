// llm-write-test-ui.js — the 🧪 "What will it write?" view, shared by the model finder's cards
// (llm-models-ui.js) and 📦 Models on this PC (llm-setup-ui.js): a small table — probe, ✅ / ⚠ / ✖,
// a one-line excerpt, the time — and the overall verdict. Runs through window.api.llmWriteTest
// (main.js → llm-write-test.js → Ollama on this PC); progress comes on the "llm" channel
// ({type:'write-test', model, step, of}). Nothing here talks to the internet.
(function () {
  'use strict';
  const api = () => window.api || {};
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function secs(ms) { const n = Number(ms) || 0; return n < 1000 ? `${Math.max(0.1, Math.round(n / 100) / 10)} s` : `${Math.round(n / 100) / 10} s`; }

  if (!document.getElementById('llmwt-style')) {
    const st = document.createElement('style');
    st.id = 'llmwt-style';
    st.textContent = [
      '.llmwt{border:1px solid #2c4434;border-radius:7px;padding:5px 7px;margin-top:4px;background:#0a100c;font-size:11px;}',
      '.llmwt-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-weight:600;}',
      '.llmwt-verdict[data-kind=free]{color:#8ef0b0;}.llmwt-verdict[data-kind=most]{color:#f0d88e;}.llmwt-verdict[data-kind=refuses]{color:#f09a8e;}',
      '.llmwt table{width:100%;border-collapse:collapse;margin-top:3px;table-layout:fixed;}',
      '.llmwt td,.llmwt th{border-top:1px solid #1c2a20;padding:2px 3px;text-align:left;vertical-align:top;overflow:hidden;text-overflow:ellipsis;}',
      '.llmwt th{font-weight:600;opacity:.75;}',
      '.llmwt td.llmwt-x{white-space:nowrap;opacity:.85;font-style:italic;}',
      '.llmwt .llmwt-sub{opacity:.75;font-weight:400;}',
      '.llmwt-err{color:#f0b08e;}',
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }

  /** The finished result (or a progress / error state) as HTML. */
  function html(state) {
    const s = state || {};
    if (s.state === 'running') {
      return `<div class="llmwt" data-state="running"><div class="llmwt-head">🧪 What will it write? <span class="llmwt-sub">Testing ${esc(s.step || 0)} of ${esc(s.of || 6)}… (on this PC only)</span></div></div>`;
    }
    if (s.state === 'error' || (s.result && s.result.ok === false)) {
      const e = s.error || (s.result && s.result.error) || 'The test didn\'t finish.';
      return `<div class="llmwt" data-state="error"><div class="llmwt-head">🧪 What will it write?</div><div class="llmwt-err">✖ ${esc(e)}</div></div>`;
    }
    const r = s.result || s;
    if (!r || !Array.isArray(r.results)) return '';
    const v = r.verdict || {};
    const rows = r.results.map((x) => `<tr data-probe="${esc(x.id)}" data-score="${esc(x.score)}"><td>${esc(x.title)}</td><td title="${esc(x.why || '')}">${esc(x.icon)} ${esc(x.label)}</td><td class="llmwt-x" title="${esc(x.excerpt || '')}">${esc(x.excerpt ? `“${x.excerpt}”` : '—')}</td><td>${esc(secs(x.ms))}</td></tr>`).join('');
    const when = r.at ? new Date(r.at).toLocaleString() : '';
    return `<div class="llmwt" data-state="done" data-verdict="${esc(v.kind || '')}">
      <div class="llmwt-head">🧪 What will it write? <span class="llmwt-verdict" data-kind="${esc(v.kind || '')}">${esc(v.label || '')}</span></div>
      <table><colgroup><col style="width:30%"><col style="width:24%"><col style="width:36%"><col style="width:10%"></colgroup>
      <thead><tr><th>Asked to write</th><th>Result</th><th>It began</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="llmwt-sub">Six short fiction requests (about 100 words each), run on this PC only${when ? ` · ${esc(when)}` : ''}. ✅ wrote it · ⚠ softened or lectured · ✖ refused.</div>
    </div>`;
  }

  // One listener on the "llm" channel for every test in progress.
  const watchers = new Map(); // model → fn(ev)
  let hooked = false;
  function hook() {
    if (hooked || typeof api().onLlm !== 'function') return;
    hooked = true;
    try { api().onLlm((ev) => { if (ev && ev.type === 'write-test' && watchers.has(ev.model)) { try { watchers.get(ev.model)(ev); } catch (_) {} } }); } catch (_) {}
  }
  /** Run the test; onUpdate(state) gets {state:'running', step, of} then {state:'done', result} / {state:'error', error}. */
  async function run(model, onUpdate) {
    const up = typeof onUpdate === 'function' ? onUpdate : () => {};
    if (typeof api().llmWriteTest !== 'function') { const s = { state: 'error', error: 'The writing test isn\'t available yet (update or restart AutoInjector).' }; up(s); return s; }
    hook();
    watchers.set(model, (ev) => { if (ev.state === 'running') up({ state: 'running', step: ev.step, of: ev.of }); });
    up({ state: 'running', step: 1, of: 6 });
    let r;
    try { r = await api().llmWriteTest({ name: model }); } catch (_) { r = { ok: false, error: 'Something went wrong — please try again.' }; }
    watchers.delete(model);
    const s = r && r.ok ? { state: 'done', result: r } : { state: 'error', error: (r && (r.error || r.message)) || 'The test didn\'t finish.' };
    up(s);
    return s;
  }
  /** The saved result for a model, or null. */
  async function cached(model) {
    if (typeof api().llmWriteTests !== 'function') return null;
    try { const r = await api().llmWriteTests({ name: model }); return r && r.result ? r.result : null; } catch (_) { return null; }
  }
  window.LlmWriteTestUI = { html, run, cached };
})();
