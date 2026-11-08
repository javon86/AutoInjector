"""🤖 Claude Code helpers, Step 2, unit level: the new settings, each new job's schema, its cleaning of malformed or
risky answers (guards: exact quotes, names, numbers, locked details, the story map), the side-by-side Book Bible fill
(dependency order, a failing section, the fallback), the specialists' "only where useful" rules, the variety block and
the measures. The fake `claude` (tests/fake_claude) stands in for the real CLI."""
from __future__ import annotations

import pytest

from akowe import claude_code as cc
from akowe import claude_code_jobs as jobs
from akowe import claude_code_speed as speed
from akowe import scenes, whole_bible
from akowe.errors import AkoweError

from cc_fake import MemStore, install

TEXT = ("Mara climbed the lighthouse stairs in 1871 with a nice lamp. The lamp room was cold and Tom Reed's logbook "
        "lay open. “I am angry with you, Tom,” Mara said. “I know you are angry, and I understand why,” Tom said. "
        "She felt afraid. She was so afraid of the dark. The house was nice.")


# ============================================================================================ settings
def test_new_jobs_and_specialists_have_sensible_defaults_and_are_checked():
    store = MemStore()
    st = cc.settings(store)
    for j in ("prepare", "bible", "extras", "specialists", "variety", "style", "specifics"):
        assert st["jobs"][j] is True and j in cc.JOB_WORDS
    assert st["specialists"] == {"dialogue": True, "pacing": False, "sensory": True, "subtext": True}
    for bad in ({"specialists": {"poetry": True}}, {"specialists": {"pacing": "yes"}}, {"specialists": []},
                {"jobs": {"prepare": 1}}):
        with pytest.raises(AkoweError):
            cc.save_settings(store, bad)
    out = cc.save_settings(store, {"specialists": {"pacing": True}, "jobs": {"bible": False}})
    assert out["specialists"]["pacing"] is True and out["specialists"]["dialogue"] is True
    assert cc.settings(store)["jobs"]["bible"] is False
    assert set(cc.public(store)["specialist_words"]) == set(cc.SPECIALISTS)


# ============================================================================================ 5. prepare
def test_prepare_uses_the_planner_schema_and_cleans_the_cards(tmp_path, monkeypatch):
    install(tmp_path, monkeypatch)
    store = MemStore()
    out, res = jobs.prepare(store, "plan", {"chapter": {"number": 2}, "characters": [{"name": "Mara"}]})
    assert len(out["cards"]) == 2 and out["cards"][0]["characters"] == ["Mara"]
    assert out["cards"][0]["obstacle_source"] == "weather" and isinstance(out["needs_raw"], dict)
    assert res["seconds"] >= 0


@pytest.mark.parametrize("mode", ["malformed", "crash", "logged_out"])
def test_a_bad_prepare_answer_falls_back(tmp_path, monkeypatch, mode):
    install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE_PREPARE=mode)
    with pytest.raises(cc.CCError):
        jobs.prepare(MemStore(), "plan", {"chapter": {"number": 2}, "characters": []})


def test_prepare_with_no_usable_scene_is_refused(monkeypatch):
    monkeypatch.setattr(cc, "run_job", lambda *a, **k: {"data": {"scenes": [{"place": "", "goals": []}]}, "seconds": 1})
    with pytest.raises(cc.CCError):
        jobs.prepare(MemStore(), "plan", {})


# ============================================================================================ 6. variety
def test_variety_keeps_only_real_chapters_and_needs_advice():
    raw = {"opening": {"repeats": True, "chapters": [1, 3, 99, True, "2"], "advice": "Open on the lens."},
           "closing": {"repeats": True, "chapters": [2], "advice": ""}}
    out = jobs.clean_variety(raw, [1, 2, 3])
    assert out["opening"] == {"repeats": True, "chapters": [1, 3], "advice": "Open on the lens."}
    assert out["closing"] == {"repeats": False, "chapters": [], "advice": ""}  # a repeat with nothing to say
    assert jobs.clean_variety("garbage", [1])["opening"]["repeats"] is False


def test_variety_job_through_the_fake(tmp_path, monkeypatch):
    install(tmp_path, monkeypatch)
    used = [{"chapter": 1, "opens": "weather", "ends": "dialogue", "first": "Rain fell.", "last": "“Go.”"}]
    out, _res = jobs.variety(MemStore(), used, {"first_scene": {"place": "lamp room"}})
    assert out["opening"]["repeats"] and out["opening"]["chapters"] == [1] and "lens" in out["opening"]["advice"]


def test_the_brief_variety_block_lists_shapes_and_gives_advice_only_for_a_used_plan():
    store = MemStore()
    row = {"used_so_far": [{"chapter": 1, "opens": "weather", "ends": "dialogue", "scenes": 3},
                           {"chapter": 2, "opens": "other", "ends": "moral", "scenes": None}],
           "variety": {"opening": {"repeats": True, "chapters": [1], "advice": "Open on the lens."},
                       "closing": {"repeats": False, "chapters": [], "advice": ""}}, "status": "ready"}
    speed._prep_put(store, "p", "main", "ch3", row)  # noqa: SLF001
    b = speed.brief_variety(store, "p", "main", "ch3")
    assert b["so_far"] == ["chapter 1: opens on weather, ends on dialogue, 3 scenes",
                           "chapter 2: opens on other, ends on moral"] and "advice" not in b
    speed._prep_put(store, "p", "main", "ch3", status="used")  # noqa: SLF001
    assert speed.brief_variety(store, "p", "main", "ch3")["advice"] == ["Opening: Open on the lens."]
    assert speed.brief_variety(store, "p", "main", "nothing") is None


def test_add_to_brief_adds_the_variety_block_and_its_rule():
    from akowe import claude_code_book as ccb
    store = MemStore()
    speed._prep_put(store, "p", "main", "ch2", {"used_so_far": [{"chapter": 1, "opens": "weather",  # noqa: SLF001
                                                                 "ends": "sleep"}], "status": "used"})
    out = ccb.add_to_brief(store, "p", "main", "ch2", {"rules": ["r"]})
    assert out["variety"]["so_far"] and speed.VARIETY_RULE in out["rules"]
    same = {"rules": ["r"]}
    assert ccb.add_to_brief(store, "p", "main", "other", same) is same  # nothing to add: the brief is unchanged


# ============================================================================================ 7. specialists
def test_specialist_problems_are_labelled_and_need_a_real_quote():
    texts = {"c1": TEXT}
    raw = {"problems": [{"chapter": 1, "quote": "She felt afraid.", "problem": "names the fear it showed"},
                        {"chapter": 1, "quote": "Words that are not there.", "problem": "invented"},
                        {"chapter": 7, "quote": "She felt afraid.", "problem": "wrong chapter"},
                        {"chapter": 1, "quote": "She felt afraid.", "problem": "", "severity": "major"},
                        "junk"]}
    out = jobs.clean_specialist(raw, "subtext", {1: "c1"}, texts)
    assert len(out) == 1 and out[0]["problem"].startswith("Subtext: ") and out[0]["severity"] == "minor"
    assert out[0]["kind"] == "subtext" and out[0]["chapter_id"] == "c1"
    d = jobs.clean_specialist({"problems": [{"chapter": 1, "quote": "“I am angry with you, Tom,”",
                                             "problem": "too plain", "severity": "major"}]},
                              "dialogue", {1: "c1"}, texts, who="Mara")
    assert d[0]["problem"].startswith("Dialogue voice — Mara: ") and d[0]["severity"] == "major"


@pytest.mark.parametrize("kind", ["dialogue", "pacing", "sensory", "subtext"])
def test_each_specialist_job_runs_through_the_fake(tmp_path, monkeypatch, kind):
    install(tmp_path, monkeypatch, FAKE_CLAUDE_SPECIALIST="1")
    raw, _res = jobs.specialist(MemStore(), kind, {"chapter": 1, "chapter_text": TEXT})
    out = jobs.clean_specialist(raw, kind, {1: "c1"}, {"c1": TEXT})
    assert out and out[0]["kind"] == kind


def test_specialists_run_only_where_useful():
    assert speed.named_feelings(TEXT) >= speed.SUBTEXT_MIN
    assert speed.named_feelings("The tide came in. Mara counted the boats.") == 0
    rich = " ".join(["The brass lamp hissed and the damp wool smelled of salt and smoke."] * 5)
    assert speed.sense_rate(rich) > speed.SENSORY_MIN > speed.sense_rate("He went there and did it and then left.")


def test_specialists_never_run_when_claude_wrote_the_chapter(monkeypatch):
    """The writer-can't-review rule: Claude Code is Claude, so _Checks never asks the specialists then."""
    from akowe import claude_code_book as ccb
    asked = []
    monkeypatch.setattr(speed, "specialist_futures", lambda *a, **k: asked.append(1) or {})
    monkeypatch.setattr(ccb, "writer_is_claude", lambda *a, **k: True)
    monkeypatch.setattr(ccb, "_settings", lambda svc: {"jobs": {j: True for j in cc.JOBS}})
    monkeypatch.setattr(ccb, "_facts_future", lambda *a, **k: None)
    monkeypatch.setattr(ccb, "_family", lambda svc, sid: None)

    class Svc:
        store = MemStore()
    ccb._Checks(Svc(), {"id": "r", "project_id": "p"}, {"kind": "chapter", "id": "cp"},  # noqa: SLF001
                {"chapter_ids": ["c1"]}, {}, ["AI-2"], {"c1": {"text": TEXT}}, ["c1"])
    assert asked == []
    monkeypatch.setattr(ccb, "writer_is_claude", lambda *a, **k: False)
    monkeypatch.setattr(ccb._Checks, "_check_future", lambda self, kind, ctx: None)  # noqa: SLF001
    ccb._Checks(Svc(), {"id": "r", "project_id": "p"}, {"kind": "chapter", "id": "cp"},  # noqa: SLF001
                {"chapter_ids": ["c1"]}, {}, ["AI-2"], {"c1": {"text": TEXT}}, ["c1"])
    assert asked == [1]


# ============================================================================================ 8. style, 9. specifics
def test_style_drift_numbers():
    card = {"avg_sentence": 9.0, "dialogue_share": 0.4, "person": "first", "tense": "past", "variety": 0.5}
    mine = {"avg_sentence": 18.0, "dialogue_share": 0.35, "person": "third", "tense": "past", "variety": 0.2}
    got = {d["what"] for d in jobs.style_drift(card, mine)}
    assert got == {"avg_sentence", "person", "variety"}


def test_style_match_returns_guarded_lines_and_the_drift(tmp_path, monkeypatch):
    install(tmp_path, monkeypatch)
    card = {"numbers": {"avg_sentence": 30.0, "person": "first"}, "voice_summary": "long, warm sentences"}
    out, _res = jobs.match_style(MemStore(), TEXT, card)
    assert out["lines"] and all(ln["quote"] in TEXT and TEXT.count(ln["quote"]) == 1 for ln in out["lines"])
    assert {d["what"] for d in out["drift"]} >= {"avg_sentence"}
    # the guards: a line whose rewrite loses a locked detail, a number or a name is dropped
    lines = [{"quote": "The house was nice.", "problem": "drift", "rewrite": "The house was a ruin."},
             {"quote": "The lamp room was cold and Tom Reed's logbook lay open.", "problem": "drift",
              "rewrite": "The lamp room was cold, the logbook open."},  # loses the name
             {"quote": "Mara climbed the lighthouse stairs in 1871 with a nice lamp.", "problem": "drift",
              "rewrite": "Mara climbed the stairs in 1871, lamp in hand."}]  # loses the locked "nice lamp"
    monkeypatch.setattr(cc, "run_job", lambda *a, **k: {"data": {"lines": lines}, "seconds": 1})
    out2, _r = jobs.match_style(MemStore(), TEXT, card, keep_exactly=["Mara: lamp: nice lamp"])
    assert [ln["quote"] for ln in out2["lines"]] == ["The house was nice."]


def test_specifics_types_and_guards(monkeypatch):
    lines = [{"quote": "The house was nice.", "type": "generic_detail", "problem": "generic",
              "rewrite": "The house leaned on its salt-grey pilings."},
             {"quote": "“I know you are angry, and I understand why,” Tom said.", "type": "tidy_dialogue",
              "problem": "too tidy", "rewrite": "“Angry. Right. Pass the oil,” Tom said."},
             {"quote": "Mara climbed the lighthouse stairs in 1871 with a nice lamp.", "type": "generic_detail",
              "problem": "generic", "rewrite": "Mara climbed the stairs with a brass lamp."},  # loses 1871
             {"quote": "The lamp room was cold and Tom Reed's logbook lay open.", "type": "poetry",
              "problem": "?", "rewrite": "The lamp room was cold."},  # an unknown type
             {"quote": "Not in the chapter.", "type": "generic_detail", "problem": "x", "rewrite": "y"}]
    monkeypatch.setattr(cc, "run_job", lambda *a, **k: {"data": {"lines": lines}, "seconds": 1})
    out, _res = jobs.specifics(MemStore(), TEXT)
    assert [(o["type"], o["quote"][:9]) for o in out] == [("generic_detail", "The house"), ("tidy_dialogue", "“I know y")]
    monkeypatch.setattr(cc, "run_job", lambda *a, **k: {"data": {"lines": lines[:1]}, "seconds": 1})
    assert jobs.specifics(MemStore(), TEXT, keep_exactly=["House: look: was nice"])[0] == []


def test_story_map_passages_are_never_proposed():
    items = [{"quote": "The house was nice."}, {"quote": "She felt afraid."}]
    assert speed._off_the_map(items, ["She felt afraid. She was so afraid"]) == [items[0]]  # noqa: SLF001


# ============================================================================================ 10. the Book Bible
def _units():
    return [{"ref": "character:mara", "kind": "character", "store": "forge", "rid": "mara", "name": "Mara",
             "keys": ["eyes", "hair"], "labels": {"eyes": "Eyes", "hair": "Hair"}, "known": {}},
            {"ref": "place:tower", "kind": "place", "store": "kinds", "rid": "tower", "name": "Tower",
             "keys": ["layout"], "labels": {"layout": "Layout"}, "known": {}},
            {"ref": "bible:character:mara", "kind": "character", "store": "bible", "target": "character:mara",
             "name": "Mara", "keys": ["bf_speed", "rel_tom"], "labels": {"bf_speed": "Speed",
                                                                         "rel_tom": "Relationship type with Tom"},
             "rels": [("rel_tom", "rel:mara:tom", "Tom")], "known": {}}]


class FakeHelper:
    def __init__(self, fail=()):
        self.fail, self.waves, self.answered = set(fail), [], []

    def start(self, wave, build):
        self.cur = [build(parts) for parts in wave]
        self.waves.append([[(p["ref"], tuple(p["keys"])) for p in parts] for parts in wave])

    def result(self, i):
        _task, schema, ctx = self.cur[i]
        names = {s["name"] for s in ctx["subjects"]}
        if names & self.fail:
            return None
        self.answered.append(names)
        return {k: ("ally" if k.endswith("rel_tom") else "grey") for k in schema["required"]}, "claude-code"

    def wave_done(self, web_s):
        self.web_s = web_s


def _fill(monkeypatch, helper, asks: list, accepted: list):
    first = {"done": False}

    def units(app, pid, branch, *, ensure=True, skip=None):
        if first["done"]:
            return [], {}
        first["done"] = True
        return [dict(u) for u in _units()], {"made_dossiers": 0, "kept": 0}
    monkeypatch.setattr(whole_bible, "units", units)
    monkeypatch.setattr(whole_bible, "base_context", lambda app, pid, branch: {"book_profile": {}})
    monkeypatch.setattr(whole_bible, "summary", lambda app, pid, branch, res: {"message": "ok"})

    def accept(app, pid, branch, u, answer, slot, *, by):
        accepted.append((u["ref"], tuple(sorted(answer)), slot))
        return list(answer)
    monkeypatch.setattr(whole_bible, "accept", accept)

    def ask(task, sch, ctx):
        asks.append({s["name"] for s in ctx["subjects"]})
        return {k: ("ally" if k.endswith("rel_tom") else "web") for k in sch["required"]}, "AI-2"
    return whole_bible.fill(None, "p", "main", ask=ask, check=lambda: None, progress=lambda *a: None, by="run:x",
                            helper=helper)


def test_bible_side_by_side_relationships_wait_for_the_characters(monkeypatch):
    asks, accepted = [], []
    h = FakeHelper()
    res = _fill(monkeypatch, h, asks, accepted)
    assert len(h.waves) == 2  # first every record's own sections, then the relationship types
    assert all(not any(k.startswith("rel_") for _r, ks in parts for k in ks) for parts in h.waves[0])
    assert [k for parts in h.waves[1] for _r, ks in parts for k in ks] == ["rel_tom"]
    assert asks == []  # every batch answered by the helpers
    assert accepted[-1] == ("bible:character:mara", ("rel_tom",), "claude-code")  # accepted after the rest
    assert {r for r, _k, _s in accepted} == {"character:mara", "place:tower", "bible:character:mara"}
    assert res["done_calls"] == res["calls"] == 2


def test_bible_a_failing_section_is_asked_of_the_web_ai(monkeypatch):
    asks, accepted = [], []
    res = _fill(monkeypatch, FakeHelper(fail={"Tower"}), asks, accepted)
    assert {"Tower"} <= set().union(*asks) and not res["failed"]
    assert any(r == "place:tower" and s == "AI-2" for r, _k, s in accepted)


def test_bible_without_helpers_is_one_after_another_as_before(monkeypatch):
    asks, accepted = [], []
    res = _fill(monkeypatch, None, asks, accepted)
    assert res["calls"] == 1 and len(asks) == 1  # the old single batch, relationships in it
    assert all(s == "AI-2" for _r, _k, s in accepted)


def test_bible_fill_job_validates_the_answer_shape(tmp_path, monkeypatch):
    install(tmp_path, monkeypatch)
    sch = {"type": "object", "required": ["s1__eyes"], "properties": {"s1__eyes": {"type": "string"}}}
    ctx = {"subjects": [{"ref": "s1", "name": "Mara", "fields": {"s1__eyes": "Eyes"}}]}
    raw, _res = jobs.bible_fill(MemStore(), "fill", sch, ctx)
    assert raw == {"s1__eyes": "4 — weathered brass and salt-stained wool"}
    install(tmp_path, monkeypatch, FAKE_CLAUDE_MODE_BIBLE_FILL="malformed")
    with pytest.raises(cc.CCError):
        jobs.bible_fill(MemStore(), "fill", sch, ctx)


# ============================================================================================ the measures
def test_speed_lines_and_saved_time():
    s = {"prepare": {"used": 2, "stale": 1, "saved_s": 130.0}, "bible": {"calls": 6, "helped": 5, "fell_back": 1,
                                                                        "wall_s": 60.0, "one_by_one_s": 240.0},
         "extras": {"pictures_s": 300.0, "launch_kit_s": 60.0, "background": 2}, "specialists": {"jobs": 4}}
    lines = speed.speed_lines(s)
    assert lines[0].startswith("next chapter ready early: 2 chapter(s)") and "2.2 min" in lines[0] and "1 prepared" in lines[0]
    assert "60 s instead of about 4.0 min" in lines[1] and "1 by the web AIs" in lines[1]
    assert "6.0 min" in lines[2] and lines[3] == "4 specialist review(s)"
    assert speed.saved_s(s) == 130 + 180 + 360
    assert speed.speed_lines(None) == [] and speed.saved_s({}) == 0.0


def test_the_planner_fingerprint_changes_with_any_fact():
    a = {"chapter": {"number": 2}, "earlier_chapters": [{"chapter": 1, "what_happened": "Mara finds the key."}]}
    b = {"earlier_chapters": [{"chapter": 1, "what_happened": "Mara finds the key."}], "chapter": {"number": 2}}
    c = {"chapter": {"number": 2}, "earlier_chapters": [{"chapter": 1, "what_happened": "Mara loses the key."}]}
    assert speed.fingerprint(a) == speed.fingerprint(b) != speed.fingerprint(c)


def test_planned_opening_and_closing_come_from_the_first_and_last_scene():
    cards = scenes.clean_cards({"scenes": [{"place": "quay", "beat": "arrive"}, {"place": "tower", "change": "lost"}]})
    p = speed._planned(cards)  # noqa: SLF001
    assert p["scenes"] == 2 and p["first_scene"]["place"] == "quay" and p["last_scene"]["change"] == "lost"
