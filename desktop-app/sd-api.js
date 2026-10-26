'use strict';
/*
 * sd-api.js — ONE clean module API for images / Stable Diffusion, for other parts
 * of AutoInjector (Alfred, the app-wide assistant; the butler; future Akọwe
 * hooks). main.js builds it once and registers it; callers in the main process do:
 *
 *   const imagesApi = require('./sd-api').get();      // null until main registered it
 *   await imagesApi.capabilities();                    // every operation + its parameter schema
 *                                                      // for the CONNECTED backend (generate tools from it)
 *   await imagesApi.call('images.generate', { prompt: 'a cat', hires: { scale: 2 } });   // generic dispatcher
 *
 *   images.status() · generate(opts) · img2img(opts) · inpaint(opts) · upscale(opts)
 *          · progress() · cancel() · gallery(limit) · test() · fixAndRetry(fix, request)
 *          · chatgptStatus() · chatgptCancel() · chatgptSettings({ freshChatPerSeries })
 *     generate also takes engine: "auto" | "sd" | "chatgpt" (ChatGPT's own image generation in
 *     its logged-in pane), purpose "view" + view (front, three_quarter_front, side,
 *     three_quarter_back, back, idle, draw, attack, dash, defend) or purpose "sheet", appearance,
 *     newChat, series → the same answer as POST /image/request (+ engine, view, paths).
 *     generate accepts everything in sd-params.js GENERATE_SCHEMA: prompt, negativePrompt,
 *     loras, characterLock, purpose, checkpoint, vae, sampler, scheduler, steps, cfgScale,
 *     width, height, seed, count, batchCount, variation, clipSkip, restoreFaces, tiling,
 *     styles, hires{…}, refiner{…}, initImage, denoise, resizeMode, mask, inpaint{…},
 *     controlnet[…], adetailer[…], script{name,args}, alwaysonScripts, overrideSettings, extra
 *        → { ok, images:[{ path, seed, sha256 }], seed, warnings, settings } | { ok:false, error, code, message, hint }
 *        a failure the server explained also has fix, serverError and maybe actions:[{id,label}]
 *        (sd-errors.js: VAE_LOAD_FAILED, OOM, NAN, CHECKPOINT_LOAD_FAILED, LORA_MISSING, …)
 *   sd.status() / detect() / connect(url) / start(targetId?) / stop() / targets()
 *   sd.install.check() / install(opts) / downloadModel('sd15'|'sdxl') / cancel()
 *   sd.options.get(keys?) / set({key: value}) / schema()       (A1111 settings menu, validated)
 *   sd.controlnet.models() / modules()  · sd.adetailer.models()
 *   sd.styles() · sd.scripts() · sd.embeddings() · sd.upscalers() · sd.extraFields(kind)
 *   sd.interrupt() · sd.skip() · sd.refresh(what) · sd.memory() · sd.lists()
 *   sd.workflows.list() / get(id) / save({name, workflow, bindings}) / delete(id) / run({id|workflow, params})
 *   sd.comfy.objectInfo(node?) / queue() / upload(image, name) / free()
 *   library.find(query, { kind, base }) → items  ·  library.get(id)
 *   library.characterLock(name) → lock | null  ·  library.locks() · library.scan()
 *
 * Every call resolves (never throws) and failures carry a plain-English `message`.
 * Something the connected app can't do → { ok:false, code:'UNSUPPORTED_ON_BACKEND', hint }.
 * Saved pictures land in the output images/ folder with their settings embedded.
 */
const P = require('./sd-params');

let registered = null;

function wrap(fn) {
  return async (...a) => {
    try { return await fn(...a); }
    catch (e) { return { ok: false, error: 'INTERNAL', message: `Something went wrong: ${(e && e.message) || e}` }; }
  };
}
function notWired(name) { return { ok: false, error: 'NOT_WIRED', code: 'NOT_WIRED', message: `${name} is not available in this build.` }; }

// ------------------------------------------------------------ operation table
// args: positional argument names, or 'object' = the params object is the one argument.
// backends: where it works. feature: a key of studio.features() that must be true.
const O = (props, required) => ({ type: 'object', properties: props || {}, required: required || [], additionalProperties: false });
const OPEN = (d) => ({ type: 'object', description: d, additionalProperties: true });
const BOTH = ['a1111', 'comfy'];
const OPS = [
  { name: 'capabilities', description: 'Every operation and parameter this API supports for the connected Stable Diffusion app', params: O(), args: [], backends: ['*'] },
  { name: 'call', description: 'Call any operation by name with a params object', params: O({ name: { type: 'string', description: 'Operation name, e.g. "images.generate"' }, params: OPEN('Its parameters') }, ['name']), args: ['name', 'params'], backends: ['*'] },
  { name: 'images.status', description: 'Is an SD app connected, which one, is it busy', params: O(), args: [], backends: ['*'] },
  { name: 'images.generate', description: 'Make pictures (txt2img; img2img when initImage is given; inpaint with mask). engine "chatgpt" / "auto" uses ChatGPT\'s own image generation when no SD app is connected; purpose "view" + view / "sheet" make character reference pictures. Saved to images/ with settings embedded', params: 'GENERATE', args: 'object', backends: ['*'] },
  { name: 'images.img2img', description: 'Change an existing picture (initImage required)', params: 'IMG2IMG', args: 'object', backends: BOTH },
  { name: 'images.inpaint', description: 'Repaint the masked part of a picture (initImage + mask required)', params: 'INPAINT', args: 'object', backends: BOTH },
  { name: 'images.upscale', description: 'Upscale a picture (A1111 Extras / ComfyUI upscale model)', params: P.UPSCALE_SCHEMA, args: 'object', backends: BOTH, feature: 'extras' },
  { name: 'images.progress', description: 'Progress of the current picture', params: O(), args: [], backends: ['*'] },
  { name: 'images.cancel', description: 'Stop the picture AutoInjector is making', params: O(), args: [], backends: ['*'] },
  { name: 'images.gallery', description: 'Recent saved pictures with their settings', params: O({ limit: { type: 'integer', minimum: 1, maximum: 500 } }), args: ['limit'], backends: ['*'] },
  { name: 'images.test', description: 'Make a 512×512 test picture', params: O(), args: [], backends: BOTH },
  { name: 'images.chatgptStatus', description: 'The ChatGPT image engine: is its pane ready (and why not), is it drawing, for how long, the last result', params: O(), args: [], backends: ['*'] },
  { name: 'images.chatgptCancel', description: 'Stop waiting for the ChatGPT picture being made', params: O(), args: [], backends: ['*'] },
  { name: 'images.chatgptSettings', description: 'ChatGPT image engine settings: freshChatPerSeries = a new ChatGPT chat for each reference-view series (default: one chat, which keeps the character the same)', params: O({ freshChatPerSeries: { type: 'boolean' }, timeoutMs: { type: 'integer', minimum: 10000, maximum: 1800000 } }), args: 'object', backends: ['*'] },
  { name: 'images.fixAndRetry', description: 'Apply the one-click fix a failed picture offered (its actions[].id, e.g. "vae-automatic" = VAE → Automatic, also in A1111\'s settings) and try the same request once more', params: O({ fix: { type: 'string', enum: ['vae-automatic'] }, request: OPEN('The images.generate params that failed') }, ['fix']), args: ['fix', 'request'], backends: BOTH },
  { name: 'sd.status', description: 'Image module + managed runner + installer state', params: O(), args: [], backends: ['*'] },
  { name: 'sd.detect', description: 'Look for SD apps on this PC (ports 7860–7865, 8188, …)', params: O(), args: [], backends: ['*'] },
  { name: 'sd.connect', description: 'Connect to an SD app (empty url = find one)', params: O({ url: { type: 'string', description: 'e.g. http://127.0.0.1:7860' } }), args: ['url'], backends: ['*'] },
  { name: 'sd.targets', description: 'SD apps AutoInjector can start (Stability Matrix packages, installed ComfyUI)', params: O(), args: [], backends: ['*'] },
  { name: 'sd.start', description: 'Start an SD app with its API on', params: O({ targetId: { type: 'string' } }), args: ['targetId'], backends: ['*'] },
  { name: 'sd.stop', description: 'Stop the SD app AutoInjector started', params: O(), args: [], backends: ['*'] },
  { name: 'sd.lists', description: 'Checkpoints, LoRAs, samplers, schedulers, VAEs, embeddings (+ ComfyUI upscale / ControlNet models)', params: O(), args: [], backends: BOTH },
  { name: 'sd.install.check', description: 'GPU / disk check for the one-click ComfyUI install', params: O(), args: [], backends: ['*'] },
  { name: 'sd.install.install', description: 'Download and install ComfyUI portable (Windows)', params: O({ build: { type: 'string' }, ignoreSpace: { type: 'boolean' } }), args: 'object', backends: ['*'] },
  { name: 'sd.install.downloadModel', description: 'Download a starter checkpoint', params: O({ id: { type: 'string', enum: ['sd15', 'sdxl'] } }, ['id']), args: ['id'], backends: ['*'] },
  { name: 'sd.install.cancel', description: 'Cancel the install / download', params: O(), args: [], backends: ['*'] },
  { name: 'sd.options.get', description: 'Read settings-menu options (all, or the given keys)', params: O({ keys: { type: 'array', items: { type: 'string' } } }), args: ['keys'], backends: ['a1111'] },
  { name: 'sd.options.set', description: 'Change settings-menu options (validated against the server: key exists, type matches, choices exist)', params: O({ options: OPEN('{ "<key>": value }, e.g. { "CLIP_stop_at_last_layers": 2 }') }, ['options']), args: ['options'], backends: ['a1111'] },
  { name: 'sd.options.schema', description: 'Every option key with its type and current value', params: O(), args: [], backends: ['a1111'] },
  { name: 'sd.controlnet.models', description: 'ControlNet models', params: O(), args: [], backends: BOTH, feature: 'controlnet' },
  { name: 'sd.controlnet.modules', description: 'ControlNet preprocessors', params: O(), args: [], backends: BOTH, feature: 'controlnet' },
  { name: 'sd.adetailer.models', description: 'ADetailer detection models', params: O(), args: [], backends: ['a1111'], feature: 'adetailer' },
  { name: 'sd.styles', description: 'Saved prompt styles', params: O(), args: [], backends: ['a1111'] },
  { name: 'sd.scripts', description: 'txt2img / img2img scripts and their arguments', params: O(), args: [], backends: ['a1111'] },
  { name: 'sd.embeddings', description: 'Textual-inversion embeddings', params: O(), args: [], backends: BOTH },
  { name: 'sd.upscalers', description: 'Upscalers (incl. latent modes) for hires fix and upscale', params: O(), args: [], backends: BOTH },
  { name: 'sd.extraFields', description: 'Every txt2img / img2img payload field the server accepts (for generate\'s `extra`)', params: O({ kind: { type: 'string', enum: ['txt2img', 'img2img'] } }), args: ['kind'], backends: ['a1111'] },
  { name: 'sd.interrupt', description: 'Stop whatever the SD app is rendering (even jobs not from AutoInjector)', params: O(), args: [], backends: BOTH },
  { name: 'sd.skip', description: 'Skip to the next picture of a batch', params: O(), args: [], backends: ['a1111'] },
  { name: 'sd.refresh', description: 'Rescan model folders', params: O({ what: { type: 'string', enum: ['all', 'checkpoints', 'loras', 'vae', 'embeddings'] } }), args: ['what'], backends: BOTH },
  { name: 'sd.memory', description: 'RAM / VRAM use', params: O(), args: [], backends: BOTH },
  { name: 'sd.workflows.list', description: 'Saved ComfyUI workflows and their parameter names', params: O(), args: [], backends: ['*'] },
  { name: 'sd.workflows.get', description: 'One saved workflow (graph + bindings)', params: O({ id: { type: 'string' } }, ['id']), args: ['id'], backends: ['*'] },
  { name: 'sd.workflows.save', description: 'Save a ComfyUI API-format workflow, optionally with named bindings', params: O({ name: { type: 'string' }, description: { type: 'string' }, workflow: OPEN('ComfyUI API-format graph'), bindings: OPEN('{ "prompt": [{ "node": "6", "input": "text" }] }') }, ['name', 'workflow']), args: 'object', backends: ['*'] },
  { name: 'sd.workflows.delete', description: 'Delete a saved workflow', params: O({ id: { type: 'string' } }, ['id']), args: ['id'], backends: ['*'] },
  { name: 'sd.workflows.run', description: 'Run a saved (id) or given (workflow) ComfyUI workflow with named params (prompt, seed, … or "<node>.<input>")', params: O({ id: { type: 'string' }, workflow: OPEN('API-format graph (instead of id)'), bindings: OPEN('extra bindings'), params: OPEN('{ "prompt": "…", "seed": 42, "6.text": "…", "image": "<path|base64>" }'), returnImage: { type: 'boolean' } }), args: 'object', backends: ['comfy'] },
  { name: 'sd.comfy.objectInfo', description: 'ComfyUI node types (all, or one node\'s inputs)', params: O({ node: { type: 'string' } }), args: ['node'], backends: ['comfy'] },
  { name: 'sd.comfy.queue', description: 'ComfyUI queue (running / pending)', params: O(), args: [], backends: ['comfy'] },
  { name: 'sd.comfy.upload', description: 'Upload a picture into ComfyUI\'s input folder (for LoadImage)', params: O({ image: { type: 'string', format: 'image' }, name: { type: 'string' } }, ['image']), args: ['image', 'name'], backends: ['comfy'] },
  { name: 'sd.comfy.free', description: 'Unload models / free VRAM in ComfyUI', params: O({ unloadModels: { type: 'boolean' }, freeMemory: { type: 'boolean' } }), args: 'object', backends: ['comfy'] },
  { name: 'library.find', description: 'Search the model & LoRA library', params: O({ query: { type: 'string' }, kind: { type: 'string', enum: ['lora', 'checkpoint', 'embedding', 'vae'] }, base: { type: 'string' } }), args: ['query', '$filters'], backends: ['*'] },
  { name: 'library.get', description: 'One library item', params: O({ id: { type: 'string' } }, ['id']), args: ['id'], backends: ['*'] },
  { name: 'library.characterLock', description: 'A character lock by id or name', params: O({ name: { type: 'string' } }, ['name']), args: ['name'], backends: ['*'] },
  { name: 'library.locks', description: 'All character locks', params: O(), args: [], backends: ['*'] },
  { name: 'library.scan', description: 'Rescan the model folders', params: O(), args: [], backends: ['*'] },
];

function _schemaFor(op, backend) {
  if (op.params !== 'GENERATE' && op.params !== 'IMG2IMG' && op.params !== 'INPAINT') return op.params;
  const s = JSON.parse(JSON.stringify(P.GENERATE_SCHEMA));
  for (const [k, v] of Object.entries(s.properties)) {
    v['x-supported'] = backend === 'comfy' ? v['x-comfy'] : backend === 'a1111' ? 'yes' : 'unknown';
  }
  s.required = op.params === 'IMG2IMG' ? ['initImage'] : op.params === 'INPAINT' ? ['initImage', 'mask'] : [];
  return s;
}
function _get(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

// Top-level keys images.generate / img2img / inpaint accept: the schema + old aliases.
const GEN_KEYS = new Set([...Object.keys(P.GENERATE_SCHEMA.properties), 'negative', 'lockId', 'character', 'pollMs']);
function checkGenKeys(opts) {
  for (const k of Object.keys(opts || {})) {
    if (GEN_KEYS.has(k) || opts[k] === undefined) continue;
    const s = P.suggest(k, [...GEN_KEYS]);
    return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: k, message: `images.generate has no parameter “${k}”.`, hint: s.length ? `Did you mean: ${s.join(', ')}?` : 'capabilities() lists every parameter.' };
  }
  return null;
}

function createImagesApi(d) {
  const studio = d.studio; const library = d.library;
  const runner = d.runner || null; const installer = d.installer || null;
  const S = (name, ...a) => (studio && typeof studio[name] === 'function' ? studio[name](...a) : notWired(name));
  const api = {
    images: {
      status: wrap(async () => Object.assign(studio.status(), { managed: runner ? runner().status() : null })),
      // engine / view / sheet → the two-engine path (the same as POST /image/request); otherwise plain SD as before.
      generate: wrap((opts) => {
        const bad = checkGenKeys(opts); if (bad) return bad;
        const o = opts || {}; const from = `api:${String(o.from || 'alfred').slice(0, 40)}`;
        if ((o.engine && o.engine !== 'sd') || o.purpose === 'view' || o.purpose === 'sheet' || o.view || o.appearance) {
          if (typeof studio.requestFrom !== 'function') return notWired('The ChatGPT image engine');
          return studio.requestFrom(Object.assign({}, o), from);
        }
        const q = Object.assign({}, o); delete q.engine;
        return studio.generate(Object.assign(q, { batchSize: o.count || o.batchSize || 1 }), from);
      }),
      img2img: wrap((opts) => checkGenKeys(opts) || S('img2img', Object.assign({}, opts || {}, { batchSize: (opts && (opts.count || opts.batchSize)) || 1 }), `api:${String((opts && opts.from) || 'alfred').slice(0, 40)}`)),
      inpaint: wrap((opts) => checkGenKeys(opts) || S('inpaint', Object.assign({}, opts || {}, { batchSize: (opts && (opts.count || opts.batchSize)) || 1 }), `api:${String((opts && opts.from) || 'alfred').slice(0, 40)}`)),
      upscale: wrap((opts) => S('upscale', opts || {}, `api:${String((opts && opts.from) || 'alfred').slice(0, 40)}`)),
      progress: wrap(() => studio.progress()),
      cancel: wrap(() => studio.cancel()),
      gallery: wrap(async (limit) => studio.gallery(limit)),
      test: wrap(() => studio.test()),
      chatgptStatus: wrap(async () => S('chatgptStatus')),
      chatgptCancel: wrap(async () => S('chatgptCancel')),
      chatgptSettings: wrap(async (o) => S('chatgptSettings', o || {})),
      fixAndRetry: wrap((fix, request) => S('fixAndRetry', fix, request || {}, `api:${String((request && request.from) || 'alfred').slice(0, 40)}`)),
    },
    sd: {
      status: wrap(async () => ({ ok: true, image: studio.status(), managed: runner ? runner().status() : null, install: installer ? installer().status() : null })),
      detect: wrap(() => studio.detect()),
      connect: wrap((url) => studio.connect(url || '')),
      targets: wrap(async () => (d.targets ? d.targets() : { ok: true, targets: [] })),
      start: wrap((targetId) => (d.start ? d.start(targetId) : { ok: false, error: 'NOT_WIRED' })),
      stop: wrap(() => (d.stop ? d.stop() : { ok: false, error: 'NOT_WIRED' })),
      lists: wrap(() => S('lists')),
      install: {
        check: wrap(() => installer().check()),
        install: wrap((o) => installer().install(o || {})),
        downloadModel: wrap((id) => installer().downloadModel(id)),
        cancel: wrap(async () => installer().cancel()),
      },
      options: {
        get: wrap((keys) => S('optionsGet', keys)),
        set: wrap((patch) => S('optionsSet', patch)),
        schema: wrap(() => S('optionsSchema')),
      },
      controlnet: { models: wrap(() => S('controlnetModels')), modules: wrap(() => S('controlnetModules')) },
      adetailer: { models: wrap(() => S('adetailerModels')) },
      styles: wrap(() => S('styles')),
      scripts: wrap(() => S('scripts')),
      embeddings: wrap(() => S('embeddings')),
      upscalers: wrap(() => S('upscalers')),
      extraFields: wrap((kind) => S('extraFields', kind)),
      interrupt: wrap(() => S('interrupt')),
      skip: wrap(() => S('skip')),
      refresh: wrap((what) => S('refresh', what)),
      memory: wrap(() => S('memory')),
      workflows: {
        list: wrap(async () => S('workflowsList')),
        get: wrap(async (id) => S('workflowGet', id)),
        save: wrap(async (rec) => S('workflowSave', rec)),
        delete: wrap(async (id) => S('workflowDelete', id)),
        run: wrap((req) => S('runWorkflow', req, `api:${String((req && req.from) || 'alfred').slice(0, 40)}`)),
      },
      comfy: {
        objectInfo: wrap((node) => S('objectInfo', node)),
        queue: wrap(() => S('queue')),
        upload: wrap((image, name) => S('uploadImage', image, name)),
        free: wrap((o) => S('free', o)),
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

  // Machine-readable list of everything above for the connected backend.
  api.capabilities = wrap(async () => {
    let f = { connected: false, backend: '' };
    try { if (studio && typeof studio.features === 'function') f = (await studio.features()) || f; } catch (_) {}
    if (!f.backend) { try { const st = studio.status(); if (st && st.endpoint) f = Object.assign({}, f, { backend: st.backend, connected: !!st.enabled }); } catch (_) {} }
    const backend = f.backend || '';
    const operations = OPS.map((op) => {
      let supported = true; let hint = '';
      if (!op.backends.includes('*')) {
        if (!backend) { supported = false; hint = 'Connect to an SD app first (sd.connect / sd.detect).'; }
        else if (!op.backends.includes(backend)) { supported = false; hint = backend === 'comfy' ? 'Needs Automatic1111 / Forge (this is ComfyUI).' : 'Needs ComfyUI (this is an A1111-family WebUI).'; }
        else if (op.feature && f[op.feature] === false) { supported = false; hint = op.feature === 'controlnet' ? (backend === 'comfy' ? 'This ComfyUI has no ControlNet nodes.' : 'Install the ControlNet extension (Forge has it built in).') : op.feature === 'adetailer' ? 'Install the ADetailer extension.' : `The server has no ${op.feature} endpoint.`; }
      }
      return { name: op.name, description: op.description, params: _schemaFor(op, backend), args: op.args, backends: op.backends, supported, hint, code: supported ? undefined : 'UNSUPPORTED_ON_BACKEND' };
    });
    const generateParams = Object.entries(P.GENERATE_SCHEMA.properties).map(([name, v]) => ({
      name, type: v.type, supported: backend === 'comfy' ? v['x-comfy'] : backend ? 'yes' : 'unknown', note: backend === 'comfy' ? (v['x-comfy-note'] || '') : '', a1111Fields: v['x-a1111'],
    }));
    const out = { ok: true, version: 2, connected: !!f.connected, backend, label: f.label || '', features: f, operations, generateParams };
    if (backend === 'a1111' && studio && typeof studio.extraFields === 'function') {
      const [t, i] = await Promise.all([studio.extraFields('txt2img'), studio.extraFields('img2img')]);
      out.extraFields = { txt2img: t && t.ok ? t.fields.map((x) => x.name) : [], img2img: i && i.ok ? i.fields.map((x) => x.name) : [], validated: !!(t && t.ok) };
    }
    return out;
  });

  // Generic dispatcher: call('sd.options.set', { options: {...} }).
  api.call = wrap(async (name, params) => {
    const op = OPS.find((o) => o.name === name);
    const fn = op && op.name !== 'call' ? _get(api, op.name) : null;
    if (!op || typeof fn !== 'function') return { ok: false, error: 'UNKNOWN_OPERATION', code: 'UNKNOWN_OPERATION', message: `There is no operation “${name}”.`, hint: `Known: ${OPS.map((o) => o.name).filter((n) => n !== 'call').join(', ')}` };
    const p = params && typeof params === 'object' ? params : {};
    const sch = _schemaFor(op, '');
    if (sch && sch.properties && sch.additionalProperties === false) {
      const unknown = Object.keys(p).filter((k) => !sch.properties[k]);
      if (unknown.length) { const s = P.suggest(unknown[0], Object.keys(sch.properties)); return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: unknown[0], message: `${name} has no parameter “${unknown[0]}”.`, hint: s.length ? `Did you mean: ${s.join(', ')}?` : `Parameters: ${Object.keys(sch.properties).join(', ') || '(none)'}` }; }
    }
    for (const r of (sch && sch.required) || []) if (p[r] === undefined || p[r] === null || p[r] === '') return { ok: false, error: 'INVALID_PARAM', code: 'INVALID_PARAM', field: r, message: `${name} needs “${r}”.` };
    if (op.args === 'object') return fn(p);
    return fn(...op.args.map((a) => (a === '$filters' ? { kind: p.kind, base: p.base } : p[a])));
  });
  return api;
}

function register(api) { registered = api; return api; }
function get() { return registered; }
// Every operation name (for tests / tool generators).
function operationNames() { return OPS.map((o) => o.name); }

module.exports = { createImagesApi, register, get, operationNames, OPS };
