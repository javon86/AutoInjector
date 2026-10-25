"""Deterministic file, layout and navigation checkers used by Set H (H07/H08/H09).

Pure standard library. Nothing here trusts a producer's own claims: every result is
derived from the exact bytes handed in. Each checker returns plain "issue" dicts

    {"rule": str, "severity": INFO|MINOR|MAJOR|BLOCKING, "decision": PASS|FAIL|UNKNOWN,
     "message": str}

which set_h turns into contract Findings. EPUBCheck (the official EPUB validator, Java) runs when
it is installed - see epubcheck_command() for where it is looked for. When it is not installed the
EPUB is still fully checked here and the report says plainly "not checked by EPUBCheck" as a MINOR
UNKNOWN VALIDATOR_UNAVAILABLE finding: never a PASS, but it does not block a release forever.

Covered formats
  PDF   header/EOF/startxref, classic xref tables and xref streams (with PNG predictors),
        object streams, trailer Root -> Catalog -> page tree, MediaBox/TrimBox/BleedBox,
        Flate/ASCIIHex/ASCII85 filters, content-stream interpretation for text/image
        bounding boxes (exact when the font dictionary carries /Widths or is Courier),
        named destinations, link annotations, outlines and font embedding.
  EPUB  ZIP integrity (CRC), mimetype first/stored/no extra field/exact bytes,
        META-INF/container.xml, OPF metadata/manifest/spine, nav document, XHTML
        well-formedness, relative resource resolution and id/fragment targets.
  DOCX  ZIP integrity, [Content_Types].xml coverage, package and document relationships,
        word/document.xml well-formedness, sectPr page size/margins, bookmarks and
        internal hyperlink anchors.
"""
from __future__ import annotations

import base64
import io
import os
import posixpath
import re
import shutil
import subprocess
import tempfile
import zipfile
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET

from . import legacy

CHECKER_VERSION = "akowe-h-checks/1.0.0"

MAX_DECODED_BYTES = 64 * 1024 * 1024
MAX_ZIP_TOTAL = 512 * 1024 * 1024
MAX_ZIP_ENTRIES = 20000
MM_PER_PT = 25.4 / 72.0
PT_TOL = 0.75  # geometry tolerance in pt (~0.26 mm)

MIME_BY_PRODUCER = {
    "G11": "application/pdf",
    "G12": "application/epub+zip",
    "G13": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
FORMAT_BY_PRODUCER = {"G11": "PDF", "G12": "EPUB", "G13": "DOCX"}


def issue(rule: str, message: str, severity: str = "BLOCKING", decision: str = "FAIL") -> dict:
    return {"rule": rule, "severity": severity, "decision": decision, "message": message}


def ok(rule: str, message: str) -> dict:
    return {"rule": rule, "severity": "INFO", "decision": "PASS", "message": message}


def mm_to_pt(mm: float) -> float:
    return float(mm) / MM_PER_PT


# ====================================================================== PDF syntax
class Name(str):
    """A PDF name object (without the leading slash)."""


class PdfString(bytes):
    """A PDF string object (literal or hex)."""


@dataclass(frozen=True)
class Ref:
    num: int
    gen: int


class Keyword(str):
    """A bare PDF keyword/operator token."""


@dataclass
class Stream:
    dict: dict
    raw: bytes


class PdfError(Exception):
    pass


WS = b"\x00\t\n\x0c\r "
DELIM = b"()<>[]{}/%"
_NUM = re.compile(rb"[+-]?(?:\d+\.?\d*|\.\d+)")


class Lexer:
    def __init__(self, data: bytes, pos: int = 0):
        self.data = data
        self.pos = pos
        self.n = len(data)

    def skip_ws(self):
        d, n = self.data, self.n
        while self.pos < n:
            c = d[self.pos]
            if c in WS:
                self.pos += 1
            elif c == 0x25:  # % comment
                while self.pos < n and d[self.pos] not in b"\r\n":
                    self.pos += 1
            else:
                break

    def token(self):
        """Return the next raw token or None at end of data."""
        self.skip_ws()
        d = self.data
        if self.pos >= self.n:
            return None
        c = d[self.pos:self.pos + 1]
        if c == b"(":
            return self._literal()
        if c == b"<":
            if d[self.pos:self.pos + 2] == b"<<":
                self.pos += 2
                return Keyword("<<")
            return self._hex()
        if c == b">":
            if d[self.pos:self.pos + 2] == b">>":
                self.pos += 2
                return Keyword(">>")
            raise PdfError(f"unexpected '>' at {self.pos}")
        if c in (b"[", b"]", b"{", b"}"):
            self.pos += 1
            return Keyword(c.decode())
        if c == b"/":
            self.pos += 1
            start = self.pos
            while self.pos < self.n and d[self.pos] not in WS and d[self.pos] not in DELIM:
                self.pos += 1
            raw = d[start:self.pos]
            name = re.sub(rb"#([0-9A-Fa-f]{2})", lambda m: bytes([int(m.group(1), 16)]), raw)
            return Name(name.decode("latin-1"))
        start = self.pos
        while self.pos < self.n and d[self.pos] not in WS and d[self.pos] not in DELIM:
            self.pos += 1
        if self.pos == start:
            self.pos += 1
            raise PdfError(f"unexpected byte {c!r} at {start}")
        word = d[start:self.pos]
        if _NUM.fullmatch(word):
            return float(word) if b"." in word else int(word)
        return Keyword(word.decode("latin-1"))

    def _literal(self) -> PdfString:
        d = self.data
        self.pos += 1
        depth, out = 1, bytearray()
        esc = {ord("n"): b"\n", ord("r"): b"\r", ord("t"): b"\t", ord("b"): b"\b", ord("f"): b"\f",
               ord("("): b"(", ord(")"): b")", ord("\\"): b"\\"}
        while self.pos < self.n:
            c = d[self.pos]
            if c == 0x5C:  # backslash
                self.pos += 1
                if self.pos >= self.n:
                    break
                e = d[self.pos]
                if e in esc:
                    out += esc[e]
                    self.pos += 1
                elif 0x30 <= e <= 0x37:
                    j = self.pos
                    while j < self.n and j < self.pos + 3 and 0x30 <= d[j] <= 0x37:
                        j += 1
                    out.append(int(d[self.pos:j], 8) & 0xFF)
                    self.pos = j
                elif e in b"\r\n":
                    self.pos += 1
                    if e == 0x0D and self.pos < self.n and d[self.pos] == 0x0A:
                        self.pos += 1
                else:
                    out.append(e)
                    self.pos += 1
                continue
            if c == 0x28:
                depth += 1
            elif c == 0x29:
                depth -= 1
                if depth == 0:
                    self.pos += 1
                    return PdfString(bytes(out))
            out.append(c)
            self.pos += 1
        raise PdfError("unterminated literal string")

    def _hex(self) -> PdfString:
        end = self.data.find(b">", self.pos)
        if end < 0:
            raise PdfError("unterminated hex string")
        body = re.sub(rb"\s", b"", self.data[self.pos + 1:end])
        self.pos = end + 1
        if not re.fullmatch(rb"[0-9A-Fa-f]*", body):
            raise PdfError("invalid hex string")
        if len(body) % 2:
            body += b"0"
        return PdfString(bytes.fromhex(body.decode()))


def parse_value(lex: Lexer, tok=None, depth: int = 0):
    """Parse one PDF object starting with token tok (or the next token)."""
    if depth > 200:
        raise PdfError("object nesting too deep")
    if tok is None:
        tok = lex.token()
    if tok is None:
        raise PdfError("unexpected end of data")
    if isinstance(tok, Keyword):
        if tok == "<<":
            out = {}
            while True:
                k = lex.token()
                if k == ">>":
                    return out
                if not isinstance(k, Name):
                    raise PdfError(f"dictionary key must be a name near {lex.pos}")
                out[str(k)] = parse_value(lex, None, depth + 1)
        if tok == "[":
            arr = []
            while True:
                t = lex.token()
                if t == "]":
                    return arr
                if t is None:
                    raise PdfError("unterminated array")
                arr.append(parse_value(lex, t, depth + 1))
        if tok == "true":
            return True
        if tok == "false":
            return False
        if tok == "null":
            return None
        return tok
    if isinstance(tok, int) and not isinstance(tok, bool):
        save = lex.pos
        t2 = lex.token()
        if isinstance(t2, int) and not isinstance(t2, bool):
            save2 = lex.pos
            t3 = lex.token()
            if t3 == "R":
                return Ref(tok, t2)
            lex.pos = save2
        lex.pos = save
        return tok
    return tok


# ---------------------------------------------------------------------- filters
def _png_unpredict(data: bytes, columns: int, colors: int = 1, bpc: int = 8) -> bytes:
    bpp = max(1, colors * bpc // 8)
    row_len = (columns * colors * bpc + 7) // 8
    out, prev = bytearray(), bytearray(row_len)
    i = 0
    while i < len(data):
        ftype = data[i]
        row = bytearray(data[i + 1:i + 1 + row_len])
        i += 1 + row_len
        if len(row) < row_len:
            row += bytes(row_len - len(row))
        for x in range(row_len):
            a = row[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if ftype == 1:
                row[x] = (row[x] + a) & 0xFF
            elif ftype == 2:
                row[x] = (row[x] + b) & 0xFF
            elif ftype == 3:
                row[x] = (row[x] + ((a + b) >> 1)) & 0xFF
            elif ftype == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                row[x] = (row[x] + pred) & 0xFF
            elif ftype != 0:
                raise PdfError(f"unknown PNG predictor {ftype}")
        out += row
        prev = row
    return bytes(out)


def decode_stream(stream: Stream, resolve=lambda x: x) -> bytes:
    d = stream.dict
    filters = resolve(d.get("Filter"))
    parms = resolve(d.get("DecodeParms"))
    if filters is None:
        return stream.raw
    if not isinstance(filters, list):
        filters, parms = [filters], [parms]
    if not isinstance(parms, list):
        parms = [parms] * len(filters)
    data = stream.raw
    for f, p in zip(filters, parms + [None] * (len(filters) - len(parms))):
        f = str(resolve(f))
        p = resolve(p) or {}
        if f in ("FlateDecode", "Fl"):
            dobj = zlib.decompressobj()
            try:
                data = dobj.decompress(data, MAX_DECODED_BYTES)
            except zlib.error as exc:
                raise PdfError(f"FlateDecode failed: {exc}") from exc
            if dobj.unconsumed_tail:
                raise PdfError("decoded stream exceeds size limit")
            pred = int(resolve(p.get("Predictor", 1)) or 1)
            if pred >= 10:
                data = _png_unpredict(data, int(resolve(p.get("Columns", 1))), int(resolve(p.get("Colors", 1))),
                                      int(resolve(p.get("BitsPerComponent", 8))))
            elif pred == 2:
                raise PdfError("TIFF predictor not supported")
        elif f in ("ASCIIHexDecode", "AHx"):
            body = re.sub(rb"\s", b"", data).split(b">")[0]
            if len(body) % 2:
                body += b"0"
            try:
                data = bytes.fromhex(body.decode())
            except ValueError as exc:
                raise PdfError("ASCIIHexDecode failed") from exc
        elif f in ("ASCII85Decode", "A85"):
            body = re.sub(rb"\s", b"", data)
            if body.startswith(b"<~"):
                body = body[2:]
            body = body.split(b"~>")[0]
            try:
                data = base64.a85decode(body)
            except ValueError as exc:
                raise PdfError("ASCII85Decode failed") from exc
        else:
            raise PdfError(f"unsupported filter {f}")
    return data


# ---------------------------------------------------------------------- document
_OBJ_RE = re.compile(rb"(?<![0-9])(\d+)\s+(\d+)\s+obj\b")


class PdfDocument:
    """Parsed PDF: objects (last definition wins), trailer and structural issues."""

    def __init__(self, data: bytes):
        self.data = data
        self.objects: dict[Ref, object] = {}
        self.trailer: dict = {}
        self.issues: list[dict] = []
        self.xref_offsets: dict[Ref, int] = {}
        self._parse()

    # -- resolution
    def resolve(self, value, depth: int = 0):
        seen = 0
        while isinstance(value, Ref):
            value = self.objects.get(value)
            seen += 1
            if seen > 32:
                return None
        return value

    def get(self, d, key, default=None):
        if isinstance(d, Stream):
            d = d.dict
        if not isinstance(d, dict):
            return default
        v = self.resolve(d.get(key, default))
        return default if v is None else v

    # -- parsing
    def _parse(self):
        d = self.data
        if not d.startswith(b"%PDF-"):
            head = d[:1024].find(b"%PDF-")
            if head < 0:
                raise PdfError("missing %PDF- header")
            self.issues.append(issue("PDF_HEADER_OFFSET", f"%PDF- header at byte {head}, not 0", "MINOR"))
        if not re.match(rb"%PDF-\d\.\d", d[d.find(b"%PDF-"):d.find(b"%PDF-") + 8]):
            raise PdfError("malformed %PDF- version header")
        tail = d[-2048:]
        if b"%%EOF" not in tail:
            raise PdfError("missing %%EOF marker at end of file")
        # 1. scan every indirect object (robust against broken xref); later definitions win
        for m in _OBJ_RE.finditer(d):
            ref = Ref(int(m.group(1)), int(m.group(2)))
            try:
                obj, end = self._parse_indirect(m.end())
            except PdfError as exc:
                self.issues.append(issue("PDF_OBJECT_SYNTAX", f"object {ref.num} {ref.gen}: {exc}"))
                continue
            self.objects[ref] = obj
            self.xref_offsets.setdefault(ref, m.start())
        # resolve indirect /Length streams that were parsed with a provisional length
        # 2. object streams
        for ref, obj in list(self.objects.items()):
            if isinstance(obj, Stream) and self.get(obj, "Type") == "ObjStm":
                try:
                    self._load_objstm(obj)
                except PdfError as exc:
                    self.issues.append(issue("PDF_OBJSTM", f"object stream {ref.num}: {exc}"))
        # 3. cross-reference verification and trailer
        self._check_xref()

    def _parse_indirect(self, pos: int):
        lex = Lexer(self.data, pos)
        obj = parse_value(lex)
        save = lex.pos
        t = lex.token()
        if t == "stream" and isinstance(obj, dict):
            p = lex.pos
            if self.data[p:p + 2] == b"\r\n":
                p += 2
            elif self.data[p:p + 1] in (b"\n", b"\r"):
                p += 1
            length = obj.get("Length")
            raw = None
            if isinstance(length, int) and 0 <= length <= len(self.data) - p:
                if re.match(rb"\s*endstream", self.data[p + length:p + length + 32]):
                    raw = self.data[p:p + length]
            if raw is None:
                end = self.data.find(b"endstream", p)
                if end < 0:
                    raise PdfError("stream without endstream")
                raw = self.data[p:end]
                if raw.endswith(b"\r\n"):
                    raw = raw[:-2]
                elif raw.endswith(b"\n") or raw.endswith(b"\r"):
                    raw = raw[:-1]
                if isinstance(length, int):
                    self.issues.append(issue("PDF_STREAM_LENGTH", f"stream /Length {length} does not match data",
                                             "MAJOR"))
            end = self.data.find(b"endstream", p + len(raw))
            return Stream(obj, raw), end + 9
        lex.pos = save
        t = lex.token()
        if t != "endobj":
            raise PdfError("missing endobj")
        return obj, lex.pos

    def _load_objstm(self, stm: Stream):
        data = decode_stream(stm, self.resolve)
        n, first = int(self.get(stm, "N", 0)), int(self.get(stm, "First", 0))
        lex = Lexer(data)
        pairs = []
        for _ in range(n):
            num, off = lex.token(), lex.token()
            if not isinstance(num, int) or not isinstance(off, int):
                raise PdfError("bad object stream header")
            pairs.append((num, off))
        for num, off in pairs:
            ref = Ref(num, 0)
            if ref in self.objects:
                continue
            self.objects[ref] = parse_value(Lexer(data, first + off))

    def _check_xref(self):
        d = self.data
        m = None
        for m in re.finditer(rb"startxref\s+(\d+)", d):
            pass
        if m is None:
            raise PdfError("missing startxref")
        offset = int(m.group(1))
        seen = set()
        trailers = []
        while offset is not None and offset not in seen:
            seen.add(offset)
            if offset >= len(d):
                raise PdfError(f"startxref offset {offset} beyond end of file")
            if d[offset:offset + 4] == b"xref":
                trailer = self._xref_table(offset)
            else:
                mo = _OBJ_RE.match(d, offset)
                if not mo:
                    raise PdfError(f"startxref offset {offset} does not point to an xref table or stream")
                obj = self.objects.get(Ref(int(mo.group(1)), int(mo.group(2))))
                if not isinstance(obj, Stream) or self.get(obj, "Type") != "XRef":
                    raise PdfError(f"object at startxref offset {offset} is not an XRef stream")
                trailer = self._xref_stream(obj)
            trailers.append(trailer)
            prev = trailer.get("Prev")
            offset = prev if isinstance(prev, int) else None
        merged = {}
        for t in reversed(trailers):
            merged.update(t)
        self.trailer = merged
        if not isinstance(self.trailer.get("Root"), Ref):
            raise PdfError("trailer has no indirect /Root")

    def _verify_offset(self, ref: Ref, off: int):
        mo = _OBJ_RE.match(self.data, off)
        if not mo or int(mo.group(1)) != ref.num or int(mo.group(2)) != ref.gen:
            self.issues.append(issue("PDF_XREF_OFFSET", f"xref entry for object {ref.num} {ref.gen} points to byte "
                                                        f"{off}, which does not start that object"))

    def _xref_table(self, offset: int) -> dict:
        lex = Lexer(self.data, offset + 4)
        while True:
            save = lex.pos
            t = lex.token()
            if t == "trailer":
                tr = parse_value(lex)
                if not isinstance(tr, dict):
                    raise PdfError("trailer is not a dictionary")
                return tr
            if not isinstance(t, int):
                raise PdfError(f"malformed xref subsection header near {save}")
            start, count = t, lex.token()
            if not isinstance(count, int):
                raise PdfError("malformed xref subsection count")
            lex.skip_ws()
            for i in range(count):
                lex.skip_ws()
                line = self.data[lex.pos:lex.pos + 20]
                mo = re.match(rb"(\d{10}) (\d{5}) ([nf])", line)
                if not mo:
                    raise PdfError(f"malformed xref entry for object {start + i}")
                lex.pos += mo.end()
                if mo.group(3) == b"n":
                    self._verify_offset(Ref(start + i, int(mo.group(2))), int(mo.group(1)))

    def _xref_stream(self, stm: Stream) -> dict:
        data = decode_stream(stm, self.resolve)
        w = [int(x) for x in self.get(stm, "W", [])]
        if len(w) != 3:
            raise PdfError("XRef stream /W must have three entries")
        size = int(self.get(stm, "Size", 0))
        index = self.get(stm, "Index", [0, size])
        rowlen = sum(w)
        if rowlen == 0:
            raise PdfError("XRef stream /W is all zero")
        pos = 0

        def field_(b: bytes, default: int) -> int:
            return int.from_bytes(b, "big") if b else default

        for k in range(0, len(index), 2):
            start, count = int(index[k]), int(index[k + 1])
            for i in range(count):
                row = data[pos:pos + rowlen]
                pos += rowlen
                if len(row) < rowlen:
                    raise PdfError("XRef stream shorter than its /Index")
                typ = field_(row[:w[0]], 1)
                f2 = field_(row[w[0]:w[0] + w[1]], 0)
                f3 = field_(row[w[0] + w[1]:], 0)
                if typ == 1:
                    self._verify_offset(Ref(start + i, f3), f2)
                elif typ == 2:
                    if Ref(start + i, 0) not in self.objects:
                        self.issues.append(issue("PDF_XREF_OBJSTM", f"object {start + i} listed in object stream "
                                                                    f"{f2} is missing"))
        return dict(stm.dict)

    # -- document model
    def catalog(self) -> dict:
        cat = self.resolve(self.trailer.get("Root"))
        if not isinstance(cat, dict) or cat.get("Type") != "Catalog":
            raise PdfError("/Root does not resolve to a /Type /Catalog dictionary")
        return cat

    def pages(self) -> list[dict]:
        """Leaf pages with inherited attributes: [{ref, dict, MediaBox, Resources, ...}]."""
        root = self.get(self.catalog(), "Pages")
        if not isinstance(root, dict) or root.get("Type") != "Pages":
            raise PdfError("Catalog /Pages is not a /Type /Pages node")
        out: list[dict] = []
        visited: set = set()

        def walk(node_ref, node, inherited, depth):
            if depth > 64:
                raise PdfError("page tree too deep")
            key = node_ref if isinstance(node_ref, Ref) else id(node)
            if key in visited:
                raise PdfError("page tree contains a cycle")
            visited.add(key)
            inh = dict(inherited)
            for k in ("MediaBox", "CropBox", "Resources", "Rotate"):
                if k in node:
                    inh[k] = self.resolve(node[k])
            typ = node.get("Type")
            if typ == "Pages":
                kids = self.resolve(node.get("Kids"))
                if not isinstance(kids, list):
                    raise PdfError("/Pages node without /Kids array")
                before = len(out)
                for kid in kids:
                    kd = self.resolve(kid)
                    if not isinstance(kd, dict):
                        raise PdfError("page tree kid does not resolve to a dictionary")
                    walk(kid, kd, inh, depth + 1)
                count = self.resolve(node.get("Count"))
                if count != len(out) - before:
                    self.issues.append(issue("PDF_PAGE_COUNT", f"/Pages /Count {count} but {len(out) - before} leaf "
                                                               "pages found", "MAJOR"))
            elif typ == "Page":
                out.append({"ref": node_ref, "dict": node, **inh})
            else:
                raise PdfError(f"page tree node of type {typ!r}")

        walk(self.catalog().get("Pages"), root, {}, 0)
        return out

    def page_contents(self, page: dict) -> bytes:
        c = self.resolve(page["dict"].get("Contents"))
        parts = c if isinstance(c, list) else ([c] if c is not None else [])
        out = []
        for p in parts:
            s = self.resolve(p)
            if not isinstance(s, Stream):
                raise PdfError("page /Contents is not a stream")
            out.append(decode_stream(s, self.resolve))
        return b"\n".join(out)


def pdf_text(s) -> str:
    if isinstance(s, PdfString):
        b = bytes(s)
        if b.startswith(b"\xfe\xff"):
            return b[2:].decode("utf-16-be", errors="replace")
        if b.startswith(b"\xef\xbb\xbf"):
            return b[3:].decode("utf-8", errors="replace")
        return b.decode("latin-1")
    return str(s)


def _box(doc: PdfDocument, value) -> tuple | None:
    v = doc.resolve(value)
    if not isinstance(v, list) or len(v) != 4:
        return None
    try:
        nums = [float(doc.resolve(x)) for x in v]
    except (TypeError, ValueError):
        return None
    x0, y0, x1, y1 = nums
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


# ---------------------------------------------------------------------- content interpreter
def _mul(m1, m2):
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (a1 * a2 + b1 * c2, a1 * b2 + b1 * d2, c1 * a2 + d1 * c2, c1 * b2 + d1 * d2,
            e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2)


def _apply(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def _bbox_of(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (min(xs), min(ys), max(xs), max(ys))


IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


@dataclass
class FontMetrics:
    widths: dict = field(default_factory=dict)
    first_char: int = 0
    missing_width: float = 0.0
    exact_widths: bool = False
    bbox: tuple | None = None  # (ymin, ymax) per 1000 em
    two_byte: bool = False
    name: str = ""
    embedded: bool = False

    def advance(self, code: int) -> tuple[float, bool]:
        if self.exact_widths:
            if code in self.widths:
                return self.widths[code], True
            return self.missing_width, True
        if self.name.startswith("Courier"):
            return 600.0, True
        return 1000.0, False  # conservative upper bound (no metrics)


def font_metrics(doc: PdfDocument, font) -> FontMetrics:
    font = doc.resolve(font)
    fm = FontMetrics()
    if not isinstance(font, dict):
        return fm
    fm.name = str(doc.get(font, "BaseFont", ""))
    fm.name = fm.name.split("+", 1)[1] if re.match(r"^[A-Z]{6}\+", fm.name) else fm.name
    subtype = doc.get(font, "Subtype")
    desc = doc.get(font, "FontDescriptor")
    if subtype == "Type0":
        fm.two_byte = True
        desc_fonts = doc.get(font, "DescendantFonts", [])
        df = doc.resolve(desc_fonts[0]) if isinstance(desc_fonts, list) and desc_fonts else None
        if isinstance(df, dict):
            desc = doc.get(df, "FontDescriptor")
            dw = doc.get(df, "DW", 1000)
            w = doc.get(df, "W")
            if isinstance(w, list):
                i = 0
                while i < len(w):
                    c0 = doc.resolve(w[i])
                    nxt = doc.resolve(w[i + 1]) if i + 1 < len(w) else None
                    if isinstance(nxt, list):
                        for j, val in enumerate(nxt):
                            fm.widths[int(c0) + j] = float(doc.resolve(val))
                        i += 2
                    else:
                        c1, val = nxt, doc.resolve(w[i + 2]) if i + 2 < len(w) else 0
                        for c in range(int(c0), int(c1) + 1):
                            fm.widths[c] = float(val)
                        i += 3
                fm.exact_widths = True
                fm.missing_width = float(dw)
    else:
        widths = doc.get(font, "Widths")
        if isinstance(widths, list):
            fm.first_char = int(doc.get(font, "FirstChar", 0))
            for i, w in enumerate(widths):
                fm.widths[fm.first_char + i] = float(doc.resolve(w) or 0)
            fm.exact_widths = True
    if isinstance(desc, dict):
        fm.missing_width = float(doc.get(desc, "MissingWidth", fm.missing_width) or 0)
        bb = _box(doc, desc.get("FontBBox"))
        if bb:
            fm.bbox = (bb[1], bb[3])
        fm.embedded = any(k in desc for k in ("FontFile", "FontFile2", "FontFile3"))
    return fm


@dataclass
class Mark:
    kind: str  # TEXT | IMAGE
    bbox: tuple
    exact: bool
    origin: tuple | None = None


def interpret_page(doc: PdfDocument, page: dict) -> tuple[list[Mark], list[dict]]:
    """Return text/image marks in default user space plus interpretation issues."""
    marks: list[Mark] = []
    issues: list[dict] = []
    try:
        content = doc.page_contents(page)
    except PdfError as exc:
        return marks, [issue("PDF_CONTENT_DECODE", str(exc), "MAJOR", "UNKNOWN")]
    _run_content(doc, content, doc.resolve(page.get("Resources")) or {}, IDENTITY, marks, issues, 0)
    return marks, issues


def _clip_box(bbox, clip):
    """Visible part of a mark's bbox inside the current clipping box (None when fully clipped away)."""
    if clip is None:
        return bbox
    x0, y0 = max(bbox[0], clip[0]), max(bbox[1], clip[1])
    x1, y1 = min(bbox[2], clip[2]), min(bbox[3], clip[3])
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1, y1)


def _run_content(doc, content: bytes, resources, ctm, marks, issues, depth, clip=None):
    """Interpret one content stream. Clipping paths (W/W* then a painting operator) are tracked as the
    bounding box of the clip path in default user space (conservative for non-rectangular paths), so
    a COVER-fit image drawn larger than its clipped box is measured by what is actually visible."""
    if depth > 8:
        issues.append(issue("PDF_FORM_DEPTH", "form XObject nesting too deep", "MAJOR", "UNKNOWN"))
        return
    lex = Lexer(content)
    ops: list = []
    stack = []
    font = FontMetrics()
    fonts_cache: dict = {}
    ts = {"fs": 0.0, "tc": 0.0, "tw": 0.0, "tz": 100.0, "tl": 0.0, "rise": 0.0}
    tm = tlm = IDENTITY
    res_fonts = doc.get(resources, "Font", {}) or {}
    res_xobj = doc.get(resources, "XObject", {}) or {}
    path_pts: list = []
    pending_clip = False

    def add_mark(kind, bbox, exact, origin=None):
        vis = _clip_box(bbox, clip)
        if vis is not None:
            marks.append(Mark(kind, vis, exact, origin))

    def show(s):
        nonlocal tm
        if not isinstance(s, (PdfString, bytes)):
            return
        data = bytes(s)
        codes = ([int.from_bytes(data[i:i + 2], "big") for i in range(0, len(data) - 1, 2)]
                 if font.two_byte else list(data))
        width, exact = 0.0, True
        for code in codes:
            w, ex = font.advance(code)
            exact = exact and ex
            sp = ts["tw"] if (code == 32 and not font.two_byte) else 0.0
            width += (w / 1000.0 * ts["fs"] + ts["tc"] + sp) * ts["tz"] / 100.0
        if font.bbox:
            lo, hi = font.bbox[0] / 1000.0 * ts["fs"], font.bbox[1] / 1000.0 * ts["fs"]
        else:
            lo, hi = -0.35 * ts["fs"], 1.05 * ts["fs"]
            exact = False
        m = _mul(tm, ctm)
        pts = [_apply(m, x, y + ts["rise"]) for x in (0.0, width) for y in (lo, hi)]
        if codes:
            add_mark("TEXT", _bbox_of(pts), exact, _apply(m, 0.0, ts["rise"]))
        tm = _mul((1.0, 0.0, 0.0, 1.0, width, 0.0), tm)

    while True:
        try:
            tok = lex.token()
        except PdfError as exc:
            issues.append(issue("PDF_CONTENT_SYNTAX", str(exc), "MAJOR", "UNKNOWN"))
            return
        if tok is None:
            break
        if isinstance(tok, Keyword) and tok not in ("[", "<<", "true", "false", "null"):
            op = str(tok)
            a = ops
            ops = []
            try:
                if op == "BI":
                    end = re.compile(rb"\sEI(?=[\s]|$)").search(content, lex.pos)
                    if not end:
                        issues.append(issue("PDF_INLINE_IMAGE", "unterminated inline image", "MAJOR", "UNKNOWN"))
                        return
                    lex.pos = end.end()
                    add_mark("IMAGE", _bbox_of([_apply(ctm, x, y) for x in (0, 1) for y in (0, 1)]), True)
                elif op == "q":
                    stack.append((ctm, clip))
                elif op == "Q":
                    ctm, clip = stack.pop() if stack else (ctm, clip)
                elif op == "re" and len(a) >= 4:
                    x, y, w, h = (float(v) for v in a[-4:])
                    path_pts.extend(_apply(ctm, px, py) for px in (x, x + w) for py in (y, y + h))
                elif op in ("m", "l") and len(a) >= 2:
                    path_pts.append(_apply(ctm, float(a[-2]), float(a[-1])))
                elif op == "c" and len(a) >= 6:
                    vals = [float(v) for v in a[-6:]]
                    path_pts.extend(_apply(ctm, vals[k], vals[k + 1]) for k in (0, 2, 4))
                elif op in ("v", "y") and len(a) >= 4:
                    vals = [float(v) for v in a[-4:]]
                    path_pts.extend(_apply(ctm, vals[k], vals[k + 1]) for k in (0, 2))
                elif op in ("W", "W*"):
                    pending_clip = True
                elif op in ("n", "S", "s", "f", "F", "f*", "B", "B*", "b", "b*"):
                    if pending_clip and path_pts:
                        box = _bbox_of(path_pts)
                        clip = _clip_box(box, clip) or (box[0], box[1], box[0], box[1])
                    path_pts, pending_clip = [], False
                elif op == "cm" and len(a) >= 6:
                    ctm = _mul(tuple(float(x) for x in a[-6:]), ctm)
                elif op == "BT":
                    tm = tlm = IDENTITY
                elif op == "Tf" and len(a) >= 2:
                    name = str(a[-2])
                    if name not in fonts_cache:
                        fonts_cache[name] = font_metrics(doc, res_fonts.get(name) if isinstance(res_fonts, dict)
                                                         else None)
                    font = fonts_cache[name]
                    ts["fs"] = float(a[-1])
                elif op == "Tc" and a:
                    ts["tc"] = float(a[-1])
                elif op == "Tw" and a:
                    ts["tw"] = float(a[-1])
                elif op == "Tz" and a:
                    ts["tz"] = float(a[-1])
                elif op == "TL" and a:
                    ts["tl"] = float(a[-1])
                elif op == "Ts" and a:
                    ts["rise"] = float(a[-1])
                elif op == "Td" and len(a) >= 2:
                    tlm = _mul((1.0, 0.0, 0.0, 1.0, float(a[-2]), float(a[-1])), tlm)
                    tm = tlm
                elif op == "TD" and len(a) >= 2:
                    ts["tl"] = -float(a[-1])
                    tlm = _mul((1.0, 0.0, 0.0, 1.0, float(a[-2]), float(a[-1])), tlm)
                    tm = tlm
                elif op == "Tm" and len(a) >= 6:
                    tlm = tm = tuple(float(x) for x in a[-6:])
                elif op == "T*":
                    tlm = _mul((1.0, 0.0, 0.0, 1.0, 0.0, -ts["tl"]), tlm)
                    tm = tlm
                elif op == "Tj" and a:
                    show(a[-1])
                elif op == "'" and a:
                    tlm = _mul((1.0, 0.0, 0.0, 1.0, 0.0, -ts["tl"]), tlm)
                    tm = tlm
                    show(a[-1])
                elif op == '"' and len(a) >= 3:
                    ts["tw"], ts["tc"] = float(a[-3]), float(a[-2])
                    tlm = _mul((1.0, 0.0, 0.0, 1.0, 0.0, -ts["tl"]), tlm)
                    tm = tlm
                    show(a[-1])
                elif op == "TJ" and a and isinstance(a[-1], list):
                    for item in a[-1]:
                        if isinstance(item, (int, float)) and not isinstance(item, bool):
                            dx = -float(item) / 1000.0 * ts["fs"] * ts["tz"] / 100.0
                            tm = _mul((1.0, 0.0, 0.0, 1.0, dx, 0.0), tm)
                        else:
                            show(item)
                elif op == "Do" and a:
                    xo = doc.resolve(res_xobj.get(str(a[-1])) if isinstance(res_xobj, dict) else None)
                    if isinstance(xo, Stream):
                        sub = doc.get(xo, "Subtype")
                        if sub == "Image":
                            add_mark("IMAGE", _bbox_of([_apply(ctm, x, y) for x in (0, 1) for y in (0, 1)]), True)
                        elif sub == "Form":
                            mtx = doc.get(xo, "Matrix", list(IDENTITY))
                            fm = tuple(float(doc.resolve(x)) for x in mtx)
                            try:
                                sub_content = decode_stream(xo, doc.resolve)
                            except PdfError as exc:
                                issues.append(issue("PDF_CONTENT_DECODE", f"form XObject: {exc}", "MAJOR",
                                                    "UNKNOWN"))
                            else:
                                _run_content(doc, sub_content, doc.get(xo, "Resources", resources), _mul(fm, ctm),
                                             marks, issues, depth + 1, clip)
                    else:
                        issues.append(issue("PDF_XOBJECT_MISSING", f"XObject /{a[-1]} is not defined", "MAJOR"))
            except (TypeError, ValueError, IndexError) as exc:
                issues.append(issue("PDF_CONTENT_OPERANDS", f"operator {op}: {exc}", "MAJOR", "UNKNOWN"))
        else:
            try:
                ops.append(parse_value(lex, tok))
            except PdfError as exc:
                issues.append(issue("PDF_CONTENT_SYNTAX", str(exc), "MAJOR", "UNKNOWN"))
                return
            if len(ops) > 4096:
                ops = ops[-64:]


# ---------------------------------------------------------------------- PDF checks
def pdf_structure(data: bytes) -> tuple[PdfDocument | None, list[dict]]:
    """H09 structural parse of a PDF."""
    try:
        doc = PdfDocument(data)
        pages = doc.pages()
    except PdfError as exc:
        return None, [issue("PDF_STRUCTURE", f"PDF does not parse: {exc}")]
    except (RecursionError, ValueError, TypeError, KeyError) as exc:
        return None, [issue("PDF_STRUCTURE", f"PDF does not parse: {type(exc).__name__}: {exc}")]
    issues = list(doc.issues)
    if not pages:
        issues.append(issue("PDF_NO_PAGES", "PDF has no pages"))
    for i, p in enumerate(pages, 1):
        mb = _box(doc, p.get("MediaBox"))
        if mb is None:
            issues.append(issue("PDF_MEDIABOX", f"page {i} has no valid /MediaBox"))
        elif mb[2] - mb[0] <= 0 or mb[3] - mb[1] <= 0:
            issues.append(issue("PDF_MEDIABOX", f"page {i} /MediaBox has no positive area"))
        try:
            doc.page_contents(p)
        except PdfError as exc:
            issues.append(issue("PDF_CONTENT_DECODE", f"page {i}: {exc}"))
    if not any(i["severity"] in ("BLOCKING", "MAJOR") and i["decision"] != "PASS" for i in issues):
        issues.append(ok("PDF_STRUCTURE", f"PDF header, xref, trailer, catalog and {len(pages)} page(s) parse"))
    return doc, issues


def pdf_fonts(doc: PdfDocument) -> list[FontMetrics]:
    out, seen = [], set()
    for p in doc.pages():
        res = doc.resolve(p.get("Resources")) or {}
        fonts = doc.get(res, "Font", {}) or {}
        if isinstance(fonts, dict):
            for v in fonts.values():
                key = v if isinstance(v, Ref) else id(v)
                if key not in seen:
                    seen.add(key)
                    out.append(font_metrics(doc, v))
    return out


def pdf_named_destinations(doc: PdfDocument) -> dict[str, int | None]:
    """Named destination -> 1-based page index (None when it targets no known page)."""
    pages = doc.pages()
    index = {p["ref"]: i + 1 for i, p in enumerate(pages) if isinstance(p["ref"], Ref)}
    out: dict[str, int | None] = {}

    def target(v):
        v = doc.resolve(v)
        if isinstance(v, dict):
            v = doc.resolve(v.get("D"))
        if isinstance(v, list) and v:
            first = v[0]
            if isinstance(first, Ref):
                return index.get(first)
            if isinstance(first, int):
                return first + 1 if 0 <= first < len(pages) else None
        return None

    cat = doc.catalog()
    dests = doc.get(cat, "Dests")
    if isinstance(dests, dict):
        for k, v in dests.items():
            out[k] = target(v)
    names = doc.get(cat, "Names")
    tree = doc.get(names, "Dests") if isinstance(names, dict) else None
    visited = set()

    def walk(node, depth):
        node = doc.resolve(node)
        if not isinstance(node, dict) or depth > 32 or id(node) in visited:
            return
        visited.add(id(node))
        arr = doc.get(node, "Names")
        if isinstance(arr, list):
            for i in range(0, len(arr) - 1, 2):
                out[pdf_text(doc.resolve(arr[i]))] = target(arr[i + 1])
        kids = doc.get(node, "Kids")
        if isinstance(kids, list):
            for k in kids:
                walk(k, depth + 1)

    if tree is not None:
        walk(tree, 0)
    return out


def pdf_internal_links(doc: PdfDocument) -> list[tuple[int, object]]:
    """[(page_no, destination)] for internal link annotations (name or explicit array)."""
    out = []
    for i, p in enumerate(doc.pages(), 1):
        annots = doc.get(p["dict"], "Annots", [])
        if not isinstance(annots, list):
            continue
        for a in annots:
            a = doc.resolve(a)
            if not isinstance(a, dict) or a.get("Subtype") != "Link":
                continue
            dest = doc.resolve(a.get("Dest"))
            act = doc.resolve(a.get("A"))
            if dest is None and isinstance(act, dict) and doc.get(act, "S") == "GoTo":
                dest = doc.resolve(act.get("D"))
            if dest is not None:
                out.append((i, dest))
    return out


def pdf_outline_titles(doc: PdfDocument) -> dict[str, str]:
    """Named-destination outline items: dest name -> title."""
    out: dict[str, str] = {}
    outlines = doc.get(doc.catalog(), "Outlines")
    seen = set()

    def walk(item, depth):
        while item is not None and depth < 64:
            node = doc.resolve(item)
            if not isinstance(node, dict) or id(node) in seen:
                return
            seen.add(id(node))
            dest = doc.resolve(node.get("Dest"))
            act = doc.resolve(node.get("A"))
            if dest is None and isinstance(act, dict):
                dest = doc.resolve(act.get("D"))
            if isinstance(dest, (PdfString, Name, str)):
                out[pdf_text(dest)] = pdf_text(doc.resolve(node.get("Title", "")))
            if node.get("First") is not None:
                walk(node.get("First"), depth + 1)
            item = node.get("Next")

    if isinstance(outlines, dict):
        walk(outlines.get("First"), 0)
    return out


def pdf_layout(data: bytes, page_profile: dict, *, print_profile: bool) -> list[dict]:
    """H07 geometry: page size vs profile, safe-area crossings with page number and bbox."""
    out: list[dict] = []
    w_mm, h_mm = float(page_profile["width_mm"]), float(page_profile["height_mm"])
    bleed_mm, safe_mm = float(page_profile["bleed_mm"]), float(page_profile["safe_margin_mm"])
    if w_mm - 2 * safe_mm <= 0 or h_mm - 2 * safe_mm <= 0:
        return [issue("PAGE_PROFILE_USABLE_AREA", "safe margins leave no positive usable width/height")]
    try:
        doc = PdfDocument(data)
        pages = doc.pages()
    except (PdfError, RecursionError, ValueError, TypeError, KeyError) as exc:
        return [issue("PDF_STRUCTURE", f"PDF does not parse for layout inspection: {exc}")]
    tw, th, bl, sm = mm_to_pt(w_mm), mm_to_pt(h_mm), mm_to_pt(bleed_mm), mm_to_pt(safe_mm)
    size_fail = unknown = crossings = 0
    blank = []
    for i, p in enumerate(pages, 1):
        mb = _box(doc, p.get("MediaBox"))
        if mb is None:
            out.append(issue("PAGE_SIZE", f"page {i}: no valid MediaBox"))
            size_fail += 1
            continue
        trim = _box(doc, p["dict"].get("TrimBox"))
        mw, mh = mb[2] - mb[0], mb[3] - mb[1]
        if trim is not None:
            if abs((trim[2] - trim[0]) - tw) > PT_TOL or abs((trim[3] - trim[1]) - th) > PT_TOL:
                out.append(issue("PAGE_SIZE", f"page {i}: TrimBox {trim[2] - trim[0]:.2f}x{trim[3] - trim[1]:.2f}pt "
                                              f"!= profile {tw:.2f}x{th:.2f}pt ({w_mm}x{h_mm}mm)", "MAJOR"))
                size_fail += 1
            if (trim[0] - mb[0] < bl - PT_TOL or trim[1] - mb[1] < bl - PT_TOL or mb[2] - trim[2] < bl - PT_TOL
                    or mb[3] - trim[3] < bl - PT_TOL):
                out.append(issue("PAGE_BLEED", f"page {i}: MediaBox does not include the {bleed_mm}mm bleed around "
                                               "the TrimBox", "MAJOR"))
                size_fail += 1
        else:
            if abs(mw - tw) <= PT_TOL and abs(mh - th) <= PT_TOL and bl <= PT_TOL:
                trim = mb
            elif abs(mw - (tw + 2 * bl)) <= PT_TOL and abs(mh - (th + 2 * bl)) <= PT_TOL:
                trim = (mb[0] + bl, mb[1] + bl, mb[2] - bl, mb[3] - bl)
            else:
                out.append(issue("PAGE_SIZE", f"page {i}: MediaBox {mw:.2f}x{mh:.2f}pt does not match profile trim "
                                              f"{tw:.2f}x{th:.2f}pt with {bleed_mm}mm bleed", "MAJOR"))
                size_fail += 1
                trim = mb
        safe = (trim[0] + sm, trim[1] + sm, trim[2] - sm, trim[3] - sm)
        marks, perr = interpret_page(doc, p)
        for e in perr:
            out.append(dict(e, message=f"page {i}: {e['message']}"))
            unknown += 1
        if not marks:
            blank.append(i)
        for m in marks:
            x0, y0, x1, y1 = m.bbox
            inside = (x0 >= safe[0] - PT_TOL and y0 >= safe[1] - PT_TOL and x1 <= safe[2] + PT_TOL
                      and y1 <= safe[3] + PT_TOL)
            if inside:
                continue
            bbox_txt = f"[{x0:.1f} {y0:.1f} {x1:.1f} {y1:.1f}]pt vs safe [{safe[0]:.1f} {safe[1]:.1f} " \
                       f"{safe[2]:.1f} {safe[3]:.1f}]pt"
            if m.kind == "IMAGE" and x0 <= trim[0] + PT_TOL and y0 <= trim[1] + PT_TOL and \
                    x1 >= trim[2] - PT_TOL and y1 >= trim[3] - PT_TOL:
                out.append(issue("FULL_BLEED_IMAGE", f"page {i}: full-bleed image {bbox_txt}", "INFO", "PASS"))
                continue
            origin_out = m.origin is not None and not (safe[0] - PT_TOL <= m.origin[0] <= safe[2] + PT_TOL and
                                                       safe[1] - PT_TOL <= m.origin[1] <= safe[3] + PT_TOL)
            if m.exact or origin_out:
                out.append(issue("SAFE_MARGIN", f"page {i}: {m.kind.lower()} bbox crosses the safe area: {bbox_txt}",
                                 "MAJOR"))
                crossings += 1
            else:
                out.append(issue("SAFE_MARGIN_UNVERIFIED",
                                 f"page {i}: text extent cannot be proven inside the safe area without font metrics "
                                 f"(/Widths, FontBBox): conservative {bbox_txt}", "MAJOR", "UNKNOWN"))
                unknown += 1
    if blank:
        out.append(issue("BLANK_PAGE", f"blank page(s): {blank}", "INFO" if print_profile else "MINOR",
                         "PASS" if print_profile else "FAIL"))
    if not size_fail:
        out.append(ok("PAGE_SIZE", f"all {len(pages)} page(s) match {w_mm}x{h_mm}mm with {bleed_mm}mm bleed"))
    if not crossings and not unknown:
        out.append(ok("SAFE_MARGIN", f"all text/image marks on {len(pages)} page(s) lie inside the {safe_mm}mm "
                                     "safe area"))
    return out


# ====================================================================== XML / ZIP helpers
def parse_xml(data: bytes, label: str) -> tuple[ET.Element | None, dict | None]:
    if re.search(rb"<!ENTITY", data[:65536]):
        return None, issue("XML_ENTITY", f"{label}: XML entity declarations are not permitted")
    try:
        return ET.fromstring(data), None
    except ET.ParseError as exc:
        return None, issue("XML_WELL_FORMED", f"{label} is not well-formed XML: {exc}")


def open_zip(data: bytes, label: str) -> tuple[zipfile.ZipFile | None, list[dict]]:
    if not data.startswith(b"PK\x03\x04"):
        return None, [issue("ZIP_SIGNATURE", f"{label} does not start with a ZIP local file header")]
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError) as exc:
        return None, [issue("ZIP_STRUCTURE", f"{label} is not a readable ZIP: {exc}")]
    infos = zf.infolist()
    if len(infos) > MAX_ZIP_ENTRIES or sum(i.file_size for i in infos) > MAX_ZIP_TOTAL:
        return None, [issue("ZIP_LIMITS", f"{label} exceeds entry/size limits")]
    names = [i.filename for i in infos]
    issues = []
    if len(set(names)) != len(names):
        issues.append(issue("ZIP_DUPLICATE_ENTRY", f"{label} contains duplicate entry names"))
    for n in names:
        if n.startswith("/") or ".." in n.split("/") or "\\" in n:
            issues.append(issue("ZIP_PATH", f"{label} entry {n!r} escapes the package root"))
    try:
        bad = zf.testzip()
    except (zipfile.BadZipFile, zlib.error, NotImplementedError, EOFError) as exc:
        return None, issues + [issue("ZIP_CRC", f"{label} entries cannot be decompressed: {exc}")]
    if bad is not None:
        issues.append(issue("ZIP_CRC", f"{label} entry {bad!r} fails its CRC check"))
    return zf, issues


def _resolve_href(base_file: str, href: str) -> tuple[str | None, str, bool]:
    """-> (zip path or None for external, fragment, escaped_root)."""
    parts = urlsplit(href)
    if parts.scheme or parts.netloc:
        return None, parts.fragment, False
    path = unquote(parts.path)
    if not path:
        return base_file, unquote(parts.fragment), False
    joined = posixpath.normpath(posixpath.join(posixpath.dirname(base_file), path))
    return joined, unquote(parts.fragment), joined.startswith("../") or joined == ".."


# ====================================================================== EPUB
NS = {
    "c": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
    "x": "http://www.w3.org/1999/xhtml",
    "epub": "http://www.idpf.org/2007/ops",
}

# External validator hook: name -> callable(bytes) -> (ok: bool, version: str, messages: list[str]), or
# None when the tool is absent. Tests may install a fake; the default runs the real EPUBCheck when found.
EXTERNAL_VALIDATORS: dict = {}

# Where EPUBCheck is looked for, in order:
#   1. AKOWE_EPUBCHECK = path to epubcheck.jar (run with Java) or to an `epubcheck` program;
#   2. a jar placed in the app folder: akowe/tools/epubcheck/epubcheck.jar, or the unzipped
#      release folder akowe/tools/epubcheck-<version>/epubcheck.jar;
#   3. an `epubcheck` program on PATH (e.g. installed with a package manager).
# A jar needs Java: `java` on PATH or JAVA_HOME/bin/java.
EPUBCHECK_ENV = "AKOWE_EPUBCHECK"
TOOLS_DIR = Path(__file__).resolve().parent.parent / "tools"
EPUBCHECK_HELP = ("to add the official check, install Java and EPUBCheck (https://www.w3.org/publishing/epubcheck/): "
                  "unzip the EPUBCheck release into akowe/tools/ (so akowe/tools/epubcheck-<version>/"
                  "epubcheck.jar exists) or set AKOWE_EPUBCHECK to the path of epubcheck.jar")


def _java() -> str | None:
    home = os.environ.get("JAVA_HOME")
    if home:
        for name in ("java", "java.exe"):
            exe = os.path.join(home, "bin", name)
            if os.path.isfile(exe):
                return exe
    return shutil.which("java")


def epubcheck_command() -> tuple[list[str] | None, str]:
    """(command prefix to run EPUBCheck, plain-language note). The command is None when it is not usable."""
    candidates: list[Path] = []
    env = (legacy.env("EPUBCHECK") or "").strip()  # AKOWE_EPUBCHECK, or the old BOOKFORGE_EPUBCHECK
    if env:
        candidates.append(Path(env))
    candidates.append(TOOLS_DIR / "epubcheck" / "epubcheck.jar")
    if TOOLS_DIR.is_dir():
        candidates += sorted(TOOLS_DIR.glob("epubcheck*/epubcheck.jar"), reverse=True)
    for c in candidates:
        if not c.is_file():
            if env and c == Path(env):
                return None, f"{EPUBCHECK_ENV} points to {env}, which does not exist"
            continue
        if c.suffix.lower() == ".jar":
            java = _java()
            if java is None:
                return None, f"EPUBCheck is at {c} but Java is not installed (java not on PATH, JAVA_HOME unset)"
            return [java, "-jar", str(c)], f"EPUBCheck jar {c}"
        return [str(c)], f"EPUBCheck program {c}"
    exe = shutil.which("epubcheck")
    if exe:
        return [exe], f"EPUBCheck program {exe}"
    return None, "EPUBCheck is not installed"


def epubcheck_available() -> bool:
    if "epubcheck" in EXTERNAL_VALIDATORS:
        return EXTERNAL_VALIDATORS["epubcheck"] is not None
    return epubcheck_command()[0] is not None


def _system_epubcheck(data: bytes):
    cmd, _note = epubcheck_command()
    if cmd is None:
        return None
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "candidate.epub")
        with open(path, "wb") as fh:
            fh.write(data)
        try:
            ver = subprocess.run(cmd + ["--version"], capture_output=True, text=True, timeout=120)
            res = subprocess.run(cmd + [path], capture_output=True, text=True, timeout=600)
        except (OSError, subprocess.SubprocessError) as exc:
            return False, "epubcheck", [f"EPUBCheck could not run: {exc}"]
        lines = (ver.stdout + "\n" + ver.stderr).splitlines()
        version = next((ln.strip() for ln in lines if ln.strip().lower().startswith("epubcheck")), "EPUBCheck")
        msgs = [ln for ln in (res.stdout + res.stderr).splitlines() if ln.startswith(("ERROR", "FATAL"))]
        if res.returncode != 0 and not msgs:
            msgs = [f"EPUBCheck exited with code {res.returncode}: " + (res.stderr or res.stdout).strip()[-400:]]
        return res.returncode == 0 and not msgs, version, msgs


def run_epubcheck(data: bytes):
    if "epubcheck" in EXTERNAL_VALIDATORS:
        fn = EXTERNAL_VALIDATORS["epubcheck"]
        return fn(data) if fn is not None else None
    return _system_epubcheck(data)


@dataclass
class EpubInfo:
    opf_path: str = ""
    nav_path: str | None = None
    nav_links: list = field(default_factory=list)  # [(href_path, fragment, text)]
    ids: dict = field(default_factory=dict)  # zip path -> set(ids)
    validator: str = "unavailable"


def epub_check(data: bytes, *, run_external: bool = True) -> tuple[list[dict], EpubInfo]:
    info = EpubInfo()
    zf, issues = open_zip(data, "EPUB")
    if zf is None:
        return issues, info
    infos = zf.infolist()
    first = infos[0] if infos else None
    if first is None or first.filename != "mimetype":
        issues.append(issue("EPUB_MIMETYPE_FIRST", "the first ZIP entry must be 'mimetype'"))
    else:
        if first.compress_type != zipfile.ZIP_STORED:
            issues.append(issue("EPUB_MIMETYPE_STORED", "'mimetype' must be stored uncompressed"))
        if data[26:28] != b"\x08\x00" or data[30:38] != b"mimetype" or data[28:30] != b"\x00\x00":
            issues.append(issue("EPUB_MIMETYPE_HEADER", "'mimetype' local header must have no extra field and "
                                                        "start at byte 0"))
        if zf.read("mimetype") != b"application/epub+zip":
            issues.append(issue("EPUB_MIMETYPE_VALUE", "'mimetype' content must be exactly application/epub+zip"))
    names = set(zf.namelist())
    if "META-INF/container.xml" not in names:
        issues.append(issue("EPUB_CONTAINER", "META-INF/container.xml is missing"))
        return issues, info
    root, err = parse_xml(zf.read("META-INF/container.xml"), "META-INF/container.xml")
    if err:
        return issues + [err], info
    rf = root.find("c:rootfiles/c:rootfile", NS)
    if rf is None or not rf.get("full-path"):
        issues.append(issue("EPUB_CONTAINER", "container.xml has no rootfile full-path"))
        return issues, info
    if rf.get("media-type") != "application/oebps-package+xml":
        issues.append(issue("EPUB_CONTAINER", "rootfile media-type must be application/oebps-package+xml", "MAJOR"))
    opf_path = rf.get("full-path")
    info.opf_path = opf_path
    if opf_path not in names:
        issues.append(issue("EPUB_OPF", f"package document {opf_path!r} is missing"))
        return issues, info
    opf, err = parse_xml(zf.read(opf_path), opf_path)
    if err:
        return issues + [err], info
    if opf.tag != f"{{{NS['opf']}}}package":
        issues.append(issue("EPUB_OPF", "package document root must be opf:package"))
        return issues, info
    meta = opf.find("opf:metadata", NS)
    if meta is None:
        issues.append(issue("EPUB_METADATA", "package has no metadata"))
    else:
        for tag in ("identifier", "title", "language"):
            el = meta.find(f"dc:{tag}", NS)
            if el is None or not (el.text or "").strip():
                issues.append(issue("EPUB_METADATA", f"dc:{tag} is missing or empty", "MAJOR"))
        uid = opf.get("unique-identifier")
        if not uid or not any(el.get("id") == uid for el in meta.findall("dc:identifier", NS)):
            issues.append(issue("EPUB_METADATA", "package unique-identifier does not reference a dc:identifier",
                                "MAJOR"))
    manifest = {}
    mf = opf.find("opf:manifest", NS)
    for item in (mf.findall("opf:item", NS) if mf is not None else []):
        iid, href, mt = item.get("id"), item.get("href"), item.get("media-type")
        if not iid or not href or not mt:
            issues.append(issue("EPUB_MANIFEST", "manifest item lacks id/href/media-type"))
            continue
        if iid in manifest:
            issues.append(issue("EPUB_MANIFEST", f"duplicate manifest id {iid!r}"))
        path, _, escaped = _resolve_href(opf_path, href)
        if path is None:
            issues.append(issue("EPUB_REMOTE_RESOURCE", f"manifest item {iid!r} is remote ({href}); assets must be "
                                                        "packaged", "MAJOR"))
            continue
        if escaped or path not in names:
            issues.append(issue("EPUB_MANIFEST_MISSING_FILE", f"manifest item {iid!r} -> {path!r} is not in the "
                                                              "package"))
        manifest[iid] = {"path": path, "media_type": mt, "properties": (item.get("properties") or "").split()}
    if not manifest:
        issues.append(issue("EPUB_MANIFEST", "manifest is empty"))
    spine = opf.find("opf:spine", NS)
    refs = spine.findall("opf:itemref", NS) if spine is not None else []
    if not refs:
        issues.append(issue("EPUB_SPINE", "spine has no itemrefs"))
    for r in refs:
        if r.get("idref") not in manifest:
            issues.append(issue("EPUB_SPINE", f"spine itemref {r.get('idref')!r} is not a manifest id"))
    navs = [m for m in manifest.values() if "nav" in m["properties"]]
    version = opf.get("version", "")
    if version.startswith("3") and len(navs) != 1:
        issues.append(issue("EPUB_NAV", f"EPUB 3 requires exactly one nav document (found {len(navs)})"))
    manifest_paths = {m["path"] for m in manifest.values()}
    # content documents: well-formedness, ids, references
    for m in manifest.values():
        if m["media_type"] != "application/xhtml+xml" or m["path"] not in names:
            continue
        doc, err = parse_xml(zf.read(m["path"]), m["path"])
        if err:
            issues.append(err)
            continue
        info.ids[m["path"]] = {el.get("id") for el in doc.iter() if el.get("id")}
        for el in doc.iter():
            for attr in ("src", "href"):
                v = el.get(attr)
                if v is None or el.tag == f"{{{NS['x']}}}a":
                    continue
                path, _, escaped = _resolve_href(m["path"], v)
                if path is None:
                    issues.append(issue("EPUB_REMOTE_RESOURCE", f"{m['path']}: remote resource {v}", "MAJOR"))
                elif escaped or path not in names:
                    issues.append(issue("EPUB_BROKEN_RESOURCE", f"{m['path']}: resource {v!r} is missing"))
                elif path not in manifest_paths:
                    issues.append(issue("EPUB_UNDECLARED_RESOURCE", f"{m['path']}: resource {v!r} is not in the "
                                                                    "manifest", "MAJOR"))
    # hyperlinks (after all ids are known)
    for m in manifest.values():
        if m["path"] not in info.ids:
            continue
        doc, _ = parse_xml(zf.read(m["path"]), m["path"])
        for a in doc.iter(f"{{{NS['x']}}}a"):
            href = a.get("href")
            if not href:
                continue
            path, frag, escaped = _resolve_href(m["path"], href)
            if path is None:
                continue
            if escaped or path not in names:
                issues.append(issue("EPUB_BROKEN_LINK", f"{m['path']}: link {href!r} targets a missing file", "MAJOR"))
            elif frag and frag not in info.ids.get(path, set()):
                issues.append(issue("EPUB_BROKEN_LINK", f"{m['path']}: link {href!r} targets missing id {frag!r}",
                                    "MAJOR"))
    if navs:
        nav_path = navs[0]["path"]
        info.nav_path = nav_path
        if nav_path in names:
            nav, err = parse_xml(zf.read(nav_path), nav_path)
            if err:
                issues.append(err)
            else:
                toc = None
                for n in nav.iter(f"{{{NS['x']}}}nav"):
                    if "toc" in (n.get(f"{{{NS['epub']}}}type") or "").split():
                        toc = n
                        break
                if toc is None:
                    issues.append(issue("EPUB_NAV", "nav document has no nav epub:type='toc'"))
                else:
                    for a in toc.iter(f"{{{NS['x']}}}a"):
                        path, frag, _ = _resolve_href(nav_path, a.get("href") or "")
                        info.nav_links.append((path, frag, " ".join("".join(a.itertext()).split())))
    if run_external:
        res = run_epubcheck(data)
        if res is None:
            _cmd, why = epubcheck_command()
            if "epubcheck" in EXTERNAL_VALIDATORS:
                why = "EPUBCheck is not installed"
            issues.append(issue("VALIDATOR_UNAVAILABLE", f"not checked by EPUBCheck ({why}). Akọwe's own EPUB "
                                f"checks above still ran; {EPUBCHECK_HELP}.", "MINOR", "UNKNOWN"))
        else:
            passed, ver, msgs = res
            info.validator = ver
            if passed:
                issues.append(ok("EPUBCHECK", f"{ver}: no errors"))
            else:
                issues.append(issue("EPUBCHECK", f"{ver}: " + "; ".join(msgs[:20]) if msgs else f"{ver} failed"))
    if not any(i["severity"] in ("BLOCKING", "MAJOR") and i["decision"] == "FAIL" for i in issues):
        issues.append(ok("EPUB_STRUCTURE", "mimetype, container, package, manifest, spine, nav and XHTML parse"))
    return issues, info


# ====================================================================== DOCX
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
OFFICE_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
DOCX_MAIN_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"


@dataclass
class DocxInfo:
    main_part: str | None = None
    bookmarks: set = field(default_factory=set)
    anchors: list = field(default_factory=list)  # internal hyperlink anchors
    sections: list = field(default_factory=list)  # [{w,h,top,bottom,left,right}] in twips
    headings: list = field(default_factory=list)


def _rels_path(part: str) -> str:
    d, f = posixpath.split(part)
    return posixpath.join(d, "_rels", f + ".rels")


def docx_check(data: bytes) -> tuple[list[dict], DocxInfo]:
    info = DocxInfo()
    zf, issues = open_zip(data, "DOCX")
    if zf is None:
        return issues, info
    names = set(zf.namelist())
    if "[Content_Types].xml" not in names:
        return issues + [issue("DOCX_CONTENT_TYPES", "[Content_Types].xml is missing")], info
    ct, err = parse_xml(zf.read("[Content_Types].xml"), "[Content_Types].xml")
    if err:
        return issues + [err], info
    defaults = {el.get("Extension", "").lower(): el.get("ContentType") for el in ct.findall(f"{{{CT_NS}}}Default")}
    overrides = {el.get("PartName", "").lstrip("/"): el.get("ContentType") for el in ct.findall(f"{{{CT_NS}}}Override")}
    for n in names:
        if n.endswith("/") or n == "[Content_Types].xml":
            continue
        ext = n.rsplit(".", 1)[-1].lower() if "." in n else ""
        if n not in overrides and ext not in defaults:
            issues.append(issue("DOCX_CONTENT_TYPES", f"part {n!r} has no content type"))
    if "_rels/.rels" not in names:
        return issues + [issue("DOCX_RELS", "_rels/.rels is missing")], info
    rels, err = parse_xml(zf.read("_rels/.rels"), "_rels/.rels")
    if err:
        return issues + [err], info
    main = None
    for r in rels.findall(f"{{{PKG_REL}}}Relationship"):
        if r.get("Type") == OFFICE_DOC:
            main = posixpath.normpath(r.get("Target", "").lstrip("/"))
    if not main or main not in names:
        return issues + [issue("DOCX_MAIN_PART", "officeDocument relationship target is missing")], info
    info.main_part = main
    if overrides.get(main) != DOCX_MAIN_CT:
        issues.append(issue("DOCX_CONTENT_TYPES", f"{main} must have content type {DOCX_MAIN_CT}"))
    doc, err = parse_xml(zf.read(main), main)
    if err:
        return issues + [err], info
    if doc.tag != f"{{{W}}}document" or doc.find(f"{{{W}}}body") is None:
        return issues + [issue("DOCX_DOCUMENT", "main part is not a w:document with w:body")], info
    rel_ids = {}
    rp = _rels_path(main)
    if rp in names:
        drels, err = parse_xml(zf.read(rp), rp)
        if err:
            issues.append(err)
        else:
            for r in drels.findall(f"{{{PKG_REL}}}Relationship"):
                rel_ids[r.get("Id")] = r
                if r.get("TargetMode") == "External":
                    continue
                target = posixpath.normpath(posixpath.join(posixpath.dirname(main), r.get("Target", "")))
                if target not in names:
                    issues.append(issue("DOCX_RELS", f"relationship {r.get('Id')} target {target!r} is missing"))
    for el in doc.iter():
        for k, v in el.attrib.items():
            if k.startswith(f"{{{R_NS}}}") and v not in rel_ids:
                issues.append(issue("DOCX_RELS", f"{el.tag.split('}')[-1]} references unknown relationship {v!r}"))
    body = doc.find(f"{{{W}}}body")
    for para in body.iter(f"{{{W}}}p"):
        st = para.find(f"{{{W}}}pPr/{{{W}}}pStyle")
        lvl = para.find(f"{{{W}}}pPr/{{{W}}}outlineLvl")
        if (st is not None and st.get(f"{{{W}}}val", "").lower().startswith("heading")) or lvl is not None:
            text = "".join(t.text or "" for t in para.iter(f"{{{W}}}t")).strip()
            if text:
                info.headings.append(text)
    for b in doc.iter(f"{{{W}}}bookmarkStart"):
        if b.get(f"{{{W}}}name"):
            info.bookmarks.add(b.get(f"{{{W}}}name"))
    for hl in doc.iter(f"{{{W}}}hyperlink"):
        if hl.get(f"{{{W}}}anchor"):
            info.anchors.append(hl.get(f"{{{W}}}anchor"))
    for a in info.anchors:
        if a not in info.bookmarks:
            issues.append(issue("DOCX_BROKEN_ANCHOR", f"internal hyperlink anchor {a!r} has no bookmark", "MAJOR"))
    for sp in doc.iter(f"{{{W}}}sectPr"):
        sz, mg = sp.find(f"{{{W}}}pgSz"), sp.find(f"{{{W}}}pgMar")
        sec = {}
        try:
            if sz is not None:
                sec["w"], sec["h"] = int(sz.get(f"{{{W}}}w")), int(sz.get(f"{{{W}}}h"))
            if mg is not None:
                for k in ("top", "bottom", "left", "right"):
                    sec[k] = abs(int(mg.get(f"{{{W}}}{k}")))
        except (TypeError, ValueError):
            issues.append(issue("DOCX_SECTION", "sectPr page size/margins are not integers", "MAJOR"))
        info.sections.append(sec)
    if not any(i["severity"] in ("BLOCKING", "MAJOR") and i["decision"] == "FAIL" for i in issues):
        issues.append(ok("DOCX_STRUCTURE", "content types, relationships and w:document parse"))
    return issues, info


def docx_layout(data: bytes, page_profile: dict) -> list[dict]:
    issues, info = docx_check(data)
    out = [i for i in issues if i["decision"] != "PASS"]
    if info.main_part is None:
        return out or [issue("DOCX_STRUCTURE", "DOCX does not parse for layout inspection")]
    w_mm, h_mm, safe_mm = float(page_profile["width_mm"]), float(page_profile["height_mm"]), \
        float(page_profile["safe_margin_mm"])
    if w_mm - 2 * safe_mm <= 0 or h_mm - 2 * safe_mm <= 0:
        return out + [issue("PAGE_PROFILE_USABLE_AREA", "safe margins leave no positive usable width/height")]
    twip = 1440 / 25.4
    tol = 20  # twips (~0.35 mm)
    if not info.sections:
        return out + [issue("DOCX_SECTION", "document has no sectPr with page geometry", "MAJOR")]
    bad = 0
    for n, sec in enumerate(info.sections, 1):
        if "w" not in sec or "h" not in sec:
            out.append(issue("PAGE_SIZE", f"section {n}: no w:pgSz", "MAJOR"))
            bad += 1
            continue
        if abs(sec["w"] - w_mm * twip) > tol or abs(sec["h"] - h_mm * twip) > tol:
            out.append(issue("PAGE_SIZE", f"section {n}: page {sec['w']}x{sec['h']} twips != profile "
                                          f"{w_mm}x{h_mm}mm", "MAJOR"))
            bad += 1
        for k in ("top", "bottom", "left", "right"):
            if k not in sec:
                out.append(issue("SAFE_MARGIN", f"section {n}: no {k} margin", "MAJOR"))
                bad += 1
            elif sec[k] + tol < safe_mm * twip:
                out.append(issue("SAFE_MARGIN", f"section {n}: {k} margin {sec[k]} twips < safe margin {safe_mm}mm",
                                 "MAJOR"))
                bad += 1
    if not bad:
        out.append(ok("PAGE_SIZE", f"{len(info.sections)} section(s) match {w_mm}x{h_mm}mm with margins >= "
                                   f"{safe_mm}mm"))
    return out
