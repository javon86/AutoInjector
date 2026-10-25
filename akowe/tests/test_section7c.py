"""Section 7 (part c) of the improvement plan: P23 the beta reader and P25 the author's own writing style.

P23: the persona from the book profile, the reader's answer cleaned (quotes checked against the book and against the
named chapter, chapters out of range dropped), findings without AI (lost, flat stretch, twists guessed early, would
stop, unverified quotes), the optional ⚡ run step (skipped unless asked for; never blocks the book), the 📖 job and the
HTTP API. P25: the numbers of the style card, sample limits, the AI summary (quotes verified), the book snapshot, the
writing brief and the editor's context, the ⚡ run setting and the HTTP API. All on the deterministic fake AI.
"""
from __future__ import annotations

import time
from collections import Counter

import pytest

from akowe import beta_reader as beta
from akowe import chapter_brief
from akowe import style_card as sc
from akowe.errors import AkoweError

from test_failover_review import SlotFake, make_app, run_book

CHAPTERS = [
    {"number": 1, "text": "# One\n\nThe fog rolled in over Gullhaven before dawn. Mara climbed the steps."},
    {"number": 2, "text": "# Two\n\nDown in the harbor the boats knocked together like restless teeth."},
    {"number": 3, "text": "# Three\n\nAt low tide the reef rose out of the water like a sleeping spine."},
]

SAMPLE = ("I burned the toast again this morning. Of course I did. The kitchen smelled of smoke and of the rain that "
          "had come in under the door; my mother would have said something about it, and I was glad she couldn't. "
          "\n\nI didn't open the window. I stood there with the knife in my hand and listened to the kettle, which "
          "was the only thing in the house that still did what it was told. Outside, the street was grey and slick "
          "and nobody was out. \"You'll be late,\" said the radio, or something like it. I ate the toast anyway. "
          "\n\nThe bus was late too, which helped. It came round the corner with its lights on in the middle of the "
          "day, the way buses do when they have given up on the weather. I sat at the back and watched the town go "
          "past, the bakery, the bank, the shop that sells nothing anyone needs. It was a Tuesday. It felt like one. "
          ) * 2


# ====================================================================== P23 pure parts
def test_persona_comes_from_the_profile():
    p = beta.persona({"audience": "Young adult (12-18)", "genre": "Mystery", "tone": "Eerie"})
    assert p["key"] == "young_adult" and "mystery" in p["label"]
    assert "Young adult (12-18)" in p["text"] and "eerie" in p["text"]
    assert beta.persona({})["key"] == "adult"


def test_clean_checks_quotes_and_chapters():
    raw = {"reactions": [
        {"chapter": 1, "kind": "confused", "quote": "The fog rolled in over Gullhaven", "note": "who?"},
        {"chapter": 2, "kind": "bored", "quote": "The fog rolled in over Gullhaven", "note": "wrong chapter"},
        {"chapter": 9, "kind": "bored", "quote": "x", "note": "out of range"},
        {"chapter": 3, "kind": "unknown", "quote": "x", "note": "bad kind"},
        {"chapter": 3, "kind": "doubted", "quote": "a line the reader invented here", "note": "?"}],
        "interest": [{"chapter": 1, "score": 9, "would_keep_reading": True}, {"chapter": 2, "score": 11},
                     {"chapter": 3, "score": 4, "would_keep_reading": False}],
        "guesses": [{"guess": "the reef hides it", "guessed_in_chapter": 1, "quote": "Mara climbed the steps",
                     "revealed_in_chapter": 3, "came_true": "yes"}],
        "stop": {"would_finish": False, "chapter": 3, "why": "slow"}, "summary": "ok"}
    c = beta.clean(raw, CHAPTERS)
    assert [(r["chapter"], r["kind"], r["verified"], r["in_chapter"]) for r in c["reactions"]] == [
        (1, "confused", True, True), (2, "bored", True, False), (3, "doubted", False, False)]
    assert [i["chapter"] for i in c["interest"]] == [1, 3]  # a score of 11 is dropped
    assert c["guesses"][0]["verified"] and c["stop"] == {"would_finish": False, "chapter": 3, "why": "slow"}
    fs = {f["id"]: f for f in beta.findings(c, 3)}
    assert fs["confused"]["chapters"] == [1]
    assert fs["flat"]["chapters"] == [2, 3]  # bored (verified) in 2, interest 4 in 3
    assert fs["guessed"]["severity"] == "major" and "chapter 1" in fs["guessed"]["detail"]
    assert fs["stop"]["severity"] == "major" and fs["unverified"]["severity"] == "info"


def test_flat_stretch_needs_two_low_chapters_in_a_row():
    read = {"reactions": [], "guesses": [], "stop": {"would_finish": True, "chapter": 0, "why": ""},
            "interest": [{"chapter": 1, "score": 5}, {"chapter": 2, "score": 8}, {"chapter": 3, "score": 4},
                         {"chapter": 4, "score": 3}]}
    fs = {f["id"]: f for f in beta.findings(read, 4)}
    assert fs["flat"]["chapters"] == [3, 4] and fs["flat"]["severity"] == "major"
    read["interest"][3]["score"] = 8
    assert "flat" not in {f["id"] for f in beta.findings(read, 4)}


# ====================================================================== P23 in a run and on the report page
def test_beta_step_is_skipped_unless_asked(tmp_path):
    app = make_app(tmp_path, SlotFake())
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    st = next(s for s in run["steps"] if s["id"] == "beta")
    assert st["state"] == "done" and st["message"] == "Not asked for in this run"
    assert not beta.service_of(app).latest(run["project_id"], "main")
    assert "beta" not in Counter(app.engine.providers.test_adapter.kinds)


def test_beta_reader_in_a_run(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1", "beta_reader": True})
    assert run["status"] == "done", run.get("problem")
    st = next(s for s in run["steps"] if s["id"] == "beta")
    assert st["state"] == "done" and "read it as" in st["message"]
    r = beta.service_of(app).latest(run["project_id"], "main")
    assert r["status"] == "done" and r["made_by"] == "run" and r["run_id"] == run["id"]
    assert r["reader"]["slot"] != "AI-1" and r["reader"]["independent"]  # not the writer
    assert r["counts"]["confused"] == 1 and r["counts"]["unverified"] == 1
    ids = {f["id"] for f in r["findings"]}
    assert {"confused", "guessed", "unverified"} <= ids
    # the reader never sees the plan: no outline, rules or scene cards in its context
    ctx = fake.prompts["beta"][0][1]
    assert set(ctx) == {"book", "reader", "chapters"}
    assert run["beta"]["id"] == r["id"]


def test_beta_failure_never_blocks_the_book(tmp_path):
    fake = SlotFake()
    fake.fail_kind("beta", AkoweError("INVALID_INPUT", "/x", "bad answer"))
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1", "beta_reader": True})
    assert run["status"] == "done", run.get("problem")
    st = next(s for s in run["steps"] if s["id"] == "beta")
    assert st["state"] == "done" and st["message"].startswith("⚠️")
    assert any(e.get("code") == "BETA_FAILED" for e in run["events"])


def test_beta_reader_api_and_job(tmp_path):
    app = make_app(tmp_path, SlotFake())
    run = run_book(app, {"slot_id": "AI-1"})
    pid = run["project_id"]
    base = f"/api/projects/{pid}/branches/main/beta"
    code, ov = app.route("GET", base, {}, None, "author", {})
    assert code == 200 and ov["latest"] is None and ov["written"] >= 1 and ov["readers"]
    code, job = app.route("POST", base, {}, {"slot_id": "AI-3"}, "author", {})
    assert code == 202
    for _ in range(400):
        code, j = app.route("GET", f"{base}/job/{job['id']}", {}, None, "author", {})
        if j["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert j["status"] == "done", j
    code, ov = app.route("GET", base, {}, None, "author", {})
    assert ov["latest"]["id"] == j["read_id"] and ov["latest"]["reader"]["slot"] == "AI-3"
    assert not ov["stale"]
    with pytest.raises(AkoweError):
        app.route("POST", base, {}, {"slot_id": 5}, "author", {})


# ====================================================================== P25 pure parts
def test_style_numbers():
    st = sc.stats([SAMPLE])
    assert st["person"] == "first" and st["tense"] == "past"
    assert st["words"] > 150 and 5 < st["avg_sentence"] < 25
    assert st["contractions_per_1000"] > 0 and st["semicolons_per_1000"] > 0
    assert st["dialogue_share"] > 0 and "toast" in st["signature_words"]
    words = " ".join(sc.describe(st))
    assert "first person, past tense" in words
    third = sc.stats(["He walked to the door. She is waiting there. They are all waiting. " * 20])
    assert third["person"] == "third" and third["tense"] == "present"


def test_sample_limits():
    with pytest.raises(AkoweError):
        sc.clean_samples([])
    with pytest.raises(AkoweError):
        sc.clean_samples(["Too short to learn from."])
    with pytest.raises(AkoweError):
        sc.clean_samples([{"text": "x" * (sc.MAX_SAMPLE_CHARS + 1)}])
    with pytest.raises(AkoweError):
        sc.clean_samples([SAMPLE] * (sc.MAX_SAMPLES + 1))
    out = sc.clean_samples([{"name": "Diary", "text": SAMPLE}, "  ", SAMPLE])
    assert [s["name"] for s in out] == ["Diary", "Sample 2"]


def test_brief_is_bounded_and_ai_quotes_checked():
    ai = sc.clean_ai({"voice_summary": "v", "do": ["a"] * 9, "avoid": ["b"],
                      "example_moves": [{"quote": "I burned the toast again", "move": "dry"},
                                        {"quote": "not in there at all", "move": "made up"}]},
                     sc._norm(SAMPLE))
    assert len(ai["do"]) == 6 and [m["verified"] for m in ai["example_moves"]] == [True, False]
    b = sc.brief_of({"stats": sc.stats([SAMPLE]), "ai": ai})
    assert b["moves"] == ["dry"] and b["numbers"]["person"] == "first"
    big = dict(ai, voice_summary="w " * 400, rhythm="r " * 200, diction="d " * 200, imagery="i " * 200)
    import json
    assert len(json.dumps(sc.brief_of({"stats": sc.stats([SAMPLE]), "ai": big}), ensure_ascii=False)) <= \
        sc.BRIEF_MAX + 1000
    assert sc.brief_of(None) is None and sc.brief_of({"stats": {"words": 0}}) is None


# ====================================================================== P25 API, the brief, the editor and a run
def _learn(app):
    code, out = app.route("PUT", "/api/style-card", {}, {"samples": [{"name": "Diary", "text": SAMPLE}]}, "author", {})
    assert code == 200 and out["card"]["stats"]["person"] == "first" and out["card"]["ai"] is None
    code, out = app.route("POST", "/api/style-card/learn", {}, {}, "author", {})
    assert code == 202
    for _ in range(400):
        code, out = app.route("GET", "/api/style-card", {}, None, "author", {})
        if out["card"]["status"] != "learning":
            break
        time.sleep(0.05)
    assert out["card"]["status"] == "ready", out["card"].get("error")
    return out


def test_style_card_api(tmp_path):
    app = make_app(tmp_path, SlotFake())
    code, out = app.route("GET", "/api/style-card", {}, None, "author", {})
    assert out["card"] is None
    with pytest.raises(AkoweError):
        app.route("POST", "/api/style-card/learn", {}, {}, "author", {})
    out = _learn(app)
    card = out["card"]
    assert card["ai"]["voice_summary"] and [m["verified"] for m in card["ai"]["example_moves"]] == [True, False]
    assert card["samples"][0]["name"] == "Diary" and card["in_words"]
    code, out = app.route("DELETE", "/api/style-card", {}, None, "author", {})
    assert out["card"] is None


def test_style_reaches_the_writer_and_the_editor(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    _learn(app)
    run = run_book(app, {"slot_id": "AI-1", "my_style": True})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    assert any(e.get("code") == "STYLE_APPLIED" for e in run["events"])
    entry = sc.book_entry(app.store, pid)
    assert entry["on"] and entry["brief"]["voice_summary"]
    # every chapter prompt carried the narrator style and its rule; the editor got it too
    chapter_ctx = [c for _s, c in fake.prompts["C02"]]
    assert chapter_ctx and all((c.get("writing_brief") or {}).get("narrator_style") for c in chapter_ctx)
    assert any(sc.RULE in (c.get("writing_brief") or {}).get("rules", []) for c in chapter_ctx)
    craft = [c for _s, c in fake.prompts.get("craft", [])]
    assert craft and all(c.get("narrator_style") for c in craft)
    assert any(sc.EDITOR_NOTE in s for s, _c in fake.prompts["craft"])
    # the author can switch it off for the book
    code, out = app.route("PUT", f"/api/projects/{pid}/branches/main/style", {}, {"on": False}, "author", {})
    assert out["style"]["on"] is False and sc.brief_for(app.store, pid) is None
    from akowe.book_path import BookPath
    bp = BookPath(app.engine, "author", pid, "main")
    outline = bp.outline()
    cid = bp.outline_chapters(outline)[0]["chapter_id"]
    brief, meta = chapter_brief.build(app.store, pid, "main", outline, cid)
    assert "narrator_style" not in (brief or {}) and not meta.get("narrator_style")
    code, out = app.route("PUT", f"/api/projects/{pid}/branches/main/style", {}, {"on": True}, "author", {})
    assert out["style"]["on"]
    code, out = app.route("GET", "/api/style-card", {}, None, "author", {})
    assert any(b["project_id"] == pid and b["on"] for b in out["books"])


def test_my_style_without_a_card_is_a_note(tmp_path):
    app = make_app(tmp_path, SlotFake())
    run = run_book(app, {"slot_id": "AI-1", "my_style": True})
    assert run["status"] == "done"
    assert any(e.get("code") == "STYLE_MISSING" for e in run["events"])
    assert sc.brief_for(app.store, run["project_id"]) is None


def test_run_settings_are_booleans(tmp_path):
    app = make_app(tmp_path, SlotFake())
    for k in ("beta_reader", "my_style"):
        with pytest.raises(AkoweError):
            app.autobook.start("author", {"author_confirms": True, k: "yes"})
