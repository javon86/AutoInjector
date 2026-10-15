// test/feature-test.test.js — the 🧪 Feature Test orchestrator (feature-test.js),
// driven against a simulated world of AIs + lockers. Checks that each step is
// judged by program-visible evidence, that a dead AI is skipped quickly, that a
// safety hole is reported as a FAIL, and that the report shows how replies end.
// Run: node test/feature-test.test.js
const ft = require('../feature-test');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

// A tiny simulated app: each AI "does" whatever the test prompt asks, unless
// told to misbehave.
function makeWorld({ dead = [], ignoresTerminalResult = [], unsafe = false, trailingJunk = {} } = {}) {
  let clock = 1000;
  const captures = []; const termReplies = []; const ledger = []; const files = {}; const grants = {};
  const now = () => clock;
  const sleep = async (ms) => { clock += ms; };
  const cap = (site, text) => captures.push({ site, text: text + (trailingJunk[site] || ''), ts: clock++ });
  const term = (site, text) => termReplies.push({ site, text, ts: clock++ });
  function bodyOf(prompt) {
    const m = /nothing else:\n([\s\S]*?)\n\[FROM: (\w+)\]/.exec(prompt);
    return m ? m[1] : '';
  }
  async function send(site, prompt) {
    ledger.push({ target: site, text: prompt, ok: true, ts: clock++ });
    if (dead.includes(site)) return { ok: true };
    const body = bodyOf(prompt);
    const tag = /^\[TO: (\w+)\]/.exec(body);
    if (!tag) return { ok: true };
    cap(site, `${body}\n[FROM: ${site.toUpperCase()}]`);
    const to = tag[1].toLowerCase();
    if (to === 'terminal') {
      const cmd = /```\n([\s\S]*?)\n```/.exec(body)[1].split('\n');
      const [verb, ...rest] = cmd[0].split(' ');
      let out = '';
      if (verb === 'write') { files[`${site}:${rest.join(' ')}`] = cmd.slice(1).join('\n'); out = 'Saved'; }
      else if (verb === 'type' || verb === 'cat') {
        const f = rest.join(' ');
        if (/^(C:|\/)/.test(f)) out = unsafe ? '[fonts]' : 'refused — not allowed in your locker';
        else out = files[`${site}:${f}`] || 'NOT_FOUND';
      } else if (verb === 'give') out = `----- ${rest[0]} -----\n${files[`${site}:${rest[0]}`]}\n----- end of file -----`;
      else if (verb === 'send') {
        const [f, , to2] = rest; const name = f.split(/[\\/]/).pop();
        files[`${to2}:inbox/from-${site}/${name}`] = files[`${site}:${f}`]; out = 'Sent';
      } else if (verb === 'share') { (grants[rest[1]] = grants[rest[1]] || []).push(site); out = 'Shared'; }
      term(site, `[FROM: TERMINAL]\nResults from your locker (1 command):\n\n> ${cmd[0]}\n${out}`);
      if (verb === 'cat' || verb === 'type') {
        if (!ignoresTerminalResult.includes(site) && !/refused/.test(out)) cap(site, `[TO: USER]\n${out}\n[FROM: ${site.toUpperCase()}]`);
      }
    } else if (to !== 'user') {
      ledger.push({ target: to, text: `[${site} → you]\n\n${body.split('\n').slice(1).join('\n')}`, ok: true, ts: clock++ });
    }
    return { ok: true };
  }
  return {
    now, sleep, send,
    captureSince: (site, ts) => captures.filter((c) => c.site === site && c.ts >= ts),
    terminalRepliesSince: (site, ts) => termReplies.filter((c) => c.site === site && c.ts >= ts),
    ledgerSince: (target, ts) => ledger.filter((e) => e.target === target && e.ts >= ts),
    fileHas: (site, rel, needle) => String(files[`${site}:${rel}`] || '').includes(needle),
    grantsFor: (site) => grants[site] || [],
    isBusy: () => false,
    _files: files,
  };
}

async function main() {
  console.log('\n== all three AIs healthy ==');
  let w = makeWorld();
  const progress = [];
  let r = await ft.runFeatureTest({ ...w, sites: ['chatgpt', 'claude', 'gemini'], platform: 'linux', label: (s) => s.toUpperCase(), stepTimeoutMs: 5000, pollMs: 50, settleMs: 10, onProgress: (p) => progress.push(p) });
  assert(r.ok && r.total === 24, `8 steps × 3 AIs (${r.total})`);
  assert(r.okCount === 24 && r.failCount === 0, `everything passes (${r.okCount} ok, ${r.failCount} failed)`);
  assert(progress.filter((p) => p.status === 'running').length === 24 && progress.some((p) => p.status === 'pass'), 'progress is reported for every step');
  assert(Object.keys(w._files).some((k) => /^claude:inbox\/from-chatgpt\/FT-/.test(k)), 'the send step really put a file in the next AI\'s inbox');
  const report = ft.formatReport(r, { label: (s) => s.toUpperCase() });
  assert(/24 passed, 0 failed/.test(report) && /How each AI's replies actually ended/.test(report), 'report has the summary + the reply-endings section');
  assert(/ends with \[FROM:\] ✅/.test(report), 'healthy endings are marked');

  console.log('\n== one AI dead, one ignores terminal results, junk after [FROM:] ==');
  w = makeWorld({ dead: ['gemini'], ignoresTerminalResult: ['claude'], trailingJunk: { chatgpt: '\n\nCopy\nRetry\nThumbs up thumbs down feedback buttons here' } });
  r = await ft.runFeatureTest({ ...w, sites: ['chatgpt', 'claude', 'gemini'], platform: 'win32', stepTimeoutMs: 2000, pollMs: 50, settleMs: 10 });
  const by = (site, step) => r.results.find((x) => x.site === site && x.step === step);
  assert(by('gemini', 'reply').ok === false && /timed out/.test(by('gemini', 'reply').detail), 'a dead AI fails step 1 with a timeout');
  assert(['write', 'read', 'relay'].every((s) => by('gemini', s).ok === null), 'and its other steps are SKIPPED, not 7 more timeouts');
  assert(by('claude', 'read').ok === false && /never repeated it back/.test(by('claude', 'read').detail), 'an AI that ignores the terminal result is pinpointed');
  assert(by('claude', 'write').ok === true && by('claude', 'give').ok === true, 'its other locker steps still pass');
  assert(by('chatgpt', 'reply').tip === undefined && by('claude', 'read').tip, 'failures carry a fix tip; passes do not');
  const rep2 = ft.formatReport(r);
  assert(/NO \[FROM:\] at the end ⚠/.test(rep2) && /Thumbs up/.test(rep2), 'the report shows chatgpt\'s reply ending has extra UI text after [FROM:]');
  assert(/What to fix/.test(rep2), 'the report lists what to fix');
  const winPrompt = w.ledgerSince('chatgpt', 0).map((e) => e.text).find((t) => /write feature-test\\FT-/.test(t));
  assert(!!winPrompt, 'on Windows the test uses backslash paths');

  console.log('\n== a safety hole is a FAIL ==');
  w = makeWorld({ unsafe: true });
  r = await ft.runFeatureTest({ ...w, sites: ['claude'], platform: 'linux', stepTimeoutMs: 2000, pollMs: 50, settleMs: 10 });
  const safety = r.results.find((x) => x.step === 'safety');
  assert(safety.ok === false && /NOT refused/.test(safety.detail) && /IMPORTANT/.test(safety.tip), 'an un-refused outside read is reported loudly');
  assert(['send', 'share', 'relay'].every((s) => r.results.find((x) => x.step === s).ok === null), 'with one AI, the two-AI steps are skipped (not failed)');

  console.log('\n== stop ==');
  w = makeWorld({ dead: ['chatgpt'] });
  let calls = 0;
  r = await ft.runFeatureTest({ ...w, sites: ['chatgpt', 'claude'], platform: 'linux', stepTimeoutMs: 100000, pollMs: 50, settleMs: 10, shouldStop: () => ++calls > 5 });
  assert(r.stopped === true && r.results.length <= 2, 'Stop ends the run promptly');

  assert((await ft.runFeatureTest({ ...makeWorld(), sites: [] })).error === 'NO_PARTICIPANTS', 'no participants -> NO_PARTICIPANTS');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
