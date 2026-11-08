"""✨ #20 Originality and "sounds like AI" check (originality.py): the no-AI detector (true positives, dialogue left
out, thresholds per 1 000 words, exact quotes, no false alarms on plain prose), what the editor gets and the "nothing
got worse" guard, the optional AI pass (passages picked, quotes verified against the book, an independent reader), the
HTTP API and the 📊 book report line. All on the deterministic fake AI."""
from __future__ import annotations

import time

import pytest

from akowe import editor as ed_mod
from akowe import originality as og
from akowe.errors import AkoweError

from autobook_fake import CHAPTER_TEXT
from test_failover_review import SlotFake, make_app, run_book

PLAIN = "\n\n".join(p for k in sorted(CHAPTER_TEXT) for p in CHAPTER_TEXT[k])
AI_PAR = ("The harbor was a testament to the town's long winters, a tapestry of nets and rope. Mara couldn't help but "
          "smile. She let out a breath she didn't know she was holding.")
FILL = ("Mara walked the length of the quay and counted the boats tied up at the wall, then went back for the oil "
        "can she had left at the sheds. ")


def _rep(text, **kw):
    return og.check([{"chapter_id": "ch1", "number": 1, "text": text}], **kw)


def _by(rep):
    return {c["check"]: c for c in rep["checks"]}


# ====================================================================== the detector
def test_finds_ai_phrases_with_chapter_quote_and_reason():
    rep = _rep(AI_PAR + "\n\n" + FILL * 3)
    hits = [f for f in rep["findings"] if f["check"] == "ai_phrase"]
    matched = {f["match"].lower() for f in hits}
    assert {"a testament to", "tapestry", "couldn't help but", "a breath she didn't know she was holding"} <= matched
    for f in hits:
        assert f["chapter"] == "ch1" and f["number"] == 1 and f["paragraph"] == 1
        assert f["quote"] in AI_PAR and f["match"].lower() in f["quote"].lower()  # word for word from the book
        assert f["reason"] and f["advice"] and len(f["quote"]) <= og.QUOTE_MAX
    assert _by(rep)["ai_phrase"]["severity"] == "major"
    assert rep["chapters"][0]["score"] < 60 and rep["chapters"][0]["rating"] != "sounds like a person"


def test_placeholders_and_word_endings():
    rep = _rep("He delved into the files. Little did they know the ledger was gone. The weight of her words stayed. "
               "He let out a breath he hadn't known he was holding.")
    matched = {f["match"].lower() for f in rep["findings"] if f["check"] == "ai_phrase"}
    assert {"delved", "little did they know", "the weight of her", "a breath he hadn't known he was holding"} <= matched


def test_a_longer_phrase_hides_the_shorter_one_inside_it():
    rep = _rep("It was a testament to her patience.")
    assert [f["match"] for f in rep["findings"] if f["check"] == "ai_phrase"] == ["a testament to"]


def test_cliches_and_not_this_but_that():
    text = ("At the end of the day the boats came home. His blood ran cold when he saw the reef.\n\n"
            "It wasn't fear. It was something older.\n\nThis isn't a harbor; it's a grave.")
    rep = _rep(text)
    assert {f["match"].lower() for f in rep["findings"] if f["check"] == "cliche"} == {"at the end of the day",
                                                                                       "blood ran cold"}
    nb = [f for f in rep["findings"] if f["check"] == "not_this_but_that"]
    assert len(nb) == 2 and nb[0]["quote"] == "It wasn't fear. It was something older."
    assert _by(rep)["not_this_but_that"]["severity"] in ("minor", "major")


def test_rhetorical_question_openers_but_not_dialogue_questions():
    text = ("What did the keeper know? Mara turned the key over.\n\n"
            "\"Where is he?\" Mara asked. Nobody answered.\n\n"
            "Why had the lamp gone dark? She climbed the steps.")
    rep = _rep(text)
    rq = [f for f in rep["findings"] if f["check"] == "rhetorical_question"]
    assert [f["paragraph"] for f in rq] == [1, 3] and rq[0]["quote"] == "What did the keeper know?"


def test_dialogue_is_left_out_unless_asked():
    text = "\"At the end of the day, it's a job,\" Nessa said. \"Little did we know.\"\n\n" + FILL * 2
    rep = _rep(text)
    assert not [f for f in rep["findings"] if f["check"] in ("cliche", "ai_phrase")]
    assert rep["chapters"][0]["dialogue_skipped"] == 2
    rep2 = _rep(text, include_dialogue=True)
    assert {f["check"] for f in rep2["findings"]} >= {"cliche", "ai_phrase"} and rep2["dialogue_counted"]


def test_thresholds_per_1000_words():
    # one stock word in about 1 200 words of plain narration: listed, but only as a note (below the line)
    one = _rep("The market was vibrant that morning.\n\n" + FILL * 40)
    f = [x for x in one["findings"] if x["check"] == "ai_phrase"]
    assert len(f) == 1 and f[0]["severity"] == "info" and _by(one)["ai_phrase"]["severity"] == "info"
    # a few long dashes are normal; many in a short text are a finding
    few = _rep("She waited — and then went home.\n\n" + FILL * 10)
    assert _by(few)["em_dash"]["severity"] == "info" and not [x for x in few["findings"] if x["check"] == "em_dash"]
    many = _rep(("She waited — and then — at last — went home. " * 4 + "\n\n") * 3)
    assert _by(many)["em_dash"]["severity"] == "major" and [x for x in many["findings"] if x["check"] == "em_dash"]
    # hedging: only a density over the line counts
    hedgy = _rep("Perhaps the boat was late. It seemed to drift, as if somehow lost, a kind of ghost. Maybe.\n\n" * 3)
    assert _by(hedgy)["hedge"]["severity"] == "major" and [x for x in hedgy["findings"] if x["check"] == "hedge"]
    assert _by(_rep("Perhaps the boat was late.\n\n" + FILL * 20))["hedge"]["severity"] == "info"
    # a threshold can be changed
    strict = og.check([("ch1", "The market was vibrant that morning.\n\n" + FILL * 40)],
                      overrides={"ai_phrase": {"minor": 0.5}})
    assert _by(strict)["ai_phrase"]["severity"] == "minor"


def test_plain_prose_is_not_flagged():
    rep = _rep(PLAIN)
    assert rep["spots"] == 0 and rep["score"] == 100 and rep["rating"] == "sounds like a person"
    assert not [f for f in rep["findings"] if f["severity"] != "info"]


def test_borrowed_pattern_checks_are_counted_once():
    text = ("She was cold, wet, and tired. He was old, slow, and sure. They were loud, rude, and late. "
            "It was grey, flat, and still. " + FILL) * 2
    rep = _rep(text)
    tri = _by(rep)["triad"]
    assert tri["source"] == "pattern_check" and tri["count"] >= 3
    assert all(f.get("source") == "pattern_check" for f in rep["findings"] if f["check"] == "triad")


def test_book_level_rows_and_summary_line():
    rep = og.check([{"chapter_id": "ch1", "number": 1, "title": "One", "text": PLAIN},
                    {"chapter_id": "ch2", "number": 2, "title": "Two", "text": AI_PAR + "\n\n" + FILL * 4}])
    assert [r["number"] for r in rep["chapters"]] == [1, 2] and rep["worst_chapter"] == 2
    assert rep["chapters"][0]["score"] > rep["chapters"][1]["score"]
    line = og.summary(rep)
    assert line.startswith("✨ Originality:") and "most in chapter 2" in line
    b = og.brief(rep)
    assert b["line"] == line and b["examples"] and b["examples"][0]["chapter"] == 2
    assert og.summary(og.check([])) == "✨ Originality: no chapters to check yet."


def test_fast_on_a_long_chapter():
    text = "\n\n".join([FILL * 6] * 60)  # ~6 000 words
    og.check([("x", "warm")])
    t = time.monotonic()
    og.check([("ch1", text)])
    assert time.monotonic() - t < 1.5


# ====================================================================== the editor and "nothing got worse"
def test_editor_brief_and_counts():
    b = og.editor_brief(AI_PAR + "\n\n" + FILL)
    assert b and b["passages"] and all(p["quote"] in AI_PAR for p in b["passages"]) and "prose_variety" in b["ask"]
    assert og.editor_brief(PLAIN) is None
    assert og.counts(AI_PAR) >= 4 and og.counts(PLAIN) == 0


def test_rewrite_that_adds_ai_phrases_is_not_kept():
    old = {"scores": {"subtext": 6}, "avg_score": 6, "counts": {"major": 1}}
    new = {"scores": {"subtext": 7}, "avg_score": 7, "counts": {"major": 0}}
    kw = dict(consistency="APPROVE", checks_ok=True, keep_lost=[], applied=[])
    assert ed_mod.judge_rewrite(old, new, new_text=PLAIN, old_text=PLAIN, **kw)[:2] == (True, "KEPT")
    assert ed_mod.judge_rewrite(old, new, new_text=PLAIN + "\n\n" + AI_PAR, old_text=PLAIN, **kw)[1] == \
        "MORE_AI_SOUNDING"
    assert ed_mod.judge_rewrite(old, new, new_text=PLAIN + "\n\n" + AI_PAR, **kw)[1] == "KEPT"  # old callers


def test_the_editor_gets_the_ai_sounding_passages(tmp_path):
    fake = SlotFake()
    fake.chapter_texts["ch2"] = ("Down in the harbor the fishing boats knocked together. " + AI_PAR + "\n\n"
                                 + CHAPTER_TEXT[2][1])
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    with_hint = [c for c in fake.craft_contexts if c.get("ai_sounding")]
    assert with_hint and all(p["quote"] in c["chapter_text"] for c in with_hint for p in c["ai_sounding"]["passages"])
    assert not any(c.get("ai_sounding") for c in fake.craft_contexts if "testament" not in c.get("chapter_text", ""))
    # the book report has the one line, and the run says it
    assert (run.get("report") or {}).get("originality", "").startswith("✨ Originality:")
    rep = app.reports.latest(run["project_id"], "main")
    assert rep["originality"]["line"].startswith("✨ Originality:")
    from akowe import book_report  # noqa: PLC0415
    assert "## Originality (no AI)" in book_report.render_markdown(rep)


# ====================================================================== the AI pass
CHS = [{"chapter_id": "ch1", "number": 1, "text": "# One\n\n" + AI_PAR + "\n\n" + FILL},
       {"chapter_id": "ch2", "number": 2, "text": "# Two\n\n" + "\n\n".join(CHAPTER_TEXT[2])}]


def test_pick_passages_flagged_first_then_one_sample_per_chapter():
    ps = og.pick_passages(CHS, og.check(CHS))
    assert ps[0]["chapter"] == 1 and ps[0]["flagged"] and ps[0]["flags"]
    assert {p["chapter"] for p in ps} == {1, 2} and not [p for p in ps if p["chapter"] == 2][0]["flagged"]
    assert og.pick_passages(CHS, og.check(CHS)) == ps  # deterministic


def test_clean_ai_checks_every_quote_against_the_book():
    ps = og.pick_passages(CHS, og.check(CHS))
    p2 = next(p for p in ps if p["chapter"] == 2)
    raw = {"machine_ratings": [
        {"passage_id": ps[0]["id"], "machine_score": 5, "reasons": ["stock phrases"], "quote": "a tapestry of nets and "
         "rope", "rewrite": "nets and rope everywhere"},
        {"passage_id": p2["id"], "machine_score": 4, "reasons": ["?"], "quote": "an invented sentence never written",
         "rewrite": ""},
        {"passage_id": p2["id"], "machine_score": 1, "reasons": [], "quote": "", "rewrite": ""},   # duplicate id
        {"passage_id": "p99", "machine_score": 3, "reasons": [], "quote": "", "rewrite": ""},     # unknown passage
        {"passage_id": ps[0]["id"], "machine_score": 9, "reasons": [], "quote": "", "rewrite": ""}],
        "summary": "Some stock phrases."}
    c = og.clean_ai(raw, ps, CHS)
    assert [r["machine_score"] for r in c["ratings"]] == [5, 4]
    good, bad = c["ratings"]
    assert good["verified"] and good["in_chapter"] and good["chapter"] == 1
    assert not bad["verified"] and not bad["in_chapter"]
    tot = og._ai_totals(c["ratings"])
    assert tot["counted"] == 1 and tot["unverified"] == 1 and tot["average"] == 5.0 and tot["machine_like"] == 1


def test_ai_pass_api_job_and_independent_reader(tmp_path):
    fake = SlotFake()
    fake.chapter_texts["ch1"] = CHAPTER_TEXT[1][0] + "\n\n" + AI_PAR
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1", "human_pass": False})  # the button alone (the end pass is off)
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    base = f"/api/projects/{pid}/branches/main/originality"
    code, ov = app.route("GET", base, {}, None, "author", {})
    assert code == 200 and ov["latest"] is None and ov["written"] >= 1 and ov["readers"]
    assert ov["report"]["line"].startswith("✨ Originality:") and ov["report"]["chapters"][0]["spots"] >= 4
    code, ov_d = app.route("GET", base, {"dialogue": ["1"]}, None, "author", {})
    assert ov_d["report"]["dialogue_counted"] is True
    code, job = app.route("POST", base, {}, {}, "author", {})
    assert code == 202
    for _ in range(400):
        code, j = app.route("GET", f"{base}/job/{job['id']}", {}, None, "author", {})
        if j["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert j["status"] == "done", j
    code, ov = app.route("GET", base, {}, None, "author", {})
    r = ov["latest"]
    assert r["id"] == j["read_id"] and r["status"] == "done" and not ov["stale"]
    assert r["reader"]["slot"] != "AI-1" and r["reader"]["independent"]  # never the AI that wrote the chapters
    assert r["ratings"][0]["verified"] and r["ratings"][0]["machine_score"] == 4
    assert any(x["quote"] and not x["verified"] for x in r["ratings"])  # the invented quote is caught
    assert r["totals"]["unverified"] >= 1
    ctx = fake.prompts["originality"][-1][1]
    assert set(ctx) == {"passages", "flags"} and all(set(p) == {"id", "chapter", "text"} for p in ctx["passages"])
    with pytest.raises(AkoweError):
        app.route("POST", base, {}, {"slot_id": 5}, "author", {})
    with pytest.raises(AkoweError):
        app.route("GET", base + "/nope", {}, None, "author", {})


def test_a_failed_ai_pass_is_stored_not_raised(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    fake.fail_kind("originality", AkoweError("INVALID_INPUT", "/x", "bad answer"))
    r = og.service_of(app).read("author", run["project_id"], "main")
    assert r["status"] == "failed" and r["error"] == "INVALID_INPUT"
    assert og.service_of(app).latest(run["project_id"], "main")["id"] == r["id"]
