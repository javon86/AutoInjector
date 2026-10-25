"""Archive / delete follow-ups: an archived book stays reachable on the Shelf (its downloads live there), and the
Bible Builder reports of a deleted book no longer carry its name."""
from __future__ import annotations

import json

import pytest

from bookforge.server import App

TOKEN = "archive-token-0123456789"


@pytest.fixture
def app(tmp_path):
    a = App(tmp_path / "data", token=TOKEN)
    a.engine.providers.secret_path = tmp_path / "secrets.json"
    yield a
    a.store.close()


def _exported(app, name):
    pid = app.engine.bootstrap_project("author", name)
    app.store.set_setting(f"book_path:{pid}:main", {"exports": {"MANUSCRIPT_PDF": {"descriptor": {}}}})
    return pid


def test_archived_books_are_listed_under_archived_on_the_shelf(app):
    keep, hide = _exported(app, "On the shelf"), _exported(app, "Put away")
    st, out = app.route("POST", f"/api/projects/{hide}/archive", {}, {"archived": True}, "author", {})
    assert st == 200 and out["archived"] is True
    st, shelf = app.route("GET", "/api/shelf", {}, None, "author", {})
    assert st == 200
    assert [b["project_id"] for b in shelf["books"]] == [keep]
    assert [b["project_id"] for b in shelf["archived"]] == [hide]
    assert shelf["archived"][0]["archived"] is True and shelf["archived"][0]["files"]
    app.route("POST", f"/api/projects/{hide}/archive", {}, {"archived": False}, "author", {})
    st, shelf = app.route("GET", "/api/shelf", {}, None, "author", {})
    assert sorted(b["project_id"] for b in shelf["books"]) == sorted([keep, hide]) and shelf["archived"] == []


def test_bible_builder_reports_of_a_deleted_book_drop_its_name(app):
    pid = app.engine.bootstrap_project("author", "Secret Title ZZNAME")
    other = app.engine.bootstrap_project("author", "Still here")
    s = app.assist.create_bible("author", {"project_id": pid, "branch_id": "main", "idea": "x"})
    md, js = app.assist.bible_report("author", s["session_id"])
    s2 = app.assist.create_bible("author", {"project_id": other, "branch_id": "main", "idea": "y"})
    md2, js2 = app.assist.bible_report("author", s2["session_id"])
    assert "ZZNAME" in md.read_text()
    st, _ = app.route("POST", f"/api/projects/{pid}/delete", {}, {"author_confirms": True,
                                                                   "confirm": "Secret Title ZZNAME"}, "author", {})
    assert st == 200
    assert "ZZNAME" not in md.read_text() and "ZZNAME" not in js.read_text()
    assert "deleted" in md.read_text()
    assert json.loads(js.read_text())["project"] == {"project_id": pid, "name": None, "deleted": True}
    assert "Still here" in md2.read_text()  # other books' reports are untouched
    with pytest.raises(Exception):
        app.assist.get_bible("author", s["session_id"])  # its session is gone too
