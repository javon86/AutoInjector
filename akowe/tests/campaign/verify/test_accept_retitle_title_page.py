"""ACCEPT-1 (found by the acceptance run, desktop-app/test/verify-acceptance.test.js): after the author changes the
book's title, BookForge marks the format out of date and offers "Make the format again" + "Export my book again".
Following exactly those steps gives files whose METADATA carry the new title but whose visible TITLE PAGE (the first
page of the PDF, the title-page section of the EPUB, the Title paragraph of the DOCX) still prints the OLD title:
the title page is made by G08 (front matter, from the format metadata) during "Put the book together", and that step
is never marked out of date / redone. The book page then says "Your book is made" with no warning."""
from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "flow"))
import flowkit as fk  # noqa: E402

from bookforge.book_path import save_profile  # noqa: E402


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    fk.quiet_provider_sleep(monkeypatch)


def first_page_texts(ex):
    import pypdfium2 as pdfium  # noqa: PLC0415
    pdf = pdfium.PdfDocument(ex["PDF"])
    pdf_p1 = pdf[0].get_textpage().get_text_range()
    z = zipfile.ZipFile(io.BytesIO(ex["EPUB"]))
    opf = next(n for n in z.namelist() if n.endswith(".opf"))
    first = sorted(n for n in z.namelist() if n.endswith(".xhtml") and "/text/" in n)[0]
    epub_p1 = z.read(first).decode("utf-8")
    d = fk.docx_info(ex["DOCX"])
    docx_title = [t for s, t in d["paras"] if s in ("Title", "Subtitle")]
    return pdf_p1, epub_p1, docx_title


def test_retitled_book_title_page_carries_the_new_title(tmp_path):
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    pid = fk.run_book(app)["project_id"]
    old = fk.bp_of(app, pid).title_author()[0]
    save_profile(app.store, pid, {"title": "A Brand New Title", "author": "New Pen"})
    # what the book page offers, in order: make the format again, approve it, export again
    out = fk.bp_of(app, pid).act("setup_format", {})
    assert out["ok"], out
    items = {s["id"]: s for s in out["book"]["steps"]}["format"]["approve"]
    assert fk.bp_of(app, pid).act("approve", {"record_ids": [i["record_id"] for i in items], "author_confirms": True})["ok"]
    st = {s["id"]: s for s in fk.bp_of(app, pid).status()["steps"]}
    if st["assemble"]["state"] != "done":   # (a fix may ask to put the book together again: follow it)
        assert fk.bp_of(app, pid).act("assemble", {})["ok"]
        st = {s["id"]: s for s in fk.bp_of(app, pid).status()["steps"]}
        fk.bp_of(app, pid).act("approve", {"record_ids": [i["record_id"] for i in st["assemble"]["approve"]],
                                           "author_confirms": True})
    out = fk.bp_of(app, pid).act("export", {})
    assert out["ok"], out
    status = fk.bp_of(app, pid).status()
    assert status["next"] in (None, "check") and {s["id"]: s for s in status["steps"]}["export"]["state"] == "done"
    ex = fk.export_files(app, pid)
    # metadata: new (this already works)
    assert fk.epub_info(ex["EPUB"])["meta"]["title"] == ["A Brand New Title"]
    # the page a reader sees first: must be new too
    pdf_p1, epub_p1, docx_title = first_page_texts(ex)
    assert "A Brand New Title" in pdf_p1 and old not in pdf_p1, pdf_p1
    assert "A Brand New Title" in epub_p1 and old not in epub_p1, epub_p1[:400]
    assert docx_title == ["A Brand New Title", "New Pen"], docx_title
