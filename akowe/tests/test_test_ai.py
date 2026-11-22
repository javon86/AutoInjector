"""🧪 The Practice AI (adapter ``practice``) and 🖥 a local model through Ollama (adapter ``ollama``).

* A whole ⚡ Make-a-book run with two Practice AI slots set up through the real ``configure_slot`` path (no test
  adapter) finishes, and the run, the report and the names say "Practice AI (test text)".
* The Ollama adapter against a tiny fake Ollama (http.server in a thread: ``/api/tags`` and ``/api/chat`` with
  ``format``; its answers come from the Practice AI, so a whole run works through it).
* Ollama errors in plain words: not running, model not installed, too slow, not JSON.
* ``configure_slot`` validation and Test connection for both.
"""
from __future__ import annotations

import json
import socket
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from akowe import book_report as br
from akowe import ollama_adapter, practice_ai, providers as prov_mod
from akowe.errors import AkoweError
from akowe.jobs import RetryPolicy
from akowe.server import App

from autobook_fake import BookFakeAI


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    """The providers' own quick retries (1-4 s) would only slow the tests down."""
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def make_app(tmp_path):
    app = App(tmp_path / "data", token="t")
    app.engine.providers.secret_path = tmp_path / "secrets.json"
    fast = RetryPolicy([0.01, 0.02], 5)
    app.autobook.retry_policy = fast
    app.write_all.retry_policy = fast
    app.assist.retry_policy = fast
    return app


def run_book(app, body=None, timeout=300):
    r = app.autobook.start("author", dict({"author_confirms": True}, **(body or {})))
    app.autobook.wait_for(r["id"], timeout)
    return app.autobook.public(app.autobook.get(r["id"]))


# ============================================================================================ the fake Ollama
class FakeOllama:
    """A tiny Ollama: GET /api/tags lists ``models``; POST /api/chat answers with the Practice AI's JSON for the
    requested ``format`` schema. ``mode``: "ok", "slow" (sleeps ``slow_s`` first), "badjson", "cut" (done_reason
    length), "missing" (every chat: 404 model not found). Records what it was sent (``chats``)."""

    def __init__(self, models=("llama3.1:8b", "qwen2.5:14b")):
        self.models = list(models)
        self.mode = "ok"
        self.slow_s = 3.0
        self.chats: list[dict] = []
        self.ai = practice_ai.PracticeAI()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # quiet
                pass

            def _send(self, code, obj):
                raw = json.dumps(obj).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_GET(self):  # noqa: N802
                if self.path == "/api/tags":
                    self._send(200, {"models": [{"name": m, "model": m} for m in outer.models]})
                else:
                    self._send(404, {"error": "not found"})

            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
                if self.path != "/api/chat":
                    self._send(404, {"error": "not found"})
                    return
                outer.chats.append({"model": body.get("model"), "stream": body.get("stream"),
                                    "has_format": isinstance(body.get("format"), dict),
                                    "options": body.get("options"), "roles": [m["role"] for m in body["messages"]]})
                if outer.mode == "missing" or body.get("model") not in outer.models:
                    self._send(404, {"error": f"model \"{body.get('model')}\" not found, try pulling it first"})
                    return
                if outer.mode == "slow":
                    time.sleep(outer.slow_s)
                if outer.mode == "badjson":
                    content = "Sure! Here is the chapter you asked for, without any JSON at all."
                else:
                    system, user = body["messages"][0]["content"], body["messages"][1]["content"]
                    out, _usage = outer.ai.submit({"slot_id": "AI-1"}, system, user, body["format"])
                    content = json.dumps(out)
                self._send(200, {"model": body["model"], "message": {"role": "assistant", "content": content},
                                 "done": True, "done_reason": "length" if outer.mode == "cut" else "stop",
                                 "prompt_eval_count": 123, "eval_count": 45})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def ollama():
    srv = FakeOllama()
    yield srv
    srv.close()


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ============================================================================================ (a) the Practice AI
def test_a_whole_make_a_book_run_with_two_practice_slots_finishes_and_says_practice_ai(tmp_path):
    app = make_app(tmp_path)
    prov = app.engine.providers
    assert prov.test_adapter is None  # the real path: no test adapter anywhere
    s1 = prov.configure_slot("AI-1", {"adapter_id": "practice"})
    prov.configure_slot("AI-2", {"adapter_id": "practice"})
    assert s1["has_credentials"] and s1["input_cost_minor_per_mtok"] == 0 and s1["output_cost_minor_per_mtok"] == 0
    assert [s["slot_id"] for s in prov.ai_slots()] == ["AI-1", "AI-2"]
    assert prov_mod.slot_family(s1) == "practice-AI-1"  # each practice slot is its own reviewer
    assert prov_mod.slot_name(s1) == "AI-1 · Practice AI (test text)"
    assert isinstance(prov.adapter(s1), practice_ai.PracticeAI)
    t0 = time.monotonic()
    run = run_book(app, {"genre": "Mystery", "length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    assert time.monotonic() - t0 < 120  # minutes at most, no real AI
    assert run.get("practice_ai") is True
    assert any(e.get("code") == "PRACTICE_AI" and "Practice AI (test text)" in e["message"] for e in run["events"])
    assert (run.get("review_summary") or {}).get("independent", 0) > 0  # two practice slots review each other
    rep = app.reports.latest(run["project_id"], "main")
    assert rep["usage"]["practice_ai"] is True and "Practice AI (test text)" in rep["usage"]["writer"]
    md = br.render_markdown(rep)
    assert br.PRACTICE_LINE in md and "Practice AI (test text)" in md
    assert run.get("files")  # the PDF / EPUB / Word files were made


def test_the_practice_ai_answers_any_schema_and_never_records_prompts():
    ai = practice_ai.PracticeAI()
    schema = {"type": "object", "required": ["a", "b"], "properties": {"a": {"type": "string"},
                                                                       "b": {"type": "array"}}}
    out, usage = ai.submit({"slot_id": "AI-1"}, "task", "Project context package (JSON):\n{}", schema)
    assert out == {"a": "text", "b": []} and usage["model"] == "practice-ai" and usage["input_tokens"] > 0
    assert not hasattr(ai, "prompts") and not hasattr(ai, "calls")  # nothing kept in production
    assert practice_ai.shared() is practice_ai.shared()
    assert isinstance(BookFakeAI(), practice_ai.PracticeAI)  # the tests' fake IS the Practice AI plus test hooks


def test_practice_slot_health_and_test_connection(tmp_path):
    app = make_app(tmp_path)
    prov = app.engine.providers
    prov.configure_slot("AI-1", {"adapter_id": "practice"})
    h = prov.health_check("AI-1")
    assert h["ok"] is True and h["error"] is None and "Practice AI" in h["message"]
    code, out = app.route("GET", "/api/slots/AI-1/health", {}, None, "author", {})
    assert code == 200 and out["ok"]
    st = prov.slot_status(prov.slots()[0])
    assert st["working"] and st["state"] == "ok" and st["name"] == "AI-1 · Practice AI (test text)"
    checks = app.health.c_slots(True)
    assert checks[0]["status"] == "ok" and "Practice AI" in checks[0]["detail"]
    assert prov.slots()[0]["max_concurrent"] >= 8  # never busy


# ============================================================================================ (b) Ollama works
def test_the_ollama_adapter_sends_a_structured_chat_and_returns_json_and_usage(ollama):
    ad = ollama_adapter.OllamaAdapter(ollama.url, 30)
    schema = {"type": "object", "required": ["premise"], "properties": {"premise": {"type": "string"},
                                                                       "dramatic_question": {"type": "string"},
                                                                       "concept_summary": {"type": "string"}}}
    user = "Project context package (JSON):\n" + json.dumps({"context": {}, "protected_facts": []})
    data, usage = ad.submit({"slot_id": "AI-1", "model": "llama3.1:8b", "context_limit_tokens": 24000,
                             "max_output_tokens": 8000}, "sys", user, schema)
    assert "premise" in data and usage == {"input_tokens": 123, "output_tokens": 45, "model": "llama3.1:8b",
                                           "provider_request_id": None}
    sent = ollama.chats[-1]
    assert sent["stream"] is False and sent["has_format"] and sent["roles"] == ["system", "user"]
    assert sent["options"]["num_ctx"] == 32000 and sent["options"]["num_predict"] == 8000


def test_several_real_akowe_calls_go_through_ollama(tmp_path, ollama):
    """Real Akọwe AI calls (assist._call_ai via a Bible Builder sketch, and providers.generate) through Ollama."""
    app = make_app(tmp_path)
    prov = app.engine.providers
    prov.configure_slot("AI-1", {"adapter_id": "ollama", "base_url": ollama.url, "model": "llama3.1:8b"})
    slot = prov.slots()[0]
    assert slot["context_limit_tokens"] == ollama_adapter.DEFAULT_CONTEXT_TOKENS and slot["max_concurrent"] == 1
    assert slot["input_cost_minor_per_mtok"] == 0 and slot["has_credentials"]
    assert isinstance(prov.adapter(slot), ollama_adapter.OllamaAdapter)
    ctx = types.SimpleNamespace(project_id="p", branch_id="main", op_id="B01", request={"request_id": "r1"})
    for i in range(3):
        data, res = prov.generate(ctx, task="Write a premise.", output_schema={
            "type": "object", "required": ["premise"], "properties": {"premise": {"type": "string"}}},
            context={"n": i}, capability="text", protected_facts=[])
        assert isinstance(data["premise"], str) and res["adapter_id"] == "ollama" and res["model"] == "llama3.1:8b"
    assert len(ollama.chats) == 3


def test_a_whole_short_run_works_through_ollama(tmp_path, ollama):
    app = make_app(tmp_path)
    prov = app.engine.providers
    prov.configure_slot("AI-1", {"adapter_id": "ollama", "base_url": ollama.url, "model": "llama3.1:8b"})
    prov.configure_slot("AI-2", {"adapter_id": "ollama", "base_url": ollama.url, "model": "qwen2.5:14b"})
    assert prov_mod.slot_family(prov.slots()[0]) != prov_mod.slot_family(prov.slots()[1])  # two models: two AIs
    run = run_book(app, {"genre": "Mystery", "length": "short_story", "pictures": False})
    assert run["status"] == "done", run.get("problem")
    assert len(ollama.chats) > 20 and {c["model"] for c in ollama.chats} == {"llama3.1:8b", "qwen2.5:14b"}
    assert not run.get("practice_ai")
    rep = app.reports.latest(run["project_id"], "main")
    assert "(on this PC)" in (rep["usage"]["writer"] or "") and not rep["usage"]["practice_ai"]


# ============================================================================================ (c) Ollama errors
def _premise(prov):
    ctx = types.SimpleNamespace(project_id="p", branch_id="main", op_id="B01", request={"request_id": "r1"})
    return prov.generate(ctx, task="Write a premise.", output_schema={
        "type": "object", "required": ["premise"], "properties": {"premise": {"type": "string"}}},
        context={}, capability="text", protected_facts=[])


def test_ollama_not_running_says_start_ollama(tmp_path):
    app = make_app(tmp_path)
    prov = app.engine.providers
    prov.configure_slot("AI-1", {"adapter_id": "ollama", "base_url": f"http://127.0.0.1:{free_port()}",
                                 "model": "llama3.1:8b"})
    with pytest.raises(AkoweError) as ei:
        _premise(prov)
    assert ei.value.code == "CAPABILITY_UNAVAILABLE"
    assert "Start Ollama, then run: ollama pull llama3.1:8b" in ei.value.errors[0]["message"]


def test_ollama_model_missing_says_ollama_pull(tmp_path, ollama):
    app = make_app(tmp_path)
    prov = app.engine.providers
    prov.configure_slot("AI-1", {"adapter_id": "ollama", "base_url": ollama.url, "model": "gemma2:27b"})
    with pytest.raises(AkoweError) as ei:
        _premise(prov)
    assert ei.value.code == "CAPABILITY_UNAVAILABLE"
    assert "ollama pull gemma2:27b" in ei.value.errors[0]["message"] and "not installed" in ei.value.errors[0]["message"]


def test_ollama_too_slow_is_a_timeout(tmp_path, ollama):
    app = make_app(tmp_path)
    prov = app.engine.providers
    prov.configure_slot("AI-1", {"adapter_id": "ollama", "base_url": ollama.url, "model": "llama3.1:8b",
                                 "timeout_s": 1})
    ollama.mode, ollama.slow_s = "slow", 2.5
    with pytest.raises(AkoweError) as ei:
        _premise(prov)
    assert ei.value.code == "TIMEOUT" and "did not answer within 1 seconds" in ei.value.errors[0]["message"]
    assert len(ollama.chats) == 1  # a slow local model is never asked three times
    # the adapter alone, with a tiny time limit
    with pytest.raises(AkoweError) as ei:
        ollama_adapter.OllamaAdapter(ollama.url, 0.3).submit({"model": "llama3.1:8b", "timeout_s": 0.3}, "s",
                                                             "u\n{}", {"type": "object"})
    assert ei.value.code == "TIMEOUT"


def test_ollama_bad_json_and_a_cut_answer(tmp_path, ollama):
    ad = ollama_adapter.OllamaAdapter(ollama.url, 30)
    slot = {"slot_id": "AI-1", "model": "llama3.1:8b"}
    ollama.mode = "badjson"
    with pytest.raises(AkoweError) as ei:
        ad.submit(slot, "s", "u\n{}", {"type": "object"})
    assert ei.value.code == "INTERNAL_ERROR" and "invalid JSON" in ei.value.errors[0]["message"]  # as the API adapter
    assert getattr(ei.value, "try_other_ai", False)
    ollama.mode = "cut"
    with pytest.raises(AkoweError) as ei:
        ad.submit(slot, "s", "u\n{}", {"type": "object"})
    assert ei.value.code == "CONTEXT_TOO_LARGE"


# ============================================================================================ (d) configure_slot
def test_configure_slot_validates_practice_and_ollama(tmp_path):
    app = make_app(tmp_path)
    prov = app.engine.providers
    s = prov.configure_slot("AI-3", {"adapter_id": "practice"})
    assert s["adapter_id"] == "practice"
    s = prov.configure_slot("AI-1", {"adapter_id": "ollama"})  # defaults: this PC, a model Ollama knows
    assert s["base_url"] == "http://localhost:11434" and s["model"] == "llama3.1:8b" and s["timeout_s"] == 900
    s = prov.configure_slot("AI-1", {"adapter_id": "ollama", "base_url": "http://192.168.1.20:11434/",
                                     "model": "qwen2.5:14b", "timeout_s": 1800})
    assert s["base_url"] == "http://192.168.1.20:11434" and s["model"] == "qwen2.5:14b" and s["timeout_s"] == 1800
    for url in ("http://mypc:11434", "http://studio.local:11434", "https://[::1]:11434", "http://10.0.0.5"):
        assert prov.configure_slot("AI-1", {"base_url": url})["adapter_id"] == "ollama"

    def refused(cfg, pointer):
        with pytest.raises(AkoweError) as ei:
            prov.configure_slot("AI-2", cfg)
        assert ei.value.code == "INVALID_INPUT" and ei.value.errors[0]["path"] == pointer, ei.value.errors
        return ei.value.errors[0]["message"]

    msg = refused({"adapter_id": "ollama", "base_url": "http://ollama.example.com:11434"}, "/base_url")
    assert "I trust this address" in msg
    refused({"adapter_id": "ollama", "base_url": "ftp://localhost:11434"}, "/base_url")
    refused({"adapter_id": "ollama", "base_url": "http://localhost:11434/api"}, "/base_url")
    refused({"adapter_id": "ollama", "base_url": "http://user:pw@localhost:11434"}, "/base_url")
    refused({"adapter_id": "ollama", "base_url": ""}, "/base_url")
    refused({"adapter_id": "ollama", "model": "two words"}, "/model")
    refused({"adapter_id": "ollama", "model": ""}, "/model")
    refused({"adapter_id": "ollama", "timeout_s": 0}, "/timeout_s")
    refused({"adapter_id": "ollama", "timeout_s": "900"}, "/timeout_s")
    refused({"adapter_id": "ollama", "confirm_internet_host": "yes"}, "/confirm_internet_host")
    refused({"adapter_id": "llama"}, "/adapter_id")
    assert prov.slots()[1]["adapter_id"] == "none"  # nothing was saved by the refused calls
    # an internet address only when the author says they trust it
    s = prov.configure_slot("AI-2", {"adapter_id": "ollama", "base_url": "https://ollama.example.com",
                                     "confirm_internet_host": True})
    assert s["base_url"] == "https://ollama.example.com" and s["base_url_trusted"] is True
    assert prov.configure_slot("AI-2", {"timeout_s": 60})["base_url"] == "https://ollama.example.com"
    assert "confirm_internet_host" not in s
    # the HTTP route takes the same body
    code, out = app.route("PUT", "/api/slots/AI-3", {}, {"adapter_id": "ollama", "model": "mistral-nemo:12b"},
                          "author", {})
    assert code == 200 and out["model"] == "mistral-nemo:12b" and out["adapter_id"] == "ollama"


# ============================================================================================ (e) Test connection
def test_test_connection_for_ollama_says_running_and_installed(tmp_path, ollama):
    app = make_app(tmp_path)
    prov = app.engine.providers
    prov.configure_slot("AI-1", {"adapter_id": "ollama", "base_url": ollama.url, "model": "llama3.1"})
    ollama.models = ["llama3.1:latest"]
    h = prov.health_check("AI-1")
    assert h["ok"] and h["running"] and h["model_installed"] and "is installed" in h["message"]
    prov.configure_slot("AI-1", {"model": "qwen2.5:14b"})
    h = prov.health_check("AI-1")
    assert not h["ok"] and h["running"] and not h["model_installed"] and h["error"] == "MODEL_NOT_INSTALLED"
    assert "ollama pull qwen2.5:14b" in h["message"] and h["models"] == ["llama3.1:latest"]
    code, out = app.route("GET", "/api/slots/AI-1/health", {}, None, "author", {})
    assert code == 200 and out["error"] == "MODEL_NOT_INSTALLED"
    checks = app.health.c_slots(True)
    assert checks[0]["status"] == "problem" and "ollama pull qwen2.5:14b" in checks[0]["fix"]
    prov.configure_slot("AI-2", {"adapter_id": "ollama", "base_url": f"http://127.0.0.1:{free_port()}"})
    h = prov.health_check("AI-2")
    assert not h["ok"] and not h["running"] and h["error"] == "CAPABILITY_UNAVAILABLE"
    assert "Ollama is not running" in h["message"] and h["fix"].startswith("Start Ollama")


def test_test_connection_refuses_slots_without_a_connection(tmp_path):
    app = make_app(tmp_path)
    with pytest.raises(AkoweError) as ei:
        app.engine.providers.health_check("AI-1")  # not set up
    assert ei.value.code == "INVALID_INPUT"


def test_the_ui_offers_both_adapters_and_the_practice_button():
    from pathlib import Path
    js = (Path(prov_mod.__file__).parent / "web" / "app.js").read_text(encoding="utf-8")
    assert "['practice', 'Practice AI (free, instant, test text only)']" in js
    assert "['ollama', 'Local model on this PC (Ollama)']" in js
    assert "🧪 Use the Practice AI for a test run" in js and "confirm(`Set AI-1 and AI-2 to the Practice AI?" in js
