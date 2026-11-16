'use strict';
// money-lab-kit/lab-talk.js — 🧪 Money lab: how the AIs talk to each other (inside the sandbox).
//
//   node lab-talk.js --to codex "I'll build the planner; can you write the listing text?"
//   node lab-talk.js --to all "Found a free host for the site: …"       (to everyone in the lab)
//   node lab-talk.js --read            new messages for me (and marks them read)
//   node lab-talk.js --wait 5          wait up to 5 minutes for a new message, then show it
//   node lab-talk.js --history         the last 30 messages
//   node lab-talk.js --to owner "Done: the planner is in my products folder. Can I list it on Etsy?"   (to the owner)
//
// The owner writes from AutoInjector's 🧪 window; those messages are in lab-control/owner-talk (read-only in the
// sandbox, so no AI can write as the owner) and come first: the owner's direction beats the AIs' own plans.
// Messages are files in workshop/talk/ (plus workshop/talk.log, which the sandbox shows live in a "Lab talk" window
// and AutoInjector's 🧪 window shows too). New messages also go into each AI's next round. The owner can read all of it.

const fs = require('fs');
const path = require('path');
const core = require('./runner-core');

const MAX_TEXT = 4000;

function parseArgs(argv) {
  const o = { to: '', rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') o.to = String(argv[++i] || '').toLowerCase();
    else if (a === '--read') o.read = true;
    else if (a === '--wait') o.wait = Number(argv[++i]);
    else if (a === '--history') o.history = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else o.rest.push(a);
  }
  return o;
}

const ALIASES = { chatgpt: 'codex', gpt: 'codex', openai: 'codex', 'claude-code': 'claude', everyone: 'all', me: 'owner', boss: 'owner', manager: 'owner' };

/** All messages (oldest first), cleaned — they are files any AI in the lab can write, so only data. */
function readDir(dir, ok) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
  return names.map((n) => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      const c = { id: String(m.id || n), from: m.from, to: m.to, text: String(m.text || '').slice(0, MAX_TEXT), at: Number(m.at) || 0 };
      return ok(c) ? c : null;
    } catch (_) { return null; }
  }).filter(Boolean);
}

/** The AIs' messages (workshop/talk) and the owner's (lab-control/owner-talk — the only place "owner" is believed). */
function readAll(talkDir, ownerDir) {
  const toOk = (t) => core.AGENT_IDS.includes(t) || t === 'all';
  const ais = readDir(talkDir, (m) => core.AGENT_IDS.includes(m.from) && (toOk(m.to) || m.to === 'owner'));
  const owner = ownerDir ? readDir(ownerDir, (m) => m.from === 'owner' && toOk(m.to)) : [];
  return ais.concat(owner).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/** Messages to this AI (or to all) from someone else, after `since`. */
function forMe(all, agent, since) {
  return all.filter((m) => m.from !== agent && (m.to === agent || m.to === 'all') && m.at > (since || 0));
}

function line(m) {
  const who = (id) => (id === 'all' ? 'everyone' : id === 'owner' ? 'Owner' : core.AGENTS[id].label);
  const d = new Date(m.at);
  const p = (n) => String(n).padStart(2, '0');
  return `[${p(d.getHours())}:${p(d.getMinutes())}] ${who(m.from)} → ${who(m.to)}: ${m.text}`;
}

function readMark(talkDir, agent) {
  try { return Number(JSON.parse(fs.readFileSync(path.join(talkDir, `.read-${agent}.json`), 'utf8')).at) || 0; } catch (_) { return 0; }
}
function setMark(talkDir, agent, at) {
  try { fs.writeFileSync(path.join(talkDir, `.read-${agent}.json`), JSON.stringify({ at })); } catch (_) { /* next read shows them again */ }
}

/** Send one message; returns it. Used by the CLI and by tests. */
function send(talkDir, from, to, text, now) {
  fs.mkdirSync(talkDir, { recursive: true });
  const m = { id: `${now.toString(36)}-${from}-${Math.random().toString(36).slice(2, 6)}`, from, to, text: String(text).slice(0, MAX_TEXT), at: now };
  fs.writeFileSync(path.join(talkDir, `${m.id}.json`), JSON.stringify(m, null, 2));
  try { fs.appendFileSync(path.join(path.dirname(talkDir), 'talk.log'), `${line(m)}\n`); } catch (_) { /* the log is for watching */ }
  return m;
}

async function main(argv, env, out, sleep, now = () => Date.now()) {
  const o = parseArgs(argv);
  const usage = 'Usage: node lab-talk.js --to claude|codex|all|owner "message"   |   --read   |   --wait <minutes>   |   --history';
  if (o.help) { out(usage); return 0; }
  const agent = core.AGENT_IDS.includes(env.LAB_AGENT) ? env.LAB_AGENT : null;
  if (!agent) { out('lab-talk: LAB_AGENT is not set — run this from the lab (the runner sets it).'); return 1; }
  const base = env.LAB_BASE || path.join(env.USERPROFILE || process.cwd(), 'Desktop');
  const talkDir = path.join(base, 'workshop', 'talk');
  const ownerDir = path.join(base, 'lab-control', 'owner-talk');
  if (o.history) {
    const all = readAll(talkDir, ownerDir).slice(-30);
    out(all.length ? all.map(line).join('\n') : 'No messages yet.');
    return 0;
  }
  if (o.read || o.wait != null) {
    const since = readMark(talkDir, agent);
    let mine = forMe(readAll(talkDir, ownerDir), agent, since);
    const until = now() + Math.max(0, Math.min(30, Number.isFinite(o.wait) ? o.wait : 0)) * 60000;
    while (!mine.length && now() < until) { await sleep(5000); mine = forMe(readAll(talkDir, ownerDir), agent, since); }
    if (!mine.length) { out(o.wait != null ? 'No new message came. Carry on; check again later.' : 'No new messages.'); return 0; }
    setMark(talkDir, agent, mine[mine.length - 1].at);
    out(mine.map(line).join('\n'));
    return 0;
  }
  const to = ALIASES[o.to] || o.to;
  if (!(core.AGENT_IDS.includes(to) || to === 'all' || to === 'owner')) { out(`lab-talk: --to must be claude, codex (ChatGPT), all or owner.\n${usage}`); return 1; }
  if (to === agent) { out('lab-talk: that is you — send it to the other AI or to all.'); return 1; }
  const text = o.rest.join(' ').trim();
  if (!text) { out(`lab-talk: write the message.\n${usage}`); return 1; }
  const m = send(talkDir, agent, to, text, now());
  out(`Sent: ${line(m)}`);
  return 0;
}

module.exports = { main, readAll, forMe, send, line, readMark, setMark };

if (require.main === module) {
  main(process.argv.slice(2), process.env, (s) => console.log(s), (ms) => new Promise((r) => setTimeout(r, ms)))
    .then((code) => { process.exitCode = code; }, (e) => { console.error(`lab-talk: ${e && e.message}`); process.exitCode = 1; });
}
