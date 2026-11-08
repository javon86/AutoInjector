'use strict';
/*
 * image-judge-service.js — 🧑‍⚖️ which AI judges a picture, and how the answer comes back.
 *
 * Three judges, best first (the order and on/off are settings — image-judge.js orderJudges):
 *   claude-code  Claude Code on this PC (image-judge-cc.js): sees the picture with its Read tool. Uses the Claude plan.
 *   pane         a web AI pane (Claude or ChatGPT) in AutoInjector: a FRESH chat, the picture uploaded as an attachment,
 *                the same JSON asked for. Never while Akọwe is using that pane (a book run): it says so instead.
 *   local        a local vision model through Ollama (qwen2.5vl, llava, gemma3, minicpm-v, llama3.2-vision …) — offline,
 *                free, but weaker: its verdicts are labelled "local (weaker)".
 * Every judge gets the same instruction (image-judge.js buildPrompt) and must answer the same JSON. A malformed answer
 * is asked for once more; a second bad answer moves on to the next judge; when none can answer: one plain error.
 * Each judge call costs one AI answer (Claude plan / ChatGPT usage) except the local one.
 *
 *   createPaneJudge({ site(), problem(site), ask(site, text, { attach, freshChat, signal }) })
 *   createOllamaJudge({ fetch, bases(), model() })
 *   createJudgeService({ judges, settings(), readRecord, updateRecord, log, now })
 *     → { status(), judge(imagePath, { ctx, signal, only }) }
 *   Logs hold judge ids, error codes, scores and timings — never the prompt or the answer text.
 */
const fs = require('fs');
const J = require('./image-judge');

const VISION_RX = /(qwen[\d.]*-?vl|llava|bakllava|gemma3|minicpm-?v|llama3\.2-vision|moondream|granite3\.2-vision|mistral-small3\.1|qwen3-vl|internvl|pixtral)/i;

function createPaneJudge(d) {
  const site = () => (typeof d.site === 'function' ? d.site() : d.site) || 'claude';
  const label = () => `${site() === 'chatgpt' ? 'ChatGPT' : 'Claude'} (web pane)`;
  function available() {
    const s = site();
    const p = d.problem ? d.problem(s) : null;
    if (p) return { ok: false, state: p.code === 'AKOWE_USING' ? 'busy' : 'not_ready', why: p.say || p.code };
    return { ok: true, state: 'ready' };
  }
  async function ask({ imagePath, prompt, signal }) {
    const av = available();
    if (!av.ok) return { ok: false, error: av.state === 'busy' ? 'PANE_BUSY' : 'PANE_NOT_READY', message: av.state === 'busy' ? `The ${label()} is busy with Akọwe's book right now, so it wasn't interrupted.` : `The ${label()} can't judge right now: ${av.why}.`, unavailable: true };
    const r = await d.ask(site(), `${prompt}\n\nThe picture is attached to this message.`, { attach: imagePath, freshChat: true, signal });
    if (!r || !r.ok) {
      const e = (r && r.error) || 'FAILED';
      const busy = e === 'AKOWE_USING' || e === 'BUSY';
      return { ok: false, error: busy ? 'PANE_BUSY' : e === 'ATTACH_FAILED' || e === 'NO_FILE_INPUT_FOUND' ? 'PANE_ATTACH_FAILED' : `PANE_${String(e).toUpperCase()}`.slice(0, 40), unavailable: busy || e === 'NOT_READY' || e === 'TURNED_OFF', message: busy ? `The ${label()} is busy (a book run or another question), so it wasn't interrupted — try again when it's free.` : e === 'TIMEOUT' ? `The ${label()} didn't answer in time.` : /ATTACH|FILE_INPUT/.test(e) ? `The picture couldn't be uploaded to the ${label()}.` : `The ${label()} couldn't judge it (${String(e).slice(0, 40)}).` };
    }
    return { ok: true, text: r.text, model: site() };
  }
  return { id: 'pane', get label() { return label(); }, available, ask };
}

function createOllamaJudge(d) {
  const fetchFn = d.fetch || (typeof fetch === 'function' ? fetch : null);
  let found = null; let foundAt = 0;
  async function get(url, ms) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 2500);
    try { const r = await fetchFn(url, { signal: ctl.signal }); return r.ok ? await r.json() : null; } catch (_) { return null; } finally { clearTimeout(t); }
  }
  async function locate() {
    if (found && Date.now() - foundAt < 60000) return found;
    const want = (typeof d.model === 'function' ? d.model() : d.model) || '';
    for (const base of [...new Set((typeof d.bases === 'function' ? d.bases() : d.bases) || [])].filter(Boolean)) {
      const tags = await get(`${base.replace(/\/+$/, '')}/api/tags`);
      if (!tags || !Array.isArray(tags.models)) continue;
      const names = tags.models.map((m) => m.name || m.model).filter(Boolean);
      const model = (want && names.find((n) => n === want || n.startsWith(`${want}:`))) || names.find((n) => VISION_RX.test(n));
      if (model) { found = { base: base.replace(/\/+$/, ''), model }; foundAt = Date.now(); return found; }
      found = { base: base.replace(/\/+$/, ''), model: null, names: names.length }; foundAt = Date.now();
    }
    return found;
  }
  async function available() {
    if (!fetchFn) return { ok: false, state: 'missing', why: 'this build cannot reach Ollama' };
    const f = await locate();
    if (!f) return { ok: false, state: 'missing', why: 'Ollama is not running on this PC (Alfred\'s ⚙ AI setup can install it)' };
    if (!f.model) return { ok: false, state: 'no_model', why: 'Ollama has no picture-reading model — add one (e.g. qwen2.5vl:7b or llava) in Alfred\'s ⚙ AI setup' };
    return { ok: true, state: 'ready', model: f.model };
  }
  async function ask({ imagePath, prompt, signal }) {
    const av = await available();
    if (!av.ok) return { ok: false, error: av.state === 'no_model' ? 'LOCAL_NO_VISION_MODEL' : 'LOCAL_MISSING', message: `The local judge isn't available: ${av.why}.`, unavailable: true };
    let b64;
    try { b64 = fs.readFileSync(imagePath).toString('base64'); } catch (_) { return { ok: false, error: 'BAD_IMAGE', message: 'The picture file could not be read.' }; }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Number(d.timeoutMs) || 300000);
    const onAbort = () => ctl.abort();
    try { if (signal) signal.addEventListener('abort', onAbort, { once: true }); } catch (_) {}
    try {
      const r = await fetchFn(`${found.base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ model: av.model, stream: false, format: 'json', options: { temperature: 0.2 }, messages: [{ role: 'user', content: prompt, images: [b64] }] }) });
      const j = r.ok ? await r.json() : null;
      if (!j) return { ok: false, error: `LOCAL_HTTP_${r.status}`, message: `The local model answered with an error (HTTP ${r.status}).` };
      return { ok: true, text: (j.message && j.message.content) || j.response || '', model: av.model };
    } catch (e) {
      if (signal && signal.aborted) return { ok: false, error: 'CANCELLED', message: 'Stopped.' };
      return { ok: false, error: 'LOCAL_FAILED', message: 'The local model did not answer in time.' };
    } finally { clearTimeout(t); try { if (signal) signal.removeEventListener('abort', onAbort); } catch (_) {} }
  }
  return { id: 'local', label: 'Local vision model (Ollama, offline — weaker)', available, ask, forget: () => { found = null; } };
}

function createJudgeService(deps) {
  const judges = deps.judges || {};
  const log = deps.log || (() => {});
  const now = deps.now || (() => Date.now());
  const settings = () => J.cleanSettings(typeof deps.settings === 'function' ? deps.settings() : deps.settings);

  async function status() {
    const s = settings();
    const out = {};
    for (const id of J.JUDGES) {
      const j = judges[id];
      if (!j) { out[id] = { ok: false, state: 'missing', why: 'not in this build', on: s.enabled[id] !== false }; continue; }
      let a; try { a = await j.available(); } catch (e) { a = { ok: false, state: 'failing', why: String((e && e.message) || e).slice(0, 120) }; }
      out[id] = Object.assign({ label: j.label, on: s.enabled[id] !== false }, a);
      delete out[id].bin;
    }
    const order = J.orderJudges(s, Object.fromEntries(Object.entries(out).map(([k, v]) => [k, !!v.ok])));
    return { ok: true, judges: out, order: s.order, settings: s, next: order[0] || null, nextLabel: order[0] ? out[order[0]].label : null };
  }

  /**
   * Judge one picture. opts: { ctx (image-judge buildPrompt ctx), signal, only (one judge id), record (instead of the sidecar), save (default true) }
   * → { ok, judge, say, tried } | { ok:false, error, message, tried }
   */
  async function judge(imagePath, opts) {
    const o = opts || {};
    const t0 = now();
    if (!imagePath || typeof imagePath !== 'string') return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', message: 'Which picture? Give the picture file (path).' };
    let head;
    try { const fd = fs.openSync(imagePath, 'r'); head = Buffer.alloc(12); fs.readSync(fd, head, 0, 12, 0); fs.closeSync(fd); } catch (_) { return { ok: false, error: 'BAD_IMAGE', code: 'BAD_IMAGE', message: 'That picture file could not be opened (moved or deleted?).' }; }
    const isImg = (head[0] === 0x89 && head[1] === 0x50) || (head[0] === 0xff && head[1] === 0xd8) || (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP');
    if (!isImg) return { ok: false, error: 'BAD_IMAGE', code: 'BAD_IMAGE', message: 'That file is not a PNG, JPEG or WebP picture.' };
    const rec = o.record || (deps.readRecord ? deps.readRecord(imagePath) : null) || {};
    const s = settings();
    const ctx = Object.assign({}, o.ctx || {});
    const hasCharacter = !!(ctx.character && (ctx.character.name || ctx.character.looks));
    const list = o.only ? [o.only] : J.orderJudges(s, null);
    const tried = [];
    for (const id of list) {
      const j = judges[id];
      if (!j) { tried.push({ by: id, error: 'MISSING' }); continue; }
      if (o.signal && o.signal.aborted) return { ok: false, error: 'CANCELLED', code: 'CANCELLED', message: 'Stopped.', tried };
      const prompt = J.buildPrompt(rec, Object.assign({}, ctx, { where: id === 'claude-code' ? 'the picture file' : 'the attached picture' }));
      let attempt = 0; let answer = null; let lastProblems = null;
      while (attempt < 2) {
        attempt++;
        const q = attempt === 1 ? prompt : `${prompt}\n\nYour last answer could not be used (${(lastProblems || []).slice(0, 3).join('; ')}). Answer again with ONLY the JSON object, exactly in the shape above.`;
        let r;
        try { r = await j.ask({ imagePath, prompt: q, signal: o.signal }); } catch (e) { r = { ok: false, error: 'FAILED', message: String((e && e.message) || e).slice(0, 160) }; }
        if (!r || !r.ok) { tried.push({ by: id, error: (r && r.error) || 'FAILED', message: r && r.message }); if (r && r.error === 'CANCELLED') return { ok: false, error: 'CANCELLED', code: 'CANCELLED', message: 'Stopped.', tried }; break; }
        const obj = J.extractJson(r.text);
        const v = obj ? J.validate(obj, { character: hasCharacter }) : { ok: false, problems: ['no JSON object in the answer'] };
        if (v.ok) { answer = Object.assign(v.judge, { by: id, byLabel: j.label, model: r.model, attempts: attempt, seconds: Math.round((now() - t0) / 100) / 10, at: new Date(now()).toISOString() }); break; }
        lastProblems = v.problems;
        if (attempt === 2) tried.push({ by: id, error: 'BAD_JSON', message: `${j.label} answered, but not with the scores AutoInjector asked for (twice).` });
      }
      if (answer) {
        if (id === 'local') answer.weaker = true;
        log('image-judge', { judge: id, ok: true, verdict: answer.verdict, overall: answer.overall, min: answer.min, fixes: answer.fixes.length, selfConflict: answer.selfConflict || undefined, attempts: answer.attempts, ms: now() - t0, tried: tried.map((t) => `${t.by}:${t.error}`) });
        if (o.save !== false && deps.updateRecord) { try { deps.updateRecord(imagePath, (cur) => ({ judge: answer, judges: [...(Array.isArray(cur.judges) ? cur.judges : []), ...(cur.judge ? [cur.judge] : [])].slice(-10) })); } catch (_) {} }
        return { ok: true, judge: answer, say: J.sayVerdict(answer), tried };
      }
    }
    log('image-judge', { ok: false, tried: tried.map((t) => `${t.by}:${t.error}`), ms: now() - t0 });
    const none = !tried.length;
    const msg = none ? 'Every AI judge is switched off — switch one on in 🧑‍⚖️ Judge settings.'
      : `No AI judge could look at the picture. ${tried.map((t) => t.message || `${J.JUDGE_WORDS[t.by] || t.by}: ${t.error}`).join(' ')}`;
    return { ok: false, error: none ? 'NO_JUDGE' : 'NO_JUDGE_ANSWERED', code: none ? 'NO_JUDGE' : 'NO_JUDGE_ANSWERED', message: msg.slice(0, 900), hint: 'Install Claude Code (and sign in), keep the Claude or ChatGPT pane logged in, or add a vision model to Ollama.', tried };
  }
  return { status, judge, settings };
}

module.exports = { createPaneJudge, createOllamaJudge, createJudgeService, VISION_RX };
