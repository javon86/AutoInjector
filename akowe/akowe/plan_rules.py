"""Deterministic SemanticRecord and plan-item rules shared by Sets A and B.

Shared Contract sections 3, 4 and 10: facts are typed subject/predicate/value assertions
with half-open effective intervals; canonical predicates come from
Contracts/predicate_registry.json. Plan items (B04-B12) carry plan.item_id == subject_id,
a unique plan.order within plan.parent_id and plan.objective; chapters/scenes also declare
plan.event_ids, plan.pov_id, plan.location_id and plan.obligation_ids.

The functions here never raise; they report issues through an ``add(rule_id, message,
severity, decision, source_refs=None)`` callback so handlers can turn them into findings.

OWNER_EXTENSIONS lists the A/B-owned ``x.*`` predicates these modules check
automatically. Each entry has an immutable type, unit/meaning and owner as section 10
requires; any other extension (or unregistered predicate) yields UNKNOWN for review.
"""
from __future__ import annotations

import re

from typing import Callable, Iterable, Iterator

Add = Callable[..., None]

# Owner-registered extensions (immutable once published; see module docstring).
OWNER_EXTENSIONS: dict[str, dict] = {
    "x.a04.parent_id": {"type": ["string", "null"], "owner": "A04",
                        "meaning": "stable ID of the containing A04 location; null is a root"},
    "x.a04.coordinates": {"type": "array", "items": "number", "owner": "A04",
                          "meaning": "position; unit given by x.a04.coordinate_unit of the same subject"},
    "x.a04.coordinate_unit": {"type": "string", "owner": "A04", "meaning": "unit of x.a04.coordinates"},
    "x.a06.member_ids": {"type": "array", "items": "string", "owner": "A06",
                         "meaning": "stable A01/A06 IDs that are members of the organization"},
    "x.a09.cost": {"type": ["string", "number"], "owner": "A09", "meaning": "stated cost of using a power"},
    "x.a09.limit": {"type": ["string", "number"], "owner": "A09", "meaning": "stated hard limit of a power"},
    "x.a13.participant_ids": {"type": "array", "items": "string", "owner": "A13",
                              "meaning": "stable A01/A06 IDs participating in a historical event"},
    "x.a13.cause_ids": {"type": "array", "items": "string", "owner": "A13",
                        "meaning": "historical event IDs that causally precede this event"},
    "x.a14.chronological_index": {"type": "integer", "minimum": 0, "owner": "A14",
                                  "meaning": "position after sorting by (time, event ID)"},
    "x.a16.unit": {"type": "string", "owner": "A16", "meaning": "explicit unit of the subject's numeric values"},
    "x.a17.jurisdiction_id": {"type": "string", "owner": "A17", "meaning": "stable A05 jurisdiction ID"},
    "x.a18.endpoint_ids": {"type": "array", "items": "string", "owner": "A18",
                           "meaning": "stable A01/A06 IDs joined by the relationship (two or more)"},
    "x.b13.min_events": {"type": "integer", "minimum": 0, "owner": "B13", "unit": "events per chapter"},
    "x.b13.max_events": {"type": "integer", "minimum": 0, "owner": "B13", "unit": "events per chapter"},
    "x.b13.min_scenes": {"type": "integer", "minimum": 0, "owner": "B13", "unit": "scenes per chapter"},
    "x.b13.max_scenes": {"type": "integer", "minimum": 0, "owner": "B13", "unit": "scenes per chapter"},
}

# Predicates whose values name entities governed by linked canon (section 4 "linked canon
# authority"): value IDs must be declared by a pinned record of one of these modules.
AUTHORITY: dict[str, tuple[str, ...]] = {
    "entity.location_id": ("A04",),
    "entity.inventory_ids": ("A12",),
    "entity.relationship_ids": ("A18",),
    "x.a04.parent_id": ("A04",),
    "x.a06.member_ids": ("A01", "A06"),
    "x.a13.participant_ids": ("A01", "A06"),
    "x.a17.jurisdiction_id": ("A05",),
    "x.a18.endpoint_ids": ("A01", "A06"),
}

PLAN_BASE = ("plan.item_id", "plan.order", "plan.objective")
PLAN_UNIT = ("plan.event_ids", "plan.pov_id", "plan.location_id", "plan.obligation_ids")


# ---------------------------------------------------------------------- basic fact helpers
def is_fact(obj) -> bool:
    return isinstance(obj, dict) and {"subject_id", "predicate", "assertion_type"} <= set(obj)


def iter_facts(data, path: str = "") -> Iterator[tuple[str, dict]]:
    """Yield (json_pointer, fact) for every SemanticRecord fact anywhere inside data."""
    if is_fact(data):
        yield path, data
        return
    if isinstance(data, dict):
        for k, v in data.items():
            yield from iter_facts(v, f"{path}/{k}")
    elif isinstance(data, list):
        for i, v in enumerate(data):
            yield from iter_facts(v, f"{path}/{i}")


def interval_ok(fact: dict) -> bool:
    frm, to = fact.get("effective_from"), fact.get("effective_to")
    return frm is None or to is None or to > frm


def overlaps(a: dict, b: dict) -> bool:
    """Half-open [from,to) intervals with null meaning unbounded."""
    a0, a1 = a.get("effective_from"), a.get("effective_to")
    b0, b1 = b.get("effective_from"), b.get("effective_to")
    lo_ok = a1 is None or b0 is None or b0 < a1
    hi_ok = b1 is None or a0 is None or a0 < b1
    return lo_ok and hi_ok


def as_list(value) -> list:
    if value is None:
        return []
    return list(value) if isinstance(value, list) else [value]


def predicate_spec(registry: dict, predicate: str) -> dict | None:
    return (registry.get("predicates") or {}).get(predicate) or OWNER_EXTENSIONS.get(predicate)


def _type_ok(t, value) -> bool:
    if isinstance(t, list):
        return any(_type_ok(x, value) for x in t)
    if t == "null":
        return value is None
    if t == "string":
        return isinstance(value, str)
    if t == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if t == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if t == "boolean":
        return isinstance(value, bool)
    if t == "array":
        return isinstance(value, list)
    return False


def value_ok(spec: dict, value) -> str | None:
    """Return a problem description when value violates the registered spec, else None."""
    if "enum" in spec:
        return None if value in spec["enum"] else f"value must be one of {spec['enum']}"
    t = spec.get("type")
    if t is not None and not _type_ok(t, value):
        return f"value must have type {t}"
    if t == "array":
        item_t = spec.get("items")
        if item_t and not all(_type_ok(item_t, v) for v in value):
            return f"every list item must have type {item_t}"
        if spec.get("items") == "string" and len(set(value)) != len(value):
            return "list items must be unique stable IDs"
    if "minimum" in spec and isinstance(value, (int, float)) and not isinstance(value, bool):
        if value < spec["minimum"]:
            return f"value must be >= {spec['minimum']}"
    return None


# ---------------------------------------------------------------------- generic fact checks
def check_facts(facts: Iterable[tuple[str, dict]], registry: dict, add: Add, *, where: str = "") -> None:
    """Interval, registered type, unregistered predicate and contradiction checks."""
    facts = list(facts)
    unregistered: dict[str, list[str]] = {}
    for ptr, f in facts:
        if not interval_ok(f):
            add("FACT_INTERVAL", f"{where}{ptr}: effective_to must be greater than effective_from "
                "(half-open interval)", "BLOCKING", "FAIL")
        spec = predicate_spec(registry, f["predicate"])
        if spec is None:
            unregistered.setdefault(f["predicate"], []).append(where + ptr)
            continue
        if f["assertion_type"] == "UNKNOWN":
            continue  # an unknown assertion carries no checkable value
        problem = value_ok(spec, f.get("value"))
        if problem:
            add("PREDICATE_TYPE", f"{where}{ptr}: {f['predicate']} {problem}", "BLOCKING", "FAIL")
    for pred, ptrs in sorted(unregistered.items()):
        kind = "unregistered extension" if pred.startswith("x.") else "unregistered predicate"
        add("PREDICATE_UNREGISTERED", f"{kind} '{pred}' at {', '.join(ptrs[:5])}: no registered type/unit/"
            "meaning/owner, so automatic consumers treat it as UNKNOWN; review or register it", "MAJOR", "UNKNOWN")
    # Contradiction: same subject/predicate asserted with different values over overlapping time.
    by_key: dict[tuple, list] = {}
    for ptr, f in facts:
        if f["assertion_type"] in ("FACT", "PLAN"):
            by_key.setdefault((f["subject_id"], f["predicate"], f["assertion_type"]), []).append((ptr, f))
    for (subj, pred, kind), items in by_key.items():
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                (p1, f1), (p2, f2) = items[i], items[j]
                if f1.get("value") != f2.get("value") and overlaps(f1, f2):
                    add("FACT_CONTRADICTION", f"{where}{p1} and {where}{p2}: {kind} {subj} {pred} has different "
                        "values over overlapping effective intervals", "BLOCKING", "FAIL")


def declared_ids(record: dict) -> set[str]:
    """Stable entity IDs a stored record declares: its record ID and its fact subjects."""
    ids = {record["record_id"]}
    for _, f in iter_facts(record.get("data")):
        ids.add(f["subject_id"])
    return ids


def _slug_tokens(v) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", str(v or "").lower()) if t]


def resolve_entity_ids(data, canon: list[dict], governed: dict) -> list[str]:
    """Web AIs sometimes write a name-like ID ("odile-marsh") instead of the canon ID they were given. Map such a
    value to the ONE pinned canon record of the governing module whose name or declared ID matches it (same words,
    or the value's words are a part of the name, e.g. "odile" -> "Odile Marsh"); leave it alone when nothing or more
    than one record matches, so the canon check still refuses it. Changes ``data`` in place; returns notes."""
    notes = []
    by_module: dict = {}
    for r in canon:
        try:
            name = next((f["value"] for _, f in iter_facts(r.get("data"))
                         if f.get("predicate") == "entity.name" and isinstance(f.get("value"), str)), "")
        except Exception:  # noqa: BLE001 - a malformed record never breaks the check
            name = ""
        ids = declared_ids(r)
        subject = next((f["subject_id"] for _, f in iter_facts(r.get("data"))
                        if f.get("predicate") == "entity.name"), None) or r["record_id"]
        keys = [_slug_tokens(name)] + [_slug_tokens(i) for i in ids]
        by_module.setdefault(r["module_id"], []).append((subject, ids, [k for k in keys if k]))
    for ptr, f in iter_facts(data):
        modules = governed.get(f.get("predicate"))
        if not modules:
            continue
        cands = [c for m in modules for c in by_module.get(m, [])]
        known = set().union(*(c[1] for c in cands)) if cands else set()

        def fix(v):
            if not isinstance(v, str) or v in known:
                return v
            vt = _slug_tokens(v)
            if not vt:
                return v
            hits = {c[0] for c in cands for k in c[2] if vt == k or (set(vt) <= set(k) and len(vt) < len(k))}
            if len(hits) == 1:
                new = hits.pop()
                notes.append(f"{ptr}: {f['predicate']} '{v}' -> '{new}'")
                return new
            return v
        val = f.get("value")
        f["value"] = [fix(x) for x in val] if isinstance(val, list) else fix(val)
    return notes


# ---------------------------------------------------------------------- plan items
class PlanItem:
    __slots__ = ("index", "item_id", "facts", "record")

    def __init__(self, index: int, item_id: str, facts: dict, record: dict):
        self.index, self.item_id, self.facts, self.record = index, item_id, facts, record

    def get(self, predicate: str, default=None):
        f = self.facts.get(predicate)
        return default if f is None else f.get("value")

    def has(self, predicate: str) -> bool:
        return predicate in self.facts

    def time(self):
        """Story time of a planned event: effective_from of its plan.item_id fact (section 10)."""
        return self.facts["plan.item_id"].get("effective_from")


def plan_items(records: list, field: str, add: Add, *, unit: bool = False, events: bool = False) -> list[PlanItem]:
    """Extract and check plan items from a list of SemanticRecords (one item per record)."""
    items: list[PlanItem] = []
    seen_ids: dict[str, int] = {}
    orders: dict[tuple, str] = {}
    required = PLAN_BASE + (PLAN_UNIT if unit else ()) + (("plan.predecessor_ids",) if events else ())
    for i, rec in enumerate(records):
        where = f"/{field}/{i}"
        id_facts = [f for f in rec.get("facts", []) if f["predicate"] == "plan.item_id"]
        if not id_facts:
            add("PLAN_ITEM_ID", f"{where}: plan item lacks a plan.item_id fact (free prose summary does not "
                "establish machine values)", "BLOCKING", "FAIL")
            continue
        subjects = {f["subject_id"] for f in id_facts}
        if len(subjects) != 1:
            add("PLAN_ITEM_ID", f"{where}: one plan item per record; found item IDs {sorted(subjects)}",
                "BLOCKING", "FAIL")
            continue
        item_id = id_facts[0]["subject_id"]
        if any(f.get("value") != item_id for f in id_facts):
            add("PLAN_ITEM_ID", f"{where}: plan.item_id value must equal its subject_id '{item_id}'",
                "BLOCKING", "FAIL")
        if item_id in seen_ids:
            add("PLAN_ITEM_DUPLICATE", f"{where}: item ID '{item_id}' already used by /{field}/{seen_ids[item_id]}",
                "BLOCKING", "FAIL")
            continue
        seen_ids[item_id] = i
        facts = {f["predicate"]: f for f in rec.get("facts", [])
                 if f["subject_id"] == item_id and f["predicate"].startswith("plan.")}
        item = PlanItem(i, item_id, facts, rec)
        for pred in required:
            if pred not in facts:
                hint = " (use [] for known empty or null for undecided)" if pred in PLAN_UNIT else ""
                add("PLAN_FIELD_MISSING", f"{where}: item '{item_id}' must declare {pred}{hint}", "BLOCKING", "FAIL")
        obj = facts.get("plan.objective")
        if obj is not None and (obj["assertion_type"] == "UNKNOWN" or not str(obj.get("value") or "").strip()):
            add("PLAN_OBJECTIVE_UNKNOWN", f"{where}: item '{item_id}' objective is unknown; unknown required "
                "objectives block final acceptance", "BLOCKING", "UNKNOWN")
        order = item.get("plan.order")
        if isinstance(order, int) and not isinstance(order, bool):
            key = (item.get("plan.parent_id"), order)
            if key in orders:
                add("PLAN_ORDER_DUPLICATE", f"{where}: plan.order {order} under parent {key[0]!r} is already used "
                    f"by '{orders[key]}'", "BLOCKING", "FAIL")
            else:
                orders[key] = item_id
        items.append(item)
    return items


def check_parents(items: list[PlanItem], allowed: set | None, field: str, add: Add, *, what: str,
                  decided: bool = True) -> None:
    """plan.parent_id must be null/absent or a known parent ID (when the parent set is known)."""
    for it in items:
        parent = it.get("plan.parent_id")
        if parent is None or allowed is None:
            continue
        if parent not in allowed:
            sev, dec = ("BLOCKING", "FAIL") if decided else ("MAJOR", "UNKNOWN")
            add("PLAN_PARENT_UNKNOWN", f"/{field}/{it.index}: parent '{parent}' is not a known {what}", sev, dec)


def check_known(items: list[PlanItem], predicate: str, known: set | None, field: str, add: Add, *, what: str,
                authoritative: bool) -> None:
    """Every ID listed under predicate must be in known (FAIL when authoritative, else UNKNOWN)."""
    for it in items:
        for value in as_list(it.get(predicate)):
            if not isinstance(value, str):
                continue
            if known is None:
                continue
            if value not in known:
                if authoritative:
                    add("PLAN_REF_UNKNOWN", f"/{field}/{it.index}: {predicate} '{value}' is not a known {what}",
                        "BLOCKING", "FAIL")
                else:
                    add("PLAN_REF_UNTRACED", f"/{field}/{it.index}: {predicate} '{value}' is not declared by the "
                        f"pinned {what} catalog yet; confirm it in a revision", "MAJOR", "UNKNOWN")


def find_cycle(edges: dict[str, list[str]]) -> list[str] | None:
    """Return one cycle (list of node IDs) in a directed graph, or None."""
    WHITE, GREY, BLACK = 0, 1, 2
    color = {n: WHITE for n in edges}
    stack: list[str] = []

    def visit(n):
        color[n] = GREY
        stack.append(n)
        for m in edges.get(n, []):
            if m not in edges:
                continue
            if color[m] == GREY:
                return stack[stack.index(m):] + [m]
            if color[m] == WHITE:
                cyc = visit(m)
                if cyc:
                    return cyc
        stack.pop()
        color[n] = BLACK
        return None

    for n in sorted(edges):
        if color[n] == WHITE:
            cyc = visit(n)
            if cyc:
                return cyc
    return None


def check_precedence(nodes: dict[str, object], preds: dict[str, list[str]], add: Add, *, what: str,
                     known_external: set | None = None) -> None:
    """Causal predecessors: acyclic, resolvable, and never later in story time than successors."""
    cyc = find_cycle(preds)
    if cyc:
        add("CAUSAL_CYCLE", f"{what} causal predecessors form a cycle: {' -> '.join(cyc)}", "BLOCKING", "FAIL")
    for node, ps in sorted(preds.items()):
        for p in ps:
            if p not in nodes:
                if known_external is not None and p in known_external:
                    continue
                add("PREDECESSOR_UNKNOWN", f"{what} '{node}' names unknown predecessor '{p}'", "BLOCKING", "FAIL")
                continue
            t_pred, t_node = nodes[p], nodes[node]
            if t_pred is None or t_node is None:
                continue
            if t_pred > t_node:
                add("IMPOSSIBLE_PRECEDENCE", f"{what} '{p}' (t={t_pred}) must precede '{node}' (t={t_node}) but is "
                    "later in story time", "BLOCKING", "FAIL")
            elif t_pred == t_node:
                add("PRECEDENCE_SAME_TIME", f"{what} '{p}' and successor '{node}' share story time {t_node}; "
                    "confirm the intended order", "MINOR", "UNKNOWN")


# ---------------------------------------------------------------------- protected facts
def flag_matches(flag: str, fact: dict) -> bool:
    """A protected flag names a predicate, a subject ID, or '<subject_id>:<predicate>'."""
    return flag in (fact["predicate"], fact["subject_id"], f"{fact['subject_id']}:{fact['predicate']}")


def protected_facts(data: dict) -> list[dict]:
    flags = data.get("protected_fact_flags") or []
    return [f for f in data.get("facts") or [] if any(flag_matches(fl, f) for fl in flags)]


def canonical_fact(f: dict) -> str:
    import json
    return json.dumps(f, sort_keys=True, ensure_ascii=False)


def protected_changes(old: dict, new: dict) -> list[str]:
    """Describe every change to facts protected in old (removed flags, changed/added facts)."""
    out = [f"protected flag '{fl}' removed" for fl in old.get("protected_fact_flags") or []
           if fl not in (new.get("protected_fact_flags") or [])]
    keys = sorted({(f["subject_id"], f["predicate"]) for f in protected_facts(old)})
    for subj, pred in keys:
        before = sorted(canonical_fact(f) for f in old.get("facts") or [] if (f["subject_id"], f["predicate"]) == (subj, pred))
        after = sorted(canonical_fact(f) for f in new.get("facts") or [] if (f["subject_id"], f["predicate"]) == (subj, pred))
        if before != after:
            out.append(f"protected fact {subj} {pred} changed")
    return out


# ---------------------------------------------------------------------- AI output hygiene
def ref_key(ref: dict) -> tuple:
    return ref.get("record_id"), ref.get("version"), ref.get("content_hash")


def strip_unknown_refs(data, allowed: set) -> tuple[object, int]:
    """Remove Reference objects not in allowed (AI may cite only pins it was given)."""
    dropped = 0

    def is_ref(o):
        return isinstance(o, dict) and {"record_id", "version", "content_hash", "module_id"} <= set(o)

    def walk(o):
        nonlocal dropped
        if isinstance(o, list):
            out = []
            for v in o:
                if is_ref(v) and ref_key(v) not in allowed:
                    dropped += 1
                    continue
                out.append(walk(v))
            return out
        if isinstance(o, dict):
            return {k: walk(v) for k, v in o.items()}
        return o

    return walk(data), dropped


def ai_complete(ctx, partial: dict, fields: list[str], *, task: str, context: dict,
                protected: list | None = None):
    """Ask the selected AI slot for the missing OUTPUT fields; supplied values always win.

    Returns (data, resource, findings). Raises CAPABILITY_UNAVAILABLE (with a manual
    candidate request) when no slot can run the job.
    """
    from .errors import BookforgeError
    out_schema = ctx.contracts.definition(ctx.op_id, "OUTPUT")
    try:
        generated, resource = ctx.ai_generate(task=task, output_schema=out_schema, context=context,
                                              protected_facts=list(protected or []))
    except BookforgeError as exc:
        if exc.code == "CAPABILITY_UNAVAILABLE":
            raise BookforgeError(
                "CAPABILITY_UNAVAILABLE", "/payload",
                f"{ctx.op_id} needs an AI slot for {', '.join(fields)}; configure AI-1..AI-3 or supply a manual "
                "candidate.", unresolved=[f"{ctx.op_id}:manual_candidate"]) from exc
        raise
    data = dict(partial)
    for k in out_schema.get("properties", {}):
        if k in generated and k not in data:
            data[k] = generated[k]
    allowed = {ref_key(r["ref"]) for r in ctx.resolved.values()}
    data, dropped = strip_unknown_refs(data, allowed)
    findings = []
    if dropped:
        findings.append(ctx.finding("AI_REF_DROPPED", f"removed {dropped} reference(s) the AI output cited but the "
                                    "request did not pin; references are never invented", severity="MAJOR",
                                    decision="UNKNOWN"))
    return data, resource, findings


def registry_brief(registry: dict) -> dict:
    """Predicate conventions handed to AI slots (registry plus owner extensions)."""
    preds = {k: {kk: vv for kk, vv in v.items()} for k, v in (registry.get("predicates") or {}).items()}
    return {"predicates": preds, "owner_extensions": OWNER_EXTENSIONS,
            "extension_rule": registry.get("extensions")}
