"""Job L1 (📒 story ledger + 🧭 checkpoints) and job L2 (checks & approvals) working together, with the fake AI:

* a hand edit (continuity.invalidate_after_chapter, H5) sets aside the story ledger / story so far from chapter N on
  and marks the checkpoints after N for redo (the hooks L1 registers);
* the checkpoints before the last chapter run L2's light setups / payoffs check (ending_check upto=N, final=False)
  and the final ending check runs once (autobook ``_ending_pass``, not again in the final checkpoint);
* the continuity part of the brief (continuity.section, story_ledger.brief) reports what it cut through
  brief_cuts.py, so the run's ⚠️ "what was cut" lists it (H13).
"""
from __future__ import annotations

import time
import types

import pytest

from akowe import brief_cuts, chapter_brief, checkpoints, continuity, ending_check
from akowe import providers as prov_mod
from akowe import story_ledger as sl
from akowe.book_path import BookPath

from autobook_fake import CHAPTER_TEXT, BookFakeAI
from test_autobook import make_app, run_book

BR = "main"


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def done(run):
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    return run


def events(app, run, code):
    return [e for e in app.autobook.get(run["id"])["events"] if e.get("code") == code]


def text_of(n, extra=""):
    paras = [p + f" That was night {n} of the search." for p in CHAPTER_TEXT[((n - 1) % 3) + 1]]
    return "\n\n".join(paras + ([extra] if extra else []))


def ledger_book():
    fake = BookFakeAI()
    fake.story_ledger = True
    fake.chapter_texts["ch1"] = text_of(1, "Mara Vell twisted her ankle on the slick steps and limped to the door. "
                                           "She lost her knife in the surf.")
    fake.chapter_texts["ch2"] = text_of(2, "At dusk Mara Vell found the brass key under the third step.")
    return fake


# ====================================================================== 1. a hand edit reaches the ledger + checkpoints
def test_a_hand_edit_sets_the_ledger_aside_from_that_chapter_on_and_marks_later_checkpoints_for_redo(tmp_path,
                                                                                                     monkeypatch):
    monkeypatch.setattr(checkpoints, "DEFAULT_EVERY", 1)  # checkpoints after chapters 1 and 2, and the final one
    assert continuity._ledger_hook in continuity.INVALIDATE_HOOKS
    assert continuity._checkpoint_hook in continuity.INVALIDATE_HOOKS
    fake = ledger_book()
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"length": "short_story", "pictures": False}))
    pid, store = run["project_id"], app.store
    cps = {c["id"]: c for c in checkpoints.items(store, pid, BR)}
    assert set(cps) == {"after-1", "after-2", "final"} and all(c["status"] == "done" for c in cps.values())
    outline = BookPath(app.engine, "author", pid, BR).outline()
    before, _m = chapter_brief.build(store, pid, BR, outline, "ch3")
    assert any(x.startswith("Chapter 2:") for x in before["story_so_far"]) and before["previous_chapter_end"]

    out = continuity.invalidate_after_chapter(store, pid, BR, "ch2", number=2, reason="a hand edit")
    assert "ch3" in out["flagged"]
    # 📒 chapter 2 and 3 are set aside (read from the old text), chapter 1 stays
    assert not (sl.get_chapter(store, pid, BR, "ch1") or {}).get("set_aside")
    for cid in ("ch2", "ch3"):
        e = sl.get_chapter(store, pid, BR, cid)
        assert e["set_aside"]["because"] == "ch2" and e["weak_why"] == "changed"
    order = ["ch1", "ch2", "ch3"]
    assert [e["chapter_id"] for e in sl.ordered(store, pid, BR, order)] == ["ch1"]
    assert sl.weak_chapters(store, pid, BR, order) == ["ch2", "ch3"]  # read again (retrack_weak)
    after, _m = chapter_brief.build(store, pid, BR, outline, "ch3")
    assert not any(x.startswith("Chapter 2:") for x in after.get("story_so_far") or [])
    assert "previous_chapter_end" not in after  # chapter 2's old ending never reaches the writer
    assert sl.page_info(store, pid, BR, order)["set_aside"] == [2, 3]
    # 🧭 the checkpoints after chapter 2 are to be read again; the one after chapter 1 stays
    cps = {c["id"]: c for c in checkpoints.items(store, pid, BR)}
    assert cps["after-1"]["status"] == "done"
    for k in ("after-2", "final"):
        assert cps[k]["status"] == "new" and cps[k]["parts"] is None and cps[k]["redo_because"]["number"] == 2
        assert cps[k]["redo_of"]["status"] == "done"
    assert [s["after"] for s in checkpoints.summaries(store, pid, BR)] == [1]  # the stale summary leaves
    rep = checkpoints.report(store, pid, BR)
    assert "to be read again (chapter 2 was changed by hand)" in next(c for c in rep if c["id"] == "after-2")["line"]
    # idempotent: the same edit seen again changes nothing
    v = sl.get_all(store, pid, BR)["version"]
    continuity.invalidate_after_chapter(store, pid, BR, "ch2", number=2)
    assert sl.get_all(store, pid, BR)["version"] == v
    # a new reading of a set-aside chapter replaces its entry
    ch = {"chapter_id": "ch2", "number": 2, "record_id": "r", "version": 9, "text": text_of(2)}
    sl.save_chapter(store, pid, BR, ch, {"summary": ["Mara finds the key."]}, made_by="ai")
    assert not sl.get_chapter(store, pid, BR, "ch2").get("set_aside")


# ====================================================================== 2. checkpoints use L2's setups / payoffs check
def test_checkpoints_check_setups_so_far_and_the_final_ending_check_runs_once(tmp_path, monkeypatch):
    monkeypatch.setattr(checkpoints, "DEFAULT_EVERY", 1)
    fake = ledger_book()
    fake.plot_obligations = ["The brass key opens the lamp room."]

    def dropped(ctx):  # the checkpoint after chapter 2: the page already dropped the setup
        return {"items": [{"id": p["id"], "kept": False, "where": "", "note": "The key is thrown away.", "fix": ""}
                          for p in ctx["promises"]],
                "arc": {"kept": True, "note": "", "fix": ""}, "question": {"kept": True, "note": "", "fix": ""}}
    fake.ending_script = [None, dropped]
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"length": "short_story", "pictures": False}))
    pid, store = run["project_id"], app.store
    calls = [task for task, _ctx in fake.prompts["ending"]]
    assert len(calls) == 3, calls  # after chapter 1, after chapter 2, and the ONE final ending check
    assert ["CHECKPOINT" in t for t in calls] == [True, True, False]
    assert [ctx["upto"] for _t, ctx in fake.prompts["ending"]] == [1, 2, None]
    cps = {c["id"]: c for c in checkpoints.items(store, pid, BR)}
    assert cps["after-2"]["ending"]["open"] and not cps["after-1"]["ending"]["open"]
    assert "ending" not in cps["final"] or not cps["final"]["ending"]  # the final checkpoint leaves it to the pass
    ev = events(app, run, "CHECKPOINT_SETUPS")
    assert len(ev) == 1 and "A setup with no payoff: The brass key opens the lamp room." in ev[0]["message"]
    assert ending_check.get(store, pid, BR, "checkpoint")["upto"] == 2
    assert ending_check.get(store, pid, BR)["final"] is True
    md = "\n".join(checkpoints.markdown(checkpoints.report(store, pid, BR)))
    assert "🎯 A setup with no payoff: The brass key" in md


def test_a_plan_without_setups_makes_no_extra_ai_call_at_checkpoints(tmp_path, monkeypatch):
    monkeypatch.setattr(checkpoints, "DEFAULT_EVERY", 1)
    fake = ledger_book()
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"length": "short_story", "pictures": False}))
    assert [ctx["upto"] for _t, ctx in fake.prompts["ending"]] == [None]  # only the final ending check
    cps = {c["id"]: c for c in checkpoints.items(app.store, run["project_id"], BR)}
    assert cps["after-1"]["ending"]["skipped"]


# ====================================================================== 3. the continuity part's cuts are said (H13)
def test_story_ledger_and_tracked_state_cuts_reach_the_what_was_cut_warning(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "LEDGER_BUDGET", 120)       # a tight story ledger: most of its lines do not fit
    fake = ledger_book()
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"length": "short_story", "pictures": False}))
    pid = run["project_id"]
    cut_events = [e["message"] for e in events(app, run, "INSTRUCTIONS_CUT")]
    assert any("story ledger — " in m for m in cut_events), cut_events
    listed = brief_cuts.listing(app.store, pid, BR)
    assert any(any(c.startswith("story ledger — ") for c in e["cut"]) for e in listed), listed
    # the continuity part on its own: what it trims is listed in plain words
    monkeypatch.setattr(continuity, "BRIEF_BUDGET", 10)
    cut: list = []
    continuity.section(app.store, pid, BR, ["ch1", "ch2", "ch3"], "ch3", ["Mara Vell"], cut=cut)
    assert cut and all(c.startswith(("continuity — ", "story ledger — ", "story so far")) for c in cut), cut
    assert any(c.startswith("continuity — ") for c in cut), cut
