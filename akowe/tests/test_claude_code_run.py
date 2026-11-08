"""🤖 Claude Code helpers in a real ⚡ Make-a-book run (fake web AIs + the fake `claude` CLI).

* the helpers run side by side (the fake CLI's own log shows the overlap) and their results land in the normal
  places: the per-chapter all-AI check (``part["by_ai"]``, merged by cross_check), the sourced fact checks, the
  research notes in the next chapters' writing briefs, and AI-tell proposals that become a draft only through ✔ Use;
* the run report has the checks' timing with and without the helpers;
* the writer never reviews itself: when Claude writes, the helpers only fact-check (no continuity / voice reading);
* every failure mode (not installed, signed out, at the limit, crashing, malformed answers) falls back: the run
  completes exactly as before.
"""
from __future__ import annotations

import time

import pytest

from akowe import checkpoints, claude_code, claude_code_book, fact_checks
from akowe.book_path import BookPath

from cc_fake import calls, install, max_overlap, remove
from test_failover_review import SlotFake, make_app, run_book  # noqa: F401
from test_failover_review import no_provider_sleep  # noqa: F401 - the fixture


def _fake(write_delay: float = 0.0):
    fake = SlotFake()
    fake.story_ledger = True
    prompts: list[tuple[str, str]] = []
    orig = fake.submit

    def submit(slot, system, user, schema):
        out = orig(slot, system, user, schema)
        prompts.append((fake.kinds[-1] if fake.kinds else "", user))
        if write_delay and fake.kinds and fake.kinds[-1] == "C02":
            time.sleep(write_delay)  # a chapter takes a moment to write, as on the real sites
        return out
    fake.submit = submit
    return fake, prompts


def _wait_jobs(timeout=30):
    """The helpers' background jobs (fact checks, the AI-tell pass of the last chapter) finish."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if all(f.done() for f in list(claude_code_book._FUTS.values())):  # noqa: SLF001
            return
        time.sleep(0.05)


def _chapter_checks(app, pid):
    return [c for c in checkpoints.items(app.store, pid, "main") if c.get("kind") == "chapter"]


def test_a_run_with_helpers_parallel_results_in_place_and_timed(tmp_path, monkeypatch):
    log = tmp_path / "cclog"
    log.mkdir()
    install(tmp_path, monkeypatch, FAKE_CLAUDE_DELAY=0.4, FAKE_CLAUDE_LOG=log)
    fake, prompts = _fake(write_delay=1.5)
    app = make_app(tmp_path, fake)
    assert claude_code.detect(app.store, force=True)["state"] == "ready"
    run = run_book(app, {"length": "short_story", "slot_id": "AI-2"})  # ChatGPT writes: Claude is a reviewer
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    _wait_jobs()
    pid = run["project_id"]
    rows = [c for c in calls(log) if c["job"] != "login_check"]
    kinds = {c["job"] for c in rows}
    assert {"research", "facts", "continuity", "voice", "ai_tells"} <= kinds, kinds
    assert max_overlap(rows) >= 2, "the helpers never ran side by side"
    assert max_overlap(rows) <= claude_code.settings(app.store)["helpers"]
    # 1. the per-chapter all-AI check: the helpers read for Claude (same family), in the normal result format
    chs = _chapter_checks(app, pid)
    assert len(chs) == 3
    for c in chs:
        by = c["parts"][0]["by_ai"]
        names = {v.get("name") for v in by.values() if v.get("done")}
        assert claude_code_book.NAME in names and "Claude" not in names, by
        assert len(checkpoints.checked_by(c)) == 3  # still three AIs: ChatGPT, Gemini and Claude (as Claude Code)
        assert c["status"] == "done"
    # 2. sourced fact checks, stored where the fact checks live
    bp = BookPath(app.engine, "author", pid, "main")
    order = [c["chapter_id"] for c in bp.outline_chapters(bp.outline())]
    fc = fact_checks.sourced_of(app.store, pid, "main", order[0])
    assert fc and fc["claims"] and fc["claims"][0]["source_url"].startswith("https://")
    # 3. research ahead reached the later chapters' writers, labelled, and the unsourced note was dropped
    notes = claude_code_book.brief_notes(app.store, pid, "main", order[1])
    assert notes and {n["label"] for n in notes} == {"established fact", "legend"}
    assert not any("Unsourced" in (n.get("topic") or "") for n in notes)
    assert any("research_notes" in u and "Fresnel" in u for k, u in prompts if k == "C02"), \
        "no chapter writer got the research notes"
    # 4. the run report: timings with and without the helpers
    full = app.autobook.public(app.autobook.get(run["id"]))
    hl = full["costs"]["helpers"]
    assert hl and hl["jobs"] >= 8 and hl["checks"] and hl["checks_wall_s"] > 0
    assert hl["checks_one_by_one_s"] > hl["checks_wall_s"], hl
    assert "side by side" in hl["line"]
    print("\nMEASURED:", hl["line"], {k: hl[k] for k in ("checks_wall_s", "checks_one_by_one_s", "checks_old_way_s",
                                                          "speedup", "jobs", "peak")})
    # 5. AI-tell proposals: nothing changed until the author uses them; then a new draft that waits for approval
    ch = next(c for c in fact_checks.book_texts(app.engine, "author", pid, "main") if c["number"] == 2)
    info = claude_code_book.chapter_info(app, "author", pid, "main", ch["record_id"])
    props = [p for p in info["proposals"] if p["kind"] == "ai_tell"]
    assert props, info
    assert ch["approved"] and props[0]["original"] in ch["text"]
    out = claude_code_book.use_proposals(app, "author", pid, "main", ch["record_id"], {"ids": [props[0]["id"]]})
    head = app.review._head(pid, "main", ch["record_id"])  # noqa: SLF001
    assert out["used"] == 1 and props[0]["replacement"] in head["data"]["text"]
    assert head.get("approved_version") != head["version"]  # waits for the author's approval
    s, body = app.route("GET", f"/api/projects/{pid}/branches/main/review/claude-code/chapter/{ch['record_id']}", {},
                        None, "author", {})
    assert s == 200 and not [p for p in body["proposals"] if p["id"] == props[0]["id"]]
    # the settings endpoint
    s, st = app.route("GET", "/api/settings/claude-code", {}, None, "author", {})
    assert s == 200 and st["status"]["state"] == "ready" and st["active"]


def test_when_claude_writes_the_helpers_only_check_facts(tmp_path, monkeypatch):
    log = tmp_path / "cclog"
    log.mkdir()
    install(tmp_path, monkeypatch, FAKE_CLAUDE_LOG=log)
    fake, _p = _fake()
    app = make_app(tmp_path, fake)
    claude_code.detect(app.store, force=True)
    run = run_book(app, {"length": "short_story", "slot_id": "AI-1"})  # Claude writes
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    _wait_jobs()
    kinds = {c["job"] for c in calls(log)}
    assert "continuity" not in kinds and "voice" not in kinds and "facts" in kinds, kinds
    for c in _chapter_checks(app, run["project_id"]):
        by = c["parts"][0]["by_ai"]
        assert "Claude" in {v.get("name") for v in by.values()}  # the Claude pane read it itself (the writer reads too)
        assert claude_code_book.PSEUDO_SLOT not in by  # no extra "AI": the fact check is folded into Claude's reading


def _plain_run(tmp_path):
    fake, _p = _fake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "slot_id": "AI-2"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    return app, run


@pytest.mark.parametrize("mode", ["missing", "logged_out", "limit", "crash", "malformed"])
def test_every_failure_falls_back_to_the_old_way(tmp_path, monkeypatch, mode):
    if mode == "missing":
        remove(tmp_path, monkeypatch)
    else:
        install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE=mode)
    fake, _p = _fake()
    app = make_app(tmp_path, fake)
    claude_code.detect(app.store, force=True)
    run = run_book(app, {"length": "short_story", "slot_id": "AI-2"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid = run["project_id"]
    for c in _chapter_checks(app, pid):  # exactly as before: the three web AIs
        names = {v.get("name") for v in c["parts"][0]["by_ai"].values() if v.get("done")}
        assert names == {"Claude", "ChatGPT", "Gemini"}, names
    assert not (app.autobook.public(app.autobook.get(run["id"]))["costs"].get("helpers") or {}).get("ok")
    if mode in ("logged_out", "limit"):
        assert any(e.get("code") == "CLAUDE_CODE_FALLBACK" for e in run["events"]), [e.get("code") for e in run["events"]]


def test_a_failing_helper_mid_run_hands_the_check_back_to_the_claude_pane(tmp_path, monkeypatch):
    install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE_CONTINUITY="crash")
    fake, _p = _fake()
    app = make_app(tmp_path, fake)
    claude_code.detect(app.store, force=True)
    run = run_book(app, {"length": "short_story", "slot_id": "AI-2"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    for c in _chapter_checks(app, run["project_id"]):
        names = {v.get("name") for v in c["parts"][0]["by_ai"].values() if v.get("done")}
        assert "Claude" in names, names  # the pane read it after all


def test_without_the_cli_the_run_is_the_same_as_before(tmp_path, monkeypatch):
    remove(tmp_path, monkeypatch)
    app, run = _plain_run(tmp_path / "a")
    pid = run["project_id"]
    chs = _chapter_checks(app, pid)
    assert len(chs) == 3 and all(len(checkpoints.checked_by(c)) == 3 for c in chs)
    assert claude_code_book.brief_notes(app.store, pid, "main", chs[0]["chapter_ids"][0]) == []
    assert (run.get("costs") or {}).get("helpers") is None
    # and the run option switches them off for one book even when they are ready
    install(tmp_path, monkeypatch)
    fake, _p = _fake()
    app2 = make_app(tmp_path / "b", fake)
    claude_code.detect(app2.store, force=True)
    run2 = run_book(app2, {"length": "short_story", "slot_id": "AI-2", "claude_code": False})
    assert run2["status"] == "done"
    for c in _chapter_checks(app2, run2["project_id"]):
        assert claude_code_book.NAME not in {v.get("name") for v in c["parts"][0]["by_ai"].values()}
