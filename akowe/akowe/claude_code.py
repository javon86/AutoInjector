"""🤖 Claude Code helpers: the connection to the Claude Code CLI on this computer (Step 1 of the speed plan).

Claude Code is Anthropic's command-line tool. It signs in with the author's own Claude plan (the same plan as the
Claude pane, so it SHARES that plan's usage limits) and can be run by a program, several copies at once. Akọwe uses it
for small side jobs — research ahead, fact checks with real sources, checks side by side, the "sounds like AI" pass —
that would otherwise wait in line for the three web AIs. The jobs themselves are in ``claude_code_jobs`` and their
place in a ⚡ run in ``claude_code_book``; this module only finds the CLI, checks it is signed in, and runs one job
safely. Everything here falls back: when Claude Code is missing, signed out, at its limit or failing, the caller
simply does what Akọwe always did (the web panes). Nothing here ever raises into a book run except ``CCError``, which
the callers catch.

How a job runs (verified against the official docs, code.claude.com/docs/en/headless and /cli-reference):

* ``claude -p "<short instruction>" --output-format json`` — headless ("print") mode, one JSON result object on
  stdout: ``{"type": "result", "subtype": "success" | "error_max_turns" | "error_during_execution" | …,
  "is_error": bool, "result": "<the answer text>", "total_cost_usd": n, "usage": {...}, "duration_ms": n,
  "num_turns": n, "session_id": "…", "api_error_status": n | null, "errors": [...]}``. A failure inside the run (for
  example "Not logged in · Please run /login") is printed as the result on stdout with a non-zero exit code.
* The prompt (which may hold a whole chapter) goes in on **stdin** ("Non-interactive mode reads stdin": ``cat file |
  claude -p "query"``), never on the command line — Windows limits a command line to about 32 000 characters.
* No file or shell tools: ``--disallowedTools`` removes Bash, Edit, Write, Read … and every MCP tool (``mcp__*``);
  only WebSearch and WebFetch are allowed for research and fact checks (``--allowedTools``), and none at all for
  checks. ``--permission-mode dontAsk`` denies anything that would prompt; ``--no-session-persistence`` keeps no
  session on disk; ``--strict-mcp-config`` loads no MCP servers. Each job runs in its own new, empty temp folder.
  An older CLI that does not know one of these flags is asked once more with the basic flags only.
* A timeout (setting ``timeout_s``) kills the whole process tree; so does a cancel. At most ``helpers`` jobs run at
  once (setting, default 3, 1–5). A transient failure (a crash, a malformed answer, an overloaded server) is tried
  once more.

Privacy: the log holds codes, counts and timings only — never prompts, answers or book text.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from .errors import AkoweError

log = logging.getLogger("akowe.claude_code")

SETTINGS_KEY = "claude_code"
INSTALL_URL = "https://code.claude.com/docs/en/setup"
JOBS = ("research", "facts", "checks", "ai_tells",
        # 🤖 Step 2 (claude_code_speed.py): speed, quality and a less machine-written sound
        "prepare", "bible", "extras", "specialists", "variety", "style", "specifics")
JOB_WORDS = {"research": "Research ahead (the next chapters' facts, with sources)",
             "facts": "Fact-check each written chapter with real sources",
             "checks": "Checks side by side (continuity, voices, facts)",
             "ai_tells": "“Sounds like AI” pass (proposed rewrites of single lines)",
             "prepare": "Get the next chapter ready early (its scene plan and needs list, while this one is checked)",
             "bible": "Fill the Book Bible side by side (when “Fill the whole Book Bible” is on)",
             "extras": "Extras in the background (character pictures, the launch kit's first drafts)",
             "specialists": "Specialist reviewers (the ones ticked below, only where they are useful)",
             "variety": "Variety across the book (how the chapters so far open and end, checked against this plan)",
             "style": "Match my writing style (when the book uses your ✒️ style card: proposed fixes)",
             "specifics": "Specific details and real dialogue (proposed rewrites of generic or too-tidy lines)"}
# 🤖 Step 2: which specialist reviewers run (each only on chapters where it is useful)
SPECIALISTS = ("dialogue", "pacing", "sensory", "subtext")
SPECIALIST_WORDS = {"dialogue": "Dialogue voice — each main character who speaks, against their voice card",
                    "pacing": "Pacing — scenes that drag or rush",
                    "sensory": "Senses and concrete detail — only when a chapter has few",
                    "subtext": "Subtext — feelings named after they were already shown"}
DEFAULTS = {"enabled": None, "helpers": 3, "jobs": {j: True for j in JOBS}, "path": "", "model": "",
            "timeout_s": 600, "specialists": {"dialogue": True, "pacing": False, "sensory": True, "subtext": True}}
MIN_HELPERS, MAX_HELPERS = 1, 5
VERSION_TIMEOUT_S = 20
LOGIN_TIMEOUT_S = 90
READY_TTL_S = 30 * 60        # a "found, signed in" check is trusted this long
OTHER_TTL_S = 5 * 60         # any other status is looked at again after this
LIMIT_UNKNOWN_S = 30 * 60    # a usage limit without a reset time: try again after this
ARGV_PROMPT = ("Do the task described in the text on standard input. Use no tools except the ones it allows. "
               "Answer with only the JSON object it asks for.")
DENY_ALWAYS = ("Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep", "Task", "Agent",
               "TodoWrite", "BashOutput", "KillShell", "Skill", "SlashCommand", "mcp__*")
WEB_TOOLS = ("WebSearch", "WebFetch")

# plain words for each state (the 🤖 card, the run window, the AI activity strip)
STATE_WORDS = {
    "ready": "✔ Claude Code {version} found, signed in",
    "not_installed": "Not installed: Claude Code was not found on this computer. How to install it: {url}",
    "signed_out": "Signed out: open a terminal (PowerShell), run `claude` once and sign in with your Claude account",
    "limited": "At your Claude plan's usage limit{until} — the web AIs do the work until then",
    "failing": "Found, but not working right now ({code}) — the web AIs do the work",
    "off": "Off — the web AIs do all the work",
    "checking": "Checking Claude Code…",
}

_AUTH_RE = re.compile(r"not logged in|please run /login|run /login|login expired|invalid api key|"
                      r"authentication[_ ]failed|oauth token|not signed in|claude login not accepted|"
                      r"signed out of claude", re.I)
_LIMIT_RE = re.compile(r"hit your (?:session|weekly|opus|sonnet|monthly|individual)[\w ]* limit|usage limit|"
                       r"limit reached|rate[_ ]limit|credit balance is too low|spend limit", re.I)
_UNKNOWN_FLAG_RE = re.compile(r"unknown option|unknown argument|unrecognized (?:option|argument)", re.I)
_RESET_RE = re.compile(r"resets?\s+(?:at\s+)?(?:(mon|tue|wed|thu|fri|sat|sun)\w*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?",
                       re.I)
_VERSION_RE = re.compile(r"(\d+\.\d+(?:\.\d+)?)")


class CCError(AkoweError):
    """A Claude Code job did not give a usable answer. ``state``: signed_out | limited | not_installed | failing;
    ``transient``: worth one more try; ``reset_at``: epoch seconds when a usage limit resets (when known)."""

    def __init__(self, code: str, message: str, *, state: str = "failing", transient: bool = False,
                 reset_at: float | None = None, detail: str = ""):
        super().__init__(code, "/claude_code", message)
        self.state, self.transient, self.reset_at, self.detail = state, transient, reset_at, detail
        self.usage_limited = state == "limited"


# ====================================================================== settings
def _bool_or_none(v, path):
    if v is None or isinstance(v, bool):
        return v
    raise AkoweError("INVALID_INPUT", path, "on/off: true, false or empty (automatic)", status="REJECTED")


def settings(store) -> dict:
    try:
        cur = store.get_setting(SETTINGS_KEY) or {}
    except Exception:  # noqa: BLE001
        cur = {}
    out = json.loads(json.dumps(DEFAULTS))
    if isinstance(cur, dict):
        for k in ("enabled", "helpers", "path", "model", "timeout_s"):
            if k in cur:
                out[k] = cur[k]
        if isinstance(cur.get("jobs"), dict):
            out["jobs"].update({k: bool(v) for k, v in cur["jobs"].items() if k in JOBS})
        if isinstance(cur.get("specialists"), dict):  # 🤖 Step 2
            out["specialists"].update({k: bool(v) for k, v in cur["specialists"].items() if k in SPECIALISTS})
    out["helpers"] = helpers_of(out)
    return out


def helpers_of(st: dict) -> int:
    try:
        n = int(st.get("helpers") or DEFAULTS["helpers"])
    except (TypeError, ValueError):
        n = DEFAULTS["helpers"]
    return max(MIN_HELPERS, min(MAX_HELPERS, n))


def save_settings(store, body) -> dict:
    body = body if isinstance(body, dict) else {}
    cur = settings(store)
    if "enabled" in body:
        cur["enabled"] = _bool_or_none(body["enabled"], "/enabled")
    if "helpers" in body:
        n = body["helpers"]
        if isinstance(n, bool) or not isinstance(n, int) or not MIN_HELPERS <= n <= MAX_HELPERS:
            raise AkoweError("INVALID_INPUT", "/helpers", f"helpers at once: {MIN_HELPERS} to {MAX_HELPERS}",
                             status="REJECTED")
        cur["helpers"] = n
    if "jobs" in body:
        jobs = body["jobs"]
        if not isinstance(jobs, dict) or any(k not in JOBS or not isinstance(v, bool) for k, v in jobs.items()):
            raise AkoweError("INVALID_INPUT", "/jobs", "jobs: " + ", ".join(JOBS) + " each true or false",
                             status="REJECTED")
        cur["jobs"].update(jobs)
    if "specialists" in body:  # 🤖 Step 2: which specialist reviewers run
        sp = body["specialists"]
        if not isinstance(sp, dict) or any(k not in SPECIALISTS or not isinstance(v, bool) for k, v in sp.items()):
            raise AkoweError("INVALID_INPUT", "/specialists", "specialists: " + ", ".join(SPECIALISTS)
                             + " each true or false", status="REJECTED")
        cur["specialists"].update(sp)
    if "path" in body:
        p = body["path"]
        if p is not None and (not isinstance(p, str) or len(p) > 400):
            raise AkoweError("INVALID_INPUT", "/path", "the path to claude: up to 400 characters", status="REJECTED")
        cur["path"] = (p or "").strip()
    if "model" in body:
        m = body["model"]
        if m is not None and (not isinstance(m, str) or len(m) > 80 or not re.fullmatch(r"[\w.\-\[\]]*", m or "")):
            raise AkoweError("INVALID_INPUT", "/model", "model: an alias like sonnet or a model name", status="REJECTED")
        cur["model"] = (m or "").strip()
    if "timeout_s" in body:
        t = body["timeout_s"]
        if isinstance(t, bool) or not isinstance(t, int) or not 30 <= t <= 3600:
            raise AkoweError("INVALID_INPUT", "/timeout_s", "timeout: 30 to 3600 seconds", status="REJECTED")
        cur["timeout_s"] = t
    store.set_setting(SETTINGS_KEY, cur)
    GATE.resize(cur["helpers"])
    forget_status()
    return cur


def switched_off_here(env=None) -> bool:
    """AKOWE_CLAUDE_CODE=off (the test suite sets it, so a real Claude Code on a developer's PC is never used)."""
    return str((env or os.environ).get("AKOWE_CLAUDE_CODE", "")).strip().lower() in ("0", "off", "false", "no")


# ====================================================================== finding the CLI
def candidates(setting_path: str = "", env=None, home=None, os_name: str | None = None) -> list[tuple[str, str]]:
    """Where Claude Code may be, in order: [(where, path)]. ``where``: override | path | native | npm | homebrew."""
    env = os.environ if env is None else env
    win = (os_name or os.name) == "nt"
    out: list[tuple[str, str]] = []
    for over in (str(env.get("AKOWE_CLAUDE_PATH") or "").strip(), str(setting_path or "").strip()):
        if over:
            out.append(("override", over))
    for name in (("claude.exe", "claude.cmd", "claude") if win else ("claude",)):
        w = shutil.which(name, path=env.get("PATH"))
        if w:
            out.append(("path", w))
    hm = Path(home) if home else Path(env.get("USERPROFILE") or env.get("HOME") or str(Path.home()))
    out.append(("native", str(hm / ".local" / "bin" / ("claude.exe" if win else "claude"))))
    prefix = env.get("NPM_CONFIG_PREFIX") or env.get("npm_config_prefix")
    if win:
        if env.get("APPDATA"):
            out.append(("npm", str(Path(env["APPDATA"]) / "npm" / "claude.cmd")))
        if prefix:
            out.append(("npm", str(Path(prefix) / "claude.cmd")))
    else:
        if prefix:
            out.append(("npm", str(Path(prefix) / "bin" / "claude")))
        out += [("npm", str(hm / ".npm-global" / "bin" / "claude")), ("npm", "/usr/local/bin/claude"),
                ("homebrew", "/opt/homebrew/bin/claude")]
    seen, uniq = set(), []
    for w, p in out:
        if p not in seen:
            seen.add(p)
            uniq.append((w, p))
    return uniq


def find_cli(setting_path: str = "", env=None, home=None, os_name: str | None = None) -> tuple[str, str] | None:
    """(where, path) of the first candidate that exists as a file, else None. An override that does not exist is
    skipped (the others are still tried)."""
    for where, p in candidates(setting_path, env, home, os_name):
        try:
            if Path(p).is_file():
                return where, p
        except OSError:
            continue
    return None


# ====================================================================== the process: start, wait, kill the tree
def _popen(cmd: list[str], cwd: str, env=None):
    kw = {"stdin": subprocess.PIPE, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "cwd": cwd,
          "env": env, "text": True, "encoding": "utf-8", "errors": "replace"}
    if os.name == "nt":
        kw["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200) | 0x08000000  # + no window
    else:
        kw["start_new_session"] = True
    return subprocess.Popen(cmd, **kw)  # noqa: S603 - fixed arguments; book text goes in on stdin only


def kill_tree(proc) -> None:
    """Stop the process and everything it started. Never raises."""
    if proc is None or proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, timeout=15)  # noqa: S603,S607
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except Exception:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
    try:
        proc.wait(timeout=5)
    except Exception:  # noqa: BLE001
        pass


# Claude Code bills an API account instead of the user's Claude plan when one of these is set on the PC, so the
# helpers leave them out (the helpers are meant to use the plan the user signed in with). Someone who really wants
# API billing sets AKOWE_CLAUDE_USE_API_KEY=1.
API_BILLING_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


def child_env(base=None) -> dict:
    """The environment for a Claude Code process: this one, without the API-billing keys (see API_BILLING_VARS)."""
    env = dict(os.environ if base is None else base)
    if str(env.get("AKOWE_CLAUDE_USE_API_KEY", "")).strip().lower() not in ("1", "true", "yes", "on"):
        for k in API_BILLING_VARS:
            env.pop(k, None)
    return env


def run_process(cmd: list[str], stdin_text: str, *, timeout_s: float, cancel=None, env=None,
                files=None, on_start=None) -> tuple[int, str, str]:
    """Run ``cmd`` in a new empty temp folder with ``stdin_text`` on stdin. (exit code, stdout, stderr). Raises
    CCError TIMEOUT (tree killed), a cancel (CCError CANCELLED as UPSTREAM_UNAVAILABLE, tree killed) or
    not_installed. ``files``: copied into the folder first (⌨ command-line mode: a picture to look at); ``cmd``
    may name the folder as ``{work}``. ``on_start(proc)``: told the process once it runs (so it can be stopped)."""
    work = tempfile.mkdtemp(prefix="akowe-cc-")
    env = child_env() if env is None else env
    proc = None
    try:
        for f in files or ():
            shutil.copy2(f, Path(work) / Path(f).name)
        cmd = [a.replace("{work}", work) for a in cmd]
        try:
            proc = _popen(cmd, work, env)
        except (FileNotFoundError, PermissionError, OSError) as exc:
            raise CCError("CAPABILITY_UNAVAILABLE", STATE_WORDS["not_installed"].format(url=INSTALL_URL),
                          state="not_installed", detail=type(exc).__name__) from None
        if on_start is not None:
            on_start(proc)
        deadline = time.monotonic() + timeout_s
        pending = stdin_text
        while True:
            if cancel is not None and cancel():
                kill_tree(proc)
                raise CCError("UPSTREAM_UNAVAILABLE", "the Claude Code job was stopped", detail="CANCELLED")
            left = deadline - time.monotonic()
            if left <= 0:
                kill_tree(proc)
                raise CCError("TIMEOUT", f"Claude Code took longer than {int(timeout_s)} s, so Akọwe stopped it",
                              detail="TIMEOUT")
            try:
                out, err = proc.communicate(input=pending, timeout=min(0.5, left))
                return proc.returncode, out or "", err or ""
            except subprocess.TimeoutExpired:
                pending = None  # stdin was written and closed by the first call
    finally:
        if proc is not None and proc.poll() is None:
            kill_tree(proc)
        shutil.rmtree(work, ignore_errors=True)


# ====================================================================== at most N at once
class Gate:
    """A counting gate with a capacity that can change (the "helpers at once" setting)."""

    def __init__(self, n: int):
        self._cv = threading.Condition()
        self.cap, self.running, self.peak = max(1, n), 0, 0

    def resize(self, n: int) -> None:
        with self._cv:
            self.cap = max(1, int(n))
            self._cv.notify_all()

    def acquire(self, cancel=None) -> None:
        with self._cv:
            while self.running >= self.cap:
                if cancel is not None and cancel():
                    raise CCError("UPSTREAM_UNAVAILABLE", "the Claude Code job was stopped", detail="CANCELLED")
                self._cv.wait(0.2)
            self.running += 1
            self.peak = max(self.peak, self.running)

    def release(self) -> None:
        with self._cv:
            self.running = max(0, self.running - 1)
            self._cv.notify_all()


GATE = Gate(DEFAULTS["helpers"])


# ====================================================================== reading the answer
def parse_output(stdout: str) -> dict | None:
    """The result object of ``--output-format json`` (also the last ``result`` line of stream-json). None when
    there is none."""
    s = (stdout or "").strip()
    if not s:
        return None
    try:
        v = json.loads(s)
        if isinstance(v, dict):
            return v
        if isinstance(v, list):
            res = [x for x in v if isinstance(x, dict) and x.get("type") == "result"]
            return res[-1] if res else None
    except ValueError:
        pass
    for line in reversed(s.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                v = json.loads(line)
            except ValueError:
                continue
            if isinstance(v, dict) and (v.get("type") == "result" or "result" in v):
                return v
    return None


def parse_reset(text: str, now: datetime | None = None) -> float | None:
    """'You've hit your session limit · resets 3:45pm' -> epoch seconds of the next 3:45 PM (local time); 'resets
    Mon 12:00am' -> next Monday. None when no reset time is said."""
    m = _RESET_RE.search(text or "")
    if not m:
        return None
    day, hh, mm, ap = m.group(1), int(m.group(2)), int(m.group(3) or 0), (m.group(4) or "").lower()
    if ap == "pm" and hh < 12:
        hh += 12
    if ap == "am" and hh == 12:
        hh = 0
    if hh > 23 or mm > 59:
        return None
    now = now or datetime.now()
    t = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if day:
        want = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].index(day.lower()[:3])
        t += timedelta(days=(want - now.weekday()) % 7)
    if t <= now:
        t += timedelta(days=7 if day else 1)
    return t.timestamp()


def classify(rc: int, res: dict | None, stderr: str) -> CCError | None:
    """None when the run gave a usable answer, else the CCError that says what went wrong."""
    text = " ".join(str(x) for x in ((res or {}).get("result"), " ".join(map(str, (res or {}).get("errors") or [])),
                                     stderr) if x)
    if _AUTH_RE.search(text):
        return CCError("PERMISSION_DENIED", STATE_WORDS["signed_out"], state="signed_out", detail="NOT_LOGGED_IN")
    status = (res or {}).get("api_error_status")
    if _LIMIT_RE.search(text) or status == 429:
        at = parse_reset(text)
        return CCError("RATE_LIMITED", limit_words(at), state="limited", reset_at=at, detail="USAGE_LIMIT")
    if res is None:
        if _UNKNOWN_FLAG_RE.search(stderr or ""):
            return CCError("UPSTREAM_UNAVAILABLE", "this Claude Code does not know one of Akọwe's options",
                           detail="UNKNOWN_FLAG")
        return CCError("UPSTREAM_UNAVAILABLE", f"Claude Code stopped without an answer (exit code {rc})",
                       transient=True, detail="CRASH" if rc else "NO_RESULT")
    if res.get("is_error") or (res.get("subtype") not in (None, "success")):
        sub = str(res.get("subtype") or "error")
        transient = sub == "error_during_execution" or (isinstance(status, int) and (status >= 500 or status == 529))
        return CCError("UPSTREAM_UNAVAILABLE", f"Claude Code could not finish the job ({sub})", transient=transient,
                       detail=sub.upper()[:40])
    if rc not in (0, None):
        return CCError("UPSTREAM_UNAVAILABLE", f"Claude Code ended with exit code {rc}", transient=True,
                       detail="EXIT_CODE")
    return None


def limit_words(reset_at: float | None) -> str:
    from . import usage_limits  # noqa: PLC0415 - the same "about 3:40 PM" words as the web AIs' limits
    until = f" until about {usage_limits.clock(reset_at)}" if reset_at else ""
    return STATE_WORDS["limited"].format(until=until)


def answer_json(res: dict, schema: dict | None):
    """The job's JSON answer from the result: ``structured_output`` when the CLI gave one, else the JSON object in
    the result text (Akọwe's usual smart parsing: fences, prose around it, curly quotes). Validated against
    ``schema`` with Akọwe's own validator. Raises CCError (transient: one more try) when it is not usable."""
    from .contracts import AkoweValidator, schema_errors  # noqa: PLC0415
    from .providers import extract_json_object  # noqa: PLC0415
    obj = res.get("structured_output") if isinstance(res.get("structured_output"), dict) else None
    if obj is None:
        obj = extract_json_object(str(res.get("result") or ""))
    if obj is None:
        raise CCError("UPSTREAM_UNAVAILABLE", "Claude Code's answer was not the JSON Akọwe asked for", transient=True,
                      detail="BAD_JSON")
    if schema:
        errs = schema_errors(AkoweValidator(schema), obj)
        if errs:
            raise CCError("UPSTREAM_UNAVAILABLE", "Claude Code's answer did not have the shape Akọwe asked for "
                          f"({len(errs)} problem(s))", transient=True, detail="SCHEMA")
    return obj


# ====================================================================== status (found? signed in? at a limit?)
_LOCK = threading.Lock()
_STATUS: dict = {}
_DETECTING = threading.Event()


def forget_status() -> None:
    with _LOCK:
        _STATUS.clear()


def _set_status(**kw) -> dict:
    with _LOCK:
        keep = {k: _STATUS.get(k) for k in ("version", "path", "where") if _STATUS.get(k)}
        _STATUS.clear()
        _STATUS.update(keep)
        _STATUS.update(kw, at=time.time())
        return dict(_STATUS)


def status_words(st: dict) -> str:
    state = st.get("state") or "checking"
    if state == "limited":
        return limit_words(st.get("reset_at"))
    return STATE_WORDS.get(state, state).format(version=st.get("version") or "", url=INSTALL_URL,
                                                code=st.get("code") or "?", until="")


def cached_status() -> dict | None:
    with _LOCK:
        if not _STATUS:
            return None
        st = dict(_STATUS)
    age = time.time() - st.get("at", 0)
    if st.get("state") == "limited":
        until = st.get("reset_at") or (st.get("at", 0) + LIMIT_UNKNOWN_S)
        return st if time.time() < until else None
    if age > (READY_TTL_S if st.get("state") == "ready" else OTHER_TTL_S):
        return None
    return st


def note_job_error(exc: CCError) -> None:
    """A job found Claude Code signed out / at its limit / not installed: later jobs fall back at once."""
    if exc.state in ("signed_out", "limited", "not_installed"):
        _set_status(state=exc.state, reset_at=exc.reset_at, code=exc.code, words=str(exc))


def detect(store, *, force: bool = False) -> dict:
    """Is Claude Code here, signed in and working? {state, words, version, path, where, at, reset_at?, code?}.
    Runs ``claude --version`` and one tiny signed-in check (a one-line ``-p`` prompt, short timeout). Cached."""
    st = settings(store)
    if switched_off_here():
        return {"state": "off", "words": "Switched off on this computer — the web AIs do all the work", "at": time.time()}
    if not force:
        cur = cached_status()
        if cur:
            return dict(cur, words=status_words(cur))
    found = find_cli(st.get("path") or "")
    if not found:
        out = _set_status(state="not_installed", version=None, path=None, where=None)
        out.update(version=None, path=None, where=None)
        return dict(out, words=status_words(out), install_url=INSTALL_URL)
    where, path = found
    try:
        rc, out_s, err_s = run_process([path, "--version"], "", timeout_s=VERSION_TIMEOUT_S)
    except CCError as exc:
        o = _set_status(state=exc.state if exc.state == "not_installed" else "failing", code=exc.code, path=path,
                        where=where)
        return dict(o, words=status_words(o), install_url=INSTALL_URL)
    m = _VERSION_RE.search(out_s or "")
    if rc != 0 or not m:
        o = _set_status(state="failing", code="VERSION_CHECK", path=path, where=where)
        return dict(o, words=status_words(o))
    with _LOCK:
        _STATUS.update(version=m.group(1), path=path, where=where)
    try:
        run_job(store, kind="login_check", prompt="Reply with the single word OK, as the JSON object {\"ok\": true}.",
                schema=None, tools="none", timeout_s=LOGIN_TIMEOUT_S, max_turns=1, retry=False, check_status=False)
    except CCError as exc:
        state = exc.state if exc.state in ("signed_out", "limited", "not_installed") else "failing"
        o = _set_status(state=state, code=exc.code, reset_at=exc.reset_at, path=path, where=where, version=m.group(1))
        return dict(o, words=status_words(o))
    o = _set_status(state="ready", path=path, where=where, version=m.group(1))
    return dict(o, words=status_words(o))


def detect_in_background(store) -> None:
    if _DETECTING.is_set():
        return
    _DETECTING.set()

    def go():
        try:
            detect(store)
        except Exception:  # noqa: BLE001
            log.exception("could not check Claude Code")
        finally:
            _DETECTING.clear()
    threading.Thread(target=go, name="akowe-claude-code-detect", daemon=True).start()


def enabled(store) -> bool:
    """The author's On/Off (empty = automatic: on when Claude Code is found)."""
    if switched_off_here():
        return False
    return settings(store).get("enabled") is not False


def available(store) -> dict | None:
    """The ready status when jobs may go to Claude Code now, else None (the caller falls back). Never waits: a
    status that is not known yet is looked up in the background (the next call knows)."""
    if not enabled(store):
        return None
    cur = cached_status()
    if cur is None:
        detect_in_background(store)
        return None
    return cur if cur.get("state") == "ready" else None


# ====================================================================== one job
def command(path: str, *, tools: str, model: str = "", max_turns: int | None = None, basic: bool = False) -> list[str]:
    cmd = [path, "-p", ARGV_PROMPT, "--output-format", "json"]
    if max_turns:
        cmd += ["--max-turns", str(int(max_turns))]
    deny = list(DENY_ALWAYS) + ([] if tools == "web" else list(WEB_TOOLS))
    cmd += ["--disallowedTools", ",".join(deny)]
    if tools == "web":
        cmd += ["--allowedTools", ",".join(WEB_TOOLS)]
    if model:
        cmd += ["--model", model]
    if not basic:
        cmd += ["--permission-mode", "dontAsk", "--no-session-persistence", "--strict-mcp-config"]
    return cmd


def run_job(store, *, kind: str, prompt: str, schema: dict | None = None, tools: str = "none",
            timeout_s: float | None = None, max_turns: int | None = None, cancel=None, retry: bool = True,
            check_status: bool = True) -> dict:
    """Run one Claude Code job and return {data (the validated JSON answer, or the text when no schema), seconds,
    cost_usd, tokens_in, tokens_out, attempts}. Raises CCError (state says why) — the caller falls back."""
    st = settings(store)
    if check_status:
        cur = cached_status()
        if cur and cur.get("state") in ("signed_out", "limited", "not_installed"):
            raise CCError({"signed_out": "PERMISSION_DENIED", "limited": "RATE_LIMITED"}.get(
                cur["state"], "CAPABILITY_UNAVAILABLE"), status_words(cur), state=cur["state"],
                reset_at=cur.get("reset_at"))
    path = (cached_status() or {}).get("path") or ((find_cli(st.get("path") or "") or (None, None))[1])
    if not path:
        raise CCError("CAPABILITY_UNAVAILABLE", STATE_WORDS["not_installed"].format(url=INSTALL_URL),
                      state="not_installed")
    timeout_s = float(timeout_s or st.get("timeout_s") or DEFAULTS["timeout_s"])
    GATE.resize(helpers_of(st))
    t0 = time.monotonic()
    attempts, basic = 0, False
    last: CCError | None = None
    while True:
        attempts += 1
        cmd = command(path, tools=tools, model=st.get("model") or "", max_turns=max_turns, basic=basic)
        GATE.acquire(cancel)
        try:
            rc, out, err = run_process(cmd, prompt, timeout_s=timeout_s, cancel=cancel)
        except CCError as exc:
            last = exc
            res = None
        else:
            res = parse_output(out)
            last = classify(rc, res, err)
            if res is None and rc == 0 and (out or "").strip() and last is not None:
                last.detail = "BAD_JSON"  # it answered, but not with the JSON result object
        finally:
            GATE.release()
        data = None
        if last is None:
            try:
                data = answer_json(res, schema) if schema else str(res.get("result") or "")
            except CCError as exc:
                last = exc
        if last is None:
            secs = time.monotonic() - t0
            usage = res.get("usage") or {}
            log.info("Claude Code job %s: ok in %.1fs (attempt %d, prompt %d chars, answer %d chars)", kind, secs,
                     attempts, len(prompt or ""), len(str(res.get("result") or "")))
            return {"data": data, "seconds": round(secs, 2), "attempts": attempts,
                    "cost_usd": float(res.get("total_cost_usd") or 0.0),
                    "tokens_in": int(usage.get("input_tokens") or 0) if isinstance(usage, dict) else 0,
                    "tokens_out": int(usage.get("output_tokens") or 0) if isinstance(usage, dict) else 0}
        if last.detail == "UNKNOWN_FLAG" and not basic:
            basic = True  # an older Claude Code: once more with the basic flags only
            attempts -= 1
            continue
        if retry and last.transient and attempts < 2 and not (cancel and cancel()):
            log.info("Claude Code job %s: %s (%s), trying once more", kind, last.code, last.detail)
            continue
        log.info("Claude Code job %s: failed %s/%s after %.1fs (%d attempt(s))", kind, last.code, last.detail,
                 time.monotonic() - t0, attempts)
        note_job_error(last)
        raise last


# ====================================================================== HTTP: Settings › 🤖 Claude Code helpers
def public(store, *, force: bool = False, wait: bool = False) -> dict:
    st = settings(store)
    if switched_off_here():
        cur = detect(store)
    else:
        cur = detect(store, force=True) if force else (detect(store) if wait else (cached_status() or None))
    if cur is None:
        detect_in_background(store)
        cur = {"state": "checking"}
    cur = dict(cur)
    cur["words"] = cur.get("words") or status_words(cur)
    on = enabled(store) and cur.get("state") == "ready"
    return {"settings": st, "status": cur, "active": on, "install_url": INSTALL_URL, "job_words": JOB_WORDS,
            "specialist_words": SPECIALIST_WORDS,
            "helpers_range": [MIN_HELPERS, MAX_HELPERS],
            "shares_limits": "Claude Code uses your Claude plan, so it shares that plan's usage limits with the "
                             "Claude pane and claude.ai."}


def route(store, method: str, rest: list, body) -> tuple[int, dict]:
    """/settings/claude-code[...]"""
    if rest == [] and method == "GET":  # never waits: an unknown status is checked in the background ("checking")
        return 200, public(store)
    if rest == [] and method == "PUT":
        save_settings(store, body)
        return 200, public(store)
    if rest == ["check"] and method == "POST":
        return 200, public(store, force=True)
    raise AkoweError("NOT_FOUND", "/settings/claude-code/" + "/".join(rest), "no such endpoint", status="REJECTED")
