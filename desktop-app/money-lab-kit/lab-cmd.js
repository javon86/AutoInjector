'use strict';
// money-lab-kit/lab-cmd.js — 🧪 Money lab: the AIs' Command Prompt (inside the Windows Sandbox only).
//
//   node lab-cmd.js "dir /b"                  run one command in Command Prompt (cmd.exe); its output comes back
//   node lab-cmd.js --cwd C:\path "npm init -y"
//   node lab-cmd.js --timeout 30 "npm install"   minutes it may run (default 10, at most 60)
//
// Whatever the AI sends goes into a real Command Prompt; whatever Command Prompt prints comes back to the AI. Each
// command and its output is also written to workshop/console/<ai>.log, which the sandbox shows live in a
// "Command Prompt — Claude / ChatGPT" window and AutoInjector's 🧪 window shows too — so you can watch.
// It can only touch what the sandbox can: the sandbox is the fence, not this tool.
// Exit code: the command's own (124 = stopped because it ran out of time, 1 = this tool was used wrongly).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./runner-core');

const MAX_SHOW = 20000; // characters of output given back (the start and the end of longer output)

function parseArgs(argv) {
  const o = { cwd: '', timeout: 10, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') o.cwd = String(argv[++i] || '');
    else if (a === '--timeout') o.timeout = Number(argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
    else o.rest.push(a);
  }
  o.command = o.rest.join(' ').trim();
  return o;
}

/** Keep the start and the end of very long output (the end usually has the error). */
function clip(text, max = MAX_SHOW) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4);
  return `${s.slice(0, head)}\n… [${s.length - max} characters left out] …\n${s.slice(s.length - (max - head))}`;
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The shell: Command Prompt on Windows (the sandbox); sh elsewhere (only for the tests). */
function shellFor(platform, command) {
  return platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', `"${command}"`], { windowsVerbatimArguments: true }] : ['/bin/sh', ['-c', command], {}];
}

function killTree(child, platform) {
  try {
    if (platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGKILL');
  } catch (_) { /* gone */ }
}

function run(command, { cwd, env, timeoutMs, platform, onData }) {
  return new Promise((resolve) => {
    const [cmd, args, extra] = shellFor(platform, command);
    let out = '';
    let timedOut = false;
    let child;
    try { child = spawn(cmd, args, Object.assign({ cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }, extra)); } catch (e) { resolve({ code: 1, output: `Could not start Command Prompt: ${e.message}` }); return; }
    const add = (b) => { const s = b.toString(); if (out.length < 2000000) out += s; if (onData) onData(s); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; killTree(child, platform); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, output: `${out}\nCould not run it: ${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? 124 : code == null ? 1 : code, output: out, timedOut }); });
  });
}

async function main(argv, env, out, opts = {}) {
  const platform = opts.platform || process.platform;
  const o = parseArgs(argv);
  const agent = core.AGENT_IDS.includes(env.LAB_AGENT) ? env.LAB_AGENT : null;
  const usage = 'Usage: node lab-cmd.js [--cwd folder] [--timeout minutes] "command"';
  if (o.help) { out(usage); return 0; }
  if (!agent) { out('lab-cmd: LAB_AGENT is not set — run this from the lab (the runner sets it).'); return 1; }
  if (!o.command) { out(`lab-cmd: give the command to run.\n${usage}`); return 1; }
  const base = env.LAB_BASE || path.join(env.USERPROFILE || process.cwd(), 'Desktop');
  const workshop = path.join(base, 'workshop');
  const cwd = o.cwd || path.join(workshop, agent);
  if (!fs.existsSync(cwd)) { out(`lab-cmd: no such folder: ${cwd}`); return 1; }
  const minutes = Math.max(1, Math.min(60, Number.isFinite(o.timeout) ? o.timeout : 10));
  const logFile = path.join(workshop, 'console', `${agent}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const who = core.AGENTS[agent].label;
  const t0 = Date.now();
  const log = (s) => { try { fs.appendFileSync(logFile, s); } catch (_) { /* the log is for watching; the command still runs */ } };
  log(`\n[${stamp(new Date(t0))}] ${who} ${cwd}> ${o.command}\n`);
  const r = await run(o.command, { cwd, env, timeoutMs: minutes * 60000, platform, onData: log });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const tail = r.timedOut ? `[stopped: it ran longer than ${minutes} min — exit 124]` : `[exit ${r.code}, ${secs} s]`;
  log(`${r.output && !r.output.endsWith('\n') ? '\n' : ''}${tail}\n`);
  out(`${clip(r.output).replace(/\s+$/, '')}\n${tail}`);
  return r.code;
}

module.exports = { main, parseArgs, clip, shellFor };

if (require.main === module) {
  main(process.argv.slice(2), process.env, (s) => process.stdout.write(`${s}\n`))
    .then((code) => { process.exitCode = code; }, (e) => { console.error(`lab-cmd: ${e && e.message}`); process.exitCode = 1; });
}
