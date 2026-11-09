'use strict';
/*
 * video-judge.js — 🧑‍⚖️ the AI judge's rules for VIDEO: what it is asked, how its answer is checked, how its fixes change
 * the settings, the quick-preview size and the time estimate. Pure functions (no Electron, no fs, no network);
 * test/video-judge.test.js. The judges themselves, their order and the "ask once more, then the next judge" runner are
 * the pictures' (image-judge-service.js with rules = this file); the order, on/off, pane and pass mark are the same
 * 🧑‍⚖️ judge settings as for pictures.
 *
 * AIs can't watch a video, so the judge gets ONE picture — the contact sheet (video-frames.js: ~8 frames in time order,
 * labelled #frame and time; for picture → video the starting picture is the first tile, labelled START) — plus the
 * sidecar (prompt, every setting) and the result of a check that needs no AI (frame-to-frame differences: frozen / sudden
 * jumps / flicker). It answers ONE JSON object:
 *   { "scores": { "prompt", "quality", "consistency", "motion", "flicker": 1-10, "faithful": 1-10 | null },
 *     "verdict": "keep" | "fix" | "redo", "good": [...], "bad": [...],
 *     "fixes": [ { "type": <one of FIX_TYPES>, …, "why" } ], "prompt": { "add", "remove", "front" } }
 * The flicker score is combined with the no-AI check (the lower one counts more). Fixes come from a FIXED video
 * vocabulary; anything else is ignored. The scores win over a verdict that contradicts them (as for pictures).
 *
 *   buildPrompt(record, ctx) · validate(obj, { i2v, check }) · applyFixes(request, judge, ctx) · previewRequest(request, ctx)
 *   estimateSeconds(request, ctx) · sayVerdict(judge) · cleanVideoSettings(patch, cur)
 *   + the pictures' extractJson / passes / better / orderJudges / cleanSettings / JUDGES / JUDGE_WORDS
 */
const IJ = require('./image-judge');
const VR = require('./video-record');

const SCORE_KEYS = ['prompt', 'quality', 'consistency', 'motion', 'flicker', 'faithful'];
const SCORE_WORDS = { prompt: 'Matches the prompt', quality: 'Picture quality', consistency: 'Stays the same across frames (face, clothes, background)', motion: 'Natural motion (no melting, warping, morphing limbs)', flicker: 'No flicker or sudden jumps', faithful: 'Faithful to the starting picture' };
const FIX_TYPES = ['steps', 'cfg', 'seconds', 'fps', 'size', 'shift', 'motion', 'distilled_cfg', 'teacache', 'seed', 'negative_add', 'engine', 'better_picture'];
const NOUN = 'the video';
const FRAMEPACK_MODEL = VR.FRAMEPACK_MODEL;
// The models' own sizes ("buckets"): full and quick-preview, by shape. Wan 2.2 5B needs multiples of 32, Wan 2.1 1.3B of 16.
const BUCKETS = {
  'wan22-ti2v-5b': { full: { landscape: [1280, 704], portrait: [704, 1280], square: [960, 960] }, preview: { landscape: [832, 480], portrait: [480, 832], square: [640, 640] }, step: 32 },
  'wan21-t2v-1.3b': { full: { landscape: [832, 480], portrait: [480, 832], square: [624, 624] }, preview: { landscape: [640, 368], portrait: [368, 640], square: [480, 480] }, step: 16 },
};
const MODEL_FPS = { 'wan22-ti2v-5b': 24, 'wan21-t2v-1.3b': 16 };
const MODEL_MAX_FRAMES = { 'wan22-ti2v-5b': 121, 'wan21-t2v-1.3b': 81 };
const DEFAULTS = { 'wan22-ti2v-5b': { steps: 20, cfgScale: 5, shift: 8, sampler: 'uni_pc', scheduler: 'simple' }, 'wan21-t2v-1.3b': { steps: 30, cfgScale: 6, shift: 8, sampler: 'uni_pc', scheduler: 'simple' } };
const VIDEO_DEFAULT_SETTINGS = { rounds: 3, bestCount: 2, autoTrailer: false, previewSeconds: 1.5 };

function clip(s, n) { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; }
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
function engineOf(req) { const b = String((req && (req.backend || req.engine)) || ''); if (/framepack/.test(b) || (req && req.model === FRAMEPACK_MODEL)) return 'framepack'; if (b === 'endpoint') return 'endpoint'; return 'comfy-wan'; }
function aspectOf(w, h) { if (!(w > 0 && h > 0)) return 'landscape'; const r = w / h; return r > 1.15 ? 'landscape' : r < 0.87 ? 'portrait' : 'square'; }
function snapFrames(n, max) { const k = Math.max(1, Math.round((Number(n) - 1) / 4)); return clamp(4 * k + 1, 5, max || 121); }
function secondsOf(req) { const fps = Number(req.fps) || MODEL_FPS[req.model] || 24; if (Number(req.frames) > 0) return Math.round((Number(req.frames) - 1) / fps * 100) / 100; return Number(req.seconds) || 0; }

/** The instruction. ctx: { where, sheet: { frames: [{index,time}], hasStart, total }, check: { score, words }, installed: [model ids], framepack: bool } */
function buildPrompt(rec, ctx) {
  const r = rec || {};
  const c = ctx || {};
  const used = VR.settingsUsed(r).filter((x) => !/^(Made on|App version|Asked by|AI judge|Make it better|Time to make|Quick preview)$/.test(x.label)).map((x) => `- ${x.label}: ${clip(x.value, 600)}`).join('\n');
  const sh = c.sheet || {};
  const frames = Array.isArray(sh.frames) && sh.frames.length ? sh.frames.map((f) => `#${f.index} (${Number(f.time).toFixed(1)} s)`).join(', ') : 'about 8 frames';
  const i2v = r.mode === 'i2v';
  const fp = engineOf(r) === 'framepack';
  const ck = c.check && c.check.score != null ? `\nA frame-by-frame check (no AI) of ${c.check.sampled || 'many'} frames says: ${(c.check.words || []).join('; ')} (its flicker score: ${c.check.score}/10).` : '';
  const engines = [];
  if (Array.isArray(c.installed) && c.installed.length) engines.push(`Video models installed: ${c.installed.join(' | ')}`);
  if (c.framepack) engines.push('FramePack (picture → video) is also on this PC');
  const where = c.where || 'the attached picture';
  return [
    `You are a strict, fair judge of short AI-made VIDEOS (${fp ? 'FramePack' : 'Wan on ComfyUI'}). You can't watch the video, so ${where} is a CONTACT SHEET: frames taken evenly across the clip, in time order left to right, top to bottom, each labelled with its frame number and time: ${frames}${sh.total ? ` (of ${sh.total} frames)` : ''}.${sh.hasStart ? ' The FIRST tile, labelled START, is the starting picture the video was made from (not a frame of the video).' : ''}`,
    'Look closely at every tile and compare them with each other: does the same person / place stay the same, do hands, faces and limbs keep their shape, does anything melt, warp or jump?',
    'Here is how it was made:',
    used,
    ck,
    engines.length ? `\n${engines.join('\n')}` : '',
    '\nAnswer with ONLY one JSON object, no other words, in exactly this shape:',
    `{"scores":{"prompt":1-10,"quality":1-10,"consistency":1-10,"motion":1-10,"flicker":1-10,"faithful":${i2v ? '1-10' : 'null'}},`,
    ' "verdict":"keep"|"fix"|"redo",',
    ' "good":["short plain words",...], "bad":["short plain words",...],',
    ' "fixes":[{"type":"…", …, "why":"…"}],',
    ' "prompt":{"add":["words to add"],"remove":["words to remove"],"front":["words to move to the front"]}}',
    '\nScores: 10 = perfect. "consistency" = the face, clothes and background stay the same from tile to tile. "motion" = natural movement, no melting, warping or limbs changing shape. "flicker" 10 = no flicker or sudden jumps between tiles.',
    i2v ? '"faithful" = the video keeps the starting picture (START): the same person, clothes, place and look.' : 'This is text → video: give "faithful": null.',
    'verdict: keep = good enough to use; fix = a good start, settings or words need changing; redo = start again.',
    'fixes — use ONLY these types (anything else is ignored):',
    '  {"type":"steps","delta":+/-N}   {"type":"cfg","delta":+/-N}   {"type":"seconds","delta":+/-N} (shorter clips stay steadier)   {"type":"fps","value":N}',
    '  {"type":"size","aspect":"portrait"|"square"|"landscape"} (the model\'s own size for that shape)   {"type":"shift","delta":+/-N} (Wan only)',
    '  {"type":"motion","amount":"less"|"more"} (calmer or livelier movement)   {"type":"distilled_cfg","delta":+/-N} (FramePack only)   {"type":"teacache","on":true|false} (FramePack: off = sharper, slower)',
    '  {"type":"seed"} (try another random take)   {"type":"negative_add","terms":["…"]}   {"type":"engine","to":"wan22"|"wan21"|"framepack"} (another video engine / model)',
    `  {"type":"better_picture"}${i2v ? ' (the starting picture itself is the problem: make a better one first)' : ' (only for picture → video)'}`,
    'Keep "good" and "bad" to at most 5 items each, a few words per item. Give at most 6 fixes, the most useful first.',
  ].filter(Boolean).join('\n');
}

function score(v) {
  if (v === null || v === undefined || v === '' || v === 'null' || v === 'n/a') return null;
  const n = Number(typeof v === 'string' ? v.replace(/\/\s*10$/, '') : v);
  if (!Number.isFinite(n)) return NaN;
  return Math.min(10, Math.max(1, Math.round(n * 10) / 10));
}
function strList(v, max) { return (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []).map((x) => clip(typeof x === 'string' ? x : x && (x.text || x.what) ? x.text || x.what : '', 160)).filter(Boolean).slice(0, max || 6); }

/** Check and tidy an answer. opts: { i2v (picture → video: "faithful" is scored), check (the no-AI motion check) } */
function validate(obj, opts) {
  const o = opts || {};
  const problems = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, problems: ['the answer is not a JSON object'] };
  const src = obj.scores && typeof obj.scores === 'object' ? obj.scores : obj;
  const scores = {};
  for (const k of SCORE_KEYS) {
    const v = score(src[k] !== undefined ? src[k] : src[`${k}_score`]);
    if (k === 'faithful') { if (!o.i2v || v === null || v === undefined || Number.isNaN(v)) { if (o.i2v && (v === null || v === undefined)) problems.push('scores.faithful is missing (this is picture → video)'); scores.faithful = null; continue; } }
    if (v === null || v === undefined) { problems.push(`scores.${k} is missing`); continue; }
    if (Number.isNaN(v)) { problems.push(`scores.${k} is not a number`); continue; }
    scores[k] = v;
  }
  let verdict = String(obj.verdict || '').toLowerCase().trim();
  if (!IJ.VERDICTS.includes(verdict)) problems.push('verdict must be keep, fix or redo');
  if (problems.length) return { ok: false, problems };
  // flicker: the AI's view and the frame check together — the lower one counts more (a frozen or jumping clip can't pass)
  const ck = o.check && Number.isFinite(Number(o.check.score)) ? Number(o.check.score) : null;
  let flickerAi = scores.flicker;
  if (ck != null) { const lo = Math.min(flickerAi, ck); const hi = Math.max(flickerAi, ck); scores.flicker = Math.round((lo * 2 + hi) / 3 * 10) / 10; }
  else flickerAi = undefined;
  const vals = SCORE_KEYS.map((k) => scores[k]).filter((x) => typeof x === 'number');
  const overall = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  const min = Math.min(...vals);
  const derived = IJ.derivedVerdict(overall, min);
  let selfConflict = false;
  if ((verdict === 'keep' && (overall < 5.5 || min <= 3)) || (verdict === 'redo' && overall >= 8)) { selfConflict = true; verdict = derived; }
  const fixes = []; const ignored = [];
  for (const f of Array.isArray(obj.fixes) ? obj.fixes.slice(0, 12) : []) {
    if (!f || typeof f !== 'object') continue;
    let type = String(f.type || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (type === 'frames') type = 'seconds';
    if (type === 'model') type = 'engine';
    if (type === 'distilledcfg' || type === 'guidance') type = 'distilled_cfg';
    if (type === 'starting_picture' || type === 'better_starting_picture') type = 'better_picture';
    if (!FIX_TYPES.includes(type)) { ignored.push(clip(type || '?', 30)); continue; }
    const x = { type };
    for (const k of ['delta', 'value']) if (f[k] !== undefined && Number.isFinite(Number(f[k]))) x[k] = Number(f[k]);
    for (const k of ['aspect', 'amount', 'to']) if (f[k] !== undefined) x[k] = clip(f[k], 60).toLowerCase();
    if (f.on !== undefined) x.on = f.on === true || f.on === 'true' || f.on === 'on';
    if (Array.isArray(f.terms)) x.terms = strList(f.terms, 10); else if (typeof f.terms === 'string') x.terms = strList(f.terms.split(','), 10);
    if (f.why) x.why = clip(f.why, 200);
    fixes.push(x);
  }
  const pe = obj.prompt && typeof obj.prompt === 'object' ? obj.prompt : obj.promptEdits && typeof obj.promptEdits === 'object' ? obj.promptEdits : {};
  const promptEdits = { add: strList(pe.add, 10), remove: strList(pe.remove, 10), front: strList(pe.front || pe.reorder, 10) };
  const out = { kind: 'video', scores, overall, min, verdict, selfConflict, good: strList(obj.good, 6), bad: strList(obj.bad, 6), fixes: fixes.slice(0, 8), promptEdits, ignored };
  if (ck != null) { out.flickerAi = flickerAi; out.flickerCheck = ck; out.checkWords = (o.check.words || []).slice(0, 4); }
  return { ok: true, judge: out };
}

function sizeFor(model, aspect, which) { const b = BUCKETS[model] || BUCKETS['wan22-ti2v-5b']; const s = b[which || 'full'][aspect] || b[which || 'full'].landscape; return { width: s[0], height: s[1] }; }

/**
 * Apply the judge's fixes to a video request (video-record remakeRequest().request shape). A copy comes back.
 * ctx: { installed: [model ids], framepack: bool (ready), startPicture (path, for switching to FramePack / picture → video) }
 * → { request, changed: [plain words], skipped: [{type, why}], betterPicture: bool }
 */
function applyFixes(request, judge, ctx) {
  const q = JSON.parse(JSON.stringify(request || {}));
  const c = ctx || {};
  const changed = []; const skipped = [];
  const skip = (type, why) => skipped.push({ type, why });
  let eng = engineOf(q);
  const j = judge || {};
  let newSeed = j.verdict === 'redo'; let betterPicture = false;
  const i2v = !!q.image;
  for (const f of j.fixes || []) {
    const fp = eng === 'framepack';
    switch (f.type) {
      case 'steps': {
        const lo = fp ? 10 : 4; const hi = fp ? 50 : 60;
        const cur = Number(q.steps) || (fp ? 25 : (DEFAULTS[q.model] || DEFAULTS['wan22-ti2v-5b']).steps);
        const v = Math.round(clamp(f.value != null ? f.value : cur + (f.delta || 0), lo, hi));
        if (v !== cur) { changed.push(`steps ${cur} → ${v}`); q.steps = v; } break;
      }
      case 'cfg':
      case 'distilled_cfg': {
        if (fp) {
          const cur = Number(q.distilledCfg) || 10; const v = Math.round(clamp(f.value != null ? f.value : cur + (f.delta || 0), 4, 16) * 2) / 2;
          if (v !== cur) { changed.push(`distilled CFG ${cur} → ${v}`); q.distilledCfg = v; } break;
        }
        if (f.type === 'distilled_cfg') { skip(f.type, 'distilled CFG is a FramePack setting'); break; }
        const cur = Number(q.cfgScale) || (DEFAULTS[q.model] || DEFAULTS['wan22-ti2v-5b']).cfgScale; const v = Math.round(clamp(f.value != null ? f.value : cur + (f.delta || 0), 1.5, 10) * 2) / 2;
        if (v !== cur) { changed.push(`CFG ${cur} → ${v}`); q.cfgScale = v; } break;
      }
      case 'seconds': {
        const cur = secondsOf(q) || (fp ? 5 : 4);
        const max = fp ? 10 : Math.floor(((MODEL_MAX_FRAMES[q.model] || 121) - 1) / (Number(q.fps) || MODEL_FPS[q.model] || 24));
        const v = Math.round(clamp(f.value != null ? f.value : cur + (f.delta || 0), 1, max) * 2) / 2;
        if (v === cur) break;
        if (fp) { q.seconds = v; delete q.frames; } else { const fps = Number(q.fps) || MODEL_FPS[q.model] || 24; q.frames = snapFrames(v * fps + 1, MODEL_MAX_FRAMES[q.model]); delete q.seconds; }
        changed.push(`length ${cur} s → ${v} s`); break;
      }
      case 'fps': {
        if (fp) { skip('fps', 'FramePack always makes 30 frames a second'); break; }
        const sec = secondsOf(q); const v = Math.round(clamp(f.value != null ? f.value : (Number(q.fps) || 24) + (f.delta || 0), 8, 30));
        if (v === Number(q.fps)) break;
        q.fps = v; if (sec) q.frames = snapFrames(sec * v + 1, MODEL_MAX_FRAMES[q.model]);
        changed.push(`fps → ${v}`); break;
      }
      case 'size': {
        if (fp) { skip('size', 'FramePack keeps the starting picture\'s shape and size'); break; }
        const a = ['portrait', 'square', 'landscape'].includes(f.aspect) ? f.aspect : aspectOf(q.width, q.height);
        const sz = sizeFor(q.model, a, 'full');
        if (sz.width !== q.width || sz.height !== q.height) { changed.push(`size ${q.width || '?'}×${q.height || '?'} → ${sz.width}×${sz.height} (${a}, the model's own size)`); q.width = sz.width; q.height = sz.height; }
        break;
      }
      case 'shift':
      case 'motion': {
        if (fp) {
          if (f.type === 'motion') { const w = f.amount === 'more' ? 'lively movement' : 'slow, gentle movement, steady camera'; const before = q.prompt || ''; if (!before.toLowerCase().includes(w)) { q.prompt = [before, w].filter(Boolean).join(', '); changed.push(`prompt: added “${w}” (FramePack has no motion setting)`); } }
          else skip('shift', 'shift is a Wan setting');
          break;
        }
        const cur = Number(q.shift) || 8;
        const delta = f.type === 'motion' ? (f.amount === 'more' ? 2 : -2) : (f.value != null ? f.value - cur : f.delta || 0);
        const v = Math.round(clamp(cur + delta, 1, 16) * 2) / 2;
        if (v !== cur) { changed.push(`${f.type === 'motion' ? `${f.amount === 'more' ? 'livelier' : 'calmer'} motion: ` : ''}shift ${cur} → ${v}`); q.shift = v; }
        break;
      }
      case 'teacache': {
        if (!fp) { skip('teacache', 'TeaCache is a FramePack setting'); break; }
        const on = f.on !== false; if ((q.teacache !== false) !== on) { q.teacache = on; changed.push(`Faster (TeaCache) ${on ? 'on' : 'off — sharper, slower'}`); }
        break;
      }
      case 'negative_add': {
        const add = (f.terms || []).filter(Boolean); if (!add.length) break;
        const before = q.negativePrompt || '';
        const have = before.toLowerCase().split(',').map((x) => x.trim());
        const extra = add.filter((t) => !have.includes(t.toLowerCase()));
        if (extra.length) { q.negativePrompt = [before, ...extra].filter(Boolean).join(', '); changed.push(`avoid: ${extra.join(', ')}`); }
        break;
      }
      case 'engine': {
        const to = /frame/.test(f.to || '') ? 'framepack' : /2\.?1|1\.3|wan21|small|fast/.test(f.to || '') ? 'wan21-t2v-1.3b' : 'wan22-ti2v-5b';
        if (to === 'framepack') {
          if (!c.framepack) { skip('engine', 'FramePack is not ready on this PC'); break; }
          if (eng === 'framepack') break;
          const sec = secondsOf(q) || 4;
          for (const k of ['model', 'width', 'height', 'frames', 'fps', 'cfgScale', 'shift', 'sampler', 'scheduler']) delete q[k];
          Object.assign(q, { backend: 'framepack', seconds: sec, steps: 25, distilledCfg: 10, teacache: true });
          if (!i2v && c.startPicture) q.image = c.startPicture;
          eng = 'framepack'; changed.push(i2v || c.startPicture ? 'engine → FramePack' : 'engine → FramePack (it makes a picture first)'); break;
        }
        if (Array.isArray(c.installed) && c.installed.length && !c.installed.includes(to)) { skip('engine', `${VR.MODEL_WORDS[to]} is not downloaded`); break; }
        if (to === 'wan21-t2v-1.3b' && i2v) { skip('engine', 'Wan 2.1 1.3B makes video from text only'); break; }
        if (eng === 'comfy-wan' && q.model === to) break;
        const sec = secondsOf(q) || 4; const a = aspectOf(q.width, q.height);
        for (const k of ['distilledCfg', 'teacache', 'gpuMemoryPreservation', 'seconds']) delete q[k];
        const d = DEFAULTS[to]; const sz = sizeFor(to, a === 'landscape' || !q.width ? a : a, 'full');
        Object.assign(q, { backend: 'comfy-wan', model: to, fps: MODEL_FPS[to], frames: snapFrames(sec * MODEL_FPS[to] + 1, MODEL_MAX_FRAMES[to]), width: sz.width, height: sz.height, steps: d.steps, cfgScale: d.cfgScale, shift: d.shift, sampler: d.sampler, scheduler: d.scheduler });
        eng = 'comfy-wan'; changed.push(`engine → ${VR.MODEL_WORDS[to]} (its own size, steps and CFG)`); break;
      }
      case 'better_picture': {
        if (!i2v) { skip('better_picture', 'this is text → video (no starting picture)'); break; }
        betterPicture = true; skip('better_picture', 'the starting picture itself needs to be better — 🎨 Images → 🔁 Make it better on it, then make the video again'); break;
      }
      case 'seed': newSeed = true; break;
      default: skip(f.type, 'unknown fix');
    }
  }
  const pe = j.promptEdits || {};
  if ((pe.add && pe.add.length) || (pe.remove && pe.remove.length) || (pe.front && pe.front.length)) {
    const before = q.prompt || '';
    q.prompt = IJ.applyPromptEdits(before, pe);
    if (q.prompt !== before) changed.push(`prompt: ${[pe.add && pe.add.length ? `added “${pe.add.join(', ')}”` : '', pe.remove && pe.remove.length ? `removed “${pe.remove.join(', ')}”` : '', pe.front && pe.front.length ? 'most important words first' : ''].filter(Boolean).join(', ')}`);
  }
  if (newSeed) { q.seed = -1; changed.push('a new random seed'); }
  return { request: q, changed, skipped, betterPicture };
}

/** The quick preview of a (full) request: about 1.5 s and a smaller size of the same shape; the same seed and every other setting. */
function previewRequest(request, ctx) {
  const q = JSON.parse(JSON.stringify(request || {}));
  const want = clamp(Number(ctx && ctx.seconds) || VIDEO_DEFAULT_SETTINGS.previewSeconds, 1, 2);
  const sec = Math.min(want, secondsOf(q) || want); // never longer than the video itself
  if (engineOf(q) === 'framepack') { q.seconds = Math.max(1, Math.round(sec)); delete q.frames; }
  else {
    const fps = Number(q.fps) || MODEL_FPS[q.model] || 24;
    q.frames = snapFrames(sec * fps + 1, MODEL_MAX_FRAMES[q.model]); delete q.seconds;
    const sz = sizeFor(q.model || 'wan22-ti2v-5b', aspectOf(q.width, q.height), 'preview');
    if (!q.width || q.width * q.height > sz.width * sz.height) { q.width = sz.width; q.height = sz.height; }
  }
  q.preview = true;
  return q;
}

/**
 * About how long a request takes, in seconds (shown before Make it better / the final / Make N). ctx.calib: earlier videos'
 * records ({ engine, model, width, height, frames, steps, renderSeconds, framepack }) — the speed of THIS PC when known.
 */
function workOf(q) {
  if (engineOf(q) === 'framepack') { const sec = secondsOf(q) || 4; return { engine: 'framepack', units: sec * (Number(q.steps) || 25) * (q.teacache === false ? 2 : 1) }; }
  const fps = Number(q.fps) || MODEL_FPS[q.model] || 24; const frames = Number(q.frames) || Math.round((Number(q.seconds) || 4) * fps + 1);
  const w = Number(q.width) || 1280; const h = Number(q.height) || 704;
  return { engine: q.model || 'wan22-ti2v-5b', units: w * h * frames * (Number(q.steps) || 20) };
}
// rough speeds of a 16 GB RTX card (units per second) when nothing has been measured yet
const BASE_RATE = { 'wan22-ti2v-5b': 3.6e6, 'wan21-t2v-1.3b': 9e6, framepack: 1.6 };
const OVERHEAD = { 'wan22-ti2v-5b': 25, 'wan21-t2v-1.3b': 15, framepack: 45 };
function estimateSeconds(request, ctx) {
  const w = workOf(request || {});
  let rate = BASE_RATE[w.engine] || BASE_RATE['wan22-ti2v-5b'];
  for (const r of ((ctx && ctx.calib) || []).slice(0, 6)) {
    if (!r || !(r.renderSeconds > 5)) continue;
    const wr = workOf(Object.assign({}, r, r.framepack ? { backend: 'framepack', seconds: r.seconds, steps: r.framepack.steps, teacache: r.framepack.teacache } : {}));
    if (wr.engine !== w.engine) continue;
    rate = wr.units / Math.max(1, r.renderSeconds - (OVERHEAD[w.engine] || 20)); break;
  }
  return Math.round((OVERHEAD[w.engine] || 20) + w.units / rate);
}
function sayDuration(s) { const n = Math.max(1, Math.round(Number(s) || 0)); return n < 90 ? `about ${n} s` : n < 3600 ? `about ${Math.round(n / 60)} min` : `about ${Math.floor(n / 3600)} h ${Math.round((n % 3600) / 60)} min`; }

function sayVerdict(j) {
  if (!j) return '';
  const v = j.verdict === 'keep' ? 'This video is good enough to keep' : j.verdict === 'redo' ? 'This video is better made again from scratch' : 'This video is a good start but needs some changes';
  const parts = [`${v} (${j.overall}/10, judged by ${j.byLabel || IJ.JUDGE_WORDS[j.by] || 'the AI judge'} from a contact sheet of its frames).`];
  if (j.good && j.good.length) parts.push(`Good: ${j.good.slice(0, 3).join('; ')}.`);
  if (j.bad && j.bad.length) parts.push(`Not so good: ${j.bad.slice(0, 3).join('; ')}.`);
  if (j.flickerCheck != null && j.flickerCheck < 7) parts.push(`The frame check found: ${(j.checkWords || []).join('; ')}.`);
  if (j.selfConflict) parts.push('(The judge\'s verdict didn\'t match its own scores, so AutoInjector went by the scores.)');
  return parts.join(' ');
}

function cleanVideoSettings(p, cur) {
  const s = Object.assign({}, VIDEO_DEFAULT_SETTINGS, cur || {});
  const x = p || {};
  if (x.rounds != null && Number.isFinite(Number(x.rounds))) s.rounds = clamp(Math.round(Number(x.rounds)), 1, 5);
  if (x.bestCount != null && Number.isFinite(Number(x.bestCount))) s.bestCount = clamp(Math.round(Number(x.bestCount)), 2, 4);
  if (typeof x.autoTrailer === 'boolean') s.autoTrailer = x.autoTrailer;
  if (x.previewSeconds != null && Number.isFinite(Number(x.previewSeconds))) s.previewSeconds = clamp(Math.round(Number(x.previewSeconds) * 2) / 2, 1, 2);
  return { rounds: s.rounds, bestCount: s.bestCount, autoTrailer: s.autoTrailer, previewSeconds: s.previewSeconds };
}

module.exports = {
  SCORE_KEYS, SCORE_WORDS, FIX_TYPES, BUCKETS, NOUN, VIDEO_DEFAULT_SETTINGS, buildPrompt, validate, applyFixes, previewRequest, estimateSeconds, sayDuration, sayVerdict, cleanVideoSettings, sizeFor, aspectOf, engineOf, secondsOf,
  // shared with the picture judge
  extractJson: IJ.extractJson, passes: IJ.passes, better: IJ.better, orderJudges: IJ.orderJudges, cleanSettings: IJ.cleanSettings, JUDGES: IJ.JUDGES, JUDGE_WORDS: IJ.JUDGE_WORDS, VERDICTS: IJ.VERDICTS, DEFAULT_SETTINGS: IJ.DEFAULT_SETTINGS,
};
