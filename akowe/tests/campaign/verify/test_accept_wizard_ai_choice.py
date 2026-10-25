"""ACCEPT-2 (found by the acceptance run): the 🚀 wizard asks "Which AI should help?" and stores the answer in the book
profile (ai_slot = AI-1/AI-2/AI-3). Only the wizard's Bible Builder session uses it; every "Make my book" step
(premise, plot, outline, chapters) is sent to the automatically chosen slot instead. In the acceptance run the author
picked "AI-2 · ChatGPT"; ChatGPT got the one character request, Claude (AI-1) wrote the premise, plot and outline."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "flow"))
import flowkit as fk  # noqa: E402

from bookforge.book_path import save_profile  # noqa: E402


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    fk.quiet_provider_sleep(monkeypatch)


def test_make_my_book_steps_use_the_ai_chosen_in_the_wizard(tmp_path):
    ai = fk.TraceAI()
    used = []
    orig = ai.submit

    def submit(slot, *a, **kw):
        used.append(slot.get("slot_id"))
        return orig(slot, *a, **kw)
    ai.submit = submit
    app = fk.make_app(tmp_path, fake=ai)
    app.engine.providers.configure_slot("AI-2", {"adapter_id": "anthropic", "api_key": "sk-fake-flow-key-2"})
    from http.server import ThreadingHTTPServer  # noqa: PLC0415
    import threading  # noqa: PLC0415
    from bookforge.server import make_handler  # noqa: PLC0415
    from test_server import call  # noqa: PLC0415
    from autobook_fake import fact  # noqa: PLC0415
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        st, proj, _ = call(httpd.server_address[1], "POST", "/api/projects", {   # what the wizard's "Create my book" sends
            "name": "Chosen AI", "release_profiles": ["MANUSCRIPT_PDF", "EPUB_REFLOWABLE", "EDITABLE_DOCX"],
            "profile": {"title": "Chosen AI", "author": "Ann", "length": "short_story", "idea": "x y z",
                        "ai_slot": "AI-2"}}, token=fk.TOKEN)
    finally:
        httpd.shutdown()
    assert st in (200, 201), proj
    pid = proj["project_id"]
    bp = fk.bp_of(app, pid)
    ref, _ = bp.create("A01", {"concept": "Mara Vell"}, manual_candidate={
        "concept": "Mara Vell", "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
        "facts": [fact("mara-vell", "entity.name", "Mara Vell")]})
    assert bp.act("approve", {"record_ids": [ref["record_id"]], "author_confirms": True})["ok"]
    used.clear()
    out = fk.bp_of(app, pid).act("create", {"op": "B01"})   # "✨ Let my AI draft it" on the premise step
    assert out.get("ok"), out
    assert used and set(used) == {"AI-2"}, f"the author chose AI-2 in the wizard; the premise was written by {used}"
