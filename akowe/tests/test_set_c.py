"""Set C tests: context loader, prose writers, event bundles, boundaries, acceptance, style.

Prerequisite A/B records use manual candidates (h.create_approved(..., manual_candidate=...)).
AI paths use a fake adapter injected as engine.providers.test_adapter.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from bookforge.c_events import extract_event_bundle, find_bundles
from bookforge.errors import BookforgeError

from conftest import PRINCIPAL, errors_of

TEXT = "Mara walked from the harbor to the lighthouse. She picked up the brass key."


# ====================================================================== fixtures/helpers
def fact(s, p, v, a="FACT", frm=None, to=None):
    return {"subject_id": s, "predicate": p, "value": v, "assertion_type": a, "effective_from": frm,
            "effective_to": to, "source_refs": []}


def plan_item(item_id, order, objective, links=(), pov="mara", loc="harbor", parent=None):
    facts = [fact(item_id, "plan.item_id", item_id, "PLAN"), fact(item_id, "plan.order", order, "PLAN"),
             fact(item_id, "plan.parent_id", parent, "PLAN"), fact(item_id, "plan.objective", objective, "PLAN"),
             fact(item_id, "plan.event_ids", [], "PLAN"), fact(item_id, "plan.pov_id", pov, "PLAN"),
             fact(item_id, "plan.location_id", loc, "PLAN"), fact(item_id, "plan.obligation_ids", [], "PLAN")]
    return {"summary": f"{item_id}: {objective}", "facts": facts, "links": list(links)}


def approved(h, op, payload, cand):
    """Create from a manual candidate, then VALIDATE + ACCEPT (fails loudly with owner findings)."""
    r = h.dispatch(op, "CREATE", payload=payload, manual_candidate=cand)
    assert r["status"] == "DRAFT", r
    ref = r["output_refs"][0]
    a = h.approve(ref) if not [f for f in h.validate(ref)["findings"] if f["severity"] == "BLOCKING"] else None
    assert a and a["status"] == "APPROVED", [(f["rule_id"], f["message"]) for f in h.validate(ref)["findings"]]
    return ref


def places(h, ids=("harbor", "lighthouse", "cliffs")):
    cand = {"concept": "Harbor town", "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
            "facts": [fact(i, "entity.name", i.title()) for i in ids]}
    return approved(h, "A04", {"concept": "Harbor town"}, cand)


def character(h, cid="mara", name="Mara Vell", location="harbor", approve=True, extra=(), where=None):
    where = where or places(h)
    cand = {"concept": name, "attributes": {}, "linked_refs": [where], "protected_fact_flags": ["entity.name"],
            "facts": [fact(cid, "entity.name", name), fact(cid, "entity.location_id", location),
                      fact(cid, "entity.inventory_ids", []), *extra]}
    if approve:
        return approved(h, "A01", {"concept": name}, cand)
    return h.dispatch("A01", "CREATE", payload={"concept": name}, manual_candidate=cand)["output_refs"][0]


def build_world(h, chapters=("ch1", "ch2", "ch3")):
    where = places(h)
    a01 = character(h, where=where)
    b01 = approved(h, "B01", {"idea": "i", "goals": ["g"]},
                   {"premise": "p", "dramatic_question": "q?", "concept_summary": "s"})
    plot = {"main_plot": {"summary": "plot", "facts": [], "links": []}, "objectives": [], "plot_obligations": []}
    b03 = approved(h, "B03", {"premise_ref": b01, "canon_refs": [a01, where], "constraints": []}, plot)
    items = [plan_item(c, i, f"objective of {c}", links=[a01] if i == 0 else []) for i, c in enumerate(chapters)]
    outline = approved(h, "B11", {"main_plot_ref": b03, "selected_plan_refs": []},
                       {"chapters": items, "unresolved_threads": []})
    scenes = approved(h, "B12", {"outline_ref": outline, "canon_refs": [a01, where]},
                      {"scenes": [plan_item("s1", 0, "reach the lighthouse", parent=chapters[0])]})
    return {"a01": a01, "outline": outline, "scenes": scenes, "places": where}


def make_context(h, w, chapter="ch1"):
    r = h.create("C01", {"chapter_id": chapter, "outline_ref": w["outline"], "instruction": "write it"})
    assert r["status"] == "DRAFT", r
    return r


def objective_pass(item):
    return {"id": f"obj-{item}", "rule_id": f"OBJECTIVE:{item}", "severity": "INFO", "decision": "PASS",
            "message": "objective met", "evidence": [], "source_refs": [], "confidence": None}


def write_chapter(h, w, text=TEXT, chapter="ch1", findings=(), ctx_ref=None):
    ctx_ref = ctx_ref or make_context(h, w, chapter)["output_refs"][0]
    return h.dispatch("C02", "CREATE", payload={"chapter_id": chapter, "outline_ref": w["outline"],
                                                "context_ref": ctx_ref, "instruction": "write"},
                      manual_candidate={"text": text, "candidate_events": [], "findings": list(findings)})


def raw_events(location_after="lighthouse", t=100, quote="walked from the harbor to the lighthouse"):
    return [
        {"entity_id": "mara", "path": "/location_id", "operation": "SET", "before": "harbor",
         "after": location_after, "story_time": t, "scene_id": "s1", "scene_order": 0, "event_order": 0,
         "evidence": [{"quote": quote}]},
        {"entity_id": "mara", "path": "/inventory_ids", "operation": "ADD", "before": [], "after": ["brass-key"],
         "story_time": t + 10, "scene_id": "s1", "scene_order": 0, "event_order": 1,
         "evidence": [{"quote": "picked up the brass key"}]},
    ]


def accepted_chapter(h, w, text=TEXT, events=None):
    """Accepted C02 prose with its event bundle (manual events); returns (prose_ref, bundle_record)."""
    r = write_chapter(h, w, text=text, findings=[objective_pass("ch1")])
    assert r["status"] == "DRAFT", r
    prose = r["output_refs"][0]
    b = extract_event_bundle(h.engine, PRINCIPAL, prose, events=events if events is not None else raw_events())
    assert b["status"] == "DRAFT", b
    assert h.approve(prose)["status"] == "APPROVED"
    return prose, h.record(b["output_refs"][0])


def k09_approval(h, subject_ref):
    """K09 checkpoint binding subject_ref, then an APPROVED decision by the project owner."""
    payload = {"action_id": "accept-candidate", "impact": {"action_hash": "h" * 8, "source_versions": [subject_ref],
                                                           "protected": True},
               "policy": {"policy_id": "author", "authorized_roles": ["author"], "ttl_seconds": 3600},
               "base_revision": 1}
    r = h.create("K09", payload)
    assert r["status"] == "DRAFT", r
    expiry = (datetime.now(timezone.utc) + timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    u = h.dispatch("K09", "UPDATE", base_ref=r["output_refs"][0],
                   payload=dict(r["result"], decision="APPROVED", expiry=expiry))
    assert u["status"] == "DRAFT", u
    return u["output_refs"][0]


class FakeAI:
    """submit(slot, system, user, schema): prose, events or style depending on the schema asked."""

    def __init__(self, text=TEXT, events=None, fail_extract=None):
        self.text, self.events, self.fail_extract = text, events, fail_extract
        self.calls = {"prose": 0, "events": 0, "other": 0}

    def submit(self, slot, system, user, schema):
        props = schema.get("properties", {})
        usage = {"model": "fake", "input_tokens": 10, "output_tokens": 10}
        if "events" in props:
            self.calls["events"] += 1
            if self.fail_extract:
                raise BookforgeError(self.fail_extract, "", "extraction provider failed")
            return {"events": self.events if self.events is not None else raw_events()}, usage
        if "text" in props:
            self.calls["prose"] += 1
            return {"text": self.text, "objective_assessments": [
                {"item_id": "ch1", "decision": "PASS", "message": "reaches the lighthouse"}]}, usage
        self.calls["other"] += 1
        return {"style_goal": "spare", "style_profile": {"summary": "Close third person, past tense.", "facts": [],
                                                         "links": []}}, usage


def use_ai(h, fake, **slot):
    h.engine.providers.test_adapter = fake
    h.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic", **slot})
    return fake


# ====================================================================== C01
def test_c01_context_package_is_deterministic_and_verbatim(h):
    w = build_world(h)
    r1 = make_context(h, w)
    r2 = make_context(h, w)
    data = r1["result"]
    assert data == r2["result"]  # same pins -> same package (schema record reused)
    prot = data["protected_facts"]
    assert fact("mara", "entity.name", "Mara Vell") in prot  # verbatim protected canon
    preds = {(f["subject_id"], f["predicate"]) for f in data["facts"]}
    assert ("ch1", "plan.objective") in preds and ("mara", "entity.location_id") in preds
    assert data["token_count"] > 0
    schema_rec = h.record(data["output_schema_ref"])
    assert schema_rec["record_kind"] == "OutputSchema" and schema_rec["owner"] == "C"
    assert w["a01"] in r1["source_refs"] and w["outline"] in r1["source_refs"]
    assert h.approve(r1["output_refs"][0])["status"] == "APPROVED"


def test_c01_inputs_and_bindings(h):
    w = build_world(h)
    bad = h.create("C01", {"chapter_id": "ch9", "outline_ref": w["outline"], "instruction": "x"})
    assert errors_of(bad)[0] == ("INVALID_INPUT", "/payload/chapter_id")
    missing = h.create("C01", {"chapter_id": "ch1", "instruction": "x"})
    assert errors_of(missing)[0] == ("MISSING_INPUT", "/payload/outline_ref")
    wrong = h.create("C01", {"chapter_id": "ch1", "outline_ref": w["a01"], "instruction": "x"})
    assert errors_of(wrong)[0] == ("INVALID_INPUT", "/payload/outline_ref/module_id")


def test_c01_unapproved_outline_blocks_acceptance(h):
    w = build_world(h)
    plot = h.record(w["outline"])["data"]
    draft = h.dispatch("B11", "UPDATE", base_ref=w["outline"], payload=plot)["output_refs"][0]
    r = h.create("C01", {"chapter_id": "ch1", "outline_ref": draft, "instruction": "x"})
    v = h.validate(r["output_refs"][0])
    assert v["status"] == "DRAFT" and any(f["rule_id"] == "OUTLINE_APPROVAL" for f in v["findings"])


def test_c01_budget_omits_optional_then_blocks_mandatory(h):
    w = build_world(h)
    full = make_context(h, w)["result"]["token_count"]
    use_ai(h, FakeAI(), context_limit_tokens=full - 1, max_output_tokens=0)
    r = make_context(h, w)
    assert r["result"]["token_count"] <= full - 1
    assert any(f["rule_id"] == "OPTIONAL_OMITTED" for f in r["findings"])
    h.engine.providers.configure_slot("AI-1", {"context_limit_tokens": 20})
    tiny = h.create("C01", {"chapter_id": "ch1", "outline_ref": w["outline"], "instruction": "x"})
    assert errors_of(tiny)[0][0] == "CONTEXT_TOO_LARGE"


def test_c01_is_logic_only(h):
    w = build_world(h)
    r = h.dispatch("C01", "CREATE", payload={"chapter_id": "ch1", "outline_ref": w["outline"], "instruction": "x"},
                   manual_candidate={"facts": [], "protected_facts": [], "output_schema_ref": w["outline"],
                                     "token_count": 0})
    assert errors_of(r)[0] == ("INVALID_INPUT", "/manual_candidate")


# ====================================================================== prose + event bundles
def test_manual_prose_then_resumable_manual_extraction(h):
    w = build_world(h)
    r = write_chapter(h, w)
    assert r["status"] == "DRAFT" and len(r["output_refs"]) == 1
    assert r["result"]["candidate_events"] == []
    assert "C02:event_extraction" in r["unresolved_requests"]
    prose = r["output_refs"][0]
    no_ai = extract_event_bundle(h.engine, PRINCIPAL, prose)
    assert no_ai["status"] == "BLOCKED" and errors_of(no_ai)[0][0] == "CAPABILITY_UNAVAILABLE"
    b = extract_event_bundle(h.engine, PRINCIPAL, prose, events=raw_events())
    assert b["status"] == "DRAFT"
    bundle = h.record(b["output_refs"][0])
    assert bundle["record_kind"] == "CEventBundle" and bundle["owner"] == "C" and bundle["module_id"] == "C02"
    assert bundle["data"]["prose_ref"] == prose and bundle["source_refs"] == [prose]
    for ev in bundle["data"]["events"]:
        assert ev["source_ref"] == prose and ev["status"] == "CANDIDATE" and ev["entity_ids"] == ["mara"]
        for sp in ev["evidence"]:
            assert sp["record_ref"] == prose
            assert sp["text_hash"] == hashlib.sha256(TEXT[sp["start"]:sp["end"]].encode()).hexdigest()
    denied = extract_event_bundle(h.engine, "intruder", prose, events=raw_events())
    assert errors_of(denied)[0][0] == "PERMISSION_DENIED"
    again = extract_event_bundle(h.engine, PRINCIPAL, prose, events=raw_events())
    assert again["output_refs"] == b["output_refs"]  # duplicate delivery replays the same bundle ID
    assert len(find_bundles(h.store, h.project_id, "main", prose)) == 1
    assert h.record(prose)["data"]["candidate_events"] == []  # prose unchanged


def test_unicode_code_point_spans_and_reanchoring(h):
    w = build_world(h)
    text = "Ñandú 🙂 Mara walked from the harbor to the lighthouse. She picked up the brass key."
    prose = write_chapter(h, w, text=text)["output_refs"][0]
    evs = raw_events()
    evs[0]["evidence"] = [{"start": 0, "end": 3, "quote": "walked from the harbor to the lighthouse"}]  # stale offsets
    evs.append(dict(evs[0], path="/mood", evidence=[{"quote": "Mara"}]))   # unregistered path
    evs.append(dict(evs[0], evidence=[{"quote": "the"}]))                  # ambiguous quote
    b = extract_event_bundle(h.engine, PRINCIPAL, prose, events=evs)
    data = h.record(b["output_refs"][0])["data"]
    assert len(data["events"]) == 2
    sp = data["events"][0]["evidence"][0]
    assert text[sp["start"]:sp["end"]] == "walked from the harbor to the lighthouse"
    assert sp["start"] == text.index("walked")  # code points: the emoji counts once
    rules = {f["rule_id"] for f in data["extraction_findings"]}
    assert {"UNKNOWN_PREDICATE", "SPAN_CONFLICT"} <= rules


def test_ai_prose_and_bundle_share_one_receipt(h):
    w = build_world(h)
    fake = use_ai(h, FakeAI())
    ctx_ref = make_context(h, w)["output_refs"][0]
    req = h.request("C02", "CREATE", payload={"chapter_id": "ch1", "outline_ref": w["outline"],
                                              "context_ref": ctx_ref, "instruction": "write"})
    r = h.engine.dispatch(req, PRINCIPAL)
    assert r["status"] == "DRAFT", r
    prose, bundle_ref = r["output_refs"]
    assert r["result"]["candidate_events"] == [] and r["result"]["text"] == TEXT
    bundle = h.record(bundle_ref)
    assert bundle["record_kind"] == "CEventBundle" and bundle["data"]["prose_ref"] == prose
    assert h.record(prose)["content_hash"] == prose["content_hash"]  # predicted pin is the stored pin
    assert all(ev["source_ref"] == prose for ev in bundle["data"]["events"])
    count = h.store.query_one("SELECT COUNT(*) c FROM records")["c"]
    again = h.engine.dispatch(req, PRINCIPAL)
    assert again["output_refs"] == r["output_refs"]
    assert h.store.query_one("SELECT COUNT(*) c FROM records")["c"] == count
    assert fake.calls["prose"] == 1 and fake.calls["events"] == 1
    assert any(f["rule_id"] == "OBJECTIVE:ch1" and f["decision"] == "PASS" for f in r["result"]["findings"])


def test_extraction_failure_keeps_prose_and_retries_without_regeneration(h):
    w = build_world(h)
    fake = use_ai(h, FakeAI(fail_extract="TIMEOUT"))
    ctx_ref = make_context(h, w)["output_refs"][0]
    r = h.create("C02", {"chapter_id": "ch1", "outline_ref": w["outline"], "context_ref": ctx_ref,
                         "instruction": "write"})
    assert r["status"] == "DRAFT" and len(r["output_refs"]) == 1
    assert any(f["rule_id"] == "EVENT_EXTRACTION_PENDING" for f in r["findings"])
    prose = r["output_refs"][0]
    assert h.record(prose)["lifecycle"] == "DRAFT"
    fake.fail_extract = None
    b = extract_event_bundle(h.engine, PRINCIPAL, prose)
    assert b["status"] == "DRAFT" and len(b["result"]["events"]) == 2
    assert fake.calls["prose"] == 1  # paid prose generation was not repeated


def test_no_ai_slot_holds_creative_prose(h):
    w = build_world(h)
    ctx_ref = make_context(h, w)["output_refs"][0]
    r = h.create("C02", {"chapter_id": "ch1", "outline_ref": w["outline"], "context_ref": ctx_ref,
                         "instruction": "write"})
    assert r["status"] == "BLOCKED" and errors_of(r)[0][0] == "CAPABILITY_UNAVAILABLE"
    assert "C02:manual_candidate" in r["unresolved_requests"]


def test_prose_output_never_carries_inline_events(h):
    w = build_world(h)
    prose, bundle = accepted_chapter(h, w)
    r = write_chapter(h, w)
    cand = {"text": TEXT, "candidate_events": [bundle["data"]["events"][0]], "findings": []}
    bad = h.dispatch("C02", "CREATE", payload={"chapter_id": "ch1", "outline_ref": w["outline"],
                                               "context_ref": make_context(h, w)["output_refs"][0],
                                               "instruction": "w"}, manual_candidate=cand)
    assert errors_of(bad)[0][0] == "INVALID_INPUT" and r["status"] == "DRAFT"
    # a bundle cannot stand in for prose input
    c11 = h.create("C11", {"passage_id": bundle["record_id"], "rewrite_goal": "g", "instruction": "i",
                           "passage_ref": bundle["ref"]})
    assert errors_of(c11)[0] == ("INVALID_INPUT", "/payload/passage_ref")


def test_c02_context_must_match_chapter(h):
    w = build_world(h)
    ctx2 = make_context(h, w, "ch2")["output_refs"][0]
    r = write_chapter(h, w, ctx_ref=ctx2)
    assert errors_of(r)[0] == ("INVALID_INPUT", "/payload/context_ref")


# ====================================================================== acceptance
def test_objective_review_and_exact_candidate_approval(h):
    w = build_world(h)
    prose = write_chapter(h, w)["output_refs"][0]
    v = h.validate(prose)
    assert v["status"] == "VALIDATED" and any(f["rule_id"] == "OBJECTIVE_REVIEW" for f in v["findings"])
    a = h.accept(prose)
    assert errors_of(a)[0] == ("APPROVAL_REQUIRED", "/payload/approval_ref")
    other = write_chapter(h, w)["output_refs"][0]
    wrong = h.accept(prose, k09_approval(h, other))
    # The kernel refuses an approval that binds a different candidate before the C gate runs.
    assert wrong["status"] == "BLOCKED" and errors_of(wrong)[0] == ("APPROVAL_REQUIRED", "/payload/approval_ref")
    ok = h.accept(prose, k09_approval(h, prose))
    assert ok["status"] == "APPROVED"
    state = h.store.get_state(h.project_id, "main", "c_manuscript", "chapter:ch1")
    assert state["ref"] == prose


def test_failed_objective_blocks(h):
    w = build_world(h)
    failed = dict(objective_pass("ch1"), decision="FAIL", severity="MAJOR", message="never reaches it")
    prose = write_chapter(h, w, findings=[failed])["output_refs"][0]
    v = h.validate(prose)
    assert v["status"] == "DRAFT" and any(f["rule_id"] == "OBJECTIVE_UNSATISFIED" for f in v["findings"])


def test_protected_contradiction_never_auto_approves(h):
    w = build_world(h)
    flag = {"id": "p1", "rule_id": "PROTECTED:mara.entity.name", "severity": "BLOCKING", "decision": "FAIL",
            "message": "calls her Mira", "evidence": [], "source_refs": [], "confidence": None}
    prose = write_chapter(h, w, findings=[objective_pass("ch1"), flag])["output_refs"][0]
    a = h.accept(prose, k09_approval(h, prose))
    assert a["status"] == "DRAFT" and errors_of(a)[0][0] == "APPROVAL_REQUIRED"


def test_c11_rewrite_requires_exact_approval_and_supersedes(h):
    w = build_world(h)
    prose, bundle = accepted_chapter(h, w)
    mismatch = h.create("C11", {"passage_id": "other", "rewrite_goal": "tighten", "instruction": "i",
                                "passage_ref": prose})
    assert errors_of(mismatch)[0] == ("INVALID_INPUT", "/payload/passage_id")
    new_text = "Mara climbed from the harbor to the cliffs. She picked up the brass key."
    r = h.dispatch("C11", "CREATE", payload={"passage_id": prose["record_id"], "rewrite_goal": "tighten",
                                              "instruction": "i", "passage_ref": prose},
                   manual_candidate={"text": new_text, "candidate_events": [], "findings": []})
    cand = r["output_refs"][0]
    assert errors_of(h.accept(cand))[0][0] == "APPROVAL_REQUIRED"
    blocked = h.accept(cand, k09_approval(h, prose))  # approval of the source is not approval of the change
    assert blocked["status"] == "BLOCKED"
    assert h.accept(cand, k09_approval(h, cand))["status"] == "APPROVED"
    assert h.record(prose)["lifecycle"] == "SUPERSEDED"
    assert h.record(bundle["ref"])["stale"] is True
    assert h.store.get_state(h.project_id, "main", "c_manuscript", "chapter:ch1")["ref"] == cand
    ev = h.store.query_one("SELECT payload FROM outbox WHERE event_type='c.prose_replaced'")
    import json
    assert sorted(json.loads(ev["payload"])["superseded_event_ids"]) == sorted(
        e["event_id"] for e in bundle["data"]["events"])


# ====================================================================== C06 / C09 / C10
def action_payload(w, **kw):
    return {"scene_id": "s1", "action_plan_ref": w["scenes"], "instruction": "fight", **kw}


def test_c06_nonmagical_action_needs_no_power_rules(h):
    w = build_world(h)
    assert h.store.feature_manifest(h.project_id, "main")["features"]["magic"] is False
    cand = {"text": "Mara ducked the swinging boom.", "candidate_events": [], "findings": []}
    r = h.dispatch("C06", "CREATE", payload=action_payload(w, uses_magic=False), manual_candidate=cand)
    assert r["status"] == "DRAFT", r
    v = h.validate(r["output_refs"][0])
    assert v["status"] == "VALIDATED"
    m = h.dispatch("C06", "CREATE", payload=action_payload(w, uses_magic=True), manual_candidate=cand)
    assert errors_of(m)[0] == ("MISSING_INPUT", "/payload/power_rules_ref")
    c = h.dispatch("C06", "CREATE", payload=action_payload(w, is_combat=True), manual_candidate=cand)
    assert errors_of(c)[0] == ("MISSING_INPUT", "/payload/combat_rules_ref")


def test_c06_combat_rules_must_be_approved_canon(h):
    w = build_world(h)
    a11 = {"concept": "Harbor brawling", "attributes": {}, "linked_refs": [], "protected_fact_flags": [], "facts": []}
    draft = h.dispatch("A11", "CREATE", payload={"concept": "Harbor brawling"}, manual_candidate=a11)["output_refs"][0]
    cand = {"text": "Mara swung the oar.", "candidate_events": [], "findings": []}
    r = h.dispatch("C06", "CREATE", payload=action_payload(w, is_combat=True, combat_rules_ref=draft),
                   manual_candidate=cand)
    assert r["status"] == "DRAFT", r
    v = h.validate(r["output_refs"][0])
    assert v["status"] == "DRAFT" and any(f["rule_id"] == "RULE_AUTHORITY" for f in v["findings"])
    wrong_scene = h.dispatch("C06", "CREATE", payload=dict(action_payload(w), scene_id="s9"), manual_candidate=cand)
    assert errors_of(wrong_scene)[0] == ("INVALID_INPUT", "/payload/scene_id")


def boundary(h, op, w, chapter, position, **refs):
    cand = {"text": f"{op} text for {chapter}", "candidate_events": [], "findings": []}
    payload = {"chapter_id": chapter, "outline_ref": w["outline"], "instruction": "i", "chapter_position": position,
               **refs}
    return h.dispatch(op, "CREATE", payload=payload, manual_candidate=cand)


def test_first_and_last_chapter_boundaries(h):
    w = build_world(h)
    prior, bundle = accepted_chapter(h, w)
    assert boundary(h, "C09", w, "ch1", "FIRST")["status"] == "DRAFT"
    assert errors_of(boundary(h, "C09", w, "ch1", "FIRST", previous_ending_ref=prior))[0] == \
        ("INVALID_INPUT", "/payload/previous_ending_ref")
    assert errors_of(boundary(h, "C09", w, "ch2", "MIDDLE"))[0] == ("MISSING_INPUT", "/payload/previous_ending_ref")
    assert errors_of(boundary(h, "C09", w, "ch2", "FIRST"))[0] == ("INVALID_INPUT", "/payload/chapter_position")
    assert boundary(h, "C09", w, "ch2", "MIDDLE", previous_ending_ref=prior)["status"] == "DRAFT"
    assert errors_of(boundary(h, "C09", w, "ch2", "MIDDLE", previous_ending_ref=bundle["ref"]))[0] == \
        ("INVALID_INPUT", "/payload/previous_ending_ref")
    assert boundary(h, "C10", w, "ch3", "LAST")["status"] == "DRAFT"
    assert errors_of(boundary(h, "C10", w, "ch3", "LAST", next_chapter_ref=w["outline"]))[0] == \
        ("INVALID_INPUT", "/payload/next_chapter_ref")
    assert errors_of(boundary(h, "C10", w, "ch1", "FIRST"))[0] == ("MISSING_INPUT", "/payload/next_chapter_ref")
    assert boundary(h, "C10", w, "ch1", "FIRST", next_chapter_ref=w["outline"])["status"] == "DRAFT"


def test_only_chapter_position(h):
    w = build_world(h, chapters=("solo",))
    assert boundary(h, "C09", w, "solo", "ONLY")["status"] == "DRAFT"
    assert boundary(h, "C10", w, "solo", "ONLY")["status"] == "DRAFT"
    assert errors_of(boundary(h, "C10", w, "solo", "LAST"))[0] == ("INVALID_INPUT", "/payload/chapter_position")


def test_c08_transition_flags_events(h):
    w = build_world(h)
    r = h.dispatch("C08", "CREATE", payload={"from_scene_id": "s1", "to_scene_id": "s2", "transition_goal": "time",
                                             "instruction": "i"},
                   manual_candidate={"text": TEXT, "candidate_events": [], "findings": []})
    b = extract_event_bundle(h.engine, PRINCIPAL, r["output_refs"][0], events=raw_events())
    assert any(f["rule_id"] == "TRANSITION_EVENT" for f in b["result"]["extraction_findings"])
    same = h.dispatch("C08", "CREATE", payload={"from_scene_id": "s1", "to_scene_id": "s1", "transition_goal": "t",
                                                "instruction": "i"},
                      manual_candidate={"text": TEXT, "candidate_events": [], "findings": []})
    assert errors_of(same)[0] == ("INVALID_INPUT", "/payload/to_scene_id")
    assert w


# ====================================================================== C12
def test_c12_text_style_scope_feeds_context(h):
    w = build_world(h)
    style = {"style_goal": "spare", "style_profile": {"summary": "Close third, past tense.", "facts": [
        fact("project", "x.c12.tense", "past")], "links": []}}
    mism = h.dispatch("C12", "CREATE", payload={"style_goal": "lush", "scope_id": "project", "instruction": "i"},
                      manual_candidate=style)
    assert errors_of(mism)[0] == ("INVALID_INPUT", "/manual_candidate/style_goal")
    ref, _ = h.create_approved("C12", {"style_goal": "spare", "scope_id": "project", "instruction": "i"},
                               manual_candidate=style)
    data = make_context(h, w)["result"]
    assert fact("project", "x.c12.tense", "past") in data["facts"]
    assert h.store.get_state(h.project_id, "main", "c_style", "project")["ref"] == ref


def test_c12_ai_profile_cannot_invent_references(h):
    use_ai(h, FakeAI())
    r = h.create("C12", {"style_goal": "spare", "scope_id": "ch1", "instruction": "i"})
    assert r["status"] == "DRAFT", r
    assert r["result"]["style_profile"]["links"] == []
