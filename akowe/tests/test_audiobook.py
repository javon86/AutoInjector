"""🎧 5b Audiobook (audiobook.py): text cleanup and chunking, who says what in dialogue and which voice reads it, the
make job through a fake voice engine (WAV without ffmpeg, MP3 + M4B with it — mocked and, when present, real),
resume (finished chapters are skipped), cancel, the no-engine message in plain words, and the API."""
from __future__ import annotations

import base64
import json
import shutil
import time
import types
import wave
from pathlib import Path

import pytest

from akowe import audiobook, forge
from akowe import providers as prov_mod

from audio_fakes import FakeVoice, free_port, tiny_wav
from test_failover_review import SlotFake, make_app, run_book


# ====================================================================== text → speech
def test_cleanup_markdown_scene_breaks_numbers_and_abbreviations():
    title, paras = audiobook.blocks("# The *Storm*\n\n**Mr. Vell** paid $5.50 on the 3rd of May, 1999 — 25% of it."
                                    "\n\n* * *\n\nSee [the map](http://x.example) & go.\n\n---\n\n## Later\n\nDr. Reed "
                                    "counted 1,250 lamps, pages 3–5, i.e. all of them.")
    assert title == "The Storm"
    assert paras[0] == ("Mister Vell paid five dollars and fifty cents on the third of May, nineteen ninety-nine, "
                        "twenty-five percent of it.")
    assert paras[1] is None and paras[2] == "See the map and go." and paras[3] is None
    assert paras[4] == "Later"  # a scene heading: a pause, then it is read
    assert paras[5] == ("Doctor Reed counted one thousand two hundred and fifty lamps, pages three to five, that is "
                        "all of them.")
    assert audiobook.number_words(2026) == "two thousand and twenty-six" and audiobook._year(1905) == "nineteen oh-five"
    assert audiobook._ordinal(21) == "twenty-first" and audiobook._ordinal(12) == "twelfth"


def test_chunking_keeps_pieces_under_the_engine_limit_and_cuts_at_sentences():
    text = " ".join(f"Sentence number {i} goes on for a little while." for i in range(200))
    parts = audiobook.chunk_text(text, 300)
    assert all(len(p) <= 300 for p in parts) and len(parts) > 10
    assert all(p.endswith(".") for p in parts) and " ".join(parts) == " ".join(text.split())
    giant = "word " * 900  # one sentence with no end: cut at spaces, never mid-word
    parts = audiobook.chunk_text(giant, 500)
    assert all(len(p) <= 500 for p in parts) and all(w == "word" for p in parts for w in p.split())


def test_dialogue_is_attributed_carefully_and_read_in_each_characters_voice():
    cast = audiobook.Cast([{"name": "Mara Vell", "gender": "female"}, {"name": "Tom Reed", "gender": "male"},
                           {"name": "Ada Reed", "gender": "female"}])
    paras = ['"We go tonight," Mara said. "Now."', '"Why?"', '"Because the lamp is out," said Tom.', '"And then?"',
             '"Then we wait."', '"Fine," she said.', 'Tom set the cup down. "Go."', "The fog thickened.", '"Who is there?"',
             None, '"Reed?" Ada asked.']
    att = audiobook.attribute(paras, cast)
    who = [[s["speaker"] for s in segs if s["quote"]] if segs else None for segs in att]
    assert who[0] == ["Mara Vell", "Mara Vell"]      # one speaker per paragraph, from its tag
    assert who[1] == [None]                           # unsure: the narrator
    assert who[2] == ["Tom Reed"]
    assert who[3] == ["Mara Vell"] and who[4] == ["Tom Reed"]   # a strict two-person exchange alternates
    assert who[5] == ["Mara Vell"]                    # "she" fits exactly one of the two talking
    assert who[6] == ["Tom Reed"]                     # an action beat naming exactly one character
    assert who[8] == [None]                           # narration ended the exchange
    assert who[9] is None and who[10] == ["Ada Reed"]  # "Reed" alone is two people; the tag "Ada" is one
    voices = {"Mara Vell": "en_US-amy-medium", "Tom Reed": "en_GB-alan-medium"}
    plan = audiobook.pieces("Chapter one. The Storm", att, "en_US-lessac-medium", voices, True)
    assert plan[0] == {"say": "Chapter one. The Storm", "voice": "en_US-lessac-medium"}   # the title first
    assert plan[1] == {"pause": audiobook.PAUSE_TITLE_S}
    said = [(p["say"], p["voice"]) for p in plan if "say" in p]
    assert ("We go tonight,", "en_US-amy-medium") in said and ("Mara said.", "en_US-lessac-medium") in said
    assert ("Because the lamp is out,", "en_GB-alan-medium") in said and ("Why?", "en_US-lessac-medium") in said
    assert ("Reed? Ada asked.", "en_US-lessac-medium") in said   # Ada has no voice: the narrator reads it all
    assert {"pause": audiobook.PAUSE_SCENE_S} in plan
    flat = audiobook.pieces("T", att, "nar", voices, False)  # character voices off: the narrator reads it all
    assert {p["voice"] for p in flat if "say" in p} == {"nar"}


def test_default_voices_follow_the_book_bible_gender_hints():
    assert audiobook.voice_gender("en_US-amy-medium") == "female" and audiobook.voice_gender("en_GB-alan-low") == "male"
    assert audiobook.voice_gender("en_US-hfc_female-medium") == "female" and audiobook.voice_gender("xx-zzz-low") is None
    assert audiobook.gender_age("She is a 34-year-old keeper") == ("female", "about 34")
    assert audiobook.gender_age("a grey-haired man") == ("male", "older")
    voices = ["en_US-lessac-medium", "en_US-amy-medium", "en_GB-alan-medium", "en_US-ryan-medium"]
    cast = [{"name": "Mara", "gender": "female"}, {"name": "Tom", "gender": "male"}, {"name": "Sam", "gender": "male"},
            {"name": "Kit", "gender": None}]
    narr, cv = audiobook.default_voices(voices, None, cast)
    assert narr == "en_US-lessac-medium" and "en_US-lessac-medium" not in cv.values()
    assert cv["Mara"] == "en_US-amy-medium" and cv["Tom"] == "en_GB-alan-medium" and cv["Sam"] == "en_US-ryan-medium"
    assert audiobook.default_voices(voices, "en_GB-alan-medium", cast)[0] == "en_GB-alan-medium"
    assert audiobook.default_voices([], None, cast) == (None, {})


def test_wav_helpers_resample_and_normalise_to_the_same_loudness():
    rate, a = audiobook.read_wav(tiny_wav(0.5, 16000, amp=500))
    assert rate == 16000 and len(a) == 8000
    b = audiobook.resample(a, 16000, 22050)
    assert abs(len(b) - 11025) <= 1
    quiet = audiobook.normalise(b)
    loud = audiobook.normalise(audiobook.read_wav(tiny_wav(0.5, 22050, amp=30000))[1])
    for x in (quiet, loud):
        lv = audiobook.levels(x)
        assert -21.5 <= lv["rms_dbfs"] <= -18.5 and lv["peak_dbfs"] <= -2.9, lv
    _r, st = audiobook.read_wav(tiny_wav(0.1, 22050, channels=2))  # stereo is mixed down
    assert len(st) == 2205


# ====================================================================== the job, through a fake engine
@pytest.fixture(scope="module")
def book(tmp_path_factory):
    mp = pytest.MonkeyPatch()
    mp.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic, time=time.time))
    tmp = tmp_path_factory.mktemp("audiobook")
    app = make_app(tmp, SlotFake())
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    forge.save_bridge_settings(app, {"url": f"http://127.0.0.1:{free_port()}"})  # no AutoInjector: the shim directly
    yield types.SimpleNamespace(app=app, pid=run["project_id"], tmp=tmp)
    mp.undo()


@pytest.fixture
def voice(monkeypatch, book, tmp_path):
    fake = FakeVoice(rates={"en_GB-alan-medium": 16000})
    monkeypatch.setenv("AKOWE_VOICE_URL", fake.url)
    monkeypatch.setattr(audiobook, "OUT_ROOT", tmp_path)
    monkeypatch.setattr(audiobook, "find_ffmpeg", lambda: None)
    book.app.store.set_setting(f"audiobook:{book.pid}:main", None)
    audiobook._JOBS.clear()
    yield fake
    fake.close()


def _wait(pid, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = audiobook.job_of(pid, "main")
        if j and j.status != "running":
            return j.public()
        time.sleep(0.05)
    raise AssertionError("the audiobook job did not finish")


def test_make_wav_without_ffmpeg_titles_first_then_resume_skips_finished_chapters(book, voice):
    app, pid = book.app, book.pid
    info = audiobook.info(app, "author", pid, "main")
    assert info["engine"]["ok"] and info["engine"]["via"] == "shim" and info["format"] == "wav" and not info["m4b"]
    assert info["settings"]["narrator"] == "en_US-amy-medium" and len(info["chapters"]) == 3
    assert not any(c["done"] for c in info["chapters"])
    r = audiobook.start(app, "author", pid, "main", {})
    assert r["ok"]
    job = _wait(pid)
    assert job["status"] == "done" and job["made"] == 3 and job["kept"] == 0, job
    folder = audiobook.folder(app, pid, "main")
    files = sorted(p.name for p in folder.iterdir() if not p.name.startswith("."))
    assert sum(1 for f in files if f.endswith(".wav") and f[:2].isdigit()) == 3
    assert any("(whole book).wav" in f for f in files) and "About these files.txt" in files
    assert any("ffmpeg is not on this PC" in n for n in job["notes"])
    assert voice.requests[0]["text"].startswith("Chapter one") and voice.requests[0]["voice"] == "en_US-amy-medium"
    # every chapter file: 22.05 kHz mono, the same loudness
    for f in files:
        if f.endswith(".wav"):
            with wave.open(str(folder / f)) as w:
                assert w.getframerate() == 22050 and w.getnchannels() == 1
                rate, a = audiobook.read_wav((folder / f).read_bytes())
            lv = audiobook.levels(a)
            assert -22 <= lv["rms_dbfs"] <= -18 and lv["peak_dbfs"] <= -2.9, (f, lv)
    man = json.loads((folder / audiobook.MANIFEST).read_text())
    assert len(man["chapters"]) == 3 and man["format"] == "wav"
    # making it again: every chapter is kept, nothing is spoken again (only the whole-book file is joined again)
    n = len(voice.requests)
    audiobook.start(app, "author", pid, "main", {"full_book": False})
    job = _wait(pid)
    assert job["status"] == "done" and job["kept"] == 3 and job["made"] == 0 and len(voice.requests) == n
    assert all(c["done"] for c in audiobook.info(app, "author", pid, "main")["chapters"])
    # another narrator: every chapter is read again in the new voice (16 kHz voice → resampled)
    audiobook.save_settings(app.store, pid, "main", {"narrator": "en_GB-alan-medium"})
    assert not any(c["done"] for c in audiobook.info(app, "author", pid, "main")["chapters"])
    audiobook.start(app, "author", pid, "main", {"full_book": False})
    job = _wait(pid)
    assert job["made"] == 3 and {q["voice"] for q in voice.requests[n:]} == {"en_GB-alan-medium"}


def test_cancel_stops_between_pieces_and_keeps_only_finished_chapters(book, voice):
    app, pid = book.app, book.pid
    voice.delay = 0.05
    audiobook.start(app, "author", pid, "main", {})
    t0 = time.time()
    while len(voice.requests) < 2 and time.time() - t0 < 20:
        time.sleep(0.02)
    assert audiobook.start(app, "author", pid, "main", {})["already"]  # one job at a time
    audiobook.cancel(pid, "main")
    job = _wait(pid)
    assert job["status"] == "cancelled" and job["problem"]["code"] == "CANCELLED"
    assert "finished chapters are kept" in job["problem"]["fix"]
    folder = audiobook.folder(app, pid, "main")
    man = json.loads((folder / audiobook.MANIFEST).read_text()) if (folder / audiobook.MANIFEST).exists() else {}
    assert len(man.get("chapters") or {}) < 3
    assert not list(folder.glob("*.tmp")) and not list(folder.glob("*.part"))
    voice.delay = 0.0
    audiobook.start(app, "author", pid, "main", {"full_book": False})  # and it goes on where it stopped
    job = _wait(pid)
    assert job["status"] == "done" and job["made"] + job["kept"] == 3


def test_character_voices_are_used_for_tagged_dialogue(book, voice, monkeypatch):
    app, pid = book.app, book.pid
    text = '# The Lamp\n\n"We go tonight," Mara said.\n\n"Why?" Tom asked.\n\nThe fog came in.'
    monkeypatch.setattr(audiobook, "_chapters", lambda *a: [{"chapter_id": "c1", "record_id": "r1", "version": 1,
                                                             "title": "The Lamp", "text": text, "words": 9}])
    monkeypatch.setattr(audiobook, "characters", lambda *a: [
        {"name": "Mara Vell", "gender": "female", "age": None, "hint": "female", "record_id": "m"},
        {"name": "Tom Reed", "gender": "male", "age": None, "hint": "male", "record_id": "t"}])
    audiobook.save_settings(app.store, pid, "main", {"dialogue": True, "narrator": "en_US-amy-medium",
                                                     "character_voices": {"Tom Reed": "en_US-ryan-medium"}})
    info = audiobook.info(app, "author", pid, "main")
    rows = {r["name"]: r for r in info["characters"]}
    assert rows["Tom Reed"]["voice"] == "en_US-ryan-medium" and rows["Mara Vell"]["voice"] != "en_US-amy-medium"
    audiobook.start(app, "author", pid, "main", {"full_book": False})
    assert _wait(pid)["status"] == "done"
    said = [(q["text"], q["voice"]) for q in voice.requests]
    assert said[0] == ("Chapter one. The Lamp", "en_US-amy-medium")
    assert ("Why?", "en_US-ryan-medium") in said and ("Tom asked.", "en_US-amy-medium") in said
    assert ("We go tonight,", rows["Mara Vell"]["voice"]) in said
    assert ("The fog came in.", "en_US-amy-medium") in said


def test_mp3_and_m4b_with_ffmpeg_mocked(book, voice, monkeypatch):
    app, pid = book.app, book.pid
    calls = []

    def fake_ff(ff, args, timeout=3600):
        calls.append(args)
        Path(args[-1]).write_bytes(b"ID3fake")
    monkeypatch.setattr(audiobook, "find_ffmpeg", lambda: "/usr/local/bin/ffmpeg")
    monkeypatch.setattr(audiobook, "_ff", fake_ff)
    meta_seen = []
    real_concat = audiobook.concat

    def spy_concat(ff, files, out, *, m4b_meta=None):
        if m4b_meta is not None:
            meta_seen.append(m4b_meta.read_text())
        return real_concat(ff, files, out, m4b_meta=m4b_meta)
    monkeypatch.setattr(audiobook, "concat", spy_concat)
    assert audiobook.info(app, "author", pid, "main")["format"] == "mp3"
    audiobook.start(app, "author", pid, "main", {})
    job = _wait(pid)
    assert job["status"] == "done", job
    mp3s = [a for a in calls if "libmp3lame" in a]
    assert len(mp3s) == 3 and all("192k" in a and "44100" in a for a in mp3s)
    assert any("-c" in a and "copy" in a for a in calls)                    # the whole book, joined
    assert any("aac" in a and a[-1].endswith(".m4b") for a in calls)        # the M4B
    assert meta_seen and meta_seen[0].startswith(";FFMETADATA1") and meta_seen[0].count("[CHAPTER]") == 3
    folder = audiobook.folder(app, pid, "main")
    assert not list(folder.glob("*.wav*"))  # the WAVs were only steps on the way
    assert sum(1 for f in job["files"] if f.endswith(".mp3")) == 4 and any(f.endswith(".m4b") for f in job["files"])


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is not installed")
def test_mp3_and_m4b_with_the_real_ffmpeg(book, voice, monkeypatch):
    app, pid = book.app, book.pid
    monkeypatch.setattr(audiobook, "find_ffmpeg", shutil.which("ffmpeg").__str__)
    audiobook.start(app, "author", pid, "main", {})
    job = _wait(pid, 120)
    assert job["status"] == "done", job
    folder = audiobook.folder(app, pid, "main")
    m4b = next(folder.glob("*.m4b"))
    assert m4b.stat().st_size > 1000 and len(list(folder.glob("[0-9][0-9] - *.mp3"))) == 3
    import subprocess  # noqa: PLC0415
    probe = subprocess.run([shutil.which("ffmpeg"), "-hide_banner", "-i", str(m4b)], capture_output=True, text=True)
    assert probe.stderr.count("Chapter #") == 3


def test_no_voice_engine_is_said_in_plain_words_with_the_setup_hint(book, voice, monkeypatch):
    app, pid = book.app, book.pid
    monkeypatch.setenv("AKOWE_VOICE_URL", f"http://127.0.0.1:{free_port()}")
    info = audiobook.info(app, "author", pid, "main")
    p = info["engine"]["problem"]
    assert not info["engine"]["ok"] and p["code"] == "NO_VOICE_ENGINE"
    assert p["title"] == "No voice engine is ready on this PC" and "Setup Wizard → Installs → “Voice engine”" in p["fix"]
    assert "Voice models" in p["fix"]
    r = audiobook.start(app, "author", pid, "main", {})
    assert r["ok"] is False and r["problem"]["code"] == "NO_VOICE_ENGINE"
    t = audiobook.test_voice(app, {"voice": "en_US-amy-medium"})
    assert t["ok"] is False and t["problem"]["code"] == "NO_VOICE_ENGINE"
    # an engine with no piper voice yet
    empty = FakeVoice(voices=())
    try:
        monkeypatch.setenv("AKOWE_VOICE_URL", empty.url)
        p = audiobook.info(app, "author", pid, "main")["engine"]["problem"]
        assert p["code"] == "NO_VOICES" and "Voice models" in p["fix"]
    finally:
        empty.close()
    # the engine dies half-way: plain words, the finished chapters stay
    monkeypatch.setenv("AKOWE_VOICE_URL", voice.url)
    voice.fail_after = 4
    audiobook.start(app, "author", pid, "main", {})
    job = _wait(pid)
    assert job["status"] == "problem" and job["problem"]["code"] == "VOICE_FAILED"
    assert "chapters already finished are kept" in job["problem"]["fix"] and "Traceback" not in json.dumps(job)


def test_the_service_bridge_is_asked_first(book, voice, monkeypatch):
    app, pid = book.app, book.pid
    br = FakeVoice(style="bridge", voices=("en_US-lessac-medium",))
    try:
        forge.save_bridge_settings(app, {"url": br.url, "token": "t"})
        info = audiobook.info(app, "author", pid, "main")
        assert info["engine"]["via"] == "bridge" and [v["name"] for v in info["engine"]["voices"]] == ["en_US-lessac-medium"]
        t = audiobook.test_voice(app, {"voice": "en_US-lessac-medium", "character": "Mara Vell"})
        assert t["ok"] and base64.b64decode(t["audio_b64"])[:4] == b"RIFF"
        assert br.requests[-1]["text"].startswith("Hello. I am Mara Vell") and not voice.requests
    finally:
        forge.save_bridge_settings(app, {"url": f"http://127.0.0.1:{free_port()}"})
        br.close()


def test_api_routes(book, voice):
    from akowe.errors import AkoweError  # noqa: PLC0415
    app, pid = book.app, book.pid
    code, out = audiobook.route(app, "GET", [], {}, None, "author", pid, "main")
    assert code == 200 and out["engine"]["ok"] and out["retail_notes"][0].startswith("This is information, not a guarantee")
    assert any("ACX" in n and "−3 dB" in n for n in out["retail_notes"])
    code, out = audiobook.route(app, "PUT", ["settings"], {}, {"dialogue": True, "full_book": False}, "author", pid, "main")
    assert out["settings"]["dialogue"] is True and out["settings"]["full_book"] is False
    with pytest.raises(AkoweError):
        audiobook.route(app, "PUT", ["settings"], {}, {"narrator": "../../x"}, "author", pid, "main")
    with pytest.raises(AkoweError):
        audiobook.route(app, "POST", ["test"], {}, {"voice": "a/b"}, "author", pid, "main")
    code, out = audiobook.route(app, "POST", ["make"], {}, {}, "author", pid, "main")
    assert code == 202 and out["ok"]
    _wait(pid)
    code, out = audiobook.route(app, "GET", ["job"], {}, None, "author", pid, "main")
    assert out["job"]["status"] == "done" and out["job"]["chapters"] == 3
    with pytest.raises(AkoweError):
        audiobook.route(app, "GET", ["nope"], {}, None, "author", pid, "main")
