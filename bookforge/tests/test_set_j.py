"""Set J (reconciliation): conflicts, ranking, ripple, multi-owner commit, revalidation."""
from __future__ import annotations

from bookforge.canonical import sha256_text
from bookforge.j_approvals import waivable, waiver_action_hash, waiver_applies
from bookforge.modules.set_j import classify, claims_of
from bookforge.store import CrashInjected
from conftest import errors_of
from fj_fixtures import canon, fact, iso, k09, prose, rec, seed


def j(h, op, payload, **kw):
    r = h.create(op, payload, **kw)
    return r


def ids(items):
    return [i["decision"] for i in items]


# ------------------------------------------------------------------------------ J01/J02 classification
def test_j01_branch_time_and_belief_nonconflicts(h):
    a = canon(h, facts=[fact("mira", "entity.name", "Mira", 0, 100)])
    b = canon(h, facts=[fact("mira", "entity.name", "Myra", 100, None)])  # disjoint interval
    c = canon(h, facts=[fact("mira", "entity.name", "Mirra", None, None, kind="BELIEF")])
    r = j(h, "J01", {"claim_refs": [a, b, c]})
    assert r["status"] == "DRAFT", r
    assert r["result"]["conflict_candidates"] == []
    note = [f for f in r["result"]["findings"] if f["rule_id"] == "NON_CONFLICTS"][0]["message"]
    assert "TEMPORAL_MISMATCH=1" in note and "NON_CONFLICT=2" in note
    d = canon(h, facts=[fact("mira", "entity.name", "Mora", 50, 150)])  # overlaps both FACTs
    r2 = j(h, "J01", {"claim_refs": [a, b, d]})
    cands = r2["result"]["conflict_candidates"]
    assert len(cands) == 2 and ids(cands) == ["CONFLICT", "CONFLICT"]
    # branch: claims on another branch never conflict with this branch's FACT
    x = {"subject": "s", "predicate": "p", "value": 1, "kind": "FACT", "frm": None, "to": None, "branch": "main"}
    assert classify(x, dict(x, value=2, branch="alt")) == "BRANCH_MISMATCH"
    assert classify(x, dict(x, value=2)) == "HARD_CONFLICT"
    assert classify(x, dict(x, value=2, frm=5, to=None)) == "HARD_CONFLICT"  # [None,None) overlaps [5,inf)
    assert classify(dict(x, to=5), dict(x, value=2, frm=5)) == "TEMPORAL_MISMATCH"  # half-open
    assert classify(x, dict(x, value=2, kind="UNKNOWN")) == "AMBIGUOUS"
    # branch_scope filters claims to one branch
    r3 = j(h, "J01", {"claim_refs": [a, d], "branch_scope": "alt"})
    assert r3["result"]["conflict_candidates"] == []


def test_j01_event_claims_carry_branch_and_status():
    record = {"record_id": "r", "version": 1, "branch_id": "main", "data": {"events": [
        {"event_id": "e1", "entity_ids": ["mira"], "path": "/location_id", "after": "port", "branch_id": "alt",
         "story_time": 10, "status": "ACCEPTED"},
        {"event_id": "e2", "entity_ids": ["mira"], "path": "/location_id", "after": "hill", "branch_id": "main",
         "story_time": 10, "status": "CANDIDATE"}]}}
    cs = claims_of(record)
    assert [(c["branch"], c["kind"], c["path"]) for c in cs] == [("alt", "FACT", "/events/0/after"),
                                                                 ("main", "PLAN", "/events/1/after")]
    assert classify(cs[0], cs[1]) == "BRANCH_MISMATCH"


def test_j02_cross_bible_classification(h):
    a = canon(h, facts=[fact("ilo", "entity.name", "Ilo", 0, 10), fact("ilo", "x.age", 30, None, None)])
    b = canon(h, facts=[fact("ilo", "entity.name", "Ilo the Elder", 10, 20),
                        fact("ilo", "x.age", 31, None, None), fact("ilo", "x.rank", "?", None, None)])
    c = canon(h, facts=[fact("ilo", "x.rank", "captain", None, None, kind="UNKNOWN")])
    r = j(h, "J02", {"candidate_refs": [a, b, c]})
    got = sorted(ids(r["result"]["classified_conflicts"]))
    assert got == ["AMBIGUOUS", "HARD_CONFLICT", "TEMPORAL_MISMATCH"]
    ms = prose(h, "x")
    assert errors_of(j(h, "J02", {"candidate_refs": [ms]}))[0][0] == "INVALID_INPUT"


def test_j03_duplicates_exact_near_and_name_only(h):
    a = canon(h, facts=[fact("k", "x.home", "harbor", 0, None)], concept="Kell")
    b = canon(h, facts=[fact("k", "x.home", "harbor", 0, None)], concept="Kell")
    c = canon(h, facts=[], concept="Kell")
    d = canon(h, facts=[], concept="Kell")
    r = j(h, "J03", {"record_refs": [a, b, c, d]})
    dec = ids(r["result"]["duplicate_candidates"])
    assert "EXACT_DUPLICATE_FACT" in dec and dec.count("EXACT_DUPLICATE") == 2
    e = canon(h, facts=[], concept="Kell", module_id="A02")
    f = canon(h, facts=[], concept="Kell", module_id="A03")
    r2 = j(h, "J03", {"record_refs": [e, f]})
    assert r2["result"]["duplicate_candidates"] == []
    assert [x["rule_id"] for x in r2["result"]["findings"]] == ["NAME_ONLY_MATCH"]


# ------------------------------------------------------------------------------ pipeline helpers
def conflict_setup(h, locked_lifecycle="LOCKED"):
    hi = canon(h, facts=[fact("mira", "entity.name", "Mira")], concept="locked bible", lifecycle=locked_lifecycle)
    lo = canon(h, facts=[fact("mira", "entity.name", "Myra")], concept="draft bible")
    j01 = j(h, "J01", {"claim_refs": [hi, lo]})["output_refs"][0]
    assert h.approve(j01)["status"] == "APPROVED"
    j04r = j(h, "J04", {"conflict_refs": [j01]})
    assert j04r["status"] == "DRAFT", j04r
    # consumers of the options (J05/J11) can only be accepted on validated inputs (Shared s9 ACCEPT predicate)
    assert h.validate(j04r["output_refs"][0])["status"] == "VALIDATED"
    return hi, lo, j01, j04r


def test_j04_options_follow_authority(h):
    hi, lo, j01, r = conflict_setup(h)
    opts = {o["id"].rsplit("-", 2)[-2] + "-" + o["id"].rsplit("-", 1)[-1]: o for o in r["result"]["repair_options"]}
    assert opts["keep-hi"]["decision"] == "PROPOSED" and opts["keep-lo"]["decision"] == "ALTERNATIVE"
    p = [p for p in r["result"]["patches"] if p["patch_id"].startswith(opts["keep-hi"]["id"])][0]
    assert p["target_ref"] == lo and p["path"] == "/facts/0/value" and p["replacement"] == "Mira"
    # authority tie escalates
    a = canon(h, facts=[fact("ilo", "entity.name", "Ilo")])
    b = canon(h, facts=[fact("ilo", "entity.name", "Ila")])
    j01b = j(h, "J01", {"claim_refs": [a, b]})["output_refs"][0]
    r2 = j(h, "J04", {"conflict_refs": [j01b]})
    assert set(ids(r2["result"]["repair_options"])) == {"ESCALATE"}
    assert any(f["rule_id"] == "AUTHORITY_TIE" for f in r2["result"]["findings"])


def test_j05_unknown_impact_blocks_then_ranks_with_j06(h):
    hi, lo, j01, r = conflict_setup(h)
    j04 = r["output_refs"][0]
    blocked = j(h, "J05", {"option_refs": [j04]})
    assert blocked["status"] == "BLOCKED" and errors_of(blocked)[0][0] == "APPROVAL_REQUIRED"
    assert "J11:decision_request" in blocked["unresolved_requests"]
    assert any(u.startswith("J06:impact:") for u in blocked["unresolved_requests"])
    j06 = j(h, "J06", {"changed_refs": [lo], "evidence_refs": [j04]})
    assert j06["result"]["impact_known"] is True
    assert {x["record_id"] for x in j06["result"]["impact_refs"]} >= {j01["record_id"]}
    ranked = j(h, "J05", {"option_refs": [j04], "evidence_refs": [j06["output_refs"][0]]})
    assert ranked["status"] == "DRAFT", ranked
    plans = ranked["result"]["ranked_repairs"]
    top, other = plans[0], plans[1]
    n = len(j06["result"]["impact_refs"])
    assert top["state"] == "PROPOSED" and top["cost"] == 100 + n and top["affected_downstream_count"] == n
    assert other["state"] == "BLOCKED" and other["cost"] is None and other["protected_violations"] == 1
    assert h.validate(ranked["output_refs"][0])["status"] == "VALIDATED"
    # authorized protected change becomes feasible but costs 1000 per violation
    j06b = j(h, "J06", {"changed_refs": [hi], "evidence_refs": [j04]})["output_refs"][0]
    ok = k09(h, [hi])
    ranked2 = j(h, "J05", {"option_refs": [j04], "evidence_refs": [j06["output_refs"][0], j06b, ok]})
    costs = [(p["state"], p["cost"]) for p in ranked2["result"]["ranked_repairs"]]
    assert costs[0][1] < costs[1][1] and costs[1][1] >= 1100


def test_j06_stale_pin_unknown_and_branch_isolation(h):
    a = canon(h, facts=[fact("s", "entity.name", "A")])
    j01 = j(h, "J01", {"claim_refs": [a]})["output_refs"][0]
    r = j(h, "J06", {"changed_refs": [a]})
    assert r["result"]["impact_known"] is True
    assert [x["record_id"] for x in r["result"]["impact_refs"]] == [j01["record_id"]]
    seed(h, "A01", rec(h, a)["data"], record=rec(h, a), lifecycle="DRAFT")
    r2 = j(h, "J06", {"changed_refs": [a]})
    assert r2["result"]["impact_known"] is False


# ------------------------------------------------------------------------------ full walkthrough
def approved_j07(h):
    hi, lo, j01, r = conflict_setup(h)
    j04 = r["output_refs"][0]
    j06 = j(h, "J06", {"changed_refs": [lo], "evidence_refs": [j04]})["output_refs"][0]
    j05 = j(h, "J05", {"option_refs": [j04], "evidence_refs": [j06]})["output_refs"][0]
    assert h.approve(j05)["status"] == "APPROVED"
    j07r = j(h, "J07", {"approved_option_ref": j05})
    assert j07r["status"] == "DRAFT", j07r
    contract = [f for f in j07r["result"]["findings"] if f["rule_id"] == "PATCH_CONTRACT"]
    assert '"inverse": "Myra"' in contract[0]["message"]
    j07 = j07r["output_refs"][0]
    assert h.approve(j07)["status"] == "APPROVED"
    return hi, lo, j01, j07


def test_j_walkthrough_prepare_owner_validate_commit_revalidate(h):
    hi, lo, j01, j07 = approved_j07(h)
    prep = j(h, "J08", {"approved_patch_ref": j07})
    assert prep["status"] == "DRAFT", prep
    assert prep["result"]["transaction_state"] == "PREPARED"
    j08 = prep["output_refs"][0]
    staged = prep["output_refs"][1]
    assert staged["owner"] == "A" and staged["record_id"] == lo["record_id"] and staged["version"] == 2
    # nothing visible yet: approved head still v1
    assert rec(h, lo)["approved_version"] == 1
    # commit refused until the owner validated its part, and without explicit approval
    appr = k09(h, [j08])
    early = h.accept(j08, appr)
    assert early["status"] in ("BLOCKED", "DRAFT") and rec(h, lo)["approved_version"] == 1
    assert h.validate(staged)["status"] == "VALIDATED"
    assert errors_of(h.accept(j08))[0][0] == "APPROVAL_REQUIRED"
    done = h.accept(j08, appr)
    assert done["status"] == "APPROVED", done
    assert rec(h, lo)["approved_version"] == 2 and rec(h, staged)["lifecycle"] == "APPROVED"
    assert rec(h, j01)["stale"] is True  # consumer of the changed canon
    assert rec(h, hi)["approved_version"] == 1  # untouched participant-free record
    up = h.dispatch("J08", "UPDATE", base_ref=j08, payload={"commit_receipts": [], "transaction_state": "COMMITTED",
                                                            "findings": []})
    assert up["status"] == "DRAFT" and up["result"]["commit_receipts"][0]["output_ref"] == staged
    j10 = j(h, "J10", {"repair_receipt_ref": up["output_refs"][0]})
    assert j10["status"] == "DRAFT", j10
    reports = {r["id"].split("-")[0]: r["decision"] for r in j10["result"]["validation_reports"]}
    assert reports["rv"] == "PASS" and reports["rc"] == "RESOLVED"


def test_j08_protected_change_needs_unexpired_authorization(h):
    hi = canon(h, facts=[fact("mira", "entity.name", "Mira")], lifecycle="LOCKED")
    jp = seed(h, "J07", {"patch_proposals": [{"patch_id": "p1", "target_ref": hi, "path": "/facts/0/value",
                                              "replacement": "Myra", "reason": "user chose", "approval_ref": None}],
                         "findings": []})
    r = j(h, "J08", {"approved_patch_ref": jp})
    assert r["status"] == "BLOCKED" and errors_of(r)[0][0] == "LOCKED_FACT"
    old = k09(h, [jp], expires_in=-30)
    assert errors_of(j(h, "J08", {"approved_patch_ref": jp, "evidence_refs": [old]}))[0][0] == "EXPIRED_APPROVAL"
    ok = k09(h, [jp], expires_in=3600)
    prep = j(h, "J08", {"approved_patch_ref": jp, "evidence_refs": [ok]})
    assert prep["status"] == "DRAFT", prep
    j08 = prep["output_refs"][0]
    h.validate(prep["output_refs"][1])
    # an expired commit approval is rejected by the kernel; protected head stays LOCKED v1
    expired_commit = k09(h, [j08], expires_in=-1)
    assert errors_of(h.accept(j08, expired_commit))[0][0] == "EXPIRED_APPROVAL"
    assert rec(h, hi)["approved_version"] == 1 and rec(h, hi)["lifecycle"] == "LOCKED"
    assert h.accept(j08, k09(h, [j08]))["status"] == "APPROVED"
    assert rec(h, hi)["approved_version"] == 2


def two_owner_patch(h):
    a = canon(h, facts=[fact("mira", "entity.name", "Myra")])
    b = canon(h, module_id="A02", facts=[fact("port", "entity.name", "Portt")])
    jp = seed(h, "J07", {"patch_proposals": [
        {"patch_id": "p1", "target_ref": a, "path": "/facts/0/value", "replacement": "Mira", "reason": "r",
         "approval_ref": None},
        {"patch_id": "p2", "target_ref": b, "path": "/facts/0/value", "replacement": "Port", "reason": "r",
         "approval_ref": None}], "findings": []})
    return a, b, jp


def crash(point):
    def hook(p):
        if p == point:
            raise CrashInjected(p)
    return hook


def test_j08_interrupted_prepare_and_commit_never_mixed(h):
    a, b, jp = two_owner_patch(h)
    h.store.fault_hook = crash("before_commit")
    r = j(h, "J08", {"approved_patch_ref": jp})
    h.store.fault_hook = None
    assert r["errors"] and rec(h, a)["latest_version"] == 1 and rec(h, b)["latest_version"] == 1
    prep = j(h, "J08", {"approved_patch_ref": jp})
    j08, sa, sb = prep["output_refs"]
    h.validate(sa)
    # only one owner validated: commit refused, nothing promoted
    blocked = h.accept(j08, k09(h, [j08]))
    assert blocked["status"] == "BLOCKED" and rec(h, a)["approved_version"] == 1
    h.validate(sb)
    appr = k09(h, [j08])
    h.store.fault_hook = crash("before_commit")
    bad = h.accept(j08, appr)
    h.store.fault_hook = None
    assert bad["errors"]
    assert (rec(h, a)["approved_version"], rec(h, b)["approved_version"]) == (1, 1)
    good = h.accept(j08, appr)
    assert good["status"] == "APPROVED", good
    assert (rec(h, a)["approved_version"], rec(h, b)["approved_version"]) == (2, 2)
    receipts = h.store.list_state(h.project_id, h.branch_id, "j08.commits")[j08["record_id"]]["receipts"]
    assert {r["output_ref"]["record_id"] for r in receipts} == {a["record_id"], b["record_id"]}


def test_j08_intervening_revision_and_compensation(h):
    a, b, jp = two_owner_patch(h)
    prep = j(h, "J08", {"approved_patch_ref": jp})
    j08, sa, sb = prep["output_refs"]
    h.validate(sa)
    h.validate(sb)
    seed(h, "A02", rec(h, b)["data"], record=rec(h, sb), lifecycle="DRAFT")  # someone else revised b
    gate = h.accept(j08, k09(h, [j08]))
    assert gate["status"] == "BLOCKED"
    assert any(f["rule_id"] == "VERSION_CONFLICT" for f in gate["findings"])
    comp = h.dispatch("J08", "UPDATE", base_ref=j08, payload={"commit_receipts": [], "transaction_state":
                                                              "COMPENSATED", "findings": []})
    assert comp["status"] == "BLOCKED" and "J11:decision_request" in comp["unresolved_requests"]
    # stale J07 base: a fresh prepare against moved heads is a VERSION_CONFLICT
    assert errors_of(j(h, "J08", {"approved_patch_ref": jp}))[0][0] == "VERSION_CONFLICT"
    with_no_commit = h.dispatch("J08", "UPDATE", base_ref=j08, payload={
        "commit_receipts": [], "transaction_state": "COMMITTED", "findings": []})
    assert errors_of(with_no_commit)[0][0] == "APPROVAL_REQUIRED"


def test_j08_compensation_rejects_unpromoted_participants(h):
    a, b, jp = two_owner_patch(h)
    prep = j(h, "J08", {"approved_patch_ref": jp})
    j08, sa, sb = prep["output_refs"]
    comp = h.dispatch("J08", "UPDATE", base_ref=j08, payload={"commit_receipts": [], "transaction_state":
                                                              "COMPENSATED", "findings": []})
    assert comp["result"]["transaction_state"] == "COMPENSATED"
    assert rec(h, sa)["lifecycle"] == "REJECTED" and rec(h, a)["approved_version"] == 1


# ------------------------------------------------------------------------------ J09 / J10 / J11
def test_j09_passage_impact_exact_references_only(h):
    a = canon(h, facts=[fact("mira", "entity.name", "Mira")])
    hit = prose(h, "Mira opened the door. Admiral was there. Mira smiled.")
    miss = prose(h, "Nobody here. Admirable.")
    miss_hash = rec(h, miss)["content_hash"]
    a2 = seed(h, "A01", dict(rec(h, a)["data"], facts=[fact("mira", "entity.name", "Myra")]), record=rec(h, a))
    r = j(h, "J09", {"changed_fact_refs": [a2]})
    assert r["status"] == "DRAFT", r
    impacts = r["result"]["passage_impacts"]
    assert [i["source_refs"][0]["record_id"] for i in impacts] == [hit["record_id"]]
    ev = [f for f in r["result"]["findings"] if f["rule_id"] == "PASSAGE_REFERENCE"][0]["evidence"]
    assert [(e["start"], e["end"]) for e in ev] == [(0, 4), (41, 45)]
    assert all(e["text_hash"] == sha256_text("Mira") for e in ev)
    assert {p["replacement"] for p in r["result"]["patches"]} == {"Myra"}
    assert rec(h, miss)["content_hash"] == miss_hash
    assert h.validate(r["output_refs"][0])["status"] == "VALIDATED"


def test_j11_decision_records_bind_exact_proposal(h):
    hi, lo, j01, r = conflict_setup(h)
    j04 = r["output_refs"][0]
    req = j(h, "J11", {"proposal_ref": j04})
    assert req["result"]["approval_records"] == []
    assert "J11:user_decision" in req["unresolved_requests"]
    assert any(f["rule_id"] == "DECISION_REQUIRED" and "approver_scope" in f["message"]
               for f in req["result"]["findings"])
    assert h.validate(req["output_refs"][0])["status"] == "VALIDATED"
    assert h.accept(req["output_refs"][0])["status"] == "BLOCKED"
    expired = k09(h, [j04], expires_in=-5)
    other = k09(h, [lo])
    r2 = j(h, "J11", {"proposal_ref": j04, "evidence_refs": [expired, other]})
    rules = {f["rule_id"] for f in r2["result"]["findings"]}
    assert {"EXPIRED_APPROVAL", "APPROVAL_MISMATCH", "DECISION_REQUIRED"} <= rules
    ok = k09(h, [j04])
    r3 = j(h, "J11", {"proposal_ref": j04, "evidence_refs": [ok]})
    recs = r3["result"]["approval_records"]
    assert len(recs) == 1 and recs[0]["decision"] == "APPROVED" and recs[0]["subject_ref"] == j04
    assert h.approve(r3["output_refs"][0])["status"] == "APPROVED"
    rej = k09(h, [j04], decision="REJECTED", expires_in=None)
    r4 = j(h, "J11", {"proposal_ref": j04, "evidence_refs": [rej]})
    assert any(f["rule_id"] == "DECISION_REJECTED" for f in r4["result"]["findings"])


def test_waivers_bind_exact_hashes_and_nonwaivable_rules(h):
    ref = canon(h, facts=[])
    finding = {"id": "x", "rule_id": "STYLE", "severity": "BLOCKING", "decision": "FAIL", "message": "m",
               "evidence": [], "source_refs": [], "confidence": None}
    w = {"waiver_id": "w1", "finding_ref": ref, "source_refs": [], "policy_ref": ref, "approver_id": "author-1",
         "reason": "accepted risk", "expires_at": iso(600), "action_hash": waiver_action_hash(finding, ref)}
    assert h.engine.contracts.check_shared("Waiver", w) == []
    assert waiver_applies(w, finding, ref, [])[0] is True
    assert waiver_applies(dict(w, expires_at=iso(-1)), finding, ref, [])[0] is False
    assert waiver_applies(w, dict(finding, message="changed"), ref, [])[0] is False
    assert waiver_applies(w, finding, ref, [ref])[0] is False
    for rule in ("SCHEMA", "STALE", "HASH_MISMATCH", "VERSION_CONFLICT", "LOCKED_FACT", "OWNERSHIP"):
        assert not waivable(dict(finding, rule_id=rule))
        assert waiver_applies(w, dict(finding, rule_id=rule), ref, [])[0] is False


def test_j_logic_ops_reject_manual_candidates(h):
    a = canon(h, facts=[])
    r = h.create("J06", {"changed_refs": [a]}, manual_candidate={"impact_refs": [], "impact_known": True,
                                                                 "findings": [], "patches": []})
    assert errors_of(r)[0][0] == "INVALID_INPUT"


def test_j10_conflict_remains_and_escalates_after_three_iterations(h):
    hi = canon(h, facts=[fact("mira", "entity.name", "Mira")], lifecycle="LOCKED")
    lo = canon(h, facts=[fact("mira", "entity.name", "Myra")])
    lo2 = canon(h, module_id="A02", facts=[fact("mira", "entity.name", "Mora")])
    j01 = j(h, "J01", {"claim_refs": [hi, lo, lo2]})["output_refs"][0]
    jp = seed(h, "J07", {"patch_proposals": [{"patch_id": "p1", "target_ref": lo, "path": "/facts/0/value",
                                              "replacement": "Mira", "reason": "partial fix",
                                              "approval_ref": None}], "findings": []})
    prep = j(h, "J08", {"approved_patch_ref": jp})
    j08, staged = prep["output_refs"]
    h.validate(staged)
    assert h.accept(j08, k09(h, [j08]))["status"] == "APPROVED"
    with h.store.transaction() as tx:
        tx.put_state(h.project_id, h.branch_id, "j10.iterations", jp["record_id"], {"failures": 2})
    r = j(h, "J10", {"repair_receipt_ref": j08})
    assert r["status"] == "DRAFT", r
    decisions = {x["id"].split("-")[0]: x["decision"] for x in r["result"]["validation_reports"]}
    assert decisions["rc"] == "CONFLICT_REMAINS" and rec(h, j01)["stale"] is True
    assert any(f["rule_id"] == "ESCALATE" for f in r["result"]["findings"])
    assert "J11:decision_request" in r["unresolved_requests"]
    # an uncommitted repair is never revalidated as resolved
    a = canon(h, facts=[fact("q", "entity.name", "Q")])
    jp2 = seed(h, "J07", {"patch_proposals": [{"patch_id": "p1", "target_ref": a, "path": "/facts/0/value",
                                               "replacement": "R", "reason": "r", "approval_ref": None}],
                          "findings": []})
    prep2 = j(h, "J08", {"approved_patch_ref": jp2})["output_refs"][0]
    assert errors_of(j(h, "J10", {"repair_receipt_ref": prep2}))[0][0] == "APPROVAL_REQUIRED"
