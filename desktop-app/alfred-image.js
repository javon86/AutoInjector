'use strict';
/*
 * alfred-image.js — Alfred's ONE way to make images.
 *
 * It goes through the images module API (sd-api.js: `require('./sd-api').get().images.generate`),
 * the same Stable Diffusion path as the 🎨 Images tab — Forge / A1111 / ComfyUI, LoRAs, character
 * locks, pictures saved in the images/ output folder with their settings. Only when that module is
 * not registered (older builds, some tests) does it fall back to the plain image-provider path
 * (the manager's GENERATE_IMAGE path). The tool contract stays the same either way:
 *   {prompt, width, height, style, character, loras, negativePrompt, engine, purpose, view, appearance, newChat}
 *     -> {ok, path, paths, count, warnings, engine, view} | {ok:false, error, message}
 * engine "chatgpt" / "auto" and purpose "view" / "sheet" need the module (sd-api); the plain
 * image-provider fallback is Stable Diffusion only.
 */
const crypto = require('crypto');

function createImageAdapter({ imageProvider, outputManager, dbService, sdApi, from = 'alfred' }) {
  const api = () => { try { return sdApi ? sdApi.get() : require('./sd-api').get(); } catch (_) { return null; } };
  let busy = Promise.resolve();

  async function viaModule(m, o) {
    let prompt = String(o.prompt || '').trim();
    let characterLock;
    if (o.character) {
      const lock = await m.library.characterLock(String(o.character));
      if (lock && lock.id && lock.ok !== false) characterLock = lock.character || lock.id;
      else prompt += `, featuring ${String(o.character).trim()}`;
    }
    if (o.style) prompt += `, in the style of ${String(o.style).trim()}`;
    const req = { prompt, from };
    if (characterLock) req.characterLock = characterLock;
    if (o.width) req.width = o.width;
    if (o.height) req.height = o.height;
    if (o.negativePrompt) req.negativePrompt = o.negativePrompt;
    if (Array.isArray(o.loras) && o.loras.length) req.loras = o.loras;
    // the second engine (ChatGPT) and reference views / sheets — sd-api routes them
    for (const k of ['engine', 'purpose', 'view', 'appearance', 'newChat']) if (o[k] !== undefined && o[k] !== null && o[k] !== '') req[k] = o[k];
    if (!req.prompt) delete req.prompt;
    const r = await m.images.generate(req);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'IMAGE_FAILED', message: (r && r.message) || 'The image could not be made.' };
    const paths = (r.images || []).map((x) => x.path).filter(Boolean);
    if (!paths.length) return { ok: false, error: 'NO_IMAGE', message: 'The image generator answered without a picture.' };
    return { ok: true, path: paths[0], paths, count: paths.length, warnings: r.warnings || [], characterLock: characterLock || null, engine: r.engine || 'sd', view: r.view || undefined };
  }

  async function viaProvider(o) {
    if ((o.engine && o.engine !== 'sd') || o.purpose === 'view' || o.purpose === 'sheet') return { ok: false, error: 'NOT_WIRED', message: 'ChatGPT pictures and reference views need the 🎨 Images module, which this build does not have.' };
    let full = String(o.prompt || '').trim();
    if (o.character) full += `, featuring ${String(o.character).trim()}`;
    if (o.style) full += `, in the style of ${String(o.style).trim()}`;
    const before = imageProvider.getSettings();
    const sized = !!(o.width || o.height);
    if (sized) imageProvider.setSettings({ width: o.width || before.width, height: o.height || before.height });
    let r;
    try { r = await imageProvider.generate(full, { negativePrompt: o.negativePrompt || '' }); }
    catch (e) { r = { ok: false, error: 'IMAGE_ERROR' }; }
    finally { if (sized) imageProvider.setSettings({ width: before.width, height: before.height }); }
    if (!r || !r.ok) {
      const code = (r && r.error) || 'FAILED';
      const message = r && r.message ? r.message
        : code === 'IMAGE_DISABLED' ? 'Image generation is turned off. Connect Stable Diffusion in the 🎨 Images tab.'
        : code === 'NO_ENDPOINT' ? 'No image generator is connected yet: open the 🎨 Images tab and press 🔍 Find or ▶ Start.'
        : `The image generator reported a problem (${code}).`;
      return { ok: false, error: code, message };
    }
    const batch = Array.isArray(r.images) && r.images.length ? r.images : [r.imageBase64];
    const paths = [];
    try {
      for (let i = 0; i < batch.length; i++) {
        const buf = Buffer.from(batch[i], 'base64');
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        const p = outputManager.saveBuffer(outputManager.imagesDir(), `img-${Date.now()}${batch.length > 1 ? `-${i + 1}` : ''}.png`, buf);
        paths.push(p);
        try { dbService.recordImage({ path: p, prompt: full, model: imageProvider.status().model, from, sha256: sha }); } catch (_) { /* optional */ }
      }
    } catch (e) { return { ok: false, error: 'SAVE_FAILED', message: 'The image was made but could not be saved in the images folder.' }; }
    return { ok: true, path: paths[0], paths, count: paths.length };
  }

  function generate(opts) {
    const o = opts || {};
    const p = busy.then(() => { const m = api(); return m ? viaModule(m, o) : viaProvider(o); });
    busy = p.catch(() => {});
    return p;
  }
  return { generate, module: api };
}

module.exports = { createImageAdapter };
