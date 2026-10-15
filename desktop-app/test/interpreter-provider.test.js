// test/interpreter-provider.test.js — the Open Interpreter adapter. Spins up a
// stub OI server that streams execution events, and checks run() drives it,
// normalizes native + simple event shapes, streams them, and concatenates the
// assistant prose. No real Open Interpreter needed. Run: node test/interpreter-provider.test.js
const http = require('http');
const oi = require('../interpreter-provider');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

// A stub Open Interpreter server: echoes a fixed stream of events for any task,
// mixing native "lmc" chunks and the simple contract, as NDJSON.
function makeStub(lines) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {}; try { parsed = JSON.parse(body); } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const l of lines(parsed)) res.write(JSON.stringify(l) + '\n');
      res.end();
    });
  });
}

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

async function main() {
  console.log('\n== normalize(): native lmc chunks and simple events fold to one shape ==');
  assert(oi.normalize({ role: 'assistant', type: 'message', content: 'hi' }).type === 'message', 'lmc message -> message');
  assert(oi.normalize({ role: 'assistant', type: 'code', format: 'python', content: 'print(1)' }).format === 'python', 'lmc code keeps its format');
  assert(oi.normalize({ role: 'computer', type: 'console', content: '1' }).type === 'output', 'lmc console -> output');
  assert(oi.normalize({ role: 'assistant', type: 'message', end: true }) === null, 'an end marker yields no event');
  assert(oi.normalize({ type: 'output', content: 'done' }).type === 'output', 'simple event passes through');

  console.log('\n== guards: disabled / no endpoint / empty task ==');
  oi.setSettings({ enabled: false, endpoint: '' });
  assert((await oi.run('x')).error === 'INTERPRETER_DISABLED', 'disabled -> INTERPRETER_DISABLED');
  oi.setSettings({ enabled: true, endpoint: '' });
  assert((await oi.run('x')).error === 'NO_ENDPOINT', 'enabled but no endpoint -> NO_ENDPOINT');
  assert((await oi.run('')).error === 'NEED_TASK' || (await oi.run('   ')).error === 'NEED_TASK', 'empty task -> NEED_TASK');

  console.log('\n== run(): streams a real execution and concatenates the prose ==');
  const server = makeStub((body) => ([
    { role: 'assistant', type: 'message', content: `Working on: ${body.task}. ` },
    { role: 'assistant', type: 'code', format: 'python', content: 'print(2+2)' },
    { role: 'computer', type: 'console', content: '4' },
    { type: 'message', content: 'The answer is 4.' },
    { type: 'done' },
  ]));
  const port = await listen(server);
  oi.setSettings({ enabled: true, endpoint: `http://127.0.0.1:${port}/run`, autoRun: true });

  const streamed = [];
  const r = await oi.run('add two and two', { onEvent: (ev) => streamed.push(ev) });
  assert(r.ok === true, 'run resolves ok against the stub server');
  assert(r.message === 'Working on: add two and two. The answer is 4.', 'assistant prose is concatenated in order');
  assert(streamed.some((e) => e.type === 'code' && /print/.test(e.content)), 'a code event was streamed');
  assert(streamed.some((e) => e.type === 'output' && e.content === '4'), 'an execution output event was streamed');
  assert(streamed.some((e) => e.type === 'done'), 'a done event closed the run');
  assert(r.events.length >= 4, `all events captured (${r.events.length})`);

  console.log('\n== run(): an HTTP error surfaces cleanly ==');
  const errServer = http.createServer((req, res) => { res.writeHead(500); res.end('boom'); });
  const eport = await listen(errServer);
  oi.setSettings({ endpoint: `http://127.0.0.1:${eport}/run` });
  const er = await oi.run('x');
  assert(er.ok === false && /HTTP_500/.test(er.error), 'a 500 from the OI server is reported, not thrown');

  console.log('\n== managed mode: AutoInjector spawns the shim itself, waits for /health, then run() works ==');
  {
    const mport = 18000 + Math.floor(Math.random() * 2000);
    // A stand-in "shim": a Node process that answers /health and streams one /run event.
    const code = `const http=require('http');http.createServer((q,s)=>{`
      + `if(q.url==='/health'){s.writeHead(200);s.end('{"ok":true}');return;}`
      + `if(q.method==='POST'&&q.url==='/run'){s.writeHead(200);`
      + `s.write(JSON.stringify({role:'assistant',type:'message',content:'managed ok'})+String.fromCharCode(10));`
      + `s.write(JSON.stringify({type:'done'})+String.fromCharCode(10));s.end();return;}`
      + `s.writeHead(404);s.end();}).listen(${mport},'127.0.0.1');`;
    const started = await oi.startManaged({ command: process.execPath, args: ['-e', code], port: mport, readyTimeoutMs: 8000 });
    assert(started.ok, `startManaged reports ok once /health answers (${started.endpoint || started.error})`);
    assert(started.ok && started.endpoint.includes(String(mport)), 'the endpoint points at the spawned shim port');
    assert(oi.status().managed === true && oi.status().managedPid, 'status() reports managed mode + the child pid');
    const mrun = await oi.run('do the thing');
    assert(mrun.ok && /managed ok/.test(mrun.message), 'run() works against the auto-spawned shim');
    const stopped = oi.stopManaged();
    assert(stopped.stopped === true, 'stopManaged kills the child process');
    assert(oi.status().managed === false, 'status() reports managed mode is off after stop');
    const noCmd = await oi.startManaged({});
    assert(noCmd.ok === false && noCmd.error === 'NO_COMMAND', 'startManaged with no command is rejected');
  }

  await new Promise((r) => server.close(r));
  await new Promise((r) => errServer.close(r));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e && e.stack || e); process.exit(1); });
