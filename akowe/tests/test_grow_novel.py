"""📖 Grow my start into a novel (grow_novel.py) with the fake AI: the opening brought in (paste, .txt, .md, .docx,
.pdf), the Book Bible filled from it (characters with voice cards from their real lines, places, world, story rules
with a STRUCTURED magic rule the rule check enforces, the style card, premise, protected mysteries, the kind of
story) and shown for the author's corrections, the plan of the rest from chapter N+1, the author's chapters stored
once and never rewritten by any pass, and a whole ⚡ run to a finished book."""
from __future__ import annotations

import io
import time
import types
import zipfile

import pytest

from akowe import book_import as bi
from akowe import characters as chars_mod
from akowe import grow_novel as gn
from akowe import magic_rules, story_rules, style_card
from akowe import providers as prov_mod
from akowe.book_path import BookPath, get_profile
from akowe.errors import AkoweError

from grow_fake import OPENING, GrowFakeAI, opening_text
from test_autobook import make_app, steps
from autobook_fake import trust_one_ai


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def wait_job(app, job, timeout=60):
    t = time.time() + timeout
    while time.time() < t:
        j = app.review._jobs[job["job_id"]].public()  # noqa: SLF001
        if j["status"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def start_book(app, *, chapters=4, length="short_story", text=None):
    d = bi.drafts_of(app).save(bi.new_draft("opening.txt", "txt", bi.read_text(text or opening_text())))
    return gn.start(app, "author", {"draft_id": d["id"], "author_confirms": True, "author": "R. Ashby",
                                    "target": {"length": length, "chapters": chapters}})


def grow_to_ready(app, fake, *, chapters=4):
    out = start_book(app, chapters=chapters)
    pid, b = out["project_id"], "main"
    j = wait_job(app, gn.understand(app, "author", pid, b, {}))
    assert j["status"] == "done", j
    gn.accept(app, "author", pid, b, {"author_confirms": True})
    j = wait_job(app, gn.plan(app, "author", pid, b, {}))
    assert j["status"] == "done", j
    gn.use_plan(app, "author", pid, b, {"author_confirms": True})
    return pid


def author_texts_now(app, pid):
    bp = BookPath(app.engine, "author", pid, "main")
    outline = bp.outline()
    out = {}
    for c in bp.outline_chapters(outline):
        _ctx, _l, appr = bp.chapter_prose(outline, c["chapter_id"])
        out[c["chapter_id"]] = (appr or {}).get("data", {}).get("text") if appr else None
    return out


# ------------------------------------------------------------------------------------------------ 1. import
def _docx(paras):
    body = "".join(f'<w:p>{"<w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr>" if h else ""}<w:r><w:t>{t}</w:t></w:r></w:p>'
                   for t, h in paras)
    doc = ('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/'
           f'wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>')
    styles = ('<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/'
              'wordprocessingml/2006/main"><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>'
              '</w:styles>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", doc)
        z.writestr("word/styles.xml", styles)
    return buf.getvalue()


def _pdf(lines):
    """A tiny one-page text PDF (no library)."""
    content = "BT /F1 12 Tf 72 720 Td " + " T* ".join(f"({ln}) Tj" for ln in lines) + " ET"
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >>"
            " >> >>", f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offs = b"%PDF-1.4\n", []
    for i, o in enumerate(objs):
        offs.append(len(out))
        out += f"{i + 1} 0 obj\n{o}\nendobj\n".encode()
    x = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offs).encode()
    out += f"trailer << /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF".encode()
    return out


@pytest.mark.parametrize("name,data,want", [
    ("opening.txt", opening_text().encode(), 2),
    ("opening.md", ("# Chapter One: The Dark Light\n\n" + "\n\n".join(OPENING[0][1]) + "\n\n# Chapter Two: The Blink"
                    "\n\n" + "\n\n".join(OPENING[1][1])).encode(), 2),
    ("opening.docx", _docx([(OPENING[0][0], True)] + [(p.replace('"', "&quot;"), False) for p in OPENING[0][1]]
                           + [(OPENING[1][0], True)] + [(p.replace('"', "&quot;"), False) for p in OPENING[1][1]]),
     2),
    ("pages.txt", "\n\n".join(OPENING[0][1]).encode(), 1),  # a few pages, no heading: chapter 1
])
def test_the_opening_is_read_and_split(name, data, want):
    kind, blocks = bi.read_file(name, data)
    d = bi.new_draft(name, kind, blocks)
    inc = [c for c in d["chapters"] if c["include"]]
    assert len(inc) == want
    assert "Mara" in inc[0]["text"]


def test_a_text_pdf_is_read_with_and_without_pypdf(monkeypatch):
    data = _pdf(["Mara Vell climbed the hundred steps.", "", "Tom Reed shook his head at the dark lamp."])
    kind, blocks = bi.read_file("opening.pdf", data)
    assert kind == "pdf" and "Mara Vell" in " ".join(b["text"] for b in blocks)
    import builtins
    real = builtins.__import__

    def no_pypdf(name, *a, **kw):
        if name == "pypdf":
            raise ImportError("no pypdf")
        return real(name, *a, **kw)
    monkeypatch.setattr(builtins, "__import__", no_pypdf)
    kind, blocks = bi.read_file("opening.pdf", data)
    assert "Tom Reed" in " ".join(b["text"] for b in blocks)
    with pytest.raises(AkoweError) as ei:  # a scan: no text
        bi.read_file("scan.pdf", _pdf([]))
    assert ei.value.errors[0]["problem"] == "IMPORT_PDF_NO_TEXT"


def test_start_makes_the_book_and_keeps_the_chapters_waiting(tmp_path):
    app = make_app(tmp_path, fake=GrowFakeAI())
    out = gn.start(app, "author", {"text": opening_text(), "author_confirms": True,
                                   "target": {"length": "novella"}})
    pid = out["project_id"]
    assert out["chapters"] == 2 and out["target"] == {"length": "novella", "chapters": 12}
    st = gn.public(app, "author", pid, "main")
    assert st["stage"] == "imported" and st["from_chapter"] == 3
    assert [c["number"] for c in gn.author_texts(app.store, pid, "main")] == [1, 2]
    assert not BookPath(app.engine, "author", pid, "main").approved("A01")  # nothing in the Bible yet
    with pytest.raises(AkoweError):
        gn.start(app, "author", {"text": opening_text()})  # needs the author's OK
    with pytest.raises(AkoweError):
        gn.start(app, "author", {"text": opening_text(), "author_confirms": True,
                                 "target": {"length": "novel", "chapters": 2}})  # not more than the author's 2
    big = "\n\n".join(f"Chapter {i}\n\nMara walked on, night {i}." for i in range(1, 15))
    with pytest.raises(AkoweError) as ei:
        gn.start(app, "author", {"text": big, "author_confirms": True})
    assert ei.value.errors[0]["problem"] == "GROW_TOO_MANY"


# ------------------------------------------------------------------------------------------------ 2. the Bible
def test_the_bible_is_filled_from_the_chapters_and_shown_first(tmp_path):
    fake = GrowFakeAI()
    app = make_app(tmp_path, fake=fake)
    pid = start_book(app)["project_id"]
    assert wait_job(app, gn.understand(app, "author", pid, "main", {}))["status"] == "done"
    assert [k for k in fake.kinds if k.startswith("grow")] == ["grow_understand", "grow_voices"]  # two requests
    # the voices request got each character's REAL lines (found without AI)
    lines = {c["name"]: c["lines"] for c in fake.voice_contexts[0]["characters"]}
    assert "Who signed the log?" in lines["Mara Vell"]
    assert "Mind yourself," in " ".join(lines["Nessa Crane"]) or any("Mind yourself" in x for x in lines["Nessa Crane"])
    st = gn.public(app, "author", pid, "main")
    assert st["stage"] == "understood"
    u = st["understood"]
    mara = next(c for c in u["characters"] if c["name"] == "Mara Vell")
    assert mara["looks"]["eyes"]["on_page"] and not mara["looks"]["hair"]["on_page"]  # quotes checked
    assert "Who signed the log?" in mara["voice"]["samples"]  # sample lines = her real lines
    assert u["style"]["voice_summary"] and [m["verified"] for m in u["style"]["example_moves"]] == [True, False]
    assert u["pov"] == "third" and u["tense"] == "past"
    assert u["magic"] and "2 tide-stones" in u["magic"][0]
    assert any(r["category"] == "mystery" for r in u["rules"])
    # nothing is in the book before ✔ Use this
    assert not BookPath(app.engine, "author", pid, "main").approved("A01")
    assert story_rules.get_entry(app.store, pid, "main") is None
    # the author corrects the reading on the one screen
    u2 = dict(u, title="The Keeper's Stones", premise="Mara Vell spends her last tide-stones to find her master.")
    u2["characters"] = [dict(c, wants="To bring her master home.") if c["name"] == "Mara Vell" else c
                        for c in u["characters"]]
    with pytest.raises(AkoweError):
        gn.save_understood(app, "author", pid, "main", {"understood": u2, "version": 99})
    st = gn.save_understood(app, "author", pid, "main", {"understood": u2, "version": st["understood_version"]})
    assert st["understood"]["premise"].startswith("Mara Vell spends")
    with pytest.raises(AkoweError):
        gn.accept(app, "author", pid, "main", {})  # needs the author's OK
    out = gn.accept(app, "author", pid, "main", {"author_confirms": True})
    assert out["stage"] == "accepted" and "magic rule" in out["message"]
    # characters with sheets, voice cards (the author's) and one protagonist
    cast = {c["name"]: c for c in chars_mod.canon_characters(app.store, pid, "main", approved_only=True)}
    assert set(cast) == {"Mara Vell", "Tom Reed", "Nessa Crane"}
    e = chars_mod.get_entry(app.store, pid, "main", cast["Mara Vell"]["record_id"])
    assert e["made_by"]["kind"] == "author" and e["story_role"] == "protagonist"
    assert e["sheet"]["wants"] == "To bring her master home." and "Who signed the log?" in e["voice"]["samples"]
    # places, profile, kind of story, central question, point of view
    bp = BookPath(app.engine, "author", pid, "main")
    assert len(bp.approved("A04")) == 2
    prof = get_profile(app.store, pid)
    assert prof["idea"].startswith("Mara Vell spends") and prof["central_question"] and prof["pov"] == "third"
    from akowe import story_kind
    assert story_kind.of_store(app.store, pid) == "quest" and prof["title"] == "The Keeper's Stones"
    # the magic rule is STRUCTURED: the rule check knows its needs, limits, price and holdings
    abil = magic_rules.abilities_of(story_rules.get_entry(app.store, pid, "main"))
    assert [a["name"] for a in abil] == ["Blinking"]
    assert abil[0]["needs"][0]["qty"] == 2 and abil[0]["limits"].get("per_day") == 3
    assert abil[0]["start"] and abil[0]["price"] == "a nosebleed"
    # the protected mystery and the style card (this book only)
    assert any(r["category"] == "mystery" for r in story_rules.get_entry(app.store, pid, "main")["rules"])
    sb = style_card.brief_for(app.store, pid)
    assert sb and sb.get("voice_summary") == "Plain, salt-worn close third person."
    assert style_card.author_card(app.store, "author") is None  # the author's own card is not touched
    with pytest.raises(AkoweError):
        gn.accept(app, "author", pid, "main", {"author_confirms": True})  # once


# ------------------------------------------------------------------------------------------------ 3. the plan
def test_the_plan_continues_from_chapter_n_plus_1(tmp_path):
    fake = GrowFakeAI()
    app = make_app(tmp_path, fake=fake)
    pid = start_book(app, chapters=5)["project_id"]
    wait_job(app, gn.understand(app, "author", pid, "main", {}))
    with pytest.raises(AkoweError):
        gn.plan(app, "author", pid, "main", {})  # the reading first
    gn.accept(app, "author", pid, "main", {"author_confirms": True})
    assert wait_job(app, gn.plan(app, "author", pid, "main", {"note": "a storm in the middle"}))["status"] == "done"
    ctx = fake.plan_contexts[-1]
    assert ctx["from_chapter"] == 3 and ctx["how_many"] == 3 and ctx["total_chapters"] == 5
    assert ctx["author_note"] == "a storm in the middle" and ctx["magic_rules"]
    assert "one tide-stone left" in ctx["last_chapter_end"]
    st = gn.public(app, "author", pid, "main")
    assert st["stage"] == "planned" and len(st["plan"]["chapters"]) == 3
    p = dict(st["plan"])
    p["chapters"] = p["chapters"] + [{"title": "The reef", "objective": "Mara reaches the reef at low tide.",
                                      "pov": "Mara Vell", "place": "The Old Light"}]
    st = gn.save_plan(app, "author", pid, "main", {"plan": p, "version": st["plan_version"]})
    assert len(st["plan"]["chapters"]) == 4
    out = gn.use_plan(app, "author", pid, "main", {"author_confirms": True})
    assert out["stage"] == "ready" and out["total"] == 6
    bp = BookPath(app.engine, "author", pid, "main")
    assert bp.approved("B01") and bp.approved("B03") and bp.approved("B11")
    chs = bp.outline_chapters(bp.outline())
    assert [c["chapter_id"] for c in chs] == [f"ch{i}" for i in range(1, 7)]
    assert chs[3]["objective"].startswith("Mara follows") and chs[5]["objective"].startswith("Mara reaches the reef")
    texts = author_texts_now(app, pid)
    assert "hundred steps of the old light" in texts["ch1"] and "two tide-stones in her fist" in texts["ch2"]
    assert texts["ch3"] is None  # the AI's chapters are still to be written
    for cid in ("ch1", "ch2"):  # the author's text: made by "you"
        _c, _l, appr = bp.chapter_prose(bp.outline(), cid)
        assert app.review.made_by(pid, "main", appr, app.review.fixes(pid, "main"))["kind"] not in ("ai", "ai_fix")
    assert get_profile(app.store, pid)["chapters"] == 6
    # the magic ledger is seeded from the author's chapters: Mara used two stones in chapter 2
    rep = magic_rules.compute(app.engine, "author", pid, "main")
    assert rep["counts"]["uses"] >= 1 and rep["counts"]["broken"] == 0


def test_the_rule_check_flags_a_chapter_that_breaks_the_authors_magic(tmp_path):
    app = make_app(tmp_path, fake=GrowFakeAI())
    pid = grow_to_ready(app, None)
    bp = BookPath(app.engine, "author", pid, "main")
    _c, _l, appr = bp.chapter_prose(bp.outline(), "ch2")
    bad = dict(appr, data=dict(appr["data"], text="Mara held one tide-stone in her fist and blinked across the "
                                                    "water to the reef. Her nose bled."))
    flags = magic_rules.flags_for(app.engine, "author", pid, "main", bad)
    assert flags and any("2" in f.get("message", "") or "two" in f.get("message", "") for f in flags)


# ------------------------------------------------------------------------------------------------ 4. write on
def test_a_whole_run_finishes_the_book_and_never_touches_the_authors_chapters(tmp_path):
    fake = GrowFakeAI()
    app = make_app(tmp_path, fake=fake)
    pid = grow_to_ready(app, fake, chapters=4)
    before = author_texts_now(app, pid)
    st = gn.public(app, "author", pid, "main")
    run = gn.write(app, "author", pid, "main", {"author_confirms": True, "improve_pass": True, "opening_pass": True,
                                                "beta_reader": True})
    app.autobook.wait_for(run["id"], 240)
    trust_one_ai(app, run["id"], 240)
    r = app.autobook.public(app.autobook.get(run["id"]))
    assert r["status"] == "done", (r.get("problem"), [(s["id"], s["state"], s["message"]) for s in r["steps"]])
    assert r["project_id"] == pid
    s = steps(r)
    assert s["chapters"]["state"] == "done"
    texts = author_texts_now(app, pid)
    assert texts["ch1"] == before["ch1"] and texts["ch2"] == before["ch2"]  # never rewritten
    assert texts["ch3"] and texts["ch4"]  # written by the AI from chapter 3
    # no AI request ever wrote chapter 1 or 2, and nothing invented the profile or the cast again
    assert "profile" not in fake.kinds and "sketch" not in fake.kinds
    assert "fresh_names" not in fake.kinds
    # the 🩺 story doctor scored the author's plan (scored, never rewritten) and the trade card step ran
    assert "plan_review" in fake.kinds
    # the opening pass left the author's chapter 1 alone; the improve pass (weakest scenes) and the end-of-book voice
    # pass ran and still left chapters 1-2 exactly as written (checked above)
    assert "you wrote chapter 1 yourself" in s["opening"]["message"], s["opening"]["message"]
    assert "weak_scene" in fake.kinds and "human_rewrite" in fake.kinds
    # the author's voice cards stayed theirs (the AI only filled what was empty)
    cast = {c["name"]: c for c in chars_mod.canon_characters(app.store, pid, "main")}
    for name in ("Mara Vell", "Nessa Crane"):
        e = chars_mod.get_entry(app.store, pid, "main", cast[name]["record_id"])
        assert e["made_by"]["kind"] == "author"
    e = chars_mod.get_entry(app.store, pid, "main", cast["Mara Vell"]["record_id"])
    assert "Who signed the log?" in e["voice"]["samples"]
    # the book was made: files exported, the run window says it continued the author's book
    assert r["files"] and gn.public(app, "author", pid, "main")["run"]["status"] == "done"
    assert st["stage"] == "ready"


def test_every_rewrite_pass_skips_the_authors_chapters(tmp_path):
    """The improve pass (weakest scenes), the opening pass, the chapter polish and the end-of-book voice pass all
    ask the run's ``_ai_made``: the author's chapters are never theirs to change."""
    from akowe import opening_pass, chapter_polish  # noqa: F401
    fake = GrowFakeAI()
    app = make_app(tmp_path, fake=fake)
    pid = grow_to_ready(app, fake)
    bp = BookPath(app.engine, "author", pid, "main")
    run = {"id": "run-x", "project_id": pid, "branch_id": "main", "principal": "author", "made": {}}
    for cid in ("ch1", "ch2"):
        _c, _l, appr = bp.chapter_prose(bp.outline(), cid)
        assert app.autobook._ai_made(run, appr) is False  # noqa: SLF001
    # a changed chapter list (e.g. a revised outline) puts the author's chapter back word for word, no AI
    before = author_texts_now(app, pid)
    outline = bp.outline()
    data = dict(outline["data"])
    data["chapters"] = [dict(c) for c in data["chapters"]]
    data["chapters"][-1]["summary"] = data["chapters"][-1]["summary"] + " (changed)"
    r = bp.dispatch("B11", "UPDATE", base_ref=outline["ref"], payload=data)
    assert bp.approve_ref(r["output_refs"][0])["ok"]
    n = len(fake.calls)
    for cid in ("ch1", "ch2"):
        rec = bi.keep_author_chapter(app, "author", pid, "main", cid)
        assert rec and rec["data"]["text"] == before[cid]
    assert len(fake.calls) == n  # no AI call
    assert bi.keep_author_chapter(app, "author", pid, "main", "ch3") is None  # not the author's


def test_routes(tmp_path):
    fake = GrowFakeAI()
    app = make_app(tmp_path, fake=fake)
    st, d = app.route("POST", "/api/import/read", {}, {"text": opening_text(), "name": "pasted"}, "author", {})
    assert st == 201 and d["chapter_count"] == 2
    st, out = app.route("POST", "/api/grow/start", {}, {"draft_id": d["draft_id"], "author_confirms": True,
                                                         "target": {"length": "short_story", "chapters": 3}},
                        "author", {})
    assert st == 201
    base = f"/api/projects/{out['project_id']}/branches/main/grow"
    st, g = app.route("GET", base, {}, None, "author", {})
    assert st == 200 and g["stage"] == "imported" and g["lengths"]
    st, j = app.route("POST", base + "/understand", {}, {}, "author", {})
    assert st == 202 and wait_job(app, j)["status"] == "done"
    st, g = app.route("GET", base, {}, None, "author", {})
    assert g["stage"] == "understood"
    st, g = app.route("POST", base + "/accept", {}, {"author_confirms": True}, "author", {})
    assert st == 200 and g["stage"] == "accepted"
