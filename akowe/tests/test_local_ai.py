"""🖥 5c Local AI backup (local_ai.py): while every online AI is at its usage limit, Alfred's local model (a fake
Ollama here) takes the allowed checks, refuses to write unless the author allowed it, gets one more try for a broken
JSON answer (then the work waits as before), marks what it made, never reviews its own writing, finds the model
through AutoInjector or Ollama itself, and has its settings card."""
from __future__ import annotations

import json
import time
import types
from types import SimpleNamespace

import pytest

from akowe import ai_activity, forge, local_ai, usage_limits
from akowe import providers as prov_mod
from akowe.assist import Job
from akowe.errors import AkoweError

from audio_fakes import FakeLlmBridge, FakeOllama, free_port
from test_failover_review import SlotFake, _draft_b01, make_app
from test_server import TOKEN, call  # noqa: F401

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["notes"],
          "properties": {"notes": {"type": "array", "items": {"type": "string"}}}}
GOOD = '```json\n{"notes": ["Mara has the lantern in both scenes."]}\n```'
REVIEW_OK = json.dumps({"verdict": "APPROVE", "reasons": ["It fits the plan and the canon."], "suggested_changes": [],
                        "confidence": 0.8})


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))
    usage_limits.clear()
    local_ai.forget()
    yield
    usage_limits.clear()
    local_ai.forget()


def _app(tmp_path, ollama, monkeypatch, slots=("AI-1", "AI-2")):
    fake = SlotFake()
    app = make_app(tmp_path, fake, slots=slots)
    forge.save_bridge_settings(app, {"url": f"http://127.0.0.1:{free_port()}"})  # no AutoInjector: Ollama itself
    monkeypatch.setenv("AKOWE_OLLAMA_URL", ollama.url if ollama else f"http://127.0.0.1:{free_port()}")
    return app, fake


def _limit_all(fake, slots=("AI-1", "AI-2")):
    for sid in slots:
        fake.states[sid], fake.problems[sid] = "needs_user", "USAGE_LIMIT"


def _job(app, kind, pid="p"):
    j = Job(kind, "author", pid, "main", None, None)
    j.retry_busy = False
    return j


def _ask(app, job):
    return app.assist._call_ai(job, op_for_roles="C02", task="List continuity notes.", schema=SCHEMA,  # noqa: SLF001
                               context={"chapter": "text"}, protected=[])


# ====================================================================== finding the model
def test_status_finds_ollama_and_picks_a_good_enough_model(tmp_path, monkeypatch):
    ol = FakeOllama(models=(("llama3.2:3b", "3.2B"), ("qwen2.5:7b", "7.6B"), ("qwen2.5:32b", "32.8B"),
                            ("nomic-embed-text", "137M")))
    try:
        app, _ = _app(tmp_path, ol, monkeypatch)
        st = local_ai.status(app)
        assert st["found"] and st["source"] == "ollama" and st["model"] == "qwen2.5:7b" and st["params_b"] == 7.6
        assert st["good_enough"] and st["enabled"] and "Ready: qwen2.5:7b" in st["words"]
        assert all("embed" not in m["name"] for m in st["models"])
        # only a small model: not good enough, and so off by default
        ol.models = [{"name": "llama3.2:3b", "details": {"parameter_size": "3.2B"}}]
        st = local_ai.status(app, fresh=True)
        assert st["model"] == "llama3.2:3b" and not st["good_enough"] and not st["enabled"] and "small" in st["words"]
        # the author can still switch it on
        local_ai.save_settings(app.store, {"enabled": True})
        assert local_ai.status(app)["enabled"]
    finally:
        ol.close()
    st = local_ai.status(app, fresh=True)
    assert not st["found"] and not st["enabled"] and "Ollama was not found" in st["words"]
    assert local_ai.params_of("x", {"parameter_size": "500M"}) == 0.5 and local_ai.params_of("mistral:7b-instruct") == 7


def test_status_uses_what_autoinjector_knows_about_alfreds_model(tmp_path, monkeypatch):
    ol = FakeOllama()
    br = FakeLlmBridge({"found": True, "endpoint": ol.url + "/v1", "model": "qwen2.5:14b", "params_b": 14.8,
                        "fit": {"rating": "good", "label": "★★ Good fit"},
                        "models": [{"name": "qwen2.5:14b", "params_b": 14.8, "fit": {"rating": "good", "label": "★★ Good fit"}},
                                   {"name": "qwen2.5:7b", "params_b": 7.6, "fit": {"rating": "excellent", "label": "★★★"}}]})
    try:
        app, _ = _app(tmp_path, None, monkeypatch)
        forge.save_bridge_settings(app, {"url": br.url, "token": "t"})
        st = local_ai.status(app, fresh=True)
        assert st["source"] == "autoinjector" and st["model"] == "qwen2.5:14b" and st["endpoint"] == ol.url
        assert st["fit"]["label"] == "★★ Good fit" and st["good_enough"] and st["alfred_model"] == "qwen2.5:14b"
        local_ai.save_settings(app.store, {"model": "qwen2.5:7b"})  # the author's own choice wins
        assert local_ai.status(app, fresh=True)["model"] == "qwen2.5:7b"
    finally:
        br.close()
        ol.close()


# ====================================================================== covering for the online AIs
def test_when_every_online_ai_is_limited_the_local_ai_does_the_checks_and_says_so(tmp_path, monkeypatch):
    ol = FakeOllama(replies=[GOOD])
    try:
        app, fake = _app(tmp_path, ol, monkeypatch)
        _limit_all(fake)
        seen = []
        real = ai_activity.note_local
        monkeypatch.setattr(ai_activity, "note_local", lambda m: (seen.append(m), real(m)))
        job = _job(app, "continuity_track")
        out = _ask(app, job)
        assert out == {"notes": ["Mara has the lantern in both scenes."]}
        assert job.slot == "LOCAL" and job.slot_label.startswith("🖥 Local AI") and job.model == "ollama:qwen2.5:7b"
        assert len(ol.requests) == 1 and ol.requests[0]["model"] == "qwen2.5:7b"
        assert ol.requests[0]["response_format"] == {"type": "json_object"}
        assert seen and seen[0].startswith("🖥 Local AI is doing the checks while")
        # a web AI works again: it answers, the local model is not asked
        fake.states.clear()
        fake.problems.clear()
        n = len(ol.requests)
        job = _job(app, "continuity_track")
        try:
            _ask(app, job)
        except AkoweError:
            pass  # the fake web AI may not know this little task; what matters is who was asked
        assert len(ol.requests) == n and job.slot in ("AI-1", "AI-2")
    finally:
        ol.close()


def test_the_activity_strip_message_names_who_rests_and_until_when():
    reset = time.time() + 3600
    msg = local_ai.cover_message({"names": ["AI-1 · Claude"], "reset_at": reset})
    assert msg == f"🖥 Local AI is doing the checks while Claude rests until {usage_limits.clock(reset)}"
    assert local_ai.cover_message({"names": ["AI-1 · Claude", "AI-2 · ChatGPT"]}) == \
        "🖥 Local AI is doing the checks while Claude and ChatGPT rest"
    reg = ai_activity.Registry()
    with ai_activity.doing("Reviewing chapter 7"):
        reg.call_started("LOCAL", "🖥 Local AI (qwen2.5:7b)")
        reg.note_local(msg)
        row = reg.snapshot()["rows"][0]
    assert row["ai"].startswith("🖥 Local AI") and row["stage"] == "local_cover" and row["wait_message"] == msg


def test_writing_waits_for_an_online_ai_unless_the_author_allows_the_local_ai(tmp_path, monkeypatch):
    ol = FakeOllama(replies=[GOOD])
    try:
        app, fake = _app(tmp_path, ol, monkeypatch)
        _limit_all(fake)
        with pytest.raises(AkoweError) as e:
            _ask(app, _job(app, "fix"))  # a rewrite is writing
        assert e.value.code == "UPSTREAM_UNAVAILABLE" and not ol.requests
        # an engine step (a chapter) through providers.generate: also waits
        ctx = SimpleNamespace(project_id="p", branch_id="main", op_id="C02", op={"timeout_ms": 1000},
                              request={"request_id": "r1", "deadline": None})
        with pytest.raises(AkoweError) as e:
            app.engine.providers.generate(ctx, task="Write.", output_schema=SCHEMA, context={}, capability="text",
                                          protected_facts=[])
        assert e.value.code == "UPSTREAM_UNAVAILABLE" and not ol.requests
        # the setting needs the author's explicit yes, with the warning
        with pytest.raises(AkoweError) as e:
            local_ai.save_settings(app.store, {"allow_write": True})
        assert e.value.code == "APPROVAL_REQUIRED" and "worse prose" in e.value.errors[0]["message"]
        assert local_ai.settings(app.store)["allow_write"] is False
        local_ai.save_settings(app.store, {"allow_write": True, "author_confirms": True})
        job = _job(app, "fix")
        assert _ask(app, job)["notes"] and job.slot == "LOCAL"
        data, res = app.engine.providers.generate(ctx, task="Write.", output_schema=SCHEMA, context={},
                                                  capability="text", protected_facts=[])
        assert data["notes"] and res["ai_slot"] == "LOCAL" and res["adapter_id"] == "ollama" and res["local_ai"]
        assert prov_mod.slot_family({"slot_id": "LOCAL"}) == "local"
    finally:
        ol.close()


def test_a_broken_json_answer_is_asked_again_once_then_the_work_waits(tmp_path, monkeypatch):
    ol = FakeOllama(replies=["Sure! Here are the notes: Mara, lantern.", GOOD])
    try:
        app, fake = _app(tmp_path, ol, monkeypatch)
        _limit_all(fake)
        assert _ask(app, _job(app, "planned_check"))["notes"]
        assert len(ol.requests) == 2 and "rejected because it did not validate" in ol.requests[1]["messages"][-1]["content"]
        ol.requests.clear()
        ol.replies = ['{"notes": "not a list"}', "still not JSON"]
        with pytest.raises(AkoweError) as e:
            _ask(app, _job(app, "planned_check"))
        assert e.value.code == "UPSTREAM_UNAVAILABLE"  # the original "every AI is limited" error: the work waits
        assert len(ol.requests) == 2
    finally:
        ol.close()


def test_the_review_is_marked_local_and_the_local_ai_never_reviews_its_own_writing(tmp_path, monkeypatch):
    ol = FakeOllama(replies=[REVIEW_OK])
    try:
        app, fake = _app(tmp_path, ol, monkeypatch)
        pid = app.engine.bootstrap_project("author", "Local")
        ref = _draft_b01(app, pid)
        _limit_all(fake)
        rv = app.review.review_sync("author", pid, "main", ref["record_id"])["review"]
        assert rv["slot"] == "LOCAL" and rv["local_ai"] is True and rv["reviewer"].startswith("🖥 Local AI")
        assert "while the online AIs were at their limits" in rv["local_note"] and rv["independent"] is True
        assert app.review.slot_label("LOCAL") == "🖥 Local AI"
        from akowe import cross_check  # noqa: PLC0415
        assert cross_check.name_of(app.engine.providers, "LOCAL") == "🖥 Local AI"
        # the writer-can't-review rule: a draft the local AI wrote is never reviewed by it
        job = _job(app, "review", pid)
        job.avoid_slots = ["LOCAL"]
        n = len(ol.requests)
        with pytest.raises(AkoweError):
            _ask(app, job)
        assert len(ol.requests) == n
        job = _job(app, "review", pid)
        job.avoid_families = {"local"}
        with pytest.raises(AkoweError):
            _ask(app, job)
        assert len(ol.requests) == n
    finally:
        ol.close()


def test_the_private_fourth_reviewer_adds_a_marked_opinion_and_never_changes_the_verdict(tmp_path, monkeypatch):
    ol = FakeOllama(replies=[json.dumps({"verdict": "REVISE", "reasons": ["The ending is rushed."],
                                         "suggested_changes": ["Slow the last scene."], "confidence": 0.6})])
    try:
        app, fake = _app(tmp_path, ol, monkeypatch)
        st = local_ai.private_review(app.store, local_ai.app_view(app.assist), task="t", schema=SCHEMA, context={},
                                     protected=[], writer_slot="AI-1")
        assert st is None and not ol.requests  # off by default: Ollama is not even asked
        local_ai.save_settings(app.store, {"fourth_reviewer": True})
        from akowe.review import REVIEW_SCHEMA  # noqa: PLC0415
        st = local_ai.private_review(app.store, local_ai.app_view(app.assist), task="t", schema=REVIEW_SCHEMA,
                                     context={}, protected=[], writer_slot="AI-1")
        assert st["verdict"] == "REVISE" and st["local_ai"] and st["private"] and st["reviewer"].startswith("🖥 Local AI")
        assert local_ai.private_review(app.store, local_ai.app_view(app.assist), task="t", schema=REVIEW_SCHEMA,
                                       context={}, protected=[], writer_slot="LOCAL") is None
    finally:
        ol.close()


def test_the_settings_card_api(tmp_path, monkeypatch):
    import threading  # noqa: PLC0415
    from http.server import ThreadingHTTPServer  # noqa: PLC0415

    from akowe.server import make_handler  # noqa: PLC0415
    ol = FakeOllama()
    try:
        app, _ = _app(tmp_path, ol, monkeypatch)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        port = httpd.server_address[1]
        code, out, _r = call(port, "GET", "/api/settings/local-ai")
        assert code == 200 and out["found"] and out["model"] == "qwen2.5:7b" and out["enabled"] is True
        assert out["settings"] == {"enabled": None, "model": None, "allow_write": False, "fourth_reviewer": False}
        assert "worse prose" in out["write_warning"]
        code, out, _r = call(port, "PUT", "/api/settings/local-ai", {"enabled": False, "fourth_reviewer": True})
        assert code == 200 and out["enabled"] is False and out["settings"]["fourth_reviewer"] is True
        code, out, _r = call(port, "PUT", "/api/settings/local-ai", {"allow_write": True})
        assert code in (400, 409, 422) and "author_confirms" in json.dumps(out)
        code, out, _r = call(port, "PUT", "/api/settings/local-ai", {"enabled": "yes"})
        assert code == 400
        code, out, _r = call(port, "POST", "/api/settings/local-ai/check")
        assert code == 200 and out["model"] == "qwen2.5:7b"
        httpd.shutdown()
        httpd.server_close()
    finally:
        ol.close()
