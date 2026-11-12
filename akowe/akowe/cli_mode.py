"""⌨ Command-line mode (try it first): an AI slot talks to an AI's command-line tool instead of its web window.

Per AI slot the author chooses **Web window** (as always: AutoInjector types into the logged-in web page) or
**Command line**: Akọwe then runs the AI's own command-line tool on this computer, headless, one fresh process per
request, the same way the 🤖 Claude Code helpers run (``claude_code.py``):

* Claude → **Claude Code** — ``claude -p "<short instruction>" --output-format json`` with the prompt on stdin, no file,
  shell, web or MCP tools, ``--permission-mode dontAsk --no-session-persistence --strict-mcp-config``; it uses the
  Claude plan the person signed in with (``claude_code.child_env`` drops the API-billing keys).
* ChatGPT → **OpenAI Codex CLI** — ``codex exec --skip-git-repo-check --ephemeral --sandbox read-only --color never
  -C <empty temp folder> -o <answer file> -`` with the prompt on stdin (``-`` = read the instructions from stdin); it
  uses the ChatGPT plan of ``codex login`` (``CODEX_API_KEY`` / ``OPENAI_API_KEY`` are dropped from its environment
  unless ``AKOWE_CODEX_USE_API_KEY=1``). Flags checked against the Codex source (codex-rs/exec/src/cli.rs,
  codex-rs/utils/cli/src/shared_options.rs, codex-rs/cli/src/login.rs). An older Codex that does not know
  ``--ephemeral`` / ``--color`` is asked once more with the basic flags.
* Gemini stays a web window. TODO(cli-mode): the Gemini CLI (``gemini -p``) could be added the same way once its
  headless output and sign-in messages are checked; until then "Command line" is refused for a Gemini slot.

Every request: the same prompt and JSON handling as the web AIs (``AutoInjectorAdapter.build_prompt``,
``extract_json_object``, up to 2 schema re-asks), a timeout that kills the whole process tree, at most ``at_once``
processes per tool at the same time, a cancel (⚡ Cancel) that kills them at once, and the tools' sign-in / usage-limit
messages mapped to Akọwe's codes with plain words:

* usage limit → ``RATE_LIMITED`` (site state ``needs_user``, problem ``USAGE_LIMIT``, with the reset time when the
  tool says it): the work moves to another AI or waits for the limit like a web AI's limit;
* signed out / not installed → ``CAPABILITY_UNAVAILABLE`` (problem ``SIGNED_OUT`` / ``NOT_INSTALLED``): another AI
  takes the call, or the run stops and says how to sign in;
* a crash, an overloaded server, a time-out → ``UPSTREAM_UNAVAILABLE`` / ``TIMEOUT`` (another AI, or ask again).

Pictures: ``submit(images=[paths])`` copies the pictures into the empty work folder; Claude Code may then use its Read
tool on them (only Read is allowed), Codex gets them with ``-i <file>``. A tool that refuses pictures gives the call to
another AI (``try_other_ai``).

The 📜 conversation: the last ``EXCHANGES_MAX`` exchanges (a short summary of what was asked, the answer's start, the
outcome) are kept **in memory only** for AutoInjector's "Command-line conversation" view (GET /api/cli-mode) — the
command line has no web page to look at. Logs hold codes, counts and timings only, never prompts or answers.
"""
from __future__ import annotations

import itertools
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
from collections import deque
from pathlib import Path

from . import claude_code
from .errors import AkoweError

log = logging.getLogger("akowe.cli_mode")

CLI_SITES = ("claude", "chatgpt")
TOOL_OF = {"claude": "claude", "chatgpt": "codex"}
TOOL_NAMES = {"claude": "Claude Code", "codex": "Codex"}
SITE_WORDS = {"claude": "Claude", "chatgpt": "ChatGPT", "gemini": "Gemini"}
MODES = ("web", "cli")
SETTINGS_KEY = "cli_mode"
DEFAULTS = {"timeout_s": 900, "at_once": 2, "codex_path": "", "codex_model": "", "claude_model": ""}
MIN_AT_ONCE, MAX_AT_ONCE = 1, 4
MAX_REASKS = 2
EXCHANGES_MAX = 40
CODEX_INSTALL_URL = "https://github.com/openai/codex"
CODEX_INSTALL_CMD = "npm install -g @openai/codex"
# what a command-line AI takes in one request when the author set no limit (both tools read far more than a web chat)
CLI_CONTEXT_TOKENS = {"claude": 150000, "chatgpt": 150000}
CODEX_BILLING_VARS = ("CODEX_API_KEY", "OPENAI_API_KEY")
VERSION_TIMEOUT_S = 20
LOGIN_TIMEOUT_S = 30
READY_TTL_S = 30 * 60
OTHER_TTL_S = 5 * 60
LIMIT_UNKNOWN_S = 30 * 60
CLAUDE_ARGV = ("Do the task described in the text on standard input. Use no tools{pics}. Answer with only the JSON "
               "object it asks for.")
CODEX_PREAMBLE = ("You are answering one request for Akọwe, a book-writing program. Do not run commands and do not "
                  "change any file{pics}. Answer with only the JSON object the request asks for.\n\n")
CLAUDE_DENY = tuple(t for t in claude_code.DENY_ALWAYS) + claude_code.WEB_TOOLS

_CODEX_LIMIT_RE = re.compile(r"hit your usage limit|usage limit|rate limit exceeded|too many requests|\b429\b|"
                             r"purchase more credits|quota", re.I)
_CODEX_AUTH_RE = re.compile(r"not logged in|codex login|log ?in again|sign in again|unauthorized|\b401\b|"
                            r"refresh token|access token could not be refreshed|authentication|not signed in", re.I)
_CODEX_TRY_AT_RE = re.compile(r"try again at\s+([A-Z][a-z]{2} \d{1,2}(?:st|nd|rd|th)?, \d{4} )?(\d{1,2}):(\d{2})\s*"
                              r"(AM|PM)", re.I)
_CODEX_VERSION_RE = re.compile(r"(\d+\.\d+(?:\.\d+)?)")
_IMAGE_FLAG_RE = re.compile(r"(?:unexpected|unknown|unrecognized)[^\n]*(?:--image|-i\b)", re.I)


# ====================================================================== settings
def settings(store) -> dict:
    try:
        cur = store.get_setting(SETTINGS_KEY) or {}
    except Exception:  # noqa: BLE001
        cur = {}
    out = dict(DEFAULTS)
    if isinstance(cur, dict):
        out.update({k: cur[k] for k in DEFAULTS if k in cur})
    try:
        out["at_once"] = max(MIN_AT_ONCE, min(MAX_AT_ONCE, int(out["at_once"])))
    except (TypeError, ValueError):
        out["at_once"] = DEFAULTS["at_once"]
    return out


def save_settings(store, body) -> dict:
    body = body if isinstance(body, dict) else {}
    cur = settings(store)
    if "timeout_s" in body:
        t = body["timeout_s"]
        if isinstance(t, bool) or not isinstance(t, int) or not 60 <= t <= 3600:
            raise AkoweError("INVALID_INPUT", "/timeout_s", "time for one answer: 60 to 3600 seconds", status="REJECTED")
        cur["timeout_s"] = t
    if "at_once" in body:
        n = body["at_once"]
        if isinstance(n, bool) or not isinstance(n, int) or not MIN_AT_ONCE <= n <= MAX_AT_ONCE:
            raise AkoweError("INVALID_INPUT", "/at_once", f"at once: {MIN_AT_ONCE} to {MAX_AT_ONCE}", status="REJECTED")
        cur["at_once"] = n
    for k, n in (("codex_path", 400), ("codex_model", 80), ("claude_model", 80)):
        if k in body:
            v = body[k]
            if v is not None and (not isinstance(v, str) or len(v) > n
                                  or (k.endswith("model") and not re.fullmatch(r"[\w.\-\[\]]*", v))):
                raise AkoweError("INVALID_INPUT", "/" + k, f"{k}: up to {n} characters", status="REJECTED")
            cur[k] = (v or "").strip()
    store.set_setting(SETTINGS_KEY, cur)
    for g in GATES.values():
        g.resize(cur["at_once"])
    forget_status()
    return cur


def is_cli(slot: dict | None) -> bool:
    """A slot set to "Command line" (an AutoInjector slot of Claude or ChatGPT with mode cli)."""
    return bool(slot) and slot.get("adapter_id") == "autoinjector" and slot.get("mode") == "cli" \
        and slot.get("site") in CLI_SITES


def tool_of(slot: dict) -> str:
    return TOOL_OF.get(slot.get("site") or "", "claude")


# ====================================================================== finding Codex
def codex_candidates(setting_path: str = "", env=None, home=None, os_name: str | None = None) -> list[tuple[str, str]]:
    env = os.environ if env is None else env
    win = (os_name or os.name) == "nt"
    out: list[tuple[str, str]] = []
    for over in (str(env.get("AKOWE_CODEX_PATH") or "").strip(), str(setting_path or "").strip()):
        if over:
            out.append(("override", over))
    for name in (("codex.exe", "codex.cmd", "codex") if win else ("codex",)):
        w = shutil.which(name, path=env.get("PATH"))
        if w:
            out.append(("path", w))
    hm = Path(home) if home else Path(env.get("USERPROFILE") or env.get("HOME") or str(Path.home()))
    prefix = env.get("NPM_CONFIG_PREFIX") or env.get("npm_config_prefix")
    if win:
        if env.get("APPDATA"):
            out.append(("npm", str(Path(env["APPDATA"]) / "npm" / "codex.cmd")))
        if prefix:
            out.append(("npm", str(Path(prefix) / "codex.cmd")))
    else:
        if prefix:
            out.append(("npm", str(Path(prefix) / "bin" / "codex")))
        out += [("npm", str(hm / ".npm-global" / "bin" / "codex")), ("npm", "/usr/local/bin/codex"),
                ("homebrew", "/opt/homebrew/bin/codex")]
    seen, uniq = set(), []
    for w, p in out:
        if p not in seen:
            seen.add(p)
            uniq.append((w, p))
    return uniq


def find_codex(setting_path: str = "", env=None, home=None, os_name: str | None = None) -> tuple[str, str] | None:
    for where, p in codex_candidates(setting_path, env, home, os_name):
        try:
            if Path(p).is_file():
                return where, p
        except OSError:
            continue
    return None


def codex_env(base=None) -> dict:
    """Codex's environment: this one without API keys (so it uses the ChatGPT plan of ``codex login``)."""
    env = claude_code.child_env(base)
    if str(env.get("AKOWE_CODEX_USE_API_KEY", "")).strip().lower() not in ("1", "true", "yes", "on"):
        for k in CODEX_BILLING_VARS:
            env.pop(k, None)
    return env


# ====================================================================== status (installed? signed in? at a limit?)
_LOCK = threading.Lock()
_STATUS: dict[str, dict] = {}   # "codex" -> {state, version, path, at, reset_at?, code?}

STATE_WORDS = {
    "ready": "✔ {name} {version} found, signed in",
    "not_installed": "Not installed: {name} was not found on this computer",
    "signed_out": "Signed out: press “⌨ Open {name}” and sign in ({how})",
    "limited": "At your {plan} plan's usage limit{until}",
    "failing": "Found, but not working right now ({code})",
    "off": "Switched off on this computer",
    "checking": "Checking {name}…",
}
SIGN_IN_HOW = {"claude": "run claude once and sign in with your Claude account",
               "codex": "run codex login and sign in with your ChatGPT account"}
PLAN_OF = {"claude": "Claude", "codex": "ChatGPT"}


def forget_status() -> None:
    with _LOCK:
        _STATUS.clear()


def _set(tool: str, **kw) -> dict:
    with _LOCK:
        keep = {k: (_STATUS.get(tool) or {}).get(k) for k in ("version", "path", "where")
                if (_STATUS.get(tool) or {}).get(k)}
        _STATUS[tool] = dict(keep, **kw, at=time.time())
        return dict(_STATUS[tool])


def words(tool: str, st: dict) -> str:
    state = st.get("state") or "checking"
    until = ""
    if state == "limited" and st.get("reset_at"):
        from . import usage_limits  # noqa: PLC0415
        until = f" until about {usage_limits.clock(st['reset_at'])}"
    return STATE_WORDS.get(state, state).format(name=TOOL_NAMES[tool], version=st.get("version") or "",
                                                how=SIGN_IN_HOW[tool], plan=PLAN_OF[tool], until=until,
                                                code=st.get("code") or "?")


def _codex_cached() -> dict | None:
    with _LOCK:
        st = dict(_STATUS.get("codex") or {})
    if not st:
        return None
    if st.get("state") == "limited":
        until = st.get("reset_at") or (st.get("at", 0) + LIMIT_UNKNOWN_S)
        return st if time.time() < until else None
    age = time.time() - st.get("at", 0)
    return None if age > (READY_TTL_S if st.get("state") == "ready" else OTHER_TTL_S) else st


def cached(tool: str) -> dict | None:
    """The last known status of a tool, without running anything (None: not checked lately)."""
    if tool == "claude":
        if claude_code.switched_off_here():
            return {"state": "off"}
        return claude_code.cached_status()
    return _codex_cached()


def detect_codex(store, *, force: bool = False) -> dict:
    if not force:
        cur = _codex_cached()
        if cur:
            return dict(cur, words=words("codex", cur))
    found = find_codex(settings(store).get("codex_path") or "")
    if not found:
        out = _set("codex", state="not_installed", version=None, path=None, where=None)
        out.update(version=None, path=None, where=None)
        return dict(out, words=words("codex", out), install_url=CODEX_INSTALL_URL)
    where, path = found
    try:
        rc, out_s, err_s = claude_code.run_process([path, "--version"], "", timeout_s=VERSION_TIMEOUT_S,
                                                   env=codex_env())
    except claude_code.CCError as exc:
        o = _set("codex", state="not_installed" if exc.state == "not_installed" else "failing", code=exc.code,
                 path=path, where=where)
        return dict(o, words=words("codex", o))
    m = _CODEX_VERSION_RE.search(out_s or err_s or "")
    if rc != 0 or not m:
        o = _set("codex", state="failing", code="VERSION_CHECK", path=path, where=where)
        return dict(o, words=words("codex", o))
    version = m.group(1)
    # the tiny signed-in check: `codex login status` (exit 0 "Logged in using ChatGPT", exit 1 "Not logged in")
    try:
        rc, out_s, err_s = claude_code.run_process([path, "login", "status"], "", timeout_s=LOGIN_TIMEOUT_S,
                                                   env=codex_env())
    except claude_code.CCError as exc:
        o = _set("codex", state="failing", code=exc.code, path=path, where=where, version=version)
        return dict(o, words=words("codex", o))
    text = f"{out_s}\n{err_s}"
    if rc == 0 and re.search(r"logged in|api key configured", text, re.I) and not re.search(r"not logged in", text,
                                                                                               re.I):
        o = _set("codex", state="ready", path=path, where=where, version=version)
    elif re.search(r"not logged in", text, re.I) or rc == 1:
        o = _set("codex", state="signed_out", code="NOT_LOGGED_IN", path=path, where=where, version=version)
    else:
        o = _set("codex", state="failing", code="LOGIN_CHECK", path=path, where=where, version=version)
    return dict(o, words=words("codex", o))


def detect(store, tool: str, *, force: bool = False) -> dict:
    if tool == "claude":
        st = claude_code.detect(store, force=force)
        st = dict(st)
        st["words"] = words("claude", st) if st.get("state") != "off" else STATE_WORDS["off"]
        return st
    return detect_codex(store, force=force)


def note_error(tool: str, state: str, reset_at: float | None = None, code: str | None = None) -> None:
    """A request found the tool signed out / at its limit / missing: later requests know at once."""
    if state not in ("signed_out", "limited", "not_installed"):
        return
    if tool == "claude":
        claude_code._set_status(state=state, reset_at=reset_at, code=code)  # noqa: SLF001 - the shared status
    else:
        _set("codex", state=state, reset_at=reset_at, code=code)


def site_state(slot: dict) -> dict:
    """The slot's state for the registry (like a bridge site's): limited → needs_user/USAGE_LIMIT, signed out →
    needs_user/SIGNED_OUT, missing → broken/NOT_INSTALLED, else ok. Never runs anything (a background check starts
    when nothing is known)."""
    tool = tool_of(slot)
    st = cached(tool)
    if st is None:
        _detect_in_background(tool)
        return {"state": "ok", "problem": None, "source": "cli", "reset_at": None}
    s = st.get("state")
    if s == "limited":
        return {"state": "needs_user", "problem": "USAGE_LIMIT", "source": "cli", "reset_at": st.get("reset_at")}
    if s == "signed_out":
        return {"state": "needs_user", "problem": "SIGNED_OUT", "source": "cli", "reset_at": None}
    if s in ("not_installed", "off"):
        return {"state": "broken", "problem": "NOT_INSTALLED" if s == "not_installed" else "SWITCHED_OFF",
                "source": "cli", "reset_at": None}
    return {"state": "ok", "problem": None, "source": "cli", "reset_at": None}


_STORE = {"store": None}
_DETECTING: dict[str, threading.Event] = {"claude": threading.Event(), "codex": threading.Event()}


def bind_store(store) -> None:
    """The settings store the background checks read (set once by the server)."""
    _STORE["store"] = store


def _detect_in_background(tool: str) -> None:
    store = _STORE["store"]
    ev = _DETECTING[tool]
    if store is None or ev.is_set():
        return
    ev.set()

    def go():
        try:
            detect(store, tool)
        except Exception:  # noqa: BLE001
            log.exception("cli status check failed tool=%s", tool)
        finally:
            ev.clear()
    threading.Thread(target=go, name=f"akowe-cli-detect-{tool}", daemon=True).start()


# ====================================================================== running processes (at most N; cancel)
GATES = {"claude": claude_code.Gate(DEFAULTS["at_once"]), "codex": claude_code.Gate(DEFAULTS["at_once"])}
_RUNNING: dict[int, dict] = {}   # id -> {proc, run_id, book_id}
_RUN_LOCK = threading.Lock()
_IDS = itertools.count(1)


def cancel(run_id: str | None = None, book_id: str | None = None) -> int:
    """⚡ Cancel: stop every command-line AI working for this run (or book; both None = all). Returns how many."""
    with _RUN_LOCK:
        rows = [r for r in _RUNNING.values() if (run_id is None and book_id is None)
                or (run_id and r.get("run_id") == run_id) or (book_id and r.get("book_id") == book_id)]
        for r in rows:
            r["cancelled"] = True
    for r in rows:
        claude_code.kill_tree(r.get("proc"))
    if rows:
        log.info("cli-mode cancel: %d process(es) stopped", len(rows))
    return len(rows)


def running() -> int:
    with _RUN_LOCK:
        return len(_RUNNING)


# ====================================================================== 📜 the conversation (memory only)
_EXCHANGES: deque = deque(maxlen=EXCHANGES_MAX)
_EX_LOCK = threading.Lock()
_EX_SEQ = itertools.count(1)


def task_summary(system: str) -> str:
    """The one-line task out of the module-worker system prompt ("You are a module worker … {task}\\nRules: …")."""
    s = system or ""
    m = re.search(r"book production system\.\s*(.*?)\nRules:", s, re.S)
    text = (m.group(1) if m else s).strip()
    text = re.sub(r"\s+", " ", text)
    return text[:240] + ("…" if len(text) > 240 else "")


def record(**row) -> dict:
    with _EX_LOCK:
        row = dict(row, id=next(_EX_SEQ), at=time.time())
        _EXCHANGES.append(row)
        return dict(row)


def last_id() -> int:
    with _EX_LOCK:
        return _EXCHANGES[-1]["id"] if _EXCHANGES else 0


def exchanges(after: int = 0) -> list[dict]:
    with _EX_LOCK:
        return [dict(r) for r in _EXCHANGES if r["id"] > after]


def clear_exchanges() -> None:
    with _EX_LOCK:
        _EXCHANGES.clear()


# ====================================================================== mapping a failed run to Akọwe's codes
def _err(code: str, msg: str, *, problem: str | None = None, state: str | None = None, reset_at=None,
         try_other: bool = False, retry_after: float | None = None, transient: bool = False) -> AkoweError:
    e = AkoweError(code, "", msg)
    e.site_state = state
    e.site_problem = problem
    e.reset_at = reset_at
    e.cli = True
    e.transient = transient
    if retry_after is not None:
        e.retry_after_s = retry_after
    if try_other:
        e.try_other_ai = True
    if problem == "USAGE_LIMIT":
        e.no_wait = False
    return e


def _from_cc(exc: claude_code.CCError, tool: str, site: str) -> AkoweError:
    name = f"{SITE_WORDS[site]} (command line)"
    if exc.detail == "CANCELLED":
        return _err("CAPABILITY_UNAVAILABLE", f"{name} was stopped because you pressed Cancel", problem="CANCELLED")
    if exc.state == "signed_out":
        return _err("CAPABILITY_UNAVAILABLE", f"{name} is signed out: press “⌨ Open {TOOL_NAMES[tool]}” in Settings "
                    f"and sign in ({SIGN_IN_HOW[tool]}); another AI takes the work meanwhile", problem="SIGNED_OUT",
                    state="needs_user", try_other=True)
    if exc.state == "limited":
        from . import usage_limits  # noqa: PLC0415
        until = f" until about {usage_limits.clock(exc.reset_at)}" if exc.reset_at else ""
        return _err("RATE_LIMITED", f"{name} is at your {PLAN_OF[tool]} plan's usage limit{until}; Akọwe uses another "
                    "AI or waits for the limit", problem="USAGE_LIMIT", state="needs_user", reset_at=exc.reset_at,
                    retry_after=max(60.0, (exc.reset_at - time.time())) if exc.reset_at else 600.0)
    if exc.state == "not_installed":
        return _err("CAPABILITY_UNAVAILABLE", f"{TOOL_NAMES[tool]} is not installed on this computer, so {name} can't "
                    "answer; choose “Web window” for this AI in Settings, or install it", problem="NOT_INSTALLED",
                    state="broken", try_other=True)
    if exc.code == "TIMEOUT":
        e = _err("TIMEOUT", f"{name} took too long, so Akọwe stopped it (nothing was saved); it is asked again or "
                 "another AI takes the work", problem="TIMEOUT")
        e.late_collect_tried = True  # a fresh process can safely be asked again (nothing is typed anywhere)
        return e
    return _err("UPSTREAM_UNAVAILABLE", f"{name} gave no usable answer ({exc.detail or exc.code}); Akọwe asks again "
                "or uses another AI", problem=(exc.detail or "CLI_ERROR")[:40], transient=exc.transient,
                retry_after=30.0)


def _codex_reset(text: str) -> float | None:
    """'… Try again at 3:45 PM.' / 'Try again at Nov 14th, 2026 3:45 PM.' -> epoch seconds (local time)."""
    m = _CODEX_TRY_AT_RE.search(text or "")
    if not m:
        return claude_code.parse_reset(text)
    from datetime import datetime, timedelta  # noqa: PLC0415
    hh, mm, ap = int(m.group(2)), int(m.group(3)), m.group(4).lower()
    if ap == "pm" and hh < 12:
        hh += 12
    if ap == "am" and hh == 12:
        hh = 0
    now = datetime.now()
    if m.group(1):
        try:
            day = datetime.strptime(re.sub(r"(st|nd|rd|th),", ",", m.group(1).strip()), "%b %d, %Y")
            return day.replace(hour=hh, minute=mm).timestamp()
        except ValueError:
            pass
    t = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if t <= now:
        t += timedelta(days=1)
    return t.timestamp()


def classify_codex(rc: int, answer: str | None, stdout: str, stderr: str) -> claude_code.CCError | None:
    text = f"{stdout}\n{stderr}"
    if rc == 0 and answer and answer.strip():
        return None
    if _CODEX_LIMIT_RE.search(text):
        at = _codex_reset(text)
        return claude_code.CCError("RATE_LIMITED", "usage limit", state="limited", reset_at=at, detail="USAGE_LIMIT")
    if _CODEX_AUTH_RE.search(text):
        return claude_code.CCError("PERMISSION_DENIED", "signed out", state="signed_out", detail="NOT_LOGGED_IN")
    if re.search(r"unexpected argument|unknown option|unrecognized (?:option|argument)|found argument", stderr or "",
                 re.I):
        return claude_code.CCError("UPSTREAM_UNAVAILABLE", "unknown flag", detail="UNKNOWN_FLAG")
    if rc == 0:
        return claude_code.CCError("UPSTREAM_UNAVAILABLE", "no answer", transient=True, detail="NO_RESULT")
    return claude_code.CCError("UPSTREAM_UNAVAILABLE", f"exit {rc}", transient=True, detail="CRASH")


# ====================================================================== the adapter
def claude_command(path: str, *, model: str = "", pictures: bool = False, basic: bool = False) -> list[str]:
    deny = [t for t in CLAUDE_DENY if not (pictures and t == "Read")]
    cmd = [path, "-p", CLAUDE_ARGV.format(pics=" except Read, only on the picture files in the current folder"
                                          if pictures else ""), "--output-format", "json",
           "--disallowedTools", ",".join(deny)]
    if pictures:
        cmd += ["--allowedTools", "Read"]
    if model:
        cmd += ["--model", model]
    if not basic:
        cmd += ["--permission-mode", "dontAsk", "--no-session-persistence", "--strict-mcp-config"]
    return cmd


def codex_command(path: str, *, model: str = "", images=(), basic: bool = False,
                  answer_file: str = "{work}/akowe-answer.txt") -> list[str]:
    cmd = [path, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "-C", "{work}", "-o", answer_file]
    if not basic:
        cmd += ["--ephemeral", "--color", "never"]
    if model:
        cmd += ["-m", model]
    for p in images:
        cmd += ["-i", "{work}/" + Path(p).name]
    cmd.append("-")  # the instructions come from stdin
    return cmd


class CliAdapter:
    """One AI slot in "Command line" mode (see the module docstring). Same submit() as the AutoInjector adapter."""

    adapter_id = "autoinjector"
    accepts_request_context = True
    accepts_images = True
    MAX_REASKS = MAX_REASKS

    def __init__(self, store, site: str):
        if site not in CLI_SITES:
            raise AkoweError("CAPABILITY_UNAVAILABLE", "", f"{SITE_WORDS.get(site, site)} has no command-line mode "
                             "in Akọwe yet; choose “Web window” for this AI")
        self.store = store
        self.site = site
        self.tool = TOOL_OF[site]

    def capabilities(self) -> list[str]:
        return ["text", "json"]

    def _path(self) -> str:
        st = cached(self.tool) or {}
        if st.get("state") == "off":
            raise _from_cc(claude_code.CCError("CAPABILITY_UNAVAILABLE", "off", state="not_installed"), self.tool,
                           self.site)
        if st.get("state") in ("signed_out", "limited", "not_installed"):
            raise _from_cc(claude_code.CCError("RATE_LIMITED", "", state=st["state"], reset_at=st.get("reset_at")),
                           self.tool, self.site)
        if st.get("path"):
            return st["path"]
        if self.tool == "claude":
            found = claude_code.find_cli(claude_code.settings(self.store).get("path") or "")
        else:
            found = find_codex(settings(self.store).get("codex_path") or "")
        if not found:
            note_error(self.tool, "not_installed")
            raise _from_cc(claude_code.CCError("CAPABILITY_UNAVAILABLE", "", state="not_installed"), self.tool,
                           self.site)
        return found[1]

    def _once(self, path: str, prompt: str, images: list, timeout_s: float, cancel, basic: bool) -> str:
        """One process. The answer text, or raises CCError."""
        from . import ai_activity  # noqa: PLC0415
        st = settings(self.store)
        cur = ai_activity.current()
        row = {"proc": None, "run_id": cur.get("run_id"), "book_id": cur.get("book_id")}
        key = next(_IDS)
        with _RUN_LOCK:
            _RUNNING[key] = row

        def started(proc):
            with _RUN_LOCK:
                row["proc"] = proc
            if row.get("cancelled"):
                claude_code.kill_tree(proc)

        def stop():
            return bool(row.get("cancelled")) or bool(cancel and cancel())

        gate = GATES[self.tool]
        gate.resize(st["at_once"])
        gate.acquire(stop)
        try:
            if self.tool == "claude":
                cmd = claude_command(path, model=st.get("claude_model") or claude_code.settings(self.store).get("model")
                                     or "", pictures=bool(images), basic=basic)
                rc, out, err = claude_code.run_process(cmd, prompt, timeout_s=timeout_s, cancel=stop,
                                                       files=images, on_start=started)
                if row.get("cancelled"):
                    raise claude_code.CCError("UPSTREAM_UNAVAILABLE", "stopped", detail="CANCELLED")
                res = claude_code.parse_output(out)
                bad = claude_code.classify(rc, res, err)
                if bad is None:
                    return str(res.get("structured_output") and json.dumps(res["structured_output"])
                               or res.get("result") or "")
                raise bad
            pics = " (look at the attached pictures)" if images else ""
            outdir = tempfile.mkdtemp(prefix="akowe-cli-answer-")
            answer_file = str(Path(outdir) / "answer.txt")
            try:
                cmd = codex_command(path, model=st.get("codex_model") or "", images=images, basic=basic,
                                    answer_file=answer_file)
                rc, out, err = claude_code.run_process(cmd, CODEX_PREAMBLE.format(pics=pics) + prompt,
                                                       timeout_s=timeout_s, cancel=stop, env=codex_env(),
                                                       files=images, on_start=started)
                try:
                    answer = Path(answer_file).read_text(encoding="utf-8", errors="replace").strip()
                except OSError:
                    answer = ""
            finally:
                shutil.rmtree(outdir, ignore_errors=True)
            if row.get("cancelled"):
                raise claude_code.CCError("UPSTREAM_UNAVAILABLE", "stopped", detail="CANCELLED")
            answer = answer or (out or "").strip()  # -o is the answer; stdout also carries the last message
            if images and _IMAGE_FLAG_RE.search(err or ""):
                raise claude_code.CCError("UPSTREAM_UNAVAILABLE", "no pictures", detail="NO_PICTURES")
            bad = classify_codex(rc, answer, out, err)
            if bad is not None:
                raise bad
            return answer
        finally:
            gate.release()
            with _RUN_LOCK:
                _RUNNING.pop(key, None)

    def submit(self, slot: dict, system: str, user: str, schema: dict, *, request_id: str | None = None,
               attempt: int = 0, deadline: str | None = None, call: int = 0, images=None, cancel=None):
        from .providers import (AutoInjectorAdapter, estimate_tokens, extract_json_object,  # noqa: PLC0415
                                looks_like_refusal, schema_errors)
        images = [str(p) for p in (images or [])]
        for p in images:
            if not Path(p).is_file():
                raise AkoweError("INVALID_INPUT", "/images", "a picture to look at was not found", status="REJECTED")
        st = settings(self.store)
        timeout_s = float(st["timeout_s"])
        if deadline:
            timeout_s = max(30.0, min(timeout_s, AutoInjectorAdapter.timeout_ms(deadline) / 1000.0))
        path = self._path()
        name = f"{SITE_WORDS[self.site]} (command line)"
        errors: list[str] = []
        in_tok = out_tok = 0
        refused = False
        t0 = time.monotonic()
        task = task_summary(system)
        for reask in range(self.MAX_REASKS + 1):
            prompt = AutoInjectorAdapter.build_prompt(system, user, schema, errors)
            basic = False
            tries = 0
            while True:
                tries += 1
                try:
                    text = self._once(path, prompt, images, timeout_s, cancel, basic)
                    break
                except claude_code.CCError as exc:
                    if exc.detail == "UNKNOWN_FLAG" and not basic:
                        basic = True  # an older tool: once more with the basic flags only
                        continue
                    if exc.detail == "NO_PICTURES":
                        record(slot_id=slot.get("slot_id"), site=self.site, tool=self.tool, task=task,
                               answer="", outcome="NO_PICTURES", seconds=round(time.monotonic() - t0, 1))
                        e = _err("CAPABILITY_UNAVAILABLE", f"{name} can't look at pictures; another AI is asked",
                                 problem="NO_PICTURES", try_other=True)
                        raise e from None
                    if exc.transient and tries < 2 and exc.detail != "CANCELLED":
                        log.info("cli-mode tool=%s request_id=%s: %s (%s), trying once more", self.tool, request_id,
                                 exc.code, exc.detail)
                        continue
                    note_error(self.tool, exc.state, exc.reset_at, exc.code)
                    log.info("cli-mode tool=%s request_id=%s attempt=%s outcome=%s/%s elapsed=%.1fs", self.tool,
                             request_id, attempt + 1, exc.code, exc.detail, time.monotonic() - t0)
                    record(slot_id=slot.get("slot_id"), site=self.site, tool=self.tool, task=task, answer="",
                           outcome=(exc.detail or exc.code)[:40], seconds=round(time.monotonic() - t0, 1))
                    raise _from_cc(exc, self.tool, self.site) from None
            in_tok += estimate_tokens(prompt)
            out_tok += estimate_tokens(text)
            data = extract_json_object(text)
            errors = ["/: the reply contained no JSON object"] if data is None else schema_errors(schema, data)
            log.info("cli-mode tool=%s request_id=%s attempt=%s reask=%s chars_out=%s outcome=%s elapsed=%.1fs",
                     self.tool, request_id, attempt + 1, reask, len(text), "ok" if not errors else "schema_invalid",
                     time.monotonic() - t0)
            record(slot_id=slot.get("slot_id"), site=self.site, tool=self.tool, task=task, answer=text[:1500],
                   outcome="ok" if not errors else "SCHEMA", seconds=round(time.monotonic() - t0, 1),
                   pictures=len(images))
            if not errors:
                return data, {"model": f"cli:{self.tool}", "input_tokens": in_tok, "output_tokens": out_tok,
                              "provider_request_id": request_id}
            refused = data is None and looks_like_refusal(text)
        if refused:
            err = AkoweError("AI_DECLINED", "", f"{name} declined to answer this request {self.MAX_REASKS + 1} "
                             "times; nothing was saved")
            err.refusal = err.declined = True
            err.no_wait = True
        else:
            err = AkoweError("INTERNAL_ERROR", "", f"{name} did not return JSON matching the output schema after "
                             f"{self.MAX_REASKS + 1} tries; nothing was saved. Last errors: " + "; ".join(errors[:5]))
        err.try_other_ai = True
        raise err


# ====================================================================== the preset and the HTTP routes
PRESET_TWO = {"AI-1": {"adapter_id": "autoinjector", "site": "claude", "mode": "cli"},
              "AI-2": {"adapter_id": "autoinjector", "site": "chatgpt", "mode": "cli"},
              "AI-3": {"adapter_id": "none"}}


def apply_preset(providers, name: str) -> list[dict]:
    """“Two AIs: Claude + ChatGPT on command line, Gemini off”, or "web" (all three back to web windows)."""
    if name == "two_cli":
        for sid, cfg in PRESET_TWO.items():
            providers.configure_slot(sid, dict(cfg))
    elif name == "web":
        from .providers import AUTOINJECTOR_DEFAULT_SITES  # noqa: PLC0415
        for sid, site in AUTOINJECTOR_DEFAULT_SITES.items():
            providers.configure_slot(sid, {"adapter_id": "autoinjector", "site": site, "mode": "web"})
    else:
        raise AkoweError("INVALID_INPUT", "/preset", "preset: two_cli or web", status="REJECTED")
    log.info("cli-mode preset applied: %s", name)
    return providers.slots()


def public(store, providers=None, *, force: bool = False, after: int = 0) -> dict:
    tools = {}
    for tool in ("claude", "codex"):
        cur = detect(store, tool, force=True) if force else cached(tool)
        if cur is None:
            _detect_in_background(tool)
            cur = {"state": "checking"}
        cur = dict(cur)
        cur["words"] = words(tool, cur) if cur.get("state") != "off" else STATE_WORDS["off"]
        cur.pop("path", None) if not force else None
        tools[tool] = {k: cur.get(k) for k in ("state", "words", "version", "where", "reset_at", "code")}
        tools[tool]["name"] = TOOL_NAMES[tool]
    tools["codex"]["install_url"] = CODEX_INSTALL_URL
    tools["codex"]["install_cmd"] = CODEX_INSTALL_CMD
    tools["claude"]["install_url"] = claude_code.INSTALL_URL
    slots = []
    if providers is not None:
        for s in providers.slots():
            slots.append({"slot_id": s["slot_id"], "site": s.get("site"), "adapter_id": s["adapter_id"],
                          "mode": s.get("mode") or "web", "cli": is_cli(s),
                          "can_cli": s["adapter_id"] == "autoinjector" and s.get("site") in CLI_SITES})
    return {"settings": settings(store), "tools": tools, "slots": slots, "running": running(),
            "exchanges": exchanges(after), "last_id": last_id(), "sites": list(CLI_SITES),
            "about": "Command line: Akọwe runs the AI's own command-line tool on this computer (Claude Code for "
                     "Claude, Codex for ChatGPT) instead of typing into its web window. It uses the same plan you "
                     "sign in with, so it shares that plan's usage limits."}


def route(app, method: str, rest: list, body, query=None) -> tuple[int, dict]:
    """/cli-mode[...]"""
    store = app.store
    prov = app.engine.providers
    if rest == [] and method == "GET":
        try:
            after = int(((query or {}).get("after") or ["0"])[0])
        except (TypeError, ValueError):
            after = 0
        return 200, public(store, prov, after=after)
    if rest == [] and method == "PUT":
        save_settings(store, body)
        return 200, public(store, prov)
    if rest == ["check"] and method == "POST":
        return 200, public(store, prov, force=True)
    if rest == ["preset"] and method == "POST":
        name = body.get("preset") if isinstance(body, dict) else None
        apply_preset(prov, name)
        return 200, public(store, prov)
    if rest == ["exchanges"] and method == "DELETE":
        clear_exchanges()
        return 200, {"ok": True}
    raise AkoweError("NOT_FOUND", "/cli-mode/" + "/".join(rest), "no such endpoint", status="REJECTED")


def open_codex_window(store, *, local: bool, launcher=None, finder=None) -> dict:
    """⌨ Open Codex: a command window on this computer running ``codex login`` (the same rules as Open Claude
    Code: this computer only, fixed commands only)."""
    from . import claude_code_window as ccw  # noqa: PLC0415
    if not local:
        raise ccw.WindowError("LOCAL_ONLY", "Codex can only be opened on the computer Akọwe runs on.")
    found = (finder or find_codex)(settings(store).get("codex_path") or "")
    if not found:
        raise ccw.WindowError("NOT_INSTALLED", "Codex is not installed yet. Install it first (in a command window: "
                              f"{CODEX_INSTALL_CMD}), then press “⌨ Open Codex” again.")
    cmd = ccw.commands("claude", found[1], args=("login",))
    try:
        (launcher or ccw._launch)(cmd, ccw._home(), codex_env())  # noqa: SLF001
    except Exception as exc:  # noqa: BLE001
        log.warning("codex window open failed: %s", type(exc).__name__)
        raise ccw.WindowError("OPEN_FAILED", "The window could not be opened (" + type(exc).__name__ + "). Open a "
                              "command prompt yourself and type: codex login") from exc
    forget_status()
    log.info("codex window opened")
    return {"ok": True, "kind": "codex", "message": "Codex is open in a new window and asks you to sign in with your "
            "ChatGPT account. When it says you are signed in, come back and press “↻ Check again”."}
