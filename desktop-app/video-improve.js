'use strict';
/*
 * video-improve.js — 🎬 the video side of ♻ Remake, 💾 recipes, 🧑‍⚖️ the AI judge, 🔁 Make it better and "Make 2, pick
 * the best". Electron-free (main.js passes the pieces); test/video-judge.test.js.
 *
 *   🧑‍⚖️ judge(video): a contact sheet of ~8 frames (+ the starting picture for picture → video) and the no-AI motion check
 *      (video-frames.js) → the SAME judges in the same order as pictures (image-judge-service.js with rules =
 *      video-judge.js). One AI answer per judgement. The verdict is saved in the video's sidecar.
 *   🔁 improve(video): round 0 = the video as it is (judged). Rounds 1–N (default 3, max 5) are QUICK PREVIEWS: the
 *      judge's fixes are applied to the full settings, and a short, small preview of them is made (~1.5 s, the model's
 *      smaller size of the same shape, the same seed unless the judge asks for a new one) and judged. It stops early when
 *      a round passes, when two rounds in a row are no better, or on ⏹ Stop (which also stops the render). Then ONE final
 *      full-length, full-size render of the best settings — after a confirm step that shows the estimated time
 *      (final: 'confirm', the default; 'auto' renders it straight away — the trailer; 'none' skips it).
 *      It NEVER changes the 🎬 Video defaults; 💾 "Save these settings as a recipe" is the person's choice.
 *   Make N, pick the best: N (2–4) full videos with different seeds, each judged, the best marked.
 *   The round loop is the pictures' (sd-improve.js runRounds).
 *
 *   createVideoJudgeStudio({ studio, judge (judge service), grabber(), recipes, settings(), persistSettings(s), engineInfo(),
 *                            log, onProgress(e), applyToForm(patch), fileUrl(p) })
 *     → { record, remake, contactSheet, judge, improve, improveFinal, stop, status, makeBest, estimate, recipesOp, settings, readRecord }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const VJ = require('./video-judge');
const VR = require('./video-record');
const VF = require('./video-frames');
const VRec = require('./video-recipes');
const { runRounds } = require('./sd-improve');

const VIDEO_RX = /\.(mp4|webm|mkv|mov)$/i;

function createVideoJudgeStudio(d) {
  const log = d.log || (() => {});
  const fileUrl = d.fileUrl || ((p) => p);
  const progress = (e) => { try { if (d.onProgress) d.onProgress(e); } catch (_) {} };
  let running = null; // { id, kind, ctl, round, rounds, phase }
  let pending = null; // the final render waiting for the person's OK: { id, kind, request, estimate, from, source, rounds }

  const settings = () => VJ.cleanVideoSettings(typeof d.settings === 'function' ? d.settings() : d.settings);
  const jsonOf = (p) => String(p || '').replace(/\.[^.\\/]+$/, '.json');
  function readRecord(p) { try { const r = JSON.parse(fs.readFileSync(jsonOf(p), 'utf8')); return r && typeof r === 'object' ? r : null; } catch (_) { return null; } }
  function updateRecord(p, patch) {
    const cur = readRecord(p); if (!cur) return null;
    const add = typeof patch === 'function' ? patch(cur) : patch;
    const next = Object.assign({}, cur, add || {});
    try { fs.writeFileSync(jsonOf(p), JSON.stringify(next, null, 2)); } catch (_) { return null; }
    return next;
  }
  function checkVideo(p) {
    if (!p || typeof p !== 'string') return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: 'path', message: 'Which video? Give the video file (path).' };
    if (!VIDEO_RX.test(p)) return { ok: false, error: 'BAD_VIDEO', code: 'BAD_VIDEO', message: 'That is not a video file (.mp4 / .webm / .mkv / .mov).' };
    try { if (!fs.statSync(p).isFile()) throw new Error('x'); } catch (_) { return { ok: false, error: 'BAD_VIDEO', code: 'BAD_VIDEO', message: 'That video file could not be opened (moved or deleted?).' }; }
    return null;
  }
  async function info() { try { return (d.engineInfo && (await d.engineInfo())) || {}; } catch (_) { return {}; } }
  function calib() { try { const g = d.studio.gallery(12); return ((g && g.items) || []).map((x) => x.record).filter((r) => r && r.renderSeconds > 5 && !r.preview); } catch (_) { return []; } }
  function estimate(req) { const s = VJ.estimateSeconds(req || {}, { calib: calib() }); return { ok: true, seconds: s, say: VJ.sayDuration(s) }; }
  function busy() {
    if (running) return { ok: false, error: 'BUSY', code: 'BUSY', message: `“${running.kind === 'best' ? 'Make several, pick the best' : 'Make it better'}” is already running — wait for it or press ⏹ Stop.` };
    if (d.studio && typeof d.studio.busy === 'function' && d.studio.busy()) return { ok: false, error: 'BUSY', code: 'BUSY', message: 'A video is being made right now (the graphics card is busy) — wait for it or press ⏹ Stop.' };
    return null;
  }

  // ---- ♻ the saved settings / remake
  function record(p) {
    const bad = checkVideo(p); if (bad) return bad;
    const rec = readRecord(p);
    if (!rec) return { ok: false, error: 'NO_RECORD', code: 'NO_RECORD', message: 'That video has no saved settings (only videos made by AutoInjector have them).' };
    return { ok: true, record: rec, used: VR.settingsUsed(rec), remake: VR.remakeRequest(rec) };
  }
  async function render(kind, req, from) { return kind === 'animate' ? d.studio.animate(req, from) : d.studio.generate(req, from); }
  async function remake(p, from) {
    const bad = checkVideo(p); if (bad) return bad;
    const rec = readRecord(p);
    if (!rec) return { ok: false, error: 'NO_RECORD', code: 'NO_RECORD', message: 'That video has no saved settings, so it can\'t be made again exactly.' };
    const rm = VR.remakeRequest(rec);
    if (rm.kind === 'animate' && !rm.request.image) return { ok: false, error: 'NO_PICTURE', code: 'NO_PICTURE', message: rm.note };
    const req = Object.assign({}, rm.request, { promptTyped: rec.promptTyped || undefined, recipeUsed: rec.recipe || undefined });
    const r = await render(rm.kind, req, from || 'video-tab:remake');
    log('video-remake', { ok: !!(r && r.ok), engine: rec.engine, sameSeed: !!(r && r.ok && r.seed === rec.seed), error: r && !r.ok ? r.error : undefined });
    return r && r.ok ? Object.assign({}, r, { note: rm.note, remadeFrom: path.basename(p), sameSeed: r.seed === rec.seed }) : r;
  }

  // ---- 🧑‍⚖️ the contact sheet and the judge
  async function contactSheet(p, rec) {
    const bad = checkVideo(p); if (bad) return bad;
    const r = rec || readRecord(p) || {};
    const out = p.replace(/\.[^.\\/]+$/, '.sheet.png');
    let g = null; try { g = d.grabber ? await d.grabber() : null; } catch (_) { g = null; }
    const s = await VF.makeContactSheet({ file: p, record: r, out, grabber: g });
    if (!s.ok) return Object.assign({ code: s.error }, s);
    log('video-sheet', { how: s.how, tiles: s.tiles, start: s.hasStart, check: s.check && s.check.score, frozen: s.check && s.check.frozen || undefined, jumps: s.check ? s.check.jumps.length : undefined });
    return Object.assign({}, s, { sheetUrl: fileUrl(out) });
  }
  async function judge(p, o) {
    const opts = o || {};
    const bad = checkVideo(p); if (bad) return bad;
    const rec = opts.record || readRecord(p);
    if (!rec) return { ok: false, error: 'NO_RECORD', code: 'NO_RECORD', message: 'That video has no saved settings, so the judge can\'t compare it with its prompt (only videos made by AutoInjector have them).' };
    const sh = await contactSheet(p, rec);
    if (!sh.ok) return sh;
    const inf = await info();
    const i2v = rec.mode === 'i2v';
    const jr = await d.judge.judge(sh.sheet, { record: rec, save: false, only: opts.only, signal: opts.signal, validateOpts: { i2v, check: sh.check },
      ctx: { sheet: { frames: sh.frames, hasStart: sh.hasStart, total: sh.total }, check: sh.check, installed: inf.installed || [], framepack: !!inf.framepack } });
    if (!jr.ok) return Object.assign({ sheet: sh.sheet, sheetUrl: sh.sheetUrl, check: sh.check }, jr);
    jr.judge.sheet = path.basename(sh.sheet);
    if (opts.save !== false) updateRecord(p, (cur) => ({ judge: jr.judge, judges: [...(Array.isArray(cur.judges) ? cur.judges : []), ...(cur.judge ? [cur.judge] : [])].slice(-10), frameCheck: { score: sh.check.score, words: sh.check.words, how: sh.how } }));
    return { ok: true, judge: jr.judge, say: jr.say, sheet: sh.sheet, sheetUrl: sh.sheetUrl, check: sh.check, how: sh.how, tried: jr.tried };
  }

  // ---- 🔁 Make it better with quick previews
  function stop() {
    if (!running) return { ok: true, stopped: false };
    running.ctl.abort();
    try { if (d.studio && typeof d.studio.cancel === 'function') d.studio.cancel(); } catch (_) {}
    log('video-improve', { id: running.id, stop: true, round: running.round });
    return { ok: true, stopped: true };
  }
  function status() { return Object.assign({ ok: true }, running ? { running: true, kind: running.kind, round: running.round, rounds: running.rounds, phase: running.phase } : { running: false }, pending ? { awaitingFinal: { id: pending.id, estimate: pending.estimate } } : {}); }
  function item(n, g, judgeR, extra) {
    return Object.assign({ round: n, path: g ? g.path : '', url: g ? g.url : '', posterUrl: g ? g.posterUrl || '' : '', seed: g ? g.seed : null, judge: judgeR || null, overall: judgeR ? judgeR.overall : null, verdict: judgeR ? judgeR.verdict : null }, extra || {});
  }

  async function improve(p, o) {
    const b = busy(); if (b) return b;
    const opts = o || {};
    const bad = checkVideo(p); if (bad) return bad;
    const s = settings();
    const R = Math.min(5, Math.max(1, Math.round(Number(opts.rounds) || s.rounds)));
    const bar = Number.isFinite(Number(opts.bar)) ? Number(opts.bar) : VJ.cleanSettings(d.judgeSettings ? d.judgeSettings() : null).bar;
    const finalMode = ['confirm', 'auto', 'none'].includes(opts.final) ? opts.final : 'confirm';
    const rec0 = readRecord(p);
    if (!rec0) return { ok: false, error: 'NO_RECORD', code: 'NO_RECORD', message: 'That video has no saved settings, so it can\'t be made again (only videos made by AutoInjector can).' };
    if (rec0.engine === 'endpoint') return { ok: false, error: 'UNSUPPORTED', code: 'UNSUPPORTED', message: 'Make it better needs ComfyUI + Wan or FramePack (the other video server decides its own settings).' };
    const rm = VR.remakeRequest(rec0);
    if (rm.kind === 'animate' && !rm.request.image) return { ok: false, error: 'NO_PICTURE', code: 'NO_PICTURE', message: rm.note };
    const id = crypto.randomBytes(4).toString('hex');
    const ctl = new AbortController();
    if (opts.signal) { try { opts.signal.addEventListener('abort', () => ctl.abort(), { once: true }); } catch (_) {} }
    running = { id, kind: 'improve', ctl, round: 0, rounds: R, phase: 'judging' };
    pending = null;
    const from = opts.from || 'video-tab:improve';
    const t0 = Date.now();
    const rounds = [];
    const inf = await info();
    try {
      progress({ kind: 'improve', id, phase: 'judging', round: 0, rounds: R });
      const j0 = rec0.judge && rec0.judge.kind === 'video' && rec0.judge.scores ? { ok: true, judge: rec0.judge } : await judge(p, { record: rec0, signal: ctl.signal });
      if (!j0.ok) return Object.assign({ rounds }, j0);
      const full0 = Object.assign({}, rm.request);
      rounds.push(item(0, { path: p, url: fileUrl(p), posterUrl: rec0.poster ? fileUrl(path.join(path.dirname(p), rec0.poster)) : '', seed: rec0.seed }, j0.judge, { label: 'Your video', full: full0, changed: [], skipped: [] }));
      progress({ kind: 'improve', id, phase: 'judged', round: 0, rounds: R, result: publicItem(rounds[0]) });
      const tried = new Set();
      const loop = await runRounds({
        rounds, N: R + 1, signal: ctl.signal, passes: (j) => VJ.passes(j, bar), better: VJ.better,
        onRound: (n) => { running.round = n - 1; },
        step: async (n, best) => {
          const k = n - 1; // preview number
          const a = VJ.applyFixes(best.full, best.judge, { installed: inf.installed || [], framepack: !!inf.framepack, startPicture: rm.request.image });
          const full = a.request; const changed = a.changed;
          const key = JSON.stringify(Object.assign({}, full, { seed: full.seed === -1 ? 'r' : full.seed }));
          if (tried.has(key) || !changed.length) { full.seed = -1; if (!changed.includes('a new random seed')) changed.push('a new random seed'); }
          tried.add(JSON.stringify(full));
          const kindNow = full.image ? 'animate' : 'generate';
          const prev = VJ.previewRequest(full, { seconds: s.previewSeconds });
          prev.improve = { session: id, round: k, preview: true, changed: changed.slice(0, 8) };
          prev.promptTyped = rec0.promptTyped || undefined;
          running.phase = 'making';
          progress({ kind: 'improve', id, phase: 'making', round: k, rounds: R, changed, estimate: estimate(prev).seconds });
          const g = await render(kindNow, prev, from);
          if (ctl.signal.aborted) return { stopped: true };
          if (!g || !g.ok) {
            log('video-improve', { id, round: k, error: (g && (g.code || g.error)) || 'FAILED' });
            return { failed: item(k, null, null, { label: `Preview ${k}`, preview: true, changed, skipped: a.skipped, error: (g && g.message) || 'The preview could not be made.', code: g && (g.code || g.error) }) };
          }
          if (full.seed === -1) full.seed = g.seed; // the final uses the seed the preview really had
          running.phase = 'judging';
          progress({ kind: 'improve', id, phase: 'judging', round: k, rounds: R });
          const jn = await judge(g.path, { signal: ctl.signal });
          const it = item(k, g, jn.ok ? jn.judge : null, { label: `Preview ${k}`, preview: true, full, changed, skipped: a.skipped, betterPicture: a.betterPicture || undefined, sheetUrl: jn.sheetUrl, error: jn.ok ? undefined : jn.message });
          if (ctl.signal.aborted) return { stopped: true, item: it };
          progress({ kind: 'improve', id, phase: 'judged', round: k, rounds: R, result: publicItem(it) });
          return jn.ok ? { item: it } : { item: it, judgeFailed: true };
        },
      });
      const bestI = loop.bestI; const stopReason = loop.stopReason;
      const best = rounds[bestI];
      const out = { ok: true, id, rounds: rounds.map(publicItem), best: bestI, stopReason, bar, defaultsChanged: false };
      log('video-improve', { id, previews: rounds.length - 1, best: best.round, scores: rounds.map((r) => r.overall), stop: stopReason, ms: Date.now() - t0 });
      if (bestI === 0 || stopReason === 'stopped' && bestI === 0) {
        out.say = stopReason === 'stopped' ? 'Stopped. None of the previews beat your video.' : stopReason === 'passed' ? `Your video already passes (${best.overall}/10) — nothing to change.` : `None of the previews beat your video (${best.overall}/10), so there is no final to make.`;
        out.bestPath = p;
        progress({ kind: 'improve', id, phase: 'done', best: bestI, stopReason });
        return out;
      }
      const fullReq = Object.assign({}, best.full); delete fullReq.preview;
      const est = estimate(fullReq);
      pending = { id, kind: fullReq.image ? 'animate' : 'generate', request: fullReq, estimate: est.seconds, from, source: p, rounds, bestI, rec0 };
      out.final = { estimateSeconds: est.seconds, say: est.say, changed: best.changed, seed: fullReq.seed };
      out.say = `${stopReason === 'stopped' ? 'Stopped. ' : ''}Preview ${best.round} is the best (${best.overall}/10). The full-length video with these settings takes ${est.say}.`;
      if (stopReason === 'stopped' || finalMode === 'none') { out.awaitingFinal = true; progress({ kind: 'improve', id, phase: 'awaiting-final', best: bestI, final: out.final }); return out; }
      if (finalMode === 'confirm') { out.awaitingFinal = true; progress({ kind: 'improve', id, phase: 'awaiting-final', best: bestI, final: out.final }); return out; }
      running = null; // the final render below takes its own turn
      const f = await improveFinal(id, { signal: ctl.signal });
      return Object.assign(out, { awaitingFinal: false, finalResult: f, bestPath: f && f.ok ? f.final.path : best.path, say: f && f.ok ? `${out.say.replace(/ The full-length.*$/, '')} The full video is made (${f.final.overall != null ? `${f.final.overall}/10` : 'not judged'}).` : `${out.say} The full video failed: ${(f && f.message) || 'unknown'}` });
    } finally { if (running && running.id === id) running = null; }
  }

  /** The final full-length, full-size render of the best preview's settings (after the person said OK). */
  async function improveFinal(id, o) {
    const opts = o || {};
    if (!pending || (id && pending.id !== id)) return { ok: false, error: 'NO_PENDING', code: 'NO_PENDING', message: 'There is no "Make it better" result waiting for its full-length video (run 🔁 Make it better first).' };
    const b = busy(); if (b) return b;
    const pd = pending;
    const ctl = new AbortController();
    if (opts.signal) { try { opts.signal.addEventListener('abort', () => ctl.abort(), { once: true }); } catch (_) {} }
    running = { id: pd.id, kind: 'improve', ctl, round: 'final', rounds: pd.rounds.length - 1, phase: 'final' };
    try {
      progress({ kind: 'improve', id: pd.id, phase: 'final', estimate: pd.estimate });
      const req = Object.assign({}, pd.request, { improve: { session: pd.id, round: pd.rounds[pd.bestI].round, final: true, changed: (pd.rounds[pd.bestI].changed || []).slice(0, 8) }, promptTyped: pd.rec0.promptTyped || undefined });
      const t0 = Date.now();
      const g = await render(pd.kind, req, pd.from);
      if (ctl.signal.aborted || (g && g.error === 'VIDEO_CANCELLED')) { log('video-improve', { id: pd.id, final: 'stopped' }); return { ok: false, error: 'VIDEO_CANCELLED', code: 'VIDEO_CANCELLED', message: 'Stopped. The best settings are still there: press “Make the full video” again, or 💾 save them as a recipe.' }; }
      if (!g || !g.ok) { log('video-improve', { id: pd.id, final: (g && (g.code || g.error)) || 'FAILED' }); return Object.assign({ ok: false }, g || { error: 'VIDEO_FAILED', message: 'The full video could not be made.' }); }
      pending = null;
      running.phase = 'judging';
      progress({ kind: 'improve', id: pd.id, phase: 'judging-final' });
      const jn = await judge(g.path, { signal: ctl.signal });
      const it = item('final', g, jn.ok ? jn.judge : null, { label: 'Final', final: true, changed: pd.rounds[pd.bestI].changed, error: jn.ok ? undefined : jn.message, sheetUrl: jn.sheetUrl });
      log('video-improve', { id: pd.id, final: 'done', overall: it.overall, ms: Date.now() - t0 });
      progress({ kind: 'improve', id: pd.id, phase: 'final-done', result: publicItem(it) });
      return { ok: true, id: pd.id, final: publicItem(it), path: g.path, say: `The full video is made${it.overall != null ? ` (${it.overall}/10)` : ''}.`, defaultsChanged: false };
    } finally { running = null; }
  }
  function publicItem(it) { if (!it) return it; const o = Object.assign({}, it); if (o.full) { o.settings = o.full; delete o.full; } return o; }

  // ---- Make N, pick the best
  async function makeBest(request, o) {
    const b = busy(); if (b) return b;
    const opts = o || {};
    const count = Math.min(4, Math.max(2, Math.round(Number(opts.count) || settings().bestCount)));
    const req0 = Object.assign({}, request || {});
    const kind = req0.image ? 'animate' : 'generate';
    const id = crypto.randomBytes(4).toString('hex');
    const ctl = new AbortController();
    running = { id, kind: 'best', ctl, round: 0, rounds: count, phase: 'making' };
    const t0 = Date.now();
    const items = [];
    try {
      for (let i = 0; i < count; i++) {
        if (ctl.signal.aborted) break;
        running.round = i + 1; running.phase = 'making';
        progress({ kind: 'best', id, phase: 'making', index: i, count });
        const g = await render(kind, Object.assign({}, req0, { seed: -1 }), opts.from || 'video-tab:best');
        if (ctl.signal.aborted) break;
        if (!g || !g.ok) { items.push({ path: '', error: (g && g.message) || 'The video could not be made.', code: g && (g.code || g.error) }); break; }
        running.phase = 'judging';
        progress({ kind: 'best', id, phase: 'judging', index: i, count });
        const jr = await judge(g.path, { signal: ctl.signal });
        items.push({ path: g.path, url: g.url, posterUrl: g.posterUrl, seed: g.seed, judge: jr.ok ? jr.judge : null, overall: jr.ok ? jr.judge.overall : null, error: jr.ok ? undefined : jr.message, sheetUrl: jr.sheetUrl });
        progress({ kind: 'best', id, phase: 'judged', index: i, count, result: items[items.length - 1] });
        if (!jr.ok && /NO_JUDGE/.test(jr.error || '')) { /* keep making them; nobody to judge */ }
      }
      let bi = -1;
      items.forEach((it, i) => { if (it.judge && (bi < 0 || VJ.better(it.judge, items[bi].judge))) bi = i; });
      if (bi >= 0) updateRecord(items[bi].path, { picked: { session: id, of: items.length } });
      log('video-best', { id, count: items.length, judged: items.filter((x) => x.judge).length, best: bi, scores: items.map((x) => x.overall), ms: Date.now() - t0 });
      progress({ kind: 'best', id, phase: 'done', best: bi });
      const stopped = ctl.signal.aborted;
      const say = bi >= 0 ? `${stopped ? 'Stopped. ' : ''}Video ${bi + 1} of ${items.length} is the best (${items[bi].overall}/10).` : items.length && items[0].error && !items[0].path ? `It stopped: ${items[0].error}` : `${stopped ? 'Stopped. ' : ''}Made ${items.filter((x) => x.path).length} videos, but none could be judged: ${(items.find((x) => x.error) || {}).error || 'no AI judge answered'}.`;
      return { ok: items.some((x) => x.path), id, videos: items, best: bi, bestPath: bi >= 0 ? items[bi].path : null, say, stopped, error: items.some((x) => x.path) ? undefined : (items[0] && items[0].code) || 'VIDEO_FAILED', message: items.some((x) => x.path) ? undefined : say };
    } finally { running = null; }
  }

  // ---- 💾 recipes
  function recipesOp(op, a) {
    const x = a || {};
    const st = d.recipes;
    switch (op) {
      case 'list': return st.list({});
      case 'get': return st.get(x.id || x.name);
      case 'save': return st.save(Object.assign({ from: x.from || 'form' }, x.recipe || x));
      case 'rename': return st.rename(x.id, x.name);
      case 'delete': return st.remove(x.id);
      case 'setDefault': return st.setDefault(x.id || '');
      case 'fromVideo': {
        const r = readRecord(x.path); if (!r) return { ok: false, error: 'NO_RECORD', code: 'NO_RECORD', message: 'That video has no saved settings.' };
        const rc = VRec.fromRecord(r, x.name);
        return st.save(Object.assign(rc, { makeDefault: !!x.makeDefault }));
      }
      case 'fromSettings': { // 🔁 the best round's settings (a video request)
        const q = Object.assign({}, x.settings || {});
        if (q.seconds == null) q.seconds = VJ.secondsOf(q) || undefined;
        if (q.image) { delete q.width; delete q.height; }
        const rc = VRec.fromForm(q, x.name);
        if (!rc.settings.engine && x.settings && x.settings.backend) rc.settings.engine = x.settings.backend;
        return st.save(Object.assign(rc, { makeDefault: !!x.makeDefault }));
      }
      case 'apply': {
        const r = st.get(x.id || x.name); if (!r.ok) return r;
        try { if (d.applyToForm) d.applyToForm({ recipeId: r.recipe.id, recipeName: r.recipe.name }, 'recipe'); } catch (_) {}
        return { ok: true, applied: r.recipe.id, name: r.recipe.name, message: `The 🎬 Video form now has the recipe “${r.recipe.name}” — nothing is made until Make video.` };
      }
      case 'request': { // a recipe + words → the request (the trailer and the API use this)
        const r = st.get(x.id || x.name); if (!r.ok) return r;
        return { ok: true, request: VRec.toRequest(r.recipe, { subject: x.subject, request: x.request }) };
      }
      default: return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', message: `Unknown recipe operation “${op}”.` };
    }
  }
  function settingsOp(patch) {
    if (patch && Object.keys(patch).length) { const s = VJ.cleanVideoSettings(patch, settings()); try { if (d.persistSettings) d.persistSettings(s); } catch (_) {} log('video-judge-settings', s); return { ok: true, settings: s }; }
    return { ok: true, settings: settings() };
  }

  async function judgeStatus() { try { return await d.judge.status(); } catch (e) { return { ok: false, error: 'INTERNAL', message: String((e && e.message) || e) }; } }
  return { record, remake, contactSheet, judge, improve, improveFinal, stop, status, makeBest, estimate, recipesOp, settings: settingsOp, judgeStatus, readRecord, updateRecord };
}

module.exports = { createVideoJudgeStudio };
