'use strict';
// media-selftest-ui.js — 🎬 Video → 🩺 Test pictures & video (and the same button in 🎨 Images).
// ▶ Quick / ▶ Full / ⏹ Stop, a live list of the steps (✅ ⚠️ ❌ ⏭, the time, the error and what to try),
// the summary, 📋 Copy report and 📄 Open report. The work is done in main (media-selftest.js).
(function () {
  const api = window.api && window.api.mediaTest;
  const $ = (id) => document.getElementById(id);
  if (!api || !$('vd-view-selftest')) return;
  const ICON = { pass: '✅', warn: '⚠️', fail: '❌', skip: '⏭' };
  let busy = false;
  let ownRun = false; // this window pressed ▶ and is waiting for the answer
  // Runs that are over (by their start time): a progress message can arrive AFTER the run's answer (they travel on
  // different IPC paths) — it must not put the view back to "Running (12 of 12 done)…" with ▶ greyed for ever.
  const finished = new Set();

  function setBusy(on) {
    busy = on;
    $('btn-mt-quick').disabled = on; $('btn-mt-full').disabled = on; $('btn-mt-stop').disabled = !on;
  }
  function li(s) {
    const el = document.createElement('li');
    el.className = 'mt-step'; el.dataset.id = s.id; el.dataset.status = s.status || 'running';
    const head = document.createElement('div');
    head.textContent = `${s.status ? ICON[s.status] : '⏳'} ${s.name}${s.seconds != null ? ` — ${s.seconds} s` : ''}`;
    el.appendChild(head);
    if (s.detail) { const d = document.createElement('div'); d.className = 'mt-detail'; d.textContent = s.detail; el.appendChild(d); }
    if (s.error && (s.status === 'fail' || s.status === 'warn')) { const d = document.createElement('div'); d.className = 'mt-error'; d.textContent = `Exact error: ${s.error}`; el.appendChild(d); }
    if (s.fix && (s.status === 'fail' || s.status === 'warn')) { const d = document.createElement('div'); d.className = 'mt-fix'; d.textContent = `What to try: ${s.fix}`; el.appendChild(d); }
    return el;
  }
  function paint(st) {
    if (!st) return;
    const list = $('mt-steps');
    const steps = st.steps || [];
    list.textContent = '';
    for (const s of steps) list.appendChild(li(s));
    if (st.running && st.current) {
      list.appendChild(li({ id: st.current.id, name: `${st.current.name}${st.current.note ? ` — ${st.current.note}` : ''}`, seconds: st.current.seconds }));
      $('mt-progress').textContent = `${st.stopping ? '⏹ Stopping… ' : ''}Step ${Math.min(st.index + 1, st.total)} of ${st.total} (${st.mode === 'full' ? 'Full' : 'Quick'}): ${st.current.name}…`;
    } else if (st.running) $('mt-progress').textContent = `${st.stopping ? '⏹ Stopping… ' : ''}Running (${st.index} of ${st.total} done)…`;
  }
  function showReport(r) {
    if (!r) return;
    if (r.steps) paint({ steps: r.steps });
    $('mt-progress').textContent = '';
    $('mt-summary').textContent = r.summary || '';
    $('mt-summary').dataset.verdict = r.counts && r.counts.fail ? 'problems' : r.counts && r.counts.warn ? 'mostly-ok' : 'ok';
    $('btn-mt-copy').disabled = !r.markdown && !r.summary;
    $('btn-mt-open').disabled = !(r.files && r.files.md);
    $('mt-msg').textContent = r.files && r.files.md ? `Saved: ${r.files.md}${r.files.json ? ' (and .json)' : ''}` : r.saveError ? `The report could not be saved: ${r.saveError}` : '';
  }
  async function run(mode) {
    if (busy) return;
    setBusy(true);
    $('mt-summary').textContent = ''; $('mt-msg').textContent = ''; $('mt-steps').textContent = '';
    $('mt-progress').textContent = mode === 'full' ? 'Starting the Full test (a tiny picture, a tiny clip and a tiny trailer)…' : 'Starting the Quick test…';
    let r = null;
    ownRun = true;
    try { r = await api.run({ mode, chatgptPicture: !!$('mt-chatgpt').checked, unload: !!$('mt-unload').checked }); } catch (e) { r = { ok: false, message: String(e) }; }
    ownRun = false;
    if (r && r.startedAt) finished.add(Date.parse(r.startedAt));
    setBusy(false);
    if (!r || r.ok === false) { $('mt-progress').textContent = ''; $('mt-msg').textContent = `✖ ${(r && (r.message || r.error)) || 'The test did not run.'}`; return; }
    showReport(r);
  }
  $('btn-mt-quick').addEventListener('click', () => run('quick'));
  $('btn-mt-full').addEventListener('click', () => run('full'));
  $('btn-mt-stop').addEventListener('click', async () => { $('btn-mt-stop').disabled = true; $('mt-progress').textContent = '⏹ Stopping…'; try { await api.stop(); } catch (_) {} });
  $('btn-mt-copy').addEventListener('click', async () => {
    let r = null; try { r = await api.copy(); } catch (e) { r = { ok: false, message: String(e) }; }
    $('mt-msg').textContent = r && r.ok ? '📋 Copied — paste it into your message.' : `✖ ${(r && (r.message || r.error)) || 'Could not copy.'}`;
  });
  $('btn-mt-open').addEventListener('click', async () => { try { const r = await api.openReport(); if (r && r.ok === false) $('mt-msg').textContent = `✖ ${r.message || r.error}`; } catch (_) {} });
  if (typeof api.onProgress === 'function') api.onProgress((st) => {
    if (!st) return;
    if (st.running) { if (finished.has(Number(st.startedAt))) return; if (!busy) setBusy(true); paint(st); return; }
    // a run started elsewhere (🎩 Alfred's mediatest.run) ended: ▶ works again and the summary shows
    if (busy && !ownRun) { setBusy(false); $('mt-progress').textContent = ''; if (st.last) $('mt-summary').textContent = st.last; }
  });
  // 🎨 Images has the same button: it opens this view.
  if ($('btn-sd-mediatest')) $('btn-sd-mediatest').addEventListener('click', () => { try { $('tab-app-video').click(); } catch (_) {} if (window.vdSubTab) window.vdSubTab('selftest'); });
  // Opening the view shows the last report (this session, or the newest saved one).
  document.addEventListener('vd-subtab', async (e) => {
    if (e.detail !== 'selftest' || busy) return;
    let s = null; try { s = await api.status(); } catch (_) { s = null; }
    if (s && s.running) { setBusy(true); paint(s); } else if (s && s.last && !$('mt-steps').children.length) showReport(s.last);
  });
  window.mediaSelfTestRun = run;
})();
