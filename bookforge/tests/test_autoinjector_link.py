"""AutoInjector link (BookForge side): one-button pairing and the status push, against an in-process fake bridge."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from bookforge.status_push import MAX_BODY, build_summary, encode

from test_server import TOKEN, call, server  # noqa: F401

PAIR_TOKEN = "paired-connection-key-0123456789abcdef"
CODE = "AB12-CD34-EF56"
CHAPTER_TEXT = "SECRET CHAPTER PROSE that must never leave BookForge"


class FakeBridge:
    def __init__(self):
        self.codes = {CODE}
        self.pair_requests = []
        self.status_bodies = []
        self.status_auth = []
        self.status_code = 200
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

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(n) or b"{}")

            def do_GET(self):
                if self.headers.get("Authorization") != f"Bearer {PAIR_TOKEN}":
                    return self._send(401, {"ok": False, "error": "UNAUTHORIZED"})
                sites = {s: {"ready": True, "busy": False} for s in ("claude", "chatgpt", "gemini")}
                self._send(200, {"ok": True, "bridge_version": "1", "sites": sites})

            def do_POST(self):
                if self.path == "/v1/pair":
                    body = self._body()
                    bridge.pair_requests.append({"body": body, "auth": self.headers.get("Authorization")})
                    if body.get("code") in bridge.codes:
                        bridge.codes.discard(body["code"])  # one-time
                        return self._send(200, {"ok": True, "token": PAIR_TOKEN})
                    return self._send(410, {"ok": False, "error": "PAIRING_CODE_EXPIRED"})
                if self.path == "/v1/status":
                    raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                    bridge.status_auth.append(self.headers.get("Authorization"))
                    bridge.status_bodies.append(raw)
                    if bridge.status_code != 200:
                        return self._send(bridge.status_code, {"ok": False})
                    return self._send(200, {"ok": True})
                self._send(404, {"ok": False})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def bridge():
    b = FakeBridge()
    yield b
    b.close()


@pytest.fixture
def app_server(server, tmp_path):  # noqa: F811
    app, port = server
    app.engine.providers.secret_path = tmp_path / "secrets.json"
    app.port = port
    return app, port


def test_pair_success_connects_three_slots_and_never_returns_the_key(app_server, bridge):
    app, port = app_server
    status, out, resp = call(port, "POST", "/api/slots/pair-autoinjector", {"code": CODE, "bridge_url": bridge.url})
    assert status == 200, out
    raw = json.dumps(out)
    assert PAIR_TOKEN not in raw and out["connected"] is True
    assert [(s["slot_id"], s["site"], s["ok"]) for s in out["slots"]] == [
        ("AI-1", "claude", True), ("AI-2", "chatgpt", True), ("AI-3", "gemini", True)]
    req = bridge.pair_requests[0]
    assert req["body"] == {"code": CODE, "client": "bookforge"} and req["auth"] is None
    slots = app.engine.providers.slots()
    assert all(s["adapter_id"] == "autoinjector" and s["has_credentials"] for s in slots)
    assert all(app.engine.providers._api_key(s["slot_id"]) == PAIR_TOKEN for s in slots)
    status, listed, _ = call(port, "GET", "/api/slots")
    assert PAIR_TOKEN not in json.dumps(listed)
    # the same code a second time: expired/used -> friendly message, nothing changes
    status, out, _ = call(port, "POST", "/api/slots/pair-autoinjector", {"code": CODE, "bridge_url": bridge.url})
    assert status == 400 and "expired or was already used" in out["errors"][0]["message"]
    assert "Connect again in AutoInjector" in out["errors"][0]["message"]


def test_pair_rejects_bad_codes_and_non_local_bridges(app_server, bridge):
    app, port = app_server
    for code in ("short", "has space 1234", "x" * 33, None, 12345678):
        status, out, _ = call(port, "POST", "/api/slots/pair-autoinjector", {"code": code, "bridge_url": bridge.url})
        assert status == 400 and out["errors"][0]["path"] == "/code"
    for url in ("http://example.com:17891", "https://127.0.0.1:17891", "http://127.0.0.1:17891/v1", "http://10.0.0.2"):
        status, out, _ = call(port, "POST", "/api/slots/pair-autoinjector", {"code": CODE, "bridge_url": url})
        assert status == 400 and out["errors"][0]["path"] == "/bridge_url", url
    assert bridge.pair_requests == []  # nothing was sent anywhere
    # bridge not running
    status, out, _ = call(port, "POST", "/api/slots/pair-autoinjector", {"code": CODE,
                                                                         "bridge_url": "http://127.0.0.1:9"})
    assert status == 400 and out["errors"][0]["code"] == "UPSTREAM_UNAVAILABLE"
    assert call(port, "POST", "/api/slots/pair-autoinjector", {"code": CODE}, token=None)[0] == 401
    assert all(s["adapter_id"] == "none" for s in app.engine.providers.slots())


def _book_with_chapter_draft(port):
    status, proj, _ = call(port, "POST", "/api/projects", {"name": "Status Book", "profile": {"title": "The Key"}})
    pid = proj["project_id"]
    cand = {"concept": "Mara Vell", "attributes": {}, "linked_refs": [], "protected_fact_flags": [], "facts": []}
    call(port, "POST", "/api/dispatch", {"request": {"project_id": pid, "branch_id": "main", "target_operation": "A01",
                                                     "action": "CREATE", "payload": {"concept": "Mara Vell"}},
                                         "manual_candidate": cand})
    call(port, "POST", "/api/dispatch", {"request": {"project_id": pid, "branch_id": "main", "target_operation": "B01",
                                                     "action": "CREATE", "payload": {"idea": "x", "goals": []}},
                                         "manual_candidate": {"premise": CHAPTER_TEXT, "dramatic_question": "q?",
                                                              "concept_summary": CHAPTER_TEXT}})
    call(port, "GET", f"/api/projects/{pid}/branches/main/book")  # opening the book makes it the "last used"
    return pid


def test_status_push_shape_size_titles_only_and_401(app_server, bridge):
    app, port = app_server
    pid = _book_with_chapter_draft(port)
    p = app.pusher
    assert p.tick(now=1000.0) == 0  # no AutoInjector slot yet: nothing is sent anywhere
    call(port, "POST", "/api/slots/pair-autoinjector", {"code": CODE, "bridge_url": bridge.url})
    assert p.tick(now=1000.0) == 1
    assert bridge.status_auth[-1] == f"Bearer {PAIR_TOKEN}"
    raw = bridge.status_bodies[-1]
    assert len(raw) < MAX_BODY
    body = json.loads(raw)
    assert body["app"] == "bookforge" and body["version"] == 1
    assert body["bookforge_url"] == f"http://127.0.0.1:{port}/"
    assert body["project"] == {"id": pid, "title": "The Key"}
    t = body["current_task"]
    assert set(t) == {"set", "op", "title", "state", "message", "url"}
    assert t["state"] in ("needs_you", "ai_can", "working", "blocked", "done")
    assert t["url"].startswith(f"http://127.0.0.1:{port}/#/p/{pid}/main/")
    assert body["approvals"]["count"] == 2 and body["approvals"]["url"].endswith(f"#/p/{pid}/main/review")
    assert {i["op"] for i in body["approvals"]["items"]} == {"A01", "B01"}
    assert all(set(i) == {"op", "set", "title"} for i in body["approvals"]["items"])
    assert body["checklist"][0]["id"] == "profile" and body["total"] == len(body["checklist"])
    assert all(c["state"] in ("done", "needs_you", "ai_can", "ready", "blocked", "waiting") for c in body["checklist"])
    assert body["working_on"] is None and body["updated_at"].endswith("Z")
    assert CHAPTER_TEXT.encode() not in raw and PAIR_TOKEN.encode() not in raw  # titles only, never text or keys
    # unchanged -> no push before the 30 s heartbeat; a change waits for the 5 s gap
    assert p.tick(now=1002.0) == 0
    assert p.tick(now=1031.0) == 1
    app.work.begin(pid, "C02", "Writing chapter ch1")
    assert p.tick(now=1032.0) == 0
    assert p.tick(now=1037.0) == 1
    assert json.loads(bridge.status_bodies[-1])["working_on"]["title"] == "Writing chapter ch1"
    # 401: stop pushing with this key until a new key is saved (pairing again)
    bridge.status_code = 401
    n = len(bridge.status_bodies)
    assert p.tick(now=1100.0) == 0 and len(bridge.status_bodies) == n + 1
    assert p.tick(now=1200.0) == 0 and len(bridge.status_bodies) == n + 1
    bridge.status_code = 200
    bridge.codes.add("NEW-CODE-1234")
    app.engine.providers.connect_autoinjector("another-key-abcdef12345", bridge.url)
    assert p.tick(now=1300.0) == 1  # a new key resets the stop


def test_status_push_backs_off_quietly_when_the_bridge_is_down(app_server):
    app, port = app_server
    _book_with_chapter_draft(port)
    app.engine.providers.connect_autoinjector("key-for-a-dead-bridge-123", "http://127.0.0.1:9")
    p = app.pusher
    assert p.tick(now=10.0) == 0 and p.last_error
    st = next(iter(p._targets.values()))
    assert st.fails == 1 and st.next_try > 10.0
    assert p.tick(now=10.5) == 0 and st.fails == 1  # still backing off: no new attempt


def test_status_body_is_capped(app_server):
    app, port = app_server
    _book_with_chapter_draft(port)
    body = build_summary(app, app.base_url())
    body["approvals"]["items"] = [{"op": "A01", "set": "A", "title": "x" * 60}] * 2000
    assert len(encode(body)) < MAX_BODY
    assert TOKEN not in json.dumps(body)
