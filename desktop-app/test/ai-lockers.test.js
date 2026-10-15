// test/ai-lockers.test.js — each AI's private folder (ai-lockers.js): parsing,
// the "only inside your own locker" gate (Windows rules checked with a fake
// shell; posix rules checked against a REAL shell), write/append/give/send.
// Run: node test/ai-lockers.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../ai-lockers');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

async function main() {
  console.log('\n== parseRequest ==');
  let ops = L.parseRequest('Saving it.\n```\nwrite notes\\plan.md\n# Plan\n\nStep 1\n```\n```cmd\ndir /b\ntype notes\\plan.md\n```');
  assert(ops.length === 3, `write block + 2 commands (${ops.length})`);
  assert(ops[0].type === 'write' && ops[0].file === 'notes\\plan.md' && ops[0].content === '# Plan\n\nStep 1', 'write keeps the block content verbatim (blank lines, # lines)');
  assert(ops[1].type === 'cmd' && ops[1].command === 'dir /b' && ops[2].command === 'type notes\\plan.md', 'other blocks are one command per line');
  ops = L.parseRequest('```\nappend log.txt\nline A\n```');
  assert(ops.length === 1 && ops[0].type === 'append' && ops[0].content === 'line A', 'append block');
  ops = L.parseRequest('dir');
  assert(ops.length === 1 && ops[0].command === 'dir', 'no code block -> bare line is a command');

  console.log('\n== lex ==');
  let lx = L.lex('dir /b | sort > list.txt');
  assert(lx.segments.length === 2 && lx.redirects[0] === 'list.txt', 'pipe + redirect split');
  lx = L.lex('type a.txt 2>&1 && echo "x & y"');
  assert(lx.segments.length === 2 && lx.redirects.length === 0 && lx.segments[1][1] === '"x & y"', '2>&1 is not a file; & inside quotes is text');
  assert(L.lex('echo "oops').error, 'unbalanced quotes reported');

  console.log('\n== Windows rules (fake shell) ==');
  const winRoot = 'C:\\Users\\javon\\AutoInjector\\stuff and thing\\ai-lockers';
  const fakeRuns = [];
  const W = L.createLockers({ root: winRoot, platform: 'win32', createTerminal: () => ({ run: async (c) => { fakeRuns.push(c); return { ok: true, exitCode: 0, output: '' }; }, stop() {}, status: () => ({}) }) });
  const ok = (line) => W.checkCommand('claude', line).ok;
  assert(ok('dir'), 'dir allowed');
  assert(ok('type notes\\plan.md'), 'type a relative file allowed');
  assert(ok('copy a.txt b.txt'), 'copy inside allowed');
  assert(ok('del /q old\\*.tmp'), 'del inside allowed WITHOUT asking (own locker)');
  assert(ok('dir /b | sort > list.txt'), 'pipes + redirect inside allowed');
  assert(ok('findstr /i "todo" notes\\*.md'), 'findstr: pattern is not treated as a path');
  assert(ok('md drafts\\v2'), 'make subfolders');
  assert(!ok('type C:\\Windows\\win.ini'), 'drive letter refused');
  assert(!ok('type \\Windows\\win.ini'), 'absolute path refused');
  assert(!ok('type ..\\gemini\\secret.txt'), 'climbing into another AI\'s locker refused');
  assert(!ok('dir ..'), '.. out of the locker refused');
  assert(!ok('type %USERPROFILE%\\x.txt'), '%VARIABLES% refused');
  assert(!ok('echo %PATH%'), 'echo %PATH% refused');
  assert(!ok('copy notes.txt \\\\server\\share'), 'network path refused');
  assert(!ok('echo hi > C:\\temp\\x.txt'), 'redirect outside refused');
  assert(!ok('dir & powershell -c "x"'), 'a second command that is not allowed is refused');
  assert(!ok('powershell Get-ChildItem'), 'powershell refused');
  assert(!ok('start notepad'), 'start refused');
  assert(!ok('curl http://x'), 'network tools refused');
  assert(!ok('type con'), 'device names refused');
  assert(!ok('cd sub && dir'), 'cd must be on its own line');
  assert(!ok('python -c "import os"'), 'python -c refused');
  const reason = W.checkCommand('claude', 'reg query HKLM').reason;
  assert(/isn't allowed/.test(reason) && /dir/.test(reason), 'refusal explains what IS allowed');
  assert(W.checkOp('claude', { type: 'cmd', command: 'send plan.md to gemini' }).ok, 'send to another AI allowed');
  assert(!W.checkOp('claude', { type: 'cmd', command: 'send plan.md to claude' }).ok, 'send to yourself refused');
  assert(!W.checkOp('claude', { type: 'cmd', command: 'send plan.md to bob' }).ok, 'send to an unknown AI refused');
  assert(!W.checkOp('claude', { type: 'write', file: '..\\..\\evil.bat', content: 'x' }).ok, 'write outside refused');
  W.grant('claude', 'gemini');
  assert(W.checkCommand('gemini', 'type ..\\claude\\plan.md').ok, 'win: shared locker readable with type');
  assert(W.checkCommand('gemini', 'copy ..\\claude\\plan.md mine.md').ok, 'win: copy out of a shared locker');
  assert(!W.checkCommand('gemini', 'del ..\\claude\\plan.md').ok, 'win: del in a shared locker refused');
  assert(!W.checkCommand('gemini', 'copy mine.md ..\\claude\\x.md').ok, 'win: copy INTO a shared locker refused');
  W.consumeGrants('gemini');
  assert(!W.checkCommand('gemini', 'type ..\\claude\\plan.md').ok, 'win: closed after one request');
  const blocked = await W.runOp('claude', { type: 'cmd', command: 'type C:\\secret.txt' });
  assert(!blocked.ok && blocked.error === 'NOT_ALLOWED' && fakeRuns.length === 0, 'a refused command never reaches the shell');

  console.log('\n== posix: real shell, real files ==');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lockers-'));
  const outside = path.join(path.dirname(root), `outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'TOP SECRET');
  const sent = []; const given = [];
  const P = L.createLockers({ root, platform: process.platform === 'win32' ? 'linux' : process.platform });
  if (process.platform === 'win32') { console.log('  (skipping live posix shell on Windows)'); }
  else {
    assert(P.ensure().ok, 'ensure() creates the lockers');
    for (const s of ['chatgpt', 'claude', 'gemini']) assert(fs.existsSync(path.join(root, s, 'inbox')) && fs.existsSync(path.join(root, s, 'README.txt')), `${s} has inbox/ + README.txt`);
    const ctx = {
      sendFile: async (from, to, abs, rel) => { sent.push({ from, to, abs, rel }); return { ok: true }; },
      giveFile: async (site, abs) => { given.push({ site, abs }); return { ok: true }; },
    };
    let r = await P.runOp('claude', { type: 'write', file: 'notes/plan.md', content: '# Plan\nline two' }, ctx);
    assert(r.ok && fs.readFileSync(path.join(root, 'claude', 'notes', 'plan.md'), 'utf8') === '# Plan\nline two\n', 'write creates folders + the file');
    r = await P.runOp('claude', { type: 'append', file: 'notes/plan.md', content: 'line three' }, ctx);
    assert(r.ok && /line three\n$/.test(fs.readFileSync(path.join(root, 'claude', 'notes', 'plan.md'), 'utf8')), 'append adds to the end');
    r = await P.runOp('claude', { type: 'cmd', command: 'cat notes/plan.md' }, ctx);
    assert(r.ok && /line two/.test(r.output), 'cat/type output comes back');
    r = await P.runOp('claude', { type: 'cmd', command: 'ls notes | sort > listing.txt' }, ctx);
    assert(r.ok && /plan\.md/.test(fs.readFileSync(path.join(root, 'claude', 'listing.txt'), 'utf8')), 'pipe + redirect works inside the locker');
    r = await P.runOp('claude', { type: 'cmd', command: `cat ${outside}` }, ctx);
    assert(!r.ok && r.error === 'NOT_ALLOWED' && !/TOP SECRET/.test(r.output), 'reading a file outside the locker is refused');
    r = await P.runOp('claude', { type: 'cmd', command: 'cat ../../' + path.basename(outside) }, ctx);
    assert(!r.ok && r.error === 'NOT_ALLOWED', '.. escape refused');
    r = await P.runOp('claude', { type: 'cmd', command: 'cd notes' }, ctx);
    assert(r.ok, 'cd into a subfolder');
    r = await P.runOp('claude', { type: 'cmd', command: 'pwd' }, ctx);
    assert(r.ok && r.output.trim() === path.join(root, 'claude', 'notes'), 'the shell really moved');
    r = await P.runOp('claude', { type: 'cmd', command: 'cat ../../gemini/README.txt' }, ctx);
    assert(!r.ok, 'from a subfolder, climbing to another AI is still refused');
    r = await P.runOp('claude', { type: 'cmd', command: 'cd ..' }, ctx);
    assert(r.ok, 'cd .. back to the locker root is fine');
    r = await P.runOp('claude', { type: 'cmd', command: 'cd ..' }, ctx);
    assert(!r.ok && r.error === 'NOT_ALLOWED', 'cd .. above the locker refused');
    r = await P.runOp('claude', { type: 'cmd', command: 'give notes/plan.md' }, ctx);
    assert(r.ok && /line three/.test(r.output) && /end of file/.test(r.output) && given.length === 0, 'give pastes a small text file');
    fs.writeFileSync(path.join(root, 'claude', 'pic.bin'), Buffer.from([0, 1, 2, 3]));
    r = await P.runOp('claude', { type: 'cmd', command: 'give pic.bin' }, ctx);
    assert(r.ok && given.length === 1 && /Uploaded/.test(r.output), 'give uploads a binary file');
    r = await P.runOp('claude', { type: 'cmd', command: 'give nope.txt' }, ctx);
    assert(!r.ok && r.error === 'NOT_FOUND' && /Files here/.test(r.output), 'give of a missing file lists what IS there');
    r = await P.runOp('claude', { type: 'cmd', command: 'send notes/plan.md to gemini' }, ctx);
    const dest = path.join(root, 'gemini', 'inbox', 'from-claude', 'plan.md');
    assert(r.ok && fs.existsSync(dest) && sent.length === 1 && sent[0].to === 'gemini' && sent[0].from === 'claude', 'send copies into the recipient\'s inbox/from-claude and notifies');
    r = await P.runOp('claude', { type: 'cmd', command: 'send notes/plan.md gemini' }, ctx);
    assert(r.ok && fs.existsSync(path.join(root, 'gemini', 'inbox', 'from-claude', 'plan (2).md')), 'a second send never overwrites — it gets (2)');
    r = await P.runOp('gemini', { type: 'cmd', command: 'cat inbox/from-claude/plan.md' }, ctx);
    assert(r.ok && /Plan/.test(r.output), 'the recipient can read it from its own locker');
    r = await P.runOp('claude', { type: 'cmd', command: 'help' }, ctx);
    assert(r.ok && /send <file> to <ai>/.test(r.output), 'help lists the commands');
    r = await P.runOp('claude', { type: 'cmd', command: 'rm listing.txt' }, ctx);
    assert(r.ok && !fs.existsSync(path.join(root, 'claude', 'listing.txt')), 'deleting inside the locker just works (no approval)');
    fs.writeFileSync(path.join(root, 'claude', 'tool.js'), 'console.log(1)');
    assert(P.checkOp('claude', { type: 'cmd', command: 'node tool.js' }).needsApproval === true, 'running a script needs approval');
    assert(!P.checkOp('claude', { type: 'cmd', command: 'node missing.js' }).ok, 'a script that isn\'t there is refused');
    console.log('\n== sharing: one request, look-only ==');
    let clock = Date.now();
    const S = L.createLockers({ root, platform: process.platform, now: () => clock });
    S.ensure();
    fs.writeFileSync(path.join(root, 'claude', 'secret-plan.md'), 'shared idea');
    const notified = [];
    const sctx = { notifyShare: async (from, to) => { notified.push({ from, to }); return { ok: true }; } };
    r = await S.runOp('gemini', { type: 'cmd', command: 'cat ../claude/secret-plan.md' }, sctx);
    assert(!r.ok && r.error === 'NOT_ALLOWED', 'before sharing, Gemini cannot read Claude\'s locker');
    r = await S.runOp('claude', { type: 'cmd', command: 'share with gemini' }, sctx);
    assert(r.ok && notified.length === 1 && notified[0].to === 'gemini', 'share with gemini works and Gemini is told');
    assert(!S.checkOp('claude', { type: 'cmd', command: 'share with claude' }).ok, 'cannot share with yourself');
    r = await S.runOp('gemini', { type: 'cmd', command: 'cat ../claude/secret-plan.md' }, sctx);
    assert(r.ok && /shared idea/.test(r.output), 'after sharing, Gemini can read it');
    r = await S.runOp('gemini', { type: 'cmd', command: 'ls ../claude' }, sctx);
    assert(r.ok && /secret-plan\.md/.test(r.output), 'and list it');
    r = await S.runOp('gemini', { type: 'cmd', command: 'cp ../claude/secret-plan.md mine.md' }, sctx);
    assert(r.ok && fs.existsSync(path.join(root, 'gemini', 'mine.md')), 'and copy from it into its own locker');
    r = await S.runOp('gemini', { type: 'cmd', command: 'rm ../claude/secret-plan.md' }, sctx);
    assert(!r.ok && /only LOOK/.test(r.output) && fs.existsSync(path.join(root, 'claude', 'secret-plan.md')), 'but it can NOT delete Claude\'s file');
    r = await S.runOp('gemini', { type: 'cmd', command: 'cp mine.md ../claude/planted.md' }, sctx);
    assert(!r.ok && !fs.existsSync(path.join(root, 'claude', 'planted.md')), 'or copy INTO Claude\'s locker');
    r = await S.runOp('gemini', { type: 'cmd', command: 'echo x > ../claude/x.txt' }, sctx);
    assert(!r.ok, 'or redirect into it');
    r = await S.runOp('gemini', { type: 'write', file: '../claude/w.txt', content: 'x' }, sctx);
    assert(!r.ok && !fs.existsSync(path.join(root, 'claude', 'w.txt')), 'or write into it');
    r = await S.runOp('gemini', { type: 'cmd', command: 'cd ../claude' }, sctx);
    assert(!r.ok, 'or cd into it');
    r = await S.runOp('gemini', { type: 'cmd', command: 'give ../claude/secret-plan.md' }, sctx);
    assert(r.ok && /shared idea/.test(r.output), 'give works on a shared file');
    r = await S.runOp('gemini', { type: 'cmd', command: 'send ../claude/secret-plan.md to chatgpt' }, sctx);
    assert(!r.ok, 'but it can\'t send Claude\'s file on to someone else');
    r = await S.runOp('chatgpt', { type: 'cmd', command: 'cat ../claude/secret-plan.md' }, sctx);
    assert(!r.ok, 'a share with Gemini does NOT open it to ChatGPT');
    assert(JSON.stringify(S.consumeGrants('gemini')) === '["claude"]', 'consumeGrants returns who had shared');
    r = await S.runOp('gemini', { type: 'cmd', command: 'cat ../claude/secret-plan.md' }, sctx);
    assert(!r.ok, 'after that one request, the share is closed');
    await S.runOp('claude', { type: 'cmd', command: 'share gemini' }, sctx);
    clock += 11 * 60 * 1000;
    assert(S.grantsFor('gemini').length === 0, 'an unused share expires after 10 minutes');

    console.log('\n== user locker browser ==');
    const lf = S.listFiles('claude');
    assert(lf.ok && lf.files.some((f) => f.rel === path.join('notes', 'plan.md') && f.kind === 'text'), 'listFiles shows nested files with their kind');
    assert(lf.files.some((f) => f.name === 'pic.bin' && f.kind === 'document'), 'binary files are marked as documents');
    const uf = S.userFile('claude', path.join('notes', 'plan.md'));
    assert(uf.ok && /line three/.test(uf.text), 'userFile returns small text content');
    assert(!S.userFile('claude', '../gemini/mine.md').ok, 'userFile stays inside that locker');
    assert(!S.listFiles('bob').ok, 'unknown AI -> error');
    S.stopAll();
    P.stopAll();
  }
  try { fs.unlinkSync(outside); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
