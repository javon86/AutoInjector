"""Shared helpers for the export campaign tests (exporter-level book building + independent readers).

Independent readers: pypdfium2 (PDF text/rendering), lxml (EPUB XHTML), python-docx (DOCX).
External validators are optional: EPUBCheck (java + jar), LibreOffice (soffice), qpdf - tests
that need them skip when they are missing.
"""
from __future__ import annotations

import io
import os
import random
import re
import shutil
import subprocess
import zipfile

from akowe.exporters import book as bookmod
from akowe.exporters.docx import build_docx
from akowe.exporters.epub import build_epub
from akowe.exporters.layout import Typography, make_geometry, paginate
from akowe.exporters.pdf import render_pdf

PAGE = {"width_mm": 152.4, "height_mm": 228.6, "bleed_mm": 0, "safe_margin_mm": 12.7}
META = {"title": "The Salt Road", "author": "Mara Vell", "identifier": "urn:uuid:3f1c2d7e-0000-4000-8000-000000000001",
        "rights": "Copyright 2026 Mara Vell.", "language": "en"}
XHTML = "{http://www.w3.org/1999/xhtml}"
STYLE = {"max_depth": 2, "include_pages": True, "link_targets": True}

_HERE = os.path.dirname(os.path.abspath(__file__))
EPUBCHECK_JAR = os.environ.get("BF_EPUBCHECK_JAR") or os.path.normpath(os.path.join(
    _HERE, "..", "..", "..", "..", "..", "epubcheck-dl", "epubcheck-5.1.0", "epubcheck.jar"))


class Built:
    def __init__(self, book, layout, geom, entries, pdf, epub, docx):
        self.book, self.layout, self.geom, self.entries = book, layout, geom, entries
        self.pdf, self.epub, self.docx = pdf, epub, docx

    def source_blocks(self) -> list[str]:
        """Text of every paragraph/sub-heading in reading order (book model = source after the
        documented whitespace normalisation ' '.join(line.split()))."""
        return [b["text"] for s in self.book["sections"] for b in s["blocks"] if b["t"] in ("p", "h2")]


def build_all(chapters, *, meta=META, toc=True, front=None, back=None, placements=None, images=None, margins=54,
              page=PAGE, typo=None, max_passes=6, pdf=True) -> Built:
    """Same pipeline as G04 -> G07 -> G11/G12/G13 (book model, convergence loop, three writers)."""
    book = bookmod.build_book(meta, chapters, front=front, back=back, placements=placements, toc=toc)
    geom = make_geometry(page, {k: margins for k in ("top", "bottom", "left", "right")})
    t = typo or Typography("times", 11.0, 14.0)
    dims = {k: (i.width, i.height) for k, (_, i) in (images or {}).items()}
    nav = [dict(e, page=None) for e in bookmod.heading_entries(book, 2)] if toc else None
    if not pdf:  # Unicode-only content: the PDF path blocks it (BF-20), EPUB/DOCX must still work
        epub = build_epub(book, modified="2026-01-01T00:00:00Z", toc_entries=nav, images=images)
        docx = build_docx(book, created="2026-01-01T00:00:00Z", toc_entries=nav, images=images, page=page)
        return Built(book, None, geom, nav, None, epub, docx)
    lay = paginate(book, geom, t, images=dims)
    entries = None
    if toc:
        prev = (lay.page_map(), lay.page_count)
        for _ in range(max_passes):
            pm = dict(prev[0])
            entries = [dict(e, page=pm.get(e["heading_id"])) for e in bookmod.heading_entries(book, 2)]
            lay = paginate(book, geom, t, toc_entries=entries, toc_style=STYLE, images=dims)
            cur = (lay.page_map(), lay.page_count)
            if cur == prev:
                break
            prev = cur
        else:
            raise AssertionError("TOC did not converge")
    pdf_bytes = render_pdf(lay, page_width=geom.width, page_height=geom.height, meta=meta,
                     images={k: i for k, (_, i) in (images or {}).items()})
    nav = [dict(e, page=None) for e in entries] if entries else None
    epub = build_epub(book, modified="2026-01-01T00:00:00Z", toc_entries=nav, images=images)
    docx = build_docx(book, created="2026-01-01T00:00:00Z", toc_entries=nav, images=images, page=page)
    return Built(book, lay, geom, entries, pdf_bytes, epub, docx)


# ----------------------------------------------------------------------------- random books
WORDS = ("the tide came in over stones slowly she said gulls wheeled above café roofs while ferry waited "
         "“quoted” it’s don't — – … naïve façade Œuvre ‰ € ™ ½ ¿Qué? ¡Sí! & <tag> ]]> \"dq\" 'sq' x").split()


def random_paragraph(rng: random.Random) -> str:
    r = rng.random()
    if r < 0.04:
        return "Z" * rng.choice([1, 50, 400, 3000])          # one unbroken word, up to many lines
    if r < 0.08:
        return "- list item " + " ".join(rng.choice(WORDS) for _ in range(rng.randint(1, 8)))
    if r < 0.14:
        return "“" + " ".join(rng.choice(WORDS) for _ in range(rng.randint(1, 20))) + ",” she said."
    k = rng.choice([1, 3, 12, 60, 300, 1500])
    return " ".join(rng.choice(WORDS) for _ in range(k))


def random_book(seed: int, *, max_chapters: int = 60, max_paras: int = 25) -> list[dict]:
    rng = random.Random(seed)
    chapters = []
    for c in range(rng.randint(1, max_chapters)):
        lines = []
        if rng.random() < 0.8:
            lines.append("# " + " ".join(rng.choice(WORDS) for _ in range(rng.randint(1, 15))))
        for _ in range(rng.randint(0, max_paras)):
            r = rng.random()
            if r < 0.05:
                lines.append(rng.choice(["***", "* * *", "#"]))
            elif r < 0.1:
                lines.append("## " + random_paragraph(rng)[:80])
            else:
                lines.append(random_paragraph(rng))
        sep = rng.choice(["\n", "\r\n", "\n\n", "\n   \n"])
        chapters.append({"id": f"C02-{seed:04d}{c:04d}aaaa", "text": sep.join(lines)})
    return chapters


# ----------------------------------------------------------------------------- readers
def nows(s: str) -> str:
    return re.sub(r"\s+", "", s)


def in_order(haystack: str, needles: list[str]) -> list[str]:
    """Whitespace-insensitive: every needle present once more, in order. Returns the missing ones."""
    full, pos, missing = nows(haystack), 0, []
    for t in needles:
        j = full.find(nows(t), pos)
        if j < 0:
            missing.append(t[:80])
            continue
        pos = j + len(nows(t))
    return missing


def pdf_pages_text(pdf: bytes, *, bottom: float = 0.0) -> list[str]:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf)
    out = []
    for i in range(len(doc)):
        page = doc[i]
        w, h = page.get_size()
        out.append(page.get_textpage().get_text_bounded(left=0, bottom=bottom, right=w, top=h))
    return out


def pdf_footer_text(pdf: bytes, footer_top: float) -> list[str]:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf)
    out = []
    for i in range(len(doc)):
        page = doc[i]
        w, _ = page.get_size()
        out.append(page.get_textpage().get_text_bounded(left=0, bottom=0, right=w, top=footer_top).strip())
    return out


def epub_blocks(epub: bytes) -> list[str]:
    from lxml import etree
    zf = zipfile.ZipFile(io.BytesIO(epub))
    out = []
    for n in sorted(x for x in zf.namelist() if x.startswith("OEBPS/text/s")):
        root = etree.fromstring(zf.read(n))
        for el in root.iter(f"{XHTML}p", f"{XHTML}h2"):
            if el.get("id"):
                out.append(el.xpath("string()"))
    return out


def docx_blocks(docx: bytes) -> list[str]:
    import docx as pydocx
    d = pydocx.Document(io.BytesIO(docx))
    return [p.text for p in d.paragraphs if p.style.name in ("Body Text", "First Paragraph", "Heading 2")]


# ----------------------------------------------------------------------------- external validators
def have_epubcheck() -> bool:
    return bool(shutil.which("java")) and os.path.isfile(EPUBCHECK_JAR)


def run_epubcheck(data: bytes, tmp_path) -> tuple[int, list[str]]:
    p = tmp_path / "book.epub"
    p.write_bytes(data)
    r = subprocess.run(["java", "-jar", EPUBCHECK_JAR, str(p)], capture_output=True, text=True, timeout=300)
    msgs = [ln for ln in (r.stdout + r.stderr).splitlines() if ln.startswith(("ERROR", "FATAL"))]
    return r.returncode, msgs


def epubcheck_validator(data: bytes):
    """h_checks.EXTERNAL_VALIDATORS hook backed by the real EPUBCheck jar."""
    import tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory() as td:
        rc, msgs = run_epubcheck(data, Path(td))
    return rc == 0 and not msgs, "EPUBCheck 5.1.0", msgs


def png(img) -> bytes:
    b = io.BytesIO()
    img.save(b, "PNG")
    return b.getvalue()


def jpeg(img, **kw) -> bytes:
    b = io.BytesIO()
    img.save(b, "JPEG", **kw)
    return b.getvalue()
