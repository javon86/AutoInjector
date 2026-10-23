"""Cross-operation checks against the set specifications ("does the check really check").

Each test plants a specific inconsistency and asserts what the spec says must happen:
E (state tracking) chronology/inventory/power limits, A->B/C/E/J ripple after a canon change,
I storage/approval rules, the ACCEPT-stage dependency predicate and K cost control.
"""
from __future__ import annotations

import copy

import pytest

from bookforge import k_runtime as kr
from bookforge.c_events import extract_event_bundle

from conftest import PRINCIPAL, errors_of
from fj_fixtures import canon, fact as fx_fact, k09
from test_set_c import FakeAI, approved, build_world, fact, make_context, objective_pass, use_ai, write_chapter
from test_set_e import accept_ok, e_create, head, initialized, rules


def XFAIL(**kw):  # toggled for the report run
    return (lambda f: f) if __import__("os").environ.get("NOXFAIL") else pytest.mark.xfail(**kw)


# ---------------------------------------------------------------------------- helpers
def ev(path, op, before, after, t, quote, order=0, entity="mara"):
    return {"entity_id": entity, "path": path, "operation": op, "before": before, "after": after, "story_time": t,
            "scene_id": "s1", "scene_order": 0, "event_order": order, "evidence": [{"quote": quote}]}


def chapter(h, w, ch, text, events):
    """Accepted chapter prose with its C-owned event bundle; returns (prose_ref, bundled events)."""
    r = write_chapter(h, w, text=text, chapter=ch, findings=[objective_pass(ch)])
    assert r["status"] == "DRAFT", r
    prose = r["output_refs"][0]
    b = extract_event_bundle(h.engine, PRINCIPAL, prose, events=events)
    assert b["status"] == "DRAFT", b
    assert h.approve(prose)["status"] == "APPROVED"
    return prose, b["result"]["events"]


def locations(snapshot):
    return sorted(((f["value"], f["effective_from"], f["effective_to"]) for f in snapshot["facts"]
                   if f["predicate"] == "entity.location_id"), key=lambda x: (x[1] is not None, x[1] or 0))


# ============================================================================ E: planted contradictions
def test_e07_item_used_after_it_was_lost_is_detected(h):
    w = build_world(h, chapters=("ch1", "ch2", "ch3"))
    _, got = chapter(h, w, "ch1", "Mara picked up the brass key.",
                     [ev("/inventory_ids", "ADD", [], ["brass-key"], 100, "picked up the brass key")])
    _, lost = chapter(h, w, "ch2", "Mara lost the brass key in the sea.",
                      [ev("/inventory_ids", "REMOVE", ["brass-key"], [], 200, "lost the brass key")])
    _, used = chapter(h, w, "ch3", "Mara gave the brass key to Tomas.",
                      [ev("/inventory_ids", "REMOVE", ["brass-key"], [], 300, "gave the brass key to Tomas")])
    start = initialized(h, "E07", "mara", w["a01"])
    r = e_create(h, "E07", "mara", "APPLY", events=got + lost, current_snapshot_ref=start)
    assert r["result"]["accepted_event_ids"] == [got[0]["event_id"], lost[0]["event_id"]]
    accept_ok(h, r["output_refs"][0])
    bad = e_create(h, "E07", "mara", "APPLY", events=used, current_snapshot_ref=head(h, "E07", "mara"))
    assert "BEFORE_MISMATCH" in rules(bad)
    assert used[0]["event_id"] not in bad["result"]["accepted_event_ids"]
    assert h.accept(bad["output_refs"][0])["status"] != "APPROVED"


def test_e07_lost_then_used_in_one_batch_is_detected(h):
    w = build_world(h, chapters=("ch1", "ch2", "ch3"))
    _, got = chapter(h, w, "ch1", "Mara picked up the brass key.",
                     [ev("/inventory_ids", "ADD", [], ["brass-key"], 100, "picked up the brass key")])
    _, lost = chapter(h, w, "ch2", "Mara lost the brass key in the sea.",
                      [ev("/inventory_ids", "REMOVE", ["brass-key"], [], 200, "lost the brass key")])
    _, used = chapter(h, w, "ch3", "Mara gave the brass key to Tomas.",
                      [ev("/inventory_ids", "REMOVE", ["brass-key"], [], 300, "gave the brass key to Tomas")])
    start = initialized(h, "E07", "mara", w["a01"])
    r = e_create(h, "E07", "mara", "APPLY", events=used + got + lost, current_snapshot_ref=start)
    assert "BEFORE_MISMATCH" in rules(r)
    assert r["result"]["accepted_event_ids"] == [got[0]["event_id"], lost[0]["event_id"]]
    inv = [(f["value"], f["effective_from"]) for f in r["result"]["snapshot"]["facts"]
           if f["predicate"] == "entity.inventory_ids"]
    assert sorted(inv, key=lambda x: x[1] or 0) == [([], None), (["brass-key"], 100), ([], 200)]


@XFAIL(strict=True, reason="NEW-ops-1: E applies an earlier-in-story-time event without re-checking the "
                                       "already accepted later events whose `before` it invalidates")
def test_e02_out_of_order_insertion_rechecks_later_events(h):
    """Spec E: apply in (story_time, scene_order, event_order, event_id) order; `before` must match the projected
    state; impossible chronology commits no invalid state. ch1 (t=100) moves Mara harbor->lighthouse; ch2 then
    claims that at t=50 she walked harbor->cliffs. Chronologically she is on the cliffs at t=100, so the accepted
    t=100 event (before=harbor) no longer holds - the result is an impossible timeline."""
    w = build_world(h)
    _, a = chapter(h, w, "ch1", "Mara walked from the harbor to the lighthouse.",
                   [ev("/location_id", "SET", "harbor", "lighthouse", 100, "walked from the harbor to the lighthouse")])
    _, b = chapter(h, w, "ch2", "Earlier that morning Mara walked from the harbor to the cliffs.",
                   [ev("/location_id", "SET", "harbor", "cliffs", 50, "walked from the harbor to the cliffs")])
    start = initialized(h, "E02", "mara", w["a01"])
    r = e_create(h, "E02", "mara", "APPLY", events=a, current_snapshot_ref=start)
    accept_ok(h, r["output_refs"][0])
    r2 = e_create(h, "E02", "mara", "APPLY", events=b, current_snapshot_ref=head(h, "E02", "mara"))
    # observed today: [harbor [-,50), cliffs [50,100), lighthouse [100,-)] with no finding and VALIDATED
    assert rules(r2) & {"BEFORE_MISMATCH", "CHRONOLOGY"}, locations(r2["result"]["snapshot"])
    assert h.validate(r2["output_refs"][0])["status"] != "VALIDATED"


@XFAIL(strict=True, reason="NEW-ops-2: E08 never compares power use with the pinned A09 limits")
def test_e08_power_above_a09_limit_is_a_finding(h):
    """Spec E: '... power use exceeding A09 limits produces a finding and commits no invalid state.'"""
    h.set_features(magic=True)
    w = build_world(h)
    a09 = approved(h, "A09", {"concept": "Tide magic"}, {
        "concept": "Tide magic", "attributes": {"costs": "one unit per wave", "limits": "never more than 3 units"},
        "linked_refs": [], "protected_fact_flags": [],
        "facts": [fact("tide-magic", "x.a09.cost", 1), fact("tide-magic", "x.a09.limit", 3)]})
    a01 = approved(h, "A01", {"concept": "Mara"}, {
        "concept": "Mara", "attributes": {}, "linked_refs": [a09, w["places"]], "protected_fact_flags": [],
        "facts": [fact("mara", "entity.name", "Mara"), fact("mara", "entity.power_remaining", 3)]})
    _, evs = chapter(h, w, "ch1", "Mara drew nine units of tide power at once.",
                     [ev("/power_remaining", "SET", 3, 9, 10, "drew nine units of tide power")])
    start = e_create(h, "E08", "mara", "INITIALIZE", baseline_ref=a01, source_refs=[a01, a09])
    assert start["status"] == "DRAFT", start
    accept_ok(h, start["output_refs"][0])
    r = e_create(h, "E08", "mara", "APPLY", events=evs, current_snapshot_ref=start["output_refs"][0])
    assert r["result"]["accepted_event_ids"] == [], "9 units exceeds the A09 hard limit of 3"


def test_e08_negative_power_is_still_refused(h):
    """Control for the test above: the generic non-negative predicate rule does fire."""
    h.set_features(magic=True)
    w = build_world(h)
    _, evs = chapter(h, w, "ch1", "Mara spent more power than she had.",
                     [ev("/power_remaining", "SET", None, -2, 10, "spent more power than she had")])
    start = e_create(h, "E08", "mara", "INITIALIZE")
    accept_ok(h, start["output_refs"][0])
    r = e_create(h, "E08", "mara", "APPLY", events=evs, current_snapshot_ref=start["output_refs"][0])
    assert "NEGATIVE_VALUE" in rules(r) and r["result"]["accepted_event_ids"] == []


@XFAIL(strict=True, reason="NEW-ops-7: E11/E12 CHECK compare chapter claims only with A/B baseline; the accepted "
                            "E state passed in source_refs is ignored, so a continuity break is not found")
@pytest.mark.parametrize("op", ["E11", "E12"])
def test_continuity_check_uses_accepted_state(h, op):
    """Spec E: 'E11 checks adjacent chapter/scene state ...; E12 compares manuscript claims with A/E'. ch1 (accepted,
    applied to E02) leaves Mara at the lighthouse at t=100; ch2 says she walked *from the harbor* at t=150."""
    w = build_world(h)
    _, a = chapter(h, w, "ch1", "Mara walked from the harbor to the lighthouse.",
                   [ev("/location_id", "SET", "harbor", "lighthouse", 100, "walked from the harbor to the lighthouse")])
    ch2, b = chapter(h, w, "ch2", "Mara walked from the harbor to the cliffs.",
                     [ev("/location_id", "SET", "harbor", "cliffs", 150, "walked from the harbor to the cliffs")])
    start = initialized(h, "E02", "mara", w["a01"])
    accept_ok(h, e_create(h, "E02", "mara", "APPLY", events=a, current_snapshot_ref=start)["output_refs"][0])
    state = head(h, "E02", "mara")
    key = {"E11": ("chapter_id", "ch2"), "E12": ("manuscript_ref", ch2)}[op]
    r = h.create(op, {key[0]: key[1], "mode": "CHECK", "events": b, "source_refs": [ch2, w["a01"], state]})
    assert r["status"] == "DRAFT", r
    assert "BEFORE_MISMATCH" in rules(r), "ch2 contradicts the accepted state (lighthouse since t=100)"


def test_e12_finds_break_when_whole_manuscript_is_checked(h):
    """Control: with both chapters' events E12 does detect the break, so the gap above is the ignored state."""
    w = build_world(h)
    ch1, a = chapter(h, w, "ch1", "Mara walked from the harbor to the lighthouse.",
                     [ev("/location_id", "SET", "harbor", "lighthouse", 100, "walked from the harbor to the lighthouse")])
    ch2, b = chapter(h, w, "ch2", "Mara walked from the harbor to the cliffs.",
                     [ev("/location_id", "SET", "harbor", "cliffs", 150, "walked from the harbor to the cliffs")])
    r = h.create("E12", {"manuscript_ref": ch2, "mode": "CHECK", "events": a + b, "source_refs": [ch1, ch2, w["a01"]]})
    assert "BEFORE_MISMATCH" in rules(r)
    assert h.store.get_state(h.project_id, "main", "e_head", f"E12:{ch2['record_id']}") is None  # CHECK: no head


# ============================================================================ A -> B/C/E/J ripple
def test_canon_change_ripples_to_plans_prose_state_and_j06(h):
    """Spec A: accepting a changed A record emits a commit event with changed paths; B/C/E consumers become
    stale (revalidate). Spec J06: impact traversal lists the affected chapters. Spec C/E: stale prose/state
    cannot be re-approved without a replacement."""
    w = build_world(h)
    ch1, evs = chapter(h, w, "ch1", "Mara walked from the harbor to the lighthouse.",
                       [ev("/location_id", "SET", "harbor", "lighthouse", 100,
                           "walked from the harbor to the lighthouse")])
    ch2, _ = chapter(h, w, "ch2", "Mara slept.", [])
    e_init = initialized(h, "E02", "mara", w["a01"])
    ap = e_create(h, "E02", "mara", "APPLY", events=evs, current_snapshot_ref=e_init)
    accept_ok(h, ap["output_refs"][0])
    e_head = head(h, "E02", "mara")
    hashes = {k: h.record(r)["content_hash"] for k, r in (("ch1", ch1), ("ch2", ch2), ("e", e_head))}

    # rename the harbor in A04 and approve the change
    a04 = h.record(w["places"])
    data = copy.deepcopy(a04["data"])
    for f in data["facts"]:
        if f["subject_id"] == "harbor":
            f["value"] = "Port Varn"
    u = h.dispatch("A04", "UPDATE", base_ref=w["places"], payload=data)
    assert h.approve(u["output_refs"][0])["status"] == "APPROVED"
    out = h.store.query("SELECT payload FROM outbox WHERE event_type='record.approved'")
    assert any(w["places"]["record_id"] in r["payload"] for r in out)

    for name, ref in (("B11", w["outline"]), ("B12", w["scenes"]), ("ch1", ch1), ("ch2", ch2), ("E02", e_head)):
        assert h.record(ref)["stale"] is True, name
    # history is kept: stale records keep their bytes
    assert h.record(ch1)["content_hash"] == hashes["ch1"] and h.record(e_head)["content_hash"] == hashes["e"]
    # revalidation of a stale chapter reports STALE instead of passing
    v = h.validate(ch2)
    assert any(f["rule_id"] == "STALE" for f in v["findings"])

    j06 = h.create("J06", {"changed_refs": [u["output_refs"][0]]})
    assert j06["status"] == "DRAFT", j06
    impacted = {r["record_id"] for r in j06["result"]["impact_refs"]}
    assert {ch1["record_id"], ch2["record_id"], e_head["record_id"]} <= impacted


@XFAIL(strict=True, reason="NEW-ops-3: references inside a manual_candidate (and other handler-built "
                                       "outputs) get no dependency edge, so the consumer never becomes stale")
def test_manual_candidate_references_are_recorded_reads(h):
    """Spec Shared s6/Set A: a changed producer invalidates consumers that read it. A02 created with the SAME
    linked_refs once via payload and once via manual_candidate must behave the same after A01 changes."""
    a_ref, a = h.create_approved("A01", {"concept": "Mara"})
    via_payload = h.create("A02", {"concept": "Selkies", "linked_refs": [a_ref]})["output_refs"][0]
    cand = {"concept": "Selkies", "attributes": {}, "linked_refs": [a_ref], "protected_fact_flags": [], "facts": []}
    via_manual = h.dispatch("A02", "CREATE", payload={"concept": "Selkies"}, manual_candidate=cand)["output_refs"][0]
    assert h.approve(via_manual)["status"] == "APPROVED"
    u = h.dispatch("A01", "UPDATE", base_ref=a_ref, payload=dict(a["result"], concept="Mara Vell"))
    assert h.approve(u["output_refs"][0])["status"] == "APPROVED"
    assert h.record(via_payload)["stale"] is True
    assert h.record(via_manual)["stale"] is True  # observed: False, and it re-validates as APPROVED


# ============================================================================ I: approvals honoured
@XFAIL(strict=True, reason="NEW-ops-4: I01 marks canon APPROVED from any approval record whose decision "
                                       "says APPROVED - expired or bound to another record")
@pytest.mark.parametrize("which", ["expired", "other-subject"])
def test_i01_approved_canon_needs_valid_bound_approval(h, which):
    """Spec I: 'APPROVED requires a valid I10 approval/delegation and resolved applicable sources'; K09 APPROVED
    requires a future expiry; approval binds the exact candidate/source revision."""
    a = canon(h, facts=[fx_fact("mara", "entity.name", "Mara")])
    other = canon(h, facts=[fx_fact("x", "entity.name", "X")])
    appr = k09(h, [a], expires_in=-60) if which == "expired" else k09(h, [other])
    r = h.create("I01", {"owner_operation": "A01", "source_ref": a, "approval_ref": appr, "fact_type": "character",
                         "fact_payload": {"summary": "Mara", "facts": [], "links": []}, "requested_state": "APPROVED"})
    assert r["status"] != "DRAFT" or r["result"]["approval_state"] != "APPROVED", r["result"]


def test_i01_approved_canon_with_current_bound_approval(h):
    a = canon(h, facts=[fx_fact("mara", "entity.name", "Mara")])
    r = h.create("I01", {"owner_operation": "A01", "source_ref": a, "approval_ref": k09(h, [a]),
                         "fact_type": "character", "fact_payload": {"summary": "Mara", "facts": [], "links": []},
                         "requested_state": "APPROVED"})
    assert r["status"] == "DRAFT" and r["result"]["approval_state"] == "APPROVED"
    no = h.create("I01", {"owner_operation": "A01", "source_ref": a, "fact_type": "character",
                          "fact_payload": {"summary": "Mara", "facts": [], "links": []},
                          "requested_state": "APPROVED"})
    assert errors_of(no)[0][0] in ("MISSING_INPUT", "APPROVAL_REQUIRED") and no["output_refs"] == []


def test_c01_context_contains_approved_canon_not_newer_draft(h):
    """Spec C01/I07: the context package carries pinned approved canon; an unapproved A01 revision is not canon."""
    w = build_world(h)
    data = copy.deepcopy(h.record(w["a01"])["data"])
    for f in data["facts"]:
        if f["predicate"] == "entity.location_id":
            f["value"] = "cliffs"
    assert h.dispatch("A01", "UPDATE", base_ref=w["a01"], payload=data)["status"] == "DRAFT"
    ctx = make_context(h, w)["result"]
    locs = [(f["subject_id"], f["value"]) for f in ctx["facts"] if f["predicate"] == "entity.location_id"]
    assert locs == [("mara", "harbor")]


def test_locked_record_cannot_be_replaced_or_reapproved_without_authorization(h):
    ref, r = h.create_approved("A01", {"concept": "Mara"})
    lock = h.create("I10", {"candidate_ref": ref, "decision": "LOCK", "approver_id": PRINCIPAL, "reason": "final",
                            "authorization_ref": None})
    assert lock["status"] == "DRAFT", lock
    assert h.record(ref)["lifecycle"] == "LOCKED"
    u = h.dispatch("A01", "UPDATE", base_ref=ref, payload=dict(r["result"], concept="changed"))
    assert errors_of(u)[0][0] == "LOCKED_FACT"
    assert len(h.store.history(h.project_id, "main", ref["record_id"])) == 1


# ============================================================================ ACCEPT-stage dependency predicate
@XFAIL(strict=True, reason="NEW-ops-5: ACCEPT ignores the dependency matrix ACCEPT predicate "
                                       "ALL_SELECTED_INPUTS_RESOLVED_AND_VALIDATED; a consumer is approved while "
                                       "its HARD input is an unvalidated draft or REJECTED")
@pytest.mark.parametrize("input_state", ["DRAFT", "REJECTED"])
def test_accept_requires_validated_hard_inputs(h, input_state):
    b01 = h.dispatch("B01", "CREATE", payload={"idea": "i", "goals": ["g"]},
                     manual_candidate={"premise": "p", "dramatic_question": "q?", "concept_summary": "s"})
    premise = b01["output_refs"][0]
    if input_state == "REJECTED":
        rej = h.create("I10", {"candidate_ref": premise, "decision": "REJECT", "approver_id": PRINCIPAL,
                               "reason": "author rejected the premise", "authorization_ref": None})
        assert rej["status"] == "DRAFT", rej
        assert h.record(premise)["lifecycle"] == "REJECTED"
    plot = {"main_plot": {"summary": "plot", "facts": [], "links": []}, "objectives": [], "plot_obligations": []}
    b03 = h.dispatch("B03", "CREATE", payload={"premise_ref": premise, "canon_refs": [], "constraints": []},
                     manual_candidate=plot)
    assert b03["status"] == "DRAFT", b03
    h.validate(b03["output_refs"][0])
    a = h.accept(b03["output_refs"][0])
    assert a["status"] != "APPROVED", f"B03 approved on a {input_state} premise"


# ============================================================================ K: cost cap stops work
@XFAIL(strict=True, reason="NEW-ops-6: the K12 quota ledger is never consulted before AI dispatch; an "
                                       "exhausted cost cap does not stop paid generation")
def test_exhausted_quota_holds_ai_generation(h):
    """Spec K: 'K12 atomically enforces spent+reserved+estimate <= quota ... Reserve before dispatch ...
    insufficient quota holds next work.' With a zero quota and a priced slot, C02 generation must not call
    the provider."""
    w = build_world(h)
    fake = use_ai(h, FakeAI(), input_cost_minor_per_mtok=1_000_000_000, output_cost_minor_per_mtok=1_000_000_000)
    for account in ("AI-1", h.project_id, "default"):
        kr.configure_quota(h.store, PRINCIPAL, h.project_id, "main", account_id=account, period="2026-10",
                           limit=0, currency="USD")
    ctx_ref = make_context(h, w)["output_refs"][0]
    r = h.create("C02", {"chapter_id": "ch1", "outline_ref": w["outline"], "context_ref": ctx_ref,
                         "instruction": "write"})
    assert fake.calls["prose"] == 0 and r["status"] in ("BLOCKED", "PARTIAL"), (r["status"], fake.calls)
    assert ("QUOTA_EXCEEDED" in [e["code"] for e in r["errors"]])


def test_k12_reservation_respects_trusted_ledger(h):
    """Spec K walkthrough: spent=70, limit=100, two 20-unit requests -> at most one is allowed."""
    kr.configure_quota(h.store, PRINCIPAL, h.project_id, "main", account_id="acct", period="p", limit=100,
                       currency="USD")
    q = {"account_id": "acct", "limit": 100, "period": "p", "currency": "USD"}
    first = h.create("K12", {"job_id": "warm", "estimated_cost": 70, "quota": q, "usage": {"spent": 0, "reserved": 0}})
    assert first["result"]["allowed"] is True
    kr.settle(h.store, PRINCIPAL, h.project_id, "main", account_id="acct", period="p",
              reservation_id=first["result"]["reservation_id"], actual=70)
    lie = {"spent": 0, "reserved": 0}  # caller-supplied balances must be ignored
    a = h.create("K12", {"job_id": "j1", "estimated_cost": 20, "quota": dict(q, limit=10**6), "usage": lie})
    b = h.create("K12", {"job_id": "j2", "estimated_cost": 20, "quota": dict(q, limit=10**6), "usage": lie})
    allowed = [x["result"]["allowed"] for x in (a, b)]
    assert allowed == [True, False]
    assert b["result"] == {"reservation_id": None, "allowed": False, "remaining": 10}
    led = kr.get_ledger(h.store, h.project_id, "main", "acct", "p")
    led = led[0] if isinstance(led, tuple) else led
    assert led["spent"] == 70 and led["reserved"] == 20
