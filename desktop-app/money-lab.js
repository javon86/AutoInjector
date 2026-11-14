'use strict';
// money-lab.js — 🧪 Money lab, AutoInjector's side, the plain parts (no Electron, no processes): unit-tested.
//
// The lab puts Claude (Claude Code) and ChatGPT (Codex) in a Windows Sandbox — a throw-away Windows inside Windows
// — with a web browser, and lets them try to earn money honestly for a set time. They only see five folders of the
// lab on this PC (everything else on the PC is out of their reach), and they must ask you before any account,
// public post, message or money (ask-owner → the 🧪 window's Allow / Deny).
//
// On this PC (Documents\AutoInjector Money lab\):
//   lab-kit      the runner, the rules, the browser guard, ask-owner — copied fresh from the app at each start; read-only inside
//   lab-control  your mission, your answers, the sites you allowed sign-in on, "stop" — read-only inside, so an AI can't answer itself
//   workshop     what they make, journals, board, ledger, their asks, logs, lab-status.json
//   lab-cache    Node, Git, Claude Code, Codex, the browser tool — downloaded the first time, kept
//   lab-logins   their own sign-ins and browser profiles — kept, so you sign in once
//   money-lab.wsb, lab-settings.json  (host only — not visible in the sandbox)

const path = require('path');
const core = require('./money-lab-kit/runner-core');

const FOLDERS = ['lab-kit', 'lab-control', 'workshop', 'lab-cache', 'lab-logins'];
const READ_ONLY = { 'lab-kit': true, 'lab-control': true };
const SANDBOX_DESKTOP = 'C:\\Users\\WDAGUtilityAccount\\Desktop';
const ALIVE_MS = 90000; // the runner writes a heartbeat every 15 s
const SLOW_PHASES_MS = 20 * 60000; // opening the sandbox + the first-time downloads write no heartbeat for minutes
const SLOW_PHASES = ['opening', 'setting-up', 'starting'];

const DEFAULT_MISSION = 'Find an honest, legal way to earn real money online, starting with $0 and only free tools. '
  + 'Pick one idea you can actually finish (for example a small digital product, a useful template, a short e-book, '
  + 'printables, or a simple web tool), build it properly, and get it ready to sell. Ask me before you make any account '
  + 'or publish anything. Keep notes on what you tried and what you learned.';

const DEFAULTS = {
  mission: DEFAULT_MISSION,
  agents: { claude: true, codex: true },
  hours: 2,
  roundMinutes: 20,
  style: 'solo',
  memoryMB: 8192,
  autoStart: false,
};

const clampInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

function labPaths(root) {
  const p = { root, wsb: path.join(root, 'money-lab.wsb'), settings: path.join(root, 'lab-settings.json') };
  p.kit = path.join(root, 'lab-kit');
  p.control = path.join(root, 'lab-control');
  p.workshop = path.join(root, 'workshop');
  p.cache = path.join(root, 'lab-cache');
  p.logins = path.join(root, 'lab-logins');
  p.status = path.join(p.workshop, 'lab-status.json');
  p.asks = path.join(p.workshop, 'asks');
  p.answers = path.join(p.control, 'answers');
  p.approved = path.join(p.control, 'approved-sites.json');
  p.mission = path.join(p.control, 'mission.json');
  p.stop = path.join(p.control, 'stop.json');
  p.ledger = path.join(p.workshop, 'ledger.md');
  p.board = path.join(p.workshop, 'board.md');
  return p;
}

/** The settings, cleaned (from the 🧪 window or the saved file). */
function normalizeSettings(raw) {
  const s = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
  const agents = { claude: !!(s.agents && s.agents.claude), codex: !!(s.agents && s.agents.codex) };
  const mission = String(s.mission == null ? '' : s.mission).trim().slice(0, 4000);
  return {
    mission: mission || DEFAULT_MISSION,
    agents,
    hours: clampInt(s.hours, 1, 72, DEFAULTS.hours),
    roundMinutes: clampInt(s.roundMinutes, 5, 120, DEFAULTS.roundMinutes),
    style: core.STYLES[s.style] ? s.style : 'solo',
    memoryMB: clampInt(s.memoryMB, 4096, 32768, DEFAULTS.memoryMB),
    autoStart: s.autoStart === true,
  };
}

/** Can this PC run the lab? { ok, code, words, steps[] } — Windows Sandbox needs Windows 10/11 Pro, Enterprise or Education. */
function availability({ platform, sandboxExe, exists }) {
  if (platform !== 'win32') return { ok: false, code: 'NOT_WINDOWS', words: 'The Money lab uses Windows Sandbox, so it only works on Windows.', steps: [] };
  if (sandboxExe && exists(sandboxExe)) return { ok: true, code: 'READY', words: 'Windows Sandbox is on.', steps: [] };
  return {
    ok: false, code: 'SANDBOX_OFF',
    words: 'Windows Sandbox is not turned on (or this Windows can\'t have it).',
    steps: [
      'Windows Sandbox comes with Windows 10/11 Pro, Enterprise and Education (not Home). To check: Start → Settings → System → About → Edition.',
      'Turn it on: press “Turn Windows Sandbox on” below and say Yes to the Windows question — or Start → type “Turn Windows features on or off” → tick “Windows Sandbox” → OK.',
      'Restart the PC when Windows asks.',
      'If it says virtualization is off: turn on “Intel VT-x” / “AMD SVM” (virtualization) in the PC\'s BIOS / UEFI settings.',
    ],
  };
}

function sandboxExePath(env) {
  const root = (env && (env.SystemRoot || env.windir)) || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsSandbox.exe');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The Windows Sandbox file (.wsb): network on, the five folders mapped, start.ps1 run at logon, nothing else shared. */
function buildWsb(paths, settings) {
  const s = normalizeSettings(settings);
  const maps = FOLDERS.map((name) => [
    '    <MappedFolder>',
    `      <HostFolder>${xml(path.join(paths.root, name))}</HostFolder>`,
    `      <SandboxFolder>${xml(`${SANDBOX_DESKTOP}\\${name}`)}</SandboxFolder>`,
    `      <ReadOnly>${READ_ONLY[name] ? 'true' : 'false'}</ReadOnly>`,
    '    </MappedFolder>',
  ].join('\r\n'));
  const script = `${SANDBOX_DESKTOP}\\lab-kit\\start.ps1`;
  const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script}'"`;
  return [
    '<Configuration>',
    '  <Networking>Enable</Networking>',
    '  <vGPU>Disable</vGPU>',
    `  <MemoryInMB>${s.memoryMB}</MemoryInMB>`,
    '  <AudioInput>Disable</AudioInput>',
    '  <VideoInput>Disable</VideoInput>',
    '  <PrinterRedirection>Disable</PrinterRedirection>',
    '  <ClipboardRedirection>Enable</ClipboardRedirection>',
    '  <MappedFolders>',
    maps.join('\r\n'),
    '  </MappedFolders>',
    '  <LogonCommand>',
    `    <Command>${xml(cmd)}</Command>`,
    '  </LogonCommand>',
    '</Configuration>',
    '',
  ].join('\r\n');
}

/** The mission file for one start (lab-control/mission.json). */
function buildMission(settings, now) {
  const s = normalizeSettings(settings);
  const agents = core.AGENT_IDS.filter((a) => s.agents[a]);
  return { id: `lab-${Number(now).toString(36)}`, mission: s.mission, agents, hours: s.hours, roundMinutes: s.roundMinutes, style: s.style, created_at: now };
}

/** The status the runner wrote, read with the clock: { alive, phase, words, … }. */
function readStatus(raw, now) {
  if (!raw || typeof raw !== 'object') return { alive: false, phase: 'off', words: 'The lab is closed.', agents: [] };
  const hb = Number(raw.heartbeat) || 0;
  const phase = String(raw.phase || 'unknown').slice(0, 40);
  const alive = now - hb < (SLOW_PHASES.includes(phase) ? SLOW_PHASES_MS : ALIVE_MS);
  const agents = Object.entries(raw.agents && typeof raw.agents === 'object' ? raw.agents : {})
    .filter(([id]) => core.AGENT_IDS.includes(id))
    .map(([id, a]) => ({
      id, label: core.AGENTS[id].label, tool: core.AGENTS[id].tool,
      state: String((a && a.state) || '').slice(0, 30), words: String((a && a.words) || '').slice(0, 300),
      last: String((a && a.last) || '').slice(0, 700), money: a && Number.isFinite(Number(a.money)) && a.money !== null ? Number(a.money) : null,
      rounds: Number(a && a.rounds) || 0,
    }));
  const finished = ['finished', 'needs-sign-in', 'error'].includes(phase);
  return {
    alive, phase: alive || finished ? phase : 'off', lastPhase: phase,
    words: alive || finished ? String(raw.words || '').slice(0, 400) : 'The lab is closed (no word from the sandbox for over a minute).',
    missionId: raw.mission_id || null, round: Number(raw.round) || 0,
    startedAt: Number(raw.started_at) || null, endsAt: Number(raw.ends_at) || null, roundEndsAt: Number(raw.round_ends_at) || null,
    moneyClaimed: Number(raw.money_claimed) || 0, heartbeat: hb, agents,
  };
}

/** The asks the AIs wrote, with your answers: newest first, open ones first. */
function asksView(rawAsks, rawAnswers) {
  const answers = new Map((rawAnswers || []).map(core.cleanAnswer).filter(Boolean).map((a) => [a.id, a]));
  return (rawAsks || []).map(core.cleanAsk).filter(Boolean).map((q) => Object.assign({}, q, { label: core.AGENTS[q.agent].label, answer: answers.get(q.id) || null }))
    .sort((a, b) => (!!a.answer - !!b.answer) || (b.at - a.at));
}

/** Your answer to an ask → the answer file + (for an allowed account ask) the site added to the sign-in list. */
function answerFor(ask, allow, note, now, approvedRaw) {
  const answer = { id: ask.id, allow: allow === true, note: String(note || '').trim().slice(0, 500), at: now };
  let approved = core.approvedHosts(approvedRaw);
  if (answer.allow && ask.kind === 'account' && ask.site && !approved.includes(ask.site)) approved = approved.concat(ask.site);
  return { answer, approved };
}

/** The last lines of the ledger, for the window. */
function ledgerTail(text, n = 12) {
  return String(text || '').split(/\r?\n/).filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l) && !/^\|\s*When\s*\|/i.test(l)).slice(-n).map((l) => l.slice(0, 300));
}

module.exports = {
  FOLDERS, READ_ONLY, SANDBOX_DESKTOP, ALIVE_MS, DEFAULTS, DEFAULT_MISSION,
  labPaths, normalizeSettings, availability, sandboxExePath, buildWsb, buildMission, readStatus, asksView, answerFor, ledgerTail,
};
