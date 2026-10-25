"""GET /api/sets: the 11 module sets with plain-language guide data, per-operation counts, featured
actions that point at real operations, "what's next" along the main path, and the same access rules
as every other /api endpoint. Also: Bible Builder runs accept optional author guidance."""
from __future__ import annotations

import pytest

from akowe.assist import AssistService, supports
from akowe.sets_guide import FEATURED_TYPES, MAIN_PATH, SET_GUIDE, SET_IDS, sets_overview

from test_assist import FakeAI, ai_on, bible, idle
from test_server import OTHER_TOKEN, call, server  # noqa: F401  (pytest fixture re-export)
from akowe.canonical import sha256_bytes


def test_eleven_sets_cover_every_operation_exactly_once(contracts):
    out = sets_overview(contracts)
    assert [s["set_id"] for s in out["sets"]] == list("ABCDEFGHIJK") == list(SET_IDS)
    ids = [o["op_id"] for s in out["sets"] for o in s["operations"]]
    assert len(ids) == 142 and sorted(ids) == sorted(contracts.operation_ids)
    for s in out["sets"]:
        assert all(o["op_id"][0] == s["set_id"] for o in s["operations"])
        assert s["name"] and s["icon"] and s["purpose"] and s["about"] and s["stage"]
        assert set(s["depends_on"]) <= set(SET_IDS) - {s["set_id"]}
        assert s["record_count"] == 0 and s["approved_count"] == 0
    assert sorted(s["build_order"] for s in out["sets"]) == list(range(1, 12))
    # without a project there is no "what's next"
    assert out["next_step"] is None and out["main_path"] == list(MAIN_PATH)


def test_featured_actions_reference_real_operations(contracts):
    out = sets_overview(contracts)
    for s in out["sets"]:
        assert 1 <= len(s["featured_actions"]) <= 3, s["set_id"]
        for f in s["featured_actions"]:
            assert f["type"] in FEATURED_TYPES and f["label"] and f["id"]
            if f["type"] in ("make", "new", "open"):
                assert contracts.operation(f["op"]) is not None and f["op"][0] == s["set_id"]
                assert f["op_title"] == contracts.operation(f["op"])["name"]
            if f["type"] == "make":
                # "make some for me" only where the proposal (assist / Bible Builder) path exists
                assert supports(contracts, f["op"]) and 1 <= f["count"] <= 10
            if f["type"] == "page":
                assert f["page"] in ("progress", "activity", "manifest")
    a = {f["id"]: f for f in out["sets"][0]["featured_actions"]}
    assert a["make-characters"]["op"] == "A01" and "protagonist" in a["make-characters"]["hints"]
    assert out["sets"][0]["featured_actions"][0]["id"] == "make-characters"  # prominent: first
    b = {f["op"] for f in out["sets"][1]["featured_actions"] if f["type"] == "make"}
    assert {"B01", "B03"} <= b
    # LOGIC operations are never offered as AI creative work
    for s in out["sets"]:
        for f in s["featured_actions"]:
            if f["type"] == "make":
                assert not contracts.operation(f["op"])["execution"].startswith("LOGIC")
    assert all(op in contracts.operation_ids for op in MAIN_PATH)
    for g in SET_GUIDE.values():
        assert len(g["op_order"]) == len(set(g["op_order"]))


def test_ai_flags_follow_contract(contracts):
    ops = {o["op_id"]: o for s in sets_overview(contracts)["sets"] for o in s["operations"]}
    assert ops["A01"]["ai_capable"] and ops["B01"]["ai_capable"]
    assert not ops["C01"]["ai_capable"] and not ops["C01"]["uses_ai"]  # deterministic context loader
    assert ops["C02"]["uses_ai"] and ops["C02"]["ai_capable"]  # instructions can be AI-proposed
    assert ops["E11"]["uses_ai"] and not ops["E11"]["ai_capable"]  # state comes from evidence, never proposals
    assert not ops["G11"]["uses_ai"] and ops["G11"]["kind"] == "LOGIC"


def test_counts_lifecycle_and_whats_next(h, contracts):
    recs = lambda: h.store.list_records(h.project_id, "main")  # noqa: E731
    manifest = lambda: h.store.feature_manifest(h.project_id, "main")  # noqa: E731
    out = sets_overview(contracts, recs(), manifest())
    assert out["next_step"]["op_id"] == "A01" and "no records" in out["next_step"]["reason"]
    cand = {"concept": "Mara Vell", "attributes": {}, "linked_refs": [], "protected_fact_flags": [], "facts": []}
    r = h.create("A01", {"concept": "Mara Vell"}, manual_candidate=cand)
    assert r["status"] == "DRAFT", r
    out = sets_overview(contracts, recs(), manifest())
    a01 = out["sets"][0]["operations"][0]
    assert a01["op_id"] == "A01" and a01["record_count"] == 1 and a01["approved_count"] == 0
    assert a01["latest_lifecycle"] == "DRAFT" and a01["required"] is True
    assert out["next_step"]["op_id"] == "A01" and "none approved" in out["next_step"]["reason"]
    assert out["sets"][0]["record_count"] == 1
    a = h.approve(r["output_refs"][0])
    assert a["status"] == "APPROVED", a
    out = sets_overview(contracts, recs(), manifest())
    a01 = out["sets"][0]["operations"][0]
    assert a01["approved_count"] == 1 and a01["latest_lifecycle"] == "APPROVED"
    assert out["sets"][0]["ops_with_approved"] == 1
    assert out["next_step"]["op_id"] == "B01" and out["next_step"]["set_id"] == "B"
    # an operation the manifest does not require is skipped by "what's next"
    m = dict(manifest())
    m["required_operations"] = [op for op in m["required_operations"] if op != "B01"]
    h.engine.set_manifest(h.principal, h.project_id, "main", m)
    out = sets_overview(contracts, recs(), manifest())
    assert out["next_step"]["op_id"] == "B03"
    b01 = [o for o in out["sets"][1]["operations"] if o["op_id"] == "B01"][0]
    assert b01["required"] is False


def test_sets_endpoint_auth_and_access(server):  # noqa: F811
    app, port = server
    assert call(port, "GET", "/api/sets", token=None)[0] == 401
    assert call(port, "GET", "/api/sets", token="wrong")[0] == 401
    status, out, _ = call(port, "GET", "/api/sets")
    assert status == 200 and len(out["sets"]) == 11 and out["next_step"] is None
    status, proj, _ = call(port, "POST", "/api/projects", {"name": "Sets Book"})
    pid = proj["project_id"]
    status, out, _ = call(port, "GET", f"/api/sets?project_id={pid}&branch_id=main")
    assert status == 200 and out["project_id"] == pid and out["next_step"]["op_id"] == "A01"
    assert sum(len(s["operations"]) for s in out["sets"]) == 142
    assert call(port, "GET", f"/api/sets?project_id={pid}&branch_id=nope")[0] == 404
    assert call(port, "GET", "/api/sets?project_id=missing")[0] in (403, 404)
    with app.store.transaction() as tx:
        tx.ensure_principal("other", "Other Author", sha256_bytes(OTHER_TOKEN.encode()))
    status, err, _ = call(port, "GET", f"/api/sets?project_id={pid}", token=OTHER_TOKEN)
    assert status == 403 and err["errors"][0]["code"] == "PERMISSION_DENIED"


# ---------------------------------------------------------------- Bible Builder guidance
@pytest.fixture
def svc(h):
    return AssistService(h.engine, h.principal)


def test_bible_run_guidance_reaches_ai_but_not_report(h, svc):
    fake = FakeAI()
    ai_on(h, fake)
    guide = "Roles to cover: protagonist, mentor. ZZGUIDE"
    s = svc.create_bible(h.principal, {"project_id": h.project_id, "branch_id": "main", "idea": "A foggy coast",
                                       "counts": {"A01": 2}, "guidance": guide})
    s = idle(svc, h, s["session_id"])
    assert [i["op"] for i in s["items"]] == ["A01", "A01"] and all(i["status"] == "done" for i in s["items"])
    sketch = fake.calls[0]
    assert sketch["context"]["author_guidance"] == guide.strip()
    item_users = [c for c in fake.calls[1:]]
    assert item_users and all(c["context"].get("this_item") for c in item_users)
    # follow-up run without guidance: no author_guidance in the sketch
    s = svc.run_bible(h.principal, s["session_id"], {"sections": {"A04": 1}})
    s = idle(svc, h, s["session_id"])
    later = [c for c in fake.calls if "world_summary" in c["schema"]["properties"]][-1]
    assert "author_guidance" not in later["context"]
    md, js = svc.bible_report(h.principal, s["session_id"])
    assert "ZZGUIDE" not in md.read_text() and "ZZGUIDE" not in js.read_text()
    # validation
    for bad in (123, "x" * 2001):
        with pytest.raises(Exception) as exc:
            svc.run_bible(h.principal, s["session_id"], {"sections": {"A01": 1}, "guidance": bad})
        assert getattr(exc.value, "code", None) == "INVALID_INPUT"
    assert bible  # helper imported from test_assist stays available
