"""Q3 — nothing goes missing silently (docs/stress/FIX_PLAN_QUALITY.md batch Q3, and section D of the stress test).

One regression test per stress finding: the promise ledger (C-10.2-a/d/e/f/j/o, C-10.3-i), the who-knows-what grid
(C-10.4-l), the character sheets (B-4-d/e/l), the ending checklist (E-12.10-g), the trade card (C-10.6-l/m) and the
"Fill the whole Book Bible" step (D-11-a/c/g/j/l/m/r)."""
from __future__ import annotations

import time
import types

import pytest

from akowe import autobook as ab_mod
from akowe import characters as chars_mod
from akowe import ending_writer, forge, forge_kinds, predictability, promise_ledger, providers as prov_mod
from akowe import trade_card as tc
from akowe import usage_limits, whole_bible
from akowe.errors import AkoweError

from autobook_fake import trust_one_ai
from test_failover_review import SlotFake
from test_failover_review import make_app as slot_app
from test_world_planned import book
from test_whole_bible import BR, NUMBERS, chars, done, fake_ai, make_app, run_book

KEY = "Mara hides the brass key under the third lighthouse stair"


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def _ledger(ctx):
    n = len(ctx["chapters"])
    return {"promises": [{"promise": KEY, "plant": 1, "payoff": "Mara opens the lamp room with it",
                          "payoff_from": 2, "payoff_by": n}]}


def codes(run):
    return [e.get("code") for e in run["events"]]


def note(run, code):
    return [e for e in run["events"] if e.get("code") == code]


# ====================================================================== 📜 the promise ledger
def test_ledger_timeout_is_noted_and_made_on_the_second_try_after_chapter_one(tmp_path):
    """C-10.2-a / d / e / f: an AI error is said (LEDGER_FAILED) and the ledger is asked once more after chapter 1."""
    fake = SlotFake()

    def timeout(ctx):
        raise AkoweError("TIMEOUT", "", "the AI did not answer in time")
    fake.ledger_script = [timeout, _ledger]
    app, fake, run = book(tmp_path, fake)
    failed, built = note(run, "LEDGER_FAILED"), note(run, "LEDGER_BUILT")
    assert failed and "TIMEOUT" in failed[0]["message"] and "after chapter 1" in failed[0]["message"]
    assert built and "second try" in built[0]["message"]
    assert codes(run).index("LEDGER_FAILED") < codes(run).index("LEDGER_BUILT")
    info = promise_ledger.report_info(app.store, run["project_id"], "main")
    assert info and not info.get("missing") and info["total"] == 1


def test_ledger_that_fails_twice_is_said_in_the_report(tmp_path):
    fake = SlotFake()

    def garbage(ctx):
        return {"promises": [{"nope": 1}, "junk"]}  # promises listed, none usable
    fake.ledger_script = [garbage, garbage]
    app, fake, run = book(tmp_path, fake)
    assert len(note(run, "LEDGER_FAILED")) == 2 and not note(run, "LEDGER_BUILT")
    info = promise_ledger.report_info(app.store, run["project_id"], "main")
    assert info["missing"] and "could not list" in info["line"]
    assert "not tracked" in "\n".join(promise_ledger.report_md(info))


def test_no_promises_and_no_secrets_are_said_plainly(tmp_path):
    """C-10.2-j: an empty ledger is LEDGER_EMPTY (no retry); C-10.4-l: an empty grid is GRID_EMPTY, never an
    INTERNAL_ERROR failure."""
    app, fake, run = book(tmp_path, SlotFake())  # the fake answers an empty ledger and an empty grid
    assert note(run, "LEDGER_EMPTY") and not note(run, "LEDGER_FAILED")
    assert len(fake.prompts.get("ledger") or []) == 1
    assert note(run, "GRID_EMPTY") and not note(run, "GRID_FAILED")
    assert not any("INTERNAL_ERROR" in e["message"] for e in run["events"])


def test_pause_before_the_ledger_is_not_a_failure_and_resume_builds_it(tmp_path, monkeypatch):
    """C-10.2-o / C-10.3-i: a Pause caught by the ledger's AI call goes on up; ▶ Resume makes the ledger."""
    fake = SlotFake()
    fake.ledger_script = [_ledger]
    app = slot_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    app.review.editor.save_settings({"enabled": False})
    real = predictability.run_probe
    state = {"paused": False}

    def probe_then_pause(svc, run, st):
        real(svc, run, st)
        if not state["paused"]:
            state["paused"] = True
            svc.pause("author", run["id"])  # the author presses Pause while the probe works
    monkeypatch.setattr(predictability, "run_probe", probe_then_pause)
    r = app.autobook.start("author", {"author_confirms": True, "slot_id": "AI-1"})
    app.autobook.wait_for(r["id"], 120)
    run = app.autobook.get(r["id"])
    assert run["status"] == "paused" and run["pause_reason"] == "author"
    assert "LEDGER_FAILED" not in codes(run) and not run.get("ledger_built", {})
    app.autobook.resume("author", r["id"])
    app.autobook.wait_for(r["id"], 180)
    run = trust_one_ai(app, r["id"])
    assert run["status"] == "done", run.get("problem")
    assert "LEDGER_BUILT" in codes(run) and "LEDGER_FAILED" not in codes(run)


# ====================================================================== 📋 the character sheets
def test_a_sheet_that_fails_twice_is_on_the_check_later_list(tmp_path, monkeypatch):
    """B-4-d / e / l: retried once after the outline, then listed for the author."""
    fake = SlotFake()
    fake.companion = False  # the proposals come without sheets: the characters step asks the AI
    asked = {"n": 0}
    real = fake._sheet_for

    def bad_sheet(name, others=(), story_role=None):
        if name == "Mara Vell":
            asked["n"] += 1
            raise AkoweError("INVALID_INPUT", "/character_sheet", "the answer was not JSON")
        return real(name, others, story_role)
    monkeypatch.setattr(fake, "_sheet_for", bad_sheet)
    app, fake, run = book(tmp_path, fake)
    assert asked["n"] >= 2  # the first try and the second one after the outline
    assert note(run, "CHARACTER_SHEET_FAILED") and note(run, "CHARACTER_SHEET_LATER")
    raw = app.autobook.get(run["id"])
    assert any("Mara Vell: sheet and voice card missing" in x for x in raw.get("check_later") or [])
    assert not raw.get("sheet_retry")


def test_a_sheet_made_on_the_second_try_is_not_listed(tmp_path, monkeypatch):
    fake = SlotFake()
    fake.companion = False
    real = fake._sheet_for
    state = {"failed": False}

    def once(name, others=(), story_role=None):
        if name == "Mara Vell" and not state["failed"]:
            state["failed"] = True
            raise AkoweError("INVALID_INPUT", "/character_sheet", "the answer was not JSON")
        return real(name, others, story_role)
    monkeypatch.setattr(fake, "_sheet_for", once)
    app, fake, run = book(tmp_path, fake)
    assert note(run, "CHARACTER_SHEET_FAILED") and note(run, "CHARACTER_SHEET_RETRIED")
    raw = app.autobook.get(run["id"])
    assert not any("sheet and voice card missing" in x for x in raw.get("check_later") or [])
    mara = next(r for r in chars_mod.canon_characters(app.store, run["project_id"], "main") if r["name"] == "Mara Vell")
    assert chars_mod.complete(chars_mod.get_entry(app.store, run["project_id"], "main", mara["record_id"]))


# ====================================================================== 🎬 the ending checklist
def test_an_ending_checklist_that_cannot_be_made_is_noted(tmp_path, monkeypatch):
    """E-12.10-g: noted (codes only) and on the check-later list."""
    def boom(*a, **k):
        raise RuntimeError("injected")
    monkeypatch.setattr(ending_writer, "checklist", boom)
    app, fake, run = book(tmp_path, SlotFake())
    said = note(run, "ENDING_BRIEF_FAILED")
    assert said and "RuntimeError" in said[0]["message"] and "last chapter" in " ".join(e["message"] for e in said)
    assert len({e["message"] for e in said}) == len(said)  # once per chapter
    raw = app.autobook.get(run["id"])
    assert any("without its ending checklist" in x for x in raw.get("check_later") or [])


# ====================================================================== 🔧 the trade card
class _Store:
    def __init__(self, v=None):
        self.v = {}
        if v is not None:
            self.v[tc._key("p", "main")] = v  # noqa: SLF001

    def get_setting(self, k):
        return self.v.get(k)

    def set_setting(self, k, v):
        self.v[k] = v


def test_a_damaged_stored_trade_card_counts_as_missing():
    """C-10.6-m: cards that are not a list of cards are never used (a new card is made)."""
    for bad in ("garbage-not-a-list", ["x", "y"], [{"no": "craft"}], [], {"craft": "x"}):
        st = _Store({"cards": bad, "crafts": ["keeper"], "by": "ai"})
        assert tc.get_entry(st, "p", "main") is None and tc.cards_of(st, "p", "main") == []
    good = {"cards": [{"craft": "lighthouse keeping", "how_it_works": "x"}], "crafts": ["keeper"]}
    assert tc.get_entry(_Store(good), "p", "main")


def test_cards_for_trades_the_book_does_not_have_are_dropped():
    """C-10.6-l: only cards whose craft matches a trade Akọwe found are kept."""
    card = {"craft": "x", "how_it_works": "How it is done.", "steps": ["one"]}
    raw = {"craft_cards": [dict(card, craft=f"nuclear physics {i}") for i in range(50)]
           + [dict(card, craft="Lighthouse keeping")]}
    out = tc.clean(raw, sourced=False, crafts=["lighthouse keeper"])
    assert [c["craft"] for c in out] == ["Lighthouse keeping"]
    assert tc.clean({"craft_cards": raw["craft_cards"][:50]}, sourced=False, crafts=["piano tuner"]) == []
    assert tc.matches_craft("glassblower", ["glassblowing"]) and tc.matches_craft("Piano tuning", ["piano tuner"])
    assert not tc.matches_craft("surgery", ["piano tuner", "keeper"])


# ====================================================================== 📖 the whole Book Bible
@pytest.fixture
def written(tmp_path):
    fake = fake_ai()
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"genre": "Mystery", "length": "short_story", "pictures": False}))
    return app, run["project_id"], fake


def _fill(app, pid, ask, **kw):
    return whole_bible.fill(app, pid, BR, ask=ask, check=lambda: None, progress=lambda *a: None, by=None, **kw)


def _answer(fake, ctx):
    return fake._details(ctx)  # noqa: SLF001 - the Practice AI's own answer


def test_a_batch_missing_two_fields_still_fills_the_rest(written):
    """D-11-j: no key is required; the AI's other answers are kept and the summary says what it left empty."""
    app, pid, fake = written
    seen = []

    def ask(task, sch, ctx):
        seen.append(sch)
        d = _answer(fake, ctx)
        for k in sorted(d)[:2]:
            d.pop(k)
        return d, "AI-1"
    res = _fill(app, pid, ask)
    assert all(s["required"] == [] for s in seen)
    assert res["summary"]["filled_sections"] > 10 and res["left_empty"] >= 2
    assert "the AI left" in res["summary"]["message"] and not res["failed"]


def test_an_ai_that_keeps_timing_out_is_given_up_after_a_few_calls(written):
    """D-11-a: GIVE_UP_AFTER time-outs in a row and the rest is left for later (not 30 calls)."""
    app, pid, _fake = written
    n = {"calls": 0}

    def ask(task, sch, ctx):
        n["calls"] += 1
        raise AkoweError("TIMEOUT", "", "no answer in time")
    res = _fill(app, pid, ask)
    assert n["calls"] == whole_bible.GIVE_UP_AFTER and res["gave_up"]["code"] == "TIMEOUT"
    whys = {r["why"] for r in res["summary"]["reasons"]}
    assert "left for later: the AI stopped answering" in whys


def test_every_ai_at_its_usage_limit_stops_the_fill_with_a_plain_note(written):
    """D-11-c: a usage limit is named, not "the AI did not answer"."""
    app, pid, _fake = written
    n = {"calls": 0}

    def ask(task, sch, ctx):
        n["calls"] += 1
        exc = AkoweError("UPSTREAM_UNAVAILABLE", "", "every AI is at its usage limit")
        exc.usage_limited, exc.limited_names, exc.reset_at = True, ["Claude"], None
        raise exc
    try:
        res = _fill(app, pid, ask)
    finally:
        usage_limits.clear()
    assert n["calls"] == 1 and res["gave_up"]["limit"]
    events = []
    svc = types.SimpleNamespace(event=lambda run, kind, msg, **kw: events.append((msg, kw.get("code"))))
    whole_bible._notes(svc, {"id": "r"}, res)  # noqa: SLF001
    assert len(events) == 1 and "usage limit" in events[0][0] and "📖 Fill in the whole Book Bible" in events[0][0]


def test_a_fault_while_saving_or_a_deleted_page_costs_only_that_page(written):
    """D-11-g / D-11-r: an exception in accept (a bug, a full disk, a page deleted meanwhile) never stops the fill."""
    app, pid, fake = written
    real = whole_bible.accept
    calls = {"n": 0}

    def flaky(app_, pid_, branch, u, answer, slot, *, by):
        calls["n"] += 1
        if calls["n"] == 1:
            raise AkoweError("NOT_FOUND", "/record_id", "this place dossier does not exist in this book")
        if calls["n"] == 2:
            raise KeyError("injected")
        return real(app_, pid_, branch, u, answer, slot, by=by)
    whole_bible.accept = flaky
    try:
        res = _fill(app, pid, lambda task, sch, ctx: (_answer(fake, ctx), "AI-1"))
    finally:
        whole_bible.accept = real
    assert [e["code"] for e in res["errors"]] == ["NOT_FOUND", "KeyError"] and res["errors"][0]["gone"]
    assert res["summary"]["filled_sections"] > 10


def test_the_run_step_never_stops_the_book_on_its_own_fault(monkeypatch):
    """D-11-g: anything but the run's pause / cancel is a note; Pause still goes on up."""
    events = []
    svc = types.SimpleNamespace(app=None, event=lambda run, kind, msg, **kw: events.append(kw.get("code")),
                                save=lambda run: None, check=lambda run: None)
    run, st = {"id": "r", "project_id": "p", "branch_id": BR, "settings": {}}, {}

    def boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(whole_bible, "fill", boom)
    whole_bible.run_step(svc, run, st)
    assert events == ["BIBLE_FILL_FAILED"] and "stopped (OSError)" in st["message"]

    def pause(*a, **k):
        raise ab_mod.RunPaused()
    monkeypatch.setattr(whole_bible, "fill", pause)
    with pytest.raises(ab_mod.RunPaused):
        whole_bible.run_step(svc, run, {})


def test_a_swapped_batch_is_asked_again_subject_by_subject(written):
    """D-11-l: answers that describe another subject of the batch are never saved on the wrong page."""
    app, pid, fake = written
    alone = []

    def ask(task, sch, ctx):
        subs = ctx["subjects"]
        d = _answer(fake, ctx)
        if len(subs) < 2:
            alone.append(subs[0]["name"])
            return d, "AI-1"
        a, b = subs[0]["ref"], subs[1]["ref"]
        names = {s["ref"]: s["name"] for s in subs}
        out = {}
        for k, v in d.items():
            ref, field = k.split("__", 1)
            other = b if ref == a else a if ref == b else ref
            out[k] = f"About {names[other]}: {field}" if other != ref else v
        return out, "AI-1"
    res = _fill(app, pid, ask)
    assert res["mixed"] >= 1 and alone
    for c in chars_mod.canon_characters(app.store, pid, BR):
        others = [o["name"] for o in chars_mod.canon_characters(app.store, pid, BR) if o["name"] != c["name"]]
        d = forge.public(app.store, pid, BR, c["record_id"])
        for f in (f for s in d["sections"] for f in s["fields"]):
            t = f["text"] or ""
            assert not (t.startswith("About ") and any(n in t for n in others) and c["name"] not in t), (c["name"], t)


def test_mixed_up_needs_most_of_a_subjects_answers_to_name_another():
    parts = [{"ref_id": "s1", "name": "Mara Vell"}, {"ref_id": "s2", "name": "Tom Reed"}]
    # one relationship answer naming the other character is fine
    ans = {"s1": {"a": "Tom Reed: her oldest rival", "b": "Grey eyes", "c": "A slow walker", "d": "Speaks low"},
           "s2": {"a": "About Tom Reed", "b": "Tom Reed's boots"}}
    assert whole_bible.mixed_up(parts, ans) == []
    ans["s2"] = {"a": "About Mara Vell", "b": "Mara's coat", "c": "Grey eyes"}
    assert whole_bible.mixed_up(parts, ans) == ["s2"]
    # a family name the two share does not hide the mix-up
    kin = [{"ref_id": "s1", "name": "Mara Vell"}, {"ref_id": "s2", "name": "Ivo Vell"}]
    assert whole_bible.mixed_up(kin, {"s1": {"a": "About Ivo Vell", "b": "Ivo Vell's boots"},
                                      "s2": {"a": "About Mara Vell", "b": "Mara Vell's coat"}}) == ["s1", "s2"]


def test_a_huge_book_bible_is_capped_and_says_so(written):
    """D-11-m: at most ``max_calls`` calls; the rest is left for later with a plain note."""
    app, pid, fake = written
    for i in range(40):
        forge_kinds.create(app.store, pid, BR, "place", {"name": f"Harbour shed {i + 1}"})
    n = {"calls": 0}

    def ask(task, sch, ctx):
        n["calls"] += 1
        return _answer(fake, ctx), "AI-1"
    res = _fill(app, pid, ask, max_calls=5)
    assert n["calls"] == 5 and res["capped"]["planned"] > 5
    assert any(r["why"].startswith("left for later: this step asks at most 5") for r in res["summary"]["reasons"])
    events = []
    svc = types.SimpleNamespace(event=lambda run, kind, msg, **kw: events.append((msg, kw.get("code"))))
    whole_bible._notes(svc, {"id": "r"}, res)  # noqa: SLF001
    assert events and events[0][1] == "BIBLE_FILL_CAPPED" and "minutes" in events[0][0]


def test_timeouts_in_the_run_step_give_one_note_not_one_per_batch(tmp_path, monkeypatch):
    """D-11-a in a ⚡ run: the book finishes, the journal holds one note, the step stops asking."""
    fake = fake_ai()
    real = fake._details  # noqa: SLF001
    n = {"bible": 0}

    def details(ctx):
        if ctx.get("fill") == "whole_book_bible":
            n["bible"] += 1
            raise AkoweError("TIMEOUT", "", "no answer in time")
        return real(ctx)
    monkeypatch.setattr(fake, "_details", details)
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"genre": "Mystery", "length": "short_story", "pictures": False, "fill_bible": True}))
    tally = app.autobook.get(run["id"])["tally"]  # (the journal keeps only its newest lines)
    assert tally.get("code:BIBLE_FILL_LATER") == 1
    bible = next(s_ for s_ in run["steps"] if s_["id"] == "bible")
    assert "left for later: the AI stopped answering" in bible["message"]
    assert n["bible"] <= 3 * whole_bible.GIVE_UP_AFTER  # (a call may go to another AI first)
    assert chars(app, run["project_id"])
