'use strict';
// test/llm-speed.test.js — the speed Alfred MEASURES on real replies (llm-speed.js): Ollama's eval_count /
// eval_duration become tokens/second per model, a running average, short replies ignored, names matched like
// Ollama does, kept across restarts in a small file — and alfred-ai.js records it from /api/chat.
// Run: node test/llm-speed.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const speed = require('../llm-speed');
const ai = require('../alfred-ai');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

(async () => {
  console.log('\n== recording ==');
  speed.reset();
  let r = speed.recordOllama('qwen2.5:7b', { eval_count: 200, eval_duration: 4e9 });
  assert(r && r.tokensPerSec === 50 && r.samples === 1, '200 tokens in 4 s → 50 tokens/s');
  speed.recordOllama('qwen2.5:7b', { eval_count: 100, eval_duration: 4e9 });
  assert(speed.get('qwen2.5:7b').tokensPerSec === 37.5 && speed.get('qwen2.5:7b').samples === 2, 'a running average (50, 25 → 37.5)');
  assert(speed.recordOllama('qwen2.5:7b', { eval_count: 3, eval_duration: 1e8 }) === null && speed.get('qwen2.5:7b').samples === 2, 'a very short reply (< 8 tokens) is ignored');
  assert(speed.recordOllama('x', {}) === null && speed.recordOllama('x', { eval_count: 50, eval_duration: 0 }) === null && speed.record('', 5) === null && speed.record('x', -1) === null, 'missing or bad numbers are ignored, never thrown');
  speed.record('Mistral', 12);
  assert(speed.get('mistral:latest').tokensPerSec === 12 && speed.get('MISTRAL').tokensPerSec === 12, 'names match like Ollama (case, ":latest")');
  assert(Object.keys(speed.all()).sort().join() === 'mistral:latest,qwen2.5:7b', 'all() lists every model');

  console.log('\n== kept across restarts ==');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-speed-'));
  const file = path.join(dir, 'llm-speeds.json');
  speed.reset();
  speed.configure({ file });
  speed.record('llama3.1:8b', 30);
  assert(fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8'))['llama3.1:8b'].tokensPerSec === 30, 'saved to the file');
  speed.reset();
  speed.record('qwen3:8b', 40); // measured before the file was opened
  speed.configure({ file });
  assert(speed.get('llama3.1:8b').tokensPerSec === 30 && speed.get('qwen3:8b').tokensPerSec === 40, 'read back after a restart, joined with what was measured before');
  fs.writeFileSync(file, '{not json');
  speed.reset(); speed.configure({ file });
  assert(Object.keys(speed.all()).length === 0, 'a broken file → start fresh, no crash');
  speed.configure({ file: null });
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('\n== Alfred records it from Ollama\'s /api/chat ==');
  speed.reset();
  ai._resetOllamaCache();
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = (() => { try { return JSON.parse(body || '{}'); } catch (_) { return {}; } })();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.12.3' }));
      return res.end(JSON.stringify({ model: j.model, message: { role: 'assistant', content: 'Hello.' }, eval_count: 120, eval_duration: 3e9 }));
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const ep = `http://127.0.0.1:${srv.address().port}/v1`;
  const out = await ai.next({ kind: 'local', endpoint: ep, model: 'qwen2.5:7b', timeoutMs: 5000 }, [{ role: 'user', content: 'hi' }], []);
  assert(out.ok && out.message.content === 'Hello.', 'the reply still comes through');
  assert(speed.get('qwen2.5:7b') && speed.get('qwen2.5:7b').tokensPerSec === 40, `120 tokens in 3 s recorded as 40 tokens/s (${JSON.stringify(speed.get('qwen2.5:7b'))})`);
  srv.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
