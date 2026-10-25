"""Hand-written PDF 1.7 writer and structural inspector (stdlib only).

Writer: classic cross-reference table, page tree, base-14 Type1 fonts with
WinAnsiEncoding (not embedded: the 14 standard fonts are guaranteed by every conforming
reader, so no font program is written), image XObjects (JPEG/PNG via images.py),
document outline (bookmarks) for every heading, /Link annotations from TOC entries to
heading destinations, /Lang, Info (no timestamps) and a content-derived trailer /ID.
Streams are uncompressed so output bytes never depend on the zlib build: identical
inputs always produce identical files.

Inspector: `inspect_pdf(data)` parses header, every xref offset, trailer, the page tree,
media/trim/bleed boxes, font resources, link destinations and outline destinations and
returns a report with `errors` (empty when the file is structurally valid).
"""
from __future__ import annotations

import hashlib
import re

from .fontmetrics import DESCRIPTORS, WIDTHS
from .images import ImageInfo
from .layout import Layout, Typography

BASE14 = {"Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Helvetica", "Helvetica-Bold",
          "Helvetica-Oblique", "Helvetica-BoldOblique", "Courier", "Courier-Bold", "Courier-Oblique",
          "Courier-BoldOblique", "Symbol", "ZapfDingbats"}


def num(v: float) -> str:
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def pdf_string(text: str) -> bytes:
    """Literal string in WinAnsi bytes with every non-printable byte octal-escaped."""
    out = bytearray(b"(")
    for b in text.encode("cp1252"):
        if b in (0x28, 0x29, 0x5C):
            out += b"\\" + bytes([b])
        elif 32 <= b < 127:
            out.append(b)
        else:
            out += b"\\%03o" % b
    out += b")"
    return bytes(out)


def pdf_text_string(text: str) -> bytes:
    """Text string (outline titles, Info): ASCII literal or UTF-16BE hex with BOM."""
    if all(32 <= ord(c) < 127 for c in text):
        return b"(" + text.encode("ascii").replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)") + b")"
    return b"<FEFF" + text.encode("utf-16-be").hex().upper().encode("ascii") + b">"


def pdf_name(name: str) -> str:
    """PDF name object; anything but ASCII letters/digits/-_. is written as #XX UTF-8 bytes (PDF 1.7 7.3.5)."""
    out = []
    for ch in name:
        if (ch.isascii() and ch.isalnum()) or ch in "-_.":
            out.append(ch)
        else:
            out.extend(f"#{b:02X}" for b in ch.encode("utf-8"))
    return "/" + "".join(out)


class PdfWriter:
    def __init__(self):
        self.objects: list[bytes | None] = []

    def reserve(self) -> int:
        self.objects.append(None)
        return len(self.objects)

    def set(self, num_: int, body: bytes):
        self.objects[num_ - 1] = body

    def add(self, body: bytes) -> int:
        self.objects.append(body)
        return len(self.objects)

    @staticmethod
    def stream(entries: str, data: bytes) -> bytes:
        return (f"<< {entries} /Length {len(data)} >>\nstream\n").encode("latin-1") + data + b"\nendstream"

    def build(self, root: int, info: int) -> bytes:
        out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for i, body in enumerate(self.objects, start=1):
            if body is None:
                raise ValueError(f"object {i} reserved but never written")
            offsets.append(len(out))
            out += f"{i} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
        doc_id = hashlib.sha256(bytes(out)).hexdigest()[:32].upper()
        xref = len(out)
        out += f"xref\n0 {len(self.objects) + 1}\n".encode("ascii")
        out += b"0000000000 65535 f \n"
        for off in offsets:
            out += f"{off:010d} 00000 n \n".encode("ascii")
        out += (f"trailer\n<< /Size {len(self.objects) + 1} /Root {root} 0 R /Info {info} 0 R "
                f"/ID [<{doc_id}> <{doc_id}>] >>\nstartxref\n{xref}\n%%EOF\n").encode("ascii")
        return bytes(out)


def image_matrix(orientation: int, x: float, y: float, dw: float, dh: float) -> tuple:
    """cm matrix that maps the image unit square onto the display box (x, y, dw, dh), applying the EXIF
    orientation of the stored pixels (1 = as stored; 2-8 mirror/rotate as cameras record them)."""
    return {
        1: (dw, 0, 0, dh, x, y),
        2: (-dw, 0, 0, dh, x + dw, y),
        3: (-dw, 0, 0, -dh, x + dw, y + dh),
        4: (dw, 0, 0, -dh, x, y + dh),
        5: (0, -dh, -dw, 0, x + dw, y + dh),
        6: (0, -dh, dw, 0, x, y + dh),
        7: (0, dh, dw, 0, x, y),
        8: (0, dh, -dw, 0, x + dw, y),
    }.get(orientation, (dw, 0, 0, dh, x, y))


def _xobject(w: PdfWriter, img: ImageInfo) -> int:
    entries = " ".join(f"/{k} {v}" for k, v in img.pdf_dict.items())
    if img.smask:
        sm_dict, sm_data = img.smask
        sm = w.add(PdfWriter.stream(" ".join(f"/{k} {v}" for k, v in sm_dict.items()), sm_data))
        entries += f" /SMask {sm} 0 R"
    return w.add(PdfWriter.stream(entries, img.pdf_data))


def render_pdf(layout: Layout, *, page_width: float, page_height: float, bleed: float = 0.0,
               meta: dict, images: dict | None = None, extra_info: dict | None = None) -> bytes:
    """Write the composed pages. page_width/height = trim size (pt); bleed extends the MediaBox
    on every side and adds TrimBox/BleedBox (print interior)."""
    images = images or {}
    w = PdfWriter()
    catalog = w.reserve()
    pages_obj = w.reserve()
    info_obj = w.reserve()
    fonts_used = sorted({op[1] for p in layout.pages for op in p.ops if op[0] == "text"})
    font_objs = {}
    for i, f in enumerate(fonts_used, start=1):
        # Base-14 font, NOT embedded (no FontFile): full AFM /Widths and a descriptor are written so
        # checkers can compute exact text extents (PDF 1.5+ recommends them for standard fonts too).
        d = DESCRIPTORS[f]
        desc = w.add((f"<< /Type /FontDescriptor /FontName /{f} /Flags {d['flags']} /FontBBox "
                      f"[{' '.join(str(v) for v in d['bbox'])}] /ItalicAngle {num(d['italic'])} /Ascent {d['ascent']} "
                      f"/Descent {d['descent']} /CapHeight {d['cap']} /StemV {d['stemv']} >>").encode("ascii"))
        widths = " ".join(str(x) for x in WIDTHS[f])
        font_objs[f] = (f"F{i}", w.add((f"<< /Type /Font /Subtype /Type1 /BaseFont /{f} /Encoding /WinAnsiEncoding "
                                        f"/FirstChar 32 /LastChar 255 /Widths [{widths}] /FontDescriptor {desc} 0 R >>")
                                       .encode("ascii")))
    img_keys = sorted({op[1] for p in layout.pages for op in p.ops if op[0] == "img"})
    img_objs = {}
    for i, k in enumerate(img_keys, start=1):
        if k not in images:
            raise ValueError(f"image {k} missing")
        img_objs[k] = (f"Im{i}", _xobject(w, images[k]))
    page_nums = [w.reserve() for _ in layout.pages]
    mw, mh = page_width + 2 * bleed, page_height + 2 * bleed
    for idx, page in enumerate(layout.pages):
        content = bytearray()
        if bleed:
            content += f"1 0 0 1 {num(bleed)} {num(bleed)} cm\n".encode("ascii")
        for op in page.ops:
            if op[0] == "text":
                _, font, size, x, y, text, tw = op
                content += (f"BT /{font_objs[font][0]} {num(size)} Tf {num(tw)} Tw {num(x)} {num(y)} Td ").encode("ascii")
                content += pdf_string(text) + b" Tj ET\n"
            elif op[0] == "img":
                _, key, x, y, dw, dh, clip = op
                content += b"q\n"
                if clip:
                    cx, cy, cw, ch = clip
                    content += f"{num(cx)} {num(cy)} {num(cw)} {num(ch)} re W n\n".encode("ascii")
                m = image_matrix(images[key].orientation, x, y, dw, dh)
                content += (" ".join(num(v) for v in m) + f" cm /{img_objs[key][0]} Do\nQ\n").encode("ascii")
        content_obj = w.add(PdfWriter.stream("", bytes(content)))
        used_fonts = sorted({op[1] for op in page.ops if op[0] == "text"})
        used_imgs = sorted({op[1] for op in page.ops if op[0] == "img"})
        res = "<< /ProcSet [/PDF /Text /ImageB /ImageC /ImageI]"
        if used_fonts:
            res += " /Font << " + " ".join(f"/{font_objs[f][0]} {font_objs[f][1]} 0 R" for f in used_fonts) + " >>"
        if used_imgs:
            res += " /XObject << " + " ".join(f"/{img_objs[k][0]} {img_objs[k][1]} 0 R" for k in used_imgs) + " >>"
        res += " >>"
        annots = []
        for (x0, y0, x1, y1, hid) in page.links:
            if hid not in layout.positions:
                continue
            annots.append(w.add((f"<< /Type /Annot /Subtype /Link /Rect [{num(x0 + bleed)} {num(y0 + bleed)} "
                                 f"{num(x1 + bleed)} {num(y1 + bleed)}] /Border [0 0 0] /Dest {pdf_name(hid)} >>")
                                .encode("ascii")))
        boxes = f"/MediaBox [0 0 {num(mw)} {num(mh)}]"
        if bleed:
            boxes += (f" /BleedBox [0 0 {num(mw)} {num(mh)}] /TrimBox [{num(bleed)} {num(bleed)} "
                      f"{num(bleed + page_width)} {num(bleed + page_height)}]")
        body = f"<< /Type /Page /Parent {pages_obj} 0 R {boxes} /Resources {res} /Contents {content_obj} 0 R"
        if annots:
            body += " /Annots [" + " ".join(f"{a} 0 R" for a in annots) + "]"
        body += " >>"
        w.set(page_nums[idx], body.encode("ascii"))
    kids = " ".join(f"{p} 0 R" for p in page_nums)
    w.set(pages_obj, f"<< /Type /Pages /Kids [{kids}] /Count {len(page_nums)} >>".encode("ascii"))
    outline_root = _outline(w, layout, page_nums, bleed)
    dests = None
    if layout.positions:
        dests = w.add(("<< " + " ".join(
            f"{pdf_name(hid)} [{page_nums[tp]} 0 R /XYZ 0 {num(ty + bleed)} 0]"
            for hid, (tp, ty) in sorted(layout.positions.items())) + " >>").encode("ascii"))
    cat = f"<< /Type /Catalog /Pages {pages_obj} 0 R"
    if dests:
        cat += f" /Dests {dests} 0 R"
    if outline_root:
        cat += f" /Outlines {outline_root} 0 R /PageMode /UseOutlines"
    cat_b = cat.encode("ascii")
    if meta.get("language"):
        cat_b += b" /Lang " + pdf_text_string(meta["language"])
    w.set(catalog, cat_b + b" >>")
    info = b"<< /Producer (Akowe PDF writer 1)"
    for key, field in (("Title", "title"), ("Author", "author"), ("Subject", "identifier")):
        if meta.get(field):
            info += f" /{key} ".encode("ascii") + pdf_text_string(meta[field])
    for k, v in sorted((extra_info or {}).items()):
        info += f" /{k} ".encode("ascii") + pdf_text_string(v)
    w.set(info_obj, info + b" >>")
    return w.build(catalog, info_obj)


def _outline(w: PdfWriter, layout: Layout, page_nums: list[int], bleed: float) -> int | None:
    items = [(t, h, lvl) for (t, h, lvl) in layout.outline if h in layout.positions]
    if not items:
        return None
    root = w.reserve()
    # Build a two-level tree: level-1 items under root, level-2 under the preceding level-1.
    tree: list[dict] = []
    for title, hid, lvl in items:
        node = {"title": title, "hid": hid, "children": [], "num": w.reserve()}
        if lvl >= 2 and tree:
            tree[-1]["children"].append(node)
        else:
            tree.append(node)

    def write(nodes, parent):
        for i, n in enumerate(nodes):
            body = b"<< /Title " + pdf_text_string(n["title"]) + f" /Parent {parent} 0 R".encode("ascii")
            if i > 0:
                body += f" /Prev {nodes[i - 1]['num']} 0 R".encode("ascii")
            if i < len(nodes) - 1:
                body += f" /Next {nodes[i + 1]['num']} 0 R".encode("ascii")
            if n["children"]:
                body += (f" /First {n['children'][0]['num']} 0 R /Last {n['children'][-1]['num']} 0 R "
                         f"/Count -{len(n['children'])}").encode("ascii")
                write(n["children"], n["num"])
            body += f" /Dest {pdf_name(n['hid'])} >>".encode("ascii")
            w.set(n["num"], body)

    write(tree, root)
    total = len(items)
    w.set(root, f"<< /Type /Outlines /First {tree[0]['num']} 0 R /Last {tree[-1]['num']} 0 R /Count {total} >>"
          .encode("ascii"))
    return root


def render_cover_pdf(*, width: float, height: float, bleed: float, image: ImageInfo, image_box: tuple,
                     meta: dict, spine: tuple | None = None) -> bytes:
    """Single-page cover: the image fills image_box=(x, y, w, h) in trim coordinates (COVER fit,
    clipped to the box). spine=(x, w) only records the spine geometry in TrimBox-relative Info."""
    from .layout import Layout, Page
    x, y, bw, bh = image_box
    s = max(bw / image.width, bh / image.height)
    dw, dh = image.width * s, image.height * s
    page = Page(number=1, section_kind="cover")
    page.ops.append(("img", "cover", x + (bw - dw) / 2.0, y + (bh - dh) / 2.0, dw, dh, (x, y, bw, bh)))
    layout = Layout([page], [], {}, [])
    extra = {}
    if spine is not None:
        extra["AkoweSpine"] = f"x={num(spine[0])}pt width={num(spine[1])}pt"
    return render_pdf(layout, page_width=width, page_height=height, bleed=bleed, meta=meta,
                      images={"cover": image}, extra_info=extra)


# =========================================================================== inspector
_WS = b" \t\r\n\x0c\x00"
_DELIM = b"()<>[]{}/%"


class _Ref(tuple):
    pass


class _Parser:
    def __init__(self, data: bytes, pos: int = 0):
        self.d = data
        self.p = pos

    def ws(self):
        d = self.d
        while self.p < len(d):
            c = d[self.p]
            if c in _WS:
                self.p += 1
            elif c == 0x25:  # comment
                while self.p < len(d) and d[self.p] not in b"\r\n":
                    self.p += 1
            else:
                break

    def token(self) -> bytes:
        self.ws()
        start = self.p
        while self.p < len(self.d) and self.d[self.p] not in _WS and self.d[self.p] not in _DELIM:
            self.p += 1
        return self.d[start:self.p]

    def value(self):
        self.ws()
        d = self.d
        c = d[self.p:self.p + 1]
        if d.startswith(b"<<", self.p):
            self.p += 2
            out = {}
            while True:
                self.ws()
                if d.startswith(b">>", self.p):
                    self.p += 2
                    return out
                key = self.value()
                if not isinstance(key, str) or not key.startswith("/"):
                    raise ValueError(f"dictionary key expected at {self.p}")
                out[key[1:]] = self.value()
        if c == b"[":
            self.p += 1
            out = []
            while True:
                self.ws()
                if d[self.p:self.p + 1] == b"]":
                    self.p += 1
                    return out
                out.append(self.value())
        if c == b"/":
            self.p += 1
            return "/" + self.token().decode("latin-1")
        if c == b"(":
            return self.literal()
        if c == b"<":
            end = d.index(b">", self.p)
            raw = re.sub(rb"\s", b"", d[self.p + 1:end])
            self.p = end + 1
            return bytes.fromhex(raw.decode("ascii") + ("0" if len(raw) % 2 else ""))
        tok = self.token()
        if not tok:
            raise ValueError(f"unexpected byte {c!r} at {self.p}")
        if tok in (b"true", b"false"):
            return tok == b"true"
        if tok == b"null":
            return None
        if re.fullmatch(rb"[+-]?\d+", tok):
            save = self.p
            g = self.token()
            if re.fullmatch(rb"\d+", g or b""):
                r = self.token()
                if r == b"R":
                    return _Ref((int(tok), int(g)))
            self.p = save
            return int(tok)
        if re.fullmatch(rb"[+-]?(\d+\.\d*|\.\d+|\d+)", tok):
            return float(tok)
        return tok.decode("latin-1")  # operator/keyword

    def literal(self) -> bytes:
        d = self.d
        self.p += 1
        depth, out = 1, bytearray()
        while self.p < len(d):
            c = d[self.p]
            if c == 0x5C:
                nxt = d[self.p + 1]
                if 0x30 <= nxt <= 0x37:
                    m = re.match(rb"[0-7]{1,3}", d[self.p + 1:self.p + 4])
                    out.append(int(m.group(0), 8) & 0xFF)
                    self.p += 1 + len(m.group(0))
                    continue
                out += {0x6E: b"\n", 0x72: b"\r", 0x74: b"\t", 0x62: b"\b", 0x66: b"\f"}.get(nxt, bytes([nxt]))
                self.p += 2
                continue
            if c == 0x28:
                depth += 1
            elif c == 0x29:
                depth -= 1
                if depth == 0:
                    self.p += 1
                    return bytes(out)
            out.append(c)
            self.p += 1
        raise ValueError("unterminated string")


def parse_pdf_objects(data: bytes) -> tuple[dict, dict, list[str]]:
    """Return (objects{num: (dict_or_value, stream_bytes|None)}, trailer, errors)."""
    errors: list[str] = []
    objs: dict = {}
    if not data.startswith(b"%PDF-1."):
        return objs, {}, ["missing %PDF-1.x header"]
    if not data.rstrip().endswith(b"%%EOF"):
        errors.append("missing %%EOF marker")
    m = re.search(rb"startxref\s+(\d+)\s+%%EOF\s*$", data)
    if not m:
        return objs, {}, errors + ["missing startxref"]
    xref = int(m.group(1))
    if not data.startswith(b"xref", xref):
        return objs, {}, errors + [f"startxref {xref} does not point at an xref table"]
    p = _Parser(data, xref + 4)
    first, count = int(p.token()), int(p.token())
    p.ws()
    entries = []
    for i in range(count):
        line = data[p.p:p.p + 20]
        if len(line) != 20 or not re.fullmatch(rb"\d{10} \d{5} [nf](\r\n| \n| \r)", line):
            return objs, {}, errors + [f"malformed xref entry {first + i}"]
        entries.append((first + i, int(line[:10]), line[17:18]))
        p.p += 20
    tok = p.token()
    if tok != b"trailer":
        return objs, {}, errors + ["missing trailer"]
    trailer = p.value()
    for n, off, kind in entries:
        if kind != b"n":
            continue
        head = re.match(rb"(\d+) (\d+) obj\b", data[off:off + 32])
        if not head or int(head.group(1)) != n:
            errors.append(f"xref offset {off} for object {n} does not start that object")
            continue
        q = _Parser(data, off + head.end())
        try:
            val = q.value()
            q.ws()
            stream = None
            if data.startswith(b"stream", q.p):
                q.p += 6
                if data[q.p:q.p + 2] == b"\r\n":
                    q.p += 2
                elif data[q.p:q.p + 1] == b"\n":
                    q.p += 1
                length = val.get("Length") if isinstance(val, dict) else None
                if not isinstance(length, int):
                    errors.append(f"object {n}: stream without direct /Length")
                    continue
                stream = data[q.p:q.p + length]
                q.p += length
                q.ws()
                if not data.startswith(b"endstream", q.p):
                    errors.append(f"object {n}: /Length does not end at endstream")
                    continue
                q.p += 9
                q.ws()
            if not data.startswith(b"endobj", q.p):
                errors.append(f"object {n}: missing endobj")
            objs[n] = (val, stream)
        except (ValueError, IndexError) as exc:
            errors.append(f"object {n}: {exc}")
    size = trailer.get("Size") if isinstance(trailer, dict) else None
    if size != len(entries) + first:
        errors.append("trailer /Size does not match the xref table")
    return objs, trailer, errors


def inspect_pdf(data: bytes) -> dict:
    objs, trailer, errors = parse_pdf_objects(data)
    report = {"page_count": 0, "media_boxes": [], "trim_boxes": [], "fonts": [], "embedded_fonts": [],
              "links": 0, "outline_items": 0, "lang": None, "info": {}, "errors": errors, "text_bytes": 0}
    if not objs:
        return report

    def get(ref):
        if isinstance(ref, _Ref):
            if ref[0] not in objs:
                raise KeyError(f"dangling reference {ref[0]} 0 R")
            return objs[ref[0]][0]
        return ref

    try:
        root = get(trailer.get("Root"))
        if not isinstance(root, dict) or root.get("Type") != "/Catalog":
            errors.append("trailer /Root is not a /Catalog")
            return report
        info = get(trailer.get("Info")) if trailer.get("Info") is not None else {}
        report["info"] = {k: (v.decode("latin-1") if isinstance(v, bytes) else v) for k, v in (info or {}).items()}
        if isinstance(root.get("Lang"), bytes):
            report["lang"] = root["Lang"].decode("latin-1")
        page_refs: list[int] = []
        seen = set()

        def walk(ref, inherited_box):
            node = get(ref)
            if ref[0] in seen:
                raise ValueError("cycle in page tree")
            seen.add(ref[0])
            box = node.get("MediaBox", inherited_box)
            if node.get("Type") == "/Pages":
                kids = node.get("Kids") or []
                if node.get("Count") is None:
                    errors.append(f"/Pages {ref[0]} lacks /Count")
                for k in kids:
                    walk(k, box)
            elif node.get("Type") == "/Page":
                page_refs.append(ref[0])
                if not (isinstance(box, list) and len(box) == 4 and box[2] > box[0] and box[3] > box[1]):
                    errors.append(f"page {ref[0]} has no positive MediaBox")
                report["media_boxes"].append(box)
                report["trim_boxes"].append(node.get("TrimBox"))
                res = get(node.get("Resources")) or {}
                for name, fref in sorted((get(res.get("Font")) or {}).items()):
                    font = get(fref)
                    base = (font.get("BaseFont") or "/")[1:]
                    desc = get(font.get("FontDescriptor")) if font.get("FontDescriptor") else None
                    if desc and any(k in desc for k in ("FontFile", "FontFile2", "FontFile3")):
                        report["embedded_fonts"].append(base)
                    elif base not in BASE14:
                        errors.append(f"font {base} is neither base-14 nor embedded")
                    if base not in report["fonts"]:
                        report["fonts"].append(base)
                for xname, xref in sorted((get(res.get("XObject")) or {}).items()):
                    if not isinstance(get(xref), dict):
                        errors.append(f"XObject {xname} unresolved")
                contents = node.get("Contents")
                if not isinstance(contents, _Ref) or objs[contents[0]][1] is None:
                    errors.append(f"page {ref[0]} has no content stream")
                else:
                    report["text_bytes"] += len(objs[contents[0]][1])
            else:
                errors.append(f"page tree node {ref[0]} has unexpected /Type {node.get('Type')}")

        pages_ref = root.get("Pages")
        pages = get(pages_ref)
        walk(pages_ref, None)
        report["page_count"] = len(page_refs)
        if pages.get("Count") != len(page_refs):
            errors.append(f"/Count {pages.get('Count')} != {len(page_refs)} pages")
        page_set = set(page_refs)
        named = get(root.get("Dests")) if root.get("Dests") is not None else {}
        report["named_destinations"] = sorted(_unname(k) for k in (named or {}))

        def check_dest(dest, what):
            if isinstance(dest, str) and dest.startswith("/"):
                dest = get((named or {}).get(dest[1:]))
            if not (isinstance(dest, list) and dest and isinstance(dest[0], _Ref) and dest[0][0] in page_set):
                errors.append(f"{what} destination does not resolve to a page")

        for k, v in (named or {}).items():
            check_dest(get(v), f"named destination {_unname(k)}")

        for pnum in page_refs:
            for aref in get(objs[pnum][0].get("Annots")) or []:
                a = get(aref)
                if a.get("Subtype") == "/Link":
                    report["links"] += 1
                    check_dest(a.get("Dest"), "link")
        outlines = get(root.get("Outlines")) if root.get("Outlines") is not None else None
        if outlines:
            stack = [outlines.get("First")]
            visited = set()
            while stack:
                ref = stack.pop()
                while ref is not None:
                    if ref[0] in visited:
                        raise ValueError("cycle in outline")
                    visited.add(ref[0])
                    item = get(ref)
                    report["outline_items"] += 1
                    check_dest(item.get("Dest"), "outline")
                    if item.get("First") is not None:
                        stack.append(item.get("First"))
                    ref = item.get("Next")
    except (KeyError, ValueError, TypeError, AttributeError) as exc:
        errors.append(f"structure: {exc}")
    return report


def _unname(raw: str) -> str:
    return re.sub(r"#([0-9A-Fa-f]{2})", lambda m: chr(int(m.group(1), 16)), raw)


def font_names(typo: Typography) -> list[str]:
    return [typo.regular, typo.bold]
