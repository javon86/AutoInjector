"""Round-2 review: the plain chapter editor (app.js viewWrite) splits "# Title\n\nText" into title + body and joins
them back on save. Its title regex /^\s*#\s+([^\n]+)\n+/ lets \s+ run over newlines, so a chapter whose first line
is the "#" scene-break marker (book.py: a line consisting only of "#" is a scene break) is read as having the FIRST
PARAGRAPH as its title: the reader shows that paragraph as a heading, and saving without any change rewrites the
chapter (scene break gone, paragraph promoted to the "# Title" line). Same for "#   \n\nText"."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[3] / "akowe" / "web" / "app.js"


def roundtrip(text: str) -> dict:
    if not shutil.which("node"):
        pytest.skip("node not installed")
    src = APP.read_text(encoding="utf-8")
    fns = [re.search(r"^function %s\(.*?^}\n" % n, src, re.S | re.M).group(0) for n in ("splitChapter", "joinChapter")]
    js = "\n".join(fns) + f"""
const t = {json.dumps(text)}; const p = splitChapter(t);
console.log(JSON.stringify({{ title: p.title, saved: joinChapter(p.title, p.body) }}));"""
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_titled_chapter_round_trips():
    r = roundtrip("# The Reef\n\nFirst paragraph.\n\nSecond.")
    assert r == {"title": "The Reef", "saved": "# The Reef\n\nFirst paragraph.\n\nSecond."}


@pytest.mark.parametrize("text", ["#\n\nThe storm came at dawn.\n\nShe ran.", "#   \n\nThe storm came at dawn."])
def test_leading_scene_break_is_not_taken_for_a_title(text):
    r = roundtrip(text)
    assert r["title"] == "", r
    assert r["saved"].startswith("#") and "# The storm" not in r["saved"], r


@pytest.mark.parametrize("text,title", [
    ("\n\n  # Spaced Title  \n\nBody.", "Spaced Title"),
    ("# Only a title", "Only a title"),
    ("## A sub-heading first\n\nBody.", ""),
    ("#Hashtag start\n\nBody.", ""),
    ("* * *\n\nBody.", ""),
    ("# Title\r\n\r\nBody one.\r\n\r\nBody two.", "Title"),
])
def test_title_rule_matches_the_exporter(text, title):
    from akowe.exporters.book import SCENE_BREAK  # noqa: F401 - the rule lives next to it in book.py
    r = roundtrip(text)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    exp = lines[0][2:].strip() if lines and lines[0].startswith("# ") and len(lines[0]) > 2 else ""
    assert r["title"] == exp == title, r
    if not title:
        assert r["saved"] == text.rstrip(), r  # untitled text is saved back unchanged
