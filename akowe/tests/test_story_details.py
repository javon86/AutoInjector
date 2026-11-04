"""⏱ Story details just in time (story_details.py) and 🧑 ⚖ 🗺 "How the story treats the characters"
(character_mode.py), end to end with the fake AI."""
from __future__ import annotations

import time
import types

import pytest

from akowe import binder_fields, character_mode, forge, forge_kinds, providers as prov_mod, story_choices
from akowe import story_details
from akowe.book_path import get_profile
from akowe.errors import AkoweError

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book, steps


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def done(run):
    assert run["status"] == "done", (run["phase"], [(s["id"], s["state"], s.get("problem")) for s in run["steps"]])
    return run


def details_calls(fake):
    return [p for p in fake.prompts.get("details", [])]


def dossier_texts(app, pid, rid):
    d = forge.public(app.store, pid, "main", rid)
    return {f["key"]: f for s in d["sections"] for f in s["fields"]}


def chars(app, pid):
    from akowe import characters as chars_mod
    return {c["name"]: c for c in chars_mod.canon_characters(app.store, pid, "main")}


def events(app, run, kind=None, code=None):
    run = app.autobook.get(run["id"])
    return [e for e in run["events"] if (kind is None or e["kind"] == kind) and (code is None or e.get("code") == code)]


# ---------------------------------------------------------------------------------------------- 1. essentials
def test_essentials_fill_looks_and_voice_for_all_and_extras_only_for_story_roles(tmp_path):
    fake = BookFakeAI()
    fake.role_override = {"Nessa Crane": "extra"}
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"genre": "Mystery", "length": "novelette"}))
    pid = run["project_id"]
    st = steps(run)
    assert st["looks"]["state"] == "done" and STEP_ORDER_OK(run)
    cs = chars(app, pid)
    assert len(cs) >= 3
    for name, c in cs.items():
        f = dossier_texts(app, pid, c["record_id"])
        assert f["physique"]["text"] and f["hair"]["text"] and f["clothing"]["text"], name
        assert f["physique"]["status"] == "approved"
        vals = binder_fields.values(app.store, pid, "main", f"character:{c['record_id']}")
        if name == "Nessa Crane":  # an extra: only the short looks set
            assert not f["eyes"]["text"] and not f["speech_anger"]["text"] and not f["public_private"]["text"]
            assert vals["height"]["value"] is None and vals["handedness"]["value"] is None
        else:
            assert f["eyes"]["text"] == "storm-grey eyes" and f["presence"]["text"]
            assert f["speech_anger"]["text"] and f["speech_grief"]["text"] and f["public_private"]["text"]
            assert vals["height"]["value"] == "1.68 m (5 ft 6 in)" and vals["height"]["status"] == "approved"
            assert vals["handedness"]["value"] == "left" and vals["build"]["value"] == "lean"
    # the voice card got the speech detail (approved fields are written through)
    from akowe import characters as chars_mod
    voice = chars_mod.get_entry(app.store, pid, "main", cs["Mara Vell"]["record_id"])["voice"]
    assert "Anger:" in voice["under_pressure"]
    # batched: a few subjects per call, each logged in plain words
    ess = [c for c in details_calls(fake) if "chapter" not in c[1]]
    assert 1 <= len(ess) <= (len(cs) + 6) // story_details.BATCH + 2
    assert any("Decided the looks and voice details of “Mara Vell”" in e["message"] for e in events(app, run, "details"))
    # 🖼 the pictures are made from the detailed looks
    prompt = forge.art_prompt(forge.public(app.store, pid, "main", cs["Mara Vell"]["record_id"]), "portrait")
    assert "storm-grey eyes" in prompt and "1.68 m" in prompt and "oilskin coat" in prompt
    # places the outline uses got a short look and feel (only the essentials, no layout yet)
    places = forge_kinds.list_dossiers(app.store, pid, "main", "place")
    assert places
    led = story_details.ledger(app.store, pid, "main")
    for p in places:
        f = {x["key"]: x for s in forge_kinds.public(app.store, pid, "main", "place", p["record_id"])["sections"]
             for x in s["fields"]}
        if f"place:{p['record_id']}" in led["essentials"]:
            assert f["one_line"]["text"] and f["mood"]["text"]
    # nothing the story never needed was filled: no fighting, powers or a spell list
    for c in cs.values():
        f = dossier_texts(app, pid, c["record_id"])
        assert not f["primary_style"]["text"] and not f["power_source"]["text"] and not f["practical_skills"]["text"]
    assert not forge_kinds.list_dossiers(app.store, pid, "main", "magic")  # a book without magic never fills magic


def STEP_ORDER_OK(run):
    ids = [s["id"] for s in run["steps"]]
    return ids.index("characters") < ids.index("looks") < ids.index("pictures")


def test_essentials_never_overwrite_the_authors_text_and_resume_does_not_refill(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    gate_after = {"n": 0}
    real = story_details._accept

    def stop_after_first(svc, run, s, answer, slot, **kw):
        out = real(svc, run, s, answer, slot, **kw)
        gate_after["n"] += 1
        if gate_after["n"] == 1 and kw.get("how") == "essentials":
            app.autobook._ctl[run["id"]]["pause"] = True  # the author presses Pause right after the first batch
        return out
    story_details._accept = stop_after_first
    try:
        r = app.autobook.start("author", {"author_confirms": True, "length": "short_story"})
        app.autobook.wait_for(r["id"], 60)
    finally:
        story_details._accept = real
    run = app.autobook.public(app.autobook.get(r["id"]))
    assert run["status"] == "paused"
    pid = run["project_id"]
    cs = chars(app, pid)
    calls_before = len(details_calls(fake))
    # the author writes one look themselves meanwhile: it is never replaced
    tom = cs["Tom Reed"]["record_id"]
    forge.edit(app.store, pid, "main", tom, {"sections": {"appearance_detail": {"eyes": {"text": "pale blue eyes"}}}})
    filled_before = {n: {k: v["text"] for k, v in dossier_texts(app, pid, c["record_id"]).items()}
                     for n, c in cs.items()}
    app.autobook.resume("author", r["id"])
    app.autobook.wait_for(r["id"], 120)
    run = done(app.autobook.public(app.autobook.get(r["id"])))
    assert dossier_texts(app, pid, tom)["eyes"]["text"] == "pale blue eyes"
    # nothing decided before the pause was asked again
    asked = [k.split("__", 1)[1] for _t, ctx in details_calls(fake)[calls_before:] for s in ctx["subjects"]
             if s["name"] in filled_before for k in s["fields"]
             if filled_before[s["name"]].get(k.split("__", 1)[1])]
    assert asked == []


def test_ai_down_skips_with_an_event_and_fills_later(tmp_path):
    fake = BookFakeAI()
    fake.fail_kind("details", *[AkoweError("UPSTREAM_UNAVAILABLE", "/ai", "the AI is down") for _ in range(4)])
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"length": "short_story"}))
    assert events(app, run, code="DETAILS_LATER")
    pid = run["project_id"]
    # the next call (chapter one) asked again for what the essentials could not get, and the book was written
    for c in chars(app, pid).values():
        assert dossier_texts(app, pid, c["record_id"])["physique"]["text"]
    assert all(i["state"] == "done" for i in steps(run)["chapters"]["items"])


# ---------------------------------------------------------------------------------------------- 2. just in time
FIGHT_OBJECTIVES = ["Mara climbs to the dark lighthouse and finds the keeper's log",
                    "Mara fights the stranger in a duel on the reef",
                    "Mara and Tom fight the stranger again at the lamp"]


def test_a_fight_fills_fighting_once_and_a_later_fight_must_match(tmp_path):
    fake = BookFakeAI()
    fake.objectives = FIGHT_OBJECTIVES
    fake.chapter_texts["ch3"] = ("Mara drew her axe and swung it at the stranger. Tom shouted from the stairs.\n\n"
                                 "Mara looked at him with her blue eyes and said nothing.")
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"length": "short_story"}))
    pid = run["project_id"]
    mara = chars(app, pid)["Mara Vell"]["record_id"]
    f = dossier_texts(app, pid, mara)
    assert f["primary_style"]["text"] and f["primary_weapon"]["text"] == "a short curved sabre carried on the left hip"
    assert f["primary_weapon"]["status"] == "approved"
    # filled once: chapter 2 asked for it, chapter 3 (another fight) did not ask again
    asks = [(ctx.get("chapter") or {}).get("number") for _t, ctx in details_calls(fake)
            for s in ctx["subjects"] if s["name"] == "Mara Vell" and any("primary_weapon" in k for k in s["fields"])]
    assert asks == [2]
    assert any(e["message"] == "Decided Mara Vell's fighting style and weapon for chapter 2" for e in events(app, run))
    # 🔒 locked once chapter 2 relied on it; chapter 3 got it as a fixed detail
    led = story_details.ledger(app.store, pid, "main")
    assert led["locked"][f"character:{mara}"]["primary_weapon"]["chapter"] == "ch2"
    assert f["primary_weapon"]["protected"] is True
    # chapter 3 says "axe" and "blue eyes": both flagged
    bad = events(app, run, code="DETAIL_CONTRADICTION")
    msgs = " ".join(e["message"] for e in bad)
    assert "axe" in msgs and "sabre" in msgs and "blue eyes" in msgs and "Which is right?" in msgs
    # the continuity page lists them, and ✨ Fill from the book asks instead of proposing
    from akowe import continuity
    info = continuity.info(app.review, "author", pid, "main", app=app)
    assert any(x["code"] == "DETAIL_CONTRADICTION" and x["number"] == 3 for x in info["checks"]["dossier"])
    job = binder_fields.start_fill(app, "author", pid, "main", {"ai": False})
    from akowe.forge import wait
    j = wait(app, "author", job["job_id"] if "job_id" in job else job["id"])
    checks = [r for r in j["results"] if r.get("check")]
    assert checks and "the book says" in checks[0]["message"]


def test_no_magic_never_fills_powers_and_magic_fills_only_that_ability(tmp_path):
    fake = BookFakeAI()
    fake.objectives = ["Mara climbs to the dark lighthouse and finds the keeper's log",
                       "Mara casts the fog-spell to hide the boats",
                       "Mara casts the fog-spell again at the reef"]
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"length": "short_story"}))
    pid = run["project_id"]
    systems = forge_kinds.list_dossiers(app.store, pid, "main", "magic")
    assert len(systems) == 1
    f = {x["key"]: x for s in forge_kinds.public(app.store, pid, "main", "magic", systems[0]["record_id"])["sections"]
         for x in s["fields"]}
    assert f["named_power_1"]["text"].startswith("Fog-spell:")
    filled = [k for k, v in f.items() if v["text"] and v["status"] == "approved"]
    assert filled == ["named_power_1"]  # only that ability: no spell list, no other magic fields
    asks = [(ctx.get("chapter") or {}).get("number") for _t, ctx in details_calls(fake) for s in ctx["subjects"]
            if s["kind"] == "magic"]
    assert asks == [2]  # chapter 3 uses the same spell: not decided twice
    mara = chars(app, pid)["Mara Vell"]["record_id"]
    assert dossier_texts(app, pid, mara)["power_source"]["text"]
    # the book without magic (the default fake book) never has magic fields: see test 1


def test_a_new_room_is_filled_once_and_an_artifact_used_twice_is_filled_once(tmp_path):
    fake = BookFakeAI()
    fake.max_chapters = 12
    fake.objectives = ["Mara climbs to the dark lighthouse and finds the keeper's log",
                       "Mara questions the harbor and learns about the stranger",
                       "Mara turns the brass key in the lighthouse door",
                       "Mara walks the harbor wall",
                       "Mara asks Nessa about the stranger",
                       "Mara watches the reef",
                       "Mara waits for the storm",
                       "Mara turns the brass key once more to light the lamp"]

    def scenes(ctx):
        num = int((ctx.get("chapter") or {}).get("number") or 1)
        place = "the map room of the harbour tower" if num == 2 else "the lamp room of the old light"
        cast = ["Mara Vell"]
        return {"scenes": [{"place": place, "time": "dusk", "characters": cast,
                            "goals": [{"character": "Mara Vell", "goal": "Mara wants the log", "hidden_agenda": "x"}],
                            "obstacle": "the harbour board has sealed the lamp room", "obstacle_source": "institution",
                            "change": "Mara learns who signed the log", "unsaid": "Mara suspects her master",
                            "beat": str((ctx.get("chapter") or {}).get("objective") or "")[:120]}]}
    fake.scene_script = [scenes] * 40
    fake.chapter_texts["ch8"] = "Mara turned the iron key in the door. The lamp woke."
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"length": "novella"}))
    pid = run["project_id"]
    places = {p["name"]: p for p in forge_kinds.list_dossiers(app.store, pid, "main", "place")}
    room = next(p for n, p in places.items() if "map room" in n.lower())
    rf = {x["key"]: x for s in forge_kinds.public(app.store, pid, "main", "place", room["record_id"])["sections"]
          for x in s["fields"]}
    assert rf["layout"]["text"] and rf["sounds"]["text"] and rf["population"]["text"]
    room_asks = [(ctx.get("chapter") or {}).get("number") for _t, ctx in details_calls(fake) for s in ctx["subjects"]
                 if s["name"] == room["name"]]
    assert room_asks == [2]
    assert any(e["message"].startswith("Decided the Map room") or "Map room" in e["message"]
               for e in events(app, run, "details"))
    items = forge_kinds.list_dossiers(app.store, pid, "main", "item")
    key = next(i for i in items if "brass key" in i["name"].lower())
    kf = {x["key"]: x for s in forge_kinds.public(app.store, pid, "main", "item", key["record_id"])["sections"]
          for x in s["fields"]}
    assert kf["abilities"]["text"] and kf["limits"]["text"] and kf["condition"]["text"]
    used_asks = [(ctx.get("chapter") or {}).get("number") for _t, ctx in details_calls(fake) for s in ctx["subjects"]
                 if s["name"] == key["name"] and any("abilities" in k for k in s["fields"])]
    assert used_asks == [3]  # used in chapter 3 and 8: decided once
    led = story_details.ledger(app.store, pid, "main")
    assert led["locked"][f"item:{key['record_id']}"]["abilities"]["chapter"] == "ch3"
    assert kf["abilities"]["protected"] is True
    bad = [e["message"] for e in events(app, run, code="DETAIL_CONTRADICTION")]
    assert any("iron key" in m and "brass" in m for m in bad)


# ---------------------------------------------------------------------------------------------- 4. the setting
@pytest.mark.parametrize("mode", ["character_led", "balanced", "plot_led"])
def test_the_setting_reaches_the_planner_the_brief_and_the_reviewers(tmp_path, mode):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"length": "short_story", "choices": {"characters": mode}}))
    pid = run["project_id"]
    assert get_profile(app.store, pid)["choices"]["characters"] == mode
    assert character_mode.of_store(app.store, pid) == mode
    words = character_mode.AI_WORDS[mode]
    for op in ("B01", "B03", "B11"):
        system, ctx = fake.prompts[op][-1]
        assert words in system and ctx["character_mode"]["mode"] == mode
    system, ctx = fake.prompts["C02"][-1]
    assert ctx["writing_brief"]["character_mode"]["mode"] == mode
    assert character_mode.writer_rule(mode) in system
    rsys, rctx = fake.prompts["review"][-1]
    assert character_mode.reviewer_rule(mode).strip() in rsys
    craft = fake.prompts.get("craft") or []
    assert craft
    note = character_mode.editor_notes(mode)["character_agency"]
    assert note in craft[-1][0]
    assert story_choices.summary({"characters": mode}) == [character_mode.summary_line(mode)]


def test_default_is_balanced_and_a_sequel_inherits_the_setting(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"length": "short_story"}))
    assert character_mode.of_store(app.store, run["project_id"]) == "balanced"
    assert "BALANCED" in fake.prompts["B01"][-1][0]
    # a book made plot-led; its sequel starts plot-led too (the setting is per book)
    run2 = done(run_book(app, {"length": "short_story", "choices": {"characters": "plot_led"}}))
    from akowe import series
    out = series.start_sequel(app, "author", run2["project_id"], "main", {"author_confirms": True, "skip_changes": True})
    app.autobook.wait_for(out["run"]["id"], 120)
    seq = done(app.autobook.public(app.autobook.get(out["run"]["id"])))
    assert character_mode.of_store(app.store, seq["project_id"]) == "plot_led"
    assert character_mode.of_store(app.store, run["project_id"]) == "balanced"
    with pytest.raises(AkoweError):
        story_choices.clean({"characters": "random"})
    assert story_choices.field_info()["character_mode"]["default"] == "balanced"
