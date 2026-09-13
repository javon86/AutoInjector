// test/log-bundle.test.js — "Download all logs" collector. Verifies it copies
// every on-disk log, writes the generated blobs alongside, notes (not fatal)
// missing files, and avoids basename collisions. Real temp dirs, no Electron.
// Run: node test/log-bundle.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const lb = require('../log-bundle');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

function main() {
  console.log('\n== stamp() is filesystem-safe ==');
  assert(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(lb.stamp(new Date('2026-09-13T11:20:05Z'))), 'stamp has no ":" or "." so it is a valid folder name');

  console.log('\n== bundle() gathers on-disk files + generated blobs into one folder ==');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'logbundle-'));
  const userData = path.join(base, 'userData');
  const logsDir = path.join(base, 'stuff and thing', 'logs');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(userData, 'autoinjector-debug.log'), 'event one\nevent two\n');
  fs.writeFileSync(path.join(userData, 'autoinjector-state.json'), '{"ok":true}');
  fs.writeFileSync(path.join(userData, 'autoinjector-shared.db'), 'SQLITEbinary');
  // A same-basename file from a different folder — must not clobber.
  const sub = path.join(userData, 'sub'); fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'autoinjector-debug.log'), 'other debug');

  const r = lb.bundle({
    logsDir,
    files: [
      path.join(userData, 'autoinjector-debug.log'),
      path.join(userData, 'autoinjector-state.json'),
      path.join(userData, 'autoinjector-shared.db'),
      path.join(sub, 'autoinjector-debug.log'),
      path.join(userData, 'does-not-exist.log'),
    ],
    blobs: [
      { name: 'events.json', content: '[{"kind":"boot"}]' },
      { name: 'system-info.txt', content: 'OS: Windows' },
    ],
    now: new Date('2026-09-13T11:20:05Z'),
  });

  assert(r.ok && fs.existsSync(r.folder), 'the bundle folder is created');
  assert(/autoinjector-logs-2026-09-13_11-20-05$/.test(r.folder), 'the folder is timestamped');
  const inFolder = fs.readdirSync(r.folder).sort();
  assert(inFolder.includes('autoinjector-debug.log') && inFolder.includes('autoinjector-state.json') && inFolder.includes('autoinjector-shared.db'),
    'every on-disk log/state/db file is copied in');
  assert(fs.readFileSync(path.join(r.folder, 'autoinjector-debug.log'), 'utf8') === 'event one\nevent two\n', 'the debug log content is copied verbatim');
  assert(inFolder.includes('events.json') && inFolder.includes('system-info.txt'), 'the generated in-memory blobs are written alongside');
  assert(inFolder.includes('sub-autoinjector-debug.log'), 'a same-named file from another folder is kept (prefixed), not clobbered');
  assert(Array.isArray(r.missing) && r.missing.some((m) => /does-not-exist/.test(m)), 'a missing source is noted, not fatal');
  assert(r.entries.length >= 6 && r.entries.every((e) => typeof e.bytes === 'number'), 'each entry reports its size');

  console.log('\n== bundle() degrades cleanly ==');
  const none = lb.bundle({ logsDir: '' });
  assert(!none.ok && /logs folder/.test(none.error), 'no logs folder -> a clean error, no throw');
  const empty = lb.bundle({ logsDir, now: new Date('2026-01-01T00:00:00Z') });
  assert(empty.ok && empty.entries.length === 0, 'no files + no blobs -> an empty bundle, still ok');

  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
