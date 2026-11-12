"""🩺 The story doctor is the plan's quality gate, and 📖 the final beta read is current ("The Salt Tuner", Nov 2026).

* The doctor runs whenever the chapter outline is approved — also after the author's ✔ approve anyway / accept the
  change, and on a run saved by an Akọwe from before the setting existed (resumed after the update).
* The AI reviewer's objections to the AI's main plot / outline go into the doctor's revision instead of stopping the
  run for the author; the author is asked only on author-only topics, for their own text, or when the doctor's
  revision cannot settle them.
* After the end rewrites (chapter 1 last, the final check read again) the beta readers read the final book again and
  the report does not call that read "for an earlier version".
"""
from __future__ import annotations

from akowe import beta_reader
from akowe import story_doctor as sd
from akowe.book_path import BookPath
from akowe.book_report import book_chapters, render_markdown, version_key

from test_failover_review import SlotFake, make_app, run_book
from test_opening_pass import _review, _rewrite_opening
from test_review_loop import SAME, scripted

OFF = {"length": "short_story", "improve_pass": False, "first_page": False, "opening_pass": False,
       "human_pass": False}
CANON = {"verdict": "REVISE", "reasons": ["Chapter 2 says the lamp was first lit in spring."],
         "suggested_changes": ["Change the approved Old Light record instead."],
         "canon_change": {"field": "the lamp", "before": "the lamp was lit in autumn",
                          "after": "the lamp was lit in spring",
                          "approved_fact": "The Old Light record (approved) says the lamp was first lit in autumn."}}
STALE = "This read is for an earlier version of the book"


def _events(app, run):
    return app.autobook.get(run["id"])["events"]


def _codes(app, run):
    return [e.get("code") for e in _events(app, run)]


def _decide(app, run, action):
    app.autobook.decide("author", run["id"], {"action": action, "author_confirms": True})
    app.autobook.wait_for(run["id"], 180)
    return app.autobook.public(app.autobook.get(run["id"]))


# ====================================================================== 🩺 the doctor runs after the author's approval
def test_the_doctor_runs_after_the_authors_decision_also_on_a_run_from_before_the_setting(tmp_path):
    fake = SlotFake()
    fake.verdicts = [scripted({"B11": [CANON]})] * 80   # an approved fact would change: only the author decides
    fake.plan_review_script = [7, 7]
    app = make_app(tmp_path, fake)
    run = run_book(app, OFF)
    prob = run["problem"]
    assert run["status"] == "paused" and prob["code"] == "REVIEW_DECISION" and prob["module_id"] == "B11", run["phase"]
    assert "plan_review" not in fake.kinds
    live = app.autobook.get(run["id"])
    live["settings"].pop("story_doctor")  # saved by an Akọwe from before the setting (resumed after the update)
    app.autobook.save(live)
    run = _decide(app, run, "accept_change")
    assert run["status"] == "done", run["phase"]
    mem = app.autobook.get(run["id"])["story_doctor"]
    # scored, and — the AI's text the author accepted, not text the author typed — revised like any AI outline
    assert fake.kinds.count("plan_review") >= 2 and fake.doctor_fixes == 1 and mem["revisions"] == 1
    assert mem["line"].startswith("🩺 Plan scored 7.0") and app.autobook.get(run["id"])["report"]["doctor"]
    assert "DOCTOR_DONE" in _codes(app, run)


def test_switched_off_still_means_no_doctor():
    assert sd.enabled({"settings": {}}) and sd.enabled({"settings": {"story_doctor": True}})
    assert not sd.enabled({"settings": {"story_doctor": False}})


def test_a_doctor_that_could_not_score_still_says_so():
    ln = sd.line({"state": "done", "why": "no AI could score the plan now", "rounds": []})
    assert ln.startswith("🩺 The plan could not be scored (no AI could score the plan now)")


# ====================================================================== 🩺 the reviewer's objections -> the doctor
def test_the_reviewers_objections_go_into_the_doctors_revision_not_to_the_author(tmp_path):
    fake = SlotFake()
    fake.verdicts = [scripted({"B11": [SAME, SAME]})] * 80  # the same objection again after a fix: a loop
    app = make_app(tmp_path, fake)
    run = run_book(app, OFF)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    codes = _codes(app, run)
    assert "REVIEW_DECISION" not in codes and "REVIEW_LOOP" not in codes and "DOCTOR_TAKES_OBJECTIONS" in codes
    assert not any(e.get("type") == "problem" and "outline" in str(e.get("message")) for e in _events(app, run))
    mem = app.autobook.get(run["id"])["story_doctor"]
    # the plan scored 9 (over the target) — the open objections still get one revision, which is reviewed again
    assert fake.doctor_fixes == 1 and mem["revisions"] == 1 and not mem.get("objections")
    _task, ctx = fake.prompts["doctor_fix"][0]
    note = ctx["author_note"]
    assert note.startswith("🩺 Story doctor") and "the ai plan reviewer also objected" in note.lower()
    assert SAME["suggested_changes"][0][:60] in note
    i = fake.kinds.index("doctor_fix")
    assert fake.kinds[i + 1] == "review"  # the doctor's revision is reviewed like any outline
    assert "objections to the plan were settled" in mem["line"]
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    out = bp.outline()
    assert out["data"]["chapters"][0]["summary"].endswith("(doctor fix)")  # the revision is the approved outline
    head = bp.rec(out["record_id"])
    assert head["approved_version"] == head["version"]


def test_when_the_doctors_revision_cannot_settle_them_the_author_decides(tmp_path):
    fake = SlotFake()
    fake.verdicts = [scripted({"B11": [SAME] * 6})] * 80
    app = make_app(tmp_path, fake)
    run = run_book(app, OFF)
    prob = run["problem"] or {}
    assert run["status"] == "paused" and prob.get("code") == "REVIEW_DECISION", run["phase"]
    assert prob["module_id"] == "B11" and fake.doctor_fixes == 1  # asked only after the doctor's revision
    assert "DOCTOR_TAKES_OBJECTIONS" in _codes(app, run)
    run = _decide(app, run, "accept_change")
    assert run["status"] == "done", run["phase"]
    mem = app.autobook.get(run["id"])["story_doctor"]
    assert mem["state"] == "done" and mem["line"] and not mem.get("pending") and not mem.get("author_gate")
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    head = bp.rec(bp.outline()["record_id"])
    assert head["approved_version"] == head["version"]


def test_the_authors_own_outline_is_never_handed_to_the_doctor_and_only_scored(tmp_path, monkeypatch):
    fake = SlotFake()
    fake.verdicts = [scripted({"B11": [SAME, SAME]})] * 80
    fake.plan_review_script = [6, 6]
    app = make_app(tmp_path, fake)
    orig = app.autobook._ai_made
    monkeypatch.setattr(app.autobook, "_ai_made",
                        lambda run, rec: False if rec.get("module_id") == "B11" else orig(run, rec))
    run = run_book(app, OFF)
    assert run["status"] == "paused" and run["problem"]["code"] == "REVIEW_DECISION", run["phase"]
    assert "DOCTOR_TAKES_OBJECTIONS" not in _codes(app, run)
    run = _decide(app, run, "accept_change")
    assert run["status"] == "done", run["phase"]
    mem = app.autobook.get(run["id"])["story_doctor"]
    assert mem.get("own_text") and "only scored it" in mem["line"] and "doctor_fix" not in fake.kinds


def test_the_gate_switched_off_asks_the_author_as_before(tmp_path):
    fake = SlotFake()
    fake.verdicts = [scripted({"B11": [SAME, SAME]})] * 80
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(OFF, doctor_gate=False))
    assert run["status"] == "paused" and run["problem"]["code"] == "REVIEW_DECISION", run["phase"]
    assert "DOCTOR_TAKES_OBJECTIONS" not in _codes(app, run)


def test_an_author_only_topic_still_stops_for_the_author(tmp_path):
    fake = SlotFake()
    fake.verdicts = [scripted({"B11": [CANON]})] * 80
    app = make_app(tmp_path, fake)
    run = run_book(app, OFF)
    assert run["status"] == "paused" and run["problem"]["decision"]["kind"] == "canon"
    assert "DOCTOR_TAKES_OBJECTIONS" not in _codes(app, run)


# ====================================================================== 📖 the final beta read is current
def test_the_final_beta_read_after_the_end_rewrites_is_shown_as_current(tmp_path):
    """Chapter 1 is rewritten after the beta read, and the final whole-book check — read again after it — fixes a
    line of it AFTER the report was remade: the beta readers read the final book again, and the report shows that read
    without "(!) for an earlier version"."""
    fake = SlotFake()
    fake.opening_rewrite_script = [_rewrite_opening]
    fake.book_review_script = [None, None, _review(8), _review(8)]
    s = "Mara Vell stood on the hundred and twelfth step of Gullhaven lighthouse at dawn"

    def check(ctx):
        out = fake._checkpoint(ctx)
        c = next((c for c in ctx.get("chapters") or [] if s in (c.get("text") or "")), None)
        if c:  # only the final check read again (chapter 1 was rewritten): one small fix in it
            out["problems"].append({"chapter": c["number"], "quote": s, "problem": "The step count disagrees.",
                                    "original": s, "replacement": s.replace("hundred and twelfth", "hundredth")})
        return out
    fake.checkpoint_script = [check] * 40
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(OFF, opening_pass=True, beta_reader=True))
    assert run["status"] == "done", run.get("problem")
    live = app.autobook.get(run["id"])
    assert live["opening"]["kept"] is True and "BETA_AGAIN" in _codes(app, run)
    pid = run["project_id"]
    chapters = book_chapters(BookPath(app.engine, "author", pid, "main"))
    assert "hundredth step" in chapters[0]["text"]  # the final check's fix came after the report
    rep = app.reports.latest(pid, "main")
    reads = [r for r in beta_reader.service_of(app).reads(pid, "main") if r.get("status") == "done"]
    assert len(reads) == 2 and reads[-1]["version_key"] == version_key(chapters)
    md = render_markdown(beta_reader.with_beta(app, pid, "main", rep))
    assert "## Beta readers" in md and STALE not in md
    # a read that really is for an earlier version is still said plainly
    old = dict(rep, beta=reads[0], book_key_now=version_key(chapters))
    assert STALE in render_markdown(old)
