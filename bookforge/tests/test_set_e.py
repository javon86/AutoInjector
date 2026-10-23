"""Set E tests: baseline, typed events, candidate vs accepted events, snapshots, replay, checks."""
from __future__ import annotations

import copy
import json

from bookforge.c_events import extract_event_bundle

from conftest import PRINCIPAL, errors_of
from test_set_c import (TEXT, accepted_chapter, build_world, character, fact, k09_approval, make_context, raw_events,
                        write_chapter)

FIELD = {"E01": "character_id", "E02": "entity_id", "E03": "timeline_id", "E05": "character_id",
         "E07": "holder_id", "E08": "character_id", "E09": "thread_id"}


def e_create(h, op, entity, mode, events=(), source_refs=(), **kw):
    payload = {FIELD[op]: entity, "mode": mode, "events": [copy.deepcopy(e) for e in events],
               "source_refs": list(source_refs), **kw}
    return h.create(op, payload)


def accept_ok(h, ref):
    v = h.validate(ref)
    assert v["status"] == "VALIDATED", [(f["rule_id"], f["message"]) for f in v["findings"]]
    a = h.accept(ref)
    assert a["status"] == "APPROVED", a
    return a


def initialized(h, op, entity, baseline):
    r = e_create(h, op, entity, "INITIALIZE", baseline_ref=baseline, source_refs=[baseline])
    assert r["status"] == "DRAFT", r
    accept_ok(h, r["output_refs"][0])
    return r["output_refs"][0]


def head(h, op, entity):
    return h.store.get_state(h.project_id, "main", "e_head", f"{op}:{entity}")["ref"]


def rules(resp):
    return {f["rule_id"] for f in resp["findings"]}


def location_facts(snapshot):
    return sorted((f["value"], f["effective_from"], f["effective_to"]) for f in snapshot["facts"]
                  if f["predicate"] == "entity.location_id")


def world_with_prose(h):
    w = build_world(h)
    prose, bundle = accepted_chapter(h, w)
    return w, prose, bundle["data"]["events"], bundle


# ====================================================================== INITIALIZE
def test_initialize_from_approved_baseline(h):
    w = build_world(h)
    ref = initialized(h, "E02", "mara", w["a01"])
    data = h.record(ref)["data"]
    assert data["entity_id"] == "mara" and data["accepted_event_ids"] == []
    assert location_facts(data["snapshot"]) == [("harbor", None, None)]
    assert all(f["predicate"] == "entity.location_id" for f in data["snapshot"]["facts"])  # E02 tracks location only
    assert w["a01"] in data["snapshot"]["links"]
    again = e_create(h, "E02", "mara", "INITIALIZE", baseline_ref=w["a01"], source_refs=[w["a01"]])
    assert errors_of(again)[0] == ("INVALID_INPUT", "/payload/mode")
    draft = character(h, cid="tomas", name="Tomas", approve=False, where=w["places"])
    blocked = e_create(h, "E02", "tomas", "INITIALIZE", baseline_ref=draft, source_refs=[draft])
    assert blocked["status"] == "BLOCKED" and errors_of(blocked)[0] == ("APPROVAL_REQUIRED", "/payload/baseline_ref")


def test_initialize_known_empty_snapshot(h):
    r = e_create(h, "E01", "ghost", "INITIALIZE")
    assert r["status"] == "DRAFT"
    assert r["result"]["snapshot"]["facts"] == [] and "KNOWN_EMPTY" in rules(r)
    accept_ok(h, r["output_refs"][0])


def test_apply_requires_current_snapshot_and_event(h):
    w = build_world(h)
    initialized(h, "E02", "mara", w["a01"])
    r = e_create(h, "E02", "mara", "APPLY")
    assert errors_of(r)[0][0] == "MISSING_INPUT"
    r = e_create(h, "E02", "mara", "APPLY", current_snapshot_ref=head(h, "E02", "mara"))
    assert errors_of(r)[0] == ("INVALID_INPUT", "/payload/events")


# ====================================================================== candidate vs accepted events
def test_candidate_events_from_unaccepted_prose_are_not_applied(h):
    w = build_world(h)
    start = initialized(h, "E02", "mara", w["a01"])
    prose = write_chapter(h, w)["output_refs"][0]
    b = extract_event_bundle(h.engine, PRINCIPAL, prose, events=raw_events())
    ev = b["result"]["events"][0]
    claim = dict(ev, status="ACCEPTED")  # an unauthorized status claim changes nothing
    r = e_create(h, "E02", "mara", "APPLY", events=[claim], current_snapshot_ref=start, source_refs=b["output_refs"])
    assert r["status"] == "DRAFT" and "PROSE_NOT_ACCEPTED" in rules(r)
    assert r["result"]["accepted_event_ids"] == []
    v = h.validate(r["output_refs"][0])
    assert v["status"] == "DRAFT" and "CANDIDATE_FINDING" in rules(v)


def test_accepted_event_updates_state_and_head(h):
    w, prose, events, bundle = world_with_prose(h)
    start = initialized(h, "E02", "mara", w["a01"])
    start_hash = h.record(start)["content_hash"]
    loc = events[0]
    r = e_create(h, "E02", "mara", "APPLY", events=[loc], current_snapshot_ref=start)
    assert r["status"] == "DRAFT", r
    data = r["result"]
    assert data["accepted_event_ids"] == [loc["event_id"]]
    assert location_facts(data["snapshot"]) == [("harbor", None, 100), ("lighthouse", 100, None)]
    new_fact = [f for f in data["snapshot"]["facts"] if f["value"] == "lighthouse"][0]
    assert new_fact["source_refs"] == [prose]
    assert bundle["ref"] in data["snapshot"]["links"] and start in data["snapshot"]["links"]
    accept_ok(h, r["output_refs"][0])
    assert head(h, "E02", "mara") == r["output_refs"][0]
    ledger = h.store.get_state(h.project_id, "main", "e_ledger", "E02:mara")["events"]
    assert ledger[loc["event_id"]]["status"] == "ACCEPTED"
    assert h.record(start)["content_hash"] == start_hash  # old snapshot kept byte-identical
    out = h.store.query_one("SELECT payload FROM outbox WHERE event_type='e.state_accepted' ORDER BY created_at DESC")
    assert loc["event_id"] in json.loads(out["payload"])["applied_event_ids"]


def test_span_hash_mismatch_and_unbundled_events(h):
    w, prose, events, bundle = world_with_prose(h)
    start = initialized(h, "E02", "mara", w["a01"])
    bad = copy.deepcopy(events[0])
    bad["evidence"][0]["text_hash"] = "0" * 64
    r = e_create(h, "E02", "mara", "APPLY", events=[bad], current_snapshot_ref=start)
    assert "SPAN_HASH" in rules(r) and r["result"]["accepted_event_ids"] == []
    shifted = copy.deepcopy(events[0])
    shifted["evidence"][0]["start"] += 1
    r = e_create(h, "E02", "mara", "APPLY", events=[shifted], current_snapshot_ref=start)
    assert "SPAN_HASH" in rules(r)
    fabricated = dict(copy.deepcopy(events[0]), after="cliffs", event_id="made-up")
    r = e_create(h, "E02", "mara", "APPLY", events=[fabricated], current_snapshot_ref=start)
    assert "UNBUNDLED_EVENT" in rules(r)


def test_before_must_match_projection(h):
    w, prose, events, bundle = world_with_prose(h)
    # baseline says harbor; a bundle event claiming before=castle is refused
    text = "Mara walked from the castle to the lighthouse."
    p2 = write_chapter(h, w, text=text, findings=[{"id": "o", "rule_id": "OBJECTIVE:ch1", "severity": "INFO",
                                                    "decision": "PASS", "message": "ok", "evidence": [],
                                                    "source_refs": [], "confidence": None}])["output_refs"][0]
    ev = raw_events(quote="walked from the castle to the lighthouse")[0]
    ev["before"] = "castle"
    b = extract_event_bundle(h.engine, PRINCIPAL, p2, events=[ev])
    assert h.approve(p2)["status"] == "APPROVED"
    start = initialized(h, "E02", "mara", w["a01"])
    r = e_create(h, "E02", "mara", "APPLY", events=b["result"]["events"], current_snapshot_ref=start)
    assert "BEFORE_MISMATCH" in rules(r) and r["result"]["accepted_event_ids"] == []
    assert r["result"]["snapshot"]["facts"] == h.record(start)["data"]["snapshot"]["facts"]  # no invalid state


def test_list_membership_needs_known_prior(h):
    w, prose, events, bundle = world_with_prose(h)
    inv = events[1]  # ADD brass-key, before []
    empty = e_create(h, "E07", "mara", "INITIALIZE")  # no baseline: inventory unknown
    accept_ok(h, empty["output_refs"][0])
    r = e_create(h, "E07", "mara", "APPLY", events=[inv], current_snapshot_ref=empty["output_refs"][0])
    assert "UNKNOWN_PRIOR" in rules(r)
    w2 = initialized(h, "E07", "tomas-is-not-mara", w["a01"])  # wrong entity for the event
    r = e_create(h, "E07", "tomas-is-not-mara", "APPLY", events=[inv], current_snapshot_ref=w2)
    assert "ENTITY_MISMATCH" in rules(r)


def test_inventory_add_from_baseline(h):
    w, prose, events, bundle = world_with_prose(h)
    start = initialized(h, "E07", "mara", w["a01"])
    r = e_create(h, "E07", "mara", "APPLY", events=[events[1]], current_snapshot_ref=start)
    inv = [f for f in r["result"]["snapshot"]["facts"] if f["predicate"] == "entity.inventory_ids"]
    assert sorted((tuple(f["value"]), f["effective_from"]) for f in inv) == [((), None), (("brass-key",), 110)]
    wrong_path = e_create(h, "E07", "mara", "APPLY", events=[events[0]], current_snapshot_ref=start)
    assert "PATH_NOT_TRACKED" in rules(wrong_path)


def test_duplicate_delivery_applies_once_and_conflicts(h):
    w, prose, events, bundle = world_with_prose(h)
    start = initialized(h, "E02", "mara", w["a01"])
    r = e_create(h, "E02", "mara", "APPLY", events=[events[0], events[0]], current_snapshot_ref=start)
    assert r["result"]["accepted_event_ids"] == [events[0]["event_id"]]
    accept_ok(h, r["output_refs"][0])
    again = e_create(h, "E02", "mara", "APPLY", events=[events[0]], current_snapshot_ref=head(h, "E02", "mara"))
    assert "DUPLICATE_EVENT" in rules(again)
    assert again["result"]["accepted_event_ids"] == [events[0]["event_id"]]
    changed = dict(events[0], after="cliffs")
    c = e_create(h, "E02", "mara", "APPLY", events=[changed], current_snapshot_ref=head(h, "E02", "mara"))
    assert errors_of(c)[0][0] == "EVENT_CONFLICT"


def test_chronology_conflict(h):
    w, prose, events, bundle = world_with_prose(h)
    start = initialized(h, "E02", "mara", w["a01"])
    r = e_create(h, "E02", "mara", "APPLY", events=[events[0]], current_snapshot_ref=start)
    accept_ok(h, r["output_refs"][0])
    # same instant, second location change for the same entity
    text2 = "At once Mara was also on the cliffs."
    obj = {"id": "o", "rule_id": "OBJECTIVE:ch1", "severity": "INFO", "decision": "PASS", "message": "ok",
           "evidence": [], "source_refs": [], "confidence": None}
    p2 = write_chapter(h, w, text=text2, findings=[obj])["output_refs"][0]
    ev = dict(raw_events(quote="Mara was also on the cliffs")[0], before="lighthouse", after="cliffs")
    b = extract_event_bundle(h.engine, PRINCIPAL, p2, events=[ev])
    h.approve(p2)
    c = e_create(h, "E02", "mara", "APPLY", events=b["result"]["events"], current_snapshot_ref=head(h, "E02", "mara"))
    assert "CHRONOLOGY" in rules(c)
    assert h.validate(c["output_refs"][0])["status"] == "DRAFT"


# ====================================================================== stale snapshots / UPDATE
def test_stale_snapshot_rejected_at_accept_and_create(h):
    w, prose, events, bundle = world_with_prose(h)
    start = initialized(h, "E01", "mara", w["a01"])
    first = e_create(h, "E01", "mara", "APPLY", events=[events[0]], current_snapshot_ref=start)
    second = e_create(h, "E01", "mara", "APPLY", events=[events[1]], current_snapshot_ref=start)
    accept_ok(h, first["output_refs"][0])
    late = h.accept(second["output_refs"][0])
    assert late["status"] == "BLOCKED" and "STALE_SNAPSHOT" in rules(late)
    stale = e_create(h, "E01", "mara", "APPLY", events=[events[1]], current_snapshot_ref=start)
    assert errors_of(stale)[0] == ("VERSION_CONFLICT", "/payload/current_snapshot_ref")


def test_update_publishes_only_a_derived_candidate(h):
    w, prose, events, bundle = world_with_prose(h)
    start = initialized(h, "E02", "mara", w["a01"])
    cand = e_create(h, "E02", "mara", "APPLY", events=[events[0]], current_snapshot_ref=start)
    forged = copy.deepcopy(cand["result"])
    forged["snapshot"]["facts"][-1]["value"] = "moon"
    bad = h.dispatch("E02", "UPDATE", base_ref=start, payload=forged)
    assert errors_of(bad)[0] == ("INVALID_INPUT", "/payload")
    u = h.dispatch("E02", "UPDATE", base_ref=start, payload=cand["result"])
    assert u["status"] == "DRAFT" and u["output_refs"][0]["record_id"] == start["record_id"]
    accept_ok(h, u["output_refs"][0])
    assert head(h, "E02", "mara") == u["output_refs"][0]
    assert h.record(start)["lifecycle"] == "SUPERSEDED"
    late = h.accept(cand["output_refs"][0])  # the same data computed from the old head is now stale
    assert late["status"] != "APPROVED" and rules(late) & {"STALE", "STALE_SNAPSHOT"}


def test_manual_state_injection_rejected(h):
    r = h.dispatch("E01", "CREATE", payload={"character_id": "x", "mode": "INITIALIZE", "events": [],
                                             "source_refs": []},
                   manual_candidate={"entity_id": "x", "snapshot": {"summary": "s", "facts": [], "links": []},
                                     "accepted_event_ids": [], "superseded_event_ids": [], "findings": [],
                                     "affected_refs": []})
    assert errors_of(r)[0] == ("INVALID_INPUT", "/manual_candidate")


# ====================================================================== rewrite replay
def test_rewrite_replay_from_baseline_and_checkpoint(h):
    w, prose, events, bundle = world_with_prose(h)
    loc, inv = events
    other = initialized(h, "E02", "tomas", character(h, cid="tomas", name="Tomas", where=w["places"]))
    other_hash = h.record(other)["content_hash"]
    e02 = initialized(h, "E02", "mara", w["a01"])
    r = e_create(h, "E02", "mara", "APPLY", events=[loc], current_snapshot_ref=e02)
    accept_ok(h, r["output_refs"][0])
    e01 = initialized(h, "E01", "mara", w["a01"])
    r1 = e_create(h, "E01", "mara", "APPLY", events=[loc, inv], current_snapshot_ref=e01)
    accept_ok(h, r1["output_refs"][0])
    old_head = head(h, "E02", "mara")

    # C rewrites the earlier passage; acceptance supersedes it and marks readers stale
    new_text = "Mara climbed from the harbor to the cliffs. She picked up the brass key."
    c11 = h.dispatch("C11", "CREATE", payload={"passage_id": prose["record_id"], "rewrite_goal": "relocate",
                                                "instruction": "i", "passage_ref": prose},
                     manual_candidate={"text": new_text, "candidate_events": [], "findings": []})
    p2 = c11["output_refs"][0]
    b2 = extract_event_bundle(h.engine, PRINCIPAL, p2,
                              events=raw_events("cliffs", quote="climbed from the harbor to the cliffs"))
    assert h.accept(p2, k09_approval(h, p2))["status"] == "APPROVED"
    assert h.record(prose)["lifecycle"] == "SUPERSEDED"
    assert h.record(old_head)["stale"] is True

    # the old event can no longer be applied from superseded prose
    stale_apply = e_create(h, "E02", "mara", "REPLAY", current_snapshot_ref=old_head, superseded_event_ids=[])
    assert "SOURCE_SUPERSEDED" in rules(stale_apply)

    new_loc = b2["result"]["events"][0]
    missing = e_create(h, "E02", "mara", "REPLAY", events=[new_loc], current_snapshot_ref=old_head)
    assert errors_of(missing)[0] == ("MISSING_INPUT", "/payload/superseded_event_ids")
    rp = e_create(h, "E02", "mara", "REPLAY", events=[new_loc], current_snapshot_ref=old_head,
                  superseded_event_ids=[loc["event_id"]])
    assert rp["status"] == "DRAFT", rp
    data = rp["result"]
    assert data["accepted_event_ids"] == [new_loc["event_id"]]
    assert data["superseded_event_ids"] == [loc["event_id"]]
    assert location_facts(data["snapshot"]) == [("cliffs", 100, None), ("harbor", None, 100)]
    assert head(h, "E01", "mara") in data["affected_refs"]  # E01 also applied the superseded event
    accept_ok(h, rp["output_refs"][0])
    assert head(h, "E02", "mara") == rp["output_refs"][0]
    ledger = h.store.get_state(h.project_id, "main", "e_ledger", "E02:mara")["events"]
    assert ledger[loc["event_id"]]["status"] == "SUPERSEDED" and ledger[new_loc["event_id"]]["status"] == "ACCEPTED"
    assert h.record(head(h, "E01", "mara"))["stale"] is True
    # unrelated entity untouched, byte-identical
    assert h.record(other)["content_hash"] == other_hash and h.record(other)["stale"] is False
    assert head(h, "E02", "tomas") == other

    # E01 replay from a checkpoint that already contains the superseded event is refused
    bad_chk = e_create(h, "E01", "mara", "REPLAY", current_snapshot_ref=head(h, "E01", "mara"),
                       checkpoint_ref=head(h, "E01", "mara"), superseded_event_ids=[loc["event_id"]])
    assert errors_of(bad_chk)[0] == ("INVALID_INPUT", "/payload/checkpoint_ref")
    # ...while the baseline-initialized checkpoint (no events) works and keeps the other event
    ok = e_create(h, "E01", "mara", "REPLAY", events=[new_loc], current_snapshot_ref=head(h, "E01", "mara"),
                  checkpoint_ref=e01, superseded_event_ids=[loc["event_id"], inv["event_id"]])
    assert ok["status"] == "DRAFT", ok
    assert ok["result"]["accepted_event_ids"] == [new_loc["event_id"]]


# ====================================================================== CHECK / features / review
def test_check_mode_reports_without_new_head(h):
    w, prose, events, bundle = world_with_prose(h)
    start = initialized(h, "E03", "main-timeline", w["a01"])
    none = e_create(h, "E03", "main-timeline", "CHECK", events=[events[0]])
    assert errors_of(none)[0] == ("MISSING_INPUT", "/payload/source_refs")
    r = e_create(h, "E03", "main-timeline", "CHECK", events=[events[0]], source_refs=[prose, w["a01"]])
    assert r["status"] == "DRAFT"
    assert r["result"]["snapshot"]["facts"] == h.record(start)["data"]["snapshot"]["facts"]
    accept_ok(h, r["output_refs"][0])
    assert head(h, "E03", "main-timeline") == start


def test_e12_manuscript_check_routes_conflicts(h):
    w, prose, events, bundle = world_with_prose(h)
    ev = dict(copy.deepcopy(events[0]))
    r = h.create("E12", {"manuscript_ref": prose, "mode": "CHECK", "events": [ev], "source_refs": [prose, w["a01"]]})
    assert r["status"] == "DRAFT" and r["result"]["entity_id"] == prose["record_id"]
    bad = h.create("E12", {"manuscript_ref": bundle["ref"], "mode": "CHECK", "events": [],
                           "source_refs": [prose]})
    assert errors_of(bad)[0] == ("INVALID_INPUT", "/payload/manuscript_ref")


def test_e08_requires_magic_and_nonnegative_power(h):
    r = e_create(h, "E08", "mara", "INITIALIZE")
    assert r["status"] == "NOT_APPLICABLE" and r["selection_rule_id"] == "FEATURE_TRUE:magic"
    h.set_features(magic=True)
    w = build_world(h)
    text = "Mara spent more power than she had."
    obj = {"id": "o", "rule_id": "OBJECTIVE:ch1", "severity": "INFO", "decision": "PASS", "message": "ok",
           "evidence": [], "source_refs": [], "confidence": None}
    p = write_chapter(h, w, text=text, findings=[obj])["output_refs"][0]
    ev = {"entity_id": "mara", "path": "/power_remaining", "operation": "SET", "before": None, "after": -2,
          "story_time": 5, "scene_id": "s1", "scene_order": 0, "event_order": 0,
          "evidence": [{"quote": "spent more power than she had"}]}
    b = extract_event_bundle(h.engine, PRINCIPAL, p, events=[ev])
    h.approve(p)
    start = e_create(h, "E08", "mara", "INITIALIZE")
    accept_ok(h, start["output_refs"][0])
    r = e_create(h, "E08", "mara", "APPLY", events=b["result"]["events"], current_snapshot_ref=start["output_refs"][0])
    assert "NEGATIVE_VALUE" in rules(r) and r["result"]["accepted_event_ids"] == []


def test_unknown_predicate_needs_review(h):
    w, prose, events, bundle = world_with_prose(h)
    start = initialized(h, "E01", "mara", w["a01"])
    odd = dict(copy.deepcopy(events[0]), path="/mood", event_id="odd-1")
    r = e_create(h, "E01", "mara", "APPLY", events=[odd, events[0]], current_snapshot_ref=start)
    assert "UNKNOWN_PREDICATE" in rules(r)
    assert r["result"]["accepted_event_ids"] == [events[0]["event_id"]]
    ref = r["output_refs"][0]
    assert h.validate(ref)["status"] == "VALIDATED"
    assert errors_of(h.accept(ref))[0][0] == "APPROVAL_REQUIRED"
    assert h.accept(ref, k09_approval(h, ref))["status"] == "APPROVED"


def test_ai_extracted_bundle_feeds_e(h):
    from test_set_c import FakeAI, use_ai
    w = build_world(h)
    use_ai(h, FakeAI())
    ctx_ref = make_context(h, w)["output_refs"][0]
    r = h.create("C02", {"chapter_id": "ch1", "outline_ref": w["outline"], "context_ref": ctx_ref,
                         "instruction": "write"})
    prose, bundle_ref = r["output_refs"]
    assert h.approve(prose)["status"] == "APPROVED"
    events = h.record(bundle_ref)["data"]["events"]
    start = initialized(h, "E02", "mara", w["a01"])
    a = e_create(h, "E02", "mara", "APPLY", events=[events[0]], current_snapshot_ref=start,
                 source_refs=[bundle_ref])
    assert a["result"]["accepted_event_ids"] == [events[0]["event_id"]]
    accept_ok(h, a["output_refs"][0])
    # the next chapter's context package carries the accepted entry state
    ctx = make_context(h, w, "ch2")["result"]
    assert any(f["predicate"] == "entity.location_id" and f["value"] == "lighthouse" for f in ctx["facts"])
    assert TEXT
