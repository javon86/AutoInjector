'use strict';
/*
 * alfred-app-actions.js — the rest of AutoInjector as a FIXED catalog of direct controls for 🎩 Alfred.
 *
 * Every user-facing thing the control panel / tabs / menus can do is an IPC channel in main.js. Each
 * entry below names one capability, the channel it calls, a JSON schema for its arguments, whether it
 * changes something (→ "I will" card) and an example (used by the coverage test). Alfred reaches them
 * through two tools in alfred-tools.js: `app_info` (read-only entries) and `app_control` (the rest).
 * Channels that must NOT be driven by an AI (secrets, window chrome, free command execution …) are in
 * EXCLUDED with the reason. test/alfred-coverage.test.js fails when a channel is in neither list.
 *
 * Entry: { id, channel, title, changes, allowAlways?, args (properties), required?, call(a) -> ipc args,
 *          example, local? } — `local` = handled inside Alfred (no IPC), e.g. switching the visible tab.
 */
const S = ['chatgpt', 'claude', 'gemini'];
const site = { type: 'string', enum: S };
const sites = { type: 'array', items: { type: 'string', enum: S }, maxItems: 3 };
const text = (n) => ({ type: 'string', minLength: 1, maxLength: n || 4000 });
const opt = (n) => ({ type: 'string', maxLength: n || 400 });
const pass = { type: 'object', 'x-passthrough': true, description: 'Settings to change (only the keys you name)' };

const ACTIONS = [];
function A(id, channel, o) {
  ACTIONS.push(Object.freeze({
    id, channel, title: o.t, changes: !!o.c, allowAlways: !!o.aa, args: o.a || {}, required: o.r || [],
    call: o.call || (Object.keys(o.a || {}).length ? (a) => [a] : () => []), example: o.ex || {}, local: o.local || null,
  }));
}

// ---- 💬 the three AIs: sending, routing, relay ----------------------------------------------------------
A('send.forward', 'send:forward', { t: 'Forward an AI\'s last reply to other AIs', c: true, a: { source: site, targets: sites }, r: ['source', 'targets'], ex: { source: 'claude', targets: ['gemini'] } });
A('send.regenerate', 'send:regenerate', { t: 'Ask an AI to regenerate its last answer', c: true, a: { site }, r: ['site'], call: (a) => [a.site], ex: { site: 'chatgpt' } });
A('routing.set', 'routing:set', { t: 'Turn forwarding from one AI to another on/off', c: true, aa: true, a: { source: site, target: site, enabled: { type: 'boolean' } }, r: ['source', 'target', 'enabled'], ex: { source: 'claude', target: 'gemini', enabled: true } });
A('routing.pause_all', 'routing:pause-all', { t: 'Pause all forwarding', c: true, aa: true });
A('routing.stop_all', 'routing:stop-all', { t: 'Stop all forwarding', c: true, aa: true });
A('routing.auto_all', 'routing:auto-all', { t: 'Turn on Auto forwarding for all AIs', c: true });
A('relay.silence', 'relay:silence', { t: 'Stop the AIs talking (silence the relay)', c: true, aa: true });
A('relay.hop_limit', 'relay:hop-limit', { t: 'Set the AI-to-AI hop limit', c: true, aa: true, a: { max: { type: 'integer', minimum: 0, maximum: 100 } }, r: ['max'], ex: { max: 6 } });
A('participants.set', 'participants:set', { t: 'Make an AI active / inactive', c: true, a: { site, enabled: { type: 'boolean' } }, r: ['site', 'enabled'], ex: { site: 'gemini', enabled: false } });
A('roles.set', 'roles:set', { t: 'Give an AI a role to play', c: true, aa: true, a: { site, role: opt(400) }, r: ['site', 'role'], ex: { site: 'claude', role: 'a strict editor' } });
A('health.check', 'health:check', { t: 'Check one AI pane now', c: false, a: { site }, r: ['site'], ex: { site: 'claude' } });
A('health.get', 'health:get', { t: 'AI pane health lights', c: false });
A('health.status', 'health:status', { t: 'Is anything wrong? What the 🩺 health watch found (his brain/Ollama, free disk, Stable Diffusion, Akọwe\'s server, AI panes, logs folder) and the fix for each', c: false, a: { fresh: { type: 'boolean', description: 'look again now (cheap local checks)' } } });
A('health.fix', 'health:fix', { t: 'Apply the one-click fix for a problem the health watch found', c: true, a: { code: text(80) }, r: ['code'], ex: { code: 'brain-ollama-down' } });
A('sites.list', 'site:list', { t: 'The AI panes and their state', c: false });
A('site.reload', 'site:reload', { t: 'Reload an AI pane', c: true, aa: true, a: { site }, r: ['site'], call: (a) => [a.site], ex: { site: 'gemini' } });
A('sites.new_chat_all', 'sites:new-chat-all', { t: 'Start a new chat in every AI pane', c: true });
A('site.zoom', 'site:zoom', { t: 'Zoom an AI pane', c: true, aa: true, a: { site, factor: { type: 'number', minimum: 0.25, maximum: 3 } }, r: ['site', 'factor'], ex: { site: 'chatgpt', factor: 0.9 } });
A('transcript.clear', 'transcript:clear', { t: 'Clear the transcript', c: true });
A('transcript.toggle_pin', 'transcript:toggle-pin', { t: 'Pin / unpin a transcript message', c: true, aa: true, a: { id: { type: 'integer', minimum: 0 } }, r: ['id'], call: (a) => [a.id], ex: { id: 1 } });
A('state.get', 'state:get', { t: 'The whole app state (settings, transcript, log)', c: false });
A('ledger.trace_report', 'trace:report', { t: 'Relay Trace report (where every message went)', c: false, call: () => [{}] });
A('ledger.trace_save', 'trace:report', { t: 'Save the Relay Trace report to the logs folder', c: true, aa: true, call: () => [{ save: true }] });
A('ledger.trace_reset', 'trace:report', { t: 'Reset the Relay Trace', c: true, call: () => [{ reset: true }] });

// ---- 🎭 House Rules, sequences, prompts -----------------------------------------------------------------
A('houserule.start', 'houserule:start', { t: 'Start a House Rule (debate, brainstorm, roundtable …)', c: true, a: { mode: opt(40), topic: text(2000), rounds: { type: 'integer', minimum: 1, maximum: 50 } }, r: ['mode', 'topic'], ex: { mode: 'debate', topic: 'Is the lighthouse haunted?', rounds: 2 } });
A('houserule.stop', 'houserule:stop', { t: 'Stop the House Rule', c: true, aa: true });
A('houserule.pause', 'houserule:pause', { t: 'Pause the House Rule', c: true, aa: true });
A('houserule.resume', 'houserule:resume', { t: 'Resume the House Rule', c: true });
A('houserule.wrap_up', 'houserule:wrap-up-brainstorm', { t: 'Wrap up the brainstorm', c: true });
A('sequence.run', 'sequence:run', { t: 'Run a Prompt Sequence', c: true, a: { steps: { type: 'array', maxItems: 30, items: { type: 'object', required: ['target', 'text'], properties: { target: { type: 'string', enum: S.concat(['all']) }, text: text(4000) }, additionalProperties: false } } }, r: ['steps'], ex: { steps: [{ target: 'claude', text: 'Outline chapter 1' }] } });
A('sequence.stop', 'sequence:stop', { t: 'Stop the Prompt Sequence', c: true, aa: true });
A('sequence.open_editor', 'sequence:open', { t: 'Open the Prompt Sequence editor', c: true, aa: true });
A('prompts.save', 'prompts:save', { t: 'Save a prompt in the Prompt Library', c: true, a: { id: { type: 'integer', minimum: 0 }, name: text(200), text: text(8000) }, r: ['name', 'text'], ex: { name: 'Chapter check', text: 'Check this chapter for continuity.' } });
A('prompts.delete', 'prompts:delete', { t: 'Delete a prompt from the library', c: true, a: { id: { type: 'integer', minimum: 0 } }, r: ['id'], call: (a) => [a.id], ex: { id: 3 } });
A('prompts.send', 'prompts:send', { t: 'Send a library prompt to the AIs', c: true, a: { text: text(8000) }, r: ['text'], ex: { text: 'Hello all' } });
A('prompts.open_editor', 'prompts:open-editor', { t: 'Open the prompt editor', c: true, aa: true, a: { id: { type: 'integer', minimum: 0 } }, call: (a) => [a.id], ex: { id: 1 } });

// ---- 🧪 tests and checks ---------------------------------------------------------------------------------
A('selftest.run', 'selftest:run', { t: 'Self-test one AI pane', c: true, aa: true, a: { site }, r: ['site'], ex: { site: 'claude' } });
A('tuner.run', 'tuner:run', { t: 'Run the Tuner (whole relay test)', c: true });
A('brigade.run', 'brigade:run', { t: 'Run the relay check (Bucket Brigade)', c: true });
A('brigade.stop', 'brigade:stop', { t: 'Stop the relay check', c: true, aa: true });
A('featuretest.run', 'featuretest:run', { t: 'Run the Feature Test', c: true });
A('featuretest.stop', 'featuretest:stop', { t: 'Stop the Feature Test', c: true, aa: true });
A('featuretest.open_report', 'featuretest:open-report', { t: 'Open the Feature Test report', c: true, aa: true, a: { file: opt(1000) }, r: ['file'], ex: { file: 'feature-test.txt' } });
A('butler.selfcheck', 'butler:selfcheck', { t: 'System Check (what the butler can do)', c: false });
A('butler.capability_test', 'butler:capability-test', { t: 'Test all capabilities (really runs them)', c: true });
A('butler.install_missing', 'butler:install-missing', { t: 'Install what is missing', c: true });
A('butler.send_intro', 'butler:send-intro', { t: 'Send the butler\'s introduction to the AIs', c: true, a: { targets: sites }, ex: { targets: ['claude'] } });

// ---- 🤵 the butler / manager ------------------------------------------------------------------------------
A('manager.start_task', 'manager:start-task', { t: 'Give the butler a managed task', c: true, a: { userRequest: text(6000), mode: { type: 'string', enum: ['auto', 'self', 'delegate'] } }, r: ['userRequest'], ex: { userRequest: 'Compare three openings for chapter 1', mode: 'delegate' } });
A('manager.pause', 'manager:pause', { t: 'Pause the butler\'s task', c: true, aa: true });
A('manager.resume', 'manager:resume', { t: 'Resume the butler\'s task', c: true });
A('manager.stop', 'manager:stop', { t: 'Stop the butler\'s task', c: true, aa: true });
A('manager.approve', 'manager:approve', { t: 'Approve the butler\'s waiting step', c: true });
A('manager.reject', 'manager:reject', { t: 'Reject the butler\'s waiting step', c: true, a: { reason: opt(400) }, ex: { reason: 'not now' } });
A('manager.configure', 'manager:configure-provider', { t: 'Change the butler\'s AI settings (never the key)', c: true, a: { provider: { type: 'string', enum: ['runpod-serverless', 'runpod-pod', 'openai-compatible'] }, endpoint: opt(400), model: opt(200), tier: { type: 'integer', minimum: 1, maximum: 4 }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 }, podId: opt(200), approvalMode: { type: 'boolean' }, maximumTurns: { type: 'integer', minimum: 1, maximum: 1000 }, costLimit: { type: 'number', minimum: 0 } }, ex: { model: 'qwen2.5:7b', tier: 2 } });
A('manager.test_connection', 'manager:test-connection', { t: 'Test the butler\'s AI connection', c: false });
A('manager.get_state', 'manager:get-state', { t: 'The butler\'s task state and log', c: false });
A('butler.chat', 'butler:chat', { t: 'Talk to the butler\'s model', c: false, a: { message: text(4000) }, r: ['message'], ex: { message: 'hello' } });
A('tools.list', 'tools:list', { t: 'The butler\'s tool list', c: false });
A('memory.summary', 'memory:summary', { t: 'What the butler remembers (summary)', c: false });
A('memory.search', 'memory:search', { t: 'Search the butler\'s memory', c: false, a: { query: text(400) }, r: ['query'], ex: { query: 'lighthouse' } });

// ---- 🗄 lockers, terminal, database, files ----------------------------------------------------------------
A('lockers.status', 'lockers:status', { t: 'AI lockers status', c: false });
A('lockers.list', 'lockers:list', { t: 'Files in an AI\'s locker', c: false, a: { site }, r: ['site'], ex: { site: 'claude' } });
A('lockers.read', 'lockers:read', { t: 'Read a file from an AI\'s locker', c: false, a: { site, rel: text(500) }, r: ['site', 'rel'], ex: { site: 'claude', rel: 'notes.txt' } });
A('lockers.attach', 'lockers:attach', { t: 'Attach a locker file to AIs\' chats', c: true, a: { site, rel: text(500), targets: sites }, r: ['site', 'rel', 'targets'], ex: { site: 'claude', rel: 'notes.txt', targets: ['gemini'] } });
A('lockers.open', 'lockers:open', { t: 'Open the lockers folder', c: true, aa: true });
A('terminal.state', 'terminal:state', { t: 'Command Prompt connection state', c: false });
A('terminal.start', 'terminal:start', { t: 'Start the Command Prompt connection', c: true });
A('terminal.stop', 'terminal:stop', { t: 'Stop / restart the Command Prompt connection', c: true, aa: true, a: { restart: { type: 'boolean' } }, ex: { restart: false } });
A('terminal.clear', 'terminal:clear', { t: 'Clear the terminal output', c: true, aa: true });
A('terminal.reject', 'terminal:reject', { t: 'Reject a command an AI asked to run', c: true, aa: true, a: { id: opt(80), reason: opt(300) }, r: ['id'], ex: { id: 'cmd-1', reason: 'no' } });
A('terminal.send_output', 'terminal:send-output', { t: 'Send the terminal output to AIs', c: true, a: { targets: sites }, r: ['targets'], ex: { targets: ['claude'] } });
A('db.status', 'db:status', { t: 'Shared database status', c: false });
A('db.recent_messages', 'db:recent-messages', { t: 'Recent messages from the database', c: false, a: { limit: { type: 'integer', minimum: 1, maximum: 200 } }, call: (a) => [a.limit || 20], ex: { limit: 5 } });
A('models.info', 'models:info', { t: 'Downloaded models (the "stuff and thing" folder)', c: false });
A('models.open', 'models:open', { t: 'Open the models / content folder', c: true, aa: true, a: { category: opt(40) }, ex: { category: 'llm' } });
A('logs.extract_options', 'logs:extract-options', { t: 'Log extract choices (books, ranges)', c: false });
A('logs.extract_preview', 'logs:extract-preview', { t: 'Preview a log extract', c: false, a: { scope: { type: 'string', enum: ['book', 'time', 'everything'] }, bookId: opt(80), preset: opt(20) }, ex: { scope: 'time', preset: 'day' } });
A('logs.download_all', 'logs:download-all', { t: 'Gather all logs into one folder', c: true, aa: true });
A('logs.tags', 'logs:tags', { t: 'Activity log categories', c: false });
A('feed.history', 'feed:history', { t: 'AI feed history', c: false });
A('feed.open', 'feed:open', { t: 'Open the AI Feed window', c: true, aa: true });

// ---- ⚙ setup, models, voice, image/video settings, endpoints, GPU ------------------------------------------
A('setup.list', 'setup:list', { t: 'What can be installed', c: false });
A('setup.detect', 'setup:detect', { t: 'Detect what is installed', c: false });
A('setup.install', 'setup:install', { t: 'Install a component (fixed list: Open Interpreter, voice, a local model …)', c: true, a: { target: opt(60), model: opt(120) }, r: ['target'], ex: { target: 'open-interpreter' } });
A('setup.auto', 'setup:auto', { t: 'Install everything recommended', c: true, a: { model: opt(120) }, ex: {} });
A('wizard.open', 'wizard:open', { t: 'Open the Setup Wizard', c: true, aa: true, a: { tab: opt(40) }, ex: { tab: 'images' } });
A('wizard.catalog', 'wizard:catalog', { t: 'Setup Wizard catalog', c: false });
A('ollama.detect', 'ollama:detect', { t: 'Is Ollama installed?', c: false });
A('ollama.list', 'ollama:list', { t: 'Local models installed in Ollama', c: false, a: { endpoint: opt(300) }, call: (a) => [a.endpoint || undefined] });
A('ollama.recommended', 'ollama:recommended', { t: 'Recommended local models for a graphics card', c: false, a: { vramGB: { type: 'number', minimum: 0, maximum: 200 }, uncensored: { type: 'boolean' } }, ex: { vramGB: 8 } });
A('ollama.pull', 'ollama:pull', { t: 'Download a local model (ollama pull)', c: true, a: { model: text(120) }, r: ['model'], call: (a) => [a.model], ex: { model: 'qwen2.5:7b' } });
A('ollama.managed_status', 'ollama:managed-status', { t: 'The app\'s own Ollama', c: false });
A('ollama.migrate', 'ollama:migrate', { t: 'Move downloaded models into "stuff and thing"', c: true });
// ---- 🎩 his own AI: one-button setup, the check, the model finder (llm-setup.js / model-catalog.js) ---------
A('llm.status', 'llm:status', { t: 'His AI: Ollama, the server, installed models, the model he uses', c: false });
A('llm.hardware', 'llm:hardware', { t: 'This PC\'s graphics card and memory (what models fit)', c: false, a: { fresh: { type: 'boolean' } } });
A('llm.check', 'llm:check', { t: 'Check everything for his AI (installed, running, model answers, tools, fit)', c: false, a: { quick: { type: 'boolean' } } });
A('llm.fix', 'llm:fix', { t: 'Fix one problem the check found', c: true, a: { action: { type: 'string', enum: ['install', 'start', 'stop', 'use', 'butler-use', 'download-recommended', 'setup'] }, model: opt(200) }, r: ['action'], ex: { action: 'start' } });
A('llm.setup_all', 'llm:setup-all', { t: 'Set up his AI with one button (install Ollama, start it, download the best model that fits, use it, check)', c: true, a: { uncensored: { type: 'boolean' } }, ex: { uncensored: false } });
A('llm.start_alfred', 'llm:start-alfred', { t: 'Start his AI with what is already downloaded (no download): Ollama, the model, loaded', c: true, aa: true });
A('llm.scan', 'llm:scan', { t: 'Find what is already installed: Ollama, model folders, models, .gguf files from other apps', c: false });
A('llm.use_store', 'llm:use-store', { t: 'Use an Ollama model folder that already has models (no download)', c: true, a: { dir: text(1000) }, r: ['dir'], ex: { dir: '/home/me/.ollama/models' } });
A('llm.import_gguf', 'llm:import-gguf', { t: 'Add a .gguf model file another app downloaded into Ollama (no download)', c: true, a: { file: text(1000), name: opt(60) }, r: ['file'], ex: { file: '/home/me/Downloads/model.gguf', name: 'my-model' } });
A('folders.map', 'folders:map', { t: 'Where everything is kept (one tidy list: "stuff and thing", ComfyUI, models, settings…)', c: false });
A('folders.open', 'folders:open', { t: 'Open one of the folders in the "where everything is" list', c: true, aa: true, a: { path: text(1000) }, r: ['path'], ex: { path: '/home/me/AutoInjector/stuff and thing' } });
A('folders.move_comfy', 'folders:move-comfy', { t: 'Move an older ComfyUI (and its models) into "stuff and thing" (the app restarts)', c: true });
A('content.roots', 'content:roots', { t: 'Where your downloads are kept ("stuff and thing"), and earlier AutoInjector folders that also have downloads', c: false, a: { fresh: { type: 'boolean' } } });
A('content.use_root', 'content:use-root', { t: 'Keep downloads in another AutoInjector folder (the app restarts)', c: true, a: { root: text(1000) }, r: ['root'], ex: { root: '/home/me/Documents/git/AutoInjector' } });
A('llm.install_ollama', 'llm:install-ollama', { t: 'Install Ollama', c: true });
A('llm.start', 'llm:start', { t: 'Start Ollama', c: true, aa: true });
A('llm.stop', 'llm:stop', { t: 'Stop the app\'s Ollama', c: true, aa: true });
A('llm.search', 'llm:search', { t: 'Find models on the Ollama library and Hugging Face, rated for this PC', c: false, a: { query: opt(200), sources: { type: 'array', maxItems: 2, items: { type: 'string', enum: ['ollama', 'hf'] } }, uncensored: { type: 'boolean' }, toolsOnly: { type: 'boolean' } }, call: (a) => [a.query || '', { sources: a.sources, uncensored: !!a.uncensored, toolsOnly: !!a.toolsOnly }], ex: { query: 'qwen', uncensored: true } });
A('llm.curated', 'llm:curated', { t: 'Recommended models for this PC (works offline)', c: false, a: { uncensored: { type: 'boolean' } }, ex: { uncensored: true } });
A('llm.hf_files', 'llm:hf-files', { t: 'The sizes (quantizations) of a Hugging Face model and which fit', c: false, a: { repo: text(300) }, r: ['repo'], call: (a) => [a.repo], ex: { repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF' } });
A('llm.pull', 'llm:pull', { t: 'Download a model (only ones that fit this PC)', c: true, a: { pullName: text(300), sizeBytes: { type: 'number', minimum: 0 } }, r: ['pullName'], call: (a) => [a.pullName, { sizeBytes: a.sizeBytes }], ex: { pullName: 'qwen2.5:7b' } });
A('llm.cancel', 'llm:cancel', { t: 'Stop the download / install', c: true, aa: true });
A('llm.remove', 'llm:remove', { t: 'Delete a downloaded model', c: true, a: { name: text(300) }, r: ['name'], call: (a) => [a.name], ex: { name: 'llama3.2:1b' } });
A('llm.use', 'llm:use', { t: 'Make a model his AI (and the Butler\'s)', c: true, a: { name: text(300), alsoButler: { type: 'boolean' } }, r: ['name'], ex: { name: 'qwen2.5:7b' } });
A('voice.status', 'voice:status', { t: 'Voice status', c: false });
A('voice.check', 'voice:check', { t: 'Check the voice service', c: false });
A('voice.configure', 'voice:configure', { t: 'Change voice settings', c: true, a: { settings: pass }, r: ['settings'], call: (a) => [a.settings], ex: { settings: { enabled: true } } });
A('voice.speak', 'voice:speak', { t: 'Say something out loud', c: true, aa: true, a: { text: text(2000), who: opt(40) }, r: ['text'], ex: { text: 'Good evening.' } });
A('voice.redownload', 'voice:redownload', { t: 'Re-download the voice file (when it is damaged or incomplete)', c: true, ex: {} });
A('voice.listen', 'voice:listen', { t: 'Listen with the microphone', c: true, a: { seconds: { type: 'integer', minimum: 1, maximum: 60 } }, ex: { seconds: 5 } });
A('image.status', 'image:status', { t: 'Image generator settings', c: false });
A('image.configure', 'image:configure', { t: 'Change image generator settings', c: true, a: { settings: pass }, r: ['settings'], call: (a) => [a.settings], ex: { settings: { steps: 25 } } });
A('video.configure', 'video:configure', { t: 'Change video generator settings', c: true, a: { settings: pass }, r: ['settings'], call: (a) => [a.settings], ex: { settings: { frames: 24 } } });
A('endpoints.presets', 'endpoints:presets', { t: 'Known addresses for image/video servers', c: false, a: { kind: { type: 'string', enum: ['image', 'video'] } }, ex: { kind: 'image' } });
A('endpoints.detect', 'endpoints:detect', { t: 'Find a running image/video server', c: false, a: { kind: { type: 'string', enum: ['image', 'video'] } }, ex: { kind: 'image' } });
A('endpoints.test', 'endpoints:test', { t: 'Test an address', c: false, a: { url: text(400) }, r: ['url'], ex: { url: 'http://127.0.0.1:7860' } });
A('gpu.info', 'gpu:info', { t: 'Graphics card use', c: false });

// ---- 🔧 self-repair, picker ---------------------------------------------------------------------------------
A('selfrepair.status', 'selfrepair:status', { t: 'Self-repair state of the AIs', c: false });
A('selfrepair.teach_start', 'selfrepair:teach-start', { t: 'Start the number teach for an AI', c: true, a: { site }, r: ['site'], ex: { site: 'gemini' } });
A('selfrepair.teach_cancel', 'selfrepair:teach-cancel', { t: 'Cancel the number teach', c: true, aa: true, a: { site }, r: ['site'], ex: { site: 'gemini' } });
A('selfrepair.reload', 'selfrepair:reload', { t: 'Reload an AI pane and re-check it', c: true, aa: true, a: { site }, r: ['site'], ex: { site: 'gemini' } });
A('selfrepair.forget_learned', 'selfrepair:forget-learned', { t: 'Forget what self-repair learned about an AI page', c: true, a: { site }, r: ['site'], ex: { site: 'gemini' } });
A('selfrepair.settings', 'selfrepair:settings', { t: 'Check-in settings (every N minutes, at start)', c: true, aa: true, a: { intervalMin: { type: 'integer', minimum: 0, maximum: 1440 }, startup: { type: 'boolean' } }, ex: { intervalMin: 30 } });
A('picker.status', 'picker:status', { t: '🎯 picker state for an AI', c: false, a: { site }, r: ['site'], ex: { site: 'claude' } });
A('picker.start', 'picker:start', { t: '🎯 Start pointing at a part of an AI page (you point)', c: true, a: { site, role: { type: 'string', enum: ['input', 'send', 'assistant'] } }, r: ['site', 'role'], ex: { site: 'claude', role: 'input' } });
A('picker.cancel', 'picker:cancel', { t: '🎯 Cancel pointing', c: true, aa: true, a: { site }, r: ['site'], ex: { site: 'claude' } });
A('picker.save', 'picker:save', { t: '🎯 Save what you pointed at', c: true, a: { site, role: { type: 'string', enum: ['input', 'send', 'assistant'] } }, r: ['site', 'role'], ex: { site: 'claude', role: 'input' } });
A('picker.clear', 'picker:clear', { t: '🎯 Clear a saved part', c: true, a: { site, role: { type: 'string', enum: ['input', 'send', 'assistant'] } }, r: ['site', 'role'], ex: { site: 'claude', role: 'input' } });
A('picker.test', 'picker:test', { t: '🎯 Test the saved parts', c: true, aa: true, a: { site }, r: ['site'], ex: { site: 'claude' } });
A('selector.clear', 'selector:clear', { t: 'Clear a hand-picked selector', c: true, a: { site, role: opt(20) }, r: ['site', 'role'], ex: { site: 'claude', role: 'input' } });

// ---- 📖 Akọwe connection / server / view -------------------------------------------------------------------
A('akowe.status', 'akowe:status', { t: 'Akọwe bridge / connection status', c: false, call: () => [{ panelOpen: false }] });
A('akowe.diagnostics', 'akowe:diagnostics', { t: 'Akọwe diagnostics (safe text)', c: false, call: () => [{}] });
A('akowe.copy_diagnostics', 'akowe:copy-diagnostics', { t: 'Copy Akọwe diagnostics to the clipboard', c: true, aa: true, call: () => [{}] });
A('akowe.set_bridge', 'akowe:set-enabled', { t: 'Turn the Akọwe bridge on/off', c: true, a: { enabled: { type: 'boolean' } }, r: ['enabled'], ex: { enabled: true } });
A('akowe.connect', 'akowe:connect', { t: '🔗 Connect Akọwe', c: true, aa: true });
A('akowe.start_app', 'akowe:start-app', { t: 'Start Akọwe', c: true, aa: true });
A('akowe.linktest_run', 'akowe:linktest-run', { t: 'Run the Akọwe link test', c: true });
A('akowe.linktest_stop', 'akowe:linktest-stop', { t: 'Stop the Akọwe link test', c: true, aa: true });
A('akowe.linktest_report', 'akowe:linktest-open-report', { t: 'Open the Akọwe link-test report', c: true, aa: true, a: { file: opt(1000) }, r: ['file'], ex: { file: 'akowe-link-test.txt' } });
A('akowe_server.status', 'akowe-server:status', { t: 'Akọwe server status', c: false });
A('akowe_server.retry', 'akowe-server:retry', { t: 'Start / restart Akọwe\'s server', c: true, aa: true });
A('akowe_server.autostart', 'akowe-server:set-autostart', { t: 'Start Akọwe with AutoInjector on/off', c: true, a: { on: { type: 'boolean' } }, r: ['on'], ex: { on: true } });
A('akowe_server.open_log', 'akowe-server:open-log', { t: 'Open Akọwe\'s server log', c: true, aa: true });
A('akowe_server.get_python', 'akowe-server:get-python', { t: 'Open the Python download page', c: true, aa: true });
A('akowe_view.reload', 'akowe-view:reload', { t: 'Reload the Akọwe tab', c: true, aa: true });
A('akowe_view.pop_out', 'akowe-view:pop-out', { t: 'Pop Akọwe out into its own window', c: true, aa: true });
A('akowe_view.dock', 'akowe-view:dock', { t: 'Bring Akọwe back into the tab', c: true, aa: true });

// ---- 🎨 Images tab extras (the main generate/library calls go through sd_call / sd-api) ---------------------
A('sd.lists', 'sd:lists', { t: 'Checkpoints, samplers, VAEs, LoRAs the SD app lists', c: false });
A('sd.settings', 'sd:settings', { t: 'Change the Images tab defaults (size, steps, sampler, checkpoint …)', c: true, a: { patch: pass }, r: ['patch'], ex: { patch: { steps: 30 } } });
A('sd.record', 'sd:record', { t: 'The settings a picture was made with', c: false, a: { path: text(1000) }, r: ['path'], ex: { path: '/out/images/sd-1.png' } });
A('sd.open_images_folder', 'sd:open-images-folder', { t: 'Open the images folder', c: true, aa: true });
A('sd.open_ui', 'sd:open-ui', { t: 'Open the Stable Diffusion app\'s own page', c: true, aa: true });
A('sd.show_file', 'sd:show-file', { t: 'Show a picture in its folder', c: true, aa: true, a: { path: text(1000) }, r: ['path'], ex: { path: '/out/images/sd-1.png' } });
A('sd.open_log', 'sd:open-log', { t: 'Open the Stable Diffusion log', c: true, aa: true });
A('sd.set_autostart', 'sd:set-autostart', { t: 'Start Stable Diffusion with AutoInjector on/off', c: true, a: { on: { type: 'boolean' } }, r: ['on'], ex: { on: false } });
A('sd.open_install_folder', 'sd:open-install-folder', { t: 'Open the Stable Diffusion install folder', c: true, aa: true });
A('sd.start_cpu', 'sd:start-cpu', { t: 'Start ComfyUI on the processor (slow, but works on any PC) — when it crashes on the graphics card', c: true, a: { id: opt(300) }, ex: { id: 'portable:comfyui' } });
A('sd.use_other_build', 'sd:use-other-build', { t: 'Use the other ComfyUI build (switches to, or downloads, the other portable build for this graphics card, then starts it)', c: true });
A('sdlib.update', 'sdlib:update', { t: 'Edit a library entry (tags, ★, notes, base, weight, triggers)', c: true, a: { id: text(300), patch: pass }, r: ['id', 'patch'], ex: { id: 'lora:odile_face', patch: { favorite: true } } });
A('sdlib.folders', 'sdlib:folders', { t: 'Library model folders', c: false });
A('sdlib.add_folder', 'sdlib:add-folder', { t: 'Add a models folder to the library', c: true, a: { path: text(1000), kind: { type: 'string', enum: ['checkpoint', 'lora', 'vae', 'embedding', 'auto'] } }, r: ['path'], ex: { path: 'C:/StabilityMatrix/Data/Models' } });
A('sdlib.remove_folder', 'sdlib:remove-folder', { t: 'Remove a models folder from the library', c: true, a: { path: text(1000) }, r: ['path'], ex: { path: 'C:/old/Models' } });
A('sdlib.collection', 'sdlib:collection', { t: 'Add / rename / delete a library collection', c: true, a: { op: { type: 'string', enum: ['add', 'rename', 'delete'] }, name: text(120), to: opt(120) }, r: ['op', 'name'], ex: { op: 'add', name: 'Faces' } });
A('sdlib.save_lock', 'sdlib:save-lock', { t: 'Save a character lock', c: true, a: { lock: { type: 'object', required: ['character'], properties: { id: opt(80), character: text(120), book: opt(200), loras: { type: 'array', maxItems: 8, items: { type: 'object', required: ['name'], properties: { name: text(200), weight: { type: 'number' } }, additionalProperties: false } }, triggerWords: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 80 } }, prompt: opt(2000), negative: opt(2000), checkpoint: opt(200), seed: { type: 'integer' }, width: { type: 'integer', minimum: 64, maximum: 4096 }, height: { type: 'integer', minimum: 64, maximum: 4096 }, notes: opt(2000) }, additionalProperties: false } }, r: ['lock'], ex: { lock: { character: 'Odile', loras: [{ name: 'odile_face', weight: 0.8 }], prompt: 'red hair' } } });
A('sdlib.delete_lock', 'sdlib:delete-lock', { t: 'Delete a character lock', c: true, a: { id: text(80) }, r: ['id'], ex: { id: 'lock-1' } });
// ---- 🎬 Video tab extras (generate / animate / models / install go through video_call / video-api) ------------
A('video.open_folder', 'video:open-folder', { t: 'Open the videos folder', c: true, aa: true });
A('video.show_file', 'video:show-file', { t: 'Show a video in its folder', c: true, aa: true, a: { path: text(1000) }, r: ['path'], ex: { path: '/out/videos/video-1.mp4' } });
A('sdlib.check', 'sdlib:check', { t: 'Check LoRAs fit a checkpoint', c: false, a: { loras: { type: 'array', maxItems: 8, items: { type: 'object', required: ['name'], properties: { name: text(200), weight: { type: 'number' } }, additionalProperties: false } }, checkpoint: opt(200) }, ex: { loras: [{ name: 'odile_face' }], checkpoint: 'dreamshaper_8' } });

// ---- 🪟 what the window shows (inside Alfred: no IPC) ---------------------------------------------------------
A('ui.show_tab', null, { t: 'Show a tab (🤖 AutoInjector, 📖 Akọwe, 🎨 Images, 🎬 Video)', c: false, local: 'showTab', a: { tab: { type: 'string', enum: ['main', 'akowe', 'images', 'video'] } }, r: ['tab'], ex: { tab: 'images' } });

/** Channels the AI must not drive — each with the reason. The coverage test checks every channel is
 *  either an ACTIONS entry, a direct Alfred tool (TOOL_CHANNELS), or here. */
const EXCLUDED = {
  'logins:list': 'saved logins (usernames) — secrets stay with the user',
  'logins:save': 'stores a password — secrets stay with the user',
  'llm:hf-token': 'stores the Hugging Face token — secrets stay with the user',
  'logins:delete': 'saved logins — secrets stay with the user',
  'logins:fill': 'types a saved password into a page — secrets stay with the user',
  'akowe:copy-token': 'the Akọwe connection key — secret',
  'akowe:reveal-token': 'the Akọwe connection key — secret',
  'akowe:regenerate-token': 'replaces the Akọwe connection key (breaks pairing) — a security decision for the user',
  'phone:info': 'the phone link carries an access token — secret',
  'phone:set-lan': 'opens the app to the local network — a security setting left to the user',
  'external:open': 'opens any web address — not a direct control (specific tools open their own pages)',
  'terminal:run': 'free command execution — Alfred has no free code; Open Interpreter (optional, confirm-first, exact code shown) is the only code path',
  'terminal:input': 'free command execution (typing into the shell) — see terminal:run',
  'terminal:approve': 'approves a command an AI asked to run — a decision that stays with the user',
  'terminal:settings': 'can turn on auto-approve of commands — a security setting left to the user',
  'tools:run': 'the butler\'s tool runner includes run-command / install-package (free code) — Alfred\'s direct tools cover the safe ones',
  'selector:pick': 'legacy picker (superseded by the 🎯 picker:* actions Alfred has)',
  'site:inspect': 'opens developer tools — developer-only',
  'window:toggle-collapse': 'window chrome',
  'wizard-window:close': 'window chrome',
  'feed-window:close': 'window chrome',
  'prompt-editor:close': 'window chrome',
  'sequence-editor:close': 'window chrome',
  'panes:sync': 'internal layout sync (not a user action)',
  'ui:log': 'internal UI logging (not a user action)',
  'sd:extras': 'internal: the Images tab\'s one-call bundle (upscalers, ControlNet, ADetailer, styles, scripts, options, workflows); Alfred reads each through sd_call (sd.upscalers, sd.controlnet.*, sd.adetailer.models, sd.styles, sd.scripts, sd.options.get, sd.workflows.list)',
  'sd:capabilities': 'internal: Alfred reads sd-api capabilities() directly when he builds his sd_call method list and schemas (alfred-main.js sdMethodsOf)',
  'akowe-view:tab': 'internal: the tab tells main it is showing (Alfred uses ui.show_tab / open_akowe_page)',
  'video:capabilities': 'internal: Alfred reads video-api capabilities() directly when he builds his video_call method list and schemas',
  'video:trailer-pick-file': 'opens a file chooser for the person at the screen (music / a picture for a trailer shot) — Alfred passes the file path straight to trailer.make',
};
/** IPC channels that a dedicated Alfred tool covers (alfred-tools.js). */
const TOOL_CHANNELS = {
  'send:compose': 'send_to_ai',
  'selfrepair:probe': 'run_checkin',
  'logs:extract-all': 'export_logs',
  'image:generate': 'generate_image',
  'video:generate': 'generate_video',
  'video:status': 'video_status',
  'akowe:open-url': 'open_akowe_page',
  'sd:status': 'sd_call:images.status', 'sd:detect': 'sd_call:sd.detect', 'sd:connect': 'sd_call:sd.connect', 'sd:generate': 'sd_call:images.generate',
  'sd:test': 'sd_call:images.test', 'sd:fix-retry': 'sd_call:images.fixAndRetry', 'sd:progress': 'sd_call:images.progress', 'sd:cancel': 'sd_call:images.cancel', 'sd:gallery': 'sd_call:images.gallery',
  'sdlib:list': 'sd_call:library.find', 'sdlib:scan': 'sd_call:library.scan', 'sdlib:locks': 'sd_call:library.locks',
  'sd:targets': 'sd_call:sd.targets', 'sd:start': 'sd_call:sd.start', 'sd:stop': 'sd_call:sd.stop',
  'sd:install-check': 'sd_call:sd.install.check', 'sd:install': 'sd_call:sd.install.install', 'sd:install-model': 'sd_call:sd.install.downloadModel', 'sd:install-cancel': 'sd_call:sd.install.cancel',
  'sd:img2img': 'sd_call:images.img2img', 'sd:inpaint': 'sd_call:images.inpaint', 'sd:upscale': 'sd_call:images.upscale',
  'sd:options-get': 'sd_call:sd.options.get', 'sd:options-set': 'sd_call:sd.options.set', 'sd:interrupt': 'sd_call:sd.interrupt', 'sd:skip': 'sd_call:sd.skip',
  'sd:refresh': 'sd_call:sd.refresh', 'sd:memory': 'sd_call:sd.memory', 'sd:workflows': 'sd_call:sd.workflows.list', 'sd:workflow-get': 'sd_call:sd.workflows.get',
  'sd:workflow-save': 'sd_call:sd.workflows.save', 'sd:workflow-delete': 'sd_call:sd.workflows.delete', 'sd:workflow-run': 'sd_call:sd.workflows.run',
  // 🎨 the second engine (ChatGPT) + reference views / sheets: images.generate with engine / purpose / view is the same path as sd:request
  'sd:request': 'sd_call:images.generate', 'sd:chatgpt-status': 'sd_call:images.chatgptStatus', 'sd:chatgpt-cancel': 'sd_call:images.chatgptCancel', 'sd:chatgpt-settings': 'sd_call:images.chatgptSettings',
  // 🎬 the Video tab → the video module API (video-api.js) through video_call
  'video:full-status': 'video_call:video.status', 'video:models': 'video_call:video.models', 'video:settings': 'video_call:video.settings',
  'video:generate-t2v': 'video_call:video.generate', 'video:animate': 'video_call:video.animate', 'video:progress': 'video_call:video.progress',
  'video:cancel': 'video_call:video.cancel', 'video:gallery': 'video_call:video.gallery', 'video:test': 'video_call:video.test',
  'video:install-check': 'video_call:video.install.check', 'video:install-model': 'video_call:video.install.downloadModel',
  'video:install-all': 'video_call:video.install.installAll', 'video:install-cancel': 'video_call:video.install.cancel',
  // 🎞 book trailers (video-trailer.js) — also make_trailer for a book through Akọwe
  'video:trailer-make': 'video_call:trailer.make', 'video:trailer-status': 'video_call:trailer.status', 'video:trailer-cancel': 'video_call:trailer.cancel',
  'video:trailer-list': 'video_call:trailer.list', 'video:trailer-plan': 'video_call:trailer.plan',
};

function get(id) { return ACTIONS.find((a) => a.id === id) || null; }
function schemaOf(entry) { return { type: 'object', properties: entry.args, required: entry.required, additionalProperties: false }; }
/** Compact list for the AI: ids with their argument names (titles/schemas via the app_help tool). */
function catalogText(changes) {
  return ACTIONS.filter((a) => a.changes === !!changes).map((a) => `${a.id}${Object.keys(a.args).length ? `(${Object.keys(a.args).map((k) => (a.required.includes(k) ? k : `${k}?`)).join(',')})` : ''}`).join(' ');
}
/** Titles + argument schemas, for the app_help tool. */
function help(prefix) {
  const p = String(prefix || '');
  return ACTIONS.filter((a) => !p || a.id.startsWith(p)).map((a) => ({ action: a.id, tool: a.changes ? 'app_control' : 'app_info', title: a.title, args: a.args, required: a.required }));
}

module.exports = { ACTIONS, EXCLUDED, TOOL_CHANNELS, get, schemaOf, catalogText, help, SITES: S };
