"""verify3: EPUBCheck on a book with inline emphasis, images (PNG RGBA + EXIF-rotated JPEG), front/back matter and
non-ASCII text; DOCX/EPUB keep every word of emphasised text."""
from __future__ import annotations

import io
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "export"))
from bf_export_helpers import build_all, epub_blocks, docx_blocks, have_epubcheck, run_epubcheck  # noqa: E402

from bookforge.exporters.images import load_image  # noqa: E402

PIL = pytest.importorskip("PIL.Image")


def _imgs():
    from PIL import Image
    rgba = Image.new("RGBA", (40, 30), (200, 10, 10, 128))
    b = io.BytesIO(); rgba.save(b, "PNG"); p = b.getvalue()
    j = Image.new("RGB", (60, 20), (10, 200, 10))
    exif = Image.Exif(); exif[0x0112] = 6
    b = io.BytesIO(); j.save(b, "JPEG", exif=exif.tobytes()); jj = b.getvalue()
    return {"pic1": (p, load_image(p, "image/png")), "pic2": (jj, load_image(jj, "image/jpeg"))}


CH1 = ("# Chapter One: *The* Café\n\nShe walked *slowly* to the **old** café — naïve, *très* "
       "***chic***.\n\n## A _quiet_ part\n\nNumbers 1 000 and 5 %; soft­hyphen; "
       "escaped \\*stars\\*.\n\n* * *\n\nThe end of **bold *and italic* text**.")
CH2 = "# Zwei\n\nÜber den Straßen, ¿qué? ¡Sí! Œuvre — “quoted” *emphasis at the end*"


@pytest.mark.skipif(not have_epubcheck(), reason="EPUBCheck not installed")
def test_epubcheck_rich_book(tmp_path):
    images = _imgs()
    placements = [{"anchor_id": "ch1-p1", "placement_id": "fig-1", "key": "pic1", "width_mm": 80, "height_mm": 60,
                   "fit": "CONTAIN"},
                  {"anchor_id": "ch2-p1", "placement_id": "fig-2", "key": "pic2", "width_mm": 50, "height_mm": 80,
                   "fit": "CONTAIN"}]
    b = build_all([{"id": "ch1", "text": CH1}, {"id": "ch2", "text": CH2}],
                  front=[{"item_id": "title_page", "title": "Le *Livre*", "text": "Mara Vell\n**Édition** 1"},
                         {"item_id": "dedication", "title": "Für dich", "text": "To *you*, always."},
                         {"item_id": "widmung_für", "title": "Widmung", "text": "Ü"},
                         {"item_id": "समर्पण", "title": "Dedication two", "text": "x"}],
                  back=[{"item_id": "colophon", "title": "Colophon", "text": "Set in _Times_. © 2026"}],
                  placements=placements, images=images)
    rc, msgs = run_epubcheck(b.epub, tmp_path)
    assert rc == 0 and not msgs, msgs
    joined = " ".join(epub_blocks(b.epub))
    for want in ("slowly", "très", "chic", "*stars*", "and italic", "emphasis at the end"):
        assert want in joined
    d = " ".join(docx_blocks(b.docx))
    assert "*stars*" in d and "and italic" in d


def test_own_checks_pass_on_rich_book():
    from bookforge import h_checks
    from bf_export_helpers import PAGE
    images = _imgs()
    placements = [{"anchor_id": "ch1-p1", "placement_id": "fig-1", "key": "pic1", "width_mm": 80, "height_mm": 60,
                   "fit": "COVER"},
                  {"anchor_id": "ch2-p1", "placement_id": "fig-2", "key": "pic2", "width_mm": 50, "height_mm": 80,
                   "fit": "CONTAIN"}]
    b = build_all([{"id": "ch1", "text": CH1}, {"id": "ch2", "text": CH2}],
                  front=[{"item_id": "widmung_für", "title": "Widmung", "text": "*Ü*"}],
                  back=[{"item_id": "colophon", "title": "Colophon", "text": "Set in _Times_."}],
                  placements=placements, images=images)
    bad = [i for i in h_checks.pdf_layout(b.pdf, PAGE, print_profile=False) if i["decision"] == "FAIL"]
    assert not bad, bad
    issues, info = h_checks.docx_check(b.docx)
    assert not [i for i in issues if i["decision"] == "FAIL"], issues
    issues, info = h_checks.epub_check(b.epub, run_external=False)
    assert not [i for i in issues if i["decision"] == "FAIL"], issues
