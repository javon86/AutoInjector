"""BACK BURNER (parked 2026-11-08 by the user's request): not loaded by the app; see docs/AKOWE_IMPROVEMENT_PLAN.md back-burner list.

📝 Fix it with my notes (notes_fix.py): notes parsed and mapped to chapters (Akọwe's own guess, the AI's mapping with
checked quotes, malformed answers, an AI failure), the author's confirmation, before/after proposals per change, the
independent check (never the writer; one AI only = said plainly), 🔒 locked facts surfacing as conflicts instead of
changing silently, approvals through the editor's proposal path (a new draft per chapter) and the summary line."""
from __future__ import annotations

import pytest as _pytest_parked  # noqa: E402

pytestmark = _pytest_parked.mark.skip(reason="back burner: feature parked")


import time
import types

import pytest

from akowe import book_import as bi
from akowe import notes_fix as nf
from akowe import providers as prov_mod
from akowe.errors import AkoweError

from import_fake import ImportFake, book_text
from test_book_import import PRINCIPAL, _import, make_app

NOTES = ("cut the dream in ch 3\nmake Mara angrier in the harbour scene\nMara's eyes should be grey in chapter 1\n"
         "the ending needs more payoff for the locket")


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


@pytest.fixture(autouse=True)
def drafts_dir(tmp_path, monkeypatch):
    d = tmp_path / "drafts"
    d.mkdir()
    monkeypatch.setattr(bi, "temp_dir", lambda: d)


def _wait(app, pid, timeout=60):
    t = time.time()
    while nf._alive(app, pid, "main") and time.time() - t < timeout:  # noqa: SLF001
        time.sleep(0.02)
    return nf.public(app, pid, "main")


def _book(tmp_path, second=True, bible=True):
    fake = ImportFake()
    app = make_app(tmp_path, fake, second=second)
    pid = _import(app)["project_id"]
    if bible:  # the Book Bible (with its 🔒 on-page details: Mara's green eyes)
        svc = bi.service_of(app)
        svc.start(PRINCIPAL, pid, "main", {})
        t = time.time()
        while svc.alive(pid, "main") and time.time() - t < 60:
            time.sleep(0.02)
    return app, fake, pid


# ====================================================================== notes and Akọwe's own mapping
def test_parse_notes():
    ns = nf.parse_notes("- Chapter 7 drags\n\n  2) cut the dream  \n• the ending\n")
    assert [n["text"] for n in ns] == ["Chapter 7 drags", "cut the dream", "the ending"]
    assert [n["id"] for n in ns] == ["n1", "n2", "n3"]
    with pytest.raises(AkoweError):
        nf.parse_notes("   ")
    with pytest.raises(AkoweError):
        nf.parse_notes("\n".join(f"note {i}" for i in range(nf.MAX_NOTES + 1)))


def test_guess_chapters_names_words_and_ending():
    chs = [{"number": i + 1, "chapter_id": f"ch{i + 1}", "text": t} for i, t in enumerate(
        ["Mara at the harbour.", "Tom and the boats.", "Mara found the locket.", "The lamp. Mara and Tom."])]
    assert nf.guess("Chapter 2 drags", chs, [])["chapters"] == [2]
    assert nf.guess("chapters 2-3 are slow", chs, [])["chapters"] == [2, 3]
    assert nf.guess("ch 9 is wrong", chs, [])["chapters"] == []           # no such chapter
    assert nf.guess("the ending is weak", chs, []) == {"chapters": [3, 4], "how": "the ending", "names": []}
    assert nf.guess("the opening is slow", chs, [])["chapters"] == [1]
    g = nf.guess("make Tom kinder", chs, ["Tom Reed", "Mara Vell"])
    assert g["how"] == "names" and set(g["chapters"]) == {2, 4}
    g = nf.guess("more payoff for the locket", chs, [])
    assert g == {"chapters": [3], "how": "words", "names": []}


def test_apply_mapping_checks_quotes_and_ignores_junk():
    chs = [{"number": 1, "text": "Mara walked to the harbour in the fog."}, {"number": 2, "text": "Tom slept."}]
    notes = [{"id": "n1", "text": "x", "chapters": [], "passages": [], "confirmed": False}]
    raw = {"mappings": ["junk", {"note": "n9", "chapters": [1]},
                        {"note": "n1", "chapters": [2, 99, "x", True],
                         "passages": [{"chapter": 1, "quote": "walked to the harbour"},
                                      {"chapter": 1, "quote": "a quote that is not there"}, "x"], "why": "w"}]}
    out = nf.apply_mapping(notes, raw, chs)
    assert out[0]["chapters"] == [1, 2] and out[0]["confirmed"] and out[0]["how"] == "ai"
    assert out[0]["passages"] == [{"chapter": 1, "quote": "walked to the harbour"}]
    assert nf.apply_mapping(notes, "junk", chs) == notes


def test_clean_changes_exact_unique_overlap_and_locked():
    text = "Mara walked. Her green eyes stung. Mara walked. The end came slowly."
    note = {"id": "n1", "text": "t"}
    raw = {"changes": [
        {"original": "Mara walked.", "replacement": "Mara ran.", "why": "", "conflict": ""},          # twice: no
        {"original": "not there", "replacement": "x", "why": "", "conflict": ""},                     # not found
        {"original": "The end came slowly.", "replacement": "The end came slowly.", "why": "", "conflict": ""},
        {"original": "Her green eyes stung.", "replacement": "Her grey eyes stung.", "why": "", "conflict": ""},
        {"original": "green eyes", "replacement": "blue eyes", "why": "", "conflict": ""},          # overlaps
        {"original": "The end came slowly.", "replacement": "", "why": "cut", "conflict": ""},       # a cut is fine
        "junk", {"original": 3}]}
    out = nf.clean_changes(raw, text, note, 1, locked=["Her green eyes stung."], keep=[])
    assert [(c["original"], c["replacement"]) for c in out] == [("Her green eyes stung.", "Her grey eyes stung."),
                                                               ("The end came slowly.", "")]
    assert "locked" in out[0]["conflict"] and not out[1]["conflict"]
    out = nf.clean_changes({"changes": [{"original": "The end came slowly.", "replacement": "Done.", "why": "",
                                         "conflict": ""}]}, text, note, 1, locked=[], keep=["came slowly"])
    assert "must stay" in out[0]["conflict"]
    assert nf.clean_changes("junk", text, note, 1, [], []) == []


# ====================================================================== the whole pass
def test_notes_map_revise_check_and_approve(tmp_path):
    app, fake, pid = _book(tmp_path)
    fake.check_problems = [{"match": "slammed her fist", "problem": "Mara never shouts in the Book Bible"}]
    base = f"/api/projects/{pid}/branches/main/notes-fix"
    st, out = app.route("POST", base + "/map", {}, {"notes": NOTES}, PRINCIPAL, {})
    assert st == 202
    m = _wait(app, pid)
    assert m["status"] == "mapped", m
    by = {n["id"]: n for n in m["notes"]}
    assert by["n1"]["chapters"] == [3] and by["n1"]["passages"][0]["quote"].startswith("She dreamed")
    assert by["n2"]["chapters"] == [2] and by["n2"]["passages"] == []  # the AI's made-up quote was dropped
    assert by["n4"]["chapters"] == [2, 3]                              # "the ending": the last chapters
    # the author confirms the mapping: n4 only for the last chapter
    st, m = app.route("PUT", base + "/mapping", {}, {"notes": [{"id": "n4", "chapters": [3]}]}, PRINCIPAL, {})
    assert {n["id"]: n for n in m["notes"]}["n4"]["chapters"] == [3]
    with pytest.raises(AkoweError):
        app.route("PUT", base + "/mapping", {}, {"notes": [{"id": "n4", "chapters": [99]}]}, PRINCIPAL, {})
    st, out = app.route("POST", base + "/revise", {}, {}, PRINCIPAL, {})
    p = _wait(app, pid)
    assert p["status"] == "proposed", p
    chs = {c["note"]: c for c in p["changes"]}
    assert set(chs) == {"n1", "n2", "n3", "n4"}
    assert chs["n1"]["replacement"] == "" and chs["n1"]["number"] == 3
    assert chs["n3"]["conflict"] and "locked" in chs["n3"]["conflict"]          # Mara's eyes are 🔒 on the page
    assert chs["n2"]["checks"] and chs["n2"]["checks"][0]["problem"].startswith("Mara never shouts")
    # writer != checker: the writer was AI-1, the check AI-2
    writes = [c for c in fake.calls if c["kind"] == "revise"]
    checks = [c for c in fake.calls if c["kind"] == "check"]
    assert writes and checks and {c["slot"] for c in writes}.isdisjoint({c["slot"] for c in checks})
    assert p["checks"]["independent"] is True
    assert p["summary"] == "4 notes → 4 changes proposed, 0 accepted, 4 waiting for you (1 touch a 🔒 locked detail)."
    # the proposals also wait on the chapter pages (kind "note"), never the conflict
    from akowe import claude_code_book as ccb
    rid3 = chs["n1"]["record_id"]
    info = ccb.chapter_info(app, PRINCIPAL, pid, "main", rid3)
    assert {i["kind"] for i in info["proposals"]} == {"note"} and len(info["proposals"]) == 2
    rid1 = chs["n3"]["record_id"]
    assert not ccb.chapter_info(app, PRINCIPAL, pid, "main", rid1)["proposals"]
    # a conflict is never used without saying so
    with pytest.raises(AkoweError) as ei:
        app.route("POST", base + "/decide", {}, {"accept": [chs["n3"]["id"]]}, PRINCIPAL, {})
    assert ei.value.code == "VERSION_CONFLICT"
    before = {c: app.review._head(pid, "main", chs[c]["record_id"])["version"] for c in chs}  # noqa: SLF001
    st, d = app.route("POST", base + "/decide", {}, {"accept": [chs["n1"]["id"], chs["n4"]["id"], chs["n2"]["id"]],
                                                      "reject": [chs["n3"]["id"]]}, PRINCIPAL, {})
    assert d["summary"] == "4 notes → 4 changes proposed, 3 accepted, 1 left out (1 touch a 🔒 locked detail)."
    assert d["status"] == "done"
    # chapter 3 got ONE new draft with both changes; chapter 2 one; chapter 1 untouched
    h3 = app.review._head(pid, "main", rid3)  # noqa: SLF001
    assert h3["version"] == before["n1"] + 1 and h3["lifecycle"] in ("DRAFT", "VALIDATED")
    t3 = h3["data"]["text"]
    assert "She dreamed" not in t3 and "opened the brass locket" in t3
    assert app.review._head(pid, "main", rid1)["version"] == before["n3"]  # noqa: SLF001
    # the approved text is still the author's until they approve the new draft
    from akowe.fact_checks import book_texts
    by_cid = {c["chapter_id"]: c for c in book_texts(app.engine, PRINCIPAL, pid, "main")}
    assert by_cid["ch3"]["approved"] is False and by_cid["ch1"]["approved"] is True


def test_map_falls_back_to_akowes_guess_when_the_ai_fails(tmp_path):
    app, fake, pid = _book(tmp_path, bible=False)
    fake.fail_kind["map"] = ["INVALID_INPUT"]
    nf.start_map(app, PRINCIPAL, pid, "main", {"notes": "Chapter 2 drags\nsomething vague"})
    m = _wait(app, pid)
    assert m["status"] == "mapped" and "Akọwe’s own guess" in m["message"]
    by = {n["id"]: n for n in m["notes"]}
    assert by["n1"]["chapters"] == [2] and by["n1"]["confirmed"]
    assert by["n2"]["chapters"] == [] and not by["n2"]["confirmed"]


def test_malformed_ai_answers_give_no_changes(tmp_path):
    app, fake, pid = _book(tmp_path, bible=False)
    fake.malformed = True
    nf.start_map(app, PRINCIPAL, pid, "main", {"notes": "cut the dream in ch 3"})
    m = _wait(app, pid)
    assert m["notes"][0]["chapters"] == [3]  # Akọwe's own guess stands; the junk is ignored
    nf.start_revise(app, PRINCIPAL, pid, "main", {})
    p = _wait(app, pid)
    assert p["status"] == "proposed" and p["changes"] == []
    assert p["summary"].startswith("1 note → 0 changes proposed")


def test_one_ai_only_says_the_check_was_not_independent(tmp_path):
    app, fake, pid = _book(tmp_path, second=False, bible=False)
    nf.start_map(app, PRINCIPAL, pid, "main", {"notes": "cut the dream in ch 3"})
    _wait(app, pid)
    nf.start_revise(app, PRINCIPAL, pid, "main", {})
    p = _wait(app, pid)
    assert p["changes"] and p["checks"]["independent"] is False
    assert "Only the AI that wrote the changes" in p["checks"]["note"]


def test_revise_needs_a_confirmed_note_and_interrupted_state(tmp_path):
    app, fake, pid = _book(tmp_path, bible=False)
    with pytest.raises(AkoweError):
        nf.start_revise(app, PRINCIPAL, pid, "main", {})
    nf.start_map(app, PRINCIPAL, pid, "main", {"notes": "Chapter 2 drags"})
    _wait(app, pid)
    nf.edit_mapping(app, PRINCIPAL, pid, "main", {"notes": [{"id": "n1", "confirmed": False}]})
    with pytest.raises(AkoweError):
        nf.start_revise(app, PRINCIPAL, pid, "main", {})
    st = nf.get(app.store, pid, "main")
    st["status"] = "revising"
    nf._put(app.store, pid, "main", st)  # noqa: SLF001 - as if Akọwe stopped mid-way
    assert nf.public(app, pid, "main")["status"] == "interrupted"
    st, out = app.route("DELETE", f"/api/projects/{pid}/branches/main/notes-fix", {}, None, PRINCIPAL, {})
    assert out["status"] == "idle"
    _ = book_text
