"""Format-neutral book model shared by pagination and the PDF/EPUB/DOCX writers.

A book is a dict:
    {"meta": {title, author, language, identifier, rights},
     "sections": [Section, ...]}
Section: {"id", "kind": title_page|front|toc|chapter|back, "heading", "number", "blocks"}
Block:   {"t": "p", "id", "text", "first": bool}   paragraph (first = no indent)
         {"t": "h2", "id", "text"}                  sub-heading inside a chapter
         {"t": "break"}                             scene break
         {"t": "img", "id", "key", "w_mm", "h_mm", "fit"}   placed asset (key -> image bytes)
         {"t": "meta", "text"}                      centred metadata line (title page etc.)

         A "p" block may also carry "runs": [(text, style)] (style "" | "i" | "b" | "bi") when the
         paragraph has inline emphasis; "text" is always the plain text (the runs joined).

Prose conventions (approved C chapter text is plain Unicode): the first non-blank line
"# Title" names the chapter; "## Text" is a sub-heading; a line consisting only of
"***", "* * *" or "#" is a scene break; every other non-blank line is one paragraph.
Inside a paragraph *italic*, **bold** and _italic_ are emphasis (rendered in every format,
never printed literally); a backslash before * or _ keeps it literal.
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
# Inline emphasis: ***x***, **x**, *x*, _x_ (delimiters hug non-space text; \* / \_ are literal).
_EMPH = re.compile(r"(?<!\\)(\*\*\*|\*\*|\*|_)(?=\S)(.+?)(?<=\S)(?<!\\)\1(?!\*)")
_ESCAPED = re.compile(r"\\([*_])")
_STYLE = {"***": "bi", "**": "b", "*": "i", "_": "i"}
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


def inline_runs(text: str, style: str = "") -> list[tuple[str, str]]:
    """Split simple Markdown-style emphasis into [(text, style)] runs (markers removed)."""
    runs: list[tuple[str, str]] = []
    pos = 0
    while True:
        m = _EMPH.search(text, pos)
        while m is not None and m.group(1) == "_" and (
                (m.start() > 0 and text[m.start() - 1].isalnum()) or
                (m.end() < len(text) and text[m.end()].isalnum())):
            m = _EMPH.search(text, m.start() + 1)  # snake_case words are not emphasis
        if m is None:
            break
        if m.start() > pos:
            runs.append((text[pos:m.start()], style))
        inner = _STYLE[m.group(1)]
        merged = "bi" if {inner, style} == {"i", "b"} or "bi" in (inner, style) else (inner or style)
        runs.extend(inline_runs(m.group(2), merged))
        pos = m.end()
    if pos < len(text):
        runs.append((text[pos:], style))
    out: list[tuple[str, str]] = []
    for t, st in runs:
        t = _ESCAPED.sub(r"\1", t) if not style else t
        if not t:
            continue
        if out and out[-1][1] == st:
            out[-1] = (out[-1][0] + t, st)
        else:
            out.append((t, st))
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
        sec["blocks"].insert(i + 1, {"t": "img", "id": p["placement_id"], "key": p["key"], "w_mm": p["width_mm"],
                                     "h_mm": p["height_mm"], "fit": p["fit"]})


def heading_entries(book: dict, max_depth: int = 2) -> list[dict]:
    """TOC candidates in reading order: (heading_id, title, level)."""
    out = []
    for s in book["sections"]:
        if s["kind"] in ("title_page", "toc") or s["id"] == "front-copyright":
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
