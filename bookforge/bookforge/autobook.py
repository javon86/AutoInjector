"""⚡ "Make a book for me" (R14) with pause/resume/cancel (S21), and "✍ Write all chapters" (S2).

A Make-a-book run creates a NEW book (it never touches an existing project) and walks the whole guided book path
with the AI, in a background thread whose state is persisted (``JobStore``, kind ``autobook``) after every change,
so a page reload shows it and a BookForge restart shows it as "interrupted — Resume":

    safety backup -> book profile (the AI invents title, genre, audience, tone, idea, pen name)
    -> characters and places (A01/A04/A03 through the Bible Builder: world sketch + proposals, created as drafts)
    -> premise B01 -> main plot B03 -> chapter outline B11 -> every chapter (C01 context + C02 prose)
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

from . import h_checks as hc
from .assist import AssistService, BibleSession, Cancelled, Job, book_profile_brief
from .book_path import EXPORT_FOR, LENGTHS, BookPath, StepError, save_profile
from .engine import Engine
from .errors import BookforgeError
from .jobs import BUSY_CODES, JobStore, RetryPolicy, busy_code, now_iso, slot_word, wait_and_retry
from .providers import ProviderRegistry
from .review import REVIEWABLE, ReviewJob, ReviewService, plain_problem, safe_title

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


class RunPaused(Exception):
    pass


class RunCancelled(Exception):
    pass


class StepProblem(Exception):
    """Pause the run on this step with a ⚠️ for the author (problem dict as shown in the UI)."""

    def __init__(self, code: str, message: str, fix: str | None = None, **extra):
        super().__init__(message)
        self.problem = dict({"code": code, "message": message, "fix": fix}, **extra)


class PinnedProviders(ProviderRegistry):
    """The author's AI slots, optionally limited to one slot the author picked for this run. Shares the base
    registry's busy counters, so concurrency limits stay correct."""

    def __init__(self, base: ProviderRegistry, slot_id: str | None):
        self._base = base
        super().__init__(base.store, base.secret_path)
        self._active = base._active
        self._lock = base._lock
        self.pinned = slot_id

    @property
    def test_adapter(self):
        return getattr(self._base, "test_adapter", None)

    @test_adapter.setter
    def test_adapter(self, value):  # the base registry owns it
        pass

    def eligible(self, project_id, capability, needed_tokens, operation=None):
        out = super().eligible(project_id, capability, needed_tokens, operation if not self.pinned else None)
        return [s for s in out if s["slot_id"] == self.pinned] if self.pinned else out


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
            if code is None and any(e.get("code") == "CAPABILITY_UNAVAILABLE" for e in errs) and self._slots_busy():
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

    def _slots_busy(self) -> bool:
        slots = [s for s in self.app.engine.providers.slots() if s["adapter_id"] in ("anthropic", "autoinjector")
                 or (s["adapter_id"] == "manual" and self.app.engine.providers.test_adapter is not None)]
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
        self.save(run)


# ====================================================================== Make a book for me
class AutoBookService(_Runner):
    KIND = "autobook"

    def __init__(self, app):
        super().__init__(app)

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
        live = [r for r in self.active()]
        if live:
            raise BookforgeError("VERSION_CONFLICT", "/run", "a Make-a-book run is already working; pause or cancel "
                                 "it first (or wait for it to finish)", status="REJECTED")
        if not self._ai_configured():
            raise BookforgeError("CAPABILITY_UNAVAILABLE", "/slot_id", "no AI is connected — Make a book for me needs "
                                 "an AI", status="REJECTED")
        run_id = f"run-{uuid.uuid4().hex[:12]}"
        at = now_iso()
        run = {"id": run_id, "kind": self.KIND, "status": "queued", "phase": "Starting", "principal": principal,
               "project_id": None, "branch_id": "main", "created_at": at, "started_at": at, "finished_at": None,
               "settings": settings, "current": None, "waiting": None, "problem": None, "decision": None,
               "pause_reason": None, "files": [], "title": None, "fix_counts": {}, "events": [],
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
        if self.alive(run_id):
            if self._ctl.get(run_id, {}).get("pause"):
                self._ctl[run_id]["pause"] = False
                run["status"], run["phase"] = "running", "Continuing"
                self.save(run)
            return self.public(run)
        if any(self.alive(r["id"]) for r in self.active()):
            raise BookforgeError("VERSION_CONFLICT", "/run", "another Make-a-book run is working", status="REJECTED")
        run["status"], run["phase"], run["problem"], run["pause_reason"] = "running", "Continuing where it stopped", \
            None, None
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
            run.setdefault("fix_counts", {})[rid] = 0
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

    def _run(self, run_id: str):
        run = self.get(run_id)
        self._engine, self._assist, self._review = self._services(run)
        self._thread_run = run_id
        run["status"] = "running"
        self.save(run)
        try:
            for sid in STEP_IDS:
                st = self._step(run, sid)
                if st["state"] in ("done", "skipped"):
                    continue
                self.check(run)
                run["current"] = sid
                st.update(state="running", started_at=st.get("started_at") or now_iso(), finished_at=None,
                          problem=None, message="Working…")
                run["phase"] = f"{st['title']}…"
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
            self._thread_run = None

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
        st.update(state="failed" if problem.get("code") not in ("TIMEOUT", "REVIEW_NOT_PASSED") else "paused",
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
    def _approve(self, run, ref, *, why: str, verdict: str | None = None, slot: str | None = None) -> dict:
        """Approve exactly this revision under the author's consent for THIS run (never outside one)."""
        if (getattr(self, "_thread_run", None) != run["id"] or threading.current_thread() is not
                self._threads.get(run["id"]) or not run.get("consent") or run.get("status") not in ("running", "waiting")
                or ref.get("project_id") != run.get("project_id")):
            raise BookforgeError("PERMISSION_DENIED", "/consent", "approvals under the Make-a-book consent happen only "
                                 "inside the run the author started, for that run's own book", status="REJECTED")
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
            raise StepProblem("APPROVAL_REQUIRED", "BookForge's checks refused the approval: "
                              + plain_problem(res.get("problems")), "Open the draft to see the checks, fix it (✏️ Edit) "
                              "and press 🔁 Try again.", record_id=ref["record_id"], module_id=ref["module_id"],
                              details=(res.get("problems") or [])[:6])
        self.event(run, "approve", f"{safe_title(self.app.engine.contracts, bp.rec(ref['record_id']))}: {label}",
                   approval="run_consent", record_id=ref["record_id"], module_id=ref["module_id"], verdict=verdict)
        return res

    def _review_until_approved(self, run, st, rid: str, label: str, chapter_id: str | None = None):
        """AI review -> approve under consent, or fix (max 2) -> review again; else pause for the author."""
        bp = self.bp(run)
        counts = run.setdefault("fix_counts", {})
        while True:
            self.check(run)
            head = bp.rec(rid)
            if head is None:
                raise StepProblem("NOT_FOUND", f"The draft of the {label} disappeared.", "Press 🔁 Try again.")
            if head["lifecycle"] in ("APPROVED", "LOCKED") or head.get("approved_version") == head["version"]:
                return head
            st["message"] = f"AI is reviewing the {label}"
            run["phase"] = st["message"]
            self.save(run)
            job = self._job(run, "review", head["module_id"])
            rj = ReviewJob("review", run["principal"], run["project_id"], run["branch_id"], [rid],
                           run["settings"].get("slot_id"))
            for k in ("started", "status", "retry_busy", "check", "on_wait"):
                setattr(rj, k, getattr(job, k))
            try:
                res = self._review.review_one(rj, rid)
            except BookforgeError as exc:
                self._ai_problem(exc, f"reviewing the {label}", record_id=rid, chapter_id=chapter_id)
            verdict = res["review"]["verdict"]
            self.event(run, "review", f"AI review of the {label}: {verdict}", verdict=verdict, slot=rj.slot,
                       record_id=rid)
            if res.get("auto_approved"):
                self.event(run, "approve", f"{label}: approved by your standing auto-approve setting",
                           approval="standing_auto_approve", record_id=rid)
                return bp.rec(rid)
            head = bp.rec(rid)
            if verdict == "APPROVE":
                self._approve(run, head["ref"], why=f"AI review: APPROVE ({label})", verdict="APPROVE", slot=rj.slot)
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
            name = "New book (being made…)"
            pid = self._engine.bootstrap_project(run["principal"], name, settings={"made_by_run": run["id"]},
                                                 features={"character_arcs": False}, release_profiles=list(RELEASE))
            run["project_id"] = pid
            save_profile(self.store, pid, {"length": s["length"], "chapters": CHAPTERS_FOR[s["length"]],
                                           "ai_slot": s.get("slot_id") or "", "genre": s.get("genre") or ""})
            self.event(run, "project", "A new, separate book was created (your other books are not touched)")
            self.save(run)
        pid = run["project_id"]
        prof = book_profile_brief(self.store, pid)
        if prof.get("title") and prof.get("idea"):
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
        save_profile(self.store, pid, prof)
        with self.store.transaction() as tx:
            tx.execute("UPDATE projects SET name=? WHERE project_id=?", (prof["title"], pid))
        run["title"] = prof["title"]
        st["message"] = f"“{prof['title']}” by {prof['author']} ({prof['genre'] or 'any genre'})"
        self.event(run, "ai", f"The AI invented the book “{prof['title']}”", slot=job.slot)

    def _s_canon(self, run, st):
        bp = self.bp(run)
        canon_ops = ("A01", "A04", "A03")
        have = [r for op in canon_ops for r in bp.heads(op)]
        if not have:
            counts = CANON_COUNTS[run["settings"]["length"]]
            self._bible(run, st, counts)
            bp = self.bp(run)
            have = [r for op in canon_ops for r in bp.heads(op)]
        if not any(r["module_id"] == "A01" for r in have):
            raise StepProblem("INVALID_INPUT", "The AI did not make a main character that BookForge could save.",
                              "Press 🔁 Try again (the AI makes new characters).")
        todo = [r for r in have if r["lifecycle"] in REVIEWABLE and r.get("approved_version") != r["version"]
                and not r.get("stale")]
        todo.sort(key=lambda r: (["A03", "A04", "A01"].index(r["module_id"]), r.get("created_at") or ""))
        for i, r in enumerate(todo):
            name = safe_title(self.app.engine.contracts, r)
            st["items"] = [{"id": x["record_id"], "label": safe_title(self.app.engine.contracts, x),
                            "state": "done" if j < i else "running" if j == i else "pending"}
                           for j, x in enumerate(todo)]
            self._review_until_approved(run, st, r["record_id"], f"entry “{name}”")
        n = len(self.bp(run).approved("A01"))
        st["items"] = [dict(x, state="done") for x in st.get("items") or []]
        st["message"] = f"{n} character(s) and {len(self.bp(run).approved('A04'))} place(s) approved"

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
        if not any(sess.items[k]["op"] == "A01" for k in good):
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
        self.event(run, "ai", f"The AI drafted {len(out['created'])} character/place entries (Bible Builder)",
                   slot=sess.runs[-1].get("slot") if sess.runs else None)
        if out["errors"]:
            self.event(run, "note", f"{len(out['errors'])} entr(y/ies) could not be saved and were skipped",
                       code=out["errors"][0].get("code"))

    def _planning(self, run, st, op, label):
        bp = self.bp(run)
        if bp.approved(op):
            st["message"] = "Approved"
            return
        drafts = sorted(bp.drafts(op), key=lambda r: r.get("created_at") or "", reverse=True)
        drafts = [d for d in drafts if not d.get("stale")]
        if drafts:
            rid = drafts[0]["record_id"]
        else:
            st["message"] = f"The AI is writing the {label}"
            self.save(run)
            ref = self.ai_create(run, bp, op, bp.payload_for(op), label)
            rid = ref["record_id"]
            self.event(run, "ai", f"The AI wrote the {label}", record_id=rid, module_id=op)
        self._review_until_approved(run, st, rid, label)
        st["message"] = "Written, reviewed and approved"

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
            if latest and latest["lifecycle"] in REVIEWABLE and not latest.get("stale"):
                rid = latest["record_id"]
            else:
                payload = bp.prepare_chapter(cid)
                ref = self.ai_create(run, self.bp(run), "C02", payload, f"chapter {cid}")
                rid = ref["record_id"]
                self.event(run, "ai", f"The AI wrote chapter {cid}", record_id=rid, module_id="C02")
            try:
                rec = self._review_until_approved(run, st, rid, f"chapter {cid}", chapter_id=cid)
            except StepProblem:
                item["state"] = "paused"
                raise
            item.update(state="done", words=len((((rec or {}).get("data") or {}).get("text") or "").split()))
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

    def _run(self, job_id):
        job = self.get(job_id)
        try:
            for item in job["items"]:
                if item["state"] == "done":
                    continue
                self.check(job)
                item["state"] = "running"
                job["phase"] = f"Writing {item['label'].lower()}"
                self.save(job)
                bp = BookPath(self.app.engine, job["principal"], job["project_id"], job["branch_id"])
                try:
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
        self.save(job)


def public_json(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)
