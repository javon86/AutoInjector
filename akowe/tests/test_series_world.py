"""📚 Series follow-ups: places, items and groups change book by book (series_world.py); 📚 Start a sequel from the
📘 book page (GET/POST …/binder/series/sequel); the series travels inside the book file (series_package.py)."""
from __future__ import annotations

import copy
import io
import json
import zipfile

import pytest

from akowe import binder, book_bible, book_package, chapter_brief, series, series_package, series_world as sw
from akowe.book_path import BookPath
from akowe.errors import AkoweError

from test_autobook import make_app, no_provider_sleep  # noqa: F401
from test_series import BR, book1, key_of, wait_job, world  # noqa: F401 - fixtures


def _fact(subject, name):
    return {"subject_id": subject, "predicate": "entity.name", "value": name, "assertion_type": "FACT",
            "effective_from": None, "effective_to": None, "source_refs": []}


@pytest.fixture
def book(book1):
    """Book 1 with its place (Gullhaven Harbor), plus an item (the Resonance Key) and a group (the Harbour Board)."""
    app, fake, b, pid = book1
    bp = BookPath(app.engine, "author", pid, BR)
    bp.create("A12", {"concept": "The Resonance Key"}, manual_candidate={
        "concept": "The Resonance Key", "attributes": {"properties": "A brass key that hums near hidden doors",
                                                       "origin": "Forged by the first lamplighter"},
        "linked_refs": [], "protected_fact_flags": [], "facts": [_fact("resonance-key", "The Resonance Key")]})
    bp.create("A06", {"concept": "The Harbour Board"}, manual_candidate={
        "concept": "The Harbour Board", "attributes": {"membership": "Twelve captains", "hierarchy": "Harbourmaster Oyo",
                                                       "goals": "Keep the harbour open"},
        "linked_refs": [], "protected_fact_flags": [], "facts": [_fact("harbour-board", "The Harbour Board")]})
    return app, fake, b, pid


def tkey(app, pid, name, kind=None):
    s = series.linked(app.store, series.of_book(app.store, pid, BR))
    return next(k for k, t in s["things"].items() if t["name"] == name and (kind is None or t["kind"] == kind))


# ---------------------------------------------------------------------------------------------- pure: deltas, as of
def _s():
    return {"id": "ser-abcdef", "books": [{"number": 1, "project_id": "p1"}, {"number": 2, "project_id": "p2"},
                                          {"number": 3, "project_id": "p3"}],
            "characters": {},
            "things": {
                "p1": {"kind": "place", "name": "Gullhaven", "first_book": 1, "records": {"p1": "x"},
                       "fixed": {"name": "Gullhaven", "description": "a grey harbour town"},
                       "base": {"ruler": "the old council", "look": "grey roofs"}},
                "i1": {"kind": "item", "name": "The Resonance Key", "first_book": 1, "records": {"p1": "y"},
                       "fixed": {"name": "The Resonance Key"}, "base": {"holder": "the lighthouse"}},
                "g1": {"kind": "group", "name": "The Harbour Board", "first_book": 2, "records": {"p2": "z"},
                       "fixed": {"name": "The Harbour Board", "symbol": "a gull on blue"}, "base": {}}},
            "thing_changes": {
                "1": {"p1": {"delta": {"ruler": ["the Salt Guild"], "damage": ["the north wall burned"],
                                       "description": "now a city"}},
                      "i1": {"delta": {"holder": ["Mara Vell"], "powers_gained": ["opens hidden doors", "sings"]}}},
                "2": {"p1": {"delta": {"damage": ["the north wall rebuilt"], "danger": ["deadly at night"]}},
                      "i1": {"delta": {"powers_lost": ["sings"], "condition": ["cracked"]}},
                      "g1": {"delta": {"leader": ["Captain Ade"], "enemies": ["the Salt Guild"]}}}},
            "thing_proposals": {"3": {"p1": {"delta": {"ruler": ["the rebels"]}}}}}


def test_place_item_group_state_as_of_book_n():
    s = _s()
    st = sw.state_as_of(s, "p1", 1, "start")
    assert st["now"]["ruler"]["text"] == "the old council" and st["now"]["ruler"]["base"] and not st["changed"]
    end1 = sw.state_as_of(s, "p1", 1, "end")
    assert end1["now"]["ruler"]["text"] == "the Salt Guild" and end1["now"]["ruler"]["book"] == 1
    assert [e["text"] for e in end1["lists"]["damage"]] == ["the north wall burned"]
    assert sw.state_as_of(s, "p1", 2, "start")["now"] == end1["now"]  # start of 2 = end of 1
    end2 = sw.state_as_of(s, "p1", 2, "end")
    assert [e["text"] for e in end2["lists"]["damage"]] == ["the north wall burned", "the north wall rebuilt"]
    assert sw.state_words(end2)["Danger level"] == "deadly at night"
    # a proposal (book 3) is never used before it is approved
    assert sw.state_as_of(s, "p1", 3, "end")["now"]["ruler"]["text"] == "the Salt Guild"
    # the fixed layer is not a category: "description" in a delta is dropped
    assert "description" not in sw.approved(s, 1, "p1")
    # an item's powers: gained and lost like a character's belongings
    i2 = sw.state_as_of(s, "i1", 2, "end")
    assert [e["text"] for e in i2["powers"]] == ["opens hidden doors"] and i2["now"]["holder"]["text"] == "Mara Vell"
    assert sw.state_words(i2)["Powers lost"] == "sings" and i2["now"]["condition"]["text"] == "cracked"
    # a group of book 2
    g = sw.state_as_of(s, "g1", 2, "end")
    assert g["now"]["leader"]["text"] == "Captain Ade" and sw.state_words(g)["Enemies"] == "the Salt Guild"
    assert sw.delta_words("group", sw.approved(s, 2, "g1")) == "Leader: Captain Ade · Enemies: the Salt Guild"


def test_clean_and_merge_thing_deltas():
    d = sw.clean_delta("place", {"ruler": "the Guild", "name": "New name", "origin": "x",
                                    "residents": ["Ade moved in", "ade moved in!"], "holder": ["not a place cat"]})
    assert set(d) == set(sw.cat_keys("place")) and d["ruler"] == [{"text": "the Guild", "chapter": None}]
    assert len(d["residents"]) == 1
    m = sw.merge_delta("place", d, {"residents": ["Bola left"], "ruler": ["the Guild"]})
    assert [e["text"] for e in m["residents"]] == ["Ade moved in", "Bola left"] and len(m["ruler"]) == 1


# ---------------------------------------------------------------------------------------------- linking, proposals
def _script(pid_chapter=""):
    return {"character_changes": [
        {"name": "Mara Vell", "appearance": [], "items_gained": [{"text": "the Resonance Key", "chapter": "ch2"}],
         "items_lost": [], "abilities_gained": [], "abilities_lost": [], "relationships": [], "status": []}],
        "thing_changes": [
            {"name": "Gullhaven Harbor", "kind": "place", "changes": [
                {"category": "ruler", "text": "the Salt Guild", "chapter": "ch3"},
                {"category": "look", "text": "half the docks burned black", "chapter": "ch3"},
                {"category": "name", "text": "Gullhaven Ruins", "chapter": "ch3"}]},  # fixed: never kept
            {"name": "The Harbour Board", "kind": "group", "changes": [
                {"category": "leader", "text": "Captain Ade", "chapter": "ch4"}]},
            {"name": "Atlantis", "kind": "place", "changes": [{"category": "ruler", "text": "x", "chapter": ""}]}]}


def test_things_are_linked_with_a_fixed_layer(book):
    app, _fake, _b, pid = book
    s = series.linked(app.store, series.of_book(app.store, pid, BR))
    kinds = {t["name"]: t["kind"] for t in s["things"].values()}
    assert kinds.get("Gullhaven Harbor") == "place" and kinds.get("The Resonance Key") == "item"
    assert kinds.get("The Harbour Board") == "group"
    key = tkey(app, pid, "The Resonance Key")
    assert s["things"][key]["fixed"]["origin"] == "Forged by the first lamplighter"
    g = s["things"][tkey(app, pid, "The Harbour Board")]
    assert g["base"]["leader"] == "Harbourmaster Oyo"
    v = series.view(app, pid, BR)
    assert {t["kind"] for t in v["things"]} == {"place", "item", "group"} and v["thing_categories"]["item"]


def test_find_changes_proposes_place_item_group_changes_and_links_items(book):
    app, fake, _b, pid = book
    fake.series_script = [_script()]
    j = wait_job(app, series.start_find(app, "author", pid, BR))
    assert j["status"] == "done", j
    msg = j["results"][-1]["message"]
    assert "2 place(s), item(s) or group(s)" in msg and "Atlantis" in msg
    ctx = fake.prompts["series_changes"][-1][1]
    assert any(t["name"] == "Gullhaven Harbor" and "ruler" in t["categories"] for t in ctx["things"])
    s = series.of_book(app.store, pid, BR)
    place, grp, item = tkey(app, pid, "Gullhaven Harbor"), tkey(app, pid, "The Harbour Board"), \
        tkey(app, pid, "The Resonance Key")
    prop = s["thing_proposals"]["1"][place]["delta"]
    assert prop["ruler"][0]["text"] == "the Salt Guild" and "name" not in prop
    assert not s["thing_changes"]  # nothing used before the author approves
    assert (sw.state_as_of(s, place, 1, "end")["now"]["ruler"] or {}).get("text") != "the Salt Guild"
    # ✔ approve the place: its look changed -> a picture for book 1 is waiting
    out = series.approve(app.store, pid, BR, {"key": place})
    assert out["kind"] == "place" and out["portrait_needed"]
    s = series.of_book(app.store, pid, BR)
    assert sw.state_as_of(s, place, 1, "end")["now"]["ruler"]["text"] == "the Salt Guild"
    assert place in s["thing_picture_waiting"]["1"]
    # ✕ dismiss the group, ✏ edit it by hand
    series.dismiss(app.store, pid, BR, {"key": grp})
    s = series.of_book(app.store, pid, BR)
    assert grp not in s["thing_proposals"]["1"]
    series.edit(app.store, pid, BR, {"key": grp, "delta": {"leader": ["Captain Bola"], "allies": ["the Watch"]}})
    with pytest.raises(AkoweError) as e:
        series.edit(app.store, pid, BR, {"key": grp, "delta": {"symbol": "a red gull"}})
    assert "fixed for the whole series" in e.value.errors[0]["message"]
    with pytest.raises(AkoweError) as e:
        series.approve(app.store, pid, BR, {"key": grp})
    assert "no proposal" in e.value.errors[0]["message"]
    # ✔ approve Mara: she gained the Resonance Key -> the key's own page: holder = Mara Vell (book 1)
    out = series.approve(app.store, pid, BR, {"key": key_of(app, pid, "Mara Vell")})
    assert out["linked_items"] == ["The Resonance Key"] and "holder" in out["message"]
    s = series.of_book(app.store, pid, BR)
    assert sw.state_as_of(s, item, 1, "end")["now"]["holder"]["text"] == "Mara Vell"
    v = series.view(app, pid, BR)
    assert v["proposals_here"] == 0 and v["portraits_waiting"] == 1


def test_binder_place_item_group_pages_show_the_series(book):
    app, _fake, _b, pid = book
    place, item, grp = (tkey(app, pid, n) for n in ("Gullhaven Harbor", "The Resonance Key", "The Harbour Board"))
    series.ensure(app.store, pid, BR)
    series.edit(app.store, pid, BR, {"key": place, "delta": {"ruler": ["the Salt Guild"], "danger": ["deadly"],
                                                             "residents": ["the refugees of Tarn"]}})
    series.edit(app.store, pid, BR, {"key": item, "delta": {"holder": ["Mara Vell"], "location": ["the vault"]}})
    series.edit(app.store, pid, BR, {"key": grp, "delta": {"leader": ["Captain Ade"], "enemies": ["the Guild"]}})
    data = binder.build(app, pid, BR)  # this book: the strip, the fields as the book has them
    pp = next(p for p in data["pages"] if p["template"] == "7")
    assert pp["series"]["kind"] == "place" and pp["series"]["state"]["Ruler or owner"] == "the Salt Guild"
    assert "series:" not in str(pp["sections"]["7.2"]["fields"]["7.2.6"].get("source"))
    d1 = binder.build(app, pid, BR, as_of=1)  # 📖 as of book 1: the fields show the state, read only
    pp = next(p for p in d1["pages"] if p["template"] == "7")
    f = pp["sections"]["7.2"]["fields"]["7.2.6"]
    assert f["value"] == "the Salt Guild" and f["source"] == "series:as_of_book_1" and "edit" not in f
    assert "refugees of Tarn" in pp["sections"]["7.7"]["fields"]["7.7.1"]["value"]
    ip = next(p for p in d1["pages"] if p["template"] == "8B" and p["title"] == "The Resonance Key")
    assert ip["sections"]["8B.2"]["fields"]["8B.2.4"]["value"] == "Mara Vell"
    assert ip["sections"]["8B.8"]["fields"]["8B.8.6"]["value"] == "the vault"
    gp = next(p for p in d1["pages"] if p["template"] == "8C" and p["title"] == "The Harbour Board")
    assert gp["sections"]["8C.3"]["fields"]["8C.3.3"]["value"] == "Captain Ade"
    assert "the Guild" in gp["sections"]["8C.5"]["fields"]["8C.5.3"]["value"]
    assert [b["number"] for b in gp["series"]["strip"]] == [1] and gp["series"]["strip"][0]["words"]
    html, _d = binder.export_html(app, pid, BR, as_of=1)
    assert "Through the series" in html and "the Salt Guild" in html and "Captain Ade" in html
    docx, _name = binder.export_docx(app, pid, BR, as_of=1)
    with zipfile.ZipFile(io.BytesIO(docx)) as z:
        assert "Captain Ade" in z.read("word/document.xml").decode("utf-8")
    bb = book_bible.build(app, pid, BR)
    assert any(t["name"] == "The Harbour Board" and t["changes"] for t in bb["series"]["things"].values())
    assert "The Harbour Board (Group) — through the series" in book_bible.render_markdown(bb)


def test_place_picture_per_book_waits_then_is_made(book):
    app, _fake, b, pid = book
    place = tkey(app, pid, "Gullhaven Harbor")
    series.ensure(app.store, pid, BR)
    b.sd_on = False
    series.edit(app.store, pid, BR, {"key": place, "delta": {"look": ["half the docks burned black"]}})
    res = series.make_portraits(app, "author", pid, BR)
    assert res["down"] and res["made"] == 0
    s = series.of_book(app.store, pid, BR)
    assert s["thing_picture_waiting"]["1"][place]["code"] == "SD_NOT_CONNECTED"  # on the to-make list
    from akowe import book_pictures
    assert book_pictures.summary(app.store, pid, BR)["series_portraits"] == 1
    b.sd_on = True
    j = wait_job(app, series.start_portraits(app, "author", pid, BR, {}))
    assert j["status"] == "done" and j["results"][-1]["made"] == 1, j
    req = b.requests[-1]
    assert req["purpose"] == "scene" and "half the docks burned black" in req["prompt"] and "characterLock" not in req
    s = series.of_book(app.store, pid, BR)
    assert s["thing_pictures"]["1"][place]["asset_id"] and not s["thing_picture_waiting"]["1"]
    d1 = binder.build(app, pid, BR, as_of=1)
    pp = next(p for p in d1["pages"] if p["template"] == "7")
    assert pp["pics"]["7.1.1"]["url"] == pp["series"]["strip"][0]["portrait"]["url"]
    assert binder.picture_bytes(app, pid, BR, pp["pics"]["7.1.1"]["url"])


def test_sequel_carries_places_items_groups_at_their_end_state(book):
    app, fake, _b, pid = book
    place, item = tkey(app, pid, "Gullhaven Harbor"), tkey(app, pid, "The Resonance Key")
    series.ensure(app.store, pid, BR)
    series.edit(app.store, pid, BR, {"key": place, "delta": {"ruler": ["the Salt Guild"]}})
    series.edit(app.store, pid, BR, {"key": item, "delta": {"holder": ["Mara Vell"]}})
    st = series.sequel_status(app, pid, BR)
    assert st["possible"] and st["next_number"] == 2
    out = series.start_sequel(app, "author", pid, BR, {"author_confirms": True, "pictures": False})
    app.autobook.wait_for(out["run"]["id"], 120)
    run = app.autobook.get(out["run"]["id"])
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid2 = run["project_id"]
    s = series.of_book(app.store, pid2, BR)
    assert pid2 in s["things"][place]["records"]  # the sequel's harbour is the same series place
    assert pid2 in s["things"][item]["records"]
    st2 = sw.state_as_of(s, place, 2, "start")
    assert st2["now"]["ruler"]["text"] == "the Salt Guild" and st2["now"]["ruler"]["book"] == 1
    brief = series.world_brief(app.store, pid2, BR)
    assert any(x["name"] == "Gullhaven Harbor" and x["Ruler or owner"] == "the Salt Guild" for x in brief)
    bp2 = BookPath(app.engine, "author", pid2, BR)
    outline = bp2.outline()
    cid = bp2.outline_chapters(outline)[0]["chapter_id"]
    wb, _meta = chapter_brief.build(app.store, pid2, BR, outline, cid)
    assert wb.get("series_world") and any("places, items and groups" in r for r in wb["rules"])
    d2 = binder.build(app, pid2, BR)
    pp = next(p for p in d2["pages"] if p["template"] == "7" and p["title"] == "Gullhaven Harbor")
    assert [b["number"] for b in pp["series"]["strip"]] == [1, 2]
    assert pp["series"]["state"]["Ruler or owner"] == "the Salt Guild"
    # book 2 exists now: the sequel button of book 1 says so in plain words
    st = series.sequel_status(app, pid, BR)
    assert not st["possible"] and "Book 2 of this series already exists" in st["why"]


# ---------------------------------------------------------------------------------------------- 📘 the book page button
def test_book_page_sequel_route(book1):
    app, _fake, _b, pid = book1
    st, out = binder.route(app, "GET", ["series", "sequel"], {}, None, "author", pid, BR)
    assert st == 200 and out["possible"] is True and out["why"] is None and out["next_number"] == 2
    app.autobook._ai_configured = lambda: False  # noqa: SLF001 - no AI connected
    st, out = binder.route(app, "GET", ["series", "sequel"], {}, None, "author", pid, BR)
    assert out["possible"] is False and "No AI is connected" in out["why"]
    v = series.view(app, pid, BR)
    assert v["sequel"]["possible"] is False
    with pytest.raises(AkoweError) as e:  # the same route as the Book Bible's: consent first
        binder.route(app, "POST", ["series", "sequel"], {}, {}, "author", pid, BR)
    assert e.value.code == "APPROVAL_REQUIRED"
    st, out = binder.route(app, "GET", ["series", "sequel"], {}, None, "author", "proj-gone", BR)
    assert out["possible"] is False and out["why"]


# ---------------------------------------------------------------------------------------------- the book file
def _series_book(app, pid):
    """Book 1 in a series with one approved change of Mara and one of the harbour."""
    series.ensure(app.store, pid, BR)
    series.edit(app.store, pid, BR, {"key": key_of(app, pid, "Mara Vell"), "delta": {"status": ["keeper of the light"]}})
    series.edit(app.store, pid, BR, {"key": tkey(app, pid, "Gullhaven Harbor"), "delta": {"ruler": ["the Salt Guild"]}})
    series.rename(app.store, pid, BR, {"name": "The Gullhaven Books"})
    return series.of_book(app.store, pid, BR)


def test_book_file_round_trip_restores_the_series_on_another_computer(book1, tmp_path):
    app, _fake, _b, pid = book1
    s1 = _series_book(app, pid)
    data = book_package.build(app, pid)
    pkg = book_package.read(data)
    assert pkg["series"]["series"]["id"] == s1["id"] and pkg["manifest"]["files"].get("series.json")
    other = make_app(tmp_path, name="other-computer")
    res = book_package.import_package(other, data, "author")
    assert res["series"]["action"] == "restored" and "The Gullhaven Books" in res["series"]["message"]
    new = res["project_id"]
    s2 = series.of_book(other.store, new, BR)
    assert s2["id"] == s1["id"] and series.number_of(s2, new) == 1 and not s2.get("virtual")
    k = key_of(other, new, "Mara Vell")
    assert series.state_as_of(s2, k, 1, "end")["status"]["text"] == "keeper of the light"
    place = tkey(other, new, "Gullhaven Harbor")
    assert sw.state_as_of(s2, place, 1, "end")["now"]["ruler"]["text"] == "the Salt Guild"
    assert new in s2["characters"][k]["records"] and pid not in s2["characters"][k]["records"]
    # opening it a second time on that computer: the same series is merged, never a second one
    res2 = book_package.import_package(other, data, "author")
    assert res2["series"]["action"] == "merged" and "already in this Akọwe" in res2["series"]["message"]
    assert series.member(other.store, res2["project_id"]) is None  # the copy is a book on its own
    keys = [r["key"] for r in other.store.query("SELECT key FROM settings WHERE key LIKE 'series:%'")]
    assert keys == [f"series:{s1['id']}"]
    assert [b["project_id"] for b in series.books(series.get(other.store, s1["id"]))] == [new]


def test_book_file_merges_with_an_existing_series_and_reports_conflicts(book1):
    app, _fake, _b, pid = book1
    s1 = _series_book(app, pid)
    data = book_package.build(app, pid)
    # meanwhile, on this computer: the harbour's ruler changes in book 1 (later), and a new proposal waits
    place = tkey(app, pid, "Gullhaven Harbor")
    series.edit(app.store, pid, BR, {"key": place, "delta": {"ruler": ["the rebels"], "damage": ["the gate fell"]}})
    # the book was deleted here, then opened from its file: same series id -> merged
    app.store.delete_project(pid)
    pkg = book_package.read(data)
    pkg["series"]["series"]["thing_changes"]["1"][place]["delta"]["residents"] = [{"text": "Tarn's refugees"}]
    pkg["series"]["series"]["thing_changes"]["1"][place]["at"] = "2000-01-01T00:00:00Z"  # older than the one here
    res = book_package.import_package(app, data, "author", pkg=pkg)
    sres = res["series"]
    assert sres["action"] == "merged" and len(sres["conflicts"]) == 1
    assert "kept “the rebels”" in sres["conflicts"][0] and "the Salt Guild" in sres["conflicts"][0]
    assert "did not agree" in sres["message"]
    new = res["project_id"]
    s = series.of_book(app.store, new, BR)
    assert s["id"] == s1["id"] and series.number_of(s, new) == 1  # the opened book took its place again
    d = sw.approved(s, 1, place)
    assert d["ruler"][-1]["text"] == "the rebels"  # the newer approved change wins the conflict
    assert [e["text"] for e in d["residents"]] == ["Tarn's refugees"] and d["damage"]  # the rest is joined
    keys = [r["key"] for r in app.store.query("SELECT key FROM settings WHERE key LIKE 'series:%'")]
    assert keys == [f"series:{s1['id']}"]


def test_old_book_file_without_series_and_a_damaged_series_part(book1, tmp_path):
    app, _fake, _b, pid = book1
    data = book_package.build(app, pid)  # a book on its own: no series.json
    assert book_package.read(data)["series"] is None
    other = make_app(tmp_path, name="other")
    res = book_package.import_package(other, data, "author")
    assert res["series"]["action"] == "none" and series.member(other.store, res["project_id"]) is None
    # a damaged series part never stops the book from opening
    _series_book(app, pid)
    pkg = book_package.read(book_package.build(app, pid))
    pkg["series"] = {"format": "akowe-series", "schema_version": 1, "series": {"id": "not a series"}}
    res = book_package.import_package(other, b"", "author", pkg=pkg)
    assert res["series"]["action"] == "failed" and "could not be restored" in res["series"]["message"]
    assert other.store.project(res["project_id"]) is not None
    assert series.member(other.store, res["project_id"]) is None
    assert series.of_book(other.store, res["project_id"], BR)["virtual"]


def test_book_open_says_what_happened_to_the_series(book1, tmp_path):
    app, _fake, _b, pid = book1
    _series_book(app, pid)
    data = book_package.build(app, pid)
    other = make_app(tmp_path, name="laptop")
    out = other.opener.import_bytes("author", data)
    assert "📚 Its series “The Gullhaven Books” came with it" in out["message"]
    assert out["series"]["action"] == "restored"


def test_series_record_clean_refuses_bad_shapes():
    with pytest.raises(series_package.SeriesProblem):
        series_package.clean_record({"format": "akowe-series", "schema_version": 9, "series": {}})
    rec = series_package.clean_record({"format": "akowe-series", "schema_version": 1, "series": {
        "id": "ser-abc123", "books": [{"number": 1, "project_id": "p1"}, {"number": "x"}],
        "things": {"p1": {"kind": "spaceship"}, "p2": {"kind": "place", "name": "A"}}}})
    assert [b["number"] for b in rec["books"]] == [1] and list(rec["things"]) == ["p2"]
    cur = copy.deepcopy(_s())
    inc = copy.deepcopy(_s())
    inc["thing_changes"]["2"]["g1"] = {"delta": {"leader": ["Captain Bola"], "allies": ["the Watch"]}, "at": "9"}
    cur["thing_changes"]["2"]["g1"]["at"] = "1"
    out, conflicts, _notes, _j = series_package.merge(_NoStore(), cur, inc, "p9")
    assert len(conflicts) == 1 and "Captain Bola" in conflicts[0]
    d = sw.approved(out, 2, "g1")
    assert d["leader"][-1]["text"] == "Captain Bola" and {e["text"] for e in d["allies"]} == {"the Watch"}
    assert {e["text"] for e in d["enemies"]} == {"the Salt Guild"}  # the older copy's other entries are kept
    json.dumps(out)


class _NoStore:
    def project(self, pid):
        return None
