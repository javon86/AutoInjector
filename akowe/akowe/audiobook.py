"""🎧 Audiobook (plan item 5b): the finished book read aloud, chapter by chapter, with piper voices on this PC.

**The engine.** piper, offline, through AutoInjector's voice shim (integrations/voice/voice_shim.py). Akọwe asks
AutoInjector the way it asks for pictures (docs/SD_IMAGE_API.md): the service bridge (``GET /voice/voices``,
``POST /voice/synthesize``, docs/AKOWE_AUTOINJECTOR_BRIDGE.md) — AutoInjector then starts its managed voice engine
when it is installed but not running. Without the bridge, Akọwe talks to a running voice shim directly
(``AKOWE_VOICE_URL``, default http://127.0.0.1:8232: ``GET /voices``, ``POST /synthesize``). With neither, the page
says so in plain words with the setup hint (Setup Wizard → Installs → Voice engine / Voice models) — never a raw
error (``PROBLEMS``).

**Voices.** A narrator voice the author picks from the installed piper voices. Optional "character voices for
dialogue": quoted speech is attributed with the speaker tags Akọwe already reads for the repetition sorter
(prose_audit's ``_TAG_AFTER`` / ``_TAG_BEFORE``: ``"…," Mara said`` / ``said Mara``), plus careful rules of our own
(``attribute``): one speaker per paragraph; an action beat naming exactly one character ("Mara set the cup down.
"We go tonight.""); "she said" when only one woman is in the exchange; strict alternation of a two-person exchange
for untagged lines. Anything uncertain is read by the narrator. Each character gets a default voice by the gender /
age hints of the Book Bible (the character's attributes and the Character Forge looks) and the voice's known
gender; the author changes it in a small table with a ▶ test button.

**The files.** In the book's folder (the books folder, 💾 Save): ``audiobook/01 - <chapter>.mp3`` (MP3 when ffmpeg
is on this PC — found on PATH or ``AKOWE_FFMPEG``, like AutoInjector's 🎬 trailer joiner — else WAV), each chapter
starting with its spoken title; optionally the whole book in one file; and, with ffmpeg, an ``.m4b`` audiobook with
chapter marks. Loudness is set the same way for every chapter (RMS about −20 dBFS, peaks at most −3 dBFS — inside the
range ACX asks for). Before speaking, the text is cleaned: markdown marks go, a scene break becomes a pause, numbers
and common abbreviations are written out (``speakable``).

**Progress, resume, cancel.** A background job (``start``): "chapter n of N", the time left (from the speed so far),
✕ Cancel between pieces. Finished chapters are recorded in ``audiobook/.akowe-audiobook.json`` with a key of the
chapter's text version and the voices; making it again skips them (only changed chapters are read again).

Book text is never logged — only counts, codes and timings.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import wave
from array import array
from pathlib import Path

from .errors import AkoweError

log = logging.getLogger("akowe.audiobook")

SHIM_DEFAULT = "http://127.0.0.1:8232"
ENGINE_VERSION = 1           # part of a chapter's key: a change in how audio is made reads every chapter again
OUT_RATE = 22050             # every chapter file (WAV) is 22.05 kHz mono 16-bit; MP3 / M4B are 44.1 kHz
MAX_PIECE = 1200             # characters per synthesize call (the shim takes at most 4000)
SYNTH_TIMEOUT_S = 180.0
PROBE_TIMEOUT_S = 3.0
TARGET_RMS_DBFS = -20.0      # ACX: −23 to −18 dB RMS
PEAK_DBFS = -3.0             # ACX: peaks at most −3 dB
PAUSE_PARAGRAPH_S = 0.35
PAUSE_TITLE_S = 1.2
PAUSE_SCENE_S = 1.5
PAUSE_DIALOGUE_S = 0.12
MP3_BITRATE = "192k"         # ACX: 192 kbps constant bit rate, 44.1 kHz
OUT_ROOT = None              # tests: a folder instead of the book's folder in the books folder
MANIFEST = ".akowe-audiobook.json"
_LOCK = threading.RLock()
_JOBS: dict = {}
_REJ = {"status": "REJECTED"}

PROBLEMS = {
    "NO_VOICE_ENGINE": ("No voice engine is ready on this PC",
                        "In AutoInjector: Setup Wizard → Installs → “Voice engine”, then “Voice models” (pick at least "
                        "one piper voice). Keep AutoInjector open, then press 🎧 Make audiobook again."),
    "NO_VOICES": ("The voice engine has no piper voice yet",
                  "In AutoInjector: Setup Wizard → Installs → “Voice models”, download at least one piper voice, then "
                  "press 🎧 Make audiobook again."),
    "VOICE_FAILED": ("A piece of the book could not be spoken",
                     "Press 🎧 Make audiobook again: the chapters already finished are kept. If it keeps happening, "
                     "pick another narrator voice."),
    "BRIDGE_KEY": ("AutoInjector did not accept the key",
                   "Copy the bridge token from AutoInjector and paste it into Settings → Pictures (the same key is "
                   "used for voices)."),
    "NO_CHAPTERS": ("The book has no written chapters yet", "Write and approve the chapters first."),
    "ENCODE_FAILED": ("The MP3 / M4B files could not be made",
                      "The WAV files were kept instead. If it keeps happening, reinstall ffmpeg or remove it from the "
                      "PATH."),
    "CANCELLED": ("The audiobook was stopped", "Press 🎧 Make audiobook again to go on: finished chapters are kept."),
}

RETAIL_NOTES = [
    "This is information, not a guarantee: check each store's current rules yourself before you upload.",
    "ACX / Audible ask for exact audio specs: each file 1–120 minutes, RMS between −23 and −18 dB, peaks no higher "
    "than −3 dB, a noise floor below −60 dB, 192 kbps constant-bit-rate MP3 at 44.1 kHz, mono or stereo used the same "
    "way in every file, 0.5–1 s of room tone at the start and 1–5 s at the end, and a separate opening and closing "
    "credits file. Akọwe sets the loudness and bit rate for you; run their checker (or a tool such as ACX Check) "
    "before you upload.",
    "AI-made voices: rules differ by store and change often. Some stores accept only human narration, some accept "
    "AI voices with a label, and some have their own AI-narration programmes. Read the store's narration rules "
    "first, and say honestly that the narration is computer-generated where they ask.",
    "piper voices have their own licences (listed on each voice's page); some do not allow commercial use.",
]


class VoiceProblem(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(code)
        self.code = code
        self.detail = str(detail or "")[:200]

    def as_dict(self) -> dict:
        title, fix = PROBLEMS.get(self.code, PROBLEMS["VOICE_FAILED"])
        return {"code": self.code, "title": title, "fix": fix, "detail": self.detail}


def problem(code: str, detail: str = "") -> dict:
    return VoiceProblem(code, detail).as_dict()


# ====================================================================== the voice engine
def _targets(app) -> list[tuple[str, str, str | None]]:
    """[(via, base url, token)]: the service bridge first (AutoInjector starts its voice engine), then the shim."""
    out = []
    try:
        from . import forge  # noqa: PLC0415
        out += [("bridge", u, t) for u, t in forge.bridge_targets(app)]
    except Exception:  # noqa: BLE001
        log.exception("bridge targets")
    shim = (os.environ.get("AKOWE_VOICE_URL") or SHIM_DEFAULT).strip().rstrip("/")
    try:
        from .providers import validate_bridge_url  # noqa: PLC0415
        out.append(("shim", validate_bridge_url(shim), None))
    except AkoweError:
        log.warning("AKOWE_VOICE_URL is not an address on this computer; ignored")
    return out


ROUTES = {"bridge": {"voices": "/voice/voices", "synth": "/voice/synthesize"},
          "shim": {"voices": "/voices", "synth": "/synthesize"}}


def _http(url: str, body: dict | None, token: str | None, timeout: float) -> tuple[int, dict]:
    """(HTTP status, JSON object). Raises VoiceProblem("UNREACHABLE") when nothing answers."""
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="GET" if body is None else "POST",
                                 headers={"Accept": "application/json"})
    if data is not None:
        req.add_header("Content-Type", "application/json; charset=utf-8")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # this computer only
    try:
        with opener.open(req, timeout=timeout) as r:
            raw, code = r.read(64 * 1024 * 1024), r.status
    except urllib.error.HTTPError as exc:
        raw, code = exc.read(65536), exc.code
    except (urllib.error.URLError, OSError, socket.timeout, TimeoutError):
        raise VoiceProblem("UNREACHABLE") from None
    try:
        out = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        out = {}
    return code, out if isinstance(out, dict) else {}


def engine(app) -> dict:
    """{"ok", "via", "url", "voices"} of the first engine that answers with voices, else {"ok": False, "problem"}."""
    seen_engine = False
    key_refused = False
    for via, url, token in _targets(app):
        try:
            code, out = _http(url + ROUTES[via]["voices"], None, token, PROBE_TIMEOUT_S)
        except VoiceProblem:
            continue
        if code == 401:
            key_refused = True
            continue
        if code != 200 or out.get("ok") is False:
            if out.get("error") in ("NO_TTS", "NO_TTS_MODEL", "VOICE_NOT_INSTALLED", "VOICE_NOT_STARTED"):
                seen_engine = True
            continue  # an older AutoInjector without voices (404 / 501): try the next door
        voices = [v for v in out.get("voices") or [] if isinstance(v, str) and v and len(v) < 120]
        seen_engine = True
        if voices:
            return {"ok": True, "via": via, "url": url, "token": token, "voices": voices}
    code = "NO_VOICES" if seen_engine else "BRIDGE_KEY" if key_refused else "NO_VOICE_ENGINE"
    return {"ok": False, "voices": [], "problem": problem(code)}


def synthesize(eng: dict, text: str, voice: str) -> bytes:
    """One piece of speech as WAV bytes (raises VoiceProblem)."""
    try:
        code, out = _http(eng["url"] + ROUTES[eng["via"]]["synth"], {"text": text, "voice": voice, "from": "akowe"},
                          eng.get("token"), SYNTH_TIMEOUT_S)
    except VoiceProblem:
        raise VoiceProblem("NO_VOICE_ENGINE", "the voice engine stopped answering") from None
    if code == 401:
        raise VoiceProblem("BRIDGE_KEY")
    if code != 200 or not out.get("ok") or not isinstance(out.get("audio_b64"), str):
        err = str(out.get("error") or f"HTTP_{code}")
        if err in ("NO_TTS", "NO_TTS_MODEL"):
            raise VoiceProblem("NO_VOICES", err)
        raise VoiceProblem("VOICE_FAILED", err)
    try:
        return base64.b64decode(out["audio_b64"], validate=True)
    except (ValueError, TypeError):
        raise VoiceProblem("VOICE_FAILED", "unreadable audio") from None


# ====================================================================== text → what to say
_ABBR = [(r"\bMr\.", "Mister"), (r"\bMrs\.", "Missus"), (r"\bMs\.", "Miz"), (r"\bDr\.", "Doctor"),
         (r"\bProf\.", "Professor"), (r"\bSt\.(?=\s+[A-Z])", "Saint"), (r"\bMt\.", "Mount"), (r"\bCapt\.", "Captain"),
         (r"\bLt\.", "Lieutenant"), (r"\bSgt\.", "Sergeant"), (r"\bGen\.", "General"), (r"\bJr\.", "Junior"),
         (r"\bSr\.", "Senior"), (r"\be\.g\.", "for example"), (r"\bi\.e\.", "that is"), (r"\betc\.", "et cetera"),
         (r"\bvs\.", "versus"), (r"\bapprox\.", "approximately"), (r"\bNo\.(?=\s*\d)", "number"),
         (r"\bft\.", "feet"), (r"\bkm\b", "kilometres"), (r"\bkg\b", "kilograms")]
_ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
         "seventeen eighteen nineteen").split()
_TENS = "  twenty thirty forty fifty sixty seventy eighty ninety".split(" ")
_ORD = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth", "nine": "ninth",
        "twelve": "twelfth"}
_SCENE_BREAK = re.compile(r"^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,}|(?:~\s*){3,}|#|⁂|§|•\s*•\s*•|◇+|\* \* \*)\s*$")


def number_words(n: int) -> str:
    if n < 0:
        return "minus " + number_words(-n)
    if n < 20:
        return _ONES[n]
    if n < 100:
        t, o = divmod(n, 10)
        return _TENS[t] + (f"-{_ONES[o]}" if o else "")
    if n < 1000:
        h, r = divmod(n, 100)
        return f"{_ONES[h]} hundred" + (f" and {number_words(r)}" if r else "")
    for size, word in ((10 ** 9, "billion"), (10 ** 6, "million"), (1000, "thousand")):
        if n >= size:
            q, r = divmod(n, size)
            tail = "" if not r else (f" and {number_words(r)}" if r < 100 else f" {number_words(r)}")
            return f"{number_words(q)} {word}{tail}"
    return str(n)


def _year(n: int) -> str:
    if 2000 <= n <= 2009:
        return number_words(n)
    hi, lo = divmod(n, 100)
    return f"{number_words(hi)} hundred" if lo == 0 else f"{number_words(hi)} {'oh-' + _ONES[lo] if lo < 10 else number_words(lo)}"


def _ordinal(n: int) -> str:
    w = number_words(n)
    head, _, last = w.rpartition(" ")
    last_parts = last.split("-")
    lw = last_parts[-1]
    lw = _ORD.get(lw) or (lw[:-1] + "ieth" if lw.endswith("y") else lw + "th")
    last_parts[-1] = lw
    return (head + " " if head else "") + "-".join(last_parts)


def _numbers(s: str) -> str:
    s = re.sub(r"([£$€])\s?(\d[\d,]*)(?:\.(\d\d))?", lambda m: _money(m), s)
    s = re.sub(r"\b(\d+)(st|nd|rd|th)\b", lambda m: _ordinal(int(m.group(1))), s)
    s = re.sub(r"\b(\d+(?:\.\d+)?)\s?%", lambda m: _num_text(m.group(1)) + " percent", s)
    s = re.sub(r"\b(1[1-9]\d\d|20\d\d)\b(?!,\d)", lambda m: _year(int(m.group(1))), s)
    s = re.sub(r"\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\b", lambda m: _num_text(m.group(0)), s)
    return s


def _num_text(t: str) -> str:
    t = t.replace(",", "")
    if "." in t:
        a, b = t.split(".", 1)
        return number_words(int(a or "0")) + " point " + " ".join(_ONES[int(d)] for d in b)
    return number_words(int(t)) if len(t) <= 12 else " ".join(_ONES[int(d)] for d in t)


def _money(m) -> str:
    unit = {"£": ("pound", "pounds"), "$": ("dollar", "dollars"), "€": ("euro", "euros")}[m.group(1)]
    n = int(m.group(2).replace(",", ""))
    out = f"{number_words(n)} {unit[0] if n == 1 else unit[1]}"
    if m.group(3) and int(m.group(3)):
        out += f" and {number_words(int(m.group(3)))} " + ("pence" if m.group(1) == "£" else "cents")
    return out


def clean_line(s: str) -> str:
    """Markdown and symbols out, abbreviations and numbers written out (one paragraph)."""
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"<[^>\n]{1,80}>", " ", s)
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"(\*\*|__)(.+?)\1", r"\2", s)
    s = re.sub(r"(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)", r"\1\2", s)
    s = re.sub(r"(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)", r"\1\2", s)
    s = re.sub(r"~~(.+?)~~", r"\1", s)
    s = re.sub(r"^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+•]\s+)", "", s)
    s = re.sub(r"\[\^?\d+\]", "", s)  # footnote marks
    for pat, rep in _ABBR:
        s = re.sub(pat, rep, s)
    s = re.sub(r"(\d)\s?–\s?(\d)", r"\1 to \2", s)
    s = s.replace("&", " and ").replace("…", "...").replace("—", ", ").replace("–", ", ")
    s = _numbers(s)
    return re.sub(r"\s+([,.;:!?])", r"\1", " ".join(s.split())).replace(",,", ",")


def blocks(text: str) -> tuple[str, list]:
    """(chapter title from its "# " heading or "", [paragraph text | None for a scene-break pause])."""
    title = ""
    out: list = []
    lines = str(text or "").replace("\r\n", "\n").split("\n")
    if lines and lines[0].lstrip().startswith("# "):
        title = lines[0].lstrip()[2:].strip()
        lines = lines[1:]
    for par in re.split(r"\n\s*\n", "\n".join(lines)):
        par = par.strip()
        if not par:
            continue
        if _SCENE_BREAK.match(par):
            if out and out[-1] is not None:
                out.append(None)
            continue
        if par.startswith("#"):  # a scene heading inside the chapter: a pause, then the heading is read
            if out and out[-1] is not None:
                out.append(None)
            par = par.lstrip("#").strip()
        par = clean_line(" ".join(par.split()))
        if par and re.search(r"\w", par):
            out.append(par)
    while out and out[-1] is None:
        out.pop()
    return clean_line(title), out


# ====================================================================== who says what
_QUOTE = re.compile(r"[\"“]([^\"“”]{1,1200})[\"”]")
_TAG_AFTER = re.compile(r"^[,!?.]?[\"”]?[,]?\s*(?:([A-Z][\w'’-]+|he|she|they|I|we)\s+([a-z]+)|([a-z]+)\s+"
                        r"([A-Z][\w'’-]+|he|she|they))\b")
_TAG_BEFORE = re.compile(r"\b([A-Z][\w'’-]+|He|She|They)\s+([a-z]+)(?:\s+\w+)?\s*[,:]\s*$")
SAID = {"said", "says", "asked", "asks", "replied", "whispered", "shouted", "called", "answered", "muttered",
        "murmured", "cried", "snapped", "added", "told", "yelled", "hissed", "breathed", "began", "continued",
        "insisted", "admitted", "agreed", "laughed", "sighed", "growled", "repeated", "warned", "demanded",
        "explained", "offered", "pressed", "managed", "croaked", "whimpered", "roared", "barked", "teased",
        "corrected", "promised", "protested", "pleaded", "lied", "confessed", "wondered", "mumbled", "stammered"}


class Cast:
    """Name → character lookup: full names, first names and last names that are unique in the book."""

    def __init__(self, chars: list[dict]):
        self.chars = chars
        self.by: dict[str, str] = {}
        first: dict[str, list] = {}
        for c in chars:
            name = c["name"]
            self.by[name] = name
            parts = [p for p in re.split(r"\s+", name) if p[:1].isupper()]
            for p in parts:
                first.setdefault(p, []).append(name)
            for a in c.get("aliases") or []:
                self.by.setdefault(a, name)
        for p, names in first.items():
            if len(set(names)) == 1:
                self.by.setdefault(p, names[0])
        self.gender = {c["name"]: c.get("gender") for c in chars}

    def find(self, word: str | None) -> str | None:
        if not word:
            return None
        return self.by.get(word.strip("’'s").strip()) or self.by.get(word)

    def named_in(self, text: str) -> list[str]:
        seen = []
        for w in re.findall(r"\b[A-Z][\w'’-]+", text):
            n = self.find(w)
            if n and n not in seen:
                seen.append(n)
        return seen


def _tag_of(par: str, m) -> tuple[str | None, str | None]:
    """(name, pronoun) of the speaker tag right after or right before one quote."""
    after = _TAG_AFTER.match(par[m.end() - 1:m.end() + 60])
    if after:
        who, verb = (after.group(1), after.group(2)) if after.group(1) else (after.group(4), after.group(3))
        if verb in SAID or (who and who[0].isupper() and verb.endswith("ed") and len(verb) > 3):
            return (who, None) if who[0].isupper() and who not in ("I",) else (None, who.lower())
    before = _TAG_BEFORE.search(par[max(0, m.start() - 50):m.start()])
    if before and before.group(2) in SAID:
        who = before.group(1)
        return (None, who.lower()) if who in ("He", "She", "They") else (who, None)
    return None, None


def attribute(paragraphs: list, cast: Cast) -> list[list[dict]]:
    """Per paragraph: [{"text", "speaker" (character name or None for the narrator), "quote": bool}].

    Careful rules, the narrator when unsure: one speaker per paragraph (its tag, else a pronoun tag that fits exactly
    one of the two people talking, else an action beat that names exactly one character, else the other person of a
    strict two-person exchange). A scene break or a paragraph without speech ends the exchange."""
    out = []
    pair: list[str] = []      # the last two distinct speakers of the running exchange
    last: str | None = None   # who spoke in the previous paragraph
    for par in paragraphs:
        if par is None:
            out.append(None)
            pair, last = [], None
            continue
        quotes = list(_QUOTE.finditer(par))
        if not quotes:
            out.append([{"text": par, "speaker": None, "quote": False}])
            pair, last = [], None
            continue
        speaker = None
        pron = None
        for m in quotes:
            name, p = _tag_of(par, m)
            if name and cast.find(name):
                speaker = cast.find(name)
                break
            pron = pron or p
        if speaker is None:
            narration = _QUOTE.sub(" ", par)
            named = cast.named_in(narration)
            if pron in ("he", "she"):
                fits = [n for n in pair if cast.gender.get(n) == ("female" if pron == "she" else "male")]
                if len(fits) == 1:
                    speaker = fits[0]
                elif len(named) == 1 and cast.gender.get(named[0]) in (None, "female" if pron == "she" else "male"):
                    speaker = named[0]
            elif len(named) == 1 and not pron:
                speaker = named[0]
            elif not named and not pron and len(pair) == 2 and last in pair:
                speaker = pair[0] if last == pair[1] else pair[1]
        segs = []
        pos = 0
        for m in quotes:
            if m.start() > pos and par[pos:m.start()].strip(" ,.;:—-"):
                segs.append({"text": par[pos:m.start()].strip(), "speaker": None, "quote": False})
            segs.append({"text": m.group(1).strip(), "speaker": speaker, "quote": True})
            pos = m.end()
        if par[pos:].strip(" ,.;:—-"):
            segs.append({"text": par[pos:].strip(), "speaker": None, "quote": False})
        out.append(segs)
        if speaker:
            if speaker not in pair:
                pair = (pair + [speaker])[-2:]
            last = speaker
        else:
            last = None  # unsure: the narrator reads it; the exchange itself goes on
    return out


def pieces(title: str, attributed: list, narrator: str, voices: dict, dialogue: bool) -> list[dict]:
    """[{"say", "voice"} | {"pause": seconds}] in reading order: the title, then each paragraph; consecutive text in
    the same voice is joined, then split at sentence ends into pieces of at most ``MAX_PIECE`` characters."""
    out: list[dict] = []

    def add(text, voice):
        text = " ".join(str(text).split())
        if not text or not re.search(r"\w", text):
            return
        for chunk in chunk_text(text):
            if out and "say" in out[-1] and out[-1]["voice"] == voice and len(out[-1]["say"]) + len(chunk) < MAX_PIECE:
                out[-1]["say"] += " " + chunk
            else:
                out.append({"say": chunk, "voice": voice})

    if title:
        add(title, narrator)
        out.append({"pause": PAUSE_TITLE_S})
    for segs in attributed:
        if segs is None:
            out.append({"pause": PAUSE_SCENE_S})
            continue
        prev = None
        for s in segs:
            v = voices.get(s["speaker"]) if dialogue and s["speaker"] else None
            v = v or narrator
            if prev is not None and prev != v:
                out.append({"pause": PAUSE_DIALOGUE_S})
            add(s["text"], v)
            prev = v
        out.append({"pause": PAUSE_PARAGRAPH_S})
    while out and "pause" in out[-1]:
        out.pop()
    return out


def chunk_text(text: str, limit: int = MAX_PIECE) -> list[str]:
    text = " ".join(str(text).split())
    if len(text) <= limit:
        return [text] if text else []
    out, cur = [], ""
    for sent in re.findall(r"[^.!?…]+(?:[.!?…]+[\"'”’)]*|$)\s*", text):
        sent = sent.strip()
        while len(sent) > limit:  # one very long sentence: cut at a comma / space
            cut = max(sent.rfind(", ", 0, limit), sent.rfind(" ", 0, limit))
            cut = cut if cut > limit // 3 else limit
            if cur:
                out.append(cur)
                cur = ""
            out.append(sent[:cut].strip(" ,"))
            sent = sent[cut:].strip(" ,")
        if cur and len(cur) + 1 + len(sent) > limit:
            out.append(cur)
            cur = sent
        else:
            cur = (cur + " " + sent).strip()
    if cur:
        out.append(cur)
    return [c for c in out if c]


# ====================================================================== voices for characters
FEMALE_VOICES = {"amy", "lessac", "kathleen", "kristin", "ljspeech", "jenny", "jenny_dioco", "alba", "cori",
                 "southern_english_female", "hfc_female", "libritts_r", "semaine", "eva_k", "kerstin", "ramona",
                 "siwis", "upmc", "mls", "sharvard", "paola", "irina", "berta", "lili", "anna", "natia", "ona"}
MALE_VOICES = {"alan", "ryan", "joe", "john", "kusal", "danny", "arctic", "northern_english_male", "hfc_male",
               "bryce", "norman", "aru", "thorsten", "karlsson", "carlfm", "davefx", "pim", "ruslan", "dmitri",
               "denis", "riccardo", "faber", "gilles", "tom", "rohan", "harri", "nathan", "sam", "kareem", "reza"}


def voice_gender(voice: str) -> str | None:
    """'female' / 'male' / None from a piper voice name such as en_US-amy-medium."""
    parts = str(voice).lower().split("-")
    speaker = parts[1] if len(parts) >= 3 else parts[0]
    if speaker in FEMALE_VOICES or "female" in speaker:
        return "female"
    if speaker in MALE_VOICES or "male" in speaker:
        return "male"
    return None


_F = re.compile(r"\b(she|her|hers|herself|woman|girl|female|mother|daughter|sister|wife|queen|lady|grandmother|"
                r"aunt|niece|princess|duchess|widow)\b", re.I)
_M = re.compile(r"\b(he|him|his|himself|man|boy|male|father|son|brother|husband|king|lord|grandfather|uncle|"
                r"nephew|prince|duke|widower)\b", re.I)
_AGE_WORDS = [(re.compile(r"\b(child|kid|toddler|little girl|little boy)\b", re.I), "a child"),
              (re.compile(r"\b(teen|teenage|teenager|adolescent)\b", re.I), "a teenager"),
              (re.compile(r"\b(elderly|grey-haired|gray-haired|white-haired|grandmother|grandfather|old (?:man|woman))\b",
                          re.I), "older")]
_AGE_NUM = re.compile(r"\b(\d{1,3})[- ]years?[- ]old\b|\bage[d]?[:\s]+(\d{1,3})\b", re.I)


def gender_age(text: str) -> tuple[str | None, str | None]:
    f, m = len(_F.findall(text or "")), len(_M.findall(text or ""))
    gender = "female" if f > m else "male" if m > f else None
    age = None
    m = _AGE_NUM.search(text or "")
    if m:
        n = int(m.group(1) or m.group(2))
        age = "a child" if n < 13 else "a teenager" if n < 20 else "older" if n >= 60 else f"about {n}"
    else:
        age = next((word for rx, word in _AGE_WORDS if rx.search(text or "")), None)
    return gender, age


def characters(app, principal: str, pid: str, branch: str) -> list[dict]:
    """The cast with gender / age hints (attributes, facts and the Character Forge looks)."""
    from . import characters as chars_mod  # noqa: PLC0415
    out = []
    for c in chars_mod.canon_characters(app.store, pid, branch):
        if not c.get("name"):
            continue
        txt = " ".join(str(v) for v in (c.get("attributes") or {}).values())
        txt += " " + " ".join(str(f.get("value") or f.get("text") or "") for f in c.get("facts") or [])
        try:
            from .pictures import looks_of  # noqa: PLC0415
            txt += " " + looks_of(app.store, pid, branch, c["record_id"], budget=600)
        except Exception:  # noqa: BLE001 - looks are a bonus
            pass
        attrs = {str(k).lower(): str(v).lower() for k, v in (c.get("attributes") or {}).items()}
        gender = None
        for k in ("gender", "sex", "pronouns"):
            v = attrs.get(k, "")
            if re.search(r"\b(female|woman|she|her|girl)\b", v):
                gender = "female"
            elif re.search(r"\b(male|man|he|him|boy)\b", v):
                gender = "male"
        g2, age = gender_age(txt)
        gender = gender or g2
        hint = ", ".join(x for x in (gender, age) if x) or "no hint in the Book Bible"
        out.append({"name": c["name"], "record_id": c["record_id"], "gender": gender, "age": age, "hint": hint})
    return out


def default_voices(voices: list[str], narrator: str | None, cast: list[dict]) -> tuple[str | None, dict]:
    """(narrator, {character: voice}): a different voice per character where possible, of the matching gender."""
    if not voices:
        return None, {}
    narr = narrator if narrator in voices else voices[0]
    pool = [v for v in voices if v != narr] or [narr]
    used: dict[str, int] = {}
    out = {}
    for c in cast:
        fits = [v for v in pool if voice_gender(v) == c.get("gender")] if c.get("gender") else []
        cands = fits or [v for v in pool if voice_gender(v) is None] or pool
        v = min(cands, key=lambda x: (used.get(x, 0), cands.index(x)))
        used[v] = used.get(v, 0) + 1
        out[c["name"]] = v
    return narr, out


# ====================================================================== WAV work (pure Python, no numpy)
def read_wav(data: bytes) -> tuple[int, array]:
    """(sample rate, mono 16-bit samples) of a WAV (stereo is mixed down; 8-bit / 24-bit are refused)."""
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            rate, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
            raw = w.readframes(n)
    except (wave.Error, EOFError) as exc:
        raise VoiceProblem("VOICE_FAILED", f"not a WAV ({exc})") from None
    if width != 2:
        raise VoiceProblem("VOICE_FAILED", f"{8 * width}-bit audio")
    a = array("h")
    a.frombytes(raw[:len(raw) - len(raw) % 2])
    if _big_endian():
        a.byteswap()
    if ch == 2:
        a = array("h", ((a[i] + a[i + 1]) // 2 for i in range(0, len(a) - 1, 2)))
    return rate, a


def _big_endian() -> bool:
    import sys  # noqa: PLC0415
    return sys.byteorder == "big"


def resample(a: array, src: int, dst: int) -> array:
    if src == dst or not a:
        return a
    n = max(1, int(len(a) * dst / src))
    step = src / dst
    last = len(a) - 1
    out = array("h", bytes(2 * n))
    for i in range(n):
        x = i * step
        j = int(x)
        if j >= last:
            out[i] = a[last]
            continue
        f = x - j
        out[i] = int(a[j] + (a[j + 1] - a[j]) * f)
    return out


def silence(seconds: float, rate: int = OUT_RATE) -> array:
    return array("h", bytes(2 * int(seconds * rate)))


def normalise(a: array) -> array:
    """The same loudness for every chapter: RMS to TARGET_RMS_DBFS, peaks capped at PEAK_DBFS."""
    if not a:
        return a
    step = max(1, len(a) // 400000)  # measure on at most ~400k samples (fast, and plenty)
    sample = a[::step]
    sq = sum(x * x for x in sample)
    rms = (sq / len(sample)) ** 0.5
    peak = max(max(sample), -min(sample)) or 1
    if rms < 1:
        return a
    gain = (32767 * 10 ** (TARGET_RMS_DBFS / 20)) / rms
    gain = min(gain, (32767 * 10 ** (PEAK_DBFS / 20)) / peak)
    if abs(gain - 1.0) < 0.01:
        return a
    lim = int(32767 * 10 ** (PEAK_DBFS / 20))
    return array("h", (max(-lim, min(lim, int(x * gain))) for x in a))


def levels(a: array) -> dict:
    """RMS and peak in dBFS (for the notes and the tests)."""
    import math  # noqa: PLC0415
    if not a:
        return {"rms_dbfs": None, "peak_dbfs": None}
    rms = (sum(x * x for x in a) / len(a)) ** 0.5
    peak = max(max(a), -min(a))
    db = (lambda v: round(20 * math.log10(v / 32767), 1) if v > 0 else None)
    return {"rms_dbfs": db(rms), "peak_dbfs": db(peak)}


def wav_bytes(a: array, rate: int = OUT_RATE) -> bytes:
    buf = io.BytesIO()
    b = array("h", a)
    if _big_endian():
        b.byteswap()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b.tobytes())
    return buf.getvalue()


# ====================================================================== ffmpeg
def find_ffmpeg() -> str | None:
    """ffmpeg on this PC: AKOWE_FFMPEG, else on the PATH (the same rule as AutoInjector's trailer joiner)."""
    env = os.environ.get("AKOWE_FFMPEG")
    if env and os.path.isfile(env):
        return env
    return shutil.which("ffmpeg")


def _ff(ff: str, args: list[str], timeout: float = 3600) -> None:
    r = subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", *args], capture_output=True,
                       timeout=timeout, check=False)
    if r.returncode != 0:
        raise VoiceProblem("ENCODE_FAILED", (r.stderr or b"").decode("utf-8", "replace")[-200:])


def to_mp3(ff: str, wav: Path, mp3: Path) -> None:
    _ff(ff, ["-i", str(wav), "-codec:a", "libmp3lame", "-b:a", MP3_BITRATE, "-ar", "44100", "-ac", "1", str(mp3)])


def concat(ff: str, files: list[Path], out: Path, *, m4b_meta: Path | None = None) -> None:
    lst = out.with_name(out.name + ".list.txt")
    lst.write_text("".join("file '" + str(f).replace("'", "'\\''") + "'\n" for f in files), encoding="utf-8")
    try:
        if m4b_meta is None:
            _ff(ff, ["-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out)])
        else:
            _ff(ff, ["-f", "concat", "-safe", "0", "-i", str(lst), "-i", str(m4b_meta), "-map_metadata", "1",
                     "-map", "0:a", "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-f", "mp4", str(out)])
    finally:
        lst.unlink(missing_ok=True)


def chapter_meta(book_title: str, author: str, chs: list[dict]) -> str:
    def esc(s):
        return re.sub(r"([=;#\\\n])", r"\\\1", str(s or ""))
    out = [";FFMETADATA1", f"title={esc(book_title)}", f"artist={esc(author)}", "genre=Audiobook"]
    t = 0
    for c in chs:
        ms = int(round(c["seconds"] * 1000))
        out += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={t}", f"END={t + ms}", f"title={esc(c['title'])}"]
        t += ms
    return "\n".join(out) + "\n"


# ====================================================================== settings, folder, manifest
def _skey(pid, branch) -> str:
    return f"audiobook:{pid}:{branch}"


def settings(store, pid, branch) -> dict:
    s = store.get_setting(_skey(pid, branch)) or {}
    s = s if isinstance(s, dict) else {}
    cv = s.get("character_voices") if isinstance(s.get("character_voices"), dict) else {}
    return {"narrator": s.get("narrator") if isinstance(s.get("narrator"), str) else None,
            "dialogue": bool(s.get("dialogue")), "full_book": s.get("full_book") is not False,
            "character_voices": {str(k): str(v) for k, v in cv.items() if isinstance(v, str)}}


def save_settings(store, pid, branch, body) -> dict:
    if not isinstance(body, dict):
        raise AkoweError("INVALID_INPUT", "", "settings must be an object", **_REJ)
    cur = settings(store, pid, branch)
    name_ok = re.compile(r"^[A-Za-z0-9._\-]{1,120}$")
    if "narrator" in body:
        v = body["narrator"]
        if v not in (None, "") and (not isinstance(v, str) or not name_ok.match(v)):
            raise AkoweError("INVALID_INPUT", "/narrator", "narrator: the name of an installed piper voice", **_REJ)
        cur["narrator"] = v or None
    for k in ("dialogue", "full_book"):
        if k in body:
            if not isinstance(body[k], bool):
                raise AkoweError("INVALID_INPUT", f"/{k}", f"{k}: true or false", **_REJ)
            cur[k] = body[k]
    if "character_voices" in body:
        cv = body["character_voices"]
        if not isinstance(cv, dict) or len(cv) > 200 or not all(
                isinstance(k, str) and len(k) <= 120 and isinstance(v, str) and (v == "" or name_ok.match(v))
                for k, v in cv.items()):
            raise AkoweError("INVALID_INPUT", "/character_voices", "character_voices: {character: voice}", **_REJ)
        cur["character_voices"] = {k: v for k, v in cv.items() if v}
    store.set_setting(_skey(pid, branch), cur)
    return cur


def folder(app, pid, branch, create: bool = False) -> Path:
    if OUT_ROOT is not None:
        base = Path(OUT_ROOT) / f"{pid}-{branch}"
    else:
        base = app.saver.book_folder(pid, branch, create=create)
    f = base / "audiobook"
    if create:
        f.mkdir(parents=True, exist_ok=True)
    return f


def read_manifest(f: Path) -> dict:
    try:
        d = json.loads((f / MANIFEST).read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def write_manifest(f: Path, d: dict) -> None:
    tmp = f / (MANIFEST + ".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, f / MANIFEST)


def safe_file(s: str, n: int = 60) -> str:
    s = re.sub(r"[^\w\-'’ ,.()&!]+", " ", str(s or ""), flags=re.UNICODE)
    return " ".join(s.split()).strip(" .")[:n].strip() or "Chapter"


def chapter_key(ch: dict, narrator: str, voices: dict, dialogue: bool) -> str:
    raw = json.dumps([ENGINE_VERSION, ch["record_id"], ch["version"], ch.get("title"), narrator, bool(dialogue),
                      sorted(voices.items()) if dialogue else []], ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]


def _chapters(app, principal, pid, branch) -> list[dict]:
    from .continuity import chapters_of  # noqa: PLC0415
    return chapters_of(app.review.bp(principal, pid, branch))


# ====================================================================== the job
class Job:
    def __init__(self, pid, branch):
        self.pid, self.branch = pid, branch
        self.status = "running"
        self.phase = "Starting"
        self.chapter = 0
        self.chapters = 0
        self.started = time.time()
        self.finished: float | None = None
        self.done_chars = 0
        self.total_chars = 0
        self.spoken_s = 0.0          # time spent speaking (for the time left)
        self.cancelled = False
        self.problem: dict | None = None
        self.files: list[str] = []
        self.kept = 0
        self.made = 0
        self.notes: list[str] = []

    def public(self) -> dict:
        left = None
        if self.status == "running" and self.done_chars > 200 and self.spoken_s > 0:
            left = int((self.total_chars - self.done_chars) * self.spoken_s / self.done_chars)
        return {"status": self.status, "phase": self.phase, "chapter": self.chapter, "chapters": self.chapters,
                "seconds_left": left, "time_left": _left_words(left), "problem": self.problem, "files": self.files,
                "kept": self.kept, "made": self.made, "notes": self.notes[-8:],
                "elapsed_s": int((self.finished or time.time()) - self.started),
                "percent": int(100 * self.done_chars / self.total_chars) if self.total_chars else 0}


def _left_words(s: int | None) -> str | None:
    if s is None:
        return None
    if s < 60:
        return "less than a minute left"
    m = round(s / 60)
    if m < 60:
        return f"about {m} minute{'s' if m != 1 else ''} left"
    return f"about {m // 60} h {m % 60:02d} min left"


def job_of(pid, branch) -> Job | None:
    with _LOCK:
        return _JOBS.get((pid, branch))


def start(app, principal: str, pid: str, branch: str, body: dict | None = None) -> dict:
    body = body if isinstance(body, dict) else {}
    with _LOCK:
        cur = _JOBS.get((pid, branch))
        if cur is not None and cur.status == "running":
            return {"ok": True, "already": True, "job": cur.public()}
    chs = [c for c in _chapters(app, principal, pid, branch) if (c.get("text") or "").strip()]
    if not chs:
        return {"ok": False, "problem": problem("NO_CHAPTERS")}
    eng = engine(app)
    if not eng["ok"]:
        return {"ok": False, "problem": eng["problem"]}
    job = Job(pid, branch)
    with _LOCK:
        _JOBS[(pid, branch)] = job
    t = threading.Thread(target=_run_safe, args=(app, principal, job, eng, chs, body), name="akowe-audiobook",
                         daemon=True)
    t.start()
    return {"ok": True, "job": job.public()}


def cancel(pid, branch) -> dict:
    job = job_of(pid, branch)
    if job is None or job.status != "running":
        return {"ok": True, "job": job.public() if job else None}
    job.cancelled = True
    job.phase = "Stopping after this piece…"
    return {"ok": True, "job": job.public()}


def _run_safe(app, principal, job: Job, eng, chs, body):
    try:
        _run(app, principal, job, eng, chs, body)
        if job.status == "running":
            job.status, job.phase = "done", "Finished"
    except _Cancelled:
        job.status, job.phase, job.problem = "cancelled", "Stopped", problem("CANCELLED")
    except VoiceProblem as exc:
        log.warning("audiobook stopped: %s", exc.code)
        job.status, job.phase, job.problem = "problem", "Stopped", exc.as_dict()
    except Exception:  # noqa: BLE001 - never a raw error in the page
        log.exception("audiobook failed")
        job.status, job.phase, job.problem = "problem", "Stopped", problem("VOICE_FAILED", "unexpected problem")
    finally:
        job.finished = time.time()


class _Cancelled(Exception):
    pass


def _check(job: Job):
    if job.cancelled:
        raise _Cancelled()


def _run(app, principal, job: Job, eng: dict, chs: list[dict], body: dict):
    pid, branch = job.pid, job.branch
    s = settings(app.store, pid, branch)
    cast = characters(app, principal, pid, branch) if s["dialogue"] else []
    narrator, defaults = default_voices(eng["voices"], s["narrator"], cast)
    voices = {c["name"]: (s["character_voices"].get(c["name"]) if s["character_voices"].get(c["name"])
                          in eng["voices"] else defaults.get(c["name"])) for c in cast}
    ff = find_ffmpeg()
    fmt = "mp3" if ff else "wav"
    out = folder(app, pid, branch, create=True)
    man = read_manifest(out)
    mch = man.get("chapters") if isinstance(man.get("chapters"), dict) else {}
    job.chapters = len(chs)
    looked = Cast(cast)
    plans = []
    for i, ch in enumerate(chs, 1):
        title, paras = blocks(ch["text"])
        title = title or clean_line(ch.get("title") or "")
        spoken_title = f"Chapter {number_words(i)}" + (f". {title}" if title else "")
        att = attribute(paras, looked) if s["dialogue"] else [[{"text": p, "speaker": None, "quote": False}]
                                                              if p is not None else None for p in paras]
        plan = pieces(spoken_title, att, narrator, voices, s["dialogue"])
        key = chapter_key(ch, narrator, voices, s["dialogue"])
        name = f"{i:02d} - {safe_file(title or f'Chapter {i}')}.{fmt}"
        plans.append((i, ch, title, plan, key, name))
        job.total_chars += sum(len(p.get("say", "")) for p in plan)
    for i, ch, title, plan, key, name in plans:
        _check(job)
        job.chapter = i
        prev = mch.get(ch["chapter_id"]) or {}
        if prev.get("key") == key and prev.get("file") and (out / prev["file"]).is_file():
            job.kept += 1
            job.done_chars += sum(len(p.get("say", "")) for p in plan)
            job.phase = f"Chapter {i} of {len(chs)} was already made — kept"
            continue
        job.phase = f"Reading chapter {i} of {len(chs)}"
        audio = array("h")
        audio.extend(silence(0.6))  # room tone at the start
        for p in plan:
            _check(job)
            if "pause" in p:
                audio.extend(silence(p["pause"]))
                continue
            t0 = time.monotonic()
            rate, a = read_wav(synthesize(eng, p["say"], p["voice"]))
            audio.extend(resample(a, rate, OUT_RATE))
            job.spoken_s += time.monotonic() - t0
            job.done_chars += len(p["say"])
        audio.extend(silence(1.5))  # and at the end
        audio = normalise(audio)
        seconds = len(audio) / OUT_RATE
        for old in (prev.get("file"), name):  # a renamed chapter: the old file goes
            if old and old != name:
                (out / old).unlink(missing_ok=True)
        wav_path = out / (name if fmt == "wav" else name[:-4] + ".wav.part")
        tmp = wav_path.with_name(wav_path.name + ".tmp")
        tmp.write_bytes(wav_bytes(audio))
        os.replace(tmp, wav_path)
        if fmt == "mp3":
            try:
                to_mp3(ff, wav_path, out / name)
            finally:
                wav_path.unlink(missing_ok=True)
        mch[ch["chapter_id"]] = {"key": key, "file": name, "seconds": round(seconds, 2), "title": title or f"Chapter {i}",
                                 "number": i, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        man["chapters"] = mch
        write_manifest(out, man)
        job.made += 1
        log.info("audiobook chapter %s of %s made: %.0f s, %s pieces", i, len(chs), seconds, len(plan))
    order = [mch[ch["chapter_id"]] for _i, ch, *_ in plans]
    job.files = [c["file"] for c in order]
    book_title, author = _title_author(app, pid)
    want_full = body.get("full_book") if isinstance(body.get("full_book"), bool) else s["full_book"]
    if want_full:
        _check(job)
        job.phase = "Joining the whole book into one file"
        full = f"{safe_file(book_title, 80)} (whole book).{fmt}"
        try:
            if ff:
                concat(ff, [out / c["file"] for c in order], out / full)
            else:
                _join_wavs([out / c["file"] for c in order], out / full)
            job.files.append(full)
        except VoiceProblem as exc:
            job.notes.append(f"The whole-book file could not be made ({exc.as_dict()['title']}); the chapter files "
                             "are complete.")
    if ff:
        _check(job)
        job.phase = "Making the M4B audiobook with chapter marks"
        meta = out / ".chapters.ffmeta"
        meta.write_text(chapter_meta(book_title, author, order), encoding="utf-8")
        m4b = f"{safe_file(book_title, 80)}.m4b"
        try:
            concat(ff, [out / c["file"] for c in order], out / m4b, m4b_meta=meta)
            job.files.append(m4b)
        except VoiceProblem:
            job.notes.append("The M4B file could not be made; the MP3 files are complete.")
        finally:
            meta.unlink(missing_ok=True)
    else:
        job.notes.append("ffmpeg is not on this PC, so the files are WAV (large) and there is no M4B. Install ffmpeg "
                         "to get MP3 files and an M4B audiobook with chapter marks.")
    (out / "About these files.txt").write_text(_about(book_title, fmt, narrator, s["dialogue"]), encoding="utf-8")
    man.update(format=fmt, narrator=narrator, files=job.files, at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    write_manifest(out, man)
    job.phase = f"Finished: {len(order)} chapter file(s)" + (f", {job.kept} kept from before" if job.kept else "")


def _join_wavs(files: list[Path], out: Path) -> None:
    tmp = out.with_name(out.name + ".tmp")
    with wave.open(str(tmp), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(OUT_RATE)
        for f in files:
            with wave.open(str(f), "rb") as r:
                w.writeframes(r.readframes(r.getnframes()))
    os.replace(tmp, out)


def _title_author(app, pid) -> tuple[str, str]:
    try:
        from .book_path import get_profile  # noqa: PLC0415
        p = get_profile(app.store, pid)
        return (p.get("title") or (app.store.project(pid) or {}).get("name") or "Book"), (p.get("author") or "")
    except Exception:  # noqa: BLE001
        return "Book", ""


def _about(title: str, fmt: str, narrator: str, dialogue: bool) -> str:
    lines = [f"Audiobook of “{title}”, made by Akọwe with piper voices on this PC.", "",
             f"Format: {fmt.upper()}" + (" (192 kbps, 44.1 kHz, mono) plus an M4B with chapter marks" if fmt == "mp3"
                                         else " (22.05 kHz, mono)"),
             f"Narrator voice: {narrator}" + (" · characters have their own voices in dialogue" if dialogue else ""),
             "Loudness: about −20 dB RMS, peaks at most −3 dB, the same for every chapter.", "",
             "Before you sell it:"] + [f"• {n}" for n in RETAIL_NOTES]
    return "\n".join(lines) + "\n"


# ====================================================================== the page
def info(app, principal, pid, branch) -> dict:
    eng = engine(app)
    s = settings(app.store, pid, branch)
    cast = characters(app, principal, pid, branch)
    narrator, defaults = default_voices(eng["voices"], s["narrator"], cast)
    rows = [dict(c, voice=s["character_voices"].get(c["name"]) if s["character_voices"].get(c["name"]) in
                 eng["voices"] else defaults.get(c["name"]), default_voice=defaults.get(c["name"])) for c in cast]
    chs = _chapters(app, principal, pid, branch)
    out = folder(app, pid, branch)
    man = read_manifest(out)
    mch = man.get("chapters") if isinstance(man.get("chapters"), dict) else {}
    vmap = {r["name"]: r["voice"] for r in rows}
    chapters = []
    for i, c in enumerate(chs, 1):
        e = mch.get(c["chapter_id"]) or {}
        fresh = bool(narrator) and e.get("key") == chapter_key(c, narrator, vmap, s["dialogue"]) \
            and (out / str(e.get("file") or "-")).is_file()
        chapters.append({"number": i, "title": c.get("title") or f"Chapter {i}", "words": c.get("words"),
                         "done": fresh, "seconds": e.get("seconds") if fresh else None})
    job = job_of(pid, branch)
    ff = find_ffmpeg()
    files = [f for f in (man.get("files") or []) if isinstance(f, str) and (out / f).is_file()]
    return {"engine": {"ok": eng["ok"], "via": eng.get("via"), "voices": [{"name": v, "gender": voice_gender(v)}
                                                                          for v in eng["voices"]],
                       "problem": eng.get("problem")},
            "ffmpeg": bool(ff), "format": "mp3" if ff else "wav", "m4b": bool(ff),
            "settings": dict(s, narrator=narrator), "characters": rows, "chapters": chapters,
            "job": job.public() if job else None, "files": files, "folder": str(out),
            "retail_notes": RETAIL_NOTES}


SAMPLE = {"narrator": "This is how the narrator of your book will sound.",
          "character": "Hello. I am {name}, and this is how I sound in your book."}


def test_voice(app, body) -> dict:
    body = body if isinstance(body, dict) else {}
    voice = body.get("voice")
    if not isinstance(voice, str) or not re.match(r"^[A-Za-z0-9._\-]{1,120}$", voice):
        raise AkoweError("INVALID_INPUT", "/voice", "voice: the name of an installed piper voice", **_REJ)
    name = body.get("character")
    text = SAMPLE["character"].format(name=str(name)[:60]) if isinstance(name, str) and name else SAMPLE["narrator"]
    eng = engine(app)
    if not eng["ok"]:
        return {"ok": False, "problem": eng["problem"]}
    try:
        wav = synthesize(eng, clean_line(text), voice)
    except VoiceProblem as exc:
        return {"ok": False, "problem": exc.as_dict()}
    return {"ok": True, "mime": "audio/wav", "audio_b64": base64.b64encode(wav).decode("ascii")}


def route(app, method: str, rest: list, query: dict, body, principal: str, pid: str, branch: str):
    """/api/projects/:pid/branches/:b/audiobook/… (one block in server.py)."""
    if not app.store.has_project_access(principal, pid):
        raise AkoweError("PERMISSION_DENIED", "", "no access to this book", **_REJ)
    if rest == [] and method == "GET":
        return 200, info(app, principal, pid, branch)
    if rest == ["settings"] and method == "PUT":
        save_settings(app.store, pid, branch, body)
        return 200, info(app, principal, pid, branch)
    if rest == ["test"] and method == "POST":
        return 200, test_voice(app, body)
    if rest == ["make"] and method == "POST":
        return 202, start(app, principal, pid, branch, body)
    if rest == ["cancel"] and method == "POST":
        return 200, cancel(pid, branch)
    if rest == ["job"] and method == "GET":
        job = job_of(pid, branch)
        return 200, {"job": job.public() if job else None}
    raise AkoweError("NOT_FOUND", "/audiobook", "no such Audiobook endpoint", **_REJ)
