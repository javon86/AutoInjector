"""Deterministic page composition for the PDF path (G04 pagination, G07 TOC loop, G11 render).

Units: pt (1 pt = 25.4/72 mm). Text is set in a PDF base-14 family (Times, Helvetica or
Courier) with WinAnsi encoding and the Adobe AFM advance widths in fontmetrics.py, so line
breaking measures the exact glyph widths the viewer will use. Body paragraphs are justified
(PDF Tw word spacing) with a first-line indent; chapters start on a new page; sub-headings
keep with the next two lines; images scale into their placement box and never split.
Page numbers are continuous arabic numerals centred in the bottom margin. Inline emphasis
runs (book "runs") are set in the family's italic/bold faces. PDF text mapping: soft hyphens
(U+00AD) are invisible break hints and are dropped (no automatic hyphenation), narrow/figure
no-break spaces print as the WinAnsi no-break space, and no-break spaces never break a line.
Not implemented: hyphenation, kerning, widow/orphan control beyond keep-with-next.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .fontmetrics import WIDTHS

MM_PER_PT = 25.4 / 72.0
FAMILIES = {
    "times": ("Times-Roman", "Times-Bold", "Times-Italic"),
    "helvetica": ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique"),
    "courier": ("Courier", "Courier-Bold", "Courier-Oblique"),
}
FAMILY_ALIASES = {"times-roman": "times", "times": "times", "helvetica": "helvetica", "courier": "courier"}


class LayoutError(ValueError):
    pass


def mm_to_pt(mm: float) -> float:
    return mm / MM_PER_PT


def resolve_family(names: list[str]) -> str | None:
    for n in names:
        fam = FAMILY_ALIASES.get(n.strip().lower())
        if fam:
            return fam
    return None


# What the PDF prints for characters WinAnsi lacks but that have an exact typographic stand-in.
_PDF_MAP = str.maketrans({"\u00ad": None, "\u202f": "\u00a0", "\u2007": "\u00a0", "\u2060": None,
                          "\u2011": "-"})


def pdf_text(text: str) -> str:
    """Book text as the PDF sets it (see module doc): soft hyphens dropped, narrow no-break spaces mapped."""
    return text.translate(_PDF_MAP)


def unencodable(text: str) -> list[str]:
    bad = []
    for ch in sorted(set(pdf_text(text))):
        if ch in "\n\t":
            continue
        try:
            b = ch.encode("cp1252")
        except UnicodeEncodeError:
            bad.append(ch)
            continue
        if b[0] < 32:
            bad.append(ch)
    return bad


def encode(text: str) -> bytes:
    return text.encode("cp1252")


def text_width(text: str, font: str, size: float) -> float:
    table = WIDTHS[font]
    total = 0
    for byte in encode(text):
        total += table[byte - 32] if byte >= 32 else 0
    return total * size / 1000.0


@dataclass
class Geometry:
    width: float      # trim width pt
    height: float     # trim height pt
    top: float
    bottom: float
    left: float
    right: float
    safe: float = 0.0  # printer/profile safe margin (pt); page numbers stay inside it

    @property
    def content_width(self) -> float:
        return self.width - self.left - self.right

    @property
    def content_height(self) -> float:
        return self.height - self.top - self.bottom


@dataclass
class Typography:
    family: str
    size: float
    leading: float

    @property
    def regular(self) -> str:
        return FAMILIES[self.family][0]

    @property
    def bold(self) -> str:
        return FAMILIES[self.family][1]

    @property
    def italic(self) -> str:
        return FAMILIES[self.family][2]


def make_geometry(page: dict, margins_pt: dict) -> Geometry:
    """PAGE_PROFILE (mm) + requested margins (pt); safe margin is the minimum on every side."""
    safe = mm_to_pt(page["safe_margin_mm"])
    g = Geometry(mm_to_pt(page["width_mm"]), mm_to_pt(page["height_mm"]),
                 max(margins_pt["top"], safe), max(margins_pt["bottom"], safe),
                 max(margins_pt["left"], safe), max(margins_pt["right"], safe), safe)
    return g


def check_geometry(g: Geometry, typo: Typography) -> list[str]:
    errs = []
    if g.content_width <= 0:
        errs.append(f"margins leave no usable width ({g.content_width:.2f} pt)")
    if g.content_height <= 0:
        errs.append(f"margins leave no usable height ({g.content_height:.2f} pt)")
    if not errs:
        if g.content_height < typo.leading * 4:
            errs.append("usable height is smaller than four text lines")
        if g.content_width < typo.size * 8:
            errs.append("usable width is narrower than eight ems")
    return errs


@dataclass
class Page:
    # ("text", font, size, x, y, str, tw[, colour]) | ("img", key, x, y, w, h, clip)
    # | ("rect", x, y, w, h, fill colour|None, stroke colour|None, line width) | ("line", x0, y0, x1, y1, colour, width)
    ops: list = field(default_factory=list)
    links: list = field(default_factory=list)  # (x0, y0, x1, y1, heading_id)
    number: int = 0
    section_kind: str = ""
    size: tuple | None = None        # (width, height) pt when this page differs from the document (a landscape plate)
    background: tuple | str | None = None  # a full-page fill colour


@dataclass
class Layout:
    pages: list
    heading_pages: list          # [{"heading_id", "page"}] in reading order
    positions: dict              # heading_id -> (page_index, y_top)
    outline: list                # [(title, heading_id, level)]

    @property
    def page_count(self) -> int:
        return len(self.pages)

    def page_map(self) -> list:
        return [(h["heading_id"], h["page"]) for h in self.heading_pages]


def words_of(text: str) -> list[str]:
    """Break opportunities are ordinary spaces only (no-break spaces stay inside their word)."""
    return [w for w in pdf_text(text).replace("\t", " ").replace("\n", " ").split(" ") if w]


def wrap(text: str, font: str, size: float, width: float) -> list[list[str]]:
    words = words_of(text)
    lines: list[list[str]] = []
    cur: list[str] = []
    space = text_width(" ", font, size)
    cur_w = 0.0
    for w in words:
        ww = text_width(w, font, size)
        if ww > width:  # break an over-long token by characters
            if cur:
                lines.append(cur)
                cur, cur_w = [], 0.0
            piece = ""
            for ch in w:
                if text_width(piece + ch, font, size) > width and piece:
                    lines.append([piece])
                    piece = ch
                else:
                    piece += ch
            cur, cur_w = [piece], text_width(piece, font, size)
            continue
        add = ww if not cur else cur_w + space + ww
        if cur and add > width:
            lines.append(cur)
            cur, cur_w = [w], ww
        else:
            cur.append(w)
            cur_w = add
    if cur:
        lines.append(cur)
    return lines


def styled_words(runs: list, fonts: dict) -> list[list[tuple[str, str]]]:
    """Inline runs [(text, style)] -> words, each a list of (text, font) segments (a word may change face
    mid-word, e.g. an italic word followed by a roman comma)."""
    words: list[list[tuple[str, str]]] = []
    cur: list[tuple[str, str]] = []
    for text, style in runs:
        font = fonts.get(style) or fonts[""]
        for j, part in enumerate(pdf_text(text).replace("\t", " ").replace("\n", " ").split(" ")):
            if j and cur:
                words.append(cur)
                cur = []
            if part:
                if cur and cur[-1][1] == font:
                    cur[-1] = (cur[-1][0] + part, font)
                else:
                    cur.append((part, font))
    if cur:
        words.append(cur)
    return words


def _word_width(word, size: float) -> float:
    return sum(text_width(t, f, size) for t, f in word)


def wrap_styled(words: list, size: float, first_width: float, width: float, space_font: str) -> list[list]:
    """Greedy line breaking of styled words (same rules as wrap(); first line may be narrower)."""
    lines: list[list] = []
    cur: list = []
    cur_w = 0.0
    space = text_width(" ", space_font, size)

    def avail():
        return first_width if not lines else width

    for w in words:
        ww = _word_width(w, size)
        if ww > avail():  # break an over-long token by characters, keeping each character's face
            if cur:
                lines.append(cur)
                cur, cur_w = [], 0.0
            piece: list = []
            pw = 0.0
            for seg, font in w:
                for ch in seg:
                    cw = text_width(ch, font, size)
                    if piece and pw + cw > avail():
                        lines.append([piece])
                        piece, pw = [], 0.0
                    if piece and piece[-1][1] == font:
                        piece[-1] = (piece[-1][0] + ch, font)
                    else:
                        piece.append((ch, font))
                    pw += cw
            cur, cur_w = [piece], pw
            continue
        add = ww if not cur else cur_w + space + ww
        if cur and add > avail():
            lines.append(cur)
            cur, cur_w = [w], ww
        else:
            cur.append(w)
            cur_w = add
    if cur:
        lines.append(cur)
    return lines


class _Composer:
    def __init__(self, geom: Geometry, typo: Typography, images: dict):
        self.g = geom
        self.t = typo
        self.images = images
        self.pages: list[Page] = []
        self.y = 0.0
        self.heading_pages: list = []
        self.positions: dict = {}
        self.outline: list = []
        self.kind = ""

    # ----------------------------------------------------------------- page handling
    def new_page(self):
        p = Page(number=len(self.pages) + 1, section_kind=self.kind)
        self.pages.append(p)
        self.y = self.g.height - self.g.top
        return p

    @property
    def page(self) -> Page:
        return self.pages[-1]

    @property
    def footer_y(self) -> float:
        """Page-number baseline: centred in the bottom margin but never outside the safe area."""
        size = self.t.size * 0.9
        return max(self.g.bottom / 2.0 - size / 2.0, self.g.safe + size * 0.25, 2.0)

    @property
    def floor(self) -> float:
        return max(self.g.bottom, self.footer_y + self.t.size * 1.5)

    def ensure(self, height: float):
        if self.y - height < self.floor - 0.001:
            self.new_page()

    def mark(self, heading_id: str, title: str, level: int):
        self.heading_pages.append({"heading_id": heading_id, "page": len(self.pages)})
        self.positions[heading_id] = (len(self.pages) - 1, round(self.y, 2))
        self.outline.append((title, heading_id, level))

    # ----------------------------------------------------------------- drawing
    def line(self, words: list[str], font: str, size: float, *, align: str, indent: float = 0.0,
             justify: bool = False, width: float | None = None):
        width = (self.g.content_width if width is None else width) - indent
        text = " ".join(words)
        natural = text_width(text, font, size)
        x = self.g.left + indent
        tw = 0.0
        if align == "center":
            x = self.g.left + (self.g.content_width - natural) / 2.0
        elif align == "right":
            x = self.g.left + self.g.content_width - natural
        elif justify and len(words) > 1:
            tw = (width - natural) / (len(words) - 1)
            if tw > size * 1.5:
                tw = 0.0
        baseline = self.y - size
        self.page.ops.append(("text", font, size, x, baseline, text, tw))
        self.y -= self.t.leading * size / self.t.size

    def line_styled(self, words: list, size: float, *, indent: float = 0.0, justify: bool = False):
        """One justified/left-aligned line of styled words: one text op per run of the same face."""
        width = self.g.content_width - indent
        space = text_width(" ", self.t.regular, size)
        natural = sum(_word_width(w, size) for w in words) + space * (len(words) - 1)
        tw = 0.0
        if justify and len(words) > 1:
            tw = (width - natural) / (len(words) - 1)
            if tw > size * 1.5:
                tw = 0.0
        baseline = self.y - size
        x = self.g.left + indent
        cur_font, cur_text = None, ""

        def flush():
            nonlocal x
            if cur_font is not None and cur_text:
                self.page.ops.append(("text", cur_font, size, x, baseline, cur_text, tw))
                x += text_width(cur_text, cur_font, size) + tw * cur_text.count(" ")

        for wi, word in enumerate(words):
            for si, (seg, font) in enumerate(word):
                if wi and not si:
                    cur_text += " "  # the inter-word space belongs to the run before it
                if font != cur_font:
                    flush()
                    cur_font, cur_text = font, seg
                else:
                    cur_text += seg
        flush()
        self.y -= self.t.leading * size / self.t.size

    def paragraph_runs(self, runs: list, *, indent_first: bool = True):
        size = self.t.size
        lead = self.t.leading
        indent = size * 1.5 if indent_first else 0.0
        fonts = {"": self.t.regular, "i": self.t.italic, "b": self.t.bold, "bi": self.t.bold}
        words = styled_words(runs, fonts)
        if not words:
            return
        lines = wrap_styled(words, size, self.g.content_width - indent, self.g.content_width, self.t.regular)
        for i, ws in enumerate(lines):
            self.ensure(lead)
            self.line_styled(ws, size, indent=indent if i == 0 else 0.0, justify=i != len(lines) - 1)

    def paragraph(self, text: str, *, font: str | None = None, size: float | None = None, align: str = "justify",
                  indent_first: bool = True):
        font = font or self.t.regular
        size = size or self.t.size
        lead = self.t.leading * size / self.t.size
        indent = size * 1.5 if indent_first else 0.0
        first_lines = wrap(text, font, size, self.g.content_width - indent) if words_of(text) else []
        if not first_lines:
            return
        lines = [first_lines[0]]
        rest = " ".join(" ".join(ws) for ws in first_lines[1:])
        if rest:
            lines += wrap(rest, font, size, self.g.content_width)
        for i, words in enumerate(lines):
            self.ensure(lead)
            last = i == len(lines) - 1
            self.line(words, font, size, align="left" if align == "justify" else align,
                      indent=indent if i == 0 else 0.0, justify=(align == "justify" and not last))

    def heading(self, sec: dict):
        size = self.t.size * 1.6
        lead = self.t.leading * 1.6
        self.y -= self.t.leading * 3
        self.mark(sec["id"], sec["heading"], 1)
        for words in wrap(sec["heading"], self.t.bold, size, self.g.content_width):
            self.ensure(lead)
            self.line(words, self.t.bold, size, align="center")
        self.y -= self.t.leading * 1.5

    def subheading(self, block: dict):
        size = self.t.size * 1.2
        lead = self.t.leading * 1.2
        lines = wrap(block["text"], self.t.bold, size, self.g.content_width)
        self.ensure(self.t.leading * 0.8 + lead * len(lines) + self.t.leading * 2)
        if self.y < self.g.height - self.g.top - 0.001:
            self.y -= self.t.leading * 0.8
        self.mark(block["id"], block["text"], 2)
        for words in lines:
            self.ensure(lead)
            self.line(words, self.t.bold, size, align="left")
        self.y -= self.t.leading * 0.3

    def image(self, block: dict):
        info = self.images.get(block["key"])
        if info is None:
            raise LayoutError(f"image {block['key']} not supplied")
        box_w = min(mm_to_pt(block["w_mm"]), self.g.content_width)
        box_h = mm_to_pt(block["h_mm"]) * box_w / mm_to_pt(block["w_mm"])
        # Tallest box a page can hold: from the top of the text area down to the composer floor (which
        # keeps clear of the page number), less the space ensure() reserves around the image.
        max_h = max(self.g.height - self.g.top - self.floor - self.t.leading * 0.5, 1.0)
        if box_h > max_h:
            scale = max_h / box_h
            box_w, box_h = box_w * scale, box_h * scale
        iw, ih = info
        if block["fit"] == "CONTAIN":
            s = min(box_w / iw, box_h / ih)
            dw, dh = iw * s, ih * s
            clip = None
        else:  # COVER: fill the box, clip overflow
            s = max(box_w / iw, box_h / ih)
            dw, dh = iw * s, ih * s
            clip = True
        self.ensure(box_h + self.t.leading * 0.5)
        self.y -= self.t.leading * 0.25
        x_box = self.g.left + (self.g.content_width - box_w) / 2.0
        y_box = self.y - box_h
        x = x_box + (box_w - dw) / 2.0
        y = y_box + (box_h - dh) / 2.0
        self.page.ops.append(("img", block["key"], x, y, dw, dh,
                              (x_box, y_box, box_w, box_h) if clip else None))
        self.y = y_box - self.t.leading * 0.25

    def title_page(self, sec: dict):
        self.mark(sec["id"], sec["heading"], 1)
        self.y = self.g.height - self.g.top - self.g.content_height / 3.0
        size = self.t.size * 2.2
        for words in wrap(sec["heading"], self.t.bold, size, self.g.content_width):
            self.ensure(size * 1.25)
            self.line(words, self.t.bold, size, align="center")
        self.y -= self.t.leading * 2
        for b in sec["blocks"]:
            size = self.t.size * 1.2
            for words in wrap(b["text"], self.t.regular, size, self.g.content_width):
                self.ensure(self.t.leading * 1.2)
                self.line(words, self.t.regular, size, align="center")

    def toc(self, sec: dict, entries: list[dict], include_pages: bool, links: bool):
        self.heading(sec)
        size = self.t.size
        lead = self.t.leading
        for e in entries:
            indent = size * 1.5 * (e.get("level", 1) - 1)
            num = str(e["page"]) if (include_pages and e.get("page") is not None) else ""
            num_w = text_width(num, self.t.regular, size) if num else 0.0
            avail = self.g.content_width - indent - num_w - size * 1.5
            lines = wrap(e["title"], self.t.regular, size, max(avail, size * 4))
            start_page = len(self.pages) - 1
            top = self.y
            for i, words in enumerate(lines):
                self.ensure(lead)
                if len(self.pages) - 1 != start_page:
                    start_page, top = len(self.pages) - 1, self.y + 0.0
                last = i == len(lines) - 1
                self.page.ops.append(("text", self.t.regular, size, self.g.left + indent, self.y - size,
                                      " ".join(words), 0.0))
                if last and num:
                    text_end = self.g.left + indent + text_width(" ".join(words), self.t.regular, size)
                    num_x = self.g.left + self.g.content_width - num_w
                    dot_w = text_width(".", self.t.regular, size)
                    gap = num_x - text_end - size * 0.5
                    dots = int(gap / dot_w) - 1 if dot_w > 0 else 0
                    if dots > 2:
                        dot_text = "." * dots
                        self.page.ops.append(("text", self.t.regular, size, num_x - size * 0.25 -
                                              text_width(dot_text, self.t.regular, size), self.y - size, dot_text, 0.0))
                    self.page.ops.append(("text", self.t.regular, size, num_x, self.y - size, num, 0.0))
                self.y -= lead
            if links:
                self.page.links.append((self.g.left + indent, round(self.y + lead * 0.2, 2),
                                        self.g.left + self.g.content_width, round(top, 2), e["heading_id"]))

    def scene_break(self):
        self.ensure(self.t.leading * 2)
        self.y -= self.t.leading * 0.5
        self.line(["*", "*", "*"], self.t.regular, self.t.size, align="center")
        self.y -= self.t.leading * 0.5

    def footer(self):
        for p in self.pages:
            if p.section_kind == "title_page":
                continue
            num = str(p.number)
            size = self.t.size * 0.9
            w = text_width(num, self.t.regular, size)
            p.ops.append(("text", self.t.regular, size, self.g.left + (self.g.content_width - w) / 2.0,
                          self.footer_y, num, 0.0))


def paginate(book: dict, geom: Geometry, typo: Typography, *, toc_entries: list[dict] | None = None,
             toc_style: dict | None = None, images: dict | None = None) -> Layout:
    """Compose the book. toc_entries (with pages from the previous pass) render the 'toc' section."""
    errs = check_geometry(geom, typo)
    if errs:
        raise LayoutError("; ".join(errs))
    c = _Composer(geom, typo, images or {})
    style = toc_style or {"include_pages": True, "link_targets": True, "max_depth": 2}
    for sec in book["sections"]:
        if sec["kind"] == "toc" and toc_entries is None:
            continue
        c.kind = sec["kind"]
        c.new_page()
        if sec["kind"] == "title_page":
            c.title_page(sec)
            continue
        if sec["kind"] == "toc":
            c.toc(sec, toc_entries, style["include_pages"], style["link_targets"])
            continue
        c.heading(sec)
        for b in sec["blocks"]:
            t = b["t"]
            if t == "p" and b.get("runs"):
                c.paragraph_runs(b["runs"], indent_first=not b.get("first"))
            elif t == "p":
                c.paragraph(b["text"], indent_first=not b.get("first"))
            elif t == "meta":
                c.paragraph(b["text"], align="center", indent_first=False)
            elif t == "h2":
                c.subheading(b)
            elif t == "break":
                c.scene_break()
            elif t == "img":
                c.image(b)
    if not c.pages:
        c.new_page()
    c.footer()
    return Layout(c.pages, c.heading_pages, c.positions, c.outline)
