// test/mcp-client.test.js — the MCP client (mcp-client.js), the saved tool servers (mcp-manager.js) and the
// tool-provider registration, against a fake stdio MCP server and a fake Streamable-HTTP one (test/fixtures).
// No Electron needed. Run: node test/mcp-client.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMcpClient, formatContent, makeRedactor, splitCommandLine, PROTOCOL_VERSION } = require('../mcp-client');
const { createMcpManager, parseSecrets } = require('../mcp-manager');
const tp = require('../tool-provider');
const { startFakeMcpHttp } = require('./fixtures/fake-mcp-http');

const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); } return null; }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const stdio = (extra = {}) => createMcpClient(Object.assign({ name: 'fake', transport: 'stdio', command: process.execPath, args: [FAKE], timeoutMs: 5000, initTimeoutMs: 5000, restartDelayMs: 50 }, extra));

async function main() {
  console.log('\n== helpers ==');
  assert(JSON.stringify(splitCommandLine('npx -y "@scope/server fs" \'C:\\My Docs\' plain')) === JSON.stringify(['npx', '-y', '@scope/server fs', 'C:\\My Docs', 'plain']), 'splitCommandLine keeps quoted parts together');
  const red = makeRedactor(['s3cr3t-value']);
  const r1 = red('token=abcdef123 and s3cr3t-value and Authorization: Bearer abc.def.ghi and sk-ABCDEFGHIJKLMNOP1234 https://u:p4ss@host/x');
  assert(!/s3cr3t-value|abcdef123|abc\.def\.ghi|sk-ABCDEFGH|p4ss/.test(r1), `the redactor hides given secrets and things that look like keys (${r1})`);
  const fc = formatContent({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'resource', resource: { uri: 'x://1', text: 'inner' } }, { type: 'resource_link', uri: 'x://2', name: 'two' }], structuredContent: { n: 1 } }, { saveImage: () => '/tmp/pic.png' });
  assert(/a/.test(fc.text) && fc.images[0].path === '/tmp/pic.png' && /inner/.test(fc.text) && fc.resources.length === 2 && fc.structured.n === 1, 'formatContent: text joined, pictures saved, resources included, links listed, structured kept');

  console.log('\n== stdio: initialize, tools/list with a cursor, tools/call ==');
  const saved = [];
  const c = stdio({ saveImage: (buf, mime) => { const p = path.join(TMP, `pic-${saved.length}.png`); fs.writeFileSync(p, buf); saved.push({ p, mime }); return p; } });
  const s = await c.start();
  assert(s.ok && c.status().status === 'connected', `connects (${s.message || 'ok'})`);
  assert(c.status().serverInfo && c.status().serverInfo.name === 'fake-mcp', 'reads serverInfo from initialize');
  assert(s.tools && s.tools.length === 8, `follows nextCursor through every page of tools/list (${s.tools && s.tools.length} tools)`);
  let r = await c.callTool('echo', { text: 'hello' });
  assert(r.ok && r.text === 'echo: hello', 'tools/call echo → its text');
  r = await c.callTool('add', { a: 2, b: 3 });
  assert(r.ok && r.text === '5' && r.structured && r.structured.sum === 5, 'structuredContent is kept');
  r = await c.callTool('picture', {});
  assert(r.ok && r.images.length === 1 && saved.length === 1 && fs.statSync(saved[0].p).size > 50 && /saved/.test(r.text), 'an image result is saved to a file and named in the text');
  r = await c.callTool('doc', {});
  assert(r.ok && /note text/.test(r.text) && r.resources.some((x) => x.link && x.uri === 'file:///notes/b.txt'), 'an embedded resource\'s text and a resource link come through');
  r = await c.callTool('fail', {});
  assert(!r.ok && r.error === 'TOOL_ERROR' && /disk is full/.test(r.message), 'isError results → ok:false with the server\'s words');
  r = await c.callTool('nope', {});
  assert(!r.ok && r.error === 'UNKNOWN_TOOL', 'an unknown tool is refused before anything is sent');
  r = await c.callTool('slow', { ms: 2000 }, { timeoutMs: 300 });
  assert(!r.ok && r.error === 'TIMEOUT' && /didn't answer in/.test(r.message), 'a slow call times out with a plain sentence');
  r = await c.callTool('echo', { text: 'still here' });
  assert(r.ok, 'the server keeps working after a timed-out call');

  console.log('\n== stdio: crash → restart (bounded), clean stop ==');
  const starts = path.join(TMP, 'starts.txt');
  const c2 = stdio({ env: { FAKE_MCP_STARTS: starts }, maxRestarts: 2, restartWindowMs: 60000 });
  await c2.start();
  const pid1 = c2.status().pid;
  r = await c2.callTool('crash', {});
  assert(!r.ok && /stopped/.test(r.message) && /crashing on purpose/.test(r.message), `a crash during a call fails that call with what the server said (${r.message})`);
  assert(await until(() => c2.status().status === 'connected' && c2.status().pid !== pid1, 4000), 'the crashed server is restarted and connects again');
  assert(fs.readFileSync(starts, 'utf8').trim().split('\n').length === 2, 'it was started twice');
  r = await c2.callTool('echo', { text: 'back' });
  assert(r.ok && r.text === 'echo: back', 'calls work after the restart');
  await c2.callTool('crash', {});
  await until(() => c2.status().status === 'connected', 4000);
  await c2.callTool('crash', {});
  assert(await until(() => c2.status().status === 'error', 4000) && c2.status().error === 'KEEPS_CRASHING' && /stopped restarting/.test(c2.status().message), 'after maxRestarts it gives up with a plain message');
  const pid = c.status().pid;
  await c.stop();
  assert(c.status().status === 'stopped' && !(await until(() => alive(pid), 300)), 'stop() ends the server process cleanly');
  r = await c.callTool('echo', { text: 'x' });
  assert(!r.ok && r.error === 'NOT_CONNECTED', 'a stopped server says so');

  console.log('\n== stdio: start errors in plain words, secrets never shown ==');
  let e = await createMcpClient({ name: 'missing', command: 'definitely-not-a-program-xyz', args: [], initTimeoutMs: 3000 }).start();
  assert(!e.ok && /isn't installed/.test(e.message), `a program that isn't there → "${e.message}"`);
  e = await stdio({ env: { FAKE_MCP_MODE: 'die', FAKE_TOKEN: 'tok-SUPERSECRET-123' } }).start();
  assert(!e.ok && /exit code 2/.test(e.message) && /rejected/.test(e.message), `a server that exits at once → its stderr in the message (${e.message})`);
  assert(!/SUPERSECRET/.test(e.message), 'the env secret is redacted from that stderr');
  e = await stdio({ env: { FAKE_MCP_MODE: 'noinit' }, initTimeoutMs: 400 }).start();
  assert(!e.ok && e.error === 'TIMEOUT' && /didn't answer/.test(e.message), 'a program that never answers initialize times out');
  const c3 = stdio({ env: { FAKE_TOKEN: 'tok-HIDDEN-987654' }, maxRestarts: 0 });
  await c3.start();
  r = await c3.callTool('leak', {});
  await until(() => c3.status().status === 'error', 3000);
  const all = JSON.stringify([r, c3.status()]);
  assert(/oops my token is/.test(all) && !/HIDDEN-987654/.test(all), 'stderr captured for errors never shows the secret');
  await c3.stop();

  console.log('\n== Streamable HTTP: JSON and SSE answers, sessions, headers ==');
  const h = await startFakeMcpHttp({ token: 'web-TOKEN-55555', sse: true });
  const hc = createMcpClient({ name: 'web', transport: 'http', url: h.url, headers: { Authorization: 'Bearer web-TOKEN-55555' }, timeoutMs: 3000 });
  const hs = await hc.start();
  assert(hs.ok && hs.tools.length === 2, `connects over HTTP and pages tools/list (${hs.tools && hs.tools.length})`);
  const init = h.state.requests.find((x) => x.method === 'initialize');
  assert(init && /text\/event-stream/.test(init.accept) && /application\/json/.test(init.accept), 'POSTs accept JSON and SSE');
  const later = h.state.requests.filter((x) => x.method !== 'initialize');
  assert(later.length && later.every((x) => x.session === 's1' && x.protocol === PROTOCOL_VERSION), 'later requests carry Mcp-Session-Id and MCP-Protocol-Version');
  r = await hc.callTool('shout', { text: 'hi there' });
  assert(r.ok && r.text === 'HI THERE', 'a tools/call answered as an SSE stream works');
  h.forgetSessions();
  r = await hc.callTool('shout', { text: 'again' });
  assert(r.ok && r.text === 'AGAIN' && h.state.requests.filter((x) => x.method === 'initialize').length === 2, 'an expired session (404) → one new session and a retry');
  await hc.stop();
  assert(h.state.deleted === 1, 'stop() ends the HTTP session (DELETE)');
  const bad = await createMcpClient({ name: 'web', transport: 'http', url: h.url, headers: { Authorization: 'Bearer wrong-token-123456' }, timeoutMs: 2000 }).start();
  assert(!bad.ok && bad.error === 'UNAUTHORIZED' && /check the key or token/.test(bad.message) && !/wrong-token/.test(bad.message), 'a refused key → a plain sentence, the key not shown');
  await h.close();
  const h2 = await startFakeMcpHttp({ sse: true, keepOpen: true });
  const hc2 = createMcpClient({ name: 'web2', transport: 'http', url: h2.url, timeoutMs: 2000 });
  await hc2.start();
  r = await hc2.callTool('shout', { text: 'open' });
  assert(r.ok && r.text === 'OPEN', 'an SSE stream that stays open is closed once our answer arrived');
  await hc2.stop(); await h2.close();
  const down = await createMcpClient({ name: 'down', transport: 'http', url: 'http://127.0.0.1:1/mcp', timeoutMs: 1500 }).start();
  assert(!down.ok && /Nothing is answering/.test(down.message), 'nothing at the address → "Nothing is answering at …"');

  console.log('\n== saved servers (mcp-manager): add, secrets sealed, start/stop/remove, tool-provider ==');
  const ps = parseSecrets('API_KEY=abc123\n# comment\nAuthorization: Bearer x\n\nnot a line');
  assert(ps.env.API_KEY === 'abc123' && ps.headers.Authorization === 'Bearer x' && ps.bad.length === 1, 'secret lines: NAME=value → env, Header: value → headers, the rest reported');
  const file = path.join(TMP, 'servers.json');
  const seal = (v) => `SEALED(${Buffer.from(v).toString('hex')})`;
  const open = (v) => { const m = /^SEALED\(([0-9a-f]*)\)$/.exec(v); return m ? Buffer.from(m[1], 'hex').toString() : ''; };
  const logs = [];
  const m = createMcpManager({ file, seal, open, toolProvider: tp, log: (k, d) => logs.push(JSON.stringify(d)), timeoutMs: 4000, initTimeoutMs: 4000, clientOptions: { restartDelayMs: 50 } });
  assert(m.list().servers.length === 0, 'off by default: no servers, nothing runs');
  let a = m.add({ name: 'files', line: `"${process.execPath}" "${FAKE}"`, secrets: 'FAKE_TOKEN=tok-MANAGER-4242' });
  assert(a.ok && a.server.transport === 'stdio' && a.server.envKeys[0] === 'FAKE_TOKEN', 'adds a command-line server');
  assert(!m.add({ name: 'Files', line: 'x' }).ok, 'names are unique');
  const w = m.add({ name: 'web', line: 'http://127.0.0.1:9/mcp?api_key=QQQQ-secret-1', secrets: 'Authorization: Bearer hdr-SECRET-777' });
  assert(w.ok && w.server.transport === 'http' && w.server.headerKeys[0] === 'Authorization' && !/QQQQ|hdr-SECRET/.test(JSON.stringify(m.list())), 'adds a web-address server; its header and the key in its URL are never shown');
  m.remove('web');
  assert(!m.add({ name: 'bad', line: 'node x', secrets: 'Authorization: Bearer y' }).ok, 'header lines on a program server are refused with a reason');
  const disk = fs.readFileSync(file, 'utf8');
  assert(!/tok-MANAGER-4242/.test(disk) && /SEALED\(/.test(disk), 'the env secret is sealed on disk, never plain text');
  assert(!/tok-MANAGER-4242/.test(JSON.stringify(m.list())), 'the public list never shows a secret value');
  let st = await m.start('files');
  assert(st.ok && /connected · 8 tools/.test(st.server.summary), `start → "${st.server && st.server.summary}"`);
  assert(tp.has('mcp:files/echo') && tp.get('mcp:files/echo').risk === 'ask', 'its tools are registered in tool-provider as mcp:files/<tool>, risk "ask"');
  const viaTp = await tp.run('mcp:files/echo', { text: 'butler' });
  assert(viaTp.ok && viaTp.message === 'echo: butler', 'the butler\'s USE_TOOL path (tool-provider.run) reaches the server');
  const tl = m.tools();
  assert(tl.tools.length === 8 && tl.tools[0].inputSchema && tl.tools[0].server === 'files', 'tools() lists the tools with their input schemas');
  r = await m.call('files', 'add', { a: 1, b: 1 });
  assert(r.ok && r.text === '2', 'call() reaches the tool');
  await m.stop('files');
  assert(!tp.has('mcp:files/echo') && m.find('files').status === 'stopped', 'stop → stopped and its tools leave the registry');
  r = await m.call('files', 'echo', { text: 'wake' });
  assert(r.ok && r.text === 'echo: wake', 'a call to a stopped server starts it first');
  // a fresh manager (= the app restarted) reads the file, opens the secret, starts the enabled server
  const m2 = createMcpManager({ file, seal, open, timeoutMs: 4000 });
  const as = await m2.autoStart();
  assert(as.started === 1 && m2.find('files').status === 'connected', 'after a restart the enabled server starts again with its secret');
  const leak = await m2.call('files', 'leak', {});
  assert(!/tok-MANAGER-4242/.test(JSON.stringify([leak, m2.list()])), 'the reopened secret is still redacted from stderr');
  await m2.stopAll();
  const m3 = createMcpManager({ file: path.join(TMP, 'plain.json'), seal: () => null, open: () => '' });
  a = m3.add({ name: 'nokeychain', line: 'node x.js', secrets: 'K=value-123456' });
  assert(a.ok && a.server.secretsNotSaved && /only until AutoInjector closes/.test(a.message) && !/value-123456/.test(fs.readFileSync(path.join(TMP, 'plain.json'), 'utf8')), 'without a keychain the secret is kept for this session only, never written');
  await m.remove('files');
  assert(m.list().servers.length === 0 && !/files/.test(fs.readFileSync(file, 'utf8')), 'remove deletes it from the list and the file');
  assert(!logs.some((l) => /tok-MANAGER-4242/.test(l)), 'nothing logged contains the secret');
  assert(tp.registerMcpServer({}).ok === false, 'registerMcpServer without a server → NEED_SERVER');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
