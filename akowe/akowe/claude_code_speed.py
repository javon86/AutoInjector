"""🤖 Claude Code helpers, Step 2 of the speed plan: a faster book without losing quality, and a less machine-written
sound. Step 1 (``claude_code_book``) runs research ahead, fact checks, checks side by side and the "sounds like AI"
pass; this module adds, through short marked hook calls in autobook.py, whole_bible.py and claude_code_book.py:

1. **Get the next chapter ready early** (``chapter_done`` → ``use_prepared``). As soon as chapter N is approved and
   its running notes are updated, a helper plans chapter N+1's scene cards and needs list — the scene planner's own
   task, schema, context and cleaning (scenes.ScenePlanner) — while chapter N goes through its all-AI check and the
   "sounds like AI" pass. The plan carries a **fingerprint of every fact it was made from** (the planner's whole
   context: the outline revision, the running notes and story so far, what earlier chapters used without planning,
   the characters, world, story beats, the writers' room…). When chapter N+1 starts, the context is built again: same
   fingerprint → the prepared cards are saved as the chapter's scene cards (``how="prepared"``) and go through the
   SAME independent scene check and approval; a different one (the check fixed chapter N, the notes or the story map
   changed) → the prepared plan is marked stale and the chapter is planned the old way. A chapter is never written
   from stale facts. A prepare still running is waited for at most ``PREPARE_WAIT_S``.
2. **Fill the Book Bible side by side** (``bible_helper``, used by whole_bible.fill). The independent sections run as
   parallel helper jobs (first wave: every character, place, item, magic system and Book Bible value; second wave:
   the relationship types, after the characters). Every answer goes through the same ``read_answer`` / ``accept``
   (schemas, approval under the run consent) on the run's thread, in the old order. A section whose helper fails or
   is too slow is asked of the web AI exactly as before.
3. **Extras in the background** (``pictures_in_background``, ``launch_kit_start``, ``finish``). The character
   pictures (the 🎨 Images module, Stable Diffusion through AutoInjector — book_pictures.run_step unchanged) are made
   on a background thread as soon as the characters' looks are approved, while the book goes on; the launch kit's
   first drafts (blurb, description, hook, keywords, categories, comparable titles, A+ plan) are written by a helper
   as soon as the chapter outline is approved — drafts only: the author approves them on 🚀 Launch kit as always.
   📣 Marketing needs an approved 🎨 cover (a run never approves one), so it is not started here.
4. **Specialist reviewers** (``specialist_futures``, joined into claude_code_book._Checks): dialogue voice (per main
   character who speaks, against their voice card), pacing, senses and concrete detail, subtext — problems in the
   checks' format, merged like the checks side by side; only when Claude did not write the chapter (Claude Code is
   Claude); each only where useful (Settings → which specialists run).
5. **Variety across the book** (``used_so_far``, ``brief_variety``): how the chapters so far opened, ended and how many
   scenes they had (human_voice's opening / closing kinds), and a helper's check of the prepared plan's opening and
   closing against them, in the next chapter's writing brief (``writing_brief.variety``) — next to #133's
   ``human_voice.this_book_so_far``, which only names habits.
6. **Match the author's voice** (``style_future``): with a ✒️ style card, the chapter's narration numbers against the
   card's, and the lines that drift most with rewrites — PROPOSALS (claude_code_book._proposals_put, ✔ Use =
   editor.apply, a new draft the author approves).
7. **Specific details and real dialogue** (``specifics_future``): generic details and too-tidy dialogue with concrete
   / messier rewrites — proposals, never silent; names, numbers, locked details, protected repeats and the story
   map's passages are never touched (claude_code_jobs.clean_tells' guards plus the story-map guard).

Everything falls back: helpers off / missing / signed out / limited / failing → each hook does nothing and the run
goes on exactly as before. Hooks never raise (only the run's own pause / cancel while a wait is in progress).
Measured (``run["timing"]["helpers"]["speed"]``, the run's costs and report): the planning moved off the chapters'
path, the Bible fill side by side against one after another, and the extras' time off the run.
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import logging
import re
import threading
import time

from . import claude_code as cc
from . import claude_code_book as ccb
from . import claude_code_jobs as jobs

log = logging.getLogger("akowe.claude_code_speed")

PREPARE_KEY = "cc_prepared:{pid}:{branch}"
PREPARE_WAIT_S = ccb.FINISH_WAIT_S      # a prepare still running when its chapter starts: wait at most this long
EXTRAS_WAIT_S = ccb.FINISH_WAIT_S       # the end of the run waits at most this long for the background extras
BIBLE_WAIT_MIN_S = ccb.COVER_WAIT_MIN_S  # a Bible wave waits at least this long (or twice its slowest helper job)
MAX_DIALOGUE = 3                        # dialogue-voice specialists: at most this many characters per chapter
SENSORY_MIN = 14.0                      # senses specialist: only when a chapter has fewer sense words per 1 000
SUBTEXT_MIN = 2                         # subtext specialist: only when the narration names feelings this often
VARIETY_SO_FAR = 8
VARIETY_RULE = ("Variety (context.writing_brief.variety): so_far is how the chapters before this one opened and ended "
                "and how many scenes they had; open and end this chapter differently from them, and follow advice "
                "when it is given (it was checked against this chapter's planned first and last scene).")
SENSE_WORDS = frozenset("""smell smelled smelt scent stink stank reek reeked odor odour perfume smoke taste tasted bitter
sweet sour salt salty sharp rough smooth cold warm hot icy damp wet sticky soft hard gritty slick heavy loud quiet
hum hummed buzz creak creaked rattle rattled hiss hissed thud clang clatter whisper roar crack cracked ring rang
echo echoed bright dim glow glowed glint gleam shadow shadows grey gray amber crimson rust copper brass iron wool
linen leather velvet silk mud dust ash rain fog salt tar pine cedar oil wax""".split())
FEELING_RX = re.compile(r"\b(?:she|he|they|i|we) (?:felt|was|were|am) (?:so |very |suddenly |deeply )?(?:afraid|angry|"
                        r"sad|scared|furious|ashamed|guilty|relieved|nervous|anxious|happy|lonely|jealous|"
                        r"terrified|hurt|frightened|embarrassed|grateful|hopeful|hopeless|desperate)\b|"
                        r"\b(?:a wave of|a surge of|a pang of|a flicker of) (?:fear|anger|guilt|relief|shame|"
                        r"sadness|grief|joy|jealousy|hope)\b", re.I)
_LOCK = threading.Lock()
_BG: dict[str, dict] = {}   # run id -> {"pictures": {...}, "thread": Thread}


def _now() -> str:
    return ccb._now()  # noqa: SLF001


def _pb(run) -> tuple[str, str]:
    return run["project_id"], run.get("branch_id") or "main"


def _control(exc) -> bool:
    return bool(getattr(exc, "control", False)) or type(exc).__name__ in ("RunPaused", "RunCancelled", "Cancelled")


# ====================================================================== the measures (numbers only)
def _speed(run_id: str) -> dict:
    st = ccb._state(run_id)  # noqa: SLF001
    with ccb._LOCK:  # noqa: SLF001
        return st["stats"].setdefault("speed", {
            "prepare": {"made": 0, "used": 0, "stale": 0, "waited_s": 0.0, "saved_s": 0.0},
            "bible": {"waves": 0, "calls": 0, "helped": 0, "fell_back": 0, "wall_s": 0.0, "one_by_one_s": 0.0},
            "extras": {"pictures_s": 0.0, "launch_kit_s": 0.0, "background": 0, "still_running": 0},
            "specialists": {"jobs": 0, "skipped": 0}})


def _bump(run_id: str, part: str, **kw) -> None:
    sp = _speed(run_id)
    with ccb._LOCK:  # noqa: SLF001
        for k, v in kw.items():
            sp[part][k] = round(sp[part].get(k, 0) + v, 2) if isinstance(v, float) else sp[part].get(k, 0) + v


def _dur(secs) -> str:
    secs = float(secs or 0)
    return f"{secs:.0f} s" if secs < 90 else f"{secs / 60:.1f} min"


def speed_lines(s: dict | None) -> list[str]:
    """Plain lines of what Step 2 saved (the run window, ⏱ Time and AI use, the report)."""
    if not s:
        return []
    out = []
    p = s.get("prepare") or {}
    if p.get("used") or p.get("stale"):
        out.append(f"next chapter ready early: {p.get('used', 0)} chapter(s) started without waiting for their scene "
                   f"plan (about {_dur(p.get('saved_s'))} of planning off the chapters' path)"
                   + (f"; {p['stale']} prepared plan(s) were out of date and planned again" if p.get("stale") else ""))
    b = s.get("bible") or {}
    if b.get("calls"):
        out.append(f"Book Bible filled side by side in {_dur(b.get('wall_s'))} instead of about "
                   f"{_dur(b.get('one_by_one_s'))} one after another ({b.get('helped', 0)} of {b['calls']} "
                   "batch(es) by helpers" + (f", {b['fell_back']} by the web AIs" if b.get("fell_back") else "") + ")")
    e = s.get("extras") or {}
    if e.get("background"):
        out.append(f"extras in the background: about {_dur(e.get('pictures_s', 0) + e.get('launch_kit_s', 0))} of "
                   "pictures and launch-kit drafts off the run")
    sp = s.get("specialists") or {}
    if sp.get("jobs"):
        out.append(f"{sp['jobs']} specialist review(s)")
    return out


def saved_s(s: dict | None) -> float:
    """The time Step 2 took off the run (seconds; an estimate from measured job times)."""
    if not s:
        return 0.0
    b = s.get("bible") or {}
    e = s.get("extras") or {}
    return round((s.get("prepare") or {}).get("saved_s", 0) + max(0.0, b.get("one_by_one_s", 0) - b.get("wall_s", 0))
                 + e.get("pictures_s", 0) + e.get("launch_kit_s", 0), 1)


# ====================================================================== 1. get the next chapter ready early
def _prep_get(store, pid, branch) -> dict:
    try:
        cur = store.get_setting(PREPARE_KEY.format(pid=pid, branch=branch))
    except Exception:  # noqa: BLE001
        cur = None
    return cur if isinstance(cur, dict) else {}


def _prep_put(store, pid, branch, cid: str, row: dict | None = None, **change) -> None:
    with ccb._LOCK:  # noqa: SLF001
        cur = _prep_get(store, pid, branch)
        if row is not None:
            cur[cid] = row
        elif cid in cur:
            cur[cid].update(change)
        store.set_setting(PREPARE_KEY.format(pid=pid, branch=branch), cur)


def prepared_of(store, pid: str, branch: str, cid: str) -> dict | None:
    return _prep_get(store, pid, branch).get(cid)


def fingerprint(ctx: dict) -> str:
    """Every fact the plan is made from, as one hash (the planner's whole context)."""
    return ccb._hash(json.dumps(ctx, sort_keys=True, ensure_ascii=False, default=str))  # noqa: SLF001


def planner_input(svc, run, outline: dict, cid: str) -> tuple[str, dict, str]:
    """(task, context, fingerprint) — exactly what scenes.ScenePlanner.make would send for this chapter now."""
    from . import needs_list, scenes  # noqa: PLC0415
    review = getattr(svc, "_review", None) or svc.app.review
    planner = review.scenes
    pid, branch = _pb(run)
    bp = planner.bp(run["principal"], pid, branch)
    ctx = planner._context(pid, branch, bp, outline, cid)  # noqa: SLF001
    planner._needs_context(pid, branch, ctx)  # noqa: SLF001
    task = planner._task(scenes.PLAN_TASK, ctx) + " " + needs_list.PLAN_TASK  # noqa: SLF001
    return task, ctx, fingerprint(ctx)


def used_so_far(store, pid: str, branch: str, outline: dict, cid: str) -> list[dict]:
    """5. How the chapters before ``cid`` opened and ended (human_voice's kinds) and how many scenes they had."""
    try:
        from . import human_voice, scenes  # noqa: PLC0415
        earlier = human_voice.earlier_chapters(store, pid, branch, outline, cid)
        entries = scenes.all_entries(store, pid, branch)
        out = []
        for c in earlier:
            first, last = human_voice._first_last(c["text"])  # noqa: SLF001
            e = entries.get(scenes.ekey(outline["record_id"], c["chapter_id"])) or {}
            out.append({"chapter": c["number"], "opens": human_voice.opening_kind(first) or "other",
                        "ends": human_voice.closing_kind(last) or "other", "first": jobs._clip(first, 160),  # noqa: SLF001
                        "last": jobs._clip(last, 160), "scenes": len(e.get("cards") or []) or None})  # noqa: SLF001
        return out
    except Exception:  # noqa: BLE001
        log.exception("could not read how the chapters so far open and end")
        return []


def _planned(cards: list[dict]) -> dict:
    keys = ("place", "time", "characters", "beat", "change", "obstacle")
    first, last = cards[0], cards[-1]
    return {"scenes": len(cards), "first_scene": {k: first.get(k) for k in keys if first.get(k)},
            "last_scene": {k: last.get(k) for k in keys if last.get(k)}}


def chapter_done(svc, run: dict, outline: dict, chapters: list[dict], idx: int) -> None:
    """🤖 hook (autobook, after chapter ``idx`` is approved and its running notes and details are updated): plan the
    next chapter's scenes and needs list now, in the background, while this chapter is checked."""
    try:
        if idx + 1 >= len(chapters) or not svc._on(run, "scenes") or not ccb.active(svc, run, "prepare"):  # noqa: SLF001
            return
        from . import needs_list, scenes  # noqa: PLC0415
        pid, branch = _pb(run)
        store = svc.store
        cid = chapters[idx + 1]["chapter_id"]
        number = idx + 2
        if scenes.usable(scenes.get_entry(store, pid, branch, outline["record_id"], cid), outline):
            return
        task, ctx, fp = planner_input(svc, run, outline, cid)
        row = prepared_of(store, pid, branch, cid) or {}
        if row.get("fp") == fp and row.get("status") in ("ready", "used"):
            return
        used = used_so_far(store, pid, branch, outline, cid)
        variety_on = bool(used) and ccb.active(svc, run, "variety")
        rid = run["id"]

        def fn(cancel):
            out, res = jobs.prepare(store, task, ctx, cancel=cancel)
            secs = float(res.get("seconds") or 0)
            out["variety"] = None
            if variety_on:
                try:
                    out["variety"], r2 = jobs.variety(store, used, _planned(out["cards"]), cancel=cancel)
                    secs += float(r2.get("seconds") or 0)
                except cc.CCError:
                    out["variety"] = None  # the plan is still good without the variety check
            out["seconds"] = round(secs, 2)
            return out, dict(res, seconds=secs)

        def then(out):
            needs = needs_list.clean(out.get("needs_raw"), store, pid, branch)
            _prep_put(store, pid, branch, cid, {
                "fp": fp, "number": number, "outline_record_id": outline["record_id"],
                "outline_version": outline["version"], "cards": out["cards"], "needs": needs,
                "variety": out.get("variety"), "used_so_far": used, "status": "ready", "at": _now(),
                "seconds": out.get("seconds") or 0.0})
            _bump(rid, "prepare", made=1)
        ccb._submit(svc, run, ("prepare", pid, cid, fp), "prepare", f"getting chapter {number} ready early", fn,  # noqa: SLF001
                    then)
    except Exception as exc:  # noqa: BLE001
        if _control(exc):
            raise
        log.exception("the next chapter could not be prepared early")


def _running_prepare(pid, cid) -> list[cf.Future]:
    with ccb._LOCK:  # noqa: SLF001
        return [f for k, f in ccb._FUTS.items() if k[:3] == ("prepare", pid, cid) and not f.done()]  # noqa: SLF001


def claude_slot(svc) -> str:
    """The Claude-family slot the prepared plan counts as written by (so its independent check avoids Claude)."""
    try:
        prov = getattr(svc.app.engine.providers, "_base", svc.app.engine.providers)
        for s in prov.slots():
            if ccb._family(svc, s["slot_id"]) == "claude":  # noqa: SLF001
                return s["slot_id"]
    except Exception:  # noqa: BLE001
        pass
    return ccb.PSEUDO_SLOT


def use_prepared(svc, run: dict, outline: dict, cid: str, label: str):
    """🤖 hook (autobook._scene_cards, before the planner is asked): the prepared scene cards when every fact they were
    made from is unchanged — saved as this chapter's cards (they still get the independent check and the approval);
    None = plan the old way (nothing prepared, still running too long, or out of date)."""
    try:
        from . import scenes  # noqa: PLC0415
        pid, branch = _pb(run)
        store = svc.store
        if scenes.usable(scenes.get_entry(store, pid, branch, outline["record_id"], cid), outline):
            return None
        running = _running_prepare(pid, cid)
        waited = 0.0
        if running:
            t0 = time.monotonic()
            end = t0 + PREPARE_WAIT_S
            while time.monotonic() < end and not all(f.done() for f in running):
                svc.check(run)
                cf.wait(running, timeout=0.25)
            waited = round(time.monotonic() - t0, 2)
            _bump(run["id"], "prepare", waited_s=waited)
        row = prepared_of(store, pid, branch, cid)
        if not row or row.get("status") != "ready":
            return None
        _task, _ctx, fp = planner_input(svc, run, outline, cid)
        if (row.get("fp") != fp or row.get("outline_record_id") != outline["record_id"]
                or row.get("outline_version") != outline["version"]):
            _prep_put(store, pid, branch, cid, status="stale", stale_at=_now())
            _bump(run["id"], "prepare", stale=1)
            svc.event(run, "note", f"🤖 The scene plan prepared early for {label} was made before the facts changed "
                      "(the check of the chapter before, the running notes or the story map): it is planned again "
                      "from the current facts", code="PREPARED_STALE", chapter_id=cid)
            return None
        slot = claude_slot(svc)
        entry = scenes.save_cards(store, pid, branch, outline, cid, row["cards"], by="ai", slot=slot, how="prepared",
                                  needs=row.get("needs"))
        _prep_put(store, pid, branch, cid, status="used", used_at=_now())
        # measured: the planning that ran beside the check of the chapter before (its time minus any wait here)
        _bump(run["id"], "prepare", used=1, saved_s=round(max(0.0, float(row.get("seconds") or 0.0) - waited), 2))
        svc.event(run, "scenes", f"🤖 {label[:1].upper()}{label[1:]} starts without waiting: Claude Code planned its "
                  f"{len(row['cards'])} scene(s) and needs list while the chapter before was checked (the facts are "
                  "unchanged); an independent AI checks them now", slot=slot, code="PREPARED_USED")
        return entry
    except Exception as exc:  # noqa: BLE001
        if _control(exc):
            raise
        log.exception("the prepared scene plan could not be used")
        return None


def brief_variety(store, pid: str, branch: str, cid: str) -> dict | None:
    """5. The writer's ``variety`` block: how the chapters so far opened and ended (and their scene counts) and, when
    the prepared plan was used, the helper's advice for this chapter's planned opening and closing."""
    row = prepared_of(store, pid, branch, cid) or {}
    used = row.get("used_so_far") or []
    if not used:
        return None
    so_far = [f"chapter {u['chapter']}: opens on {u['opens']}, ends on {u['ends']}"
              + (f", {u['scenes']} scenes" if u.get("scenes") else "") for u in used[-VARIETY_SO_FAR:]]
    out = {"so_far": so_far}
    var = row.get("variety") or {}
    if row.get("status") == "used":
        advice = [f"{k.capitalize()}: {v['advice']}" for k, v in var.items() if isinstance(v, dict) and v.get("advice")]
        if advice:
            out["advice"] = advice
    return out


# ====================================================================== 2. the Book Bible side by side
class BibleHelper:
    """whole_bible.fill's helper: ``start(wave, build)`` submits each batch of a wave as a helper job; ``result(i)``
    is (raw answer, slot) or None (the web AI asks it as before). Waits are capped like the checks side by side."""

    def __init__(self, svc, run):
        self.svc, self.run = svc, run
        self.futs: list[cf.Future] = []
        self.t0 = 0.0
        self.limit = 0.0

    def start(self, wave: list, build) -> None:
        store = self.svc.store
        pid, _b = _pb(self.run)
        self.futs = []
        self.t0 = time.monotonic()
        self.limit = float(cc.settings(store)["timeout_s"])
        for parts in wave:
            task, schema, ctx = build(parts)
            names = ", ".join(dict.fromkeys(str(p.get("name")) for p in parts))[:80]

            def fn(cancel, task=task, schema=schema, ctx=ctx):
                return jobs.bible_fill(store, task, schema, ctx, cancel=cancel)
            key = ("bible_fill", pid, ccb._hash(json.dumps(ctx, sort_keys=True, default=str)))  # noqa: SLF001
            self.futs.append(ccb._submit(self.svc, self.run, key, "bible_fill",  # noqa: SLF001
                                         f"filling the Book Bible: {names}", fn))
        _bump(self.run["id"], "bible", waves=1)

    def _cap(self) -> float:
        done = [float(f.result().get("seconds") or 0) for f in self.futs if f.done() and f.result()]
        return min(self.limit, max(BIBLE_WAIT_MIN_S, 2 * max(done or [0])))

    def result(self, i: int):
        f = self.futs[i] if i < len(self.futs) else None
        if f is None:
            return None
        while not f.done() and time.monotonic() - self.t0 < self._cap():
            self.svc.check(self.run)
            cf.wait([f], timeout=0.25)
        out = f.result() if f.done() else None
        _bump(self.run["id"], "bible", calls=1, helped=1 if out else 0, fell_back=0 if out else 1)
        if not out:
            return None
        return out["out"], ccb.PSEUDO_SLOT

    def wave_done(self, web_s: float) -> None:
        """Measured: the wave's wall time against its jobs (and the web AI's fallbacks) one after another."""
        jobs_s = sum(float(f.result().get("seconds") or 0) for f in self.futs if f.done() and f.result())
        _bump(self.run["id"], "bible", wall_s=round(time.monotonic() - self.t0, 2), one_by_one_s=round(jobs_s + web_s, 2))
        ccb.sync(self.svc, self.run)


def bible_helper(svc, run):
    """🤖 hook (whole_bible.run_step): the parallel helper, or None (the old one-after-another fill)."""
    try:
        return BibleHelper(svc, run) if ccb.active(svc, run, "bible") else None
    except Exception:  # noqa: BLE001
        log.exception("the Book Bible helpers could not start")
        return None


# ====================================================================== 3. extras in the background
class _Stop(Exception):
    control = True


class _BgSvc:
    """What book_pictures.run_step needs of the run, for a background thread: the app, the book path, a check that
    stops only on a cancel (a pause does not stop pictures), and events queued for the run's own thread."""

    def __init__(self, svc, run):
        self.app, self.store, self._svc, self._rid = svc.app, svc.store, svc, run["id"]

    def bp(self, run):
        return self._svc.bp(run)

    def check(self, _run):
        if ((getattr(self._svc, "_ctl", None) or {}).get(self._rid) or {}).get("cancel"):
            raise _Stop()

    def save(self, _run):
        pass

    def event(self, _run, kind, message, **kw):
        st = ccb._state(self._rid)  # noqa: SLF001
        with ccb._LOCK:  # noqa: SLF001
            st.setdefault("events", []).append((kind, message, kw))


def pictures_in_background(svc, run: dict, st: dict) -> bool:
    """🤖 hook (autobook._s_pictures): make the character pictures on a background thread (Stable Diffusion only — a
    chat pane would be shared with the run) and let the run go on. False = the old step runs them now."""
    try:
        if not ccb.active(svc, run, "extras"):
            return False
        from . import book_pictures  # noqa: PLC0415
        conf = book_pictures.settings(svc.store)
        want = (run.get("settings") or {}).get("pictures")
        if want is False or (want is None and not conf["run"]) or conf["engine"] != "sd":
            return False
        rid = run["id"]
        with _LOCK:
            cur = _BG.get(rid) or {}
            if cur.get("thread") is not None and cur["thread"].is_alive():
                st["message"] = "🖼 Being made in the background while the book is written"
                return True
        shadow = {k: run.get(k) for k in ("id", "project_id", "branch_id", "principal", "settings")}
        shadow["phase"] = ""
        bst: dict = {"items": [], "message": ""}
        proxy = _BgSvc(svc, run)
        state = {"step": bst, "done": False}

        def go():
            t0 = time.monotonic()
            try:
                book_pictures.run_step(proxy, shadow, bst)
            except _Stop:
                bst["message"] = "Stopped: the run was cancelled (🖼 Make the rest of the pictures in the Book Bible)"
            except Exception:  # noqa: BLE001 - pictures never stop the book
                log.exception("background pictures failed")
                bst["message"] = ("⚠️ The pictures could not be made now; make them later with 🖼 Make the rest of "
                                  "the pictures in the Book Bible")
            finally:
                _bump(rid, "extras", pictures_s=round(time.monotonic() - t0, 2), background=1)
                state["done"] = True
        th = threading.Thread(target=go, name=f"akowe-pictures-{rid}", daemon=True)
        state["thread"] = th
        with _LOCK:
            _BG[rid] = state
        th.start()
        st["message"] = ("🖼 Being made in the background while the book is written (Stable Diffusion in "
                         "AutoInjector); the book does not wait")
        svc.event(run, "note", "🤖 The character pictures are made in the background, so the book goes on now",
                  step="pictures", code="EXTRAS_BACKGROUND")
        return True
    except Exception as exc:  # noqa: BLE001
        if _control(exc):
            raise
        log.exception("the pictures could not start in the background")
        return False


def sync_steps(run: dict) -> None:
    """On the run's thread: copy the background pictures' progress into the run's "Character pictures" step."""
    state = _BG.get(run.get("id") or "")
    if not state:
        return
    step = next((s for s in run.get("steps") or [] if s.get("id") == "pictures"), None)
    bst = state.get("step") or {}
    if step is None or not bst.get("message"):
        return
    step["items"] = json.loads(json.dumps(bst.get("items") or []))
    step["message"] = ("🖼 In the background: " if not state.get("done") else "🖼 Made in the background: ") \
        + str(bst["message"])


def launch_kit_start(svc, run: dict) -> None:
    """🤖 hook (claude_code_book.chapter_started, the first chapter: the profile, premise, characters and the chapter
    outline are approved): the launch kit's first drafts by a helper, in the background — only the fields that
    have no version yet; drafts wait for the author's ✔ on 🚀 Launch kit."""
    try:
        if not ccb.active(svc, run, "extras"):
            return
        from . import launch_kit as lk  # noqa: PLC0415
        pid, branch = _pb(run)
        store, app = svc.store, svc.app
        d = lk.doc(store, pid, branch)
        fields = [f for f in lk.AI_FIELDS if not lk.newest(d, f)]
        prof = lk._profile(store, pid)  # noqa: SLF001
        if not fields or not (prof.get("title") or prof.get("idea")):
            return
        canon = lk.canon_of(app, pid, branch)
        if not lk.newest(d, "age_content"):
            lk.add_version(store, pid, branch, "age_content", lk.age_content(canon["profile"]), by="akowe",
                           note="made from the book profile")
        ctx = lk.gen_context(app, pid, branch, fields, d, canon, fix=False)
        schema = lk.gen_schema(fields)
        rid = run["id"]

        def fn(cancel):
            return jobs.launch_kit(store, lk.GEN_TASK, schema, ctx, cancel=cancel)

        def then(raw):
            made = 0
            for f in fields:
                try:
                    v = lk.clean_value(f, raw.get(f))
                except Exception:  # noqa: BLE001 - a field the helper got wrong is left for the 🚀 page
                    continue
                if v in ("", [], None) or lk.newest(lk.doc(store, pid, branch), f):
                    continue
                lk.add_version(store, pid, branch, f, v, by="ai", slot=ccb.PSEUDO_SLOT,
                               note="first draft, made in the background while the book was written")
                made += 1
            if made:
                _BgSvc(svc, run).event(run, "note", f"🚀 The launch kit's first drafts are ready ({made} part(s)): "
                                       "read and approve them on 🚀 Launch kit", code="EXTRAS_LAUNCH_KIT")
        f = ccb._submit(svc, run, ("launch_kit", pid, ccb._hash(json.dumps(ctx, sort_keys=True, default=str))),  # noqa: SLF001
                        "launch_kit", "writing the launch kit's first drafts in the background", fn, then)

        def timed(fut):
            try:
                r = fut.result()
            except Exception:  # noqa: BLE001
                r = None
            if r:
                _bump(rid, "extras", launch_kit_s=float(r.get("seconds") or 0.0), background=1)
        f.add_done_callback(timed)
    except Exception as exc:  # noqa: BLE001
        if _control(exc):
            raise
        log.exception("the launch kit could not start in the background")


def finish(svc, run: dict) -> None:
    """🤖 hook (autobook, before the run is marked done): give the background extras at most ``EXTRAS_WAIT_S`` to
    finish, then copy their progress and numbers into the run. What is still running finishes on its own."""
    try:
        rid = run["id"]
        state = _BG.get(rid) or {}
        th = state.get("thread")
        pid = run.get("project_id")
        with ccb._LOCK:  # noqa: SLF001
            lk = [f for k, f in ccb._FUTS.items() if k[:2] == ("launch_kit", pid) and not f.done()]  # noqa: SLF001
        end = time.monotonic() + EXTRAS_WAIT_S
        while time.monotonic() < end and ((th is not None and th.is_alive()) or not all(f.done() for f in lk)):
            time.sleep(0.1)
        still = int(th is not None and th.is_alive()) + sum(1 for f in lk if not f.done())
        if still:
            _bump(rid, "extras", still_running=still)
            svc.event(run, "note", "🤖 Some extras are still being made in the background (pictures or launch-kit "
                      "drafts): they appear in the Book Bible and on 🚀 Launch kit when they are done",
                      code="EXTRAS_STILL_RUNNING")
        ccb.sync(svc, run)
    except Exception:  # noqa: BLE001
        log.exception("could not finish the background extras")


# ====================================================================== 4. specialist reviewers
def speakers(store, pid: str, branch: str, text: str) -> list[tuple[str, dict]]:
    """The main characters who speak in this chapter (a voice card and at least two dialogue paragraphs that name
    them), most lines first: [(name, voice card)]."""
    from . import characters as chars_mod  # noqa: PLC0415
    from .prose_audit import paragraphs  # noqa: PLC0415
    pars = [p for p in paragraphs(text or "") if re.search(r"[\"“”]", p)]
    if not pars:
        return []
    entries = chars_mod.all_entries(store, pid, branch)
    found = []
    for c in chars_mod.canon_characters(store, pid, branch):
        e = entries.get(c["record_id"]) or {}
        if not e.get("voice") or chars_mod.is_empty(e.get("sheet"), e.get("voice")):
            continue
        first = str(c.get("name") or "").split()[0] if c.get("name") else ""
        if len(first) < 2:
            continue
        k = sum(1 for p in pars if re.search(rf"\b{re.escape(first)}\b", p))
        if k >= 2:
            found.append((k, c, e))
    found.sort(key=lambda x: -x[0])
    return [(c["name"], chars_mod.full_card(c, e)) for _k, c, e in found[:MAX_DIALOGUE]]


def sense_rate(text: str) -> float:
    ws = re.findall(r"[a-z]+", (text or "").lower())
    return 1000.0 * sum(1 for w in ws if w in SENSE_WORDS) / len(ws) if ws else 0.0


def named_feelings(text: str) -> int:
    return len(FEELING_RX.findall(text or ""))


def specialist_futures(svc, run: dict, cp: dict, nums: dict[int, str], texts: dict[str, str]) -> dict[str, list]:
    """🤖 (claude_code_book._Checks, per-chapter checks only, when Claude did not write the chapter): the specialist
    reviewers this chapter needs, as helper futures {kind: [future]} whose result is problems in the checks' format."""
    try:
        if len(nums) != 1 or not ccb.active(svc, run, "specialists"):
            return {}
        on = cc.settings(svc.store).get("specialists") or {}
        (n, cid), = nums.items()
        text = texts.get(cid) or ""
        if not text.strip():
            return {}
        store = svc.store
        pid, branch = _pb(run)
        from .assist import book_profile_brief  # noqa: PLC0415
        book = book_profile_brief(store, pid)
        h = ccb._hash(text)  # noqa: SLF001
        out: dict[str, list] = {}
        skipped = 0

        def add(kind, ctx, who=""):
            def fn(cancel):
                raw, res = jobs.specialist(store, kind, ctx, cancel=cancel)
                return jobs.clean_specialist(raw, kind, nums, texts, who), res
            what = {"dialogue": f"checking {who}'s dialogue in chapter {n}", "pacing": f"checking the pacing of "
                    f"chapter {n}", "sensory": f"checking the senses and detail of chapter {n}",
                    "subtext": f"checking the subtext of chapter {n}"}[kind]
            out.setdefault(kind, []).append(ccb._submit(svc, run, (kind, pid, cp.get("id"), h, who), kind, what, fn))  # noqa: SLF001
        base = {"book": book, "chapter": n, "chapter_text": text}
        if on.get("dialogue"):
            sp = speakers(store, pid, branch, text)
            for name, card in sp:
                add("dialogue", dict(base, character=name, voice_card=card), name)
            skipped += int(not sp)
        if on.get("pacing"):
            try:
                from . import lengths  # noqa: PLC0415
                tw = lengths.of_book(store, pid, None).get("target_words")
            except Exception:  # noqa: BLE001
                tw = None
            add("pacing", dict(base, target_words=tw))
        if on.get("sensory"):
            if sense_rate(text) < SENSORY_MIN:
                add("sensory", base)
            else:
                skipped += 1
        if on.get("subtext"):
            if named_feelings(text) >= SUBTEXT_MIN:
                add("subtext", base)
            else:
                skipped += 1
        _bump(run["id"], "specialists", jobs=sum(len(v) for v in out.values()), skipped=skipped)
        return out
    except Exception as exc:  # noqa: BLE001
        if _control(exc):
            raise
        log.exception("the specialist reviewers could not start")
        return {}


# ====================================================================== 6. your style and 7. specifics (proposals)
def _story_map_quotes(store, pid, branch) -> list[str]:
    from .human_voice import _story_map_quotes as smq  # noqa: PLC0415
    return smq(store, pid, branch)


def _off_the_map(items: list[dict], quotes: list[str]) -> list[dict]:
    """The story map's approved / 🔒 locked passages are never rewritten."""
    return [i for i in items if not any(i["quote"] in q or q in i["quote"] for q in quotes)]


def _proposal(ln: dict) -> dict:
    return {"quote": ln["quote"], "problem": ln["problem"], "original": ln["quote"], "replacement": ln["rewrite"]}


def style_future(svc, run: dict, cid: str, number: int, rec: dict):
    """6. A book in the author's own style (a real ✒️ style card, not the book's automatic voice): the narration's
    drift from the card, as proposals."""
    from . import style_card  # noqa: PLC0415
    pid, branch = _pb(run)
    store = svc.store
    entry = style_card.book_entry(store, pid)
    if not entry or not entry.get("on") or entry.get("auto") or not isinstance(entry.get("brief"), dict):
        return None
    text = str((rec.get("data") or {}).get("text") or "")
    if not text.strip():
        return None
    locked, reps = ccb._keeps(svc, run, text, rec)  # noqa: SLF001
    card = entry["brief"]
    h = ccb._hash(text)  # noqa: SLF001

    def fn(cancel):
        return jobs.match_style(store, text, card, keep_exactly=locked, keep_repeats=reps, cancel=cancel)

    def then(out):
        items = [_proposal(ln) for ln in _off_the_map(out["lines"], _story_map_quotes(store, pid, branch))]
        ccb._proposals_put(store, pid, branch, cid, "style", items,  # noqa: SLF001
                           {"number": number, "style_hash": h, "style_drift": out.get("drift") or []})
    return ccb._submit(svc, run, ("style", pid, cid, h), "style",  # noqa: SLF001
                       f"comparing chapter {number} with your writing style", fn, then)


def specifics_future(svc, run: dict, cid: str, number: int, rec: dict):
    """7. Generic details and too-tidy dialogue, with concrete / messier rewrites, as proposals."""
    pid, branch = _pb(run)
    store = svc.store
    text = str((rec.get("data") or {}).get("text") or "")
    if not text.strip():
        return None
    locked, reps = ccb._keeps(svc, run, text, rec)  # noqa: SLF001
    from .assist import book_profile_brief  # noqa: PLC0415
    book = book_profile_brief(store, pid)
    try:
        from .scenes import world_view  # noqa: PLC0415
        world = world_view(svc.app.engine, pid, branch)
    except Exception:  # noqa: BLE001
        world = []
    h = ccb._hash(text)  # noqa: SLF001

    def fn(cancel):
        return jobs.specifics(store, text, book=book, world=world, keep_exactly=locked, keep_repeats=reps,
                              cancel=cancel)

    def then(lines):
        lines = _off_the_map(lines, _story_map_quotes(store, pid, branch))
        meta = {"number": number, "specifics_hash": h}
        ccb._proposals_put(store, pid, branch, cid, "detail",  # noqa: SLF001
                           [_proposal(ln) for ln in lines if ln["type"] == "generic_detail"], meta)
        ccb._proposals_put(store, pid, branch, cid, "dialogue",  # noqa: SLF001
                           [_proposal(ln) for ln in lines if ln["type"] == "tidy_dialogue"], meta)
    return ccb._submit(svc, run, ("specifics", pid, cid, h), "specifics",  # noqa: SLF001
                       f"finding generic details and too-tidy dialogue in chapter {number}", fn, then)


def after_approval(svc, run: dict, cid: str, number: int, rec: dict) -> None:
    """🤖 (claude_code_book.chapter_approved): the style match and the specifics pass, in the background."""
    try:
        if ccb.active(svc, run, "style"):
            style_future(svc, run, cid, number, rec)
        if ccb.active(svc, run, "specifics"):
            specifics_future(svc, run, cid, number, rec)
    except Exception as exc:  # noqa: BLE001
        if _control(exc):
            raise
        log.exception("the style and specifics passes could not start")
