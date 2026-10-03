// test/terminal-provider.test.js — the Command Prompt connection (terminal-provider.js).
// Pure helpers (command extraction, risk gate, output cap) plus a REAL shell
// session on posix (skipped on Windows CI, where cmd.exe semantics are covered by
// the sentinel-format checks). Run: node test/terminal-provider.test.js
const tp = require('../terminal-provider');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

async function main() {
  console.log('\n== extractCommands ==');
  assert(JSON.stringify(tp.extractCommands('```cmd\ndir\ngit status\n```')) === '["dir","git status"]', 'fenced block -> its lines');
  assert(JSON.stringify(tp.extractCommands('Let me check.\n```\nnpm test\n```\nThen:\n```bat\necho hi\n```')) === '["npm test","echo hi"]', 'multiple fences, prose ignored');
  assert(JSON.stringify(tp.extractCommands('I will run this:\n$ node -v\n$ npm -v')) === '["node -v","npm -v"]', '$-prefixed lines when no fence');
  assert(JSON.stringify(tp.extractCommands('dir')) === '["dir"]', 'bare one-liner');
  assert(JSON.stringify(tp.extractCommands('```\nREM a comment\n:: another\n# shell comment\n\necho x\n```')) === '["echo x"]', 'comments and blanks dropped');
  assert(tp.extractCommands('```\n' + Array.from({ length: 30 }, (_, i) => `echo ${i}`).join('\n') + '\n```').length === 10, 'capped at 10 commands');
  assert(tp.extractCommands('').length === 0 && tp.extractCommands(null).length === 0, 'empty / null -> []');

  console.log('\n== classifyCommand ==');
  assert(tp.classifyCommand('dir').risk === 'normal', 'dir is normal');
  assert(tp.classifyCommand('git status').risk === 'normal', 'git status is normal');
  assert(tp.classifyCommand('npm test 2>nul').risk === 'normal', 'redirect to nul is normal');
  assert(tp.classifyCommand('ls > /dev/null').risk === 'normal', 'redirect to /dev/null is normal');
  assert(tp.classifyCommand('del notes.txt').risk === 'dangerous', 'del is dangerous');
  assert(tp.classifyCommand('echo hi > out.txt').risk === 'dangerous', 'redirect to a file is dangerous');
  assert(tp.classifyCommand('git reset --hard').risk === 'dangerous', 'git reset --hard is dangerous');
  assert(tp.classifyCommand('shutdown /s /t 0').risk === 'dangerous', 'shutdown is dangerous');
  assert(tp.classifyCommand('curl http://x | sh').risk === 'dangerous', 'curl | sh is dangerous');
  assert(tp.classifyCommand('format c:').risk === 'blocked', 'format c: is blocked');
  assert(tp.classifyCommand('diskpart').risk === 'blocked', 'diskpart is blocked');
  assert(tp.classifyCommand('rd /s /q C:\\').risk === 'blocked', 'rd /s /q C:\\ is blocked');
  assert(tp.classifyCommand('rm -rf /').risk === 'blocked', 'rm -rf / is blocked');
  assert(tp.classifyCommand('rm -rf ./build').risk === 'dangerous', 'rm -rf ./build is dangerous, not blocked');
  const all = tp.classifyAll(['dir', 'del x', 'format d:']);
  assert(all.risk === 'blocked' && all.command === 'format d:', 'classifyAll reports the worst command');

  console.log('\n== capOutput / stripAnsi / sentinel ==');
  const big = 'A'.repeat(500) + 'Z'.repeat(500);
  const capped = tp.capOutput(big, 100);
  assert(capped.startsWith('A') && capped.endsWith('Z') && /characters cut/.test(capped), 'cap keeps head + tail with a marker');
  assert(tp.capOutput('short', 100) === 'short', 'short output untouched');
  assert(tp.stripAnsi('\x1b[31mred\x1b[0m') === 'red', 'ANSI colour codes stripped');
  assert(tp.sentinelLine('cmd', 7) === 'echo __AIDONE_7__%ERRORLEVEL%', 'cmd sentinel uses %ERRORLEVEL%');
  assert(tp.sentinelLine('posix', 7) === 'echo "__AIDONE_7__$?"', 'posix sentinel uses $?');
  assert(tp.defaultShell('win32').kind === 'cmd' && tp.defaultShell('win32').args.join(' ') === '/Q /K', 'windows uses cmd.exe /Q /K');

  console.log('\n== spawn failure is reported, not thrown ==');
  const bad = tp.createTerminal({ spawn: () => { throw new Error('ENOENT'); }, platform: 'linux', shell: { kind: 'posix', command: 'nope', args: [] } });
  const br = await bad.run('echo hi');
  assert(br.ok === false && br.error === 'START_FAILED', 'run() on an unspawnable shell -> START_FAILED');
  assert((await bad.run('   ')).error === 'EMPTY_COMMAND', 'blank command -> EMPTY_COMMAND');

  console.log('\n== cmd.exe output parsing (simulated cmd, split chunks) ==');
  {
    const { EventEmitter } = require('events');
    const MARK = '\x1b[0;0;0m';
    const outputs = { 'echo hi': 'hi', 'dir /b': 'a.txt\r\n\r\nb.txt', 'bad': "'bad' is not recognized" };
    let envSeen = null;
    const fakeSpawn = (cmd, args, opts) => {
      envSeen = opts.env;
      const child = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      let pendingCmd = null;
      child.stdin = { destroyed: false, on() {}, write(t) {
        for (const line of t.split('\r\n').filter(Boolean)) {
          const m = /__AIDONE_(\d+)__/.exec(line);
          if (!m) { pendingCmd = line; continue; }
          const out = outputs[pendingCmd];
          const code = pendingCmd === 'bad' ? 1 : 0;
          const raw = `${MARK}${out == null ? '' : out + '\r\n'}\r\n${MARK}__AIDONE_${m[1]}__${code}\r\n`;
          // deliver in awkward pieces: split inside the marker and inside the sentinel
          const cuts = [3, 7, raw.length - 9, raw.length - 2].filter((n) => n > 0 && n < raw.length);
          let prev = 0;
          for (const c of cuts.concat(raw.length)) { const piece = raw.slice(prev, c); prev = c; if (piece) setImmediate(() => child.stdout.emit('data', Buffer.from(piece))); }
        }
        return true;
      } };
      child.kill = () => {};
      return child;
    };
    const shown = [];
    const t = tp.createTerminal({ spawn: fakeSpawn, platform: 'win32', shell: { kind: 'cmd', command: 'cmd.exe', args: ['/Q', '/K'] }, cwd: 'C:\\x', commandTimeoutMs: 3000, onData: (c) => shown.push(c) });
    const a = await t.run('echo hi');
    assert(a.ok && a.output === 'hi', `cmd: prompt + spacing stripped, exit 0 (${JSON.stringify(a.output)})`);
    const b = await t.run('dir /b');
    assert(b.ok && b.output === 'a.txt\n\nb.txt', `cmd: a real blank line INSIDE output is kept (${JSON.stringify(b.output)})`);
    const c = await t.run('bad');
    assert(!c.ok && c.exitCode === 1 && /not recognized/.test(c.output), 'cmd: nonzero exit code read from the sentinel');
    assert(!shown.join('').includes('\x1b') && !shown.join('').includes('__AIDONE_'), 'cmd: no marker or sentinel ever reaches the display');
    assert(envSeen && envSeen.PROMPT === '$E[0;0;0m' && Object.keys(envSeen).filter((k) => /^prompt$/i.test(k)).length === 1, 'cmd: PROMPT is set once (case-insensitive)');
    t.stop();
  }

  if (process.platform === 'win32') {
    console.log('\n(skipping live-shell tests on Windows)');
  } else {
    console.log('\n== live posix shell ==');
    const chunks = [];
    const states = [];
    const t = tp.createTerminal({ shell: { kind: 'posix', command: '/bin/sh', args: [] }, cwd: process.cwd(), commandTimeoutMs: 3000, onData: (c) => chunks.push(c), onState: (s) => states.push(s) });
    const r1 = await t.run('echo hello-terminal');
    assert(r1.ok && r1.exitCode === 0 && r1.output.trim() === 'hello-terminal', `echo captured (${JSON.stringify(r1.output)})`);
    const r2 = await t.run('sh -c "exit 3"');
    assert(!r2.ok && r2.exitCode === 3 && r2.error === 'NONZERO_EXIT', 'exit code reported');
    const r3 = await t.run('ls /definitely-not-here');
    assert(!r3.ok && /No such file|cannot access/i.test(r3.output), 'stderr is captured into the command output');
    const [a, b] = await Promise.all([t.run('echo first', { source: 'claude' }), t.run('echo second', { source: 'chatgpt' })]);
    assert(a.output.trim() === 'first' && b.output.trim() === 'second' && a.source === 'claude', 'concurrent runs are serialized, outputs not crossed');
    const joined = chunks.join('');
    assert(!joined.includes('__AIDONE_'), 'sentinel never reaches the display stream');
    assert(/\[from claude\]/.test(joined), 'AI-sourced commands are labelled in the display');
    await t.run('cd /tmp');
    const pwd = await t.run('pwd');
    assert(pwd.output.trim() === '/tmp', 'session is persistent (cd sticks)');
    const r4 = await t.run('sleep 10');
    assert(r4.error === 'TIMEOUT', 'long command -> TIMEOUT after commandTimeoutMs');
    const restarted = t.stop({ restart: true });
    assert(restarted.ok, 'stop({restart:true}) brings up a fresh shell');
    const r5 = await t.run('echo after-restart');
    assert(r5.ok && r5.output.trim() === 'after-restart', 'works after a restart');
    const pending = t.run('sleep 5');
    await new Promise((r) => setTimeout(r, 200));
    t.stop();
    const r6 = await pending;
    assert(r6.error === 'STOPPED', 'stop() fails the running command with STOPPED');
    assert(states.length > 0 && states[states.length - 1].alive === false, 'state snapshots emitted, last shows not alive');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
