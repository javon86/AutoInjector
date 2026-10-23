"""Review2: E08 power limits (NEW-ops-2). Spec E: "power use exceeding A09 limits produces a finding"; Spec A:
"A09 powers must state costs and limits used by scenes". The limits that govern an event must be the ones of the
character the E08 projection is about, not of every A record pinned in source_refs."""
from __future__ import annotations

import sys
from pathlib import Path

OPS = Path(__file__).resolve().parent.parent / "ops"
if str(OPS) not in sys.path:
    sys.path.insert(0, str(OPS))

from test_ops_crossset import chapter, ev  # noqa: E402
from test_set_c import approved, build_world, fact  # noqa: E402
from test_set_e import accept_ok, e_create, rules  # noqa: E402


def test_e08_uses_only_the_tracked_characters_power_limits(h):
    """BUG: StateTracker.power_limits collects x.a09.limit from EVERY approved A record in baseline_refs /
    source_refs and the A09s they link, then power_limit_error applies min() of all of them. Pinning a second
    character (as a scene with both of them would) imposes that character's power system limit on Mara: spending
    2 of her 8 tide units (limit 10) is refused because Tom's storm magic has limit 1."""
    h.set_features(magic=True)
    w = build_world(h)

    def a09(name, sid, limit):
        return approved(h, "A09", {"concept": name}, {
            "concept": name, "attributes": {"costs": "one unit per use", "limits": f"at most {limit} units"},
            "linked_refs": [], "protected_fact_flags": [],
            "facts": [fact(sid, "x.a09.cost", 1), fact(sid, "x.a09.limit", limit)]})
    tide, storm = a09("Tide magic", "tide-magic", 10), a09("Storm magic", "storm-magic", 1)
    mara = approved(h, "A01", {"concept": "Mara"}, {
        "concept": "Mara", "attributes": {}, "linked_refs": [tide, w["places"]], "protected_fact_flags": [],
        "facts": [fact("mara", "entity.name", "Mara"), fact("mara", "entity.power_remaining", 8)]})
    tom = approved(h, "A01", {"concept": "Tom"}, {
        "concept": "Tom", "attributes": {}, "linked_refs": [storm, w["places"]], "protected_fact_flags": [],
        "facts": [fact("tom", "entity.name", "Tom"), fact("tom", "entity.power_remaining", 1)]})
    _, evs = chapter(h, w, "ch1", "Mara spent two units of tide power while Tom watched.",
                     [ev("/power_remaining", "SET", 8, 6, 10, "spent two units of tide power")])
    start = e_create(h, "E08", "mara", "INITIALIZE", baseline_ref=mara, source_refs=[mara, tom])
    assert start["status"] == "DRAFT", start
    accept_ok(h, start["output_refs"][0])
    r = e_create(h, "E08", "mara", "APPLY", events=evs, current_snapshot_ref=start["output_refs"][0])
    assert "POWER_LIMIT" not in rules(r), [f["message"] for f in r["result"]["findings"]]
    assert r["result"]["accepted_event_ids"] == [evs[0]["event_id"]]
