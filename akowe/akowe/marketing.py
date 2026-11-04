"""📣 Mockups and ads (idea #17): pictures and short clips to sell the book, made from its 🎨 cover — the
📣 Mockups & ads page (``#/p/<pid>/<b>/marketing``, web/marketing.js), next to 🎨 Cover.

**Everything is drawn here, in pure Python, as SVG** (Akọwe has no image library at runtime, docs/COVERS.md): the
front cover — and the print wrap when the page count is known, so the spine and the back are the real ones — is put
inline (its ids prefixed) and mapped onto a 3D book:

* **3D mockups** (``paperback``, ``hardcover``, ``stack``, ``series``): a box of the trim size and the real spine width
  is posed in 3D and seen through a pin-hole camera. SVG has only affine transforms, so every textured face is cut
  into a small grid; each cell is the cover under the affine map that fits three of its projected corners, clipped
  to its exact projected quad (grown by half a pixel so no seam shows). The grid is refined until the fourth corner
  is within ``MAX_CELL_ERROR_PX`` of where the true perspective puts it. Faces facing away are dropped; the rest get
  light from the upper left (a darker spine), a gloss band over the front, page edges (fine lines in the paper's
  colour) on the head and the fore-edge, and a soft shadow cast on the floor.
* **Flat mockups** (``phone``, ``tablet``, ``ereader``): the front cover on a screen (the e-reader in greyscale).
* Each mockup comes **see-through** (a transparent PNG) and **on a background** (a JPG in the cover's colours).
* **Ads** in the sizes the stores ask for (``ADS``): the mockup, the hook (the 🚀 launch kit's hook when there is one,
  else the cover's tagline, else the book's one-line idea; the author can type their own) and a call to action
  ("Available now"), in the cover template's colours and fonts. Text is measured with the cover's own font metrics
  (``exporters.cover.measure``) and kept inside each format's text-safe area (``safe``); the Amazon custom image has no
  added words at all (Amazon's rule).
* **Teaser clips** (``CLIPS``, 13 s, vertical 1080 × 1920 and square 1080 × 1080): four frames (the mockup, the hook,
  the cover, the end card) drawn as JPGs, then joined by AutoInjector's trailer maker (``POST /video/trailer`` with
  ``still`` items: a slow zoom / pan, no video engine needed; WebM, plus MP4 when ffmpeg is found). Optionally the
  cover picture itself is brought to life by 🎬 Video (FramePack / Wan) as one ``shot``; when that cannot be done the
  clip uses the still cover and says so.

**Pixels**: the PNGs / JPGs are drawn from the SVGs by AutoInjector (``render.render_image``, ``POST /render/image``,
a see-through PNG when no background is given). Without AutoInjector the SVG of every piece still downloads.

**Out of date** (like the pictures, H15, and the trailer, H24): each made file keeps fingerprints of what it was made
from — the cover (the SVG of the front / wrap), the words (hook, call to action) and how Akọwe draws it
(``LAYOUT_VERSION``). When the cover or the words change, the file is marked out of date with the reason, and
🖼 Make the pictures again makes it new.

The model: settings ``marketing:<pid>:<branch>`` = ``{"revision", "hook", "cta", "animate", "made": {piece: asset +
fingerprints}, "clips": {clip: {webm, mp4, …}}, "updated_at"}``. The book save writes ``Marketing/`` (``save_files``).
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import logging
import math
import os
import re
import struct
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timezone

from .errors import AkoweError
from .exporters import cover as cx

log = logging.getLogger("akowe.marketing")

LAYOUT_VERSION = "1"
MOCKUP_PX = 2000                 # every mockup is a 2000 × 2000 picture
MAX_CELL_ERROR_PX = 0.6          # the affine cells stay this close to the true perspective
HOOK_MAX = 160
CTA_MAX = 40
CTA_DEFAULT = "Available now"
CTA_CHOICES = ("Available now", "Out now", "Coming soon", "Pre-order now", "Read it today", "New release")
JPG_QUALITY = 92
CLIP_SECONDS = (6.0, 15.0)
PICTURES_ROOT = None             # where the teaser frames go for AutoInjector (None: the temp folder; tests set it)
POLL_S = 2.0
CLIP_TIMEOUT_S = 3 * 3600.0
STATUS_MISSES = 15
MAX_CLIP_BYTES = 200 * 1024 * 1024
_LOCK = threading.RLock()
_REJ = {"status": "REJECTED"}

MOCKUPS = {  # id -> (label, one line about it)
    "paperback": ("Paperback, standing", "The paperback at an angle: its front, its spine and the page edges on top."),
    "hardcover": ("Hardcover, standing", "The hardback turned the other way: the front, the boards and the page "
                                         "edges."),
    "phone": ("Ebook on a phone", "The ebook cover on a phone screen."),
    "tablet": ("Ebook on a tablet", "The ebook cover on a tablet."),
    "ereader": ("Ebook on an e-reader", "The ebook cover on an e-ink reader, in shades of grey like the real screen."),
    "stack": ("A stack of copies", "Three copies lying on top of each other, the top one showing its cover."),
    "series": ("The series together", "The books of the series standing side by side, each with its own cover."),
}
ADS = {  # id -> spec. safe = (left, top, right, bottom) px kept free of words
    "ad-square": {"w": 1080, "h": 1080, "label": "Instagram / Facebook post", "safe": (72, 72, 72, 72),
                  "line": "Square 1080 × 1080: a post in the feed on Instagram and Facebook.",
                  "note": "Words stay 72 px inside every edge."},
    "ad-story": {"w": 1080, "h": 1920, "label": "Story / Reel", "safe": (72, 250, 72, 340),
                 "line": "Tall 1080 × 1920: Instagram and Facebook stories and Reels.",
                 "note": "The apps put their buttons over the top 250 px and the bottom 340 px, so the words stay "
                         "out of them."},
    "ad-landscape": {"w": 1200, "h": 628, "label": "Facebook / X link post", "safe": (48, 40, 48, 40),
                     "line": "Wide 1200 × 628: a Facebook or X (Twitter) post or ad.",
                     "note": "Words stay 40–48 px inside the edges."},
    "ad-amazon": {"w": 1200, "h": 1200, "label": "Amazon Ads custom image", "safe": None,
                  "line": "1200 × 1200: the custom image of an Amazon (KDP) Sponsored Brands ad.",
                  "note": "Amazon asks for at least 1200 × 628 px and no added words, logos, prices or reviews on a "
                          "custom image: this one shows only the book. Check Amazon Ads' current rules before you "
                          "upload it."},
    "ad-bookbub": {"w": 300, "h": 250, "label": "BookBub ad", "safe": (12, 12, 12, 12),
                   "line": "Small 300 × 250: a BookBub Ads (and web banner) size.",
                   "note": "So small that only a short hook fits: keep it to a few words."},
}
CLIPS = {
    "clip-vertical": {"w": 1080, "h": 1920, "label": "Teaser clip, tall", "safe": (72, 250, 72, 340),
                      "line": "13 seconds, 1080 × 1920: stories, Reels, TikTok and Shorts."},
    "clip-square": {"w": 1080, "h": 1080, "label": "Teaser clip, square", "safe": (72, 72, 72, 72),
                    "line": "13 seconds, 1080 × 1080: a video post in the feed."},
}
# the frames of a teaser: (what, seconds, movement)
CLIP_FRAMES = (("scene", 3.5, "zoom-in"), ("hook", 3.0, "zoom-in"), ("cover", 3.0, "pan-up"), ("end", 3.5, "zoom-out"))
# a cover picture brought to life that cannot be made: the clip uses the still cover instead (and says why)
SHOT_FALLBACK = {"VIDEO_NOT_SET_UP", "VIDEO_MODEL_MISSING", "VIDEO_OOM", "VIDEO_TIMEOUT", "VIDEO_FAILED",
                 "UNSUPPORTED_ON_BACKEND", "NOT_WIRED", "NO_IMAGE_ENGINE"}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _bad(path: str, msg: str, code: str = "INVALID_INPUT") -> AkoweError:
    return AkoweError(code, path, msg, **_REJ)


def _h(*parts) -> str:
    m = hashlib.sha256()
    for p in parts:
        m.update(p if isinstance(p, (bytes, bytearray)) else str(p).encode("utf-8"))
        m.update(b"\x00")
    return m.hexdigest()[:24]


def _f(v: float) -> str:
    s = f"{v:.2f}"
    return s.rstrip("0").rstrip(".") if "." in s else s


def _esc(s: str) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _hex(col) -> str:
    return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(v)))) for v in col)


def _mix(a, b, t: float) -> tuple:
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def _lum(c) -> float:
    def ch(v):
        v = v / 255.0
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])


def contrast(a, b) -> float:
    la, lb = sorted((_lum(a), _lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


# ====================================================================== the stored model
def _key(pid: str, branch: str) -> str:
    return f"marketing:{pid}:{branch}"


def _empty() -> dict:
    return {"revision": 0, "hook": None, "cta": None, "animate": False, "made": {}, "clips": {}, "updated_at": None}


def doc(store, pid: str, branch: str) -> dict:
    d = store.get_setting(_key(pid, branch))
    out = _empty()
    if isinstance(d, dict):
        out.update(copy.deepcopy(d))
    for k in ("made", "clips"):
        if not isinstance(out.get(k), dict):
            out[k] = {}
    return out


def _mutate(store, pid, branch, fn, revision=None):
    with _LOCK:
        d = doc(store, pid, branch)
        if revision is not None and not isinstance(revision, bool) and isinstance(revision, int) \
                and revision != int(d.get("revision") or 0):
            raise AkoweError("VERSION_CONFLICT", "/revision", "the mockups page was changed in another window: "
                             "reload the page, then make your change again", **_REJ)
        out = fn(d)
        d["revision"] = int(d.get("revision") or 0) + 1
        d["updated_at"] = _now()
        store.set_setting(_key(pid, branch), d)
        return out if out is not None else d


# ====================================================================== the words: hook and call to action
def _clean_line(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n].strip()


def _launch_kit_hook(store, pid: str, branch: str) -> str:
    """The 🚀 launch kit's one-line hook (its approved version, else its newest), read from its stored kit
    (``launch_kit:<pid>:<branch>``; a plain ``hook`` / ``tagline`` text is read too). '' when there is none."""
    try:
        d = store.get_setting(f"launch_kit:{pid}:{branch}")
    except Exception:  # noqa: BLE001
        return ""
    if not isinstance(d, dict):
        return ""
    for k in ("hook", "tagline"):
        if isinstance(d.get(k), str) and d[k].strip():
            return _clean_line(d[k], HOOK_MAX)
    f = (d.get("fields") or {}).get("hook") if isinstance(d.get("fields"), dict) else None
    if isinstance(f, dict):
        vs = [v for v in f.get("versions") or [] if isinstance(v, dict)]
        pick = next((v for v in vs if f.get("approved") and v.get("n") == f.get("approved")), None) or \
            (vs[-1] if vs else None)
        if pick and isinstance(pick.get("value"), str):
            return _clean_line(pick["value"], HOOK_MAX)
    return ""


def auto_hook(app, pid: str, branch: str) -> tuple[str, str]:
    """(hook, where it came from): the launch kit's hook, else the cover's tagline, else the book in one line."""
    from . import cover  # noqa: PLC0415
    h = _launch_kit_hook(app.store, pid, branch)
    if h:
        return h, "launch kit"
    try:
        t = cover.resolved_texts(app.store, pid, cover.get_design(app.store, pid, branch)).get("tagline") or ""
    except Exception:  # noqa: BLE001
        t = ""
    if t.strip():
        return _clean_line(t, HOOK_MAX), "cover tagline"
    try:
        from . import trailer  # noqa: PLC0415
        t = trailer.logline(app, app.principal_id, pid, branch)
    except Exception:  # noqa: BLE001
        t = ""
    if t.strip():
        return _clean_line(t, HOOK_MAX), "book idea"
    return "", "none"


def words(app, pid: str, branch: str, d: dict | None = None) -> dict:
    d = d or doc(app.store, pid, branch)
    auto, src = auto_hook(app, pid, branch)
    own = d.get("hook")
    hook = own if isinstance(own, str) else auto
    cta = d.get("cta") if isinstance(d.get("cta"), str) and d.get("cta").strip() else CTA_DEFAULT
    return {"hook": _clean_line(hook, HOOK_MAX), "hook_source": "yours" if isinstance(own, str) else src,
            "auto_hook": auto, "auto_source": src, "cta": _clean_line(cta, CTA_MAX)}


# ====================================================================== the cover as a source
class Source:
    """One book's cover ready to be put on a mockup: the inline SVG (prefixed ids), where its front / spine / back
    panels are, the book's proportions (inches) and its colours."""

    def __init__(self):
        self.defs: list[str] = []      # <g id> groups to put in <defs>, ids already prefixed
        self.front = None              # (group id, (x, y, w, h)) in the group's coordinates (SVG, y down)
        self.spine = None
        self.back = None
        self.w_in = 6.0
        self.h_in = 9.0
        self.t_in = 0.6
        self.wrap = False              # the print wrap is used (real spine and back)
        self.colors: dict = {}
        self.texts: dict = {}
        self.template: dict = {}
        self.fp = ""                   # fingerprint of the cover SVG(s)
        self.art = None                # (bytes, ImageInfo) of the cover picture, or None
        self.paper = "cream"


_ID_RE = re.compile(r'\bid="([A-Za-z_][\w.-]*)"')


def inline_svg(svg: str, prefix: str) -> tuple[str, tuple]:
    """(the inner content with every id and url(#…) / href="#…" prefixed, (viewBox w, h))."""
    s = re.sub(r"^\s*<\?xml[^>]*\?>", "", svg)
    m = re.search(r"<svg\b[^>]*>", s)
    if not m:
        raise ValueError("not an SVG")
    vb = re.search(r'viewBox="\s*([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)\s*"', m.group(0))
    w, h = (float(vb.group(3)), float(vb.group(4))) if vb else (432.0, 691.2)
    inner = s[m.end():s.rfind("</svg>")]
    inner = re.sub(r"<title>.*?</title>", "", inner, flags=re.S)
    ids = set(_ID_RE.findall(inner))
    inner = _ID_RE.sub(lambda k: f'id="{prefix}{k.group(1)}"', inner)
    inner = re.sub(r"url\(#([\w.-]+)\)", lambda k: f"url(#{prefix}{k.group(1)})" if k.group(1) in ids else k.group(0),
                   inner)
    inner = re.sub(r'(xlink:href|href)="#([\w.-]+)"',
                   lambda k: f'{k.group(1)}="#{prefix}{k.group(2)}"' if k.group(2) in ids else k.group(0), inner)
    return inner, (w, h)


def _source_def(gid: str, inner: str, _data: bytes) -> str:
    """The cover in <defs>, inline (its ids already prefixed)."""
    return f'<g id="{gid}">{inner}</g>'


def _template_colors(d: dict) -> tuple[dict, dict]:
    t = cx.TEMPLATES.get(d.get("template")) or cx.TEMPLATES[cx.DEFAULT_TEMPLATE]
    return t, cx._colors(t, d.get("colors"))  # noqa: SLF001 - the cover's own colour rules


def spine_svg(gid: str, w: float, h: float, src: Source) -> str:
    """A drawn spine (no print wrap yet): the background colour, the title down the spine and the author."""
    c = src.colors
    t = src.template
    out = [f'<g id="{gid}"><rect x="0" y="0" width="{_f(w)}" height="{_f(h)}" fill="{_hex(c["background"])}"/>']
    title = cx.safe(src.texts.get("title") or "").replace("\n", " ").strip()
    author = cx.safe(src.texts.get("author") or "").strip()
    font = t.get("title_font", "Times-Bold")
    if title and w >= 6:
        size = min(w * 0.46, h * 0.05)
        room = h * (0.62 if author else 0.8)
        tw = cx.measure(title.upper() if t.get("title_upper") else title, font, size)
        if tw > room:
            size *= room / tw
        text = title.upper() if t.get("title_upper") else title
        tw = cx.measure(text, font, size)
        x = w / 2 - (cx.cap(font) * size) / 2
        y0 = h * 0.08
        out.append(f'<text transform="translate({_f(x)} {_f(y0)}) rotate(90)" {cx._svg_font(font)} '  # noqa: SLF001
                   f'font-size="{_f(size)}" fill="{_hex(c["text"])}" textLength="{_f(tw)}" '
                   f'lengthAdjust="spacingAndGlyphs">{_esc(text)}</text>')
        if author:
            af = t.get("author_font", "Times-Roman")
            asz = min(size * 0.7, w * 0.36)
            aw = cx.measure(author.upper(), af, asz)
            room2 = h * 0.24
            if aw > room2:
                asz *= room2 / aw
                aw = cx.measure(author.upper(), af, asz)
            ax = w / 2 - (cx.cap(af) * asz) / 2
            out.append(f'<text transform="translate({_f(ax)} {_f(h * 0.94 - aw)}) rotate(90)" '
                       f'{cx._svg_font(af)} font-size="{_f(asz)}" fill="{_hex(c["accent"])}" '  # noqa: SLF001
                       f'textLength="{_f(aw)}" lengthAdjust="spacingAndGlyphs">{_esc(author.upper())}</text>')
    out.append("</g>")
    return "".join(out)


def source_of(app, pid: str, branch: str, prefix: str = "s") -> Source:
    """The book's cover as a mockup source: the print wrap when the page count is known (the real spine and back),
    else the ebook front and a drawn spine."""
    from . import cover  # noqa: PLC0415
    store = app.store
    d = cover.get_design(store, pid, branch)
    src = Source()
    src.template, src.colors = _template_colors(d)
    src.texts = cover.resolved_texts(store, pid, d)
    src.paper = (d.get("print") or {}).get("paper") or "cream"
    try:
        src.art = cover.art_image(app, pid, branch, d)
    except Exception:  # noqa: BLE001
        src.art = None
    wrap = None
    try:
        wrap = cover.print_cover(app, pid, branch, fmt="svg", design=d)
    except AkoweError:
        wrap = None
    except Exception:  # noqa: BLE001 - a broken wrap: the front alone
        log.exception("marketing: the print wrap")
        wrap = None
    if wrap is not None:
        data, _m, _n, geo = wrap
        g = cx.wrap_geometry(geo["trim"], geo["paper"], geo["page_count"])
        p = g["pt"]
        inner, _vb = inline_svg(data.decode("utf-8"), f"{prefix}w-")
        gid = f"{prefix}wrap"
        src.defs.append(_source_def(gid, inner, data))
        b = p["bleed"]
        src.front = (gid, (p["front_x"], b, p["trim_w"], p["trim_h"]))
        src.back = (gid, (p["back_x"], b, p["trim_w"], p["trim_h"]))
        src.spine = (gid, (p["spine_x"], b, p["spine"], p["trim_h"])) if p["spine"] > 0 else None
        src.w_in, src.h_in, src.t_in = g["trim_w_in"], g["trim_h_in"], max(0.06, g["spine_in"])
        src.wrap = True
        src.fp = _h("wrap", data)
    else:
        data = cover.ebook(app, pid, branch, fmt="svg", design=d)[0]
        inner, (W, H) = inline_svg(data.decode("utf-8"), f"{prefix}f-")
        gid = f"{prefix}front"
        src.defs.append(_source_def(gid, inner, data))
        src.front = (gid, (0.0, 0.0, W, H))
        try:
            pc = cover.page_count(app, pid, branch, d).get("pages")
        except Exception:  # noqa: BLE001
            pc = None
        src.w_in, src.h_in = 6.0, 6.0 * H / W
        src.t_in = max(0.25, cx.spine_width_in(int(pc), src.paper)) if pc else 0.7
        sw = W * src.t_in / src.w_in
        sid = f"{prefix}spine"
        src.defs.append(spine_svg(sid, sw, H, src))
        src.spine = (sid, (0.0, 0.0, sw, H))
        src.back = None
        src.fp = _h("front", data, src.t_in)
    return src


def series_sources(app, pid: str, branch: str) -> list[Source]:
    """The books of the series in order (this one included), each as a source; [] for a book on its own."""
    from . import series  # noqa: PLC0415
    try:
        s = series.of_book(app.store, pid, branch)
        bks = series.books(s)
    except Exception:  # noqa: BLE001
        return []
    out = []
    for i, b in enumerate(bks[:5]):
        try:
            if not app.store.project(b["project_id"]):
                continue
            out.append(source_of(app, b["project_id"], b.get("branch_id") or "main", prefix=f"b{i}"))
        except Exception:  # noqa: BLE001 - a book that cannot be drawn is left out
            log.exception("marketing: a series book's cover")
    return out if len(out) >= 2 else []


# ====================================================================== 3D: vectors, poses, the camera
def _rx(a):
    c, s = math.cos(a), math.sin(a)
    return ((1, 0, 0), (0, c, -s), (0, s, c))


def _ry(a):
    c, s = math.cos(a), math.sin(a)
    return ((c, 0, s), (0, 1, 0), (-s, 0, c))


def _rz(a):
    c, s = math.cos(a), math.sin(a)
    return ((c, -s, 0), (s, c, 0), (0, 0, 1))


def _mm(A, B):
    return tuple(tuple(sum(A[i][k] * B[k][j] for k in range(3)) for j in range(3)) for i in range(3))


def _mv(A, v):
    return tuple(A[i][0] * v[0] + A[i][1] * v[1] + A[i][2] * v[2] for i in range(3))


def _add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _scale(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _norm(a):
    n = math.sqrt(_dot(a, a)) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


def _lerp3(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def _bil(q, u, v):
    """A point of the planar quad q = (TL, TR, BR, BL) at (u, v) in 0..1 (u across, v down)."""
    top = _lerp3(q[0], q[1], u)
    bot = _lerp3(q[3], q[2], u)
    return _lerp3(top, bot, v)


class Camera:
    """A pin-hole camera at ``pos`` looking along -Z after a pitch (looking down by ``pitch`` radians)."""

    def __init__(self, pos, pitch: float):
        self.pos = pos
        self.R = _rx(pitch)  # world -> view

    def view(self, p):
        return _mv(self.R, _sub(p, self.pos))

    def project(self, p):
        v = self.view(p)
        z = -v[2] if v[2] < -1e-6 else 1e-6
        return (v[0] / z, -v[1] / z)


class Book:
    """A book posed in the world: local X across (spine at 0, fore-edge at w), Y up (tail 0, head h), Z out of the
    front (front at 0, back at -t). ``R``, ``T``: world = R · (local - pivot) + T."""

    def __init__(self, src: Source, *, kind: str = "paperback", R=None, T=(0.0, 0.0, 0.0), pivot=None):
        self.src, self.kind = src, kind
        self.w, self.h, self.t = src.w_in, src.h_in, src.t_in
        if kind == "hardcover":
            self.w, self.h, self.t = src.w_in + 0.25, src.h_in + 0.25, src.t_in + 0.25
        self.R = R or ((1, 0, 0), (0, 1, 0), (0, 0, 1))
        self.T = T
        self.pivot = pivot if pivot is not None else (self.w / 2, 0.0, -self.t / 2)

    def world(self, p):
        return _add(_mv(self.R, _sub(p, self.pivot)), self.T)

    def corners(self):
        w, h, t = self.w, self.h, self.t
        return [self.world((x, y, z)) for x in (0, w) for y in (0, h) for z in (0, -t)]

    def faces(self):
        """[(name, local quad TL TR BR BL as seen from outside, local normal)]."""
        w, h, t = self.w, self.h, self.t
        return [
            ("front", ((0, h, 0), (w, h, 0), (w, 0, 0), (0, 0, 0)), (0, 0, 1)),
            ("back", ((w, h, -t), (0, h, -t), (0, 0, -t), (w, 0, -t)), (0, 0, -1)),
            ("spine", ((0, h, -t), (0, h, 0), (0, 0, 0), (0, 0, -t)), (-1, 0, 0)),
            ("fore", ((w, h, 0), (w, h, -t), (w, 0, -t), (w, 0, 0)), (1, 0, 0)),
            ("head", ((0, h, -t), (w, h, -t), (w, h, 0), (0, h, 0)), (0, 1, 0)),
            ("tail", ((0, 0, 0), (w, 0, 0), (w, 0, -t), (0, 0, -t)), (0, -1, 0)),
        ]


SHADOW_DIR = _norm((0.42, -1.0, -0.38))  # the direction the light travels (the shadow falls right and back)
PAPER = {"cream": (243, 234, 214), "white": (248, 247, 242)}


def _hull(pts):
    pts = sorted(set((round(x, 3), round(y, 3)) for x, y in pts))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _grow(poly, d):
    cx_ = sum(p[0] for p in poly) / len(poly)
    cy_ = sum(p[1] for p in poly) / len(poly)
    out = []
    for x, y in poly:
        dx, dy = x - cx_, y - cy_
        n = math.hypot(dx, dy) or 1.0
        out.append((x + dx / n * d, y + dy / n * d))
    return out


def _pts(poly) -> str:
    return " ".join(f"{_f(x)},{_f(y)}" for x, y in poly)


class Scene:
    """Books seen by a camera, fitted into a box of the output picture -> SVG defs and body."""

    def __init__(self, books: list[Book], cam: Camera, *, floor_y: float = 0.0, shadow: bool = True,
                 light=(0.45, 0.55, 0.7)):
        self.books, self.cam, self.floor_y, self.shadow = books, cam, floor_y, shadow
        self.light = _norm(light)   # where the light comes from (in front, above, on the side the front faces)
        self.k, self.ox, self.oy = 1.0, 0.0, 0.0
        self.max_error = 0.0       # px: the worst cell corner (tests)
        self.cells = 0

    def _shadow_pts(self, b: Book):
        out = []
        for p in b.corners():
            s = (self.floor_y - p[1]) / SHADOW_DIR[1]
            out.append(_add(p, _scale(SHADOW_DIR, s)))
        return out

    def fit(self, box, margin: float = 0.06):
        pts = []
        for b in self.books:
            pts += [self.cam.project(p) for p in b.corners()]
        x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts)
        y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
        bx, by, bw, bh = box
        m = min(bw, bh) * margin
        self.k = min((bw - 2 * m) / max(1e-9, x1 - x0), (bh - 2 * m) / max(1e-9, y1 - y0))
        self.ox = bx + bw / 2 - (x0 + x1) / 2 * self.k
        self.oy = by + bh / 2 - (y0 + y1) / 2 * self.k
        return self

    def px(self, p):
        x, y = self.cam.project(p)
        return (x * self.k + self.ox, y * self.k + self.oy)

    def svg(self, prefix: str) -> tuple[list[str], list[str]]:
        defs, body = [], []
        n = [0]

        def nid(kind):
            n[0] += 1
            return f"{prefix}{kind}{n[0]}"
        if self.shadow:
            blur = nid("blur")
            size = self.k * max(b.h for b in self.books)
            defs.append(f'<filter id="{blur}" x="-50%" y="-50%" width="200%" height="200%">'
                        f'<feGaussianBlur stdDeviation="{_f(size * 0.025)}"/></filter>')
            soft = nid("blur")
            defs.append(f'<filter id="{soft}" x="-50%" y="-50%" width="200%" height="200%">'
                        f'<feGaussianBlur stdDeviation="{_f(size * 0.008)}"/></filter>')
            for b in self.books:
                hull = _hull([self.px(p) for p in self._shadow_pts(b)])
                body.append(f'<polygon points="{_pts(hull)}" fill="#000" fill-opacity="0.30" filter="url(#{blur})"/>')
                base = [b.world((x, 0, z)) for x in (0, b.w) for z in (0, -b.t)] if b.R[1][1] > 0.5 else \
                    [p for p in b.corners() if abs(p[1] - self.floor_y) < 1e-6 or p[1] <= min(q[1] for q in b.corners()) + 1e-6]
                hull = _hull([self.px(p) for p in base])
                if len(hull) >= 3:
                    body.append(f'<polygon points="{_pts(_grow(hull, size * 0.004))}" fill="#000" fill-opacity="0.45" '
                                f'filter="url(#{soft})"/>')
        # far books first
        order = sorted(self.books, key=lambda b: self.cam.view(b.world((b.w / 2, b.h / 2, -b.t / 2)))[2])
        for b in order:
            self._book(b, defs, body, nid)
        return defs, body

    # ------------------------------------------------------------------ one book
    def _visible(self, b: Book, quad, normal) -> bool:
        n = _mv(b.R, normal)
        c = b.world(_bil(quad, 0.5, 0.5))
        return _dot(n, _sub(self.cam.pos, c)) > 1e-6

    def _shade(self, b: Book, normal) -> float:
        n = _mv(b.R, normal)
        return max(0.0, min(0.45, (1.0 - max(0.0, _dot(n, self.light))) * 0.5))

    def _book(self, b: Book, defs, body, nid):
        src = b.src
        col = src.colors
        for name, quad, normal in b.faces():
            if not self._visible(b, quad, normal):
                continue
            poly = [self.px(b.world(p)) for p in quad]
            shade = self._shade(b, normal)
            if name in ("front", "back", "spine"):
                tex = getattr(src, name)
                if b.kind == "hardcover" and name != "spine":
                    # the boards overhang the pages: the case is the face, the printed cover inside it
                    body.append(f'<polygon points="{_pts(poly)}" fill="{_hex(_mix(col["background"], (0, 0, 0), 0.25))}"/>')
                    inset = 0.125 / b.w, 0.125 / b.h
                    quad_in = (_bil(quad, inset[0] if name == "front" else 0, inset[1]),
                               _bil(quad, 1 - (0 if name == "front" else inset[0]), inset[1]),
                               _bil(quad, 1 - (0 if name == "front" else inset[0]), 1 - inset[1]),
                               _bil(quad, inset[0] if name == "front" else 0, 1 - inset[1]))
                    if name == "front":  # the printed front starts after the hinge
                        quad_in = (_bil(quad, 0.0, 0.0), quad[1], quad[2], _bil(quad, 0.0, 1.0))
                    self._texture(b, quad_in, tex, defs, body, nid)
                elif tex is None:
                    body.append(f'<polygon points="{_pts(poly)}" fill="{_hex(col["background"])}"/>')
                else:
                    self._texture(b, quad, tex, defs, body, nid)
                if name == "spine" and b.kind == "hardcover":
                    g = nid("rnd")
                    a, c_ = _mid(poly[0], poly[3]), _mid(poly[1], poly[2])
                    defs.append(f'<linearGradient id="{g}" gradientUnits="userSpaceOnUse" x1="{_f(a[0])}" '
                                f'y1="{_f(a[1])}" x2="{_f(c_[0])}" y2="{_f(c_[1])}">'
                                '<stop offset="0" stop-color="#000" stop-opacity="0.45"/>'
                                '<stop offset="0.45" stop-color="#fff" stop-opacity="0.10"/>'
                                '<stop offset="1" stop-color="#000" stop-opacity="0.35"/></linearGradient>')
                    body.append(f'<polygon points="{_pts(poly)}" fill="url(#{g})"/>')
                if shade > 0.01:
                    body.append(f'<polygon points="{_pts(poly)}" fill="#000" fill-opacity="{_f(shade)}"/>')
                if name == "front":
                    self._gloss(b, quad, poly, defs, body, nid)
            else:
                self._pages(b, name, quad, poly, shade, body)

    def _texture(self, b: Book, quad, tex, defs, body, nid):
        """The cover panel ``tex`` on the face ``quad``: a grid of cells, each a polygon (its projected quad, grown
        a little so no hair-line shows between cells) filled with a pattern whose tile is that cell of the cover
        under the cell's affine map. One fill per cell: drawing the cover itself under many small clips would show
        a fine grid wherever the cover has see-through layers (each clip edge blends them twice)."""
        gid, (sx, sy, sw, sh) = tex
        nu, nv = 2, 3
        while True:
            err = self._grid_error(b, quad, nu, nv)
            if err <= MAX_CELL_ERROR_PX or nu * nv >= 600:
                break
            nu, nv = min(24, nu * 2), min(25, nv * 2)
        self.max_error = max(self.max_error, err)
        grow = 0.6
        for i in range(nu):
            for j in range(nv):
                u0, u1, v0, v1 = i / nu, (i + 1) / nu, j / nv, (j + 1) / nv
                p00 = self.px(b.world(_bil(quad, u0, v0)))
                p10 = self.px(b.world(_bil(quad, u1, v0)))
                p11 = self.px(b.world(_bil(quad, u1, v1)))
                p01 = self.px(b.world(_bil(quad, u0, v1)))
                su0, su1 = sx + sw * u0, sx + sw * u1
                sv0, sv1 = sy + sh * v0, sy + sh * v1
                du, dv = su1 - su0, sv1 - sv0
                a = (p10[0] - p00[0]) / du
                bb = (p10[1] - p00[1]) / du
                c = (p01[0] - p00[0]) / dv
                d = (p01[1] - p00[1]) / dv
                e = p00[0] - a * su0 - c * sv0
                f = p00[1] - bb * su0 - d * sv0
                # the tile: this cell of the cover with a margin (so the grown polygon never shows the next tile)
                mu, mv = du * 0.25, dv * 0.25
                tx, ty, tw, th = su0 - mu, sv0 - mv, du + 2 * mu, dv + 2 * mv
                pid = nid("p")
                defs.append(f'<pattern id="{pid}" patternUnits="userSpaceOnUse" x="{_f(tx)}" y="{_f(ty)}" '
                            f'width="{_f(tw)}" height="{_f(th)}" patternTransform="matrix({_f6(a)} {_f6(bb)} '
                            f'{_f6(c)} {_f6(d)} {_f(e)} {_f(f)})"><use href="#{gid}" xlink:href="#{gid}" '
                            f'transform="translate({_f(-tx)} {_f(-ty)})"/></pattern>')
                body.append(f'<polygon points="{_pts(_grow([p00, p10, p11, p01], grow))}" fill="url(#{pid})"/>')
                self.cells += 1

    def _grid_error(self, b: Book, quad, nu, nv) -> float:
        worst = 0.0
        for i in (0, nu - 1, nu // 2):
            for j in (0, nv - 1, nv // 2):
                u0, u1, v0, v1 = i / nu, (i + 1) / nu, j / nv, (j + 1) / nv
                p00 = self.px(b.world(_bil(quad, u0, v0)))
                p10 = self.px(b.world(_bil(quad, u1, v0)))
                p01 = self.px(b.world(_bil(quad, u0, v1)))
                p11 = self.px(b.world(_bil(quad, u1, v1)))
                guess = (p10[0] + p01[0] - p00[0], p10[1] + p01[1] - p00[1])
                worst = max(worst, math.hypot(guess[0] - p11[0], guess[1] - p11[1]))
        return worst

    def _gloss(self, b: Book, quad, poly, defs, body, nid):
        g = nid("gl")
        a, c = _mid(poly[0], poly[3]), _mid(poly[1], poly[2])
        strength = 0.10 if b.kind == "hardcover" else 0.16
        defs.append(f'<linearGradient id="{g}" gradientUnits="userSpaceOnUse" x1="{_f(a[0])}" y1="{_f(a[1])}" '
                    f'x2="{_f(c[0])}" y2="{_f(c[1])}">'
                    '<stop offset="0" stop-color="#000" stop-opacity="0.22"/>'
                    '<stop offset="0.035" stop-color="#fff" stop-opacity="0.22"/>'
                    '<stop offset="0.06" stop-color="#000" stop-opacity="0.10"/>'
                    f'<stop offset="0.16" stop-color="#fff" stop-opacity="{_f(strength)}"/>'
                    '<stop offset="0.42" stop-color="#fff" stop-opacity="0"/>'
                    f'<stop offset="0.78" stop-color="#fff" stop-opacity="{_f(strength * 0.35)}"/>'
                    '<stop offset="1" stop-color="#000" stop-opacity="0.06"/></linearGradient>')
        body.append(f'<polygon points="{_pts(poly)}" fill="url(#{g})"/>')

    def _pages(self, b: Book, name, quad, poly, shade, body):
        """A head / fore-edge / tail face: the cover's edge, then the page block with fine lines."""
        col = b.src.colors
        paper = PAPER.get(b.src.paper, PAPER["cream"])
        edge = _mix(col["background"], (0, 0, 0), 0.2)
        body.append(f'<polygon points="{_pts(poly)}" fill="{_hex(edge)}"/>')
        board = (0.1 if b.kind == "hardcover" else 0.018) / max(b.t, 0.05)
        board = min(0.3, board)
        over = (0.125 / b.w) if b.kind == "hardcover" else 0.0
        if name == "fore":  # across = Z (front → back), down = Y
            ua, ub, va, vb = board, 1 - board, (0.125 / b.h if b.kind == "hardcover" else 0), \
                1 - (0.125 / b.h if b.kind == "hardcover" else 0)
            lines = [((u, va), (u, vb)) for u in _steps(ua, ub, 14)]
        else:  # head / tail: across = X (spine → fore-edge), down = Z
            spine_side = (0.03 / b.w) if b.kind != "hardcover" else max(0.04, 0.2 / b.w)
            ua, ub = spine_side, 1 - over
            va, vb = board, 1 - board
            lines = [((ua, v), (ub, v)) for v in _steps(va, vb, 14)]
        inner = [self.px(b.world(_bil(quad, u, v))) for u, v in ((ua, va), (ub, va), (ub, vb), (ua, vb))]
        body.append(f'<polygon points="{_pts(inner)}" fill="{_hex(paper)}"/>')
        lc = _hex(_mix(paper, (120, 105, 80), 0.55))
        lw = max(0.4, self.k * 0.004)
        for (u0, v0), (u1, v1) in lines:
            p0 = self.px(b.world(_bil(quad, u0, v0)))
            p1 = self.px(b.world(_bil(quad, u1, v1)))
            body.append(f'<line x1="{_f(p0[0])}" y1="{_f(p0[1])}" x2="{_f(p1[0])}" y2="{_f(p1[1])}" stroke="{lc}" '
                        f'stroke-opacity="0.35" stroke-width="{_f(lw)}"/>')
        if shade > 0.01:
            body.append(f'<polygon points="{_pts(poly)}" fill="#000" fill-opacity="{_f(shade * 0.8)}"/>')


def _steps(a, b, n):
    return [a + (b - a) * (i + 0.5) / n for i in range(n)]


def _mid(a, b):
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)


def _f6(v: float) -> str:
    return f"{v:.6f}".rstrip("0").rstrip(".") or "0"


# ====================================================================== the mockup scenes
def scene_for(kind: str, srcs: list[Source]) -> Scene:
    """The posed books and the camera of a 3D mockup."""
    src = srcs[0]
    h = src.h_in
    if kind == "paperback":
        b = Book(src, R=_ry(math.radians(32)))
        cam = Camera((0.0, h * 1.55, h * 4.2), math.radians(16))
        return Scene([b], cam)
    if kind == "hardcover":
        b = Book(src, kind="hardcover", R=_ry(math.radians(-30)))
        cam = Camera((0.0, h * 1.4, h * 4.2), math.radians(14))
        return Scene([b], cam, light=(-0.45, 0.55, 0.7))
    if kind == "stack":
        books = []
        y = 0.0
        turns = (8, -6, 14)
        shifts = ((0.0, 0.0), (0.35, -0.2), (-0.25, 0.25))
        for i in range(3):
            pose = _mm(_ry(math.radians(turns[i])), _rx(math.radians(-90)))
            b = Book(src, R=pose, pivot=(src.w_in / 2, src.h_in / 2, -src.t_in))
            b.T = (shifts[i][0], y, shifts[i][1])
            books.append(b)
            y += src.t_in + 0.02
        cam = Camera((0.0, h * 3.0, h * 3.2), math.radians(42))
        return Scene(books, cam, floor_y=0.0, light=(0.25, 0.9, 0.35))
    if kind == "series":
        books = []
        n = len(srcs)
        gap = max(s.w_in for s in srcs) * 0.42
        for i, s in enumerate(srcs):
            b = Book(s, R=_ry(math.radians(30)))
            b.T = ((i - (n - 1) / 2) * gap, 0.0, -i * 0.9)
            books.append(b)
        cam = Camera((0.0, h * 1.6, h * 4.6), math.radians(15))
        return Scene(books, cam)
    raise ValueError(kind)


def _defs_body_scene(kind, srcs, box, prefix):
    sc = scene_for(kind, srcs).fit(box)
    defs, body = sc.svg(prefix)
    return defs, body, sc


def _use_front(src: Source, x, y, w, h, *, fit: str = "cover", extra: str = "") -> str:
    """The front cover (only the front panel, never the spine or the bleed around it) drawn into the box
    (x, y, w, h): 'cover' fills the box (cropping the cover), 'contain' fits the whole cover inside it."""
    gid, (sx, sy, sw, sh) = src.front
    if fit == "contain":
        k = min(w / sw, h / sh)
        x, y, w, h = x + (w - sw * k) / 2, y + (h - sh * k) / 2, sw * k, sh * k
    return (f'<svg x="{_f(x)}" y="{_f(y)}" width="{_f(w)}" height="{_f(h)}" viewBox="{_f(sx)} {_f(sy)} {_f(sw)} '
            f'{_f(sh)}" preserveAspectRatio="xMidYMid slice" overflow="hidden"{extra}>'
            f'<use href="#{gid}" xlink:href="#{gid}"/></svg>')


def device(kind: str, src: Source, box, prefix: str) -> tuple[list[str], list[str]]:
    """A flat device with the ebook cover on its screen, fitted into box."""
    bx, by, bw, bh = box
    defs, body = [], []
    col = src.colors
    # (corner radius, side bezel, top bezel, bottom bezel) as parts of the width; the tablet's and the e-reader's
    # screens have the cover's own shape (no empty strip), the phone's is tall (the cover sits in the middle)
    radius, side, top_b, bottom_b = {"phone": (0.12, 0.035, 0.035, 0.035), "tablet": (0.075, 0.06, 0.06, 0.06),
                                     "ereader": (0.03, 0.07, 0.07, 0.15)}[kind]
    _g, (_x, _y, fw, fh) = src.front
    screen_h = (1 - 2 * side) * (fh / fw) if kind != "phone" else 2.05 - 2 * side
    rw, rh = 1.0, top_b + screen_h + bottom_b
    k = min(bw * 0.82 / rw, bh * 0.86 / rh)
    W, H = rw * k, rh * k
    x, y = bx + (bw - W) / 2, by + (bh - H) / 2
    r = radius * W
    blur = f"{prefix}dsh"
    defs.append(f'<filter id="{blur}" x="-30%" y="-30%" width="160%" height="160%">'
                f'<feGaussianBlur stdDeviation="{_f(W * 0.03)}"/></filter>')
    body.append(f'<rect x="{_f(x + W * 0.03)}" y="{_f(y + W * 0.05)}" width="{_f(W)}" height="{_f(H)}" '
                f'rx="{_f(r)}" fill="#000" fill-opacity="0.35" filter="url(#{blur})"/>')
    shell = f"{prefix}shell"
    if kind == "ereader":
        defs.append(f'<linearGradient id="{shell}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a3a3c"/>'
                    '<stop offset="1" stop-color="#1d1d1f"/></linearGradient>')
    else:
        defs.append(f'<linearGradient id="{shell}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b2d31"/>'
                    '<stop offset="1" stop-color="#0c0d0f"/></linearGradient>')
    body.append(f'<rect x="{_f(x)}" y="{_f(y)}" width="{_f(W)}" height="{_f(H)}" rx="{_f(r)}" fill="url(#{shell})"/>')
    body.append(f'<rect x="{_f(x + 1.5)}" y="{_f(y + 1.5)}" width="{_f(W - 3)}" height="{_f(H - 3)}" rx="{_f(r)}" '
                'fill="none" stroke="#fff" stroke-opacity="0.12" stroke-width="2"/>')
    s = side * W
    top = top_b * W
    bottom = bottom_b
    sx, sy, sw, sh = x + s, y + top, W - 2 * s, H - top - bottom_b * W
    sr = r * 0.82 if kind == "phone" else r * 0.35
    clip = f"{prefix}scr"
    defs.append(f'<clipPath id="{clip}"><rect x="{_f(sx)}" y="{_f(sy)}" width="{_f(sw)}" height="{_f(sh)}" '
                f'rx="{_f(sr)}"/></clipPath>')
    screen_bg = (236, 233, 225) if kind == "ereader" else col["background"]
    body.append(f'<rect x="{_f(sx)}" y="{_f(sy)}" width="{_f(sw)}" height="{_f(sh)}" rx="{_f(sr)}" '
                f'fill="{_hex(screen_bg)}"/>')
    extra = ""
    if kind == "ereader":
        gray = f"{prefix}gray"
        defs.append(f'<filter id="{gray}"><feColorMatrix type="saturate" values="0"/>'
                    '<feComponentTransfer><feFuncR type="linear" slope="0.92" intercept="0.03"/>'
                    '<feFuncG type="linear" slope="0.92" intercept="0.03"/>'
                    '<feFuncB type="linear" slope="0.9" intercept="0.03"/></feComponentTransfer></filter>')
        extra = f' filter="url(#{gray})"'
    pad = 0.0 if kind == "phone" else sw * 0.0
    body.append(f'<g clip-path="url(#{clip})">' + _use_front(src, sx + pad, sy + pad, sw - 2 * pad, sh - 2 * pad,
                                                            fit="contain",
                                                            extra=extra) + "</g>")
    if kind != "ereader":  # glass
        gl = f"{prefix}glass"
        defs.append(f'<linearGradient id="{gl}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" '
                    'stop-opacity="0.16"/><stop offset="0.42" stop-color="#fff" stop-opacity="0.03"/>'
                    '<stop offset="0.43" stop-color="#fff" stop-opacity="0"/></linearGradient>')
        body.append(f'<rect x="{_f(sx)}" y="{_f(sy)}" width="{_f(sw)}" height="{_f(sh)}" rx="{_f(sr)}" '
                    f'fill="url(#{gl})"/>')
    if kind == "phone":  # the camera
        body.append(f'<rect x="{_f(x + W * 0.38)}" y="{_f(sy + W * 0.03)}" width="{_f(W * 0.24)}" '
                    f'height="{_f(W * 0.06)}" rx="{_f(W * 0.03)}" fill="#050505"/>')
    elif kind == "tablet":
        body.append(f'<circle cx="{_f(x + W / 2)}" cy="{_f(y + top / 2)}" r="{_f(W * 0.008)}" fill="#050505"/>')
    else:
        body.append(f'<text x="{_f(x + W / 2)}" y="{_f(y + H - bottom * W * 0.42)}" text-anchor="middle" '
                    f'{cx._svg_font("Helvetica")} font-size="{_f(W * 0.035)}" fill="#8a8a8e" '  # noqa: SLF001
                    'letter-spacing="2">e-reader</text>')
    return defs, body


# ====================================================================== backgrounds and words
def background(prefix: str, src: Source, w: float, h: float, *, floor: bool = True) -> tuple[list[str], list[str]]:
    """The cover's colours as a backdrop: a soft gradient, a glow in the accent colour and a floor."""
    col = src.colors
    light = bool(src.template.get("light"))
    top = _mix(col["background"], (255, 255, 255), 0.14 if not light else 0.0)
    bottom = _mix(col["background"], (0, 0, 0), 0.38 if not light else 0.1)
    g, r = f"{prefix}bg", f"{prefix}glow"
    defs = [f'<linearGradient id="{g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{_hex(top)}"/>'
            f'<stop offset="1" stop-color="{_hex(bottom)}"/></linearGradient>',
            f'<radialGradient id="{r}" cx="0.5" cy="0.45" r="0.55"><stop offset="0" stop-color="{_hex(col["accent"])}" '
            f'stop-opacity="{0.22 if not light else 0.16}"/><stop offset="1" stop-color="{_hex(col["accent"])}" '
            'stop-opacity="0"/></radialGradient>']
    body = [f'<rect x="0" y="0" width="{_f(w)}" height="{_f(h)}" fill="url(#{g})"/>',
            f'<rect x="0" y="0" width="{_f(w)}" height="{_f(h)}" fill="url(#{r})"/>']
    if floor:
        fl = f"{prefix}floor"
        defs.append(f'<linearGradient id="{fl}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" '
                    'stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.28"/></linearGradient>')
        body.append(f'<rect x="0" y="{_f(h * 0.7)}" width="{_f(w)}" height="{_f(h * 0.3)}" fill="url(#{fl})"/>')
    return defs, body


class Text:
    """Typeset words placed by their top: the lines, their boxes (for the safe-area checks) and the SVG."""

    def __init__(self):
        self.svg: list[str] = []
        self.boxes: list[tuple] = []   # (x, y, w, h, role)

    def block(self, text, font, *, box, max_size, min_size, max_lines, color, align="center", lead=1.12,
              track_em=0.0, upper=False, role="text", valign="top") -> float:
        """Set ``text`` as large as fits ``box`` (x, y, w, h); returns the bottom y. Nothing when empty."""
        x, y, w, h = box
        t = cx.safe(text or "").replace("\n", " ").strip()
        if upper:
            t = t.upper()
        if not t or w <= 4 or h <= 4:
            return y
        size, lines, _cut = cx.fit_text(t, font, max_size=max_size, min_size=min_size, width=w, max_lines=max_lines,
                                        max_height=h, lead=lead, track_em=track_em)
        bh = cx.block_height(len(lines), font, size, lead)
        top = y if valign == "top" else (y + (h - bh) / 2 if valign == "middle" else y + h - bh)
        base = top + cx.asc(font) * size
        track = track_em * size
        for ln in lines:
            lw = cx.measure(ln, font, size, track)
            lx = x + (w - lw) / 2 if align == "center" else x
            ls = f' letter-spacing="{_f(track)}"' if track else ""
            self.svg.append(f'<text x="{_f(lx)}" y="{_f(base)}" {cx._svg_font(font)} font-size="{_f(size)}" '  # noqa: SLF001
                            f'fill="{_hex(color)}"{ls} textLength="{_f(lw)}" lengthAdjust="spacingAndGlyphs">'
                            f"{_esc(ln)}</text>")
            self.boxes.append((lx, base - cx.asc(font) * size, lw, (cx.asc(font) + cx.desc(font)) * size, role))
            base += size * lead
        return top + bh

    def button(self, text, *, cx_, top, max_w, size, fill, color, font="Helvetica-Bold", role="cta") -> float:
        t = cx.safe(text or "").strip().upper()
        if not t:
            return top
        track = 0.12 * size
        tw = cx.measure(t, font, size, track)
        while tw > max_w * 0.84 and size > 6:
            size *= 0.95
            track = 0.12 * size
            tw = cx.measure(t, font, size, track)
        pad_x, pad_y = size * 1.1, size * 0.75
        bw, bh = tw + 2 * pad_x, (cx.asc(font) + cx.desc(font)) * size + 2 * pad_y
        x = cx_ - bw / 2
        self.svg.append(f'<rect x="{_f(x)}" y="{_f(top)}" width="{_f(bw)}" height="{_f(bh)}" rx="{_f(bh / 2)}" '
                        f'fill="{_hex(fill)}"/>')
        base = top + pad_y + cx.asc(font) * size
        self.svg.append(f'<text x="{_f(x + pad_x)}" y="{_f(base)}" {cx._svg_font(font)} font-size="{_f(size)}" '  # noqa: SLF001
                        f'fill="{_hex(color)}" letter-spacing="{_f(track)}" textLength="{_f(tw)}" '
                        f'lengthAdjust="spacingAndGlyphs">{_esc(t)}</text>')
        self.boxes.append((x, top, bw, bh, role))
        return top + bh


def _cta_colors(src: Source):
    col = src.colors
    fill = col["accent"]
    ink = col["background"] if contrast(col["background"], fill) >= contrast((255, 255, 255), fill) else (255, 255, 255)
    if contrast(ink, fill) < 3.0:
        ink = (0, 0, 0) if _lum(fill) > 0.4 else (255, 255, 255)
    return fill, ink


def _text_color(src: Source):
    col = src.colors
    t = col["text"]
    bg = _mix(col["background"], (0, 0, 0), 0.15)
    if contrast(t, bg) < 4.5:
        t = (255, 255, 255) if _lum(bg) < 0.4 else (17, 17, 17)
    return t


# ====================================================================== the pieces
def piece_list(app, pid: str, branch: str, *, srcs: list[Source] | None = None) -> list[dict]:
    """Every piece the page offers, in gallery order."""
    out = []
    series = bool(srcs) if srcs is not None else bool(series_sources(app, pid, branch))
    for m, (label, line) in MOCKUPS.items():
        if m == "series" and not series:
            continue
        out.append({"id": m, "group": "mockup", "mockup": m, "label": f"{label} (see-through)", "line": line,
                    "width": MOCKUP_PX, "height": MOCKUP_PX, "raster": "png", "transparent": True,
                    "note": "A PNG with no background: put it on anything (your website, a post, a flyer)."})
        out.append({"id": f"{m}-bg", "group": "mockup", "mockup": m, "label": f"{label} (on a background)",
                    "line": line, "width": MOCKUP_PX, "height": MOCKUP_PX, "raster": "jpg", "transparent": False,
                    "note": "A JPG on a backdrop in your cover's colours."})
    for a, spec in ADS.items():
        out.append({"id": a, "group": "ad", "label": spec["label"], "line": spec["line"], "width": spec["w"],
                    "height": spec["h"], "raster": "jpg", "transparent": False, "note": spec["note"]})
    for c, spec in CLIPS.items():
        out.append({"id": c, "group": "clip", "label": spec["label"], "line": spec["line"], "width": spec["w"],
                    "height": spec["h"], "raster": "webm", "transparent": False,
                    "note": "Made by AutoInjector from four pictures with a slow zoom (WebM, and MP4 when ffmpeg is "
                            "on the computer)."})
    return out


def _wrap_svg(w, h, defs, body, title) -> str:
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" '
            'xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" '
            f'viewBox="0 0 {_f(w)} {_f(h)}" width="{_f(w)}" height="{_f(h)}" role="img" aria-label="{_esc(title)}">'
            f"<title>{_esc(title)}</title><defs>{''.join(defs)}</defs>{''.join(body)}</svg>")


def mockup_svg(kind: str, srcs: list[Source], *, with_bg: bool, size: int = MOCKUP_PX) -> tuple[str, dict]:
    src = srcs[0]
    defs = [d for s in (srcs if kind == "series" else srcs[:1]) for d in s.defs]
    body: list[str] = []
    info: dict = {"kind": kind}
    if with_bg:
        bd, bb = background("bg-", src, size, size, floor=kind not in ("phone", "tablet", "ereader"))
        defs += bd
        body += bb
    box = (0, 0, size, size)
    if kind in ("phone", "tablet", "ereader"):
        dd, db = device(kind, src, box, "d-")
    else:
        dd, db, sc = _defs_body_scene(kind, srcs, box, "m-")
        info["max_cell_error_px"] = round(sc.max_error, 3)
        info["cells"] = sc.cells
    defs += dd
    body += db
    title = f"{(src.texts.get('title') or 'Book').strip()} — {MOCKUPS[kind][0]}"
    return _wrap_svg(size, size, defs, body, title), info


def _book_box(kind_scene: str, srcs, box, prefix, defs, body):
    if kind_scene in ("phone", "tablet", "ereader"):
        dd, db = device(kind_scene, srcs[0], box, prefix)
    else:
        dd, db, _sc = _defs_body_scene(kind_scene, srcs, box, prefix)
    defs += dd
    body += db


def ad_svg(ad: str, srcs: list[Source], w: dict) -> tuple[str, dict]:
    """An ad: the mockup, the hook and the call to action in the cover's colours, the words inside ``safe``."""
    spec = ADS[ad]
    W, H = spec["w"], spec["h"]
    src = srcs[0]
    t = src.template
    defs = list(src.defs)
    bd, bb = background("bg-", src, W, H)
    defs += bd
    body = list(bb)
    tx = Text()
    ink = _text_color(src)
    fill, cta_ink = _cta_colors(src)
    hook = w.get("hook") or ""
    cta = w.get("cta") or CTA_DEFAULT
    author = cx.safe(src.texts.get("author") or "").strip()
    hfont = t.get("title_font", "Times-Bold")
    sfont = t.get("sub_font", "Times-Italic")
    safe = spec["safe"]
    if ad == "ad-amazon":
        _book_box("paperback", srcs, (60, 60, W - 120, H - 120), "m-", defs, body)
    elif ad == "ad-square":
        l, tp, r, bt = safe
        _book_box("paperback", srcs, (0, 40, W * 0.56, H - 80), "m-", defs, body)
        col_x = W * 0.56
        cw = W - r - col_x
        y = tx.block(hook, sfont, box=(col_x, tp + 90, cw, 470), max_size=64, min_size=28, max_lines=6, color=ink,
                     role="hook", valign="middle")
        y = tx.button(cta, cx_=col_x + cw / 2, top=y + 46, max_w=cw, size=30, fill=fill, color=cta_ink)
        tx.block(author, t.get("author_font", "Times-Roman"), box=(col_x, y + 36, cw, 60), max_size=30, min_size=16,
                 max_lines=1, color=_mix(ink, src.colors["background"], 0.2), upper=True, track_em=0.12, role="author")
    elif ad == "ad-story":
        l, tp, r, bt = safe
        cw = W - l - r
        y = tx.block(hook, sfont, box=(l, tp + 20, cw, 400), max_size=84, min_size=40, max_lines=5, color=ink,
                     role="hook", valign="middle")
        cta_top = H - bt - 165
        _book_box("paperback", srcs, (0, y, W, cta_top - 10 - y), "m-", defs, body)
        y = tx.button(cta, cx_=W / 2, top=cta_top, max_w=cw, size=40, fill=fill, color=cta_ink)
        tx.block(author, t.get("author_font", "Times-Roman"), box=(l, y + 30, cw, 70), max_size=38, min_size=20,
                 max_lines=1, color=_mix(ink, src.colors["background"], 0.2), upper=True, track_em=0.12,
                 role="author")
    elif ad == "ad-landscape":
        l, tp, r, bt = safe
        _book_box("paperback", srcs, (0, 0, W * 0.47, H), "m-", defs, body)
        col_x = W * 0.49
        cw = W - r - col_x
        y = tx.block(hook, sfont, box=(col_x, tp + 30, cw, 300), max_size=54, min_size=24, max_lines=5, color=ink,
                     role="hook", valign="middle")
        y = tx.button(cta, cx_=col_x + cw / 2, top=y + 30, max_w=cw, size=26, fill=fill, color=cta_ink)
        tx.block(author, t.get("author_font", "Times-Roman"), box=(col_x, y + 22, cw, 44), max_size=24, min_size=14,
                 max_lines=1, color=_mix(ink, src.colors["background"], 0.2), upper=True, track_em=0.12,
                 role="author")
    elif ad == "ad-bookbub":
        l, tp, r, bt = safe
        _book_box("paperback", srcs, (0, 0, W * 0.48, H), "m-", defs, body)
        col_x = W * 0.49
        cw = W - r - col_x
        y = tx.block(hook, sfont, box=(col_x, tp + 4, cw, 150), max_size=20, min_size=11, max_lines=6, color=ink,
                     role="hook", valign="middle", lead=1.08)
        tx.button(cta, cx_=col_x + cw / 2, top=min(y + 12, H - bt - 34), max_w=cw, size=11, fill=fill, color=cta_ink)
    body += tx.svg
    title = f"{(src.texts.get('title') or 'Book').strip()} — {spec['label']}"
    return _wrap_svg(W, H, defs, body, title), {"text_boxes": tx.boxes, "safe": safe, "width": W, "height": H}


def frame_svg(clip: str, frame: str, srcs: list[Source], w: dict) -> tuple[str, dict]:
    """One picture of a teaser clip: 'scene' (the book, no words), 'hook', 'cover' (the front, large) or 'end'."""
    spec = CLIPS[clip]
    W, H = spec["w"], spec["h"]
    l, tp, r, bt = spec["safe"]
    src = srcs[0]
    t = src.template
    defs = list(src.defs)
    bd, bb = background("bg-", src, W, H, floor=frame in ("scene", "end"))
    defs += bd
    body = list(bb)
    tx = Text()
    ink = _text_color(src)
    fill, cta_ink = _cta_colors(src)
    cw = W - l - r
    if frame == "scene":
        _book_box("hardcover" if clip == "clip-vertical" else "paperback", srcs, (0, H * 0.12, W, H * 0.76), "m-",
                  defs, body)
    elif frame == "hook":
        tx.block(w.get("hook") or (src.texts.get("title") or ""), t.get("sub_font", "Times-Italic"),
                 box=(l + 20, tp, cw - 40, H - tp - bt), max_size=124 if H > W else 96, min_size=40, max_lines=7,
                 color=ink, role="hook", valign="middle")
        ay = tp + (H - tp - bt) * 0.5
        body.append(f'<rect x="{_f(W / 2 - 60)}" y="{_f(min(H - bt - 8, ay + 330 if H > W else ay + 300))}" '
                    f'width="120" height="4" fill="{_hex(src.colors["accent"])}"/>')
    elif frame == "cover":
        gid, (sx, sy, sw, sh) = src.front
        k = min(cw * 0.86 / sw, (H - tp - bt) * 0.94 / sh)
        cwid, chei = sw * k, sh * k
        x, y = (W - cwid) / 2, tp + ((H - tp - bt) - chei) / 2
        blur = "cv-sh"
        defs.append(f'<filter id="{blur}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur '
                    f'stdDeviation="{_f(W * 0.02)}"/></filter>')
        body.append(f'<rect x="{_f(x + W * 0.012)}" y="{_f(y + W * 0.02)}" width="{_f(cwid)}" height="{_f(chei)}" '
                    f'fill="#000" fill-opacity="0.45" filter="url(#{blur})"/>')
        clip_id = "cv-clip"
        defs.append(f'<clipPath id="{clip_id}"><rect x="{_f(x)}" y="{_f(y)}" width="{_f(cwid)}" height="{_f(chei)}"/>'
                    "</clipPath>")
        body.append(f'<g clip-path="url(#{clip_id})">' + _use_front(src, x, y, cwid, chei, fit="cover") + "</g>")
    elif frame == "end":
        title = src.texts.get("title") or ""
        top_h = (H - tp - bt) * (0.62 if H > W else 0.52)
        _book_box("paperback", srcs, (0, tp - (90 if H > W else 30), W, top_h + (90 if H > W else 60)), "m-", defs,
                  body)
        y = tx.block(title, t.get("title_font", "Times-Bold"), box=(l, tp + top_h + 10, cw, 260 if H > W else 150),
                     max_size=86 if H > W else 64, min_size=30, max_lines=3, color=ink, role="title",
                     upper=bool(t.get("title_upper")), track_em=float(t.get("title_track") or 0) * 0.5,
                     valign="middle")
        y = tx.button(w.get("cta") or CTA_DEFAULT, cx_=W / 2, top=y + 30, max_w=cw, size=40 if H > W else 34,
                      fill=fill, color=cta_ink)
        author = cx.safe(src.texts.get("author") or "").strip()
        tx.block(author, t.get("author_font", "Times-Roman"), box=(l, y + 26, cw, min(70, H - bt - (y + 26))),
                 max_size=38, min_size=16, max_lines=1, color=_mix(ink, src.colors["background"], 0.2), upper=True,
                 track_em=0.12, role="author")
    body += tx.svg
    return _wrap_svg(W, H, defs, body, f"Teaser {frame}"), {"text_boxes": tx.boxes, "safe": spec["safe"],
                                                           "width": W, "height": H}


# ====================================================================== fingerprints and the page
class Ctx:
    """What every piece is made from, worked out once per request."""

    def __init__(self, app, pid, branch):
        self.app, self.pid, self.branch = app, pid, branch
        self.src = source_of(app, pid, branch)
        self._series = None
        self.d = doc(app.store, pid, branch)
        self.w = words(app, pid, branch, self.d)

    @property
    def series(self) -> list[Source]:
        if self._series is None:
            self._series = series_sources(self.app, self.pid, self.branch)
        return self._series

    def srcs(self, piece: str) -> list[Source]:
        if piece.split("-bg")[0] == "series" and self.series:
            return self.series
        return [self.src]

    def cover_fp(self, piece: str) -> str:
        if piece.split("-bg")[0] == "series" and self.series:
            return _h(*[s.fp for s in self.series])
        return self.src.fp

    def words_fp(self, piece: str) -> str:
        if piece in ADS and piece != "ad-amazon":
            return _h(self.w["hook"], self.w["cta"])
        if piece in CLIPS:
            return _h(self.w["hook"], self.w["cta"], bool(self.d.get("animate")))
        return _h("")

    def fp(self, piece: str) -> str:
        return _h(LAYOUT_VERSION, piece, self.cover_fp(piece), self.words_fp(piece))

    def svg(self, piece: str) -> tuple[str, dict]:
        srcs = self.srcs(piece)
        if piece in ADS:
            return ad_svg(piece, srcs, self.w)
        base = piece[:-3] if piece.endswith("-bg") else piece
        if base in MOCKUPS:
            if base == "series" and len(srcs) < 2:
                raise _bad("/piece", "this book is not part of a series with other books yet")
            return mockup_svg(base, srcs, with_bg=piece.endswith("-bg"))
        raise _bad("/piece", "no such mockup or ad")


def _stale(ctx: Ctx, piece: str, rec: dict) -> list[str]:
    why = []
    if rec.get("cover_fp") and rec["cover_fp"] != ctx.cover_fp(piece):
        why.append("the cover changed since it was made")
    if rec.get("words_fp") and rec["words_fp"] != ctx.words_fp(piece):
        why.append("the words (the hook or the call to action) changed since it was made")
    if not why and rec.get("fp") and rec["fp"] != ctx.fp(piece):
        why.append("Akọwe draws it a little differently now")
    return why


def _asset_url(pid, branch, a) -> str | None:
    if not isinstance(a, dict) or not a.get("asset_id"):
        return None
    return f"/api/projects/{pid}/branches/{branch}/assets/{a['asset_id']}/{a.get('version') or 1}"


def info(app, pid: str, branch: str) -> dict:
    from . import cover, forge  # noqa: PLC0415
    ctx = Ctx(app, pid, branch)
    pieces = piece_list(app, pid, branch, srcs=ctx.series)
    base = f"/api/projects/{pid}/branches/{branch}/marketing"
    stale_n = 0
    for p in pieces:
        p["svg_url"] = None if p["group"] == "clip" else f"{base}/svg/{p['id']}"
        rec = (ctx.d["clips"] if p["group"] == "clip" else ctx.d["made"]).get(p["id"])
        p["made"] = None
        p["out_of_date"] = False
        p["out_of_date_why"] = []
        if isinstance(rec, dict):
            if p["group"] == "clip":
                p["made"] = {"url": _asset_url(pid, branch, rec.get("webm")), "mp4_url": _asset_url(pid, branch, rec.get("mp4")),
                             "at": rec.get("at"), "seconds": rec.get("seconds"), "warnings": rec.get("warnings") or [],
                             "animated": bool(rec.get("animated")), "file_url": f"{base}/file/{p['id']}"}
            else:
                p["made"] = {"url": _asset_url(pid, branch, rec), "at": rec.get("at"), "bytes": rec.get("bytes"),
                             "mime": rec.get("mime"), "file_url": f"{base}/file/{p['id']}",
                             "warnings": rec.get("warnings") or []}
            why = _stale(ctx, p["id"], rec)
            p["out_of_date"], p["out_of_date_why"] = bool(why), why
            stale_n += 1 if why else 0
    d = cover.get_design(app.store, pid, branch)
    try:
        bridge = forge.bridge_info(app)
    except Exception:  # noqa: BLE001
        bridge = None
    return {"revision": ctx.d.get("revision", 0), "words": ctx.w, "cta_choices": list(CTA_CHOICES),
            "animate": bool(ctx.d.get("animate")), "has_art": ctx.src.art is not None,
            "cover": {"designed": bool(d.get("revision")), "print_wrap": ctx.src.wrap,
                      "template": d.get("template"), "title": ctx.src.texts.get("title") or ""},
            "series": len(ctx.series), "pieces": pieces, "out_of_date": stale_n > 0, "out_of_date_count": stale_n,
            "made_count": sum(1 for p in pieces if p["made"]),
            "limits": {"hook": HOOK_MAX, "cta": CTA_MAX, "clip_seconds": list(CLIP_SECONDS)}, "bridge": bridge}


def save_words(app, pid: str, branch: str, body) -> dict:
    """PUT /marketing {hook?, cta?, animate?, revision?}: hook null/"" = the automatic one again."""
    if not isinstance(body, dict):
        raise _bad("/body", "send the words as JSON: {hook, cta}")
    ch = {}
    if "hook" in body:
        v = body["hook"]
        if v is not None and not isinstance(v, str):
            raise _bad("/hook", "hook: text (one short line), or empty for the automatic one")
        v = _clean_line(v, HOOK_MAX + 1) if v is not None else None
        if v is not None and len(v) > HOOK_MAX:
            raise _bad("/hook", f"the hook is longer than {HOOK_MAX} letters: keep it to one short line")
        ch["hook"] = v or None
    if "cta" in body:
        v = body["cta"]
        if v is not None and not isinstance(v, str):
            raise _bad("/cta", "cta: a few words, like “Available now”")
        v = _clean_line(v, CTA_MAX + 1) if v is not None else None
        if v is not None and len(v) > CTA_MAX:
            raise _bad("/cta", f"the call to action is longer than {CTA_MAX} letters: a few words are enough")
        ch["cta"] = v or None
    if "animate" in body:
        if not isinstance(body["animate"], bool):
            raise _bad("/animate", "animate: true or false")
        ch["animate"] = body["animate"]

    def fn(d):
        d.update(ch)
    _mutate(app.store, pid, branch, fn, body.get("revision"))
    return info(app, pid, branch)


# ====================================================================== making the pictures (AutoInjector)
def png_has_alpha(data: bytes) -> bool:
    """A PNG that can hold see-through pixels (colour type 4 / 6, or a tRNS chunk)."""
    if data[:8] != b"\x89PNG\r\n\x1a\n" or len(data) < 33:
        return False
    if data[25] in (4, 6):
        return True
    i = 8
    while i + 8 <= len(data):
        n, typ = struct.unpack(">I4s", data[i:i + 8])
        if typ == b"tRNS":
            return True
        if typ == b"IDAT":
            return False
        i += 12 + n
    return False


def _job(principal, pid, branch, kind, items):
    from .review import ReviewJob  # noqa: PLC0415

    class MarketingJob(ReviewJob):
        def public(self):
            out = super().public()
            out["total"] = len(self.record_ids)
            return out
    return MarketingJob(kind, principal, pid, branch, list(items), None)


def _check_scope(app, principal, pid, branch):
    if not app.store.has_scope(principal, pid, branch, "I01:create"):
        raise AkoweError("PERMISSION_DENIED", "", "missing scope I01:create", **_REJ)


def start_make(app, principal, pid, branch, body) -> dict:
    """POST /marketing/make {pieces?} -> 202 job: every picture (or the ones asked for) drawn by AutoInjector."""
    body = body if isinstance(body, dict) else {}
    _check_scope(app, principal, pid, branch)
    ctx = Ctx(app, pid, branch)
    all_ids = [p["id"] for p in piece_list(app, pid, branch, srcs=ctx.series) if p["group"] != "clip"]
    want = body.get("pieces")
    if want is None:
        ids = all_ids
    else:
        if not isinstance(want, list) or not want or any(not isinstance(x, str) for x in want):
            raise _bad("/pieces", "pieces: the list of pictures to make (or leave it out for all of them)")
        bad = [x for x in want if x not in all_ids]
        if bad:
            raise _bad("/pieces", f"no such picture: {', '.join(bad[:3])}")
        ids = [x for x in all_ids if x in want]
    job = _job(principal, pid, branch, "marketing_pictures", ids)

    def fn(j):
        run_make(app, j, pid, branch, ids)
    return app.review._start(job, fn, same=tuple(ids))  # noqa: SLF001


def run_make(app, job, pid, branch, ids) -> None:
    from . import forge, render  # noqa: PLC0415
    ctx = Ctx(app, pid, branch)
    title = ctx.src.texts.get("title") or "Book"
    for n, piece in enumerate(ids, 1):
        job.check()
        job.current = piece
        p = next(x for x in piece_list(app, pid, branch, srcs=ctx.series) if x["id"] == piece)
        job.phase = f"AutoInjector is drawing {p['label']} ({n} of {len(ids)})"
        try:
            svg, _info = ctx.svg(piece)
            fmt = "png" if p["transparent"] else "jpeg"
            data = render.render_image(app, svg, p["width"], p["height"], fmt=fmt, quality=JPG_QUALITY,
                                       timeout_s=60.0)
        except forge.ArtProblem as exc:
            if exc.code in ("IMAGE_BRIDGE_UNREACHABLE", "IMAGE_BRIDGE_KEY", "RENDER_NOT_WIRED"):
                err = render.as_error(exc, "picture")
                job.status, job.phase = "error", "Failed"
                job.error = {"code": exc.code, "message": err.errors[0]["message"], "path": ""}
                return
            job.results.append({"ok": False, "piece": piece, "code": exc.code,
                                "message": f"{p['label']}: {exc.message}. {exc.hint}".strip()})
            job.done = n
            continue
        warnings = []
        if p["transparent"] and not png_has_alpha(data):
            warnings.append("AutoInjector drew it on a solid background, not see-through: update AutoInjector for "
                            "see-through PNGs.")
        asset = forge._store_asset(app.store, job.principal, pid, branch, data,  # noqa: SLF001
                                   "image/png" if fmt == "png" else "image/jpeg", f"{title} — {p['label']}")
        rec = dict(asset, bytes=len(data), width=p["width"], height=p["height"], at=_now(), fp=ctx.fp(piece),
                   cover_fp=ctx.cover_fp(piece), words_fp=ctx.words_fp(piece),
                   mime="image/png" if fmt == "png" else "image/jpeg", warnings=warnings or None)

        def fn(d, piece=piece, rec=rec):
            d["made"][piece] = {k: v for k, v in rec.items() if v is not None}
        _mutate(app.store, pid, branch, fn)
        job.done = n
        job.results.append({"ok": True, "piece": piece, "message": f"{p['label']} made."})
    ok = sum(1 for r in job.results if r.get("ok"))
    job.results.append({"ok": ok == len(ids), "message": f"{ok} of {len(ids)} picture(s) made and kept with the "
                                                         "book."})


# ====================================================================== the teaser clips (AutoInjector trailers)
def frame_dir(pid: str, branch: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", f"{pid}-{branch}")[:100] or "book"
    return os.path.join(PICTURES_ROOT or tempfile.gettempdir(), "akowe-teaser-pictures", safe)


def _write_file(folder: str, data: bytes, ext: str) -> str:
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, hashlib.sha256(data).hexdigest()[:32] + ext)
    if os.path.isfile(path) and os.path.getsize(path) == len(data):
        return path
    tmp = f"{path}.{os.getpid()}-{threading.get_ident()}.tmp"
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return path


def clip_plan(clip: str, frames: dict, *, art_path: str | None = None) -> list[dict]:
    """The items of one teaser (``POST /video/trailer``): the four frames as stills, the cover brought to life as a
    shot when ``art_path`` is given."""
    items = []
    for what, secs, motion in CLIP_FRAMES:
        if what == "cover" and art_path:
            items.append({"type": "shot", "image": art_path, "seconds": 4,
                          "prompt": "The book-cover picture comes slowly to life: a gentle camera push-in, soft "
                                    "natural movement, cinematic light. No text, letters or watermark."})
            continue
        items.append({"type": "still", "image": frames[what], "seconds": secs, "motion": motion})
    return items


def start_clips(app, principal, pid, branch, body) -> dict:
    """POST /marketing/clips {clips?, animate?} -> 202 job: the teaser clips made by AutoInjector."""
    body = body if isinstance(body, dict) else {}
    _check_scope(app, principal, pid, branch)
    want = body.get("clips")
    if want is None:
        ids = list(CLIPS)
    else:
        if not isinstance(want, list) or not want or any(x not in CLIPS for x in want):
            raise _bad("/clips", "clips: clip-vertical and / or clip-square")
        ids = [c for c in CLIPS if c in want]
    if "animate" in body:
        if not isinstance(body["animate"], bool):
            raise _bad("/animate", "animate: true or false")
        _mutate(app.store, pid, branch, lambda d: d.update(animate=body["animate"]))
    job = _job(principal, pid, branch, "marketing_clips", ids)

    def fn(j):
        run_clips(app, j, pid, branch, ids)
    return app.review._start(job, fn, same=tuple(ids))  # noqa: SLF001


def run_clips(app, job, pid, branch, ids) -> None:
    from . import forge, render  # noqa: PLC0415
    from . import trailer as tr  # noqa: PLC0415
    ctx = Ctx(app, pid, branch)
    animate = bool(ctx.d.get("animate"))
    targets = forge.bridge_targets(app)
    if not targets:
        job.status, job.phase = "error", "Failed"
        job.error = tr.TrailerProblem("IMAGE_BRIDGE_UNREACHABLE").as_error()
        return
    folder = frame_dir(pid, branch)
    title = ctx.src.texts.get("title") or "Book"
    art_path = None
    warn_all = []
    if animate:
        if ctx.src.art is None:
            warn_all.append("The cover has no picture to bring to life, so the clip shows the still cover.")
        else:
            data, inf = ctx.src.art
            art_path = _write_file(folder, data, "." + inf.ext)
    for n, clip in enumerate(ids, 1):
        job.check()
        job.current = clip
        spec = CLIPS[clip]
        warnings = list(warn_all)
        frames = {}
        try:
            for what, _s, _m in CLIP_FRAMES:
                job.phase = f"AutoInjector is drawing the pictures of the {spec['label'].lower()} ({what})"
                svg, _i = frame_svg(clip, what, ctx.srcs(clip), ctx.w)
                jpg = render.render_image(app, svg, spec["w"], spec["h"], fmt="jpeg", quality=JPG_QUALITY)
                frames[what] = _write_file(folder, jpg, ".jpg")
        except forge.ArtProblem as exc:
            err = render.as_error(exc, "teaser clip")
            job.status, job.phase = "error", "Failed"
            job.error = {"code": exc.code, "message": err.errors[0]["message"], "path": ""}
            return
        use_art = art_path
        res = None
        for _attempt in range(2):
            items = clip_plan(clip, frames, art_path=use_art)
            req = {"book": f"{title} - teaser {clip.split('-')[1]}"[:200], "title": title, "items": items,
                   "from": "akowe-teaser", "width": spec["w"], "height": spec["h"], "fps": 30, "fade": 0.35}
            job.phase = f"AutoInjector is making the {spec['label'].lower()}"
            try:
                res = _make_clip(app, job, targets, req)
            except tr.TrailerProblem as exc:
                if use_art and exc.code in SHOT_FALLBACK:
                    warnings.append(f"The cover picture could not be brought to life ({exc.message}), so the clip "
                                    "shows the still cover instead.")
                    use_art = None
                    continue
                if exc.code == "INVALID_PARAM" and "still" in (exc.message or "").lower() + str(exc.fix):
                    exc = tr.TrailerProblem("VIDEO_NOT_WIRED", "This AutoInjector cannot make clips from pictures "
                                                               "yet: update AutoInjector")
                job.status, job.phase, job.error = "error", "Failed", exc.as_error()
                return
            break
        if res is None:
            job.status, job.phase = "error", "Failed"
            job.error = tr.TrailerProblem("VIDEO_FAILED").as_error()
            return
        _store_clip(app, job, pid, branch, ctx, clip, res, warnings, animated=bool(use_art))
        job.done = n
    job.results.append({"ok": True, "message": f"{len(ids)} teaser clip(s) made and kept with the book."})


def _make_clip(app, job, targets, req) -> dict:
    """One clip: POST /video/trailer, then follow it until it is done -> its result. Raises TrailerProblem."""
    from . import forge  # noqa: PLC0415
    from . import trailer as tr  # noqa: PLC0415
    from .assist import Cancelled  # noqa: PLC0415
    try:
        resp, target = tr._call(app, targets, "POST", "/video/trailer", req, tr.START_TIMEOUT_S)  # noqa: SLF001
    except forge.ArtProblem as exc:
        p = tr._problem(exc)  # noqa: SLF001
        if exc.code == "INVALID_PARAM":
            p.message = f"{p.message} ({exc.message})"[:400]
        raise p from None
    if not resp.get("id") and resp.get("ok") and resp.get("path"):
        return resp
    tid = resp.get("id")
    if not tid:
        raise tr.TrailerProblem("VIDEO_BAD_ANSWER", "AutoInjector did not say which clip it started")
    started = time.time()
    misses = 0
    while True:
        try:
            job.check()
        except Cancelled:
            try:
                tr._call(app, [target], "POST", "/video/trailer/cancel", {}, 15.0)  # noqa: SLF001
            except forge.ArtProblem:
                pass
            raise
        if time.time() - started > CLIP_TIMEOUT_S:
            raise tr.TrailerProblem("VIDEO_TIMEOUT", "the clip took more than 3 hours")
        try:
            st, _t = tr._call(app, [target], "GET", f"/video/trailer?id={tid}", None, 30.0)  # noqa: SLF001
            misses = 0
        except forge.ArtProblem as exc:
            if exc.code == "VIDEO_NOT_WIRED":
                raise tr.TrailerProblem("TRAILER_LOST") from None
            misses += 1
            if exc.code in ("IMAGE_BRIDGE_UNREACHABLE", "VIDEO_TIMEOUT") and misses < STATUS_MISSES:
                _sleep(job, POLL_S)
                continue
            raise tr._problem(exc) from None  # noqa: SLF001
        s = st.get("status") or {}
        stage = str(s.get("phase") or "")
        if stage == "shots":
            job.phase = "AutoInjector is bringing the cover picture to life (a few minutes)" \
                if any(x["type"] == "shot" for x in req["items"]) else job.phase
        elif stage == "joining":
            job.phase = "AutoInjector is putting the pictures together into the clip (it plays once, in real time)"
        elif stage == "mp4":
            job.phase = "AutoInjector is making the MP4 copy"
        if not st.get("busy") and s.get("busy") is not True:
            res = st.get("result")
            if not isinstance(res, dict):
                raise tr.TrailerProblem("VIDEO_BAD_ANSWER", "AutoInjector finished without a result")
            if res.get("ok"):
                return res
            code = str(res.get("error") or res.get("code") or "VIDEO_FAILED")
            if code == "VIDEO_CANCELLED" and job.cancelled:
                raise Cancelled()
            raise tr._problem(forge.ArtProblem(code, str(res.get("message") or ""), "",  # noqa: SLF001
                                               str(res.get("model") or "")))
        _sleep(job, POLL_S)


def _sleep(job, s):
    end = time.time() + s
    while time.time() < end:
        if job.cancelled:
            return
        time.sleep(min(0.1, max(0.0, end - time.time())))


def _store_clip(app, job, pid, branch, ctx: Ctx, clip, res, warnings, *, animated: bool) -> None:
    from . import forge  # noqa: PLC0415
    from . import trailer as tr  # noqa: PLC0415
    job.phase = "Keeping the clip with the book"
    webm = tr._read_local(res.get("path"), MAX_CLIP_BYTES + 1)  # noqa: SLF001
    if not webm or len(webm) > MAX_CLIP_BYTES or forge.sniff_video(webm) is None:
        raise tr.TrailerProblem("VIDEO_BAD_ANSWER", "Akọwe could not read the clip AutoInjector made")
    mp4 = tr._read_local(res.get("mp4"), MAX_CLIP_BYTES) if res.get("mp4") else None  # noqa: SLF001
    if mp4 is not None and forge.sniff_video(mp4) != "video/mp4":
        mp4 = None
    title = ctx.src.texts.get("title") or "Book"
    a_webm = forge._store_asset(app.store, job.principal, pid, branch, webm, forge.sniff_video(webm),  # noqa: SLF001
                                f"{title} — {CLIPS[clip]['label']}")
    a_webm["bytes"] = len(webm)
    a_mp4 = None
    if mp4:
        a_mp4 = forge._store_asset(app.store, job.principal, pid, branch, mp4, "video/mp4",  # noqa: SLF001
                                   f"{title} — {CLIPS[clip]['label']} (MP4)")
        a_mp4["bytes"] = len(mp4)
    for w in res.get("warnings") or []:
        m = w.get("message") if isinstance(w, dict) else w
        if m:
            warnings.append(str(m)[:200])
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else None  # noqa: E731
    rec = {"webm": a_webm, "mp4": a_mp4, "seconds": num(res.get("seconds")), "width": num(res.get("width")),
           "height": num(res.get("height")), "at": _now(), "warnings": warnings[:10] or None, "animated": animated,
           "fp": ctx.fp(clip), "cover_fp": ctx.cover_fp(clip), "words_fp": ctx.words_fp(clip)}

    def fn(d):
        d["clips"][clip] = {k: v for k, v in rec.items() if v is not None}
    _mutate(app.store, pid, branch, fn)
    job.results.append({"ok": True, "piece": clip, "message": f"{CLIPS[clip]['label']} made"
                        + (f" ({rec['seconds']} s)" if rec["seconds"] else "") + "."})


# ====================================================================== files: one, all (zip), the book save
def _stem(app, pid, branch) -> str:
    from . import cover  # noqa: PLC0415
    t = cover.resolved_texts(app.store, pid, cover.get_design(app.store, pid, branch)).get("title") or "Book"
    return cover.file_stem(t, 40) or "Book"


def file_name(piece: str, ext: str) -> str:
    p = piece[:-3] if piece.endswith("-bg") else piece
    if p in MOCKUPS:
        return f"{MOCKUPS[p][0]}{' (on a background)' if piece.endswith('-bg') else ''}.{ext}"
    if piece in ADS:
        return f"Ad {ADS[piece]['w']}x{ADS[piece]['h']} {re.sub(r'[^A-Za-z ]', '', ADS[piece]['label'])}.{ext}"
    if piece in CLIPS:
        return f"{CLIPS[piece]['label']}.{ext}"
    return f"{piece}.{ext}"


def made_file(app, pid, branch, piece: str, fmt: str | None = None) -> tuple[bytes, str, str]:
    from . import forge  # noqa: PLC0415
    d = doc(app.store, pid, branch)
    if piece in CLIPS:
        rec = d["clips"].get(piece)
        key = "mp4" if fmt == "mp4" else "webm"
        a = (rec or {}).get(key)
        data = forge.picture_bytes(app.store, pid, branch, a) if a else None
        if not data:
            raise AkoweError("NOT_FOUND", "/piece", f"the {CLIPS[piece]['label'].lower()} has not been made yet"
                             + (" as an MP4 (AutoInjector found no ffmpeg)" if rec and key == "mp4" else "")
                             + ": press 🎬 Make the teaser clips", **_REJ)
        mime = a.get("mime") or forge.sniff_video(data) or "video/webm"
        return data, mime, f"{_stem(app, pid, branch)} - {file_name(piece, 'mp4' if mime == 'video/mp4' else 'webm')}"
    rec = d["made"].get(piece)
    data = forge.picture_bytes(app.store, pid, branch, rec) if rec else None
    if not data:
        raise AkoweError("NOT_FOUND", "/piece", "this picture has not been made yet: press 🖼 Make the pictures "
                         "(AutoInjector draws them), or download the SVG", **_REJ)
    mime = rec.get("mime") or "image/png"
    return data, mime, f"{_stem(app, pid, branch)} - {file_name(piece, 'png' if mime == 'image/png' else 'jpg')}"


def _readme(app, pid, branch, listing) -> str:
    lines = ["Mockups and ads of your book, made by Akọwe (📣 Mockups & ads).", "",
             "See-through PNGs have no background: put them on anything. JPGs are on a backdrop in your cover's "
             "colours.", "SVG files are the same pictures as drawings (any size, open them in a browser or Inkscape).",
             ""]
    for x in listing:
        lines.append(f"- {x['file']}: {x['label']} ({x['size']})" + (" — OUT OF DATE: " + "; ".join(x["why"])
                                                                       if x.get("why") else ""))
        if x.get("note"):
            lines.append(f"    {x['note']}")
    return "\n".join(lines) + "\n"


def all_files(app, pid, branch, *, svgs: str = "missing") -> tuple[dict, list]:
    """{name: bytes} of everything made (+ the SVG of each picture that has no PNG / JPG yet when svgs="missing", of
    every picture when "all") and the listing."""
    from . import forge  # noqa: PLC0415
    ctx = Ctx(app, pid, branch)
    files: dict = {}
    listing = []
    for p in piece_list(app, pid, branch, srcs=ctx.series):
        if p["group"] == "clip":
            rec = ctx.d["clips"].get(p["id"])
            if not isinstance(rec, dict):
                continue
            for key in ("webm", "mp4"):
                data = forge.picture_bytes(app.store, pid, branch, rec.get(key)) if rec.get(key) else None
                if data:
                    name = file_name(p["id"], "mp4" if forge.sniff_video(data) == "video/mp4" else "webm")
                    files[name] = data
                    listing.append({"file": name, "label": p["label"], "size": f"{p['width']} × {p['height']}",
                                    "note": p["line"], "why": _stale(ctx, p["id"], rec)})
            continue
        rec = ctx.d["made"].get(p["id"])
        data = forge.picture_bytes(app.store, pid, branch, rec) if isinstance(rec, dict) else None
        if data:
            name = file_name(p["id"], "png" if rec.get("mime") == "image/png" else "jpg")
            files[name] = data
            listing.append({"file": name, "label": p["label"], "size": f"{p['width']} × {p['height']}",
                            "note": p["note"], "why": _stale(ctx, p["id"], rec)})
        if svgs == "all" or (svgs == "missing" and not data):
            try:
                svg, _i = ctx.svg(p["id"])
            except AkoweError:
                continue
            name = file_name(p["id"], "svg")
            files[name] = svg.encode("utf-8")
            listing.append({"file": name, "label": p["label"], "size": f"{p['width']} × {p['height']}",
                            "note": p["note"]})
    return files, listing


def zip_all(app, pid, branch) -> tuple[bytes, str]:
    files, listing = all_files(app, pid, branch)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data, compress_type=zipfile.ZIP_STORED if name.endswith((".png", ".jpg", ".webm", ".mp4"))
                       else zipfile.ZIP_DEFLATED)
        z.writestr("About these files.txt", _readme(app, pid, branch, listing))
    return buf.getvalue(), f"{_stem(app, pid, branch)} - mockups and ads.zip"


def save_files(app, pid: str, branch: str, files: dict, text) -> None:
    """Marketing/ in the book's folder (once the page has been used): every picture and clip made, the SVG of each
    picture not made yet, and marketing.json (what each file is, and whether it is out of date)."""
    d = doc(app.store, pid, branch)
    if not d.get("revision") and not d["made"] and not d["clips"]:
        return
    got, listing = all_files(app, pid, branch)
    for name, data in got.items():
        files[f"Marketing/{name}"] = data
    text("Marketing/marketing.json", json.dumps({"words": words(app, pid, branch, d), "files": listing},
                                                ensure_ascii=False, indent=1))


# ====================================================================== HTTP
def _q(query: dict, k: str, default=None):
    v = (query or {}).get(k)
    return v[0] if isinstance(v, list) and v else (v if isinstance(v, str) else default)


def route(app, method: str, rest: list, query: dict, body, principal: str, pid: str, branch: str, headers):
    """/api/projects/:pid/branches/:b/marketing/… (one block in server.py)."""
    dl = "attachment" if _q(query, "download") == "1" else "inline"
    if rest == [] and method == "GET":
        return 200, info(app, pid, branch)
    if rest == [] and method == "PUT":
        return 200, save_words(app, pid, branch, body)
    if len(rest) == 2 and rest[0] == "svg" and method == "GET":
        ctx = Ctx(app, pid, branch)
        svg, _i = ctx.svg(rest[1])
        return 200, ("__binary__", "image/svg+xml", svg.encode("utf-8"),
                     f"{_stem(app, pid, branch)} - {file_name(rest[1], 'svg')}", dl)
    if len(rest) == 2 and rest[0] == "file" and method == "GET":
        data, mime, name = made_file(app, pid, branch, rest[1], _q(query, "format"))
        return 200, ("__binary__", mime, data, name, dl)
    if rest == ["zip"] and method == "GET":
        data, name = zip_all(app, pid, branch)
        return 200, ("__binary__", "application/zip", data, name, "attachment")
    if rest == ["make"] and method == "POST":
        return 202, start_make(app, principal, pid, branch, body)
    if rest == ["clips"] and method == "POST":
        return 202, start_clips(app, principal, pid, branch, body)
    if len(rest) == 2 and rest[0] == "jobs" and method == "GET":
        return 200, app.review.get_job(principal, rest[1])
    raise AkoweError("NOT_FOUND", "/marketing", "no such Mockups & ads endpoint", **_REJ)
