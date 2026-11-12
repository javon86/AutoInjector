"""📏 Chapters kept near their share of the book when written (lengths.rule: the exact range ±10 %), and the book
report's length line with each chapter against its share (length_guard.line)."""
from __future__ import annotations

from akowe import length_guard, lengths


def test_the_writer_is_told_the_chapter_share_and_its_range():
    plan = lengths.chapter_plan({"length": "short_story"})          # 4,000 words in 3 chapters
    assert plan["target_words"] == 1333 and plan["aim_min_words"] == 1200 and plan["aim_max_words"] == 1466
    rule = lengths.rule(plan)
    assert "about 1,333 words" in rule and "between 1,200 and 1,466 words" in rule and "never more than 1,466" in rule
    # an older plan without the range still gets one
    old = {k: v for k, v in plan.items() if not k.startswith("aim_")}
    assert "between 1,200 and 1,466 words" in lengths.rule(old)


def test_the_length_line_names_each_chapter_against_its_share():
    ln = length_guard.line(4560, 4000, [1300, 1600, 1660], 1333)
    assert ln.startswith("📏 Length: 4,560 words (114% of the 4,000-word target)")
    assert "chapters against their ~1,333-word share: ch1 1,300 (98%), ch2 1,600 (120% ⚠️), ch3 1,660 (125% ⚠️)" in ln
    assert length_guard.line(4000, 4000) == "📏 Length: 4,000 words (100% of the 4,000-word target)"
    assert length_guard.line(None, 4000, [1, 2], 3) is None
