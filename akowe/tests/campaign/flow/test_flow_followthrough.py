"""Follow-through of the whole book path: after every step of "⚡ Make a book for me" and "Make my book", what the
step made is real, correct, consistent with the earlier steps, and actually used by the next step - all the way into
the PDF, EPUB and DOCX text (paragraph by paragraph)."""
from __future__ import annotations

import io
import json
import threading
import zipfile

import pytest

import flowkit as fk
from akowe.book_path import get_profile, save_profile


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    fk.quiet_provider_sleep(monkeypatch)


def edges_into(app, pid, consumer_id):
    return {(r["producer_record_id"], r["producer_version"]) for r in app.store.query(
        "SELECT producer_record_id, producer_version FROM dependency_edges WHERE project_id=? AND branch_id='main' "
        "AND consumer_record_id=?", (pid, consumer_id))}


def canon_subjects(app, pid, op):
    out = set()
    for r in fk.bp_of(app, pid).approved(op):
        out |= {f["subject_id"] for f in r["data"].get("facts") or [] if f.get("predicate") == "entity.name"}
    return out


def outline_facts(outline):
    rows = []
    for item in outline["data"]["chapters"]:
        f = {x["predicate"]: x["value"] for x in item["facts"]}
        rows.append(f)
    return rows


def check_exports(app, pid, chapters, title, author, files=None):
    """Every approved chapter's full text in PDF, EPUB and DOCX exactly once, in outline order; TOC/spine/nav ==
    chapters; metadata from the profile."""
    expected = [(cid, fk.expected_paragraphs(rec["data"]["text"])) for cid, rec in chapters]
    all_expected = [p for _cid, ps in expected for p in ps]
    ex = fk.export_files(app, pid, files)
    assert set(ex) == {"PDF", "EPUB", "DOCX"}
    # EPUB: one chapter section per chapter, paragraphs equal, spine and nav == chapters
    e = fk.epub_info(ex["EPUB"])
    assert [c["paras"] for c in e["chapters"]] == [ps for _cid, ps in expected]
    assert len(e["nav"]) == len(chapters) and len(e["spine"]) == len(chapters) + 2  # + title page, contents
    assert [h for h, _ in e["nav"]] == [c["heading"] for c in e["chapters"]]
    assert [href.split("#")[0] for _h, href in e["nav"]] == [f"text/{c['href'].split('/')[-1]}" for c in e["chapters"]]
    assert e["meta"] == {"title": [title], "creator": [author]} and e["scripts"] == 0
    # DOCX: the body paragraphs are exactly the chapters' paragraphs (headings in between), TOC == chapters
    d = fk.docx_info(ex["DOCX"])
    body = [t for s, t in d["paras"] if t and not s.lower().startswith(("toc", "heading", "title", "subtitle"))]
    assert [t for s, t in d["paras"] if s in ("Title", "Subtitle")] == [title, author]  # the title page (BF-04)
    assert body == all_expected, (body[:6], all_expected[:6])
    toc = [t for s, t in d["paras"] if s.lower().startswith("toc ") and s.lower() != "toc heading" and t]
    assert len(toc) == len(chapters) and len([h for h in d["headings"]]) == len(chapters)
    assert d["meta"] == {"title": title, "author": author}
    # PDF: every paragraph once, in order (line breaks normalised away)
    p = fk.pdf_info(ex["PDF"])
    pos = 0
    for para in all_expected:
        assert p["text"].count(para) == 1, para
        i = p["text"].index(para)
        assert i >= pos, f"paragraph out of order: {para}"
        pos = i
    assert p["meta"].get("/Title") == title and p["meta"].get("/Author") == author
    return ex


# ---------------------------------------------------------------------------------------------------------------
def test_make_a_book_every_step_follows_through(tmp_path):
    ai = fk.TraceAI()
    app = fk.make_app(tmp_path, fake=ai)
    run = fk.run_book(app, {"genre": "Mystery", "length": "novella"})
    assert run["status"] == "done", (run.get("problem"), [(s["id"], s["state"]) for s in run["steps"]])
    pid = run["project_id"]
    bp = fk.bp_of(app, pid)

    # profile -> stored, project named after it, used for the chapter target
    prof = get_profile(app.store, pid)
    assert prof["title"] == run["title"] == "The Keeper of Gullhaven" and prof["author"] == "Rowan Ashby"
    assert prof["genre"] == "Mystery" and prof["length"] == "novella" and prof["chapters"] == 12  # P15 preset
    assert app.store.project(pid)["name"] == prof["title"]

    # canon -> approved; nothing left as a stray draft
    a01, a04 = bp.approved("A01"), bp.approved("A04")
    assert len(a01) == 3 and len(a04) == 2
    assert not [r for r in app.store.list_records(pid, "main") if r["module_id"] in ("A01", "A03", "A04")
                and r["lifecycle"] not in ("APPROVED", "LOCKED")]
    chars, places = canon_subjects(app, pid, "A01"), canon_subjects(app, pid, "A04")

    # premise -> plot -> outline: exactly one approved each, each built on the approved one before it
    b01, b03, b11 = bp.approved("B01"), bp.approved("B03"), bp.approved("B11")
    assert len(b01) == len(b03) == len(b11) == 1
    assert [r["record_id"] for r in app.store.list_records(pid, "main", "B01", "OUTPUT")] == [b01[0]["record_id"]]
    canon_ids = {(r["record_id"], r["version"]) for r in a01 + a04 + bp.approved("A03")}
    into_b01 = edges_into(app, pid, b01[0]["record_id"])
    assert into_b01 and into_b01 <= canon_ids  # premise used the approved canon, nothing else
    assert (b01[0]["record_id"], b01[0]["version"]) in edges_into(app, pid, b03[0]["record_id"])
    assert (b03[0]["record_id"], b03[0]["version"]) in edges_into(app, pid, b11[0]["record_id"])

    # outline: chapter count == target; every POV/location resolves to approved canon (no dangling ids)
    facts = outline_facts(b11[0])
    assert len(facts) == 12  # P15: novella preset (was 8)
    assert all(f["plan.pov_id"] in chars and f["plan.location_id"] in places for f in facts)
    outline_ids = [c["chapter_id"] for c in bp.outline_chapters(b11[0])]
    assert outline_ids == [f"ch{i}" for i in range(1, 13)]

    # chapters: exactly one context and one prose record per outline chapter, the prose follows the objective
    c01 = app.store.list_records(pid, "main", "C01", "OUTPUT")
    c02 = app.store.list_records(pid, "main", "C02", "OUTPUT")
    assert len(c01) == 12 and len(c02) == 12
    chapters = fk.approved_chapters(app, pid)
    assert [cid for cid, _ in chapters] == outline_ids
    for cid, rec in chapters:
        assert rec is not None and rec["lifecycle"] == "APPROVED"
        assert rec["data"]["text"].startswith(f"[{cid}/p1] {fk.objective_marker(cid)}")
    assert ai.chapter_versions == {cid: 1 for cid in outline_ids}  # each chapter written once
    assert len({rec["record_id"] for _c, rec in chapters}) == 12

    # assembly uses exactly those approved chapter revisions, in outline order
    asm = bp.mem["assembly"]
    assert asm["chapters"] == [f"{rec['record_id']}:{rec['version']}" for _c, rec in chapters]
    g02 = bp.rec(asm["G02"]["record_id"])
    assert g02["lifecycle"] == "APPROVED"

    # exports: every approved chapter exactly once in PDF/EPUB/DOCX; metadata from the profile
    check_exports(app, pid, chapters, prof["title"], prof["author"], run["files"])
    # check step really ran on this assembly and passed
    st = {s["id"]: s for s in bp.status()["steps"]}
    assert st["check"]["state"] == "done" and st["check"]["result"] == "PASS"
    assert bp.status()["next"] is None


def test_edit_chapter_two_then_reassemble_exports_new_text_only(tmp_path):
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    run = fk.run_book(app)
    assert run["status"] == "done"
    pid = run["project_id"]
    old = dict(fk.approved_chapters(app, pid))["ch2"]
    old_paras = fk.expected_paragraphs(old["data"]["text"])
    bp = fk.bp_of(app, pid)
    new_text = "[ch2/EDIT] Mara rewrote the night on the reef.\n\nA second, entirely new paragraph."
    r = bp.dispatch("C02", "UPDATE", base_ref=old["ref"], payload=dict(old["data"], text=new_text))
    assert r["status"] == "DRAFT"
    # an unapproved edit does not leak into the book: the approved revision stays the source
    assert dict(fk.approved_chapters(app, pid))["ch2"]["version"] == old["version"]
    out = fk.bp_of(app, pid).act("approve", {"record_ids": [r["output_refs"][0]["record_id"]],
                                             "author_confirms": True})
    assert out["ok"], out
    st = {s["id"]: s for s in fk.bp_of(app, pid).status()["steps"]}
    assert st["assemble"]["state"] == "ready" and st["export"]["state"] == "blocked" and not st["export"]["files"]
    # an unapproved draft of chapter 3 is waiting while the book is re-assembled: it must not leak in
    ch3 = dict(fk.approved_chapters(app, pid))["ch3"]
    d3 = bp.dispatch("C02", "UPDATE", base_ref=ch3["ref"], payload=dict(ch3["data"], text="[ch3/DRAFT-LEAK] no."))
    assert d3["status"] == "DRAFT"
    assert fk.bp_of(app, pid).act("assemble", {})["ok"]
    st = {s["id"]: s for s in fk.bp_of(app, pid).status()["steps"]}
    assert fk.bp_of(app, pid).act("approve", {"record_ids": [x["record_id"] for x in st["assemble"]["approve"]],
                                              "author_confirms": True})["ok"]
    out = fk.bp_of(app, pid).act("export", {})
    assert out["ok"] and not out.get("problems"), out
    assert fk.bp_of(app, pid).act("check", {})["ok"]
    chapters = fk.approved_chapters(app, pid)
    assert dict(chapters)["ch2"]["data"]["text"] == new_text
    ex = check_exports(app, pid, chapters, run["title"], "Rowan Ashby")
    texts = {"PDF": fk.pdf_info(ex["PDF"])["text"], "EPUB": " ".join(fk.epub_info(ex["EPUB"])["paras"]),
             "DOCX": " ".join(fk.docx_info(ex["DOCX"])["texts"])}
    for fmt, txt in texts.items():
        assert "[ch2/EDIT]" in txt, fmt
        assert "DRAFT-LEAK" not in txt and "[ch3/p1]" in txt, fmt
        assert not any(p in txt for p in old_paras), f"old chapter 2 text still in {fmt}"


def test_title_page_shows_profile_title_and_author(tmp_path):
    # chapter 2's prose names its title on a "# " line (as the C02 task asks); the others have none
    def titled(ctx, out):
        if (ctx.get("request_payload") or {}).get("chapter_id") == "ch2":
            out["text"] = "# Chapter 2: The *Brass* Key\n\n" + out["text"]
        return out
    app = fk.make_app(tmp_path, fake=fk.TraceAI(overrides={"C02": titled}))
    run = fk.run_book(app)
    ex = fk.export_files(app, run["project_id"], run["files"])
    first = fk.norm(fk.pdf_info(ex["PDF"])["pages"][0])
    assert "The Keeper of Gullhaven" in first and "Rowan Ashby" in first
    assert "The Keeper of Gullhaven" in " ".join(fk.docx_info(ex["DOCX"])["texts"][:3])
    e = fk.epub_info(ex["EPUB"])
    title_doc = zipfile.ZipFile(io.BytesIO(ex["EPUB"])).read("OEBPS/" + e["spine"][0]).decode("utf-8")
    assert 'epub:type="titlepage"' in title_doc and "The Keeper of Gullhaven" in title_doc and "Rowan Ashby" in title_doc
    # chapter headings: G06 numbering + the prose's own title (no doubled "Chapter 2", no markup)
    assert [c["heading"] for c in e["chapters"]] == ["Chapter 1", "Chapter 2: The Brass Key", "Chapter 3"]
    assert fk.docx_info(ex["DOCX"])["headings"] == ["Chapter 1", "Chapter 2: The Brass Key", "Chapter 3"]


def test_make_my_book_over_http_follows_through(tmp_path):
    """The guided path the UI drives (POST .../book/<action>), with the AI writing, the author approving."""
    from http.server import ThreadingHTTPServer
    from akowe.server import make_handler
    from test_server import call
    ai = fk.TraceAI()
    app = fk.make_app(tmp_path, fake=ai)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    try:
        def c(method, path, body=None):
            return call(port, method, path, body, token=fk.TOKEN)
        status, proj, _ = c("POST", "/api/projects", {
            "name": "Guided", "release_profiles": ["MANUSCRIPT_PDF", "EPUB_REFLOWABLE", "EDITABLE_DOCX"],
            "profile": {"title": "The Guided Light", "author": "Ann Writer", "genre": "Mystery",
                        "length": "short_story", "idea": "An apprentice keeper searches for her master.",
                        "chapters": 2}})
        assert status in (200, 201), proj
        pid = proj["project_id"]
        base = f"/api/projects/{pid}/branches/main/book"

        def act(action, body=None):
            st, out, _ = c("POST", f"{base}/{action}", body or {})
            assert st == 200, out
            return out

        def approve_all(step_id):
            book = c("GET", base)[1]
            ids = [x["record_id"] for x in {s["id"]: s for s in book["steps"]}[step_id]["approve"]]
            assert ids, step_id
            out = act("approve", {"record_ids": ids, "author_confirms": True})
            assert out["ok"], out
            return ids
        # canon: the author's own characters/places (manual), named like the AI's outline expects
        from autobook_fake import fact
        bp = fk.bp_of(app, pid, principal=app.authenticate("Bearer " + fk.TOKEN))
        for op, name, sid in (("A04", "Gullhaven Harbor", "gullhaven-harbor"), ("A01", "Mara Vell", "mara-vell")):
            ref, _ = bp.create(op, {"concept": name}, manual_candidate={
                "concept": name, "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
                "facts": [fact(sid, "entity.name", name)]})
        approve_all("canon")
        for op, sid in (("B01", "premise"), ("B03", "plot"), ("B11", "outline")):
            out = act("create", {"op": op})
            assert out["ok"] and out["created"]["module_id"] == op, out
            # the step offers exactly the record it just made
            book = c("GET", base)[1]
            assert [x["record_id"] for x in {s["id"]: s for s in book["steps"]}[sid]["approve"]] == \
                [out["created"]["record_id"]]
            approve_all(sid)
        book = c("GET", base)[1]
        chs = {s["id"]: s for s in book["steps"]}["chapters"]["chapters"]
        assert [x["chapter_id"] for x in chs] == ["ch1", "ch2"]
        for ch in chs:
            out = act("write_chapter", {"chapter_id": ch["chapter_id"]})
            assert out["ok"], out
        approve_all("chapters")
        assert act("setup_format")["ok"]
        approve_all("format")
        assert act("assemble")["ok"]
        approve_all("assemble")
        out = act("export")
        assert out["ok"] and not out.get("problems"), out
        assert act("check")["ok"]
        book = c("GET", base)[1]
        assert book["next"] is None and book["done_count"] == book["total"]
        chapters = fk.approved_chapters(app, pid)
        for cid, rec in chapters:
            assert fk.objective_marker(cid) in rec["data"]["text"]
        check_exports(app, pid, chapters, "The Guided Light", "Ann Writer")
        # downloads over HTTP are the same bytes as the stored files
        for f in {s["id"]: s for s in book["steps"]}["export"]["files"]:
            st, data, _ = c("GET", f"/api/projects/{pid}/branches/main/assets/{f['record_id']}/{f['version']}")
            assert st == 200 and data == fk.export_files(app, pid)[f["format"]]
    finally:
        httpd.shutdown()
        httpd.server_close()
        app.store.close()



def test_profile_title_change_reaches_the_next_export(tmp_path):
    """NEW-flow-7: after the title/author change in the profile, the format step is out of date and offers to make it
    again, the export step stops saying done (the old files stay listed, marked out of date and named after the old
    title), and following the offered steps puts the NEW title/author in every file."""
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    run = fk.run_book(app)
    pid = run["project_id"]
    save_profile(app.store, pid, {"title": "A Brand New Title", "author": "New Pen"})
    bp = fk.bp_of(app, pid)
    status = bp.status()
    st = {s["id"]: s for s in status["steps"]}
    assert st["format"]["state"] != "done" and st["format"]["action"] == "setup_format" and st["format"]["out_of_date"]
    assert st["export"]["state"] != "done" and status["next"] == "format"
    assert {f["out_of_date"] for f in st["export"]["files"]} == {True}
    assert {f["title"] for f in st["export"]["files"]} == {"The Keeper of Gullhaven"}
    assert not bp.act("export", {})["ok"]  # exporting with the old format is refused, not silently stale
    out = bp.act("setup_format", {})
    assert out["ok"], out
    items = {s["id"]: s for s in out["book"]["steps"]}["format"]["approve"]
    assert items and fk.bp_of(app, pid).act("approve", {"record_ids": [i["record_id"] for i in items],
                                                        "author_confirms": True})["ok"]
    # ACCEPT-1: the title page is made when the book is put together, so that step is out of date now and says why;
    # exporting before it is redone is refused (it would print the old title on the first page).
    status = fk.bp_of(app, pid).status()
    st = {s["id"]: s for s in status["steps"]}
    assert st["format"]["state"] == "done" and status["next"] == "assemble"
    assert st["assemble"]["state"] == "ready" and st["assemble"]["action"] == "assemble"
    assert st["assemble"]["out_of_date"]
    assert "title page" in st["assemble"]["about"] and st["export"]["state"] == "blocked"
    assert st["export"]["waiting_for"] == "assemble" and not fk.bp_of(app, pid).act("export", {})["ok"]
    out = fk.bp_of(app, pid).act("assemble", {})
    assert out["ok"], out
    items = {s["id"]: s for s in out["book"]["steps"]}["assemble"]["approve"]
    assert items and fk.bp_of(app, pid).act("approve", {"record_ids": [i["record_id"] for i in items],
                                                        "author_confirms": True})["ok"]
    st = {s["id"]: s for s in fk.bp_of(app, pid).status()["steps"]}
    assert st["assemble"]["state"] == "done" and st["export"]["action"] == "export"
    out = fk.bp_of(app, pid).act("export", {})
    assert out["ok"], out
    st = {s["id"]: s for s in out["book"]["steps"]}
    assert st["export"]["state"] == "done" and not any(f["out_of_date"] for f in st["export"]["files"])
    ex = fk.export_files(app, pid)
    assert fk.epub_info(ex["EPUB"])["meta"] == {"title": ["A Brand New Title"], "creator": ["New Pen"]}
    assert fk.docx_info(ex["DOCX"])["meta"] == {"title": "A Brand New Title", "author": "New Pen"}
    # The visible title page (what a reader sees first), not only the metadata, carries the new title and author.
    import pypdfium2 as pdfium  # noqa: PLC0415
    pdf_p1 = pdfium.PdfDocument(ex["PDF"])[0].get_textpage().get_text_range()
    assert "A Brand New Title" in pdf_p1 and "New Pen" in pdf_p1 and "Gullhaven" not in pdf_p1, pdf_p1
    z = zipfile.ZipFile(io.BytesIO(ex["EPUB"]))
    epub_p1 = z.read(sorted(n for n in z.namelist() if n.endswith(".xhtml") and "/text/" in n)[0]).decode("utf-8")
    assert "A Brand New Title" in epub_p1 and "New Pen" in epub_p1 and "Gullhaven" not in epub_p1, epub_p1[:400]
    docx_title = [t for sty, t in fk.docx_info(ex["DOCX"])["paras"] if sty in ("Title", "Subtitle")]
    assert docx_title == ["A Brand New Title", "New Pen"], docx_title
    # ...and the book list / picker / breadcrumb show the new name (renamed with the profile, atomically).
    assert app.store.project(pid)["name"] == "A Brand New Title"
