"""BACK BURNER (parked 2026-11-08 by the user's request): not loaded by the app; see docs/AKOWE_IMPROVEMENT_PLAN.md back-burner list.

📥 Bring in my book (book_import.py): the stdlib readers (.docx built here with zipfile, .odt, .txt, .md, pasted
text), tolerant chapter splitting on messy inputs, the split the author adjusts, the import creating the AUTHOR's
approved chapters (marked "you", no AI call), the Book Bible built from the text with a fake AI (drafts + 🔒 locks
for what is on the page, malformed answers), resume after an interruption / a stop / the budget, and the three
follow-on offers (checks, originality, ✍ continue the book)."""
from __future__ import annotations

import pytest as _pytest_parked  # noqa: E402

pytestmark = _pytest_parked.mark.skip(reason="back burner: feature parked")


import io
import json
import time
import types
import zipfile

import pytest

from akowe import book_import as bi
from akowe import providers as prov_mod
from akowe.book_path import BookPath, get_profile
from akowe.errors import AkoweError
from akowe.jobs import RetryPolicy
from akowe.server import App

from import_fake import BOOK, ImportFake, book_text

PRINCIPAL = "author"


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


@pytest.fixture(autouse=True)
def drafts_dir(tmp_path, monkeypatch):
    d = tmp_path / "drafts"
    d.mkdir()
    monkeypatch.setattr(bi, "temp_dir", lambda: d)
    return d


def make_app(tmp_path, fake=None, second=True):
    app = App(tmp_path / "data", token="t")
    app.engine.providers.secret_path = tmp_path / "secrets.json"
    if fake is not None:
        app.engine.providers.test_adapter = fake
        app.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
        if second:
            app.engine.providers.configure_slot("AI-2", {"adapter_id": "manual", "input_cost_minor_per_mtok": 9000,
                                                         "output_cost_minor_per_mtok": 40000})
    app.assist.retry_policy = RetryPolicy([0.01, 0.02], 5)
    return app


def code_of(exc: AkoweError) -> str:
    return exc.errors[0].get("problem") or exc.code


# ====================================================================== .docx built in the test
def _docx(paras, styles=True, extra=None) -> bytes:
    W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    body = []
    for p in paras:
        if isinstance(p, str):
            p = (None, p)
        style, text = p[0], p[1]
        ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
        if style and style.startswith("outline:"):
            ppr = f'<w:pPr><w:outlineLvl w:val="{style.split(":")[1]}"/></w:pPr>'
        runs = "".join(f'<w:r><w:t xml:space="preserve">{t}</w:t></w:r>' if not t.startswith("<") else t
                       for t in (text if isinstance(text, list) else [text]))
        body.append(f"<w:p>{ppr}{runs}</w:p>")
    doc = f'<?xml version="1.0" encoding="UTF-8"?><w:document {W}><w:body>{"".join(body)}</w:body></w:document>'
    sty = (f'<?xml version="1.0"?><w:styles {W}>'
           '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>'
           '<w:style w:type="paragraph" w:styleId="Kop2"><w:name w:val="heading 2"/></w:style>'
           '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>'
           '<w:style w:type="paragraph" w:styleId="MyChapter"><w:name w:val="My chapter"/>'
           '<w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", doc)
        if styles:
            z.writestr("word/styles.xml", sty)
        for k, v in (extra or {}).items():
            z.writestr(k, v)
    return buf.getvalue()


def test_docx_reader_styles_tracked_changes_and_breaks():
    data = _docx([("Title", "The Salt Road"),
                  ("Heading1", "The Fog"),
                  (None, ["Mara climbed.", "<w:r><w:tab/></w:r>", "She ", "<w:del><w:r><w:delText>never </w:delText>"
                          "</w:r></w:del>", "stopped."]),
                  (None, "* * *"),
                  (None, "The lamp was cold."),
                  ("MyChapter", "The Harbour"),          # a custom style with an outline level = a heading
                  (None, "Boats knocked together."),
                  ("outline:0", "The Reef"),             # a direct outline level
                  (None, "Low tide.")])
    kind, blocks = bi.read_file("salt.docx", data)
    assert kind == "docx"
    texts = [b["text"] for b in blocks]
    assert "Mara climbed.\tShe stopped." in texts  # the tracked deletion is left out
    assert [b["level"] for b in blocks if b["level"] is not None] == [0, 1, 1, 1]
    sp = bi.split_chapters(blocks)
    assert sp["title_guess"] == "The Salt Road"
    assert [c["title"] for c in sp["chapters"]] == ["The Fog", "The Harbour", "The Reef"]
    assert sp["chapters"][0]["text"].split("\n\n") == ["Mara climbed. She stopped.", "* * *", "The lamp was cold."]
    assert all(c["how"].startswith("Heading") for c in sp["chapters"])


def test_docx_heading2_chapters_under_heading1_parts():
    data = _docx([("Heading1", "Part One"), ("Kop2", "Chapter 1"), "A.", ("Kop2", "Chapter 2"), "B.",
                  ("Heading1", "Part Two"), ("Kop2", "Chapter 3"), "C."])
    sp = bi.split_chapters(bi.read_docx(data))
    assert [c["title"] for c in sp["chapters"]] == ["Chapter 1", "Chapter 2", "Chapter 3"]
    assert [c["part"] for c in sp["chapters"]] == ["Part One", "Part One", "Part Two"]


def test_docx_written_by_akowe_reads_back():
    from akowe.exporters import book as bookmod
    from akowe.exporters.docx import build_docx
    meta = {"title": "The Salt Road", "author": "Mara Vell", "identifier": "urn:uuid:1", "language": "en",
            "rights": "c"}
    book = bookmod.build_book(meta, [{"id": "c1", "text": "# One\nThe salt was white.\n\n* * *\n\nThe road."},
                                     {"id": "c2", "text": "# Two\nThe road was long."}], toc=False)
    sp = bi.split_chapters(bi.read_docx(build_docx(book, created="2026-01-01T00:00:00Z")))
    titles = [c["title"] for c in sp["chapters"] if c["kind"] == "chapter"]
    assert titles[-2:] == ["One", "Two"]
    assert "The salt was white." in sp["chapters"][-2]["text"]


@pytest.mark.parametrize("name,data,code", [
    ("book.docx", b"PK\x03\x04 this is not a zip at all", "IMPORT_BAD_FILE"),
    ("book.docx", b"not a zip", "IMPORT_BAD_FILE"),
    ("book.odt", b"plain words", "IMPORT_BAD_FILE"),
    ("book.pdf", b"%PDF-1.4", "IMPORT_UNKNOWN_KIND"),
    ("book.bin", b"\x00\x01\x02binary", "IMPORT_UNKNOWN_KIND"),
    ("empty.txt", b"", "IMPORT_EMPTY"),
])
def test_bad_files_are_refused_in_plain_words(name, data, code):
    with pytest.raises(AkoweError) as ei:
        bi.read_file(name, data)
    assert code_of(ei.value) == code and ei.value.errors[0]["fix"]


def test_docx_without_document_or_with_broken_xml():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/other.xml", "<x/>")
    with pytest.raises(AkoweError) as ei:
        bi.read_file("a.docx", buf.getvalue())
    assert code_of(ei.value) == "IMPORT_BAD_FILE"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", "<w:document><unclosed>")
    with pytest.raises(AkoweError) as ei:
        bi.read_file("a.docx", buf.getvalue())
    assert code_of(ei.value) == "IMPORT_BAD_FILE"


def test_huge_file_and_whitespace_only(monkeypatch):
    monkeypatch.setattr(bi, "MAX_FILE", 100)
    with pytest.raises(AkoweError) as ei:
        bi.read_file("big.txt", b"x" * 101)
    assert code_of(ei.value) == "IMPORT_TOO_LARGE"
    with pytest.raises(AkoweError) as ei:
        bi.new_draft("blank.txt", "txt", bi.read_text("   \n\n  \n"))
    assert code_of(ei.value) == "IMPORT_EMPTY"
    with pytest.raises(AkoweError) as ei:
        bi.read_pasted("   ")
    assert code_of(ei.value) == "IMPORT_EMPTY"


def test_odt_reader():
    content = ('<?xml version="1.0"?><office:document-content '
               'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
               'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>'
               '<text:h text:outline-level="1">Chapter One</text:h><text:p>Mara<text:s text:c="2"/>walked '
               '<text:span>fast</text:span>.</text:p><text:h text:outline-level="1">Chapter Two</text:h>'
               '<text:p>The end.</text:p></office:text></office:body></office:document-content>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mimetype", "application/vnd.oasis.opendocument.text")
        z.writestr("content.xml", content)
    kind, blocks = bi.read_file("b.odt", buf.getvalue())
    assert kind == "odt"
    sp = bi.split_chapters(blocks)
    assert [c["title"] for c in sp["chapters"]] == ["Chapter One", "Chapter Two"]
    assert sp["chapters"][0]["text"] == "Mara walked fast."


def test_text_readers_encodings_and_line_styles():
    # blank-line paragraphs with wrapped lines; a UTF-8 BOM
    t = "﻿Chapter 1\n\nMara walked\ninto the fog.\n\nShe stopped.\n\nChapter 2\n\nThe end.\n"
    blocks = bi.read_file("a.txt", t.encode("utf-8"))[1]
    assert [b["text"] for b in blocks] == ["Chapter 1", "Mara walked into the fog.", "She stopped.", "Chapter 2",
                                           "The end."]
    # one paragraph per line (no blank lines), Windows-1252 quotes
    t2 = "CHAPTER ONE\r\nShe said “hello”.\r\nCHAPTER TWO\r\nBye.\r\n".encode("cp1252")
    sp = bi.split_chapters(bi.read_file("b.txt", t2)[1])
    assert [c["title"] for c in sp["chapters"]] == ["CHAPTER ONE", "CHAPTER TWO"]
    assert "“hello”" in sp["chapters"][0]["text"]
    # Markdown: # and setext headings, *** scene breaks
    md = "# My Book\n\nIntro.\n\n## The Fog\n\nMara.\n\n***\n\nMore.\n\nThe Reef\n--------\n\nLow tide.\n"
    kind, blocks = bi.read_file("c.md", md.encode())
    assert kind == "md"
    sp = bi.split_chapters(blocks)
    assert [c["title"] for c in sp["chapters"] if c["kind"] == "chapter"] == ["The Fog", "The Reef"]
    assert sp["chapters"][-2]["text"] == "Mara.\n\n* * *\n\nMore."
    # pasted text: Markdown headings are understood, plain text too
    assert [b["level"] for b in bi.read_pasted("# One\n\nText.") if b["level"]] == [1]


# ====================================================================== chapter splitting on messy inputs
def _split(text: str) -> dict:
    return bi.split_chapters(bi.read_text(text))


def test_messy_headings_chapter_words_numbers_prologue_epilogue():
    text = ("THE LIGHTHOUSE\n\nby Jane Doe\n\nPrologue\n\nLong ago the light went out.\n\nCHAPTER ONE\n\nThe Fog\n\n"
            "Mara climbed the steps.\n\n#\n\nShe looked out.\n\nChapter 2: The Harbour\n\nBoats.\n\nCh. 3 - The Reef\n\n"
            "Low tide.\n\nChapter Four\n\nChapter Five\n\nThe lamp blazed.\n\nEpilogue\n\nYears later.")
    sp = _split(text)
    titles = [c["title"] for c in sp["chapters"] if c["include"]]
    assert titles == ["Prologue", "CHAPTER ONE: The Fog", "Chapter 2: The Harbour", "Ch. 3 - The Reef",
                      "Chapter Five", "Epilogue"]
    assert sp["title_guess"] == "THE LIGHTHOUSE"
    front = [c for c in sp["chapters"] if c["kind"] == "front"]
    assert front and not front[0]["include"] and "Jane Doe" in front[0]["text"]  # short front matter set aside
    assert any("Chapter Four" in w for w in sp["warnings"])  # an empty heading is left out, with a warning
    one = next(c for c in sp["chapters"] if c["title"].startswith("CHAPTER ONE"))
    assert one["text"] == "Mara climbed the steps.\n\n* * *\n\nShe looked out."  # "#" is a scene break


def test_numbered_and_roman_headings_only_in_sequence():
    sp = _split("1.\n\nFirst.\n\n2.\n\nSecond.\n\n3. The Reef\n\nThird.")
    assert [c["title"] for c in sp["chapters"]] == ["1.", "2.", "3. The Reef"]
    sp = _split("I\n\nOne.\n\nII\n\nTwo.\n\nIII\n\nThree.")
    assert [c["title"] for c in sp["chapters"]] == ["I", "II", "III"]
    # a lone list item in prose is not a chapter
    sp = _split("She wrote a list.\n\n1. Buy rope\n\nThen she left the house and walked to the harbour.")
    assert len(sp["chapters"]) == 1 and "1. Buy rope" in sp["chapters"][0]["text"]


def test_parts_alone_are_chapters_and_with_chapters_are_parts():
    sp = _split("Part One\n\nA.\n\nPart Two\n\nB.")
    assert [c["title"] for c in sp["chapters"]] == ["Part One", "Part Two"]
    sp = _split("Part One\n\nChapter 1\n\nA.\n\nChapter 2\n\nB.\n\nPart Two\n\nChapter 3\n\nC.")
    assert [(c["title"], c["part"]) for c in sp["chapters"]] == [("Chapter 1", "Part One"), ("Chapter 2", "Part One"),
                                                                ("Chapter 3", "Part Two")]


def test_no_headings_cuts_parts_and_warns(monkeypatch):
    monkeypatch.setattr(bi, "PART_WORDS", 50)
    text = "\n\n".join(f"Paragraph {i} " + "word " * 20 for i in range(12))
    sp = _split(text)
    assert len(sp["chapters"]) >= 3 and all(c["how"].startswith("no headings") for c in sp["chapters"])
    assert sp["warnings"] and "No chapter headings" in sp["warnings"][0]
    assert sum(c["words"] for c in sp["chapters"]) == bi.count_words(text)
    sp = _split("Just one short paragraph of a story.")
    assert len(sp["chapters"]) == 1 and "No chapter headings" in sp["warnings"][0]


def test_long_opening_before_first_heading_is_kept():
    text = "Opening " + "word " * 400 + "\n\nChapter 1\n\nA."
    sp = _split(text)
    assert sp["chapters"][0]["kind"] == "front" and sp["chapters"][0]["include"]


def test_guess_names():
    g = bi.guess_names(book_text())
    assert g["main_character"] == "Mara Vell" and g["main_place"] == "Gullhaven"


# ====================================================================== the split the author adjusts
def test_draft_adjust_merge_split_rename_include(drafts_dir):
    drafts = bi.Drafts()
    d = drafts.save(bi.new_draft("book.txt", "txt", bi.read_text(book_text())))
    assert (drafts_dir / f"{d['id']}.json").is_file()
    assert oct((drafts_dir / f"{d['id']}.json").stat().st_mode)[-3:] == "600"
    pub = bi.public_draft(d)
    assert pub["chapter_count"] == 3 and pub["ai_calls"]["total"] >= 4
    bi.edit_draft(d, {"op": "rename", "index": 0, "title": "  The   Fog  "})
    assert d["chapters"][0]["title"] == "The Fog"
    bi.edit_draft(d, {"op": "merge", "index": 1})
    assert len(d["chapters"]) == 2 and "* * *" in d["chapters"][1]["text"]
    paras = bi.paragraphs_of(d, 1)
    at = next(p["at"] for p in paras if p["start"].startswith("At low tide"))
    bi.edit_draft(d, {"op": "split", "index": 1, "at": at, "title": "The Reef"})
    assert [c["title"] for c in d["chapters"]] == ["The Fog", "Chapter Two: The Harbour", "The Reef"]
    assert d["chapters"][2]["text"].startswith("At low tide")
    bi.edit_draft(d, {"op": "include", "index": 2, "include": False})
    assert bi.public_draft(d)["chapter_count"] == 2
    for bad in ({"op": "merge", "index": 2}, {"op": "split", "index": 0, "at": 0}, {"op": "rename", "index": 0},
                {"op": "zap", "index": 0}, {"op": "rename", "index": 9, "title": "x"}):
        with pytest.raises(AkoweError):
            bi.edit_draft(d, bad)
    with pytest.raises(AkoweError) as ei:
        drafts.load("imp-0000000000000000")
    assert code_of(ei.value) == "IMPORT_DRAFT_GONE"
    with pytest.raises(AkoweError):
        drafts.load("../../etc/passwd")


# ====================================================================== create the book
def _import(app, text=None, **body) -> dict:
    d = bi.new_draft("book.txt", "txt", bi.read_text(text or book_text()))
    return bi.create_book(app, PRINCIPAL, d, dict({"author_confirms": True, "main_character": "Mara Vell",
                                                   "main_place": "Gullhaven"}, **body))


def test_create_makes_author_approved_chapters_without_any_ai_call(tmp_path):
    fake = ImportFake()
    app = make_app(tmp_path, fake)
    out = _import(app, title="The Light", author="Jane Doe")
    pid = out["project_id"]
    assert out["chapters"] == 3 and not fake.calls  # no AI call at all while the book was created
    from akowe.fact_checks import book_texts
    chs = book_texts(app.engine, PRINCIPAL, pid, "main")
    assert [c["approved"] for c in chs] == [True, True, True]
    bp = BookPath(app.engine, PRINCIPAL, pid, "main")
    for c, (title, paras) in zip(chs, BOOK):
        rec = bp.rec(c["record_id"], c["version"])
        assert app.review.made_by(pid, "main", rec, {})["kind"] == "you"
        assert c["text"] == f"# {title.split(': ', 1)[1]}\n\n" + "\n\n".join(paras)
        # the end-of-book passes and the run's redo logic treat these as the author's own text
        assert app.autobook._ai_made({"id": "r", "made": {}, "project_id": pid, "branch_id": "main"}, rec) is False
    prof = get_profile(app.store, pid)
    assert prof["title"] == "The Light" and prof["author"] == "Jane Doe" and prof["ai_slot"] == ""
    assert prof["chapters"] == 3 and prof["length"] == "short_story"
    meta = bi.meta_of(app.store, pid, "main")
    assert meta["author_chapters"] == ["ch1", "ch2", "ch3"] and meta["source"] == "book.txt"
    assert bi.author_chapter_ids(app.store, pid, "main") == ["ch1", "ch2", "ch3"]
    st = bp.status()
    assert {s["id"]: s for s in st["steps"]}["chapters"]["state"] == "done"
    assert app.store.project(pid)["name"] == "The Light"


def test_create_needs_the_authors_ok_and_a_ticked_chapter(tmp_path):
    app = make_app(tmp_path)
    d = bi.new_draft("book.txt", "txt", bi.read_text(book_text()))
    with pytest.raises(AkoweError):
        bi.create_book(app, PRINCIPAL, d, {})
    for c in d["chapters"]:
        c["include"] = False
    with pytest.raises(AkoweError) as ei:
        bi.create_book(app, PRINCIPAL, d, {"author_confirms": True})
    assert code_of(ei.value) == "IMPORT_EMPTY"


def test_a_failed_create_leaves_no_half_book(tmp_path, monkeypatch):
    app = make_app(tmp_path)
    before = {p["project_id"] for p in app.store.projects_for(PRINCIPAL)}
    real = BookPath.approve_ref

    def refuse_outline(self, ref):
        if ref["module_id"] == "B11":
            return {"record_id": ref["record_id"], "ok": False, "problems": ["refused"]}
        return real(self, ref)
    monkeypatch.setattr(BookPath, "approve_ref", refuse_outline)
    with pytest.raises(AkoweError) as ei:
        _import(app)
    assert code_of(ei.value) == "IMPORT_FAILED"
    now = {p["project_id"] for p in app.store.projects_for(PRINCIPAL)
           if not app.store.project(p["project_id"]).get("archived")}
    assert now == before


def test_storing_the_chapters_stops_and_goes_on(tmp_path, monkeypatch):
    app = make_app(tmp_path)
    real = BookPath.approve_ref
    seen = {"n": 0}

    def flaky(self, ref):
        if ref["module_id"] == "C02":
            seen["n"] += 1
            if seen["n"] == 2:
                return {"record_id": ref["record_id"], "ok": False, "problems": ["refused"]}
        return real(self, ref)
    monkeypatch.setattr(BookPath, "approve_ref", flaky)
    with pytest.raises(AkoweError) as ei:
        _import(app)
    assert code_of(ei.value) == "IMPORT_FAILED"
    pid = next(p["project_id"] for p in app.store.projects_for(PRINCIPAL)
               if (bi.meta_of(app.store, p["project_id"], "main") or {}).get("create"))
    st = bi.status(app, PRINCIPAL, pid, "main")
    assert st["create"]["status"] == "failed" and st["create"]["done"] == 1 and "▶ Go on" in st["create"]["message"]
    with pytest.raises(AkoweError):  # no Book Bible before every chapter is in
        bi.service_of(app).start(PRINCIPAL, pid, "main", {})
    monkeypatch.setattr(BookPath, "approve_ref", real)
    app.route("POST", f"/api/projects/{pid}/branches/main/import/create/resume", {}, None, PRINCIPAL, {})
    _wait_created(app, pid)
    from akowe.fact_checks import book_texts
    chs = book_texts(app.engine, PRINCIPAL, pid, "main")
    assert [c["approved"] for c in chs] == [True, True, True]  # the second chapter was not made twice
    assert len(app.store.list_records(pid, "main", module_id="C02")) <= 4
    assert app.store.get_setting(bi.PENDING_KEY.format(pid=pid, branch="main")) is None


def _wait_created(app, pid, timeout=60):
    t = time.time()
    while time.time() - t < timeout:
        cr = bi.status(app, PRINCIPAL, pid, "main")["create"]
        if not cr.get("running"):
            return cr
        time.sleep(0.02)
    return bi.status(app, PRINCIPAL, pid, "main")["create"]


def test_routes_read_adjust_create(tmp_path):
    app = make_app(tmp_path)
    data = _docx([("Heading1", "One"), "Mara Vell walked in Gullhaven.", ("Heading1", "Two"), "Mara slept."])
    st, d = app.route("POST", "/api/import/read", {}, data, PRINCIPAL, {"X-Filename": "my book.docx",
                                                                       "Content-Type": "application/octet-stream"})
    assert st == 201 and d["chapter_count"] == 2 and d["title_guess"] == "my book" and d["kind"] == "docx"
    st, d2 = app.route("PUT", f"/api/import/{d['draft_id']}", {}, {"op": "rename", "index": 1, "title": "Sleep"},
                       PRINCIPAL, {})
    assert d2["chapters"][1]["title"] == "Sleep"
    st, ps = app.route("GET", f"/api/import/{d['draft_id']}/chapter/0", {}, None, PRINCIPAL, {})
    assert ps["paragraphs"][0]["start"].startswith("Mara Vell")
    st, out = app.route("POST", f"/api/import/{d['draft_id']}/create", {},
                        {"author_confirms": True, "title": "Walks"}, PRINCIPAL, {})
    assert st == 201 and out["chapters"] == 2 and out["creating"]
    assert _wait_created(app, out["project_id"])["status"] == "done"
    with pytest.raises(AkoweError):  # the split is gone once the book is made
        app.route("GET", f"/api/import/{d['draft_id']}", {}, None, PRINCIPAL, {})
    st, info = app.route("GET", f"/api/projects/{out['project_id']}/branches/main/import", {}, None, PRINCIPAL, {})
    assert info["imported"] and [c["title"] for c in info["chapters"]] == ["One", "Sleep"]
    st, d = app.route("POST", "/api/import/read", {}, {"text": "Chapter 1\n\nHello there."}, PRINCIPAL,
                      {"Content-Type": "application/json"})
    assert d["kind"] == "paste" and d["chapter_count"] == 1


# ====================================================================== 📖 the Book Bible from the text
def _wait(svc, pid, timeout=60):
    t = time.time()
    while svc.alive(pid, "main") and time.time() - t < timeout:
        time.sleep(0.02)
    return svc.public(pid, "main")


def _book(tmp_path, fake=None, **kw):
    fake = fake or ImportFake()
    app = make_app(tmp_path, fake, **kw)
    pid = _import(app)["project_id"]
    return app, fake, pid, bi.service_of(app)


def test_bible_build_drafts_and_locks_on_page_facts(tmp_path):
    app, fake, pid, svc = _book(tmp_path)
    svc.start(PRINCIPAL, pid, "main", {})
    st = _wait(svc, pid)
    assert st["status"] == "done", st
    kinds = [c["kind"] for c in fake.calls]
    assert kinds.count("track") == 3 and kinds.count("rules") == 1 and "details" in kinds
    s = st["summary"]
    assert s["chapters_read"] == 3 and s["timeline"] == 3 and s["links"] == 1 and s["links_locked"] == 1
    assert s["characters"] == 2 and s["places"] == 1 and s["items"] == 1 and s["rules"] == 2
    from akowe import characters as chars_mod
    from akowe import forge, story_details, story_ledger
    from akowe.checkpoints import _locked
    names = {c["name"]: c for c in chars_mod.canon_characters(app.store, pid, "main")}
    assert {"Mara Vell", "Tom Reed", "Nessa Crane"} <= set(names)
    assert not names["Tom Reed"]["approved"]  # new characters are drafts for the author
    mara = names["Mara Vell"]["record_id"]
    led = story_details.ledger(app.store, pid, "main")["locked"][f"character:{mara}"]
    assert set(led) == {"eyes", "relationship_1"}  # quotes really on the page
    assert led["eyes"]["quote"] == "Her green eyes stung in the salt wind." and led["eyes"]["chapter"] == "ch1"
    flds = forge.raw_entry(app.store, pid, "main", mara)["fields"]
    assert flds["eyes"]["protected"] and flds["eyes"]["status"] == "approved"
    assert flds["hair"]["status"] == "proposed" and not flds["hair"]["protected"]  # its quote is not in the book
    assert flds["wants"]["status"] == "proposed"
    assert any("Green." in x for x in _locked(app.store, pid, "main"))
    assert len(story_ledger.get_all(app.store, pid, "main")["chapters"]) == 3
    from akowe import story_rules
    e = story_rules.get_entry(app.store, pid, "main")  # the rules wait as proposals for the author
    assert story_rules.active(e) == [] and [i["action"] for i in e["proposals"]["items"]] == ["add", "add"]


def test_bible_build_survives_malformed_ai_answers(tmp_path):
    fake = ImportFake()
    fake.malformed = True
    app, fake, pid, svc = _book(tmp_path, fake)
    svc.start(PRINCIPAL, pid, "main", {})
    st = _wait(svc, pid)
    assert st["status"] == "done", st
    s = st["summary"]
    assert s["details_proposed"] <= 1 and s["details_locked"] == 0 and s["links"] == 0  # a bare string value is OK
    assert s["chapters_read"] == 3  # Akọwe's own reading is kept when the AI's answer is junk
    from akowe import story_rules
    assert story_rules.active(story_rules.get_entry(app.store, pid, "main")) == []
    assert st["rules"] == {"failed": "INTERNAL_ERROR"}


def test_accept_details_ignores_junk():
    svc = bi.BibleBuild(types.SimpleNamespace(store=None))
    for raw in (None, "x", {"fields": "x"}, {"fields": {"eyes": 3, "zzz": {"value": "a", "quote": ""}}}):
        assert svc.accept_details("p", "main", {"record_id": "r", "name": "M"}, raw, "", []) == ([], [])


def test_bible_build_resumes_after_interruption_stop_and_busy_ai(tmp_path, monkeypatch):
    fake = ImportFake()
    fake.fail_kind["track"] = ["UPSTREAM_UNAVAILABLE", "UPSTREAM_UNAVAILABLE", "UPSTREAM_UNAVAILABLE"]
    app, fake, pid, svc = _book(tmp_path, fake, second=False)
    # 1. a stop after the chapters were read (the cast step is cancelled)
    from akowe.assist import Cancelled
    real_cast = bi.BibleBuild._s_cast
    calls = {"n": 0}

    def cast_once(self, job, p, b):
        calls["n"] += 1
        if calls["n"] == 1:
            raise Cancelled()
        return real_cast(self, job, p, b)
    monkeypatch.setattr(bi.BibleBuild, "_s_cast", cast_once)
    svc.start(PRINCIPAL, pid, "main", {})
    st = _wait(svc, pid)
    assert st["status"] == "stopped" and st["read_done"] == ["ch1", "ch2", "ch3"]
    assert st["read_weak"] == ["ch1"]  # the busy AI: Akọwe's own reading for now, read again later
    tracks = [c for c in fake.calls if c["kind"] == "track"]
    # 2. Akọwe restarted while it was "running": the page says interrupted
    svc._put(pid, "main", status="running")  # noqa: SLF001
    svc._jobs.clear()  # noqa: SLF001
    assert svc.public(pid, "main")["status"] == "interrupted"
    # 3. ▶ Go on: the chapters already read are not read again — only the weak one
    svc.start(PRINCIPAL, pid, "main", {})
    st = _wait(svc, pid)
    assert st["status"] == "done", st
    new_tracks = [c for c in fake.calls if c["kind"] == "track"][len(tracks):]
    assert len(new_tracks) == 1 and st["read_weak"] == []
    assert st["summary"]["characters"] >= 1


def test_bible_build_budget_stops_and_goes_on(tmp_path):
    app, fake, pid, svc = _book(tmp_path)
    svc.start(PRINCIPAL, pid, "main", {"max_calls": 2})
    st = _wait(svc, pid)
    assert st["status"] == "stopped" and st["stopped_reason"] == "budget" and len(st["read_done"]) == 2
    svc.start(PRINCIPAL, pid, "main", {})
    st = _wait(svc, pid)
    assert st["status"] == "done" and [c["kind"] for c in fake.calls].count("track") == 3
    with pytest.raises(AkoweError):
        svc.start(PRINCIPAL, pid, "main", {"max_calls": 0})


def test_bible_routes_and_ai_activity(tmp_path):
    app, fake, pid, svc = _book(tmp_path)
    base = f"/api/projects/{pid}/branches/main/import"
    st, j = app.route("POST", base + "/bible", {}, {}, PRINCIPAL, {})
    assert st == 202 and j["kind"] == "book_import"
    _wait(svc, pid)
    st, info = app.route("GET", base, {}, None, PRINCIPAL, {})
    assert info["bible"]["status"] == "done" and info["bible"]["summary"]["line"].startswith("Book Bible built")
    other = app.engine.bootstrap_project(PRINCIPAL, "Not imported")
    with pytest.raises(AkoweError):
        app.route("POST", f"/api/projects/{other}/branches/main/import/bible", {}, {}, PRINCIPAL, {})
    assert app.route("GET", f"/api/projects/{other}/branches/main/import", {}, None, PRINCIPAL, {})[1] == \
        {"imported": False}


# ====================================================================== the three offers
LONG = "\n\n".join(f"Chapter {i}\n\n" + " ".join(
    f"Mara Vell walked the long harbour road of Gullhaven on day {i}, counting the boats and the gulls, and thinking "
    f"of the keeper's brass locket number {k}." for k in range(12)) for i in range(1, 5))


def test_offer_checks_and_originality_work_on_the_authors_chapters(tmp_path):
    fake = ImportFake()
    app = make_app(tmp_path, fake)
    pid = _import(app, LONG)["project_id"]
    st, cn = app.route("GET", f"/api/projects/{pid}/branches/main/review/continuity/check-now", {}, None,
                       PRINCIPAL, {})
    assert cn["can_start"] and cn["chapters"] == 4
    st, orig = app.route("GET", f"/api/projects/{pid}/branches/main/originality", {}, None, PRINCIPAL, {})
    assert st == 200 and orig


def test_offer_continue_style_plan_and_use(tmp_path):
    fake = ImportFake()
    app = make_app(tmp_path, fake)
    pid = _import(app, LONG)["project_id"]
    base = f"/api/projects/{pid}/branches/main/import"
    with pytest.raises(AkoweError):  # never without the author's OK
        app.route("POST", base + "/style", {}, {}, PRINCIPAL, {})
    st, out = app.route("POST", base + "/style", {}, {"author_confirms": True}, PRINCIPAL, {})
    assert "learned your style" in out["message"]
    from akowe import style_card
    assert (style_card.book_entry(app.store, pid) or {}).get("on")
    card = style_card.author_card(app.store, PRINCIPAL)
    assert len(card["samples"]) == 4 and card["samples"][0]["text"].startswith("Mara Vell")
    with pytest.raises(AkoweError) as ei:  # samples exist: replacing them needs a second OK
        app.route("POST", base + "/style", {}, {"author_confirms": True}, PRINCIPAL, {})
    assert ei.value.code == "VERSION_CONFLICT"
    st, j = app.route("POST", base + "/continue/plan", {}, {"chapters": 2, "note": "the locket opens"}, PRINCIPAL, {})
    t = time.time()
    while app.review.get_job(PRINCIPAL, j["job_id"])["status"] in ("queued", "running") and time.time() - t < 30:
        time.sleep(0.02)
    plan = bi.meta_of(app.store, pid, "main")["plan"]
    assert plan["from"] == 5 and len(plan["chapters"]) == 2
    with pytest.raises(AkoweError):
        app.route("POST", base + "/continue/use", {}, {"chapters": plan["chapters"]}, PRINCIPAL, {})
    edited = [dict(plan["chapters"][0], objective="Mara opens the locket."), plan["chapters"][1]]
    st, out = app.route("POST", base + "/continue/use", {}, {"author_confirms": True, "chapters": edited},
                        PRINCIPAL, {})
    assert out["chapters"] == 6 and out["new"] == 2
    bp = BookPath(app.engine, PRINCIPAL, pid, "main")
    chs = bp.outline_chapters(bp.outline())
    assert len(chs) == 6 and chs[4]["objective"] == "Mara opens the locket."
    from akowe.fact_checks import book_texts
    texts = book_texts(app.engine, PRINCIPAL, pid, "main")
    assert [c["chapter_id"] for c in texts] == ["ch1", "ch2", "ch3", "ch4"] and all(c["approved"] for c in texts)
    for c in texts:  # the author's chapters keep their text and stay theirs
        assert app.review.made_by(pid, "main", bp.rec(c["record_id"], c["version"]), {})["kind"] == "you"
        assert c["text"].startswith("Mara Vell walked") or c["text"].startswith("# ")
    assert get_profile(app.store, pid)["chapters"] == 6
    steps = {s["id"]: s for s in bp.status()["steps"]}
    assert [c["chapter_id"] for c in steps["chapters"]["chapters"] if not c.get("approved")] == ["ch5", "ch6"]
    info = app.route("GET", base, {}, None, PRINCIPAL, {})[1]
    assert info["continued"]["to"] == 6 and info["plan"] is None


def test_clean_plan_drops_junk():
    assert bi.clean_plan({"chapters": [{"title": 3}, "x", {"objective": ""}, {"objective": "Go.", "title": ""}]},
                         5) == [{"title": "Go.", "objective": "Go."}]
    assert bi.clean_plan("junk", 3) == []
    _ = json


def test_a_120k_word_book_splits_fast_and_budgets_its_ai_calls():
    para = ("Mara Vell walked the long harbour road of Gullhaven, counting the boats and the gulls, and thinking of the "
            "keeper's brass locket and the light. ") * 3
    text = "\n\n".join(f"Chapter {i}\n\n" + "\n\n".join(para for _ in range(16)) for i in range(1, 101))
    t = time.time()
    d = bi.new_draft("big.txt", "txt", bi.read_text(text))
    pub = bi.public_draft(d)
    assert time.time() - t < 10
    assert pub["chapter_count"] == 100 and 115_000 < pub["words"] < 125_000
    assert pub["ai_calls"] == {"chapters": 100, "characters": bi.MAX_DETAIL_CHARACTERS, "rules": 1,
                               "total": 100 + bi.MAX_DETAIL_CHARACTERS + 1}
    assert len(json.dumps(pub)) < 200_000  # the page gets previews, not the whole text
