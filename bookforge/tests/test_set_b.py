"""Set B (Story Plot) staged planning: plan-item closure rules, gates, partitions and AI/manual paths."""
from __future__ import annotations

import json

from conftest import errors_of


def fact(subject, predicate, value, kind="PLAN", frm=None, to=None):
    return {"subject_id": subject, "predicate": predicate, "value": value, "assertion_type": kind,
            "effective_from": frm, "effective_to": to, "source_refs": []}


def item(item_id, order, objective, parent=None, unit=None, at=None, **plan):
    """One plan item SemanticRecord; unit=(events, pov, location, obligations) for chapters/scenes."""
    facts = [fact(item_id, "plan.item_id", item_id, frm=at), fact(item_id, "plan.order", order),
             fact(item_id, "plan.parent_id", parent), fact(item_id, "plan.objective", objective)]
    if unit is not None:
        ev, pov, loc, obl = unit
        facts += [fact(item_id, "plan.event_ids", ev), fact(item_id, "plan.pov_id", pov),
                  fact(item_id, "plan.location_id", loc), fact(item_id, "plan.obligation_ids", obl)]
    for pred, value in plan.items():
        facts.append(fact(item_id, f"plan.{pred}", value))
    return {"summary": objective, "facts": facts, "links": []}


def rules(resp, severity=None):
    return {f["rule_id"] for f in resp["findings"] if severity is None or f["severity"] == severity}


class FakeAdapter:
    def __init__(self, output):
        self.output, self.calls = output, []

    def submit(self, slot, system, user, schema):
        self.calls.append((system, json.loads(user.split("\n", 1)[1])))
        return self.output, {"model": "fake", "input_tokens": 1, "output_tokens": 1}


def use_ai(h, output):
    fake = FakeAdapter(output)
    h.engine.providers.test_adapter = fake
    h.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
    return fake


def canon(h):
    """Approved A01 character and A04 location the plans may name."""
    mara, _ = h.create_approved("A01", {"concept": "Mara", "facts": [
        {"subject_id": "char-mara", "predicate": "entity.name", "value": "Mara", "assertion_type": "FACT",
         "effective_from": None, "effective_to": None, "source_refs": []}],
        "protected_fact_flags": ["char-mara"]})
    harbor, _ = h.create_approved("A04", {"concept": "Harbor", "facts": [
        {"subject_id": "loc-harbor", "predicate": "entity.name", "value": "Gull Harbor", "assertion_type": "FACT",
         "effective_from": None, "effective_to": None, "source_refs": []}]})
    return mara, harbor


def foundation(h, canon_refs=()):
    """Approved B01 premise and B03 main plot with events e1 -> e2 and obligations obl-1/obl-2."""
    p_ref, _ = h.create_approved("B01", {"idea": "a keeper hears the sea", "goals": []}, manual_candidate={
        "premise": "A keeper hears the drowned.", "dramatic_question": "Will she answer?", "concept_summary": "Sea"})
    plot = {"main_plot": {"summary": "Mara finds the bell, then rings it.", "links": [], "facts": [
        fact("e1", "plan.item_id", "e1", frm=10), fact("e1", "plan.objective", "Mara finds the bell"),
        fact("e2", "plan.item_id", "e2", frm=20), fact("e2", "plan.objective", "Mara rings the bell"),
        fact("e2", "plan.predecessor_ids", ["e1"])]},
        "objectives": ["the bell rings"], "plot_obligations": ["obl-1", "obl-2"]}
    r = h.dispatch("B03", "CREATE", payload={"premise_ref": p_ref, "canon_refs": list(canon_refs), "constraints": []},
                   manual_candidate=plot)
    assert r["status"] == "DRAFT", r
    assert h.approve(r["output_refs"][0])["status"] == "APPROVED"
    return r["output_refs"][0]


def chapters(pov="char-mara", loc="loc-harbor"):
    return {"chapters": [item("ch-1", 0, "Mara finds the bell", unit=(["e1"], pov, loc, ["obl-1"])),
                         item("ch-2", 1, "Mara rings the bell", unit=(["e2"], pov, loc, ["obl-2"]))],
            "unresolved_threads": []}


def outline(h, main, manual=None, **payload):
    return h.dispatch("B11", "CREATE", payload=dict({"main_plot_ref": main, "selected_plan_refs": []}, **payload),
                      manual_candidate=manual or chapters())


def test_creative_ops_hold_without_ai_and_never_fabricate(h):
    r = h.create("B01", {"idea": "a keeper hears the sea", "goals": []})
    assert r["status"] == "BLOCKED" and errors_of(r)[0][0] == "CAPABILITY_UNAVAILABLE"
    assert r["unresolved_requests"] == ["B01:manual_candidate"]
    assert h.store.query_one("SELECT COUNT(*) c FROM records")["c"] == 0
    main = foundation(h)
    sub = h.create("B04", {"main_plot_ref": main})
    assert sub["status"] == "BLOCKED"  # an empty subplot list would be a fabricated "known empty"


def test_walkthrough_without_prose_or_optional_features(h):
    mara, harbor = canon(h)
    main = foundation(h, canon_refs=[mara, harbor])
    assert h.create("B08", {"main_plot_ref": main, "feature_selected": False})["status"] == "NOT_APPLICABLE"
    assert h.create("B09", {"main_plot_ref": main, "feature_selected": False})["status"] == "NOT_APPLICABLE"
    o = outline(h, main, target_length={"value": 2, "unit": "chapters"})
    assert o["status"] == "DRAFT", o
    assert not rules(o, "BLOCKING"), o["findings"]
    assert h.approve(o["output_refs"][0])["status"] == "APPROVED"
    end = h.dispatch("B14", "CREATE", payload={"plot_refs": [main], "resolution_goals": ["close the bell"]},
                     manual_candidate={"ending": {"summary": "The bell tolls once.", "links": [], "facts": [
                         fact("obl-1", "plan.resolution", "PLANNED_RESOLVED"),
                         fact("obl-2", "plan.resolution", "INTENTIONALLY_UNRESOLVED")]},
                         "resolved_obligation_ids": ["obl-1"], "unresolved_obligation_ids": ["obl-2"]})
    assert end["status"] == "DRAFT" and "INTENTIONALLY_UNRESOLVED" in rules(end)
    assert h.approve(end["output_refs"][0])["status"] == "APPROVED"


def test_outline_closure_rules(h):
    main = foundation(h)
    bad = {"chapters": [
        item("ch-1", 0, "find", unit=(["e1"], None, None, ["obl-9"])),
        {"summary": "dup order", "links": [], "facts": [
            fact("ch-2", "plan.item_id", "ch-X"), fact("ch-2", "plan.order", 0), fact("ch-2", "plan.parent_id", None),
            fact("ch-2", "plan.objective", "ring")]},
        {"summary": "prose only", "links": [], "facts": []},
        item("ch-4", 3, "", unit=(["e2"], None, None, []))],
        "unresolved_threads": []}
    o = outline(h, main, manual=bad, target_length={"value": 3, "unit": "chapters"})
    assert o["status"] == "DRAFT"  # drafts are kept with findings
    blocking = rules(o, "BLOCKING")
    assert {"PLAN_REF_UNKNOWN", "PLAN_ITEM_ID", "PLAN_ORDER_DUPLICATE", "PLAN_FIELD_MISSING",
            "PLAN_OBJECTIVE_UNKNOWN", "TARGET_LENGTH", "PLAN_UNDECIDED"} <= blocking
    assert "OBLIGATION_UNPLACED" in rules(o)
    v = h.validate(o["output_refs"][0])
    assert v["status"] == "DRAFT" and "TARGET_LENGTH" in rules(v)  # target pinned in module state
    # UPDATE keeps the lineage's input pins: the unknown obligation is still detected.
    u = h.dispatch("B11", "UPDATE", base_ref=o["output_refs"][0], payload=bad)
    assert "PLAN_REF_UNKNOWN" in rules(u, "BLOCKING")


def test_undecided_pov_blocks_only_when_prose_selected(h):
    main = foundation(h)
    o = outline(h, main, manual=chapters(pov=None, loc=None))
    assert "PLAN_UNDECIDED" in rules(o, "BLOCKING")
    m = dict(h.store.feature_manifest(h.project_id, "main"))
    m["required_operations"] = [op for op in m["required_operations"] if not op.startswith("C")]
    h.engine.set_manifest(h.principal, h.project_id, "main", m)
    o2 = outline(h, main, manual=chapters(pov=None, loc=None))
    assert "PLAN_UNDECIDED" in rules(o2, "INFO") and not rules(o2, "BLOCKING")
    # A decided POV must resolve to pinned A01 canon (none pinned here).
    o3 = outline(h, main, manual=chapters(pov="char-ghost", loc=None))
    assert "CANON_UNRESOLVED" in rules(o3, "BLOCKING")


def test_mystery_selected_gates_final_outline(h):
    h.set_features(mystery=True)
    main = foundation(h)
    bad = h.create("B08", {"main_plot_ref": main, "feature_selected": False})
    assert bad["status"] == "REJECTED" and errors_of(bad)[0] == ("INVALID_INPUT", "/payload/feature_selected")
    m = dict(h.store.feature_manifest(h.project_id, "main"))
    m["required_operations"] = [op for op in m["required_operations"] if not op.startswith("C")]
    h.engine.set_manifest(h.principal, h.project_id, "main", m)
    first = outline(h, main, manual=chapters(pov=None, loc=None))
    assert first["status"] == "DRAFT"  # the first B11 does not wait for B08
    gate = h.accept(first["output_refs"][0])
    assert gate["status"] == "BLOCKED" and "SELECTED_PLAN_MISSING" in rules(gate)
    reveals = h.dispatch("B08", "CREATE", payload={"main_plot_ref": main, "feature_selected": True},
                         manual_candidate={"reveals": [
                             item("clue-1", 0, "bell has a crack", at=5),
                             item("rev-1", 1, "the drowned are kin", at=15, predecessor_ids=["clue-1", "e1"])]})
    assert reveals["status"] == "DRAFT" and not rules(reveals, "BLOCKING"), reveals["findings"]
    assert h.approve(reveals["output_refs"][0])["status"] == "APPROVED"
    final = outline(h, main, manual=chapters(pov=None, loc=None), selected_plan_refs=[reveals["output_refs"][0]])
    assert h.approve(final["output_refs"][0])["status"] == "APPROVED"
    # Disabling mystery makes B08 an unselected output for later plans.
    h.set_features(mystery=False)
    r = outline(h, main, selected_plan_refs=[reveals["output_refs"][0]])
    assert r["status"] == "REJECTED" and errors_of(r)[0] == ("INVALID_INPUT", "/payload/selected_plan_refs/0")


def test_b10_deterministic_chronology_and_impossible_precedence(h):
    main = foundation(h)
    r = h.create("B10", {"main_plot_ref": main})
    assert r["status"] == "DRAFT"
    events = r["result"]["events"]
    assert [e["summary"] for e in events] == ["Mara finds the bell", "Mara rings the bell"]
    ids = [[f for f in e["facts"] if f["predicate"] == "plan.item_id"][0] for e in events]
    assert [(f["value"], f["effective_from"]) for f in ids] == [("e1", 10), ("e2", 20)]
    assert "PLAN_FIELD_MISSING" in rules(r, "BLOCKING")  # e1 never declared its predecessors: not invented
    bad = h.dispatch("B10", "CREATE", payload={"main_plot_ref": main}, manual_candidate={"events": [
        item("e1", 0, "find", at=30, predecessor_ids=[]), item("e2", 1, "ring", at=20, predecessor_ids=["e1"])]})
    assert "IMPOSSIBLE_PRECEDENCE" in rules(bad, "BLOCKING")
    cyc = h.dispatch("B10", "CREATE", payload={"main_plot_ref": main}, manual_candidate={"events": [
        item("e1", 0, "find", predecessor_ids=["e2"]), item("e2", 1, "ring", predecessor_ids=["e1"])]})
    assert "CAUSAL_CYCLE" in rules(cyc, "BLOCKING")
    partial = h.dispatch("B10", "CREATE", payload={"main_plot_ref": main}, manual_candidate={"events": [
        item("e1", 0, "find", at=10, predecessor_ids=[])]})
    assert "EVENT_ID_MISSING" in rules(partial)


def test_b10_catalog_is_authoritative_for_outline_events(h):
    main = foundation(h)
    b10 = h.dispatch("B10", "CREATE", payload={"main_plot_ref": main}, manual_candidate={"events": [
        item("e1", 0, "find", at=10, predecessor_ids=[]), item("e2", 1, "ring", at=20, predecessor_ids=["e1"])]})
    assert not rules(b10, "BLOCKING")
    manual = chapters(pov=None, loc=None)
    manual["chapters"][1] = item("ch-2", 1, "ring", unit=(["e2", "e7"], None, None, ["obl-2"]))
    o = outline(h, main, manual=manual, selected_plan_refs=[b10["output_refs"][0]])
    assert any(f["rule_id"] == "PLAN_REF_UNKNOWN" and "e7" in f["message"] for f in o["findings"])


def test_b12_scenes_follow_outline(h):
    mara, harbor = canon(h)
    main = foundation(h, canon_refs=[mara, harbor])
    o = outline(h, main)
    scenes = {"scenes": [
        item("sc-1", 0, "climb the tower", parent="ch-1", unit=(["e1"], "char-mara", "loc-harbor", ["obl-1"])),
        item("sc-2", 1, "ring early", parent="ch-1", unit=(["e2"], "char-mara", "loc-harbor", [])),
        item("sc-3", 0, "lost", parent="ch-9", unit=([], "char-mara", "loc-harbor", []))]}
    r = h.dispatch("B12", "CREATE", payload={"outline_ref": o["output_refs"][0], "canon_refs": [mara, harbor]},
                   manual_candidate=scenes)
    assert {"SCENE_EVENT", "SCENE_PARENT"} <= rules(r, "BLOCKING")
    good = h.dispatch("B12", "CREATE", payload={"outline_ref": o["output_refs"][0], "canon_refs": [mara, harbor]},
                      manual_candidate={"scenes": scenes["scenes"][:1]})
    assert not rules(good, "BLOCKING"), good["findings"]
    assert h.approve(good["output_refs"][0])["status"] == "APPROVED"


def test_b13_deterministic_pacing(h):
    main = foundation(h)
    o = outline(h, main)["output_refs"][0]
    targets = {"summary": "at most one event per chapter, two scenes", "links": [], "facts": [
        fact("*", "x.b13.max_events", 0), fact("ch-1", "x.b13.min_scenes", 2), fact("*", "x.vibes.tension", 9)]}
    r = h.create("B13", {"outline_ref": o, "length_targets": targets})
    assert r["status"] == "DRAFT"
    assert r["result"]["pacing_targets"] == [targets]
    assert r["result"]["pacing_warnings"] == [
        "chapter 'ch-1': 1 events above x.b13.max_events=0", "chapter 'ch-2': 1 events above x.b13.max_events=0",
        "scene counts unknown: no B12 scene plans pinned"]
    assert "PREDICATE_UNSUPPORTED" in rules(r)
    assert h.validate(r["output_refs"][0])["status"] == "VALIDATED"
    hidden = h.dispatch("B13", "UPDATE", base_ref=r["output_refs"][0], payload=dict(r["result"], pacing_warnings=[]))
    assert "PACING_WARNING_MISSING" in rules(hidden, "BLOCKING")


def test_b14_obligation_partition_and_observed_mismatch(h):
    main = foundation(h)
    bad = h.dispatch("B14", "CREATE", payload={"plot_refs": [main], "resolution_goals": []}, manual_candidate={
        "ending": {"summary": "End.", "links": [], "facts": [fact("obl-1", "thread.resolution", "OBSERVED_RESOLVED")]},
        "resolved_obligation_ids": ["obl-1", "obl-9"], "unresolved_obligation_ids": ["obl-1"]})
    assert {"OBLIGATION_PARTITION", "OBLIGATION_UNKNOWN", "OBLIGATION_UNPLANNED",
            "OBSERVED_CLAIM"} <= rules(bad, "BLOCKING")
    # Synthetic E09 fixture: observed state says obl-1 is still unresolved after prose.
    e09 = {"entity_id": "obl-1", "snapshot": {"summary": "observed", "links": [], "facts": [
        fact("obl-1", "thread.resolution", "UNRESOLVED", kind="FACT")]},
        "accepted_event_ids": [], "superseded_event_ids": [], "findings": [], "affected_refs": []}
    with h.store.transaction() as tx:
        e_ref = tx.insert_json_record(project_id=h.project_id, branch_id="main", module_id="E09",
                                      record_id="E09-fixture", version=1, data=e09, source_refs=[],
                                      principal_id=h.principal, evidence_origin="FIXTURE")
    planned = {"ending": {"summary": "The bell tolls.", "links": [], "facts": []},
               "resolved_obligation_ids": ["obl-1", "obl-2"], "unresolved_obligation_ids": []}
    r = h.dispatch("B14", "CREATE", payload={"plot_refs": [main], "resolution_goals": [],
                                             "observed_state_refs": [e_ref]}, manual_candidate=planned)
    mismatch = [f for f in r["findings"] if f["rule_id"] == "OBSERVED_MISMATCH"]
    assert mismatch and mismatch[0]["severity"] == "MAJOR" and mismatch[0]["source_refs"] == [e_ref]
    assert r["result"]["resolved_obligation_ids"] == ["obl-1", "obl-2"]  # plan is never rewritten as observed


def test_b06_structure_model_and_ai_paths(h):
    mara, harbor = canon(h)
    main = foundation(h, canon_refs=[mara, harbor])
    mismatch = h.dispatch("B06", "CREATE", payload={"main_plot_ref": main, "selected_structure": "three-act"},
                          manual_candidate={"acts": [], "structure_model": "five-act"})
    assert errors_of(mismatch)[0] == ("INVALID_INPUT", "/manual_candidate/structure_model")
    fake = use_ai(h, {"acts": [item("act-1", 0, "setup", event_ids=["e1"])],
                      "structure_model": "something else"})
    r = h.create("B06", {"main_plot_ref": main, "selected_structure": "three-act"})
    assert r["status"] == "DRAFT", r["errors"]
    assert r["result"]["structure_model"] == "three-act"  # logic field is never taken from the model
    system, package = fake.calls[0]
    assert "plan.item_id" in system and "B06" in system
    assert package["context"]["known_ids"]["obligation_ids"] == ["obl-1", "obl-2"]
    assert package["context"]["known_ids"]["event_ids"] == ["e1", "e2"]
    assert package["context"]["known_ids"]["character_ids"][-1] == "char-mara"
    assert package["protected_facts"] and package["protected_facts"][0]["subject_id"] == "char-mara"
    fake.output = {"chapters": chapters()["chapters"], "unresolved_threads": []}
    o = h.create("B11", {"main_plot_ref": main, "selected_plan_refs": [],
                         "target_length": {"value": 60000, "unit": "words"}})
    assert o["status"] == "DRAFT" and not rules(o, "BLOCKING"), o["findings"]
    assert h.store.query_one("SELECT transform FROM provenance ORDER BY rowid DESC LIMIT 1")["transform"] == "AI"
