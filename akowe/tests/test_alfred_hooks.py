"""🎩 The two small, additive hooks AutoInjector's assistant (Alfred) uses: a journal note for an action he
did (codes and titles only) and an optional author's note on "Ask AI to fix it" (a chapter rewrite with a note)."""
from __future__ import annotations

import json

from akowe import journal
from test_review import FakeAI, b01, use_fake, wait  # noqa: F401
from test_review import rv  # noqa: F401  (fixture)
from test_server import call, server  # noqa: F401


def test_journal_note_over_http_codes_and_titles_only(server):  # noqa: F811
    app, port = server
    status, proj, _ = call(port, "POST", "/api/projects", {"name": "Alfred Book"})
    assert status == 201
    pid = proj["project_id"]
    base = f"/api/projects/{pid}/branches/main/journal"
    status, out, _ = call(port, "POST", f"{base}/note", {"source": "alfred", "code": "edit_profile", "title": "Edit book profile"})
    assert status == 201 and out["ok"] and out["event_id"]
    status, j, _ = call(port, "GET", base)
    assert status == 200
    notes = [e for e in j["entries"] if e["kind"] == "assistant"]
    assert len(notes) == 1 and notes[0]["what"] == "Alfred: Edit book profile" and notes[0]["who"].startswith("Alfred")
    status, md, _ = call(port, "GET", f"{base}?format=md")
    assert status == 200 and "🎩 Alfred: Edit book profile" in md.decode()
    # only codes and titles: anything else is refused, nothing stored
    for bad in ({"source": "someone", "code": "x", "title": "t"}, {"source": "alfred", "code": "Bad Code!", "title": "t"},
                {"source": "alfred", "code": "ok", "title": "x" * 161}, {"source": "alfred", "code": "ok", "title": ""}):
        assert call(port, "POST", f"{base}/note", bad)[0] == 400
    assert len([e for e in call(port, "GET", base)[1]["entries"] if e["kind"] == "assistant"]) == 1
    # the token is required like everywhere else
    assert call(port, "POST", f"{base}/note", {"source": "alfred", "code": "x", "title": "t"}, token=None)[0] == 401


def test_fix_with_an_author_note_reaches_the_ai(h, rv):  # noqa: F811
    fake = use_fake(h, "REVISE")
    p = b01(h)
    wait(rv, h.principal, rv.start_review(h.principal, h.project_id, "main", {"record_ids": [p["record_id"]]}))
    j = wait(rv, h.principal, rv.start_fix(h.principal, h.project_id, "main",
                                          {"record_id": p["record_id"], "note": "Make the harbor fog thicker."}))
    assert j["status"] == "done", j
    sent = fake.calls[-1]
    assert "Make the harbor fog thicker." in json.dumps(sent["user"]) and "author_note" in sent["system"] + json.dumps(sent["user"])
    hist = h.store.history(h.project_id, "main", p["record_id"])
    assert hist[-1]["version"] == 2 and hist[-1]["lifecycle"] == "DRAFT"  # it waits for approval: nothing approved


def test_fix_note_is_checked(h, rv):  # noqa: F811
    use_fake(h, "REVISE")
    p = b01(h)
    import pytest  # noqa: PLC0415
    from akowe.errors import AkoweError  # noqa: PLC0415
    with pytest.raises(AkoweError):
        rv.start_fix(h.principal, h.project_id, "main", {"record_id": p["record_id"], "note": "x" * 1001})
    with pytest.raises(AkoweError):
        rv.start_fix(h.principal, h.project_id, "main", {"record_id": p["record_id"], "note": 5})


def test_journal_build_shows_note(h):
    journal.add_note(h.store, h.project_id, "main", {"source": "alfred", "code": "save_book", "title": "Save the book"})
    j = journal.build(type("A", (), {"store": h.store, "engine": h.engine, "jobstore": type("J", (), {"list": staticmethod(lambda **k: [])})()})(),
                      h.project_id, "main")
    assert any(e["kind"] == "assistant" and e["what"] == "Alfred: Save the book" for e in j["entries"])
