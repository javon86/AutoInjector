// test/voice-provider.test.js — the local voice adapter (N2). Checks settings,
// status, speak/listen guards, a real speak+listen against a stub voice server,
// and the managed-mode guard. No real TTS/STT needed. Run: node test/voice-provider.test.js
const http = require('http');
const vp = require('../voice-provider');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
// A port with nothing listening on it (bind, read the port, close).
async function deadPort() { const s = http.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; }

// A stub voice shim: /health, /speak echoes ms, /listen returns a fixed transcript.
function makeStub() {
  return http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(body || '{}'); } catch (_) {}
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url.replace(/\/$/, '') === '/health') return send(200, { ok: true, service: 'voice-shim' });
      if (req.method === 'POST' && req.url === '/speak') return j.text ? send(200, { ok: true, ms: 12, voice: j.voice || '', device: j.device || '' }) : send(400, { ok: false, error: 'NEED_TEXT' });
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

  console.log('\n== a distinct voice per speaker + output device ==');
  vp.setSettings({ voices: { butler: 'en_US-butler', chatgpt: 'en_US-chatgpt' }, speakerDevice: 'spk-2' });
  const st = vp.status();
  assert(st.voices.butler === 'en_US-butler' && st.voices.chatgpt === 'en_US-chatgpt', 'per-speaker voices round-trip through status()');
  const asButler = await vp.speak('hi', { who: 'butler' });
  assert(asButler.ok && asButler.voice === 'en_US-butler' && asButler.device === 'spk-2', 'speak({who:"butler"}) sends the butler voice + the chosen output device');
  const asChat = await vp.speak('hi', { who: 'chatgpt' });
  assert(asChat.voice === 'en_US-chatgpt', 'speak({who:"chatgpt"}) sends a DIFFERENT voice — each speaker sounds distinct');
  const override = await vp.speak('hi', { voice: 'custom-voice' });
  assert(override.voice === 'custom-voice', 'an explicit voice override wins');
  server.close();

  console.log('\n== OP-12: plain-language errors instead of a raw ECONNREFUSED ==');
  assert(!spoke.message && !heard.message, 'a successful speak/listen carries no error message');
  vp.setSettings({ enabled: false });
  const off = await vp.speak('hi');
  assert(off.error === 'VOICE_DISABLED' && /turned off/i.test(off.message || ''), 'VOICE_DISABLED comes with a plain "voice is turned off" message');
  vp.setSettings({ enabled: true, endpoint: '' });
  const noEp = await vp.speak('hi');
  assert(noEp.error === 'NO_ENDPOINT' && /No voice service address/i.test(noEp.message || '') && /8232/.test(noEp.message), 'NO_ENDPOINT says no address is set and suggests the default one');
  vp.setSettings({ endpoint: 'not a url' });
  assert(/isn't a valid web address/.test((await vp.speak('hi')).message || ''), 'BAD_ENDPOINT explains the address is not valid');
  const dead = await deadPort();
  const deadEp = `http://127.0.0.1:${dead}`;
  vp.setSettings({ enabled: true, endpoint: deadEp });
  const refused = await vp.speak('hello');
  assert(refused.ok === false && refused.error === 'ECONNREFUSED', 'speak to a dead address keeps the short code ECONNREFUSED in error');
  const m = refused.message || '';
  assert(m.includes(deadEp), 'the message names the address it tried');
  assert(/isn't running/i.test(m), 'the message says the voice service is not running');
  assert(/Setup Wizard/.test(m) && /voice_shim\.py/.test(m), 'the message says how to start it');
  assert(/change the voice address/i.test(m) && /Voice settings/.test(m), 'the message says where to change the address');
  assert(!/^ECONNREFUSED/.test(m), 'the message is plain words, not the raw socket code');
  const refusedListen = await vp.listen({ seconds: 2 });
  assert(refusedListen.error === 'ECONNREFUSED' && refusedListen.message && refusedListen.message.includes(deadEp), 'listen gets the same plain message');
  assert(/try 127\.0\.0\.1 instead of "localhost"/.test(vp.explainError({ error: 'ECONNREFUSED' }, 'http://localhost:8232')), 'a refused "localhost" address suggests 127.0.0.1 (IPv6 ::1 vs IPv4 shim)');
  assert(!/instead of "localhost"/.test(m), 'no localhost hint for a 127.0.0.1 address');
  assert(/didn't answer in time/.test(vp.explainError({ error: 'TIMEOUT' }, deadEp)), 'TIMEOUT has a plain message');
  assert(/can't be found/.test(vp.explainError({ error: 'ENOTFOUND' }, 'http://nope:8232')), 'ENOTFOUND has a plain message');
  assert(/HTTP 500: model missing/.test(vp.explainError({ error: 'HTTP_500', body: '{"error":"model missing"}' }, deadEp)), 'an HTTP error includes the service\'s reason');

  console.log('\n== OP-12: checkConnection() — a cheap GET /health ==');
  const chkDead = await vp.checkConnection({ timeoutMs: 1000 });
  assert(chkDead.ok === false && chkDead.reachable === false && chkDead.error === 'ECONNREFUSED' && chkDead.endpoint === deadEp, 'a dead address is reported unreachable with the code + address');
  assert(/isn't running/.test(chkDead.message || ''), 'and with the plain "not running" message');
  const server2 = makeStub();
  const port2 = await listen(server2);
  vp.setSettings({ endpoint: `http://127.0.0.1:${port2}` });
  const chkUp = await vp.checkConnection();
  assert(chkUp.ok === true && chkUp.reachable === true && /running/.test(chkUp.message), 'a running voice shim is reported reachable');
  server2.close();
  const other = http.createServer((req, res) => { res.writeHead(404); res.end('not here'); });
  const port3 = await listen(other);
  vp.setSettings({ endpoint: `http://127.0.0.1:${port3}` });
  const chkOther = await vp.checkConnection();
  assert(chkOther.ok === false && chkOther.error === 'HTTP_404' && /isn't the AutoInjector voice service/.test(chkOther.message || ''), 'some other server at the address is called out as not the voice service');
  other.close();
  vp.setSettings({ endpoint: '' });
  assert((await vp.checkConnection()).error === 'NO_ENDPOINT', 'checkConnection with no address -> NO_ENDPOINT');
  assert(vp.status().lastStartError === '', 'status() reports no managed-start error by default');

  console.log('\n== settings round-trip (what the app persists + restores) ==');
  const want = { enabled: true, endpoint: 'http://127.0.0.1:8299', speakOnAck: false, listenSeconds: 9, voices: { butler: 'en_US-amy', chatgpt: '', claude: 'en_GB-alan', gemini: '' }, micDevice: 'mic-1', speakerDevice: 'spk-2', timeoutMs: 30000 };
  vp.setSettings(want);
  const saved = JSON.parse(JSON.stringify(vp.getSettings())); // as written to autoinjector-state.json
  vp.setSettings({ enabled: false, endpoint: '', speakOnAck: true, listenSeconds: 6, voices: { butler: '', chatgpt: '', claude: '', gemini: '' }, micDevice: '', speakerDevice: '', timeoutMs: 60000 });
  vp.setSettings(saved); // as restored on startup
  assert(JSON.stringify(vp.getSettings()) === JSON.stringify(want), 'getSettings() -> JSON -> setSettings() restores every voice setting exactly');
  assert(!Object.keys(saved).some((k) => /key|token|secret|password/i.test(k)), 'the persisted voice settings hold no secret fields');
  assert(vp.status().managed === false, 'restoring settings never starts the voice shim');
  vp.setSettings({ enabled: false, endpoint: '' });

  console.log('\n== managed mode requires a command ==');
  assert((await vp.startManaged({})).error === 'NO_COMMAND', 'startManaged with no command -> NO_COMMAND');
  assert(vp.stopManaged().ok === true, 'stopManaged is a safe no-op when nothing is running');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
