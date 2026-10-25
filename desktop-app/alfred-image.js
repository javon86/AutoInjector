'use strict';
/*
 * alfred-image.js — Alfred's ONE way to make images.
 *
 * RE-POINT HERE: this adapter is the only place Alfred touches image generation. Today it goes
 * through the existing image-provider.js (the same path as the manager's GENERATE_IMAGE action and
 * the wizard's image:generate): Stable Diffusion txt2img, the PNG saved in the images output folder
 * and recorded as a project image. When the new image module (🎨 Images tab / SD server manager /
 * LoRA library) lands, swap the body of generate() for a call into it — the tool contract
 * ({prompt, width, height, style, character} -> {ok, path, paths, count, error, message}) stays.
 */
const crypto = require('crypto');

function createImageAdapter({ imageProvider, outputManager, dbService, from = 'alfred' }) {
  let busy = Promise.resolve();
  async function generateNow({ prompt, width, height, style, character }) {
    let full = String(prompt || '').trim();
    if (character) full += `, featuring ${String(character).trim()}`;
    if (style) full += `, in the style of ${String(style).trim()}`;
    const before = imageProvider.getSettings();
    const sized = !!(width || height);
    if (sized) imageProvider.setSettings({ width: width || before.width, height: height || before.height });
    let r;
    try { r = await imageProvider.generate(full, {}); }
    catch (e) { r = { ok: false, error: 'IMAGE_ERROR' }; }
    finally { if (sized) imageProvider.setSettings({ width: before.width, height: before.height }); }
    if (!r || !r.ok) {
      const code = (r && r.error) || 'FAILED';
      const message = r && r.message ? r.message
        : code === 'IMAGE_DISABLED' ? 'Image generation is turned off. Turn it on in the Setup Wizard → Images (it needs a local Stable Diffusion server).'
        : code === 'NO_ENDPOINT' ? 'No image generator is set up yet: start a Stable Diffusion server (Automatic1111 / Forge) with its API on and enter its address in the Setup Wizard → Images.'
        : /ECONNREFUSED|ENOTFOUND|TIMEOUT/.test(code) ? `The image generator didn't answer (${code}). Is the Stable Diffusion server running?`
        : `The image generator reported a problem (${code}${r && r.detail ? `: ${String(r.detail).slice(0, 160)}` : ''}).`;
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
        try { dbService.recordImage({ path: p, prompt: full, model: imageProvider.status().model, from, sha256: sha }); } catch (_) { /* optional db */ }
      }
    } catch (e) { return { ok: false, error: 'SAVE_FAILED', message: 'The image was made but could not be saved in the images folder.' }; }
    return { ok: true, path: paths[0], paths, count: paths.length };
  }
  // one at a time (the size is a shared setting of image-provider)
  function generate(opts) { const p = busy.then(() => generateNow(opts || {})); busy = p.catch(() => {}); return p; }
  return { generate };
}

module.exports = { createImageAdapter };
