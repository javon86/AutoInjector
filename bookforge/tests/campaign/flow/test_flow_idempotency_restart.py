"""Re-running steps and restarting mid-run: pressing a step twice, "Try again" after a refusal, and a BookForge
restart (crash-consistent copy of the data folder taken while an AI call is in flight) must neither lose nor
duplicate characters, plans or chapters, and the run must be able to finish."""
from __future__ import annotations

import json

import pytest

import flowkit as fk
from autobook_fake import fact
from bookforge.book_path import save_profile
from bookforge.engine import Engine


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    fk.quiet_provider_sleep(monkeypatch)


def outputs(app, pid, op):
    return app.store.list_records(pid, "main", op, "OUTPUT")


def guided_book(app, chapters=2):
    pid = app.engine.bootstrap_project("author", "Twice", release_profiles=["MANUSCRIPT_PDF", "EPUB_REFLOWABLE",
                                                                           "EDITABLE_DOCX"])
    save_profile(app.store, pid, {"title": "Twice", "author": "A", "idea": "A keeper vanishes.",
                                  "length": "short_story", "chapters": chapters})
    bp = fk.bp_of(app, pid)
    for op, name, sid in (("A04", "Gullhaven Harbor", "gullhaven-harbor"), ("A01", "Mara Vell", "mara-vell")):
        ref, _ = bp.create(op, {"concept": name}, manual_candidate={
            "concept": name, "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
            "facts": [fact(sid, "entity.name", name)]})
        assert fk.bp_of(app, pid).approve_ref(ref)["ok"]
    return pid


def act(app, pid, action, body=None):
    return fk.bp_of(app, pid).act(action, body or {})


# ------------------------------------------------------------------------------------------- "next step" twice
@pytest.mark.xfail(strict=True, reason="NEW-flow-6: pressing a Make-my-book create step twice (or after it is done) "
                                       "asks the AI again and leaves duplicate premise/plan drafts that can all be "
                                       "approved")
def test_create_step_twice_does_not_duplicate_the_premise(tmp_path):
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    pid = guided_book(app)
    first = act(app, pid, "create", {"op": "B01"})
    second = act(app, pid, "create", {"op": "B01"})
    assert first["ok"]
    assert len(outputs(app, pid, "B01")) == 1, second.get("message")


@pytest.mark.xfail(strict=True, reason="NEW-flow-6: write_chapter twice writes the same chapter twice (two AI "
                                       "calls, two drafts for one outline chapter)")
def test_write_chapter_twice_does_not_duplicate_the_chapter(tmp_path):
    ai = fk.TraceAI()
    app = fk.make_app(tmp_path, fake=ai)
    pid = guided_book(app)
    for op, sid in (("B01", "premise"), ("B03", "plot"), ("B11", "outline")):
        out = act(app, pid, "create", {"op": op})
        assert act(app, pid, "approve", {"record_ids": [out["created"]["record_id"]], "author_confirms": True})["ok"]
    act(app, pid, "write_chapter", {"chapter_id": "ch1"})
    act(app, pid, "write_chapter", {"chapter_id": "ch1"})
    assert len(outputs(app, pid, "C01")) == 1  # the context is reused
    assert ai.kinds.count("C02") == 1 and len(outputs(app, pid, "C02")) == 1


def test_approved_steps_are_not_redone_by_their_actions(tmp_path):
    """Pressing assemble/export/check again after approval: the approved chapters are the only source and the
    newest export still holds each chapter exactly once."""
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    run = fk.run_book(app)
    pid = run["project_id"]
    for _ in range(2):
        out = act(app, pid, "export")
        assert out["ok"] and not out.get("problems"), out
    assert act(app, pid, "check")["ok"]
    chapters = fk.approved_chapters(app, pid)
    paras = fk.epub_info(fk.export_files(app, pid)["EPUB"])["paras"]
    for _cid, rec in chapters:
        assert fk.count_sub(paras, fk.expected_paragraphs(rec["data"]["text"])) == 1
    assert len(outputs(app, pid, "C02")) == 3


# ------------------------------------------------------------------------------------------- "Try again" loops
@pytest.mark.xfail(strict=True, reason="NEW-flow-1: when BookForge's checks refuse the approval of an AI draft "
                                       "(TARGET_LENGTH, CANON_UNRESOLVED, PLAN_ITEM_DUPLICATE ...), 'Try again' "
                                       "re-submits the same draft forever; the AI is never asked to fix or redo it")
def test_try_again_after_a_refused_outline_lets_the_ai_fix_it(tmp_path):
    state = {"n": 0}

    def outline(ctx, out):
        state["n"] += 1
        if state["n"] == 1:  # the first outline has 5 chapters for a 3-chapter book
            out["chapters"] = out["chapters"] + [fk.plan_item(f"ch{i}", i - 1, "extra", "mara-vell",
                                                              "gullhaven-harbor") for i in (4, 5)]
        return out
    ai = fk.TraceAI(overrides={"B11": outline})
    app = fk.make_app(tmp_path, fake=ai)
    run = fk.run_book(app)
    assert run["problem"]["step"] == "outline" and "TARGET_LENGTH" in json.dumps(run["problem"])
    for _ in range(2):
        app.autobook.decide("author", run["id"], {"action": "retry"})
        run = fk.wait_run(app, run["id"])
        if run["status"] == "done":
            break
    assert run["status"] == "done", run.get("problem")


@pytest.mark.xfail(strict=True, reason="NEW-flow-2: when the canon step stops after some Bible entries were saved "
                                       "but no main character (crash or a refused A01 create), Try again never makes "
                                       "a character again - the run can never finish")
def test_canon_step_recovers_when_the_main_character_was_not_saved(tmp_path, monkeypatch):
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    orig = Engine.dispatch
    state = {"on": True}

    def flaky(self, req, principal, manual_candidate=None, **kw):
        if req.get("target_operation") == "A01" and req.get("action") == "CREATE" and state["on"]:
            # e.g. the database was busy / BookForge stopped right after the place was saved
            return {"status": "REJECTED", "errors": [{"code": "VERSION_CONFLICT", "path": "",
                                                      "message": "database is busy"}], "output_refs": []}
        return orig(self, req, principal, manual_candidate=manual_candidate, **kw)
    monkeypatch.setattr(Engine, "dispatch", flaky)
    run = fk.run_book(app)
    assert run["problem"]["step"] == "canon"
    pid = run["project_id"]
    assert outputs(app, pid, "A04") and not outputs(app, pid, "A01")
    state["on"] = False  # the problem is gone
    for _ in range(2):  # the author presses Try again
        app.autobook.decide("author", run["id"], {"action": "retry"})
        run = fk.wait_run(app, run["id"])
    assert run["status"] == "done", run.get("problem")


# ------------------------------------------------------------------------------------------- restart mid-step
CRASH_POINTS = [("profile", 1), ("sketch", 1), ("canon", 2), ("review", 1), ("B01", 1), ("B03", 1), ("B11", 1),
                ("C02", 2), ("review", 7)]


@pytest.mark.parametrize("kind,nth", CRASH_POINTS, ids=[f"{k}-{n}" for k, n in CRASH_POINTS])
def test_restart_while_the_ai_is_answering_then_resume(tmp_path, kind, nth):
    """Copy the data folder (committed state only) while the nth `kind` AI call is in flight = BookForge stopped
    there. A new BookForge on that copy shows the run interrupted; Resume finishes the book with nothing lost or
    duplicated."""
    snap = tmp_path / "after-crash"
    seen = {"n": 0}
    holder = {}

    def crash_here(ctx, out):
        seen["n"] += 1
        if seen["n"] == nth and not snap.exists():
            fk.snapshot_data(holder["app"], tmp_path / "data", snap)
        return out
    ai = fk.TraceAI(overrides={kind: crash_here})
    app = fk.make_app(tmp_path, fake=ai)
    holder["app"] = app
    first = fk.run_book(app)
    assert first["status"] == "done" and snap.exists()
    app.store.close()

    ai2 = fk.TraceAI()
    app2 = fk.make_app(tmp_path, name="after-crash", fake=ai2)
    run = app2.autobook.get(first["id"])
    assert run["status"] == "interrupted", run["status"]
    app2.autobook.resume("author", first["id"])
    run = fk.wait_run(app2, first["id"])
    assert run["status"] == "done", (run.get("problem"), [(s["id"], s["state"]) for s in run["steps"]])
    pid = run["project_id"]
    assert pid  # the same book continues
    assert len(app2.store.query("SELECT project_id FROM projects WHERE settings LIKE ?", (f"%{first['id']}%",))) == 1
    bp = fk.bp_of(app2, pid)
    counts = {op: len(outputs(app2, pid, op)) for op in ("A01", "A04", "B01", "B03", "B11", "C01", "C02")}
    assert counts == {"A01": 2, "A04": 1, "B01": 1, "B03": 1, "B11": 1, "C01": 3, "C02": 3}, counts
    assert len(bp.approved("A01")) == 2 and len(bp.approved("B11")) == 1
    chapters = fk.approved_chapters(app2, pid)
    assert [c for c, _ in chapters] == ["ch1", "ch2", "ch3"]
    paras = fk.epub_info(fk.export_files(app2, pid, run["files"])["EPUB"])["paras"]
    assert paras == [p for _c, rec in chapters for p in fk.expected_paragraphs(rec["data"]["text"])]
    assert {s["id"]: s for s in bp.status()["steps"]}["check"]["result"] == "PASS"
    app2.store.close()
