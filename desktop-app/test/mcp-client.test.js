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

  console.log('\n== Windows: the whole process tree is ended (taskkill /T /F), not just cmd.exe ==');
  {
    const cp = require('child_process');
    const killed = []; let plainKills = 0;
    const wspawn = (cmdLine, args, opts) => { // shell:true on Windows: start the fake server, and spy on ch.kill()
      const ch = cp.spawn(process.execPath, [FAKE], { stdio: opts.stdio });
      const orig = ch.kill.bind(ch); ch.kill = (sig) => { plainKills++; return orig(sig); };
      return ch;
    };
    const wexec = (cmd, args, o2, cb) => { killed.push([cmd, ...args].join(' ')); try { process.kill(Number(args[1]), 'SIGKILL'); } catch (_) {} if (cb) setImmediate(() => cb(null)); };
    const w = stdio({ platform: 'win32', spawn: wspawn, execFile: wexec });
    const ws = await w.start();
    const wpid = w.status().pid;
    assert(ws.ok && wpid, 'a Windows-style (shell) server starts');
    w.killNow();
    assert(killed.length === 1 && killed[0] === `taskkill /pid ${wpid} /T /F` && plainKills === 0, `killNow → taskkill /pid ${wpid} /T /F (not ch.kill)`);
    assert(await until(() => !alive(wpid), 2000), 'and the server is gone');
    // killAll (the app quitting) goes through killNow for every server
    const wm = createMcpManager({ file: path.join(TMP, 'win.json'), seal: () => null, open: () => '', spawn: wspawn, clientOptions: { platform: 'win32', execFile: wexec } });
    const wa = wm.add({ name: 'winsrv', line: `"${process.execPath}" "${FAKE}"` });
    await wm.start(wa.server.id);
    const before = killed.length;
    wm.killAll();
    assert(killed.length === before + 1 && /^taskkill \/pid \d+ \/T \/F$/.test(killed[killed.length - 1]), 'killAll on Windows → taskkill for each server');
    const lin = []; const lc = stdio({ platform: 'linux', execFile: (...a) => lin.push(a) });
    await lc.start(); const lpid = lc.status().pid; lc.killNow();
    assert(!lin.length && await until(() => !alive(lpid), 2000), 'elsewhere it is a plain kill (no taskkill)');
  }

  console.log('\n== a call\'s own time limit reaches the server (not the manager\'s default) ==');
  {
    const tm = createMcpManager({ file: path.join(TMP, 'timeouts.json'), seal: () => null, open: () => '', timeoutMs: 300 });
    const ta = tm.add({ name: 'slowpoke', line: `"${process.execPath}" "${FAKE}"` });
    await tm.start(ta.server.id);
    let tr = await tm.call('slowpoke', 'slow', { ms: 900 });
    assert(!tr.ok && tr.error === 'TIMEOUT', 'without a time limit the manager\'s default applies');
    tr = await tm.call('slowpoke', 'slow', { ms: 900 }, { timeoutMs: 5000 });
    assert(tr.ok && tr.text === 'finally', 'call(ref, tool, args, { timeoutMs }) passes the longer limit through to callTool');
    await tm.stopAll();
    const src = fs.readFileSync(path.join(__dirname, '..', 'alfred-tools.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'alfred-main.js'), 'utf8');
    assert(/ctx\.mcpCall\(a\.server, a\.tool, a\.arguments \|\| \{\}, \{ timeoutMs: MCP_CALL_MS \}\)/.test(src) && /h\.mcp\.call\(server, tool, args, opts\)/.test(src), 'Alfred\'s mcp_call hands its own (180 s) limit to the manager');
    // HTTP: the socket idle timeout never cuts a request before the request's own limit
    const hs2 = await startFakeMcpHttp({ callDelayMs: 2600 });
    const slowHttp = createMcpClient({ name: 'slowweb', transport: 'http', url: hs2.url, timeoutMs: 300, initTimeoutMs: 300 });
    assert(slowHttp.httpIdleMs(180000) === 182000 && slowHttp.httpIdleMs() === 3000, 'HTTP idle timeout = max(request limit, timeoutMs, initTimeoutMs) + 2 s');
    await slowHttp.start();
    tr = await slowHttp.callTool('when', {}, { timeoutMs: 6000 });
    assert(tr.ok && tr.text === 'slow noon', `a slow HTTP tool call within its own limit is not cut by the socket timeout (${tr.message || 'ok'})`);
    await slowHttp.stop(); await hs2.close();
  }

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
  assert(m.find('files').enabled === false && JSON.parse(fs.readFileSync(file, 'utf8')).servers.find((x) => x.name === 'files').enabled === false, '…without undoing the user\'s Stop (not saved as "start with the app")');
  await m.start('files');
  assert(m.find('files').enabled === true, 'pressing Start still turns "start with the app" on');
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
  { // a secret that couldn't be sealed leaves a placeholder → the next run says "needs its secrets again"
    const pf = path.join(TMP, 'placeholder.json');
    const p1 = createMcpManager({ file: pf, seal: () => null, open: () => '' });
    p1.add({ name: 'nokc', line: 'node x.js', secrets: 'K=value-777777' });
    const disk = fs.readFileSync(pf, 'utf8');
    assert(!/value-777777/.test(disk) && JSON.parse(disk).servers[0].env.K && JSON.parse(disk).servers[0].env.K.enc === null, 'unsealable secret → {enc:null} on disk (never the value)');
    const p2 = createMcpManager({ file: pf, seal, open });
    const st2 = await p2.start('nokc');
    assert(p2.find('nokc').missingSecrets.includes('K') && !st2.ok && st2.error === 'MISSING_SECRETS' && /needs its secrets again/.test(st2.message), 'next run: "needs its secrets again (K)" instead of starting without it');
    // a keychain that can't open the blob this run: the sealed blob is carried over, not erased
    const cf = path.join(TMP, 'carry.json');
    const c1 = createMcpManager({ file: cf, seal, open });
    c1.add({ name: 'carry', line: 'node x.js', secrets: 'API_KEY=carry-secret-1234' });
    const blob = JSON.parse(fs.readFileSync(cf, 'utf8')).servers[0].env.API_KEY.enc;
    const c2 = createMcpManager({ file: cf, seal, open: () => '' });
    assert(c2.find('carry').missingSecrets.includes('API_KEY'), 'a run whose keychain can\'t open it lists the key as missing');
    c2.add({ name: 'other', line: 'node y.js' }); // any save
    assert(JSON.parse(fs.readFileSync(cf, 'utf8')).servers.find((x) => x.name === 'carry').env.API_KEY.enc === blob, 'saving in that run writes the original sealed blob back');
    const c3m = createMcpManager({ file: cf, seal, open });
    assert(!c3m.find('carry').missingSecrets.length && c3m.find('carry').envKeys.includes('API_KEY'), 'a later run with the keychain back has the secret again');
  }
  await m.remove('files');
  assert(m.list().servers.length === 0 && !/files/.test(fs.readFileSync(file, 'utf8')), 'remove deletes it from the list and the file');
  assert(!logs.some((l) => /tok-MANAGER-4242/.test(l)), 'nothing logged contains the secret');
  assert(tp.registerMcpServer({}).ok === false, 'registerMcpServer without a server → NEED_SERVER');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
