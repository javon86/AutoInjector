"""✋ Keep briefs and stopping rules: every AI rewrite of a chapter is told what is GOOD and must stay, and a revision
that does not make the chapter better ends the revising.

Why (docs: "AI novel quality beyond eight", recommendation 8): revising without guardrails turns 8.0 into a treadmill —
a fix of one problem cuts the chapter's best lines, a "fixed" chapter becomes the new weakest one, scores go 9→8→9
(NousResearch autonovel: each rewrite brief quotes the chapter's strongest sentences under "what to keep", and the
loop has stopping rules).

What it does in a ⚡ Make-a-book run (run setting ``keep_briefs``, on unless switched off):

1. **The KEEP list** (``collect``, no AI call): the chapter's strongest lines, copied word for word, from what already
   exists — the chapter reviewer's ``keep`` (one optional field of the normal review of a chapter, see
   ``review_schema``; no extra AI call), the editor's keep quotes (editor.py craft reviews of any version of the
   chapter) and the quotes the whole-book reviewers praised (book report strengths). Only lines that are in the
   chapter word for word count; at most ``MAX_KEEP``.
2. **Every rewrite gets it** (``arm`` — set on the rewrite's job; a line the rewrite is asked to change is left out):
   the review fix and the checks repair (review.py ``_run_fix``: ``fix_part`` adds ``context.keep`` and the rule), and
   the editor's P5 rewrites, the planned-to-page fixes, the ending fixes and the improve pass (editor.py ``propose``:
   ``for_propose`` adds them to the editor's own keep list, so a replacement that would cut one is refused).
3. **Checked after the rewrite**: a review fix that drops a KEEP line is refused and the earlier version stays
   (``guard_fix``, ⚠️ KEEP_LOST, and the next fix is told exactly which line to keep); a replacement that would cut one
   is not applied (``after_propose``, ⚠️ KEEP_SAVED).
4. **Stopping rules** (built on the existing caps — MAX_FIXES review fixes, MAX_REPAIRS check repairs, the editor's
   rounds and its "nothing got worse" judge, planned.ROUNDS, ending_check.FIX_ROUNDS, the improve pass that ends on
   a round with no gain, the 🔁 loop detection): a review fix that changes only spacing, punctuation or capitals is
   refused and ends the fixing of that version (⚠️ FIX_COSMETIC — the objection is decided now, as when the fixes are
   used up); an editor rewrite that was kept but raised no score and removed no major note ends the editor's rounds
   (⚠️ EDITOR_NO_GAIN, ``editor_stop``).

Never holds up the book: anything that goes wrong here leaves the rewrite exactly as before. Journal lines and logs
carry codes and numbers only (the KEEP lines themselves go only to the AI, never to a log).
"""
from __future__ import annotations

import copy
import logging
import re

log = logging.getLogger("akowe.keep_brief")

MAX_KEEP = 6                   # KEEP lines given to one rewrite
REVIEW_KEEP = 5                # lines the chapter reviewer may name
QUOTE_MIN, QUOTE_MAX = 12, 300
REWRITE_KINDS = ("fix", "repair", "editor_fix", "planned_fix", "ending_fix", "improve")
FLAG_KEY = "keep_briefs:{pid}:{branch}"
SETTING = "keep_briefs"

REVIEW_TASK = (
    " keep (chapters only): up to 5 of the chapter's strongest lines or moments — the ones a revision must not lose — "
    "each copied EXACTLY, character for character, from the chapter text (one sentence or a short passage, at most "
    "300 characters). Leave it empty when nothing stands out; never list a line you ask to change.")
KEEP_PROPERTY = {"type": "array", "maxItems": REVIEW_KEEP, "items": {"type": "string", "maxLength": QUOTE_MAX}}
FIX_RULE = (
    " context.keep lists the chapter's strongest lines (KEEP): every one must be in your revision word for word — fix "
    "the problems around them (change HOW the scene gets there, not these lines). A revision that drops a KEEP line is "
    "refused. A revision must really change what the review asks; changing only punctuation or spacing is refused.")
COSMETIC_RULE = (" A revision must really change what the review asks; changing only punctuation or spacing is "
                 "refused.")
PROPOSE_RULE = (
    " context.keep also lists the chapter's strongest lines (KEEP): never cut or reword one; work around them.")
_PUNCT_WORDS = ("punctuation", "comma", "quotation mark", "quote mark", "dash", "hyphen", "spacing", "capital",
                "full stop", "period", "semicolon", "colon", "apostrophe", "italic", "paragraph break")
_Q = re.compile(r"[“\"‘']([^“”\"‘’']{%d,})[”\"’']" % QUOTE_MIN)


# ====================================================================== settings
def clean_run_option(body: dict) -> dict:
    """``keep_briefs`` from a ⚡ start body: on unless switched off."""
    from .errors import AkoweError  # noqa: PLC0415
    v = (body or {}).get(SETTING, True)
    if not isinstance(v, bool):
        raise AkoweError("INVALID_INPUT", f"/{SETTING}", f"{SETTING} must be true or false", status="REJECTED")
    return {SETTING: v}


def on(run: dict | None) -> bool:
    return ((run or {}).get("settings") or {}).get(SETTING) is not False


def note_run(store, run: dict) -> None:
    """Remember for the book whether this run uses keep briefs (the chapter reviewer reads it). Never raises."""
    try:
        store.set_setting(FLAG_KEY.format(pid=run["project_id"], branch=run["branch_id"]),
                          {"on": on(run), "run": run.get("id")})
    except Exception:  # noqa: BLE001
        log.exception("could not note the keep-brief setting")


def book_on(store, pid: str, branch: str) -> bool:
    """True once a ⚡ run with keep briefs on has started this book's chapters (a book no run made: nothing changes)."""
    try:
        v = store.get_setting(FLAG_KEY.format(pid=pid, branch=branch))
        return isinstance(v, dict) and v.get("on") is True
    except Exception:  # noqa: BLE001
        return False


# ====================================================================== the KEEP lines
def _norm(s: str) -> str:
    s = str(s or "").replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    return re.sub(r"\s+", " ", s).strip()


def _words(s: str) -> list[str]:
    return re.findall(r"[^\W_]+", str(s or "").lower())


def _usable(q, text: str) -> str | None:
    """The quote itself when it is a usable KEEP line of ``text`` (in it word for word, not too short or long)."""
    if not isinstance(q, str):
        return None
    q = q.strip()
    if not QUOTE_MIN <= len(q) <= QUOTE_MAX or len(_words(q)) < 3 or not text or q not in text:
        return None
    return q


def merge(quotes, text: str, n: int = MAX_KEEP) -> list[str]:
    """Usable quotes, each once, a quote inside another longer one dropped, at most ``n``."""
    out: list[str] = []
    for q in quotes or []:
        q = _usable(q, text)
        if not q or any(q in o for o in out):
            continue
        out = [o for o in out if o not in q] + [q]
    return out[:n]


def clean_keep(raw, text: str) -> list[str]:
    """The reviewer's ``keep`` answer → the lines that are really in the chapter (≤ REVIEW_KEEP)."""
    v = raw.get("keep") if isinstance(raw, dict) else None
    return merge(v if isinstance(v, list) else [], text, REVIEW_KEEP)


def review_schema(base: dict) -> dict:
    """The chapter reviewer's schema with the optional ``keep`` field."""
    s = copy.deepcopy(base)
    s.setdefault("properties", {})["keep"] = copy.deepcopy(KEEP_PROPERTY)
    return s


def _by_record(store, key: str, rid: str) -> list[dict]:
    """Stored opinions of one record ("<rid>:<version>" keys), newest version first."""
    cur = store.get_setting(key) or {}
    rows = []
    for k, v in (cur.items() if isinstance(cur, dict) else []):
        head, _sep, ver = str(k).rpartition(":")
        if head == rid and ver.isdigit() and isinstance(v, dict):
            rows.append((int(ver), v))
    return [v for _n, v in sorted(rows, key=lambda x: -x[0])]


def _praised(store, pid: str, branch: str) -> list[str]:
    """Quotes the whole-book reviewers gave as strengths (the latest book report)."""
    cur = store.get_setting(f"book_reports:{pid}:{branch}") or {}
    reps = cur.get("reports") if isinstance(cur, dict) else None
    if not reps or not isinstance(reps[-1], dict):
        return []
    rep = reps[-1]
    pts = list((rep.get("aggregate") or {}).get("strengths") or []) + list(rep.get("strengths") or [])
    return [p.get("quote") for p in pts if isinstance(p, dict) and p.get("quote")]


def collect(store, pid: str, branch: str, rid: str, text: str) -> list[str]:
    """The chapter's KEEP lines from what exists: the chapter reviewer's keep, the editor's keep quotes, the book
    report's praised quotes (in that order; newest versions first). Never raises."""
    quotes: list = []
    try:
        for r in _by_record(store, f"ai_reviews:{pid}:{branch}", rid):
            quotes += list(r.get("keep") or [])
        for c in _by_record(store, f"craft_reviews:{pid}:{branch}", rid):
            quotes += list(c.get("keep_quotes") or c.get("keep") or [])
        quotes += _praised(store, pid, branch)
    except Exception:  # noqa: BLE001
        log.exception("could not gather the keep lines")
    return merge(quotes, text)


def asked_to_change(q: str, strings=(), text: str = "", passages=()) -> bool:
    """True when the rewrite is asked to change this line: a review point or check quotes it (or a part of it), or a
    flagged passage overlaps it in the text."""
    nq = _norm(q).lower()
    for s in strings or []:
        ns = _norm(s).lower()
        if nq and nq in ns:
            return True
        for frag in _Q.findall(_norm(s)):
            nf = _norm(frag).lower()
            if nf and (nf in nq or nq in nf):
                return True
    i = text.find(q) if text else -1
    for p in passages or []:
        if not p:
            continue
        if p in q or q in p:
            return True
        j = text.find(p) if text else -1
        if i >= 0 and j >= 0 and i < j + len(p) and j < i + len(q):
            return True
    return False


# ====================================================================== on a rewrite's job
def _stats(run: dict) -> dict:
    return run.setdefault("keep_brief", {"refused": 0, "saved": 0, "stopped": 0})


def arm(svc, run: dict, job, kind: str, rid: str) -> None:
    """Give a chapter rewrite's job its KEEP lines and the run's note callbacks. Nothing for a rewrite kind this
    does not cover, a run with keep briefs off, or anything that is not an AI-made chapter. Never raises."""
    try:
        if kind not in REWRITE_KINDS or not on(run):
            return
        rec = svc.bp(run).rec(rid)
        if not rec or rec.get("module_id") != "C02" or not svc._ai_made(run, rec):  # noqa: SLF001
            return
        pid, branch = run["project_id"], run["branch_id"]
        meta = svc.store.get_state(pid, branch, "c_meta", rid) or {}
        cid = meta.get("chapter_id") or meta.get("unit_id")
        label = f"chapter {cid}" if cid else "chapter"
        job.keep_kind = kind
        job.keep_lines = collect(svc.store, pid, branch, rid, str((rec.get("data") or {}).get("text") or ""))
        job.keep_label = label

        def note(code: str, message: str, what: str | None = None):
            try:
                if what:
                    _stats(run)[what] = int(_stats(run).get(what) or 0) + 1
                svc.event(run, "note", message, record_id=rid, code=code)
            except Exception:  # noqa: BLE001
                log.exception("keep-brief note")
        job.keep_note = note
        if kind == "fix":
            def stop():  # the stopping rule: this version's objection is decided now (as when the fixes are used up)
                from .autobook import MAX_FIXES  # noqa: PLC0415
                run.setdefault("fix_counts", {})[rid] = MAX_FIXES
            job.keep_stop = stop
    except Exception:  # noqa: BLE001
        log.exception("could not arm the keep brief")


def _note(job, code: str, message: str, what: str | None = None) -> None:
    fn = getattr(job, "keep_note", None)
    if callable(fn):
        fn(code, message, what)


def fix_part(job, rec: dict, review: dict, checks=()) -> tuple[dict, str, list[str]] | None:
    """For review.py ``_run_fix``: (extra context, task words, the KEEP lines) or None when the job is not armed or
    this is not a chapter. The lines the review or Akọwe's checks ask to change are left out."""
    try:
        if not getattr(job, "keep_kind", None) or rec.get("module_id") != "C02":
            return None
        text = str((rec.get("data") or {}).get("text") or "")
        asked = [*(review.get("reasons") or []), *(review.get("suggested_changes") or []), *(checks or [])]
        keep = [q for q in merge(getattr(job, "keep_lines", None) or [], text) if not asked_to_change(q, asked)]
        task = FIX_RULE if keep else (COSMETIC_RULE if job.keep_kind == "fix" else "")
        return ({"keep": keep} if keep else {}), task, keep
    except Exception:  # noqa: BLE001
        log.exception("keep brief of a fix")
        return None


def cosmetic(old: str, new: str) -> bool:
    """Only spacing, punctuation or capitals changed (the same words in the same order)."""
    return _words(old) == _words(new)


def _about_punctuation(review: dict) -> bool:
    s = " ".join(str(x) for x in [*(review.get("reasons") or []), *(review.get("suggested_changes") or [])]).lower()
    return any(w in s for w in _PUNCT_WORDS)


def guard_fix(job, rec: dict, payload: dict, keep: list[str], review: dict) -> None:
    """After the fixer answered, before anything is saved: a revision that drops a KEEP line, or (a review fix) one
    that changes only spacing / punctuation, is refused (AkoweError; the earlier version stays). No-op otherwise."""
    from .errors import AkoweError  # noqa: PLC0415
    try:  # never holds up the book: a bug in the check lets the fix through unchanged (only the refusals below raise)
        found = _guard_check(job, rec, payload, keep, review)
    except Exception as exc:  # noqa: BLE001
        if getattr(exc, "control", False):
            raise
        log.exception("keep check of a fix")
        return
    if not found:
        return
    lost, label = found
    if lost:
        _note(job, "KEEP_LOST", f"⚠️ The AI's fix of the {label} cut {len(lost)} line(s) it was told to keep, so it "
                                "was not saved; the earlier version stays", "refused")
        err = AkoweError("INVALID_INPUT", "/payload", f"the revision dropped {len(lost)} line(s) it was told to keep, "
                         "so nothing was saved", status="REJECTED")
        err.check_problems = [f"KEEP_LOST: keep this line word for word: “{q[:200]}”" for q in lost]
        raise err
    # no line lost: the fix changed only spacing or punctuation
    _note(job, "FIX_COSMETIC", f"⚠️ The AI's fix of the {label} changed only spacing or punctuation, so it was not "
                               "saved and no more fixes are tried for this version", "stopped")
    stop = getattr(job, "keep_stop", None)
    if callable(stop):
        stop()
    raise AkoweError("INVALID_INPUT", "/payload", "the revision changed only spacing or punctuation, so nothing "
                     "was saved", status="REJECTED")


def _guard_check(job, rec: dict, payload: dict, keep: list[str], review: dict) -> tuple[list[str], str] | None:
    """For ``guard_fix``: None when the fix may be saved; else (the KEEP lines it dropped, the label) — an empty list
    means the fix changed only spacing or punctuation."""
    if not getattr(job, "keep_kind", None) or rec.get("module_id") != "C02":
        return None
    old = str((rec.get("data") or {}).get("text") or "")
    new = str((payload or {}).get("text") or "")
    if not new:
        return None
    label = getattr(job, "keep_label", "chapter")
    lost = [q for q in keep or [] if _norm(q) not in _norm(new)]
    if lost:
        return lost, label
    if job.keep_kind == "fix" and cosmetic(old, new) and not _about_punctuation(review or {}):
        return [], label
    return None


def for_propose(job, text: str, findings: list) -> list[str]:
    """For editor.py ``propose``: the KEEP lines of an armed rewrite that no flagged passage touches ([] otherwise)."""
    try:
        if not getattr(job, "keep_kind", None) or job.keep_kind == "fix":
            return []
        passages = [f.get("passage") for f in findings or [] if isinstance(f, dict)]
        asked = [f.get("why") for f in findings or [] if isinstance(f, dict)]
        keep = [q for q in merge(getattr(job, "keep_lines", None) or [], text)
                if not asked_to_change(q, asked, text, passages)]
        job.keep_used = keep
        return keep
    except Exception:  # noqa: BLE001
        log.exception("keep lines of a rewrite")
        return []


def after_propose(job, res: dict) -> None:
    """A replacement refused because it would cut a KEEP line: one ⚠️ note (the line stays as it was)."""
    try:
        if not getattr(job, "keep_used", None):
            return
        n = sum(1 for u in (res or {}).get("unresolved") or [] if u.get("reason") == "KEEP_LOST")
        if n:
            label = getattr(job, "keep_label", "chapter")
            _note(job, "KEEP_SAVED", f"⚠️ {n} change(s) the writer proposed for the {label} would have cut a line "
                                     "marked to keep, so they were not applied", "saved")
    except Exception:  # noqa: BLE001
        log.exception("keep lines after a rewrite")


# ====================================================================== the editor's stopping rule
def gained(old: dict | None, new: dict | None) -> bool:
    """Did the editor's scores get better: a higher average or lowest score, or fewer major notes?"""
    if not old or not new:
        return True
    try:
        return (float(new.get("avg_score") or 0) > float(old.get("avg_score") or 0)
                or float(new.get("min_score") or 0) > float(old.get("min_score") or 0)
                or int((new.get("counts") or {}).get("major") or 0) < int((old.get("counts") or {}).get("major") or 0))
    except (TypeError, ValueError):
        return True


def editor_stop(svc, run: dict, rid: str, label: str, old: dict | None, new: dict | None) -> str | None:
    """After a kept editor rewrite: the reason to stop the editor's rounds when it raised no score and removed no
    major note (and the editor still has notes), else None. Never raises."""
    try:
        if not on(run) or not new or new.get("verdict") == "PASS" or gained(old, new):
            return None
        _stats(run)["stopped"] = int(_stats(run).get("stopped") or 0) + 1
        svc.event(run, "note", f"⚠️ The editor's rewrite of the {label} was kept but did not raise its scores, so the "
                               "editor stops here (another round would only move the notes around)", record_id=rid,
                  code="EDITOR_NO_GAIN")
        return "the last rewrite did not raise the scores (stopping rule)"
    except Exception:  # noqa: BLE001
        log.exception("editor stopping rule")
        return None


# ====================================================================== the run's report line
def report_line(run: dict) -> str | None:
    s = (run or {}).get("keep_brief") or {}
    if not any(int(s.get(k) or 0) for k in ("refused", "saved", "stopped")):
        return None
    bits = []
    if s.get("refused"):
        bits.append(f"{s['refused']} fix(es) refused for cutting a line marked to keep")
    if s.get("saved"):
        bits.append(f"{s['saved']} rewrite(s) kept their marked lines")
    if s.get("stopped"):
        bits.append(f"{s['stopped']} revision(s) stopped because they did not improve the chapter")
    return "✋ Keep lists and stopping rules: " + "; ".join(bits) + "."
