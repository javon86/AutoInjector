'use strict';
// test/llm-main.test.js — the REAL main.js (mock Electron) with the B6 llm:* IPC block against a fake Ollama
// on the app's port: status / hardware / curated (built-in fallback when the model finder is absent) /
// search / pull with progress on the "llm" channel / use (Alfred + the old Butler) / remove / check / fix /
// cancel / the Hugging Face token (sealed, never in a log or event), and that no handler throws.
// Run: node test/llm-main.test.js
process.env.AUTOINJECTOR_BRIDGE = '0';
process.env.AUTOINJECTOR_CHECKIN = '0';
process.env.AUTOINJECTOR_AKOWE_SERVER = '0';
process.env.AUTOINJECTOR_SD_AUTOSTART = '0';
process.env.AUTOINJECTOR_VIDEO_AUTOSTART = '0';
process.env.AUTOINJECTOR_SAVE_DEBOUNCE_MS = '30';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-main-'));
process.env.AUTOINJECTOR_SD_HOME = path.join(TMP, 'sdhome');
process.env.AUTOINJECTOR_AKOWE_PORT = String(20000 + Math.floor(Math.random() * 20000));
const mockPath = path.join(__dirname, 'mock-electron.js');
const origLoad = Module._load;
Module._load = function (request) { if (request === 'electron') return require(mockPath); return origLoad.apply(this, arguments); };
const mock = require(mockPath);
mock.shell = { openPath: async () => '', openExternal: async () => {}, showItemInFolder: () => {} };
mock.Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => {} };

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }

function fakeOllama() {
  const st = { models: [], pulls: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const j = (() => { try { return JSON.parse(body || '{}'); } catch (_) { return {}; } })();
      const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/version') return send(200, { version: '0.5.7' });
      if (req.url === '/api/tags') return send(200, { models: st.models.map((m) => ({ name: m, size: 4 * 1024 ** 3, details: {} })) });
      if (req.url === '/api/delete') { st.models = st.models.filter((m) => m !== j.model); return send(200, {}); }
      if (req.url === '/api/pull') {
        st.pulls.push(j.model);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        for (let i = 1; i <= 4; i++) { res.write(JSON.stringify({ status: 'pulling x', digest: 'sha256:x', total: 1000, completed: i * 250 }) + '\n'); await sleep(90); }
        res.write(JSON.stringify({ status: 'success' }) + '\n');
        if (!st.models.includes(j.model)) st.models.push(j.model);
        return res.end();
      }
      if (req.url === '/v1/chat/completions') {
        if (j.tools) return send(200, { choices: [{ message: { content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'get_time', arguments: '{}' } }] } }] });
        return send(200, { choices: [{ message: { content: 'ready' } }] });
      }
      if (req.url === '/v1/models') return send(200, { data: st.models.map((m) => ({ id: m })) });
      send(404, {});
    });
  });
  return { st, server };
}

(async () => {
  const port = await freePort();
  process.env.AUTOINJECTOR_OLLAMA_HOST = `127.0.0.1:${port}`;
  const fake = fakeOllama();
  await new Promise((r) => fake.server.listen(port, '127.0.0.1', r));
  require('../main.js');
  await sleep(300);
  require('../output-manager').init(path.join(TMP, 'content'));
  const H = mock.__ipcHandlers;
  const call = (ch, ...a) => H[ch]({}, ...a);
  const events = [];
  const sent = [];
  const ui = mock.__registry['controls-ui'] || mock.__registry.controls || null;
  if (ui) ui.webContents.on('ipc-send', (channel, payload) => { sent.push([channel, payload]); if (channel === 'llm') events.push(payload); });

  console.log('\n== the llm:* channels exist ==');
  const CH = ['llm:status', 'llm:hardware', 'llm:check', 'llm:fix', 'llm:setup-all', 'llm:install-ollama', 'llm:start', 'llm:stop', 'llm:search', 'llm:curated', 'llm:hf-files', 'llm:pull', 'llm:cancel', 'llm:remove', 'llm:use', 'llm:hf-token'];
  assert(CH.every((c) => typeof H[c] === 'function'), `all ${CH.length} handlers registered`);

  console.log('\n== status / hardware / curated / search ==');
  let r = await call('llm:status');
  assert(r.ok && r.server.running && r.server.base === `http://127.0.0.1:${port}` && r.hfConnected === false, `status: the app's Ollama answers (${r.server.base})`);
  r = await call('llm:hardware');
  assert(r.ok && typeof r.line === 'string' && /Your PC/.test(r.line) && Array.isArray(r.gpus), `hardware (${r.line})`);
  r = await call('llm:curated', { uncensored: true });
  assert(r.ok && r.models.length >= 1 && r.models.every((m) => m.pullName && m.fit && m.fit.label), `curated: rated picks (${r.models.map((m) => m.pullName).join(', ')})`);
  r = await call('llm:search', 'qwen', { sources: ['ollama'] });
  assert(r && typeof r === 'object' && (r.ok || /isn't part of this build|internet|reach|search/i.test(r.error || JSON.stringify(r.errors || ''))), 'search answers (finder present) or says the finder is missing — never throws');
  r = await call('llm:hf-files', 'not a repo');
  assert(r && r.ok === false && typeof r.error === 'string', 'hf-files: bad input → plain error');

  console.log('\n== pull (progress on "llm") → use → check → remove ==');
  r = await call('llm:pull', 'llama3.3:70b', { sizeBytes: 400 * 1024 ** 3 });
  assert(!r.ok && r.tooBig && !fake.st.pulls.length, `pull(pullName, {sizeBytes}) refuses a too-big size (${r.error})`);
  r = await call('llm:pull', 'qwen2.5:7b', { sizeBytes: 1000 });
  assert(r.ok && fake.st.pulls.includes('qwen2.5:7b'), `pull (${r.message || r.error})`);
  const prog = events.filter((e) => e.type === 'progress' && e.task === 'pull');
  assert(!!ui && prog.length >= 2 && prog.some((e) => e.percent > 0 && e.percent < 100) && prog.every((e) => e.pullName === 'qwen2.5:7b'), `progress events on the "llm" channel (${prog.map((e) => e.percent).join(',')})`);
  r = await call('llm:use', { name: 'qwen2.5:7b' });
  assert(r.ok && r.test && r.test.ok, `use (${r.message || r.error})`);
  const al = await call('alfred:status');
  assert(al.settings.local.model === 'qwen2.5:7b' && al.settings.local.endpoint === `http://127.0.0.1:${port}/v1`, 'Alfred now points at it');
  const ms = await call('manager:get-state');
  assert(ms.managerConfig.model === 'qwen2.5:7b' && ms.managerConfig.provider === 'openai-compatible' && /\/v1\/chat\/completions$/.test(ms.managerConfig.endpoint), 'so does the old Butler (lsi-* settings)');
  r = await call('llm:check', { quick: true });
  assert(Array.isArray(r.rows) && r.rows.find((x) => x.id === 'alfred-model').ok === true && r.rows.find((x) => x.id === 'installed').ok === false, 'check: Alfred\'s model ✔; Ollama not installed on this machine → ✖ (honest)');
  r = await call('llm:remove', 'qwen2.5:7b');
  assert(r.ok && !fake.st.models.length, 'remove');

  console.log('\n== fix / cancel / start / stop / install never throw ==');
  r = await call('llm:fix', { action: 'nope' });
  assert(r.ok === false && /don't know/.test(r.error), 'unknown fix → plain error');
  r = await call('llm:cancel');
  assert(r.ok && r.cancelled === false, 'cancel with nothing running');
  r = await call('llm:start');
  assert(r.ok && r.already, 'start: reuses the one answering');
  r = await call('llm:stop');
  assert(r.ok, 'stop: answers');

  console.log('\n== the Hugging Face token: sealed, never logged or broadcast ==');
  r = await call('llm:hf-token', { token: 'nope' });
  assert(r.ok === false && /hf_/.test(r.error), 'a bad token → plain error');
  const TOKEN = 'hf_SuperSecretToken12345';
  r = await call('llm:hf-token', { token: TOKEN });
  assert(r.ok && r.connected && r.persisted && !JSON.stringify(r).includes(TOKEN), 'connected + stored encrypted; the token isn\'t echoed back');
  const file = path.join(mock.__userDataDir, 'llm-secrets.json');
  assert(fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(TOKEN), 'the file holds only the sealed token');
  r = await call('llm:status');
  assert(r.hfConnected === true && !JSON.stringify(r).includes(TOKEN), 'status says connected, without the token');
  await sleep(100);
  const st = await call('state:get');
  assert(!JSON.stringify(st).includes(TOKEN) && !JSON.stringify(sent).includes(TOKEN), 'not in the app state/log or any event');
  let dbg = ''; try { dbg = fs.readFileSync(path.join(mock.__userDataDir, 'autoinjector-debug.log'), 'utf8'); } catch (_) {}
  assert(!dbg.includes(TOKEN), 'not in the debug log');
  r = await call('llm:hf-token', { clear: true });
  assert(r.ok && !r.connected && (await call('llm:status')).hfConnected === false, 'disconnect');

  console.log('\n== bad input everywhere: an object back, never a throw ==');
  let threw = false;
  for (const c of CH.filter((x) => !['llm:setup-all', 'llm:install-ollama', 'llm:fix'].includes(x))) {
    try { const o = await call(c, { weird: { deep: 1 } }, 42); if (!o || typeof o !== 'object') { threw = true; console.log('   no object from', c); } } catch (e) { threw = true; console.log('   threw:', c, e); }
  }
  assert(!threw, 'every llm:* handler returns an object for nonsense input');

  fake.server.closeAllConnections && fake.server.closeAllConnections();
  fake.server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL - crashed', e); process.exit(1); });
