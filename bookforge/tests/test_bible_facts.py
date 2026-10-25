"""The book bible carries the P31 trade-facts list (with the author's ✔/✕ decisions and the story year) and the P30
repeat labels, and a 🔁 rerun from the bible starts with them instead of an empty list."""
from __future__ import annotations

from bookforge import book_bible, repetition, terms

from test_section6 import new_app, run_book


def test_bible_round_trip_and_rerun_keeps_terms_and_labels(tmp_path):
    app, _fake = new_app(tmp_path)
    run = run_book(app)
    pid = run["project_id"]
    app.store.set_setting(f"trade_terms:{pid}:main", None)
    terms.seed_from_bible(app.store, pid, "main", [
        {"term": "wick-key", "status": "wrong", "use_instead": "gas cock key", "note": "gas lamps have no wick",
         "verified": {"by": "author", "at": "2026-10-25T00:00:00Z"}},
        {"term": "pressure gauge", "status": "research_needed"}], story_year=1887)
    repetition.save_labels(app.store, pid, "main", {"Right, so": "voice", "thirty-two, thirty-three": "motif"})

    src = book_bible.build(app, pid, "main")
    assert src["trade_terms"]["story_year"] == 1887 and len(src["trade_terms"]["items"]) == 2
    assert src["repeat_labels"] == {repetition.norm_phrase("Right, so"): "voice",
                                    repetition.norm_phrase("thirty-two, thirty-three"): "motif"}
    md = book_bible.render_markdown(src)
    assert "## Trade and period terms (2) — story year 1887" in md and "gas cock key" in md
    assert "## Repeat labels (2)" in md
    again = book_bible.clean(src)  # what a saved book-bible.json reads back as
    assert again["trade_terms"] == src["trade_terms"] or \
        [i["term"] for i in again["trade_terms"]["items"]] == ["wick-key", "pressure gauge"]
    assert book_bible.summary(again)["trade_terms"] == 2 and book_bible.summary(again)["repeat_labels"] == 2

    r = app.autobook.start("author", {"author_confirms": True, "from_bible": {"project_id": pid}, "reuse_plan": True})
    app.autobook.wait_for(r["id"], 240)
    run2 = app.autobook.get(r["id"])
    assert run2["status"] == "done", run2.get("problem")
    new = run2["project_id"]
    e = terms.get_entry(app.store, new, "main")
    by = {i["term"]: i for i in e["items"]}
    assert e["story_year"] == 1887
    assert by["wick-key"]["status"] == "wrong" and by["wick-key"]["use_instead"] == "gas cock key"
    assert by["pressure gauge"]["status"] == "research_needed"
    assert repetition.get_labels(app.store, new, "main")["labels"][repetition.norm_phrase("Right, so")] == "voice"
    assert any("trade term" in ev["message"] for ev in run2["events"] if ev.get("kind") == "bible")


def test_bad_bible_values_are_dropped_not_fatal():
    b = book_bible.clean({"kind": book_bible.KIND, "schema_version": 1, "profile": {"title": "X"},
                          "trade_terms": {"story_year": "soon", "items": [{"term": "ok term"}, "junk", {"term": ""}]},
                          "repeat_labels": {"fine phrase here": "voice", "bad": "nonsense", 5: "voice"}})
    assert b["trade_terms"]["story_year"] is None and [i["term"] for i in b["trade_terms"]["items"]] == ["ok term"]
    assert b["repeat_labels"] == {repetition.norm_phrase("fine phrase here"): "voice"}


def test_seed_never_replaces_an_existing_list(tmp_path):
    app, _fake = new_app(tmp_path)
    pid = run_book(app)["project_id"]
    terms.seed_from_bible(app.store, pid, "main", [{"term": "first term"}])
    before = terms.get_entry(app.store, pid, "main")
    terms.seed_from_bible(app.store, pid, "main", [{"term": "other term"}])
    assert terms.get_entry(app.store, pid, "main")["items"] == before["items"]
