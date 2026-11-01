"""★ Story roles: every character has a title (main character, villain, mentor, extra…) and the book-making pipeline
always knows who the ONE main character is — by a tag on the character's record ID, robust to spelling corrections,
accents, titles, initials and renames, so the main character is never left out.

Covers: the role list and its back compatibility (old main/side, no role -> inferred proposal), exactly-one
protagonist resolution, the shared name matcher, Make a book with the fake AI (misspelt POV, no roles, two
protagonists), a renamed protagonist, the guard, the author's role picker and the guided path's chips.
"""
from __future__ import annotations

import time
import types

import pytest

from akowe import characters as chars_mod
from akowe import names
from akowe import plan_rules as pr
from akowe import protagonist
from akowe import providers as prov_mod
from akowe import story_roles
from akowe.book_path import BookPath, save_profile

import autobook_fake
from autobook_fake import BookFakeAI, fact
from test_autobook import FAKE_KEY, make_app
from test_autobook import run_book as _run_book


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def run_book(app, body=None):
    run = _run_book(app, body)
    return dict(run, _full=app.autobook.get(run["id"]))


def events(run, code=None):
    return [e for e in (run.get("_full") or run)["events"] if code is None or e.get("code") == code]


class NoStore:
    def get_setting(self, key):
        return None


def ch(rid, name, role_text="", approved=True, subject=None):
    return {"record_id": rid, "name": name, "subject_id": subject or "-".join(name.lower().split()),
            "approved": approved, "attributes": {"role": role_text} if role_text else {}, "facts": []}


def entry(story_role=None, by=None, legacy=None, at=None):
    e = {"sheet": {"role": legacy or ""}}
    if story_role:
        e.update(story_role=story_role, story_role_by=by or "ai", story_role_at=at)
    return e


def cast_of(chars, entries, idea="", povs=()):
    k = story_roles.cast(NoStore(), "p", "main", chars=chars, entries=entries, idea=idea, povs=list(povs))
    return k, {c["name"]: c for c in k["characters"]}


# ============================================================================================ the role list
def test_every_role_has_a_label_a_meaning_an_icon_and_a_group():
    info = story_roles.role_info()
    keys = [r["key"] for r in info]
    for k in ("protagonist", "deuteragonist", "antagonist", "love_interest", "mentor", "sidekick", "ally",
              "supporting", "rival", "henchman", "family", "minor", "extra"):
        assert k in keys
    assert all(r["label"] and r["meaning"] and r["icon"] and r["group_label"] for r in info)
    assert story_roles.title("protagonist") == "★ Main character"
    assert [g for g, _l in story_roles.GROUPS] == ["main", "leads", "villains", "supporting", "minor"]
    assert story_roles.group_of("henchman") == "villains" and story_roles.group_of("love_interest") == "leads"
    assert chars_mod.field_info()["story_roles"] == info


@pytest.mark.parametrize("raw,want", [("protagonist", "protagonist"), ("Main character", "protagonist"),
                                      ("main", "protagonist"), ("villain", "antagonist"), ("Love Interest",
                                                                                           "love_interest"),
                                      ("walk-on", "extra"), ("side", "supporting"), ("minion", "henchman"),
                                      ("galactic overlord", "supporting"), ("", "supporting"), (None, "supporting")])
def test_normalize_unknown_roles_become_supporting(raw, want):
    assert story_roles.normalize(raw) == want


def test_infer_from_the_character_s_own_role_words():
    assert story_roles.infer("The harbour master's enforcer, who does the dirty work") == "henchman"
    assert story_roles.infer("The villain of the piece") == "antagonist"
    assert story_roles.infer("Mara's older sister") == "family"
    assert story_roles.infer("A fisherman") is None


def test_clean_sheet_keeps_the_story_role_and_the_old_role_for_older_readers():
    s = chars_mod.clean_sheet({"story_role": "villain", "wants": "x"})
    assert s["story_role"] == "antagonist" and s["role"] == "side"
    s = chars_mod.clean_sheet({"story_role": "deuteragonist"})
    assert s["role"] == "main"
    s = chars_mod.clean_sheet({"role": "main"})  # an old sheet: no story role yet (the cast decides)
    assert s["story_role"] == "" and s["role"] == "main"
    assert "story_role" in chars_mod.SHEET_SCHEMA["properties"]
    assert chars_mod.SHEET_SCHEMA["properties"]["story_role"]["enum"] == list(story_roles.KEYS)


# ============================================================================================ back compatibility
def test_old_main_is_the_protagonist_when_alone_and_side_is_supporting():
    k, by = cast_of([ch("a", "Odile Marsh"), ch("b", "Tamsin Reed")], {"a": entry(legacy="main"),
                                                                       "b": entry(legacy="side")})
    assert k["protagonist"] == "a"
    assert by["Odile Marsh"]["story_role"] == "protagonist" and not by["Odile Marsh"]["proposed"]
    assert by["Tamsin Reed"]["story_role"] == "supporting" and not by["Tamsin Reed"]["proposed"]


def test_two_old_mains_the_primary_is_protagonist_the_other_a_second_lead():
    chars = [ch("a", "Corvin Haske"), ch("b", "Odile Marsh")]
    k, by = cast_of(chars, {"a": entry(legacy="main"), "b": entry(legacy="main")},
                    idea="Odile Marsh is the last lamplighter of Vell Harbour.")
    assert k["protagonist"] == "b" and "idea" in k["reason"]
    assert by["Corvin Haske"]["story_role"] == "deuteragonist"


def test_no_role_is_inferred_and_marked_as_a_proposal():
    chars = [ch("a", "Odile Marsh"), ch("b", "Silas Crane", "the villain who owns the ferry"), ch("c", "Pip")]
    k, by = cast_of(chars, {}, idea="Odile Marsh keeps the lamps.")
    assert k["protagonist"] == "a"
    assert by["Silas Crane"]["story_role"] == "antagonist" and by["Silas Crane"]["proposed"]
    assert by["Pip"]["story_role"] == "supporting" and by["Pip"]["proposed"]
    assert by["Odile Marsh"]["proposed"]  # nobody confirmed it yet


# ============================================================================================ exactly one protagonist
def test_two_ai_protagonists_resolve_to_the_one_named_in_the_idea():
    chars = [ch("a", "Tamsin Reed"), ch("b", "Odile Marsh")]
    k, by = cast_of(chars, {"a": entry("protagonist"), "b": entry("protagonist")},
                    idea="Odille Marsh, the last lamplighter, must cross the bay.")  # the idea misspells her
    assert k["protagonist"] == "b"
    assert by["Tamsin Reed"]["story_role"] == "deuteragonist"
    assert sum(c["story_role"] == "protagonist" for c in k["characters"]) == 1


def test_resolution_order_main_mark_then_pov_then_first_created():
    chars = [ch("a", "Ann Tull"), ch("b", "Bea Lorn"), ch("c", "Cal Vey")]
    assert cast_of(chars, {"c": entry(legacy="main")})[0]["protagonist"] == "c"  # Bible Builder main mark
    assert cast_of(chars, {}, povs=["bea-lorn", "Bea Lorn", "cal-vey"])[0]["protagonist"] == "b"  # most POV
    assert cast_of(chars, {})[0]["protagonist"] == "a"  # first created
    k = cast_of(chars, {"b": entry("protagonist"), "c": entry("protagonist")}, povs=["cal-vey"])[0]
    assert k["protagonist"] == "c"


def test_the_author_s_choice_wins_over_everything():
    chars = [ch("a", "Odile Marsh"), ch("b", "Tamsin Reed")]
    k, by = cast_of(chars, {"a": entry("protagonist", "ai"), "b": entry("protagonist", "author", at="2026-01-01")},
                    idea="Odile Marsh is the last lamplighter.")
    assert k["protagonist"] == "b" and k["reason"] == "chosen by you"


# ============================================================================================ the name matcher
@pytest.mark.parametrize("variant", ["Odile Marsh", "Odille Marsh", "odile marsh", "Odíle Marsh", "O. Marsh",
                                     "Captain Odile Marsh", "odile-marsh", "Odile Marsh's", "ODILE  MARSH",
                                     "Odile"])
def test_spelling_accents_case_titles_initials_are_the_same_person(variant):
    assert names.same_person(variant, "Odile Marsh")
    assert names.match(variant, [("odile", ["Odile Marsh"]), ("tamsin", ["Tamsin Reed"])]) == "odile"


def test_yoruba_marks_and_titles():
    assert names.normalize("Chief Ọláwálé Adébáyọ̀") == "olawale adebayo"
    assert names.same_person("Olawale Adebayo", "Ọláwálé Adébáyọ̀")


def test_close_names_of_two_characters_never_auto_match():
    cands = [("odile", ["Odile Marsh"]), ("odette", ["Odette Marsh"])]
    assert not names.same_person("Odile", "Odette")
    assert names.match("Odile Marsh", cands) == "odile" and names.match("Odette Marsh", cands) == "odette"
    assert names.match("Marsh", cands) is None  # the family name alone: which one?
    assert names.match("O. Marsh", cands) is None


def test_a_place_is_never_matched_as_a_person():
    assert names.score("Marsh Harbour", "Odile Marsh") == 0
    assert names.match("Marsh Harbour", [("odile", ["Odile Marsh"])]) is None
    assert names.match("Vell", [("odile", ["Odile Vell"])], exclude=["Vell"]) is None  # a canon place's name


def test_canon_resolution_maps_a_misspelt_pov_to_the_one_character():
    def rec(mod, sid, name):
        return {"module_id": mod, "record_id": f"r-{sid}", "data": {"facts": [fact(sid, "entity.name", name)]}}
    canon = [rec("A01", "odile-marsh", "Odile Marsh"), rec("A01", "tamsin-reed", "Tamsin Reed"),
             rec("A04", "marsh-harbour", "Marsh Harbour")]
    data = {"chapters": [{"facts": [fact("ch1", "plan.pov_id", "Captain Odille Marsh", "PLAN")]},
                         {"facts": [fact("ch2", "plan.pov_id", "Marsh Harbour", "PLAN")]}]}
    notes = pr.resolve_entity_ids(data, canon, {"plan.pov_id": ("A01",)})
    assert data["chapters"][0]["facts"][0]["value"] == "odile-marsh" and notes
    assert data["chapters"][1]["facts"][0]["value"] == "Marsh Harbour"  # a place: still refused by the check


# ============================================================================================ Make a book (fake AI)
def protagonist_rid(app, run):
    return story_roles.tagged_protagonist(app.store, run["project_id"], "main")


def test_make_a_book_tags_every_character_and_the_outline_follows_the_protagonist(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    k = story_roles.cast(app.store, pid, "main")
    by = {c["name"]: c for c in k["characters"]}
    assert by["Mara Vell"]["story_role"] == "protagonist" and k["protagonist"] == protagonist_rid(app, run)
    assert all(c["story_role"] in story_roles.KEYS for c in k["characters"])
    # the AI was asked for story roles (world sketch and character sheets) and the outline got the protagonist
    sketch = [t for t, _c in fake.prompts.get("sketch", [])]
    assert sketch and "story_role" in sketch[0] and "Exactly ONE character" in sketch[0]
    b11 = [c for _t, c in fake.prompts.get("B11", [])]
    assert b11 and b11[-1]["main_character"]["pov_id"] == by["Mara Vell"]["subject_id"]
    assert {c["story_role"] for c in b11[-1]["cast"]} >= {"protagonist"}
    # the A01 record says the title in words, too
    bp = BookPath(app.engine, "author", pid, "main")
    mara = bp.rec(k["protagonist"])
    assert mara["data"]["attributes"]["role"].startswith("Story role: Main character.")
    assert protagonist.check(bp)["ok"]


def test_ai_misspells_the_protagonist_in_the_outline_pov_she_is_still_resolved(tmp_path):
    fake = BookFakeAI()
    fake.pov_name = "Mara Vel"  # a "spelling correction" of the canon name, not her canon ID
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    povs = story_roles.outline_povs(app.store, run["project_id"], "main")
    prot = story_roles.protagonist_of(app.store, run["project_id"], "main")
    assert prot["name"] == "Mara Vell" and povs and set(povs) == {prot["subject_id"]}
    assert protagonist.check(bp)["ok"] and not events(run, "PROTAGONIST_MISSING")


def test_ai_gives_no_roles_they_are_inferred_and_the_idea_names_the_protagonist(tmp_path):
    fake = BookFakeAI()
    fake.no_roles = True
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    k = story_roles.cast(app.store, run["project_id"], "main")
    by = {c["name"]: c for c in k["characters"]}
    assert by["Mara Vell"]["story_role"] == "protagonist" and not by["Mara Vell"]["proposed"]
    others = [c for c in k["characters"] if c["name"] != "Mara Vell"]
    assert others and all(c["story_role"] != "protagonist" and c["proposed"] for c in others)
    ev = events(run, "PROTAGONIST_SET")
    assert ev and "Mara Vell" in ev[0]["message"] and "named in the book idea" in ev[0]["message"]


def test_ai_gives_two_protagonists_exactly_one_stays(tmp_path):
    fake = BookFakeAI()
    fake.role_override = {"Tom Reed": "protagonist"}
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    k = story_roles.cast(app.store, run["project_id"], "main")
    roles = {c["name"]: c["story_role"] for c in k["characters"]}
    assert roles["Mara Vell"] == "protagonist" and roles["Tom Reed"] == "deuteragonist"
    assert list(roles.values()).count("protagonist") == 1
    ev = events(run, "PROTAGONIST_SET")
    assert any("Tom Reed" in e["message"] and "second lead" in e["message"] for e in ev)


NEUTRAL = ["The keeper's log is found in the dark lighthouse", "The harbor learns about the stranger",
           "The brass key is found on the reef"]


def test_outline_without_the_protagonist_is_redone_then_the_run_goes_on(tmp_path, monkeypatch):
    monkeypatch.setattr(autobook_fake, "OBJECTIVES", NEUTRAL)
    fake = BookFakeAI()
    fake.pov_name = "tom-reed"  # the first outline gives every chapter to someone else
    app = make_app(tmp_path, fake=fake)
    seen = []
    real = fake._answer

    def answer(ctx, props, schema):
        kind, out = real(ctx, props, schema)
        if kind == "B11":
            seen.append(1)
            if len(seen) > 1:
                fake.pov_name = None
                kind, out = real(ctx, props, schema)
        return kind, out
    fake._answer = answer
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    assert len(seen) >= 2
    assert any("PROTAGONIST_NOT_IN_OUTLINE" in e["message"] for e in events(run, "PROTAGONIST_MISSING"))
    assert protagonist.check(BookPath(app.engine, "author", run["project_id"], "main"))["ok"]


def test_guard_stops_with_protagonist_missing_when_the_outline_never_has_them(tmp_path, monkeypatch):
    monkeypatch.setattr(autobook_fake, "OBJECTIVES", NEUTRAL)
    fake = BookFakeAI()
    fake.pov_name = "tom-reed"
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "paused"
    prob = run["problem"]
    assert "Mara Vell" in prob["message"] and "PROTAGONIST_NOT_IN_OUTLINE" in prob["message"]
    assert "C02" not in fake.kinds  # no chapter was written without her


# ============================================================================================ renames, the guard
def _book_with_characters(tmp_path, names_, idea="Odile Marsh is the last lamplighter of Vell Harbour."):
    app = make_app(tmp_path, fake=BookFakeAI())
    pid = app.engine.bootstrap_project("author", "Lamplighter")
    save_profile(app.store, pid, {"title": "The Lamplighter's Last Ferry", "length": "short_story", "idea": idea})
    bp = BookPath(app.engine, "author", pid, "main")
    rids = []
    for n in names_:
        sid = "-".join(n.lower().split())
        cand = {"concept": n, "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
                "facts": [fact(sid, "entity.name", n)]}
        ref, _ = bp.create("A01", {"concept": n}, manual_candidate=cand)
        assert bp.act("approve", {"record_ids": [ref["record_id"]], "author_confirms": True})["results"][0]["ok"]
        rids.append(ref["record_id"])
    return app, pid, rids


def test_renamed_protagonist_keeps_the_tag_never_re_derived_from_text(tmp_path):
    app, pid, (odile, tamsin) = _book_with_characters(tmp_path, ["Odile Marsh", "Tamsin Reed"])
    res = story_roles.enforce(app.store, pid, "main")
    assert res["protagonist"] == odile and "idea" in res["reason"]
    # the protagonist is renamed ("Odile Marsh" -> "Wren Calloway") and the idea still names someone else
    save_profile(app.store, pid, {"idea": "Tamsin Reed rows the last ferry across the bay."})
    chars = chars_mod.canon_characters(app.store, pid, "main")
    for c in chars:
        if c["record_id"] == odile:
            c["name"], c["subject_id"] = "Wren Calloway", "wren-calloway"
    k = story_roles.cast(app.store, pid, "main", chars=chars)
    assert k["protagonist"] == odile
    assert story_roles.enforce(app.store, pid, "main", chars=chars)["changed"] == []


def test_author_moves_the_star_and_the_guided_path_shows_chips(tmp_path):
    app, pid, (odile, tamsin) = _book_with_characters(tmp_path, ["Odile Marsh", "Tamsin Reed"])
    steps = {s["id"]: s for s in BookPath(app.engine, "author", pid, "main").status()["steps"]}
    canon = steps["canon"]
    assert canon["no_protagonist"] is True and canon["protagonist"]["name"] == "Odile Marsh"
    assert {c["name"]: c["story_role"] for c in canon["cast"]}["Odile Marsh"] == "protagonist"
    out = app.book_act("author", pid, "main", "set_role", {"record_id": tamsin, "story_role": "protagonist"})
    assert out["ok"]
    canon = {s["id"]: s for s in out["book"]["steps"]}["canon"]
    assert canon["no_protagonist"] is False and canon["protagonist"]["record_id"] == tamsin
    # the character page: the picker moves the ★ back, the previous one becomes a second lead
    r = app.review.set_character_role("author", pid, "main", odile, {"story_role": "protagonist"})
    assert r["previous_protagonist"]["record_id"] == tamsin and "second lead" in r["message"]
    assert story_roles.story_role(app.store, pid, "main", tamsin) == "deuteragonist"
    info = app.review.character_info("author", pid, "main", odile)
    assert info["story_role"]["story_role"] == "protagonist" and info["story_role"]["title"] == "★ Main character"
    with pytest.raises(Exception):
        app.review.set_character_role("author", pid, "main", odile, {"story_role": "overlord"})
    # an AI sheet later never takes the author's role away
    chars_mod.save_entry(app.store, pid, "main", tamsin, sheet={"story_role": "protagonist", "wants": "x"}, by="ai")
    assert story_roles.protagonist_of(app.store, pid, "main")["record_id"] == odile


def test_guard_check_and_outline_presence(tmp_path):
    app, pid, (odile, tamsin) = _book_with_characters(tmp_path, ["Odile Marsh", "Tamsin Reed"])
    story_roles.enforce(app.store, pid, "main")
    bp = BookPath(app.engine, "author", pid, "main")
    chk = protagonist.check(bp)
    assert chk["ok"] and chk["in_canon"] and chk["in_outline"] is None  # no outline yet
    chars = chars_mod.canon_characters(app.store, pid, "main")
    prot = story_roles.protagonist_of(app.store, pid, "main")
    outline = {"data": {"chapters": [
        {"summary": "Tamsin rows out.", "facts": [fact("ch1", "plan.pov_id", "tamsin-reed", "PLAN")]},
        {"summary": "Captain Odíle Marsh lights the lamp.", "facts": [fact("ch2", "plan.pov_id", "tamsin-reed",
                                                                            "PLAN")]}]}}
    assert protagonist.in_outline(outline, prot, chars) == [1]  # named in the chapter (accents, title)
    outline["data"]["chapters"][1]["summary"] = "The lamp is lit."
    assert protagonist.in_outline(outline, prot, chars) == []
    outline["data"]["chapters"][0]["facts"][0]["value"] = "odille-marsh"  # a misspelt POV ID is still her
    assert protagonist.in_outline(outline, prot, chars) == [0]


def test_missing_main_character_found_through_a_spelling_correction(tmp_path):
    """The idea says "Odile Marsh"; the approved canon spells her "Odille Marsh": she is not missing."""
    app, pid, _ = _book_with_characters(tmp_path, ["Odille Marsh", "Tamsin Reed"])
    bp = BookPath(app.engine, "author", pid, "main")
    assert protagonist.missing(bp, store=app.store) == []
    k = story_roles.cast(app.store, pid, "main")
    assert {c["name"]: c["story_role"] for c in k["characters"]}["Odille Marsh"] == "protagonist"


def test_make_for_book_makes_the_missing_main_character_as_protagonist(tmp_path):
    fake = BookFakeAI()
    app, pid, (tamsin,) = _book_with_characters(tmp_path, ["Tamsin Reed"])
    app.engine.providers.test_adapter = fake
    app.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic", "api_key": FAKE_KEY})
    out = app.book_act("author", pid, "main", "make_character", {"name": "Odile Marsh"})
    assert out["ok"] and out.get("created"), out
    rid = out["created"]["record_id"]
    assert story_roles.tagged_protagonist(app.store, pid, "main") == rid
    asks = [c for _t, c in fake.prompts.get("canon", []) if (c.get("this_item") or {}).get("name") == "Odile Marsh"]
    assert asks and asks[0]["this_item"]["story_role"] == "protagonist"
    assert "story_role is protagonist" in asks[0]["author_request"]


def test_fake_ai_sheet_carries_story_role():
    assert autobook_fake.sheet_for("Mara Vell")["story_role"] == "protagonist"
    assert autobook_fake.sheet_for("Ilse Marrow")["story_role"] == "antagonist"
    assert "story_role" not in autobook_fake.sheet_for("Mara Vell", story_role=False)
    assert "role" not in autobook_fake.sheet_for("Mara Vell", story_role=False)
