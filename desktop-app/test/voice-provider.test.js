// test/voice-provider.test.js — the local voice adapter (N2). Checks settings,
// status, speak/listen guards, a real speak+listen against a stub voice server,
// and the managed-mode guard. No real TTS/STT needed. Run: node test/voice-provider.test.js
const http = require('http');
const vp = require('../voice-provider');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

// A stub voice shim: /health, /speak echoes ms, /listen returns a fixed transcript.
function makeStub() {
  return http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(body || '{}'); } catch (_) {}
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url.replace(/\/$/, '') === '/health') return send(200, { ok: true, service: 'voice-shim' });
      if (req.method === 'POST' && req.url === '/speak') return j.text ? send(200, { ok: true, ms: 12 }) : send(400, { ok: false, error: 'NEED_TEXT' });
      if (req.method === 'POST' && req.url === '/listen') return send(200, { ok: true, text: `heard ${j.seconds || 6}s` });
      send(404, { ok: false, error: 'NOT_FOUND' });
    });
  });
}

async function main() {
  console.log('\n== settings + status ==');
  vp.setSettings({ enabled: false, endpoint: '', speakOnAck: true });
  let s = vp.status();
  assert(s.configured === false && s.enabled === false, 'status reflects unconfigured/disabled');
  const set = vp.setSettings({ listenSeconds: 999 });
  assert(set.listenSeconds === 60, 'listenSeconds is clamped to <= 60');
  assert(vp.setSettings({ listenSeconds: 0 }).listenSeconds === 1, 'listenSeconds is clamped to >= 1');

  console.log('\n== guards: disabled / no endpoint / empty text ==');
  assert((await vp.speak('hi')).error === 'VOICE_DISABLED', 'speak while disabled -> VOICE_DISABLED');
  assert((await vp.listen({})).error === 'VOICE_DISABLED', 'listen while disabled -> VOICE_DISABLED');
  vp.setSettings({ enabled: true, endpoint: '' });
  assert((await vp.speak('hi')).error === 'NO_ENDPOINT', 'enabled but no endpoint -> NO_ENDPOINT');
  assert((await vp.speak('')).error === 'NEED_TEXT', 'empty text -> NEED_TEXT');

  console.log('\n== speak + listen against a stub voice server ==');
  const server = makeStub();
  const port = await listen(server);
  vp.setSettings({ enabled: true, endpoint: `http://127.0.0.1:${port}`, speakOnAck: true });
  const spoke = await vp.speak('hello there');
  assert(spoke.ok === true && spoke.ms === 12, 'speak posts /speak and returns the shim result');
  const heard = await vp.listen({ seconds: 5 });
  assert(heard.ok === true && heard.text === 'heard 5s', 'listen posts /listen and returns the transcript');
  assert(vp.status().enabled && vp.status().speakOnAck, 'status shows enabled + speakOnAck after config');
  server.close();

  console.log('\n== managed mode requires a command ==');
  assert((await vp.startManaged({})).error === 'NO_COMMAND', 'startManaged with no command -> NO_COMMAND');
  assert(vp.stopManaged().ok === true, 'stopManaged is a safe no-op when nothing is running');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
