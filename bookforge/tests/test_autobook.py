"""⚡ Make a book for me (R14) end to end with a fake AI, run consent scoping, REVISE->fix loop, pause/resume/cancel
(S21), restart-resume (S11), the AI retry queue (S10), TIMEOUT pausing a step, Write all chapters (S2), health (R12),
diagnostics without secrets (S8), backups with rotation and restore (S9), the book journal (R11), the finished-books
shelf (S22) and structured errors from every endpoint (R1-R3)."""
from __future__ import annotations

import json
import time
import types

import pytest

from bookforge import journal, providers as prov_mod
from bookforge.autobook import verify_file
from bookforge.book_path import BookPath, save_profile
from bookforge.errors import BookforgeError
from bookforge.jobs import JobStore, RetryPolicy, wait_and_retry
from bookforge.server import App, make_handler

from autobook_fake import CHAPTER_TEXT, BookFakeAI, fact, plan_item
from test_server import TOKEN, call  # noqa: F401

FAKE_KEY = "sk-ant-FAKEKEY-0123456789abcdefghij-SECRET"


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    """The providers' own quick retries (1-4 s) would only slow the tests down."""
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def make_app(tmp_path, name="data", fake=None):
    app = App(tmp_path / name, token=TOKEN)
    app.engine.providers.secret_path = tmp_path / "secrets.json"
    if fake is not None:
        app.engine.providers.test_adapter = fake
        app.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
    fast = RetryPolicy([0.01, 0.02], 5)
    app.autobook.retry_policy = fast
    app.write_all.retry_policy = fast
    app.assist.retry_policy = fast
    return app


def run_book(app, body=None, timeout=120):
    r = app.autobook.start("author", dict({"author_confirms": True}, **(body or {})))
    app.autobook.wait_for(r["id"], timeout)
    return app.autobook.public(app.autobook.get(r["id"]))


def steps(run):
    return {s["id"]: s for s in run["steps"]}


def outbox(app, pid, et):
    return [json.loads(r["payload"]) for r in app.store.query(
        "SELECT payload FROM outbox WHERE project_id=? AND event_type=? ORDER BY created_at", (pid, et))]


# ---------------------------------------------------------------------------------------------- R14 end to end
def test_make_a_book_end_to_end_with_fake_ai(tmp_path):
    fake = BookFakeAI(verdicts=["REVISE"])  # the first review asks for changes: fix -> review -> approve
    app = make_app(tmp_path, fake=fake)
    other = app.engine.bootstrap_project("author", "My own book")
    cand = {"concept": "Old Tom", "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
            "facts": [fact("tom", "entity.name", "Old Tom")]}
    bp_other = BookPath(app.engine, "author", other, "main")
    draft_other, _ = bp_other.create("A01", {"concept": "Old Tom"}, manual_candidate=cand)
    before = {(r["record_id"], r["version"], r["lifecycle"]) for r in app.store.list_records(other, "main")}

    run = run_book(app, {"genre": "Mystery", "length": "short_story"})
    assert run["status"] == "done", (run["phase"], [(s["id"], s["state"], s.get("problem")) for s in run["steps"]])
    st = steps(run)
    assert all(s["state"] == "done" for s in run["steps"])
    assert run["consent"]["by"] == "author" and run["consent"]["run_id"] == run["id"]
    pid = run["project_id"]
    assert pid != other and run["title"] == "The Keeper of Gullhaven"
    # the author's existing book was not touched (its draft stays a draft)
    assert {(r["record_id"], r["version"], r["lifecycle"]) for r in app.store.list_records(other, "main")} == before
    assert app.store.history(other, "main", draft_other["record_id"])[-1]["lifecycle"] == "DRAFT"
    # real files, re-read by the independent checkers
    files = {f["format"]: f for f in run["files"]}
    assert set(files) == {"PDF", "EPUB", "DOCX"}
    for fmt, f in files.items():
        rec = app.store.get_record(pid, "main", f["record_id"], f["version"])
        data = app.store.read_binary(rec)
        assert verify_file(fmt, data)[0]
        assert data[:4] == (b"%PDF" if fmt == "PDF" else b"PK\x03\x04")
    pdf = app.store.read_binary(app.store.get_record(pid, "main", files["PDF"]["record_id"], files["PDF"]["version"]))
    assert b"Gullhaven" in pdf
    # every step in book order, with the REVISE -> fix -> APPROVE loop on the first reviewed draft
    assert fake.kinds.index("profile") < fake.kinds.index("sketch") < fake.kinds.index("B01") < \
        fake.kinds.index("B03") < fake.kinds.index("B11") < fake.kinds.index("C02")
    assert fake.kinds[fake.kinds.index("review") + 1] == "fix"
    assert st["chapters"]["items"] and all(i["state"] == "done" for i in st["chapters"]["items"])
    # approvals are labelled with the run consent and the run id; nothing else was approved for the author
    appr = outbox(app, pid, "autobook.approved_under_consent")
    assert appr and all(a["run_id"] == run["id"] and run["id"] in a["label"] for a in appr)
    assert not outbox(app, pid, "review.approved_by_author")
    bp = BookPath(app.engine, "author", pid, "main")
    status = bp.status()
    assert status["next"] is None and status["words"]["words"] > 100 and status["words"]["target_words"] == 5000
    manifest = app.store.feature_manifest(pid, "main")
    assert set(manifest["release_profiles"]) >= {"MANUSCRIPT_PDF", "EPUB_REFLOWABLE", "EDITABLE_DOCX"}
    # automatic backups: before the run, before assembling, before exporting
    reasons = {b["reason"] for b in app.backups.list()}
    assert {"before-run", "before-assemble", "before-export"} <= reasons


def test_run_consent_is_scoped_to_the_live_run(tmp_path):
    app = make_app(tmp_path, fake=BookFakeAI())
    run = run_book(app)
    assert run["status"] == "done"
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    out = bp.dispatch("B01", "CREATE", payload=bp.payload_for("B01"))
    ref = out["output_refs"][0]
    saved = app.autobook.get(run["id"])
    with pytest.raises(BookforgeError) as exc:
        app.autobook._approve(saved, ref, why="test")  # run finished: no consent any more
    assert exc.value.code == "PERMISSION_DENIED"
    live = dict(saved, status="running")
    with pytest.raises(BookforgeError):
        app.autobook._approve(live, ref, why="test")  # not inside the run's own thread
    assert app.store.history(run["project_id"], "main", ref["record_id"])[-1]["lifecycle"] == "DRAFT"
    # starting needs the button press (author_confirms) and an AI
    with pytest.raises(BookforgeError) as exc:
        app.autobook.start("author", {})
    assert exc.value.code == "APPROVAL_REQUIRED"
    bare = make_app(tmp_path, "bare")
    with pytest.raises(BookforgeError) as exc:
        bare.autobook.start("author", {"author_confirms": True})
    assert exc.value.code == "CAPABILITY_UNAVAILABLE"


def test_revise_twice_pauses_for_the_author_then_approve_anyway(tmp_path):
    fake = BookFakeAI(verdicts=["REVISE", "REVISE", "REJECT"])
    app = make_app(tmp_path, fake=fake)
    run = run_book(app)
    assert run["status"] == "paused" and run["pause_reason"] == "problem"
    prob = run["problem"]
    assert prob["code"] == "REVIEW_NOT_PASSED" and set(prob["options"]) == {"approve_anyway", "edit", "retry"}
    assert prob["where"]["step"] == "Characters and places" and prob["record_id"]
    assert fake.kinds.count("fix") == 2
    assert steps(run)["canon"]["state"] == "paused" and steps(run)["premise"]["state"] == "pending"
    head = app.store.history(run["project_id"], "main", prob["record_id"])[-1]
    assert head["lifecycle"] == "DRAFT" and head["version"] == 3  # two AI fixes, nothing approved
    with pytest.raises(BookforgeError):
        app.autobook.decide("author", run["id"], {"action": "approve_anyway"})  # needs author_confirms
    app.autobook.decide("author", run["id"], {"action": "approve_anyway", "author_confirms": True})
    app.autobook.wait_for(run["id"], 120)
    run = app.autobook.public(app.autobook.get(run["id"]))
    assert run["status"] == "done", run["phase"]
    by_author = outbox(app, run["project_id"], "review.approved_by_author")
    assert by_author and prob["record_id"] in by_author[0]["record_ids"]
    j = journal.build(app, run["project_id"], "main")
    kinds = {e["approval"] for e in j["entries"] if e["kind"] == "approval"}
    assert {"author", "run_consent"} <= kinds


def test_retry_decision_gives_the_ai_two_more_fixes(tmp_path):
    fake = BookFakeAI(verdicts=["REVISE"] * 4)  # paused after 2 fixes; after "try again" one more fix passes
    app = make_app(tmp_path, fake=fake)
    run = run_book(app)
    assert run["problem"]["code"] == "REVIEW_NOT_PASSED"
    app.autobook.decide("author", run["id"], {"action": "retry"})
    app.autobook.wait_for(run["id"], 120)
    run = app.autobook.public(app.autobook.get(run["id"]))
    assert run["status"] == "done" and fake.kinds.count("fix") == 3


def test_pause_resume_and_cancel(tmp_path):
    import threading
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    fake.gate = threading.Event()
    r = app.autobook.start("author", {"author_confirms": True})
    for _ in range(200):
        if app.autobook.get(r["id"]).get("current") == "profile":
            break
        time.sleep(0.01)
    app.autobook.pause("author", r["id"])
    assert app.autobook.get(r["id"])["status"] == "pausing"
    fake.gate.set()
    app.autobook.wait_for(r["id"], 60)
    run = app.autobook.get(r["id"])
    assert run["status"] == "paused" and run["pause_reason"] == "author"
    done_before = [s["id"] for s in run["steps"] if s["state"] == "done"]
    assert "backup" in done_before and "check" not in done_before
    fake.gate = None
    app.autobook.resume("author", r["id"])
    app.autobook.wait_for(r["id"], 120)
    run = app.autobook.get(r["id"])
    assert run["status"] == "done"
    assert sum(1 for k in fake.kinds if k == "profile") == 1 or "profile" not in done_before
    # cancel a second run while it waits for the AI
    fake.gate = threading.Event()
    r2 = app.autobook.start("author", {"author_confirms": True})
    time.sleep(0.2)
    app.autobook.cancel("author", r2["id"])
    fake.gate.set()
    app.autobook.wait_for(r2["id"], 60)
    assert app.autobook.get(r2["id"])["status"] == "cancelled"
    with pytest.raises(BookforgeError):
        app.autobook.resume("author", r2["id"])


def test_restart_shows_interrupted_and_resumes(tmp_path):
    import threading
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    fake.gate = threading.Event()
    r = app.autobook.start("author", {"author_confirms": True})
    time.sleep(0.2)
    app.autobook.pause("author", r["id"])
    fake.gate.set()
    app.autobook.wait_for(r["id"], 60)
    # simulate BookForge stopping in the middle of a step: the saved state still says "running"
    saved = app.autobook.get(r["id"])
    saved["status"] = "running"
    app.jobstore.save(saved)
    app.store.close()
    fake.gate = None
    app2 = make_app(tmp_path, fake=fake)  # a new App on the same data folder = a restart
    run = app2.autobook.get(r["id"])
    assert run["status"] == "interrupted" and "Resume" in run["phase"]
    jobs = app2.route("GET", "/api/jobs", {}, None, "author", {})[1]
    assert jobs["interrupted"] >= 1 and any(j["id"] == r["id"] and j["resumable"] for j in jobs["jobs"])
    app2.autobook.resume("author", r["id"])
    app2.autobook.wait_for(r["id"], 120)
    assert app2.autobook.get(r["id"])["status"] == "done"


# ---------------------------------------------------------------------------------------------- S10 / TIMEOUT
def test_retry_queue_waits_on_busy_then_succeeds(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    busy = [BookforgeError("RATE_LIMITED", "", "the web site is busy with another bridge request (SITE_BUSY: x)")
            for _ in range(4)]
    fake.fail_kind("B01", *busy)
    run = run_book(app)
    assert run["status"] == "done", run.get("problem")
    waits = [e for e in app.autobook.get(run["id"])["events"] if e["kind"] == "wait"]
    assert waits and "busy" in waits[0]["message"] and "retrying in" in waits[0]["message"]


def test_wait_and_retry_policy_backoff_and_timeout():
    slept = []
    policy = RetryPolicy([15, 30, 60], 120, sleep=slept.append)
    calls = {"n": 0}
    infos = []

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise BookforgeError("UPSTREAM_UNAVAILABLE", "", "bridge down")
        return "ok"
    assert wait_and_retry(flaky, policy=policy, on_wait=infos.append, who="Claude") == "ok"
    assert abs(sum(slept) - 45) < 0.01
    msgs = [i["message"] for i in infos if i]
    assert msgs == ["Waiting for Claude (not reachable) — retrying in 15 s",
                    "Waiting for Claude (not reachable) — retrying in 30 s"]

    def timeout():
        raise BookforgeError("TIMEOUT", "", "no answer")
    slept.clear()
    with pytest.raises(BookforgeError) as exc:
        wait_and_retry(timeout, policy=policy)
    assert exc.value.code == "TIMEOUT" and not slept  # never retried automatically

    def always_busy():
        raise BookforgeError("RATE_LIMITED", "", "busy")
    with pytest.raises(BookforgeError) as exc:
        wait_and_retry(always_busy, policy=RetryPolicy([15, 30, 60], 100, sleep=lambda s: None))
    assert exc.value.code == "RATE_LIMITED" and "stopped waiting" in exc.value.errors[0]["message"]


def test_timeout_pauses_the_step_not_the_run(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    fake.fail_kind("B03", BookforgeError("TIMEOUT", "", "provider timed out"))
    run = run_book(app)
    st = steps(run)
    assert run["status"] == "paused" and run["problem"]["code"] == "TIMEOUT"
    assert st["plot"]["state"] == "paused" and st["plot"]["problem"]["fix"]
    assert st["premise"]["state"] == "done" and st["outline"]["state"] == "pending"
    assert run["problem"]["where"]["op"] == "B03" and run["problem"]["options"] == ["retry"]
    app.autobook.resume("author", run["id"])
    app.autobook.wait_for(run["id"], 120)
    assert app.autobook.get(run["id"])["status"] == "done"


# ---------------------------------------------------------------------------------------------- S2
def approved_outline(app, n=2):
    pid = app.engine.bootstrap_project("author", "Outlined book")
    save_profile(app.store, pid, {"title": "Outlined", "idea": "A keeper vanishes.", "length": "short_story",
                                  "chapters": n})
    bp = lambda: BookPath(app.engine, "author", pid, "main")  # noqa: E731

    def mk(op, payload, cand):
        ref, _ = bp().create(op, payload, manual_candidate=cand)
        assert bp().approve_ref(ref)["ok"]
        return ref
    mk("A04", {"concept": "Gullhaven Harbor"}, {"concept": "Gullhaven Harbor", "attributes": {}, "linked_refs": [],
                                                 "protected_fact_flags": [],
                                                 "facts": [fact("gullhaven-harbor", "entity.name", "Gullhaven Harbor")]})
    mk("A01", {"concept": "Mara Vell"}, {"concept": "Mara Vell", "attributes": {}, "linked_refs": [],
                                         "protected_fact_flags": [], "facts": [fact("mara-vell", "entity.name", "Mara Vell")]})
    mk("B01", bp().payload_for("B01"), {"premise": "p", "dramatic_question": "q", "concept_summary": "s"})
    mk("B03", bp().payload_for("B03"), {"main_plot": {"summary": "s", "facts": [], "links": []}, "objectives": [],
                                        "plot_obligations": []})
    mk("B11", bp().payload_for("B11"), {"chapters": [plan_item(f"ch{i + 1}", i, "go") for i in range(n)],
                                        "unresolved_threads": []})
    return pid


def test_write_all_chapters(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    pid = approved_outline(app, 3)
    j = app.write_all.start("author", pid, "main")
    app.write_all.wait_for(j["id"], 60)
    j = app.write_all.public(app.write_all.get(j["id"]))
    assert j["status"] == "done" and j["done"] == j["total"] == 3
    assert fake.kinds.count("C02") == 3
    q = app.review.queue("author", pid, "main")
    c02 = [i for i in q["items"] if i["module_id"] == "C02"]
    assert len(c02) == 3 and all(i["lifecycle"] == "DRAFT" for i in c02)  # drafts wait for the author
    assert not outbox(app, pid, "review.approved_by_author") and not outbox(app, pid, "autobook.approved_under_consent")
    st = BookPath(app.engine, "author", pid, "main").status()
    assert st["words"]["draft_words"] > 0 and st["words"]["approved_words"] == 0
    # nothing left to write: a second run finishes at once
    j2 = app.write_all.start("author", pid, "main")
    app.write_all.wait_for(j2["id"], 30)
    assert app.write_all.get(j2["id"])["status"] == "done" and fake.kinds.count("C02") == 3


def test_write_all_timeout_stops_on_that_chapter_and_try_again(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    pid = approved_outline(app, 2)
    fake.fail_kind("C02", BookforgeError("TIMEOUT", "", "timed out"))
    j = app.write_all.start("author", pid, "main")
    app.write_all.wait_for(j["id"], 60)
    j = app.write_all.get(j["id"])
    assert j["status"] == "error" and j["problem"]["code"] == "TIMEOUT" and j["problem"]["chapter_id"] == "ch1"
    assert j["items"][0]["state"] == "failed"
    app.write_all.resume("author", j["id"])
    app.write_all.wait_for(j["id"], 60)
    assert app.write_all.get(j["id"])["status"] == "done"


# ---------------------------------------------------------------------------------------------- R12 / S8 / S9
def test_health_checks(tmp_path):
    app = make_app(tmp_path, fake=BookFakeAI())
    h = app.health.run(force=True)
    ids = {c["id"] for c in h["checks"]}
    assert {"database", "disk", "backups", "slot-AI-1", "bridge", "exports", "jobs"} <= ids
    assert {c["id"]: c for c in h["checks"]}["backups"]["status"] == "warn"  # no backup yet
    run = run_book(app)
    h = app.health.run(force=True)
    by = {c["id"]: c for c in h["checks"]}
    assert by["backups"]["status"] == "ok" and by["exports"]["status"] == "ok" and h["overall"] == "ok"
    # a damaged export file is found
    f = run["files"][0]
    rec = app.store.get_record(run["project_id"], "main", f["record_id"], f["version"])
    path = app.store.asset_dir / rec["binary"]["storage_uri"].split("/")[-1]
    path.write_bytes(b"damaged")
    h = app.health.run(force=True)
    by = {c["id"]: c for c in h["checks"]}
    assert by["exports"]["status"] == "problem" and by["exports"]["code"] == "HASH_MISMATCH" and by["exports"]["fix"]
    assert h["overall"] == "problem"
    # cached between calls unless forced
    assert app.health.run() is app.health.run()


def test_diagnostics_contain_no_secrets_or_book_text(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    app.engine.providers.configure_slot("AI-2", {"adapter_id": "anthropic", "api_key": FAKE_KEY})
    run = run_book(app)
    assert run["status"] == "done"
    chapter = CHAPTER_TEXT[1][0]
    app.errors.add(400, "POST", "/api/dispatch", [{"code": "INVALID_INPUT", "path": "/payload/text",
                                                   "message": f"'{chapter}' is too long; key {FAKE_KEY}"}])
    from bookforge import diagnostics
    rep = diagnostics.build(app, {"user_agent": "test", "errors": [{"code": "NETWORK", "message": f"x {FAKE_KEY}"}]})
    raw = json.dumps(rep, ensure_ascii=False) + diagnostics.render_text(rep)
    assert FAKE_KEY not in raw and TOKEN not in raw
    assert chapter not in raw and chapter[:40] not in raw
    assert "The Keeper of Gullhaven" not in raw  # no book titles
    assert "Rowan Ashby" not in raw and "fog-bound harbor" not in raw
    assert rep["app"]["version"] and rep["system"]["python"] and rep["health"]["checks"]
    assert any(s["slot_id"] == "AI-2" and s["key_saved"] for s in rep["ai_slots"])
    assert any(j["kind"] == "autobook" for j in rep["jobs"])
    assert rep["recent_errors"][-1]["code"] == "INVALID_INPUT"


def test_backups_rotation_and_guarded_restore(tmp_path):
    app = make_app(tmp_path)
    p1 = app.engine.bootstrap_project("author", "Before backup")
    app.backups.set_keep(3)
    # BF-05: only automatic backups rotate; "Back up now" copies and restore safety copies are pinned
    manual = app.backups.backup("manual")["name"]
    names = [app.backups.backup("before-export")["name"] for _ in range(5)]
    kept = [b["name"] for b in app.backups.list() if not b["pinned"]]
    assert len(kept) == 3 and set(kept) == set(names[-3:]) and all(b["verified"] for b in app.backups.list())
    assert manual in [b["name"] for b in app.backups.list()]
    p2 = app.engine.bootstrap_project("author", "After backup")
    with pytest.raises(BookforgeError) as exc:
        app.backups.restore(kept[0], {"author_confirms": True})  # the word RESTORE is missing
    assert exc.value.code == "APPROVAL_REQUIRED"
    with pytest.raises(BookforgeError) as exc:
        app.backups.restore("../etc", {"author_confirms": True, "confirm": "RESTORE"})
    assert exc.value.code == "NOT_FOUND"
    out = app.backups.restore(kept[0], {"author_confirms": True, "confirm": "RESTORE"})
    assert out["safety_backup"].endswith("before-restore")
    assert app.store.project(p1) is not None and app.store.project(p2) is None
    # 3 automatic + the pinned manual backup + the pinned safety copy
    assert len(app.backups.list()) == 5 and kept[0] in [b["name"] for b in app.backups.list()]
    # the safety copy can bring the later project back
    app.backups.restore(out["safety_backup"], {"author_confirms": True, "confirm": "restore"})
    assert app.store.project(p2) is not None


# ---------------------------------------------------------------------------------------------- R11 / S22 / HTTP
@pytest.fixture
def served(tmp_path):
    import threading
    from http.server import ThreadingHTTPServer
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield app, httpd.server_address[1], fake
    finally:
        httpd.shutdown()
        httpd.server_close()
        app.store.close()


def test_http_run_journal_and_shelf(served):
    app, port, fake = served
    status, run, _ = call(port, "POST", "/api/autobook", {"author_confirms": True, "length": "short_story"})
    assert status == 202 and run["status"] in ("queued", "running")
    app.autobook.wait_for(run["id"], 120)
    status, run, _ = call(port, "GET", f"/api/autobook/{run['id']}")
    assert status == 200 and run["status"] == "done" and run["elapsed_ms"] >= 0
    pid = run["project_id"]
    status, j, _ = call(port, "GET", f"/api/projects/{pid}/branches/main/journal")
    assert status == 200 and j["count"] > 10
    kinds = {e["kind"] for e in j["entries"]}
    assert {"ai", "ai_review", "approval", "backup", "export"} <= kinds
    assert any(e["approval"] == "run_consent" and e.get("run_id") == run["id"] for e in j["entries"])
    assert any(e["ai"] and e["ai"].get("model") == "fake-book-model" for e in j["entries"])
    status, jc, _ = call(port, "GET", f"/api/projects/{pid}/branches/main/journal?step=C02")
    assert status == 200 and jc["entries"] and all(e["step"]["op"] == "C02" for e in jc["entries"])
    status, md, resp = call(port, "GET", f"/api/projects/{pid}/branches/main/journal?format=md&download=1")
    text = md.decode()
    assert status == 200 and text.startswith("# 📜 Book journal") and "attachment" in resp.getheader("Content-Disposition")
    assert CHAPTER_TEXT[1][0][:30] not in text and "Task: invent" not in text
    status, jp, _ = call(port, "GET", f"/api/projects/{pid}/branches/main/journal?problems=1")
    assert status == 200 and all(e.get("problem") or e["kind"] in ("problem", "retry", "pause") for e in jp["entries"])
    # the shelf lists the finished book with verified files, newest first
    status, shelf, _ = call(port, "GET", "/api/shelf")
    assert status == 200 and shelf["books"][0]["project_id"] == pid and shelf["books"][0]["all_verified"]
    assert [f["format"] for f in shelf["books"][0]["files"]] == ["PDF", "EPUB", "DOCX"]
    f = shelf["books"][0]["files"][1]
    status, data, resp = call(port, "GET", f"/api/projects/{pid}/branches/main/assets/{f['record_id']}/{f['version']}")
    assert status == 200 and data[:2] == b"PK"
    # health, diagnostics, backups and jobs over HTTP
    assert call(port, "GET", "/api/health?force=1")[1]["overall"] in ("ok", "warn")
    status, dg, _ = call(port, "POST", "/api/diagnostics", {"client": {"user_agent": "pw", "errors": []}})
    assert status == 200 and dg["text"].startswith("BookForge diagnostics")
    status, txt, resp = call(port, "GET", "/api/diagnostics?download=1")
    assert status == 200 and "attachment" in resp.getheader("Content-Disposition")
    status, b, _ = call(port, "GET", "/api/backups")
    assert status == 200 and len(b["backups"]) >= 3 and b["keep"] == 10
    status, jobs, _ = call(port, "GET", "/api/jobs")
    assert status == 200 and any(x["kind"] == "autobook" for x in jobs["jobs"])
    status, rs, _ = call(port, "PUT", "/api/settings/ai-retry", {"delays_s": [10, 20], "max_total_s": 300})
    assert status == 200 and rs["delays_s"] == [10, 20]
    assert call(port, "PUT", "/api/settings/ai-retry", {"delays_s": [0]})[0] == 400


def test_endpoints_return_structured_errors_without_tracebacks(served):
    app, port, fake = served
    pid = app.engine.bootstrap_project("author", "Errors")
    cases = [
        ("GET", f"/api/projects/{pid}/branches/main/assets/X/notanumber", None, 400),
        ("GET", "/api/autobook/run-nope", None, 404),
        ("POST", "/api/autobook", {}, 400),
        ("POST", "/api/autobook/run-nope/decide", {"action": "x"}, 404),
        ("GET", f"/api/projects/{pid}/branches/main/journal?step=bad!", None, 400),
        ("POST", "/api/backups/nope/restore", {"author_confirms": True, "confirm": "RESTORE"}, 404),
        ("POST", "/api/backups/nope/restore", {}, 400),
        ("PUT", "/api/backups/settings", {"keep": 0}, 400),
        ("POST", "/api/jobs/job-nope/resume", None, 404),
        ("POST", f"/api/projects/{pid}/branches/main/book/write-all", None, 400),
        ("GET", "/api/no/such/thing", None, 404),
    ]
    for method, path, body, want in cases:
        status, out, _ = call(port, method, path, body)
        assert status == want, (method, path, status, out)
        e = out["errors"][0]
        assert set(e) >= {"code", "path", "message"} and "Traceback" not in json.dumps(out), (path, out)
    status, out, _ = call(port, "POST", "/api/dispatch", b"{not json", content_type="application/json; charset=utf-8")
    assert status == 400 and out["errors"][0]["code"] == "INVALID_INPUT"

    def boom(force=False):
        raise RuntimeError("secret internal detail")
    app.health.run = boom
    status, out, _ = call(port, "GET", "/api/health")
    assert status == 500 and out["errors"][0]["code"] == "INTERNAL_ERROR"
    assert "secret internal detail" not in json.dumps(out) and "Traceback" not in json.dumps(out)
    assert app.errors.recent()[-1]["code"] == "INTERNAL_ERROR"


def test_jobstore_marks_live_work_interrupted(tmp_path):
    from bookforge.store import Store
    store = Store(tmp_path / "d")
    js = JobStore(store)
    js.save({"id": "assist-1", "kind": "assist", "status": "running"})
    js.save({"id": "assist-2", "kind": "assist", "status": "done"})
    assert js.mark_interrupted() == 1
    assert js.get("assist-1")["status"] == "interrupted" and js.get("assist-2")["status"] == "done"
    assert [j["id"] for j in js.list(kind="assist")] and js.list(kind="nope") == []
    store.close()


def test_problem_table_covers_every_error_code():
    """R1-R3: one plain-language table (web/problems.js) maps every kernel error code."""
    from pathlib import Path
    from bookforge.errors import ERROR_CODES
    src = (Path(__file__).resolve().parent.parent / "bookforge" / "web" / "problems.js").read_text(encoding="utf-8")
    missing = [c for c in ERROR_CODES if f"{c}:" not in src]
    assert not missing, missing
    for extra in ("NETWORK", "HTTP_500", "REVIEW_NOT_PASSED", "INTERRUPTED", "SITE_BUSY", "NOT_APPLICABLE"):
        assert f"{extra}:" in src, extra
