'use strict';
// ai-lockers.js — each web AI's own private folder ("locker"), and the ONLY
// place its [TO: TERMINAL] commands can touch.
//
//   <stuff and thing>/ai-lockers/
//       chatgpt/   claude/   gemini/
//          inbox/from-<ai>/   <- files another AI sent it
//          README.txt         <- the command list, so it can always re-read it
//
// Every AI gets its own shell process that starts in its locker. Before ANY
// command reaches that shell it goes through checkCommand():
//   - only file-type commands are allowed (dir, type, copy, move, del, md, echo,
//     find, …) — nothing that can launch programs, change the system, or reach
//     the network;
//   - every argument that could be a path must resolve INSIDE that AI's locker
//     (no drive letters, no \\server, no absolute paths, no %VARS%, no climbing
//     out with ..);
//   - pipes/&&/redirects are allowed, but every piece is checked the same way.
// Inside its locker an AI can do what it likes without asking you.
//
// Scripts are the one exception that ASKS: `python x.py` / `node x.js` from the
// locker runs code, and code can reach anywhere on the PC, so main.js routes
// those through the approval strip.
//
// App-handled commands (not cmd.exe — the app does them, still locker-only):
//   write <file>   — rest of the code block becomes the file (multi-line safe)
//   append <file>  — rest of the code block is added to the end
//   give <file>    — the app puts the file into this AI's chat (pasted if it's
//                    small text, uploaded as a real attachment otherwise)
//   send <file> to <ai> — copies it into that AI's inbox/from-<you>/ and tells it
//   help           — the command list
//
// Electron-free: main.js injects the terminal factory + the chat side-effects.
const fs = require('fs');
const path = require('path');
const terminalProvider = require('./terminal-provider');

const SITES_DEFAULT = ['chatgpt', 'claude', 'gemini'];
const LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };

// File-only commands. cmd.exe set for Windows, a posix set so the same rules
// work (and are tested) on mac/linux.
const ALLOWED = {
  cmd: new Set(['dir', 'type', 'copy', 'xcopy', 'move', 'ren', 'rename', 'del', 'erase', 'md', 'mkdir', 'rd', 'rmdir',
    'echo', 'find', 'findstr', 'more', 'sort', 'tree', 'fc', 'comp', 'cd', 'chdir', 'cls', 'attrib']),
  posix: new Set(['ls', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'echo', 'grep', 'head', 'tail', 'wc', 'sort', 'pwd',
    'cd', 'touch', 'diff', 'tree', 'clear']),
};
const SCRIPT_RUNNERS = new Set(['python', 'python3', 'py', 'node']);
const BUILTINS = new Set(['write', 'append', 'give', 'send', 'share', 'help']);
// Commands that only LOOK at files — these may read a locker another AI has
// shared with you (one request only). Copy may read from it into your own.
const READ_CMDS = new Set(['dir', 'type', 'find', 'findstr', 'more', 'sort', 'tree', 'fc', 'comp',
  'ls', 'cat', 'grep', 'head', 'tail', 'wc', 'diff']);
const COPY_CMDS = new Set(['copy', 'xcopy', 'cp']);
const GRANT_TTL_MS = 10 * 60 * 1000;
const DEVICE_NAMES = /^(con|prn|aux|com\d|lpt\d)(\..*)?$/i;

const HELP_TEXT = [
  'Your locker is your own private folder on the user\'s PC. Everything you run here stays inside it.',
  'Put commands in a ``` code block after [TO: TERMINAL], one per line. Paths are relative to your locker.',
  '',
  'File commands (Windows cmd): dir, type, copy, xcopy, move, ren, del, md, rd, echo, find, findstr, more, sort, tree, fc, cd',
  '  Pipes and redirects work inside your locker: e.g.  dir /b | sort > list.txt',
  '',
  'App commands:',
  '  write <file>        the REST of that code block becomes the file (any length, multi-line)',
  '  append <file>       the rest of that code block is added to the end of the file',
  '  give <file>         the app puts the file into this chat (pasted, or uploaded if big/binary)',
  '  send <file> to <ai> copies it into that AI\'s inbox\\from-<you>\\ and tells them (chatgpt / claude / gemini)',
  '  share with <ai>     lets that AI LOOK at your locker (read + copy out, never change) for its NEXT terminal request only',
  '',
  'When another AI shares with you: its files are at ..\\<ai>\\ (e.g. dir ..\\claude, type ..\\claude\\plan.md,',
  '  copy ..\\claude\\plan.md mine.md, give ..\\claude\\pic.png) — for your next [TO: TERMINAL] message only.',
  '  help                this list',
  '',
  'Scripts (python x.py / node x.js) are allowed but the user must approve each run.',
  'Not allowed: anything outside your locker, drive letters, %VARIABLES%, programs, installs, network.',
].join('\n');

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Turn an AI's [TO: TERMINAL] body into ops. Code blocks are the unit:
//  - a block whose FIRST line is `write <file>` / `append <file>` is ONE op whose
//    content is the rest of the block, verbatim;
//  - any other block: each non-empty, non-comment line is a command.
// No code block at all -> fall back to terminalProvider.extractCommands (bare
// lines / $-prefixed lines).
function parseRequest(body, maxOps = 20) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const ops = [];
  const fence = /```[^\n`]*\n([\s\S]*?)```/g;
  let m; let sawFence = false;
  while ((m = fence.exec(text)) && ops.length < maxOps) {
    sawFence = true;
    const lines = m[1].replace(/\n$/, '').split('\n');
    const first = (lines[0] || '').trim();
    const wm = /^(write|append)\s+(.+)$/i.exec(first);
    if (wm) {
      ops.push({ type: wm[1].toLowerCase(), file: unquote(wm[2].trim()), content: lines.slice(1).join('\n') });
      continue;
    }
    for (const raw of lines) {
      const l = raw.trim();
      if (!l || /^(rem\b|::|#(?!!))/i.test(l)) continue;
      ops.push({ type: 'cmd', command: l });
      if (ops.length >= maxOps) break;
    }
  }
  if (!sawFence) for (const c of terminalProvider.extractCommands(text, maxOps)) ops.push({ type: 'cmd', command: c });
  return ops;
}

function unquote(s) {
  const t = String(s || '').trim();
  return /^".*"$/.test(t) || /^'.*'$/.test(t) ? t.slice(1, -1) : t;
}

// Split one command line into segments on unquoted && || & | and pull out
// redirect targets. Returns { segments:[ [tokens…] ], redirects:[target…], error? }.
function lex(line) {
  const s = String(line || '');
  const segments = [[]];
  const redirects = [];
  let cur = ''; let inQ = false; let pendingRedirect = false;
  const pushTok = () => {
    if (!cur) return;
    if (pendingRedirect) { redirects.push(cur); pendingRedirect = false; }
    else segments[segments.length - 1].push(cur);
    cur = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { inQ = !inQ; cur += c; continue; }
    if (inQ) { cur += c; continue; }
    if (c === ' ' || c === '\t') { pushTok(); continue; }
    if (c === '&' || c === '|' || c === ';') {
      // 2>&1 / >&2 style: a & right after > is a handle duplication, not a separator
      if (c === '&' && pendingRedirect && /^\d$/.test(s[i + 1] || '')) { i++; pendingRedirect = false; continue; }
      pushTok();
      if ((c === '&' || c === '|') && s[i + 1] === c) i++;
      segments.push([]);
      continue;
    }
    if (c === '>' || c === '<') {
      // a leading stream number (2>) belongs to the redirect, not the args
      if (/^\d$/.test(cur)) cur = '';
      pushTok();
      if (s[i + 1] === '>') i++;
      pendingRedirect = true;
      continue;
    }
    cur += c;
  }
  if (inQ) return { segments, redirects, error: 'unbalanced quotes' };
  pushTok();
  if (pendingRedirect) return { segments, redirects, error: 'a redirect (>) with no file after it' };
  return { segments: segments.filter((seg) => seg.length), redirects };
}

// ---------------------------------------------------------------------------
// The lockers
// ---------------------------------------------------------------------------
//
// createLockers({ root, sites, platform, createTerminal, onData, onState, onLog })
function createLockers(opts = {}) {
  const platform = opts.platform || process.platform;
  const pathLib = platform === 'win32' ? path.win32 : path.posix;
  const shellKind = platform === 'win32' ? 'cmd' : 'posix';
  const sites = Array.isArray(opts.sites) && opts.sites.length ? opts.sites : SITES_DEFAULT;
  const root = opts.root ? pathLib.resolve(opts.root) : '';
  const makeTerminal = typeof opts.createTerminal === 'function' ? opts.createTerminal : terminalProvider.createTerminal;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const onData = typeof opts.onData === 'function' ? opts.onData : () => {};
  const onState = typeof opts.onState === 'function' ? opts.onState : () => {};
  const maxPasteChars = Number(opts.maxPasteChars) || 12000;
  const terminals = {};
  const cwd = {}; // tracked current folder per site (always inside its locker)
  const grants = new Map(); // grantee -> Map(granter -> expiresAt)
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  const label = (s) => LABELS[s] || s;
  const dirFor = (site) => pathLib.join(root, site);
  const same = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  function inside(site, abs) { return insideDir(dirFor(site), abs); }
  function insideDir(base, abs) {
    const rel = pathLib.relative(base, abs);
    if (rel === '') return true;
    if (rel.startsWith('..') || pathLib.isAbsolute(rel)) return false;
    return same(pathLib.resolve(base, rel), pathLib.resolve(abs));
  }
  function rel(site, abs) { return pathLib.relative(dirFor(site), abs) || '.'; }

  function ensure() {
    if (!root) return { ok: false, error: 'NO_ROOT' };
    try {
      for (const s of sites) {
        fs.mkdirSync(pathLib.join(dirFor(s), 'inbox'), { recursive: true });
        const readme = pathLib.join(dirFor(s), 'README.txt');
        fs.writeFileSync(readme, `${label(s)}'s locker\n\n${HELP_TEXT}\n`);
        if (!cwd[s]) cwd[s] = dirFor(s);
      }
      return { ok: true, root };
    } catch (e) {
      onLog('locker-init-error', { error: String((e && e.message) || e) });
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // Resolve a path-ish token against the site's current folder and confirm it
  // stays in the locker. Returns { ok, abs } or { ok:false, reason }.
  // `shared`: also accept a path inside a locker another AI has shared with
  // this one (read-only uses only — callers decide). Result carries sharedFrom.
  function resolveInside(site, token, shared = false) {
    const t = unquote(token);
    if (!t) return { ok: false, reason: 'empty path' };
    if (/[%!^`$]/.test(t)) return { ok: false, reason: `"${t}" uses variables/special characters (% ! ^ \` $), which aren't allowed` };
    if (/^[a-z]:/i.test(t)) return { ok: false, reason: `"${t}" names a drive — use paths relative to your locker` };
    if (/^[\\/]{2}/.test(t)) return { ok: false, reason: `"${t}" is a network path` };
    if (/^[\\/]/.test(t)) return { ok: false, reason: `"${t}" is an absolute path — use paths relative to your locker` };
    if (shellKind === 'posix' && /^~/.test(t)) return { ok: false, reason: `"${t}" points at the home folder` };
    const base = pathLib.basename(t.replace(/[\\/]+$/, ''));
    if (DEVICE_NAMES.test(base)) return { ok: false, reason: `"${t}" is a device name` };
    const abs = pathLib.resolve(cwd[site] || dirFor(site), t);
    if (inside(site, abs)) return { ok: true, abs };
    const open = grantsFor(site);
    for (const g of open) {
      if (insideDir(dirFor(g), abs)) {
        if (shared) return { ok: true, abs, sharedFrom: g };
        return { ok: false, reason: `"${t}" is in ${label(g)}'s shared locker — you can only LOOK at it (dir/type/find/give) or copy from it into your own` };
      }
    }
    return { ok: false, reason: `"${t}" is outside your locker` };
  }
  const isSwitch = (t) => (shellKind === 'cmd' ? /^\/[a-z0-9?:\-]{1,12}$/i.test(t) : /^-{1,2}[a-z0-9-]+$/i.test(t));

  // Is this cmd line allowed in the site's locker? (pure check — runs nothing)
  // -> { ok:true, kind:'shell'|'script', newCwd? } | { ok:false, reason }
  function checkCommand(site, line) {
    if (!sites.includes(site)) return { ok: false, reason: 'unknown AI' };
    const lx = lex(line);
    if (lx.error) return { ok: false, reason: lx.error };
    if (!lx.segments.length) return { ok: false, reason: 'empty command' };
    let kind = 'shell'; let newCwd;
    for (const target of lx.redirects) {
      if (target === 'nul' || target === '/dev/null') continue;
      const r = resolveInside(site, target);
      if (!r.ok) return { ok: false, reason: `redirect target ${r.reason}` };
    }
    for (const seg of lx.segments) {
      const cmd = unquote(seg[0]).toLowerCase().replace(/\.exe$/, '');
      const args = seg.slice(1);
      if (SCRIPT_RUNNERS.has(cmd)) {
        if (lx.segments.length > 1) return { ok: false, reason: 'scripts must run on their own (no pipes / && with them)' };
        const script = args.find((a) => !isSwitch(a) && !/^-/.test(a));
        if (!script || args.some((a) => /^-/.test(a) && args.indexOf(a) < args.indexOf(script))) {
          return { ok: false, reason: `"${cmd}" can only run a script file from your locker (e.g. ${cmd} tools\\clean.py) — no -c/-e/-m` };
        }
        const r = resolveInside(site, script);
        if (!r.ok) return { ok: false, reason: r.reason };
        if (!fs.existsSync(r.abs)) return { ok: false, reason: `script "${script}" doesn't exist in your locker` };
        kind = 'script';
        continue;
      }
      if (!ALLOWED[shellKind].has(cmd)) {
        return { ok: false, reason: `"${cmd}" isn't allowed in your locker. Allowed: ${Array.from(ALLOWED[shellKind]).join(', ')} (+ write/append/give/send/help)` };
      }
      // echo's words are text, not paths — but still no variables / drive refs.
      const pathArgs = cmd === 'echo' ? [] : args.filter((a) => !isSwitch(a));
      if (cmd === 'echo' && args.some((a) => /[%!^`$]/.test(a))) return { ok: false, reason: 'echo text can\'t contain % ! ^ ` $ (variables)' };
      if ((cmd === 'find' || cmd === 'findstr' || cmd === 'grep') && pathArgs.length) {
        // first non-switch arg is the search pattern, not a path
        const [pattern, ...files] = pathArgs;
        if (/[%!^`$]/.test(pattern)) return { ok: false, reason: 'search text can\'t contain % ! ^ ` $' };
        for (const f of files) { const r = resolveInside(site, f, true); if (!r.ok) return { ok: false, reason: r.reason }; }
      } else if (COPY_CMDS.has(cmd) && pathArgs.length >= 2) {
        // sources may come from a shared locker; the destination must be yours
        const dest = pathArgs[pathArgs.length - 1];
        for (const a of pathArgs.slice(0, -1)) { const r = resolveInside(site, a, true); if (!r.ok) return { ok: false, reason: r.reason }; }
        const rd = resolveInside(site, dest, false); if (!rd.ok) return { ok: false, reason: rd.reason };
      } else {
        const canRead = READ_CMDS.has(cmd) || COPY_CMDS.has(cmd); // copy with one arg copies INTO the current (own) folder
        for (const a of pathArgs) { const r = resolveInside(site, a, canRead); if (!r.ok) return { ok: false, reason: r.reason }; }
      }
      if ((cmd === 'cd' || cmd === 'chdir') && (lx.segments.length > 1 || lx.redirects.length)) {
        return { ok: false, reason: 'put cd on its own line (no && / | / > with it)' };
      }
      if (cmd === 'cd' || cmd === 'chdir') {
        const target = pathArgs[0];
        newCwd = target ? resolveInside(site, target, false).abs : undefined;
      }
    }
    return { ok: true, kind, newCwd };
  }

  function terminalFor(site) {
    if (terminals[site]) return terminals[site];
    terminals[site] = makeTerminal({
      cwd: dirFor(site),
      platform,
      onData: (chunk, stream) => onData(chunk, stream, site),
      onState: () => onState(site),
      onLog,
    });
    return terminals[site];
  }

  // Check an op without running it. -> { ok, needsApproval, reason }
  function checkOp(site, op) {
    if (!op) return { ok: false, reason: 'empty' };
    if (op.type === 'write' || op.type === 'append') {
      const r = resolveInside(site, op.file);
      return r.ok ? { ok: true, needsApproval: false } : { ok: false, reason: r.reason };
    }
    const first = String(op.command || '').trim().split(/\s+/)[0].toLowerCase();
    if (BUILTINS.has(first)) return checkBuiltin(site, op.command);
    const c = checkCommand(site, op.command);
    return c.ok ? { ok: true, needsApproval: c.kind === 'script' } : { ok: false, reason: c.reason };
  }
  function parseBuiltin(line) {
    const m = /^(\w+)\s*(.*)$/.exec(String(line || '').trim());
    const name = m ? m[1].toLowerCase() : '';
    const rest = m ? m[2].trim() : '';
    if (name === 'send') {
      const sm = /^("[^"]+"|\S+)\s+(?:to\s+)?(\w+)$/i.exec(rest);
      return sm ? { name, file: unquote(sm[1]), to: sm[2].toLowerCase() } : { name, error: 'use: send <file> to <chatgpt|claude|gemini>' };
    }
    if (name === 'give') return rest ? { name, file: unquote(rest) } : { name, error: 'use: give <file>' };
    if (name === 'share') {
      const sm = /^(?:with\s+)?(\w+)$/i.exec(rest);
      return sm ? { name, to: sm[1].toLowerCase() } : { name, error: 'use: share with <chatgpt|claude|gemini>' };
    }
    return { name };
  }
  function checkBuiltin(site, line) {
    const b = parseBuiltin(line);
    if (b.error) return { ok: false, reason: b.error };
    if (b.name === 'help') return { ok: true, needsApproval: false };
    if (b.name === 'write' || b.name === 'append') return { ok: false, reason: `${b.name} must be the FIRST line of its own code block; the rest of the block is the content` };
    if (b.name === 'share') {
      if (!sites.includes(b.to)) return { ok: false, reason: `"${b.to}" isn't one of: ${sites.join(', ')}` };
      if (b.to === site) return { ok: false, reason: 'that\'s you — you already have your own locker' };
      return { ok: true, needsApproval: false };
    }
    const r = resolveInside(site, b.file, b.name === 'give'); // give may read a shared locker; send only your own
    if (!r.ok) return { ok: false, reason: r.reason };
    if (b.name === 'send') {
      if (!sites.includes(b.to)) return { ok: false, reason: `"${b.to}" isn't one of: ${sites.join(', ')}` };
      if (b.to === site) return { ok: false, reason: 'that\'s you — no need to send it to yourself' };
    }
    return { ok: true, needsApproval: false };
  }

  // Run one op. ctx: { sendFile(fromSite, toSite, absPath, relInRecipient), giveFile(site, absPath, rel) }
  // Always resolves { ok, command, output, exitCode?, error?, durationMs? } — never throws.
  async function runOp(site, op, ctx = {}) {
    const t0 = Date.now();
    const done = (o) => ({ durationMs: Date.now() - t0, exitCode: o.ok ? 0 : (o.exitCode == null ? null : o.exitCode), ...o });
    try {
      if (op.type === 'write' || op.type === 'append') {
        const r = resolveInside(site, op.file);
        const command = `${op.type} ${op.file}`;
        if (!r.ok) return done({ ok: false, command, error: 'NOT_ALLOWED', output: r.reason });
        fs.mkdirSync(pathLib.dirname(r.abs), { recursive: true });
        const content = String(op.content == null ? '' : op.content);
        if (op.type === 'write') fs.writeFileSync(r.abs, content.endsWith('\n') || !content ? content : content + '\n');
        else fs.appendFileSync(r.abs, content.endsWith('\n') || !content ? content : content + '\n');
        const size = fs.statSync(r.abs).size;
        onData(`[${label(site)} ${op.type === 'write' ? 'wrote' : 'appended to'} ${rel(site, r.abs)} — ${size} bytes]\n`, 'system', site);
        onLog('locker-write', { site, op: op.type, file: rel(site, r.abs), bytes: size });
        return done({ ok: true, command, output: `${op.type === 'write' ? 'Saved' : 'Appended to'} ${rel(site, r.abs)} (${size} bytes total).` });
      }
      const line = String(op.command || '').trim();
      const first = line.split(/\s+/)[0].toLowerCase();
      if (BUILTINS.has(first)) return done(await runBuiltin(site, line, ctx));
      const c = checkCommand(site, line);
      if (!c.ok) return done({ ok: false, command: line, error: 'NOT_ALLOWED', output: c.reason });
      const r = await terminalFor(site).run(line, { source: label(site) });
      if (r.ok && c.newCwd) cwd[site] = c.newCwd;
      return { ...r, command: line };
    } catch (e) {
      onLog('locker-op-error', { site, error: String((e && e.message) || e) });
      return done({ ok: false, command: op.command || `${op.type} ${op.file}`, error: 'ERROR', output: String((e && e.message) || e) });
    }
  }

  async function runBuiltin(site, line, ctx) {
    const b = parseBuiltin(line);
    if (b.error) return { ok: false, command: line, error: 'BAD_COMMAND', output: b.error };
    if (b.name === 'help') return { ok: true, command: line, output: HELP_TEXT };
    const chk = checkBuiltin(site, line);
    if (!chk.ok) return { ok: false, command: line, error: 'NOT_ALLOWED', output: chk.reason };
    if (b.name === 'share') {
      grant(site, b.to);
      onData(`[${label(site)} shared its locker with ${label(b.to)} (look-only, next request)]\n`, 'system', site);
      onLog('locker-share', { from: site, to: b.to });
      let note = '';
      if (typeof ctx.notifyShare === 'function') {
        const n = await ctx.notifyShare(site, b.to);
        if (!n || !n.ok) note = ` (telling them failed: ${(n && n.error) || 'error'} — the share is still open)`;
      }
      return { ok: true, command: line, output: `Shared your locker with ${label(b.to)}: they can look at it and copy from it on their NEXT terminal request (expires in ${Math.round(GRANT_TTL_MS / 60000)} min). They can't change anything in it.${note}` };
    }
    const r = resolveInside(site, b.file, b.name === 'give');
    let st;
    try { st = fs.statSync(r.abs); } catch (_) { return { ok: false, command: line, error: 'NOT_FOUND', output: `No file "${b.file}" in your locker.${listingHint(site)}` }; }
    if (!st.isFile()) return { ok: false, command: line, error: 'NOT_A_FILE', output: `"${b.file}" is a folder, not a file.` };

    if (b.name === 'give') {
      const text = readTextIfSmall(r.abs, st.size);
      if (text != null) {
        onLog('locker-give', { site, file: rel(site, r.abs), mode: 'paste', bytes: st.size });
        return { ok: true, command: line, output: `----- ${rel(site, r.abs)} (${st.size} bytes) -----\n${text}\n----- end of file -----`, raw: true };
      }
      if (typeof ctx.giveFile !== 'function') return { ok: false, command: line, error: 'UNAVAILABLE', output: 'Uploading files into the chat isn\'t available right now.' };
      const up = await ctx.giveFile(site, r.abs, rel(site, r.abs));
      onLog('locker-give', { site, file: rel(site, r.abs), mode: 'upload', ok: !!(up && up.ok) });
      return up && up.ok
        ? { ok: true, command: line, output: `Uploaded ${rel(site, r.abs)} (${st.size} bytes) into this chat as an attachment.` }
        : { ok: false, command: line, error: 'UPLOAD_FAILED', output: `Couldn't upload ${rel(site, r.abs)}: ${(up && up.error) || 'error'}` };
    }

    if (b.name === 'send') {
      const destDir = pathLib.join(dirFor(b.to), 'inbox', `from-${site}`);
      fs.mkdirSync(destDir, { recursive: true });
      const dest = uniquePath(destDir, pathLib.basename(r.abs));
      fs.copyFileSync(r.abs, dest);
      const relTo = pathLib.relative(dirFor(b.to), dest);
      onData(`[${label(site)} sent ${rel(site, r.abs)} → ${label(b.to)} (${relTo})]\n`, 'system', site);
      onLog('locker-send', { from: site, to: b.to, file: rel(site, r.abs), bytes: st.size });
      let note = '';
      if (typeof ctx.sendFile === 'function') {
        const n = await ctx.sendFile(site, b.to, dest, relTo);
        if (!n || !n.ok) note = ` (the file is in their inbox, but telling them failed: ${(n && n.error) || 'error'})`;
      }
      return { ok: true, command: line, output: `Sent ${rel(site, r.abs)} to ${label(b.to)} — it's in their locker at ${relTo}.${note}` };
    }
    return { ok: false, command: line, error: 'BAD_COMMAND', output: `Unknown command "${b.name}".` };
  }

  function readTextIfSmall(abs, size) {
    if (size > maxPasteChars * 2) return null;
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { return null; }
    if (buf.includes(0)) return null; // binary
    const text = buf.toString('utf8');
    return text.length <= maxPasteChars ? text.replace(/\n$/, '') : null;
  }
  function uniquePath(dir, name) {
    let p = pathLib.join(dir, name);
    if (!fs.existsSync(p)) return p;
    const ext = pathLib.extname(name); const stem = name.slice(0, name.length - ext.length);
    for (let i = 2; i < 1000; i++) { p = pathLib.join(dir, `${stem} (${i})${ext}`); if (!fs.existsSync(p)) return p; }
    return pathLib.join(dir, `${stem}-${Date.now()}${ext}`);
  }
  function listingHint(site) {
    try {
      const names = fs.readdirSync(cwd[site] || dirFor(site)).slice(0, 30);
      return names.length ? ` Files here: ${names.join(', ')}` : ' Your locker is empty.';
    } catch (_) { return ''; }
  }

  // A recipient's small text file, for pasting into the "you got a file" note.
  function previewFor(abs) {
    try { const st = fs.statSync(abs); return readTextIfSmall(abs, st.size); } catch (_) { return null; }
  }

  // ---- one-request read-only sharing ----
  function grant(from, to) {
    if (!grants.has(to)) grants.set(to, new Map());
    grants.get(to).set(from, now() + GRANT_TTL_MS);
  }
  function grantsFor(site) {
    const m = grants.get(site);
    if (!m) return [];
    const t = now();
    for (const [g, exp] of m) if (exp <= t) m.delete(g);
    return Array.from(m.keys());
  }
  // Called after the grantee's request finishes: the share was for ONE request.
  function consumeGrants(site) {
    const had = grantsFor(site);
    grants.delete(site);
    if (had.length) onLog('locker-share-used', { site, from: had });
    return had;
  }

  // ---- for the user's locker browser (the user may look at any locker) ----
  function listFiles(site, { max = 300, depth = 4 } = {}) {
    if (!sites.includes(site)) return { ok: false, error: 'BAD_SITE' };
    const base = dirFor(site);
    const out = [];
    const walk = (dir, d) => {
      if (d > depth || out.length >= max) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        if (out.length >= max) break;
        const abs = pathLib.join(dir, e.name);
        if (e.isDirectory()) { walk(abs, d + 1); continue; }
        if (!e.isFile()) continue;
        let st; try { st = fs.statSync(abs); } catch (_) { continue; }
        out.push({ rel: pathLib.relative(base, abs), name: e.name, size: st.size, mtime: st.mtimeMs, kind: fileKind(abs, st.size) });
      }
    };
    walk(base, 0);
    out.sort((a, b) => b.mtime - a.mtime);
    return { ok: true, site, dir: base, files: out, truncated: out.length >= max };
  }
  function fileKind(abs, size) {
    const ext = pathLib.extname(abs).toLowerCase();
    if (/^\.(png|jpe?g|gif|webp|bmp|svg)$/.test(ext)) return 'image';
    if (/^\.(pdf|docx?|xlsx?|pptx?|zip|mp3|mp4|wav|mov)$/.test(ext)) return 'document';
    if (size > maxPasteChars * 2) return 'document';
    try {
      const fd = fs.openSync(abs, 'r'); const buf = Buffer.alloc(Math.min(size, 4096));
      fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      return buf.includes(0) ? 'document' : 'text';
    } catch (_) { return 'document'; }
  }
  // Resolve a locker-relative path for the USER (UI). Must stay in that locker.
  function userFile(site, relPath) {
    if (!sites.includes(site)) return { ok: false, error: 'BAD_SITE' };
    const abs = pathLib.resolve(dirFor(site), String(relPath || ''));
    if (!inside(site, abs) || abs === dirFor(site)) return { ok: false, error: 'OUTSIDE_LOCKER' };
    let st; try { st = fs.statSync(abs); } catch (_) { return { ok: false, error: 'NOT_FOUND' }; }
    if (!st.isFile()) return { ok: false, error: 'NOT_A_FILE' };
    const kind = fileKind(abs, st.size);
    return { ok: true, abs, size: st.size, kind, text: kind === 'text' ? readTextIfSmall(abs, st.size) : null };
  }

  function stopAll() {
    for (const s of Object.keys(terminals)) { try { terminals[s].stop(); } catch (_) {} cwd[s] = dirFor(s); }
  }
  function status() {
    const out = {};
    for (const s of sites) out[s] = { dir: dirFor(s), cwd: rel(s, cwd[s] || dirFor(s)), shell: terminals[s] ? terminals[s].status() : { alive: false } };
    return { root, lockers: out };
  }

  return { ensure, dirFor, checkOp, checkCommand, runOp, status, stopAll, previewFor, root: () => root, terminalFor,
    grant, grantsFor, consumeGrants, listFiles, userFile };
}

module.exports = { createLockers, parseRequest, lex, HELP_TEXT, ALLOWED };
