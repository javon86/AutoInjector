"""Who is this name? One shared, deterministic matcher for people's names (no AI).

The book's main character must be found again whatever the spelling: an AI that corrects "Odile" to "Odille", drops
an accent ("Odíle", Yoruba "Ọlá" / "Ola"), writes "O. Marsh", "odile-marsh", "Captain Odile Marsh" or "Odile's", or a
nickname from the character's dossier. Everything in the pipeline that links a name to a character (the idea's main
character, outline POV IDs and names, scene cards, chapter POV checks, the protagonist guard, canon resolution of a
name-like ID, the Book Bible's relationship-map centre) uses these rules:

* ``normalize`` — casefold, strip accents and diacritics (any combining mark, incl. Yoruba under-dots and tones),
  drop possessives ('s), punctuation, hyphens/underscores (IDs), and titles (Captain, Dr, Lady, Chief, …).
* ``score`` — how sure two names are the same person: exact (1.0) > initials ("O. Marsh", 0.9) > a part of the name
  (given or family name alone, 0.8) > close spelling (each word within an edit distance of 1, or 2 for words of 8+
  letters; a 3-letter word next to an exact one, 0.7) > close spelling of a part (0.6). A place word (Harbour, Street, …) that the person's name does not
  carry means "not this person" (0.0).
* ``match`` — the ONE candidate a name means: the best score must be clearly ahead of the next one (two characters
  with close names, e.g. "Odile" and "Odette", never auto-match a spelling between them; an exact match always wins)
  and the name must not be a place's or group's name.
"""
from __future__ import annotations

import re
import unicodedata

TITLES = frozenset("""captain capt cpt dr doctor lady lord sir dame mr mrs ms miss mx madam madame mme monsieur m
professor prof inspector detective sergeant sgt officer agent chief king queen prince princess saint st sr jr
aunt auntie uncle reverend rev father fr sister brother master mistress commander general colonel major lieutenant
lt admiral judge mayor oba olori iya baba alhaji alhaja mama papa""".split())
# Words that mark a place, building, group or thing (never part of a person's name in a match).
PLACE_WORDS = frozenset("""harbor harbour street bay reef island isle islands isles city port river mount mountain
mountains sea ocean kingdom empire lighthouse ferry station road lane bridge castle tower forest valley coast academy
school college university company guild council church abbey market square gate quay docks canal cove village county
republic federation society inn tavern hotel museum library point house hall district quarter province state line
railway avenue""".split())
EXACT, INITIALS, PART, FUZZY, FUZZY_PART = 1.0, 0.9, 0.8, 0.7, 0.6
THRESHOLD = 0.6
MAX_WORDS = 6  # a longer text is not a name
MARGIN = 0.1


def strip_accents(s: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFKD", str(s or "")) if not unicodedata.combining(ch))


def tokens(s, *, keep_titles: bool = False) -> list[str]:
    """The words of a name, normalised (see the module doc). "Captain Odíle Marsh's" -> ["odile", "marsh"]."""
    t = strip_accents(s).casefold().replace("’", "'")
    t = re.sub(r"'s\b", "", t)
    words = [w for w in re.split(r"[^0-9a-z]+", t) if w]
    if not keep_titles:
        kept = [w for w in words if w not in TITLES]
        words = kept or words  # a name that is only a title ("the Captain") keeps it
    return words


def normalize(s) -> str:
    return " ".join(tokens(s))


def edit_distance(a: str, b: str, cap: int = 3) -> int:
    """Levenshtein distance with adjacent transpositions, stopped early above ``cap``."""
    if a == b:
        return 0
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev2, prev = None, list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
            if prev2 is not None and i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        if min(cur) > cap:
            return cap + 1
        prev2, prev = prev, cur
    return prev[-1]


def allowed_typos(word: str) -> int:
    n = len(word)
    return 0 if n < 4 else 1 if n < 8 else 2


def close(a: str, b: str) -> bool:
    """Two words that are the same word spelled a little differently ("odile" / "odille")."""
    if a == b:
        return True
    k = min(allowed_typos(a), allowed_typos(b))
    return k > 0 and a[0] == b[0] and edit_distance(a, b, k) <= k


def _initials_match(q: list[str], c: list[str]) -> bool:
    """"o marsh" vs "odile marsh": same number of words, each equal or the initial of the other, at least one whole."""
    if len(q) != len(c) or len(q) < 2:
        return False
    whole = 0
    for a, b in zip(q, c):
        if a == b:
            whole += 1
        elif not ((len(a) == 1 and b.startswith(a)) or (len(b) == 1 and a.startswith(b))):
            return False
    return whole >= 1


def _sub_match(q: list[str], c: list[str], same) -> bool:
    """Every word of q matches a different word of c (q is a part of c, e.g. the given or family name alone)."""
    if not q or len(q) > len(c):
        return False
    left = list(c)
    for w in q:
        hit = next((x for x in left if same(w, x)), None)
        if hit is None:
            return False
        left.remove(hit)
    return True


def score(a, b) -> float:
    """How sure the names ``a`` and ``b`` mean the same person (0.0 .. 1.0); symmetric."""
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    if max(len(ta), len(tb)) > MAX_WORDS:  # a sentence, not a name
        return EXACT if ta == tb else 0.0
    pa, pb = set(ta) & PLACE_WORDS, set(tb) & PLACE_WORDS
    if pa != pb:
        return 0.0  # "Marsh Harbour" is a place, not "Odile Marsh"
    if ta == tb:
        return EXACT
    if _initials_match(ta, tb):
        return INITIALS
    short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    eq = lambda x, y: x == y  # noqa: E731
    if len(short) < len(long_) and _sub_match(short, long_, eq) and any(len(w) >= 3 for w in short):
        return PART
    if len(ta) == len(tb) and all(close(x, y) for x, y in zip(ta, tb)):
        return FUZZY
    if len(ta) == len(tb) >= 2 and any(x == y and len(x) >= 3 for x, y in zip(ta, tb)) and \
            sum(x != y for x, y in zip(ta, tb)) == 1 and \
            all(x == y or close(x, y) or (min(len(x), len(y)) >= 3 and x[0] == y[0] and edit_distance(x, y, 1) <= 1)
                for x, y in zip(ta, tb)):
        return FUZZY  # one short word misspelled next to an exact one ("mara-vel" / "Mara Vell")
    if len(short) < len(long_) and _sub_match(short, long_, close) and any(len(w) >= 4 for w in short):
        return FUZZY_PART
    if len(ta) == len(tb) and _sub_match(ta, tb, close):  # same words in another order ("Marsh Odile")
        return FUZZY
    return 0.0


def same_person(a, b, threshold: float = THRESHOLD) -> bool:
    return score(a, b) >= threshold


def best_score(query, names) -> float:
    return max((score(query, n) for n in names or () if n), default=0.0)


def match(query, candidates, *, exclude=(), threshold: float = THRESHOLD, margin: float = MARGIN):
    """The ONE candidate ``query`` names, or None. ``candidates``: iterable of (key, [names / aliases / IDs]).
    ``exclude``: names of places, groups and things — a query that is (exactly) one of them names no person.
    The best candidate must reach ``threshold`` and be ``margin`` ahead of the next (an exact match is enough on its
    own when it is the only exact one)."""
    q = normalize(query)
    if not q:
        return None
    if any(normalize(x) == q for x in exclude or () if x):
        return None
    scored = sorted(((best_score(query, names), key) for key, names in candidates), key=lambda x: -x[0])
    scored = [s for s in scored if s[0] > 0]
    if not scored or scored[0][0] < threshold:
        return None
    top, key = scored[0]
    second = scored[1][0] if len(scored) > 1 else 0.0
    if top == EXACT and second < EXACT:
        return key
    if top - second < margin - 1e-9:
        return None
    return key


def id_names(ident) -> list[str]:
    """A name-like ID as a name: "odile-marsh" -> "odile marsh" (prefixes such as char-/a01- are kept as words)."""
    return [" ".join(w for w in re.split(r"[-_./\s]+", str(ident or "")) if w)]
