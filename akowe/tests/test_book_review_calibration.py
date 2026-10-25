"""🎯 P36 extended to the 📊 whole-book review (book_report.py).

From the first real book: Gemini read the whole book in 7.5 seconds, scored it 8-9 on all 13 dimensions with ONE
weakness, and the report said "overall 8.6/10". Now the whole-book review is held to the editor's rules (shared in
calibration.py): a 9/10 counts only with a quoted proof that is in the book, a near-perfect review needs at least 3
weaknesses whose quotes are in the book, an untrusted review is asked again ONCE with a stricter task, and a review
that stays unproven is flagged ⚠️ with its unproven high scores counted as 7. Each whole-book review feeds the per-AI
leniency record (``reviewer_leniency``) and gets the same discount after ``MIN_OBS`` observations; the report page,
Markdown and PDF show the flag and a one-line "how generous" note per reviewer. Everything runs on the fake AI.
"""
from __future__ import annotations

import pytest

from akowe import book_report as br
from akowe import calibration as cal
from akowe import h_checks as hc
from akowe.errors import AkoweError

from test_failover_review import SlotFake, make_app, no_provider_sleep, run_book  # noqa: F401

Q1 = "Down in the harbor the fishing boats knocked together like restless teeth."
Q2 = "Only old Nessa at the net sheds would talk, and only in a whisper"
Q3 = "the keeper had gone out to the reef with a stranger"
Q4 = "Mara asked every captain about the night the light went dark"
BOOK = f"# One\n\n{Q1} {Q2}. Then {Q3}. {Q4}."


def gemini_like(dims=br.DIM_KEYS):
    """8-9 everywhere, one weakness, no score evidence (the first real book's Gemini review)."""
    return {"book_scores": {d: (9 if i % 2 == 0 else 8) for i, d in enumerate(dims)},
            "strengths": [{"point": "Vivid harbour.", "quote": Q1}],
            "weaknesses": [{"point": "Helpers cooperate.", "quote": Q2}],
            "try_next": ["Raise the cost."], "summary": "A strong book."}


def honest(dims=br.DIM_KEYS):
    """A calibrated answer: 7s, one proven 9, three quoted weaknesses."""
    out = {"book_scores": {d: 7 for d in dims}, "strengths": [{"point": "Vivid harbour.", "quote": Q1}],
           "weaknesses": [{"point": "Helpers cooperate.", "quote": Q2}, {"point": "Told, not shown.", "quote": Q3},
                          {"point": "Repetitive asking.", "quote": Q4}],
           "try_next": ["Raise the cost."], "summary": "Good, with flaws.",
           "score_evidence": [{"dimension": "atmosphere", "quote": Q1, "why": "concrete"}]}
    out["book_scores"]["atmosphere"] = 9
    return out


# ====================================================================== prompt and schema
def test_prompt_asks_for_three_quoted_weaknesses_and_proof_and_schema_stays_optional():
    task = br.REVIEW_TASK.format(rubric="R")
    assert "at least 3" in task and "score_evidence" in task and "{dimension, quote, why}" in task
    assert "Give at least 3 weaknesses" in br.STRICT_REASK
    sch = br.review_schema(br.DIM_KEYS)
    assert "score_evidence" in sch["properties"] and "score_evidence" not in sch["required"]
    assert sch["properties"]["score_evidence"]["items"]["properties"]["dimension"]["enum"] == br.DIM_KEYS


# ====================================================================== pure trust rules (shared with the editor)
def test_assess_book_distrusts_the_gemini_like_review():
    tn = cal.norm(BOOK)
    raw = gemini_like()
    rv = br.clean_review(raw, br.DIM_KEYS, tn)
    a = cal.assess_book(raw, rv, tn)
    assert not a["trusted"] and a["too_clean"] and a["weaknesses_verified"] == 1
    assert set(a["unjustified"]) == {d for d, v in rv["scores"].items() if v >= 9}
    assert any("without a quoted proof" in r for r in a["reasons"])
    assert any("quoted weakness(es)" in r and "at least 3" in r for r in a["reasons"])
    capped, changed = cal.apply_caps(rv["scores"], a)  # too clean: every score at most CAP
    assert max(capped.values()) == cal.CAP and all(o > n == cal.CAP for o, n in changed.values())


def test_assess_book_trusts_a_calibrated_review_and_checks_quotes():
    tn = cal.norm(BOOK)
    raw = honest()
    a = cal.assess_book(raw, br.clean_review(raw, br.DIM_KEYS, tn), tn)
    assert a["trusted"], a["reasons"]
    assert a["evidence"] == {"atmosphere": Q1}
    # a proof that is not in the book proves nothing
    raw["score_evidence"] = [{"dimension": "atmosphere", "quote": "A sentence nobody ever wrote in this book."}]
    a = cal.assess_book(raw, br.clean_review(raw, br.DIM_KEYS, tn), tn)
    assert not a["trusted"] and a["unjustified"] == ["atmosphere"] and not a["too_clean"]
    # near-perfect with 3 weaknesses whose quotes are invented: too clean
    raw = honest()
    raw["book_scores"] = {d: 9 for d in br.DIM_KEYS}
    raw["score_evidence"] = [{"dimension": d, "quote": Q1} for d in br.DIM_KEYS]
    raw["weaknesses"] = [{"point": f"p{i}", "quote": f"invented sentence number {i} here"} for i in range(3)]
    a = cal.assess_book(raw, br.clean_review(raw, br.DIM_KEYS, tn), tn)
    assert a["too_clean"] and not a["unjustified"] and a["weaknesses_verified"] == 0
    # the editor's assess uses the same judge (unchanged behaviour)
    j = cal.judge({"a": 10, "b": 9}, {"a": "q"}, 3, weakest_found=False)
    assert j["unjustified"] == ["b"] and j["too_clean"] and "no quoted weakest passage" in j["reasons"][-1]


def test_book_pattern_ceilings_map_to_whole_book_dimensions():
    report = {"findings": [{"check": "reassurance", "severity": "major"}, {"check": "voice_sameness",
                                                                         "severity": "minor"},
                           {"check": "triad", "severity": "major"}]}
    ceil = cal.audit_ceilings(report, cal.BOOK_AUDIT_DIMS)
    assert ceil == {"peril_uncertainty": 6, "character_differentiation": 8}
    assert set(cal.BOOK_AUDIT_DIMS.values()) <= set(br.DIM_KEYS)
    assert cal.audit_ceilings(report)["prose_variety"] == 6  # the editor's map is unchanged


def test_generosity_line():
    assert "not enough reviews yet" in cal.generosity_line("Gemini", None)
    row = {"leniency": 1.4, "observations": 4, "words": "too generous", "discount": 1}
    line = cal.generosity_line("Gemini", row)
    assert line.startswith("Gemini: +1.4") and "too generous" in line and "lowered by 1" in line


# ====================================================================== whole-book review end to end (fake AI)
def _book(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)  # AI-1 claude (writes), AI-2 chatgpt, AI-3 gemini
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    rep = app.reports.latest(run["project_id"], "main")
    # the fake's default whole-book review proves its 9s: trusted, never asked again
    assert all((r.get("calibration") or {}).get("trusted") for r in rep["reviews"])
    assert not any((r.get("calibration") or {}).get("reasked") for r in rep["reviews"])
    assert all(r.get("generosity") for r in rep["reviews"])
    return fake, app, run["project_id"], rep


def test_too_clean_review_is_reasked_once_then_flagged_and_capped(tmp_path):
    fake, app, pid, first = _book(tmp_path)
    n0 = fake.kinds.count("book_review")
    fake.book_review_script = [gemini_like(), gemini_like()]
    rep = app.reports.make("author", pid, "main", slots=["AI-3"], add_to=first["id"])
    assert fake.kinds.count("book_review") == n0 + 2  # asked ONCE more, not more
    reask_task = fake.prompts["book_review"][-1][0]
    g = next(r for r in rep["reviews"] if r["slot"] == "AI-3")
    c = g["calibration"]
    assert c["reasked"] and c["flagged"] and not c["trusted"] and c["too_clean"]
    assert max(g["scores"].values()) <= cal.CAP and max(g["scores_raw"].values()) == 9
    assert c["capped"] and all(n == cal.CAP for _o, n in c["capped"].values())
    # the median now uses the capped scores: no "8.6/10 from one reviewer"
    by = {d["dimension"]: d for d in rep["aggregate"]["dimensions"]}
    assert by["premise"]["by"]["AI-3"] == cal.CAP
    assert any(w.startswith("⚠️ AI-3 · Gemini's whole-book review is not backed by quotes") for w in rep["warnings"])
    # leniency: recorded for the book report, flagged and re-asked, vs the other reviewers
    e = app.store.get_setting(cal.KEY)["gemini"]
    last = e["recent"][-1]
    assert last["where"] == "book_report" and last["flagged"] and last["vs_other"] is not None
    assert e["reasked"] >= 1 and e["flagged"] >= 1
    # Markdown and PDF show the flag and the "how generous" line
    md = br.render_markdown(rep)
    assert "## How far the reviewers were trusted" in md and "⚠️ AI-3 · Gemini's whole-book review" in md
    assert "🎯 How generous: Gemini:" in md and "ChatGPT" in md.split("## How far the reviewers were trusted")[1]
    doc, issues = hc.pdf_structure(br.render_pdf(rep))
    assert doc is not None and not [i for i in issues if i.get("decision") == "FAIL"]
    assert "Your previous review was not accepted by Akọwe" in reask_task and "at least 3 weaknesses" in reask_task


def test_reask_that_is_honest_replaces_the_first_answer(tmp_path):
    fake, app, pid, first = _book(tmp_path)
    fake.book_review_script = [gemini_like(), honest()]
    rep = app.reports.make("author", pid, "main", slots=["AI-2"], add_to=first["id"])
    r = next(x for x in rep["reviews"] if x["slot"] == "AI-2")
    c = r["calibration"]
    assert c["reasked"] and c["trusted"] and not c["flagged"] and not c["capped"]
    assert r["scores"]["atmosphere"] == 9 and r["scores"]["premise"] == 7 and len(r["weaknesses"]) == 3
    assert not any("not backed by quotes" in w for w in rep["warnings"])
    assert "asked once more with a stricter task; the second answer is used" in br.render_markdown(rep)


def test_failed_reask_keeps_the_first_answer_flagged_and_never_blocks(tmp_path):
    fake, app, pid, first = _book(tmp_path)

    def lenient_then_fail(_ctx):
        fake.failures.append(AkoweError("TIMEOUT", "", "limit"))  # the next call (the re-ask) fails
        return gemini_like()
    fake.book_review_script = [lenient_then_fail]
    rep = app.reports.make("author", pid, "main", slots=["AI-3"], add_to=first["id"])
    g = next(r for r in rep["reviews"] if r["slot"] == "AI-3")
    assert g["status"] == "done" and g["calibration"]["flagged"] and g["calibration"]["reasked"]
    assert g["calibration"]["reask_error"] == "TIMEOUT"
    assert max(g["scores"].values()) <= cal.CAP
    assert "but that failed (TIMEOUT)" in br.render_markdown(rep)


def test_lenient_ai_is_discounted_only_after_min_obs(tmp_path):
    fake, app, pid, first = _book(tmp_path)
    # make Gemini's history: generous by +1.6 over MIN_OBS comparisons (set before the next review)
    cur = app.store.get_setting(cal.KEY) or {}
    cur["gemini"] = {"name": "Gemini", "reviews": cal.MIN_OBS, "flagged": 0, "reasked": 0, "other_n": cal.MIN_OBS,
                     "other_sum": 1.6 * cal.MIN_OBS, "audit_n": 0, "audit_sum": 0.0, "recent": []}
    cur["chatgpt"] = {"name": "ChatGPT", "reviews": 1, "flagged": 0, "reasked": 0, "other_n": 1, "other_sum": 3.0,
                      "audit_n": 0, "audit_sum": 0.0, "recent": []}  # generous but too few observations
    app.store.set_setting(cal.KEY, cur)
    fake.book_review_script = [honest(), honest()]
    rep = app.reports.make("author", pid, "main", slots=["AI-3", "AI-2"], add_to=first["id"])
    g = next(r for r in rep["reviews"] if r["slot"] == "AI-3")
    c = next(r for r in rep["reviews"] if r["slot"] == "AI-2")
    assert g["discount"] == 1 and g["scores"]["atmosphere"] == 8 and g["scores_raw"]["atmosphere"] == 9
    assert not c.get("discount") and c["scores"]["atmosphere"] == 9  # 1 observation < MIN_OBS: no discount
    assert "too generous" in g["generosity"] and "lowered by 1" in g["generosity"]
    md = br.render_markdown(rep)
    assert "AI-3 · Gemini's scores were lowered by 1 point(s)" in md
    # the overview's leniency table counts the whole-book reviews too
    ov = app.reports.overview("author", pid, "main")
    assert {r["family"]: r for r in ov["leniency"]}["gemini"]["reviews"] >= cal.MIN_OBS + 1


@pytest.mark.parametrize("scores", [{"atmosphere": 10}, {}])
def test_old_reports_without_calibration_still_render(scores):
    rep = {"title": "T", "at": "2026-10-25T00:00:00Z", "version": {"key": "k", "chapters": ["a:1"]},
           "reviews": [{"slot": "AI-2", "name": "ChatGPT", "status": "done", "independent": True, "scores": scores,
                        "strengths": [], "weaknesses": [], "try_next": [], "summary": "ok"}],
           "aggregate": br.aggregate([{"slot": "AI-2", "status": "done", "scores": scores}]), "warnings": [],
           "words": {"total": 1, "target": 1, "chapters": []}}
    md = br.render_markdown(rep)
    assert "How far the reviewers were trusted" not in md and br.reviewer_notes(rep["reviews"][0]) == []
