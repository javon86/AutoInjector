"""🎨 Book covers (plan item B3, lane A): templates, layout, print maths and the cover files, in pure Python.

One layout engine, two outputs. ``layout_front`` / ``layout_back`` / ``layout_spine`` turn a design (template, colours,
texts, optional artwork) into a small *display list* (rectangles, lines, polygons, alpha gradients, images, text with
tracking and rotation). ``render_pdf`` writes the display list as PDF pages (base-14 fonts with full AFM widths,
JPEG/PNG image XObjects, a soft-mask shading for every gradient) and ``render_svg`` writes the same list as SVG (the
ebook cover in the EPUB and the live preview). Positions are computed with the exact base-14 widths, so the title never
leaves the safe area; the SVG pins every line to the measured width (``textLength``) so a reader's stand-in font cannot
push it out either.

**Print maths** (Amazon KDP paperback rules, the strictest of the common print-on-demand services):
* bleed 0.125 in on the outer edges (top, bottom, the back's left and the front's right edge);
* spine width = page count × paper thickness: white paper 0.002252 in per page, cream 0.0025 in per page;
* full wrap = bleed + back trim width + spine + front trim width + bleed; height = bleed + trim height + bleed;
* trim sizes 5 × 8, 5.5 × 8.5 and 6 × 9 in; 24 to 828 pages on white, 24 to 776 on cream; an odd count is
  rounded up (the printer adds a blank page);
* text stays 0.375 in inside every trim edge and fold (KDP asks 0.25 in); spine text keeps 0.0625 in from each fold
  and is only set from ``SPINE_TEXT_MIN_PAGES`` (100) pages (KDP allows it from 80; under 100 the spine is so thin
  that a small drift of the fold puts the text on the front or back);
* barcode area: a blank white 2 × 1.2 in box at the bottom right of the back cover, 0.25 in from the spine fold and
  from the bottom trim edge (where KDP prints the ISBN barcode).

**Ebook cover without Pillow (the decision):** Akọwe does not rasterise. Drawing text into pixels needs glyph
outlines, and the base-14 fonts are never embedded (there are no outlines to draw); decoding the AI's JPEG needs a
full DCT decoder. So the ebook cover is (1) a one-page PDF (``GET …/cover/ebook``), (2) an SVG that layers the
artwork and the typeset text (``…/cover/ebook?format=svg``; in the EPUB it is the cover page, an inline SVG in
``cover.xhtml``), and (3) the artwork itself as the EPUB ``cover-image`` (the library thumbnail; the title is in the
metadata). Without artwork the SVG is the ``cover-image`` (SVG is an EPUB 3 core media type). The DOCX gets a cover
page with the title, the artwork and the author. See docs/COVERS.md.
"""
from __future__ import annotations

import base64
import math
import re
from xml.sax.saxutils import escape as _xml_escape
from xml.sax.saxutils import quoteattr as _xml_quoteattr

from .fontmetrics import DESCRIPTORS, WIDTHS
from .images import ImageInfo
from .pdf import PdfWriter, _xobject, image_matrix, num, parse_pdf_objects, pdf_string, pdf_text_string

IN = 72.0
BLEED_IN = 0.125
SAFE_IN = 0.375
SPINE_MARGIN_IN = 0.0625
SPINE_TEXT_MIN_PAGES = 100
BARCODE_IN = (2.0, 1.2)
BARCODE_INSET_IN = 0.25
TRIMS = {"5x8": (5.0, 8.0), "5.5x8.5": (5.5, 8.5), "6x9": (6.0, 9.0)}
PAPERS = {"white": 0.002252, "cream": 0.0025}           # inches per page (KDP, black-ink interiors)
PAPER_LABELS = {"white": "White paper", "cream": "Cream paper"}
MIN_PAGES = 24
MAX_PAGES = {"white": 828, "cream": 776}
EBOOK_PT = (432.0, 691.2)                                # 6 × 9.6 in: the 1600 × 2560 px (1 : 1.6) ebook shape
FONT_KEYS = ("Times-Roman", "Times-Bold", "Times-Italic", "Helvetica", "Helvetica-Bold", "Helvetica-Oblique")


class CoverError(ValueError):
    """A plain-words problem with the cover request (the caller maps it to INVALID_INPUT)."""

    def __init__(self, message: str, path: str = ""):
        super().__init__(message)
        self.message, self.path = message, path


# ====================================================================== templates
def _t(**kw):
    base = {"title_upper": False, "title_track": 0.0, "title_max": 0.15, "title_lead": 1.04, "align": "center",
            "art": "full", "sub_font": "Times-Italic", "author_font": "Times-Roman", "author_upper": True,
            "author_track": 0.12, "series_font": "Helvetica", "body_font": "Times-Roman", "scrim_alpha": 0.82}
    base.update(kw)
    return base


TEMPLATES = {
    "gilded": _t(name="Gilded", genre="Literary, historical, saga", light=False, bg="#1B1F23", text="#EFE3BF",
                 accent="#D4B97A", scrim="#101316", title_font="Times-Bold", title_upper=True, title_track=0.06,
                 title_pos="top", ornament="gilded"),
    "thriller": _t(name="Midnight thriller", genre="Thriller, crime, suspense", light=False, bg="#0B0B0D",
                   text="#FFFFFF", accent="#E0322B", scrim="#050506", title_font="Helvetica-Bold", title_upper=True,
                   title_track=0.01, title_max=0.17, title_lead=0.98, title_pos="bottom", ornament="bar",
                   sub_font="Helvetica", author_font="Helvetica-Bold", author_track=0.16, scrim_alpha=0.86),
    "romance": _t(name="Blush", genre="Romance, women's fiction", light=True, bg="#F7EDE8", text="#7A3B46",
                  accent="#B9727A", scrim="#F7EDE8", title_font="Times-Italic", title_max=0.16, title_pos="middle",
                  ornament="flourish", author_font="Times-Roman", author_track=0.1, scrim_alpha=0.8),
    "fantasy": _t(name="Epic fantasy", genre="Fantasy, myth, adventure", light=False, bg="#0F1A2E", text="#F2E3B3",
                  accent="#C9A24A", scrim="#0A1222", title_font="Times-Bold", title_upper=True, title_track=0.1,
                  title_max=0.14, title_pos="top", ornament="diamond", author_track=0.18),
    "literary": _t(name="Paper and ink", genre="Literary fiction, memoir, essays", light=True, bg="#F4F1EA",
                   text="#1E1E1E", accent="#8C2F2B", scrim="#F4F1EA", title_font="Times-Roman", title_max=0.13,
                   title_pos="top", art="inset", ornament="frame", author_font="Helvetica", author_track=0.22,
                   series_font="Helvetica"),
    "scifi": _t(name="Signal", genre="Science fiction, techno-thriller", light=False, bg="#06121A", text="#E6F4F1",
                accent="#5FC7C0", scrim="#03090D", title_font="Helvetica", title_upper=True, title_track=0.14,
                title_max=0.12, title_lead=1.1, title_pos="bottom", align="left", ornament="vbar",
                sub_font="Helvetica-Oblique", author_font="Helvetica", author_track=0.24),
    "minimal": _t(name="Swiss minimal", genre="Non-fiction, contemporary, poetry", light=True, bg="#FFFFFF",
                  text="#111111", accent="#F2B705", scrim="#FFFFFF", title_font="Helvetica-Bold", title_max=0.14,
                  title_lead=1.0, title_pos="top", align="left", art="inset", ornament="block",
                  sub_font="Helvetica", author_font="Helvetica-Bold", author_track=0.04,
                  body_font="Helvetica"),
}
DEFAULT_TEMPLATE = "gilded"
HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def template_list() -> list[dict]:
    return [{"id": k, "name": t["name"], "genre": t["genre"], "light": t["light"], "art": t["art"],
             "colors": {"background": t["bg"], "text": t["text"], "accent": t["accent"]},
             "title_font": t["title_font"]} for k, t in TEMPLATES.items()]


def rgb(hexstr: str) -> tuple:
    c = hexstr.lstrip("#")
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def _mix(a: tuple, b: tuple, t: float) -> tuple:
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


# ====================================================================== print maths
def spine_width_in(page_count: int, paper: str) -> float:
    """KDP formula: page count × paper thickness per page (white 0.002252 in, cream 0.0025 in)."""
    return page_count * PAPERS[paper]


def check_print(trim: str, paper: str, page_count) -> tuple[int, list[str]]:
    """A usable (even) page count and notes, or CoverError in plain words."""
    if trim not in TRIMS:
        raise CoverError(f"trim size: {', '.join(TRIMS)} (inches)", "/trim")
    if paper not in PAPERS:
        raise CoverError("paper: white or cream", "/paper")
    if page_count is None:
        raise CoverError("the print cover needs the book's page count: export the PDF first, or type the number of "
                         "pages of the printed interior", "/page_count")
    if isinstance(page_count, str) and page_count.strip().isdigit():
        page_count = int(page_count.strip())
    if not isinstance(page_count, int) or isinstance(page_count, bool):
        raise CoverError("page count: a whole number of pages", "/page_count")
    if page_count < MIN_PAGES:
        raise CoverError(f"a printed paperback needs at least {MIN_PAGES} pages (this book has {page_count})",
                         "/page_count")
    if page_count > MAX_PAGES[paper]:
        raise CoverError(f"on {paper} paper a paperback can have at most {MAX_PAGES[paper]} pages (this book has "
                         f"{page_count})", "/page_count")
    notes = []
    if page_count % 2:
        notes.append(f"{page_count} pages is odd: the printer adds a blank page, so the spine is made for "
                     f"{page_count + 1}.")
        page_count += 1
    return page_count, notes


def wrap_geometry(trim: str, paper: str, page_count: int) -> dict:
    """Every measurement of the full wrap, in inches and points (page_count already checked)."""
    tw, th = TRIMS[trim]
    sw = spine_width_in(page_count, paper)
    width = BLEED_IN + tw + sw + tw + BLEED_IN
    height = BLEED_IN + th + BLEED_IN
    return {"trim": trim, "paper": paper, "page_count": page_count, "trim_w_in": tw, "trim_h_in": th,
            "spine_in": round(sw, 4), "bleed_in": BLEED_IN, "width_in": round(width, 4), "height_in": round(height, 4),
            "spine_text": page_count >= SPINE_TEXT_MIN_PAGES,
            "inches_per_page": PAPERS[paper],
            "barcode_in": {"w": BARCODE_IN[0], "h": BARCODE_IN[1], "from_spine": BARCODE_INSET_IN,
                           "from_bottom": BARCODE_INSET_IN},
            "pt": {"width": width * IN, "height": height * IN, "bleed": BLEED_IN * IN, "trim_w": tw * IN,
                   "trim_h": th * IN, "spine": sw * IN, "back_x": BLEED_IN * IN, "spine_x": (BLEED_IN + tw) * IN,
                   "front_x": (BLEED_IN + tw + sw) * IN}}


# ====================================================================== text measuring and fitting
def safe(text) -> str:
    from ..forge_pdf import safe as _safe  # noqa: PLC0415 - the one WinAnsi clean-up (accents kept where possible)
    return _safe(text)


def asc(font: str) -> float:
    return DESCRIPTORS[font]["ascent"] / 1000.0


def desc(font: str) -> float:
    return -DESCRIPTORS[font]["descent"] / 1000.0


def cap(font: str) -> float:
    return DESCRIPTORS[font]["cap"] / 1000.0


def measure(text: str, font: str, size: float, track: float = 0.0) -> float:
    """Advance width in pt; ``track`` (pt) is added between glyphs (PDF Tc), not after the last one."""
    table = WIDTHS[font]
    total = 0
    n = 0
    for b in text.encode("cp1252", "replace"):
        total += table[b - 32] if b >= 32 else 0
        n += 1
    return total * size / 1000.0 + track * max(0, n - 1)


def _greedy(words: list[str], font: str, size: float, track: float, width: float) -> list[str] | None:
    lines: list[str] = []
    cur = ""
    for w in words:
        if measure(w, font, size, track) > width + 1e-6:
            return None
        cand = f"{cur} {w}" if cur else w
        if cur and measure(cand, font, size, track) > width + 1e-6:
            lines.append(cur)
            cur = w
        else:
            cur = cand
    if cur:
        lines.append(cur)
    return lines


def wrap_balanced(text: str, font: str, size: float, track: float, width: float) -> list[str] | None:
    """Fewest lines that fit ``width``, then re-broken at the narrowest width that keeps that many lines (even line
    lengths, no lone last word). None when a single word is wider than ``width``. "\\n" forces a break."""
    out: list[str] = []
    for para in [p for p in text.split("\n")]:
        words = para.split()
        if not words:
            continue
        g = _greedy(words, font, size, track, width)
        if g is None:
            return None
        if len(g) > 1:
            lo = max(measure(w, font, size, track) for w in words)
            hi = width
            for _ in range(22):
                mid = (lo + hi) / 2.0
                t = _greedy(words, font, size, track, mid)
                if t is not None and len(t) <= len(g):
                    hi = mid
                else:
                    lo = mid
            g = _greedy(words, font, size, track, hi) or g
        out.extend(g)
    return out


def block_height(n: int, font: str, size: float, lead: float) -> float:
    return (asc(font) + desc(font)) * size + max(0, n - 1) * size * lead


def _hard_wrap(text: str, font: str, size: float, track: float, width: float) -> list[str]:
    """Greedy wrap that also breaks a word too long for the line (the last resort)."""
    lines, cur = [], ""
    for w in text.split():
        while measure(w, font, size, track) > width:
            k = len(w)
            while k > 1 and measure(w[:k] + "-", font, size, track) > width:
                k -= 1
            if cur:
                lines.append(cur)
                cur = ""
            lines.append(w[:k] + "-")
            w = w[k:]
        cand = f"{cur} {w}" if cur else w
        if cur and measure(cand, font, size, track) > width:
            lines.append(cur)
            cur = w
        else:
            cur = cand
    if cur:
        lines.append(cur)
    return lines


def fit_text(text: str, font: str, *, max_size: float, min_size: float, width: float, max_lines: int,
             max_height: float, lead: float = 1.1, track_em: float = 0.0) -> tuple[float, list[str], bool]:
    """(size, lines, shortened): the largest size whose balanced wrap fits ``max_lines`` and ``max_height``.
    When nothing fits even at ``min_size`` the text is set at min_size and cut with an ellipsis (shortened=True)."""
    s = max_size
    while s >= min_size - 1e-6:
        lines = wrap_balanced(text, font, s, track_em * s, width)
        if lines and len(lines) <= max_lines and block_height(len(lines), font, s, lead) <= max_height + 1e-6:
            return s, lines, False
        s = round(s - max(0.25, s * 0.03), 3)
    s = min_size
    fit_n = max(1, min(max_lines, int((max_height - (asc(font) + desc(font)) * s) // (s * lead)) + 1))
    lines = _hard_wrap(text, font, s, track_em * s, width)
    cut = len(lines) > fit_n
    if cut:
        lines = lines[:fit_n]
        last = lines[-1]
        while last and measure(last + "…", font, s, track_em * s) > width:
            last = last[:-1].rstrip()
        lines[-1] = last + "…"
    return s, lines, cut


# ====================================================================== display list
# ("rect", x, y, w, h, rgb, alpha) · ("stroke", x, y, w, h, rgb, lw) · ("line", x0, y0, x1, y1, rgb, lw)
# ("poly", [(x, y)…], rgb) · ("grad", x, y, w, h, rgb, [(t, alpha)…] bottom→top) · ("img", key, x, y, w, h, clip)
# ("text", s, font, size, x, y, rgb, track, rot, width, role) · ("guide", x0, y0, x1, y1, kind) (SVG preview only)
class Block:
    """One typeset text block: lines at a size, its colour, tracking and leading; placed by its top."""

    def __init__(self, role, lines, font, size, color, track_em=0.0, lead=1.1):
        self.role, self.lines, self.font, self.size, self.color = role, lines, font, size, color
        self.track = track_em * size
        self.lead = lead

    @property
    def height(self) -> float:
        return block_height(len(self.lines), self.font, self.size, self.lead) if self.lines else 0.0

    def width_of(self, line) -> float:
        return measure(line, self.font, self.size, self.track)

    def place(self, ops, top: float, x0: float, w: float, m: float, align: str):
        y = top - asc(self.font) * self.size
        for ln in self.lines:
            lw = self.width_of(ln)
            x = x0 + (w - lw) / 2.0 if align == "center" else x0 + m
            ops.append(("text", ln, self.font, self.size, x, y, self.color, self.track, 0, lw, self.role))
            y -= self.size * self.lead
        return top - self.height


def _colors(t: dict, colors: dict | None) -> dict:
    c = {"background": t["bg"], "text": t["text"], "accent": t["accent"]}
    for k, v in (colors or {}).items():
        if k in c and isinstance(v, str) and HEX_RE.match(v):
            c[k] = v
    out = {k: rgb(v) for k, v in c.items()}
    # the scrim follows a changed background (same darkness family), else the template's own
    out["scrim"] = rgb(t["scrim"]) if c["background"].lower() == t["bg"].lower() else \
        _mix(out["background"], (0, 0, 0) if not t["light"] else (255, 255, 255), 0.35)
    out["muted"] = _mix(out["text"], out["background"], 0.35)
    return out


def _texts(texts: dict) -> dict:
    return {k: safe((texts or {}).get(k) or "").strip() for k in ("title", "subtitle", "author", "series", "tagline",
                                                                   "blurb", "author_bio")}


def _cover_fit(img: ImageInfo, box: tuple) -> tuple:
    x, y, w, h = box
    s = max(w / img.width, h / img.height)
    dw, dh = img.width * s, img.height * s
    return (x + (w - dw) / 2.0, y + (h - dh) / 2.0, dw, dh)


def _diamond(cx, cy, r, color):
    return ("poly", [(cx, cy + r), (cx + r, cy), (cx, cy - r), (cx - r, cy)], color)


def layout_front(design: dict, panel: tuple, *, art: ImageInfo | None = None, art_key: str = "art",
                 bleed: tuple = (0.0, 0.0, 0.0, 0.0)) -> tuple[list, dict]:
    """The front cover in ``panel`` = (x0, y0, w, h) (trim box, pt). ``bleed`` = (left, right, top, bottom) pt that
    the background and artwork extend past the trim. -> (ops, info: warnings, safe box, art box)."""
    t = TEMPLATES.get(design.get("template")) or TEMPLATES[DEFAULT_TEMPLATE]
    c = _colors(t, design.get("colors"))
    tx = _texts(design.get("texts") or {})
    x0, y0, w, h = panel
    bl, br, bt, bb = bleed
    m = max(SAFE_IN * IN, 0.085 * w)
    inner = w - 2 * m
    align = t["align"]
    warnings: list[str] = []
    ops: list = [("rect", x0 - bl, y0 - bb, w + bl + br, h + bt + bb, c["background"], 1.0)]
    full_art = art is not None and t["art"] == "full"
    inset_art = art is not None and t["art"] == "inset"
    if full_art:
        box = (x0 - bl, y0 - bb, w + bl + br, h + bt + bb)
        ops.append(("img", art_key, *_cover_fit(art, box), box))
    title = tx["title"] or "Untitled"
    if t["title_upper"]:
        title = title.upper()
    long_title = len(title) > 40
    tfont = t["title_font"]

    # ---- the small pieces first (their sizes do not depend on the title)
    author = (tx["author"].upper() if t["author_upper"] else tx["author"])
    a_size, a_lines, a_cut = fit_text(author, t["author_font"], max_size=0.05 * w, min_size=8.0, width=inner,
                                      max_lines=2, max_height=0.12 * h, lead=1.15,
                                      track_em=t["author_track"]) if author else (0, [], False)
    series = tx["series"].upper()
    s_size, s_lines, _ = fit_text(series, t["series_font"], max_size=0.024 * w, min_size=6.5, width=inner,
                                  max_lines=2, max_height=0.06 * h, track_em=0.22) if series else (0, [], False)
    tag = tx["tagline"]
    g_size, g_lines, _ = fit_text(tag, t["sub_font"], max_size=0.03 * w, min_size=7.0, width=inner * 0.92,
                                  max_lines=2, max_height=0.08 * h, lead=1.25) if tag else (0, [], False)
    sub = tx["subtitle"]
    author_b = Block("author", a_lines, t["author_font"], a_size, c["text"], t["author_track"], 1.15)
    series_b = Block("series", s_lines, t["series_font"], s_size, c["accent"], 0.22)
    tag_b = Block("tagline", g_lines, t["sub_font"], g_size, c["text"] if not full_art else c["text"], 0.0, 1.25)
    if a_cut and a_lines:
        warnings.append("The author name is long: it was shortened on the front cover.")

    gap = 0.022 * h
    top_line, bottom_line = y0 + h - m, y0 + m
    orn_room = {"gilded": 0.035 * h, "diamond": 0.035 * h, "block": 0.045 * h, "flourish": 0.0}.get(t["ornament"], 0.0)

    for shrink in range(0, 9):
        zone = {"top": 0.34, "bottom": 0.34, "middle": 0.36}[t["title_pos"]] * h
        if t["art"] == "inset":
            zone = 0.25 * h
        zone *= (1.0 - 0.07 * shrink)
        max_lines = 3 if not long_title else (4 if len(title) <= 70 else 5)
        ts, tl, t_cut = fit_text(title, tfont, max_size=t["title_max"] * w, min_size=14.0, width=inner,
                                 max_lines=max_lines, max_height=zone, lead=t["title_lead"],
                                 track_em=t["title_track"])
        title_b = Block("title", tl, tfont, ts, c["text"], t["title_track"], t["title_lead"])
        if author and a_size > 0.62 * ts:  # the title always leads: the author never outgrows it
            a_size, a_lines, a_cut = fit_text(author, t["author_font"], max_size=max(8.0, 0.62 * ts), min_size=8.0,
                                              width=inner, max_lines=2, max_height=0.12 * h, lead=1.15,
                                              track_em=t["author_track"])
            author_b = Block("author", a_lines, t["author_font"], a_size, c["text"], t["author_track"], 1.15)
        sub_b = Block("subtitle", [], t["sub_font"], 0, c["text"])
        if sub:
            ss, sl, _ = fit_text(sub, t["sub_font"], max_size=min(0.045 * w, ts * 0.5), min_size=8.0,
                                 width=inner * 0.92, max_lines=3 if len(sub) > 60 else 2, max_height=0.1 * h,
                                 lead=1.2)
            sub_b = Block("subtitle", sl, t["sub_font"], ss, c["text"] if t["light"] or full_art else c["muted"],
                          0.0, 1.2)
        stack = [b for b in (series_b, title_b, sub_b) if b.lines]
        stack_h = sum(b.height for b in stack) + gap * (len(stack) - 1) + orn_room * (2 if t["ornament"] in
                                                                                      ("gilded", "diamond") else 1)
        # the bottom group: author (and the tagline above it unless the title is at the bottom)
        if t["title_pos"] == "bottom":
            bottom_group = [title_b, sub_b, author_b] if author_b.lines else [title_b, sub_b]
            bottom_group = [b for b in ([series_b] + bottom_group) if b.lines]
            top_group = [tag_b] if tag_b.lines else []
        else:
            top_group = stack
            bottom_group = [b for b in (tag_b, author_b) if b.lines]
        bg_h = sum(b.height for b in bottom_group) + gap * max(0, len(bottom_group) - 1)
        tg_h = sum(b.height for b in top_group) + gap * max(0, len(top_group) - 1)
        if t["title_pos"] == "bottom":
            bg_h += orn_room + (0.03 * h if t["ornament"] == "bar" else 0)
        else:
            tg_h += orn_room * (2 if t["ornament"] in ("gilded", "diamond") else 1)
        needed = tg_h + bg_h + (0.30 * h if inset_art else 0.12 * h) if t["title_pos"] != "middle" else \
            stack_h + 2 * bg_h + 0.06 * h
        if needed <= h - 2 * m or shrink == 8:
            break
    if t_cut:
        warnings.append("The title is very long: it was shortened on the cover. Shorten it, or put line breaks in "
                        "it yourself.")
    if len(tl) > 1 and ts < 0.06 * w and not t_cut:
        warnings.append("The title is long, so it is set quite small. A shorter title (or the long part as a "
                        "subtitle) reads better as a thumbnail.")

    placed: dict = {}

    def put_stack(blocks, top):
        y = top
        for i, b in enumerate(blocks):
            if i:
                y -= gap
            if b.role == "title" and t["ornament"] in ("gilded", "diamond"):
                placed["rule_top"] = y - orn_room * 0.35
                y -= orn_room
            placed[b.role] = (y, y - b.height)
            y = b.place(ops_text, y, x0, w, m, align)
            if b.role == "title":
                if t["ornament"] in ("gilded", "diamond"):
                    placed["rule_bottom"] = y - orn_room * 0.65
                    y -= orn_room
                if t["ornament"] == "bar":
                    placed["bar"] = y - 0.018 * h
                    y -= 0.03 * h
        return y

    ops_text: list = []
    if t["ornament"] == "block":
        placed["block"] = top_line
        top_line -= orn_room
    if t["title_pos"] == "top":
        stack_bottom = put_stack(stack, top_line)
        bottom_top = bottom_line + bg_h
        put_stack(bottom_group, bottom_top)
        text_top, text_bottom = top_line, stack_bottom
    elif t["title_pos"] == "middle":
        sh = sum(b.height for b in stack) + gap * (len(stack) - 1)
        mid = y0 + 0.56 * h
        top = min(top_line, mid + sh / 2.0)
        stack_bottom = put_stack(stack, top)
        put_stack(bottom_group, bottom_line + bg_h)
        text_top, text_bottom = top, stack_bottom
    else:  # bottom
        put_stack(bottom_group, bottom_line + bg_h)
        if top_group:
            put_stack(top_group, top_line)
        text_top, text_bottom = bottom_line + bg_h, bottom_line

    # ---- contrast over the artwork: a scrim (a soft gradient band) behind every text group, solid where the text is
    if full_art:
        a = t["scrim_alpha"]
        fx0, fw = x0 - bl, w + bl + br
        fade = 0.14 * h
        groups = []  # (top, bottom) of each text group
        if t["title_pos"] == "bottom":
            groups.append(("bottom", bottom_line + bg_h))
            if top_group:
                groups.append(("top", placed["tagline"][1]))
        elif t["title_pos"] == "top":
            groups.append(("top", text_bottom))
            if bottom_group:
                groups.append(("bottom", bottom_line + bg_h))
        else:
            groups.append(("band", (text_top, text_bottom)))
            if bottom_group:
                groups.append(("bottom", bottom_line + bg_h))
        for kind, edge in groups:
            if kind == "top":
                yb = edge - fade
                hh = (y0 + h + bt) - yb
                ops.append(("grad", fx0, yb, fw, hh, c["scrim"], [(0.0, 0.0), (fade / hh, a), (1.0, a)]))
            elif kind == "bottom":
                ys = y0 - bb
                hh = edge + fade - ys
                ops.append(("grad", fx0, ys, fw, hh, c["scrim"], [(0.0, min(1.0, a + 0.08)),
                                                                  ((edge - ys) / hh, a), (1.0, 0.0)]))
            else:
                tt, tb_ = edge
                yb = tb_ - fade
                hh = (tt + fade) - yb
                ops.append(("grad", fx0, yb, fw, hh, c["scrim"], [(0.0, 0.0), (fade / hh, a),
                                                                  (1.0 - fade / hh, a), (1.0, 0.0)]))

    # ---- ornaments
    ac = c["accent"]
    cx = x0 + w / 2.0
    if t["ornament"] == "gilded":
        fr = max(0.3 * IN, m * 0.55)
        ops.append(("stroke", x0 + fr, y0 + fr, w - 2 * fr, h - 2 * fr, ac, 0.8))
        ops.append(("stroke", x0 + fr + 3.5, y0 + fr + 3.5, w - 2 * fr - 7, h - 2 * fr - 7, ac, 0.35))
        for key in ("rule_top", "rule_bottom"):
            if key in placed:
                y = placed[key]
                ops.append(("line", cx - 0.16 * w, y, cx - 6, y, ac, 0.7))
                ops.append(("line", cx + 6, y, cx + 0.16 * w, y, ac, 0.7))
                ops.append(_diamond(cx, y, 3.0, ac))
    elif t["ornament"] == "diamond":
        for key in ("rule_top", "rule_bottom"):
            if key in placed:
                y = placed[key]
                ops.append(("line", cx - 0.3 * w, y, cx + 0.3 * w, y, ac, 0.9))
                ops.append(_diamond(cx - 0.3 * w, y, 2.6, ac))
                ops.append(_diamond(cx + 0.3 * w, y, 2.6, ac))
                ops.append(_diamond(cx, y, 4.2, ac))
    elif t["ornament"] == "bar" and "bar" in placed:
        ops.append(("rect", cx - 0.11 * w, placed["bar"] - 1.5, 0.22 * w, 3.0, ac, 1.0))
    elif t["ornament"] == "flourish" and "title" in placed:
        y = max(v[0] for k, v in placed.items() if k in ("series", "title")) + 0.028 * h
        ops.append(("line", cx - 0.14 * w, y, cx - 8, y, ac, 0.6))
        ops.append(("line", cx + 8, y, cx + 0.14 * w, y, ac, 0.6))
        ops.append(_diamond(cx, y, 2.6, ac))
        y2 = placed[("subtitle" if "subtitle" in placed else "title")][1] - 0.03 * h
        ops.append(("line", cx - 0.06 * w, y2, cx + 0.06 * w, y2, ac, 0.6))
    elif t["ornament"] == "vbar" and "title" in placed:
        yt, yb = placed["title"][0], placed.get("subtitle", placed["title"])[1]
        ops.append(("rect", x0 + m - 0.032 * w, yb, 2.6, yt - yb, ac, 1.0))
    elif t["ornament"] == "block" and "block" in placed:
        ops.append(("rect", x0 + m, placed["block"] - 7.0, 0.2 * w, 7.0, ac, 1.0))
    elif t["ornament"] == "frame" and "title" in placed:
        y = placed.get("subtitle", placed["title"])[1] - 0.02 * h
        ops.append(("line", cx - 0.07 * w, y, cx + 0.07 * w, y, ac, 1.0))

    art_box = None
    if inset_art:
        upper = min(v[1] for k, v in placed.items() if isinstance(v, tuple) and k in ("title", "subtitle", "series"))
        upper -= 0.045 * h
        lower = (bottom_line + bg_h) + 0.035 * h
        if t["ornament"] == "frame":
            upper -= 0.01 * h
        if upper - lower > 0.12 * h:
            bx, bw_ = x0 + m, w - 2 * m
            if t["ornament"] == "block":  # Swiss: the picture runs off the right edge
                bw_ = (x0 + w + br) - bx
            art_box = (bx, lower, bw_, upper - lower)
            ops.append(("img", art_key, *_cover_fit(art, art_box), art_box))
            if t["ornament"] == "frame":
                ops.append(("stroke", bx - 5, lower - 5, bw_ + 10, upper - lower + 10, c["text"], 0.6))
        else:
            warnings.append("There is little room left for the picture: shorten the title or subtitle.")
    elif art is None and t["art"] == "inset" and t["ornament"] == "frame":
        pass
    ops.extend(ops_text)
    safe_box = (x0 + SAFE_IN * IN, y0 + SAFE_IN * IN, w - 2 * SAFE_IN * IN, h - 2 * SAFE_IN * IN)
    return ops, {"warnings": warnings, "safe": safe_box, "art_box": art_box, "margin": m, "title_size": ts,
                 "title_lines": tl}


def _paragraph_lines(text: str, font: str, size: float, width: float) -> list[str | None]:
    """Lines of the text (a None between paragraphs)."""
    out: list = []
    for i, para in enumerate([p.strip() for p in re.split(r"\n\s*\n|\n", text) if p.strip()]):
        if i:
            out.append(None)
        out.extend(_hard_wrap(para, font, size, 0.0, width))
    return out


def layout_back(design: dict, panel: tuple, *, bleed: tuple = (0.0, 0.0, 0.0, 0.0),
                barcode: bool = True) -> tuple[list, dict]:
    """The back cover: the tagline as a headline, the blurb, "About the author" with the bio, and the blank barcode
    box. Text shrinks (11.5 → 8 pt) to fit above the barcode box; what still does not fit is cut (with a warning)."""
    t = TEMPLATES.get(design.get("template")) or TEMPLATES[DEFAULT_TEMPLATE]
    c = _colors(t, design.get("colors"))
    tx = _texts(design.get("texts") or {})
    x0, y0, w, h = panel
    bl, br, bt, bb = bleed
    m = max(SAFE_IN * IN, 0.085 * w)
    inner = w - 2 * m
    ops: list = [("rect", x0 - bl, y0 - bb, w + bl + br, h + bt + bb, c["background"], 1.0)]
    warnings: list[str] = []
    bw, bh = BARCODE_IN[0] * IN, BARCODE_IN[1] * IN
    bx, by = x0 + w - BARCODE_INSET_IN * IN - bw, y0 + BARCODE_INSET_IN * IN
    floor = (by + bh + 0.22 * IN) if barcode else (y0 + m)
    top = y0 + h - m
    body_font = t["body_font"]
    head_font = t["title_font"] if t["title_font"] != "Helvetica" else "Helvetica-Bold"
    bold = "Helvetica-Bold" if body_font.startswith("Helvetica") else "Times-Bold"
    blurb, bio, tag = tx["blurb"], tx["author_bio"], tx["tagline"]
    if not blurb:
        warnings.append("The back cover has no blurb yet: write one (it sells the book).")
    chosen = None
    for size in [x / 4.0 for x in range(46, 31, -1)]:  # 11.5 … 8 pt
        lead = size * 1.38
        head_s = size * 1.45
        parts = []
        if tag:
            hl = wrap_balanced(tag, head_font, head_s, 0.0, inner) or _hard_wrap(tag, head_font, head_s, 0, inner)
            parts.append(("head", hl, head_font, head_s, head_s * 1.2))
        if blurb:
            parts.append(("blurb", _paragraph_lines(blurb, body_font, size, inner), body_font, size, lead))
        if bio:
            bs = max(7.0, size * 0.86)
            parts.append(("bio_head", ["ABOUT THE AUTHOR"], bold, bs * 0.95, bs * 1.3))
            parts.append(("bio", _paragraph_lines(bio, body_font, bs, inner), body_font, bs, bs * 1.36))
        total = 0.0
        for i, (role, lines, font, s, ld) in enumerate(parts):
            real = [x for x in lines if x is not None]
            total += (asc(font) + desc(font)) * s + (len(real) - 1) * ld + (len(lines) - len(real)) * ld * 0.45
            total += (0.16 * IN if i else 0) + (0.12 * IN if role == "bio_head" else 0)
        chosen = parts
        if total <= top - floor:
            break
    else:
        # still too long at 8 pt: cut the blurb (then the bio) to what fits
        warnings.append("The blurb and author bio are too long for the back cover: the end was cut. Shorten them.")
    y = top
    stop = False
    for i, (role, lines, font, s, ld) in enumerate(chosen or []):
        if stop:
            break
        if i:
            y -= 0.16 * IN
        if role == "bio_head":
            y -= 0.12 * IN
            if y - (asc(font) + desc(font)) * s < floor:
                break
            ops.append(("line", x0 + m, y + 0.06 * IN, x0 + m + 0.6 * IN, y + 0.06 * IN, c["accent"], 0.8))
        y -= asc(font) * s
        for ln in lines:
            if ln is None:
                y -= ld * 0.45
                continue
            if y - desc(font) * s < floor - 1e-6:
                stop = True
                last = ops[-1] if ops and ops[-1][0] == "text" else None
                if last is not None and not last[1].endswith("…"):
                    s_ = last[1]
                    while s_ and measure(s_ + "…", last[2], last[3], last[7]) > inner:
                        s_ = s_[:-1].rstrip()
                    ops[-1] = (last[0], s_ + "…", *last[2:9], measure(s_ + "…", last[2], last[3], last[7]), last[10])
                break
            tr = 0.12 * s if role == "bio_head" else 0.0
            color = c["accent"] if role in ("head", "bio_head") else c["text"]
            ops.append(("text", ln, font, s, x0 + m, y, color, tr, 0, measure(ln, font, s, tr), role))
            y -= ld
        y += ld
        y -= desc(font) * s
    if barcode:
        ops.append(("rect", bx, by, bw, bh, (255, 255, 255), 1.0))
    return ops, {"warnings": warnings, "barcode": (bx, by, bw, bh) if barcode else None,
                 "safe": (x0 + SAFE_IN * IN, y0 + SAFE_IN * IN, w - 2 * SAFE_IN * IN, h - 2 * SAFE_IN * IN),
                 "floor": floor}


def layout_spine(design: dict, panel: tuple, page_count: int, *, bleed_tb: tuple = (0.0, 0.0)) -> tuple[list, dict]:
    """The spine: template background, and (from SPINE_TEXT_MIN_PAGES pages) the title and the author rotated to
    read top to bottom (US/UK custom), centred across the spine on the capital height and along it."""
    t = TEMPLATES.get(design.get("template")) or TEMPLATES[DEFAULT_TEMPLATE]
    c = _colors(t, design.get("colors"))
    tx = _texts(design.get("texts") or {})
    x0, y0, sw, h = panel
    bt, bb = bleed_tb
    ops: list = [("rect", x0, y0 - bb, sw, h + bt + bb, c["background"], 1.0)]
    info = {"spine_text": False, "warnings": [], "reason": None}
    if page_count < SPINE_TEXT_MIN_PAGES:
        info["reason"] = (f"No spine text: with {page_count} pages the spine is {sw / IN:.3f} in wide; spine text "
                          f"needs at least {SPINE_TEXT_MIN_PAGES} pages.")
        return ops, info
    title = tx["title"] or "Untitled"
    if t["title_upper"]:
        title = title.upper()
    author = tx["author"].upper() if t["author_upper"] else tx["author"]
    tfont, afont = t["title_font"], t["author_font"]
    margin = SPINE_MARGIN_IN * IN
    half = sw / 2.0 - margin
    room = h - 2 * 0.5 * IN

    def max_size(font):
        return half / max(cap(font) / 2.0 + desc(font), asc(font) - cap(font) / 2.0)
    ts = min(15.0, max_size(tfont))
    asz = min(ts * 0.78, max_size(afont))
    ttr, atr = t["title_track"] * ts, t["author_track"] * asz * 0.6

    def length(ts_, as_):
        tw_ = measure(title, tfont, ts_, t["title_track"] * ts_)
        aw_ = measure(author, afont, as_, t["author_track"] * as_ * 0.6) if author else 0.0
        return tw_, aw_, tw_ + (ts_ * 1.6 if author else 0) + aw_
    tw_, aw_, total = length(ts, asz)
    while total > room and ts > 5.5:
        ts *= 0.95
        asz = min(ts * 0.78, max_size(afont))
        tw_, aw_, total = length(ts, asz)
    if total > room and author:
        info["warnings"].append("The title is too long for the spine together with the author: the author was left "
                                "off the spine.")
        author, aw_ = "", 0.0
        total = tw_
    if total > room:
        info["warnings"].append("The title is too long for the spine: it is not printed there.")
        info["reason"] = "No spine text: the title does not fit along the spine."
        return ops, info
    ttr, atr = t["title_track"] * ts, t["author_track"] * asz * 0.6
    cx = x0 + sw / 2.0
    y = y0 + h / 2.0 + total / 2.0
    bx = cx - cap(tfont) * ts / 2.0
    ops.append(("text", title, tfont, ts, bx, y, c["text"], ttr, -90, tw_, "spine_title"))
    if author:
        y2 = y - tw_ - ts * 1.6
        bx2 = cx - cap(afont) * asz / 2.0
        ops.append(("text", author, afont, asz, bx2, y2, c["accent"], atr, -90, aw_, "spine_author"))
    info["spine_text"] = True
    info["sizes"] = (ts, asz)
    return ops, info


def layout_wrap(design: dict, geom: dict, *, art: ImageInfo | None = None, guides: bool = False) -> tuple[list, dict]:
    p = geom["pt"]
    b = p["bleed"]
    back_ops, back = layout_back(design, (p["back_x"], b, p["trim_w"], p["trim_h"]), bleed=(b, 0.0, b, b))
    sp_ops, sp = layout_spine(design, (p["spine_x"], b, p["spine"], p["trim_h"]), geom["page_count"],
                              bleed_tb=(b, b))
    fr_ops, fr = layout_front(design, (p["front_x"], b, p["trim_w"], p["trim_h"]), art=art, bleed=(0.0, b, b, b))
    ops = back_ops + sp_ops + fr_ops
    if guides:
        W, H = p["width"], p["height"]
        for x in (b, W - b):
            ops.append(("guide", x, 0, x, H, "trim"))
        for y in (b, H - b):
            ops.append(("guide", 0, y, W, y, "trim"))
        for x in (p["spine_x"], p["front_x"]):
            ops.append(("guide", x, 0, x, H, "fold"))
        s = SAFE_IN * IN
        for px in (p["back_x"], p["front_x"]):
            ops.append(("guide_box", px + s, b + s, p["trim_w"] - 2 * s, p["trim_h"] - 2 * s, "safe"))
    warnings = list(fr["warnings"]) + list(back["warnings"]) + list(sp["warnings"])
    if sp.get("reason"):
        warnings.append(sp["reason"])
    return ops, {"warnings": warnings, "front": fr, "back": back, "spine": sp}


# ====================================================================== PDF
class _Res:
    def __init__(self, w: PdfWriter, images: dict):
        self.w, self.images = w, images
        self.fonts: dict = {}
        self.imgs: dict = {}
        self.gs: dict = {}
        self.n = 0

    def font(self, f: str) -> str:
        if f not in self.fonts:
            d = DESCRIPTORS[f]
            desc_ = self.w.add((f"<< /Type /FontDescriptor /FontName /{f} /Flags {d['flags']} /FontBBox "
                                f"[{' '.join(str(v) for v in d['bbox'])}] /ItalicAngle {num(d['italic'])} "
                                f"/Ascent {d['ascent']} /Descent {d['descent']} /CapHeight {d['cap']} "
                                f"/StemV {d['stemv']} >>").encode("ascii"))
            widths = " ".join(str(x) for x in WIDTHS[f])
            obj = self.w.add((f"<< /Type /Font /Subtype /Type1 /BaseFont /{f} /Encoding /WinAnsiEncoding "
                              f"/FirstChar 32 /LastChar 255 /Widths [{widths}] /FontDescriptor {desc_} 0 R >>")
                             .encode("ascii"))
            self.fonts[f] = (f"CF{len(self.fonts) + 1}", obj)
        return self.fonts[f][0]

    def image(self, key: str) -> str:
        if key not in self.imgs:
            self.imgs[key] = (f"CI{len(self.imgs) + 1}", _xobject(self.w, self.images[key]))
        return self.imgs[key][0]

    def alpha(self, a: float) -> str:
        k = ("a", round(a, 3))
        if k not in self.gs:
            obj = self.w.add(f"<< /Type /ExtGState /ca {num(a)} /CA {num(a)} >>".encode("ascii"))
            self.gs[k] = (f"CG{len(self.gs) + 1}", obj)
        return self.gs[k][0]

    def gradient(self, x, y, w, h, stops) -> str:
        """A luminosity soft mask whose grey axial shading carries the alpha stops (bottom → top)."""
        funcs = []
        for (t0, a0), (t1, a1) in zip(stops, stops[1:]):
            funcs.append(f"<< /FunctionType 2 /Domain [0 1] /C0 [{num(a0)}] /C1 [{num(a1)}] /N 1 >>")
        if len(funcs) == 1:
            fn = funcs[0]
        else:
            bounds = " ".join(num(t) for t, _ in stops[1:-1])
            enc = " ".join("0 1" for _ in funcs)
            fn = f"<< /FunctionType 3 /Domain [0 1] /Functions [{' '.join(funcs)}] /Bounds [{bounds}] /Encode [{enc}] >>"
        sh = self.w.add((f"<< /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 {num(y)} 0 {num(y + h)}] "
                         f"/Function {fn} /Extend [true true] >>").encode("ascii"))
        form = self.w.add(PdfWriter.stream(
            f"/Type /XObject /Subtype /Form /BBox [{num(x)} {num(y)} {num(x + w)} {num(y + h)}] "
            f"/Group << /S /Transparency /CS /DeviceGray >> /Resources << /Shading << /Sh0 {sh} 0 R >> >>",
            b"/Sh0 sh"))
        obj = self.w.add(f"<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G {form} 0 R >> >>"
                         .encode("ascii"))
        self.n += 1
        name = f"CS{self.n}"
        self.gs[("s", self.n)] = (name, obj)
        return name

    def resources(self) -> str:
        r = "<< /ProcSet [/PDF /Text /ImageB /ImageC /ImageI]"
        if self.fonts:
            r += " /Font << " + " ".join(f"/{a} {o} 0 R" for a, o in self.fonts.values()) + " >>"
        if self.imgs:
            r += " /XObject << " + " ".join(f"/{a} {o} 0 R" for a, o in self.imgs.values()) + " >>"
        if self.gs:
            r += " /ExtGState << " + " ".join(f"/{a} {o} 0 R" for a, o in self.gs.values()) + " >>"
        return r + " >>"


def _rgb(col, op: str) -> str:
    """(r, g, b) 0-255 -> PDF colour operands (always 0-255: a near-black #000001 is never read as 0-1 floats)."""
    r, g, b = (float(v) / 255.0 for v in col)
    return f"{num(r)} {num(g)} {num(b)} {op}"


def _content(ops: list, res: _Res) -> bytes:
    out = bytearray()
    for op in ops:
        k = op[0]
        if k == "rect":
            _, x, y, w, h, col, a = op
            g = f"/{res.alpha(a)} gs " if a < 0.999 else ""
            out += f"q {g}{_rgb(col, 'rg')} {num(x)} {num(y)} {num(w)} {num(h)} re f Q\n".encode("ascii")
        elif k == "stroke":
            _, x, y, w, h, col, lw = op
            out += f"q {_rgb(col, 'RG')} {num(lw)} w {num(x)} {num(y)} {num(w)} {num(h)} re S Q\n".encode("ascii")
        elif k == "line":
            _, x0, y0, x1, y1, col, lw = op
            out += f"q {_rgb(col, 'RG')} {num(lw)} w {num(x0)} {num(y0)} m {num(x1)} {num(y1)} l S Q\n".encode("ascii")
        elif k == "poly":
            _, pts, col = op
            path = f"{num(pts[0][0])} {num(pts[0][1])} m " + " ".join(f"{num(px)} {num(py)} l" for px, py in pts[1:])
            out += f"q {_rgb(col, 'rg')} {path} h f Q\n".encode("ascii")
        elif k == "grad":
            _, x, y, w, h, col, stops = op
            if h <= 0 or w <= 0:
                continue
            g = res.gradient(x, y, w, h, stops)
            out += f"q /{g} gs {_rgb(col, 'rg')} {num(x)} {num(y)} {num(w)} {num(h)} re f Q\n".encode("ascii")
        elif k == "img":
            _, key, x, y, w, h, clip = op
            name = res.image(key)
            out += b"q\n"
            if clip:
                cx, cy, cw, ch = clip
                out += f"{num(cx)} {num(cy)} {num(cw)} {num(ch)} re W n\n".encode("ascii")
            mtx = image_matrix(res.images[key].orientation, x, y, w, h)
            out += (" ".join(num(v) for v in mtx) + f" cm /{name} Do\nQ\n").encode("ascii")
        elif k == "text":
            _, s, font, size, x, y, col, track, rot, _w, _role = op
            fname = res.font(font)
            tm = f"1 0 0 1 {num(x)} {num(y)}" if not rot else f"0 -1 1 0 {num(x)} {num(y)}"
            out += (f"BT /{fname} {num(size)} Tf {num(track)} Tc {_rgb(col, 'rg')} {tm} Tm ").encode("ascii")
            out += pdf_string(s) + b" Tj ET\n"
    return bytes(out)


def _page_obj(w: PdfWriter, res: _Res, parent: int, page: dict) -> int:
    content = w.add(PdfWriter.stream("", _content(page["ops"], res)))
    boxes = f"/MediaBox [0 0 {num(page['width'])} {num(page['height'])}]"
    if page.get("trim"):
        tx, ty, tw, th = page["trim"]
        boxes += (f" /BleedBox [0 0 {num(page['width'])} {num(page['height'])}] "
                  f"/TrimBox [{num(tx)} {num(ty)} {num(tx + tw)} {num(ty + th)}]")
    return w.add(f"<< /Type /Page /Parent {parent} 0 R {boxes} /Resources {res.resources()} "
                 f"/Contents {content} 0 R >>".encode("ascii"))


def render_pdf(pages: list[dict], *, images: dict | None = None, meta: dict | None = None,
               extra_info: dict | None = None) -> bytes:
    """pages: [{"width", "height", "ops", "trim": (x, y, w, h) | None}] (pt) -> PDF bytes (deterministic)."""
    meta = meta or {}
    w = PdfWriter()
    catalog, pages_obj, info = w.reserve(), w.reserve(), w.reserve()
    kids = []
    for pg in pages:
        res = _Res(w, images or {})  # every page its own resource dictionary
        kids.append(_page_obj(w, res, pages_obj, pg))
    w.set(pages_obj, f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>"
          .encode("ascii"))
    cat = f"<< /Type /Catalog /Pages {pages_obj} 0 R".encode("ascii")
    if meta.get("language"):
        cat += b" /Lang " + pdf_text_string(meta["language"])
    w.set(catalog, cat + b" >>")
    inf = b"<< /Producer (Akowe cover writer 1)"
    for key, field_ in (("Title", "title"), ("Author", "author"), ("Subject", "subject")):
        if meta.get(field_):
            inf += f" /{key} ".encode("ascii") + pdf_text_string(str(meta[field_]))
    for k, v in sorted((extra_info or {}).items()):
        inf += f" /{k} ".encode("ascii") + pdf_text_string(str(v))
    w.set(info, inf + b" >>")
    return w.build(catalog, info)


def add_cover_pdf(book_pdf: bytes, ops_for, *, images: dict | None = None) -> bytes:
    """The book PDF with a cover page put in front of page 1. ``ops_for(width, height)`` -> display list for a page of
    the book's own size (its TrimBox when it has bleed). Every other object keeps its number (outline, links and
    named destinations still point at the same pages); a fresh cross-reference table is written."""
    objs, trailer, errors = parse_pdf_objects(book_pdf)
    if errors or not objs:
        raise CoverError("the book PDF cannot be read: " + "; ".join(errors[:2]))
    m = re.search(rb"startxref\s+(\d+)\s+%%EOF\s*$", book_pdf)
    xref = int(m.group(1))
    hm = re.match(rb"xref\s+0\s+(\d+)\s+", book_pdf[xref:xref + 64])
    if not hm:
        raise CoverError("the book PDF has an unexpected layout (it was not written by Akọwe)")
    count, p0 = int(hm.group(1)), xref + hm.end()
    starts = {}
    for i in range(1, count):
        line = book_pdf[p0 + 20 * i:p0 + 20 * i + 20]
        if line[17:18] == b"n":
            starts[i] = int(line[:10])
    if sorted(starts) != list(range(1, count)) or count - 1 != max(objs):
        raise CoverError("the book PDF has an unexpected layout (it was not written by Akọwe)")
    order = sorted(starts.items(), key=lambda kv: kv[1])
    raw: dict[int, bytes] = {}
    for i, (n, off) in enumerate(order):
        end = order[i + 1][1] if i + 1 < len(order) else xref
        head = f"{n} 0 obj\n".encode("ascii")
        body = book_pdf[off + len(head):end]
        if not body.endswith(b"\nendobj\n"):
            raise CoverError("the book PDF has an unexpected layout (it was not written by Akọwe)")
        raw[n] = body[:-len(b"\nendobj\n")]
    root_n = trailer["Root"][0]
    info_n = trailer["Info"][0] if trailer.get("Info") else None
    pages_n = objs[root_n][0]["Pages"][0]
    pages = objs[pages_n][0]
    kids = pages.get("Kids") or []
    if not kids:
        raise CoverError("the book PDF has no pages")
    first = objs[kids[0][0]][0]
    mb = first.get("MediaBox") or pages.get("MediaBox")
    tb = first.get("TrimBox")
    w = PdfWriter()
    w.objects = [raw[n] for n in range(1, len(raw) + 1)]
    if info_n is None:
        info_n = w.add(b"<< /Producer (Akowe cover writer 1) >>")
    width, height = float(mb[2]) - float(mb[0]), float(mb[3]) - float(mb[1])
    trim = None
    if tb:
        trim = (float(tb[0]), float(tb[1]), float(tb[2]) - float(tb[0]), float(tb[3]) - float(tb[1]))
    ops = ops_for(width, height, trim)
    res = _Res(w, images or {})
    page_n = _page_obj(w, res, pages_n, {"width": width, "height": height, "ops": ops, "trim": trim})
    kid_refs = " ".join(f"{k[0]} 0 R" for k in kids)
    w.set(pages_n, f"<< /Type /Pages /Kids [{page_n} 0 R {kid_refs}] /Count {len(kids) + 1} >>".encode("ascii"))
    return w.build(root_n, info_n)


# ====================================================================== SVG
SVG_FONTS = {"Times": "'Times New Roman', Times, 'Liberation Serif', 'Nimbus Roman', serif",
             "Helvetica": "Helvetica, Arial, 'Liberation Sans', 'Nimbus Sans', sans-serif",
             "Courier": "'Courier New', Courier, monospace"}


def _svg_font(font: str) -> str:
    fam = SVG_FONTS[font.split("-")[0]]
    weight = " font-weight=\"bold\"" if "Bold" in font else ""
    style = " font-style=\"italic\"" if ("Italic" in font or "Oblique" in font) else ""
    return f"font-family=\"{fam}\"{weight}{style}"


def _hex(col) -> str:
    return "#%02x%02x%02x" % tuple(int(v) for v in col)


def render_svg(width: float, height: float, ops: list, *, hrefs: dict | None = None, title: str = "",
               guides: bool = False, standalone: bool = True) -> str:
    """The display list as SVG in a ``width`` × ``height`` pt viewBox (y flipped). ``hrefs``: image key -> href
    (a relative file in the EPUB, a data: URI in a download)."""
    hrefs = hrefs or {}
    defs, body = [], []
    gid = [0]

    def Y(y):
        return height - y
    for op in ops:
        k = op[0]
        if k == "rect":
            _, x, y, w, h, col, a = op
            op_ = f" fill-opacity=\"{num(a)}\"" if a < 0.999 else ""
            body.append(f"<rect x=\"{num(x)}\" y=\"{num(Y(y + h))}\" width=\"{num(w)}\" height=\"{num(h)}\" "
                        f"fill=\"{_hex(col)}\"{op_}/>")
        elif k == "stroke":
            _, x, y, w, h, col, lw = op
            body.append(f"<rect x=\"{num(x)}\" y=\"{num(Y(y + h))}\" width=\"{num(w)}\" height=\"{num(h)}\" "
                        f"fill=\"none\" stroke=\"{_hex(col)}\" stroke-width=\"{num(lw)}\"/>")
        elif k == "line":
            _, x0, y0, x1, y1, col, lw = op
            body.append(f"<line x1=\"{num(x0)}\" y1=\"{num(Y(y0))}\" x2=\"{num(x1)}\" y2=\"{num(Y(y1))}\" "
                        f"stroke=\"{_hex(col)}\" stroke-width=\"{num(lw)}\"/>")
        elif k == "poly":
            _, pts, col = op
            body.append("<polygon points=\"" + " ".join(f"{num(px)},{num(Y(py))}" for px, py in pts)
                        + f"\" fill=\"{_hex(col)}\"/>")
        elif k == "grad":
            _, x, y, w, h, col, stops = op
            if h <= 0:
                continue
            gid[0] += 1
            # SVG gradients run top → bottom (offset 0 at the top): the PDF stops are bottom → top
            st = "".join(f"<stop offset=\"{num(1 - t)}\" stop-color=\"{_hex(col)}\" stop-opacity=\"{num(a)}\"/>"
                         for t, a in reversed(stops))
            defs.append(f"<linearGradient id=\"g{gid[0]}\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">{st}</linearGradient>")
            body.append(f"<rect x=\"{num(x)}\" y=\"{num(Y(y + h))}\" width=\"{num(w)}\" height=\"{num(h)}\" "
                        f"fill=\"url(#g{gid[0]})\"/>")
        elif k == "img":
            _, key, x, y, w, h, clip = op
            if key not in hrefs:
                continue
            clip_attr = ""
            if clip:
                gid[0] += 1
                cx, cy, cw, ch = clip
                defs.append(f"<clipPath id=\"c{gid[0]}\"><rect x=\"{num(cx)}\" y=\"{num(Y(cy + ch))}\" "
                            f"width=\"{num(cw)}\" height=\"{num(ch)}\"/></clipPath>")
                clip_attr = f" clip-path=\"url(#c{gid[0]})\""
            href = _xml_quoteattr(hrefs[key])
            body.append(f"<image x=\"{num(x)}\" y=\"{num(Y(y + h))}\" width=\"{num(w)}\" height=\"{num(h)}\" "
                        f"preserveAspectRatio=\"none\" xlink:href={href}{clip_attr}/>")
        elif k == "text":
            _, s, font, size, x, y, col, track, rot, tw, _role = op
            ls = f" letter-spacing=\"{num(track)}\"" if track else ""
            tr = f" transform=\"rotate(90 {num(x)} {num(Y(y))})\"" if rot else ""
            body.append(f"<text x=\"{num(x)}\" y=\"{num(Y(y))}\" {_svg_font(font)} font-size=\"{num(size)}\" "
                        f"fill=\"{_hex(col)}\"{ls} textLength=\"{num(tw)}\" lengthAdjust=\"spacingAndGlyphs\"{tr}>"
                        f"{_xml_escape(s)}</text>")
        elif k == "guide" and guides:
            _, x0, y0, x1, y1, kind = op
            col = {"trim": "#ff2d55", "fold": "#00a2ff"}.get(kind, "#999999")
            body.append(f"<line x1=\"{num(x0)}\" y1=\"{num(Y(y0))}\" x2=\"{num(x1)}\" y2=\"{num(Y(y1))}\" "
                        f"stroke=\"{col}\" stroke-width=\"0.8\" stroke-dasharray=\"4 3\" class=\"guide {kind}\"/>")
        elif k == "guide_box" and guides:
            _, x, y, w, h, kind = op
            body.append(f"<rect x=\"{num(x)}\" y=\"{num(Y(y + h))}\" width=\"{num(w)}\" height=\"{num(h)}\" "
                        "fill=\"none\" stroke=\"#22c55e\" stroke-width=\"0.7\" stroke-dasharray=\"2 3\" "
                        f"class=\"guide {kind}\"/>")
    head = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" if standalone else ""
    label = _xml_quoteattr(title or "Book cover")
    return (f"{head}<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" "
            f"version=\"1.1\" viewBox=\"0 0 {num(width)} {num(height)}\" width=\"{num(width)}pt\" "
            f"height=\"{num(height)}pt\" preserveAspectRatio=\"xMidYMid meet\" role=\"img\" aria-label={label}>"
            f"<title>{_xml_escape(title or 'Book cover')}</title>"
            + (f"<defs>{''.join(defs)}</defs>" if defs else "") + "".join(body) + "</svg>")


def data_uri(data: bytes, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(data).decode("ascii")


# ====================================================================== EPUB and DOCX
def add_cover_epub(epub: bytes, *, svg_inline: str, art: tuple | None, svg_file: str | None, title: str,
                   lang: str = "en") -> bytes:
    """The EPUB with a cover: ``cover.xhtml`` first in the spine (an inline SVG: the artwork with the typeset text
    over it) and a ``cover-image`` (the artwork itself, else the SVG). ``art`` = (bytes, ImageInfo) or None.
    An EPUB that already has a cover-image is returned unchanged."""
    from .ziputil import build_zip, read_zip  # noqa: PLC0415
    zf = read_zip(epub)
    names = zf.namelist()
    opf_name = "OEBPS/content.opf"
    if opf_name not in names:
        raise CoverError("the EPUB has no OEBPS/content.opf (it was not written by Akọwe)")
    opf = zf.read(opf_name).decode("utf-8")
    if "cover-image" in opf:
        return epub
    items, files = [], []
    if art is not None:
        data, info = art
        href = f"images/cover-art.{info.ext}"
        files.append((f"OEBPS/{href}", data))
        items.append(f"<item id=\"cover-image\" href=\"{href}\" media-type=\"{info.mime}\" properties=\"cover-image\"/>")
    else:
        files.append(("OEBPS/images/cover.svg", (svg_file or "").encode("utf-8")))
        items.append("<item id=\"cover-image\" href=\"images/cover.svg\" media-type=\"image/svg+xml\" "
                     "properties=\"cover-image\"/>")
    xhtml = ("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n"
             f"<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" "
             f"lang={_xml_quoteattr(lang)} xml:lang={_xml_quoteattr(lang)}>\n<head>\n<meta charset=\"utf-8\"/>\n"
             f"<title>{_xml_escape(title or 'Cover')}</title>\n"
             "<style>html, body { margin: 0; padding: 0; height: 100%; text-align: center; } "
             "section.cover { height: 100%; } section.cover svg { display: block; width: 100%; height: 100vh; "
             "margin: 0 auto; }</style>\n</head>\n<body>\n"
             f"<section epub:type=\"cover\" class=\"cover\">{svg_inline}</section>\n</body>\n</html>\n")
    files.append(("OEBPS/text/cover.xhtml", xhtml.encode("utf-8")))
    items.append("<item id=\"cover\" href=\"text/cover.xhtml\" media-type=\"application/xhtml+xml\" "
                 "properties=\"svg\"/>")
    opf = opf.replace("</manifest>", "".join(i + "\n" for i in items) + "</manifest>", 1)
    opf = re.sub(r"<spine([^>]*)>\n?", lambda mm: f"<spine{mm.group(1)}>\n<itemref idref=\"cover\"/>\n", opf, count=1)
    opf = opf.replace("</metadata>", "<meta name=\"cover\" content=\"cover-image\"/>\n</metadata>", 1)
    entries = []
    for n in names:
        entries.append((n, opf.encode("utf-8") if n == opf_name else zf.read(n)))
        if n == opf_name:
            entries.extend(files)
    return build_zip(entries)


EMU_PER_PT = 12700


def add_cover_docx(docx: bytes, *, texts: dict, art: tuple | None) -> bytes:
    """The DOCX with a cover page in front: series, the title (Title style), subtitle, the artwork fitted to the page,
    the author; then a page break. ``art`` = (bytes, ImageInfo) or None (typographic cover page)."""
    from .docx import _drawing, escape  # noqa: PLC0415
    from .ziputil import build_zip, read_zip  # noqa: PLC0415
    zf = read_zip(docx)
    names = zf.namelist()
    doc = zf.read("word/document.xml").decode("utf-8")
    if "akowe-cover" in doc:
        return docx
    rels = zf.read("word/_rels/document.xml.rels").decode("utf-8")
    ctypes = zf.read("[Content_Types].xml").decode("utf-8")
    pw, ph, mar = 612.0, 792.0, 72.0  # Word's default page when the section names none
    m1 = re.search(r"<w:pgSz w:w=\"(\d+)\" w:h=\"(\d+)\"", doc)
    if m1:
        pw, ph = int(m1.group(1)) / 20.0, int(m1.group(2)) / 20.0
    m2 = re.search(r"<w:pgMar w:top=\"(\d+)\"", doc)
    if m2:
        mar = int(m2.group(1)) / 20.0

    def para(text, size_pt, *, style=None, bold=False, italic=False, caps=False, space_after=120):
        ppr = (f"<w:pStyle w:val=\"{style}\"/>" if style else "") + \
            f"<w:jc w:val=\"center\"/><w:spacing w:before=\"0\" w:after=\"{space_after}\"/>"
        rpr = ("<w:b/>" if bold else "") + ("<w:i/>" if italic else "") + ("<w:caps/>" if caps else "") + \
            f"<w:sz w:val=\"{int(size_pt * 2)}\"/>"
        return (f"<w:p><w:pPr>{ppr}</w:pPr><w:r><w:rPr>{rpr}</w:rPr><w:t xml:space=\"preserve\">{escape(text)}</w:t>"
                "</w:r></w:p>")
    tx = {k: (texts.get(k) or "").strip() for k in ("title", "subtitle", "author", "series", "tagline")}
    parts = ["<w:bookmarkStart w:id=\"9000\" w:name=\"akowe-cover\"/><w:bookmarkEnd w:id=\"9000\"/>"]
    if tx["series"]:
        parts.append(para(tx["series"], 11, caps=True))
    parts.append(para(tx["title"] or "Untitled", 30 if len(tx["title"]) < 40 else 22, style="Title", bold=True))
    if tx["subtitle"]:
        parts.append(para(tx["subtitle"], 15, italic=True))
    files = []
    if art is not None:
        data, info = art
        rid = "rIdAkoweCover"
        target = f"media/akowe-cover.{info.ext}"
        files.append((f"word/{target}", data))
        rels = rels.replace("</Relationships>", f"<Relationship Id=\"{rid}\" Type=\"http://schemas.openxmlformats."
                            f"org/officeDocument/2006/relationships/image\" Target=\"{target}\"/></Relationships>")
        ext = info.ext
        if f"Extension=\"{ext}\"" not in ctypes:
            ctypes = ctypes.replace("<Default Extension=\"xml\"", f"<Default Extension=\"{ext}\" ContentType="
                                    f"\"{info.mime}\"/><Default Extension=\"xml\"", 1)
        box_w, box_h = pw - 2 * mar, (ph - 2 * mar) * 0.6
        s = min(box_w / info.width, box_h / info.height)
        cx, cy = int(info.width * s * EMU_PER_PT), int(info.height * s * EMU_PER_PT)
        parts.append("<w:p><w:pPr><w:jc w:val=\"center\"/><w:spacing w:before=\"120\" w:after=\"240\"/></w:pPr>"
                     + _drawing(rid, 9000, cx, cy, "Cover", info.orientation) + "</w:p>")
    elif tx["tagline"]:
        parts.append(para(tx["tagline"], 13, italic=True, space_after=600))
    if tx["author"]:
        parts.append(para(tx["author"], 16, caps=True))
    parts.append("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>")
    doc = doc.replace("<w:body>", "<w:body>" + "".join(parts), 1)
    out = []
    for n in names:
        if n == "word/document.xml":
            out.append((n, doc.encode("utf-8")))
        elif n == "word/_rels/document.xml.rels":
            out.append((n, rels.encode("utf-8")))
        elif n == "[Content_Types].xml":
            out.append((n, ctypes.encode("utf-8")))
        else:
            out.append((n, zf.read(n)))
    return build_zip(out + files)


def effective_dpi(img: ImageInfo, box_w_pt: float, box_h_pt: float) -> float:
    """Pixels per inch of the artwork when it covers a box (the smaller of the two directions)."""
    s = max(box_w_pt / img.width, box_h_pt / img.height)  # pt per pixel
    return IN / s if s > 0 else math.inf
