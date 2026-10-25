"""Set A handlers: Bible Universe Builder (A01-A18).

Every A operation CREATEs from a concept alone (a draft shell with known-empty
attributes/facts); links and other records are never prerequisites for a draft. All
semantics are deterministic owner checks run at CREATE (as preview findings), VALIDATE
and ACCEPT:

* facts: half-open effective intervals (rejected at CREATE/UPDATE), registered predicate
  types, unregistered predicates -> UNKNOWN review, contradictions within the record and
  against linked A canon (A10 cannot silently override A09 limits, etc.);
* protected_fact_flags: a flag names a predicate, a subject ID or '<subject>:<predicate>';
  it must protect FACT assertions. Once a lineage has an approved head, changing protected
  facts needs an I10/K09 protected-change authorization at UPDATE and an approval_ref for
  the exact candidate at ACCEPT (LOCKED heads are additionally guarded by the kernel);
* linked canon authority: an asserted entity link (location, inventory, relationship,
  membership, jurisdiction, endpoints...) must be declared by a resolved pinned record of
  the governing module, otherwise approval is blocked (drafts are not);
* reciprocal links (A01/A18, A04/A07, A05/A17, A10/A16) are revision feedback, never blocks;
* op rules: A04 acyclic containment and coordinate units, A09 costs and limits, A13/A14
  chronology (sort by time then stable event ID, impossible precedence), A16 explicit
  units, A18 relationship endpoints.

AI is used only for an explicitly requested creative proposal (ctx.ai_requested) and never
overrides supplied values; manual candidates are always accepted for review.
"""
from __future__ import annotations

import copy

from .. import plan_rules as pr
from ..errors import AkoweError
from . import register
from .base import Context, OperationHandler, Result, normalize_to_output

A_OPS = tuple(f"A{i:02d}" for i in range(1, 19))

# Reciprocal link pairs (Set rules): missing back-links are revision feedback.
RECIPROCAL = {"A01": "A18", "A18": "A01", "A04": "A07", "A07": "A04", "A05": "A17", "A17": "A05",
              "A10": "A16", "A16": "A10"}

PURPOSE_RULES = {
    "A01": "Appearance facts (identity, skin, hair, anatomy, distinguishing features) are protected when flagged.",
    "A02": "Capabilities and limits constrain character biology.",
    "A03": "Physical rules constrain worlds and lower-level locations.",
    "A04": "Containment (x.a04.parent_id) must be acyclic; coordinates need x.a04.coordinate_unit.",
    "A05": "Jurisdictions use stable IDs that A17 laws link to.",
    "A06": "Membership (x.a06.member_ids) names existing A01/A06 IDs.",
    "A07": "Distinguish societal claims (BELIEF) from verified physical truth (FACT).",
    "A08": "Distinguish beliefs (BELIEF) from verified physical truth (FACT).",
    "A09": "Powers must state costs and limits (attributes or x.a09.cost/x.a09.limit facts).",
    "A10": "Technology cannot silently override A09 power limits.",
    "A11": "Combat rules are constraints, not prose-generated events.",
    "A12": "Artifact rules are constraints, not prose-generated events.",
    "A13": "Events preserve participants (x.a13.participant_ids), causes (x.a13.cause_ids) and outcomes; "
           "event time is the fact effective_from.",
    "A14": "Order historical events by time then stable event ID and report impossible precedence.",
    "A15": "Names use stable entity IDs and preserve exact spelling (entity.name).",
    "A16": "Currencies/resources have explicit units (x.a16.unit).",
    "A17": "Laws link to A05 jurisdictions by stable ID (x.a17.jurisdiction_id).",
    "A18": "Baseline relationships join existing A01/A06 endpoints (x.a18.endpoint_ids).",
}


def resolve_pins(ctx: Context, refs: list) -> list[dict]:
    """Stored records for exact pins that still resolve (kernel reports the rest)."""
    out = []
    for ref in refs or []:
        rec = ctx.store.get_record(ctx.project_id, ctx.branch_id, ref["record_id"], ref["version"])
        if rec is not None and rec["content_hash"] == ref["content_hash"] and rec["module_id"] == ref["module_id"]:
            out.append(rec)
    return out


def historical_events(rec: dict) -> dict[str, dict]:
    """A13 event subjects -> {time, causes, ref}; time is the earliest FACT effective_from."""
    events: dict[str, dict] = {}
    for f in (rec.get("data") or {}).get("facts") or []:
        if f["assertion_type"] != "FACT":
            continue
        if not (f["predicate"].startswith("x.a13.") or f["predicate"] == "entity.name"):
            continue
        ev = events.setdefault(f["subject_id"], {"time": None, "causes": [], "ref": rec["ref"]})
        t = f.get("effective_from")
        if t is not None and (ev["time"] is None or t < ev["time"]):
            ev["time"] = t
        if f["predicate"] == "x.a13.cause_ids":
            ev["causes"] += [c for c in pr.as_list(f.get("value")) if isinstance(c, str) and c not in ev["causes"]]
    return events


@register(*A_OPS)
class CanonHandler(OperationHandler):
    """Shared A-set behavior; per-op rules live in the _rules_<op> methods."""

    # -- applicability ------------------------------------------------------------------
    def applicability(self, ctx: Context):
        if self.op_id != "A09" or ctx.manifest is None:
            return None
        magic = (ctx.manifest.get("features") or {}).get("magic")
        if magic is False and "A09" not in (ctx.manifest.get("required_operations") or []):
            return ("FEATURE_TRUE:magic",
                    f"A09 requires magic=true or explicit selection in feature manifest revision "
                    f"{ctx.manifest['revision']}")
        return None

    # -- CREATE / UPDATE -----------------------------------------------------------------
    def create(self, ctx: Context) -> Result:
        findings: list = []
        resource = None
        if ctx.manual_candidate is not None:
            data, transform = copy.deepcopy(ctx.manual_candidate), "MANUAL"
        else:
            data, _ = normalize_to_output(ctx.payload, ctx.contracts.definition(ctx.op_id, "OUTPUT"))
            transform = "LOGIC"
            if self.op_id == "A14":
                self._derive_timeline(ctx, data)
            if getattr(ctx, "ai_requested", False):
                data, resource, findings = self._propose(ctx, data)
                transform = "AI"
        self._reject_intervals(data, "/manual_candidate" if transform == "MANUAL" else "/payload")
        findings += self._check(ctx, data, None, resolve_pins(ctx, data.get("linked_refs")))
        return Result(data=data, transform=transform, resource=resource, findings=findings)

    def update(self, ctx: Context) -> Result:
        data = copy.deepcopy(ctx.payload)
        self._reject_intervals(data, "/payload")
        approved = self._approved_head(ctx, ctx.base)
        if approved is not None:
            changes = pr.protected_changes(approved["data"], data)
            if changes and not ctx.engine._protected_change_authorized(ctx, approved):
                raise AkoweError(
                    "LOCKED_FACT", "/payload/facts",
                    f"{'; '.join(changes)} on approved v{approved['version']}; an I10/K09 approval with scope "
                    f"{self.op_id}:protected_change for that exact revision is required", status="BLOCKED")
        findings = self._check(ctx, data, ctx.base["record_id"], resolve_pins(ctx, data.get("linked_refs")))
        return Result(data=data, transform="MANUAL", findings=findings)

    # -- VALIDATE / ACCEPT ----------------------------------------------------------------
    def validate(self, ctx: Context, record: dict) -> list[dict]:
        return self._check(ctx, record["data"], record["record_id"],
                           resolve_pins(ctx, record["data"].get("linked_refs")), record=record)

    def requires_explicit_approval(self, ctx: Context, record: dict) -> bool:
        approved = self._approved_head(ctx, record)
        return bool(approved and approved["version"] != record["version"]
                    and pr.protected_changes(approved["data"], record["data"]))

    # -- helpers --------------------------------------------------------------------------
    @staticmethod
    def _approved_head(ctx: Context, record: dict) -> dict | None:
        v = record.get("approved_version")
        if not v:
            return None
        return ctx.store.get_record(ctx.project_id, ctx.branch_id, record["record_id"], v)

    @staticmethod
    def _reject_intervals(data: dict, base: str):
        for i, f in enumerate(data.get("facts") or []):
            if not pr.interval_ok(f):
                raise AkoweError("INVALID_INPUT", f"{base}/facts/{i}/effective_to",
                                     "effective interval is half-open [from,to): to must be greater than from",
                                     status="REJECTED")

    def _check(self, ctx: Context, data: dict, record_id: str | None, linked: list[dict],
               record: dict | None = None) -> list[dict]:
        out: list[dict] = []

        def add(rule, msg, severity="MAJOR", decision="FAIL", refs=None):
            out.append(ctx.finding(rule, msg, severity=severity, decision=decision, source_refs=refs or []))

        facts = data.get("facts") or []
        registry = ctx.contracts.predicate_registry
        pr.check_facts(pr.iter_facts(facts, "/facts"), registry, add)
        self._check_protected(data, add)
        own_ids = {f["subject_id"] for f in facts} | ({record_id} if record_id else set())
        self._check_authority(facts, own_ids, linked, add)
        self._check_linked_contradictions(facts, linked, add)
        if record is not None:
            self._check_reciprocal(ctx, record, linked, add)
        rule = getattr(self, f"_rules_{self.op_id.lower()}", None)
        if rule:
            rule(ctx, data, own_ids, linked, add)
        return out

    @staticmethod
    def _check_protected(data: dict, add):
        facts = data.get("facts") or []
        for flag in data.get("protected_fact_flags") or []:
            matched = [f for f in facts if pr.flag_matches(flag, f)]
            if not matched:
                add("PROTECTED_FLAG_UNMATCHED", f"protected flag '{flag}' matches no fact (use a predicate, a "
                    "subject ID or '<subject_id>:<predicate>')", "MAJOR", "UNKNOWN")
            for f in matched:
                if f["assertion_type"] != "FACT":
                    add("PROTECTED_NOT_FACT", f"protected flag '{flag}' covers a {f['assertion_type']} assertion "
                        f"({f['subject_id']} {f['predicate']}); only FACT is eligible for protected canon",
                        "BLOCKING", "FAIL")

    def _check_authority(self, facts: list, own_ids: set, linked: list[dict], add):
        for i, f in enumerate(facts):
            if f["assertion_type"] != "FACT":
                continue
            if f["predicate"] == "entity.power_remaining" and not any(r["module_id"] == "A09" for r in linked):
                add("LINKED_AUTHORITY", f"/facts/{i}: entity.power_remaining uses the unit configured by A09; pin "
                    "the governing A09 record in linked_refs before approval", "BLOCKING", "FAIL")
            modules = pr.AUTHORITY.get(f["predicate"])
            if not modules:
                continue
            known = set(own_ids) if self.op_id in modules else set()
            refs = []
            for rec in linked:
                if rec["module_id"] in modules:
                    known |= pr.declared_ids(rec)
                    refs.append(rec["ref"])
            for value in pr.as_list(f.get("value")):
                if isinstance(value, str) and value not in known:
                    add("LINKED_AUTHORITY", f"/facts/{i}: {f['predicate']} asserts '{value}' but no resolved pinned "
                        f"{'/'.join(modules)} record in linked_refs declares it; approval needs that authority",
                        "BLOCKING", "FAIL", refs)

    @staticmethod
    def _check_linked_contradictions(facts: list, linked: list[dict], add):
        for rec in linked:
            if not rec["module_id"].startswith("A") or not isinstance(rec.get("data"), dict):
                continue
            protected = {pr.canonical_fact(f) for f in pr.protected_facts(rec["data"])}
            for other in rec["data"].get("facts") or []:
                if other["assertion_type"] != "FACT":
                    continue
                for i, f in enumerate(facts):
                    if (f["assertion_type"] == "FACT" and f["subject_id"] == other["subject_id"]
                            and f["predicate"] == other["predicate"] and f.get("value") != other.get("value")
                            and pr.overlaps(f, other)):
                        kind = "protected " if pr.canonical_fact(other) in protected else ""
                        add("CANON_CONTRADICTION", f"/facts/{i}: {f['subject_id']} {f['predicate']} contradicts "
                            f"{kind}linked canon {rec['module_id']}:{rec['record_id']} v{rec['version']}; linked "
                            "constraints cannot be silently overridden", "BLOCKING", "FAIL", [rec["ref"]])

    def _check_reciprocal(self, ctx: Context, record: dict, linked: list[dict], add):
        partner = RECIPROCAL.get(self.op_id)
        for rec in linked:
            if rec["module_id"] != partner:
                continue
            latest = ctx.store.get_record(ctx.project_id, ctx.branch_id, rec["record_id"]) or rec
            back = {r["record_id"] for r in (latest.get("data") or {}).get("linked_refs") or []}
            if record["record_id"] not in back:
                add("RECIPROCAL_LINK", f"{partner}:{rec['record_id']} does not link back to this {self.op_id} "
                    "record; add the reciprocal link in a revision", "MINOR", "UNKNOWN", [rec["ref"]])

    # -- per-operation rules ---------------------------------------------------------------
    def _rules_a04(self, ctx, data, own_ids, linked, add):
        parents: dict[str, list[str]] = {}
        units: dict[str, set] = {}
        sources = [("", data.get("facts") or [])] + [
            (f"{r['record_id']}:", (r.get("data") or {}).get("facts") or []) for r in linked if r["module_id"] == "A04"]
        for _, facts in sources:
            for f in facts:
                if f["assertion_type"] != "FACT":
                    continue
                if f["predicate"] == "x.a04.parent_id" and isinstance(f.get("value"), str):
                    parents.setdefault(f["subject_id"], []).append(f["value"])
                if f["predicate"] == "x.a04.coordinate_unit":
                    units.setdefault(f["subject_id"], set()).add(f.get("value"))
        for p in list(parents.values()):
            for v in p:
                parents.setdefault(v, [])
        cyc = pr.find_cycle(parents)
        if cyc:
            add("CONTAINMENT_CYCLE", f"location containment must be acyclic: {' -> '.join(cyc)}", "BLOCKING", "FAIL")
        for i, f in enumerate(data.get("facts") or []):
            if f["predicate"] == "x.a04.coordinates" and f["subject_id"] not in units:
                add("COORDINATE_UNIT", f"/facts/{i}: coordinates of '{f['subject_id']}' need an "
                    "x.a04.coordinate_unit fact", "BLOCKING", "FAIL")
        all_units = {u for us in units.values() for u in us}
        if len(all_units) > 1:
            add("COORDINATE_UNIT_MIXED", f"coordinate units differ across linked geography {sorted(map(str, all_units))};"
                " travel claims cannot be compared automatically", "MAJOR", "UNKNOWN")

    def _rules_a09(self, ctx, data, own_ids, linked, add):
        attrs = data.get("attributes") or {}
        preds = {f["predicate"] for f in data.get("facts") or [] if f["assertion_type"] == "FACT"}
        if not (attrs.get("costs") or "x.a09.cost" in preds):
            add("POWER_COSTS", "power systems must state costs used by scenes (attributes.costs or x.a09.cost)",
                "BLOCKING", "FAIL")
        if not (attrs.get("limits") or "x.a09.limit" in preds):
            add("POWER_LIMITS", "power systems must state limits used by scenes (attributes.limits or x.a09.limit)",
                "BLOCKING", "FAIL")

    def _rules_a13(self, ctx, data, own_ids, linked, add):
        own = historical_events({"data": data, "ref": None})
        nodes = {k: v["time"] for k, v in own.items()}
        for rec in linked:
            if rec["module_id"] == "A13":
                nodes.update({k: v["time"] for k, v in historical_events(rec).items() if k not in nodes})
        pr.check_precedence(nodes, {k: v["causes"] for k, v in own.items()}, add, what="historical event")

    def _rules_a14(self, ctx, data, own_ids, linked, add):
        events = self._timeline_events(linked)
        if not events:
            if not data.get("facts"):
                add("TIMELINE_EMPTY", "no linked A13 events to order; link historical events before relying on "
                    "this chronology", "INFO", "UNKNOWN")
            return
        pr.check_precedence({k: v["time"] for k, v in events.items()},
                            {k: v["causes"] for k, v in events.items()}, add, what="historical event")
        for eid, ev in sorted(events.items()):
            if ev["time"] is None:
                add("EVENT_TIME_UNKNOWN", f"event '{eid}' has no effective_from time and cannot be placed",
                    "MAJOR", "UNKNOWN", [ev["ref"]])
        expected = {eid: i for i, eid in enumerate(self._ordered(events))}
        for i, f in enumerate(data.get("facts") or []):
            if f["predicate"] != "x.a14.chronological_index":
                continue
            if f["subject_id"] not in expected:
                add("TIMELINE_UNKNOWN_EVENT", f"/facts/{i}: '{f['subject_id']}' is not an event of the linked A13 "
                    "records", "BLOCKING", "FAIL")
            elif f.get("value") != expected[f["subject_id"]]:
                add("TIMELINE_ORDER", f"/facts/{i}: '{f['subject_id']}' index {f.get('value')} differs from the "
                    f"(time, event ID) order {expected[f['subject_id']]}", "BLOCKING", "FAIL")

    def _rules_a16(self, ctx, data, own_ids, linked, add):
        facts = data.get("facts") or []
        with_unit = {f["subject_id"] for f in facts if f["predicate"] == "x.a16.unit"}
        for i, f in enumerate(facts):
            v = f.get("value")
            if (isinstance(v, (int, float)) and not isinstance(v, bool) and f["predicate"] not in pr.OWNER_EXTENSIONS
                    and f["subject_id"] not in with_unit):
                add("EXPLICIT_UNIT", f"/facts/{i}: numeric {f['predicate']} of '{f['subject_id']}' needs an explicit "
                    "x.a16.unit fact", "BLOCKING", "FAIL")

    def _rules_a18(self, ctx, data, own_ids, linked, add):
        endpoints = [(i, f) for i, f in enumerate(data.get("facts") or [])
                     if f["predicate"] == "x.a18.endpoint_ids" and f["assertion_type"] == "FACT"]
        if not endpoints:
            add("RELATIONSHIP_ENDPOINTS", "no x.a18.endpoint_ids fact declares the related A01/A06 entities",
                "MAJOR", "UNKNOWN")
        for i, f in endpoints:
            if len(pr.as_list(f.get("value"))) < 2:
                add("RELATIONSHIP_ENDPOINTS", f"/facts/{i}: a relationship joins at least two endpoints",
                    "BLOCKING", "FAIL")

    # -- A14 deterministic chronology --------------------------------------------------------
    @staticmethod
    def _timeline_events(linked: list[dict]) -> dict[str, dict]:
        events: dict[str, dict] = {}
        for rec in linked:
            if rec["module_id"] == "A13":
                for k, v in historical_events(rec).items():
                    events.setdefault(k, v)
        return events

    @staticmethod
    def _ordered(events: dict[str, dict]) -> list[str]:
        return sorted(events, key=lambda e: (events[e]["time"] is None, events[e]["time"] or 0, e))

    def _derive_timeline(self, ctx: Context, data: dict) -> bool:
        """Fill an A14 chronology from linked A13 events when the caller supplied none."""
        if data.get("facts") or (data.get("attributes") or {}).get("ordered_events"):
            return False
        events = self._timeline_events(ctx.field_records("linked_refs"))
        if not events:
            return False
        order = self._ordered(events)
        data["facts"] = [{"subject_id": eid, "predicate": "x.a14.chronological_index", "value": i,
                          "assertion_type": "FACT", "effective_from": events[eid]["time"], "effective_to": None,
                          "source_refs": [events[eid]["ref"]]} for i, eid in enumerate(order)]
        attrs = dict(data.get("attributes") or {})
        attrs["ordered_events"] = "; ".join(
            f"{eid} @ t={events[eid]['time'] if events[eid]['time'] is not None else 'unknown'}" for eid in order)
        data["attributes"] = attrs
        return True

    # -- AI proposals (explicit request only) -------------------------------------------------
    def _propose(self, ctx: Context, data: dict):
        # Protection is an author decision: flags always come from the request, never the model.
        supplied = {k: data[k] for k in ("concept", "linked_refs", "protected_fact_flags") if k in data}
        for k in ("attributes", "facts"):
            if ctx.payload.get(k):
                supplied[k] = data[k]
        missing = [k for k in ("attributes", "facts") if k not in supplied]
        if not missing:
            return data, None, []
        merged, resource, findings = pr.ai_complete(
            ctx, supplied, missing, task=self.ai_task(ctx), context=self.ai_context(ctx),
            protected=self._linked_protected(ctx))
        return merged, resource, findings

    @staticmethod
    def _linked_protected(ctx: Context) -> list[dict]:
        out = []
        for rec in ctx.field_records("linked_refs"):
            if rec["module_id"].startswith("A") and isinstance(rec.get("data"), dict):
                out += [dict(f, source=f"{rec['module_id']}:{rec['record_id']} v{rec['version']}")
                        for f in pr.protected_facts(rec["data"])]
        return out

    def ai_task(self, ctx: Context) -> str:
        op = ctx.op
        return (
            f"Operation {op['id']} - {op['name']}: propose canon for the author's concept. {op['purpose']} "
            f"Set rule: {PURPOSE_RULES[self.op_id]} Keep 'concept' and 'linked_refs' exactly as given. "
            "'attributes' holds narrative descriptions only; precise claims go in 'facts' as "
            "{subject_id, predicate, value, assertion_type, effective_from, effective_to, source_refs}. Use stable "
            "lowercase subject IDs, canonical predicates from predicate_registry or the listed owner extensions, "
            "scalar or flat-list values, assertion_type FACT only for intended canon (BELIEF for societal or "
            "character beliefs, PLAN for intentions, UNKNOWN when undecided), integer story-time ticks with "
            "effective_to > effective_from or null bounds, and source_refs [] unless citing a provided pin. Never "
            "contradict protected facts. Return only JSON matching the output schema.")

    def ai_context(self, ctx: Context) -> dict:
        ctx_data = super().ai_context(ctx)
        ctx_data["predicate_conventions"] = pr.registry_brief(ctx.contracts.predicate_registry)
        return ctx_data
