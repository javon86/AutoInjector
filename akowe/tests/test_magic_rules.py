"""✨ Magic rules that are kept (magic_rules.py): structured ability rules, the use ledger across chapters, the rule
check per chapter (must-fix for the editor), deliberate twists, free-text rules, the writer's brief and a fake-AI run."""
from __future__ import annotations

import pytest

from akowe import magic_rules as mr
from akowe import story_rules
from akowe.errors import AkoweError

from test_failover_review import SlotFake, make_app, run_book  # noqa: F401

NAMES = ["Mara Vell", "Tom Reed"]
TELEPORT = {"name": "Teleportation", "does": "The user steps from one place to another she can see.",
            "requires": ["2 anchor stones", "line of sight", "at night only"],
            "limits": ["3 times a day", "cooldown 1 hour"], "price": "a nosebleed", "who": "Mara",
            "exceptions": "none", "start": "Mara: 3 anchor stones"}


def _ab(**over):
    return mr.ability(mr.clean_magic(dict(TELEPORT, **over)), "r1")


def _chapters(*texts):
    return [{"chapter_id": f"ch{i + 1}", "number": i + 1, "text": t, "version": 1} for i, t in enumerate(texts)]


C1 = ("Night fell over Gullhaven. Mara Vell crushed two anchor stones in her fist and teleported to the reef. Her "
      "nose bled onto her collar.")
C2 = ("In the morning Mara found one anchor stone in the sand. \"I could teleport,\" Tom said. That night she "
      "teleported home, blood running from her nose.")
C3 = "At midnight Mara teleported again with only one anchor stone, and her nose bled."


# ====================================================================== structured rules
def test_structured_rule_parsing():
    assert mr.parse_requirement("2 anchor stones") == {"text": "2 anchor stones", "kind": "item", "qty": 2,
                                                       "item": "anchor stones", "consumed": True}
    assert mr.parse_requirement("two anchor stones (kept)")["consumed"] is False
    assert mr.parse_requirement("a pair of moonstones")["qty"] == 2
    assert mr.parse_requirement("line of sight")["kind"] == "condition"
    assert mr.parse_requirement("at night only") == {"text": "at night only", "kind": "time", "when": "night"}
    lim = mr.parse_limits(["3 times a day", "cooldown 1 hour", "range: within a mile"])
    assert lim["per_day"] == 3 and lim["cooldown"] == "cooldown 1 hour" and lim["range"].startswith("range")
    assert mr.parse_limits(["once a night"])["per_day"] == 1
    assert mr.parse_start("Mara: 3 anchor stones; Tom Reed: 1 anchor stone") == {
        "Mara": {"anchor stone": 3}, "Tom Reed": {"anchor stone": 1}}
    mg = mr.clean_magic(dict(TELEPORT, requires="2 anchor stones\nline of sight"))
    assert mg["requires"] == ["2 anchor stones", "line of sight"] and mg["exceptions"] == ""  # "none" = no exception
    assert mr.clean_magic({"does": "no name"}) is None
    a = _ab()
    assert a["pattern"].search("she teleported") and a["pattern"].search("Teleportation") and not a["anyone"]
    assert _ab(words="blink, step through")["pattern"].search("she blinked")


def test_a_rule_keeps_its_structured_fields_and_an_old_rule_is_unchanged():
    r = story_rules.clean_rule({"category": "hard_rule", "text": "Teleportation needs anchor stones.",
                                "magic": dict(TELEPORT, requires="2 anchor stones")})
    assert r["magic"]["name"] == "Teleportation" and r["magic"]["requires"] == ["2 anchor stones"]
    old = story_rules.clean_rule({"category": "hard_rule", "text": "The lamp lights only with the key.",
                                  "scope": "only at the Old Light"})
    assert "magic" not in old
    assert "magic" in story_rules.RULE_SCHEMA["properties"] and "magic" in story_rules.RULES_TASK
    assert "magic" not in story_rules.RULE_SCHEMA["required"]  # optional: an ordinary rule has none


def test_free_text_rules_still_work():
    mg = mr.parse_free("Teleportation requires two anchor stones and line of sight.",
                       "only at night; at most three times a day; each jump leaves a nosebleed")
    assert mg["name"] == "Teleportation" and "two anchor stones" in mg["requires"] and mg["from_text"]
    assert mg["limits"] == ["at most three times a day"] and "nosebleed" in mg["price"]
    assert mr.parse_free("Boats turn for home when the lamp blazes.") is None
    entry = {"rules": [
        {"id": "r1", "category": "hard_rule", "text": "Teleportation requires two anchor stones.", "scope": "",
         "status": "active"},
        {"id": "r2", "category": "belief", "text": "Harbour folk believe the drowned guide the light.",
         "status": "active"},
        {"id": "r3", "category": "hard_rule", "text": "The lamp lights only when the key turns.", "scope": "once",
         "status": "active"}]}
    abs_ = mr.abilities_of(entry)
    assert [a["name"] for a in abs_] == ["Teleportation"] and abs_[0]["from_text"]
    rep = mr.check_book(abs_, _chapters("At midnight Mara teleported with a single anchor stone."), names=NAMES)
    assert rep["counts"]["broken"] == 1
    assert story_rules.lint(entry["rules"]) is not None  # the old checks still run on the same rules


# ====================================================================== the ledger and the check
def test_the_ledger_follows_the_stones_across_chapters():
    rep = mr.check_book([_ab()], _chapters(C1, C2), names=NAMES)
    ch1, ch2 = rep["chapters"]
    assert ch1["uses"][0]["who"] == "Mara Vell" and ch1["uses"][0]["paid"] == ["two anchor stones"]
    assert ch1["state_after"] == {"Mara": {"anchor stone": 1}}  # 3 at the start, 2 used
    assert ch2["gains"] == [{"who": "Mara Vell", "item": "anchor stone", "qty": 1, "change": "gained"}]
    assert len(ch2["uses"]) == 1 and ch2["uses"][0]["who"] == "Mara Vell"  # Tom's line is dialogue, not a use
    assert ch2["state_after"] == {"Mara": {"anchor stone": 0}}  # 1 + 1 found - 2 used
    assert rep["counts"] == {"uses": 2, "broken": 0, "deliberate": 0, "minor": 0}
    assert mr.summary_line(rep["counts"]) == "✨ Magic rules kept: 2 use(s), 0 broken"
    assert mr.state_lines(rep["state"]) == ["Mara has no anchor stones."]


def test_teleporting_with_one_stone_when_the_rule_needs_two_is_caught():
    rep = mr.check_book([_ab()], _chapters(C1, C2, C3), names=NAMES)
    p = [x for x in rep["problems"] if x["severity"] == "major"]
    assert len(p) == 1 and p[0]["code"] == "needs_more" and p[0]["number"] == 3
    assert p[0]["message"] == "Mara Vell uses Teleportation in chapter 3 with only one anchor stone; the rule needs 2."
    assert "only one anchor stone" in p[0]["quote"]
    assert not rep["chapters"][2]["uses"][0]["ok"] and rep["counts"]["broken"] == 1


def test_an_empty_ledger_is_caught_too():
    rep = mr.check_book([_ab(start="Mara: 2 anchor stones")], _chapters(
        "At night Mara teleported to the reef; her nose bled.",
        "That night Mara teleported back across the bay, her nose bleeding."), names=NAMES)
    p = [x for x in rep["problems"] if x["severity"] == "major"]
    assert [x["code"] for x in p] == ["not_enough"] and "has only no anchor stones" not in p[0]["message"]
    assert "chapter 2" in p[0]["message"] and "left by the ledger" in p[0]["message"]


def test_time_uses_per_day_cooldown_and_who_may_use_it():
    a = _ab(start="Mara: 20 anchor stones")
    day = mr.check_book([a], _chapters("At noon, under the sun, Mara teleported to the quay with two anchor stones, "
                                       "her nose bleeding."), names=NAMES)
    assert [x["code"] for x in day["problems"]] == ["wrong_time"]
    many = " ".join(f"That night Mara teleported again to cove {i}. Her nose bled. * The tide ran." for i in range(4))
    rep = mr.check_book([a], _chapters(many), names=NAMES)
    assert "too_many" in [x["code"] for x in rep["problems"]]
    who = mr.check_book([a], _chapters("At night Tom Reed teleported with two anchor stones; his nose bled."),
                        names=NAMES)
    assert [x["code"] for x in who["problems"]] == ["not_allowed"]
    assert who["problems"][0]["message"] == "Tom Reed uses Teleportation in chapter 1; the rule says only Mara can."
    cool = mr.check_book([a], _chapters("At night Mara teleported to the rock, nose bleeding. She gasped. Mara "
                                        "teleported again to the boat, her nose bleeding."), names=NAMES)
    assert "cooldown" in [x["code"] for x in cool["problems"]]
    later = mr.check_book([a], _chapters("At night Mara teleported to the rock, nose bleeding. Two hours later, "
                                         "Mara teleported again to the boat, her nose bleeding."), names=NAMES)
    assert "cooldown" not in [x["code"] for x in later["problems"]]


def test_talk_of_magic_is_not_a_use_and_the_price_is_noted():
    rep = mr.check_book([_ab()], _chapters("Mara could not teleport without her stones. \"Teleport!\" Tom shouted. "
                                           "She wanted to teleport."), names=NAMES)
    assert rep["counts"]["uses"] == 0
    rep = mr.check_book([_ab()], _chapters("At night Mara teleported with two anchor stones."), names=NAMES)
    assert [(x["code"], x["severity"]) for x in rep["problems"]] == [("price_missing", "minor")]
    assert rep["counts"]["broken"] == 0 and rep["counts"]["minor"] == 1


def test_a_deliberate_twist_in_the_plan_or_by_the_author_is_allowed():
    plans = {"ch3": "Mara breaks the rule: a deliberate twist — she teleports with one stone and pays dearly."}
    rep = mr.check_book([_ab()], _chapters(C1, C2, C3), names=NAMES, plans=plans)
    p = [x for x in rep["problems"] if x["severity"] == "major"]
    assert p and p[0]["allowed"] and rep["counts"] == {"uses": 3, "broken": 0, "deliberate": 1, "minor": 0}
    assert rep["chapters"][2]["uses"][0]["ok"] and rep["chapters"][2]["uses"][0]["deliberate"]
    assert "deliberate" in mr.summary_line(rep["counts"])
    # a twist in ANOTHER chapter's plan, or one that does not name the ability, allows nothing
    other = mr.check_book([_ab()], _chapters(C1, C2, C3), names=NAMES, plans={"ch2": plans["ch3"],
                                                                                "ch3": "A deliberate twist."})
    assert other["counts"]["broken"] == 1
    author = mr.check_book([_ab()], _chapters(C1, C2, C3), names=NAMES,
                           allowed=[{"chapter": 3, "ability": "Teleportation", "why": "the stones were fake"}])
    assert author["counts"]["broken"] == 0 and author["problems"][0]["allowed"] == "the stones were fake"


def test_the_trackers_reading_is_used_when_it_matches_the_text():
    tracked = {"ch1": {"version": 1, "uses": [{"who": "Mara", "ability": "Teleportation", "cost_paid": "one anchor "
                                                "stone", "where": "the reef", "quote": "At night she vanished."}],
                       "gains": [{"who": "Mara", "what": "2 anchor stones", "change": "gained"}]}}
    rep = mr.check_book([_ab()], _chapters("Text the AI read."), names=NAMES, tracked=tracked)
    assert rep["chapters"][0]["source"] == "ai" and rep["counts"]["broken"] == 1
    assert rep["chapters"][0]["state_after"] == {"Mara": {"anchor stone": 3}}  # 3 + 2 gained - 2 used
    stale = mr.check_book([_ab()], _chapters("Text the AI read."), names=NAMES,
                          tracked={"ch1": dict(tracked["ch1"], version=0)})
    assert stale["chapters"][0]["source"] == "akowe" and stale["counts"]["uses"] == 0


def test_a_broken_rule_becomes_a_major_editor_note():
    flags = [{"name": "magic", "message": "Not enough: Mara uses Teleportation with one stone.",
              "quote": "At midnight Mara teleported again with only one anchor stone, and her nose bled."}]
    out = mr.magic_findings([], flags, C3)
    assert out[0]["severity"] == "major" and out[0]["source"] == "akowe_magic" and out[0]["dimension"] == "story_rules"
    minor = [{"passage": "only one anchor stone", "severity": "minor", "dimension": "story_rules"}]
    assert mr.magic_findings(minor, flags, C3)[0]["severity"] == "major"
    assert mr.magic_findings([], flags, "other text") == []  # a quote not in the chapter is not invented


# ====================================================================== the book (store, routes, run)
def test_rules_page_settings_and_the_brief(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    pid, store = "p-magic", app.store  # companion settings only: no book records are needed
    story_rules.save(store, pid, "main", story_rules.clean_rules([{"category": "hard_rule",
                                                                   "text": "Teleportation needs anchor stones.",
                                                                   "magic": TELEPORT}]), by="author")
    part = mr.brief_part(store, pid, "main", 1, ["Mara teleports to the reef."])
    assert part["abilities"][0]["name"] == "Teleportation" and part["abilities"][0]["exceptions"] == "none"
    assert part["ledger"] == ["Mara has three anchor stones."]
    assert mr.brief_part(store, pid, "main", 1, ["Mara walks home."]) is None  # not in this chapter's plan
    assert len(str(part)) < mr.BRIEF_BUDGET
    from akowe import continuity  # noqa: PLC0415 - ✨ the tracker's one call also lists the ability uses
    ctx: dict = {}
    task, schema = mr.track_ask(store, pid, "main", ctx, continuity.TRACK_TASK, continuity.TRACK_SCHEMA)
    assert "ability_uses" in schema["properties"] and "ability_uses" not in schema["required"]
    assert "ability_uses" in task and ctx["abilities"][0]["name"] == "Teleportation"
    assert "ability_uses" not in continuity.TRACK_SCHEMA["properties"]  # the shared schema is not changed
    assert mr.save_tracked(store, pid, "main", "ch1", 2, {"ability_uses": [{"who": "Mara", "ability": "Teleportation",
                                                                           "cost_paid": "2 anchor stones", "where": "",
                                                                           "quote": "She vanished."}]}) == 1
    assert mr.get_entry(store, pid, "main")["tracked"]["ch1"]["version"] == 2
    e = mr.save_settings(store, pid, "main", {"allowed_breaks": [{"chapter": 3, "ability": "Teleportation",
                                                                  "why": "fake stones"}]})
    assert e["allowed_breaks"][0]["chapter"] == 3 and e["enabled"] is True
    mr.save_settings(store, pid, "main", {"enabled": False})
    assert mr.brief_part(store, pid, "main", 1, ["Mara teleports."]) is None  # switched off
    with pytest.raises(AkoweError):
        mr.save_settings(store, pid, "main", {"allowed_breaks": [{"chapter": "three"}]})


MAGIC_RULES = {"rules": [
    {"id": "", "category": "hard_rule", "text": "Teleportation carries the user to a place she can see.",
     "scope": "only at night; costs two anchor stones and a nosebleed; never more than three times a day",
     "source": "the premise", "stated_by": "the canon",
     "magic": dict(TELEPORT, who="Mara Vell", start="Mara Vell: 3 anchor stones")}], "notes": []}


def test_a_fake_ai_run_checks_the_magic_rules(tmp_path):
    fake = SlotFake()
    fake.rules_script = [MAGIC_RULES] * 8
    fake.chapter_texts = {
        "ch1": "That night Mara Vell crushed two anchor stones and teleported to the reef. Her nose bled.",
        "ch2": "At midnight Mara teleported back to the lighthouse with only one anchor stone, and her nose bled.",
        "ch3": "The lamp blazed. Mara slept, and nobody used any magic at all."}
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    entry = story_rules.get_entry(app.store, pid, "main")
    assert any((r.get("magic") or {}).get("name") == "Teleportation" for r in story_rules.active(entry))
    sent = [c for c in fake.craft_contexts if "only one anchor stone" in str(c.get("chapter_text") or "")]
    assert sent and any(f.get("name") == "magic" and "the rule needs 2" in f["message"]
                        for f in sent[0].get("akowe_in_chapter") or [])
    assert sent[0].get("magic_rules", {}).get("abilities")
    crafts = app.review.editor.crafts(pid, "main")
    assert any(f.get("source") == "akowe_magic" and f["severity"] == "major" for c in crafts.values()
               for f in c.get("findings") or [])
    briefs = [c.get("writing_brief") for _k, rows in fake.prompts.items() for _t, c in rows
              if isinstance(c, dict) and isinstance(c.get("writing_brief"), dict)]
    later = [b["magic_rules"] for b in briefs if (b.get("magic_rules") or {}).get("abilities")]
    assert later and later[0]["abilities"][0]["needs"][0] == "2 anchor stones"  # used before: the next brief has it
    assert any("Mara Vell has one anchor stone." in b.get("ledger", []) for b in later)
    rep = mr.report_part(app.engine, "author", pid, "main")
    assert rep["line"].startswith("✨ Magic rules kept: 2 use(s), 1 broken")
    status, page = mr.route(app, "GET", [], None, "author", pid, "main")
    assert status == 200 and page["abilities"][0]["name"] == "Teleportation" and page["problems"]
    assert mr.get_entry(app.store, pid, "main").get("snapshot", {}).get("chapters")
