'use strict';
/*
 * video-record.js — everything that is saved with a video, in one place (the 🎬 twin of sd-record.js). Shared by the
 * main process (video-studio.js, video-judge.js, video-improve.js, video-recipes.js) and the 🎬 Video tab (a <script>
 * tag → window.videoRecord). No Electron, no DOM, no fs: plain functions, unit-tested in test/video-judge.test.js.
 *
 * Every video's sidecar (<name>.json next to the .mp4 / .webm and its .png poster) holds:
 *   promptTyped        what the person (or Alfred / Akọwe) typed, before a character lock's looks were added
 *   prompt             what was actually sent to the video engine; negativePrompt (+ negativeAuto: the default one)
 *   engine             'comfy-wan' | 'framepack' | 'endpoint'; model (wan22-ti2v-5b | wan21-t2v-1.3b | framepack-i2v-hy)
 *   modelFiles         { diffusion, textEncoder, vae } (Wan, as ComfyUI spells them) | { folder, repos } (FramePack)
 *   workflow           'built-in Wan graph (AutoInjector)' + comfyGraph (the exact ComfyUI graph that was queued)
 *   mode ('t2v' | 'i2v'), seconds, fps, frames, width, height
 *   steps, cfgScale, shift, sampler, scheduler (Wan) · framepack { steps, cfg, distilledCfg, rs, teacache,
 *                      gpuMemoryPreservation, sections, wantSeconds, mp4Crf } (FramePack)
 *   seed               the REAL seed (a random one is picked before the render and saved)
 *   startPicture       { path, sidecar, seed? } — the picture a picture→video started from, and its own .json
 *   askedBy            { who: 'you' | 'Alfred' | 'Akọwe trailer' | 'Trailer' | 'Make it better' | …, from, book? }
 *   recipe {id, name}  when a saved 🎬 video recipe was used
 *   judge {...} / judges [...] the AI judge's verdicts (video-judge.js) · improve {session, round, preview} · picked
 *   preview            true for a quick preview of 🔁 Make it better (short and small)
 *   renderSeconds, appVersion, createdAt
 *
 *   enrich(rec, ctx)        → the record with the fields above filled in where they can be known
 *   askedByOf(from, rec)    → { who, from, book? }
 *   settingsUsed(rec)       → [{ label, value }] in plain words (the "Settings used" panel)
 *   remakeRequest(rec)      → { kind: 'generate' | 'animate', request, note } — the request that makes the same video again
 *   SETTING_KEYS            → the generation settings a video recipe can hold (no prompt text)
 */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.videoRecord = m;
})(typeof self !== 'undefined' ? self : this, function () {
  const FRAMEPACK_MODEL = 'framepack-i2v-hy';
  const SETTING_KEYS = ['engine', 'model', 'seconds', 'fps', 'width', 'height', 'steps', 'cfgScale', 'shift', 'sampler', 'scheduler', 'negativePrompt', 'teacache', 'distilledCfg', 'gpuMemoryPreservation'];
  const MODEL_WORDS = { 'wan22-ti2v-5b': 'Wan 2.2 5B', 'wan21-t2v-1.3b': 'Wan 2.1 1.3B (fast, smaller)', [FRAMEPACK_MODEL]: 'FramePack (HunyuanVideo)', endpoint: 'the other video server' };
  const ENGINE_WORDS = { 'comfy-wan': 'ComfyUI + Wan', framepack: 'FramePack', endpoint: 'the other video server (Advanced)' };

  function isPicPath(p) { const s = String(p || ''); return s.length < 1024 && /\.(png|jpe?g|webp)$/i.test(s) && !/^data:/i.test(s); }
  function sidecarOf(p) { return isPicPath(p) ? String(p).replace(/\.(png|jpe?g|webp)$/i, '.json') : ''; }

  function askedByOf(from, rec) {
    const f = String(from || 'video-tab');
    const r = rec || {};
    let who = 'you';
    if (/^api:alfred|^alfred/i.test(f)) who = 'Alfred';
    else if (/^trailer/i.test(f)) who = /akowe|bridge|bookforge/i.test(f) ? 'Akọwe trailer' : 'Trailer';
    else if (/^bridge:/i.test(f)) who = /akowe|bookforge/i.test(f) || r.book ? 'Akọwe' : f.replace(/^bridge:/, '');
    else if (/improve|best|judge/i.test(f)) who = 'Make it better';
    else if (/^api:/i.test(f)) who = f.replace(/^api:/, '');
    else if (/test/i.test(f)) who = 'a test';
    const out = { who, from: f.slice(0, 60) };
    if (r.book) out.book = String(r.book).slice(0, 200);
    return out;
  }

  /** ctx: { from, promptTyped, negativeAuto, appVersion, recipe {id,name}, startPicture (path), startPictureRecord, renderSeconds, preview, improve } */
  function enrich(rec, ctx) {
    const r = Object.assign({}, rec || {});
    const c = ctx || {};
    if (c.promptTyped != null && String(c.promptTyped).trim() && r.promptTyped == null) r.promptTyped = String(c.promptTyped).slice(0, 4000);
    if (r.promptTyped == null) r.promptTyped = r.prompt || '';
    if (c.negativeAuto) r.negativeAuto = true;
    if (c.appVersion && !r.appVersion) r.appVersion = String(c.appVersion).slice(0, 40);
    if (c.recipe && c.recipe.id) r.recipe = { id: String(c.recipe.id), name: String(c.recipe.name || c.recipe.id).slice(0, 120) };
    const sp = c.startPicture || (r.mode === 'i2v' ? r.sourceImage : '') || r.sourcePicture;
    if (sp && isPicPath(sp) && !r.startPicture) {
      r.startPicture = { path: String(sp), sidecar: sidecarOf(sp) };
      const pr = c.startPictureRecord;
      if (pr && typeof pr === 'object') { if (pr.seed != null) r.startPicture.seed = pr.seed; if (pr.checkpoint) r.startPicture.checkpoint = String(pr.checkpoint).slice(0, 200); if (pr.recipe) r.startPicture.recipe = pr.recipe; }
      if (r.sourcePicture) r.startPicture.madeFirst = true; // FramePack text → video: the picture was made first by 🎨 Images
    }
    if (c.renderSeconds != null && Number.isFinite(Number(c.renderSeconds))) r.renderSeconds = Math.round(Number(c.renderSeconds));
    if (c.preview) r.preview = true;
    if (c.improve && typeof c.improve === 'object') r.improve = c.improve;
    r.askedBy = r.askedBy || askedByOf(c.from || r.from, r);
    for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
    return r;
  }

  function num(v) { return v == null || v === '' ? '' : String(v); }
  const isFP = (r) => r.engine === 'framepack' || r.model === FRAMEPACK_MODEL;

  /** The "Settings used" panel: every setting in plain words. Empty values are left out. */
  function settingsUsed(rec) {
    const r = rec || {};
    const out = [];
    const add = (label, value) => { if (value != null && String(value).trim() !== '') out.push({ label, value: String(value) }); };
    const typed = r.promptTyped || r.prompt || '';
    add('What you asked for', typed);
    if (r.prompt && r.prompt !== typed) add('What was sent to the video maker', r.prompt);
    add('Things to avoid (negative prompt)', r.negativePrompt ? `${r.negativePrompt}${r.negativeAuto ? '  (the automatic default)' : ''}` : '');
    add('Kind', r.mode === 'i2v' ? 'Picture → video' : 'Text → video');
    add('Made by', `${ENGINE_WORDS[r.engine] || r.engine || '?'}${r.workflow ? ` — ${r.workflow}` : ''}`);
    add('Model', MODEL_WORDS[r.model] || r.model || '');
    const mf = r.modelFiles || {};
    if (mf.diffusion || mf.textEncoder || mf.vae) add('Model files', [mf.diffusion, mf.textEncoder, mf.vae].filter(Boolean).join(' · '));
    if (mf.folder || (mf.repos && mf.repos.length)) add('Model files', [mf.folder, (mf.repos || []).join(', ')].filter(Boolean).join(' — '));
    add('Length', r.seconds != null ? `${r.seconds} s${r.frames ? ` (${r.frames} frames at ${r.fps || '?'} fps)` : ''}` : '');
    add('Size', r.width && r.height ? `${r.width} × ${r.height}` : '');
    if (isFP(r)) {
      const f = r.framepack || {};
      add('Steps', num(f.steps != null ? f.steps : r.steps));
      add('Distilled CFG (guidance)', num(f.distilledCfg != null ? f.distilledCfg : r.distilledCfg));
      add('CFG (real)', num(f.cfg != null ? f.cfg : 1));
      add('Faster (TeaCache)', (f.teacache != null ? f.teacache : r.teacache) === false ? 'off' : 'on');
      add('GPU memory kept free', f.gpuMemoryPreservation != null || r.gpuMemoryPreservation != null ? `${f.gpuMemoryPreservation != null ? f.gpuMemoryPreservation : r.gpuMemoryPreservation} GB` : '');
      if (f.sections) add('Parts', `${f.sections} of about 1.2 s`);
    } else {
      add('Steps', num(r.steps));
      add('CFG (how strictly it follows the words)', num(r.cfgScale));
      add('Shift (motion / timing of the sampler)', num(r.shift));
      add('Sampler', r.sampler ? `${r.sampler}${r.scheduler ? ` · ${r.scheduler}` : ''}` : '');
    }
    add('Seed (the number that makes this exact video)', r.seed != null && Number(r.seed) >= 0 ? String(r.seed) : (r.engine === 'endpoint' ? 'unknown (the other video server)' : ''));
    if (r.startPicture && r.startPicture.path) add(r.startPicture.madeFirst ? 'Picture made first (🎨 Images)' : 'Starting picture', `${r.startPicture.path}${r.startPicture.seed != null ? ` (its seed ${r.startPicture.seed})` : ''}`);
    else if (r.sourceImage && r.mode === 'i2v') add('Starting picture', r.sourceImage);
    if (r.characterLock && (r.characterLock.character || r.characterLock.id)) add('Character lock', r.characterLock.character || r.characterLock.id);
    if (r.recipe) add('Recipe', r.recipe.name || r.recipe.id);
    if (r.purpose && r.purpose !== 'free') add('Purpose', { clip: 'Character clip', trailer_shot: 'Trailer shot', test: 'Test clip' }[r.purpose] || r.purpose);
    const a = r.askedBy || askedByOf(r.from, r);
    add('Asked by', `${a.who}${a.book ? ` — book “${a.book}”` : ''}`);
    if (r.preview) add('Quick preview', 'yes — short and small, made by 🔁 Make it better');
    if (r.judge) add('AI judge', `${r.judge.verdict || '?'} · ${r.judge.overall != null ? `${r.judge.overall}/10` : ''} · by ${r.judge.byLabel || r.judge.by || '?'}`);
    if (r.improve && r.improve.round) add('Make it better', `${r.improve.final ? 'final render' : `round ${r.improve.round}`}${r.improve.changed && r.improve.changed.length ? ` — changed: ${r.improve.changed.join('; ')}` : ''}`);
    add('Time to make', r.renderSeconds != null ? `${Math.floor(r.renderSeconds / 60)} min ${r.renderSeconds % 60} s` : '');
    add('Made on', r.createdAt ? String(r.createdAt).replace('T', ' ').slice(0, 19) : '');
    add('App version', r.appVersion || '');
    return out;
  }

  /**
   * The request that makes the same video again: the prompt as SENT (a character lock's looks are already in it), the same
   * negative, seed, size, frames, fps and every engine setting — no automatic changes. FramePack text → video is remade
   * from the picture that was made first (so it is the same picture, not a new one).
   */
  function remakeRequest(rec) {
    const r = rec || {};
    const notes = [];
    const q = { prompt: r.prompt || r.promptTyped || '', negativePrompt: r.negativePrompt != null ? r.negativePrompt : undefined, seed: r.seed != null && Number(r.seed) >= 0 ? Number(r.seed) : -1, purpose: r.purpose && r.purpose !== 'test' ? r.purpose : undefined, book: r.book || undefined };
    let kind = r.mode === 'i2v' ? 'animate' : 'generate';
    const start = (r.startPicture && r.startPicture.path) || (r.mode === 'i2v' && isPicPath(r.sourceImage) ? r.sourceImage : '') || r.sourcePicture || '';
    if (isFP(r)) {
      const f = r.framepack || {};
      Object.assign(q, { backend: 'framepack', seconds: f.wantSeconds != null ? f.wantSeconds : r.seconds, steps: f.steps != null ? f.steps : r.steps, distilledCfg: f.distilledCfg != null ? f.distilledCfg : r.distilledCfg,
        teacache: (f.teacache != null ? f.teacache : r.teacache) !== false, gpuMemoryPreservation: f.gpuMemoryPreservation != null ? f.gpuMemoryPreservation : r.gpuMemoryPreservation });
      if (r.sourcePicture && start) { kind = 'animate'; notes.push('FramePack made a picture first; the remake starts from that same picture.'); }
    } else if (r.engine === 'endpoint') {
      Object.assign(q, { backend: 'endpoint' });
      notes.push('The other video server decides its own settings and seed, so the remake may differ.');
    } else {
      Object.assign(q, { backend: 'comfy-wan', model: r.model, width: r.width, height: r.height, frames: r.frames, fps: r.fps, steps: r.steps, cfgScale: r.cfgScale, shift: r.shift, sampler: r.sampler, scheduler: r.scheduler });
    }
    if (kind === 'animate') {
      if (start) q.image = start;
      else notes.push('The starting picture was not saved as a file (it was dropped in), so it can’t be remade from here.');
    }
    for (const k of Object.keys(q)) if (q[k] === undefined || q[k] === null || q[k] === '') delete q[k];
    if (q.prompt === undefined) q.prompt = '';
    return { kind, request: q, note: notes.join(' '), exact: !notes.length || (isFP(r) && !!start && notes.length === 1) };
  }

  return { SETTING_KEYS, FRAMEPACK_MODEL, MODEL_WORDS, ENGINE_WORDS, enrich, askedByOf, settingsUsed, remakeRequest, sidecarOf, isPicPath };
});
