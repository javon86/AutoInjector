"""Deterministic E state projection (Shared Contract section 10).

E state is the SemanticRecord snapshot facts indexed by (subject_id, predicate, effective
interval). Typed events address exactly one entity and resolve their path through
predicate_registry.event_paths. Events are applied in (story_time, scene_order, event_order,
event_id) order:

* SET replaces the named scalar/list; ``before`` must equal the projected value exactly.
* ADD appends exactly one scalar item that was absent; REMOVE removes exactly one present item;
  both need a known prior list equal to ``before`` and keep every other item unchanged.
* A missing prior value is unknown (null): it satisfies only before=null and never a known
  before; list membership changes on an unknown list are refused.
* A change at or before the instant the current value was established is a chronology
  conflict (no zero-length or overlapping intervals are ever produced).

The applied change closes the current fact at story_time and opens [story_time, old_to) with
the event's prose pin as source. Failures are returned as (rule_id, message) and leave the
projection untouched, so no invalid state is committed.
"""
from __future__ import annotations

import copy

from .canonical import canonical_bytes

NEG_INF = float("-inf")


def same(a, b) -> bool:
    """Typed JSON equality via canonical bytes (1, 1.0 and true are different values)."""
    return canonical_bytes(a) == canonical_bytes(b)


def sort_key(ev: dict) -> tuple:
    return (ev["story_time"], ev["scene_order"], ev["event_order"], ev["event_id"])


def event_body(ev: dict) -> dict:
    """Event content without its status (status is the owner's disposition, not content)."""
    return {k: v for k, v in ev.items() if k != "status"}


def check_value(value, spec: dict | None) -> str | None:
    """Validate a value against a predicate_registry entry; returns an error message or None."""
    if not spec:
        return None
    if "enum" in spec:
        return None if any(same(value, e) for e in spec["enum"]) else f"value must be one of {spec['enum']}"
    types = spec.get("type")
    types = types if isinstance(types, list) else [types]

    def is_type(v, t):
        if t == "string":
            return isinstance(v, str)
        if t == "number":
            return isinstance(v, (int, float)) and not isinstance(v, bool)
        if t == "integer":
            return isinstance(v, int) and not isinstance(v, bool)
        if t == "boolean":
            return isinstance(v, bool)
        if t == "null":
            return v is None
        if t == "array":
            return isinstance(v, list)
        return True
    if not any(is_type(value, t) for t in types if t):
        return f"value must be {spec.get('type')}"
    if isinstance(value, list):
        item_t = spec.get("items")
        if item_t and not all(is_type(x, item_t) for x in value):
            return f"list items must be {item_t}"
        if len({canonical_bytes(x) for x in value}) != len(value):
            return "list items must be unique"
    if "minimum" in spec and isinstance(value, (int, float)) and not isinstance(value, bool) and value < spec["minimum"]:
        return f"value must be >= {spec['minimum']}"
    return None


def _from(f) -> float:
    return NEG_INF if f["effective_from"] is None else f["effective_from"]


def fact_sort_key(f: dict) -> tuple:
    return (f["subject_id"], f["predicate"], _from(f), canonical_bytes(f["value"]))


def overlaps(facts: list[dict]) -> list[tuple[str, str]]:
    """(subject, predicate) pairs whose FACT intervals overlap (the index must be a partition)."""
    groups: dict[tuple, list] = {}
    for f in facts:
        if f["assertion_type"] == "FACT":
            groups.setdefault((f["subject_id"], f["predicate"]), []).append(f)
    bad = []
    for key, fs in sorted(groups.items()):
        fs = sorted(fs, key=_from)
        for a, b in zip(fs, fs[1:]):
            if a["effective_to"] is None or b["effective_from"] is None or a["effective_to"] > b["effective_from"]:
                bad.append(key)
                break
    return bad


class Projection:
    def __init__(self, facts: list[dict]):
        self.facts = [copy.deepcopy(f) for f in facts]

    def _series(self, subject: str, predicate: str) -> list[dict]:
        return [f for f in self.facts if f["subject_id"] == subject and f["predicate"] == predicate
                and f["assertion_type"] == "FACT"]

    def containing(self, subject: str, predicate: str, t: int) -> list[dict]:
        return [f for f in self._series(subject, predicate)
                if _from(f) <= t and (f["effective_to"] is None or f["effective_to"] > t)]

    def value_at(self, subject: str, predicate: str, t: int):
        hits = self.containing(subject, predicate, t)
        return hits[0]["value"] if len(hits) == 1 else None

    def apply(self, ev: dict, predicate: str, spec: dict | None) -> tuple[str, str] | None:
        subject, t = ev["entity_ids"][0], ev["story_time"]
        hits = self.containing(subject, predicate, t)
        if len(hits) > 1:
            return "STATE_CONFLICT", f"{subject} {predicate} has overlapping values at {t}"
        cur = hits[0] if hits else None
        if cur is not None and cur["effective_from"] is not None and cur["effective_from"] >= t:
            return ("CHRONOLOGY", f"{ev['event_id']} at story_time {t} does not follow the change that established "
                    f"{subject} {predicate} at {cur['effective_from']}; replay in chronological order")
        cur_val = cur["value"] if cur else None
        before, after, op = ev["before"], ev["after"], ev["operation"]
        if op == "SET":
            if not same(before, cur_val):
                return "BEFORE_MISMATCH", (f"{ev['event_id']} before={before!r} does not match projected "
                                           f"{'unknown (null)' if cur is None else repr(cur_val)}")
        else:
            if spec is not None and spec.get("type") != "array":
                return "INVALID_OPERATION", f"{op} applies only to list predicates, not {predicate}"
            if cur is None or not isinstance(cur_val, list):
                return "UNKNOWN_PRIOR", f"{op} needs a known prior list for {subject} {predicate}; prior is unknown"
            if not same(before, cur_val):
                return "BEFORE_MISMATCH", f"{ev['event_id']} before={before!r} does not match projected {cur_val!r}"
            if not isinstance(after, list):
                return "INVALID_VALUE", f"{op} after must be the full new list"
            keys = [canonical_bytes(x) for x in before]
            if op == "ADD":
                ok = (len(after) == len(before) + 1 and same(after[:-1], before)
                      and canonical_bytes(after[-1]) not in keys and not isinstance(after[-1], list))
                if not ok:
                    return "INVALID_OPERATION", "ADD must append exactly one absent scalar item and keep the others"
            else:
                ok = len(after) == len(before) - 1 and any(same(before[:i] + before[i + 1:], after)
                                                          for i in range(len(before)))
                if not ok:
                    return "INVALID_OPERATION", "REMOVE must remove exactly one present item and keep the others"
        err = check_value(after, spec)
        if err:
            label = "NEGATIVE_VALUE" if "must be >=" in err else "INVALID_VALUE"
            return label, f"{ev['event_id']} after: {err}"
        if cur is not None:
            end = cur["effective_to"]
            cur["effective_to"] = t
        else:
            later = [f["effective_from"] for f in self._series(subject, predicate)
                     if f["effective_from"] is not None and f["effective_from"] > t]
            end = min(later) if later else None
        self.facts.append({"subject_id": subject, "predicate": predicate, "value": copy.deepcopy(after),
                           "assertion_type": "FACT", "effective_from": t, "effective_to": end,
                           "source_refs": [ev["source_ref"]]})
        return None

    def sorted_facts(self) -> list[dict]:
        return sorted(self.facts, key=fact_sort_key)
