"""🗂 The Character Forge dossier as a PDF, in the look of the author's Moki Vey sample (pure Python).

Page 1: the cover (gold name, teal tagline, the portrait, three summary lines). Page 2 (landscape): "NAME / TEN-VIEW
REFERENCE" — the turnaround sheet when there is one, else a 5 × 2 grid of the ten views with their labels. Then the 14
numbered sections, every field a dark bordered card: teal letter tags, a bold label, the text. Every page has the dark
background, the letter legend and "CH-001 | REV 1 | DRAFT | n" in the footer; the section pages also the header
"CHARACTER FORGE / NAME / PROPOSED CHARACTER DETAILS". Missing art gets tidy empty placeholders; text wraps with the
exact base-14 font widths and a card that does not fit is split cleanly onto the next page (never overflows).

Built on exporters.layout (Page, text_width) and exporters.pdf.render_pdf (per-page size, rectangles, coloured text).
"""
from __future__ import annotations

import logging
import unicodedata

from .exporters.images import UnsupportedImage, load_image
from .exporters.layout import Layout, Page, text_width
from .exporters.pdf import render_pdf

log = logging.getLogger("akowe.forge_pdf")

PORTRAIT = (612.0, 792.0)    # US Letter, like the sample
LANDSCAPE = (842.0, 595.0)   # the ten-view plate (A4 landscape, like the sample)
BG = (27, 31, 35)
CARD = (35, 41, 47)
BORDER = (82, 92, 102)
GOLD = (212, 185, 122)
TEAL = (95, 199, 192)
TEXT = (236, 238, 240)
MUTED = (140, 150, 160)
SLOT = (44, 51, 58)
REG, BOLD = "Helvetica", "Helvetica-Bold"
MARGIN = 34.0
CARD_X, CARD_W = 44.0, 524.0
PAD_X, PAD_Y = 10.0, 9.0
SIZE, LEAD = 9.5, 13.6
FOOT_TOP = 82.0               # nothing of the body below this line
LEGEND = (("C Canon   |   P Personality   |   V Voice", "S Story development   |   E Essential on-page detail"),
          ("A Appearance   |   F Fighting   |   M Magic", ""),
          ("K Knowledge/skills   |   R Relationships", ""))
VIEW_LABELS = (("front", "FRONT"), ("three_quarter_front", "3/4 FRONT"), ("side", "SIDE"),
               ("three_quarter_back", "3/4 BACK"), ("back", "BACK"), ("idle", "IDLE"), ("draw", "DRAW / TOOL REACH"),
               ("attack", "ATTACK / EMPTY HAND"), ("dash", "DASH"), ("defend", "DEFEND"))


def safe(text) -> str:
    """Text the base-14 fonts can print (WinAnsi): other letters lose their accents, the rest becomes '?'."""
    out = []
    for ch in unicodedata.normalize("NFC", str(text or "")):
        if unicodedata.combining(ch):
            continue  # a lone accent the fonts cannot place
        if ch == "\n":
            out.append(ch)
            continue
        if ord(ch) < 32:
            out.append(" ")
            continue
        try:
            b = ch.encode("cp1252")
            if b and b[0] >= 32:
                out.append(ch)
                continue
        except UnicodeEncodeError:
            pass
        base = "".join(c for c in unicodedata.normalize("NFKD", ch) if not unicodedata.combining(c))
        try:
            base.encode("cp1252")
            out.append(base or "?")
        except UnicodeEncodeError:
            out.append({"‑": "-", "−": "-", " ": " ", " ": " "}.get(ch, "?"))
    return "".join(out)


def tw(text, font, size) -> float:
    return text_width(safe(text), font, size)


# ====================================================================== wrapping of mixed runs
def wrap_runs(runs: list, width: float, size: float = SIZE) -> list[list]:
    """runs: [(text, font, colour)] -> lines of [(word, font, colour)]; '\\n' in a text starts a new line.
    A word wider than the line is broken by characters (never overflows)."""
    space = tw(" ", REG, size)
    lines: list[list] = [[]]
    cur_w = 0.0
    for text, font, color in runs:
        paras = safe(text).split("\n")
        for pi, para in enumerate(paras):
            if pi > 0:
                lines.append([])
                cur_w = 0.0
            for word in [w for w in para.split(" ") if w]:
                ww = tw(word, font, size)
                if ww > width:
                    piece = ""
                    for ch in word:
                        if tw(piece + ch, font, size) > width - (cur_w + space if lines[-1] else 0) and piece:
                            if lines[-1]:
                                lines.append([])
                            lines[-1].append((piece, font, color))
                            lines.append([])
                            cur_w = 0.0
                            piece = ch
                        else:
                            piece += ch
                    word, ww = piece, tw(piece, font, size)
                add = ww if not lines[-1] else cur_w + space + ww
                if lines[-1] and add > width:
                    lines.append([(word, font, color)])
                    cur_w = ww
                else:
                    lines[-1].append((word, font, color))
                    cur_w = add
    return [ln for ln in lines if ln] or [[]]


def draw_line(page: Page, tokens: list, x: float, y: float, size: float = SIZE):
    """One wrapped line: consecutive words of the same font/colour become one text op."""
    space = tw(" ", REG, size)
    i = 0
    while i < len(tokens):
        word, font, color = tokens[i]
        group = [word]
        j = i + 1
        while j < len(tokens) and tokens[j][1] == font and tokens[j][2] == color:
            group.append(tokens[j][0])
            j += 1
        s = " ".join(group)
        page.ops.append(("text", font, size, x, y, s, 0, color))
        x += tw(s, font, size) + space
        i = j


def text_op(page, s, font, size, x, y, color):
    page.ops.append(("text", font, size, x, y, safe(s), 0, color))


def centered(page, s, font, size, cx, y, color):
    text_op(page, s, font, size, cx - tw(s, font, size) / 2.0, y, color)


# ====================================================================== page furniture
def _footer(page: Page, w: float, code_line: str):
    page.ops.append(("line", MARGIN, 66.0, w - MARGIN, 66.0, (72, 80, 88), 0.8))
    col = (w - 2 * MARGIN) / 3.0
    for i, (r1, r2) in enumerate(LEGEND):
        if r1:
            text_op(page, r1, REG, 6.8, MARGIN + i * col, 53.0, TEAL)
        if r2:
            text_op(page, r2, REG, 6.8, MARGIN + i * col, 40.0, TEAL)
    text_op(page, code_line, REG, 6.8, w - MARGIN - tw(code_line, REG, 6.8), 22.0, TEXT)


def _new_page(w_h, number) -> Page:
    p = Page(number=number, section_kind="forge")
    if w_h != PORTRAIT:
        p.size = w_h
    p.background = BG
    return p


def _fit(img_w, img_h, box_w, box_h, cover=False):
    s = (max if cover else min)(box_w / img_w, box_h / img_h)
    return img_w * s, img_h * s


def _image_or_slot(page, images, key, info, x, y, w, h, *, cover, label=None, note=None):
    """The picture in the box (contain or cover-and-clip), else a quiet empty slot."""
    im = info.get(key)
    if im is not None:
        dw, dh = _fit(im.width, im.height, w, h, cover)
        page.ops.append(("img", key, x + (w - dw) / 2.0, y + (h - dh) / 2.0 if not cover else y + h - dh, dw, dh,
                         (x, y, w, h) if cover else None))
        return True
    page.ops.append(("rect", x, y, w, h, SLOT, BORDER, 0.6))
    if label:
        centered(page, label, BOLD, 9.0, x + w / 2.0, y + h / 2.0 + 4, (120, 132, 142))
    if note:
        centered(page, note, REG, 7.0, x + w / 2.0, y + h / 2.0 - 9, MUTED)
    return False


# ====================================================================== the document
def render(d: dict, pictures: dict) -> bytes:
    """d = forge.public(...) (the dossier JSON); pictures = {slot: bytes|None} (portrait, sheet, the ten views)."""
    images, info = {}, {}
    for key, data in (pictures or {}).items():
        if not data:
            continue
        try:
            im = load_image(data)
        except (UnsupportedImage, ValueError) as exc:
            log.warning("dossier picture %s cannot go into the PDF: %s", key, exc)
            continue
        images[key] = info[key] = im
    name = safe(d.get("name") or "Character")
    status = "READY" if d.get("readiness") == "ready" else "DRAFT"
    code_tpl = f"{d.get('code') or 'CH-000'} | REV {d.get('revision') or 1} | {status} | " + "{n}"
    pages: list[Page] = []

    # -------- page 1: the cover
    pw, ph = PORTRAIT
    p = _new_page(PORTRAIT, 1)
    tsize = 30.0
    while tsize > 14 and tw(name.upper(), BOLD, tsize) > pw - 2 * MARGIN:
        tsize -= 1
    text_op(p, name.upper(), BOLD, tsize, MARGIN, ph - 52.0, GOLD)
    tag = (d.get("tagline") or "").strip()
    sub = f"{tag.upper()}  /  CHARACTER FORGE" if tag else "CHARACTER FORGE"
    ssize = 10.5
    while ssize > 7 and tw(sub, REG, ssize) > pw - 2 * MARGIN:
        ssize -= 0.5
    text_op(p, sub, REG, ssize, MARGIN, ph - 69.0, TEAL)
    bx, by, bw, bh = 126.0, 168.0, 360.0, 542.0
    _image_or_slot(p, images, "portrait", info, bx, by, bw, bh, cover=False, label="PORTRAIT",
                   note="No picture yet: make one in Akowe or upload your own")
    lines = [x for x in d.get("summary") or [] if x][:3]
    if not lines:
        c = d.get("counts") or {}
        lines = [f"Character dossier for {name}.", f"{c.get('filled', 0)} of {c.get('fields', 0)} fields filled; "
                 f"{c.get('proposed', 0)} proposal(s) waiting for approval.", "Profile, ten-view reference plate and "
                 "story arc."]
    y = 142.0
    for ln in lines:
        for wl in wrap_runs([(ln, REG, TEXT)], pw - 2 * MARGIN, 10.0)[:2]:
            draw_line(p, wl, MARGIN, y, 10.0)
            y -= 18.0
    pages.append(p)

    # -------- page 2: the ten-view reference plate (landscape)
    lw, lh = LANDSCAPE
    p = _new_page(LANDSCAPE, 2)
    title = f"{name.upper()} / TEN-VIEW REFERENCE"
    t2 = 20.0
    while t2 > 12 and tw(title, BOLD, t2) > lw - 2 * MARGIN:
        t2 -= 1
    text_op(p, title, BOLD, t2, MARGIN, lh - 42.0, GOLD)
    gx, gw = MARGIN, lw - 2 * MARGIN
    top, bottom = lh - 70.0, 86.0
    if "sheet" in info:
        _image_or_slot(p, images, "sheet", info, gx, bottom, gw, top - bottom, cover=False)
    else:
        cw = gw / 5.0
        ch = 206.0
        rows = (top - ch, top - ch - 18.0 - ch - 4.0)
        for i, (key, label) in enumerate(VIEW_LABELS):
            r, c = divmod(i, 5)
            x = gx + c * cw
            y0 = rows[r]
            _image_or_slot(p, images, key, info, x + 0.5, y0, cw - 1.0, ch, cover=True, label=None,
                           note="No picture yet" if key not in info else None)
            centered(p, label, BOLD, 7.5, x + cw / 2.0, y0 - 11.0, TEAL)
    pages.append(p)

    # -------- the sections
    header = f"CHARACTER FORGE / {name.upper()} / " + \
        ("PROPOSED CHARACTER DETAILS" if status == "DRAFT" else "CHARACTER DETAILS")
    state = {"page": None, "y": 0.0}

    def new_section_page():
        pg = _new_page(PORTRAIT, len(pages) + 1)
        text_op(pg, header, REG, 7.5, CARD_X, ph - 26.0, TEAL)
        pages.append(pg)
        state["page"], state["y"] = pg, ph - 48.0

    def room() -> float:
        return state["y"] - FOOT_TOP

    def card_height(n: int) -> float:
        return 2 * PAD_Y + n * LEAD - (LEAD - SIZE) + 2.0

    def card(lines_, continued=False):
        pg = state["page"]
        hgt = card_height(len(lines_))
        y_top = state["y"]
        pg.ops.append(("rect", CARD_X, y_top - hgt, CARD_W, hgt, CARD, BORDER, 0.7))
        yb = y_top - PAD_Y - SIZE + 1.0
        for ln in lines_:
            draw_line(pg, ln, CARD_X + PAD_X, yb)
            yb -= LEAD
        state["y"] = y_top - hgt - 12.0

    new_section_page()
    for s in d.get("sections") or []:
        fields = [f for f in s.get("fields") or [] if (f.get("text") or "").strip()]
        heading = f"{int(s.get('n') or 0):02d} / {s.get('title') or ''}"
        blocks = []
        for f in fields:
            tag = "[" + ",".join(f.get("letters") or []) + "]"
            runs = [(tag, REG, TEAL), (" " + (f.get("label") or "") + ":", BOLD, TEXT), (" " + f["text"], REG, TEXT)]
            blocks.append(wrap_runs(runs, CARD_W - 2 * PAD_X))
        if not blocks:
            blocks = [wrap_runs([("Not filled in yet.", REG, MUTED)], CARD_W - 2 * PAD_X)]
        head_need = 34.0 + 19.0 + 14.0 + card_height(min(2, len(blocks[0])))
        if state["y"] < ph - 60 and room() < head_need:
            new_section_page()
        if state["y"] < ph - 60:
            state["y"] -= 26.0
        else:
            state["y"] -= 8.0
        text_op(state["page"], heading, BOLD, 19.0, CARD_X + 8.0, state["y"] - 19.0, GOLD)
        state["y"] -= 19.0 + 20.0
        for lines_ in blocks:
            rest = lines_
            while rest:
                fits = int((room() - card_height(0)) // LEAD)
                if fits >= len(rest):
                    card(rest)
                    rest = []
                elif fits >= 2 and len(rest) - fits >= 1 and len(rest) > 3:
                    card(rest[:fits])
                    rest = rest[fits:]
                    new_section_page()
                else:
                    new_section_page()
                    if int((room() - card_height(0)) // LEAD) < 1:
                        rest = rest[1:]  # cannot happen with this geometry; never loop
    for i, pg in enumerate(pages, start=1):
        pg.number = i
        w = (pg.size or PORTRAIT)[0]
        _footer(pg, w, code_tpl.format(n=i))
    layout = Layout(pages, [], {}, [])
    meta = {"title": f"{name} - Character Forge dossier", "language": "en"}
    return render_pdf(layout, page_width=PORTRAIT[0], page_height=PORTRAIT[1], meta=meta, images=images,
                      extra_info={"Keywords": f"{d.get('code') or ''} Character Forge"})
