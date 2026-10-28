"""🎨 Book covers (plan item B3, lane A): the cover designer behind the 🎨 Cover page (``#/p/<pid>/<b>/cover``).

**The design** (settings ``cover:<pid>:<branch>``, one per book branch) is plain JSON: a template (``exporters.cover
.TEMPLATES``: seven typographic looks, light and dark, for different genres), colour overrides (background / text /
accent), the cover texts (title, subtitle, author, series, tagline; an empty title or author falls back to the book
profile), the artwork (a book asset: made by AutoInjector, uploaded, or none = a typographic cover), the print
settings (trim, paper, page count) and an optional art note / character lock for the AI prompt. The back-cover
**blurb** and **author bio** live in the book profile (``blurb`` / ``author_bio``) so the rest of the book can use
them; the cover page edits them there. Every save bumps ``revision`` (a stale ``revision`` is refused: 409).

**AI artwork** goes through AutoInjector ``POST /image/request`` with ``purpose: "cover"`` (the forge helpers:
bridge address and token, every error code in plain words, the NO_LOCK fallback), ``size`` (a shape hint from the
trim), optional ``upscale`` 2|4 and ``characterLock``. The prompt asks for a picture without any lettering, calm
where the title goes.

**The files** (exporters/cover.py): the ebook cover (one-page PDF or SVG; a **JPG** — what Amazon KDP and most
stores want — is drawn from the SVG by AutoInjector, ``POST /render/image``, since Akọwe has no image library at
runtime; the last JPG of each size is kept as a book asset and used again while the cover is unchanged, and the
EPUB with the cover uses it as its cover image), the print wrap PDF (back + spine + front
with 0.125 in bleed, KDP spine maths, barcode area), and the book's own exports with the cover added (PDF: a cover
page in front; EPUB: cover image + cover page; DOCX: a cover page). See docs/COVERS.md.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import re
import threading
from datetime import datetime, timezone

from .errors import AkoweError
from .exporters import cover as cx
from .exporters.images import UnsupportedImage, load_image

log = logging.getLogger("akowe.cover")

TEXT_MAX = {"title": 200, "subtitle": 200, "author": 200, "series": 120, "tagline": 160}
NOTE_MAX = 600
LOCK_MAX = 80
UPSCALES = (1, 2, 4)
PROFILE_TEXTS = {"blurb": 3000, "author_bio": 1500}
# 🖨 the ebook cover as a JPG (drawn by AutoInjector): the 1 : 1.6 shape of the ebook cover at these sizes
JPG_SIZES = {"1600x2560": (1600, 2560, "Amazon KDP (recommended)"),
             "2560x4096": (2560, 4096, "High resolution"),
             "1000x1600": (1000, 1600, "Small (for a website)"),
             "625x1000": (625, 1000, "The smallest KDP accepts")}
JPG_DEFAULT = "1600x2560"
JPG_QUALITY = 92
WORDS_PER_PAGE = 280      # a 6 × 9 in novel page (an estimate only: the exported PDF's page count is used first)
_LOCK = threading.RLock()


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _err(code, path, message, status="REJECTED"):
    return AkoweError(code, path, message, status=status)


def _key(pid: str, branch: str) -> str:
    return f"cover:{pid}:{branch}"


def default_design() -> dict:
    return {"template": cx.DEFAULT_TEMPLATE, "colors": {}, "texts": {k: "" for k in TEXT_MAX},
            "art": None, "use_art": True, "art_note": "", "character_lock": "",
            "print": {"trim": "6x9", "paper": "cream", "page_count": None}, "revision": 0, "updated_at": None}


def get_design(store, pid: str, branch: str) -> dict:
    d = store.get_setting(_key(pid, branch))
    base = default_design()
    if isinstance(d, dict):
        for k, v in d.items():
            if k in ("texts", "print") and isinstance(v, dict):
                base[k].update(v)
            else:
                base[k] = v
    return base


def _profile(store, pid) -> dict:
    from .book_path import get_profile  # noqa: PLC0415
    return get_profile(store, pid) or {}


def resolved_texts(store, pid: str, design: dict) -> dict:
    """The texts the cover prints: the design's own, the profile's title / author when those are empty, and the
    profile's blurb and author bio."""
    prof = _profile(store, pid)
    tx = dict(design.get("texts") or {})
    title = (tx.get("title") or "").strip() or prof.get("title") or dict(store.project(pid) or {}).get("name") or ""
    author = (tx.get("author") or "").strip() or prof.get("author") or ""
    out = {k: (tx.get(k) or "").strip() for k in TEXT_MAX}
    out.update(title=title, author=author, blurb=prof.get("blurb") or "", author_bio=prof.get("author_bio") or "")
    return out


def _clean(body, old: dict) -> tuple[dict, dict]:
    """(new design, profile changes) from a PUT body (partial). Plain errors for every bad value."""
    if not isinstance(body, dict):
        raise _err("INVALID_INPUT", "", "the cover design must be a JSON object")
    d = copy.deepcopy(old)
    prof: dict = {}
    for k, v in body.items():
        if k == "revision":
            continue
        if k == "template":
            if v not in cx.TEMPLATES:
                raise _err("INVALID_INPUT", "/template", "template: one of " + ", ".join(cx.TEMPLATES))
            d["template"] = v
        elif k == "colors":
            if not isinstance(v, dict):
                raise _err("INVALID_INPUT", "/colors", "colors: {background, text, accent} as #rrggbb (or null for "
                           "the template's own)")
            for ck, cv in v.items():
                if ck not in ("background", "text", "accent"):
                    raise _err("INVALID_INPUT", f"/colors/{ck}", "colors: background, text or accent")
                if cv in (None, ""):
                    d["colors"].pop(ck, None)
                elif isinstance(cv, str) and cx.HEX_RE.match(cv):
                    d["colors"][ck] = cv.lower()
                else:
                    raise _err("INVALID_INPUT", f"/colors/{ck}", f"{ck} colour: write it as #rrggbb, e.g. #1b1f23")
        elif k == "texts":
            if not isinstance(v, dict):
                raise _err("INVALID_INPUT", "/texts", "texts: {title, subtitle, author, series, tagline}")
            for tk, tv in v.items():
                if tk not in TEXT_MAX:
                    raise _err("INVALID_INPUT", f"/texts/{tk}", "texts: title, subtitle, author, series or tagline")
                tv = "" if tv is None else tv
                if not isinstance(tv, str):
                    raise _err("INVALID_INPUT", f"/texts/{tk}", f"{tk} must be text")
                if len(tv) > TEXT_MAX[tk]:
                    raise _err("INVALID_INPUT", f"/texts/{tk}", f"{tk} is limited to {TEXT_MAX[tk]} characters")
                d["texts"][tk] = tv.strip() if tk != "title" else tv.strip(" \t")
        elif k in PROFILE_TEXTS:
            v = "" if v is None else v
            if not isinstance(v, str) or len(v) > PROFILE_TEXTS[k]:
                raise _err("INVALID_INPUT", f"/{k}", f"{k.replace('_', ' ')}: text of at most {PROFILE_TEXTS[k]} "
                           "characters")
            prof[k] = v.strip()
        elif k == "print":
            if not isinstance(v, dict):
                raise _err("INVALID_INPUT", "/print", "print: {trim, paper, page_count}")
            for pk, pv in v.items():
                if pk == "trim":
                    if pv not in cx.TRIMS:
                        raise _err("INVALID_INPUT", "/print/trim", "trim size: " + ", ".join(cx.TRIMS) + " (inches)")
                elif pk == "paper":
                    if pv not in cx.PAPERS:
                        raise _err("INVALID_INPUT", "/print/paper", "paper: white or cream")
                elif pk == "page_count":
                    if pv in (None, ""):
                        pv = None
                    elif not isinstance(pv, int) or isinstance(pv, bool) or not cx.MIN_PAGES <= pv <= 828:
                        raise _err("INVALID_INPUT", "/print/page_count", f"page count: a whole number from "
                                   f"{cx.MIN_PAGES} to 828 (or empty to use the exported PDF)")
                else:
                    raise _err("INVALID_INPUT", f"/print/{pk}", "print: trim, paper or page_count")
                d["print"][pk] = pv
        elif k == "use_art":
            if not isinstance(v, bool):
                raise _err("INVALID_INPUT", "/use_art", "use_art: true or false")
            d["use_art"] = v
        elif k == "art":
            if v is not None:
                raise _err("INVALID_INPUT", "/art", "art: null removes the picture (make or upload a new one with "
                           "the art buttons)")
            d["art"] = None
        elif k == "art_note":
            if not isinstance(v, str) or len(v) > NOTE_MAX:
                raise _err("INVALID_INPUT", "/art_note", f"art note: text of at most {NOTE_MAX} characters")
            d["art_note"] = v.strip()
        elif k == "character_lock":
            v = v or ""
            if not isinstance(v, str) or len(v) > LOCK_MAX:
                raise _err("INVALID_INPUT", "/character_lock", "character lock: a character's name")
            d["character_lock"] = v.strip()
        else:
            raise _err("INVALID_INPUT", f"/{k}", f"unknown cover field {k!r}")
    return d, prof


def _store_design(store, pid, branch, d: dict) -> dict:
    d["revision"] = int(d.get("revision") or 0) + 1
    d["updated_at"] = _now()
    store.set_setting(_key(pid, branch), d)
    return d


def save(app, pid: str, branch: str, body) -> dict:
    """PUT /cover: merge the changes, bump the revision; blurb / author_bio go into the book profile."""
    with _LOCK:
        old = get_design(app.store, pid, branch)
        if isinstance(body, dict) and body.get("revision") is not None and body["revision"] != old["revision"]:
            raise _err("VERSION_CONFLICT", "/revision", "the cover was changed elsewhere (another tab?): reload it, "
                       "then make your change again")
        d, prof = _clean(body, old)
        if prof:
            from .book_path import save_profile  # noqa: PLC0415
            save_profile(app.store, pid, prof)
        _store_design(app.store, pid, branch, d)
    return public(app, pid, branch)


def set_art(app, pid, branch, asset: dict | None) -> dict:
    with _LOCK:
        d = get_design(app.store, pid, branch)
        d["art"] = asset
        if asset:
            d["use_art"] = True
        return _store_design(app.store, pid, branch, d)


# ====================================================================== reading the art and the page count
def art_image(app, pid, branch, d: dict):
    """(bytes, ImageInfo) of the design's artwork when it is used, else None (a broken picture is skipped)."""
    from . import forge  # noqa: PLC0415
    if not d.get("use_art") or not d.get("art"):
        return None
    data = forge.picture_bytes(app.store, pid, branch, d["art"])
    if not data:
        return None
    try:
        return data, load_image(data)
    except (UnsupportedImage, ValueError) as exc:
        log.warning("cover art cannot be used: %s", exc)
        return None


def _export_files(app, pid, branch) -> list[dict]:
    from .book_path import BookPath  # noqa: PLC0415
    try:
        st = BookPath(app.engine, app.principal_id, pid, branch).status()
    except Exception:  # noqa: BLE001 - no book yet
        return [], None
    steps = {s["id"]: s for s in st["steps"]}
    return list((steps.get("export") or {}).get("files") or []), st.get("words")


def _export_bytes(app, pid, branch, fmt: str) -> tuple[bytes, dict] | None:
    files, _w = _export_files(app, pid, branch)
    cur = [f for f in files if f.get("format") == fmt and f.get("record_id")]
    cur.sort(key=lambda f: bool(f.get("out_of_date")))
    if not cur:
        return None
    f = cur[0]
    rec = app.store.get_record(pid, branch, f["record_id"], f["version"])
    return (app.store.read_binary(rec), f) if rec else None


def page_count(app, pid, branch, d: dict, override=None) -> dict:
    """{"pages", "source"}: the author's number, else the exported PDF's pages, else an estimate from the words."""
    if override not in (None, ""):
        return {"pages": override, "source": "request"}
    if d["print"].get("page_count"):
        return {"pages": d["print"]["page_count"], "source": "yours"}
    got = _export_bytes(app, pid, branch, "PDF")
    if got:
        from .exporters.pdf import inspect_pdf  # noqa: PLC0415
        n = inspect_pdf(got[0]).get("page_count") or 0
        if n:
            return {"pages": n, "source": "pdf"}
    _f, words = _export_files(app, pid, branch)
    total = (words or {}).get("words") if isinstance(words, dict) else None
    if isinstance(total, int) and total > 0:
        est = max(cx.MIN_PAGES, int(total / WORDS_PER_PAGE) + 8)
        return {"pages": est + (est % 2), "source": "estimate"}
    return {"pages": None, "source": None}


# ====================================================================== public JSON
def _art_public(pid, branch, a):
    if not isinstance(a, dict) or not a.get("asset_id"):
        return None
    out = {k: a.get(k) for k in ("asset_id", "version", "mime", "engine", "seed", "source", "at", "warnings",
                                 "width", "height", "upscale") if a.get(k) is not None}
    out["url"] = f"/api/projects/{pid}/branches/{branch}/assets/{a['asset_id']}/{a.get('version') or 1}"
    return out


def print_info(app, pid, branch, d: dict, *, trim=None, paper=None, pages=None) -> dict:
    trim = trim or d["print"]["trim"]
    paper = paper or d["print"]["paper"]
    pc = page_count(app, pid, branch, d, pages)
    out = {"trim": trim, "paper": paper, "page_count": pc["pages"], "page_count_source": pc["source"],
           "ok": False, "problem": None, "notes": []}
    try:
        n, notes = cx.check_print(trim, paper, pc["pages"])
    except cx.CoverError as exc:
        out["problem"] = exc.message
        return out
    g = cx.wrap_geometry(trim, paper, n)
    out.update({k: v for k, v in g.items() if k != "pt"}, ok=True, notes=notes)
    if pc["source"] == "estimate":
        out["notes"].append("The page count is an estimate from the word count: type the real number of pages of "
                            "the printed interior before you order.")
    elif pc["source"] == "pdf":
        out["notes"].append("The page count is the exported PDF's. If your printed interior has a different page "
                            "size, type its page count.")
    return out


def public(app, pid: str, branch: str) -> dict:
    from . import forge  # noqa: PLC0415
    store = app.store
    d = get_design(store, pid, branch)
    texts = resolved_texts(store, pid, d)
    warnings: list[str] = []
    ai = art_image(app, pid, branch, d)
    if ai is not None:
        _data, info = ai
        tw, th = cx.TRIMS[d["print"]["trim"]]
        dpi = cx.effective_dpi(info, (tw + 2 * cx.BLEED_IN) * cx.IN, (th + 2 * cx.BLEED_IN) * cx.IN)
        if dpi < 300:
            warnings.append(f"The picture is {info.width} × {info.height} pixels: about {int(dpi)} dpi on a "
                            f"{d['print']['trim'].replace('x', ' × ')} in print cover. Printers want 300 dpi: make it "
                            "again with ×2 or ×4 upscale, or upload a bigger picture. (The ebook cover is fine.)")
    elif d.get("art") and d.get("use_art"):
        warnings.append("The cover picture cannot be read any more: make or upload it again.")
    try:
        front_warn = cx.layout_front({"template": d["template"], "colors": d["colors"], "texts": texts},
                                     (0, 0, *cx.EBOOK_PT), art=ai[1] if ai else None)[1]["warnings"]
    except Exception:  # noqa: BLE001 - never break the page for a preview warning
        front_warn = []
    try:
        chars = [c["name"] for c in forge.list_dossiers(store, pid, branch)]
    except Exception:  # noqa: BLE001
        chars = []
    prof = _profile(store, pid)
    return {"design": dict(d, art=_art_public(pid, branch, d.get("art"))), "texts": texts,
            "templates": cx.template_list(),
            "trims": [{"id": k, "w_in": v[0], "h_in": v[1]} for k, v in cx.TRIMS.items()],
            "papers": [{"id": k, "label": cx.PAPER_LABELS[k], "inches_per_page": v} for k, v in cx.PAPERS.items()],
            "print": print_info(app, pid, branch, d), "warnings": front_warn + warnings,
            "ebook": {"width_pt": cx.EBOOK_PT[0], "height_pt": cx.EBOOK_PT[1], "width_px": 1600, "height_px": 2560,
                      "jpg_sizes": [{"id": k, "width": w, "height": h, "label": lb}
                                    for k, (w, h, lb) in JPG_SIZES.items()], "jpg_default": JPG_DEFAULT},
            "characters": chars, "idea": prof.get("idea") or "",
            "image_bridge": {"uses": [u for u, _t in forge.bridge_targets(app)]},
            "rules": {"bleed_in": cx.BLEED_IN, "safe_in": cx.SAFE_IN, "spine_text_min_pages": cx.SPINE_TEXT_MIN_PAGES,
                      "barcode_in": list(cx.BARCODE_IN), "min_pages": cx.MIN_PAGES, "max_pages": cx.MAX_PAGES}}


# ====================================================================== rendering
def _layout_design(app, pid, branch, d: dict, extra: dict | None = None) -> dict:
    texts = resolved_texts(app.store, pid, d)
    texts.update(extra or {})  # an unsaved blurb / bio in the live preview
    return {"template": d["template"], "colors": d["colors"], "texts": texts}


def ebook(app, pid, branch, *, fmt: str = "pdf", design: dict | None = None,
          extra: dict | None = None) -> tuple[bytes, str, str]:
    """(bytes, mime, file name) of the front cover: pdf | svg | art (the artwork itself)."""
    d = design or get_design(app.store, pid, branch)
    lay = _layout_design(app, pid, branch, d, extra)
    ai = art_image(app, pid, branch, d)
    title = lay["texts"]["title"] or "Book"
    stem = re.sub(r"[^A-Za-z0-9 _-]+", "", title).strip()[:60] or "Book"
    if fmt == "art":
        if ai is None:
            raise _err("MISSING_INPUT", "/format", "this cover has no picture: make or upload one first")
        return ai[0], ai[1].mime, f"{stem} - cover art.{ai[1].ext}"
    W, H = cx.EBOOK_PT
    ops, _info = cx.layout_front(lay, (0, 0, W, H), art=ai[1] if ai else None)
    if fmt == "svg":
        hrefs = {"art": cx.data_uri(ai[0], ai[1].mime)} if ai else {}
        svg = cx.render_svg(W, H, ops, hrefs=hrefs, title=f"Cover: {title}")
        return svg.encode("utf-8"), "image/svg+xml", f"{stem} - ebook cover.svg"
    if fmt != "pdf":
        raise _err("INVALID_INPUT", "/format", "format: pdf, svg, jpg or art")
    pdf = cx.render_pdf([{"width": W, "height": H, "ops": ops}], images={"art": ai[1]} if ai else {},
                        meta={"title": f"{title} - cover", "author": lay["texts"]["author"], "language": "en"},
                        extra_info={"Keywords": "Akowe ebook cover"})
    return pdf, "application/pdf", f"{stem} - ebook cover.pdf"


# ====================================================================== 🖨 the ebook cover as a JPG (AutoInjector)
def _jpg_key(pid: str, branch: str) -> str:
    return f"cover_jpg:{pid}:{branch}"


def _jpg_size(size) -> str:
    size = size or JPG_DEFAULT
    if size not in JPG_SIZES:
        raise _err("INVALID_INPUT", "/size", "size: " + ", ".join(JPG_SIZES))
    return size


def _fingerprint(svg: bytes, size: str) -> str:
    return hashlib.sha256(svg + b"|" + size.encode("ascii")).hexdigest()[:32]


def cached_jpg(app, pid, branch, size: str | None = None, *, svg: bytes | None = None) -> bytes | None:
    """The JPG drawn earlier for exactly this cover (same SVG) at ``size`` (default: any size, the KDP one first),
    or None. Never raises."""
    try:
        kept = (app.store.get_setting(_jpg_key(pid, branch)) or {}).get("sizes") or {}
        svg = svg if svg is not None else ebook(app, pid, branch, fmt="svg")[0]
        order = [size] if size else [JPG_DEFAULT] + [k for k in JPG_SIZES if k != JPG_DEFAULT]
        from . import forge  # noqa: PLC0415
        for k in order:
            a = kept.get(k)
            if isinstance(a, dict) and a.get("fingerprint") == _fingerprint(svg, k):
                data = forge.picture_bytes(app.store, pid, branch, a)
                if data and data[:3] == b"\xff\xd8\xff":
                    return data
    except Exception:  # noqa: BLE001 - no JPG: the callers fall back to the PDF / SVG cover
        log.warning("the kept ebook cover JPG could not be read")
    return None


def ebook_jpg(app, principal, pid, branch, size: str | None = None) -> tuple[bytes, str, str]:
    """(JPG bytes, mime, file name) of the front cover at ``size`` (``JPG_SIZES``): the SVG with its artwork embedded,
    drawn by AutoInjector (``POST /render/image``). Plain-words error when AutoInjector is not connected."""
    from . import forge, render  # noqa: PLC0415
    size = _jpg_size(size)
    w, h, _label = JPG_SIZES[size]
    svg, _m, name = ebook(app, pid, branch, fmt="svg")
    stem = name.rsplit(" - ebook cover", 1)[0]
    fname = f"{stem} - ebook cover {w}x{h}.jpg"
    data = cached_jpg(app, pid, branch, size, svg=svg)
    if data:
        return data, "image/jpeg", fname
    try:
        data = render.render_image(app, svg, w, h, fmt="jpeg", quality=JPG_QUALITY)
    except forge.ArtProblem as exc:
        raise render.as_error(exc, "JPG cover") from None
    try:  # keep it: the EPUB and the book save use it while the cover stays the same
        asset = forge._store_asset(app.store, principal, pid, branch, data, "image/jpeg",  # noqa: SLF001
                                   f"Ebook cover {w} x {h} (JPG)")
        with _LOCK:
            kept = app.store.get_setting(_jpg_key(pid, branch)) or {}
            sizes = kept.get("sizes") if isinstance(kept.get("sizes"), dict) else {}
            sizes[size] = dict(asset, fingerprint=_fingerprint(svg, size), width=w, height=h)
            app.store.set_setting(_jpg_key(pid, branch), {"sizes": sizes})
    except AkoweError:
        log.warning("the ebook cover JPG could not be kept with the book")
    return data, "image/jpeg", fname


def print_cover(app, pid, branch, *, trim=None, paper=None, pages=None, fmt: str = "pdf", guides: bool = False,
                design: dict | None = None, extra: dict | None = None) -> tuple[bytes, str, str, dict]:
    """(bytes, mime, name, geometry) of the full wrap. Plain-words errors for a bad trim / paper / page count."""
    d = design or get_design(app.store, pid, branch)
    if isinstance(pages, str):
        if not pages.strip().isdigit():
            raise _err("INVALID_INPUT", "/pages", "pages: a whole number of pages")
        pages = int(pages)
    pc = page_count(app, pid, branch, d, pages)
    try:
        n, notes = cx.check_print(trim or d["print"]["trim"], paper or d["print"]["paper"], pc["pages"])
    except cx.CoverError as exc:
        raise _err("INVALID_INPUT" if pc["pages"] is not None else "MISSING_INPUT", exc.path, exc.message) from None
    g = cx.wrap_geometry(trim or d["print"]["trim"], paper or d["print"]["paper"], n)
    lay = _layout_design(app, pid, branch, d, extra)
    ai = art_image(app, pid, branch, d)
    ops, info = cx.layout_wrap(lay, g, art=ai[1] if ai else None, guides=guides)
    p = g["pt"]
    title = lay["texts"]["title"] or "Book"
    stem = re.sub(r"[^A-Za-z0-9 _-]+", "", title).strip()[:50] or "Book"
    geo = {k: v for k, v in g.items() if k != "pt"}
    geo.update(warnings=notes + info["warnings"], page_count_source=pc["source"])
    name = f"{stem} - print cover {g['trim']} {g['paper']} {n}p"
    if fmt == "svg":
        hrefs = {"art": cx.data_uri(ai[0], ai[1].mime)} if ai else {}
        svg = cx.render_svg(p["width"], p["height"], ops, hrefs=hrefs, title=f"Print cover: {title}", guides=guides)
        return svg.encode("utf-8"), "image/svg+xml", name + ".svg", geo
    if fmt != "pdf":
        raise _err("INVALID_INPUT", "/format", "format: pdf or svg")
    b = p["bleed"]
    pdf = cx.render_pdf([{"width": p["width"], "height": p["height"], "ops": ops,
                          "trim": (b, b, p["width"] - 2 * b, p["height"] - 2 * b)}],
                        images={"art": ai[1]} if ai else {},
                        meta={"title": f"{title} - print cover", "author": lay["texts"]["author"], "language": "en"},
                        extra_info={"AkoweSpine": f"x={cx.num(p['spine_x'])}pt width={cx.num(p['spine'])}pt "
                                                  f"pages={n} paper={g['paper']}",
                                    "Keywords": f"Akowe print cover {g['trim']} spine {g['spine_in']}in"})
    return pdf, "application/pdf", name + ".pdf", geo


def book_with_cover(app, pid, branch, fmt: str) -> tuple[bytes, str, str]:
    """The current exported book (PDF | EPUB | DOCX) with this cover added."""
    fmt = (fmt or "").upper()
    mimes = {"PDF": "application/pdf", "EPUB": "application/epub+zip",
             "DOCX": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
    if fmt not in mimes:
        raise _err("INVALID_INPUT", "/format", "format: PDF, EPUB or DOCX")
    got = _export_bytes(app, pid, branch, fmt)
    if not got:
        raise _err("MISSING_INPUT", "/format", f"there is no {fmt} of the book yet: export the book first (📘 Make my "
                   "book → Export my book)")
    data, f = got
    d = get_design(app.store, pid, branch)
    lay = _layout_design(app, pid, branch, d)
    ai = art_image(app, pid, branch, d)
    title = lay["texts"]["title"] or "Book"
    stem = re.sub(r"[^A-Za-z0-9 _-]+", "", f.get("title") or title).strip()[:50] or "Book"
    try:
        if fmt == "PDF":
            def ops_for(w, h, trim):
                if trim:
                    tx, ty, tw, th = trim
                    return cx.layout_front(lay, (tx, ty, tw, th), art=ai[1] if ai else None,
                                           bleed=(tx, w - tx - tw, h - ty - th, ty))[0]
                return cx.layout_front(lay, (0, 0, w, h), art=ai[1] if ai else None)[0]
            out = cx.add_cover_pdf(data, ops_for, images={"art": ai[1]} if ai else {})
        elif fmt == "EPUB":
            W, H = cx.EBOOK_PT
            ops, _ = cx.layout_front(lay, (0, 0, W, H), art=ai[1] if ai else None)
            ext = ai[1].ext if ai else None
            inline = cx.render_svg(W, H, ops, hrefs={"art": f"../images/cover-art.{ext}"} if ai else {},
                                   title=f"Cover: {title}", standalone=False)
            svg_file = None if ai else cx.render_svg(W, H, ops, title=f"Cover: {title}")
            out = cx.add_cover_epub(data, svg_inline=inline, art=ai, svg_file=svg_file, title=title,
                                    jpg=cached_jpg(app, pid, branch))
        else:
            out = cx.add_cover_docx(data, texts=lay["texts"], art=ai)
    except cx.CoverError as exc:
        raise _err("INVALID_INPUT", "/format", exc.message) from None
    return out, mimes[fmt], f"{stem} (with cover).{fmt.lower()}"


# ====================================================================== AI artwork (AutoInjector POST /image/request)
def art_prompt(app, pid, branch, d: dict) -> str:
    prof = _profile(app.store, pid)
    texts = resolved_texts(app.store, pid, d)
    t = cx.TEMPLATES[d["template"]]
    parts = [f"Book cover artwork for \"{texts['title']}\"" if texts["title"] else "Book cover artwork"]
    if prof.get("genre"):
        parts.append(f"Genre: {prof['genre']}")
    if prof.get("tone"):
        parts.append(f"Mood: {prof['tone']}")
    if d.get("art_note"):
        parts.append(d["art_note"])
    elif prof.get("idea"):
        parts.append("Story: " + " ".join(prof["idea"].split())[:500])
    if d.get("character_lock"):
        parts.append(f"Featuring {d['character_lock']}")
    zone = {"top": "the upper third", "bottom": "the lower third", "middle": "the middle band"}[t["title_pos"]]
    look = "light, airy palette" if t["light"] else "dark, rich, cinematic palette"
    parts.append(f"Portrait orientation, {look}, one strong focal point, calm uncluttered area in {zone} for the "
                 "title; professional, painterly, high detail")
    parts.append("No text, no letters, no title, no logos, no watermark, no border")
    return ". ".join(x.strip().rstrip(".") for x in parts if x and x.strip())[:1800]


def run_art(app, job, pid, branch, engine: str, upscale: int) -> None:
    from . import forge  # noqa: PLC0415
    d = get_design(app.store, pid, branch)
    texts = resolved_texts(app.store, pid, d)
    tw, th = cx.TRIMS[d["print"]["trim"]]
    body = {"engine": engine, "purpose": "cover", "prompt": art_prompt(app, pid, branch, d),
            "size": {"width": 1600, "height": int(round(1600 * th / tw))}, "book": texts["title"] or None,
            "from": "akowe-cover", "returnImage": True}
    if upscale > 1:
        body["upscale"] = upscale
    if d.get("character_lock"):
        body["characterLock"] = d["character_lock"]
    body = {k: v for k, v in body.items() if v is not None}
    job.phase = "Making the cover picture — a ChatGPT picture can take 1-3 minutes"
    lock_missing = False
    job.check()
    try:
        resp = forge.request_image(app, body)
    except forge.ArtProblem as exc:
        if exc.code == "NO_LOCK" and "characterLock" in body:
            lock_missing = True
            body.pop("characterLock", None)
            job.check()
            resp = forge.request_image(app, body)
        else:
            raise
    data, seed = forge.first_picture(resp)
    asset = forge.store_picture(app.store, job.principal, pid, branch, data, "", f"{texts['title'] or 'Book'} — cover")
    try:
        info = load_image(data)
        asset.update(width=info.width, height=info.height)
    except (UnsupportedImage, ValueError):
        raise forge.ArtProblem("IMAGE_BAD_ANSWER") from None
    warns = [str(w)[:200] for w in resp.get("warnings") or []][:5]
    if lock_missing:
        warns.append(f"no character lock named {d['character_lock']}: made from the prompt alone")
    asset.update(source=str(resp.get("engine") or engine), engine=resp.get("engine"),
                 seed=seed if seed is not None else resp.get("seed"), upscale=upscale if upscale > 1 else None,
                 warnings=warns or None)
    set_art(app, pid, branch, {k: v for k, v in asset.items() if v is not None})
    job.done = 1
    job.results.append({"ok": True, "slot": "cover", "engine": resp.get("engine"), "seed": asset.get("seed"),
                        "message": "Cover picture made and stored with the book."})


class CoverService:
    def __init__(self, app):
        self.app = app

    def start_art(self, principal, pid, branch, body) -> dict:
        from . import forge  # noqa: PLC0415
        from .review import ReviewJob  # noqa: PLC0415
        body = body if isinstance(body, dict) else {}
        engine = body.get("engine", "auto")
        if engine not in forge.ENGINES:
            raise _err("INVALID_INPUT", "/engine", "engine: auto, sd or chatgpt")
        upscale = body.get("upscale", 1)
        if upscale in (None, ""):
            upscale = 1
        if upscale not in UPSCALES or isinstance(upscale, bool):
            raise _err("INVALID_INPUT", "/upscale", "upscale: 1 (none), 2 or 4")
        if not self.app.store.has_scope(principal, pid, branch, "I01:create"):
            raise _err("PERMISSION_DENIED", "", "missing scope I01:create")

        class CoverJob(ReviewJob):
            def public(self):
                out = super().public()
                out["total"] = 1
                return out
        job = CoverJob("cover_art", principal, pid, branch, ["cover"], None)

        def fn(j):
            j.current = "cover"
            try:
                run_art(self.app, j, pid, branch, engine, upscale)
            except forge.ArtProblem as exc:
                j.status, j.phase, j.error = "error", "Failed", exc.as_error()
        return self.app.review._start(job, fn)

    def upload(self, principal, pid, branch, body) -> dict:
        from . import forge  # noqa: PLC0415
        if not isinstance(body, (bytes, bytearray)):
            raise _err("INVALID_INPUT", "/body", "send the picture itself (PNG or JPEG bytes) with Content-Type "
                       "image/png or image/jpeg")
        title = resolved_texts(self.app.store, pid, get_design(self.app.store, pid, branch))["title"] or "Book"
        asset = forge.store_picture(self.app.store, principal, pid, branch, bytes(body), "", f"{title} — cover")
        try:
            info = load_image(bytes(body))
        except (UnsupportedImage, ValueError) as exc:
            raise _err("INVALID_INPUT", "/body", f"this picture cannot be used on a cover: {exc}") from None
        asset.update(source="upload", width=info.width, height=info.height)
        set_art(self.app, pid, branch, asset)
        out = public(self.app, pid, branch)
        out["message"] = "Picture saved with the book."
        return out


# ====================================================================== HTTP: /api/projects/:pid/branches/:b/cover/…
def _q(query: dict, k: str, default=None):
    v = (query or {}).get(k)
    return v[0] if isinstance(v, list) and v else (v if isinstance(v, str) else default)


def route(app, method: str, rest: list, query: dict, body, principal: str, pid: str, branch: str, headers):
    svc = app.cover
    dl = "attachment" if _q(query, "download") == "1" else "inline"
    if rest == [] and method == "GET":
        return 200, public(app, pid, branch)
    if rest == [] and method == "PUT":
        return 200, save(app, pid, branch, body)
    if rest == ["art"] and method == "POST":
        return 202, svc.start_art(principal, pid, branch, body)
    if rest == ["art"] and method == "PUT":
        return 200, svc.upload(principal, pid, branch, body)
    if rest == ["preview"] and method == "POST":  # the live preview of an unsaved design (SVG)
        body = body if isinstance(body, dict) else {}
        d, prof = _clean(body, get_design(app.store, pid, branch))
        if _q(query, "what", "front") == "print":
            data, mime, name, _geo = print_cover(app, pid, branch, fmt="svg", guides=True, design=d, extra=prof)
        else:
            data, mime, name = ebook(app, pid, branch, fmt="svg", design=d, extra=prof)
        return 200, ("__binary__", mime, data, name, "inline")
    if rest == ["ebook"] and method == "GET":
        if _q(query, "format") in ("jpg", "jpeg"):
            data, mime, name = ebook_jpg(app, principal, pid, branch, _q(query, "size"))
            return 200, ("__binary__", mime, data, name, dl)
        data, mime, name = ebook(app, pid, branch, fmt=_q(query, "format", "pdf"))
        return 200, ("__binary__", mime, data, name, dl)
    if rest == ["print"] and method == "GET":
        data, mime, name, _geo = print_cover(app, pid, branch, trim=_q(query, "trim"), paper=_q(query, "paper"),
                                             pages=_q(query, "pages"), fmt=_q(query, "format", "pdf"),
                                             guides=_q(query, "guides") == "1")
        return 200, ("__binary__", mime, data, name, dl)
    if rest == ["book"] and method == "GET":
        data, mime, name = book_with_cover(app, pid, branch, _q(query, "format", "PDF"))
        return 200, ("__binary__", mime, data, name, dl)
    if len(rest) == 2 and rest[0] == "jobs" and method == "GET":
        return 200, app.review.get_job(principal, rest[1])
    raise _err("NOT_FOUND", "/cover", "no such cover endpoint")


# ====================================================================== book save (💾): Cover/
def save_files(app, pid: str, branch: str, files: dict, stem: str) -> None:
    """Cover/ in the book's folder (every path ≤ 60 characters): the design, the ebook cover (PDF + SVG), the print
    wrap (when the page count is known), the artwork, and the exported book files with the cover."""
    d = get_design(app.store, pid, branch)
    if not d.get("revision"):
        return  # never opened on the 🎨 Cover page
    short = (stem or "Book")[:24].strip() or "Book"
    files["Cover/cover-design.json"] = json.dumps(dict(d, texts=resolved_texts(app.store, pid, d)),
                                                  ensure_ascii=False, indent=1).encode("utf-8")
    files["Cover/ebook cover.pdf"] = ebook(app, pid, branch, fmt="pdf")[0]
    files["Cover/ebook cover.svg"] = ebook(app, pid, branch, fmt="svg")[0]
    jpg = cached_jpg(app, pid, branch)  # 🖨 the JPG AutoInjector drew, while the cover is unchanged
    if jpg:
        files["Cover/ebook cover.jpg"] = jpg
    ai = art_image(app, pid, branch, d)
    if ai:
        files[f"Cover/cover art.{ai[1].ext}"] = ai[0]
    try:
        files["Cover/print cover.pdf"] = print_cover(app, pid, branch)[0]
    except AkoweError:
        pass  # no page count yet
    for fmt in ("PDF", "EPUB", "DOCX"):
        try:
            data, _m, _n = book_with_cover(app, pid, branch, fmt)
        except AkoweError:
            continue
        files[f"Cover/{short} (with cover).{fmt.lower()}"] = data
