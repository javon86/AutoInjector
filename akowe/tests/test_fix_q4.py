"""🧹 Batch Q4 — junk is refused early, and ONE clean-up for AI text.

Each stress ID of the batch has its regression here: the stress harness scenario that found it (tools/stress) must now
come out ✅ HANDLED or 🟡 SAFE STOP, plus fast unit tests of the new pure parts (ai_text, draft_guard, the outline's
repeated objectives, the one-judge rule of pairwise, the files' title / author).
"""
from __future__ import annotations

import pytest

from akowe import ai_text, draft_guard, pairwise
from akowe.modules.set_b import repeated_objectives
from tools.stress import core

YORUBA = "Ọmọ ọ̀ràn ẹ́ ṣé — Àdììtú ilé-ìmọ́lẹ̀"


# ====================================================================== the shared clean-up (ai_text)
def test_clean_removes_controls_bidi_and_zero_width_but_keeps_tone_marks_and_emoji():
    weird = "‮The Book​‍ of\x00 X\x07\x1b[31m Red\t\r\nEnd ﻿"
    assert ai_text.clean(weird) == "The Book of X Red\t\nEnd "
    assert ai_text.clean("Ann\x00e \x1b[31mBell\x07") == "Anne Bell"
    assert ai_text.clean(YORUBA) == YORUBA                      # accents and Yorùbá tone marks stay (no normalising)
    family = "👩‍👩‍👧 می‌خواهم"                  # joiners inside emoji / Persian words stay
    assert ai_text.clean(family) == family
    assert ai_text.clean("a‎‏b") == "a‎‏b"  # LRM / RLM marks are kept (Arabic, Hebrew)
    assert ai_text.clean("a⁦b⁩c\x7f\x85d") == "abcd"
    assert ai_text.clean(None) is None and ai_text.clean(5) == 5
    assert not ai_text.needs_cleaning(YORUBA) and ai_text.needs_cleaning("x\x00")


def test_clean_tree_cleans_every_string_and_keeps_untouched_objects():
    data = {"title": "A\x00B", "list": ["ok", "x‮y", {"k​": ("t\x07",)}], "n": 3}
    assert ai_text.clean_tree(data) == {"title": "AB", "list": ["ok", "xy", {"k": ("t",)}], "n": 3}
    clean = {"a": ["b", {"c": "d"}], "e": 1}
    assert ai_text.clean_tree(clean) is clean


# ====================================================================== pure parts
def test_draft_guard_same_text_and_lengths():
    a = "# Chapter 1\n\n" + "Mara climbed the hundred steps of the lighthouse in the fog and the cold. " * 3
    assert draft_guard.same_text(a, a.replace("# Chapter 1", "# Chapter 2"))   # only the title differs
    assert draft_guard.same_text(a, a.upper().replace("  ", " "))
    assert not draft_guard.same_text(a, "# Chapter 2\n\n" + "Tom rowed out to the reef at dawn, alone. " * 3)
    assert draft_guard.length_kind(7, 1300) == "short"
    assert draft_guard.length_kind(62, 1300) is None              # merely short: the editor's business, not refused
    assert draft_guard.length_kind(54000, 1300) == "long" and draft_guard.length_kind(2000, 1300) is None
    assert draft_guard.length_kind(7, None) is None
    run = {"draft_guard": {"ch2": {"note": "Write it at length."}}}
    out = draft_guard.with_note(run, "ch2", {"instruction": "Write chapter ch2: x" + "y" * 2000})
    assert out["instruction"].startswith("Write it at length.") and len(out["instruction"]) == 2000
    assert draft_guard.with_note(run, "ch1", {"instruction": "z"}) == {"instruction": "z"}


class _Item:
    def __init__(self, index, objective):
        self.index, self.obj = index, objective

    def get(self, predicate, default=None):
        return self.obj if predicate == "plan.objective" else default


def test_repeated_objectives_are_named_by_chapter():
    items = [_Item(0, "Mara climbs the lighthouse"), _Item(1, "Mara climbs the lighthouse."),
             _Item(2, "MARA  climbs the lighthouse"), _Item(3, "Mara reads the log"), _Item(4, "Go"), _Item(5, "Go")]
    assert repeated_objectives(items) == [(1, 2), (1, 3)]      # case / punctuation / spacing ignored; short skipped
    assert repeated_objectives([_Item(0, "A b c (part 1)"), _Item(1, "A b c (part 2)")]) == []


def test_one_judge_counts_only_when_both_orders_agree():
    assert pairwise.split_ok(["a", "a"]) and pairwise.split_ok(["tie", "tie"])
    assert not pairwise.split_ok(["a", "b"])                    # it chose the text shown first both times
    assert not pairwise.split_ok(["a", None])                   # answered once only


def test_files_get_a_clean_title_and_author_within_the_form_limits(tmp_path):
    from akowe.book_path import BookPath
    from test_autobook import make_app

    app = make_app(tmp_path)
    pid = app.engine.bootstrap_project("author", "Book")
    app.store.set_setting(f"book_profile:{pid}", {"title": ("The Very Long Title " * 150)[:3000],
                                                   "author": "Ann\x00e \x1b[31mBell\x07"})
    title, author = BookPath(app.engine, "author", pid, "main").title_author()
    assert len(title) <= 200 and title.startswith("The Very Long Title") and author == "Anne Bell"


# ====================================================================== the stress scenarios of the batch
IDS = {  # result ID -> the results it may have now
    "A-2-l": {core.HANDLED},           # control characters in the AI's title / idea
    "A-2-n": {core.HANDLED, core.SAFE},  # an empty profile answer is asked again, then a clear pause
    "B-3-m": {core.HANDLED},           # odd characters in AI character names
    "B-5-l": {core.HANDLED},           # control characters in the looks
    "C-8-o": {core.HANDLED},           # the lock list
    "C-10-l": {core.HANDLED, core.SAFE},  # identical chapter objectives are refused
    "C-10.5-m": {core.HANDLED},        # the shape changed while its beats were placed
    "D-11-o": {core.HANDLED},          # control characters in Book Bible answers
    "E-12.2-j": {core.HANDLED, core.SAFE},  # one-sentence chapters
    "E-12.2-k": {core.HANDLED, core.SAFE},  # a 54 000-word chapter
    "E-12.2-l": {core.HANDLED, core.SAFE},  # the same chapter text every time
    "E-12.2-o": {core.HANDLED},        # control characters in the prose
    "E-12.7-l": {core.HANDLED},        # a hand edit during the guard check
    "E-12.9-l": {core.HANDLED},        # one judge with a position bias
    "E-12.9-m": {core.HANDLED},        # control characters in the second version
    "F-14-k": {core.HANDLED},          # a stored 3 000-character title, control characters in the author
}


@pytest.fixture(scope="module")
def sections():
    loaded: dict = {}
    yield lambda letter: loaded.setdefault(letter, core.load_section(letter))
    core.cleanup_tmp()


@pytest.mark.parametrize("rid", sorted(IDS))
def test_stress_scenario_is_handled_now(sections, rid):
    sec, rest = rid.split("-", 1)
    part, letter = rest.rsplit("-", 1)
    if sec == "E":
        sec = "E1" if part in ("12.1", "12.2", "12.3", "12.4", "12.5", "12.6") else "E2"
    section = sections(sec)
    o = core.run_one(section, section.stresses[(part, letter)], seed=0, verbose=False)
    assert o.result in IDS[rid], (o.result, o.happened, o.issues, o.risks)
