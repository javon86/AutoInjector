"""HTTP-level smoke test: server.App behind a real ThreadingHTTPServer on an ephemeral port."""
from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

from bookforge.canonical import sha256_bytes
from bookforge.server import WEB_DIR, App, make_handler
from test_set_g import png_bytes

TOKEN = "author-token-123"
OTHER_TOKEN = "other-token-456"


@pytest.fixture
def server(tmp_path):
    app = App(tmp_path / "data", token=TOKEN)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield app, httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()
        app.store.close()


def call(port, method, path, body=None, token=TOKEN, content_type="application/json", headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    hdrs = dict(headers or {})
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode() if content_type == "application/json" else body
        hdrs["Content-Type"] = content_type
    conn.request(method, path, body=data, headers=hdrs)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    ctype = resp.getheader("Content-Type") or ""
    return resp.status, (json.loads(raw) if ctype.startswith("application/json") else raw), resp


def test_http_smoke(server):
    app, port = server
    # static workspace
    status, body, resp = call(port, "GET", "/", token=None)
    assert status == 200 and body == (WEB_DIR / "index.html").read_bytes()
    assert resp.getheader("Content-Type").startswith("text/html") and resp.getheader("Content-Security-Policy")

    # bearer token required
    assert call(port, "GET", "/api/session", token=None)[0] == 401
    assert call(port, "GET", "/api/session", token="wrong")[0] == 401
    status, session, _ = call(port, "GET", "/api/session")
    assert status == 200 and session["principal_id"] == app.principal_id

    # project + dispatch A01 CREATE + list records
    status, proj, _ = call(port, "POST", "/api/projects", {"name": "Smoke Book"})
    assert status == 201, proj
    pid = proj["project_id"]
    cand = {"concept": "Mara Vell", "attributes": {}, "linked_refs": [], "protected_fact_flags": [], "facts": []}
    status, out, _ = call(port, "POST", "/api/dispatch", {
        "request": {"project_id": pid, "branch_id": "main", "target_operation": "A01", "action": "CREATE",
                    "payload": {"concept": "Mara Vell"}}, "manual_candidate": cand})
    assert status == 200 and out["response"]["status"] == "DRAFT", out
    a01 = out["response"]["output_refs"][0]
    status, recs, _ = call(port, "GET", f"/api/projects/{pid}/branches/main/records?module=A01")
    assert status == 200 and [r["record_id"] for r in recs] == [a01["record_id"]]
    assert recs[0]["title"] == "Mara Vell" and recs[0]["lifecycle"] == "DRAFT"

    # upload a PNG and read identical bytes back through /assets
    png = png_bytes(4, 3)
    status, up, _ = call(port, "POST", f"/api/projects/{pid}/branches/main/uploads", png, content_type="image/png",
                         headers={"X-Filename": "cover.png"})
    assert status == 201 and up["byte_length"] == len(png), up
    ref = up["ref"]
    assert ref["content_hash"] == sha256_bytes(png)
    asset_path = f"/api/projects/{pid}/branches/main/assets/{ref['record_id']}/{ref['version']}"
    status, got, resp = call(port, "GET", asset_path)
    assert status == 200 and got == png and resp.getheader("Content-Type") == "image/png"
    assert call(port, "GET", asset_path, token=None)[0] == 401

    # a second principal (own token, own project via store grants) cannot read the first project's asset
    with app.store.transaction() as tx:
        tx.ensure_principal("other", "Other Author", sha256_bytes(OTHER_TOKEN.encode()))
    status, other_proj, _ = call(port, "POST", "/api/projects", {"name": "Other Book"}, token=OTHER_TOKEN)
    assert status == 201
    opid = other_proj["project_id"]
    assert app.store.has_project_access("other", opid) and not app.store.has_project_access("other", pid)
    status, err, _ = call(port, "GET", asset_path, token=OTHER_TOKEN)
    assert status == 403 and err["errors"][0]["code"] == "PERMISSION_DENIED"
    # nor by naming the record under its own project
    status, _, _ = call(port, "GET", f"/api/projects/{opid}/branches/main/assets/{ref['record_id']}/1",
                        token=OTHER_TOKEN)
    assert status == 404
    assert call(port, "GET", f"/api/projects/{pid}/branches/main/records", token=OTHER_TOKEN)[0] == 403
    assert call(port, "GET", f"/api/projects/{pid}/branches/main/export", token=OTHER_TOKEN)[0] == 403
    status, out, _ = call(port, "POST", "/api/dispatch", {
        "request": {"project_id": pid, "branch_id": "main", "target_operation": "A01", "action": "CREATE",
                    "payload": {"concept": "Intruder"}}, "manual_candidate": dict(cand, concept="Intruder")},
        token=OTHER_TOKEN)
    assert out["response"]["status"] != "DRAFT" and out["response"]["errors"][0]["code"] == "PERMISSION_DENIED"

    # export endpoint
    status, exp, _ = call(port, "GET", f"/api/projects/{pid}/branches/main/export")
    assert status == 200 and exp["project"]["project_id"] == pid and exp["branch_id"] == "main"
    by_id = {r["record_id"]: r for r in exp["records"]}
    assert by_id[a01["record_id"]]["data"]["concept"] == "Mara Vell"
    assert by_id[ref["record_id"]]["binary"]["mime_type"] == "image/png"
    assert "Intruder" not in json.dumps(exp)
