"""First real PC test (2026-10-28), Akọwe side of problem 6: the book report said "The editor did not read these chapter
versions" with every Editor field empty, suggestions were cut off mid-word, quoted story lines showed doubled quote
marks (""Can they save the line?""), Reports/Planned to page.md held nothing useful, and an AI-problem pause could be
"approved anyway" although no AI had reviewed the draft."""
from __future__ import annotations

import pytest

from akowe import book_report as br
from akowe.errors import AkoweError

import test_world_planned as W


# ---------------------------------------------------------------------- the editor read an earlier version
def test_report_counts_the_editor_read_before_the_planned_fix(tmp_path):
    """Every chapter got a planned-to-page fix AFTER the editor read it: the approved version was a newer one, so the
    report (matched on the exact version) found no editor read at all."""
    fake = W.SlotFake()
    fake.planned_fix = True
    app, fake, run = W.book(tmp_path, fake, {"choices": W.CHOICES}, editor=True)
    pid = run["project_id"]
    assert run["planned_summary"]["fixed"] >= 1
    rep = app.reports.make("author", pid, "main", ai=False)
    ed = rep["editor"]
    assert ed["read"] == ed["of"] == 3, ed
    assert ed["earlier"] and all(e["read_version"] < e["version"] for e in ed["earlier"])
    rows = rep["usage"]["chapters"]
    assert all(r["reviewer"] and r["editor"] for r in rows), rows
    md = br.render_markdown(rep)
    assert "The editor did not read these chapter versions" not in md and "not read again" in md
    assert "| – |" not in md.split("## AI usage", 1)[1]
    files, _info = app.saver.collect(pid, "main")
    assert "not read |" not in files["Reports/Editor summary.md"].decode()


# ---------------------------------------------------------------------- words and quote marks
def test_clip_words_never_cuts_mid_word():
    s = "Let the ending cost something and leave one question open for the reader to carry home"
    out = br.clip_words(s, 40)
    assert len(out) <= 40 and out.endswith("…") and s.startswith(out[:-1]) and out[-2] != " "
    assert s[len(out) - 1] == " "  # the cut is at a space
    assert br.clip_words("short", 40) == "short" and br.clip_words("", 5) == ""
    assert br.clip_words("Supercalifragilisticexpialidocious", 10).endswith("…")


def test_quoted_story_lines_are_not_doubled():
    assert br.quoted('"Can they save the line?"') == '"Can they save the line?"'
    assert br.quoted("“Can they save the line?”") == "“Can they save the line?”"
    assert br.quoted('"Tamsin Reed," Odile said.') == '"Tamsin Reed," Odile said.'
    assert br.quoted("The lamp went out.") == "“The lamp went out.”"
    rep = {"title": "T", "version": {"key": "k", "chapters": []}, "aggregate": {}, "words": {},
           "reviews": [{"status": "done", "name": "ChatGPT", "independent": True, "slot": "AI-2",
                        "strengths": [{"point": "Tension", "quote": '"Can they save the line?"', "verified": True}],
                        "weaknesses": []}],
           "editor": {"read": 1, "of": 1, "major": 0, "minor": 1, "dimensions": [],
                      "notes": [{"chapter": 1, "severity": "minor", "passage": '"Push," she said.', "why": "x"}]}}
    md = br.render_markdown(rep)
    assert '""' not in md and "“\"" not in md and "\"”" not in md
    assert '— "Can they save the line?"' in md


# ---------------------------------------------------------------------- Reports/Planned to page.md
def test_planned_to_page_file_has_content_or_is_not_written(tmp_path):
    fake = W.SlotFake()
    app, fake, run = W.book(tmp_path, fake, {"choices": W.CHOICES})
    pid = run["project_id"]
    files, _ = app.saver.collect(pid, "main")
    txt = files["Reports/Planned to page.md"].decode()
    assert "planned item(s) are on the page" in txt and "| 1 |" in txt
    # nothing planned to check -> no file (an older one is removed by the save)
    real = app.review.planned.book
    app.review.planned.book = lambda *a, **k: dict(real(*a, **k), names_never_on_page=[], chapters=[
        dict(r, counts=dict(r.get("counts") or {}, items=0)) for r in real(*a, **k)["chapters"]])
    assert app.saver._planned_summary(pid, "main") is None
    # the check fails -> a short note that says so (never an empty file)

    def boom(*a, **k):
        raise AkoweError("INTERNAL_ERROR", "", "x")
    app.review.planned.book = boom
    note = app.saver._planned_summary(pid, "main")
    assert note and "could not check" in note


# ---------------------------------------------------------------------- an unreviewed draft is never approved blind
def test_approve_anyway_needs_a_review_decision(tmp_path):
    from test_autobook import make_app
    from autobook_fake import BookFakeAI
    app = make_app(tmp_path, fake=BookFakeAI())
    run = {"id": "run-abc123def456", "kind": "autobook", "status": "paused", "principal": "author",
           "project_id": "proj-x", "branch_id": "main", "steps": [], "events": [], "pause_reason": "problem",
           "problem": {"code": "INTERNAL_ERROR", "message": "the reviewer's answer could not be read",
                       "record_id": "C02-1"}}
    app.jobstore.save(run)
    pub = app.autobook.public(app.autobook.get(run["id"]))
    assert pub["state"] == "problem" and not pub["needs_decision"] and pub["needs_you"]
    with pytest.raises(AkoweError) as x:
        app.autobook.decide("author", run["id"], {"action": "approve_anyway", "author_confirms": True})
    assert "nothing was approved" in x.value.errors[0]["message"]
