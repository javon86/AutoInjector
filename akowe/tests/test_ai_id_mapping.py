"""A web AI wrote 'odile-marsh' as an outline's plan.pov_id instead of the character's canon ID, and the outline was
refused (CANON_UNRESOLVED). Akọwe now maps such a name-like ID to the ONE matching pinned canon record."""
from __future__ import annotations

from akowe import plan_rules as pr

GOV = dict(pr.AUTHORITY, **{"plan.pov_id": ("A01",), "plan.location_id": ("A04",)})


def fact(subject, predicate, value, kind="FACT"):
    return {"subject_id": subject, "predicate": predicate, "value": value, "assertion_type": kind,
            "effective_from": None, "effective_to": None, "source_refs": []}


def canon_rec(rid, module, subject, name):
    return {"record_id": rid, "module_id": module, "version": 1,
            "data": {"facts": [fact(subject, "entity.name", name)]}}


CANON = [canon_rec("A01-aaa", "A01", "char-1", "Odile Marsh"), canon_rec("A01-bbb", "A01", "char-2", "Tom Breck"),
         canon_rec("A04-ccc", "A04", "place-1", "Gullhaven Lighthouse")]


def outline(pov, loc="place-1"):
    return {"chapters": [{"summary": "x", "facts": [fact("ch1", "plan.pov_id", pov, "PLAN"),
                                                     fact("ch1", "plan.location_id", loc, "PLAN")]}]}


def value(data, pred):
    return next(f["value"] for _, f in pr.iter_facts(data) if f["predicate"] == pred)


def test_name_like_ids_map_to_the_canon_id():
    for written in ("odile-marsh", "Odile Marsh", "odile_marsh", "odile"):
        d = outline(written)
        notes = pr.resolve_entity_ids(d, CANON, GOV)
        assert value(d, "plan.pov_id") == "char-1" and notes, written
    d = outline("char-2", "gullhaven-lighthouse")
    pr.resolve_entity_ids(d, CANON, GOV)
    assert value(d, "plan.pov_id") == "char-2" and value(d, "plan.location_id") == "place-1"


def test_unknown_or_ambiguous_values_are_left_for_the_canon_check():
    d = outline("captain-vane")
    assert pr.resolve_entity_ids(d, CANON, GOV) == [] and value(d, "plan.pov_id") == "captain-vane"
    twins = CANON + [canon_rec("A01-ddd", "A01", "char-3", "Odile Fenn")]
    d = outline("odile")
    pr.resolve_entity_ids(d, twins, GOV)
    assert value(d, "plan.pov_id") == "odile"  # two Odiles: never guess
    d = outline(None)
    pr.resolve_entity_ids(d, CANON, GOV)
    assert value(d, "plan.pov_id") is None


def test_a_place_id_is_never_mapped_to_a_character():
    d = outline("odile-marsh", "odile-marsh")
    pr.resolve_entity_ids(d, CANON, GOV)
    assert value(d, "plan.location_id") == "odile-marsh"
