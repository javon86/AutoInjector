'use strict';
/*
 * model-catalog.js — find language models for Alfred: the Ollama library
 * (ollama.com/search, scraped defensively), Hugging Face GGUF repos (the public
 * API; Ollama pulls them directly as hf.co/<user>/<repo>:<QUANT>), and a
 * built-in curated list that works OFFLINE. Every model is rated against this
 * PC (llm-hardware.rateFit) and UNCENSORED models are first-class: detected,
 * badged, ranked first when asked for — never hidden.
 *
 *   const cat = createCatalog({ fetch, hfToken: () => token, timeoutMs });
 *   await cat.search('qwen', { sources:['ollama','hf'], uncensored, toolsOnly, hardware })
 *   await cat.hfFiles('bartowski/Qwen2.5-7B-Instruct-GGUF', { hardware })
 *   cat.curated(hardware, { uncensored })   // -> array of rated models (offline)
 *
 * Electron-free; fetch is injectable. Network calls time out, never throw, and
 * return { ok:false, error:<plain English> }. The HF token is only ever put in
 * the Authorization header — never in an error, a URL or a log.
 */
const hw = require('./llm-hardware');

const GB = 1024 * 1024 * 1024;
const OLLAMA_BASE = 'https://ollama.com';
const HF_BASE = 'https://huggingface.co';

// ------------------------------------------------------------------ detection
const UNCENSORED_RES = [
  /uncensor/i, /abliterat/i, /obliterat/i, /dolphin/i, /hermes/i, /(^|[^a-z])lexi([^a-z]|$)/i, /unfilter/i,
  /nsfw/i, /unaligned/i, /unrestrict/i, /heretic/i, /amoral/i, /josiefied/i, /huihui/i, /no[-_ ]?refusal/i,
  /(^|[^a-z])evil/i, /tiger-gemma/i,
];
/** Does this name / tag list / description say "uncensored" (abliterated, Dolphin, Hermes, Lexi…)? */
function isUncensored(...texts) {
  const s = texts.flat().filter((x) => x != null).map(String).join(' ');
  return UNCENSORED_RES.some((re) => re.test(s));
}

// Families known to do native tool calling in Ollama (used where the source doesn't say).
const TOOL_FAMILIES = /(qwen2\.5|qwen-?2\.5|qwen3|qwq|llama-?3\.[123]|llama3\.[123]|mistral-nemo|mistral-small|mistral-large|ministral|mixtral|hermes-?[23]|hermes3|command-r|firefunction|granite-?3|phi-?4-mini|smollm2|nemotron|devstral|gpt-oss|glm-?4)/i;
function toolsLikely(name) { return TOOL_FAMILIES.test(String(name || '')); }

/** "8b"→8, "1.5B"→1.5, "135m"→0.135, "8x7b"→~46 (MoE), "30B-A3B"→30. null when unknown. */
function parseParams(text) {
  const s = String(text || '');
  const moe = /(?:^|[^a-z0-9.])(\d+)x(\d+(?:\.\d+)?)b(?![a-z])/i.exec(s);
  if (moe) return Math.round(Number(moe[1]) * Number(moe[2]) * 0.83 * 10) / 10;
  const b = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*b(?![a-z])/i.exec(s);
  if (b) return Number(b[1]);
  const m = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*m(?![a-z])/i.exec(s);
  if (m) return Number(m[1]) / 1000;
  return null;
}

/** Rough Q4_K_M download size from parameter count (≈0.6 GB per billion + overhead). */
function estimateQ4Bytes(params) {
  const p = Number(params);
  if (!Number.isFinite(p) || p <= 0) return null;
  return Math.round((p * 0.6 + 0.2) * GB);
}

/** "108.5M" → 108500000, "2,345" → 2345, "1.2K" → 1200. */
function parseCount(text) {
  const m = /([\d.,]+)\s*([KMB])?/i.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[String(m[2] || '').toUpperCase()] || 1;
  return Math.round(n * mult);
}

// ------------------------------------------------------------------ GGUF quants
const QUANT_RE = /(?:^|[-_.\/ ])((?:UD-)?(?:IQ\d_[A-Z]+|Q\d_K(?:_[A-Z]+)?|Q\d_\d(?:_\d_\d)?|TQ\d_\d|MXFP4(?:_MOE)?|BF16|FP16|F16|F32))(?=[-_.\/ ]|$)/i;
const PART_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

/** "Qwen2.5-7B-Instruct-Q4_K_M.gguf" → "Q4_K_M"; null when there's no quant in the name. */
function parseQuant(filename) {
  const base = String(filename || '').replace(PART_RE, '.gguf');
  const m = QUANT_RE.exec(base);
  if (!m) return null;
  return m[1].toUpperCase().replace(/^FP16$/, 'F16');
}

// Quality order (higher = better) — used to break ties and to describe quants.
function quantBits(q) {
  const s = String(q || '').toUpperCase().replace(/^UD-/, '');
  if (s === 'F32') return 32; if (s === 'F16' || s === 'BF16') return 16;
  const m = /^(?:I?Q|TQ)(\d)/.exec(s);
  return m ? Number(m[1]) : (s.startsWith('MXFP4') ? 4 : null);
}

/**
 * siblings [{rfilename, size}] → variants [{file, files, parts, quant, sizeBytes, pullName}] (smallest first).
 * Multi-part files (-00001-of-00003) are summed per quant; mmproj (vision) files are skipped.
 */
function groupGgufFiles(siblings, repoId) {
  const groups = new Map(); // base → { quant, files, size, sizeKnown }
  for (const s of Array.isArray(siblings) ? siblings : []) {
    const f = s && String(s.rfilename || '');
    if (!/\.gguf$/i.test(f) || /mmproj/i.test(f)) continue;
    const quant = parseQuant(f);
    if (!quant) continue;
    const base = f.replace(PART_RE, '.gguf');
    const g = groups.get(base) || { quant, files: [], size: 0, sizeKnown: true };
    g.files.push(f);
    if (Number.isFinite(Number(s.size)) && Number(s.size) > 0) g.size += Number(s.size); else g.sizeKnown = false;
    groups.set(base, g);
  }
  const byQuant = new Map();
  for (const g of groups.values()) if (!byQuant.has(g.quant)) byQuant.set(g.quant, g);
  return [...byQuant.values()].map((g) => ({
    file: g.files.slice().sort()[0],
    files: g.files.slice().sort(),
    parts: g.files.length,
    quant: g.quant,
    tag: g.quant,
    sizeBytes: g.sizeKnown ? g.size : null,
    pullName: repoId ? `hf.co/${repoId}:${g.quant}` : null,
  })).sort((a, b) => (a.sizeBytes || 0) - (b.sizeBytes || 0) || (quantBits(a.quant) || 0) - (quantBits(b.quant) || 0));
}

// ------------------------------------------------------------------ Ollama search HTML
function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, ' ').trim();
}
function attrTexts(chunk, attr) {
  const re = new RegExp(`<(\\w+)[^>]*\\b${attr}\\b[^>]*>([\\s\\S]*?)</\\1>`, 'gi');
  const out = []; let m;
  while ((m = re.exec(chunk))) { const t = stripTags(m[2]); if (t) out.push(t); }
  return out;
}

/** ollama.com/search HTML → [{ name, title, description, capabilities, sizes, pulls, url }] (defensive). */
// ollama.com/search, two layouts: the older one marked its parts with x-test-* attributes; the current one
// (seen live 2026-10) is plain markup: <li><a href="/library/NAME"><h2 title="NAME">…</h2> capability badges
// (<span>tools</span>), <p>description</p>, <span title="5,075,057 downloads">, size badges (<span>27b</span>).
const CAPS = new Set(['tools', 'vision', 'thinking', 'embedding', 'audio', 'cloud', 'insert']);
const SIZE_RE = /^(?:\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)?[bm]|e\d+(?:\.\d+)?b)$/; // lowercase: "8b", "135m", "8x7b", "e4b" — not the "5.1M" download count
function spanTexts(chunk) {
  const out = []; const re = /<span\b[^>]*>([^<]*)<\/span>/gi; let m;
  while ((m = re.exec(chunk))) { const t = stripTags(m[1]); if (t) out.push(t); }
  return out;
}
function parseOllamaSearchHtml(html) {
  const s = String(html || '');
  const chunks = s.split(/<li\b/i).slice(1).filter((c) => /x-test-search-response-title|x-test-model/i.test(c) || (/<h2\b/i.test(c) && /href="\/[^"]+"/i.test(c)));
  const out = [];
  for (const raw of chunks) {
    const chunk = raw.split(/<\/li>/i)[0];
    const href = /href="\/([^"?#]+)"/i.exec(chunk);
    const h2 = /<h2\b([^>]*)>([\s\S]*?)<\/h2>/i.exec(chunk);
    const h2Title = h2 ? ((/\btitle="([^"]*)"/i.exec(h2[1]) || [])[1] || stripTags(h2[2])) : '';
    const title = attrTexts(chunk, 'x-test-search-response-title')[0] || h2Title || '';
    let name = href ? decodeURIComponent(href[1]).replace(/^library\//, '') : title;
    name = String(name || '').trim();
    if (!name || /\s/.test(name) || /^(search|models|blog|download|signin|signup|docs)\b/i.test(name)) continue;
    const spans = spanTexts(chunk).map((t) => t.trim());
    let caps = attrTexts(chunk, 'x-test-capability').map((c) => c.toLowerCase());
    if (!caps.length) caps = spans.map((t) => t.toLowerCase()).filter((t) => CAPS.has(t));
    let sizes = attrTexts(chunk, 'x-test-size').map((c) => c.toLowerCase());
    if (!sizes.length) sizes = spans.filter((t) => SIZE_RE.test(t)).map((t) => t.toLowerCase());
    sizes = [...new Set(sizes)];
    const pullTitle = /title="([\d,.]+)\s+(?:downloads|pulls)"/i.exec(chunk);
    const pulls = pullTitle ? Number(pullTitle[1].replace(/[,.]/g, '')) : parseCount(attrTexts(chunk, 'x-test-pull-count')[0]);
    let description = '';
    const pre = /<p\b[^>]*>([\s\S]*?)<\/p>/gi; let pm;
    while ((pm = pre.exec(chunk))) {
      if (/x-test-/i.test(pm[0])) continue;
      const t = stripTags(pm[1]);
      if (t) { description = t; break; }
    }
    out.push({ name, title: title || name, description, capabilities: caps, sizes, pulls: Number.isFinite(pulls) ? pulls : null, url: `${OLLAMA_BASE}/${href ? href[1] : `library/${name}`}` });
  }
  return out;
}

// ------------------------------------------------------------------ model shape
function ollamaModel(p) {
  const variants = (p.sizes.length ? p.sizes : [null]).map((size) => {
    const params = size ? parseParams(size) : null;
    return {
      tag: size ? `${p.name}:${size}` : p.name,
      quant: 'Q4_K_M', params, sizeBytes: estimateQ4Bytes(params), estimated: true,
      pullName: size ? `${p.name}:${size}` : p.name,
    };
  });
  return {
    id: `ollama:${p.name}`, source: 'ollama', name: p.name, title: p.title || p.name, description: p.description || '',
    pullName: variants[0].pullName, params: variants[0].params, sizeBytes: variants[0].sizeBytes, quant: 'Q4_K_M',
    uncensored: isUncensored(p.name, p.description), tools: p.capabilities.includes('tools'),
    vision: p.capabilities.includes('vision'), thinking: p.capabilities.includes('thinking'),
    embedding: p.capabilities.includes('embedding'),
    downloads: p.pulls, likes: null, url: p.url, gated: false, variants, fit: null,
  };
}

function hfModel(m) {
  const id = String(m.id || m.modelId || '');
  const tags = Array.isArray(m.tags) ? m.tags.map(String) : [];
  const params = parseParams(id.split('/').pop());
  const sizeBytes = estimateQ4Bytes(params);
  const toolTag = tags.some((t) => /tool|function[-_ ]?call/i.test(t));
  const pipe = String(m.pipeline_tag || '');
  // Only chat/text models can talk to you: an embedding, speech or image model can't (when HF says so).
  const embedding = /feature-extraction|sentence-similarity/i.test(pipe) || tags.some((t) => /^sentence-transformers$|^embeddings?$/i.test(t));
  const chat = !pipe || /text-generation|text2text|conversational|image-text-to-text/i.test(pipe) ? true : false;
  return {
    embedding, chat,
    id: `hf:${id}`, repo: id, source: 'hf', name: id, title: id.split('/').pop() || id,
    description: m.pipeline_tag ? String(m.pipeline_tag).replace(/-/g, ' ') : '',
    pullName: `hf.co/${id}:Q4_K_M`, params, sizeBytes, quant: 'Q4_K_M',
    uncensored: isUncensored(id, tags), tools: toolTag || toolsLikely(id) ? true : null,
    vision: tags.some((t) => /vision|image-text-to-text|multimodal/i.test(t)) || String(m.pipeline_tag || '') === 'image-text-to-text',
    downloads: Number.isFinite(Number(m.downloads)) ? Number(m.downloads) : null,
    likes: Number.isFinite(Number(m.likes)) ? Number(m.likes) : null,
    url: `${HF_BASE}/${id}`, gated: !!(m.gated && m.gated !== 'false'),
    lastModified: m.lastModified || null,
    // Real file list comes from hfFiles(); until then one estimated Q4 variant.
    variants: [{ tag: 'Q4_K_M', quant: 'Q4_K_M', params, sizeBytes, estimated: true, pullName: `hf.co/${id}:Q4_K_M` }],
    filesLoaded: false, fit: null,
  };
}

/** Model name as Ollama reports it: lower case, ":latest" when there is no tag. */
function speedKey(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  return /:[^/]+$/.test(n) ? n : `${n}:latest`;
}
/** tokens/second Alfred measured for this model (opts.speeds: { name: tokensPerSec | {tokensPerSec} }), or null. */
function measuredSpeed(speeds, name) {
  if (!speeds || !name) return null;
  const want = speedKey(name);
  for (const k of Object.keys(speeds)) {
    if (speedKey(k) !== want) continue;
    const v = speeds[k];
    const t = Number(v && typeof v === 'object' ? v.tokensPerSec : v);
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  return null;
}

/** Rate every variant, auto-pick the best that fits, and set model.fit / pullName / size from it — plus its speed and verdict. */
function rateModel(model, hardware, opts) {
  const o = opts || {};
  const variants = (model.variants || []).map((v) => {
    const fit = hw.rateFit(v.sizeBytes, hardware, o);
    return Object.assign({}, v, { fit, speed: hw.estimateSpeed(v.sizeBytes, hardware, { fit, measured: measuredSpeed(o.speeds, v.pullName) }) });
  });
  const pick = o.preferQuants || (model.source === 'hf' && model.filesLoaded) ? pickQuant(variants, hardware, o) : hw.pickVariant(variants, hardware, o);
  let chosen = pick ? variants.find((v) => v.pullName === pick.pullName) : null;
  if (!chosen) chosen = variants.filter((v) => v.sizeBytes).sort((a, b) => a.sizeBytes - b.sizeBytes)[0] || variants[0] || null;
  const out = Object.assign({}, model, { variants });
  if (chosen) {
    out.fit = chosen.fit; out.pick = chosen.tag; out.pullName = chosen.pullName; out.speed = chosen.speed;
    out.sizeBytes = chosen.sizeBytes; out.quant = chosen.quant || out.quant; out.params = chosen.params != null ? chosen.params : out.params;
  } else { out.fit = hw.rateFit(null, hardware); out.speed = hw.estimateSpeed(null, hardware); }
  out.verdict = hw.verdictFor(out, out.fit, chosen);
  return out;
}

/** Popularity tie-break inside the same verdict / fit / speed step. */
function rankScore(m) {
  let s = Math.log10((m.downloads || 0) + 1) * 0.6;
  if (m.tools === true) s += 1;
  return s;
}
const isBad = (m) => (m.verdict ? m.verdict.kind === 'bad' : !!(m.embedding || (m.fit && m.fit.rating === 'too-big'))) ? 1 : 0;
/**
 * The order of every model list: ✖ not-a-good-pick last; with 🔓 on, uncensored ones first; then
 * ✔ good pick → ◐ works-but, then fit (Excellent → Good → OK → Slow), then speed in steps; ties keep `then`.
 */
function compareModels(a, b, o, then) {
  return (isBad(a) - isBad(b))
    || (o && o.uncensored && !!a.uncensored !== !!b.uncensored ? (a.uncensored ? -1 : 1) : 0)
    || hw.compareChoice(a, b)
    || (then ? then(a, b) : 0);
}

// ------------------------------------------------------------------ curated (offline)
// Sizes are the Ollama library's default (Q4_K_M-ish) downloads, in GB.
const CURATED = [
  { name: 'qwen3', title: 'Qwen 3', description: 'Strong all-rounder from Alibaba; great at following instructions and calling tools.', tools: true, thinking: true, sizes: { '0.6b': 0.52, '1.7b': 1.4, '4b': 2.5, '8b': 5.2, '14b': 9.3, '30b': 19, '32b': 20 } },
  { name: 'qwen2.5', title: 'Qwen 2.5', description: 'Reliable, fast and very good at tools and JSON — a safe first choice.', tools: true, sizes: { '0.5b': 0.4, '1.5b': 0.99, '3b': 1.9, '7b': 4.7, '14b': 9.0, '32b': 20, '72b': 47 } },
  { name: 'llama3.1', title: 'Llama 3.1', description: 'Meta\'s well-known general model with tool calling.', tools: true, sizes: { '8b': 4.9, '70b': 43 } },
  { name: 'llama3.2', title: 'Llama 3.2', description: 'Small, quick Llama for modest PCs; can call tools.', tools: true, sizes: { '1b': 1.3, '3b': 2.0 } },
  { name: 'mistral-nemo', title: 'Mistral Nemo', description: 'Mistral and NVIDIA\'s 12B model with a long memory and tool calling.', tools: true, sizes: { '12b': 7.1 } },
  { name: 'mistral', title: 'Mistral 7B', description: 'Classic, light 7B model with tool calling.', tools: true, sizes: { '7b': 4.1 } },
  { name: 'phi4-mini', title: 'Phi-4 mini', description: 'Microsoft\'s small model; good for lower-end PCs.', tools: true, sizes: { '3.8b': 2.5 } },
  { name: 'llama3.3', title: 'Llama 3.3', description: 'Meta\'s big 70B model — needs a very powerful PC.', tools: true, sizes: { '70b': 43 } },
  { name: 'hermes3', title: 'Hermes 3 (uncensored)', description: 'Nous Research\'s Llama 3 tune: few refusals, follows instructions and calls tools well.', tools: true, uncensored: true, sizes: { '3b': 2.0, '8b': 4.7, '70b': 40 } },
  { name: 'dolphin3', title: 'Dolphin 3 (uncensored)', description: 'Eric Hartford\'s uncensored Llama 3.1 8B; obeys your instructions without lectures.', tools: null, uncensored: true, sizes: { '8b': 4.9 } },
  { name: 'huihui_ai/qwen3-abliterated', title: 'Qwen 3 abliterated (uncensored)', description: 'Qwen 3 with its refusals removed ("abliterated"); keeps tool calling.', tools: true, uncensored: true, thinking: true, sizes: { '4b': 2.5, '8b': 5.0, '14b': 9.0, '32b': 20 } },
  { name: 'huihui_ai/qwen2.5-abliterate', title: 'Qwen 2.5 abliterated (uncensored)', description: 'Qwen 2.5 with its refusals removed; good at tools and JSON.', tools: true, uncensored: true, sizes: { '7b': 4.7, '14b': 9.0 } },
  { name: 'huihui_ai/llama3.2-abliterate', title: 'Llama 3.2 abliterated (uncensored)', description: 'Small Llama 3.2 with its refusals removed, for modest PCs.', tools: true, uncensored: true, sizes: { '1b': 1.3, '3b': 2.0 } },
  { name: 'dolphin-mistral', title: 'Dolphin Mistral (uncensored)', description: 'Older uncensored Mistral 7B; light and quick.', tools: null, uncensored: true, sizes: { '7b': 4.1 } },
  { name: 'dolphin-mixtral', title: 'Dolphin Mixtral (uncensored)', description: 'Big uncensored mixture-of-experts model for powerful PCs.', tools: null, uncensored: true, sizes: { '8x7b': 26 } },
];

function curatedModels() {
  return CURATED.map((c, i) => {
    const variants = Object.keys(c.sizes).map((size) => ({
      tag: `${c.name}:${size}`, quant: 'Q4_K_M', params: parseParams(size), sizeBytes: Math.round(c.sizes[size] * GB), pullName: `${c.name}:${size}`,
    }));
    return {
      id: `curated:${c.name}`, source: 'curated', name: c.name, title: c.title, description: c.description,
      pullName: variants[0].pullName, params: variants[0].params, sizeBytes: variants[0].sizeBytes, quant: 'Q4_K_M',
      uncensored: !!c.uncensored, tools: c.tools, vision: false, thinking: !!c.thinking, downloads: null, likes: null,
      url: `${OLLAMA_BASE}/${c.name.includes('/') ? c.name : `library/${c.name}`}`, gated: false, variants, fit: null, order: i,
    };
  });
}

// ------------------------------------------------------------------ 🔓 uncensored finder helpers
// The quants we'd rather download (best quality first): good quality for their size, and Ollama runs them well.
const PREFERRED_QUANTS = ['Q5_K_M', 'Q4_K_M', 'IQ4_XS'];
function quantPref(v) {
  const q = String((v && (v.quant || v.tag)) || '').toUpperCase().replace(/^UD-/, '').split(':').pop();
  const i = PREFERRED_QUANTS.indexOf(q);
  return i < 0 ? 99 : i;
}
/**
 * pickQuant(variants, hardware) -> the size to download. First a preferred quant (Q5_K_M / Q4_K_M / IQ4_XS)
 * that runs fully on the graphics card: the best fit tier (★★★ > ★★ > ★), then Q5_K_M > Q4_K_M > IQ4_XS.
 * Else any other quant that runs on the card: 3–6 bits before the rest (2-bit is poor, 8-bit is twice the
 * download for little gain), then the best tier, then the biggest. Else 🐢: the smallest (least spill onto the
 * processor). Nothing runs → null. The returned object is a copy with .fit set.
 */
function pickQuant(variants, hardware, opts) {
  const list = (Array.isArray(variants) ? variants : []).filter((v) => v && Number(v.sizeBytes) > 0)
    .map((v) => Object.assign({}, v, { fit: hw.rateFit(v.sizeBytes, hardware, opts) }));
  const TIER = { excellent: 3, good: 2, ok: 1 };
  const onCard = list.filter((v) => TIER[v.fit.rating]);
  const pref = onCard.filter((v) => quantPref(v) < 99)
    .sort((a, b) => TIER[b.fit.rating] - TIER[a.fit.rating] || quantPref(a) - quantPref(b) || b.sizeBytes - a.sizeBytes);
  if (pref.length) return pref[0];
  const odd = (v) => { const b = quantBits(v.quant); return b == null ? 0 : (b < 3 || b > 6 ? 1 : 0); };
  const rest = onCard.sort((a, b) => odd(a) - odd(b) || TIER[b.fit.rating] - TIER[a.fit.rating] || b.sizeBytes - a.sizeBytes);
  if (rest.length) return rest[0];
  const slow = list.filter((v) => v.fit.rating === 'slow').sort((a, b) => a.sizeBytes - b.sizeBytes);
  return slow[0] || null;
}

// Names / tags that say a model was made for tools, and base families known to call tools well in Ollama.
const TOOL_WORDS_RE = /(^|[^a-z])(tools?|agentic|agent|hermes|function[-_ ]?call(?:ing)?|fc)([^a-z]|$)/i;
const TOOL_BASES_RE = /(qwen-?2\.5|qwen-?3|qwq|llama-?3\.[123]|llama3\.[123]|mistral-?small|gpt-?oss|hermes)/i;
/** 🛠 good for Alfred's tools / ⚠ may not use tools well — from the source's own flag, the name/tags, or the base family. */
function toolHint(model) {
  const m = model || {};
  const text = [m.name, m.repo, m.title, m.pullName, m.description].concat(Array.isArray(m.tags) ? m.tags : []).filter(Boolean).join(' ');
  const good = m.tools === true || TOOL_WORDS_RE.test(text) || TOOL_BASES_RE.test(text) || toolsLikely(text);
  return good
    ? { good: true, label: '🛠 good for Alfred\'s tools' }
    : { good: false, label: '⚠ may not use tools well' };
}
/** One plain line saying what "uncensored" means for this model. */
function uncensoredLine(model) {
  const m = model || {};
  const text = [m.name, m.repo, m.title, m.description].filter(Boolean).join(' ');
  if (/abliterat|obliterat|heretic|huihui|josiefied|no[-_ ]?refusal/i.test(text)) return 'Uncensored: refusals removed (abliterated) — knowledge and skill same as the base model';
  return 'Uncensored: re-trained to follow instructions without refusing — knowledge and skill close to the base model';
}
const UNC_OLLAMA_QUERIES = ['uncensored', 'abliterated', 'dolphin', 'hermes'];
const UNC_HF_QUERIES = ['abliterated', 'uncensored', 'heretic'];
/** What is kept in the small "last result" cache (the ratings are worked out again for this PC when it's read). */
function cacheable(m) {
  const keep = ['id', 'source', 'name', 'repo', 'title', 'description', 'params', 'quant', 'uncensored', 'tools', 'vision', 'thinking', 'downloads', 'likes', 'url', 'gated', 'filesLoaded', 'chat', 'embedding'];
  const o = {};
  for (const k of keep) if (m[k] !== undefined) o[k] = m[k];
  o.variants = (m.variants || []).slice(0, 24).map((v) => ({ tag: v.tag, quant: v.quant, params: v.params, sizeBytes: v.sizeBytes, estimated: !!v.estimated, pullName: v.pullName, parts: v.parts }));
  return o;
}

// ------------------------------------------------------------------ the catalog
function createCatalog(options) {
  const o = options || {};
  const fetchFn = o.fetch || (typeof fetch === 'function' ? fetch : null);
  const getToken = typeof o.hfToken === 'function' ? o.hfToken : () => o.hfToken || '';
  const timeoutMs = Math.max(1000, o.timeoutMs || 15000);
  const ollamaBase = o.ollamaBase || OLLAMA_BASE;
  const hfBase = o.hfBase || HF_BASE;

  function token() { try { const t = getToken(); return t ? String(t).trim() : ''; } catch (_) { return ''; } }
  function netError(e, site) {
    const s = [e && e.name, e && e.message, e && e.cause && e.cause.code, typeof e === 'string' ? e : ''].filter(Boolean).join(' ');
    if (/abort|timeout/i.test(s)) return `${site} took too long to answer. Check your internet connection and try again.`;
    return `Couldn't reach ${site}. Check your internet connection (or try again later).`;
  }
  // GET with a timeout; never throws. → { ok, status, text?, json?, error? }
  async function get(url, { headers, site, json }) {
    if (!fetchFn) return { ok: false, error: `Can't search ${site} from here (no internet access available).` };
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; try { ctl && ctl.abort(); } catch (_) {} }, timeoutMs);
    try {
      const res = await fetchFn(url, { method: 'GET', headers: headers || {}, signal: ctl ? ctl.signal : undefined });
      if (!res || typeof res.status !== 'number') return { ok: false, error: `${site} sent an answer we couldn't read.` };
      if (!res.ok) return { ok: false, status: res.status, error: null };
      if (json) {
        try { return { ok: true, status: res.status, json: await res.json() }; } catch (_) { return { ok: false, status: res.status, error: `${site} sent an answer we couldn't read.` }; }
      }
      return { ok: true, status: res.status, text: await res.text() };
    } catch (e) {
      return { ok: false, error: netError(timedOut ? 'timeout' : e, site) };
    } finally { clearTimeout(t); }
  }
  function hfHeaders() { const t = token(); const h = { Accept: 'application/json' }; if (t) h.Authorization = `Bearer ${t}`; return h; }
  function httpError(status, site) {
    if (status === 401) return `${site} didn't accept your token. Check it in "Hugging Face token" and try again.`;
    if (status === 403) return `${site} says this needs permission. Accept the model's terms on its page and connect your token.`;
    if (status === 404) return `${site} couldn't find that.`;
    if (status === 429) return `${site} is getting too many searches right now. Wait a minute and try again.`;
    if (status >= 500) return `${site} is having trouble right now. Try again later.`;
    return `${site} answered with an error (${status}).`;
  }

  async function searchOllama(query, opts) {
    const so = opts || {};
    let url = `${ollamaBase}/search?q=${encodeURIComponent(String(query || '').trim())}`;
    if (so.toolsOnly) url += '&c=tools';
    const r = await get(url, { headers: { Accept: 'text/html' }, site: 'The Ollama library' });
    if (!r.ok) return { ok: false, models: [], error: r.error || httpError(r.status, 'The Ollama library') };
    let parsed;
    try { parsed = parseOllamaSearchHtml(r.text); } catch (_) { parsed = null; }
    if (!parsed) return { ok: false, models: [], error: 'The Ollama library page changed and we couldn\'t read it. Use "Recommended" or Hugging Face instead.' };
    if (!parsed.length && /<li\b/i.test(r.text) && !/x-test-/i.test(r.text)) {
      return { ok: false, models: [], error: 'The Ollama library page changed and we couldn\'t read it. Use "Recommended" or Hugging Face instead.' };
    }
    let models = parsed.map(ollamaModel);
    if (so.hardware) models = models.map((m) => rateModel(m, so.hardware, so));
    return { ok: true, models };
  }

  async function searchHf(query, opts) {
    const so = opts || {};
    const limit = Math.min(100, Math.max(1, Number(so.limit) || 30));
    const url = `${hfBase}/api/models?search=${encodeURIComponent(String(query || '').trim())}&filter=gguf&sort=downloads&direction=-1&limit=${limit}`;
    const r = await get(url, { headers: hfHeaders(), site: 'Hugging Face', json: true });
    if (!r.ok) return { ok: false, models: [], error: r.error || httpError(r.status, 'Hugging Face') };
    if (!Array.isArray(r.json)) return { ok: false, models: [], error: 'Hugging Face sent an answer we couldn\'t read.' };
    let models = r.json.filter((m) => m && (m.id || m.modelId)).map(hfModel);
    if (so.hardware) models = models.map((m) => rateModel(m, so.hardware, so));
    return { ok: true, models };
  }

  async function hfFiles(repoId, opts) {
    const so = opts || {};
    const repo = String(repoId || '').replace(/^hf:/, '').replace(/^hf\.co\//, '').replace(/^https?:\/\/huggingface\.co\//, '').split(':')[0].trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, variants: [], error: 'That doesn\'t look like a Hugging Face model name (it should be like "user/model").' };
    const url = `${hfBase}/api/models/${repo.split('/').map(encodeURIComponent).join('/')}?blobs=true`;
    const r = await get(url, { headers: hfHeaders(), site: 'Hugging Face', json: true });
    if (!r.ok) {
      let error = r.error || httpError(r.status, 'Hugging Face');
      if (r.status === 401 || r.status === 403) error = token()
        ? 'Hugging Face says your token can\'t open this model. Accept the model\'s terms on its page, then try again.'
        : 'This model is gated: accept its terms on Hugging Face and connect your Hugging Face token, then try again.';
      if (r.status === 404) error = 'Couldn\'t find that model on Hugging Face (it may be private or renamed).';
      return { ok: false, variants: [], gated: r.status === 401 || r.status === 403, rateLimited: r.status === 429, status: r.status || null, error };
    }
    const d = r.json || {};
    const gguf = d.gguf || {};
    let variants = groupGgufFiles(d.siblings, repo);
    const vision = Array.isArray(d.siblings) && d.siblings.some((s) => /mmproj/i.test(String(s && s.rfilename)));
    const template = String(gguf.chat_template || '');
    const tools = template ? /tools|tool_call|function/i.test(template) : (toolsLikely(repo) ? true : null);
    const params = Number(gguf.total) > 0 ? Math.round(Number(gguf.total) / 1e8) / 10 : parseParams(repo.split('/').pop());
    const tags = Array.isArray(d.tags) ? d.tags : [];
    const card = d.cardData || {};
    variants = variants.map((v) => Object.assign(v, { params }));
    if (so.hardware) {
      variants = variants.map((v) => {
        const fit = hw.rateFit(v.sizeBytes, so.hardware, so);
        return Object.assign(v, { fit, speed: hw.estimateSpeed(v.sizeBytes, so.hardware, { fit, measured: measuredSpeed(so.speeds, v.pullName) }) });
      });
    }
    const pick = so.hardware ? hw.pickVariant(variants, so.hardware, so) : null;
    const out = {
      ok: true, repo, variants, gated: !!(d.gated && d.gated !== 'false'), tools, params,
      contextLength: Number(gguf.context_length) || null, architecture: gguf.architecture || null, vision,
      uncensored: isUncensored(repo, tags, card.tags || []), pick: pick ? pick.tag : null,
    };
    if (!variants.length) { out.ok = false; out.error = 'This Hugging Face model has no GGUF files Ollama can download.'; }
    else if (variants.some((v) => v.parts > 1)) out.note = 'Some sizes are split into several files; Ollama may not be able to download those — pick a single-file size if one fits.';
    return out;
  }

  function widen(query, uncensored) {
    const q = String(query || '').trim();
    if (!uncensored) return [q];
    if (isUncensored(q)) return [q];
    return q ? [q, `${q} abliterated`, `${q} uncensored`] : ['uncensored', 'abliterated', 'dolphin'];
  }

  async function search(query, opts) {
    const so = Object.assign({ sources: ['ollama', 'hf'] }, opts || {});
    const sources = (Array.isArray(so.sources) ? so.sources : [so.sources]).filter((s) => s === 'ollama' || s === 'hf');
    if (!sources.length) return { ok: false, models: [], errors: [{ source: 'all', message: 'Pick at least one place to search (Ollama library or Hugging Face).' }] };
    const queries = widen(query, so.uncensored);
    const jobs = [];
    for (const src of sources) for (const q of queries) {
      jobs.push((src === 'ollama' ? searchOllama(q, { toolsOnly: so.toolsOnly }) : searchHf(q, { limit: so.limit })).then((r) => ({ src, r })));
    }
    const results = await Promise.all(jobs);
    const errors = []; const seen = new Map();
    for (const { src, r } of results) {
      if (!r.ok) { if (!errors.some((e) => e.source === src)) errors.push({ source: src, message: r.error }); continue; }
      for (const m of r.models) if (!seen.has(m.id)) seen.set(m.id, m);
    }
    // A source counts as working if any of its queries succeeded.
    const okSources = new Set(results.filter((x) => x.r.ok).map((x) => x.src));
    const errs = errors.filter((e) => !okSources.has(e.source));
    let models = [...seen.values()].filter((m) => !m.embedding || so.includeEmbedding);
    if (so.toolsOnly) models = models.filter((m) => m.tools === true);
    models = models.map((m) => rateModel(m, so.hardware, so));
    models.sort((a, b) => compareModels(a, b, so, (x, y) => rankScore(y) - rankScore(x)));
    return { ok: okSources.size > 0, models, errors: errs };
  }

  /**
   * 🔓 The uncensored finder: the Ollama library ("uncensored", "abliterated", "dolphin", "hermes") and
   * Hugging Face GGUF repos ("abliterated", "uncensored", "heretic"), merged, ONLY uncensored chat models,
   * the most-downloaded Hugging Face ones with their exact file sizes (so the quant that fits the graphics
   * card is picked), each rated for this PC with a tool-use hint and a plain "what uncensored means" line.
   * opts: { sources, hardware, speeds, cache: { read() -> {at, models}, write(obj) }, filesLimit=8, max=40, now }
   * Offline / rate-limited: the last result from the cache (re-rated), else the built-in list — never throws.
   */
  async function findUncensored(opts) {
    const so = Object.assign({ sources: ['ollama', 'hf'] }, opts || {});
    const sources = (Array.isArray(so.sources) ? so.sources : [so.sources]).filter((x) => x === 'ollama' || x === 'hf');
    const useSources = sources.length ? sources : ['ollama', 'hf'];
    const now = typeof so.now === 'function' ? so.now : () => Date.now();
    const jobs = [];
    if (useSources.includes('ollama')) for (const q of UNC_OLLAMA_QUERIES) jobs.push(searchOllama(q, {}).then((r) => ({ src: 'ollama', r })));
    if (useSources.includes('hf')) for (const q of UNC_HF_QUERIES) jobs.push(searchHf(q, { limit: so.limit || 25 }).then((r) => ({ src: 'hf', r })));
    const results = await Promise.all(jobs);
    const seen = new Map(); const errors = [];
    for (const { src, r } of results) {
      if (!r.ok) { if (!errors.some((e) => e.source === src)) errors.push({ source: src, message: r.error }); continue; }
      for (const m of r.models) if (!seen.has(m.id)) seen.set(m.id, m);
    }
    const okSources = new Set(results.filter((x) => x.r.ok).map((x) => x.src));
    const errs = errors.filter((e) => !okSources.has(e.source));
    const annotate = (m) => Object.assign(m, { uncensored: true, toolHint: toolHint(m), uncensoredLine: uncensoredLine(m) });
    const finish = (list) => list.map((m) => annotate(rateModel(m, so.hardware, Object.assign({}, so, { preferQuants: true }))))
      .sort((a, b) => compareModels(a, b, { uncensored: true }, (x, y) => rankScore(y) - rankScore(x)));
    const errText = errs.map((e) => e.message).filter(Boolean).join(' ');

    if (!okSources.size) {
      let cached = null;
      try { cached = so.cache && typeof so.cache.read === 'function' ? so.cache.read() : null; } catch (_) { cached = null; }
      if (cached && Array.isArray(cached.models) && cached.models.length) {
        const when = cached.at ? new Date(cached.at).toLocaleDateString() : 'earlier';
        return { ok: true, models: finish(cached.models.map((m) => Object.assign({}, m))), errors: errs, fromCache: true, cachedAt: cached.at || null,
          message: `${errText || 'The model sites didn\'t answer.'} Showing the uncensored models found on ${when} (saved on this PC).` };
      }
      const offline = curatedModels().filter((m) => m.uncensored);
      return { ok: true, models: finish(offline), errors: errs, offline: true,
        message: `${errText || 'The model sites didn\'t answer.'} Showing the built-in list of uncensored models (works offline).` };
    }

    let models = [...seen.values()].filter((m) => (m.uncensored || isUncensored(m.name, m.description)) && !m.embedding && m.chat !== false);
    // Exact file sizes for the most-downloaded Hugging Face repos (a few, one after another in small groups: polite to the API).
    const hfTop = models.filter((m) => m.source === 'hf').sort((a, b) => (b.downloads || 0) - (a.downloads || 0)).slice(0, Math.max(0, so.filesLimit == null ? 8 : so.filesLimit));
    let limited = false;
    for (let i = 0; i < hfTop.length && !limited; i += 3) {
      const group = hfTop.slice(i, i + 3);
      const got = await Promise.all(group.map((m) => hfFiles(m.repo, {}).catch(() => null)));
      group.forEach((m, k) => {
        const r = got[k];
        if (!r) return;
        if (r.rateLimited) { limited = true; return; }
        if (!r.ok || !Array.isArray(r.variants) || !r.variants.length) { if (r.ok === false && /no GGUF/i.test(r.error || '')) m.noGguf = true; return; }
        m.variants = r.variants.filter((v) => (v.parts || 1) === 1).length ? r.variants.filter((v) => (v.parts || 1) === 1) : r.variants;
        m.filesLoaded = true;
        if (r.tools != null && m.tools !== true) m.tools = r.tools;
        if (r.params) m.params = r.params;
        if (r.gated) m.gated = true;
        if (r.vision) m.vision = true;
      });
    }
    models = models.filter((m) => !m.noGguf);
    models = finish(models).slice(0, Math.max(1, so.max || 40));
    if (limited) errs.push({ source: 'hf', message: 'Hugging Face is getting too many requests right now, so some sizes are estimates. Wait a minute and try again for exact sizes.' });
    try { if (so.cache && typeof so.cache.write === 'function' && models.length) so.cache.write({ at: now(), models: models.slice(0, 30).map(cacheable) }); } catch (_) {}
    return { ok: true, models, errors: errs, live: true };
  }

  function curated(hardware, opts) {
    const co = opts || {};
    let models = curatedModels();
    if (co.toolsOnly) models = models.filter((m) => m.tools === true);
    models = models.map((m) => rateModel(m, hardware, co));
    models.sort((a, b) => compareModels(a, b, co, (x, y) => x.order - y.order));
    return models;
  }

  return { searchOllama, searchHf, hfFiles, search, curated, findUncensored };
}

module.exports = {
  createCatalog, isUncensored, toolsLikely, parseParams, parseQuant, quantBits, groupGgufFiles,
  parseOllamaSearchHtml, parseCount, estimateQ4Bytes, rateModel, compareModels, measuredSpeed, speedKey, CURATED,
  pickQuant, toolHint, uncensoredLine, PREFERRED_QUANTS, UNC_OLLAMA_QUERIES, UNC_HF_QUERIES,
};
