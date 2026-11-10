"""🏆 Who writes best: a track record of the chapters each AI writes, and "let the best writer write more" (no AI).

The checker record (checker_record.py) says how good each AI is at CHECKING. This is the writer's side: for each AI
family (ChatGPT, Claude, Gemini, …) the editor's score of every chapter it wrote — the editor's FIRST reading of the
chapter (before any editor rewrite), so the number measures the writer's own draft. The writer is the AI that wrote the
approved version (review.writer_of). A chapter whose editor is the same AI as its writer does not count (an AI marking
its own work), and a chapter without an editor reading does not count either.

What is stored (setting ``writer_record``): per AI the last ``WINDOW`` scores as numbers and codes only —
``{"s": 8.1, "t": epoch, "i": "<record id>:<version>"}`` — so recent books weigh most and the same chapter is never
counted twice. Never a quote, a name from the book or any other book text.

**Let the best writer write more** (setting ``writer_pick``, default on): when ⚡ Make-a-book chooses who writes a
chapter by itself (the author did not pick an AI in "Which AI"), the AI with the best average writes the chapter —
once at least two working AIs have ``MIN_CHAPTERS`` scored chapters each. Every ``EXPLORE_EVERY``-th chapter goes to
another working AI (the one with the fewest scored chapters first), so the record stays fair and a newcomer can
catch up. An AI that is not working right now (busy, at its usage limit, being repaired) is never preferred: the run
falls back to the usual choice. The author's own "Which AI" choice always wins. The preference only re-orders the
AIs that may write anyway (providers.eligible) — it never adds an AI call.

Every function here is safe to call from anywhere: it never raises into a run.
"""
from __future__ import annotations

import copy
import logging
import threading
import time

log = logging.getLogger("akowe.writer_record")

SETTING = "writer_record"
PICK_SETTING = "writer_pick"
WINDOW = 60            # the last N scored chapters per AI count (about the last few books)
MIN_CHAPTERS = 3       # scored chapters each before the record decides anything
EXPLORE_EVERY = 4      # every 4th chapter goes to another AI so the record stays fair
NAMES = {"chatgpt": "ChatGPT", "claude": "Claude", "gemini": "Gemini"}

_LOCK = threading.RLock()
_clock = time.time


def name_of(fam: str | None) -> str:
    return NAMES.get(str(fam or ""), str(fam or "an AI"))


# ====================================================================== settings
def settings(store) -> dict:
    try:
        cur = store.get_setting(PICK_SETTING)
    except Exception:  # noqa: BLE001
        cur = None
    on = cur.get("enabled") if isinstance(cur, dict) else None
    return {"enabled": True if on is None else bool(on)}


def save_settings(store, body) -> dict:
    from .errors import AkoweError  # noqa: PLC0415
    if not isinstance(body, dict) or not isinstance(body.get("enabled"), bool):
        raise AkoweError("INVALID_INPUT", "/enabled", "enabled must be true or false", status="REJECTED")
    store.set_setting(PICK_SETTING, {"enabled": body["enabled"]})
    return settings(store)


# ====================================================================== storage (numbers and codes only)
def _load(store) -> dict:
    try:
        cur = store.get_setting(SETTING)
    except Exception:  # noqa: BLE001
        cur = None
    if not isinstance(cur, dict) or not isinstance(cur.get("ais"), dict):
        return {"v": 1, "ais": {}}
    return copy.deepcopy(cur)


def note(store, fam: str | None, score, ref: str | None = None, *, now: float | None = None) -> bool:
    """One scored chapter for one AI (``ref``: "<record id>:<version>", counted once). Never raises."""
    try:
        s = float(score)
    except (TypeError, ValueError):
        return False
    if not fam or not (0 <= s <= 10):
        return False
    try:
        with _LOCK:
            data = _load(store)
            a = data["ais"].setdefault(str(fam)[:40], {"ev": [], "n": 0})
            evs = list(a.get("ev") or [])
            if ref and any(e.get("i") == str(ref)[:80] for e in evs):
                return False
            ev = {"s": round(s, 2), "t": round(float(_clock() if now is None else now), 1)}
            if ref:
                ev["i"] = str(ref)[:80]
            a["ev"] = (evs + [ev])[-WINDOW:]
            a["n"] = int(a.get("n") or 0) + 1
            store.set_setting(SETTING, data)
        return True
    except Exception:  # noqa: BLE001 - a track record never breaks a run
        log.debug("could not write a writer score", exc_info=True)
        return False


def stats(store) -> dict:
    """{family: {"n": scored chapters in the window, "avg": average score or None, "enough": bool}}."""
    out = {}
    for fam, a in _load(store)["ais"].items():
        ss = [float(e["s"]) for e in a.get("ev") or [] if isinstance(e.get("s"), (int, float))]
        out[fam] = {"n": len(ss), "avg": round(sum(ss) / len(ss), 1) if ss else None,
                    "enough": len(ss) >= MIN_CHAPTERS}
    return out


# ====================================================================== the choice (no AI)
def choose(store, fams: list[str], number: int, *, enabled: bool = True) -> dict | None:
    """Which AI family should write chapter ``number`` (1-based), among the working families ``fams`` (in the usual
    order). None: no preference (the usual choice). Else {"family", "why": best|explore, "best", "line"}."""
    try:
        fams = [f for f in dict.fromkeys(fams or []) if f]
        if not enabled or len(fams) < 2:
            return None
        st = stats(store)
        ranked = sorted((f for f in fams if (st.get(f) or {}).get("enough")), key=lambda f: -float(st[f]["avg"]))
        explore = int(number) > 0 and int(number) % EXPLORE_EVERY == 0
        if len(ranked) < 2:
            if not explore:
                return None
            # not enough data yet: every 4th chapter goes to the AI with the fewest scored chapters, so data builds
            low = min(fams, key=lambda f: ((st.get(f) or {}).get("n") or 0, fams.index(f)))
            return {"family": low, "why": "explore", "best": None,
                    "line": f"Chapter {number} goes to {name_of(low)} so Akọwe learns how well each AI writes "
                            f"(it needs {MIN_CHAPTERS} scored chapters from at least two AIs)."}
        best = ranked[0]
        line = best_line(st, best, ranked[1:])
        if explore:
            others = [f for f in fams if f != best]
            low = min(others, key=lambda f: ((st.get(f) or {}).get("n") or 0, others.index(f)))
            return {"family": low, "why": "explore", "best": best,
                    "line": f"Chapter {number} goes to {name_of(low)} so the record stays fair. {line}"}
        return {"family": best, "why": "best", "best": best, "line": line}
    except Exception:  # noqa: BLE001
        log.debug("could not choose a writer", exc_info=True)
        return None


def best_line(st: dict, best: str, others: list[str]) -> str:
    """"Claude writes most chapters: its chapters score 8.1 vs ChatGPT 7.4"."""
    vs = " and ".join(f"{name_of(f)} {st[f]['avg']:.1f}" for f in others if (st.get(f) or {}).get("avg") is not None)
    return f"{name_of(best)} writes most chapters: its chapters score {st[best]['avg']:.1f}" + (f" vs {vs}" if vs else "")


def card(store, prov=None) -> dict:
    """🏆 What Settings shows: one plain line per AI, whether the choice uses the data yet, and the switch."""
    st = stats(store)
    fams = ["chatgpt", "claude", "gemini"]
    try:
        if prov is not None:
            from . import providers as providers_mod  # noqa: PLC0415
            base = getattr(prov, "_base", prov)
            for s in base.ai_slots():
                f = providers_mod.slot_family(s)
                if f and f not in fams:
                    fams.append(f)
    except Exception:  # noqa: BLE001
        log.debug("could not list the AIs for the writer card", exc_info=True)
    fams += [f for f in st if f not in fams]
    rows = []
    for f in fams:
        s = st.get(f) or {"n": 0, "avg": None, "enough": False}
        if not s["n"]:
            words = f"{name_of(f)}: no scored chapters yet"
        elif not s["enough"]:
            words = (f"{name_of(f)}: needs more data — {s['n']} scored chapter{'s' if s['n'] != 1 else ''} so far "
                     f"(average {s['avg']:.1f}/10; a small sample)")
        else:
            words = f"{name_of(f)}: its chapters score {s['avg']:.1f}/10 on average ({s['n']} chapters)"
        rows.append({"family": f, "name": name_of(f), "n": s["n"], "avg": s["avg"], "enough": s["enough"],
                     "words": words})
    ranked = sorted((r for r in rows if r["enough"]), key=lambda r: -float(r["avg"]))
    cfg = settings(store)
    if not cfg["enabled"]:
        order = "Switched off: Akọwe chooses the writer the usual way."
    elif len(ranked) >= 2:
        order = best_line(st, ranked[0]["family"], [r["family"] for r in ranked[1:]]) + \
            f" — so it writes most chapters; every {EXPLORE_EVERY}th chapter goes to another AI to keep the record fair."
    else:
        order = (f"Not enough data yet: Akọwe needs {MIN_CHAPTERS} scored chapters from at least two AIs. Until then "
                 f"it chooses the writer the usual way, and every {EXPLORE_EVERY}th chapter goes to another AI so the "
                 "record can grow.")
    return {"ais": rows, "enabled": cfg["enabled"], "min_chapters": MIN_CHAPTERS, "window": WINDOW,
            "explore_every": EXPLORE_EVERY, "uses_data": cfg["enabled"] and len(ranked) >= 2, "order_words": order,
            "about": ("Each chapter an AI writes gets the editor's score (its first reading, before any rewrite). An "
                      "AI's own editor score does not count. Only the last "
                      f"{WINDOW} chapters per AI count, so recent books weigh most. No book text is stored — only "
                      "numbers. Your own choice in “Which AI” always wins.")}


# ====================================================================== inside a ⚡ run
def working_slots(prov) -> list[dict]:
    """The AI slots that could write right now, in the usual order (connected, healthy, not busy, not at a limit)."""
    try:
        base = getattr(prov, "_base", prov)
        out = []
        for s in base.ai_slots():
            if not s.get("healthy", True) or s.get("active_jobs", 0) >= s.get("max_concurrent", 1):
                continue
            if base.health.failed(s["slot_id"]) is not None or not base.available(s):
                continue
            out.append(s)
        out.sort(key=lambda s: (float(s.get("input_cost_minor_per_mtok") or 0), s["slot_id"]))
        return out
    except Exception:  # noqa: BLE001
        log.debug("could not list the working AIs", exc_info=True)
        return []


def before_chapter(store, prov, run: dict, number: int, *, editor_on: bool = True) -> str | None:
    """The slot to prefer for writing chapter ``number`` of this run, or None (the usual choice). Sets
    ``run["writer_pick"]`` (plain line + codes) for the run window. Never raises."""
    try:
        if (run.get("settings") or {}).get("slot_id"):
            return None  # the author's "Which AI" choice always wins
        if not settings(store)["enabled"] or not editor_on:
            run.pop("writer_pick", None)
            return None
        from . import providers as providers_mod  # noqa: PLC0415
        slots = working_slots(prov)
        by_fam: dict[str, str] = {}
        for s in slots:
            by_fam.setdefault(providers_mod.slot_family(s) or s["slot_id"], s["slot_id"])
        pick = choose(store, list(by_fam), number)
        if not pick:
            if len(by_fam) >= 2:
                run["writer_pick"] = {"line": None, "family": None, "why": None}
            return None
        run["writer_pick"] = {"line": pick["line"], "family": pick["family"], "why": pick["why"],
                              "best": pick["best"], "chapter": int(number)}
        return by_fam.get(pick["family"])
    except Exception:  # noqa: BLE001
        log.debug("could not prefer a writer", exc_info=True)
        return None


def after_chapter(svc, run: dict, rec: dict | None) -> bool:
    """Chapter ``rec`` (its approved version) is done: its writer gets the editor's first score. Never raises."""
    try:
        if not rec:
            return False
        ed = (run.get("editor") or {}).get(rec["record_id"]) or {}
        if ed.get("independent") is False:
            return False  # the editor was the writer: an AI marking its own work does not count
        first = next((h for h in ed.get("history") or [] if isinstance(h.get("avg"), (int, float))
                      and h.get("round") == 0), None)
        if not first:
            return False
        who = svc._review.writer_of(run["project_id"], run["branch_id"], rec)
        if who.get("kind") not in ("ai", "ai_fix") or not who.get("slot"):
            return False
        from . import checker_record  # noqa: PLC0415
        fam = checker_record.family_of_slot(svc.app.engine.providers, who["slot"])
        return note(svc.store, fam, first["avg"], f"{rec['record_id']}:{first.get('version') or rec.get('version')}")
    except Exception:  # noqa: BLE001
        log.debug("could not record the writer's score", exc_info=True)
        return False
