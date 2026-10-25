"""Set A (Bible Universe Builder) owner semantics: shells, facts, authority, protection, chronology."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from akowe.modules.base import Context

from conftest import errors_of


def fact(subject, predicate, value, kind="FACT", frm=None, to=None, refs=None):
    return {"subject_id": subject, "predicate": predicate, "value": value, "assertion_type": kind,
            "effective_from": frm, "effective_to": to, "source_refs": refs or []}


def rules(resp, severity=None):
    return {f["rule_id"] for f in resp["findings"] if severity is None or f["severity"] == severity}


def grant_protected_change(h, ref, op):
    """Store an I10-style protected-change authorization for one exact approved revision."""
    now = datetime.now(timezone.utc)
    body = {"approval_id": f"appr-pc-{ref['record_id']}", "subject_ref": ref, "action_hash": "pc",
            "policy_ref": ref, "approver_id": h.principal, "scopes": [f"{op}:protected_change"],
            "source_refs": [], "issued_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "expires_at": (now + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ"), "revoked": False,
            "decision": "APPROVED", "evidence_origin": "AUTHORITATIVE"}
    with h.store.transaction() as tx:
        tx.insert_approval(body, h.project_id, h.branch_id)


class FakeAdapter:
    def __init__(self, output):
        self.output, self.calls = output, []

    def submit(self, slot, system, user, schema):
        self.calls.append((system, json.loads(user.split("\n", 1)[1])))
        return self.output, {"model": "fake", "input_tokens": 1, "output_tokens": 1}


def test_empty_project_bootstraps_every_a_operation(h):
    for i in range(1, 19):
        op = f"A{i:02d}"
        r = h.create(op, {"concept": f"concept {op}"})
        if op == "A09":  # magic=false and not selected
            assert r["status"] == "NOT_APPLICABLE" and r["selection_rule_id"] == "FEATURE_TRUE:magic"
            continue
        assert r["status"] == "DRAFT", (op, r["errors"])
        assert r["result"] == {"concept": f"concept {op}", "attributes": {}, "linked_refs": [],
                               "protected_fact_flags": [], "facts": []}
        assert h.validate(r["output_refs"][0])["status"] == "VALIDATED", op


def test_missing_concept_and_half_open_interval(h):
    assert errors_of(h.create("A01", {}))[0] == ("MISSING_INPUT", "/payload/concept")
    bad = h.create("A01", {"concept": "Mara", "facts": [fact("char-mara", "entity.name", "Mara", frm=5, to=5)]})
    assert bad["status"] == "REJECTED"
    assert errors_of(bad)[0] == ("INVALID_INPUT", "/payload/facts/0/effective_to")
    assert h.store.query_one("SELECT COUNT(*) c FROM records")["c"] == 0


def test_fact_types_unregistered_predicates_and_contradictions(h):
    r = h.create("A01", {"concept": "Mara", "facts": [
        fact("char-mara", "entity.name", "Mara", frm=0, to=100),
        fact("char-mara", "entity.name", "Marra", frm=50),        # overlaps -> contradiction
        fact("char-mara", "entity.name", "Mara Vell", frm=100),   # half-open: no overlap with [0,100)
        fact("char-mara", "entity.power_remaining", -1, kind="BELIEF"),
        fact("char-mara", "appearance.hair", "silver"),
    ]})
    assert r["status"] == "DRAFT"
    assert {"FACT_CONTRADICTION", "PREDICATE_TYPE", "PREDICATE_UNREGISTERED"} <= rules(r)
    contradictions = [f for f in r["findings"] if f["rule_id"] == "FACT_CONTRADICTION"]
    assert len(contradictions) == 2  # [0,100) vs [50,∞) and [50,∞) vs [100,∞)
    unreg = next(f for f in r["findings"] if f["rule_id"] == "PREDICATE_UNREGISTERED")
    assert unreg["decision"] == "UNKNOWN" and unreg["severity"] == "MAJOR"
    v = h.validate(r["output_refs"][0])
    assert v["status"] == "DRAFT"


def test_linked_authority_blocks_approval_not_draft(h):
    r = h.create("A01", {"concept": "Mara", "facts": [fact("char-mara", "entity.location_id", "loc-harbor")]})
    assert r["status"] == "DRAFT"
    ref = r["output_refs"][0]
    acc = h.accept(ref)
    assert acc["status"] == "DRAFT" and "LINKED_AUTHORITY" in rules(acc, "BLOCKING")
    loc = h.create("A04", {"concept": "Harbor", "facts": [fact("loc-harbor", "entity.name", "Gull Harbor")]})
    u = h.dispatch("A01", "UPDATE", base_ref=ref,
                   payload=dict(r["result"], linked_refs=[loc["output_refs"][0]]))
    assert u["status"] == "DRAFT" and "LINKED_AUTHORITY" not in rules(u)
    assert h.approve(u["output_refs"][0])["status"] == "APPROVED"


def test_relationship_walkthrough_reciprocal_and_endpoints(h):
    mara = h.create("A01", {"concept": "Mara", "facts": [fact("char-mara", "entity.name", "Mara")]})
    guild = h.create("A06", {"concept": "Lamplighters", "facts": [fact("org-lamp", "entity.name", "Lamplighters")]})
    rel_payload = {"concept": "Mara serves the Lamplighters",
                   "linked_refs": [mara["output_refs"][0]],
                   "facts": [fact("rel-1", "x.a18.endpoint_ids", ["char-mara", "org-lamp"])]}
    rel = h.create("A18", rel_payload)
    assert rel["status"] == "DRAFT"  # unresolved endpoint never blocks a draft
    v = h.validate(rel["output_refs"][0])
    assert v["status"] == "DRAFT" and "LINKED_AUTHORITY" in rules(v, "BLOCKING")
    assert "RECIPROCAL_LINK" in rules(v)  # A01 does not link back yet: revision feedback only
    rel2 = h.dispatch("A18", "UPDATE", base_ref=rel["output_refs"][0],
                      payload=dict(rel["result"], linked_refs=[mara["output_refs"][0], guild["output_refs"][0]]))
    rel_ref = rel2["output_refs"][0]
    v2 = h.validate(rel_ref)
    assert v2["status"] == "VALIDATED" and "RECIPROCAL_LINK" in rules(v2, "MINOR")
    m2 = h.dispatch("A01", "UPDATE", base_ref=mara["output_refs"][0],
                    payload=dict(mara["result"], linked_refs=[rel_ref]))
    assert h.approve(m2["output_refs"][0])["status"] == "APPROVED"
    v3 = h.validate(rel_ref)
    assert "RECIPROCAL_LINK" not in rules(v3)
    assert h.accept(rel_ref)["status"] == "APPROVED"
    one = h.create("A18", {"concept": "solo", "linked_refs": [mara["output_refs"][0]],
                           "facts": [fact("rel-2", "x.a18.endpoint_ids", ["char-mara"])]})
    assert "RELATIONSHIP_ENDPOINTS" in rules(one, "BLOCKING")


def test_protected_fact_change_requires_authorization(h):
    payload = {"concept": "Mara", "protected_fact_flags": ["char-mara:x.a01.hair"],
               "facts": [fact("char-mara", "x.a01.hair", "silver"), fact("char-mara", "x.a01.mood", "calm")]}
    ref, r = h.create_approved("A01", payload)
    changed = dict(r["result"], facts=[fact("char-mara", "x.a01.hair", "black"), fact("char-mara", "x.a01.mood", "calm")])
    blocked = h.dispatch("A01", "UPDATE", base_ref=ref, payload=changed)
    assert errors_of(blocked)[0] == ("LOCKED_FACT", "/payload/facts") and blocked["status"] == "BLOCKED"
    unflagged = dict(r["result"], protected_fact_flags=[])
    assert errors_of(h.dispatch("A01", "UPDATE", base_ref=ref, payload=unflagged))[0][0] == "LOCKED_FACT"
    # Unprotected facts change freely.
    ok = h.dispatch("A01", "UPDATE", base_ref=ref,
                    payload=dict(r["result"], facts=[fact("char-mara", "x.a01.hair", "silver"),
                                                     fact("char-mara", "x.a01.mood", "angry")]))
    assert ok["status"] == "DRAFT"
    assert h.approve(ok["output_refs"][0])["status"] == "APPROVED"
    head = ok["output_refs"][0]
    grant_protected_change(h, head, "A01")
    upd = h.dispatch("A01", "UPDATE", base_ref=head, payload=changed)
    assert upd["status"] == "DRAFT", upd["errors"]
    cand = upd["output_refs"][0]
    assert h.validate(cand)["status"] == "VALIDATED"
    refused = h.accept(cand)
    assert errors_of(refused)[0] == ("APPROVAL_REQUIRED", "/payload/approval_ref")
    k09 = h.dispatch("K09", "CREATE", payload={
        "action_id": "protected-hair", "base_revision": head["version"],
        "impact": {"action_hash": "h", "source_versions": [cand], "protected": True},
        "policy": {"policy_id": "canon", "authorized_roles": ["author"], "ttl_seconds": 3600}})
    assert k09["status"] == "DRAFT", k09["errors"]
    expiry = (datetime.now(timezone.utc) + timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    decided = h.dispatch("K09", "UPDATE", base_ref=k09["output_refs"][0],
                         payload=dict(k09["result"], decision="APPROVED", expiry=expiry))
    assert decided["status"] == "DRAFT", decided["errors"]
    pending = h.accept(cand, approval_ref=k09["output_refs"][0])
    assert errors_of(pending)[0][0] == "APPROVAL_REQUIRED"  # a PENDING checkpoint authorizes nothing
    final = h.accept(cand, approval_ref=decided["output_refs"][0])
    assert final["status"] == "APPROVED", (final["errors"], final["findings"])
    assert h.record(head)["lifecycle"] == "SUPERSEDED"


def test_protected_flags_must_cover_facts(h):
    r = h.create("A01", {"concept": "Mara", "protected_fact_flags": ["x.a01.eyes", "char-mara"],
                         "facts": [fact("char-mara", "x.a01.secret", "royal", kind="BELIEF")]})
    assert {"PROTECTED_FLAG_UNMATCHED", "PROTECTED_NOT_FACT"} <= rules(r)
    assert h.validate(r["output_refs"][0])["status"] == "DRAFT"


def test_a09_magic_gate_and_costs_limits(h):
    assert h.create("A09", {"concept": "Tidecalling"})["status"] == "NOT_APPLICABLE"
    h.set_features(magic=True)
    r = h.create("A09", {"concept": "Tidecalling"})
    assert r["status"] == "DRAFT" and {"POWER_COSTS", "POWER_LIMITS"} <= rules(r, "BLOCKING")
    ok = h.create("A09", {"concept": "Tidecalling", "attributes": {"costs": "body heat"},
                          "facts": [fact("pow-tide", "x.a09.limit", "one tide per day")]})
    assert h.approve(ok["output_refs"][0])["status"] == "APPROVED"


def test_a10_cannot_override_linked_a09_limit(h):
    h.set_features(magic=True)
    power, _ = h.create_approved("A09", {"concept": "Tides", "attributes": {"costs": "heat", "limits": "daily"},
                                         "protected_fact_flags": ["x.a09.limit"],
                                         "facts": [fact("pow-tide", "x.a09.limit", 1)]})
    tech = h.create("A10", {"concept": "Tide engine", "linked_refs": [power],
                            "facts": [fact("pow-tide", "x.a09.limit", 5)]})
    found = [f for f in tech["findings"] if f["rule_id"] == "CANON_CONTRADICTION"]
    assert found and "protected" in found[0]["message"] and found[0]["source_refs"] == [power]
    assert h.validate(tech["output_refs"][0])["status"] == "DRAFT"


def test_a04_containment_and_coordinates(h):
    r = h.create("A04", {"concept": "Coast", "facts": [
        fact("loc-a", "x.a04.parent_id", "loc-b"), fact("loc-b", "x.a04.parent_id", "loc-a"),
        fact("loc-a", "x.a04.coordinates", [1.5, 2.0])]})
    assert {"CONTAINMENT_CYCLE", "COORDINATE_UNIT"} <= rules(r, "BLOCKING")
    ok = h.create("A04", {"concept": "Coast", "facts": [
        fact("loc-a", "x.a04.parent_id", None), fact("loc-b", "x.a04.parent_id", "loc-a"),
        fact("loc-a", "x.a04.coordinates", [1.5, 2.0]), fact("loc-a", "x.a04.coordinate_unit", "km")]})
    assert h.validate(ok["output_refs"][0])["status"] == "VALIDATED"


def test_a16_units_explicit(h):
    r = h.create("A16", {"concept": "Salt economy", "facts": [fact("res-salt", "x.econ.price", 4)]})
    assert "EXPLICIT_UNIT" in rules(r, "BLOCKING")
    ok = h.create("A16", {"concept": "Salt", "facts": [fact("res-salt", "x.econ.price", 4),
                                                       fact("res-salt", "x.a16.unit", "silver marks")]})
    assert "EXPLICIT_UNIT" not in rules(ok)


def test_a13_impossible_precedence_and_a14_ordering(h):
    bad = h.create("A13", {"concept": "The Sundering", "facts": [
        fact("evt-flood", "entity.name", "Flood", frm=10),
        fact("evt-famine", "entity.name", "Famine", frm=5),
        fact("evt-famine", "x.a13.cause_ids", ["evt-flood"], frm=5)]})
    assert "IMPOSSIBLE_PRECEDENCE" in rules(bad, "BLOCKING")
    cyc = h.create("A13", {"concept": "loop", "facts": [
        fact("e1", "x.a13.cause_ids", ["e2"]), fact("e2", "x.a13.cause_ids", ["e1"])]})
    assert "CAUSAL_CYCLE" in rules(cyc, "BLOCKING")
    good = h.create("A13", {"concept": "History", "facts": [
        fact("evt-b", "entity.name", "B", frm=20), fact("evt-a", "entity.name", "A", frm=20),
        fact("evt-c", "entity.name", "C", frm=3), fact("evt-b", "x.a13.cause_ids", ["evt-c"], frm=20)]})
    assert h.validate(good["output_refs"][0])["status"] == "VALIDATED"
    tl = h.create("A14", {"concept": "World timeline", "linked_refs": [good["output_refs"][0]]})
    assert tl["status"] == "DRAFT"
    order = [(f["subject_id"], f["value"], f["effective_from"]) for f in tl["result"]["facts"]]
    assert order == [("evt-c", 0, 3), ("evt-a", 1, 20), ("evt-b", 2, 20)]  # time, then stable event ID
    assert tl["result"]["attributes"]["ordered_events"].startswith("evt-c @ t=3")
    assert h.validate(tl["output_refs"][0])["status"] == "VALIDATED"
    wrong = dict(tl["result"], facts=[dict(tl["result"]["facts"][0], value=2)] + tl["result"]["facts"][1:])
    u = h.dispatch("A14", "UPDATE", base_ref=tl["output_refs"][0], payload=wrong)
    assert "TIMELINE_ORDER" in rules(u, "BLOCKING")


def test_manual_candidate_and_ai_requested_proposal(h, monkeypatch):
    cand = {"concept": "Mara", "attributes": {"role": "keeper"}, "linked_refs": [], "protected_fact_flags": [],
            "facts": [fact("char-mara", "entity.name", "Mara")]}
    m = h.dispatch("A01", "CREATE", payload={"concept": "Mara"}, manual_candidate=cand)
    assert m["status"] == "DRAFT" and m["result"] == cand
    # AI runs only on explicit request and never overrides supplied values or invents pins.
    loc = h.create("A04", {"concept": "Harbor", "protected_fact_flags": ["loc-harbor"],
                           "facts": [fact("loc-harbor", "entity.name", "Gull Harbor")]})["output_refs"][0]
    bogus = dict(loc, record_id="A04-invented")
    fake = FakeAdapter({"concept": "changed by AI", "attributes": {"role": "lighthouse keeper"},
                        "facts": [fact("char-mara", "entity.location_id", "loc-harbor", refs=[bogus])]})
    h.engine.providers.test_adapter = fake
    h.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
    monkeypatch.setattr(Context, "ai_requested", True, raising=False)
    r = h.create("A01", {"concept": "Mara", "linked_refs": [loc]})
    assert r["status"] == "DRAFT", r["errors"]
    assert r["result"]["concept"] == "Mara" and r["result"]["linked_refs"] == [loc]
    assert r["result"]["attributes"] == {"role": "lighthouse keeper"}
    assert r["result"]["facts"][0]["source_refs"] == [] and "AI_REF_DROPPED" in rules(r)
    system, package = fake.calls[0]
    assert "A01" in system and "predicate" in system
    assert package["protected_facts"][0]["subject_id"] == "loc-harbor"
    assert "predicate_conventions" in package["context"]
    prov = h.store.query_one("SELECT transform FROM provenance ORDER BY rowid DESC LIMIT 1")
    assert prov["transform"] == "AI"


def test_jurisdiction_links_by_stable_id(h):
    gov = h.create("A05", {"concept": "Crown", "facts": [fact("jur-crown", "entity.name", "Crown")]})
    law = h.create("A17", {"concept": "Salt tax", "facts": [fact("law-salt", "x.a17.jurisdiction_id", "jur-crown")]})
    assert "LINKED_AUTHORITY" in rules(law, "BLOCKING")
    law2 = h.create("A17", {"concept": "Salt tax", "linked_refs": [gov["output_refs"][0]],
                            "facts": [fact("law-salt", "x.a17.jurisdiction_id", "jur-crown")]})
    assert "LINKED_AUTHORITY" not in rules(law2)
