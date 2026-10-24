"""⚡ "Make a book for me" (R14) with pause/resume/cancel (S21), and "✍ Write all chapters" (S2).

A Make-a-book run creates a NEW book (it never touches an existing project) and walks the whole guided book path
with the AI, in a background thread whose state is persisted (``JobStore``, kind ``autobook``) after every change,
so a page reload shows it and a BookForge restart shows it as "interrupted — Resume":

    safety backup -> book profile (the AI invents title, genre, audience, tone, idea, pen name)
    -> characters and places (A01/A04/A03 through the Bible Builder: world sketch + proposals, created as drafts)
    -> character sheets and voice cards (P7/P17: made with the characters, or made now for any without)
    -> premise B01 -> main plot B03 -> chapter outline B11 -> every chapter (scene cards planned by the writer and
    checked by an independent AI (P8), then C01 context + C02 prose)
    -> book format (I01 profiles) -> backup + assembly (G02/G01/G05/G04/G07) -> backup + exports (G11 PDF,
    G12 EPUB, G13 DOCX - all three release profiles are switched on for this book) -> content check H05.

Every step is a normal ``engine.dispatch`` through ``BookPath`` (no shortcut around the kernel's checks).

Consent and approvals: pressing the button is the author's consent for THIS run only. The consent (who, when,
run id, which new book) is stored with the run. Each creative draft is sent to the AI reviewer (review.py):
APPROVE -> approved under the run consent (outbox ``autobook.approved_under_consent``, label "Approved under your
Make-a-book-for-me consent, run <id>"); REVISE/REJECT -> "Ask AI to fix it" (a new DRAFT revision through the
normal UPDATE), at most twice, then reviewed again; still not passing -> the run pauses with a ⚠️ on that step
and the author decides (approve anyway / edit it / try again). Deterministic BookForge outputs (book format,
assembly records, the export approval manifest) are approved under the same consent without an AI opinion.
``_approve`` refuses anything that is not inside the live thread of a run the author started, for that run's
own book - nothing is ever approved outside a run.

AI availability: busy/unreachable answers wait and retry (jobs.wait_and_retry, shown as "waiting for Claude
(busy) - retrying in 30 s"); a TIMEOUT is never retried automatically - inside a run it pauses that step with a
⚠️ (the author presses "Try again"), it never fails the whole run.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
import uuid
from datetime import datetime, timezone

from . import characters as chars_mod
from . import h_checks as hc
from . import scenes as scenes_mod
from .assist import AssistService, BibleSession, Cancelled, Job, book_profile_brief
from .book_path import EXPORT_FOR, LENGTHS, BookPath, StepError, _step_lock, get_profile, problems, save_profile
from .requests import candidate_payload
from .engine import Engine
from .errors import BookforgeError
from .jobs import BUSY_CODES, JobStore, RetryPolicy, busy_code, now_iso, slot_word, wait_and_retry
from .providers import PROBE_POLL_S, PROBE_WAIT_S, PinnedProviders  # noqa: F401 - re-exported (older imports)
from .editor import judge_rewrite, keep_quotes_of, lost_keeps
from .editor_rubric import LABELS as EDITOR_LABELS
from .review import NOT_INDEPENDENT, REVIEWABLE, ReviewJob, ReviewService, plain_problem, safe_title

log = logging.getLogger("bookforge.autobook")

MAX_FIXES = 2
MAX_EVENTS = 400
RELEASE = ["MANUSCRIPT_PDF", "EPUB_REFLOWABLE", "EDITABLE_DOCX"]
CANON_COUNTS = {"short_story": {"A01": 2, "A04": 1}, "novella": {"A01": 3, "A04": 2, "A03": 1},
                "novel": {"A01": 4, "A04": 3, "A03": 1}}
CHAPTERS_FOR = {"short_story": 3, "novella": 8, "novel": 24}
SET_NAMES = {"A": "Universe & Characters", "B": "Story Planning", "C": "Writing", "G": "Assemble & Export",
             "H": "Quality Checks", "I": "Storage & Context"}

STEPS = [
    ("backup", None, None, "Safety backup", "A backup of all your books, before anything starts."),
    ("profile", None, None, "Invent the book", "The AI invents the title, genre, readers, tone and the idea."),
    ("canon", "A", "A01", "Characters and places", "The AI drafts the main characters and places (Bible Builder); "
     "each one is reviewed and approved under your consent."),
    ("characters", "A", "A01", "Character sheets and voices", "What each character wants, needs, fears and hides, "
     "and how each one talks (a voice card each); the writer gets them in every chapter."),
    ("premise", "B", "B01", "Premise", "What the book is about in one or two sentences."),
    ("plot", "B", "B03", "Main plot", "The main storyline built from the premise and the characters."),
    ("outline", "B", "B11", "Chapter outline", "The chapter-by-chapter plan."),
    ("chapters", "C", "C02", "Write every chapter", "Context (C01) and prose (C02) for each chapter, reviewed and "
     "approved one by one."),
    ("format", "I", "I01", "Book format", "Page size, font and PDF/EPUB/DOCX settings."),
    ("assemble", "G", "G01", "Put the book together", "Order, manuscript, typography, pages and contents."),
    ("export", "G", "G11", "Export PDF, EPUB and Word", "Makes the three files and re-reads each one."),
    ("check", "H", "H05", "Content check", "Every chapter is in the book once and in order."),
]
STEP_IDS = [s[0] for s in STEPS]

PROFILE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["title", "author", "genre", "audience", "tone", "idea"],
    "properties": {"title": {"type": "string"}, "author": {"type": "string"}, "genre": {"type": "string"},
                   "audience": {"type": "string"}, "tone": {"type": "string"}, "idea": {"type": "string"}},
}
PROFILE_TASK = (
    "Task: invent an ORIGINAL book for the author to make with BookForge. Use the author's wishes in "
    "context.wishes when given (genre, length, an idea) and choose everything else yourself. Return: title (a short, "
    "evocative working title), author (an invented pen name), genre, audience (who it is for, e.g. Adult, Young adult "
    "(12-18), Middle grade (8-12)), tone (a few words), idea (one paragraph of 3-5 sentences: who the main character "
    "is, where it happens, what goes wrong and what is at stake). No real people, no existing franchises. Return only "
    "the JSON object.")

TIMEOUT_FIX = ("The AI did not answer in time, so BookForge paused here instead of guessing (the answer may still "
               "arrive). Check the AI's window (AutoInjector: is the site logged in and idle?), then press 🔁 Try again.")
BUSY_FIX = ("The AI stayed busy or unreachable for a long time. Check Settings → Test connection (is AutoInjector "
            "running and the site logged in?), then press 🔁 Try again.")
CHECKS_FIX = ("Press 🔁 Try again: the AI writes it again and is told exactly what BookForge refused. Or ✏️ Edit it "
              "yourself so the checks pass, then press Continue.")
STALE_FIX = ("It was made from a plan or other inputs that changed since, so it is out of date: editing it cannot fix "
             "that. Press 🔁 Try again: the AI writes it again from the current, approved inputs.")
AUTHOR_CHECKS_FIX = ("This is your own edited version, so BookForge keeps it and does not ask the AI to replace it. "
                     "✏️ Edit it so the checks pass (see what was refused below), then press Continue.")
AUTHOR_STALE_FIX = ("Your edited version was made from a plan or other inputs that changed since, so it is out of date "
                    "and editing it cannot fix that. BookForge keeps it (the AI does not replace your text). Open the "
                    "book, approve the current version of what it was made from, and make this step again there.")
BOOK_GONE_FIX = ("This run cannot continue. Start a new ⚡ Make a book for me, or restore a backup that still has "
                 "this book.")
NEW_BOOK_NAME = "New book (being made…)"


class RunPaused(Exception):
    pass


class RunCancelled(Exception):
    pass


class StepProblem(Exception):
    """Pause the run on this step with a ⚠️ for the author (problem dict as shown in the UI)."""

    def __init__(self, code: str, message: str, fix: str | None = None, **extra):
        super().__init__(message)
        self.problem = dict({"code": code, "message": message, "fix": fix}, **extra)


class ChecksRefused(StepProblem):
    """BookForge's own checks refused a draft (not the AI reviewer): approving it again cannot help, so the run asks
    the AI to write it again (told what was wrong), at most MAX_FIXES times, then pauses for the author."""


def digest(problems_: list, limit: int = 6) -> list[str]:
    """One line per kind of problem (rule), with how many more of the same kind there are."""
    seen: dict[str, list] = {}
    for p in problems_ or []:
        rule = str(p).split(":", 1)[0]
        seen.setdefault(rule, []).append(str(p))
    out = []
    for rule, msgs in seen.items():
        more = len(msgs) - 1
        out.append(msgs[0][:300] + (f" (and {more} more like this)" if more else ""))
    return out[:limit]


def _elapsed(start_iso: str | None, end_iso: str | None = None) -> int:
    if not start_iso:
        return 0
    try:
        a = datetime.strptime(start_iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        b = datetime.strptime(end_iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) if end_iso else \
            datetime.now(timezone.utc)
        return max(0, int((b - a).total_seconds() * 1000))
    except ValueError:
        return 0


# ====================================================================== shared runner machinery
class _Runner:
    """Thread + control flags + persistence shared by Make-a-book runs and Write-all-chapters jobs."""

    KIND = "job"

    def __init__(self, app):
        self.app = app
        self.store = app.store
        self.jobs: JobStore = app.jobstore
        self._lock = threading.RLock()
        self._threads: dict[str, threading.Thread] = {}
        self._ctl: dict[str, dict] = {}
        self._cache: dict[str, dict] = {}
        self.retry_policy: RetryPolicy | None = None  # tests inject a fast policy
        self.probe_timeout_s = PROBE_WAIT_S  # before a run: wait at most this long for the AIs' check-in
        self.probe_poll_s = PROBE_POLL_S

    # ------------------------------------------------------------------ persistence
    def get(self, run_id: str) -> dict | None:
        with self._lock:
            if run_id in self._cache:
                return self._cache[run_id]
        r = self.jobs.get(run_id)
        return r if r and r.get("kind") == self.KIND else None

    def save(self, run: dict):
        with self._lock:
            self._cache[run["id"]] = run
            run["updated_at"] = now_iso()
            self.jobs.save(run)
        try:
            self.app.changed()
        except Exception:  # noqa: BLE001
            pass

    def event(self, run: dict, kind: str, message: str, step: str | None = None, **extra):
        ev = dict({"at": now_iso(), "kind": kind, "step": step or run.get("current"), "message": message[:400]},
                  **{k: v for k, v in extra.items() if v is not None})
        run.setdefault("events", []).append(ev)
        if len(run["events"]) > MAX_EVENTS:
            run["events"] = run["events"][-MAX_EVENTS:]

    def alive(self, run_id: str) -> bool:
        t = self._threads.get(run_id)
        return bool(t and t.is_alive())

    def check(self, run: dict):
        ctl = self._ctl.get(run["id"]) or {}
        if ctl.get("cancel"):
            raise RunCancelled()
        if ctl.get("pause"):
            raise RunPaused()

    def policy(self) -> RetryPolicy:
        return self.retry_policy or RetryPolicy.from_store(self.store)

    def _launch(self, run: dict, target):
        with self._lock:
            if self.alive(run["id"]):
                raise BookforgeError("VERSION_CONFLICT", "/run", "this is already running", status="REJECTED")
            self._ctl[run["id"]] = {"pause": False, "cancel": False}
            t = threading.Thread(target=self._wrap, args=(run["id"], target), daemon=True,
                                 name=f"bookforge-{self.KIND}-{run['id'][-6:]}")
            self._threads[run["id"]] = t
            t.start()

    def _wrap(self, run_id, target):
        try:
            target(run_id)
        except Exception:  # noqa: BLE001 - never crash the server
            log.exception("%s %s crashed", self.KIND, run_id)
            run = self.get(run_id)
            if run:
                run["status"], run["phase"] = "paused", "Stopped by an unexpected problem — press Resume to try again"
                run["problem"] = {"code": "INTERNAL_ERROR", "message": "BookForge hit an unexpected problem.",
                                  "fix": "Press 🔁 Try again. If it keeps happening, use 📋 Copy diagnostics."}
                self.save(run)
        finally:
            try:
                self.store.close()
            except Exception:  # noqa: BLE001
                pass

    def wait_for(self, run_id: str, timeout: float = 60.0):
        t = self._threads.get(run_id)
        if t:
            t.join(timeout)

    def active(self) -> list[dict]:
        out = []
        for rid in list(self._threads):
            if self.alive(rid):
                r = self.get(rid)
                if r:
                    out.append(r)
        return out

    def owned(self, principal: str, run_id: str) -> dict:
        r = self.get(run_id)
        if r is None or r.get("principal") not in (None, principal):
            raise BookforgeError("NOT_FOUND", "/run_id", "this run is not known", status="REJECTED")
        return r

    # ------------------------------------------------------------------ AI create through dispatch, with S10 retry
    def ai_create(self, run: dict, bp: BookPath, op: str, payload: dict, label: str) -> dict:
        """CREATE a creative record with the AI; busy answers wait and retry; TIMEOUT -> StepProblem."""
        def once():
            self.check(run)
            r = bp.dispatch(op, "CREATE", payload=payload)
            if r["status"] == "DRAFT" and r.get("output_refs"):
                return r["output_refs"][0]
            errs = r.get("errors") or []
            code = busy_code(errs)
            if code is None and any(e.get("code") == "CAPABILITY_UNAVAILABLE" for e in errs) and self._slots_busy(
                    getattr(bp.engine.providers, "pinned", None)):
                code = "RATE_LIMITED"
            if code:
                raise BookforgeError(code, "", (errs[0].get("message") if errs else "") or "the AI is busy")
            first = errs[0] if errs else {"code": r.get("status"), "message": r.get("status")}
            if first.get("code") == "TIMEOUT":
                raise StepProblem("TIMEOUT", f"The AI did not answer in time while writing the {label}.", TIMEOUT_FIX,
                                  op=op)
            if first.get("code") == "CAPABILITY_UNAVAILABLE":
                raise StepProblem("CAPABILITY_UNAVAILABLE", f"No AI is ready to write the {label}.",
                                  "Open Settings and connect AutoInjector or add an API key, then press 🔁 Try again.",
                                  op=op)
            from .book_path import problems  # noqa: PLC0415
            raise StepProblem(first.get("code") or "INVALID_INPUT",
                              f"The {label} could not be made: {first.get('message')}",
                              "Press 🔁 Try again. If it fails again, open the step and write it yourself.",
                              op=op, details=problems(r)[:6])

        tok = self.app.work.begin(run["project_id"], op, f"AI is writing the {label}")
        try:
            return wait_and_retry(once, policy=self.policy(), check=lambda: self.check(run),
                                  on_wait=lambda info: self.on_wait(run, info), who=self._who(run))
        except BookforgeError as exc:
            if exc.code in BUSY_CODES:
                raise StepProblem(exc.code, exc.errors[0].get("message") or "the AI stayed busy", BUSY_FIX, op=op) \
                    from None
            raise
        finally:
            self.app.work.end(tok)

    def _ai_configured(self) -> bool:
        prov = self.app.engine.providers
        for s in prov.slots():
            if s["adapter_id"] in ("anthropic", "autoinjector") and (s.get("has_credentials") or prov.test_adapter):
                return True
            if s["adapter_id"] == "manual" and prov.test_adapter is not None:
                return True
        return False

    def _slots_busy(self, pinned: str | None = None) -> bool:
        """True when every AI that may take this step is set up but busy (so the step waits and retries). A book or
        run pinned to one AI (``pinned``) only ever uses that one: its being busy is enough, whatever the others do."""
        slots = [s for s in self.app.engine.providers.slots() if s["adapter_id"] in ("anthropic", "autoinjector")
                 or (s["adapter_id"] == "manual" and self.app.engine.providers.test_adapter is not None)]
        if pinned:
            slots = [s for s in slots if s["slot_id"] == pinned]
        return bool(slots) and all(s["active_jobs"] >= s["max_concurrent"] for s in slots)

    def _who(self, run: dict) -> str:
        slots = self.app.engine.providers.slots()
        pick = run.get("settings", {}).get("slot_id")
        s = next((x for x in slots if x["slot_id"] == pick), None) or next(
            (x for x in slots if x["adapter_id"] in ("autoinjector", "anthropic")), None)
        if not s:
            return "the AI"
        return slot_word(None, s.get("site")) if s["adapter_id"] == "autoinjector" else "Claude"

    def on_wait(self, run: dict, info):
        run["waiting"] = info
        if info:
            run["status"] = "waiting"
            run["phase"] = info["message"]
            self.event(run, "wait", info["message"], code=info["code"])
        else:
            run["status"] = "running"
            run["phase"] = "Trying the AI again"
        self.refresh_ais(run)
        self.save(run)

    # ------------------------------------------------------------------ which AIs work (P18.9)
    @staticmethod
    def _ai_row(st: dict) -> dict:
        checking = bool(st.get("pending")) and st["state"] in ("ok", "unknown")
        return {"slot_id": st["slot_id"], "name": st["name"], "state": "checking" if checking else st["state"],
                "word": "being checked" if checking else st.get("word"), "problem": st.get("problem"),
                "working": bool(st.get("working")) and not st.get("pending")}

    def refresh_ais(self, run: dict):
        """The run window's "which AIs work" list, from the cached bridge view (cheap: at most one read per 15 s)."""
        try:
            prov = self.app.engine.providers
            run["ais"] = [self._ai_row(prov.slot_status(s)) for s in prov.ai_slots()]
        except Exception:  # noqa: BLE001 - a display hint must never break the run
            log.exception("could not read the AI states")

    def probe_ais(self, run: dict):
        """Before the run works: ask AutoInjector to check in with each site (bridge v1.2 /v1/probe) and wait up to
        ``probe_timeout_s`` (60 s) so the run starts knowing which AIs work; progress shows in the run window."""
        prov = self.app.engine.providers
        if not prov.ai_slots():
            return
        run["phase"] = "Checking which AIs work…"
        run["probe"] = {"state": "running", "started_at": now_iso()}
        self.save(run)

        def progress(statuses, elapsed):
            run["ais"] = [self._ai_row(x) for x in statuses]
            waiting = [x["name"] for x in statuses if x.get("pending")]
            run["phase"] = (f"Checking which AIs work… ({int(elapsed)} s; waiting for {', '.join(waiting)})"
                            if waiting else "Checking which AIs work…")
            self.save(run)
        statuses = prov.probe_and_wait(timeout_s=self.probe_timeout_s, poll_s=self.probe_poll_s, on_progress=progress,
                                       check=lambda: self.check(run))
        run["ais"] = [self._ai_row(x) for x in statuses]
        working = [a for a in run["ais"] if a["working"]]
        run["probe"] = {"state": "done", "at": now_iso(), "working": len(working), "total": len(run["ais"])}
        words = "; ".join(f"{a['name']}: {a['word']}" + (f" ⚠️ {a['problem']}" if a.get("problem") and not a["working"]
                                                          else "") for a in run["ais"])
        self.event(run, "probe", f"AIs checked — {words}", step=run.get("current") or "backup")
        if len(working) == 1 and len(run["ais"]) >= 1:
            self.event(run, "note", f"Only {working[0]['name']} works right now: it writes AND reviews ⚠️ "
                       f"({NOT_INDEPENDENT.split(' — ')[0].lower()} until another AI works again)",
                       code="REVIEW_NOT_INDEPENDENT")
        self.save(run)

    def on_failover(self, run: dict, info: dict):
        """A call moved to another AI because one was not working (P18.9): tell the author in the run window."""
        try:
            gone = []
            for f in info.get("from") or []:
                st = f.get("state")
                word = {"repairing": "is being repaired", "needs_user": "needs you", "broken": "is not working"}.get(
                    st or "", "did not answer")
                gone.append(f"{f.get('from_name') or f.get('name') or f.get('from') or f.get('slot_id')} {word}"
                            + (f" ({f['problem']})" if f.get("problem") else ""))
            msg = f"{'; '.join(gone) or 'An AI was not working'} — this went to {info.get('to_name')} instead"
            self.event(run, "failover", msg, code="AI_MOVED", slot=info.get("to"))
            run.setdefault("failovers", 0)
            run["failovers"] += 1
            self.refresh_ais(run)
            self.save(run)
        except Exception:  # noqa: BLE001 - display only
            log.exception("could not record a failover")


# ====================================================================== Make a book for me
class AutoBookService(_Runner):
    KIND = "autobook"

    def __init__(self, app):
        super().__init__(app)
        # The services bound to a run's AI choice and the id of the run a thread is working on belong to THAT
        # run's thread (two runs, or a run and a test call, never see each other's).
        self._tl = threading.local()

    @property
    def _engine(self):
        return getattr(self._tl, "engine", None) or self.app.engine

    @property
    def _assist(self):
        return self._tl.assist

    @property
    def _review(self):
        return self._tl.review

    @property
    def _thread_run(self):
        return getattr(self._tl, "run_id", None)

    # ------------------------------------------------------------------ API
    def list(self, principal: str, limit: int = 20) -> list[dict]:
        out = []
        for r in self.jobs.list(kind=self.KIND, limit=limit):
            if r.get("principal") in (None, principal):
                out.append(self.public(self._cache.get(r["id"], r)))
        return out

    def public(self, run: dict) -> dict:
        out = dict(run)
        out["alive"] = self.alive(run["id"])
        out["elapsed_ms"] = _elapsed(run.get("started_at"), run.get("finished_at")) if run.get("started_at") else 0
        steps = []
        for s in run.get("steps") or []:
            s = dict(s)
            if s.get("started_at"):
                s["elapsed_ms"] = _elapsed(s["started_at"], s.get("finished_at"))
            steps.append(s)
        out["steps"] = steps
        out["events"] = (run.get("events") or [])[-60:]
        return out

    def start(self, principal: str, body) -> dict:
        body = body if isinstance(body, dict) else {}
        if body.get("author_confirms") is not True:
            raise BookforgeError("APPROVAL_REQUIRED", "/author_confirms", "pressing ⚡ Make a book for me is your "
                                 "consent for this run; it must be sent as author_confirms: true", status="REJECTED")
        settings = self._clean_settings(body)
        if not self._ai_configured():
            raise BookforgeError("CAPABILITY_UNAVAILABLE", "/slot_id", "no AI is connected — Make a book for me needs "
                                 "an AI", status="REJECTED")
        with self._lock:  # the check and the launch are one step: two presses at once start ONE run
            return self._start_locked(principal, settings)

    def _start_locked(self, principal: str, settings: dict) -> dict:
        if self.active():
            raise BookforgeError("VERSION_CONFLICT", "/run", "a Make-a-book run is already working; pause or cancel "
                                 "it first (or wait for it to finish)", status="REJECTED")
        run_id = f"run-{uuid.uuid4().hex[:12]}"
        at = now_iso()
        run = {"id": run_id, "kind": self.KIND, "status": "queued", "phase": "Starting", "principal": principal,
               "project_id": None, "branch_id": "main", "created_at": at, "started_at": at, "finished_at": None,
               "settings": settings, "current": None, "waiting": None, "problem": None, "decision": None,
               "pause_reason": None, "files": [], "title": None, "fix_counts": {}, "events": [],
               "editor_settings": self._editor_snapshot(), "editor": {},
               "consent": {"by": principal, "at": at, "run_id": run_id, "scope": "this run only (one new book)",
                           "text": "You pressed ⚡ Make a book for me: the AI may approve drafts that its own review "
                                   "passes, for this new book and this run only."},
               "steps": [{"id": sid, "set": st, "op": op, "title": title, "about": about, "state": "pending",
                          "message": "", "started_at": None, "finished_at": None, "problem": None, "items": []}
                         for sid, st, op, title, about in STEPS]}
        self.event(run, "start", "Make a book for me started (you pressed the button: consent for this run)",
                   step="backup")
        self.save(run)
        self._launch(run, self._run)
        return self.public(run)

    def pause(self, principal: str, run_id: str) -> dict:
        run = self.owned(principal, run_id)
        if self.alive(run_id):
            self._ctl[run_id]["pause"] = True
            run["status"], run["phase"] = "pausing", "Pausing after the current answer…"
            self.event(run, "pause", "You pressed Pause")
            self.save(run)
        return self.public(run)

    def resume(self, principal: str, run_id: str) -> dict:
        run = self.owned(principal, run_id)
        if run["status"] in ("done", "cancelled"):
            raise BookforgeError("INVALID_INPUT", "/run_id", f"this run is {run['status']}", status="REJECTED")
        with self._lock:
            if self.alive(run_id):
                if self._ctl.get(run_id, {}).get("pause"):
                    self._ctl[run_id]["pause"] = False
                    run["status"], run["phase"] = "running", "Continuing"
                    self.save(run)
                return self.public(run)
            if self.active():
                raise BookforgeError("VERSION_CONFLICT", "/run", "another Make-a-book run is working",
                                     status="REJECTED")
            run["status"], run["phase"], run["problem"], run["pause_reason"] = "running", \
                "Continuing where it stopped", None, None
            for s in run["steps"]:
                if s["state"] in ("paused", "failed", "running", "waiting"):
                    s["state"], s["problem"] = "pending", None
            self.event(run, "resume", "Resumed")
            self.save(run)
            self._launch(run, self._run)
            return self.public(run)

    def cancel(self, principal: str, run_id: str) -> dict:
        run = self.owned(principal, run_id)
        if run["status"] in ("done", "cancelled"):
            return self.public(run)
        if self.alive(run_id):
            self._ctl[run_id]["cancel"] = True
            run["status"], run["phase"] = "pausing", "Cancelling after the current answer…"
        else:
            self._finish_cancel(run)
        self.event(run, "cancel", "You pressed Cancel")
        self.save(run)
        return self.public(run)

    def decide(self, principal: str, run_id: str, body) -> dict:
        """The author's decision on a paused step: approve anyway / try again / I edited it."""
        run = self.owned(principal, run_id)
        body = body if isinstance(body, dict) else {}
        action = body.get("action")
        if action not in ("approve_anyway", "retry", "edited"):
            raise BookforgeError("INVALID_INPUT", "/action", "action: approve_anyway, retry or edited",
                                 status="REJECTED")
        if self.alive(run_id):
            raise BookforgeError("VERSION_CONFLICT", "/run", "the run is still working; pause it first",
                                 status="REJECTED")
        if run.get("status") not in ("paused", "interrupted"):
            # Nothing may change behind an error answer: refuse before approving anything.
            raise BookforgeError("INVALID_INPUT", "/run_id", f"this run is {run.get('status')}: there is nothing "
                                 "to decide (nothing was changed)", status="REJECTED")
        prob = run.get("problem") or {}
        rid = prob.get("record_id")
        if action == "approve_anyway":
            if body.get("author_confirms") is not True:
                raise BookforgeError("APPROVAL_REQUIRED", "/author_confirms", "approving needs your explicit "
                                     "confirmation (author_confirms: true)", status="REJECTED")
            if not rid:
                raise BookforgeError("INVALID_INPUT", "/action", "there is no draft waiting for a decision",
                                     status="REJECTED")
            out = self.app.review.approve(principal, run["project_id"], run["branch_id"],
                                          {"record_ids": [rid], "author_confirms": True, "how": "one"})
            res = out["results"][0] if out.get("results") else {"ok": False, "message": "not approved"}
            if not res.get("ok"):
                raise BookforgeError("INVALID_INPUT", "/action", res.get("message") or "it could not be approved",
                                     status="REJECTED")
            self.event(run, "approve", "You approved it anyway (your own approval)", approval="author",
                       record_id=rid)
        elif action == "retry" and rid:
            counts = run.setdefault("fix_counts", {})
            counts[rid] = 0
            for k in [k for k in counts if k.startswith("redo:")]:
                counts[k] = 0  # "Try again" gives the AI new attempts at a draft BookForge's checks refused
            self.event(run, "retry", "You asked the AI to try again")
        else:
            self.event(run, "retry", "Continuing after your change" if action == "edited" else "Trying again")
        self.save(run)
        return self.resume(principal, run_id)

    # ------------------------------------------------------------------ settings
    def _clean_settings(self, body) -> dict:
        out = {"genre": "", "length": "short_story", "slot_id": None, "idea": ""}
        g = body.get("genre")
        if g not in (None, ""):
            if not isinstance(g, str) or len(g.strip()) > 120:
                raise BookforgeError("INVALID_INPUT", "/genre", "genre: up to 120 characters", status="REJECTED")
            out["genre"] = g.strip()
        ln = body.get("length")
        if ln not in (None, ""):
            if ln not in LENGTHS:
                raise BookforgeError("INVALID_INPUT", "/length", "length: short_story, novella or novel",
                                     status="REJECTED")
            out["length"] = ln
        out["slot_id"] = AssistService._check_slot(body.get("slot_id"))
        idea = body.get("idea")
        if idea not in (None, ""):
            if not isinstance(idea, str) or len(idea) > 2000:
                raise BookforgeError("INVALID_INPUT", "/idea", "your idea: up to 2000 characters", status="REJECTED")
            out["idea"] = idea.strip()
        return out

    # ------------------------------------------------------------------ services bound to this run's AI choice
    def _services(self, run):
        slot = run["settings"].get("slot_id")
        providers = PinnedProviders(self.app.engine.providers, slot)
        engine = Engine(self.store, self.app.engine.contracts, providers=providers)
        assist = AssistService(engine, run["principal"], retry_busy=True)
        assist.retry_policy = self.retry_policy
        review = ReviewService(engine, assist, run["principal"], work=self.app.work, on_change=self.app.changed)
        return engine, assist, review

    def bp(self, run) -> BookPath:
        return BookPath(self._engine, run["principal"], run["project_id"], run["branch_id"])

    def _job(self, run, kind, op=None) -> Job:
        job = Job(kind, run["principal"], run["project_id"], run["branch_id"], op, run["settings"].get("slot_id"))
        job.started = time.time()
        job.status = "running"
        job.retry_busy = True
        job.check = lambda: self.check(run)  # type: ignore[method-assign]
        job.on_wait = lambda info: self.on_wait(run, info)
        return job

    # ------------------------------------------------------------------ the run
    def _step(self, run, sid) -> dict:
        return next(s for s in run["steps"] if s["id"] == sid)

    @staticmethod
    def _ensure_steps(run):
        """A run saved by an older BookForge (resumed after an update) gets the steps added since, in order."""
        have = {s["id"]: s for s in run.get("steps") or []}
        if all(sid in have for sid in STEP_IDS):
            return
        out = []
        for sid, st, op, title, about in STEPS:
            if sid in have:
                out.append(have[sid])
                continue
            out.append({"id": sid, "set": st, "op": op, "title": title, "about": about, "state": "pending",
                        "message": "", "started_at": None, "finished_at": None, "problem": None, "items": []})
        run["steps"] = out

    def _run(self, run_id: str):
        run = self.get(run_id)
        self._ensure_steps(run)
        self._tl.engine, self._tl.assist, self._tl.review = self._services(run)
        self._tl.run_id = run_id
        run["status"] = "running"
        self.save(run)
        health = self.app.engine.providers.health
        health.set_listener(lambda info: self.on_failover(run, info))
        try:
            self.probe_ais(run)
            if run.get("project_id") and self.store.project(run["project_id"]) is None:
                run["current"] = run.get("current") or "profile"
                raise StepProblem("NOT_FOUND", "This run's book no longer exists: it was removed (for example by "
                                  "restoring a backup made before the book was created).", BOOK_GONE_FIX,
                                  options=[])
            for sid in STEP_IDS:
                st = self._step(run, sid)
                if st["state"] in ("done", "skipped"):
                    continue
                self.check(run)
                run["current"] = sid
                st.update(state="running", started_at=st.get("started_at") or now_iso(), finished_at=None,
                          problem=None, message="Working…")
                run["phase"] = f"{st['title']}…"
                self.refresh_ais(run)
                self.save(run)
                getattr(self, f"_s_{sid}")(run, st)
                st.update(state="done", finished_at=now_iso())
                if not st.get("message") or st["message"] == "Working…":
                    st["message"] = "Done"
                self.event(run, "done", f"{st['title']}: {st['message']}", step=sid)
                self.save(run)
            run.update(status="done", finished_at=now_iso(), current=None, waiting=None,
                       phase="Your book is made — download it below")
            self.event(run, "finished", "Your book is made: PDF, EPUB and Word files are ready")
            es = run.get("editor_summary") or {}
            if es.get("reviewed"):
                fl = es.get("flagged") or []
                self.event(run, "note", f"Editor: {es['reviewed']} chapter(s) read, {es.get('passed', 0)} passed, "
                           f"{es.get('kept', 0)} rewrite(s) kept, {es.get('rejected', 0)} not kept"
                           + (f" — ⚠️ still had notes on {', '.join(str(f.get('label')) for f in fl)}" if fl else ""),
                           code="EDITOR_NOTES" if fl else None)
            rs = run.get("review_summary") or {}
            if rs.get("same_ai"):
                self.event(run, "note", f"⚠️ {NOT_INDEPENDENT}: {rs['same_ai']} of {rs['same_ai'] + rs.get('independent', 0)}"
                           " AI review(s) were made by the AI that wrote the draft (only one AI worked then)",
                           code="REVIEW_NOT_INDEPENDENT")
            self._length_warning(run)
            self.save(run)
        except RunPaused:
            st = self._step(run, run.get("current") or "backup")
            if st["state"] == "running":
                st["state"] = "paused"
                st["message"] = "Paused by you"
            run.update(status="paused", pause_reason="author", waiting=None, phase="Paused — press ▶ Resume to continue")
            self.save(run)
        except RunCancelled:
            self._finish_cancel(run)
            self.save(run)
        except StepProblem as exc:
            self._pause_problem(run, exc.problem)
        except StepError as exc:
            self._pause_problem(run, {"code": exc.code or "INVALID_INPUT", "message": exc.message,
                                      "fix": "Press 🔁 Try again. If it fails again, open the book and do this step "
                                             "yourself.", "details": exc.problems[:6]})
        except BookforgeError as exc:
            e = exc.errors[0] if exc.errors else {}
            code = exc.code
            fix = TIMEOUT_FIX if code == "TIMEOUT" else BUSY_FIX if code in BUSY_CODES else (
                "Press 🔁 Try again. If it keeps failing, use 📋 Copy diagnostics.")
            self._pause_problem(run, {"code": code, "message": e.get("message") or code, "fix": fix,
                                      "path": e.get("path") or ""})
        except Cancelled:
            self._finish_cancel(run)
            self.save(run)
        except Exception as exc:  # noqa: BLE001 - shown as a ⚠️ on the step, logged here
            log.exception("make-a-book run %s: unexpected problem in step %s", run_id, run.get("current"))
            self._pause_problem(run, {"code": "INTERNAL_ERROR",
                                      "message": f"BookForge hit an unexpected problem ({type(exc).__name__}).",
                                      "fix": "Press 🔁 Try again. If it keeps happening, use 📋 Copy diagnostics."})
        finally:
            health.set_listener(None)
            self._tl.run_id = None
            self._tl.engine = self._tl.assist = self._tl.review = None

    def _length_warning(self, run):
        """A made book far below the length the author chose is flagged (it is still made: the files are ready)."""
        try:
            words = self.bp(run).word_stats()
        except Exception:  # noqa: BLE001 - a word count must never break a finished run
            return
        if words.get("short"):
            run["problem"] = {"code": "BOOK_TOO_SHORT", "severity": "warning", "message": words["warning"],
                              "fix": "Open the book to rewrite chapters longer (🔁 Redo with AI), or change the length "
                                     "in the book profile.", "words": words["words"],
                              "target_words": words["target_words"], "step": "chapters", "at": now_iso()}
            self.event(run, "note", words["warning"], step="chapters", code="BOOK_TOO_SHORT")

    def _pause_problem(self, run, problem: dict):
        sid = run.get("current") or "backup"
        st = self._step(run, sid)
        where = {"book": run.get("title") or "New book", "step": st["title"], "set": st.get("set"),
                 "set_name": SET_NAMES.get(st.get("set") or "", None), "op": problem.get("op") or st.get("op")}
        if problem.get("chapter_id"):
            where["chapter"] = problem["chapter_id"]
        problem = dict(problem, where=where, step=sid, at=now_iso())
        if problem.get("code") == "TIMEOUT":
            problem.setdefault("options", ["retry"])
        st.update(state="failed" if problem.get("code") not in ("TIMEOUT", "REVIEW_NOT_PASSED", "CHECKS_REFUSED")
                  else "paused",
                  problem=problem, message=problem["message"])
        run.update(status="paused", pause_reason="problem", problem=problem, waiting=None,
                   phase=f"⚠️ {st['title']}: needs you")
        self.event(run, "problem", problem["message"], step=sid, code=problem.get("code"))
        self.save(run)

    def _finish_cancel(self, run):
        for s in run["steps"]:
            if s["state"] in ("running", "waiting", "paused", "failed"):
                s["state"] = "cancelled" if s["state"] != "failed" else "failed"
        run.update(status="cancelled", finished_at=now_iso(), waiting=None,
                   phase="Cancelled. The book made so far stays in Your books.")

    # ------------------------------------------------------------------ approvals under the run consent
    def _check_consent(self, run, project_id):
        """Approvals under the run consent happen only inside the live thread of the run the author started, while it
        runs, for that run's own book."""
        if (getattr(self, "_thread_run", None) != run["id"] or threading.current_thread() is not
                self._threads.get(run["id"]) or not run.get("consent") or run.get("status") not in ("running", "waiting")
                or project_id != run.get("project_id")):
            raise BookforgeError("PERMISSION_DENIED", "/consent", "approvals under the Make-a-book consent happen only "
                                 "inside the run the author started, for that run's own book", status="REJECTED")

    def _approve(self, run, ref, *, why: str, verdict: str | None = None, slot: str | None = None) -> dict:
        """Approve exactly this revision under the author's consent for THIS run (never outside one)."""
        self._check_consent(run, ref.get("project_id"))
        bp = self.bp(run)
        res = bp.approve_ref(ref)
        label = f"Approved under your Make-a-book-for-me consent, run {run['id']}"
        with self.store.transaction() as tx:
            tx.insert_outbox(run["project_id"], run["branch_id"],
                             "autobook.approved_under_consent" if res.get("ok") else "autobook.approve_failed",
                             {"record_id": ref["record_id"], "version": ref["version"], "module_id": ref["module_id"],
                              "run_id": run["id"], "consent": {"by": run["consent"]["by"], "at": run["consent"]["at"]},
                              "why": why, "verdict": verdict, "ai_slot": slot, "ok": bool(res.get("ok")),
                              "label": label if res.get("ok") else "Approval under the run consent was refused by "
                              "BookForge's checks"})
        if not res.get("ok"):
            raise self._refused(ref, safe_title(self.app.engine.contracts, bp.rec(ref["record_id"]) or ref),
                                res.get("problems") or [])
        self.event(run, "approve", f"{safe_title(self.app.engine.contracts, bp.rec(ref['record_id']))}: {label}",
                   approval="run_consent", record_id=ref["record_id"], module_id=ref["module_id"], verdict=verdict)
        return res

    @staticmethod
    def _refused(ref, label: str, probs: list, chapter_id: str | None = None) -> ChecksRefused:
        rules = {str(p).split(":", 1)[0].strip() for p in probs or []}
        stale = bool(rules) and rules <= {"STALE", "SOURCE_PIN", "INPUT_NOT_VALIDATED"}
        return ChecksRefused("CHECKS_REFUSED", f"BookForge's checks refused the {label}: " + plain_problem(probs),
                             STALE_FIX if stale else CHECKS_FIX, record_id=ref["record_id"],
                             version=ref.get("version"), module_id=ref["module_id"], details=digest(probs),
                             chapter_id=chapter_id, options=["retry"] if stale else ["edit", "retry"])

    def _review_until_approved(self, run, st, rid: str, label: str, chapter_id: str | None = None):
        """BookForge's checks, then AI review -> approve under consent, or fix (max 2) -> review again; else pause
        for the author. A draft the checks refuse is not sent to the AI reviewer (ChecksRefused)."""
        bp = self.bp(run)
        counts = run.setdefault("fix_counts", {})
        while True:
            self.check(run)
            head = bp.rec(rid)
            if head is None:
                raise StepProblem("NOT_FOUND", f"The draft of the {label} disappeared.", "Press 🔁 Try again.")
            if head["lifecycle"] in ("APPROVED", "LOCKED") or head.get("approved_version") == head["version"]:
                return head
            v = bp.dispatch(head["module_id"], "VALIDATE", base_ref=head["ref"],
                            payload=candidate_payload(head["ref"], None))
            if v["status"] not in ("VALIDATED", "APPROVED"):
                self.event(run, "problem", f"BookForge's checks refused the {label}", record_id=rid,
                           code="CHECKS_REFUSED")
                raise self._refused(head["ref"], label, problems(v), chapter_id)
            st["message"] = f"AI is reviewing the {label}"
            run["phase"] = st["message"]
            self.save(run)
            job = self._job(run, "review", head["module_id"])
            # The reviewer is chosen automatically: a working AI other than the one that wrote the draft (P3.1),
            # even when the run writes with the one AI the author picked.
            rj = ReviewJob("review", run["principal"], run["project_id"], run["branch_id"], [rid], None)
            for k in ("started", "status", "retry_busy", "check", "on_wait"):
                setattr(rj, k, getattr(job, k))
            editor_next = head["module_id"] == "C02" and self._editor_settings(run).get("enabled")
            try:
                res = self._review.review_one(rj, rid, auto=not editor_next)
            except BookforgeError as exc:
                self._ai_problem(exc, f"reviewing the {label}", record_id=rid, chapter_id=chapter_id)
            verdict = res["review"]["verdict"]
            self._note_review(run, st, label, res["review"])
            self.event(run, "review", f"AI review of the {label}: {verdict} · {st['review_note']}", verdict=verdict,
                       slot=rj.slot, record_id=rid, independent=res["review"].get("independent"))
            if res.get("auto_approved"):
                self.event(run, "approve", f"{label}: approved by your standing auto-approve setting",
                           approval="standing_auto_approve", record_id=rid)
                return bp.rec(rid)
            head = bp.rec(rid)
            if verdict == "APPROVE":
                why = f"AI review: APPROVE ({label})"
                if editor_next:
                    head = self._editor_pass(run, st, rid, label, chapter_id)
                    ed = (run.get("editor") or {}).get(rid) or {}
                    why += " · editor: " + ("PASS" if ed.get("verdict") == "PASS" and not ed.get("flagged") else
                                            "still had notes (rounds used up or rewrite not kept)" if ed.get("flagged")
                                            else "not run")
                self._approve(run, head["ref"], why=why, verdict="APPROVE", slot=rj.slot)
                return bp.rec(rid)
            n = int(counts.get(rid, 0))
            if n >= MAX_FIXES:
                reasons = res["review"].get("reasons") or []
                raise StepProblem("REVIEW_NOT_PASSED",
                                  f"The AI reviewer still says {verdict} for the {label} after {MAX_FIXES} fixes.",
                                  "Decide: ✔ Approve anyway (your own approval), ✏️ Edit it yourself and then press "
                                  "Continue, or 🔁 Try again (the AI gets two more fixes).",
                                  record_id=rid, version=head["version"], module_id=head["module_id"],
                                  verdict=verdict, reasons=reasons[:4], chapter_id=chapter_id,
                                  options=["approve_anyway", "edit", "retry"])
            counts[rid] = n + 1
            st["message"] = f"AI is fixing the {label} (fix {n + 1} of {MAX_FIXES})"
            run["phase"] = st["message"]
            self.event(run, "fix", f"Asked the AI to fix the {label} ({verdict}; fix {n + 1} of {MAX_FIXES})",
                       record_id=rid)
            self.save(run)
            fj = ReviewJob("fix", run["principal"], run["project_id"], run["branch_id"], [rid],
                           run["settings"].get("slot_id"))
            for k in ("started", "status", "retry_busy", "check", "on_wait"):
                setattr(fj, k, getattr(job, k))
            try:
                self._review._run_fix(fj)
                self.event(run, "fix_done", f"The AI made a new version of the {label}", record_id=rid)
            except BookforgeError as exc:
                if exc.code in ("TIMEOUT",) or exc.code in BUSY_CODES or exc.code == "CAPABILITY_UNAVAILABLE":
                    self._ai_problem(exc, f"fixing the {label}", record_id=rid, chapter_id=chapter_id)
                self.event(run, "fix_failed", f"The AI's fix of the {label} did not pass BookForge's checks; "
                                              "nothing was saved", code=exc.code, record_id=rid)
            self.save(run)

    # ------------------------------------------------------------------ 🖋 the editor inside a run (P4 / P5)
    def _editor_snapshot(self) -> dict:
        try:
            es = self.app.review.editor.settings()
        except Exception:  # noqa: BLE001 - the default editor settings
            log.exception("could not read the editor settings")
            es = {"enabled": True, "rounds": 2, "strictness": "normal"}
        return {k: es[k] for k in ("enabled", "rounds", "strictness")}

    def _editor_settings(self, run) -> dict:
        if not run.get("editor_settings"):
            run["editor_settings"] = self._editor_snapshot()
        return run["editor_settings"]

    def _sub_job(self, run, kind: str, rid: str, slot=None) -> ReviewJob:
        job = self._job(run, kind, "C02")
        rj = ReviewJob(kind, run["principal"], run["project_id"], run["branch_id"], [rid], slot)
        for k in ("started", "status", "retry_busy", "check", "on_wait"):
            setattr(rj, k, getattr(job, k))
        return rj

    def _editor_pass(self, run, st, rid: str, label: str, chapter_id: str | None) -> dict:
        """The editor reads the chapter (its consistency review passed); REVISE -> the writer rewrites only the
        flagged passages -> pattern check + consistency review + editor again on the new version -> the rewrite is
        kept only when nothing got worse, else the earlier text is restored. At most ``rounds`` rewrites; when the
        editor still has notes, the chapter is approved under the run consent and marked ⚠️ (never blocks the book).
        Returns the head revision to approve."""
        es = self._editor_settings(run)
        head = self.bp(run).rec(rid)
        if not es.get("enabled") or head["module_id"] != "C02":
            return head
        ed = run.setdefault("editor", {}).setdefault(rid, {"chapter_id": chapter_id, "label": label, "rounds": 0,
                                                           "history": [], "kept": 0, "rejected": 0})
        if ed.get("done_version") == head["version"]:
            return head
        ed.update(flagged=False, notes=[], flag_reason=None, error=None)
        craft = self._craft(run, st, rid, label, ed, ed["rounds"])
        while True:
            self.check(run)
            head = self.bp(run).rec(rid)
            if craft is None:
                return self._editor_flag(run, st, ed, None, head, "the editor could not read it", "EDITOR_FAILED")
            if craft["verdict"] == "PASS":
                ed.update(verdict="PASS", flagged=False, done_version=head["version"], notes=[])
                st["editor_note"] = self._editor_line(ed)
                self._editor_summary(run)
                self.save(run)
                return head
            if ed["rounds"] >= int(es.get("rounds") or 0):
                return self._editor_flag(run, st, ed, craft, head, f"{ed['rounds']} editor round(s) used up"
                                         if ed["rounds"] else "editor rounds are set to 0", "EDITOR_NOTES")
            ed["rounds"] += 1
            n, total = ed["rounds"], int(es.get("rounds") or 0)
            st["message"] = f"The writer is reworking the editor's notes on the {label} (round {n} of {total})"
            run["phase"] = st["message"]
            self.save(run)
            made = self._editor_rewrite(run, rid, label, craft, ed, n)
            if made is None:
                return self._editor_flag(run, st, ed, craft, self.bp(run).rec(rid),
                                         ed.get("flag_reason") or "the writer's changes could not be applied",
                                         "EDITOR_NOTES")
            applied, old = made
            ok, code, why, new_craft = self._regression(run, st, rid, label, ed, n, old, craft, applied)
            ed["history"].append({"round": n, "rewrite": "kept" if ok else "not kept", "code": code,
                                  "applied": len(applied), "at": now_iso()})
            if ok:
                ed["kept"] = int(ed.get("kept", 0)) + 1
                self._made(run, self.bp(run).rec(rid)["ref"])
                self.event(run, "editor", f"Editor's rewrite of the {label} kept (round {n}): {why}", record_id=rid,
                           code="EDITOR_REWRITE_KEPT")
                craft = new_craft
                continue
            ed["rejected"] = int(ed.get("rejected", 0)) + 1
            try:
                ref = self._review.editor.restore(run["principal"], run["project_id"], run["branch_id"], rid, old, code)
                self._made(run, ref)
            except BookforgeError as exc:
                raise StepProblem(exc.code, f"The editor's rewrite of the {label} was not good enough and the earlier "
                                  "text could not be put back.", "Press 🔁 Try again.", record_id=rid,
                                  chapter_id=chapter_id) from None
            self.event(run, "note", f"⚠️ The editor's rewrite of the {label} was not kept (round {n}): {why}; the "
                       "earlier text is used", code="EDITOR_REWRITE_REJECTED", record_id=rid)
            return self._editor_flag(run, st, ed, craft, self.bp(run).rec(rid), f"rewrite not kept — {why}",
                                     "EDITOR_NOTES")

    def _craft(self, run, st, rid, label, ed, round_no):
        st["message"] = f"The editor is reading the {label}" + (f" again (after round {round_no})" if round_no else "")
        run["phase"] = st["message"]
        self.save(run)
        rj = self._sub_job(run, "editor", rid)
        try:
            craft = self._review.editor.craft_one(rj, rid, round_no=round_no)
        except BookforgeError as exc:
            ed["error"] = exc.code
            self.event(run, "note", f"⚠️ The editor could not read the {label} ({exc.code}); the book goes on without "
                       "the editor's opinion on it", code="EDITOR_FAILED", record_id=rid)
            self.save(run)
            return None
        low = min(craft["scores"].items(), key=lambda kv: kv[1])
        ed.update(verdict=craft["verdict"], scores=craft["scores"], min_score=craft["min_score"],
                  avg_score=craft["avg_score"], counts=craft["counts"], reviewer=craft.get("reviewer"),
                  independent=craft.get("independent"), version=craft["version"])
        ed["history"].append({"round": round_no, "version": craft["version"], "verdict": craft["verdict"],
                              "avg": craft["avg_score"], "min": craft["min_score"], "major": craft["counts"]["major"],
                              "minor": craft["counts"]["minor"], "editor": craft.get("reviewer"),
                              "patterns": (craft.get("pattern") or {}).get("summary"), "at": now_iso()})
        self.event(run, "editor", f"Editor ({craft.get('reviewer') or 'AI'}) on the {label}: {craft['verdict']} · "
                   f"{craft['counts']['major']} major / {craft['counts']['minor']} minor note(s) · lowest "
                   f"{EDITOR_LABELS.get(low[0], low[0])} {low[1]}", verdict=craft["verdict"], record_id=rid,
                   slot=rj.slot, independent=craft.get("independent"))
        if craft.get("independent") is False:
            self.event(run, "note", f"⚠️ {NOT_INDEPENDENT} (the editor of the {label} is the AI that wrote it)",
                       code="REVIEW_NOT_INDEPENDENT")
        st["editor_note"] = self._editor_line(ed)
        self.save(run)
        return craft

    def _editor_rewrite(self, run, rid, label, craft, ed, n):
        """The writer rewrites only the flagged passages; applied exactly through the normal UPDATE. Returns
        (applied [with their passages], the old revision) or None (nothing could be applied; noted)."""
        editor = self._review.editor
        old = self.bp(run).rec(rid)
        rj = self._sub_job(run, "editor_fix", rid, run["settings"].get("slot_id"))
        try:
            prop = editor.propose(rj, rid, craft=craft)
        except BookforgeError as exc:
            ed["flag_reason"] = f"the writer could not rework the notes ({exc.code})"
            self.event(run, "note", f"⚠️ The writer could not rework the editor's notes on the {label} ({exc.code})",
                       code="EDITOR_FAILED", record_id=rid)
            return None
        if not prop["applied"]:
            ed["flag_reason"] = "the writer's changes did not match the chapter word for word"
            self.event(run, "note", f"⚠️ None of the writer's changes to the {label} matched the text word for word "
                       f"({prop['unresolved']} note(s) unresolved); nothing was guessed", code="EDITOR_UNRESOLVED",
                       record_id=rid)
            return None
        try:
            out = editor.apply(run["principal"], run["project_id"], run["branch_id"], rid, old["version"], None,
                               proposal=prop, round_no=n, how="run")
        except BookforgeError as exc:
            ed["flag_reason"] = f"the rewritten chapter was refused ({exc.code})"
            self.event(run, "note", f"⚠️ The rewritten {label} did not pass BookForge's checks, so it was not saved",
                       code="EDITOR_FAILED", record_id=rid)
            return None
        byf = {f["id"]: f for f in craft.get("findings") or []}
        applied = [dict(a, passage=(byf.get(a["finding_id"]) or {}).get("passage")) for a in out["applied"]]
        ed["unresolved"] = len(out["unresolved"])
        self.event(run, "rewrite", f"The writer reworked {len(applied)} passage(s) of the {label} (round {n}"
                   + (f"; {len(out['unresolved'])} note(s) could not be matched word for word" if out["unresolved"]
                      else "") + ")", record_id=rid)
        self.save(run)
        return applied, old

    def _regression(self, run, st, rid, label, ed, n, old, old_craft, applied):
        """Check the rewrite like a new draft: BookForge's checks, the consistency reviewer, the pattern checker and
        the editor; keep it only when nothing got worse (editor.judge_rewrite)."""
        bp = self.bp(run)
        new = bp.rec(rid)
        v = bp.dispatch(new["module_id"], "VALIDATE", base_ref=new["ref"], payload=candidate_payload(new["ref"], None))
        checks_ok = v["status"] in ("VALIDATED", "APPROVED")
        cons, new_craft = None, None
        if checks_ok:
            st["message"] = f"AI is reviewing the rewritten {label}"
            run["phase"] = st["message"]
            self.save(run)
            rj = self._sub_job(run, "review", rid)
            try:
                res = self._review.review_one(rj, rid, auto=False)
                cons = res["review"]["verdict"]
                self._note_review(run, st, label, res["review"])
            except BookforgeError as exc:
                self.event(run, "note", f"⚠️ The rewritten {label} could not be reviewed ({exc.code})",
                           code="EDITOR_FAILED", record_id=rid)
            if cons == "APPROVE":
                new_craft = self._craft(run, st, rid, label, ed, n)
        old_text = str((old.get("data") or {}).get("text") or "")
        new_text = str((self.bp(run).rec(rid).get("data") or {}).get("text") or "")
        lost = lost_keeps(old_text, new_text, keep_quotes_of(old_craft, old_text))
        ok, code, why = judge_rewrite(old_craft, new_craft, consistency=cons, checks_ok=checks_ok, keep_lost=lost,
                                      applied=applied, new_text=new_text)
        return ok, code, why, new_craft

    def _editor_flag(self, run, st, ed, craft, head, why: str, code: str) -> dict:
        notes = []
        for f in (craft or {}).get("findings") or []:
            notes.append({"id": f["id"], "label": f.get("label"), "severity": f.get("severity"),
                          "why": str(f.get("why") or "")[:200], "passage": str(f.get("passage") or "")[:80]})
        ed.update(flagged=True, done_version=head["version"], notes=notes[:6], flag_reason=why, code=code)
        self.event(run, "note", f"⚠️ Editor still had notes on the {ed.get('label')} ({why}); it is approved under "
                   "your run consent — see the run summary", code="EDITOR_NOTES", record_id=head["record_id"])
        st["editor_note"] = self._editor_line(ed)
        self._editor_summary(run)
        self.save(run)
        return head

    @staticmethod
    def _editor_line(ed: dict) -> str:
        bits = [f"editor: {ed.get('verdict') or '…'}"]
        if ed.get("avg_score") is not None:
            bits.append(f"avg {ed['avg_score']}, lowest {ed.get('min_score')}")
        if ed.get("rounds"):
            bits.append(f"{ed['rounds']} rewrite round(s)")
        if ed.get("reviewer"):
            bits.append(f"by {ed['reviewer']}")
        return " · ".join(bits) + (" ⚠️ still had notes" if ed.get("flagged") else "")

    def _editor_summary(self, run):
        eds = list((run.get("editor") or {}).values())
        run["editor_summary"] = {
            "reviewed": sum(1 for e in eds if e.get("history")), "passed": sum(1 for e in eds if e.get("verdict") ==
                                                                               "PASS" and not e.get("flagged")),
            "rounds": sum(int(e.get("rounds") or 0) for e in eds), "kept": sum(int(e.get("kept") or 0) for e in eds),
            "rejected": sum(int(e.get("rejected") or 0) for e in eds),
            "flagged": [{"chapter_id": e.get("chapter_id"), "label": e.get("label"), "reason": e.get("flag_reason"),
                         "notes": e.get("notes") or []} for e in eds if e.get("flagged")],
            "settings": run.get("editor_settings")}

    def _note_review(self, run, st, label: str, review: dict):
        """"written by X · reviewed by Y" on the step, and the run's count of independent / same-AI reviews (P3.2)."""
        writer = review.get("writer") or "the author"
        note = f"written by {writer} · reviewed by {review.get('reviewer') or review.get('slot') or 'the AI'}"
        same = review.get("independent") is False
        if same:
            note += f" ⚠️ {NOT_INDEPENDENT}"
        st["review_note"] = note
        st["review_independent"] = not same
        rs = run.setdefault("review_summary", {"independent": 0, "same_ai": 0})
        rs["same_ai" if same else "independent"] = int(rs.get("same_ai" if same else "independent", 0)) + 1
        if same:
            rs["warning"] = NOT_INDEPENDENT
            self.event(run, "note", f"⚠️ {NOT_INDEPENDENT} ({label}: {writer})", code="REVIEW_NOT_INDEPENDENT")

    def _ai_problem(self, exc: BookforgeError, what: str, **extra):
        e = exc.errors[0] if exc.errors else {}
        if exc.code == "TIMEOUT":
            raise StepProblem("TIMEOUT", f"The AI did not answer in time while {what}.", TIMEOUT_FIX, **extra) from None
        if exc.code in BUSY_CODES:
            raise StepProblem(exc.code, e.get("message") or "the AI stayed busy", BUSY_FIX, **extra) from None
        if exc.code == "CAPABILITY_UNAVAILABLE":
            raise StepProblem(exc.code, f"No AI was ready while {what}.", "Open Settings and connect an AI, then press "
                              "🔁 Try again.", **extra) from None
        raise StepProblem(exc.code, f"Something went wrong while {what}: {e.get('message') or exc.code}",
                          "Press 🔁 Try again.", **extra) from None

    # ------------------------------------------------------------------ steps
    def _s_backup(self, run, st):
        b = self.app.backups.try_backup("before-run")
        st["message"] = f"Backup saved ({b['name']})" if b else "Backup could not be written (continuing; see Health)"
        self.event(run, "backup", st["message"], step="backup")

    def _s_profile(self, run, st):
        s = run["settings"]
        if not run.get("project_id"):
            # The book's id comes from the run's id, so a BookForge stop between creating the book and saving the
            # run finds that book again on Resume instead of making a second one.
            pid = "proj-" + run["id"].split("-", 1)[-1]
            if self.store.project(pid) is None:
                self._engine.bootstrap_project(run["principal"], NEW_BOOK_NAME, project_id=pid,
                                               settings={"made_by_run": run["id"]},
                                               features={"character_arcs": False}, release_profiles=list(RELEASE))
                self.event(run, "project", "A new, separate book was created (your other books are not touched)")
            run["project_id"] = pid
            self.save(run)
        pid = run["project_id"]
        if not get_profile(self.store, pid).get("length"):
            save_profile(self.store, pid, {"length": s["length"], "chapters": CHAPTERS_FOR[s["length"]],
                                           "ai_slot": s.get("slot_id") or "", "genre": s.get("genre") or ""})
        prof = book_profile_brief(self.store, pid)
        if prof.get("title") and prof.get("idea"):
            self._name_book(pid, prof["title"])  # a stop between saving the profile and naming the book
            run["title"] = prof["title"]
            st["message"] = f"“{prof['title']}”"
            return
        wishes = {"length": LENGTHS[s["length"]][0]}
        if s.get("genre"):
            wishes["genre"] = s["genre"]
        if s.get("idea"):
            wishes["idea"] = s["idea"]
        job = self._job(run, "profile", "B01")
        st["message"] = "The AI is inventing your book"
        self.save(run)
        try:
            raw = self._assist._call_ai(job, op_for_roles="B01", task=PROFILE_TASK, schema=PROFILE_SCHEMA,
                                        context={"wishes": wishes, "lengths": {k: v[0] for k, v in LENGTHS.items()}},
                                        protected=[])
        except BookforgeError as exc:
            self._ai_problem(exc, "inventing the book")
        raw = raw if isinstance(raw, dict) else {}
        prof = {k: str(raw.get(k) or "").strip() for k in ("title", "author", "genre", "audience", "tone", "idea")}
        if s.get("genre"):
            prof["genre"] = s["genre"]
        prof["title"] = prof["title"][:200] or "Untitled book"
        prof["author"] = prof["author"][:200] or "BookForge author"
        prof["idea"] = (prof["idea"] or s.get("idea") or prof["title"])[:4000]
        for k, n in (("genre", 120), ("audience", 120), ("tone", 200)):
            prof[k] = prof[k][:n]
        with self.store.transaction():  # the profile and the book's name are saved together
            save_profile(self.store, pid, prof)
            self._name_book(pid, prof["title"])
        run["title"] = prof["title"]
        st["message"] = f"“{prof['title']}” by {prof['author']} ({prof['genre'] or 'any genre'})"
        self.event(run, "ai", f"The AI invented the book “{prof['title']}”", slot=job.slot)

    def _name_book(self, pid: str, title: str):
        with self.store.transaction() as tx:
            tx.execute("UPDATE projects SET name=? WHERE project_id=? AND name=?", (title, pid, NEW_BOOK_NAME))

    def _s_canon(self, run, st):
        canon_ops = ("A01", "A04", "A03")
        counts = CANON_COUNTS[run["settings"]["length"]]
        # Entries BookForge's checks refused and set aside, per section, that the Bible Builder must make again.
        remake = run.setdefault("canon_remake", {})
        made_missing = False  # the missing sections get one Bible Builder pass per step run (never a loop)
        while True:
            bp = self.bp(run)
            have = [r for op in canon_ops for r in bp.heads(op) if not r.get("stale")]
            # Make what is missing: everything on the first pass; after a stop or a refused save only the sections
            # with no entry yet (e.g. the places were saved but no main character), plus the entries set aside
            # because the checks refused them.
            missing = {op: n for op, n in counts.items() if not any(r["module_id"] == op for r in have)}
            want = {} if made_missing else dict(missing or ({} if have else counts))
            for op, n in remake.items():
                want[op] = max(want.get(op, 0), int(n))
            if want:
                made_missing = made_missing or bool(missing) or not have
                self._bible(run, st, want)
                run["canon_remake"] = remake = {}
                self.save(run)
                bp = self.bp(run)
                have = [r for op in canon_ops for r in bp.heads(op) if not r.get("stale")]
            if not any(r["module_id"] == "A01" for r in have):
                raise StepProblem("INVALID_INPUT", "The AI did not make a main character that BookForge could save.",
                                  "Press 🔁 Try again (the AI makes new characters).")
            todo = [r for r in have if r["lifecycle"] in REVIEWABLE and r.get("approved_version") != r["version"]
                    and not r.get("stale")]
            todo.sort(key=lambda r: (["A03", "A04", "A01"].index(r["module_id"]), r.get("created_at") or ""))
            redo = None
            for i, r in enumerate(todo):
                name = safe_title(self.app.engine.contracts, r)
                st["items"] = [{"id": x["record_id"], "label": safe_title(self.app.engine.contracts, x),
                                "state": "done" if j < i else "running" if j == i else "pending"}
                               for j, x in enumerate(todo)]
                try:
                    self._review_until_approved(run, st, r["record_id"], f"entry “{name}”")
                except ChecksRefused as exc:
                    # Bounded per section: at most MAX_FIXES new entries, then the run pauses for the author
                    # (🔁 Try again gives MAX_FIXES more). The author's own edit is never replaced (paused instead).
                    self._redo_refused(run, st, r["record_id"], f"redo:canon:{r['module_id']}", f"entry “{name}”",
                                       exc)
                    redo = r["module_id"]
                    break
            if redo is None:
                break
            remake[redo] = int(remake.get(redo, 0)) + 1
            self.save(run)
        n = len(self.bp(run).approved("A01"))
        st["items"] = [dict(x, state="done") for x in st.get("items") or []]
        st["message"] = f"{n} character(s) and {len(self.bp(run).approved('A04'))} place(s) approved"

    def _s_characters(self, run, st):
        """P7/P17: every approved character has a sheet and a voice card (made with the character by the Bible
        Builder; any character without one gets it now from the writer AI). Never blocks the book: a character whose
        sheet cannot be made is flagged ⚠️ and the run goes on (only TIMEOUT / a busy or missing AI pause it)."""
        bp = self.bp(run)
        pid, branch = run["project_id"], run["branch_id"]
        people = bp.approved("A01")
        st["items"] = [{"id": r["record_id"], "label": safe_title(self.app.engine.contracts, r), "state": "pending"}
                       for r in people]
        made = failed = 0
        for item, rec in zip(st["items"], people):
            self.check(run)
            entry = chars_mod.get_entry(self.store, pid, branch, rec["record_id"])
            if chars_mod.complete(entry):
                item.update(state="done", note="made with the character")
                continue
            item["state"] = "running"
            st["message"] = f"The AI is writing the sheet and voice of “{item['label']}”"
            run["phase"] = st["message"]
            self.save(run)
            rj = self._sub_job(run, "characters", rec["record_id"], run["settings"].get("slot_id"))
            try:
                chars_mod.generate(self._assist, rj, pid, branch, rec["record_id"])
            except BookforgeError as exc:
                if exc.code == "TIMEOUT" or exc.code in BUSY_CODES or exc.code == "CAPABILITY_UNAVAILABLE":
                    item["state"] = "paused"
                    self._ai_problem(exc, f"writing the sheet and voice of “{item['label']}”")
                failed += 1
                item.update(state="failed", note=exc.code)
                self.event(run, "note", f"⚠️ The sheet and voice of “{item['label']}” could not be made ({exc.code}); "
                           "the book goes on — make them on the character's page", code="CHARACTER_SHEET_FAILED",
                           record_id=rec["record_id"])
                self.save(run)
                continue
            made += 1
            item.update(state="done", note="made now")
            self.event(run, "characters", f"The AI wrote the sheet and voice card of “{item['label']}”",
                       slot=rj.slot, record_id=rec["record_id"])
            self.save(run)
        ok = sum(1 for i in st["items"] if i["state"] == "done")
        st["message"] = f"{ok} of {len(people)} character(s) have a sheet and a voice card" + (
            f" ({made} made now)" if made else "") + (f" · ⚠️ {failed} could not be made" if failed else "")

    def _scene_cards(self, run, st, cid: str, item: dict):
        """P8: before a chapter is written, the writer AI plans its scenes and an independent AI checks them (goal,
        obstacle from the world, something unsaid); REVISE -> the writer reworks them (max MAX_FIXES), then they are
        approved under the run consent (⚠️ flagged when the checker still had notes). Never blocks the book: only a
        TIMEOUT or a busy/missing AI pauses the step; any other failure writes the chapter from the outline alone."""
        bp = self.bp(run)
        outline = bp.outline()
        pid, branch = run["project_id"], run["branch_id"]
        planner = self._review.scenes
        label = f"chapter {cid}"
        entry = scenes_mod.get_entry(self.store, pid, branch, outline["record_id"], cid)
        if scenes_mod.usable(entry, outline) and entry.get("status") == "approved":
            item["scenes"] = scenes_mod.summary(entry, outline)
            return
        counts = run.setdefault("fix_counts", {})
        key = f"scenes:{outline['record_id']}:{cid}"
        try:
            if not scenes_mod.usable(entry, outline):
                st["message"] = f"The AI is planning the scenes of {label}"
                item["phase"] = "planning scenes"
                run["phase"] = st["message"]
                self.save(run)
                rj = self._sub_job(run, "scenes", cid, run["settings"].get("slot_id"))
                entry = planner.make(rj, cid)
                self.event(run, "scenes", f"The AI planned {len(entry['cards'])} scene(s) for {label}", slot=rj.slot)
            while True:
                self.check(run)
                st["message"] = f"An AI is checking the scenes of {label}"
                item["phase"] = "checking scenes"
                run["phase"] = st["message"]
                self.save(run)
                cj = self._sub_job(run, "scenes_check", cid)
                res = planner.check(cj, cid)
                self.event(run, "scenes", f"Scene check of {label}: {res['verdict']} · by {res.get('reviewer')}"
                           + (f" — {'; '.join(res['why'])}" if res.get("why") else ""), verdict=res["verdict"],
                           slot=cj.slot, independent=res.get("independent"))
                if res.get("independent") is False:
                    self.event(run, "note", f"⚠️ {NOT_INDEPENDENT} (the scenes of {label})",
                               code="REVIEW_NOT_INDEPENDENT")
                if res["verdict"] == "PASS":
                    flagged = False
                    break
                n = int(counts.get(key, 0))
                if n >= MAX_FIXES:
                    flagged = True
                    self.event(run, "note", f"⚠️ The scene checker still had notes on {label} after {MAX_FIXES} "
                               "reworks; the scenes are used as they are", code="SCENES_NOTES")
                    break
                counts[key] = n + 1
                st["message"] = f"The AI is reworking the scenes of {label} ({n + 1} of {MAX_FIXES})"
                item["phase"] = "reworking scenes"
                run["phase"] = st["message"]
                self.save(run)
                rj = self._sub_job(run, "scenes", cid, run["settings"].get("slot_id"))
                entry = planner.make(rj, cid, revise=True)
                self.event(run, "scenes", f"The AI reworked the scenes of {label} ({n + 1} of {MAX_FIXES})",
                           slot=rj.slot)
            self._check_consent(run, pid)
            text = f"Approved under your Make-a-book-for-me consent, run {run['id']}" + (
                " (the checker still had notes)" if flagged else "")
            entry = planner.approve(run["principal"], pid, branch, cid, version=res["version"], how="run_consent",
                                    run_id=run["id"], flagged=flagged, label=text)
            self.event(run, "scenes", f"Scene cards of {label}: {text}", approval="run_consent",
                       code="SCENES_NOTES" if flagged else None)
            item["scenes"] = scenes_mod.summary(entry, outline)
        except BookforgeError as exc:
            if exc.code == "TIMEOUT" or exc.code in BUSY_CODES or exc.code == "CAPABILITY_UNAVAILABLE":
                self._ai_problem(exc, f"planning the scenes of {label}", chapter_id=cid)
            if exc.code == "PERMISSION_DENIED":
                raise
            item["scenes"] = dict(scenes_mod.summary(
                scenes_mod.get_entry(self.store, pid, branch, outline["record_id"], cid), outline) or {},
                failed=exc.code)
            self.event(run, "note", f"⚠️ The scenes of {label} could not be planned or checked ({exc.code}); the "
                       "chapter is written from the outline" + (" and the unchecked scene cards" if
                                                                scenes_mod.usable(scenes_mod.get_entry(
                                                                    self.store, pid, branch, outline["record_id"],
                                                                    cid), outline) else ""),
                       code="SCENES_FAILED")
        finally:
            item.pop("phase", None)
            self.save(run)

    def _bible(self, run, st, counts):
        prof = book_profile_brief(self.store, run["project_id"])
        sess = BibleSession(self._assist, run["principal"], run["project_id"], run["branch_id"],
                            prof.get("idea") or prof.get("title") or "a new book", run["settings"].get("slot_id"))
        sess._check_cancel = lambda: self.check(run)  # type: ignore[method-assign]
        orig_job = sess._job

        def hooked_job(op_id, slot):
            j = orig_job(op_id, slot)
            j.retry_busy = True
            j.on_wait = lambda info: self.on_wait(run, info)
            return j
        sess._job = hooked_job  # type: ignore[method-assign]
        sess.current = {"run": 1, "t0": time.time(), "phase": "Starting"}
        st["message"] = "The AI is sketching the characters and places"
        self.save(run)
        sess._run_sections({"run": 1, "sections": dict(counts), "slot": run["settings"].get("slot_id"),
                            "guidance": None})
        sess.current = None
        self.check(run)  # a pause/cancel during the Bible Builder stops here (items are made again on resume)
        items = [sess.items[k] for k in sess.order]
        errs = [i.get("error") or {} for i in items if i["status"] == "error"]
        run_err = (sess.runs[-1].get("error") if sess.runs else None) or {}
        codes = {e.get("code") for e in errs} | ({run_err.get("code")} if run_err else set())
        good = [i["key"] for i in items if i["status"] == "done" and i.get("valid") is not False]
        # A main character is required when this pass makes characters; a pass that only makes again a refused
        # place or group needs at least one usable entry.
        need = (lambda k: sess.items[k]["op"] == "A01") if "A01" in counts else (lambda k: True)
        if not any(need(k) for k in good):
            if "TIMEOUT" in codes:
                raise StepProblem("TIMEOUT", "The AI did not answer in time while making the characters.", TIMEOUT_FIX)
            busy = codes & set(BUSY_CODES)
            if busy:
                raise StepProblem(sorted(busy)[0], "The AI stayed busy while making the characters.", BUSY_FIX)
            msg = (run_err.get("message") or (errs[0].get("message") if errs else None) or
                   "the AI's characters did not fit BookForge's forms")
            raise StepProblem(run_err.get("code") or (errs[0].get("code") if errs else None) or "INVALID_INPUT",
                              f"The characters could not be made: {msg}", "Press 🔁 Try again.")
        out = sess.create(good, {})
        for c in out["created"]:
            self._made(run, c["ref"])
        self.event(run, "ai", f"The AI drafted {len(out['created'])} character/place entries (Bible Builder)",
                   slot=sess.runs[-1].get("slot") if sess.runs else None)
        if out["errors"]:
            self.event(run, "note", f"{len(out['errors'])} entr(y/ies) could not be saved and were skipped",
                       code=out["errors"][0].get("code"))

    @staticmethod
    def _made(run, ref: dict):
        """Remember that this run's AI made exactly this revision (so only AI text is ever redone)."""
        run.setdefault("made", {})[ref["record_id"]] = ref["version"]

    def _ai_made(self, run, rec: dict) -> bool:
        """True when this exact revision was written by the AI (an AI create, or an AI fix the run asked for); False
        for the author's own text (a manual candidate or an edit). Only AI text is ever set aside and redone."""
        if run.get("made", {}).get(rec["record_id"]) == rec["version"]:
            return True  # this run's AI made exactly this revision (Bible Builder entries, AI drafts)
        try:
            kind = self.app.review.made_by(run["project_id"], run["branch_id"], rec,
                                           self.app.review.fixes(run["project_id"], run["branch_id"]))["kind"]
        except Exception:  # noqa: BLE001 - when in doubt, never throw the author's text away
            log.exception("make-a-book run %s: could not tell who wrote %s", run["id"], rec.get("record_id"))
            return False
        return kind in ("ai", "ai_fix")

    def _redo_refused(self, run, st, rid: str, key: str, label: str, exc: ChecksRefused):
        """Set an AI draft BookForge's checks refused aside so the AI writes it again (told what was wrong: the B11
        prompt lists the earlier outline's refusals); after MAX_FIXES attempts the run pauses for the author. The
        author's own version (an edit made while the run was paused) is never set aside: the run pauses for the
        author instead (CHECKS_REFUSED, Edit only), without asking the AI."""
        bp = self.bp(run)
        rec = bp.rec(rid)
        if rec is not None and not self._ai_made(run, rec):
            stale = exc.problem.get("fix") == STALE_FIX
            exc.problem.update(message=exc.problem["message"].replace("BookForge's checks refused the",
                                                                      "BookForge's checks refused your edited", 1),
                               fix=AUTHOR_STALE_FIX if stale else AUTHOR_CHECKS_FIX, options=["edit"],
                               authored_by="author")
            self.event(run, "problem", f"BookForge's checks refused your edited {label}; it is kept for you to fix "
                                       "(the AI was not asked to replace it)", record_id=rid, code="CHECKS_REFUSED")
            raise exc
        counts = run.setdefault("fix_counts", {})
        n = int(counts.get(key, 0))
        if n >= MAX_FIXES:
            exc.problem["message"] += f" The AI wrote it {n + 1} times."
            raise exc
        counts[key] = n + 1
        if rec is not None:
            bp.set_aside(rec, f"BookForge's checks refused it; the AI writes the {label} again")
        st["message"] = f"The AI is writing the {label} again (attempt {n + 2} of {MAX_FIXES + 1})"
        run["phase"] = st["message"]
        self.event(run, "fix", f"BookForge's checks refused the {label}; asked the AI to write it again "
                               f"({n + 1} of {MAX_FIXES}): " + "; ".join(exc.problem.get("details") or [])[:300],
                   record_id=rid)
        self.save(run)

    def _planning(self, run, st, op, label):
        while True:
            bp = self.bp(run)
            if bp.approved(op):
                st["message"] = "Approved"
                return
            drafts = sorted(bp.drafts(op), key=lambda r: r.get("created_at") or "", reverse=True)
            if drafts:
                rid = drafts[0]["record_id"]
            else:
                st["message"] = f"The AI is writing the {label}"
                self.save(run)
                ref = self.ai_create(run, bp, op, bp.payload_for(op), label)
                rid = ref["record_id"]
                self._made(run, ref)
                self.event(run, "ai", f"The AI wrote the {label}", record_id=rid, module_id=op)
            try:
                self._review_until_approved(run, st, rid, label)
            except ChecksRefused as exc:
                self._redo_refused(run, st, rid, f"redo:{op}", label, exc)
                continue
            st["message"] = "Written, reviewed and approved"
            return

    def _s_premise(self, run, st):
        self._planning(run, st, "B01", "premise")

    def _s_plot(self, run, st):
        self._planning(run, st, "B03", "main plot")

    def _s_outline(self, run, st):
        self._planning(run, st, "B11", "chapter outline")
        n = len(self.bp(run).outline_chapters(self.bp(run).outline()))
        st["message"] = f"{n} chapter(s) planned and approved"

    def _s_chapters(self, run, st):
        bp = self.bp(run)
        outline = bp.outline()
        if not outline:
            raise StepProblem("NOT_FOUND", "There is no approved chapter outline.", "Press 🔁 Try again.")
        chapters = bp.outline_chapters(outline)
        if not chapters:
            raise StepProblem("INVALID_INPUT", "The chapter outline has no chapters BookForge can write.",
                              "Press 🔁 Try again.")
        items = {i["id"]: i for i in st.get("items") or []}
        st["items"] = [items.get(c["chapter_id"]) or {"id": c["chapter_id"], "label": f"Chapter {c['chapter_id']}",
                                                       "state": "pending", "words": 0} for c in chapters]
        for idx, ch in enumerate(chapters):
            cid = ch["chapter_id"]
            item = st["items"][idx]
            bp = self.bp(run)
            _ctx, latest, appr = bp.chapter_prose(outline, cid)
            if appr:
                item.update(state="done", words=len(((appr.get("data") or {}).get("text") or "").split()))
                continue
            item["state"] = "running"
            st["message"] = f"Chapter {idx + 1} of {len(chapters)}"
            self.save(run)
            while True:
                bp = self.bp(run)
                _ctx, latest, _appr = bp.chapter_prose(outline, cid)
                if latest and latest["lifecycle"] in REVIEWABLE and not latest.get("stale"):
                    rid = latest["record_id"]
                else:
                    try:
                        self._scene_cards(run, st, cid, item)
                    except StepProblem:
                        item["state"] = "paused"
                        raise
                    st["message"] = f"Chapter {idx + 1} of {len(chapters)}"
                    run["phase"] = st["message"]
                    self.save(run)
                    payload = bp.prepare_chapter(cid)
                    ref = self.ai_create(run, self.bp(run), "C02", payload, f"chapter {cid}")
                    rid = ref["record_id"]
                    self._made(run, ref)
                    self.event(run, "ai", f"The AI wrote chapter {cid}", record_id=rid, module_id="C02")
                try:
                    rec = self._review_until_approved(run, st, rid, f"chapter {cid}", chapter_id=cid)
                    break
                except ChecksRefused as exc:
                    try:
                        self._redo_refused(run, st, rid, f"redo:C02:{cid}", f"chapter {cid}", exc)
                    except StepProblem:
                        item["state"] = "paused"
                        raise
                except StepProblem:
                    item["state"] = "paused"
                    raise
            item.update(state="done", words=len((((rec or {}).get("data") or {}).get("text") or "").split()))
            ed = (run.get("editor") or {}).get((rec or {}).get("record_id") or rid)
            if ed:
                item["editor"] = {"verdict": ed.get("verdict"), "rounds": ed.get("rounds", 0),
                                  "flagged": bool(ed.get("flagged")), "avg": ed.get("avg_score"),
                                  "min": ed.get("min_score"), "reviewer": ed.get("reviewer")}
            self.save(run)
        words = sum(i.get("words") or 0 for i in st["items"])
        st["message"] = f"{len(chapters)} chapter(s) written and approved · {words} words"

    def _approve_step_items(self, run, step_id, why):
        bp = self.bp(run)
        stp = {s["id"]: s for s in bp.status()["steps"]}[step_id]
        for i in stp.get("approve") or []:
            rec = bp.rec(i["record_id"])
            if rec and rec["lifecycle"] in REVIEWABLE:
                self._approve(run, rec["ref"], why=why)

    def _s_format(self, run, st):
        bp = self.bp(run)
        s = {x["id"]: x for x in bp.status()["steps"]}["format"]
        if s["state"] == "done":
            return
        if s["state"] != "needs_you":
            bp.a_setup_format({})
        self._approve_step_items(run, "format", "book format made by BookForge from the profile (deterministic)")
        st["message"] = "6 x 9 inch pages, Times 11 pt, PDF/EPUB/DOCX settings — approved"

    def _s_assemble(self, run, st):
        bp = self.bp(run)
        s = {x["id"]: x for x in bp.status()["steps"]}["assemble"]
        if s["state"] == "done":
            return
        b = self.app.backups.try_backup("before-assemble")
        if b:
            self.event(run, "backup", f"Backup before putting the book together ({b['name']})")
        if s["state"] != "needs_you":
            bp.a_assemble({})
        self._approve_step_items(run, "assemble", "assembly made by BookForge from the approved chapters "
                                                  "(deterministic)")
        st["message"] = "The book is put together and approved"

    def _s_export(self, run, st):
        bp = self.bp(run)
        s = {x["id"]: x for x in bp.status()["steps"]}["export"]
        if s["state"] != "done":
            b = self.app.backups.try_backup("before-export")
            if b:
                self.event(run, "backup", f"Backup before exporting ({b['name']})")
            out = self._export_under_consent(run, bp)
            if not out.get("ok") or out.get("problems"):
                raise StepProblem("INVALID_INPUT", out.get("message") or "Some files could not be made.",
                                  "Press 🔁 Try again.", details=(out.get("problems") or [])[:6])
            s = {x["id"]: x for x in self.bp(run).status()["steps"]}["export"]
        files = []
        for f in s.get("files") or []:
            rec = self.store.get_record(run["project_id"], run["branch_id"], f["record_id"], f["version"])
            data = self.store.read_binary(rec)
            ok, why = verify_file(f["format"], data)
            if not ok:
                raise StepProblem("HASH_MISMATCH", f"The {f['format']} file does not read back: {why}",
                                  "Press 🔁 Try again.")
            files.append(dict(f, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
            self.event(run, "export", f"{f['format']} file made and re-read ({len(data)} bytes)")
        run["files"] = files
        st["message"] = "Made and re-read: " + ", ".join(f["format"] for f in files)

    def _export_under_consent(self, run, bp):
        """BookPath.a_export, with the approval-manifest approval routed through the run's consent check."""
        orig = bp.approve_ref

        def approve_ref(ref):
            if ref.get("module_id") == "I01":
                return self._approve(run, ref, why="list of approved chapters for this export (deterministic)")
            return orig(ref)
        bp.approve_ref = approve_ref  # type: ignore[method-assign]
        try:
            return bp.a_export({})
        except StepProblem as exc:
            return {"ok": False, "message": exc.problem.get("message"), "problems": exc.problem.get("details") or []}

    def _s_check(self, run, st):
        out = self.bp(run).a_check({})
        if not out.get("ok"):
            raise StepProblem("INVALID_INPUT", out.get("message") or "The content check did not pass.",
                              "Open the book's Quality Checks to see what is missing, then press 🔁 Try again.",
                              details=(out.get("problems") or [])[:6])
        st["message"] = out.get("message") or "PASS"


def verify_file(fmt: str, data: bytes) -> tuple[bool, str]:
    """Re-read an exported file with BookForge's independent checkers (as the workflow test does)."""
    try:
        if fmt == "PDF":
            doc, issues = hc.pdf_structure(data)
            ok = doc is not None
        elif fmt == "EPUB":
            issues, _info = hc.epub_check(data, run_external=False)
            ok = True
        else:
            issues, _info = hc.docx_check(data)
            ok = True
    except Exception as exc:  # noqa: BLE001
        return False, type(exc).__name__
    bad = [i["message"] for i in issues if i.get("decision") == "FAIL" and i.get("severity") in ("BLOCKING", "MAJOR")]
    return (ok and not bad), "; ".join(bad)[:300]


# ====================================================================== ✍ Write all chapters (S2)
class WriteAllService(_Runner):
    """Writes every unwritten chapter one after another (C01 context + C02 prose). Drafts land in the review
    queue; nothing is approved here (only the author's existing opt-in auto-approve can approve, after an AI
    review the author asks for)."""

    KIND = "write_all"

    def start(self, principal: str, pid: str, branch: str) -> dict:
        for r in self.active():
            if r.get("project_id") == pid and r.get("branch_id") == branch:
                return self.public(r)
        bp = BookPath(self.app.engine, principal, pid, branch)
        outline = bp.outline()
        if not outline:
            raise BookforgeError("INVALID_INPUT", "/outline", "approve the chapter outline first", status="REJECTED")
        if (bp.profile.get("ai_slot") or "") == "manual" or not self._ai_configured():
            raise BookforgeError("CAPABILITY_UNAVAILABLE", "", "no AI is connected (or the book profile says you "
                                 "write it yourself)", status="REJECTED")
        items = []
        for ch in bp.outline_chapters(outline):
            _ctx, latest, appr = bp.chapter_prose(outline, ch["chapter_id"])
            state = "done" if appr or (latest and latest["lifecycle"] in REVIEWABLE and not latest.get("stale")) \
                else "pending"
            items.append({"id": ch["chapter_id"], "label": f"Chapter {ch['chapter_id']}", "state": state,
                          "note": "already written" if state == "done" else ""})
        at = now_iso()
        job = {"id": f"wall-{uuid.uuid4().hex[:12]}", "kind": self.KIND, "status": "running", "principal": principal,
               "project_id": pid, "branch_id": branch, "created_at": at, "started_at": at, "finished_at": None,
               "items": items, "phase": "Starting", "problem": None, "waiting": None, "events": [], "settings": {}}
        self.save(job)
        self._launch(job, self._run)
        return self.public(job)

    def public(self, job):
        out = dict(job)
        out["alive"] = self.alive(job["id"])
        out["done"] = sum(1 for i in job["items"] if i["state"] == "done")
        out["total"] = len(job["items"])
        out["elapsed_ms"] = _elapsed(job.get("started_at"), job.get("finished_at"))
        out["events"] = (job.get("events") or [])[-30:]
        return out

    def latest(self, principal, pid, branch):
        for j in self.jobs.list(kind=self.KIND, project_id=pid, limit=10):
            if j.get("branch_id") == branch and j.get("principal") in (None, principal):
                return self.public(self._cache.get(j["id"], j))
        return None

    def cancel(self, principal, job_id):
        job = self.owned(principal, job_id)
        if self.alive(job_id):
            self._ctl[job_id]["cancel"] = True
            job["phase"] = "Stopping after the current chapter…"
        elif job["status"] not in ("done", "cancelled"):
            job.update(status="cancelled", finished_at=now_iso(), phase="Stopped")
        self.save(job)
        return self.public(job)

    def resume(self, principal, job_id):
        job = self.owned(principal, job_id)
        if job["status"] in ("done",) or self.alive(job_id):
            return self.public(job)
        for i in job["items"]:
            if i["state"] in ("running", "failed", "paused"):
                i["state"] = "pending"
        job.update(status="running", problem=None, finished_at=None, phase="Continuing")
        self.save(job)
        self._launch(job, self._run)
        return self.public(job)

    def _plan_scenes(self, job, bp, item):
        """P8 outside runs: a chapter without scene cards gets them from the writer AI first (a draft the author can
        check, change and approve on the chapter's scene page). A failure is noted and the chapter is written from
        the outline; TIMEOUT / a busy AI stop like a chapter would."""
        outline = bp.outline()
        if not outline:
            return
        entry = scenes_mod.get_entry(self.store, job["project_id"], job["branch_id"], outline["record_id"], item["id"])
        if scenes_mod.usable(entry, outline):
            return
        from .review import ReviewJob  # noqa: PLC0415
        rj = ReviewJob("scenes", job["principal"], job["project_id"], job["branch_id"], [item["id"]], None)
        rj.started, rj.status, rj.retry_busy = time.time(), "running", True
        rj.check = lambda: self.check(job)  # type: ignore[method-assign]
        rj.on_wait = lambda info: self.on_wait(job, info)
        job["phase"] = f"Planning the scenes of {item['label'].lower()}"
        self.save(job)
        try:
            e = self.app.review.scenes.make(rj, item["id"])
            item["scenes"] = scenes_mod.summary(e, outline)
            self.event(job, "scenes", f"The AI planned {len(e['cards'])} scene(s) for {item['label'].lower()} "
                       "(not checked yet)", slot=rj.slot)
        except BookforgeError as exc:
            if exc.code == "TIMEOUT" or exc.code in BUSY_CODES:
                raise StepProblem(exc.code, f"The AI did not answer while planning the scenes of "
                                  f"{item['label'].lower()}.", TIMEOUT_FIX if exc.code == "TIMEOUT" else BUSY_FIX,
                                  chapter_id=item["id"]) from None
            self.event(job, "note", f"⚠️ The scenes of {item['label'].lower()} could not be planned ({exc.code}); it "
                       "is written from the outline", code="SCENES_FAILED")
        self.save(job)

    def _run(self, job_id):
        job = self.get(job_id)
        health = self.app.engine.providers.health
        health.set_listener(lambda info: self.on_failover(job, info))
        try:
            self.probe_ais(job)
            for item in job["items"]:
                if item["state"] == "done":
                    continue
                self.check(job)
                item["state"] = "running"
                job["phase"] = f"Writing {item['label'].lower()}"
                self.save(job)
                bp = BookPath(self.app.engine, job["principal"], job["project_id"], job["branch_id"])
                try:
                    # The same per-chapter lock as the book page's "write this chapter": decide and write as one
                    # step, and look again now (the author may have written or approved it since Write-all started).
                    with _step_lock(f"{bp.key}:C02:{item['id']}"):
                        outline = bp.outline()
                        _ctx, latest, appr = bp.chapter_prose(outline, item["id"]) if outline else (None, None, None)
                        if appr or (latest and latest["lifecycle"] in REVIEWABLE and not latest.get("stale")):
                            item.update(state="done", note="already approved" if appr else
                                        "already written — waits for your approval")
                            self.event(job, "skip", f"{item['label']} was already written; not written again")
                            self.save(job)
                            continue
                        self._plan_scenes(job, bp, item)
                        payload = bp.prepare_chapter(item["id"])
                        ref = self.ai_create(job, bp, "C02", payload, f"chapter {item['id']}")
                except StepError as exc:
                    if "already approved" in exc.message:
                        item.update(state="done", note="already approved")
                        continue
                    raise StepProblem(exc.code or "INVALID_INPUT", exc.message, "Press 🔁 Try again.",
                                      chapter_id=item["id"])
                except StepProblem as exc:
                    exc.problem.setdefault("chapter_id", item["id"])
                    raise
                rec = bp.rec(ref["record_id"])
                item.update(state="done", record_id=ref["record_id"],
                            words=len(((rec or {}).get("data") or {}).get("text", "").split()), note="draft — waits "
                            "for your approval")
                self.event(job, "ai", f"The AI wrote {item['label'].lower()}", record_id=ref["record_id"])
                self.save(job)
            job.update(status="done", finished_at=now_iso(), phase="All chapters are written — read and approve "
                       "them in Needs your approval", waiting=None)
        except (RunCancelled, RunPaused, Cancelled):
            for i in job["items"]:
                if i["state"] == "running":
                    i["state"] = "pending"
            job.update(status="cancelled", finished_at=now_iso(), phase="Stopped — the chapters written so far are "
                       "kept as drafts", waiting=None)
        except StepProblem as exc:
            for i in job["items"]:
                if i["state"] == "running":
                    i.update(state="failed", note=exc.problem.get("message"))
            job.update(status="error", problem=dict(exc.problem, where={"step": "Write all chapters", "set": "C",
                                                                        "op": "C02",
                                                                        "chapter": exc.problem.get("chapter_id")}),
                       phase="⚠️ " + exc.problem["message"], waiting=None)
        except Exception as exc:  # noqa: BLE001
            log.exception("write-all %s failed", job_id)
            job.update(status="error", problem={"code": "INTERNAL_ERROR", "message": f"Unexpected problem "
                                                f"({type(exc).__name__})", "fix": "Press 🔁 Try again."},
                       phase="⚠️ Unexpected problem", waiting=None)
        finally:
            health.set_listener(None)
        self.save(job)


def public_json(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)
