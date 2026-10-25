"""AutoInjector bridge adapter (docs/AKOWE_AUTOINJECTOR_BRIDGE.md, contract v1).

An in-process fake bridge (http.server on an ephemeral port) implements the contract: bearer
auth, GET /v1/health, POST /v1/complete with request_id idempotency and scripted outcomes.
"""
from __future__ import annotations

import hmac
import http.client
import json
import logging
import re
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from akowe import providers as prov
from akowe.errors import AkoweError
from akowe.providers import extract_json_object
from akowe.server import App, make_handler

from conftest import errors_of

BRIDGE_TOKEN = "bridge-token-abcdefghijklmnopqrstuvwxyz"
APP_TOKEN = "app-token-123"
B01_OUT = {"premise": "A keeper hears the drowned.", "dramatic_question": "Will she answer?",
           "concept_summary": "Sea"}
ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


class FakeBridge:
    """Contract v1 fake. `script` holds outcomes consumed by /v1/complete sends (not cache hits):
    ("ok", text) | ("status", http_status, error_code) | ("timeout_then_cache", text)."""

    def __init__(self, token=BRIDGE_TOKEN):
        self.token = token
        self.script: list = []
        self.default_text = json.dumps(B01_OUT)
        self.sends: list[dict] = []     # requests that reached a site (prompt delivered)
        self.requests: list[dict] = []  # every /v1/complete body seen
        self.cache: dict[str, dict] = {}
        self.auth_headers: list = []
        self.health_sites = {s: {"ready": True, "busy": False} for s in ("chatgpt", "claude", "gemini")}
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

            def _err(self, status, code, ambiguous=False):
                self._send(status, {"ok": False, "error": code, "message": code.lower(), "ambiguous": ambiguous})

            def _authed(self):
                auth = self.headers.get("Authorization") or ""
                bridge.auth_headers.append(auth)
                ok = auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].encode(), bridge.token.encode())
                if not ok:
                    self._err(401, "UNAUTHORIZED")
                return ok

            def do_GET(self):
                if not self._authed():
                    return
                if self.path != "/v1/health":
                    return self._err(404, "NOT_FOUND")
                self._send(200, {"ok": True, "bridge_version": "1", "sites": bridge.health_sites})

            def do_POST(self):
                if not self._authed():
                    return
                if self.path != "/v1/complete":
                    return self._err(404, "NOT_FOUND")
                n = int(self.headers.get("Content-Length") or 0)
                if n > 1024 * 1024:
                    return self._err(413, "TOO_LARGE")
                try:
                    body = json.loads(self.rfile.read(n).decode("utf-8"))
                except ValueError:
                    return self._err(400, "BAD_REQUEST")
                bridge.requests.append(body)
                site, prompt, rid, tmo = (body.get("site"), body.get("prompt"), body.get("request_id"),
                                          body.get("timeout_ms", 240000))
                if site not in ("chatgpt", "claude", "gemini"):
                    return self._err(404, "UNKNOWN_SITE")
                if (not isinstance(prompt, str) or not prompt or not isinstance(rid, str) or not ID_RE.match(rid)
                        or not isinstance(tmo, int) or not 10000 <= tmo <= 900000):
                    return self._err(400, "BAD_REQUEST")
                if rid in bridge.cache:
                    return self._send(200, bridge.cache[rid])
                step = bridge.script.pop(0) if bridge.script else ("ok", bridge.default_text)
                if step[0] == "status":
                    return self._err(step[1], step[2], ambiguous=step[1] == 504)
                bridge.sends.append(body)
                res = {"ok": True, "site": site, "request_id": rid, "text": step[1],
                       "seq": f"{len(bridge.sends):04d}", "elapsed_ms": 5}
                bridge.cache[rid] = res
                if step[0] == "timeout_then_cache":
                    return self._err(504, "TIMEOUT", ambiguous=True)
                self._send(200, res)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def bridge():
    b = FakeBridge()
    yield b
    b.close()


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(prov.time, "sleep", lambda s: None)


def connect(h, bridge_url, slot="AI-1", site="claude", token=BRIDGE_TOKEN, **extra):
    return h.engine.providers.configure_slot(slot, dict({"adapter_id": "autoinjector", "site": site,
                                                         "bridge_url": bridge_url, "api_key": token}, **extra))


def b01(h, **kw):
    return h.create("B01", {"idea": "a keeper hears the sea", "goals": []}, **kw)


def provenance_resource(h, ref):
    row = h.store.query_one("SELECT resource FROM provenance WHERE record_id=?", (ref["record_id"],))
    return json.loads(row["resource"])


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ---------------------------------------------------------------------------- happy path
def test_b01_create_through_bridge(h, bridge, caplog):
    caplog.set_level(logging.DEBUG)
    slot = connect(h, bridge.url)
    assert slot["input_cost_minor_per_mtok"] == 0 and slot["output_cost_minor_per_mtok"] == 0
    assert slot["has_credentials"] and slot["site"] == "claude"
    r = b01(h)
    assert r["status"] == "DRAFT", r
    assert h.record(r["output_refs"][0])["data"] == B01_OUT
    res = provenance_resource(h, r["output_refs"][0])
    assert res["ai_slot"] == "AI-1" and res["model"] == "web:claude" and res["adapter_id"] == "autoinjector"
    assert res["input_tokens"] > 0 and res["output_tokens"] > 0
    assert len(bridge.sends) == 1
    sent = bridge.sends[0]
    assert sent["site"] == "claude" and 10000 <= sent["timeout_ms"] <= 900000
    lines = sent["prompt"].split("\n")
    i = lines.index("JSON_SCHEMA:")
    assert lines[i + 2] == "END_JSON_SCHEMA"
    schema = json.loads(lines[i + 1])
    assert set(schema["required"]) == {"premise", "dramatic_question", "concept_summary"}
    assert "Project context package (JSON):" in sent["prompt"] and "a keeper hears the sea" in sent["prompt"]
    assert "exactly one JSON object" in sent["prompt"]
    assert sent["request_id"] == f"bf-{r['request_id']}-claude-c0-a0"
    assert all(a == f"Bearer {BRIDGE_TOKEN}" for a in bridge.auth_headers)
    # never log prompts, replies or the token
    logs = caplog.text
    assert BRIDGE_TOKEN not in logs and "a keeper hears the sea" not in logs and "drowned" not in logs


def test_json_extraction_tolerates_fences_and_prose():
    obj = {"a": 1, "b": {"c": "x}"}}
    assert extract_json_object(json.dumps(obj)) == obj
    assert extract_json_object("Sure! Here it is:\n```json\n" + json.dumps(obj) + "\n```\nHope it helps.") == obj
    assert extract_json_object("Here {not json} then " + json.dumps(obj) + " and {\"z\": 2}") == obj
    assert extract_json_object("``` \n" + json.dumps(obj) + "```") == obj
    assert extract_json_object("a stray { brace then " + json.dumps(obj)) == obj
    assert extract_json_object("[1, 2]") is None and extract_json_object("no json here") is None


def test_json_inside_prose_through_bridge(h, bridge):
    connect(h, bridge.url)
    bridge.script = [("ok", "Of course. Here is the premise:\n\n```json\n" + json.dumps(B01_OUT, indent=2)
                      + "\n```\n\nLet me know if you want changes.\n")]
    r = b01(h)
    assert r["status"] == "DRAFT", r
    assert h.record(r["output_refs"][0])["data"] == B01_OUT and len(bridge.sends) == 1


# ---------------------------------------------------------------------------- schema re-asks
def test_invalid_then_valid_reask(h, bridge):
    connect(h, bridge.url)
    bridge.script = [("ok", json.dumps({"premise": "only this"})), ("ok", json.dumps(B01_OUT))]
    r = b01(h)
    assert r["status"] == "DRAFT", r
    assert len(bridge.sends) == 2
    ids = [s["request_id"] for s in bridge.sends]
    assert ids[0].endswith("-a0") and ids[1].endswith("-a1") and ids[0][:-1] == ids[1][:-1]
    second = bridge.sends[1]["prompt"]
    assert "'dramatic_question' is a required property" in second and "JSON_SCHEMA:" in second


def test_three_invalid_replies_fail_cleanly(h, bridge):
    connect(h, bridge.url)
    bridge.script = [("ok", "I cannot do that."), ("ok", json.dumps({"premise": 3})),
                     ("ok", json.dumps(dict(B01_OUT, extra="no")))]
    r = b01(h)
    assert r["status"] == "BLOCKED" and errors_of(r)[0][0] == "INTERNAL_ERROR", r
    assert "nothing was saved" in r["errors"][0]["message"]
    assert len(bridge.sends) == 3
    assert h.store.query_one("SELECT COUNT(*) c FROM records")["c"] == 0


# ---------------------------------------------------------------------------- error mapping
def test_busy_409_is_retried_with_the_same_request_id(h, bridge):
    connect(h, bridge.url)
    bridge.script = [("status", 409, "SITE_BUSY")]
    r = b01(h)
    assert r["status"] == "DRAFT", r
    assert len(bridge.requests) == 2 and len(bridge.sends) == 1
    assert bridge.requests[0]["request_id"] == bridge.requests[1]["request_id"]


def test_unauthorized_maps_to_capability_unavailable(h, bridge):
    connect(h, bridge.url, token="wrong-token")
    r = b01(h)
    assert r["status"] == "BLOCKED" and errors_of(r)[0][0] == "CAPABILITY_UNAVAILABLE", r
    assert r["unresolved_requests"] == ["B01:manual_candidate"]
    assert not bridge.sends


def test_connection_refused_maps_to_upstream_unavailable(h):
    connect(h, f"http://127.0.0.1:{free_port()}")
    r = b01(h)
    assert r["status"] == "BLOCKED" and errors_of(r)[0][0] == "UPSTREAM_UNAVAILABLE", r
    assert r["errors"][0]["retryable"] is True


@pytest.mark.parametrize("status,code,expected", [
    (503, "SITE_NOT_READY", "UPSTREAM_UNAVAILABLE"), (502, "SEND_FAILED", "UPSTREAM_UNAVAILABLE"),
    (400, "BAD_REQUEST", "INVALID_INPUT"), (413, "TOO_LARGE", "INVALID_INPUT")])
def test_status_mapping(h, bridge, status, code, expected):
    connect(h, bridge.url)
    bridge.script = [("status", status, code)] * 3
    r = b01(h)
    assert errors_of(r)[0][0] == expected, r
    assert h.store.query_one("SELECT COUNT(*) c FROM records")["c"] == 0


def test_timeout_needs_user_decision_and_retry_reuses_the_reply(h, bridge):
    connect(h, bridge.url)
    bridge.script = [("timeout_then_cache", json.dumps(B01_OUT))]
    req = h.request("B01", "CREATE", payload={"idea": "a keeper hears the sea", "goals": []})
    r = h.engine.dispatch(req, h.principal)
    assert r["status"] == "BLOCKED" and errors_of(r)[0][0] == "TIMEOUT", r
    assert "user_decision:retry_ambiguous_generation" in r["unresolved_requests"]
    assert len(bridge.requests) == 1  # ambiguous: never silently re-sent
    # The user retries the same logical call: same bridge request_id -> cached reply, no second send.
    again = h.engine.dispatch(req, h.principal)
    assert again["status"] == "DRAFT", again
    assert len(bridge.sends) == 1 and len(bridge.requests) == 2
    assert bridge.requests[0]["request_id"] == bridge.requests[1]["request_id"]


# ---------------------------------------------------------------------------- roles
def test_roles_route_operations(h, bridge):
    pr = h.engine.providers
    connect(h, bridge.url, "AI-1", "claude", roles=["b"])
    connect(h, bridge.url, "AI-2", "chatgpt", roles=["C"])
    connect(h, bridge.url, "AI-3", "gemini")
    assert pr.slots()[0]["roles"] == ["B"]
    assert pr.eligible(h.project_id, "text", 100, "C02")[0]["slot_id"] == "AI-2"
    assert [s["slot_id"] for s in pr.eligible(h.project_id, "text", 100, "C02")] == ["AI-2"]
    assert pr.eligible(h.project_id, "text", 100, "B05")[0]["slot_id"] == "AI-1"
    assert len(pr.eligible(h.project_id, "text", 100, "A01")) == 3  # no role match: normal order
    ctx = SimpleNamespace(project_id=h.project_id, op_id="C02", request={"request_id": "req-c02", "deadline": None})
    bridge.default_text = json.dumps({"x": "y"})
    data, res = pr.generate(ctx, task="t", output_schema={"type": "object", "properties": {"x": {"type": "string"}},
                                                          "required": ["x"]},
                            context={}, capability="text", protected_facts=[])
    assert data == {"x": "y"} and res["ai_slot"] == "AI-2" and res["model"] == "web:chatgpt"
    assert bridge.sends[-1]["site"] == "chatgpt" and bridge.sends[-1]["timeout_ms"] == 240000
    # B01 goes to the B-role slot through the real dispatch path.
    bridge.default_text = json.dumps(B01_OUT)
    r = b01(h)
    assert provenance_resource(h, r["output_refs"][0])["ai_slot"] == "AI-1" and bridge.sends[-1]["site"] == "claude"


# ---------------------------------------------------------------------------- configuration
@pytest.mark.parametrize("url", ["http://example.com:17891", "https://127.0.0.1:17891", "http://127.0.0.1.evil.test:1",
                                 "http://user:pw@127.0.0.1:17891", "http://127.0.0.1:17891/v1", "ftp://localhost:1",
                                 "http://0.0.0.0:17891", "http://[::1]:17891", "127.0.0.1:17891", ""])
def test_non_localhost_bridge_url_rejected(h, url):
    with pytest.raises(AkoweError) as e:
        connect(h, url)
    assert e.value.code == "INVALID_INPUT" and e.value.errors[0]["path"] == "/bridge_url"
    assert h.engine.providers.slots()[0]["adapter_id"] == "none"
    assert not h.engine.providers._secrets()  # nothing stored on a rejected configuration


def test_slot_validation(h):
    pr = h.engine.providers
    assert connect(h, "http://localhost:17891/")["bridge_url"] == "http://localhost:17891"
    with pytest.raises(AkoweError):
        pr.configure_slot("AI-2", {"adapter_id": "autoinjector"})  # site required
    with pytest.raises(AkoweError):
        pr.configure_slot("AI-2", {"adapter_id": "autoinjector", "site": "bing"})
    with pytest.raises(AkoweError):
        pr.configure_slot("AI-2", {"roles": ["C2"]})
    with pytest.raises(AkoweError):
        pr.configure_slot("AI-2", {"roles": "C"})
    assert pr.configure_slot("AI-2", {"roles": ["c02", "B"]})["roles"] == ["C02", "B"]
    assert pr.slots()[0]["max_concurrent"] == 1


# ---------------------------------------------------------------------------- HTTP endpoints
@pytest.fixture
def app_server(tmp_path):
    app = App(tmp_path / "data", token=APP_TOKEN)
    app.engine.providers.secret_path = tmp_path / "secrets.json"
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield app, httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()
        app.store.close()


def call(port, method, path, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    hdrs = {"Authorization": f"Bearer {APP_TOKEN}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=hdrs)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    return resp.status, json.loads(raw)


def test_connect_autoinjector_endpoint_and_health(app_server, bridge, tmp_path):
    app, port = app_server
    status, out = call(port, "POST", "/api/slots/connect-autoinjector", {"token": ""})
    assert status == 400 and out["errors"][0]["code"] == "MISSING_INPUT"
    status, out = call(port, "POST", "/api/slots/connect-autoinjector",
                       {"token": BRIDGE_TOKEN, "bridge_url": "http://10.0.0.5:17891"})
    assert status == 400 and out["errors"][0]["path"] == "/bridge_url"
    status, slots = call(port, "POST", "/api/slots/connect-autoinjector", {"token": BRIDGE_TOKEN, "bridge_url": bridge.url})
    assert status == 200, slots
    assert {s["slot_id"]: s["site"] for s in slots} == {"AI-1": "claude", "AI-2": "chatgpt", "AI-3": "gemini"}
    assert all(s["adapter_id"] == "autoinjector" and s["has_credentials"] and s["bridge_url"] == bridge.url
               for s in slots)
    assert all(app.engine.providers._api_key(s) == BRIDGE_TOKEN for s in ("AI-1", "AI-2", "AI-3"))

    bridge.health_sites["gemini"] = {"ready": True, "busy": True}
    status, hc = call(port, "GET", "/api/slots/AI-3/health")
    assert status == 200 and hc["ok"] is True and hc["site"] == "gemini" and hc["site_busy"] is True
    assert set(hc["sites"]) == {"chatgpt", "claude", "gemini"} and "busy" in hc["message"]
    bridge.health_sites["claude"] = {"ready": False, "busy": False}
    status, hc = call(port, "GET", "/api/slots/AI-1/health")
    assert status == 200 and hc["ok"] is False and "not ready" in hc["message"]

    call(port, "PUT", "/api/slots/AI-2", {"api_key": "bad-token"})
    status, hc = call(port, "GET", "/api/slots/AI-2/health")
    assert status == 200 and hc["ok"] is False and hc["error"] == "CAPABILITY_UNAVAILABLE"
    call(port, "PUT", "/api/slots/AI-2", {"bridge_url": f"http://127.0.0.1:{free_port()}"})
    status, hc = call(port, "GET", "/api/slots/AI-2/health")
    assert hc["ok"] is False and hc["error"] == "UPSTREAM_UNAVAILABLE" and "not reachable" in hc["message"]
    call(port, "PUT", "/api/slots/AI-2", {"adapter_id": "anthropic"})
    assert call(port, "GET", "/api/slots/AI-2/health")[0] == 400
    assert call(port, "GET", "/api/slots/AI-9/health")[0] == 404

    # The token never lands in stored settings, the slots API, the database or a project export.
    status, proj = call(port, "POST", "/api/projects", {"name": "Bridge Book"})
    pid = proj["project_id"]
    status, out = call(port, "POST", "/api/dispatch", {"request": {
        "project_id": pid, "branch_id": "main", "target_operation": "B01", "action": "CREATE",
        "payload": {"idea": "a keeper hears the sea", "goals": []}}})
    assert out["response"]["status"] == "DRAFT", out
    assert BRIDGE_TOKEN not in json.dumps(app.store.get_setting("ai_slots"))
    assert BRIDGE_TOKEN not in json.dumps(call(port, "GET", "/api/slots")[1])
    status, export = call(port, "GET", f"/api/projects/{pid}/branches/main/export")
    assert status == 200 and BRIDGE_TOKEN not in json.dumps(export)
    for f in (tmp_path / "data").rglob("*"):
        if f.is_file():
            assert BRIDGE_TOKEN.encode() not in f.read_bytes(), f
