"""Regression tests for the review2 / acceptance fixes in the BookForge core that the pinned verify tests do not
fully cover: an approved chapter's waiting revision (ACCEPT-4), retitle renames the book (ACCEPT-5), the AI chosen
for the book (ACCEPT-2, pinned slot not set up / Automatic with roles), stuck AMBIGUOUS cost reservations, advice for
out-of-date refusals, and a restore of a backup taken while a run was working."""
from __future__ import annotations

import sys
from datetime import timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "flow"))
import flowkit as fk  # noqa: E402

from bookforge import k_runtime as kr  # noqa: E402
from bookforge.errors import BookforgeError  # noqa: E402
from bookforge.book_path import refusal_advice, save_profile  # noqa: E402

CONFIRM = {"author_confirms": True, "confirm": "RESTORE"}


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    fk.quiet_provider_sleep(monkeypatch)


def steps(app, pid):
    st = fk.bp_of(app, pid).status()
    return st, {s["id"]: s for s in st["steps"]}


# ------------------------------------------------------------------------------------- ACCEPT-4
def test_edited_approved_chapter_waits_for_approval_and_then_makes_the_book_out_of_date(tmp_path):
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    run = fk.run_book(app)
    pid = run["project_id"]
    status, st = steps(app, pid)
    assert status["next"] is None
    old = dict(fk.approved_chapters(app, pid))["ch2"]
    r = fk.bp_of(app, pid).dispatch("C02", "UPDATE", base_ref=old["ref"],
                                    payload=dict(old["data"], text="[ch2/EDIT] A new night on the reef."))
    assert r["status"] == "DRAFT"
    new = r["output_refs"][0]
    # The book page no longer says the book is made: the chapters step shows the waiting revision with Approve.
    status, st = steps(app, pid)
    assert status["next"] == "chapters" and status["done_count"] < status["total"]
    ch2 = next(c for c in st["chapters"]["chapters"] if c["chapter_id"] == "ch2")
    assert ch2["state"] == "needs_you" and ch2["revision_waiting"] is True
    assert ch2["prose"]["version"] == new["version"] and ch2["approved"]["version"] == old["version"]
    assert [i["record_id"] for i in st["chapters"]["approve"]] == [new["record_id"]]
    assert "wait for your approval" in st["chapters"]["about"]
    # the approved book is unchanged until then (the files are still the approved text)
    assert st["assemble"]["state"] == "done" and st["export"]["state"] == "done"
    assert fk.bp_of(app, pid).act("approve", {"record_ids": [new["record_id"]], "author_confirms": True})["ok"]
    status, st = steps(app, pid)
    assert status["next"] == "assemble" and st["chapters"]["state"] == "done"
    assert st["assemble"]["state"] == "ready" and st["assemble"]["action"] == "assemble"
    assert st["assemble"]["out_of_date"]
    assert st["export"]["state"] == "blocked" and all(f["out_of_date"] for f in st["export"]["files"])
    assert st["check"]["state"] != "done"


# ------------------------------------------------------------------------------------- ACCEPT-5
def test_retitle_renames_the_book_and_other_profile_saves_do_not(tmp_path):
    app = fk.make_app(tmp_path)
    pid = app.engine.bootstrap_project("author", "My working name")
    save_profile(app.store, pid, {"title": "First Title", "author": "A"})
    assert app.store.project(pid)["name"] == "My working name"  # the first title does not override a chosen name
    save_profile(app.store, pid, {"tone": "dark"})
    assert app.store.project(pid)["name"] == "My working name"
    save_profile(app.store, pid, {"title": "Second Title"})
    assert app.store.project(pid)["name"] == "Second Title"
    with pytest.raises(BookforgeError):
        save_profile(app.store, pid, {"title": "   "})  # refused: nothing renamed
    assert app.store.project(pid)["name"] == "Second Title"


# ------------------------------------------------------------------------------------- ACCEPT-2
def test_book_pinned_to_an_ai_that_is_not_set_up_says_so(tmp_path):
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    pid = app.engine.bootstrap_project("author", "Pinned")
    save_profile(app.store, pid, {"title": "Pinned", "idea": "a lighthouse keeper", "ai_slot": "AI-3"})
    bp = fk.bp_of(app, pid)
    assert bp.ai_ready() is False  # only AI-1 is set up
    out = bp.act("create", {"op": "B01"})
    assert out.get("needs_manual") and "AI-3" in out["message"] and "Settings" in out["message"]


def test_automatic_follows_the_slot_roles(tmp_path):
    ai = fk.TraceAI()
    used = []
    orig = ai.submit

    def submit(slot, *a, **kw):
        used.append(slot.get("slot_id"))
        return orig(slot, *a, **kw)
    ai.submit = submit
    app = fk.make_app(tmp_path, fake=ai)
    app.engine.providers.configure_slot("AI-2", {"adapter_id": "anthropic", "api_key": "sk-fake-2", "roles": ["B"]})
    pid = app.engine.bootstrap_project("author", "Auto")
    save_profile(app.store, pid, {"title": "Auto", "idea": "a lighthouse keeper", "ai_slot": ""})
    out = fk.bp_of(app, pid).act("create", {"op": "B01"})
    assert out.get("ok"), out
    assert used and set(used) == {"AI-2"}, used


# ------------------------------------------------------------------------------------- risk: AMBIGUOUS reservation
def test_ambiguous_reservation_is_released_after_the_bounded_time(tmp_path, monkeypatch, caplog):
    app = fk.make_app(tmp_path)
    pid = app.engine.bootstrap_project("author", "Ledger")
    kr.configure_quota(app.store, "author", pid, "main", account_id="acct", period="p", limit=100, currency="USD")
    res = kr.reserve(app.store, "author", pid, "main", account_id="acct", period="p", job_id="C02:req:0", amount=80)
    kr.settle(app.store, "author", pid, "main", account_id="acct", period="p",
              reservation_id=res["reservation_id"], actual=0, ambiguous=True)
    # still within the bounded time: the timed-out call may have run, so the cap stays held
    with pytest.raises(BookforgeError) as exc:
        kr.reserve(app.store, "author", pid, "main", account_id="acct", period="p", job_id="C02:req2:0", amount=80)
    assert exc.value.code == "QUOTA_EXCEEDED"
    later = kr.now() + timedelta(seconds=kr.AMBIGUOUS_RELEASE_SECONDS + 5)
    monkeypatch.setattr(kr, "now", lambda: later)
    with caplog.at_level("WARNING", logger="bookforge.k_runtime"):
        res2 = kr.reserve(app.store, "author", pid, "main", account_id="acct", period="p", job_id="C02:req3:0",
                          amount=80)
    assert res2 is not None
    led, _ = kr.get_ledger(app.store, pid, "main", "acct", "p")
    assert led["reserved"] == 80 and led["reservations"][res["reservation_id"]]["state"] == "RELEASED"
    assert any("released AMBIGUOUS reservation" in r.getMessage() for r in caplog.records)


def test_provider_reported_failure_releases_an_ambiguous_reservation(tmp_path):
    app = fk.make_app(tmp_path)
    pid = app.engine.bootstrap_project("author", "Ledger")
    kr.configure_quota(app.store, "author", pid, "main", account_id="acct", period="p", limit=100, currency="USD")
    res = kr.reserve(app.store, "author", pid, "main", account_id="acct", period="p", job_id="j", amount=60)
    kr.settle(app.store, "author", pid, "main", account_id="acct", period="p",
              reservation_id=res["reservation_id"], actual=0, ambiguous=True)
    led = kr.release_ambiguous(app.store, "author", pid, "main", account_id="acct", period="p",
                               reservation_id=res["reservation_id"])
    assert led["reserved"] == 0 and led["spent"] == 0


# ------------------------------------------------------------------------------------- risk: STALE advice
def test_out_of_date_refusal_does_not_say_edit_it(tmp_path):
    assert "Edit it so the checks pass" in refusal_advice(["SCHEMA: bad"], None)
    stale = refusal_advice(["STALE: input pins changed"], {"action": "write_chapter"})
    assert "out of date" in stale and "Edit it so" not in stale and "Approve the current" in stale
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    run = fk.run_book(app)
    pid = run["project_id"]
    old = dict(fk.approved_chapters(app, pid))["ch1"]
    bp = fk.bp_of(app, pid)
    r = bp.dispatch("C02", "UPDATE", base_ref=old["ref"], payload=dict(old["data"], text="[ch1/EDIT] new text"))
    new = r["output_refs"][0]
    with app.store.transaction() as tx:  # what invalidation does when an input it was made from changes
        tx.mark_stale(pid, "main", new["record_id"], new["version"], "the chapter outline changed")
    out = fk.bp_of(app, pid).act("approve", {"record_ids": [new["record_id"]], "author_confirms": True})
    res = out["results"][0]
    assert not res["ok"] and "out of date" in res["fix"] and "Edit it so" not in res["fix"], res


# ------------------------------------------------------------------------------------- risk: restore mid-run
def test_restoring_a_backup_taken_mid_run_shows_the_run_interrupted(tmp_path):
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    run = {"id": "run-restoretest1", "kind": "autobook", "status": "running", "principal": "author",
           "project_id": None, "branch_id": "main", "phase": "Write every chapter…", "steps": [], "events": []}
    app.jobstore.save(run)
    b = app.backups.backup("manual")
    app.jobstore.save(dict(run, status="done", phase="Your book is made"))
    app.autobook._cache[run["id"]] = dict(run, status="done")
    app.backups.restore(b["name"], CONFIRM)
    got = app.autobook.get(run["id"])
    assert got["status"] == "interrupted" and "restored from a backup" in got["phase"]
    assert app.jobstore.get(run["id"])["status"] == "interrupted"
