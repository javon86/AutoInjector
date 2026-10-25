"""Set F (editing refinement): anchored findings/patch proposals, never manuscripts."""
from __future__ import annotations

from bookforge.canonical import sha256_text
from bookforge.spans import build_replacement, make_span, reanchor
from bookforge.errors import BookforgeError
from conftest import errors_of
from fj_fixtures import canon, fact, k09, prose, rec, seed, use_ai

TEXT = "Mira walked to the the gate.  She waited by the old oak tree. The night was cold ."


def f09(h, ms, names_ref, **extra):
    payload = {"language_tag": "en", "protected_names_ref": names_ref, "confidence_floor": 0.7,
               "manuscript_ref": ms, "instruction": "check grammar", "span_ids": []}
    payload.update(extra)
    return h.create("F09", payload)


def a15(h, names):
    return canon(h, "A15", [fact(f"n{i}", "entity.name", n) for i, n in enumerate(names)], concept="names")


# ------------------------------------------------------------------------------ F09 deterministic
def test_f09_deterministic_patches_anchor_exact_spans(h):
    ms = prose(h, TEXT)
    r = f09(h, ms, a15(h, ["Mira"]))
    assert r["status"] == "DRAFT", r
    data = r["result"]
    assert data["kind"] == "grammar_findings"
    rules = sorted(f["rule_id"] for f in data["findings"])
    assert rules == ["DOUBLE_SPACE", "REPEATED_WORD", "SPACE_BEFORE_PUNCT"]
    # every patch anchored to one evidence span whose hash matches the exact substring
    spans = {e["span_id"]: e for f in data["findings"] for e in f["evidence"]}
    for p in data["patches"]:
        ev = spans[p["patch_id"]]
        assert p["path"] == "/text" and p["target_ref"] == ms
        assert ev["text_hash"] == sha256_text(TEXT[ev["start"]:ev["end"]])
        assert p["approval_ref"] == ms  # approved base pin is the authority
    # deterministic: identical inputs give identical findings content
    r2 = f09(h, ms, a15(h, ["Mira"]))
    strip = lambda d: [(f["rule_id"], f["evidence"][0]["start"], f["evidence"][0]["end"]) for f in d["findings"]]
    assert strip(r2["result"]) == strip(data)
    out = build_replacement(rec(h, ms), [rec(h, r["output_refs"][0])])
    assert out["text"] == "Mira walked to the gate. She waited by the old oak tree. The night was cold."
    v = h.validate(r["output_refs"][0])
    assert v["status"] == "VALIDATED", v["findings"]


def test_f09_protected_names_never_corrected_and_confidence_floor(h):
    ms = prose(h, "Bora Bora rose. He had had enough.")
    r = f09(h, ms, a15(h, ["Bora"]), confidence_floor=0.6)
    data = r["result"]
    by_rule = {f["rule_id"]: f for f in data["findings"]}
    assert by_rule["PROTECTED_NAME"]["decision"] == "UNKNOWN"
    assert by_rule["REPEATED_WORD"]["decision"] == "UNKNOWN"  # 'had had' 0.5 < floor 0.6
    assert data["patches"] == []


def test_f_patches_withheld_without_authority(h):
    ms = prose(h, "a  b", lifecycle="DRAFT")
    r = f09(h, ms, a15(h, []))
    assert r["result"]["patches"] == []
    assert any(f["rule_id"] == "PATCHES_WITHHELD" for f in r["result"]["findings"])
    # explicit K09 approval in input_refs authorizes proposals; expired one is rejected
    good = k09(h, [ms])
    r2 = h.create("F09", {
        "language_tag": "en", "protected_names_ref": a15(h, []), "confidence_floor": 0.5, "manuscript_ref": ms,
        "instruction": "x", "span_ids": []}, input_refs=[good])
    assert r2["result"]["patches"][0]["approval_ref"] == good
    old = k09(h, [ms], expires_in=-10)
    r3 = h.create("F09", {"language_tag": "en", "protected_names_ref": a15(h, []), "confidence_floor": 0.5,
                          "manuscript_ref": ms, "instruction": "x", "span_ids": []}, input_refs=[old])
    assert errors_of(r3)[0][0] == "EXPIRED_APPROVAL"


def test_f_manual_candidate_rejects_bad_anchor_and_overlap(h):
    ms = prose(h, TEXT)
    names = a15(h, [])
    m = rec(h, ms)
    s1 = make_span(m, 15, 22)
    s2 = make_span(m, 19, 26)
    base = {"language_tag": "en", "protected_names_ref": names, "confidence_floor": 0.5, "manuscript_ref": ms,
            "instruction": "x", "span_ids": []}

    def cand(spans, patches):
        return {"kind": "grammar_findings",
                "findings": [{"id": f"f{i}", "rule_id": "R", "severity": "MINOR", "decision": "FAIL",
                              "message": "m", "evidence": [s], "source_refs": [], "confidence": 1.0}
                             for i, s in enumerate(spans)],
                "patches": [{"patch_id": sid, "target_ref": ms, "path": "/text", "replacement": "x",
                             "reason": "r", "approval_ref": ms} for sid in patches]}

    r = h.create("F09", base, manual_candidate=cand([s1, s2], [s1["span_id"], s2["span_id"]]))
    assert errors_of(r)[0][0] == "PATCH_OVERLAP"
    bad = dict(s1, text_hash="0" * 64)
    r = h.create("F09", base, manual_candidate=cand([bad], [bad["span_id"]]))
    assert errors_of(r)[0][0] == "HASH_MISMATCH"
    r = h.create("F09", base, manual_candidate=cand([s1], ["no-such-span"]))
    assert errors_of(r)[0][0] == "SPAN_CONFLICT"
    ok = h.create("F09", base, manual_candidate=cand([s1], [s1["span_id"]]))
    assert ok["status"] == "DRAFT", ok


def test_f_stale_manuscript_version_conflict_and_reanchor(h):
    ms1 = prose(h, "One two  three. Four five.")
    r = f09(h, ms1, a15(h, []))
    fref = r["output_refs"][0]
    ms2 = prose(h, "Zero. One two  three. Four five.", record=rec(h, ms1))
    # creating against the superseded pin is a VERSION_CONFLICT
    assert errors_of(f09(h, ms1, a15(h, [])))[0][0] == "VERSION_CONFLICT"
    v = h.validate(fref)
    codes = {f["rule_id"] for f in v["findings"] if f["severity"] == "BLOCKING"}
    assert "VERSION_CONFLICT" in codes and v["status"] == "DRAFT"
    assert any("re-located" in f["message"] for f in v["findings"])
    # ambiguous re-anchor -> SPAN_CONFLICT
    m1 = rec(h, ms1)
    span = make_span(m1, 7, 9)  # the double space
    try:
        reanchor(m1["data"]["text"], "a  b  c", span)
        raise AssertionError("expected SPAN_CONFLICT")
    except BookforgeError as exc:
        assert exc.code == "SPAN_CONFLICT"
    assert ms2["version"] == 2


def test_f_concurrent_overlapping_edits_patch_overlap(h):
    ms = prose(h, "The door  opened slowly.")
    names = a15(h, [])
    a = f09(h, ms, names)["output_refs"][0]
    m = rec(h, ms)
    s = make_span(m, 4, 16)  # "door  opened" overlaps the double-space patch
    other = {"kind": "grammar_findings",
             "findings": [{"id": "x", "rule_id": "R", "severity": "MINOR", "decision": "FAIL", "message": "m",
                           "evidence": [s], "source_refs": [], "confidence": 1.0}],
             "patches": [{"patch_id": s["span_id"], "target_ref": ms, "path": "/text", "replacement": "gate swung",
                          "reason": "r", "approval_ref": ms}]}
    b = h.create("F09", {"language_tag": "en", "protected_names_ref": names, "confidence_floor": 0.5,
                         "manuscript_ref": ms, "instruction": "x", "span_ids": []},
                 manual_candidate=other)["output_refs"][0]
    assert h.approve(a)["status"] == "APPROVED"
    h.validate(b)
    rb = h.accept(b)
    assert rb["status"] == "BLOCKED"
    assert any(f["rule_id"] == "PATCH_OVERLAP" for f in rb["findings"])
    # C-side merge also refuses to choose the last writer
    try:
        build_replacement(rec(h, ms), [rec(h, a), rec(h, b)])
        raise AssertionError("expected PATCH_OVERLAP")
    except BookforgeError as exc:
        assert exc.code == "PATCH_OVERLAP"


def test_f_accepted_edit_through_c_invalidates_only_readers(h):
    ms = prose(h, "Rain  fell.")
    other = prose(h, "Unrelated chapter.")
    other_hash = rec(h, other)["content_hash"]
    names = a15(h, [])
    fref = f09(h, ms, names)["output_refs"][0]
    reader = h.create("F07", {"exact_min_occurrences": 2, "similarity_threshold": 0.9, "comparison_scope": "chapter",
                              "excluded_terms": [], "manuscript_ref": other, "instruction": "x",
                              "span_ids": []})["output_refs"][0]
    assert h.approve(fref)["status"] == "APPROVED"
    merged = build_replacement(rec(h, ms), [rec(h, fref)])
    # C owner submits the replacement candidate and accepts it
    up = h.dispatch("C07", "UPDATE", base_ref=ms, payload={"text": merged["text"], "candidate_events": [],
                                                            "findings": []})
    assert up["status"] == "DRAFT", up
    acc = h.approve(up["output_refs"][0])
    assert acc["status"] == "APPROVED", acc
    assert rec(h, fref)["stale"] is True  # F proposal read the changed manuscript
    assert rec(h, reader)["stale"] is False  # unrelated chapter reader untouched
    assert rec(h, other)["content_hash"] == other_hash
    assert merged["inverse"] == [{"start": 4, "end": 5, "text": "  "}]


# ------------------------------------------------------------------------------ F07 / F03 / F02 logic
def test_f07_repetition_exact_near_and_excluded(h):
    text = ("The wind was cold and grey. The wind was cold and grey. Kell ran far away now. "
            "Kell ran far away now. The wind was cold and gray.")
    ms = prose(h, text)
    payload = {"exact_min_occurrences": 2, "similarity_threshold": 0.6, "comparison_scope": "chapter",
               "excluded_terms": ["Kell"], "manuscript_ref": ms, "instruction": "x", "span_ids": []}
    d = h.create("F07", payload)["result"]
    exact = [f for f in d["findings"] if f["rule_id"] == "EXACT_SENTENCE"]
    assert len(exact) == 2  # 'kell' excluded from comparison text, but the rest still repeats
    assert all(len(f["evidence"]) == 2 for f in exact)
    near = [f for f in d["findings"] if f["rule_id"] == "NEAR_REPEAT"]
    assert near and all(f["decision"] == "UNKNOWN" for f in near)
    assert d["patches"] == []
    again = h.create("F07", payload)["result"]
    assert [(f["rule_id"], f["message"]) for f in again["findings"]] == [(f["rule_id"], f["message"])
                                                                          for f in d["findings"]]
    # exact_min_occurrences=3 suppresses pairs
    d3 = h.create("F07", dict(payload, exact_min_occurrences=3))["result"]
    assert not [f for f in d3["findings"] if f["rule_id"] == "EXACT_SENTENCE"]


def test_f07_jaccard_edges_and_book_scope(h):
    from bookforge.modules.set_f import jaccard
    assert jaccard(set(), set()) == 1.0 and jaccard({"a"}, set()) == 0.0
    a = prose(h, "Silver rain falls on the quiet harbor tonight.")
    b = prose(h, "Silver rain falls on the quiet harbor tonight.")
    payload = {"exact_min_occurrences": 2, "similarity_threshold": 0.95, "comparison_scope": "book",
               "excluded_terms": [], "manuscript_ref": a, "instruction": "x", "span_ids": []}
    d = h.create("F07", payload, input_refs=[b])["result"]
    ev = [f for f in d["findings"] if f["rule_id"] == "EXACT_SENTENCE"][0]["evidence"]
    assert {e["record_ref"]["record_id"] for e in ev} == {a["record_id"], b["record_id"]}
    d2 = h.create("F07", dict(payload, comparison_scope="chapter"), input_refs=[b])["result"]
    assert not [f for f in d2["findings"] if f["rule_id"] == "EXACT_SENTENCE"]


def test_f03_pacing_from_scene_lengths(h):
    ms = prose(h, "one two three\n***\nfour five\n***\nsix")
    d = h.create("F03", {"scene_lengths": [3, 2, 9], "pacing_targets": "min=2, max=8; brisk",
                         "manuscript_ref": ms, "instruction": "x", "span_ids": []})["result"]
    rules = [f["rule_id"] for f in d["findings"]]
    assert "DECLARED_LENGTH" in rules and "ABOVE_TARGET" in rules and "QUALITATIVE_TARGET" in rules
    above = [f for f in d["findings"] if f["rule_id"] == "ABOVE_TARGET"][0]
    assert above["evidence"][0]["start"] == 32  # "six"


def test_f02_structure_against_beat_map(h):
    ms = prose(h, "Chapter text.")
    beat = seed(h, "B11", {"chapters": [{"summary": "plan", "facts": [
        fact("ch1", "plan.order", 0, kind="PLAN"), fact("ch2", "plan.order", 1, kind="PLAN"),
        fact("ch3", "plan.order", 2, kind="PLAN")], "links": []}], "unresolved_threads": []})
    d = h.create("F02", {"beat_map_ref": beat, "chapter_order": ["ch2", "ch1"], "manuscript_ref": ms,
                         "instruction": "x", "span_ids": []})["result"]
    rules = [f["rule_id"] for f in d["findings"]]
    assert "MISSING_STRUCTURAL_FUNCTION" in rules and rules.count("MISPLACED_CHAPTER") == 2
    ok = h.create("F02", {"beat_map_ref": beat, "chapter_order": ["ch1", "ch2", "ch3"], "manuscript_ref": ms,
                          "instruction": "x", "span_ids": []})["result"]
    assert [f["rule_id"] for f in ok["findings"]] == ["STRUCTURE_ORDER"]
    d2 = h.create("F02", {"chapter_order": ["ch1", "ch1"], "manuscript_ref": ms, "instruction": "x",
                          "span_ids": []})["result"]
    assert {f["rule_id"] for f in d2["findings"]} >= {"DUPLICATE_CHAPTER", "NO_BEAT_MAP"}


# ------------------------------------------------------------------------------ AI ops
def test_f11_ai_line_edit_anchors_quotes_and_protects_facts(h):
    ms = prose(h, "Captain Vael drew the blade slowly. It was a very very old blade.")
    prot = canon(h, "A01", [fact("vael", "entity.name", "Captain Vael")])
    voice = canon(h, "A01", [], concept="voice")
    use_ai(h, {"F11": {"items": [
        {"quote": "a very very old", "rule_id": "WORDINESS", "severity": "MINOR", "message": "tighten",
         "confidence": 0.8, "replacement": "an ancient"},
        {"quote": "Captain Vael drew", "rule_id": "VOICE", "severity": "MINOR", "message": "rename",
         "confidence": 0.6, "replacement": "Vael drew"},
        {"quote": "blade", "rule_id": "REPEAT", "severity": "INFO", "message": "ambiguous quote",
         "confidence": 0.5, "replacement": "sword"},
        {"quote": None, "rule_id": "OVERALL", "severity": "INFO", "message": "solid", "confidence": None,
         "replacement": None}]}})
    r = h.create("F11", {"voice_profile_ref": voice, "protected_facts_ref": prot, "meaning_preservation": True,
                         "manuscript_ref": ms, "instruction": "line edit", "span_ids": []})
    assert r["status"] == "DRAFT", r
    d = r["result"]
    assert len(d["patches"]) == 1 and d["patches"][0]["replacement"] == "an ancient"
    rules = {f["rule_id"]: f for f in d["findings"]}
    assert rules["PROTECTED_FACT_CHANGE"]["decision"] == "UNKNOWN"
    assert "ambiguous" in rules["REPEAT"]["message"] and rules["REPEAT"]["evidence"] == []
    assert h.validate(r["output_refs"][0])["status"] == "VALIDATED"


def test_f_ai_unavailable_blocks_with_manual_route(h):
    ms = prose(h, "Text.")
    r = h.create("F01", {"story_goal": "g", "stakes": "s", "arc_expectations": [], "manuscript_ref": ms,
                         "instruction": "review", "span_ids": []})
    assert r["status"] == "BLOCKED" and errors_of(r)[0][0] == "CAPABILITY_UNAVAILABLE"
    assert r["unresolved_requests"] == ["F01:manual_candidate"]
    m = h.create("F01", {"story_goal": "g", "stakes": "s", "arc_expectations": [], "manuscript_ref": ms,
                         "instruction": "review", "span_ids": []},
                 manual_candidate={"kind": "narrative_findings", "findings": [], "patches": []})
    assert m["status"] == "DRAFT"


def test_f10_neighbor_rules(h):
    ms = prose(h, "Text.")
    nxt = prose(h, "Next.")
    r = h.create("F10", {"chapter_position": "only", "next_chapter_ref": nxt, "manuscript_ref": ms,
                         "instruction": "x", "span_ids": []})
    assert errors_of(r)[0] == ("INVALID_INPUT", "/payload/next_chapter_ref")


def test_f12_polish_preview_without_approval_and_gates(h):
    base = prose(h, "Draft text.", module_id="C07")
    ms = seed(h, "C11", {"text": "The end  came.", "candidate_events": [], "findings": []}, source_refs=[base])
    lock = canon(h, "A01", [fact("x", "entity.name", "Ilo")], lifecycle="LOCKED")
    clean = seed(h, "F07", {"kind": "repetition_findings", "findings": [], "patches": []})
    use_ai(h, {"F12": {"items": [{"quote": "end  came", "rule_id": "POLISH", "severity": "MINOR",
                                  "message": "spacing", "confidence": 0.9, "replacement": "end came"}]}})
    payload = {"approved_manuscript_ref": ms, "unresolved_blockers": clean, "locked_canon_ref": lock,
               "manuscript_ref": ms, "instruction": "final polish", "span_ids": []}
    r = h.create("F12", payload)
    assert r["status"] == "DRAFT", r
    assert r["result"]["patches"][0]["approval_ref"] == ms
    blocked = seed(h, "F07", {"kind": "repetition_findings", "findings": [
        {"id": "b", "rule_id": "X", "severity": "BLOCKING", "decision": "FAIL", "message": "open",
         "evidence": [], "source_refs": [], "confidence": None}], "patches": []})
    r2 = h.create("F12", dict(payload, unresolved_blockers=blocked))
    assert r2["status"] == "BLOCKED" and errors_of(r2)[0][0] == "APPROVAL_REQUIRED"
    expired = k09(h, [ms], expires_in=-5)
    r3 = h.create("F12", dict(payload, approval_ref=expired))
    assert errors_of(r3)[0][0] == "EXPIRED_APPROVAL"
    good = k09(h, [ms])
    r4 = h.create("F12", dict(payload, approval_ref=good))
    assert r4["result"]["patches"][0]["approval_ref"] == good
    # draft manuscript cannot be polished
    draft = seed(h, "C11", {"text": "x", "candidate_events": [], "findings": []}, lifecycle="DRAFT")
    r5 = h.create("F12", dict(payload, approved_manuscript_ref=draft, manuscript_ref=draft))
    assert errors_of(r5)[0][0] == "APPROVAL_REQUIRED"


def test_f_output_never_manuscript_and_duplicate_delivery(h):
    ms = prose(h, "a  b")
    req = h.request("F09", "CREATE", payload={"language_tag": "en", "protected_names_ref": a15(h, []),
                                               "confidence_floor": 0.5, "manuscript_ref": ms, "instruction": "x",
                                               "span_ids": []}, idempotency_key="dup-f09")
    one = h.engine.dispatch(req, h.principal)
    two = h.engine.dispatch(req, h.principal)
    assert one == two
    fref = one["output_refs"][0]
    assert fref["owner"] == "F" and "text" not in one["result"]
    # an F record cannot be used where a manuscript is required (producer binding)
    r = h.create("F07", {"exact_min_occurrences": 2, "similarity_threshold": 0.5, "comparison_scope": "chapter",
                         "excluded_terms": [], "manuscript_ref": fref, "instruction": "x", "span_ids": []})
    assert errors_of(r)[0][0] == "INVALID_INPUT"


def test_f_update_rechecks_anchors(h):
    ms = prose(h, "a  b  c")
    fref = f09(h, ms, a15(h, []))["output_refs"][0]
    data = rec(h, fref)["data"]
    dup = dict(data, patches=data["patches"] + [dict(data["patches"][0], replacement="!")])
    r = h.dispatch("F09", "UPDATE", base_ref=fref, payload=dup)
    assert errors_of(r)[0][0] == "PATCH_OVERLAP"
    ok = h.dispatch("F09", "UPDATE", base_ref=fref, payload=dict(data, patches=data["patches"][:1]))
    assert ok["status"] == "DRAFT" and ok["output_refs"][0]["version"] == 2


def test_f12_c_acceptance_needs_authorization_for_exact_candidate(h):
    """C-side rule (documented flow): approval of the source/preview cannot authorize the changed text."""
    from bookforge.j_approvals import check_approval
    ms = prose(h, "The end  came.", module_id="C11")
    candidate = prose(h, "The end came.", module_id="C11", record=rec(h, ms), lifecycle="DRAFT")
    for_source = rec(h, k09(h, [ms]))
    try:
        check_approval(for_source, "/payload/approval_ref", subject=candidate)
        raise AssertionError("source approval must not authorize the polished candidate")
    except BookforgeError as exc:
        assert exc.code == "APPROVAL_REQUIRED"
    check_approval(rec(h, k09(h, [candidate])), "/payload/approval_ref", subject=candidate)
