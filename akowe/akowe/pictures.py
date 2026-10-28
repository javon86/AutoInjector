"""🖼 Interior pictures (plan item B3, "Lane B"): chapter and scene illustrations, a map of the book's world, and
their placement in the PDF, EPUB and DOCX exports. The full description is ``docs/PICTURES.md``.

**The model.** Companion data like the scene cards: settings key ``pictures:<project>:<branch>`` =
``{"style", "revision", "counter", "pictures": {pic_id: picture}}``. A picture is
``{"id": "pic-001", "kind": "chapter"|"map", "chapter_id", "scene", "candidates": [candidate], "chosen": index|None,
"caption", "alt", "placement": {"where": before|start|after_scene|end, "scene": n}, "prompt", "created_at",
"updated_at"}``. One picture per chapter (``scene`` None), per scene card (``scene`` n) and one map. A candidate is a
book asset (a binary I01 record, like an upload; forge._store_asset) ``{asset_id, version, mime, source: sd|chatgpt|
upload|svg, engine, seed, at, warnings}``; at most ``MAX_CANDIDATES`` are kept. Only a picture with a chosen candidate
is placed in the book.

**Prompts** (``build_prompt``): the book's art style (set once per book), the scene card (place, time, who is there and
the key moment: what changes), the present characters' approved looks (Character Forge: Fixed visual anchors and
the appearance fields that are the author's own or approved, never proposals) and the character lock of the main
character (the POV when present), at most ``PROMPT_MAX`` characters. AutoInjector ``POST /image/request`` with
``purpose: "illustration"`` (``"map"`` for the illustrated map) and ``characterLock``; the bridge, its error codes and
the "no lock with this name" fallback are forge.py's.

**Placement.** "Put the book together" (book_path.a_assemble) takes a snapshot of the chosen pictures, keyed by that
assembly's G02 record (``snapshot``), and set_g.assemble places it into the book model (``overlay`` →
exporters/book.place_pictures), so the pagination, the TOC pass and the three exports all see the same pictures. A
change on this page afterwards marks the assembly out of date (``signature``): put the book together again.

**The SVG map** (``svg_map``): d_maps.render_svg of the places (A04): their x.map.x / x.map.y coordinates when they
have them (d_maps.extract_graph), else a deterministic route layout in story order (the places in the order the
chapters visit them, joined by the route). The EPUB carries the SVG itself and the PDF draws it with vector operations
(lines, circles, text). Word cannot show an SVG and Akọwe has no image library at runtime (no Pillow), so a PNG copy
of the map for the DOCX is drawn by AutoInjector (``POST /render/image``, ``render.py``) when the map is made (or
with "Make the Word copy": ``POST …/pictures/map {kind: "png"}``) and kept on the candidate as ``png``; without it
the DOCX names where the map is. An illustrated or uploaded PNG/JPEG map is placed in all three.

Prompts and picture bytes are never logged; outbox events carry numbers and codes only.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import math
import re
import threading
from datetime import datetime, timezone

from . import characters as chars_mod
from . import d_maps
from . import forge
from . import scenes as scenes_mod
from .errors import AkoweError

log = logging.getLogger("akowe.pictures")

PROMPT_MAX = 1200
STYLE_MAX = 120
TEXT_MAX = 300
MAX_CANDIDATES = 6
MAX_COUNT = 3
WHERE = ("before", "start", "after_scene", "end")
STYLES = ("ink wash", "painterly", "watercolour", "manga", "pencil sketch", "woodcut", "children's picture book",
          "graphic novel", "oil painting")
SVG_MIME = "image/svg+xml"
_LOCK = threading.RLock()
_REJ = {"status": "REJECTED"}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(v, n: int = TEXT_MAX) -> str:
    if isinstance(v, bool) or not isinstance(v, (str, int, float)):
        return ""
    return " ".join(str(v).split())[:n].strip()


def _bad(path: str, msg: str, code: str = "INVALID_INPUT") -> AkoweError:
    return AkoweError(code, path, msg, **_REJ)


# ====================================================================== storage
def _key(pid: str, branch: str) -> str:
    return f"pictures:{pid}:{branch}"


def snap_key(pid: str, branch: str, g02_record_id: str) -> str:
    return f"pictures_snap:{pid}:{branch}:{g02_record_id}"


def _empty() -> dict:
    return {"style": "", "revision": 0, "counter": 0, "pictures": {}}


def doc(store, pid: str, branch: str) -> dict:
    cur = store.get_setting(_key(pid, branch))
    if not isinstance(cur, dict):
        return _empty()
    out = _empty()
    out.update(cur)
    return out


def _mutate(store, pid: str, branch: str, fn, event: str | None = None):
    """Read-change-write the pictures document inside one transaction; ``fn(doc)`` returns what to hand back."""
    with _LOCK:
        with store.transaction() as tx:
            row = tx.conn.execute("SELECT value FROM settings WHERE key=?", (_key(pid, branch),)).fetchone()
            cur = json.loads(row["value"]) if row else {}
            d = _empty()
            d.update(cur if isinstance(cur, dict) else {})
            out = fn(d)
            d["revision"] = int(d.get("revision") or 0) + 1
            store.set_setting(_key(pid, branch), d)
            if event:
                tx.insert_outbox(pid, branch, event, {"revision": d["revision"], "pictures": len(d["pictures"]),
                                                      "chosen": sum(1 for p in d["pictures"].values()
                                                                    if p.get("chosen") is not None)})
    return copy.deepcopy(out)


def _new_picture(d: dict, kind: str, chapter_id: str | None, scene: int | None) -> dict:
    d["counter"] = int(d.get("counter") or 0) + 1
    pid_ = f"pic-{d['counter']:03d}"
    where = {"where": "before", "scene": None} if kind == "map" else \
        {"where": "start", "scene": None} if not scene or scene == 1 else {"where": "after_scene", "scene": scene - 1}
    pic = {"id": pid_, "kind": kind, "chapter_id": chapter_id, "scene": scene, "candidates": [], "chosen": None,
           "caption": "", "alt": "", "placement": where, "prompt": "", "created_at": _now(), "updated_at": _now()}
    d["pictures"][pid_] = pic
    return pic


def _find(d: dict, kind: str, chapter_id: str | None, scene: int | None) -> dict | None:
    for p in d["pictures"].values():
        if p.get("kind") == kind and (kind == "map" or (p.get("chapter_id") == chapter_id
                                                        and (p.get("scene") or None) == (scene or None))):
            return p
    return None


def ensure_picture(store, pid, branch, kind: str, chapter_id: str | None, scene: int | None) -> str:
    """The id of the picture for this chapter / scene (or the map), made when there is none yet."""
    def fn(d):
        p = _find(d, kind, chapter_id, scene) or _new_picture(d, kind, chapter_id, scene)
        return p["id"]
    return _mutate(store, pid, branch, fn)


def add_candidate(store, pid, branch, pic_id: str, cand: dict, *, choose: bool | None = None,
                  prompt: str | None = None) -> dict:
    """Add a candidate; ``choose`` True = choose it, None = choose it when nothing is chosen yet, False = leave."""
    def fn(d):
        p = d["pictures"].get(pic_id)
        if p is None:
            raise _bad("/pic_id", "this picture was deleted", "NOT_FOUND")
        cands = list(p.get("candidates") or [])
        chosen = p.get("chosen")
        cands.append({k: v for k, v in cand.items() if v is not None})
        drop = max(0, len(cands) - MAX_CANDIDATES)
        if drop:  # the oldest unchosen ones go first
            keep_idx = [i for i in range(len(cands)) if i == chosen or i == len(cands) - 1]
            others = [i for i in range(len(cands)) if i not in keep_idx][drop:]
            idx = sorted(set(keep_idx) | set(others))
            chosen = idx.index(chosen) if chosen is not None and chosen in idx else None
            cands = [cands[i] for i in idx]
        p["candidates"] = cands
        if choose or (choose is None and chosen is None):
            chosen = len(cands) - 1
        p["chosen"] = chosen
        if prompt is not None:
            p["prompt"] = prompt[:PROMPT_MAX]
        p["updated_at"] = _now()
        return p
    return _mutate(store, pid, branch, fn, "pictures.candidate")


def has_chosen(d: dict, chapter_id: str) -> bool:
    p = _find(d, "chapter", chapter_id, None)
    return bool(p and p.get("chosen") is not None and p.get("candidates"))


# ====================================================================== the book's chapters, places and people
def _bp(app, principal, pid, branch):
    from .book_path import BookPath  # noqa: PLC0415
    return BookPath(app.engine, principal, pid, branch)


def _title_of(text: str) -> str:
    for line in str(text or "").splitlines():
        line = line.strip()
        if line:
            return line[2:].strip()[:120] if line.startswith("# ") else ""
    return ""


def _scene_count(text: str) -> int:
    return 1 + sum(1 for ln in str(text or "").splitlines() if re.match(r"^\s*(\*\s*\*\s*\*|#)\s*$", ln)) \
        if str(text or "").strip() else 0


def chapters(app, principal, pid, branch) -> list[dict]:
    """[{chapter_id, number, title, objective, scenes, cards, state, section_id}] in outline order."""
    bp = _bp(app, principal, pid, branch)
    outline = bp.outline()
    if not outline:
        return []
    out = []
    for i, ch in enumerate(bp.outline_chapters(outline)):
        cid = ch["chapter_id"]
        try:
            _ctx, latest, appr = bp.chapter_prose(outline, cid)
        except Exception:  # noqa: BLE001 - a missing chapter text is "unwritten"
            latest = appr = None
        rec = appr or latest
        text = str(((rec or {}).get("data") or {}).get("text") or "")
        entry = scenes_mod.get_entry(app.store, pid, branch, outline["record_id"], cid)
        cards = list((entry or {}).get("cards") or [])
        out.append({"chapter_id": cid, "number": i + 1, "title": _title_of(text) or _clip(ch.get("objective"), 90),
                    "objective": _clip(ch.get("objective"), 200), "scenes": max(_scene_count(text), len(cards)),
                    "cards": [{"scene": k + 1, "place": _clip(c.get("place"), 80), "time": _clip(c.get("time"), 60),
                               "characters": [_clip(n, 60) for n in c.get("characters") or []][:6],
                               "moment": _clip(c.get("change") or c.get("beat"), 160)} for k, c in enumerate(cards)],
                    "state": "approved" if appr else "draft" if rec else "unwritten",
                    "section_id": appr["record_id"] if appr else None})
    return out


def _places(store, pid, branch) -> list[dict]:
    """The places (A04): [{record_id, subject_id, name, rec}] — approved revision when there is one."""
    out = []
    for r in sorted(store.list_records(pid, branch, module_id="A04"), key=lambda x: x.get("created_at") or ""):
        if r.get("record_kind") != "OUTPUT" or r.get("lifecycle") in ("REJECTED", "SUPERSEDED"):
            continue
        rec = store.get_record(pid, branch, r["record_id"], r["approved_version"]) if r.get("approved_version") else r
        rec = rec or r
        name, subject = chars_mod._name_and_subject(rec)  # noqa: SLF001 - the one name rule of the book
        out.append({"record_id": r["record_id"], "subject_id": subject, "name": name, "rec": rec})
    return out


def looks_of(store, pid, branch, rid: str, budget: int = 260) -> str:
    """A character's approved look for a prompt: Fixed visual anchors first, then the appearance fields that are the
    author's own or approved (never an AI proposal), at most ``budget`` characters."""
    try:
        d = forge.public(store, pid, branch, rid)
    except AkoweError:
        return ""
    texts = {f["key"]: f["text"] for s in d["sections"] for f in s["fields"]
             if f["text"] and f["status"] in ("supplied", "approved")}
    parts = []
    if texts.get("visual_anchors"):
        parts.append(texts["visual_anchors"])
    for k in forge.APPEARANCE_KEYS:
        if texts.get(k) and texts[k] not in parts:
            parts.append(texts[k])
    return _fit("; ".join(" ".join(p.split()).rstrip(".;") for p in parts), budget)


def _fit(text: str, n: int) -> str:
    """At most n characters, cut at a word boundary (an ellipsis-free cut: the prompt stays plain)."""
    text = " ".join(str(text or "").split())
    if len(text) <= n:
        return text
    cut = text[:n + 1].rsplit(" ", 1)[0] if " " in text[:n + 1] else text[:n]
    return cut.rstrip(" ,;:.")[:n]


def scene_context(app, principal, pid, branch, chapter_id: str, scene: int | None) -> dict:
    """What the picture shows: {number, scene, place, time, moment, characters: [{record_id, name}], pov}."""
    bp = _bp(app, principal, pid, branch)
    outline = bp.outline()
    if not outline:
        raise _bad("/chapter_id", "plan the chapters first (Make my book → chapter outline): a picture is made from "
                   "a chapter of the outline", "MISSING_INPUT")
    plan = scenes_mod.chapter_plan(bp, outline, chapter_id)
    entry = scenes_mod.get_entry(app.store, pid, branch, outline["record_id"], chapter_id)
    cards = list((entry or {}).get("cards") or [])
    if scene is not None and scene > max(len(cards), 1):
        raise _bad("/scene", f"chapter {plan['number']} has {len(cards)} scene card(s); make the scene cards first "
                   "or illustrate the whole chapter")
    card = cards[scene - 1] if scene and cards else (cards[0] if cards else {})
    cs = chars_mod.canon_characters(app.store, pid, branch)
    names = [n for n in card.get("characters") or [] if isinstance(n, str)] + \
        [g.get("character") for g in card.get("goals") or [] if isinstance(g, dict) and g.get("character")]
    pov = next((c for c in cs if plan.get("pov_id") and plan["pov_id"] in (c["subject_id"], c["record_id"])), None)
    if names:
        present = chars_mod.present_in(cs, *names, ids=names)
    else:
        present = chars_mod.present_in(cs, plan.get("objective") or "", plan.get("summary") or "",
                                       ids=[plan.get("pov_id")])
    if pov and pov in present:
        present.remove(pov)
        present.insert(0, pov)
    elif pov and not names:
        present.insert(0, pov)
    place = _clip(card.get("place"), 120)
    if not place and plan.get("location_id"):
        place = next((p["name"] for p in _places(app.store, pid, branch)
                      if plan["location_id"] in (p["subject_id"], p["record_id"])), "")
    if scene:
        moment = card.get("change") or card.get("beat") or plan.get("objective")
    else:
        moment = plan.get("objective") or plan.get("summary") or card.get("change")
    return {"number": plan["number"], "scene": scene, "place": place, "time": _clip(card.get("time"), 80),
            "moment": _clip(moment, 400), "obstacle": _clip(card.get("obstacle"), 200),
            "characters": [{"record_id": c["record_id"], "name": c["name"]} for c in present][:4],
            "pov": pov["name"] if pov else None}


def build_prompt(ctx: dict, looks: dict, style: str, lock: str | None = None) -> str:
    """The illustration prompt (≤ PROMPT_MAX): style, the moment, place and time, each present character's approved
    look and the character lock. ``looks`` = {name: look text}."""
    style = _clip(style, STYLE_MAX) or "detailed book illustration"
    where = f"chapter {ctx['number']}" + (f", scene {ctx['scene']}" if ctx.get("scene") else "")
    head = f"Art style: {style}. Book illustration for {where}"
    moment = _fit(ctx.get("moment") or "", 320)
    setting = ", ".join(x for x in (_fit(ctx.get("place") or "", 140), _fit(ctx.get("time") or "", 70)) if x)
    tail = "Keep every character's look exactly as described. No text, letters, captions or watermark in the picture."
    lock_txt = f"Character lock: {lock}." if lock else ""
    fixed = [head + (f": {moment}." if moment else "."), f"Setting: {setting}." if setting else "", lock_txt, tail]
    room = PROMPT_MAX - sum(len(x) + 1 for x in fixed if x) - len("Characters: ") - 4
    people = [c["name"] for c in ctx.get("characters") or []]
    chars = ""
    if people and room > 40:
        each = max(40, room // len(people))
        bits = []
        for n in people:
            look = looks.get(n) or ""
            bit = f"{n} ({look})" if look else n
            bits.append(_fit(bit, each - 2) + (")" if look and len(bit) > each - 2 else ""))
        chars = _fit("Characters: " + "; ".join(bits), room + len("Characters: ")) + "."
    parts = [fixed[0], fixed[1], chars, fixed[2], fixed[3]]
    return _fit(" ".join(p for p in parts if p), PROMPT_MAX)


def prompt_for(app, principal, pid, branch, chapter_id: str, scene: int | None) -> dict:
    """{prompt, lock, characters, context} for a chapter or scene picture (also the 👁 preview on the page)."""
    ctx = scene_context(app, principal, pid, branch, chapter_id, scene)
    looks = {c["name"]: looks_of(app.store, pid, branch, c["record_id"]) for c in ctx["characters"]}
    lock = ctx["pov"] if ctx["pov"] and any(c["name"] == ctx["pov"] for c in ctx["characters"]) else \
        (ctx["characters"][0]["name"] if ctx["characters"] else None)
    style = doc(app.store, pid, branch).get("style") or ""
    return {"prompt": build_prompt(ctx, looks, style, lock), "lock": lock,
            "characters": [c["name"] for c in ctx["characters"]], "context": ctx}


def map_prompt(app, pid, branch) -> str:
    """The illustrated map's prompt: the places, the world's rules and the art style (≤ PROMPT_MAX)."""
    from .book_path import get_profile  # noqa: PLC0415
    style = doc(app.store, pid, branch).get("style") or "hand-drawn fantasy cartography"
    title = (get_profile(app.store, pid) or {}).get("title") or "the book"
    places = [p["name"] for p in _places(app.store, pid, branch)][:16]
    world = []
    try:
        for w in scenes_mod.world_view(app.engine, pid, branch, limit=12):
            if w.get("kind") in ("A04", "place", "location") or not w.get("about"):
                continue
            world.append(_fit(f"{w['name']}: {w['about']}", 140))
    except Exception:  # noqa: BLE001 - the places alone are enough
        world = []
    head = (f"Art style: {_clip(style, STYLE_MAX)}. A wide, top-down illustrated map of the world of {title}, "
            "seen from above like an old atlas page, no legend, no compass text, no frame text.")
    pl = ("Places to show, each clearly separate: " + ", ".join(places) + ".") if places else ""
    tail = "Clear coastlines, rivers, roads between the places; place names may be lettered small and legibly."
    room = PROMPT_MAX - len(head) - len(pl) - len(tail) - 16
    wr = _fit("World: " + "; ".join(world), room) + "." if world and room > 60 else ""
    return _fit(" ".join(x for x in (head, pl, wr, tail) if x), PROMPT_MAX)


# ====================================================================== the SVG map (d_maps)
def map_graph(app, principal, pid, branch) -> dict:
    """A d_maps MapGraph of the book's places: their own coordinates when every place has them, else a route in
    story order (the order the chapters first visit the places; places never visited follow in canon order)."""
    places = _places(app.store, pid, branch)
    if not places:
        raise _bad("/kind", "the book has no places yet: make the places first (Make my book → characters and "
                   "places, or the 🌍 world page), or upload your own map", "MISSING_INPUT")
    merged = {"data": {"facts": [f for p in places for f in ((p["rec"].get("data") or {}).get("facts") or [])
                                 if isinstance(f, dict)]}, "ref": places[0]["rec"]["ref"]}
    graph, problems = d_maps.extract_graph(merged, [p["rec"] for p in places], None)
    if graph is not None and len(graph["nodes"]) >= 1:
        return graph
    # story order: chapter plan locations and scene-card places
    order: list[str] = []
    by_name = {p["name"].lower(): p["subject_id"] for p in places}
    by_id = {}
    for p in places:
        by_id[p["subject_id"]] = p["subject_id"]
        by_id[p["record_id"]] = p["subject_id"]
    try:
        bp = _bp(app, principal, pid, branch)
        outline = bp.outline()
        for ch in bp.outline_chapters(outline) if outline else []:
            plan = scenes_mod.chapter_plan(bp, outline, ch["chapter_id"])
            if plan.get("location_id") in by_id:
                order.append(by_id[plan["location_id"]])
            entry = scenes_mod.get_entry(app.store, pid, branch, outline["record_id"], ch["chapter_id"])
            for c in (entry or {}).get("cards") or []:
                txt = str(c.get("place") or "").lower()
                for name, sid in by_name.items():
                    if name and name in txt:
                        order.append(sid)
    except Exception:  # noqa: BLE001 - canon order is a fine route
        log.info("story order of the places unavailable; canon order used")
    seen: list[str] = []
    for sid in order + [p["subject_id"] for p in places]:
        if sid not in seen:
            seen.append(sid)
    names = {p["subject_id"]: p["name"] for p in places}
    refs = {p["subject_id"]: p["rec"]["ref"] for p in places}
    nodes = []
    for i, sid in enumerate(seen):  # a gentle meander left to right, two rows when there are many places
        row, col = divmod(i, 8)
        x = col * 100 if row % 2 == 0 else (7 - col) * 100
        y = row * 140 + int(round(45 * math.sin(i * 1.7)))
        nodes.append({"id": sid, "x": x, "y": y, "label": names[sid], "canon_ref": refs[sid]})
    edges = [{"id": f"{a}->{b}", "from": a, "to": b} for a, b in zip(seen, seen[1:])]
    return {"coordinate_system": "story-route", "unit": "world_units", "nodes": nodes, "edges": edges,
            "geometry_tolerance": 0}


def svg_map(app, principal, pid, branch) -> bytes:
    from .book_path import get_profile  # noqa: PLC0415
    title = (get_profile(app.store, pid) or {}).get("title") or "the book"
    graph = map_graph(app, principal, pid, branch)
    return _fit_labels(d_maps.render_svg(graph, title=f"Map of {title}"[:120]), graph)


def _fit_labels(svg: bytes, graph: dict) -> bytes:
    """Widen the SVG's viewBox so the (centred) place names are not cut off at the sides; nothing else changes."""
    m = re.search(rb'viewBox="([^"]+)"', svg)
    f = re.search(rb'font-size="([^"]+)"', svg)
    if not m or not f or not graph["nodes"]:
        return svg
    x, y, w, h = (float(v) for v in m.group(1).split())
    font = float(f.group(1))
    lo = min(n["x"] - len(n["label"]) * font * 0.32 for n in graph["nodes"]) - font
    hi = max(n["x"] + len(n["label"]) * font * 0.32 for n in graph["nodes"]) + font
    top = min(n["y"] for n in graph["nodes"]) - font * 2
    nx, nw = min(x, lo), max(x + w, hi) - min(x, lo)
    ny, nh = min(y, top), y + h - min(y, top)
    vb = " ".join(d_maps._num(v) for v in (nx, ny, nw, nh))  # noqa: SLF001 - the same number format as the SVG
    return svg.replace(m.group(0), f'viewBox="{vb}"'.encode("ascii"), 1)


# ====================================================================== art (AutoInjector POST /image/request)
def _request(app, body: dict) -> tuple[bytes, dict, bool]:
    """One picture: (bytes, answer, lock_missing). A missing character lock: the picture is made from the prompt."""
    try:
        resp = forge.request_image(app, body)
        lock_missing = False
    except forge.ArtProblem as exc:
        if exc.code != "NO_LOCK" or "characterLock" not in body:
            raise
        body = {k: v for k, v in body.items() if k != "characterLock"}
        resp = forge.request_image(app, body)
        lock_missing = True
    data, seed = forge.first_picture(resp)
    resp = dict(resp, seed=seed if seed is not None else resp.get("seed"))
    return data, resp, lock_missing


def _candidate(app, job, pid, branch, body: dict, label: str, engine: str) -> dict:
    data, resp, lock_missing = _request(app, body)
    asset = forge.store_picture(app.store, job.principal, pid, branch, data, "", label)
    warnings = [str(w)[:200] for w in resp.get("warnings") or []][:5]
    if lock_missing:
        warnings.append(f"no character lock named {body.get('characterLock')}")
    seed = resp.get("seed")
    asset.update(source=str(resp.get("engine") or engine), engine=resp.get("engine"),
                 seed=seed if isinstance(seed, int) and not isinstance(seed, bool) else None,
                 warnings=warnings or None)
    return asset


def _book_title(app, pid) -> str | None:
    try:
        from .book_path import get_profile  # noqa: PLC0415
        return (get_profile(app.store, pid) or {}).get("title") or None
    except Exception:  # noqa: BLE001
        return None


def _job(app, kind, principal, pid, branch, total: int):
    from .review import ReviewJob  # noqa: PLC0415

    class PicturesJob(ReviewJob):
        def public(self):
            out = super().public()
            out["total"] = self.total
            out["pic_id"] = getattr(self, "pic_id", None)
            return out
    j = PicturesJob(kind, principal, pid, branch, [], None)
    j.total = total
    return j


def _fail(j, exc: forge.ArtProblem, made: int):
    j.status, j.phase, j.error = "error", "Failed", exc.as_error()
    if made:
        j.error["message"] = f"{j.error['message']} — the {made} picture(s) made before are kept"


def _engine(body: dict) -> str:
    engine = body.get("engine", "auto")
    if engine not in forge.ENGINES:
        raise _bad("/engine", "engine: auto, sd or chatgpt")
    return engine


def _scene(v) -> int | None:
    if v in (None, "", 0):
        return None
    if isinstance(v, str) and v.isdigit():
        v = int(v)
    if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= scenes_mod.MAX_SCENES:
        raise _bad("/scene", f"scene: a scene number 1-{scenes_mod.MAX_SCENES}, or leave it out for the whole chapter")
    return v


def _need_scope(app, principal, pid, branch):
    if not app.store.has_scope(principal, pid, branch, "I01:create"):
        raise AkoweError("PERMISSION_DENIED", "", "missing scope I01:create", **_REJ)


def _known_chapter(chs: list[dict], chapter_id) -> dict:
    ch = next((c for c in chs if c["chapter_id"] == chapter_id), None)
    if ch is None:
        raise _bad("/chapter_id", "that chapter is not in the approved chapter outline")
    return ch


def start_illustrate(app, principal, pid, branch, body) -> dict:
    """POST …/pictures/illustrate {chapter_id, scene?, engine, count?} -> 202 job (count 1-3 candidates)."""
    body = body if isinstance(body, dict) else {}
    engine = _engine(body)
    scene = _scene(body.get("scene"))
    count = body.get("count", 1)
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= MAX_COUNT:
        raise _bad("/count", f"count: how many pictures to choose from, 1-{MAX_COUNT}")
    chs = chapters(app, principal, pid, branch)
    ch = _known_chapter(chs, body.get("chapter_id"))
    _need_scope(app, principal, pid, branch)
    info = prompt_for(app, principal, pid, branch, ch["chapter_id"], scene)
    pic_id = ensure_picture(app.store, pid, branch, "chapter", ch["chapter_id"], scene)
    job = _job(app, "pictures", principal, pid, branch, count)
    job.pic_id = pic_id
    what = f"chapter {ch['number']}" + (f", scene {scene}" if scene else "")

    def fn(j):
        j.current = pic_id
        base = {"engine": engine, "purpose": "illustration", "prompt": info["prompt"], "characterLock": info["lock"],
                "book": _book_title(app, pid), "from": "akowe-pictures", "returnImage": True}
        base = {k: v for k, v in base.items() if v is not None}
        try:
            for i in range(count):
                j.check()
                j.phase = f"Making picture {i + 1} of {count} for {what} — a ChatGPT picture can take 1-3 minutes"
                cand = _candidate(app, j, pid, branch, dict(base), f"Picture for {what}", engine)
                add_candidate(app.store, pid, branch, pic_id, cand, choose=None if count == 1 else False,
                              prompt=info["prompt"])
                j.done = i + 1
                j.results.append({"ok": True, "pic_id": pic_id, "engine": cand.get("engine"),
                                  "message": f"Picture {i + 1} of {count} made"})
        except forge.ArtProblem as exc:
            _fail(j, exc, j.done)
            return
        j.results.append({"ok": True, "pic_id": pic_id, "message": (
            f"{count} pictures made for {what}: pick the one you want." if count > 1 else
            f"The picture for {what} is made and stored with the book.")})
    return app.review._start(job, fn)  # noqa: SLF001 - the jobs of forge.py run the same way


def start_illustrate_all(app, principal, pid, branch, body) -> dict:
    """POST …/pictures/illustrate-all {engine} -> 202 job: one picture per chapter that has no chosen picture yet."""
    body = body if isinstance(body, dict) else {}
    engine = _engine(body)
    chs = chapters(app, principal, pid, branch)
    if not chs:
        raise _bad("/chapter_id", "plan the chapters first: there is no approved chapter outline yet", "MISSING_INPUT")
    _need_scope(app, principal, pid, branch)
    d = doc(app.store, pid, branch)
    todo = [c for c in chs if not has_chosen(d, c["chapter_id"])]
    job = _job(app, "pictures_all", principal, pid, branch, len(todo))

    def fn(j):
        made = skipped = 0
        try:
            for k, ch in enumerate(todo):
                j.check()
                j.current = ch["chapter_id"]
                if has_chosen(doc(app.store, pid, branch), ch["chapter_id"]):  # chosen meanwhile (another tab)
                    skipped += 1
                    j.done = k + 1
                    continue
                j.phase = f"Chapter {ch['number']} ({k + 1} of {len(todo)}): making the picture"
                info = prompt_for(app, principal, pid, branch, ch["chapter_id"], None)
                pic_id = ensure_picture(app.store, pid, branch, "chapter", ch["chapter_id"], None)
                body_ = {"engine": engine, "purpose": "illustration", "prompt": info["prompt"],
                         "characterLock": info["lock"], "book": _book_title(app, pid), "from": "akowe-pictures",
                         "returnImage": True}
                cand = _candidate(app, j, pid, branch, {k_: v for k_, v in body_.items() if v is not None},
                                  f"Picture for chapter {ch['number']}", engine)
                add_candidate(app.store, pid, branch, pic_id, cand, choose=True, prompt=info["prompt"])
                made += 1
                j.done = k + 1
                j.results.append({"ok": True, "pic_id": pic_id, "chapter_id": ch["chapter_id"],
                                  "message": f"Chapter {ch['number']}: picture made"})
        except forge.ArtProblem as exc:
            _fail(j, exc, made)
            return
        left = len(chs) - len(todo)
        j.results.append({"ok": True, "made": made, "message": f"{made} chapter picture(s) made"
                          + (f"; {left + skipped} chapter(s) already had a picture and were left as they are"
                             if left + skipped else "") + "."})
    return app.review._start(job, fn)  # noqa: SLF001


MAP_PNG_WIDTH = 2000


def map_png_size(svg: bytes) -> tuple[int, int]:
    """The PNG size of the Word copy: MAP_PNG_WIDTH wide (less when very tall), the SVG's viewBox shape."""
    m = re.search(rb'viewBox="\s*[-0-9.eE]+[ ,]+[-0-9.eE]+[ ,]+([0-9.eE]+)[ ,]+([0-9.eE]+)\s*"', svg)
    try:
        vw, vh = (float(m.group(1)), float(m.group(2))) if m else (4.0, 3.0)
    except ValueError:
        vw, vh = 4.0, 3.0
    if vw <= 0 or vh <= 0:
        vw, vh = 4.0, 3.0
    w, h = float(MAP_PNG_WIDTH), MAP_PNG_WIDTH * vh / vw
    if h > 4096:
        w, h = w * 4096 / h, 4096.0
    return max(16, min(4096, int(round(w)))), max(16, min(4096, int(round(h))))


def map_png(app, principal, pid, branch, svg: bytes) -> dict:
    """🖨 The PNG copy of an SVG map for Word, drawn by AutoInjector → a book asset {asset_id, version, mime}.
    Raises forge.ArtProblem when AutoInjector cannot draw it."""
    from . import render  # noqa: PLC0415
    w, h = map_png_size(svg)
    data = render.render_image(app, svg, w, h, fmt="png")
    asset = forge._store_asset(app.store, principal, pid, branch, data, "image/png",  # noqa: SLF001
                               "Map of the book (PNG copy for Word)")
    return {k: asset[k] for k in ("asset_id", "version", "mime")} | {"width": w, "height": h}


WORD_NOTE = ("Word cannot show this map without a PNG copy, which AutoInjector draws: start AutoInjector, then press "
             "“Make the Word copy”. Until then the Word file says where to find the map.")


def make_svg_map(app, principal, pid, branch) -> dict:
    """POST …/pictures/map {kind: "svg"}: the map drawn from the places (d_maps SVG), added as a candidate; its PNG
    copy for Word is drawn by AutoInjector when it is connected."""
    _need_scope(app, principal, pid, branch)
    svg = svg_map(app, principal, pid, branch)
    asset = forge._store_asset(app.store, principal, pid, branch, svg, SVG_MIME, "Map of the book (SVG)")  # noqa: SLF001
    asset["source"] = "svg"
    word = "Word files show a PNG copy of it."
    try:
        asset["png"] = map_png(app, principal, pid, branch, svg)
    except forge.ArtProblem as exc:
        log.info("the Word copy of the map was not drawn: %s", exc.code)
        word = WORD_NOTE
    pic_id = ensure_picture(app.store, pid, branch, "map", None, None)
    p = add_candidate(app.store, pid, branch, pic_id, asset, choose=None)
    return {"ok": True, "picture": public_picture(pid, branch, p),
            "message": f"The map is drawn from your places. It is in the PDF (drawn as lines and text) and the EPUB. "
                       f"{word}"}


def make_map_png(app, principal, pid, branch) -> dict:
    """POST …/pictures/map {kind: "png"}: draw the missing Word copy of the chosen SVG map (AutoInjector)."""
    from . import render  # noqa: PLC0415
    _need_scope(app, principal, pid, branch)
    d = doc(app.store, pid, branch)
    p = next((x for x in d["pictures"].values() if x["kind"] == "map"), None)
    cands = (p or {}).get("candidates") or []
    c = (p or {}).get("chosen")
    if p is None or c is None or c >= len(cands) or cands[c].get("mime") != SVG_MIME:
        raise _bad("/kind", "the chosen map is not a drawn (SVG) map: only a drawn map needs a Word copy",
                   "MISSING_INPUT")
    svg = forge.picture_bytes(app.store, pid, branch, cands[c])
    if not svg:
        raise _bad("/kind", "the drawn map cannot be read any more: draw the map again", "MISSING_INPUT")
    try:
        png = map_png(app, principal, pid, branch, svg)
    except forge.ArtProblem as exc:
        raise render.as_error(exc, "Word copy of the map", "/kind") from None
    idx = c

    def fn(dd):
        pp = dd["pictures"].get(p["id"])
        if pp is None or idx >= len(pp.get("candidates") or []):
            raise _bad("/pic_id", "this picture was deleted", "NOT_FOUND")
        pp["candidates"][idx]["png"] = png
        pp["updated_at"] = _now()
        return pp
    out = _mutate(app.store, pid, branch, fn, "pictures.candidate")
    return {"ok": True, "picture": public_picture(pid, branch, out),
            "message": "The Word copy of the map is made: put the book together again and the Word file shows it."}


def start_map_illustrated(app, principal, pid, branch, body) -> dict:
    engine = _engine(body)
    if not _places(app.store, pid, branch):
        raise _bad("/kind", "the book has no places yet: make the places first, or upload your own map",
                   "MISSING_INPUT")
    _need_scope(app, principal, pid, branch)
    prompt = map_prompt(app, pid, branch)
    pic_id = ensure_picture(app.store, pid, branch, "map", None, None)
    job = _job(app, "pictures_map", principal, pid, branch, 1)
    job.pic_id = pic_id

    def fn(j):
        j.current = pic_id
        j.phase = "Making the illustrated map — a ChatGPT picture can take 1-3 minutes"
        body_ = {"engine": engine, "purpose": "map", "prompt": prompt, "book": _book_title(app, pid),
                 "from": "akowe-pictures", "returnImage": True}
        try:
            cand = _candidate(app, j, pid, branch, {k: v for k, v in body_.items() if v is not None},
                              "Illustrated map", engine)
        except forge.ArtProblem as exc:
            _fail(j, exc, 0)
            return
        add_candidate(app.store, pid, branch, pic_id, cand, choose=True, prompt=prompt)
        j.done = 1
        j.results.append({"ok": True, "pic_id": pic_id, "message": "The illustrated map is made and chosen."})
    return app.review._start(job, fn)  # noqa: SLF001


def upload(app, principal, pid, branch, query: dict, body) -> dict:
    """PUT …/pictures/upload?chapter=<chapter id>|map[&scene=n] with the PNG/JPEG bytes: the author's own picture,
    added as a candidate and chosen."""
    if not isinstance(body, (bytes, bytearray)):
        raise _bad("/body", "send the picture itself (PNG or JPEG bytes) with Content-Type image/png or image/jpeg")
    chapter = (query.get("chapter") or [""])[0]
    scene = _scene((query.get("scene") or [None])[0])
    if chapter == "map":
        kind, cid, label = "map", None, "Map (uploaded)"
    else:
        ch = _known_chapter(chapters(app, principal, pid, branch), chapter)
        kind, cid, label = "chapter", ch["chapter_id"], f"Picture for chapter {ch['number']} (uploaded)"
    asset = forge.store_picture(app.store, principal, pid, branch, bytes(body), "", label)
    asset["source"] = "upload"
    pic_id = ensure_picture(app.store, pid, branch, kind, cid, scene)
    p = add_candidate(app.store, pid, branch, pic_id, asset, choose=True)
    return {"ok": True, "picture": public_picture(pid, branch, p), "message": "Picture saved with the book."}


# ====================================================================== author edits
def set_style(store, pid, branch, body) -> dict:
    body = body if isinstance(body, dict) else {}
    style = body.get("style")
    if not isinstance(style, str) or len(style) > STYLE_MAX:
        raise _bad("/style", f"style: the book's art style in a few words (at most {STYLE_MAX} characters), for "
                   "example “ink wash”, “painterly” or “manga”")

    def fn(d):
        d["style"] = _clip(style, STYLE_MAX)
        return d["style"]
    return {"ok": True, "style": _mutate(store, pid, branch, fn, "pictures.style")}


def update(store, pid, branch, pic_id: str, body) -> dict:
    """PUT …/pictures/:pic_id {caption?, alt?, placement?: {where, scene?}, chosen?: index|null}."""
    if not isinstance(body, dict) or not body:
        raise _bad("/body", "send caption, alt, placement or chosen")
    unknown = set(body) - {"caption", "alt", "placement", "chosen", "revision"}
    if unknown:
        raise _bad(f"/{sorted(unknown)[0]}", "only caption, alt, placement and chosen can be changed")
    for k in ("caption", "alt"):
        if k in body and (not isinstance(body[k], str) or len(body[k]) > TEXT_MAX):
            raise _bad(f"/{k}", f"{k}: plain text, at most {TEXT_MAX} characters")
    pl = body.get("placement")
    if pl is not None:
        if not isinstance(pl, dict) or pl.get("where") not in WHERE:
            raise _bad("/placement/where", "where: before (a page of its own before the chapter), start (under the "
                       "chapter heading), after_scene (with scene: n) or end (the end of the chapter)")
        if pl["where"] == "after_scene" and _scene(pl.get("scene")) is None:
            raise _bad("/placement/scene", "after_scene needs the scene number (scene: 1, 2, …)")

    def fn(d):
        p = d["pictures"].get(pic_id)
        if p is None:
            raise _bad("/pic_id", "no such picture (it may have been deleted)", "NOT_FOUND")
        if "revision" in body and body["revision"] != d.get("revision"):
            raise _bad("/revision", "the pictures changed since you opened the page; reload it", "VERSION_CONFLICT")
        for k in ("caption", "alt"):
            if k in body:
                p[k] = _clip(body[k], TEXT_MAX)
        if pl is not None:
            p["placement"] = {"where": pl["where"], "scene": _scene(pl.get("scene")) if pl["where"] == "after_scene"
                              else None}
        if "chosen" in body:
            c = body["chosen"]
            if c is not None and (isinstance(c, bool) or not isinstance(c, int)
                                  or not 0 <= c < len(p.get("candidates") or [])):
                raise _bad("/chosen", f"chosen: the number of a candidate (0-{len(p.get('candidates') or []) - 1}) "
                           "or null to place no picture")
            p["chosen"] = c
        p["updated_at"] = _now()
        return p
    p = _mutate(store, pid, branch, fn, "pictures.saved")
    return {"ok": True, "picture": public_picture(pid, branch, p), "message": "Saved"}


def delete(store, pid, branch, pic_id: str) -> dict:
    def fn(d):
        if pic_id not in d["pictures"]:
            raise _bad("/pic_id", "no such picture (it may have been deleted already)", "NOT_FOUND")
        del d["pictures"][pic_id]
        return True
    _mutate(store, pid, branch, fn, "pictures.deleted")
    return {"ok": True, "message": "Picture removed from the book (its files stay in the book's assets)."}


# ====================================================================== reading
def _cand_public(pid, branch, i, c, chosen):
    out = forge._art_public(pid, branch, c) or {}  # noqa: SLF001 - the same asset URL rule as the dossier art
    out["index"] = i
    out["chosen"] = i == chosen
    out["vector"] = c.get("mime") == SVG_MIME
    if out["vector"]:
        out["word_copy"] = bool(isinstance(c.get("png"), dict) and c["png"].get("asset_id"))
    return out


def public_picture(pid, branch, p: dict) -> dict:
    chosen = p.get("chosen")
    cands = [_cand_public(pid, branch, i, c, chosen) for i, c in enumerate(p.get("candidates") or [])]
    return {"id": p["id"], "kind": p["kind"], "chapter_id": p.get("chapter_id"), "scene": p.get("scene"),
            "caption": p.get("caption") or "", "alt": p.get("alt") or "", "placement": p.get("placement") or {},
            "candidates": cands, "chosen": chosen if chosen is not None and chosen < len(cands) else None,
            "picture": cands[chosen] if chosen is not None and chosen < len(cands) else None,
            "prompt": p.get("prompt") or "", "updated_at": p.get("updated_at")}


def info(app, principal, pid, branch) -> dict:
    """GET …/pictures: the style, the map, every chapter with its pictures, and where AutoInjector is."""
    d = doc(app.store, pid, branch)
    chs = chapters(app, principal, pid, branch)
    pics = [public_picture(pid, branch, p) for p in sorted(d["pictures"].values(), key=lambda p: p["id"])]
    by_ch: dict = {}
    for p in pics:
        if p["kind"] == "chapter":
            by_ch.setdefault(p["chapter_id"], []).append(p)
    for c in chs:
        c["pictures"] = sorted(by_ch.get(c["chapter_id"], []), key=lambda p: (p["scene"] or 0, p["id"]))
        c.pop("section_id", None)
    return {"style": d.get("style") or "", "styles": list(STYLES), "revision": d.get("revision") or 0,
            "chapters": chs, "map": next((p for p in pics if p["kind"] == "map"), None),
            "places": len(_places(app.store, pid, branch)),
            "counts": {"pictures": len(pics), "chosen": sum(1 for p in pics if p["picture"]),
                       "chapters_with_picture": sum(1 for c in chs if has_chosen(d, c["chapter_id"]))},
            "where": list(WHERE), "max_count": MAX_COUNT, "out_of_date": None,
            "image_bridge": {"uses": [u for u, _t in forge.bridge_targets(app)]}}


# ====================================================================== the exports: snapshot + overlay
def signature(store, pid, branch) -> str:
    """What the placed pictures are (chosen candidate, caption, alt, placement): "" when no picture is placed."""
    d = doc(store, pid, branch)
    rows = []
    for p in sorted(d["pictures"].values(), key=lambda p: p["id"]):
        c = p.get("chosen")
        cands = p.get("candidates") or []
        if c is None or c >= len(cands):
            continue
        row = [p["id"], p.get("kind"), p.get("chapter_id"), p.get("scene"), cands[c].get("asset_id"),
               cands[c].get("version"), p.get("caption"), p.get("alt"), p.get("placement")]
        if isinstance(cands[c].get("png"), dict):  # 🖨 the Word copy of a drawn map (only then: older books keep theirs)
            row.append(cands[c]["png"].get("asset_id"))
        rows.append(row)
    if not rows:
        return ""
    return hashlib.sha256(json.dumps(rows, sort_keys=True).encode("utf-8")).hexdigest()[:24]


def snapshot(bp, g02_ref: dict) -> str:
    """Freeze the chosen pictures for this assembly (keyed by its G02 record); returns the signature."""
    store, pid, branch = bp.store, bp.pid, bp.branch
    d = doc(store, pid, branch)
    outline = bp.outline()
    order, section = {}, {}
    if outline:
        for i, ch in enumerate(bp.outline_chapters(outline)):
            order[ch["chapter_id"]] = i
            try:
                _c, _l, appr = bp.chapter_prose(outline, ch["chapter_id"])
            except Exception:  # noqa: BLE001
                appr = None
            if appr:
                section[ch["chapter_id"]] = appr["record_id"]
    first = min(order, key=order.get) if order else None
    items = []
    pics = sorted(d["pictures"].values(), key=lambda p: (order.get(p.get("chapter_id") or first, 0),
                                                         0 if p["kind"] == "map" else 1, p.get("scene") or 0, p["id"]))
    for p in pics:
        c = p.get("chosen")
        cands = p.get("candidates") or []
        if c is None or c >= len(cands):
            continue
        cand = cands[c]
        cid = p.get("chapter_id") or first
        if cid not in section:
            continue
        rec = store.get_record(pid, branch, cand["asset_id"], int(cand.get("version") or 1))
        if rec is None or rec.get("representation") != "BINARY_ARTIFACT":
            continue
        pl = p.get("placement") or {}
        item = {"id": p["id"], "kind": p["kind"], "section_id": section[cid], "where": pl.get("where") or "start",
                "scene": pl.get("scene"), "caption": p.get("caption") or "", "alt": p.get("alt") or "",
                "asset": {"record_id": rec["record_id"], "version": rec["version"],
                          "content_hash": rec["content_hash"]},
                "mime": rec["binary"]["mime_type"]}
        png = cand.get("png") if item["mime"] == SVG_MIME else None
        if isinstance(png, dict) and png.get("asset_id"):  # 🖨 the Word copy of a drawn map
            prec = store.get_record(pid, branch, png["asset_id"], int(png.get("version") or 1))
            if prec is not None and prec.get("representation") == "BINARY_ARTIFACT":
                item["png"] = {"record_id": prec["record_id"], "version": prec["version"],
                               "content_hash": prec["content_hash"]}
        items.append(item)
    sig = signature(store, pid, branch)
    store.set_setting(snap_key(pid, branch, g02_ref["record_id"]), {"items": items, "signature": sig, "at": _now()})
    return sig


def _box(info, where: str) -> tuple[float, float]:
    """Placement box (mm) from the picture's aspect: a plate fills the page width, an in-text picture is smaller."""
    w = 150.0 if where == "before" else 120.0
    h = w * info.height / max(info.width, 1)
    cap = 220.0 if where == "before" else 100.0
    if h > cap:
        w, h = w * cap / h, cap
    return round(w, 3), round(h, 3)


def overlay(ctx, asm) -> None:
    """set_g.assemble: place the snapshot of this assembly (by its G02 record) into the book model. Deterministic:
    the same snapshot always gives the same book, so the G04 pagination reproduces exactly."""
    try:
        snap = ctx.store.get_setting(snap_key(ctx.project_id, ctx.branch_id, asm.manifest_rec["record_id"]))
    except Exception:  # noqa: BLE001 - no snapshot: no pictures
        snap = None
    items = (snap or {}).get("items") if isinstance(snap, dict) else None
    if not items:
        return
    from .canonical import sha256_bytes  # noqa: PLC0415
    from .exporters import book as bookmod  # noqa: PLC0415
    from .exporters.images import UnsupportedImage, load_image  # noqa: PLC0415
    place = []
    for it in items:
        a = it.get("asset") or {}
        rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, a.get("record_id"), a.get("version"))
        if rec is None or rec.get("representation") != "BINARY_ARTIFACT" or rec["content_hash"] != a.get("content_hash"):
            log.warning("picture %s: its stored file is missing; left out", it.get("id"))
            continue
        raw = ctx.binary(rec)
        blk = {"id": it["id"]}
        if it.get("caption"):
            blk["caption"] = bookmod.squash(bookmod.clean_text(it["caption"]))
        if it.get("alt"):
            blk["alt"] = bookmod.squash(bookmod.clean_text(it["alt"]))
        if it.get("mime") == SVG_MIME:
            blk.update(t="vmap", svg=raw.decode("utf-8"), w_mm=150.0 if it["where"] == "before" else 120.0,
                       h_mm=120.0 if it["where"] == "before" else 90.0)
            pa = it.get("png") or {}
            prec = ctx.store.get_record(ctx.project_id, ctx.branch_id, pa.get("record_id"), pa.get("version")) \
                if pa else None
            if prec is not None and prec.get("representation") == "BINARY_ARTIFACT" \
                    and prec["content_hash"] == pa.get("content_hash"):
                try:  # 🖨 the Word copy: the DOCX places it like a picture (the PDF / EPUB keep the SVG)
                    praw = ctx.binary(prec)
                    pkey = sha256_bytes(praw)
                    asm.pictures[pkey] = (praw, load_image(praw, "image/png"))
                    blk["png_key"] = pkey
                    asm.picture_recs.append(prec)
                except UnsupportedImage:
                    log.warning("picture %s: its Word copy is not a usable PNG; left out", it.get("id"))
        else:
            try:
                info_ = load_image(raw, it.get("mime"))
            except UnsupportedImage:
                log.warning("picture %s cannot be placed (not a usable PNG/JPEG); left out", it.get("id"))
                continue
            key = sha256_bytes(raw)
            asm.pictures[key] = (raw, info_)
            w, h = _box(info_, it["where"])
            blk.update(t="img", key=key, w_mm=w, h_mm=h, fit="CONTAIN")
        asm.picture_recs.append(rec)
        place.append({"block": blk, "section_id": it["section_id"], "where": it["where"], "scene": it.get("scene")})
    bookmod.place_pictures(asm.book["sections"], place)


def out_of_date(store, pid, branch, asm: dict) -> str | None:
    """book_path: why the assembled book's pictures differ from the Pictures page (plain words), or None."""
    if not asm.get("G01"):
        return None
    if (asm.get("pictures") or "") != signature(store, pid, branch):
        return ("The pictures changed since the book was put together (🖼 Pictures): put it together again so the "
                "files show them.")
    return None


# ====================================================================== book save
def save_files(app, pid, branch, files: dict, text) -> None:
    """Pictures/ in the book's folder: pictures.json + the chosen picture of each chapter / scene / the map."""
    d = doc(app.store, pid, branch)
    if not d["pictures"] and not d.get("style"):
        return
    numbers = {}
    try:
        for c in chapters(app, app.principal_id, pid, branch):
            numbers[c["chapter_id"]] = c["number"]
    except Exception:  # noqa: BLE001
        numbers = {}
    listing = {"style": d.get("style") or "", "pictures": []}
    for p in sorted(d["pictures"].values(), key=lambda p: p["id"]):
        pub = public_picture(pid, branch, p)
        entry = {k: pub[k] for k in ("id", "kind", "chapter_id", "scene", "caption", "alt", "placement", "chosen")}
        c = p.get("chosen")
        cands = p.get("candidates") or []
        if c is not None and c < len(cands):
            raw = forge.picture_bytes(app.store, pid, branch, cands[c])
            if raw:
                mime = cands[c].get("mime")
                ext = "svg" if mime == SVG_MIME else "jpg" if mime == "image/jpeg" else "png"
                if p["kind"] == "map":
                    name = f"Pictures/map.{ext}"
                else:
                    n = numbers.get(p.get("chapter_id"))
                    name = f"Pictures/ch{n:02d}" if n else f"Pictures/{p['id']}"
                    name += f" scene {p['scene']}" if p.get("scene") else ""
                    name += f" {p['id']}.{ext}"
                files[name] = raw
                entry["file"] = name.split("/", 1)[1]
                png = forge.picture_bytes(app.store, pid, branch, cands[c].get("png")) if mime == SVG_MIME else None
                if png and p["kind"] == "map":
                    files["Pictures/map.png"] = png  # 🖨 the Word copy AutoInjector drew
        listing["pictures"].append(entry)
    text("Pictures/pictures.json", json.dumps(listing, ensure_ascii=False, indent=1))


# ====================================================================== HTTP
def route(app, method: str, rest: list, query: dict, body, principal: str, pid: str, branch: str, headers):
    """/api/projects/:pid/branches/:b/pictures/… (one block in server.py)."""
    store = app.store
    if rest == [] and method == "GET":
        out = info(app, principal, pid, branch)
        try:
            from .book_path import BookPath  # noqa: PLC0415
            asm = BookPath(app.engine, principal, pid, branch).mem.get("assembly") or {}
            out["out_of_date"] = out_of_date(store, pid, branch, asm)
        except Exception:  # noqa: BLE001 - a notice only
            out["out_of_date"] = None
        return 200, out
    if rest == ["style"] and method == "PUT":
        return 200, set_style(store, pid, branch, body)
    if rest == ["prompt"] and method == "GET":
        cid = (query.get("chapter") or [""])[0]
        _known_chapter(chapters(app, principal, pid, branch), cid)
        out = prompt_for(app, principal, pid, branch, cid, _scene((query.get("scene") or [None])[0]))
        out.pop("context", None)
        return 200, out
    if rest == ["illustrate"] and method == "POST":
        return 202, start_illustrate(app, principal, pid, branch, body)
    if rest == ["illustrate-all"] and method == "POST":
        return 202, start_illustrate_all(app, principal, pid, branch, body)
    if rest == ["map"] and method == "POST":
        body = body if isinstance(body, dict) else {}
        kind = body.get("kind", "svg")
        if kind == "svg":
            return 200, make_svg_map(app, principal, pid, branch)
        if kind == "illustrated":
            return 202, start_map_illustrated(app, principal, pid, branch, body)
        if kind == "png":
            return 200, make_map_png(app, principal, pid, branch)
        raise _bad("/kind", "kind: svg (drawn from your places), illustrated (made by the picture maker) or png (the "
                   "Word copy of the drawn map)")
    if rest == ["upload"] and method == "PUT":
        return 200, upload(app, principal, pid, branch, query, body)
    if len(rest) == 2 and rest[0] == "jobs" and method == "GET":
        return 200, app.review.get_job(principal, rest[1])
    if len(rest) == 1 and method == "PUT":
        return 200, update(store, pid, branch, rest[0], body)
    if len(rest) == 1 and method == "DELETE":
        return 200, delete(store, pid, branch, rest[0])
    raise AkoweError("NOT_FOUND", "/pictures", "no such Pictures endpoint", **_REJ)
