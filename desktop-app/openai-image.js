'use strict';
/*
 * openai-image.js — the THIRD image engine: OpenAI's paid image service (the Images API), with your own API key.
 *
 * Paid per picture, so it is careful:
 *   • off until you turn it on and save a key (🎨 Images → Engine → OpenAI → ⚙ OpenAI pictures);
 *   • a monthly limit on pictures (default 30) — at the limit it stops and says so, never a surprise bill;
 *   • "Auto" never picks it by itself unless you ticked "Use OpenAI for book pictures";
 *   • ✔ Check key reads the model list (free) — it never makes a picture to test.
 * The key is kept sealed on this PC (main.js, secret-store.js) and never logged, shown or returned.
 *
 * createOpenAiImage(deps): deps.fetch, deps.key() → the key or '', deps.settings() → { enabled, model, quality,
 * monthlyLimit, forBooks }, deps.usage() / deps.addUse(n) → this month's count, deps.imagesDir(), deps.recordImage(e),
 * deps.log(type, data), deps.fileUrl(path), deps.now().
 * generate({ text, purpose, view, shape, record, from, returnImage }) → the same answer shape as the other engines.
 */
const sdImages = require('./sd-images');

const API = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-image-1';
const QUALITIES = ['low', 'medium', 'high', 'auto'];
const DEFAULTS = { enabled: false, model: DEFAULT_MODEL, quality: 'medium', monthlyLimit: 30, forBooks: false };
const TIMEOUT_MS = 180000;

/** The settings, cleaned. */
function cleanSettings(raw) {
  const s = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
  const model = String(s.model || '').trim();
  const lim = Math.round(Number(s.monthlyLimit));
  return {
    enabled: s.enabled === true,
    model: /^[\w.:-]{1,64}$/.test(model) ? model : DEFAULT_MODEL,
    quality: QUALITIES.includes(s.quality) ? s.quality : 'medium',
    monthlyLimit: Number.isFinite(lim) ? Math.max(0, Math.min(1000, lim)) : DEFAULTS.monthlyLimit,
    forBooks: s.forBooks === true,
  };
}

/** The picture size OpenAI makes for a purpose / shape: square, tall or wide (the sizes its image models accept). */
function sizeFor(purpose, shape) {
  const w = Number(shape && shape.width);
  const h = Number(shape && shape.height);
  if (w > 0 && h > 0) { const r = w / h; return r < 0.9 ? '1024x1536' : r > 1.1 ? '1536x1024' : '1024x1024'; }
  if (purpose === 'portrait' || purpose === 'cover' || purpose === 'view') return '1024x1536';
  if (purpose === 'scene' || purpose === 'illustration' || purpose === 'map' || purpose === 'sheet') return '1536x1024';
  return '1024x1024';
}

/** "2026-11" — the month the limit counts. */
function monthOf(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }

/** OpenAI's error → plain words (the key is never in them). */
function explain(status, body) {
  const e = (body && body.error) || {};
  const code = String(e.code || e.type || '');
  const msg = String(e.message || '').slice(0, 300);
  if (status === 401) return { error: 'OPENAI_BAD_KEY', message: 'OpenAI did not accept the API key.', hint: 'Check the key in 🎨 Images → ⚙ OpenAI pictures (it starts with "sk-"), or make a new one at platform.openai.com → API keys.' };
  if (code === 'insufficient_quota' || /quota|billing/i.test(msg)) return { error: 'OPENAI_NO_CREDIT', message: 'Your OpenAI account has no credit left for pictures.', hint: 'Add credit at platform.openai.com → Billing, or use Stable Diffusion / ChatGPT.' };
  if (status === 429) return { error: 'OPENAI_BUSY', message: 'OpenAI says too many requests right now.', hint: 'Wait a minute and try again.' };
  if (code === 'moderation_blocked' || /safety|content policy|moderation/i.test(msg)) return { error: 'IMAGE_REFUSED', message: 'OpenAI refused to draw this (its content rules).', hint: 'Change the description (less violence / no real people) and try again.' };
  if (status === 404 || code === 'model_not_found') return { error: 'OPENAI_NO_MODEL', message: 'OpenAI does not know that picture model (or your account can\'t use it yet).', hint: `Check the model name in ⚙ OpenAI pictures (e.g. ${DEFAULT_MODEL}). Some models need your organisation verified at platform.openai.com.` };
  if (status === 403) return { error: 'OPENAI_NOT_ALLOWED', message: 'Your OpenAI account is not allowed to use that picture model yet.', hint: 'Verify your organisation at platform.openai.com → Settings, or pick another model.' };
  if (status >= 500) return { error: 'OPENAI_DOWN', message: 'OpenAI had a problem on its side.', hint: 'Try again in a few minutes.' };
  return { error: 'OPENAI_ERROR', message: `OpenAI said no${msg ? `: ${msg}` : ''}.`, hint: 'Try again, or use another engine.' };
}

function createOpenAiImage(deps) {
  const d = deps || {};
  const now = d.now || (() => Date.now());
  const log = d.log || (() => {});
  const fileUrl = d.fileUrl || (() => '');
  const fetchFn = d.fetch || ((...a) => fetch(...a));
  let busy = false;

  const settings = () => cleanSettings(d.settings ? d.settings() : {});
  const hasKey = () => { try { return !!String(d.key() || '').trim(); } catch (_) { return false; } };
  function used() { try { const u = d.usage ? d.usage() : null; return u && u.month === monthOf(now()) ? Number(u.count) || 0 : 0; } catch (_) { return 0; } }

  function readiness() {
    const s = settings();
    if (!s.enabled) return { ready: false, code: 'OFF', why: 'OpenAI pictures are off (🎨 Images → ⚙ OpenAI pictures)' };
    if (!hasKey()) return { ready: false, code: 'NO_KEY', why: 'no OpenAI API key is saved' };
    if (used() >= s.monthlyLimit) return { ready: false, code: 'LIMIT', why: `this month's limit of ${s.monthlyLimit} pictures is used up` };
    return { ready: true, code: 'OK' };
  }

  function status() {
    const s = settings();
    const r = readiness();
    return { engine: 'openai', ready: r.ready, why: r.ready ? undefined : r.why, code: r.code, busy, enabled: s.enabled, hasKey: hasKey(), model: s.model, quality: s.quality,
      monthlyLimit: s.monthlyLimit, usedThisMonth: used(), forBooks: s.forBooks };
  }

  async function call(path, init, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || TIMEOUT_MS);
    try { return await fetchFn(`${API}${path}`, Object.assign({}, init, { signal: ctl.signal })); } finally { clearTimeout(t); }
  }

  /** ✔ Check key: reads the model list (free). */
  async function checkKey() {
    if (!hasKey()) return { ok: false, error: 'NO_KEY', message: 'Paste your OpenAI API key first.' };
    let r;
    try { r = await call('/models', { headers: { Authorization: `Bearer ${d.key()}` } }, 20000); } catch (e) { return { ok: false, error: 'OPENAI_UNREACHABLE', message: 'Could not reach OpenAI (internet / firewall?).' }; }
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    if (!r.ok) return Object.assign({ ok: false }, explain(r.status, body));
    const ids = Array.isArray(body && body.data) ? body.data.map((m) => String(m.id)) : [];
    const images = ids.filter((id) => /image|dall-e/i.test(id)).sort();
    const s = settings();
    log('openai-image', { step: 'check-key', ok: true, imageModels: images.length });
    return { ok: true, message: images.includes(s.model) ? `✔ The key works, and ${s.model} is available.` : `✔ The key works${images.length ? ` — picture models you can use: ${images.slice(0, 8).join(', ')}` : ''}.`, models: images, modelOk: images.includes(s.model) };
  }

  async function generate(job) {
    const j = job || {};
    const s = settings();
    const rd = readiness();
    if (!rd.ready) return { ok: false, engine: 'openai', error: rd.code === 'LIMIT' ? 'OPENAI_MONTHLY_LIMIT' : rd.code === 'NO_KEY' ? 'NO_KEY' : 'OPENAI_OFF', message: `OpenAI can't make pictures: ${rd.why}.`, hint: rd.code === 'LIMIT' ? 'Raise the monthly limit in 🎨 Images → ⚙ OpenAI pictures, or use Stable Diffusion / ChatGPT.' : 'Turn it on and save your key in 🎨 Images → ⚙ OpenAI pictures.' };
    if (busy) return { ok: false, engine: 'openai', error: 'BUSY', message: 'OpenAI is already making a picture — one at a time.' };
    const text = String(j.text || '').trim().slice(0, 30000);
    if (!text) return { ok: false, engine: 'openai', error: 'NEED_PROMPT', message: 'Nothing to draw.' };
    const size = sizeFor(j.purpose, j.shape);
    busy = true;
    const t0 = now();
    log('openai-image', { step: 'start', model: s.model, size, quality: s.quality, purpose: j.purpose || 'free', from: j.from });
    try {
      let r;
      try {
        r = await call('/images/generations', { method: 'POST', headers: { Authorization: `Bearer ${d.key()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: s.model, prompt: text, size, quality: s.quality, n: 1 }) });
      } catch (e) {
        const timeout = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
        return { ok: false, engine: 'openai', error: timeout ? 'IMAGE_TIMEOUT' : 'OPENAI_UNREACHABLE', message: timeout ? 'OpenAI took too long (3 minutes).' : 'Could not reach OpenAI (internet / firewall?).', hint: 'Try again.' };
      }
      let body = null;
      try { body = await r.json(); } catch (_) { body = null; }
      if (!r.ok) { const ex = explain(r.status, body); log('openai-image', { step: 'failed', status: r.status, error: ex.error }); return Object.assign({ ok: false, engine: 'openai' }, ex); }
      const item = body && Array.isArray(body.data) ? body.data[0] : null;
      let b64 = item && item.b64_json;
      if (!b64 && item && item.url) {
        try { const ir = await fetchFn(item.url); if (ir.ok) b64 = Buffer.from(await ir.arrayBuffer()).toString('base64'); } catch (_) { b64 = null; }
      }
      if (!b64) return { ok: false, engine: 'openai', error: 'IMAGE_FETCH_FAILED', message: 'OpenAI answered without a picture.' };
      if (d.addUse) { try { d.addUse(1, monthOf(now())); } catch (_) { /* the count is a guard, not a reason to lose the picture */ } }
      const [w, h] = size.split('x').map(Number);
      const record = Object.assign({}, j.record || {}, {
        engine: 'openai', backend: 'openai', label: `OpenAI ${s.model}`, model: s.model, quality: s.quality, purpose: j.purpose || 'free', view: j.view || undefined,
        prompt: (j.record && j.record.prompt) || text, openaiPrompt: text, revisedPrompt: item.revised_prompt ? String(item.revised_prompt).slice(0, 4000) : undefined,
        width: w, height: h, from: j.from || 'images-tab', seconds: Math.round((now() - t0) / 1000),
      });
      let saved;
      try { saved = sdImages.saveGeneration(d.imagesDir(), [b64], record, { prefix: j.prefix || (j.purpose && j.purpose !== 'free' ? `${j.purpose}${j.view ? `-${j.view}` : ''}` : 'openai') }); }
      catch (e) { return { ok: false, engine: 'openai', error: 'SAVE_FAILED', message: `The picture was made but couldn't be saved: ${(e && e.message) || e}` }; }
      for (const sv of saved) { try { if (d.recordImage) d.recordImage({ path: sv.path, prompt: sv.record.prompt, seed: null, model: `openai:${s.model}`, from: record.from, sha256: sv.sha256 }); } catch (_) { /* the picture is saved */ } }
      log('openai-image', { step: 'done', model: s.model, size, seconds: record.seconds, usedThisMonth: used() });
      const out = { ok: true, engine: 'openai', backend: 'openai', purpose: record.purpose, view: j.view || undefined, seed: null, warnings: [], settings: saved[0].record,
        images: saved.map((sv) => ({ path: sv.path, url: fileUrl(sv.path), json: sv.json, sha256: sv.sha256, width: w, height: h })) };
      if (j.returnImage) out.images.forEach((im) => { im.imageBase64 = b64; });
      const left = s.monthlyLimit - used();
      if (left <= 3) out.warnings.push({ level: 'soft', kind: 'engine', message: left > 0 ? `${left} OpenAI picture${left === 1 ? '' : 's'} left this month (your limit).` : 'That was the last OpenAI picture this month (your limit).' });
      return out;
    } finally { busy = false; }
  }

  return { generate, status, readiness, checkKey, settings };
}

module.exports = { createOpenAiImage, cleanSettings, sizeFor, explain, monthOf, DEFAULTS, DEFAULT_MODEL, QUALITIES };
