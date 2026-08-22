'use strict';
/*
 * atelier-bridge.js — the seam between AutoInjector and the ATELIER governance
 * toolkit (vendored under ./atelier as a self-contained Python package).
 *
 * AutoInjector routes raw replies between the ChatGPT / Claude / Gemini web
 * UIs. It has no notion of *authority* (who may write what), *provenance* (who
 * authored an artifact), or an ordered, refusable lifecycle. ATELIER has all
 * three, proven by its own regression suites. This module lets the Electron
 * main process call those controls without embedding a Python interpreter: it
 * shells out to the `autoinjector.py` adapter and `authority.py` gate and maps
 * their documented exit codes (0 permitted · 1 refused/held · 3 bad call) into
 * plain JS results.
 *
 * Everything here degrades gracefully. If Python 3 is not installed, or the
 * vendored package is missing, `detect()` reports unavailable and the caller
 * behaves exactly as it did before governance existed — the feature is opt-in
 * and never blocks the normal roundtable path.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ATELIER_DIR = path.join(__dirname, 'atelier');
const ADAPTER = 'autoinjector.py';
const AUTHORITY = 'authority.py';
const SCAFFOLD = 'init_project.py';
const ASSEMBLE = 'assemble_manuscript.py';
const DEFAULT_TIMEOUT_MS = 20000;

// The three web-UI AIs AutoInjector drives map onto ATELIER's write-authority
// roles. Anything sent by the operator maps to the all-powerful `human` role.
const ROLE_MAP = {
  chatgpt: 'chatgpt',
  claude: 'claude',
  gemini: 'gemini',
  human: 'human',
  user: 'human',
  operator: 'human',
};

let _cache = null;

function _pythonCandidates() {
  // An explicit override is authoritative: if the user set ATELIER_PYTHON, use
  // exactly that and nothing else, so a wrong override surfaces as unavailable
  // rather than silently falling back to some other interpreter.
  const env = process.env.ATELIER_PYTHON;
  if (env) return [env];
  return process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
}

function _run(python, args, opts) {
  return execFileSync(python, args, {
    cwd: ATELIER_DIR,
    timeout: (opts && opts.timeout) || DEFAULT_TIMEOUT_MS,
    encoding: 'utf8',
    windowsHide: true,
  });
}

/**
 * Locate a usable Python 3 and confirm the vendored adapter is present.
 * Result is cached; pass { force: true } to re-probe (e.g. after the user
 * installs Python without restarting the app).
 * @returns {{available:boolean, python:(string|null), version:(string|null), dir:string, reason:(string|null)}}
 */
function detect(opts) {
  if (_cache && !(opts && opts.force)) return _cache;

  if (!fs.existsSync(path.join(ATELIER_DIR, ADAPTER))) {
    _cache = { available: false, python: null, version: null, dir: ATELIER_DIR,
      reason: `ATELIER package not found at ${ATELIER_DIR}` };
    return _cache;
  }

  for (const py of _pythonCandidates()) {
    try {
      const out = execFileSync(py, ['--version'], {
        timeout: 5000, encoding: 'utf8', windowsHide: true,
      });
      const version = String(out).trim();
      // ATELIER requires Python 3; reject a stray Python 2.
      if (/^Python\s+3\./.test(version) || /Python\s+3\./.test(version)) {
        _cache = { available: true, python: py, version, dir: ATELIER_DIR, reason: null };
        return _cache;
      }
    } catch (_) { /* try the next candidate */ }
  }

  _cache = { available: false, python: null, version: null, dir: ATELIER_DIR,
    reason: 'Python 3 not found on PATH (set ATELIER_PYTHON to override)' };
  return _cache;
}

/** Normalise an AutoInjector AI id to an ATELIER authority role. */
function roleFor(aiId) {
  if (!aiId) return null;
  return ROLE_MAP[String(aiId).toLowerCase()] || null;
}

/**
 * Authority gate — may this role write this project-relative path?
 * Wraps `authority.py check`. Deny-by-default: an unknown role or an
 * unmatched path is refused. Never throws for a refusal; only an
 * unavailable toolkit yields available:false.
 * @returns {{available:boolean, ok:boolean, reason:string}}
 */
function checkAuthority(role, targetPath) {
  const d = detect();
  if (!d.available) return { available: false, ok: false, reason: d.reason };

  const mapped = roleFor(role) || role;
  try {
    const out = _run(d.python, [AUTHORITY, 'check', '--role', String(mapped), '--path', String(targetPath)]);
    return { available: true, ok: true, reason: String(out).trim() };
  } catch (err) {
    // exit 1 = refused (expected), exit 3 = bad invocation. Both carry a
    // message on stderr; surface it rather than the raw Error.
    const msg = (err && (err.stderr || err.stdout) ? String(err.stderr || err.stdout) : String(err && err.message)).trim();
    return { available: true, ok: false, reason: msg || 'refused' };
  }
}

/** The ordered, non-skippable pipeline stage list, straight from the adapter. */
function stages() {
  const d = detect();
  if (!d.available) return { available: false, stages: [], reason: d.reason };
  try {
    const out = _run(d.python, [ADAPTER, 'stages']);
    return { available: true, stages: String(out).trim().split('->').map(s => s.trim()).filter(Boolean), reason: null };
  } catch (err) {
    return { available: true, stages: [], reason: String(err && err.message) };
  }
}

/**
 * Deliver a reply into a book project through the adapter's
 * CREATE -> ROUTE -> DELIVER path. Writes the content to a temp file first
 * (the adapter reads a --file), runs the adapter, and returns its verdict.
 * @param {{projectDir:string, jobId:string, role:string, content:string,
 *          target?:string, projectId?:string, specVersion?:string}} job
 * @returns {{available:boolean, ok:boolean, message:string}}
 */
function deliver(job) {
  const d = detect();
  if (!d.available) return { available: false, ok: false, message: d.reason };
  if (!job || !job.projectDir || !job.jobId) {
    return { available: true, ok: false, message: 'deliver requires projectDir and jobId' };
  }

  const os = require('os');
  const tmp = path.join(os.tmpdir(), `atelier-${Date.now()}-${Math.floor(Math.random() * 1e6)}.md`);
  fs.writeFileSync(tmp, job.content == null ? '' : String(job.content), 'utf8');

  const args = [ADAPTER, 'deliver', String(job.projectDir),
    '--job-id', String(job.jobId),
    '--file', tmp,
    '--role', String(roleFor(job.role) || job.role || 'human')];
  if (job.target) args.push('--target', String(job.target));
  if (job.projectId) args.push('--project-id', String(job.projectId));
  if (job.specVersion) args.push('--spec-version', String(job.specVersion));

  try {
    const out = _run(d.python, args);
    return { available: true, ok: true, message: String(out).trim() };
  } catch (err) {
    const msg = (err && (err.stderr || err.stdout) ? String(err.stderr || err.stdout) : String(err && err.message)).trim();
    return { available: true, ok: false, message: msg || 'refused' };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
  }
}

/**
 * Scaffold a governed ATELIER project (BG-001). Runs init_project.py, which
 * creates <parentDir>/<slug>/ with the full 00_CONTROL … 07_BUILD tree. Returns
 * the created directory so the caller can make it the canonical book home.
 * @returns {{available:boolean, ok:boolean, dir:(string|null), reason:string}}
 */
function scaffold(title, parentDir, opts) {
  const d = detect();
  if (!d.available) return { available: false, ok: false, dir: null, reason: d.reason };
  if (!title || !parentDir) return { available: true, ok: false, dir: null, reason: 'scaffold requires title and parentDir' };
  const args = [SCAFFOLD, String(title), '--path', String(parentDir), '--chapters', String((opts && opts.chapters) || 1)];
  if (opts && opts.force) args.push('--force');
  try {
    const out = _run(d.python, args);
    const m = /Created\s+(.+)/.exec(String(out));
    const dir = m ? m[1].trim() : null;
    if (!dir || !fs.existsSync(dir)) return { available: true, ok: false, dir: null, reason: 'scaffold produced no directory' };
    return { available: true, ok: true, dir, reason: String(out).trim() };
  } catch (err) {
    const msg = (err && (err.stderr || err.stdout) ? String(err.stderr || err.stdout) : String(err && err.message)).trim();
    return { available: true, ok: false, dir: null, reason: msg || 'scaffold failed' };
  }
}

/**
 * Strict manuscript assembly (BG-007). Runs assemble_manuscript.py over the
 * project's 04_CHAPTERS into 07_BUILD/manuscript.md and returns the report.
 * @returns {{available:boolean, ok:boolean, output:(string|null), report:string}}
 */
function assemble(projectDir) {
  const d = detect();
  if (!d.available) return { available: false, ok: false, output: null, report: d.reason };
  if (!projectDir) return { available: true, ok: false, output: null, report: 'assemble requires projectDir' };
  const chaptersDir = path.join(projectDir, '04_CHAPTERS');
  const outFile = path.join(projectDir, '07_BUILD', 'manuscript.md');
  const reportFile = path.join(projectDir, '07_BUILD', 'build_report.txt');
  try {
    const out = _run(d.python, [ASSEMBLE, chaptersDir, '-o', outFile, '--strict', '--report', reportFile]);
    return { available: true, ok: true, output: outFile, report: String(out).trim() };
  } catch (err) {
    const msg = (err && (err.stderr || err.stdout) ? String(err.stderr || err.stdout) : String(err && err.message)).trim();
    return { available: true, ok: false, output: null, report: msg || 'assembly failed' };
  }
}

/** Read pipeline state for a project (00_CONTROL/PIPELINE.json via the adapter). */
function status(projectDir) {
  const d = detect();
  if (!d.available) return { available: false, lines: [], reason: d.reason };
  try {
    const out = _run(d.python, [ADAPTER, 'status', String(projectDir)]);
    return { available: true, lines: String(out).trim().split('\n').map(s => s.trim()).filter(Boolean), reason: null };
  } catch (err) {
    return { available: true, lines: [], reason: String(err && err.message) };
  }
}

module.exports = {
  ATELIER_DIR,
  ROLE_MAP,
  detect,
  roleFor,
  checkAuthority,
  stages,
  deliver,
  scaffold,
  assemble,
  status,
};
