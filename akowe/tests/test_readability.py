"""P24 readability and pacing: reading level, sentence variety, dialogue share, scenes and pace, matched to the
profile's audience; part of the 📊 book report (numbers, Markdown/PDF, what to try next)."""
from __future__ import annotations

import time
import types

import pytest

from bookforge import book_report as br
from bookforge import h_checks as hc
from bookforge import providers as prov_mod
from bookforge import readability as rd

from test_failover_review import SlotFake, make_app, run_book

PLAIN = ("The dog ran. It was red. Sam saw it. He sat down. The sun was up. "
         "She had a cat. The cat was fat. They all went home. ") * 30
DENSE = ("Notwithstanding the considerable institutional complications surrounding the administration of the "
         "lighthouse, the superintendent, whose responsibilities encompassed maintenance, documentation and "
         "extraordinarily meticulous correspondence with the provincial authorities, deliberated interminably "
         "before authorising any modification whatsoever to the illumination apparatus. ") * 15
DIALOGUE = "\n\n".join(f'“Where were you, {n}?” Mara asked.\n\n“Out on the rocks,” he said. “The tide was low.”'
                       for n in ("Tom", "Ben", "Wil", "Jon", "Ned", "Sid") * 6)


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def test_syllables_and_scenes():
    assert [rd.syllables(w) for w in ("cat", "lighthouse", "the", "table", "beautiful", "")] == [1, 2, 1, 2, 3, 1]
    text = "# Chapter 1\n\nOne scene here.\n\n* * *\n\nA second scene.\n\n***\n\nA third.\n\n#\n\nFourth."
    assert len(rd.scenes(text)) == 4
    assert len(rd.scenes("Only one scene, no breaks.")) == 1


def test_audience_matching():
    assert rd.audience_of("Adult")["key"] == "adult"
    assert rd.audience_of("")["key"] == "adult"
    assert rd.audience_of("Young adult (14+)")["key"] == "young_adult"
    assert rd.audience_of("teens")["key"] == "young_adult"
    assert rd.audience_of("Middle grade, ages 8-12")["key"] == "middle_grade"
    assert rd.audience_of("Kids who love dragons")["key"] == "children"
    assert rd.audience_of("Adult", "Literary fiction")["grade"][1] == rd.AUDIENCES["adult"]["grade"][1] + 2


def test_plain_text_is_easy_and_dense_text_is_hard():
    easy, hard = rd.chapter(PLAIN), rd.chapter(DENSE)
    assert easy["grade"] < 3 and easy["ease"] > 90
    assert hard["grade"] > 15 and hard["ease"] < 30
    assert hard["avg_sentence"] > easy["avg_sentence"] and hard["long_share"] == 1.0
    assert easy["short_share"] == 1.0


def test_dialogue_share_and_pace():
    d = rd.chapter(DIALOGUE)
    assert 0.4 < d["dialogue_share"] < 0.9 and d["pace"] == "fast"
    assert rd.chapter(DENSE)["dialogue_share"] == 0 and rd.chapter(DENSE)["pace"] == "slow"


def test_empty_and_odd_input_never_breaks():
    assert rd.chapter("")["grade"] is None
    r = rd.book([("c1", ""), ("c2", None), ("c3", 42)])
    assert r["totals"]["grade"] is None and r["findings"] == [] and len(r["chapters"]) == 3


def test_findings_against_the_audience():
    hard = rd.book([("c1", DENSE)], audience="Middle grade")
    ids = {f["id"] for f in hard["findings"]}
    assert {"reading_level_high", "long_sentences", "many_long"} <= ids
    assert hard["findings"][0]["severity"] == "major"  # sorted most severe first
    simple = rd.book([("c1", PLAIN)], audience="Adult")
    assert "reading_level_low" in {f["id"] for f in simple["findings"]}
    assert "little_dialogue" in {f["id"] for f in simple["findings"]}
    talky = rd.book([("c1", DIALOGUE)], audience="Children")
    assert "reading_level_high" not in {f["id"] for f in talky["findings"]}


def test_chapter_that_reads_differently_is_named():
    mid = ("Mara walked down to the harbour and counted the boats that had come in before the storm. "
           "The keeper watched her from the gallery and did not wave. ") * 15
    r = rd.book([("c1", mid), ("c2", mid), ("c3", DENSE), ("c4", mid)], audience="Adult")
    jump = next(f for f in r["findings"] if f["id"] == "chapter_level_jump")
    assert jump["chapters"] == [3]


def test_brief_is_numbers_only():
    b = rd.brief(rd.book([("c1", DIALOGUE)], audience="Adult"))
    assert set(b["chapters"][0]) == {"number", "chapter_id", "words", "grade", "ease", "avg_sentence",
                                     "dialogue_share", "scenes", "pace"}
    assert "Mara" not in repr(b) and "rocks" not in repr(b)


def test_book_report_includes_readability(tmp_path):
    app = make_app(tmp_path, SlotFake())
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    rep = app.reports.latest(run["project_id"], "main")
    r = rep["readability"]
    assert r["totals"]["grade"] is not None and r["audience"]["key"] in rd.AUDIENCES
    assert len(r["chapters"]) == len(rep["words"]["chapters"])
    md = br.render_markdown(rep)
    assert "## Readability and pacing (no AI)" in md and "Reading level: grade" in md
    doc, issues = hc.pdf_structure(br.render_pdf(rep))
    assert doc is not None and not [i for i in issues if i.get("decision") == "FAIL"]


def test_report_survives_a_readability_crash(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("boom")
    monkeypatch.setattr(rd, "book", boom)
    app = make_app(tmp_path, SlotFake())
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done"
    rep = app.reports.latest(run["project_id"], "main")
    assert rep["readability"] == {"error": True}
    assert "## Readability" not in br.render_markdown(rep)


def test_try_next_uses_readability_findings():
    rep = {"aggregate": {"dimensions": []}, "readability": {"findings": [
        {"id": "a", "label": "Harder to read", "severity": "major", "detail": "Grade 14.", "advice": "Split."},
        {"id": "b", "label": "Many long", "severity": "minor", "detail": "20%.", "advice": "Trim."},
        {"id": "c", "label": "Low", "severity": "minor", "detail": "x", "advice": "y"},
        {"id": "d", "label": "Info", "severity": "info", "detail": "x", "advice": "y"}]}}
    out = [t for t in br.ReportService.try_next(rep) if t["from"] == "readability"]
    assert len(out) == 2 and out[0]["text"].startswith("Harder to read")
