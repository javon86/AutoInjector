"""Format-neutral book model shared by pagination and the PDF/EPUB/DOCX writers.

A book is a dict:
    {"meta": {title, author, language, identifier, rights},
     "sections": [Section, ...]}
Section: {"id", "kind": title_page|front|toc|chapter|back|plate, "heading", "number", "blocks"}
         (a "plate" is a page of its own holding one placed picture: no heading, not in the contents)
Block:   {"t": "p", "id", "text", "first": bool}   paragraph (first = no indent)
         {"t": "h2", "id", "text"}                  sub-heading inside a chapter
         {"t": "break"}                             scene break
         {"t": "img", "id", "key", "w_mm", "h_mm", "fit"[, "caption", "alt"]}   placed asset (key -> image bytes)
         {"t": "vmap", "id", "svg", "w_mm", "h_mm"[, "caption", "alt"]}   a vector map (d_maps SVG text): drawn
                                                    with vector operations in the PDF, the SVG itself in the EPUB
                                                    (the DOCX says where it is: see docs/PICTURES.md)
         {"t": "meta", "text"}                      centred metadata line (title page etc.)

         A "p" block may also carry "runs": [(text, style)] (style "" | "i" | "b" | "bi") when the
         paragraph has inline emphasis; "text" is always the plain text (the runs joined).

Prose conventions (approved C chapter text is plain Unicode): the first non-blank line
"# Title" names the chapter; "## Text" is a sub-heading; a line consisting only of
"***", "* * *" or "#" is a scene break; every other non-blank line is one paragraph.
Inside a paragraph *italic*, **bold** and _italic_ are emphasis (rendered in every format,
never printed literally); a backslash before * or _ keeps it literal. Characters that are not part
of a real emphasis pair are never dropped: f*ck, 5*3, ****, __init__.py and URLs stay as written.
Stable anchors: chapter heading = section ID; paragraphs <section>-p<n>; sub-headings
<section>-s<n> (1-based, recomputed deterministically from the approved text).

Text hygiene (one choke point for all writers): every string entering the model is NFC
normalised and stripped of characters XML 1.0 cannot carry or that never print (C0/C1
controls except tab/newline, DEL, lone surrogates, U+FFFE/U+FFFF, BOM). Whitespace runs
collapse to one space, but no-break spaces (U+00A0, U+202F, U+2007) and the word joiner
are kept: they must not become line-break opportunities.
"""
from __future__ import annotations

import re
import unicodedata

SCENE_BREAK = re.compile(r"^\s*(\*\s*\*\s*\*|#)\s*$")
PLACEHOLDER = re.compile(r"\{([a-z_]*)\}")
LOGIC_FRONT = ("title_page", "copyright", "toc")
LOGIC_BACK = ("colophon",)
# XML 1.0-illegal or non-printing characters removed from all book text (tab/LF/CR are kept and later
# collapsed as whitespace).
_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff\ufeff\ufffe\uffff]")
# Breaking whitespace: every Unicode space except the no-break ones (they bind words together).
_BREAKING_WS = re.compile("[^\\S\u00a0\u202f\u2007\u2060]+")
# Inline emphasis (``inline_runs``): ***x***, **x**, *x*, _x_; \* / \_ are literal.
_GUARD_ = frozenset("_/")  # _x_ touching these on the outside is part of a name, path or URL, not emphasis
_CHAPTER_PREFIX = re.compile(r"^(chapter|ch\.)\s+(\d+|[ivxlcdm]+)\b\s*[:.\-\u2013\u2014]?\s*", re.IGNORECASE)


def clean_text(text) -> str:
    """NFC-normalise and drop characters that are illegal in XML 1.0 or never print (see module doc)."""
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    return _ILLEGAL.sub("", unicodedata.normalize("NFC", text))


def xml_safe(text: str) -> str:
    """Last-line defence in the XML writers: drop characters XML 1.0 cannot carry."""
    return _ILLEGAL.sub("", text)


def squash(text: str) -> str:
    """Collapse breaking whitespace runs to one space and trim; no-break spaces are kept as they are."""
    return " ".join(w for w in _BREAKING_WS.split(text) if w)


def _is_punct(ch: str) -> bool:
    return unicodedata.category(ch)[0] in "PS"


def _word_dot(text: str, i: int, step: int) -> bool:
    """text[i] is a '.' that sits inside a word or name (file.py, example.com), not a sentence end."""
    j = i + step
    return text[i] == "." and 0 <= j < len(text) and text[j].isalnum()


def _emphasis(text: str) -> tuple[list[tuple[str, str]], set[int]]:
    """Parse emphasis; returns ([(text, style)], indexes of the characters removed from ``text``).

    CommonMark-style delimiter runs, matched with a stack (linear time): a run of * or _ can open emphasis when
    it is left-flanking (it hugs the text after it) and close it when it is right-flanking; _ never opens or
    closes inside a word. Extra rules keep ordinary prose intact: a single *...* pair whose outer neighbours are
    both letters/digits (f*ck … sh*t, 5*3 … 2*4) is not emphasis, a run of only * between spaces is text
    (****, Rating: ***), and _..._ is not emphasis when it touches _, /, a letter/digit or a dot inside a name
    on the outside (__init__.py, example.com/_drafts_/v2). A backslash before * or _ keeps it literal (the
    backslash is dropped). Nothing else is ever removed or changed."""
    n = len(text)
    pieces: list = []  # str | delimiter dict, in text order
    removed: set[int] = set()
    buf: list[str] = []
    i = 0
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n and text[i + 1] in "*_":
            buf.append(text[i + 1])
            removed.add(i)
            i += 2
            continue
        if ch not in "*_":
            buf.append(ch)
            i += 1
            continue
        j = i
        while j < n and text[j] == ch:
            j += 1
        if buf:
            pieces.append("".join(buf))
            buf = []
        before = text[i - 1] if i > 0 else " "
        after = text[j] if j < n else " "
        left = not after.isspace() and (not _is_punct(after) or before.isspace() or _is_punct(before))
        right = not before.isspace() and (not _is_punct(before) or after.isspace() or _is_punct(after))
        if ch == "*":
            can_open, can_close = left, right
            guard_before = before.isalnum()
            guard_after = after.isalnum()
        else:
            can_open = left and (not right or _is_punct(before))
            can_close = right and (not left or _is_punct(after))
            guard_before = before.isalnum() or before in _GUARD_ or (i > 0 and _word_dot(text, i - 1, -1))
            guard_after = after.isalnum() or after in _GUARD_ or (j < n and _word_dot(text, j, 1))
        pieces.append({"ch": ch, "start": i, "len": j - i, "left": j - i, "open": can_open, "close": can_close,
                       "gb": guard_before, "ga": guard_after, "closes": [], "opens": []})
        i = j
    if buf:
        pieces.append("".join(buf))

    stack: list[dict] = []  # delimiter runs that may still open
    bottom: dict[tuple, int] = {}  # closer kind -> stack depth below which no opener can match it (linear time)
    for d in pieces:
        if isinstance(d, str):
            continue
        while d["close"] and d["left"] > 0:
            key = (d["ch"], d["open"], d["len"] % 3, d["left"] >= 2, d["ga"])
            k = len(stack) - 1
            stop = bottom.get(key, 0)
            found = -1
            while k >= stop:
                o = stack[k]
                if o["ch"] == d["ch"] and not (  # CommonMark's "rule of 3" for runs that can both open and close
                        (o["close"] or d["open"]) and (o["len"] + d["len"]) % 3 == 0
                        and not (o["len"] % 3 == 0 and d["len"] % 3 == 0)):
                    use = 2 if o["left"] >= 2 and d["left"] >= 2 else 1
                    if d["ch"] == "_":
                        ok = not (o["gb"] or d["ga"])
                    else:
                        ok = use == 2 or not (o["gb"] and d["ga"])
                    if ok:
                        found = k
                        break
                k -= 1
            if found < 0:
                bottom[key] = len(stack)
                break
            o = stack[found]
            o["left"] -= use
            d["left"] -= use
            style = "b" if use == 2 else "i"
            o["opens"].append(style)  # innermost first
            d["closes"].append(style)
            del stack[found + 1:]  # runs between the pair can no longer open anything
            if o["left"] == 0:
                stack.pop()
            for kk, v in bottom.items():
                if v > len(stack):
                    bottom[kk] = len(stack)
        if d["open"] and d["left"] > 0:
            stack.append(d)

    runs: list[tuple[str, str]] = []
    em = strong = 0

    def emit(t: str):
        st = ("b" if strong else "") + ("i" if em else "")
        if runs and runs[-1][1] == st:
            runs[-1] = (runs[-1][0] + t, st)
        else:
            runs.append((t, st))

    for d in pieces:
        if isinstance(d, str):
            emit(d)
            continue
        used_close = sum(2 if s_ == "b" else 1 for s_ in d["closes"])
        used_open = sum(2 if s_ == "b" else 1 for s_ in d["opens"])
        for s_ in d["closes"]:
            if s_ == "b":
                strong -= 1
            else:
                em -= 1
        literal = d["len"] - used_close - used_open
        if literal:
            emit(d["ch"] * literal)
        removed.update(range(d["start"], d["start"] + used_close))
        removed.update(range(d["start"] + used_close + literal, d["start"] + d["len"]))
        for s_ in reversed(d["opens"]):
            if s_ == "b":
                strong += 1
            else:
                em += 1
    return [(t, st) for t, st in runs if t], removed


def inline_runs(text: str, style: str = "") -> list[tuple[str, str]]:
    """Split simple Markdown-style emphasis into [(text, style)] runs (markers removed; style "" | "i" | "b" | "bi").

    ``style`` is added to every run (text that is already italic or bold as a whole)."""
    runs, _removed = _emphasis(text)
    if not style:
        return runs
    out: list[tuple[str, str]] = []
    for t, st in runs:
        merged = "bi" if "bi" in (st, style) or {st, style} == {"i", "b"} else (st or style)
        if out and out[-1][1] == merged:
            out[-1] = (out[-1][0] + t, merged)
        else:
            out.append((t, merged))
    return out


def plain_text(text: str) -> str:
    """Text with emphasis markers removed (headings, titles, metadata lines)."""
    return "".join(t for t, _ in inline_runs(squash(text)))


def para_block(block_id: str, line: str, first: bool) -> dict:
    runs = inline_runs(squash(line))
    b = {"t": "p", "id": block_id, "text": "".join(t for t, _ in runs), "first": first}
    if any(st for _, st in runs):
        b["runs"] = runs
    return b


def parse_chapter(section_id: str, text: str) -> tuple[str | None, list[dict]]:
    lines = clean_text(text).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    title = None
    blocks: list[dict] = []
    pn = sn = 0
    first = True
    started = False
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if not started:
            started = True
            if line.startswith("# ") and len(line) > 2:
                title = plain_text(line[2:]) or None
                continue
        if SCENE_BREAK.match(line):
            blocks.append({"t": "break"})
            first = True
            continue
        if line.startswith("## ") and len(line) > 3:
            sn += 1
            blocks.append({"t": "h2", "id": f"{section_id}-s{sn}", "text": plain_text(line[3:])})
            first = True
            continue
        pn += 1
        blocks.append(para_block(f"{section_id}-p{pn}", line, first))
        first = False
    return title, blocks


def anchors_of(section_id: str, blocks: list[dict]) -> list[str]:
    return [section_id] + [b["id"] for b in blocks if b["t"] in ("p", "h2")]


def format_heading(number: int, title: str | None, rules: dict | None) -> str:
    """Apply G06 TITLE_RULES ({pattern, include_number}); default is the chapter title."""
    if not rules:
        return title or f"Chapter {number}"
    if title and rules["include_number"] and "{number}" in rules["pattern"]:
        title = _CHAPTER_PREFIX.sub("", title, count=1).strip() or None  # "Chapter 3: X" -> "X" (no doubling)
    text = rules["pattern"]
    text = text.replace("{number}", str(number) if rules["include_number"] else "")
    text = text.replace("{title}", title or "")
    text = " ".join(text.split()).strip(" :-–—.")
    return text or (title or f"Chapter {number}")


def check_title_rules(rules: dict) -> list[str]:
    errs = []
    names = set(PLACEHOLDER.findall(rules["pattern"]))
    if names - {"number", "title"}:
        errs.append(f"unknown placeholders {sorted(names - {'number', 'title'})}; allowed {{number}}, {{title}}")
    if rules["include_number"] and "number" not in names:
        errs.append("include_number=true requires {number} in pattern")
    if not rules["include_number"] and "number" in names:
        errs.append("pattern uses {number} but include_number=false")
    if not names:
        errs.append("pattern must contain {number} or {title}")
    return errs


def text_blocks(item_id: str, text: str, prefix: str) -> list[dict]:
    out = []
    for i, line in enumerate([ln.strip() for ln in clean_text(text).split("\n") if ln.strip()]):
        out.append(para_block(f"{prefix}-{item_id}-p{i + 1}", line, True))
    return out


def clean_meta(meta: dict) -> dict:
    return {k: (clean_text(v) if isinstance(v, str) else v) for k, v in (meta or {}).items()}


def build_book(meta: dict, chapters: list[dict], *, title_rules: dict | None = None,
               front: list[dict] | None = None, back: list[dict] | None = None,
               placements: list[dict] | None = None, toc: bool = False) -> dict:
    """chapters: [{"id", "text"}] in manifest order; front/back: G08/G09 items;
    placements: G03 placements [{placement_id, anchor_id, key, width_mm, height_mm, fit}];
    toc: include a Contents section (at the front item 'toc' or before the first chapter)."""
    sections: list[dict] = []
    has_toc_item = False
    for item in front or []:
        iid = item["item_id"]
        heading = plain_text(clean_text(item["title"]))
        if iid == "title_page":
            blocks = [{"t": "meta", "text": plain_text(line)} for line in clean_text(item["text"]).split("\n")
                      if plain_text(line)]
            sections.append({"id": "front-title_page", "kind": "title_page", "heading": heading,
                             "number": None, "blocks": blocks})
        elif iid == "toc":
            has_toc_item = True
            if toc:
                sections.append({"id": "toc", "kind": "toc", "heading": heading, "number": None, "blocks": []})
        else:
            sections.append({"id": f"front-{iid}", "kind": "front", "heading": heading, "number": None,
                             "blocks": text_blocks(iid, item["text"], "front")})
    if toc and not has_toc_item:
        sections.append({"id": "toc", "kind": "toc", "heading": "Contents", "number": None, "blocks": []})
    for n, ch in enumerate(chapters, start=1):
        title, blocks = parse_chapter(ch["id"], ch["text"])
        sections.append({"id": ch["id"], "kind": "chapter", "heading": format_heading(n, title, title_rules),
                         "number": n, "title": title, "blocks": blocks})
    for item in back or []:
        iid = item["item_id"]
        sections.append({"id": f"back-{iid}", "kind": "back", "heading": plain_text(clean_text(item["title"])),
                         "number": None,
                         "blocks": text_blocks(iid, item["text"], "back")})
    if placements:
        place_assets(sections, placements)
    return {"meta": clean_meta(meta), "sections": sections}


def all_anchors(book: dict) -> set[str]:
    out = set()
    for s in book["sections"]:
        out.add(s["id"])
        out.update(b["id"] for b in s["blocks"] if b["t"] in ("p", "h2", "meta") and "id" in b)
    return out


def place_assets(sections: list[dict], placements: list[dict]) -> None:
    index = {}
    for s in sections:
        index[s["id"]] = (s, -1)
        for i, b in enumerate(s["blocks"]):
            if b.get("id"):
                index[b["id"]] = (s, i)
    # Insert in reverse document order so earlier indices stay valid; stable by placement order.
    resolved = []
    for order, p in enumerate(placements):
        if p["anchor_id"] not in index:
            raise KeyError(p["anchor_id"])
        sec, i = index[p["anchor_id"]]
        resolved.append((sections.index(sec), i, order, sec, p))
    for _, i, _, sec, p in sorted(resolved, key=lambda x: (x[0], x[1], x[2]), reverse=True):
        blk = {"t": "img", "id": p["placement_id"], "key": p["key"], "w_mm": p["width_mm"], "h_mm": p["height_mm"],
               "fit": p["fit"]}
        for k in ("caption", "alt"):  # 🖼 B3 pictures: shown under the picture / read aloud (optional)
            if p.get(k):
                blk[k] = squash(clean_text(p[k]))
        sec["blocks"].insert(i + 1, blk)


def scene_ends(blocks: list[dict]) -> list[int]:
    """Block index where each scene of a chapter ends (the index of its scene break, or len(blocks) for the last)."""
    return [i for i, b in enumerate(blocks) if b["t"] == "break"] + [len(blocks)]


def place_pictures(sections: list[dict], pictures: list[dict]) -> None:
    """🖼 B3: place the author's chosen pictures (pictures.py) into the book sections.

    pictures: [{"block": img/vmap block, "section_id", "where": before|start|after_scene|end, "scene": n}] in the
    order they should appear. ``before`` puts the picture on a page of its own (a "plate" section) in front of the
    chapter; ``start`` right under the chapter heading; ``after_scene`` at the end of scene n (before its scene
    break; the last scene's end when the chapter has fewer scenes); ``end`` at the end of the chapter. An unknown
    section is skipped (the picture's chapter is not in this book)."""
    by_id = {s["id"]: s for s in sections}
    plates: dict[str, list] = {}
    for p in pictures:
        sec = by_id.get(p.get("section_id"))
        if sec is None:
            continue
        blk = dict(p["block"])
        where = p.get("where") or "start"
        if where == "before":
            plates.setdefault(sec["id"], []).append({"id": f"plate-{blk['id']}", "kind": "plate", "heading": "",
                                                     "number": None, "blocks": [blk]})
        elif where == "start":
            starts = [i for i, b in enumerate(sec["blocks"]) if b.get("_pic_start")]
            blk["_pic_start"] = True
            sec["blocks"].insert(len(starts), blk)
        elif where == "after_scene":
            ends = scene_ends(sec["blocks"])
            n = max(1, int(p.get("scene") or 1))
            sec["blocks"].insert(ends[min(n, len(ends)) - 1], blk)
        else:
            sec["blocks"].append(blk)
    for s in sections:
        for b in s["blocks"]:
            b.pop("_pic_start", None)
    if plates:
        out = []
        for s in sections:
            out.extend(plates.get(s["id"], []))
            out.append(s)
        sections[:] = out


def heading_entries(book: dict, max_depth: int = 2) -> list[dict]:
    """TOC candidates in reading order: (heading_id, title, level)."""
    out = []
    for s in book["sections"]:
        if s["kind"] in ("title_page", "toc", "plate") or s["id"] == "front-copyright":
            continue
        out.append({"heading_id": s["id"], "title": s["heading"], "level": 1})
        if max_depth >= 2:
            for b in s["blocks"]:
                if b["t"] == "h2":
                    out.append({"heading_id": b["id"], "title": b["text"], "level": 2})
    return out


def all_text(book: dict) -> str:
    parts = [book["meta"].get("title", ""), book["meta"].get("author", "")]
    for s in book["sections"]:
        parts.append(s["heading"])
        for b in s["blocks"]:
            if "text" in b:
                parts.append(b["text"])
    return "\n".join(parts)
