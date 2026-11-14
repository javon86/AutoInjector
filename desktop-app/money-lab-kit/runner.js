'use strict';
// money-lab-kit/runner.js — 🧪 Money lab: the runner INSIDE the Windows Sandbox (start.ps1 starts it after it has
// put Node, Git and the command-line tools in lab-cache).
//
//   1. waits for the owner's mission (lab-control/mission.json, written by AutoInjector when you press ▶ Start);
//   2. checks Claude Code and Codex are signed in — if not, opens a sign-in window in the sandbox and waits;
//   3. runs rounds until the time is up or you press ⏸ Stop after this round: each AI gets its instructions
//      (runner-core.buildPrompt), its browser (Edge through Playwright MCP, with the guard script), and works in
//      workshop/<claude|codex>; both work at the same time; a round that runs over its time is stopped;
//   4. writes workshop/lab-status.json every 15 s (AutoInjector shows it) and a log per AI per round.
//
// The fence is the sandbox itself (it only sees the five mapped folders; closing it wipes everything else). The
// rules, ask-owner, the browser guard and the payment block are the lab's rules inside the fence.
//
// runLab(deps) takes everything it touches (files, clock, processes) so test/money-lab-runner.test.js runs the whole
// loop on any computer with fakes; realDeps() is what the sandbox uses.

const fsReal = require('fs');
const path = require('path');
const core = require('./runner-core');

const HEARTBEAT_MS = 15000;
const MISSION_POLL_MS = 10000;

function labDirs(base) {
  return {
    base,
    kit: path.join(base, 'lab-kit'),
    control: path.join(base, 'lab-control'),
    workshop: path.join(base, 'workshop'),
    cache: path.join(base, 'lab-cache'),
    logins: path.join(base, 'lab-logins'),
  };
}

function readJson(fs, file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return fallback; }
}
function writeJson(fs, file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (_) { return false; }
}
function ensureFile(fs, file, text) {
  try { if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); } } catch (_) { /* best effort */ }
}
function appendText(fs, file, text) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, text); } catch (_) { /* best effort */ }
}
function readDirJson(fs, dir, clean) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
  return names.map((n) => clean(readJson(fs, path.join(dir, n), null))).filter(Boolean);
}

async function runLab(deps) {
  const { fs, dirs, now, sleep, log } = deps;
  const statusFile = path.join(dirs.workshop, 'lab-status.json');
  const status = { phase: 'starting', words: 'The lab is starting', mission_id: null, round: 0, started_at: null, ends_at: null, agents: {}, money_claimed: 0, heartbeat: now(), version: 1 };
  const save = () => { status.heartbeat = now(); writeJson(fs, statusFile, status); };
  const set = (patch) => { Object.assign(status, patch); save(); };
  const beat = deps.setInterval ? deps.setInterval(save, HEARTBEAT_MS) : null;
  try {
    save();
    // 1. the mission
    let mission = null;
    for (;;) {
      mission = core.normalizeMission(readJson(fs, path.join(dirs.control, 'mission.json'), null));
      if (mission) break;
      set({ phase: 'waiting', words: 'Waiting for a mission — press ▶ Start in AutoInjector\'s 🧪 Money lab' });
      if (deps.once) return status;
      await sleep(MISSION_POLL_MS);
    }
    const runDir = path.join(dirs.workshop, 'runs', mission.id);
    const stateFile = path.join(runDir, 'state.json');
    const st = readJson(fs, stateFile, null) || { started_at: now(), round: 0 };
    if (!st.ends_at) st.ends_at = st.started_at + mission.hours * 3600000;
    writeJson(fs, stateFile, st);
    set({ mission_id: mission.id, started_at: st.started_at, ends_at: st.ends_at, round: st.round });
    for (const a of mission.agents) status.agents[a] = { label: core.AGENTS[a].label, state: 'checking', words: 'Checking the sign-in…', last: '', money: null, rounds: 0 };

    // 2. folders + sign-in
    ensureFile(fs, path.join(dirs.workshop, 'board.md'), '# Shared board\n\nShort notes from the AIs to each other and to the owner. Newest at the bottom.\n\n');
    ensureFile(fs, path.join(dirs.workshop, 'ledger.md'), '# Money ledger\n\nOnly money actually received, with proof (where, when, how much). No estimates.\n\n| When | Who | Amount | Where from | Proof |\n|---|---|---|---|---|\n');
    for (const a of mission.agents) {
      fs.mkdirSync(path.join(dirs.workshop, a, 'products'), { recursive: true });
      ensureFile(fs, path.join(dirs.workshop, a, 'journal.md'), `# ${core.AGENTS[a].label}'s journal\n\n`);
    }
    set({ phase: 'signing-in', words: 'Checking Claude Code and Codex are signed in' });
    const ready = [];
    for (const a of mission.agents) {
      let ok = false;
      try { ok = await deps.ensureSignedIn(a, (words) => { status.agents[a].state = 'sign-in'; status.agents[a].words = words; save(); }); } catch (e) { log(`sign-in check ${a}: ${e && e.message}`); }
      status.agents[a].state = ok ? 'ready' : 'signed-out';
      status.agents[a].words = ok ? 'Signed in' : `${core.AGENTS[a].tool} is not signed in — it sits this run out`;
      if (ok) ready.push(a);
      save();
    }
    if (!ready.length) { set({ phase: 'needs-sign-in', words: 'Neither AI is signed in. Close the sandbox, press ▶ Start again and sign in when the windows ask.' }); return status; }

    // 3. the rounds
    const rules = (() => { try { return fs.readFileSync(path.join(dirs.kit, 'RULES.md'), 'utf8'); } catch (_) { return 'Be honest and legal. Ask the owner before any account, public post, message or money.'; } })();
    const stopped = () => { const s = readJson(fs, path.join(dirs.control, 'stop.json'), null); return !!(s && s.mission_id === mission.id); };
    let endWords = 'The time is up';
    for (;;) {
      if (stopped()) { endWords = 'Stopped by the owner'; break; }
      if (!core.shouldStartRound({ now: now(), endsAt: st.ends_at, roundMinutes: mission.roundMinutes })) break;
      st.round += 1;
      writeJson(fs, stateFile, st);
      const budget = core.roundBudgetMs({ now: now(), endsAt: st.ends_at, roundMinutes: mission.roundMinutes });
      const lastRound = !core.shouldStartRound({ now: now() + budget, endsAt: st.ends_at, roundMinutes: mission.roundMinutes });
      set({ phase: 'working', words: `Round ${st.round}${lastRound ? ' (the last one)' : ''}`, round: st.round, round_ends_at: now() + budget });
      const asks = readDirJson(fs, path.join(dirs.workshop, 'asks'), core.cleanAsk);
      const answers = readDirJson(fs, path.join(dirs.control, 'answers'), core.cleanAnswer);
      const signIn = core.approvedHosts(readJson(fs, path.join(dirs.control, 'approved-sites.json'), []));
      await Promise.all(ready.map(async (a) => {
        const prompt = core.buildPrompt({
          agent: a, agents: ready, mission: mission.mission, style: mission.style, round: st.round, roundMinutes: Math.round(budget / 60000),
          minutesLeft: (st.ends_at - now()) / 60000, lastRound, rules, answers: core.answersFor(a, asks, answers), waiting: core.openAsks(a, asks, answers),
          signInSites: signIn, dirs: { mine: path.join(dirs.workshop, a), workshop: dirs.workshop, kit: dirs.kit },
        });
        status.agents[a].state = 'working';
        status.agents[a].words = `Working on round ${st.round}`;
        save();
        const t0 = now();
        let r;
        try { r = await deps.runAgent(a, prompt, { budgetMs: budget, approvedHosts: signIn, round: st.round, missionId: mission.id }); } catch (e) { r = { code: -1, output: '', error: (e && e.message) || String(e) }; }
        const secs = Math.round((now() - t0) / 1000);
        const logFile = path.join(runDir, 'logs', `${a}-round-${String(st.round).padStart(3, '0')}.txt`);
        appendText(fs, logFile, `# ${core.AGENTS[a].label} — round ${st.round} — ${secs} s — exit ${r.code}${r.timedOut ? ' (stopped: out of time)' : ''}${r.error ? ` — ${r.error}` : ''}\n\n${r.output || ''}\n`);
        const ag = status.agents[a];
        ag.rounds += 1;
        ag.last = core.summarize(r.output) || (r.error ? `✖ ${r.error}` : '(no words at the end of the round)');
        const m = core.moneyClaim(r.output);
        if (m != null) ag.money = m;
        ag.state = r.timedOut ? 'over-time' : r.code === 0 ? 'done' : 'trouble';
        ag.words = r.timedOut ? `Round ${st.round}: ran out of time (stopped)` : r.code === 0 ? `Round ${st.round} done (${Math.round(secs / 60)} min)` : `Round ${st.round}: ${core.AGENTS[a].tool} stopped with an error — see the log`;
        save();
      }));
      status.money_claimed = Object.values(status.agents).reduce((s, x) => s + (x.money || 0), 0);
      save();
      if (deps.maxRounds && st.round >= deps.maxRounds) break;
    }
    set({ phase: 'finished', words: `${endWords}. Their work is in the workshop folder (REPORT.md in each AI's folder).`, round_ends_at: null });
    for (const a of ready) { status.agents[a].state = 'finished'; status.agents[a].words = 'Finished'; }
    save();
    return status;
  } catch (e) {
    set({ phase: 'error', words: `The lab runner stopped: ${(e && e.message) || e}` });
    log(`runner error: ${(e && e.stack) || e}`);
    return status;
  } finally {
    if (beat && deps.clearInterval) deps.clearInterval(beat);
  }
}

// ------------------------------------------------------------------------------------------------------------------
// The real world (only inside the sandbox)

/** How to start a command-line tool installed with npm into lab-cache/npm: [command, ...args] (no shell, no .cmd). */
function resolveTool(fs, cacheDir, pkg, binName, nodeExe) {
  const roots = [path.join(cacheDir, 'npm', 'node_modules'), path.join(cacheDir, 'npm', 'lib', 'node_modules')];
  for (const r of roots) {
    const dir = path.join(r, ...pkg.split('/'));
    const meta = readJson(fs, path.join(dir, 'package.json'), null);
    if (!meta) continue;
    const bin = typeof meta.bin === 'string' ? meta.bin : meta.bin && (meta.bin[binName] || Object.values(meta.bin)[0]);
    if (!bin) continue;
    const full = path.join(dir, bin);
    return /\.(c|m)?js$/i.test(full) ? [nodeExe, full] : [full];
  }
  return null;
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  try {
    if (process.platform === 'win32') require('child_process').spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGKILL');
  } catch (_) { /* already gone */ }
}

/** Run one command with the prompt on stdin; stop it after budgetMs. Never throws. */
function runCommand(cmd, args, { stdin, cwd, env, budgetMs, maxOut = 400000 }) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    let child;
    try {
      child = require('child_process').spawn(cmd, args, { cwd, env, windowsHide: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { resolve({ code: -1, output: '', error: e.message }); return; }
    const add = (b) => { if (out.length < maxOut) out += b.toString(); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, budgetMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: out, error: e.message, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, output: out, timedOut }); });
    try { child.stdin.on('error', () => {}); child.stdin.end(stdin || ''); } catch (_) { /* closed */ }
  });
}

function agentEnv(dirs, agent) {
  const env = Object.assign({}, process.env);
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[k]; // the plans you signed in with, never per-use billing
  env.CLAUDE_CONFIG_DIR = path.join(dirs.logins, 'claude');
  env.CODEX_HOME = path.join(dirs.logins, 'codex');
  env.IS_SANDBOX = '1';
  env.LAB_AGENT = agent || '';
  env.LAB_BASE = dirs.base;
  const bash = path.join(dirs.cache, 'git', 'bin', 'bash.exe');
  if (fsReal.existsSync(bash)) env.CLAUDE_CODE_GIT_BASH_PATH = bash;
  return env;
}

function realDeps(base) {
  const dirs = labDirs(base);
  const nodeExe = process.execPath;
  const logFile = path.join(dirs.workshop, 'logs', 'runner.log');
  const log = (s) => { appendText(fsReal, logFile, `${new Date().toISOString()} ${s}\n`); try { console.log(s); } catch (_) {} };
  const tool = (a) => resolveTool(fsReal, dirs.cache, core.AGENTS[a].pkg, core.AGENTS[a].bin, nodeExe);

  function prepareBrowser(a, hosts) {
    const runDir = path.join(dirs.cache, 'run', a);
    fsReal.mkdirSync(runDir, { recursive: true });
    const guardFile = path.join(runDir, 'guard.js');
    fsReal.writeFileSync(guardFile, core.guardScript(hosts));
    const pw = resolveTool(fsReal, dirs.cache, '@playwright/mcp', 'mcp-server-playwright', nodeExe);
    if (!pw) return null;
    const outDir = path.join(dirs.workshop, a, 'browser-files');
    fsReal.mkdirSync(outDir, { recursive: true });
    const args = core.browserArgs({ cliJs: pw[pw.length - 1], profileDir: path.join(dirs.logins, `browser-${a}`), guardFile, outDir });
    return { command: pw[0] === nodeExe ? nodeExe : pw[0], args: pw[0] === nodeExe ? args : args.slice(1), runDir };
  }

  async function openSignInWindow(a, t) {
    const title = `Sign in to ${core.AGENTS[a].tool}`;
    const hint = a === 'claude' ? 'Sign in with your Claude account (Pro or Max). When it says you are signed in, type /exit and close this window.' : 'A browser opens: sign in with your ChatGPT account. Then close this window.';
    const run = (a === 'codex' ? [...t, 'login'] : t).map((x) => `"${x}"`).join(' ');
    const line = `title ${title} & echo ${hint} & echo. & ${run} & echo. & echo You can close this window now. & pause`;
    await runCommand('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath cmd.exe -ArgumentList '/c', '${line.replace(/'/g, "''")}' -Wait`], { env: agentEnv(dirs, a), cwd: dirs.workshop, budgetMs: 30 * 60000 });
  }

  async function signedIn(a, t) {
    if (a === 'codex') {
      const r = await runCommand(t[0], [...t.slice(1), 'login', 'status'], { env: agentEnv(dirs, a), cwd: dirs.workshop, budgetMs: 60000 });
      return r.code === 0 && !/not logged in/i.test(r.output);
    }
    const r = await runCommand(t[0], [...t.slice(1), '-p', '--output-format', 'text'], { stdin: 'Reply with just the word OK.', env: agentEnv(dirs, a), cwd: dirs.workshop, budgetMs: 180000 });
    return r.code === 0 && /\bOK\b/i.test(r.output) && !/(invalid api key|please run \/login|not logged in)/i.test(r.output);
  }

  return {
    fs: fsReal, dirs, log, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), setInterval, clearInterval,
    async ensureSignedIn(a, say) {
      const t = tool(a);
      if (!t) { log(`${a}: the command-line tool is not installed in lab-cache`); return false; }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await signedIn(a, t)) return true;
        say(`Sign in to ${core.AGENTS[a].tool} in the window that opened in the sandbox`);
        await openSignInWindow(a, t);
      }
      return signedIn(a, t);
    },
    async runAgent(a, prompt, o) {
      const t = tool(a);
      if (!t) return { code: -1, output: '', error: `${core.AGENTS[a].tool} is not installed` };
      const b = prepareBrowser(a, o.approvedHosts);
      const env = agentEnv(dirs, a);
      const cwd = path.join(dirs.workshop, a);
      if (a === 'claude') {
        const cfg = path.join(b ? b.runDir : path.join(dirs.cache, 'run', a), 'mcp.json');
        fsReal.mkdirSync(path.dirname(cfg), { recursive: true });
        fsReal.writeFileSync(cfg, b ? core.claudeMcpConfig(b.command, b.args) : JSON.stringify({ mcpServers: {} }));
        return runCommand(t[0], [...t.slice(1), ...core.claudeArgs(cfg)], { stdin: prompt, cwd, env, budgetMs: o.budgetMs });
      }
      fsReal.mkdirSync(env.CODEX_HOME, { recursive: true });
      if (b) fsReal.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), core.codexConfigToml(b.command, b.args));
      const answer = path.join(dirs.workshop, 'runs', o.missionId, 'logs', `codex-round-${String(o.round).padStart(3, '0')}-answer.txt`);
      fsReal.mkdirSync(path.dirname(answer), { recursive: true });
      const r = await runCommand(t[0], [...t.slice(1), ...core.codexArgs(cwd, answer)], { stdin: prompt, cwd, env, budgetMs: o.budgetMs });
      try { const last = fsReal.readFileSync(answer, 'utf8'); if (last.trim()) r.output = `${r.output}\n${last}`; } catch (_) { /* no answer file */ }
      return r;
    },
  };
}

module.exports = { runLab, labDirs, resolveTool, runCommand, readJson, writeJson, HEARTBEAT_MS };

if (require.main === module) {
  const base = process.env.LAB_BASE || path.join(process.env.USERPROFILE || process.cwd(), 'Desktop');
  runLab(realDeps(base)).then((s) => { console.log(`\nThe lab is ${s.phase}: ${s.words}`); }, (e) => { console.error(e); process.exitCode = 1; });
}
