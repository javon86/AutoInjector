// test/alfred-coverage.test.js — "can 🎩 Alfred control every aspect of AutoInjector?" — proved, not claimed.
//
// 1. INVENTORY: every user-facing capability, checked in below as explicit lists (IPC channels the control
//    panel / tabs / menus call, live events, the butler's decision actions, the service-bridge and Akọwe-bridge
//    routes, the 🎨 Images module API, the 📖 Akọwe API Alfred uses, the menu items, the tabs). The test scans
//    the sources and FAILS when the code has something the lists don't (a new feature must be classified).
// 2. CLASSIFICATION: each entry maps to an Alfred tool (or app action) or sits in a justified EXCLUDE list.
// 3. END TO END: every Alfred tool is driven from a fake LLM tool call (fake Ollama /v1) — against the REAL
//    main.js under mock Electron (fake panes), a fake Forge (A1111) and a fake ComfyUI through the real sd-api,
//    and a fake Akọwe API — checking the effect and the "I will" confirm flow for tools that change things.
//    Every app action is driven through Alfred to its IPC channel, and the read-only ones (plus a set of
//    changing ones) against the real handlers.
// Prints a coverage table: capability → tool → tested ✔.     Run: node test/alfred-coverage.test.js
process.env.AUTOINJECTOR_BRIDGE = '0';
process.env.AUTOINJECTOR_CHECKIN = '0';
process.env.AUTOINJECTOR_AKOWE_SERVER = '0';
process.env.AUTOINJECTOR_SD_AUTOSTART = '0';
process.env.AUTOINJECTOR_POLL_MS = process.env.AUTOINJECTOR_POLL_MS || '50';
process.env.AUTOINJECTOR_STABLE_MS = process.env.AUTOINJECTOR_STABLE_MS || '80';
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = '60';
process.env.AUTOINJECTOR_CHATIMG_POLL_MS = '80'; // the fake ChatGPT page draws in 150 ms
process.env.AUTOINJECTOR_CHATIMG_GRACE_MS = '300';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const net = require('net');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-cov-'));
const MODELS = path.join(TMP, 'Models');
process.env.AUTOINJECTOR_SD_MODEL_DIRS = MODELS;
process.env.AUTOINJECTOR_SD_HOME = path.join(TMP, 'sdhome');
function writeSafetensors(file, metadata) {
  const json = Buffer.from(JSON.stringify({ __metadata__: metadata, w: { dtype: 'F16', shape: [2], data_offsets: [0, 4] } }));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(json.length));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([len, json, Buffer.from([1, 2, 3, 4])]));
}
writeSafetensors(path.join(MODELS, 'Lora', 'odile_face.safetensors'), { ss_base_model_version: 'sd_v1', 'modelspec.trigger_phrase': 'odile woman' });
writeSafetensors(path.join(MODELS, 'StableDiffusion', 'dreamshaper_8.safetensors'), { 'modelspec.architecture': 'stable-diffusion-v1' });

const ROOT = path.join(__dirname, '..');
const mockPath = path.join(__dirname, 'mock-electron.js');
const origLoad = Module._load;
Module._load = function (request) { if (request === 'electron') return require(mockPath); return origLoad.apply(this, arguments); };
const mock = require(mockPath);
const opened = [];
mock.shell = { openPath: async (p) => { opened.push(p); return ''; }, openExternal: async (u) => { opened.push(u); }, showItemInFolder: (p) => { opened.push(p); } };
mock.clipboard = { writeText: () => {} };
mock.Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => {} };

// Open Interpreter: a stand-in (the real one is a separate local agent)
const interpreterProvider = require('../interpreter-provider');
const oiRuns = [];
interpreterProvider.status = () => ({ enabled: true, configured: true });
interpreterProvider.run = async (task) => { oiRuns.push(task); return { ok: true, message: 'ran it', events: [{ type: 'output', content: '45' }] }; };
interpreterProvider.startManaged = async () => ({ ok: false });

const registry = require('../alfred-tools');
const appActions = require('../alfred-app-actions');
const alfredMain = require('../alfred-main');
const { createAlfred } = require('../alfred');
const { nodeHttp } = require('../akowe-link-test');
const { fakeLlm, fakeAkowe, toolCall, lastMsg } = require('./alfred-fakes');
const { fakeA1111, fakeComfy } = require('./fixtures/fake-sd');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, every = 100) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } return null; }
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }

// =====================================================================================================
// 1. THE INVENTORY (explicit; a new capability fails the scan below until it is added and classified)
// =====================================================================================================
const IPC_INVENTORY = [
  'akowe-server:get-python', 'akowe-server:open-log', 'akowe-server:retry', 'akowe-server:set-autostart', 'akowe-server:status',
  'akowe-view:dock', 'akowe-view:pop-out', 'akowe-view:reload', 'akowe-view:tab',
  'akowe:connect', 'akowe:copy-diagnostics', 'akowe:copy-token', 'akowe:diagnostics', 'akowe:linktest-open-report', 'akowe:linktest-run',
  'akowe:linktest-stop', 'akowe:open-url', 'akowe:regenerate-token', 'akowe:reveal-token', 'akowe:set-enabled', 'akowe:start-app', 'akowe:status',
  'alfred:ask', 'alfred:cancel', 'alfred:clear', 'alfred:confirm', 'alfred:models', 'alfred:open-path', 'alfred:reject', 'alfred:set-enabled',
  'alfred:settings', 'alfred:status', 'alfred:test-ai',
  'alfred:personality', 'alfred:profiles', 'alfred:profile-save', 'alfred:profile-use', 'alfred:profile-delete',
  'alfred:panel', 'alfred:panel-toggle', 'alfred:show-butler',
  'brigade:run', 'brigade:stop', 'butler:capability-test', 'butler:chat', 'butler:install-missing', 'butler:selfcheck', 'butler:send-intro',
  'db:recent-messages', 'db:status', 'endpoints:detect', 'endpoints:presets', 'endpoints:test', 'external:open',
  'featuretest:open-report', 'featuretest:run', 'featuretest:stop', 'feed-window:close', 'feed:history', 'feed:open', 'gpu:info',
  'health:check', 'health:get', 'health:status', 'health:fix', 'houserule:pause', 'houserule:resume', 'houserule:start', 'houserule:stop', 'houserule:wrap-up-brainstorm',
  'image:configure', 'image:generate', 'image:status', 'lockers:attach', 'lockers:list', 'lockers:open', 'lockers:read', 'lockers:status',
  'logins:delete', 'logins:fill', 'logins:list', 'logins:save', 'logs:download-all', 'logs:extract-all', 'logs:extract-options', 'logs:extract-preview', 'logs:tags',
  'manager:approve', 'manager:configure-provider', 'manager:get-state', 'manager:pause', 'manager:reject', 'manager:resume', 'manager:start-task',
  'manager:stop', 'manager:test-connection', 'memory:search', 'memory:summary', 'models:info', 'models:open',
  'llm:status', 'llm:hardware', 'llm:check', 'llm:fix', 'llm:setup-all', 'llm:start-alfred', 'llm:scan', 'llm:use-store', 'llm:import-gguf', 'llm:install-ollama', 'llm:start', 'llm:stop', 'llm:search', 'llm:curated', 'llm:hf-files', 'llm:pull', 'llm:cancel', 'llm:remove', 'llm:use', 'llm:hf-token',
  'ollama:detect', 'ollama:list', 'ollama:managed-status', 'ollama:migrate', 'ollama:pull', 'ollama:recommended', 'panes:sync', 'participants:set',
  'phone:info', 'phone:set-lan', 'picker:cancel', 'picker:clear', 'picker:save', 'picker:start', 'picker:status', 'picker:test',
  'prompt-editor:close', 'prompts:delete', 'prompts:open-editor', 'prompts:save', 'prompts:send', 'relay:hop-limit', 'relay:silence', 'roles:set',
  'routing:auto-all', 'routing:pause-all', 'routing:set', 'routing:stop-all',
  'sd:cancel', 'sd:connect', 'sd:detect', 'sd:gallery', 'sd:generate', 'sd:install', 'sd:install-cancel', 'sd:install-check', 'sd:install-model',
  'sd:lists', 'sd:open-images-folder', 'sd:open-install-folder', 'sd:open-log', 'sd:open-ui', 'sd:progress', 'sd:record', 'sd:set-autostart',
  'sd:settings', 'sd:show-file', 'sd:start', 'sd:status', 'sd:stop', 'sd:targets', 'sd:test', 'sd:fix-retry',
  'sd:img2img', 'sd:inpaint', 'sd:upscale', 'sd:extras', 'sd:options-get', 'sd:options-set', 'sd:interrupt', 'sd:skip', 'sd:refresh', 'sd:memory', 'sd:workflows', 'sd:workflow-get', 'sd:workflow-save', 'sd:workflow-delete', 'sd:workflow-run', 'sd:capabilities',
  'sd:request', 'sd:chatgpt-status', 'sd:chatgpt-cancel', 'sd:chatgpt-settings',
  'sdlib:add-folder', 'sdlib:check', 'sdlib:collection', 'sdlib:delete-lock', 'sdlib:folders', 'sdlib:list', 'sdlib:locks', 'sdlib:remove-folder',
  'sdlib:save-lock', 'sdlib:scan', 'sdlib:update', 'selector:clear', 'selector:pick',
  'selfrepair:forget-learned', 'selfrepair:probe', 'selfrepair:reload', 'selfrepair:settings', 'selfrepair:status', 'selfrepair:teach-cancel', 'selfrepair:teach-start',
  'selftest:run', 'send:compose', 'send:forward', 'send:regenerate', 'sequence-editor:close', 'sequence:open', 'sequence:run', 'sequence:stop',
  'setup:auto', 'setup:detect', 'setup:install', 'setup:list', 'site:inspect', 'site:list', 'site:reload', 'site:zoom', 'sites:new-chat-all', 'state:get',
  'terminal:approve', 'terminal:clear', 'terminal:input', 'terminal:reject', 'terminal:run', 'terminal:send-output', 'terminal:settings', 'terminal:start',
  'terminal:state', 'terminal:stop', 'tools:list', 'tools:run', 'trace:report', 'transcript:clear', 'transcript:toggle-pin', 'tuner:run', 'ui:log',
  'video:configure', 'video:generate', 'video:status',
  'video:full-status', 'video:models', 'video:capabilities', 'video:settings', 'video:generate-t2v', 'video:animate', 'video:progress', 'video:cancel', 'video:gallery', 'video:test',
  'video:install-check', 'video:install-model', 'video:install-all', 'video:install-cancel', 'video:open-folder', 'video:show-file',
  'voice:check', 'voice:configure', 'voice:listen', 'voice:redownload', 'voice:speak', 'voice:status',
  'window:toggle-collapse', 'wizard-window:close', 'wizard:catalog', 'wizard:open',
];
// Live updates the window listens to (not actions). The ones that matter to the user feed Alfred's watcher.
const EVENTS = {
  'self-repair': 'watcher: "an AI broke / was fixed" notices', 'manager-log': 'watcher: "an image finished" notices',
  'alfred': 'Alfred\'s own panel updates',
  'health': 'the 🩺 health watch tells Alfred itself (alfred.notice) — Alfred reads health.status',
  'akowe-activity': 'UI live update (Akọwe link feed) — book runs are watched by polling Akọwe', 'chatgpt-image': 'UI live update (ChatGPT is drawing / done — Alfred reads images.chatgptStatus)', 'akowe-linktest-progress': 'UI live update', 'akowe-server': 'UI live update',
  'akowe-tab-show': 'UI live update', 'brigade-progress': 'UI live update', 'capability-test-step': 'UI live update', 'capture': 'UI live update (replies → read_latest_reply)',
  'featuretest-progress': 'UI live update', 'houserule-state': 'UI live update', 'ledger-entry': 'UI live update', 'locker-changed': 'UI live update', 'log': 'UI live update',
  'manager-ack': 'UI live update', 'manager-state': 'UI live update', 'ollama-progress': 'UI live update', 'llm': 'UI live update (setup / download progress — Alfred reads llm.status / llm.check)', 'pane-health': 'UI live update (→ ai_health)', 'picker': 'UI live update',
  'prompts-changed': 'UI live update', 'relay-paused': 'UI live update', 'sd-connected': 'UI live update', 'sd-install': 'UI live update', 'sd-runner': 'UI live update', 'video-install': 'UI live update (model download progress — Alfred reads video.install.check / video.status)', 'video-done': 'UI live update (a video finished — Alfred gets the result from video_call)',
  'send-error': 'UI live update', 'sent': 'UI live update', 'sequence-state': 'UI live update', 'setup-progress': 'UI live update', 'setup-status': 'UI live update',
  'terminal-data': 'UI live update', 'terminal-state': 'UI live update', 'tuner-state': 'UI live update', 'voice-speaking': 'UI live update', 'waiting-changed': 'UI live update',
  'window-collapse-changed': 'UI live update',
};
// The butler's decision actions (manager-provider.js): Alfred reaches them by giving the butler a task, or directly.
const MANAGER_ACTIONS_MAP = {
  CLASSIFY: 'app_control:manager.start_task', PLAN: 'app_control:manager.start_task', DELEGATE: 'send_to_ai', SEND: 'send_to_ai', FORWARD: 'app_control:send.forward',
  COMPARE: 'app_control:manager.start_task', CRITIQUE: 'app_control:manager.start_task', VERIFY: 'app_control:manager.start_task', EXTRACT: 'app_control:manager.start_task',
  ASSEMBLE: 'app_control:manager.start_task', REVISE: 'app_control:manager.start_task', VALIDATE: 'app_control:manager.start_task', SAVE: 'app_control:manager.start_task',
  EXPORT: 'export_logs', ESCALATE: 'app_control:manager.start_task', WAIT: 'app_control:manager.pause', FINISH: 'app_control:manager.stop', PAUSE: 'app_control:manager.pause',
  REQUEST_APPROVAL: 'app_control:manager.approve', RUN_CODE: 'run_code', USE_TOOL: 'EXCLUDE: the butler\'s tool runner includes free code (see tools:run)',
  REMEMBER: 'app_control:manager.start_task', RECALL: 'app_info:memory.search', GENERATE_IMAGE: 'generate_image', SETUP: 'app_control:setup.install',
};
// service-bridge.js (the local API for the phone / other programs) — the same capabilities, mapped.
const SERVICE_BRIDGE_ROUTES = {
  'GET /status': 'app_info:state.get', 'GET /participants': 'app_info:sites.list', 'GET /responses': 'read_latest_reply', 'POST /send': 'send_to_ai',
  'POST /council/start': 'app_control:houserule.start', 'POST /council/stop': 'app_control:houserule.stop', 'POST /silence': 'app_control:relay.silence',
  'GET /interpreter/status': 'app_info:butler.selfcheck', 'POST /interpreter/settings': 'EXCLUDE: Open Interpreter endpoint/auto-run settings — a security setting left to the user', 'POST /interpreter/run': 'run_code',
  'GET /jarvis/status': 'app_info:manager.get_state', 'POST /jarvis/start': 'app_control:manager.start_task', 'POST /jarvis/stop': 'app_control:manager.stop',
  'GET /tools/list': 'app_info:tools.list', 'POST /tools/run': 'EXCLUDE: free code (see tools:run)',
  'GET /voice/status': 'app_info:voice.status', 'POST /voice/settings': 'app_control:voice.configure', 'POST /voice/speak': 'app_control:voice.speak', 'POST /voice/listen': 'app_control:voice.listen',
  'GET /image/status': 'image_generator_status', 'POST /image/settings': 'app_control:image.configure', 'POST /image/generate': 'generate_image',
  'GET /image/backend': 'image_generator_status', 'GET /image/locks': 'character_locks', 'POST /image/request': 'generate_image',
  'GET /video/backend': 'video_call:video.status', 'POST /video/request': 'video_call:video.generate', 'GET /events': 'EXCLUDE: event stream for external programs (Alfred has the watcher)',
};
// akowe-bridge.js — Akọwe's own channel INTO AutoInjector (Akọwe → the AI panes): not a user control.
const AKOWE_BRIDGE_ROUTES = {
  '/v1/pair': 'EXCLUDE: pairing handshake (secrets)', '/v1/status': 'EXCLUDE: Akọwe pushes its status (Alfred reads Akọwe directly: book_status)',
  '/v1/probe': 'run_checkin', '/v1/health': 'ai_health', '/v1/complete': 'EXCLUDE: Akọwe\'s own prompts to the AIs (Alfred uses send_to_ai / the book tools)',
};
// The 🎨 Images module (sd-api.js): every method through sd_call (new methods appear automatically).
const SD_API_METHODS = ['images.status', 'images.generate', 'images.progress', 'images.cancel', 'images.gallery', 'images.test', 'images.fixAndRetry', 'sd.status', 'sd.detect', 'sd.connect',
  'sd.targets', 'sd.start', 'sd.stop', 'sd.install.check', 'sd.install.install', 'sd.install.downloadModel', 'sd.install.cancel', 'library.find', 'library.get',
  'library.characterLock', 'library.locks', 'library.scan',
  'images.img2img', 'images.inpaint', 'images.upscale', 'sd.lists', 'sd.options.get', 'sd.options.set', 'sd.options.schema', 'sd.controlnet.models', 'sd.controlnet.modules', 'sd.adetailer.models', 'sd.styles', 'sd.scripts', 'sd.embeddings', 'sd.upscalers', 'sd.extraFields', 'sd.interrupt', 'sd.skip', 'sd.refresh', 'sd.memory', 'sd.workflows.list', 'sd.workflows.get', 'sd.workflows.save', 'sd.workflows.delete', 'sd.workflows.run', 'sd.comfy.objectInfo', 'sd.comfy.queue', 'sd.comfy.upload', 'sd.comfy.free',
  'images.chatgptStatus', 'images.chatgptCancel', 'images.chatgptSettings'];
// The 🎬 Video module (video-api.js): every method through video_call.
const VIDEO_API_METHODS = ['video.status', 'video.capabilities', 'video.models', 'video.progress', 'video.gallery', 'video.cancel', 'video.generate', 'video.animate', 'video.test', 'video.settings',
  'video.install.check', 'video.install.downloadModel', 'video.install.installAll', 'video.install.cancel'];
// The 📖 Akọwe API Alfred uses (method + path pattern) → the tool that calls it.
const AKOWE_API_USED = {
  'GET /api/projects': 'book_status, list_books', 'GET /api/autobook': 'book_status, pause_run/resume_run/cancel_run', 'GET /api/slots/states': 'book_status',
  'GET /api/projects/:pid/branches/main/book': 'book_status, rewrite_chapter', 'GET /api/projects/:pid/branches/main/journal?problems=1': 'book_status',
  'POST /api/autobook': 'start_book', 'POST /api/autobook/:run/:verb': 'pause_run, resume_run, cancel_run', 'PUT /api/projects/:pid/profile': 'edit_profile',
  'GET /api/projects/:pid/branches/main/review/characters': 'edit_character', 'PUT /api/projects/:pid/branches/main/review/characters/:rid': 'edit_character',
  'GET /api/projects/:pid/branches/main/review/world': 'add_story_rule, add_world_detail', 'PUT /api/projects/:pid/branches/main/review/world/rules': 'add_story_rule',
  'PUT /api/projects/:pid/branches/main/review/world/texture': 'add_world_detail', 'POST /api/projects/:pid/branches/main/review/fix': 'rewrite_chapter',
  'POST /api/projects/:pid/branches/main/report': 'make_book_report', 'POST /api/projects/:pid/branches/main/save': 'save_book',
  'POST /api/projects/:pid/branches/main/journal/note': '(every book action → the journal)',
  'GET /api/projects/:pid/branches/main/forge/:kind': 'character_dossier (list) and every forge tool (find the character)',
  'GET /api/projects/:pid/branches/main/forge/:kind/:rid': 'character_dossier, edit_dossier',
  'PUT /api/projects/:pid/branches/main/forge/:kind/:rid': 'edit_dossier',
  'POST /api/projects/:pid/branches/main/forge/:kind/:rid/forge': 'forge_character',
  'POST /api/projects/:pid/branches/main/forge/:kind/:rid/approve': 'approve_dossier',
  'POST /api/projects/:pid/branches/main/forge/:kind/:rid/art': 'make_character_art',
  'POST /api/projects/:pid/branches/main/forge/:kind': 'create_dossier',
  'POST /api/projects/:pid/branches/main/forge/:kind/:rid/check': 'check_dossier (run)',
  'GET /api/projects/:pid/branches/main/forge/:kind/:rid/check': 'check_dossier (results)',
  'PUT /api/projects/:pid/branches/main/forge/:kind/:rid/check/:finding': 'check_dossier (verdict)',
  'GET /api/projects/:pid/branches/main/pictures': 'book_pictures, illustrate',
  'GET /api/projects/:pid/branches/main/cover': 'book_cover',
  'PUT /api/projects/:pid/branches/main/cover': 'design_cover, make_cover_art (lock / note)',
  'POST /api/projects/:pid/branches/main/cover/art': 'make_cover_art',
  'PUT /api/projects/:pid/branches/main/pictures/style': 'set_art_style',
  'POST /api/projects/:pid/branches/main/pictures/illustrate-all': 'illustrate (all)',
  'POST /api/projects/:pid/branches/main/pictures/illustrate': 'illustrate',
  'DELETE /api/projects/:pid/branches/main/pictures/:pic': 'edit_picture (remove)',
  'PUT /api/projects/:pid/branches/main/pictures/:pic': 'edit_picture',
  'POST /api/projects/:pid/branches/main/pictures/map': 'book_map',
};
const MENU_ITEMS = {
  'Setup Wizard': 'app_control:wizard.open', 'Relay Trace report (where every message went)': 'app_control:ledger.trace_save', 'Reset Relay Trace': 'app_control:ledger.trace_reset',
  'Run relay check (Bucket Brigade, ~23 messages)…': 'app_control:brigade.run', 'Stop relay check': 'app_control:brigade.stop',
  'Open Content Folder ("stuff and thing")': 'app_control:models.open', 'User Guide': 'EXCLUDE: opens the online guide (window chrome)',
  'Under Construction / Status': 'EXCLUDE: opens the online status page (window chrome)', 'About AutoInjector': 'EXCLUDE: about box (window chrome)',
};
const TABS = { 'tab-app-main': 'app_info:ui.show_tab', 'tab-app-akowe': 'open_akowe_page / app_info:ui.show_tab', 'tab-app-images': 'app_info:ui.show_tab', 'tab-app-video': 'app_info:ui.show_tab' };

// =====================================================================================================
// scanning the sources
// =====================================================================================================
function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
function scanIpc() {
  const set = new Set();
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.js'))) for (const m of read(f).matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)) set.add(m[1]);
  return set;
}
function sameSet(name, scanned, listed) {
  const a = [...scanned].filter((x) => !listed.has(x)); const b = [...listed].filter((x) => !scanned.has(x));
  assert(!a.length, `${name}: everything in the code is in the inventory${a.length ? ` — NEW, classify: ${a.join(', ')}` : ''}`);
  assert(!b.length, `${name}: nothing in the inventory is gone from the code${b.length ? ` — gone: ${b.join(', ')}` : ''}`);
}
function toolOf(ref) { // 'app_control:routing.set' | 'sd_call:images.generate' | 'generate_image'
  const [tool, sub] = String(ref).split(':');
  if (!registry.get(tool)) return null;
  if (tool === 'app_control' || tool === 'app_info') { const e = appActions.get(sub); return e && (e.changes === (tool === 'app_control')) ? `${tool}:${sub}` : null; }
  if (tool === 'sd_call') return SD_API_METHODS.includes(sub) ? ref : null;
  if (tool === 'video_call') return VIDEO_API_METHODS.includes(sub) ? ref : null;
  return tool;
}

const rows = []; // the coverage table
const tested = new Map(); // key -> how
function mark(key, how) { tested.set(key, tested.has(key) ? `${tested.get(key)}, ${how}` : how); }

async function main() {
  console.log('\n== 1. inventory = what the code has ==');
  sameSet('IPC channels', scanIpc(), new Set(IPC_INVENTORY));
  const pre = read('preload.js');
  sameSet('preload events', new Set([...pre.matchAll(/ipcRenderer\.on\(\s*['"]([^'"]+)/g)].map((m) => m[1])), new Set(Object.keys(EVENTS)));
  assert([...pre.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)/g)].every((m) => IPC_INVENTORY.includes(m[1])), 'every window API call (preload) is an inventoried IPC channel');
  sameSet('butler decision actions', new Set(require('../manager-provider').MANAGER_ACTIONS), new Set(Object.keys(MANAGER_ACTIONS_MAP)));
  sameSet('service-bridge routes', new Set([...read('service-bridge.js').matchAll(/method === '([A-Z]+)' && path === '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`)), new Set(Object.keys(SERVICE_BRIDGE_ROUTES)));
  sameSet('Akọwe-bridge routes', new Set([...read('akowe-bridge.js').matchAll(/url === '(\/v1\/[^']+)'/g)].map((m) => m[1])), new Set(Object.keys(AKOWE_BRIDGE_ROUTES)));
  const sdApi = require('../sd-api');
  const shape = sdApi.createImagesApi({ studio: {}, library: {}, runner: () => ({}), installer: () => ({}) });
  sameSet('🎬 Video module (video-api) methods', new Set(require('../video-api').operationNames().filter((n) => n !== 'capabilities' && n !== 'call')), new Set(VIDEO_API_METHODS));
  assert(require('../video-api').OPS.every((o) => typeof o.changes === 'boolean' && o.params && o.params.type === 'object'), '🎬 every video-api operation has a JSON schema and a changes flag');
  sameSet('🎨 Images module (sd-api) methods', new Set(alfredMain.sdMethodsOf ? (await alfredMain.sdMethodsOf(shape)).map((m) => m.method) : []), new Set(SD_API_METHODS));
  const akoweUsed = new Set();
  for (const m of read('alfred-tools.js').matchAll(/ctx\.akowe\('([A-Z]+)', `([^`]+)`/g)) akoweUsed.add(`${m[1]} ${m[2].replace(/\$\{enc\(b\.pid\)\}/g, ':pid').replace(/\$\{enc\(rr\.runId\)\}\/\$\{verb\}/g, ':run/:verb').replace(/\$\{base\}\/\$\{enc\(c\.record_id\)\}/, '/api/projects/:pid/branches/main/review/characters/:rid').replace(/\$\{enc\(r\.pid\)\}/g, ':pid').replace(/\$\{enc\(r\.d\.record_id\)\}/g, ':rid').replace(/\$\{enc\(b\.pid\)\}/g, ':pid').replace(/\$\{base\}\//, '/api/projects/:pid/branches/main/pictures/').replace(/\$\{url\}/, '/api/projects/:pid/branches/main/pictures/:pic').replace(/\$\{(r\.kp|kp|a\.kind)\}/g, ':kind').replace(/\$\{enc\(a\.finding_id\)\}/g, ':finding')}`);
  for (const m of read('alfred-tools.js').matchAll(/ctx\.akowe\('([A-Z]+)', '([^']+)'/g)) akoweUsed.add(`${m[1]} ${m[2]}`);
  akoweUsed.add('GET /api/projects/:pid/branches/main/review/characters'); // via const base
  akoweUsed.add('POST /api/projects/:pid/branches/main/journal/note'); // alfred-main.js journal()
  if (/ctx\.akowe\('DELETE', url\)/.test(read('alfred-tools.js'))) akoweUsed.add('DELETE /api/projects/:pid/branches/main/pictures/:pic'); // edit_picture (via const url)
  if (/ctx\.akowe\('PUT', url, body\)/.test(read('alfred-tools.js'))) akoweUsed.add('PUT /api/projects/:pid/branches/main/pictures/:pic');
  const akoweUsedClean = new Set([...akoweUsed].filter((x) => !x.includes('${')));
  sameSet('📖 Akọwe API Alfred uses', akoweUsedClean, new Set(Object.keys(AKOWE_API_USED)));
  const menuSrc = read('main.js').slice(read('main.js').indexOf('function buildAppMenu'));
  sameSet('menu items', new Set([...menuSrc.slice(0, 4000).matchAll(/label: "((?:[^"\\]|\\.)+)", click:/g)].map((m) => m[1].replace(/\\"/g, '"'))), new Set(Object.keys(MENU_ITEMS)));
  sameSet('tabs', new Set([...read('controls.html').matchAll(/id="(tab-app-[a-z]+)"/g)].map((m) => m[1])), new Set(Object.keys(TABS)));

  console.log('\n== 2. every capability is mapped to an Alfred tool or excluded with a reason ==');
  const actionChannels = new Set(appActions.ACTIONS.map((a) => a.channel).filter(Boolean));
  const unclassified = IPC_INVENTORY.filter((c) => !c.startsWith('alfred:') && !actionChannels.has(c) && !appActions.TOOL_CHANNELS[c] && !appActions.EXCLUDED[c]);
  assert(!unclassified.length, `every IPC channel is classified${unclassified.length ? ` — UNCLASSIFIED: ${unclassified.join(', ')}` : ''}`);
  const both = Object.keys(appActions.EXCLUDED).filter((c) => actionChannels.has(c) || appActions.TOOL_CHANNELS[c]);
  assert(!both.length, `nothing is both mapped and excluded${both.length ? `: ${both.join(', ')}` : ''}`);
  assert(Object.values(appActions.EXCLUDED).every((r) => typeof r === 'string' && r.length > 10), 'every exclusion has a reason');
  const badTool = Object.entries(appActions.TOOL_CHANNELS).filter(([, t]) => !toolOf(t));
  assert(!badTool.length, `every channel's tool exists${badTool.length ? `: ${badTool.map((x) => x.join('→')).join(', ')}` : ''}`);
  for (const [name, map] of [['butler actions', MANAGER_ACTIONS_MAP], ['service-bridge', SERVICE_BRIDGE_ROUTES], ['Akọwe bridge', AKOWE_BRIDGE_ROUTES], ['menu', MENU_ITEMS]]) {
    const bad = Object.entries(map).filter(([, v]) => !/^EXCLUDE: .{10,}/.test(v) && !toolOf(v));
    assert(!bad.length, `${name}: every entry maps to a real tool/action or a justified exclusion${bad.length ? ` — ${bad.map((x) => x.join('→')).join(', ')}` : ''}`);
  }
  assert(Object.keys(EVENTS).every((k) => EVENTS[k]), 'every live event is classified');
  assert(appActions.ACTIONS.every((a) => a.title && a.args && a.example && (a.channel || a.local)), 'every app action has a title, a schema, an example and a channel');
  assert(appActions.ACTIONS.every((a) => !registry.validate({ args: appActions.schemaOf(a) }, a.example).error), 'every app action\'s example passes its own schema');

  // =====================================================================================================
  // 3a. every app action, driven through Alfred to its channel (fake LLM → card → ✔ Do it → IPC)
  // =====================================================================================================
  console.log('\n== 3a. every app action: fake LLM tool call → (card → ✔ Do it) → the right IPC call ==');
  {
    const q = [];
    const llm = await fakeLlm((body) => (lastMsg(body).role === 'tool' ? { content: `RESULT ${lastMsg(body).content}` } : q.shift() || { content: 'idle' }));
    const invoked = [];
    const file = path.join(TMP, 'alfred-a.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: true, brain: 'local', local: { endpoint: llm.base, model: 'fake' } }));
    const a = createAlfred({ settingsFile: file, noTimers: true, ctx: { invoke: async (ch, ...args) => { invoked.push({ ch, args }); return { ok: true }; }, local: async (w, x) => { invoked.push({ ch: `local:${w}`, args: [x] }); return { ok: true }; } } });
    let okAll = 0;
    for (const e of appActions.ACTIONS) {
      invoked.length = 0;
      q.push(toolCall(e.changes ? 'app_control' : 'app_info', { action: e.id, args: e.example }));
      let r = await a.ask(`do ${e.id}`);
      const carded = r.type === 'confirm';
      if (carded) r = await a.confirm(r.card.id);
      const want = e.local ? { ch: `local:${e.local}`, args: [e.example] } : { ch: e.channel, args: e.call(e.example) };
      const good = carded === e.changes && invoked.length === 1 && invoked[0].ch === want.ch && JSON.stringify(invoked[0].args) === JSON.stringify(want.args) && /RESULT/.test(r.text || '');
      if (good) { okAll++; mark(`app:${e.id}`, 'fake-LLM→IPC'); } else console.log(`      ! ${e.id}: carded=${carded} invoked=${JSON.stringify(invoked)}`);
    }
    assert(okAll === appActions.ACTIONS.length, `all ${appActions.ACTIONS.length} app actions reach their channel with the right arguments; the ${appActions.ACTIONS.filter((x) => x.changes).length} that change something only after ✔ Do it (${okAll} ok)`);
    q.push(toolCall('app_control', { action: 'routing.set', args: { source: 'claude', target: 'bing', enabled: true } }));
    await a.ask('bad');
    assert(!invoked.length || invoked[invoked.length - 1].args[0].target !== 'bing', 'an app action with bad arguments is refused before anything runs');
    q.push(toolCall('app_control', { action: 'state.get', args: {} }));
    const r2 = await a.ask('read via control');
    assert(r2.type === 'reply' && /no app_control action/.test(llm.requests[llm.requests.length - 1].body.messages.slice(-1)[0].content), 'a read action asked through app_control (or an unknown action) is refused');
    q.push(toolCall('app_control', { action: 'phone.set_lan', args: { enabled: true } }));
    await a.ask('open my app to the LAN');
    assert(!invoked.some((x) => x.ch === 'phone:set-lan'), 'excluded controls cannot be reached (phone LAN switch)');
    await llm.close();
  }

  // =====================================================================================================
  // 3b. the REAL app (main.js under mock Electron): real handlers, real sd-api, fake panes / Forge / ComfyUI
  // =====================================================================================================
  console.log('\n== 3b. the real app: Alfred through his own IPC, every tool end to end ==');
  process.env.AUTOINJECTOR_AKOWE_PORT = String(await freePort());
  require('../main.js');
  await sleep(300);
  const outputManager = require('../output-manager');
  const CONTENT = path.join(TMP, 'content');
  outputManager.init(CONTENT);
  const H = mock.__ipcHandlers;
  const call = (ch, payload) => H[ch]({}, payload);
  const captured = alfredMain.ipcHandlers;
  const missing = [...new Set([...appActions.ACTIONS.map((x) => x.channel).filter(Boolean), ...Object.keys(appActions.TOOL_CHANNELS)])].filter((c) => !captured.has(c));
  assert(!missing.length, `Alfred captured the real handler of every mapped channel in main.js (${captured.size} handlers)${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);

  const forge = await fakeA1111({ flavor: 'forge', loraFile: path.join(MODELS, 'Lora', 'odile_face.safetensors') });
  const comfy = await fakeComfy({});
  const q = [];
  const llm = await fakeLlm((body) => (lastMsg(body).role === 'tool' ? { content: `RESULT ${lastMsg(body).content}` } : q.shift() || { content: 'idle' }));
  await call('alfred:set-enabled', { on: true });
  await call('alfred:settings', { brain: 'local', local: { endpoint: llm.base, model: 'fake-model' }, maxSteps: 4, interpreter: true, notices: false });
  /** drive one tool: returns { carded, text, result } (result = the tool's JSON as the AI saw it) */
  async function drive(tool, args, { confirm = true } = {}) {
    q.push(toolCall(tool, args));
    let r = await call('alfred:ask', { text: `use ${tool}` });
    const carded = r && r.type === 'confirm';
    const card = carded ? r.card : null;
    if (carded && confirm) r = await call('alfred:confirm', { id: card.id });
    const text = (r && r.text) || '';
    let result = null; try { result = JSON.parse(text.replace(/^RESULT /, '')); } catch (_) { result = null; }
    return { carded, card, text, result, r };
  }
  const T = {}; // tool -> ok?
  function check(tool, cond, msg, how = 'real app') { if (assert(cond, `${tool}: ${msg}`)) { T[tool] = T[tool] || how; mark(`tool:${tool}`, how); } else T[tool] = false; }

  // ---- 🎨 images through the real sd-api against a fake Forge -------------------------------------------
  let d = await drive('sd_call', { method: 'sd.connect', args: { url: forge.base } });
  check('sd_call', d.carded && d.result && d.result.ok, `connect asks first, then connects the real Images module to a fake Forge (${d.result && d.result.message})`);
  mark('sd:sd.connect', 'real sd-api + fake Forge');
  d = await drive('image_generator_status', {});
  check('image_generator_status', !d.carded && d.result && d.result.data && d.result.data.connected && /Forge/i.test(JSON.stringify(d.result.data)), 'reads the connection (Forge) without a card');
  d = await drive('generate_image', { prompt: 'a lighthouse at dusk', width: 640, height: 512, loras: [{ name: 'odile_face', weight: 0.7 }] });
  const png = d.result && d.result.data && d.result.data.path;
  check('generate_image', d.carded && !!forge.state.lastTxt2img && /a lighthouse at dusk/.test(forge.state.lastTxt2img.prompt) && /<lora:odile_face:0\.7>/.test(forge.state.lastTxt2img.prompt) && forge.state.lastTxt2img.width === 640 && png && fs.existsSync(png), 'card → ✔ → txt2img on Forge (prompt, LoRA, size) → PNG saved');
  d = await drive('sd_call', { method: 'images.generate', args: { prompt: 'harbor at night', steps: 33, cfgScale: 5.5, sampler: 'DPM++ 2M', seed: 42, count: 2 } });
  check('sd_call', d.carded && forge.state.lastTxt2img.steps === 33 && forge.state.lastTxt2img.cfg_scale === 5.5 && forge.state.lastTxt2img.sampler_name === 'DPM++ 2M' && forge.state.lastTxt2img.seed === 42 && d.result && d.result.ok, 'images.generate sets the generation fields (steps, CFG, sampler, seed, count) on Forge');
  mark('sd:images.generate', 'real sd-api + fake Forge');
  // full controls: hires fix (structured) + a settings-menu option for this picture + a raw A1111 field
  d = await drive('sd_call', { method: 'images.generate', args: { prompt: 'x y', hires: { scale: 2, upscaler: 'R-ESRGAN 4x+', denoise: 0.4 }, overrideSettings: { CLIP_stop_at_last_layers: 2 }, extra: { s_noise: 1.01 } } });
  const lt = forge.state.lastTxt2img;
  check('sd_call', d.carded && d.result && d.result.ok && lt.prompt === 'x y' && lt.enable_hr === true && lt.hr_scale === 2 && lt.hr_upscaler === 'R-ESRGAN 4x+' && lt.override_settings && lt.override_settings.CLIP_stop_at_last_layers === 2 && lt.s_noise === 1.01,
    'full controls: hires fix + per-picture setting override + raw A1111 field all reach Forge');
  d = await drive('sd_call', { method: 'images.generate', args: { prompt: 'z', extra: { no_such_field_xyz: 1 } } });
  assert(!(d.result && d.result.ok) && forge.state.lastTxt2img.prompt !== 'z', 'a raw field Forge does not have is refused before anything is sent');
  d = await drive('sd_call', { method: 'sd.options.get', args: {} });
  if (assert(!d.carded && d.result && d.result.ok !== false && JSON.stringify(d.result).includes('CLIP_stop_at_last_layers'), 'sd.options.get: reads every settings-menu option without a card')) mark('sd:sd.options.get', 'real sd-api + fake Forge');
  d = await drive('sd_call', { method: 'sd.options.set', args: { options: { jpeg_quality: 95 } } });
  if (assert(d.carded && forge.state.options.jpeg_quality === 95, 'sd.options.set: asks first, then changes a settings-menu option on Forge')) mark('sd:sd.options.set', 'real sd-api + fake Forge');
  d = await drive('sd_call', { method: 'images.upscale', args: { image: png, factor: 2, upscaler: 'R-ESRGAN 4x+' } });
  if (assert(d.carded && !!forge.state.lastExtras, 'images.upscale: asks first, then upscales the picture on Forge (Extras)')) mark('sd:images.upscale', 'real sd-api + fake Forge');
  // the one-click fix a failed picture offers (VAE → Automatic, also in Forge's own settings) + one retry
  d = await drive('sd_call', { method: 'images.fixAndRetry', args: { fix: 'vae-automatic', request: { prompt: 'retry the lighthouse' } } });
  if (assert(d.carded && d.result && d.result.ok && forge.state.options.sd_vae === 'Automatic' && /retry the lighthouse/.test(forge.state.lastTxt2img.prompt), 'images.fixAndRetry: asks first, then sets VAE → Automatic on Forge and makes the picture again')) mark('sd:images.fixAndRetry', 'real sd-api + fake Forge');
  for (const m of ['images.status', 'images.progress', 'images.gallery', 'sd.status', 'sd.targets', 'sd.detect', 'sd.install.check', 'library.locks']) {
    d = await drive('sd_call', { method: m, args: m === 'images.gallery' ? { limit: 5 } : {} });
    if (assert(!d.carded && d.result && d.result.ok !== false && d.result.data !== undefined, `sd_call ${m}: read-only, runs directly against the real module`)) mark(`sd:${m}`, 'real sd-api');
  }
  d = await drive('sd_call', { method: 'library.scan', args: {} });
  if (assert(d.carded && d.result && d.result.ok, 'sd_call library.scan: asks, then scans the model folders')) mark('sd:library.scan', 'real sd-api');
  d = await drive('find_models', { query: 'odile', kind: 'lora' });
  check('find_models', !d.carded && /odile_face/.test(JSON.stringify(d.result && d.result.data)), 'finds the synthetic LoRA in the library');
  for (const [m, args] of [['library.find', { query: 'dream' }], ['library.get', { id: 'lora:odile_face' }]]) {
    d = await drive('sd_call', { method: m, args });
    if (assert(!d.carded && d.result && d.result.ok !== false, `sd_call ${m}: runs directly`)) mark(`sd:${m}`, 'real sd-api');
  }
  d = await drive('app_control', { action: 'sdlib.save_lock', args: { lock: { character: 'Odile', loras: [{ name: 'odile_face', weight: 0.8 }], triggerWords: ['odile woman'], prompt: 'red hair, green coat' } } });
  assert(d.carded && d.result && d.result.ok, 'app_control sdlib.save_lock: card → saves a character lock (real handler)'); mark('app:sdlib.save_lock', 'real handler');
  d = await drive('character_locks', { name: 'Odile' });
  check('character_locks', !d.carded && /odile_face:0.8/.test(JSON.stringify(d.result)), 'shows the saved lock');
  d = await drive('sd_call', { method: 'library.characterLock', args: { name: 'Odile' } });
  if (assert(!d.carded && /Odile/.test(d.text), 'sd_call library.characterLock: runs directly')) mark('sd:library.characterLock', 'real sd-api');
  d = await drive('generate_image', { prompt: 'at the quay', character: 'Odile' });
  check('generate_image', d.carded && /odile woman/.test(forge.state.lastTxt2img.prompt) && /red hair/.test(forge.state.lastTxt2img.prompt), 'a character name uses the saved character lock (trigger words + look)');

  // ---- 🎨 the second engine: ChatGPT's own image generation, against a fake ChatGPT image page in the mock pane ----
  {
    const { fakeChatGptPane } = require('./fixtures/fake-chatgpt-image');
    const cgPane = fakeChatGptPane({ mode: 'ok', delayMs: 150 });
    const wc = mock.__registry.chatgpt.webContents;
    const prevHook = wc.onSendAttempt;
    wc.chatImagePage = (script) => cgPane.run(script);
    wc.onSendAttempt = (text, fail) => { if (!fail) cgPane.send(text); if (typeof prevHook === 'function') prevHook(text, fail); };
    const sentText = () => cgPane.state.sends.map((x) => x.text).join('\n');
    d = await drive('sd_call', { method: 'images.chatgptStatus', args: {} });
    if (assert(!d.carded && d.result && d.result.data && d.result.data.ready === true && d.result.data.busy === false, 'sd_call images.chatgptStatus: read-only, runs directly — the ChatGPT pane is ready')) mark('sd:images.chatgptStatus', 'real sd-api + fake ChatGPT page');
    d = await drive('image_generator_status', {});
    check('image_generator_status', !d.carded && d.result && d.result.data && d.result.data.chatgpt && d.result.data.chatgpt.ready === true, 'also says whether ChatGPT can make pictures');
    const sdBefore = forge.state.lastTxt2img;
    d = await drive('sd_call', { method: 'images.generate', args: { prompt: 'a lighthouse keeper', engine: 'chatgpt' } });
    const p1 = d.result && d.result.data && d.result.data.paths && d.result.data.paths[0];
    if (assert(d.carded && d.result && d.result.ok && d.result.data.engine === 'chatgpt' && /Create an image: a lighthouse keeper/.test(sentText()) && forge.state.lastTxt2img === sdBefore && p1 && fs.existsSync(p1) && /^chatgpt-/.test(path.basename(p1)),
      `sd_call images.generate {engine:"chatgpt"}: asks first, types the request into the ChatGPT pane, saves the picture (${p1 ? path.basename(p1) : d.text.slice(0, 120)}) — Forge untouched`)) mark('sd:images.generate', 'real sd-api + fake ChatGPT page (engine chatgpt)');
    d = await drive('sd_call', { method: 'images.generate', args: { purpose: 'view', view: 'side', characterLock: 'Odile', engine: 'chatgpt' } });
    assert(d.carded && d.result && d.result.ok && d.result.data.view === 'side' && d.result.data.engine === 'chatgpt' && /Create an image: Odile[^\n]*Framing: full body, head to toe, standing, seen exactly from the side \(profile\)/.test(sentText()),
      'sd_call images.generate {purpose:"view", view:"side", characterLock} → the side framing is typed into ChatGPT, view echoed');
    d = await drive('generate_image', { character: 'Odile', purpose: 'sheet', engine: 'chatgpt' });
    check('generate_image', d.carded && d.result && d.result.ok && d.result.data.engine === 'chatgpt' && /Create one wide image: character turnaround sheet/.test(sentText()) && fs.existsSync(d.result.data.path),
      'purpose "sheet" with engine "chatgpt": one wide turnaround sheet from the ChatGPT pane, saved');
    d = await drive('generate_image', { purpose: 'view', view: 'dash', appearance: 'a wiry courier in a yellow rain cape', engine: 'chatgpt' });
    check('generate_image', d.carded && d.result && d.result.ok && d.result.data.view === 'dash' && /a wiry courier in a yellow rain cape/.test(sentText()), 'a reference view from a typed appearance (no lock)');
    const tr = ((await call('state:get')).transcript || []).filter((t) => t.site === 'chatgpt').map((t) => t.text).join(' ');
    assert(!/Creating image/.test(tr), 'the image jobs\' replies are held: nothing of them reaches the conversation or the relay');
    const ipc = await call('sd:request', { prompt: 'a red door', engine: 'chatgpt', purpose: 'illustration' });
    assert(ipc && ipc.ok && ipc.engine === 'chatgpt' && /Create a wide image: a red door/.test(sentText()), 'the Images tab\'s sd:request (engine ChatGPT) takes the same path');
    d = await drive('sd_call', { method: 'images.chatgptSettings', args: { freshChatPerSeries: true } });
    if (assert(d.carded && d.result && d.result.ok && d.result.data.freshChatPerSeries === true && (await call('sd:chatgpt-status')).freshChatPerSeries === true, 'sd_call images.chatgptSettings: asks first, then "a fresh ChatGPT chat per series" is on')) mark('sd:images.chatgptSettings', 'real sd-api');
    await call('sd:chatgpt-settings', { freshChatPerSeries: false });
    d = await drive('sd_call', { method: 'images.chatgptCancel', args: {} });
    if (assert(d.carded && d.result && d.result.ok !== false, 'sd_call images.chatgptCancel: asks first, then stops (nothing running here)')) mark('sd:images.chatgptCancel', 'real sd-api');
    cgPane.state.mode = 'refuse';
    d = await drive('sd_call', { method: 'images.generate', args: { prompt: 'something it will not draw', engine: 'chatgpt' } });
    assert(d.carded && /IMAGE_REFUSED/.test(d.text) && /declined/.test(d.text), 'a ChatGPT refusal reaches Alfred as IMAGE_REFUSED in plain words');
    wc.onSendAttempt = prevHook; delete wc.chatImagePage;
  }
  d = await drive('list_images', { limit: 5 });
  check('list_images', !d.carded && Array.isArray(d.result && d.result.data) && d.result.data.length >= 1, 'lists the saved pictures');
  d = await drive('start_image_generator', {});
  check('start_image_generator', d.carded && /NO_TARGET|No Stable Diffusion app/i.test(d.text), 'asks, then calls sd-api sd.start (here: no app to start → a plain message)');
  d = await drive('stop_image_generator', {});
  check('stop_image_generator', d.carded && d.result && d.result.ok, 'asks, then calls sd-api sd.stop');
  for (const [m, args] of [['sd.start', {}], ['sd.stop', {}], ['images.cancel', {}], ['sd.install.cancel', {}]]) {
    d = await drive('sd_call', { method: m, args });
    if (assert(d.carded, `sd_call ${m}: asks first, then reaches the real module (${(d.text || '').slice(0, 60)})`)) mark(`sd:${m}`, 'real sd-api');
  }
  for (const m of ['images.test', 'sd.install.install', 'sd.install.downloadModel']) {
    d = await drive('sd_call', { method: m, args: m === 'sd.install.downloadModel' ? { id: 'sd15' } : {} }, { confirm: false });
    if (assert(d.carded, `sd_call ${m}: shows the "I will" card (not run here: it downloads / renders for real)`)) { await call('alfred:reject', { id: d.card.id }); mark(`sd:${m}`, 'card (✖ No)'); }
  }
  // more full controls on Forge: img2img / inpaint (a picture + a mask), read-only lists, interrupt / skip / refresh
  d = await drive('sd_call', { method: 'images.img2img', args: { prompt: 'same harbor, at dawn', initImage: png, denoise: 0.45 } });
  if (assert(d.carded && forge.state.lastPath === '/sdapi/v1/img2img' && forge.state.lastTxt2img.denoising_strength === 0.45 && /dawn/.test(forge.state.lastTxt2img.prompt), 'images.img2img: asks first, then changes a picture on Forge (denoise)')) mark('sd:images.img2img', 'real sd-api + fake Forge');
  d = await drive('sd_call', { method: 'images.inpaint', args: { prompt: 'a red door', initImage: png, mask: png, denoise: 0.8, inpaint: { maskBlur: 8 } } });
  if (assert(d.carded && forge.state.lastPath === '/sdapi/v1/img2img' && !!forge.state.lastTxt2img.mask && forge.state.lastTxt2img.mask_blur === 8, 'images.inpaint: asks first, then sends picture + mask + blur to Forge')) mark('sd:images.inpaint', 'real sd-api + fake Forge');
  for (const [m, args] of [['sd.lists', {}], ['sd.options.schema', {}], ['sd.controlnet.models', {}], ['sd.controlnet.modules', {}], ['sd.adetailer.models', {}], ['sd.styles', {}], ['sd.scripts', {}], ['sd.embeddings', {}], ['sd.upscalers', {}], ['sd.extraFields', { kind: 'txt2img' }], ['sd.memory', {}]]) {
    d = await drive('sd_call', { method: m, args });
    if (assert(!d.carded && /^RESULT \{"ok":true/.test(d.text), `sd_call ${m}: read-only, runs directly on Forge`)) mark(`sd:${m}`, 'real sd-api + fake Forge');
  }
  forge.state.refreshed = [];
  d = await drive('sd_call', { method: 'sd.refresh', args: { what: 'loras' } });
  if (assert(d.carded && forge.state.refreshed.includes('refresh-loras'), 'sd.refresh: asks first, then rescans the LoRA folder on Forge')) mark('sd:sd.refresh', 'real sd-api + fake Forge');
  d = await drive('sd_call', { method: 'sd.skip', args: {} });
  if (assert(forge.state.skipped === true, 'sd.skip: skips the current picture on Forge')) mark('sd:sd.skip', 'real sd-api + fake Forge');
  forge.state.interrupted = false;
  d = await drive('sd_call', { method: 'sd.interrupt', args: {} });
  if (assert(forge.state.interrupted === true, 'sd.interrupt: stops the render on Forge')) mark('sd:sd.interrupt', 'real sd-api + fake Forge');
  forge.state.interrupted = false;
  // ComfyUI: connect + generate through the same tool
  d = await drive('sd_call', { method: 'sd.connect', args: { url: comfy.base } });
  d = await drive('sd_call', { method: 'images.generate', args: { prompt: 'a ferry in fog', steps: 12, checkpoint: 'sd15/dreamshaper_8.safetensors' } });
  const g = comfy.state.lastGraph && JSON.stringify(comfy.state.lastGraph);
  assert(d.carded && g && /a ferry in fog/.test(g) && /"steps":12/.test(g), 'sd_call images.generate on a fake ComfyUI: the built-in graph carries the prompt and steps');
  {
    // ComfyUI: any workflow with named params, node types, queue, upload, free VRAM
    const WF = {
      3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
      4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd15/dreamshaper_8.safetensors' } },
      5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
      6: { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
      7: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
      8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
    };
    d = await drive('sd_call', { method: 'sd.workflows.save', args: { name: 'Alfred wf', workflow: WF } });
    const wfId = d.result && d.result.data && d.result.data.workflow && d.result.data.workflow.id;
    if (assert(d.carded && !!wfId, `sd.workflows.save: asks first, then saves a ComfyUI workflow (${wfId})`)) mark('sd:sd.workflows.save', 'real sd-api + fake ComfyUI');
    d = await drive('sd_call', { method: 'sd.workflows.list', args: {} });
    if (assert(!d.carded && JSON.stringify(d.result).includes(String(wfId)), 'sd.workflows.list: lists it without a card')) mark('sd:sd.workflows.list', 'real sd-api');
    d = await drive('sd_call', { method: 'sd.workflows.get', args: { id: wfId } });
    if (assert(!d.carded && d.result && d.result.ok !== false && JSON.stringify(d.result).includes('KSampler'), 'sd.workflows.get: reads it back')) mark('sd:sd.workflows.get', 'real sd-api');
    d = await drive('sd_call', { method: 'sd.workflows.run', args: { id: wfId, params: { prompt: 'a lighthouse keeper', steps: 9 } } });
    const wg = JSON.stringify(comfy.state.lastGraph || {});
    if (assert(d.carded && /a lighthouse keeper/.test(wg) && /"steps":9/.test(wg), 'sd.workflows.run: asks first, then runs the saved workflow with named params on ComfyUI')) mark('sd:sd.workflows.run', 'real sd-api + fake ComfyUI');
    d = await drive('sd_call', { method: 'sd.workflows.delete', args: { id: wfId } });
    if (assert(d.carded && d.result && d.result.ok !== false, 'sd.workflows.delete: asks first, then deletes it')) mark('sd:sd.workflows.delete', 'real sd-api');
    for (const m of ['sd.comfy.objectInfo', 'sd.comfy.queue']) {
      d = await drive('sd_call', { method: m, args: {} });
      if (assert(!d.carded && d.result && d.result.ok !== false, `sd_call ${m}: read-only, runs directly on ComfyUI`)) mark(`sd:${m}`, 'real sd-api + fake ComfyUI');
    }
    d = await drive('sd_call', { method: 'sd.comfy.upload', args: { image: png, name: 'alfred.png' } });
    if (assert(d.carded && comfy.state.uploads.length > 0, 'sd.comfy.upload: asks first, then uploads a picture to ComfyUI')) mark('sd:sd.comfy.upload', 'real sd-api + fake ComfyUI');
    d = await drive('sd_call', { method: 'sd.comfy.free', args: {} });
    if (assert(comfy.state.freed !== null, 'sd.comfy.free: frees VRAM on ComfyUI')) mark('sd:sd.comfy.free', 'real sd-api + fake ComfyUI');
  }
  d = await drive('sd_call', { method: 'nope.method', args: {} });
  assert(!d.carded && /has no method/.test(JSON.stringify(llm.requests.slice(-1)[0].body.messages.slice(-1))), 'sd_call refuses a method the module does not have');
  {
    // a method the module gains later appears automatically (asks first because it is unknown)
    const api = require('../sd-api').get();
    if (typeof api.call !== 'function') {
      api.images.alfredProbe = async (o) => ({ ok: true, probed: o && o.factor });
      d = await drive('sd_call', { method: 'images.alfredProbe', args: { factor: 2 } });
      assert(d.carded && /probed/.test(d.text), 'a NEW Images-module method is usable at once (unknown → asks first)');
      delete api.images.alfredProbe;
    } else {
      const ms = await alfredMain.sdMethodsOf(api);
      assert(ms.length >= SD_API_METHODS.length, `the module's own capability list feeds sd_call (${ms.length} methods)`);
    }
  }

  // ---- 🎬 video ------------------------------------------------------------------------------------------
  // 🎬 video through the REAL video-api + video-studio against the fake ComfyUI (Wan nodes + models)
  d = await drive('video_status', {});
  check('video_status', !d.carded && d.result && d.result.ok && d.result.data && d.result.data.ready === true && /comfy/.test(JSON.stringify(d.result.data)), 'reads the 🎬 Video module without a card (ComfyUI + Wan ready)', 'real video-api + fake ComfyUI');
  const vg0 = comfy.state.videoGraphs.length;
  d = await drive('generate_video', { prompt: 'waves at night', seconds: 1 });
  const vpath = d.result && d.result.data && d.result.data.path;
  check('generate_video', d.carded && comfy.state.videoGraphs.length === vg0 + 1 && /waves at night/.test(JSON.stringify(comfy.state.videoGraphs[vg0])) && vpath && fs.existsSync(vpath), 'card → ✔ → a Wan text→video graph on ComfyUI → the clip is saved', 'real video-api + fake ComfyUI');
  d = await drive('generate_video', { image: png, prompt: 'he breathes', seconds: 1 });
  check('generate_video', d.carded && comfy.state.videoGraphs.length === vg0 + 2 && /LoadImage/.test(JSON.stringify(comfy.state.videoGraphs[vg0 + 1])) && d.result.ok, 'with a picture → picture→video (the picture is uploaded and loaded)', 'real video-api + fake ComfyUI');
  // the call a small local model sent in the user's log: {character, image, prompt, seconds} → no INVALID_PARAM
  d = await drive('generate_video', { character: 'Odile', image: png, prompt: 'she turns her head', seconds: 30 });
  assert(d.carded && d.result && d.result.ok && comfy.state.videoGraphs.length === vg0 + 3 && /LoadImage/.test(JSON.stringify(comfy.state.videoGraphs[vg0 + 2])) && !/odile woman/.test(JSON.stringify(comfy.state.videoGraphs[vg0 + 2])) && (d.result.notes || []).some((n) => /picture was used/.test(n)) && (d.result.notes || []).some((n) => /seconds 30 is outside 1–10/.test(n)), 'generate_video: picture + character + seconds 30 → the picture is used, seconds clamped, both noted');
  d = await drive('generate_video', { character: 'Odile', image: path.join(os.tmpdir(), 'no-such-picture-for-alfred.png'), prompt: 'she waves', seconds: '2 seconds' });
  assert(d.carded && d.result && d.result.ok && comfy.state.videoGraphs.length === vg0 + 4 && !/LoadImage/.test(JSON.stringify(comfy.state.videoGraphs[vg0 + 3])) && /odile woman/.test(JSON.stringify(comfy.state.videoGraphs[vg0 + 3])) && (d.result.notes || []).some((n) => /could not be used/.test(n)), 'generate_video: a picture path that does not exist → text→video with the character lock, noted (no INVALID_PARAM)');
  d = await drive('generate_video', { image: 'Odile', prompt: 'rain on a window', seconds: 'none' });
  assert(d.carded && d.result && d.result.ok && comfy.state.videoGraphs.length === vg0 + 5 && (d.result.notes || []).some((n) => /image “Odile” is not a picture/.test(n)), 'generate_video: an image that is no picture → dropped with a note, text→video');
  d = await drive('generate_video', { image: path.join(os.tmpdir(), 'no-such-picture-for-alfred.png') });
  assert(d.carded && d.result && d.result.ok === false && d.result.error === 'INVALID_PARAM' && /image/.test(d.result.message) && /\.png \/ \.jpg \/ \.webp/.test(d.result.message) && comfy.state.videoGraphs.length === vg0 + 5, `generate_video: only a missing picture → the error names the field and what it may be: “${d.result && d.result.message}”`);
  for (const m of ['video.status', 'video.models', 'video.progress', 'video.gallery', 'video.capabilities', 'video.install.check']) {
    d = await drive('video_call', { method: m, args: {} });
    if (assert(!d.carded && /^RESULT \{"ok":true/.test(d.text), `video_call ${m}: read-only, runs directly against the real module`)) mark(`video:${m}`, 'real video-api');
  }
  d = await drive('video_call', { method: 'video.generate', args: { prompt: 'a lighthouse', seconds: 1, steps: 7, cfgScale: 4.5, seed: 42 } });
  const vg = JSON.stringify(comfy.state.videoGraphs.slice(-1)[0] || {});
  check('video_call', d.carded && d.result && d.result.ok && /"steps":7/.test(vg) && /"cfg":4\.5/.test(vg) && /"seed":42/.test(vg), 'video.generate: every Wan setting (steps, cfg, seed) reaches ComfyUI', 'real video-api + fake ComfyUI');
  d = await drive('video_call', { method: 'video.generate', args: { prompt: 'x', seconds: 99 } });
  assert(!(d.result && d.result.ok) && !d.carded, 'video_call: an out-of-range setting is refused before anything runs');
  d = await drive('video_call', { method: 'video.install.downloadModel', args: { id: 'wan21-t2v-1.3b' } }, { confirm: false });
  if (assert(d.carded, 'video_call video.install.downloadModel: shows the "I will" card (not run here: it downloads gigabytes)')) await call('alfred:reject', { id: d.card.id });

  // ---- 💬 the AI panes (fake panes in mock Electron) -----------------------------------------------------
  const sentBefore = mock.__registry.claude.webContents.sentLog.length;
  d = await drive('send_to_ai', { to: 'claude', message: 'Please summarise chapter 1.' });
  const sent = mock.__registry.claude.webContents.sentLog.slice(sentBefore).map((x) => JSON.stringify(x)).join(' ');
  check('send_to_ai', d.carded && /summarise chapter 1/.test(sent), 'card → ✔ → typed into the Claude pane');
  mock.__registry.claude.webContents.currentText = 'Chapter 1: the keeper finds a bottle. [FROM: CLAUDE]';
  await until(async () => ((await call('state:get')).transcript || []).some((t) => t.site === 'claude' && /keeper finds a bottle/.test(t.text)), 8000);
  d = await drive('read_latest_reply', { from: 'claude' });
  check('read_latest_reply', !d.carded && /keeper finds a bottle/.test(d.text), 'reads Claude\'s captured reply');
  d = await drive('ai_health', {});
  check('ai_health', !d.carded && /chatgpt/.test(d.text) && /gemini/.test(d.text), 'reads each AI\'s self-repair state');
  d = await drive('run_checkin', { sites: ['gemini'] });
  check('run_checkin', d.carded && /Check-in started/.test(d.text), 'asks, then starts the real self-repair check-in');

  // ---- 📁 files / logs -------------------------------------------------------------------------------------
  d = await drive('list_outputs', { folder: 'images' });
  check('list_outputs', !d.carded && /\.png/.test(d.text), 'lists the images folder');
  d = await drive('open_output', { path: png });
  check('open_output', d.carded && opened.includes(path.resolve(png)), 'asks, then opens the file (shell.openPath)');
  d = await drive('open_output', { path: path.join(CONTENT, 'stuff and thing', 'evil.bat') });
  assert(d.carded && /never open programs|does not exist|OUTSIDE/.test(d.text), 'open_output never opens programs/scripts or files outside the output folders');
  d = await drive('export_logs', { scope: 'day' });
  const logFile = d.result && d.result.data && d.result.data.file;
  check('export_logs', d.carded && logFile && fs.existsSync(logFile), 'asks, then writes the log extract to the logs folder');

  // ---- 🧪 Open Interpreter (turned on for this test) ----------------------------------------------------------
  d = await drive('run_code', { language: 'python', code: 'print(sum(range(10)))', why: 'add up numbers' });
  check('run_code', d.carded && d.card.steps[0].code && d.card.steps[0].code.code === 'print(sum(range(10)))' && oiRuns.some((t) => t.includes('print(sum(range(10)))')) && /45/.test(d.text), 'shows the exact code on the card, runs exactly that after ✔');

  // ---- 🧰 app_help / app_info / app_control against REAL handlers ------------------------------------------------
  d = await drive('app_help', { prefix: 'routing.' });
  check('app_help', !d.carded && /routing.set/.test(d.text) && /Turn forwarding/.test(d.text), 'explains actions with titles and arguments');
  const SLOW_OR_EXTERNAL = new Set(['endpoints.detect']); // probes many local ports; covered in 3a
  let realReads = 0, realReadOk = 0;
  for (const e of appActions.ACTIONS.filter((x) => !x.changes)) {
    if (SLOW_OR_EXTERNAL.has(e.id)) continue;
    realReads++;
    const res = await Promise.race([drive('app_info', { action: e.id, args: e.example }), sleep(30000).then(() => ({ timeout: true }))]);
    const okReal = res && !res.timeout && !res.carded && /RESULT/.test(res.text) && !/NO_SUCH_CONTROL|CONTROL_ERROR/.test(res.text);
    if (okReal) { realReadOk++; mark(`app:${e.id}`, 'real handler'); } else console.log(`      ! real ${e.id}: ${res && (res.timeout ? 'timeout' : res.text.slice(0, 160))}`);
  }
  check('app_info', realReadOk === realReads, `all ${realReads} read-only app actions answer from the REAL handlers without a card (${realReadOk} ok)`);
  const st0 = await call('state:get');
  const REAL_CHANGES = [
    ['routing.set', { source: 'claude', target: 'gemini', enabled: true }, (s) => JSON.stringify(s).includes('gemini')],
    ['relay.hop_limit', { max: 7 }, null],
    ['roles.set', { site: 'claude', role: 'a strict editor' }, async () => JSON.stringify(await call('state:get')).includes('a strict editor')],
    ['prompts.save', { name: 'Alfred coverage prompt', text: 'Check continuity.' }, async () => JSON.stringify(await call('state:get')).includes('Alfred coverage prompt')],
    ['transcript.clear', {}, async () => ((await call('state:get')).transcript || []).length === 0],
    ['selfrepair.settings', { intervalMin: 45 }, async () => (await call('selfrepair:status')).settings.intervalMin === 45],
    ['sd.settings', { patch: { steps: 31 } }, async () => (await call('image:status')).steps === 31],
    ['image.configure', { settings: { cfgScale: 6 } }, async () => (await call('image:status')).cfgScale === 6],
    ['manager.configure', { model: 'qwen2.5:7b', tier: 3 }, async () => (await call('manager:get-state')).managerConfig.model === 'qwen2.5:7b'],
    ['participants.set', { site: 'gemini', enabled: false }, async () => (await call('state:get')).global.enabled.gemini === false],
    ['participants.set', { site: 'gemini', enabled: true }, async () => (await call('state:get')).global.enabled.gemini === true],
    ['relay.silence', {}, null],
    ['routing.pause_all', {}, null],
    ['akowe_server.autostart', { on: false }, async () => (await call('akowe-server:status')).startWithApp === false],
    ['sdlib.collection', { op: 'add', name: 'Faces' }, null],
    ['sdlib.delete_lock', { id: 'nonexistent' }, null],
    ['models.open', { category: 'llm' }, () => opened.some((p) => /models/.test(String(p)))],
  ];
  let realChOk = 0;
  for (const [id, args, verify] of REAL_CHANGES) {
    const res = await drive('app_control', { action: id, args });
    const v = verify ? await verify(res.result && res.result.data) : true;
    const good = res.carded && /RESULT/.test(res.text) && !/NO_SUCH_CONTROL|CONTROL_ERROR/.test(res.text) && v;
    if (good) { realChOk++; mark(`app:${id}`, 'real handler + effect'); } else console.log(`      ! real ${id}: ${res.text.slice(0, 200)} verify=${v}`);
  }
  check('app_control', realChOk === REAL_CHANGES.length, `${REAL_CHANGES.length} changing app actions: card → ✔ → the REAL handler → the effect is visible in the app state (${realChOk} ok)`);
  void st0;
  d = await drive('app_info', { action: 'ui.show_tab', args: { tab: 'images' } });
  assert(!d.carded && /done/.test(d.text), 'ui.show_tab: switches the visible tab (no card: it only changes the view)');

  // ---- 🔒 always allow, per action ------------------------------------------------------------------------------
  d = await drive('app_control', { action: 'relay.hop_limit', args: { max: 5 } }, { confirm: false });
  await call('alfred:confirm', { id: d.card.id, alwaysAllow: ['app_control:relay.hop_limit', 'app_control:routing.auto_all', 'app_control:phone.set_lan'] });
  const s1 = await call('alfred:status');
  assert(s1.settings.alwaysAllow['app_control:relay.hop_limit'] && !s1.settings.alwaysAllow['app_control:routing.auto_all'] && !s1.settings.alwaysAllow['app_control:phone.set_lan'], '"always allow" is per action and only for harmless ones');
  d = await drive('app_control', { action: 'relay.hop_limit', args: { max: 4 } });
  assert(!d.carded && /RESULT/.test(d.text), 'an always-allowed action then runs without a card');

  // ---- what went into the activity log ----------------------------------------------------------------------------
  const log = ((await call('state:get')).log || []).filter((e) => /^alfred-/.test(e.kind));
  assert(log.some((e) => e.kind === 'alfred-tool' && e.detail.tool === 'app_control' && e.detail.action === 'routing.set'), 'the activity log names the app action (codes only)');
  assert(!JSON.stringify(log).includes('summarise chapter 1') && !JSON.stringify(log).includes('a lighthouse at dusk'), 'no prompts or prose in the log');

  // =====================================================================================================
  // 3c. the book tools against a fake Akọwe API
  // =====================================================================================================
  console.log('\n== 3c. the book tools against a fake Akọwe API ==');
  {
    const TOKEN = 'cov-token';
    const ak = await fakeAkowe(TOKEN);
    const bq = [];
    const bl = await fakeLlm((body) => (lastMsg(body).role === 'tool' ? { content: `RESULT ${lastMsg(body).content}` } : bq.shift() || { content: 'idle' }));
    const file = path.join(TMP, 'alfred-b.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: true, brain: 'local', local: { endpoint: bl.base, model: 'fake' } }));
    const pages = [];
    const journal = [];
    const b = createAlfred({ settingsFile: file, noTimers: true, journal: async (pid, code) => { journal.push(code); }, ctx: {
      akowe: (m, p, body) => nodeHttp({ method: m, url: ak.base + p, headers: { Authorization: `Bearer ${TOKEN}` }, body, timeoutMs: 5000 }).catch(() => ({ status: 0 })),
      openAkowePage: async (h) => { pages.push(h); return { ok: true }; },
    } });
    const bd = async (tool, args) => { bq.push(toolCall(tool, args)); let r = await b.ask(`use ${tool}`); const carded = r.type === 'confirm'; if (carded) r = await b.confirm(r.card.id); return { carded, text: r.text || '' }; };
    const hit = (m, p) => ak.requests.some((x) => x.method === m && x.path === p);
    const B = '/api/projects/proj-1/branches/main';
    const cases = [
      ['book_status', {}, false, () => hit('GET', '/api/slots/states') && hit('GET', `${B}/book`)],
      ['list_books', {}, false, () => hit('GET', '/api/projects')],
      ['start_book', { idea: 'A keeper finds a bottle' }, true, () => ak.requests.some((x) => x.method === 'POST' && x.path === '/api/autobook' && x.body.author_confirms === true)],
      ['pause_run', {}, true, () => hit('POST', '/api/autobook/run-abc/pause')],
      ['resume_run', {}, true, () => hit('POST', '/api/autobook/run-abc/resume')],
      ['cancel_run', {}, true, () => hit('POST', '/api/autobook/run-abc/cancel')],
      ['edit_profile', { tone: 'quiet' }, true, () => hit('PUT', '/api/projects/proj-1/profile')],
      ['edit_character', { character: 'Mara Vell', voice: { rhythm: 'clipped' } }, true, () => hit('PUT', `${B}/review/characters/rec-mara`)],
      ['add_story_rule', { text: 'Salt stops ghosts.', category: 'belief' }, true, () => hit('PUT', `${B}/review/world/rules`)],
      ['add_world_detail', { detail: 'Oil costs a shilling', kind: 'economy' }, true, () => hit('PUT', `${B}/review/world/texture`)],
      ['rewrite_chapter', { chapter: 'ch2', note: 'More fog.' }, true, () => ak.requests.some((x) => x.path === `${B}/review/fix` && x.body.note === 'More fog.')],
      ['open_akowe_page', { page: 'report' }, false, () => pages.includes('#/p/proj-1/main/report')],
      ['make_book_report', {}, true, () => hit('POST', `${B}/report`)],
      ['save_book', {}, true, () => hit('POST', `${B}/save`)],
      ['character_dossier', { character: 'Mara Vell' }, false, () => hit('GET', `${B}/forge/characters/rec-mara`)],
      ['forge_character', { character: 'Mara Vell' }, true, () => hit('POST', `${B}/forge/characters/rec-mara/forge`)],
      ['edit_dossier', { character: 'Mara Vell', fields: { goals: 'Keep the lamp lit.' } }, true, () => hit('PUT', `${B}/forge/characters/rec-mara`)],
      ['approve_dossier', { character: 'Mara Vell', fields: ['traits'] }, true, () => ak.requests.some((x) => x.path === `${B}/forge/characters/rec-mara/approve` && x.body.fields[0] === 'traits')],
      ['create_dossier', { kind: 'places', from: 'A04-x' }, true, () => ak.requests.some((x) => x.method === 'POST' && x.path === `${B}/forge/places` && x.body.from === 'A04-x')],
      ['check_dossier', { character: 'Mara Vell', action: 'run' }, true, () => ak.requests.some((x) => x.method === 'POST' && x.path === `${B}/forge/characters/rec-mara/check`)],
      ['book_cover', {}, false, () => hit('GET', `${B}/cover`)],
      ['design_cover', { template: 'thriller', texts: { tagline: 'Every light hides a debt.' }, print: { trim: '5.5x8.5', paper: 'white' } }, true, () => ak.requests.some((x) => x.method === 'PUT' && x.path === `${B}/cover` && x.body.template === 'thriller' && x.body.print.trim === '5.5x8.5')],
      ['make_cover_art', { engine: 'sd', upscale: 2, character: 'Mara Vell', note: 'the lighthouse in a storm' }, true, () => ak.requests.some((x) => x.path === `${B}/cover/art` && x.body.upscale === 2) && ak.requests.some((x) => x.method === 'PUT' && x.path === `${B}/cover` && x.body.character_lock === 'Mara Vell')],
      ['book_pictures', {}, false, () => hit('GET', `${B}/pictures`)],
      ['set_art_style', { style: 'watercolour storybook' }, true, () => ak.requests.some((x) => x.method === 'PUT' && x.path === `${B}/pictures/style` && x.body.style === 'watercolour storybook')],
      ['illustrate', { chapter: '2', count: 2, engine: 'chatgpt' }, true, () => ak.requests.some((x) => x.path === `${B}/pictures/illustrate` && x.body.chapter_id === 'ch2' && x.body.count === 2 && x.body.engine === 'chatgpt')],
      ['edit_picture', { pic_id: 'pic-001', caption: 'At dawn', where: 'after_scene', scene: 2 }, true, () => ak.requests.some((x) => x.method === 'PUT' && x.path === `${B}/pictures/pic-001` && x.body.caption === 'At dawn' && x.body.placement.scene === 2)],
      ['book_map', { kind: 'illustrated', engine: 'sd' }, true, () => ak.requests.some((x) => x.path === `${B}/pictures/map` && x.body.kind === 'illustrated' && x.body.engine === 'sd')],
      ['make_character_art', { character: 'Mara Vell', what: 'sheet', engine: 'chatgpt' }, true, () => ak.requests.some((x) => x.path === `${B}/forge/characters/rec-mara/art` && x.body.what === 'sheet' && x.body.engine === 'chatgpt')],
    ];
    for (const [tool, args, changes, effect] of cases) {
      const r = await bd(tool, args);
      check(tool, r.carded === changes && effect() && /RESULT/.test(r.text), `${changes ? 'card → ✔ → ' : 'directly → '}the right Akọwe call`, 'fake Akọwe API');
    }
    assert(['edit_profile', 'save_book', 'rewrite_chapter'].every((c) => journal.includes(c)), 'book actions are noted in the Akọwe journal');
    assert(!ak.requests.some((x) => /approve|decide/.test(x.path) && !/\/forge\/characters\//.test(x.path)), 'no book-draft approval is ever sent to Akọwe (dossier proposals only via approve_dossier\'s card)');
    await ak.close(); await bl.close();
  }

  // =====================================================================================================
  // the coverage table
  // =====================================================================================================
  console.log('\n== coverage: every Alfred tool driven end to end ==');
  const missingTools = registry.TOOLS.map((t) => t.name).filter((n) => !T[n]);
  assert(!missingTools.length, `every one of the ${registry.TOOLS.length} Alfred tools was driven from a fake LLM tool call and checked${missingTools.length ? ` — NOT: ${missingTools.join(', ')}` : ''}`);
  const untestedActions = appActions.ACTIONS.filter((e) => !tested.has(`app:${e.id}`)).map((e) => e.id);
  assert(!untestedActions.length, `every app action was driven${untestedActions.length ? ` — NOT: ${untestedActions.join(', ')}` : ''}`);
  const untestedSd = SD_API_METHODS.filter((m) => !tested.has(`sd:${m}`));
  assert(!untestedSd.length, `every Images-module method was driven${untestedSd.length ? ` — NOT: ${untestedSd.join(', ')}` : ''}`);

  for (const t of registry.TOOLS) rows.push([t.title, t.name, t.changes ? 'asks first' : 'read-only', tested.get(`tool:${t.name}`) || '✗']);
  for (const e of appActions.ACTIONS) rows.push([e.title, `${e.changes ? 'app_control' : 'app_info'}:${e.id}`, e.channel || 'in Alfred', tested.get(`app:${e.id}`) || '✗']);
  for (const m of SD_API_METHODS) rows.push([`Images module ${m}`, `sd_call:${m}`, 'sd-api', tested.get(`sd:${m}`) || '✗']);
  for (const [c, why] of Object.entries(appActions.EXCLUDED)) rows.push([c, 'EXCLUDED', why, '—']);
  const w = [52, 38, 30];
  const pad = (s, n) => { s = String(s); return s.length > n ? `${s.slice(0, n - 1)}…` : s + ' '.repeat(n - s.length); };
  console.log(`\n  ${pad('capability', w[0])} ${pad('Alfred tool', w[1])} ${pad('how', w[2])} tested`);
  console.log(`  ${'-'.repeat(w[0])} ${'-'.repeat(w[1])} ${'-'.repeat(w[2])} ------`);
  for (const r of rows) console.log(`  ${pad(r[0], w[0])} ${pad(r[1], w[1])} ${pad(r[2], w[2])} ${r[3] === '✗' || r[3] === '—' ? r[3] : `✔ ${r[3]}`}`);
  const mappedChannels = IPC_INVENTORY.filter((c) => !c.startsWith('alfred:') && !appActions.EXCLUDED[c]).length;
  console.log(`\n  IPC channels: ${IPC_INVENTORY.length} (${IPC_INVENTORY.filter((c) => c.startsWith('alfred:')).length} are Alfred's own, ${mappedChannels} mapped, ${Object.keys(appActions.EXCLUDED).length} excluded with reasons)`);
  console.log(`  Alfred tools: ${registry.TOOLS.length} · app actions: ${appActions.ACTIONS.length} · Images-module methods: ${SD_API_METHODS.length} · butler actions ${Object.keys(MANAGER_ACTIONS_MAP).length} · bridge routes ${Object.keys(SERVICE_BRIDGE_ROUTES).length + Object.keys(AKOWE_BRIDGE_ROUTES).length}`);

  await llm.close(); await forge.close(); await comfy.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
