"""🩹 Clean runs: a fix that breaks Akọwe's own checks no longer stops the book.

The pattern the logs showed (plot step 3/19, chapter 3): the AI reviewer asks for a change, the writer's fix answers
it but breaks a story-map fact, Akọwe's checks refuse the new version and the run stopped (CHECKS_REFUSED), or the
whole draft was thrown away and written again — and broken again. Now:

* the fixer is told Akọwe's rules up front, and exactly what the checks refused (context.akowe_checks);
* a refused AI version is repaired (at most MAX_REPAIRS times), keeping the reviewer's points;
* if the repairs fail, the last version that passed the checks is put back and the reviewer's objection is decided
  the usual way (REVIEW_NOT_PASSED: the author, or the AIs' vote) — never a stop on a broken draft;
* each step is one code-only line in akowe.log (no book text).
"""
from __future__ import annotations

import json
import logging

from akowe import autobook as ab_mod
from akowe.book_path import BookPath

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book, steps

BROKEN = "(revised)"   # what the fake's fix adds — here it breaks a story-map fact
MENDED = "(repaired)"  # what a repair that obeys context.akowe_checks leaves instead
RULE = "CANON_CONFLICT"


class RepairingFake(BookFakeAI):
    """The fake writer: a plain fix adds BROKEN; a repair (context.akowe_checks given) mends it when ``mend``."""

    def __init__(self, *a, mend=True, **kw):
        super().__init__(*a, **kw)
        self.mend = mend

    def _answer(self, ctx, props, schema):
        kind, out = super()._answer(ctx, props, schema)
        if kind == "fix" and ctx.get("akowe_checks"):
            if self.mend:
                out = json.loads(json.dumps(out).replace(BROKEN, MENDED))
            return "repair", out
        return kind, out


def refuse_broken(monkeypatch, when=lambda data_json: BROKEN in data_json):
    """Akọwe's checks (VALIDATE) refuse a version whose data matches ``when``, like a story-map conflict."""
    orig = BookPath.dispatch
    seen = []

    def dispatch(self, op, action, **kw):
        if action == "VALIDATE" and kw.get("base_ref"):
            rec = self.rec(kw["base_ref"]["record_id"])
            if rec is not None and when(json.dumps(rec.get("data"), ensure_ascii=False)):
                seen.append((rec["record_id"], rec["version"]))
                return {"status": "REJECTED", "errors": [], "output_refs": [],
                        "findings": [{"rule_id": RULE, "severity": "BLOCKING", "decision": "FAIL",
                                      "message": "the place's name contradicts the approved canon"}]}
        return orig(self, op, action, **kw)

    monkeypatch.setattr(BookPath, "dispatch", dispatch)
    return seen


def events(app, run_id, kind=None, code=None):
    return [e for e in app.autobook.get(run_id)["events"]
            if (kind is None or e["kind"] == kind) and (code is None or e.get("code") == code)]


def test_a_fix_that_breaks_the_checks_is_repaired_and_the_run_finishes(tmp_path, monkeypatch, caplog):
    fake = RepairingFake(verdicts=["REVISE"])  # one objection; the fix answers it but breaks the canon
    app = make_app(tmp_path, fake=fake)
    seen = refuse_broken(monkeypatch)
    with caplog.at_level(logging.INFO, logger="akowe.autobook"):
        run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    assert seen, "Akọwe's checks refused the broken fix"
    assert fake.kinds.count("fix") == 1 and fake.kinds.count("repair") == 1
    # the repair is told exactly what was refused, and still has the reviewer's points
    _sys, ctx = fake.prompts["repair"][0]
    assert any(c.startswith(RULE + ":") for c in ctx["akowe_checks"])
    assert ctx["review"]["verdict"] == "REVISE" and ctx["review"]["reasons"]
    assert events(app, run["id"], "repair", "CHECKS_REPAIR") and events(app, run["id"], "repair_done")
    assert not events(app, run["id"], code="CHECKS_REFUSED")  # never a stop
    assert not any(e["kind"] == "fix" and "write it again" in e["message"] for e in app.autobook.get(run["id"])["events"])
    # 🧾 the log: one code-only line per step, never the book's text
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("review-loop")]
    assert any("step=checks_refused" in x and f"rules={RULE}" in x for x in lines)
    assert any("step=repair " in x and "n=1/2" in x for x in lines)
    assert any("step=review" in x and "verdict=REVISE" in x and "reasons=1" in x for x in lines)
    assert not any("Gullhaven" in x or "Mara" in x or "contradicts" in x for x in lines)


def test_every_fix_is_told_the_rules_up_front(tmp_path):
    fake = BookFakeAI(verdicts=["REVISE"])
    app = make_app(tmp_path, fake=fake)
    run = run_book(app)
    assert run["status"] == "done"
    system, ctx = fake.prompts["fix"][0]
    blob = system + json.dumps(ctx, ensure_ascii=False)
    assert "never contradict an approved fact" in blob and "akowe_checks" not in ctx  # no refusal: no checks list


def test_repairs_that_fail_put_the_last_good_version_back(tmp_path, monkeypatch):
    fake = RepairingFake(verdicts=["REVISE"], mend=False)  # the repairs keep the conflict
    app = make_app(tmp_path, fake=fake)
    refuse_broken(monkeypatch)
    run = run_book(app)
    assert run["status"] == "paused", run["phase"]
    prob = run["problem"]
    # not a stop on a broken draft: the reviewer's objection is decided the usual way (author / the AIs' vote)
    assert prob["code"] == "REVIEW_NOT_PASSED" and "approve_anyway" in prob["options"], prob
    assert fake.kinds.count("repair") == ab_mod.MAX_REPAIRS
    head = app.store.history(run["project_id"], "main", prob["record_id"])[-1]
    assert BROKEN not in json.dumps(head["data"]) and head["version"] == prob["version"]
    first = app.store.get_record(run["project_id"], "main", prob["record_id"], 1)
    assert head["data"] == first["data"], "the version that passed the checks is back"
    assert events(app, run["id"], "restore", "FIX_UNDONE")
    app.autobook.decide("author", run["id"], {"action": "approve_anyway", "author_confirms": True})
    app.autobook.wait_for(run["id"], 120)
    run = app.autobook.public(app.autobook.get(run["id"]))
    assert run["status"] == "done", run["phase"]


def test_a_refused_fix_tells_the_next_fix_what_was_refused(tmp_path, monkeypatch):
    fake = BookFakeAI(verdicts=["REVISE", "REVISE"])
    app = make_app(tmp_path, fake=fake)
    orig = BookPath.dispatch
    refused = []

    def dispatch(self, op, action, **kw):  # the first fix's UPDATE is refused (nothing saved)
        if action == "UPDATE" and not refused and BROKEN in json.dumps(kw.get("payload") or {}):
            refused.append(op)
            return {"status": "REJECTED", "output_refs": [], "errors": [],
                    "findings": [{"rule_id": "NAME_CHANGED", "severity": "BLOCKING", "decision": "FAIL",
                                  "message": "a character's name changed"}]}
        return orig(self, op, action, **kw)

    monkeypatch.setattr(BookPath, "dispatch", dispatch)
    run = run_book(app)
    assert refused and run["status"] == "done", run["phase"]
    first, second = fake.prompts["fix"][0][1], fake.prompts["fix"][1][1]
    assert "akowe_checks" not in first
    assert any(c.startswith("NAME_CHANGED:") for c in second["akowe_checks"])


def test_a_first_draft_the_checks_refuse_is_repaired_not_thrown_away(tmp_path, monkeypatch):
    fake = RepairingFake()
    app = make_app(tmp_path, fake=fake)
    state = {"refused": 0}

    def when(data_json):  # the main plot's first draft breaks a fact once; the repair mends it
        if '"main_plot"' in data_json and MENDED not in data_json and state["refused"] == 0:
            state["refused"] += 1
            return True
        return False

    refuse_broken(monkeypatch, when)
    run = run_book(app)
    assert run["status"] == "done", run["phase"]
    assert state["refused"] == 1 and fake.kinds.count("repair") == 1
    assert steps(run)["plot"]["state"] == "done"


def test_the_authors_own_text_is_never_repaired_by_the_ai(tmp_path, monkeypatch):
    app = make_app(tmp_path, fake=RepairingFake())
    run = {"id": "r1", "project_id": "p", "branch_id": "main", "made": {}}
    monkeypatch.setattr(app.autobook, "_ai_made", lambda run, rec: False)
    head = {"record_id": "x", "version": 2, "module_id": "B03"}
    assert app.autobook._repair_refused(run, {}, head, "main plot", [RULE + ": a conflict"]) is False
    # an old source pin is not the AI's to fix either (🔁 Try again re-pins it)
    monkeypatch.setattr(app.autobook, "_ai_made", lambda run, rec: True)
    assert app.autobook._repair_refused(run, {}, head, "main plot", ["STALE: an old source"]) is False
    assert "check_repairs" not in run or not run["check_repairs"]


def test_rule_codes_keep_only_codes():
    assert ab_mod.rule_codes(["CANON_CONFLICT: Mara's name", "CANON_CONFLICT: again", "weird text: x",
                              "PROTAGONIST_MISSING: no Mara"]) == ["CANON_CONFLICT", "OTHER", "PROTAGONIST_MISSING"]


# ====================================================================== 5. ▶ Resume during a long wait
def test_sleep_unless_woken_ends_early_when_woken():
    import threading  # noqa: PLC0415
    import time  # noqa: PLC0415

    from akowe import jobs  # noqa: PLC0415
    pol = jobs.RetryPolicy([1], 5)
    t0 = time.monotonic()
    threading.Timer(0.3, jobs.wake_waits).start()
    slept = jobs.sleep_unless_woken(pol, 60, None)
    assert slept < 5 and time.monotonic() - t0 < 5
    assert jobs.sleep_unless_woken(pol, 0.6, None) >= 0.6  # a wake before the wait started does not cut it


def test_resume_during_a_usage_limit_wait_tries_the_ai_again_now(tmp_path):
    import time  # noqa: PLC0415

    from akowe import usage_limits  # noqa: PLC0415
    from akowe.errors import AkoweError  # noqa: PLC0415
    from akowe.jobs import RetryPolicy  # noqa: PLC0415
    from autobook_fake import trust_one_ai  # noqa: PLC0415
    class LimitedFake(BookFakeAI):  # every AI is at its usage limit until the test lifts it
        limited = True

        def submit(self, slot, system, user, schema):
            if self.limited:
                exc = AkoweError("UPSTREAM_UNAVAILABLE", "", "no AI works")
                exc.usage_limited, exc.limited_names, exc.reset_at = True, ["Claude", "ChatGPT"], None
                usage_limits.note(["Claude", "ChatGPT"])
                raise exc
            return super().submit(slot, system, user, schema)

    fake = LimitedFake()
    app = make_app(tmp_path, fake=fake)
    slow = RetryPolicy([0.01], 5, limit_wait_s=7200, limit_check_s=3600)  # an hour before the next look
    app.autobook.retry_policy = app.write_all.retry_policy = app.assist.retry_policy = slow
    try:
        r = app.autobook.start("author", {"author_confirms": True})
        end = time.time() + 30
        while time.time() < end and not app.autobook.get(r["id"]).get("waiting"):
            time.sleep(0.05)
        run = app.autobook.get(r["id"])
        assert run.get("waiting") and run["waiting"]["kind"] == "usage_limit", run.get("phase")
        t0 = time.time()
        fake.limited = False  # one AI works again; the next look would be an hour away
        usage_limits.clear()
        app.autobook.resume("author", r["id"])
        app.autobook.wait_for(r["id"], 120)
        trust_one_ai(app, r["id"], 120)
        run = app.autobook.public(app.autobook.get(r["id"]))
        assert run["status"] == "done" and time.time() - t0 < 110, run["phase"]
        assert events(app, r["id"], "resume", "WAIT_WOKEN")
    finally:
        usage_limits.clear()


def test_resume_while_already_working_says_so(tmp_path):
    import threading  # noqa: PLC0415
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    fake.gate = threading.Event()
    r = app.autobook.start("author", {"author_confirms": True})
    assert fake.waiting.wait(30)
    app.autobook.resume("author", r["id"])
    assert events(app, r["id"], "note", "ALREADY_RUNNING")
    fake.gate.set()
    app.autobook.wait_for(r["id"], 120)
