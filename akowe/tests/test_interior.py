"""🎨 Interior themes (exporters/interior.py): per theme, the PDF has the chapter-opener design (drop cap, ornament,
no header or page number on the opener), the trim size, mirrored margins, the accented letters embedded and every
paragraph readable exactly as written; the EPUB has the heading design, the drop-cap / small-caps classes and the
ornament as generated content (never text); the Word file has a real drop cap, the ornament, running headers and
page numbers. The book profile choices, the gutter growing with the page count, and the preview."""
from __future__ import annotations

import io
import re
import zipfile
from types import SimpleNamespace

import pytest

from akowe import h_checks
from akowe.book_path import clean_profile, get_profile, save_profile
from akowe.errors import AkoweError
from akowe.exporters import book as bookmod
from akowe.exporters import interior
from akowe.exporters.docx import build_docx, inspect_docx
from akowe.exporters.epub import build_epub, inspect_epub
from akowe.exporters.layout import Typography, make_geometry, paginate
from akowe.exporters.pdf import inspect_pdf, render_pdf

META = {"title": "The Salt Road", "author": "Mara Vell", "language": "en", "identifier": "urn:uuid:interior-test",
        "rights": "Copyright 2026 Mara Vell."}
RULES = {"pattern": "Chapter {number}: {title}", "include_number": True}
THEMES = list(interior.THEMES)
CH2 = ("# Ọ̀rọ̀ at the Gate\n“Wait,” said Ọlá, and the gate-keeper waited. Łódź, Ærø and Ðakovo were names on the map.\n"
       + " ".join(["The caravan moved on through the white salt and the long blue afternoon."] * 30) + "\n***\n"
       + "After the break the night was quiet, and the stars were very near.\n"
       + " ".join(["They slept in the lee of the dunes, wrapped in wool against the cold."] * 40))


def nows(s: str) -> str:
    return re.sub(r"\s+", "", s)


def build(theme: str, trim: str = "6x9"):
    th = interior.spec(theme, trim=trim)
    chapters = [{"id": "c1", "text": interior.SAMPLE}, {"id": "c2", "text": CH2}]
    book = bookmod.build_book(META, chapters, title_rules=RULES,
                              front=[{"item_id": "title_page", "title": "The Salt Road", "text": "Mara Vell"}])
    page = interior.trim_page(trim)
    geom = make_geometry(page, interior.margins_for(page, 120))
    lay = paginate(book, geom, Typography("times", 11.0, 14.0), interior=th)
    pdf = render_pdf(lay, page_width=geom.width, page_height=geom.height, meta=META)
    epub = build_epub(book, modified="2026-01-01T00:00:00Z", theme=th)
    docx = build_docx(book, created="2026-01-01T00:00:00Z", theme=th, page=page)
    return SimpleNamespace(th=th, book=book, geom=geom, lay=lay, pdf=pdf, epub=epub, docx=docx, page=page)


@pytest.fixture(scope="module", params=THEMES)
def built(request):
    return build(request.param)


def source_paragraphs(book):
    return [b["text"] for s in book["sections"] for b in s["blocks"] if b["t"] == "p"]


# ------------------------------------------------------------------------------------------------- PDF
def test_pdf_valid_and_passes_the_export_check(built):
    from akowe.autobook import verify_file
    assert inspect_pdf(built.pdf)["errors"] == []
    ok, why = verify_file("PDF", built.pdf)
    assert ok, why


def test_pdf_drop_cap_and_ornaments(built):
    openers = [p for p in built.lay.pages if p.role == "opener" and p.section_kind == "chapter"]
    assert len(openers) == 2
    big = [op for op in openers[0].ops if op[0] == "text" and op[2] > 11 * 2.2 and len(op[5]) <= 2]
    numbered = built.th["number"] in ("digits", "padded", "roman", "circle") and built.th["number_size"] > 2.2
    if built.th["drop_cap"]:
        assert any(op[5] == "T" for op in big), "drop cap missing"
    else:
        assert not [op for op in big if op[5] == "T"] or numbered
    shapes = [op for p in built.lay.pages for op in p.ops if op[0] in ("poly", "circle", "line", "rect")]
    assert shapes, "no ornament drawn"
    # the scene breaks are drawn, never printed as asterisks
    assert not any(op[0] == "text" and op[5].strip() in ("* * *", "***") for p in built.lay.pages for op in p.ops)


def test_pdf_no_header_or_folio_on_openers(built):
    g = built.geom
    for p in built.lay.pages:
        texts = [op for op in p.ops if op[0] == "text"]
        outside = [op for op in texts if op[4] > g.height - g.top + 1 or op[4] < g.bottom - 1]
        if p.role in ("opener", "blank", "title"):
            assert not outside, (p.number, p.role, [op[5] for op in outside])
        elif p.section_kind == "chapter":
            assert any(op[5] == str(p.number) for op in outside), f"page {p.number} has no page number"
            heads = [op for op in outside if op[4] > g.height - g.top]
            assert heads, f"page {p.number} has no running header"
            want = "The Salt Road" if p.number % 2 or built.th["header"] == "title-chapter" else "Mara Vell"
            if built.th["header"] == "title-chapter" and p.number % 2:
                want = p.label
            assert heads[0][9] == want or heads[0][5] == want, (heads[0][5], want)
    blank = [p for p in built.lay.pages if p.role == "blank"]
    if built.th["recto_start"]:
        assert all(p.number % 2 == 0 and not p.ops for p in blank)
        assert all(p.number % 2 == 1 for p in built.lay.pages if p.role == "opener" and p.section_kind == "chapter")


def test_pdf_text_as_written_and_accents_embedded(built):
    import pypdfium2 as pdfium
    rep = inspect_pdf(built.pdf)
    assert "DejaVuSerif" in " ".join(rep["embedded_fonts"])  # ọ, Ł, Ð… set in the bundled Unicode font
    doc = pdfium.PdfDocument(built.pdf)
    g = built.geom
    text = ""
    for i in range(len(doc)):  # body only: the running header and the page number are left out
        page = doc[i]
        w, hgt = page.get_size()
        text += page.get_textpage().get_text_bounded(left=0, bottom=g.bottom - 2, right=w, top=g.height - g.top + 2)
    full, pos = nows(text), 0
    for para in source_paragraphs(built.book):
        j = full.find(nows(para), pos)
        assert j >= 0, para[:60]
        pos = j + len(nows(para))
    assert "Chapter2:Ọ̀rọ̀attheGate" in full or nows("Chapter 2: Ọ̀rọ̀ at the Gate") in full


def test_pdf_mirrored_gutter(built):
    g = built.geom
    left_x = {p.number % 2: min(op[3] for op in p.ops if op[0] == "text" and g.bottom < op[4] < g.height - g.top)
              for p in built.lay.pages if p.role == "" and p.section_kind == "chapter"}
    assert g.left > g.right  # inner margin larger than outer
    assert abs(left_x[1] - g.left) < 0.5 and abs(left_x[0] - g.right) < 0.5


@pytest.mark.parametrize("trim", list(interior.TRIMS))
def test_trim_sizes(trim):
    b = build("classic", trim)
    w, h, _ = interior.TRIMS[trim]
    box = inspect_pdf(b.pdf)["media_boxes"][0]
    assert abs(box[2] - w / 25.4 * 72) < 0.01 and abs(box[3] - h / 25.4 * 72) < 0.01
    doc = zipfile.ZipFile(io.BytesIO(b.docx)).read("word/document.xml").decode()
    assert f'w:w="{int(round(w * 1440 / 25.4))}"' in doc


def test_gutter_grows_with_pages():
    page = interior.trim_page("6x9")
    inner = [interior.margins_for(page, n)["left"] for n in (100, 250, 400, 600, 800)]
    assert inner == sorted(inner) and inner[-1] > inner[0]
    assert all(interior.margins_for(page, n)["left"] > interior.margins_for(page, n)["right"] for n in (100, 800))


def test_numbers():
    assert interior.number_words(7) == "seven" and interior.number_words(42) == "forty-two"
    assert interior.roman(14) == "XIV" and interior.roman(1999) == "MCMXCIX"
    assert interior.number_label(7, interior.THEMES["classic"]) == "CHAPTER SEVEN"
    assert interior.number_label(21, interior.THEMES["romance"]) == "Chapter Twenty-One"
    assert interior.number_label(7, interior.THEMES["scifi"]) == "07"
    assert interior.number_label(7, interior.THEMES["noir"]) == "CHAPTER 7"


def test_widow_orphan_control():
    b = build("classic", "5x8")
    lead = 14.0
    for p in b.lay.pages:
        if p.role:
            continue
        ys = sorted({round(op[4], 2) for op in p.ops if op[0] == "text" and b.geom.bottom < op[4] < b.geom.height
                     - b.geom.top})
        assert len(ys) >= 2 or p is b.lay.pages[-1]
        assert all(round(y2 - y1, 1) >= lead - 0.5 for y1, y2 in zip(ys, ys[1:]))


# ------------------------------------------------------------------------------------------------- EPUB
def test_epub_theme(built):
    assert inspect_epub(built.epub)["errors"] == []
    issues, _ = h_checks.epub_check(built.epub, run_external=False)
    assert not [i for i in issues if i.get("decision") == "FAIL" and i.get("severity") in ("BLOCKING", "MAJOR")]
    z = zipfile.ZipFile(io.BytesIO(built.epub))
    css = z.read("OEBPS/style.css").decode()
    ch = z.read("OEBPS/text/s002.xhtml").decode()
    assert 'class="chapter-head"' in ch and 'class="ch-title">The Lantern Road<' in ch
    assert 'class="first opening"' in ch
    assert '<div class="scene-break" role="separator"' in ch and "* * *" not in ch
    assert "div.scene-break::before" in css and interior.ORNAMENT_TEXT[built.th["scene"]] in css
    assert ("::first-letter" in css) == bool(built.th["drop_cap"])
    from lxml import etree
    paras = []
    for n in sorted(x for x in z.namelist() if x.startswith("OEBPS/text/s")):
        root = etree.fromstring(z.read(n))
        paras += [el.xpath("string()") for el in root.iter("{http://www.w3.org/1999/xhtml}p") if el.get("id")]
    assert paras == source_paragraphs(built.book)  # the ornaments are not text


# ------------------------------------------------------------------------------------------------- Word
def test_docx_theme(built):
    import docx as pydocx
    assert inspect_docx(built.docx)["errors"] == []
    issues, _ = h_checks.docx_check(built.docx)
    assert not [i for i in issues if i.get("decision") == "FAIL" and i.get("severity") in ("BLOCKING", "MAJOR")]
    d = pydocx.Document(io.BytesIO(built.docx))
    styles = [p.style.name for p in d.paragraphs]
    assert ("Drop Cap" in styles) == bool(built.th["drop_cap"])
    breaks = [p.text for p in d.paragraphs if p.style.name == "Scene Break"]
    assert breaks and all(t == interior.ORNAMENT_TEXT[built.th["scene"]] for t in breaks)
    # text as written: a drop cap joins its paragraph again
    paras, carry = [], ""
    for p in d.paragraphs:
        if p.style.name == "Drop Cap":
            carry = p.text
        elif p.style.name in ("Body Text", "First Paragraph"):
            paras.append(carry + p.text)
            carry = ""
    assert paras == source_paragraphs(built.book)
    z = zipfile.ZipFile(io.BytesIO(built.docx))
    names = z.namelist()
    assert "word/header1.xml" in names and "word/footer1.xml" in names
    assert "The Salt Road" in z.read("word/header1.xml").decode()
    assert "PAGE" in z.read("word/footer1.xml").decode()
    doc = z.read("word/document.xml").decode()
    assert doc.count("<w:titlePg/>") >= 2  # no header / number on each chapter's first page
    assert "<w:mirrorMargins/>" in z.read("word/settings.xml").decode()


# ------------------------------------------------------------------------------------------------- choices
def test_profile_choices_and_defaults(h):
    assert interior.chosen({"genre": "Mystery"})["theme"] == "noir"
    assert interior.chosen({"genre": "Literary"})["theme"] == "classic"
    assert interior.chosen({})["trim"] == "6x9"
    with pytest.raises(AkoweError):
        clean_profile({"interior_theme": "gothic"})
    with pytest.raises(AkoweError):
        clean_profile({"trim_size": "4x6"})
    save_profile(h.store, h.project_id, {"title": "T", "genre": "Romance", "interior_theme": "plain",
                                         "trim_size": "a5"})
    c = interior.chosen(get_profile(h.store, h.project_id))
    assert c["theme"] == "plain" and c["theme_default"] == "romance" and c["trim"] == "a5"
    assert interior.for_profile(None) is None  # a book without a profile keeps the plain manuscript layout


def test_preview_spreads(h):
    from akowe import book_design
    save_profile(h.store, h.project_id, {"title": "The Salt Road", "author": "Mara Vell", "genre": "Horror"})
    app = SimpleNamespace(engine=h.engine, store=h.store)
    out = book_design.state(app, h.principal, h.project_id, "main", {"render": ["svg"]})
    pv = out["preview"]
    assert out["chosen"]["theme"] == "horror" and pv["kind"] == "layout_svg" and "real page layout" in pv["honest"]
    assert [s["name"] for s in pv["spreads"]] == ["Chapter opener", "Normal pages"]
    opener = pv["spreads"][0]["pages"][1]
    assert opener["role"] == "opener" and opener["page"] % 2 == 1 and "<svg" in opener["svg"]
    assert all(p["page"] % 2 == 0 for p in (pv["spreads"][0]["pages"][0], pv["spreads"][1]["pages"][0]))
    assert pv["spreads"][1]["pages"][1]["role"] == "text"
    out = book_design.state(app, h.principal, h.project_id, "main", {"theme": ["scifi"], "trim": ["5x8"],
                                                                     "render": ["svg"]})
    assert out["preview"]["page_size_in"] == [5.0, 8.0] and out["preview"]["theme"] == "scifi"
    r = book_design.save(app, h.project_id, {"interior_theme": "scifi", "trim_size": "5x8"})
    assert r["chosen"]["theme"] == "scifi" and r["chosen"]["trim"] == "5x8"
    with pytest.raises(AkoweError):
        book_design.state(app, h.principal, h.project_id, "main", {"theme": ["nope"]})
