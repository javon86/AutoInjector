"""🎯 Rewrite the weakest scenes: how the final 🔁 improve pass works by default (run setting ``improve_mode``
"scenes"; the older whole-chapter way stays behind ``improve_mode`` "chapters").

Whole-chapter rewrites moved the author's last book only 7.8 → 7.9 for about 20 AI answers. What lifts a score is
fixing the exact scenes the reviewers quote. So, per round (``improve_rounds``: default 1, at most 2):

1. **Every complaint gets a place** (no AI, ``complaints``): the whole-book reviewers' weaknesses (their quoted
   passages), the editor's major notes and the notes kept by ✔ Approve anyway, the beta readers' top fixes and
   Akọwe's own checks (clock / tide contradictions, phrases repeated across chapters) — each is found word for word
   (or as the reviewers' quotes are checked) in one scene of one chapter. Scenes are the parts between scene-break
   lines (``***``), as on the 🗂 scene grid; a long chapter written without breaks is cut at paragraph ends into
   as many parts as it has scene cards (or about ``SPLIT_WORDS`` words each). A note that quotes nothing but names
   a chapter counts, at half weight, for that chapter's first scene; plain-word tics and a too-simple reading level
   go along as notes for a chosen scene of that chapter but never choose one.
2. **Rank the scenes** (``rank``): each complaint counts by where it comes from (improve_pass.WEIGHT, the reviewers'
   quotes like the editor's major notes) times how weak its part of the book is — the book's lowest dimensions
   weigh most (a dimension at 5/10 counts 2.5×, at 8 or more 1×). Never a scene of a chapter the author wrote.
3. **Rewrite only the top ``MAX_SCENES`` scenes** — one AI answer each, by the chapter's writer, with: the scene, its
   complaints, its plan beat (the scene card: goals, obstacle, what changes, what stays unsaid), the paragraphs just
   before and after it (continuity), the voice cards and the author's style card when there is one, the protected
   facts, the lines the editor said to keep, and a word budget (never more than ``GROWTH`` longer).
4. **Checks before anything is judged** (no AI, ``check_scene``): the budget, not cut to less than ``SHRINK`` of the
   scene, every name and every kept line of the scene still there, no new chapter title or scene break. A scene that
   fails keeps its text.
5. The improve pass then does what it always did (improve_pass.py): the SAME reviewers re-read the book with the
   rewritten scenes; kept only if the overall score went up and no dimension dropped by more than 1; kept chapters
   go through the usual review and approval (``save`` makes the new draft); the report says
   "🎯 Rewrote 3 weakest scenes (ch1 opening, ch2 photograph investigation, ch3 final miscalculation): 7.9 → 8.4
   (kept)".

Never touches the author's own text, approved canon, locked details, the ending's outcome or names (the rules the
writer gets, the checks above, and the chapter review against approved canon). AI calls go through the usual request
plumbing (assist._call_ai: usage limits, failover) and are counted in the run forecast (run_forecast.py ``improve``).
Logs: codes and numbers only.
"""
from __future__ import annotations

import copy
import logging
import math
import re
from datetime import datetime, timezone

log = logging.getLogger("akowe.weak_scenes")

TEXT_KEY = "weak_scenes:{pid}:{branch}"   # the rewritten chapters waiting for their review (survives a resume)
MAX_SCENES = 3
MAX_COMPLAINTS = 8
GROWTH = 0.10          # a rewritten scene may be at most 10 % longer
SHRINK = 0.6           # … and never shorter than 60 % (a cut-off answer is not a rewrite)
SPLIT_WORDS = 900      # a chapter without scene breaks is cut into parts of about this many words
NEIGHBOUR_CHARS = 700  # the paragraphs just before / after a scene the writer sees
MIN_SCENE_WORDS = 20
ROUNDS_DEFAULT, ROUNDS_MAX = 1, 2
UNQUOTED_SHARE = 0.5   # a note that names a chapter but quotes nothing counts half, for its first scene
WEIGHT = {"review": 3}  # the reviewers' quoted weaknesses (the rest: improve_pass.WEIGHT)
NOTE_ONLY = ("tic", "reading", "reviewers")   # chapter-wide advice: goes along, never chooses a scene

# where a note's own dimension lands among the whole-book reviewers' dimensions (book_report.DIMENSIONS)
DIM_MAP = {"timeline": "plot_continuity", "cause_effect": "plot_continuity", "continuity": "plot_continuity",
           "prose_variety": "prose_clarity", "clarity": "prose_clarity", "voice_distinction":
           "character_differentiation", "story_rules": "rule_rigor", "protected_mysteries": "rule_rigor",
           "stakes": "peril_uncertainty", "tension": "peril_uncertainty", "beta_bored": "peril_uncertainty",
           "beta_stop": "peril_uncertainty", "beta_guessed": "structure", "beta_lost": "prose_clarity",
           "texture": "world_distinctiveness", "ending_promises": "ending"}
# a reviewer's weakness has no dimension: guess it from its words (first match wins)
DIM_WORDS = [
    ("peril_uncertainty", ("cooperat", "convenient", "too easy", "easily", "stakes", "peril", "tension", "risk",
                           "hand her", "hand him", "handed")),
    ("subtext", ("subtext", "on the nose", "tells the reader", "announc", "explain", "spelled out", "states")),
    ("rule_rigor", ("rule", "magic", "ghost", "curse", "limit", "cost")),
    ("ending", ("ending", "final", "climax", "resolution")),
    ("plot_continuity", ("contradict", "continuity", "gap", "dropped", "timeline", "tide", "clock")),
    ("character_differentiation", ("voice", "sound alike", "same register", "interchangeable")),
    ("psychological_complexity", ("motive", "inner", "psycholog", "flat character", "self-")),
    ("prose_clarity", ("prose", "sentence", "clunky", "confus", "unclear", "repeat", "simile", "cliché", "cliche")),
    ("world_distinctiveness", ("world", "generic", "setting", "institution")),
    ("realism", ("realis", "procedure", "tool", "implausib")),
    ("atmosphere", ("atmosphere", "mood", "sense of place")),
    ("structure", ("structure", "pacing", "shape", "slow", "rushed")),
]

SCENE_TASK = (
    "You are the writer of this book. Rewrite ONE scene (context.scene.text) so it answers the complaints about it "
    "(context.complaints: what the reviewers, the editor, the beta readers and Akọwe's checks said, with the exact "
    "words they quoted). Keep the scene's job in the story (context.plan_beat: who wants what, what gets in the way, "
    "what changes, what stays unsaid) and make it flow from context.before and into context.after, which you must "
    "not repeat or change. Write in the book's voice: the narrator's style (context.narrator_style, when given) and "
    "each character's voice card (context.voices). Follow context.rules strictly: never change what happens, the "
    "ending's outcome, who lives or dies, any name, the main character, a protected fact, a 🔒 locked detail or a "
    "story rule; keep every line in context.keep word for word. Stay within context.scene.max_words words. Return "
    "the whole new scene as plain prose in rewritten_scene (no title, no scene-break line, no notes), and in "
    "what_changed say in a few words per complaint what you did.")
SCENE_RULES = ["Keep what happens, the ending's outcome, who lives or dies, every name and the main character.",
               "Keep every protected fact, locked detail, approved fact and story rule.",
               "Keep every line in keep word for word.",
               "Answer each complaint inside this scene; do not add a new plot event or a new character.",
               "Never reuse a simile or phrase from another chapter; vary plain words.",
               "Stay within the word budget: tighter is better than longer."]
SCENE_SCHEMA = {"type": "object", "additionalProperties": False,
                "properties": {"rewritten_scene": {"type": "string", "maxLength": 40000},
                               "what_changed": {"type": "array", "maxItems": 10,
                                                "items": {"type": "string", "maxLength": 300}}},
                "required": ["rewritten_scene"]}
REJECT_WORDS = {"EMPTY": "the answer had no scene", "TOO_LONG": "longer than the word budget",
                "TOO_SHORT": "much shorter than the scene (cut off?)", "NAME_LOST": "a name of the scene was lost",
                "KEEP_LOST": "a line the editor said to keep was lost", "NO_CHANGE": "nothing changed",
                "FORM": "it added a chapter title or a scene break", "FAILED": "the AI could not answer"}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n]


def _words(s: str) -> int:
    return len(re.findall(r"\b[\w'’-]+\b", s or ""))


def enabled(settings: dict | None) -> bool:
    """Is the improve pass working on the weakest scenes? (a run saved before this setting: the whole-chapter way)"""
    return (settings or {}).get("improve_mode") == "scenes"


def rounds_of(settings: dict | None) -> int:
    n = (settings or {}).get("improve_rounds", ROUNDS_DEFAULT)
    if isinstance(n, int) and not isinstance(n, bool) and n >= 1:
        return min(n, ROUNDS_MAX)
    return ROUNDS_DEFAULT


# ====================================================================== scenes on the page (no AI)
def _body_start(text: str) -> int:
    m = re.match(r"\s*#[^\n]*\n", text or "")
    return m.end() if m else 0


def _trim(text: str, a: int, b: int) -> tuple[int, int]:
    while a < b and text[a].isspace():
        a += 1
    while b > a and text[b - 1].isspace():
        b -= 1
    return a, b


def scene_spans(text: str, planned: int = 0) -> list[tuple[int, int]]:
    """[(start, end)] of each scene in the chapter text (the title line and the scene-break lines left out), so a
    scene is always ``text[start:end]`` exactly. A chapter written without breaks is cut at paragraph ends into
    ``planned`` parts (its scene cards), or parts of about SPLIT_WORDS words when it is long."""
    from .readability import _SCENE_BREAK  # noqa: PLC0415 - one definition of a scene break for the whole app
    t = text or ""
    pos = _body_start(t)
    spans = []
    for m in _SCENE_BREAK.finditer(t, pos):
        spans.append(_trim(t, pos, m.start()))
        pos = m.end()
    spans.append(_trim(t, pos, len(t)))
    spans = [s for s in spans if _words(t[s[0]:s[1]])]
    if len(spans) != 1:
        return spans
    a, b = spans[0]
    total = _words(t[a:b])
    k = max(planned if planned >= 2 else 1, math.ceil(total / SPLIT_WORDS) if total > SPLIT_WORDS * 1.5 else 1)
    if k <= 1:
        return spans
    paras = [_trim(t, a + m.start(), a + m.end()) for m in re.finditer(r"(?:(?!\n\s*\n).)+", t[a:b], re.S)]
    paras = [p for p in paras if p[1] > p[0]]
    if len(paras) < k:
        return spans
    cum, acc = [], 0
    for p in paras:
        acc += _words(t[p[0]:p[1]])
        cum.append(acc)
    per, cuts, last = total / k, [], -1
    for j in range(1, k):  # cut after the paragraph where the j-th part's words are reached (≥ 1 paragraph a part)
        idx = next((i for i in range(last + 1, len(paras)) if cum[i] >= j * per), len(paras) - 1)
        idx = max(last + 1, min(idx, len(paras) - 1 - (k - j)))
        cuts.append(idx)
        last = idx
    out, first = [], 0
    for c in cuts + [len(paras) - 1]:
        out.append((paras[first][0], paras[c][1]))
        first = c + 1
    return out


def chapter_scenes(ch: dict, cards: list | None = None) -> list[dict]:
    """The scenes of one chapter: [{n, start, end, text, words, card}] (card n of the plan beside scene n)."""
    cards = cards or []
    out = []
    for i, (a, b) in enumerate(scene_spans(ch["text"], len(cards))):
        out.append({"n": i + 1, "start": a, "end": b, "text": ch["text"][a:b], "words": _words(ch["text"][a:b]),
                    "card": cards[i] if i < len(cards) and isinstance(cards[i], dict) else None})
    return out


def _cards(app, principal, pid, branch) -> dict:
    """chapter id -> its scene cards (when they belong to the current outline)."""
    from . import scenes as scenes_mod  # noqa: PLC0415
    from .book_path import BookPath  # noqa: PLC0415
    try:
        bp = BookPath(app.engine, principal, pid, branch)
        outline = bp.outline()
        if not outline:
            return {}
        out = {}
        for ch in bp.outline_chapters(outline):
            e = scenes_mod.get_entry(app.store, pid, branch, outline["record_id"], ch["chapter_id"])
            if scenes_mod.usable(e, outline):
                out[ch["chapter_id"]] = list(e.get("cards") or [])
        return out
    except Exception:  # noqa: BLE001 - the plan beat is a help, never a reason to stop
        log.warning("weak scenes: the scene cards could not be read")
        return {}


# ====================================================================== complaints -> scenes (no AI)
def dimension_of(c: dict) -> str | None:
    from .book_report import DIM_KEYS  # noqa: PLC0415
    d = str(c.get("dimension") or "")
    if d in DIM_KEYS:
        return d
    if d in DIM_MAP:
        return DIM_MAP[d]
    words = f" {c.get('why') or ''} {c.get('suggestion') or ''} ".lower()
    for key, keys in DIM_WORDS:
        if any(k in words for k in keys):
            return key
    return None


def dim_factor(median) -> float:
    """How much a complaint about a dimension at this score counts: 5/10 → 2.5×, 8/10 or more → 1×."""
    if not isinstance(median, (int, float)):
        return 1.0
    return 1.0 + max(0.0, 8.0 - float(median)) * 0.5


def _find(scenes: list[dict], passage: str) -> dict | None:
    from . import calibration  # noqa: PLC0415
    from .book_report import verify_quote  # noqa: PLC0415
    p = str(passage or "").strip()
    if not p:
        return None
    for s in scenes:
        if p in s["text"]:
            return s
    for s in scenes:
        if verify_quote(p, calibration.norm(s["text"])):
            return s
    return None


def complaints(store, pid, branch, chapters: list[dict], rep: dict | None, beta: dict | None,
               crafts: dict | None, skip: set, cards: dict | None = None) -> dict:
    """Every complaint placed in its scene: {(chapter number, scene n): {chapter, scene, items: [...]}} plus
    ``notes`` (chapter number -> chapter-wide notes) and ``lost`` (how many quoted complaints were not found)."""
    from . import improve_pass  # noqa: PLC0415
    by_num = {c["number"]: c for c in chapters}
    scenes = {c["number"]: chapter_scenes(c, (cards or {}).get(c["chapter_id"])) for c in chapters}
    out: dict = {"scenes": {}, "notes": {}, "lost": 0}

    def put(num, sc, src, f, share=1.0, who=""):
        key = (num, sc["n"])
        row = out["scenes"].setdefault(key, {"chapter": by_num[num], "scene": sc, "items": []})
        why = _clip(f.get("why"), 500)
        passage = str(f.get("passage") or "")
        if any(x["why"] == why and x["passage"] == passage and x["who"] == who for x in row["items"]):
            return  # the same note twice; two reviewers quoting the same scene both count
        row["items"].append({"source": src, "dimension": dimension_of(f), "why": why, "passage": passage
                             if passage in sc["text"] else "", "suggestion": _clip(f.get("suggestion"), 300),
                             "share": share, "who": who})

    # 1. the whole-book reviewers' weaknesses: only their quotes that are really in the book
    for ri, r in enumerate((rep or {}).get("reviews") or []):
        if r.get("status") != "done":
            continue
        for w in r.get("weaknesses") or []:
            q = str(w.get("quote") or "")
            if not q or w.get("verified") is False:
                continue
            for num, scs in scenes.items():
                if num in skip:
                    continue
                sc = _find(scs, q)
                if sc:
                    put(num, sc, "review", {"why": w.get("point"), "passage": q, "suggestion": ""},
                        who=str(r.get("slot") or ri))
                    break
            else:
                out["lost"] += 1
    # 2. the editor's major notes, ✔ Approve-anyway notes, clock / tide, repeats, tics, reading level, beta fixes
    rows = improve_pass.targets(store, pid, branch, chapters, rep, beta, crafts, skip, max_chapters=None,
                                max_findings=None)
    for row in rows:
        num = row["number"]
        scs = scenes.get(num) or []
        for f in row["findings"]:
            if f["source"] in NOTE_ONLY or not scs:
                if f["source"] != "reviewers":
                    out["notes"].setdefault(num, []).append(_clip(f.get("why"), 300))
                continue
            sc = _find(scs, f.get("passage"))
            if sc:
                put(num, sc, f["source"], f)
            else:
                put(num, scs[0], f["source"], dict(f, passage=""), UNQUOTED_SHARE)
    return out


def rank(placed: dict, rep: dict | None, limit: int = MAX_SCENES) -> list[dict]:
    """The weakest scenes first: [{chapter, scene, items, score, label}] (≤ limit). A complaint counts its source's
    weight times dim_factor of its dimension's median score; ties: more complaints, then story order."""
    from . import improve_pass  # noqa: PLC0415
    med = {d["dimension"]: d.get("median") for d in ((rep or {}).get("aggregate") or {}).get("dimensions") or []
           if d.get("n")}
    rows = []
    for (_num, _n), row in placed.get("scenes", {}).items():
        if row["scene"]["words"] < MIN_SCENE_WORDS:
            continue
        score = 0.0
        for it in row["items"]:
            w = WEIGHT.get(it["source"], improve_pass.WEIGHT.get(it["source"], 1))
            it["weight"] = round(w * it["share"] * dim_factor(med.get(it["dimension"])), 2)
            score += it["weight"]
        row["items"].sort(key=lambda x: (-x["weight"], not x["passage"]))
        rows.append(dict(row, score=round(score, 2)))
    rows.sort(key=lambda r: (-r["score"], -len(r["items"]), r["chapter"]["number"], r["scene"]["n"]))
    return rows[:limit]


def label_of(ch: dict, sc: dict, last_chapter: int, scenes_in_chapter: int) -> str:
    """A short name for the report: "ch1 opening", "ch3 ending", or a few words of the scene's plan beat."""
    if ch["number"] == 1 and sc["n"] == 1:
        name = "opening"
    elif ch["number"] == last_chapter and sc["n"] == scenes_in_chapter:
        name = "ending"
    else:
        card = sc.get("card") or {}
        src = str(card.get("beat") or card.get("change") or "")
        ws = re.findall(r"[\w'’-]+", src)[:4]
        name = " ".join(ws).lower() if ws else f"scene {sc['n']}"
    return f"ch{ch['number']} {name}"


# ====================================================================== the writer's brief for one scene (no AI)
def _tail(text: str, n: int) -> str:
    t = text.rstrip()
    if len(t) <= n:
        return t.strip()
    cut = t[-n:]
    i = cut.find("\n\n")
    return (cut[i:] if 0 <= i < n // 2 else cut).strip()


def _head(text: str, n: int) -> str:
    t = text.lstrip()
    if len(t) <= n:
        return t.strip()
    cut = t[:n]
    i = cut.rfind("\n\n")
    return (cut[:i] if i > n // 2 else cut).strip()


def names_in(text: str, names) -> list[str]:
    """The book's names on this stretch of page, whole or by a part ("Mara" of "Mara Vell"), whole words only."""
    out = []
    for n in names or []:
        for part in [str(n)] + str(n).split():
            part = part.strip(".,;:'’\"“”()")
            if len(part) >= 3 and part[:1].isupper() and part not in out and \
                    re.search(rf"(?<![\w-]){re.escape(part)}(?![\w-])", text or ""):
                out.append(part)
    return out


def budget(words: int) -> int:
    return max(1, math.floor(words * (1 + GROWTH)))


def brief(pick: dict, *, rep: dict | None, notes: list | None = None, keep: list | None = None,
          names: list | None = None, voices: list | None = None, style: dict | None = None,
          profile: dict | None = None, protected: list | None = None) -> dict:
    """The context of one scene rewrite (see the module docstring)."""
    from .book_report import LABELS, TRY  # noqa: PLC0415
    ch, sc = pick["chapter"], pick["scene"]
    card = sc.get("card") or {}
    weak = sorted([d for d in ((rep or {}).get("aggregate") or {}).get("dimensions") or [] if d.get("n")],
                  key=lambda d: d["median"])[:3]
    dims = {it["dimension"] for it in pick["items"] if it.get("dimension")}
    ctx = {"akowe_task": "weak_scene",
           "scene": {"chapter": ch["number"], "scene": sc["n"], "label": pick.get("label"), "text": sc["text"],
                     "words": sc["words"], "max_words": budget(sc["words"])},
           "complaints": [{k: it[k] for k in ("source", "why", "passage", "suggestion")} | {"dimension": LABELS.get(
               it["dimension"], it["dimension"] or "")} for it in pick["items"][:MAX_COMPLAINTS]],
           "chapter_objective": _clip(ch.get("objective"), 300),
           "plan_beat": {k: card[k] for k in ("beat", "goals", "obstacle", "change", "unsaid", "place", "time",
                                              "characters") if card.get(k)},
           "before": _tail(ch["text"][_body_start(ch["text"]):sc["start"]], NEIGHBOUR_CHARS),
           "after": _head(ch["text"][sc["end"]:], NEIGHBOUR_CHARS),
           "weak_dimensions": [{"dimension": d["label"], "score": d["median"], "advice": TRY.get(d["dimension"], "")}
                               for d in weak if d["dimension"] in dims or len(dims) == 0][:3],
           "keep": [k for k in keep or [] if k in sc["text"]],
           "names": names_in(sc["text"], names)[:30],
           "rules": SCENE_RULES}
    if notes:
        ctx["chapter_notes"] = notes[:4]
    if voices:
        ctx["voices"] = voices
    if style:
        ctx["narrator_style"] = style
    if profile:
        ctx["book_profile"] = profile
    if protected:
        ctx["protected_facts"] = protected[:40]
    return ctx


def check_scene(old: str, new, keep=(), names=()) -> tuple[str | None, str]:
    """(reason it is refused or None, the cleaned new scene). See the module docstring, step 4."""
    from .readability import _SCENE_BREAK  # noqa: PLC0415
    if not isinstance(new, str) or not _words(new):
        return "EMPTY", ""
    new = new.strip()
    if new.startswith("#") or _SCENE_BREAK.search(new):
        return "FORM", new
    w0, w1 = _words(old), _words(new)
    if w1 > budget(w0):
        return "TOO_LONG", new
    if w1 < w0 * SHRINK:
        return "TOO_SHORT", new
    if " ".join(new.split()) == " ".join(old.split()):
        return "NO_CHANGE", new
    if any(k and k in old and k not in new for k in keep):
        return "KEEP_LOST", new
    for n in names:
        if n and re.search(rf"\b{re.escape(n)}\b", old) and not re.search(rf"\b{re.escape(n)}\b", new):
            return "NAME_LOST", new
    return None, new


def splice(text: str, changes: list[tuple[int, int, str]]) -> str:
    for a, b, new in sorted(changes, key=lambda x: -x[0]):
        text = text[:a] + new + text[b:]
    return text


# ====================================================================== the round (AI: one answer per scene)
def pick(runner, run, chapters, rep, beta, crafts, skip) -> dict:
    """{picks: the weakest scenes (≤ MAX_SCENES, labelled), notes, lost} — no AI."""
    app = runner.app
    pid, branch = run["project_id"], run["branch_id"]
    cards = _cards(app, run["principal"], pid, branch)
    placed = complaints(app.store, pid, branch, chapters, rep, beta, crafts, skip, cards)
    picks = rank(placed, rep)
    last = max((c["number"] for c in chapters), default=0)
    for p in picks:
        n_sc = len(chapter_scenes(p["chapter"], cards.get(p["chapter"]["chapter_id"])))
        p["label"] = label_of(p["chapter"], p["scene"], last, n_sc)
    return {"picks": picks, "notes": placed["notes"], "lost": placed["lost"], "rep": rep}


def propose(runner, run, chosen: dict, total: int) -> tuple[list[dict], list[dict]]:
    """One rewrite per picked scene by the chapter's writer (nothing saved). Returns (candidates per chapter
    [{chapter_id, number, record_id, version, text, applied, scenes: [labels]}], refused [{label, code}])."""
    from . import ai_activity  # noqa: PLC0415
    from .assist import book_profile_brief, canon_context  # noqa: PLC0415
    from .editor import _rkey, keep_quotes_of  # noqa: PLC0415
    from .errors import AkoweError  # noqa: PLC0415
    from .fact_checks import protected_keep  # noqa: PLC0415
    app = runner.app
    pid, branch = run["project_id"], run["branch_id"]
    ed = runner._review.editor  # noqa: SLF001
    rv = runner._review  # noqa: SLF001
    try:
        names = ed.names(pid, branch)
    except Exception:  # noqa: BLE001
        names = []
    try:
        voices = ed._voices(pid, branch)  # noqa: SLF001
    except Exception:  # noqa: BLE001
        voices = []
    try:
        from .style_card import brief_for  # noqa: PLC0415
        style = brief_for(app.store, pid)
    except Exception:  # noqa: BLE001
        style = None
    try:
        _a, _d, protected = canon_context(app.engine, pid, branch, max_approved=40, max_drafts=0)
    except Exception:  # noqa: BLE001
        protected = []
    profile = book_profile_brief(app.store, pid)
    crafts = ed.crafts(pid, branch) or {}
    rep = chosen.get("rep")
    changes: dict[str, dict] = {}
    refused = []
    for p in chosen["picks"]:
        runner.check(run)
        ch, sc = p["chapter"], p["scene"]
        keep = keep_quotes_of(crafts.get(_rkey(ch["record_id"], ch["version"])) or {}, ch["text"])
        try:  # voice and motif repeats are never cut (as in the editor's rewrites)
            keep = list(dict.fromkeys(keep + protected_keep(app.engine, run["principal"], pid, branch, sc["text"])))
        except Exception:  # noqa: BLE001
            pass
        ctx = brief(p, rep=rep, notes=chosen.get("notes", {}).get(ch["number"]), keep=keep, names=names,
                    voices=voices, style=style, profile=profile, protected=protected)
        job = runner._sub_job(run, "improve", ch["record_id"], run["settings"].get("slot_id"))  # noqa: SLF001
        if not job.slot_pref:
            try:
                rec = rv._head(pid, branch, ch["record_id"])  # noqa: SLF001
                writer = rv.writer_of(pid, branch, rec) if rec else {}
                job.prefer_slots = [writer["slot"]] if writer.get("slot") else []
            except Exception:  # noqa: BLE001
                pass
        try:
            with ai_activity.doing(f"Improve pass: rewriting a weak scene of chapter {ch['number']}",
                                   done=f"Improve pass: rewrote a weak scene of chapter {ch['number']}",
                                   chapter=ch["number"], chapters=total):
                raw = ed.assist._call_ai(job, op_for_roles="C02", task=SCENE_TASK, schema=SCENE_SCHEMA,
                                         context=ctx, protected=protected)
        except AkoweError as exc:
            if getattr(exc, "control", False):
                raise
            refused.append({"label": p["label"], "code": "FAILED"})
            log.info("weak scenes: a rewrite failed (%s)", exc.code)
            continue
        runner.check(run)
        new = raw.get("rewritten_scene") if isinstance(raw, dict) else None
        why, new = check_scene(sc["text"], new, keep, ctx["names"])
        if why:
            refused.append({"label": p["label"], "code": why})
            continue
        row = changes.setdefault(ch["chapter_id"], {"chapter": ch, "edits": [], "labels": []})
        row["edits"].append((sc["start"], sc["end"], new))
        row["labels"].append(p["label"])
    out = []
    for cid, row in changes.items():
        ch = row["chapter"]
        out.append({"chapter_id": cid, "number": ch["number"], "record_id": ch["record_id"],
                    "version": ch["version"], "text": splice(ch["text"], row["edits"]), "applied": len(row["edits"]),
                    "scenes": row["labels"]})
    out.sort(key=lambda c: c["number"])
    return out, refused


def remember(store, pid, branch, cands: list[dict]) -> None:
    """Keep the rewritten chapters until their review (a resume finds them)."""
    store.set_setting(TEXT_KEY.format(pid=pid, branch=branch),
                      {c["chapter_id"]: {"record_id": c["record_id"], "version": c["version"], "text": c["text"],
                                         "at": _now()} for c in cands})


def save(runner, run, c: dict) -> dict:
    """The kept rewrite of one chapter becomes its new DRAFT (the normal UPDATE path, as the editor's fixes do); the
    usual review and approval follow in improve_pass._approve_kept."""
    from .book_path import BookPath, problems  # noqa: PLC0415
    from .editor import _rkey  # noqa: PLC0415
    from .errors import AkoweError  # noqa: PLC0415
    app = runner.app
    pid, branch = run["project_id"], run["branch_id"]
    rv = runner._review  # noqa: SLF001
    kept = (app.store.get_setting(TEXT_KEY.format(pid=pid, branch=branch)) or {}).get(c["chapter_id"]) or {}
    rec = rv._head(pid, branch, c["record_id"])  # noqa: SLF001
    if not kept.get("text") or rec is None or kept.get("version") != c["version"] or rec["version"] != c["version"]:
        raise AkoweError("VERSION_CONFLICT", "/version", "the chapter changed since its scenes were rewritten",
                         status="REJECTED")
    payload = copy.deepcopy(rec.get("data") or {})
    payload["text"] = kept["text"]
    resp = BookPath(app.engine, run["principal"], pid, branch).dispatch(rec["module_id"], "UPDATE",
                                                                        base_ref=rec["ref"], payload=payload)
    if resp["status"] != "DRAFT" or not resp.get("output_refs"):
        raise AkoweError("INVALID_INPUT", "/payload", "the rewritten chapter did not pass Akọwe's checks: "
                         + "; ".join(problems(resp))[:300], status="REJECTED")
    new = resp["output_refs"][0]
    try:
        writer = rv.writer_of(pid, branch, rec)
    except Exception:  # noqa: BLE001
        writer = {}
    rv._put(f"ai_fixes:{pid}:{branch}", _rkey(c["record_id"], new["version"]),  # noqa: SLF001
            {"slot": writer.get("slot"), "from_version": c["version"], "at": _now(), "editor": True,
             "weak_scenes": True})
    with app.store.transaction() as tx:
        tx.insert_outbox(pid, branch, "editor.rewrite", {
            "record_id": c["record_id"], "from_version": c["version"], "to_version": new["version"],
            "module_id": rec["module_id"], "applied": int(c.get("applied") or 0), "unresolved": 0,
            "ai_slot": writer.get("slot"), "how": "run", "round": None,
            "label": "The weakest scenes rewritten inside a Make-a-book run (checked again before approval)"})
    return new


# ====================================================================== the report line
def line(res: dict, labels: list[str], rounds: int = 1) -> str:
    """'🎯 Rewrote 3 weakest scenes (ch1 opening, …): 7.9 → 8.4 (kept)'."""
    n = len(labels)
    head = f"🎯 Rewrote {n} weakest scene{'s' if n != 1 else ''}" + (f" ({', '.join(labels)})" if labels else "")
    if res.get("before") is None:
        return "🎯 Weakest scenes: nothing was changed"
    if res.get("after") is None:
        return f"🎯 Weakest scenes: {res['before']:g}/10 — {res.get('why') or 'nothing was changed'}"
    word = "kept" if res.get("keep") else f"not kept, the original book stays: {res.get('why')}"
    return f"{head}: {res['before']:g} → {res['after']:g} ({word})" + (f" · {rounds} rounds" if rounds > 1 else "")
