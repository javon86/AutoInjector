"""BookForge side of the bridge fixes (campaign area "bridge"), without the desktop app.

* BF-01: an answer must name the [MSG #] it answers (seq / reply_to) or it is never used.
* NEW-bridge-2: after a 504 whose prompt WAS typed, "Try again" (a new BookForge request id) collects the late
  answer under the timed-out bridge request_id instead of being refused with 409 and typing the prompt twice;
  after a 504 whose prompt was never typed it simply asks again.
* The late window / busy-retry budget agree with the bridge (bookforge-bridge.js LATE_WINDOW_MAX_MS).
* BF-08: a second start never sends the access token to whatever answers on the port.
"""
from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from bookforge import jobs, providers as prov
from bookforge.errors import BookforgeError
from bookforge import server as srv

ROOT = Path(__file__).resolve().parents[3]
BRIDGE_JS = ROOT.parent / "desktop-app" / "bookforge-bridge.js"
TOKEN = "bridge-token-abcdefghijklmnopqrstuvwxyz"
SLOT = {"slot_id": "AI-1", "site": "claude"}
SCHEMA = {"type": "object", "required": ["x"], "properties": {"x": {"type": "integer"}}}


class Scripted:
    """A loopback HTTP server answering each request with the next scripted (status, body)."""

    def __init__(self, script, path_prefix="/v1/"):
        self.script = list(script)
        self.seen: list[dict] = []
        me = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _any(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                me.seen.append({"method": self.command, "path": self.path, "headers": dict(self.headers),
                                "body": json.loads(raw) if raw else None})
                status, body = me.script.pop(0) if me.script else (500, {"ok": False})
                if callable(body):
                    body = body(self.path)
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _any

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture(autouse=True)
def clean_late():
    prov._LATE_TYPED.clear()
    yield
    prov._LATE_TYPED.clear()


def ok(seq="0007", reply_to="same", text='{"x": 1}'):
    body = {"ok": True, "site": "claude", "request_id": "r", "text": text, "elapsed_ms": 5}
    if seq is not None:
        body["seq"] = seq
    if reply_to == "same":
        body["reply_to"] = seq
    elif reply_to is not None:
        body["reply_to"] = reply_to
    return 200, body


def timeout(typed, **extra):
    return 504, {"ok": False, "error": "TIMEOUT", "message": "t", "ambiguous": bool(typed), "typed": typed, **extra}


def submit(url, request_id):
    return prov.AutoInjectorAdapter(TOKEN, url).submit(SLOT, "sys", "user", SCHEMA, request_id=request_id)


def test_answer_without_seq_is_never_used():
    b = Scripted([ok(seq=None, reply_to=None)])
    try:
        with pytest.raises(BookforgeError) as ei:
            submit(b.url, "req-1")
        assert "which message it answers" in str(ei.value)
    finally:
        b.close()


def test_answer_to_another_message_is_never_used():
    b = Scripted([ok(seq="0007", reply_to="0006")])
    try:
        with pytest.raises(BookforgeError) as ei:
            submit(b.url, "req-1")
        assert "#0006" in str(ei.value) and "#0007" in str(ei.value)
    finally:
        b.close()


def test_answer_with_matching_seq_is_used():
    b = Scripted([ok(seq="0007")])
    try:
        data, usage = submit(b.url, "req-1")
        assert data == {"x": 1}
    finally:
        b.close()


def test_try_again_after_typed_timeout_collects_the_late_answer():
    b = Scripted([timeout(True, seq="0009", late_window_ms=300000), ok(seq="0009")])
    try:
        with pytest.raises(BookforgeError) as ei:
            submit(b.url, "req-first")
        msg = str(ei.value)
        assert "was typed into claude" in msg and "Try again collects it" in msg
        data, usage = submit(b.url, "req-second")  # "Try again": a NEW BookForge request id
        first, second = (s["body"]["request_id"] for s in b.seen)
        assert second == first, "the retry must use the timed-out bridge request_id (no second typing)"
        assert "req-first" in first and data == {"x": 1}
        assert usage["provider_request_id"] == first
        # collected: the next call is a fresh request again
        b.script.append(ok(seq="0010"))
        submit(b.url, "req-third")
        assert "req-third" in b.seen[-1]["body"]["request_id"]
    finally:
        b.close()


def test_try_again_after_untyped_timeout_asks_again():
    b = Scripted([timeout(False, seq=None), ok(seq="0011")])
    try:
        with pytest.raises(BookforgeError) as ei:
            submit(b.url, "req-first")
        assert "never typed" in str(ei.value)
        submit(b.url, "req-second")
        assert "req-second" in b.seen[1]["body"]["request_id"]
    finally:
        b.close()


def test_late_window_expired_is_not_reused():
    b = Scripted([timeout(True, seq="0012", late_expired=True), ok(seq="0013")])
    try:
        with pytest.raises(BookforgeError) as ei:
            submit(b.url, "req-first")
        assert "no answer came" in str(ei.value)
        submit(b.url, "req-second")
        assert "req-second" in b.seen[1]["body"]["request_id"]
    finally:
        b.close()


def test_site_busy_409_is_a_busy_answer_with_the_bridge_reason():
    b = Scripted([(409, {"ok": False, "error": "SITE_BUSY", "message": "claude is still reserved for the answer to "
                                                                       "an earlier BookForge prompt"})])
    try:
        with pytest.raises(BookforgeError) as ei:
            submit(b.url, "req-1")
        assert jobs.is_busy_error(ei.value) and "still reserved" in str(ei.value)
    finally:
        b.close()


def test_late_window_and_busy_retry_budget_agree():
    assert jobs.DEFAULT_RETRY["max_total_s"] >= 2 * jobs.BRIDGE_LATE_WINDOW_S
    if BRIDGE_JS.is_file():
        m = re.search(r"const LATE_WINDOW_MAX_MS = ([0-9* ]+);", BRIDGE_JS.read_text(encoding="utf-8"))
        assert m, "bookforge-bridge.js defines LATE_WINDOW_MAX_MS"
        assert eval(m.group(1)) == jobs.BRIDGE_LATE_WINDOW_S * 1000  # noqa: S307 - digits and * only
    # an AI call's bridge timeout stays inside the contract (10..900 s)
    from bookforge.assist import AI_DEADLINE_S
    assert prov.AutoInjectorAdapter.timeout_ms(None) <= 900000 and AI_DEADLINE_S <= 900


def test_already_running_never_sends_the_token(tmp_path):
    impostor = Scripted([(200, {"app": "bookforge", "version": "x", "contract_version": "1"})], "/")
    try:
        assert srv.already_running("127.0.0.1", impostor.port, "the-secret-token-123") is False
        req = impostor.seen[0]
        assert req["path"].startswith("/api/ping?challenge=")
        assert "the-secret-token-123" not in json.dumps(req)
        assert not any(k.lower() == "authorization" for k in req["headers"])
    finally:
        impostor.close()
    # a replayed proof (made for another challenge) is refused too
    stale = srv.ping_proof("the-secret-token-123", "0" * 32)
    replay = Scripted([(200, {"app": "bookforge", "proof": stale})], "/")
    try:
        assert srv.already_running("127.0.0.1", replay.port, "the-secret-token-123") is False
    finally:
        replay.close()


def test_already_running_recognises_its_own_data_folder(tmp_path):
    app = srv.App(tmp_path / "data")
    assert "proof" not in app.ping() and "proof" not in app.ping("not-hex")

    def answer(path):
        challenge = path.split("challenge=", 1)[1]
        return app.ping(challenge)
    same = Scripted([(200, answer)], "/")
    try:
        assert srv.already_running("127.0.0.1", same.port, app.token) is True
    finally:
        same.close()
    other = Scripted([(200, answer)], "/")
    try:
        assert srv.already_running("127.0.0.1", other.port, "a-different-token") is False
    finally:
        other.close()
