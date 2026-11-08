"""Fakes for the 🎧 audiobook and 🖥 local AI tests: a voice engine (the voice shim's /voices + /synthesize, or the
service bridge's /voice/voices + /voice/synthesize) answering with small WAVs, and an Ollama (/api/tags,
/v1/chat/completions) answering with scripted replies. Both record what they were asked."""
from __future__ import annotations

import base64
import io
import json
import math
import socket
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def tiny_wav(seconds: float = 0.2, rate: int = 22050, amp: int = 3000, freq: float = 220.0, channels: int = 1) -> bytes:
    n = int(seconds * rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(n):
            v = int(amp * math.sin(2 * math.pi * freq * i / rate))
            frames += v.to_bytes(2, "little", signed=True) * channels
        w.writeframes(bytes(frames))
    return buf.getvalue()


class _Server:
    def __init__(self, handler_cls):
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.httpd = ThreadingHTTPServer(("127.0.0.1", self.port), handler_cls)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def _send(h, code, obj):
    body = json.dumps(obj).encode("utf-8")
    h.send_response(code)
    h.send_header("Content-Type", "application/json")
    h.send_header("Content-Length", str(len(body)))
    h.end_headers()
    h.wfile.write(body)


class FakeVoice(_Server):
    """``style`` "shim" (/voices, /synthesize) or "bridge" (/voice/voices, /voice/synthesize, Bearer token)."""

    def __init__(self, voices=("en_US-amy-medium", "en_GB-alan-medium", "en_US-ryan-medium"), style="shim",
                 rates: dict | None = None):
        self.voices = list(voices)
        self.style = style
        self.rates = dict(rates or {})          # voice -> sample rate of its WAVs (default 22050)
        self.requests: list[dict] = []
        self.delay = 0.0
        self.fail_after: int | None = None      # synthesize calls after this many answer TTS_FAILED
        self.lock = threading.Lock()
        fake = self
        pre = "/voice" if style == "bridge" else ""

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):  # noqa: N802
                if self.path.rstrip("/") == pre + "/voices":
                    return _send(self, 200, {"ok": True, "voices": fake.voices})
                return _send(self, 404, {"ok": False, "error": "NOT_FOUND"})

            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                if self.path.rstrip("/") != pre + "/synthesize":
                    return _send(self, 404, {"ok": False, "error": "NOT_FOUND"})
                with fake.lock:
                    fake.requests.append(body)
                    k = len(fake.requests)
                if fake.delay:
                    time.sleep(fake.delay)
                if fake.fail_after is not None and k > fake.fail_after:
                    return _send(self, 200, {"ok": False, "error": "TTS_FAILED", "detail": "boom"})
                if len(body.get("text") or "") > 4000:
                    return _send(self, 413, {"ok": False, "error": "TEXT_TOO_LONG"})
                v = body.get("voice") or fake.voices[0]
                wav = tiny_wav(0.05 + min(len(body.get("text") or ""), 400) / 4000, fake.rates.get(v, 22050))
                return _send(self, 200, {"ok": True, "audio_b64": base64.b64encode(wav).decode(), "mime": "audio/wav",
                                         "voice": v})
        super().__init__(H)


class FakeOllama(_Server):
    """``replies``: a list of reply texts used in order (the last one repeats); or ``responder(prompt) -> text``."""

    def __init__(self, models=(("qwen2.5:7b", "7.6B"), ("llama3.2:3b", "3.2B")), replies=None, responder=None):
        self.models = [{"name": n, "model": n, "details": {"parameter_size": p}} for n, p in models]
        self.replies = list(replies or ['{"ok": true}'])
        self.responder = responder
        self.requests: list[dict] = []
        self.lock = threading.Lock()
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):  # noqa: N802
                if self.path.rstrip("/") == "/api/tags":
                    return _send(self, 200, {"models": fake.models})
                return _send(self, 404, {"error": "not found"})

            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                if self.path.rstrip("/") != "/v1/chat/completions":
                    return _send(self, 404, {"error": "not found"})
                with fake.lock:
                    fake.requests.append(body)
                    k = len(fake.requests) - 1
                prompt = body["messages"][-1]["content"]
                text = fake.responder(prompt) if fake.responder else fake.replies[min(k, len(fake.replies) - 1)]
                return _send(self, 200, {"id": "x", "object": "chat.completion", "model": body.get("model"),
                                         "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                                                      "finish_reason": "stop"}]})
        super().__init__(H)


class FakeLlmBridge(_Server):
    """AutoInjector's service bridge answering GET /llm/local (and nothing else)."""

    def __init__(self, answer: dict):
        self.answer = answer
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):  # noqa: N802
                if self.path.rstrip("/") == "/llm/local":
                    return _send(self, 200, dict({"ok": True}, **fake.answer))
                return _send(self, 404, {"ok": False, "error": "NOT_FOUND"})
        super().__init__(H)
