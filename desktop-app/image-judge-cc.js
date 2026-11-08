'use strict';
/*
 * image-judge-cc.js — the 🧑‍⚖️ judge through Claude Code (the `claude` command-line tool) on this PC.
 *
 * A small Node version of Akọwe's akowe/akowe/claude_code.py (the same rules, kept in step by hand):
 *   • found the same way: AUTOINJECTOR_CLAUDE_PATH / the setting, then PATH (claude.exe / claude.cmd / claude),
 *     ~/.local/bin, npm's global folder, /usr/local/bin, /opt/homebrew/bin;
 *   • headless: `claude -p "<short instruction>" --output-format json`, the real prompt on STDIN (never the command
 *     line — Windows caps it near 32 000 characters);
 *   • the picture is copied into a NEW EMPTY temp folder that is the working folder, and the ONLY tool allowed is
 *     Read (Claude Code views images with it): --allowedTools Read, --disallowedTools for everything else (Bash,
 *     Edit, Write, web, every MCP tool), --permission-mode dontAsk, --no-session-persistence, --strict-mcp-config;
 *     an older CLI that does not know one of these flags is asked once more with the basic flags;
 *   • a timeout (and Stop) kills the whole process tree (taskkill /T on Windows, the process group elsewhere);
 *   • ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed from its environment so it uses the person's Claude plan
 *     (AUTOINJECTOR_CLAUDE_USE_API_KEY=1 keeps them);
 *   • "Not logged in · Please run /login" → signed_out, "usage limit … resets 3pm" → limited (remembered until then).
 *
 * Why not call Akọwe's helper over the bridge: the judge belongs to AutoInjector's own Images tab and must work when
 * Akọwe is not running (Akọwe is optional); the service bridge carries requests from Akọwe INTO AutoInjector, not
 * the other way; and the picture would have to travel to Akọwe and back. This file is ~200 lines with no new
 * dependency. Privacy: the log holds codes and timings only — never the prompt or the answer.
 *
 *   createClaudeCodeJudge({ env, pathSetting, spawn, log, timeoutMs, now }) → { id, label, available(), ask({ imagePath, prompt, signal }) }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ARGV_PROMPT = 'Do the task described in the text on standard input. You may only use the Read tool, and only on the picture file in the current folder. Answer with only the JSON object it asks for.';
const DENY = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'Task', 'Agent', 'TodoWrite', 'BashOutput', 'KillShell', 'Skill', 'SlashCommand', 'WebSearch', 'WebFetch', 'mcp__*'];
const AUTH_RE = /not logged in|please run \/login|run \/login|login expired|invalid api key|authentication[_ ]failed|oauth token|not signed in|signed out of claude/i;
const LIMIT_RE = /hit your (?:session|weekly|opus|sonnet|monthly|individual)[\w ]* limit|usage limit|limit reached|rate[_ ]limit|credit balance is too low|spend limit/i;
const UNKNOWN_FLAG_RE = /unknown option|unknown argument|unrecognized (?:option|argument)/i;
const RESET_RE = /resets?\s+(?:at\s+)?(?:(mon|tue|wed|thu|fri|sat|sun)\w*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
const INSTALL_URL = 'https://code.claude.com/docs/en/setup';

function candidates(setting, env, platform) {
  const e = env || process.env;
  const win = (platform || process.platform) === 'win32';
  const out = [];
  for (const o of [e.AUTOINJECTOR_CLAUDE_PATH, setting]) if (o && String(o).trim()) out.push(String(o).trim());
  const sep = win ? ';' : ':';
  for (const dir of String(e.PATH || e.Path || '').split(sep).filter(Boolean)) for (const n of win ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude']) out.push(path.join(dir, n));
  const home = e.USERPROFILE || e.HOME || os.homedir();
  out.push(path.join(home, '.local', 'bin', win ? 'claude.exe' : 'claude'));
  const prefix = e.NPM_CONFIG_PREFIX || e.npm_config_prefix;
  if (win) { if (e.APPDATA) out.push(path.join(e.APPDATA, 'npm', 'claude.cmd')); if (prefix) out.push(path.join(prefix, 'claude.cmd')); }
  else { if (prefix) out.push(path.join(prefix, 'bin', 'claude')); out.push(path.join(home, '.npm-global', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'); }
  return [...new Set(out)];
}
function findCli(setting, env, platform) {
  for (const p of candidates(setting, env, platform)) { try { if (fs.statSync(p).isFile()) return p; } catch (_) {} }
  return null;
}
function childEnv(env) {
  const e = Object.assign({}, env || process.env);
  if (!/^(1|true|yes|on)$/i.test(String(e.AUTOINJECTOR_CLAUDE_USE_API_KEY || ''))) { delete e.ANTHROPIC_API_KEY; delete e.ANTHROPIC_AUTH_TOKEN; }
  return e;
}
function command(bin, basic) {
  const args = ['-p', ARGV_PROMPT, '--output-format', 'json', '--max-turns', '4', '--allowedTools', 'Read', '--disallowedTools', DENY.join(',')];
  if (!basic) args.push('--permission-mode', 'dontAsk', '--no-session-persistence', '--strict-mcp-config');
  return { bin, args };
}
function parseOutput(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try { const v = JSON.parse(s); if (v && typeof v === 'object' && !Array.isArray(v)) return v; if (Array.isArray(v)) { const r = v.filter((x) => x && x.type === 'result'); return r.length ? r[r.length - 1] : null; } } catch (_) {}
  for (const line of s.split(/\r?\n/).reverse()) { const t = line.trim(); if (!t.startsWith('{')) continue; try { const v = JSON.parse(t); if (v && (v.type === 'result' || 'result' in v)) return v; } catch (_) {} }
  return null;
}
function parseReset(text, now) {
  const m = RESET_RE.exec(String(text || ''));
  if (!m) return null;
  let hh = Number(m[2]); const mm = Number(m[3] || 0); const ap = String(m[4] || '').toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12; if (ap === 'am' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  const d = new Date(now || Date.now()); const t = new Date(d); t.setHours(hh, mm, 0, 0);
  if (m[1]) { const want = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(m[1].toLowerCase().slice(0, 3)); t.setDate(t.getDate() + ((want - d.getDay() + 7) % 7)); }
  if (t <= d) t.setDate(t.getDate() + (m[1] ? 7 : 1));
  return t.getTime();
}
/** → null (usable) | { error, state, message, transient, resetAt } */
function classify(code, res, stderr) {
  const text = [res && res.result, res && Array.isArray(res.errors) ? res.errors.join(' ') : '', stderr].filter(Boolean).join(' ');
  if (AUTH_RE.test(text)) return { error: 'CC_SIGNED_OUT', state: 'signed_out', message: 'Claude Code is signed out: open PowerShell, run  claude  once and sign in with your Claude account.' };
  if (LIMIT_RE.test(text) || (res && res.api_error_status === 429)) { const at = parseReset(text); return { error: 'CC_LIMITED', state: 'limited', resetAt: at, message: `Claude Code is at your Claude plan's usage limit${at ? ` until about ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}.` }; }
  if (!res) {
    if (UNKNOWN_FLAG_RE.test(stderr || '')) return { error: 'CC_UNKNOWN_FLAG', state: 'failing', message: 'This Claude Code is older and does not know one of the options.' };
    return { error: 'CC_NO_RESULT', state: 'failing', transient: true, message: `Claude Code stopped without an answer (exit code ${code}).` };
  }
  if (res.is_error || (res.subtype && res.subtype !== 'success')) return { error: 'CC_FAILED', state: 'failing', transient: res.subtype === 'error_during_execution', message: `Claude Code could not finish (${String(res.subtype || 'error').slice(0, 40)}).` };
  if (code) return { error: 'CC_EXIT', state: 'failing', transient: true, message: `Claude Code ended with exit code ${code}.` };
  return null;
}
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32') cp.spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, timeout: 15000 });
    else process.kill(-child.pid, 'SIGKILL');
  } catch (_) { try { child.kill('SIGKILL'); } catch (__) {} }
}

function createClaudeCodeJudge(opts) {
  const o = opts || {};
  const env = () => (typeof o.env === 'function' ? o.env() : o.env) || process.env;
  const log = o.log || (() => {});
  const spawn = o.spawn || cp.spawn;
  const now = o.now || (() => Date.now());
  const timeoutMs = () => Number(env().AUTOINJECTOR_JUDGE_CC_TIMEOUT_MS) || o.timeoutMs || 240000;
  let remembered = null; // { state, until, message }

  function run(bin, args, stdinText, cwd, signal) {
    return new Promise((resolve) => {
      const isCmd = process.platform === 'win32' && /\.cmd$|\.bat$/i.test(bin);
      let child;
      try {
        child = isCmd
          ? spawn(`"${bin}"`, args.map((a) => `"${String(a).replace(/"/g, '')}"`), { cwd, env: childEnv(env()), shell: true, windowsHide: true })
          : spawn(bin, args, { cwd, env: childEnv(env()), detached: process.platform !== 'win32', windowsHide: true });
      } catch (e) { resolve({ spawnError: (e && e.code) || 'SPAWN' }); return; }
      let out = ''; let err = ''; let done = false;
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { if (signal) signal.removeEventListener('abort', onAbort); } catch (_) {} resolve(v); };
      const timer = setTimeout(() => { killTree(child); finish({ timeout: true }); }, timeoutMs());
      const onAbort = () => { killTree(child); finish({ cancelled: true }); };
      try { if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); } } catch (_) {}
      child.on('error', (e) => finish({ spawnError: (e && e.code) || 'SPAWN' }));
      if (child.stdout) child.stdout.on('data', (d) => { out += d; if (out.length > 4e6) out = out.slice(-4e6); });
      if (child.stderr) child.stderr.on('data', (d) => { err += d; if (err.length > 1e5) err = err.slice(-1e5); });
      child.on('close', (code) => finish({ code, out, err }));
      try { child.stdin.on('error', () => {}); child.stdin.end(stdinText || ''); } catch (_) {}
    });
  }

  function available() {
    if (/^(0|off|false|no)$/i.test(String(env().AUTOINJECTOR_JUDGE_CC || ''))) return { ok: false, state: 'off', why: 'switched off on this PC' };
    if (remembered && remembered.until > now()) return { ok: false, state: remembered.state, why: remembered.message };
    const bin = findCli(typeof o.pathSetting === 'function' ? o.pathSetting() : o.pathSetting, env());
    if (!bin) return { ok: false, state: 'not_installed', why: `Claude Code is not installed on this PC (how to install it: ${INSTALL_URL})` };
    return { ok: true, state: 'ready', bin };
  }

  /** One judging question. The picture is the only file Claude Code can see. */
  async function ask({ imagePath, prompt, signal }) {
    const av = available();
    if (!av.ok) return { ok: false, error: av.state === 'not_installed' ? 'CC_NOT_INSTALLED' : `CC_${String(av.state).toUpperCase()}`, message: av.why, unavailable: true };
    let buf;
    try { buf = fs.readFileSync(imagePath); } catch (_) { return { ok: false, error: 'BAD_IMAGE', message: 'The picture file could not be read.' }; }
    const ext = buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : buf[0] === 0x52 && buf[1] === 0x49 ? 'webp' : 'png';
    const work = fs.mkdtempSync(path.join(o.tmpdir || os.tmpdir(), 'ai-judge-'));
    const name = `picture.${ext}`;
    const t0 = now();
    try {
      fs.writeFileSync(path.join(work, name), buf);
      const text = `${prompt}\n\nThe picture is the file ./${name} in the current folder: open it with the Read tool and look at it before you answer.`;
      let basic = false; let attempts = 0;
      for (;;) {
        attempts++;
        const c = command(av.bin, basic);
        const r = await run(c.bin, c.args, text, work, signal);
        if (r.cancelled) return { ok: false, error: 'CANCELLED', message: 'Stopped.' };
        if (r.spawnError) return { ok: false, error: 'CC_NOT_INSTALLED', unavailable: true, message: `Claude Code could not be started (${r.spawnError}).` };
        if (r.timeout) { log('image-judge', { judge: 'claude-code', error: 'TIMEOUT', ms: now() - t0 }); return { ok: false, error: 'CC_TIMEOUT', message: `Claude Code took longer than ${Math.round(timeoutMs() / 1000)} s, so it was stopped.` }; }
        const res = parseOutput(r.out);
        const bad = classify(r.code, res, r.err);
        if (bad && bad.error === 'CC_UNKNOWN_FLAG' && !basic) { basic = true; continue; }
        if (bad && bad.transient && attempts < 2 && !(signal && signal.aborted)) continue;
        if (bad) {
          if (bad.state === 'signed_out') remembered = { state: 'signed_out', until: now() + 5 * 60000, message: bad.message };
          if (bad.state === 'limited') remembered = { state: 'limited', until: bad.resetAt || now() + 30 * 60000, message: bad.message };
          log('image-judge', { judge: 'claude-code', error: bad.error, attempts, ms: now() - t0 });
          return { ok: false, error: bad.error, message: bad.message, unavailable: bad.state === 'signed_out' || bad.state === 'limited' };
        }
        remembered = null;
        return { ok: true, text: String(res.structured_output ? JSON.stringify(res.structured_output) : res.result || ''), seconds: Math.round((now() - t0) / 100) / 10, attempts, model: res.model || undefined };
      }
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
    }
  }
  return { id: 'claude-code', label: 'Claude Code (on this PC)', available, ask, forget: () => { remembered = null; } };
}

module.exports = { createClaudeCodeJudge, findCli, candidates, childEnv, command, parseOutput, classify, parseReset, DENY, ARGV_PROMPT };
