'use strict';
/*
 * alfred-main.js — wires 🎩 Alfred into the Electron main process. main.js calls
 * installAlfred(hooks) once (one small, clearly marked block) and hands over the app's own
 * functions; everything Alfred does goes through them:
 *   Akọwe            hooks.akoweApi (Akọwe's HTTP API with the token AutoInjector already holds)
 *   images           alfred-image.js (the one adapter over image-provider — re-point it later)
 *   video            video-provider.js (reported as not available until a backend is set up)
 *   AI panes         sendTextTo + the captured replies, the self-repair check-in, pane health
 *   files / logs     the output folders, the log Extract ("This book only")
 *   Open Interpreter interpreter-provider.js (only when turned on in Alfred's settings)
 * IPC: alfred:* handlers; UI events go out on the "alfred" channel.
 */
const fs = require('fs');
const path = require('path');
const { createAlfred } = require('./alfred');
const { createImageAdapter } = require('./alfred-image');

const NEVER_OPEN = /\.(exe|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|lnk|jar|sh|bash|py|pyw|app|command|reg|hta|cpl|dll)$/i;

// ---- IPC capture: Alfred's app controls call the SAME handlers the buttons call ----------------------------
// main.js calls captureIpc(ipcMain) right after requiring Electron, before any handler is registered.
const ipcHandlers = new Map();
function captureIpc(ipcMain) {
  if (!ipcMain || ipcMain.__alfredCaptured) return ipcHandlers;
  const orig = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => { ipcHandlers.set(channel, fn); return orig(channel, fn); };
  ipcMain.__alfredCaptured = true;
  return ipcHandlers;
}
const ALFRED_EVENT = Object.freeze({ sender: { send: () => {} }, senderFrame: null, alfred: true });
async function invokeChannel(channel, ...args) {
  const fn = ipcHandlers.get(channel);
  if (!fn) return { ok: false, error: 'NO_SUCH_CONTROL', message: `This build has no "${channel}" control.` };
  try { return await fn(ALFRED_EVENT, ...args); } catch (e) { return { ok: false, error: 'CONTROL_ERROR', message: `That control failed: ${String((e && e.message) || e).slice(0, 200)}` }; }
}

// ---- the 🎨 Images module (sd-api.js) as Alfred methods -------------------------------------------------------
// Built from the module object itself, so a method the module gains later appears here automatically (unknown
// ones ask first and take their arguments as given). Known ones get a schema; when the module advertises
// capabilities() (the full-controls build), its schemas win.
const str = { type: 'string', maxLength: 2000 };
const LORAS = { type: 'array', maxItems: 12, items: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 200 }, weight: { type: 'number', minimum: -5, maximum: 5 } }, additionalProperties: false } };
const PASS = { 'x-passthrough': true };
const VIEW_IDS = ['front', 'three_quarter_front', 'side', 'three_quarter_back', 'back', 'idle', 'draw', 'attack', 'dash', 'defend'];
const GENERATE_SCHEMA = { type: 'object', additionalProperties: false, required: [], properties: {
  prompt: { type: 'string', minLength: 1, maxLength: 4000 }, negativePrompt: str, loras: LORAS, characterLock: { type: 'string', maxLength: 120 },
  purpose: { type: 'string', enum: ['portrait', 'cover', 'scene', 'illustration', 'map', 'test', 'free', 'view', 'sheet'] },
  engine: { type: 'string', enum: ['auto', 'sd', 'chatgpt'], description: 'sd = Stable Diffusion, chatgpt = ChatGPT\'s own image generation in its pane, auto = SD when connected, else ChatGPT' },
  view: { type: 'string', enum: VIEW_IDS, description: 'with purpose "view": which full-body reference view' },
  appearance: { type: 'string', maxLength: 2000, description: 'what the character looks like, in words' },
  upscale: { type: 'integer', minimum: 2, maximum: 4, description: 'upscale the finished picture ×2 or ×4' }, size: { type: 'object', description: 'shape hint {width, height}, e.g. {width:6,height:9} for a 6×9 in cover' },
  newChat: { type: 'boolean', description: 'ChatGPT engine: start a fresh ChatGPT chat' }, series: { type: 'string', maxLength: 120 },
  width: { type: 'integer', minimum: 64, maximum: 4096 }, height: { type: 'integer', minimum: 64, maximum: 4096 },
  steps: { type: 'integer', minimum: 1, maximum: 200 }, cfgScale: { type: 'number', minimum: 0, maximum: 40 }, seed: { type: 'integer' },
  sampler: { type: 'string', maxLength: 80 }, scheduler: { type: 'string', maxLength: 80 }, checkpoint: { type: 'string', maxLength: 300 }, vae: { type: 'string', maxLength: 300 },
  count: { type: 'integer', minimum: 1, maximum: 8 }, batchCount: { type: 'integer', minimum: 1, maximum: 8 }, initImage: { type: 'string', maxLength: 30000000 }, denoise: { type: 'number', minimum: 0, maximum: 1 },
  book: { type: 'string', maxLength: 200 }, keepSeed: { type: 'boolean' },
  extra: Object.assign({ description: 'raw A1111 txt2img/img2img payload fields (e.g. enable_hr, hr_scale, alwayson_scripts)' }, PASS),
  options: Object.assign({ description: '/sdapi/v1/options keys to set (e.g. CLIP_stop_at_last_layers)' }, PASS),
  workflow: Object.assign({ description: 'ComfyUI: a workflow JSON (API format) with {{name}} parameters, or the name of a saved one' }, PASS),
  params: Object.assign({ description: 'values for the workflow\'s {{name}} parameters' }, PASS),
} };
const SD_META = {
  'images.status': { changes: false, schema: { type: 'object', properties: {}, additionalProperties: false } },
  'images.progress': { changes: false, schema: { type: 'object', properties: {}, additionalProperties: false } },
  'images.gallery': { changes: false, schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false }, call: (a) => [a.limit || 20] },
  'images.generate': { changes: true, schema: GENERATE_SCHEMA, call: (a) => [Object.assign({ from: 'alfred' }, a)] },
  'images.cancel': { changes: true, schema: { type: 'object', properties: {}, additionalProperties: false } },
  'images.test': { changes: true, schema: { type: 'object', properties: {}, additionalProperties: false } },
  'images.chatgptStatus': { changes: false, schema: { type: 'object', properties: {}, additionalProperties: false } },
  'images.chatgptCancel': { changes: true, schema: { type: 'object', properties: {}, additionalProperties: false } },
  'images.chatgptSettings': { changes: true, schema: { type: 'object', properties: { freshChatPerSeries: { type: 'boolean' }, timeoutMs: { type: 'integer', minimum: 10000, maximum: 1800000 } }, additionalProperties: false }, call: (a) => [a] },
  'sd.status': { changes: false, schema: { type: 'object', properties: {}, additionalProperties: false } },
  'sd.targets': { changes: false, schema: { type: 'object', properties: {}, additionalProperties: false } },
  'sd.detect': { changes: false, schema: { type: 'object', properties: {}, additionalProperties: false } },
  'sd.connect': { changes: true, schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', minLength: 4, maxLength: 400 } }, additionalProperties: false }, call: (a) => [a.url] },
  'sd.start': { changes: true, schema: { type: 'object', properties: { target: { type: 'string', maxLength: 200 } }, additionalProperties: false }, call: (a) => [a.target] },
  'sd.stop': { changes: true, schema: { type: 'object', properties: {}, additionalProperties: false } },
  'sd.install.check': { changes: false, schema: { type: 'object', properties: {}, additionalProperties: false } },
  'sd.install.install': { changes: true, schema: { type: 'object', properties: { build: { type: 'string', maxLength: 40 }, ignoreSpace: { type: 'boolean' } }, additionalProperties: false }, call: (a) => [a] },
  'sd.install.downloadModel': { changes: true, schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', enum: ['sd15', 'sdxl'] } }, additionalProperties: false }, call: (a) => [a.id] },
  'sd.install.cancel': { changes: true, schema: { type: 'object', properties: {}, additionalProperties: false } },
  'library.find': { changes: false, schema: { type: 'object', properties: { query: { type: 'string', maxLength: 200 }, kind: { type: 'string', enum: ['checkpoint', 'lora', 'vae', 'embedding'] }, base: { type: 'string', maxLength: 40 } }, additionalProperties: false }, call: (a) => [a.query || '', { kind: a.kind, base: a.base }] },
  'library.get': { changes: false, schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 300 } }, additionalProperties: false }, call: (a) => [a.id] },
  'library.characterLock': { changes: false, schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 120 } }, additionalProperties: false }, call: (a) => [a.name] },
  'library.locks': { changes: false, schema: { type: 'object', properties: {}, additionalProperties: false } },
  'library.scan': { changes: true, schema: { type: 'object', properties: {}, additionalProperties: false } },
};
const READ_VERBS = /^(status|progress|gallery|list|lists|find|get|locks|targets|detect|check|models|modules|schema|capabilities|upscalers|samplers|schedulers|info|describe|styles|scripts|embeddings|extraFields|memory|queue|objectInfo|characterLock)$/i;
function walkMethods(obj, prefix, out, depth) {
  if (!obj || typeof obj !== 'object' || depth > 3) return out;
  for (const [k, v] of Object.entries(obj)) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'function') out.push(name);
    else if (v && typeof v === 'object') walkMethods(v, name, out, depth + 1);
  }
  return out;
}
async function sdMethodsOf(api) {
  if (!api) return [];
  let caps = null;
  if (typeof api.capabilities === 'function') { try { caps = await api.capabilities(); } catch (_) { caps = null; } }
  if (caps && caps.ok === false) caps = null;
  const capList = caps && (Array.isArray(caps) ? caps : caps.operations || caps.ops || caps.methods) || [];
  const capBy = new Map(capList.filter((c) => c && (c.method || c.name)).map((c) => [c.method || c.name, c]));
  const passthrough = (caps && caps.passthrough) || {};
  const names = new Set(walkMethods(api, '', [], 0));
  for (const c of capBy.keys()) names.add(c); // operations reachable only through api.call()
  return [...names].filter((m) => m !== 'capabilities' && m !== 'call').map((m) => {
    const meta = SD_META[m] || {};
    const cap = capBy.get(m) || {};
    const last = m.split('.').pop();
    const changes = cap.changes !== undefined ? !!cap.changes : meta.changes !== undefined ? meta.changes : !READ_VERBS.test(last);
    const capSchema = cap.params && typeof cap.params === 'object' ? cap.params : cap.schema && typeof cap.schema === 'object' ? cap.schema : null;
    let schema = capSchema || meta.schema || null;
    if (m === 'images.generate' && caps && caps.generateSchema) schema = Object.assign({}, caps.generateSchema, { properties: Object.assign({}, GENERATE_SCHEMA.properties, caps.generateSchema.properties || {}) });
    const out = { method: m, changes, schema, title: cap.title || cap.description || null, call: meta.call || null };
    if (m === 'images.generate' && !capSchema) {
      out.unsupported = (a) => {
        for (const k of ['extra', 'options', 'workflow']) if (a && a[k] !== undefined && !passthrough[k] && !(caps && caps.generateSchema && caps.generateSchema.properties && caps.generateSchema.properties[k])) return `"${k}" needs the full Stable Diffusion controls in the Images module, which this build does not have yet`;
        return null;
      };
    }
    return out;
  });
}
function resolvePath(api, method) { return method.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), api); }

function videoModule() { try { return require('./video-api').get(); } catch (_) { return null; } }

function installAlfred(h) {
  const { ipcMain, shell } = h;
  const image = createImageAdapter({ imageProvider: h.imageProvider, outputManager: h.outputManager, dbService: h.dbService });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SITE_IDS = h.siteIds;

  function listOutputs(category, limit) {
    let dir;
    try { dir = h.outputManager.dir(category); } catch (_) { return []; }
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return []; }
    return names.map((n) => { const p = path.join(dir, n); try { const st = fs.statSync(p); return st.isFile() ? { name: n, path: p, size: st.size, modified: new Date(st.mtimeMs).toISOString(), mtime: st.mtimeMs } : null; } catch (_) { return null; } })
      .filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(1, Math.min(100, limit || 20))).map(({ mtime, ...rest }) => rest);
  }
  async function openOutput(p) {
    const root = h.outputManager.root();
    if (!root) return { ok: false, error: 'NO_OUTPUT_FOLDER' };
    const full = path.resolve(path.isAbsolute(p) ? p : path.join(root, p));
    const rel = path.relative(root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'OUTSIDE_OUTPUTS', message: 'I only open files from the app\'s output folders.' };
    if (NEVER_OPEN.test(full)) return { ok: false, error: 'NOT_ALLOWED', message: 'I never open programs or scripts.' };
    if (!fs.existsSync(full)) return { ok: false, error: 'NOT_FOUND', message: 'That file does not exist.' };
    try { const err = await shell.openPath(full); return err ? { ok: false, error: 'OPEN_FAILED' } : { ok: true }; } catch (_) { return { ok: false, error: 'OPEN_FAILED' }; }
  }
  function exportLogs({ scope, bookId }) {
    const opts = scope === 'day' ? { scope: 'time', preset: 'day' } : scope === 'everything' ? { scope: 'everything' } : { scope: 'book', bookId };
    const r = h.buildExtract(opts);
    if (!r.ok) return { ok: false, error: r.error };
    const file = h.outputManager.saveBuffer(h.outputManager.logsDir(), r.fileName, r.text);
    h.logEvent('extract-all', { scope: r.scope, book: r.book ? r.book.id : undefined, messages: r.counts.messages, logEntries: r.counts.events, redactions: r.redactions, via: 'alfred' });
    return { ok: true, file };
  }
  async function generateVideo(prompt) {
    const r = await h.videoProvider.generate(prompt, {});
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'FAILED', message: r && r.message };
    if (r.videoBase64) {
      try { return { ok: true, path: h.outputManager.saveBuffer(h.outputManager.videosDir(), `vid-${Date.now()}.mp4`, Buffer.from(r.videoBase64, 'base64')) }; }
      catch (_) { return { ok: false, error: 'SAVE_FAILED' }; }
    }
    return { ok: true, url: r.videoUrl || null };
  }
  async function sendToAi(sites, text) {
    const out = {};
    for (const s of sites) {
      if (!h.state.enabled[s]) { out[s] = { ok: false, error: 'TURNED_OFF' }; continue; }
      try { out[s] = await h.sendTextTo(s, h.withEnvelope(String(text), s), null); } catch (e) { out[s] = { ok: false, error: 'SEND_FAILED' }; }
    }
    return out;
  }
  function latestReply(site) {
    const t = (h.state.transcript || []).filter((x) => x.site === site).pop();
    return t ? { text: t.text, ts: t.ts } : null;
  }
  function aiHealth() {
    const sr = h.selfRepairStatus();
    const out = {};
    for (const s of SITE_IDS) {
      const x = (sr.sites && sr.sites[s]) || {};
      const p = x.problem;
      out[s] = { name: x.label || s, active: !!x.active, state: x.state || 'unknown', problem: p ? (p.say || p.code || String(p)).toString().slice(0, 200) : null };
    }
    return out;
  }
  function runCheckin(sites) {
    const want = sites && sites.length ? sites.filter((s) => SITE_IDS.includes(s)) : null;
    for (const s of (want || SITE_IDS)) { try { h.selfRepair.userActed(s); } catch (_) {} }
    const r = h.selfRepair.probeMany(want, 'alfred', 'demand');
    h.logEvent('self-repair', { step: 'check', reason: 'alfred', outcome: `started:${(r.started || []).length}` });
    return r;
  }
  async function openAkowePage(hash) {
    const base = h.akoweServerBase();
    if (!base) return { ok: false, error: 'AKOWE_NOT_READY' };
    const url = `${base.replace(/\/$/, '')}/${hash}`;
    let ok = false;
    try { ok = h.akoweShowInTab(url); } catch (_) {}
    if (!ok) { try { h.akoweLoadView(true); await sleep(300); ok = h.akoweShowInTab(url); } catch (_) {} }
    return { ok: !!ok };
  }
  /** A web AI pane as Alfred's brain: type the prompt, wait for the next captured reply. */
  async function paneAsk(site, text, { timeoutMs, signal } = {}) {
    if (!h.state.enabled[site]) return { ok: false, error: 'TURNED_OFF' };
    const sentTs = Date.now();
    const r = await h.sendTextTo(site, h.withEnvelope(String(text), site), null);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'SEND_FAILED' };
    const end = Date.now() + (timeoutMs || 180000);
    while (Date.now() < end) {
      if (signal && signal.aborted) return { ok: false, error: 'CANCELLED' };
      const t = (h.state.transcript || []).filter((x) => x.site === site && x.ts >= sentTs).pop();
      if (t && t.text) return { ok: true, text: t.text };
      await sleep(400);
    }
    return { ok: false, error: 'TIMEOUT' };
  }

  const ctx = {
    invoke: (channel, ...args) => invokeChannel(channel, ...args),
    local: async (what, a) => { if (what === 'showTab') { h.broadcast('alfred', { type: 'show-tab', tab: a.tab }); return { ok: true, tab: a.tab }; } return { ok: false, error: 'UNKNOWN' }; },
    sdMethods: async () => sdMethodsOf(image.module()),
    sdInvoke: async (method, a) => {
      const api = image.module();
      if (!api) return { ok: false, error: 'NO_IMAGES_MODULE', message: 'The Images module is not available.' };
      const params = method === 'images.generate' && a && typeof a === 'object' && !Array.isArray(a) ? Object.assign({ from: 'alfred' }, a) : a;
      if (typeof api.call === 'function') return api.call(method, params === undefined ? {} : params); // the module's own dispatcher (full-controls build)
      const fn = resolvePath(api, method);
      if (typeof fn !== 'function') return { ok: false, error: 'NO_METHOD' };
      const meta = (await sdMethodsOf(api)).find((m) => m.method === method) || {};
      const args = meta.call ? meta.call(a || {}) : Array.isArray(a) ? a : a === undefined || (a && typeof a === 'object' && !Object.keys(a).length) ? [] : [a];
      const owner = resolvePath(api, method.split('.').slice(0, -1).join('.')) || api;
      return fn.apply(owner, args);
    },
    // 🎬 Video module (video-api.js) — the Video tab's own API; null in a build without it
    videoMethods: async () => sdMethodsOf(videoModule()),
    videoInvoke: async (method, a) => {
      const api = videoModule();
      if (!api) return { ok: false, code: 'VIDEO_NOT_SET_UP', error: 'NO_VIDEO_MODULE', message: 'The 🎬 Video module is not available.' };
      const params = /^video\.(generate|animate)$/.test(method) && a && typeof a === 'object' && !Array.isArray(a) ? Object.assign({ from: 'alfred' }, a) : (a === undefined ? {} : a);
      if (typeof api.call === 'function') return api.call(method, params);
      const fn = resolvePath(api, method);
      if (typeof fn !== 'function') return { ok: false, error: 'NO_METHOD' };
      const owner = resolvePath(api, method.split('.').slice(0, -1).join('.')) || api;
      return fn.call(owner, params);
    },
    akowe: (method, p, body) => h.akoweApi(method, p, body, 20000),
    openAkowePage,
    generateImage: (o) => image.generate(o),
    // Stable Diffusion module (sd-api.js) — the 🎨 Images tab's own API
    sdStatus: async () => {
      const m = image.module();
      if (!m) return { ok: false, error: 'NO_IMAGES_MODULE' };
      const r = await m.sd.status();
      if (r && r.ok !== false && m.images && typeof m.images.chatgptStatus === 'function') { try { r.chatgpt = await m.images.chatgptStatus(); } catch (_) {} }
      return r;
    },
    sdStart: async (t) => { const m = image.module(); return m ? m.sd.start(t) : { ok: false, error: 'NO_IMAGES_MODULE' }; },
    sdStop: async () => { const m = image.module(); return m ? m.sd.stop() : { ok: false, error: 'NO_IMAGES_MODULE' }; },
    libraryFind: async (q, f) => { const m = image.module(); return m ? m.library.find(q, f) : { ok: false, error: 'NO_IMAGES_MODULE' }; },
    characterLock: async (n) => { const m = image.module(); return m ? m.library.characterLock(n) : null; },
    characterLocks: async () => { const m = image.module(); return m ? m.library.locks() : []; },
    listOutputs: async (cat, limit) => listOutputs(cat, limit),
    videoStatus: () => h.videoProvider.status(),
    generateVideo,
    sendToAi, latestReply, aiHealth, runCheckin,
    openOutput, exportLogs: async (o) => exportLogs(o),
    interpreterRun: (task) => {
      const st = h.interpreterProvider.status();
      if (!st.enabled || !st.configured) return Promise.resolve({ ok: false, error: 'INTERPRETER_NOT_SET_UP' });
      return h.interpreterProvider.run(task, { onEvent: () => {} });
    },
  };

  const alfred = createAlfred({
    settingsFile: path.join(h.userDataDir(), 'alfred-settings.json'),
    ctx,
    log: (kind, detail) => h.logEvent(kind, detail),
    emit: (payload) => h.broadcast('alfred', payload),
    journal: (pid, code, title) => h.akoweApi('POST', `/api/projects/${encodeURIComponent(pid)}/branches/main/journal/note`, { source: 'alfred', code, title }, 8000),
    managerConfig: () => { const c = h.state.managerConfig || {}; return c.endpoint && c.model ? { endpoint: c.endpoint, apiKey: c.apiKey, model: c.model } : null; },
    managedOllama: () => { try { return h.ollamaManager.managedStatus(); } catch (_) { return null; } },
    paneAsk,
    listModels: (endpoint) => h.ollamaManager.listInstalled(String(endpoint || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '').replace(/\/+$/, ''), 3000),
    akoweReady: () => !!h.akoweServerBase(),
    connected: () => {
      const im = h.imageProvider.status(); const vi = h.videoProvider.status(); const oi = h.interpreterProvider.status();
      return { akowe: !!h.akoweServerBase(), images: !!(im.enabled && im.configured), video: !!(vi.enabled && vi.configured), panes: SITE_IDS.filter((s) => h.state.enabled[s]).length, interpreter: !!(oi.enabled && oi.configured) };
    },
  });

  // App events -> the watcher (ignored while Alfred is off; the listener itself does nothing then).
  h.broadcastListeners.add((channel, payload) => {
    if (channel === 'alfred') return;
    if (channel === 'self-repair' || channel === 'manager-log') { try { alfred.onAppEvent(channel, payload); } catch (_) {} }
  });

  ipcMain.handle('alfred:status', () => alfred.status());
  ipcMain.handle('alfred:set-enabled', (_e, p) => alfred.setEnabled(!!(p && p.on)));
  ipcMain.handle('alfred:settings', (_e, patch) => alfred.setSettings(patch || {}));
  ipcMain.handle('alfred:ask', async (_e, p) => { try { return await alfred.ask(p && p.text); } catch (e) { return { ok: false, error: 'ERROR', message: 'Something went wrong on my side.' }; } });
  ipcMain.handle('alfred:confirm', async (_e, p) => { try { return await alfred.confirm(p && p.id, { alwaysAllow: p && p.alwaysAllow }); } catch (e) { return { ok: false, error: 'ERROR' }; } });
  ipcMain.handle('alfred:reject', (_e, p) => alfred.reject(p && p.id));
  ipcMain.handle('alfred:cancel', () => alfred.cancel());
  ipcMain.handle('alfred:clear', () => alfred.clearChat());
  ipcMain.handle('alfred:test-ai', async () => { try { return await alfred.testAi(); } catch (_) { return { ok: false }; } });
  ipcMain.handle('alfred:models', async () => {
    const s = alfred.getSettings();
    const base = (s.local.endpoint || 'http://127.0.0.1:11434/v1').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    try { return await h.ollamaManager.listInstalled(base, 3000); } catch (_) { return { ok: false, models: [] }; }
  });
  ipcMain.handle('alfred:open-path', async (_e, p) => openOutput(String((p && p.path) || '')));
  return alfred;
}

module.exports = { installAlfred, captureIpc, ipcHandlers, invokeChannel, sdMethodsOf, SD_META, GENERATE_SCHEMA };
