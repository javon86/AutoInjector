'use strict';
// test/voice-python.test.js — which Python runs the voice engine (voice-python.js). A set-up that already works is
// never broken: plain `python` that already has faster-whisper stays, even when `py -3.12` exists; nothing installed
// anywhere -> the installer's pick; the remembered choice wins while it still works; a remembered one that no longer
// runs is replaced. The real probe asks Python quickly (find_spec, no heavy import) and caches the answer.
// Run: node test/voice-python.test.js
const { chooseVoicePython, makeProbe, PROBE_CODE } = require('../voice-python');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }
const PY = { cmd: 'python', pre: [] };
const PY3 = { cmd: 'python3', pre: [] };
const LAUNCHER = { cmd: 'py', pre: ['-3.12'] };
const fake = (table) => async (c) => table[`${c.cmd} ${c.pre.join(' ')}`.trim()] || { runs: false, has: false };
const same = (a, b) => !!a && a.cmd === b.cmd && a.pre.join(' ') === b.pre.join(' ');

(async () => {
  console.log('\n== the choice ==');
  let c = await chooseVoicePython({ plain: [PY, PY3], installerPick: LAUNCHER, probe: fake({ python: { runs: true, has: true }, 'py -3.12': { runs: true, has: false } }) });
  assert(same(c, PY) && c.why === 'has-voice-packages', 'plain python already has faster-whisper -> it stays plain python, even though py -3.12 exists');
  c = await chooseVoicePython({ plain: [PY, PY3], installerPick: LAUNCHER, probe: fake({ python: { runs: true, has: false }, python3: { runs: true, has: false }, 'py -3.12': { runs: true, has: false } }) });
  assert(same(c, LAUNCHER) && c.why === 'installer-pick', 'nothing installed anywhere -> the installer\'s pick (where the Setup Wizard installs)');
  c = await chooseVoicePython({ plain: [PY, PY3], installerPick: LAUNCHER, probe: fake({ python: { runs: true, has: false }, 'py -3.12': { runs: true, has: true } }) });
  assert(same(c, LAUNCHER), 'the voice packages only in py -3.12 -> py -3.12');
  const REM = { cmd: 'C:/old/python.exe', pre: [] };
  c = await chooseVoicePython({ remembered: REM, plain: [PY], installerPick: LAUNCHER, probe: fake({ 'C:/old/python.exe': { runs: true, has: true }, python: { runs: true, has: true }, 'py -3.12': { runs: true, has: true } }) });
  assert(same(c, REM) && c.why === 'remembered', 'the remembered choice wins while it still works');
  c = await chooseVoicePython({ remembered: REM, plain: [PY], installerPick: LAUNCHER, probe: fake({ python: { runs: true, has: true } }) });
  assert(same(c, PY), 'a remembered Python that no longer runs is replaced by one that works');
  c = await chooseVoicePython({ remembered: REM, plain: [PY], installerPick: LAUNCHER, probe: fake({ 'C:/old/python.exe': { runs: true, has: false }, 'py -3.12': { runs: true, has: true } }) });
  assert(same(c, LAUNCHER), 'a remembered Python without the voice packages gives way to the one that has them');
  c = await chooseVoicePython({ plain: [PY], installerPick: null, probe: fake({}) });
  assert(same(c, PY) && c.why === 'unchecked', 'nothing could be checked -> plain python, as before');
  assert(await chooseVoicePython({}) === null, 'no candidates -> null');
  let n = 0;
  c = await chooseVoicePython({ plain: [PY, PY, { cmd: 'python', pre: [] }], installerPick: PY, probe: async () => { n++; return { runs: true, has: false }; } });
  assert(n === 1, 'the same Python is checked once');

  console.log('\n== the real probe (fake execFile) ==');
  const calls = [];
  const exec = (cmd, args, o, cb) => { calls.push({ cmd, args }); setTimeout(() => (cmd === 'missing' ? cb(new Error('ENOENT')) : cb(null, cmd === 'python' ? 'HAS\n' : 'NONE\n')), 1); return { on() {} }; };
  const probe = makeProbe(exec);
  let r = await probe(PY);
  assert(r.runs && r.has, 'python with faster-whisper -> has');
  r = await probe(LAUNCHER);
  assert(r.runs && !r.has && calls[1].args[0] === '-3.12' && calls[1].args[1] === '-c' && calls[1].args[2] === PROBE_CODE, 'py -3.12 -c … (the version switch kept), none installed');
  assert(/find_spec\("faster_whisper"\)/.test(PROBE_CODE) && /find_spec\("piper"\)/.test(PROBE_CODE) && !/^import faster_whisper/.test(PROBE_CODE), 'a quick check (find_spec), not a heavy import');
  r = await probe({ cmd: 'missing', pre: [] });
  assert(!r.runs && !r.has, 'a Python that is not there -> does not run');
  await probe(PY);
  assert(calls.filter((x) => x.cmd === 'python').length === 1, 'answers are cached');
  probe.clear(); await probe(PY);
  assert(calls.filter((x) => x.cmd === 'python').length === 2, 'and can be checked again after an install');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
