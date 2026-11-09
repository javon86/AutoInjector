"""Fixes from the run of the short story "The Salt Organ" (Make-a-book, 3 chapters):

1. Gemini answered the whole-book review with a canned "I can't help with that" (a false alarm on a literary ghost
   story). Akọwe reported it as "Gemini could not review (UPSTREAM_UNAVAILABLE)" and counted one reviewer. Now a
   refusal is its own code, AI_DECLINED, end to end (the bridge's 503 SITE_ERROR "refused" -> AI_DECLINED), the report
   says it plainly, the reviewer is asked once more with a short neutral note that the book is fiction under review,
   and when it still declines another AI (or the 🤖 Claude Code helper) stands in so the book gets two independent
   whole-book reviewers when possible — and the report says who stood in.
2. The report's AI usage table said "Written by: AI (version 4 again — the editor's rewrite was not kept)": the AI that
   wrote the kept version is named now, and counted in "Most of the book was written by".
3. The title page showed "Odile Harrow", the main character of the author's OTHER book: the ⚡ invent step asked the AI
   for "an invented pen name". A pen name is now only what the author typed (or their saved pen name), and the plan
   check warns when it is a character's name.
Everything runs on the fake AI.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from akowe import book_report as br
from akowe import pen_name
from akowe import providers as prov
from akowe import run_forecast
from akowe.errors import ERROR_CODES, AkoweError
from akowe.jobs import is_busy_error
from akowe.review import ReviewService

from test_book_review_calibration import honest
from test_failover_review import SlotFake, make_app, no_provider_sleep, run_book  # noqa: F401
from test_server import call, server  # noqa: F401


def declined(site="Gemini"):
    return prov.AutoInjectorAdapter._classify_http(
        503, "", {"error": "SITE_ERROR", "site_error": "refused", "declined": True, "retry_after_s": 30},
        site.lower())


# ====================================================================== 1a. the code, end to end
def test_a_refusal_from_the_bridge_is_ai_declined_not_upstream_unavailable():
    err = declined()
    assert "AI_DECLINED" in ERROR_CODES
    assert err.code == "AI_DECLINED" and err.code != "UPSTREAM_UNAVAILABLE"
    assert "Gemini declined to answer (it said it can't help with that)" in err.errors[0]["message"]
    assert err.try_other_ai and err.declined and err.retry_after_s == 30
    assert is_busy_error(err)  # the work still moves to another AI or waits and asks again, like before
    # an older bridge without the "declined" flag: the site_error kind alone is enough
    old = prov.AutoInjectorAdapter._classify_http(503, "", {"error": "SITE_ERROR", "site_error": "refused"}, "gemini")
    assert old.code == "AI_DECLINED"
    # other site notices are unchanged
    assert prov.AutoInjectorAdapter._classify_http(503, "", {"error": "SITE_ERROR", "site_error": "error"},
                                                   "gemini").code == "UPSTREAM_UNAVAILABLE"
    # a refusal after the adapter's re-asks: AI_DECLINED too, never waited on (another AI instead)
    e2 = AkoweError("AI_DECLINED", "", "x")
    e2.no_wait = True
    assert not is_busy_error(e2)


# ====================================================================== 1b. the whole-book review
REVIEW_WORDS = "independent, demanding literary critic"


class DecliningFake(SlotFake):
    """SlotFake whose ``decline`` slots answer whole-book reviews with a refusal ``decline[slot]`` times."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.decline: dict[str, int] = {}
        self.review_prompts: list[tuple[str, str]] = []

    def submit(self, slot, system, user, schema):
        sid = slot["slot_id"]
        if REVIEW_WORDS in (system + user):
            with self.lock:
                self.review_prompts.append((sid, system + user))
                left = self.decline.get(sid, 0)
                if left:
                    self.decline[sid] = left - 1
            if left:
                raise declined(prov.SITE_NAMES.get(slot.get("site"), sid))
        return super().submit(slot, system, user, schema)


@pytest.fixture()
def no_helper(monkeypatch):
    from akowe import claude_code as cc
    monkeypatch.setattr(cc, "available", lambda store: None)


def _book(tmp_path, writer="AI-2"):
    fake = DecliningFake()
    app = make_app(tmp_path, fake)  # AI-1 claude, AI-2 chatgpt, AI-3 gemini
    run = run_book(app, {"slot_id": writer})
    assert run["status"] == "done", run.get("problem")
    return fake, app, run["project_id"]


def test_declined_once_then_answers_after_the_fiction_note(tmp_path, no_helper):
    fake, app, pid = _book(tmp_path)
    fake.decline = {"AI-3": 1}
    fake.review_prompts.clear()
    rep = app.reports.make("author", pid, "main")
    g = next(r for r in rep["reviews"] if r["slot"] == "AI-3")
    assert g["status"] == "done" and g.get("reframed") and g.get("declined_first")
    gem = [p for s, p in fake.review_prompts if s == "AI-3"]
    assert len(gem) >= 2 and br.FICTION_NOTE not in gem[0] and br.FICTION_NOTE in gem[1]
    assert "work of fiction" in br.FICTION_NOTE and "ignore" not in br.FICTION_NOTE.lower()  # context, no tricks
    assert rep["aggregate"]["reviewers"] == 2 and rep["aggregate"]["independent"] == 2
    assert not any(r.get("stand_in_for") for r in rep["reviews"])
    assert any("answered after Akọwe said the book is fiction under review" in n for n in g["trust_notes"])


def test_still_declined_another_ai_stands_in_and_the_report_says_so(tmp_path, no_helper):
    fake, app, pid = _book(tmp_path, writer="AI-1")  # Claude wrote: ChatGPT and Gemini are the independent ones
    fake.decline = {"AI-3": 2}
    rep = app.reports.make("author", pid, "main")
    g = next(r for r in rep["reviews"] if r["slot"] == "AI-3")
    assert g["status"] == "failed" and g["error"] == "AI_DECLINED" and g["declined"]
    assert g["message"] == "AI-3 · Gemini declined to review this book (it said it can't help with that)"
    # no other independent AI: the writer (Claude) stands in, counted as not independent
    s = next(r for r in rep["reviews"] if r.get("stand_in_for"))
    assert s["slot"] == "AI-1" and s["status"] == "done" and s["independent"] is False
    assert s["stand_in_for"] == "AI-3 · Gemini" and g["replaced_by"] == "AI-1 · Claude"
    assert rep["aggregate"]["reviewers"] == 2 and rep["aggregate"]["independent"] == 1
    text = " ".join(rep["warnings"])
    assert "AI-3 · Gemini declined to review this book (it said it can't help with that)" in text
    assert "AI-1 · Claude reviewed the book in its place" in text and "UPSTREAM_UNAVAILABLE" not in text
    md = br.render_markdown(rep)
    assert "Whole-book review: AI-3 · Gemini — declined" in md and "UPSTREAM_UNAVAILABLE" not in md
    assert "stood in for AI-3 · Gemini" in md


def test_the_claude_code_helper_stands_in_as_a_second_independent_reviewer(tmp_path, monkeypatch):
    """The user's case: ChatGPT wrote, Gemini declined, Claude reviewed — the helper makes it two independent."""
    from akowe import claude_code as cc
    from akowe import claude_code_jobs as ccj
    fake, app, pid = _book(tmp_path, writer="AI-2")
    asked = []
    monkeypatch.setattr(cc, "available", lambda store: {"state": "ready"})

    def fake_job(store, task, schema, ctx, cancel=None):
        asked.append(task)
        return honest(), {"seconds": 1}
    monkeypatch.setattr(ccj, "book_review", fake_job)
    fake.decline = {"AI-3": 2}
    rep = app.reports.make("author", pid, "main")
    h = next(r for r in rep["reviews"] if r["slot"] == br.CC_SLOT)
    assert h["status"] == "done" and h["independent"] and h["stand_in_for"] == "AI-3 · Gemini"
    assert asked and br.FICTION_NOTE in asked[0]
    assert rep["aggregate"]["reviewers"] == 2 and rep["aggregate"]["independent"] == 2
    assert not any(r["slot"] == "AI-2" for r in rep["reviews"])  # the writer is not needed
    assert "Claude Code helper reviewed the book in its place" in " ".join(rep["warnings"])


def test_a_declined_review_inside_a_make_a_book_run_gets_a_stand_in(tmp_path, no_helper):
    fake = DecliningFake()
    fake.decline = {"AI-3": 2}
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    rep = app.reports.latest(run["project_id"], "main")
    assert any(r.get("declined") for r in rep["reviews"])
    assert run["report"]["reviewers"] == 2
    assert any("declined to review this book" in w for w in run["report"]["warnings"])


# ====================================================================== 2. who wrote the kept version
class _Store:
    def __init__(self, recs, prov_rows):
        self.recs, self.prov_rows = recs, prov_rows

    def get_record(self, pid, branch, rid, version):
        return self.recs.get(version)

    def query_one(self, sql, args):
        return self.prov_rows.get(args[-1])

    def get_setting(self, key, default=None):
        return default


def _rv(fixes):
    import json
    recs = {v: {"record_id": "ch1", "version": v} for v in (3, 4, 5)}
    prov_rows = {3: {"transform": "AI", "resource": json.dumps({"ai_slot": "AI-2", "model": "web:chatgpt"})}}
    rv = SimpleNamespace(store=_Store(recs, prov_rows), slot_label=lambda s: {"AI-2": "AI-2 · ChatGPT"}.get(s, s),
                         fixes=lambda pid, branch: fixes)
    rv.made_by = lambda *a, **k: ReviewService.made_by(rv, *a, **k)
    rv.writer_of = lambda *a, **k: ReviewService.writer_of(rv, *a, **k)
    return rv, recs


def test_restored_version_names_the_ai_that_wrote_it():
    # v3 written by ChatGPT; v4 = the editor's change of v3 (no slot noted); v5 = v4 again after the editor's
    # rewrite was rejected (the note had no slot either, because v4's writer had none)
    fixes = {"ch1:4": {"slot": None, "from_version": 3, "editor": True},
             "ch1:5": {"slot": None, "from_version": 6, "restored_from": 4}}
    rv, recs = _rv(fixes)
    w = rv.writer_of("p", "main", recs[5])
    assert w["slot"] == "AI-2"
    assert w["label"] == "AI-2 · ChatGPT (version 4 kept; the editor's rewrite was not kept)"
    assert "AI (version" not in w["label"]
    e = rv.writer_of("p", "main", recs[4])  # the editor's change names the writer and carries its slot
    assert e["slot"] == "AI-2" and e.get("editor")


def test_report_counts_the_restored_chapter_for_its_writer(tmp_path):
    fixes = {"ch1:4": {"slot": None, "from_version": 3, "editor": True},
             "ch1:5": {"slot": None, "from_version": 6, "restored_from": 4}}
    rv, recs = _rv(fixes)
    rv.reviews = lambda pid, branch: {}
    rv.editor = SimpleNamespace(crafts=lambda pid, branch: {})
    rv._slot = lambda s: {"slot_id": s, "adapter_id": "autoinjector", "site": "chatgpt"}
    svc = SimpleNamespace(store=rv.store)
    us = br.ReportService._usage(svc, rv, "p", "main", [{"number": 1, "record_id": "ch1", "version": 5}])
    assert us["writer_slot"] == "AI-2" and us["writer"] == "AI-2 · ChatGPT" and us["writers"] == {"AI-2": 1}
    assert us["chapters"][0]["writer"] == "AI-2 · ChatGPT (version 4 kept; the editor's rewrite was not kept)"
    md = br.render_markdown({"title": "T", "at": "2026-11-09T00:00:00Z", "version": {"key": "k", "chapters": ["x"]},
                             "usage": us, "reviews": [], "aggregate": {}, "words": {}})
    assert "Most of the book was written by AI-2 · ChatGPT." in md


# ====================================================================== 3. the pen name
def test_profile_task_never_asks_the_ai_for_a_pen_name():
    from akowe import autobook
    assert "pen name" not in autobook.PROFILE_TASK.split("Do not choose")[0]
    assert "Do not choose an author name or pen name" in autobook.PROFILE_TASK
    assert "author" not in autobook.PROFILE_SCHEMA["required"]


def test_new_book_never_gets_the_ais_pen_name(tmp_path, no_helper):
    fake = DecliningFake()
    app = make_app(tmp_path, fake)
    from akowe.book_path import get_profile
    run = run_book(app, {"slot_id": "AI-1"})
    prof = get_profile(app.store, run["project_id"])
    assert prof["author"] == "" and prof["author"] != "Rowan Ashby"  # the fake AI still answers "Rowan Ashby"
    # typed for the run -> used
    run2 = run_book(app, {"slot_id": "AI-1", "pen_name": "  Ada   Okafor "})
    assert get_profile(app.store, run2["project_id"])["author"] == "Ada Okafor"
    # the saved pen name (the last one the author typed into a book profile) -> used for a new book
    pen_name.remember(app.store, "Ada Okafor")
    run3 = run_book(app, {"slot_id": "AI-1"})
    assert get_profile(app.store, run3["project_id"])["author"] == "Ada Okafor"


def test_pen_name_that_is_a_character_name_is_warned_about(tmp_path, no_helper):
    from akowe import characters as chars_mod
    from akowe.book_path import get_profile
    fake = DecliningFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    first = run["project_id"]
    hero = chars_mod.canon_characters(app.store, first, "main")[0]["name"]
    title = get_profile(app.store, first)["title"]
    # the plan check (the estimate before Start) warns: the name is a character in another book on the shelf
    chk = run_forecast.pen_name_check(app, {"pen_name": hero})
    assert chk["pen_name"] == {"name": hero, "from": "typed", "saved": ""}
    assert len(chk["warnings"]) == 1 and f"your other book “{title}”" in chk["warnings"][0] and hero in chk["warnings"][0]
    assert run_forecast.pen_name_check(app, {"pen_name": "Ada Okafor"})["warnings"] == []
    assert pen_name.warning(app.store, first, hero).count("this book") == 1
    # a saved pen name that is a character's name is never put on a new book (left empty, with a note)
    pen_name.remember(app.store, hero)
    run2 = run_book(app, {"slot_id": "AI-1"})
    assert get_profile(app.store, run2["project_id"])["author"] == ""
    assert any(e.get("code") == "PEN_NAME_IS_CHARACTER" for e in run2["events"])
    # typed for the run: the author's choice is kept, with the warning
    run3 = run_book(app, {"slot_id": "AI-1", "pen_name": hero})
    assert get_profile(app.store, run3["project_id"])["author"] == hero
    assert any(e.get("code") == "PEN_NAME_IS_CHARACTER" for e in run3["events"])


def test_pen_name_matching_rules():
    assert pen_name._same("Odile Harrow", "odile  harrow")
    assert pen_name._same("Odile Harrow", "Captain Odile Harrow")
    assert not pen_name._same("Odile Harrow", "Odile")  # a first name alone is not a clash
    assert not pen_name._same("Ann Lee", "Lee Ann Marsh")
    assert pen_name.for_new_book(SimpleNamespace(get_setting=lambda k: None), "") == ("", "")


def test_estimate_returns_the_pen_name_check(tmp_path):
    fake = DecliningFake()
    app = make_app(tmp_path, fake)
    pen_name.remember(app.store, "Ada Okafor")
    e = run_forecast.estimate(app, {"length": "short_story"})
    assert e["pen_name"]["name"] == "Ada Okafor" and e["pen_name"]["from"] == "saved" and e["warnings"] == []


def test_profile_save_remembers_the_typed_pen_name(server):  # noqa: F811
    app, port = server
    st, proj, _ = call(port, "POST", "/api/projects", {"name": "B", "profile": {"title": "B", "ai_slot": "manual"}})
    pid = proj["project_id"]
    assert pen_name.saved(app.store) == ""
    st, prof, _ = call(port, "PUT", f"/api/projects/{pid}/profile", {"genre": "fantasy"})
    assert st == 200 and pen_name.saved(app.store) == ""  # no author typed: nothing remembered
    st, prof, _ = call(port, "PUT", f"/api/projects/{pid}/profile", {"author": "Ada Okafor"})
    assert st == 200 and prof["author"] == "Ada Okafor" and pen_name.saved(app.store) == "Ada Okafor"
    assert "pen_name_warning" not in prof
