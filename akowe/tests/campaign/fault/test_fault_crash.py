"""Crash mid-step (fault campaign): the real server in a subprocess is SIGKILLed during Make-a-book, during parallel
writes and during backups, then restarted on the same data folder. After every crash: SQLite integrity_check, every
record's head/version chain, lifecycle rows, audit/receipt references, asset bytes vs. their hashes, no live job left
behind, and the run either resumes to a finished book or stops with a clearly reported problem."""
from __future__ import annotations

import random
import sqlite3
import threading
import time

import pytest

from akowe.autobook import verify_file
from akowe.store import Store

from fault_helpers import LIVE, Proc, call, check_store, jobs, poll

RUN_BODY = {"author_confirms": True, "genre": "Mystery", "length": "short_story"}


def _runs(data):
    return [j for j in jobs(data) if j.get("kind") == "autobook"]


def _finish(p: Proc, rid: str, timeout=90) -> dict:
    def settled():
        st, b = p.call("GET", f"/api/autobook/{rid}")
        return b if st == 200 and b["status"] not in LIVE else None
    return poll(settled, timeout)


def _crash_then_resume(tmp_path, *kill_args):
    data = tmp_path / "data"
    p = Proc(data, *kill_args)
    try:
        p.call("POST", "/api/autobook", RUN_BODY)
    except OSError:
        pass  # killed before it could answer
    assert p.wait_dead(60), "the kill point was never reached"
    p.kill()
    p = Proc(data)
    try:
        assert check_store(data) == []
        runs = _runs(data)
        assert len(runs) == 1
        assert not [j for j in jobs(data) if j.get("status") in LIVE], "live work survived a restart"
        rid = runs[0]["id"]
        st, b = p.call("GET", "/api/jobs")
        assert st == 200 and any(j["id"] == rid and j["resumable"] for j in b["jobs"])
        st, _ = p.call("POST", f"/api/jobs/{rid}/resume")
        assert st == 200
        run = _finish(p, rid)
        return data, p, run
    except BaseException:
        p.kill()
        raise


def _projects(data):
    conn = sqlite3.connect(data / "akowe.sqlite3")
    try:
        return conn.execute("SELECT project_id, name, settings FROM projects ORDER BY created_at").fetchall()
    finally:
        conn.close()


def _assert_finished_book(p, data, run):
    assert run["status"] == "done", (run["status"], run.get("problem"))
    assert {f["format"] for f in run["files"]} == {"PDF", "EPUB", "DOCX"}
    store = Store(data)
    try:
        for f in run["files"]:
            rec = store.get_record(run["project_id"], "main", f["record_id"], f["version"])
            ok, why = verify_file(f["format"], store.read_binary(rec))
            assert ok, why
    finally:
        store.close()
    assert check_store(data) == []


# ---------------------------------------------------------------------------------------------- sweep
# Kill points (commit numbers) chosen outside the three windows pinned by the dedicated tests below.
SWEEP = [("--kill-after-commit", n) for n in (2, 4, 9, 12, 20, 35, 50, 70, 95, 120, 150, 172)] + \
        [("--kill-before-commit", n) for n in (5, 30, 100, 160)]


@pytest.mark.parametrize("flag,n", SWEEP, ids=[f"{f[7:]}{n}" for f, n in SWEEP])
def test_make_a_book_survives_sigkill_at_commit_n(tmp_path, flag, n):
    data, p, run = _crash_then_resume(tmp_path, flag, str(n))
    try:
        _assert_finished_book(p, data, run)
        assert len(_projects(data)) == 1
    finally:
        p.kill()


def test_make_a_book_survives_sigkill_at_random_times(tmp_path):
    rnd = random.Random(20261023)
    for i in range(4):
        data = tmp_path / f"d{i}"
        p = Proc(data)
        st, b = p.call("POST", "/api/autobook", RUN_BODY)
        assert st == 202
        time.sleep(rnd.uniform(0.05, 1.0))
        p.kill()
        p = Proc(data)
        try:
            assert check_store(data) == [], i
            assert not [j for j in jobs(data) if j.get("status") in LIVE]
            run = _runs(data)[0]
            if run["status"] == "done":
                continue
            assert run["status"] == "interrupted"
            p.call("POST", f"/api/jobs/{run['id']}/resume")
            out = _finish(p, run["id"])
            # either a finished book or a clearly reported stop (never a silent hang)
            assert out["status"] == "done" or (out["status"] == "paused" and out["problem"]["message"]), out
            assert check_store(data) == []
        finally:
            p.kill()


# ---------------------------------------------------------------------------------------------- pinned windows
ORPHAN = ("SELECT EXISTS(SELECT 1 FROM projects) AND NOT EXISTS(SELECT 1 FROM settings WHERE key LIKE 'job:%' "
          "AND json_extract(value, '$.project_id') IS NOT NULL)")
TITLE_SAVED = ("SELECT EXISTS(SELECT 1 FROM settings WHERE key LIKE 'book_profile:%' AND "
               "json_extract(value, '$.title') IS NOT NULL) AND EXISTS(SELECT 1 FROM projects WHERE name LIKE 'New book%')")
CANON_PARTIAL = ("SELECT EXISTS(SELECT 1 FROM heads WHERE module_id IN ('A03','A04')) AND "
                 "NOT EXISTS(SELECT 1 FROM heads WHERE module_id='A01')")


def test_crash_right_after_the_project_is_created_leaves_one_book(tmp_path):
    data, p, run = _crash_then_resume(tmp_path, "--kill-when", ORPHAN)
    try:
        assert run["status"] == "done"
        names = [r[1] for r in _projects(data)]
        assert names == [run["title"]], names
    finally:
        p.kill()


def test_crash_after_profile_saved_still_names_the_book(tmp_path):
    """NEW-fault-6: the AI profile and the book's name are now saved in ONE transaction, so there is no commit at
    which the title is saved and the book is still 'New book (being made…)': the kill point is never reached and
    the run makes a correctly named book. (Resume also renames a book left unnamed by an older Akọwe: see
    test_resume_names_a_book_left_unnamed in the flow campaign.)"""
    data = tmp_path / "data"
    p = Proc(data, "--kill-when", TITLE_SAVED)
    try:
        st, b = p.call("POST", "/api/autobook", RUN_BODY)
        assert st == 202, b
        run = _finish(p, b["id"])
        assert p.p.poll() is None, "a commit saved the title while the book was still unnamed"
        assert run["status"] == "done"
        names = [r[1] for r in _projects(data)]
        assert names == [run["title"]], names
        st, shelf = p.call("GET", "/api/shelf")
        assert [b.get("title") for b in shelf["books"]] == [run["title"]], shelf
    finally:
        p.kill()


def test_crash_during_canon_creation_can_still_finish(tmp_path):
    data, p, run = _crash_then_resume(tmp_path, "--kill-when", CANON_PARTIAL)
    try:
        for _ in range(2):  # the author presses Try again / Resume
            if run["status"] == "done":
                break
            if run["status"] == "paused":
                p.call("POST", f"/api/autobook/{run['id']}/decide", {"action": "retry"})
                p.call("POST", f"/api/autobook/{run['id']}/resume")
                run = _finish(p, run["id"])
        _assert_finished_book(p, data, run)
    finally:
        p.kill()


# ---------------------------------------------------------------------------------------------- parallel writes
def test_sigkill_during_parallel_http_writes_keeps_the_store_consistent(tmp_path):
    data = tmp_path / "data"
    p = Proc(data)
    st, proj = p.call("POST", "/api/projects", {"name": "Crash book"})
    pid = proj["project_id"]
    stop = threading.Event()

    def writer(i):
        try:
            base = None
            while not stop.is_set():
                if base is None:
                    st, b = p.call("POST", "/api/dispatch", {"request": {
                        "project_id": pid, "branch_id": "main", "target_operation": "A01", "action": "CREATE",
                        "payload": {"concept": f"Person {i}"}}})
                else:
                    st, b = p.call("POST", "/api/dispatch", {"request": {
                        "project_id": pid, "branch_id": "main", "target_operation": "A01", "action": "UPDATE",
                        "base_ref": base, "payload": dict(data_, concept=f"Person {i} {time.time()}")}})
                r = b["response"]
                if r["status"] == "DRAFT":
                    base, data_ = r["output_refs"][0], r["result"]
                call(p.port, "POST", f"/api/projects/{pid}/branches/main/uploads",
                     raw=f"asset {i} {time.time()}".encode() * 5000, content_type="image/png")
        except Exception:  # noqa: BLE001 - the server is killed under us
            pass
    ts = [threading.Thread(target=writer, args=(i,)) for i in range(6)]
    for t in ts:
        t.start()
    time.sleep(0.8)
    p.kill()
    stop.set()
    for t in ts:
        t.join(15)
    p = Proc(data)
    try:
        assert check_store(data) == []
        st, recs = p.call("GET", f"/api/projects/{pid}/branches/main/records")
        assert st == 200 and recs
        for r in recs:
            st, d = p.call("GET", f"/api/projects/{pid}/branches/main/records/{r['record_id']}")
            assert st == 200 and [v["version"] for v in d["versions"]] == list(range(1, r["latest_version"] + 1))
    finally:
        p.kill()


def test_sigkill_during_backups_never_lists_a_broken_backup(tmp_path):
    data = tmp_path / "data"
    p = Proc(data)
    st, proj = p.call("POST", "/api/projects", {"name": "Backup book"})
    pid = proj["project_id"]
    for i in range(20):
        call(p.port, "POST", f"/api/projects/{pid}/branches/main/uploads", raw=bytes([i]) * 200_000,
             content_type="image/png")
    stop = threading.Event()

    def loop():
        while not stop.is_set():
            try:
                p.call("POST", "/api/backups")
            except Exception:  # noqa: BLE001
                return
    t = threading.Thread(target=loop)
    t.start()
    time.sleep(0.7)
    p.kill()
    stop.set()
    t.join(15)
    p = Proc(data)
    try:
        assert check_store(data) == []
        st, b = p.call("GET", "/api/backups")
        assert st == 200 and b["backups"]
        for item in b["backups"]:
            problems = Store.verify_backup(data / "backups" / item["name"])
            if item["verified"]:
                assert problems == [], (item, problems)
        newest = next(x for x in b["backups"] if x["verified"])
        st, out = p.call("POST", f"/api/backups/{newest['name']}/restore", {"author_confirms": True,
                                                                          "confirm": "RESTORE"})
        assert st == 200, out
        assert check_store(data) == []
    finally:
        p.kill()
