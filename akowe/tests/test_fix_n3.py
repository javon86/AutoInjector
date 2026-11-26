"""R3 fixes (agent n3): characters the PDF fonts cannot print never stop the book.

A-2-u / F-15-k  an emoji (or another alphabet) in the book's title
E-12.2-q / F-15-j  an emoji the AI writes into a chapter; a stray byte-order mark
F-15-l  letters of other alphabets / a NUL byte typed into a chapter

The PDF alone shows □ for a character no font of the PDF has (invisible junk — BOM, NUL — is just left out), the EPUB
and Word files keep the text as written, and the run leaves a ⚠️ note naming the chapter and how many characters.
"""
from __future__ import annotations

import io

from akowe.exporters import unifont
from akowe.exporters.book import unprintable_lines

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book, steps

WAVE = "\U0001F30A"


class EmojiFake(BookFakeAI):
    """The fake writer: the book title (``title``) and the first chapter it writes (``chapter_add``) as given."""

    def __init__(self, *a, title=None, chapter_add="", **kw):
        super().__init__(*a, **kw)
        self.title, self.chapter_add, self.done = title, chapter_add, False

    def _answer(self, ctx, props, schema):
        kind, out = super()._answer(ctx, props, schema)
        if kind == "profile" and self.title:
            out = dict(out, title=self.title)
        if kind == "C02" and self.chapter_add and not self.done and isinstance(out.get("text"), str):
            self.done = True
            out = dict(out, text=out["text"].replace(". ", ". " + self.chapter_add + " ", 1))
        return kind, out


def _finished_with_every_file(run):
    assert run["status"] == "done", (run.get("problem"), [(s["id"], s["state"]) for s in run["steps"]])
    assert {f["format"] for f in run.get("files") or []} >= {"PDF", "EPUB", "DOCX"} or len(run["files"]) >= 3, \
        run.get("files")


def _notes(run, code="PDF_LETTERS_REPLACED"):
    return [e["message"] for e in run.get("events") or [] if e.get("code") == code]


def test_unifont_replaces_drops_and_lists():
    assert unifont.printable("Sea ﻿" + WAVE + " calm\x00.") == "Sea □ calm."
    assert unifont.uncovered("a﻿\x00" + WAVE + "ọ") == [WAVE]  # junk is dropped, not listed; ọ prints
    assert unifont.replaced_count("书本 " + WAVE) == 3
    segs = unifont.segments("A " + WAVE + " b", "Times-Roman")
    assert segs == [("A ", "Times-Roman"), ("□", unifont.NAME), (" b", "Times-Roman")]
    book = {"meta": {"title": "T"}, "sections": [
        {"id": "c1", "kind": "chapter", "number": 2, "heading": "One", "blocks": [{"t": "p", "text": "x " + WAVE}]}]}
    lines = unprintable_lines(book)
    assert len(lines) == 1 and lines[0].startswith("Chapter 2 has 1 character") and WAVE not in lines[0]


def test_a2u_f15k_emoji_title_does_not_stop_the_book(tmp_path):
    """A-2-u / F-15-k: an emoji title used to stop the book at assemble (G05 BLOCKED, no PDF, EPUB or Word)."""
    app = make_app(tmp_path, fake=EmojiFake(title="The Sea " + WAVE + " Book"))
    run = run_book(app, {"genre": "Mystery", "length": "short_story"})
    _finished_with_every_file(run)
    notes = _notes(run)
    assert notes and "title" in notes[0] and "□" in notes[0] and WAVE not in notes[0]


def test_e122q_f15j_emoji_in_a_chapter_does_not_stop_the_book(tmp_path):
    """E-12.2-q / F-15-j: an emoji the AI writes into a chapter; the PDF shows □, EPUB keeps the emoji."""
    import pypdf
    app = make_app(tmp_path, fake=EmojiFake(chapter_add="The sea was calm " + WAVE + "."))
    run = run_book(app, {"genre": "Mystery", "length": "short_story"})
    _finished_with_every_file(run)
    notes = _notes(run)
    assert len(notes) == 1 and notes[0].startswith("⚠️ Chapter 1 has 1 character"), notes
    assert notes[0] in run.get("check_later", []) or any(notes[0] in str(x) for x in run.get("check_later") or [])
    pdf = next(f for f in run["files"] if f["format"] == "PDF")
    rec = app.store.get_record(run["project_id"], run["branch_id"], pdf["record_id"], pdf["version"])
    text = "".join(p.extract_text() for p in pypdf.PdfReader(io.BytesIO(app.store.read_binary(rec))).pages)
    assert "□" in text and WAVE not in text


def test_f15l_other_alphabets_and_nul_in_a_chapter(tmp_path):
    """F-15-l: Chinese + Hebrew + Hindi words and a NUL typed into a chapter: the book finishes; the NUL is dropped
    and not counted."""
    app = make_app(tmp_path, fake=EmojiFake(chapter_add="海 שלום हि\x00."))
    run = run_book(app, {"genre": "Mystery", "length": "short_story"})
    _finished_with_every_file(run)
    notes = _notes(run)
    assert len(notes) == 1 and "Chapter 1 has 7 character(s)" in notes[0], notes
    assert steps(run)["assemble"]["state"] == "done"
