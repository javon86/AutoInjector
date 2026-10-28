"""🗂 The Character Forge dossier as a PDF, in the look of the author's Moki Vey sample (pure Python).

Page 1: the cover (gold name, teal tagline, the portrait, three summary lines; with a motion clip the portrait — or
an item / place / magic system's cover picture — moves left and the clip's poster stands beside it as a small framed
"MOTION STUDY" still). Page 2 (landscape): "NAME / TEN-VIEW
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


def _motion_study(page, im, clip: dict, x: float, y_bottom: float, w: float):
    """🎬 A small framed still of the motion clip (its poster), bottom-aligned with the portrait: a gold hairline
    frame on a card, the label "MOTION STUDY" above it, a one-line caption below."""
    pad = 5.0
    inner_w = w - 2 * pad
    dw, dh = _fit(im.width, im.height, inner_w, 260.0)
    cap_y = y_bottom + 2.0
    frame_y = cap_y + 14.0
    frame_h = dh + 2 * pad
    page.ops.append(("rect", x, frame_y, w, frame_h, CARD, GOLD, 0.8))
    page.ops.append(("img", "clip_poster", x + pad + (inner_w - dw) / 2.0, frame_y + pad, dw, dh, None))
    label_y = frame_y + frame_h + 8.0
    text_op(page, "MOTION STUDY", BOLD, 9.0, x, label_y, TEAL)
    page.ops.append(("line", x, label_y - 3.5, x + tw("MOTION STUDY", BOLD, 9.0), label_y - 3.5, GOLD, 0.6))
    secs = clip.get("seconds")
    secs = int(secs) if isinstance(secs, (int, float)) and not isinstance(secs, bool) and secs > 0 else None
    cap = f"{secs}-second loop, first frame" if secs else "Clip, first frame"
    while tw(cap, REG, 6.8) > w and len(cap) > 4:
        cap = cap[:-2]
    text_op(page, cap, REG, 6.8, x, cap_y, MUTED)


# ====================================================================== the document
KIND_WORDS = {"character": "character", "item": "item", "place": "place", "magic": "magic system"}


def _ref_line(x: dict) -> str:
    return f"{x.get('code') or ''} {x.get('name') or ''}".strip()


def render(d: dict, pictures: dict, spec: dict | None = None) -> bytes:
    """d = forge.public(...) (the dossier JSON); pictures = {slot: bytes|None} (portrait, sheet, the ten views, and
    ``clip_poster``: the motion clip's first frame, drawn as a framed MOTION STUDY still on the cover).

    ``spec`` (an item, place or magic system: ``forge_kinds.pdf_spec``) changes the words ("ITEM FORGE"), the cover
    picture (``spec["hero"]``: item portrait / establishing shot / sigil, each in a box of its own shape) and the
    landscape plate (``spec["plate"]``: turnaround / mood views / in use). Fields with ``links`` show them as teal
    references, and the dossier's ``links`` / ``backlinks`` close the document as "Linked records"."""
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
    kind = (spec or {}).get("kind") or "character"
    forge_word = (spec or {}).get("forge") or "CHARACTER FORGE"
    name = safe(d.get("name") or ("Character" if not spec else spec.get("word", "Record").capitalize()))
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
    sub = f"{tag.upper()}  /  {forge_word}" if tag else forge_word
    ssize = 10.5
    while ssize > 7 and tw(sub, REG, ssize) > pw - 2 * MARGIN:
        ssize -= 0.5
    text_op(p, sub, REG, ssize, MARGIN, ph - 69.0, TEAL)
    bx, by, bw, bh = 126.0, 168.0, 360.0, 542.0
    hero, hero_label = "portrait", "PORTRAIT"
    if spec:
        hero, hero_label = spec["hero"], spec["hero_label"]
        if kind == "place":   # a wide establishing shot
            bx, by, bw, bh = MARGIN, 300.0, pw - 2 * MARGIN, 400.0
        elif kind == "magic":  # a square sigil
            bx, by, bw, bh = 141.0, 260.0, 330.0, 330.0
    if "clip_poster" in info:
        bx = MARGIN  # the picture moves left to make room for the motion-study still (else: unchanged)
        if kind == "place":  # the wide establishing shot gets narrower
            bw = pw - 2 * MARGIN - 16.0 - 150.0
    _image_or_slot(p, images, hero, info, bx, by, bw, bh, cover=False, label=hero_label,
                   note="No picture yet: make one in Akowe or upload your own")
    if spec and kind in ("place", "magic"):
        refs = [_ref_line(x) for x in (d.get("links") or [])][:6]
        if refs:  # the records it names, under the picture (the cover has room for one line)
            line = "LINKED: " + "  /  ".join(refs)
            while tw(line, REG, 8.5) > pw - 2 * MARGIN and len(line) > 10:
                line = line[:-2]
            text_op(p, line, REG, 8.5, MARGIN, by - 22.0, TEAL)
    if "clip_poster" in info:
        _motion_study(p, info["clip_poster"], (d.get("art") or {}).get("clip") or {}, bx + bw + 16.0, by,
                      pw - MARGIN - (bx + bw + 16.0))
    lines = [x for x in d.get("summary") or [] if x][:3]
    if not lines:
        c = d.get("counts") or {}
        word = KIND_WORDS.get(kind, "character").capitalize()
        lines = [f"{word} dossier for {name}.", f"{c.get('filled', 0)} of {c.get('fields', 0)} fields filled; "
                 f"{c.get('proposed', 0)} proposal(s) waiting for approval.",
                 "Profile, ten-view reference plate and story arc." if not spec else
                 f"Profile, {spec['plate_title'].lower()} and continuity ledger."]
    y = 142.0
    for ln in lines:
        for wl in wrap_runs([(ln, REG, TEXT)], pw - 2 * MARGIN, 10.0)[:2]:
            if y < FOOT_TOP:
                break  # never into the footer's legend
            draw_line(p, wl, MARGIN, y, 10.0)
            y -= 18.0
    pages.append(p)

    # -------- page 2: the ten-view reference plate (landscape)
    lw, lh = LANDSCAPE
    p = _new_page(LANDSCAPE, 2)
    title = f"{name.upper()} / " + ((spec or {}).get("plate_title") or "TEN-VIEW REFERENCE")
    t2 = 20.0
    while t2 > 12 and tw(title, BOLD, t2) > lw - 2 * MARGIN:
        t2 -= 1
    text_op(p, title, BOLD, t2, MARGIN, lh - 42.0, GOLD)
    gx, gw = MARGIN, lw - 2 * MARGIN
    top, bottom = lh - 70.0, 86.0
    if spec:  # items: front / side / back / detail; places: day / night / interior; magic: one "in use" scene
        plate = list(spec.get("plate") or [])
        n = max(1, len(plate))
        cw = gw / n
        ch = top - bottom - 22.0
        for i, (key, label) in enumerate(plate):
            x = gx + i * cw
            _image_or_slot(p, images, key, info, x + 0.5, bottom + 18.0, cw - 1.0, ch, cover=n > 1,
                           note="No picture yet" if key not in info else None)
            centered(p, label, BOLD, 8.0, x + cw / 2.0, bottom + 5.0, TEAL)
    elif "sheet" in info:
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
    details = (spec or {}).get("details") or "CHARACTER DETAILS"
    header = f"{forge_word} / {name.upper()} / " + (f"PROPOSED {details}" if status == "DRAFT" else details)
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

    def place_blocks(heading, blocks):
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

    new_section_page()
    for s in d.get("sections") or []:
        fields = [f for f in s.get("fields") or [] if (f.get("text") or "").strip()]
        heading = f"{int(s.get('n') or 0):02d} / {s.get('title') or ''}"
        blocks = []
        for f in fields:
            tag = "[" + ",".join(f.get("letters") or []) + "]"
            runs = [(tag, REG, TEAL), (" " + (f.get("label") or "") + ":", BOLD, TEXT), (" " + f["text"], REG, TEXT)]
            if f.get("links"):  # cross-references to the other dossiers it names
                runs.append(("\n-> " + "; ".join(_ref_line(x) for x in f["links"]), REG, TEAL))
            blocks.append(wrap_runs(runs, CARD_W - 2 * PAD_X))
        if not blocks:
            blocks = [wrap_runs([("Not filled in yet.", REG, MUTED)], CARD_W - 2 * PAD_X)]
        place_blocks(heading, blocks)
    # -------- the linked records (what this dossier names, and who names it)
    this_word = KIND_WORDS.get(kind, "record")
    refs = []
    for x in d.get("links") or []:
        refs.append(wrap_runs([("[R]", REG, TEAL), (f" {_ref_line(x)}", BOLD, TEXT),
                               (f" ({KIND_WORDS.get(x.get('kind'), x.get('kind') or '')}): named in "
                                + ", ".join(x.get("fields") or []), REG, TEXT)], CARD_W - 2 * PAD_X))
    for x in d.get("backlinks") or []:
        refs.append(wrap_runs([("[R]", REG, TEAL), (f" {_ref_line(x)}", BOLD, TEXT),
                               (f" ({KIND_WORDS.get(x.get('kind'), x.get('kind') or '')}) names this {this_word} "
                                "in: " + ", ".join(x.get("fields") or []), REG, TEXT)], CARD_W - 2 * PAD_X))
    if refs:
        place_blocks("Linked records", refs)
    for i, pg in enumerate(pages, start=1):
        pg.number = i
        w = (pg.size or PORTRAIT)[0]
        _footer(pg, w, code_tpl.format(n=i))
    layout = Layout(pages, [], {}, [])
    title_word = "Character Forge" if not spec else forge_word.title()
    meta = {"title": f"{name} - {title_word} dossier", "language": "en"}
    return render_pdf(layout, page_width=PORTRAIT[0], page_height=PORTRAIT[1], meta=meta, images=images,
                      extra_info={"Keywords": f"{d.get('code') or ''} {title_word}"})
