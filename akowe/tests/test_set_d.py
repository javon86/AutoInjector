"""Set D (Art / Visual) behaviour tests: Build Plan milestone 6 exit cases.

Covers: D-owned binary descriptors, deterministic D01/D09/D10 JSON bytes, manual image input
without an art provider, rights / protected appearance gates, empty scenes without creature or
weapon arrays, D08 reading order, D12 graph/sidecar with exact labels and geometry, provider
checkpoints and ambiguous paid retries, and text-only projects.
"""
from __future__ import annotations

import json
import unicodedata

import pytest

from akowe import d_assets as da
from akowe import d_maps
from akowe.canonical import sha256_bytes
from akowe.errors import AkoweError
from akowe.store import new_id

from conftest import errors_of

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR test image bytes supplied by the user"
PNG2 = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR second image supplied by the user"


# ---------------------------------------------------------------------------------- helpers
def fact(subject, predicate, value):
    return {"subject_id": subject, "predicate": predicate, "value": value, "assertion_type": "FACT",
            "effective_from": None, "effective_to": None, "source_refs": []}


def canon(h, op, concept, facts=(), flags=(), attributes=None):
    payload = {"concept": concept, "attributes": attributes or {}, "linked_refs": [],
               "protected_fact_flags": list(flags), "facts": list(facts)}
    ref, _ = h.create_approved(op, payload)
    return ref


def upload(h, data: bytes, mime="image/png"):
    """Same transaction shape as server.App.upload: an I01-owned IMPORT binary."""
    rid = f"I01-{new_id('import').split('-', 1)[1]}"
    with h.store.transaction() as tx:
        return tx.insert_binary_record(project_id=h.project_id, branch_id=h.branch_id, module_id="I01",
                                       record_id=rid, version=1, data=data, mime_type=mime, source_refs=[],
                                       principal_id=h.principal, record_kind="IMPORT")


def style(h, **extra):
    payload = {"style_name": "Ink wash", "style_rules": "Muted ink, visible paper grain",
               "publishing_format": "6x9 print interior", **extra}
    ref, r = h.create_approved("D01", payload)
    return ref


def manual(op_type, data=PNG, cleared=True, mime="image/png"):
    return {"asset_type": op_type, "storage_uri": "upload", "mime_type": mime, "file_hash": sha256_bytes(data),
            "rights": {"license": "author-owned", "source": "author illustration", "cleared": cleared},
            "findings": []}


def binary_of(h, data):
    parsed = da.parse_asset_uri(data["storage_uri"])
    assert parsed is not None
    rec = h.store.get_record(h.project_id, h.branch_id, parsed["record_id"], parsed["version"])
    return rec, h.store.read_binary(rec)


def mara(h, flags=("appearance.hair_color",)):
    return canon(h, "A01", "Mara, lighthouse keeper",
                 [fact("char-mara", "entity.name", "Mara"), fact("char-mara", "appearance.hair_color", "red")],
                 flags=flags, attributes={"appearance": "red hair, grey coat"})


def d02_manual(h, data=PNG, cleared=True, **kw):
    upload(h, data)
    st = kw.pop("style_ref", None) or style(h)
    a01 = kw.pop("canon_ref", None) or mara(h)
    return h.create("D02", {"character_id": "char-mara", "appearance_canon_ref": a01, "style_ref": st},
                    manual_candidate=manual("Character Appearance/Reference", data, cleared)), st, a01


def review_with_d10(h, asset_ref, reference_ref, *, disposition="PASS"):
    """Run D10, record the reviewer disposition by UPDATE and approve the report."""
    r = h.create("D10", {"asset_refs": [asset_ref], "reference_revision_refs": [reference_ref],
                         "tolerance_profile": {"color_delta_max": 0, "geometry_px_max": 0}})
    assert r["status"] == "DRAFT", r
    data = r["result"]
    reviewed = []
    for f in data["findings"]:
        if f["decision"] == "UNKNOWN":
            f = dict(f, decision=disposition, message=f["message"] + f" [reviewer: {disposition}]")
        reviewed.append(f)
    u = h.dispatch("D10", "UPDATE", base_ref=r["output_refs"][0], payload=dict(data, findings=reviewed))
    assert u["status"] == "DRAFT", u
    return u


# ---------------------------------------------------------------------------------- D01
def test_d01_style_json_bytes_bound_by_file_hash(h):
    r = h.create("D01", {"style_name": "Ink wash", "style_rules": "Muted ink", "publishing_format": "6x9",
                         "palette": "sepia, indigo"})
    assert r["status"] == "DRAFT", r
    desc_ref, bin_ref = r["output_refs"][0], r["output_refs"][1]
    data = r["result"]
    assert data["asset_type"] == "Visual Style Definition" and data["mime_type"] == "application/json"
    rec, blob = binary_of(h, data)
    assert rec["representation"] == "BINARY_ARTIFACT" and rec["module_id"] == "D01"
    assert rec["record_id"] == bin_ref["record_id"] != desc_ref["record_id"]  # never self-referential
    assert data["file_hash"] == sha256_bytes(blob) == rec["content_hash"]
    doc = json.loads(blob)
    assert {k: doc[k] for k in ("style_name", "style_rules", "publishing_format", "palette")} == {
        "style_name": "Ink wash", "style_rules": "Muted ink", "publishing_format": "6x9", "palette": "sepia, indigo"}
    # deterministic: same request content -> same bytes
    again = h.create("D01", {"style_name": "Ink wash", "style_rules": "Muted ink", "publishing_format": "6x9",
                             "palette": "sepia, indigo"})
    assert again["result"]["file_hash"] == data["file_hash"]
    assert h.approve(desc_ref)["status"] == "APPROVED"


def test_d01_refuses_manual_candidate_for_computed_bytes(h):
    r = h.create("D01", {"style_name": "a", "style_rules": "b", "publishing_format": "c"},
                 manual_candidate=manual("Visual Style Definition", mime="application/json"))
    assert ("INVALID_INPUT", "/manual_candidate") in errors_of(r)


# ---------------------------------------------------------------------------------- imagery without provider
def test_image_op_without_provider_holds_for_manual_input(h):
    st, a01 = style(h), mara(h)
    before = h.store.query_one("SELECT COUNT(*) c FROM records")["c"]
    r = h.create("D02", {"character_id": "char-mara", "appearance_canon_ref": a01, "style_ref": st})
    assert r["status"] == "BLOCKED"
    assert errors_of(r)[0] == ("CAPABILITY_UNAVAILABLE", "/payload")
    assert "D02:manual_image" in r["unresolved_requests"]
    assert h.store.query_one("SELECT COUNT(*) c FROM records")["c"] == before  # nothing invented


def test_manual_upload_is_copied_into_d_owned_binary(h):
    r, st, a01 = d02_manual(h)
    assert r["status"] == "DRAFT", r
    data = r["result"]
    rec, blob = binary_of(h, data)
    assert rec["module_id"] == "D02" and rec["owner"] == "D" and blob == PNG
    assert data["file_hash"] == sha256_bytes(PNG) and data["mime_type"] == "image/png"
    imports = [s for s in r["source_refs"] if s["module_id"] == "I01"]
    assert len(imports) == 1 and imports[0]["content_hash"] == sha256_bytes(PNG)
    assert any(f["rule_id"] == "PROVENANCE" for f in data["findings"])
    assert h.validate(r["output_refs"][0])["status"] == "VALIDATED"


def test_uploaded_image_pinned_in_input_refs(h):
    st, a01 = style(h), mara(h)
    imp = upload(h, PNG)
    r = h.create("D02", {"character_id": "char-mara", "appearance_canon_ref": a01, "style_ref": st},
                 input_refs=[imp])
    assert r["status"] == "DRAFT", r
    assert r["result"]["rights"]["cleared"] is False
    v = h.validate(r["output_refs"][0])
    assert v["status"] == "DRAFT" and any(f["rule_id"] == "RIGHTS" for f in v["findings"])


def test_manual_upload_rejections(h):
    st, a01 = style(h), mara(h)
    payload = {"character_id": "char-mara", "appearance_canon_ref": a01, "style_ref": st}
    r = h.create("D02", payload, manual_candidate=manual("Character Appearance/Reference", data=b"never uploaded"))
    assert errors_of(r)[0] == ("MISSING_INPUT", "/manual_candidate/file_hash")
    upload(h, b"plain text, not an image", mime="image/png")
    r = h.create("D02", payload, manual_candidate=manual("Character Appearance/Reference",
                                                          data=b"plain text, not an image"))
    assert r["status"] == "REJECTED" and errors_of(r)[0][0] == "INVALID_INPUT"
    upload(h, PNG)
    r = h.create("D02", payload, manual_candidate=manual("Character Appearance/Reference", mime="image/jpeg"))
    assert ("INVALID_INPUT", "/manual_candidate/mime_type") in errors_of(r)
    r = h.create("D02", dict(payload, character_id="char-unknown"),
                 manual_candidate=manual("Character Appearance/Reference"))
    assert ("INVALID_INPUT", "/payload/character_id") in errors_of(r)


def test_manual_create_idempotent_replay(h):
    st, a01 = style(h), mara(h)
    upload(h, PNG)
    req = h.request("D02", "CREATE", payload={"character_id": "char-mara", "appearance_canon_ref": a01,
                                              "style_ref": st}, idempotency_key="d02-key")
    cand = manual("Character Appearance/Reference")
    a = h.engine.dispatch(req, h.principal, manual_candidate=cand)
    n = h.store.query_one("SELECT COUNT(*) c FROM records WHERE module_id='D02'")["c"]
    b = h.engine.dispatch(req, h.principal, manual_candidate=cand)
    assert a["output_refs"] == b["output_refs"] and n == 2  # descriptor + binary, once
    assert h.store.query_one("SELECT COUNT(*) c FROM records WHERE module_id='D02'")["c"] == n


# ---------------------------------------------------------------------------------- rights / protected appearance
def test_visual_approval_needs_reviewer_evidence(h):
    r, st, a01 = d02_manual(h)
    ref = r["output_refs"][0]
    a = h.accept(ref)
    assert a["status"] == "BLOCKED" and any(f["rule_id"] == "VISUAL_REVIEW" for f in a["findings"])


def test_protected_hair_color_discrepancy_blocks_d02(h):
    r, st, a01 = d02_manual(h)
    ref = r["output_refs"][0]
    check = h.create("D10", {"asset_refs": [ref], "reference_revision_refs": [st],
                             "tolerance_profile": {"color_delta_max": 0, "geometry_px_max": 0}})
    prot = [f for f in check["result"]["findings"] if f["rule_id"] == "PROTECTED_APPEARANCE"]
    assert prot and prot[0]["decision"] == "UNKNOWN" and prot[0]["severity"] == "BLOCKING"
    assert "hair_color='red'" in prot[0]["message"]
    # D10 check bytes retain findings and source pins
    _, blob = binary_of(h, check["result"])
    assert json.loads(blob)["findings"] == check["result"]["findings"]
    blocked = h.accept(ref)
    assert blocked["status"] == "DRAFT" and any(f["rule_id"] == "VISUAL_CONSISTENCY" for f in blocked["findings"])
    # reviewer records the discrepancy: still blocked, and A canon is never edited
    data = check["result"]
    found = [dict(f, decision="FAIL", message="hair rendered blue; canon says red") if f["rule_id"] ==
             "PROTECTED_APPEARANCE" else f for f in data["findings"]]
    u = h.dispatch("D10", "UPDATE", base_ref=check["output_refs"][0], payload=dict(data, findings=found))
    assert u["status"] == "DRAFT", u
    _, blob2 = binary_of(h, u["result"])
    assert json.loads(blob2)["findings"] == found
    again = h.accept(ref)
    assert again["status"] == "DRAFT" and any("hair rendered blue" in f["message"] for f in again["findings"])
    assert h.record(a01)["lifecycle"] == "APPROVED" and h.record(a01)["version"] == 1


def test_reviewed_and_cleared_asset_approves(h):
    r, st, a01 = d02_manual(h)
    ref = r["output_refs"][0]
    u = review_with_d10(h, ref, st)
    assert h.approve(u["output_refs"][0])["status"] == "APPROVED"
    assert h.accept(ref)["status"] == "APPROVED"


def test_uncleared_rights_block_approval_even_with_review(h):
    r, st, a01 = d02_manual(h, cleared=False)
    ref = r["output_refs"][0]
    u = review_with_d10(h, ref, st)
    h.approve(u["output_refs"][0])
    a = h.accept(ref)
    assert a["status"] == "DRAFT" and any(f["rule_id"] == "RIGHTS" for f in a["findings"])


def test_ownership_update_cannot_point_at_foreign_bytes(h):
    r, st, a01 = d02_manual(h)
    style_rec = h.record(st)
    data = dict(r["result"], storage_uri=style_rec["data"]["storage_uri"], file_hash=style_rec["data"]["file_hash"],
                mime_type="application/json")
    u = h.dispatch("D02", "UPDATE", base_ref=r["output_refs"][0], payload=data)
    assert u["status"] == "REJECTED" and errors_of(u)[0] == ("INVALID_INPUT", "/payload/storage_uri")
    # replacing the image with a new upload copies it into a fresh D-owned binary
    upload(h, PNG2)
    u = h.dispatch("D02", "UPDATE", base_ref=r["output_refs"][0],
                   payload=dict(r["result"], file_hash=sha256_bytes(PNG2)))
    assert u["status"] == "DRAFT", u
    rec, blob = binary_of(h, u["result"])
    assert rec["module_id"] == "D02" and blob == PNG2
    # an A-owned record is not a permitted scene subject
    bad = h.create("D07", {"scene_description": "x", "style_ref": st, "character_asset_refs": [a01]})
    assert bad["status"] == "REJECTED" and errors_of(bad)[0][0] == "INVALID_INPUT"


# ---------------------------------------------------------------------------------- D07 scenes
def approved_location_art(h, st):
    a04 = canon(h, "A04", "The drowned lighthouse", [fact("loc-light", "entity.name", "Drowned Lighthouse")])
    upload(h, PNG2)
    r = h.create("D04", {"location_id": "loc-light", "location_canon_ref": a04, "style_ref": st},
                 manual_candidate=manual("Environment/Location Art", PNG2))
    assert r["status"] == "DRAFT", r
    ref = r["output_refs"][0]
    u = review_with_d10(h, ref, st)
    h.approve(u["output_refs"][0])
    assert h.accept(ref)["status"] == "APPROVED"
    return ref


def test_empty_scene_without_creature_or_weapon_arrays(h):
    st = style(h)
    loc = approved_location_art(h, st)
    img = PNG + b"scene"
    upload(h, img)
    r = h.create("D07", {"scene_description": "The empty lamp room at dawn", "style_ref": st,
                         "location_asset_ref": loc}, manual_candidate=manual("Scene Illustration", img))
    assert r["status"] == "DRAFT", r
    assert any(f["rule_id"] == "SUBJECTS" and f["decision"] == "PASS" for f in r["result"]["findings"])
    assert h.validate(r["output_refs"][0])["status"] == "VALIDATED"


def test_scene_subjects_need_approved_reference_interpretations(h):
    r, st, a01 = d02_manual(h)
    upload(h, PNG2)
    s = h.create("D07", {"scene_description": "Mara at the lamp", "style_ref": st,
                         "character_asset_refs": [r["output_refs"][0]]},
                 manual_candidate=manual("Scene Illustration", PNG2))
    assert s["status"] == "BLOCKED" and errors_of(s)[0] == ("APPROVAL_REQUIRED", "/payload/character_asset_refs/0")


def test_text_only_project_scheduler_skips_art_but_direct_request_runs(h):
    st = style(h)  # direct authorized request on an artwork=false project is an explicit asset request
    a02 = canon(h, "A02", "Gull-wyrm", [fact("c", "entity.name", "Gull-wyrm")])
    a11 = canon(h, "A11", "Harpoon", [fact("o", "entity.name", "Harpoon")])
    req = h.request("D05", "CREATE", payload={"creature_id": "c", "creature_canon_ref": a02, "style_ref": st})
    req["source_set"] = "K"  # dispatched by the scheduler, not requested by the user
    r = h.engine.dispatch(req, h.principal)
    assert r["status"] == "NOT_APPLICABLE" and r["selection_rule_id"] == "REQUIRED_OR_DIRECT_REQUEST:artwork"
    req = h.request("D06", "CREATE", payload={"object_id": "o", "object_canon_ref": a11, "style_ref": st})
    req["source_set"] = "K"
    assert h.engine.dispatch(req, h.principal)["status"] == "NOT_APPLICABLE"
    # text work stays usable with no art provider at all
    assert h.create("A01", {"concept": "Mara"})["status"] == "DRAFT"
    h.set_features(artwork=True)
    req = h.request("D05", "CREATE", payload={"creature_id": "c", "creature_canon_ref": a02, "style_ref": st})
    req["source_set"] = "K"
    assert h.engine.dispatch(req, h.principal)["status"] != "NOT_APPLICABLE"


# ---------------------------------------------------------------------------------- D08 / D09 / D11
def two_panels(h, st):
    out = []
    for img in (PNG + b"p1", PNG + b"p2"):
        upload(h, img)
        r = h.create("D02", {"character_id": "char-mara", "appearance_canon_ref": mara(h, flags=()),
                             "style_ref": st}, manual_candidate=manual("Character Appearance/Reference", img))
        ref = r["output_refs"][0]
        u = review_with_d10(h, ref, st)
        h.approve(u["output_refs"][0])
        assert h.accept(ref)["status"] == "APPROVED"
        out.append(ref)
    return out


def test_d08_reading_order_unique_and_complete(h):
    st = style(h)
    p1, p2 = two_panels(h, st)
    base = {"panel_brief": "Mara climbs", "page_dimensions": "170x260 mm", "style_ref": st, "asset_refs": [p1, p2]}
    for bad in ("1,1", "1", "1,2,3"):
        r = h.create("D08", dict(base, reading_order=bad))
        assert errors_of(r)[0] == ("INVALID_INPUT", "/payload/reading_order"), bad
    r = h.create("D08", dict(base, reading_order=f"2, {p1['record_id']}"))
    assert r["status"] == "DRAFT", r
    _, blob = binary_of(h, r["result"])
    plan = json.loads(blob)
    assert [p["asset_ref"]["record_id"] for p in plan["panels"]] == [p2["record_id"], p1["record_id"]]
    assert h.approve(r["output_refs"][0])["status"] == "APPROVED"


def test_d09_composition_fits_positive_canvas(h):
    st = style(h)
    r = h.create("D09", {"composition_brief": "Wide establishing shot", "canvas_dimensions": "3000x2000 px",
                         "style_ref": st, "asset_refs": [st], "focal_point": "upper-left"})
    assert r["status"] == "DRAFT", r
    _, blob = binary_of(h, r["result"])
    doc = json.loads(blob)
    assert doc["canvas"] == {"width": 3000, "height": 2000, "unit": "px"}
    assert doc["placements"][0]["box"] == {"x": 0.0, "y": 0, "width": 3000.0, "height": 2000}
    assert h.validate(r["output_refs"][0])["status"] == "VALIDATED"
    bad = h.create("D09", {"composition_brief": "x", "canvas_dimensions": "0x10 px", "style_ref": st})
    assert errors_of(bad)[0] == ("INVALID_INPUT", "/payload/canvas_dimensions")
    bad = h.create("D09", {"composition_brief": "x", "canvas_dimensions": "100x10", "style_ref": st})
    assert errors_of(bad)[0] == ("INVALID_INPUT", "/payload/canvas_dimensions")


def test_d11_cover_artwork_does_not_claim_spine(h):
    st = style(h)
    upload(h, PNG2)
    r = h.create("D11", {"title": "The Drowned Light", "trim_dimensions": "6x9 in", "style_ref": st,
                         "cover_brief": "Lighthouse in storm"}, manual_candidate=manual("Cover Artwork", PNG2))
    assert r["status"] == "DRAFT", r
    assert any(f["rule_id"] == "NO_SPINE_GEOMETRY" for f in r["result"]["findings"])


# ---------------------------------------------------------------------------------- D12 maps
def map_canon(h, cafe="Café"):
    return canon(h, "A04", "The coast", [
        fact("loc-light", "entity.name", "Drowned Lighthouse"), fact("loc-light", "x.map.x", 10),
        fact("loc-light", "x.map.y", 20.5), fact("loc-light", "x.map.connects_to", ["loc-cafe"]),
        fact("loc-cafe", "entity.name", cafe), fact("loc-cafe", "x.map.x", -4), fact("loc-cafe", "x.map.y", 3),
        fact("loc-cafe", "x.map.unit", "mm")])


def test_d12_graph_sidecar_and_exact_labels(h):
    a04 = map_canon(h)
    r = h.create("D12", {"map_requirements": "Coast map", "geometry_source_ref": a04, "canonical_label_refs": [],
                         "legend": "dots are places"})
    assert r["status"] == "DRAFT", r
    data = r["result"]
    g, s = h.record(data["source_graph_ref"]), h.record(data["sidecar_ref"])
    assert (g["module_id"], g["record_kind"], s["module_id"], s["record_kind"]) == ("D12", "MapGraph", "D12",
                                                                                     "MapSidecar")
    assert g["record_id"] != s["record_id"] != r["output_refs"][0]["record_id"]
    assert g["data"]["unit"] == "mm" and g["data"]["geometry_tolerance"] == 0
    assert {n["id"]: (n["x"], n["y"], n["label"]) for n in g["data"]["nodes"]} == {
        "loc-light": (10, 20.5, "Drowned Lighthouse"), "loc-cafe": (-4, 3, "Café")}
    assert g["data"]["edges"] == [{"id": "loc-light->loc-cafe", "from": "loc-light", "to": "loc-cafe"}]
    rec, svg = binary_of(h, data)
    assert data["mime_type"] == "image/svg+xml" and rec["module_id"] == "D12"
    assert s["data"]["file_hash"] == sha256_bytes(svg) == data["file_hash"]
    assert s["data"]["graph_ref"] == data["source_graph_ref"]
    assert sorted((lab["node_id"], lab["rendered_text"], lab["x"], lab["y"]) for lab in s["data"]["labels"]) == [
        ("loc-cafe", "Café", -4, 3), ("loc-light", "Drowned Lighthouse", 10, 20.5)]
    # deterministic rendering
    again = h.create("D12", {"map_requirements": "Coast map", "geometry_source_ref": a04, "canonical_label_refs": [],
                             "legend": "dots are places"})
    assert again["result"]["file_hash"] == data["file_hash"]
    assert h.approve(r["output_refs"][0])["status"] == "APPROVED"


def test_d12_wrong_label_fails_exact_comparison(h):
    a04 = map_canon(h)
    first = h.create("D12", {"map_requirements": "Coast map", "geometry_source_ref": a04, "canonical_label_refs": []})
    labels = canon(h, "A15", "Place names", [fact("loc-light", "entity.name", "Drowned Light-house")])
    r = h.create("D12", {"map_requirements": "Coast map", "geometry_source_ref": first["result"]["source_graph_ref"],
                         "canonical_label_refs": [labels]})
    assert r["status"] == "DRAFT"  # attractive map is stored as a candidate ...
    bad = [f for f in r["result"]["findings"] if f["rule_id"] == "CANONICAL_LABEL"]
    assert bad and bad[0]["decision"] == "FAIL" and bad[0]["severity"] == "BLOCKING"
    a = h.accept(r["output_refs"][0])  # ... but cannot be approved
    assert a["status"] == "DRAFT" and any(f["rule_id"] == "CANONICAL_LABEL" for f in a["findings"])


def test_d12_requires_approved_a04_coordinates_and_labels(h):
    r = h.create("A04", {"concept": "draft coast", "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
                         "facts": [fact("x", "x.map.x", 1), fact("x", "x.map.y", 1), fact("x", "entity.name", "X")]})
    d = h.create("D12", {"map_requirements": "m", "geometry_source_ref": r["output_refs"][0],
                         "canonical_label_refs": []})
    assert errors_of(d)[0] == ("APPROVAL_REQUIRED", "/payload/geometry_source_ref")
    nolabel = canon(h, "A04", "unnamed", [fact("x", "x.map.x", 1), fact("x", "x.map.y", 1)])
    d = h.create("D12", {"map_requirements": "m", "geometry_source_ref": nolabel, "canonical_label_refs": []})
    assert d["status"] == "REJECTED" and "no canonical entity.name label" in d["errors"][0]["message"]


def test_map_compare_exact_geometry_labels_and_raster_only():
    ref = {"project_id": "p", "branch_id": "main", "owner": "A", "module_id": "A04", "record_id": "a",
           "version": 1, "content_hash": "0" * 64}
    graph = {"coordinate_system": "cartesian", "unit": "px", "geometry_tolerance": 0, "edges": [],
             "nodes": [{"id": "n1", "x": 1.5, "y": 2, "label": "Café", "canon_ref": ref}]}
    svg = d_maps.render_svg(graph, title="t")
    side = d_maps.build_sidecar(ref, svg)
    nfd = {"n1": unicodedata.normalize("NFD", "Café")}
    assert all(ok for _, ok, _ in d_maps.compare(graph, side, svg, nfd))  # NFC for comparison only
    moved = dict(side, labels=[dict(side["labels"][0], x=1.6)])
    res = d_maps.compare(graph, moved, svg, {})
    assert ("GEOMETRY", False) in [(r, ok) for r, ok, _ in res]
    assert ("SIDECAR_MATCHES_FILE", False) in [(r, ok) for r, ok, _ in res]
    assert any(r == "GEOMETRY" and ok for r, ok, _ in d_maps.compare(graph, moved, None, {}, tolerance=0.2))
    raster = d_maps.compare(graph, side, None, {})
    assert ("VECTOR_TEXT_LAYER", False) in [(r, ok) for r, ok, _ in raster]
    wrong = dict(graph, nodes=[dict(graph["nodes"][0], label="Cafe")])
    assert ("CANONICAL_LABEL", False) in [(r, ok) for r, ok, _ in d_maps.compare(wrong, side, svg, nfd)]
    dup = dict(graph, edges=[{"id": "e", "from": "n1", "to": "zz"}])
    assert d_maps.graph_problems(dup) == ["edge e endpoint does not exist"]


# ---------------------------------------------------------------------------------- provider checkpoints
class FakeImageAdapter:
    def __init__(self, *, timeout_first=False, running_first=False, with_status=True):
        self.timeout_first, self.running_first = timeout_first, running_first
        self.submits, self.status_calls = 0, 0
        if not with_status:
            self.image_status = None
            del self.image_status

    def capabilities(self):
        return ["image"]

    def submit_image(self, slot, request):
        self.submits += 1
        assert request["protected_facts"] and request["style"]["style_name"] == "Ink wash"
        if self.timeout_first and self.submits == 1:
            raise AkoweError("TIMEOUT", "", "provider timed out")
        if self.running_first and self.submits == 1:
            return {"status": "RUNNING", "provider_job_id": "job-1"}
        return {"status": "COMPLETED", "provider_job_id": f"job-{self.submits}", "image_bytes": PNG,
                "mime_type": "image/png", "license": "provider ToS v3"}

    def image_status(self, slot, job_id):
        self.status_calls += 1
        return {"status": "COMPLETED", "provider_job_id": job_id, "image_bytes": PNG, "mime_type": "image/png"}


def image_slot(h, adapter):
    h.engine.providers.configure_slot("AI-2", {"adapter_id": "anthropic", "capabilities": ["image"]})
    h.engine.providers.test_adapter = adapter


def d02_request(h, key):
    st, a01 = style(h), mara(h)
    return h.request("D02", "CREATE", payload={"character_id": "char-mara", "appearance_canon_ref": a01,
                                               "style_ref": st}, idempotency_key=key)


def test_ambiguous_paid_retry_without_status_blocks_for_user_decision(h):
    fake = FakeImageAdapter(timeout_first=True, with_status=False)
    image_slot(h, fake)
    req = d02_request(h, "gen-1")
    r1 = h.engine.dispatch(req, h.principal)
    assert r1["status"] == "BLOCKED" and errors_of(r1)[0][0] == "TIMEOUT"
    r2 = h.engine.dispatch(dict(req, request_id="req-retry"), h.principal)
    assert r2["status"] == "BLOCKED" and fake.submits == 1  # never pays twice silently
    assert "user_decision:D02:retry_ambiguous_generation" in r2["unresolved_requests"]
    # the user's explicit decision: a new logical request (new key) may pay for a new attempt
    r3 = h.engine.dispatch(dict(req, idempotency_key="gen-2", request_id="req-new"), h.principal)
    assert r3["status"] == "DRAFT" and fake.submits == 2, r3
    assert r3["result"]["rights"]["cleared"] is False
    rec, blob = binary_of(h, r3["result"])
    assert blob == PNG and rec["module_id"] == "D02"


def test_provider_job_resumes_through_status_without_duplicate_charge(h):
    fake = FakeImageAdapter(running_first=True)
    image_slot(h, fake)
    req = d02_request(h, "gen-run")
    r1 = h.engine.dispatch(req, h.principal)
    assert r1["status"] == "PARTIAL" and "provider_job:job-1" in r1["unresolved_requests"]
    cp = h.store.get_state(h.project_id, h.branch_id, "d_provider_jobs", "D02:gen-run")
    assert cp["provider_job_id"] == "job-1" and cp["status"] == "SUBMITTED"
    r2 = h.engine.dispatch(dict(req, request_id="req-resume"), h.principal)
    assert r2["status"] == "DRAFT" and fake.submits == 1 and fake.status_calls == 1
    prov = h.store.query_one("SELECT * FROM provenance WHERE record_id=?", (r2["output_refs"][0]["record_id"],))
    assert prov is not None and "job-1" in prov["resource"] and prov["transform"] == "AI"
    r3 = h.engine.dispatch(dict(req, request_id="req-dup"), h.principal)  # duplicate delivery
    assert r3["output_refs"] == r2["output_refs"] and fake.submits == 1


def test_resource_ids_helper():
    assert da.parse_dimensions("6 x 9 in", "/p") == {"width": 6, "height": 9, "unit": "in"}
    with pytest.raises(AkoweError):
        da.parse_dimensions("6x9", "/p")
    ref = {"project_id": "p", "branch_id": "main", "owner": "D", "module_id": "D02", "record_id": "D02-ab",
           "version": 3, "content_hash": "a" * 64}
    assert da.parse_asset_uri(da.asset_uri(ref)) == {"project": "p", "branch": "main", "sha": "a" * 64,
                                                      "record_id": "D02-ab", "version": 3}
    assert da.sniff_mime(b"<svg xmlns='x'><script>alert(1)</script></svg>") is None


def test_d03_pose_preserves_reference_identity(h):
    r, st, a01 = d02_manual(h)
    ref = r["output_refs"][0]
    u = review_with_d10(h, ref, st)
    h.approve(u["output_refs"][0])
    assert h.accept(ref)["status"] == "APPROVED"
    upload(h, PNG2)
    wrong = h.create("D03", {"character_id": "char-other", "character_reference_ref": ref, "scene_brief": "waves"},
                     manual_candidate=manual("Character Pose/Expression", PNG2))
    assert errors_of(wrong)[0] == ("INVALID_INPUT", "/payload/character_id")
    ok = h.create("D03", {"character_id": "char-mara", "character_reference_ref": ref, "scene_brief": "waves",
                          "pose": "waving"}, manual_candidate=manual("Character Pose/Expression", PNG2))
    assert ok["status"] == "DRAFT", ok
    assert any(s["record_id"] == a01["record_id"] for s in ok["source_refs"])  # canon pin carried for D10
    check = h.create("D10", {"asset_refs": [ok["output_refs"][0]], "reference_revision_refs": [ref],
                             "tolerance_profile": {"color_delta_max": 2, "geometry_px_max": 1}})
    rules = {f["rule_id"] for f in check["result"]["findings"]}
    assert {"PROTECTED_APPEARANCE", "VISUAL_TOLERANCE"} <= rules and "REFERENCE_PIN" not in rules
