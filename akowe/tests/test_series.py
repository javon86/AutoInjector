"""📚 Series progression (series.py): the fixed layer (personality, voice, name, origin) never changes through the
books; each book stores only its changes (appearance, items, abilities, relationships, status) and a character's state
"as of book N" applies them in order; ✨ Find what changed proposes, only the author approves; 📚 Start a sequel makes
the next book from the END of this one; a new look gets a new portrait for that book with the same 🔒 lock (earlier
portraits kept); the binder shows the "Through the series" strip and the whole binder "as of book N"; a single book is
unchanged."""
from __future__ import annotations

import copy
import time

import pytest

from akowe import binder, book_bible, characters as chars_mod, forge, series
from akowe.book_path import BookPath
from akowe.errors import AkoweError

from autobook_fake import BookFakeAI
from test_autobook import make_app, no_provider_sleep, run_book, steps  # noqa: F401
from test_book_pictures import PictureBridge

BR = "main"


def wait_job(app, job, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = app.review._jobs[job["job_id"]].public()
        if j["status"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.05)
    raise AssertionError("job did not finish")


@pytest.fixture
def world(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    b = PictureBridge()
    forge.save_bridge_settings(app, {"url": b.url})
    yield app, fake, b
    b.close()


@pytest.fixture
def book1(world):
    app, fake, b = world
    run = run_book(app, {"genre": "Mystery", "length": "short_story", "pictures": False})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    return app, fake, b, run["project_id"]


def key_of(app, pid, name):
    s = series.linked(app.store, series.of_book(app.store, pid, BR))
    return next(k for k, c in s["characters"].items() if c["name"] == name)


# ---------------------------------------------------------------------------------------------- pure: deltas
def _series():
    return {"id": "ser-x", "books": [{"number": 1, "project_id": "p1"}, {"number": 2, "project_id": "p2"},
                                     {"number": 3, "project_id": "p3"}],
            "characters": {"c1": {"name": "Ade", "first_book": 1, "records": {"p1": "r1", "p2": "r2", "p3": "r3"},
                                  "fixed": {"name": "Ade", "traits": "stubborn, kind"},
                                  "base": {"appearance": "Tall, two brown eyes.",
                                           "relationships": [{"with": "Bola", "text": "friends"}]}}},
            "changes": {
                "1": {"c1": {"delta": {"appearance": [{"text": "lost his left eye", "chapter": "ch7"}],
                                       "items_gained": ["the Resonance Key", "a lantern"],
                                       "abilities_gained": [{"text": "can hear the city's voices"}],
                                       "relationships": [{"with": "Bola", "text": "now his enemy"}]}}},
                "2": {"c1": {"delta": {"items_lost": ["the lantern"], "status": ["Captain of the Watch"],
                                       "appearance": ["grey streak in his hair"]}}},
            },
            "proposals": {"3": {"c1": {"delta": {"items_lost": ["the Resonance Key"]}}}}, "portraits": {},
            "portrait_waiting": {}}


def test_state_as_of_book_n_applies_the_deltas_in_order():
    s = _series()
    start1 = series.state_as_of(s, "c1", 1, "start")
    assert start1["appearance_changes"] == [] and start1["items"] == [] and not start1["changed"]
    assert start1["relationships"][0]["text"] == "friends" and start1["relationships"][0]["base"]
    end1 = series.state_as_of(s, "c1", 1, "end")
    assert [e["text"] for e in end1["appearance_changes"]] == ["lost his left eye"]
    assert [e["text"] for e in end1["items"]] == ["the Resonance Key", "a lantern"]
    assert end1["relationships"] == [{"with": "Bola", "text": "now his enemy", "chapter": None, "book": 1}]
    start2 = series.state_as_of(s, "c1", 2, "start")
    assert start2["items"] == end1["items"]  # the start of book 2 is the end of book 1
    end2 = series.state_as_of(s, "c1", 2, "end")
    assert [e["text"] for e in end2["items"]] == ["the Resonance Key"]  # "the lantern" lost in book 2
    assert end2["status"]["text"] == "Captain of the Watch" and end2["status"]["book"] == 2
    assert [e["text"] for e in end2["appearance_changes"]] == ["lost his left eye", "grey streak in his hair"]
    # a proposal (book 3) is never applied before it is approved
    end3 = series.state_as_of(s, "c1", 3, "end")
    assert [e["text"] for e in end3["items"]] == ["the Resonance Key"]
    look = series.appearance_text(end2)
    assert look.startswith("Tall, two brown eyes.") and "lost his left eye" in look and "grey streak" in look


def test_clean_delta_keeps_only_the_changeable_layer():
    d = series.clean_delta({"appearance": "a scar", "traits": "now cruel", "voice": {"rhythm": "x"},
                            "relationships": [{"text": "no name"}, {"with": "Bola", "text": "enemy"}],
                            "items_gained": [{"text": "a key"}, {"text": "A key!"}]})
    assert set(d) == set(series.CAT_KEYS)
    assert d["appearance"] == [{"text": "a scar", "chapter": None}]
    assert d["relationships"] == [{"text": "enemy", "chapter": None, "with": "Bola"}]
    assert len(d["items_gained"]) == 1  # the same thing twice is kept once
    merged = series.merge_delta(d, {"appearance": ["a limp"], "items_gained": ["a key"]})
    assert [e["text"] for e in merged["appearance"]] == ["a scar", "a limp"] and len(merged["items_gained"]) == 1


# ---------------------------------------------------------------------------------------------- single book
def test_a_single_book_is_unchanged(book1):
    app, _fake, _b, pid = book1
    assert series.member(app.store, pid) is None
    data = binder.build(app, pid, BR)
    assert data["series"]["in_series"] is False and data["series"]["number"] == 1
    assert all("series" not in p for p in data["pages"])
    for p in data["pages"]:
        for sec in p["sections"].values():
            assert not any(str(f.get("source", "")).startswith("series:") for f in sec["fields"].values())
    v = series.view(app, pid, BR)
    assert v["in_series"] is False and len(v["books"]) == 1 and v["characters"]
    assert all(c["strip"][0]["changes"] is None for c in v["characters"])
    assert "series" not in book_bible.build(app, pid, BR)  # nothing stored, nothing added
    assert series.member(app.store, pid) is None


# ---------------------------------------------------------------------------------------------- ✨ find what changed
def test_find_changes_makes_proposals_that_need_approval(book1):
    app, fake, _b, pid = book1
    job = series.start_find(app, "author", pid, BR)
    j = wait_job(app, job)
    assert j["status"] == "done", j
    assert "approve" in j["results"][-1]["message"] and "Nobody Here" in j["results"][-1]["message"]
    s = series.of_book(app.store, pid, BR)
    assert series.member(app.store, pid)["number"] == 1  # the book is now book 1 of its series
    k = key_of(app, pid, "Mara Vell")
    prop = s["proposals"]["1"][k]["delta"]
    assert "personality" not in prop and prop["appearance"][0]["text"].startswith("a pale scar")
    assert not s["changes"]  # nothing approved yet
    assert not series.state_as_of(s, k, 1, "end")["changed"]
    # the AI was told the fixed layer never changes
    ctx = fake.prompts["series_changes"][-1][1]
    assert any(c["name"] == "Mara Vell" and "fixed_never_changes" in c for c in ctx["characters"])
    out = series.approve(app.store, pid, BR, {"key": k})
    assert out["portrait_needed"] is True
    s = series.of_book(app.store, pid, BR)
    assert k not in s["proposals"]["1"] and s["changes"]["1"][k]["by"] == "author"
    st = series.state_as_of(s, k, 1, "end")
    assert st["changed"] and st["items"][0]["text"] == "the keeper's brass key"
    # a new proposal never replaces the approved change: only what is new is proposed
    series.save_proposals(app.store, pid, BR, {"character_changes": [
        {"name": "Mara Vell", "appearance": [{"text": "a pale scar across the left cheek"}, {"text": "a limp"}]}]})
    s = series.of_book(app.store, pid, BR)
    assert [e["text"] for e in s["proposals"]["1"][k]["delta"]["appearance"]] == ["a limp"]
    series.dismiss(app.store, pid, BR, {"key": k})
    s = series.of_book(app.store, pid, BR)
    assert k not in s["proposals"]["1"] and s["changes"]["1"][k]["delta"]["appearance"]
    with pytest.raises(AkoweError) as e:
        series.approve(app.store, pid, BR, {"key": k})
    assert "no proposal" in e.value.errors[0]["message"]
    with pytest.raises(AkoweError) as e:
        series.edit(app.store, pid, BR, {"key": k, "delta": {"traits": "cruel"}})
    assert "fixed for the whole series" in e.value.errors[0]["message"]


def test_find_changes_needs_written_chapters(world):
    app, _fake, _b = world
    pid = app.engine.bootstrap_project("author", "Empty book")
    with pytest.raises(AkoweError) as e:
        series.start_find(app, "author", pid, BR)
    assert "no written chapters" in e.value.errors[0]["message"]


# ---------------------------------------------------------------------------------------------- fixed layer
def test_fixed_layer_protected_from_an_ai_fix_in_a_later_book(book1):
    app, _fake, _b, pid = book1
    s = series.ensure(app.store, pid, BR)
    k = key_of(app, pid, "Mara Vell")
    rid = s["characters"][k]["records"][pid]
    # book 1 is where Mara comes from: nothing to protect there
    rec = {"module_id": "A01", "record_id": rid, "data": {"attributes": {"traits": "x"}}}
    assert series.protect_fixed(app.store, pid, BR, rec, {"attributes": {"traits": "cruel"}}) == []
    # pretend this book is book 2 and Mara comes from book 1
    s = series.get(app.store, s["id"])
    s["books"][0]["number"] = 2
    series._save(app.store, s)  # noqa: SLF001
    fixed = s["characters"][k]["fixed"]
    payload = {"attributes": {"traits": "now cruel and loud", "background": "born on the moon",
                              "appearance": "a new scar"}}
    notes = series.protect_fixed(app.store, pid, BR, rec, payload)
    assert any("Personality" in n for n in notes)
    assert payload["attributes"]["traits"] == fixed["traits"]
    assert payload["attributes"]["background"] == fixed["background"]
    assert payload["attributes"]["appearance"] == "a new scar"  # changeable: the fix may change it
    # the voice card is fixed too: an AI save keeps it, the author may still change it
    chars_mod.mark_series_fixed(app.store, pid, BR, [rid])
    before = chars_mod.get_entry(app.store, pid, BR, rid)["voice"]
    chars_mod.save_entry(app.store, pid, BR, rid, voice={"rhythm": "totally different"}, by="ai")
    assert chars_mod.get_entry(app.store, pid, BR, rid)["voice"] == before
    chars_mod.save_entry(app.store, pid, BR, rid, voice=dict(before, rhythm="the author's change"), by="author")
    assert chars_mod.get_entry(app.store, pid, BR, rid)["voice"]["rhythm"] == "the author's change"


# ---------------------------------------------------------------------------------------------- 📚 start a sequel
def test_start_a_sequel_copies_the_end_state_and_protects_the_fixed_layer(book1):
    app, fake, b, pid = book1
    series.save_proposals(app.store, pid, BR, {"character_changes": [
        {"name": "Mara Vell", "appearance": [{"text": "lost her left eye", "chapter": "ch3"}],
         "items_gained": [{"text": "the Resonance Key"}], "abilities_gained": [{"text": "hears the city's voices"}],
         "relationships": [{"with": "Tom Reed", "text": "now her enemy"}]}]})
    k = key_of(app, pid, "Mara Vell")
    series.approve(app.store, pid, BR, {"key": k})
    s1 = series.of_book(app.store, pid, BR)
    fixed = copy.deepcopy(s1["characters"][k]["fixed"])
    bible, sequel = series.sequel_bible(app, pid, BR, {})
    mara = next(c for c in bible["characters"] if c["name"] == "Mara Vell")
    assert "lost her left eye" in mara["data"]["attributes"]["appearance"]
    assert mara["data"]["attributes"]["traits"] == fixed["traits"] and mara["voice"] == fixed["voice"]
    assert any(r["with"] == "Tom Reed" and r["tension"] == "now her enemy" for r in mara["sheet"]["relationships"])
    assert bible["plan"] == {} and bible["profile"]["series_number"] == 2 and sequel["number"] == 2
    # a REVISE on a carried-over character: its AI fix must not touch the fixed layer
    fake.verdicts = []
    out = series.start_sequel(app, "author", pid, BR, {"author_confirms": True, "pictures": False})
    assert out["sequel"]["number"] == 2
    app.autobook.wait_for(out["run"]["id"], 120)
    run = app.autobook.get(out["run"]["id"])  # every event (the public view shows the last 60)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid2 = run["project_id"]
    assert any(e.get("code") == "SERIES_SEQUEL" for e in run["events"])
    s = series.of_book(app.store, pid2, BR)
    assert s["id"] == s1["id"] and series.number_of(s, pid2) == 2
    assert [x["number"] for x in series.books(s)] == [1, 2]
    rid2 = s["characters"][k]["records"][pid2]
    rec2 = next(c for c in chars_mod.canon_characters(app.store, pid2, BR) if c["record_id"] == rid2)
    assert rec2["attributes"]["traits"] == fixed["traits"] and rec2["attributes"]["background"] == fixed["background"]
    assert "lost her left eye" in rec2["attributes"]["appearance"]
    e2 = chars_mod.get_entry(app.store, pid2, BR, rid2)
    assert e2["series_fixed"] and e2["voice"] == fixed["voice"]
    assert series.fixed_for_record(app.store, pid2, rid2)["traits"] == fixed["traits"]
    # an AI fix of Mara in book 2 (the fake revises the first attribute it finds): the fixed layer is put back
    from akowe.review import ReviewJob
    bp2 = BookPath(app.engine, "author", pid2, BR)
    head = bp2.rec(rid2)
    data = copy.deepcopy(head["data"])
    data["attributes"] = dict(data["attributes"], identity="Someone else entirely")
    r = bp2.dispatch("A01", "UPDATE", base_ref=head["ref"], payload=data)
    assert r["status"] == "DRAFT", r
    fj = ReviewJob("fix", "author", pid2, BR, [rid2], None)
    app.review._run_fix(fj)  # noqa: SLF001
    new = bp2.rec(rid2)["data"]["attributes"]
    assert new["identity"] == fixed["identity"] and new["traits"] == fixed["traits"], new
    assert fj.results[-1].get("series_fixed")
    # the writer got Mara "as at the start of book 2" (not book 1's version)
    brief, n = series.writer_brief(app.store, pid2, BR)
    assert n == 2 and any(x["name"] == "Mara Vell" and "Resonance Key" in x.get("carries", "") and
                          x["as_of"] == "start of book 2" for x in brief)
    from akowe import chapter_brief
    bp2 = BookPath(app.engine, "author", pid2, BR)
    outline = bp2.outline()
    cid = bp2.outline_chapters(outline)[0]["chapter_id"]
    wb, meta = chapter_brief.build(app.store, pid2, BR, outline, cid)
    assert wb.get("series_state") and any("Series" in r for r in wb["rules"])
    # a finished series book: the AI proposed its changes (proposals only)
    assert any(e.get("code") == "SERIES_CHANGES_PROPOSED" for e in run["events"])
    assert series.of_book(app.store, pid2, BR)["proposals"].get("2")
    assert not series.of_book(app.store, pid2, BR)["changes"].get("2")
    # starting a second "book 2" is refused in plain words
    with pytest.raises(AkoweError) as e:
        series.sequel_bible(app, pid, BR, {})
    assert "book 2 of this series already exists" in e.value.errors[0]["message"]
    # the binder of book 2 shows the strip: book 1 (with what changed) → book 2
    data = binder.build(app, pid2, BR)
    assert data["series"]["in_series"] and data["series"]["number"] == 2
    page = next(p for p in data["pages"] if p["template"] == "5" and p["title"] == "Mara Vell")
    assert [x["number"] for x in page["series"]["strip"]] == [1, 2]
    assert "lost her left eye" in page["series"]["strip"][0]["words"]
    # as of book 1 from book 2: book 1's own pages (read only) with Mara at the END of book 1
    d1 = binder.build(app, pid2, BR, as_of=1)
    assert d1["series"]["viewing"]["number"] == 1 and d1["read_only"]
    p1 = next(p for p in d1["pages"] if p["template"] == "5" and p["title"] == "Mara Vell")
    look = p1["sections"]["5.6"]["fields"]["5.6.1"]
    assert "lost her left eye" in look["value"] and look["source"] == "series:as_of_book_1" and "edit" not in look
    assert "Resonance Key" in p1["sections"]["5.10"]["fields"]["5.10.3"]["value"]
    assert not any("edit" in f for sec in p1["sections"].values() for f in sec["fields"].values())
    with pytest.raises(AkoweError):
        binder.build(app, pid2, BR, as_of=7)
    html, _d = binder.export_html(app, pid2, BR, as_of=1)
    assert "📖 As of book 1" in html and "Through the series" in html and "lost her left eye" in html
    docx, name = binder.export_docx(app, pid2, BR, as_of=1)
    assert docx[:2] == b"PK" and "(as of book 1)" in name
    # the book bible of book 2 carries the series
    bb = book_bible.build(app, pid2, BR)
    assert bb["series"]["number"] == 2 and "Mara Vell" in bb["series"]["characters"]
    assert "Through the series" in book_bible.render_markdown(bb) or "📚 Series" in book_bible.render_markdown(bb)
    # deleting book 1 never loses the series: book 2 still knows what happened in book 1
    app.store.delete_project(pid)
    s = series.of_book(app.store, pid2, BR)
    assert s.get("virtual") is not True and series.state_as_of(s, k, 2, "start")["changed"]
    v = series.view(app, pid2, BR)
    assert v["books"][0]["exists"] is False
    d1 = binder.build(app, pid2, BR, as_of=1)
    assert "not in this Akọwe any more" in d1["series"]["note"]


def test_start_sequel_needs_consent_and_a_real_series(book1):
    app, _fake, _b, pid = book1
    with pytest.raises(AkoweError) as e:
        series.start_sequel(app, "author", pid, BR, {})
    assert e.value.code == "APPROVAL_REQUIRED"
    with pytest.raises(AkoweError) as e:  # a sequel always starts from the book before it
        app.autobook.start("author", {"author_confirms": True, "sequel": {"series_id": "nope", "number": 2}})
    assert "book bible" in e.value.errors[0]["message"]
    with pytest.raises(AkoweError) as e:
        app.autobook.start("author", {"author_confirms": True, "from_bible": {"project_id": pid},
                                      "sequel": {"series_id": "nope", "number": 2}})
    assert "series does not exist" in e.value.errors[0]["message"]
    with pytest.raises(AkoweError) as e:
        series.start_sequel(app, "author", "proj-gone", BR, {"author_confirms": True})
    assert "does not exist" in e.value.errors[0]["message"]
    assert not app.autobook.active()  # nothing was started


def test_broken_series_link_reads_as_a_single_book(book1):
    app, _fake, _b, pid = book1
    app.store.set_setting(f"series_of:{pid}", {"series_id": "ser-gone", "number": 1})
    s = series.of_book(app.store, pid, BR)
    assert s["virtual"] and "missing" in s["problem"]
    data = binder.build(app, pid, BR)
    assert "missing" in data["series"]["problem"]
    s2 = series.ensure(app.store, pid, BR)  # repaired by a new series that holds the book
    assert not s2.get("virtual") and series.member(app.store, pid)["series_id"] == s2["id"]


# ---------------------------------------------------------------------------------------------- 🖼 per-book portraits
def test_new_look_gets_a_portrait_for_that_book_with_the_same_lock(book1):
    app, _fake, b, pid = book1
    k = key_of(app, pid, "Mara Vell")
    series.save_proposals(app.store, pid, BR, {"character_changes": [
        {"name": "Mara Vell", "appearance": [{"text": "lost her left eye"}]}]})
    # the picture maker is down: the portrait waits on the to-make list
    b.sd_on = False
    series.approve(app.store, pid, BR, {"key": k})
    res = series.make_portraits(app, "author", pid, BR)
    assert res["down"] and res["failed"] == 1 and res["made"] == 0
    s = series.of_book(app.store, pid, BR)
    assert k in s["portrait_waiting"]["1"] and s["portrait_waiting"]["1"][k]["code"] == "SD_NOT_CONNECTED"
    from akowe import book_pictures
    assert book_pictures.summary(app.store, pid, BR)["series_portraits"] == 1
    # back up: the lock exists (Part 1 made it), the new portrait uses it and keeps the face
    b.sd_on = True
    b.locks["mara vell"] = {"character": "Mara Vell", "seed": 4242, "id": "lock-1"}
    job = series.start_portraits(app, "author", pid, BR, {})
    j = wait_job(app, job)
    assert j["status"] == "done" and j["results"][-1]["made"] == 1, j
    req = b.requests[-1]
    assert req["characterLock"] == "Mara Vell" and "lost her left eye" in req["prompt"] and req["purpose"] == "portrait"
    s = series.of_book(app.store, pid, BR)
    p = s["portraits"]["1"][k]
    assert p["seed"] == 4242 and p["lock"] == "Mara Vell" and not s["portrait_waiting"]["1"]
    first = p["asset_id"]
    # a later change of look in the same book: a new portrait, the earlier one is kept
    series.edit(app.store, pid, BR, {"key": k, "delta": {"appearance": ["lost her left eye", "hair cut short"]}})
    assert series.make_portraits(app, "author", pid, BR)["made"] == 1
    s = series.of_book(app.store, pid, BR)
    assert s["portraits"]["1"][k]["asset_id"] != first
    assert any(o["asset_id"] == first for o in s["portraits_old"])
    strip = series.strip(app.store, s, k)
    assert strip[0]["portrait"]["made_for_book"] and strip[0]["portrait"]["url"].endswith(
        f"/assets/{s['portraits']['1'][k]['asset_id']}/1")
    # the binder "as of book 1" shows that portrait on the page and in the cast list
    d = binder.build(app, pid, BR, as_of=1)
    page = next(p for p in d["pages"] if p["template"] == "5" and p["title"] == "Mara Vell")
    assert page["pics"]["5.1.1"]["url"] == strip[0]["portrait"]["url"]
    assert binder.picture_bytes(app, pid, BR, strip[0]["portrait"]["url"])


def test_series_routes(book1):
    app, _fake, _b, pid = book1
    st, v = binder.route(app, "GET", ["series"], {}, None, "author", pid, BR)
    assert st == 200 and v["in_series"] is False
    st, j = binder.route(app, "POST", ["series", "find"], {}, {}, "author", pid, BR)
    assert st == 202 and wait_job(app, j)["status"] == "done"
    k = key_of(app, pid, "Mara Vell")
    st, out = binder.route(app, "POST", ["series", "approve"], {}, {"key": k}, "author", pid, BR)
    assert st == 200 and out["ok"]
    st, out = binder.route(app, "PUT", ["series", "name"], {}, {"name": "The Gullhaven Books"}, "author", pid, BR)
    assert out["name"] == "The Gullhaven Books"
    st, d = binder.route(app, "GET", [], {"as_of": ["1"]}, None, "author", pid, BR)
    assert d["series"]["as_of"] == 1 and d["series"]["name"] == "The Gullhaven Books"
    with pytest.raises(AkoweError):
        binder.route(app, "GET", [], {"as_of": ["one"]}, None, "author", pid, BR)
    st, out = binder.route(app, "GET", ["export"], {"format": ["docx"], "as_of": ["1"]}, None, "author", pid, BR)
    assert out[0] == "__binary__" and "(as of book 1)" in out[3]


def test_new_portrait_made_once_when_two_makers_start_together(book1):
    """Regression: ✔ Approve of a new look starts 🖼 Make the new portraits by itself; pressing the button too (or
    🖼 Make the rest of the pictures, which also makes them) planned the same waiting portrait twice and made it
    twice."""
    import threading
    app, _fake, b, pid = book1
    k = key_of(app, pid, "Mara Vell")
    series.save_proposals(app.store, pid, BR, {"character_changes": [
        {"name": "Mara Vell", "appearance": [{"text": "lost her left eye"}]}]})
    series.approve(app.store, pid, BR, {"key": k})
    b.gate = threading.Event()
    j1 = series.start_portraits(app, "author", pid, BR, {})
    assert b.waiting.wait(30)
    j2 = series.start_portraits(app, "author", pid, BR, {})
    b.gate.set()
    assert wait_job(app, j1)["status"] == "done" and wait_job(app, j2)["status"] == "done"
    assert sum(1 for r in b.ok if r.get("purpose") == "portrait") == 1, b.ok
    s = series.of_book(app.store, pid, BR)
    assert s["portraits"]["1"][k] and not s["portrait_waiting"]["1"] and not s.get("portraits_old")
