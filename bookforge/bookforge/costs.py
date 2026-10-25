"""⏱ P28 Cost and time per book: how many AI calls and how many minutes each AI spent on a book and on each run, and
an estimate before a run starts.

Where the numbers come from (nothing new is asked of any AI; numbers only — never prompts, replies or book text):

* **Runs (measured).** A Make-a-book run times every AI call it makes (autobook ``_TimedProviders``, the same clock
  as the P15 ETA). ``record_call`` adds each call to ``run["timing"]``: ``calls`` / ``call_s`` (as before),
  ``by_ai`` {slot: {calls, s, failed}} and ``by_step`` {step id: {calls, s}}. Runs saved before P28 have the totals
  only; their calls show as "an AI (not recorded which)". The run's wall time comes from ``started_at`` /
  ``finished_at`` and each step's own times.
* **The journal (counted).** Work outside runs (✨ Fill with AI, 🧐 AI review, ✍ Write all chapters, 📊 reports …) is
  not timed, but the book journal (journal.py) names the AI of every piece of AI work: those entries are counted per AI
  (what was written, reviewed, fixed, edited, checked).
* **Tokens and money.** The provenance of each AI-written version holds the input/output tokens of that call; with
  per-token prices set on a slot (Settings, K12 cost control) BookForge shows the money too. Web AIs through
  AutoInjector cost 0 and report no tokens, so only calls and minutes are shown for them.

``estimate`` (before a run): the number of AI calls a run of this length and pipeline makes (a model per step, the
same order as autobook.STEPS; measured calls per step of earlier runs replace the model's guesses when there are
some), times the measured average seconds per AI call of the last finished runs (a first guess of
``DEFAULT_CALL_S`` without any), plus BookForge's own time between calls (the measured share, or ``OVERHEAD``). The
result is a range: fixes, retries and waiting for a busy AI make runs longer, never shorter.
"""
from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timezone

from . import lengths as lengths_mod
from . import pipeline as pipeline_mod

log = logging.getLogger("bookforge.costs")

UNKNOWN_AI = "?"            # calls of runs saved before P28 (no slot recorded)
DEFAULT_CALL_S = 45.0        # first guess for one web AI answer, before any run was measured
OVERHEAD = 1.15              # BookForge's own work between AI calls (saving, checks, backups), as a share
RUNS_MEASURED = 10           # how many finished runs the averages look at
RANGE = (0.8, 1.6)           # low / high around the expected value (fixes and waits only make a run longer)
MIN_CALLS_FOR_AVG = 5        # a run with fewer measured calls says nothing about the average

# Expected AI calls per run step (full pipeline, one AI writing and another reviewing), from fake-AI runs and the
# step code in autobook.py. "per chapter" steps are multiplied by the chapter count, "per character" ones by
# CHARACTERS. Measured calls per step of earlier runs (scaled to this book's chapters) replace these.
CHARACTERS = 4
STEP_MODEL = {
    "profile": {"fixed": 1},
    "canon": {"fixed": 3, "per_character": 2},          # Bible Builder drafts + one review per draft
    "characters": {"per_character": 0.5, "flag": "voices"},  # often made with the character (then 0 calls)
    "world": {"fixed": 2, "flag": "rules"},             # story rules + world texture
    "premise": {"fixed": 2},
    "plot": {"fixed": 2},
    "outline": {"fixed": 3},                            # outline, review, story-rules update
    "chapters": {"per_chapter": 2},                     # context + prose review; writing, scenes, editor added below
    "planned": {"per_chapter": 0},                      # deterministic book-level step (the AI check is per chapter)
    "format": {}, "assemble": {}, "export": {}, "check": {},
    "report": {"fixed": 2},                             # the AIs that did not write the book
}
PER_CHAPTER_EXTRA = {"scenes": 2, "editor": 2, "planned": 1}   # scene plan + check, two editors (P36), planned check
FIX_SHARE = 0.25            # expected AI fix rounds per reviewed chapter (some chapters need one)
STEP_LABELS = {"profile": "Invent the book", "canon": "Characters and places", "characters": "Character sheets and "
               "voices", "world": "Story rules and world texture", "premise": "Premise", "plot": "Main plot",
               "outline": "Chapter outline", "chapters": "Write every chapter", "planned": "Planned details on the page",
               "format": "Book format", "assemble": "Put the book together", "export": "Export", "check": "Content check",
               "report": "Book report", None: "Before the steps"}

# journal entry kinds that are AI work, and their plain words
JOURNAL_KINDS = {"ai": "wrote", "ai_review": "reviewed", "ai_fix": "fixed", "editor": "edited", "scenes": "planned scenes",
                 "planned": "checked the plan", "characters": "character sheets", "world": "rules and texture"}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _secs(a: str | None, b: str | None = None) -> float:
    if not a:
        return 0.0
    try:
        t0 = datetime.strptime(a, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        t1 = datetime.strptime(b, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) if b else datetime.now(timezone.utc)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, (t1 - t0).total_seconds())


def _min(s: float) -> float:
    return round(float(s or 0) / 60.0, 1)


# ====================================================================== measuring (called from the run's AI clock)
def record_call(run: dict, secs: float, slot: str | None = None, ok: bool = True) -> None:
    """Add one timed AI call to ``run["timing"]`` (totals, per AI, per step). Numbers only; never raises."""
    t = run.setdefault("timing", {"calls": 0, "call_s": 0.0})
    secs = max(0.0, float(secs or 0.0))
    t["calls"] = int(t.get("calls") or 0) + 1
    t["call_s"] = round(float(t.get("call_s") or 0.0) + secs, 3)
    ai = (t.setdefault("by_ai", {})).setdefault(str(slot or UNKNOWN_AI), {"calls": 0, "s": 0.0, "failed": 0})
    ai["calls"] += 1
    ai["s"] = round(ai["s"] + secs, 3)
    if not ok:
        ai["failed"] += 1
    st = (t.setdefault("by_step", {})).setdefault(str(run.get("current") or "-"), {"calls": 0, "s": 0.0})
    st["calls"] += 1
    st["s"] = round(st["s"] + secs, 3)


# ====================================================================== one run
def run_costs(run: dict, label=None) -> dict:
    """Calls and minutes of one run: in total, per AI and per step (numbers only).
    ``label(slot_id) -> "AI-1 · Claude"`` names the AIs."""
    label = label or (lambda s: s)
    t = run.get("timing") or {}
    calls, call_s = int(t.get("calls") or 0), float(t.get("call_s") or 0.0)
    by_ai = dict(t.get("by_ai") or {})
    seen = sum(int(v.get("calls") or 0) for v in by_ai.values())
    if calls > seen:  # a run saved before P28 (or an older BookForge): the rest is not attributed
        rest = by_ai.setdefault(UNKNOWN_AI, {"calls": 0, "s": 0.0, "failed": 0})
        rest["calls"] = int(rest.get("calls") or 0) + calls - seen
        rest["s"] = round(float(rest.get("s") or 0) + max(0.0, call_s - sum(float(v.get("s") or 0)
                                                                            for v in by_ai.values())), 3)
    ais = []
    for sid, v in sorted(by_ai.items(), key=lambda kv: -float(kv[1].get("s") or 0)):
        n, s = int(v.get("calls") or 0), float(v.get("s") or 0)
        ais.append({"slot": None if sid == UNKNOWN_AI else sid,
                    "name": "an AI (not recorded which)" if sid == UNKNOWN_AI else (label(sid) or sid),
                    "calls": n, "minutes": _min(s), "seconds": round(s, 1), "failed": int(v.get("failed") or 0),
                    "avg_s": round(s / n, 1) if n else None})
    wall = _secs(run.get("started_at"), run.get("finished_at")) if run.get("started_at") else 0.0
    by_step = t.get("by_step") or {}
    steps = []
    for s in run.get("steps") or []:
        m = by_step.get(s.get("id")) or {}
        w = _secs(s.get("started_at"), s.get("finished_at")) if s.get("started_at") else 0.0
        if not (m or w):
            continue
        steps.append({"id": s.get("id"), "title": s.get("title"), "state": s.get("state"),
                      "calls": int(m.get("calls") or 0), "ai_minutes": _min(m.get("s") or 0), "minutes": _min(w)})
    chap = [float(x) for x in t.get("chapter_s") or [] if isinstance(x, (int, float))]
    return {"run_id": run.get("id"), "kind": run.get("kind"), "status": run.get("status"),
            "started_at": run.get("started_at"), "finished_at": run.get("finished_at"),
            "calls": calls, "ai_minutes": _min(call_s), "minutes": _min(wall),
            "ai_share": round(call_s / wall, 2) if wall >= 1 else None,
            "avg_call_s": round(call_s / calls, 1) if calls else None, "ais": ais, "steps": steps,
            "chapters": {"timed": len(chap), "avg_minutes": _min(sum(chap) / len(chap)) if chap else None},
            "length": (run.get("settings") or {}).get("length"), "measured": bool(t.get("by_ai"))}


# ====================================================================== one book
def _journal_counts(app, pid: str, branch: str, label) -> list[dict]:
    """AI work per AI from the book journal (counted, not timed): what each AI wrote, reviewed, fixed, edited…"""
    from . import journal  # noqa: PLC0415
    try:
        j = journal.build(app, pid, branch, limit=100000)
    except Exception:  # noqa: BLE001 - the page still shows the measured runs
        log.exception("could not read the journal for the costs page")
        return []
    per: dict[str, dict] = {}
    for e in j.get("entries") or []:
        ai = e.get("ai") or {}
        sid = ai.get("slot")
        if e.get("who") != "AI" or not sid or e.get("kind") not in JOURNAL_KINDS:
            continue
        row = per.setdefault(sid, {"slot": sid, "name": label(sid) or sid, "total": 0, "work": {}})
        word = JOURNAL_KINDS[e["kind"]]
        row["work"][word] = row["work"].get(word, 0) + 1
        row["total"] += 1
    return sorted(per.values(), key=lambda r: -r["total"])


def _tokens(app, pid: str, branch: str, label) -> list[dict]:
    """Input/output tokens of AI-written versions per AI (provenance), and money when the slot has prices."""
    try:
        rows = app.store.query("SELECT resource FROM provenance WHERE project_id=? AND branch_id=? AND transform='AI'",
                               (pid, branch))
    except Exception:  # noqa: BLE001
        return []
    prov = app.engine.providers
    prov = getattr(prov, "_base", prov)
    try:
        slots = {s["slot_id"]: s for s in prov.slots()}
    except Exception:  # noqa: BLE001
        slots = {}
    per: dict[str, dict] = {}
    for r in rows:
        try:
            res = json.loads(r["resource"]) if r["resource"] else {}
        except ValueError:
            continue
        sid = res.get("ai_slot")
        if not sid:
            continue
        row = per.setdefault(sid, {"slot": sid, "name": label(sid) or sid, "versions": 0, "input_tokens": 0,
                                   "output_tokens": 0, "cost_minor": 0})
        row["versions"] += 1
        row["input_tokens"] += int(res.get("input_tokens") or 0)
        row["output_tokens"] += int(res.get("output_tokens") or 0)
    for sid, row in per.items():
        s = slots.get(sid)
        try:
            row["cost_minor"] = prov.call_cost(s, row["input_tokens"], row["output_tokens"]) if s else 0
        except Exception:  # noqa: BLE001
            row["cost_minor"] = 0
    return sorted(per.values(), key=lambda r: -r["versions"])


def book_costs(app, pid: str, branch: str = "main") -> dict:
    """Every run of this book (measured), the AI work outside runs (journal, counted) and tokens/money (provenance)."""
    label = _labeler(app)
    runs, merged = [], {}
    for j in app.jobstore.list(kind="autobook", project_id=pid, limit=200):
        if (j.get("branch_id") or "main") != branch:
            continue
        rc = run_costs(j, label)
        runs.append(rc)
        for a in rc["ais"]:
            k = a["slot"] or UNKNOWN_AI
            m = merged.setdefault(k, {"slot": a["slot"], "name": a["name"], "calls": 0, "seconds": 0.0, "failed": 0})
            m["calls"] += a["calls"]
            m["seconds"] += a["seconds"]
            m["failed"] += a["failed"]
    for m in merged.values():
        m["minutes"] = _min(m["seconds"])
        m["seconds"] = round(m["seconds"], 1)
    other = []
    for j in app.jobstore.list(project_id=pid, limit=200):  # ✍ Write all chapters: wall time only (not timed per AI)
        if j.get("kind") == "write_all" and (j.get("branch_id") or "main") == branch:
            other.append({"run_id": j.get("id"), "kind": "write_all", "status": j.get("status"),
                          "started_at": j.get("started_at"), "finished_at": j.get("finished_at"),
                          "minutes": _min(_secs(j.get("started_at"), j.get("finished_at")))})
    runs.sort(key=lambda r: r.get("started_at") or "", reverse=True)
    tokens = _tokens(app, pid, branch, label)
    from .book_path import get_profile  # noqa: PLC0415
    prof = get_profile(app.store, pid)
    proj = app.store.project(pid)
    return {"project_id": pid, "branch_id": branch, "title": prof.get("title") or (proj["name"] if proj else pid),
            "at": _now(), "currency": proj["currency"] if proj is not None else None,
            "totals": {"runs": len(runs), "calls": sum(r["calls"] for r in runs),
                       "ai_minutes": round(sum(r["ai_minutes"] for r in runs), 1),
                       "minutes": round(sum(r["minutes"] for r in runs), 1),
                       "cost_minor": sum(t["cost_minor"] for t in tokens),
                       "tokens": sum(t["input_tokens"] + t["output_tokens"] for t in tokens)},
            "by_ai": sorted(merged.values(), key=lambda m: -m["seconds"]), "runs": runs, "other_jobs": other,
            "journal": _journal_counts(app, pid, branch, label), "tokens": tokens,
            "about": "Measured: every AI call of a ⚡ Make-a-book run is timed. Counted: AI work outside runs comes "
                     "from the book journal (not timed). Money only for AIs with per-token prices (web AIs cost 0)."}


def _labeler(app):
    review = getattr(app, "review", None)

    def label(sid):
        if not sid or sid == UNKNOWN_AI:
            return None
        try:
            return review.slot_label(sid) if review is not None else sid
        except Exception:  # noqa: BLE001
            return sid
    return label


# ====================================================================== estimate before a run
def _measured(app, limit: int = RUNS_MEASURED) -> dict:
    """Averages of the last finished runs: seconds per AI call, BookForge's overhead, calls per step (per chapter
    for the chapter steps)."""
    calls = secs = wall = 0.0
    steps: dict[str, list] = {}
    n = 0
    try:
        jobs = app.jobstore.list(kind="autobook", limit=200)
    except Exception:  # noqa: BLE001
        jobs = []
    for j in jobs:
        t = j.get("timing") or {}
        if j.get("status") != "done" or int(t.get("calls") or 0) < MIN_CALLS_FOR_AVG:
            continue
        n += 1
        calls += int(t["calls"])
        secs += float(t.get("call_s") or 0)
        wall += _secs(j.get("started_at"), j.get("finished_at"))
        chapters = max(1, len([i for s in j.get("steps") or [] if s.get("id") == "chapters"
                               for i in s.get("items") or []]))
        for sid, v in (t.get("by_step") or {}).items():
            per = float(v.get("calls") or 0) / (chapters if sid in ("chapters", "planned") else 1)
            steps.setdefault(sid, []).append(per)
        if n >= limit:
            break
    out = {"runs": n, "per_call_s": round(secs / calls, 1) if calls else None,
           "overhead": round(min(3.0, max(1.0, wall / secs)), 2) if secs >= 1 and wall else None,
           "steps": {k: sum(v) / len(v) for k, v in steps.items()}}
    return out


def estimate(app, body: dict | None) -> dict:
    """AI calls and minutes a Make-a-book run of this length and pipeline will probably take (a range)."""
    body = body if isinstance(body, dict) else {}
    length = body.get("length") if body.get("length") in lengths_mod.PRESETS else lengths_mod.DEFAULT
    prof = {"length": length}
    ch = body.get("chapters")
    if isinstance(ch, int) and not isinstance(ch, bool) and 1 <= ch <= 200:
        prof["chapters"] = ch
    flags = dict(pipeline_mod.PRESETS["full"])
    pl = body.get("pipeline")
    if isinstance(pl, dict) and isinstance(pl.get("flags"), dict):
        flags.update({k: bool(v) for k, v in pl["flags"].items() if k in pipeline_mod.FLAGS})
    elif isinstance(pl, (str, dict)):
        flags = dict(pipeline_mod.PRESETS.get(pl if isinstance(pl, str) else pl.get("preset"), flags))
    try:
        cfg = lengths_mod.settings(app.store)
    except Exception:  # noqa: BLE001
        cfg = dict(lengths_mod.DEFAULT_SETTINGS)
    plan = lengths_mod.chapter_plan(prof, None, cfg=cfg)
    n = plan["chapters"]
    write_calls = plan["scenes"] if plan["scene_by_scene"] else 1
    measured = _measured(app)
    ms = measured["steps"]
    rows, total = [], 0.0
    for sid, model in STEP_MODEL.items():
        if model.get("flag") and not flags.get(model["flag"], True):
            continue
        guess = model.get("fixed", 0) + model.get("per_character", 0) * CHARACTERS + model.get("per_chapter", 0) * n
        if sid == "chapters":
            per = write_calls + FIX_SHARE * (1 + write_calls)
            per += sum(v for k, v in PER_CHAPTER_EXTRA.items() if flags.get(k, True))
            guess += per * n
        basis = "model"
        if sid in ms and measured["runs"]:
            m = ms[sid] * (n if sid in ("chapters", "planned") else 1)
            if sid == "chapters":  # measured per chapter, rescaled when this book writes more scene calls per chapter
                m += max(0, write_calls - 1) * n * 0.5
            guess, basis = m, "measured"
        if guess <= 0:
            continue
        total += guess
        rows.append({"step": sid, "label": STEP_LABELS.get(sid, sid), "calls": int(round(guess)), "basis": basis})
    timed = bool(measured["per_call_s"])  # a run of instant answers (a test AI) says nothing about real ones
    per_call = measured["per_call_s"] if timed else DEFAULT_CALL_S
    overhead = measured["overhead"] or OVERHEAD
    calls = int(round(total))
    minutes = calls * per_call * overhead / 60.0
    lo, hi = RANGE
    return {"length": length, "label": plan["label"], "chapters": n, "words": plan["book_words"],
            "scene_by_scene": plan["scene_by_scene"], "flags": flags,
            "calls": {"expected": calls, "low": int(math.floor(calls * lo)), "high": int(math.ceil(calls * hi))},
            "minutes": {"expected": int(round(minutes)), "low": max(1, int(math.floor(minutes * lo))),
                        "high": max(1, int(math.ceil(minutes * hi)))},
            "per_call_s": round(per_call, 1), "overhead": overhead, "runs_measured": measured["runs"],
            "basis": "measured" if measured["runs"] else "first_guess", "steps": rows,
            "about": (f"From {measured['runs']} earlier run(s) on this computer: about {per_call:.0f} s per AI answer."
                      if timed else
                      f"A first guess (no run measured yet): about {per_call:.0f} s per AI answer. After your first "
                      "run the estimate uses your own AIs' measured times.")}


# ====================================================================== Markdown (download)
def render_markdown(c: dict) -> str:
    t = c.get("totals") or {}
    out = [f"# ⏱ Time and AI use — {c.get('title')}", "",
           f"- Runs: {t.get('runs', 0)} · AI calls (timed): {t.get('calls', 0)} · AI minutes: {t.get('ai_minutes', 0)}"
           f" · run minutes: {t.get('minutes', 0)}",
           "- Numbers only: this page never contains prompts, AI replies or your book's text.", "",
           "## Per AI (measured in runs)", "", "| AI | Calls | Minutes | Failed |", "|---|---|---|---|"]
    for a in c.get("by_ai") or []:
        out.append(f"| {a['name']} | {a['calls']} | {a['minutes']} | {a['failed']} |")
    out += ["", "## Runs", "", "| Started (UTC) | Status | Calls | AI minutes | Minutes |", "|---|---|---|---|---|"]
    for r in c.get("runs") or []:
        out.append(f"| {(r.get('started_at') or '')[:16].replace('T', ' ')} | {r.get('status')} | {r['calls']} | "
                   f"{r['ai_minutes']} | {r['minutes']} |")
    if c.get("journal"):
        out += ["", "## AI work counted from the journal", "", "| AI | Total | What |", "|---|---|---|"]
        for j in c["journal"]:
            what = ", ".join(f"{k} {v}" for k, v in j["work"].items())
            out.append(f"| {j['name']} | {j['total']} | {what} |")
    out.append("")
    return "\n".join(out)
