"""Round-2 review: a book pinned to one AI (wizard / profile ai_slot) whose AI is momentarily busy.

With two AIs set up and the book pinned to AI-1, a step that finds AI-1 busy (another book, a review, ...) gets
CAPABILITY_UNAVAILABLE from PinnedProviders.eligible; _Runner.ai_create only treats that as "busy, wait and retry"
when EVERY slot is busy (_slots_busy ignores the pin), so it pauses at once with "No AI is ready ... connect
AutoInjector" instead of waiting for AI-1 (before round 2 the book page/Write-all used the shared engine and
simply went to AI-2)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "flow"))
import flowkit as fk  # noqa: E402

from bookforge.autobook import StepProblem  # noqa: E402
from bookforge.book_path import save_profile  # noqa: E402
from bookforge.errors import BookforgeError  # noqa: E402


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    fk.quiet_provider_sleep(monkeypatch)


def test_pinned_busy_slot_waits_instead_of_saying_no_ai(tmp_path):
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    app.engine.providers.configure_slot("AI-2", {"adapter_id": "anthropic", "api_key": "sk-fake-2"})
    pid = app.engine.bootstrap_project("author", "Pinned busy")
    save_profile(app.store, pid, {"title": "Pinned busy", "idea": "a lighthouse keeper", "ai_slot": "AI-1"})
    bp = fk.bp_of(app, pid)
    prov = app.engine.providers
    slot = next(s for s in prov.slots() if s["slot_id"] == "AI-1")
    with prov._lock:
        prov._active["AI-1"] += slot["max_concurrent"]  # AI-1 is answering something else right now
    job = {"id": "wall-pinbusy", "kind": "write_all", "status": "running", "principal": "author",
           "project_id": pid, "branch_id": "main", "settings": {}, "events": [], "items": []}
    app.write_all.save(job)
    try:
        app.write_all.ai_create(job, bp, "B01", bp.payload_for("B01"), "premise")
        outcome = "made"
    except StepProblem as exc:
        outcome = exc.problem.get("code") if hasattr(exc, "problem") else str(exc)
    except BookforgeError as exc:
        outcome = exc.code  # a busy code after the (fast) retry budget = it waited, as for an unpinned book
    finally:
        with prov._lock:
            prov._active["AI-1"] -= slot["max_concurrent"]
    assert outcome in ("RATE_LIMITED", "UPSTREAM_UNAVAILABLE"), (
        f"pinned AI-1 busy -> {outcome!r}: the step stops with 'No AI is ready' instead of waiting for AI-1")


def test_control_automatic_book_uses_the_other_ai(tmp_path):
    app = fk.make_app(tmp_path, fake=fk.TraceAI())
    app.engine.providers.configure_slot("AI-2", {"adapter_id": "anthropic", "api_key": "sk-fake-2"})
    pid = app.engine.bootstrap_project("author", "Auto busy")
    save_profile(app.store, pid, {"title": "Auto busy", "idea": "a lighthouse keeper", "ai_slot": ""})
    bp = fk.bp_of(app, pid)
    prov = app.engine.providers
    slot = next(s for s in prov.slots() if s["slot_id"] == "AI-1")
    with prov._lock:
        prov._active["AI-1"] += slot["max_concurrent"]
    job = {"id": "wall-autobusy", "kind": "write_all", "status": "running", "principal": "author",
           "project_id": pid, "branch_id": "main", "settings": {}, "events": [], "items": []}
    app.write_all.save(job)
    try:
        ref = app.write_all.ai_create(job, bp, "B01", bp.payload_for("B01"), "premise")
    finally:
        with prov._lock:
            prov._active["AI-1"] -= slot["max_concurrent"]
    assert ref["record_id"]
