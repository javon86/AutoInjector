"""🗺 The story map (story_map.py): a live, editable map of the Book Bible's connections that feeds the writing and the
checks. One ⚡ run of a short book with the fake AI (whose continuity tracker returns story-map links, some of them
malformed) gives a real book; the pure parts (cleaning, the lock rules, conflicts, every gap warning, the brief's
tiers, the picture) are tested on top of it, then the HTTP routes, the binder export, the package round trip and the
sequel's carry-forward."""
from __future__ import annotations

import copy
import json
import time
import types
import zipfile
import io

import pytest

from akowe import book_package, binder, binder_docx, binder_html, series
from akowe import providers as prov_mod
from akowe import story_ledger as sl
from akowe import story_map as sm
from akowe.errors import AkoweError

from autobook_fake import CHAPTER_TEXT, BookFakeAI
from test_autobook import make_app, run_book

BR = "main"
UNCLE = "Tom Reed, Mara Vell's uncle, had taught her every lamp on the coast."
STRANGER = "Mara Vell looked at Tom Reed as if he were a stranger to her."
SECRET = "Mara Vell learned that the keeper had gone out to the reef with a stranger."


def text_of(n, extra=""):
    paras = list(CHAPTER_TEXT[((n - 1) % 3) + 1]) + ([extra] if extra else [])
    return "\n\n".join(paras)


class MapFake(BookFakeAI):
    """The fake continuity tracker also returns the chapter's story-map links (``map_links[number]``)."""

    def __init__(self):
        super().__init__()
        self.story_ledger = True
        self.map_links: dict = {}

    def _answer(self, ctx, props, schema):
        kind, out = super()._answer(ctx, props, schema)
        if kind == "track" and isinstance(out, dict):
            n = (ctx.get("chapter") or {}).get("number")
            out = copy.deepcopy(out)
            out.setdefault("story", {})["links"] = copy.deepcopy(self.map_links.get(n, []))
        return kind, out


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


@pytest.fixture(scope="module")
def book(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("storymap")
    fake = MapFake()
    fake.chapter_texts["ch1"] = text_of(1, UNCLE)
    fake.chapter_texts["ch2"] = text_of(2, STRANGER + " " + SECRET)
    fake.map_links = {
        1: [{"from": "Mara Vell", "to": "Tom Reed", "kind": "family", "note": "her uncle", "change": "new",
             "on_page": True, "quote": UNCLE},
            {"from": "Nessa Crane", "to": "Ilse Marrow", "kind": "rivals", "note": "the net sheds", "change": "new",
             "on_page": False, "quote": ""},
            "not a link", {"from": "", "to": "Tom Reed", "kind": "family"}, {"from": "Mara Vell", "to": "Mara Vell"},
            {"from": "Mara Vell", "to": "Nessa Crane", "kind": "best-buddies", "note": "old friend", "change": "??",
             "on_page": True, "quote": "this sentence is not in the chapter at all, not anywhere"}],
        2: [{"from": "Mara Vell", "to": "Tom Reed", "kind": "strangers", "note": "", "change": "changed",
             "on_page": True, "quote": STRANGER}],
    }
    app = make_app(tmp, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", (run["phase"], [(s["id"], s["state"], s.get("problem")) for s in run["steps"]])
    return types.SimpleNamespace(app=app, pid=run["project_id"], run=run, fake=fake, store=app.store)


def _links(b):
    return sm.get(b.store, b.pid, BR)["links"]


def _find(b, kind):
    return next((lid, lk) for lid, lk in _links(b).items() if lk["kind"] == kind)


def _api(b, method, path, body=None):
    return b.app.route(method, f"/api/projects/{b.pid}/branches/{BR}/storymap{path}", {}, body, "author", {})


# =========================================================================================== the run: live updates
def test_links_from_the_tracking_call_on_page_is_locked_the_rest_drafts(book):
    lid, fam = _find(book, "family")
    assert fam["status"] == "locked" and fam["source"] == "ai" and fam["since"] == 1
    assert fam["from"].startswith("C:") and fam["to"].startswith("C:")  # the Book Bible's own character ids
    assert fam["evidence"][0]["quote"].startswith("Tom Reed, Mara Vell's uncle") and fam["evidence"][0]["chapter"] == 1
    _r, riv = _find(book, "rivals")
    assert riv["status"] == "draft"  # not on the page
    _a, ally = _find(book, "ally")  # "best-buddies" guessed as friends; its quote is not on the page -> a draft
    assert ally["status"] == "draft"
    kinds = [lk["kind"] for lk in _links(book).values()]
    assert kinds.count("family") == 1  # the malformed entries were dropped, nothing crashed


def test_a_chapter_that_changes_a_locked_link_is_a_conflict_never_a_silent_change(book):
    lid, fam = _find(book, "family")
    cur = sm.get(book.store, book.pid, BR)
    conflicts = [c for c in cur["conflicts"].values() if c["link"] == lid]
    assert conflicts and conflicts[0]["status"] == "open" and conflicts[0]["chapter"] == 2
    assert conflicts[0]["proposed"]["kind"] == "strangers" and conflicts[0]["proposed"]["new_link"]
    assert fam["kind"] == "family" and fam["status"] == "locked" and fam.get("conflict")
    assert not any(lk["kind"] == "strangers" for lk in cur["links"].values())
    msgs = [e["message"] for e in book.app.autobook.get(book.run["id"])["events"]
            if e.get("code") in ("STORY_MAP", "STORY_MAP_CONFLICT")]
    assert any("🗺 Story map after chapter 1" in m for m in msgs)
    assert any("seems to change link" in m and lid in m for m in msgs)
    # 🏠 Book home's ⚠️ Needs a look says it in plain words
    from akowe import attention
    lines = attention.of_book(book.store, book.pid, BR)["lines"]
    assert any(line.startswith("🗺 Story map:") and lid in line for line in lines)


def test_the_tracker_the_writer_and_the_reviewer_get_the_map(book):
    lid, _fam = _find(book, "family")
    tracks = [ctx for _t, ctx in book.fake.prompts["track"] if (ctx.get("chapter") or {}).get("number") == 2]
    assert any(lid in " ".join(ctx.get("story_map") or []) for ctx in tracks)
    briefs = {(ctx.get("request_payload") or {}).get("chapter_id"): ctx.get("writing_brief") or {}
              for _t, ctx in book.fake.prompts["C02"]}
    b3 = briefs["ch3"]
    assert any(line.startswith(f"{lid} 🔒 Mara Vell is family of Tom Reed") for line in b3["story_map"]), b3.get(
        "story_map")
    assert sm.RULE in b3["rules"]
    assert not any("rivals" in x or "rival of" in x for x in b3["story_map"])  # drafts never reach the writer
    reviews = [ctx for _t, ctx in book.fake.prompts["review"] if ctx.get("story_map")]
    assert reviews and reviews[-1]["story_map_note"] == sm.REVIEW_NOTE
    checks = [ctx for _t, ctx in book.fake.prompts.get("checkpoint", []) if ctx.get("story_map")]
    assert checks, "the checkpoint got the story map"


# =========================================================================================== cleaning (fake AI replies)
def test_clean_links_drops_malformed_ai_json():
    raw = [None, 3, "x", {"from": "A"}, {"from": "A", "to": "a"}, {"from": "Ann", "to": "Bo", "kind": "loves",
                                                                   "on_page": "yes", "change": "maybe"},
           {"from": "Ann", "to": "Bo", "kind": "nope", "note": "her twin sister"}, {"from": ["x"], "to": "Bo"}]
    out = sm.clean_links(raw)
    assert [x["kind"] for x in out] == ["loves", "family"]
    assert out[0]["on_page"] is False and out[0]["change"] == "new"
    assert sm.clean_links("garbage") == [] and sm.clean_links({"links": 1}) == []
    assert sl.clean({"links": "bad"})["links"] == [] and sl.extract("Mara ran.")["links"] == []
    assert "links" in sl.STORY_SCHEMA["properties"] and "links" in sl.STORY_SCHEMA["required"]


def test_from_chapter_never_raises_and_weak_readings_stay_drafts(book):
    store = book.store
    key = sm.KEY.format(pid=book.pid, branch="weak")
    store.set_setting(key, {})
    res = sm.from_chapter(store, book.pid, "weak", {"chapter_id": "x", "number": 1, "text": None}, {"links": 7})
    assert res["added"] == 0
    res = sm.from_chapter(store, book.pid, BR, {"chapter_id": "ch9", "number": 9, "text": UNCLE},
                          {"links": [{"from": "Nobody Here", "to": "Somewhere Else", "kind": "lives_at",
                                      "on_page": True, "quote": UNCLE}]}, weak=True)
    cur = sm.get(store, book.pid, BR)
    new = [lk for lk in cur["links"].values() if lk.get("since") == 9]
    assert res["added"] == 1 and new and new[0]["status"] == "draft"  # a weak reading never locks
    ends = {cur["nodes"][x]["kind"] for x in (new[0]["from"], new[0]["to"]) if x in cur["nodes"]}
    assert ends == {"character", "place"}  # names the Bible lacks become the map's own entries


# =========================================================================================== the author's edits
def test_user_links_approve_edit_lock_rules_and_history(book):
    store, pid = book.store, book.pid
    v = sm.view(store, pid, BR)
    names = {n["name"]: n["id"] for n in v["nodes"]}
    lk = sm.add_link(store, pid, BR, {"from": names["Nessa Crane"], "to": names["Tom Reed"], "kind": "works_for",
                                      "note": "keeps his nets", "status": "draft"})
    assert lk["status"] == "draft" and lk["source"] == "user"
    with pytest.raises(AkoweError):  # the same link twice
        sm.add_link(store, pid, BR, {"from": names["Nessa Crane"], "to": names["Tom Reed"], "kind": "works_for"})
    with pytest.raises(AkoweError):
        sm.add_link(store, pid, BR, {"from": names["Nessa Crane"], "to": "C:nobody", "kind": "family"})
    with pytest.raises(AkoweError):
        sm.approve_link(store, pid, BR, lk["id"], {})  # needs the author's confirmation
    a = sm.approve_link(store, pid, BR, lk["id"], {"author_confirms": True})
    assert a["status"] == "approved" and "approved by you" in a["history"][-1]["what"]
    e = sm.edit_link(store, pid, BR, lk["id"], {"note": "mends his nets", "since": 2})
    assert e["note"] == "mends his nets" and e["since"] == 2 and "keeps his nets" in e["history"][-1]["before"]
    lid, _fam = _find(book, "family")
    with pytest.raises(AkoweError) as ex:  # 🔒 no silent edit
        sm.edit_link(store, pid, BR, lid, {"note": "not her uncle"})
    assert "Change it" in str(ex.value)
    with pytest.raises(AkoweError):
        sm.change_locked(store, pid, BR, lid, {"note": "x", "author_confirms": True})  # no reason
    with pytest.raises(AkoweError):
        sm.delete_link(store, pid, BR, lid, {})  # a locked link needs a reason
    with pytest.raises(AkoweError):
        sm.edit_link(store, pid, BR, lk["id"], {"kind": "best friends"})
    with pytest.raises(AkoweError):  # an old version of the map
        sm.edit_link(store, pid, BR, lk["id"], {"note": "x", "version": 1})
    assert sm.delete_link(store, pid, BR, lk["id"], {})["ok"]
    assert lk["id"] not in _links(book)


def test_conflict_keep_or_accept_with_a_reason(book):
    store, pid = book.store, book.pid
    lid, fam = _find(book, "family")
    kid = fam["conflict"]
    snap = store.get_setting(sm.KEY.format(pid=pid, branch=BR))
    with pytest.raises(AkoweError):
        sm.resolve_conflict(store, pid, BR, kid, {"choice": "keep", "author_confirms": True})  # no reason
    out = sm.resolve_conflict(store, pid, BR, kid, {"choice": "keep", "reason": "she was pretending",
                                                    "author_confirms": True})
    assert out["conflict"]["status"] == "kept"
    after = _links(book)[lid]
    assert after["kind"] == "family" and "conflict" not in after and after["history"][-1]["reason"] == \
        "she was pretending"
    with pytest.raises(AkoweError):
        sm.resolve_conflict(store, pid, BR, kid, {"choice": "accept", "reason": "x" * 5, "author_confirms": True})
    store.set_setting(sm.KEY.format(pid=pid, branch=BR), snap)  # back to open: accept it this time
    out = sm.resolve_conflict(store, pid, BR, kid, {"choice": "accept", "reason": "the memory loss arc",
                                                    "author_confirms": True})
    cur = sm.get(store, pid, BR)
    assert cur["links"][lid]["ended"] == 2 and cur["links"][out["new_link"]]["kind"] == "strangers"
    assert cur["links"][out["new_link"]]["status"] == "locked"
    store.set_setting(sm.KEY.format(pid=pid, branch=BR), snap)


def test_a_deleted_character_shows_as_removed_never_a_crash(book):
    store, pid = book.store, book.pid
    snap = store.get_setting(sm.KEY.format(pid=pid, branch=BR))
    cur = sm.get(store, pid, BR)
    lid, fam = _find(book, "family")
    ghost = dict(fam, to="C:deleted-record", to_name="Old Wilf", status="approved", conflict=None)
    cur["links"]["L99"] = ghost
    store.set_setting(sm.KEY.format(pid=pid, branch=BR), cur)
    v = sm.view(store, pid, BR)
    node = next(n for n in v["nodes"] if n["id"] == "C:deleted-record")
    assert node["missing"] and node["name"] == "Old Wilf"
    assert next(x for x in v["links"] if x["id"] == "L99")["about_removed"]
    assert any(g["code"] == "REMOVED" and "Old Wilf" in g["message"] for g in v["gaps"])
    lines = sm.brief(store, pid, BR, ["Mara Vell"], 3)
    assert any("Old Wilf (removed from the Book Bible)" in x for x in lines)
    store.set_setting(sm.KEY.format(pid=pid, branch=BR), snap)


# =========================================================================================== gap warnings (no AI)
def _cur(links, nodes=None, conflicts=None):
    return {"links": links, "nodes": nodes or {}, "conflicts": conflicts or {}, "positions": {}, "meta": {}}


def _lk(a, b, kind, since=1, status="approved", ev=()):
    return {"from": a, "to": b, "kind": kind, "since": since, "status": status, "evidence":
            [{"chapter": c, "quote": "q"} for c in ev], "history": []}


NODES = {"C:mara": {"id": "C:mara", "kind": "character", "name": "Mara", "main": True, "protagonist": True},
         "C:tom": {"id": "C:tom", "kind": "character", "name": "Tom", "role": "mentor"},
         "C:nessa": {"id": "C:nessa", "kind": "character", "name": "Nessa"},
         "C:extra": {"id": "C:extra", "kind": "character", "name": "A sailor", "minor": True},
         "S:th": {"id": "S:th", "kind": "thread", "name": "The smugglers"},
         "S:cl": {"id": "S:cl", "kind": "clue", "name": "The brass key", "plan": True},
         "W:m1": {"id": "W:m1", "kind": "secret", "name": "Who rowed back"},
         "P:pl": {"id": "P:pl", "kind": "place", "name": "The Old Light"}}


def codes(warnings):
    return {g["code"] for g in warnings}


def test_every_gap_warning():
    links = {"L1": _lk("C:mara", "C:tom", "family", 1), "L2": _lk("C:tom", "S:th", "thread", 2),
             "L3": _lk("S:cl", "W:m1", "clue_for", 1, "locked"), "L4": _lk("C:mara", "C:tom", "strangers", 3, "draft"),
             "L5": _lk("C:nessa", "C:ghost", "ally", 2)}
    links["L5"]["to_name"] = "Ghost"
    nodes = sm.all_nodes(_cur(links), NODES)
    conflicts = {"K1": {"link": "L1", "chapter": 9, "status": "open"}}
    g = sm.gaps(_cur(links, conflicts=conflicts), nodes, {"written": 10, "planned": 10, "finished": True})
    c = codes(g)
    assert {"CONFLICT", "THREAD_QUIET", "CLUE_NO_PAYOFF", "MAIN_ALONE", "SECRET_UNLEARNED", "CONTRADICTION",
            "ORPHAN", "REMOVED"} <= c, c
    msg = {x["code"]: x["message"] for x in g}
    assert "has not moved for 8 chapters (last in chapter 2)" in msg["THREAD_QUIET"]
    assert "never paid off by the end of the book" in msg["CLUE_NO_PAYOFF"]
    assert "Mara ★ has no new connections in the last 5 chapters" in msg["MAIN_ALONE"]
    assert "Nobody learns the secret" in msg["SECRET_UNLEARNED"]
    assert "cannot both be true" in msg["CONTRADICTION"] and "L1" in msg["CONTRADICTION"]
    assert "The Old Light" in msg["ORPHAN"] and not any("A sailor" in x["message"] for x in g)  # extras are fine
    assert g[0]["severity"] == "warn" and g[-1]["severity"] == "info"
    # paid off, learned, active and consistent: quiet
    links2 = {"L1": _lk("C:mara", "C:tom", "family", 1, ev=(9,)), "L2": _lk("C:tom", "S:th", "thread", 8),
              "L3": _lk("S:cl", "W:m1", "clue_for", 1), "L6": _lk("C:mara", "S:cl", "pays_off", 9),
              "L7": _lk("C:nessa", "W:m1", "knows_secret", 9), "L8": _lk("C:nessa", "P:pl", "lives_at", 2)}
    g2 = sm.gaps(_cur(links2), sm.all_nodes(_cur(links2), NODES), {"written": 10, "planned": 10, "finished": True})
    assert not codes(g2) & {"CONFLICT", "THREAD_QUIET", "CLUE_NO_PAYOFF", "MAIN_ALONE", "SECRET_UNLEARNED",
                            "CONTRADICTION", "REMOVED", "ORPHAN"}, g2
    # a planned payoff chapter: due before the end of the book
    nodes3 = dict(NODES, **{"S:cl": dict(NODES["S:cl"], payoff_chapter=4)})
    links3 = {"L3": _lk("S:cl", "W:m1", "clue_for", 1)}
    g3 = sm.gaps(_cur(links3), sm.all_nodes(_cur(links3), nodes3), {"written": 5, "planned": 20})
    assert any(x["code"] == "CLUE_NO_PAYOFF" and "by chapter 4, as planned" in x["message"] for x in g3)
    assert not any(x["code"] == "CLUE_NO_PAYOFF" for x in sm.gaps(_cur(links3), sm.all_nodes(_cur(links3), nodes3),
                                                                  {"written": 3, "planned": 20}))


# =========================================================================================== the brief and the checks
def test_brief_three_tiers_and_budget_with_cuts(book, monkeypatch):
    store, pid = book.store, book.pid
    snap = store.get_setting(sm.KEY.format(pid=pid, branch=BR))
    v = sm.view(store, pid, BR)
    ids = {n["name"]: n["id"] for n in v["nodes"]}
    sm.add_link(store, pid, BR, {"from": ids["Nessa Crane"], "to": ids["Ilse Marrow"], "kind": "hates",
                                 "note": "the fire"})
    sm.add_link(store, pid, BR, {"from": ids["Mara Vell"], "to": ids["Ilse Marrow"], "kind": "enemy", "since": 7})
    lines = sm.brief(store, pid, BR, ["Mara Vell", "Tom Reed"], 3)
    assert lines and lines[0].split()[1] == "🔒"  # tier 1: both ends in the chapter
    assert not any("hates" in x for x in lines)  # nobody in this chapter
    assert not any("enemy" in x for x in lines)  # starts in chapter 7
    assert any("enemy" in x for x in sm.brief(store, pid, BR, ["Mara Vell"], 8))
    monkeypatch.setattr(sm, "BRIEF_BUDGET", 60)
    cut: list = []
    short = sm.brief(store, pid, BR, ["Mara Vell", "Nessa Crane", "Tom Reed"], 9, cut)
    assert len(short) <= 1 and any("story map" in c for c in cut)
    store.set_setting(sm.KEY.format(pid=pid, branch=BR), snap)


def test_the_quick_check_names_the_link_code(book):
    store, pid = book.store, book.pid
    lid, _fam = _find(book, "family")
    fl = sm.flags(store, pid, BR, "ch5", 5, "Mara Vell met Tom Reed for the first time on the quay.")
    assert fl and fl[0]["code"] == "STORY_MAP" and fl[0]["link"] == lid and lid in fl[0]["message"]
    assert sm.flags(store, pid, BR, "ch5", 5, "Mara Vell met Tom Reed on the quay.") == []


def test_needs_list_and_code_map_know_the_story_map():
    from akowe import code_map, needs_list
    assert code_map.is_code("N00") and code_map.parse("N0a")["section"] == "N00"
    assert "N00" in needs_list.LEDGER_KEYS
    assert "story map" in code_map.markdown().lower()


# =========================================================================================== HTTP routes
def test_routes(book):
    st, v = _api(book, "GET", "")
    assert st == 200 and v["code"] == "N00" and v["counts"]["links"] >= 3 and v["chapters"]["written"] >= 3
    assert any(n["protagonist"] and n["name"] == "Mara Vell" for n in v["nodes"])
    ids = {n["name"]: n["id"] for n in v["nodes"]}
    st, out = _api(book, "POST", "/nodes", {"kind": "clue", "name": "The torn letter", "payoff_chapter": 3})
    assert st == 201 and out["node"]["id"].startswith("X")
    st, out2 = _api(book, "POST", "/links", {"from": out["node"]["id"], "to": ids["Tom Reed"], "kind": "clue_for"})
    assert st == 201 and out2["link"]["status"] == "approved"
    st, _ = _api(book, "PUT", f"/links/{out2['link']['id']}", {"note": "the last line"})
    assert st == 200
    st, _ = _api(book, "PUT", "/positions", {"positions": {ids["Tom Reed"]: [120.5, 300], "bad": "x"}})
    assert st == 200 and sm.get(book.store, book.pid, BR)["positions"][ids["Tom Reed"]] == [120.5, 300.0]
    st, v2 = _api(book, "GET", "")
    assert any(g["code"] == "CLUE_NO_PAYOFF" and "The torn letter" in g["message"] for g in v2["gaps"])
    st, svg_ = _api(book, "GET", "/svg")
    assert st == 200 and svg_[0] == "__binary__" and b"<svg" in svg_[2]
    st, _ = _api(book, "POST", f"/nodes/{out['node']['id']}/delete", {})
    st, v3 = _api(book, "GET", "")
    gone = next(x for x in v3["links"] if x["id"] == out2["link"]["id"])
    assert gone["about_removed"]  # the user's link is never dropped with the node
    _api(book, "POST", f"/links/{out2['link']['id']}/delete", {})
    with pytest.raises(AkoweError):
        _api(book, "GET", "/nope")


# =========================================================================================== the binder, the package, a sequel
def test_binder_export_has_the_map_picture_and_table(book):
    data = binder.build(book.app, book.pid, BR)
    page = next(p for p in data["pages"] if p["template"] == "6")
    part = page["story_map"]
    assert part["svg"].startswith("<svg class=\"story-map\"") and "★" in part["svg"] and "stroke-dasharray" in \
        part["svg"]
    assert any(r["status"].startswith("🔒") and r["evidence"].startswith("Ch 1") for r in part["rows"])
    html = binder_html.render(data)
    assert "🗺 Story map" in html and 'class="story-map"' in html and "On the page" in html
    docx = binder_docx.build_docx(data)
    with zipfile.ZipFile(io.BytesIO(docx)) as z:
        doc = z.read("word/document.xml").decode("utf-8")
        assert "🗺 Story map" in doc and any(n.startswith("word/media/") and n.endswith(".png") for n in z.namelist())
    png, key = sm.png(part["view"])
    from akowe.exporters.images import load_image
    info = load_image(png)
    assert info.mime == "image/png" and info.width == 900 and key and key[0]["n"] == 1


def test_book_package_round_trip_keeps_the_map(book):
    data = book_package.build(book.app, book.pid)
    pkg = book_package.read(data)
    res = book_package.import_package(book.app, data, "author", pkg=pkg)
    new_pid = res["project_id"]
    old, new = sm.get(book.store, book.pid, BR), sm.get(book.store, new_pid, BR)
    assert set(new["links"]) == set(old["links"]) and new["conflicts"].keys() == old["conflicts"].keys()
    v = sm.view(book.store, new_pid, BR)
    assert not any(n["missing"] for n in v["nodes"] if n["kind"] == "character")  # record ids kept: still linked


def test_sequel_carries_locked_and_approved_links_forward(book):
    store, pid = book.store, book.pid
    new_pid = book.app.engine.bootstrap_project("author", "Book two")
    old_v = sm.view(store, pid, BR)
    rules = [x for x in old_v["links"] if x["status"] in ("locked", "approved") and not x.get("ended")]
    s = series.ensure(store, pid, BR)
    called = {}
    orig = sm.carry_forward

    def spy(*a, **k):
        called["args"] = a
        return orig(*a, **k)
    sm.carry_forward = spy
    try:
        series.link_sequel(store, {"series_id": s["id"], "previous": pid, "previous_branch": BR,
                                   "previous_number": 1, "keys": {}}, new_pid, BR, {})
    finally:
        sm.carry_forward = orig
    assert called["args"][:5] == (store, pid, BR, new_pid, BR)
    new = sm.get(store, new_pid, BR)
    assert len(new["links"]) == len(rules) and all(lk["status"] in ("locked", "approved") for lk in
                                                   new["links"].values())
    assert all(lk["since"] is None and "carried over from book 1" in lk["history"][-1]["what"]
               for lk in new["links"].values())
    assert not any(lk["kind"] == "rivals" for lk in new["links"].values())  # drafts stay behind
    assert sm.carry_forward(store, pid, BR, new_pid, BR, {}) == 0  # carried once only
    assert series.clean_sequel_setting(store, {"series_id": s["id"], "number": 2, "previous_branch": "x"})[
        "previous_branch"] == "x"
    json.dumps(new)  # stays plain JSON
