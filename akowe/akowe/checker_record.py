"""📊 How good is each checker: a track record of every AI that checks the book (data, not guessing).

For each AI family — ChatGPT, Claude, Gemini, the 🤖 Claude Code helpers and 🎩 Alfred (the local AI) when they
check — Akọwe writes down how each of its findings and review verdicts turned out:

* **confirmed** — the writer's fix answered it and the record was then approved (the next review passed); another AI
  found the same problem on its own (a checkpoint merge: two or more agree); or the author accepted the change;
* **overruled** (a false alarm) — the author kept the original; the version this AI rejected was approved after all
  (the author accepted the change, approved it anyway, or another reviewer passed it); or the AI quoted words that are
  not in the chapter (``cross_check.merge`` drops it: the existing word-for-word quote check);
* **missed** — another AI (or a later checkpoint) found a confirmed problem in exactly the text this AI had read or
  approved: the same checkpoint part, or the same approved version of the chapter with the quote found in it word for
  word. Nothing else counts as "the same passage".

A 🧑‍⚖️ stand-in decision (stand_in.py) counts too, as its own kind (``stand_in``): confirmed when it stands, overruled
when the author presses ↩ Undo.

What is stored (setting ``checker_record``): per AI the last ``WINDOW`` outcomes as codes and times only —
``{"k": kind, "o": outcome, "t": epoch}`` (plus a short id for a stand-in decision, so Undo can turn it round) — and
lifetime totals. Never a quote, a finding, a name from the book or any other book text. The window keeps recent books
weighing more: old outcomes fall out as new ones come in.

The score is plain: "ChatGPT: 87% of its corrections held up · 3 false alarms in the last 50". Below
``MIN_SAMPLE`` judged outcomes it says "needs more data" (with the small numbers, labelled as small). The automatic
checker order (checker_order.py) uses ``ranking`` only once at least two AIs have enough data.

Every function here is safe to call from anywhere: it never raises into a run.
"""
from __future__ import annotations

import copy
import logging
import threading
import time

log = logging.getLogger("akowe.checker_record")

SETTING = "checker_record"
KINDS = ("bible", "chapter", "continuity", "style", "stand_in")
KIND_WORDS = {"bible": "Book Bible records", "chapter": "chapters", "continuity": "continuity checks",
              "style": "style checks", "stand_in": "stand-in decisions"}
OUTCOMES = ("confirmed", "overruled", "missed")
WINDOW = 200          # the last N outcomes per AI count (recent books weigh more; older ones fall out)
RECENT = 50           # "… false alarms in the last 50"
MIN_SAMPLE = 10       # below this many judged outcomes: "needs more data"
NAMES = {"chatgpt": "ChatGPT", "claude": "Claude", "gemini": "Gemini", "claude_code": "Claude Code helpers",
         "local": "🎩 Alfred (your local AI)"}
CLAUDE_CODE_SLOT = "claude-code"   # claude_code_book.PSEUDO_SLOT
LOCAL = "local"

_LOCK = threading.RLock()
_clock = time.time


def name_of(fam: str | None) -> str:
    return NAMES.get(str(fam or ""), str(fam or "an AI"))


def family_of_slot(prov, slot_id: str | None) -> str | None:
    """The AI family that answered in a slot: chatgpt / claude / gemini (the web site or the API), ``claude_code`` for
    the helpers, else the slot id (an AI Akọwe cannot name, e.g. a test AI). None for no slot."""
    if not slot_id:
        return None
    if slot_id == CLAUDE_CODE_SLOT:
        return "claude_code"
    if slot_id == LOCAL:
        return LOCAL
    try:
        from . import providers as providers_mod  # noqa: PLC0415
        base = getattr(prov, "_base", prov)
        s = next((x for x in base.slots() if x["slot_id"] == slot_id), None)
        return providers_mod.slot_family(s) or slot_id
    except Exception:  # noqa: BLE001
        return slot_id


def kind_of_module(module_id: str | None) -> str:
    """Which kind of check a record review is: a chapter, or a Book Bible record (characters, places, the plan …)."""
    return "chapter" if module_id == "C02" else "bible"


# ====================================================================== storage (numbers and codes only)
def _load(store) -> dict:
    try:
        cur = store.get_setting(SETTING)
    except Exception:  # noqa: BLE001
        cur = None
    if not isinstance(cur, dict) or not isinstance(cur.get("ais"), dict):
        return {"v": 1, "ais": {}}
    return copy.deepcopy(cur)


def _save(store, data: dict) -> None:
    store.set_setting(SETTING, data)


def note(store, fam: str | None, kind: str, outcome: str, *, now: float | None = None, ref: str | None = None) -> bool:
    """One outcome for one AI. ``ref``: a short id (a stand-in decision) so ``flip`` can find it. Never raises."""
    if not fam or kind not in KINDS or outcome not in OUTCOMES:
        return False
    try:
        t = float(_clock() if now is None else now)
        with _LOCK:
            data = _load(store)
            a = data["ais"].setdefault(str(fam)[:40], {"ev": [], "total": {}})
            ev = {"k": kind, "o": outcome, "t": round(t, 1)}
            if ref:
                ev["i"] = str(ref)[:40]
            a["ev"] = (list(a.get("ev") or []) + [ev])[-WINDOW:]
            tot = a.setdefault("total", {})
            tot[outcome] = int(tot.get(outcome) or 0) + 1
            _save(store, data)
        return True
    except Exception:  # noqa: BLE001 - a track record never breaks a run
        log.debug("could not write a checker outcome", exc_info=True)
        return False


def note_many(store, rows, ref: str | None = None) -> int:
    """``rows``: [(fam, kind, outcome)] written in ONE save (``ref``: an id on each, for ``flip_all``)."""
    rows = [(f, k, o) for f, k, o in rows or [] if f and k in KINDS and o in OUTCOMES]
    if not rows:
        return 0
    try:
        t = round(float(_clock()), 1)
        with _LOCK:
            data = _load(store)
            for fam, kind, outcome in rows:
                a = data["ais"].setdefault(str(fam)[:40], {"ev": [], "total": {}})
                ev = {"k": kind, "o": outcome, "t": t}
                if ref:
                    ev["i"] = str(ref)[:40]
                a["ev"] = (list(a.get("ev") or []) + [ev])[-WINDOW:]
                tot = a.setdefault("total", {})
                tot[outcome] = int(tot.get(outcome) or 0) + 1
            _save(store, data)
        return len(rows)
    except Exception:  # noqa: BLE001
        log.debug("could not write checker outcomes", exc_info=True)
        return 0


def flip(store, fam: str | None, ref: str, outcome: str) -> bool:
    """Turn a recorded outcome round (the author undid a stand-in decision: confirmed -> overruled)."""
    if not fam or not ref or outcome not in OUTCOMES:
        return False
    try:
        with _LOCK:
            data = _load(store)
            a = data["ais"].get(str(fam))
            if not a:
                return False
            for ev in reversed(a.get("ev") or []):
                if ev.get("i") == ref:
                    old = ev.get("o")
                    if old == outcome:
                        return False
                    ev["o"] = outcome
                    tot = a.setdefault("total", {})
                    if old in OUTCOMES:
                        tot[old] = max(0, int(tot.get(old) or 0) - 1)
                    tot[outcome] = int(tot.get(outcome) or 0) + 1
                    _save(store, data)
                    return True
        return False
    except Exception:  # noqa: BLE001
        log.debug("could not change a checker outcome", exc_info=True)
        return False


def flip_all(store, ref: str, *, skip_kind: str | None = None) -> int:
    """Every outcome written with ``ref`` turned round (confirmed <-> overruled; a miss stays): the author undid the
    decision they came from. Returns how many changed."""
    if not ref:
        return 0
    swap = {"confirmed": "overruled", "overruled": "confirmed"}
    n = 0
    try:
        with _LOCK:
            data = _load(store)
            for a in data["ais"].values():
                for ev in a.get("ev") or []:
                    if ev.get("i") == ref and ev.get("o") in swap and ev.get("k") != skip_kind:
                        tot = a.setdefault("total", {})
                        tot[ev["o"]] = max(0, int(tot.get(ev["o"]) or 0) - 1)
                        ev["o"] = swap[ev["o"]]
                        tot[ev["o"]] = int(tot.get(ev["o"]) or 0) + 1
                        n += 1
            if n:
                _save(store, data)
        return n
    except Exception:  # noqa: BLE001
        log.debug("could not turn the outcomes round", exc_info=True)
        return 0


# ====================================================================== scores and plain words
def _counts(evs: list[dict]) -> dict:
    c = {o: 0 for o in OUTCOMES}
    for e in evs:
        if e.get("o") in c:
            c[e["o"]] += 1
    return c


def _held(c: dict) -> int | None:
    judged = c["confirmed"] + c["overruled"]
    return round(100 * c["confirmed"] / judged) if judged else None


def score(c: dict) -> float | None:
    """The ranking score: corrections that held up, a miss counting as half a false alarm. None: nothing judged."""
    den = c["confirmed"] + c["overruled"] + 0.5 * c["missed"]
    return c["confirmed"] / den if den else None


def stats_of(store, fam: str) -> dict:
    data = _load(store)
    evs = list((data["ais"].get(fam) or {}).get("ev") or [])
    return _stats(fam, evs)


def _stats(fam: str, evs: list[dict], kinds: tuple = KINDS) -> dict:
    checks = [e for e in evs if e.get("k") != "stand_in"]
    c = _counts(checks)
    judged = sum(c.values())
    recent = checks[-RECENT:]
    rc = _counts(recent)
    enough = judged >= MIN_SAMPLE
    held = _held(c)
    per_kind = {}
    for k in kinds:
        kc = _counts([e for e in evs if e.get("k") == k])
        n = sum(kc.values())
        if n:
            per_kind[k] = dict(kc, judged=n, held_pct=_held(kc), enough=n >= MIN_SAMPLE, words=_kind_line(k, kc, n))
    out = {"family": fam, "name": name_of(fam), "judged": judged, "enough": enough, "held_pct": held,
           "score": score(c), "false_alarms_recent": rc["overruled"], "missed_recent": rc["missed"],
           "recent_n": len(recent), **c, "kinds": per_kind}
    out["words"] = line(out)
    return out


def _kind_line(kind: str, c: dict, n: int) -> str:
    held = _held(c)
    what = KIND_WORDS.get(kind, kind)
    if kind == "stand_in":
        base = f"{n} stand-in decision{'s' if n != 1 else ''}: {c['confirmed']} stood, {c['overruled']} undone by you"
        return base + (" (a small sample)" if n < MIN_SAMPLE else "")
    if n < MIN_SAMPLE:
        return f"{what}: needs more data ({n} so far)"
    return f"{what}: {held if held is not None else '—'}% held up, {c['overruled']} false alarm(s), {c['missed']} missed"


def line(st: dict) -> str:
    """"ChatGPT: 87% of its corrections held up · 3 false alarms in the last 50" — or "needs more data"."""
    name = st["name"]
    if not st["judged"]:
        return f"{name}: needs more data (nothing checked yet)"
    if not st["enough"]:
        bits = f"so far {st['confirmed']} held up, {st['overruled']} false alarm(s), {st['missed']} missed"
        return f"{name}: needs more data — only {st['judged']} judged ({bits}; a small sample)"
    held = st["held_pct"]
    fa = st["false_alarms_recent"]
    s = (f"{name}: {held}% of its corrections held up" if held is not None else f"{name}: no corrections judged yet")
    s += f" · {fa} false alarm{'s' if fa != 1 else ''} in the last {st['recent_n']}"
    if st["missed_recent"]:
        s += f" · missed {st['missed_recent']} that another AI found"
    return s


def ranking(store, fams) -> list[str] | None:
    """The families best track record first, or None when fewer than two of them have enough data (the caller then
    keeps its usual order). Families without enough data come after the ranked ones, in the order given."""
    fams = [f for f in dict.fromkeys(fams or []) if f]
    if len(fams) < 2:
        return None
    data = _load(store)
    sts = {f: _stats(f, list((data["ais"].get(f) or {}).get("ev") or [])) for f in fams}
    ranked = [f for f in fams if sts[f]["enough"] and sts[f]["score"] is not None]
    if len(ranked) < 2:
        return None
    ranked.sort(key=lambda f: -float(sts[f]["score"]))
    return ranked + [f for f in fams if f not in ranked]


def card(store, prov=None) -> dict:
    """📊 What the "How good is each checker" card shows: one row per AI (the three web AIs always, plus any other AI
    with outcomes), plain words, and whether the automatic order uses the data yet."""
    data = _load(store)
    fams = ["chatgpt", "claude", "gemini"]
    try:
        if prov is not None:
            from . import providers as providers_mod  # noqa: PLC0415
            base = getattr(prov, "_base", prov)
            for s in base.slots():
                if s.get("adapter_id") in ("none", None):
                    continue
                f = providers_mod.slot_family(s)
                if f and f not in fams:
                    fams.append(f)
    except Exception:  # noqa: BLE001
        log.debug("could not list the AIs for the checker card", exc_info=True)
    fams += [f for f in data["ais"] if f not in fams]
    rows = [_stats(f, list((data["ais"].get(f) or {}).get("ev") or [])) for f in fams]
    rows = [r for r in rows if r["judged"] or r["family"] in ("chatgpt", "claude", "gemini")
            or r["kinds"].get("stand_in")]
    rank = ranking(store, [r["family"] for r in rows])
    return {"ais": rows, "ranked": rank, "min_sample": MIN_SAMPLE, "window": WINDOW, "recent": RECENT,
            "uses_data": rank is not None,
            "about": ("Each AI's corrections and review verdicts are checked against what happened next: did the "
                      "writer's fix settle it, did another AI find the same thing, did you accept it — or did you keep "
                      f"the original, or did it quote words that are not in the book? Only the last {WINDOW} "
                      f"outcomes per AI count, so recent books weigh most. Under {MIN_SAMPLE} it says “needs more "
                      "data”: a few lucky or unlucky checks prove nothing. No book text is stored — only counts."),
            "order_words": ("The automatic checker order uses these numbers now (best track record first)."
                            if rank else "Not enough data yet for the automatic order: Akọwe keeps its usual order "
                                         "until at least two AIs have enough checks behind them.")}


# ====================================================================== what happened in a run (no AI)
def remember_verdicts(run: dict, rid: str, version: int, module_id: str | None, review: dict, prov) -> None:
    """After a review of record ``rid`` (version ``version``): keep who said what (one or two reviewers), so the
    outcome can be settled when the record is approved. Kept in the run (codes only)."""
    try:
        rows = review.get("reviewers") if isinstance(review.get("reviewers"), list) else None
        if not rows:
            rows = [{"slot": review.get("slot"), "verdict": review.get("verdict")}]
        if review.get("independent") is False:
            return  # the writer reviewed its own draft: not a check of anyone else's work
        trail = run.setdefault("ck_verdicts", {})
        lst = list(trail.get(rid) or [])
        for r in rows:
            fam = family_of_slot(prov, r.get("slot"))
            if fam and r.get("verdict") in ("APPROVE", "REVISE", "REJECT"):
                lst.append({"f": fam, "v": r["verdict"], "n": int(version), "k": kind_of_module(module_id)})
        trail[rid] = lst[-16:]
    except Exception:  # noqa: BLE001
        log.debug("could not keep the review verdicts", exc_info=True)


def settle(store, run: dict, rid: str, approved_version: int, *, how: str = "review",
           chapter_id: str | None = None, ref: str | None = None) -> list[tuple]:
    """Record ``rid`` was approved at ``approved_version``: turn the verdicts kept for it into outcomes.

    * ``how`` = "keep_original": the author put the original back — every objection was overruled.
    * otherwise an objection to the approved version itself is overruled (it was approved after all), an objection to
      an earlier version is confirmed (the fix answered it and the next review passed), and an APPROVE given to an
      earlier version that another AI's (now confirmed) objection was about is a miss (the same version: clearly the
      same text).

    Returns the rows written [(fam, kind, outcome)]. Never raises."""
    try:
        lst = list((run.get("ck_verdicts") or {}).pop(rid, None) or [])
        if not lst:
            return []
        rows = []
        objections_confirmed = set()
        for e in lst:
            if e["v"] == "APPROVE":
                continue
            if how == "keep_original" or int(e["n"]) >= int(approved_version):
                rows.append((e["f"], e["k"], "overruled"))
            else:
                rows.append((e["f"], e["k"], "confirmed"))
                objections_confirmed.add(int(e["n"]))
        for e in lst:
            if e["v"] == "APPROVE" and int(e["n"]) in objections_confirmed and int(e["n"]) < int(approved_version):
                if not any(x["v"] != "APPROVE" and x["f"] == e["f"] and int(x["n"]) == int(e["n"]) for x in lst):
                    rows.append((e["f"], e["k"], "missed"))
        # who approved the version that counts (a later checkpoint may find something in exactly that text)
        if chapter_id:
            fams = sorted({e["f"] for e in lst if e["v"] == "APPROVE" and int(e["n"]) == int(approved_version)})
            if fams:
                run.setdefault("ck_approved", {})[chapter_id] = {"n": int(approved_version), "f": fams, "r": rid}
        note_many(store, rows, ref=ref)
        return rows
    except Exception:  # noqa: BLE001
        log.debug("could not settle the review verdicts", exc_info=True)
        return []


def from_merge(store, run: dict | None, merged: list[dict], read_by: list[str], prov, *, kind: str = "continuity",
               versions: dict | None = None) -> list[tuple]:
    """What a checkpoint's merge (cross_check.merge) says about each AI that read the part: a problem two or more
    found is confirmed for each of them and missed by every other AI that read the same part; a problem whose quote is
    not in the chapter is a false alarm for the one that reported it. A confirmed problem in a chapter whose approved
    version is still the one the chapter's reviewers passed is a miss for each of those reviewers (``versions``:
    chapter_id -> the version read now). Never raises."""
    try:
        fam_of = {s: family_of_slot(prov, s) for s in read_by}
        rows = []
        for p in merged or []:
            finders = {fam_of.get(s) or family_of_slot(prov, s) for s in p.get("slots") or []}
            finders.discard(None)
            if p.get("plan") == "dropped":
                rows += [(f, kind, "overruled") for f in finders]
                continue
            if p.get("agreement") != "confirmed":
                continue
            rows += [(f, kind, "confirmed") for f in finders]
            rows += [(f, kind, "missed") for s, f in fam_of.items() if f and f not in finders]
            appr = ((run or {}).get("ck_approved") or {}).get(p.get("chapter_id")) if run else None
            if appr and p.get("verified") and versions and versions.get(p.get("chapter_id")) == appr.get("n"):
                rows += [(f, "chapter", "missed") for f in appr.get("f") or [] if f not in finders]
        # one row per AI per outcome per problem is fine; never the same AI twice for one problem
        note_many(store, rows)
        return rows
    except Exception:  # noqa: BLE001
        log.debug("could not record the checkpoint outcomes", exc_info=True)
        return []
