"""🧹 The ONE clean-up for text an AI made (and for a few stored fields that must never carry invisible characters).

What it removes — only characters nobody can see or type on purpose in a book:

* C0 control characters (NUL, BEL, ESC, …) except newline and tab; a carriage return becomes a newline (``\\r\\n`` →
  ``\\n``); DEL and the C1 controls (U+0080–U+009F);
* a terminal colour / cursor code as a whole (``ESC[31m`` → nothing, not a stray ``[31m``);
* the bidirectional embedding / override / isolate controls (U+202A–U+202E, U+2066–U+2069) that make text display
  reversed; the left-to-right / right-to-left marks (U+200E, U+200F, U+061C) are kept: Arabic and Hebrew text uses
  them;
* zero-width characters: zero-width space (U+200B), word joiner (U+2060), the invisible operators (U+2061–U+2064),
  the Mongolian vowel separator (U+180E) and the byte-order mark (U+FEFF); a zero-width joiner / non-joiner
  (U+200D / U+200C) only when it joins nothing (next to a space, the start or end, or another removed character) —
  between two letters or two emoji it is part of the writing (Persian, Hindi, 👩‍👩‍👧) and stays;
* the Unicode "tag" characters (U+E0000–U+E007F) outside an emoji flag sequence, and the lone surrogates a broken
  decoder leaves.

What it never touches: letters with accents and tone marks (Yorùbá ọ̀ ẹ́ ṣ, Vietnamese, Greek, …: the combining marks
stay where they are, no normalisation), emoji, any visible character, spacing and line breaks.

``clean(text)`` returns the cleaned string (anything that is not a string is returned unchanged); ``clean_tree(obj)``
cleans every string inside dicts / lists / tuples (keys too); ``needs_cleaning(text)`` says whether ``clean`` would
change it. All are pure, fast for a 350 kB chapter, and never raise.
"""
from __future__ import annotations

import re

# ESC [ … final byte  (CSI)  |  ESC ] … BEL / ESC \  (OSC)  |  ESC + one character
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]")
_BIDI = "‪‫‬‭‮⁦⁧⁨⁩"
_ZERO = "​⁠⁡⁢⁣⁤᠎﻿"
_JOIN = "‌‍"
_DROP = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f" + _BIDI + _ZERO + "\ud800-\udfff]")
_TAG = re.compile("[\U000e0000-\U000e007f]+")
_ANY = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f" + _BIDI + _ZERO + _JOIN + "\ud800-\udfff\U000e0000-\U000e007f]")
_FLAG_BASE = "\U0001f3f4"  # 🏴 + tag letters + cancel tag = a subdivision flag (🏴󠁧󠁢󠁳󠁣󠁴󠁿)


def needs_cleaning(text) -> bool:
    """True when ``clean`` would change ``text`` (a quick test before copying a large text)."""
    return isinstance(text, str) and bool(_ANY.search(text))


def _tags(m: re.Match) -> str:
    s, start = m.string, m.start()
    return m.group(0) if start and s[start - 1] == _FLAG_BASE and m.group(0).endswith("\U000e007f") else ""


def _joiners(text: str) -> str:
    out = []
    n = len(text)
    for i, ch in enumerate(text):
        if ch in _JOIN:
            before = text[i - 1] if i else ""
            after = text[i + 1] if i + 1 < n else ""
            if not before or not after or before.isspace() or after.isspace() or before in _JOIN or after in _JOIN:
                continue
        out.append(ch)
    return "".join(out)


def clean(text):
    """``text`` without control, bidirectional-override and zero-width characters (see the module docstring)."""
    if not isinstance(text, str) or not _ANY.search(text):
        return text
    try:
        s = _ANSI.sub("", text)
        s = s.replace("\r\n", "\n").replace("\r", "\n")
        s = _DROP.sub("", s)
        s = _TAG.sub(_tags, s)
        if "‌" in s or "‍" in s:
            s = _joiners(s)
        return s
    except Exception:  # noqa: BLE001 - a clean-up never breaks the caller: worst case the text stays as it was
        return text


def clean_tree(obj, _depth: int = 0):
    """``obj`` with every string inside it cleaned (dicts, lists and tuples, keys too; other values unchanged).
    Returns the very same object when nothing in it needed cleaning."""
    if isinstance(obj, str):
        return clean(obj)
    if _depth > 60 or not isinstance(obj, (dict, list, tuple)):
        return obj
    if isinstance(obj, dict):
        pairs = [(clean(k), clean_tree(v, _depth + 1)) for k, v in obj.items()]
        same = all(k2 is k and v2 is v for (k2, v2), (k, v) in zip(pairs, obj.items()))
        return obj if same else dict(pairs)
    items = [clean_tree(v, _depth + 1) for v in obj]
    if all(a is b for a, b in zip(items, obj)):
        return obj
    return items if isinstance(obj, list) else tuple(items)
