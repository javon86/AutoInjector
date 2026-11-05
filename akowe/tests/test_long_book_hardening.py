"""PR #122 — hardening for long books (the 40–50-chapter pre-mortem): every item has its tests here.

1. each AI call of a chapter gets its own full deadline; the chapter's deadline grows with its scenes
2. a time-out first collects the late answer, then moves the call to another AI (or asks the same one again after a
   wait), and only then pauses — a late answer is never used twice
3. a refusal or JSON still broken after the re-asks moves to another AI; a re-ask sends only the correction when the
   bridge says the chat can be continued
4. every AI at its usage limit: the run waits (plain words, a resume time) and goes on by itself; one AI left: the
   run keeps going and lists the chapters for the author's check later (or waits for a second AI)
5. concurrency guards: check-now start lock, no ⚡ start during a whole-book check, no writers' room during a run
6. a hand edit redoes only the checkpoints (and parts) that read the chapter
7. backups hard-link unchanged assets; pinned backups are capped; Akọwe's own log rotates by size
8. the real (OneDrive) Documents folder, a plain warning for synced folders
9. a too-long file path is shortened (or that one file is left out), never the whole save
10. the story so far scales with the book and keeps every chapter
plus a 25-chapter book with the fake AI that survives time-outs, refusals and usage limits.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import types
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

from akowe import backups as backups_mod
from akowe import book_save, check_now, checkpoints, jobs, lengths, story_ledger, usage_limits, writers_room
from akowe import providers as prov
from akowe.errors import AkoweError
from akowe.jobs import RetryPolicy, wait_and_retry
from akowe.server import App, add_log_file

from autobook_fake import BookFakeAI
from test_failover_review import SlotFake, make_app as make_slot_app

BR = "main"
TOKEN = "bridge-token-abcdefghijklmnopqrstuvwxyz"
OUT = {"x": "y"}
SCHEMA = {"type": "object", "properties": {"x": {"type": "string"}}, "required": ["x"]}


@pytest.fixture(autouse=True)
def _clean_limits():
    usage_limits.clear()
    yield
    usage_limits.clear()


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# ====================================================================== a contract fake bridge with late answers
class LateBridge:
    """Bridge v1.2 fake. ``plan[site]``: outcomes consumed per NEW request id (not a join):
    ("ok", text[, extra]) | ("late", text) = 504 typed:true, the answer arrives for the same id |
    ("lost",) = 504 typed:true and the join gets 504 late_expired | ("untyped",) = 504 typed:false |
    ("nofollow",) = 409 FOLLOWUP_UNAVAILABLE (PR #123: the chat of a follow-up is no longer the current one)."""

    def __init__(self):
        self.plan: dict[str, list] = {}
        self.requests: list[dict] = []
        self.typed: list[dict] = []           # prompts that were typed into a site
        self.late: dict[str, dict] = {}       # request id -> the late answer (or None: lost)
        self.done: dict[str, dict] = {}
        bridge = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._send(200, {"ok": True, "bridge_version": "1.2", "sites": {
                    s: {"ready": True, "busy": False, "state": "ok"} for s in ("chatgpt", "claude", "gemini")}})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
                bridge.requests.append(body)
                rid, site = body["request_id"], body["site"]
                if rid in bridge.done:
                    return self._send(200, bridge.done[rid])
                if rid in bridge.late:
                    hit = bridge.late.pop(rid)
                    if hit is None:
                        return self._send(504, {"ok": False, "error": "TIMEOUT", "typed": True, "late_expired": True,
                                                "ambiguous": True})
                    bridge.done[rid] = hit
                    return self._send(200, hit)
                step = (bridge.plan.get(site) or [("ok", json.dumps(OUT))]).pop(0) if bridge.plan.get(site) \
                    else ("ok", json.dumps(OUT))
                if step[0] == "untyped":
                    return self._send(504, {"ok": False, "error": "TIMEOUT", "typed": False, "ambiguous": False})
                if step[0] == "limit":  # PR #123: the site's usage-limit notice named a time (ISO 8601)
                    return self._send(503, {"ok": False, "error": "SITE_ERROR", "site_error": "rate-limit",
                                            "retry_after_s": 60, "limit_reset_at": step[1], "ambiguous": False})
                if step[0] == "nofollow":  # PR #123: the chat can't be continued; nothing typed (the step is used up)
                    return self._send(409, {"ok": False, "error": "FOLLOWUP_UNAVAILABLE", "ambiguous": False,
                                            "message": "a fresh chat was opened; send the whole prompt instead"})
                bridge.typed.append(body)
                seq = f"{len(bridge.typed):04d}"
                if step[0] == "lost":
                    bridge.late[rid] = None
                    return self._send(504, {"ok": False, "error": "TIMEOUT", "typed": True, "seq": seq,
                                            "late_window_ms": 20000, "ambiguous": True})
                res = {"ok": True, "site": site, "request_id": rid, "text": step[1], "seq": seq, "reply_to": seq}
                if len(step) > 2:
                    res.update(step[2])
                if step[0] == "late":
                    bridge.late[rid] = res
                    return self._send(504, {"ok": False, "error": "TIMEOUT", "typed": True, "seq": seq,
                                            "late_window_ms": 20000, "ambiguous": True})
                bridge.done[rid] = res
                self._send(200, res)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def bridge():
    b = LateBridge()
    yield b
    b.close()


def reg(tmp_path, url, sites=("claude",)):
    app = App(tmp_path / "data", token="app-token-123")
    pr = app.engine.providers
    pr.secret_path = tmp_path / "secrets.json"
    for sid, site in zip(("AI-1", "AI-2", "AI-3"), sites):
        pr.configure_slot(sid, {"adapter_id": "autoinjector", "site": site, "bridge_url": url, "api_key": TOKEN})
    pr.health.hold_s = 0.0
    return app, pr


def ctx_for(op_timeout_ms=180000, deadline_in_s=2):
    return SimpleNamespace(project_id="p", branch_id=BR, op_id="C02", op={"timeout_ms": op_timeout_ms},
                           request={"request_id": f"req-{time.time_ns()}",
                                    "deadline": _iso(datetime.now(timezone.utc) + timedelta(seconds=deadline_in_s))})


def gen(pr, ctx, slot_id=None):
    return pr.generate(ctx, task="t", output_schema=SCHEMA, context={}, capability="text", protected_facts=[],
                       slot_id=slot_id)


# ====================================================================== 1. a deadline per call
def test_each_ai_call_gets_its_own_full_deadline_and_the_chapter_deadline_grows_with_its_scenes(tmp_path, bridge):
    app, pr = reg(tmp_path, bridge.url)
    ctx = ctx_for(deadline_in_s=2)  # the chapter's deadline is almost used up by earlier scenes
    for _ in range(3):  # three scene calls under one C02 request
        assert gen(pr, ctx)[0] == OUT
    # every call to the web AI waited at least its own 300 s, never the 2 s left over
    assert len(bridge.requests) == 3 and all(r["timeout_ms"] >= 290000 for r in bridge.requests), \
        [r["timeout_ms"] for r in bridge.requests]
    # an API slot gets the operation's own time (180 s) per call; a longer request deadline is kept
    api = {"adapter_id": "anthropic"}
    dl = datetime.fromisoformat(prov.ProviderRegistry.call_deadline(ctx, api).replace("Z", "+00:00"))
    assert 170 <= (dl - datetime.now(timezone.utc)).total_seconds() <= 181
    far = ctx_for(deadline_in_s=3000)
    assert prov.ProviderRegistry.call_deadline(far, api) == far.request["deadline"]
    # the chapter-level deadline: 180 s × the calls a scene-by-scene chapter makes (scenes + continuation)
    plan = lengths.chapter_plan({"length": "novel"}, 25)
    assert plan["scene_by_scene"] and lengths.calls_per_chapter(plan) == max(2, plan["scenes"]) + 1
    assert lengths.calls_per_chapter(lengths.chapter_plan({"length": "short_story"})) == 2  # 1 call + 1 expand
    from akowe.book_path import BookPath, save_profile  # noqa: PLC0415
    pid = app.engine.bootstrap_project("author", "Long")
    save_profile(app.store, pid, {"title": "Long", "length": "novel"})
    seen = {}
    bp = BookPath(app.engine, "author", pid, BR)
    bp.engine = SimpleNamespace(dispatch=lambda req, principal, manual_candidate=None: seen.setdefault("r", req) or {})
    bp.dispatch("C02", "CREATE", payload={})
    left = (datetime.fromisoformat(seen["r"]["deadline"].replace("Z", "+00:00")) - datetime.now(timezone.utc))
    calls = lengths.calls_per_chapter(lengths.of_book(app.store, pid))
    assert calls >= 5 and left.total_seconds() >= 180 * calls - 5


# ====================================================================== 2. time-outs
def test_a_late_answer_is_collected_with_the_same_request_id_and_typed_only_once(tmp_path, bridge):
    app, pr = reg(tmp_path, bridge.url)
    bridge.plan["claude"] = [("late", json.dumps({"x": "late answer"}))]
    data, res = gen(pr, ctx_for())
    assert data == {"x": "late answer"} and res["ai_slot"] == "AI-1"
    assert len(bridge.typed) == 1  # never typed twice
    assert len(bridge.requests) == 2 and bridge.requests[0]["request_id"] == bridge.requests[1]["request_id"]


def test_a_lost_answer_moves_the_call_to_another_ai_and_the_late_answer_is_never_used(tmp_path, bridge):
    app, pr = reg(tmp_path, bridge.url, sites=("claude", "chatgpt"))
    notes = []
    pr.health.set_listener(notes.append)
    bridge.plan["claude"] = [("lost",)]
    bridge.plan["chatgpt"] = [("ok", json.dumps({"x": "from chatgpt"}))]
    data, res = gen(pr, ctx_for())
    assert data == {"x": "from chatgpt"} and res["ai_slot"] == "AI-2"
    assert notes and notes[0]["from"][0]["why"] == "timeout" and notes[0]["to"] == "AI-2"
    # nothing of claude's is kept for later: the same prompt to claude is a new request, not the old late one
    assert not [k for k in prov._LATE_TYPED if k[1] == "claude"]
    pr.health.set_listener(None)


def test_one_ai_that_timed_out_is_asked_once_more_after_a_wait_before_anything_pauses(tmp_path, bridge, monkeypatch):
    monkeypatch.setattr(prov.ProviderRegistry, "TIMEOUT_RETRY_WAIT_S", 0.01)
    app, pr = reg(tmp_path, bridge.url)
    bridge.plan["claude"] = [("untyped",), ("ok", json.dumps({"x": "second try"}))]
    assert gen(pr, ctx_for())[0] == {"x": "second try"}
    assert len(bridge.typed) == 1
    # still no answer after the second try: the work pauses (TIMEOUT) and the prompt was typed at most once each
    bridge.plan["claude"] = [("lost",), ("lost",)]
    with pytest.raises(AkoweError) as e:
        gen(pr, ctx_for())
    assert e.value.code == "TIMEOUT"


def test_an_ambiguous_time_out_from_an_older_bridge_is_never_sent_again_by_itself(tmp_path, bridge, monkeypatch):
    monkeypatch.setattr(prov.ProviderRegistry, "TIMEOUT_RETRY_WAIT_S", 0.01)
    app, pr = reg(tmp_path, bridge.url)
    real = prov.AutoInjectorAdapter._call

    def no_typed(self, method, path, body, timeout_s):  # a v1.0 bridge: a 504 that does not say "typed"
        if method == "POST":
            bridge.requests.append(body)
            err = AkoweError("TIMEOUT", "", "late")
            err.bridge_body = {}
            raise err
        return real(self, method, path, body, timeout_s)

    monkeypatch.setattr(prov.AutoInjectorAdapter, "_call", no_typed)
    with pytest.raises(AkoweError) as e:
        gen(pr, ctx_for())
    assert e.value.code == "TIMEOUT" and len(bridge.requests) == 1


# ====================================================================== 3. refusals, broken JSON, short re-asks
def test_a_refusal_after_the_re_asks_moves_to_another_ai(tmp_path, bridge):
    app, pr = reg(tmp_path, bridge.url, sites=("claude", "chatgpt"))
    bridge.plan["claude"] = [("ok", "I'm sorry, but I can't help with that.")] * 3
    bridge.plan["chatgpt"] = [("ok", json.dumps({"x": "written"}))]
    data, res = gen(pr, ctx_for())
    assert data == {"x": "written"} and res["ai_slot"] == "AI-2"
    assert [r["site"] for r in bridge.typed] == ["claude"] * 3 + ["chatgpt"]
    assert prov.looks_like_refusal("I can’t assist with this request.")
    assert not prov.looks_like_refusal('{"x": "I cannot"}') and not prov.looks_like_refusal("Here you go")


def test_broken_json_on_every_ai_still_ends_as_before(tmp_path, bridge):
    app, pr = reg(tmp_path, bridge.url, sites=("claude", "chatgpt"))
    bridge.plan["claude"] = [("ok", "{broken")] * 3
    bridge.plan["chatgpt"] = [("ok", "{broken")] * 3
    with pytest.raises(AkoweError) as e:
        gen(pr, ctx_for())
    assert e.value.code == "INTERNAL_ERROR" and "every working AI was asked" in e.value.errors[0]["message"]


def test_a_re_ask_sends_only_the_correction_when_the_bridge_can_continue_the_chat(tmp_path, bridge):
    app, pr = reg(tmp_path, bridge.url)
    bridge.plan["claude"] = [("ok", "{broken", {"followup": True}), ("ok", json.dumps(OUT))]
    assert gen(pr, ctx_for())[0] == OUT
    first, second = bridge.typed
    assert "Project context package" in first["prompt"]
    assert second["prompt"].startswith("Your last answer was not valid JSON") and len(second["prompt"]) < 600
    assert "Project context package" not in second["prompt"] and second["followup_of"] == first["request_id"]
    # a bridge that does not say so: the whole prompt again, as before
    bridge.plan["claude"] = [("ok", "{broken"), ("ok", json.dumps(OUT))]
    assert gen(pr, ctx_for())[0] == OUT
    assert "Project context package" in bridge.typed[-1]["prompt"] and "followup_of" not in bridge.typed[-1]


def test_a_short_re_ask_the_bridge_cannot_continue_becomes_the_whole_prompt(tmp_path, bridge):
    """Final hardening (PR #123): the bridge answers 409 FOLLOWUP_UNAVAILABLE when the chat changed (a fresh chat, the
    author typed there): nothing was typed, so Akọwe sends the whole prompt at once, in the same re-ask."""
    app, pr = reg(tmp_path, bridge.url)
    bridge.plan["claude"] = [("ok", "{broken", {"followup": True}), ("nofollow",), ("ok", json.dumps(OUT))]
    assert gen(pr, ctx_for())[0] == OUT
    first, second = bridge.typed
    assert [r.get("followup_of") is not None for r in bridge.requests] == [False, True, False]
    assert "Project context package" in second["prompt"] and "followup_of" not in second
    assert "rejected because it did not validate" in second["prompt"]  # the errors are still named
    assert second["request_id"] != first["request_id"] and second["request_id"].endswith("-full")


# ====================================================================== 4. usage limits
def test_wait_and_retry_waits_for_usage_limits_with_a_resume_time_and_goes_on_by_itself():
    slept, infos = [], []
    pol = RetryPolicy([1], 5, sleep=slept.append, limit_wait_s=3600, limit_check_s=300)
    n = {"i": 0}
    reset = time.time() + 600

    def fn():
        n["i"] += 1
        if n["i"] <= 2:
            exc = AkoweError("UPSTREAM_UNAVAILABLE", "", "no AI works")
            exc.usage_limited, exc.reset_at, exc.limited_names = True, reset, ["Claude", "ChatGPT"]
            raise exc
        return "written"

    assert wait_and_retry(fn, policy=pol, on_wait=infos.append) == "written"
    waits = [i for i in infos if i]
    assert waits[0]["kind"] == "usage_limit"
    assert waits[0]["message"].startswith("All AIs hit their usage limits — waiting; resumes by itself at about ")
    assert usage_limits.clock(reset + 15)[-2:] in ("AM", "PM")
    assert 590 <= sum(slept) <= 1300  # honoured the reset time, far beyond the 5 s busy budget
    # no reset time known: it checks every limit_check_s, and stops (plain words) after limit_wait_s
    pol2 = RetryPolicy([1], 5, sleep=lambda s: None, limit_wait_s=900, limit_check_s=300)

    def always():
        usage_limits.note(["Gemini"])
        raise AkoweError("UPSTREAM_UNAVAILABLE", "", "no AI works")  # through a dispatch: only the note says it

    infos.clear()
    with pytest.raises(AkoweError) as e:
        wait_and_retry(always, policy=pol2, on_wait=infos.append)
    assert "stayed at their usage limits" in e.value.errors[0]["message"]
    assert len([i for i in infos if i]) == 3 and "next check at about" in infos[0]["message"]
    # switched off (0): the old ~10-minute busy budget
    usage_limits.note(["Gemini"])
    with pytest.raises(AkoweError) as e:
        wait_and_retry(always, policy=RetryPolicy([1], 2, sleep=lambda s: None, limit_wait_s=0))
    assert "stayed busy or unreachable" in e.value.errors[0]["message"]
    assert jobs.clean_retry_settings({"limit_wait_s": 3 * 3600})["limit_wait_s"] == 10800
    with pytest.raises(AkoweError):
        jobs.clean_retry_settings({"limit_wait_s": 49 * 3600})


def test_generate_says_when_every_ai_is_at_its_usage_limit(tmp_path):
    fake = SlotFake()
    app = make_slot_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    pr = app.engine.providers
    for sid in ("AI-1", "AI-2"):
        fake.states[sid], fake.problems[sid] = "needs_user", "USAGE_LIMIT"
    with pytest.raises(AkoweError) as e:
        gen(pr, ctx_for())
    assert e.value.code == "UPSTREAM_UNAVAILABLE" and e.value.usage_limited
    assert usage_limits.current()["names"]
    # one of them is logged out instead: that needs the author, not a long wait
    fake.problems["AI-2"] = "LOGGED_OUT"
    with pytest.raises(AkoweError) as e:
        gen(pr, ctx_for())
    assert not getattr(e.value, "usage_limited", False) and usage_limits.current() is None


def test_the_reset_time_autoinjector_read_from_the_limit_notice_is_used(tmp_path, bridge):
    """Final hardening (PR #123): AutoInjector reads "until 3:40 PM" / "try again in 2 hours" from the site's notice
    and sends limit_reset_at (ISO 8601) — Akọwe's wait for the usage limits then resumes at that time."""
    from datetime import datetime, timezone  # noqa: PLC0415
    reset = time.time() + 7200
    iso = datetime.fromtimestamp(reset, timezone.utc).isoformat().replace("+00:00", "Z")
    app, pr = reg(tmp_path, bridge.url)
    bridge.plan["claude"] = [("limit", iso)] * 6
    with pytest.raises(AkoweError) as e:
        gen(pr, ctx_for())
    assert e.value.code == "UPSTREAM_UNAVAILABLE" and e.value.usage_limited
    assert abs(e.value.reset_at - reset) < 2
    assert abs(usage_limits.of_error(e.value)["reset_at"] - reset) < 2
    assert abs(prov._epoch_s(iso) - reset) < 2 and prov.normalize_site_info({"limit_reset_at": iso})["reset_at"]
    usage_limits.clear()


class LongFake(SlotFake):
    """SlotFake + scripted trouble for a long book: ``trouble`` = {submit number: kind} where kind is "timeout" (the
    AI's answer never came; the bridge said so), "refusal" (a refusal after the re-asks) or "limits" (every AI hits its
    usage limit; it lifts after ``limit_reads`` state reads)."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.trouble: dict[int, str] = {}
        self.limit_reads = 0
        self.seen: list[str] = []

    def site_state(self, slot):
        with self.lock:
            if self.limit_reads > 0:
                self.limit_reads -= 1
                if self.limit_reads == 0:
                    for sid in list(self.states):
                        self.states[sid], self.problems[sid] = "ok", None
        return super().site_state(slot)

    def submit(self, slot, system, user, schema):
        with self.lock:
            k = self.trouble.pop(self.n + 1, None)
        if k == "limits":
            with self.lock:
                self.n += 1
                for sid in ("AI-1", "AI-2", "AI-3"):
                    self.states[sid], self.problems[sid] = "needs_user", "USAGE_LIMIT"
                self.limit_reads = 40
                self.seen.append("limits")
            exc = AkoweError("UPSTREAM_UNAVAILABLE", "", "usage limit")
            exc.site_state, exc.site_problem = "needs_user", "USAGE_LIMIT"
            raise exc
        if k in ("timeout", "refusal"):
            with self.lock:
                self.n += 1
                self.seen.append(k)
            if k == "timeout":
                exc = AkoweError("TIMEOUT", "", "no answer in time")
                exc.bridge_body = {"typed": True, "late_expired": True}
            else:
                exc = AkoweError("INTERNAL_ERROR", "", "declined")
                exc.try_other_ai = True
            raise exc
        return super().submit(slot, system, user, schema)


def test_a_25_chapter_book_survives_time_outs_refusals_and_usage_limits(tmp_path):
    fake = LongFake()
    fake.max_chapters = 25
    fake.trouble = {40: "timeout", 90: "refusal", 140: "limits", 200: "timeout", 250: "refusal", 300: "limits"}
    app = make_slot_app(tmp_path, fake)
    pol = RetryPolicy([0.01, 0.02], 1, limit_wait_s=120, limit_check_s=0.02)
    for svc in (app.autobook, app.write_all, app.assist):
        svc.retry_policy = pol
    r = app.autobook.start("author", {"author_confirms": True, "length": "novel", "checkers": "one",
                                      "pictures": False})
    app.autobook.wait_for(r["id"], 900)
    run = app.autobook.get(r["id"])
    assert run["status"] == "done", (run.get("problem"), run.get("phase"))
    chapters = next(s for s in run["steps"] if s["id"] == "chapters")["items"]
    assert len(chapters) == 25 and all(i["state"] == "done" for i in chapters)
    assert fake.seen.count("timeout") == 2 and fake.seen.count("refusal") == 2 and fake.seen.count("limits") == 2, \
        (fake.n, fake.seen)
    codes = [e.get("code") for e in run["events"]]
    assert "USAGE_LIMIT_WAIT" in codes  # said once per wait, in plain words
    waits = [e["message"] for e in run["events"] if e.get("code") == "USAGE_LIMIT_WAIT"]
    assert waits and all(m.startswith("All AIs hit their usage limits — waiting; resumes by itself") for m in waits)
    assert not [e for e in run["events"] if e.get("kind") == "problem" and e.get("code") in ("TIMEOUT",)]


# ====================================================================== 4b. one AI left
def test_one_ai_keeps_going_and_lists_its_chapters_for_the_authors_check_later(tmp_path):
    from test_autobook import make_app, run_book  # noqa: PLC0415
    from akowe import approval_trust  # noqa: PLC0415
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake, second_ai=False)
    run = run_book(app, {"length": "short_story", "pictures": False}, trust_one_ai=False)
    assert run["status"] == "done", run.get("problem")  # default single_ai = continue: no pause at 2 a.m.
    assert any(x.startswith("chapter") for x in run["check_later"]), run["check_later"]
    hows = {e["how"] for e in approval_trust.entries(app.store, run["project_id"], BR)}
    assert hows == {"self_review_later"}
    lines = [e["line"] for e in approval_trust.entries(app.store, run["project_id"], BR)]
    assert all("needs your check later" in x for x in lines)
    assert any(e.get("code") == "NEEDS_CHECK_LATER" for e in app.autobook.get(run["id"])["events"])
    with pytest.raises(AkoweError):
        app.autobook.start("author", {"author_confirms": True, "single_ai": "sometimes"})


def test_one_ai_with_wait_waits_for_a_second_ai_and_lets_it_review(tmp_path):
    fake = SlotFake()
    app = make_slot_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    app.autobook.retry_policy = RetryPolicy([0.01, 0.02], 5, limit_wait_s=60, limit_check_s=0.05)
    fake.states["AI-2"], fake.problems["AI-2"] = "needs_user", "LOGGED_OUT"
    r = app.autobook.start("author", {"author_confirms": True, "length": "short_story", "pictures": False,
                                      "single_ai": "wait", "slot_id": "AI-1", "checkers": "one"})
    t0 = time.time()
    while time.time() - t0 < 60:
        run = app.autobook.get(r["id"])
        if (run.get("waiting") or {}).get("kind") == "second_ai":
            break
        time.sleep(0.02)
    assert (run.get("waiting") or {}).get("kind") == "second_ai", run.get("phase")
    assert "waiting for a second AI" in run["waiting"]["message"]
    fake.states["AI-2"], fake.problems["AI-2"] = "ok", None  # the author logged in again
    app.autobook.wait_for(r["id"], 300)
    run = app.autobook.get(r["id"])
    assert run["status"] == "done", run.get("problem")
    assert not run.get("check_later")  # every draft was reviewed by the second AI in the end


# ====================================================================== 5. concurrency guards
def test_check_now_kick_is_locked_and_a_run_waits_for_a_whole_book_check(tmp_path, monkeypatch):
    from test_autobook import make_app  # noqa: PLC0415
    app = make_app(tmp_path, fake=BookFakeAI())
    pid = app.engine.bootstrap_project("author", "Book")
    check_now._put(app.store, pid, BR, {"id": "now-1", "status": "queued", "label": "chapters 1–40", "by": "author"})
    spawned = []
    gate = threading.Event()
    alive = threading.Event()

    def slow_spawn(app_, principal, pid_, branch, req):
        spawned.append(req["id"])
        gate.wait(2)
        t = threading.Thread(target=lambda: alive.wait(10), daemon=True)
        check_now._THREADS[(pid_, branch)] = t
        t.start()

    monkeypatch.setattr(check_now, "_spawn", slow_spawn)
    ts = [threading.Thread(target=check_now._kick, args=(app, "author", pid, BR)) for _ in range(4)]
    for t in ts:
        t.start()
    time.sleep(0.2)
    gate.set()
    for t in ts:
        t.join(5)
    assert spawned == ["now-1"]  # two pages polling at once never start the same check twice
    why = check_now.solo_running(app, pid)
    assert why and "consistency check of chapters 1–40 is running" in why
    from akowe.book_path import save_profile  # noqa: PLC0415
    save_profile(app.store, pid, {"title": "Book", "idea": "x"})
    with pytest.raises(AkoweError) as e:
        app.autobook._start_locked("author", {"continue": {"project_id": pid, "title": "Book"}})
    assert e.value.code == "VERSION_CONFLICT" and "consistency check" in e.value.errors[0]["message"]
    alive.set()
    check_now._THREADS.pop((pid, BR), None)


def test_the_writers_room_does_not_meet_during_a_run_of_the_same_book(tmp_path, monkeypatch):
    from test_autobook import make_app  # noqa: PLC0415
    app = make_app(tmp_path, fake=BookFakeAI())
    pid = app.engine.bootstrap_project("author", "Book")
    monkeypatch.setattr(app.autobook, "active", lambda: [{"id": "run-1", "project_id": pid}])
    with pytest.raises(AkoweError) as e:
        writers_room.service_of(app).start("author", pid, BR, {"chapter": 1})
    assert e.value.code == "VERSION_CONFLICT" and "A book is being made" in e.value.errors[0]["message"]


# ====================================================================== 6. checkpoints after a hand edit
def test_a_hand_edit_redoes_only_the_checkpoints_and_parts_that_read_that_chapter(tmp_path):
    from test_autobook import make_app  # noqa: PLC0415
    app = make_app(tmp_path, fake=BookFakeAI())
    store = app.store
    pid = app.engine.bootstrap_project("author", "Book")

    def part(cids):
        return {"pieces": [{"chapter_id": c, "number": int(c[2:]), "piece": 1, "of": 1} for c in cids],
                "chapter_ids": cids, "done": True, "problems": [{"chapter": 1}], "summary": "read"}

    items = {
        "after-5": {"id": "after-5", "after": 5, "chapter_ids": [f"ch{i}" for i in range(1, 6)], "status": "done",
                    "parts": [part([f"ch{i}" for i in range(1, 6)])], "summary": "1-5"},
        "after-10": {"id": "after-10", "after": 10, "chapter_ids": [f"ch{i}" for i in range(6, 11)],
                     "status": "done", "parts": [part([f"ch{i}" for i in range(6, 11)])], "summary": "6-10"},
        "final": {"id": "final", "after": 15, "final": True, "chapter_ids": [f"ch{i}" for i in range(1, 16)],
                  "status": "done", "summary": "all",
                  "parts": [part([f"ch{i}" for i in range(1, 6)]), part([f"ch{i}" for i in range(6, 11)]),
                            part([f"ch{i}" for i in range(11, 16)])],
                  "problems": [{"id": "final-1-1", "chapter_id": "ch2", "status": "fixed"},
                               {"id": "final-2-1", "chapter_id": "ch7", "status": "fixed"},
                               {"id": "final-3-1", "chapter_id": "ch12", "status": "listed"}]},
    }
    store.set_setting(checkpoints._key(pid, BR), {"items": items, "version": 1})
    out = checkpoints.invalidate_from(store, pid, BR, "ch7", 7)
    assert sorted(out) == ["after-10", "final"]  # after-5 never read chapter 7: untouched
    cps = {c["id"]: c for c in checkpoints.items(store, pid, BR)}
    assert cps["after-5"]["status"] == "done" and "may_be_affected" not in cps["after-5"]
    assert cps["after-10"]["status"] == "new" and cps["after-10"]["parts"] is None  # its one part: read again
    fin = cps["final"]
    assert fin["status"] == "new" and fin["redo_parts"] == [2]
    assert fin["parts"][0]["done"] and fin["parts"][2]["done"] and not fin["parts"][1].get("done")
    assert {p["id"] for p in fin["problems"]} == {"final-1-1", "final-3-1"}
    # a chapter after every checkpoint that read it: later ones only get a note
    items2 = {"after-5": dict(items["after-5"], status="done"), "after-10": dict(items["after-10"], status="done")}
    store.set_setting(checkpoints._key(pid, BR), {"items": items2, "version": 1})
    assert checkpoints.invalidate_from(store, pid, BR, "ch3", 3) == ["after-5"]
    assert checkpoints.items(store, pid, BR)[1]["may_be_affected"]["number"] == 3


def test_each_checkpoint_is_its_own_settings_row_and_an_old_blob_moves_over(tmp_path):
    """Final hardening (PR #123): every part used to rewrite ONE blob holding every checkpoint and chapter check
    (megabytes by chapter 50). Now each item is its own settings row; the index row stays tiny; a blob saved by an
    older Akọwe is read as it is and moved to rows the first time anything is saved."""
    from test_autobook import make_app  # noqa: PLC0415
    app = make_app(tmp_path, fake=BookFakeAI())
    store = app.store
    pid = app.engine.bootstrap_project("author", "Book")
    key = checkpoints._key(pid, BR)  # noqa: SLF001
    old = {f"ch-{i}": {"id": f"ch-{i}", "kind": "chapter", "after": i, "status": "done", "summary": "x" * 5000}
           for i in range(1, 21)}
    store.set_setting(key, {"items": old, "version": 7})
    assert len(checkpoints.items(store, pid, BR)) == 20  # read as it is
    checkpoints._put(store, pid, BR, {"id": "after-5", "after": 5, "status": "new"})  # noqa: SLF001
    idx = store.get_setting(key)
    assert "items" not in idx and idx["version"] == 8 and len(json.dumps(idx)) < 100
    rows = store.query("SELECT key FROM settings WHERE substr(key, 1, ?) = ?", (len(key) + 6, key + ":item:"))
    assert len(rows) == 21
    its = {c["id"]: c for c in checkpoints.items(store, pid, BR)}
    assert len(its) == 21 and its["ch-3"]["summary"] == "x" * 5000 and its["after-5"]["status"] == "new"
    # one more part saves ONE row (not the whole set again)
    before = {r["key"]: r["updated_at"] for r in store.query("SELECT key, updated_at FROM settings WHERE substr(key, 1, ?) = ?",
                                                              (len(key) + 6, key + ":item:"))}
    time.sleep(0.01)
    checkpoints._put(store, pid, BR, dict(its["after-5"], status="done"))  # noqa: SLF001
    after = {r["key"]: r["updated_at"] for r in store.query("SELECT key, updated_at FROM settings WHERE substr(key, 1, ?) = ?",
                                                             (len(key) + 6, key + ":item:"))}
    changed = [k for k in after if after[k] != before[k]]
    assert changed in ([key + ":item:after-5"], [])  # timestamps may share a second; never another row
    assert checkpoints.get_all(store, pid, BR)["items"]["after-5"]["status"] == "done"
    # deleting the book deletes its checkpoint rows too
    store.delete_project(pid)
    assert not store.query("SELECT key FROM settings WHERE instr(key, ?) > 0", (key,))


# ====================================================================== 7. backups, log
def test_backups_hard_link_unchanged_assets_and_pinned_backups_are_capped(tmp_path, monkeypatch):
    from akowe.canonical import sha256_bytes  # noqa: PLC0415
    app = App(tmp_path / "data", token="t")
    data = b"a picture" * 5000
    name = app.store.write_asset(data, sha256_bytes(data))
    b1 = app.backups.backup("manual")
    b2 = app.backups.backup("manual")
    a1 = app.backups.dir / b1["name"] / "assets" / name
    a2 = app.backups.dir / b2["name"] / "assets" / name
    assert a1.read_bytes() == a2.read_bytes() == data
    if hasattr(os, "link"):
        assert os.stat(a1).st_ino == os.stat(a2).st_ino and os.stat(a2).st_nlink >= 2  # one copy on the disk
    assert all(b["verified"] for b in app.backups.list())
    # a disk that cannot link (another volume, FAT, Windows refusing): copied, still verified
    monkeypatch.setattr(os, "link", lambda *a: (_ for _ in ()).throw(OSError("no links here")))
    b3 = app.backups.backup("manual")
    a3 = app.backups.dir / b3["name"] / "assets" / name
    assert a3.read_bytes() == data and os.stat(a3).st_nlink == 1
    assert app.backups.list()[0]["verified"]
    # pinned kinds keep their newest N
    monkeypatch.setitem(backups_mod.PINNED_KEEP, "manual", 2)
    app.backups.backup("manual")
    assert len([b for b in app.backups.list() if b["reason"] == "manual"]) == 2
    # removing an older backup never touches a newer one's (linked) files
    newest = app.backups.list()[0]
    assert (app.backups.dir / newest["name"] / "assets" / name).read_bytes() == data


def test_akowes_own_log_rotates_by_size(tmp_path):
    from logging.handlers import RotatingFileHandler  # noqa: PLC0415
    path = add_log_file(tmp_path)
    root = logging.getLogger()
    try:
        h = next(x for x in root.handlers if isinstance(x, RotatingFileHandler) and Path(x.baseFilename) == path)
        assert h.maxBytes == 10 * 1024 * 1024 and h.backupCount == 5
        assert add_log_file(tmp_path) == path and len([x for x in root.handlers if x is h]) == 1  # added once
    finally:
        for x in [x for x in root.handlers if isinstance(x, RotatingFileHandler)]:
            root.removeHandler(x)
            x.close()


# ====================================================================== 8. OneDrive
def test_the_default_books_folder_follows_the_real_documents_folder_and_warns_about_onedrive(tmp_path, monkeypatch):
    monkeypatch.delenv("AKOWE_BOOKS_DIR", raising=False)
    monkeypatch.delenv("BOOKFORGE_BOOKS_DIR", raising=False)
    user = tmp_path / "user"
    (user / "Documents").mkdir(parents=True)
    od = tmp_path / "user" / "OneDrive" / "Documents"
    od.mkdir(parents=True)
    monkeypatch.setenv("USERPROFILE", str(user))
    monkeypatch.setenv("OneDrive", str(tmp_path / "user" / "OneDrive"))
    got = book_save.default_folder(windows=True, documents=lambda: od)
    assert got == od / "Akowe Books"  # Documents moved to OneDrive (Known Folder Move)
    assert book_save.synced_by(got) == "OneDrive"
    w = book_save.sync_warning(got)
    assert w["service"] == "OneDrive" and "inside OneDrive" in w["warning"]
    assert w["suggested"] == str(user / "Akowe Books")
    assert book_save.synced_by(user / "Akowe Books") is None
    # books already saved in the old place stay there (never moved by themselves)
    (user / "Documents" / "Akowe Books").mkdir()
    assert book_save.default_folder(windows=True, documents=lambda: od) == user / "Documents" / "Akowe Books"
    # nothing answers: the old guess
    (user / "Documents" / "Akowe Books").rmdir()
    assert book_save.default_folder(windows=True, documents=lambda: None) == user / "Documents" / "Akowe Books"
    assert book_save.synced_by(tmp_path / "Dropbox" / "Books") == "Dropbox"


def test_the_settings_card_carries_the_sync_warning(tmp_path, monkeypatch):
    from test_autobook import make_app  # noqa: PLC0415
    app = make_app(tmp_path, fake=BookFakeAI())
    target = tmp_path / "OneDrive - Contoso" / "Books"
    out = app.saver.save_settings({"path": str(target)})
    assert out["synced"]["service"] == "OneDrive" and out["path"] == str(target)
    assert app.saver.save_settings({"path": str(tmp_path / "plain")})["synced"] is None


# ====================================================================== 9. long paths
def test_a_too_long_file_name_is_shortened_and_kept_unique_never_failing_the_save(tmp_path, monkeypatch):
    folder = tmp_path / "book"
    limit = len(str(folder)) + 40
    files = {"Chapters/01 - " + "A" * 80 + ".md": b"1", "Chapters/02 - " + "A" * 80 + ".md": b"2",
             "README.txt": b"r", "Character Forge/" + "x" * 300 + "/deep.pdf": b"d"}
    out, renamed, dropped = book_save.fit_paths(folder, files, limit)
    assert "README.txt" in out and len(renamed) == 2 and dropped == ["Character Forge/" + "x" * 300 + "/deep.pdf"]
    news = list(renamed.values())
    assert len(set(news)) == 2 and all(n.endswith(".md") and n.startswith("Chapters/") for n in news)
    assert all(len(str(folder / n)) <= limit for n in out)
    assert sorted(out[n] for n in news) == [b"1", b"2"]
    # a whole save: one file over the limit is shortened, the rest is saved, with a plain warning
    from test_autobook import make_app  # noqa: PLC0415
    from akowe.book_path import save_profile  # noqa: PLC0415
    app = make_app(tmp_path, fake=BookFakeAI())
    pid = app.engine.bootstrap_project("author", "Long")
    save_profile(app.store, pid, {"title": "Long"})
    base = app.saver.base()
    folder = app.saver.book_folder(pid, BR, create=True)
    monkeypatch.setattr(book_save, "MAX_PATH", len(str(folder)) + 60)
    orig = app.saver.collect
    long_name = "Character Forge/C1 " + "Lady Marisol of the Grey Coast " * 6 + "- dossier.json"

    def collect(*a, **kw):  # a character with a very long name
        files, info = orig(*a, **kw)
        files[long_name] = b"{}"
        return files, info

    monkeypatch.setattr(app.saver, "collect", collect)
    monkeypatch.setattr(book_save, "check_folder", lambda p: None)
    res = app.saver.save_now(pid, BR)
    assert res["ok"] and res["shortened"] and "shortened" in res["warning"], res
    assert list(res["shortened"]) == [long_name]
    assert not [x for x in res["not_made"] if "longer than" in x["why"]]
    assert all(len(str(Path(res["path"]) / n)) <= book_save.MAX_PATH for n in res["shortened"].values())
    assert (Path(res["path"]) / res["shortened"][long_name]).read_bytes() == b"{}"
    assert base == app.saver.base()


# ====================================================================== 10. the story so far
def test_the_story_so_far_scales_with_a_45_chapter_book_and_keeps_every_chapter():
    entries = [{"chapter_id": f"ch{n}", "number": n,
                "summary": [f"In chapter {n} Mara follows clue number {n} along the grey coast and learns a new "
                            f"thing about the drowned keeper, which changes her plan.",
                            f"She pays for it: injury or loss number {n}, and an enemy notices her."]}
               for n in range(1, 45)]
    lines = story_ledger.story_so_far(entries)
    budget = story_ledger.so_far_budget(44)
    assert budget > 2200 * 2 and len(json.dumps(lines, ensure_ascii=False)) <= budget
    covered = set()
    for x in lines:
        head = x.split(":", 1)[0]
        if head.startswith("Chapters "):
            a, b = head[len("Chapters "):].split("–")
            covered |= set(range(int(a), int(b) + 1))
        elif head.startswith("Chapter "):
            covered.add(int(head[len("Chapter "):]))
    assert covered == set(range(1, 45))  # no chapter is forgotten
    assert all(f"injury or loss number {n}" in " ".join(lines) for n in (42, 43, 44))  # recent: in full
    # with the checkpoints' summaries (every 5 chapters / act ends) the oldest chapters are told as stretches
    cps = [{"chapter_ids": [f"ch{i}" for i in range(a, a + 5)], "summary": f"Act part {a}: the hunt goes on."}
           for a in range(1, 31, 5)]
    lines2 = story_ledger.story_so_far(entries, cps)
    assert lines2[0].startswith("Chapters 1–5: Act part 1") and len(json.dumps(lines2)) <= budget
    # a tiny budget still works (the old last resort) and says it was cut
    cut = []
    small = story_ledger.story_so_far(entries, budget=600, cut=cut)
    assert small and cut
