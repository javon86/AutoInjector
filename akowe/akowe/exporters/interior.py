"""🎨 Interior themes: the inside of the printed book, as polished as a book-design program makes it.

Eight themes: one per Book Bible look (``binder.LOOKS``: classic, fantasy, scifi, noir, romance, horror, playful) and
``plain`` (a quiet classic page with no ornaments). A book uses the theme it chose (book profile ``interior_theme``),
else its genre's look (``binder.look_for_genre``). Five trim sizes (``TRIMS``; book profile ``trim_size``, default
6 x 9 in). Each theme decides:

* the body font (``times`` or ``helvetica``: the PDF's standard fonts; letters they lack are still set in the bundled
  DejaVu Serif, ``unifont``) and the heading font (``times``, ``helvetica`` or ``courier``);
* the chapter opener: how far down the page it starts (``sink``), the chapter number ("Chapter Seven", "7", "VII",
  "07", or none), the title under it, a rule or ornament, a **drop cap** (the first letter over 2-4 lines) and the
  first words in small capitals;
* the **scene-break ornament** that replaces ``* * *`` (drawn with vector shapes in the PDF, so no font can lack it;
  a glyph every bundled font has in the EPUB and Word files);
* running headers (author on the left page, title on the right, or title / chapter) and the page number (centre or
  outer corner) — never on a chapter opener, a blank page or the title page;
* whether chapters start on a right-hand page (a blank left page is added when needed).

Margins (``margins_for``): the inner margin (the gutter, where the pages are bound) is larger than the outer one and
grows with the page count (the usual print-on-demand minimums plus a comfortable extra). Left pages are mirrored.
Widows and orphans: a paragraph never leaves one line alone at the foot or the head of a page when it can be helped.

Text fidelity: the PDF prints "CHAPTER SEVEN" / small capitals / UPPER-CASE titles, but carries the book's own words
as ``/ActualText`` (what a PDF reader copies and searches), so the export check reads the text exactly as written. The
ornaments are shapes, not text, so they are never "extra text".

``paginate_themed`` composes the pages (``layout.paginate(..., interior=spec)`` calls it); ``epub_css`` gives the
EPUB writer its part (the Word writer reads the spec itself); ``preview`` draws a chapter-opener spread and a normal
spread from the real page layout (``preview_svg``) for the Book format page.
"""
from __future__ import annotations

import math
import threading

from . import unifont
from .fontmetrics import DESCRIPTORS
from .layout import (FAMILIES, Geometry, Layout, LayoutError, Page, Typography, _Composer, check_geometry,
                     mm_to_pt, pdf_text, styled_words, text_width)

DEFAULT_TRIM = "6x9"
TRIMS = {  # id -> (width mm, height mm, plain label)
    "5x8": (127.0, 203.2, "5 × 8 in (small paperback)"),
    "5.25x8": (133.35, 203.2, "5.25 × 8 in (paperback)"),
    "5.5x8.5": (139.7, 215.9, "5.5 × 8.5 in (trade paperback)"),
    "6x9": (152.4, 228.6, "6 × 9 in (trade paperback, the usual size)"),
    "a5": (148.0, 210.0, "A5 (148 × 210 mm)"),
}
FONTS = {"times": "Times (a classic book serif)", "helvetica": "Helvetica (a clean sans-serif)"}
HEAD_FONTS = ("times", "helvetica", "courier")
NUMBER_STYLES = ("words", "digits", "roman", "padded", "none")
ORNAMENTS = ("dots3", "diamonds3", "fleuron", "trefoil", "squares3", "bars3", "heart", "cross", "circles3")

# The EPUB / Word stand-in for each drawn ornament: characters that every bundled font has (DejaVu Serif covers them;
# U+2022 and U+00B7 are in WinAnsi too).
ORNAMENT_TEXT = {"dots3": "•  •  •", "diamonds3": "◆  ◆  ◆", "fleuron": "—  ◆  —", "trefoil": "⁂",
                 "squares3": "◇  ◇  ◇", "bars3": "—  —  —", "heart": "♥", "cross": "·  †  ·", "circles3": "○  ○  ○"}


def _t(**kw) -> dict:
    base = {"body": "times", "head": "times", "head_style": "regular", "number": "words", "number_prefix": "Chapter",
            "number_case": "upper", "number_size": 1.0, "number_track": 0.18, "title_case": "asis",
            "title_style": "italic", "title_size": 1.7, "title_track": 0.0, "rule": None, "sink": 0.22,
            "drop_cap": 3, "drop_style": "regular", "small_caps": 4, "scene": "dots3", "recto_start": False,
            "header": "author-title", "header_case": "upper", "folio": "center", "accent": "#333333"}
    base.update(kw)
    return base


THEMES = {
    "plain": _t(label="Plain classic", look=None, feel="A quiet, traditional page: Times, “Chapter One”, no drop cap "
                "and three small dots between scenes.", number_case="title", number_track=0.0, title_style="regular",
                title_size=1.5, drop_cap=0, small_caps=0, scene="dots3", header="author-title", header_case="italic",
                sink=0.18),
    "classic": _t(label="Classic", look="classic", feel="Literary and timeless: “CHAPTER SEVEN” in spaced capitals, an "
                  "italic title, a fine rule with a diamond, a three-line drop cap and small capitals.",
                  rule="fleuron", scene="fleuron", recto_start=True, accent="#1f4d3a"),
    "fantasy": _t(label="Fantasy", look="fantasy", feel="Old-world and grand: a large Roman numeral, the title in "
                  "spaced capitals, a four-line drop cap and a trefoil between scenes.", number="roman",
                  number_prefix="", number_size=2.6, number_track=0.05, title_case="upper", title_style="regular",
                  title_size=1.25, title_track=0.16, rule="diamonds3", drop_cap=4, small_caps=3, scene="trefoil",
                  recto_start=True, header="title-chapter", header_case="italic", folio="outer", accent="#7a1f2b"),
    "scifi": _t(label="Science fiction", look="scifi", feel="Clean and modern: Helvetica headings, a big “07”, a thin "
                "line, a two-line drop cap and three squares between scenes.", head="helvetica", head_style="bold",
                number="padded", number_prefix="", number_size=2.4, number_track=0.02, title_case="upper",
                title_style="regular", title_size=1.15, title_track=0.2, rule="rule", drop_cap=2, drop_style="bold",
                small_caps=3, scene="squares3", header="title-chapter", header_case="upper", folio="outer",
                accent="#0a8fa8", sink=0.25),
    "noir": _t(label="Noir case file", look="noir", feel="A typewriter case file: “CHAPTER 7” in Courier, a heavy bar, "
               "a two-line drop cap and three dashes between scenes.", head="courier", head_style="bold",
               number="digits", number_track=0.1, title_case="asis", title_style="regular", title_size=1.35,
               rule="bar", drop_cap=2, drop_style="bold", small_caps=0, scene="bars3", header="title-chapter",
               header_case="upper", folio="outer", accent="#b3161b", sink=0.2),
    "romance": _t(label="Romance", look="romance", feel="Soft and elegant: an italic “Chapter Seven”, a graceful "
                  "title, a small heart, a three-line italic drop cap and small capitals.", head_style="italic",
                  number_case="title", number_track=0.02, number_size=1.25, title_style="regular", title_size=1.9,
                  rule="heart", drop_cap=3, drop_style="italic", small_caps=4, scene="heart", header="author-title",
                  header_case="italic", accent="#b4516b"),
    "horror": _t(label="Horror", look="horror", feel="Stark and heavy: a huge chapter number, the title in spaced "
                 "bold capitals, a thick-and-thin rule, a three-line drop cap and a small cross between scenes.",
                 head_style="bold", number="digits", number_prefix="", number_size=3.6, number_track=0.0,
                 title_case="upper", title_style="bold", title_size=1.2, title_track=0.18, rule="thickthin",
                 drop_cap=3, drop_style="bold", small_caps=3, scene="cross", header="author-title",
                 header_case="upper", accent="#8a0f0f", sink=0.26),
    "playful": _t(label="Playful", look="playful", feel="Bright and friendly: Helvetica, the chapter number in a circle, "
                  "a bold title, a two-line drop cap and three little circles between scenes.", body="helvetica",
                  head="helvetica", head_style="bold", number="circle", number_prefix="", number_size=1.6,
                  number_track=0.0, title_style="bold", title_size=1.6, rule=None, drop_cap=2, drop_style="bold",
                  small_caps=0, scene="circles3", header="title-chapter", header_case="asis", accent="#ff6b35",
                  sink=0.2),
}
LOOK_THEME = {t["look"]: k for k, t in THEMES.items() if t["look"]}


# ---------------------------------------------------------------------------------------------- choices
def theme_for_genre(genre: str | None) -> str:
    from ..binder import look_for_genre  # noqa: PLC0415 - the Book Bible's genre -> look map
    return LOOK_THEME.get(look_for_genre(genre), "classic")


def chosen(profile: dict | None) -> dict:
    """The book's interior choices: {theme, theme_default, theme_stored, trim, trim_stored, font, font_stored}."""
    prof = profile or {}
    default = theme_for_genre(prof.get("genre"))
    stored = prof.get("interior_theme") or ""
    trim = prof.get("trim_size") or ""
    font = prof.get("interior_font") or ""
    return {"theme": stored if stored in THEMES else default, "theme_default": default,
            "theme_stored": stored if stored in THEMES else None,
            "trim": trim if trim in TRIMS else DEFAULT_TRIM, "trim_stored": trim if trim in TRIMS else None,
            "font": font if font in FONTS else THEMES[stored if stored in THEMES else default]["body"],
            "font_stored": font if font in FONTS else None}


def spec(theme: str, *, font: str | None = None, trim: str = DEFAULT_TRIM) -> dict:
    """The full interior spec stored with a pagination (JSON): the theme's settings, the body font and the trim."""
    t = dict(THEMES.get(theme) or THEMES["classic"])
    t.pop("feel", None)
    t["id"] = theme if theme in THEMES else "classic"
    if font in FONTS:
        t["body"] = font
    t["trim"] = trim if trim in TRIMS else DEFAULT_TRIM
    return t


def for_profile(profile: dict | None) -> dict | None:
    """The interior spec of a book (None for a book without a profile: the plain manuscript layout of old)."""
    if not profile:
        return None
    c = chosen(profile)
    return spec(c["theme"], font=c["font"], trim=c["trim"])


def clean_choice(key: str, value) -> str:
    """Validate a book-profile interior field (``interior_theme``, ``trim_size``, ``interior_font``); "" = default."""
    if value in (None, ""):
        return ""
    allowed = {"interior_theme": THEMES, "trim_size": TRIMS, "interior_font": FONTS}[key]
    if value not in allowed:
        raise ValueError(f"{key}: one of " + ", ".join(allowed) + " (or empty for the default)")
    return value


def trim_page(trim: str) -> dict:
    """The PAGE_PROFILE data of a trim size (no bleed: a manuscript/print-ready interior PDF)."""
    w, h, _label = TRIMS.get(trim) or TRIMS[DEFAULT_TRIM]
    return {"width_mm": w, "height_mm": h, "bleed_mm": 0, "safe_margin_mm": 15}


def trim_of(page: dict) -> str | None:
    for k, (w, h, _l) in TRIMS.items():
        if abs(page.get("width_mm", 0) - w) < 0.05 and abs(page.get("height_mm", 0) - h) < 0.05:
            return k
    return None


# ---------------------------------------------------------------------------------------------- margins
def gutter_in(pages: int) -> float:
    """The usual print-on-demand minimum inside margin (inches) for a page count."""
    for limit, inch in ((150, 0.375), (300, 0.5), (500, 0.625), (700, 0.75)):
        if pages <= limit:
            return inch
    return 0.875


def margins_for(page: dict, pages: int, body_size: float = 11.0) -> dict:
    """{top, bottom, left (inner), right (outer)} in pt: inner = the gutter minimum + 0.25 in (never under 0.7 in),
    outer 0.6 in, top/bottom leave room for the running header and the page number above the safe margin."""
    safe = mm_to_pt(page["safe_margin_mm"])
    head = body_size * 0.8
    inner = max(gutter_in(pages) + 0.25, 0.7) * 72
    outer = max(0.6 * 72, safe)
    top = max(0.75 * 72, safe + head + body_size * 1.1)
    bottom = max(0.75 * 72, safe + head + body_size * 1.6)
    return {"top": round(top, 2), "bottom": round(bottom, 2), "left": round(inner, 2), "right": round(outer, 2)}


# ---------------------------------------------------------------------------------------------- numbers
_ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
         "seventeen eighteen nineteen").split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def number_words(n: int) -> str:
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + ("-" + _ONES[n % 10] if n % 10 else "")
    if n < 1000:
        rest = n % 100
        return _ONES[n // 100] + " hundred" + (" " + number_words(rest) if rest else "")
    return str(n)


def roman(n: int) -> str:
    out = ""
    for v, s in ((1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
                 (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")):
        while n >= v:
            out += s
            n -= v
    return out


def _title_case(s: str) -> str:
    return "-".join(" ".join(w[:1].upper() + w[1:] for w in part.split(" ")) for part in s.split("-"))


def number_label(n: int | None, th: dict) -> str:
    """The chapter number as the theme prints it ("CHAPTER SEVEN", "Chapter Seven", "VII", "07", "7"; "" for none)."""
    if not n or th["number"] == "none":
        return ""
    core = {"words": number_words(n), "digits": str(n), "roman": roman(n), "padded": f"{n:02d}",
            "circle": str(n)}.get(th["number"], str(n))
    prefix = th.get("number_prefix") or ""
    label = f"{prefix} {core}".strip()
    if th["number_case"] == "upper":
        return label.upper()
    if th["number_case"] == "title":
        return _title_case(label)
    return label


def _upper(text: str) -> str:
    up = text.upper()
    return text if unifont.uncovered(up) else up


# ---------------------------------------------------------------------------------------------- the composer
def _fonts(fam: str) -> dict:
    reg, bold, ital = FAMILIES[fam]
    return {"regular": reg, "bold": bold, "italic": ital}


def _cap(font: str) -> float:
    d = DESCRIPTORS.get(font)
    return (d["cap"] if d else 700) / 1000.0


class ThemedComposer(_Composer):
    def __init__(self, geom: Geometry, typo: Typography, images: dict, th: dict, meta: dict):
        super().__init__(geom, Typography(th.get("body") or typo.family, typo.size, typo.leading), images)
        self.th = th
        self.meta = meta or {}
        self.head = _fonts(th.get("head") or "times")
        self.label = ""

    # ------------------------------------------------------------------ pages
    def new_page(self):
        p = super().new_page()
        p.label = self.label
        return p

    def start_section(self, sec: dict):
        self.label = sec.get("title") or sec.get("heading") or ""
        self.new_page()
        if sec["kind"] == "chapter" and self.th.get("recto_start") and self.page.number % 2 == 0:
            self.page.role = "blank"
            self.new_page()

    def head_font(self, style: str | None = None) -> str:
        return self.head.get(style or self.th.get("head_style") or "regular") or self.head["regular"]

    # ------------------------------------------------------------------ text drawing helpers
    def text_op(self, font, size, x, y, text, *, tc=0.0, actual=None, tw=0.0):
        self.page.ops.append(("text", font, size, x, y, text, tw, None, tc, actual))

    def tracked_width(self, text: str, font: str, size: float, tc: float) -> float:
        return text_width(text, font, size) + tc * max(len(text) - 1, 0)

    def centred(self, text: str, font: str, size: float, *, track: float = 0.0, actual=None, lead=None):
        """One or more centred lines (wrapped to the text width); ``track`` = letter spacing in em."""
        tc = size * track
        lead = lead or size * 1.25
        lines = []
        cur = ""
        for w in pdf_text(text).split():
            cand = (cur + " " + w).strip()
            if cur and self.tracked_width(cand, font, size, tc) > self.g.content_width:
                lines.append(cur)
                cur = w
            else:
                cur = cand
        if cur:
            lines.append(cur)
        for ln in lines:
            if self.tracked_width(ln, font, size, tc) > self.g.content_width:  # a single over-long word
                tc = 0.0
            w = self.tracked_width(ln, font, size, tc)
            self.text_op(font, size, self.g.left + (self.g.content_width - w) / 2.0, self.y - size, ln, tc=tc,
                         actual=actual)
            actual = "" if actual is not None else None  # the whole actual text rides on the first line
            self.y -= lead
        return lines

    # ------------------------------------------------------------------ ornaments (vector shapes)
    def ornament(self, kind: str | None, cx: float, cy: float, scale: float = 1.0):
        if not kind:
            return
        s = self.t.size / 11.0 * scale
        ink = (0.1, 0.1, 0.1)
        ops = self.page.ops

        def diamond(x, y, r):
            ops.append(("poly", [(x, y + r), (x + r * 0.75, y), (x, y - r), (x - r * 0.75, y)], ink, None, 0))

        if kind == "dots3":
            for dx in (-11, 0, 11):
                ops.append(("circle", cx + dx * s, cy, 1.15 * s, ink, None, 0))
        elif kind == "diamonds3":
            for dx in (-13, 0, 13):
                diamond(cx + dx * s, cy, 2.6 * s)
        elif kind == "fleuron":
            diamond(cx, cy, 3.4 * s)
            for side in (-1, 1):
                ops.append(("circle", cx + side * 8 * s, cy, 1.0 * s, ink, None, 0))
                ops.append(("line", cx + side * 12 * s, cy, cx + side * 38 * s, cy, ink, 0.5 * s))
        elif kind == "trefoil":
            for ang in (90, 210, 330):
                a = math.radians(ang)
                ops.append(("circle", cx + math.cos(a) * 2.6 * s, cy + math.sin(a) * 2.6 * s, 2.0 * s, ink, None, 0))
            for side in (-1, 1):
                ops.append(("line", cx + side * 8 * s, cy, cx + side * 24 * s, cy, ink, 0.5 * s))
                diamond(cx + side * 27 * s, cy, 1.6 * s)
        elif kind == "squares3":
            for dx in (-12, 0, 12):
                r = 1.9 * s
                ops.append(("rect", cx + dx * s - r, cy - r, 2 * r, 2 * r, None, ink, 0.7 * s))
        elif kind == "bars3":
            for dx in (-14, 0, 14):
                ops.append(("line", cx + (dx - 5) * s, cy, cx + (dx + 5) * s, cy, ink, 1.4 * s))
        elif kind == "heart":
            pts = []
            for i in range(48):
                t = 2 * math.pi * i / 48
                x = 16 * math.sin(t) ** 3
                y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
                pts.append((cx + x * 0.28 * s, cy + (y + 2) * 0.28 * s))
            ops.append(("poly", pts, ink, None, 0))
            for side in (-1, 1):
                ops.append(("circle", cx + side * 11 * s, cy, 0.9 * s, ink, None, 0))
        elif kind == "cross":
            ops.append(("line", cx, cy - 5 * s, cx, cy + 5 * s, ink, 1.1 * s))
            ops.append(("line", cx - 3 * s, cy + 1.8 * s, cx + 3 * s, cy + 1.8 * s, ink, 1.1 * s))
            for side in (-1, 1):
                ops.append(("circle", cx + side * 10 * s, cy, 1.0 * s, ink, None, 0))
        elif kind == "circles3":
            for dx in (-12, 0, 12):
                ops.append(("circle", cx + dx * s, cy, 2.3 * s, None, ink, 0.8 * s))
        elif kind == "rule":
            ops.append(("line", cx - 60 * s, cy, cx + 60 * s, cy, ink, 0.6 * s))
        elif kind == "bar":
            ops.append(("line", self.g.left, cy, self.g.left + self.g.content_width, cy, ink, 2.2 * s))
        elif kind == "thickthin":
            ops.append(("line", cx - 45 * s, cy + 1.6 * s, cx + 45 * s, cy + 1.6 * s, ink, 1.8 * s))
            ops.append(("line", cx - 45 * s, cy - 1.4 * s, cx + 45 * s, cy - 1.4 * s, ink, 0.5 * s))

    # ------------------------------------------------------------------ headings
    def heading(self, sec: dict):
        if sec["kind"] != "chapter":
            self.minor_heading(sec)
            return
        th = self.th
        size, lead = self.t.size, self.t.leading
        self.page.role = "opener"
        self.y = self.g.height - self.g.top - self.g.content_height * th["sink"]
        self.mark(sec["id"], sec["heading"], 1)
        self.page.ops.append(("mc", sec["heading"]))  # what a reader copies: the heading as written
        label = number_label(sec.get("number"), th)
        hf = self.head_font()
        title = sec.get("title")
        if not label and not title:
            title = sec["heading"]
        if label:
            nsize = size * th["number_size"]
            if th["number"] == "circle":
                r = nsize * 1.05
                cy = self.y - r
                self.page.ops.append(("circle", self.g.left + self.g.content_width / 2.0, cy, r, None,
                                      (0.1, 0.1, 0.1), 1.4))
                w = text_width(label, hf, nsize)
                self.text_op(hf, nsize, self.g.left + (self.g.content_width - w) / 2.0, cy - nsize * _cap(hf) / 2.0,
                             label)
                self.y = cy - r - lead * 0.9
            else:
                self.centred(label, hf, nsize, track=th["number_track"], lead=nsize * 1.3)
                self.y -= lead * 0.4
        if title:
            tsize = size * th["title_size"]
            tfont = self.head_font(th["title_style"]) if th["title_style"] != "regular" else self.head["regular"]
            text = _upper(title) if th["title_case"] == "upper" else title
            self.centred(text, tfont, tsize, track=th["title_track"], lead=tsize * 1.2)
        if th.get("rule"):
            self.y -= lead * 0.5
            self.ornament(th["rule"], self.g.left + self.g.content_width / 2.0, self.y - lead * 0.3, 0.85)
            self.y -= lead * 0.6
        self.page.ops.append(("/mc",))
        self.y -= lead * 2.0
        self.opening = True

    def minor_heading(self, sec: dict):
        """Contents, front and back matter: a centred heading in the theme's heading font, lower on the page."""
        size, lead = self.t.size, self.t.leading
        self.page.role = "opener"
        self.y = self.g.height - self.g.top - self.g.content_height * 0.12
        self.mark(sec["id"], sec["heading"], 1)
        self.centred(sec["heading"], self.head_font(), size * 1.5, track=0.04, lead=size * 1.9)
        self.y -= lead * 1.5

    def title_page(self, sec: dict):
        size = self.t.size
        self.page.role = "title"
        self.mark(sec["id"], sec["heading"], 1)
        self.y = self.g.height - self.g.top - self.g.content_height / 3.2
        title = sec["heading"]
        shown = _upper(title) if self.th["title_case"] == "upper" or self.th["head"] != "times" else title
        self.page.ops.append(("mc", title))
        self.centred(shown, self.head_font("bold" if self.th["head_style"] == "bold" else "regular"), size * 2.4,
                     track=0.06 if shown != title else 0.0, lead=size * 3.0)
        self.page.ops.append(("/mc",))
        self.y -= self.t.leading
        self.ornament(self.th.get("rule") or self.th["scene"], self.g.left + self.g.content_width / 2.0,
                      self.y - self.t.leading * 0.3, 1.0)
        self.y -= self.t.leading * 2.2
        for b in sec["blocks"]:
            self.centred(b["text"], self.t.regular, size * 1.2, lead=self.t.leading * 1.4)

    # ------------------------------------------------------------------ paragraphs
    def body_fonts(self) -> dict:
        return {"": self.t.regular, "i": self.t.italic, "b": self.t.bold, "bi": self.t.bold}

    def para(self, block: dict, *, opening: bool = False, after_break: bool = False):
        size, lead = self.t.size, self.t.leading
        th = self.th
        runs = block.get("runs") or [(block["text"], "")]
        words = styled_words(runs, self.body_fonts())
        if not words:
            return
        pieces = [[(t, f, size, None) for t, f in w] for w in words]
        drop = None
        dc_lines = th["drop_cap"] if opening else 0
        if dc_lines:
            first = pieces[0]
            text0 = "".join(p[0] for p in first)
            k = 0
            while k < len(text0) and not text0[k].isalnum():
                k += 1
            if k < len(text0) and k < 3:
                dc_text = text0[:k + 1]
                rest = []
                cut = k + 1
                for t, f, s, a in first:
                    if cut >= len(t):
                        cut -= len(t)
                        continue
                    rest.append((t[cut:], f, s, a))
                    cut = 0
                dfont = self.head_font(th["drop_style"]) if th["drop_style"] != "regular" else self.head["regular"]
                if th["head"] == "courier" and th["drop_style"] == "regular":
                    dfont = self.head["regular"]
                capr = _cap(dfont)
                dsize = (dc_lines - 1) * lead / capr + size
                dw = text_width(dc_text, dfont, dsize) + size * (0.6 if dfont.endswith(("Italic", "Oblique")) else 0.3)
                drop = (dc_text, dfont, dsize, dw)
                if rest:
                    pieces[0] = rest
                else:
                    pieces = pieces[1:]
        sc = th["small_caps"] if (opening or after_break) else 0
        if sc:
            for wi in range(min(sc, len(pieces))):
                out = []
                for t, f, s, a in pieces[wi]:
                    out.extend(_small_caps(t, f, s))
                pieces[wi] = out
        indent = 0.0 if block.get("first") or opening or after_break else size * 1.5
        width = self.g.content_width

        def avail(i):
            if drop and i < dc_lines:
                return width - drop[3]
            return width - (indent if i == 0 else 0.0)

        lines = _wrap_pieces(pieces, avail, self.t.regular, size)
        if drop:
            self.ensure(lead * dc_lines)
        self.place(lines, avail, drop=drop, dc_lines=dc_lines)

    def place(self, lines, avail, *, drop=None, dc_lines=0):
        """Set the lines with widow/orphan control: never one line alone at the foot or head of a page when the
        paragraph can move instead (very short pages are allowed rather than a lonely line)."""
        lead = self.t.leading
        i, n = 0, len(lines)
        top_y = self.y
        while i < n:
            room = int((self.y - self.floor + 0.001) // lead)
            remaining = n - i
            k = remaining if room >= remaining else room
            if k < remaining and remaining >= 2:
                if k < 2:
                    k = 0
                elif remaining - k < 2:
                    k = remaining - 2 if remaining - 2 >= 2 else 0
            fresh = self.y >= self.g.height - self.g.top - 0.001
            if k == 0 and fresh:
                k = max(room, 1)
            for j in range(i, i + k):
                cap = None
                if j == 0 and drop:
                    top_y = self.y
                    cap = ("text", drop[1], drop[2], self.g.left, self.y - self.t.size - (dc_lines - 1) * lead,
                           drop[0], 0.0, None, 0.0, None)
                x0 = self.g.left + (self.g.content_width - avail(j))
                self.draw_line(lines[j], x0, avail(j), justify=j != n - 1, cap=cap)
            i += k
            if i < n:
                self.new_page()
        if drop and n < dc_lines:
            self.y = min(self.y, top_y - dc_lines * lead)

    def draw_line(self, words, x, width, *, justify: bool, cap=None):
        """One line of piece-words (justified unless it ends the paragraph). ``cap``: the drop-cap text op, drawn
        first and read together with the line's first words (one /ActualText: "The night", not "T" + "he night")."""
        size = self.t.size
        space = text_width(" ", self.t.regular, size)
        natural = sum(_pw(w) for w in words) + space * (len(words) - 1)
        tw = 0.0
        if justify and len(words) > 1:
            tw = (width - natural) / (len(words) - 1)
            if tw > size * 1.5:
                tw = 0.0
        baseline = self.y - size
        # The leading words read as one text as written: the drop cap with its first word, and the words in small
        # capitals ("The night was", not "T" + "HE NIGHT WAS"): one /ActualText group, ending with a space.
        g = 0
        while g < len(words) and any(p[3] is not None for p in words[g]):
            g += 1
        if cap is not None and g == 0 and words:
            g = 1

        def runs_of(ws, trailing: bool):
            runs = []  # [font, size, text]
            for wi, w in enumerate(ws):
                for pi, (t, f, s, _a) in enumerate(w):
                    if wi and not pi and runs:
                        runs[-1][2] += " "
                    if runs and runs[-1][0] == f and runs[-1][1] == s:
                        runs[-1][2] += t
                    else:
                        runs.append([f, s, t])
            if trailing and runs:
                runs[-1][2] += " "
            return runs

        def emit(runs):
            nonlocal x
            for f, s, t in runs:
                self.page.ops.append(("text", f, s, x, baseline, t, tw, None, 0.0, None))
                x += text_width(t, f, s) + tw * t.count(" ")

        if g:
            written = " ".join("".join(a if a is not None else t for t, _f, _s, a in w) for w in words[:g])
            self.page.ops.append(("mc", (cap[5] if cap is not None else "") + written + " "))
            if cap is not None:
                self.page.ops.append(cap)
            emit(runs_of(words[:g], g < len(words)))
            self.page.ops.append(("/mc",))
        elif cap is not None:
            self.page.ops.append(cap)
        emit(runs_of(words[g:], False))
        self.y -= self.t.leading

    def scene_break(self):
        lead = self.t.leading
        self.ensure(lead * 4)  # the ornament keeps with the first lines after it
        self.y -= lead * 0.6
        self.ornament(self.th["scene"], self.g.left + self.g.content_width / 2.0, self.y - lead * 0.45)
        self.y -= lead * 1.6

    # ------------------------------------------------------------------ running heads, folios, mirroring
    def finish(self):
        th = self.th
        size = self.t.size * 0.8
        title = self.meta.get("title") or ""
        author = self.meta.get("author") or ""
        head_y = self.g.height - self.g.top + size * 1.3
        for p in self.pages:
            if p.role in ("blank", "opener", "title") or p.section_kind in ("title_page", "plate"):
                continue
            recto = p.number % 2 == 1
            num = str(p.number)
            fw = text_width(num, self.t.regular, size)
            if th["folio"] == "outer":
                fx = self.g.left + self.g.content_width - fw if recto else self.g.left
            else:
                fx = self.g.left + (self.g.content_width - fw) / 2.0
            p.ops.append(("text", self.t.regular, size, fx, self.footer_y, num, 0.0, None, 0.0, None))
            if th["header"] == "none" or p.section_kind not in ("chapter", "back"):
                continue
            if th["header"] == "title-chapter":
                text = (p.label or title) if recto else title
            else:
                text = title if recto else (author or title)
            if not text:
                continue
            font = self.t.italic if th["header_case"] == "italic" else self.head_font("regular") \
                if th["head"] != "times" else self.t.regular
            shown = _upper(text) if th["header_case"] == "upper" else text
            tc = size * 0.14 if th["header_case"] == "upper" else 0.0
            while shown and self.tracked_width(shown, font, size, tc) > self.g.content_width * 0.9:
                shown = shown[:-2].rstrip() + "…" if len(shown) > 2 else ""
            if not shown:
                continue
            hx = self.g.left + (self.g.content_width - self.tracked_width(shown, font, size, tc)) / 2.0
            p.ops.append(("text", font, size, hx, head_y, shown, 0.0, None, tc, text if shown != text else None))
        # left-hand (even) pages: the wider margin is on the right (the spine side)
        dx = self.g.right - self.g.left
        if abs(dx) > 0.001:
            for p in self.pages:
                if p.number % 2 == 0:
                    p.ops = [_shift(op, dx) for op in p.ops]
                    p.links = [(x0 + dx, y0, x1 + dx, y1, h) for (x0, y0, x1, y1, h) in p.links]


def _shift(op, dx):
    k = op[0]
    if k == "text":
        return op[:3] + (op[3] + dx,) + op[4:]
    if k in ("rect", "circle"):
        return op[:1] + (op[1] + dx,) + op[2:]
    if k == "line":
        return (k, op[1] + dx, op[2], op[3] + dx) + op[4:]
    if k == "img":
        clip = op[6]
        return (k, op[1], op[2] + dx, op[3], op[4], op[5], (clip[0] + dx,) + tuple(clip[1:]) if clip else None)
    if k == "poly":
        return (k, [(x + dx, y) for x, y in op[1]]) + op[2:]
    return op


def _small_caps(text: str, font: str, size: float) -> list:
    """Lower-case letters as capitals at 78 %: [(shown, font, size, actual)] pieces (actual = the letters as written,
    so the PDF's text reads as the author wrote it)."""
    out = []
    buf, low = "", None
    for ch in text:
        lc = ch.islower()
        if low is not None and lc != low:
            out.append(_sc_piece(buf, low, font, size))
            buf = ""
        buf += ch
        low = lc
    if buf:
        out.append(_sc_piece(buf, low, font, size))
    return out


def _sc_piece(buf: str, low: bool, font: str, size: float):
    if not low:
        return (buf, font, size, None)
    up = _upper(buf)
    if up == buf:
        return (buf, font, size, None)
    return (up, font, size * 0.78, buf)


def _pw(word) -> float:
    return sum(text_width(t, f, s) for t, f, s, _a in word)


def _wrap_pieces(words: list, avail, space_font: str, size: float) -> list:
    """Greedy line breaking of piece-words with a width per line index (``avail(i)``)."""
    lines: list = []
    cur: list = []
    cur_w = 0.0
    space = text_width(" ", space_font, size)
    for w in words:
        ww = _pw(w)
        if ww > avail(len(lines)):  # an over-long token: break it by characters
            if cur:
                lines.append(cur)
                cur, cur_w = [], 0.0
            piece: list = []
            pw = 0.0
            for t, f, s, a in w:
                for ch in t:
                    cw = text_width(ch, f, s)
                    if piece and pw + cw > avail(len(lines)):
                        lines.append([piece])
                        piece, pw = [], 0.0
                    piece.append((ch, f, s, a if a is None else ""))
                    pw += cw
                if a and piece:  # keep the written letters with the last character of a small-caps piece
                    t_, f_, s_, _ = piece[-1]
                    piece[-1] = (t_, f_, s_, a)
            cur, cur_w = [piece], pw
            continue
        add = ww if not cur else cur_w + space + ww
        if cur and add > avail(len(lines)):
            lines.append(cur)
            cur, cur_w = [w], ww
        else:
            cur.append(w)
            cur_w = add
    if cur:
        lines.append(cur)
    return lines


def paginate_themed(book: dict, geom: Geometry, typo: Typography, th: dict, *, toc_entries=None, toc_style=None,
                    images=None) -> Layout:
    c = ThemedComposer(geom, typo, images or {}, th, book.get("meta") or {})
    errs = check_geometry(geom, c.t)
    if errs:
        raise LayoutError("; ".join(errs))
    style = toc_style or {"include_pages": True, "link_targets": True, "max_depth": 2}
    for sec in book["sections"]:
        if sec["kind"] == "toc" and toc_entries is None:
            continue
        c.kind = sec["kind"]
        c.start_section(sec)
        if sec["kind"] == "title_page":
            c.title_page(sec)
            continue
        if sec["kind"] == "toc":
            c.toc(sec, toc_entries, style["include_pages"], style["link_targets"])
            continue
        c.opening = False
        if sec["kind"] == "plate":
            if sec["blocks"]:
                c.plate_start(sec["blocks"][0])
        else:
            c.heading(sec)
        opened = sec["kind"] != "chapter"
        after_break = False
        for b in sec["blocks"]:
            t = b["t"]
            if t == "p":
                c.para(b, opening=not opened, after_break=after_break)
                opened, after_break = True, False
            elif t == "meta":
                c.paragraph(b["text"], align="center", indent_first=False)
            elif t == "h2":
                c.subheading(b)
                opened, after_break = True, False
            elif t == "break":
                c.scene_break()
                opened, after_break = True, True
            elif t == "img":
                c.image(b)
            elif t == "vmap":
                c.vector_map(b)
    if not c.pages:
        c.new_page()
    c.finish()
    return Layout(c.pages, c.heading_pages, c.positions, c.outline)


# ---------------------------------------------------------------------------------------------- EPUB / Word
_CSS_FONT = {"times": "Georgia, 'Times New Roman', serif", "helvetica": "'Helvetica Neue', Helvetica, Arial, "
             "sans-serif", "courier": "'Courier New', Courier, monospace"}


def epub_css(th: dict) -> str:
    """The theme's EPUB stylesheet additions: heading design, drop cap (::first-letter), small capitals
    (::first-line), the scene-break ornament (generated content, so it is never part of the text)."""
    head = _CSS_FONT.get(th.get("head"), _CSS_FONT["times"])
    body = _CSS_FONT.get(th.get("body"), _CSS_FONT["times"])
    weight = "bold" if th.get("head_style") == "bold" else "normal"
    italic = "italic" if th.get("head_style") == "italic" else "normal"
    num_case = "uppercase" if th.get("number_case") == "upper" else "none"
    title_case = "uppercase" if th.get("title_case") == "upper" else "none"
    title_style = "italic" if th.get("title_style") == "italic" else "normal"
    title_weight = "bold" if th.get("title_style") == "bold" else "normal"
    orn = ORNAMENT_TEXT.get(th.get("scene"), "•  •  •").replace("\\", "\\\\").replace('"', '\\"')
    rule = ORNAMENT_TEXT.get(th.get("rule"), "") if th.get("rule") in ORNAMENT_TEXT else ""
    out = [f"body {{ font-family: {body}; }}",
           f"h1.chapter-head {{ font-family: {head}; font-weight: {weight}; font-style: {italic}; margin: 18% 0 2.2em; "
           "line-height: 1.2; }",
           f"h1.chapter-head .ch-num {{ display: block; font-size: {0.75 * th.get('number_size', 1):.2f}em; "
           f"text-transform: {num_case}; letter-spacing: {th.get('number_track', 0):.2f}em; margin-bottom: 0.35em; }}",
           f"h1.chapter-head .ch-title {{ display: block; font-size: {th.get('title_size', 1.6) / 1.6:.2f}em; "
           f"text-transform: {title_case}; letter-spacing: {th.get('title_track', 0):.2f}em; font-style: "
           f"{title_style}; font-weight: {title_weight}; }}",
           "div.scene-break { text-align: center; margin: 1.1em 0; min-height: 1em; text-indent: 0; }",
           f"div.scene-break::before {{ content: \"{orn}\"; letter-spacing: 0.1em; }}",
           "p.after-break::first-line { font-variant: small-caps; letter-spacing: 0.03em; }" if th.get("small_caps")
           else ""]
    if th.get("number") == "circle":
        out.append("h1.chapter-head .ch-num { display: inline-block; border: 2px solid currentColor; border-radius: "
                   "50%; min-width: 1.8em; line-height: 1.8em; margin-bottom: 0.5em; }")
    if rule:
        out.append(f"h1.chapter-head::after {{ content: \"{rule}\"; display: block; font-size: 0.6em; "
                   "margin-top: 0.8em; font-weight: normal; font-style: normal; }")
    if th.get("drop_cap"):
        lines = th["drop_cap"]
        out.append(f"p.opening::first-letter {{ float: left; font-family: {head}; font-size: {lines * 1.15 + 0.4:.2f}em; "
                   f"line-height: 0.85; padding: 0.06em 0.08em 0 0; font-weight: "
                   f"{'bold' if th.get('drop_style') == 'bold' else 'normal'}; font-style: "
                   f"{'italic' if th.get('drop_style') == 'italic' else 'normal'}; }}")
    if th.get("small_caps"):
        out.append("p.opening::first-line { font-variant: small-caps; letter-spacing: 0.03em; }")
    return "\n".join(x for x in out if x) + "\n"


# ---------------------------------------------------------------------------------------------- preview
SAMPLE = ("# The Lantern Road\n"
          "The night the river froze, Ada Okonkwọ climbed the bell tower with a lantern and a letter she had not "
          "dared to open. Below her the town slept under a skin of snow, every roof the same pale grey, every "
          "chimney breathing the same thin smoke.\n"
          "She broke the seal with her thumb. The paper was older than she expected, soft as cloth, and the ink had "
          "gone the colour of tea. *Come to the crossing at first light,* it said. *Bring nothing that can be "
          "taken from you.*\n"
          "“That rules out most things,” she said to the bells, and the bells, for once, kept quiet.\n"
          "She read it twice more, as if the words might change their minds, then folded it into the lining of her "
          "coat where her mother had once sewn a pocket for exactly this kind of secret. The wind came off the river "
          "with a sound like a held breath let go.\n"
          "* * *\n"
          "Morning came slowly, the way it does in the deep of winter, light seeping up from the east like water "
          "into cloth. Ada was already at the crossing when the first cart rattled over the ice, its driver wrapped "
          "so thickly in scarves that only his eyes showed.\n"
          "“You’re early,” he said. It was not a question, and it was not quite a welcome either.\n"
          "“I was told to bring nothing,” she said. “So I came quickly. Nothing is light.”\n"
          "He laughed at that, a short surprised sound, and the horses stamped and blew. Behind him, under a "
          "canvas sheet, something shifted that was not a sack of grain. Ada saw it and decided, for now, not to.\n"
          "They crossed together. The ice groaned and held, groaned and held, the long complaint of a river that "
          "would rather be moving. On the far bank the road climbed into pine woods so dark that the snow between "
          "the trunks seemed to glow on its own.\n"
          "“Where are we going?” she asked at last.\n"
          "“Where the letter says.” He did not look round. “You did read it?”\n"
          "“Twice,” she lied, and then, because lies sat badly with her in the cold, “Three times.”\n"
          "The driver nodded as though that settled something between them. The cart creaked on. Somewhere ahead a "
          "bell began to ring — not her bells, not any bell she knew — slow and low, like a heart remembering how.\n"
          "By noon the woods had thinned to a high white meadow, and in the middle of the meadow stood a house with "
          "every window lit.\n")


def preview_book(meta: dict, chapter_text: str | None = None, number: int = 7) -> dict:
    """A small book for the preview: one chapter (the book's own first chapter when it has one, else a sample)."""
    from . import book as bookmod  # noqa: PLC0415
    text = chapter_text or SAMPLE
    # enough text for three pages (the opener and a full normal spread), even from a short first chapter
    more = SAMPLE.split("\n", 1)[1]
    if len(text.split()) < 1400:
        text = text.rstrip() + "\n* * *\n" + more + "\n* * *\n" + more
    b = bookmod.build_book(meta, [{"id": "preview-ch", "text": text}],
                           title_rules={"pattern": "Chapter {number}: {title}", "include_number": True})
    sec = b["sections"][0]
    sec["number"] = number
    return b


def preview_layout(th: dict, trim: str, meta: dict, chapter_text: str | None = None, *, size: float = 11.0,
                   leading: float = 14.0, pages_hint: int = 280) -> tuple[Layout, Geometry]:
    from .layout import make_geometry  # noqa: PLC0415
    page = trim_page(trim)
    geom = make_geometry(page, margins_for(page, pages_hint, size))
    b = preview_book(meta, chapter_text, 1 if chapter_text else 7)
    lay = paginate_themed(b, geom, Typography(th.get("body") or "times", size, leading), th)
    return lay, geom


_SVG_FONT = {"Times-Roman": ("'Times New Roman', Times, 'Liberation Serif', 'Nimbus Roman', serif", "normal", "normal"),
             "Times-Bold": ("'Times New Roman', Times, 'Liberation Serif', serif", "bold", "normal"),
             "Times-Italic": ("'Times New Roman', Times, 'Liberation Serif', serif", "normal", "italic"),
             "Helvetica": ("Helvetica, Arial, 'Liberation Sans', sans-serif", "normal", "normal"),
             "Helvetica-Bold": ("Helvetica, Arial, 'Liberation Sans', sans-serif", "bold", "normal"),
             "Helvetica-Oblique": ("Helvetica, Arial, 'Liberation Sans', sans-serif", "normal", "italic"),
             "Courier": ("'Courier New', Courier, 'Liberation Mono', monospace", "normal", "normal"),
             "Courier-Bold": ("'Courier New', Courier, 'Liberation Mono', monospace", "bold", "normal"),
             "Courier-Oblique": ("'Courier New', Courier, 'Liberation Mono', monospace", "normal", "italic"),
             unifont.NAME: ("'DejaVu Serif', serif", "normal", "normal")}


def _esc(t: str) -> str:
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _col(c) -> str:
    if c is None:
        return "none"
    if isinstance(c, str):
        return c
    r, g, b = c
    if max(r, g, b) <= 1:
        r, g, b = r * 255, g * 255, b * 255
    return f"rgb({int(r)},{int(g)},{int(b)})"


def page_svg(page: Page, width: float, height: float) -> str:
    """One composed page as SVG (pt units, y flipped): the same lines, positions and shapes the PDF draws."""
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.1f} {height:.1f}" '
           f'data-page="{page.number}" data-role="{page.role or ""}" class="pv-page">',
           f'<rect x="0" y="0" width="{width:.1f}" height="{height:.1f}" fill="#fffdf8"/>']
    for op in page.ops:
        k = op[0]
        if k == "text":
            font, size, x, y, text, tw = op[1], op[2], op[3], op[4], op[5], op[6]
            tc = op[8] if len(op) > 8 else 0.0
            fam, weight, style = _SVG_FONT.get(font, _SVG_FONT["Times-Roman"])
            extra = (f' word-spacing="{tw:.2f}"' if tw else "") + (f' letter-spacing="{tc:.2f}"' if tc else "")
            out.append(f'<text x="{x:.2f}" y="{height - y:.2f}" font-family="{_esc(fam)}" font-size="{size:.2f}" '
                       f'font-weight="{weight}" font-style="{style}"{extra} xml:space="preserve">{_esc(text)}</text>')
        elif k == "line":
            _, x0, y0, x1, y1, col, lw = op
            out.append(f'<line x1="{x0:.2f}" y1="{height - y0:.2f}" x2="{x1:.2f}" y2="{height - y1:.2f}" '
                       f'stroke="{_col(col)}" stroke-width="{lw:.2f}"/>')
        elif k == "circle":
            _, cx, cy, r, fill, stroke, lw = op
            out.append(f'<circle cx="{cx:.2f}" cy="{height - cy:.2f}" r="{r:.2f}" fill="{_col(fill)}" '
                       f'stroke="{_col(stroke)}" stroke-width="{lw:.2f}"/>')
        elif k == "rect":
            _, x, y, w, h, fill, stroke, lw = op
            out.append(f'<rect x="{x:.2f}" y="{height - y - h:.2f}" width="{w:.2f}" height="{h:.2f}" '
                       f'fill="{_col(fill)}" stroke="{_col(stroke)}" stroke-width="{lw:.2f}"/>')
        elif k == "poly":
            _, pts, fill, stroke, lw = op
            p = " ".join(f"{x:.2f},{height - y:.2f}" for x, y in pts)
            out.append(f'<polygon points="{p}" fill="{_col(fill)}" stroke="{_col(stroke)}" stroke-width="{lw:.2f}"/>')
    out.append("</svg>")
    return "".join(out)


def _blank_svg(width: float, height: float, note: str = "") -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.1f} {height:.1f}" class="pv-page" '
            f'data-role="blank"><rect x="0" y="0" width="{width:.1f}" height="{height:.1f}" fill="#fffdf8"/>'
            + (f'<text x="{width / 2:.1f}" y="{height / 2:.1f}" text-anchor="middle" font-size="9" fill="#b9b2a4" '
               f'font-family="sans-serif">{_esc(note)}</text>' if note else "") + "</svg>")


_PDFIUM_LOCK = threading.Lock()


def _pdfium_pngs(layout: Layout, geom: Geometry, meta: dict, wanted: list[int]) -> dict | None:
    """The real PDF pages as PNG pictures (only when pypdfium2 is installed; it is optional)."""
    try:
        import pypdfium2 as pdfium  # noqa: PLC0415
    except Exception:  # noqa: BLE001 - optional
        return None
    import base64  # noqa: PLC0415
    import io  # noqa: PLC0415

    from .pdf import render_pdf  # noqa: PLC0415
    try:
        data = render_pdf(layout, page_width=geom.width, page_height=geom.height, meta=meta)
        out = {}
        with _PDFIUM_LOCK:  # pdfium is not thread-safe: one preview at a time (the server answers in threads)
            doc = pdfium.PdfDocument(data)
            try:
                for n in wanted:
                    if 1 <= n <= len(doc):
                        img = doc[n - 1].render(scale=1.6).to_pil()
                        buf = io.BytesIO()
                        img.save(buf, "PNG")
                        out[n] = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
            finally:
                doc.close()
        return out
    except Exception:  # noqa: BLE001 - a preview never breaks the page
        return None


def preview(theme: str, trim: str, meta: dict, chapter_text: str | None = None, *, font: str | None = None,
            render: str = "auto", size: float = 11.0, leading: float = 14.0) -> dict:
    """A chapter-opener spread and a normal spread, from the real page layout of this theme and trim.

    kind "pdf_image": pictures of the real PDF pages (pypdfium2 is installed); kind "layout_svg": the same composed
    pages drawn by the browser (exact lines, positions and ornaments; the letters are the computer's version of the
    font, so a line may look a hair longer or shorter than in the PDF)."""
    th = spec(theme, font=font, trim=trim)
    lay, geom = preview_layout(th, th["trim"], meta, chapter_text, size=size, leading=leading)
    pages = {p.number: p for p in lay.pages}
    opener = next((p.number for p in lay.pages if p.role == "opener"), 1)
    spreads = [[opener - 1, opener], [opener + 1, opener + 2]]
    pngs = _pdfium_pngs(lay, geom, meta, [n for s in spreads for n in s]) if render in ("auto", "pdf") else None
    kind = "pdf_image" if pngs else "layout_svg"
    out_spreads = []
    for pair, name in zip(spreads, ("Chapter opener", "Normal pages")):
        sides = []
        for n in pair:
            if n not in pages:
                sides.append({"page": n, "role": "blank", "svg": _blank_svg(geom.width, geom.height,
                                                                            "(end of the previous chapter)" if n else "")})
                continue
            p = pages[n]
            item = {"page": n, "role": p.role or "text"}
            if pngs and n in pngs:
                item["png"] = pngs[n]
            else:
                item["svg"] = page_svg(p, geom.width, geom.height)
            sides.append(item)
        out_spreads.append({"name": name, "pages": sides})
    w_in, h_in = geom.width / 72.0, geom.height / 72.0
    return {"kind": kind, "theme": th["id"], "trim": th["trim"], "font": th["body"],
            "page_size_in": [round(w_in, 3), round(h_in, 3)],
            "margins_in": {"top": round(geom.top / 72, 2), "bottom": round(geom.bottom / 72, 2),
                           "inside": round(geom.left / 72, 2), "outside": round(geom.right / 72, 2)},
            "spreads": out_spreads,
            "honest": ("These are pictures of the real PDF pages Akọwe makes with this design." if kind == "pdf_image"
                       else "Drawn from the real page layout Akọwe uses for the PDF (the same lines, spacing and "
                            "ornaments). Your browser draws the letters with its own copy of the font, so a line can "
                            "look a hair different from the PDF.")}


def options() -> dict:
    """Everything the Book format page offers (plain words)."""
    return {"themes": [{"id": k, "label": v["label"], "feel": v["feel"], "look": v["look"], "body": v["body"],
                        "drop_cap": v["drop_cap"], "scene": v["scene"], "accent": v["accent"]}
                       for k, v in THEMES.items()],
            "trims": [{"id": k, "label": v[2], "width_mm": v[0], "height_mm": v[1]} for k, v in TRIMS.items()],
            "fonts": [{"id": k, "label": v} for k, v in FONTS.items()], "default_trim": DEFAULT_TRIM}
