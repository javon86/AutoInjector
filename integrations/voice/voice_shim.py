#!/usr/bin/env python3
"""voice_shim.py — a tiny local voice bridge so AutoInjector can speak and listen
fully offline, matching its no-cloud ethos. Same stdlib-http.server shape as the
Open Interpreter shim (integrations/open-interpreter/interpreter_shim.py).

Contract (all localhost, single JSON object per response — voice is naturally
request/response, not a stream):
    GET  /health              -> {"ok": true, "service": "voice-shim", "tts": <bool>, "stt": <bool>}
    POST /speak  {text}        -> {"ok": true, "ms": <int>}         (plays audio on the host)
    POST /listen {seconds?}    -> {"ok": true, "text": "<transcript>"}

Text-to-speech uses piper if available (piper-tts), else the OS `say`/`espeak`.
Speech-to-text uses faster-whisper (whisper.cpp-class models) if available.
Everything is lazy-imported and degrades gracefully: with no TTS/STT backend the
plumbing still answers (health, argument validation), and /speak or /listen
returns a clear {"ok": false, "error": "NO_TTS"/"NO_STT", "hint": "..."} rather
than crashing — so `smoke-test.js` can verify the shim without any model.

Run it:
    pip install piper-tts faster-whisper sounddevice   # optional backends
    python voice_shim.py --port 8232

Or let AutoInjector run it (set AUTOINJECTOR_VOICE_SPAWN=python — see README).
Bind is localhost-only.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _have_tts():
    """Is any text-to-speech backend usable?"""
    try:
        import piper  # noqa: F401
        return "piper"
    except Exception:
        pass
    for exe in ("say", "espeak-ng", "espeak"):
        if shutil.which(exe):
            return exe
    return None


def _have_stt():
    try:
        import faster_whisper  # noqa: F401
        return "faster-whisper"
    except Exception:
        return None


def _speak(text):
    """Speak text aloud. Returns (ok, error, hint)."""
    backend = _have_tts()
    if not backend:
        return False, "NO_TTS", "pip install piper-tts (or install `say`/`espeak`)"
    try:
        if backend == "piper":
            # piper writes a WAV; play it with a system player if present.
            from piper.voice import PiperVoice  # type: ignore
            model = os.environ.get("VOICE_TTS_MODEL")
            if not model or not os.path.exists(model):
                return False, "NO_TTS_MODEL", "set VOICE_TTS_MODEL to a piper .onnx voice"
            voice = PiperVoice.load(model)
            out = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"voice-{int(time.time()*1000)}.wav")
            with wave.open(out, "wb") as wf:
                voice.synthesize(text, wf)
            player = shutil.which("aplay") or shutil.which("afplay") or shutil.which("ffplay")
            if player:
                subprocess.run([player, out], check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True, None, None
        # OS speaker
        if backend == "say":
            subprocess.run(["say", text], check=False)
        else:
            subprocess.run([backend, text], check=False)
        return True, None, None
    except Exception as exc:  # pragma: no cover - backend-specific
        return False, f"TTS_FAILED: {exc}", None


def _listen(seconds):
    """Record `seconds` of mic audio and transcribe it. Returns (ok, text, error, hint)."""
    if not _have_stt():
        return False, "", "NO_STT", "pip install faster-whisper sounddevice"
    try:
        import numpy as np  # type: ignore
        import sounddevice as sd  # type: ignore
        from faster_whisper import WhisperModel  # type: ignore
        sr = 16000
        rec = sd.rec(int(seconds * sr), samplerate=sr, channels=1, dtype="float32")
        sd.wait()
        audio = np.squeeze(rec)
        model_name = os.environ.get("VOICE_STT_MODEL") or "base.en"
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments, _ = model.transcribe(audio, language="en")
        text = " ".join(seg.text for seg in segments).strip()
        return True, text, None, None
    except Exception as exc:  # pragma: no cover - backend-specific
        return False, "", f"STT_FAILED: {exc}", None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        # Close the connection after each response so strict HTTP/1.1 clients
        # (Node's http) see a clean end even without Content-Length ambiguity.
        body = json.dumps(obj).encode("utf-8")
        self.close_connection = True
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return None

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") in ("", "/health"):
            self._send(200, {"ok": True, "service": "voice-shim",
                             "tts": bool(_have_tts()), "stt": bool(_have_stt())})
        else:
            self._send(404, {"ok": False, "error": "NOT_FOUND"})

    def do_POST(self):  # noqa: N802
        path = self.path.rstrip("/")
        body = self._read_json()
        if body is None:
            return self._send(400, {"ok": False, "error": "BAD_JSON"})
        if path == "/speak":
            text = (body.get("text") or "").strip()
            if not text:
                return self._send(400, {"ok": False, "error": "NEED_TEXT"})
            t0 = time.time()
            ok, err, hint = _speak(text)
            if ok:
                return self._send(200, {"ok": True, "ms": int((time.time() - t0) * 1000)})
            return self._send(200, {"ok": False, "error": err, "hint": hint})
        if path == "/listen":
            seconds = max(1, min(60, int(body.get("seconds") or 6)))
            ok, text, err, hint = _listen(seconds)
            if ok:
                return self._send(200, {"ok": True, "text": text})
            return self._send(200, {"ok": False, "error": err, "hint": hint})
        return self._send(404, {"ok": False, "error": "NOT_FOUND"})

    def log_message(self, *args):  # silence default request logging
        return


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("VOICE_PORT", "8232")))
    parser.add_argument("--host", default=os.environ.get("VOICE_HOST", "127.0.0.1"))
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"voice-shim listening on http://{args.host}:{args.port} "
          f"(tts={bool(_have_tts())}, stt={bool(_have_stt())})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())
