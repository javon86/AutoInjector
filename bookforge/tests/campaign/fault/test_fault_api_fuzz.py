"""API fuzzing (fault campaign): malformed / wrong-typed / oversized input, wrong methods, unknown ids, path traversal
and auth on every route. Expectation: a clean 4xx JSON answer with a message, never a 500, never a hang, and never a
byte from outside the data folder."""
from __future__ import annotations

import http.client
import json
import socket
import threading
from http.server import ThreadingHTTPServer

import pytest

from bookforge.server import App, make_handler

from fault_helpers import TOKEN, call

ROUTES_GET = [
    "/api/session", "/api/operations", "/api/sets", "/api/operations/A01/schema", "/api/slots", "/api/slots/AI-1/health",
    "/api/selftest", "/api/selftest/report", "/api/workflow-test", "/api/workflow-test/report", "/api/autobook",
    "/api/autobook/run-x", "/api/jobs", "/api/health", "/api/diagnostics", "/api/backups", "/api/shelf",
    "/api/settings/ai-retry", "/api/assist/x", "/api/bible-builder", "/api/bible-builder/x",
    "/api/bible-builder/x/report", "/api/projects", "/api/projects/{pid}", "/api/projects/{pid}/profile",
    "{B}/manifest", "{B}/records", "{B}/records/x", "{B}/assets/x/1", "{B}/journal", "{B}/activity", "{B}/export",
    "{B}/progress", "{B}/book", "{B}/book/write-all", "{B}/book/write-all/x", "{B}/review", "{B}/review/summary",
    "{B}/review/settings", "{B}/review/ai/x", "{B}/review/record/x",
]
ROUTES_WRITE = [
    ("POST", "/api/slots/connect-autoinjector"), ("POST", "/api/slots/pair-autoinjector"), ("PUT", "/api/slots/AI-1"),
    ("POST", "/api/selftest"), ("POST", "/api/workflow-test/run"), ("POST", "/api/workflow-test/stop"),
    ("POST", "/api/autobook"), ("POST", "/api/autobook/x/pause"), ("POST", "/api/autobook/x/decide"),
    ("POST", "/api/jobs/x/resume"), ("POST", "/api/jobs/x/dismiss"), ("POST", "/api/diagnostics"),
    ("POST", "/api/backups"), ("PUT", "/api/backups/settings"), ("POST", "/api/backups/x/restore"),
    ("PUT", "/api/settings/ai-retry"), ("POST", "/api/assist"), ("POST", "/api/assist/x/cancel"),
    ("POST", "/api/bible-builder"), ("POST", "/api/bible-builder/x/run"), ("POST", "/api/projects"),
    ("POST", "/api/dispatch"), ("POST", "/api/projects/{pid}/branches"), ("POST", "/api/projects/{pid}/backup"),
    ("PUT", "/api/projects/{pid}/profile"), ("PUT", "{B}/manifest"), ("POST", "{B}/uploads"),
    ("POST", "{B}/book/create"), ("POST", "{B}/book/write-all"), ("POST", "{B}/review/approve"),
    ("PUT", "{B}/review/settings"), ("POST", "{B}/review/ai"), ("POST", "{B}/review/fix"),
]


@pytest.fixture
def srv(tmp_path):
    outside = tmp_path / "outside-secret.txt"
    outside.write_text("TOP-SECRET-OUTSIDE-DATA-DIR")
    app = App(tmp_path / "data", token=TOKEN)
    app.engine.providers.secret_path = tmp_path / "secrets.json"
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
    port = httpd.server_address[1]
    st, proj = call(port, "POST", "/api/projects", {"name": "Fuzz book"})
    assert st == 201
    try:
        yield app, port, proj["project_id"]
    finally:
        httpd.shutdown()
        httpd.server_close()
        app.store.close()


def fill(path, pid):
    return path.replace("{B}", f"/api/projects/{pid}/branches/main").replace("{pid}", pid)


def is_clean_error(status, body):
    return 400 <= status < 500 and isinstance(body, dict) and body.get("errors") and \
        all(e.get("code") and e.get("message") for e in body["errors"])


# ---------------------------------------------------------------------------------------------- auth
def test_every_api_route_rejects_missing_and_wrong_token(srv):
    app, port, pid = srv
    assert call(port, "GET", "/api/ping", token=None)[0] == 200
    routes = [("GET", fill(p, pid)) for p in ROUTES_GET] + [(m, fill(p, pid)) for m, p in ROUTES_WRITE]
    for method, path in routes:
        for tok in (None, "wrong-token", TOKEN + "x", ""):
            st, body = call(port, method, path, {} if method != "GET" else None, token=tok)
            assert st == 401 and body["errors"][0]["code"] == "PERMISSION_DENIED", (method, path, tok, st)
    # nothing was created by the refused writes
    assert len(app.store.query("SELECT * FROM projects")) == 1
    assert not (app.store.data_dir / "backups").exists() or not list((app.store.data_dir / "backups").iterdir())


# ---------------------------------------------------------------------------------------------- malformed bodies
CLEAN_CASES = [  # already answered with a clean 4xx today (regression guard)
    ("POST", "/api/projects", {"name": ""}),
    ("POST", "/api/projects", {"name": "x", "features": {"magic": "yes"}}),
    ("POST", "/api/dispatch", {"request": "x"}),
    ("POST", "/api/projects/{pid}/branches", {"branch_id": "../evil"}),
    ("POST", "/api/projects/{pid}/branches", {"branch_id": "a/b"}),
    ("PUT", "/api/backups/settings", {"keep": "5"}),
    ("PUT", "/api/backups/settings", {"keep": True}),
    ("POST", "/api/backups/..%2F..%2Fx/restore", {"author_confirms": True, "confirm": "RESTORE"}),
    ("POST", "/api/backups/%2e%2e/restore", {"author_confirms": True, "confirm": "RESTORE"}),
    ("POST", "/api/backups/x%00y/restore", {"author_confirms": True, "confirm": "RESTORE"}),
    ("PUT", "/api/settings/ai-retry", {"delays_s": [1.5]}),
    ("PUT", "/api/settings/ai-retry", {"max_total_s": 10 ** 30}),
    ("POST", "/api/autobook", {"author_confirms": "true"}),
    ("POST", "/api/autobook/x/decide", {"action": 5}),
    ("POST", "/api/jobs/..%2F..%2Fx/resume", None),
    ("GET", "{B}/assets/..%2F..%2Foutside-secret.txt/1", None),
    ("GET", "{B}/assets/x/-1", None),
    ("GET", "{B}/records/..%2F..%2F..%2Fetc%2Fpasswd", None),
    ("GET", "/api/projects/..%2F..%2F/branches/main/records", None),
    ("GET", "/api/projects/{pid}/branches/..%2Fmain/records", None),
    ("GET", "/api/projects/%00/branches/main/records", None),
    ("GET", "{B}/journal?step=../../x", None),
    ("GET", "/api/selftest/report?format=../../x", None),
    ("GET", "/api/bible-builder/..%2F..%2Fx/report", None),
    ("GET", "/api/operations/..%2F..%2Fx/schema", None),
    ("POST", "{B}/review/approve", {"record_ids": "abc", "author_confirms": True}),
    ("POST", "{B}/review/approve", {"record_ids": ["x"]}),
    ("PUT", "{B}/review/settings", {"auto_approve": "yes"}),
    ("POST", "{B}/review/ai", {"record_ids": 5}),
    ("POST", "{B}/book/bogus", {}),
    ("POST", "{B}/uploads", None),
    ("POST", "/api/slots/connect-autoinjector", {"token": "x", "bridge_url": "http://evil.example"}),
    ("POST", "/api/slots/pair-autoinjector", {"code": "../../x", "bridge_url": "file:///etc/passwd"}),
    ("PUT", "/api/slots/..%2F..%2Fx", {}),
    ("POST", "/api/workflow-test/run", {"rows": ["../../x"]}),
    ("POST", "/api/bible-builder", {"project_id": "../../x"}),
    ("POST", "/api/assist", {"project_id": "../../x", "branch_id": "main", "op": "A01"}),
    ("DELETE_NOT", "/api/nope", None),
]


@pytest.mark.parametrize("method,path,body", [c for c in CLEAN_CASES if c[0] != "DELETE_NOT"])
def test_malformed_requests_get_a_clean_4xx(srv, method, path, body):
    app, port, pid = srv
    st, out = call(port, method, fill(path, pid), body)
    assert is_clean_error(st, out), (st, out)
    assert b"TOP-SECRET" not in json.dumps(out).encode()


# NEW-fault-1: wrong-typed JSON bodies / path values used to raise inside the route and answer 500 INTERNAL_ERROR
SERVER_500_CASES = [
    ("POST", "/api/projects", [1]),
    ("POST", "/api/projects", "just a string"),
    ("POST", "/api/projects", {"name": 5}),
    ("POST", "/api/projects", {"name": "x", "currency": ["USD"]}),
    ("POST", "/api/dispatch", [1]),
    ("POST", "/api/dispatch", {"request": {"project_id": "{pid}", "branch_id": "main", "target_operation": ["A01"],
                                           "action": "CREATE"}}),
    ("POST", "/api/projects/{pid}/branches", [1]),
    ("POST", "/api/projects/{pid}/branches", {"branch_id": 5}),
    ("PUT", "{B}/manifest", [1]),
    ("GET", "{B}/assets/x/%C2%B2", None),                       # '²'.isdigit() is True, int('²') raises
    ("GET", "{B}/assets/x/99999999999999999999999", None),      # too large for SQLite INTEGER
    ("POST", "/api/autobook", {"author_confirms": True, "length": ["short_story"]}),
]


@pytest.mark.parametrize("method,path,body", SERVER_500_CASES)
def test_wrong_typed_input_is_a_4xx_not_a_500(srv, method, path, body):
    app, port, pid = srv
    body = json.loads(json.dumps(body).replace("{pid}", pid)) if body is not None else None
    st, out = call(port, method, fill(path, pid), body)
    assert is_clean_error(st, out), (st, out)


def test_deeply_nested_json_is_a_4xx(srv):
    app, port, pid = srv
    st, out = call(port, "POST", "/api/projects", raw=b"[" * 100000 + b"]" * 100000)
    assert is_clean_error(st, out), (st, out)


def _raw(port, data: bytes, timeout=3.0) -> bytes:
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        s.sendall(data)
        return s.recv(200)
    except socket.timeout:
        return b"<timeout>"
    finally:
        s.close()


def test_non_numeric_content_length_is_a_4xx(srv):
    app, port, pid = srv
    out = _raw(port, b"POST /api/projects HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + TOKEN.encode() +
               b"\r\nContent-Type: application/json\r\nContent-Length: abc\r\n\r\n{}")
    assert out.split(b" ")[1].startswith(b"4"), out


def test_negative_content_length_answers_promptly(srv):
    app, port, pid = srv
    out = _raw(port, b"POST /api/projects HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + TOKEN.encode() +
               b"\r\nContent-Type: application/json\r\nContent-Length: -1\r\n\r\n{}")
    assert out != b"<timeout>" and out.split(b" ")[1].startswith(b"4"), out


def test_oversized_body_refused_before_reading(srv):
    app, port, pid = srv
    out = _raw(port, b"POST /api/projects HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + TOKEN.encode() +
               b"\r\nContent-Type: application/json\r\nContent-Length: " + str(64 * 1024 * 1024 + 1).encode() +
               b"\r\n\r\n{}")
    assert out.startswith(b"HTTP/1.0 413"), out


def test_nan_in_body_cannot_poison_the_project_list(srv):
    app, port, pid = srv
    call(port, "POST", "/api/projects", raw=b'{"name": "n", "settings": {"a": NaN, "b": Infinity}}')
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", "/api/projects", headers={"Authorization": f"Bearer {TOKEN}"})
    raw = conn.getresponse().read()
    conn.close()

    def strict(c):
        raise ValueError(f"non-standard JSON constant {c}")
    json.loads(raw, parse_constant=strict)  # what a browser's JSON.parse accepts


@pytest.mark.parametrize("method", ["DELETE", "PATCH", "OPTIONS"])
def test_unsupported_methods_get_json_405(srv, method):
    app, port, pid = srv
    st, out = call(port, method, "/api/projects")
    assert st == 405 and isinstance(out, dict) and out.get("errors"), (st, out[:80] if isinstance(out, bytes) else out)


def test_unknown_ids_are_clean_404s(srv):
    app, port, pid = srv
    for method, path, body in [
            ("GET", "/api/projects/proj-nope", None), ("GET", "/api/projects/proj-nope/branches/main/records", None),
            ("GET", "{B}/records/A01-nope", None), ("GET", "{B}/assets/I01-nope/1", None),
            ("GET", "/api/projects/{pid}/branches/nope/records", None), ("GET", "/api/autobook/run-nope", None),
            ("POST", "/api/jobs/job-nope/resume", None), ("POST", "/api/jobs/job-nope/dismiss", None),
            ("POST", "/api/backups/auto-nope/restore", {"author_confirms": True, "confirm": "RESTORE"}),
            ("GET", "/api/operations/Z99/schema", None), ("GET", "{B}/book/write-all/nope", None),
            ("GET", "/api/assist/nope", None), ("GET", "/api/bible-builder/nope", None)]:
        st, out = call(port, method, fill(path, pid), body)
        assert is_clean_error(st, out) and st in (400, 403, 404), (path, st, out)


def test_static_paths_cannot_escape_the_web_folder(srv):
    app, port, pid = srv
    for raw_path in [b"/static/../../server.py", b"/static/..%2f..%2fserver.py", b"/static/%2e%2e/%2e%2e/server.py",
                     b"/static//etc/passwd", b"/static/../../../outside-secret.txt", b"/..%2f..%2fstore.py",
                     b"/static/a%00b", b"/static/....//....//server.py"]:
        out = _raw(port, b"GET " + raw_path + b" HTTP/1.1\r\nHost: x\r\n\r\n", timeout=3)
        assert out.startswith(b"HTTP/1.0 404"), (raw_path, out)


def test_asset_and_upload_names_never_touch_files_outside_assets(srv, tmp_path):
    app, port, pid = srv
    before = sorted(p.name for p in tmp_path.iterdir())
    st, up = call(port, "POST", fill("{B}/uploads", pid), raw=b"\x89PNG fake", content_type="image/png",
                  headers={"X-Filename": "..%2F..%2F..%2Foutside-secret.txt"})
    assert st == 201
    files = sorted(p.name for p in (app.store.data_dir / "assets").iterdir())
    assert len(files) == 1 and files[0].endswith(".bin")
    assert sorted(p.name for p in tmp_path.iterdir()) == before
    assert (tmp_path / "outside-secret.txt").read_text() == "TOP-SECRET-OUTSIDE-DATA-DIR"
    st, body = call(port, "GET", fill(f"{{B}}/assets/{up['ref']['record_id']}/1", pid))
    assert st == 200 and body == b"\x89PNG fake"
