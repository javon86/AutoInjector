'use strict';
// money-lab-main.js — 🧪 Money lab, AutoInjector's main-process side: the folders on this PC, starting and closing
// the Windows Sandbox, your answers to the AIs' asks, and a desktop notice when an AI asks something.
//
// createMoneyLab(deps) takes what it touches (fs, spawn, the clock, the platform) so test/money-lab.test.js runs it
// with fakes on any computer. main.js makes one with the real ones and wires the lab:* IPC channels to it.

const path = require('path');
const L = require('./money-lab');
const core = require('./money-lab-kit/runner-core');

const SANDBOX_PROCESSES = ['WindowsSandboxRemoteSession.exe', 'WindowsSandboxClient.exe', 'WindowsSandbox.exe', 'WindowsSandboxServer.exe'];
const MAX_ASK_FILES = 300;
const MAX_ASK_BYTES = 20000;

function createMoneyLab(deps) {
  const fs = deps.fs || require('fs');
  const spawn = deps.spawn || require('child_process').spawn;
  const now = deps.now || (() => Date.now());
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const log = deps.log || (() => {});
  const notify = deps.notify || (() => {});
  const P = L.labPaths(deps.root);
  const kitSource = deps.kitSource; // the app's money-lab-kit folder
  const seenAsks = new Set();
  let seeded = false;

  const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return fallback; } };
  const writeJson = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  };
  const exists = (f) => { try { return fs.existsSync(f); } catch (_) { return false; } };

  function available() {
    return L.availability({ platform, sandboxExe: L.sandboxExePath(env), exists });
  }

  function getSettings() { return L.normalizeSettings(readJson(P.settings, null)); }
  function saveSettings(raw) {
    const s = L.normalizeSettings(raw);
    try { fs.mkdirSync(P.root, { recursive: true }); writeJson(P.settings, s); return { ok: true, settings: s }; } catch (e) { return { ok: false, error: 'SAVE_FAILED', words: `Couldn't save the lab settings: ${e.message}` }; }
  }

  function readDirJson(dir, max) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
    names.sort();
    return names.slice(-max).map((n) => {
      try {
        const file = path.join(dir, n);
        if (fs.statSync(file).size > MAX_ASK_BYTES) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      } catch (_) { return null; }
    }).filter(Boolean);
  }

  function asks() { return L.asksView(readDirJson(P.asks, MAX_ASK_FILES), readDirJson(P.answers, MAX_ASK_FILES * 2)); }

  function products() {
    const out = {};
    for (const a of core.AGENT_IDS) {
      try { out[a] = fs.readdirSync(path.join(P.workshop, a, 'products')).filter((n) => !n.startsWith('.')).slice(0, 40); } catch (_) { out[a] = []; }
    }
    return out;
  }

  function status() {
    const st = L.readStatus(readJson(P.status, null), now());
    let ledger = [];
    try { ledger = L.ledgerTail(fs.readFileSync(P.ledger, 'utf8')); } catch (_) { /* no ledger yet */ }
    return { available: available(), settings: getSettings(), status: st, asks: asks(), ledger, products: products(), root: P.root, workshop: P.workshop };
  }

  /** Copy the app's kit into lab-kit (fresh each start, so an update to the app reaches the lab). */
  function copyKit() {
    if (!kitSource) throw new Error('the lab kit is missing from the app');
    const copy = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) {
        const src = path.join(from, name);
        const dst = path.join(to, name);
        if (fs.statSync(src).isDirectory()) copy(src, dst);
        else fs.writeFileSync(dst, fs.readFileSync(src));
      }
    };
    copy(kitSource, P.kit);
  }

  function start(raw) {
    const av = available();
    if (!av.ok) return { ok: false, error: av.code, words: av.words, steps: av.steps };
    const st = L.readStatus(readJson(P.status, null), now());
    if (st.alive && !['finished', 'needs-sign-in', 'error'].includes(st.phase)) {
      return { ok: false, error: 'ALREADY_OPEN', words: 'The lab is already open. Close the sandbox window first (or press ⏹ Close the sandbox) to start a new run.' };
    }
    const saved = raw ? saveSettings(raw) : { ok: true, settings: getSettings() };
    if (!saved.ok) return saved;
    const s = saved.settings;
    if (!s.agents.claude && !s.agents.codex) return { ok: false, error: 'NO_AI', words: 'Tick Claude, ChatGPT or both.' };
    try {
      for (const f of L.FOLDERS) fs.mkdirSync(path.join(P.root, f), { recursive: true });
      fs.mkdirSync(P.answers, { recursive: true });
      fs.mkdirSync(P.asks, { recursive: true });
      copyKit();
      const mission = L.buildMission(s, now());
      writeJson(P.mission, mission);
      try { fs.unlinkSync(P.stop); } catch (_) { /* not there */ }
      if (!exists(P.approved)) writeJson(P.approved, []);
      writeJson(P.status, { phase: 'opening', words: 'Opening Windows Sandbox…', heartbeat: now(), agents: {}, version: 1 });
      fs.writeFileSync(P.wsb, L.buildWsb(P, s));
      const child = spawn(L.sandboxExePath(env), [P.wsb], { detached: true, stdio: 'ignore', windowsHide: false });
      if (child && typeof child.on === 'function') child.on('error', (e) => log(`money-lab: Windows Sandbox did not start: ${e.message}`));
      if (child && typeof child.unref === 'function') child.unref();
      log(`money-lab: started ${mission.id} (${mission.agents.join('+')}, ${mission.hours} h, ${mission.roundMinutes} min rounds, ${mission.style})`);
      return { ok: true, missionId: mission.id, words: 'Windows Sandbox is opening. The first time, it downloads its tools (a few minutes) and asks you to sign in to Claude and ChatGPT inside the sandbox window.' };
    } catch (e) {
      log(`money-lab: start failed: ${e.message}`);
      return { ok: false, error: 'START_FAILED', words: `The lab couldn't start: ${e.message}` };
    }
  }

  function stopAfterRound() {
    const raw = readJson(P.mission, null);
    if (!raw || !raw.id) return { ok: false, error: 'NO_RUN', words: 'There is no run to stop.' };
    try { writeJson(P.stop, { mission_id: raw.id, at: now() }); return { ok: true, words: 'They will stop when this round ends.' }; } catch (e) { return { ok: false, error: 'WRITE_FAILED', words: e.message }; }
  }

  function closeNow() {
    stopAfterRound();
    if (platform !== 'win32') return { ok: false, error: 'NOT_WINDOWS', words: 'Windows only.' };
    for (const name of SANDBOX_PROCESSES) {
      try { const c = spawn('taskkill', ['/IM', name, '/F'], { stdio: 'ignore', windowsHide: true }); if (c && c.on) c.on('error', () => {}); } catch (_) { /* not running */ }
    }
    try { writeJson(P.status, Object.assign(readJson(P.status, {}) || {}, { phase: 'closed', words: 'You closed the sandbox.', heartbeat: 0 })); } catch (_) { /* best effort */ }
    log('money-lab: closed the sandbox');
    return { ok: true, words: 'The sandbox is closing. Their work stays in the workshop folder.' };
  }

  function answer(id, allow, note) {
    if (!core.ID_RE.test(String(id || ''))) return { ok: false, error: 'BAD_ID', words: 'That ask is not there.' };
    const ask = core.cleanAsk(readJson(path.join(P.asks, `${id}.json`), null));
    if (!ask || ask.id !== id) return { ok: false, error: 'NO_ASK', words: 'That ask is not there any more.' };
    try {
      const r = L.answerFor(ask, allow === true, note, now(), readJson(P.approved, []));
      writeJson(path.join(P.answers, `${id}.json`), r.answer);
      writeJson(P.approved, r.approved);
      log(`money-lab: ${r.answer.allow ? 'allowed' : 'said no to'} ${ask.agent} ${ask.kind}${ask.site ? ` on ${ask.site}` : ''}`);
      return { ok: true, allowed: r.answer.allow, words: r.answer.allow ? `Allowed. ${ask.label || core.AGENTS[ask.agent].label} sees your yes now (or in its next round).` : 'Said no. It will find another way.' };
    } catch (e) { return { ok: false, error: 'WRITE_FAILED', words: `Couldn't save your answer: ${e.message}` }; }
  }

  /** New asks since last time → a desktop notice each (the first look only remembers what is there). */
  function poll() {
    const open = asks().filter((q) => !q.answer);
    const fresh = open.filter((q) => !seenAsks.has(q.id));
    for (const q of open) seenAsks.add(q.id);
    if (!seeded) { seeded = true; return { fresh: 0, open: open.length }; }
    for (const q of fresh) notify(`🧪 ${q.label} asks: ${q.kind}${q.site ? ` on ${q.site}` : ''}`, q.what);
    return { fresh: fresh.length, open: open.length };
  }

  function folder(which) {
    if (which === 'workshop') return P.workshop;
    if (which === 'root') return P.root;
    if (core.AGENT_IDS.includes(which)) return path.join(P.workshop, which, 'products');
    return null;
  }

  function enableCommand() {
    return ['powershell.exe', ['-NoProfile', '-Command', "Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoExit','-Command','Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All -NoRestart; Write-Host; Write-Host ''Done. Restart the PC, then open the Money lab again.'''"]];
  }
  function enableSandbox() {
    if (platform !== 'win32') return { ok: false, error: 'NOT_WINDOWS', words: 'Windows only.' };
    try {
      const [cmd, args] = enableCommand();
      const c = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      if (c && c.on) c.on('error', () => {});
      if (c && c.unref) c.unref();
      return { ok: true, words: 'Say Yes to the Windows question. When it says Done, restart the PC.' };
    } catch (e) { return { ok: false, error: 'SPAWN_FAILED', words: e.message }; }
  }

  return { paths: P, available, getSettings, saveSettings, status, start, stopAfterRound, closeNow, answer, poll, folder, enableSandbox, enableCommand, SANDBOX_PROCESSES };
}

module.exports = { createMoneyLab, SANDBOX_PROCESSES };
