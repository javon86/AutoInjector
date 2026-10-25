"""Self-test ("Test everything"): manual mode, AI mode through a fake AutoInjector bridge, AI mode
without slots, report contents (no secrets) and the server endpoints."""
from __future__ import annotations

import hmac
import http.client
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from akowe import CONTRACT_VERSION, __version__
from akowe.selftest import FAIL, PASS, SKIPPED, SelfTest
from akowe.server import App, make_handler
from akowe.store import Store

BRIDGE_KEY = "connection-key-SECRET-abcdefghijklmnop"
APP_TOKEN = "app-token-selftest-xyz"
AI_STEPS = {"A0", "A1", "A2", "A3"}
PREMISE = {"premise": "A keeper hears the drowned bell.", "dramatic_question": "Will she answer it?",
           "concept_summary": "A short sea mystery."}
CHARACTER = {"concept": "Old Tom Gale", "attributes": {
    k: f"{k} of the grumpy keeper" for k in ("identity", "role", "traits", "appearance", "background", "goals",
                                           "constraints")},
    "facts": [{"subject_id": "tom-gale", "predicate": "entity.name", "value": "Tom Gale", "assertion_type": "FACT",
               "effective_from": None, "effective_to": None, "source_refs": []}]}
PROSE = "Mara climbed the stairs at dawn and found the brass key glinting on the lamp room floor."


class ScriptedBridge:
    """Contract v1 fake bridge (as in test_autoinjector_adapter.py) answering by prompt content."""

    def __init__(self, token=BRIDGE_KEY):
        self.prompts: list[str] = []
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _authed(self):
                auth = self.headers.get("Authorization") or ""
                if not (auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].encode(), token.encode())):
                    self._send(401, {"ok": False, "error": "UNAUTHORIZED", "message": "bad key"})
                    return False
                return True

            def do_GET(self):
                if self._authed():
                    self._send(200, {"ok": True, "bridge_version": "1",
                                     "sites": {s: {"ready": True, "busy": False} for s in ("claude", "chatgpt", "gemini")}})

            def do_POST(self):
                if not self._authed():
                    return
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
                prompt = body["prompt"]
                bridge.prompts.append(prompt)
                schema = prompt.split("JSON_SCHEMA:", 1)[1]
                if '"events"' in schema:
                    reply = {"events": [{"entity_id": "mara", "path": "/inventory_ids", "operation": "ADD",
                                         "before": [], "after": ["brass-key"], "story_time": 300, "scene_id": "s9",
                                         "scene_order": 0, "event_order": 0,
                                         "evidence": [{"quote": "found the brass key"}]}]}
                elif "objective_assessments" in schema:
                    reply = {"text": PROSE, "objective_assessments": [
                        {"item_id": "ch2", "decision": "PASS", "message": "key found"}]}
                elif '"traits"' in schema:
                    reply = CHARACTER
                else:
                    reply = PREMISE
                self._send(200, {"ok": True, "site": body["site"], "request_id": body["request_id"],
                                 "text": "```json\n" + json.dumps(reply) + "\n```", "seq": "0001", "elapsed_ms": 3})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def app(tmp_path):
    a = App(tmp_path / "data", token=APP_TOKEN)
    a.engine.providers.secret_path = tmp_path / "secrets.json"
    yield a
    a.selftest.wait(60)
    a.store.close()


def run(app, use_ai=False):
    return SelfTest(app.store, base_providers=app.engine.providers, principal_id=app.principal_id,
                    use_ai=use_ai).run()


def by_id(rep):
    return {s["id"]: s for s in rep["steps"]}


def assert_no_secrets(rep, *secrets):
    md = open(rep["files"]["markdown"], encoding="utf-8").read()
    js = open(rep["files"]["json"], encoding="utf-8").read()
    for secret in secrets:
        assert secret not in md and secret not in js


def test_manual_selftest_passes_and_writes_report(app, tmp_path):
    rep = run(app)
    steps = by_id(rep)
    non_ai = [s for s in rep["steps"] if s["id"] not in AI_STEPS]
    assert all(s["status"] == PASS for s in non_ai), [(s["id"], s["detail"]) for s in non_ai if s["status"] != PASS]
    assert all(steps[i]["status"] == SKIPPED and "not requested" in steps[i]["detail"] for i in AI_STEPS)
    assert rep["verdict"] == "PASS" and rep["mode"] == "MANUAL"
    # its own, clearly named project, visible to the author
    proj = app.store.project(rep["project"]["project_id"])
    assert proj["name"].startswith("Self-test ") and app.store.has_project_access(app.principal_id, proj["project_id"])
    # every step records timings and the records it created
    assert all(isinstance(s["elapsed_ms"], int) for s in rep["steps"])
    assert any(r["module_id"] == "H10" for r in steps["S13"]["records"])
    assert "MANUAL (no AI)" in steps["S5"]["detail"]
    # real exports, hashed
    assert {e["format"] for e in rep["exports"]} == {"PDF", "EPUB", "DOCX"}
    assert all(len(e["sha256"]) == 64 and e["bytes"] > 100 for e in rep["exports"])
    md = open(rep["files"]["markdown"], encoding="utf-8").read()
    for text in ("# Akọwe self-test report", "## Summary", "## Exported files", "## Environment notes",
                 rep["package_sha256"], CONTRACT_VERSION):
        assert text in md
    assert rep["files"]["json"].startswith(str(tmp_path / "data" / "reports"))
    assert json.load(open(rep["files"]["json"]))["counts"][FAIL] == 0
    assert_no_secrets(rep, APP_TOKEN)


def test_ai_mode_through_fake_autoinjector_bridge(app):
    bridge = ScriptedBridge()
    try:
        app.engine.providers.connect_autoinjector(BRIDGE_KEY, bridge.url)
        rep = run(app, use_ai=True)
    finally:
        bridge.close()
    steps = by_id(rep)
    bad = [(s["id"], s["status"], s["detail"]) for s in rep["steps"] if s["status"] != PASS]
    assert not bad, bad
    assert "ready" in steps["A0"]["detail"] and "AI-1" in steps["A0"]["detail"]
    assert "AI-1" in steps["A1"]["detail"] and "used by the book slice" in steps["A1"]["detail"]
    assert "1 candidate event" in steps["A2"]["detail"]
    assert steps["S3"]["detail"].startswith("using the AI premise")
    assert "nothing was saved" in steps["A3"]["detail"] and "typed role was kept" in steps["A3"]["detail"]
    # exactly the AI steps reached the bridge: B01 premise, A01 form fill, C02 prose, C02 event extraction
    assert len(bridge.prompts) == 4
    assert rep["mode"] == "AI" and {s["state"] for s in rep["ai_slots"]} == {"READY"}
    # never the key, prompts or replies in the report
    assert_no_secrets(rep, BRIDGE_KEY, APP_TOKEN, PREMISE["premise"], PROSE, bridge.prompts[0][:60],
                      CHARACTER["attributes"]["traits"])


def test_ai_mode_without_slots_skips_ai_steps_with_reason(app):
    rep = run(app, use_ai=True)
    steps = by_id(rep)
    for sid in AI_STEPS:
        assert steps[sid]["status"] == SKIPPED, steps[sid]
        assert "no AI slot is ready" in steps[sid]["detail"] and "Settings" in steps[sid]["fix"]
    assert "MANUAL (no AI)" in steps["A1"]["detail"]
    assert all(s["status"] == PASS for s in rep["steps"] if s["id"] not in AI_STEPS)
    assert rep["verdict"] == "PASS"


def test_ai_mode_unreachable_bridge_is_skipped_not_failed(app):
    app.engine.providers.connect_autoinjector(BRIDGE_KEY, "http://127.0.0.1:9")  # nothing listens there
    rep = run(app, use_ai=True)
    steps = by_id(rep)
    assert steps["A0"]["status"] == SKIPPED and "not reachable" in steps["A0"]["detail"]
    assert steps["A1"]["status"] == SKIPPED and steps["S13"]["status"] == PASS
    assert_no_secrets(rep, BRIDGE_KEY)


def test_failure_does_not_abort_independent_steps(app, monkeypatch):
    def broken(self):
        raise RuntimeError("simulated EPUB exporter crash")
    monkeypatch.setattr(SelfTest, "s_epub", broken)
    monkeypatch.setattr(SelfTest, "s_canon", broken)
    rep = run(app)
    steps = by_id(rep)
    assert steps["S2"]["status"] == FAIL and "simulated" in steps["S2"]["detail"] and steps["S2"]["fix"]
    assert steps["S3"]["status"] == SKIPPED and "needs step S2" in steps["S3"]["detail"]
    assert steps["S13"]["status"] == SKIPPED
    assert steps["S1"]["status"] == PASS and steps["K5"]["status"] == PASS  # independent steps still ran
    assert rep["verdict"] == "FAIL"


# ---------------------------------------------------------------------- HTTP endpoints
@pytest.fixture
def server(app):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield app, httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()


def call(port, method, path, body=None, token=APP_TOKEN):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    hdrs = {"Authorization": f"Bearer {token}"} if token else {}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=hdrs)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    ctype = resp.getheader("Content-Type") or ""
    return resp.status, (json.loads(raw) if ctype.startswith("application/json") else raw), resp


def test_ping_needs_no_auth_and_leaks_nothing(server):
    app, port = server
    app.engine.bootstrap_project(app.principal_id, "Secret Novel Title")
    status, body, resp = call(port, "GET", "/api/ping", token=None)
    assert status == 200
    assert body == {"app": "akowe", "version": __version__, "contract_version": CONTRACT_VERSION}
    raw = json.dumps(body)
    assert "Secret Novel" not in raw and APP_TOKEN not in raw
    assert call(port, "GET", "/api/selftest", token=None)[0] == 401


def test_selftest_endpoints(server, monkeypatch):
    app, port = server
    assert call(port, "GET", "/api/selftest/report?format=md")[0] == 404  # nothing yet
    gate = threading.Event()
    original = SelfTest.k_contracts

    def slow(self):
        gate.wait(20)
        return original(self)
    monkeypatch.setattr(SelfTest, "k_contracts", slow)
    assert call(port, "POST", "/api/selftest", {"use_ai": "yes"})[0] == 400
    status, started, _ = call(port, "POST", "/api/selftest", {"use_ai": False})
    assert status == 202 and started["running"] is True and started["progress"]["total"] == 23
    assert call(port, "POST", "/api/selftest", {"use_ai": False})[0] == 409  # one at a time
    status, live, _ = call(port, "GET", "/api/selftest")
    assert status == 200 and live["running"] and live["progress"]["current_step"].startswith("K1")
    gate.set()
    deadline = time.time() + 60
    while time.time() < deadline:
        status, live, _ = call(port, "GET", "/api/selftest")
        if not live["running"] and live["last_report"]:
            break
        time.sleep(0.1)
    assert live["progress"]["done"] == live["progress"]["total"] == 23
    last = live["last_report"]
    assert last["verdict"] == "PASS" and last["counts"]["FAIL"] == 0 and len(last["steps"]) == 23
    assert last["project"]["name"].startswith("Self-test ")
    # report download requires auth
    assert call(port, "GET", "/api/selftest/report?format=md", token=None)[0] == 401
    assert call(port, "GET", "/api/selftest/report?format=md", token="wrong")[0] == 401
    status, md, resp = call(port, "GET", "/api/selftest/report?format=md&download=1")
    assert status == 200 and resp.getheader("Content-Type").startswith("text/markdown")
    assert resp.getheader("Content-Disposition").startswith("attachment") and md.startswith("# Akọwe self-test".encode("utf-8"))
    status, js, _ = call(port, "GET", "/api/selftest/report?format=json")
    assert status == 200 and js["verdict"] == "PASS"
    assert call(port, "GET", "/api/selftest/report?format=html")[0] == 400
    assert APP_TOKEN.encode() not in md
    # the self-test project shows up in the author's project list
    status, projects, _ = call(port, "GET", "/api/projects")
    assert any(p["project_id"] == last["project"]["project_id"] for p in projects)


def test_runner_summary_survives_restart(app, tmp_path):
    run(app)
    fresh = App(tmp_path / "data", token=APP_TOKEN)
    try:
        st = fresh.selftest.status()
        assert st["running"] is False and st["last_report"]["verdict"] == "PASS"
    finally:
        fresh.store.close()


def test_cli_selftest(tmp_path, capsys):
    from akowe.selftest import main
    assert main(["--data-dir", str(tmp_path / "cli")]) == 0
    out = capsys.readouterr().out
    assert "Result: PASS" in out and "selftest-" in out
    store = Store(tmp_path / "cli")
    try:
        assert any(r["name"].startswith("Self-test ") for r in store.query("SELECT name FROM projects"))
    finally:
        store.close()
