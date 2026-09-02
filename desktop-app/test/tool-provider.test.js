// test/tool-provider.test.js — the butler's external-tool registry (N5). Checks
// the built-in tools, register/unregister, run() normalization + streaming, the
// read-file sandbox, http-fetch guards + a real fetch, and the MCP-ready seam.
// No AutoInjector/Electron needed. Run: node test/tool-provider.test.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tp = require('../tool-provider');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

async function main() {
  console.log('\n== the registry ships the two built-in tools ==');
  const names = tp.list().map((t) => t.name);
  assert(names.includes('http-fetch'), 'http-fetch is registered by default');
  assert(names.includes('read-file'), 'read-file is registered by default');
  assert(tp.has('read-file') && !tp.has('nope'), 'has() reflects the registry');
  assert(tp.list().find((t) => t.name === 'http-fetch').risk === 'ask', 'http-fetch is risk "ask" (approval-gated)');
  assert(tp.status().count >= 2, 'status() reports the tool count');
  // list() must never leak the invoke function.
  assert(typeof tp.list()[0].invoke === 'undefined', 'list() never exposes a tool\'s invoke()');

  console.log('\n== register / unregister a custom tool ==');
  tp.register({ name: 'echo', description: 'echo args back', risk: 'monitor', invoke: (args) => ({ ok: true, message: JSON.stringify(args) }) });
  assert(tp.has('echo'), 'a custom tool registers');
  assert(tp.register({ name: '', invoke: null }).ok === false, 'a malformed tool is rejected');

  console.log('\n== run(): normalizes results and streams events ==');
  const evs = [];
  const r1 = await tp.run('echo', { a: 1 }, { onEvent: (e) => evs.push(e.type) });
  assert(r1.ok && /"a":1/.test(r1.message), 'run returns the tool\'s ok + message');
  assert(evs[0] === 'tool-start' && evs.includes('output') && evs[evs.length - 1] === 'done', 'run streams tool-start … output … done');
  const r2 = await tp.run('does-not-exist', {});
  assert(r2.ok === false && r2.error === 'UNKNOWN_TOOL', 'an unknown tool -> UNKNOWN_TOOL');
  tp.register({ name: 'boom', description: 'throws', invoke: () => { throw new Error('kaboom'); } });
  const r3 = await tp.run('boom', {});
  assert(r3.ok === false && /kaboom/.test(r3.error), 'a throwing tool is caught -> ok:false with the error');

  console.log('\n== read-file is sandboxed to the configured output root ==');
  const r4 = await tp.run('read-file', { path: 'x.txt' });
  assert(r4.ok === false && r4.error === 'NO_OUTPUT_ROOT', 'read-file with no root -> NO_OUTPUT_ROOT');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolprov-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello from disk');
  tp.configure({ outputRoot: dir });
  const r5 = await tp.run('read-file', { path: 'note.txt' });
  assert(r5.ok && r5.message === 'hello from disk', 'read-file reads a file under the root');
  const r6 = await tp.run('read-file', { path: '../../etc/passwd' });
  assert(r6.ok === false && r6.error === 'PATH_ESCAPE', 'a .. path escape is refused');
  const r7 = await tp.run('read-file', {});
  assert(r7.ok === false && r7.error === 'NEED_PATH', 'read-file with no path -> NEED_PATH');

  console.log('\n== http-fetch: guards + a real fetch ==');
  assert((await tp.run('http-fetch', {})).error === 'NEED_URL', 'no url -> NEED_URL');
  assert((await tp.run('http-fetch', { url: 'not a url' })).error === 'BAD_URL', 'a bad url -> BAD_URL');
  assert((await tp.run('http-fetch', { url: 'file:///etc/passwd' })).error === 'BAD_PROTOCOL', 'a non-http protocol -> BAD_PROTOCOL');
  const stub = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('PONG'); });
  const port = await listen(stub);
  const good = await tp.run('http-fetch', { url: `http://127.0.0.1:${port}/x` });
  assert(good.ok && good.message === 'PONG', 'http-fetch GETs the body');
  tp.configure({ fetchAllowlist: ['example.com'] });
  const blocked = await tp.run('http-fetch', { url: `http://127.0.0.1:${port}/x` });
  assert(blocked.ok === false && blocked.error === 'HOST_NOT_ALLOWED', 'a host outside the allowlist is refused');
  tp.configure({ fetchAllowlist: [] }); // reset
  stub.close();

  console.log('\n== the MCP seam is present but not yet implemented ==');
  const mcp = tp.registerMcpServer({ url: 'stdio://whatever' });
  assert(mcp.ok === false && mcp.error === 'MCP_NOT_IMPLEMENTED', 'registerMcpServer() is a documented, unimplemented seam');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
