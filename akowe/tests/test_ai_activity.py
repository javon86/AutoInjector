"""⚡ #116 the AI activity strip: the in-memory registry of AI work in flight (lifecycle, stages, outcomes, expiry,
thread safety), the plain words a ⚡ Make-a-book run gives each AI call (fake AI), and GET /api/activity."""
from __future__ import annotations

import threading
import time
import types

import pytest

from akowe import ai_activity
from akowe import providers as prov_mod
from akowe.errors import AkoweError

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


@pytest.fixture
def reg(monkeypatch):
    clock = Clock()
    r = ai_activity.Registry(keep_s=6.0, clock=clock)
    r.clock_obj = clock
    monkeypatch.setattr(ai_activity, "REGISTRY", r)
    return r


def rows(state=None):
    return [x for x in ai_activity.snapshot()["rows"] if state is None or x["state"] == state]


# ---------------------------------------------------------------------------------------------- lifecycle
def test_a_piece_of_work_answering_checking_done_then_gone_after_6_s(reg):
    with ai_activity.doing("Writing chapter 7 — 'The Brass Key'", done="Wrote chapter 7", book_id="p1",
                           book_title="The Keeper", chapter=7, chapters=20, run_id="run-1", kind="autobook"):
        assert rows() == []  # nothing until an AI is asked
        ai_activity.call_started("AI-1", "AI-1 · Claude")
        reg.clock_obj.t += 12
        [r] = rows()
        assert (r["state"], r["stage"], r["stage_words"]) == ("live", "answering", "AI is answering")
        assert (r["slot"], r["ai"], r["task"]) == ("AI-1", "AI-1 · Claude", "Writing chapter 7 — 'The Brass Key'")
        assert (r["chapter"], r["chapters"], r["book_title"], r["run_id"]) == (7, 20, "The Keeper", "run-1")
        assert r["elapsed_s"] == 12.0 and r["started_at"].endswith("Z")
        ai_activity.call_ended(None)
        assert rows()[0]["stage"] == "checking" and rows()[0]["stage_words"] == "Checking the answer"
        assert ai_activity.snapshot()["busy"] == 1
    [r] = rows()
    assert r["state"] == "done" and r["outcome"] == "done" and r["icon"] == "✔"
    assert r["done_text"] == "Done: Wrote chapter 7" and r["elapsed_s"] == 12.0
    assert ai_activity.snapshot()["busy"] == 0
    reg.clock_obj.t += 5.9
    assert rows("done") and rows()[0]["gone_in_s"] == pytest.approx(0.1, abs=0.01)
    reg.clock_obj.t += 0.2
    assert rows() == []  # kept ~6 s, then removed


def test_outcomes_failed_timeout_needs_you_stopped(reg):
    class StepProblem(Exception):
        problem = {"code": "REVIEW_NOT_PASSED"}

    class RunPaused(Exception):
        pass

    for exc, outcome, icon in ((AkoweError("TIMEOUT", "", "no answer"), "timeout", "⏳"),
                               (StepProblem(), "needs_you", "⚠"), (RunPaused(), "stopped", "■"),
                               (ValueError("x"), "failed", "✖")):
        reg.clear()
        with pytest.raises(type(exc)):
            with ai_activity.doing("Reviewing chapter 3"):
                ai_activity.call_started("AI-2", "AI-2 · ChatGPT")
                ai_activity.call_ended(exc if isinstance(exc, AkoweError) else None)
                raise exc
        [r] = rows()
        assert (r["outcome"], r["icon"]) == (outcome, icon), exc
        assert r["done_text"].endswith("Reviewing chapter 3")
    # a failed call that the caller swallowed (nothing answered after it) still ends as ✖ failed
    reg.clear()
    with ai_activity.doing("Editor reading chapter 3"):
        ai_activity.call_started("AI-2", "AI-2 · ChatGPT")
        ai_activity.call_ended(AkoweError("INVALID_INPUT", "", "bad answer"))
    assert rows()[0]["outcome"] == "failed"


def test_unnamed_call_is_one_row_and_waits_show_seconds_left(reg):
    ai_activity.call_started("AI-3", "AI-3 · Gemini", fallback="Writing the premise", book_id="p9")
    [r] = rows("live")
    assert r["task"] == "Writing the premise" and r["book_id"] == "p9"
    ai_activity.call_ended(None)
    assert rows("live") == [] and rows("done")[0]["done_text"] == "Done: Writing the premise"
    reg.clear()
    with ai_activity.doing("Writing chapter 2"):
        ai_activity.note_queued("AI-1")
        assert rows()[0]["stage"] == "queued" and rows()[0]["stage_words"] == "Waiting for the AI"
        ai_activity.call_started("AI-1", "AI-1 · Claude")
        ai_activity.call_ended(AkoweError("RATE_LIMITED", "", "busy"))
        ai_activity.note_wait({"code": "RATE_LIMITED", "retry_in_s": 30, "message": "…"})
        r = rows()[0]
        assert r["stage"] == "busy_wait" and r["stage_words"] == "Waiting after a busy site" and r["retry_in_s"] == 30
        reg.clock_obj.t += 12
        assert rows()[0]["retry_in_s"] == 18
        ai_activity.note_wait(None)
        ai_activity.call_started("AI-1", "AI-1 · Claude")
        ai_activity.call_ended(None)
    assert rows()[0]["outcome"] == "done"  # it answered in the end
    assert len(rows()) == 1  # ONE row for the piece of work, not one per try


def test_inner_work_replaces_outer_row_and_a_dead_thread_leaves_no_ghost(reg):
    with ai_activity.doing("Writing the chapters", step=14, steps=20):
        ai_activity.call_started("AI-1", "AI-1 · Claude")
        ai_activity.call_ended(None)
        with ai_activity.doing(None, chapter=4, chapters=9, chapter_id="ch4"):
            assert ai_activity.nice("chapter ch4") == "chapter 4"
            with ai_activity.doing("Reviewing chapter 4", done="Reviewed chapter 4"):
                ai_activity.call_started("AI-2", "AI-2 · ChatGPT")
                [r] = rows("live")
                assert (r["task"], r["chapter"], r["step"], r["steps"]) == ("Reviewing chapter 4", 4, 14, 20)
                ai_activity.call_ended(None)
        assert [x["done_text"] for x in rows("done")] == ["Done: Reviewed chapter 4"]
    reg.clear()

    def worker():
        try:
            with ai_activity.doing("Writers' room: pitching a twist"):
                ai_activity.call_started("AI-3", "AI-3 · Gemini")
                raise RuntimeError("the thread dies mid-call (no call_ended)")
        except RuntimeError:
            pass
    t = threading.Thread(target=worker)
    t.start()
    t.join()
    assert all(x["state"] == "done" for x in rows())  # ended by the scope; and never a live ghost
    reg._live[123456789] = reg._new({"task": "ghost", "_scope": 1}, "AI-1", "x", None)
    assert all(x["task"] != "ghost" for x in rows())


def test_thread_safety_many_workers_at_once(reg):
    reg.clock_obj = None
    ai_activity.REGISTRY.clock = time.time
    errors = []
    stop = threading.Event()

    def reader():
        while not stop.is_set():
            try:
                ai_activity.snapshot()
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

    def worker(n):
        try:
            for i in range(150):
                with ai_activity.doing(f"Worker {n} job {i}", book_id=f"p{n}"):
                    ai_activity.call_started(f"AI-{n % 3 + 1}", "x")
                    ai_activity.call_ended(None if i % 5 else AkoweError("TIMEOUT", "", "t"))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)
    rd = threading.Thread(target=reader)
    rd.start()
    ws = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
    for w in ws:
        w.start()
    for w in ws:
        w.join()
    stop.set()
    rd.join()
    assert not errors
    snap = ai_activity.snapshot()
    assert snap["busy"] == 0 and all(r["state"] == "done" for r in snap["rows"])
    assert len(snap["rows"]) <= ai_activity.MAX_DONE


def test_carry_gives_a_worker_thread_the_details_but_its_own_rows(reg):
    out = {}
    with ai_activity.doing("Beta readers reading the book", book_id="p1", step=19, steps=20):
        def work():
            ai_activity.call_started("AI-2", "AI-2 · ChatGPT")
            out["live"] = rows("live")
            ai_activity.call_ended(None)
        t = threading.Thread(target=ai_activity.carry(work))
        t.start()
        t.join()
    [r] = out["live"]
    assert (r["task"], r["book_id"], r["step"]) == ("Beta readers reading the book", "p1", 19)
    assert all(x["state"] == "done" for x in rows())


# ---------------------------------------------------------------------------------------------- ⚡ run, fake AI
@pytest.fixture
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def test_make_a_book_run_labels_every_ai_call_in_plain_words(tmp_path, no_provider_sleep):
    ai_activity.REGISTRY.clear()
    fake = BookFakeAI()
    seen = []
    submit = fake.submit

    def watching(*a, **kw):  # what the strip shows while the AI answers this call
        me = [r for r in ai_activity.snapshot()["rows"] if r["state"] == "live" and r["stage"] == "answering"]
        seen.extend(me)
        return submit(*a, **kw)
    fake.submit = watching
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"genre": "Mystery", "length": "short_story"})
    assert run["status"] == "done"
    tasks = [r["task"] for r in seen]
    for want in ("Inventing the book", "Writing the premise", "Reviewing the premise", "Writing the chapter outline",
                 "Planning scenes for chapter 1", "Checking the scenes of chapter 1", "Writing chapter 1",
                 "Reviewing chapter 1", "Editor reading chapter 1", "Checking chapter 1 against its plan",
                 "Updating the running notes after chapter 1", "Writing chapter 2",
                 "Checking that the ending keeps the book's promises", "Book report: reading the whole book"):
        assert want in tasks, (want, sorted(set(tasks)))
    assert any(t.startswith("Checking chapters 1–") and "check" in t for t in tasks), sorted(set(tasks))
    assert not [t for t in tasks if "chapter ch" in t], "Akọwe's chapter ids leaked into the plain words"
    ch = next(r for r in seen if r["task"] == "Writing chapter 2")
    n = len([s for s in run["steps"] if s["id"] == "chapters"][0]["items"])
    assert (ch["chapter"], ch["chapters"], ch["run_id"], ch["kind"]) == (2, n, run["id"], "autobook")
    assert ch["step"] and ch["steps"] == len(run["steps"]) and ch["book_title"] == run["title"]
    assert ch["slot"] == "AI-1" and ch["ai"] and ch["book_id"] == run["project_id"]
    rv = next(r for r in seen if r["task"] == "Reviewing chapter 2")
    assert rv["slot"] == "AI-2"  # the independent reviewer shows as the other AI
    # the run is over: nothing is live; finished rows say ✔ Done in plain words
    snap = ai_activity.snapshot()
    assert snap["busy"] == 0
    assert any(r["done_text"] == "Done: Reviewed chapter 1" or r["done_text"].startswith("Done: ")
               for r in snap["rows"])

    # GET /api/activity: rows of this author's books only
    with ai_activity.doing("Writing chapter 9", book_id=run["project_id"]):
        ai_activity.call_started("AI-1", "AI-1 · Claude")
        started, release = threading.Event(), threading.Event()

        def elsewhere():
            with ai_activity.doing("Someone else's book", book_id="not-a-book-here"):
                ai_activity.call_started("AI-2", "x")
                started.set()
                release.wait(10)
                ai_activity.call_ended(None)
        other = threading.Thread(target=elsewhere)
        other.start()
        started.wait(10)
        assert len(rows("live")) == 2
        out = app.ai_activity("author")
        release.set()
        other.join()
        assert [r["task"] for r in out["rows"] if r["state"] == "live"] == ["Writing chapter 9"]
        assert out["busy"] == 1 and out["now"]
        ai_activity.call_ended(None)


def test_one_row_per_ai_a_finished_row_gives_way_to_new_work(reg):
    for task in ("Writing chapter 1", "Reviewing chapter 1"):
        with ai_activity.doing(task):
            ai_activity.call_started("AI-1", "AI-1 · Claude")
            ai_activity.call_ended(None)
    assert [r["done_text"] for r in rows()] == ["Done: Reviewing chapter 1"]  # only the newest per AI
    with ai_activity.doing("Editor reading chapter 1"):
        ai_activity.call_started("AI-3", "AI-3 · Gemini")
        assert [(r["slot"], r["state"]) for r in rows()] == [("AI-3", "live"), ("AI-1", "done")]
        with ai_activity.doing("Writing chapter 2"):
            pass
        ai_activity.call_started("AI-1", "AI-1 · Claude")  # AI-1 works again: its finished row goes
        assert [(r["slot"], r["state"]) for r in rows()] == [("AI-1", "live")]
