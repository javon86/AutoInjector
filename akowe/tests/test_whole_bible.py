"""📖 "Fill the whole Book Bible" (whole_bible.py): the ⚡ run switch (off = the unchanged just-in-time run; on =
every empty section filled before chapter one, author text untouched, a resume never refills) and the 📖 At a
glance button (proposals that wait for the author's OK, Stop, "N sections filled, M still empty (why)")."""
from __future__ import annotations

import time
import types

import pytest

from akowe import binder, binder_fields, forge, forge_kinds, providers as prov_mod, whole_bible
from akowe import characters as chars_mod

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book, steps

BR = "main"
NUMBERS = {"bf_stat_strength": "7", "bf_stat_speed": "6", "bf_stat_agility": "8", "bf_stat_stamina": "5",
           "bf_stat_durability": "6", "bf_danger_level": "3", "bf_rel_1": "ally", "bf_rel_2": "family",
           "bf_rel_3": "rival", "bf_rel_4": "mentor", "bf_rel_5": "enemy", "bf_rel_6": "other",
           # a relationship row is matched by the other person's name: a real AI names a different person each time
           **{f"relationship_{i}": f"{n}: an old acquaintance of {{name}}, the tension and the history"
              for i, n in ((1, "Ada Pike"), (2, "Ben Hollis"), (3, "Cora Wynd"), (4, "Dan Moor"), (5, "Eli Stone"),
                           (6, "Fay Lune"))}}


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def fake_ai():
    fake = BookFakeAI()
    fake.details.update(NUMBERS)
    return fake


def bible_calls(fake):
    return [ctx for _s, ctx in fake.prompts.get("details", []) if ctx.get("fill") == "whole_book_bible"]


def done(run):
    assert run["status"] == "done", (run["phase"], [(s["id"], s["state"], s.get("problem")) for s in run["steps"]])
    return run


def dossier(app, pid, rid, kind="character"):
    d = forge.public(app.store, pid, BR, rid) if kind == "character" else \
        forge_kinds.public(app.store, pid, BR, kind, rid)
    return {f["key"]: f for s in d["sections"] for f in s["fields"]}


def chars(app, pid):
    return {c["name"]: c for c in chars_mod.canon_characters(app.store, pid, BR)}


def open_left(app, pid):
    us, _info = whole_bible.units(app, pid, BR, ensure=False)
    return {u["ref"]: u["keys"] for u in us}


# ---------------------------------------------------------------------------------------------- the run switch
def test_switch_off_is_the_unchanged_just_in_time_run(tmp_path):
    fake = fake_ai()
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"genre": "Mystery", "length": "short_story", "pictures": False}))
    st = steps(run)
    assert st["bible"]["state"] == "done" and st["bible"]["message"] == "Not asked for in this run"
    assert run["settings"].get("fill_bible") is False
    assert bible_calls(fake) == []
    # the just-in-time way still left most of the dossiers empty
    assert sum(len(v) for v in open_left(app, run["project_id"]).values()) > 50


def test_switch_on_fills_everything_before_chapter_one(tmp_path, monkeypatch):
    fake = fake_ai()
    app = make_app(tmp_path, fake=fake)
    seen = {}
    real = app.autobook._s_chapters

    def chapters_step(run, st):
        seen["open"] = open_left(app, run["project_id"])  # what is still empty when chapter one starts
        seen["calls"] = len(bible_calls(fake))
        seen["places"] = forge_kinds.list_dossiers(app.store, run["project_id"], BR, "place")
        return real(run, st)
    monkeypatch.setattr(app.autobook, "_s_chapters", chapters_step)
    run = done(run_book(app, {"genre": "Mystery", "length": "short_story", "pictures": False, "fill_bible": True}))
    pid = run["project_id"]
    st = steps(run)
    ids = [s["id"] for s in run["steps"]]
    assert ids.index("outline") < ids.index("bible") < ids.index("chapters")
    assert st["bible"]["state"] == "done" and "sections filled" in st["bible"]["message"]
    assert seen["open"] == {}, seen["open"]          # nothing left empty before chapter one
    assert seen["calls"] == len(bible_calls(fake)) >= 2
    # batched: several sections (and records) per call, never one call per field
    n_keys = sum(len(s["fields"]) for ctx in bible_calls(fake) for s in ctx["subjects"])
    assert n_keys / len(bible_calls(fake)) > 10
    assert all(len(s["fields"]) <= whole_bible.CHUNK_KEYS for ctx in bible_calls(fake) for s in ctx["subjects"])
    # every record kind got filled, approved under the run's consent
    mara = chars(app, pid)["Mara Vell"]["record_id"]
    f = dossier(app, pid, mara)
    assert f["stance"]["text"] and f["stance"]["status"] == "approved" and f["languages"]["text"]
    vals = binder_fields.values(app.store, pid, BR, f"character:{mara}")
    assert vals["stat_strength"]["value"] == 7 and vals["stat_strength"]["status"] == "approved"
    places = seen["places"]  # (a place a chapter visits later for the first time is decided just in time)
    assert places and all(dossier(app, pid, p["record_id"], "place")["economy"]["text"] for p in places)
    sm = st["bible"]["summary"]
    assert sm["filled_sections"] > 20 and sm["empty_sections"] == 0
    # protected author fields are never filled
    assert not f["supplied_canon"]["text"] or f["supplied_canon"]["status"] == "supplied"
    assert any("Book Bible detail(s) of “Mara Vell”" in e["message"] for e in app.autobook.get(run["id"])["events"])


def test_switch_on_never_touches_author_text_and_resume_does_not_refill(tmp_path, monkeypatch):
    fake = fake_ai()
    app = make_app(tmp_path, fake=fake)
    real = whole_bible.accept
    calls = {"n": 0}

    def pause_after_first_call(app_, pid, branch, u, answer, slot, *, by):
        out = real(app_, pid, branch, u, answer, slot, by=by)
        calls["n"] += 1
        if calls["n"] == 1:
            app.autobook._ctl[next(iter(app.autobook._ctl))]["pause"] = True  # the author presses Pause
        return out
    monkeypatch.setattr(whole_bible, "accept", pause_after_first_call)
    r = app.autobook.start("author", {"author_confirms": True, "length": "short_story", "pictures": False,
                                      "fill_bible": True})
    app.autobook.wait_for(r["id"], 120)
    from test_autobook import trust_one_ai_
    trust_one_ai_(app, r["id"], 120)
    run = app.autobook.public(app.autobook.get(r["id"]))
    assert run["status"] == "paused" and steps(run)["bible"]["state"] == "paused", run["phase"]
    pid = run["project_id"]
    before = len(bible_calls(fake))
    asked_before = {(s["name"], k.split("__", 1)[1]) for ctx in bible_calls(fake) for s in ctx["subjects"]
                    for k in s["fields"]}
    # meanwhile the author writes a detail and protects an empty one themselves
    tom = chars(app, pid)["Tom Reed"]["record_id"]
    forge.edit(app.store, pid, BR, tom, {"sections": {"fighting": {"stance": {"text": "Feet planted, never moves "
                                                                                       "first."}}}})
    forge.edit(app.store, pid, BR, tom, {"sections": {"knowledge": {"languages": {"protected": True}}}})
    app.autobook.resume("author", r["id"])
    app.autobook.wait_for(r["id"], 180)
    run = done(app.autobook.public(app.autobook.get(r["id"])))
    f = dossier(app, pid, tom)
    assert f["stance"]["text"] == "Feet planted, never moves first." and f["stance"]["status"] == "supplied"
    assert not f["languages"]["text"] and f["languages"]["protected"]
    # nothing asked before the pause was asked again, and the author's fields were never asked
    again = [(s["name"], k.split("__", 1)[1]) for ctx in bible_calls(fake)[before:] for s in ctx["subjects"]
             for k in s["fields"]]
    assert not (set(again) & asked_before)
    assert ("Tom Reed", "stance") not in again and ("Tom Reed", "languages") not in again


# ---------------------------------------------------------------------------------------------- the At a glance button
@pytest.fixture
def written_book(tmp_path):
    fake = fake_ai()
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"genre": "Mystery", "length": "short_story", "pictures": False}))
    return app, run["project_id"], fake


def test_button_fills_as_proposals_that_wait_for_the_author(written_book):
    app, pid, fake = written_book
    mara = chars(app, pid)["Mara Vell"]["record_id"]
    forge.edit(app.store, pid, BR, mara, {"sections": {"fighting": {"tactics": {"text": "Waits for the tide."}}}})
    status, job = binder.route(app, "POST", ["fill_all"], {}, {}, "author", pid, BR)
    assert status == 202
    j = forge.wait(app, "author", job["job_id"], 120)
    assert j["status"] == "done", j
    f = dossier(app, pid, mara)
    assert f["tactics"]["text"] == "Waits for the tide." and f["tactics"]["status"] == "supplied"
    assert f["stance"]["text"] and f["stance"]["status"] == "proposed"        # waits for the author's OK
    vals = binder_fields.values(app.store, pid, BR, f"character:{mara}")
    assert vals["stat_speed"]["status"] == "proposed"
    # the story so far (what is written) reaches the AI
    assert any(ctx.get("story_so_far") for ctx in bible_calls(fake))
    sm = j["results"][-1]["summary"]
    assert sm["filled_sections"] > 10 and sm["empty_sections"] == 0
    assert "sections filled, 0 still empty" in j["results"][-1]["message"]
    assert "wait for your OK" in j["results"][-1]["message"]
    # a second press asks nothing: proposals are waiting, nothing is empty
    n = len(bible_calls(fake))
    j2 = forge.wait(app, "author", binder.route(app, "POST", ["fill_all"], {}, {}, "author", pid, BR)[1]["job_id"])
    assert j2["status"] == "done" and len(bible_calls(fake)) == n, [(s["kind"], s["name"], list(s["fields"])[:5]) for c in bible_calls(fake)[n:] for s in c["subjects"]]
    assert j2["results"][-1]["summary"]["filled_sections"] == 0
    # ✔ approving works as for every other proposal
    forge.approve(app.store, pid, BR, mara, {"fields": ["stance"]})
    assert dossier(app, pid, mara)["stance"]["status"] == "approved"


def test_button_stop_keeps_what_is_filled_and_says_what_is_left(written_book):
    app, pid, fake = written_book
    import threading
    gate = threading.Event()
    real = whole_bible.accept
    state = {"n": 0, "job": None}

    def slow_accept(*a, **kw):
        out = real(*a, **kw)
        state["n"] += 1
        if state["n"] == 1:
            app.review._jobs[state["job"]].cancelled = True   # the author presses Stop after the first batch
            gate.set()
        return out
    whole_bible.accept = slow_accept
    try:
        _s, job = binder.route(app, "POST", ["fill_all"], {}, {}, "author", pid, BR)
        state["job"] = job["job_id"]
        j = forge.wait(app, "author", job["job_id"], 120)
    finally:
        whole_bible.accept = real
    assert j["status"] == "cancelled"
    sm = j["results"][-1]["summary"]
    assert j["results"][-1]["message"].startswith("Stopped. ")
    assert sm["filled_sections"] >= 1 and sm["empty_sections"] > 0
    assert any(r["why"] == "stopped before it was reached" for r in sm["reasons"])
    assert len(bible_calls(fake)) == 1


def test_http_codes_endpoint_and_markdown(written_book):
    app, pid, _fake = written_book
    status, data = binder.route(app, "GET", ["codes"], {}, None, "author", pid, BR)
    assert status == 200 and data["fid"]["5.2.8"] == "C1c"
    status, out = binder.route(app, "GET", ["codes"], {"format": ["md"]}, None, "author", pid, BR)
    assert out[0] == "__binary__" and out[1].startswith("text/markdown") and b"C1c" in out[2]
