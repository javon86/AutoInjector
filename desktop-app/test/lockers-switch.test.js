// test/lockers-switch.test.js — the 📁 AI lockers switch (lockers-switch.js), on its own:
//   * default off, and an older state file (no "lockers" key) migrates to off
//   * AUTOINJECTOR_LOCKERS=1 / =0 overrides the saved setting for one run
//   * the LOCKERS_OFF answer, the one-notice-per-AI gate (no loop / no spam)
//   * stripLockerTeaching removes every [TO: TERMINAL] / locker line and keeps the rest
//   * Alfred's lockers.* controls are hidden from his tools, app_help and "Everything I can do" while off
// Run with: node test/lockers-switch.test.js
const L = require('../lockers-switch');

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log(`  ok   - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } return cond; }

console.log('\n== 📁 lockers switch: default off, migration, env override ==');
assert(L.fromSnapshot({}) === false, 'a state file from an older build (no "lockers" key) reads as OFF — everyone starts hidden');
assert(L.fromSnapshot(null) === false && L.fromSnapshot({ lockers: {} }) === false && L.fromSnapshot({ lockers: { enabled: 'yes' } }) === false, 'anything but enabled:true is off');
assert(L.fromSnapshot({ lockers: { enabled: true } }) === true, 'a saved "on" stays on');
assert(JSON.stringify(L.toSnapshot(true)) === '{"enabled":true}' && JSON.stringify(L.toSnapshot(undefined)) === '{"enabled":false}', 'what is saved');
assert(L.effective(undefined, {}) === false, 'default (nothing saved, no env var): off');
assert(L.effective(true, {}) === true && L.effective(false, {}) === false, 'the saved setting applies');
assert(L.effective(false, { AUTOINJECTOR_LOCKERS: '1' }) === true && L.effective(false, { AUTOINJECTOR_LOCKERS: 'on' }) === true, 'AUTOINJECTOR_LOCKERS=1 turns them on for this run (the escape hatch)');
assert(L.effective(true, { AUTOINJECTOR_LOCKERS: '0' }) === false, 'AUTOINJECTOR_LOCKERS=0 forces them off');
assert(L.envOverride({ AUTOINJECTOR_LOCKERS: '' }) === null && L.envOverride({}) === null && L.envOverride({ AUTOINJECTOR_LOCKERS: 'maybe' }) === null, 'an empty / unknown env value changes nothing');

console.log('\n== 📁 lockers switch: the off answer and the one notice per AI ==');
const off = L.offResult();
assert(off.ok === false && off.error === 'LOCKERS_OFF' && off.message === 'AI lockers are switched off (⚙ Advanced → AI lockers).', 'the IPC answer while off');
off.ok = true; assert(L.offResult().ok === false, 'each answer is a fresh object');
assert(/File commands are switched off in AutoInjector/.test(L.OFF_NOTICE) && /won't be told again/.test(L.OFF_NOTICE) && L.OFF_NOTICE.length < 400, 'the notice an AI gets is short and plain');
const gate = L.createNoticeGate();
assert(gate.first('claude') === true && gate.first('claude') === false && gate.first('claude') === false, 'one notice per AI — a model that keeps trying is not told again (no loop)');
assert(gate.first('gemini') === true && gate.told('claude') && gate.told('gemini') && !gate.told('chatgpt'), 'each AI is told once, on its own');
gate.reset(); assert(gate.first('claude') === true, 'reset (app start / switch flipped) allows one notice again');

console.log('\n== 📁 lockers switch: the protocol explainer without terminal / locker lines ==');
const routingOn = 'Quick reference. START with a tag on its own line — [TO: CHATGPT], [TO: CLAUDE], [TO: GEMINI], [TO: ALL], [TO: USER], [TO: TERMINAL], or [TO: NONE] — to control who sees it next: a specific one of us, everyone, just the human running this, your own private folder ("locker") on the human\'s PC, through a command prompt that only works inside it (put commands in a ``` code block — dir, type, copy, del, md, plus write/append/give/send; send `help` for the list; results come back as a [FROM: TERMINAL] message; `send <file> to <ai>` passes a file to another of us), or nobody if you have nothing to add. END with [FROM: CLAUDE].' +
  '\n\nYOUR LOCKER (your own private folder on this PC):\n• Address it with [TO: TERMINAL] and put commands in a ``` code block.\n• give <file> — the app puts the file into this chat.\nResults come back to you as a [FROM: TERMINAL] message.';
const stripped = L.stripLockerTeaching(routingOn);
assert(!/TERMINAL/.test(stripped) && !/locker/i.test(stripped) && !/give <file>/.test(stripped), 'no [TO: TERMINAL], no locker, no file commands left');
assert(/\[TO: USER\], or \[TO: NONE\]/.test(stripped) && /just the human running this, or nobody if you have nothing to add/.test(stripped) && /END with \[FROM: CLAUDE\]/.test(stripped), `the rest reads cleanly (${stripped.slice(60, 200)}…)`);
const userLines = 'Be kind.\nUse [TO: TERMINAL] for files.\nAlways end with [FROM: GEMINI].';
assert(L.stripLockerTeaching(userLines) === 'Be kind.\nAlways end with [FROM: GEMINI].', 'a line the user wrote about the terminal goes as a whole line, the others stay');
assert(L.stripLockerTeaching('plain text') === 'plain text' && L.stripLockerTeaching(null) === '', 'text without terminal lines is unchanged');

console.log('\n== 🎩 Alfred: lockers.* hidden while off, back when on ==');
const appActions = require('../alfred-app-actions');
const registry = require('../alfred-tools');
const catalog = require('../alfred-catalog');
const lockerIds = appActions.ACTIONS.filter((a) => a.id.startsWith('lockers.')).map((a) => a.id);
assert(lockerIds.length === 5 && appActions.ACTIONS.filter((a) => a.feature === 'lockers').length === 5, 'the five lockers.* controls are still in the fixed list (the code is kept)');
appActions.setFeature('lockers', false);
const toolText = () => registry.openAiTools({}).map((t) => t.function.description).join('\n');
const catIds = () => catalog.build({}).groups.flatMap((g) => g.items.map((i) => i.id));
assert(!appActions.featureOn('lockers'), 'off by default');
assert(lockerIds.every((id) => appActions.get(id) === null), 'off: Alfred cannot find (or run) any lockers.* control');
assert(!/lockers\./.test(toolText()), 'off: his tool list (app_info / app_control) does not offer them');
assert(!appActions.help('lockers').length && !appActions.help().some((h) => h.action.startsWith('lockers.')), 'off: app_help does not list them');
assert(!catIds().some((id) => id.startsWith('lockers.')), 'off: "Everything I can do" does not list them');
assert(appActions.get('downloads.list') && catIds().includes('downloads.list'), 'the ⬇ downloads controls are still there');
const appControl = registry.get('app_control');
assert(!appControl.check({ action: 'lockers.open', args: {} }).ok, 'off: app_control refuses lockers.open');
appActions.setFeature('lockers', true);
assert(lockerIds.every((id) => appActions.get(id)), 'on: every lockers.* control is back');
assert(/lockers\.list/.test(toolText()) && /lockers\.open/.test(toolText()), 'on: his tool list offers them again');
assert(catIds().includes('lockers.list') && appActions.help('lockers').length === 5, 'on: "Everything I can do" and app_help list them again');
assert(appControl.check({ action: 'lockers.open', args: {} }).ok, 'on: app_control accepts lockers.open again');
appActions.setFeature('lockers', false);
appActions.setFeature('nonsense', true);
assert(appActions.featureOn('nonsense') === false, 'an unknown feature name is ignored');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
