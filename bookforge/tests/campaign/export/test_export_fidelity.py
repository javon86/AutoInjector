"""Content fidelity of the three exporters (property tests at exporter level).

For generated books (1-60 chapters, paragraphs from 1 char to a 3000-char unbroken word, dialogue,
lists, scene breaks, cp1252 typography, XML specials, empty/whitespace chapters) the text read back
with independent readers (pdfium / lxml / python-docx) must contain every paragraph exactly once and
in order, with no truncation at page breaks and no mojibake. Layout invariants are checked on the
same books: nothing outside the content box, continuous page numbers, TOC numbers == heading pages.
"""
from __future__ import annotations

import io
import re
import unicodedata
import zipfile

import pytest

from bf_export_helpers import (META, PAGE, build_all, docx_blocks, epub_blocks, in_order, nows, pdf_pages_text,
                               random_book)
from bookforge import h_checks
from bookforge.exporters import book as bookmod
from bookforge.exporters.epub import inspect_epub
from bookforge.exporters.layout import text_width, unencodable
from bookforge.exporters.pdf import inspect_pdf

SEEDS = list(range(8))


@pytest.fixture(scope="module", params=SEEDS)
def built(request):
    return build_all(random_book(request.param), front=[{"item_id": "title_page", "title": "The Salt Road",
                                                          "text": "Mara Vell"},
                                                         {"item_id": "toc", "title": "Contents", "text": "Contents"}],
                     back=[{"item_id": "colophon", "title": "Colophon", "text": "Set in Times."}])


def test_structural_inspectors_accept(built):
    assert inspect_pdf(built.pdf)["errors"] == []
    assert inspect_epub(built.epub)["errors"] == []


def test_pdf_every_paragraph_once_in_order(built):
    # body text only (exclude the footer band with the page numbers so a paragraph split over a
    # page break is still contiguous)
    pages = pdf_pages_text(built.pdf, bottom=built.geom.bottom - 1)
    text = "".join(pages)
    src = built.source_blocks()
    assert in_order(text, src) == []
    # nothing duplicated: total non-whitespace length of body paragraphs is not exceeded by more than
    # headings/TOC/title page text
    assert len(nows(text)) < len(nows("".join(src))) + len(nows(bookmod.all_text(built.book))) + 10 * len(pages)


def test_pdf_cp1252_roundtrip_no_mojibake(built):
    text = "".join(pdf_pages_text(built.pdf))
    for ch in "“”’—–…€™‰Œ½¿¡éç&<>]\"'":
        if ch in bookmod.all_text(built.book):
            assert ch in text, ch
    assert "�" not in text and "â€" not in text


def test_epub_paragraphs_exact(built):
    assert epub_blocks(built.epub) == built.source_blocks()


def test_docx_paragraphs_exact(built):
    assert docx_blocks(built.docx) == built.source_blocks()


def test_no_text_outside_content_box(built):
    g = built.geom
    bad = []
    for pi, p in enumerate(built.layout.pages, 1):
        for op in p.ops:
            if op[0] != "text":
                continue
            _, font, size, x, y, text, tw = op
            w = text_width(text, font, size) + tw * text.count(" ")
            if x < g.left - 0.01 or x + w > g.width - g.right + 0.01 or y < g.safe - 0.01 or y + size > g.height - g.top + 0.01:
                bad.append((pi, text[:30]))
    assert bad == []
    issues = [i for i in h_checks.pdf_layout(built.pdf, PAGE, print_profile=False)
              if i["decision"] != "PASS" and i["rule_id"] != "BLANK_PAGE"]
    assert issues == []


def test_page_numbers_continuous(built):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(built.pdf)
    feet = []
    for i in range(len(doc)):
        w, _ = doc[i].get_size()
        feet.append(doc[i].get_textpage().get_text_bounded(left=0, bottom=0, right=w,
                                                           top=built.geom.bottom - 1).strip())
    kinds = [p.section_kind for p in built.layout.pages]
    want = ["" if k == "title_page" else str(i) for i, k in enumerate(kinds, 1)]
    assert feet == want


def test_toc_page_numbers_match_rendered_pages(built):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(built.pdf)
    toc_pages = [i for i, p in enumerate(built.layout.pages) if p.section_kind == "toc"]
    toc_text = "\n".join(doc[i].get_textpage().get_text_bounded(left=0, bottom=built.geom.bottom, right=1e4, top=1e4)
                         for i in toc_pages)
    printed = [int(m) for m in re.findall(r"(\d+)\s*$", toc_text, re.M)]
    want = [e["page"] for e in built.entries]
    assert printed[-len(want):] == want
    for e in built.entries:  # the heading really is on the page the TOC names
        page_text = nows(doc[e["page"] - 1].get_textpage().get_text_range())
        assert nows(e["title"])[:40] in page_text, (e["title"][:40], e["page"])
    # and the PDF outline / link destinations land on the same pages
    from pypdf import PdfReader
    r = PdfReader(io.BytesIO(built.pdf))
    flat = []

    def walk(items):
        for it in items:
            if isinstance(it, list):
                walk(it)
            else:
                flat.append((it.title, r.get_destination_page_number(it) + 1))
    walk(r.outline)
    pos = 0
    for e in built.entries:  # outline is in reading order; it also has the title page / Contents items
        while flat[pos][0] != e["title"]:
            pos += 1
        assert flat[pos][1] == e["page"], e["title"][:40]
        pos += 1


def test_epub_nav_and_docx_toc_cover_every_heading(built):
    zf = zipfile.ZipFile(io.BytesIO(built.epub))
    nav = zf.read("OEBPS/nav.xhtml").decode()
    for e in built.entries:
        assert f"#{e['heading_id']}\"" in nav
    import docx as pydocx
    d = pydocx.Document(io.BytesIO(built.docx))
    toc = [p.text for p in d.paragraphs if p.style.name in ("toc 1", "toc 2")]
    assert toc == [e["title"] for e in built.entries]


# ----------------------------------------------------------------------------- targeted fidelity cases
UNICODE_CHAPTER = ("# Ünïcödé 😀 שלום\nArabic مرحبا and emoji 👩‍👩‍👧 and é combining, CJK 漢字.\n"
                   "RTL: עברית text here.\nAmp & lt < gt > ]]> \"' end\nTitle-ish # not a heading")


def test_epub_docx_carry_full_unicode_and_xml_specials():
    b = build_all([{"id": "C02-u1", "text": UNICODE_CHAPTER}, {"id": "C02-empty", "text": ""},
                   {"id": "C02-ws", "text": "  \n\t\n   "}],
                  meta=dict(META, title="Tïtle & <x> 😀 \"q\" ]]>", author="Ä & B " * 200), toc=False, pdf=False)
    src = b.source_blocks()
    assert epub_blocks(b.epub) == src
    assert docx_blocks(b.docx) == src
    from lxml import etree
    zf = zipfile.ZipFile(io.BytesIO(b.epub))
    opf = etree.fromstring(zf.read("OEBPS/content.opf"))
    ns = {"dc": "http://purl.org/dc/elements/1.1/"}
    assert opf.find(".//dc:title", ns).text == "Tïtle & <x> 😀 \"q\" ]]>"
    assert opf.find(".//dc:creator", ns).text == "Ä & B " * 200
    # empty and whitespace-only chapters still get a heading/nav entry and no stray paragraphs
    headings = [s["heading"] for s in b.book["sections"]]
    assert headings == ["Ünïcödé 😀 שלום", "Chapter 2", "Chapter 3"]


def test_pdf_long_titles_and_author_wrap_inside_page():
    long_word = "Supercalifragilistic" * 40
    b = build_all([{"id": "C02-l1", "text": f"# {long_word}\nShort."},
                   {"id": "C02-l2", "text": "# " + "A very long chapter title " * 30 + "\nBody."}],
                  meta=dict(META, title="T" * 2000, author="Author " * 300),
                  front=[{"item_id": "title_page", "title": "Title " * 80, "text": "Author " * 300}])
    assert in_order("".join(pdf_pages_text(b.pdf)), [long_word, "Short.", "Body."]) == []
    issues = [i for i in h_checks.pdf_layout(b.pdf, PAGE, print_profile=False)
              if i["decision"] != "PASS" and i["rule_id"] != "BLANK_PAGE"]
    assert issues == []
    from pypdf import PdfReader
    assert PdfReader(io.BytesIO(b.pdf)).metadata.title == "T" * 2000


def test_giant_unbroken_word_20k_chars_all_formats():
    word = "".join(chr(ord("a") + (i * 7) % 26) for i in range(20000))
    b = build_all([{"id": "C02-g1", "text": f"# Giant\nbefore {word} after\nNext paragraph."}], toc=False)
    pdf_text = "".join(pdf_pages_text(b.pdf, bottom=b.geom.bottom - 1))
    assert in_order(pdf_text, ["before", word, "after", "Next paragraph."]) == []
    assert epub_blocks(b.epub)[0] == f"before {word} after"
    assert docx_blocks(b.docx)[0] == f"before {word} after"


def test_scene_break_markers_and_dialogue():
    text = "# D\n“Hello,” she said.\n***\n'Single' and \"double\" — and… ellipsis.\n* * *\n#\nEnd."
    b = build_all([{"id": "C02-d1", "text": text}], toc=False)
    kinds = [x["t"] for x in b.book["sections"][0]["blocks"]]
    assert kinds == ["p", "break", "p", "break", "break", "p"]
    pdf = "".join(pdf_pages_text(b.pdf))
    assert pdf.count("* * *") == 3 and "“Hello,” she said." in pdf and "ellipsis." in pdf


# ----------------------------------------------------------------------------- known bugs pinned
@pytest.mark.parametrize("ch", ["\x01", "\x08", "\x1b"])
def test_bf06_control_chars_keep_epub_docx_well_formed(ch):
    from lxml import etree
    b = bookmod.build_book(META, [{"id": "C02-c1", "text": f"# T\nbad{ch}char"}])
    from bookforge.exporters.docx import build_docx
    from bookforge.exporters.epub import build_epub
    zf = zipfile.ZipFile(io.BytesIO(build_epub(b, modified="2026-01-01T00:00:00Z")))
    for n in zf.namelist():
        if n.endswith(".xhtml"):
            etree.fromstring(zf.read(n))
    etree.fromstring(zipfile.ZipFile(io.BytesIO(build_docx(b, created="2026-01-01T00:00:00Z"))).read("word/document.xml"))


def test_bf06_noncharacters_keep_epub_well_formed():
    from bookforge.exporters.epub import build_epub
    b = bookmod.build_book(META, [{"id": "C02-c1", "text": "# T\nbad￿char"}])
    assert inspect_epub(build_epub(b, modified="2026-01-01T00:00:00Z"))["errors"] == []


@pytest.mark.xfail(strict=True, reason="BF-20: base-14 WinAnsi fonts only - emoji/CJK/Hebrew block the PDF path")
def test_bf20_pdf_covers_unicode():
    b = bookmod.build_book(META, [{"id": "C02-u1", "text": UNICODE_CHAPTER}])
    assert unencodable(bookmod.all_text(b)) == []


# ----------------------------------------------------------------------------- NEW bugs (xfail strict)
def test_nbsp_preserved():
    text = "# T\nMr. Smith paid 100 € — « Bonjour ! »"
    b = build_all([{"id": "C02-n1", "text": text}], toc=False)
    assert " " in epub_blocks(b.epub)[0] and " " in epub_blocks(b.epub)[0]
    assert " " in docx_blocks(b.docx)[0]


def test_soft_hyphen_not_printed_in_pdf():
    b = build_all([{"id": "C02-s1", "text": "# T\nsuper­cali­fragi­listic word­break here."}],
                  toc=False)
    text = "".join(pdf_pages_text(b.pdf))
    assert "supercalifragilistic" in text.replace("­", "") and "-" not in text


def test_nfd_text_is_pdf_renderable():
    text = unicodedata.normalize("NFD", "# Café\nNaïve façade, crème brûlée.")
    b = bookmod.build_book(META, [{"id": "C02-f1", "text": text}])
    assert unencodable(bookmod.all_text(b)) == []


def test_markdown_emphasis_not_printed_literally():
    b = build_all([{"id": "C02-m1", "text": "# T\nShe was *very* tired and **angry**."}], toc=False)
    assert "*" not in "".join(pdf_pages_text(b.pdf, bottom=b.geom.bottom - 1))
