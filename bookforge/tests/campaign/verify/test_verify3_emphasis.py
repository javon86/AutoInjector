"""verify3: inline emphasis must never lose or mangle prose that merely contains * or _ characters.

book.inline_runs() treats any *...* pair hugging non-space text as italic, even inside words, so censored words,
arithmetic and names lose their asterisks in every export (PDF, EPUB, DOCX). Snake_case got a guard; * did not.
"""
from __future__ import annotations

import pytest

from bookforge.exporters.book import para_block

KEEP_LITERALLY = [
    "He said f*ck and sh*t, then left.",          # censored profanity: very common in fiction
    "What the f***? Holy sh*t.",
    "The answer is 5*3 and 2*4, she wrote.",
    "He rated it **** out of five.",
    "Rating: ***",
    "Open __init__.py first.",
    "See https://example.com/_drafts_/v2 for the draft.",
]


@pytest.mark.parametrize("line", KEEP_LITERALLY)
def test_prose_with_stars_and_underscores_is_kept(line):
    b = para_block("x-p1", line, False)
    assert b["text"] == line, f"{line!r} was exported as {b['text']!r} (runs {b.get('runs')})"


@pytest.mark.parametrize("line,text", [("a *real* word", "a real word"), ("**bold** move", "bold move"),
                                        ("an _aside_ here", "an aside here"), ("5 * 3 = 15", "5 * 3 = 15"),
                                        ("snake_case_words", "snake_case_words")])
def test_real_emphasis_still_works(line, text):
    assert para_block("x-p1", line, False)["text"] == text
