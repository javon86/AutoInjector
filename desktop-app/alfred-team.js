'use strict';
/*
 * alfred-team.js — 🎩 Alfred's TEAM: five roles, each with its own local (Ollama) model.
 *
 *   🎩 Butler         talks with you (the default role; the model chosen in ⚙ → Model is his)
 *   🧰 Assistant      does tasks with the app's tools ("assistant, …"; the Director's task steps)
 *   🎬 Director       plans: splits a request into steps and hands them to the others
 *   😈 Bad boy        the uncensored model, for chat and creative text ("bad boy, …" / "the bad boy")
 *   🎨 Prompt writer  writes picture / video prompts ("make me a picture / video / cover / portrait")
 *
 * A role without a model uses the Butler's model, so one model is enough and nothing breaks.
 * The roles' models only matter when his AI is a LOCAL model; with a web pane or the connected API
 * every role thinks with that one AI.
 *
 * Pure and Electron-free (alfred.js and the panel use it; the renderer gets the same helpers as
 * window.AlfredTeam when this file is loaded by a <script> tag):
 *   route(text)                          → { role, text, why: 'named' | 'intent' | 'default', media? }
 *   modelFor(team, role, butlerModel)    → { model, own }
 *   rate(role, model, ctx)               → { stars 1–5, why: [plain lines], text }
 *   suggest(role, current, models, ctx)  → { model, stars, current } | null   (another DOWNLOADED model fits better)
 *   pickBest(models, ctx, butlerModel)   → { role: model }                   (no downloads: only what is on this PC)
 *   vramPlan({ want, loaded, vramMB, sizeOf }) → { unload: [names], fits, reuse }
 *   teamLine(status)                     → { text, tone: 'ok' | 'warn' | 'off' }
 * Nothing here logs.
 */
(function (root) {
  const ROLES = Object.freeze([
    { id: 'butler', icon: '🎩', name: 'Butler', for: 'Talks with you and answers your questions (the main one).' },
    { id: 'assistant', icon: '🧰', name: 'Assistant', for: 'Does the jobs: uses the app\'s tools (books, pictures, files, the AIs).' },
    { id: 'director', icon: '🎬', name: 'Director', for: 'Makes a plan: splits a big job into steps and hands them to the others.' },
    { id: 'prompt', icon: '🎨', name: 'Prompt writer', for: 'Writes the prompts for pictures, covers, portraits and videos.' },
    { id: 'badboy', icon: '😈', name: 'Bad boy', for: 'The uncensored one: frank chat and creative writing, no lectures.' },
  ]);
  const ROLE_IDS = ROLES.map((r) => r.id);
  const byId = (id) => ROLES.find((r) => r.id === id) || ROLES[0];

  // ------------------------------------------------------------------ routing: the user's words choose the role
  const NAME_RES = [
    ['badboy', 'bad\\s*-?\\s*boy'],
    ['director', 'director'],
    ['assistant', 'assistant'],
    ['prompt', 'prompt\\s*-?\\s*writer'],
    ['butler', 'butler'],
  ];
  const PIC_WORDS = 'pictures?|images?|photos?|photographs?|portraits?|covers?|illustrations?|drawings?|paintings?|artworks?|posters?|wallpapers?|sketch(?:es)?|renders?|art';
  const VID_WORDS = 'videos?|clips?|animations?|trailers?';
  const MAKE = '(?:make|create|generate|render|produce|design|draw|paint|sketch|illustrate|animate|give)';
  const PLAN_RE = /\b(?:break (?:it|this|that|the job|the work)?\s*(?:up|down)|step[- ]by[- ]step|in (?:\w+ )?steps|make a plan|plan (?:it|this|that|out|for|how)|a plan for|split (?:it|this|that|the job) (?:up|into)|(?:first|then)\b[^.?!]{3,80}\b(?:then|after that|finally)\b)/i;

  /** Strip "bad boy, " / "ask the director to " from the front; null when the text doesn't start that way. */
  function addressed(text) {
    const t = String(text || '');
    for (const [id, re] of NAME_RES) {
      // "bad boy, write …", "Director: plan …", "hey assistant, …", "ok prompt writer - …"
      let m = new RegExp(`^\\s*(?:(?:hey|ok|okay|yo|dear|oi)\\s+)?(?:the\\s+|my\\s+|our\\s+)?(?:${re})\\b\\s*[,:;!.\\-–—]*\\s*`, 'i').exec(t);
      if (m && (m[0].length < t.length || id)) return { role: id, text: t.slice(m[0].length).trim() || t.trim() };
      // "ask / let / have / get / tell the director (to) …"
      m = new RegExp(`^\\s*(?:(?:please|can you|could you|would you)\\s+)*(?:ask|let|have|get|tell|use|send (?:it|this|that) to)\\s+(?:the\\s+|my\\s+|our\\s+)?(?:${re})\\b\\s*(?:to\\s+|for\\s+|:|,)?\\s*`, 'i').exec(t);
      if (m) return { role: id, text: t.slice(m[0].length).trim() || t.trim() };
    }
    return null;
  }
  /** What kind of picture / video the words ask for → { kind:'picture'|'video', purpose } | null. */
  function mediaIntent(text) {
    const low = String(text || '').toLowerCase();
    if (!low || low.length > 1500) return null;
    if (/^\s*(?:how|why|what|where|when|which|who|is|are|does|did|can i|should)\b/.test(low) && !/\b(?:make|create|draw|generate)\s+me\b/.test(low)) return null;
    // "ask ChatGPT to draw …" (ChatGPT draws it), and the book's own pictures (a chapter, a dossier's views, the
    // trailer, the map) have their own tools
    if (/\b(?:chat\s?gpt|gpt|openai|claude|gemini|bard)\b/.test(low) || /\b(?:chapters?|dossiers?|trailers?|gallery|folder|maps?|character sheet|turnaround)\b/.test(low)) return null;
    const vid = new RegExp(`\\b${MAKE}\\b[^.?!]{0,50}?\\b(?:${VID_WORDS})\\b|\\b(?:${VID_WORDS})\\s+prompt\\b`).test(low);
    const pic = new RegExp(`\\b${MAKE}\\b[^.?!]{0,50}?\\b(?:${PIC_WORDS})\\b|\\b(?:draw|paint|sketch|illustrate)\\s+(?:me\\s+)?\\S|\\b(?:image|picture|art|cover|portrait)\\s+prompt\\b|\\bprompt (?:for|of) (?:a|an|the|my)\\b`).test(low);
    if (!vid && !pic) return null;
    if (vid && !/\b(?:picture|image|photo|portrait|cover)\s+prompt\b/.test(low)) return { kind: 'video', purpose: 'video' };
    const purpose = /\bcover\b/.test(low) ? 'cover' : /\bportrait\b/.test(low) ? 'portrait' : /\billustrat/.test(low) ? 'illustration' : 'free';
    return { kind: 'picture', purpose };
  }
  /** The role for these words: named first, then the intent (picture/video → Prompt writer, plan → Director), else Butler. */
  function route(text) {
    const t = String(text || '').trim();
    const a = addressed(t);
    if (a) return Object.assign({ role: a.role, text: a.text, why: 'named' }, a.role === 'prompt' || a.role === 'badboy' ? { media: mediaIntent(a.text) } : {});
    // "… and let the bad boy write it", "the bad boy's version" — the bad boy, wherever he is named
    if (/\b(?:the\s+)?bad\s*-?\s*boy\b/i.test(t)) return { role: 'badboy', text: t, why: 'named', media: mediaIntent(t) };
    if (PLAN_RE.test(t) && t.length >= 12) return { role: 'director', text: t, why: 'intent' };
    const media = mediaIntent(t);
    if (media) return { role: 'prompt', text: t, why: 'intent', media };
    return { role: 'butler', text: t, why: 'default' };
  }

  // ------------------------------------------------------------------ which model a role uses
  const modelKey = (m) => { const t = String(m || '').trim().toLowerCase(); return t && !t.includes(':') ? `${t}:latest` : t; };
  const sameModel = (a, b) => !!a && !!b && modelKey(a) === modelKey(b);
  /** The model a role thinks with: its own, else the Butler's. */
  function modelFor(team, role, butlerModel) {
    if (role === 'butler') return { model: butlerModel || '', own: true };
    const m = team && team[role] && String(team[role].model || '').trim();
    return m ? { model: m, own: true } : { model: butlerModel || '', own: false };
  }
  function sanitizeTeam(t) {
    const out = {};
    for (const id of ROLE_IDS) {
      if (id === 'butler') continue;
      const v = t && typeof t === 'object' ? t[id] : null;
      const m = String((v && typeof v === 'object' ? v.model : v) || '').replace(/[^A-Za-z0-9_.:/@+-]/g, '').slice(0, 160);
      out[id] = { model: m };
    }
    return out;
  }

  // ------------------------------------------------------------------ the fit rating ★1–5 per role
  const GB = 1024 * 1024 * 1024;
  const UNC_RE = /uncensor|abliterat|obliterat|dolphin|hermes|(^|[^a-z])lexi([^a-z]|$)|unfilter|nsfw|unaligned|unrestrict|heretic|amoral|josiefied|huihui|no[-_ ]?refusal|(^|[^a-z])evil|tiger-gemma/i;
  const TOOLS_RE = /(qwen2\.5|qwen-?2\.5|qwen3|qwq|llama-?3\.[123]|llama3\.[123]|mistral-nemo|mistral-small|mistral-large|ministral|mixtral|hermes-?[23]|hermes3|command-r|firefunction|granite-?3|phi-?4-mini|smollm2|nemotron|devstral|gpt-oss|glm-?4)/i;
  const NO_TOOLS_RE = /(dolphin|gemma(?!3n)|phi-?3|llava|tinyllama|deepseek-r1|codellama|starcoder|orca|vicuna|mytho|stheno|nous-capybara)/i;
  const REASON_RE = /(qwen3|qwq|deepseek-r1|(^|[^a-z])r1([^a-z]|$)|reason|phi-?4-reasoning|magistral|gpt-oss|exaone-deep|openthinker|marco-o1|thinking)/i;
  const CODER_RE = /(coder|codestral|devstral|starcoder|codellama|codegemma|(^|[^a-z])code)/i;
  const CREATIVE_RE = /(nemo|mistral|llama-?3|gemma|hermes|dolphin|mytho|stheno|rp|story|writer|creative|novel|qwen3|qwen2\.5:(?:14|32)b|command-r|magnum|cydonia|rocinante)/i;
  const EMBED_RE = /(embed|bge-|nomic|minilm|e5-|all-minilm|snowflake-arctic-embed)/i;
  const VISION_ONLY_RE = /(llava|moondream|bakllava|minicpm-v)/i;
  function paramsOf(m) {
    const p = Number(m && m.paramsB);
    if (Number.isFinite(p) && p > 0) return p;
    const s = `${(m && m.params) || ''} ${(m && m.name) || ''}`;
    const moe = /(?:^|[^a-z0-9.])(\d+)x(\d+(?:\.\d+)?)b(?![a-z])/i.exec(s);
    if (moe) return Math.round(Number(moe[1]) * Number(moe[2]) * 0.83 * 10) / 10;
    const b = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*b(?![a-z])/i.exec(s);
    if (b) return Number(b[1]);
    const mm = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*m(?![a-z])/i.exec(s);
    if (mm) return Number(mm[1]) / 1000;
    const sz = Number(m && m.sizeBytes);
    return sz > 0 ? Math.round(((sz / GB) - 0.2) / 0.6 * 10) / 10 : null; // ≈ Q4: 0.6 GB per billion
  }
  function gbText(bytes) { const g = bytes / GB; return g >= 10 ? `${Math.round(g)} GB` : `${Math.round(g * 10) / 10} GB`; }
  /** About how much graphics memory a model needs loaded with a normal chat (file × 1.15 + KV cache + overhead). */
  function needMB(sizeBytes) {
    const mb = Number(sizeBytes) / (1024 * 1024);
    if (!Number.isFinite(mb) || mb <= 0) return null;
    return mb * 1.15 + Math.min(4096, mb * 0.12 + 256) + 500;
  }
  /** Where it runs: 'excellent' | 'good' | 'ok' | 'slow' | 'too-big' | 'unknown' (llm-hardware's tiers, simplified). */
  function fitOf(model, hw, HW) {
    if (HW && typeof HW.rateFit === 'function' && model && model.sizeBytes) {
      try { const f = HW.rateFit(model.sizeBytes, hw); if (f && f.rating) return { rating: f.rating, reason: f.reason || f.text || '' }; } catch (_) { /* fall through */ }
    }
    const need = needMB(model && model.sizeBytes);
    const vram = Number(hw && hw.bestVramMB) || 0;
    if (!need || !hw) return { rating: 'unknown', reason: '' };
    if (vram > 0) {
      if (need + 1500 <= vram) return { rating: 'excellent', reason: '' };
      if (need + 512 <= vram) return { rating: 'good', reason: '' };
      if (need <= vram) return { rating: 'ok', reason: '' };
      if (need <= vram + (Number(hw.ramMB) || 0) * 0.5) return { rating: 'slow', reason: '' };
      return { rating: 'too-big', reason: '' };
    }
    return { rating: need <= (Number(hw.ramMB) || 0) * 0.5 ? 'slow' : 'too-big', reason: '' };
  }
  function measuredTps(speeds, name) {
    if (!speeds || !name) return null;
    const want = modelKey(name);
    for (const k of Object.keys(speeds)) {
      if (modelKey(k) !== want) continue;
      const v = speeds[k]; const t = Number(v && typeof v === 'object' ? v.tokensPerSec : v);
      return Number.isFinite(t) && t > 0 ? t : null;
    }
    return null;
  }
  /** What the model is good at, from its name, the catalog's facts and Ollama's details. */
  function traits(m, catalog) {
    const name = String((m && m.name) || '');
    const base = name.toLowerCase().replace(/^hf\.co\//, '').split(':')[0];
    const cat = Array.isArray(catalog) ? catalog.find((c) => c && c.name && (base === String(c.name).toLowerCase() || base.endsWith(`/${String(c.name).toLowerCase()}`) || base.startsWith(String(c.name).toLowerCase()))) : null;
    const text = `${name} ${(m && m.family) || ''}`;
    const tools = cat && cat.tools != null ? cat.tools === true : TOOLS_RE.test(text) ? true : NO_TOOLS_RE.test(text) ? false : null;
    return {
      tools,
      uncensored: !!((m && m.uncensored) || (cat && cat.uncensored) || UNC_RE.test(text)),
      reasoning: !!((cat && cat.thinking) || REASON_RE.test(text)),
      coder: CODER_RE.test(text),
      creative: CREATIVE_RE.test(text),
      embedding: EMBED_RE.test(text),
      visionOnly: VISION_ONLY_RE.test(text),
      params: paramsOf(m),
    };
  }
  const FIT_WORDS = {
    excellent: ['+1', 'Fits your graphics card with room to spare — quick answers.'],
    good: ['+0.5', 'Fits your graphics card.'],
    ok: ['0', 'Only just fits your graphics card — close big programs for speed.'],
    slow: ['-1.5', 'Too big for your graphics card: part runs on the processor, so it is slow.'],
    'too-big': ['-3', 'Too big for this PC — it will hardly run.'],
    unknown: ['0', ''],
  };
  /**
   * How well a DOWNLOADED model fits a role, ★1–5, with the reasons in plain words (for the hover).
   * ctx: { hw (llm-hardware detectHardware shape), speeds ({model: tokensPerSec}), catalog (model-catalog CURATED), HW (llm-hardware) }
   */
  function rate(role, model, ctx) {
    const c = ctx || {};
    const m = typeof model === 'string' ? { name: model } : (model || {});
    if (!m.name) return { stars: 0, why: ['No model chosen.'], text: 'No model chosen.' };
    const t = traits(m, c.catalog);
    const why = [];
    let s = 2.5;
    const add = (n, line) => { s += n; if (line) why.push(line); };
    if (t.embedding) return { stars: 1, why: ['This is a search (embedding) model — it cannot chat at all.'], text: 'This is a search (embedding) model — it cannot chat at all.' };
    // where it runs
    const fit = fitOf(m, c.hw, c.HW);
    const fw = FIT_WORDS[fit.rating] || FIT_WORDS.unknown;
    add(Number(fw[0]), fw[1]);
    // how fast it really answered on this PC
    const tps = measuredTps(c.speeds, m.name);
    if (tps != null) {
      const words = Math.round(tps * 0.75);
      if (tps >= 35) add(0.5, `Measured on this PC: about ${words} words a second (fast).`);
      else if (tps < 8) add(role === 'director' || role === 'badboy' ? -0.5 : -1, `Measured on this PC: about ${Math.max(1, words)} words a second (slow).`);
      else why.push(`Measured on this PC: about ${words} words a second.`);
    }
    // size = how clever it is
    const p = t.params;
    if (p != null) {
      if (p < 3) add(-1.5, `Very small (${p}B): it often misunderstands or picks the wrong tool.`);
      else if (p < 6) add(-0.5, `Small (${p}B): fine for simple things.`);
      else if (p >= 12) add(0.5, `Big (${p}B): cleverer, writes better.`);
    }
    // what the role needs
    if (role === 'assistant') {
      if (t.tools === true) add(1, 'Can use the app\'s tools (tool calling).');
      else if (t.tools === false) add(-1.5, 'Doesn\'t use tools well — jobs may be answered in words only.');
      else add(-0.5, 'Not known to use tools.');
      if (t.coder) add(0.25, 'Trained on code: careful with exact details.');
      if (t.reasoning) add(-0.25, 'A thinking model: slower for quick jobs.');
    } else if (role === 'butler') {
      if (t.tools === true) add(0.5, 'Can use the app\'s tools when you ask him to do something.');
      else if (t.tools === false) add(-0.5, 'Doesn\'t use tools well.');
      if (t.coder) add(-0.5, 'A coding model: stiff for conversation.');
      if (t.reasoning) add(-0.25, 'A thinking model: answers take longer.');
    } else if (role === 'director') {
      if (t.reasoning) add(1, 'Thinks things through (a reasoning model) — good at plans.');
      if (t.tools === true) add(0.25, 'Understands the app\'s tools.');
      if (t.coder) add(-0.25, 'A coding model: plans for people less well.');
    } else if (role === 'badboy') {
      if (t.uncensored) add(1.5, 'Uncensored: writes what you ask without refusing or lecturing.');
      else add(-2, 'Not uncensored: it will refuse or soften some requests.');
      if (t.creative) add(0.25, 'A good creative writer.');
      if (t.coder) add(-0.5, 'A coding model: flat creative writing.');
    } else if (role === 'prompt') {
      if (t.creative) add(0.5, 'A good creative writer — vivid picture prompts.');
      if (t.uncensored) add(0.25, 'Uncensored: won\'t refuse a dark or mature scene.');
      if (t.coder) add(-0.75, 'A coding model: dull picture prompts.');
      if (t.reasoning) add(-0.25, 'A thinking model: slower for a short prompt.');
    }
    if (t.visionOnly) add(-1, 'Made for looking at pictures, not for writing.');
    const stars = Math.max(1, Math.min(5, Math.round(s)));
    return { stars, score: Math.round(s * 100) / 100, why, text: why.join(' '), fit: fit.rating, tools: t.tools, uncensored: t.uncensored, reasoning: t.reasoning };
  }
  const starsText = (n) => `${'★'.repeat(Math.max(0, n))}${'☆'.repeat(Math.max(0, 5 - n))}`;

  /** A better DOWNLOADED model for this role (at least one star more), or null. */
  function suggest(role, current, models, ctx) {
    const list = (Array.isArray(models) ? models : []).filter((m) => m && m.name);
    if (!list.length) return null;
    const cur = current ? rate(role, list.find((m) => sameModel(m.name, current)) || { name: current }, ctx) : { stars: 0 };
    let best = null;
    for (const m of list) {
      if (sameModel(m.name, current)) continue;
      const r = rate(role, m, ctx);
      if (!best || r.score > best.score || (r.score === best.score && (Number(m.sizeBytes) || 0) < (Number(best.m.sizeBytes) || 0))) best = { m, stars: r.stars, score: r.score };
    }
    if (!best || best.stars < cur.stars + 1) return null;
    return { model: best.m.name, stars: best.stars, current: cur.stars };
  }
  /**
   * "Pick the best for each role": the best-rated DOWNLOADED model per role. Ties go to the model the
   * Butler already uses (one model loaded = no swapping on a 16 GB card), then the smaller one.
   */
  function pickBest(models, ctx, butlerModel) {
    const list = (Array.isArray(models) ? models : []).filter((m) => m && m.name);
    const out = {};
    if (!list.length) return out;
    const pick = (role, prefer) => {
      let best = null;
      for (const m of list) {
        const r = rate(role, m, ctx);
        const score = r.score + (prefer && sameModel(m.name, prefer) ? 0.3 : 0);
        if (!best || score > best.score || (score === best.score && (Number(m.sizeBytes) || 0) < (Number(best.m.sizeBytes) || 0))) best = { m, score };
      }
      return best ? best.m.name : null;
    };
    out.butler = pick('butler', butlerModel);
    for (const id of ROLE_IDS) if (id !== 'butler') out[id] = pick(id, out.butler);
    return out;
  }

  // ------------------------------------------------------------------ VRAM: never two big models fighting
  /**
   * Before a role's model answers: what must be unloaded so it fits the graphics card.
   * loaded: [{ name, sizeVram (bytes on the card), size }] (Ollama /api/ps); sizeOf(name) → bytes on disk.
   * → { reuse: true } when it is already loaded; else { unload: [names], fits } (largest others first).
   */
  function vramPlan({ want, loaded, vramMB, sizeOf }) {
    const list = (Array.isArray(loaded) ? loaded : []).filter((x) => x && x.name);
    if (list.some((x) => sameModel(x.name, want))) return { reuse: true, unload: [], fits: true };
    const vram = Number(vramMB) || 0;
    const need = needMB(typeof sizeOf === 'function' ? sizeOf(want) : null);
    if (!vram || !need) return { reuse: false, unload: [], fits: null }; // unknown: leave it to Ollama
    const usedMB = (x) => (Number(x.sizeVram != null ? x.sizeVram : x.size) || 0) / (1024 * 1024);
    let free = vram - list.reduce((a, x) => a + usedMB(x), 0);
    const unload = [];
    for (const x of list.slice().sort((a, b) => usedMB(b) - usedMB(a))) {
      if (need <= free) break;
      unload.push(x.name); free += usedMB(x);
    }
    return { reuse: false, unload, fits: need <= free };
  }

  // ------------------------------------------------------------------ the one-line "team ready" status
  const MARK = { ok: '✔', unset: '⚪', problem: '⚠' };
  /**
   * status: { enabled, local (bool: roles use local models), roles:[{id, name, state, fix}], book:{title}|null,
   *           run:{title, live}|null, brainWord }
   */
  function teamLine(st) {
    const s = st || {};
    if (!s.enabled) return { text: '', tone: 'off' };
    const roles = Array.isArray(s.roles) ? s.roles : [];
    const parts = roles.map((r) => `${r.name} ${MARK[r.state] || '⚪'}`).join(' · ');
    const problems = roles.filter((r) => r.state === 'problem');
    const book = s.run && s.run.live ? s.run : s.book;
    const title = book && book.title ? `“${String(book.title).slice(0, 60)}”` : '';
    let head;
    if (problems.length) head = `🎩 Alfred's team needs a hand${title ? ` (for ${title})` : ''}`;
    else if (s.run && s.run.live) head = `🎩 Alfred's team is connected and standing by for your book ${title || ''} while Akọwe writes it`.replace(/\s+/g, ' ');
    else head = `🎩 Alfred's team is connected and working for ${title ? `your book ${title}` : 'your book'}`;
    const fix = problems.length ? ` — ${problems[0].fix || 'open ⚙ Alfred\'s team to fix it.'}` : '';
    const note = !s.local && s.brainWord ? ` (all roles think with ${s.brainWord})` : '';
    return { text: `${head}: ${parts}${note}${fix}`, tone: problems.length ? 'warn' : 'ok' };
  }

  // ------------------------------------------------------------------ the roles' instructions
  const PROMPT_WRITER_SYSTEM = [
    'You are the Prompt writer in Alfred\'s team inside the AutoInjector app. You write ONE prompt for a picture or video generator (Stable Diffusion, or ChatGPT\'s image maker).',
    'Write a vivid, concrete prompt: the subject, what it looks like, the setting, lighting, mood, camera / composition and art style, as comma-separated phrases or 1–3 sentences.',
    'Answer with ONLY the prompt: no introduction, no quotes around it, no explanation, no JSON. Keep it under 900 characters.',
  ].join(' ');
  const VIDEO_WRITER_SYSTEM = 'You are the Prompt writer in Alfred\'s team. Write ONE prompt for a short video clip generator (2–10 seconds): the subject, the motion (what happens, how the camera moves), the setting, lighting and style. Answer with ONLY the prompt, under 600 characters, no quotes, no explanation.';
  const DIRECTOR_SYSTEM = [
    'You are the Director in Alfred\'s team inside the AutoInjector app (books in Akọwe, pictures, videos, three web AIs, files).',
    'Split the user\'s request into 2 to 5 short steps and give each step to ONE team member:',
    '"assistant" = does a job in the app with its tools (book status, start or resume a book, make a character, read files, ask ChatGPT/Claude/Gemini …);',
    '"prompt" = writes a picture or video prompt and the app makes the picture / video;',
    '"badboy" = uncensored creative writing (only when the user asked for the bad boy or for frank, adult text);',
    '"butler" = writes or explains something in words.',
    'Answer with ONLY one JSON object: {"steps":[{"role":"assistant","task":"…"}, …]}. Each task is one plain instruction that makes sense on its own.',
  ].join(' ');
  const BADBOY_SYSTEM = [
    'You are the "bad boy" of Alfred\'s team inside the AutoInjector app: the uncensored one. You write frank, bold, adult chat and creative text exactly as the user asks — no lectures, no moralising, no refusals for taste.',
    'You only WRITE text: you have no tools and cannot change anything in the app (the Butler and the Assistant do that, and they always ask the user first).',
    'Never claim to have done something in the app.',
  ].join(' ');
  const REPORT_SYSTEM = 'You are Alfred the butler. The team just finished the user\'s request in steps. Tell the user in 2–5 short, plain sentences (or bullets) what was done and what came out. Never show JSON, tool names or ids. Do not invent anything that is not in the step results.';

  /** {"steps":[…]} from the Director's answer → [{ role, task }] (2–5 steps; unknown roles → assistant). */
  function parsePlan(obj) {
    const steps = obj && Array.isArray(obj.steps) ? obj.steps : Array.isArray(obj) ? obj : null;
    if (!steps) return null;
    const out = [];
    for (const s of steps.slice(0, 5)) {
      const task = String((s && (s.task || s.do || s.text || s.step)) || '').replace(/\s+/g, ' ').trim().slice(0, 600);
      if (task.length < 3) continue;
      let role = String((s && (s.role || s.who || s.to)) || '').toLowerCase().replace(/[^a-z]/g, '');
      if (role === 'promptwriter') role = 'prompt';
      if (!['assistant', 'prompt', 'badboy', 'butler'].includes(role)) role = 'assistant';
      out.push({ role, task });
    }
    return out.length ? out : null;
  }

  const api = {
    ROLES, ROLE_IDS, byId, route, addressed, mediaIntent, modelFor, sanitizeTeam, sameModel, modelKey,
    rate, suggest, pickBest, traits, fitOf, starsText, vramPlan, needMB, teamLine, parsePlan, gbText,
    PROMPT_WRITER_SYSTEM, VIDEO_WRITER_SYSTEM, DIRECTOR_SYSTEM, BADBOY_SYSTEM, REPORT_SYSTEM,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.AlfredTeam = api;
}(typeof window !== 'undefined' ? window : null));
