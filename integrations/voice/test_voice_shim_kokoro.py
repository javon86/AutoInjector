"""Tests for the voice shim's optional Kokoro engine, with a FAKE kokoro_onnx / onnxruntime / piper (no models).

    python -m pytest -q -p no:cacheprovider integrations/voice

What they prove: /health says whether Kokoro is ready (package + both model files); /synthesize with
engine "kokoro" gives a WAV from Kokoro on the processor by default (half the cores) or on the graphics card when
asked and available (else the processor); a bad voice name, a missing model or a crash falls back to piper and
says so; without piper either it fails cleanly (the app then uses the PC's voices); plain requests are unchanged.
"""
import base64
import io
import json
import os
import sys
import threading
import types
import urllib.request
import wave
from http.server import ThreadingHTTPServer

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import voice_shim  # noqa: E402

np = pytest.importorskip("numpy")


class FakeSession:
    def __init__(self, path, sess_options=None, providers=None):
        FakeRT.sessions.append({"path": path, "providers": list(providers or []),
                                "threads": getattr(sess_options, "intra_op_num_threads", None)})
        if FakeRT.fail_gpu and providers and providers[0] != "CPUExecutionProvider":
            raise RuntimeError("CUDA failed to start")


class FakeOptions:
    intra_op_num_threads = 0


class FakeRT(types.ModuleType):
    sessions = []
    providers = ["CPUExecutionProvider"]
    fail_gpu = False

    def __init__(self):
        super().__init__("onnxruntime")
        self.InferenceSession = FakeSession
        self.SessionOptions = FakeOptions
        self.get_available_providers = lambda: list(FakeRT.providers)


class FakeKokoro:
    calls = []
    crash = False

    def __init__(self, model, voices):
        self.model = model

    @classmethod
    def from_session(cls, sess, voices):
        return cls("session", voices)

    def get_voices(self):
        return ["af_heart", "bm_george"]

    def create(self, text, voice, speed=1.0, lang="en-us"):
        FakeKokoro.calls.append({"text": text, "voice": voice, "lang": lang})
        if FakeKokoro.crash:
            raise RuntimeError("kokoro exploded")
        if voice not in self.get_voices():
            raise KeyError(voice)
        return np.linspace(-0.5, 0.5, 2400).astype("float32"), 24000


class FakePiperVoice:
    @classmethod
    def load(cls, path):
        return cls()

    def synthesize_wav(self, text, wf):
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(22050)
        wf.writeframes(b"\x00\x00" * 100)


def _install(monkeypatch, kokoro=True, piper=True):
    if kokoro:
        k = types.ModuleType("kokoro_onnx")
        k.Kokoro = FakeKokoro
        monkeypatch.setitem(sys.modules, "kokoro_onnx", k)
        monkeypatch.setitem(sys.modules, "onnxruntime", FakeRT())
    else:
        monkeypatch.setitem(sys.modules, "kokoro_onnx", None)  # import raises
    if piper:
        p = types.ModuleType("piper")
        pv = types.ModuleType("piper.voice")
        pv.PiperVoice = FakePiperVoice
        p.voice = pv
        monkeypatch.setitem(sys.modules, "piper", p)
        monkeypatch.setitem(sys.modules, "piper.voice", pv)
    else:
        monkeypatch.setitem(sys.modules, "piper", None)


@pytest.fixture()
def shim(tmp_path, monkeypatch):
    vdir = tmp_path / "voice"
    (vdir / "kokoro").mkdir(parents=True)
    (vdir / "en_US-lessac-high.onnx").write_bytes(b"x")
    monkeypatch.setenv("VOICE_MODELS_DIR", str(vdir))
    monkeypatch.delenv("VOICE_KOKORO_DIR", raising=False)
    monkeypatch.delenv("VOICE_KOKORO_DEVICE", raising=False)
    monkeypatch.delenv("VOICE_TTS_MODEL", raising=False)
    FakeRT.sessions, FakeRT.providers, FakeRT.fail_gpu = [], ["CPUExecutionProvider"], False
    FakeKokoro.calls, FakeKokoro.crash = [], False
    voice_shim._KOKORO.update(engine=None, key=None, device="", kind="", error="")
    voice_shim._VOICES.clear()
    server = ThreadingHTTPServer(("127.0.0.1", 0), voice_shim.Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    def model_files():
        (vdir / "kokoro" / "kokoro-v1.0.onnx").write_bytes(b"m")
        (vdir / "kokoro" / "voices-v1.0.bin").write_bytes(b"v")

    def get(path):
        with urllib.request.urlopen(base + path, timeout=5) as r:
            return json.loads(r.read())

    def post(path, body):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            return json.loads(e.read())

    yield types.SimpleNamespace(get=get, post=post, model_files=model_files, vdir=vdir)
    server.shutdown()
    server.server_close()


def _wav_rate(b64):
    with wave.open(io.BytesIO(base64.b64decode(b64)), "rb") as wf:
        return wf.getframerate(), wf.getnframes()


def test_health_reports_kokoro_only_when_package_and_both_files(shim, monkeypatch):
    _install(monkeypatch, kokoro=False)
    h = shim.get("/health")
    assert h["kokoro"] is False and h["kokoro_ready"] is False
    _install(monkeypatch, kokoro=True)
    h = shim.get("/health")
    assert h["kokoro"] is True and h["kokoro_model"] is False and h["kokoro_ready"] is False
    shim.model_files()
    h = shim.get("/health")
    assert h["kokoro_ready"] is True and h["kokoro_loaded"] is False


def test_kokoro_on_the_processor_by_default(shim, monkeypatch):
    _install(monkeypatch)
    shim.model_files()
    FakeRT.providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    r = shim.post("/synthesize", {"text": "Hello there.", "engine": "kokoro", "kokoro_voice": "bm_george"})
    assert r["ok"] and r["engine"] == "kokoro" and r["voice"] == "bm_george" and r["device"] == "cpu"
    assert _wav_rate(r["audio_b64"]) == (24000, 2400)
    s = FakeRT.sessions[-1]
    assert s["providers"] == ["CPUExecutionProvider"], "the graphics card is left free"
    assert s["threads"] == max(1, (os.cpu_count() or 2) // 2), "only half the processor"
    assert FakeKokoro.calls[-1]["lang"] == "en-gb", "a British voice reads British English"
    assert shim.get("/voices")["kokoro_voices"] == ["af_heart", "bm_george"]
    assert shim.get("/health")["kokoro_loaded"] is True


def test_kokoro_on_the_graphics_card_when_asked(shim, monkeypatch):
    _install(monkeypatch)
    shim.model_files()
    FakeRT.providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    r = shim.post("/synthesize", {"text": "Hi.", "engine": "kokoro", "kokoro_voice": "af_heart", "device": "gpu"})
    assert r["ok"] and r["device"] == "gpu"
    assert FakeRT.sessions[-1]["providers"][0] == "CUDAExecutionProvider"


def test_graphics_card_missing_or_failing_uses_the_processor(shim, monkeypatch):
    _install(monkeypatch)
    shim.model_files()
    r = shim.post("/synthesize", {"text": "Hi.", "engine": "kokoro", "kokoro_voice": "af_heart", "device": "gpu"})
    assert r["ok"] and r["engine"] == "kokoro" and r["device"] == "cpu"
    voice_shim._KOKORO.update(engine=None, key=None)
    FakeRT.providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    FakeRT.fail_gpu = True
    r = shim.post("/synthesize", {"text": "Hi.", "engine": "kokoro", "kokoro_voice": "af_heart", "device": "gpu"})
    assert r["ok"] and r["device"] == "cpu"


@pytest.mark.parametrize("case", ["no_model", "bad_voice", "unknown_voice", "crash", "no_package"])
def test_any_kokoro_problem_falls_back_to_piper(shim, monkeypatch, case):
    _install(monkeypatch, kokoro=case != "no_package")
    if case != "no_model":
        shim.model_files()
    FakeKokoro.crash = case == "crash"
    kv = {"bad_voice": "../../etc", "unknown_voice": "af_nobody"}.get(case, "af_heart")
    r = shim.post("/synthesize", {"text": "Hello.", "engine": "kokoro", "kokoro_voice": kv, "voice": "en_US-lessac-high"})
    assert r["ok"] and r["engine"] == "piper" and r["voice"] == "en_US-lessac-high"
    assert r["fallback_from"] == "kokoro" and r["kokoro_error"]
    assert _wav_rate(r["audio_b64"])[0] == 22050


def test_kokoro_and_piper_both_missing_fails_cleanly(shim, monkeypatch):
    _install(monkeypatch, kokoro=False, piper=False)
    r = shim.post("/synthesize", {"text": "Hello.", "engine": "kokoro"})
    assert r["ok"] is False and r["error"] == "NO_TTS" and r["fallback_from"] == "kokoro"


def test_plain_requests_still_use_piper(shim, monkeypatch):
    _install(monkeypatch)
    shim.model_files()
    r = shim.post("/synthesize", {"text": "Hello."})
    assert r["ok"] and r["engine"] == "piper" and "fallback_from" not in r
    assert FakeKokoro.calls == []
