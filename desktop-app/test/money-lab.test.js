// test/money-lab.test.js — 🧪 Money lab, AutoInjector's side:
//   * money-lab.js: settings kept in range; can this PC run it (Windows Sandbox on / off / not Windows); the .wsb file
//     (network, the five folders, kit + control read-only, the start script); the mission; the status read with the
//     clock; the asks with your answers; an allowed account ask unlocks sign-in on that site; the ledger lines
//   * money-lab-main.js with a real temp folder and a fake spawn: ▶ Start copies the kit, writes the mission and the
//     .wsb and opens Windows Sandbox with it; not twice; ⏸ stop; ⏹ close (taskkill); your Yes / No; a desktop notice
//     for a new ask (not for the ones already there); the folders
//   * money-lab-ui.js: the window's model; the real lab.html in jsdom — the asks with Yes / No (calls the API), an
//     AI's text never becomes HTML, the "Windows Sandbox isn't ready" steps
//   * the wiring: IPC handlers, preload, the 🧪 button, packaged files
// Run with: node test/money-lab.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../money-lab');
const { createMoneyLab } = require('../money-lab-main');
const UI = require('../money-lab-ui');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); }
  return cond;
}
const DIR = path.join(__dirname, '..');

(async () => {
  console.log('== money-lab.js ==');
  const s = L.normalizeSettings({ hours: 999, roundMinutes: 1, style: 'x', agents: { claude: 1 }, mission: '   ', memoryMB: 1, autoStart: 'yes' });
  assert(s.hours === 72 && s.roundMinutes === 5 && s.style === 'solo' && s.memoryMB === 4096, 'settings kept in range');
  assert(s.agents.claude === true && s.agents.codex === false, 'AIs ticked as given');
  assert(s.mission === L.DEFAULT_MISSION && s.autoStart === false, 'an empty mission → the default one; autoStart only on a real true');
  assert(L.normalizeSettings(null).agents.codex === true && L.normalizeSettings(null).hours === 2, 'defaults: both AIs, 2 hours');
  assert(L.availability({ platform: 'linux', sandboxExe: 'x', exists: () => true }).code === 'NOT_WINDOWS', 'not Windows → says so');
  const off = L.availability({ platform: 'win32', sandboxExe: 'C:\\Windows\\System32\\WindowsSandbox.exe', exists: () => false });
  assert(off.code === 'SANDBOX_OFF' && off.steps.length >= 3 && off.steps.some((x) => /Pro/.test(x)) && off.steps.some((x) => /BIOS/.test(x)), 'Windows Sandbox off → the steps to turn it on');
  assert(L.availability({ platform: 'win32', sandboxExe: 'X', exists: () => true }).ok, 'Windows Sandbox there → ready');
  assert(L.sandboxExePath({ SystemRoot: 'D:\\Win' }) === 'D:\\Win\\System32\\WindowsSandbox.exe', 'the Windows Sandbox program path');
  const P = L.labPaths('C:\\Users\\Me\\Documents\\AutoInjector Money lab & co');
  const wsb = L.buildWsb(P, { memoryMB: 12288 });
  assert(/<Networking>Enable<\/Networking>/.test(wsb) && /<MemoryInMB>12288<\/MemoryInMB>/.test(wsb), 'wsb: network on, the memory');
  assert((wsb.match(/<MappedFolder>/g) || []).length === 5, 'wsb: exactly the five lab folders are shared');
  const ro = (name) => new RegExp(`${name}</HostFolder>\\s*<SandboxFolder>C:\\\\Users\\\\WDAGUtilityAccount\\\\Desktop\\\\${name}</SandboxFolder>\\s*<ReadOnly>(true|false)</ReadOnly>`).exec(wsb);
  assert(ro('lab-kit')[1] === 'true' && ro('lab-control')[1] === 'true', 'wsb: the kit and your decisions are read-only inside');
  assert(ro('workshop')[1] === 'false' && ro('lab-cache')[1] === 'false' && ro('lab-logins')[1] === 'false', 'wsb: workshop, cache, sign-ins writable');
  assert(wsb.includes('&amp; co') && !/& co/.test(wsb), 'wsb: the folder name is XML-escaped');
  assert(/<LogonCommand>[\s\S]*lab-kit\\start\.ps1/.test(wsb) && /<vGPU>Disable/.test(wsb) && /<PrinterRedirection>Disable/.test(wsb), 'wsb: start.ps1 at logon; GPU and printers not shared');
  const m = L.buildMission({ agents: { claude: true, codex: false }, hours: 3 }, 1700000000000);
  assert(/^lab-[a-z0-9]+$/.test(m.id) && m.agents.join() === 'claude' && m.hours === 3, 'the mission file');
  const core = require('../money-lab-kit/runner-core');
  assert(core.normalizeMission(m) !== null, 'the mission file is one the runner accepts');
  const now = 5000000;
  assert(L.readStatus(null, now).phase === 'off', 'no status → closed');
  const live = L.readStatus({ phase: 'working', words: 'Round 2', heartbeat: now - 20000, round: 2, agents: { claude: { state: 'working', money: 4 }, gemini: {} } }, now);
  assert(live.alive && live.phase === 'working' && live.agents.length === 1 && live.agents[0].money === 4, 'a fresh heartbeat → running; only known AIs');
  const stale = L.readStatus({ phase: 'working', heartbeat: now - 5 * 60000 }, now);
  assert(!stale.alive && stale.phase === 'off' && /no word/.test(stale.words), 'an old heartbeat → closed (the sandbox was shut)');
  assert(L.readStatus({ phase: 'setting-up', heartbeat: now - 6 * 60000 }, now).alive && !L.readStatus({ phase: 'setting-up', heartbeat: now - 25 * 60000 }, now).alive, 'first-time set-up: minutes without a heartbeat are fine, not forever');
  assert(L.readStatus({ phase: 'finished', words: 'Done', heartbeat: now - 3600000 }, now).phase === 'finished', 'finished stays finished');
  const av = L.asksView([{ id: 'claude-aaaa', agent: 'claude', kind: 'post', what: 'A', at: 1 }, { id: 'codex-bbbb', agent: 'codex', kind: 'account', site: 'etsy.com', what: 'B', at: 2 }, { id: 'bad id', agent: 'claude', what: 'x' }],
    [{ id: 'claude-aaaa', allow: true, at: 3 }]);
  assert(av.length === 2 && av[0].id === 'codex-bbbb' && !av[0].answer && av[1].answer.allow, 'asks: open ones first, bad ones dropped');
  const af = L.answerFor({ id: 'codex-bbbb', kind: 'account', site: 'etsy.com' }, true, ' fine ', 9, ['gumroad.com']);
  assert(af.answer.allow && af.answer.note === 'fine' && af.approved.join() === 'gumroad.com,etsy.com', 'yes to an account → sign-in unlocked on that site');
  assert(L.answerFor({ id: 'codex-bbbb', kind: 'account', site: 'etsy.com' }, false, '', 9, []).approved.length === 0, 'no → nothing unlocked');
  assert(L.answerFor({ id: 'x-1234', kind: 'post', site: 'reddit.com' }, true, '', 9, []).approved.length === 0, 'yes to a post doesn\'t unlock sign-in');
  assert(L.ledgerTail('# L\n| When | Who |\n|---|---|\n| 1 Nov | Claude | $5 |\nnot a row').join() === '| 1 Nov | Claude | $5 |', 'ledger: only the money rows');

  console.log('== money-lab-main.js (temp folder, fake spawn) ==');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mlab-'));
    const sys = path.join(root, 'Windows');
    fs.mkdirSync(path.join(sys, 'System32'), { recursive: true });
    const exe = path.win32.join(sys, 'System32', 'WindowsSandbox.exe');
    const spawned = [];
    const notices = [];
    const fakeSpawn = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
    let t = 1700000000000;
    const existsFake = { [exe]: true };
    const fsx = Object.assign({}, fs, { existsSync: (f) => existsFake[f] || fs.existsSync(f) });
    const lab = createMoneyLab({ root: path.join(root, 'lab'), kitSource: path.join(DIR, 'money-lab-kit'), fs: fsx, spawn: fakeSpawn, now: () => t, platform: 'win32', env: { SystemRoot: sys }, notify: (a, b) => notices.push([a, b]) });
    assert(lab.status().available.ok, 'Windows Sandbox found');
    let r = lab.start({ agents: { claude: false, codex: false } });
    assert(!r.ok && r.error === 'NO_AI', 'no AI ticked → refused');
    r = lab.start({ agents: { claude: true, codex: true }, hours: 4, mission: 'Earn honestly' });
    assert(r.ok, `▶ Start (${r.words})`);
    assert(spawned.length === 1 && spawned[0].cmd === exe && spawned[0].args[0] === lab.paths.wsb && spawned[0].opts.detached, 'Windows Sandbox opened with the lab\'s .wsb');
    assert(fs.existsSync(path.join(lab.paths.kit, 'runner.js')) && fs.existsSync(path.join(lab.paths.kit, 'start.ps1')) && fs.existsSync(path.join(lab.paths.kit, 'RULES.md')), 'the kit is copied into lab-kit');
    const mission = JSON.parse(fs.readFileSync(lab.paths.mission, 'utf8'));
    assert(mission.mission === 'Earn honestly' && mission.hours === 4 && mission.agents.length === 2, 'the mission is written');
    assert(/<Configuration>/.test(fs.readFileSync(lab.paths.wsb, 'utf8')), 'the .wsb is written');
    assert(lab.getSettings().hours === 4, 'the settings are saved');
    assert(['workshop', 'lab-cache', 'lab-logins', 'lab-control'].every((f) => fs.existsSync(path.join(lab.paths.root, f))), 'the lab folders exist');
    fs.writeFileSync(lab.paths.status, JSON.stringify({ phase: 'working', heartbeat: t, agents: {} }));
    r = lab.start(null);
    assert(!r.ok && r.error === 'ALREADY_OPEN' && spawned.length === 1, 'not opened twice');
    r = lab.stopAfterRound();
    assert(r.ok && JSON.parse(fs.readFileSync(lab.paths.stop, 'utf8')).mission_id === mission.id, '⏸ stop after this round → stop.json for this mission');
    // asks + answers + notices
    assert(lab.poll().fresh === 0, 'the first look only remembers');
    fs.writeFileSync(path.join(lab.paths.asks, 'codex-q1w2.json'), JSON.stringify({ id: 'codex-q1w2', agent: 'codex', kind: 'account', site: 'gumroad.com', what: 'Make a Gumroad account', why: 'to sell', at: t }));
    fs.writeFileSync(path.join(lab.paths.asks, 'evil.json'), '{"id":"../../x","agent":"codex","what":"x"}');
    fs.writeFileSync(path.join(lab.paths.asks, 'big.json'), JSON.stringify({ id: 'codex-big1', agent: 'codex', what: 'x'.repeat(30000) }));
    const p1 = lab.poll();
    assert(p1.fresh === 1 && notices.length === 1 && /ChatGPT asks: account on gumroad\.com/.test(notices[0][0]), 'a new ask → one desktop notice');
    assert(lab.poll().fresh === 0 && notices.length === 1, 'the same ask isn\'t announced twice');
    assert(lab.status().asks.length === 1, 'bad and oversized ask files are ignored');
    r = lab.answer('codex-q1w2', true, 'Use the name Tide');
    assert(r.ok && r.allowed, 'Yes saved');
    const ans = JSON.parse(fs.readFileSync(path.join(lab.paths.answers, 'codex-q1w2.json'), 'utf8'));
    assert(ans.allow === true && ans.note === 'Use the name Tide', 'the answer file');
    assert(JSON.parse(fs.readFileSync(lab.paths.approved, 'utf8')).includes('gumroad.com'), 'sign-in unlocked on gumroad.com');
    assert(lab.status().asks[0].answer.allow === true, 'the window shows your answer');
    assert(!lab.answer('../../etc', true).ok && !lab.answer('codex-nope', true).ok, 'answers only to real asks');
    // the Command Prompt logs and the talk, for the window (only the end of big files is read)
    fs.mkdirSync(path.join(lab.paths.workshop, 'console'), { recursive: true });
    fs.writeFileSync(path.join(lab.paths.workshop, 'console', 'claude.log'), `${'old line\n'.repeat(5000)}[10:00:01] Claude C:\\w> dir /b\r\nplanner.pdf\r\n[exit 0, 0.2 s]\n`);
    fs.writeFileSync(path.join(lab.paths.workshop, 'talk.log'), '[10:00] Claude → ChatGPT: I build, you list\n');
    const stc = lab.status();
    assert(stc.consoles.claude.slice(-3).join('|') === '[10:00:01] Claude C:\\w> dir /b|planner.pdf|[exit 0, 0.2 s]' && stc.consoles.claude.length === 80 && stc.consoles.codex.length === 0, 'status: the end of each AI\'s Command Prompt log');
    assert(stc.talk.length === 1 && /I build, you list/.test(stc.talk[0]), 'status: the lab talk');
    // close
    spawned.length = 0;
    r = lab.closeNow();
    assert(r.ok && spawned.length === 4 && spawned.every((x) => x.cmd === 'taskkill' && x.args[0] === '/IM'), '⏹ close → the Windows Sandbox programs are ended');
    assert(lab.status().status.phase === 'closed' || lab.status().status.phase === 'off', 'shown as closed');
    assert(lab.folder('workshop') === lab.paths.workshop && lab.folder('claude').endsWith(path.join('claude', 'products')) && lab.folder('../x') === null, 'the folders it may open');
    spawned.length = 0;
    r = lab.enableSandbox();
    assert(r.ok && spawned[0].cmd === 'powershell.exe' && /RunAs/.test(spawned[0].args.join(' ')) && /Containers-DisposableClientVM/.test(spawned[0].args.join(' ')), 'Turn Windows Sandbox on → an admin PowerShell that enables the feature');
    // not Windows / sandbox off
    const lab2 = createMoneyLab({ root: path.join(root, 'lab2'), kitSource: path.join(DIR, 'money-lab-kit'), fs, spawn: fakeSpawn, platform: 'linux', env: {} });
    assert(lab2.start({}).error === 'NOT_WINDOWS' && lab2.closeNow().error === 'NOT_WINDOWS', 'not Windows → refused, nothing started');
    const lab3 = createMoneyLab({ root: path.join(root, 'lab3'), kitSource: path.join(DIR, 'money-lab-kit'), fs, spawn: fakeSpawn, platform: 'win32', env: { SystemRoot: path.join(root, 'nowhere') } });
    const r3 = lab3.start({});
    assert(r3.error === 'SANDBOX_OFF' && r3.steps.length >= 3 && !fs.existsSync(path.join(root, 'lab3', 'money-lab.wsb')), 'Windows Sandbox off → the steps, nothing written');
    const lab4 = createMoneyLab({ root: path.join(root, 'lab4'), kitSource: path.join(root, 'no-kit'), fs: fsx, spawn: fakeSpawn, platform: 'win32', env: { SystemRoot: sys } });
    const r4 = lab4.start({});
    assert(!r4.ok && r4.error === 'START_FAILED', 'a missing kit → a clear error, no crash');
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('== money-lab-ui.js ==');
  const data = {
    available: { ok: true, code: 'READY' }, settings: L.normalizeSettings({}),
    status: { alive: true, phase: 'working', words: 'Round 2', round: 2, endsAt: now + 90 * 60000, roundEndsAt: now + 10 * 60000, moneyClaimed: 7, agents: [{ id: 'claude', label: 'Claude', tool: 'Claude Code', state: 'working', words: 'Working on round 2', last: 'DID: x', money: 7, rounds: 1 }] },
    asks: [{ id: 'claude-zz11', agent: 'claude', label: 'Claude', kind: 'post', site: 'reddit.com', what: '<img src=x onerror="window.pwned=1">Post it', why: 'reach', at: now, answer: null },
      { id: 'codex-yy22', agent: 'codex', label: 'ChatGPT', kind: 'account', site: 'etsy.com', what: 'Shop', at: now, answer: { allow: false, note: 'not yet' } }],
    ledger: ['| 1 Nov | Claude | $7 | Gumroad | receipt |'], products: { claude: ['planner.pdf'], codex: [] }, workshop: 'W',
    consoles: { claude: ['[10:00:01] Claude C:\\w> dir', '<b>not html</b>', '[exit 0, 0.1 s]'], codex: [] }, talk: ['[10:00] Claude → ChatGPT: I build, you list'],
  };
  const mm = UI.model(data, now);
  assert(mm.running && mm.canStop && !mm.canStart && mm.timeLeft === '1 h 30 min left' && mm.roundLeft === '10 min left', 'model: running, the time left');
  assert(mm.openAsks.length === 1 && mm.answeredAsks.length === 1 && /You said no — “not yet”/.test(mm.answeredAsks[0].answer), 'model: open and answered asks');
  assert(mm.moneyClaimed === '$7.00' && mm.agents[0].money === '$7.00', 'model: the money they claim');
  const mOff = UI.model({ available: { ok: false, code: 'SANDBOX_OFF', words: 'off', steps: ['a'] }, status: { phase: 'off' } }, now);
  assert(!mOff.canStart && !mOff.available && mOff.steps.length === 1, 'model: sandbox off → no Start, the steps');

  let JSDOM = null;
  try { ({ JSDOM } = require('jsdom')); } catch (_) { /* not installed */ }
  if (!JSDOM) assert(true, 'jsdom not installed — the window tests skipped');
  else {
    const html = fs.readFileSync(path.join(DIR, 'lab.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///lab.html' });
    const w = dom.window;
    w.eval(fs.readFileSync(path.join(DIR, 'money-lab-ui.js'), 'utf8'));
    const calls = [];
    const api = {
      labStatus: async () => data,
      labAnswer: async (id, allow, note) => { calls.push(['answer', id, allow, note]); return { ok: true, words: 'Allowed.' }; },
      labStart: async (st) => { calls.push(['start', st]); return { ok: true, words: 'opening' }; },
      labSave: async (st) => { calls.push(['save', st]); return { ok: true }; },
      labStop: async () => { calls.push(['stop']); return { ok: true, words: 'stopping' }; },
      labClose: async () => ({ ok: true }), labOpen: async (x) => { calls.push(['open', x]); return { ok: true }; }, labEnable: async () => ({ ok: true }),
    };
    const stopTimer = w.MoneyLabUi.start(w.document, api);
    await new Promise((r) => setTimeout(r, 50));
    const $ = (id) => w.document.getElementById(id);
    assert($('lab-mission').value === L.DEFAULT_MISSION && $('lab-ai-claude').checked && $('lab-hours').value === '2', 'the form is filled from the saved settings');
    assert($('lab-phase').textContent === 'Working' && /Round 2/.test($('lab-words').textContent), 'what is happening now');
    assert($('lab-start').disabled && !$('lab-stop').disabled, 'Start off while running; Stop on');
    const askCards = w.document.querySelectorAll('[data-testid="lab-ask"]');
    assert(askCards.length === 1 && /reddit\.com/.test(askCards[0].textContent), 'the waiting ask is shown');
    assert(!w.document.querySelector('#lab-asks img') && !w.pwned && /<img src=x/.test(askCards[0].querySelector('.lab-ask-what').textContent), 'an AI\'s text is shown as text, never as HTML');
    askCards[0].querySelector('.lab-ask-note').value = 'only r/planners';
    askCards[0].querySelector('[data-testid="lab-ask-yes"]').click();
    await new Promise((r) => setTimeout(r, 30));
    assert(calls.some((c) => c[0] === 'answer' && c[1] === 'claude-zz11' && c[2] === true && c[3] === 'only r/planners'), 'Yes → labAnswer(id, true, your note)');
    assert(/Allowed/.test($('lab-msg').textContent), 'the answer is confirmed');
    assert(/You said no/.test($('lab-asks-done').textContent), 'earlier answers listed');
    assert(/planner\.pdf/.test($('lab-products').textContent) && /\$7/.test($('lab-ledger').textContent), 'what they made and the ledger');
    assert(/I build, you list/.test($('lab-talk').textContent), 'the window shows what they say to each other');
    assert(/dir/.test($('lab-console-claude').textContent) && /<b>not html<\/b>/.test($('lab-console-claude').textContent) && !$('lab-console-claude').querySelector('b'), 'the window shows each Command Prompt, as text');
    assert(/hasn't used its Command Prompt/.test($('lab-console-codex').textContent), 'an AI with no commands yet says so');
    $('lab-stop').click();
    await new Promise((r) => setTimeout(r, 30));
    assert(calls.some((c) => c[0] === 'stop'), '⏸ Stop → labStop');
    $('lab-hours').value = '6';
    $('lab-ai-codex').checked = false;
    data.status = { alive: false, phase: 'off', agents: [] };
    await w.MoneyLabUi.refresh();
    assert(!$('lab-start').disabled, 'closed → Start on');
    $('lab-start').click();
    await new Promise((r) => setTimeout(r, 30));
    const st = calls.find((c) => c[0] === 'start');
    assert(st && st[1].hours === 6 && st[1].agents.codex === false && st[1].agents.claude === true, '▶ Start sends the form');
    data.available = { ok: false, code: 'SANDBOX_OFF', words: 'Windows Sandbox is not turned on', steps: ['one', 'two'] };
    await w.MoneyLabUi.refresh();
    assert(!$('lab-avail').hidden && $('lab-avail-steps').children.length === 2 && !$('lab-enable').hidden && $('lab-start').disabled, 'Sandbox off → the steps and the Turn on button; no Start');
    stopTimer();
  }

  console.log('== wiring ==');
  const main = fs.readFileSync(path.join(DIR, 'main.js'), 'utf8');
  for (const ch of ['lab:window', 'lab:status', 'lab:save', 'lab:start', 'lab:stop', 'lab:close', 'lab:answer', 'lab:open', 'lab:enable']) assert(main.includes(`ipcMain.handle("${ch}"`), `main.js handles ${ch}`);
  assert(/AutoInjector Money lab/.test(main) && /target === "lab"/.test(main), 'main.js: the lab folder in Documents; a notice click opens the lab');
  const preload = fs.readFileSync(path.join(DIR, 'preload.js'), 'utf8');
  for (const fn of ['labOpenWindow', 'labStatus', 'labSave', 'labStart', 'labStop', 'labClose', 'labAnswer', 'labOpen', 'labEnable']) assert(preload.includes(`${fn}:`), `preload: ${fn}`);
  const controls = fs.readFileSync(path.join(DIR, 'controls.html'), 'utf8');
  assert(/id="btn-lab"/.test(controls) && /labOpenWindow/.test(fs.readFileSync(path.join(DIR, 'controls.js'), 'utf8')), 'the 🧪 button in the title bar opens the lab');
  const pkg = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
  for (const f of ['money-lab.js', 'money-lab-main.js', 'money-lab-ui.js', 'lab.html', 'lab.js', 'money-lab-kit/**/*']) assert(pkg.build.files.includes(f), `packaged: ${f}`);
  assert(pkg.build.asarUnpack.includes('money-lab-kit/**/*'), 'the kit is unpacked (copied out to the lab)');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
