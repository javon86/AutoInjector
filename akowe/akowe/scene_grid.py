"""🗂 P27 Scene grid: the whole book on one page — chapters × scenes, in story order.

One row per scene: chapter, scene number, POV (the outline chapter's point-of-view character), place and time, who is
there, each one's goal, the obstacle and what changes (from the chapter's scene cards, scenes.py), the words of that
scene on the page and its readability numbers (readability.py, P24: reading level, words per sentence, dialogue share,
pace), and the problems Akọwe already knows about. Built on demand from stored data (nothing is stored, no AI is
asked); the browser page sorts and filters the rows, shows them as cards on a phone and prints cleanly.

Where each part comes from:

* chapters: the approved outline (B11) in its order; POV and place from the outline item's ``plan.pov_id`` /
  ``plan.location_id`` (names from the characters A01 and places A04);
* scenes: the chapter's scene cards (companion data, ``scene_cards:<pid>:<branch>``) — only cards made for the current
  outline version count as the plan; out-of-date cards are shown but flagged;
* words and readability per scene: the chapter's approved text (or its newest draft, marked) split on scene-break
  lines (``***``) exactly as readability.py splits it; scene *n* of the plan is matched with scene *n* on the page;
* problems: the scene cards' own check (``scenes.lint``) and the scene checker's notes, a plan and page with a
  different number of scenes, very short scenes, a chapter far under its length target (lengths.py), a chapter the
  editor or the planned-to-page check still had notes on, and the readability findings that name chapters.

Output (``build``): ``{project_id, branch_id, title, audience, outline, chapters: [{chapter_id, number, title,
objective, pov, place, state, words, target_words, min_words, grade, ease, avg_sentence, dialogue_share, pace,
cards: {version, status, usable, verdict, planned, written}, problems: [...], scenes: [{n, place, time, pov,
characters, goals: [{character, goal}], obstacle, change, words, grade, dialogue_share, avg_sentence, pace,
planned, written, problems: [...]}]}], totals: {...}, problem_words: {code: label}, povs, places}``.
Problems are ``{code, severity: major|minor|info, label}``. The scene cards' text is the author's own plan and is only
shown back to them on this page — never logged.
"""
from __future__ import annotations

import logging

from . import characters as chars_mod
from . import lengths as lengths_mod
from . import pipeline as pipeline_mod
from . import readability
from . import scenes as scenes_mod

log = logging.getLogger("akowe.scene_grid")

SHORT_SCENE = 150       # words: a scene this short is flagged (readability's "thin scene")
TEXT_MAX = 240          # characters of a card field on the grid (the full card is on the 🎬 scene page)

PROBLEM_WORDS = {
    "NO_GOAL": "No character has a goal",
    "GOAL_MISSING": "A character there has no goal",
    "NO_OBSTACLE": "Nothing gets in the way",
    "NO_UNSAID": "Nothing stays unsaid",
    "NO_CHANGE": "Nothing changes",
    "UNKNOWN_CHARACTER": "A name that is not a character of the book",
    "CHECKER_NOTE": "The scene checker had a note",
    "SHORT_SCENE": f"Very short scene (under {SHORT_SCENE} words)",
    "NOT_ON_PAGE": "Planned, but not on the page (fewer scenes written)",
    "NOT_PLANNED": "On the page, but not in the scene plan",
    "SCENE_COUNT": "The page has a different number of scenes than the plan",
    "NO_BREAKS": "Written without scene breaks: words per scene cannot be split",
    "NO_PLAN": "No scene cards for this chapter",
    "PLAN_OUT_OF_DATE": "The scene cards belong to an older outline",
    "NOT_WRITTEN": "Not written yet",
    "DRAFT": "Not approved yet (the newest draft is shown)",
    "UNDER_TARGET": "Far under the chapter's length target",
    "EDITOR_NOTES": "The editor still had notes",
    "PLANNED_MISSING": "Planned details not on the page",
    "READABILITY": "Reads differently from the rest of the book",
}


def _clip(v, n: int = TEXT_MAX) -> str:
    s = " ".join(str(v or "").split())
    return s if len(s) <= n else s[:n - 1].rstrip() + "…"


def _p(code: str, severity: str = "minor", label: str | None = None) -> dict:
    return {"code": code, "severity": severity, "label": label or PROBLEM_WORDS.get(code, code)}


def _body(text: str) -> str:
    """The chapter text without its '# Title' line(s), so the title is not counted as words of scene 1."""
    return "\n".join(x for x in str(text or "").splitlines() if not x.lstrip().startswith("# ")).strip()


def _title(text: str) -> str:
    first = str(text or "").lstrip().split("\n", 1)[0]
    return first[2:].strip()[:120] if first.startswith("# ") else ""


def _names(store, pid: str, branch: str, module: str) -> dict:
    """{subject id or record id: name} for every record of one A operation (characters A01, places A04)."""
    out = {}
    try:
        heads = store.list_records(pid, branch, module_id=module)
    except Exception:  # noqa: BLE001
        return out
    for r in heads:
        if r.get("record_kind") != "OUTPUT" or r.get("lifecycle") in ("REJECTED", "SUPERSEDED"):
            continue
        rec = store.get_record(pid, branch, r["record_id"], r["approved_version"]) if r.get("approved_version") else r
        name, subject = chars_mod._name_and_subject(rec or r)  # noqa: SLF001 - the one name rule of the book
        out[subject] = name
        out[r["record_id"]] = name
    return out


def _scene_numbers(text: str) -> list[dict]:
    """Readability numbers for each scene on the page (numbers only)."""
    out = []
    for part in readability.scenes(_body(text)):
        try:
            c = readability.chapter(part)
        except Exception:  # noqa: BLE001 - one odd scene never breaks the grid
            c = readability.chapter("")
        out.append({k: c.get(k) for k in ("words", "grade", "ease", "avg_sentence", "dialogue_share", "pace")})
    return out


def scene_rows(cards: list, written: list, *, written_any: bool, lint: list, checker: dict, pov: str,
               place: str) -> tuple[list[dict], list[dict]]:
    """(scene rows, chapter problems) of one chapter: scene n of the plan beside scene n on the page.

    Scenes on the page are only told apart by scene-break lines: a chapter written in one piece without breaks has one
    scene on the page, so with a plan of several scenes its words cannot be split — the rows then show the plan only
    and the chapter says so (NO_BREAKS), instead of flagging every later scene as missing."""
    probs: list[dict] = []
    split = len(written) >= 2 or len(cards) <= 1
    if not split:
        probs.append(_p("NO_BREAKS", "info"))
        written = []
    elif cards and written and len(written) != len(cards):
        probs.append(_p("SCENE_COUNT", "minor", f"{PROBLEM_WORDS['SCENE_COUNT']} (planned {len(cards)}, "
                                                f"on the page {len(written)})"))
    n_rows = max(len(cards), len(written))
    rows = []
    for i in range(n_rows):
        card = cards[i] if i < len(cards) else None
        page = written[i] if i < len(written) else None
        sc = {"n": i + 1, "planned": card is not None, "written": page is not None, "pov": pov,
              "place": _clip((card or {}).get("place"), 120) or place, "time": _clip((card or {}).get("time"), 120),
              "characters": [_clip(c, 80) for c in (card or {}).get("characters") or []][:8],
              "goals": [{"character": _clip(g.get("character"), 80), "goal": _clip(g.get("goal"))}
                        for g in (card or {}).get("goals") or [] if isinstance(g, dict)][:8],
              "obstacle": _clip((card or {}).get("obstacle")), "change": _clip((card or {}).get("change")),
              "problems": []}
        sc.update({k: (page or {}).get(k) for k in ("words", "grade", "ease", "avg_sentence", "dialogue_share",
                                                     "pace")})
        for pr in lint:
            if pr.get("scene") == i + 1:
                sc["problems"].append(_p(pr["code"], pr.get("severity") or "minor",
                                         _clip(pr.get("message"), 160) if pr.get("name") else None))
        ck = checker.get(i + 1)
        if ck and not (ck.get("goal") and ck.get("obstacle_from_world") and ck.get("unsaid")):
            sc["problems"].append(_p("CHECKER_NOTE", "minor", PROBLEM_WORDS["CHECKER_NOTE"]
                                     + (f": {_clip(ck.get('note'), 160)}" if ck.get("note") else "")))
        if card is not None and page is None and written_any and split and written:
            sc["problems"].append(_p("NOT_ON_PAGE", "minor"))
        if page is not None and card is None and cards:
            sc["problems"].append(_p("NOT_PLANNED", "info"))
        if page is not None and len(written) > 1 and (page.get("words") or 0) < SHORT_SCENE:
            sc["problems"].append(_p("SHORT_SCENE", "info"))
        rows.append(sc)
    if not rows:  # neither planned nor written: one row so the chapter is on the grid
        rows.append({"n": 1, "planned": False, "written": False, "pov": pov, "place": place, "time": "",
                     "characters": [], "goals": [], "obstacle": "", "change": "", "words": None, "grade": None,
                     "ease": None, "avg_sentence": None, "dialogue_share": None, "pace": None, "problems": []})
    return rows, probs


def build(app, principal: str, pid: str, branch: str = "main") -> dict:
    """The scene grid of one book (see the module docstring). Never raises for odd stored data."""
    from .book_path import BookPath, get_profile  # noqa: PLC0415
    store = app.store
    prof = get_profile(store, pid)
    proj = store.project(pid)
    bp = BookPath(app.engine, principal, pid, branch)
    outline = bp.outline()
    aud = readability.audience_of(prof.get("audience"), prof.get("genre"))
    out = {"project_id": pid, "branch_id": branch, "title": prof.get("title") or (proj["name"] if proj else pid),
           "audience": {k: aud[k] for k in ("key", "label", "grade")}, "outline": bool(outline), "chapters": [],
           "problem_words": PROBLEM_WORDS, "scenes_on": bool(pipeline_mod.of_store(store, pid).get("scenes", True))}
    if not outline:
        out["totals"] = {"chapters": 0, "scenes": 0, "words": 0, "problems": 0, "planned_scenes": 0,
                         "written_chapters": 0}
        out["povs"], out["places"] = [], []
        return out
    chapters = bp.outline_chapters(outline)
    people = _names(store, pid, branch, "A01")
    places = _names(store, pid, branch, "A04")
    known = [c["name"] for c in chars_mod.canon_characters(store, pid, branch)]
    review = getattr(app, "review", None)
    try:
        crafts = review.editor.crafts(pid, branch) if review is not None else {}
    except Exception:  # noqa: BLE001
        crafts = {}
    try:
        planned = review.planned.stored(pid, branch) if review is not None else {}
    except Exception:  # noqa: BLE001
        planned = {}
    plan_len = lengths_mod.of_book(store, pid, len(chapters) or None)
    texts = []
    for idx, ch in enumerate(chapters):
        cid = ch["chapter_id"]
        try:
            facts = scenes_mod.chapter_plan(bp, outline, cid)
        except Exception:  # noqa: BLE001
            facts = {"pov_id": None, "location_id": None}
        pov = people.get(facts.get("pov_id")) or (facts.get("pov_id") or "")
        place = places.get(facts.get("location_id")) or (facts.get("location_id") or "")
        _ctx, latest, appr = bp.chapter_prose(outline, cid)
        rec = appr or latest
        text = str(((rec or {}).get("data") or {}).get("text") or "")
        texts.append((cid, text))
        row = {"chapter_id": cid, "number": idx + 1, "title": _title(text), "objective": _clip(ch.get("objective")),
               "pov": pov, "place": place, "state": "approved" if appr else ("draft" if rec else "unwritten"),
               "record_id": (rec or {}).get("record_id"), "version": (rec or {}).get("version"),
               "target_words": plan_len["target_words"], "min_words": plan_len["min_words"], "problems": []}
        whole = readability.chapter(_body(text)) if text else readability.chapter("")
        row.update({k: whole.get(k) for k in ("words", "grade", "ease", "avg_sentence", "dialogue_share", "pace")})
        entry = scenes_mod.get_entry(store, pid, branch, outline["record_id"], cid)
        cards = list((entry or {}).get("cards") or [])
        usable = scenes_mod.usable(entry, outline)
        rv = (entry or {}).get("review") or {}
        rv = rv if rv.get("version") == (entry or {}).get("version") else {}
        written = _scene_numbers(text) if text else []
        row["cards"] = {"version": (entry or {}).get("version"), "status": (entry or {}).get("status"),
                        "usable": usable, "verdict": rv.get("verdict"), "planned": len(cards),
                        "written": len(written)}
        if not rec:
            row["problems"].append(_p("NOT_WRITTEN", "info"))
        elif not appr:
            row["problems"].append(_p("DRAFT", "info"))
        if rec and row["words"] < row["min_words"]:
            row["problems"].append(_p("UNDER_TARGET", "major", f"{PROBLEM_WORDS['UNDER_TARGET']} ({row['words']:,} of "
                                                                f"about {row['target_words']:,} words)"))
        if not cards and out["scenes_on"]:
            row["problems"].append(_p("NO_PLAN", "info"))
        elif cards and not usable:
            row["problems"].append(_p("PLAN_OUT_OF_DATE", "minor"))
        if rec:
            cr = crafts.get(f"{rec['record_id']}:{rec['version']}") or {}
            if cr and cr.get("verdict") not in (None, "PASS"):
                row["problems"].append(_p("EDITOR_NOTES", "minor"))
            pl = planned.get(f"{rec['record_id']}:{rec['version']}") or {}
            miss = [i for i in pl.get("items") or [] if isinstance(i, dict) and i.get("required")
                    and i.get("status") != "on_page"]
            if miss:
                row["problems"].append(_p("PLANNED_MISSING", "minor", f"{PROBLEM_WORDS['PLANNED_MISSING']} "
                                                                      f"({len(miss)})"))
        lint = scenes_mod.lint(cards, known) if cards else []
        checker = {s.get("scene"): s for s in rv.get("scenes") or [] if isinstance(s, dict)}
        scenes, more = scene_rows(cards, written, written_any=bool(rec), lint=lint, checker=checker, pov=pov,
                                  place=place)
        row["problems"] += more
        row["scenes"] = scenes
        out["chapters"].append(row)
    try:  # readability findings that name chapters (P24): the chapters that read differently from the rest
        rep = readability.book([(c, _body(t)) for c, t in texts if t], audience=prof.get("audience"),
                               genre=prof.get("genre"))
        written_rows = [r for r in out["chapters"] if r["state"] != "unwritten"]
        for f in rep.get("findings") or []:
            if f.get("id") not in ("chapter_level_jump", "chapter_no_dialogue"):
                continue
            for num in f.get("chapters") or []:
                if 1 <= num <= len(written_rows):
                    written_rows[num - 1]["problems"].append(_p("READABILITY", "info", f.get("label")))
        out["readability"] = {"grade": (rep.get("totals") or {}).get("grade"),
                              "pace": (rep.get("totals") or {}).get("pace")}
    except Exception:  # noqa: BLE001 - numbers only, never break the page
        log.exception("readability findings for the scene grid failed")
    n_scenes = sum(len(r["scenes"]) for r in out["chapters"])
    n_probs = sum(len(r["problems"]) + sum(len(s["problems"]) for s in r["scenes"]) for r in out["chapters"])
    out["totals"] = {"chapters": len(out["chapters"]), "scenes": n_scenes,
                     "planned_scenes": sum(r["cards"]["planned"] for r in out["chapters"]),
                     "written_chapters": sum(1 for r in out["chapters"] if r["state"] != "unwritten"),
                     "words": sum(r.get("words") or 0 for r in out["chapters"]), "problems": n_probs}
    out["povs"] = sorted({r["pov"] for r in out["chapters"] if r["pov"]})
    out["places"] = sorted({s["place"] for r in out["chapters"] for s in r["scenes"] if s["place"]})
    return out


def render_csv(g: dict) -> str:
    """The grid as a spreadsheet (one row per scene; numbers and the author's own plan only)."""
    import csv  # noqa: PLC0415
    import io  # noqa: PLC0415
    buf = io.StringIO()
    raw = csv.writer(buf)

    def cell(v):  # a cell a spreadsheet would run as a formula is kept as text
        v = "" if v is None else v
        return "'" + v if isinstance(v, str) and v[:1] in ("=", "+", "-", "@") else v

    class _W:
        @staticmethod
        def writerow(row):
            raw.writerow([cell(x) for x in row])
    w = _W()
    w.writerow(["chapter", "scene", "pov", "place", "time", "goals", "obstacle", "change", "words", "grade",
                "dialogue %", "pace", "problems"])
    for r in g.get("chapters") or []:
        for s in r["scenes"]:
            probs = [p["label"] for p in r["problems"]] if s["n"] == 1 else []
            probs += [p["label"] for p in s["problems"]]
            w.writerow([r["number"], s["n"], s["pov"], s["place"], s["time"],
                        "; ".join(f"{g_['character']}: {g_['goal']}" for g_ in s["goals"]), s["obstacle"], s["change"],
                        s["words"] if s["words"] is not None else "", s["grade"] if s["grade"] is not None else "",
                        round(100 * s["dialogue_share"]) if s["dialogue_share"] is not None else "", s["pace"] or "",
                        " | ".join(probs)])
    return buf.getvalue()
