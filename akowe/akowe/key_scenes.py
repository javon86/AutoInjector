"""🎭 Key scenes written twice, the better version kept (run setting ``key_scene_versions``, on unless switched off).

Why (docs: "AI novel quality beyond eight", recommendation 13 — the Re3 approach): writing a few versions of a key
scene and keeping the one a separate judge prefers lifts the scenes that matter most. It multiplies the AI's cost, so
Akọwe does it only for the book's key chapters: the climax and the major setback of the story shape (for "Five
turning points" the major setback and the climax; the matching beats of the other shapes), or the last chapter when
the book has no shape — at most ``MAX_KEY`` per book, never chapter 1 (✍ first_page.py already writes two first
pages for it).

How, in a ⚡ Make-a-book run (autobook.py ``_s_chapters``, right after a key chapter's first draft is written and
before its polish, review and approval — the pattern of first_page.py: the writer drafts twice, another AI picks):

1. the WRITER of the draft (the same AI) writes ONE second version of the whole chapter with a different approach —
   a different way into the scene, another order of its moments or another place where the pressure peaks — from the
   same writing brief (point of view, tense, voices, rules, planned beats, promises), keeping what must happen;
2. Akọwe checks it (no AI): a real chapter (``MIN_WORDS``), not the same text, about the same length as the first
   (``LENGTH_MIN``–``LENGTH_MAX`` of it: judges favour longer text, so lengths are matched before comparing);
3. ⚖ an independent AI picks the better version head to head (pairwise.py: random order, both orders when two AIs
   work, ties allowed); when no other AI works, Akọwe's own signals decide (``signals``: AI-sounding phrases and the
   pattern checker's findings per 1 000 words — clearly fewer wins; else the first version stays);
4. the second version is kept only when it wins: it becomes the draft's next revision (Akọwe's checks must accept
   it, else the first comes back) and goes through the usual polish, review and approval. A tie keeps the first.

Never the author's own text. Bounded: per key chapter 1 writer answer + at most 2 judge answers; at most ``MAX_KEY``
chapters. Never holds up the book: an AI problem, a bad answer or any error → the first draft stays (a note). Counted
in the run forecast (run_forecast.py ``key_scene_versions``). Logs: codes and numbers only, never book text.
"""
from __future__ import annotations

import copy
import logging
import re
from datetime import datetime, timezone

from . import pairwise

log = logging.getLogger("akowe.key_scenes")

SETTING = "key_scene_versions"
MAX_KEY = 3
MIN_WORDS = 200
MAX_WORDS = 7000              # a longer chapter (written scene by scene) is not rewritten in one answer
LENGTH_MIN, LENGTH_MAX = 0.75, 1.3
SIGNAL_MARGIN = 1.0           # problems per 1 000 words the second version must have fewer of (no judge)
OPENING_CHARS = 700
# the story shapes' climax and major-setback beats (story_shape.TEMPLATES)
KEY_BEATS = ("climax", "major_setback", "act_two_turn", "all_is_lost", "finale", "ordeal", "resurrection",
             "pinch_two", "plot_turn_two")

_S = {"type": "string"}
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["approach", "text"],
          "properties": {"approach": _S, "text": _S}}
TASK = (
    "Task: write a SECOND VERSION of chapter {number} of this book — the whole chapter, about {words} words. It is "
    "one of the book's key chapters ({why}). A first version exists; its opening is in context.first_version_opening. "
    "Write the chapter with a DIFFERENT APPROACH: a different way into the scene, another order of its moments, or "
    "another place where the pressure peaks — not the same chapter reworded. Keep everything the chapter must do: "
    "follow context.chapter (its plan and instruction) and context.writing_brief exactly as for the chapter itself "
    "(point of view, tense, voices, story rules, planned beats, set-ups and payoffs, locked details); never invent "
    "names, places or facts the plan does not give; never reveal what the book reveals later. Return approach (one "
    "short line: how this version tells it) and text (the whole chapter, plain prose, starting with a '# ' title "
    "line like the first version). Return only the JSON object.")
CRITERIA = [
    "Which version of this key chapter is the better read: real peril and cost, choices that matter, a scene shown "
    "rather than summarized, a moment that lands, characters who sound like themselves.",
    "Both versions must do what the plan asks; prefer the one that does it with more force and surprise.",
]


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _words(t: str) -> int:
    return len(re.findall(r"\S+", t or ""))


def enabled(run: dict) -> bool:
    return pairwise.enabled(run, SETTING)


# ====================================================================== the pure part
def key_chapters(n: int, beats: list[dict] | None = None) -> list[dict]:
    """The key chapters of a book of ``n`` chapters: [{number, why}] — the climax / major-setback beats of the story
    shape (``beats``: [{id, name, number}]) when it has one, else the last chapter. Never chapter 1, at most
    ``MAX_KEY``, in book order."""
    if n < 2:
        return []
    out: dict[int, str] = {}
    for b in beats or []:
        num = b.get("number")
        if b.get("id") in KEY_BEATS and isinstance(num, int) and 2 <= num <= n and num not in out:
            out[num] = str(b.get("name") or "a key turn")
    if not out:
        out[n] = "the last chapter"
    keep = sorted(out)[-MAX_KEY:]
    return [{"number": k, "why": out[k]} for k in keep]


def check_version(first: str, second: str) -> str | None:
    """Why the second version cannot be compared (a code), or None when it can."""
    a, b = " ".join(str(first or "").split()), " ".join(str(second or "").split())
    wa, wb = _words(a), _words(b)
    if wb < MIN_WORDS:
        return "TOO_SHORT"
    if a == b:
        return "SAME"
    if wa and not (LENGTH_MIN <= wb / wa <= LENGTH_MAX):
        return "LENGTH"
    return None


def problems_per_1000(text: str, names=()) -> float:
    """Akọwe's own signals (no AI): AI-sounding phrases, clichés and the pattern checker's findings (major ×2) per
    1 000 words."""
    from . import originality, prose_audit  # noqa: PLC0415
    w = max(1, _words(text))
    try:
        ai = originality.counts(text)
    except Exception:  # noqa: BLE001
        ai = 0
    try:
        s = (prose_audit.audit(text, names=names) or {}).get("summary") or {}
        pat = 2 * int(s.get("major") or 0) + int(s.get("minor") or 0)
    except Exception:  # noqa: BLE001
        pat = 0
    return round((ai + pat) * 1000.0 / w, 2)


def signals(first: str, second: str, names=()) -> str:
    """'a' / 'b' / 'tie' by Akọwe's own signals: the second wins only with clearly fewer problems."""
    pa, pb = problems_per_1000(first, names), problems_per_1000(second, names)
    if pb + SIGNAL_MARGIN <= pa:
        return "b"
    if pa + SIGNAL_MARGIN <= pb:
        return "a"
    return "tie"


# ====================================================================== the run (autobook.py _s_chapters)
def _plan(runner, run, outline, chapters) -> list[dict]:
    """The key chapters of this outline revision (stored in the run, once per revision)."""
    from . import story_shape  # noqa: PLC0415
    mem = run.setdefault("key_scenes", {"chapters": {}})
    key = f"{outline['record_id']}:{outline['version']}"
    if mem.get("plan_for") != key:
        beats = None
        try:
            m = story_shape.mapping(runner.store, run["project_id"], run["branch_id"], outline)
            beats = (m or {}).get("beats")
        except Exception:  # noqa: BLE001
            log.debug("key scenes: no story shape", exc_info=True)
        ks = key_chapters(len(chapters), beats)
        for k in ks:
            k["chapter_id"] = chapters[k["number"] - 1]["chapter_id"]
        mem.update(plan_for=key, plan=ks)
    return mem.get("plan") or []


def after_draft(runner, run: dict, st: dict, outline: dict, chapters: list[dict], cid: str, number: int, rid: str,
                item: dict | None = None) -> dict | None:
    """🎭 For a key chapter's fresh AI draft: one second version with a different approach, a head-to-head pick, the
    winner kept. Returns the chapter's row (``run["key_scenes"]["chapters"][cid]``) or None (off, not a key chapter,
    done before). Raises only the run's pause / cancel."""
    if not enabled(run):
        return None
    try:
        plan = {k["chapter_id"]: k for k in _plan(runner, run, outline, chapters)}
    except Exception:  # noqa: BLE001
        log.exception("key scenes: could not list the key chapters")
        return None
    if cid not in plan:
        return None
    mem = run["key_scenes"]
    if cid in mem["chapters"]:
        return None  # once per chapter (also after a pause or a redo)
    row = mem["chapters"][cid] = {"number": number, "why": plan[cid]["why"], "state": "asking", "at": _now()}
    runner.save(run)
    try:
        _work(runner, run, row, outline, cid, number, rid, item)
    except Exception as exc:  # noqa: BLE001 - help, never a reason to stop the book
        if pairwise._control(exc):  # noqa: SLF001
            mem["chapters"].pop(cid, None)  # asked again after the pause
            raise
        code = getattr(exc, "code", None) or type(exc).__name__
        log.warning("key scenes of run %s: chapter %s stopped (%s)", run.get("id"), number, code)
        row.update(state="failed", kept="first", code=code)
        runner.event(run, "note", f"⚠️ 🎭 Chapter {number}: the second version could not be finished ({code}); the "
                     "first draft stays", step="chapters", code="KEY_SCENE_FAILED", chapter_id=cid)
    runner.save(run)
    return row


def _not_used(runner, run, row, cid, number, code, why):
    row.update(state="not_used", kept="first", code=code)
    runner.event(run, "note", f"🎭 Chapter {number}: {why}; the first draft stays", step="chapters",
                 code="KEY_SCENE_NOT_USED", chapter_id=cid)


def _work(runner, run, row, outline, cid, number, rid, item):
    from . import ai_activity, chapter_brief, chapter_polish  # noqa: PLC0415
    from .assist import book_profile_brief  # noqa: PLC0415
    from .errors import AkoweError  # noqa: PLC0415
    store, pid, branch = runner.store, run["project_id"], run["branch_id"]
    bp = runner.bp(run)
    head = bp.rec(rid)
    if head is None or head.get("module_id") != "C02" or not runner._ai_made(run, head):  # noqa: SLF001
        row.update(state="not_ai_text", kept="first")
        return
    first = str((head.get("data") or {}).get("text") or "")
    wa = _words(first)
    if wa > MAX_WORDS or wa < MIN_WORDS:  # written scene by scene / not a real chapter: no second version
        row.update(state="too_long" if wa > MAX_WORDS else "too_short", kept="first",
                   code="TOO_LONG" if wa > MAX_WORDS else "TOO_SHORT")
        return
    writer = (runner._review.writer_of(pid, branch, head) or {}).get("slot")  # noqa: SLF001
    brief, _meta = chapter_brief.build(store, pid, branch, outline, cid, use_needs=True)
    ch = next((c for c in bp.outline_chapters(outline) if c["chapter_id"] == cid), {}) or {}
    ctx = {"akowe_task": "key_scene_version", "book_profile": book_profile_brief(store, pid),
           "chapter": {"number": number, "chapter_id": cid, "objective": str(ch.get("objective") or "")[:600],
                       "summary": str(ch.get("summary") or "")[:600]},
           "first_version_opening": first[:OPENING_CHARS]}
    if brief:
        ctx["writing_brief"] = brief
    # 1. the writer: one second version
    runner.check(run)
    job = runner._sub_job(run, "key_scene", rid, writer or run["settings"].get("slot_id"))  # noqa: SLF001
    task = TASK.format(number=number, words=f"{wa:,}", why=row["why"])
    try:
        with ai_activity.doing(f"Writing a second version of chapter {number}",
                               done=f"Wrote a second version of chapter {number}", chapter=number):
            raw = runner._assist._call_ai(job, op_for_roles="C02", task=task, schema=SCHEMA, context=ctx,  # noqa: SLF001
                                          protected=[])
    except AkoweError as exc:
        if pairwise._control(exc):  # noqa: SLF001
            raise
        return _not_used(runner, run, row, cid, number, exc.code, f"the second version could not be written now "
                         f"({exc.code})")
    second = str((raw or {}).get("text") or "").strip() if isinstance(raw, dict) else ""
    bad = check_version(first, second)
    if bad:
        why = {"TOO_SHORT": "the writer gave no usable second version", "SAME": "the second version was the same text",
               "LENGTH": "the second version's length was too far from the first"}[bad]
        return _not_used(runner, run, row, cid, number, bad, why)
    row.update(words=[wa, _words(second)], approach=str((raw or {}).get("approach") or "")[:160],
               writer=job.slot or writer)
    # 2. head to head: an independent AI (both orders when two work), else Akọwe's own signals
    res = {"winner": None}
    if pairwise.enabled(run):
        res = pairwise.pick(runner, run, first, second, what=f"chapter {number} of a book, a key chapter ({row['why']})",
                            criteria=CRITERIA, writer_slot=job.slot or writer, rid=rid,
                            extra={"chapter": ctx["chapter"], "book_profile": ctx["book_profile"]})
    if res.get("winner") is not None:
        winner, how = res["winner"], f"{pairwise.who(res)} (head to head)"
    else:
        try:
            names = runner._review.editor.names(pid, branch)  # noqa: SLF001
        except Exception:  # noqa: BLE001
            names = []
        winner, how = signals(first, second, names), "Akọwe's own checks (no other AI could judge)"
    row.update(winner=winner, how="ai" if res.get("winner") is not None else "signals", judges=res.get("judges", 0))
    if winner != "b":
        row.update(state="first_kept", kept="first")
        runner.event(run, "note", f"🎭 Chapter {number} ({row['why']}): two versions were written; {how} "
                     + ("found them equally good" if winner == "tie" else "preferred the first") + ", so the first "
                     "stays", step="chapters", code="KEY_SCENE_FIRST", chapter_id=cid)
        return
    # 3. the second version becomes the draft's next revision (Akọwe's checks must accept it)
    data = copy.deepcopy(head.get("data") or {})
    data["text"] = second
    r = bp.dispatch("C02", "UPDATE", base_ref=head["ref"], payload=data)
    if r.get("status") != "DRAFT" or not r.get("output_refs"):
        return _not_used(runner, run, row, cid, number, "REFUSED", "Akọwe's checks refused the second version")
    runner._made(run, r["output_refs"][0])  # noqa: SLF001
    if not chapter_polish._validates(runner, run, rid):  # noqa: SLF001
        try:
            back = runner._review.editor.restore(run["principal"], pid, branch, rid, head, "KEY_SCENE_CHECKS")  # noqa: SLF001
            runner._made(run, back)  # noqa: SLF001
        except AkoweError:
            log.warning("key scenes: the first draft could not be put back for run %s", run.get("id"))
        return _not_used(runner, run, row, cid, number, "CHECKS_REFUSED", "Akọwe's checks refused the second version")
    row.update(state="second_kept", kept="second", version=r["output_refs"][0]["version"])
    runner.event(run, "note", f"🎭 Chapter {number} ({row['why']}): two versions were written; {how} preferred the "
                 "second (a different approach), so it is kept", step="chapters", code="KEY_SCENE_SECOND",
                 chapter_id=cid, record_id=rid)
    if item is not None:
        item["key_scene"] = {"kept": "second"}


def line(run: dict) -> str | None:
    """'🎭 Key scenes written twice: chapters 5 and 6; the second version was kept in chapter 6.' or None."""
    rows = sorted(((run.get("key_scenes") or {}).get("chapters") or {}).values(), key=lambda r: r.get("number") or 0)
    tried = [r for r in rows if r.get("state") in ("first_kept", "second_kept")]
    if not tried:
        return None
    nums = [str(r["number"]) for r in tried]
    said = nums[0] if len(nums) == 1 else ", ".join(nums[:-1]) + " and " + nums[-1]
    kept = [str(r["number"]) for r in tried if r.get("kept") == "second"]
    tail = (f"the second version was kept in chapter{'s' if len(kept) > 1 else ''} {', '.join(kept)}" if kept
            else "the first version was kept each time")
    return f"🎭 Key scenes written twice (chapter{'s' if len(nums) > 1 else ''} {said}): {tail}."


def to_report(runner, run: dict, rep: dict | None) -> None:
    pairwise.add_report_line(runner, run, rep, "key_scenes", line(run))
