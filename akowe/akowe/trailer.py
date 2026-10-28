"""🎞 Book trailers (plan item B2): a short trailer of the book — 5-8 video shots joined with title cards — made by
AutoInjector's 🎬 Video module (``POST /video/trailer``, docs/VIDEO_API.md "Trailers") and stored with the book.

**The plan** (``plan_from_book``): built from the book itself, never by an AI call, so it is instant and the author
edits it before anything is made. An opening title card (the title, the genre / author), an establishing shot of the
book's main place, shots of key chapters spread over the first four fifths of the book (never the ending: a trailer
does not spoil it) made from the scene card (where, when, who, the key moment — ``pictures.scene_context``), each
present character's approved look from the Character Forge dossier (``pictures.looks_of``) and the character lock of
the main character, a card with the logline (the premise), a shot of the main character (their portrait brought to
life when the dossier has one), and a closing card ("Coming soon"). A chapter that already has a chosen 🖼 picture uses
it: that shot brings the picture to life (picture→video). 5-8 shots in all.

**The model.** Companion data like the pictures: settings key ``trailer:<project>:<branch>`` =
``{"revision", "plan": {"items": [item], "music", "made_from", "updated_at"}, "trailer": {...} | None}``. An item is a
title card ``{"type": "card", "text", "subtitle", "seconds"}`` or a shot ``{"type": "shot", "prompt", "seconds",
"character", "picture": {"kind": "chapter"|"portrait", "id"} | None, "label"}``. The made trailer is a book asset
(WebM, plus the MP4 when AutoInjector had ffmpeg): ``{"webm": asset, "mp4": asset | None, "seconds", "width",
"height", "shots", "at", "warnings"}``.

**Make the trailer** (``start_make``, a background job polled like every job: GET /review/ai/:id): the pictures go to
temp files AutoInjector can read, ``POST /video/trailer`` starts it there, ``GET /video/trailer?id=`` is followed
every few seconds (the job's phase says which shot AutoInjector is making), Stop sends ``POST /video/trailer/cancel``.
AutoInjector keeps the shots it made, so making it again continues where it stopped. A character lock AutoInjector
does not have (``NO_LOCK``) is left out of that shot and the trailer continues. Every ``VIDEO_*`` code becomes plain
words with what to do (``PROBLEMS``). The finished trailer.webm / trailer.mp4 are read from AutoInjector's folder
(the same computer) and stored with the book; the book save writes ``Trailer/`` (book_save.py).

Prompts and video bytes are never logged.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from . import forge
from . import pictures
from .errors import AkoweError

log = logging.getLogger("akowe.trailer")

MIN_SHOTS, MAX_SHOTS = 5, 8
MAX_ITEMS = 24
SHOT_SECONDS = (1.0, 5.0)
CARD_SECONDS = (1.0, 10.0)
PROMPT_MAX = 1200
TEXT_MAX = 120
SUB_MAX = 160
LABEL_MAX = 120
MAX_TRAILER_BYTES = 200 * 1024 * 1024
POLL_S = 2.0            # how often AutoInjector is asked how far it is (tests set it lower)
START_TIMEOUT_S = 120.0
TRAILER_TIMEOUT_S = 8 * 3600.0
MUSIC_EXT = (".mp3", ".ogg", ".oga", ".opus", ".wav", ".m4a", ".aac", ".flac", ".webm")
CINEMA = "Cinematic book-trailer shot, film lighting, slow camera movement, shallow depth of field."
NO_TEXT = "No text, letters, captions or watermark."
_LOCK = threading.RLock()
_REJ = {"status": "REJECTED"}

# Every code AutoInjector (or the way there) can answer with, in plain words: (what happened, what to do).
PROBLEMS = {
    "VIDEO_NOT_SET_UP": ("AutoInjector cannot make video yet", "In AutoInjector's 🎬 Video tab, set up video (one "
                         "click: ComfyUI + the video model), then press Make the trailer again."),
    "VIDEO_MODEL_MISSING": ("The video model is not downloaded yet", "In AutoInjector's 🎬 Video tab → Setup, "
                            "download the video model (one click), then press Make the trailer again."),
    "VIDEO_OOM": ("The graphics card ran out of memory", "Close other programs that use the graphics card (Stable "
                  "Diffusion too), then press Make the trailer again: the shots already made are kept."),
    "VIDEO_TIMEOUT": ("A shot took too long", "Press Make the trailer again: the shots already made are kept, and the "
                      "first shot after a start loads the video model, which is slow."),
    "VIDEO_CANCELLED": ("The trailer was stopped in AutoInjector", "Press Make the trailer again when you are ready: "
                        "the shots already made are kept."),
    "VIDEO_FAILED": ("A shot could not be made", "Press Make the trailer again (the shots already made are kept). If "
                     "the same shot fails again, change its description or remove it."),
    "UNSUPPORTED_ON_BACKEND": ("This video maker cannot bring a picture to life", "In AutoInjector's 🎬 Video tab, "
                               "switch to the built-in ComfyUI video, or remove the picture from that shot."),
    "VIDEO_NOT_WIRED": ("This AutoInjector cannot make trailers", "Update AutoInjector to a version with 🎬 Video → "
                        "🎞 Trailer."),
    "VIDEO_BAD_ANSWER": ("No usable trailer came back", "Press Make the trailer again. If it repeats, open "
                         "AutoInjector's 🎬 Video → 🎞 Trailer and look at the trailer there."),
    "TRAILER_JOIN_FAILED": ("The shots were made, but joining them failed", "Press Make the trailer again: the shots "
                            "are kept and only the joining is done again."),
    "BUSY": ("AutoInjector is already making a trailer", "Wait until it is finished (🎬 Video → 🎞 Trailer shows it), "
             "then press Make the trailer again."),
    "INVALID_PARAM": ("AutoInjector did not accept the trailer plan", "Check the shots and title cards (each shot "
                      "needs a description or a picture), then try again."),
    "NO_LOCK": ("No character lock", "Make a character lock in AutoInjector → 🎨 Images → 🔒 Character locks."),
    "IMAGE_BRIDGE_UNREACHABLE": ("AutoInjector cannot be reached", "Start the AutoInjector desktop app (its bridge "
                                 "must be on). Check Settings → Pictures for the bridge address."),
    "IMAGE_BRIDGE_KEY": ("AutoInjector did not accept the key", "Copy the bridge token from AutoInjector and paste it "
                         "into Settings → Pictures."),
    "TRAILER_LOST": ("AutoInjector restarted while making the trailer", "Press Make the trailer again: the shots "
                     "already made are kept and reused."),
}


class TrailerProblem(Exception):
    def __init__(self, code: str, message: str = "", shot: int | None = None, detail: str = ""):
        super().__init__(code)
        title, fix = PROBLEMS.get(code, ("The trailer could not be made", "Press Make the trailer again."))
        self.code = code
        msg = message or title
        if shot and not msg.lower().startswith("shot"):
            msg = f"Shot {shot}: {msg}"
        if detail and detail not in msg:
            msg = f"{msg} ({detail})"
        self.message, self.fix, self.shot = msg[:400], fix, shot

    def as_error(self) -> dict:
        out = {"code": self.code, "message": self.message, "fix": self.fix, "path": ""}
        if self.shot:
            out["shot"] = self.shot
        return out


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _clip(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n]


def _bad(path: str, msg: str, code: str = "INVALID_INPUT") -> AkoweError:
    return AkoweError(code, path, msg, **_REJ)


def _key(pid: str, branch: str) -> str:
    return f"trailer:{pid}:{branch}"


def _empty() -> dict:
    return {"revision": 0, "plan": None, "trailer": None}


def doc(store, pid: str, branch: str) -> dict:
    d = store.get_setting(_key(pid, branch))
    if not isinstance(d, dict):
        return _empty()
    out = _empty()
    out.update(d)
    return out


def _mutate(store, pid, branch, fn):
    with _LOCK:
        d = copy.deepcopy(doc(store, pid, branch))
        out = fn(d)
        d["revision"] = int(d.get("revision") or 0) + 1
        store.set_setting(_key(pid, branch), d)
        return out if out is not None else d


# ====================================================================== the plan from the book
def _profile(app, pid) -> dict:
    try:
        from .book_path import get_profile  # noqa: PLC0415
        return get_profile(app.store, pid) or {}
    except Exception:  # noqa: BLE001
        return {}


def logline(app, principal, pid, branch) -> str:
    """The book in one line: the approved premise (B01), else the blurb's first sentence, else the idea."""
    text = ""
    try:
        bp = pictures._bp(app, principal, pid, branch)  # noqa: SLF001 - the one BookPath helper
        a = bp.approved("B01")
        data = (a[0].get("data") or {}) if a else {}
        text = data.get("premise") or data.get("logline") or data.get("concept_summary") or ""
    except Exception:  # noqa: BLE001 - a plan without a logline card is still a plan
        text = ""
    prof = _profile(app, pid)
    text = text or prof.get("blurb") or prof.get("idea") or ""
    text = " ".join(str(text).split())
    m = re.match(r"(.{20,}?[.!?])(\s|$)", text)
    return pictures._fit(m.group(1) if m else text, TEXT_MAX)  # noqa: SLF001


def _chosen_chapter_picture(app, pid, branch, chapter_id) -> str | None:
    """The pic_id of a chapter's chosen 🖼 picture (the whole-chapter one first), or None."""
    try:
        d = pictures.doc(app.store, pid, branch)
    except Exception:  # noqa: BLE001
        return None
    best = None
    for p in d.get("pictures", {}).values():
        if p.get("kind") != "chapter" or p.get("chapter_id") != chapter_id or p.get("chosen") is None:
            continue
        if p.get("scene") is None:
            return p["id"]
        best = best or p["id"]
    return best


def _portrait(app, pid, branch, rid) -> bool:
    try:
        art = forge.raw_entry(app.store, pid, branch, rid).get("art") or {}
    except Exception:  # noqa: BLE001
        return False
    return bool(art.get("portrait") or (art.get("views") or {}).get("front"))


def shot_prompt(ctx: dict, looks: dict, style: str, *, extra: str = "") -> str:
    """A cinematic shot from a scene: the moment, the place and time, each present character's approved look (≤
    PROMPT_MAX). ``looks`` = {name: look text}."""
    style = _clip(style, 120)
    head = CINEMA + (f" Art style: {style}." if style else "")
    moment = pictures._fit(ctx.get("moment") or "", 300)  # noqa: SLF001
    setting = ", ".join(x for x in (pictures._fit(ctx.get("place") or "", 140),  # noqa: SLF001
                                     pictures._fit(ctx.get("time") or "", 70)) if x)  # noqa: SLF001
    fixed = [head, f"{moment}." if moment else "", f"Setting: {setting}." if setting else "", extra, NO_TEXT]
    room = PROMPT_MAX - sum(len(x) + 1 for x in fixed if x) - 16
    people = [c["name"] for c in ctx.get("characters") or []][:3]
    chars = ""
    if people and room > 40:
        each = max(40, room // len(people))
        bits = [pictures._fit(f"{n} ({looks[n]})" if looks.get(n) else n, each - 2) for n in people]  # noqa: SLF001
        chars = pictures._fit("Characters: " + "; ".join(bits), room + 12) + "."  # noqa: SLF001
    extra = f"{extra.rstrip('.')}." if extra else ""
    parts = [fixed[0], fixed[1], fixed[2], chars, extra, fixed[4]]
    return pictures._fit(" ".join(p for p in parts if p), PROMPT_MAX)  # noqa: SLF001


def _key_chapters(chs: list[dict], want: int) -> list[dict]:
    """Up to ``want`` chapters spread over the first four fifths of the book (the ending is not shown)."""
    if not chs:
        return []
    cut = max(1, min(len(chs) - 1, (len(chs) * 4 + 4) // 5)) if len(chs) >= 3 else len(chs)
    pool = chs[:cut]
    if len(pool) <= want:
        return pool
    step = (len(pool) - 1) / max(1, want - 1)
    picked, seen = [], set()
    for i in range(want):
        c = pool[round(i * step)]
        if c["chapter_id"] not in seen:
            seen.add(c["chapter_id"])
            picked.append(c)
    return picked


def plan_from_book(app, principal, pid, branch) -> dict:
    """The trailer plan built from the book (no AI call): {items, made_from, notes}."""
    chs = pictures.chapters(app, principal, pid, branch)
    if not chs:
        raise _bad("/plan", "plan the chapters first (📘 Make my book → chapter outline): the trailer's shots come "
                   "from the chapters' scenes", "MISSING_INPUT")
    prof = _profile(app, pid)
    title = _clip(prof.get("title") or "", TEXT_MAX) or "Untitled"
    style = pictures.doc(app.store, pid, branch).get("style") or ""
    notes: list[str] = []
    shots: list[dict] = []
    ctxs = []
    for ch in _key_chapters(chs, MAX_SHOTS - 2):
        try:
            ctxs.append((ch, pictures.scene_context(app, principal, pid, branch, ch["chapter_id"], None)))
        except AkoweError:
            continue
    looks_cache: dict = {}

    def looks(ctx):
        for c in ctx["characters"]:
            if c["name"] not in looks_cache:
                looks_cache[c["name"]] = pictures.looks_of(app.store, pid, branch, c["record_id"])
        return {c["name"]: looks_cache[c["name"]] for c in ctx["characters"]}

    # the main character: the first chapter's point of view, else the first character met
    main = None
    for _ch, ctx in ctxs:
        if ctx.get("pov"):
            main = next((c for c in ctx["characters"] if c["name"] == ctx["pov"]), None) or main
            if main:
                break
    if main is None:
        main = next((ctx["characters"][0] for _ch, ctx in ctxs if ctx["characters"]), None)
    # 1. establishing shot: the book's main place (the first chapter's, else the first place)
    place = next((ctx["place"] for _ch, ctx in ctxs if ctx.get("place")), "")
    if not place:
        pl = pictures._places(app.store, pid, branch)  # noqa: SLF001
        place = pl[0]["name"] if pl else ""
    if place:
        shots.append({"type": "shot", "seconds": 5.0, "character": None, "picture": None,
                      "label": f"The world: {_clip(place, 80)}",
                      "prompt": shot_prompt({"place": place, "moment": f"An establishing shot of {place}, no people, "
                                             "the mood of the whole book"}, {}, style)})
    # 2. key chapters (their chosen picture brought to life when there is one)
    for ch, ctx in ctxs:
        pic = _chosen_chapter_picture(app, pid, branch, ch["chapter_id"])
        lock = ctx["pov"] if ctx.get("pov") and any(c["name"] == ctx["pov"] for c in ctx["characters"]) else \
            (ctx["characters"][0]["name"] if ctx["characters"] else None)
        shots.append({"type": "shot", "seconds": 4.0, "character": None if pic else lock,
                      "picture": {"kind": "chapter", "id": pic} if pic else None,
                      "label": _clip(f"Chapter {ch['number']}" + (f": {ch['title']}" if ch.get("title") else ""),
                                     LABEL_MAX),
                      "prompt": shot_prompt(ctx, looks(ctx), style, extra="" if not pic else
                                            "The picture comes to life: gentle motion, the camera drifts.")})
    # 3. the main character, close
    if main is not None:
        has = _portrait(app, pid, branch, main["record_id"])
        look = looks_cache.get(main["name"]) or pictures.looks_of(app.store, pid, branch, main["record_id"])
        shots.insert(min(len(shots), 3), {
            "type": "shot", "seconds": 4.0, "character": None if has else main["name"],
            "picture": {"kind": "portrait", "id": main["record_id"]} if has else None,
            "label": _clip(f"{main['name']}, close", LABEL_MAX),
            "prompt": shot_prompt({"moment": f"Close-up of {main['name']} looking up, a decision in their eyes, wind "
                                   "and light moving", "characters": [main]}, {main["name"]: look}, style)})
    # 5-8 shots: pad with the other characters (close), then more scenes of the same chapters (never the ending's
    # chapter), then another angle of a shot already there
    if len(shots) < MIN_SHOTS:
        seen = {main["name"]} if main else set()
        for _ch, ctx in ctxs:
            for c in ctx["characters"]:
                if len(shots) >= MIN_SHOTS or c["name"] in seen:
                    continue
                seen.add(c["name"])
                look = looks_cache.get(c["name"]) or pictures.looks_of(app.store, pid, branch, c["record_id"])
                shots.append({"type": "shot", "seconds": 4.0, "character": c["name"], "picture": None,
                              "label": _clip(f"{c['name']}, close", LABEL_MAX),
                              "prompt": shot_prompt({"moment": f"Close-up of {c['name']}, turning towards the camera, "
                                                     "something unsaid", "characters": [c]}, {c["name"]: look}, style)})
    for ch, _ctx in ctxs:
        for card in ch.get("cards") or []:
            if len(shots) >= MIN_SHOTS:
                break
            if card["scene"] < 2:
                continue
            try:
                ctx = pictures.scene_context(app, principal, pid, branch, ch["chapter_id"], card["scene"])
            except AkoweError:
                continue
            shots.append({"type": "shot", "seconds": 4.0, "character": ctx["pov"], "picture": None,
                          "label": _clip(f"Chapter {ch['number']}, scene {card['scene']}", LABEL_MAX),
                          "prompt": shot_prompt(ctx, looks(ctx), style)})
    k = 0
    while len(shots) < MIN_SHOTS and shots and k < MAX_SHOTS:
        base = shots[1 + k % max(1, len(shots) - 1)] if len(shots) > 1 else shots[0]
        k += 1
        shots.append(dict(base, label=_clip(f"{base['label']} (another angle)", LABEL_MAX), picture=None,
                          prompt=pictures._fit(base["prompt"].replace(CINEMA, CINEMA + " Another angle, wider.", 1),  # noqa: SLF001
                                               PROMPT_MAX)))
    if len(shots) < MIN_SHOTS:
        notes.append("The book has little to show yet: add shots yourself, or write the scene cards first.")
    shots = shots[:MAX_SHOTS]
    # the cards
    sub = " · ".join(x for x in (_clip(prof.get("genre"), 60), f"by {_clip(prof.get('author'), 60)}" if
                                 prof.get("author") else "") if x)
    items = [{"type": "card", "text": title, "subtitle": _clip(sub, SUB_MAX), "seconds": 3.0}]
    line = logline(app, principal, pid, branch)
    for i, s in enumerate(shots):
        items.append(s)
        if line and i == min(1, len(shots) - 1):
            items.append({"type": "card", "text": line, "subtitle": "", "seconds": 3.5})
    items.append({"type": "card", "text": title, "subtitle": "Coming soon", "seconds": 3.0})
    if not line:
        notes.append("No premise yet, so there is no logline card (approve the premise, or write a blurb on the "
                     "🎨 Cover page).")
    return {"items": items, "made_from": "book", "notes": notes}


# ====================================================================== checking the author's plan
def _seconds(v, lo_hi, path, default):
    if v in (None, ""):
        return default
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise _bad(path, f"seconds: a number {lo_hi[0]:g}-{lo_hi[1]:g}")
    if not lo_hi[0] <= v <= lo_hi[1]:
        raise _bad(path, f"seconds: {lo_hi[0]:g}-{lo_hi[1]:g} (got {v:g})")
    return float(v)


def clean_plan(app, pid, branch, body) -> dict:
    """The author's plan, checked: {items, music}."""
    body = body if isinstance(body, dict) else {}
    items = body.get("items")
    if not isinstance(items, list) or not items:
        raise _bad("/items", "items: the shots and title cards, in order (at least one)")
    if len(items) > MAX_ITEMS:
        raise _bad("/items", f"a trailer has at most {MAX_ITEMS} shots and title cards")
    out = []
    for i, it in enumerate(items):
        p = f"/items/{i}"
        if not isinstance(it, dict) or it.get("type") not in ("shot", "card"):
            raise _bad(f"{p}/type", "each item is a shot or a title card (type: shot or card)")
        if it["type"] == "card":
            text = _clip(it.get("text"), TEXT_MAX + 1)
            if not text:
                raise _bad(f"{p}/text", f"title card {i + 1} needs its text")
            if len(text) > TEXT_MAX:
                raise _bad(f"{p}/text", f"a title card's text is at most {TEXT_MAX} characters")
            out.append({"type": "card", "text": text, "subtitle": _clip(it.get("subtitle"), SUB_MAX),
                        "seconds": _seconds(it.get("seconds"), CARD_SECONDS, f"{p}/seconds", 3.0)})
            continue
        prompt = str(it.get("prompt") or "").strip()
        if len(prompt) > PROMPT_MAX:
            raise _bad(f"{p}/prompt", f"a shot's description is at most {PROMPT_MAX} characters")
        pic = it.get("picture")
        if pic not in (None, ""):
            if not isinstance(pic, dict) or pic.get("kind") not in ("chapter", "portrait") or \
                    not isinstance(pic.get("id"), str) or not pic["id"]:
                raise _bad(f"{p}/picture", "picture: a chosen chapter picture or a character's portrait")
            pic = {"kind": pic["kind"], "id": pic["id"][:80]}
        else:
            pic = None
        character = _clip(it.get("character"), 120) or None
        if not prompt and not pic and not character:
            raise _bad(f"{p}/prompt", f"shot {sum(1 for x in out if x['type'] == 'shot') + 1} needs a description "
                       "(what happens) or a picture")
        out.append({"type": "shot", "prompt": prompt, "seconds": _seconds(it.get("seconds"), SHOT_SECONDS,
                                                                          f"{p}/seconds", 4.0),
                    "character": character, "picture": pic, "label": _clip(it.get("label"), LABEL_MAX)})
    music = body.get("music")
    if music not in (None, ""):
        if not isinstance(music, str) or not music.lower().endswith(MUSIC_EXT):
            raise _bad("/music", "music: the full path of a music file (.mp3, .ogg, .wav, .m4a, .flac …) on this "
                       "computer, or leave it empty")
        if not os.path.isfile(music):
            raise _bad("/music", f"the music file {music} was not found on this computer")
    else:
        music = None
    return {"items": out, "music": music}


def save_plan(app, pid, branch, body, made_from: str = "author") -> dict:
    plan = clean_plan(app, pid, branch, body)

    def fn(d):
        d["plan"] = dict(plan, made_from=made_from, updated_at=_now())
    _mutate(app.store, pid, branch, fn)
    return info(app, pid, branch)


# ====================================================================== the public page data
def _asset_public(pid, branch, a):
    if not isinstance(a, dict) or not a.get("asset_id"):
        return None
    out = {k: a.get(k) for k in ("asset_id", "version", "mime", "bytes", "at") if a.get(k) is not None}
    out["url"] = f"/api/projects/{pid}/branches/{branch}/assets/{a['asset_id']}/{a.get('version') or 1}"
    return out


def info(app, pid, branch) -> dict:
    d = doc(app.store, pid, branch)
    t = d.get("trailer")
    plan = d.get("plan")
    shots = sum(1 for x in (plan or {}).get("items") or [] if x.get("type") == "shot")
    out = {"revision": d.get("revision", 0), "plan": plan, "shots": shots,
           "seconds": round(sum(float(x.get("seconds") or 0) for x in (plan or {}).get("items") or []), 2),
           "trailer": None, "limits": {"shots": [MIN_SHOTS, MAX_SHOTS], "items": MAX_ITEMS, "shot_seconds": SHOT_SECONDS,
                                       "card_seconds": CARD_SECONDS}}
    if isinstance(t, dict):
        out["trailer"] = {k: t.get(k) for k in ("seconds", "width", "height", "at", "warnings", "shots", "cards",
                                                "planned", "plan_revision") if t.get(k) is not None}
        out["trailer"]["webm"] = _asset_public(pid, branch, t.get("webm"))
        out["trailer"]["mp4"] = _asset_public(pid, branch, t.get("mp4"))
        out["out_of_date"] = bool(plan and t.get("plan_at") and plan.get("updated_at") and
                                  plan["updated_at"] > t["plan_at"])
    try:
        out["bridge"] = forge.bridge_info(app)
    except Exception:  # noqa: BLE001
        out["bridge"] = None
    return out


# ====================================================================== making it (AutoInjector POST /video/trailer)
def _bridge(app):
    targets = forge.bridge_targets(app)
    if not targets:
        raise TrailerProblem("IMAGE_BRIDGE_UNREACHABLE", "no local AutoInjector address is set")
    return targets


def _call(app, targets, method, route, body=None, timeout_s=30.0):
    """One call to the first AutoInjector that answers (the next one is tried only when one is not reachable / has
    no trailer route). -> (answer, the target that answered)."""
    last = None
    for url, token in targets:
        try:
            return forge._post(url, token, body or {}, timeout_s, route=route, method=method), (url, token)  # noqa: SLF001
        except forge.ArtProblem as exc:
            if exc.code not in ("IMAGE_BRIDGE_UNREACHABLE", "VIDEO_NOT_WIRED"):
                raise
            last = exc
    raise last


def _problem(exc: forge.ArtProblem, shot=None) -> TrailerProblem:
    """AutoInjector's answer → the trailer's plain words (its own message is kept as the detail for VIDEO_FAILED)."""
    code = exc.code if exc.code in PROBLEMS else ("VIDEO_FAILED" if exc.code.startswith("VIDEO") or
                                                  exc.code.startswith("HTTP_") else exc.code)
    first = next((ln.strip() for ln in str(exc.message or "").splitlines() if ln.strip()), "")
    if first.lower().startswith("shot ") and ":" in first:
        first = first.split(":", 1)[1].strip()
    if code in ("VIDEO_FAILED", "TRAILER_JOIN_FAILED", "IMAGE_BRIDGE_UNREACHABLE", "VIDEO_BAD_ANSWER") and first:
        title = PROBLEMS[code][0]
        msg = f"{title} — {first}" if first and first != title else title
    else:
        msg = ""
    tp = TrailerProblem(code, msg, shot=shot)
    if code == "VIDEO_MODEL_MISSING" and exc.model:
        tp.message = f"{tp.message} (model {exc.model})"
    return tp


def _picture_file(app, pid, branch, pic: dict, tmpdir: str) -> str | None:
    """A shot's picture (a chosen chapter picture / a portrait) as a temp file AutoInjector can read, or None."""
    data = None
    try:
        if pic["kind"] == "chapter":
            p = pictures.doc(app.store, pid, branch)["pictures"].get(pic["id"])
            c = p.get("chosen") if p else None
            cands = (p or {}).get("candidates") or []
            if c is not None and c < len(cands) and cands[c].get("mime") in ("image/png", "image/jpeg"):
                data = forge.picture_bytes(app.store, pid, branch, cands[c])
        else:
            art = forge.raw_entry(app.store, pid, branch, pic["id"]).get("art") or {}
            data = forge.picture_bytes(app.store, pid, branch, art.get("portrait") or (art.get("views") or {}).get("front"))
    except Exception:  # noqa: BLE001 - the shot is made from its words instead
        data = None
    if not data:
        return None
    ext = ".jpg" if data[:3] == b"\xff\xd8\xff" else ".png"
    safe = re.sub(r"[^A-Za-z0-9_-]", "", pic["id"])[:40]
    path = os.path.join(tmpdir, f"{pic['kind']}-{safe}{ext}")
    with open(path, "wb") as fh:
        fh.write(data)
    return path


def _read_local(path, limit) -> bytes | None:
    try:
        fp = Path(str(path))
        if fp.is_file() and fp.stat().st_size <= limit:
            return fp.read_bytes()
    except (OSError, ValueError):
        pass
    return None


def _job(app, principal, pid, branch, total):
    from .review import ReviewJob  # noqa: PLC0415

    class TrailerJob(ReviewJob):
        def public(self):
            out = super().public()
            out["total"] = self.total
            out["shot"] = getattr(self, "shot", 0)
            out["stage"] = getattr(self, "stage", "")
            return out
    j = TrailerJob("trailer", principal, pid, branch, [], None)
    j.total = total
    return j


def start_make(app, principal, pid, branch, body) -> dict:
    """POST …/trailer/make {items?, music?} -> 202 job. Without items the saved plan is made (planned from the book
    first when there is none)."""
    body = body if isinstance(body, dict) else {}
    if not app.store.has_scope(principal, pid, branch, "I01:create"):
        raise AkoweError("PERMISSION_DENIED", "", "missing scope I01:create", **_REJ)
    if body.get("items"):
        save_plan(app, pid, branch, body)
    d = doc(app.store, pid, branch)
    if not d.get("plan"):
        p = plan_from_book(app, principal, pid, branch)
        save_plan(app, pid, branch, {"items": p["items"]}, made_from="book")
        d = doc(app.store, pid, branch)
    plan = copy.deepcopy(d["plan"])
    shots = [x for x in plan["items"] if x["type"] == "shot"]
    job = _job(app, principal, pid, branch, len(shots))
    title = _clip(_profile(app, pid).get("title") or "", 200) or "Untitled"

    def fn(j):
        tmpdir = tempfile.mkdtemp(prefix="akowe-trailer-")
        try:
            run_make(app, j, pid, branch, plan, title, tmpdir)
        except TrailerProblem as exc:
            j.status, j.phase, j.error = "error", "Failed", exc.as_error()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
    return app.review._start(job, fn)  # noqa: SLF001


def _request_items(app, pid, branch, plan, tmpdir, warnings) -> list[dict]:
    out = []
    n = 0
    for it in plan["items"]:
        if it["type"] == "card":
            out.append({"type": "card", "text": it["text"], "subtitle": it.get("subtitle") or None,
                        "seconds": it["seconds"]})
            continue
        n += 1
        shot = {"type": "shot", "seconds": it["seconds"]}
        if it.get("prompt"):
            shot["prompt"] = it["prompt"]
        if it.get("picture"):
            f = _picture_file(app, pid, branch, it["picture"], tmpdir)
            if f:
                shot["image"] = f
            else:
                warnings.append(f"Shot {n}: its picture is gone, so it is made from its description")
        if it.get("character") and "image" not in shot:
            shot["characterLock"] = it["character"]
        if "prompt" not in shot and "image" not in shot and "characterLock" not in shot:
            shot["prompt"] = it.get("label") or "a quiet moment from the book"
        out.append({k: v for k, v in shot.items() if v is not None})
    return [{k: v for k, v in x.items() if v is not None} for x in out]


def run_make(app, job, pid, branch, plan, title, tmpdir) -> None:
    from .assist import Cancelled  # noqa: PLC0415
    targets = _bridge(app)
    warnings: list[str] = []
    items = _request_items(app, pid, branch, plan, tmpdir, warnings)
    n_shots = sum(1 for x in items if x["type"] == "shot")
    body = {"book": title, "title": title, "items": items, "from": "akowe-trailer", "width": 1280, "height": 720}
    if plan.get("music"):
        body["music"] = plan["music"]
    job.stage = "starting"
    job.phase = "Asking AutoInjector to make the trailer"
    started = time.time()
    for attempt in range(n_shots + 2):  # a missing character lock: that shot without it, then on (shots are kept)
        job.check()
        try:
            resp, target = _call(app, targets, "POST", "/video/trailer", body, START_TIMEOUT_S)
        except forge.ArtProblem as exc:
            raise _problem(exc) from None
        tid = resp.get("id")
        if not tid and resp.get("ok") and resp.get("path"):  # an AutoInjector that answered with the finished trailer
            return _store(app, job, pid, branch, plan, resp, warnings)
        if not tid:
            raise TrailerProblem("VIDEO_BAD_ANSWER", "AutoInjector did not say which trailer it started")
        result = _follow(app, job, [target], tid, n_shots, started)
        if result.get("ok"):
            return _store(app, job, pid, branch, plan, result, warnings)
        code = str(result.get("error") or result.get("code") or "VIDEO_FAILED")
        shot = result.get("shot") if isinstance(result.get("shot"), int) else None
        if code == "NO_LOCK" and shot and 1 <= shot <= n_shots:
            k = [i for i, x in enumerate(items) if x["type"] == "shot"][shot - 1]
            lock = items[k].pop("characterLock", None)
            if lock:
                warnings.append(f"Shot {shot}: AutoInjector has no character lock named {lock}, so it was made "
                                "without one")
                if not items[k].get("prompt") and not items[k].get("image"):
                    items[k]["prompt"] = f"{lock}, a quiet moment from the book"
                continue
        if code == "VIDEO_CANCELLED" and job.cancelled:
            raise Cancelled()
        raise _problem(forge.ArtProblem(code, str(result.get("message") or ""), "", str(result.get("model") or "")),
                       shot=shot)
    raise TrailerProblem("VIDEO_FAILED", "the trailer could not be started")


def _follow(app, job, targets, tid, n_shots, started) -> dict:
    """Follow AutoInjector's trailer until it is finished -> its result. Stop → POST /video/trailer/cancel."""
    from .assist import Cancelled  # noqa: PLC0415
    misses = 0
    while True:
        try:
            job.check()
        except Cancelled:
            try:
                _call(app, targets, "POST", "/video/trailer/cancel", {}, 15.0)
            except forge.ArtProblem:
                pass
            raise
        if time.time() - started > TRAILER_TIMEOUT_S:
            raise TrailerProblem("VIDEO_TIMEOUT", "the trailer took more than 8 hours")
        try:
            st, _t = _call(app, targets, "GET", f"/video/trailer?id={tid}", None, 30.0)
            misses = 0
        except forge.ArtProblem as exc:
            if exc.code == "VIDEO_NOT_WIRED":  # 404: AutoInjector no longer knows this trailer
                raise TrailerProblem("TRAILER_LOST") from None
            misses += 1
            if exc.code == "IMAGE_BRIDGE_UNREACHABLE" and misses < 15:  # a short hiccup: keep following
                _sleep(job, POLL_S)
                continue
            raise _problem(exc) from None
        s = st.get("status") or {}
        job.shot = int(s.get("shot") or 0)
        job.done = int(s.get("shotsDone") or 0)
        job.stage = str(s.get("phase") or "")
        if job.stage == "shots":
            job.phase = (f"AutoInjector is making shot {max(1, min(job.shot, n_shots))} of {n_shots} — a shot takes "
                         "a few minutes")
        elif job.stage == "joining":
            job.phase = "AutoInjector is joining the shots and title cards"
        elif job.stage == "mp4":
            job.phase = "AutoInjector is making the MP4 copy"
        if not st.get("busy") and s.get("busy") is not True:
            res = st.get("result")
            if isinstance(res, dict):
                return res
            raise TrailerProblem("VIDEO_BAD_ANSWER", "AutoInjector finished without a result")
        _sleep(job, POLL_S)


def _sleep(job, s):
    end = time.time() + s
    while time.time() < end:
        if job.cancelled:
            return
        time.sleep(min(0.1, max(0.0, end - time.time())))


def _store(app, job, pid, branch, plan, res, warnings) -> None:
    job.phase = "Storing the trailer with the book"
    webm = _read_local(res.get("path"), MAX_TRAILER_BYTES + 1)
    if not webm:
        raise TrailerProblem("VIDEO_BAD_ANSWER", "Akọwe could not read the trailer file AutoInjector made")
    if len(webm) > MAX_TRAILER_BYTES:
        raise TrailerProblem("VIDEO_BAD_ANSWER", f"the trailer is larger than {MAX_TRAILER_BYTES // (1024 * 1024)} MB")
    if forge.sniff_video(webm) is None:
        raise TrailerProblem("VIDEO_BAD_ANSWER", "the trailer is not a WebM or MP4 file")
    mp4 = _read_local(res.get("mp4"), MAX_TRAILER_BYTES) if res.get("mp4") else None
    if mp4 is not None and forge.sniff_video(mp4) != "video/mp4":
        mp4 = None
    principal = job.principal
    a_webm = forge._store_asset(app.store, principal, pid, branch, webm, forge.sniff_video(webm),  # noqa: SLF001
                                "Book trailer")
    a_webm["bytes"] = len(webm)
    a_mp4 = None
    if mp4:
        a_mp4 = forge._store_asset(app.store, principal, pid, branch, mp4, "video/mp4", "Book trailer (MP4)")  # noqa: SLF001
        a_mp4["bytes"] = len(mp4)
    for w in res.get("warnings") or []:
        m = w.get("message") if isinstance(w, dict) else w
        if m:
            warnings.append(str(m)[:200])
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else None  # noqa: E731
    rec = {"webm": a_webm, "mp4": a_mp4, "seconds": num(res.get("seconds")), "planned": num(res.get("planned")),
           "width": num(res.get("width")), "height": num(res.get("height")), "at": _now(),
           "shots": len(res.get("shots") or []), "cards": len(res.get("cards") or []),
           "warnings": warnings[:10] or None, "plan_at": plan.get("updated_at")}

    def fn(d):
        d["trailer"] = {k: v for k, v in rec.items() if v is not None}
    _mutate(app.store, pid, branch, fn)
    job.done = job.total
    reused = res.get("reused") or 0
    job.results.append({"ok": True, "seconds": rec["seconds"], "mp4": bool(a_mp4),
                        "message": f"Trailer made ({rec['seconds']} s) and stored with the book."
                                   + (f" {reused} shot(s) were kept from before." if reused else "")})


# ====================================================================== book save
def save_files(app, pid, branch, files: dict, text) -> None:
    """Trailer/ in the book's folder: trailer.webm (+ trailer.mp4) and trailer.json (the plan)."""
    d = doc(app.store, pid, branch)
    if not d.get("plan") and not d.get("trailer"):
        return
    t = d.get("trailer") or {}
    listing = {"plan": d.get("plan"), "trailer": None}
    if t:
        listing["trailer"] = {k: t.get(k) for k in ("seconds", "width", "height", "at", "shots", "cards")}
        for key, name in (("webm", "trailer.webm"), ("mp4", "trailer.mp4")):
            raw = forge.picture_bytes(app.store, pid, branch, t.get(key))
            if raw:
                files[f"Trailer/{name}"] = raw
                listing["trailer"][key] = name
    text("Trailer/trailer.json", json.dumps(listing, ensure_ascii=False, indent=1))


# ====================================================================== HTTP
def route(app, method: str, rest: list, query: dict, body, principal: str, pid: str, branch: str, headers):
    """/api/projects/:pid/branches/:b/trailer/… (one block in server.py)."""
    if rest == [] and method == "GET":
        return 200, info(app, pid, branch)
    if rest == ["plan"] and method == "POST":  # "Plan a trailer": from the book (replaces the plan)
        p = plan_from_book(app, principal, pid, branch)
        out = save_plan(app, pid, branch, {"items": p["items"], "music": (doc(app.store, pid, branch).get("plan") or {})
                                           .get("music")}, made_from="book")
        out["notes"] = p["notes"]
        return 200, out
    if rest == ["plan"] and method == "PUT":  # the author's edits
        return 200, save_plan(app, pid, branch, body)
    if rest == ["make"] and method == "POST":
        return 202, start_make(app, principal, pid, branch, body)
    if len(rest) == 2 and rest[0] == "jobs" and method == "GET":
        return 200, app.review.get_job(principal, rest[1])
    raise AkoweError("NOT_FOUND", "/trailer", "no such Trailer endpoint", **_REJ)
