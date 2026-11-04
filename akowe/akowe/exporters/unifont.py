"""🔤 H18: a Unicode-capable font for the PDFs (book, Character Forge dossier, cover, map labels and captions).

The PDF path sets text in the base-14 fonts (Times / Helvetica / Courier, WinAnsi encoding). Those have no ọ, ẹ, ł,
ő, Greek or Cyrillic letters: a book with them used to fail at the very end (G05) and captions / labels / the cover
lost their accents or printed "?". Now every run of letters WinAnsi cannot print is set in **DejaVu Serif** (bundled:
``fonts/DejaVuSerif.ttf``, free licence in ``fonts/DejaVu-LICENSE.txt``), embedded in the PDF as a subset
(``subset``: only the glyphs the document uses keep their outlines, so a PDF grows by a few kB, not 380 kB).

* ``covered(ch)`` — does the bundled font have this letter; ``uncovered(text)`` — the letters NO font of the PDF
  can print (they still block: never silently replaced).
* ``segments(text, base)`` — the text cut into runs [(text, font)] where ``font`` is ``base`` or ``NAME``.
* ``width(text)`` — advance width in 1/1000 em, like the AFM tables of the base-14 fonts.
* ``pdf_objects(writer, used_chars)`` — the Type0 / CIDFontType2 font (Identity-H, FontFile2 subset, ToUnicode, /W)
  added to a ``PdfWriter``; ``encode(text)`` — the hex string of the glyph ids for a Tj.

Pure Python (no fontTools): the TrueType tables are read with ``struct``.
"""
from __future__ import annotations

import struct
import threading
from pathlib import Path

NAME = "DejaVuSerif"                     # the font name the layout ops use for these runs
FILE = Path(__file__).resolve().parent / "fonts" / "DejaVuSerif.ttf"
_LOCK = threading.Lock()
_FONT = None


class _Font:
    def __init__(self, data: bytes):
        self.data = data
        num = struct.unpack(">H", data[4:6])[0]
        self.tables = {}
        for i in range(num):
            tag, _chk, off, ln = struct.unpack(">4sIII", data[12 + 16 * i: 28 + 16 * i])
            self.tables[tag.decode("latin-1")] = (off, ln)
        head = self.table("head")
        self.upem = struct.unpack(">H", head[18:20])[0]
        self.bbox = struct.unpack(">hhhh", head[36:44])
        self.loc_long = struct.unpack(">h", head[50:52])[0] == 1
        self.num_glyphs = struct.unpack(">H", self.table("maxp")[4:6])[0]
        hhea = self.table("hhea")
        self.ascent, self.descent = struct.unpack(">hh", hhea[4:8])
        n_hm = struct.unpack(">H", hhea[34:36])[0]
        hmtx = self.table("hmtx")
        adv = [struct.unpack(">H", hmtx[4 * i: 4 * i + 2])[0] for i in range(n_hm)]
        self.adv = adv + [adv[-1]] * (self.num_glyphs - n_hm)
        os2 = self.table("OS/2") if "OS/2" in self.tables else b""
        self.cap = struct.unpack(">h", os2[88:90])[0] if len(os2) >= 90 else self.ascent
        self.cmap = self._cmap()
        loca = self.table("loca")
        if self.loc_long:
            self.loca = list(struct.unpack(f">{self.num_glyphs + 1}I", loca[:4 * (self.num_glyphs + 1)]))
        else:
            self.loca = [2 * x for x in struct.unpack(f">{self.num_glyphs + 1}H", loca[:2 * (self.num_glyphs + 1)])]

    def table(self, tag: str) -> bytes:
        off, ln = self.tables[tag]
        return self.data[off: off + ln]

    def _cmap(self) -> dict:
        t = self.table("cmap")
        n = struct.unpack(">H", t[2:4])[0]
        subs = []
        for i in range(n):
            pid, eid, off = struct.unpack(">HHI", t[4 + 8 * i: 12 + 8 * i])
            fmt = struct.unpack(">H", t[off: off + 2])[0]
            subs.append((fmt, pid, eid, off))
        out: dict = {}
        for fmt, pid, eid, off in sorted(subs, key=lambda s: s[0] != 12):  # format 12 (full Unicode) first
            if pid not in (0, 3):
                continue
            if fmt == 12:
                ng = struct.unpack(">I", t[off + 12: off + 16])[0]
                for k in range(ng):
                    s, e, g = struct.unpack(">III", t[off + 16 + 12 * k: off + 28 + 12 * k])
                    for c in range(s, e + 1):
                        out.setdefault(c, g + c - s)
                return out
            if fmt == 4:
                segx2 = struct.unpack(">H", t[off + 6: off + 8])[0]
                seg = segx2 // 2
                ends = struct.unpack(f">{seg}H", t[off + 14: off + 14 + segx2])
                starts = struct.unpack(f">{seg}H", t[off + 16 + segx2: off + 16 + 2 * segx2])
                deltas = struct.unpack(f">{seg}h", t[off + 16 + 2 * segx2: off + 16 + 3 * segx2])
                ro_at = off + 16 + 3 * segx2
                ros = struct.unpack(f">{seg}H", t[ro_at: ro_at + segx2])
                for k in range(seg):
                    for c in range(starts[k], ends[k] + 1):
                        if c == 0xFFFF:
                            continue
                        if ros[k] == 0:
                            g = (c + deltas[k]) & 0xFFFF
                        else:
                            at = ro_at + 2 * k + ros[k] + 2 * (c - starts[k])
                            g = struct.unpack(">H", t[at: at + 2])[0]
                            g = (g + deltas[k]) & 0xFFFF if g else 0
                        if g:
                            out.setdefault(c, g)
        return out

    def glyph(self, gid: int) -> bytes:
        off = self.tables["glyf"][0]
        return self.data[off + self.loca[gid]: off + self.loca[gid + 1]]

    def components(self, gid: int) -> list[int]:
        g = self.glyph(gid)
        if len(g) < 10 or struct.unpack(">h", g[:2])[0] >= 0:
            return []
        out, p = [], 10
        while p + 4 <= len(g):
            flags, comp = struct.unpack(">HH", g[p: p + 4])
            out.append(comp)
            p += 4 + (4 if flags & 0x1 else 2)
            p += 2 if flags & 0x8 else 4 if flags & 0x40 else 8 if flags & 0x80 else 0
            if not flags & 0x20:
                break
        return out


def font() -> _Font | None:
    """The bundled font (read once). None when the file is missing (an old install): the PDFs then keep the base-14
    behaviour and G05 blocks letters they cannot print, as before."""
    global _FONT
    with _LOCK:
        if _FONT is None:
            try:
                _FONT = _Font(FILE.read_bytes())
            except (OSError, struct.error, KeyError, ValueError):
                _FONT = False
        return _FONT or None


def covered(ch: str) -> bool:
    f = font()
    return bool(f) and ord(ch) in f.cmap


def winansi_ok(ch: str) -> bool:
    try:
        b = ch.encode("cp1252")
    except UnicodeEncodeError:
        return False
    return b[0] >= 32


def uncovered(text: str) -> list[str]:
    """The letters neither the base-14 fonts (WinAnsi) nor the bundled Unicode font can print (sorted, once)."""
    return sorted({ch for ch in text if ch not in "\n\t\r" and not winansi_ok(ch) and not covered(ch)})


def segments(text: str, base: str) -> list[tuple[str, str]]:
    """[(run, font)]: the runs WinAnsi can print stay in ``base``; the others go to the Unicode font (a letter the
    Unicode font lacks too stays in ``base`` — it prints as "?"; G05 blocks such a book before)."""
    out: list[tuple[str, str]] = []
    for ch in text:
        f = base if winansi_ok(ch) or not covered(ch) else NAME
        if out and out[-1][1] == f:
            out[-1] = (out[-1][0] + ch, f)
        else:
            out.append((ch, f))
    return out


def needs(text: str) -> bool:
    return any(not winansi_ok(ch) and ch not in "\n\t\r" and covered(ch) for ch in text)


def width(text: str) -> float:
    """Advance width of ``text`` in the Unicode font, in 1/1000 em."""
    f = font()
    if not f:
        return 0.0
    return sum(f.adv[f.cmap.get(ord(ch), 0)] for ch in text) * 1000.0 / f.upem


def encode(text: str) -> bytes:
    """A PDF hex string of the glyph ids (Identity-H)."""
    f = font()
    return b"<" + "".join(f"{f.cmap.get(ord(ch), 0):04X}" for ch in text).encode("ascii") + b">"


# ====================================================================== the subset and the PDF objects
def _checksum(b: bytes) -> int:
    b = b + b"\0" * (-len(b) % 4)
    return sum(struct.unpack(f">{len(b) // 4}I", b)) & 0xFFFFFFFF


def subset(chars) -> bytes:
    """The font with only the glyphs of ``chars`` (and .notdef, and the parts of composite glyphs): the other glyphs
    are empty, so glyph ids do not change (Identity CIDToGIDMap). Hinting tables are kept; layout tables dropped."""
    f = font()
    keep = {0}
    todo = [f.cmap[ord(c)] for c in chars if ord(c) in f.cmap]
    while todo:
        g = todo.pop()
        if g in keep or g >= f.num_glyphs:
            continue
        keep.add(g)
        todo += f.components(g)
    glyf = bytearray()
    loca = []
    for g in range(f.num_glyphs):
        loca.append(len(glyf))
        if g in keep:
            glyf += f.glyph(g)
            glyf += b"\0" * (-len(glyf) % 4)
    loca.append(len(glyf))
    head = bytearray(f.table("head"))
    head[8:12] = b"\0\0\0\0"            # checkSumAdjustment, set below
    head[50:52] = struct.pack(">h", 1)  # long loca
    tables = {"head": bytes(head), "hhea": f.table("hhea"), "maxp": f.table("maxp"), "hmtx": f.table("hmtx"),
              "loca": struct.pack(f">{len(loca)}I", *loca), "glyf": bytes(glyf)}
    for t in ("cvt ", "fpgm", "prep"):
        if t in f.tables:
            tables[t] = f.table(t)
    tags = sorted(tables)
    n = len(tags)
    es = max(k for k in range(8) if 2 ** k <= n)
    out = bytearray(struct.pack(">IHHHH", 0x00010000, n, 16 * 2 ** es, es, 16 * n - 16 * 2 ** es))
    off = 12 + 16 * n
    body = bytearray()
    for t in tags:
        data = tables[t]
        out += struct.pack(">4sIII", t.encode("latin-1"), _checksum(data), off + len(body), len(data))
        body += data + b"\0" * (-len(data) % 4)
    whole = bytes(out + body)
    adj = (0xB1B0AFBA - _checksum(whole)) & 0xFFFFFFFF
    at = 12 + 16 * n + sum(len(tables[t]) + (-len(tables[t]) % 4) for t in tags[:tags.index("head")]) + 8
    return whole[:at] + struct.pack(">I", adj) + whole[at + 4:]


def _tounicode(pairs: list[tuple[int, int]]) -> bytes:
    lines = ["/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
             "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
             "/CMapName /Adobe-Identity-UCS def", "/CMapType 2 def", "1 begincodespacerange", "<0000> <FFFF>",
             "endcodespacerange"]
    for i in range(0, len(pairs), 100):
        chunk = pairs[i: i + 100]
        lines.append(f"{len(chunk)} beginbfchar")
        for g, u in chunk:
            uh = chr(u).encode("utf-16-be").hex().upper()
            lines.append(f"<{g:04X}> <{uh}>")
        lines.append("endbfchar")
    lines += ["endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"]
    return "\n".join(lines).encode("ascii")


def pdf_objects(w, chars) -> int:
    """Add the Unicode font (a subset of the bundled font with ``chars``) to the PdfWriter ``w``; returns the object
    number of the Type0 font for the page /Font resources."""
    f = font()
    chars = sorted({c for c in chars if ord(c) in f.cmap})
    data = subset(chars)
    ff = w.add(w.stream(f"/Length1 {len(data)}", data))
    s = 1000.0 / f.upem
    bbox = " ".join(str(round(v * s)) for v in f.bbox)
    tag = "AKOWEA"
    desc = w.add((f"<< /Type /FontDescriptor /FontName /{tag}+{NAME} /Flags 34 /FontBBox [{bbox}] /ItalicAngle 0 "
                  f"/Ascent {round(f.ascent * s)} /Descent {round(f.descent * s)} /CapHeight {round(f.cap * s)} "
                  f"/StemV 80 /FontFile2 {ff} 0 R >>").encode("ascii"))
    gids = sorted({f.cmap[ord(c)] for c in chars} | {0})
    wspec = " ".join(f"{g} [{round(f.adv[g] * s)}]" for g in gids)
    cid = w.add((f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{tag}+{NAME} /CIDSystemInfo << /Registry "
                 f"(Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor {desc} 0 R /DW 1000 /W [{wspec}] "
                 "/CIDToGIDMap /Identity >>").encode("ascii"))
    tu = w.add(w.stream("", _tounicode([(f.cmap[ord(c)], ord(c)) for c in chars])))
    return w.add((f"<< /Type /Font /Subtype /Type0 /BaseFont /{tag}+{NAME} /Encoding /Identity-H "
                  f"/DescendantFonts [{cid} 0 R] /ToUnicode {tu} 0 R >>").encode("ascii"))


def metrics() -> dict:
    """{ascent, descent, cap} in 1/1000 em (for the cover's vertical placement)."""
    f = font()
    if not f:
        return {"ascent": 900, "descent": -230, "cap": 700}
    s = 1000.0 / f.upem
    return {"ascent": round(f.ascent * s), "descent": round(f.descent * s), "cap": round(f.cap * s)}
