'use strict';
// feature-test.js — the 🧪 Feature Test: walks EVERY participating AI through
// every feature, one at a time, for real — and judges each step by what the
// PROGRAM can see (files on disk, the delivery ledger, what the terminal sent
// back), never by what an AI claims it did.
//
// For each AI, in order:
//   1 reply      — a plain reply comes back and is captured (envelope + [FROM:])
//   2 write      — [TO: TERMINAL] write → the file really appears in its locker
//   3 read       — type/cat it back → the terminal returns the text AND the AI
//                  repeats it to you (the full round trip)
//   4 give       — give → the file's text is pasted into its chat
//   5 send       — send to the next AI → the copy lands in that AI's inbox
//   6 share      — share with the next AI → the share is really open
//   7 safety     — try to read a system file → must be REFUSED, nothing leaks
//   8 relay      — [TO: <next AI>] → the message is delivered to that AI
// Steps 5/6/8 need a second AI; they're skipped (not failed) with only one.
//
// It also records HOW EACH AI'S REPLIES ACTUALLY END (the raw last characters,
// [FROM:] tag included or not) — the thing that most often breaks capture.
//
// Pure orchestration with injected deps, so it's unit-testable without Electron.

const STEPS = ['reply', 'write', 'read', 'give', 'send', 'share', 'safety', 'relay'];
const STEP_NAMES = {
  reply: 'Reply captured', write: 'Locker: write a file', read: 'Locker: read it back (round trip)',
  give: 'Locker: give (paste into chat)', send: 'Locker: send a file to another AI', share: 'Locker: share for one turn',
  safety: 'Safety: outside the locker is refused', relay: 'Routing: [TO: another AI] is delivered',
};
const TIPS = {
  reply: 'No reply was captured. Check the pane is signed in, then run 🧪 Test / 🎛️ Tuner on that AI — usually a send or reply selector needs re-picking (🎯).',
  write: 'The AI did not produce a working [TO: TERMINAL] write. Send it the "System Prompt (How Routing Works)" from the Prompt Library so it learns the locker commands, then retry.',
  read: 'The terminal result or the AI\'s read-back was missing. If the terminal part passed, the AI ignored the result — resend the routing prompt.',
  give: 'give did not paste the file back. Check the Activity Log (Files / Code tags) for the error.',
  send: 'The copy never reached the other AI\'s inbox. Check the Activity Log for locker-send errors.',
  share: 'The share was not opened. Check the Activity Log for locker-share entries.',
  safety: 'IMPORTANT: a read outside the locker was not refused. Do not let AIs use the terminal until this is fixed.',
  relay: 'The tagged message was not delivered to the other AI. Make sure "Stop AIs Talking" isn\'t on and the target AI is checked Active.',
};

function makeToken() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// deps:
//   sites: ['chatgpt', ...]                 participating AIs, in order
//   label(site) -> 'Claude'
//   platform: 'win32' | 'linux' | ...
//   send(site, text) -> Promise<{ok, error?}>
//   captureSince(site, ts) -> [{ text (raw), ts }]   every capture from site after ts
//   terminalRepliesSince(site, ts) -> [{ text, ts }] [FROM: TERMINAL] messages sent to site
//   ledgerSince(target, ts) -> [{ text, ok, ts }]   deliveries to target
//   fileHas(site, relPath, needle) -> bool         file exists in site's locker and contains needle
//   grantsFor(site) -> [granterSite]
//   isBusy(site) -> bool                           still generating / waiting
//   onProgress({ site, step, index, total, status, detail })
//   shouldStop() -> bool
//   now(), sleep(ms)
//   stepTimeoutMs (default 120000), settleMs (default 2500)
async function runFeatureTest(deps) {
  const d = Object.assign({
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    stepTimeoutMs: 120000,
    pollMs: 700,
    settleMs: 2500,
    onProgress: () => {},
    shouldStop: () => false,
    label: (s) => s,
  }, deps || {});
  const sites = (d.sites || []).slice();
  if (!sites.length) return { ok: false, error: 'NO_PARTICIPANTS' };
  const win = d.platform === 'win32';
  const sep = win ? '\\' : '/';
  const readCmd = win ? 'type' : 'cat';
  const systemFile = win ? 'C:\\Windows\\win.ini' : '/etc/hostname';
  const runId = makeToken();
  const results = [];   // { site, step, name, ok:true|false|null, detail, ms, tip? }
  const endings = {};   // site -> [raw tail of each captured reply]
  const total = sites.length * STEPS.length;
  let index = 0;
  let stopped = false;

  const waitFor = async (fn, timeoutMs) => {
    const end = d.now() + (timeoutMs || d.stepTimeoutMs);
    while (d.now() < end) {
      if (d.shouldStop()) { stopped = true; return null; }
      let v = null;
      try { v = await fn(); } catch (_) { v = null; }
      if (v) return v;
      await d.sleep(d.pollMs);
    }
    return null;
  };
  // Let the pane finish whatever it's doing (e.g. answering a terminal result
  // with NONE) before the next prompt goes in, so steps never overlap.
  const settle = async (site) => {
    await waitFor(async () => !d.isBusy || !d.isBusy(site), 60000);
    await d.sleep(d.settleMs);
  };
  const noteEndings = (site, since) => {
    for (const c of d.captureSince(site, since) || []) {
      const raw = String(c.text || '');
      (endings[site] = endings[site] || []).push(raw.slice(-160));
    }
  };
  const record = (site, step, ok, detail, t0) => {
    const r = { site, step, name: `${d.label(site)} — ${STEP_NAMES[step]}`, ok, detail, ms: d.now() - t0 };
    if (ok === false) r.tip = TIPS[step];
    results.push(r);
    index++;
    try { d.onProgress({ site, step, index, total, status: ok === true ? 'pass' : ok === false ? 'fail' : 'skip', detail }); } catch (_) {}
    return r;
  };
  const envelope = (site, body, after) =>
    `AutoInjector FEATURE TEST (automatic — this is the app checking itself, not a task). Reply with EXACTLY this and nothing else:\n` +
    `${body}\n[FROM: ${site.toUpperCase()}]` + (after ? `\n\n${after}` : '');
  const NONE_AFTER = 'When the [FROM: TERMINAL] result comes back, reply with just NONE.';

  for (let i = 0; i < sites.length && !stopped; i++) {
    const site = sites[i];
    const next = sites.length > 1 ? sites[(i + 1) % sites.length] : null;
    const T = `${runId}${i}`;
    const file = `feature-test${sep}FT-${T}.txt`;
    const fileTok = `FT-${T}-FILE`;
    let wrote = false;

    for (const step of STEPS) {
      if (d.shouldStop()) { stopped = true; break; }
      const t0 = d.now();
      try { d.onProgress({ site, step, index, total, status: 'running' }); } catch (_) {}
      const needsNext = step === 'send' || step === 'share' || step === 'relay';
      if (needsNext && !next) { record(site, step, null, 'needs a second AI checked Active', t0); continue; }
      const needsFile = step === 'read' || step === 'give' || step === 'send';
      if (needsFile && !wrote) { record(site, step, null, 'skipped — the write step failed, so there is no file to use', t0); continue; }

      let prompt; let check; let termOk = false;
      if (step === 'reply') {
        const tok = `FT-${T}-REPLY`;
        prompt = envelope(site, `[TO: USER]\n${tok}`);
        check = async () => {
          const c = (d.captureSince(site, t0) || []).find((x) => String(x.text).includes(tok));
          return c ? { ok: true, detail: 'captured' } : null;
        };
      } else if (step === 'write') {
        prompt = envelope(site, `[TO: TERMINAL]\n\`\`\`\nwrite ${file}\n${fileTok}\n\`\`\``, NONE_AFTER);
        check = async () => (d.fileHas(site, file, fileTok) ? { ok: true, detail: `${file} exists with the right text` } : null);
      } else if (step === 'read') {
        prompt = envelope(site, `[TO: TERMINAL]\n\`\`\`\n${readCmd} ${file}\n\`\`\``,
          `When the [FROM: TERMINAL] result comes back, reply to the user with the line you read, like this:\n[TO: USER]\n<the line>\n[FROM: ${site.toUpperCase()}]`);
        check = async () => {
          if (!termOk) termOk = (d.terminalRepliesSince(site, t0) || []).some((m) => m.text.includes(fileTok));
          if (!termOk) return null;
          // the AI's own read-back: a capture AFTER the terminal result that repeats the token
          const back = (d.captureSince(site, t0) || []).some((c) => String(c.text).includes(fileTok) && !/\[TO:\s*TERMINAL\]/i.test(String(c.text)));
          return back ? { ok: true, detail: 'terminal returned the text and the AI read it back' } : null;
        };
      } else if (step === 'give') {
        prompt = envelope(site, `[TO: TERMINAL]\n\`\`\`\ngive ${file}\n\`\`\``, NONE_AFTER);
        check = async () => ((d.terminalRepliesSince(site, t0) || []).some((m) => m.text.includes(fileTok) && /end of file/.test(m.text))
          ? { ok: true, detail: 'file text pasted into the chat' } : null);
      } else if (step === 'send') {
        const inboxRel = `inbox${sep}from-${site}${sep}FT-${T}.txt`;
        prompt = envelope(site, `[TO: TERMINAL]\n\`\`\`\nsend ${file} to ${next}\n\`\`\``, NONE_AFTER);
        check = async () => (d.fileHas(next, inboxRel, fileTok) ? { ok: true, detail: `copy is in ${d.label(next)}'s ${inboxRel}` } : null);
      } else if (step === 'share') {
        prompt = envelope(site, `[TO: TERMINAL]\n\`\`\`\nshare with ${next}\n\`\`\``, NONE_AFTER);
        check = async () => ((d.grantsFor(next) || []).includes(site) ? { ok: true, detail: `${d.label(next)} can look at ${d.label(site)}'s locker for one turn` } : null);
      } else if (step === 'safety') {
        prompt = envelope(site, `[TO: TERMINAL]\n\`\`\`\n${readCmd} ${systemFile}\n\`\`\``, `(This one is SUPPOSED to be refused.) ${NONE_AFTER}`);
        check = async () => {
          const m = (d.terminalRepliesSince(site, t0) || []).find((x) => /Results from your locker/.test(x.text));
          if (!m) return null;
          return /refused/i.test(m.text)
            ? { ok: true, detail: 'refused, nothing read' }
            : { ok: false, detail: 'NOT refused — the command reached the shell' };
        };
      } else if (step === 'relay') {
        const tok = `FT-${T}-RELAY`;
        prompt = envelope(site, `[TO: ${next.toUpperCase()}]\n${tok} (feature test — ${d.label(next)}: reply with just NONE)`);
        check = async () => ((d.ledgerSince(next, t0) || []).some((e) => e.ok && String(e.text).includes(tok))
          ? { ok: true, detail: `delivered to ${d.label(next)}` } : null);
      }
      const res = await sendAndCheck();
      if (step === 'read' && res.ok === false && termOk) res.detail = 'the terminal returned the text, but the AI never repeated it back';
      finish(res);

      async function sendAndCheck() {
        let s;
        try { s = await d.send(site, prompt); } catch (e) { s = { ok: false, error: String(e) }; }
        if (!s || !s.ok) return { ok: false, detail: `couldn't send the test prompt (${(s && s.error) || 'error'})` };
        const r = await waitFor(check);
        if (stopped) return { ok: null, detail: 'stopped' };
        return r || { ok: false, detail: `timed out after ${Math.round(d.stepTimeoutMs / 1000)}s` };
      }
      function finish(r) {
        if (step === 'write' && r.ok) wrote = true;
        noteEndings(site, t0);
        record(site, step, r.ok, r.detail, t0);
      }
      if (!stopped) await settle(site);
      if (step === 'reply' && results[results.length - 1].ok === false) {
        // No reply at all = this pane isn't working; don't spend 7 more timeouts on it.
        for (const rest of STEPS.slice(1)) record(site, rest, null, `skipped — ${d.label(site)} didn't reply to step 1`, d.now());
        break;
      }
    }
  }

  const okCount = results.filter((r) => r.ok === true).length;
  const failCount = results.filter((r) => r.ok === false).length;
  return { ok: true, runId, stopped, results, endings, okCount, failCount, total: results.length };
}

// A readable report (Markdown) — saved to the logs folder.
function formatReport(r, { label = (s) => s, when = new Date() } = {}) {
  const lines = [];
  lines.push(`# AutoInjector Feature Test — ${when.toLocaleString()}`, '');
  lines.push(`**${r.okCount} passed, ${r.failCount} failed, ${r.total - r.okCount - r.failCount} skipped**${r.stopped ? ' (stopped early)' : ''}`, '');
  lines.push('| AI / feature | Result | Detail | Time |', '|---|---|---|---|');
  for (const x of r.results) {
    lines.push(`| ${x.name} | ${x.ok === true ? '✅ pass' : x.ok === false ? '❌ FAIL' : '⚪ skip'} | ${String(x.detail || '').replace(/\|/g, '/')} | ${(x.ms / 1000).toFixed(1)}s |`);
  }
  const fails = r.results.filter((x) => x.ok === false);
  if (fails.length) {
    lines.push('', '## What to fix', '');
    for (const f of fails) lines.push(`- **${f.name}** — ${f.tip}`);
  }
  lines.push('', '## How each AI\'s replies actually ended', '',
    'The last characters of every reply captured during the test, exactly as the app saw them. A healthy reply ends with its own `[FROM: NAME]` tag. Anything after it (UI text, a copy button label, a sign-off) is what the end-of-message detector has to cope with.', '');
  for (const [site, tails] of Object.entries(r.endings || {})) {
    lines.push(`### ${label(site)}`, '');
    tails.forEach((t, i) => {
      const hasTag = /\[\s*FROM\s*:[^\]]+\]\s*\S{0,40}$/i.test(t.trim());
      lines.push(`${i + 1}. ${hasTag ? 'ends with [FROM:] ✅' : 'NO [FROM:] at the end ⚠'}`, '```', t.replace(/```/g, "'''"), '```');
    });
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { runFeatureTest, formatReport, STEPS, STEP_NAMES, TIPS };
