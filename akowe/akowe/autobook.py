"""⚡ "Make a book for me" (R14) with pause/resume/cancel (S21), and "✍ Write all chapters" (S2).

A Make-a-book run creates a NEW book (it never touches an existing project) and walks the whole guided book path
with the AI, in a background thread whose state is persisted (``JobStore``, kind ``autobook``) after every change,
so a page reload shows it and an Akọwe restart shows it as "interrupted — Resume":

    safety backup -> book profile (the AI invents title, genre, audience, tone, idea; never the pen name: pen_name.py)
    -> characters and places (A01/A04/A03 through the Bible Builder: world sketch + proposals, created as drafts)
    -> character sheets and voice cards (P7/P17: made with the characters, or made now for any without)
    -> character looks and voice details (story_details.py: essentials only; the rest is decided just in time,
    before the chapter that needs it, and locked once a chapter used it)
    -> story rules and world texture (P9/P10: drafted from the canon and the profile)
    -> premise B01 -> main plot B03 -> chapter outline B11 (then the story rules are updated for the plan: the AI's
    suggestions are accepted under the run consent) -> every chapter (scene cards planned by the writer and
    checked by an independent AI (P8), then C01 context + C02 prose; after the editor, the planned-to-page check
    (P11) with at most one targeted fix) -> planned details on the page (whole book, a report)
    -> book format (I01 profiles) -> backup + assembly (G02/G01/G05/G04/G07) -> backup + exports (G11 PDF,
    G12 EPUB, G13 DOCX - all three release profiles are switched on for this book) -> content check H05.

Every step is a normal ``engine.dispatch`` through ``BookPath`` (no shortcut around the kernel's checks).

Consent and approvals: pressing the button is the author's consent for THIS run only. The consent (who, when,
run id, which new book) is stored with the run. Each creative draft is sent to the AI reviewer (review.py):
APPROVE -> approved under the run consent (outbox ``autobook.approved_under_consent``, label "Approved under your
Make-a-book-for-me consent, run <id>"); REVISE/REJECT -> "Ask AI to fix it" (a new DRAFT revision through the
normal UPDATE), at most twice, then reviewed again; still not passing -> the run pauses with a ⚠️ on that step
and the author decides (approve anyway / edit it / try again). Deterministic Akọwe outputs (book format,
assembly records, the export approval manifest) are approved under the same consent without an AI opinion.
``_approve`` refuses anything that is not inside the live thread of a run the author started, for that run's
own book - nothing is ever approved outside a run.

AI availability: busy/unreachable answers wait and retry (jobs.wait_and_retry, shown as "waiting for Claude
(busy) - retrying in 30 s"); a TIMEOUT is never retried automatically - inside a run it pauses that step with a
⚠️ (the author presses "Try again"), it never fails the whole run.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import re
import threading
import time
import uuid
from datetime import datetime, timezone

from . import ai_activity, ai_check
from . import approval_trust
from . import assist as assist_mod
from . import characters as chars_mod
from . import checker_record
from . import costs as costs_mod
from . import check_now as check_now_mod
from . import cross_check
from . import h_checks as hc
from . import lengths as lengths_mod
from . import pipeline as pipeline_mod
from . import planned as planned_mod
from . import alerts as alerts_mod
from . import protagonist
from . import review_loop
from . import run_clock
from . import scenes as scenes_mod
from . import story_choices
from . import story_roles
from . import story_rules
from . import texture as texture_mod
from . import providers as providers_mod
from . import usage_limits
from .assist import AssistService, BibleSession, Cancelled, Job, book_profile_brief
from .book_path import EXPORT_FOR, LENGTHS, BookPath, StepError, _step_lock, get_profile, problems, save_profile
from .requests import candidate_payload
from .engine import Engine
from .errors import AkoweError
from .jobs import BUSY_CODES, JobStore, RetryPolicy, busy_code, now_iso, slot_word, wait_and_retry
from .providers import PROBE_POLL_S, PROBE_WAIT_S, PinnedProviders  # noqa: F401 - re-exported (older imports)
from .editor import judge_rewrite, keep_quotes_of, lost_keeps
from .editor_rubric import LABELS as EDITOR_LABELS
from .book_report import clip_words
from .review import NOT_INDEPENDENT, REVIEWABLE, ReviewJob, ReviewService, plain_problem, safe_title

log = logging.getLogger("akowe.autobook")

MAX_FIXES = 2
MAX_EVENTS = 400
RELEASE = ["MANUSCRIPT_PDF", "EPUB_REFLOWABLE", "EDITABLE_DOCX"]
CANON_COUNTS = {"short_story": {"A01": 2, "A04": 1}, "novelette": {"A01": 3, "A04": 2},
                "novella": {"A01": 3, "A04": 2, "A03": 1}, "novel": {"A01": 4, "A04": 3, "A03": 1}}
CHAPTERS_FOR = {k: v["default_chapters"] for k, v in lengths_mod.PRESETS.items()}  # P15 length presets
SET_NAMES = {"A": "Universe & Characters", "B": "Story Planning", "C": "Writing", "G": "Assemble & Export",
             "H": "Quality Checks", "I": "Storage & Context"}

STEPS = [
    ("backup", None, None, "Safety backup", "A backup of all your books, before anything starts."),
    ("profile", None, None, "Invent the book", "The AI invents the title, genre, readers, tone and the idea."),
    ("canon", "A", "A01", "Characters and places", "The AI drafts the main characters and places (Character & place maker); "
     "each one is reviewed and approved under your consent."),
    ("characters", "A", "A01", "Character sheets and voices", "What each character wants, needs, fears and hides, "
     "and how each one talks (a voice card each); the writer gets them in every chapter."),
    ("looks", "A", "A01", "Character looks and voice details", "Only the essentials before chapter one: how each "
     "character looks (height, build, face, eyes, hair, clothes, posture) and how they talk when afraid, angry or "
     "grieving; a short look for the places and items the outline names. Everything else (fighting style, powers, "
     "skills, a place's rooms, an item's powers…) is decided just in time, before the chapter that needs it, and "
     "fixed once a chapter used it."),
    ("pictures", "A", None, "Character pictures", "A portrait of every character from its description, and the "
     "full set (portrait, front, side and back views, character sheet) for the main character — made with Stable "
     "Diffusion in AutoInjector; each portrait becomes that character's 🔒 lock so later pictures keep the face. "
     "(Never holds up the book: what cannot be made now waits on the Book Bible's to-make list.)"),
    ("world", "A", "A03", "Story rules and world texture", "What is law in this world, what is only seen, believed "
     "or must stay a mystery — and concrete details of work, weather, institutions and people that can get in the "
     "way."),
    ("premise", "B", "B01", "Premise", "What the book is about in one or two sentences."),
    ("plot", "B", "B03", "Main plot", "The main storyline built from the premise and the characters."),
    ("outline", "B", "B11", "Chapter outline", "The chapter-by-chapter plan."),
    # 📖 optional (run setting fill_bible, off by default = the just-in-time way): whole_bible.py
    ("bible", "A", None, "Fill the whole Book Bible", "Every empty section of every Book Bible page — characters, "
     "places, items, magic, groups, the world and the story plan — filled from the plan before chapter one, in a few "
     "batched AI calls and approved under your consent. Never replaces your own text. (Optional; never holds up the "
     "book.)"),
    ("chapters", "C", "C02", "Write every chapter", "Context (C01) and prose (C02) for each chapter, reviewed and "
     "approved one by one."),
    ("planned", "C", "C02", "Planned details on the page", "Every chapter is checked: did the outline beats, the "
     "scene goals and obstacles and the planned character details reach the page? (Never holds up the book.)"),
    ("format", "I", "I01", "Book format", "Page size, font and PDF/EPUB/DOCX settings."),
    ("assemble", "G", "G01", "Put the book together", "Order, manuscript, typography, pages and contents."),
    ("export", "G", "G11", "Export PDF, EPUB and Word", "Makes the three files and re-reads each one."),
    ("check", "H", "H05", "Content check", "Every chapter is in the book once and in order."),
    ("report", "H", None, "Book report", "Scores, strengths and weaknesses with quotes, the editor's and the "
     "planned-to-page findings, word counts and which AI did what — the whole book is read by the AIs that did not "
     "write it. (Never holds up the book.)"),
    # P23 (Section 7c): optional, only when the run asks for it (run setting beta_reader)
    ("beta", "H", None, "Beta reader", "An AI reads the whole book as its target reader and marks where it got "
     "confused, bored or guessed a twist, each with a quote checked against the book. (Optional; never holds up the "
     "book.)"),
    # ✍ opening_pass.py: on by default (run setting opening_pass): chapter 1 once more, with the whole book known
    ("opening", "H", None, "Rewrite chapter 1 last", "Chapter 1 was written before the rest of the book existed: now "
     "the writer reworks it once with the whole book in view (a short summary, the ending, the setups it must plant, "
     "where the twist must stay hidden and the readers' and reviewers' notes on it). The same reviewers re-read the "
     "book; the new chapter 1 is kept only if the score is at least as good (a tie: only if their notes on chapter 1 "
     "went down). Never a chapter you wrote. (On by default; never holds up the book.)"),
    # 🔁 improve_pass.py: on by default (run setting improve_pass), at most improve_rounds rounds
    ("improve", "H", None, "Improve until better", "The reviewers' “What to try next”, the beta readers' top fixes, "
     "the editor's major notes (also those of chapters you approved anyway) and Akọwe's own checks (clock and tide "
     "times, repeated phrases, plain-word tics, too-simple sentences) go to the 🎯 3 weakest scenes (or, the older way, "
     "the chapters that need them most); the same "
     "reviewers re-read the book, and the rewrite is kept only if the score went up and nothing dropped. (On by "
     "default; never holds up the book.)"),
    # 🔁 final_reads.py: once at the end, only where the book changed (run settings reread_after_rewrites, beta_reread)
    ("reread", "H", None, "Read the final book again", "After Akọwe's own rewrites at the end (chapter 1 rewritten "
     "last, the improve pass), the final whole-book check reads the chapters again, and the beta readers read the "
     "final book once more — only when something changed since they read it. The run window also says the book's "
     "length against its target. (On by default; never holds up the book.)"),
]
# ⚡ #116: what the AI activity strip says while a step works (present tense, plain words); else the step's title
STEP_DOING = {
    "profile": "Inventing the book", "canon": "Making the characters and places",
    "characters": "Writing character sheets and voices", "looks": "Deciding how the characters look",
    "pictures": "Making character pictures", "world": "Writing the story rules and world",
    "premise": "Writing the premise", "plot": "Writing the main plot", "outline": "Writing the chapter outline",
    "bible": "Filling the whole Book Bible", "chapters": "Writing the chapters",
    "planned": "Checking the planned details are on the page", "format": "Setting the book format",
    "assemble": "Putting the book together", "export": "Making the PDF, EPUB and Word files",
    "check": "Checking the book's content", "report": "Writing the book report",
    "beta": "Beta readers reading the book", "opening": "Rewriting chapter 1 with the whole book in view",
    "improve": "Improving the book until it scores better", "reread": "Reading the final book again",
}


def the(what: str) -> str:
    """'chapter 7' / 'the premise' / 'the chapter outline' for the activity strip's plain words."""
    w = str(what or "")
    if re.match(r"^chapter \S+$", w) and w != "chapter outline":
        return w
    return f"the {w}"


STEP_IDS = [s[0] for s in STEPS]
# P14: steps that belong to a pipeline switch (switched off -> the step is skipped)
STEP_FLAGS = {"characters": "voices", "looks": "voices", "world": "rules", "planned": "planned"}
# P23 (Section 7c): steps that run only when the run's settings ask for them (step -> setting)
STEP_OPTIONAL = {"beta": "beta_reader", "bible": "fill_bible", "opening": "opening_pass", "improve": "improve_pass"}

PROFILE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    # ✒️ no pen name: the author's pen name is only ever what they typed (pen_name.py). "author" stays an allowed
    # (ignored) property so an AI that still sends one is not refused for it.
    "required": ["title", "genre", "audience", "tone", "idea"],
    "properties": {"title": {"type": "string"}, "author": {"type": "string"}, "genre": {"type": "string"},
                   "audience": {"type": "string"}, "tone": {"type": "string"}, "idea": {"type": "string"},
                   # H10: optional — when the AI leaves them out, Akọwe chooses from the genre (book_promises.decide)
                   "point_of_view": {"type": "string", "enum": ["first", "third"]},
                   "tense": {"type": "string", "enum": ["past", "present"]}},
}
PROFILE_TASK = (
    "Task: invent an ORIGINAL book for the author to make with Akọwe. Use the author's wishes in "
    "context.wishes when given (genre, length, an idea) and choose everything else yourself. Return: title (a short, "
    "evocative working title), genre, audience (who it is for, e.g. Adult, Young adult "
    "(12-18), Middle grade (8-12)), tone (a few words), idea (one paragraph of 3-5 sentences: who the main character "
    "is, where it happens, what goes wrong and what is at stake), point_of_view (first or third person) and tense "
    "(past or present) that suit the genre. No real people, no existing franchises. Do not choose an author name or "
    "pen name (the author's own name goes there). Return only the JSON object.")

TIMEOUT_FIX = ("The AI did not answer in time. Akọwe already waited for a late answer and asked another AI (or the "
               "same one again), so it stopped here instead of guessing. What to do: open AutoInjector and look at "
               "that AI's window — if it says the chat is too long, press the site's New chat; if it asks you to log "
               "in or to confirm you are human, do that. Then press 🔁 Try again.")
BUSY_FIX = ("The AIs stayed busy or could not be reached for a long time. What to do: make sure AutoInjector (the "
            "program with the AI windows) is open; look at each AI's window (logged in? a usage-limit message?); "
            "Settings → 🧪 Test connection shows which AI works. Then press 🔁 Try again.")
DECLINED_FIX = ("The AI declined to answer (it said it can't help with that) — story material such as a death or a "
                "crime sometimes trips an AI's safety filter by mistake. Akọwe already asked again and tried the other "
                "AIs. What to do: press 🔁 Try again, or pick another AI for the book in the run's settings.")
CHECKS_FIX = ("Press 🔁 Try again: the AI writes it again and is told exactly what Akọwe refused. Or ✏️ Edit it "
              "yourself so the checks pass, then press Continue.")
STALE_FIX = ("It was made from a plan or other inputs that changed since, so it is out of date: editing it cannot fix "
             "that. Press 🔁 Try again: the AI writes it again from the current, approved inputs.")
AUTHOR_CHECKS_FIX = ("This is your own edited version, so Akọwe keeps it and does not ask the AI to replace it. "
                     "✏️ Edit it so the checks pass (see what was refused below), then press Continue.")
AUTHOR_STALE_FIX = ("Your edited version was made from a plan or other inputs that changed since, so it is out of date "
                    "and editing it cannot fix that. Akọwe keeps it (the AI does not replace your text). Open the "
                    "book, approve the current version of what it was made from, and make this step again there.")
BOOK_GONE_FIX = ("This run cannot continue. Start a new ⚡ Make a book for me, or restore a backup that still has "
                 "this book.")
NEW_BOOK_NAME = "New book (being made…)"


# PR #122: when only ONE AI works, nobody independent can check its drafts (H6). What the run does then (run setting
# ``single_ai``):
# * "continue" (default) — keep writing; that AI's APPROVE approves its own draft, and the chapter is listed as
#   "needs your check later" (book home, book report, the run's journal). Nothing is published without you, and a
#   night-long run is not lost to one AI being logged out or at its usage limit.
# * "wait" — wait (up to the usage-limit waiting time, default 6 h) for a second AI, then let it review; if none comes,
#   the run pauses for you.
# * "ask" — pause at once and ask you (the old behaviour).
SINGLE_AI = ("continue", "wait", "ask")


def single_ai_mode(run: dict) -> str:
    v = (run.get("settings") or {}).get("single_ai")
    return v if v in SINGLE_AI else "continue"


class RunPaused(Exception):
    control = True  # a pause/cancel of the run: never swallowed as "this reviewer failed"


class RunCancelled(Exception):
    control = True


class StepProblem(Exception):
    """Pause the run on this step with a ⚠️ for the author (problem dict as shown in the UI)."""

    def __init__(self, code: str, message: str, fix: str | None = None, **extra):
        super().__init__(message)
        self.problem = dict({"code": code, "message": message, "fix": fix}, **extra)


class ChecksRefused(StepProblem):
    """Akọwe's own checks refused a draft (not the AI reviewer): approving it again cannot help, so the run asks
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
        ev = dict({"at": now_iso(), "kind": kind, "step": step or run.get("current"), "message": clip_words(message, 400)},
                  **{k: v for k, v in extra.items() if v is not None})
        run.setdefault("events", []).append(ev)
        if len(run["events"]) > MAX_EVENTS:
            run["events"] = run["events"][-MAX_EVENTS:]

    def alive(self, run_id: str) -> bool:
        t = self._threads.get(run_id)
        return bool(t and t.is_alive())

    def check(self, run: dict):
        if check_now_mod._ANNOUNCE:  # noqa: SLF001 - 🔎 a "Check consistency now" queued: say so in the journal
            try:
                check_now_mod.notice(self, run)
            except Exception:  # noqa: BLE001
                log.exception("could not announce the queued consistency check")
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
                raise AkoweError("VERSION_CONFLICT", "/run", "this is already running", status="REJECTED")
            self._ctl[run["id"]] = {"pause": False, "cancel": False}
            t = threading.Thread(target=self._wrap, args=(run["id"], target), daemon=True,
                                 name=f"akowe-{self.KIND}-{run['id'][-6:]}")
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
                run["problem"] = {"code": "INTERNAL_ERROR", "message": "Akọwe hit an unexpected problem.",
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
            raise AkoweError("NOT_FOUND", "/run_id", "this run is not known", status="REJECTED")
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
                raise AkoweError(code, "", (errs[0].get("message") if errs else "") or "the AI is busy")
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
        what = the(ai_activity.nice(label))
        try:
            with ai_activity.doing(f"Writing {what}", done=f"Wrote {what}"):  # ⚡ #116 the AI activity strip
                return wait_and_retry(once, policy=self.policy(), check=lambda: self.check(run),
                                      on_wait=lambda info: self.on_wait(run, info), who=self._who(run))
        except AkoweError as exc:
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
            if info.get("kind"):
                # ⏳ PR #122: a long wait (usage limits, a second AI) checks every few minutes: one journal line per
                # wait, not one per check
                key = f"_note_at_{info['kind']}"
                if time.time() - float(run.get(key) or 0) > 1800:
                    self.event(run, "wait", info["message"], code="USAGE_LIMIT_WAIT" if info["kind"] == "usage_limit"
                               else info["code"])
                run[key] = time.time()
            else:
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
            return
        self.ai_alerts(run)

    def ai_alerts(self, run: dict, *, at_start: bool = False):
        """P37.5: a visible notice in the run window for every AI that is not working — what is wrong and how to fix
        it (ai_check.describe) — so no AI ever sits out silently; an event when one stops working during the run and
        when it works again."""
        try:
            skipped = set(((run.get("settings") or {}).get("ai_check") or {}).get("skipped") or [])
            now, new, back = ai_check.alert_rows(run.get("ais") or [], run.get("ai_alerts"), skipped)
            others = [a["name"].split(" · ")[-1] for a in run.get("ais") or [] if a.get("working")]
            for a in now:
                a["since"] = a.get("since") or now_iso()
                a["takes_over"] = others
            for a in new:
                if a["chosen"]:
                    continue  # the author chose to start without it; the start event already says so
                where = "at the start of the run" if at_start else "during the run"
                self.event(run, "ai_alert", f"⚠️ {a['title']} ({where}): {a['what']} "
                           + (f"Its work goes to {' and '.join(others)} meanwhile. " if others else
                              "No other AI works, so the work waits for one. ")
                           + (f"To fix it: {a['fix'][0]}" if a.get("fix") else ""),
                           code="AI_NOT_READY" if at_start else "AI_STOPPED", slot=a["slot_id"])
            for a in back:
                self.event(run, "note", f"✔ {a.get('ai') or a.get('slot_id')} works again — Akọwe uses it again.",
                           code="AI_BACK", slot=a.get("slot_id"))
            run["ai_alerts"] = now
        except Exception:  # noqa: BLE001 - a display hint must never break the run
            log.exception("could not update the AI notices")

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
        self.ai_alerts(run, at_start=True)
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
            self.refresh_ais(run)  # also raises the visible ⚠️ notice for the AI that stopped working (P37.5)
            self.save(run)
        except Exception:  # noqa: BLE001 - display only
            log.exception("could not record a failover")


class _TimedProviders(PinnedProviders):
    """The run's AI registry, timing every AI call made through it (P15 ETA; numbers only)."""

    def __init__(self, base, slot_id, sink):
        super().__init__(base, slot_id)
        self._sink = sink
        self.prefer_writer = None  # 🏆 writer_record.py: the AI with the best chapters writes this chapter first
        self.avoid: set = set()    # 🗳 stand_in_errors.py: "let another AI do it" — not used while another works

    def eligible(self, project_id, capability, needed_tokens, operation=None):
        out = super().eligible(project_id, capability, needed_tokens, operation)
        if self.avoid and any(s["slot_id"] not in self.avoid for s in out):
            out = [s for s in out if s["slot_id"] not in self.avoid]
        pref = self.prefer_writer
        if pref and not self.pinned and operation == "C02" and len(out) > 1:
            # only a re-order of the AIs that may write anyway: a busy / limited / broken AI is never added
            out.sort(key=lambda s: (self.health.failed(s["slot_id"]) is not None, s["slot_id"] != pref))
        return out

    def _generate_on(self, *a, **kw):
        t0 = time.monotonic()
        slot = (a[1] if len(a) > 1 else kw.get("slot")) or {}  # P28: which AI answered (numbers only)
        ok = False
        try:
            out = super()._generate_on(*a, **kw)
            ok = True
            return out
        finally:
            try:
                self._sink(time.monotonic() - t0, slot=slot.get("slot_id"), ok=ok)
            except Exception:  # noqa: BLE001 - a timing hint never breaks a call
                pass


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
        """The newest runs first; runs a newer run of the same book made unnecessary (``replaced_by``) come last, so
        ``runs[0]`` is always the newest run that counts."""
        out = []
        for r in self.jobs.list(kind=self.KIND, limit=limit):
            if r.get("principal") in (None, principal):
                out.append(self.public(self._cache.get(r["id"], r)))
        return [r for r in out if not r.get("replaced_by")] + [r for r in out if r.get("replaced_by")]

    def current(self, principal: str, runs: list[dict] | None = None) -> dict | None:
        """The run that matters now: the one working, else the newest run that was not replaced (any state)."""
        act = [self.public(r) for r in self.active() if r.get("principal") in (None, principal)]
        if act:
            return act[0]
        runs = self.list(principal) if runs is None else runs
        return next((r for r in runs if not r.get("replaced_by")), None)

    def run_state(self, run: dict) -> tuple[str, str]:
        """(state, plain words): ONE word for where a run really stands, the same for the run window, the button in the
        top bar, the jobs list, AutoInjector's Akọwe panel and Alfred. working | waiting | pausing | paused (by the
        author) | needs_decision (the AI reviewer did not pass a draft: approve anyway / edit / try again) | problem
        (stopped on a problem: try again) | interrupted (Akọwe was closed while it worked: Resume) | done | cancelled
        | replaced (a newer run of the same book took over)."""
        status, alive = run.get("status"), self.alive(run.get("id") or "")
        prob = run.get("problem") or {}
        if status == "done":
            return "done", "Finished: the book is made."
        if status == "cancelled":
            if run.get("replaced_by"):
                return "replaced", "Not needed any more: a newer run of this book took over."
            return "cancelled", "Cancelled."
        if status == "interrupted" or (status in ("queued", "running", "waiting", "pausing") and not alive):
            return "interrupted", "Stopped because Akọwe was closed while it worked. Press ▶ Resume."
        if status == "pausing":
            return "pausing", "Pausing after the current answer."
        if status == "waiting":
            return "waiting", "Waiting for the AI."
        if status in ("queued", "running"):
            return "working", "Working."
        if status == "paused":
            if prob.get("code") == "REVIEW_DECISION":
                return "needs_decision", "Paused: it needs your decision (accept the change, keep the original, or " \
                                         "edit it yourself)."
            if {"approve_anyway", "edit"} & set(prob.get("options") or []):
                return "needs_decision", "Paused: it needs your decision (approve anyway, edit it, or try again)."
            if run.get("pause_reason") == "author":
                return "paused", "Paused by you. Press ▶ Resume to continue."
            return "problem", "Stopped on a problem. Press 🔁 Try again."
        return str(status or "unknown"), str(status or "unknown")

    def _retire_older(self, run: dict, why: str):
        """Older runs of the same book that stopped part-way (paused, interrupted) are not needed once a newer run
        finished the book or took over: they are marked replaced (status cancelled, ``replaced_by``), so no button,
        list, AutoInjector or Alfred still says the book is paused or interrupted. Never raises."""
        pid = run.get("project_id")
        if not pid:
            return
        try:
            for j in self.jobs.list(kind=self.KIND, project_id=pid, limit=100):
                if j.get("id") == run["id"] or self.alive(j["id"]) or j.get("status") in ("done", "cancelled"):
                    continue
                old = self.get(j["id"]) or j
                for s in old.get("steps") or []:
                    if s.get("state") in ("running", "waiting", "paused"):
                        s["state"] = "cancelled"
                old.update(status="cancelled", replaced_by=run["id"], finished_at=old.get("finished_at") or now_iso(),
                           waiting=None, old_status=old.get("status"),
                           phase=f"Not needed any more: a newer run ({run['id']}) {why}.")
                if old.get("problem"):
                    old["old_problem"], old["problem"] = old["problem"], None
                self.event(old, "replaced", f"Not needed any more: run {run['id']} {why}")
                self.save(old)
        except Exception:  # noqa: BLE001 - tidying up older runs never breaks this one
            log.exception("could not mark the older runs of %s as replaced", pid)

    def public(self, run: dict) -> dict:
        out = dict(run)
        out["alive"] = self.alive(run["id"])
        out["state"], out["state_words"] = self.run_state(run)
        out["needs_you"] = out["state"] in ("paused", "needs_decision", "problem", "interrupted")
        out["needs_decision"] = out["state"] == "needs_decision"
        try:  # 🔔 what the alert says: category, what, what is wrong, why it stopped, what happens next (alerts.py)
            out["alert"] = alerts_mod.describe(run, out["state"])
        except Exception:  # noqa: BLE001 - display only
            log.debug("could not describe the run's alert", exc_info=True)
            out["alert"] = None
        from . import stand_in  # noqa: PLC0415 - 🧑‍⚖️ the stand-in decider: its decisions (↩ Undo) and when it steps in
        out["stand_in"] = stand_in.view(self.app, run)
        if out["alert"]:
            out["alert"] = alerts_mod.with_stand_in(out["alert"], out["stand_in"])
        out["steps_done"] = sum(1 for s in run.get("steps") or [] if s.get("state") in ("done", "skipped"))
        out["steps_total"] = len(run.get("steps") or [])
        # A run that stopped (paused, waiting for a decision, interrupted) is not working: its clock stops at its last
        # save, so a step paused hours ago does not read "8 h 12 min" as if it were still busy.
        stopped_at = run.get("updated_at") if not out["alive"] and not run.get("finished_at") else None
        end = run.get("finished_at") or stopped_at
        out["elapsed_ms"] = _elapsed(run.get("started_at"), end) if run.get("started_at") else 0
        steps = []
        for s in run.get("steps") or []:
            s = dict(s)
            if s.get("started_at"):
                s["elapsed_ms"] = _elapsed(s["started_at"], s.get("finished_at") or stopped_at)
            steps.append(s)
        out["steps"] = steps
        out["events"] = (run.get("events") or [])[-60:]
        try:  # ⏳ the progress strip: time left against the start estimate, the step, the finish time (run_clock.py)
            out.update(run_clock.progress(run, out["alive"], out["state"]))
        except Exception:  # noqa: BLE001 - display only
            log.exception("could not add the run's progress")
        try:  # ⏱ P28: calls and minutes of this run, per AI and per step (numbers only)
            out["costs"] = costs_mod.run_costs(run, getattr(self.app.review, "slot_label", None))
        except Exception:  # noqa: BLE001 - display only
            log.exception("could not add the run's costs")
        saver = getattr(self.app, "saver", None)
        out["save"] = saver.brief(run.get("project_id"), run.get("branch_id") or "main") if saver else None
        return out

    def _autosave(self, run, *, reason: str, force: bool = False):
        """💾 P20: save the book's folder in the background (never blocks or fails the run)."""
        saver = getattr(self.app, "saver", None)
        if saver is not None and run.get("project_id"):
            saver.auto(run["project_id"], run.get("branch_id") or "main", reason=reason, force=force)

    def start(self, principal: str, body) -> dict:
        body = body if isinstance(body, dict) else {}
        if body.get("author_confirms") is not True:
            raise AkoweError("APPROVAL_REQUIRED", "/author_confirms", "pressing ⚡ Make a book for me is your "
                                 "consent for this run; it must be sent as author_confirms: true", status="REJECTED")
        settings = self._clean_settings(body)
        bible = self._bible_settings(principal, body, settings)   # P21 🔁 rerun from a saved book bible
        if body.get("sequel") not in (None, ""):  # 📚 a sequel: the next book of a series (series.start_sequel)
            if bible is None:
                raise AkoweError("INVALID_INPUT", "/sequel", "a sequel starts from the book bible of the book before "
                                     "it (from_bible)", status="REJECTED")
            from . import series as series_mod  # noqa: PLC0415
            settings["sequel"] = series_mod.clean_sequel_setting(self.store, body["sequel"])
        self._continue_settings(principal, body, settings)        # P21 ▶ continue an (opened) unfinished book
        if not self._ai_configured():
            raise AkoweError("CAPABILITY_UNAVAILABLE", "/slot_id", "no AI is connected — Make a book for me needs "
                                 "an AI", status="REJECTED")
        with self._lock:  # the check and the launch are one step: two presses at once start ONE run
            return self._start_locked(principal, settings, bible=bible)

    # ------------------------------------------------------------------ P21: rerun from a book bible / continue a book
    def _bible_settings(self, principal: str, body: dict, settings: dict) -> dict | None:
        spec = body.get("from_bible")
        if spec in (None, ""):
            return None
        if body.get("continue_project") or body.get("variant_of"):
            raise AkoweError("INVALID_INPUT", "/from_bible", "a rerun from a book bible makes a new book: it cannot "
                                 "also continue a book or be a variant", status="REJECTED")
        reuse = body.get("reuse_plan", True)
        if not isinstance(reuse, bool):
            raise AkoweError("INVALID_INPUT", "/reuse_plan", "reuse_plan must be true or false", status="REJECTED")
        bible, src = self.app.opener.resolve_bible(principal, spec)
        prof = bible.get("profile") or {}
        if body.get("length") in (None, "") and prof.get("length") in LENGTHS:
            settings["length"] = prof["length"]
        if not body.get("choices") and bible.get("choices"):
            settings["choices"] = story_choices.clean(bible["choices"])
        if body.get("pipeline") in (None, "", {}) and bible.get("pipeline"):
            settings["pipeline"] = pipeline_mod.clean({"flags": (bible["pipeline"] or {}).get("flags") or {}})
        if not settings.get("genre") and prof.get("genre"):
            settings["genre"] = str(prof["genre"])[:120]
        from . import book_bible  # noqa: PLC0415
        settings["bible"] = {"title": str(prof.get("title") or "")[:200], "source": src[:300], "reuse_plan": reuse,
                             "summary": book_bible.summary(bible)}
        return bible

    def _continue_settings(self, principal: str, body: dict, settings: dict):
        pid = body.get("continue_project")
        if pid in (None, ""):
            return
        if not isinstance(pid, str) or self.store.project(pid) is None or \
                not self.store.has_project_access(principal, pid):
            raise AkoweError("NOT_FOUND", "/continue_project", "that book does not exist", status="REJECTED")
        if body.get("variant_of"):
            raise AkoweError("INVALID_INPUT", "/continue_project", "continuing a book cannot also make a variant",
                                 status="REJECTED")
        prof = get_profile(self.store, pid)
        if prof.get("length") in LENGTHS and body.get("length") in (None, ""):
            settings["length"] = prof["length"]
        if prof.get("choices") and not body.get("choices"):
            settings["choices"] = story_choices.clean(prof["choices"])
        if body.get("pipeline") in (None, "", {}):
            settings["pipeline"] = pipeline_mod.clean({"flags": pipeline_mod.of_store(self.store, pid)})
        title = prof.get("title") or self.store.project(pid)["name"]
        settings["continue"] = {"project_id": pid, "title": str(title)[:200]}

    def _refuse_while_checking(self, pid: str | None) -> None:
        """PR #122: never start (or resume) a ⚡ run on a book while a whole-book consistency check of it runs on its
        own: both would fight over the AIs and the run would wait, then pause."""
        why = check_now_mod.solo_running(self.app, pid) if pid else None
        if why:
            raise AkoweError("VERSION_CONFLICT", "/run", why, status="REJECTED")

    def _bible_of(self, run) -> dict | None:
        key = (run.get("settings") or {}).get("bible", {}).get("key")
        v = self.store.get_setting(key) if key else None
        return v if isinstance(v, dict) else None

    def _start_locked(self, principal: str, settings: dict, bible: dict | None = None) -> dict:
        if self.active():
            raise AkoweError("VERSION_CONFLICT", "/run", "a Make-a-book run is already working; pause or cancel "
                                 "it first (or wait for it to finish)", status="REJECTED")
        self._refuse_while_checking((settings.get("continue") or {}).get("project_id"))
        run_id = f"run-{uuid.uuid4().hex[:12]}"
        if bible is not None:  # kept with the new book (deleted with it): the run reads it step by step
            key = f"rerun_bible:proj-{run_id.split('-', 1)[-1]}"
            self.store.set_setting(key, bible)
            settings["bible"]["key"] = key
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
        self._note_ai_choice(run)
        if settings.get("continue"):
            c = settings["continue"]
            run.update(project_id=c["project_id"], title=c["title"])
            run["consent"]["scope"] = f"this run only (continuing “{c['title']}”)"
            run["consent"]["text"] = ("You pressed ▶ Continue making this book: the AI may approve drafts that its own "
                                      "review passes, for this book and this run only.")
            self.event(run, "project", f"Continuing “{c['title']}” from where it stopped: the steps already done are "
                       "kept and skipped", step="backup")
        if settings.get("sequel"):
            q = settings["sequel"]
            self.event(run, "note", f"📚 Book {q['number']} of the series: it starts from the end of “"
                       f"{q.get('previous_title') or 'the book before'}” — every character's personality, voice, name "
                       "and origin are kept exactly (fixed for the series); their looks, belongings, abilities, "
                       "relationships and status start as that book left them. New premise, plot and chapters.",
                       step="backup", code="SERIES_SEQUEL")
        if settings.get("bible"):
            b = settings["bible"]
            self.event(run, "note", f"🔁 A new book from the book bible of {b['source']}: the same profile, choices, "
                       "characters (with their sheets and voice cards), places, story rules and world texture"
                       + (", premise, plot and outline" if b.get("reuse_plan") else " (a new premise, plot and outline)")
                       + ". They come into the NEW book as drafts and each one is reviewed and approved there under "
                       "your consent for this run; the chapters are written new.", step="backup", code="BIBLE_RERUN")
        self.save(run)
        if settings.get("continue"):
            self._retire_older(run, "continues this book")
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
            raise AkoweError("INVALID_INPUT", "/run_id", f"this run is {run['status']}", status="REJECTED")
        with self._lock:
            if self.alive(run_id):
                if self._ctl.get(run_id, {}).get("pause"):
                    self._ctl[run_id]["pause"] = False
                    run["status"], run["phase"] = "running", "Continuing"
                    self.save(run)
                return self.public(run)
            if self.active():
                raise AkoweError("VERSION_CONFLICT", "/run", "another Make-a-book run is working",
                                     status="REJECTED")
            self._refuse_while_checking(run.get("project_id"))
            prob = run.get("problem") or {}
            if run.get("status") == "paused" and prob.get("code") and prob.get("code") != "CHECKPOINT_WAITING":
                from . import stand_in  # noqa: PLC0415 - 🔁 Try again on a vote the AIs did not all agree on (also 🗳)
                stand_in.settle_votes(self.store, run, prob, "retry")
            elif run.get("status") == "paused" and prob.get("code") == "CHECKPOINT_WAITING":
                from . import stand_in  # noqa: PLC0415 - 🧭 ▶ Continue after a story-check vote that did not agree
                from .continuity import chapters_of  # noqa: PLC0415
                stand_in.settle_votes(self.store, run, prob, "continue",
                                      {c["chapter_id"]: c for c in chapters_of(self.bp(run))})
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
            from . import cli_mode  # noqa: PLC0415 - ⌨ a command-line AI working for this run is stopped at once
            cli_mode.cancel(run_id=run_id)
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
        if action not in ("approve_anyway", "retry", "edited", "accept_change", "keep_original"):
            raise AkoweError("INVALID_INPUT", "/action", "action: approve_anyway, retry, edited, accept_change or "
                             "keep_original", status="REJECTED")
        if self.alive(run_id):
            raise AkoweError("VERSION_CONFLICT", "/run", "the run is still working; pause it first",
                                 status="REJECTED")
        if run.get("status") not in ("paused", "interrupted"):
            # Nothing may change behind an error answer: refuse before approving anything.
            raise AkoweError("INVALID_INPUT", "/run_id", f"this run is {run.get('status')}: there is nothing "
                                 "to decide (nothing was changed)", status="REJECTED")
        prob = run.get("problem") or {}
        rid = prob.get("record_id")
        if action in ("accept_change", "keep_original"):
            return self._decide_change(principal, run, prob, action, body)
        if action == "approve_anyway":
            if body.get("author_confirms") is not True:
                raise AkoweError("APPROVAL_REQUIRED", "/author_confirms", "approving needs your explicit "
                                     "confirmation (author_confirms: true)", status="REJECTED")
            if not rid:
                raise AkoweError("INVALID_INPUT", "/action", "there is no draft waiting for a decision",
                                     status="REJECTED")
            if "approve_anyway" not in (prob.get("options") or []) and prob.get("code") != "REVIEW_NOT_PASSED":
                # e.g. the AI reviewer could not answer: the draft was never reviewed, so it is not approved blind
                raise AkoweError("INVALID_INPUT", "/action", "this step stopped on a problem, not on a review "
                                     "decision: press 🔁 Try again (nothing was approved)", status="REJECTED")
            out = self.app.review.approve(principal, run["project_id"], run["branch_id"],
                                          {"record_ids": [rid], "author_confirms": True, "how": "one"})
            res = out["results"][0] if out.get("results") else {"ok": False, "message": "not approved"}
            if not res.get("ok"):
                raise AkoweError("INVALID_INPUT", "/action", res.get("message") or "it could not be approved",
                                     status="REJECTED")
            self.event(run, "approve", "You approved it anyway (your own approval)", approval="author",
                       record_id=rid)
            checker_record.settle(self.store, run, rid, int((self.bp(run).rec(rid) or {}).get("version") or 0),
                                  how="approve_anyway", chapter_id=prob.get("chapter_id"))
            # H14: the editor and the plan check this draft skipped still run (as notes) when the run goes on
            label = (f"chapter {prob['chapter_id']}" if prob.get("chapter_id") else
                     safe_title(self.app.engine.contracts, self.bp(run).rec(rid) or {"module_id": prob.get("module_id")}))
            head = self.bp(run).rec(rid) or {"record_id": rid, "version": prob.get("version"),
                                             "module_id": prob.get("module_id")}
            approval_trust.note(self.store, run["project_id"], run["branch_id"], head, how="approve_anyway",
                                label=label, chapter_id=prob.get("chapter_id"), by=principal)
            run.setdefault("notes_due", {})[rid] = {"label": label, "chapter_id": prob.get("chapter_id"),
                                                    "approved_anyway": True,  # 🔁 its notes wait for the improve pass
                                                    "reasons": [str(x)[:300] for x in (prob.get("reasons") or [])][:4]}
            if prob.get("no_second_check") and body.get("for_rest_of_run") is True:
                # H6: the author chose to trust the one working AI for the rest of this run (said in every approval)
                run["self_review_ok"] = True
                self.event(run, "note", "You chose to approve the rest yourself through the one working AI: its own "
                           "APPROVE approves the next drafts of this run (each is listed as approved without a "
                           "second AI)", code="SELF_REVIEW_ALLOWED")
        elif action == "retry" and rid:
            counts = run.setdefault("fix_counts", {})
            counts[rid] = 0
            for k in [k for k in counts if k.startswith("redo:")]:
                counts[k] = 0  # "Try again" gives the AI new attempts at a draft Akọwe's checks refused
            self.event(run, "retry", "You asked the AI to try again")
        else:
            self.event(run, "retry", "Continuing after your change" if action == "edited" else "Trying again")
        from . import stand_in  # noqa: PLC0415 - 🧑‍⚖️ the AIs' votes on this decision (if they did not all agree)
        stand_in.settle_votes(self.store, run, prob, None if action == "edited" else action)
        self.save(run)
        return self.resume(principal, run_id)

    def _decide_change(self, principal: str, run: dict, prob: dict, action: str, body: dict) -> dict:
        """🔁 The author's answer to ONE specific decision (REVIEW_DECISION): ✔ accept the change (the draft as it is
        now, approved as the author's own) or ↩ keep the original (the version before the fix is put back as a new
        draft and approved as the author's own; the approved fact it disagrees with is listed to fix later)."""
        rid = prob.get("record_id")
        if action not in (prob.get("options") or []) or not rid:
            raise AkoweError("INVALID_INPUT", "/action", "this choice is not offered for the step that waits "
                             "(nothing was changed)", status="REJECTED")
        if body.get("author_confirms") is not True:
            raise AkoweError("APPROVAL_REQUIRED", "/author_confirms", "your choice approves this record as yours: it "
                             "needs your explicit confirmation (author_confirms: true)", status="REJECTED")
        bp = self.bp(run)
        head = bp.rec(rid)
        if head is None:
            raise AkoweError("NOT_FOUND", "/record_id", "this draft no longer exists", status="REJECTED")
        if action == "keep_original":
            pv = prob.get("prev_version")
            old = self.store.get_record(run["project_id"], run["branch_id"], rid, int(pv)) if pv else None
            if not old:
                raise AkoweError("NOT_FOUND", "/prev_version", "the original version is not there any more; edit "
                                 "it yourself instead (nothing was changed)", status="REJECTED")
            resp = bp.dispatch(head["module_id"], "UPDATE", base_ref=head["ref"], payload=copy.deepcopy(old["data"]))
            if resp["status"] != "DRAFT" or not resp.get("output_refs"):
                raise AkoweError("INVALID_INPUT", "/action", "Akọwe's checks refused the original version now: "
                                 + plain_problem(problems(resp)) + " — edit it yourself instead (nothing was "
                                 "approved)", status="REJECTED")
        out = self.app.review.approve(principal, run["project_id"], run["branch_id"],
                                      {"record_ids": [rid], "author_confirms": True, "how": "one"})
        res = out["results"][0] if out.get("results") else {"ok": False, "message": "not approved"}
        if not res.get("ok"):
            raise AkoweError("INVALID_INPUT", "/action", res.get("message") or "it could not be approved",
                             status="REJECTED")
        subject = prob.get("subject") or "the draft"
        if action == "accept_change":
            self.event(run, "approve", f"You accepted the change to {subject} (your own approval)", approval="author",
                       record_id=rid, code="CHANGE_ACCEPTED")
        else:
            self.event(run, "approve", f"You kept the original {subject} (your own approval); the approved fact it "
                       "disagrees with is listed for you to fix", approval="author", record_id=rid,
                       code="ORIGINAL_KEPT")
            later = run.setdefault("check_later", [])
            line = f"{subject}: you kept the original — make the approved facts agree with it"
            if line not in later:
                later.append(line)
        head = bp.rec(rid) or head
        checker_record.settle(self.store, run, rid, int(head.get("version") or 0), how=action,
                              chapter_id=prob.get("chapter_id"))
        approval_trust.note(self.store, run["project_id"], run["branch_id"], head, how="approve_anyway",
                            label=subject, chapter_id=prob.get("chapter_id"), by=principal)
        run.setdefault("notes_due", {})[rid] = {"label": subject, "chapter_id": prob.get("chapter_id")}
        (run.get("review_trail") or {}).pop(rid, None)
        from . import stand_in  # noqa: PLC0415 - 🧑‍⚖️ the AIs' votes on this decision (if they did not all agree)
        stand_in.settle_votes(self.store, run, prob, action)
        self.save(run)
        return self.resume(principal, run["id"])

    # ------------------------------------------------------------------ settings
    def _note_ai_choice(self, run: dict):
        """P37.5: say plainly which AIs the author chose to start without and who does their work (never raises)."""
        try:
            settings = run["settings"]
            skipped = (settings.get("ai_check") or {}).get("skipped") or []
            if not skipped:
                return
            prov = self.app.engine.providers
            slots = {s["slot_id"]: s for s in prov.ai_slots()}
            names = [ai_check.ai_word(slots.get(x) or {"slot_id": x}) for x in skipped]
            working = [ai_check.ai_word(s) for sid, s in slots.items() if sid not in skipped]
            if settings.get("slot_id") in skipped:
                self.event(run, "note", f"The AI you picked to write ({ai_check.ai_word(slots.get(settings['slot_id']) or {})}"
                           ") isn't working, so this run uses Automatic: the best working AI writes.", step="backup",
                           code="AI_SKIPPED")
                settings["slot_id"] = None
            self.event(run, "note", f"You chose to start without {' and '.join(names)}. "
                       + ai_check.start_note(names, working), step="backup", code="AI_SKIPPED")
        except Exception:  # noqa: BLE001 - a note must never stop the start
            log.exception("could not note the AI choice")

    def _clean_settings(self, body) -> dict:
        out = {"genre": "", "length": "short_story", "slot_id": None, "idea": "", "choices": {},
               "pipeline": pipeline_mod.clean(None)}
        pics = body.get("pictures")  # 🖼 the run's character pictures: None = Settings → Pictures (default on)
        if pics is not None:
            if not isinstance(pics, bool):
                raise AkoweError("INVALID_INPUT", "/pictures", "pictures must be true or false", status="REJECTED")
            out["pictures"] = pics
        hp = body.get("human_pass")  # ✍ the end-of-book "sounds like a person" pass (on unless switched off)
        if hp is not None:
            if not isinstance(hp, bool):
                raise AkoweError("INVALID_INPUT", "/human_pass", "human_pass must be true or false", status="REJECTED")
            out["human_pass"] = hp
        ip = body.get("improve_pass", True)  # 🔁 the final improve pass (improve_pass.py): on unless switched off
        if not isinstance(ip, bool):
            raise AkoweError("INVALID_INPUT", "/improve_pass", "improve_pass must be true or false", status="REJECTED")
        out["improve_pass"] = ip
        im = body.get("improve_mode", "scenes")  # 🎯 weak_scenes.py: the weakest scenes (default) or whole chapters
        if im not in ("scenes", "chapters"):
            raise AkoweError("INVALID_INPUT", "/improve_mode", "improve_mode must be \"scenes\" or \"chapters\"",
                             status="REJECTED")
        out["improve_mode"] = im
        for k in ("opening_pass", "first_page", "chapter_polish", "length_guard", "chapter_trim",  # ✍ / 📏 on
                  "scene_cut_retry",  # 📏 weak_scenes.py: one "cut it to N words" request before a scene is refused
                  "reread_after_rewrites", "beta_reread"):  # 🔁 final_reads.py
            v = body.get(k, True)
            if not isinstance(v, bool):
                raise AkoweError("INVALID_INPUT", f"/{k}", f"{k} must be true or false", status="REJECTED")
            out[k] = v
        ir = body.get("improve_rounds")
        if ir is not None:
            from . import improve_pass  # noqa: PLC0415
            if isinstance(ir, bool) or not isinstance(ir, int) or not 1 <= ir <= improve_pass.ROUNDS_MAX:
                raise AkoweError("INVALID_INPUT", "/improve_rounds", f"improve_rounds: 1 to {improve_pass.ROUNDS_MAX}",
                                 status="REJECTED")
            out["improve_rounds"] = ir
        for k in ("beta_reader", "my_style", "fill_bible", "writers_room"):  # P23 / P25 / 📖 / 🗳: off unless asked
            v = body.get(k, False)
            if not isinstance(v, bool):
                raise AkoweError("INVALID_INPUT", f"/{k}", f"{k} must be true or false", status="REJECTED")
            out[k] = v
        sa = body.get("single_ai")  # PR #122: what happens when only one AI works (see SINGLE_AI)
        if sa not in (None, ""):
            if sa not in SINGLE_AI:
                raise AkoweError("INVALID_INPUT", "/single_ai", "when only one AI works: continue, wait or ask",
                                 status="REJECTED")
            out["single_ai"] = sa
        ck = cross_check.clean(body.get("checkers"))  # 🔎 PR #117: how many AIs check for mistakes
        if ck is False:
            raise AkoweError("INVALID_INPUT", "/checkers", "how many AIs check for mistakes: all, two or one",
                             status="REJECTED")
        if ck:
            out["checkers"] = ck
        from . import checker_order  # noqa: PLC0415 - 🔢 which AI checks first, and which never check
        co = checker_order.clean(body.get("checker_order"))
        if co:
            out["checker_order"] = co
        from . import claude_code_book  # noqa: PLC0415 - 🤖 Claude Code helpers: on/off for this run (None = Settings)
        out.update(claude_code_book.clean_run_option(body, self.store))
        from . import story_doctor, voice_contrast  # noqa: PLC0415 - 🩺 the plan check / 🗣 distinct voice cards
        out.update(story_doctor.clean_run_option(body))
        out.update(voice_contrast.clean_run_option(body))
        from . import fresh_names, trade_card  # noqa: PLC0415 - 🔁 kept fresh / 🔧 the trade card (both on)
        out.update(trade_card.clean_run_option(body))
        out.update(fresh_names.clean_run_option(body))
        n = body.get("beta_readers", 1)  # 👥 idea #14: how many beta readers (1 = one AI; 2-3 = a panel)
        if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= 3:
            raise AkoweError("INVALID_INPUT", "/beta_readers", "beta_readers: 1, 2 or 3", status="REJECTED")
        if n != 1:
            out["beta_readers"] = n
        # P12: ending and style choices (all optional; empty = let the AI choose)
        out["choices"] = story_choices.clean(body.get("choices"))
        g = body.get("genre")
        if g not in (None, ""):
            if not isinstance(g, str) or len(g.strip()) > 120:
                raise AkoweError("INVALID_INPUT", "/genre", "genre: up to 120 characters", status="REJECTED")
            out["genre"] = g.strip()
        ln = body.get("length")
        if ln not in (None, ""):
            if ln not in LENGTHS:
                raise AkoweError("INVALID_INPUT", "/length", "length: short_story, novelette, novella or novel",
                                     status="REJECTED")
            out["length"] = ln
        out["slot_id"] = AssistService._check_slot(body.get("slot_id"))
        # P37.5: the page's AI check before the start ("Start without it": the AIs the author chose to skip)
        out["ai_check"] = ai_check.clean_choice(body.get("ai_check"), [s["slot_id"] for s in
                                                                     self.app.engine.providers.slots()])
        # P14: the pipeline switches of this run (default: everything on) and an optional "variant of" another book
        out["pipeline"] = pipeline_mod.clean(body.get("pipeline"))
        vo = body.get("variant_of")
        if vo not in (None, ""):
            pid = vo.get("project_id") if isinstance(vo, dict) else vo
            if not isinstance(pid, str) or not pid or len(pid) > 80:
                raise AkoweError("INVALID_INPUT", "/variant_of", "variant_of: the book (project_id) to make a "
                                     "variant of", status="REJECTED")
            src = get_profile(self.store, pid) if self.store.project(pid) is not None else {}
            if not src.get("title") and not src.get("idea"):
                raise AkoweError("NOT_FOUND", "/variant_of", "that book has no profile (title and idea) to make a "
                                     "variant of", status="REJECTED")
            out["variant_of"] = {"project_id": pid, "title": str(src.get("title") or "")[:200]}
            # the same book: its length and choices unless this run names its own
            if ln in (None, "") and src.get("length") in LENGTHS:
                out["length"] = src["length"]
            if not body.get("choices") and isinstance(src.get("choices"), dict):
                out["choices"] = story_choices.clean(src["choices"])
        pn = body.get("pen_name")  # ✒️ the author's own pen name for this book (empty: the saved one, else none)
        if pn not in (None, ""):
            if not isinstance(pn, str) or len(pn.strip()) > 200:
                raise AkoweError("INVALID_INPUT", "/pen_name", "pen name: up to 200 characters", status="REJECTED")
            out["pen_name"] = " ".join(pn.split())
        from . import starter_sheet  # noqa: PLC0415 - 📋 6c: the starter sheet's lock list
        locks = starter_sheet.clean_locks(body.get("locks"))
        if locks:
            out["locks"] = locks
        idea = body.get("idea")
        if idea not in (None, ""):
            if not isinstance(idea, str) or len(idea) > 2000:
                raise AkoweError("INVALID_INPUT", "/idea", "your idea: up to 2000 characters", status="REJECTED")
            out["idea"] = idea.strip()
        return out

    # ------------------------------------------------------------------ services bound to this run's AI choice
    def _services(self, run):
        slot = run["settings"].get("slot_id")
        sink = lambda secs, **kw: self._timed(run, secs, **kw)  # noqa: E731 - P15 ETA / P28 time per AI
        providers = _TimedProviders(self.app.engine.providers, slot, sink)
        providers.avoid = set(run["settings"].get("avoid_slots") or [])  # 🗳 an AI the stand-in moved away from
        engine = Engine(self.store, self.app.engine.contracts, providers=providers)
        assist = AssistService(engine, run["principal"], retry_busy=True)
        assist.retry_policy = self.retry_policy
        once = assist._call_ai_once

        def timed_once(job, **kw):
            # calls that leave the pinned registry (another AI reviews: cross_pin) are timed here, the rest below
            if not getattr(job, "cross_pin", False):
                return once(job, **kw)
            t0 = time.monotonic()
            ok = False
            try:
                out = once(job, **kw)
                ok = True
                return out
            finally:
                sink(time.monotonic() - t0, slot=getattr(job, "slot", None), ok=ok)
        assist._call_ai_once = timed_once  # type: ignore[method-assign]
        review = ReviewService(engine, assist, run["principal"], work=self.app.work, on_change=self.app.changed)
        from . import checker_order  # noqa: PLC0415 - 🔢 the run's checker order (else Settings › AI)
        review.checker_policy = checker_order.of_run(run, self.store)
        return engine, assist, review

    @staticmethod
    def _timed(run, secs: float, slot: str | None = None, ok: bool = True):
        costs_mod.record_call(run, secs, slot, ok)  # P28: totals (P15 ETA) plus per AI and per step
        if slot:  # 🗳 the AI whose call failed last (stand_in_errors.py: "let another AI do it")
            run["last_failed_slot"] = None if ok else slot

    def _eta(self, run, done: int, total: int) -> dict | None:
        """P15: time left, estimated from this run's measured times: the average chapter so far for the chapters
        left, plus a few measured AI calls for the steps after the chapters (report) and ~5 s per Akọwe step."""
        t = run.get("timing") or {}
        per = t.get("chapter_s") or []
        if not per or total <= 0:
            return None
        avg_ch = sum(per) / len(per)
        avg_call = (float(t.get("call_s") or 0) / int(t["calls"])) if t.get("calls") else 0.0
        after = 3 * avg_call + 5 * sum(1 for s in run["steps"] if s["id"] in ("planned", "format", "assemble", "export",
                                                                                "check", "report")
                                      and s["state"] not in ("done", "skipped"))
        left = max(0, total - done) * avg_ch + after
        return {"seconds_left": int(round(left)), "per_chapter_s": round(avg_ch, 1),
                "avg_call_s": round(avg_call, 2), "calls": int(t.get("calls") or 0), "chapters_left": total - done,
                "at": now_iso()}

    def bp(self, run) -> BookPath:
        return BookPath(self._engine, run["principal"], run["project_id"], run["branch_id"])

    @staticmethod
    def _on(run, flag: str) -> bool:
        """P14: is this pipeline switch on for the run (runs saved before the switches existed: everything on)?"""
        flags = ((run.get("settings") or {}).get("pipeline") or {}).get("flags") or {}
        return bool(flags.get(flag, True))

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
        """A run saved by an older Akọwe (resumed after an update) gets the steps added since, in order."""
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
        run_clock.clock_start(run)  # ⏳ the run's working clock (the author's waiting time is never counted)
        run_clock.plan_run(self.app, run)  # ⏳ the plan's estimate, kept on the run once
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
                flag = STEP_FLAGS.get(sid)
                if flag and not self._on(run, flag):  # P14: this part of the pipeline is switched off for the run
                    st.update(state="skipped", message=f"Off in this run's pipeline ({pipeline_mod.LABELS[flag]})",
                              finished_at=now_iso())
                    self.event(run, "skip", f"{st['title']}: switched off in this run's pipeline", step=sid)
                    self.save(run)
                    continue
                opt = STEP_OPTIONAL.get(sid)  # P23 (Section 7c): an optional step the run did not ask for
                if opt and not (run.get("settings") or {}).get(opt):
                    # "done", not "skipped": nothing was switched off, the extra was simply not asked for
                    st.update(state="done", message="Not asked for in this run", started_at=now_iso(),
                              finished_at=now_iso())
                    self.save(run)
                    continue
                run["current"] = sid
                st.update(state="running", started_at=st.get("started_at") or now_iso(), finished_at=None,
                          problem=None, message="Working…")
                run["phase"] = f"{st['title']}…"
                run_clock.step_start(run, st)
                self.refresh_ais(run)
                self.save(run)
                self._flush_notes_due(run, st)  # H14: the checks an "approve anyway" skipped, as notes
                # ⚡ #116: the AI activity strip says which book, which step (N of M) and what the AI does now
                with ai_activity.doing(STEP_DOING.get(sid, st["title"]), done=st["title"], kind="autobook",
                                       run_id=run["id"], book_id=run.get("project_id"),
                                       branch_id=run.get("branch_id"), step=STEP_IDS.index(sid) + 1,
                                       steps=len(STEP_IDS), step_title=st["title"]):
                    getattr(self, f"_s_{sid}")(run, st)
                st.update(state="done", finished_at=now_iso())
                run_clock.step_done(run, st)
                if not st.get("message") or st["message"] == "Working…":
                    st["message"] = "Done"
                self.event(run, "done", f"{st['title']}: {st['message']}", step=sid)
                self.save(run)
                if sid != STEP_IDS[-1]:  # the last step is followed by the run's own save (below)
                    self._autosave(run, reason=f"step {sid}")
            # ★ the guarantee: never a finished book without its main character (repaired, else a plain pause)
            run["current"] = "check"
            self._guarantee_main(run, self._step(run, "check"), "before the book is marked done")
            from . import claude_code_speed  # noqa: PLC0415 - 🤖 Step 2: the background extras (capped wait)
            claude_code_speed.finish(self, run)
            self.save(run)
            run_clock.finish(run)  # ⏳ the real working time beside the estimate (the next estimate learns from it)
            run.update(status="done", finished_at=now_iso(), current=None, waiting=None, pause_reason=None,
                       phase="Your book is made — download it below")
            if (run.get("problem") or {}).get("severity") != "warning":
                run["problem"] = None  # a finished run has nothing left to decide
            self._retire_older(run, "finished this book")
            self.event(run, "finished", "Your book is made: PDF, EPUB and Word files are ready")
            es = run.get("editor_summary") or {}
            if es.get("reviewed"):
                fl = es.get("flagged") or []
                self.event(run, "note", f"Editor: {es['reviewed']} chapter(s) read, {es.get('passed', 0)} passed, "
                           f"{es.get('kept', 0)} rewrite(s) kept, {es.get('rejected', 0)} not kept"
                           + (f" — ⚠️ still had notes on {', '.join(str(f.get('label')) for f in fl)}" if fl else ""),
                           code="EDITOR_NOTES" if fl else None)
            ps = run.get("planned_summary") or {}
            if ps.get("checked"):
                fl = ps.get("flagged") or []
                self.event(run, "note", f"Planned to page: {ps['checked']} chapter(s) checked, {ps.get('fixed', 0)} "
                           "fix(es) kept" + (f" — ⚠️ still missing in {', '.join(str(f.get('label')) for f in fl)}"
                                             if fl else ""), code="PLANNED_MISSING" if fl else None)
            rs = run.get("review_summary") or {}
            if rs.get("same_ai"):
                self.event(run, "note", f"⚠️ {NOT_INDEPENDENT}: {rs['same_ai']} of {rs['same_ai'] + rs.get('independent', 0)}"
                           " AI review(s) were made by the AI that wrote the draft (only one AI worked then)",
                           code="REVIEW_NOT_INDEPENDENT")
            self._length_warning(run)
            self._series_changes(run)
            self._record_quality(run)  # 📈 the trend over the author's books, and the lessons for the next one
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
        except AkoweError as exc:
            e = exc.errors[0] if exc.errors else {}
            code = exc.code
            fix = TIMEOUT_FIX if code == "TIMEOUT" else DECLINED_FIX if code == "AI_DECLINED" else \
                BUSY_FIX if code in BUSY_CODES else (
                "Press 🔁 Try again. If it keeps failing, use 📋 Copy diagnostics.")
            self._pause_problem(run, {"code": code, "message": e.get("message") or code, "fix": fix,
                                      "path": e.get("path") or ""})
        except Cancelled:
            self._finish_cancel(run)
            self.save(run)
        except Exception as exc:  # noqa: BLE001 - shown as a ⚠️ on the step, logged here
            log.exception("make-a-book run %s: unexpected problem in step %s", run_id, run.get("current"))
            self._pause_problem(run, {"code": "INTERNAL_ERROR",
                                      "message": f"Akọwe hit an unexpected problem ({type(exc).__name__}).",
                                      "fix": "Press 🔁 Try again. If it keeps happening, use 📋 Copy diagnostics."})
        finally:
            if (run.get("clock") or {}).get("since"):  # ⏳ the run stopped working: its clock stops too
                run_clock.clock_stop(run)
                self.save(run)
            health.set_listener(None)
            self._tl.run_id = None
            self._tl.engine = self._tl.assist = self._tl.review = None
            # 💾 the run stopped (finished, paused, cancelled or a problem): save the book's folder now
            self._autosave(run, reason=f"run {run.get('status')}", force=True)

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
        # The author pressed Cancel or Pause while this step was working: the step may have failed *because* it was
        # interrupted (an AI call or a session swallowed the stop and the step then found nothing made). What the
        # author asked for wins over that problem — never "paused on a problem" after a Cancel.
        ctl = self._ctl.get(run["id"]) or {}
        if threading.current_thread() is self._threads.get(run["id"]) and (ctl.get("cancel") or ctl.get("pause")):
            if ctl.get("cancel"):
                self._finish_cancel(run)
            else:
                if st["state"] in ("running", "waiting"):
                    st["state"], st["message"] = "paused", "Paused by you"
                run.update(status="paused", pause_reason="author", waiting=None,
                           phase="Paused — press ▶ Resume to continue")
            self.save(run)
            return
        where = {"book": run.get("title") or "New book", "step": st["title"], "set": st.get("set"),
                 "set_name": SET_NAMES.get(st.get("set") or "", None), "op": problem.get("op") or st.get("op")}
        if problem.get("chapter_id"):
            where["chapter"] = problem["chapter_id"]
        problem = dict(problem, where=where, step=sid, at=now_iso())
        if problem.get("code") == "TIMEOUT":
            problem.setdefault("options", ["retry"])
        if not problem.get("subject") and (problem.get("record_id") or problem.get("chapter_id")):
            try:  # what it is about, in plain words (the alert says it: "Ansel Marrant (character)", "Chapter 3")
                head = self.bp(run).rec(problem["record_id"]) if problem.get("record_id") else None
                problem["subject"] = self._subject(head, problem.get("chapter_id"))
            except Exception:  # noqa: BLE001 - the alert falls back to the step's name
                log.debug("could not name the subject of the problem", exc_info=True)
        st.update(state="failed" if problem.get("code") not in ("TIMEOUT", "REVIEW_NOT_PASSED", "CHECKS_REFUSED",
                                                                "NO_SECOND_AI", "NO_REASON", "LOW_CONFIDENCE",
                                                                "REVIEW_DECISION")
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
            raise AkoweError("PERMISSION_DENIED", "/consent", "approvals under the Make-a-book consent happen only "
                                 "inside the run the author started, for that run's own book", status="REJECTED")

    def _approve(self, run, ref, *, why: str, verdict: str | None = None, slot: str | None = None) -> dict:
        """Approve exactly this revision under the author's consent for THIS run (never outside one)."""
        self._check_consent(run, ref.get("project_id"))
        bp = self.bp(run)
        self._note_own(run, bp, ref)  # 🔁 Akọwe's own chapter text is never taken for a hand edit (final_reads.py)
        res = bp.approve_ref(ref)
        label = f"Approved under your Make-a-book-for-me consent, run {run['id']}"
        with self.store.transaction() as tx:
            tx.insert_outbox(run["project_id"], run["branch_id"],
                             "autobook.approved_under_consent" if res.get("ok") else "autobook.approve_failed",
                             {"record_id": ref["record_id"], "version": ref["version"], "module_id": ref["module_id"],
                              "run_id": run["id"], "consent": {"by": run["consent"]["by"], "at": run["consent"]["at"]},
                              "why": why, "verdict": verdict, "ai_slot": slot, "ok": bool(res.get("ok")),
                              "label": label if res.get("ok") else "Approval under the run consent was refused by "
                              "Akọwe's checks"})
        if not res.get("ok"):
            raise self._refused(ref, safe_title(self.app.engine.contracts, bp.rec(ref["record_id"]) or ref),
                                res.get("problems") or [])
        self.event(run, "approve", f"{safe_title(self.app.engine.contracts, bp.rec(ref['record_id']))}: {label}",
                   approval="run_consent", record_id=ref["record_id"], module_id=ref["module_id"], verdict=verdict)
        return res

    def _note_own(self, run, bp, ref):
        """🔁 Register an AI-made chapter revision as Akọwe's own BEFORE it is approved (continuity.note_own)."""
        try:
            if ref.get("module_id") != "C02":
                return
            rec = bp.rec(ref["record_id"], ref["version"])
            if rec is not None and self._ai_made(run, rec):
                from . import continuity  # noqa: PLC0415
                continuity.note_own(self.store, run["project_id"], run["branch_id"], ref["record_id"], ref["version"])
        except Exception:  # noqa: BLE001 - only a note; the approval goes on
            log.exception("could not note Akọwe's own chapter text")

    def _second_ai_working(self, writer_slot: str | None) -> bool:
        """Is an AI of another family than the writer's working right now (it could review independently)?"""
        prov = self.app.engine.providers
        slots = {s["slot_id"]: s for s in prov.ai_slots()}
        fam = providers_mod.slot_family(slots.get(writer_slot)) if writer_slot else None
        for s in slots.values():
            if s["slot_id"] == writer_slot or not s.get("healthy", True):
                continue
            try:
                ok = prov.available(s) and not prov.health.failed(s["slot_id"])
            except Exception:  # noqa: BLE001
                ok = False
            if ok and (fam is None or providers_mod.slot_family(s) != fam):
                return True
        return False

    def _wait_for_second_ai(self, run: dict, st: dict, label: str, review: dict) -> bool:
        """single_ai = "wait": wait (checking every few minutes, up to the usage-limit waiting time) until a second AI
        works. True: one works now (the draft is reviewed again); False: none came (the author decides)."""
        pol = self.policy()
        total = max(0.0, float(getattr(pol, "limit_wait_s", 0) or 0))
        every = max(0.01, float(getattr(pol, "limit_check_s", 300) or 300))
        writer = review.get("writer_slot")
        waited = 0.0
        while waited < total:
            if self._second_ai_working(writer):
                return True
            step = min(every, total - waited)
            nxt = time.time() + step
            info = {"code": "NO_SECOND_AI", "kind": "second_ai", "retry_in_s": int(step),
                    "retry_at": datetime.fromtimestamp(nxt, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "message": f"Only {review.get('writer_ai') or 'one AI'} is working — waiting for a second AI to "
                               f"check the {label} (next look at about {usage_limits.clock(nxt)})"}
            self.on_wait(run, info)
            left = step
            while left > 0:
                self.check(run)
                chunk = min(0.5, left)
                pol.sleep(chunk)
                left -= chunk
            waited += step
            self.on_wait(run, None)
        return self._second_ai_working(writer)

    @staticmethod
    def _refused(ref, label: str, probs: list, chapter_id: str | None = None) -> ChecksRefused:
        rules = {str(p).split(":", 1)[0].strip() for p in probs or []}
        stale = bool(rules) and rules <= {"STALE", "SOURCE_PIN", "INPUT_NOT_VALIDATED"}
        return ChecksRefused("CHECKS_REFUSED", f"Akọwe's checks refused the {label}: " + plain_problem(probs),
                             STALE_FIX if stale else CHECKS_FIX, record_id=ref["record_id"],
                             version=ref.get("version"), module_id=ref["module_id"], details=digest(probs),
                             chapter_id=chapter_id, options=["retry"] if stale else ["edit", "retry"])

    def _review_until_approved(self, run, st, rid: str, label: str, chapter_id: str | None = None, precheck=None):
        """Akọwe's checks, then AI review -> approve under consent, or fix (max 2) -> review again; else pause
        for the author. A draft the checks refuse is not sent to the AI reviewer (ChecksRefused)."""
        bp = self.bp(run)
        counts = run.setdefault("fix_counts", {})
        while True:
            self.check(run)
            head = bp.rec(rid)
            if head is None:
                raise StepProblem("NOT_FOUND", f"The draft of the {label} disappeared.", "Press 🔁 Try again.")
            if head["lifecycle"] in ("APPROVED", "LOCKED") or head.get("approved_version") == head["version"]:
                if rid in (run.get("notes_due") or {}):  # H14: approved anyway -> the skipped checks run as notes
                    self._notes_after_approval(run, st, rid, label, chapter_id)
                    return bp.rec(rid)
                return head
            v = bp.dispatch(head["module_id"], "VALIDATE", base_ref=head["ref"],
                            payload=candidate_payload(head["ref"], None))
            if v["status"] not in ("VALIDATED", "APPROVED"):
                self.event(run, "problem", f"Akọwe's checks refused the {label}", record_id=rid,
                           code="CHECKS_REFUSED")
                raise self._refused(head["ref"], label, problems(v), chapter_id)
            probs = precheck(rid) if precheck else []
            if probs:  # e.g. ★ an outline without the main character: refused like Akọwe's own checks
                self.event(run, "problem", f"Akọwe's checks refused the {label}: " + "; ".join(probs)[:300],
                           record_id=rid, code="PROTAGONIST_MISSING")
                raise self._refused(head["ref"], label, probs, chapter_id)
            st["message"] = f"AI is reviewing the {label}"
            run["phase"] = st["message"]
            self.save(run)
            job = self._job(run, "review", head["module_id"])
            # The reviewer is chosen automatically: a working AI other than the one that wrote the draft (P3.1),
            # even when the run writes with the one AI the author picked.
            rj = ReviewJob("review", run["principal"], run["project_id"], run["branch_id"], [rid], None)
            for k in ("started", "status", "retry_busy", "check", "on_wait"):
                setattr(rj, k, getattr(job, k))
            editor_next = head["module_id"] == "C02" and self._editor_settings(run).get("enabled") and \
                self._on(run, "editor")
            what = the(ai_activity.nice(label))
            # 🔎 PR #117: a chapter is reviewed by both AIs that did not write it (cross_check.py)
            two = head["module_id"] == "C02" and cross_check.setting_of(run) != "one"
            try:
                with ai_activity.doing(f"Reviewing {what}", done=f"Reviewed {what}"):
                    res = self._review.review_one(rj, rid, auto=not editor_next and not two)
                if two:
                    res = cross_check.second_review(self, run, rj, rid, res, label, auto=not editor_next)
            except AkoweError as exc:
                self._ai_problem(exc, f"reviewing the {label}", record_id=rid, chapter_id=chapter_id)
            verdict = res["review"]["verdict"]
            self._note_review(run, st, label, res["review"])
            # 📊 who said what about this version (settled into each AI's track record when it is approved)
            checker_record.remember_verdicts(run, rid, int(res.get("version") or head["version"]), head["module_id"],
                                             res["review"], self.app.engine.providers)
            cross_check.note_reviewers(self, run, res["review"], two)
            self.event(run, "review", f"AI review of the {label}: {verdict} · {st['review_note']}", verdict=verdict,
                       slot=rj.slot, record_id=rid, independent=res["review"].get("independent"))
            if res.get("auto_approved"):
                self.event(run, "approve", f"{label}: approved by your standing auto-approve setting",
                           approval="standing_auto_approve", record_id=rid)
                head = bp.rec(rid)
                # H14: the editor and the plan check were skipped: they still run, as notes
                approval_trust.note(self.store, run["project_id"], run["branch_id"], head, how="auto_approve",
                                    label=label, chapter_id=chapter_id, by=run["principal"])
                checker_record.settle(self.store, run, rid, head["version"], chapter_id=chapter_id)
                self._notes_after_approval(run, st, rid, label, chapter_id)
                return bp.rec(rid)
            head = bp.rec(rid)
            trust = approval_trust.problem(res["review"], label, res["review"].get("writer_ai")) \
                if verdict == "APPROVE" else None
            if trust:
                trust = dict(trust, ai=res["review"].get("writer_ai"))
            if trust and trust["code"] == "NO_SECOND_AI" and not run.get("self_review_ok"):
                # PR #122: only one AI works. The run's setting decides (single_ai): keep going and list the chapter
                # for the author's check later (default), wait for a second AI, or ask the author now.
                mode = single_ai_mode(run)
                if mode == "wait" and self._wait_for_second_ai(run, st, label, res["review"]):
                    continue  # a second AI works again: it reviews this draft
                if mode == "continue":
                    trust = dict(trust, later=True)
            if trust and not (trust["code"] == "NO_SECOND_AI" and (run.get("self_review_ok") or trust.get("later"))):
                # H6: no self-approval, no approval without a reason or with low confidence: the author decides
                self.event(run, "problem", trust["message"], record_id=rid, code=trust["code"])
                raise StepProblem(trust["code"], trust["message"], trust["fix"], record_id=rid,
                                  version=head["version"], module_id=head["module_id"], verdict=verdict,
                                  reasons=(res["review"].get("reasons") or [])[:4], chapter_id=chapter_id,
                                  options=["approve_anyway", "retry"], no_second_check=True)
            if verdict == "APPROVE":
                (run.get("review_trail") or {}).pop(rid, None)
                why = f"AI review: APPROVE ({label})"
                if trust and trust.get("later"):
                    why += " · ⚠️ only the AI that wrote it checked it (no second AI was working) — needs your check later"
                elif trust:
                    why += " · ⚠️ only the AI that wrote it checked it (you allowed this for the run)"
                if editor_next:
                    head = self._editor_pass(run, st, rid, label, chapter_id)
                    ed = (run.get("editor") or {}).get(rid) or {}
                    why += " · editor: " + ("PASS" if ed.get("verdict") == "PASS" and not ed.get("flagged") else
                                            "still had notes (rounds used up or rewrite not kept)" if ed.get("flagged")
                                            else "not run")
                if head["module_id"] == "C02" and self._on(run, "planned"):
                    head = self._planned_pass(run, st, rid, label, chapter_id)
                    pl = (run.get("planned") or {}).get(rid) or {}
                    if pl.get("flagged"):
                        why += " · ⚠️ planned details not all on the page"
                self._approve(run, head["ref"], why=why, verdict="APPROVE", slot=rj.slot)
                checker_record.settle(self.store, run, rid, head["version"], chapter_id=chapter_id)
                if trust:
                    approval_trust.note(self.store, run["project_id"], run["branch_id"], head,
                                        how="self_review_later" if trust.get("later") else "self_review",
                                        label=label, chapter_id=chapter_id, by=run["principal"])
                    if trust.get("later"):
                        later = run.setdefault("check_later", [])
                        if label not in later:
                            later.append(label)
                        self.event(run, "note", f"⚠️ {label}: only {trust.get('ai') or 'one AI'} is working, so it "
                                   "approved its own draft — needs your check later (listed on the book's home page "
                                   "and in the book report)", record_id=rid, code="NEEDS_CHECK_LATER")
                else:
                    approval_trust.forget(self.store, run["project_id"], run["branch_id"], rid)
                return bp.rec(rid)
            if self._realign_subject(run, bp, head, label, res["review"].get("reasons") or []):
                continue  # reviewed again with the canon's ID; no AI fix used up
            loop = self._loop_decision(run, head, label, res["review"], chapter_id)
            from . import story_doctor  # noqa: PLC0415 - 🩺 the plan's quality gate (take_objections)
            if loop is not None:  # 🔁 going round in circles (or an approved fact would change): the author decides
                if loop.problem.get("code") == "DOCTOR_TAKES":  # 🩺 the story doctor takes the objections
                    took = story_doctor.take_objections(self, run, st, head, label, res["review"],
                                                        loop.problem.get("kind"))
                    if took is not None:
                        return took
                else:
                    raise loop
            n = int(counts.get(rid, 0))
            if n >= MAX_FIXES and head["module_id"] in ("B03", "B11"):
                took = story_doctor.take_objections(self, run, st, head, label, res["review"], None)  # 🩺
                if took is not None:
                    return took
            if n >= MAX_FIXES:
                reasons = res["review"].get("reasons") or []
                raise StepProblem("REVIEW_NOT_PASSED",
                                  f"The AI reviewer still says {verdict} for the {label} after {MAX_FIXES} fixes.",
                                  "Decide: ✔ Approve anyway (your own approval), ✏️ Edit it yourself and then press "
                                  "Continue, or 🔁 Try again (the AI gets two more fixes).",
                                  record_id=rid, version=head["version"], module_id=head["module_id"],
                                  verdict=verdict, reasons=reasons[:4], chapter_id=chapter_id,
                                  options=["approve_anyway", "edit", "retry"],
                                  # 🧑‍⚖️ Akọwe's own promise checks flagged it: only the author decides (stand_in.py)
                                  promise={"pov_tense": bool(res["review"].get("pov_tense")),
                                           "content_limits": bool(res["review"].get("content_limits_breach"))})
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
                with ai_activity.doing(f"Fixing {what} (fix {n + 1} of {MAX_FIXES})",
                                       done=f"Fixed {what} (fix {n + 1} of {MAX_FIXES})"):
                    self._review._run_fix(fj)
                self.event(run, "fix_done", f"The AI made a new version of the {label}", record_id=rid)
            except AkoweError as exc:
                if exc.code in ("TIMEOUT",) or exc.code in BUSY_CODES or exc.code == "CAPABILITY_UNAVAILABLE":
                    self._ai_problem(exc, f"fixing the {label}", record_id=rid, chapter_id=chapter_id)
                self.event(run, "fix_failed", f"The AI's fix of the {label} did not pass Akọwe's checks; "
                                              "nothing was saved", code=exc.code, record_id=rid)
            self.save(run)

    def _loop_decision(self, run, head, label: str, review: dict, chapter_id: str | None) -> StepProblem | None:
        """🔁 Loop detection (review_loop.py). Remembers each record's last review; when the same finding comes back
        REVISE right after a fix that was meant to answer it, or the reviewer says only an APPROVED / LOCKED fact
        elsewhere could fix it, returns ONE specific decision for the author (StepProblem REVIEW_DECISION) instead of
        more fix rounds. The record stays unapproved until the author chooses. None: carry on with the usual loop."""
        rid = head["record_id"]
        trail = run.setdefault("review_trail", {})
        prev = trail.get(rid) if isinstance(trail.get(rid), dict) else None
        trail[rid] = {"version": head["version"], "verdict": review.get("verdict"),
                      "review": {k: review.get(k) for k in ("reasons", "suggested_changes", "canon_change")
                                 if review.get(k)}}
        if review.get("pov_tense") or review.get("content_limits_breach"):
            return None  # Akọwe's own promise checks (H3 / H10): not a disagreement — the usual fixes, then you decide
        prev_data, match, kind = None, None, None
        names = [str(f.get("value")) for f in (head.get("data") or {}).get("facts") or []
                 if isinstance(f, dict) and f.get("predicate") == "entity.name" and isinstance(f.get("value"), str)]
        ignore = review_loop.tokens(" ".join(names[:4] + [safe_title(self.app.engine.contracts, head)]))
        if prev and prev.get("verdict") in ("REVISE", "REJECT") and int(prev.get("version") or 0) < head["version"]:
            try:
                old = self.store.get_record(run["project_id"], run["branch_id"], rid, int(prev["version"]))
            except Exception:  # noqa: BLE001 - no earlier version: no loop to detect
                old = None
            prev_data = (old or {}).get("data") if old else None
            if prev_data is not None:
                match = review_loop.same_finding(prev.get("review"), review, prev_data, head.get("data"), ignore)
                kind = "loop" if match else None
        if kind is None and review.get("canon_change"):
            kind = "canon"
        if kind is None:
            return None
        from . import story_doctor  # noqa: PLC0415
        if story_doctor.can_take(self, run, head, review, kind):  # 🩺 the doctor takes it: nobody is asked
            return StepProblem("DOCTOR_TAKES", "", kind=kind)
        subject = self._subject(head, chapter_id)
        d = review_loop.decision(kind=kind, subject=subject, review=review, prev_review=(prev or {}).get("review"),
                                 match=match, prev_data=prev_data, cur_data=head.get("data"),
                                 can_keep=prev_data is not None, ignore=ignore)
        self.event(run, "problem", f"🔁 The {label}: the AI reviewer and the writer went round in circles — asking you"
                   if kind == "loop" else f"🔁 The {label}: fixing it would change an approved fact — asking you",
                   record_id=rid, code="REVIEW_LOOP" if kind == "loop" else "CANON_CHANGE")
        what = d["change"]
        rows = review.get("reviewers") if isinstance(review.get("reviewers"), list) else \
            [{"slot": review.get("slot"), "verdict": review.get("verdict")}]
        prov = self.app.engine.providers
        parties = {"writer_slot": review.get("writer_slot"),  # 🧑‍⚖️ who disagrees (stand_in.py never asks them)
                   "writer": checker_record.family_of_slot(prov, review.get("writer_slot")),
                   "reviewer_slots": [r.get("slot") for r in rows if r.get("slot") and r.get("verdict") != "APPROVE"],
                   "reviewers": sorted({checker_record.family_of_slot(prov, r.get("slot")) for r in rows
                                        if r.get("slot") and r.get("verdict") != "APPROVE"} - {None})}
        msg = (f"{subject}: the AI reviewer keeps asking for the same change, and the fix did not settle it."
               if kind == "loop" else f"{subject}: fixing it would change an approved fact.")
        return StepProblem(
            "REVIEW_DECISION", msg,
            "Pick one: accept the change, keep the original, or edit it yourself. The book carries on after you "
            "choose. Until then it is not approved.",
            record_id=rid, version=head["version"], module_id=head["module_id"], chapter_id=chapter_id,
            verdict=review.get("verdict"), reasons=(review.get("reasons") or [])[:4], options=d["options"],
            decision=dict(d, change=what), subject=subject, parties=parties,
            prev_version=int(prev["version"]) if prev_data is not None else None)

    def _subject(self, head: dict | None, chapter_id: str | None = None) -> str:
        """'Ansel Marrant (character)', 'Chapter 3', 'the main plot' — what a decision is about, in plain words."""
        if chapter_id:
            return alerts_mod.chapter_words(chapter_id)
        if not head:
            return "a draft"
        title = safe_title(self.app.engine.contracts, head)
        kind = alerts_mod.KIND_WORD.get(head.get("module_id") or "")
        return f"{title} ({kind})" if kind and kind not in title.lower() else title

    def _realign_subject(self, run, bp, head, label: str, reasons) -> bool:
        """The reviewer asks a Set A entry to use the ID the canon already gives this person ("silas-rook", not
        "silas-rook-2"). The AI fix cannot change that ID (Akọwe gave it), so Akọwe puts the canon's ID in itself
        (a new draft version) and the entry is reviewed again. False when that is not the case or the save failed."""
        if not head["module_id"].startswith("A"):
            return False
        try:
            data = assist_mod.realign_subject(self._engine.store, run["project_id"], run["branch_id"], head, reasons)
        except Exception:  # noqa: BLE001 - best effort; the normal AI fix still runs
            log.exception("could not check the subject ID of %s", head.get("record_id"))
            return False
        if data is None:
            return False
        old = chars_mod._name_and_subject(head)[1]  # noqa: SLF001
        new = chars_mod._name_and_subject(dict(head, data=data))[1]  # noqa: SLF001
        resp = bp.dispatch(head["module_id"], "UPDATE", base_ref=head["ref"], payload=data)
        if resp["status"] != "DRAFT" or not resp.get("output_refs"):
            return False
        self.event(run, "fix_done", f"Akọwe changed the ID of the {label} from “{old}” to “{new}”, the ID the book "
                                    "already uses for it; the AI reviews it again", record_id=head["record_id"])
        self.save(run)
        return True

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
        rj.run_settings = run.get("settings") or {}  # 📏 e.g. the length guard of the rewrites (length_guard.py)
        return rj

    # ------------------------------------------------------------------ H14: approved without checks -> notes
    def _flush_notes_due(self, run, st):
        for rid, d in list((run.get("notes_due") or {}).items()):
            self._notes_after_approval(run, st, rid, d.get("label") or "draft", d.get("chapter_id"))

    def _notes_after_approval(self, run, st, rid: str, label: str, chapter_id: str | None):
        """A draft approved anyway / by the standing auto-approve skipped the editor and the plan check: they still
        run now, as notes only (nothing is rewritten — it is already approved). The outcome is stored with the
        "approved without checks" entry (book report, Book home) and said in the run. Never blocks the book."""
        due = run.setdefault("notes_due", {}).pop(rid, None) or {}
        bp = self.bp(run)
        head = bp.rec(rid)
        if head is None:
            return
        notes = {}
        craft = None
        es = self._editor_settings(run)
        if head["module_id"] in ("C02", "B01", "B03", "B11") and es.get("enabled") and self._on(run, "editor"):
            st["message"] = f"The editor reads the {label} (as notes: it is already approved)"
            run["phase"] = st["message"]
            self.save(run)
            what = the(ai_activity.nice(label))
            try:
                with ai_activity.doing(f"Editor reading {what} (notes only)", done=f"Editor read {what}"):
                    craft = self._review.editor.craft_one(self._sub_job(run, "editor", rid), rid)
                notes["editor"] = (f"{craft['verdict']} · {craft['counts']['major']} major / "
                                   f"{craft['counts']['minor']} minor note(s)")
            except AkoweError as exc:
                if getattr(exc, "control", False):
                    raise
                notes["editor"] = f"could not read it ({exc.code})"
        if head["module_id"] == "C02" and self._on(run, "planned"):
            what = the(ai_activity.nice(label))
            try:
                with ai_activity.doing(f"Checking {what} against its plan", done=f"Checked {what} against its plan"):
                    res = self._review.planned.check(self._sub_job(run, "planned_check", rid), rid, round_no=0)
                missing = [i for i in res["items"] if i.get("required") and i["status"] != "on_page"]
                notes["planned"] = ("every planned detail is on the page" if not missing else
                                    "missing: " + "; ".join(clip_words(i["label"], 60) for i in missing[:3])
                                    + (" …" if len(missing) > 3 else ""))
            except AkoweError as exc:
                if getattr(exc, "control", False):
                    raise
                notes["planned"] = f"could not check it ({exc.code})"
        if due.get("approved_anyway") and head["module_id"] == "C02" and chapter_id:
            # 🔁 approved although the reviewer had not passed it: its major notes (and the reviewer's reasons) are
            # kept for the final improve pass instead of being dropped (improve_pass.py)
            from . import improve_pass  # noqa: PLC0415
            fs = [f for f in (craft or {}).get("findings") or [] if f.get("severity") == "major"]
            fs += [{"id": f"r{i + 1}", "dimension": "review", "passage": "", "why": r} for i, r in
                   enumerate(due.get("reasons") or [])]
            if fs:
                n = improve_pass.queue(self.store, run["project_id"], run["branch_id"], chapter_id, head, fs,
                                       "approved_anyway")
                notes["improve"] = f"{n} note(s) kept for the final improve pass"
                self.event(run, "note", f"🔁 The {label}: {n} note(s) are kept for the final improve pass",
                           code="IMPROVE_QUEUED", record_id=rid)
        approval_trust.add_notes(self.store, run["project_id"], run["branch_id"], rid, notes)
        self.event(run, "note", f"⚠️ The {label} was approved without checks; checked afterwards as notes — "
                   + ("; ".join(f"{k}: {v}" for k, v in notes.items()) or "nothing to check"),
                   code="APPROVED_WITHOUT_CHECKS", record_id=rid)
        self.save(run)

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
                self._must_fix_left(ed, head)
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
                if craft.get("independent") is not False:  # 📊 the editor's notes held up: its rewrite made it better
                    checker_record.note(self.store, checker_record.family_of_slot(
                        self.app.engine.providers, craft.get("slot")), "style", "confirmed")
                self._made(run, self.bp(run).rec(rid)["ref"])
                self.event(run, "editor", f"Editor's rewrite of the {label} kept (round {n}): {why}", record_id=rid,
                           code="EDITOR_REWRITE_KEPT")
                craft = new_craft
                continue
            ed["rejected"] = int(ed.get("rejected", 0)) + 1
            try:
                ref = self._review.editor.restore(run["principal"], run["project_id"], run["branch_id"], rid, old, code)
                self._made(run, ref)
            except AkoweError as exc:
                raise StepProblem(exc.code, f"The editor's rewrite of the {label} was not good enough and the earlier "
                                  "text could not be put back.", "Press 🔁 Try again.", record_id=rid,
                                  chapter_id=chapter_id) from None
            self.event(run, "note", f"⚠️ The editor's rewrite of the {label} was not kept (round {n}): {why}; the "
                       "earlier text is used", code="EDITOR_REWRITE_REJECTED", record_id=rid)
            return self._editor_flag(run, st, ed, craft, self.bp(run).rec(rid), f"rewrite not kept — {why}",
                                     "EDITOR_NOTES")

    def _craft(self, run, st, rid, label, ed, round_no, prev=None):
        st["message"] = f"The editor is reading the {label}" + (f" again (after round {round_no})" if round_no else "")
        run["phase"] = st["message"]
        self.save(run)
        rj = self._sub_job(run, "editor", rid)
        what = the(ai_activity.nice(label))
        try:
            with ai_activity.doing(f"Editor reading {what}" + (f" again (after round {round_no})" if round_no else ""),
                                   done=f"Editor read {what}"):
                craft = self._review.editor.craft_one(rj, rid, round_no=round_no, prev=prev)
        except AkoweError as exc:
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
        if craft.get("must_fix") and not (ed.get("must_fix") or {}).get("targets_list"):
            ed["must_fix"] = {"targets_list": craft["must_fix"], "targets": len(craft["must_fix"]), "remained": None}
        cal = craft.get("calibration") or {}
        ed["calibration"] = {"flagged": bool(cal.get("flagged")), "reasked": cal.get("reasked", 0),
                             "two": bool(cal.get("two_reviewers"))}
        if cal.get("flagged") or cal.get("reasked"):  # P36: never let a too-clean review pass silently
            self.event(run, "note", f"{'⚠️ ' if cal.get('flagged') else ''}Editor on the {label}: "
                       + " ".join(cal.get("notes") or [])[:380], code="EDITOR_UNTRUSTED" if cal.get("flagged")
                       else "EDITOR_REASKED", record_id=rid)
        st["editor_note"] = self._editor_line(ed)
        self.save(run)
        return craft

    def _editor_rewrite(self, run, rid, label, craft, ed, n):
        """The writer rewrites only the flagged passages; applied exactly through the normal UPDATE. Returns
        (applied [with their passages], the old revision) or None (nothing could be applied; noted)."""
        editor = self._review.editor
        old = self.bp(run).rec(rid)
        rj = self._sub_job(run, "editor_fix", rid, run["settings"].get("slot_id"))
        what = the(ai_activity.nice(label))
        total = int(self._editor_settings(run).get("rounds") or 0)
        try:
            with ai_activity.doing(f"Editing {what} (round {n}" + (f" of {total})" if total else ")"),
                                   done=f"Edited {what} (round {n})"):
                prop = editor.propose(rj, rid, craft=craft)
        except AkoweError as exc:
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
        except AkoweError as exc:
            ed["flag_reason"] = f"the rewritten chapter was refused ({exc.code})"
            self.event(run, "note", f"⚠️ The rewritten {label} did not pass Akọwe's checks, so it was not saved",
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
        """Check the rewrite like a new draft: Akọwe's checks, the consistency reviewer, the pattern checker and
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
                with ai_activity.doing(f"Reviewing the rewritten {ai_activity.nice(label)}",
                                       done=f"Reviewed the rewritten {ai_activity.nice(label)}"):
                    res = self._review.review_one(rj, rid, auto=False)
                cons = res["review"]["verdict"]
                self._note_review(run, st, label, res["review"])
            except AkoweError as exc:
                self.event(run, "note", f"⚠️ The rewritten {label} could not be reviewed ({exc.code})",
                           code="EDITOR_FAILED", record_id=rid)
            if cons == "APPROVE":
                new_craft = self._craft(run, st, rid, label, ed, n, prev=old_craft)
        old_text = str((old.get("data") or {}).get("text") or "")
        new_text = str((self.bp(run).rec(rid).get("data") or {}).get("text") or "")
        lost = lost_keeps(old_text, new_text, keep_quotes_of(old_craft, old_text))
        ok, code, why = judge_rewrite(old_craft, new_craft, consistency=cons, checks_ok=checks_ok, keep_lost=lost,
                                      applied=applied, new_text=new_text, old_text=old_text)  # ✨ #20
        return ok, code, why, new_craft

    def _editor_flag(self, run, st, ed, craft, head, why: str, code: str) -> dict:
        notes = []
        for f in (craft or {}).get("findings") or []:
            notes.append({"id": f["id"], "label": f.get("label"), "severity": f.get("severity"),
                          "why": clip_words(f.get("why"), 200), "passage": clip_words(f.get("passage"), 80)})
        ed.update(flagged=True, done_version=head["version"], notes=notes[:6], flag_reason=why, code=code)
        self._must_fix_left(ed, head)
        self.event(run, "note", f"⚠️ Editor still had notes on the {ed.get('label')} ({why}); it is approved under "
                   "your run consent — see the run summary", code="EDITOR_NOTES", record_id=head["record_id"])
        st["editor_note"] = self._editor_line(ed)
        self._editor_summary(run)
        self.save(run)
        return head

    @staticmethod
    def _must_fix_left(ed: dict, head: dict | None) -> None:
        """🔁 PR #117 (F): how many of the must-fix habits (2+ checks flagged them) are still in the chapter."""
        mf = ed.get("must_fix") or {}
        if not mf.get("targets_list") or not head:
            return
        from . import habits  # noqa: PLC0415
        try:
            res = habits.remaining(str((head.get("data") or {}).get("text") or ""), mf["targets_list"])
            mf.update(targets=res["targets"], remained=res["remained"], items=res["items"])
        except Exception:  # noqa: BLE001
            log.exception("could not count the must-fix habits left")

    @staticmethod
    def _editor_line(ed: dict) -> str:
        bits = [f"editor: {ed.get('verdict') or '…'}"]
        if ed.get("avg_score") is not None:
            bits.append(f"avg {ed['avg_score']}, lowest {ed.get('min_score')}")
        if ed.get("rounds"):
            bits.append(f"{ed['rounds']} rewrite round(s)")
        if ed.get("reviewer"):
            bits.append(f"by {ed['reviewer']}")
        mf = ed.get("must_fix") or {}
        if mf.get("targets"):
            bits.append(f"{mf['targets']} must-fix habit(s), {mf.get('remained', 0)} still there")
        cal = ed.get("calibration") or {}
        if cal.get("flagged"):
            bits.append("⚠️ review too clean to trust (capped)")
        elif cal.get("reasked"):
            bits.append("asked again for proof")
        return " · ".join(bits) + (" ⚠️ still had notes" if ed.get("flagged") else "")

    def _editor_summary(self, run):
        eds = list((run.get("editor") or {}).values())
        run["editor_summary"] = {
            "reviewed": sum(1 for e in eds if e.get("history")), "passed": sum(1 for e in eds if e.get("verdict") ==
                                                                               "PASS" and not e.get("flagged")),
            "rounds": sum(int(e.get("rounds") or 0) for e in eds), "kept": sum(int(e.get("kept") or 0) for e in eds),
            "rejected": sum(int(e.get("rejected") or 0) for e in eds),
            "must_fix": sum(int((e.get("must_fix") or {}).get("targets") or 0) for e in eds),
            "must_fix_left": sum(int((e.get("must_fix") or {}).get("remained") or 0) for e in eds),
            "flagged": [{"chapter_id": e.get("chapter_id"), "label": e.get("label"), "reason": e.get("flag_reason"),
                         "notes": e.get("notes") or []} for e in eds if e.get("flagged")],
            "settings": run.get("editor_settings")}

    # ------------------------------------------------------------------ ✅ planned-to-page check inside a run (P11)
    def _planned_pass(self, run, st, rid: str, label: str, chapter_id: str | None) -> dict:
        what = the(ai_activity.nice(label))
        with ai_activity.doing(f"Checking {what} against its plan", done=f"Checked {what} against its plan"):
            return self._planned_work(run, st, rid, label, chapter_id)

    def _planned_work(self, run, st, rid: str, label: str, chapter_id: str | None) -> dict:
        """After the editor: did what was planned reach the page? Deterministic check, then one independent AI check
        of what is unclear or missing; missing items go to the writer as targeted findings (P5 machinery) for at
        most ``planned.ROUNDS`` round(s); the fix is kept only if Akọwe's checks and the consistency reviewer
        pass it and fewer items are missing, else the earlier text is put back. Never blocks the book: what is still
        missing is flagged ⚠️ (PLANNED_MISSING) and listed in the run summary. Returns the head revision."""
        bp = self.bp(run)
        head = bp.rec(rid)
        pl = run.setdefault("planned", {}).setdefault(rid, {"chapter_id": chapter_id, "label": label, "rounds": 0,
                                                            "history": []})
        if pl.get("done_version") == head["version"]:
            return head
        checker = self._review.planned
        st["message"] = f"Checking that the plan of the {label} reached the page"
        run["phase"] = st["message"]
        self.save(run)
        try:
            res = checker.check(self._sub_job(run, "planned_check", rid), rid, round_no=pl["rounds"])
        except AkoweError as exc:
            if exc.code == "TIMEOUT" or exc.code in BUSY_CODES or exc.code == "CAPABILITY_UNAVAILABLE":
                self._ai_problem(exc, f"checking the planned details of the {label}", record_id=rid,
                                 chapter_id=chapter_id)
            pl.update(error=exc.code, done_version=head["version"])
            self.event(run, "note", f"⚠️ The planned-to-page check of the {label} did not work ({exc.code}); the book "
                       "goes on", code="PLANNED_CHECK_FAILED", record_id=rid)
            self._planned_summary(run)
            self.save(run)
            return head
        # Settings › Editor › rounds 0 means "notes only": then the planned items are only flagged, not rewritten.
        es = self._editor_settings(run)
        max_rounds = 0 if es.get("enabled") and int(es.get("rounds") or 0) == 0 else planned_mod.ROUNDS
        while self._open(res) and pl["rounds"] < max_rounds:
            pl["rounds"] += 1
            n = pl["rounds"]
            old = bp.rec(rid)
            st["message"] = f"The writer is working the missing planned details into the {label}"
            run["phase"] = st["message"]
            self.save(run)
            try:
                prop = checker.propose_fix(self._sub_job(run, "planned_fix", rid, run["settings"].get("slot_id")),
                                           rid, res)
            except AkoweError as exc:
                if exc.code == "TIMEOUT" or exc.code in BUSY_CODES or exc.code == "CAPABILITY_UNAVAILABLE":
                    self._ai_problem(exc, f"working the planned details into the {label}", record_id=rid,
                                     chapter_id=chapter_id)
                pl["history"].append({"round": n, "fix": "failed", "code": exc.code, "at": now_iso()})
                break
            if not prop["applied"]:
                pl["history"].append({"round": n, "fix": "nothing applied", "at": now_iso()})
                self.event(run, "note", f"⚠️ None of the writer's changes for the planned details of the {label} "
                           "matched the text word for word; nothing was guessed", code="PLANNED_UNRESOLVED",
                           record_id=rid)
                break
            try:
                self._review.editor.apply(run["principal"], run["project_id"], run["branch_id"], rid, old["version"],
                                          None, proposal=prop, round_no=n, how="run")
            except AkoweError as exc:
                pl["history"].append({"round": n, "fix": "refused", "code": exc.code, "at": now_iso()})
                break
            new = bp.rec(rid)
            v = bp.dispatch(new["module_id"], "VALIDATE", base_ref=new["ref"],
                            payload=candidate_payload(new["ref"], None))
            cons, new_res = None, None
            if v["status"] in ("VALIDATED", "APPROVED"):
                try:
                    r2 = self._review.review_one(self._sub_job(run, "review", rid), rid, auto=False)
                    cons = r2["review"]["verdict"]
                    self._note_review(run, st, label, r2["review"])
                    if cons == "APPROVE":
                        new_res = checker.check(self._sub_job(run, "planned_check", rid), rid, round_no=n)
                except AkoweError as exc:
                    if exc.code == "TIMEOUT" or exc.code in BUSY_CODES:
                        self._ai_problem(exc, f"checking the reworked {label}", record_id=rid, chapter_id=chapter_id)
                    cons = cons or f"failed ({exc.code})"
            ok = new_res is not None and self._open(new_res) < self._open(res)
            pl["history"].append({"round": n, "fix": "kept" if ok else "not kept", "applied": prop["applied"],
                                  "consistency": cons, "at": now_iso()})
            if ok:
                res = new_res
                self._made(run, bp.rec(rid)["ref"])
                pl["fixed"] = int(pl.get("fixed") or 0) + 1
                self.event(run, "planned", f"Planned details worked into the {label} (round {n}): "
                           f"{prop['applied']} passage(s) changed", record_id=rid, code="PLANNED_FIX_KEPT")
                continue
            try:
                ref = self._review.editor.restore(run["principal"], run["project_id"], run["branch_id"], rid, old,
                                                  "PLANNED_FIX")
                self._made(run, ref)
            except AkoweError as exc:
                raise StepProblem(exc.code, f"The fix for the planned details of the {label} was not good enough and "
                                  "the earlier text could not be put back.", "Press 🔁 Try again.", record_id=rid,
                                  chapter_id=chapter_id) from None
            self.event(run, "note", f"⚠️ The fix for the planned details of the {label} was not kept (consistency: "
                       f"{cons or 'not reviewed'}); the earlier text is used", code="PLANNED_FIX_REJECTED",
                       record_id=rid)
            break
        head = bp.rec(rid)
        missing = [i for i in res["items"] if i.get("required") and i["status"] != "on_page"]
        pl.update(done_version=head["version"], counts=res["counts"], flagged=bool(missing),
                  missing=[clip_words(i["label"], 160) for i in missing][:8], ai=bool(res.get("ai")))
        if missing:
            self.event(run, "note", f"⚠️ Planned but not on the page in the {label}: "
                       + "; ".join(clip_words(i["label"], 80) for i in missing[:4]) + (" …" if len(missing) > 4 else ""),
                       code="PLANNED_MISSING", record_id=rid)
        st["planned_note"] = self._planned_line(run)
        self._planned_summary(run)
        self.save(run)
        return head

    @staticmethod
    def _open(res: dict) -> int:
        return int(res["counts"]["missing"]) + int(res["counts"]["unclear"])

    @staticmethod
    def _planned_line(run) -> str:
        ps = run.get("planned") or {}
        fl = sum(1 for p in ps.values() if p.get("flagged"))
        return f"planned on the page: {len(ps) - fl} of {len(ps)} chapter(s) complete" + (
            f" ⚠️ {fl} with missing items" if fl else "")

    def _planned_summary(self, run):
        ps = list((run.get("planned") or {}).values())
        old = run.get("planned_summary") or {}
        run["planned_summary"] = {
            "checked": sum(1 for p in ps if p.get("done_version")), "fixed": sum(int(p.get("fixed") or 0) for p in ps),
            "flagged": [{"chapter_id": p.get("chapter_id"), "label": p.get("label"), "missing": p.get("missing") or []}
                        for p in ps if p.get("flagged")], "book": old.get("book")}

    def _s_planned(self, run, st):
        """The whole book before it is put together: a report (never blocks the book)."""
        try:
            res = self._review.planned.book(run["principal"], run["project_id"], run["branch_id"])
        except Exception as exc:  # noqa: BLE001 - a report must never stop the book
            log.exception("planned-to-page book check failed")
            st["message"] = f"⚠️ The check could not run ({type(exc).__name__}); the book goes on"
            self.event(run, "note", st["message"], step="planned", code="PLANNED_CHECK_FAILED")
            return
        self._planned_summary(run)
        run["planned_summary"]["book"] = {"missing": res["counts"]["missing"], "names": res["names_never_on_page"],
                                          "items": [{"chapter_id": m["chapter_id"], "label": clip_words(m["label"], 160)}
                                                    for m in res["missing"]][:20]}
        st["items"] = [{"id": r["chapter_id"], "label": f"Chapter {r['chapter_id']}",
                        "state": "done" if r.get("written") and not (r.get("counts") or {}).get("missing") else
                        "failed" if r.get("written") else "pending",
                        "note": f"{(r.get('counts') or {}).get('missing', 0)} planned item(s) missing"
                        if r.get("written") and (r.get("counts") or {}).get("missing") else ""}
                       for r in res["chapters"]]
        n = res["counts"]["missing"]
        if n:
            st["message"] = f"⚠️ {n} planned item(s) are not on the page — see the list; the book goes on"
            self.event(run, "note", st["message"] + (": names never on the page: " + ", ".join(
                res["names_never_on_page"]) if res["names_never_on_page"] else ""), step="planned",
                code="PLANNED_MISSING")
        else:
            st["message"] = "Everything planned is on the page"
        self._facts_report(run, st)

    def _facts_report(self, run, st):
        """🔎 P26/P30/P31 (fact_checks.py): timeline, trade facts (found terms are added as "research needed" — a run
        never verifies one) and repeats to trim, as ⚠️ notes. A report: it never blocks the book."""
        from . import fact_checks  # noqa: PLC0415
        try:
            fs = fact_checks.run_book_check(self._review, run["principal"], run["project_id"], run["branch_id"])
        except Exception as exc:  # noqa: BLE001 - a report must never stop the book
            log.exception("fact checks failed")
            self.event(run, "note", f"⚠️ The fact checks could not run ({type(exc).__name__}); the book goes on",
                       step="planned", code="FACTS_CHECK_FAILED")
            return
        run["facts_summary"] = {k: v for k, v in fs.items() if k != "notes"}
        run["facts_summary"]["notes"] = [{"code": c, "message": m} for c, m in fs.get("notes") or []]
        for code, msg in fs.get("notes") or []:
            self.event(run, "note", msg, step="planned", code=code)
        if any(c != "REPEATS_TO_TRIM" for c, _m in fs.get("notes") or []):
            st["message"] = (st.get("message") or "") + " · ⚠️ fact checks have notes"

    # ------------------------------------------------------------------ 📏 story rules and 🧺 world texture (P9/P10)
    def _s_world(self, run, st):
        """Draft the story-rules ledger and the world-texture list (once; the author's own lists are kept). Never
        blocks the book: a failure is ⚠️ (RULES_FAILED / TEXTURE_FAILED); only TIMEOUT / a busy or missing AI
        pause the step."""
        bp = self.bp(run)
        pid, branch = run["project_id"], run["branch_id"]
        if run["settings"].get("bible") and not run.get("bible_world_seeded"):
            self._seed_world(run)
        parts = (("rules", "Story rules", story_rules.get_entry, story_rules.generate, "RULES_FAILED"),
                 ("texture", "World texture", texture_mod.get_entry, texture_mod.generate, "TEXTURE_FAILED"))
        items = {i["id"]: i for i in st.get("items") or []}
        st["items"] = [items.get(k) or {"id": k, "label": label, "state": "pending"} for k, label, *_ in parts]
        for item, (k, label, get, gen, code) in zip(st["items"], parts):
            self.check(run)
            if get(self.store, pid, branch):
                if item["state"] != "done":
                    item.update(state="done", note="made earlier")
                continue
            item["state"] = "running"
            st["message"] = f"The AI is writing the {label.lower()}"
            run["phase"] = st["message"]
            self.save(run)
            rj = self._sub_job(run, f"world_{k}", k, run["settings"].get("slot_id"))
            try:
                e = gen(self._assist, rj, bp)
            except AkoweError as exc:
                if exc.code == "TIMEOUT" or exc.code in BUSY_CODES or exc.code == "CAPABILITY_UNAVAILABLE":
                    item["state"] = "paused"
                    self._ai_problem(exc, f"writing the {label.lower()}")
                item.update(state="failed", note=exc.code)
                self.event(run, "note", f"⚠️ The {label.lower()} could not be made ({exc.code}); the book goes on — "
                           "make it on the book's 🌍 World rules page", code=code)
                self.save(run)
                continue
            n = len(e.get("rules") or e.get("items") or [])
            item.update(state="done", note=f"{n} made")
            self.event(run, "world", f"The AI wrote the {label.lower()} ({n})", slot=rj.slot)
            self.save(run)
        ok = [i["label"] for i in st["items"] if i["state"] == "done"]
        st["message"] = (", ".join(ok) + " ready") if ok else "⚠️ Neither could be made (the book goes on)"
        self._bound_special(run, st)

    def _update_rules(self, run, st):
        """After the plan is approved: the AI suggests updates of the story rules for it; they are accepted under the
        run consent (bounded: one AI call). Never blocks the book."""
        pid, branch = run["project_id"], run["branch_id"]
        if not self._on(run, "rules"):
            return
        entry = story_rules.get_entry(self.store, pid, branch)
        bp = self.bp(run)
        if not entry or not story_rules.changed_since(entry, story_rules.basis(bp)):
            return
        st["message"] = "The AI is updating the story rules for the plan"
        run["phase"] = st["message"]
        self.save(run)
        rj = self._sub_job(run, "world_rules", "rules", run["settings"].get("slot_id"))
        try:
            e = story_rules.generate(self._assist, rj, bp, update=True)
        except AkoweError as exc:
            if exc.code == "TIMEOUT" or exc.code in BUSY_CODES or exc.code == "CAPABILITY_UNAVAILABLE":
                self._ai_problem(exc, "updating the story rules for the plan")
            self.event(run, "note", f"⚠️ The story rules could not be updated for the plan ({exc.code}); the book goes "
                       "on with the earlier rules", code="RULES_FAILED")
            return
        items = (e.get("proposals") or {}).get("items") or []
        if not items:
            self.event(run, "world", "The story rules already fit the plan (no change)")
            return
        self._check_consent(run, pid)
        e = story_rules.decide_proposals(self.store, pid, branch, accept=None, version=e["version"], by="ai",
                                         run_id=run["id"])
        self.event(run, "world", f"Story rules updated for the plan: {len(items)} suggestion(s) accepted under your "
                   f"Make-a-book-for-me consent, run {run['id']}", approval="run_consent", slot=rj.slot)
        self._bound_special(run, st)

    def _bound_special(self, run, st):
        """📏 Every special mechanism (a ghost, magic, a curse, a strange device) needs scope, cost and limits: rules
        that lack one are bounded by ONE AI update, accepted under the run consent (at most twice per run: after the
        first rules and after the plan). Never blocks the book."""
        pid, branch = run["project_id"], run["branch_id"]
        if not self._on(run, "rules"):
            return
        entry = story_rules.get_entry(self.store, pid, branch)
        todo = story_rules.special_unbounded(entry)
        mem = run.setdefault("special_rules", {"asked": 0})
        mem["open"] = len(todo)
        if not todo or int(mem.get("asked") or 0) >= 2:
            return
        mem["asked"] = int(mem.get("asked") or 0) + 1
        st["message"] = f"The AI gives {len(todo)} special rule(s) their scope, cost and limits"
        run["phase"] = st["message"]
        self.save(run)
        rj = self._sub_job(run, "world_rules", "rules", run["settings"].get("slot_id"))
        try:
            e = story_rules.generate(self._assist, rj, self.bp(run), update=True, note=story_rules.bound_note(todo))
        except AkoweError as exc:
            if getattr(exc, "control", False):
                raise
            self.event(run, "note", f"⚠️ {len(todo)} special rule(s) still have no scope, cost or limits ({exc.code}); "
                       "add them on the 📏 Story rules page", code="RULES_UNBOUNDED")
            return
        items = (e.get("proposals") or {}).get("items") or []
        if items:
            self._check_consent(run, pid)
            story_rules.decide_proposals(self.store, pid, branch, accept=None, version=e["version"], by="ai",
                                         run_id=run["id"])
        left = story_rules.special_unbounded(story_rules.get_entry(self.store, pid, branch))
        mem.update(open=len(left), bounded=len(todo) - len(left))
        self.event(run, "world", f"📏 Special rules bounded: {len(todo) - len(left)} of {len(todo)} now state scope, "
                   "cost and limits" + (f" — ⚠️ {len(left)} still open (📏 Story rules page)" if left else ""),
                   approval="run_consent" if items else None, slot=rj.slot,
                   code="RULES_UNBOUNDED" if left else "RULES_BOUNDED")

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

    def _ai_problem(self, exc: AkoweError, what: str, **extra):
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
            # The book's id comes from the run's id, so an Akọwe stop between creating the book and saving the
            # run finds that book again on Resume instead of making a second one.
            pid = "proj-" + run["id"].split("-", 1)[-1]
            if self.store.project(pid) is None:
                extra = {"variant_of": s["variant_of"]["project_id"]} if s.get("variant_of") else {}
                self._engine.bootstrap_project(run["principal"], NEW_BOOK_NAME, project_id=pid,
                                               settings=dict({"made_by_run": run["id"]}, **extra),
                                               features={"character_arcs": False}, release_profiles=list(RELEASE))
                self.event(run, "project", "A new, separate book was created (your other books are not touched)")
            run["project_id"] = pid
            self.save(run)
        pid = run["project_id"]
        if pipeline_mod.info_of(self.store, pid) is None:  # P14: the book remembers the switches it was made with
            pipeline_mod.save(self.store, pid, s.get("pipeline") or pipeline_mod.clean(None), run_id=run["id"],
                              variant_of=(s.get("variant_of") or {}).get("project_id"))
        if s.get("my_style") and not run.get("style_applied"):  # P25 (Section 7c): write in the author's style
            self._apply_style(run, pid)
        if not get_profile(self.store, pid).get("length"):
            first = {"length": s["length"], "chapters": CHAPTERS_FOR[s["length"]], "ai_slot": s.get("slot_id") or "",
                     "genre": s.get("genre") or ""}
            if s.get("choices"):
                first["choices"] = s["choices"]
            save_profile(self.store, pid, first)
        if s.get("variant_of") and not get_profile(self.store, pid).get("idea"):
            # P14: a variant is the same book (profile, idea, choices) made again with other pipeline switches
            src = get_profile(self.store, s["variant_of"]["project_id"])
            copy_ = {k: str(src.get(k) or "")[:n] for k, n in (("title", 200), ("author", 200), ("genre", 120),
                                                                ("audience", 120), ("tone", 200), ("idea", 4000))
                     if src.get(k)}
            if not copy_.get("title"):
                copy_["title"] = "Untitled book"
            copy_["author"] = self._pen_name(run, pid, s, carried=copy_.get("author"))
            pre = (s.get("pipeline") or {}).get("preset") or "full"
            with self.store.transaction():
                save_profile(self.store, pid, copy_)
                self._name_book(pid, f"{copy_['title']} (variant: {pre})"[:200])
            self.event(run, "project", f"Variant of “{copy_['title']}”: the same profile, idea and choices, made with "
                       f"{pipeline_mod.describe(s.get('pipeline')).lower()}")
        if s.get("bible") and not get_profile(self.store, pid).get("idea"):
            # P21 🔁: the same book profile as the saved book bible (its title, author, idea …)
            b = self._bible_of(run) or {}
            bp_ = dict(b.get("profile") or {})
            bp_.pop("ai_slot", None)
            bp_["title"] = str(bp_.get("title") or s["bible"].get("title") or "Untitled book")[:200]
            bp_["idea"] = str(bp_.get("idea") or bp_["title"])[:4000]
            bp_["author"] = self._pen_name(run, pid, s, carried=bp_.get("author"))
            if b.get("choices"):
                bp_["choices"] = b["choices"]
            with self.store.transaction():
                save_profile(self.store, pid, bp_)
                with self.store.transaction() as tx:
                    tx.execute("UPDATE projects SET name=? WHERE project_id=? AND name=?",
                               (bp_['title'][:200] if s.get("sequel") else f"{bp_['title']} (rerun)"[:200], pid,
                                NEW_BOOK_NAME))
            self.event(run, "project", f"🔁 The book profile of “{bp_['title']}” was taken from the saved book bible "
                       "(a new, separate book)")
        if s.get("sequel") and not run.get("sequel_registered"):
            from . import series as series_mod  # noqa: PLC0415
            series_mod.register_sequel(self.store, s["sequel"], pid, run["branch_id"])
            run["sequel_registered"] = True
            self.save(run)
        prof = book_profile_brief(self.store, pid)
        if prof.get("title") and prof.get("idea"):
            self._name_book(pid, prof["title"])  # a stop between saving the profile and naming the book
            run["title"] = prof["title"]
            st["message"] = f"“{prof['title']}”"
            self._auto_voice(run, pid)  # ✍ the book's own narrator voice (no AI here: from its profile)
            return
        wishes = {"length": LENGTHS[s["length"]][0]}
        if s.get("genre"):
            wishes["genre"] = s["genre"]
        if s.get("idea"):
            wishes["idea"] = s["idea"]
        if s.get("locks"):  # 📋 6c: the starter sheet's lock list (facts that must stay true)
            wishes["must_stay_true"] = list(s["locks"])
        job = self._job(run, "profile", "B01")
        st["message"] = "The AI is inventing your book"
        self.save(run)
        from . import story_kind  # noqa: PLC0415 - 📚 "Let the AI decide": the AI picks the kind of story too
        pick = story_kind.pick_wanted(self.store, pid)
        schema, task = PROFILE_SCHEMA, PROFILE_TASK
        context = {"wishes": wishes, "lengths": {k: v[0] for k, v in LENGTHS.items()}}
        if pick:
            schema = dict(PROFILE_SCHEMA, properties=dict(PROFILE_SCHEMA["properties"], **story_kind.pick_schema()))
            task = PROFILE_TASK.replace(" Return only the JSON object.", story_kind.PICK_TASK
                                        + " Return only the JSON object.")
            context["story_kinds"] = story_kind.pick_options()
        from . import fresh_names  # noqa: PLC0415 - 🔁 what the author's recent books used (unless typed now)
        fresh = fresh_names.profile_task(self, run, wishes)
        if fresh:
            task = task.replace(" Return only the JSON object.", fresh + " Return only the JSON object.")
        if self._wants_voice(pid):  # ✍ the narrator voice is folded into this first AI call (human_voice.py)
            from . import human_voice  # noqa: PLC0415
            schema = dict(schema, properties=dict(schema["properties"], narrator_voice=human_voice.VOICE_FIELD))
            task = task.replace(" Return only the JSON object.", human_voice.VOICE_TASK + " Return only the JSON object.")
        try:
            raw = self._assist._call_ai(job, op_for_roles="B01", task=task, schema=schema, context=context,
                                        protected=[])
        except AkoweError as exc:
            self._ai_problem(exc, "inventing the book")
        raw = raw if isinstance(raw, dict) else {}
        prof = {k: str(raw.get(k) or "").strip() for k in ("title", "genre", "audience", "tone", "idea")}
        if s.get("genre"):
            prof["genre"] = s["genre"]
        prof["title"] = prof["title"][:200] or "Untitled book"
        # ✒️ the pen name is never the AI's: what the author typed (this run, or the book profile), else their saved
        # pen name, else empty (pen_name.py). An AI's "author" in its answer is ignored.
        prof["author"] = self._pen_name(run, pid, s)
        prof["idea"] = (prof["idea"] or s.get("idea") or prof["title"])[:4000]
        for k, n in (("genre", 120), ("audience", 120), ("tone", 200)):
            prof[k] = prof[k][:n]
        # H10: point of view and tense are decided now (the AI's choice, else the genre's default), never left open
        from . import book_promises  # noqa: PLC0415
        old = get_profile(self.store, pid)
        dec = book_promises.decide({"genre": prof["genre"], "pov": old.get("pov") or raw.get("point_of_view"),
                                    "tense": old.get("tense") or raw.get("tense")})
        prof["pov"], prof["tense"] = dec["pov"], dec["tense"]
        with self.store.transaction():  # the profile and the book's name are saved together
            save_profile(self.store, pid, prof)
            self._name_book(pid, prof["title"])
        run["title"] = prof["title"]
        st["message"] = f"“{prof['title']}”" + (f" by {prof['author']}" if prof["author"] else "") \
            + f" ({prof['genre'] or 'any genre'}; told in the " \
                        f"{book_promises.POV_WORDS[dec['pov']]}, {dec['tense']} tense)"
        self.event(run, "ai", f"The AI invented the book “{prof['title']}”", slot=job.slot)
        fresh_names.after_profile(self, run, st)  # 🔁 a repeated title word or name -> one rename (no AI to find)
        self._auto_voice(run, pid, raw.get("narrator_voice"))
        if pick:
            try:
                kid = story_kind.record_pick(self.store, pid, raw)
            except AkoweError:
                kid = ""
            if kid:
                why = str(raw.get("story_kind_why") or "").strip()
                st["message"] += f"; kind of story: {story_kind.label_of(kid)} (picked by the AI)"
                self.event(run, "note", f"📚 Kind of story: {story_kind.label_of(kid)} — picked by the AI"
                           + (f": {why[:200]}" if why else ""), step="profile", code="KIND_PICKED")

    def _wants_voice(self, pid) -> bool:
        """✍ The book has no style of the author's (no card applied): it gets its own narrator voice."""
        from . import style_card  # noqa: PLC0415
        e = style_card.book_entry(self.store, pid)
        return not (e and not e.get("auto"))

    def _auto_voice(self, run, pid, raw=None):
        """✍ Without a style card, a distinct narrator voice for this book (the AI's, from the first call, else derived
        from the genre, tone, point of view, tense and story choices), stored like the style card's snapshot (auto) so
        the writer and the editor get it. Never stops the run."""
        if run.get("voice_set") or not self._wants_voice(pid):
            return
        from . import human_voice  # noqa: PLC0415
        try:
            prof = get_profile(self.store, pid)
            voice, source = human_voice.clean_voice(raw), "ai"
            if voice is None:
                voice, source = human_voice.derive_voice(prof, prof.get("choices") or (run.get("settings") or {})
                                                         .get("choices")), "profile"
            entry = human_voice.set_auto(self.store, pid, voice, source=source, profile=prof)
        except Exception:  # noqa: BLE001
            log.exception("could not set the narrator voice in run %s", run["id"])
            entry = None
        run["voice_set"] = True
        if entry:
            self.event(run, "note", "✍ This book has its own narrator voice: " + str(entry["brief"].get("voice_summary")
                       or "")[:200] + " (✒️ My writing style can replace it with your own)", step="profile",
                       code="VOICE_SET")

    def _series_changes(self, run):
        """📚 A finished book of a series: the AI proposes what changed for each character in it (proposals only —
        the author approves them in the Book Bible). Never stops or fails the finished run."""
        from . import series as series_mod  # noqa: PLC0415
        pid, branch = run.get("project_id"), run.get("branch_id") or "main"
        if not pid or series_mod.member(self.store, pid) is None or run.get("series_changes_done"):
            return
        run["series_changes_done"] = True
        try:
            job = self._sub_job(run, "series_changes", pid, run["settings"].get("slot_id"))
            out = series_mod.find_changes(self.app, job, pid, branch, assist=self._assist)
        except (RunPaused, RunCancelled, Cancelled):
            return
        except AkoweError as exc:
            e = exc.errors[0] if exc.errors else {}
            self.event(run, "note", f"📚 What changed for the characters in this book could not be found now "
                       f"({e.get('message') or exc.code}); press ✨ Find what changed in this book in the 📖 Book "
                       "Bible later", code="SERIES_CHANGES_LATER")
            return
        except Exception:  # noqa: BLE001 - the book is made; this is an extra
            log.exception("make-a-book run %s: series changes", run.get("id"))
            return
        if out["proposed"] or out.get("things_proposed"):
            who = " and ".join(([f"{out['proposed']} character(s)"] if out["proposed"] else []) +
                               ([f"{out['things_proposed']} place(s), item(s) or group(s)"]
                                if out.get("things_proposed") else []))
            self.event(run, "note", f"📚 The AI proposed what changed for {who} in this book. "
                       "Open the 📖 Book Bible → 📚 Series to read and ✔ approve them (nothing is used before you do)",
                       code="SERIES_CHANGES_PROPOSED")

    def _pen_name(self, run, pid: str, s: dict, carried=None) -> str:
        """✒️ The new book's pen name: typed for this run, else already in its profile (typed by the author), else
        ``carried`` (the source book's, for a variant or a rerun from a book bible), else the author's saved pen name,
        else ''. Never an AI's. A pen name that is also a character's name (this book or another on the shelf) gets a
        ⚠️ note: it is kept only when the author typed it for this run, else left out."""
        from . import pen_name  # noqa: PLC0415
        typed = pen_name.clean(s.get("pen_name")) or pen_name.clean(get_profile(self.store, pid).get("author"))
        name, how = pen_name.for_new_book(self.store, typed)
        if how != "typed" and pen_name.clean(carried):
            name, how = pen_name.clean(carried), "carried"
        warn = pen_name.warning(self.store, pid, name) if name else None
        if warn:
            if how != "typed":
                self.event(run, "note", f"{warn} Akọwe left the pen name empty for this book.", step="profile",
                           code="PEN_NAME_IS_CHARACTER")
                return ""
            self.event(run, "note", warn, step="profile", code="PEN_NAME_IS_CHARACTER")
        return name

    def _name_book(self, pid: str, title: str):
        with self.store.transaction() as tx:
            tx.execute("UPDATE projects SET name=? WHERE project_id=? AND name=?", (title, pid, NEW_BOOK_NAME))

    def _s_canon(self, run, st):
        if run["settings"].get("bible") and not run.get("bible_seeded"):
            self._seed_canon(run, st)  # P21 🔁: the saved characters, places and world, as drafts of this book
        if run["settings"].get("sequel") and run.get("bible_seeded") and not run.get("sequel_linked"):
            from . import series as series_mod  # noqa: PLC0415 - 📚 the sequel's characters = the series' people
            n = series_mod.link_sequel(self.store, run["settings"]["sequel"], run["project_id"], run["branch_id"],
                                       run.get("bible_map") or {})
            run["sequel_linked"] = True
            self.event(run, "note", f"📚 {n} character(s) carried over from the book before: their personality, "
                       "voice, name and origin are protected in this book", step="canon", code="SERIES_SEQUEL")
            self.save(run)
        canon_ops = ("A01", "A04", "A03") + tuple(op for op in run.get("bible_ops") or () if op not in
                                                  ("A01", "A04", "A03"))
        counts = CANON_COUNTS[run["settings"]["length"]]
        # Entries Akọwe's checks refused and set aside, per section, that the Bible Builder must make again
        # (older runs: a count per section), and by name (the same character made again, told what was refused:
        # a fresh world sketch would invent a different person, e.g. lose the main character named in the idea).
        remake = run.setdefault("canon_remake", {})
        redo_named = run.setdefault("canon_redo", [])
        made_missing = False  # the missing sections get one Bible Builder pass per step run (never a loop)
        while True:
            bp = self.bp(run)
            have = [r for op in canon_ops for r in bp.heads(op) if not r.get("stale")]
            # Make what is missing: everything on the first pass; after a stop or a refused save only the sections
            # with no entry yet (e.g. the places were saved but no main character), plus the entries set aside
            # because the checks refused them.
            missing = {op: n for op, n in counts.items() if not any(r["module_id"] == op for r in have)}
            if run.get("bible_seeded") and any(r["module_id"] == "A01" for r in have):
                missing = {}  # P21 🔁: the book bible's canon is the book's canon (nothing new is invented)
            want = {} if made_missing else dict(missing or ({} if have else counts))
            for op, n in remake.items():
                want[op] = max(want.get(op, 0), int(n))
            for n in redo_named:  # an entry made again by name takes the place of one the sketch would invent
                if want.get(n["op"]):
                    want[n["op"]] -= 1
            want = {op: n for op, n in want.items() if n > 0}
            if want or redo_named:
                made_missing = made_missing or bool(missing) or not have
                self._bible(run, st, want, named=redo_named, strict=bool(want))
                run["canon_remake"] = remake = {}
                run["canon_redo"] = redo_named = []
                self.save(run)
                bp = self.bp(run)
                have = [r for op in canon_ops for r in bp.heads(op) if not r.get("stale")]
            if not any(r["module_id"] == "A01" for r in have):
                raise StepProblem("INVALID_INPUT", "The AI did not make a main character that Akọwe could save.",
                                  "Press 🔁 Try again (the AI makes new characters).")
            todo = [r for r in have if r["lifecycle"] in REVIEWABLE and r.get("approved_version") != r["version"]
                    and not r.get("stale")]
            todo.sort(key=lambda r: ({"A03": 0, "A04": 1, "A01": 2}.get(r["module_id"], 3), r.get("created_at") or ""))
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
                    old_role = story_roles.stored(chars_mod.get_entry(self.store, run["project_id"],
                                                                      run["branch_id"], r["record_id"]))[0]
                    redo_named.append({"op": redo, "name": (protagonist.record_names(r) or [name])[0][:120],
                                       "details": exc.problem.get("details") or [],
                                       "story_role": old_role if old_role in story_roles.KEYS else ""})
                    break
            if redo is None:
                break
            self.save(run)
        self._ensure_main(run, st)  # (b) the main character named in the idea / proposed as main is approved canon
        self._settle_cast(run)  # every character a story role, exactly one ★ protagonist
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
            except AkoweError as exc:
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
        msg = f"{ok} of {len(people)} character(s) have a sheet and a voice card" + (
            f" ({made} made now)" if made else "") + (f" · ⚠️ {failed} could not be made" if failed else "")
        from . import voice_contrast  # noqa: PLC0415 - 🗣 the cards must really differ (≤ 1 AI answer, only if not)
        voice_contrast.run_check(self, run, st)
        vc = (run.get("voice_contrast") or {}).get("line")
        st["message"] = msg + (f" · {vc}" if vc else "")

    def _s_looks(self, run, st):
        """⏱ Essentials only, before chapter one (story_details.py). Never blocks the book."""
        from . import story_details  # noqa: PLC0415
        story_details.essentials_step(self, run, st)

    def _s_pictures(self, run, st):
        """🖼 A portrait for every character, the full set for the ★ protagonist (book_pictures.py). Never blocks
        the book: what cannot be made now goes on the book's to-make list (only pause / cancel stop it)."""
        from . import book_pictures  # noqa: PLC0415
        from . import claude_code_speed  # noqa: PLC0415 - 🤖 Step 2: made in the background, the book goes on
        if claude_code_speed.pictures_in_background(self, run, st):
            return
        try:
            book_pictures.run_step(self, run, st)
        except (RunPaused, RunCancelled, Cancelled):
            raise
        except Exception as exc:  # noqa: BLE001 - pictures never stop the book
            log.exception("make-a-book run %s: character pictures", run["id"])
            st["message"] = f"⚠️ The pictures could not be made now ({type(exc).__name__}); make them later with 🖼 " \
                            "Make the rest of the pictures in the Book Bible"
            self.event(run, "note", st["message"], step="pictures", code="PICTURES_WAITING")

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
            if not scenes_mod.usable(entry, outline):  # 🤖 Step 2: planned early by a helper, facts unchanged
                from . import claude_code_speed  # noqa: PLC0415
                entry = claude_code_speed.use_prepared(self, run, outline, cid, label) or entry
            if not scenes_mod.usable(entry, outline):
                st["message"] = f"The AI is planning the scenes of {label}"
                item["phase"] = "planning scenes"
                run["phase"] = st["message"]
                self.save(run)
                rj = self._sub_job(run, "scenes", cid, run["settings"].get("slot_id"))
                with ai_activity.doing(f"Planning scenes for {ai_activity.nice(label)}",
                                       done=f"Planned the scenes of {ai_activity.nice(label)}"):
                    entry = planner.make(rj, cid)
                self.event(run, "scenes", f"The AI planned {len(entry['cards'])} scene(s) for {label}", slot=rj.slot)
            while True:
                self.check(run)
                st["message"] = f"An AI is checking the scenes of {label}"
                item["phase"] = "checking scenes"
                run["phase"] = st["message"]
                self.save(run)
                cj = self._sub_job(run, "scenes_check", cid)
                with ai_activity.doing(f"Checking the scenes of {ai_activity.nice(label)}",
                                       done=f"Checked the scenes of {ai_activity.nice(label)}"):
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
                with ai_activity.doing(f"Reworking the scenes of {ai_activity.nice(label)} ({n + 1} of {MAX_FIXES})",
                                       done=f"Reworked the scenes of {ai_activity.nice(label)}"):
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
        except AkoweError as exc:
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

    def _bible_session(self, run) -> BibleSession:
        prof = book_profile_brief(self.store, run["project_id"])
        sess = BibleSession(self._assist, run["principal"], run["project_id"], run["branch_id"],
                            prof.get("idea") or prof.get("title") or "a new book", run["settings"].get("slot_id"))
        sess._check_cancel = lambda: self.check(run)  # type: ignore[method-assign]
        from . import fresh_names  # noqa: PLC0415 - 🔁 the cast's names: not the recent books' (fresh_names.py)
        sess.fresh = fresh_names.sketch_hook(self, run)
        orig_job = sess._job

        def hooked_job(op_id, slot):
            j = orig_job(op_id, slot)
            j.retry_busy = True
            j.on_wait = lambda info: self.on_wait(run, info)
            return j
        sess._job = hooked_job  # type: ignore[method-assign]
        return sess

    def _bible(self, run, st, counts, named=None, strict: bool = True) -> dict:
        """The Bible Builder inside a run: a world sketch for ``counts`` plus the ``named`` entries (a name already
        decided: the main character, or an entry Akọwe refused that the AI makes again under the same name).
        An entry Akọwe's checks refuse (its form, or the save) is made again with the exact problems, at most
        MAX_FIXES times; what still fails is named in an event (never dropped silently). Returns {created, dropped}."""
        sess = self._bible_session(run)
        slot = run["settings"].get("slot_id")
        sess.current = {"run": 1, "t0": time.time(), "phase": "Starting"}
        st["message"] = "The AI is sketching the characters and places" if counts else \
            "The AI is making the " + ", ".join(f"entry “{n['name']}”" for n in named or [])[:200]
        self.save(run)
        if counts:
            sess._run_sections({"run": 1, "sections": dict(counts), "slot": slot, "guidance": None})
        notes = {}
        for n in named or []:
            self.check(run)
            key = sess.add_named(n["op"], n["name"], n.get("role") or "", story_role=n.get("story_role") or "")
            notes[key] = self._named_note(n)
            sess._generate_item(sess.items[key], slot, notes[key])
        sess.current = None
        self.check(run)  # a pause/cancel during the Bible Builder stops here (items are made again on resume)
        self._fix_refused_items(run, sess, slot, notes)
        items = [sess.items[k] for k in sess.order]
        errs = [i.get("error") or {} for i in items if i["status"] == "error"]
        run_err = (sess.runs[-1].get("error") if sess.runs else None) or {}
        codes = {e.get("code") for e in errs} | ({run_err.get("code")} if run_err else set())
        good = [i["key"] for i in items if i["status"] == "done" and i.get("valid") is not False
                and not sess.refusals(i)]
        # A main character is required when this pass makes characters; a pass that only makes again a refused
        # place or group needs at least one usable entry.
        need = (lambda k: sess.items[k]["op"] == "A01") if "A01" in counts else (lambda k: True)
        self._note_mains(run, sess)
        if not any(need(k) for k in good):
            if "TIMEOUT" in codes:
                raise StepProblem("TIMEOUT", "The AI did not answer in time while making the characters.", TIMEOUT_FIX)
            busy = codes & set(BUSY_CODES)
            if busy:
                raise StepProblem(sorted(busy)[0], "The AI stayed busy while making the characters.", BUSY_FIX)
            if strict:
                refused = [sess.refusals(i) for i in items if sess.refusals(i)]
                msg = (run_err.get("message") or (errs[0].get("message") if errs else None) or
                       ("Akọwe's checks refused them: " + "; ".join(digest(refused[0], 3)) if refused else
                        "the AI's characters did not fit Akọwe's forms"))
                raise StepProblem(run_err.get("code") or (errs[0].get("code") if errs else None) or "INVALID_INPUT",
                                  f"The characters could not be made: {msg}", "Press 🔁 Try again.")
        out = sess.create(good, {}) if good else {"created": [], "errors": []}
        out = self._fix_create_errors(run, sess, slot, notes, out)
        for c in out["created"]:
            self._made(run, c["ref"])
        for note in sess.role_notes:  # ★ the AI gave several protagonists: who stays the one, and why
            self.event(run, "note", note, code="PROTAGONIST_SET")
        sess.role_notes = []
        txt = story_roles.event_text(sess.roles or {})
        if txt:
            self.event(run, "note", txt, record_id=(sess.roles or {}).get("protagonist"), code="PROTAGONIST_SET")
        if out["created"]:
            self.event(run, "ai", f"The AI drafted {len(out['created'])} character/place entries (Character & place maker)",
                       slot=sess.runs[-1].get("slot") if sess.runs else None)
        made = {c["key"] for c in out["created"]}
        dropped = {}
        for it in items:
            if it["key"] in made or it.get("created_ref"):
                continue
            why = sess.refusals(it) or ([f"{it['create_error']['code']}: {it['create_error']['message']}"]
                                        if it.get("create_error") else []) or \
                ([f"{(it.get('error') or {}).get('code')}: {(it.get('error') or {}).get('message')}"]
                 if it.get("error") else ["no usable entry"])
            dropped[it["key"]] = {"op": it["op"], "name": it["name"], "details": digest(why)}
            self.event(run, "note", f"⚠️ The entry “{it['name']}” could not be made: Akọwe's checks refused it — "
                       + "; ".join(digest(why, 3))[:300] + ". The run goes on without it"
                       + (" (Akọwe checks the main characters before the outline)." if it["op"] == "A01" else "."),
                       code="CANON_ENTRY_REFUSED")
        return {"created": out["created"], "dropped": dropped}

    @staticmethod
    def _named_note(n: dict) -> str:
        note = (protagonist.main_note(n["name"], n.get("why") or protagonist.IDEA_WHY,
                                      n.get("story_role", "protagonist")) if n.get("main") else
                f"Make the entry “{n['name']}” again: keep exactly this name and its role in the story.")
        if n.get("details"):
            note += (" Akọwe's checks refused the earlier entry: " + "; ".join(n["details"][:6])
                     + ". Fix exactly these problems.")
        return note

    @staticmethod
    def _fix_note(base: str | None, probs: list) -> str:
        return ((base + " ") if base else "") + ("Akọwe's checks refused your previous proposal of this entry: "
                                                 + "; ".join(str(p)[:300] for p in probs[:8]) + ". Keep the same "
                                                 "name and role and return a corrected complete entry that fixes "
                                                 "exactly these problems.")

    @staticmethod
    def _retryable(it: dict) -> list[str]:
        """An AI answer that failed for a reason the AI can fix (not a timeout, a busy AI or a missing AI)."""
        e = it.get("error") or {}
        if it.get("status") != "error" or not e.get("code") or e["code"] in ("TIMEOUT", "CANCELLED",
                                                                             "CAPABILITY_UNAVAILABLE") \
                or e["code"] in BUSY_CODES:
            return []
        return [f"{e['code']}: {e.get('message') or ''}"]

    def _fix_refused_items(self, run, sess, slot, notes: dict):
        """(a) Entries whose proposal Akọwe refuses are made again with the exact problems (max MAX_FIXES)."""
        for key in list(sess.order):
            it = sess.items[key]
            for n in range(MAX_FIXES):
                probs = sess.refusals(it) or self._retryable(it)
                if not probs:
                    break
                self.check(run)
                self.event(run, "fix", f"Akọwe's checks refused the proposed entry “{it['name']}”; asked the AI "
                           f"to make it again ({n + 1} of {MAX_FIXES}): " + "; ".join(digest(probs, 3))[:300],
                           code="CANON_ENTRY_REFUSED")
                st_msg = f"The AI is making the entry “{it['name']}” again ({n + 1} of {MAX_FIXES})"
                run["phase"] = st_msg
                self.save(run)
                sess._generate_item(it, slot, self._fix_note(notes.get(key), probs))
        self.check(run)

    def _fix_create_errors(self, run, sess, slot, notes: dict, out: dict) -> dict:
        """(a) An entry Akọwe refused to save is made again with the save's exact problem (max MAX_FIXES)."""
        created, errors = list(out.get("created") or []), list(out.get("errors") or [])
        for n in range(MAX_FIXES):
            retry = [e for e in errors if e.get("key") in sess.items and e.get("code") != "MISSING_INPUT"]
            if not retry:
                break
            errors = [e for e in errors if e not in retry]
            again = []
            for e in retry:
                it = sess.items[e["key"]]
                probs = [f"{e.get('code')}: {e.get('message')}" + (f" (at {e['path']})" if e.get("path") else "")]
                self.check(run)
                self.event(run, "fix", f"Akọwe refused to save the entry “{it['name']}”; asked the AI to make it "
                           f"again ({n + 1} of {MAX_FIXES}): " + "; ".join(probs)[:300], code="CANON_ENTRY_REFUSED")
                self.save(run)
                sess._generate_item(it, slot, self._fix_note(notes.get(e["key"]), probs))
                left = sess.refusals(it) or self._retryable(it)
                if it["status"] == "done" and not left:
                    again.append(e["key"])
                elif left:
                    it["create_error"] = dict(key=e["key"], code="CHECKS_REFUSED", message="; ".join(left)[:500])
                    errors.append(it["create_error"])
            if again:
                o2 = sess.create(again, {})
                created += o2["created"]
                errors += o2["errors"]
        self.check(run)
        return {"created": created, "errors": errors}

    def _note_mains(self, run, sess):
        """Remember the characters the Bible Builder proposed as main (character sheet role "main"), made or not."""
        mains = run.setdefault("main_names", [])
        for k in sess.order:
            it = sess.items[k]
            sheet = ((it.get("companion") or {}).get("character_sheet") or {})
            main = sheet.get("story_role") == story_roles.PROTAGONIST or it.get("story_role") == \
                story_roles.PROTAGONIST or (not sheet.get("story_role") and sheet.get("role") == "main")
            if it["op"] == "A01" and main and not it.get("placeholder") and it["name"] not in mains:
                mains.append(it["name"][:120])
        del mains[8:]

    # ------------------------------------------------------------------ ★ story roles: exactly one protagonist
    def _settle_cast(self, run) -> dict | None:
        """Every character gets a story role and the book exactly one protagonist (stored by record ID, so a later
        spelling correction or rename keeps it). Deterministic; a plain event says who and why when it decided."""
        try:
            res = story_roles.enforce(self.store, run["project_id"], run["branch_id"])
        except Exception:  # noqa: BLE001 - roles never stop the book
            log.exception("make-a-book run %s: could not settle the story roles", run["id"])
            return None
        text = story_roles.event_text(res)
        if text:
            self.event(run, "note", text, record_id=res["protagonist"], code="PROTAGONIST_SET")
        run["protagonist"] = {"record_id": res["protagonist"], "name": res["name"]} if res["protagonist"] else None
        return res

    def _guard_main(self, run, st, where: str):
        """★ The guard (before the outline, before writing chapters, before the whole-book review): the main
        character is approved canon and has a chapter in the outline. Missing from the canon -> made now (the
        protagonist re-make path); missing from the outline -> PROTAGONIST_MISSING (the outline step redoes an AI
        outline before it gets here)."""
        self._settle_cast(run)
        chk = protagonist.check(self.bp(run))
        if chk["ok"]:
            return chk
        prot = chk.get("protagonist")
        if not chk.get("in_canon"):
            if prot is None:
                self._ensure_main(run, st)
            else:
                draft = next((r for r in self.bp(run).heads("A01") if r["record_id"] == prot["record_id"]
                              and r["lifecycle"] in ("DRAFT", "VALIDATED") and not r.get("stale")), None)
                self._make_main(run, st, {"name": prot["name"], "why": protagonist.MAIN_WHY, "refused": [],
                                          "draft": draft["ref"] if draft else None})
            self._settle_cast(run)
            chk = protagonist.check(self.bp(run))
            if chk["ok"]:
                return chk
            prot = chk.get("protagonist")
        if prot is None:
            raise StepProblem("PROTAGONIST_MISSING", f"The book has no main character {where}.",
                              "Open the book, make a character (Characters and places) and mark it ★ the main "
                              "character, then press ▶ Resume.", options=["retry"])
        name = prot["name"]
        self.event(run, "problem", f"⚠️ {chk['problem'][0].upper()}{chk['problem'][1:]} {where}",
                   record_id=prot["record_id"], code="PROTAGONIST_MISSING")
        raise StepProblem("PROTAGONIST_MISSING",
                          f"The main character “{name}” is missing {where}: {chk['problem']}.",
                          f"Open the chapter outline and give “{name}” chapters (as viewpoint), or mark another "
                          "character ★ the main character on its page; then press 🔁 Try again.",
                          character=name, options=["retry"])

    def _guarantee_main(self, run, st, where: str) -> dict:
        """★ The guarantee (before the chapters are written, and again before the book is marked done): exactly one
        protagonist, an approved A01 entry, given chapters by the outline and named in every chapter brief. What is
        wrong is repaired here (the main character the idea names / the Bible Builder proposed is made with the
        guided make-the-main-character path; the ★ tag is put back by the deterministic cast); only what cannot be
        repaired pauses the run with a plain-words decision (PROTAGONIST_MISSING). A plain event says the result
        either way (PROTAGONIST_OK)."""
        before = (run.get("protagonist") or {}).get("record_id")
        self._ensure_main(run, st)  # the idea's / proposed main character is approved canon (made now if not)
        chk = self._guard_main(run, st, where)  # one ★, approved, in the outline — else made / paused
        pid, branch = run["project_id"], run["branch_id"]
        prot = chk.get("protagonist") or {}
        tagged = story_roles.tagged_protagonist(self.store, pid, branch)
        claims = self._protagonist_claims(run)
        repaired = []
        if tagged != prot.get("record_id") or claims > 1:
            self._settle_cast(run)  # exactly one stored ★, on the cast's protagonist
            repaired.append("the ★ main-character tag was put back")
            tagged = story_roles.tagged_protagonist(self.store, pid, branch)
        if tagged != prot.get("record_id"):
            self._no_star(prot, where)
        bp = self.bp(run)
        outline = bp.outline()
        chapters = bp.outline_chapters(outline) if outline else []
        from . import chapter_brief  # noqa: PLC0415
        no_brief = [c["chapter_id"] for c in chapters
                    if chapter_brief.build(self.store, pid, branch, outline, c["chapter_id"])[1].get("protagonist")
                    != prot.get("record_id")]
        if no_brief:
            self._no_star(prot, where, f"the writing brief of chapter(s) {', '.join(no_brief[:6])} does not name them")
        hits = protagonist.in_outline(outline, prot, chars_mod.canon_characters(self.store, pid, branch),
                                      alias_map=story_roles.aliases(self.store, pid, branch)) if outline else []
        if before and before != prot.get("record_id"):
            repaired.append("the main character's entry was made again")
        self.event(run, "note", f"★ Main character check {where}: “{prot.get('name')}” is the book's one main "
                   f"character — an approved character, in {len(hits)} of {len(chapters)} chapter(s) of the outline "
                   "and named in every chapter brief" + (f" ({'; '.join(repaired)})" if repaired else ""),
                   record_id=prot.get("record_id"), code="PROTAGONIST_OK")
        return chk

    def _protagonist_claims(self, run) -> int:
        """How many live characters carry a stored (non-proposed) ★ protagonist tag."""
        live = {c["record_id"] for c in chars_mod.canon_characters(self.store, run["project_id"], run["branch_id"])}
        n = 0
        for rid, e in chars_mod.all_entries(self.store, run["project_id"], run["branch_id"]).items():
            role, by, _at = story_roles.stored(e)
            if rid in live and role == story_roles.PROTAGONIST and by not in story_roles.PROPOSED_BY:
                n += 1
        return n

    @staticmethod
    def _no_star(prot: dict, where: str, why: str | None = None):
        name = prot.get("name") or "the main character"
        raise StepProblem("PROTAGONIST_MISSING",
                          f"The main character “{name}” could not be confirmed {where}: "
                          + (why or "the ★ main-character tag could not be stored on their entry") + ".",
                          f"Open the book, open “{name}” in Characters and places and mark them ★ the main "
                          "character (or mark another character), then press 🔁 Try again.",
                          character=name, options=["retry"])

    def _outline_has_main(self, run, rid: str) -> list[str]:
        """Problems of an outline draft that leaves the main character out (empty when they are in it)."""
        bp = self.bp(run)
        rec = bp.rec(rid)
        prot = story_roles.protagonist_of(self.store, run["project_id"], run["branch_id"])
        if rec is None or prot is None:
            return []
        chars = chars_mod.canon_characters(self.store, run["project_id"], run["branch_id"])
        if protagonist.in_outline(rec, prot, chars, alias_map=story_roles.aliases(self.store, run["project_id"],
                                                                                    run["branch_id"])):
            return []
        return [f"PROTAGONIST_NOT_IN_OUTLINE: no chapter has the main character “{prot['name']}” (canon ID "
                f"'{prot.get('subject_id')}') as plan.pov_id or names them; give them the viewpoint of most chapters"]

    # ------------------------------------------------------------------ (b) the main character is approved canon
    def _ensure_main(self, run, st):
        """Before the outline: every main character (named in the book idea, proposed as main by the Bible Builder,
        or a viewpoint a refused outline needed) is approved canon. One that is not is made now (its draft reviewed,
        or the AI makes the entry with Akọwe's refusals, at most MAX_FIXES times); if that fails the run stops
        here with a plain-English problem naming the character and the reasons (never goes on silently)."""
        bp = self.bp(run)
        for m in protagonist.missing(bp, main_names=run.get("main_names") or (), store=self.store):
            self._make_main(run, st, m)

    @staticmethod
    def _who_word(why: str) -> str:
        return "viewpoint character" if why == protagonist.POV_WHY else "main character"

    def _make_main(self, run, st, m: dict):
        name, why = m["name"], m["why"]
        label = f"entry “{name}”"
        self.event(run, "note", f"⚠️ The {self._who_word(why)} “{name}” ({why}) is not in the approved characters: "
                   "Akọwe makes the entry now", code="PROTAGONIST_MISSING")
        reasons = list(m.get("refused") or [])
        rid = (m.get("draft") or {}).get("record_id")
        tries = 0
        while True:
            self.check(run)
            if rid is None:
                srole = protagonist.role_for_missing(self.bp(run), name, why)
                res = self._bible(run, st, {}, named=[{"op": "A01", "name": name, "why": why, "main": True,
                                                        "story_role": srole, "details": reasons}], strict=False)
                made = [c for c in res["created"] if c["op"] == "A01"]
                if not made:
                    reasons = [d for x in res["dropped"].values() for d in x["details"]] or reasons
                    self._no_main(name, why, reasons)
                rid = made[0]["ref"]["record_id"]
            try:
                self._review_until_approved(run, st, rid, label)
            except ChecksRefused as exc:
                reasons = exc.problem.get("details") or reasons
                rec = self.bp(run).rec(rid)
                if rec is not None and not self._ai_made(run, rec):
                    self._redo_refused(run, st, rid, f"redo:main:{protagonist.slug(name)}", label, exc)  # raises
                tries += 1
                if tries > MAX_FIXES:
                    self._no_main(name, why, reasons)
                if rec is not None:
                    self.bp(run).set_aside(rec, f"Akọwe's checks refused it; the AI makes the {label} again")
                self.event(run, "fix", f"Akọwe's checks refused the {label}; asked the AI to make it again "
                           f"({tries} of {MAX_FIXES}): " + "; ".join(reasons)[:300], record_id=rid,
                           code="CANON_ENTRY_REFUSED")
                rid = None
                continue
            self.event(run, "note", f"✔ The {self._who_word(why)} “{name}” is an approved character now", record_id=rid)
            return

    @staticmethod
    def _no_main(name: str, why: str, reasons: list):
        raise StepProblem("PROTAGONIST_MISSING",
                          f"The main character “{name}” ({why}) is not in the approved characters, and Akọwe "
                          "could not make the entry: " + (("Akọwe's checks refused it — "
                                                           + "; ".join(digest(reasons, 3))[:400]) if reasons else
                                                          "the AI did not make a usable entry")
                          + ". The chapter outline needs this character, so the run stopped here.",
                          f"Press 🔁 Try again: the AI makes the entry “{name}” again and is told exactly what "
                          "Akọwe refused. Or open the book, make the character yourself (Characters and places → "
                          "✍️ Write one myself), approve it, then press ▶ Resume.",
                          details=digest(reasons), character=name, options=["retry"])

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
        """Set an AI draft Akọwe's checks refused aside so the AI writes it again (told what was wrong: the B11
        prompt lists the earlier outline's refusals); after MAX_FIXES attempts the run pauses for the author. The
        author's own version (an edit made while the run was paused) is never set aside: the run pauses for the
        author instead (CHECKS_REFUSED, Edit only), without asking the AI."""
        bp = self.bp(run)
        rec = bp.rec(rid)
        if rec is not None and not self._ai_made(run, rec):
            stale = exc.problem.get("fix") == STALE_FIX
            exc.problem.update(message=exc.problem["message"].replace("Akọwe's checks refused the",
                                                                      "Akọwe's checks refused your edited", 1),
                               fix=AUTHOR_STALE_FIX if stale else AUTHOR_CHECKS_FIX, options=["edit"],
                               authored_by="author")
            self.event(run, "problem", f"Akọwe's checks refused your edited {label}; it is kept for you to fix "
                                       "(the AI was not asked to replace it)", record_id=rid, code="CHECKS_REFUSED")
            raise exc
        counts = run.setdefault("fix_counts", {})
        n = int(counts.get(key, 0))
        if n >= MAX_FIXES:
            exc.problem["message"] += f" The AI wrote it {n + 1} times."
            raise exc
        counts[key] = n + 1
        if rec is not None:
            bp.set_aside(rec, f"Akọwe's checks refused it; the AI writes the {label} again")
        st["message"] = f"The AI is writing the {label} again (attempt {n + 2} of {MAX_FIXES + 1})"
        run["phase"] = st["message"]
        self.event(run, "fix", f"Akọwe's checks refused the {label}; asked the AI to write it again "
                               f"({n + 1} of {MAX_FIXES}): " + "; ".join(exc.problem.get("details") or [])[:300],
                   record_id=rid)
        self.save(run)

    def _planning(self, run, st, op, label, precheck=None, on_refused=None):
        while True:
            bp = self.bp(run)
            if bp.approved(op):
                st["message"] = "Approved"
                return
            drafts = sorted(bp.drafts(op), key=lambda r: r.get("created_at") or "", reverse=True)
            if not drafts:
                rid = self._plan_from_bible(run, st, bp, op, label)  # P21 🔁: the saved premise / plot / outline
                if rid:
                    drafts = [bp.rec(rid)]
            if drafts:
                rid = drafts[0]["record_id"]
            else:
                st["message"] = f"The AI is writing the {label}"
                self.save(run)
                payload = bp.payload_for(op)
                if op == "B03" and run.get("room_plot"):  # 🗳 the writers' room's twist (writers_room.py)
                    from . import writers_room  # noqa: PLC0415
                    payload["constraints"] = list(payload.get("constraints") or []) + writers_room.plot_constraints(run)
                ref = self.ai_create(run, bp, op, payload, label)
                rid = ref["record_id"]
                self._made(run, ref)
                self.event(run, "ai", f"The AI wrote the {label}", record_id=rid, module_id=op)
            try:
                self._review_until_approved(run, st, rid, label, precheck=precheck)
            except ChecksRefused as exc:
                self._redo_refused(run, st, rid, f"redo:{op}", label, exc)
                if on_refused:
                    on_refused()
                continue
            st["message"] = "Written, reviewed and approved"
            return

    # ------------------------------------------------------------------ P21 🔁 seeding a new book from a book bible
    def _bible_refs(self, run) -> dict:
        """old record ID (in the book bible) -> the current reference of the new book's record made from it."""
        out = {}
        bp = self.bp(run)
        for old, new in (run.get("bible_map") or {}).items():
            rec = bp.rec(new)
            if rec:
                out[old] = rec["ref"]
        return out

    def _seed_canon(self, run, st):
        """Create the bible's Set A entries in the new book (drafts; the canon step reviews and approves each one
        under the run consent), with their character sheets and voice cards. Resumable: made entries are remembered."""
        from .book_bible import remap_refs  # noqa: PLC0415
        b = self._bible_of(run) or {}
        order = {"A03": 0, "A04": 1}
        items = sorted(b.get("canon") or [], key=lambda c: order.get(c.get("module_id"), 2)) + list(
            b.get("characters") or [])
        mapping = run.setdefault("bible_map", {})
        refs = self._bible_refs(run)
        made, refused, ops = 0, [], set(run.get("bible_ops") or ())
        st["message"] = "Putting the saved characters and places into the new book"
        self.save(run)
        for it in items:
            self.check(run)
            old, op = it.get("record_id"), it.get("module_id")
            if not old or not op or old in mapping:
                continue
            payload = remap_refs(it.get("data") or {}, refs)
            if not isinstance(payload.get("linked_refs"), list):
                payload["linked_refs"] = []
            bp = self.bp(run)
            try:
                r = bp.dispatch(op, "CREATE", payload=payload)
            except AkoweError as exc:
                r = {"status": "REJECTED", "errors": exc.errors}
            if r.get("status") == "DRAFT" and r.get("output_refs"):
                ref = r["output_refs"][0]
                mapping[old] = ref["record_id"]
                refs[old] = ref
                ops.add(op)
                self._made(run, ref)
                made += 1
                if op == "A01" and (it.get("sheet") or it.get("voice")):
                    try:
                        chars_mod.save_entry(self.store, run["project_id"], run["branch_id"], ref["record_id"],
                                             sheet=it.get("sheet") or {}, voice=it.get("voice") or {}, by="author",
                                             name=it.get("name"))
                    except Exception:  # noqa: BLE001 - the character is there; its sheet can be made again
                        log.exception("could not copy the character sheet of %s", it.get("name"))
                if op == "A01" and it.get("story_role") in story_roles.KEYS:  # ★ the saved story role, kept
                    try:
                        story_roles.set_role(self.store, run["project_id"], run["branch_id"], ref["record_id"],
                                             it["story_role"], by="author", name=it.get("name"), move=False)
                    except Exception:  # noqa: BLE001
                        log.exception("could not copy the story role of %s", it.get("name"))
                if op == "A01" and it.get("forge"):  # 🧬 H7: the Character Forge dossier and its 🔒 locks travel
                    from .book_bible import seed_forge  # noqa: PLC0415
                    seed_forge(self.store, run["project_id"], run["branch_id"], ref["record_id"], it["forge"])
            else:
                refused.append(f"{it.get('name')}: {'; '.join(problems(r)[:2]) or r.get('status')}")
                self._note_refused_main(run, it)
            run["bible_ops"] = sorted(ops)
            self.save(run)
        run["bible_seeded"] = True
        self.event(run, "bible", f"🔁 From the book bible: {made} character/place entr(y/ies) put into the new book as "
                   "drafts (each is reviewed and approved here under your consent for this run)", step="canon")
        if refused:
            self.event(run, "note", "⚠️ Not taken from the book bible (Akọwe's checks refused them; the AI makes "
                       "what is missing): " + " · ".join(refused)[:300], step="canon", code="BIBLE_ENTRY_REFUSED")
        self.save(run)

    @staticmethod
    def _note_refused_main(run, it: dict):
        """★ A book bible's (or the series' earlier book's) main character that Akọwe's checks refused to put into
        the new book is remembered by name: the canon step makes her again (``_ensure_main``), never lost."""
        if it.get("module_id") == "A01" and it.get("story_role") == story_roles.PROTAGONIST and \
                str(it.get("name") or "").strip():
            mains = run.setdefault("main_names", [])
            if it["name"] not in mains:
                mains.insert(0, str(it["name"]).strip()[:120])

    def _seed_world(self, run):
        b = self._bible_of(run) or {}
        pid, branch = run["project_id"], run["branch_id"]
        notes = []
        try:
            if b.get("story_rules") and not story_rules.get_entry(self.store, pid, branch):
                story_rules.save(self.store, pid, branch, story_rules.clean_rules(b["story_rules"]), by="author",
                                 how="book_bible")
                notes.append(f"{len(b['story_rules'])} story rule(s)")
            if b.get("world_texture") and not texture_mod.get_entry(self.store, pid, branch):
                texture_mod.save(self.store, pid, branch, texture_mod.clean_items(b["world_texture"]), by="author",
                                 how="book_bible")
                notes.append(f"{len(b['world_texture'])} world detail(s)")
            tt = b.get("trade_terms") or {}
            if tt.get("items") or tt.get("story_year"):  # P31: the earlier book's trade facts (author's decisions kept)
                from . import terms as terms_mod  # noqa: PLC0415
                if not terms_mod.get_entry(self.store, pid, branch) and \
                        terms_mod.seed_from_bible(self.store, pid, branch, tt.get("items") or [], tt.get("story_year")):
                    notes.append(f"{len(tt.get('items') or [])} trade term(s)")
            if b.get("repeat_labels"):  # P30: the author's voice / motif / filler / accident labels
                from . import repetition as repetition_mod  # noqa: PLC0415
                if not repetition_mod.get_labels(self.store, pid, branch).get("labels"):
                    repetition_mod.save_labels(self.store, pid, branch, b["repeat_labels"], by="author")
                    notes.append(f"{len(b['repeat_labels'])} repeat label(s)")
        except AkoweError as exc:
            self.event(run, "note", f"⚠️ The story rules / world texture of the book bible could not be used "
                       f"({exc.code}); the AI makes new ones", step="world", code="BIBLE_ENTRY_REFUSED")
        run["bible_world_seeded"] = True
        if notes:
            self.event(run, "bible", "🔁 From the book bible: " + " and ".join(notes), step="world")
        self.save(run)

    def _plan_from_bible(self, run, st, bp, op, label) -> str | None:
        """P21 🔁 with "keep the plan": the saved premise / plot / outline as this book's draft (once per part; when
        Akọwe's checks refuse it, the AI writes it new)."""
        s = run["settings"].get("bible") or {}
        if not s.get("reuse_plan"):
            return None
        tried = run.setdefault("bible_plan_tried", [])
        if op in tried:
            return None
        from .book_bible import PLAN_OPS, remap_refs  # noqa: PLC0415
        part = ((self._bible_of(run) or {}).get("plan") or {}).get(PLAN_OPS[op])
        tried.append(op)
        self.save(run)
        if not part or not isinstance(part.get("data"), dict):
            return None
        data = remap_refs(part["data"], self._bible_refs(run))
        try:
            r = bp.dispatch(op, "CREATE", payload=bp.payload_for(op), manual_candidate=data)
        except (AkoweError, StepError) as exc:
            r = {"status": "REJECTED", "errors": getattr(exc, "errors", None) or [{"message": str(exc)}]}
        if r.get("status") == "DRAFT" and r.get("output_refs"):
            ref = r["output_refs"][0]
            self._made(run, ref)
            self.event(run, "bible", f"🔁 The {label} was taken from the book bible (it is reviewed and approved here "
                       "under your consent for this run)", record_id=ref["record_id"], module_id=op)
            return ref["record_id"]
        self.event(run, "note", f"⚠️ The {label} of the book bible did not pass Akọwe's checks in the new book "
                   f"({'; '.join(problems(r)[:2]) or r.get('status')}); the AI writes a new one",
                   code="BIBLE_PLAN_REFUSED", module_id=op)
        return None

    def _seed_scenes(self, run, outline, chapters):
        s = run["settings"].get("bible") or {}
        run["bible_scenes_seeded"] = True
        if not s.get("reuse_plan") or not self._on(run, "scenes"):
            self.save(run)
            return
        b = self._bible_of(run) or {}
        cards = {c.get("chapter_id"): c.get("cards") for c in b.get("scene_cards") or []}
        pid, branch = run["project_id"], run["branch_id"]
        n = 0
        for ch in chapters:
            cid = ch["chapter_id"]
            if not cards.get(cid) or scenes_mod.usable(scenes_mod.get_entry(self.store, pid, branch,
                                                                           outline["record_id"], cid), outline):
                continue
            try:
                scenes_mod.save_cards(self.store, pid, branch, outline, cid, scenes_mod.clean_cards(cards[cid]),
                                      by="author", how="book_bible")
                n += 1
            except AkoweError:
                continue
        if n:
            self.event(run, "bible", f"🔁 From the book bible: the scene cards of {n} chapter(s) (checked and approved "
                       "here before each chapter is written)", step="chapters")
        self.save(run)

    def _s_premise(self, run, st):
        self._seed_locks(run)  # 📋 6c: the starter sheet's lock list -> the story rules (once)
        self._carry_lessons(run)  # 🧠 the lessons from the author's last books, for the planners and the writer
        self._planning(run, st, "B01", "premise")

    def _carry_lessons(self, run):
        """🧠 Once per run: the author's lessons from the last books (quality_history.py) are copied onto this book."""
        if run.get("lessons_carried"):
            return
        from . import quality_history  # noqa: PLC0415
        ls = quality_history.carry(self.store, run["principal"], run["project_id"])
        run["lessons_carried"] = True
        run["lessons"] = [x["text"] for x in ls]
        if ls:
            self.event(run, "note", f"🧠 {len(ls)} lesson(s) from your last books go to the planners and the writer: "
                       + "; ".join(x["text"] for x in ls[:3]) + (" …" if len(ls) > 3 else ""), step="premise",
                       code="LESSONS_CARRIED")
        self.save(run)

    def _seed_locks(self, run):
        """📋 6c Paste starter sheet: the run's lock list (setting ``locks``) becomes hard rules from the author in the
        book's story-rules ledger, after the AI's own rules were made (the world step). Never blocks the book."""
        locks = run["settings"].get("locks") or []
        if not locks or run.get("locks_seeded"):
            return
        from . import starter_sheet  # noqa: PLC0415
        try:
            n = starter_sheet.seed_locks(self.store, run["project_id"], run["branch_id"], locks)
            self.event(run, "world", f"📋 Your lock list: {n} fact(s) that must stay true put into the story rules",
                       step="world")
        except Exception as exc:  # noqa: BLE001 - the book goes on; the list is still in the run's settings
            log.exception("could not put the lock list into the story rules")
            self.event(run, "note", f"⚠️ Your lock list could not be put into the story rules ({type(exc).__name__}); "
                       "add the facts on the book's 🌍 Story rules page", code="LOCKS_FAILED")
        run["locks_seeded"] = True
        self.save(run)

    def _s_plot(self, run, st):
        from . import writers_room  # noqa: PLC0415 - 🗳 optional (run setting writers_room): a room on the twist
        writers_room.run_plot(self, run, st, control=(RunPaused, RunCancelled))
        self._planning(run, st, "B03", "main plot")

    def _s_outline(self, run, st):
        if not self.bp(run).approved("B11"):
            self._ensure_main(run, st)  # never plan the chapters without the book's main character in the canon
            self._guard_main(run, st, "before the chapter outline")
            self._repin_plan(run, st)

        def made_missing():
            # ★ an outline refused for a viewpoint character the canon does not have ("plan.pov_id 'x' is not
            # declared"): that character is made and approved, and the main plot is planned again so the next
            # outline pins it (the outline sees the canon through the plot's pins)
            self._ensure_main(run, st)
            self._repin_plan(run, st)
        self._planning(run, st, "B11", "chapter outline", precheck=lambda rid: self._outline_has_main(run, rid),
                       on_refused=made_missing)
        from . import story_doctor  # noqa: PLC0415 - 🩺 the plan is scored (and mended) before chapter 1
        story_doctor.run_doctor(self, run, st)
        self._update_rules(run, st)
        n = len(self.bp(run).outline_chapters(self.bp(run).outline()))
        st["message"] = f"{n} chapter(s) planned and approved" + (f" · {st['doctor']}" if st.get("doctor") else "")
        self._place_beats(run, st)
        self._place_stages(run, st)
        from . import trade_card  # noqa: PLC0415 - 🔧 how the book's trade is really done (≤ 1 request)
        trade_card.run_step(self, run, st)
        tc = (run.get("trade_card") or {}).get("line")
        if tc:
            st["message"] += f" · {tc}"

    def _place_stages(self, run, st):
        """📚 story_kind.py: the planner places the chapter where each stage of the book's kind of story begins (one
        AI call, checked like the story shape's beats). Once per outline revision; never holds up the book."""
        from . import story_kind  # noqa: PLC0415
        bp = self.bp(run)
        outline = bp.outline()
        if not outline or not story_kind.of_store(self.store, run["project_id"]):
            return
        done = run.setdefault("stages_placed", {})
        key = f"{outline['record_id']}:{outline['version']}"
        if done.get(key):
            return
        try:
            m = story_kind.place(self._review, self._sub_job(run, "story_kind", outline["record_id"],
                                                             run["settings"].get("slot_id")), bp, outline)
        except AkoweError as exc:
            if getattr(exc, "control", False):
                raise
            self.event(run, "note", f"⚠️ The stages of the kind of story could not be placed on the chapters "
                       f"({exc.code}); each begins where it usually does", step="outline", code="KIND_FAILED")
            m = story_kind.mapping(self.store, run["project_id"], run["branch_id"], outline)
        done[key] = True
        if m:
            st["kind"] = [story_kind.strip_label(s_) for s_ in m["stages"]][:12]
            self.event(run, "note", f"📚 {m['label']}: " + "; ".join(story_kind.strip_label(s_) for s_ in m["stages"])
                       + (f" (⚠️ {len(m['problems'])} placed where they usually begin)" if m.get("problems") else ""),
                       step="outline", code="KIND_PLACED")
        self.save(run)

    def _place_beats(self, run, st):
        """📐 story_shape.py: the planner places each beat of the author's story shape on a chapter of the approved
        outline (one AI call, checked by Akọwe; a beat it leaves out or misplaces is placed by its position). Once per
        outline revision; never holds up the book."""
        from . import story_shape  # noqa: PLC0415
        bp = self.bp(run)
        outline = bp.outline()
        if not outline or not story_shape.of_store(self.store, run["project_id"]):
            return
        done = run.setdefault("beats_placed", {})
        key = f"{outline['record_id']}:{outline['version']}"
        if done.get(key):
            return
        try:
            m = story_shape.place(self._review, self._sub_job(run, "story_shape", outline["record_id"],
                                                              run["settings"].get("slot_id")), bp, outline)
        except AkoweError as exc:
            if getattr(exc, "control", False):
                raise
            self.event(run, "note", f"⚠️ The story shape could not be placed on the chapters ({exc.code}); each beat "
                       "is placed by its position", step="outline", code="SHAPE_FAILED")
            m = story_shape.mapping(self.store, run["project_id"], run["branch_id"], outline)
        done[key] = True
        if m:
            st["shape"] = [story_shape.strip_label(b) for b in m["beats"]][:20]
            self.event(run, "note", f"📐 {m['label']}: " + "; ".join(story_shape.strip_label(b) for b in m["beats"])
                       + (f" (⚠️ {len(m['problems'])} placed by their position)" if m.get("problems") else ""),
                       step="outline", code="SHAPE_PLACED")
        self.save(run)

    def _repin_plan(self, run, st):
        """An approved character the approved main plot does not pin (made after the plot: the main character the
        guard made, a viewpoint character the outline needed) is invisible to the chapter outline's canon check. The
        plot is then set aside as out of date and planned again with the whole canon pinned (once per character)."""
        bp = self.bp(run)
        plot = bp.approved("B03")
        if not plot:
            return
        pinned = set()
        for ref in plot[0].get("source_refs") or []:
            pinned.add(ref.get("record_id"))
            if str(ref.get("module_id") or "").startswith("B"):
                up = bp.rec(ref["record_id"], ref.get("version"))
                pinned |= {r.get("record_id") for r in (up or {}).get("source_refs") or []}
        done = run.setdefault("repinned", [])
        new = [r for r in bp.approved("A01") if r["record_id"] not in pinned and r["record_id"] not in done]
        if not new:
            return
        names_ = ", ".join(f"“{chars_mod._name_and_subject(r)[0]}”" for r in new)[:200]  # noqa: SLF001
        done += [r["record_id"] for r in new]
        bp.set_aside(plot[0], f"out of date: the canon has new character(s) {names_} the plan must pin")
        self.event(run, "note", f"📌 The main plot is planned again so that it includes {names_} (made after the "
                   "plot; the chapter outline can only use characters the plot pins)", code="PLAN_REPINNED",
                   module_id="B03")
        self.save(run)
        self._planning(run, st, "B03", "main plot")

    def _s_chapters(self, run, st):
        bp = self.bp(run)
        outline = bp.outline()
        if not outline:
            raise StepProblem("NOT_FOUND", "There is no approved chapter outline.", "Press 🔁 Try again.")
        self._guarantee_main(run, st, "before the chapters are written")
        bp = self.bp(run)
        chapters = bp.outline_chapters(outline)
        if not chapters:
            raise StepProblem("INVALID_INPUT", "The chapter outline has no chapters Akọwe can write.",
                              "Press 🔁 Try again.")
        if run["settings"].get("bible") and not run.get("bible_scenes_seeded"):
            self._seed_scenes(run, outline, chapters)
        items = {i["id"]: i for i in st.get("items") or []}
        st["items"] = [items.get(c["chapter_id"]) or {"id": c["chapter_id"], "label": f"Chapter {c['chapter_id']}",
                                                       "state": "pending", "words": 0} for c in chapters]
        self._chapter_edits(run, outline, chapters)  # H5: a chapter changed by hand since the book went on from it
        for idx, ch in enumerate(chapters):
            cid = ch["chapter_id"]
            item = st["items"][idx]
            self._checkpoints(run, st, outline, chapters, idx)  # 🧭 a checkpoint due after the chapters before this one
            # ⚡ #116: every AI call for this chapter shows "chapter N of M" in the AI activity strip
            with ai_activity.doing(None, chapter=idx + 1, chapters=len(chapters), chapter_id=cid):
                bp = self.bp(run)
                _ctx, latest, appr = bp.chapter_prose(outline, cid)
                if not appr:  # 📖 a chapter the author wrote (brought in): put back word for word, never written
                    from . import book_import  # noqa: PLC0415
                    appr = book_import.keep_author_chapter(self.app, run["principal"], run["project_id"],
                                                           run["branch_id"], cid)
                if appr:
                    from . import continuity  # noqa: PLC0415
                    if not continuity.tracked(self.store, run["project_id"], run["branch_id"], cid, appr):
                        # approved, but a Pause / Cancel came before its continuity was tracked, or the author changed
                        # the chapter since it was tracked (H5): track it (again) now
                        continuity.after_chapter(self, run, cid, appr, item)
                    continuity.note_written(self.store, run["project_id"], run["branch_id"], cid, appr, idx + 1)
                    if self._on(run, "voices"):  # ⏱ lock what it relied on (idempotent)
                        from . import story_details  # noqa: PLC0415
                        story_details.after_chapter(self, run, cid, idx + 1)
                    item.update(state="done", words=len(((appr.get("data") or {}).get("text") or "").split()))
                    continue
                item["state"] = "running"
                st["message"] = f"Chapter {idx + 1} of {len(chapters)}" + self._eta_words(run)
                t_chapter = time.monotonic()
                from . import claude_code_book  # noqa: PLC0415 - 🤖 research the next chapters ahead (background)
                claude_code_book.chapter_started(self, run, outline, chapters, idx)
                self.save(run)
                while True:
                    bp = self.bp(run)
                    _ctx, latest, _appr = bp.chapter_prose(outline, cid)
                    if latest and latest["lifecycle"] in REVIEWABLE and not latest.get("stale"):
                        from . import continuity  # noqa: PLC0415
                        flag = continuity.recheck_open(self.store, run["project_id"], run["branch_id"], cid)
                        if flag:  # H5: this draft was written before an earlier chapter changed: write it again
                            bp.set_aside(latest, f"written before chapter {flag['because_number']} was changed")
                            continuity.recheck_done(self.store, run["project_id"], run["branch_id"], cid)
                            self.event(run, "note", f"Chapter {idx + 1}'s draft was written before chapter "
                                       f"{flag['because_number']} changed: it is set aside and written again",
                                       code="DRAFT_BEFORE_EDIT", record_id=latest["record_id"])
                            continue
                    if latest and latest["lifecycle"] in REVIEWABLE and not latest.get("stale"):
                        rid = latest["record_id"]
                    else:
                        from . import writers_room  # noqa: PLC0415 - 🗳 optional: a room at the midpoint and the climax
                        writers_room.before_chapter(self, run, st, outline, cid, idx + 1, len(chapters),
                                                    control=(RunPaused, RunCancelled))
                        try:
                            if self._on(run, "scenes"):
                                self._scene_cards(run, st, cid, item)
                        except StepProblem:
                            item["state"] = "paused"
                            raise
                        st["message"] = f"Chapter {idx + 1} of {len(chapters)}" + self._eta_words(run)
                        run["phase"] = st["message"]
                        self.save(run)
                        from . import continuity  # noqa: PLC0415 - Section 7 (P34): the version ledger, once per run
                        continuity.before_chapter(self, run, cid)
                        if self._on(run, "voices"):  # ⏱ decide just the details this chapter needs (≤ 1 AI call)
                            from . import story_details  # noqa: PLC0415
                            with ai_activity.doing(f"Deciding the details chapter {idx + 1} needs",
                                                   done=f"Decided the details chapter {idx + 1} needs"):
                                story_details.before_chapter(self, run, st, cid, idx + 1, item)
                        payload = bp.prepare_chapter(cid)
                        from . import writer_record  # noqa: PLC0415 - 🏆 let the best writer write more
                        prov_ = self._engine.providers
                        if hasattr(prov_, "prefer_writer"):
                            prov_.prefer_writer = writer_record.before_chapter(
                                self.store, prov_, run, idx + 1, editor_on=bool(
                                    self._editor_settings(run).get("enabled") and self._on(run, "editor")))
                            st["writer_note"] = (run.get("writer_pick") or {}).get("line")
                        try:
                            if idx == 0:  # ✍ two first pages, the better one starts chapter 1 (first_page.py) — by the preferred writer
                                from . import first_page  # noqa: PLC0415
                                first_page.before_first_chapter(self, run, st, outline, cid, payload, item)
                            ref = self.ai_create(run, self.bp(run), "C02", payload, f"chapter {cid}")
                        finally:
                            if hasattr(prov_, "prefer_writer"):
                                prov_.prefer_writer = None
                        rid = ref["record_id"]
                        self._made(run, ref)
                        self.event(run, "ai", f"The AI wrote chapter {cid}", record_id=rid, module_id="C02")
                        claude_code_book.draft_written(self, run, cid, idx + 1, rid)  # 🤖 fact check starts now
                        from . import brief_cuts  # noqa: PLC0415 - H13: say exactly what did not fit
                        cuts = brief_cuts.after_write(self.store, run["project_id"], run["branch_id"], cid, idx + 1, rid,
                                                      payload.get("context_ref"))
                        item.pop("cut", None)
                        from . import needs_list  # noqa: PLC0415 - 🧠 smart memory: this chapter's instruction size
                        sm = needs_list.metric_of_record(self.store, run["project_id"], run["branch_id"], rid)
                        item.pop("memory", None)
                        if sm:
                            item["memory"] = sm
                            needs_list.record_metric(self.store, run["project_id"], run["branch_id"], cid, idx + 1, sm)
                        if cuts:
                            item["cut"] = cuts["cut"]
                            self.event(run, "note", cuts["line"], code="INSTRUCTIONS_CUT", record_id=rid,
                                       chapter_id=cid)
                    from . import chapter_polish  # noqa: PLC0415 - 📏 reading level + repeats: ≤ 1 polish, kept if better
                    chapter_polish.after_draft(self, run, st, outline, cid, idx + 1, rid, item)
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
                from . import continuity  # noqa: PLC0415 - Section 7 (P32/P35): track + approve under the run consent
                with ai_activity.doing(f"Updating the running notes after chapter {idx + 1}",
                                       done=f"Updated the running notes after chapter {idx + 1}"):
                    continuity.after_chapter(self, run, cid, rec, item)
                if idx == 0:  # ✍ the chosen first page leaves the writing brief once chapter 1 is approved
                    from . import first_page  # noqa: PLC0415
                    first_page.after_first_chapter(self, run, cid, rec)
                if rec:
                    continuity.note_written(self.store, run["project_id"], run["branch_id"], cid, rec, idx + 1)
                    continuity.recheck_done(self.store, run["project_id"], run["branch_id"], cid)
                    claude_code_book.chapter_approved(self, run, cid, idx + 1, rec)  # 🤖 facts + "sounds like AI"
                    from . import writer_record  # noqa: PLC0415 - 🏆 the writer's score joins its track record
                    writer_record.after_chapter(self, run, rec)
                    # 🔎 PR #117: all the AIs check this chapter before the next one is written (checkpoints.py)
                    due = run.setdefault("chapter_checks_due", [])
                    if cid not in due:
                        due.append(cid)
                if self._on(run, "voices"):  # ⏱ 🔒 what this chapter relied on is fixed; contradictions are flagged
                    from . import story_details  # noqa: PLC0415
                    story_details.after_chapter(self, run, cid, idx + 1)
                from . import claude_code_speed  # noqa: PLC0415 - 🤖 Step 2: plan the next chapter while this one is checked
                claude_code_speed.chapter_done(self, run, outline, chapters, idx)
                item.update(state="done", words=len((((rec or {}).get("data") or {}).get("text") or "").split()),
                            seconds=round(time.monotonic() - t_chapter, 1))
                tm = run.setdefault("timing", {"calls": 0, "call_s": 0.0})
                tm["chapter_s"] = (list(tm.get("chapter_s") or []) + [item["seconds"]])[-50:]
                done_n = sum(1 for i in st["items"] if i.get("state") == "done")
                run["eta"] = self._eta(run, done_n, len(chapters))
                self._autosave(run, reason=f"chapter {cid} approved")
                lm = self._length_meta(run, (rec or {}).get("record_id") or rid)
                if lm:
                    item["length"] = lm
                pl = (run.get("planned") or {}).get((rec or {}).get("record_id") or rid)
                if pl:
                    item["planned"] = {"missing": len(pl.get("missing") or []), "flagged": bool(pl.get("flagged")),
                                       "fixed": int(pl.get("fixed") or 0), "on_page": (pl.get("counts") or {}).get(
                                           "on_page"), "items": (pl.get("counts") or {}).get("items")}
                ed = (run.get("editor") or {}).get((rec or {}).get("record_id") or rid)
                if ed:
                    item["editor"] = {"verdict": ed.get("verdict"), "rounds": ed.get("rounds", 0),
                                      "flagged": bool(ed.get("flagged")), "avg": ed.get("avg_score"),
                                      "min": ed.get("min_score"), "reviewer": ed.get("reviewer")}
                self.save(run)
        self._checkpoints(run, st, outline, chapters, len(chapters))  # 🧭 the final check of the whole book
        # H11 / H12: the ending keeps the book's promises — the ONE final ending check (the final 🧭 checkpoint does
        # not run its own; the checkpoints before it run the light setups-so-far check, ending_check upto=N)
        self._ending_pass(run, st, outline, chapters)
        from . import chapter_polish  # noqa: PLC0415 - 📏 both numbers in the run window
        pl = chapter_polish.to_report(self, run)
        if pl:
            self.event(run, "report", pl, step="chapters", code="CHAPTER_POLISH")
        words = sum(i.get("words") or 0 for i in st["items"])
        target = lengths_mod.of_book(self.store, run["project_id"], len(chapters))
        st["message"] = f"{len(chapters)} chapter(s) written and approved · {words:,} words (target about " \
                        f"{target['book_words']:,})"
        run["eta"] = None

    def _checkpoints(self, run, st, outline, chapters, upto: int):
        """🧭 checkpoints.py: the continuity checkpoints due once ``upto`` chapters are approved. A problem the
        checkpoint cannot fix safely pauses the run once (StepProblem); anything unexpected never holds up the book."""
        from . import checkpoints  # noqa: PLC0415
        try:
            checkpoints.run_due(self, run, st, outline, chapters, upto)
        except (StepProblem, RunPaused, RunCancelled, Cancelled):
            raise
        except Exception as exc:  # noqa: BLE001
            if getattr(exc, "control", False):
                raise
            log.exception("make-a-book run %s: checkpoint failed", run["id"])
            self.event(run, "note", f"⚠️ A continuity checkpoint could not be finished "
                                    f"({getattr(exc, 'code', type(exc).__name__)}); the book goes on",
                       step="chapters", code="CHECKPOINT_FAILED")

    def _ending_pass(self, run, st, outline, chapters):
        """H11 / H12: after the last chapter — each setup, thread and named character, the main character's change
        and the book's question against the page (ending_check.py, one AI call). What is open and has a fix goes to
        the last chapter(s) through the rewrite machinery (a new draft, reviewed and approved under the run consent),
        at most ending_check.FIX_ROUNDS round, then one more check; what stays open is listed for the author. Never
        blocks the book (an AI problem is a note); pause / resume safe (``run["ending"]``)."""
        from . import continuity, ending_check  # noqa: PLC0415
        mem = run.setdefault("ending", {})
        if mem.get("done"):
            return
        pid, branch = run["project_id"], run["branch_id"]
        bp = self.bp(run)

        def checked():
            st["message"] = "Checking that the ending keeps the book's promises"
            run["phase"] = st["message"]
            self.save(run)
            # 🔎 PR #117: every working AI checks the ending (run setting "How many AIs check for mistakes")
            writer = None
            try:
                last = chapters[-1]
                _c, _l, appr_last = self.bp(run).chapter_prose(outline, last["chapter_id"])
                writer = self._review.writer_of(pid, branch, appr_last).get("slot") if appr_last else None
            except Exception:  # noqa: BLE001
                writer = None
            ck = cross_check.checker_slots(self, run, writer=writer or run["settings"].get("slot_id"))
            with ai_activity.doing("Checking that the ending keeps the book's promises", done="Checked the ending"):
                return ending_check.check(self._review, self._sub_job(run, "ending_check", "book"), checkers=ck or None)

        def finish_draft(rid, cid, number):
            rec = self._review_until_approved(run, st, rid, f"chapter {cid}", chapter_id=cid)
            if rec:
                continuity.after_chapter(self, run, cid, rec, None)  # track the new ending again
                continuity.note_written(self.store, pid, branch, cid, rec, number)
        try:
            from . import story_shape  # noqa: PLC0415 - 📐 a story beat that did not land: one targeted fix
            story_shape.fix_beats(self, run, st, outline, chapters, where="ending")
            from . import story_kind  # noqa: PLC0415 - 📚 a story stage that did not land: one targeted fix
            story_kind.fix_stages(self, run, st, outline, chapters, where="ending")
            if mem.get("fixing"):  # resumed while a fixed ending waited for its review
                f = mem["fixing"]
                finish_draft(f["record_id"], f["chapter_id"], f["number"])
                mem.pop("fixing", None)
                self.save(run)
            res = checked()
            while int(mem.get("rounds") or 0) < ending_check.FIX_ROUNDS and any(o.get("fix") for o in res["open"]):
                mem["rounds"] = int(mem.get("rounds") or 0) + 1
                changed = 0
                for number in sorted({o["fix_chapter"] for o in res["open"] if o.get("fix") and o.get("fix_chapter")}):
                    cid = chapters[number - 1]["chapter_id"]
                    _ctx, _latest, appr = self.bp(run).chapter_prose(outline, cid)
                    if not appr:
                        continue
                    head = self.bp(run).rec(appr["record_id"])
                    if not self._ai_made(run, head):  # 📖 the author's own chapter is never rewritten
                        self.event(run, "note", f"Chapter {number} is your own text: the ending's open promises are "
                                   "not worked into it (listed for you instead)", code="AUTHOR_CHAPTER")
                        continue
                    fs = ending_check.fix_findings(res, number, str((head.get("data") or {}).get("text") or ""))
                    if not fs:
                        continue
                    st["message"] = f"The writer works the open promises into chapter {number}"
                    run["phase"] = st["message"]
                    self.save(run)
                    with ai_activity.doing(f"Working the open promises into chapter {number}",
                                           done=f"Worked the open promises into chapter {number}",
                                           chapter=number, chapters=len(chapters)):
                        prop = self._review.editor.propose(
                            self._sub_job(run, "ending_fix", head["record_id"], run["settings"].get("slot_id")),
                            head["record_id"], craft={"findings": fs, "keep": [], "slot": None,
                                                      "version": head["version"], "ending": True})
                    if not prop.get("applied"):
                        self.event(run, "note", f"⚠️ The writer's changes for the ending of chapter {number} did not "
                                   "match the text word for word; nothing was guessed", code="ENDING_UNRESOLVED")
                        continue
                    self._review.editor.apply(run["principal"], pid, branch, head["record_id"], head["version"], None,
                                              proposal=prop, how="run")
                    mem["fixing"] = {"record_id": head["record_id"], "chapter_id": cid, "number": number}
                    self.save(run)
                    self.event(run, "fix", f"Chapter {number} sent back to keep {len(fs)} promise(s) of the book",
                               code="ENDING_FIX", record_id=head["record_id"])
                    finish_draft(head["record_id"], cid, number)
                    mem.pop("fixing", None)
                    changed += 1
                    self.save(run)
                if not changed:
                    break
                res = checked()
        except StepProblem:
            raise
        except AkoweError as exc:
            if getattr(exc, "control", False):
                raise
            mem.update(done=True, error=exc.code)
            self.event(run, "note", f"⚠️ The ending check did not work ({exc.code}); the book goes on — press 🎯 "
                       "Check the ending later", code="ENDING_CHECK_FAILED")
            self.save(run)
            return
        mem.update(done=True, open=len(res["open"]), line=ending_check.summary_line(res))
        self.event(run, "note", f"🎯 Ending check: {mem['line']}"
                   + (" — ⚠️ still open: " + "; ".join(o["line"] for o in res["open"][:4]) if res["open"] else ""),
                   code="ENDING_OPEN" if res["open"] else "ENDING_KEPT")
        self.save(run)

    def _chapter_edits(self, run, outline, chapters):
        """H5: before the chapters go on — an approved chapter the author changed since the book continued from it:
        its tracked state is set aside (tracked again below) and the later written chapters are flagged."""
        from . import continuity  # noqa: PLC0415
        try:
            bp = self.bp(run)
            written = []
            for i, c in enumerate(chapters):
                _ctx, latest, appr = bp.chapter_prose(outline, c["chapter_id"])
                r = appr or latest
                if r:
                    written.append({"chapter_id": c["chapter_id"], "number": i + 1, "record_id": r["record_id"],
                                    "version": r["version"]})
            for f in continuity.check_edits(self.store, run["project_id"], run["branch_id"], later=written):
                self.event(run, "note", f"✏️ Chapter {f['number']} was changed by hand: what was tracked from it is "
                           "set aside until it is tracked again"
                           + ("; " + "; ".join(continuity.message(f["number"], next(
                               (w["number"] for w in written if w["chapter_id"] == x), "?")) for x in f["flagged"])
                              if f["flagged"] else ""), step="chapters", code="CHAPTER_CHANGED",
                           chapter_id=f["chapter_id"])
        except Exception:  # noqa: BLE001 - never holds up the book
            log.exception("could not check for changed chapters")

    @staticmethod
    def _eta_words(run) -> str:
        eta = run.get("eta") or {}
        left = eta.get("seconds_left")
        if left is None:
            return ""
        return f" · about {max(1, round(left / 60))} min left" if left >= 90 else f" · about {max(1, left)} s left"

    def _length_meta(self, run, rid: str) -> dict | None:
        """How the approved chapter was written (P15: whole / scene by scene, expansion rounds) — numbers only."""
        try:
            rec = self.bp(run).rec(rid)
            hist = self.store.history(run["project_id"], run["branch_id"], rid)
            first = hist[0] if hist else rec
            meta = self.store.get_state(run["project_id"], run["branch_id"], "c_meta", first["record_id"]) or {}
            info = meta.get("length") or {}
            if not info:
                return None
            return {"mode": info.get("mode"), "scenes": info.get("scenes"), "target": info.get("target_words"),
                    "expanded": info.get("expanded_words"), "rounds": info.get("expand_rounds")}
        except Exception:  # noqa: BLE001 - display only
            return None

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
        self._approve_step_items(run, "format", "book format made by Akọwe from the profile (deterministic)")
        st["message"] = "Page size and interior design (Book format page), PDF/EPUB/DOCX settings — approved"

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
        self._approve_step_items(run, "assemble", "assembly made by Akọwe from the approved chapters "
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

    def _s_report(self, run, st):
        """P13: the book report of the finished book, with the whole-book review by every working AI that did not
        write most of it (independent). Never blocks the book: a failure is a ⚠️ note (REPORT_FAILED); a reviewer that
        fails is listed in the report."""
        self._settle_cast(run)
        chk = protagonist.check(self.bp(run))  # ★ the guard before the whole-book review
        if not chk["ok"] and not chk.get("in_canon"):
            self._guard_main(run, st, "before the whole-book review")  # makes the entry, or stops naming them
        elif not chk["ok"]:  # the chapters are written: a ⚠️ for the author (the review reads the book as it is)
            self.event(run, "note", f"⚠️ {chk['problem'][0].upper()}{chk['problem'][1:]} (before the whole-book "
                       "review)", step="report", code="PROTAGONIST_MISSING")
        rp = getattr(self.app, "reports", None)
        if rp is None:
            st["message"] = "Not available"
            self._human_pass(run, st)
            return
        st["message"] = "The other AIs are reading the whole book"
        run["phase"] = st["message"]
        self.save(run)

        def progress(i, n, s):
            st["message"] = f"{s['name']} is reading the whole book ({i + 1} of {n})"
            run["phase"] = st["message"]
            self.save(run)
        try:
            rep = rp.make(run["principal"], run["project_id"], run["branch_id"], assist=self._assist,
                          review=self._review, ai=True, made_by="run", run_id=run["id"],
                          check=lambda: self.check(run), on_progress=progress)
        except (RunPaused, RunCancelled, Cancelled):
            raise
        except Exception as exc:  # noqa: BLE001 - a report must never stop the book
            log.exception("book report failed in run %s", run["id"])
            code = exc.code if isinstance(exc, AkoweError) else type(exc).__name__
            st["message"] = f"⚠️ The report could not be made ({code}); make it on the book's 📊 report page"
            self.event(run, "note", st["message"], step="report", code="REPORT_FAILED")
            self._human_pass(run, st)
            return
        agg = rep.get("aggregate") or {}
        run["report"] = {"id": rep["id"], "overall": agg.get("overall"), "reviewers": agg.get("reviewers"),
                         "independent": agg.get("independent"), "disagreements": agg.get("disagreements") or [],
                         "words": (rep.get("words") or {}).get("total"), "warnings": rep.get("warnings") or []}
        from . import chapter_polish  # noqa: PLC0415 - 📏 the chapter polish's numbers in the saved report too
        chapter_polish.to_report(self, run, rep)
        from . import story_doctor  # noqa: PLC0415 - 🩺 the plan check's line in the saved report too
        story_doctor.to_report(self, run, rep)
        if agg.get("reviewers"):
            st["message"] = (f"{agg['reviewers']} AI(s) read the whole book · overall {agg.get('overall')}/10"
                             + (f" · ⚠️ they disagree on {', '.join(agg['disagreements'])}" if agg.get("disagreements")
                                else ""))
        else:
            st["message"] = "⚠️ Report made without an AI review: no independent AI was working (📨 Ask the other AIs " \
                            "on the report page later)"
            self.event(run, "note", st["message"], step="report", code="REPORT_NOT_INDEPENDENT")
        self.event(run, "report", f"Book report {rep['id']}: {st['message']}", step="report")
        og = (rep.get("originality") or {}).get("line")  # ✨ #20: one line, never blocks the book
        if og:
            run["report"]["originality"] = og
            self.event(run, "report", og + " (see ✨ Originality check on the 📊 report page)", step="report")
        self._human_pass(run, st)

    def _human_pass(self, run, st):
        """✍ The end-of-book "sounds like a person" pass (human_voice.end_pass): the no-AI check of every chapter, an
        independent AI read, the book-wide repeat check, then up to 20 rewrite suggestions for the author to approve on
        the chapter pages. Never blocks the book (only a pause / cancel stops it)."""
        from . import human_voice  # noqa: PLC0415
        msg = st.get("message")
        hp = human_voice.end_pass(self, run, st)
        st["message"] = msg
        if not hp:
            return
        run.setdefault("report", {})["human"] = hp["line"]
        run["report"]["human_score"] = {"before": (hp.get("before") or {}).get("score"),
                                        "projected": hp.get("projected"), "proposals": hp.get("proposals")}
        self.event(run, "report", hp["line"], step="report", code="HUMAN_PASS")
        for n in hp.get("notes") or []:
            self.event(run, "note", f"✍ {n}", step="report")
        self.save(run)

    # ------------------------------------------------------------------ Section 7c (P23 beta reader, P25 style)
    def _s_bible(self, run, st):
        """📖 Fill the whole Book Bible before chapter one (whole_bible.py) — only when the run asked for it."""
        from . import whole_bible  # noqa: PLC0415
        whole_bible.run_step(self, run, st)

    def _s_beta(self, run, st):
        from . import beta_reader  # noqa: PLC0415
        beta_reader.run_step(self, run, st, control=(RunPaused, RunCancelled))

    def _s_opening(self, run, st):
        """✍ Rewrite chapter 1 last (opening_pass.py): one rewrite with the whole book in view, kept only if the same
        reviewers score the book at least as well."""
        from . import opening_pass  # noqa: PLC0415
        opening_pass.run_step(self, run, st)

    def _s_improve(self, run, st):
        """🔁 Improve until better (improve_pass.py): targeted rewrites, the same reviewers re-read, kept only when the
        score went up and nothing dropped."""
        from . import improve_pass  # noqa: PLC0415
        improve_pass.run_step(self, run, st)

    def _s_reread(self, run, st):
        """🔁 Read the final book again where Akọwe's own rewrites changed it (final_reads.py)."""
        from . import final_reads  # noqa: PLC0415
        final_reads.run_step(self, run, st)

    def _record_quality(self, run):
        """📈 The finished book's report numbers join the author's quality history (quality_history.py); the trend
        line goes to the run window. Never raises."""
        try:
            from . import quality_history  # noqa: PLC0415
            rp = getattr(self.app, "reports", None)
            rep = rp.latest(run["project_id"], run["branch_id"]) if rp else None
            if not rep or (rep.get("aggregate") or {}).get("overall") is None:
                return
            from .improve_pass import _latest_beta  # noqa: PLC0415
            beta = _latest_beta(self.app, run["project_id"], run["branch_id"])
            from .book_report import book_chapters  # noqa: PLC0415
            texts = [c["text"] for c in book_chapters(self.bp(run))]
            im = run.get("improve") or {}
            snap = quality_history.snapshot(rep, book=run["project_id"], run_id=run["id"], texts=texts, beta=beta,
                                            improve={k: im.get(k) for k in ("before", "after", "kept")}
                                            if im.get("rounds") else None)
            quality_history.record(self.store, run["principal"], snap)
            tr = quality_history.trend(self.store, run["principal"], book=run["project_id"])
            if tr:
                run.setdefault("report", {})["trend"] = tr["text"]
                self.event(run, "report", f"📈 {tr['text']}", step="report", code="QUALITY_TREND")
        except Exception:  # noqa: BLE001 - a hint, never a reason to fail the finished book
            log.exception("could not record the quality history of run %s", run.get("id"))

    def _apply_style(self, run, pid):
        from . import style_card  # noqa: PLC0415
        try:
            ok = style_card.apply_to_book(self.store, run["principal"], pid)
        except Exception:  # noqa: BLE001 - the style is help for the writer, never a reason to stop
            log.exception("could not apply the writing style in run %s", run["id"])
            ok = None
        run["style_applied"] = True
        if ok:
            self.event(run, "note", "✒️ This book is written in your own style (your style card, version "
                       f"{ok.get('from_version')})", step="profile", code="STYLE_APPLIED")
        else:
            self.event(run, "note", "✒️ You asked for your own writing style, but there is no style card yet (✒️ My "
                       "writing style): the book gets its own narrator voice instead", step="profile",
                       code="STYLE_MISSING")

    def _s_check(self, run, st):
        out = self.bp(run).a_check({})
        if not out.get("ok"):
            raise StepProblem("INVALID_INPUT", out.get("message") or "The content check did not pass.",
                              "Open the book's Quality Checks to see what is missing, then press 🔁 Try again.",
                              details=(out.get("problems") or [])[:6])
        st["message"] = out.get("message") or "PASS"


def verify_file(fmt: str, data: bytes) -> tuple[bool, str]:
    """Re-read an exported file with Akọwe's independent checkers (as the workflow test does)."""
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
        # The check and the launch are one step: two presses at once (a double click, two tabs) start ONE writer —
        # two would write every chapter twice.
        with self._lock:
            return self._start_locked(principal, pid, branch)

    def _start_locked(self, principal: str, pid: str, branch: str) -> dict:
        for r in self.active():
            if r.get("project_id") == pid and r.get("branch_id") == branch:
                return self.public(r)
        bp = BookPath(self.app.engine, principal, pid, branch)
        outline = bp.outline()
        if not outline:
            raise AkoweError("INVALID_INPUT", "/outline", "approve the chapter outline first", status="REJECTED")
        if (bp.profile.get("ai_slot") or "") == "manual" or not self._ai_configured():
            raise AkoweError("CAPABILITY_UNAVAILABLE", "", "no AI is connected (or the book profile says you "
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
        if not outline or not pipeline_mod.on(self.store, job["project_id"], "scenes"):
            return  # P14: a book made without scene cards is written on without them
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
        except AkoweError as exc:
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
                        n = job["items"].index(item) + 1
                        with ai_activity.doing(None, kind="write_all", book_id=job["project_id"],  # ⚡ #116
                                               branch_id=job["branch_id"], chapter=n, chapters=len(job["items"]),
                                               chapter_id=item["id"], link=f"write/{item['id']}"):
                            with ai_activity.doing(f"Planning scenes for chapter {n}",
                                                   done=f"Planned the scenes of chapter {n}"):
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
                if getattr(self.app, "saver", None):
                    self.app.saver.auto(job["project_id"], job["branch_id"], reason=f"{item['label']} written")
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
        if getattr(self.app, "saver", None):
            self.app.saver.auto(job["project_id"], job["branch_id"], reason=f"write all {job.get('status')}", force=True)


def public_json(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)
