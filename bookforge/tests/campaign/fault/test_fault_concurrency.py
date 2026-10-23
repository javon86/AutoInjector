"""Concurrency and idempotency (fault campaign): parallel HTTP writers on one record (CAS conflicts, never lost
updates), parallel creates, two tabs approving the same draft, replayed idempotency keys, export while editing,
restore while other work is in flight, and BookPath's own memory under concurrent book actions."""
from __future__ import annotations

import json
import threading
import time
import types
from collections import Counter
from http.server import ThreadingHTTPServer

import pytest

from bookforge import providers as prov_mod
from bookforge.book_path import BookPath
from bookforge.errors import BookforgeError
from bookforge.jobs import RetryPolicy
from bookforge.server import App, make_handler

from autobook_fake import BookFakeAI
from fault_helpers import TOKEN, call, check_store

CONFIRM = {"author_confirms": True, "confirm": "RESTORE"}


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def make_app(path, fake=True):
    app = App(path, token=TOKEN)
    app.engine.providers.secret_path = path.parent / f"{path.name}-secrets.json"
    if fake:
        app.engine.providers.test_adapter = BookFakeAI()
        app.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
    fast = RetryPolicy([0.01, 0.02], 5)
    app.autobook.retry_policy = app.write_all.retry_policy = app.assist.retry_policy = fast
    return app


@pytest.fixture
def served(tmp_path):
    app = make_app(tmp_path / "data")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
    try:
        yield app, httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()
        app.store.close()


def made_book(app):
    r = app.autobook.start("author", {"author_confirms": True, "length": "short_story"})
    app.autobook.wait_for(r["id"], 120)
    run = app.autobook.get(r["id"])
    assert run["status"] == "done", run.get("problem")
    return run


def dispatch(port, pid, op, action, payload, base_ref=None, key=None):
    req = {"project_id": pid, "branch_id": "main", "target_operation": op, "action": action, "payload": payload}
    if base_ref:
        req["base_ref"] = base_ref
    if key:
        req["idempotency_key"] = key
    st, b = call(port, "POST", "/api/dispatch", {"request": req})
    assert st == 200, b
    return b["response"]


def parallel(n, fn):
    """n threads released together (n <= 8: the stdlib server's listen backlog is 5, like a browser's 6 per host)."""
    bar = threading.Barrier(n)
    out = [None] * n

    def run(i):
        bar.wait()
        out[i] = fn(i)
    ts = [threading.Thread(target=run, args=(i,)) for i in range(n)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(60)
    return out


def codes(resp):
    return tuple(e["code"] for e in resp.get("errors") or [])


# ---------------------------------------------------------------------------------------------- CAS / creates
def test_parallel_updates_of_one_record_one_wins_rest_conflict(served):
    app, port = served
    pid = app.engine.bootstrap_project("author", "CAS")
    r = dispatch(port, pid, "A01", "CREATE", {"concept": "Mara"})
    ref, data = r["output_refs"][0], r["result"]
    out = parallel(8, lambda i: dispatch(port, pid, "A01", "UPDATE", dict(data, concept=f"Mara {i}"), base_ref=ref))
    c = Counter((o["status"], codes(o)) for o in out)
    assert c == {("DRAFT", ()): 1, ("REJECTED", ("VERSION_CONFLICT",)): 7}, c
    winner = next(i for i, o in enumerate(out) if o["status"] == "DRAFT")
    hist = app.store.history(pid, "main", ref["record_id"])
    assert [h["version"] for h in hist] == [1, 2] and hist[-1]["data"]["concept"] == f"Mara {winner}"
    assert check_store(app.store.data_dir) == []


def test_parallel_creates_all_land_with_distinct_ids(served):
    app, port = served
    pid = app.engine.bootstrap_project("author", "Creates")
    out = parallel(8, lambda i: dispatch(port, pid, "A01", "CREATE", {"concept": f"Person {i}"}))
    assert all(o["status"] == "DRAFT" for o in out), [codes(o) for o in out]
    ids = {o["output_refs"][0]["record_id"] for o in out}
    assert len(ids) == 8 and len(app.store.list_records(pid, "main", module_id="A01")) == 8
    assert check_store(app.store.data_dir) == []


# ---------------------------------------------------------------------------------------------- idempotency
def test_replayed_idempotency_key_same_body_returns_the_same_receipt(served):
    app, port = served
    pid = app.engine.bootstrap_project("author", "Idem")
    a = dispatch(port, pid, "A01", "CREATE", {"concept": "Same"}, key="key-1")
    b = dispatch(port, pid, "A01", "CREATE", {"concept": "Same"}, key="key-1")
    assert a["status"] == "DRAFT" and b == a
    assert len(app.store.list_records(pid, "main", module_id="A01")) == 1
    # the same key for another operation is a different request, not a conflict
    c = dispatch(port, pid, "A04", "CREATE", {"concept": "Harbor"}, key="key-1")
    assert codes(c) != ("IDEMPOTENCY_CONFLICT",)


def test_replayed_idempotency_key_different_body_is_a_conflict(served):
    app, port = served
    pid = app.engine.bootstrap_project("author", "Idem")
    dispatch(port, pid, "A01", "CREATE", {"concept": "First"}, key="key-2")
    b = dispatch(port, pid, "A01", "CREATE", {"concept": "Second"}, key="key-2")
    assert b["status"] == "REJECTED" and codes(b) == ("IDEMPOTENCY_CONFLICT",)
    recs = app.store.list_records(pid, "main", module_id="A01")
    assert [r["data"]["concept"] for r in recs] == ["First"]


def test_concurrent_replays_of_one_key_create_one_record(served):
    app, port = served
    pid = app.engine.bootstrap_project("author", "Idem")
    same = parallel(8, lambda i: dispatch(port, pid, "A01", "CREATE", {"concept": "Same"}, key="k-same"))
    assert len({json.dumps(o["output_refs"]) for o in same}) == 1 and all(o["status"] == "DRAFT" for o in same)
    diff = parallel(8, lambda i: dispatch(port, pid, "A01", "CREATE", {"concept": f"D{i}"}, key="k-diff"))
    c = Counter((o["status"], codes(o)) for o in diff)
    assert c == {("DRAFT", ()): 1, ("REJECTED", ("IDEMPOTENCY_CONFLICT",)): 7}, c
    assert len(app.store.list_records(pid, "main", module_id="A01")) == 2
    assert check_store(app.store.data_dir) == []


# ---------------------------------------------------------------------------------------------- two tabs approve
def _sync_validation(app, n=2):
    """Make n concurrent ACCEPT/VALIDATE dispatches meet after they read the candidate (a reproducible race)."""
    bar = threading.Barrier(n, timeout=5)
    real = app.engine.run_validation

    def run_validation(ctx, handler, rec):
        if ctx.action == "ACCEPT":
            try:
                bar.wait()
            except threading.BrokenBarrierError:
                pass
        return real(ctx, handler, rec)
    app.engine.run_validation = run_validation


@pytest.mark.xfail(strict=True, reason="NEW-fault-14: Engine._accept reads the candidate's lifecycle outside the "
                                       "commit transaction: two tabs approving the same draft both commit, giving two "
                                       "approval records, two ACCEPT audit rows and two record.approved events")
def test_two_tabs_approving_the_same_draft_approve_it_once(served):
    app, port = served
    pid = app.engine.bootstrap_project("author", "Tabs")
    rid = dispatch(port, pid, "A01", "CREATE", {"concept": "Mara"})["output_refs"][0]["record_id"]
    _sync_validation(app)
    out = parallel(2, lambda i: call(port, "POST", f"/api/projects/{pid}/branches/main/review/approve",
                                     {"record_ids": [rid], "versions": {rid: 1}, "author_confirms": True}))
    assert all(st == 200 and b["results"][0]["ok"] for st, b in out), out
    n_appr = app.store.query_one("SELECT COUNT(*) n FROM approvals WHERE subject_ref LIKE ?", (f'%{rid}%',))["n"]
    n_audit = app.store.query_one("SELECT COUNT(*) n FROM audit WHERE action='ACCEPT' AND output_refs LIKE ?",
                                  (f'%{rid}%',))["n"]
    n_evt = app.store.query_one("SELECT COUNT(*) n FROM outbox WHERE event_type='record.approved' AND payload LIKE ?",
                                (f'%{rid}%',))["n"]
    assert (n_appr, n_audit, n_evt) == (1, 1, 1)
    assert len(app.store.get_record(pid, "main", rid)["approval_ids"]) == 1


@pytest.mark.xfail(strict=True, reason="NEW-fault-15: review/approve checks `versions` against the head, but "
                                       "BookPath.a_approve then approves whatever is latest: a revision saved by another "
                                       "tab in between is approved although the author never saw it")
def test_approve_never_approves_a_version_the_author_did_not_see(served, monkeypatch):
    app, port = served
    pid = app.engine.bootstrap_project("author", "Tabs")
    r = dispatch(port, pid, "A01", "CREATE", {"concept": "Mara"})
    ref, data = r["output_refs"][0], r["result"]
    real_bp = app.review.bp

    def bp(principal, p, b):  # the other tab's edit lands right after the version check
        dispatch(port, pid, "A01", "UPDATE", dict(data, concept="Changed in the other tab"), base_ref=ref)
        monkeypatch.setattr(app.review, "bp", real_bp)
        return real_bp(principal, p, b)
    monkeypatch.setattr(app.review, "bp", bp)
    st, out = call(port, "POST", f"/api/projects/{pid}/branches/main/review/approve",
                   {"record_ids": [ref["record_id"]], "versions": {ref["record_id"]: 1}, "author_confirms": True})
    assert st == 200
    head = app.store.get_record(pid, "main", ref["record_id"])
    assert head["version"] == 2
    assert head["approved_version"] in (None, 1), "version 2 was approved without the author seeing it"


# ---------------------------------------------------------------------------------------------- export vs edits
def test_export_while_a_chapter_is_being_edited_uses_the_approved_text(tmp_path):
    app = make_app(tmp_path / "data")
    run = made_book(app)
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    chapters = [c["approved"] for c in {s["id"]: s for s in bp.status()["steps"]}["chapters"]["chapters"]]
    first = app.store.get_record(pid, "main", chapters[0]["record_id"], chapters[0]["version"])
    marker = "ZZEDITEDWHILEEXPORTINGZZ"
    stop = threading.Event()
    errors = []

    def editor():
        from bookforge.requests import build_request
        base = first
        while not stop.is_set():
            r = app.engine.dispatch(build_request(project_id=pid, branch_id="main", op_id="C02", action="UPDATE",
                                                  principal_id="author", base_ref=base["ref"],
                                                  payload=dict(base["data"], text=base["data"]["text"] + " " + marker)),
                                    "author")
            if r["status"] != "DRAFT":
                errors.append(codes(r))
                return
            base = app.store.get_record(pid, "main", r["output_refs"][0]["record_id"])
    t = threading.Thread(target=editor)
    t.start()
    try:
        out = app.book_act("author", pid, "main", "export", {})
    finally:
        stop.set()
        t.join(30)
    assert not errors, errors
    assert out["ok"], out
    for f in {s["id"]: s for s in BookPath(app.engine, "author", pid, "main").status()["steps"]}["export"]["files"]:
        data = app.store.read_binary(app.store.get_record(pid, "main", f["record_id"], f["version"]))
        assert marker.encode() not in data
    assert check_store(app.store.data_dir) == []
    app.store.close()


# ---------------------------------------------------------------------------------------------- restore vs other work
def test_restore_is_refused_while_a_manual_export_is_running(tmp_path, monkeypatch):
    app = make_app(tmp_path / "data")
    empty = app.backups.backup("manual")  # before any book exists
    run = made_book(app)
    pid = run["project_id"]
    from bookforge.modules import set_g
    started, release = threading.Event(), threading.Event()
    real = set_g.render_pdf

    def slow_render(*a, **k):
        started.set()
        release.wait(20)
        return real(*a, **k)
    monkeypatch.setattr(set_g, "render_pdf", slow_render)
    result = {}
    t = threading.Thread(target=lambda: result.update(out=app.book_act("author", pid, "main", "export", {})))
    t.start()
    assert started.wait(20)
    refused = None
    try:
        app.backups.restore(empty["name"], CONFIRM)
    except BookforgeError as exc:
        refused = exc.code
    finally:
        release.set()
        t.join(60)
    orphans = app.store.query_one("SELECT COUNT(*) n FROM records r WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE "
                                  "p.project_id=r.project_id)")["n"]
    assert refused == "VERSION_CONFLICT", f"restore went ahead; {orphans} record(s) now belong to no project"
    app.store.close()


def test_restore_is_refused_while_make_a_book_runs(tmp_path):
    app = make_app(tmp_path / "data")
    b = app.backups.backup("manual")
    app.engine.providers.test_adapter.gate = threading.Event()
    r = app.autobook.start("author", {"author_confirms": True})
    try:
        with pytest.raises(BookforgeError) as ei:
            app.backups.restore(b["name"], CONFIRM)
        assert ei.value.code == "VERSION_CONFLICT"
    finally:
        app.engine.providers.test_adapter.gate.set()
        app.autobook.cancel("author", r["id"])
        app.autobook.wait_for(r["id"], 60)
    app.store.close()


@pytest.mark.xfail(strict=True, reason="NEW-fault-18: a paused run whose book was removed by a restore resumes into "
                                       "'The AI did not make a main character' (Try again forever) instead of saying "
                                       "the book no longer exists")
def test_restore_under_a_paused_run_then_resume_reports_a_clear_problem(tmp_path):
    app = make_app(tmp_path / "data")
    b = app.backups.backup("manual")
    fake = app.engine.providers.test_adapter
    fake.gate = threading.Event()
    r = app.autobook.start("author", {"author_confirms": True, "length": "short_story"})
    for _ in range(200):
        if app.autobook.get(r["id"]).get("project_id"):
            break
        time.sleep(0.02)
    app.autobook.pause("author", r["id"])
    fake.gate.set()
    app.autobook.wait_for(r["id"], 60)
    assert app.autobook.get(r["id"])["status"] == "paused"
    app.backups.restore(b["name"], CONFIRM)  # the run's book is gone now (allowed: the run is paused)
    run = app.autobook.get(r["id"])
    if run is not None and run["status"] not in ("done", "cancelled"):
        app.autobook.resume("author", r["id"])
        app.autobook.wait_for(r["id"], 60)
        run = app.autobook.get(r["id"])
        assert check_store(app.store.data_dir) == []
        assert app.store.project(run["project_id"]) is None
        assert run["status"] in ("paused", "cancelled", "failed")
        msg = (run.get("problem") or {}).get("message") or run.get("phase") or ""
        assert "main character" not in msg and any(w in msg.lower() for w in ("restor", "no longer", "removed",
                                                                               "not found", "missing")), msg
    app.store.close()


# ---------------------------------------------------------------------------------------------- BookPath memory
@pytest.mark.xfail(strict=True, reason="NEW-fault-17: BookPath keeps book_path:<pid>:<branch> as one settings blob read "
                                       "at construction and written back whole (no CAS): two book actions at the same "
                                       "time (two tabs, or Write-all + a manual step) silently drop each other's state")
def test_two_book_actions_at_once_keep_both_results(tmp_path):
    app = make_app(tmp_path / "data")
    pid = made_book(app)["project_id"]
    tab_a = BookPath(app.engine, "author", pid, "main")  # both requests load the memory first
    tab_b = BookPath(app.engine, "author", pid, "main")
    tab_a.a_check({})
    new_check = app.store.get_setting(tab_a.key)["check"]["H05"]
    tab_b.a_export({})
    new_exports = app.store.get_setting(tab_b.key)["exports"]
    mem = app.store.get_setting(tab_a.key)
    assert mem["exports"] == new_exports
    assert mem["check"]["H05"] == new_check, "the check made by the other tab was lost"
    app.store.close()
