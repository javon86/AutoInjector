"""First usable vertical slice (Build_Plan.md), end to end through engine.dispatch.

I/K kernel -> A01 -> B01/B03/B11 -> C01/C02 -> E01/E02 -> F01 -> (C11 replacement) ->
G02/G01/G05/G04/G07/G11 -> H05/H07/H08/H09 (+H02 reviewed, H03 no-obligation evidence) -> H10 -> release.

Everything here is AUTHORITATIVE evidence produced by the real handlers: no FIXTURE store
inserts, real exporter bytes, real K09 approvals (dispatched checkpoint + owner decision).
Manual candidates stand in for the creative AI slot, except B01 and the C02 event extraction,
which go through a fake engine.providers.test_adapter to prove the AI path end to end.
"""
from __future__ import annotations

import copy
import hashlib
from datetime import datetime, timedelta, timezone

from conftest import errors_of
from test_set_c import approved, character, objective_pass, places, plan_item
from test_set_e import accept_ok, e_create, head, initialized, location_facts
from test_set_g import MD, import_profile, manifest_revision, parse_pdf, set_release_profiles
from test_set_h import finding as h_finding
from test_set_h import manual as h_manual

from bookforge.exporters.pdf import inspect_pdf
from bookforge.spans import build_replacement, make_span

CH1 = ("Mara walked from the harbor to the lighthouse. The the lamp room was cold and dark, and the "
       "keeper's logbook lay open on the desk beside a cracked lantern.")
CH2 = ("At dawn she climbed the iron stairs again. She picked up the brass key from the lamp room floor "
       "and turned it over in her cold fingers.")
CH2_REVISED = CH2 + " Below, the ferry horn sounded twice across the water."

LOC_QUOTE = "walked from the harbor to the lighthouse"
KEY_QUOTE = "picked up the brass key"
PREMISE = {"premise": "A lighthouse keeper's apprentice searches for her missing master.",
           "dramatic_question": "Will Mara find the keeper before the winter ferry stops?",
           "concept_summary": "A quiet coastal mystery in two chapters."}


def raw_event(quote):
    """Raw extraction output for the quotes the fake extractor recognizes."""
    if quote == LOC_QUOTE:
        return {"entity_id": "mara", "path": "/location_id", "operation": "SET", "before": "harbor",
                "after": "lighthouse", "story_time": 100, "scene_id": "s1", "scene_order": 0, "event_order": 0,
                "evidence": [{"quote": quote}]}
    return {"entity_id": "mara", "path": "/inventory_ids", "operation": "ADD", "before": [], "after": ["brass-key"],
            "story_time": 200, "scene_id": "s2", "scene_order": 1, "event_order": 0, "evidence": [{"quote": quote}]}


class SliceAI:
    """Fake provider adapter: B01 premise and C event extraction (quotes found in the prompt)."""

    def __init__(self):
        self.calls = []

    def submit(self, slot, system, user, schema):
        usage = {"model": "fake-slice", "input_tokens": 10, "output_tokens": 10}
        props = schema.get("properties", {})
        if "events" in props:
            self.calls.append("events")
            return {"events": [raw_event(q) for q in (LOC_QUOTE, KEY_QUOTE) if q in user]}, usage
        if "Operation B01" in system:
            self.calls.append("B01")
            return dict(PREMISE), usage
        raise AssertionError(f"unexpected AI call: {system[:80]}")


def k09_for(h, subjects, minutes=60):
    """Real K09 approval: dispatched checkpoint pinning exact subjects + owner APPROVED decision."""
    payload = {"action_id": "approve-exact-candidates",
               "impact": {"action_hash": hashlib.sha256(repr(subjects).encode()).hexdigest()[:16],
                          "source_versions": list(subjects), "protected": True},
               "policy": {"policy_id": "author", "authorized_roles": ["author"], "ttl_seconds": 3600},
               "base_revision": 1}
    r = h.create("K09", payload)
    assert r["status"] == "DRAFT", r
    expiry = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
    u = h.dispatch("K09", "UPDATE", base_ref=r["output_refs"][0],
                   payload=dict(r["result"], decision="APPROVED", expiry=expiry))
    assert u["status"] == "DRAFT", u
    return u["output_refs"][0]


def ok(h, op, payload, **kw):
    r = h.create(op, payload, **kw)
    assert r["status"] == "DRAFT", (op, r["errors"], r["findings"])
    return r["output_refs"][0], r


def blocking(resp):
    return [(f["rule_id"], f["message"]) for f in resp["findings"] if f["severity"] in ("MAJOR", "BLOCKING")
            and f["decision"] != "PASS"]


def non_pass(resp):
    return [(f["rule_id"], f["decision"], f["message"]) for f in resp["result"]["findings"] if f["decision"] != "PASS"]


def origin(h, ref):
    return h.record(ref)["evidence_origin"]


def test_first_vertical_slice_end_to_end(h):
    # PDF-only manuscript release; H04 is excluded by an explicit manifest predicate.
    set_release_profiles(h, ["MANUSCRIPT_PDF"], character_arcs=False)

    # ------------------------------------------------------------------ 1. I01 profiles (user-approved)
    font_file = import_profile(h, "ASSET_MANIFEST", {"assets": [], "placement_ids": ["font:times-roman"]})
    font = import_profile(h, "FONT_PROFILE", {"font_refs": [font_file], "embedding_permitted": True,
                                              "fallback_names": ["Times-Roman"], "font_size_pt": 11,
                                              "line_height_pt": 14, "language_tag": "en"})
    page = import_profile(h, "PAGE_PROFILE", {"width_mm": 152.4, "height_mm": 228.6, "bleed_mm": 0,
                                              "safe_margin_mm": 15})
    pdf_profile = import_profile(h, "OUTPUT_PROFILE", {
        "profile_id": "manuscript-pdf", "profile_type": "MANUSCRIPT_PDF",
        "required_checks": ["H02", "H05", "H07", "H08", "H09"], "required_export_operations": ["G11"],
        "artwork_selected": False, "language_tag": "en", "metadata": dict(MD), "printer_profile_ref": None,
        "page_profile_ref": page, "font_profile_ref": font})
    import_profile(h, "PUBLICATION_METADATA", dict(MD))
    toc_style = import_profile(h, "TOC_STYLE", {"max_depth": 1, "include_pages": True, "link_targets": True})
    for ref in (font_file, font, page, pdf_profile, toc_style):
        assert h.record(ref)["lifecycle"] == "APPROVED" and origin(h, ref) == "AUTHORITATIVE"

    # ------------------------------------------------------------------ 2. A01 -> B01 (AI) -> B03 -> B11
    where = places(h, ("harbor", "lighthouse"))
    a01 = character(h, where=where)
    assert h.record(a01)["lifecycle"] == "APPROVED"

    fake = SliceAI()
    h.engine.providers.test_adapter = fake
    h.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
    r = h.create("B01", {"idea": "a lighthouse mystery", "goals": ["finish a two-chapter novella"]})
    assert r["status"] == "DRAFT", r
    b01 = r["output_refs"][0]
    assert r["result"]["premise"] == PREMISE["premise"] and fake.calls == ["B01"]
    assert h.approve(b01)["status"] == "APPROVED"

    plot = {"main_plot": {"summary": "Mara follows the keeper's trail from harbor to lighthouse.", "facts": [],
                          "links": []}, "objectives": [], "plot_obligations": []}
    b03 = approved(h, "B03", {"premise_ref": b01, "canon_refs": [a01, where], "constraints": []}, plot)
    chapters = [plan_item("ch1", 0, "Mara reaches the lighthouse", links=[a01], loc="harbor"),
                plan_item("ch2", 1, "Mara finds the brass key", loc="lighthouse")]
    outline = approved(h, "B11", {"main_plot_ref": b03, "selected_plan_refs": []},
                       {"chapters": chapters, "unresolved_threads": []})

    # ------------------------------------------------------------------ 3. C01 -> C02 (+ AI event bundle)
    prose, bundles = {}, {}
    for cid, text, findings in (("ch1", CH1, [objective_pass("ch1")]), ("ch2", CH2, [])):
        ctx_ref, c01 = ok(h, "C01", {"chapter_id": cid, "outline_ref": outline, "instruction": "context"})
        assert any(f["predicate"] == "plan.objective" for f in c01["result"]["facts"])
        r = h.dispatch("C02", "CREATE", payload={"chapter_id": cid, "outline_ref": outline, "context_ref": ctx_ref,
                                                 "instruction": "write the chapter"},
                       manual_candidate={"text": text, "candidate_events": [], "findings": findings})
        assert r["status"] == "DRAFT" and len(r["output_refs"]) == 2, r  # prose + C-owned event bundle
        prose[cid], bundle_ref = r["output_refs"]
        bundles[cid] = h.record(bundle_ref)
        assert bundles[cid]["record_kind"] == "CEventBundle" and len(bundles[cid]["data"]["events"]) == 1
    assert fake.calls.count("events") == 2
    # ch1 carries an author objective assessment -> plain ACCEPT; ch2 has none -> C requires an
    # explicit K09 approval of the exact candidate.
    assert h.approve(prose["ch1"])["status"] == "APPROVED"
    v = h.validate(prose["ch2"])
    assert v["status"] == "VALIDATED" and any(f["rule_id"] == "OBJECTIVE_REVIEW" for f in v["findings"])
    assert errors_of(h.accept(prose["ch2"]))[0] == ("APPROVAL_REQUIRED", "/payload/approval_ref")
    assert h.accept(prose["ch2"], k09_for(h, [prose["ch2"]]))["status"] == "APPROVED"

    # ------------------------------------------------------------------ 4. E01/E02 INITIALIZE -> APPLY
    loc_ev = bundles["ch1"]["data"]["events"][0]
    key_ev = bundles["ch2"]["data"]["events"][0]
    e01_start = initialized(h, "E01", "mara", a01)
    e02_start = initialized(h, "E02", "mara", a01)
    e01_ref, r = ok(h, "E01", {"character_id": "mara", "mode": "APPLY", "events": [copy.deepcopy(loc_ev),
                                                                                    copy.deepcopy(key_ev)],
                               "source_refs": [], "current_snapshot_ref": e01_start})
    assert r["result"]["accepted_event_ids"] == [loc_ev["event_id"], key_ev["event_id"]]
    accept_ok(h, e01_ref)
    r = e_create(h, "E02", "mara", "APPLY", events=[loc_ev], current_snapshot_ref=e02_start)
    assert r["status"] == "DRAFT", r
    accept_ok(h, r["output_refs"][0])
    e02_ref = r["output_refs"][0]
    assert location_facts(r["result"]["snapshot"]) == [("harbor", None, 100), ("lighthouse", 100, None)]
    assert head(h, "E01", "mara") == e01_ref and head(h, "E02", "mara") == e02_ref

    # ------------------------------------------------------------------ pre-review assembly (to be invalidated)
    old_g02, _ = ok(h, "G02", {"approved_chapter_refs": [prose["ch1"], prose["ch2"]],
                               "ordered_chapter_ids": [prose["ch1"]["record_id"], prose["ch2"]["record_id"]],
                               "manifest_revision": manifest_revision(h)})
    old_g01, _ = ok(h, "G01", {"ordered_manifest_ref": old_g02, "approved_chapter_refs": [prose["ch1"], prose["ch2"]],
                               "section_id_policy": "STABLE_ID"})

    # ------------------------------------------------------------------ 5. F01 anchored patch -> C11 replacement
    ch1_rec = h.record(prose["ch1"])
    start = CH1.index("The the")
    span = make_span(ch1_rec, start, start + len("The the"))
    review = {"kind": "narrative_findings",
              "findings": [{"id": "f-1", "rule_id": "REPEATED_WORD", "severity": "MINOR", "decision": "FAIL",
                            "message": "duplicated article", "evidence": [span], "source_refs": [],
                            "confidence": 0.95}],
              "patches": [{"patch_id": span["span_id"], "target_ref": prose["ch1"], "path": "/text",
                           "replacement": "The", "reason": "remove the duplicated article",
                           "approval_ref": prose["ch1"]}]}
    r = h.dispatch("F01", "CREATE", payload={"story_goal": "find the keeper", "stakes": "the last ferry",
                                             "arc_expectations": [], "manuscript_ref": prose["ch1"],
                                             "instruction": "developmental pass", "span_ids": []},
                   manual_candidate=review)
    assert r["status"] == "DRAFT", r
    f01 = r["output_refs"][0]
    assert h.approve(f01)["status"] == "APPROVED"
    merged = build_replacement(h.record(prose["ch1"]), [h.record(f01)])
    assert merged["text"] == CH1.replace("The the", "The", 1)
    assert merged["inverse"] == [{"start": start, "end": start + 3, "text": "The the"}]
    r = h.dispatch("C11", "CREATE", payload={"passage_id": prose["ch1"]["record_id"], "rewrite_goal": "apply F01",
                                             "instruction": "apply accepted patch", "passage_ref": prose["ch1"]},
                   manual_candidate={"text": merged["text"], "candidate_events": [], "findings": []})
    assert r["status"] == "DRAFT" and len(r["output_refs"]) == 2, r
    ch1_v2, new_bundle_ref = r["output_refs"]
    new_loc = h.record(new_bundle_ref)["data"]["events"][0]
    assert new_loc["event_id"] != loc_ev["event_id"] and new_loc["source_ref"] == ch1_v2
    assert errors_of(h.accept(ch1_v2))[0][0] == "APPROVAL_REQUIRED"  # replacing accepted prose
    assert h.accept(ch1_v2, k09_for(h, [prose["ch1"]]))["status"] == "BLOCKED"  # source approval != change
    assert h.accept(ch1_v2, k09_for(h, [ch1_v2]))["status"] == "APPROVED"
    assert h.record(prose["ch1"])["lifecycle"] == "SUPERSEDED"
    # old dependents are stale: event bundle, E heads that applied the old event, F proposal, assembly
    for ref in (bundles["ch1"]["ref"], e01_ref, e02_ref, f01, old_g02, old_g01):
        assert h.record(ref)["stale"] is True, ref["module_id"]
    assert h.record(bundles["ch2"]["ref"])["stale"] is False
    v = h.validate(old_g01)
    assert v["status"] == "DRAFT" and any(f["rule_id"] == "STALE" for f in v["findings"])
    redo = h.create("G01", {"ordered_manifest_ref": old_g02, "approved_chapter_refs": [prose["ch1"], prose["ch2"]],
                            "section_id_policy": "STABLE_ID"})
    assert redo["status"] in ("BLOCKED", "REJECTED"), redo
    chapters_final = [ch1_v2, prose["ch2"]]

    # E replays the superseded event from the stale heads (ch2 event kept)
    rp = e_create(h, "E02", "mara", "REPLAY", events=[new_loc], current_snapshot_ref=e02_ref,
                  superseded_event_ids=[loc_ev["event_id"]])
    assert rp["status"] == "DRAFT", rp
    accept_ok(h, rp["output_refs"][0])
    assert location_facts(rp["result"]["snapshot"]) == [("harbor", None, 100), ("lighthouse", 100, None)]
    rp1 = e_create(h, "E01", "mara", "REPLAY", events=[new_loc], current_snapshot_ref=e01_ref,
                   superseded_event_ids=[loc_ev["event_id"]])
    assert rp1["status"] == "DRAFT", rp1
    assert key_ev["event_id"] in rp1["result"]["accepted_event_ids"]
    accept_ok(h, rp1["output_refs"][0])

    # ------------------------------------------------------------------ 6. G02 -> G01 -> G05 -> G04 -> G07 -> G11
    ids = [c["record_id"] for c in chapters_final]
    g02, _ = ok(h, "G02", {"approved_chapter_refs": chapters_final, "ordered_chapter_ids": ids,
                           "manifest_revision": manifest_revision(h)})
    g01, _ = ok(h, "G01", {"ordered_manifest_ref": g02, "approved_chapter_refs": chapters_final,
                           "section_id_policy": "STABLE_ID"})
    g05, _ = ok(h, "G05", {"font_profile_ref": font, "language_tag": "en", "manuscript_ref": g01})
    g04, _ = ok(h, "G04", {"manuscript_ref": g01, "page_profile_ref": page, "typography_ref": g05,
                           "margins_pt": {"top": 54, "bottom": 54, "left": 54, "right": 54}})
    g07, _ = ok(h, "G07", {"paginated_book_ref": g04, "toc_style_ref": toc_style, "max_passes": 6})
    approvals = import_profile(h, "SOURCE_APPROVAL_MANIFEST", {"source_refs": chapters_final,
                                                               "approval_refs": chapters_final,
                                                               "policy_ref": pdf_profile})
    g11, _ = ok(h, "G11", {"final_book_ref": g07, "pdf_profile_ref": pdf_profile,
                             "approval_manifest_ref": approvals})
    for ref in (g02, g01, g05, g04, g07, g11):
        a = h.approve(ref)
        assert a["status"] == "APPROVED", (ref["module_id"], a["errors"], blocking(a))
    g11_rec = h.record(g11)
    pdf_rec = h.record(g11_rec["data"]["artifact_ref"])
    pdf = h.store.read_binary(pdf_rec)
    assert pdf_rec["binary"]["mime_type"] == "application/pdf" and origin(h, pdf_rec["ref"]) == "AUTHORITATIVE"
    assert g11_rec["data"]["sha256"] == hashlib.sha256(pdf).hexdigest()
    info = parse_pdf(pdf)
    assert info["count"] == info["kids"] >= 2
    assert inspect_pdf(pdf)["errors"] == []
    assert b"The lamp room" in pdf and b"The the" not in pdf  # the accepted F01 patch reached the export

    # ------------------------------------------------------------------ 7. frozen release manifest + QC reports
    k02, _ = ok(h, "K02", {"project_id": h.project_id, "phase": h.store.feature_manifest(h.project_id, "main")["phase"],
                           "feature_manifest": h.store.feature_manifest(h.project_id, "main"),
                           "completion_refs": [], "mode": "MANUAL"})
    sources, exports = [g01, g02, g07], [g11]
    authorization = k09_for(h, exports + sources)
    manifest = import_profile(h, "RELEASE_MANIFEST", {
        "feature_manifest_ref": k02, "source_refs": sources, "export_refs": exports, "profile_refs": [pdf_profile],
        "report_refs": [], "policy_ref": pdf_profile, "publication_authorization_ref": authorization})

    reports = {}
    reports["H05"], r = ok(h, "H05", {"manuscript_ref": g01, "chapter_manifest_ref": g02})
    assert r["result"]["status"] == "PASS", non_pass(r)
    reports["H07"], r = ok(h, "H07", {"export_ref": g11, "layout_profile_ref": pdf_profile})
    assert r["result"]["status"] == "PASS", non_pass(r)
    reports["H08"], r = ok(h, "H08", {"export_ref": g11, "toc_manifest_ref": g07})
    assert r["result"]["status"] == "PASS", non_pass(r)
    reports["H09"], r = ok(h, "H09", {"export_refs": [g11], "expected_manifest_ref": manifest})
    assert r["result"]["status"] == "PASS", non_pass(r)
    # Base-14 Times is referenced, not embedded: visible but nonblocking for a manuscript PDF.
    assert any(f["rule_id"] == "FONT_NOT_EMBEDDED" and f["severity"] == "MINOR" for f in r["result"]["findings"])
    # H03: the approved main plot selects no obligations -> explicit NOT_APPLICABLE evidence.
    reports["H03"], r = ok(h, "H03", {"manuscript_ref": g01, "plot_plan_ref": b03})
    assert r["result"]["status"] == "NOT_APPLICABLE", non_pass(r)
    # H02 (selected by the profile): approved canon snapshot, reviewed by a manual reviewer candidate.
    canon = h.create("I01", {"owner_operation": "A01", "source_ref": a01, "approval_ref": k09_for(h, [a01]),
                             "fact_type": "CHARACTER", "fact_payload": {"summary": "Mara Vell", "facts": [],
                                                                         "links": []},
                             "requested_state": "APPROVED"})
    assert canon["status"] == "DRAFT" and canon["result"]["approval_state"] == "APPROVED", canon
    canon_ref = canon["output_refs"][0]
    obligations = [f"FACT:mara:{p}" for p in ("entity.name", "entity.location_id", "entity.inventory_ids")]
    cand = h_manual("H02", [h_finding(o) for o in obligations], chapters_final, canon_ref)
    reports["H02"], r = ok(h, "H02", {"manuscript_ref": g01, "canon_snapshot_ref": canon_ref}, manual_candidate=cand)
    assert r["result"]["status"] == "PASS", non_pass(r)
    for op, ref in reports.items():
        a = h.approve(ref)
        assert a["status"] == "APPROVED", (op, a["errors"], blocking(a))

    r = h.create("H10", {"check_report_refs": list(reports.values()), "release_profile_ref": pdf_profile,
                         "release_manifest_ref": manifest})
    assert r["status"] == "DRAFT", r
    h10 = r["output_refs"][0]
    assert r["result"]["status"] == "READY", non_pass(r)
    rules = {f["rule_id"] for f in r["result"]["findings"]}
    assert {"PUBLICATION_AUTHORIZATION", "NOT_APPLICABLE_RULE:H04", "REPORT_OK:H09"} <= rules
    assert "FIXTURE_EVIDENCE" not in rules
    assert h.validate(h10)["status"] == "VALIDATED"
    # release ACCEPT: explicit K09 approval binding this exact H10 candidate
    assert errors_of(h.accept(h10))[0][0] == "APPROVAL_REQUIRED"
    wrong = h.accept(h10, k09_for(h, [g11]))
    assert wrong["status"] == "BLOCKED"
    rel = h.accept(h10, k09_for(h, [h10]))
    assert rel["status"] == "APPROVED", (rel["errors"], blocking(rel))
    assert h.record(h10)["lifecycle"] == "APPROVED"
    assert h.store.get_state(h.project_id, "main", "c_manuscript", "chapter:ch1")["ref"] == ch1_v2

    # ------------------------------------------------------------------ 8. one input changes after release
    up = h.dispatch("C02", "UPDATE", base_ref=prose["ch2"],
                    payload={"text": CH2_REVISED, "candidate_events": [], "findings": []})
    assert up["status"] == "DRAFT", up
    ch2_v2 = up["output_refs"][0]
    acc = h.accept(ch2_v2, k09_for(h, [ch2_v2]))
    assert acc["status"] == "APPROVED", (acc["errors"], blocking(acc))
    for ref in (g02, g01, g11, reports["H05"], reports["H09"], h10):
        assert h.record(ref)["stale"] is True, ref["module_id"]
    assert "C02:" + ch2_v2["record_id"] in h.record(h10)["stale_reason"]  # names the root change
    assert h.record(bundles["ch2"]["ref"])["stale"] is True and h.record(ch1_v2)["stale"] is False
    # revalidating the released H10 is refused (STALE blocks, the rerun no longer matches) and the
    # recheck never clears the stale flag
    v = h.validate(h10)
    assert v["status"] == "DRAFT" and {"STALE", "RERUN_MISMATCH"} <= {f["rule_id"] for f in v["findings"]}, v
    assert h.record(h10)["stale"] is True
    assert h.validate(reports["H09"])["status"] == "DRAFT" and h.record(reports["H09"])["stale"] is True
    # a fresh H10 over the old reports/manifest is BLOCKED and names the exact stale evidence
    again = h.create("H10", {"check_report_refs": list(reports.values()), "release_profile_ref": pdf_profile,
                             "release_manifest_ref": manifest})
    assert again["status"] == "DRAFT" and again["result"]["status"] == "BLOCKED"
    stale_reports = {f["message"].split(" ")[0] for f in again["result"]["findings"] if f["rule_id"] == "STALE_REPORT"}
    assert stale_reports == {"H02", "H03", "H05", "H07", "H08", "H09"}, stale_reports
    # and the old G01 can no longer feed an export
    blocked = h.create("G11", {"final_book_ref": g07, "pdf_profile_ref": pdf_profile, "approval_manifest_ref": approvals})
    assert blocked["status"] == "BLOCKED" and errors_of(blocked)[0][0] == "VERSION_CONFLICT", blocked
    # every record the slice produced is authoritative (no fixture inserts anywhere)
    origins = {r["evidence_origin"] for r in h.store.query("SELECT evidence_origin FROM records WHERE project_id=?",
                                                           (h.project_id,))}
    assert origins == {"AUTHORITATIVE"}, origins
