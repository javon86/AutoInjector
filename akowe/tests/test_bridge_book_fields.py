"""Every AutoInjector bridge request says which book (``book_id``) and ⚡ run (``run_id``) it is for — ids only.

AutoInjector starts a NEW book in a fresh chat in each AI window, so nothing from the last book can slip into it (a
user's run "invented" a pen name that was a character from their other book, still in that chat). The same book keeps
its chat."""
from __future__ import annotations

from akowe import ai_activity
from akowe import providers as prov

from test_autoinjector_adapter import FakeBridge, b01, connect  # noqa: F401  (fixtures below)

import pytest


@pytest.fixture
def bridge():
    b = FakeBridge()
    yield b
    b.close()


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(prov.time, "sleep", lambda s: None)


def test_request_names_the_book(h, bridge):
    connect(h, bridge.url)
    r = b01(h)
    assert r["status"] == "DRAFT", r
    sent = bridge.sends[0]
    assert sent["book_id"] == h.project_id
    assert "run_id" not in sent  # not a ⚡ run


def test_make_a_book_run_names_book_and_run(h, bridge):
    connect(h, bridge.url)
    with ai_activity.doing("Inventing the book", run_id="run-abc123", book_id=h.project_id):
        b01(h)
    sent = bridge.sends[0]
    assert sent["book_id"] == h.project_id and sent["run_id"] == "run-abc123"


def test_only_ids_are_sent():
    with ai_activity.doing(None, run_id="run-1", book_id="The Glass Road"):
        assert prov.bridge_book_fields() == {"run_id": "run-1"}
    assert prov.bridge_book_fields() == {}
