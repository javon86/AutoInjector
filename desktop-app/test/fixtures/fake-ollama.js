'use strict';
// test/fixtures/fake-ollama.js — a fake Ollama HTTP server for tests (no real Ollama, no network):
//   GET /api/version, GET /api/tags, POST /api/pull (NDJSON progress), DELETE /api/delete,
//   POST /v1/chat/completions (native tool calls, the text tool protocol, or a plain answer).
// fakeOllama(port) -> { st, port, base, up(), down(), running }. `st` is live state the test can poke:
//   models [{name,size}], version, pulls[], deletes[], chats[], nativeTools, textTools,
//   pullMode ('ok'|'slow'|'missing'|'secret'|'cut'), pullSize (bytes), pullDelayMs (per step), answer.
// Used by test/llm-setup.test.js and the real-Electron test/e2e/llm-setup.e2e.js.
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeOllama(port) {
  const st = {
    models: [], version: '0.5.7', pulls: [], deletes: [], chats: [], nativeTools: true, textTools: true,
    pullMode: 'ok', pullSize: 4 * 1024 * 1024, answer: 'ready',
  };
  let server = null;
  const sockets = new Set();
  function handler(req, res) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const j = (() => { try { return JSON.parse(body || '{}'); } catch (_) { return {}; } })();
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/version') return send(200, { version: st.version });
      if (req.url === '/api/tags') return send(200, { models: st.models.map((m) => ({ name: m.name, model: m.name, size: m.size, modified_at: '2026-01-01T00:00:00Z', details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' } })) });
      if (req.url === '/api/delete' && req.method === 'DELETE') {
        st.deletes.push(j.model || j.name);
        const i = st.models.findIndex((m) => m.name === (j.model || j.name));
        if (i < 0) return send(404, { error: 'model not found' });
        st.models.splice(i, 1); return send(200, {});
      }
      if (req.url === '/api/pull' && req.method === 'POST') {
        st.pulls.push(j.model || j.name);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const w = (o) => res.write(JSON.stringify(o) + '\n');
        w({ status: 'pulling manifest' });
        if (st.pullMode === 'missing') { w({ error: 'pull model manifest: file does not exist' }); return res.end(); }
        if (st.pullMode === 'secret') { w({ error: 'unauthorized: token hf_SECRETTOKEN12345 rejected' }); return res.end(); }
        const total = st.pullSize, steps = st.pullMode === 'slow' ? 40 : 8;
        for (let i = 1; i <= steps; i++) {
          if (res.destroyed) return;
          w({ status: 'pulling abc123', digest: 'sha256:abc123', total, completed: Math.round((total * i) / steps) });
          await sleep(st.pullDelayMs != null ? st.pullDelayMs : st.pullMode === 'slow' ? 60 : 30);
        }
        if (st.pullMode === 'cut') return res.end(); // ends without success
        w({ status: 'verifying sha256 digest' }); w({ status: 'writing manifest' }); w({ status: 'success' });
        if (!st.models.some((m) => m.name === (j.model || j.name))) st.models.push({ name: j.model || j.name, size: total });
        return res.end();
      }
      // loading a model into memory (an empty prompt): answers at once, like a real Ollama with the model loaded
      if (req.url === '/api/generate' && req.method === 'POST') { st.warmed = (st.warmed || 0) + 1; return send(200, { model: 'x', response: '', done: true, done_reason: 'load' }); }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        st.chats.push(j);
        if (!st.models.some((m) => m.name === j.model || m.name === `${j.model}:latest`)) return send(404, { error: { message: `model "${j.model}" not found, try pulling it first` } });
        if (j.tools) {
          if (st.nativeTools) return send(200, { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_time', arguments: '{}' } }] } }] });
          return send(400, { error: { message: `${j.model} does not support tools` } });
        }
        const sys = (j.messages || []).find((m) => m.role === 'system');
        if (sys && /exactly ONE JSON object/.test(sys.content)) return send(200, { choices: [{ message: { role: 'assistant', content: st.textTools ? '{"tool": "get_time", "args": {}}' : 'It is noon.' } }] });
        return send(200, { choices: [{ message: { role: 'assistant', content: st.answer } }] });
      }
      send(404, { error: 'not found' });
    });
  }
  return {
    st, port, base: `http://127.0.0.1:${port}`,
    up() { return new Promise((resolve) => { if (server) return resolve(); server = http.createServer(handler); server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); }); server.listen(port, '127.0.0.1', resolve); }); },
    down() { return new Promise((resolve) => { if (!server) return resolve(); for (const s of sockets) s.destroy(); server.close(() => resolve()); server = null; }); },
    get running() { return !!server; },
  };
}

module.exports = { fakeOllama };
