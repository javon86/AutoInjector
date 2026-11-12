// run-strip-ui.js — ⏳ the book run's progress in AutoInjector's title bar (next to 💾 / 📂 / ❓ Help).
//
// The user asked: "How long is it going to take? I want that up there so I can see where I'm at in the estimate."
// One line from the run status AutoInjector already reads (akowe-run.js summarizeRun → its `progress`, from Akọwe's
// run_clock.py): book title, step, time left, finish time, and a thin bar (% of the estimated total).
//   "📖 “The Salt Road” · Step 12 of 19 — Writing chapter 2 · ⏳ 1 h 40 m left · ends ~11:05"
//   "📖 “The Salt Road” · ⏸ waiting for you since 9:33 — the clock is paused"
//   "✔ “The Salt Road” finished in 5 h 2 m (estimated 4 h 10 m)"   (for a while after the end)
// Narrower windows get the short line ("⏳ 1 h 40 m left · ~11:05 · 12/19"), then the tiny one ("⏳ 1 h 40 m").
// Click → the 📖 Akọwe tab opens on the run window (Akọwe's #/run/<id>). It shrinks like 💾 / 📂: a shorter line on
// a narrower window, the whole line in its tooltip; it never makes the title bar scroll sideways.
// Electron-free and DOM-light: stripOf() is plain data (unit-tested in node); render() fills one button.
(function (root) {
  'use strict';
  const MOVING = ['writing', 'waiting', 'pausing'];
  const FOR_YOU = ['needs_you', 'paused', 'interrupted', 'problem'];
  const FINISHED_SHOW_MS = 3 * 3600 * 1000;

  function durWords(s) {
    s = Math.max(0, Math.round(Number(s) || 0));
    if (s < 60) return `${Math.max(1, s)} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} m`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} h ${r} m` : `${h} h`;
  }
  function clockWords(iso) {
    const t = Date.parse(iso || '');
    if (Number.isNaN(t)) return '';
    try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; }
  }
  function runUrl(sum, base) {
    const p = sum.progress || {};
    if (p.run_url) return p.run_url;
    if (!base || !sum.id) return base || '';
    return `${String(base).split('#')[0].replace(/\/?$/, '/')}#/run/${encodeURIComponent(sum.id)}`;
  }

  /**
   * The line for one run summary (akowe-run.js summarizeRun), or null (nothing to show):
   * { long, short, tip, pct, tone (work | warn | ok), url, state }
   */
  function stripOf(sum, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    if (!sum || typeof sum !== 'object' || sum.stale) return null;
    const p = sum.progress || {};
    const title = sum.title ? `“${sum.title}”` : 'Your book';
    const url = runUrl(sum, o.base);
    if (sum.state === 'finished') {
      const at = Date.parse(p.finished_at || sum.updated_at || '');
      if (Number.isNaN(at) || now - at > FINISHED_SHOW_MS || (o.hidden && o.hidden.has && o.hidden.has(sum.id))) return null;
      const took = p.actual_s != null ? p.actual_s : p.elapsed_active_s;
      const long = `✔ ${title} finished${took != null ? ` in ${durWords(took)}` : ''}${p.total_estimate_s ? ` (estimated ${durWords(p.total_estimate_s)})` : ''}`;
      return { long, short: `✔ Finished${took != null ? ` in ${durWords(took)}` : ''}`, tiny: '✔ Finished', tip: `${long}\nClick to open the run in Akọwe.`, pct: 100, tone: 'ok', url, state: 'finished' };
    }
    if (!MOVING.includes(sum.state) && !FOR_YOU.includes(sum.state)) return null;
    const stepNo = p.step_index || sum.at;
    const stepTot = p.step_total || sum.total;
    const step = stepNo && stepTot ? `Step ${stepNo} of ${stepTot}${p.step_label ? ` — ${p.step_label}` : ''}` : (p.step_label || sum.stepTitle || '');
    const parts = [`📖 ${title}`];
    if (step) parts.push(step);
    let short;
    let tiny;
    if (FOR_YOU.includes(sum.state)) {
      const since = clockWords(p.waiting_since);
      const why = sum.state === 'interrupted' ? 'stopped when Akọwe closed' : sum.state === 'paused' ? 'paused' : 'waiting for you';
      parts.push(`⏸ ${why}${since ? ` since ${since}` : ''} — the clock is paused`);
      short = `⏸ ${sum.state === 'needs_you' ? 'Waiting for you' : sum.state === 'interrupted' ? 'Stopped' : 'Paused'}${stepNo && stepTot ? ` · ${stepNo}/${stepTot}` : ''}`;
      tiny = sum.state === 'needs_you' ? '⏸ Needs you' : sum.state === 'interrupted' ? '⏸ Stopped' : '⏸ Paused';
    } else {
      const fin = clockWords(p.finish_at);
      if (p.left_s != null) parts.push(`⏳ ${durWords(p.left_s)} left${p.total_estimate_s ? ` (estimate at start: ${durWords(p.total_estimate_s)})` : ''}`);
      else if (sum.state === 'waiting') parts.push('waiting for an AI');
      if (fin) parts.push(`ends ~${fin}`);
      short = [p.left_s != null ? `⏳ ${durWords(p.left_s)} left` : '⏳ Writing', fin ? `~${fin}` : '', stepNo && stepTot ? `${stepNo}/${stepTot}` : ''].filter(Boolean).join(' · ');
      tiny = p.left_s != null ? `⏳ ${durWords(p.left_s)}` : stepNo && stepTot ? `⏳ ${stepNo}/${stepTot}` : '⏳';
    }
    const long = parts.join(' · ');
    const started = clockWords(p.started_at);
    const pct = p.percent != null ? p.percent : (sum.total ? Math.round(100 * (sum.done || 0) / sum.total) : 0);
    return { long, short, tiny, tip: `${long}${started ? `\nStarted ${started}.` : ''}\nClick to open the run window in Akọwe.`, pct: Math.max(0, Math.min(100, pct)), tone: FOR_YOU.includes(sum.state) ? 'warn' : 'work', url, state: sum.state };
  }

  const ui = { line: null, hidden: new Set() };
  /** Fill the title-bar button (#btn-run-strip) from the summary; hidden when there is nothing to show. */
  function render(btn, sum, opts) {
    if (!btn) return null;
    const line = stripOf(sum, Object.assign({ hidden: ui.hidden }, opts || {}));
    ui.line = line;
    btn.hidden = !line;
    if (!line) return null;
    const set = (sel, txt) => { const n = btn.querySelector(sel); if (n && n.textContent !== txt) n.textContent = txt; };
    set('.rsx-long', line.long);
    set('.rsx-short', line.short);
    set('.rsx-tiny', line.tiny);
    btn.title = line.tip;
    btn.setAttribute('aria-label', `${line.long}. Open the run in Akọwe`);
    btn.dataset.tone = line.tone;
    btn.dataset.state = line.state;
    btn.dataset.runId = (sum && sum.id) || '';
    const fill = btn.querySelector('.rsx-fill');
    if (fill) fill.style.width = `${line.pct}%`;
    return line;
  }
  /** Once: a click opens the run window in the 📖 Akọwe tab (open(url) → window.api.akoweOpenUrl). */
  function wire(btn, open) {
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const line = ui.line;
      if (!line) return;
      if (line.state === 'finished') { ui.hidden.add(btn.dataset.runId); btn.hidden = true; }  // seen: the line goes
      try { open(line.url); } catch (_) {}
    });
  }

  const api = { stripOf, render, wire, durWords, clockWords };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.runStripUi = api;
})(typeof window !== 'undefined' ? window : null);
