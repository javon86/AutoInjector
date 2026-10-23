"""Book profile + "Make my book": a small book goes from profile to downloadable PDF/EPUB/DOCX through the
guided path with no AI (manual candidates), approvals only on the author's explicit confirmation."""
from __future__ import annotations

import pytest

from bookforge.book_path import BookPath, clean_profile, get_profile, save_profile
from bookforge.errors import BookforgeError

from test_server import call, server  # noqa: F401


def fact(s, p, v, a="FACT"):
    return {"subject_id": s, "predicate": p, "value": v, "assertion_type": a, "effective_from": None,
            "effective_to": None, "source_refs": []}


def plan_item(item_id, order, objective):
    facts = [fact(item_id, "plan.item_id", item_id, "PLAN"), fact(item_id, "plan.order", order, "PLAN"),
             fact(item_id, "plan.parent_id", None, "PLAN"), fact(item_id, "plan.objective", objective, "PLAN"),
             fact(item_id, "plan.event_ids", [], "PLAN"), fact(item_id, "plan.pov_id", "mara", "PLAN"),
             fact(item_id, "plan.location_id", "harbor", "PLAN"), fact(item_id, "plan.obligation_ids", [], "PLAN")]
    return {"summary": f"{item_id}: {objective}", "facts": facts, "links": []}


def steps(bp):
    return {s["id"]: s for s in bp.status()["steps"]}


def approve(h, ids):
    out = BookPath(h.engine, h.principal, h.project_id, "main").act("approve", {"record_ids": ids,
                                                                                 "author_confirms": True})
    assert out["ok"], out
    return out


def test_profile_validation_and_storage(h):
    with pytest.raises(BookforgeError):
        clean_profile({"length": "epic"})
    with pytest.raises(BookforgeError):
        clean_profile({"title": 5})
    with pytest.raises(BookforgeError):
        clean_profile({"chapters": 0})
    p = save_profile(h.store, h.project_id, {"title": " The Key ", "author": "Ann", "unknown": "x", "length": "novella"})
    assert p["title"] == "The Key" and "unknown" not in p and get_profile(h.store, h.project_id)["author"] == "Ann"


def test_make_my_book_manual_end_to_end(h):
    bp = lambda: BookPath(h.engine, h.principal, h.project_id, "main")  # noqa: E731
    h.engine.set_manifest(h.principal, h.project_id, "main",
                          dict(h.store.feature_manifest(h.project_id, "main"),
                               release_profiles=["MANUSCRIPT_PDF", "EPUB_REFLOWABLE", "EDITABLE_DOCX"]))
    st = steps(bp())
    assert st["profile"]["state"] == "needs_you" and st["premise"]["state"] == "needs_you"
    assert st["plot"]["state"] == "blocked" and st["chapters"]["state"] == "blocked"
    save_profile(h.store, h.project_id, {"title": "The Lighthouse Key", "author": "Ann Writer", "length": "short_story",
                                         "idea": "An apprentice searches for her missing master.", "chapters": 2})
    # canon: a character, approved by the author
    cand = {"concept": "Mara Vell", "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
            "facts": [fact("mara", "entity.name", "Mara Vell")]}
    a04 = h.create("A04", {"concept": "Harbor"}, manual_candidate=dict(
        cand, concept="Harbor", facts=[fact("harbor", "entity.name", "Harbor")]))["output_refs"][0]
    approve(h, [a04["record_id"]])
    a01 = h.create("A01", {"concept": "Mara Vell"}, manual_candidate=cand)["output_refs"][0]
    st = steps(bp())
    assert st["canon"]["state"] == "needs_you" and st["canon"]["approve"][0]["record_id"] == a01["record_id"]
    # approval needs the author's explicit confirmation
    with pytest.raises(BookforgeError) as exc:
        bp().act("approve", {"record_ids": [a01["record_id"]]})
    assert exc.value.code == "APPROVAL_REQUIRED"
    approve(h, [a01["record_id"]])
    # premise: no AI -> a prefilled form for the author (from the profile)
    out = bp().act("create", {"op": "B01"})
    assert out["needs_manual"] and out["op"] == "B01" and out["payload"]["idea"].startswith("An apprentice")
    assert a01["record_id"] in [r["record_id"] for r in out["payload"]["canon_refs"]]
    b01 = h.create("B01", out["payload"], manual_candidate={
        "premise": "An apprentice searches for her master.", "dramatic_question": "Will she find him?",
        "concept_summary": "A coastal mystery."})["output_refs"][0]
    approve(h, [b01["record_id"]])
    out = bp().act("create", {"op": "B03"})
    b03 = h.create("B03", out["payload"], manual_candidate={
        "main_plot": {"summary": "Mara follows the trail.", "facts": [], "links": []}, "objectives": [],
        "plot_obligations": []})["output_refs"][0]
    approve(h, [b03["record_id"]])
    out = bp().act("create", {"op": "B11"})
    assert out["payload"]["target_length"] == {"unit": "chapters", "value": 2}
    b11 = h.create("B11", out["payload"], manual_candidate={
        "chapters": [plan_item("ch1", 0, "Mara reaches the lighthouse"), plan_item("ch2", 1, "Mara finds the key")],
        "unresolved_threads": []})["output_refs"][0]
    approve(h, [b11["record_id"]])
    st = steps(bp())
    assert [c["chapter_id"] for c in st["chapters"]["chapters"]] == ["ch1", "ch2"]
    # chapters: context is automatic, prose is written by the author (no AI)
    for cid, text in (("ch1", "Mara walked from the harbor to the lighthouse."), ("ch2", "She found the brass key.")):
        out = bp().act("write_chapter", {"chapter_id": cid})
        assert out["needs_manual"] and out["manual_on"] and out["payload"]["context_ref"]["module_id"] == "C01"
        r = h.create("C02", out["payload"], manual_candidate={"text": text, "candidate_events": [], "findings": []})
        assert r["status"] == "DRAFT", r
    st = steps(bp())
    assert st["chapters"]["state"] == "needs_you" and len(st["chapters"]["approve"]) == 2
    # chapter approval needs an exact-candidate K09: recorded on the author's confirmation
    approve(h, [c["record_id"] for c in st["chapters"]["approve"]])
    st = steps(bp())
    assert st["chapters"]["state"] == "done" and st["format"]["state"] == "ready"
    assert st["assemble"]["state"] == "blocked"
    out = bp().act("setup_format", {})
    assert out["ok"], out
    st = steps(bp())
    assert st["format"]["state"] == "needs_you"
    approve(h, [x["record_id"] for x in st["format"]["approve"]])
    out = bp().act("assemble", {})
    assert out["ok"], out
    st = steps(bp())
    assert st["assemble"]["state"] == "needs_you" and len(st["assemble"]["approve"]) == 7
    assert st["export"]["state"] == "blocked"
    approve(h, [x["record_id"] for x in st["assemble"]["approve"]])
    out = bp().act("export", {})
    assert out["ok"], out
    st = steps(bp())
    files = {f["format"]: f for f in st["export"]["files"]}
    assert set(files) == {"PDF", "EPUB", "DOCX"} and st["export"]["state"] == "done"
    pdf = h.store.get_record(h.project_id, "main", files["PDF"]["record_id"], files["PDF"]["version"])
    data = h.store.read_binary(pdf)
    assert data.startswith(b"%PDF") and b"brass key" in data
    out = bp().act("check", {})
    assert out["ok"], out
    assert steps(bp())["check"]["state"] == "done"
    assert bp().status()["next"] is None


def test_book_endpoints_over_http(server):  # noqa: F811
    app, port = server
    status, proj, _ = call(port, "POST", "/api/projects", {"name": "Wizard Book", "profile": {
        "title": "Wizard Book", "author": "Me", "length": "novel", "ai_slot": "manual"}})
    assert status == 201 and proj["profile"]["title"] == "Wizard Book"
    pid = proj["project_id"]
    assert call(port, "POST", "/api/projects", {"name": "Bad", "profile": {"length": "huge"}})[0] == 400
    status, prof, _ = call(port, "PUT", f"/api/projects/{pid}/profile", {"genre": "fantasy"})
    assert status == 200 and prof["genre"] == "fantasy" and prof["title"] == "Wizard Book"
    status, book, _ = call(port, "GET", f"/api/projects/{pid}/branches/main/book")
    assert status == 200 and book["steps"][0]["id"] == "profile" and book["steps"][0]["state"] == "done"
    assert book["ai_ready"] is False and book["next"] == "canon"
    status, out, _ = call(port, "POST", f"/api/projects/{pid}/branches/main/book/create", {"op": "B01"})
    assert status == 200 and out["ok"] is False and out["needs_manual"] is True
    assert call(port, "POST", f"/api/projects/{pid}/branches/main/book/nope", {})[0] == 404
    assert call(port, "GET", f"/api/projects/{pid}/branches/main/book", token=None)[0] == 401
    assert call(port, "GET", f"/api/projects/{pid}/profile", token="bad")[0] == 401
