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

Prose conventions (approved C chapter text is plain Unicode): the first non-blank line
"# Title" names the chapter; "## Text" is a sub-heading; a line consisting only of
"***", "* * *" or "#" is a scene break; every other non-blank line is one paragraph.
Stable anchors: chapter heading = section ID; paragraphs <section>-p<n>; sub-headings
<section>-s<n> (1-based, recomputed deterministically from the approved text).
"""
from __future__ import annotations

import re

SCENE_BREAK = re.compile(r"^\s*(\*\s*\*\s*\*|#)\s*$")
PLACEHOLDER = re.compile(r"\{([a-z_]*)\}")
LOGIC_FRONT = ("title_page", "copyright", "toc")
LOGIC_BACK = ("colophon",)


def parse_chapter(section_id: str, text: str) -> tuple[str | None, list[dict]]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
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
                title = line[2:].strip()
                continue
        if SCENE_BREAK.match(line):
            blocks.append({"t": "break"})
            first = True
            continue
        if line.startswith("## ") and len(line) > 3:
            sn += 1
            blocks.append({"t": "h2", "id": f"{section_id}-s{sn}", "text": " ".join(line[3:].split())})
            first = True
            continue
        pn += 1
        blocks.append({"t": "p", "id": f"{section_id}-p{pn}", "text": " ".join(line.split()), "first": first})
        first = False
    return title, blocks


def anchors_of(section_id: str, blocks: list[dict]) -> list[str]:
    return [section_id] + [b["id"] for b in blocks if b["t"] in ("p", "h2")]


def format_heading(number: int, title: str | None, rules: dict | None) -> str:
    """Apply G06 TITLE_RULES ({pattern, include_number}); default is the chapter title."""
    if not rules:
        return title or f"Chapter {number}"
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
    for i, line in enumerate([ln.strip() for ln in text.split("\n") if ln.strip()]):
        out.append({"t": "p", "id": f"{prefix}-{item_id}-p{i + 1}", "text": " ".join(line.split()), "first": True})
    return out


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
        if iid == "title_page":
            blocks = [{"t": "meta", "text": " ".join(line.split())} for line in item["text"].split("\n") if line.strip()]
            sections.append({"id": "front-title_page", "kind": "title_page", "heading": item["title"],
                             "number": None, "blocks": blocks})
        elif iid == "toc":
            has_toc_item = True
            if toc:
                sections.append({"id": "toc", "kind": "toc", "heading": item["title"], "number": None, "blocks": []})
        else:
            sections.append({"id": f"front-{iid}", "kind": "front", "heading": item["title"], "number": None,
                             "blocks": text_blocks(iid, item["text"], "front")})
    if toc and not has_toc_item:
        sections.append({"id": "toc", "kind": "toc", "heading": "Contents", "number": None, "blocks": []})
    for n, ch in enumerate(chapters, start=1):
        title, blocks = parse_chapter(ch["id"], ch["text"])
        sections.append({"id": ch["id"], "kind": "chapter", "heading": format_heading(n, title, title_rules),
                         "number": n, "title": title, "blocks": blocks})
    for item in back or []:
        iid = item["item_id"]
        sections.append({"id": f"back-{iid}", "kind": "back", "heading": item["title"], "number": None,
                         "blocks": text_blocks(iid, item["text"], "back")})
    if placements:
        place_assets(sections, placements)
    return {"meta": dict(meta), "sections": sections}


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
