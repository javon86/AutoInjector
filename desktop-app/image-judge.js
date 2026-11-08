'use strict';
/*
 * image-judge.js — 🧑‍⚖️ the AI judge's rules: what it is asked, how its answer is checked, and how its suggested
 * fixes change the settings. Pure functions (no Electron, no fs, no network); test/images-judge.test.js.
 *
 * The judge looks at the picture plus its sidecar (the prompt and every setting) and answers ONE JSON object:
 *   { "scores": { "prompt": 1-10, "quality": 1-10, "anatomy": 1-10, "artifacts": 1-10, "composition": 1-10,
 *                 "character": 1-10 | null },
 *     "verdict": "keep" | "fix" | "redo",
 *     "good": ["short plain words", …], "bad": [ … ],
 *     "fixes": [ { "type": <one of FIX_TYPES>, …, "why": "…" } ],
 *     "prompt": { "add": [ … ], "remove": [ … ], "front": [ … ] } }
 * Setting changes come from a FIXED vocabulary (FIX_TYPES) so they can be applied safely; anything else is ignored.
 *
 *   buildPrompt(record, ctx)            → the instruction text (the same for Claude Code, a web AI and a local model)
 *   extractJson(text)                   → the JSON object inside an answer (fences, prose, curly quotes) | null
 *   validate(obj, { character })        → { ok, judge } | { ok:false, problems:[…] }
 *   applyFixes(request, judge, ctx)     → { request, changed:[plain words], skipped:[{type, why}] }
 *   applyPromptEdits(prompt, edits)     → the edited prompt
 *   passes(judge, bar) · better(a, b)   → for the "Make it better" loop and "Make 4 and pick the best"
 *   orderJudges(settings, available)    → which judges to try, best first
 *   sayVerdict(judge)                   → two or three plain sentences (Alfred explains the verdict with these)
 */
const Q = require('./sd-quality');
const sdRecord = require('./sd-record');
const { parseJsonLenient } = require('./smart-json');

const SCORE_KEYS = ['prompt', 'quality', 'anatomy', 'artifacts', 'composition', 'character'];
const SCORE_WORDS = { prompt: 'Matches the prompt', quality: 'Realism / style quality', anatomy: 'Anatomy (hands, faces, eyes, limbs)', artifacts: 'Free of artifacts (blur, noise, extra limbs, text, watermark)', composition: 'Composition and lighting', character: 'Looks like the character' };
const VERDICTS = ['keep', 'fix', 'redo'];
const FIX_TYPES = ['steps', 'cfg', 'sampler', 'scheduler', 'size', 'hires', 'adetailer', 'negative_add', 'lora_weight', 'checkpoint', 'seed', 'img2img', 'inpaint'];
const JUDGES = ['claude-code', 'pane', 'local'];
const JUDGE_WORDS = { 'claude-code': 'Claude Code (on this PC)', pane: 'a web AI pane (Claude or ChatGPT)', local: 'a local vision model (Ollama, offline — weaker)' };
const DEFAULT_SETTINGS = { order: ['claude-code', 'pane', 'local'], enabled: { 'claude-code': true, pane: true, local: true }, paneSite: 'claude', bar: 7.5, rounds: 3, autoBook: false };

function clip(s, n) { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; }

/** The instruction. ctx: { checkpoints: [names], samplers: [names], schedulers, loras, family, backend, character: {name, looks}, hasImageTool } */
function buildPrompt(rec, ctx) {
  const r = rec || {};
  const c = ctx || {};
  const used = sdRecord.settingsUsed(r).filter((x) => !/^(Made on|App version|Asked by|AI judge|Make it better)$/.test(x.label)).map((x) => `- ${x.label}: ${clip(x.value, 600)}`).join('\n');
  const lists = [];
  if (Array.isArray(c.checkpoints) && c.checkpoints.length) lists.push(`Installed checkpoints (for a "checkpoint" fix, use one of these names exactly): ${c.checkpoints.slice(0, 30).map((x) => sdRecord.cleanName(x)).join(' | ')}`);
  if (Array.isArray(c.samplers) && c.samplers.length) lists.push(`Samplers this app has: ${c.samplers.slice(0, 30).join(' | ')}`);
  if (Array.isArray(c.schedulers) && c.schedulers.length) lists.push(`Schedulers: ${c.schedulers.slice(0, 20).join(' | ')}`);
  const ch = c.character && (c.character.name || c.character.looks) ? `\nThe picture should show the character ${c.character.name || ''}${c.character.looks ? `, who looks like: ${clip(c.character.looks, 600)}` : ''}. Score "character" for how well it matches.` : '\nThere is no character reference: give "character": null.';
  const where = c.where || 'the attached picture';
  return [
    `You are a strict, fair judge of AI-made pictures (Stable Diffusion). Look closely at ${where}.`,
    'Here is how it was made:',
    used,
    ch,
    lists.length ? `\n${lists.join('\n')}` : '',
    `\nModel family: ${r.family || c.family || 'unknown'}. Engine: ${r.backend || c.backend || 'unknown'}.`,
    '\nAnswer with ONLY one JSON object, no other words, in exactly this shape:',
    '{"scores":{"prompt":1-10,"quality":1-10,"anatomy":1-10,"artifacts":1-10,"composition":1-10,"character":1-10 or null},',
    ' "verdict":"keep"|"fix"|"redo",',
    ' "good":["short plain words",...], "bad":["short plain words",...],',
    ' "fixes":[{"type":"…", …, "why":"…"}],',
    ' "prompt":{"add":["words to add"],"remove":["words to remove"],"front":["words to move to the front, most important first"]}}',
    '\nScores: 10 = perfect. "artifacts" 10 = no blur, noise, extra limbs, text, watermark or melted details. "anatomy" covers hands, faces, eyes and limbs.',
    'verdict: keep = good enough to use; fix = good start, settings or words need changing; redo = start again.',
    'fixes — use ONLY these types (anything else is ignored):',
    '  {"type":"steps","delta":+/-N}   {"type":"cfg","delta":+/-N}   {"type":"sampler","name":"…"}   {"type":"scheduler","name":"…"}',
    '  {"type":"size","aspect":"portrait"|"square"|"landscape"} (the model\'s own size)   {"type":"hires","on":true|false,"denoise":0.3-0.6}',
    '  {"type":"adetailer","target":"face"|"hands"}   {"type":"negative_add","terms":["…"]}   {"type":"lora_weight","name":"…","weight":0-1.5}',
    '  {"type":"checkpoint","name":"<an installed checkpoint>"}   {"type":"seed"} (try another random picture)',
    '  {"type":"img2img","denoise":0.2-0.6} (redo the same picture lightly)   {"type":"inpaint","region":"face"|"hands"|"background","denoise":0.3-0.6}',
    'Keep "good" and "bad" to at most 5 items each, a few words per item. Give at most 6 fixes, the most useful first.',
  ].filter(Boolean).join('\n');
}

/** The JSON object inside an AI's answer. */
function extractJson(text) {
  let t = String(text == null ? '' : text).trim();
  if (!t) return null;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const direct = parseJsonLenient(t);
  if (direct.ok && direct.value && typeof direct.value === 'object' && !Array.isArray(direct.value)) return direct.value;
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  const r = parseJsonLenient(t.slice(a, b + 1));
  return r.ok && r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : null;
}

function score(v) {
  if (v === null || v === undefined || v === '' || v === 'null' || v === 'n/a') return null;
  const n = Number(typeof v === 'string' ? v.replace(/\/\s*10$/, '') : v);
  if (!Number.isFinite(n)) return NaN;
  return Math.min(10, Math.max(1, Math.round(n * 10) / 10));
}
function strList(v, max) { return (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []).map((x) => clip(typeof x === 'string' ? x : x && (x.text || x.what) ? x.text || x.what : '', 160)).filter(Boolean).slice(0, max || 6); }
function derivedVerdict(overall, min) { if (overall >= 7.5 && min >= 6) return 'keep'; if (overall < 4.5 || min <= 2) return 'redo'; return 'fix'; }

/** Check and tidy a judge's answer. character: true when a character reference exists. */
function validate(obj, opts) {
  const o = opts || {};
  const problems = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, problems: ['the answer is not a JSON object'] };
  const src = obj.scores && typeof obj.scores === 'object' ? obj.scores : obj;
  const scores = {};
  for (const k of SCORE_KEYS) {
    const v = score(src[k] !== undefined ? src[k] : src[`${k}_score`]);
    if (k === 'character') { if (v === null || v === undefined) { scores.character = null; continue; } }
    if (v === null || v === undefined) { problems.push(`scores.${k} is missing`); continue; }
    if (Number.isNaN(v)) { problems.push(`scores.${k} is not a number`); continue; }
    scores[k] = v;
  }
  if (!o.character) scores.character = null;
  let verdict = String(obj.verdict || '').toLowerCase().trim();
  if (!VERDICTS.includes(verdict)) problems.push('verdict must be keep, fix or redo');
  if (problems.length) return { ok: false, problems };
  const vals = SCORE_KEYS.map((k) => scores[k]).filter((x) => typeof x === 'number');
  const overall = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  const min = Math.min(...vals);
  const derived = derivedVerdict(overall, min);
  // A judge that disagrees with itself ("keep" with 3/10 scores): go by its scores, and say so.
  let selfConflict = false;
  if ((verdict === 'keep' && (overall < 5.5 || min <= 3)) || (verdict === 'redo' && overall >= 8)) { selfConflict = true; verdict = derived; }
  const fixes = [];
  const ignored = [];
  for (const f of Array.isArray(obj.fixes) ? obj.fixes.slice(0, 12) : []) {
    if (!f || typeof f !== 'object') continue;
    const type = String(f.type || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (!FIX_TYPES.includes(type)) { ignored.push(clip(type || '?', 30)); continue; }
    const x = { type };
    for (const k of ['delta', 'value', 'weight', 'denoise']) if (f[k] !== undefined && Number.isFinite(Number(f[k]))) x[k] = Number(f[k]);
    for (const k of ['name', 'aspect', 'target', 'region']) if (f[k] !== undefined) x[k] = clip(f[k], 200);
    if (f.on !== undefined) x.on = f.on === true || f.on === 'true' || f.on === 'on';
    if (Array.isArray(f.terms)) x.terms = strList(f.terms, 10);
    else if (typeof f.terms === 'string') x.terms = strList(f.terms.split(','), 10);
    if (f.why) x.why = clip(f.why, 200);
    fixes.push(x);
  }
  const pe = obj.prompt && typeof obj.prompt === 'object' ? obj.prompt : obj.promptEdits && typeof obj.promptEdits === 'object' ? obj.promptEdits : {};
  const promptEdits = { add: strList(pe.add, 10), remove: strList(pe.remove, 10), front: strList(pe.front || pe.reorder, 10) };
  return { ok: true, judge: { scores, overall, min, verdict, selfConflict, good: strList(obj.good, 6), bad: strList(obj.bad, 6), fixes: fixes.slice(0, 8), promptEdits, ignored } };
}

function terms(s) { return String(s || '').split(',').map((x) => x.trim()).filter(Boolean); }
/** Add / remove / move words in a comma prompt. <lora:…> tags are kept as they are. */
function applyPromptEdits(prompt, edits) {
  const e = edits || {};
  let list = terms(prompt);
  const lower = (x) => x.toLowerCase();
  for (const rm of e.remove || []) {
    const r = lower(rm.trim()); if (!r) continue;
    list = list.map((t) => (lower(t) === r ? '' : /<lora:/i.test(t) ? t : t.replace(new RegExp(`\\b${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig'), '').replace(/\s{2,}/g, ' ').trim())).filter(Boolean);
  }
  for (const a of e.add || []) { const t = a.trim(); if (t && !list.some((x) => lower(x) === lower(t))) list.push(t); }
  const front = [];
  for (const f of e.front || []) {
    const i = list.findIndex((x) => lower(x) === lower(f.trim()) || lower(x).includes(lower(f.trim())));
    if (i >= 0) front.push(list.splice(i, 1)[0]);
  }
  return [...front, ...list].join(', ');
}

const AD_MODELS = { face: 'face_yolov8n.pt', hands: 'hand_yolov8n.pt' };
/**
 * Apply the judge's fixes to an images.generate request (a copy is returned; the input is never changed).
 * ctx: { family, backend ('a1111' | 'comfy'), lists: { samplers, schedulers, checkpoints, loras }, imagePath, adetailer (true when installed) }
 */
function applyFixes(request, judge, ctx) {
  const q = JSON.parse(JSON.stringify(request || {}));
  const c = ctx || {};
  const fam = c.family || Q.familyOf(q.checkpoint || '');
  const L = c.lists || {};
  const changed = []; const skipped = [];
  const skip = (type, why) => skipped.push({ type, why });
  const inList = (arr, name) => { if (!Array.isArray(arr) || !arr.length) return name; const n = String(name || '').toLowerCase(); return arr.find((x) => String(x).toLowerCase() === n) || arr.find((x) => sdRecord.cleanName(x).toLowerCase() === sdRecord.cleanName(n).toLowerCase()) || arr.find((x) => String(x).toLowerCase().includes(n) && n.length >= 4) || null; };
  const j = judge || {};
  let newSeed = j.verdict === 'redo';
  for (const f of j.fixes || []) {
    switch (f.type) {
      case 'steps': {
        if (fam === 'Flux' && f.delta > 0 && (q.steps || 20) >= 30) { skip('steps', 'Flux gains nothing above 30 steps'); break; }
        const v = Math.round(Math.min(80, Math.max(10, f.value != null ? f.value : (Number(q.steps) || 20) + (f.delta || 0))));
        if (v !== q.steps) { changed.push(`steps ${q.steps || '?'} → ${v}`); q.steps = v; } break;
      }
      case 'cfg': {
        if (fam === 'Flux') { skip('cfg', 'Flux works at CFG 1 — changing it makes it worse'); break; }
        const v = Math.round(Math.min(15, Math.max(1.5, f.value != null ? f.value : (Number(q.cfgScale) || 7) + (f.delta || 0))) * 2) / 2;
        if (v !== q.cfgScale) { changed.push(`CFG ${q.cfgScale || '?'} → ${v}`); q.cfgScale = v; } break;
      }
      case 'sampler': {
        const n = inList(L.samplers, f.name);
        if (!n) { skip('sampler', `this app has no sampler called “${f.name}”`); break; }
        if (n !== q.sampler) { changed.push(`sampler → ${n}`); q.sampler = n; } break;
      }
      case 'scheduler': {
        const n = inList(L.schedulers, f.name);
        if (!n) { skip('scheduler', `this app has no scheduler called “${f.name}”`); break; }
        if (n !== q.scheduler) { changed.push(`scheduler → ${n}`); q.scheduler = n; } break;
      }
      case 'size': {
        const a = Q.ASPECTS.includes(f.aspect) ? f.aspect : Q.aspectOf(q.width, q.height);
        const sz = Q.sizeFor(fam, a);
        if (sz.width !== q.width || sz.height !== q.height) { changed.push(`size ${q.width || '?'}×${q.height || '?'} → ${sz.width}×${sz.height} (${a})`); q.width = sz.width; q.height = sz.height; } break;
      }
      case 'hires': {
        if (f.on === false) { if (q.hires) { delete q.hires; changed.push('hires fix off'); } break; }
        const denoise = Math.min(0.6, Math.max(0.25, f.denoise != null ? f.denoise : 0.4));
        const scale = Q.isBig(fam) ? 1.25 : 1.5;
        const was = q.hires ? JSON.stringify(q.hires) : '';
        q.hires = Object.assign({ upscaler: 'Latent', secondPassSteps: 0 }, q.hires || {}, { scale: (q.hires && q.hires.scale) || scale, denoise });
        if (JSON.stringify(q.hires) !== was) changed.push(`hires fix on (×${q.hires.scale}, denoise ${denoise})`);
        break;
      }
      case 'adetailer':
      case 'inpaint': {
        const target = f.type === 'adetailer' ? (f.target === 'hands' ? 'hands' : 'face') : f.region === 'hands' ? 'hands' : f.region === 'face' ? 'face' : '';
        if (target && c.backend === 'a1111' && c.adetailer !== false) {
          const model = AD_MODELS[target];
          q.adetailer = Array.isArray(q.adetailer) ? q.adetailer : [];
          if (!q.adetailer.some((u) => u.model === model)) { q.adetailer.push({ model, denoise: f.denoise != null ? Math.min(0.6, Math.max(0.2, f.denoise)) : 0.4 }); changed.push(`ADetailer ${target} on`); }
          break;
        }
        if (f.type === 'adetailer') { skip('adetailer', c.backend === 'comfy' ? 'ADetailer needs Forge / Automatic1111' : 'the ADetailer add-on is not installed (🧩 Add-ons)'); break; }
        // fall through to a light img2img of the whole picture (a mask of one region can't be drawn automatically)
      } // eslint-disable-line no-fallthrough
      case 'img2img': {
        if (!c.imagePath) { skip(f.type, 'there is no picture file to start from'); break; }
        const d = Math.min(0.6, Math.max(0.2, f.denoise != null ? f.denoise : 0.35));
        q.initImage = c.imagePath; q.denoise = d;
        changed.push(`redo the same picture lightly (img2img, change ${d})${f.type === 'inpaint' ? ` — instead of repainting only the ${f.region || 'region'}` : ''}`);
        break;
      }
      case 'negative_add': {
        const add = (f.terms || []).filter(Boolean);
        if (!add.length) break;
        if (fam === 'Flux') { skip('negative_add', 'Flux ignores the negative prompt'); break; }
        const before = q.negativePrompt || '';
        q.negativePrompt = Q.mergeTerms(before, add.join(', '));
        if (q.negativePrompt !== before) changed.push(`avoid: ${add.join(', ')}`);
        break;
      }
      case 'lora_weight': {
        const ls = Array.isArray(q.loras) ? q.loras : [];
        const l = ls.find((x) => String(x.name).toLowerCase() === String(f.name || '').toLowerCase());
        if (!l) { skip('lora_weight', `no LoRA called “${f.name}” in this picture`); break; }
        const w = Math.round(Math.min(1.5, Math.max(0, f.weight != null ? f.weight : (l.weight || 0.8) + (f.delta || 0))) * 100) / 100;
        if (w !== l.weight) { changed.push(`LoRA ${l.name} ${l.weight} → ${w}`); l.weight = w; } break;
      }
      case 'checkpoint': {
        const n = inList(L.checkpoints, f.name);
        if (!n || !Array.isArray(L.checkpoints) || !L.checkpoints.length) { skip('checkpoint', `“${f.name}” is not installed`); break; }
        if (n !== q.checkpoint) {
          changed.push(`checkpoint → ${sdRecord.cleanName(n)}`); q.checkpoint = n;
          const nf = Q.familyOf(n);
          if (nf && nf !== fam) { const sz = Q.sizeFor(nf, Q.aspectOf(q.width, q.height)); q.width = sz.width; q.height = sz.height; const d = Q.defaultsFor(nf); q.steps = d.steps; q.cfgScale = d.cfgScale; changed.push(`size / steps / CFG for ${nf}`); }
        }
        break;
      }
      case 'seed': newSeed = true; break;
      default: skip(f.type, 'unknown fix');
    }
  }
  const pe = j.promptEdits || {};
  if ((pe.add && pe.add.length) || (pe.remove && pe.remove.length) || (pe.front && pe.front.length)) {
    const before = q.prompt || '';
    q.prompt = applyPromptEdits(before, pe);
    if (q.prompt !== before) {
      const bits = [pe.add && pe.add.length ? `added “${pe.add.join(', ')}”` : '', pe.remove && pe.remove.length ? `removed “${pe.remove.join(', ')}”` : '', pe.front && pe.front.length ? 'most important words first' : ''].filter(Boolean);
      changed.push(`prompt: ${bits.join(', ')}`);
    }
  }
  if (newSeed) { q.seed = -1; changed.push('a new random seed'); }
  return { request: q, changed, skipped };
}

function passes(j, bar) { return !!j && j.verdict === 'keep' && j.overall >= (bar != null ? bar : DEFAULT_SETTINGS.bar); }
/** a better than b? overall first, then the weakest score. */
function better(a, b) { if (!b) return true; if (!a) return false; if (a.overall !== b.overall) return a.overall > b.overall; return (a.min || 0) > (b.min || 0); }

/** settings: { order, enabled }, available: { 'claude-code': bool, … } → ids in the order to try */
function orderJudges(settings, available) {
  const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  const order = (Array.isArray(s.order) ? s.order : DEFAULT_SETTINGS.order).filter((x, i, a) => JUDGES.includes(x) && a.indexOf(x) === i);
  for (const j of JUDGES) if (!order.includes(j)) order.push(j);
  const en = Object.assign({}, DEFAULT_SETTINGS.enabled, s.enabled || {});
  return order.filter((j) => en[j] !== false && (!available || available[j] !== false));
}
function cleanSettings(p, cur) {
  const s = Object.assign({}, DEFAULT_SETTINGS, cur || {});
  const x = p || {};
  if (Array.isArray(x.order)) s.order = orderJudges({ order: x.order, enabled: {} }, null);
  if (x.enabled && typeof x.enabled === 'object') s.enabled = Object.assign({}, s.enabled, ...JUDGES.filter((j) => typeof x.enabled[j] === 'boolean').map((j) => ({ [j]: x.enabled[j] })));
  if (x.paneSite === 'claude' || x.paneSite === 'chatgpt') s.paneSite = x.paneSite;
  if (x.bar != null && Number.isFinite(Number(x.bar))) s.bar = Math.min(10, Math.max(5, Number(x.bar)));
  if (x.rounds != null && Number.isFinite(Number(x.rounds))) s.rounds = Math.min(5, Math.max(1, Math.round(Number(x.rounds))));
  if (typeof x.autoBook === 'boolean') s.autoBook = x.autoBook;
  return { order: s.order, enabled: s.enabled, paneSite: s.paneSite, bar: s.bar, rounds: s.rounds, autoBook: s.autoBook };
}

function sayVerdict(j) {
  if (!j) return '';
  const v = j.verdict === 'keep' ? 'This one is good enough to keep' : j.verdict === 'redo' ? 'This one is better made again from scratch' : 'This one is a good start but needs some changes';
  const parts = [`${v} (${j.overall}/10, judged by ${j.byLabel || JUDGE_WORDS[j.by] || 'the AI judge'}).`];
  if (j.good && j.good.length) parts.push(`Good: ${j.good.slice(0, 3).join('; ')}.`);
  if (j.bad && j.bad.length) parts.push(`Not so good: ${j.bad.slice(0, 3).join('; ')}.`);
  if (j.selfConflict) parts.push('(The judge\'s verdict didn\'t match its own scores, so AutoInjector went by the scores.)');
  return parts.join(' ');
}

module.exports = { SCORE_KEYS, SCORE_WORDS, VERDICTS, FIX_TYPES, JUDGES, JUDGE_WORDS, DEFAULT_SETTINGS, buildPrompt, extractJson, validate, applyFixes, applyPromptEdits, passes, better, orderJudges, cleanSettings, sayVerdict, derivedVerdict };
