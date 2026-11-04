"""🔢 The Book Bible code map (code_map.py): every binder field id and every Forge field has exactly one code, codes
round-trip, whole sections expand, the old Forge letters and binder numbers translate, the generated sheet and web
module are in sync, and the checks name the exact detail by its code."""
from __future__ import annotations

import json
import re

import pytest

from akowe import binder, code_map as cm, forge, story_details, story_ledger
from akowe.errors import AkoweError
from akowe.forge_kinds_spec import SPECS


# ---------------------------------------------------------------------------------------------- completeness
def test_every_binder_id_forge_field_and_new_value_has_exactly_one_code():
    a = cm.audit()
    assert all(not v for v in a.values()), {k: v for k, v in a.items() if v}
    ids = cm.binder_ids()
    assert len(ids) == len(set(ids)) >= 480
    assert set(ids) == set(binder.all_ids())
    # every id / key resolves to one code, and that code lists it back
    for fid in ids:
        (code,) = cm.codes_for(fid)
        assert fid in cm.resolve(code)["binder"]
    for key in cm.forge_keys():
        (code,) = cm.codes_for(key)
        assert key in cm.resolve(code)["forge"]
    assert len(cm.forge_keys()) == len(forge.FIELDS) + sum(len(s["fields"]) for s in SPECS.values())


def test_the_rules_of_the_codes():
    for code, e in cm.fields().items():
        assert re.fullmatch(r"[BCPMIGSHWN]\d[a-z]", code), code
        assert e["section"] == f"{code[0]}{code[1]}{code[1]}"
    for scode, s in cm.sections().items():
        assert len(s["fields"]) <= 26 and scode[1] == scode[2]
        # letters run a, b, c… with no gaps
        assert [c[2] for c in s["fields"]] == list("abcdefghijklmnopqrstuvwxyz"[:len(s["fields"])])
    # the author's draft: C1c = eyes, quick-stat looks moved into Looks, C11 = Looks, C33 = Voice
    assert cm.resolve("C1c")["label"] == "Eyes" and "5.2.8" in cm.resolve("C1c")["binder"]
    assert cm.resolve("C1c")["forge"] == ["character:eyes"] and cm.resolve("C1c")["bible"] == ["character:eyes"]
    assert cm.resolve("C11")["label"] == "Looks" and cm.resolve("C33")["label"] == "Voice"
    for fid in ("5.2.5", "5.2.6", "5.2.7", "5.2.9", "5.2.10", "5.2.11"):
        assert cm.codes_for(fid)[0].startswith("C1"), fid
    assert sorted({c[0] for c in cm.sections()}) == sorted("BCPMIGSHWN")
    assert set(cm.KINDS) == set("BCPMIGSHWN")


def test_running_notes_map_onto_the_story_ledger():
    assert cm.codes_for("people.injuries") == ["N1a"]
    assert cm.codes_for("ledger:people.items_lost") == ["N2c"]
    assert cm.codes_for("time.season") == ["N6c"] and cm.codes_for("names") == ["N8a"]
    assert cm.codes_for("summary") == ["N9a"]
    # every category the ledger stores has a code
    props = story_ledger.STORY_SCHEMA["properties"]
    cats = ["summary", "names", "trips", "knowledge", "relationships"] + \
        [f"people.{k}" for k in story_ledger.PERSON["properties"] if k != "name"] + \
        [f"time.{k}" for k in props["time"]["properties"]] + \
        [f"numbers.{k}" for k in props["numbers"]["items"]["properties"]["kind"]["enum"]]
    for c in cats:
        assert cm.codes_for(f"ledger:{c}"), c
    assert set(story_ledger.FLAG_FIELDS) == set(story_ledger.FLAG_WORDS)


# ---------------------------------------------------------------------------------------------- parse / format / expand
def test_round_trips_and_expand():
    for code in cm.all_codes():
        p = cm.parse(code)
        assert cm.format_code(p["kind"], p["digit"], p["letter"]) == code
        assert cm.expand(code) == [code]
    for scode, s in cm.sections().items():
        p = cm.parse(scode)
        assert p["whole"] and cm.format_code(p["kind"], p["digit"]) == scode
        assert cm.expand(scode) == s["fields"]
        assert cm.expand(scode[:2]) == s["fields"]  # "C1" means the whole section too
    assert cm.expand("C11")[:3] == ["C1a", "C1b", "C1c"]
    assert cm.resolve("C33")["whole"] and len(cm.resolve("C33")["fields"]) == len(cm.expand("C33"))


@pytest.mark.parametrize("bad, words", [("C12", "number written twice"), ("X1a", "not a Book Bible code"),
                                        ("C1z", "fields a-"), ("P8a", "no section 8"), ("", "not a Book Bible code"),
                                        ("c1c", "not a Book Bible code"), ("C10a", "not a Book Bible code")])
def test_unknown_codes_give_a_clear_error(bad, words):
    with pytest.raises(AkoweError) as e:
        cm.parse(bad)
    assert words in e.value.errors[0]["message"]
    assert not cm.is_code(bad)


# ---------------------------------------------------------------------------------------------- old forms translate
def test_old_forge_letters_and_binder_numbers_keep_working():
    assert cm.resolve("5.2.8")["code"] == "C1c"
    assert cm.resolve("character:eyes")["code"] == "C1c"
    assert cm.codes_for("eyes", kind="character") == ["C1c"]
    assert cm.codes_for("forge:place:sights") == ["P2a"]
    assert cm.codes_for("character:height") == ["C1b"]          # a 🆕 value
    assert cm.codes_for("relationship:type") == ["C5b"]
    assert cm.codes_for("5.2")[:4] == ["C0f", "C0g", "C0h", "C0i"]  # a binder section -> its codes
    a = cm.resolve("A")                                           # the old Appearance letter
    assert a["code"] == "C11" and a["old_letter"] == "A" and "C1c" in a["translated"]
    for letter in cm.LETTER_NAMES:
        codes = cm.codes_for(letter)
        assert codes and all(c.startswith("C") for c in codes), letter
        tagged = {k for k, f in forge.FIELDS.items() if letter in f["letters"]}
        assert {cm.code_of_field("character", k) for k in tagged} == set(codes)
    assert cm.codes_for("nonsense") == [] and cm.codes_for("99.9.9") == []
    with pytest.raises(AkoweError):
        cm.resolve("nonsense")
    assert cm.tag("character", "eyes") == "C1c (eyes)"
    assert cm.tag("character", "primary_weapon", "Primary weapon") == "C7a (primary weapon)"


# ---------------------------------------------------------------------------------------------- the generated files
def test_docs_and_web_module_are_in_sync():
    assert cm.DOC_PATH.read_text(encoding="utf-8") == cm.markdown(), \
        "docs/CODE_MAP.md is out of date: run python -m akowe.code_map --write"
    assert cm.WEB_PATH.read_text(encoding="utf-8") == cm.web_module(), \
        "web/code-map.js is out of date: run python -m akowe.code_map --write"
    md = cm.markdown()
    assert "`C1c` | Eyes | 5.2.8" in md and "### `C11` Looks" in md and "### `N11` Injuries" in md
    data = json.loads(cm.web_module().split("export const CODE_MAP = ", 1)[1].split(";\nexport const", 1)[0])
    assert data["fid"]["5.2.8"] == "C1c" and data["sections"]["C11"][0] == "Looks"
    assert "5.2" in data["sections"]["C11"][2] and "5.2" in data["sections"]["C00"][2]


# ---------------------------------------------------------------------------------------------- the checks use the codes
def test_locked_detail_contradictions_name_the_code(tmp_path):
    class Store:
        def __init__(self):
            self.s = {}

        def get_setting(self, k):
            return self.s.get(k)

        def set_setting(self, k, v):
            self.s[k] = v
    st = Store()
    st.set_setting(story_details.KEY.format(pid="p", branch="b"), {"locked": {
        "character:R1": {"eyes": {"text": "storm-grey eyes", "name": "Mara Vell", "chapter": "c1"},
                         "primary_weapon": {"text": "a cutlass", "name": "Mara Vell", "chapter": "c1"}},
        "item:K1": {"materials": {"text": "brass", "name": "The brass key"}}}})
    out = story_details.contradictions(st, "p", "b", [{"chapter_id": "c9", "number": 9, "text":
                                                      "Mara blinked her brown eyes. Mara drew her axe. "
                                                      "The silver key lay there."}])
    msgs = {o["field_code"]: o["message"] for o in out}
    assert msgs["C1c"].startswith("Chapter 9: Mara Vell C1c (eyes) doesn't match — the sheet says “storm-grey "
                                  "eyes”, the book says “brown eyes”. Which is right?")
    assert "C7a (primary weapon)" in msgs["C7a"] and "I0l (look)" in msgs["I0l"]


def test_ledger_flags_carry_the_running_notes_code():
    e1 = {"chapter_id": "c1", "number": 1, "people": [{"name": "Mara", "status": "dead", "where": "", "injuries": [],
                                                       "items_gained": [], "items_lost": [], "carrying": [],
                                                       "magic_cost": ""}], "names": [], "time": {}, "trips": [],
          "knowledge": [], "relationships": [], "numbers": []}
    e2 = dict(e1, chapter_id="c2", number=2, people=[])
    flags = story_ledger.check([e1], e2, "Mara said hello and walked to the door.")
    dead = [f for f in flags if f["code"] == "DEAD_ACTS"]
    assert dead and dead[0]["field_code"] == "N3a" and dead[0]["message"].endswith("(N3a)")
