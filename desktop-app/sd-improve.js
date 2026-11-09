'use strict';
/*
 * sd-improve.js — 🔁 "Make it better" and "Make 4 and pick the best".
 *
 * Make it better (improve): judge the picture → apply the judge's setting and prompt changes (image-judge.js
 * applyFixes, a fixed vocabulary) → make it again → judge again, up to N rounds (default 3, at most 5). Every round's
 * picture is kept with its sidecar and scores. It stops early when a round passes the bar (verdict "keep" and the
 * average score ≥ the bar) or when two rounds in a row are no better. It NEVER changes the person's defaults or the
 * Images form: each round is an explicit request (quality off — the automatic additions are already in it). The
 * winning settings become a recipe only when the person presses 💾 Save these settings as a recipe.
 *
 * Make 4 and pick the best (best): one batch of 4 with different seeds, each judged, the best marked.
 *
 *   createImprover({ generate(req, from), judge(path, opts), readRecord, updateRecord, ctxFor(record), cancelRender(), log, onProgress })
 *     → { improve(path, { rounds, bar, from, signal }), best(request, { count, from, signal }), stop(), status() }
 */
const crypto = require('crypto');
const J = require('./image-judge');
const sdRecord = require('./sd-record');

/**
 * The shared "Make it better" round loop (🎨 pictures here, 🎬 video's quick previews in video-improve.js).
 * rounds: [round 1, already judged]; step(n, best) → { item } | { item, judgeFailed } | { failed: item } | { stopped, item? }.
 * Stops when the best passes, on Stop, on a failure, or when two rounds in a row are no better.
 * → { bestI, stopReason: 'rounds' | 'passed' | 'stopped' | 'failed' | 'judge-failed' | 'no-better' } (rounds is filled in).
 */
async function runRounds(o) {
  const rounds = o.rounds;
  let bestI = 0; let worse = 0; let stopReason = 'rounds';
  for (let n = rounds.length + 1; n <= o.N; n++) {
    const best = rounds[bestI];
    if (o.passes(best.judge)) { stopReason = 'passed'; break; }
    if (o.signal && o.signal.aborted) { stopReason = 'stopped'; break; }
    if (o.onRound) o.onRound(n);
    const r = (await o.step(n, best)) || { failed: { round: n, error: 'nothing came back' } };
    if (r.stopped) { if (r.item) rounds.push(r.item); stopReason = 'stopped'; break; }
    if (r.failed) { rounds.push(r.failed); stopReason = 'failed'; break; }
    rounds.push(r.item);
    if (r.judgeFailed) { stopReason = 'judge-failed'; break; }
    if (o.better(r.item.judge, best.judge)) { bestI = rounds.length - 1; worse = 0; } else if (++worse >= 2) { stopReason = 'no-better'; break; }
  }
  if (stopReason === 'rounds' && o.passes(rounds[bestI].judge)) stopReason = 'passed';
  return { bestI, stopReason };
}

function createImprover(d) {
  const log = d.log || (() => {});
  const progress = (e) => { try { if (d.onProgress) d.onProgress(e); } catch (_) {} };
  let running = null; // { id, kind, ctl, round, rounds }

  function busy() { return running ? { ok: false, error: 'BUSY', code: 'BUSY', message: `“${running.kind === 'best' ? 'Make 4 and pick the best' : 'Make it better'}” is already running — wait for it or press Stop.` } : null; }
  function stop() {
    if (!running) return { ok: true, stopped: false };
    running.ctl.abort();
    try { if (d.cancelRender) d.cancelRender(); } catch (_) {}
    return { ok: true, stopped: true };
  }
  function status() { return running ? { ok: true, running: true, kind: running.kind, round: running.round, rounds: running.rounds } : { ok: true, running: false }; }
  function roundOut(n, path, url, rec, judge, changed, skipped) {
    return { round: n, path, url: url || '', seed: rec && rec.seed, judge: judge || null, overall: judge ? judge.overall : null, verdict: judge ? judge.verdict : null, changed: changed || [], skipped: skipped || [] };
  }
  async function judgeOne(path, rec, signal) {
    const ctx = d.ctxFor ? await d.ctxFor(rec) : {};
    return d.judge(path, { ctx: ctx.judge || {}, signal, record: rec });
  }

  async function improve(path, opts) {
    const b = busy(); if (b) return b;
    const o = opts || {};
    const N = Math.min(5, Math.max(1, Math.round(Number(o.rounds) || 3)));
    const bar = Number.isFinite(Number(o.bar)) ? Number(o.bar) : J.DEFAULT_SETTINGS.bar;
    const rec0 = d.readRecord(path);
    if (!rec0) return { ok: false, error: 'NO_RECORD', code: 'NO_RECORD', message: 'That picture has no saved settings, so it can\'t be made again (only pictures made by AutoInjector can).' };
    if (rec0.kind === 'upscale' || rec0.kind === 'workflow') return { ok: false, error: 'UNSUPPORTED', code: 'UNSUPPORTED', message: 'Make it better works on pictures made from a prompt (not upscaled copies or ComfyUI workflow runs).' };
    const id = crypto.randomBytes(4).toString('hex');
    const ctl = new AbortController();
    if (o.signal) { try { o.signal.addEventListener('abort', () => ctl.abort(), { once: true }); } catch (_) {} }
    running = { id, kind: 'improve', ctl, round: 1, rounds: N };
    const rounds = [];
    let stopReason = 'rounds';
    const t0 = Date.now();
    try {
      progress({ kind: 'improve', id, phase: 'judging', round: 1, rounds: N });
      let j1 = rec0.judge && rec0.judge.scores ? { ok: true, judge: rec0.judge } : await judgeOne(path, rec0, ctl.signal);
      if (!j1.ok) return Object.assign({ rounds }, j1);
      rounds.push(roundOut(1, path, o.url, rec0, j1.judge, [], []));
      progress({ kind: 'improve', id, phase: 'judged', round: 1, rounds: N, result: rounds[0] });
      const tried = new Set();
      const loop = await runRounds({
        rounds, N, signal: ctl.signal, passes: (j) => J.passes(j, bar), better: J.better,
        onRound: (n) => { running.round = n; },
        step: async (n, best) => {
          const recB = n === 2 ? rec0 : d.readRecord(best.path) || rec0;
          const base = sdRecord.remakeRequest(recB);
          const ctx = d.ctxFor ? await d.ctxFor(recB) : {};
          let req; let changed; let skipped;
          if (base.engine === 'chatgpt') {
            const pe = best.judge.promptEdits || {};
            req = Object.assign({}, base.request, { prompt: J.applyPromptEdits(base.request.prompt, pe) });
            changed = req.prompt !== base.request.prompt ? ['the words of the request'] : ['asked again (ChatGPT has no settings to change)'];
            skipped = (best.judge.fixes || []).map((f) => ({ type: f.type, why: 'ChatGPT pictures have no Stable Diffusion settings' }));
          } else {
            const a = J.applyFixes(base.request, best.judge, Object.assign({}, ctx.fix || {}, { imagePath: best.path }));
            req = a.request; changed = a.changed; skipped = a.skipped;
          }
          const key = JSON.stringify(Object.assign({}, req, { seed: req.seed === -1 ? 'r' : req.seed }));
          if (tried.has(key) || !changed.length) { req.seed = -1; if (!changed.includes('a new random seed')) changed.push('a new random seed'); }
          tried.add(JSON.stringify(req));
          progress({ kind: 'improve', id, phase: 'making', round: n, rounds: N, changed });
          const g = await d.generate(Object.assign(req, { batchSize: 1 }), o.from || 'images-tab:improve');
          if (ctl.signal.aborted) return { stopped: true };
          if (!g || !g.ok || !g.images || !g.images[0]) {
            log('image-improve', { id, round: n, error: (g && (g.code || g.error)) || 'FAILED' });
            return { failed: Object.assign(roundOut(n, '', '', null, null, changed, skipped), { error: (g && g.message) || 'The picture could not be made.' }) };
          }
          const p = g.images[0].path;
          try { d.updateRecord(p, { improve: { session: id, round: n, of: N, from: rec0.file || path.split(/[\\/]/).pop(), changed } }); } catch (_) {}
          progress({ kind: 'improve', id, phase: 'judging', round: n, rounds: N });
          const recN = d.readRecord(p) || g.settings;
          const jn = await judgeOne(p, recN, ctl.signal);
          if (ctl.signal.aborted) return { stopped: true, item: roundOut(n, p, g.images[0].url, recN, null, changed, skipped) };
          const item = Object.assign(roundOut(n, p, g.images[0].url, recN, jn.ok ? jn.judge : null, changed, skipped), jn.ok ? {} : { error: jn.message });
          progress({ kind: 'improve', id, phase: 'judged', round: n, rounds: N, result: item });
          return jn.ok ? { item } : { item, judgeFailed: true };
        },
      });
      let bestI = loop.bestI; stopReason = loop.stopReason;
      if (stopReason === 'rounds' && J.passes(rounds[bestI].judge, bar)) stopReason = 'passed';
      const best = rounds[bestI];
      log('image-improve', { id, rounds: rounds.length, best: best.round, scores: rounds.map((r) => r.overall), stop: stopReason, ms: Date.now() - t0 });
      const say = stopReason === 'passed' ? `Round ${best.round} passed (${best.overall}/10).`
        : stopReason === 'no-better' ? `It stopped getting better — round ${best.round} is the best (${best.overall}/10).`
          : stopReason === 'stopped' ? `Stopped. The best so far is round ${best.round} (${best.overall != null ? `${best.overall}/10` : 'not judged'}).`
            : stopReason === 'failed' || stopReason === 'judge-failed' ? `It stopped at round ${rounds.length}: ${rounds[rounds.length - 1].error || 'something failed'}. The best is round ${best.round}.`
              : `After ${rounds.length} rounds the best is round ${best.round} (${best.overall}/10).`;
      progress({ kind: 'improve', id, phase: 'done', rounds: N, best: bestI, stopReason });
      return { ok: true, id, rounds, best: bestI, bestPath: best.path, stopReason, bar, say, defaultsChanged: false };
    } finally { running = null; }
  }

  async function best(request, opts) {
    const b = busy(); if (b) return b;
    const o = opts || {};
    const count = Math.min(4, Math.max(2, Math.round(Number(o.count) || 4)));
    const ctl = new AbortController();
    if (o.signal) { try { o.signal.addEventListener('abort', () => ctl.abort(), { once: true }); } catch (_) {} }
    const id = crypto.randomBytes(4).toString('hex');
    running = { id, kind: 'best', ctl, round: 0, rounds: count };
    const t0 = Date.now();
    try {
      progress({ kind: 'best', id, phase: 'making', count });
      const g = await d.generate(Object.assign({}, request || {}, { batchSize: count, count: undefined, seed: -1 }), o.from || 'images-tab:best');
      if (!g || !g.ok) return Object.assign({ ok: false }, g || { error: 'FAILED', message: 'The pictures could not be made.' });
      const items = [];
      for (let i = 0; i < g.images.length; i++) {
        if (ctl.signal.aborted) break;
        running.round = i + 1;
        const im = g.images[i];
        progress({ kind: 'best', id, phase: 'judging', index: i, count: g.images.length });
        const rec = d.readRecord(im.path) || g.settings;
        const jr = await judgeOne(im.path, rec, ctl.signal);
        items.push({ path: im.path, url: im.url, seed: im.seed, judge: jr.ok ? jr.judge : null, overall: jr.ok ? jr.judge.overall : null, error: jr.ok ? undefined : jr.message });
        if (!jr.ok && /NO_JUDGE/.test(jr.error || '')) break; // no judge at all: don't ask three more times
      }
      for (let i = items.length; i < g.images.length; i++) items.push({ path: g.images[i].path, url: g.images[i].url, seed: g.images[i].seed, judge: null, overall: null });
      let bi = -1;
      items.forEach((it, i) => { if (it.judge && (bi < 0 || J.better(it.judge, items[bi].judge))) bi = i; });
      if (bi >= 0) { try { d.updateRecord(items[bi].path, { picked: { session: id, of: items.length } }); } catch (_) {} }
      log('image-best', { id, count: items.length, judged: items.filter((x) => x.judge).length, best: bi, scores: items.map((x) => x.overall), ms: Date.now() - t0 });
      progress({ kind: 'best', id, phase: 'done', best: bi });
      const say = bi >= 0 ? `Picture ${bi + 1} of ${items.length} is the best (${items[bi].overall}/10).` : `Made ${items.length} pictures, but none could be judged: ${(items.find((x) => x.error) || {}).error || 'no AI judge answered'}.`;
      return { ok: true, id, images: items, best: bi, bestPath: bi >= 0 ? items[bi].path : null, say, warnings: g.warnings || [] };
    } finally { running = null; }
  }
  return { improve, best, stop, status };
}

module.exports = { createImprover, runRounds };
