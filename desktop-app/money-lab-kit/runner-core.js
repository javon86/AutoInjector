'use strict';
// money-lab-kit/runner-core.js — 🧪 Money lab: the plain parts of the runner that works INSIDE the Windows Sandbox.
//
// No processes, no clocks, no files here: everything takes its inputs and returns data, so it is unit-tested on any
// computer (test/money-lab-runner.test.js). runner.js does the doing (starting Claude Code / Codex, the rounds, the
// status file) with these.
//
// The folders the sandbox sees (Windows Sandbox maps them from the host; the names match the host folder names so
// older Windows, which ignores <SandboxFolder> and puts a mapped folder on the desktop by its own name, lands on the
// same paths):
//   lab-kit      read-only  this kit (the runner, the rules, the browser guard, ask-owner)
//   lab-control  read-only  what the owner decided: the mission, answers to asks, sites approved for sign-in, stop
//   workshop     read-write everything the AIs make, their journals, the shared board, the ledger, their asks, logs
//   lab-cache    read-write Node, Git (Claude Code needs Git Bash on Windows), the installed command-line tools
//   lab-logins   read-write the AIs' own sign-ins (Claude Code, Codex) and their browser profiles — kept between runs

const AGENTS = {
  claude: { label: 'Claude', tool: 'Claude Code', pkg: '@anthropic-ai/claude-code', bin: 'claude' },
  codex: { label: 'ChatGPT', tool: 'Codex', pkg: '@openai/codex', bin: 'codex' },
};
const AGENT_IDS = Object.keys(AGENTS);

const STYLES = {
  solo: 'Each AI runs its own money idea. You can read the other one\'s posts on the shared board, and you may borrow ideas, but you are judged on your own results.',
  team: 'Claude and ChatGPT work as one team on the same goal. Split the work, say on the shared board who is doing what, and do not do the same job twice.',
};

// Payment pages never load in the lab's browser (Playwright MCP --blocked-origins). Not a wall on its own —
// the guard script below and the rules are the other layers, and there is no card anywhere in the sandbox.
const BLOCKED_ORIGINS = [
  'https://js.stripe.com', 'https://checkout.stripe.com', 'https://buy.stripe.com', 'https://m.stripe.network',
  'https://www.paypal.com', 'https://paypal.com', 'https://www.paypalobjects.com',
  'https://pay.google.com', 'https://payments.google.com', 'https://checkout.shopify.com',
  'https://secure.checkout.visa.com', 'https://www.sandbox.paypal.com', 'https://pay.amazon.com', 'https://payments.amazon.com',
  'https://js.braintreegateway.com', 'https://assets.braintreegateway.com', 'https://checkoutshopper-live.adyen.com',
];

const ASK_KINDS = ['account', 'post', 'message', 'money', 'other'];
const ID_RE = /^[a-z0-9][a-z0-9-]{3,63}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const clampInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const cut = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** A host name as the owner or an AI typed it ("https://www.Etsy.com/sell" → "etsy.com"), or '' if it is not one. */
function cleanHost(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  return HOST_RE.test(s) ? s : '';
}

/** The mission file the AutoInjector app wrote (lab-control/mission.json), cleaned. null: no usable mission. */
function normalizeMission(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  if (!ID_RE.test(id)) return null;
  const agents = (Array.isArray(raw.agents) ? raw.agents : []).filter((a, i, arr) => AGENT_IDS.includes(a) && arr.indexOf(a) === i);
  if (!agents.length) return null;
  const mission = cut(String(raw.mission || '').trim(), 4000);
  if (!mission) return null;
  return {
    id, mission, agents,
    hours: clampInt(raw.hours, 1, 72, 2),
    roundMinutes: clampInt(raw.roundMinutes, 5, 120, 20),
    style: STYLES[raw.style] ? raw.style : 'solo',
  };
}

/** Is there time for another round? Starts one only if at least half a round fits before the end. */
function shouldStartRound({ now, endsAt, roundMinutes, stopped }) {
  if (stopped) return false;
  return now + (roundMinutes * 60000) / 2 <= endsAt;
}

/** How long this round may run: the round length, or less near the end (never under 3 minutes). */
function roundBudgetMs({ now, endsAt, roundMinutes }) {
  return Math.max(3 * 60000, Math.min(roundMinutes * 60000, endsAt - now));
}

/** The answers the owner gave to this AI's asks (newest last), for its next round's instructions. */
function answersFor(agent, asks, answers) {
  const byId = new Map((answers || []).map((a) => [a.id, a]));
  return (asks || []).filter((q) => q.agent === agent && byId.has(q.id)).map((q) => {
    const a = byId.get(q.id);
    return { id: q.id, kind: q.kind, site: q.site || '', what: cut(q.what, 300), allowed: !!a.allow, note: cut(a.note || '', 500), at: a.at || 0 };
  }).sort((x, y) => x.at - y.at).slice(-12);
}

/** Asks that are still waiting for the owner. */
function openAsks(agent, asks, answers) {
  const answered = new Set((answers || []).map((a) => a.id));
  return (asks || []).filter((q) => q.agent === agent && !answered.has(q.id)).map((q) => ({ id: q.id, kind: q.kind, site: q.site || '', what: cut(q.what, 200) }));
}

/** What the AI is told at the start of each round. */
function buildPrompt(o) {
  const me = AGENTS[o.agent];
  const other = o.agents.filter((a) => a !== o.agent).map((a) => AGENTS[a].label);
  const d = o.dirs;
  const lines = [];
  lines.push(`You are ${me.label} (${me.tool}), working in the AutoInjector Money lab: a sealed Windows Sandbox on the owner's PC.`);
  lines.push(other.length ? `${other.join(' and ')} is in the lab too. ${STYLES[o.style]}` : 'You are the only AI in the lab this time.');
  lines.push('');
  lines.push('THE MISSION (from the owner):');
  lines.push(o.mission);
  lines.push('');
  lines.push(`This is round ${o.round}. You have about ${o.roundMinutes} minutes for it; about ${Math.max(0, Math.round(o.minutesLeft))} minutes are left in the whole run.`);
  if (o.lastRound) lines.push('THIS IS YOUR LAST ROUND. Finish what you can, then write REPORT.md in your folder: what you made, what you tried, what worked, any money earned (with proof) and what the owner should do next.');
  lines.push('');
  lines.push('THE LAB RULES (they come before the mission; the full text is in lab-kit\\RULES.md):');
  lines.push(o.rules.trim());
  lines.push('');
  lines.push('YOUR PLACES:');
  lines.push(`- Your folder (work here): ${d.mine}`);
  lines.push(`- Your journal (read it first, add to it last): ${d.mine}\\journal.md`);
  lines.push(`- Things you made for the owner go in: ${d.mine}\\products`);
  lines.push(`- Shared board (short notes to the other AI and the owner): ${d.workshop}\\board.md`);
  lines.push(`- Money ledger (every real earning, with proof — never estimates): ${d.workshop}\\ledger.md`);
  lines.push('- A web browser (Microsoft Edge) is available through your "browser" tools. Password and payment boxes are locked until the owner says yes.');
  lines.push('');
  lines.push('TO ASK THE OWNER (required before making an account, posting or selling anything in public, messaging or emailing anyone, or anything that costs money):');
  lines.push(`  node "${d.kit}\\ask-owner.js" --kind account|post|message|money|other --site example.com "what you want to do" "why it helps the mission"`);
  lines.push('It waits a few minutes for an answer. If none comes, carry on with other work; the answer will be in your next round. Never do the thing before a yes.');
  if (o.answers && o.answers.length) {
    lines.push('');
    lines.push('THE OWNER\'S ANSWERS TO YOUR ASKS:');
    for (const a of o.answers) lines.push(`- [${a.id}] ${a.allowed ? 'YES' : 'NO'} — ${a.kind}${a.site ? ` on ${a.site}` : ''}: ${a.what}${a.note ? ` — owner's note: ${a.note}` : ''}`);
  }
  if (o.waiting && o.waiting.length) {
    lines.push('');
    lines.push('STILL WAITING FOR THE OWNER (do not do these yet):');
    for (const a of o.waiting) lines.push(`- [${a.id}] ${a.kind}${a.site ? ` on ${a.site}` : ''}: ${a.what}`);
  }
  if (o.signInSites && o.signInSites.length) {
    lines.push('');
    lines.push(`Sites where the owner has allowed sign-in boxes: ${o.signInSites.join(', ')}.`);
  }
  lines.push('');
  lines.push('END THE ROUND by adding to your journal: what you did, what you learned, and your plan for next round. Then reply with three short lines: DID: … / NEXT: … / MONEY: … (the amount actually earned so far, or $0).');
  return lines.join('\n');
}

/** Claude Code, run once per round: no permission questions (the sandbox is the fence), the browser tools, prompt on stdin. */
function claudeArgs(mcpConfigPath) {
  return ['-p', '--dangerously-skip-permissions', '--mcp-config', mcpConfigPath, '--output-format', 'text'];
}

/** Codex, run once per round: full access inside the sandbox (its own Windows sandbox is not needed here), prompt on stdin. */
function codexArgs(workDir, answerFile) {
  return ['exec', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '--color', 'never', '-C', workDir, '-o', answerFile, '-'];
}

/** The browser for one AI: Edge (built into Windows Sandbox), its own kept profile, the guard script, payments blocked. */
function browserArgs({ cliJs, profileDir, guardFile, outDir }) {
  return [cliJs, '--browser', 'msedge', '--user-data-dir', profileDir, '--init-script', guardFile, '--blocked-origins', BLOCKED_ORIGINS.join(';'), '--output-dir', outDir];
}

function claudeMcpConfig(nodeExe, args) {
  return JSON.stringify({ mcpServers: { browser: { command: nodeExe, args } } }, null, 2);
}

const tomlStr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
/** Codex reads its tools from CODEX_HOME\config.toml; the runner owns that file in the lab. */
function codexConfigToml(nodeExe, args) {
  return [
    '# Written by the AutoInjector Money lab runner each round — changes here are replaced.',
    '[mcp_servers.browser]',
    `command = ${tomlStr(nodeExe)}`,
    `args = [${args.map(tomlStr).join(', ')}]`,
    'startup_timeout_sec = 60',
    '',
  ].join('\n');
}

/**
 * The script the lab's browser runs in every page and frame before the page's own scripts:
 *   • a password box is locked (read-only, disabled) unless the owner approved sign-in on that site;
 *   • a form with a password box can't be sent on a site that isn't approved;
 *   • card / bank boxes are always locked — there are no payments in the lab.
 * The approved sites are written in when the runner starts each round.
 */
function guardScript(approvedHosts) {
  const hosts = (approvedHosts || []).map(cleanHost).filter(Boolean);
  return `// AutoInjector Money lab — browser guard (generated; the lab's rules, not the page's)
(function () {
  'use strict';
  try {
    var APPROVED = ${JSON.stringify(hosts)};
    var host = String(location.hostname || '').toLowerCase().replace(/^www\\./, '');
    var approved = APPROVED.some(function (h) { return host === h || host.slice(-(h.length + 1)) === '.' + h; });
    var PAY = /(^|[^a-z])(cc-|card.?num|cardnumber|credit.?card|debit.?card|card.?holder|cvc|cvv|csc|security.?code|expir|iban|routing|account.?number|sort.?code|bank.?account)/i;
    var PW_NOTE = 'Locked by the lab: ask the owner first (ask-owner --kind account)';
    var PAY_NOTE = 'Locked by the lab: no payments, ever';
    function isPay(el) {
      var ac = String(el.getAttribute('autocomplete') || '').trim().toLowerCase();
      var last = ac.split(/\\s+/).pop() || '';
      if (last.indexOf('cc-') === 0) return true;
      var s = [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), ac].join(' ');
      return PAY.test(s);
    }
    function lock(el, why) {
      if (el.getAttribute('data-lab-locked')) return;
      el.setAttribute('data-lab-locked', '1');
      try { el.readOnly = true; } catch (e) {}
      try { el.disabled = true; } catch (e) {}
      el.setAttribute('title', why);
      el.setAttribute('placeholder', why);
    }
    function check(el) {
      if (!el || !el.tagName) return;
      var tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
      var type = String(el.getAttribute('type') || '').toLowerCase();
      if (type === 'password' && !approved) lock(el, PW_NOTE);
      else if (isPay(el)) lock(el, PAY_NOTE);
    }
    function scan(root) {
      if (!root) return;
      if (root.nodeType === 1) check(root);
      if (root.querySelectorAll) { var all = root.querySelectorAll('input, textarea, select'); for (var i = 0; i < all.length; i++) check(all[i]); }
    }
    document.addEventListener('submit', function (e) {
      if (approved) return;
      var f = e.target;
      if (f && f.querySelector && f.querySelector('input[type="password" i]')) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === 'attributes') check(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) scan(m.addedNodes[j]);
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'autocomplete', 'name', 'id'] });
    scan(document);
    document.addEventListener('DOMContentLoaded', function () { scan(document); });
  } catch (e) { /* never break the page */ }
})();
`;
}

/** The last useful lines of what an AI said at the end of a round (its DID / NEXT / MONEY lines if it wrote them). */
function summarize(output) {
  const lines = String(output || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tagged = lines.filter((l) => /^(\*\*)?(DID|NEXT|MONEY)(\*\*)?\s*:/i.test(l));
  const pick = tagged.length ? tagged.slice(-3) : lines.slice(-3);
  return cut(pick.join('\n'), 600);
}

/** The MONEY line's amount in dollars, if the AI wrote one ("MONEY: $12.50 from …" → 12.5); null otherwise. */
function moneyClaim(output) {
  const m = String(output || '').match(/MONEY(?:\*\*)?\s*:\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Is this an ask an AI wrote (workshop/asks/<id>.json)? Returns the cleaned ask or null. Asks are untrusted text. */
function cleanAsk(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  if (!ID_RE.test(id)) return null;
  if (!AGENT_IDS.includes(raw.agent)) return null;
  const kind = ASK_KINDS.includes(raw.kind) ? raw.kind : 'other';
  const what = cut(String(raw.what || '').trim(), 600);
  if (!what) return null;
  return { id, agent: raw.agent, kind, site: cleanHost(raw.site), what, why: cut(String(raw.why || '').trim(), 600), at: Number(raw.at) || 0 };
}

/** Is this an answer the owner wrote (lab-control/answers/<id>.json)? */
function cleanAnswer(raw) {
  if (!raw || typeof raw !== 'object' || !ID_RE.test(String(raw.id || ''))) return null;
  return { id: String(raw.id), allow: raw.allow === true, note: cut(String(raw.note || ''), 500), at: Number(raw.at) || 0 };
}

/** Sites where the owner allowed sign-in boxes (lab-control/approved-sites.json: ["etsy.com", …] or [{host}]). */
function approvedHosts(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.sites) ? raw.sites : []);
  return [...new Set(list.map((x) => cleanHost(typeof x === 'string' ? x : x && x.host)).filter(Boolean))];
}

module.exports = {
  AGENTS, AGENT_IDS, STYLES, BLOCKED_ORIGINS, ASK_KINDS, ID_RE,
  cleanHost, normalizeMission, shouldStartRound, roundBudgetMs, answersFor, openAsks, buildPrompt,
  claudeArgs, codexArgs, browserArgs, claudeMcpConfig, codexConfigToml, guardScript, summarize, moneyClaim,
  cleanAsk, cleanAnswer, approvedHosts,
};
