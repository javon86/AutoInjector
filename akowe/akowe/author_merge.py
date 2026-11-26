"""✍ R1: the author's typing always wins over an AI answer that arrives later.

A step reads a record, waits (sometimes minutes) for the AI, then saves the AI's answer. Anything the author typed
into that record meanwhile must never be replaced. The pattern used by the steps that write the author-editable
records (book profile, character sheet, story rules, world texture):

* remember what the record looked like before the AI call;
* re-read it inside the save (same transaction / lock as the write);
* a field the author changed since (or had typed before) keeps the author's value; the AI fills only the rest.

Pure helpers here; each record's own module does the re-read inside its own save.
"""
from __future__ import annotations

# book profile fields the author can type in the book profile form (``_s_profile`` merges the AI's over the rest)
PROFILE_KEYS = ("title", "idea", "genre", "audience", "tone", "author", "pov", "tense")
# fields whose non-empty value before the AI call can only be the author's (the AI step writes them together)
PROFILE_OWN_BEFORE = ("title", "idea")

WORDS = {"title": "title", "idea": "idea", "genre": "genre", "audience": "audience", "tone": "tone",
         "author": "pen name", "pov": "point of view", "tense": "tense"}


def _filled(v) -> bool:
    return isinstance(v, str) and bool(v.strip()) or (v is not None and not isinstance(v, str) and bool(v))


def keep_typed(before: dict | None, now: dict | None, ai: dict, keys=PROFILE_KEYS,
               own_before=PROFILE_OWN_BEFORE) -> list[str]:
    """Put the author's values back into ``ai`` (in place) for every key the author typed: changed since ``before``
    (read before the AI call) or, for ``own_before`` keys, already filled before. Returns the keys kept."""
    before, now = before or {}, now or {}
    kept = []
    for k in keys:
        v = now.get(k)
        if not _filled(v):
            continue
        if v != before.get(k) or (k in own_before and _filled(before.get(k))):
            if ai.get(k) != v:
                kept.append(k)
            ai[k] = v
    return kept


def words(keys) -> str:
    """'title and idea' — plain names of the kept fields (no ids)."""
    names = [WORDS.get(k, str(k).replace("_", " ")) for k in keys]
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def merge_fields(author: dict | None, ai: dict | None) -> dict:
    """The author's non-empty fields win; the AI fills only what the author left empty."""
    out = dict(ai or {})
    for k, v in (author or {}).items():
        if _filled(v):
            out[k] = v
    return out
