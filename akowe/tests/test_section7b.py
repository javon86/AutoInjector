"""Section 7 (P32–P35): 🌊 physical state per scene, 🫀 character state variables, 🪞 the two-readings test of protected
mysteries and 🧾 the version delta ledger of reruns / variants — pure logic, storage and routes, the run hooks (tracked
and approved under the run consent, fed into the next chapter's brief), the consistency review's context, the book
folder and the AI fallbacks."""
from __future__ import annotations

import copy
import json
import time
import types

import pytest

from akowe import ambiguity as amb
from akowe import chapter_brief, continuity
from akowe import character_state as cs
from akowe import characters as chars_mod
from akowe import physical_state as ps
from akowe import providers as prov_mod
from akowe import version_ledger as vl
from akowe.book_path import BookPath
from akowe.errors import AkoweError

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


class ContinuityFake(BookFakeAI):
    """BookFakeAI that also answers the continuity tracker, the readings writer and the two-readings test."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.test_script: list = []

    def _answer(self, ctx, props, schema):
        if "tracked_scenes" in props:
            n = (ctx.get("chapter") or {}).get("number") or 1
            return "track", {"tracked_scenes": [
                {"where": "the lamp room", "time": f"{n + 7} o'clock", "light": "lantern light", "tide": "low tide",
                 "weather": "fog", "footing": "slippery steps",
                 "hazards": [{"what": "gas leak", "status": "open", "effect": "no open flame near the valve"}]
                 if n == 1 else [],
                 "counts": [{"name": "lamps lit", "value": str(30 + n), "running": True}],
                 "characters": [{"name": "Mara Vell", "values": [{"variable": "duty", "value": 6 + n},
                                                                 {"variable": "guilt", "value": 3}],
                                 "observes": "the logbook's last line", "assumes": "the keeper drowned",
                                 "own_action": "hides the letter from the harbour board", "serves": "own_goal"}]}]}
        if "items" in props and "mysteries" in ctx:
            return "readings", {"items": [{"id": m["id"], "readings": [
                {"label": "Someone", "text": "The stranger left the keeper on the reef."},
                {"label": "Accident", "text": "The keeper slipped on the reef and drowned."}]}
                for m in ctx["mysteries"]]}
        if "results" in props and "mysteries" in ctx:
            with self.lock:
                scripted = self.test_script.pop(0) if self.test_script else None
            if scripted is not None:
                return "two_readings", scripted(ctx) if callable(scripted) else copy.deepcopy(scripted)
            return "two_readings", {"results": [{"id": m["id"], "readings": [
                {"label": "Someone", "supports": [{"chapter": 2, "quote": "only the stranger had come back",
                                                   "why": "he came back alone"}], "contradictions": []},
                {"label": "Accident", "supports": [{"chapter": 3, "quote": "At low tide the reef rose out of the "
                                                                           "water", "why": "a dangerous reef"}],
                 "contradictions": []}]} for m in ctx["mysteries"]]}
        return super()._answer(ctx, props, schema)


def route(app, method, path, body=None):
    return app.route(method, path, {}, body, "author", {})


def cpath(pid, rest=""):
    return f"/api/projects/{pid}/branches/main/review/continuity{rest}"


def wait_job(app, job_id, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        j = app.review.get_job("author", job_id)
        if j["status"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.05)
    raise AssertionError("job did not finish")


# ============================================================================================ P32 physical state
TEXT = ("# The Lamps\n\nThe fog rolled in before dawn and Mara climbed the hundred and twelve steps with a lantern. "
        "A cracked lens leaked cold air into the lamp room.\n\n* * *\n\nAt nine o'clock she lit the thirty-second "
        "lamp. The gauge read 40 psi and the smell of gas hung over the slippery steps.\n\n* * *\n\n"
        "At eight o'clock she lit lamp 31 at low tide.")


def test_physical_extract_scenes_fields_hazards_and_counts():
    s = ps.extract(TEXT)
    assert [x["scene"] for x in s] == [1, 2, 3]
    assert s[0]["time"] == "before dawn" and s[0]["light"] == "lantern" and s[0]["weather"] == "fog"
    assert {"name": "step", "value": "112", "running": True} in s[0]["counts"]
    assert any(h["what"] == "crack" and h["status"] == "open" for h in s[0]["hazards"])
    assert s[1]["time"] == "nine o'clock" and s[1]["footing"] == "slippery steps"
    assert {"name": "lamp", "value": "32", "running": True} in s[1]["counts"]
    assert {"name": "gauge", "value": "40 psi", "running": False} in s[1]["counts"]
    assert any(h["what"] == "gas" for h in s[1]["hazards"])
    assert s[2]["tide"] == "low tide" and {"name": "lamp", "value": "31", "running": True} in s[2]["counts"]
    assert ps.parse_number("thirty-second") == (32, True) and ps.parse_number("a hundred and twelve") == (112, False)
    assert ps.hour_of("half past nine") == 9.5 and ps.hour_of("21:15") == 21.25 and ps.hour_of("dusk") is None
    assert ps.extract("") == [] and ps.split_scenes("# Title only") == []


def test_physical_lint_and_end_state():
    s = ps.extract(TEXT)
    chs = [{"number": 1, "chapter_id": "ch1", "scenes": s, "text": TEXT},
           {"number": 2, "chapter_id": "ch2", "scenes": [], "text": "Mara mended the cracked lens with putty."},
           {"number": 3, "chapter_id": "ch3", "scenes": [], "text": "Nothing else."}]
    codes = [(p["code"], p.get("scene")) for p in ps.lint(chs)]
    assert ("COUNT_BACKWARDS", 3) in codes and ("TIME_BACKWARDS", 3) in codes
    dropped = [p for p in ps.lint(chs) if p["code"] == "HAZARD_DROPPED"]
    assert [p["message"].split(" ")[0] for p in dropped] == ["gas"]  # the crack shows up again in chapter 2
    # a resolved hazard is not open any more; the flashback words excuse the clock
    s2 = copy.deepcopy(s)
    s2[2]["hazards"] = [{"what": "gas", "status": "resolved", "effect": "shut off"}]
    s2[2]["time"] = "eight o'clock the next morning"
    chs2 = [dict(chs[0], scenes=s2), chs[1], chs[2]]
    codes2 = {p["code"] for p in ps.lint(chs2)}
    assert "TIME_BACKWARDS" not in codes2 and "HAZARD_DROPPED" not in codes2
    st = ps.end_state([{"number": 1, "scenes": s2}])
    assert st["after_chapter"] == 1 and st["tide"] == "low tide" and st["footing"] == "slippery steps"
    assert [h["what"] for h in st["open_hazards"]] == ["crack"]
    assert {"name": "lamp", "last_value": "31", "running": True} in st["counts"]
    assert ps.end_state([]) is None
    # cleaning: junk is dropped, statuses defaulted
    c = ps.clean_scenes({"scenes": [{"time": "noon", "hazards": ["fire", {"what": ""}], "counts": [{"name": "x"}]},
                                    "junk", {}]})
    assert c == [{"scene": 1, "where": "", "time": "noon", "light": "", "tide": "", "weather": "", "footing": "",
                  "hazards": [{"what": "fire", "status": "open", "effect": ""}], "counts": []}]


# ============================================================================================ P35 character state
def test_character_state_cleaning_lint_and_brief():
    assert cs.clean_variables(None) == list(cs.DEFAULT_VARIABLES)
    assert cs.clean_variables(["Fear of exposure", "duty", "duty", "", 3]) == ["fear_of_exposure", "duty"]
    vars_ = list(cs.DEFAULT_VARIABLES)
    raw = [{"characters": [{"name": "Mara Vell", "values": [{"variable": "duty", "value": 2},
                                                            {"variable": "nonsense", "value": 5}],
                            "own_action": "lies to the board", "serves": "theme"},
                           {"name": "", "values": []}]},
           {"characters": [{"name": "Mara Vell", "values": {"duty": 9, "guilt": "4"}, "observes": "the key",
                            "assumes": "Tom is alive", "serves": "bogus"}]}]
    scenes = cs.clean_scenes(raw, vars_)
    assert scenes[0]["characters"][0]["values"] == {"duty": 2} and scenes[1]["characters"][0]["serves"] == ""
    chs = [{"number": 1, "chapter_id": "ch1", "scenes": scenes}]
    lint = cs.lint(chs, ["Mara Vell", "Nessa Crane"])
    codes = [p["code"] for p in lint]
    assert codes.count("BIG_JUMP") == 1 and "NO_OWN_ACTION" in codes and "NEVER_OWN_ACTION" in codes
    assert not any(p.get("name") == "Nessa Crane" for p in lint)  # not present: nothing to say
    good = copy.deepcopy(scenes)
    good[1]["characters"][0].update(own_action="keeps the key", serves="own_goal")
    assert "NO_OWN_ACTION" not in {p["code"] for p in cs.lint([dict(chs[0], scenes=good)], ["Mara"])}
    latest = cs.latest([dict(chs[0], scenes=good)])
    b = cs.brief(latest, ["Mara"])
    assert b == [{"name": "Mara Vell", "values": {"duty": 9, "guilt": 4}, "observes": "the key",
                  "assumes": "Tom is alive", "as_of_chapter": 1}]


# ============================================================================================ P33 two readings
def test_two_readings_judge_checks_quotes_word_for_word():
    chapters = [{"number": 1, "text": "Only the stranger had come back. The tide was out."},
                {"number": 2, "text": "Tom’s boot was found on the rocks, “swollen with salt”."}]
    items = [{"id": "r4", "mystery": "Who the stranger was", "readings": [
        {"label": "Someone", "text": "The stranger did it."}, {"label": "Accident", "text": "Tom slipped."}]}]
    raw = {"results": [{"id": "r4", "readings": [
        {"label": "Someone", "supports": [{"chapter": 1, "quote": "only the stranger had come back", "why": ""}],
         "contradictions": [{"chapter": 2, "quote": "Tom's boot was found on the rocks swollen with salt", "why": "x"}]},
        {"label": "Accident", "supports": [{"chapter": 2, "quote": "a quote that is not in the book at all",
                                            "why": ""}], "contradictions": []}]}]}
    r = amb.judge(items, raw, chapters)[0]
    a, b = r["readings"]
    assert a["supports"][0]["found"] and a["contradictions"][0]["found"] and a["status"] == "contradicted"
    assert b["status"] == "unsupported" and b["unverified"] == 1
    assert r["verdict"] == "WEAK" and r["weaker"] == "Someone"  # contradicted is weaker than unsupported
    ok = {"results": [{"id": "r4", "readings": [
        {"label": "Someone", "supports": [{"chapter": 1, "quote": "Only the stranger had come back", "why": ""}],
         "contradictions": []},
        {"label": "Accident", "supports": [{"chapter": 1, "quote": "The tide was out", "why": ""}],
         "contradictions": []}]}]}
    assert amb.judge(items, ok, chapters)[0]["verdict"] == "PASS"
    none = amb.judge(items, {"results": []}, chapters)[0]  # the mock's empty answer: nothing supports either
    assert none["verdict"] == "WEAK" and not none["answered"]
    assert amb.find_quote("to", chapters, 1) is None  # too short to count


# ============================================================================================ P34 version ledger
def _bible(**over):
    b = {"profile": {"title": "The Keeper", "genre": "Mystery", "idea": "A keeper vanishes."},
         "choices": {"ending": "bittersweet"},
         "characters": [{"name": "Mara Vell", "module_id": "A01", "data": {"attributes": {"role": "apprentice"}},
                         "sheet": {"secret": "kept the letter", "fear": "the board"}},
                        {"name": "Old Tom", "module_id": "A01", "data": {"attributes": {}}, "sheet": {}}],
         "canon": [{"name": "Gullhaven", "module_id": "A04", "kind": "Place", "data": {"concept": "a harbor town"}}],
         "story_rules": [{"id": "r1", "category": "mystery", "text": "Who the stranger was.", "status": "active"}],
         "world_texture": [], "plan": {"premise": {"data": {"premise": "An apprentice searches."}}}}
    b.update(over)
    return b


def test_version_ledger_diff_names_on_page_and_brief():
    old = _bible()
    new = _bible(characters=[{"name": "Mara Vell", "module_id": "A01", "data": {"attributes": {"role": "apprentice"}},
                              "sheet": {"secret": "burned the letter", "fear": "the board"}},
                             {"name": "Nessa Crane", "module_id": "A01", "data": {"attributes": {}}, "sheet": {}}])
    items = vl.diff(vl.facts(old), vl.facts(new))
    kinds = {i["id"]: i["kind"] for i in items}
    assert kinds["char:mara-vell:sheet:secret"] == "replaced" and kinds["char:mara-vell:sheet:fear"] == "retained"
    assert kinds["char:old-tom"] == "removed" and kinds["char:nessa-crane"] == "added"
    assert kinds["rule:r1"] == "retained" and kinds["plan:premise"] == "retained"
    leaks = vl.old_on_page(items, [{"number": 2, "text": "Old Tom waved."}, {"number": 3, "text": "No one."}])
    assert leaks == [{"id": "char:old-tom", "name": "Old Tom", "chapters": [2]}]
    c = vl.counts(items, {"char:mara-vell:sheet:secret": {"status": "deliberate"}})
    assert c["replaced"] == 1 and c["unresolved"] == 2 and c["removed"] == 0 and c["retained"] > 3
    entry = {"source": {"kind": "rerun", "title": "The Keeper"}, "items": items, "old_on_page": leaks,
             "decisions": {"char:mara-vell:sheet:secret": {"status": "deliberate"},
                           "char:old-tom": {"status": "restore"}}}
    b = vl.brief(entry)
    assert b["earlier_version"] == "rerun of “The Keeper”"
    assert b["deliberate"] == ["Mara Vell: secret: now burned the letter (was: kept the letter)"]
    assert b["restore"] == ["Old Tom (character): removed (was: Old Tom)"]
    assert b["old_names_still_on_page"] == ["Old Tom (chapter 2)"]
    assert vl.brief({"items": [i for i in items if i["kind"] == "retained"]}) is None


# ============================================================================================ in a run
def test_run_tracks_each_chapter_approves_under_consent_and_feeds_the_next_brief(tmp_path):
    fake = ContinuityFake()
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    phys = continuity.get_all(app.store, pid, "main", "physical")["chapters"]
    people = continuity.get_all(app.store, pid, "main", "characters")["chapters"]
    assert set(phys) == set(people) == {"ch1", "ch2", "ch3"}
    for e in list(phys.values()) + list(people.values()):
        assert e["status"] == "approved" and e["approved"]["how"] == "run_consent"
        assert e["approved"]["run_id"] == run["id"] and e["made_by"]["ai"]
    assert phys["ch1"]["scenes"][0]["counts"][0] == {"name": "lamps lit", "value": "31", "running": True}
    # Akọwe's own reading filled in what the AI did not name (the steps of chapter 1)
    assert any(c["name"] == "step" for c in phys["ch1"]["scenes"][0]["counts"])
    # the writer of chapter 2 started from chapter 1's state; chapter 3 from chapters 1-2
    briefs = [ctx.get("writing_brief") or {} for _t, ctx in fake.prompts["C02"]]
    assert "physical_state" not in briefs[0]
    b2 = briefs[1]
    assert b2["physical_state"]["after_chapter"] == 1 and b2["physical_state"]["time"] == "8 o'clock"
    assert b2["physical_state"]["open_hazards"][0]["what"] == "gas leak"
    assert {"name": "lamps lit", "last_value": "31", "running": True} in b2["physical_state"]["counts"]
    assert b2["character_state"][0]["name"] == "Mara Vell" and b2["character_state"][0]["values"]["duty"] == 7
    assert ps.RULE in b2["rules"] and cs.RULE in b2["rules"]
    assert briefs[2]["physical_state"]["after_chapter"] == 2
    assert briefs[2]["physical_state"]["open_hazards"][0]["what"] == "gas leak"  # still open: it must matter
    # the tracker saw the state before the chapter and Akọwe's own reading
    track_ctx = [ctx for _t, ctx in fake.prompts["track"]]
    assert "state_before" not in track_ctx[0] and track_ctx[1]["state_before"]["physical"]["after_chapter"] == 1
    assert track_ctx[0]["akowe_found"] and track_ctx[0]["variables"] == ["duty", "guilt", "fear of exposure",
                                                                             "desire for contact"]
    ev = [e for e in app.autobook.get(run["id"])["events"] if "Continuity of chapter" in e["message"]]
    assert len(ev) == 3 and all("approved under the run consent" in e["message"] for e in ev)
    # the consistency review of chapter 3 had the state before it
    meta_rid = next(r["record_id"] for r in app.store.list_records(pid, "main", "C02", "OUTPUT")
                    if (app.store.get_state(pid, "main", "c_meta", r["record_id"]) or {}).get("unit_id") == "ch3")
    rec = app.store.history(pid, "main", meta_rid)[-1]
    extra = continuity.review_extra(app.store, pid, "main", rec)
    assert extra["continuity"]["physical_state"]["after_chapter"] == 2
    # the page: everything tracked and approved; the gas leak is a question (never resolved, never seen again)
    st, page = route(app, "GET", cpath(pid))
    assert st == 200 and all(r["tracked"] and r["state_approved"] for r in page["chapters"])
    assert page["mains"] == ["Mara Vell"] and page["ledger"] is None
    assert any(p["code"] == "HAZARD_DROPPED" for p in page["checks"]["physical"])
    assert not any(p["code"] == "NO_OWN_ACTION" for p in page["checks"]["characters"])
    # 💾 the book folder holds the continuity report
    files, _info = app.saver.collect(pid, "main")
    md = files["Reports/Continuity.md"].decode("utf-8")
    assert "# Continuity" in md and "gas leak" in md and "Mara Vell" in md and "Make-a-book" not in md


def test_run_with_the_plain_mock_and_with_a_failing_ai_falls_back_to_akowe(tmp_path):
    class DownForChapterOne(BookFakeAI):  # generic answers: the tracker gets an empty list back …
        def _answer(self, ctx, props, schema):
            if "tracked_scenes" in props and (ctx.get("chapter") or {}).get("number") == 1:
                raise AkoweError("UPSTREAM_UNAVAILABLE", "", "the AI is down")  # … except for chapter 1
            return super()._answer(ctx, props, schema)
    fake = DownForChapterOne()
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    phys = continuity.get_all(app.store, pid, "main", "physical")["chapters"]
    assert set(phys) == {"ch1", "ch2", "ch3"}
    assert all(e["made_by"]["kind"] == "akowe" and e["status"] == "approved" for e in phys.values())
    assert phys["ch1"]["scenes"][0]["time"] == "before dawn" and phys["ch3"]["scenes"][0]["tide"] == "low tide"
    assert continuity.get_all(app.store, pid, "main", "characters")["chapters"] == {}
    notes = [e["message"] for e in app.autobook.get(run["id"])["events"] if "Continuity of chapter" in e["message"]]
    assert "could not track it (UPSTREAM_UNAVAILABLE)" in notes[0] and "Akọwe only" in notes[0]
    assert all("nothing usable" in n for n in notes[1:])
    # the baseline pipeline (scenes off) does not track at all
    app2 = make_app(tmp_path, name="d2", fake=BookFakeAI())
    run2 = run_book(app2, {"length": "short_story", "pipeline": {"preset": "baseline"}})
    assert run2["status"] == "done"
    assert continuity.get_all(app2.store, run2["project_id"], "main", "physical")["chapters"] == {}


# ============================================================================================ routes
def test_routes_track_edit_approve_variables_and_errors(tmp_path):
    fake = ContinuityFake()
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story", "pipeline": {"flags": {"scenes": False}}})
    assert run["status"] == "done"
    pid = run["project_id"]
    st, page = route(app, "GET", cpath(pid))
    assert st == 200 and not any(r["tracked"] for r in page["chapters"])  # scenes off: nothing tracked in the run
    from akowe import pipeline  # noqa: PLC0415
    pipeline.save(app.store, pid, pipeline.clean(None))  # switch the book's pipeline back on (the brief uses it then)
    # ⚡ quick read without AI (immediate)
    st, out = route(app, "POST", cpath(pid, "/track"), {"ai": False})
    assert st == 200 and len(out["results"]) == 3 and not any(r["ai"] for r in out["results"])
    # 🧭 with AI (a job), one chapter
    st, job = route(app, "POST", cpath(pid, "/track"), {"chapter_ids": ["ch2"]})
    assert st == 202
    j = wait_job(app, job["job_id"])
    assert j["status"] == "done" and j["results"][0]["ai"] and j["results"][0]["characters"]["version"] == 1
    e2 = continuity.get_chapter(app.store, pid, "main", "physical", "ch2")
    assert e2["version"] == 2 and e2["status"] == "draft" and e2["made_by"]["ai"]
    # drafts never reach the writer
    outline = BookPath(app.engine, "author", pid, "main").outline()
    brief, _m = chapter_brief.build(app.store, pid, "main", outline, "ch3")
    assert "physical_state" not in (brief or {})
    # approving needs the author's confirmation, and the version they saw
    with pytest.raises(AkoweError) as ei:
        route(app, "POST", cpath(pid, "/chapter/ch2/approve"), {})
    assert ei.value.code == "APPROVAL_REQUIRED"
    with pytest.raises(AkoweError) as ei:
        route(app, "POST", cpath(pid, "/chapter/ch2/approve"), {"author_confirms": True, "versions": {"physical": 1}})
    assert ei.value.code == "VERSION_CONFLICT"
    st, out = route(app, "POST", cpath(pid, "/chapter/ch2/approve"), {"author_confirms": True,
                                                                      "versions": {"physical": 2, "characters": 1}})
    assert st == 200 and out["approved"]["physical"]["approved"]["how"] == "author"
    brief, _m = chapter_brief.build(app.store, pid, "main", outline, "ch3")
    assert brief["physical_state"]["after_chapter"] == 2 and brief["character_state"][0]["name"] == "Mara Vell"
    # the author edits by hand: a new draft version (a stale version is refused)
    st, out = route(app, "PUT", cpath(pid, "/chapter/ch2"), {"physical": {"version": 2, "scenes": [
        {"time": "midnight", "hazards": [{"what": "rotten boards", "status": "open", "effect": "walk the edge"}]}]}})
    assert st == 200 and out["saved"]["physical"]["version"] == 3 and out["saved"]["physical"]["status"] == "draft"
    with pytest.raises(AkoweError) as ei:
        route(app, "PUT", cpath(pid, "/chapter/ch2"), {"physical": {"version": 2, "scenes": []}})
    assert ei.value.code == "VERSION_CONFLICT"
    with pytest.raises(AkoweError) as ei:
        route(app, "PUT", cpath(pid, "/chapter/nope"), {"physical": {"scenes": []}})
    assert ei.value.code == "INVALID_INPUT"
    with pytest.raises(AkoweError):
        route(app, "POST", cpath(pid, "/track"), {"chapter_ids": ["nope"]})
    with pytest.raises(AkoweError):
        route(app, "POST", cpath(pid, "/track"), {"ai": "yes"})
    # variables
    st, out = route(app, "PUT", cpath(pid, "/variables"), {"variables": ["Loyalty", "fear of the sea"]})
    assert out["variables"] == ["loyalty", "fear_of_the_sea"]
    assert route(app, "GET", cpath(pid))[1]["variables"] == ["loyalty", "fear_of_the_sea"]
    # not ours → 404
    with pytest.raises(Exception) as ei:
        route(app, "GET", cpath(pid, "/nothing"))
    assert "no such endpoint" in str(ei.value)


def test_two_readings_routes_ai_suggestion_test_and_brief(tmp_path):
    fake = ContinuityFake()
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    pid = run["project_id"]
    page = route(app, "GET", cpath(pid))[1]
    myst = page["ambiguity"]["mysteries"]
    assert len(myst) == 1 and myst[0]["text"] == "Who the stranger on the reef was."
    with pytest.raises(AkoweError):
        route(app, "POST", cpath(pid, "/readings/test"), {})  # no readings yet
    st, job = route(app, "POST", cpath(pid, "/readings/ai"), {})
    j = wait_job(app, job["job_id"])
    assert j["status"] == "done" and j["results"][0]["items"] == 1
    st, job = route(app, "POST", cpath(pid, "/readings/test"), {})
    j = wait_job(app, job["job_id"])
    assert j["status"] == "done", j
    res = j["results"][0]["results"][0]
    assert res["verdict"] == "PASS" and all(r["status"] == "holds" for r in res["readings"])
    # the test is read by another AI than the writer when one works (here only one: allowed)
    assert fake.prompts["two_readings"][0][1]["book"]["chapters"]
    outline = BookPath(app.engine, "author", pid, "main").outline()
    brief, _m = chapter_brief.build(app.store, pid, "main", outline, "ch3")
    assert brief["two_readings"][0]["readings"] == ["Someone: The stranger left the keeper on the reef.",
                                                    "Accident: The keeper slipped on the reef and drowned."]
    assert "weaker" not in brief["two_readings"][0] and amb.RULE in brief["rules"]
    # a test where one reading is contradicted by the page marks it weaker for the writer
    fake.test_script.append(lambda ctx: {"results": [{"id": m["id"], "readings": [
        {"label": "Someone", "supports": [], "contradictions": [
            {"chapter": 2, "quote": "only the stranger had come back", "why": "x"}]},
        {"label": "Accident", "supports": [{"chapter": 3, "quote": "the reef rose out of the water", "why": ""}],
         "contradictions": []}]} for m in ctx["mysteries"]]})
    j = wait_job(app, route(app, "POST", cpath(pid, "/readings/test"), {})[1]["job_id"])
    assert j["results"][0]["results"][0]["weaker"] == "Someone"
    brief, _m = chapter_brief.build(app.store, pid, "main", outline, "ch3")
    assert brief["two_readings"][0]["weaker"] == "Someone"
    # the author edits one reading: its old test result is dropped
    e = amb.get_entry(app.store, pid, "main")
    rid = e["items"][0]["id"]
    st, out = route(app, "PUT", cpath(pid, "/readings"), {"version": e["version"], "items": [{"id": rid, "readings": [
        {"label": "Someone", "text": "Nessa's brother left him there."},
        {"label": "Accident", "text": "The keeper slipped on the reef and drowned."}]}]})
    assert st == 200 and not out["entry"]["test"]["results"]
    with pytest.raises(AkoweError):
        route(app, "PUT", cpath(pid, "/readings"), {"items": [{"id": "not-a-mystery", "readings": [
            {"label": "a", "text": "b"}, {"label": "c", "text": "d"}]}]})


def test_version_ledger_of_a_rerun_decisions_and_brief(tmp_path):
    fake = ContinuityFake()
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    pid = run["project_id"]
    st, page = route(app, "GET", cpath(pid))
    assert page["ledger"] is None
    with pytest.raises(AkoweError):
        route(app, "POST", cpath(pid, "/ledger"), {})  # not a rerun / variant
    r = app.autobook.start("author", {"author_confirms": True, "from_bible": {"project_id": pid}, "reuse_plan": True})
    app.autobook.wait_for(r["id"], 240)
    run2 = app.autobook.get(r["id"])
    assert run2["status"] == "done", run2.get("problem")
    new = run2["project_id"]
    ev = [e["message"] for e in run2["events"] if "Version ledger" in e["message"]]
    assert len(ev) == 1 and "0 replaced" in ev[0] and "0 unresolved" in ev[0]
    led = vl.get_entry(app.store, new, "main")
    assert led["source"]["kind"] == "rerun" and led["counts"]["retained"] > 5
    # the author changes Mara's secret in the new book on purpose
    mara = next(c for c in chars_mod.canon_characters(app.store, new, "main") if c["name"] == "Mara Vell")
    sheet = dict(chars_mod.get_entry(app.store, new, "main", mara["record_id"])["sheet"],
                 secret="Mara burned the stranger's letter")
    chars_mod.save_entry(app.store, new, "main", mara["record_id"], sheet=sheet)
    st, out = route(app, "POST", cpath(new, "/ledger"), {})
    led = out["ledger"]
    assert led["counts"]["unresolved"] == 1
    item = next(i for i in led["items"] if i["kind"] != "retained")
    assert item["id"] == "char:mara-vell:sheet:secret" and item["new"] == "Mara burned the stranger's letter"
    with pytest.raises(AkoweError) as ei:
        route(app, "POST", cpath(new, "/ledger/decide"), {"decisions": {item["id"]: "deliberate"}})
    assert ei.value.code == "APPROVAL_REQUIRED"
    with pytest.raises(AkoweError):
        route(app, "POST", cpath(new, "/ledger/decide"), {"author_confirms": True, "decisions": {item["id"]: "maybe"}})
    st, out = route(app, "POST", cpath(new, "/ledger/decide"), {"author_confirms": True, "version": led["version"],
                                                               "decisions": {item["id"]: "deliberate"}})
    assert out["ledger"]["counts"]["replaced"] == 1 and out["ledger"]["counts"]["unresolved"] == 0
    # the writer and the consistency reviewer are told not to change it back
    outline = BookPath(app.engine, "author", new, "main").outline()
    brief, _m = chapter_brief.build(app.store, new, "main", outline, "ch2")
    vc = brief["version_changes"]
    assert vc["deliberate"] == ["Mara Vell: secret: now Mara burned the stranger's letter (was: Mara Vell kept the "
                                "stranger's letter)"]
    assert vl.RULE in brief["rules"]
    rid = next(r["record_id"] for r in app.store.list_records(new, "main", "C02", "OUTPUT"))
    extra = continuity.review_extra(app.store, new, "main", app.store.history(new, "main", rid)[-1])
    assert extra["continuity"]["version_changes"]["deliberate"] == vc["deliberate"]
    # rebuilding keeps the decision; the page shows the ledger
    route(app, "POST", cpath(new, "/ledger"), {})
    page = route(app, "GET", cpath(new))[1]
    assert page["ledger"]["decisions"][item["id"]]["status"] == "deliberate"
    md = continuity.render_markdown(app, new, "main")
    assert "## Version ledger" in md and "[deliberate] Mara Vell: secret" in md


def test_version_ledger_source_of_a_variant(tmp_path):
    app = make_app(tmp_path, fake=ContinuityFake())
    run = run_book(app, {"length": "short_story"})
    pid = run["project_id"]
    other = app.engine.bootstrap_project("author", "A variant", settings={"variant_of": pid})
    bible, src = vl.source_of(app, other)
    assert src == {"kind": "variant", "title": bible["profile"]["title"], "project_id": pid}
    assert vl.source_of(app, pid) == (None, None)
    led = vl.build(app, other, "main")
    assert led["source"]["kind"] == "variant" and led["counts"]["unresolved"] > 0  # an empty book: all removed
    assert all(i["kind"] in ("removed", "retained") for i in led["items"])
