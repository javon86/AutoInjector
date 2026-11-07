#!/usr/bin/env python3
"""voice_shim.py — a tiny local voice bridge so AutoInjector can speak and listen
fully offline, matching its no-cloud ethos. Same stdlib-http.server shape as the
Open Interpreter shim (integrations/open-interpreter/interpreter_shim.py).

Contract (all localhost, single JSON object per response — voice is naturally
request/response, not a stream):
    GET  /health              -> {"ok": true, "service": "voice-shim", "tts": <bool>, "stt": <bool>}
    POST /speak  {text}        -> {"ok": true, "ms": <int>}         (plays audio on the host)
    POST /listen {seconds?}    -> {"ok": true, "text": "<transcript>"}
    POST /transcribe {audio_b64, mime?}  -> {"ok": true, "text": "...", "ms", "device", "model"}
                               (the app's 🎤: audio recorded in the control panel, webm/opus or wav)
    POST /synthesize {text, voice?}      -> {"ok": true, "audio_b64": "<WAV>", "mime": "audio/wav", "voice"}
                               (the app's 🔊 read-aloud: the page plays the WAV itself, so Stop is instant)
    GET  /voices               -> {"ok": true, "voices": ["en_US-lessac-medium", ...]}

Speech-to-text runs on the graphics card when it can (faster-whisper on CUDA, float16) and falls
back to the CPU (int8) — also when CUDA fails only at the first transcription (missing cuBLAS/cuDNN).
The whisper model is loaded once and kept. VOICE_STT_MODEL picks it (default: small.en on a
graphics card, base.en on the CPU); the first use downloads it (base.en is about 150 MB).
Piper voices: VOICE_TTS_MODEL (one .onnx file) and/or VOICE_MODELS_DIR (a folder of .onnx voices;
"voice" names a file in it without .onnx). Voices are loaded once and kept.

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
import base64
import io
import json
import tempfile
import threading
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


# ---- piper voices -----------------------------------------------------------
_VOICES = {}
_VOICES_LOCK = threading.Lock()


def _voices_dir():
    d = os.environ.get("VOICE_MODELS_DIR") or ""
    return d if d and os.path.isdir(d) else ""


def _list_voices():
    names = []
    d = _voices_dir()
    if d:
        try:
            names = sorted(f[:-5] for f in os.listdir(d) if f.lower().endswith(".onnx"))
        except Exception:
            names = []
    m = os.environ.get("VOICE_TTS_MODEL") or ""
    if m and os.path.exists(m):
        n = os.path.basename(m)[:-5] if m.lower().endswith(".onnx") else os.path.basename(m)
        if n not in names:
            names.insert(0, n)
    return names


def _voice_path(name):
    """A voice name (or empty for the default) -> a .onnx path, or None."""
    name = (name or "").strip()
    if name:
        if os.path.sep in name or "/" in name or ".." in name:
            return None  # only names from the voices folder, never a path from the request
        base = name[:-5] if name.lower().endswith(".onnx") else name
        d = _voices_dir()
        if d:
            p = os.path.join(d, base + ".onnx")
            if os.path.exists(p):
                return p
        m = os.environ.get("VOICE_TTS_MODEL") or ""
        if m and os.path.basename(m)[:-5] == base and os.path.exists(m):
            return m
    m = os.environ.get("VOICE_TTS_MODEL") or ""
    if m and os.path.exists(m):
        return m
    names = _list_voices()
    if names and _voices_dir():
        p = os.path.join(_voices_dir(), names[0] + ".onnx")
        if os.path.exists(p):
            return p
    return None


def _load_voice(path):
    with _VOICES_LOCK:
        v = _VOICES.get(path)
        if v is None:
            from piper.voice import PiperVoice  # type: ignore
            v = PiperVoice.load(path)
            _VOICES[path] = v
        return v


def _synthesize_wav(text, voice_name=""):
    """-> (wav_bytes, voice_name, error, hint)."""
    try:
        import piper  # noqa: F401
    except Exception:
        return None, "", "NO_TTS", "pip install piper-tts"
    path = _voice_path(voice_name)
    if not path:
        return None, "", "NO_TTS_MODEL", "put a piper .onnx voice in models/voice (Setup Wizard -> Voice model)"
    try:
        voice = _load_voice(path)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            if hasattr(voice, "synthesize_wav"):  # piper-tts 1.3+
                voice.synthesize_wav(text, wf)
            else:  # piper-tts 1.2
                voice.synthesize(text, wf)
        return buf.getvalue(), os.path.basename(path)[:-5], None, None
    except Exception as exc:  # pragma: no cover - backend-specific
        return None, "", "TTS_FAILED", str(exc)[:300]


def _speak(text, voice_name=""):
    """Speak text aloud on this computer. Returns (ok, error, hint)."""
    backend = _have_tts()
    if not backend:
        return False, "NO_TTS", "pip install piper-tts (or install `say`/`espeak`)"
    try:
        if backend == "piper":
            wav, _name, err, hint = _synthesize_wav(text, voice_name)
            if err:
                return False, err, hint
            out = os.path.join(tempfile.gettempdir(), f"voice-{int(time.time()*1000)}.wav")
            with open(out, "wb") as f:
                f.write(wav)
            player = shutil.which("aplay") or shutil.which("afplay") or shutil.which("ffplay")
            try:
                if player:
                    subprocess.run([player, out], check=False,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                elif sys.platform == "win32":
                    import winsound  # type: ignore
                    winsound.PlaySound(out, winsound.SND_FILENAME)
            finally:
                try:
                    os.remove(out)
                except Exception:
                    pass
            return True, None, None
        # OS speaker
        if backend == "say":
            subprocess.run(["say", text], check=False)
        else:
            subprocess.run([backend, text], check=False)
        return True, None, None
    except Exception as exc:  # pragma: no cover - backend-specific
        return False, "TTS_FAILED", str(exc)[:300]


# ---- whisper (speech-to-text) -------------------------------------------------
# Approximate download sizes, so the app can say "the first time it downloads … about 150 MB".
_STT_MB = {"tiny.en": 75, "tiny": 75, "base.en": 145, "base": 145, "small.en": 485, "small": 485,
           "medium.en": 1500, "medium": 1500, "large-v3": 3100, "distil-large-v3": 1500}
_STT = {"model": None, "name": "", "device": "", "lock": threading.Lock(), "cuda": None}


def _cuda_ok():
    if _STT["cuda"] is None:
        try:
            import ctranslate2  # type: ignore
            _STT["cuda"] = ctranslate2.get_cuda_device_count() > 0
        except Exception:
            _STT["cuda"] = False
    return _STT["cuda"]


def _stt_model_name():
    env = (os.environ.get("VOICE_STT_MODEL") or "").strip()
    if env:
        return env
    return "small.en" if _cuda_ok() else "base.en"


def _stt_cached(name):
    """Is the whisper model already downloaded (Hugging Face cache)?"""
    if os.path.isdir(name):
        return True
    roots = []
    for k in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        if os.environ.get(k):
            roots.append(os.environ[k])
    if os.environ.get("HF_HOME"):
        roots.append(os.path.join(os.environ["HF_HOME"], "hub"))
    roots.append(os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub"))
    for r in roots:
        try:
            for d in os.listdir(r):
                if d.startswith("models--") and d.lower().endswith("faster-whisper-" + name.lower()):
                    return True
        except Exception:
            pass
    return False


def _get_stt(force_cpu=False):
    from faster_whisper import WhisperModel  # type: ignore
    name = _stt_model_name()
    if _STT["model"] is not None and _STT["name"] == name and not (force_cpu and _STT["device"] != "cpu"):
        return _STT["model"]
    model = None
    if not force_cpu and _cuda_ok():
        try:
            model = WhisperModel(name, device="cuda", compute_type="float16")
            _STT["device"] = "cuda"
        except Exception:
            model = None
    if model is None:
        if force_cpu and not (os.environ.get("VOICE_STT_MODEL") or "").strip():
            name = "base.en"  # the GPU model would be slow on the CPU
        model = WhisperModel(name, device="cpu", compute_type="int8")
        _STT["device"] = "cpu"
    _STT["model"], _STT["name"] = model, name
    return model


def _run_whisper(audio):
    """Transcribe audio (a path or samples). CUDA errors that only show at the first run
    (cublas/cudnn not found) switch to the CPU for good and try once more."""
    with _STT["lock"]:
        model = _get_stt()
        try:
            segments, _ = model.transcribe(audio, language="en", vad_filter=True)
            return " ".join(seg.text.strip() for seg in segments).strip()
        except Exception as exc:
            if _STT["device"] != "cuda":
                raise
            _STT["cuda"] = False
            _STT["model"] = None
            sys.stderr.write(f"voice-shim: CUDA speech-to-text failed ({str(exc)[:200]}); using the CPU\n")
            model = _get_stt(force_cpu=True)
            segments, _ = model.transcribe(audio, language="en", vad_filter=True)
            return " ".join(seg.text.strip() for seg in segments).strip()


_EXT = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/x-wav": ".wav",
        "audio/wave": ".wav", "audio/mp4": ".m4a", "audio/mpeg": ".mp3"}


def _transcribe_b64(audio_b64, mime):
    """-> (ok, text, error, hint)."""
    if not _have_stt():
        return False, "", "NO_STT", "pip install faster-whisper"
    try:
        raw = base64.b64decode(audio_b64, validate=False)
    except Exception:
        return False, "", "BAD_AUDIO", "audio_b64 is not base64"
    if len(raw) < 16:
        return False, "", "NEED_AUDIO", None
    ext = _EXT.get((mime or "").split(";")[0].strip().lower(), ".webm")
    fd, tmp = tempfile.mkstemp(prefix="voice-in-", suffix=ext)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        try:
            from faster_whisper import decode_audio  # type: ignore
            audio = decode_audio(tmp, sampling_rate=16000)  # PyAV: webm/opus, ogg, wav, mp3, m4a
        except Exception as exc:
            return False, "", "BAD_AUDIO", str(exc)[:200]
        if getattr(audio, "size", len(audio)) < 1600:  # under 0.1 s
            return True, "", None, None
        return True, _run_whisper(audio), None, None
    except Exception as exc:  # pragma: no cover - backend-specific
        return False, "", "STT_FAILED", str(exc)[:300]
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass


def _listen(seconds):
    """Record `seconds` of mic audio and transcribe it. Returns (ok, text, error, hint)."""
    if not _have_stt():
        return False, "", "NO_STT", "pip install faster-whisper sounddevice"
    try:
        import numpy as np  # type: ignore
        import sounddevice as sd  # type: ignore
        sr = 16000
        rec = sd.rec(int(seconds * sr), samplerate=sr, channels=1, dtype="float32")
        sd.wait()
        audio = np.squeeze(rec)
        return True, _run_whisper(audio), None, None
    except Exception as exc:  # pragma: no cover - backend-specific
        return False, "", "STT_FAILED", str(exc)[:300]


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
            stt = bool(_have_stt())
            name = _stt_model_name() if stt else ""
            self._send(200, {"ok": True, "service": "voice-shim",
                             "tts": bool(_have_tts()), "stt": stt,
                             "piper_voices": len(_list_voices()),
                             "stt_model": name, "stt_loaded": _STT["model"] is not None,
                             "stt_device": _STT["device"] or ("cuda" if stt and _cuda_ok() else "cpu"),
                             "stt_cached": bool(stt and _stt_cached(name)),
                             "stt_mb": _STT_MB.get(name, 0)})
        elif self.path.rstrip("/") == "/voices":
            self._send(200, {"ok": True, "voices": _list_voices()})
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
            ok, err, hint = _speak(text, str(body.get("voice") or ""))
            if ok:
                return self._send(200, {"ok": True, "ms": int((time.time() - t0) * 1000)})
            return self._send(200, {"ok": False, "error": err, "hint": hint})
        if path == "/transcribe":
            audio = body.get("audio_b64")
            if not isinstance(audio, str) or not audio.strip():
                return self._send(400, {"ok": False, "error": "NEED_AUDIO"})
            if len(audio) > 40 * 1024 * 1024:
                return self._send(413, {"ok": False, "error": "AUDIO_TOO_LONG"})
            t0 = time.time()
            ok, text, err, hint = _transcribe_b64(audio, str(body.get("mime") or ""))
            if ok:
                return self._send(200, {"ok": True, "text": text, "ms": int((time.time() - t0) * 1000),
                                        "device": _STT["device"], "model": _STT["name"]})
            return self._send(200, {"ok": False, "error": err, "detail": hint})
        if path == "/synthesize":
            text = body.get("text")
            if not isinstance(text, str) or not text.strip():
                return self._send(400, {"ok": False, "error": "NEED_TEXT"})
            if len(text) > 4000:
                return self._send(413, {"ok": False, "error": "TEXT_TOO_LONG"})
            voice = body.get("voice") or ""
            if not isinstance(voice, str) or os.path.sep in voice or "/" in voice or ".." in voice:
                return self._send(400, {"ok": False, "error": "BAD_VOICE"})
            wav, name, err, hint = _synthesize_wav(text.strip(), voice)
            if err:
                return self._send(200, {"ok": False, "error": err, "detail": hint})
            return self._send(200, {"ok": True, "audio_b64": base64.b64encode(wav).decode("ascii"),
                                    "mime": "audio/wav", "voice": name})
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
