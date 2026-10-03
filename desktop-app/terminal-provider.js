'use strict';
// terminal-provider.js — the Command Prompt connection. One persistent local
// shell session (cmd.exe on Windows, bash/sh elsewhere) that BOTH the user and
// the three web AIs can drive:
//
//   - the user types commands into the Terminal zone of the User Panel;
//   - a web AI addresses it with the [TO: TERMINAL] envelope tag, main.js
//     extracts the command(s) (extractCommands), gates them (classifyCommand +
//     the approval prompt), runs them here, and sends the captured output back
//     to that AI wrapped as [FROM: TERMINAL].
//
// Transport: plain pipes (child_process.spawn), NOT a pseudo-terminal. That's a
// deliberate v1 choice — node-pty needs a native build against Electron, which
// is the most common install failure on Windows. Pipes run every normal command
// (dir, git, npm, python script.py, ...). What they can't do is full-screen TUI
// programs (vim, htop) or a REPL that expects a real console. The backend is
// isolated behind createTerminal() so a PTY backend can be dropped in later
// without touching main.js or the UI.
//
// Command completion: after each command we write a sentinel echo
// (`echo __AIDONE_<id>__%ERRORLEVEL%` / `$?`). When that line comes back on
// stdout, the command is done and we know its exit code. Sentinel lines are
// filtered out of everything the user or an AI ever sees.
//
// This module is Electron-free (spawn is injectable) so it's unit-testable.
const cp = require('child_process');
const os = require('os');

const SENTINEL_PREFIX = '__AIDONE_';
// cmd.exe still prints its prompt ("C:\\path>") between piped commands even
// with /Q. We set PROMPT to an invisible marker instead and strip it (plus the
// blank line cmd prints before every prompt), so output is just the output.
const CMD_PROMPT = '$E[0;0;0m';
const CMD_PROMPT_MARK = '\x1b[0;0;0m';
const SENTINEL_RE = /__AIDONE_(\d+)__(-?\d+)?/;

const DEFAULTS = {
  commandTimeoutMs: 120000,     // a command still running after this is reported as TIMEOUT (shell keeps it)
  maxCommandOutput: 64 * 1024,  // per-command captured output cap (what an AI gets back)
  maxScrollback: 200 * 1024,    // UI scrollback kept in memory for late-joining windows
  maxQueue: 50,                 // commands waiting behind the running one
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function defaultShell(platform) {
  const p = platform || process.platform;
  if (p === 'win32') {
    // /Q = echo off (no prompt, no command echo — keeps output clean),
    // /K = keep running and read commands from stdin.
    return { kind: 'cmd', command: process.env.ComSpec || 'cmd.exe', args: ['/Q', '/K'] };
  }
  const sh = process.env.SHELL && /bash|zsh|sh$/.test(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
  return { kind: 'posix', command: sh, args: [] };
}

function sentinelLine(kind, id) {
  return kind === 'cmd'
    ? `echo ${SENTINEL_PREFIX}${id}__%ERRORLEVEL%`
    : `echo "${SENTINEL_PREFIX}${id}__$?"`;
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// Pull the command(s) out of an AI's [TO: TERMINAL] message body.
//  1. Fenced code blocks win: ```cmd / ```bat / ```shell / ```powershell / ``` …
//  2. Otherwise lines prefixed with "$ " or "> " (the way people write commands).
//  3. Otherwise every non-empty line is a command.
// Blank lines and comment-only lines (REM / :: / #) are dropped. Capped at
// maxCommands so a runaway reply can't queue hundreds of commands.
function extractCommands(body, maxCommands = 10) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  let lines = [];
  const fence = /```[^\n`]*\n([\s\S]*?)```/g;
  let m; let sawFence = false;
  while ((m = fence.exec(text))) { sawFence = true; lines.push(...m[1].split('\n')); }
  if (!sawFence) {
    const all = text.split('\n');
    const prompted = all.filter((l) => /^\s*(\$|>)\s+\S/.test(l));
    lines = prompted.length ? prompted.map((l) => l.replace(/^\s*(\$|>)\s+/, '')) : all;
  }
  const out = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (/^(rem\b|::|#(?!!))/i.test(l)) continue;
    out.push(l);
    if (out.length >= maxCommands) break;
  }
  return out;
}

// Risk gate for AI-originated commands. The user's OWN typed commands are never
// gated — they're the operator. Three levels:
//   blocked   — never run from an AI, even with approval (wipes a drive / the OS)
//   dangerous — always needs the user's click, even when auto-run is on
//   normal    — auto-runs only if the user turned auto-run on; otherwise asks
const BLOCKED_PATTERNS = [
  [/\bformat\s+[a-z]:/i, 'formats a drive'],
  [/\bdiskpart\b/i, 'disk partitioning'],
  [/\b(rd|rmdir)\s+(\/s\s+\/q|\/q\s+\/s)\s+["']?[a-z]:\\?["']?\s*$/i, 'deletes a whole drive'],
  [/\bdel\s+.*\/s.*\s+["']?[a-z]:\\\*?["']?\s*$/i, 'deletes a whole drive'],
  [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(--no-preserve-root\s+)?\/(\s|$)/i, 'deletes the root filesystem'],
  [/\bmkfs(\.\w+)?\b/i, 'formats a filesystem'],
  [/\bdd\s+.*of=\/dev\//i, 'overwrites a raw disk'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
];
const DANGEROUS_PATTERNS = [
  [/\b(del|erase|rd|rmdir|rm|Remove-Item)\b/i, 'deletes files'],
  [/\b(shutdown|restart-computer|stop-computer|logoff)\b/i, 'shuts down / restarts'],
  [/\breg\s+(add|delete|import)\b/i, 'edits the registry'],
  [/\b(bcdedit|takeown|icacls|cacls|attrib)\b/i, 'changes system/file permissions'],
  [/\bnet\s+(user|localgroup)\b/i, 'changes user accounts'],
  [/\bSet-ExecutionPolicy\b/i, 'changes script policy'],
  [/\b(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b.*\|\s*(iex|Invoke-Expression|sh|bash|cmd)\b/i, 'downloads and runs a script'],
  [/\bgit\s+(push\s+.*(--force|-f)\b|reset\s+--hard|clean\s+-[a-z]*f)/i, 'rewrites/discards git history or files'],
  [/\b(taskkill|kill|pkill|killall|Stop-Process)\b/i, 'kills processes'],
  [/\b(sc|schtasks)\s+(create|delete|config)\b/i, 'changes services / scheduled tasks'],
  [/\bsetx\b/i, 'changes environment variables permanently'],
  [/\b(move|ren|rename|mv)\b/i, 'moves or renames files'],
  [/\d?>{1,2}\s*(?!(nul|\/dev\/null)\b)[^\s>&|]/i, 'writes a file via redirect'],
];
function classifyCommand(command) {
  const c = String(command || '');
  for (const [re, why] of BLOCKED_PATTERNS) if (re.test(c)) return { risk: 'blocked', reason: why };
  for (const [re, why] of DANGEROUS_PATTERNS) if (re.test(c)) return { risk: 'dangerous', reason: why };
  return { risk: 'normal', reason: '' };
}
// The worst risk across a list of commands.
function classifyAll(commands) {
  const order = { normal: 0, dangerous: 1, blocked: 2 };
  let worst = { risk: 'normal', reason: '', command: '' };
  for (const c of commands || []) {
    const r = classifyCommand(c);
    if (order[r.risk] > order[worst.risk]) worst = { ...r, command: c };
  }
  return worst;
}

// Cap a block of output to maxChars, keeping the head and the tail (errors are
// usually at the end), with a clear marker of what was cut.
function capOutput(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  return `${s.slice(0, head)}\n…[${s.length - maxChars} characters cut]…\n${s.slice(-tail)}`;
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------
//
// createTerminal(opts) -> terminal
//   opts.spawn       injectable spawn (tests)
//   opts.platform    'win32' | 'linux' | 'darwin' (default: process.platform)
//   opts.shell       { kind:'cmd'|'posix', command, args } (default: defaultShell)
//   opts.cwd         starting folder (default: home dir)
//   opts.onData      (chunk, stream:'stdout'|'stderr'|'system') — sentinel-free display stream
//   opts.onState     (snapshot) — running/queued/idle changes
//   opts.onLog       (kind, detail) — for main.js's logEvent
//   opts.commandTimeoutMs / maxCommandOutput / maxScrollback / maxQueue
function createTerminal(opts = {}) {
  const spawn = typeof opts.spawn === 'function' ? opts.spawn : cp.spawn;
  const platform = opts.platform || process.platform;
  const shell = opts.shell || defaultShell(platform);
  const cfg = {
    commandTimeoutMs: Number(opts.commandTimeoutMs) || DEFAULTS.commandTimeoutMs,
    maxCommandOutput: Number(opts.maxCommandOutput) || DEFAULTS.maxCommandOutput,
    maxScrollback: Number(opts.maxScrollback) || DEFAULTS.maxScrollback,
    maxQueue: Number(opts.maxQueue) || DEFAULTS.maxQueue,
  };
  const onData = typeof opts.onData === 'function' ? opts.onData : () => {};
  const onState = typeof opts.onState === 'function' ? opts.onState : () => {};
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const startCwd = opts.cwd || os.homedir();

  let child = null;
  let nextId = 1;
  let current = null;       // { id, command, source, output, startedAt, resolve, timer }
  const queue = [];         // pending { id, command, source, resolve }
  let stdoutPartial = '';
  let scrollback = '';
  let starting = false;

  const safe = (fn, ...a) => { try { fn(...a); } catch (_) { /* a listener must never break the session */ } };

  function snapshot() {
    return {
      alive: !!child,
      shell: shell.kind,
      pid: child ? child.pid : null,
      running: current ? { id: current.id, command: current.command, source: current.source, startedAt: current.startedAt } : null,
      queued: queue.map((q) => ({ id: q.id, command: q.command, source: q.source })),
    };
  }
  const emitState = () => safe(onState, snapshot());

  function display(chunk, stream) {
    if (!chunk) return;
    scrollback += chunk;
    if (scrollback.length > cfg.maxScrollback) scrollback = scrollback.slice(-cfg.maxScrollback);
    if (current && stream !== 'system') {
      current.output += chunk;
      if (current.output.length > cfg.maxCommandOutput * 2) current.output = current.output.slice(-cfg.maxCommandOutput * 2);
    }
    safe(onData, chunk, stream);
  }

  // stdout: line-buffered so the sentinel is detected even across chunk
  // boundaries. A partial line is shown immediately UNLESS it could be the start
  // of a sentinel (then it waits for the rest of the line).
  // stdout is line-buffered so the sentinel is found even across chunks. For
  // cmd.exe we also drop its (invisible) prompt and the blank line it prints
  // just before every prompt: blank lines are held back until we see whether
  // the next line starts with the prompt marker.
  let pendingBlanks = 0;
  function flushBlanks() { while (pendingBlanks > 0) { display('\n', 'stdout'); pendingBlanks--; } }
  function handleLine(raw) {
    let line = raw;
    if (shell.kind === 'cmd') {
      const promptHere = line.startsWith(CMD_PROMPT_MARK);
      if (promptHere) pendingBlanks = 0; // those blank lines were cmd's pre-prompt spacing
      line = line.split(CMD_PROMPT_MARK).join('');
      if (promptHere && !line) return;   // a bare prompt line
      if (!line) { pendingBlanks++; return; }
    }
    line = stripAnsi(line);
    const m = SENTINEL_RE.exec(line);
    if (m) {
      pendingBlanks = 0;
      const before = line.slice(0, m.index);
      if (before.trim()) display(before + '\n', 'stdout');
      finishCurrent(Number(m[1]), m[2] == null ? null : Number(m[2]));
      return;
    }
    flushBlanks();
    display(line + '\n', 'stdout');
  }
  function handleStdout(data) {
    stdoutPartial += String(data).replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '');
    let nl;
    while ((nl = stdoutPartial.indexOf('\n')) >= 0) {
      const raw = stdoutPartial.slice(0, nl);
      stdoutPartial = stdoutPartial.slice(nl + 1);
      handleLine(raw);
    }
    // A partial line (e.g. "Continue? (y/n)") is shown right away — unless it
    // could still turn into a prompt marker or a sentinel.
    if (stdoutPartial) {
      const visible = shell.kind === 'cmd' ? stdoutPartial.split(CMD_PROMPT_MARK).join('') : stdoutPartial;
      if (visible && !visible.includes('\x1b') && !stdoutPartial.endsWith('\x1b') && !/\x1b\[[0-9;]*$/.test(stdoutPartial) && !mightBeSentinel(visible)) {
        if (shell.kind === 'cmd' && stdoutPartial.startsWith(CMD_PROMPT_MARK)) pendingBlanks = 0;
        flushBlanks();
        display(stripAnsi(visible), 'stdout');
        stdoutPartial = '';
      }
    }
  }
  function mightBeSentinel(partial) {
    const t = partial.trimStart();
    return t.includes(SENTINEL_PREFIX) || SENTINEL_PREFIX.startsWith(t.slice(0, SENTINEL_PREFIX.length));
  }
  function handleStderr(data) {
    display(stripAnsi(String(data)).replace(/\r\n/g, '\n'), 'stderr');
  }

  function finishCurrent(id, exitCode, error) {
    if (!current || current.id !== id) return; // stale sentinel (e.g. after a restart)
    const done = current;
    current = null;
    clearTimeout(done.timer);
    const result = {
      ok: !error && exitCode === 0,
      id: done.id,
      command: done.command,
      source: done.source,
      exitCode: exitCode == null ? null : exitCode,
      output: capOutput(done.output.replace(/^\n+/, '').replace(/\n+$/, ''), cfg.maxCommandOutput),
      durationMs: Date.now() - done.startedAt,
      error: error || (exitCode === 0 ? undefined : 'NONZERO_EXIT'),
    };
    safe(onLog, 'terminal-command-done', { id: done.id, source: done.source, exitCode: result.exitCode, ms: result.durationMs, error: error || null });
    safe(done.resolve, result);
    emitState();
    pump();
  }

  function shellEnv() {
    const env = Object.assign({}, process.env, { PYTHONUNBUFFERED: '1', NO_COLOR: '1' });
    if (shell.kind === 'cmd') {
      for (const k of Object.keys(env)) if (/^prompt$/i.test(k)) delete env[k]; // Windows env keys are case-insensitive
      env.PROMPT = CMD_PROMPT;
    }
    return env;
  }
  function start() {
    if (child || starting) return { ok: true, already: true, pid: child ? child.pid : null };
    starting = true;
    let c;
    try {
      c = spawn(shell.command, shell.args, {
        cwd: startCwd,
        env: shellEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: platform !== 'win32', // own process group so stop() can kill the whole tree on posix
      });
    } catch (e) {
      starting = false;
      const error = String((e && e.message) || e);
      safe(onLog, 'terminal-start-error', { error });
      return { ok: false, error };
    }
    starting = false;
    child = c;
    stdoutPartial = '';
    if (c.stdout) c.stdout.on('data', handleStdout);
    if (c.stderr) c.stderr.on('data', handleStderr);
    if (c.stdin) c.stdin.on('error', (e) => safe(onLog, 'terminal-stdin-error', { error: String((e && e.message) || e) }));
    c.on('error', (e) => {
      safe(onLog, 'terminal-error', { error: String((e && e.message) || e) });
      handleExit(c, null);
    });
    c.on('exit', (code) => handleExit(c, code));
    if (shell.kind === 'cmd') writeRaw(`prompt ${CMD_PROMPT}\r\nchcp 65001>nul\r\n`); // invisible prompt + UTF-8 output
    display(`[terminal started: ${shell.command} in ${startCwd}]\n`, 'system');
    safe(onLog, 'terminal-started', { shell: shell.kind, pid: c.pid, cwd: startCwd });
    emitState();
    pump();
    return { ok: true, pid: c.pid };
  }

  function handleExit(c, code) {
    if (child !== c) return;
    child = null;
    display(`[terminal exited${code == null ? '' : ` (${code})`}]\n`, 'system');
    safe(onLog, 'terminal-exited', { code });
    if (current) finishCurrent(current.id, null, 'SHELL_EXITED');
    // Anything still queued fails rather than hanging forever.
    while (queue.length) { const q = queue.shift(); safe(q.resolve, { ok: false, id: q.id, command: q.command, source: q.source, error: 'SHELL_EXITED', output: '' }); }
    emitState();
  }

  function writeRaw(text) {
    if (!child || !child.stdin || child.stdin.destroyed) return false;
    try { child.stdin.write(text); return true; } catch (e) { safe(onLog, 'terminal-write-error', { error: String(e) }); return false; }
  }
  const eol = () => (shell.kind === 'cmd' ? '\r\n' : '\n');

  function pump() {
    if (current || !queue.length || !child) return;
    const next = queue.shift();
    current = { ...next, output: '', startedAt: Date.now(), timer: null };
    current.timer = setTimeout(() => {
      if (current && current.id === next.id) {
        display(`[still running after ${Math.round(cfg.commandTimeoutMs / 1000)}s — use ■ Stop to end it]\n`, 'system');
        finishCurrent(next.id, null, 'TIMEOUT');
      }
    }, cfg.commandTimeoutMs);
    display(`${shell.kind === 'cmd' ? '>' : '$'} ${next.command}${next.source && next.source !== 'user' ? `   [from ${next.source}]` : ''}\n`, 'system');
    safe(onLog, 'terminal-command', { id: next.id, source: next.source, command: next.command.slice(0, 300) });
    emitState();
    const ok = writeRaw(next.command + eol() + sentinelLine(shell.kind, next.id) + eol());
    if (!ok) finishCurrent(next.id, null, 'WRITE_FAILED');
  }

  // Queue a command. Resolves when it finishes (or fails/times out) with
  // { ok, id, command, source, exitCode, output, durationMs, error? }.
  function run(command, { source = 'user' } = {}) {
    const cmd = String(command == null ? '' : command).replace(/[\r\n]+/g, ' ').trim();
    if (!cmd) return Promise.resolve({ ok: false, error: 'EMPTY_COMMAND', output: '' });
    if (queue.length >= cfg.maxQueue) return Promise.resolve({ ok: false, error: 'QUEUE_FULL', command: cmd, output: '' });
    if (!child) {
      const s = start();
      if (!s.ok) return Promise.resolve({ ok: false, error: 'START_FAILED', detail: s.error, command: cmd, output: '' });
    }
    return new Promise((resolve) => {
      queue.push({ id: nextId++, command: cmd, source: String(source || 'user'), resolve });
      emitState();
      pump();
    });
  }

  // Raw keystrokes into whatever is running right now (answering a y/n prompt).
  function sendInput(text) {
    if (!child) return { ok: false, error: 'NOT_RUNNING' };
    const t = String(text == null ? '' : text);
    display(t + '\n', 'system');
    return writeRaw(t + eol()) ? { ok: true } : { ok: false, error: 'WRITE_FAILED' };
  }

  // Kill the whole process tree (pipes have no Ctrl+C), fail the running and
  // queued commands, then start a fresh shell. This is the ■ Stop button.
  function killTree(c) {
    if (!c || !c.pid) return;
    try {
      if (platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      else process.kill(-c.pid, 'SIGKILL');
    } catch (_) { try { c.kill('SIGKILL'); } catch (_) {} }
  }
  function stop({ restart = false } = {}) {
    const c = child;
    if (current) finishCurrent(current.id, null, 'STOPPED');
    while (queue.length) { const q = queue.shift(); safe(q.resolve, { ok: false, id: q.id, command: q.command, source: q.source, error: 'STOPPED', output: '' }); }
    child = null;
    if (c) { killTree(c); safe(onLog, 'terminal-stopped', { pid: c.pid, restart }); display('[terminal stopped]\n', 'system'); }
    emitState();
    if (restart) return start();
    return { ok: true, stopped: !!c };
  }

  function clearScrollback() { scrollback = ''; return { ok: true }; }

  return {
    start, stop, run, sendInput, clearScrollback,
    status: snapshot,
    scrollback: () => scrollback,
    shellKind: () => shell.kind,
  };
}

module.exports = {
  createTerminal, extractCommands, classifyCommand, classifyAll, capOutput, stripAnsi,
  defaultShell, sentinelLine, SENTINEL_PREFIX,
};
