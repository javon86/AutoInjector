"""Independent pre-merge review (review2) of the fix round's BookForge core changes: the AI redo path of refused
drafts, step locks / Write-all, upgrade of books made before G06/G08 assembly, and E08 power limits.

Each test documents one problem found in review; see the docstrings for the failure scenario."""
from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
FLOW = HERE.parent / "flow"
if str(FLOW) not in sys.path:
    sys.path.insert(0, str(FLOW))

import flowkit as fk  # noqa: E402
from bookforge.engine import Engine  # noqa: E402
from bookforge.book_path import ASSEMBLY  # noqa: E402

from test_flow_idempotency_restart import act, guided_book, outputs  # noqa: E402


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    fk.quiet_provider_sleep(monkeypatch)


def _refuse_validate(monkeypatch, op, state):
    """BookForge's own checks refuse every VALIDATE of `op` while state['on'] (stands in for a real blocking rule,
    e.g. an AI-made place whose containment is cyclic)."""
    orig = Engine.dispatch

    def patched(self, req, principal, manual_candidate=None, **kw):
        if state["on"] and req.get("target_operation") == op and req.get("action") == "VALIDATE":
            return {"status": "DRAFT", "errors": [], "output_refs": [],
                    "findings": [{"rule_id": "TEST_BLOCKING", "severity": "BLOCKING", "decision": "FAIL",
                                  "message": f"{op} refused by a blocking rule"}]}
        return orig(self, req, principal, manual_candidate=manual_candidate, **kw)
    monkeypatch.setattr(Engine, "dispatch", patched)


# ---------------------------------------------------------------------------------------------- redo path bounds
def test_chapter_checks_always_refuse_is_bounded_and_retry_is_bounded(tmp_path, monkeypatch):
    """GOOD-path guard: checks that always refuse a chapter -> 1 + MAX_FIXES AI drafts, then a CHECKS_REFUSED pause;
    each Try again costs at most MAX_FIXES more AI drafts (no runaway spending)."""
    ai = fk.TraceAI()
    app = fk.make_app(tmp_path, fake=ai)
    state = {"on": True}
    _refuse_validate(monkeypatch, "C02", state)
    run = fk.run_book(app)
    assert run["status"] == "paused" and run["problem"]["code"] == "CHECKS_REFUSED", run.get("problem")
    assert ai.kinds.count("C02") == 3 and "review" not in ai.kinds[ai.kinds.index("C02"):]
    app.autobook.decide("author", run["id"], {"action": "retry"})
    run = fk.wait_run(app, run["id"])
    assert run["status"] == "paused" and run["problem"]["code"] == "CHECKS_REFUSED"
    assert ai.kinds.count("C02") == 5
    state["on"] = False
    app.autobook.decide("author", run["id"], {"action": "retry"})
    run = fk.wait_run(app, run["id"])
    assert run["status"] == "done", run.get("problem")


def test_reviewer_that_always_rejects_is_bounded(tmp_path):
    """GOOD-path guard: an AI reviewer that never approves -> 2 fixes then REVIEW_NOT_PASSED; Try again = 2 more."""
    ai = fk.TraceAI(default_verdict="REJECT")
    app = fk.make_app(tmp_path, fake=ai)
    run = fk.run_book(app)
    assert run["problem"]["code"] == "REVIEW_NOT_PASSED"
    assert ai.kinds.count("fix") == 2 and ai.kinds.count("review") == 3
    app.autobook.decide("author", run["id"], {"action": "retry"})
    run = fk.wait_run(app, run["id"])
    assert run["problem"]["code"] == "REVIEW_NOT_PASSED"
    assert ai.kinds.count("fix") == 4 and ai.kinds.count("review") == 6


def test_refused_canon_entry_try_again_lets_the_ai_make_it_again(tmp_path, monkeypatch):
    """BUG: a character/place draft BookForge's checks refuse pauses the run with CHECKS_REFUSED, whose fix text
    says "Press Try again: the AI writes it again". In the canon step nothing is ever set aside or re-made
    (_s_canon has no ChecksRefused handling; only _planning/_s_chapters call _redo_refused), so Try again just
    re-validates the same refused draft and pauses again, forever. Expected: Try again gets a new AI entry."""
    ai = fk.TraceAI()
    app = fk.make_app(tmp_path, fake=ai)
    state = {"on": True}
    _refuse_validate(monkeypatch, "A04", state)
    run = fk.run_book(app)
    assert run["status"] == "paused" and run["problem"]["code"] == "CHECKS_REFUSED", run.get("problem")
    assert run["problem"]["step"] == "canon"
    refused = run["problem"]["record_id"]
    canon_calls = ai.kinds.count("canon")
    app.autobook.decide("author", run["id"], {"action": "retry"})
    run = fk.wait_run(app, run["id"])
    # The promise of CHECKS_FIX: the AI writes the refused entry again.
    assert ai.kinds.count("canon") > canon_calls or run["problem"]["record_id"] != refused, (
        "Try again re-submitted the same refused place: the AI was not asked again", run["problem"]["message"])


# ---------------------------------------------------------------------------------------------- Write all + locks
def test_write_all_does_not_rewrite_a_chapter_the_author_just_wrote(tmp_path):
    """BUG: the new per-chapter step lock (book_path._step_lock) and the "already written" check are only used by
    the Make-my-book 'write_chapter' action. Write all chapters (WriteAllService._run) decides which chapters to
    write once at start and never takes the lock or re-checks, so a chapter the author writes from the book page
    while Write-all is busy is written a second time by the AI (duplicate draft, duplicate AI cost)."""
    gate, inside = threading.Event(), threading.Event()

    def c02(ctx, out):
        req = ctx.get("request_payload") or {}
        if threading.current_thread().name.startswith("bookforge-write_all") and req.get("chapter_id") == "ch1":
            inside.set()
            gate.wait(20)
        return out
    ai = fk.TraceAI(overrides={"C02": c02})
    app = fk.make_app(tmp_path, fake=ai)
    pid = guided_book(app, chapters=2)
    for op in ("B01", "B03", "B11"):
        out = act(app, pid, "create", {"op": op})
        assert act(app, pid, "approve", {"record_ids": [out["created"]["record_id"]], "author_confirms": True})["ok"]
    job = app.write_all.start("author", pid, "main")
    assert inside.wait(20)  # Write-all is busy writing ch1
    mine = act(app, pid, "write_chapter", {"chapter_id": "ch2"})  # the author writes ch2 meanwhile
    assert mine["ok"] and mine.get("created")
    gate.set()
    app.write_all.wait_for(job["id"], 60)
    assert app.write_all.get(job["id"])["status"] == "done"
    ch2 = [r for r in outputs(app, pid, "C02") if (r.get("data") or {}).get("chapter_id") == "ch2"
           or "[ch2/" in ((r.get("data") or {}).get("text") or "")]
    assert len(ch2) == 1, f"chapter ch2 was written {len(ch2)} times (Write-all ignored the author's draft)"


# ---------------------------------------------------------------------------------------------- books made earlier
def test_book_finished_before_the_g06_g08_assembly_stays_consistent(tmp_path):
    """BUG (upgrade): a book finished with the old 5-record assembly (G02/G01/G05/G04/G07, no G06/G08 in the path
    memory) opens with assemble='ready', export='blocked' but check='done' (waiting_for 'assemble'), its files
    still listed, and nothing says why it must be put together again. Reproduced on real old data (a book made by
    commit f7b5553 and opened with this branch). Expected: a consistent state - the check is not 'done' while the
    assembly it checked is not current, and the assemble step explains the re-assembly (title page/headings)."""
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    run = fk.run_book(app)
    assert run["status"] == "done"
    pid = run["project_id"]
    bp = fk.bp_of(app, pid)

    def old_format(m):  # what f7b5553 stored: no G06/G08/G01_plain/G05_plain/title_rules
        for k in ("G06", "G08", "G01_plain", "G05_plain"):
            m["assembly"].pop(k, None)
        m.pop("title_rules", None)
    bp.remember(old_format)
    st = {s["id"]: s for s in fk.bp_of(app, pid).status()["steps"]}
    assert set(ASSEMBLY) - {"G06", "G08"} <= set(bp.mem["assembly"])
    if st["assemble"]["state"] != "done":
        assert st["check"]["state"] != "done", ("check shows done although its assembly is no longer current",
                                                st["assemble"]["state"], st["export"]["state"])
        assert "title page" in st["assemble"]["about"].lower() or "again" in st["assemble"]["about"].lower(), \
            st["assemble"]["about"]


# ---------------------------------------------------------------------------------------------- author's own edit
def test_continue_after_the_authors_own_edit_never_discards_it_for_new_ai_text(tmp_path, monkeypatch):
    """BUG: the run pauses on chapter ch1 (REVIEW_NOT_PASSED) and offers "Edit it yourself and then press
    Continue". The author edits the chapter; BookForge's checks refuse the edited version; on Continue
    (decide 'edited') the chapter loop treats the refusal like a refused AI draft: _redo_refused sets the AUTHOR's
    version aside (marked out of date) and has the AI write a brand-new chapter, which is then reviewed and approved
    under the run consent. The author's work silently leaves the approval queue and AI text replaces it.
    Expected: a refusal of the author's own edit pauses for the author (CHECKS_REFUSED) without asking the AI."""
    import json as _json
    state = {"revise": True, "refuse": False}

    def review(ctx, out):
        draft = (ctx.get("draft") or {})
        if state["revise"] and draft.get("module_id") == "C02":
            return dict(out, verdict="REVISE")
        return out
    ai = fk.TraceAI(overrides={"review": review})
    app = fk.make_app(tmp_path, fake=ai)
    orig = Engine.dispatch

    def patched(self, req, principal, manual_candidate=None, **kw):
        if state["refuse"] and req.get("target_operation") == "C02" and req.get("action") == "VALIDATE":
            rec = app.store.get_record(req["project_id"], req["branch_id"], req["base_ref"]["record_id"],
                                       req["base_ref"]["version"])
            if rec and "AUTHOR EDIT" in _json.dumps(rec.get("data")):
                return {"status": "DRAFT", "errors": [], "output_refs": [],
                        "findings": [{"rule_id": "TEST_BLOCKING", "severity": "BLOCKING", "decision": "FAIL",
                                      "message": "the edited chapter breaks a blocking rule"}]}
        return orig(self, req, principal, manual_candidate=manual_candidate, **kw)
    monkeypatch.setattr(Engine, "dispatch", patched)
    run = fk.run_book(app)
    assert run["status"] == "paused" and run["problem"]["code"] == "REVIEW_NOT_PASSED", run.get("problem")
    assert run["problem"]["step"] == "chapters" and "edit" in run["problem"]["options"]
    pid, rid = run["project_id"], run["problem"]["record_id"]
    head = app.store.get_record(pid, "main", rid)
    data = dict(head["data"], text="AUTHOR EDIT. " + head["data"]["text"])
    bp = fk.bp_of(app, pid)
    u = bp.dispatch("C02", "UPDATE", base_ref=head["ref"], payload=data, manual_candidate=data)
    assert u["status"] == "DRAFT", u
    mine = u["output_refs"][0]
    ai_c02_before = ai.kinds.count("C02")
    state.update(revise=False, refuse=True)
    app.autobook.decide("author", run["id"], {"action": "edited"})
    run = fk.wait_run(app, run["id"])
    after = app.store.get_record(pid, "main", mine["record_id"], mine["version"])
    del ai_c02_before
    assert not after.get("stale"), ("the author's edited chapter was set aside and the AI wrote a new one",
                                    after.get("stale_reason"), run["status"])
    assert run["status"] == "paused" and run["problem"]["code"] == "CHECKS_REFUSED"
