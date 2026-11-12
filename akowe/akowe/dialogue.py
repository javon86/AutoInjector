"""💬 One shared dialogue finder for every check that treats dialogue differently from narration (no AI).

Books quote speech in different ways, and every one of them must be recognised the same way everywhere (the
readability dialogue share, the chapter polish's "dialogue never changes" guard, the originality / prose / repeat /
clock checks that skip dialogue):

* double quotes, straight or curly: "Come here," she said.  /  “Come here,” she said.
* single quotes, straight or curly (British style): 'Come here,' she said.  /  ‘Come here,’ she said.
* em-dash dialogue (a line that opens with a dash): — Come here, she said.

Single quotes are also apostrophes, so a single quote only counts as speech when it opens after the start of a line,
a space, a bracket or a dash and closes before a space, punctuation or the end of the line — and the closing mark
follows punctuation (,.!?…—) or is followed by a speech word ("said", "she asked") or a stop. An apostrophe inside a
word (don't, Teo's), after a plural (the boys' boat), or at the start of a short form ('90s, rock 'n' roll, 'em,
'tis) is never speech. A quote left open at the end of a paragraph that started with it is speech up to the end of
that paragraph (the British way of carrying a long speech across paragraphs); any other unclosed mark is ignored.

API: ``finditer(text)`` (match-like objects: ``start()``, ``end()``, ``group(0)`` the quote with its marks,
``group(1)`` the words inside), ``spans``, ``quotes``, ``narration`` (the text with dialogue replaced),
``mask`` (same length, dialogue blanked), ``words_inside``, ``has_dialogue``, ``starts_with_dialogue``,
``same_dialogue`` (the polish guard) and ``style`` (which style a text mostly uses).
"""
from __future__ import annotations

import re
from collections import Counter

DOUBLE_OPEN, DOUBLE_CLOSE = "“", "”"
SINGLE_OPEN, SINGLE_CLOSE = "‘", "’"
DASHES = "—―–"
_OPEN_BEFORE = set(" \t([{ " + DASHES + "-“\"‘'/") | {""}
_CLOSE_AFTER = set(" \t ,.;:!?)]}…" + DASHES + "-”\"’'") | {""}
_PUNCT_BEFORE = set(",.!?…;:" + DASHES + "-")
# short forms that start with an apostrophe ('em, 'tis, rock 'n' roll …): never the start of a quote
ELISIONS = {"em", "tis", "twas", "til", "till", "cos", "cause", "bout", "nuff", "n", "round", "neath", "fraid",
            "im", "er", "ere", "ow", "e", "appen", "ave", "alf", "ell", "ead", "ome", "ouse", "un", "uns", "s", "d",
            "ll", "re", "ve", "m", "t", "kay", "member", "specially", "scuse", "course", "sides", "spose",
            "gainst", "mongst", "twixt", "tween", "ard", "ad"}
SPEECH = {"said", "says", "say", "asked", "asks", "replied", "answered", "whispered", "shouted", "called",
          "cried", "muttered", "murmured", "added", "told", "snapped", "breathed", "hissed", "yelled", "went", "began",
          "continued", "insisted", "admitted", "agreed", "explained", "repeated", "warned", "laughed", "sighed",
          "demanded", "offered", "suggested", "protested", "growled", "grumbled", "pressed", "managed", "tried",
          "corrected", "wondered", "joked", "teased", "promised", "lied", "pleaded", "begged", "mumbled", "croaked"}
_PRONOUNS = {"he", "she", "they", "i", "we", "you", "it"}
_DASH_LINE = re.compile(r"^[ \t]*[—―–][ \t]*(?=\S)")
_WORD_AT = re.compile(r"[A-Za-z][A-Za-z]*")
_PARA = re.compile(r"\n")


class Quote:
    """A found quote (behaves like an ``re.Match`` for the parts the checks use)."""
    __slots__ = ("_text", "_a", "_b", "_ia", "_ib", "kind")

    def __init__(self, text: str, a: int, b: int, ia: int, ib: int, kind: str):
        self._text, self._a, self._b, self._ia, self._ib, self.kind = text, a, b, ia, ib, kind

    def start(self, g: int = 0) -> int:
        return self._a if g == 0 else self._ia

    def end(self, g: int = 0) -> int:
        return self._b if g == 0 else self._ib

    def span(self, g: int = 0) -> tuple[int, int]:
        return self.start(g), self.end(g)

    def group(self, g: int = 0) -> str:
        return self._text[self._a:self._b] if g == 0 else self._text[self._ia:self._ib]

    def __repr__(self) -> str:  # pragma: no cover - debugging only
        return f"<Quote {self.kind} {self._a}-{self._b} {self.group(0)!r}>"


def _ch(s: str, i: int) -> str:
    return s[i] if 0 <= i < len(s) else ""


def _next_word(s: str, i: int) -> str:
    m = _WORD_AT.match(s, i)
    return m.group(0).lower() if m else ""


def _is_single_open(line: str, i: int) -> bool:
    """Can the single quote at ``i`` open a quotation (not an apostrophe)?"""
    before, after = _ch(line, i - 1), _ch(line, i + 1)
    if before not in _OPEN_BEFORE or before in ("'", "‘"):
        return False
    if not after or after.isspace():
        return False
    if after.isdigit():                       # '90s, '24
        return False
    m = _WORD_AT.match(line, i + 1)
    if m and m.group(0)[0].islower() and m.group(0) in ELISIONS:
        return False                          # 'em, 'tis, rock 'n' roll: a short form, not a quote
    return True


def _is_single_close(line: str, j: int) -> bool:
    """Can the single quote at ``j`` close an open quotation (not an apostrophe)?"""
    before, after = _ch(line, j - 1), _ch(line, j + 1)
    if before.isalnum() and after.isalnum():
        return False                          # don't, Teo's, rock'n'roll
    if after not in _CLOSE_AFTER:
        return False
    if before in _PUNCT_BEFORE or before in ("?", "!"):
        return True                           # 'Come here,' she said.  'Go!'
    if before.isspace() or not before:
        return False
    # a word ends here: the end of a quote ('Fine' she said / 'the boat'.) or a plural's apostrophe (the boys' boat)
    if not after or after in ",.;:!?)]}…" + DASHES + "-”\"":
        return True
    rest = line[j + 1:].lstrip(" \t ")
    if not rest:
        return True
    if rest[0] in DASHES or rest[0] in "“\"‘'":
        return True
    w = _next_word(rest, 0)
    if w in SPEECH:
        return True
    if w in _PRONOUNS or rest[0].isupper():
        rest2 = rest[len(w):].lstrip()
        w2 = _next_word(rest2, 0)
        if w2 in SPEECH:
            return True
    return False


def _line_quotes(text: str, a: int, b: int, out: list) -> None:
    """The quotes of one paragraph / line ``text[a:b]`` (absolute offsets)."""
    line = text[a:b]
    if not line.strip():
        return
    m = _DASH_LINE.match(line)
    if m and any(c.isalpha() for c in line):
        out.append(Quote(text, a + len(line) - len(line.lstrip(" \t")), b, a + m.end(), b, "dash"))
        return
    first = len(line) - len(line.lstrip())
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        if c == DOUBLE_OPEN or (c == '"' and _ch(line, i - 1) in _OPEN_BEFORE and _ch(line, i + 1) and
                                not _ch(line, i + 1).isspace()):
            close = DOUBLE_CLOSE if c == DOUBLE_OPEN else '"'
            j = line.find(close, i + 1)
            if c == DOUBLE_OPEN and j < 0:
                j2 = line.find('"', i + 1)
                j = j2
            if j < 0:
                if i == first:                  # a speech carried on into the next paragraph
                    out.append(Quote(text, a + i, a + len(line.rstrip()), a + i + 1, a + len(line.rstrip()), "double"))
                    return
                i += 1
                continue
            out.append(Quote(text, a + i, a + j + 1, a + i + 1, a + j, "double"))
            i = j + 1
            continue
        if c in ("'", SINGLE_OPEN) and _is_single_open(line, i):
            j = i + 1
            found = -1
            while j < n:
                d = line[j]
                if d in ("'", SINGLE_CLOSE) and _is_single_close(line, j):
                    found = j
                    break
                j += 1
            if found < 0:
                if i == first:
                    end = len(line.rstrip())
                    out.append(Quote(text, a + i, a + end, a + i + 1, a + end, "single"))
                    return
                i += 1
                continue
            out.append(Quote(text, a + i, a + found + 1, a + i + 1, a + found, "single"))
            i = found + 1
            continue
        i += 1


def finditer(text: str) -> list[Quote]:
    """Every quote of ``text`` in order (outermost only: a quote inside a quote is part of it)."""
    text = text or ""
    out: list[Quote] = []
    pos = 0
    for m in _PARA.finditer(text):
        _line_quotes(text, pos, m.start(), out)
        pos = m.end()
    _line_quotes(text, pos, len(text), out)
    return out


def spans(text: str) -> list[tuple[int, int]]:
    return [q.span() for q in finditer(text)]


def quotes(text: str) -> list[str]:
    """The quotes with their marks, in order."""
    return [q.group(0) for q in finditer(text)]


def inside(text: str) -> list[str]:
    """The words inside each quote, in order."""
    return [q.group(1) for q in finditer(text)]


def has_dialogue(text: str) -> bool:
    return bool(finditer(text))


def narration(text: str, repl: str = " ") -> str:
    """``text`` with every quote replaced by ``repl`` (the narration only)."""
    text = text or ""
    out, pos = [], 0
    for q in finditer(text):
        out.append(text[pos:q.start()])
        out.append(repl)
        pos = q.end()
    out.append(text[pos:])
    return "".join(out)


def mask(text: str, fill: str = " ") -> str:
    """``text`` with every quote blanked out character for character (same length: offsets still match)."""
    chars = list(text or "")
    for a, b in spans(text):
        chars[a:b] = fill * (b - a)
    return "".join(chars)


def words_inside(text: str) -> int:
    return sum(len(re.findall(r"[A-Za-z0-9’']+", q)) for q in inside(text))


def starts_with_dialogue(sentence: str) -> bool:
    """Does this sentence (or line) start with speech? (a quote mark that opens a quote, or a dialogue dash)"""
    s = (sentence or "").lstrip()
    if not s:
        return False
    if s[0] in (DOUBLE_OPEN, '"', SINGLE_OPEN) or _DASH_LINE.match(s):
        return True
    if s[0] == "'":
        return _is_single_open(s, 0)
    return False


def _norm(q: str) -> str:
    q = q.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    return " ".join(q.split())


def same_dialogue(old: str, new: str) -> bool:
    """True when every line of dialogue of ``old`` is in ``new`` word for word, the same number of times, and
    ``new`` has no other (curly / straight marks and spacing do not count as a change)."""
    return Counter(_norm(q) for q in quotes(old)) == Counter(_norm(q) for q in quotes(new))


def style(text: str) -> str | None:
    """The dialogue style a text mostly uses: "double", "single", "dash" or None (no dialogue)."""
    c = Counter(q.kind for q in finditer(text))
    return c.most_common(1)[0][0] if c else None


class _Finder:
    """A drop-in for the old quote regexes (``finditer``, ``findall``, ``search``, ``sub``) so every check uses this
    one finder."""

    @staticmethod
    def finditer(text: str):
        return iter(finditer(text))

    @staticmethod
    def findall(text: str) -> list[str]:
        return quotes(text)

    @staticmethod
    def search(text: str):
        found = finditer(text)
        return found[0] if found else None

    @staticmethod
    def sub(repl: str, text: str) -> str:
        return narration(text, repl)


FINDER = _Finder()
