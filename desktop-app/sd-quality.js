'use strict';
/*
 * sd-quality.js — "make the pictures look right by default", shared by the 🎨 Images tab
 * (loaded with a <script> tag → window.sdQuality) and the main process (require: sd-studio.js).
 * No Electron, no DOM, no fs: plain functions, unit-tested in test/sd-quality.test.js.
 *
 * Why it exists (PR #128, the user's own saved settings): SDXL base at 512×768 / 512×512, 20 steps,
 * CFG 7, "(default)" sampler and no negative prompt came out cartoonish and garbled; Akọwe's book
 * portraits sent ~1,900 characters to CLIP, which reads 75 tokens at a time, so the important words
 * (age, hair, eyes, scars) were diluted by the story around them.
 *
 *   familyOf(name, { base, size })        → 'SDXL' | 'SD1.5' | 'Pony' | 'Illustrious' | 'NoobAI' | 'Flux' | 'SD3' | 'SD2' | ''
 *   isBig(family)                         → true for the ~1 MP families
 *   bucketsFor(family) / sizeFor(family, aspect) / aspectOf(w, h) / nearestBucket(family, w, h)
 *   sizeWarning(family, w, h)             → '' | plain words ("SDXL makes poor pictures this small …")
 *   defaultsFor(family)                   → { steps, cfgScale, sampler, scheduler, distilledCfg? }
 *   pickSampler(family, lists)            → { sampler, scheduler } using ONLY names the backend lists (or null)
 *   defaultNegative(family, style)        → '' for Flux; the usual "lowres, blurry, …" otherwise
 *   STYLES / applyStyle(prompt, style, family) → { prompt, negative } (short quality tags + matching negative terms)
 *   mergeTerms(a, b)                      → "a, b" without repeating a term
 *   estimateTokens(text)                  → a CLIP token estimate (BPE-ish)
 *   condensePrompt(text, { maxTokens })   → { prompt, condensed, tokensBefore, tokensAfter, full }
 *   normalizeBase(raw) / loraInfo(meta, civitaiInfo) / baseMatch(loraBase, checkpointFamily)
 */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.sdQuality = m;
})(typeof self !== 'undefined' ? self : this, function () {
  // ------------------------------------------------------------ model family
  function normalizeBase(raw) {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) return '';
    if (/pony/.test(s)) return 'Pony';
    if (/illustrious/.test(s)) return 'Illustrious';
    if (/noob/.test(s)) return 'NoobAI';
    if (/flux/.test(s)) return 'Flux';
    if (/sd[\s_-]?3|stable-diffusion-3|sd3\.5/.test(s)) return 'SD3';
    if (/sdxl|sd[_\s-]xl|stable-diffusion-xl|xl(?![a-z])/.test(s)) return 'SDXL';
    if (/sd[\s_-]?v?2|stable-diffusion-v2|\b2\.[01]\b/.test(s)) return 'SD2';
    if (/sd[\s_-]?v?1|stable-diffusion-v1|\b1\.[45]\b|^sd1$|sd15/.test(s)) return 'SD1.5';
    return '';
  }
  // From a checkpoint's name (Forge's title "sd_xl_base_1.0_0.9vae.safetensors [e6bb9ea85b]"), what the
  // library read from its header (base), else its file size. '' = can't tell.
  function familyOf(name, info) {
    const i = info || {};
    const fromBase = normalizeBase(i.base);
    if (fromBase) return fromBase;
    const n = String(name || '').replace(/\\/g, '/').split('/').pop().replace(/\s*\[[0-9a-f]{6,}\]\s*$/i, '').toLowerCase();
    if (n) {
      if (/pony/.test(n)) return 'Pony';
      if (/illustrious|\bill?xl/.test(n)) return 'Illustrious';
      if (/noob/.test(n)) return 'NoobAI';
      if (/flux/.test(n)) return 'Flux';
      if (/sd3/.test(n)) return 'SD3';
      if (/sdxl|sd_xl|xl(?![a-z])/.test(n)) return 'SDXL';
      if (/sd15|sd1\.5|sd_1\.5|v1-5|sd-1-5|_v15|1\.5/.test(n)) return 'SD1.5';
    }
    const size = Number(i.size) || 0;
    if (size >= 9.5e9) return 'Flux';
    if (size >= 5.5e9 && size < 8.5e9) return 'SDXL';
    if (size >= 1.5e9 && size < 4.6e9) return 'SD1.5';
    return '';
  }
  const BIG = ['SDXL', 'Pony', 'Illustrious', 'NoobAI', 'Flux', 'SD3'];
  function isBig(f) { return BIG.includes(f); }
  const ARCH = { 'SD1.5': 'sd1', SD2: 'sd2', SDXL: 'sdxl', Pony: 'sdxl', Illustrious: 'sdxl', NoobAI: 'sdxl', SD3: 'sd3', Flux: 'flux' };
  function archOf(f) { return ARCH[f] || ''; }
  function familyLabel(f) { return f === 'Pony' || f === 'Illustrious' || f === 'NoobAI' ? `${f} (SDXL)` : f || 'unknown'; }

  // ------------------------------------------------------------ sizes
  const BUCKETS = {
    SDXL: { portrait: [832, 1216], square: [1024, 1024], landscape: [1216, 832] },
    'SD1.5': { portrait: [512, 768], square: [512, 512], landscape: [768, 512] },
    SD2: { portrait: [576, 832], square: [768, 768], landscape: [832, 576] },
    Flux: { portrait: [896, 1152], square: [1024, 1024], landscape: [1152, 896] },
  };
  function bucketsFor(f) {
    if (f === 'Flux') return BUCKETS.Flux;
    if (f === 'SD2') return BUCKETS.SD2;
    if (isBig(f)) return BUCKETS.SDXL;
    return BUCKETS['SD1.5'];
  }
  const ASPECTS = ['portrait', 'square', 'landscape'];
  function sizeFor(f, aspect) { const b = bucketsFor(f)[ASPECTS.includes(aspect) ? aspect : 'portrait']; return { width: b[0], height: b[1] }; }
  function aspectOf(w, h) { const r = Number(w) / Number(h); if (!(r > 0)) return 'portrait'; return r < 0.87 ? 'portrait' : r > 1.15 ? 'landscape' : 'square'; }
  function nearestBucket(f, w, h) { return sizeFor(f, aspectOf(w, h)); }
  // ~1 MP families below 768×768 worth of pixels (512×768 is 0.39 MP) come out garbled / cartoonish.
  function tooSmall(f, w, h) { return isBig(f) && Number(w) > 0 && Number(h) > 0 && Number(w) * Number(h) < 768 * 768; }
  function sizeWarning(f, w, h) {
    const W = Number(w), H = Number(h);
    if (!(W > 0 && H > 0)) return '';
    if (tooSmall(f, W, H)) {
      const b = nearestBucket(f, W, H);
      return `${f === 'SDXL' ? 'SDXL' : familyLabel(f)} makes poor pictures this small (${W}×${H}) — it is made for about 1 megapixel. Use Portrait / Square / Landscape (${b.width}×${b.height}).`;
    }
    if (f === 'SD1.5' && Math.min(W, H) >= 1024) return `SD1.5 is made for 512–768 px — at ${W}×${H} you may get doubled people or heads. Use Portrait (512×768) and the Hires fix instead.`;
    return '';
  }

  // ------------------------------------------------------------ sampler / steps / CFG
  function defaultsFor(f) {
    if (f === 'Flux') return { steps: 20, cfgScale: 1, distilledCfg: 3.5, sampler: 'Euler', scheduler: 'Simple' };
    if (f === 'SD3') return { steps: 28, cfgScale: 4.5, sampler: 'Euler', scheduler: 'SGM Uniform' };
    if (f === 'Pony' || f === 'Illustrious' || f === 'NoobAI') return { steps: 28, cfgScale: 6, sampler: 'DPM++ 2M', scheduler: 'Karras' };
    if (f === 'SDXL') return { steps: 28, cfgScale: 5.5, sampler: 'DPM++ 2M', scheduler: 'Karras' };
    return { steps: 28, cfgScale: 7, sampler: 'DPM++ 2M', scheduler: 'Karras' };
  }
  const SAMPLER_ALT = {
    'dpm++ 2m': ['dpm++ 2m', 'dpmpp_2m'],
    euler: ['euler', 'euler'],
  };
  const SCHED_ALT = { karras: ['karras'], simple: ['simple'], 'sgm uniform': ['sgm uniform', 'sgm_uniform'] };
  // The family's sampler + scheduler, spelled the way THIS backend lists them; null when it lists neither.
  function pickSampler(f, lists) {
    const L = lists || {};
    const samplers = Array.isArray(L.samplers) ? L.samplers.map(String) : [];
    const schedulers = Array.isArray(L.schedulers) ? L.schedulers.map(String) : [];
    if (!samplers.length) return null;
    const d = defaultsFor(f);
    const find = (arr, names) => { for (const n of names) { const hit = arr.find((x) => x.toLowerCase() === n); if (hit) return hit; } return ''; };
    const sKey = d.sampler.toLowerCase();
    const sch = find(schedulers, SCHED_ALT[d.scheduler.toLowerCase()] || [d.scheduler.toLowerCase()]);
    // Old A1111 (no scheduler list): the scheduler is part of the sampler's name ("DPM++ 2M Karras").
    const combined = find(samplers, [`${sKey} ${d.scheduler.toLowerCase()}`]);
    const plain = find(samplers, SAMPLER_ALT[sKey] || [sKey]);
    if (!schedulers.length && combined) return { sampler: combined, scheduler: '' };
    if (plain) return { sampler: plain, scheduler: sch };
    if (combined) return { sampler: combined, scheduler: '' };
    return null;
  }

  // ------------------------------------------------------------ negative prompt + styles
  const NEG_BASE = 'lowres, blurry, deformed, bad anatomy, bad hands, extra fingers, missing fingers, watermark, text, signature, jpeg artifacts';
  const STYLES = {
    photo: { label: 'Photo-real', tags: 'RAW photo, photorealistic, natural skin texture, detailed face, sharp focus, 50mm lens', negative: 'cartoon, anime, illustration, painting, drawing, 3d render, cgi, doll, plastic skin' },
    cinematic: { label: 'Cinematic', tags: 'cinematic film still, dramatic lighting, shallow depth of field, film grain, color graded', negative: 'cartoon, anime, 3d render, flat lighting, oversaturated' },
    illustration: { label: 'Illustration', tags: 'detailed digital illustration, clean lines, rich colors', negative: 'photo, photorealistic, blurry' },
    anime: { label: 'Anime', tags: 'anime style, cel shading, vibrant colors, detailed eyes', negative: 'photo, photorealistic, 3d render' },
    painting: { label: 'Painting', tags: 'oil painting, visible brush strokes, painterly, fine art', negative: 'photo, 3d render, anime' },
  };
  const STYLE_IDS = Object.keys(STYLES);
  function splitTerms(s) { return String(s || '').split(',').map((x) => x.trim()).filter(Boolean); }
  function mergeTerms(a, b) {
    const out = splitTerms(a);
    const seen = new Set(out.map((x) => x.toLowerCase()));
    for (const t of splitTerms(b)) if (!seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    return out.join(', ');
  }
  function defaultNegative(f, style) {
    if (f === 'Flux') return ''; // Flux runs at CFG 1: a negative prompt does nothing
    let n = NEG_BASE;
    if (f === 'Pony') n = `score_4, score_5, score_6, ${n}`;
    const st = STYLES[style];
    if (st) n = mergeTerms(n, st.negative);
    return n;
  }
  const PONY_PREFIX = 'score_9, score_8_up, score_7_up';
  function applyStyle(prompt, style, f) {
    let p = String(prompt || '').trim();
    const st = STYLES[style];
    if (st) {
      const have = p.toLowerCase();
      const add = splitTerms(st.tags).filter((t) => !have.includes(t.toLowerCase()));
      if (add.length) p = p ? `${p.replace(/[,\s]+$/, '')}, ${add.join(', ')}` : add.join(', ');
    }
    if (f === 'Pony' && !/score_9/i.test(p)) p = p ? `${PONY_PREFIX}, ${p}` : PONY_PREFIX;
    return { prompt: p, negative: st ? st.negative : '' };
  }

  // ------------------------------------------------------------ prompt condensing
  // CLIP's BPE: a common word is one token, a long or rare one two or three, punctuation one each.
  function estimateTokens(text) {
    const pieces = String(text || '').replace(/<(?:lora|lyco|hypernet):[^>]*>/gi, ' ').toLowerCase().match(/[a-z0-9]+|[^\sa-z0-9]/g) || [];
    let n = 0;
    for (const p of pieces) n += /^[a-z0-9]+$/.test(p) ? (p.length > 14 ? 3 : p.length > 8 ? 2 : 1) : 1;
    return n;
  }
  const CAT = ['subject', 'looks', 'clothing', 'setting', 'lighting', 'style', 'other'];
  const RX = {
    narrative: /\b(known|loves?|loved|hates?|fears?|feared|believes?|grew|born|raised|personality|temper(?:ament)?|kind-hearted|loyal|wants?|dreams?|remembers?|secret|history|past|because|learned|learnt|taught|respects?|rivals?|spirits?|gods?|always|never|often|usually|story|family|mother|father|brother|sister|husband|wife|son|daughter|friend|enemy|chapter|book|tribe|village elders|trusts?|speaks?|says|said|thinks?|feels?|hopes?|lost|killed|died|fought|served|works? as|job|role|reputation|respected|feared by)\b/i,
    looks: /\b(hair|haired|eyes?|eyed|face|faced|skin|skinned|scars?|scarred|beard|bearded|moustache|mustache|stubble|freckles?|freckled|tattoos?|tattooed|nose|lips?|mouth|jaw|jawline|cheeks?|cheekbones?|brows?|eyebrows?|forehead|complexion|build|built|tall|short|slender|slim|muscular|stocky|lean|broad|thin|heavyset|plump|wiry|wrinkles?|wrinkled|bald|braids?|braided|curls?|curly|locs|dreadlocks|teeth|smile|ears?|shoulders|height|features|pale|tanned|dark-skinned|ebony|olive|weathered|grey|gray|silver|blonde?|brunette|auburn|ginger|red-haired|chin|neck|hands|arms|body|figure|physique|age|aged|years? old|year-old|\d+\s*(?:yo|y\/o))\b/i,
    clothing: /\b(wears?|wearing|worn|dressed|dress|coat|cloak|robes?|shirt|gown|armou?r|tunic|boots|hat|hood|hooded|jacket|trousers|pants|skirt|scarf|belt|gloves|jewel(?:ry|lery)?|necklace|rings?|earrings?|bracelets?|beads|uniform|cape|vest|sash|crown|helmet|clothes|clothing|attire|garb|garment|fabric|leather|silk|wool|linen|cotton|agbada|kaftan|wrapper|headwrap|gele|turban|veil|apron|sandals|shoes)\b/i,
    lighting: /\b(light(?!\s*(?:brown|skin|gr[ae]y|blue|green|eyes|hair|-))|lighting|lit|glow|glowing|shadows?|sunset|sunrise|dusk|dawn|candle(?:light)?|lantern|moonlight|moonlit|sunlight|sunlit|backlit|rim light|golden hour|chiaroscuro|firelight|torchlight|neon|overcast)\b/i,
    style: /\b(photo|photograph|photography|realistic|photorealistic|cinematic|painting|painted|oil|watercolou?r|illustration|render|rendered|style|art|artwork|detailed|8k|4k|hdr|masterpiece|best quality|high quality|sharp|focus|lens|\d+mm|bokeh|close-?up|full body|half body|headshot|portrait|bust|three-quarter|depth of field)\b/i,
    setting: /\b(background|room|forest|city|street|market|village|town|castle|field|ocean|sea|river|mountains?|desert|interior|outdoors?|indoors|landscape|harbou?r|ship|boat|tavern|palace|temple|shrine|garden|night|rain|raining|snow|fog|misty|mist|standing|sitting|seated|holding|leaning|walking|riding|throne|courtyard|hut|house|home|beach|savanna|jungle|cave|ruins|battlefield|sky|clouds)\b/i,
    subject: /\b(man|woman|men|women|boy|girl|child|kid|person|warrior|king|queen|prince|princess|chief|elder|priest|priestess|soldier|hunter|merchant|farmer|sailor|captain|witch|wizard|mage|knight|lady|gentleman|teen(?:ager)?|old|young|elderly|middle-aged|character|figure|creature|dragon|wolf|horse|cat|dog)\b/i,
  };
  const FILLER_LEAD = /^(?:(?:and|but|also|then|he|she|they|it|his|her|hers|their|its|the|a|an|is|are|was|were|has|have|had|having|who|whom|which|that|there|this|these|those|with|of|in|on|at|as|to|by|very|quite|rather|really|always|usually)\b\s*)+/i;
  const FILLER_IN = /\b(?:very|really|quite|rather|somewhat|extremely|incredibly|truly|just)\s+/gi;
  function cleanFragment(f) {
    let s = String(f || '').replace(/\s+/g, ' ').trim().replace(/^[-–—:;,.\s]+|[-–—:;,.\s]+$/g, '');
    for (let i = 0; i < 3; i++) s = s.replace(FILLER_LEAD, '').trim();
    s = s.replace(/\s+(?:that|which|who)\b.*$/i, '').replace(/\s+from\s+(?:a|an|the)\b.*$/i, '');
    s = s.replace(FILLER_IN, '').replace(/\b(?:is|are|was|were|her|his|their|its)\s+/gi, '').replace(/\s+/g, ' ').trim();
    const words = s.split(' ');
    if (words.length > 10) s = words.slice(0, 10).join(' ');
    return s.replace(/[,.;:\s]+$/, '');
  }
  const BODY = /\b(eyes?|hair|skin|scars?|beard|braid(?:s|ed)?|cornrows|locs|freckles?)\b/i;
  function classify(f, first, sentenceNarrative) {
    if (first) return 'subject';
    if (sentenceNarrative) return 'other';
    if (RX.narrative.test(f) && !RX.looks.test(f) && !RX.clothing.test(f)) return 'other';
    if (RX.lighting.test(f) && !BODY.test(f)) return 'lighting';
    if (RX.clothing.test(f) && !BODY.test(f)) return 'clothing';
    if (RX.looks.test(f)) return 'looks';
    if (RX.style.test(f)) return 'style';
    if (RX.setting.test(f)) return 'setting';
    if (RX.subject.test(f)) return 'subject';
    return 'other';
  }
  // Long story-like descriptions → short tag phrases, most important first, within maxTokens.
  function condensePrompt(text, opts) {
    const o = opts || {};
    const maxTokens = Math.max(40, Math.min(300, Number(o.maxTokens) || 150));
    const full = String(text || '').trim();
    const tokensBefore = estimateTokens(full);
    if (tokensBefore <= maxTokens) return { prompt: full, condensed: false, tokensBefore, tokensAfter: tokensBefore, full };
    const loraTags = full.match(/<(?:lora|lyco|hypernet):[^>]*>/gi) || [];
    const body = full.replace(/<(?:lora|lyco|hypernet):[^>]*>/gi, ' ');
    // sentences → comma clauses → long clauses split at "with / and / wearing" (wearing stays as a marker)
    const frags = [];
    for (const sent of body.split(/(?<=[.!?;])\s+|\n+|[.;!?](?=\s*$)/)) {
      const narr = frags.length > 0 && RX.narrative.test(sent) && !RX.looks.test(sent) && !RX.clothing.test(sent);
      for (const clause of sent.split(/,\s*|\s+[–—-]\s+|\s*\(\s*|\s*\)\s*/)) {
        const c = clause.trim(); if (!c) continue;
        if (c.split(/\s+/).length > 6) {
          for (const part of c.split(/\s+(?=wearing\b|dressed in\b)|\s+(?:with|and|while|but|whose|who has|who wears)\s+/i)) if (part && part.trim()) frags.push({ t: part.trim(), narr });
        } else frags.push({ t: c, narr });
      }
    }
    const buckets = {}; for (const k of CAT) buckets[k] = [];
    const seen = new Set();
    let first = true;
    for (const fr of frags) {
      const cat = classify(fr.t, first, fr.narr);
      const c = cleanFragment(fr.t);
      first = false;
      if (!c || c.length < 2) continue;
      const key = c.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      buckets[cat].push(c);
    }
    // two passes: each kind gets its share first, then what is left goes in priority order
    const share = { subject: 30, looks: 60, clothing: 30, setting: 18, lighting: 14, style: 18, other: 0 };
    const chosen = {}; for (const k of CAT) chosen[k] = [];
    let used = 0;
    const cost = (s) => estimateTokens(s) + 1; // + the comma
    for (const k of CAT) {
      let mine = 0;
      for (const f of buckets[k]) { const c = cost(f); if (mine + c > share[k] || used + c > maxTokens) continue; chosen[k].push(f); mine += c; used += c; }
    }
    for (const k of CAT) for (const f of buckets[k]) { if (k === 'other' || chosen[k].includes(f)) continue; const c = cost(f); if (used + c > maxTokens) continue; chosen[k].push(f); used += c; }
    // keep each kind in the story's order
    const out = [];
    for (const k of CAT) for (const f of buckets[k]) if (chosen[k].includes(f)) out.push(f);
    let prompt = out.join(', ');
    if (loraTags.length) prompt = `${prompt} ${loraTags.join(' ')}`.trim();
    return { prompt, condensed: true, tokensBefore, tokensAfter: estimateTokens(prompt), full, kept: out.length, dropped: Math.max(0, seen.size - out.length) };
  }

  // ------------------------------------------------------------ LoRA metadata
  // safetensors __metadata__ (kohya ss_*, modelspec.*) and/or a Civitai .civitai.info → base + trigger words.
  function loraInfo(meta, civitai) {
    const m = meta || {};
    const out = { base: '', baseSource: '', triggers: [], datasetTags: [] };
    const fam = normalizeBase(m.ss_sd_model_name);
    if (fam && ['Pony', 'Illustrious', 'NoobAI'].includes(fam)) { out.base = fam; out.baseSource = 'ss_sd_model_name'; }
    for (const [v, src] of [[m['modelspec.architecture'], 'modelspec'], [m.ss_base_model_version, 'ss_base_model_version'], [m.ss_v2 === 'True' ? 'sd_v2' : '', 'ss_v2']]) {
      if (out.base) break;
      const b = normalizeBase(v); if (b) { out.base = b; out.baseSource = src; }
    }
    if (m['modelspec.trigger_phrase']) out.triggers.push(...splitTerms(m['modelspec.trigger_phrase']));
    if (m.ss_tag_frequency) {
      try {
        const tf = typeof m.ss_tag_frequency === 'string' ? JSON.parse(m.ss_tag_frequency) : m.ss_tag_frequency;
        const counts = {};
        for (const ds of Object.values(tf || {})) for (const [tag, c] of Object.entries(ds || {})) { const t = tag.trim(); if (t) counts[t] = (counts[t] || 0) + (Number(c) || 0); }
        out.datasetTags = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
      } catch (_) { /* malformed */ }
    }
    const ci = civitai || null;
    if (ci) {
      const b = normalizeBase(ci.baseModel);
      if (b && !out.base) { out.base = b; out.baseSource = 'civitai.info'; }
      const tw = Array.isArray(ci.trainedWords) ? ci.trainedWords : [];
      for (const t of tw) for (const x of splitTerms(t)) if (!out.triggers.some((y) => y.toLowerCase() === x.toLowerCase())) out.triggers.push(x);
    }
    return out;
  }
  // A LoRA's base against the checkpoint's family → 'ok' | 'soft' (same architecture, other flavour) | 'hard' | 'unknown'
  function baseMatch(loraBase, ckFamily) {
    const a = archOf(normalizeBase(loraBase) || loraBase), b = archOf(ckFamily);
    if (!a || !b) return 'unknown';
    if (a !== b) return 'hard';
    return (normalizeBase(loraBase) || loraBase) === ckFamily ? 'ok' : 'soft';
  }
  function loraTag(name, weight) { const w = Math.round(Number(weight) * 100) / 100; return `<lora:${name}:${Number.isFinite(w) ? w : 0.8}>`; }

  return {
    normalizeBase, familyOf, isBig, archOf, familyLabel, tooSmall, BUCKETS, ASPECTS, bucketsFor, sizeFor, aspectOf, nearestBucket, sizeWarning,
    defaultsFor, pickSampler, NEG_BASE, STYLES, STYLE_IDS, defaultNegative, applyStyle, mergeTerms, splitTerms,
    estimateTokens, condensePrompt, loraInfo, baseMatch, loraTag, PONY_PREFIX,
  };
});
