"""System clock jumps (fault campaign): backups and the book journal order things by wall-clock text stamps."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

import akowe.store as store_mod
from akowe import journal
from akowe.requests import build_request
from akowe.server import App

from fault_helpers import TOKEN

CONFIRM = {"author_confirms": True, "confirm": "RESTORE"}


@pytest.fixture
def app(tmp_path):
    a = App(tmp_path / "data", token=TOKEN)
    a.engine.providers.secret_path = tmp_path / "secrets.json"
    a.engine.bootstrap_project("author", "Clock book")
    yield a
    a.store.close()


def clock_back(monkeypatch, days=1):
    """utcnow() as it reads after the system clock was set back (e.g. a wrong clock corrected, VM restored)."""
    shifted = lambda: (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")  # noqa
    monkeypatch.setattr(store_mod, "utcnow", shifted)


def test_backup_made_after_the_clock_went_back_is_kept(app, monkeypatch):
    app.backups.set_keep(3)
    for _ in range(3):
        app.backups.backup("manual")
    clock_back(monkeypatch)
    b = app.backups.backup("manual")
    names = [x["name"] for x in app.backups.list()]
    assert b["name"] in names and (app.backups.dir / b["name"] / "manifest.json").exists()


def test_restore_safety_copy_survives_a_clock_jump(app, monkeypatch):
    app.backups.set_keep(3)
    first = [app.backups.backup("manual") for _ in range(3)]
    clock_back(monkeypatch)
    out = app.backups.restore(first[-1]["name"], CONFIRM)
    assert (app.backups.dir / out["safety_backup"] / "manifest.json").exists()


def test_daily_backup_after_the_clock_went_forward_then_back(app, monkeypatch):
    fwd = lambda: (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")  # noqa
    monkeypatch.setattr(store_mod, "utcnow", fwd)
    app.backups.backup("manual")  # made while the clock was 3 days ahead
    monkeypatch.undo()
    assert app.backups.daily_if_needed() is not None


def _create(app, pid, concept):
    r = app.engine.dispatch(build_request(project_id=pid, branch_id="main", op_id="A01", action="CREATE",
                                          principal_id="author", payload={"concept": concept}), "author")
    assert r["status"] == "DRAFT", r
    return r["output_refs"][0]


def test_journal_keeps_happened_before_order_across_a_clock_jump(app, monkeypatch):
    pid = app.store.query_one("SELECT project_id FROM projects")["project_id"]
    first = _create(app, pid, "Made first")
    clock_back(monkeypatch, days=0.01)  # about 15 minutes back
    second = _create(app, pid, "Made second")
    j = journal.build(app, pid, "main")
    order = [e.get("record_id") for e in j["entries"] if e.get("record_id") in (first["record_id"], second["record_id"])]
    assert order == [first["record_id"], second["record_id"]], order


def test_journal_orders_run_events_and_steps_within_one_second(app, monkeypatch):
    pid = app.store.query_one("SELECT project_id FROM projects")["project_id"]
    app.jobstore.save({"id": "run-clock", "kind": "autobook", "project_id": pid, "branch_id": "main",
                       "status": "done", "steps": [{"id": "backup", "op": None}],
                       "events": [{"at": "2026-10-23T10:00:05Z", "kind": "backup", "step": "backup",
                                   "message": "Backup saved"}]})
    monkeypatch.setattr(store_mod, "utcnow", lambda: "2026-10-23T10:00:05.300000Z")  # 0.3 s after the event
    ref = _create(app, pid, "After the backup")
    j = journal.build(app, pid, "main")
    kinds = [("backup" if e["kind"] == "backup" else e.get("record_id")) for e in j["entries"]
             if e["kind"] == "backup" or e.get("record_id") == ref["record_id"]]
    assert kinds == ["backup", ref["record_id"]], kinds
