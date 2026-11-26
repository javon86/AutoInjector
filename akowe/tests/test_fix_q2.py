"""Stress fixes, batch Q2 — the end-of-book review is reliable (docs/stress/G-quality-at-the-end.md).

G-18-a/b/c  a reviewer timeout once / busy ×3 / a short usage limit: the whole-book review is still made (waited for,
            asked once more) and a usage-limit wait is journaled;
G-18-d/e/f  a review lost for good says why (the reviewer failed), not "no independent AI was working";
G-18-k      a 1/10-everywhere review with no quoted weakness is untrusted and set aside (not counted);
G-18-n      a report made while a chapter has no text says the book is incomplete;
G-19-a/c    a beta read is asked again after a timeout; its usage-limit wait is journaled;
G-19-j/k    a "twist guessed too early" counts only when its quote is in the book;
G-22-c      the final re-read waits for a usage limit (no next checkpoint comes);
G-22-j      a much worse second beta read is said and the undo offered; G-22-l an out-of-date beta read is said;
G-22-n      a Pause pressed during the last re-read is honoured.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from akowe import beta_reader as beta
from akowe import book_report as br
from akowe import calibration
from akowe import final_reads
from akowe import usage_limits
from akowe.book_path import BookPath
from akowe.errors import AkoweError
from akowe.jobs import RetryPolicy

from test_failover_review import SlotFake, make_app, run_book


def _events(run, code):
    return [e for e in run["events"] if e.get("code") == code]


def _step(run, sid):
    return next(s for s in run["steps"] if s["id"] == sid)


def _usage_limit():
    usage_limits.note(["Claude", "ChatGPT", "Gemini"])
    exc = AkoweError("UPSTREAM_UNAVAILABLE", "", "every AI is at its usage limit (test)")
    exc.usage_limited, exc.limited_names, exc.reset_at = True, ["Claude", "ChatGPT", "Gemini"], None
    return exc


@pytest.fixture(autouse=True)
def _no_usage_limit_note():
    usage_limits.clear()
    yield
    usage_limits.clear()


def _limit_app(tmp_path, fake):
    app = make_app(tmp_path, fake)
    pol = RetryPolicy([0.01, 0.02], 5, limit_wait_s=30, limit_check_s=0.01)
    for svc in (app.autobook, app.write_all, app.assist):
        svc.retry_policy = pol
    return app


# ============================================================================== G-18 the whole-book review
def test_g18_a_b_a_timeout_and_busy_reviewers_still_review_the_book(tmp_path):
    fake = SlotFake()
    fake.fail_kind("book_review", AkoweError("TIMEOUT", "", "slow"),
                   *[AkoweError("RATE_LIMITED", "", "busy")] * 3)
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    rep = app.reports.latest(run["project_id"], "main")
    assert rep["aggregate"]["reviewers"] == 2 and all(r["status"] == "done" for r in rep["reviews"])
    assert any(r.get("retried") for r in rep["reviews"])  # the timed-out reviewer was asked once more
    assert not _events(run, "REPORT_NO_REVIEW") and not _events(run, "REPORT_NOT_INDEPENDENT")


def test_g18_c_a_usage_limit_is_waited_for_and_journaled(tmp_path):
    fake = SlotFake()
    fake.fail_kind("book_review", *[_usage_limit() for _ in range(6)])
    app = _limit_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    rep = app.reports.latest(run["project_id"], "main")
    assert rep["aggregate"]["reviewers"] == 2
    assert _events(run, "USAGE_LIMIT_WAIT")


def test_g18_d_a_review_lost_for_good_says_the_reviewer_failed(tmp_path):
    fake = SlotFake()
    fake.fail_kind("book_review", *[AkoweError("INVALID_INPUT", "", "unusable")] * 40)
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    msg = _step(run, "report")["message"]
    assert "no independent AI was working" not in msg
    assert "could not review it" in msg and "its answer could not be used" in msg and "Ask the other AIs" in msg
    assert _events(run, "REPORT_NO_REVIEW") and not _events(run, "REPORT_NOT_INDEPENDENT")
    assert "_" not in msg.replace("📨", "")  # plain words: no codes


def test_g18_f_refusing_reviewers_are_said_to_refuse(tmp_path):
    fake = SlotFake()
    fake.fail_kind("book_review", *[AkoweError("AI_DECLINED", "", "can't help")] * 40)
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    msg = _step(run, "report")["message"]
    assert "refused to review the book" in msg and "no independent AI" not in msg
    # a refusal is never waited for as if the AI were busy: two asks (plain, with the fiction note) per AI
    assert sum(1 for k in fake.kinds if k == "fail:book_review:AI_DECLINED") <= 2 * 3


def test_g18_k_a_very_low_review_without_quotes_is_set_aside():
    harsh = {"scores": {d: 1 for d in br.DIM_KEYS}, "weaknesses": []}
    a = calibration.assess_book({}, harsh, "the book")
    assert not a["trusted"] and a["too_harsh"] and "a score this low needs" in " ".join(a["reasons"])
    backed = {"scores": {d: 2 for d in br.DIM_KEYS}, "weaknesses": [{"verified": True}, {"verified": True}]}
    assert calibration.assess_book({}, backed, "the book")["trusted"]
    fair = {"scores": {d: 6 for d in br.DIM_KEYS}, "weaknesses": []}
    assert not calibration.assess_book({}, fair, "the book")["too_harsh"]
    rows = [{"slot": "AI-2", "name": "AI-2", "status": "done", "independent": True, "scores": harsh["scores"],
             "set_aside": "low_unbacked", "calibration": {"reasons": a["reasons"], "reasked": True}}]
    agg = br.aggregate(rows)
    assert agg["reviewers"] == 0 and agg["overall"] is None and agg["set_aside"] == 1
    assert "very low scores without quoting" in br.lost_line(rows)
    assert "set aside" in br.low_line(rows[0])
    rows.append({"slot": "AI-3", "name": "AI-3", "status": "done", "independent": True,
                 "scores": {d: 7 for d in br.DIM_KEYS}})
    agg = br.aggregate(rows)
    assert agg["reviewers"] == 1 and agg["overall"] == 7.0 and br.lost_line(rows) is None


def test_g18_k_in_a_run_the_harsh_review_is_not_counted(tmp_path):
    fake = SlotFake()
    harsh = {"book_scores": {d: 1 for d in br.DIM_KEYS}, "strengths": [], "weaknesses": [], "try_next": [],
             "summary": "Unreadable."}
    orig = fake._answer

    def answer(ctx, props, schema):
        kind, out = orig(ctx, props, schema)
        return (kind, dict(harsh)) if kind == "book_review" else (kind, out)
    fake._answer = answer
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    rep = app.reports.latest(run["project_id"], "main")
    done = [r for r in rep["reviews"] if r["status"] == "done"]
    assert done and all(r.get("set_aside") == "low_unbacked" for r in done)
    assert rep["aggregate"]["reviewers"] == 0 and any("set aside" in w for w in rep["warnings"])
    assert "very low scores" in _step(run, "report")["message"]


def test_g18_n_a_report_of_a_book_with_a_missing_chapter_says_so(tmp_path, monkeypatch):
    app = make_app(tmp_path, SlotFake())
    run = run_book(app, {"slot_id": "AI-1"})
    pid = run["project_id"]
    orig = BookPath.chapter_prose

    def prose(self, outline, chapter_id):
        out = orig(self, outline, chapter_id)
        ids = [c["chapter_id"] for c in self.outline_chapters(outline)]
        return (out[0], None, None) if chapter_id == ids[-1] else out
    monkeypatch.setattr(BookPath, "chapter_prose", prose)
    rep = app.reports.make("author", pid, "main", ai=False)
    n = len(rep["version"]["chapters"]) + 1
    assert rep["missing_chapters"] == [n]
    assert any(f"Chapter {n} has no text" in w and "incomplete book" in w for w in rep["warnings"])
    assert br.missing_words([2, 5]) == "Chapters 2 and 5 have no text"


# ============================================================================== G-19 the beta reader
def test_g19_a_c_a_slow_beta_read_is_asked_again_and_usage_waits_are_journaled(tmp_path):
    fake = SlotFake()
    fake.fail_kind("beta", AkoweError("TIMEOUT", "", "slow"), *[_usage_limit() for _ in range(6)])
    app = _limit_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1", "beta_reader": True})
    assert run["status"] == "done", run.get("problem")
    r = beta.service_of(app).latest(run["project_id"], "main")
    assert r["status"] == "done" and r.get("retried")
    assert not _events(run, "BETA_FAILED") and _events(run, "USAGE_LIMIT_WAIT")


def _guess(verified, ch=1, rv=3):
    return {"guess": "The stranger is the brother", "guessed_in_chapter": ch, "revealed_in_chapter": rv,
            "came_true": "yes", "quote": "a line" if verified else "an invented line", "verified": verified,
            "in_chapter": verified}


def _read(guesses):
    return {"reactions": [], "interest": [{"chapter": c, "score": 7, "would_keep_reading": True} for c in (1, 2, 3)],
            "guesses": guesses, "stop": {"would_finish": True, "chapter": 0, "why": ""}}


def test_g19_j_k_unverified_guesses_never_count_as_twists_seen_coming():
    fs = {f["id"]: f for f in beta.findings(_read([_guess(False) for _ in range(8)]), 3)}
    assert "guessed" not in fs
    assert fs["unverified"]["guesses_left_out"] == 8 and "8 twist guess(es) were left out" in fs["unverified"]["detail"]
    fs = {f["id"]: f for f in beta.findings(_read([_guess(True), _guess(False)]), 3)}
    assert fs["guessed"]["severity"] == "major" and fs["unverified"]["guesses_left_out"] == 1
    # the panel comparison (and so the opening / improve passes) sees only the verified guess
    marks = [m for m in beta._marks(_read([_guess(False)])) if m["kind"] == "guessed"]  # noqa: SLF001
    assert not marks


# ============================================================================== G-22 the final reads
class _Svc:
    def __init__(self, recs):
        self.recs = recs

    def get(self, pid, branch, rid):
        return self.recs.get(rid)


def _one(rid, interest, score, finish):
    return {"id": rid, "average_interest": interest, "overall": {"score": score},
            "stop": {"would_finish": finish}}


def test_g22_j_a_worse_second_beta_read_is_said_with_the_undo():
    svc = _Svc({"a": _one("a", 6.0, 6, True), "b": _one("b", 2.0, 2, False), "c": _one("c", 5.5, 6, True)})
    w = final_reads._beta_worse(svc, "p", "main", {"id": "a"}, {"id": "b"})  # noqa: SLF001
    assert w and "interest fell from 6 to 2/10" in w["line"] and "would no longer finish" in w["line"]
    assert "put the earlier version back" in w["line"] and "earlier chapter text back" in w["later"]
    assert final_reads._beta_worse(svc, "p", "main", {"id": "a"}, {"id": "c"}) is None  # noqa: SLF001 - < 1 point


class _Runner:
    def __init__(self, app=None, paused=False):
        self.app = app or SimpleNamespace(reports=None)
        self.events, self.paused = [], paused
        self.store = None

    def event(self, run, kind, msg, **kw):
        self.events.append(dict(kw, kind=kind, message=msg))

    def save(self, run):
        pass

    def check(self, run):
        if self.paused:
            raise _Paused()

    def bp(self, run):
        return None


class _Paused(Exception):
    control = True


def test_g22_j_the_run_step_notes_it_and_lists_it(monkeypatch):
    svc = _Svc({"a": _one("a", 6.0, 6, True), "b": _one("b", 2.0, 2, False)})
    svc.latest = lambda pid, branch: {"version_key": "old"}
    monkeypatch.setattr(beta, "service_of", lambda app: svc)
    monkeypatch.setattr(br, "book_chapters", lambda bp: [{"record_id": "r", "version": 2}])
    monkeypatch.setattr(br, "version_key", lambda chapters: "new")

    def again(runner, run, st, control=()):
        run["beta"] = {"id": "b", "status": "done", "average_interest": 2.0}
        st["message"] = "AI-2 read it"
    monkeypatch.setattr(beta, "run_step", again)
    runner = _Runner()
    run = {"id": "r1", "project_id": "p", "branch_id": "main", "settings": {"beta_reader": True},
           "beta": {"id": "a", "status": "done", "average_interest": 6.0}}
    line = final_reads._beta_again(runner, run, {}, {})  # noqa: SLF001
    assert "liked the book less" in line and "fell from 6 to 2/10" in line
    assert [e["code"] for e in runner.events] == ["BETA_WORSE", "BETA_AGAIN"]
    assert any("End rewrites" in x for x in run["check_later"])
    assert any("liked the book less" in w for w in run["report"]["warnings"])


def test_g22_l_an_out_of_date_beta_read_is_said_when_rereading_is_off(monkeypatch):
    svc = SimpleNamespace(latest=lambda pid, branch: {"version_key": "old"})
    monkeypatch.setattr(beta, "service_of", lambda app: svc)
    monkeypatch.setattr(br, "book_chapters", lambda bp: [{"record_id": "r", "version": 2}])
    monkeypatch.setattr(br, "version_key", lambda chapters: "new")
    runner = _Runner()
    run = {"id": "r1", "project_id": "p", "branch_id": "main",
           "settings": {"beta_reader": True, "beta_reread": False}, "beta": {"id": "a", "status": "done"}}
    line = final_reads._beta_again(runner, run, {}, {})  # noqa: SLF001
    assert "earlier version of the book" in line and "switched off" in line
    assert [e["code"] for e in runner.events] == ["BETA_OUT_OF_DATE"]
    monkeypatch.setattr(br, "version_key", lambda chapters: "old")  # nothing changed: nothing said
    assert final_reads._beta_again(_Runner(), dict(run), {}, {}) is None  # noqa: SLF001


def test_g22_n_a_pause_during_the_last_reread_is_honoured(monkeypatch):
    monkeypatch.setattr(final_reads, "_continuity_again", lambda *a: None)
    monkeypatch.setattr(final_reads, "_beta_again", lambda *a: "📖 read again")
    monkeypatch.setattr(final_reads, "_length", lambda *a: None)
    run = {"id": "r1", "project_id": "p", "branch_id": "main", "settings": {}}
    with pytest.raises(_Paused):
        final_reads.run_step(_Runner(paused=True), run, {})
    st = {}
    final_reads.run_step(_Runner(), run, st)
    assert st["message"] == "📖 read again"
