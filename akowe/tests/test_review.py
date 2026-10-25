"""Review queue, Current task, AI reviewer (fake adapter) and the opt-in auto-approve setting."""
from __future__ import annotations

import json
import time

import pytest

from bookforge.assist import AssistService
from bookforge.book_path import BookPath, save_profile
from bookforge.errors import BookforgeError
from bookforge.review import REVIEW_SCHEMA, ReviewService, current_task, keep_refs

from test_server import call, server  # noqa: F401


def fact(s, p, v, a="FACT"):
    return {"subject_id": s, "predicate": p, "value": v, "assertion_type": a, "effective_from": None,
            "effective_to": None, "source_refs": []}


class FakeAI:
    """submit(slot, system, user, schema): a scripted review verdict, or a revised B01 for "fix"."""

    def __init__(self, verdict="APPROVE"):
        self.verdict = verdict
        self.calls = []
        self.fail = False

    def submit(self, slot, system, user, schema):
        self.calls.append({"system": system, "schema": schema, "user": user})
        if self.fail:
            raise BookforgeError("UPSTREAM_UNAVAILABLE", "", "fake bridge down")
        if "verdict" in (schema.get("properties") or {}):
            return {"verdict": self.verdict, "reasons": ["It fits the book.", "Clear."],
                    "suggested_changes": [] if self.verdict == "APPROVE" else ["Name the harbor."],
                    "confidence": 0.8}, {"model": "fake-model", "input_tokens": 1, "output_tokens": 1}
        return {"premise": "A revised premise about the foggy harbor.", "dramatic_question": "Will she?",
                "concept_summary": "Revised."}, {"model": "fake-model"}


@pytest.fixture
def rv(h):
    svc = ReviewService(h.engine, AssistService(h.engine, h.principal), h.principal)
    return svc


def a01(h, name="Mara Vell"):
    cand = {"concept": name, "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
            "facts": [fact(name.split()[0].lower(), "entity.name", name)]}
    return h.create("A01", {"concept": name}, manual_candidate=cand)["output_refs"][0]


def b01(h):
    return h.create("B01", {"idea": "a lighthouse mystery", "goals": []}, manual_candidate={
        "premise": "An apprentice searches for her master.", "dramatic_question": "Will she find him?",
        "concept_summary": "A coastal mystery."})["output_refs"][0]


def wait(svc, principal, job):
    for _ in range(200):
        j = svc.get_job(principal, job["job_id"])
        if j["status"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def use_fake(h, verdict="APPROVE"):
    fake = FakeAI(verdict)
    h.engine.providers.test_adapter = fake
    h.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
    return fake


def test_queue_order_filters_and_approve_all(h, rv):
    p = b01(h)
    c = a01(h)
    # helper records never show up as approvals: a K09 checkpoint draft and an approved record
    q = rv.queue(h.principal, h.project_id, "main")
    ids = [i["record_id"] for i in q["items"]]
    assert ids == [c["record_id"], p["record_id"]]  # A before B (book-process order)
    assert q["items"][0]["group"].startswith("A · ") and q["items"][0]["made_by"]["kind"] == "you"
    assert q["count"] == 2 and q["settings"]["auto_approve"] is False
    with pytest.raises(BookforgeError) as exc:
        rv.approve(h.principal, h.project_id, "main", {"record_ids": ids})
    assert exc.value.code == "APPROVAL_REQUIRED"
    # a stale version number is refused in plain words and stays in the list
    out = rv.approve(h.principal, h.project_id, "main", {"record_ids": ids, "author_confirms": True, "how": "all",
                                                         "versions": {c["record_id"]: 7}})
    bad = [r for r in out["results"] if not r["ok"]]
    assert out["approved"] == 1 and len(bad) == 1 and "changed since you looked" in bad[0]["message"]
    assert [i["record_id"] for i in rv.queue(h.principal, h.project_id, "main")["items"]] == [c["record_id"]]
    out = rv.approve(h.principal, h.project_id, "main", {"record_ids": [c["record_id"]], "author_confirms": True})
    assert out["ok"] and rv.queue(h.principal, h.project_id, "main")["count"] == 0
    events = [json.loads(r["payload"]) for r in h.store.query(
        "SELECT payload FROM outbox WHERE project_id=? AND event_type='review.approved_by_author'", (h.project_id,))]
    assert len(events) == 2 and events[0]["how"] == "all" and "Approve all" in events[0]["label"]


def test_chapter_approval_records_k09_and_current_task_routes(h, rv):
    save_profile(h.store, h.project_id, {"title": "T", "idea": "x", "chapters": 1, "ai_slot": "manual"})
    q = rv.queue(h.principal, h.project_id, "main")
    assert q["current_task"]["action"] == "new" and q["current_task"]["op"] == "A01"
    c = a01(h)
    t = rv.queue(h.principal, h.project_id, "main")["current_task"]
    assert t["action"] == "review" and t["record_id"] == c["record_id"] and t["set"] == "A" and t["op"] == "A01"
    assert t["hash"].endswith(f"/review/step/{c['record_id']}") and t["state"] == "needs_you"
    rv.approve(h.principal, h.project_id, "main", {"record_ids": [c["record_id"]], "author_confirms": True})
    t = rv.queue(h.principal, h.project_id, "main")["current_task"]
    assert t["step"] == "premise" and t["action"] == "book_step" and (t["set"], t["op"]) == ("B", "B01")
    # empty profile -> the profile is the current task
    status = {"steps": [{"id": "profile", "title": "Book profile", "state": "needs_you", "approve": []}]}
    assert current_task(status, [], "p", "main")["action"] == "profile"
    assert current_task({"steps": [{"id": "x", "state": "done"}]}, [], "p", "main")["state"] == "done"


def test_ai_review_never_auto_approves_when_off_and_settings_need_consent(h, rv):
    fake = use_fake(h, "APPROVE")
    p = b01(h)
    j = wait(rv, h.principal, rv.start_review(h.principal, h.project_id, "main", {"record_ids": [p["record_id"]]}))
    assert j["status"] == "done" and j["results"][0]["review"]["verdict"] == "APPROVE"
    assert j["results"][0]["auto_approved"] is False
    assert "verdict" in fake.calls[0]["schema"]["properties"] and "strict but fair editor" in fake.calls[0]["system"]
    item = rv.queue(h.principal, h.project_id, "main")["items"][0]
    assert item["review"]["verdict"] == "APPROVE" and item["review"]["slot"] == "AI-1"
    assert h.store.history(h.project_id, "main", p["record_id"])[-1]["lifecycle"] == "DRAFT"
    # stored as advice in settings, not as a record
    assert h.store.get_setting(f"ai_reviews:{h.project_id}:main")[f"{p['record_id']}:1"]["verdict"] == "APPROVE"
    with pytest.raises(BookforgeError) as exc:
        rv.save_settings(h.principal, h.project_id, "main", {"auto_approve": True})
    assert exc.value.code == "APPROVAL_REQUIRED"
    assert rv.settings(h.project_id)["auto_approve"] is False


def test_auto_approve_only_on_approve_verdict_and_logged(h, rv):
    fake = use_fake(h, "REVISE")
    st = rv.save_settings(h.principal, h.project_id, "main", {"auto_approve": True, "author_confirms": True})
    assert st["auto_approve"] and st["consent"]["by"] == h.principal and st["consent"]["at"]
    p = b01(h)
    j = wait(rv, h.principal, rv.start_review(h.principal, h.project_id, "main", {"record_ids": [p["record_id"]]}))
    assert j["results"][0]["review"]["verdict"] == "REVISE" and not j["results"][0]["auto_approved"]
    fake.fail = True
    j = wait(rv, h.principal, rv.start_review(h.principal, h.project_id, "main", {"record_ids": [p["record_id"]]}))
    assert j["results"][0]["ok"] is False and h.store.history(h.project_id, "main", p["record_id"])[-1]["lifecycle"] == "DRAFT"
    fake.fail, fake.verdict = False, "APPROVE"
    j = wait(rv, h.principal, rv.start_review(h.principal, h.project_id, "main", {"record_ids": [p["record_id"]]}))
    assert j["results"][0]["auto_approved"] is True
    assert h.store.history(h.project_id, "main", p["record_id"])[-1]["lifecycle"] == "APPROVED"
    ev = [json.loads(r["payload"]) for r in h.store.query(
        "SELECT payload FROM outbox WHERE project_id=? AND event_type='review.auto_approved'", (h.project_id,))]
    assert len(ev) == 1 and ev[0]["consent"]["by"] == h.principal and "standing setting" in ev[0]["label"]
    # turned off again: an APPROVE verdict no longer approves anything
    rv.save_settings(h.principal, h.project_id, "main", {"auto_approve": False})
    p2 = b01(h)
    j = wait(rv, h.principal, rv.start_review(h.principal, h.project_id, "main", {"record_ids": [p2["record_id"]]}))
    assert j["results"][0]["auto_approved"] is False
    assert h.store.history(h.project_id, "main", p2["record_id"])[-1]["lifecycle"] == "DRAFT"


def test_ask_ai_to_fix_makes_a_new_draft_version(h, rv):
    use_fake(h, "REVISE")
    p = b01(h)
    wait(rv, h.principal, rv.start_review(h.principal, h.project_id, "main", {"record_ids": [p["record_id"]]}))
    j = wait(rv, h.principal, rv.start_fix(h.principal, h.project_id, "main", {"record_id": p["record_id"]}))
    assert j["status"] == "done", j
    hist = h.store.history(h.project_id, "main", p["record_id"])
    assert hist[-1]["version"] == 2 and hist[-1]["lifecycle"] == "DRAFT"
    assert hist[-1]["data"]["premise"].startswith("A revised premise")
    item = rv.queue(h.principal, h.project_id, "main")["items"][0]
    assert item["version"] == 2 and item["made_by"]["kind"] == "ai_fix" and item["review"] is None


def test_keep_refs_never_takes_references_from_the_model():
    ref = {"project_id": "p", "branch_id": "main", "owner": "A", "module_id": "A01", "record_id": "r1", "version": 1,
           "content_hash": "h"}
    fake = dict(ref, record_id="invented")
    out = keep_refs({"x": ref, "list": [ref], "text": "old"}, {"x": fake, "list": [fake, fake], "text": "new",
                                                              "extra": fake})
    assert out == {"x": ref, "list": [ref], "text": "new"}
    assert REVIEW_SCHEMA["properties"]["verdict"]["enum"] == ["APPROVE", "REVISE", "REJECT"]


def test_review_endpoints_over_http(server):  # noqa: F811
    app, port = server
    status, proj, _ = call(port, "POST", "/api/projects", {"name": "Queue Book"})
    pid = proj["project_id"]
    cand = {"concept": "Mara", "attributes": {}, "linked_refs": [], "protected_fact_flags": [], "facts": []}
    call(port, "POST", "/api/dispatch", {"request": {"project_id": pid, "branch_id": "main", "target_operation": "A01",
                                                     "action": "CREATE", "payload": {"concept": "Mara"}},
                                         "manual_candidate": cand})
    base = f"/api/projects/{pid}/branches/main/review"
    status, q, _ = call(port, "GET", base)
    assert status == 200 and q["count"] == 1 and q["current_task"]["action"] in ("review", "profile")
    status, s, _ = call(port, "GET", base + "/summary")
    assert status == 200 and s["count"] == 1 and "current_task" in s
    assert call(port, "GET", base, token=None)[0] == 401
    assert call(port, "POST", base + "/approve", {"record_ids": [q["items"][0]["record_id"]]})[0] == 400
    status, out, _ = call(port, "POST", base + "/approve", {"record_ids": [q["items"][0]["record_id"]],
                                                            "author_confirms": True})
    assert status == 200 and out["ok"] and out["approved"] == 1
    status, st, _ = call(port, "PUT", base + "/settings", {"auto_approve": True})
    assert status == 400
    status, st, _ = call(port, "PUT", base + "/settings", {"auto_approve": True, "author_confirms": True})
    assert status == 200 and st["auto_approve"] is True
    status, j, _ = call(port, "POST", base + "/ai", {"record_ids": ["nope"]})
    assert status == 202
    assert call(port, "GET", base + "/ai/unknown-job")[0] == 404
