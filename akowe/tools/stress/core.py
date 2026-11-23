"""Shared core of the ⚡ Make-a-book stress harness.

Nothing here changes product code: faults are injected from the outside (a fake AI, an in-process AutoInjector bridge,
monkeypatches that the harness undoes), and every scenario runs in its own throw-away data folder under /dev/shm.

Pieces (all usable from a ``section_<letter>.py`` module without editing this file):

* ``ChaosAI``      the Practice AI (tests/autobook_fake.BookFakeAI) plus fault ``Rule``s matched by answer kind, by the
                   run's current step, by call number, by slot and by probability (seeded); actions: ``timeout()``,
                   ``busy()``, ``usage_limit()``, ``declined()``, ``fail(code)``, ``replace(value|fn)``,
                   ``text(str|fn)`` (raw reply text, only through the bridge), ``crash()`` (a simulated process stop),
                   ``hang(event)`` and ``callback(fn)``.
* ``ChaosBridge``  a tiny AutoInjector bridge (contract v1.2) on 127.0.0.1 that answers with the ChaosAI, so raw reply
                   text goes through the REAL AutoInjectorAdapter (JSON extraction, schema checks, re-asks).
* ``Harness``      one scenario: app(s), start / wait (hang detection) / pause / resume / cancel / restart (drop the
                   App, new App on the same data folder, resume), fix (remove every fault), the book check, the problem
                   check, the log scan (tracebacks, ERRORs, book text and keys) and ``standard()`` = the usual
                   fault -> stop? -> remove fault -> resume -> finished? flow with the classification.
* ``Section``      the registry: parts, subsections and stress functions (decorator). ``std_stresses`` registers the
                   generic a–i stresses for a part from a ``Target``.
* report writer    ``write_reports`` -> docs/stress/<L>-<slug>.md + <L>-results.json (merged by result ID, so a
                   partial rerun updates only its rows) and ``write_index`` -> docs/stress/README.md.

Result IDs: ``<Section>-<part>[.<sub>]-<stress>`` e.g. ``A-2-k``, ``C-10.2-a``.
"""
from __future__ import annotations

import copy
import importlib
import json
import logging
import os
import random
import shutil
import sys
import tempfile
import threading
import time
import traceback
import types
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

# ----------------------------------------------------------------------------------------------- environment first
ROOT = Path(__file__).resolve().parents[2]          # the akowe folder (holds akowe/, tests/, tools/)
REPO = ROOT.parent
DOCS = REPO / "docs" / "stress"
_SHM = Path("/dev/shm")
TMP_BASE = (_SHM if _SHM.is_dir() and os.access(_SHM, os.W_OK) else Path(tempfile.gettempdir())) / \
    f"akowe-stress-{os.getpid()}"
TMP_BASE.mkdir(parents=True, exist_ok=True)
# the same safety switches as tests/conftest.py: never the real books folder, no auto-save, no real picture bridge,
# no real Claude Code CLI
os.environ.setdefault("AKOWE_BOOKS_DIR", str(TMP_BASE / "books"))
os.environ.setdefault("AKOWE_AUTOSAVE", "0")
os.environ.setdefault("AKOWE_IMAGE_BRIDGE", "http://127.0.0.1:9")
os.environ.setdefault("AKOWE_CLAUDE_CODE", "off")
for _p in (str(ROOT), str(ROOT / "tests")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from akowe import providers as prov_mod  # noqa: E402
from akowe import usage_limits  # noqa: E402
from akowe.autobook import AutoBookService  # noqa: E402
from akowe.errors import AkoweError  # noqa: E402
from akowe.jobs import RetryPolicy  # noqa: E402
from akowe.server import App  # noqa: E402

from autobook_fake import BookFakeAI, trust_one_ai  # noqa: E402

log = logging.getLogger("akowe.stress")

HANDLED, SAFE, PROBLEM, RISKY = "✅", "🟡", "❌", "⚠️"
RANK = {HANDLED: 0, SAFE: 1, RISKY: 2, PROBLEM: 3}
WORDS = {HANDLED: "HANDLED", SAFE: "SAFE STOP", PROBLEM: "PROBLEM", RISKY: "WORKED BUT RISKY"}
LIKELY, UNLIKELY = "likely in real use", "unlikely but dangerous"
SEVERITIES = ["would lose work", "crash/hang", "blocks the book needlessly", "confusing message", "cosmetic"]

STANDARD = {
    "a": "the AI times out (once; and every time)",
    "b": "the AI is busy / rate-limited, then recovers",
    "c": "every AI at its usage limit, then recovers",
    "d": "garbage answer (not JSON / wrong types / missing keys)",
    "e": "empty answer",
    "f": "the AI refuses (AI_DECLINED) repeatedly",
    "g": "the part's own code raises an unexpected Python exception",
    "h": "the program restarts during this part (new App on the same data, resume)",
    "i": "pause then resume during this part; cancel during it then start a new book",
    "j": "the most likely real-life problem for this part",
}

TOKEN = "stress-app-token-0123456789abcdef"
CANARY_KEY = "sk-ant-api03-STRESSCANARYKEY-0123456789abcdefghijklmnop"     # an API key that must never leak
BRIDGE_KEY = "stress-bridge-CANARYTOKEN-0123456789abcdefghijklmn"         # the bridge connection key
KEYS = (CANARY_KEY, BRIDGE_KEY)
# words of the Practice AI's lighthouse book: in logs they mean book text leaked (the journal may show them)
BOOK_TEXT = ["Keeper of Gullhaven", "Gullhaven", "Mara Vell", "brass key", "Rowan Ashby", "fog-bound harbor"]
SITE_SLOT = {"claude": "AI-1", "chatgpt": "AI-2", "gemini": "AI-3"}
SLOT_SITE = {v: k for k, v in SITE_SLOT.items()}


class SimulatedCrash(BaseException):
    """Raised in a run's thread to stop it like a closed program: no except clause of the product catches it."""


class RawText(str):
    """A raw reply text (sent as is through the ChaosBridge; the real adapter has to make sense of it)."""


# ================================================================================================ fault injection
@dataclass
class Call:
    n: int
    kind: str
    slot: str
    step: str | None
    ctx: dict
    props: list
    out: object = None


class Rule:
    """One fault. Matches a call when every given filter matches; ``times`` = how often it fires (None = always),
    ``skip`` = matching calls to let through first, ``prob`` = chance per matching call (the chaos RNG, seeded)."""

    def __init__(self, action: Callable, *, name: str = "", kinds=None, step=None, calls=None, slots=None,
                 prob: float = 1.0, times: int | None = None, skip: int = 0, when: Callable | None = None):
        self.action, self.name = action, name or getattr(action, "__name__", "fault")
        self.kinds = {kinds} if isinstance(kinds, str) else (set(kinds) if kinds else None)
        self.step = {step} if isinstance(step, str) else (set(step) if step else None)
        self.calls = set(calls) if calls is not None else None
        self.slots = {slots} if isinstance(slots, str) else (set(slots) if slots else None)
        self.prob, self.times, self.skip, self.when = prob, times, skip, when
        self.seen = 0
        self.fired = 0

    def matches(self, c: Call, rng: random.Random) -> bool:
        if self.times is not None and self.fired >= self.times:
            return False
        if self.kinds is not None and c.kind not in self.kinds:
            return False
        if self.step is not None and c.step not in self.step:
            return False
        if self.calls is not None and c.n not in self.calls:
            return False
        if self.slots is not None and c.slot not in self.slots:
            return False
        if self.when is not None and not self.when(c):
            return False
        self.seen += 1
        if self.seen <= self.skip:
            return False
        if self.prob < 1.0 and rng.random() >= self.prob:
            return False
        return True


def fail(code: str, message: str | None = None, **attrs) -> Callable:
    def action(c: Call):
        exc = AkoweError(code, "", message or f"stress fault {code}")
        for k, v in attrs.items():
            setattr(exc, k, v)
        raise exc
    action.__name__ = f"fail:{code}"
    return action


def timeout() -> Callable:
    return fail("TIMEOUT", "the AI did not answer in time (stress)")


def busy() -> Callable:
    return fail("RATE_LIMITED", "the AI is busy (stress)")


def usage_limit() -> Callable:
    def action(c: Call):
        usage_limits.note(["Claude", "ChatGPT", "Gemini"])
        exc = AkoweError("UPSTREAM_UNAVAILABLE", "", "every AI is at its usage limit (stress)")
        exc.usage_limited, exc.limited_names, exc.reset_at = True, ["Claude", "ChatGPT", "Gemini"], None
        raise exc
    action.__name__ = "usage_limit"
    return action


def declined() -> Callable:
    return fail("AI_DECLINED", "the AI declined to answer (stress)", try_other_ai=True, declined=True,
                retry_after_s=0.01, site_state=None, site_problem="AI_DECLINED", reset_at=None)


def replace(value_or_fn) -> Callable:
    def action(c: Call):
        return value_or_fn(c) if callable(value_or_fn) else copy.deepcopy(value_or_fn)
    action.__name__ = "replace"
    return action


def text(value_or_fn) -> Callable:
    def action(c: Call):
        return RawText(value_or_fn(c) if callable(value_or_fn) else value_or_fn)
    action.__name__ = "text"
    return action


def crash() -> Callable:
    def action(c: Call):
        raise SimulatedCrash(f"program stopped during call {c.n} ({c.kind})")
    action.__name__ = "crash"
    return action


def hang(event: threading.Event, limit: float = 600.0) -> Callable:
    def action(c: Call):
        event.wait(limit)
    action.__name__ = "hang"
    return action


def callback(fn: Callable) -> Callable:
    def action(c: Call):
        fn(c)
    action.__name__ = getattr(fn, "__name__", "callback")
    return action


class ChaosAI(BookFakeAI):
    """BookFakeAI (= the Practice AI + test hooks) plus fault rules. ``step_fn`` names the run's current step."""

    def __init__(self, seed: int = 0, **kw):
        super().__init__(**kw)
        self.rules: list[Rule] = []
        self.rng = random.Random(seed)
        self.n = 0
        self.step_fn: Callable[[], str | None] | None = None
        self.trace: list[tuple] = []      # (n, kind, step, slot, fault name or "")
        self.events: list[threading.Event] = []

    def add(self, *rules: Rule) -> "ChaosAI":
        self.rules.extend(rules)
        return self

    def clear(self):
        """The fault is removed: no rule fires any more; hung calls are released."""
        self.rules = []
        for ev in self.events:
            ev.set()

    def faults_fired(self) -> int:
        return sum(1 for t in self.trace if t[4])

    def submit(self, slot, system, user, schema):
        package = json.loads(user.split("\n", 1)[1])
        ctx = package.get("context") or {}
        props = schema.get("properties") or {}
        usage = {"model": "stress-model", "input_tokens": 10, "output_tokens": 20}
        with self.lock:
            self.n += 1
            n = self.n
            self.calls.append({"slot": slot["slot_id"], "props": sorted(props)})
        step = None
        try:
            step = self.step_fn() if self.step_fn else None
        except Exception:  # noqa: BLE001
            step = None
        if ctx.get("akowe_task") == "stand_in":
            kind, out = "stand_in", self._stand_in(slot["slot_id"], ctx)
        else:
            kind, out = self._answer(ctx, props, schema)
        c = Call(n, kind, slot["slot_id"], step, ctx, sorted(props), out)
        for rule in list(self.rules):
            if rule.matches(c, self.rng):
                rule.fired += 1
                with self.lock:
                    self.trace.append((n, kind, step, slot["slot_id"], rule.name))
                    self.kinds.append(f"fault:{kind}:{rule.name}")
                res = rule.action(c)  # may raise
                if res is not None:
                    out = res
                    c.out = out
                break
        else:
            with self.lock:
                self.trace.append((n, kind, step, slot["slot_id"], ""))
        with self.lock:
            self.prompts.setdefault(kind, []).append((system, ctx))
            self.kinds.append(kind)
        if isinstance(out, RawText) and not getattr(self, "_via_bridge", False):
            raise RuntimeError("text() faults need wire='bridge' (the real adapter must read the raw text)")
        return out, usage


class ChaosBridge:
    """An AutoInjector bridge (contract v1.2) answering /v1/complete with the ChaosAI; faults become the bridge's
    real HTTP answers (504 timeout, 409 busy, 503 SITE_ERROR rate-limit / refused, 500), raw texts are sent as is."""

    def __init__(self, ai: ChaosAI, token: str = BRIDGE_KEY):
        self.ai, self.token = ai, token
        ai._via_bridge = True
        self.seq = 0
        self.completes = 0
        bridge = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _auth(self):
                a = self.headers.get("Authorization") or ""
                if a != f"Bearer {bridge.token}":
                    self._send(401, {"ok": False, "error": "UNAUTHORIZED"})
                    return False
                return True

            def do_GET(self):
                if not self._auth():
                    return
                now = int(time.time() * 1000)
                sites = {s: {"ready": True, "busy": False, "state": "ok", "problem": None, "since": now,
                             "last_probe_ok_at": now} for s in SITE_SLOT}
                self._send(200, {"ok": True, "bridge_version": "1.2", "sites": sites})

            def do_POST(self):
                if not self._auth():
                    return
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path == "/v1/probe":
                    return self._send(202, {"ok": True, "started": body.get("sites") or [], "skipped": {}})
                if self.path != "/v1/complete":
                    return self._send(404, {"ok": False, "error": "NOT_FOUND"})
                site = body.get("site")
                prompt = body.get("prompt") or ""
                try:
                    pkg = prompt.split("Project context package (JSON):\n", 1)[1].split("\n\nJSON_SCHEMA:", 1)[0]
                    schema = json.loads(prompt.split("JSON_SCHEMA:\n", 1)[1].split("\nEND_JSON_SCHEMA", 1)[0])
                except (IndexError, ValueError):
                    # a short re-ask ("your last answer was not valid JSON") in the same chat: answer it again
                    pkg, schema = bridge._last.get(site, ("{}", {"type": "object"}))
                bridge._last[site] = (pkg, schema)
                try:
                    data, _ = bridge.ai.submit({"slot_id": SITE_SLOT.get(site, site), "site": site}, "",
                                               "Project context package (JSON):\n" + pkg, schema)
                except AkoweError as exc:
                    return self._send(*bridge._http_error(exc))
                bridge.seq += 1
                bridge.completes += 1
                seq = f"{bridge.seq:04d}"
                reply = data if isinstance(data, RawText) else json.dumps(data, ensure_ascii=False)
                self._send(200, {"ok": True, "site": site, "request_id": body.get("request_id"), "text": str(reply),
                                 "seq": seq, "reply_to": seq, "elapsed_ms": 3, "followup": True})

        self._last: dict = {}
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True, name="stress-bridge").start()

    @staticmethod
    def _http_error(exc: AkoweError) -> tuple[int, dict]:
        if exc.code == "TIMEOUT":
            return 504, {"ok": False, "error": "TIMEOUT", "typed": False}
        if exc.code == "RATE_LIMITED":
            return 409, {"ok": False, "error": "SITE_BUSY"}
        if exc.code == "AI_DECLINED":
            return 503, {"ok": False, "error": "SITE_ERROR", "site_error": "refused", "declined": True,
                         "retry_after_s": 0.01}
        if exc.code == "UPSTREAM_UNAVAILABLE":
            return 503, {"ok": False, "error": "SITE_ERROR", "site_error": "rate-limit" if getattr(
                exc, "usage_limited", False) else "error", "retry_after_s": 0.01}
        return 500, {"ok": False, "error": exc.code}

    def close(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:  # noqa: BLE001
            pass


# ================================================================================================ logs
class LogTap(logging.Handler):
    """Every record of the ``akowe`` loggers while a scenario runs (formatted with its traceback, if any)."""

    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.records: list[dict] = []
        self._fmt = logging.Formatter("%(levelname)s %(name)s %(message)s")

    def emit(self, record):
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001
            msg = str(record.msg)
        exc = ""
        if record.exc_info:
            exc = "".join(traceback.format_exception(*record.exc_info))
        self.records.append({"level": record.levelname, "levelno": record.levelno, "logger": record.name,
                             "message": msg, "exc": exc, "thread": record.threadName})


def scrub(s, extra: list | None = None) -> str:
    """Report-safe text: book words and keys replaced, one line, clipped."""
    s = str(s or "")
    for k in KEYS:
        s = s.replace(k, "‹key›")
    for w in sorted(set(BOOK_TEXT + list(extra or [])), key=len, reverse=True):
        if w:
            s = s.replace(w, "‹book text›")
    return " ".join(s.split())[:400]


# ================================================================================================ results
@dataclass
class Outcome:
    id: str
    section: str
    part: str
    stress: str
    title: str
    result: str = HANDLED
    happened: str = ""
    status: str = ""              # the run's status when it first stopped
    final_status: str = ""        # after the fault was removed and the run resumed (if it had to be)
    problem_code: str = ""
    problem_message: str = ""
    problem_fix: str = ""
    issues: list = field(default_factory=list)   # what made it ❌
    risks: list = field(default_factory=list)    # what made it ⚠️
    notes: list = field(default_factory=list)
    faults_fired: int = 0
    ai_calls: int = 0
    seconds: float = 0.0
    likely: str = ""
    log_errors: int = 0
    log_tracebacks: int = 0
    event_codes: list = field(default_factory=list)
    alert: dict = field(default_factory=dict)    # what the author's alert said at the first stop (label/why/next)
    finding: dict = field(default_factory=dict)

    def worst(self, other: "Outcome") -> "Outcome":
        """Combine two variants of one stress (e.g. a = once and every time): the worse result wins."""
        out = copy.deepcopy(self if RANK[self.result] >= RANK[other.result] else other)
        out.happened = f"{self.happened} — {other.happened}" if other.happened else self.happened
        for k in ("issues", "risks", "notes", "event_codes"):
            seen = []
            for x in getattr(self, k) + getattr(other, k):
                if x not in seen:
                    seen.append(x)
            setattr(out, k, seen)
        out.faults_fired = self.faults_fired + other.faults_fired
        out.ai_calls = self.ai_calls + other.ai_calls
        out.seconds = round(self.seconds + other.seconds, 2)
        out.log_errors = self.log_errors + other.log_errors
        out.log_tracebacks = self.log_tracebacks + other.log_tracebacks
        return out


# ================================================================================================ the harness
_SAVED_EXCEPTHOOK = threading.excepthook


def _quiet_crash_hook(args):
    if args.exc_type is SimulatedCrash:
        return
    _SAVED_EXCEPTHOOK(args)


class Harness:
    """One stress scenario. Use as a context manager (cleans its data folder, threads, patches and log handler)."""

    def __init__(self, sid: str, section: str, part: str, stress: str, title: str, *, seed: int = 0,
                 time_limit: float = 90.0, likely: str = ""):
        self.id, self.section, self.part, self.stress, self.title = sid, section, part, stress, title
        self.seed, self.time_limit, self.likely = seed, time_limit, likely
        self.tmp = Path(tempfile.mkdtemp(prefix=f"{sid}-", dir=TMP_BASE))
        self.apps: list = []
        self.app = None
        self.bridges: list[ChaosBridge] = []
        self.chaos = ChaosAI(seed=seed)
        self.chaos.step_fn = self.current_step
        self.run_id: str | None = None
        self.tap = LogTap()
        self._patches: list[tuple] = []
        self._fixes: list[Callable] = []
        self.markers: list[str] = []   # extra book words for the leak scan (e.g. the author's idea)
        self.t0 = time.monotonic()
        self.wire = "direct"
        self.slots = 2
        self.first_problem: dict = {}
        self.baseline: set | None = None   # books that existed before the first start (made by the scenario)
        self.first_trace: list = []

    # ------------------------------------------------------------------ context
    def __enter__(self):
        logging.getLogger("akowe").addHandler(self.tap)
        self._old_level = logging.getLogger("akowe").level
        logging.getLogger("akowe").setLevel(logging.DEBUG)
        threading.excepthook = _quiet_crash_hook
        # the providers' own short retry sleeps (1-4 s) take no time here (like tests/test_failover_review.py)
        self.patch(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                           time=time.time))
        usage_limits.clear()
        return self

    def __exit__(self, *exc):
        self.chaos.clear()
        for app in self.apps:
            try:
                for r in app.autobook.active():
                    app.autobook.cancel(r.get("principal") or "author", r["id"])
                for r in list(app.autobook._threads):  # noqa: SLF001
                    app.autobook.wait_for(r, 20)
            except Exception:  # noqa: BLE001
                pass
            self._stop_app(app)
        for b in self.bridges:
            b.close()
        self.unpatch_all()
        usage_limits.clear()
        logging.getLogger("akowe").removeHandler(self.tap)
        logging.getLogger("akowe").setLevel(self._old_level)
        threading.excepthook = _SAVED_EXCEPTHOOK
        shutil.rmtree(self.tmp, ignore_errors=True)
        return False

    @staticmethod
    def _stop_app(app):
        sv = getattr(app, "saver", None)
        try:
            sv.wait_idle(15, timers=True)   # a save it started finishes before its folder is removed
        except Exception:  # noqa: BLE001
            pass
        for fn in ("stop_periodic", "stop_timers"):
            try:
                getattr(sv, fn)()
            except Exception:  # noqa: BLE001
                pass

    # ------------------------------------------------------------------ patches and fixes
    def patch(self, obj, name: str, value):
        """Monkeypatch (undone by fix() and at the end)."""
        self._patches.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    def unpatch_all(self):
        while self._patches:
            obj, name, old = self._patches.pop()
            setattr(obj, name, old)

    def on_fix(self, fn: Callable):
        self._fixes.append(fn)

    def fix(self):
        """Remove every fault: chaos rules, monkeypatches (except the fast sleeps) and registered fix callbacks."""
        self.chaos.clear()
        fast = [(o, n, old) for (o, n, old) in self._patches if o is prov_mod and n == "time"]
        others = [(o, n, old) for (o, n, old) in self._patches if not (o is prov_mod and n == "time")]
        while others:
            obj, name, old = others.pop()
            setattr(obj, name, old)
        self._patches = fast
        for fn in self._fixes:
            try:
                fn()
            except Exception:  # noqa: BLE001
                log.exception("stress fix callback")
        self._fixes = []
        usage_limits.clear()

    def at_step(self, step: str, before: Callable | None = None, after: Callable | None = None, times: int = 1):
        """Run ``before(run)`` / ``after(run)`` around the step's own method (``AutoBookService._s_<step>``)."""
        orig = getattr(AutoBookService, f"_s_{step}")
        count = {"n": 0}

        def wrapped(svc, run, st):
            count["n"] += 1
            live = count["n"] <= times
            if live and before:
                before(run)
            res = orig(svc, run, st)
            if live and after:
                after(run)
            return res
        self.patch(AutoBookService, f"_s_{step}", wrapped)
        return count

    # ------------------------------------------------------------------ apps
    def make_app(self, wire: str = "direct", slots: int = 2, name: str = "data"):
        """wire='direct': AI-1 (anthropic, with a canary API key) and AI-2 (manual) answered by the ChaosAI, like
        tests/test_autobook.make_app. wire='bridge': three AutoInjector slots through a ChaosBridge (real adapter)."""
        self.wire, self.slots = wire, slots
        app = App(self.tmp / name, token=TOKEN)
        self._plumb(app)
        self.apps.append(app)
        self.app = app
        return app

    def _plumb(self, app):
        pr = app.engine.providers
        pr.secret_path = self.tmp / "secrets.json"
        pr.health.hold_s = 0.0
        if self.wire == "bridge":
            if not self.bridges:
                self.bridges.append(ChaosBridge(self.chaos))
            pr.connect_autoinjector(BRIDGE_KEY, self.bridges[0].url)
            if self.slots < 3:
                for sid in ("AI-3", "AI-2")[: 3 - self.slots]:
                    pr.configure_slot(sid, {"adapter_id": "none"})
        else:
            pr.test_adapter = self.chaos
            pr.configure_slot("AI-1", {"adapter_id": "anthropic", "api_key": CANARY_KEY})
            if self.slots >= 2:
                pr.configure_slot("AI-2", {"adapter_id": "manual", "input_cost_minor_per_mtok": 9000,
                                           "output_cost_minor_per_mtok": 40000})
        fast = RetryPolicy([0.01, 0.02], 3, limit_wait_s=20, limit_check_s=0.05)
        for svc in (app.autobook, app.write_all, app.assist):
            svc.retry_policy = fast
        app.autobook.probe_poll_s = app.write_all.probe_poll_s = 0.01
        app.autobook.probe_timeout_s = app.write_all.probe_timeout_s = 3

    def restart(self):
        """The program 'restarts': the old App is dropped (its run thread must already be gone — see crash()), a new
        App opens the same data folder (start-up marks live work interrupted) and becomes ``self.app``."""
        old = self.app
        if old is not None and self.run_id:
            old.autobook.wait_for(self.run_id, 15)
            if old.autobook.alive(self.run_id):
                raise RuntimeError("restart(): the old run thread is still alive")
        if old is not None:
            self._stop_app(old)
        app = App(self.tmp / "data", token=TOKEN)
        self._plumb(app)
        self.apps.append(app)
        self.app = app
        return app

    # ------------------------------------------------------------------ runs
    def current_step(self) -> str | None:
        app = self.app
        if app is None:
            return None
        for r in app.autobook.active():
            return r.get("current")
        if self.run_id:
            r = app.autobook.get(self.run_id)
            return (r or {}).get("current")
        return None

    def start(self, body: dict | None = None) -> str:
        if self.baseline is None:
            self.baseline = set(self.projects())
        r = self.app.autobook.start("author", dict({"author_confirms": True, "length": "short_story",
                                                    "pictures": False}, **(body or {})))
        self.run_id = r["id"]
        return r["id"]

    def wait(self, run_id: str | None = None, limit: float | None = None) -> bool:
        """Wait for the run's thread; False = still alive after the time limit (a hang)."""
        rid = run_id or self.run_id
        self.app.autobook.wait_for(rid, limit or self.time_limit)
        return not self.app.autobook.alive(rid)

    def settle(self, run_id: str | None = None):
        """One AI only (H6): approve like an author who trusts it (never needed with two AIs)."""
        rid = run_id or self.run_id
        trust_one_ai(self.app, rid, self.time_limit)

    def run(self, run_id: str | None = None) -> dict:
        rid = run_id or self.run_id
        return self.app.autobook.public(self.app.autobook.get(rid))

    def raw(self, run_id: str | None = None) -> dict:
        return self.app.autobook.get(run_id or self.run_id)

    def pause(self):
        self.app.autobook.pause("author", self.run_id)

    def cancel(self):
        self.app.autobook.cancel("author", self.run_id)

    def resume(self) -> bool:
        self.app.autobook.resume("author", self.run_id)
        ok = self.wait()
        if ok:
            self.settle()
        return ok

    def release(self):
        self.chaos.clear()

    # ------------------------------------------------------------------ checks
    def projects(self) -> list[str]:
        return [r["project_id"] for r in self.app.store.query("SELECT project_id FROM projects")]

    def new_projects(self) -> list[str]:
        """Books made since the first start (a scenario's own setup books are not counted)."""
        return [p for p in self.projects() if p not in (self.baseline or set())]

    def book_check(self, run: dict | None = None) -> list[str]:
        """What is wrong with a run that says done (empty list = the book is complete)."""
        run = run or self.run()
        bad = []
        if run.get("status") != "done":
            return [f"run status {run.get('status')}"]
        pid = run.get("project_id")
        if not pid or self.app.store.project(pid) is None:
            return ["the run's book does not exist"]
        from akowe.book_path import get_profile  # noqa: PLC0415
        prof = get_profile(self.app.store, pid)
        if not str(prof.get("title") or "").strip():
            bad.append("the book has no title")
        if not str(prof.get("idea") or "").strip():
            bad.append("the book has no idea")
        for s in run.get("steps") or []:
            if s.get("state") not in ("done", "skipped"):
                bad.append(f"step {s['id']} is {s.get('state')}")
        if not run.get("files"):
            bad.append("no exported files")
        ch = next((s for s in run.get("steps") or [] if s["id"] == "chapters"), {})
        if ch and any(i.get("state") != "done" for i in ch.get("items") or []):
            bad.append("a chapter is not done")
        return bad

    @staticmethod
    def problem_check(prob: dict | None, expect_internal: bool = False) -> list[str]:
        """A stop must carry a code, plain words and a fix — never traceback text."""
        bad = []
        if not prob:
            return ["paused without a problem (nothing tells the author why)"]
        msg, fix = str(prob.get("message") or ""), str(prob.get("fix") or "")
        if not prob.get("code"):
            bad.append("the problem has no code")
        if not msg.strip():
            bad.append("the problem has no message")
        if not fix.strip():
            bad.append("the problem offers no fix")
        blob = msg + " " + fix + " " + json.dumps(prob.get("details") or [], ensure_ascii=False)
        if "Traceback" in blob or 'File "' in blob or ".py\", line" in blob:
            bad.append("traceback text in the problem")
        if prob.get("code") == "INTERNAL_ERROR" and msg.startswith("Akọwe hit an unexpected problem") and \
                not expect_internal:
            bad.append("an unexpected Python exception stopped the run (INTERNAL_ERROR)")
        return bad

    def scan_logs(self, expect_tracebacks: bool = False) -> dict:
        """Tracebacks / ERRORs in the akowe logs, and book text or keys in any log line."""
        recs = self.tap.records
        tbs = [r for r in recs if r["exc"]]
        errs = [r for r in recs if r["levelno"] >= logging.ERROR]
        leaks = []
        words = [w for w in BOOK_TEXT + self.markers if w]
        for r in recs:
            blob = r["message"] + "\n" + r["exc"]
            for k in KEYS:
                if k in blob:
                    leaks.append(f"API/bridge key in a {r['level']} log line ({r['logger']})")
            for w in words:
                if w in blob:
                    leaks.append(f"book text in a {r['level']} log line ({r['logger']})")
                    break
        return {"tracebacks": tbs, "errors": errs, "leaks": sorted(set(leaks))}

    def run_leaks(self, run: dict | None = None) -> list[str]:
        """Keys anywhere in the stored run (events, problems)."""
        blob = json.dumps(run or self.raw() or {}, ensure_ascii=False)
        return ["a key appears in the stored run" for k in KEYS if k in blob]

    # ------------------------------------------------------------------ outcome building
    def outcome(self) -> Outcome:
        return Outcome(id=self.id, section=self.section, part=self.part, stress=self.stress, title=self.title,
                       likely=self.likely)

    def finish_outcome(self, o: Outcome, *, expect_tracebacks: bool = False) -> Outcome:
        """Fill the common fields (log scan, calls, codes) and compute the result from issues / risks."""
        logs = self.scan_logs(expect_tracebacks)
        o.log_errors = len(logs["errors"])
        o.log_tracebacks = len(logs["tracebacks"])
        if logs["tracebacks"] and not expect_tracebacks:
            where = sorted({scrub(r["message"])[:120] for r in logs["tracebacks"]})[:3]
            o.issues.append("unexpected traceback in the log: " + "; ".join(where))
        for leak in logs["leaks"]:
            o.issues.append(leak)
        try:
            for leak in self.run_leaks():
                o.issues.append(leak)
            raw = self.raw() or {}
            codes = []
            for e in raw.get("events") or []:
                c = e.get("code")
                if c and c not in codes:
                    codes.append(c)
            o.event_codes = codes[:30]
        except Exception:  # noqa: BLE001
            pass
        o.faults_fired = self.chaos.faults_fired()
        o.ai_calls = self.chaos.n
        o.seconds = round(time.monotonic() - self.t0, 2)
        o.issues = list(dict.fromkeys(o.issues))
        o.risks = list(dict.fromkeys(o.risks))
        if o.issues:
            o.result = PROBLEM
        elif o.risks:
            o.result = RISKY
        elif o.final_status == "done" and o.status != "done":
            o.result = SAFE
        elif o.status == "done":
            o.result = HANDLED
        else:
            o.result = PROBLEM
            o.issues.append(f"the book did not finish (status {o.final_status or o.status})")
        return o

    def standard(self, *, body: dict | None = None, expect_internal: bool = False, retry_first: bool = False,
                 check: Callable | None = None, label: str = "") -> Outcome:
        """The usual flow, faults already armed: start -> wait (hang?) -> done? / stopped -> fix() -> Resume ->
        finished? ``check(h, run)`` may add issues/risks (returns (issues, risks))."""
        o = self.outcome()
        if self.app is None:
            self.make_app()
        self.start(body)
        words = []
        if not self.wait():
            r = self.raw()
            o.status = "hang"
            o.issues.append(f"hang: no finish within {int(self.time_limit)} s (status {r.get('status')}, step "
                            f"{r.get('current')}, phase “{scrub(r.get('phase'))}”)")
            self.fix()
            self.cancel()
            self.wait(limit=30)
            o.happened = f"{label}Hung: still working after {int(self.time_limit)} s."
            return self.finish_outcome(o, expect_tracebacks=expect_internal)
        self.settle()
        run = self.run()
        o.status = run.get("status") or ""
        if o.status == "done":
            bad = self.book_check(run)
            o.issues += bad
            o.final_status = "done"
            words.append("The book finished" + (" (" + "; ".join(bad) + ")" if bad else " with nothing lost") + ".")
        elif o.status == "paused":
            prob = run.get("problem") or {}
            self.first_problem = dict(prob)
            self.first_trace = list(self.chaos.trace)
            o.problem_code = str(prob.get("code") or "")
            o.problem_message = scrub(prob.get("message"), self.markers)
            o.problem_fix = scrub(prob.get("fix"), self.markers)
            o.issues += self.problem_check(prob, expect_internal)
            al = run.get("alert") or {}
            o.alert = {k: scrub(al.get(k), self.markers) for k in ("category", "label", "wrong", "why", "next")
                       if al.get(k)}
            if str(prob.get("message") or "").startswith("Akọwe hit an unexpected problem") and \
                    al.get("category") == "ai":
                o.risks.append("the alert calls a fault in Akọwe's own code an “AI problem” (“" + scrub(al.get("why"))
                               + "”), so the author looks for the fault in the AI")
            words.append(f"Stopped at step “{prob.get('step') or run.get('current')}” with {o.problem_code}: "
                         f"“{o.problem_message}”" + (f" Fix offered: “{o.problem_fix}”." if o.problem_fix else ""))
            self.fix()
            if retry_first and "retry" in (prob.get("options") or []):
                self.app.autobook.decide("author", self.run_id, {"action": "retry"})
                ok = self.wait()
                if ok:
                    self.settle()
            else:
                ok = self.resume()
            if not ok:
                o.issues.append("hang after Resume")
                o.final_status = "hang"
            else:
                run = self.run()
                o.final_status = run.get("status") or ""
                if o.final_status == "done":
                    bad = self.book_check(run)
                    o.issues += bad
                    words.append("After the fault was removed, ▶ Resume finished the book"
                                 + (" (" + "; ".join(bad) + ")" if bad else " with nothing lost") + ".")
                else:
                    p2 = run.get("problem") or {}
                    o.issues.append(f"Resume could not finish the book (status {o.final_status}, "
                                    f"{p2.get('code')}: {scrub(p2.get('message'), self.markers)})")
                    words.append(f"Resume did not finish: {o.final_status} {p2.get('code') or ''}.")
        else:
            o.issues.append(f"the run stopped as “{o.status}” (not done, not a clear pause)")
            words.append(f"The run ended as “{o.status}”.")
        if len(self.new_projects()) > 1:
            o.issues.append(f"{len(self.new_projects())} books were made by one run (a duplicate book)")
        if check is not None:
            iss, rsk = check(self, self.run())
            o.issues += iss
            o.risks += rsk
        o.happened = label + " ".join(words)
        return self.finish_outcome(o, expect_tracebacks=expect_internal)

    def crash_restart(self, arm: Callable[["Harness"], None], *, body: dict | None = None, label: str = "",
                      check: Callable | None = None) -> Outcome:
        """``arm(h)`` makes the run stop like a closed program (SimulatedCrash) inside the part. Then: new App on
        the same data folder -> the run must read 'interrupted' -> fix() -> Resume -> the book must finish once."""
        o = self.outcome()
        if self.app is None:
            self.make_app()
        arm(self)
        self.start(body)
        if not self.wait():
            o.status = "hang"
            o.issues.append("hang before the simulated stop")
            self.fix()
            return self.finish_outcome(o)
        r0 = self.raw()
        o.status = f"stopped ({r0.get('status')})"
        self.fix()
        self.restart()
        r1 = self.app.autobook.public(self.app.autobook.get(self.run_id))
        words = [f"{label}The program stopped in step “{r0.get('current')}”; after the restart the run read "
                 f"“{r1.get('state')}” ({r1.get('state_words')})."]
        if r1.get("state") != "interrupted":
            o.issues.append(f"after the restart the run reads “{r1.get('state')}”, not interrupted")
        ok = self.resume()
        run = self.run()
        o.final_status = run.get("status") or ("hang" if not ok else "")
        if not ok:
            o.issues.append("hang after Resume")
        elif o.final_status == "done":
            bad = self.book_check(run)
            o.issues += bad
            words.append("▶ Resume finished the book" + (" (" + "; ".join(bad) + ")" if bad else " with nothing lost")
                         + ".")
        else:
            p = run.get("problem") or {}
            o.problem_code = str(p.get("code") or "")
            o.problem_message = scrub(p.get("message"), self.markers)
            o.issues.append(f"Resume could not finish (status {o.final_status}, {p.get('code')})")
            words.append(f"Resume ended as {o.final_status} {p.get('code') or ''}: “{o.problem_message}”.")
        n = len(self.new_projects())
        if n != 1:
            o.issues.append(f"{n} books exist after one run")
        if check is not None:
            iss, rsk = check(self, run)
            o.issues += iss
            o.risks += rsk
        o.happened = " ".join(words)
        o.status = "interrupted" if r1.get("state") == "interrupted" else o.status
        out = self.finish_outcome(o)
        if out.result == HANDLED and o.status != "done":
            out.result = SAFE  # it needed the author's ▶ Resume after the restart
        return out


# ================================================================================================ standard stresses
@dataclass
class Target:
    """What a part's generic stresses aim at: the run step (``STEPS`` id), the answer kinds of its AI calls (None =
    every call while the step runs; () = the part makes no AI call), and how to break its own code (``own(h)``
    installs a patch that raises, default: the step method raises RuntimeError)."""
    step: str
    kinds: tuple | None = None
    own: Callable | None = None
    body: dict | None = None
    crash_after: bool = False    # h: stop right after the step's own work (parts without AI calls)


def _rule(t: Target, action, **kw) -> Rule:
    return Rule(action, kinds=t.kinds or None, step=t.step, **kw)


def _no_ai_note(h: Harness, o: Outcome, t: Target) -> Outcome:
    if t.kinds == () or not h.chaos.faults_fired():
        if t.kinds == ():
            o.notes.append("This part makes no AI call: the fault was armed for the part's step and never fired "
                           "(the stress shows the part is immune to it).")
        elif not h.chaos.faults_fired():
            o.notes.append("The armed fault never fired (no matching AI call in this part).")
    return o


def std_a(h: Harness, t: Target) -> Outcome:
    h.make_app()
    h.chaos.add(_rule(t, timeout(), times=1))
    once = h.standard(body=t.body, label="Once: ")
    once = _no_ai_note(h, once, t)
    with Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed, time_limit=h.time_limit) as h2:
        h2.make_app()
        h2.chaos.add(_rule(t, timeout()))
        every = h2.standard(body=t.body, label="Every time: ")
    return once.worst(every)


def std_b(h: Harness, t: Target) -> Outcome:
    h.make_app()
    h.chaos.add(_rule(t, busy(), times=3))
    return _no_ai_note(h, h.standard(body=t.body, label="Busy 3 times, then answers: "), t)


def std_c(h: Harness, t: Target) -> Outcome:
    h.make_app()
    h.chaos.add(_rule(t, usage_limit(), times=6))
    o = h.standard(body=t.body, label="Every AI at its usage limit for 6 calls, then free: ")
    if t.kinds != () and h.chaos.faults_fired() and "USAGE_LIMIT_WAIT" not in o.event_codes:
        o.risks.append("no USAGE_LIMIT_WAIT note: the author was not told the run waited for usage limits")
        o = h.finish_outcome(o)
    return _no_ai_note(h, o, t)


GARBAGE = [
    ("not JSON", text("Sure! Here is your book idea: a lighthouse, a storm and a lost key. Hope this helps!")),
    ("wrong types", replace(lambda c: {k: 12345 for k in (c.out or {})} if isinstance(c.out, dict) else 12345)),
    ("missing keys", replace(lambda c: {"note": "only this"})),
]


def bad_answer_check(h: Harness, run: dict) -> tuple[list, list]:
    """After a stop on an AI's bad answer: does the problem blame the right thing, and were the other AIs asked?"""
    risks = []
    p = h.first_problem or {}
    msg = str(p.get("message") or "")
    if "is a required property" in msg or "is not of type" in msg or "JSON matching the output schema" in msg:
        risks.append("the message is in programmer's words (“…did not return JSON matching the output schema… "
                     "Last errors: /: 'title' is a required property…”, code " + str(p.get("code")) + ") and the fix "
                     "only says “" + scrub(p.get("fix")) + "” — it never suggests another AI")
    faulted = {t[3] for t in h.first_trace if t[4]}
    if p and h.wire == "bridge" and h.slots >= 2 and len(faulted) == 1:
        risks.append(f"only {sorted(faulted)[0]} was asked: the other {h.slots - 1} working AI(s) never got the call "
                     "before the run stopped")
    return [], risks


def std_d(h: Harness, t: Target) -> Outcome:
    out = None
    for i, (name, act) in enumerate(GARBAGE):
        hh = h if i == 0 else Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed,
                                      time_limit=h.time_limit).__enter__()
        try:
            hh.make_app(wire="bridge", slots=3)
            hh.chaos.add(_rule(t, act))
            o = _no_ai_note(hh, hh.standard(body=t.body, label=f"{name.capitalize()} (every time): ",
                                            check=bad_answer_check), t)
        finally:
            if hh is not h:
                hh.__exit__(None, None, None)
        out = o if out is None else out.worst(o)
    out.notes.append("Sent through an in-process AutoInjector bridge, so the real adapter reads the bad text.")
    return out


def std_e(h: Harness, t: Target) -> Outcome:
    h.make_app(wire="bridge", slots=3)
    h.chaos.add(_rule(t, text("")))
    o = h.standard(body=t.body, label="Empty reply text (every time): ", check=bad_answer_check)
    with Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed, time_limit=h.time_limit) as h2:
        h2.make_app(wire="bridge", slots=3)
        h2.chaos.add(_rule(t, text("{}")))
        o2 = h2.standard(body=t.body, label="An empty JSON object {} (every time): ", check=bad_answer_check)
    return _no_ai_note(h, o.worst(o2), t)


def _declined_words(h: Harness, run: dict) -> tuple[list, list]:
    p = h.first_problem or {}
    if p.get("code") == "AI_DECLINED" and "busy or unreachable" in str(p.get("message") or "") + str(p.get("fix") or ""):
        return [], ["the AIs REFUSED (AI_DECLINED) but the message and fix say they “stayed busy or unreachable” / "
                    "“could not be reached” and send the author to check AutoInjector and logins"]
    return [], []


def std_f(h: Harness, t: Target) -> Outcome:
    h.make_app()
    h.chaos.add(_rule(t, declined()))
    return _no_ai_note(h, h.standard(body=t.body, label="Every AI declines every time: ", check=_declined_words), t)


def std_g(h: Harness, t: Target) -> Outcome:
    h.make_app()
    if t.own is not None:
        t.own(h)
    else:
        def boom(run):
            raise RuntimeError("stress: injected failure in the part's own code")
        h.at_step(t.step, before=boom, times=10 ** 6)
    return h.standard(body=t.body, expect_internal=True, label="The part's own code raises: ")


def std_h(h: Harness, t: Target) -> Outcome:
    def arm(hh: Harness):
        if t.kinds == () or t.crash_after:
            def stop(run):
                raise SimulatedCrash("stopped right after the part's own work")
            hh.at_step(t.step, after=stop)
        else:
            hh.chaos.add(_rule(t, crash(), times=1))
    return h.crash_restart(arm, body=t.body)


def std_i(h: Harness, t: Target) -> Outcome:
    # (1) pause during the part, then resume
    h.make_app()

    def press_pause(*_):
        h.pause()
    if t.kinds == ():
        h.at_step(t.step, before=press_pause)
    else:
        h.chaos.add(_rule(t, callback(press_pause), times=1))
    o = h.outcome()
    h.start(t.body)
    if not h.wait():
        o.status = "hang"
        o.issues.append("hang after Pause")
        h.fix()
        return h.finish_outcome(o)
    r = h.run()
    o.status = r.get("status")
    words = [f"Pause pressed in “{t.step}”: the run stopped as {r.get('state')} (“{scrub(r.get('state_words'))}”)."]
    if r.get("state") != "paused":
        o.issues.append(f"after Pause the run reads “{r.get('state')}”, not paused")
    h.fix()
    ok = h.resume()
    r = h.run()
    o.final_status = r.get("status") if ok else "hang"
    if o.final_status == "done":
        o.issues += h.book_check(r)
        words.append("▶ Resume finished the book.")
    else:
        o.issues.append(f"Resume after Pause ended as {o.final_status} ({(r.get('problem') or {}).get('code')})")
    # (2) cancel during the part, then a new book
    with Harness(h.id, h.section, h.part, h.stress, h.title, seed=h.seed, time_limit=h.time_limit) as h2:
        h2.make_app()

        def press_cancel(*_):
            h2.cancel()
        if t.kinds == ():
            h2.at_step(t.step, before=press_cancel)
        else:
            h2.chaos.add(_rule(t, callback(press_cancel), times=1))
        first = h2.start(t.body)
        if not h2.wait():
            o.issues.append("hang after Cancel")
        r1 = h2.run(first)
        words.append(f"Cancel pressed in “{t.step}”: the run ended as {r1.get('state')}.")
        if r1.get("status") != "cancelled":
            o.issues.append(f"after Cancel the run reads “{r1.get('status')}”, not cancelled")
        h2.fix()
        second = h2.start(t.body)
        if not h2.wait(second):
            o.issues.append("the new book after a Cancel hung")
        h2.settle(second)
        r2 = h2.run(second)
        bad = h2.book_check(r2)
        if bad:
            o.issues.append("the new book after a Cancel did not finish: " + "; ".join(bad))
        else:
            words.append("A new book started afterwards finished.")
        if r2.get("project_id") == r1.get("project_id") and r1.get("project_id"):
            o.issues.append("the new book reused the cancelled run's book")
        sc = h2.scan_logs()
        o.issues += sc["leaks"]
        if sc["tracebacks"]:
            o.issues.append("unexpected traceback in the log (cancel variant)")
    o.happened = " ".join(words)
    out = h.finish_outcome(o)
    if out.result == HANDLED:
        out.result = SAFE if o.status != "done" else HANDLED
    return out


STD_FUNCS = {"a": std_a, "b": std_b, "c": std_c, "d": std_d, "e": std_e, "f": std_f, "g": std_g, "h": std_h,
             "i": std_i}


# ================================================================================================ the registry
@dataclass
class Part:
    id: str            # "1", "10", "10.2"
    name: str
    about: str = ""
    step: str | None = None

    @property
    def key(self) -> tuple:
        return tuple(int(x) for x in self.id.split("."))


@dataclass
class Stress:
    part: str
    letter: str
    title: str
    fn: Callable
    likely: str = ""
    time_limit: float = 90.0

    @property
    def id(self) -> str:
        return ""


class Section:
    """A lettered section: its parts (and subsections) and their stresses. Section modules create one at import time;
    ``SECTIONS`` holds them all."""

    def __init__(self, letter: str, name: str, slug: str):
        self.letter, self.name, self.slug = letter.upper(), name, slug
        self.parts: dict[str, Part] = {}
        self.stresses: dict[tuple, Stress] = {}
        self.findings: dict[str, dict] = {}
        SECTIONS[self.letter] = self

    def part(self, pid: str, name: str, about: str = "", step: str | None = None) -> Part:
        p = Part(str(pid), name, about, step)
        self.parts[p.id] = p
        return p

    def stress(self, part: str, letter: str, title: str | None = None, likely: str = "", time_limit: float = 90.0):
        """Decorator: ``@sec.stress("2", "k", "prompt injection", likely=LIKELY)`` on ``def fn(h: Harness) ->
        Outcome``. Standard letters a–j take their title from STANDARD when none is given."""
        def deco(fn):
            t = title or STANDARD.get(letter, letter)
            self.stresses[(str(part), letter)] = Stress(str(part), letter, t, fn, likely, time_limit)
            return fn
        return deco

    def std(self, part: str, target: Target, letters: str = "abcdefghi"):
        """Register the generic a–i stresses of a part (each may be replaced by a later ``@stress``)."""
        for letter in letters:
            f = STD_FUNCS[letter]
            self.stresses.setdefault((str(part), letter), Stress(str(part), letter, STANDARD[letter],
                                                                 (lambda h, f=f: f(h, target))))

    def finding(self, rid: str, *, where: str, cause: str, fix: str, severity: str, likely: str = "",
                what: str = "", repro: str = ""):
        """The analysed details of a ❌ / ⚠️ result (Where, Likely cause, Suggested fix, severity)."""
        self.findings[rid] = {"where": where, "cause": cause, "fix": fix, "severity": severity, "likely": likely,
                              "what": what, "repro": repro}

    def rid(self, part: str, letter: str) -> str:
        return f"{self.letter}-{part}-{letter}"

    def ordered(self) -> list[Stress]:
        return sorted(self.stresses.values(), key=lambda s: (tuple(int(x) for x in s.part.split(".")), s.letter))


SECTIONS: dict[str, Section] = {}


def load_section(letter: str) -> Section:
    letter = letter.upper()
    if letter not in SECTIONS:
        importlib.import_module(f"tools.stress.section_{letter.lower()}")
    return SECTIONS[letter]


def run_one(sec: Section, s: Stress, seed: int = 0, verbose: bool = True) -> Outcome:
    rid = sec.rid(s.part, s.letter)
    t0 = time.monotonic()
    try:
        with Harness(rid, sec.letter, s.part, s.letter, s.title, seed=seed, time_limit=s.time_limit,
                     likely=s.likely) as h:
            o = s.fn(h)
    except Exception as exc:  # noqa: BLE001 - the harness itself failed: say so, never hide it
        o = Outcome(id=rid, section=sec.letter, part=s.part, stress=s.letter, title=s.title, result=PROBLEM,
                    happened=f"The harness could not run this scenario ({type(exc).__name__}: {scrub(exc)}).",
                    issues=["harness error: " + scrub("".join(traceback.format_exception_only(type(exc), exc)))])
        o.notes.append("HARNESS ERROR — not a product finding until re-checked.")
    o.id, o.section, o.part, o.stress, o.title = rid, sec.letter, s.part, s.letter, s.title
    o.likely = o.likely or s.likely
    o.seconds = round(time.monotonic() - t0, 2)
    if rid in sec.findings:
        o.finding = dict(sec.findings[rid])
    if verbose:
        print(f"{o.result} {rid:10s} {o.seconds:6.1f}s  {s.title[:60]}  | {scrub(o.happened)[:160]}", flush=True)
        for i in o.issues:
            print(f"      ❌ {i}", flush=True)
        for r in o.risks:
            print(f"      ⚠️ {r}", flush=True)
    return o


def run_section(letter: str, parts: list[str] | None = None, stresses: list[str] | None = None, seed: int = 0,
                verbose: bool = True) -> list[Outcome]:
    sec = load_section(letter)
    out = []
    for s in sec.ordered():
        if parts and s.part not in parts and s.part.split(".")[0] not in parts:
            continue
        if stresses and s.letter not in stresses:
            continue
        out.append(run_one(sec, s, seed, verbose))
    return out


# ================================================================================================ reports
def _results_path(sec: Section) -> Path:
    return DOCS / f"{sec.letter}-results.json"


def _md_path(sec: Section) -> Path:
    return DOCS / f"{sec.letter}-{sec.slug}.md"


def merge_results(sec: Section, outcomes: list[Outcome], seed: int) -> list[dict]:
    old = {}
    p = _results_path(sec)
    if p.exists():
        try:
            for r in json.loads(p.read_text(encoding="utf-8")).get("results") or []:
                old[r["id"]] = r
        except (OSError, ValueError):
            old = {}
    for o in outcomes:
        d = asdict(o)
        d["result_word"] = WORDS[o.result]
        d["seed"] = seed
        d["ran_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        old[o.id] = d
    order = {sec.rid(s.part, s.letter): i for i, s in enumerate(sec.ordered())}
    return sorted(old.values(), key=lambda r: order.get(r["id"], 10 ** 6))


def _cell(s) -> str:
    return str(s or "").replace("|", "\\|").replace("\n", " ")


def _sev(r: dict) -> str:
    f = r.get("finding") or {}
    if f.get("severity") in SEVERITIES:
        return f["severity"]
    return "crash/hang" if r["result"] == PROBLEM else "confusing message"


def _part_of(sec: Section, pid: str) -> Part:
    return sec.parts.get(pid) or Part(pid, pid)


def render_markdown(sec: Section, results: list[dict]) -> str:
    by_part: dict[str, list] = {}
    for r in results:
        by_part.setdefault(r["part"], []).append(r)
    pids = sorted(by_part, key=lambda x: tuple(int(y) for y in x.split(".")))
    L = [f"# Section {sec.letter} — {sec.name}: stress results", "",
         "Every part of this section was run through the standard stresses (a–j) and out-of-the-box stresses (k…) "
         "with the stress harness (`akowe/tools/stress`). Nothing in the product was changed; this is a list of "
         "findings for the author to decide on.", "",
         "**Legend:** ✅ HANDLED — the book still finished, nothing lost · 🟡 SAFE STOP — paused with a clear problem; "
         "after the fault was removed, Resume finished the book · ❌ PROBLEM · ⚠️ WORKED BUT RISKY.", "",
         f"Re-run: `cd akowe && python -m tools.stress.run --section {sec.letter}` "
         f"(one part: `--parts 1`; some stresses: `--stress a,k`).", "",
         "## Summary", "", "| ID | Part | ✅ | 🟡 | ❌ | ⚠️ |", "|---|---|---|---|---|---|"]
    for pid in pids:
        rs = by_part[pid]
        c = {k: sum(1 for r in rs if r["result"] == k) for k in (HANDLED, SAFE, PROBLEM, RISKY)}
        L.append(f"| {sec.letter}-{pid} | {_cell(_part_of(sec, pid).name)} | {c[HANDLED]} | {c[SAFE]} | {c[PROBLEM]} "
                 f"| {c[RISKY]} |")
    tot = {k: sum(1 for r in results if r["result"] == k) for k in (HANDLED, SAFE, PROBLEM, RISKY)}
    L.append(f"| **all** | | **{tot[HANDLED]}** | **{tot[SAFE]}** | **{tot[PROBLEM]}** | **{tot[RISKY]}** |")
    L.append("")
    numbered: list[tuple[str, dict]] = []
    for pid in pids:
        p = _part_of(sec, pid)
        L += [f"## {sec.letter}-{pid} {p.name}", "", f"**What it does:** {p.about}" if p.about else "", "",
              "| ID | Stress | Result | What happened |", "|---|---|---|---|"]
        for r in by_part[pid]:
            extra = ""
            if r.get("likely") and r["stress"] > "j":
                extra = f" *({r['likely']})*"
            happened = r.get("happened") or ""
            if r.get("issues"):
                happened += " ❌ " + "; ".join(r["issues"])
            if r.get("risks"):
                happened += " ⚠️ " + "; ".join(r["risks"])
            if r.get("notes"):
                happened += " Note: " + " ".join(r["notes"])
            L.append(f"| {r['id']} | {_cell(r['title'])}{extra} | {r['result']} | {_cell(happened)} |")
        L.append("")
        bad = [r for r in by_part[pid] if r["result"] in (PROBLEM, RISKY)]
        if bad:
            L += [f"### Findings in {sec.letter}-{pid}", ""]
            for r in bad:
                numbered.append((r["id"], r))
                L += _finding_md(sec, len(numbered), r)
    L += ["## All findings in this section", "",
          "Ordered by severity: would lose work > crash/hang > blocks the book needlessly > confusing message > "
          "cosmetic.", ""]
    if not numbered:
        L.append("No ❌ or ⚠️ results.")
    else:
        L += ["| # | ID | Result | Severity | How likely | One line |", "|---|---|---|---|---|---|"]
        idx = {rid: i + 1 for i, (rid, _) in enumerate(numbered)}
        for rid, r in sorted(numbered, key=lambda x: (SEVERITIES.index(_sev(x[1])), -RANK[x[1]["result"]], x[0])):
            f = r.get("finding") or {}
            one = f.get("what") or "; ".join(r.get("issues") or r.get("risks") or [])
            L.append(f"| {idx[rid]} | {rid} | {r['result']} | {_sev(r)} | {_cell(f.get('likely') or r.get('likely') or '')} "
                     f"| {_cell(one)[:220]} |")
    L.append("")
    return "\n".join(x for x in L if x is not None) + "\n"


def _finding_md(sec: Section, n: int, r: dict) -> list[str]:
    f = r.get("finding") or {}
    what = f.get("what") or "; ".join(r.get("issues") or []) or "; ".join(r.get("risks") or [])
    status = f"run status {r.get('status')}" + (f" → {r.get('final_status')}" if r.get("final_status") else "")
    if r.get("problem_code"):
        status += f"; problem {r['problem_code']}"
    codes = ", ".join(r.get("event_codes") or []) or "none"
    repro = f.get("repro") or (f"`cd akowe && python -m tools.stress.run --section {sec.letter} --parts {r['part']} "
                               f"--stress {r['stress']}` (ID {r['id']})")
    return [f"**{n}. {r['id']} {r['result']} — {r['title']}**", "",
            f"- **Where:** {f.get('where') or 'not analysed yet (harness result only)'}",
            f"- **What happens:** {what}. The author sees: {r.get('happened')} ({status}; journal codes: {codes}; "
            f"log: {r.get('log_errors', 0)} ERROR line(s), {r.get('log_tracebacks', 0)} traceback(s)).",
            f"- **How to reproduce:** {repro}",
            f"- **Likely cause:** {f.get('cause') or 'not analysed yet'}",
            f"- **Suggested fix:** {f.get('fix') or 'not analysed yet'} (not implemented)",
            f"- **How likely:** {f.get('likely') or r.get('likely') or 'not rated'}", ""]


def write_reports(sec: Section, outcomes: list[Outcome], seed: int = 0) -> tuple[Path, Path]:
    DOCS.mkdir(parents=True, exist_ok=True)
    results = merge_results(sec, outcomes, seed)
    for r in results:  # analysed findings may be added after a run: always use the section's current text
        if r["id"] in sec.findings and r["result"] in (PROBLEM, RISKY):
            r["finding"] = dict(sec.findings[r["id"]])
    data = {"section": sec.letter, "name": sec.name, "slug": sec.slug,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "legend": {HANDLED: WORDS[HANDLED], SAFE: WORDS[SAFE], PROBLEM: WORDS[PROBLEM], RISKY: WORDS[RISKY]},
            "parts": [asdict(p) for p in sorted(sec.parts.values(), key=lambda p: p.key)],
            "results": results}
    jp, mp = _results_path(sec), _md_path(sec)
    jp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    mp.write_text(render_markdown(sec, results), encoding="utf-8")
    write_index()
    return mp, jp


# The whole plan (from the shared brief): section -> (name, slug, [(part id, name)]). The index lists it with each
# section's status (from its results file), so a section agent never edits this table by hand.
OUTLINE = {
    "A": ("Getting started", "getting-started", [("1", "backup"), ("2", "profile (invent the book)")]),
    "B": ("Characters and world", "characters-and-world",
          [("3", "canon (characters & places)"), ("4", "characters (sheets & voices)"), ("5", "looks"),
           ("6", "pictures"), ("7", "world (story rules & world texture)")]),
    "C": ("Planning the story", "planning-the-story",
          [("8", "premise"), ("9", "plot"), ("10", "outline"), ("10.1", "story doctor"), ("10.2", "promise ledger"),
           ("10.3", "predictability probe"), ("10.4", "who-knows-what grid"), ("10.5", "story shape / kind placement"),
           ("10.6", "trade card")]),
    "D": ("Optional", "optional", [("11", "bible (fill the whole Book Bible)")]),
    "E": ("Writing", "writing",
          [("12", "chapters"), ("12.1", "scene cards"), ("12.2", "the writer (C01/C02)"),
           ("12.3", "review & fix loop"), ("12.4", "editor"), ("12.5", "cut pass"), ("12.6", "subtext check"),
           ("12.7", "scope guard & knowledge check"), ("12.8", "voice test"), ("12.9", "key scenes written twice"),
           ("12.10", "ending writer"), ("12.11", "keep briefs"), ("12.12", "continuity checkpoints"),
           ("13", "planned (planned details on the page)")]),
    "F": ("Putting the book together", "putting-the-book-together",
          [("14", "format"), ("15", "assemble"), ("16", "export"), ("17", "check (content check)")]),
    "G": ("Quality at the end", "quality-at-the-end",
          [("18", "report"), ("19", "beta (beta reader)"), ("20", "opening (rewrite chapter 1 last)"),
           ("21", "improve"), ("22", "reread")]),
}


def write_index() -> Path:
    DOCS.mkdir(parents=True, exist_ok=True)
    L = ["# ⚡ Make-a-book stress test — index", "",
         "Every part of the book-making process (`akowe/akowe/autobook.py` `STEPS`) is stress-tested section by "
         "section with the harness in `akowe/tools/stress` (see its README). Findings only: no product code is "
         "changed by these tests.", "",
         "Result IDs: `<Section>-<part>[.<subsection>]-<stress>` (e.g. `B-7-a`, `C-10.2-k`). Stresses a–j are the "
         "standard ones; k, l, m… are out-of-the-box ones.", "",
         "**Legend:** ✅ HANDLED · 🟡 SAFE STOP · ❌ PROBLEM · ⚠️ WORKED BUT RISKY", "",
         "| Section | Parts / subsections | Status | ✅ | 🟡 | ❌ | ⚠️ | Report |", "|---|---|---|---|---|---|---|---|"]
    for letter, (name, slug, parts) in OUTLINE.items():
        jp = DOCS / f"{letter}-results.json"
        counts = {k: "" for k in (HANDLED, SAFE, PROBLEM, RISKY)}
        status, link = "not run yet", ""
        if jp.exists():
            try:
                data = json.loads(jp.read_text(encoding="utf-8"))
                rs = data.get("results") or []
                counts = {k: sum(1 for r in rs if r.get("result") == k) for k in counts}
                status = f"done ({len(rs)} results, {data.get('generated_at', '')[:10]})"
                slug = data.get("slug") or slug
                link = f"[{letter}-{slug}.md]({letter}-{slug}.md)"
            except (OSError, ValueError):
                status = "results file unreadable"
        plist = " · ".join(f"{letter}-{pid} {pn}" for pid, pn in parts)
        L.append(f"| {letter}. {name} | {plist} | {status} | {counts[HANDLED]} | {counts[SAFE]} | {counts[PROBLEM]} "
                 f"| {counts[RISKY]} | {link} |")
    L += ["", "Each section report has: a summary table, one section per part (what it does, every stress with its "
          "result, the ❌ / ⚠️ findings with Where / What happens / How to reproduce / Likely cause / Suggested fix / "
          "How likely) and all findings ordered by severity. The JSON next to it (`<L>-results.json`) holds the same "
          "results for tools.", ""]
    p = DOCS / "README.md"
    p.write_text("\n".join(L), encoding="utf-8")
    return p


def cleanup_tmp():
    shutil.rmtree(TMP_BASE, ignore_errors=True)
