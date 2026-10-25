'use strict';
/*
 * sd-api.js — ONE clean module API for images / Stable Diffusion, for other parts
 * of AutoInjector (Alfred, the app-wide assistant; the butler; future Akọwe
 * hooks). main.js builds it once and registers it; callers in the main process do:
 *
 *   const imagesApi = require('./sd-api').get();      // null until main registered it
 *   await imagesApi.images.status();                   // connected? which app? busy?
 *   await imagesApi.images.generate({ prompt, negativePrompt, loras:[{name,weight}],
 *            characterLock, purpose:'portrait'|'cover'|'scene'|'free', width, height,
 *            steps, cfgScale, seed, checkpoint, sampler, count });
 *        → { ok, images:[{ path, seed, sha256 }], seed, warnings, settings } | { ok:false, error, message }
 *   imagesApi.images.progress() / cancel() / gallery(limit) / test()
 *   imagesApi.sd.status() / detect() / connect(url) / start(targetId?) / stop() / targets()
 *   imagesApi.sd.install.check() / install(opts) / downloadModel('sd15'|'sdxl') / cancel()
 *   imagesApi.library.find(query, { kind, base }) → items  ·  library.get(id)
 *   imagesApi.library.characterLock(name) → lock | null  ·  library.locks() · library.scan()
 *
 * Every call resolves (never throws) and failures carry a plain-English `message`.
 * Saved pictures land in the output images/ folder with their settings embedded.
 */
let registered = null;

function wrap(fn) {
  return async (...a) => {
    try { return await fn(...a); }
    catch (e) { return { ok: false, error: 'INTERNAL', message: `Something went wrong: ${(e && e.message) || e}` }; }
  };
}

function createImagesApi(d) {
  const studio = d.studio; const library = d.library;
  const runner = d.runner || null; const installer = d.installer || null;
  return {
    images: {
      status: wrap(async () => Object.assign(studio.status(), { managed: runner ? runner().status() : null })),
      generate: wrap((opts) => studio.generate(Object.assign({}, opts || {}, { batchSize: (opts && (opts.count || opts.batchSize)) || 1 }), `api:${String((opts && opts.from) || 'alfred').slice(0, 40)}`)),
      progress: wrap(() => studio.progress()),
      cancel: wrap(() => studio.cancel()),
      gallery: wrap(async (limit) => studio.gallery(limit)),
      test: wrap(() => studio.test()),
    },
    sd: {
      status: wrap(async () => ({ ok: true, image: studio.status(), managed: runner ? runner().status() : null, install: installer ? installer().status() : null })),
      detect: wrap(() => studio.detect()),
      connect: wrap((url) => studio.connect(url || '')),
      targets: wrap(async () => (d.targets ? d.targets() : { ok: true, targets: [] })),
      start: wrap((targetId) => (d.start ? d.start(targetId) : { ok: false, error: 'NOT_WIRED' })),
      stop: wrap(() => (d.stop ? d.stop() : { ok: false, error: 'NOT_WIRED' })),
      install: {
        check: wrap(() => installer().check()),
        install: wrap((o) => installer().install(o || {})),
        downloadModel: wrap((id) => installer().downloadModel(id)),
        cancel: wrap(async () => installer().cancel()),
      },
    },
    library: {
      find: wrap(async (query, f) => { const r = library.list(Object.assign({}, f || {}, { q: query || '' })); return r.items; }),
      get: wrap(async (id) => library.get(id)),
      characterLock: wrap(async (name) => library.getLock(name)),
      locks: wrap(async () => library.listLocks().locks),
      scan: wrap(async () => library.scan()),
    },
  };
}

function register(api) { registered = api; return api; }
function get() { return registered; }

module.exports = { createImagesApi, register, get };
