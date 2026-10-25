"""Section 3: character sheets (P7), voice cards (P17) and scene cards (P8).

Pure parts (cleaning, completeness, the bounded voice brief, the scene lint and Akọwe's own PASS/REVISE), the
companion storage (made by the AI with the character, edited by the author with a version check), the C02 prompt
(voice cards of the characters present, scene cards, the POV character's name and planned backstory), the P6 voice
check, the editor's voice_distinction and scene_plan checks, Make-a-book end to end (characters step, scene cards
planned -> checked by another AI -> reworked -> approved under the run consent), Write all chapters and the HTTP
endpoints."""
from __future__ import annotations

import json
import time

import pytest

from akowe import chapter_brief, characters as chars_mod, journal, prose_audit, scenes as scenes_mod
from akowe.book_path import BookPath
from akowe.errors import AkoweError
from akowe.review import ReviewJob

from autobook_fake import VOICES, sheet_for, voice_for
from test_failover_review import SlotFake, make_app, no_provider_sleep, run_book  # noqa: F401
from test_server import call  # noqa: F401


def steps(run):
    return {s["id"]: s for s in run["steps"]}


def outbox(app, pid, et):
    return [json.loads(r["payload"]) for r in app.store.query(
        "SELECT payload FROM outbox WHERE project_id=? AND event_type=? ORDER BY rowid", (pid, et))]


def wait_job(app, job):
    for _ in range(500):
        j = app.review.get_job("author", job["job_id"])
        if j["status"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def book(tmp_path, fake=None, slots=("AI-1", "AI-2"), name="data"):
    fake = fake or SlotFake()
    app = make_app(tmp_path, fake, slots=slots, name=name)
    app.review.editor.save_settings({"enabled": False})
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    return app, fake, run


def job_of(app, pid, kind="scenes", slot=None):
    j = ReviewJob(kind, "author", pid, "main", ["x"], slot)
    j.started, j.status = time.time(), "running"
    return j


# ====================================================================== pure parts
def test_clean_sheet_voice_missing_and_complete():
    sheet = chars_mod.clean_sheet({"role": "side", "wants": "  a  boat ", "fear": 7, "secret": True, "bogus": "x",
                                   "relationships": [{"with": "Mara", "tension": "debt", "history": ""},
                                                     {"with": "", "tension": "x"}, "junk", {"with": "Tom"}]})
    assert sheet["wants"] == "a boat" and sheet["fear"] == "7" and sheet["secret"] == "" and "bogus" not in sheet
    assert sheet["relationships"] == [{"with": "Mara", "tension": "debt", "history": ""}]
    voice = chars_mod.clean_voice({"rhythm": "short", "register": "plain", "samples": "One.\nTwo.\n\nThree.\nFour.",
                                   "vocabulary": "wick; lens, log", "habits": ["a", "a", " ", "b"], "never_words": 5})
    assert voice["samples"] == ["One.", "Two.", "Three."]  # at most 3
    assert voice["vocabulary"] == ["wick", "lens", "log"] and voice["habits"] == ["a", "b"] and voice["never_words"] == []
    entry = {"sheet": sheet, "voice": voice}
    assert chars_mod.complete(entry)  # wants, fear, rhythm, register and a sample line are there
    assert not chars_mod.complete({"sheet": sheet, "voice": dict(voice, samples=[])})
    miss = chars_mod.missing(entry)
    assert "What they really need" in miss and "Their own wish" in miss  # a side character needs a wish of their own
    entry["sheet"]["role"] = "main"
    assert "Their own wish" not in chars_mod.missing(entry)
    assert chars_mod.split_companion({"character_sheet": {}, "voice_card": {}}) == (None, None)
    s, v = chars_mod.split_companion({"character_sheet": sheet_for("Tom Reed", ["Mara Vell"]),
                                      "voice_card": voice_for("Tom Reed")})
    assert s["relationships"][0]["with"] == "Mara Vell" and v["rhythm"].startswith("long")
    assert chars_mod.split_companion("nope") == (None, None)


def test_voice_brief_is_bounded_and_puts_the_pov_first(tmp_path):
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "Crowded book")
    bp = BookPath(app.engine, "author", pid, "main")
    people = []
    for i in range(12):
        name = f"Person {chr(65 + i)} Longname"
        cand = {"concept": name, "attributes": {"role": f"role {i}"}, "linked_refs": [], "protected_fact_flags": [],
                "facts": [{"subject_id": f"p{i}", "predicate": "entity.name", "value": name, "assertion_type": "FACT",
                           "effective_from": None, "effective_to": None, "source_refs": []}]}
        ref, _ = bp.create("A01", {"concept": name}, manual_candidate=cand)
        big = voice_for(name)
        big.update(rhythm="x" * 390, talks_around="y" * 390, under_pressure="z" * 390,
                   vocabulary=[f"word{j}" * 10 for j in range(12)], samples=["s" * 230] * 3)
        chars_mod.save_entry(app.store, pid, "main", ref["record_id"], sheet=sheet_for(name), voice=big, by="author")
        people.append(ref["record_id"])
    cs = chars_mod.canon_characters(app.store, pid, "main")
    assert len(cs) == 12
    vb = chars_mod.voice_brief(app.store, pid, "main", cs, first=people[7])
    size = len(json.dumps({"cards": vb["cards"], "others": vb["others"]}, ensure_ascii=False))
    assert size <= chars_mod.BRIEF_BUDGET and vb["summarized"]
    assert 1 <= len(vb["cards"]) <= chars_mod.MAX_FULL and vb["cards"][0]["name"] == "Person H Longname"
    assert len(vb["cards"]) + len(vb["others"]) >= 5 and all(len(x) <= 300 for x in vb["others"])
    # characters without a card are left out; an empty list gives an empty brief
    assert chars_mod.voice_brief(app.store, pid, "main", [])["cards"] == []


def test_scene_lint_and_akowe_decides_the_check():
    cards = scenes_mod.clean_cards({"scenes": [
        {"place": "quay", "time": "dusk", "characters": ["Mara Vell", "Stranger"], "goals": [
            {"character": "Mara Vell", "goal": "the log", "hidden_agenda": ""}],
         "obstacle": "", "obstacle_source": "weird", "change": "", "unsaid": "", "beat": "b"},
        {"place": "reef", "goals": [{"character": "Tom Reed", "goal": "money", "hidden_agenda": "the letter"}],
         "obstacle": "the board sealed the door", "obstacle_source": "institution", "change": "x", "unsaid": "y"},
        {}, "junk"]})
    assert len(cards) == 2 and cards[1]["characters"] == ["Tom Reed"] and cards[0]["obstacle_source"] == ""
    probs = scenes_mod.lint(cards, ["Mara Vell", "Tom Reed"])
    codes = {(p["scene"], p["code"]) for p in probs}
    assert {(1, "NO_OBSTACLE"), (1, "NO_UNSAID"), (1, "NO_CHANGE"), (1, "GOAL_MISSING"), (1, "UNKNOWN_CHARACTER")} <= codes
    assert not any(p["scene"] == 2 for p in probs)
    ok = {"verdict": "PASS", "scenes": [{"scene": i, "goal": True, "obstacle_from_world": True, "unsaid": True,
                                         "note": ""} for i in (1, 2)], "notes": []}
    res = scenes_mod.clean_review(ok, cards, probs)
    assert res["verdict"] == "REVISE" and "Akọwe" in res["why"][0]  # the AI said PASS, the lint did not
    res = scenes_mod.clean_review(ok, cards[1:], [])
    assert res["verdict"] == "PASS"
    half = dict(ok, scenes=[ok["scenes"][0]])
    res = scenes_mod.clean_review(half, cards[1:] * 2, [])
    assert res["verdict"] == "REVISE" and res["scenes"][1]["note"].startswith("the reviewer did not check")
    for bad in (None, {}, {"verdict": "MAYBE"}):
        with pytest.raises(AkoweError) as e:
            scenes_mod.clean_review(bad, cards, [])
        assert e.value.code == "INTERNAL_ERROR"


# ====================================================================== P6 voice check
LOOK_ALIKE = "\n\n".join([
    '"I think the light matters more than we know, and the harbour remembers it," Mara said.',
    '"I think the light matters more than we admit, and the harbour remembers it," Tom said.'] * 4)
DISTINCT = "\n\n".join([
    '"Who signed it?" Mara said.', '"As the old keepers said, a lamp that is watched never fails, and yet here we '
                                   'stand in the dark with the almanac open at the wrong page," Tom said.'] * 4)


def test_voice_check_stats_sameness_and_never_words():
    cards = {"Mara Vell": {"aliases": ["Mara"], "phrases": ["Fair enough."], "never_words": ["harbour"],
                           "vocabulary": ["wick", "light"]}}
    r = prose_audit.audit(LOOK_ALIKE, settings={"voices": cards})
    by = {f["check"]: f for f in r["findings"]}
    sp = r["stats"]["voices"]["speakers"]
    assert sp["Mara Vell"]["lines"] == 4 and sp["Mara Vell"]["words_per_line"] == 14.0 and sp["Tom"]["questions"] == 0
    assert sp["Mara Vell"]["has_card"] and sp["Mara Vell"]["vocabulary_used"] == 1 and sp["Mara Vell"]["phrases_used"] == 0
    assert by["voice_sameness"]["severity"] == "major" and by["voice_sameness"]["pairs"][0]["a"] == "Mara Vell"
    assert "Mara Vell and Tom" in by["voice_sameness"]["detail"] and by["voice_sameness"]["passages"]
    assert by["voice_never_word"]["count"] == 4 and by["voice_never_word"]["severity"] == "major"
    assert "harbour" in by["voice_never_word"]["detail"]
    # distinct voices: different line lengths and questions -> no sameness finding
    r2 = prose_audit.audit(DISTINCT)
    assert not [f for f in r2["findings"] if f["check"] == "voice_sameness"]
    pairs = r2["stats"]["voices"]["pairs"]
    assert pairs and not pairs[0]["rhythm_alike"]
    # gentle tolerates one never-word; the brief carries the voice stats, counts_only no text
    one = '"The harbour is cold," Mara said.\n\n"Yes," Tom said.'
    assert any(f["check"] == "voice_never_word" for f in prose_audit.audit(one, settings={"voices": cards})["findings"])
    assert not any(f["check"] == "voice_never_word" for f in prose_audit.audit(
        one, settings={"voices": cards, "strictness": "gentle"})["findings"])
    b = prose_audit.brief(r)
    assert b["voices"]["speakers"]["Tom"]["lines"] == 4 and "voice_sameness" in json.dumps(prose_audit.counts_only(r))
    assert "harbour remembers" not in json.dumps(prose_audit.counts_only(r))


# ====================================================================== P7/P17 made by the AI, edited by the author
def test_sheets_made_with_the_characters_and_edited_by_the_author(tmp_path):
    app, fake, run = book(tmp_path)
    pid = run["project_id"]
    st = steps(run)["characters"]
    assert st["state"] == "done" and all(i["note"] == "made with the character" for i in st["items"])
    info = app.review.characters_info("author", pid, "main")
    people = {c["name"]: c for c in info["characters"]}
    mara = people["Mara Vell"]
    assert mara["complete"] and mara["sheet"]["role"] == "main" and mara["voice"]["rhythm"] == VOICES["Mara Vell"]["rhythm"]
    assert mara["made_by"]["kind"] == "ai" and mara["made_by"]["slot"] == "AI-1"
    assert people["Tom Reed"]["sheet"]["own_wish"] and people["Tom Reed"]["sheet"]["relationships"][0]["with"] == "Mara Vell"
    assert {f["key"] for f in info["fields"]["sheet"]} >= {"wants", "needs", "fear", "secret", "false_belief", "stress",
                                                           "never_say", "private_memory", "change_limits", "own_wish"}
    # the author changes the voice card: a new version, the old one in the history; a stale version is refused
    rid = mara["record_id"]
    out = app.review.save_character("author", pid, "main", rid, {"voice": dict(mara["voice"], rhythm="clipped"),
                                                                "version": mara["version"]})
    assert out["entry"]["version"] == mara["version"] + 1 and out["entry"]["voice"]["rhythm"] == "clipped"
    assert out["entry"]["sheet"] == mara["sheet"] and out["entry"]["made_by"]["kind"] == "author"
    assert out["entry"]["history"][-1]["voice"]["rhythm"] == VOICES["Mara Vell"]["rhythm"]
    with pytest.raises(AkoweError) as e:
        app.review.save_character("author", pid, "main", rid, {"sheet": {"wants": "x"}, "version": mara["version"]})
    assert e.value.code == "VERSION_CONFLICT"
    for body, code in (({}, "INVALID_INPUT"), ({"sheet": "x"}, "INVALID_INPUT"), ({"sheet": {}, "version": -1},
                                                                                     "INVALID_INPUT")):
        with pytest.raises(AkoweError) as e:
            app.review.save_character("author", pid, "main", rid, body)
        assert e.value.code == code
    with pytest.raises(AkoweError) as e:
        app.review.save_character("author", pid, "main", "A04-nope", {"sheet": {}})
    assert e.value.code == "NOT_FOUND"
    ev = outbox(app, pid, "characters.sheet_saved")
    assert ev and ev[-1]["by"] == "author" and "clipped" not in json.dumps(ev)  # numbers only, never sheet text
    # the A01 consistency review saw the sheet and voice card
    canon_reviews = [c for s, c in fake.prompts["review"] if "character_sheet" in c]
    assert canon_reviews and canon_reviews[0]["voice_card"]["rhythm"]


def test_the_ai_writes_a_missing_sheet_in_the_run_and_on_request(tmp_path):
    fake = SlotFake()
    fake.companion = False  # the Bible Builder's model leaves the sheets out
    app, fake, run = book(tmp_path, fake)
    pid = run["project_id"]
    st = steps(run)["characters"]
    assert st["state"] == "done" and all(i["note"] == "made now" for i in st["items"])
    assert "made now" in st["message"] and fake.kinds.count("sheet") == len(st["items"])
    assert any(e["kind"] == "characters" for e in run["events"])
    rid = st["items"][0]["id"]
    before = chars_mod.get_entry(app.store, pid, "main", rid)
    j = wait_job(app, app.review.start_character_ai("author", pid, "main", rid, {"note": "make her angrier"}))
    assert j["status"] == "done", j
    after = chars_mod.get_entry(app.store, pid, "main", rid)
    assert after["version"] == before["version"] + 1 and after["made_by"]["kind"] == "ai"
    _sys, ctx = fake.prompts["sheet"][-1]
    assert ctx["author_note"] == "make her angrier" and ctx["other_characters"] and ctx["character"]["name"]
    # a model answer without a usable sheet changes nothing
    fake.kind_failures["sheet"] = [AkoweError("INTERNAL_ERROR", "", "bad")]
    j = wait_job(app, app.review.start_character_ai("author", pid, "main", rid, {}))
    assert j["status"] == "error" and chars_mod.get_entry(app.store, pid, "main", rid)["version"] == after["version"]


def test_a_failing_sheet_never_blocks_the_book(tmp_path):
    fake = SlotFake()
    fake.companion = False
    fake.kind_failures["sheet"] = [AkoweError("INTERNAL_ERROR", "", "no usable answer")] * 2
    app, fake, run = book(tmp_path, fake)
    st = steps(run)["characters"]
    assert st["state"] == "done" and "could not be made" in st["message"]
    assert any(e.get("code") == "CHARACTER_SHEET_FAILED" for e in run["events"])


# ====================================================================== the C02 prompt (P7/P17/P8/P11-lite)
def test_chapter_prompt_has_voice_cards_scene_cards_and_the_pov(tmp_path):
    app, fake, run = book(tmp_path)
    pid = run["project_id"]
    _sys, ctx = fake.prompts["C02"][0]
    wb = ctx["writing_brief"]
    assert wb["pov"]["name"] == "Mara Vell" and wb["pov"]["backstory"]  # narrator's name and planned backstory
    names = {c["name"] for c in wb["voice_cards"]}
    assert "Mara Vell" in names and wb["voice_cards"][0]["name"] == "Mara Vell"
    mara = wb["voice_cards"][0]
    assert mara["voice"]["samples"] and mara["voice"]["never_words"] and mara["sheet"]["wants"]
    assert len(wb["scene_cards"]) == 2 and wb["scene_cards"][0]["goals"] and wb["scene_cards"][0]["unsaid"]
    assert "voice card" in _sys and "scene by scene" in _sys and "point-of-view character" in _sys
    assert len(json.dumps(wb)) < 20000
    # the chapter record remembers which brief it was written with (IDs and numbers only)
    bp = BookPath(app.engine, "author", pid, "main")
    ch = bp.outline_chapters(bp.outline())[0]["chapter_id"]
    _c, latest, appr = bp.chapter_prose(bp.outline(), ch)
    meta = app.store.get_state(pid, "main", "c_meta", appr["record_id"])
    assert meta["brief"]["scene_cards"]["scenes"] == 2 and meta["brief"]["pov"] and meta["brief"]["voice_cards"] >= 1
    assert "Mara" not in json.dumps(meta["brief"])
    # a manual chapter gets no brief (nothing to send to an AI)
    brief, info = chapter_brief.build(app.store, pid, "main", None, ch)
    assert brief is None and info["voice_cards"] == 0


# ====================================================================== P8 scene cards outside runs
def test_scene_cards_planned_checked_edited_approved_and_used(tmp_path):
    app, fake, run = book(tmp_path)
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    outline = bp.outline()
    ch = bp.outline_chapters(outline)[1]["chapter_id"]
    e0 = scenes_mod.get_entry(app.store, pid, "main", outline["record_id"], ch)
    assert e0["status"] == "approved" and e0["approved"]["how"] == "run_consent" and run["id"] in e0["approved"]["label"]
    # plan again with the AI: AI-1 plans (writer), AI-2 checks (independent)
    fake.scene_verdicts = ["REVISE"]
    j = wait_job(app, app.review.start_scenes_ai("author", pid, "main", ch, {}))
    assert j["status"] == "done", j
    res = j["results"][0]
    assert res["entry"]["version"] == e0["version"] + 1 and res["entry"]["status"] == "draft"
    assert res["review"]["verdict"] == "REVISE" and res["review"]["independent"] is True
    plans = [s for s, k in fake.per_slot if k == "scenes"]
    checks = [s for s, k in fake.per_slot if k == "scene_review"]
    assert plans[-1] == "AI-1" and checks[-1] == "AI-2"
    info = app.review.scenes_info("author", pid, "main", ch)
    assert info["summary"]["verdict"] == "REVISE" and not info["summary"]["out_of_date"] and info["usable"]
    # rework with the checker's notes: the writer gets the earlier plan and the notes
    j = wait_job(app, app.review.start_scenes_ai("author", pid, "main", ch, {"revise": True}))
    _s, ctx = fake.prompts["scenes"][-1]
    assert ctx["earlier_plan"] and any("harbour board" in n or "scene" in n for n in ctx["review_notes"])
    assert j["results"][0]["review"]["verdict"] == "PASS"
    # the author edits: cleaned, a new version; a stale version is refused
    ver = app.review.scenes_info("author", pid, "main", ch)["entry"]["version"]
    cards = [{"place": "the net sheds", "time": "noon", "characters": "Mara Vell, Tom Reed",
              "goals": [{"character": "Tom Reed", "goal": "keep the letter", "hidden_agenda": "sell it"}],
              "obstacle": "the harbour board audits the sheds", "obstacle_source": "institution",
              "change": "Mara owes Tom", "unsaid": "Tom read the letter", "beat": "the stranger"}]
    out = app.review.save_scenes("author", pid, "main", ch, {"cards": cards, "version": ver})
    e = out["entry"]
    assert e["version"] == ver + 1 and e["made_by"]["kind"] == "author" and e["cards"][0]["characters"] == ["Mara Vell",
                                                                                                          "Tom Reed"]
    with pytest.raises(AkoweError) as x:
        app.review.save_scenes("author", pid, "main", ch, {"cards": cards, "version": ver})
    assert x.value.code == "VERSION_CONFLICT"
    for body in ({"cards": []}, {"cards": "x"}, {"cards": [{}]}, {"cards": cards, "version": "1"}):
        with pytest.raises(AkoweError) as x:
            app.review.save_scenes("author", pid, "main", ch, body)
        assert x.value.code == "INVALID_INPUT"
    with pytest.raises(AkoweError) as x:
        app.review.approve_scenes("author", pid, "main", ch, {"version": e["version"]})
    assert x.value.code == "APPROVAL_REQUIRED"
    with pytest.raises(AkoweError) as x:
        app.review.approve_scenes("author", pid, "main", ch, {"author_confirms": True, "version": e["version"] - 1})
    assert x.value.code == "VERSION_CONFLICT"
    a = app.review.approve_scenes("author", pid, "main", ch, {"author_confirms": True, "version": e["version"]})
    assert a["entry"]["status"] == "approved" and a["entry"]["approved"]["how"] == "author"
    # the book page shows it; the writer uses it when the chapter is written again
    row = next(c for c in chapter_rows(bp) if c["chapter_id"] == ch)
    assert row["scenes"]["status"] == "approved" and row["scenes"]["scenes"] == 1
    _ctx, _latest, appr = bp.chapter_prose(outline, ch)
    bp.dispatch("C02", "UPDATE", base_ref=appr["ref"], payload=dict(appr["data"]))
    brief, meta = chapter_brief.build(app.store, pid, "main", outline, ch)
    assert brief["scene_cards"][0]["obstacle"] == "the harbour board audits the sheds"
    assert {c["name"] for c in brief["voice_cards"]} >= {"Mara Vell", "Tom Reed"}
    # activity events: numbers only
    evs = outbox(app, pid, "scenes.saved") + outbox(app, pid, "scenes.reviewed") + outbox(app, pid, "scenes.approved")
    assert {x.get("how") for x in outbox(app, pid, "scenes.approved")} == {"run_consent", "author"}
    assert "harbour board audits" not in json.dumps(evs)
    jr = journal.build(app, pid, "main")
    kinds = {x["kind"] for x in jr["entries"]}
    assert {"scenes", "characters"} <= kinds and "harbour board audits" not in json.dumps(jr)
    # unknown chapter / no outline problems are plain errors
    with pytest.raises(AkoweError) as x:
        app.review.scenes_info("author", pid, "main", "nope")
    assert x.value.code == "INVALID_INPUT"


def test_scene_cards_go_out_of_date_with_the_outline(tmp_path):
    app, fake, run = book(tmp_path)
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    outline = bp.outline()
    ch = bp.outline_chapters(outline)[0]["chapter_id"]
    entry = scenes_mod.get_entry(app.store, pid, "main", outline["record_id"], ch)
    newer = dict(outline, version=outline["version"] + 1)
    assert scenes_mod.usable(entry, outline) and not scenes_mod.usable(entry, newer)
    assert scenes_mod.summary(entry, newer)["out_of_date"]
    brief, meta = chapter_brief.build(app.store, pid, "main", newer, ch)
    assert brief["scene_cards"] == [] and meta["scene_cards"] is None


# ====================================================================== the editor (P4) with voice cards and scenes
def dialogue_book(tmp_path, fake):
    fake.chapter_texts = {"ch2": "# The quay\n\n" + LOOK_ALIKE}
    app, fake, run = book(tmp_path, fake)
    return app, fake, run


def test_editor_checks_voices_and_the_scene_plan(tmp_path):
    fake = SlotFake()
    app, fake, run = dialogue_book(tmp_path, fake)
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    _c, _l, appr = bp.chapter_prose(bp.outline(), "ch2")
    resp = bp.dispatch("C02", "UPDATE", base_ref=appr["ref"], payload=dict(appr["data"]))
    rid = resp["output_refs"][0]["record_id"]
    j = wait_job(app, app.review.start_editor("author", pid, "main", {"record_id": rid}))
    assert j["status"] == "done", j
    craft = j["results"][0]["craft"]
    assert "scene_plan" in craft["scores"] and craft["scores"]["voice_distinction"] == 4
    f = next(x for x in craft["findings"] if x["dimension"] == "voice_distinction")
    assert f["found"] and "sounds like Mara Vell" in f["why"] and f["label"] == "Distinct voices"
    ctx = fake.craft_contexts[-1]
    assert ctx["voice_cards"]["cards"] and ctx["scene_cards"] and ctx["pov"]["name"] == "Mara Vell"
    assert ctx["pattern_report"]["voices"]["pairs"][0]["similar"]
    _sys, _c2 = fake.prompts["craft"][-1]
    assert "context.voice_cards" in _sys and "Scene plan kept" not in _sys and "context.scene_cards" in _sys
    # the pattern report on the chapter page has the voice check with the cards' never-words
    info = app.review.editor_info("author", pid, "main", rid)
    assert any(x["check"] == "voice_sameness" for x in info["pattern"]["findings"])
    assert info["pattern"]["stats"]["voices"]["speakers"]["Mara Vell"]["has_card"]


# ====================================================================== Make a book end to end (P7 + P17 + P8)
def test_make_a_book_end_to_end_with_sheets_voices_and_scene_cards(tmp_path):
    fake = SlotFake()
    fake.scene_verdicts = ["REVISE", "PASS"]  # chapter 1: the checker sends the plan back once
    fake.editor_flags = {}
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid = run["project_id"]
    st = steps(run)
    assert [s["id"] for s in run["steps"]][:6] == ["backup", "profile", "canon", "characters", "world", "premise"]
    items = {i["id"]: i for i in st["chapters"]["items"]}
    assert all(i["scenes"]["status"] == "approved" and i["scenes"]["approved_how"] == "run_consent"
               for i in items.values())
    assert items["ch1"]["scenes"]["version"] == 2 and items["ch2"]["scenes"]["version"] == 1
    # order per chapter: plan -> check -> (rework -> check) -> write
    k = [x for x in fake.kinds if x in ("scenes", "scene_review", "C02")]
    assert k[:5] == ["scenes", "scene_review", "scenes", "scene_review", "C02"]
    assert k[5:8] == ["scenes", "scene_review", "C02"]
    # the writer plans, another AI checks
    assert {s for s, x in fake.per_slot if x == "scenes"} == {"AI-1"}
    assert {s for s, x in fake.per_slot if x == "scene_review"} == {"AI-2"}
    rework = fake.prompts["scenes"][1][1]
    assert rework["review_notes"] and rework["earlier_plan"]
    # every chapter prompt carried the scene cards and voice cards; the editor checked the scene plan
    for _sys, ctx in fake.prompts["C02"]:
        assert ctx["writing_brief"]["scene_cards"] and ctx["writing_brief"]["voice_cards"]
    assert all("scene_plan" in c["scores"] for c in app.review.editor.crafts(pid, "main").values())
    # approvals under the run consent, labelled with the run; events and journal carry no card text
    appr = outbox(app, pid, "scenes.approved")
    assert len(appr) == 3 and all(a["how"] == "run_consent" and a["run_id"] == run["id"] for a in appr)
    assert any("Scene check of chapter ch1: REVISE" in e["message"] for e in run["events"])
    assert any("reworked the scenes of chapter ch1" in e["message"] for e in run["events"])
    jr = journal.build(app, pid, "main")
    assert any("Scene check of chapter ch1" in x["what"] for x in jr["entries"])
    assert "harbour board has sealed" not in json.dumps(jr)
    # the consent never works outside the live run
    saved = app.autobook.get(run["id"])
    with pytest.raises(AkoweError) as e:
        app.autobook._check_consent(saved, pid)
    assert e.value.code == "PERMISSION_DENIED"


def test_scene_checker_notes_after_two_reworks_never_block(tmp_path):
    fake = SlotFake()
    fake.scene_verdicts = ["REVISE"] * 3
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    app.review.editor.save_settings({"enabled": False})
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    items = {i["id"]: i for i in steps(run)["chapters"]["items"]}
    assert items["ch1"]["scenes"]["flagged"] and items["ch1"]["scenes"]["version"] == 3
    assert any(e.get("code") == "SCENES_NOTES" for e in run["events"])
    assert any(a["flagged"] for a in outbox(app, run["project_id"], "scenes.approved"))


def test_scene_plan_failure_writes_from_the_outline_and_timeout_pauses(tmp_path):
    fake = SlotFake()
    fake.kind_failures["scenes"] = [AkoweError("INTERNAL_ERROR", "", "garbage")]
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    app.review.editor.save_settings({"enabled": False})
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    items = {i["id"]: i for i in steps(run)["chapters"]["items"]}
    assert items["ch1"]["scenes"]["failed"] == "INTERNAL_ERROR" and items["ch2"]["scenes"]["status"] == "approved"
    assert any(e.get("code") == "SCENES_FAILED" for e in run["events"])
    # a TIMEOUT while planning pauses the step for the author (never guessed past)
    fake2 = SlotFake()
    fake2.kind_failures["scenes"] = [AkoweError("TIMEOUT", "", "slow")]
    app2 = make_app(tmp_path, fake2, slots=("AI-1", "AI-2"), name="data2")
    run2 = run_book(app2, {"slot_id": "AI-1"})
    assert run2["status"] == "paused" and run2["problem"]["code"] == "TIMEOUT"
    assert "scenes" in run2["problem"]["message"] and run2["problem"]["chapter_id"] == "ch1"
    out = app2.autobook.resume("author", run2["id"])
    app2.autobook.wait_for(out["id"], 180)
    assert app2.autobook.get(run2["id"])["status"] == "done"


def test_old_runs_get_the_new_step_on_resume():
    run = {"steps": [{"id": s, "state": "done"} for s in ("backup", "profile", "canon", "premise")]}
    from akowe.autobook import AutoBookService, STEP_IDS
    AutoBookService._ensure_steps(run)
    assert [s["id"] for s in run["steps"]] == STEP_IDS
    assert next(s for s in run["steps"] if s["id"] == "characters")["state"] == "pending"


def chapter_rows(bp):
    return next(s for s in bp.status()["steps"] if s["id"] == "chapters")["chapters"]


def test_write_all_plans_scenes_first(tmp_path):
    app, fake, run = book(tmp_path)
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    app.store.set_setting(f"scene_cards:{pid}:main", {})  # a chapter without scene cards
    assert all(r["scenes"] is None for r in chapter_rows(bp))
    n_before = fake.kinds.count("scenes")
    job = {"id": "wall-test", "principal": "author", "project_id": pid, "branch_id": "main", "events": []}
    item = {"id": "ch1", "label": "Chapter ch1"}
    app.write_all._plan_scenes(job, bp, item)
    assert fake.kinds.count("scenes") == n_before + 1 and fake.kinds.count("scene_review") == 3  # no check here
    assert item["scenes"]["status"] == "draft" and any("not checked yet" in e["message"] for e in job["events"])
    app.write_all._plan_scenes(job, bp, item)  # usable cards are kept, not made again
    assert fake.kinds.count("scenes") == n_before + 1


# ====================================================================== HTTP
@pytest.fixture
def served(tmp_path):
    import threading
    from http.server import ThreadingHTTPServer
    from akowe.server import make_handler
    app, fake, run = book(tmp_path)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield app, httpd.server_address[1], run
    finally:
        httpd.shutdown()
        httpd.server_close()
        app.store.close()


def http_job(port, pid, job):
    for _ in range(500):
        st, j, _ = call(port, "GET", f"/api/projects/{pid}/branches/main/review/ai/{job['job_id']}")
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_http_characters_and_scenes(served):
    app, port, run = served
    pid = run["project_id"]
    base = f"/api/projects/{pid}/branches/main/review"
    st, info, _ = call(port, "GET", f"{base}/characters")
    assert st == 200 and len(info["characters"]) == 2 and info["fields"]["voice_lists"]
    rid = info["characters"][0]["record_id"]
    st, one, _ = call(port, "GET", f"{base}/characters/{rid}")
    assert st == 200 and one["complete"] and one["entry"]["version"] >= 1
    st, out, _ = call(port, "PUT", f"{base}/characters/{rid}", {"sheet": dict(one["entry"]["sheet"], fear="storms"),
                                                                 "version": one["entry"]["version"]})
    assert st == 200 and out["entry"]["sheet"]["fear"] == "storms"
    st, e, _ = call(port, "PUT", f"{base}/characters/{rid}", {"sheet": {}, "version": 0})
    assert st == 409 and e["errors"][0]["code"] == "VERSION_CONFLICT"
    st, e, _ = call(port, "GET", f"{base}/characters/nope")
    assert st == 404
    st, job, _ = call(port, "POST", f"{base}/characters/{rid}/ai", {})
    assert st == 202 and http_job(port, pid, job)["status"] == "done"
    st, sc, _ = call(port, "GET", f"{base}/scenes/ch1")
    assert st == 200 and sc["entry"]["status"] == "approved" and sc["fields"]["card"] and sc["chapter"]["number"] == 1
    st, job, _ = call(port, "POST", f"{base}/scenes/ch1/ai", {"check": False})
    assert st == 202
    j = http_job(port, pid, job)
    assert j["status"] == "done" and "review" not in j["results"][0]
    st, job, _ = call(port, "POST", f"{base}/scenes/ch1/check", {})
    j = http_job(port, pid, job)
    assert j["results"][0]["review"]["verdict"] == "PASS"
    st, sc, _ = call(port, "GET", f"{base}/scenes/ch1")
    st, out, _ = call(port, "POST", f"{base}/scenes/ch1/approve", {"author_confirms": True,
                                                                   "version": sc["entry"]["version"]})
    assert st == 200 and out["entry"]["status"] == "approved"
    st, e, _ = call(port, "POST", f"{base}/scenes/ch1/approve", {})
    assert st == 400 and e["errors"][0]["code"] == "APPROVAL_REQUIRED"
    st, e, _ = call(port, "POST", f"{base}/scenes/ch1/ai", {"check": "yes"})
    assert st == 400 and e["errors"][0]["path"] == "/check"
    st, e, _ = call(port, "PUT", f"{base}/scenes/ch1", {"cards": [{}]})
    assert st == 400 and e["errors"][0]["fix"]
    st, book_, _ = call(port, "GET", f"/api/projects/{pid}/branches/main/book")
    ch_step = next(s for s in book_["steps"] if s["id"] == "chapters")
    assert ch_step["chapters"][0]["scenes"]["status"] == "approved"
    canon = next(s for s in book_["steps"] if s["id"] == "canon")
    assert canon["sheets"] == {"complete": 2, "total": 2}
