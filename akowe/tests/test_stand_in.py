"""🧑‍⚖️ The stand-in decider (stand_in.py): when the author does not answer an AI disagreement in time.

Off by default; waits the configured time (an injected clock, never a real sleep); the decider order (a) Claude Code
helper → (b) the AI not in the disagreement → (c) 🎩 Alfred (the local model) with each one missing; Alfred only for
simple cases (each disqualifier keeps waiting); plot / ending / main character / POV-tense / content limits / lock list
never decided by a stand-in; unsure, low confidence or a malformed answer keeps waiting; ↩ Undo; the per-run cap; the
notes in the run window, the alert, Book home and the status push (the desktop notification); codes-only logs.
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import cc_fake
from akowe import attention, checker_record as cr, stand_in, status_push, story_details, story_map
from akowe.errors import AkoweError

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book
from test_checkers import make_app3
from test_review_loop import SAME, scripted
from test_server import call, server  # noqa: F401


# ---------------------------------------------------------------------------------------------- helpers
class FakeOllama:
    """A local OpenAI-compatible server like Ollama's (127.0.0.1): /v1/models and /v1/chat/completions."""

    def __init__(self, answer=None, models=("llama3:8b", "qwen3.5:9b")):
        self.answer = answer if answer is not None else {"choice": "accept_change", "confidence": 0.9,
                                                         "reason": "The correction fixes the finding."}
        self.models = list(models)
        self.calls: list[dict] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, obj):
                data = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):  # noqa: N802
                self._send({"data": [{"id": m} for m in outer.models]})

            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.calls.append(body)
                a = outer.answer
                content = a if isinstance(a, str) else json.dumps(a)
                self._send({"choices": [{"message": {"role": "assistant", "content": content}}]})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/v1"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def ollama():
    o = FakeOllama()
    yield o
    o.close()


def paused(tmp_path, three=False, body=None):
    fake = BookFakeAI()
    fake.verdicts = [scripted({"Tom Reed": [SAME, SAME, SAME]})] * 40
    app = (make_app3 if three else make_app)(tmp_path, fake=fake)
    run = run_book(app, dict({"pictures": False}, **(body or {})))
    assert run["status"] == "paused" and run["problem"]["code"] == "REVIEW_DECISION", run["phase"]
    return app, fake, run


def due(app, run, extra_min=1):
    at = datetime.fromisoformat(run["problem"]["at"].replace("Z", "+00:00")).timestamp()
    return at + 60 * (stand_in.settings(app.store)["wait_min"] + extra_min)


def turn_on(app, **kw):
    return stand_in.save_settings(app.store, dict({"enabled": True}, **kw))


def set_parties(app, run_id, **kw):
    run = app.autobook.get(run_id)
    run["problem"]["parties"].update(kw)
    app.autobook.save(run)


def finish(app, run_id):
    app.autobook.wait_for(run_id, 120)
    return app.autobook.public(app.autobook.get(run_id))


def no_web_stand_in(fake):
    return "stand_in" not in fake.kinds


# ---------------------------------------------------------------------------------------------- off / timing
def test_off_by_default_and_waits_the_configured_time(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True)
    assert stand_in.settings(app.store)["enabled"] is False and stand_in.settings(app.store)["wait_min"] == 20
    assert stand_in.tick(app, now=due(app, run, 120)) == []  # off: nothing, however long
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run, -1)) == []  # 19 minutes: not yet
    pub = app.autobook.public(app.autobook.get(run["id"]))
    assert pub["stand_in"]["pending"]["state"] == "waiting"
    assert "If you don't answer by" in pub["alert"]["next"] and "a stand-in decides" in pub["alert"]["next"]
    res = stand_in.tick(app, now=due(app, run, 1))
    assert [r["code"] for r in res] == ["DECIDED"] and res[0]["who"] == "ai" and res[0]["choice"] == "accept_change"
    assert fake.kinds.count("stand_in") == 1
    assert fake.prompts["stand_in"][0][1]["no_ai_checks"]["passed"] is True
    assert fake.prompts["stand_in"][0][1]["changed_text"]["after"].endswith("(revised)")
    done = finish(app, run["id"])
    assert done["status"] == "done", done["phase"]


def test_a_shorter_wait_time(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True)
    turn_on(app, wait_min=10)
    assert stand_in.tick(app, now=due(app, run, -1)) == []
    assert stand_in.tick(app, now=due(app, run, 0.5))[0]["code"] == "DECIDED"
    with pytest.raises(AkoweError):
        stand_in.save_settings(app.store, {"wait_min": 15})
    with pytest.raises(AkoweError):
        stand_in.save_settings(app.store, {"local_endpoint": "http://example.com:11434/v1"})  # never off this PC


# ---------------------------------------------------------------------------------------------- who decides
def test_a_claude_code_decides_when_claude_is_not_in_the_disagreement(tmp_path, monkeypatch):
    cc_fake.install(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True)
    set_parties(app, run["id"], writer="AI-9", writer_slot="AI-9")  # Claude is neither writer nor reviewer here
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "DECIDED" and res[0]["who"] == "claude_code"
    assert no_web_stand_in(fake)
    d = app.autobook.get(run["id"])["stand_in"]["decisions"][0]
    assert d["name"] == "🤖 Claude Code" and "Claude Code read the finding" in d["reason"]
    assert cr.stats_of(app.store, "claude_code")["kinds"]["stand_in"]["confirmed"] == 1
    finish(app, run["id"])


def test_a_is_skipped_when_claude_wrote_it_and_b_decides(tmp_path, monkeypatch):
    cc_fake.install(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True)
    parties = app.autobook.get(run["id"])["problem"]["parties"]
    assert parties["writer"] == "claude"
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["who"] == "ai"
    asked = [c["slot"] for c in fake.calls if "choice" in c["props"]]
    assert asked and set(asked).isdisjoint({"AI-1", *parties["reviewer_slots"]})  # never one of the two
    finish(app, run["id"])


def test_b_respects_the_checker_order_and_off(tmp_path, monkeypatch, ollama):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True, body={"checker_order": {"mode": "auto", "off": ["AI-3"]}})
    parties = app.autobook.get(run["id"])["problem"]["parties"]
    assert parties["reviewer_slots"] == ["AI-2"]
    turn_on(app, local_endpoint=ollama.url)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["who"] == "local"  # AI-3 is off for checks, AI-1/AI-2 disagree: only Alfred is left
    assert no_web_stand_in(fake) and ollama.calls[0]["model"] == "qwen3.5:9b"  # a Qwen model first
    finish(app, run["id"])


def test_c_alfred_decides_a_simple_case_when_a_and_b_are_missing(tmp_path, monkeypatch, ollama):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)  # two AIs: both are in the disagreement
    turn_on(app, local_endpoint=ollama.url, local_model="qwen3.5:9b")
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "DECIDED" and res[0]["who"] == "local"
    sent = ollama.calls[0]
    assert sent["response_format"] == {"type": "json_object"} and sent["temperature"] == 0
    ctx = json.loads(sent["messages"][1]["content"].split("\n", 1)[1])
    assert set(ctx) >= {"finding", "change", "approved_canon", "no_ai_checks", "changed_text"}
    pub = app.autobook.public(app.autobook.get(run["id"]))
    line = pub["stand_in"]["decisions"][0]["line"]
    assert line.startswith("🎩 Alfred approved the correction to Tom Reed (character) at ")
    assert "because you didn't answer for 20 minutes. Why: The correction fixes the finding." in line
    done = finish(app, run["id"])
    assert done["status"] == "done"
    assert any(e.get("code") == "STAND_IN_DECIDED" for e in app.autobook.get(run["id"])["events"])


def test_nobody_reachable_keeps_waiting(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    turn_on(app, local_endpoint="http://127.0.0.1:9/v1")  # nothing listens there: Ollama is not running
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "NO_DECIDER"
    r = app.autobook.get(run["id"])
    assert r["status"] == "paused" and r["problem"]["code"] == "REVIEW_DECISION"
    assert any(e.get("code") == "STAND_IN_WAITS" for e in r["events"])
    assert stand_in.tick(app, now=due(app, run, 30)) == []  # tried once for this decision: no retry loop
    pub = app.autobook.public(r)
    assert pub["stand_in"]["pending"]["state"] == "waits" and "No stand-in could be reached" in pub["alert"]["next"]


# ---------------------------------------------------------------------------------------------- what keeps waiting
@pytest.mark.parametrize("answer,code", [
    ({"choice": "unsure", "confidence": 0.9, "reason": "Cannot tell."}, "UNSURE"),
    ({"choice": "accept_change", "confidence": 0.5, "reason": "Probably."}, "UNSURE"),
    ({"choice": "keep_original", "confidence": 0.95, "reason": "The old one was right."}, "UNSURE"),  # Alfred: only accept
    ("I think you should accept it.", "BAD_ANSWER"),
    ({"choice": "accept_change", "confidence": "high", "reason": "x"}, "BAD_ANSWER"),
    ({"choice": "approve", "confidence": 0.9, "reason": "x"}, "BAD_ANSWER"),
])
def test_unsure_low_or_malformed_keeps_waiting(tmp_path, monkeypatch, ollama, answer, code):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    ollama.answer = answer
    turn_on(app, local_endpoint=ollama.url)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == code
    r = app.autobook.get(run["id"])
    assert r["status"] == "paused" and not r["stand_in"]["decisions"]
    assert r["stand_in"]["count"] == 0


def test_web_ai_unsure_keeps_waiting_and_claude_code_malformed_too(tmp_path, monkeypatch):
    cc_fake.install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE_STAND_IN="malformed")
    app, fake, run = paused(tmp_path, three=True)
    set_parties(app, run["id"], writer="AI-9", writer_slot="AI-9")
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "BAD_ANSWER"
    assert no_web_stand_in(fake)  # never "try the next one until someone says yes"


def test_web_ai_low_confidence(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True)
    fake.stand_in_script = [{"choice": "keep_original", "confidence": 0.6, "reason": "Maybe the old one."}]
    turn_on(app)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "UNSURE"


def test_web_ai_may_keep_the_original(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True)
    fake.stand_in_script = [{"choice": "keep_original", "confidence": 0.9, "reason": "The original was right."}]
    turn_on(app)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["choice"] == "keep_original"
    done = finish(app, run["id"])
    hist = app.store.history(run["project_id"], "main", run["problem"]["record_id"])
    assert hist[-1]["data"] == hist[0]["data"] and done["status"] == "done"
    assert "kept the original of Tom Reed (character)" in done["stand_in"]["decisions"][0]["line"]


@pytest.mark.parametrize("change,code", [
    (lambda p: p["decision"].update(kind="canon"), "AUTHOR_ONLY:APPROVED_FACT"),
    (lambda p: p.update(module_id="B11"), "AUTHOR_ONLY:PLOT"),
    (lambda p: p.update(reasons=["The ending no longer pays off the lighthouse."]), "AUTHOR_ONLY:ENDING"),
    (lambda p: p.update(reasons=["The chapter slips into present tense."]), "AUTHOR_ONLY:POV_TENSE"),
    (lambda p: p.update(reasons=["This goes past the content limit."]), "AUTHOR_ONLY:CONTENT_LIMIT"),
])
def test_author_only_topics_are_never_decided(tmp_path, monkeypatch, ollama, change, code):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True)
    r = app.autobook.get(run["id"])
    change(r["problem"])
    app.autobook.save(r)
    turn_on(app, local_endpoint=ollama.url)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == code
    assert no_web_stand_in(fake) and not ollama.calls
    pub = app.autobook.public(app.autobook.get(run["id"]))
    assert "Only you can decide this one" in pub["alert"]["next"]


def test_main_character_and_lock_list_wait_for_the_author(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path, three=True)
    r = app.autobook.get(run["id"])
    prob = dict(r["problem"])
    from akowe import story_roles
    monkeypatch.setattr(story_roles, "protagonist_of", lambda *a, **k: {"record_id": prob["record_id"]})
    assert stand_in.author_only(app, r, prob) == "MAIN_CHARACTER"
    monkeypatch.undo()
    cc_fake.remove(tmp_path, monkeypatch)
    ch = stand_in._change(app, r, prob)  # noqa: SLF001
    r["settings"]["locks"] = [ch["before"][:80]]
    assert stand_in.author_only(app, r, prob) == "LOCK_LIST"


def test_simple_case_gating_each_disqualifier(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    r = app.autobook.get(run["id"])
    prob = json.loads(json.dumps(r["problem"]))
    ok = {"ok": True, "problems": []}
    assert stand_in.simple_case(app, r, prob, ok) is None
    assert stand_in.simple_case(app, r, prob, {"ok": False, "problems": ["SCHEMA"]}) == "CHECKS_OBJECT"
    assert stand_in.simple_case(app, r, dict(prob, prev_version=None), ok) == "NOT_A_CORRECTION"
    assert stand_in.simple_case(app, r, dict(prob, decision=dict(prob["decision"], kind="canon")), ok) == \
        "NOT_A_CORRECTION"
    assert stand_in.simple_case(app, r, dict(prob, reasons=[], decision=dict(prob["decision"], wrong="")), ok) == \
        "NO_FINDING"
    monkeypatch.setattr(stand_in, "SIMPLE_MAX_CHARS", 10)
    assert stand_in.simple_case(app, r, prob, ok) == "TOO_BIG"
    monkeypatch.setattr(stand_in, "SIMPLE_MAX_CHARS", 1500)
    ch = stand_in._change(app, r, prob)  # noqa: SLF001
    # a story-map link that is locked (on the page) and is about the same words
    m = story_map.get(app.store, r["project_id"], "main")
    m["links"]["L99"] = {"id": "L99", "from": "a", "to": "b", "kind": "knows", "note": ch["before"][:120],
                         "status": "locked", "evidence": []}
    app.store.set_setting(story_map._key(r["project_id"], "main"), m)  # noqa: SLF001
    assert stand_in.simple_case(app, r, prob, ok) == "LOCKED_LINK"
    m["links"]["L99"]["status"] = "approved"  # only a LOCKED link (on the page) disqualifies
    app.store.set_setting(story_map._key(r["project_id"], "main"), m)  # noqa: SLF001
    assert stand_in.simple_case(app, r, prob, ok) is None
    # a locked detail already on the page that the change touches
    led = story_details.ledger(app.store, r["project_id"], "main")
    led["locked"]["tom"] = {"background": {"name": "Tom Reed", "text": ch["before"][:200]}}
    app.store.set_setting(story_details._key(r["project_id"], "main"), led)  # noqa: SLF001
    assert stand_in.simple_case(app, r, prob, ok) == "LOCKED_DETAIL"


def test_alfred_is_not_asked_when_the_case_is_not_simple(tmp_path, monkeypatch, ollama):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    monkeypatch.setattr(stand_in, "SIMPLE_MAX_CHARS", 10)
    turn_on(app, local_endpoint=ollama.url)
    res = stand_in.tick(app, now=due(app, run))
    assert res[0]["code"] == "NO_DECIDER" and not ollama.calls
    words = app.autobook.get(run["id"])["stand_in"]["tried"]
    assert any("only decides simple corrections" in t["words"] for t in words.values())


# ---------------------------------------------------------------------------------------------- undo, cap, notes, logs
def test_undo_puts_the_other_option_back_for_re_review(tmp_path, monkeypatch, ollama):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    turn_on(app, local_endpoint=ollama.url)
    stand_in.tick(app, now=due(app, run))
    done = finish(app, run["id"])
    d = done["stand_in"]["decisions"][0]
    rid = d["record_id"]
    out = stand_in.undo(app, "author", run["id"], {"decision_id": d["id"]})
    assert out["ok"] and "back as a draft" in out["message"]
    hist = app.store.history(run["project_id"], "main", rid)
    head = hist[-1]
    assert head["data"] == hist[0]["data"]  # the original is back …
    assert head["lifecycle"] not in ("APPROVED", "LOCKED")  # … as a draft: it waits for the author's approval
    r = app.autobook.get(run["id"])
    assert r["stand_in"]["decisions"][0]["undone"] is True
    assert any(e.get("code") == "STAND_IN_UNDONE" for e in r["events"])
    assert cr.stats_of(app.store, "local")["kinds"]["stand_in"]["overruled"] == 1  # the undo counts against it
    with pytest.raises(AkoweError):
        stand_in.undo(app, "author", run["id"], {"decision_id": d["id"]})
    assert stand_in.notice(r) is None  # no "decided for you" notification for an undone decision
    assert attention.of_book(app.store, run["project_id"], "main")["stand_in"][0]["undone"] is True


def test_the_per_run_cap(tmp_path, monkeypatch, ollama):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    turn_on(app, local_endpoint=ollama.url, max_per_run=1)
    r = app.autobook.get(run["id"])
    r.setdefault("stand_in", {})["count"] = 1
    app.autobook.save(r)
    assert stand_in.tick(app, now=due(app, run))[0]["code"] == "CAP" and not ollama.calls


def test_notes_everywhere_and_codes_only_logs(tmp_path, monkeypatch, ollama, caplog):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    turn_on(app, local_endpoint=ollama.url)
    with caplog.at_level(logging.DEBUG, logger="akowe.stand_in"):
        stand_in.tick(app, now=due(app, run))
    logs = " ".join(r.getMessage() for r in caplog.records if r.name == "akowe.stand_in")
    assert "decided (accept_change by local)" in logs
    for words in ("Tom Reed", "revised", "The correction fixes", "wake"):
        assert words not in logs
    r = app.autobook.get(run["id"])
    # the desktop notification (status push): decided for you
    n = status_push._notice(r)  # noqa: SLF001
    assert n["title"].startswith("Decided for you") and "Open Akọwe to undo it." in n["body"]
    brief = status_push.run_brief(app, run["project_id"], "http://x/")
    assert brief["notice"]["key"] == r["stand_in"]["decisions"][0]["id"]
    # 🏠 Book home lists it (with Undo), and the approvals list says a stand-in decided it
    att = attention.of_book(app.store, run["project_id"], "main")
    assert att["stand_in"][0]["line"].startswith("🎩 Alfred approved the correction")
    assert any("stand-in decided it" in x for x in att["lines"])
    # the outbox holds codes only
    rows = app.store.query("SELECT payload FROM outbox WHERE event_type=?", ("autobook.stand_in_decided",))
    payload = json.loads(rows[0]["payload"])
    assert payload["decider"] == "local" and "reason" not in payload and "Tom" not in rows[0]["payload"]
    finish(app, run["id"])
    # a later alert (any later stop) mentions the last decision of this run
    from akowe import alerts
    a = alerts.with_stand_in({"next": "x"}, stand_in.view(app, app.autobook.get(run["id"])))
    assert a["stand_in"]["line"].startswith("🎩 Alfred approved")


def test_the_api(server, monkeypatch, tmp_path):  # noqa: F811
    app, port = server
    st, body, _ = call(port, "GET", "/api/settings/stand-in")
    assert st == 200 and body["enabled"] is False and body["waits"] == [10, 20, 30, 60]
    st, body, _ = call(port, "PUT", "/api/settings/stand-in", {"enabled": True, "wait_min": 30, "max_per_run": 3})
    assert st == 200 and (body["enabled"], body["wait_min"], body["max_per_run"]) == (True, 30, 3)
    st, body, _ = call(port, "PUT", "/api/settings/stand-in", {"wait_min": 7})
    assert st == 400
    st, body, _ = call(port, "POST", "/api/autobook/nope/stand-in-undo", {"decision_id": "x"})
    assert st == 404


def test_the_last_chapter_is_the_ending(tmp_path, monkeypatch):
    cc_fake.remove(tmp_path, monkeypatch)
    app, fake, run = paused(tmp_path)
    from akowe.book_path import BookPath
    monkeypatch.setattr(BookPath, "outline_chapters", lambda self, o: [{"chapter_id": "ch1"}, {"chapter_id": "ch2"}])
    r = app.autobook.get(run["id"])
    prob = dict(r["problem"], module_id="C02", chapter_id="ch2")
    assert stand_in.author_only(app, r, prob) == "ENDING"
    assert stand_in.author_only(app, r, dict(prob, chapter_id="ch1")) is None
