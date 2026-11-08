"""🤖 Claude Code helpers, Step 2, in a real ⚡ Make-a-book run (fake web AIs + the fake `claude` CLI).

* the next chapter starts without waiting: its scene plan and needs list were made by a helper while the chapter
  before was checked (the web planner is not asked for it; an independent, non-Claude AI still checks them);
* "Fill the whole Book Bible" runs its batches side by side (the fake CLI's log shows the overlap), the relationship
  types after the characters, everything accepted through the same path;
* the extras run in the background (the pictures step does not hold up the book; the launch kit's first drafts wait on
  🚀 Launch kit, never approved);
* the run report shows the time saved by each;
* with the fake CLI removed, the run is exactly as before.
"""
from __future__ import annotations

import time

from akowe import claude_code, claude_code_speed, launch_kit, scenes
from akowe.book_path import BookPath

from cc_fake import calls, install, max_overlap, remove
from test_claude_code_run import _fake, _wait_jobs
from test_failover_review import make_app, run_book  # noqa: F401
from test_failover_review import no_provider_sleep  # noqa: F401 - the fixture

PLAN_S = 0.8   # a web scene plan takes a moment, as on the real sites
CHECK_S = 0.6  # … and so does each web AI's reading in the all-AI check


def _slow_checks(fake):
    orig = fake.submit

    def submit(slot, system, user, schema):
        out = orig(slot, system, user, schema)
        if fake.kinds and fake.kinds[-1] == "checkpoint":
            time.sleep(CHECK_S)
        return out
    fake.submit = submit


def _slow_planner(monkeypatch, made: list):
    orig = scenes.ScenePlanner.make

    def make(self, job, chapter_id, revise=False):
        made.append((chapter_id, revise))
        time.sleep(PLAN_S)
        return orig(self, job, chapter_id, revise=revise)
    monkeypatch.setattr(scenes.ScenePlanner, "make", make)


def _order(app, pid):
    bp = BookPath(app.engine, "author", pid, "main")
    outline = bp.outline()
    return outline, [c["chapter_id"] for c in bp.outline_chapters(outline)]


def _step(run, sid):
    return next(s for s in run["steps"] if s["id"] == sid)


def test_step2_run_prepares_ahead_fills_the_bible_side_by_side_and_runs_extras(tmp_path, monkeypatch):
    log = tmp_path / "cclog"
    log.mkdir()
    install(tmp_path, monkeypatch, FAKE_CLAUDE_DELAY=0.3, FAKE_CLAUDE_LOG=log)
    fake, prompts = _fake()
    _slow_checks(fake)
    app = make_app(tmp_path, fake)
    claude_code.save_settings(app.store, {"specialists": {"pacing": True}})
    made: list = []
    _slow_planner(monkeypatch, made)
    assert claude_code.detect(app.store, force=True)["state"] == "ready"
    run = run_book(app, {"length": "short_story", "slot_id": "AI-2", "fill_bible": True})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    _wait_jobs()
    pid = run["project_id"]
    rows = [c for c in calls(log) if c["job"] != "login_check"]
    kinds = {c["job"] for c in rows}
    assert {"prepare", "variety", "bible_fill", "launch_kit", "pacing", "specifics"} <= kinds, kinds
    outline, order = _order(app, pid)

    # 1. the next chapter ready early: chapters 2 and 3 were planned by the helper, not the web planner
    assert [cid for cid, _r in made if not _r] == [order[0]], made
    for cid in order[1:]:
        e = scenes.get_entry(app.store, pid, "main", outline["record_id"], cid)
        assert e["status"] == "approved" and e["history"] == [] or e["made_by"]["slot"] == "AI-1", e
        assert claude_code_speed.prepared_of(app.store, pid, "main", cid)["status"] == "used"
        rv = e.get("review") or {}
        assert rv.get("slot") and rv["slot"] != "AI-1", rv  # the independent check is not by Claude
    ev = [x for x in run["events"] if x.get("code") == "PREPARED_USED"]
    assert len(ev) == 2, [x.get("code") for x in run["events"]]
    # the prepare of chapter N+1 ran while chapter N was checked: it started before chapter N+1's writer did
    prep = [c for c in rows if c["job"] == "prepare"]
    assert len(prep) == 2
    # 5. variety: the helper's advice for the planned opening reached chapter 2's and 3's writers
    briefs = [u for k, u in prompts if k == "C02" and "writing_brief" in u]
    assert any("cracked lens" in u and "so_far" in u for u in briefs), "no writer got the variety advice"

    # 2. the Book Bible side by side: several batches at once, the relationship types only after the rest
    bible = [c for c in rows if c["job"] == "bible_fill"]
    assert max_overlap(bible) >= 2, "the Bible batches never ran side by side"
    rel = [c for c in bible if c.get("rel")]
    first = [c for c in bible if not c.get("rel")]
    assert rel and first, "the fake book has relationship rows to type"
    if rel:
        assert min(c["start"] for c in rel) >= min(c["end"] for c in first)
    bst = _step(run, "bible")
    assert bst["state"] == "done" and "filled" in bst["message"], bst

    # 3. extras: the pictures did not hold up the book; the launch kit's drafts wait for the author
    pst = _step(run, "pictures")
    assert "background" in pst["message"], pst
    d = launch_kit.doc(app.store, pid, "main")
    for f in ("blurb_short", "hook", "keywords"):
        v = launch_kit.newest(d, f)
        assert v and v["by"] == "ai", (f, v)
        assert d["fields"][f]["approved"] is None  # never approved by the run
    assert any(x.get("code") == "EXTRAS_BACKGROUND" for x in run["events"])

    # the run report: the time saved by each part
    full = app.autobook.public(app.autobook.get(run["id"]))
    hl = full["costs"]["helpers"]
    sp = hl["speed"]
    assert sp["prepare"]["used"] == 2 and sp["prepare"]["saved_s"] > 0
    assert sp["bible"]["helped"] >= 2 and sp["bible"]["one_by_one_s"] > sp["bible"]["wall_s"], sp["bible"]
    assert sp["extras"]["background"] >= 2
    assert "next chapter ready early" in hl["line"] and "Book Bible filled side by side" in hl["line"]
    assert hl["speed_saved_s"] > 0
    print("\nMEASURED:", hl["line"])
    print("SPEED:", sp, "saved_s:", hl["speed_saved_s"])


def test_step2_without_the_cli_the_run_is_exactly_as_before(tmp_path, monkeypatch):
    remove(tmp_path, monkeypatch)
    fake, prompts = _fake()
    app = make_app(tmp_path, fake)
    made: list = []
    _slow_planner(monkeypatch, made)
    run = run_book(app, {"length": "short_story", "slot_id": "AI-2", "fill_bible": True})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid = run["project_id"]
    outline, order = _order(app, pid)
    assert [cid for cid, _r in made if not _r] == order  # every chapter planned by the web AI, as before
    for cid in order:
        assert claude_code_speed.prepared_of(app.store, pid, "main", cid) is None
    assert "background" not in _step(run, "pictures")["message"]
    assert _step(run, "bible")["state"] == "done"
    assert not launch_kit.newest(launch_kit.doc(app.store, pid, "main"), "blurb_short")
    assert not any("variety" in u for k, u in prompts if k == "C02")
    assert not any(x.get("code", "") and x["code"].startswith(("PREPARED", "EXTRAS")) for x in run["events"])
    assert (run.get("costs") or {}).get("helpers") is None


def test_step2_a_failing_bible_helper_falls_back_to_the_web_ai(tmp_path, monkeypatch):
    install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE_BIBLE_FILL="crash", FAKE_CLAUDE_MODE_PREPARE="malformed")
    fake, _p = _fake()
    app = make_app(tmp_path, fake)
    made: list = []
    _slow_planner(monkeypatch, made)
    claude_code.detect(app.store, force=True)
    run = run_book(app, {"length": "short_story", "slot_id": "AI-2", "fill_bible": True})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid = run["project_id"]
    _outline, order = _order(app, pid)
    assert [cid for cid, _r in made if not _r] == order  # the prepare failed: every chapter planned the old way
    full = app.autobook.public(app.autobook.get(run["id"]))
    b = full["costs"]["helpers"]["speed"]["bible"]
    assert b["calls"] and b["helped"] == 0 and b["fell_back"] == b["calls"], b
    assert "filled" in _step(run, "bible")["message"]


def test_step2_facts_changed_after_the_prepare_the_chapter_is_planned_again(tmp_path, monkeypatch):
    """The approval / check of chapter 1 changes the running notes after chapter 2 was prepared: the prepared plan is
    marked stale and chapter 2 is planned from the current facts (never written from the stale plan); chapter 3's
    plan, prepared after the change, is used."""
    from akowe import story_ledger
    install(tmp_path, monkeypatch)
    fake, _p = _fake()
    _slow_checks(fake)
    app = make_app(tmp_path, fake)
    made: list = []
    _slow_planner(monkeypatch, made)
    claude_code.detect(app.store, force=True)
    orig = claude_code_speed.chapter_done

    def chapter_done(svc, run, outline, chapters, idx):
        orig(svc, run, outline, chapters, idx)
        if idx == 0:  # the check of chapter 1 then changes what the running notes say about it
            pid, br = run["project_id"], run["branch_id"]
            cur = story_ledger.get_all(svc.store, pid, br)
            e = cur["chapters"].setdefault(chapters[0]["chapter_id"], {"number": 1})
            e["number"] = 1
            e["summary"] = list(e.get("summary") or []) + ["Mara breaks her wrist on the tower stairs."]
            svc.store.set_setting(story_ledger.KEY.format(pid=pid, branch=br), cur)
    monkeypatch.setattr(claude_code_speed, "chapter_done", chapter_done)
    run = run_book(app, {"length": "short_story", "slot_id": "AI-2"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid = run["project_id"]
    outline, order = _order(app, pid)
    assert [cid for cid, _r in made if not _r] == order[:2], made  # chapter 2 planned again by the web AI
    assert claude_code_speed.prepared_of(app.store, pid, "main", order[1])["status"] == "stale"
    assert claude_code_speed.prepared_of(app.store, pid, "main", order[2])["status"] == "used"
    e2 = scenes.get_entry(app.store, pid, "main", outline["record_id"], order[1])
    prepared = claude_code_speed.prepared_of(app.store, pid, "main", order[1])["cards"]
    assert e2["cards"] != prepared and (e2.get("made_by") or {}).get("slot") != "AI-1"
    assert [x.get("code") for x in run["events"]].count("PREPARED_STALE") == 1
    sp = app.autobook.public(app.autobook.get(run["id"]))["costs"]["helpers"]["speed"]["prepare"]
    assert sp["stale"] == 1 and sp["used"] == 1


def test_step2_when_claude_writes_no_specialist_reviews_but_proposals_still_come(tmp_path, monkeypatch):
    """The writer-can't-review rule: Claude writes, so the specialists (Claude Code = Claude) never review; the
    style / specifics passes are proposals (not reviews) and wait on the chapter page for ✔ Use."""
    from akowe import claude_code_book, fact_checks, style_card
    log = tmp_path / "cclog"
    log.mkdir()
    install(tmp_path, monkeypatch, FAKE_CLAUDE_LOG=log)
    fake, _p = _fake()
    app = make_app(tmp_path, fake)
    claude_code.save_settings(app.store, {"specialists": {"pacing": True}})
    claude_code.detect(app.store, force=True)
    orig_apply = style_card.apply_to_book

    def with_card(store, principal, pid):  # the author's ✒️ style card, applied when the run makes the book
        entry = {"on": True, "brief": {"numbers": {"avg_sentence": 30.0, "person": "first", "tense": "present"},
                                       "voice_summary": "long, warm sentences"}, "from_version": 1, "at": "now"}
        store.set_setting(style_card.BOOK_KEY.format(pid=pid), entry)
        return entry
    monkeypatch.setattr(style_card, "apply_to_book", with_card)
    run = run_book(app, {"length": "short_story", "slot_id": "AI-1", "my_style": True})
    monkeypatch.setattr(style_card, "apply_to_book", orig_apply)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    _wait_jobs()
    kinds = {c["job"] for c in calls(log)}
    assert not kinds & {"pacing", "dialogue", "sensory", "subtext", "continuity", "voice"}, kinds
    assert {"style", "specifics"} <= kinds, kinds
    pid = run["project_id"]
    ch = next(c for c in fact_checks.book_texts(app.engine, "author", pid, "main") if c["number"] == 1)
    info = claude_code_book.chapter_info(app, "author", pid, "main", ch["record_id"])
    by_kind = {}
    for p in info["proposals"]:
        by_kind.setdefault(p["kind"], []).append(p)
    assert {"style", "detail", "dialogue"} <= set(by_kind), set(by_kind)
    p = by_kind["style"][0]
    out = claude_code_book.use_proposals(app, "author", pid, "main", ch["record_id"], {"ids": [p["id"]]})
    head = app.review._head(pid, "main", ch["record_id"])  # noqa: SLF001
    assert out["used"] == 1 and p["replacement"] in head["data"]["text"]
    assert head.get("approved_version") != head["version"]  # a new draft for the author to approve
