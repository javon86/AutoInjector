"""Regression tests for the export fix round (beyond the pinned campaign tests): emphasis is rendered in every
format, no-break spaces never become line breaks in the PDF, damaged images fail with plain messages, the image
decode cache, the EPUBCheck locator (BF-22), DOCX heading counts (BF-15) and EPUBCheck on varied books."""
from __future__ import annotations

import io
import zipfile

import pytest

from bf_export_helpers import EPUBCHECK_JAR, META, PAGE, build_all, have_epubcheck, png, random_book, run_epubcheck
from bookforge import h_checks as hc
from bookforge.exporters import book as bookmod
from bookforge.exporters import images as imgmod
from bookforge.exporters.images import UnsupportedImage, load_image

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
XHTML = "{http://www.w3.org/1999/xhtml}"


# ----------------------------------------------------------------------------- emphasis (NEW-export-9)
def test_emphasis_runs_in_book_model():
    _t, blocks = bookmod.parse_chapter("c", "# A *T*\nShe was *very* tired, **angry** and ***both***. a * b, "
                                            "snake_case, \\*literal\\*")
    assert _t == "A T"
    p = blocks[0]
    assert p["text"] == "She was very tired, angry and both. a * b, snake_case, *literal*"
    assert ("very", "i") in p["runs"] and ("angry", "b") in p["runs"] and ("both", "bi") in p["runs"]


def test_emphasis_rendered_in_pdf_epub_docx():
    from lxml import etree
    b = build_all([{"id": "C02-m1", "text": "# T\nShe was *very* tired and **angry**, said _Ann_."}], toc=False)
    # PDF: the emphasised words are set in the italic / bold faces, no markers printed
    ops = [o for p in b.layout.pages for o in p.ops if o[0] == "text"]
    assert any(o[1] == "Times-Italic" and "very" in o[5] for o in ops)
    assert any(o[1] == "Times-Bold" and "angry" in o[5] for o in ops)
    assert not any("*" in o[5] or "_" in o[5] for o in ops)
    # EPUB: <em>/<strong>
    zf = zipfile.ZipFile(io.BytesIO(b.epub))
    root = etree.fromstring(zf.read("OEBPS/text/s001.xhtml"))
    assert [e.text for e in root.iter(f"{XHTML}em")] == ["very", "Ann"]
    assert [e.text for e in root.iter(f"{XHTML}strong")] == ["angry"]
    # DOCX: italic and bold runs
    doc = etree.fromstring(zipfile.ZipFile(io.BytesIO(b.docx)).read("word/document.xml"))
    italic = ["".join(r.itertext()) for r in doc.iter(f"{W}r") if r.find(f"{W}rPr/{W}i") is not None]
    bold = ["".join(r.itertext()) for r in doc.iter(f"{W}r") if r.find(f"{W}rPr/{W}b") is not None]
    assert italic == ["very", "Ann"] and bold == ["angry"]


def test_justified_emphasis_lines_stay_inside_the_text_block():
    from bookforge import h_checks
    text = "# T\n" + " ".join(f"word{i} *slanted{i}* and **heavy{i}**," for i in range(120))
    b = build_all([{"id": "C02-m2", "text": text}], toc=False)
    assert [i for i in h_checks.pdf_layout(b.pdf, PAGE, print_profile=False) if i["decision"] != "PASS"] == []
    g = b.geom
    for p in b.layout.pages:
        for o in p.ops:
            if o[0] == "text":
                assert g.left - 0.01 <= o[3] <= g.width - g.right + 0.01


# ----------------------------------------------------------------------------- no-break spaces (NEW-export-6)
def test_no_break_space_never_splits_a_pdf_line():
    words = " ".join(["Mr. Smith"] * 300)
    b = build_all([{"id": "C02-n2", "text": f"# T\n{words}"}], toc=False)
    for p in b.layout.pages:
        for o in p.ops:
            if o[0] == "text" and o[5] not in ("T",) and not o[5].isdigit():
                assert not o[5].endswith("Mr."), o[5]  # never broken between "Mr." and "Smith"


def test_text_hygiene_choke_point():
    meta = dict(META, title="Bad\x07Title﻿")
    b = bookmod.build_book(meta, [{"id": "C02-h", "text": "# Ti\x00tle\nA\x1bB   é"}],
                           front=[{"item_id": "dedication", "title": "For\x01 you", "text": "x\x0by"}])
    assert b["meta"]["title"] == "BadTitle"
    assert bookmod.all_text(b).count("\x00") == 0 and "é" in bookmod.all_text(b)
    assert b["sections"][0]["heading"] == "For you"


# ----------------------------------------------------------------------------- images (NEW-export-2/11)
def test_damaged_images_have_plain_messages():
    from PIL import Image
    good = png(Image.new("RGB", (20, 10), (1, 2, 3)))
    with pytest.raises(UnsupportedImage, match="empty"):
        load_image(b"")
    flipped = bytearray(good)
    flipped[40] ^= 0xFF  # inside IHDR/IDAT: CRC mismatch
    with pytest.raises(UnsupportedImage, match="checksum|damaged"):
        load_image(bytes(flipped))
    with pytest.raises(UnsupportedImage, match="truncated"):
        load_image(good[:-12])


def test_png_bomb_is_refused_before_inflating(monkeypatch):
    import struct
    import zlib

    def chunk(t, body):
        return struct.pack(">I", len(body)) + t + body + struct.pack(">I", zlib.crc32(t + body) & 0xFFFFFFFF)
    w = h = 20000  # 400 MP of zeros compresses to a few hundred KB
    bomb = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00" * 1000)) + chunk(b"IEND", b""))
    with pytest.raises(UnsupportedImage, match="megapixels"):
        load_image(bomb)


def test_decoded_images_are_cached_by_content():
    from PIL import Image
    data = png(Image.new("RGBA", (30, 20), (9, 8, 7, 100)))
    a = load_image(data)
    assert load_image(data) is a
    assert len(imgmod._cache) <= imgmod._CACHE_ENTRIES


# ----------------------------------------------------------------------------- BF-22: EPUBCheck locator
def test_missing_epubcheck_is_reported_plainly_not_blocking(monkeypatch, tmp_path):
    monkeypatch.delitem(hc.EXTERNAL_VALIDATORS, "epubcheck", raising=False)
    monkeypatch.setenv(hc.EPUBCHECK_ENV, str(tmp_path / "nowhere" / "epubcheck.jar"))
    b = build_all([{"id": "C02-e1", "text": "# T\nHello."}], toc=True, pdf=False)
    issues, info = hc.epub_check(b.epub)
    un = [i for i in issues if i["rule"] == "VALIDATOR_UNAVAILABLE"]
    assert len(un) == 1 and un[0]["severity"] == "MINOR" and un[0]["decision"] == "UNKNOWN"
    assert "not checked by EPUBCheck" in un[0]["message"] and "does not exist" in un[0]["message"]
    assert not any(i["decision"] == "FAIL" for i in issues)


@pytest.mark.skipif(not have_epubcheck(), reason=f"EPUBCheck jar not found at {EPUBCHECK_JAR}")
def test_epubcheck_jar_found_through_setting(monkeypatch):
    monkeypatch.delitem(hc.EXTERNAL_VALIDATORS, "epubcheck", raising=False)
    monkeypatch.setenv(hc.EPUBCHECK_ENV, EPUBCHECK_JAR)
    assert hc.epubcheck_available()
    b = build_all([{"id": "C02-e2", "text": "# T\nHello *there*."}], toc=True,
                  front=[{"item_id": "title_page", "title": "The Salt Road", "text": "Mara Vell"}])
    issues, info = hc.epub_check(b.epub)
    assert info.validator.startswith("EPUBCheck v5"), info.validator
    assert [i for i in issues if i["decision"] != "PASS"] == []


# ----------------------------------------------------------------------------- EPUBCheck on varied books
@pytest.mark.skipif(not have_epubcheck(), reason=f"EPUBCheck jar not found at {EPUBCHECK_JAR}")
@pytest.mark.parametrize("seed", [0, 3])
@pytest.mark.parametrize("toc", [True, False])
def test_random_books_pass_epubcheck(seed, toc, tmp_path):
    from PIL import Image
    chapters = random_book(seed, max_chapters=6, max_paras=8)
    chapters[0]["text"] += "\nShe was *very* tired.\nbad\x01char ￾ and no break"
    data = png(Image.new("RGBA", (40, 30), (200, 10, 10, 128)))
    info = load_image(data)
    b = build_all(chapters, toc=toc, pdf=False, images={"k": (data, info)},
                  front=[{"item_id": "title_page", "title": "The Salt Road", "text": "Mara Vell"}],
                  placements=[{"placement_id": "pl1", "anchor_id": chapters[0]["id"], "key": "k",
                               "width_mm": 80, "height_mm": 60, "fit": "CONTAIN"}])
    rc, msgs = run_epubcheck(b.epub, tmp_path)
    assert rc == 0 and msgs == [], msgs


# ----------------------------------------------------------------------------- BF-15: DOCX headings
def test_docx_check_lists_headings():
    b = build_all([{"id": "C02-d1", "text": "# One\nA.\n## Sub\nB."}, {"id": "C02-d2", "text": "# Two\nC."}],
                  toc=False, pdf=False)
    _issues, info = hc.docx_check(b.docx)
    assert info.headings == ["One", "Sub", "Two"]
