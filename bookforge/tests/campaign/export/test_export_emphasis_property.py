"""Property and speed tests for inline emphasis (exporters.book.inline_runs).

The parser may only ever remove the delimiters of the emphasis pairs it reports (and the backslash of \\* / \\_);
every other character of the author's text is kept, in order, unchanged."""
from __future__ import annotations

import random
import time
from collections import Counter

import pytest

from bookforge.exporters.book import _emphasis, inline_runs, para_block

ALPHABET = "ab1 *_*_.,/?!'-é"


def _random_lines(seed: int, count: int):
    rnd = random.Random(seed)
    for _ in range(count):
        yield "".join(rnd.choice(ALPHABET) for _ in range(rnd.randint(0, 24)))


@pytest.mark.parametrize("seed", range(8))
def test_visible_text_is_the_input_minus_only_the_reported_delimiters(seed):
    for line in _random_lines(seed, 2500):
        runs, removed = _emphasis(line)
        visible = "".join(t for t, _ in runs)
        assert visible == "".join(c for i, c in enumerate(line) if i not in removed), line
        gone = Counter(line[i] for i in removed)
        assert set(gone) <= {"*", "_"}, (line, gone)  # (no backslashes in this alphabet)
        assert gone["*"] % 2 == 0 and gone["_"] % 2 == 0, (line, runs)  # delimiters come in pairs
        assert bool(removed) == any(st for _, st in runs), (line, runs)  # removed <=> some emphasis reported
        assert all(t for t, _ in runs)
        assert all(a[1] != b[1] for a, b in zip(runs, runs[1:]))  # adjacent runs are merged


@pytest.mark.parametrize("seed", range(3))
def test_text_without_delimiters_is_untouched(seed):
    rnd = random.Random(seed)
    for _ in range(500):
        line = "".join(rnd.choice("abc xyz12.,/?!'-éß\\") for _ in range(rnd.randint(1, 40)))
        assert inline_runs(line) == [(line, "")]


def test_escapes_drop_only_their_backslash():
    runs, removed = _emphasis(r"keep \*this\* and \_that\_ and \n")
    assert "".join(t for t, _ in runs) == r"keep *this* and _that_ and \n"
    assert all(st == "" for _, st in runs)


@pytest.mark.parametrize("line,expect", [
    ("*NSYNC played and *Bob* came", [("*NSYNC played and ", ""), ("Bob", "i"), (" came", "")]),
    ("He said _never_.", [("He said ", ""), ("never", "i"), (".", "")]),
    ("**bold *and italic* text**", [("bold ", "b"), ("and italic", "bi"), (" text", "b")]),
    ("She *really* did. f*ck *yes*", [("She ", ""), ("really", "i"), (" did. f*ck ", ""), ("yes", "i")]),
    ("Open file_name.py or _x_.", [("Open file_name.py or ", ""), ("x", "i"), (".", "")]),
])
def test_mixed_prose(line, expect):
    assert inline_runs(line) == expect
    assert para_block("x-p1", line, False)["text"] == "".join(t for t, _ in expect)


@pytest.mark.parametrize("unit", ["*a ", "a* ", "x*y ", "*", "*a", "_a ", "a*b*c", "**a *b ", "f*ck "])
def test_long_paragraphs_of_unmatched_stars_are_fast(unit):
    text = (unit * (15000 // len(unit) + 1))[:15000]
    t0 = time.perf_counter()
    runs = inline_runs(text)
    assert time.perf_counter() - t0 < 0.5  # was 1.3 s for a 15k-character paragraph
    assert len("".join(t for t, _ in runs)) <= len(text)
