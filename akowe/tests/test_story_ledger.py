"""📒 The story ledger and 🧭 continuity checkpoints (holes H1, H2, H4, H8, H9, H19, H20, H21 of docs/HOLES_2026-11.md
and the checkpoints for long books), with the fake AI: each hole reproduced as a check that failed before the fix."""
from __future__ import annotations

import time
import types

import pytest

from akowe import chapter_brief, checkpoints, continuity
from akowe import character_state as cs
from akowe import providers as prov_mod
from akowe import story_ledger as sl
from akowe.book_path import BookPath, clean_profile
from akowe.errors import AkoweError

from autobook_fake import CHAPTER_TEXT, BookFakeAI
from test_autobook import make_app, run_book, steps

BR = "main"


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def done(run):
    assert run["status"] == "done", (run["phase"], run.get("problem"),
                                     [(s["id"], s["state"], s.get("problem")) for s in run["steps"]])
    return run


def events(app, run, code=None):
    return [e for e in app.autobook.get(run["id"])["events"] if code is None or e.get("code") == code]


def text_of(n, extra=""):
    paras = CHAPTER_TEXT[((n - 1) % 3) + 1]
    paras = [p + f" That was night {n} of the search." for p in paras]
    return "\n\n".join(paras + ([extra] if extra else []))


def approved_text(app, pid, cid):
    bp = BookPath(app.engine, "author", pid, BR)
    _c, _l, appr = bp.chapter_prose(bp.outline(), cid)
    return (appr.get("data") or {}).get("text") or ""


def entry(n, text, people=("Mara Vell",)):
    return dict(sl.extract(text, list(people)), chapter_id=f"ch{n}", number=n)


# =========================================================================================== pure checks (H2 H4 H8 H9 H19)
def test_h2_injury_lost_item_and_the_dead_are_checked_against_later_chapters():
    e1 = entry(1, "Mara Vell twisted her ankle on the rocks and limped home. She lost her knife in the surf. "
                  "Tom Reed died on the reef.", ("Mara Vell", "Tom Reed"))
    t2 = "Mara Vell ran down the quay. Mara drew her knife. Tom Reed said nothing would change."
    e2 = entry(2, t2, ("Mara Vell", "Tom Reed"))
    codes = {f["code"]: f for f in sl.check([e1], e2, t2)}
    assert {"INJURY_IGNORED", "LOST_ITEM_BACK", "DEAD_ACTS"} <= set(codes)
    assert codes["INJURY_IGNORED"]["replacement"] == "Mara Vell limped down the quay."
    # healed (or found again, or remembered) is not a contradiction
    t3 = "Weeks later her ankle had healed and Mara Vell ran down the quay. Mara picked up her knife and drew her " \
         "knife. She remembered how Tom Reed said the sea forgives."
    e3 = entry(3, t3, ("Mara Vell", "Tom Reed"))
    e3["time"]["since_previous"] = "three weeks"
    assert not {f["code"] for f in sl.check([e1], e3, t3)} & {"INJURY_IGNORED", "LOST_ITEM_BACK", "DEAD_ACTS"}
    st = sl.state_before([e1])
    mara = st["people"]["Mara Vell"]
    assert "ankle" in next(iter(mara["injuries"].values()))["what"] and "knife" in mara["lost"]
    assert st["people"]["Tom Reed"]["status"] == "dead"
    # the magic cost lingers into the next chapter's brief line
    e4 = dict(e1, people=[dict(e1["people"][0], magic_cost="numb hands for an hour")])
    line = sl._person_line(sl.state_before([e4])["people"]["Mara Vell"], 2)  # noqa: SLF001
    assert "still feels: numb hands" in line and "lost: knife" in line and "hurt:" in line


def test_h4_new_names_are_harvested_and_near_misses_flagged():
    t1 = "Bram Hollis rowed out from Saltmere. Bram waved to Nessa Crane on the quay."
    e1 = entry(1, t1, ("Nessa Crane",))
    assert {"Bram Hollis", "Saltmere", "Nessa Crane"} <= {n["name"] for n in e1["names"]}
    t2 = "Bram Hollis came back to Salt Mere at noon. Nesa Crane waited with the nets."
    e2 = entry(2, t2, ("Nessa Crane",))
    e2["names"].append({"name": "Salt Mere", "kind": "place"})
    msgs = [f["message"] for f in sl.check([e1], e2, t2) if f["code"] == "NAME_SPELLING"]
    assert any("“Nesa”" in m and "Nessa" in m for m in msgs), msgs
    assert any("“Salt Mere”" in m and "Saltmere" in m for m in msgs), msgs
    fix = next(f for f in sl.check([e1], e2, t2) if "Nesa" in f["message"])
    assert fix["replacement"] == "Nessa Crane waited with the nets."


def test_h8_travel_times_seasons_and_days():
    e1 = entry(1, "It was deep winter and snow lay on the road. It is three days' ride from Gullhaven to Harrowgate.")
    e1["time"]["day"] = "day 2"
    assert e1["trips"][0]["to"] == "Harrowgate" and sl.days_of(e1["trips"][0]["takes"]) == 3
    t2 = "The next morning she rode into Harrowgate. Blossom covered the orchard."
    e2 = entry(2, t2)
    e2["trips"] = [{"from": "Gullhaven", "to": "Harrowgate", "takes": "the next morning"}]
    e2["time"]["day"] = "day 1"
    codes = {f["code"] for f in sl.check([e1], e2, t2)}
    assert {"TRAVEL_TOO_FAST", "SEASON_JUMP", "DAY_BACKWARDS"} <= codes, codes
    e3 = dict(e2, trips=[], time={"day": "day 90", "season": "spring", "since_previous": "three months",
                                  "date": ""})
    assert not {f["code"] for f in sl.check([e1], e3, "Blossom covered the orchard.")} & {"SEASON_JUMP",
                                                                                           "DAY_BACKWARDS"}
    # the brief carries the travel table and the time
    st = sl.state_before([e1])
    assert st["travel"] and st["time"]["season"] == "winter"


def test_h9_who_knows_what_and_relationships():
    t1 = "Mara Vell learned that the keeper had gone out with a stranger."
    e1 = entry(1, t1)
    assert e1["knowledge"][0]["how"] == "learns"
    t2 = "Mara Vell was stunned to learn that the keeper had gone out with a stranger."
    e2 = entry(2, t2)
    assert any(f["code"] == "ALREADY_KNEW" for f in sl.check([e1], e2, t2))
    e1["relationships"] = [{"a": "Mara Vell", "b": "Nessa Crane", "line": "wary; Nessa sells answers"}]
    e2["relationships"] = [{"a": "Nessa Crane", "b": "Mara Vell", "line": "friends now"}]
    st = sl.state_before([e1, e2])
    assert [r["line"] for r in st["relationships"].values()] == ["friends now"]


def test_h19_money_prices_and_distances():
    t1 = "Nessa wanted three silver coins for the answer. The reef lay two miles out."
    e1 = entry(1, t1)
    assert {(x["what"], x["value"]) for x in e1["numbers"]} >= {("silver coin", "three"), ("distance in miles", "two")}
    t2 = "The reef lay five miles out."
    e2 = entry(2, t2)
    assert any(f["code"] == "NUMBER_CHANGED" for f in sl.check([e1], e2, t2))


def test_h1_big_cast_is_chosen_by_who_is_in_the_chapter_not_by_a_fixed_number():
    state = {f"Hero{i:02d} Vale": {"name": f"Hero{i:02d} Vale", "values": {"duty": i % 10}, "chapter": 1} for i in range(30)}
    present = [f"Hero{i:02d} Vale" for i in (3, 19, 20, 27)]
    out = cs.brief(state, present)
    assert [p["name"] for p in out][:4] == present  # character #20 (and #27) are there, first
    assert len(out) == 6  # plus others only to fill (absent people are cut first)
    assert cs.MAX_PEOPLE >= 20


def test_profile_setting_positions_and_acts():
    assert clean_profile({"checkpoint_every": "3"})["checkpoint_every"] == 3
    assert clean_profile({"checkpoint_every": 0})["checkpoint_every"] == 0
    with pytest.raises(AkoweError):
        clean_profile({"checkpoint_every": "every so often"})
    assert checkpoints.positions(12, 5) == [5, 10, 12]
    assert checkpoints.positions(12, 0, [4, 8]) == [4, 8, 12]
    assert checkpoints.positions(3, 5) == [3]
    from autobook_fake import fact, plan_item
    chs = [plan_item(f"ch{i + 1}", i, "x") for i in range(6)]
    for i, c in enumerate(chs):
        c["facts"].append(fact(f"ch{i + 1}", "plan.act", 1 if i < 2 else 2 if i < 5 else 3, "PLAN"))
    assert checkpoints.act_ends({"data": {"chapters": chs}}) == [2, 5]
    parts = checkpoints.make_parts([{"chapter_id": "a", "number": 1, "text": "x" * 50},
                                    {"chapter_id": "b", "number": 2, "text": ("y" * 40 + "\n\n") * 5}], budget=100)
    assert [p["chapter_ids"] for p in parts][0] == ["a", "b"] and len(parts) >= 3  # b is split at paragraph breaks


# =========================================================================================== in a run (H1 H2 H20)
def test_h1_h2_next_chapter_writer_reviewer_and_editor_get_the_end_story_so_far_and_ledger(tmp_path):
    fake = BookFakeAI()
    fake.story_ledger = True
    fake.chapter_texts["ch1"] = text_of(1, "Mara Vell twisted her ankle on the slick steps and limped to the door. "
                                           "She lost her knife in the surf.")
    fake.chapter_texts["ch2"] = text_of(2, "At dusk Mara Vell ran along the harbour wall.")
    fake.editor_flags = {"knocked together like restless teeth": "knocked together"}
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"length": "short_story"}))
    pid = run["project_id"]
    briefs = {(ctx.get("request_payload") or {}).get("chapter_id"): ctx.get("writing_brief") or {}
              for _t, ctx in fake.prompts["C02"]}
    b2 = briefs["ch2"]
    ch1 = approved_text(app, pid, "ch1")
    # H1: the end of the actual previous chapter and what really happened, not just the plan
    assert b2["previous_chapter_end"] and ch1.endswith(b2["previous_chapter_end"])
    assert "lost her knife" in b2["previous_chapter_end"]
    assert b2["story_so_far"][0].startswith("Chapter 1:")
    assert sl.RULE in b2["rules"]
    # H2: the injury and the lost item reach the next writer
    people = " ".join(b2["story_ledger"]["people"])
    assert "Mara Vell" in people and "ankle" in people and "lost: knife" in people
    assert "Gullhaven" in " ".join(b2["story_ledger"]["names"])  # H4: the names so far
    # the reviewer of chapter 2 had the same
    reviews = [ctx for _t, ctx in fake.prompts["review"] if '"chapter_id": "ch2"' in str(ctx.get("draft", {}).get(
        "data_json")) or (ctx.get("continuity") or {}).get("story_so_far")]
    assert any((c.get("continuity") or {}).get("previous_chapter_end") for c in reviews)
    # H20: the editor's rewrite of chapter 2 saw the tracked continuity
    rw = [ctx for _t, ctx in fake.prompts.get("rewrite", []) if (ctx.get("continuity") or {}).get("story_so_far")]
    assert rw and rw[0]["continuity"]["previous_chapter_end"]
    # H2: the automatic check flagged limping → running in the next chapter, visibly
    flags = events(app, run, "CONTINUITY_FLAG")
    assert any("chapter 2" in e["message"] and "runs, but was hurt" in e["message"] for e in flags), flags
    e2 = sl.get_chapter(app.store, pid, BR, "ch2")
    assert e2["flags"] and not e2["weak"] and e2["made_by"]["kind"] == "ai"
    # the page and the book folder show the ledger
    st, page = app.route("GET", f"/api/projects/{pid}/branches/main/review/continuity", {}, None, "author", {})
    assert st == 200 and page["story_ledger"]["flags"] and page["checkpoints"]["items"][0]["final"]
    md = continuity.render_markdown(app, pid, BR)
    assert "📒 Story ledger" in md and "🧭 Checkpoints" in md


def test_h21_weak_reading_is_marked_and_read_again_when_an_ai_is_free(tmp_path):
    class BusyForChapterOne(BookFakeAI):
        def __init__(self):
            super().__init__()
            self.story_ledger = True
            self.ch2_started = False

        def _answer(self, ctx, props, schema):
            if "objective_assessments" in props and (ctx.get("request_payload") or {}).get("chapter_id") == "ch2":
                self.ch2_started = True
            if "tracked_scenes" in props and (ctx.get("chapter") or {}).get("number") == 1 and not self.ch2_started:
                raise AkoweError("RATE_LIMITED", "", "the AI is busy")
            return super()._answer(ctx, props, schema)
    fake = BusyForChapterOne()
    app = make_app(tmp_path, fake=fake)
    seen = {}
    orig = continuity.after_chapter

    def spy(svc, run, cid, rec=None, item=None):
        orig(svc, run, cid, rec, item)
        if cid == "ch1":
            seen["ch1"] = sl.get_chapter(app.store, run["project_id"], BR, "ch1")
            seen["item"] = dict(item.get("continuity") or {}) if item else None
    continuity.after_chapter = spy
    try:
        run = done(run_book(app, {"length": "short_story"}))
    finally:
        continuity.after_chapter = orig
    pid = run["project_id"]
    # while no AI was free: Akọwe's own reading, marked weak — visibly
    assert seen["ch1"]["weak"] and seen["ch1"]["weak_why"] == "busy" and seen["ch1"]["made_by"]["kind"] == "akowe"
    assert seen["item"]["weak"] is True
    assert any("read weakly" in e["message"] for e in events(app, run, "CONTINUITY_WEAK"))
    # …and read again by the AI once one was free (before chapter 2 was tracked)
    e1 = sl.get_chapter(app.store, pid, BR, "ch1")
    assert not e1["weak"] and e1["made_by"]["kind"] == "ai"
    assert events(app, run, "CONTINUITY_RETRACKED")
    assert continuity.tracked(app.store, pid, BR, "ch1")


# =========================================================================================== checkpoints in a run
def planted_book():
    fake = BookFakeAI()
    fake.story_ledger = True
    fake.confirm_flags = True
    fake.max_chapters = 12
    fake.chapter_texts["ch3"] = text_of(3, "Mara Vell twisted her ankle on the reef and limped back across the "
                                           "stones.")
    fake.chapter_texts["ch4"] = text_of(4, "In the dark Mara Vell lost her knife in the surf.")
    fake.chapter_texts["ch7"] = text_of(7, "When the bell rang, Mara Vell ran down the quay to the boats.")
    fake.chapter_texts["ch8"] = text_of(8, "Out on the wall, Mara drew her knife and cut the rope.")
    return fake


def checkpoint_reads(fake):
    """[(after_chapter, final, [chapter numbers read in full])] of every checkpoint call."""
    return [(ctx["checkpoint"]["after_chapter"], ctx["checkpoint"]["final"], [c["number"] for c in ctx["chapters"]])
            for _t, ctx in fake.prompts.get("checkpoint", [])]


def test_twelve_chapter_book_checkpoint_every_five_catches_and_fixes_planted_contradictions(tmp_path):
    fake = planted_book()
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"checkers": "one", "length": "novella"}))
    pid = run["project_id"]
    cps = {c["id"]: c for c in checkpoints.items(app.store, pid, BR)}
    assert set(cps) == {"after-5", "after-10", "final"}
    c10 = cps["after-10"]
    assert c10["counts"]["fixed"] == 2 and c10["counts"]["waiting"] == 0, c10["problems"]
    assert {p["number"] for p in c10["problems"]} == {7, 8}
    # the fixes are minimal edits of exactly those chapters, reviewed and approved again
    t7, t8 = approved_text(app, pid, "ch7"), approved_text(app, pid, "ch8")
    assert "Mara Vell limped down the quay" in t7 and "ran down the quay" not in t7
    assert "found only the empty sheath" in t8 and "drew her knife" not in t8
    assert text_of(7).split("\n\n")[0] in t7  # the rest of the chapter is untouched
    for cid in ("ch7", "ch8"):
        e = sl.get_chapter(app.store, pid, BR, cid)
        assert not [f for f in e["flags"] if f["code"] in ("INJURY_IGNORED", "LOST_ITEM_BACK")], e["flags"]
    assert cps["after-5"]["counts"]["found"] == 0 and cps["final"]["counts"]["found"] == 0
    # cost: each checkpoint reads only its own new chapters in full; only the final one reads the whole book
    reads = checkpoint_reads(fake)
    by = {}
    for after, final, nums in reads:
        by.setdefault((after, final), []).extend(nums)
    assert sorted(by[(5, False)]) == [1, 2, 3, 4, 5]
    assert sorted(by[(10, False)]) == [6, 7, 8, 9, 10]
    assert sorted(by[(12, True)]) == list(range(1, 13))
    assert len(reads) == 3  # each fits one AI call
    # shown in the run's step list and in a plain report
    st = steps(app.autobook.public(app.autobook.get(run["id"])))["chapters"]
    assert "🧭 Checkpoint after chapter 10: 2 problems fixed" in st["checkpoints"]
    assert any(line.startswith("🧭 Final check of the whole book after chapter 12: no problems found")
               for line in st["checkpoints"])
    s, rep = app.route("GET", f"/api/projects/{pid}/branches/main/review/continuity/checkpoints", {}, None,
                       "author", {})
    assert s == 200 and "Checkpoint after chapter 10: 2 problems fixed" in rep["markdown"]
    assert "✔ fixed" in rep["markdown"] and "limped" in rep["markdown"]
    # the checkpoint summary is used for the older chapters' story so far (compressed)
    outline = BookPath(app.engine, "author", pid, BR).outline()
    brief, _m = chapter_brief.build(app.store, pid, BR, outline, "ch12")
    assert any(x.startswith("Chapters 1–5:") for x in brief["story_so_far"]), brief["story_so_far"]


def test_a_problem_that_cannot_be_fixed_safely_pauses_once_and_continue_goes_on(tmp_path):
    fake = BookFakeAI()
    fake.story_ledger = True
    fake.checkpoint_extra = [{"chapter": 2, "quote": "every captain looked away",
                              "problem": "Nessa says the keeper went out, but chapter 1 shows him in the lamp room."}]
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"checkers": "one", "length": "short_story"})
    assert run["status"] == "paused" and run["problem"]["code"] == "CHECKPOINT_WAITING", run.get("problem")
    assert "chapter 2" in run["problem"]["message"] and run["problem"]["options"] == ["edit"]
    assert "🧭 Final check of the whole book after chapter 3: 1 waiting for you" in steps(run)["chapters"][
        "checkpoints"]
    n_calls = len(checkpoint_reads(fake))
    app.autobook.decide("author", run["id"], {"action": "edited"})
    app.autobook.wait_for(run["id"], 120)
    run = done(app.autobook.public(app.autobook.get(run["id"])))
    assert len(checkpoint_reads(fake)) == n_calls  # ▶ Continue never reads the book again
    cp = checkpoints.items(app.store, run["project_id"], BR)[-1]
    assert cp["status"] == "done" and cp["problems"][0]["status"] == "waiting"
    assert "⏸ waiting for you" in "\n".join(checkpoints.markdown(checkpoints.report(app.store, run["project_id"],
                                                                                     BR)))


def test_resume_mid_checkpoint_does_not_read_finished_parts_again(tmp_path, monkeypatch):
    monkeypatch.setattr(checkpoints, "PART_CHARS", 250)  # a chapter is read in more than one part
    fake = BookFakeAI()
    fake.story_ledger = True
    app = make_app(tmp_path, fake=fake)
    state = {"run": None, "n": 0}
    orig = fake.submit

    def submit(slot, system, user, schema):
        if "problems" in (schema.get("properties") or {}) and '"checkpoint"' in user:
            state["n"] += 1
            if state["n"] == 2:
                app.autobook.pause("author", state["run"])
        return orig(slot, system, user, schema)
    fake.submit = submit
    r = app.autobook.start("author", {"author_confirms": True, "length": "short_story", "checkers": "one"})
    state["run"] = r["id"]
    app.autobook.wait_for(r["id"], 120)
    run = app.autobook.get(r["id"])
    assert run["status"] == "paused", run.get("problem")
    cp = checkpoints.items(app.store, run["project_id"], BR)[-1]
    flags = [p["done"] for p in cp["parts"]]
    assert len(flags) >= 3 and flags[0] and not flags[1] and not flags[-1], flags
    first = [(x["number"], f"{x['piece']} of {x['of']}" if x["of"] > 1 else None) for x in cp["parts"][0]["pieces"]]
    app.autobook.resume("author", r["id"])
    app.autobook.wait_for(r["id"], 120)
    done(app.autobook.public(app.autobook.get(r["id"])))
    reads = [[(c["number"], c.get("piece")) for c in ctx["chapters"]] for _t, ctx in fake.prompts["checkpoint"]]
    assert reads.count(first) == 1, reads  # the finished part was never read again
    assert len(reads) == len(flags) + 1, reads  # every other part once (the one interrupted by Pause twice)
    cp = checkpoints.items(app.store, run["project_id"], BR)[-1]
    assert cp["status"] == "done" and all(p["done"] for p in cp["parts"])


def test_fix_never_touches_the_authors_own_text(monkeypatch):
    class Svc:
        store = None

        def check(self, run):
            pass

        def bp(self, run):
            return types.SimpleNamespace(rec=lambda rid: {"record_id": rid, "version": 2,
                                                          "data": {"text": "Mara ran home."}})

        def _ai_made(self, run, rec):
            return False

        def _review_until_approved(self, *a, **k):
            raise AssertionError("never reviewed: nothing was changed")
    monkeypatch.setattr(checkpoints, "_texts", lambda svc, run: {"ch1": {"record_id": "r1"}})
    monkeypatch.setattr(checkpoints, "_put", lambda *a, **k: None)
    cp = {"id": "final", "problems": [{"id": "p1", "chapter_id": "ch1", "number": 1, "problem": "x",
                                       "original": "ran", "replacement": "limped", "status": "new"}], "fixes": {}}
    checkpoints._fix(Svc(), {"project_id": "p", "branch_id": BR}, {}, cp, "🧭")  # noqa: SLF001
    assert cp["problems"][0]["status"] == "waiting" and "your own text" in cp["problems"][0]["why"]
