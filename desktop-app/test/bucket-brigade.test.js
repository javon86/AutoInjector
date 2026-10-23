// test/bucket-brigade.test.js — TR-14 Bucket Brigade, run against a simulated
// world of AIs + the app's relay. Checks the scoring splits APP faults from AI
// faults, repairs a broken chain, and catches altered items.
// Run: node test/bucket-brigade.test.js
const bb = require('../bucket-brigade');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ok   - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } return c; }

// A tiny event-driven world. AIs follow the rules unless told to misbehave;
// the "app" relays [TO: X] replies like main.js does (frame + stripped body).
function makeWorld({ flattens = [], wrongTargetOnce = null, dropCaptureOnce = null, dupRelayOnce = null, appMangles = false, replyDelay = 5000 } = {}) {
  let clock = 0;
  const queue = []; const captures = []; const sends = [];
  let order = [];
  const flags = { wrongDone: false, dropDone: false, dupDone: false };
  const LBL = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };
  function aiReply(site, text) {
    if (!/^BRIGADE/m.test(text) || /Reply to THIS message with just NONE/.test(text)) return null;
    const got = bb.parseItems(text);
    const last = got.ids[got.ids.length - 1];
    const k = bb.IDS.indexOf(last) + 1;
    const mineStart = order.indexOf(site);
    if ((k - 1) % order.length !== mineStart) return 'NONE';
    const id = bb.IDS[k];
    const next = id === 'B20' ? 'USER' : order[(order.indexOf(site) + 1) % order.length].toUpperCase();
    let to = next;
    if (wrongTargetOnce === site && !flags.wrongDone && id !== 'B20') { flags.wrongDone = true; to = order.find((s) => s !== site && s.toUpperCase() !== next).toUpperCase(); }
    let items = [...got.ids.map((i) => `${i}: ${got.items[i]}`), `${id}: ${bb.ITEMS[id]}`].join('\n');
    if (flattens.includes(site)) items = items.replace(/\n(?!B\d\d:)/g, ' ');
    return `[TO: ${to}]\nBRIGADE\n${items}\n[FROM: ${site.toUpperCase()}]`;
  }
  function deliver(site, text, from) {
    sends.push({ target: site, text, ok: true, verified: true, ts: clock });
    queue.push({ at: clock + replyDelay, site, text });
  }
  function process() {
    queue.sort((a, b) => a.at - b.at);
    while (queue.length && queue[0].at <= clock) {
      const ev = queue.shift();
      const reply = aiReply(ev.site, ev.text);
      if (!reply || reply === 'NONE') continue;
      if (dropCaptureOnce === ev.site && !flags.dropDone) { flags.dropDone = true; continue; }
      captures.push({ site: ev.site, text: reply, ts: ev.at });
      const to = /^\[TO: (\w+)\]/.exec(reply)[1].toLowerCase();
      if (to !== 'user') {
        let body = reply.replace(/^\[TO: \w+\]\n/, '').replace(/\n\[FROM: \w+\]$/, '');
        if (appMangles) body = body.replace('Café', 'Cafe');
        const framed = `[MSG #9]\n[${LBL[ev.site]} → you]\n\n${body}`;
        deliver(to, framed, ev.site);
        if (dupRelayOnce === ev.site && !flags.dupDone) { flags.dupDone = true; deliver(to, framed, ev.site); }
      }
    }
  }
  return {
    setOrder: (o) => { order = o; },
    now: () => clock,
    sleep: async (ms) => { clock += ms; process(); },
    send: async (site, text) => { deliver(site, text, null); return { ok: true, verified: true }; },
    captureSince: (site, ts) => captures.filter((c) => c.site === site && c.ts >= ts),
    sendsSince: (target, ts) => sends.filter((s) => s.target === target && s.ts >= ts),
    _sends: sends,
  };
}

async function run(world, sites, extra = {}) {
  world.setOrder(sites);
  return bb.runBrigade({ ...world, sites, pollMs: 1000, hopTimeoutMs: 60000, setupWaitMs: 1000, ...extra });
}

async function main() {
  console.log('\n== helpers ==');
  const p = bb.parseItems('[TO: CLAUDE]\nBRIGADE\nB01: a\nB03: Line one\nLine two\n[FROM: GEMINI]');
  assert(p.ids.join() === 'B01,B03' && p.items.B03 === 'Line one\nLine two', 'multi-line items parse whole, [FROM:] stripped');
  assert(bb.damageKind('Line one\nLine two', 'Line one Line two') === 'line breaks or spacing changed', 'flattened line breaks are named');
  assert(bb.damageKind('Café', 'Cafe') === 'accents changed', 'lost accents are named');
  assert(bb.damageKind('She said "x"', 'She said “x”') === 'quote marks changed', 'curly quotes are named');
  assert(/Your items are B02, B05/.test(bb.setupPrompt('chatgpt', ['chatgpt', 'claude', 'gemini'], (s) => s)), 'each AI is told which items are its own');

  console.log('\n== everything healthy ==');
  let r = await run(makeWorld(), ['chatgpt', 'claude', 'gemini']);
  assert(r.finished && r.hops.length === 19, `all 19 hand-offs ran (${r.hops.length})`);
  assert(r.appPass === true && r.app.duplicates === 0 && r.app.passedOnExactly === '18/18', `app verdict PASS (${JSON.stringify(r.app)})`);
  assert(r.hops.every((h) => h.aiFollowed && !h.damaged.length), 'every AI followed the format, nothing altered');
  assert(r.hops[r.hops.length - 1].to === 'user', 'the last item goes to you');
  const rep = bb.formatReport(r);
  assert(/App verdict: PASS/.test(rep) && /B20 by/.test(rep), 'report states the verdict and every hand-off');

  console.log('\n== one AI flattens line breaks, another slips once ==');
  r = await run(makeWorld({ flattens: ['gemini'], wrongTargetOnce: 'claude' }), ['chatgpt', 'claude', 'gemini']);
  assert(r.finished, 'the run still finishes (the app repairs the chain)');
  assert(r.hops.some((h) => h.by === 'gemini' && h.damaged.some((d) => /line breaks/.test(d.how))), "Gemini's lost line breaks are reported as altered items");
  const slip = r.hops.find((h) => h.by === 'claude' && h.aiIssue);
  assert(slip && /addressed/.test(slip.aiIssue), `Claude's wrong [TO:] is blamed on the AI (${slip && slip.aiIssue})`);
  assert(r.repairs >= 1 && r.hops.some((h) => h.repairedIn), 'the app repaired the chain and marked it');
  assert(r.appPass === true, 'AI mistakes do not fail the APP verdict');

  console.log('\n== app faults fail the app verdict ==');
  r = await run(makeWorld({ dropCaptureOnce: 'claude' }), ['chatgpt', 'claude', 'gemini']);
  assert(r.appPass === false && r.hops.some((h) => h.by === 'claude' && !h.replyCaptured), 'a missed capture fails the app and names the hop');
  assert(r.finished, '...and the run carries on after a repair');
  r = await run(makeWorld({ dupRelayOnce: 'chatgpt' }), ['chatgpt', 'claude', 'gemini']);
  assert(r.appPass === false && r.app.duplicates >= 1, `a duplicate delivery fails the app (${r.app.duplicates})`);
  r = await run(makeWorld({ appMangles: true }), ['chatgpt', 'claude', 'gemini']);
  assert(r.appPass === false && r.hops.some((h) => h.appPassedOnExactly === false) && /APP CHANGED THE TEXT/.test(bb.formatReport(r)), 'the app altering text in transit is caught and blamed on the app');

  console.log('\n== AIs that answer faster than the checker settles ==');
  r = await run(makeWorld({ replyDelay: 200 }), ['chatgpt', 'claude', 'gemini'], { settleMs: 3000 });
  assert(r.finished && r.appPass && r.hops.every((h) => h.replyCaptured), 'a reply that lands while the checker is still settling is not missed');

  console.log('\n== two AIs, and refusing one ==');
  r = await run(makeWorld(), ['claude', 'gemini']);
  assert(r.finished && r.appPass, 'works with two AIs');
  assert((await bb.runBrigade({ sites: ['claude'] })).error === 'NEED_TWO_AIS', 'needs at least two AIs');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
