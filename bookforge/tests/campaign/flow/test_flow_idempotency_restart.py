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
def test_create_step_twice_does_not_duplicate_the_premise(tmp_path):
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    pid = guided_book(app)
    first = act(app, pid, "create", {"op": "B01"})
    second = act(app, pid, "create", {"op": "B01"})
    assert first["ok"]
    assert len(outputs(app, pid, "B01")) == 1, second.get("message")


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


def test_guided_refused_outline_offers_redo_and_the_redo_replaces_it(tmp_path):
    """NEW-flow-1 / NEW-ui-1 on "Make my book": a refused outline says why and how to redo it; Redo with AI sets the
    refused draft aside and the new outline (written knowing the refusal) can be approved."""
    state = {"n": 0}

    def outline(ctx, out):
        state["n"] += 1
        if state["n"] == 1:
            for it in out["chapters"]:
                for f in it["facts"]:
                    if f["predicate"] == "plan.pov_id":
                        f["value"] = "ghost-of-nobody"
        return out
    ai = fk.TraceAI(overrides={"B11": outline})
    app = fk.make_app(tmp_path, fake=ai)
    pid = guided_book(app)
    for op in ("B01", "B03"):
        out = act(app, pid, "create", {"op": op})
        assert act(app, pid, "approve", {"record_ids": [out["created"]["record_id"]], "author_confirms": True})["ok"]
    first = act(app, pid, "create", {"op": "B11"})["created"]
    step = {s["id"]: s for s in fk.bp_of(app, pid).status()["steps"]}["outline"]
    item = step["approve"][0]
    assert item["problems"] and "CANON_UNRESOLVED" in json.dumps(item["problems"])
    assert item["redo"] == {"action": "create", "op": "B11"}
    refused = act(app, pid, "approve", {"record_ids": [first["record_id"]], "author_confirms": True})
    assert not refused["ok"] and refused["results"][0]["redo"] == {"action": "create", "op": "B11"}
    again = act(app, pid, "create", {"op": "B11"})  # pressing the step again does not ask the AI again
    assert again.get("existing") and again["created"]["record_id"] == first["record_id"] and state["n"] == 1
    redo = act(app, pid, "create", {"op": "B11", "redo": True})
    assert redo["ok"] and redo["created"]["record_id"] != first["record_id"] and state["n"] == 2
    second_ctx = [c for k, c in ai.contexts if k == "B11"][1]
    assert "ghost-of-nobody" in json.dumps(second_ctx.get("previous_attempt_problems"))
    step = {s["id"]: s for s in redo["book"]["steps"]}["outline"]
    assert [i["record_id"] for i in step["approve"]] == [redo["created"]["record_id"]]  # the refused one is gone
    assert act(app, pid, "approve", {"record_ids": [redo["created"]["record_id"]], "author_confirms": True})["ok"]


def test_concurrent_profile_saves_keep_both_changes(tmp_path):
    """save_profile reads and writes the profile in one transaction: two saves at once keep both fields."""
    import threading  # noqa: PLC0415
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    pid = guided_book(app)
    errs = []

    def put(k, v):
        try:
            for _ in range(20):
                save_profile(app.store, pid, {k: f"{v}"})
        except Exception as exc:  # noqa: BLE001
            errs.append(exc)
        finally:
            app.store.close()
    ts = [threading.Thread(target=put, args=("genre", "Mystery")), threading.Thread(target=put, args=("tone", "Eerie"))]
    for t in ts:
        t.start()
    for t in ts:
        t.join(30)
    prof = app.store.get_setting(f"book_profile:{pid}")
    assert not errs and prof["genre"] == "Mystery" and prof["tone"] == "Eerie" and prof["title"] == "Twice"


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
def test_refused_outline_is_written_again_by_the_ai_not_resubmitted(tmp_path):
    """NEW-flow-1: an outline BookForge's checks refuse (5 chapters for a 3-chapter book) is set aside and the AI
    writes it again, told what was refused - the run is not stuck re-submitting the same draft."""
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
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    b11 = outputs(app, pid, "B11")
    assert len(b11) == 2 and [r["stale"] for r in b11] == [True, False]  # the refused one was set aside
    assert len(fk.bp_of(app, pid).outline_chapters(fk.bp_of(app, pid).outline())) == 3
    second = [c for k, c in ai.contexts if k == "B11"][1]
    assert "TARGET_LENGTH" in json.dumps(second.get("previous_attempt_problems")), second.keys()
    assert second["allowed"]["chapter_count"] == 3 and second["allowed"]["pov_ids"]
    assert any(e["kind"] == "fix" and "refused" in e["message"] for e in run["events"])


def test_try_again_after_a_refused_outline_lets_the_ai_fix_it(tmp_path):
    """NEW-flow-1: when every attempt is refused the run pauses (CHECKS_REFUSED, no 'approve anyway'); once the AI
    gets it right, Try again finishes the book instead of re-submitting the refused draft."""
    state = {"bad": True}

    def outline(ctx, out):
        if state["bad"]:
            out["chapters"] = out["chapters"] + [fk.plan_item(f"ch{i}", i - 1, "extra", "mara-vell",
                                                              "gullhaven-harbor") for i in (4, 5)]
        return out
    ai = fk.TraceAI(overrides={"B11": outline})
    app = fk.make_app(tmp_path, fake=ai)
    run = fk.run_book(app)
    assert run["status"] == "paused" and run["problem"]["step"] == "outline", run.get("problem")
    assert run["problem"]["code"] == "CHECKS_REFUSED" and "TARGET_LENGTH" in json.dumps(run["problem"])
    assert "approve_anyway" not in run["problem"]["options"]
    assert ai.kinds.count("B11") == 3  # the first draft and MAX_FIXES (2) new ones
    state["bad"] = False
    app.autobook.decide("author", run["id"], {"action": "retry"})
    run = fk.wait_run(app, run["id"])
    assert run["status"] == "done", run.get("problem")


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
        if run["status"] == "done":
            break
    assert run["status"] == "done", run.get("problem")
    assert len(outputs(app, pid, "A04")) == 1  # the saved place is kept; only the missing characters were made


def test_resume_names_a_book_left_unnamed(tmp_path):
    """NEW-fault-6 (recovery): a book whose profile has its title but whose name is still the placeholder (stopped
    between the two by an older BookForge) gets its name when the run resumes."""
    from bookforge.autobook import NEW_BOOK_NAME  # noqa: PLC0415
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    run = fk.run_book(app)
    pid = run["project_id"]
    with app.store.transaction() as tx:
        tx.execute("UPDATE projects SET name=? WHERE project_id=?", (NEW_BOOK_NAME, pid))
    raw = app.autobook.get(run["id"])
    raw["status"] = "paused"
    next(s for s in raw["steps"] if s["id"] == "profile")["state"] = "pending"
    app.autobook.save(raw)
    app.autobook.resume("author", run["id"])
    run = fk.wait_run(app, run["id"])
    assert run["status"] == "done", run.get("problem")
    assert app.store.project(pid)["name"] == run["title"] == "The Keeper of Gullhaven"


def test_decide_is_refused_unless_the_run_waits_for_a_decision(tmp_path):
    """NEW-flow-5 (regression): a finished run refuses a decision before doing anything."""
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    run = fk.run_book(app)
    with pytest.raises(Exception) as exc:
        app.autobook.decide("author", run["id"], {"action": "retry"})
    assert "done" in str(exc.value)


def test_two_make_a_book_presses_at_once_start_one_run(tmp_path):
    """BF-17: the 'is a run already working?' check and the launch are one step, so two presses at the same moment
    start exactly one run (the other is refused), and the run's services stay with that run's thread."""
    import threading  # noqa: PLC0415
    from bookforge.errors import BookforgeError  # noqa: PLC0415
    ai = fk.TraceAI()
    ai.gate = threading.Event()
    app = fk.make_app(tmp_path, fake=ai)
    barrier = threading.Barrier(4)
    out = []

    def press():
        barrier.wait()
        try:
            out.append(app.autobook.start("author", {"author_confirms": True})["id"])
        except BookforgeError as exc:
            out.append(exc.code)
    threads = [threading.Thread(target=press) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    started = [x for x in out if x.startswith("run-")]
    try:
        assert len(started) == 1 and sorted(x for x in out if not x.startswith("run-")) == ["VERSION_CONFLICT"] * 3
        assert getattr(app.autobook._tl, "run_id", None) is None  # this (test) thread is not inside the run
    finally:
        ai.gate.set()
        run = fk.wait_run(app, started[0])
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
