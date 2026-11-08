"""🤖 Claude Code helpers inside a ⚡ Make-a-book run (and on the chapter page).

Where the helpers join the run (short, marked hook calls in autobook.py, checkpoints.py and modules/set_c.py):

* **A chapter starts being written** (``chapter_started``): research ahead for the next three chapters (their plans
  and scene cards) runs in the background. The notes are saved and handed to those chapters' writers as
  ``writing_brief.research_notes`` (``add_to_brief``), each labelled established fact / disputed / legend / invented
  for the story, with its source.
* **A draft is written** (``draft_written``): the chapter's fact check (real sources) starts in the background while
  the reviewers read it.
* **The all-AI check of a chapter, a checkpoint, "Check consistency now"** (``checks_start`` in
  checkpoints._read_part_by_all): the helpers check by kind — continuity and voices (no tools) and facts (web) —
  side by side, while the web AIs read one after another. Their problems go into the SAME per-AI result
  (``part["by_ai"]``) that cross_check.merge reads, so the agreement rules, the fixes, the reports and check-now are
  unchanged. Claude Code counts as Claude (the same family as the Claude pane): when Claude did NOT write the chapter,
  the helpers read for Claude in the per-chapter check (the Claude pane is not asked; if the helpers fail, it is asked
  as before); when Claude DID write it, the helpers only add the fact check, folded into Claude's own reading, and
  the independent reviews stay with the other AIs (the writer never reviews itself).
* **A chapter is approved** (``chapter_approved``): its fact check (if the text changed) and the "sounds like AI"
  pass run in the background. Wrong facts with a fix and the AI-tell rewrites become PROPOSALS on the chapter page:
  ✔ Use saves them as a new draft through the editor's usual apply path (the author approves it like any draft).
  Nothing is ever changed silently, and lines with a locked detail are never proposed.

Every hook falls back: Claude Code off / missing / signed out / limited / failing -> the hook does nothing and the run
goes on exactly as before. Hooks never raise (except the run's own pause / cancel while the checks wait).

Speed is measured: each check records how long it took side by side, how long the same reads would take one after
another, and the old way's estimate (``run["timing"]["helpers"]``, shown in the run's costs and report).
"""
from __future__ import annotations

import concurrent.futures as cf
import hashlib
import json
import logging
import threading
import time
from datetime import datetime, timezone

from . import ai_activity
from . import claude_code as cc
from . import claude_code_jobs as jobs
from .errors import AkoweError

log = logging.getLogger("akowe.claude_code_book")

NAME = "Claude Code helpers"
PSEUDO_SLOT = "claude-code"
RESEARCH_AHEAD = 3
BRIEF_CHARS = 2500
FINISH_WAIT_S = 45.0       # after the web AIs' reads, the check waits at most this long for the helpers
COVER_WAIT_MIN_S = 90.0    # reading for Claude: wait at least this long (or twice the slowest web read) before the
#                            Claude pane reads it after all
RESEARCH_KEY = "cc_research:{pid}:{branch}"
PROPOSALS_KEY = "cc_proposals:{pid}:{branch}"
BRIEF_RULE = ("Research notes (context.writing_brief.research_notes) were checked against real sources by a research "
              "helper. Use “established fact” notes freely; treat “disputed” ones as uncertain (a character may argue "
              "about them); present a “legend” only as what people say or believe, never as fact; an “invented for "
              "the story” note is this book's own invention. Never present an invented or legendary detail as "
              "historical fact.")

_POOL = cf.ThreadPoolExecutor(max_workers=8, thread_name_prefix="akowe-cc")
_LOCK = threading.Lock()
_RUNS: dict[str, dict] = {}
_FUTS: dict[tuple, cf.Future] = {}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _hash(text: str) -> str:
    return hashlib.sha1((text or "").encode("utf-8")).hexdigest()[:16]


# ====================================================================== the run option (Make-a-book start body)
def clean_run_option(body, store=None) -> dict:
    """``claude_code``: true / false for this run (empty = the Settings card decides). With ``store``: the helpers'
    status is looked up in the background now, so it is known before the first chapter."""
    v = (body or {}).get("claude_code") if isinstance(body, dict) else None
    if store is not None and v is not False:
        try:
            cc.available(store)
        except Exception:  # noqa: BLE001
            pass
    if v is None:
        return {}
    if not isinstance(v, bool):
        raise AkoweError("INVALID_INPUT", "/claude_code", "Claude Code helpers: true or false", status="REJECTED")
    return {"claude_code": v}


# ====================================================================== per-run state (stats, notes) — numbers only
def _state(run_id: str) -> dict:
    with _LOCK:
        st = _RUNS.get(run_id)
        if st is None:
            st = _RUNS[run_id] = {"stats": {"jobs": 0, "ok": 0, "failed": 0, "job_s": 0.0, "cost_usd": 0.0,
                                            "by_kind": {}, "fallbacks": {}, "checks": [], "peak": 0},
                                  "notes": [], "noted": set()}
        return st


def _record(run_id: str, kind: str, secs: float, ok: bool, res: dict | None = None, code: str | None = None):
    st = _state(run_id)
    with _LOCK:
        s = st["stats"]
        s["jobs"] += 1
        s["ok" if ok else "failed"] += 1
        s["job_s"] = round(s["job_s"] + secs, 2)
        s["cost_usd"] = round(s["cost_usd"] + float((res or {}).get("cost_usd") or 0.0), 4)
        k = s["by_kind"].setdefault(kind, {"jobs": 0, "ok": 0, "s": 0.0})
        k["jobs"] += 1
        k["ok"] += int(ok)
        k["s"] = round(k["s"] + secs, 2)
        if code:
            s["fallbacks"][code] = s["fallbacks"].get(code, 0) + 1
        s["peak"] = max(s["peak"], cc.GATE.peak)


def _note_once(run_id: str, key: str, message: str, code: str):
    st = _state(run_id)
    with _LOCK:
        if key in st["noted"]:
            return
        st["noted"].add(key)
        st["notes"].append((message, code))


def timing_of(run: dict) -> dict | None:
    """The helpers' numbers of this run (live while it runs, else the saved copy). None when no helper ran."""
    st = _RUNS.get(run.get("id") or "")
    if st:
        with _LOCK:
            s = json.loads(json.dumps(st["stats"]))
    else:
        s = ((run.get("timing") or {}).get("helpers")) or None
    if not s or not s.get("jobs"):
        return None
    chk = s.get("checks") or []
    wall = round(sum(c["wall_s"] for c in chk), 1)
    one = round(sum(c["one_by_one_s"] for c in chk), 1)
    old = round(sum(c["old_way_s"] for c in chk), 1)
    s["checks_wall_s"], s["checks_one_by_one_s"], s["checks_old_way_s"] = wall, one, old
    s["speedup"] = round(one / wall, 2) if wall > 0 and one > 0 else None
    line = f"🤖 Claude Code helpers: {s['ok']} of {s['jobs']} job(s) done"
    if chk:
        line += (f"; the checks took {wall / 60:.1f} min side by side instead of about {one / 60:.1f} min one after "
                 f"another" + (f" ({s['speedup']}× faster)" if s["speedup"] and s["speedup"] > 1 else ""))
    if s.get("failed"):
        line += f"; {s['failed']} fell back to the web AIs"
    s["line"] = line + "."
    return s


def sync(svc, run: dict) -> None:
    """Copy the helpers' numbers into the run and write their notes into the run window (the run's own thread)."""
    st = _RUNS.get(run.get("id") or "")
    if not st:
        return
    with _LOCK:
        notes, st["notes"] = st["notes"], []
        stats = json.loads(json.dumps(st["stats"]))
    run.setdefault("timing", {"calls": 0, "call_s": 0.0})["helpers"] = stats
    for msg, code in notes:
        try:
            svc.event(run, "note", msg, code=code)
        except Exception:  # noqa: BLE001
            pass


# ====================================================================== is it on for this run?
def _settings(svc) -> dict:
    return cc.settings(svc.store)


def active(svc, run: dict, job: str | None = None) -> bool:
    """The helpers may take this job now: on in Settings and for this run, the job switched on, Claude Code found,
    signed in and not at its limit. Never raises, never waits."""
    try:
        if ((run or {}).get("settings") or {}).get("claude_code") is False:
            return False
        proj = svc.store.project(run["project_id"])
        ps = json.loads(proj["settings"] or "{}") if proj else {}
        if isinstance(ps, dict) and (ps.get("selftest") or ps.get("workflow_test")):
            return False  # 🧪 the smoke tests keep their own fixed AI calls
        st = _settings(svc)
        if job and not st["jobs"].get(job):
            return False
        ok = cc.available(svc.store) is not None
        if not ok and cc.enabled(svc.store):
            cur = cc.cached_status()
            if cur and cur.get("state") not in (None, "ready"):
                _note_once(run["id"], f"off:{cur.get('state')}", f"🤖 Claude Code helpers are not used right now: "
                           f"{cc.status_words(cur)}", "CLAUDE_CODE_FALLBACK")
        return ok
    except Exception:  # noqa: BLE001
        log.exception("could not tell whether the Claude Code helpers are on")
        return False


def _cancel_of(svc, run: dict):
    rid = run["id"]

    def cancel() -> bool:
        ctl = (getattr(svc, "_ctl", None) or {}).get(rid) or {}
        if ctl.get("cancel") or ctl.get("pause"):
            return True
        alive = getattr(svc, "alive", None)
        return bool(alive and not alive(rid))
    return cancel


def _words(what: str, store) -> str:
    n = cc.helpers_of(cc.settings(store))
    return f"🤖 Claude Code: {what} ({n} helper{'s' if n != 1 else ''})"


def _submit(svc, run: dict, key: tuple, kind: str, what: str, fn, then=None) -> cf.Future:
    """Run ``fn(cancel)`` on a helper thread (one Claude Code job; at most N run at once — claude_code.GATE).
    The same ``key`` already running or done is reused. The future's result is the job's cleaned answer, or None
    when it fell back. ``then(answer)`` runs on the helper thread after a success (saving what it found)."""
    with _LOCK:
        f = _FUTS.get(key)
        if f is not None and not (f.done() and f.result() is None):
            return f
    run_id, store = run["id"], svc.store
    cancel = _cancel_of(svc, run)
    task = _words(what, store)

    def go():
        t0 = time.monotonic()
        with ai_activity.doing(task, done=task.replace("🤖 Claude Code: ", "🤖 Claude Code: done — "),
                               book_id=run.get("project_id"), run_id=run_id):
            ai_activity.call_started(PSEUDO_SLOT, "Claude Code")
            err = None
            try:
                out, res = fn(cancel)
            except cc.CCError as exc:
                err = exc
                _record(run_id, kind, time.monotonic() - t0, False, code=exc.code)
                if exc.state in ("signed_out", "limited", "not_installed"):
                    _note_once(run_id, f"off:{exc.state}", f"🤖 Claude Code helpers stopped: {exc}. The web AIs do "
                               "the work.", "CLAUDE_CODE_FALLBACK")
                return None
            except Exception as exc:  # noqa: BLE001 - a helper never breaks the book
                err = exc
                log.exception("Claude Code job %s failed", kind)
                _record(run_id, kind, time.monotonic() - t0, False, code="INTERNAL_ERROR")
                return None
            finally:
                ai_activity.call_ended(err)
            _record(run_id, kind, res.get("seconds") or (time.monotonic() - t0), True, res)
            if then is not None:
                try:
                    then(out)
                except Exception:  # noqa: BLE001
                    log.exception("could not save what the Claude Code job %s found", kind)
            return {"out": out, "seconds": res.get("seconds") or round(time.monotonic() - t0, 2)}
    f = _POOL.submit(ai_activity.carry(go))
    with _LOCK:
        _FUTS[key] = f
        if len(_FUTS) > 400:  # forget old finished jobs
            for k in [k for k, v in list(_FUTS.items()) if v.done()][:200]:
                _FUTS.pop(k, None)
    return f


# ====================================================================== 1. research ahead
def _research_get(store, pid, branch) -> dict:
    try:
        cur = store.get_setting(RESEARCH_KEY.format(pid=pid, branch=branch))
    except Exception:  # noqa: BLE001
        cur = None
    return cur if isinstance(cur, dict) else {}


def _research_put(store, pid, branch, rows: dict) -> None:
    with _LOCK:
        cur = _research_get(store, pid, branch)
        cur.update(rows)
        store.set_setting(RESEARCH_KEY.format(pid=pid, branch=branch), cur)


def _plan_of(store, pid, branch, outline, ch: dict) -> dict:
    plan = " ".join(x for x in (ch.get("objective"), ch.get("summary")) if x)
    scenes = []
    try:
        from . import scenes as scenes_mod  # noqa: PLC0415
        entry = scenes_mod.get_entry(store, pid, branch, outline["record_id"], ch["chapter_id"])
        if entry and scenes_mod.usable(entry, outline):
            scenes = [jobs._clip(json.dumps(c, ensure_ascii=False), 600) for c in scenes_mod.brief_cards(entry)][:6]  # noqa: SLF001
    except Exception:  # noqa: BLE001
        scenes = []
    return {"plan": plan, "scenes": scenes}


def chapter_started(svc, run: dict, outline: dict, chapters: list[dict], idx: int) -> None:
    """🤖 hook: chapter ``idx`` (0-based) starts being written -> research chapters idx+2..idx+4 in the background."""
    try:
        sync(svc, run)
        if not active(svc, run, "research"):
            return
        pid, branch = run["project_id"], run.get("branch_id") or "main"
        have = _research_get(svc.store, pid, branch)
        todo = []
        for j in range(idx + 1, min(len(chapters), idx + 1 + RESEARCH_AHEAD)):
            ch = chapters[j]
            p = _plan_of(svc.store, pid, branch, outline, ch)
            h = _hash(json.dumps(p, sort_keys=True))
            running = _FUTS.get(("research", pid, ch["chapter_id"], h))
            if (have.get(ch["chapter_id"]) or {}).get("plan_hash") == h or (
                    running is not None and not (running.done() and running.result() is None)):
                continue
            todo.append(dict(p, number=j + 1, chapter_id=ch["chapter_id"], plan_hash=h))
        if not todo:
            return
        from .assist import book_profile_brief  # noqa: PLC0415
        book = book_profile_brief(svc.store, pid)
        store = svc.store

        def fn(cancel):
            return jobs.research(store, book, todo, cancel=cancel)

        def then(notes: dict):
            _research_put(store, pid, branch, {t["chapter_id"]: {"number": t["number"], "plan_hash": t["plan_hash"],
                                                                  "notes": notes.get(t["number"]) or [], "at": _now()}
                                               for t in todo})
        a, b = todo[0]["number"], todo[-1]["number"]
        what = f"researching chapter {a} ahead" if a == b else f"researching chapters {a}–{b} ahead"
        key = ("research", pid) + tuple((t["chapter_id"], t["plan_hash"]) for t in todo)
        _submit(svc, run, key, "research", what, fn, then)
        for t in todo:  # the same chapter plan is not researched twice while this job runs
            with _LOCK:
                _FUTS[("research", pid, t["chapter_id"], t["plan_hash"])] = _FUTS[key]
    except Exception:  # noqa: BLE001
        log.exception("research ahead could not start")


def brief_notes(store, pid: str, branch: str, chapter_id: str) -> list[dict]:
    """The research notes for this chapter's writer (bounded)."""
    row = _research_get(store, pid, branch).get(chapter_id) or {}
    out, size = [], 0
    for n in row.get("notes") or []:
        item = {"topic": n.get("topic"), "note": n.get("note"), "label": n.get("label_words") or n.get("label")}
        if n.get("source_url"):
            item["source"] = n["source_url"]
        size += len(json.dumps(item, ensure_ascii=False))
        if size > BRIEF_CHARS:
            break
        out.append(item)
    return out


def add_to_brief(store, pid: str, branch: str, chapter_id: str, brief: dict | None) -> dict | None:
    """🤖 hook (modules/set_c.py, the chapter writer): the chapter's research notes join its writing brief."""
    try:
        notes = brief_notes(store, pid, branch, chapter_id)
        if not notes:
            return brief
        out = dict(brief or {})
        out["research_notes"] = notes
        out["rules"] = list(out.get("rules") or []) + [BRIEF_RULE]
        return out
    except Exception:  # noqa: BLE001 - the brief is help for the writer, never a reason to fail the chapter
        log.exception("could not add the research notes to the brief")
        return brief


# ====================================================================== 2. fact checks and 4. the AI-tell pass
def _proposals_get(store, pid, branch) -> dict:
    try:
        cur = store.get_setting(PROPOSALS_KEY.format(pid=pid, branch=branch))
    except Exception:  # noqa: BLE001
        cur = None
    return cur if isinstance(cur, dict) else {}


def _proposals_put(store, pid, branch, cid: str, kind: str, items: list[dict], meta: dict) -> None:
    with _LOCK:
        cur = _proposals_get(store, pid, branch)
        row = cur.get(cid) or {"items": []}
        keep = [i for i in row.get("items") or [] if i.get("kind") != kind or i.get("status") != "proposed"]
        n = len(row.get("items") or [])
        new = []
        for i in items:
            n += 1
            new.append(dict(i, id=f"{kind[:1]}{n}", kind=kind, status="proposed", at=_now()))
        row.update(meta, items=(keep + new)[-80:])
        cur[cid] = row
        store.set_setting(PROPOSALS_KEY.format(pid=pid, branch=branch), cur)


def _facts_future(svc, run, cid: str, number: int, text: str) -> cf.Future:
    pid, branch, store = run["project_id"], run.get("branch_id") or "main", svc.store
    from .assist import book_profile_brief  # noqa: PLC0415
    book = book_profile_brief(store, pid)
    h = _hash(text)

    def fn(cancel):
        return jobs.facts(store, text, number, book, cancel=cancel)

    def then(fc: dict):
        from . import fact_checks  # noqa: PLC0415
        fact_checks.save_sourced(store, pid, branch, cid, dict(fc, text_hash=h, number=number, by=NAME))
        fixes = [{"quote": c["quote"], "problem": f"Fact check: {c['claim']} — {c.get('why') or 'wrong'}"
                  + (f" (source: {c['source_url']})" if c.get("source_url") else ""),
                  "original": c["original"], "replacement": c["replacement"]}
                 for c in fc.get("claims") or [] if c["verdict"] == "wrong" and c.get("original")]
        _proposals_put(store, pid, branch, cid, "fact", fixes, {"number": number, "facts_hash": h})
    return _submit(svc, run, ("facts", pid, cid, h), "facts", f"fact-checking chapter {number}", fn, then)


def draft_written(svc, run: dict, cid: str, number: int, rid: str) -> None:
    """🤖 hook: a chapter draft was written -> its fact check starts while the reviewers read it."""
    try:
        sync(svc, run)
        if not (active(svc, run, "facts") or active(svc, run, "checks")):
            return
        rec = svc.bp(run).rec(rid)
        text = str(((rec or {}).get("data") or {}).get("text") or "")
        if text.strip():
            _facts_future(svc, run, cid, number, text)
    except Exception:  # noqa: BLE001
        log.exception("the fact check of a draft could not start")


def _earlier_texts(svc, run, cid: str) -> list[str]:
    try:
        from .fact_checks import book_texts  # noqa: PLC0415
        chs = book_texts(svc.app.engine, run["principal"], run["project_id"], run.get("branch_id") or "main")
        out = []
        for c in chs:
            if c["chapter_id"] == cid:
                break
            out.append(c["text"])
        return out
    except Exception:  # noqa: BLE001
        return []


def keep_list(review, engine, principal, pid, branch, rec: dict | None, text: str) -> list[str]:
    """Words a rewrite must keep: the voice / motif repeats (fact_checks.protected_keep) and the passages the editor
    said to keep for this version (editor.keep_quotes_of) — the same list the editor's apply path enforces."""
    out: list[str] = []
    try:
        from .fact_checks import protected_keep  # noqa: PLC0415
        out += protected_keep(engine, principal, pid, branch, text)
    except Exception:  # noqa: BLE001
        pass
    try:
        from .editor import _rkey, keep_quotes_of  # noqa: PLC0415
        if rec:
            craft = review.editor.crafts(pid, branch).get(_rkey(rec["record_id"], rec["version"])) or {}
            out += keep_quotes_of(craft, text, set())
    except Exception:  # noqa: BLE001
        pass
    return list(dict.fromkeys(out))


def _keeps(svc, run, text: str, rec: dict | None = None) -> tuple[list[str], list[str]]:
    pid, branch = run["project_id"], run.get("branch_id") or "main"
    try:
        from .checkpoints import _locked  # noqa: PLC0415
        locked = _locked(svc.store, pid, branch)
    except Exception:  # noqa: BLE001
        locked = []
    review = getattr(svc, "_review", None) or svc.app.review
    reps = keep_list(review, svc.app.engine, run["principal"], pid, branch, rec, text)
    return locked, reps


def tells_future(svc, run: dict, cid: str, number: int, rec: dict) -> cf.Future | None:
    pid, branch, store = run["project_id"], run.get("branch_id") or "main", svc.store
    text = str((rec.get("data") or {}).get("text") or "")
    if not text.strip():
        return None
    earlier = _earlier_texts(svc, run, cid)
    locked, reps = _keeps(svc, run, text, rec)
    h = _hash(text)

    def fn(cancel):
        return jobs.ai_tells(store, text, earlier=earlier, keep_exactly=locked, keep_repeats=reps, cancel=cancel)

    def then(lines: list[dict]):
        items = [{"quote": ln["quote"], "problem": ln["problem"], "original": ln["quote"], "replacement": ln["rewrite"]}
                 for ln in lines]
        _proposals_put(store, pid, branch, cid, "ai_tell", items,
                       {"number": number, "record_id": rec.get("record_id"), "version": rec.get("version"),
                        "tells_hash": h})
    return _submit(svc, run, ("ai_tells", pid, cid, h), "ai_tells",
                   f"finding lines that sound AI-written in chapter {number}", fn, then)


def chapter_approved(svc, run: dict, cid: str, number: int, rec: dict | None) -> None:
    """🤖 hook: a chapter was approved -> its fact check (if its text changed) and the "sounds like AI" pass run in
    the background; what they find waits on the chapter page as proposals."""
    try:
        sync(svc, run)
        if not rec:
            return
        text = str((rec.get("data") or {}).get("text") or "")
        if (active(svc, run, "facts") or active(svc, run, "checks")) and text.strip():
            _facts_future(svc, run, cid, number, text)
        if active(svc, run, "ai_tells"):
            tells_future(svc, run, cid, number, rec)
    except Exception:  # noqa: BLE001
        log.exception("the helpers' after-approval jobs could not start")


# ====================================================================== 3. checks side by side (checkpoints hook)
class _Null:
    """No helpers for this check: the web AIs read exactly as before."""

    def order(self, checkers):
        return list(checkers)

    def covers(self, slot, by) -> bool:
        return False

    def finish(self, by, checkers):
        return list(checkers)


def _slot(prov, sid):
    try:
        return next((s for s in prov.slots() if s["slot_id"] == sid), None)
    except Exception:  # noqa: BLE001
        return None


def _family(svc, sid) -> str | None:
    from . import providers as providers_mod  # noqa: PLC0415
    prov = getattr(svc.app.engine.providers, "_base", svc.app.engine.providers)
    return providers_mod.slot_family(_slot(prov, sid)) if sid else None


def writer_is_claude(svc, run, record_ids: list[str]) -> bool:
    """Did Claude (the pane, the API or Claude Code) write any of these chapters? Then the helpers may only check
    facts (and propose AI-tell rewrites): Claude never reviews its own writing."""
    pid, branch = run["project_id"], run.get("branch_id") or "main"
    review = getattr(svc, "_review", None) or svc.app.review
    for rid in record_ids:
        try:
            rec = svc.bp(run).rec(rid)
            w = review.writer_of(pid, branch, rec).get("slot") if rec else None
        except Exception:  # noqa: BLE001
            w = None
        if w is None:
            w = (run.get("settings") or {}).get("slot_id")
        if w and _family(svc, w) == "claude":
            return True
    return False


class _Checks(_Null):
    def __init__(self, svc, run, cp, part, ctx, checkers, texts, order):
        self.svc, self.run, self.cp = svc, run, cp
        self.t0 = time.monotonic()
        self.marks: list[tuple[str, float]] = []
        self.nums = {order.index(c) + 1: c for c in part["chapter_ids"] if c in order}
        self.texts = {c: (texts.get(c) or {}).get("text") or "" for c in part["chapter_ids"]}
        rids = [(texts.get(c) or {}).get("record_id") for c in part["chapter_ids"] if (texts.get(c) or {}).get("record_id")]
        self.claude_wrote = writer_is_claude(svc, run, rids)
        self.claude_slots = [s for s in checkers if _family(svc, s) == "claude"]
        st = _settings(svc)
        self.futs: dict[str, list] = {}
        if st["jobs"].get("checks") and not self.claude_wrote:
            for kind in ("continuity", "voice"):
                self.futs[kind] = [self._check_future(kind, ctx)]
        if st["jobs"].get("facts") or st["jobs"].get("checks"):
            self.futs["facts"] = [(_facts_future(svc, run, cid, n, self.texts[cid]), cid, n)
                                  for n, cid in self.nums.items() if self.texts.get(cid, "").strip()]
        self.sub = self.claude_slots[0] if (cp.get("kind") == "chapter" and "continuity" in self.futs
                                            and self.claude_slots) else None
        self.covered = None
        self.used: set = set()

    def _check_future(self, kind, ctx):
        store, nums, texts = self.svc.store, self.nums, self.texts
        label = f"chapter {min(nums)}" if len(nums) == 1 else f"chapters {min(nums)}–{max(nums)}"
        what = {"continuity": f"checking {label} for continuity", "voice": f"checking the voices in {label}"}[kind]

        def fn(cancel):
            raw, res = jobs.check(store, kind, ctx, cancel=cancel)
            return jobs.clean_problems(raw, nums, texts, kind), res
        key = (kind, self.run["project_id"], self.cp.get("id"), tuple(sorted(_hash(t) for t in texts.values())))
        return _submit(self.svc, self.run, key, kind, what, fn)

    # ---------------------------------------------------------------- the checkpoints loop calls these
    def order(self, checkers):
        """The AI the helpers may read for goes last, so the helpers have the longest time to finish."""
        if not self.sub:
            return list(checkers)
        return [s for s in checkers if s != self.sub] + [self.sub]

    def _wait(self, futs: list, limit: float) -> None:
        end = time.monotonic() + limit
        while time.monotonic() < end and not all(f.done() for f in futs):
            self.svc.check(self.run)  # a pause / cancel stops the wait (the jobs stop themselves)
            cf.wait(futs, timeout=0.25)

    def _problems(self, kinds) -> list[dict]:
        out = []
        for kind in kinds:
            if kind == "facts":
                for f, cid, n in self.futs.get("facts") or []:
                    if f.done() and f.result() and ("facts", cid) not in self.used:
                        self.used.add(("facts", cid))
                        out += jobs.fact_problems(f.result()["out"], cid, n)
            else:
                for f in self.futs.get(kind) or []:
                    if f.done() and f.result() and kind not in self.used:
                        self.used.add(kind)
                        out += f.result()["out"]
        return out

    def covers(self, slot, by) -> bool:
        self.marks.append((slot, time.monotonic()))
        if slot != self.sub:
            return False
        main = [f for k in ("continuity", "voice") for f in self.futs.get(k) or []]
        reads = [t2 - t1 for (_s, t1), (_x, t2) in zip(self.marks, self.marks[1:])]
        limit = min(float(cc.settings(self.svc.store)["timeout_s"]), max(COVER_WAIT_MIN_S, 2 * max(reads or [0])))
        self._wait(main, limit)
        if not all(f.done() and f.result() for f in main):
            _note_once(self.run["id"], "check-failed", "🤖 The Claude Code helpers could not check this chapter now; "
                       "the Claude pane reads it as before", "CLAUDE_CODE_FALLBACK")
            self.sub = None
            return False
        by[slot] = {"done": True, "name": NAME, "problems": self._problems(("continuity", "voice", "facts")),
                    "summary": "", "at": _now(), "review": None, "helpers": sorted(self.futs)}
        self.covered = slot
        return True

    def finish(self, by, checkers):
        try:
            end = time.monotonic()
            pending = [f for k in self.futs for f in ((x[0] if isinstance(x, tuple) else x) for x in self.futs[k])]
            self._wait(pending, FINISH_WAIT_S)
            extra = self._problems(("continuity", "voice", "facts"))
            target = self.covered or next((s for s in self.claude_slots if (by.get(s) or {}).get("done")), None)
            out = list(checkers)
            if target:
                have = by[target].setdefault("problems", [])
                from .cross_check import same_problem  # noqa: PLC0415
                have += [p for p in extra if not any(same_problem(p, q) for q in have)]
                by[target]["helpers"] = sorted(self.futs)
            elif extra or any(f.done() and f.result() for f in pending):
                by[PSEUDO_SLOT] = {"done": True, "name": NAME, "problems": extra, "summary": "", "at": _now(),
                                   "review": None, "helpers": sorted(self.futs)}
                out.append(PSEUDO_SLOT)
            self._timing(end)
            sync(self.svc, self.run)
            return out
        except Exception as exc:  # noqa: BLE001
            if getattr(exc, "control", False) or type(exc).__name__ in ("RunPaused", "RunCancelled", "Cancelled"):
                raise
            log.exception("could not merge the Claude Code helpers' checks")
            return list(checkers)

    def _timing(self, web_end: float) -> None:
        t_end = time.monotonic()
        marks = self.marks + [("_end", web_end)]
        reads = {s: round(t2 - t1, 2) for (s, t1), (_x, t2) in zip(marks, marks[1:]) if s != self.covered}
        jobs_s = []
        for k, xs in self.futs.items():
            for x in xs:
                f = x[0] if isinstance(x, tuple) else x
                if f.done() and f.result():
                    jobs_s.append(float(f.result().get("seconds") or 0))
        web = sum(reads.values())
        avg = web / len(reads) if reads else 0.0
        row = {"cp": self.cp.get("id"), "wall_s": round(t_end - self.t0, 2), "one_by_one_s": round(web + sum(jobs_s), 2),
               "old_way_s": round(web + (avg if self.covered else 0.0), 2), "helper_jobs": len(jobs_s),
               "read_for_claude": bool(self.covered)}
        st = _state(self.run["id"])
        with _LOCK:
            st["stats"]["checks"] = (st["stats"]["checks"] + [row])[-200:]


def checks_start(svc, run, cp, part, ctx, checkers, texts, order):
    """🤖 hook (checkpoints._read_part_by_all): start the helpers' checks of this part side by side. Returns an
    object with ``order`` / ``covers`` / ``finish`` — a do-nothing one when the helpers are off."""
    try:
        if any((v or {}).get("helpers") and (v or {}).get("done") for v in (part.get("by_ai") or {}).values()):
            return _Null()  # read already (a resumed checkpoint never asks again)
        if not (active(svc, run, "checks") or active(svc, run, "facts")):
            return _Null()
        return _Checks(svc, run, cp, part, ctx, checkers, texts, order)
    except Exception:  # noqa: BLE001
        log.exception("the Claude Code helpers' checks could not start")
        return _Null()


# ====================================================================== the chapter page: notes, facts, proposals
def _head_text(review, pid, branch, rid):
    rec = review._head(pid, branch, rid)  # noqa: SLF001
    if rec is None or rec.get("module_id") != "C02":
        raise AkoweError("NOT_FOUND", "/record_id", "this chapter does not exist", status="REJECTED")
    return rec, str((rec.get("data") or {}).get("text") or "")


def _chapter_id_of(app, principal, pid, branch, rid) -> str | None:
    from .fact_checks import book_texts  # noqa: PLC0415
    for c in book_texts(app.engine, principal, pid, branch):
        if c["record_id"] == rid:
            return c["chapter_id"]
    return None


def chapter_info(app, principal, pid, branch, rid) -> dict:
    from . import fact_checks  # noqa: PLC0415
    rec, text = _head_text(app.review, pid, branch, rid)
    cid = _chapter_id_of(app, principal, pid, branch, rid)
    props = (_proposals_get(app.store, pid, branch).get(cid) or {}) if cid else {}
    keep = keep_list(app.review, app.engine, principal, pid, branch, rec, text) if props.get("items") else []
    items = [i for i in props.get("items") or [] if i.get("status") == "proposed" and text.count(i["original"]) == 1
             and not any(k in i["original"] and k not in i["replacement"] for k in keep)]
    st = cc.public(app.store)
    return {"record_id": rid, "version": rec["version"], "chapter_id": cid, "status": st["status"],
            "active": st["active"], "research_notes": brief_notes(app.store, pid, branch, cid) if cid else [],
            "facts": fact_checks.sourced_of(app.store, pid, branch, cid) if cid else None,
            "proposals": items}


def use_proposals(app, principal, pid, branch, rid, body) -> dict:
    """✔ Use: the chosen proposals saved as a NEW DRAFT of the chapter (editor.apply, how="author"), never approved
    here — the author approves it like any other draft."""
    body = body if isinstance(body, dict) else {}
    rec, text = _head_text(app.review, pid, branch, rid)
    cid = _chapter_id_of(app, principal, pid, branch, rid)
    want = body.get("ids")
    if want is not None and (not isinstance(want, list) or not all(isinstance(x, str) for x in want)):
        raise AkoweError("INVALID_INPUT", "/ids", "ids: the proposals to use", status="REJECTED")
    with _LOCK:
        cur = _proposals_get(app.store, pid, branch)
        row = cur.get(cid) or {}
        items = [i for i in row.get("items") or [] if i.get("status") == "proposed"
                 and (want is None or i["id"] in want) and text.count(i["original"]) == 1]
    if not items:
        raise AkoweError("INVALID_INPUT", "/ids", "there is no proposed change to use", status="REJECTED")
    keep = keep_list(app.review, app.engine, principal, pid, branch, rec, text)
    items = [i for i in items if not any(k in i["original"] and k not in i["replacement"] for k in keep)]
    if not items:
        raise AkoweError("INVALID_INPUT", "/ids", "these changes would cut words that must stay (a repeat or a "
                         "passage the editor kept), so nothing was changed", status="REJECTED")
    prop = {"items": [{"finding_id": i["id"], "original": i["original"], "replacement": i["replacement"], "ok": True,
                       "passage": i["original"]} for i in items], "slot": None, "keep": keep}
    out = app.review.editor.apply(principal, pid, branch, rid, rec["version"], None, proposal=prop, how="author")
    done = {a["finding_id"] for a in out.get("applied") or []}
    with _LOCK:
        cur = _proposals_get(app.store, pid, branch)
        for i in (cur.get(cid) or {}).get("items") or []:
            if i["id"] in done:
                i.update(status="draft", used_at=_now())
        app.store.set_setting(PROPOSALS_KEY.format(pid=pid, branch=branch), cur)
    return {"record_id": rid, "version": out["version"], "used": len(done),
            "message": f"{len(done)} change(s) saved as a new draft: read it and approve it."}


def route(app, method, rest, body, principal, pid, branch):
    """/review/claude-code/chapter/{rid}[/use] — None when the path is not ours."""
    if len(rest) >= 2 and rest[0] == "chapter":
        rid = rest[1]
        if len(rest) == 2 and method == "GET":
            return 200, chapter_info(app, principal, pid, branch, rid)
        if rest[2:] == ["use"] and method == "POST":
            return 200, use_proposals(app, principal, pid, branch, rid, body)
    return None
