'use strict';
// money-lab-kit/ask-owner.js — 🧪 Money lab: how an AI in the sandbox asks the owner before it makes an account,
// posts or sells anything in public, messages anyone, or does anything that costs money.
//
//   node ask-owner.js --kind account --site etsy.com "Open an Etsy shop to sell the printable planners" "Etsy has buyers for planners"
//   node ask-owner.js --check <id>      what the owner answered (or that they haven't yet)
//   node ask-owner.js --list            this AI's asks and their answers
//
// The ask is written to workshop/asks/<id>.json; AutoInjector shows it in the 🧪 Money lab window with Allow / Deny.
// The owner's answer comes back in lab-control/answers/<id>.json — a READ-ONLY folder in the sandbox, so an AI can't
// write its own yes. This waits up to --wait minutes (default 3, at most 10) for the answer, then returns either way.
// Exit code: 0 = yes, 2 = no, 3 = no answer yet, 1 = the ask itself was wrong.

const fs = require('fs');
const path = require('path');
const core = require('./runner-core');

function parseArgs(argv) {
  const o = { kind: 'other', site: '', wait: 3, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind') o.kind = String(argv[++i] || '');
    else if (a === '--site') o.site = String(argv[++i] || '');
    else if (a === '--wait') o.wait = Number(argv[++i]);
    else if (a === '--check') o.check = String(argv[++i] || '');
    else if (a === '--list') o.list = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else o.rest.push(a);
  }
  return o;
}

const USAGE = 'Usage: node ask-owner.js --kind account|post|message|money|other [--site example.com] "what you want to do" "why"\n       node ask-owner.js --check <id>   |   node ask-owner.js --list';

function newId(agent, now) {
  return `${agent}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function readAnswer(dirs, id) {
  try { return core.cleanAnswer(JSON.parse(fs.readFileSync(path.join(dirs.control, 'answers', `${id}.json`), 'utf8'))); } catch (_) { return null; }
}

function say(answer, ask) {
  if (!answer) return `NO ANSWER YET for [${ask.id}]. Do NOT do it. Carry on with other work; check later with: node ask-owner.js --check ${ask.id}`;
  return answer.allow
    ? `YES — the owner allowed [${ask.id}]${answer.note ? `. Owner's note: ${answer.note}` : ''}${ask.kind === 'account' && ask.site ? `. Sign-in boxes on ${ask.site} unlock from your next round.` : ''}`
    : `NO — the owner said no to [${ask.id}]${answer.note ? `. Owner's note: ${answer.note}` : ''}. Do not do it; find another way.`;
}

async function main(argv, env, out, sleep) {
  const o = parseArgs(argv);
  const base = env.LAB_BASE || path.join(env.USERPROFILE || process.cwd(), 'Desktop');
  const dirs = { workshop: path.join(base, 'workshop'), control: path.join(base, 'lab-control') };
  const agent = core.AGENT_IDS.includes(env.LAB_AGENT) ? env.LAB_AGENT : null;
  if (o.help) { out(USAGE); return 0; }
  if (!agent) { out('ask-owner: LAB_AGENT is not set — run this from the lab (the runner sets it).'); return 1; }
  const askDir = path.join(dirs.workshop, 'asks');
  if (o.list) {
    let names = [];
    try { names = fs.readdirSync(askDir).filter((n) => n.endsWith('.json')); } catch (_) { /* none yet */ }
    const mine = names.map((n) => { try { return core.cleanAsk(JSON.parse(fs.readFileSync(path.join(askDir, n), 'utf8'))); } catch (_) { return null; } }).filter((q) => q && q.agent === agent);
    if (!mine.length) { out('You have not asked anything yet.'); return 0; }
    for (const q of mine) out(`- ${say(readAnswer(dirs, q.id), q)} — ${q.kind}${q.site ? ` on ${q.site}` : ''}: ${q.what}`);
    return 0;
  }
  let ask;
  if (o.check) {
    try { ask = core.cleanAsk(JSON.parse(fs.readFileSync(path.join(askDir, `${o.check}.json`), 'utf8'))); } catch (_) { ask = null; }
    if (!ask || ask.agent !== agent) { out(`ask-owner: no ask of yours called ${o.check}. ${USAGE}`); return 1; }
  } else {
    if (!core.ASK_KINDS.includes(o.kind)) { out(`ask-owner: --kind must be one of ${core.ASK_KINDS.join(', ')}.\n${USAGE}`); return 1; }
    const what = String(o.rest[0] || '').trim();
    if (!what) { out(`ask-owner: say what you want to do.\n${USAGE}`); return 1; }
    const site = core.cleanHost(o.site);
    if (o.kind === 'account' && !site) { out('ask-owner: an account ask needs --site (the website, e.g. --site etsy.com).'); return 1; }
    const now = Date.now();
    ask = core.cleanAsk({ id: newId(agent, now), agent, kind: o.kind, site, what, why: o.rest.slice(1).join(' '), at: now });
    fs.mkdirSync(askDir, { recursive: true });
    fs.writeFileSync(path.join(askDir, `${ask.id}.json`), JSON.stringify(ask, null, 2));
    out(`Asked the owner [${ask.id}]: ${ask.kind}${ask.site ? ` on ${ask.site}` : ''} — ${ask.what}`);
  }
  const waitMs = Math.max(0, Math.min(10, Number.isFinite(o.wait) ? o.wait : 3)) * 60000;
  const until = Date.now() + waitMs;
  let answer = readAnswer(dirs, ask.id);
  while (!answer && Date.now() < until) { await sleep(5000); answer = readAnswer(dirs, ask.id); }
  out(say(answer, ask));
  return !answer ? 3 : answer.allow ? 0 : 2;
}

module.exports = { main, parseArgs, say };

if (require.main === module) {
  main(process.argv.slice(2), process.env, (s) => console.log(s), (ms) => new Promise((r) => setTimeout(r, ms)))
    .then((code) => { process.exitCode = code; }, (e) => { console.error(`ask-owner: ${e && e.message}`); process.exitCode = 1; });
}
