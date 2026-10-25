"""Text span anchoring and textual patch application (Shared Contract section 3).

Spans use Unicode code-point offsets [start, end) into the exact referenced text (Python
``str`` indexes are code points). Each span carries the SHA-256 of its exact substring and a
stable ``span_id`` that does not depend on offsets: it is derived from the owning record ID,
the substring hash and the occurrence index of that substring, so the same anchored text keeps
its ID after an unrelated rewrite moves it. Re-anchoring after a rewrite searches the new text
for the precondition substring; zero matches means the anchored text is gone (stale), more than
one match is ambiguous and blocks with SPAN_CONFLICT.

Used by Set F (anchored edit proposals), Set J (J09 passage impact, re-anchoring) and by the C
owner when it converts accepted F patches into a C replacement candidate (``build_replacement``).
"""
from __future__ import annotations

from .canonical import sha256_text
from .errors import AkoweError

TEXT_PATH = "/text"


def occurrences(text: str, needle: str) -> list[int]:
    """All (possibly overlapping) start offsets of needle in text."""
    if needle == "":
        return []
    out, i = [], text.find(needle)
    while i != -1:
        out.append(i)
        i = text.find(needle, i + 1)
    return out


def span_id_for(record_id: str, text: str, start: int, end: int) -> str:
    sub = text[start:end]
    idx = occurrences(text, sub).index(start) if sub else start
    return "sp-" + sha256_text(f"{record_id}\x1f{sha256_text(sub)}\x1f{idx}")[:20]


def make_span(record: dict, start: int, end: int, span_id: str | None = None) -> dict:
    """Evidence span for record (a stored C prose record with data.text)."""
    text = record_text(record)
    if not (0 <= start <= end <= len(text)):
        raise AkoweError("SPAN_CONFLICT", "", f"span [{start},{end}) outside text of length {len(text)}",
                             status="REJECTED")
    return {"record_ref": record["ref"], "span_id": span_id or span_id_for(record["record_id"], text, start, end),
            "start": start, "end": end, "text_hash": sha256_text(text[start:end])}


def record_text(record: dict) -> str:
    data = record.get("data") if record else None
    if not isinstance(data, dict) or not isinstance(data.get("text"), str):
        raise AkoweError("INVALID_INPUT", "/payload/manuscript_ref",
                             "referenced record has no prose text (data.text)", status="REJECTED")
    return data["text"]


def verify_span(text: str, span: dict) -> str | None:
    """None when the span matches text exactly, else a reason string."""
    s, e = span.get("start"), span.get("end")
    if not isinstance(s, int) or not isinstance(e, int) or not (0 <= s <= e <= len(text)):
        return f"span [{s},{e}) outside text of length {len(text)}"
    if sha256_text(text[s:e]) != span.get("text_hash"):
        return f"text_hash does not match substring [{s},{e})"
    return None


def reanchor(old_text: str, new_text: str, span: dict) -> dict:
    """Re-anchor span from old_text into new_text by its precondition substring.

    Returns the moved span (same span_id/text_hash). Raises SPAN_CONFLICT when ambiguous and
    VERSION_CONFLICT when the anchored text no longer exists.
    """
    reason = verify_span(old_text, span)
    if reason:
        raise AkoweError("HASH_MISMATCH", "", f"span {span.get('span_id')}: {reason}", status="REJECTED")
    pre = old_text[span["start"]:span["end"]]
    if pre == "":
        raise AkoweError("SPAN_CONFLICT", "", f"span {span['span_id']}: empty anchors cannot be re-anchored",
                             status="BLOCKED")
    hits = occurrences(new_text, pre)
    if not hits:
        raise AkoweError("VERSION_CONFLICT", "", f"span {span['span_id']}: anchored text no longer present",
                             status="REJECTED")
    if len(hits) > 1:
        raise AkoweError("SPAN_CONFLICT", "", f"span {span['span_id']}: anchored text matches {len(hits)} "
                             "places in the new revision", status="BLOCKED")
    out = dict(span)
    out["start"], out["end"] = hits[0], hits[0] + len(pre)
    return out


def spans_overlap(a: tuple[int, int], b: tuple[int, int]) -> bool:
    """Half-open overlap; two insertions at one point are also ambiguous (overlap)."""
    (s1, e1), (s2, e2) = a, b
    if s1 == e1 == s2 == e2:
        return True
    return s1 < e2 and s2 < e1


def find_overlaps(items: list[tuple[str, int, int]]) -> list[tuple[str, str]]:
    """items: (id, start, end). Returns overlapping id pairs, deterministic order."""
    srt = sorted(items, key=lambda x: (x[1], x[2], x[0]))
    out = []
    for i, a in enumerate(srt):
        for b in srt[i + 1:]:
            if b[1] > a[2] and not (a[1] == a[2] == b[1]):
                break
            if spans_overlap((a[1], a[2]), (b[1], b[2])):
                out.append((a[0], b[0]))
    return out


def apply_edits(text: str, edits: list[tuple[int, int, str]]) -> tuple[str, list[dict]]:
    """Apply non-overlapping [start,end)->replacement edits; returns (new_text, inverse).

    inverse items {start,end,text} address the NEW text and restore the old substring, so
    compensation can restore the source only while no intervening revision exists.
    """
    pairs = find_overlaps([(str(i), s, e) for i, (s, e, _) in enumerate(edits)])
    if pairs:
        raise AkoweError("PATCH_OVERLAP", "", f"overlapping edits {pairs[0]}", status="REJECTED")
    out, inverse, cursor, delta = [], [], 0, 0
    for s, e, rep in sorted(edits, key=lambda x: (x[0], x[1])):
        out.append(text[cursor:s])
        out.append(rep)
        inverse.append({"start": s + delta, "end": s + delta + len(rep), "text": text[s:e]})
        delta += len(rep) - (e - s)
        cursor = e
    out.append(text[cursor:])
    return "".join(out), inverse


def anchored_patches(data: dict) -> list[tuple[dict, dict]]:
    """Pair every textual patch in an F/J output with its anchoring evidence span.

    Convention: a textual patch has path "/text" and patch_id equal to the span_id of exactly one
    evidence span in the same record's findings, whose record_ref equals the patch target_ref.
    Raises SPAN_CONFLICT when the anchor is missing or ambiguous.
    """
    spans: dict[str, list[dict]] = {}
    for f in data.get("findings", []):
        for ev in f.get("evidence", []):
            spans.setdefault(ev["span_id"], []).append(ev)
    out = []
    for i, p in enumerate(data.get("patches", []) or data.get("patch_proposals", []) or []):
        if p["path"] != TEXT_PATH:
            continue
        cands = [ev for ev in spans.get(p["patch_id"], []) if _same_pin(ev["record_ref"], p["target_ref"])]
        uniq = {(ev["start"], ev["end"], ev["text_hash"]) for ev in cands}
        if len(uniq) != 1:
            raise AkoweError("SPAN_CONFLICT", f"/patches/{i}",
                                 f"patch {p['patch_id']} has {len(uniq)} anchoring spans (need exactly one)",
                                 status="REJECTED")
        if not isinstance(p["replacement"], str):
            raise AkoweError("INVALID_INPUT", f"/patches/{i}/replacement", "textual patch needs a string",
                                 status="REJECTED")
        out.append((p, cands[0]))
    return out


def _same_pin(a: dict, b: dict) -> bool:
    return (a["record_id"], a["version"], a["content_hash"]) == (b["record_id"], b["version"], b["content_hash"])


def build_replacement(manuscript: dict, proposals: list[dict]) -> dict:
    """C-owner helper: merge accepted F proposals into one replacement candidate.

    manuscript: the exact stored C prose record every patch targets. proposals: stored F/J
    records (data with findings/patches). Verifies every anchor against the exact text,
    rejects stale pins (VERSION_CONFLICT) and overlaps across editors (PATCH_OVERLAP), and
    returns {text, inverse, applied:[patch ids], precondition_hash, source_refs}. The C owner
    then submits {text, candidate_events: [], findings: []} as UPDATE/C11 replacement against
    the same base pin and accepts it atomically; inverse is retained for compensation.
    """
    text = record_text(manuscript)
    edits, ids, items = [], [], []
    for rec in proposals:
        for p, ev in anchored_patches(rec["data"]):
            if not _same_pin(p["target_ref"], manuscript["ref"]):
                raise AkoweError("VERSION_CONFLICT", "/target_ref",
                                     f"patch {p['patch_id']} pins {p['target_ref']['record_id']} "
                                     f"v{p['target_ref']['version']}, not the current manuscript", status="REJECTED")
            reason = verify_span(text, ev)
            if reason:
                raise AkoweError("HASH_MISMATCH", "/target_ref", f"patch {p['patch_id']}: {reason}",
                                     status="REJECTED")
            key = f"{rec['record_id']}:{p['patch_id']}"
            items.append((key, ev["start"], ev["end"]))
            edits.append((ev["start"], ev["end"], p["replacement"]))
            ids.append(key)
    pairs = find_overlaps(items)
    if pairs:
        raise AkoweError("PATCH_OVERLAP", "", f"overlapping proposals {pairs[0][0]} and {pairs[0][1]}; "
                             "queue merge/review instead of choosing the last writer", status="REJECTED")
    new_text, inverse = apply_edits(text, edits)
    return {"text": new_text, "inverse": inverse, "applied": ids, "precondition_hash": sha256_text(text),
            "source_refs": [manuscript["ref"]] + [r["ref"] for r in proposals]}
