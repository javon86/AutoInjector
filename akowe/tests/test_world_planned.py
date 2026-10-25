"""Section 4: story-rules ledger (P9), world texture (P10), planned-to-page check (P11), ending and style choices (P12).

Pure parts (cleaning, the "bounded?" lint, briefs and budgets, the ending-state matrix, texture usage counts, the
planned items and their deterministic check), storage as companion data (author edits with a version check, AI drafts,
AI updates as proposals), the prompts they flow into (premise/plot/outline, scene cards, the C02 brief, the editor and
the consistency review), editor findings for rule violations and an explained mystery, the planned-to-page fix through
the P5 rewrite machinery (missing -> fix -> resolved), Make-a-book end to end with all of it, failures that never block
the book, and the HTTP endpoints."""
from __future__ import annotations

import json
import time

import pytest

from akowe import editor as ed_mod
from akowe import editor_rubric, journal, planned as planned_mod, prose_audit, story_choices, story_rules
from akowe import texture as texture_mod
from akowe.book_path import BookPath
from akowe.errors import AkoweError
from akowe.review import ReviewJob

from autobook_fake import RULES, TEXTURE
from test_failover_review import SlotFake, make_app, no_provider_sleep, run_book  # noqa: F401
from test_server import call  # noqa: F401

CHOICES = {"ending": "open", "explain": "leave", "darkness": "real", "dialogue": "lots"}
MUST = "Her master taught her to read the tide-tables by candlelight"


def steps(run):
    return {s["id"]: s for s in run["steps"]}


def outbox(app, pid, et):
    return [json.loads(r["payload"]) for r in app.store.query(
        "SELECT payload FROM outbox WHERE project_id=? AND event_type=? ORDER BY rowid", (pid, et))]


def wait_job(app, job):
    for _ in range(600):
        j = app.review.get_job("author", job["job_id"])
        if j["status"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def book(tmp_path, fake=None, body=None, editor=False, name="data"):
    fake = fake or SlotFake()
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"), name=name)
    if not editor:
        app.review.editor.save_settings({"enabled": False})
    run = run_book(app, dict({"slot_id": "AI-1"}, **(body or {})))
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    return app, fake, run


def chapters(app, pid):
    bp = BookPath(app.engine, "author", pid, "main")
    outline = bp.outline()
    out = []
    for c in bp.outline_chapters(outline):
        _ctx, latest, appr = bp.chapter_prose(outline, c["chapter_id"])
        out.append((c["chapter_id"], appr or latest))
    return bp, outline, out


# ====================================================================== P12 pure: choices and the ending matrix
def test_choices_clean_matrix_brief_rules_and_relax():
    assert story_choices.clean(None) == {} and story_choices.clean({"ending": "", "pace": "ai"}) == {}
    for bad, path in (({"ending": "happy"}, "/choices/ending"), ({"matrix": {"guilt": "gone"}}, "/choices/matrix/guilt"),
                      ({"matrix": {"nope": "x"}}, "/choices/matrix/nope"), ("open", "/choices")):
        with pytest.raises(AkoweError) as e:
            story_choices.clean(bad)
        assert e.value.code == "INVALID_INPUT" and e.value.errors[0]["path"] == path
    ch = story_choices.clean({"ending": "bittersweet", "explain": "leave", "matrix": {"guilt": "displaced"}})
    m = story_choices.matrix(ch)
    # the preset, then "how much is explained" on the mystery row, then the author's own row
    assert m == {"external_plot": "complete", "decision": "made", "relationships": "damaged", "guilt": "displaced",
                 "social": "pending", "mystery": "protected", "identity": "known"}
    assert story_choices.matrix({}) == {} and story_choices.brief({}) is None
    assert story_choices.mystery_mode({"explain": "explain"}) == "explained"
    b = story_choices.brief(dict(ch, dialogue="lots", pace="fast", humor="some", darkness="real"))
    assert b["ending_matrix"]["mystery"] == "protected" and b["dialogue"].startswith("lots")
    assert len(json.dumps(b)) <= story_choices.BRIEF_MAX
    assert "ending_matrix" not in story_choices.brief(ch, ending=False)
    rules = " ".join(story_choices.rules(dict(ch, darkness="real", dialogue="little")))
    assert "ending-state" in rules and "relationships damaged" in rules and "Mysteries stay unexplained" in rules
    assert "Peril level real" in rules and "dialogue little" in rules
    assert any("gentle" in x for x in story_choices.scene_rules({"darkness": "gentle"}))
    notes = story_choices.editor_notes({"ending": "open", "explain": "explain", "darkness": "gentle"})
    assert "ending_openness" in notes and "explained by the end" in notes["protected_mysteries"]
    assert story_choices.relax({"explain": "explain", "darkness": "gentle", "ending": "open"}) == {
        "protected_mysteries": -2, "tension_stakes": -1, "ending_openness": 1}
    # the editor's PASS/REVISE uses it: explaining is wanted, so a 5 on protected_mysteries is no reason to rewrite
    s8 = {"protected_mysteries": 5, "subtext": 8}
    assert ed_mod.decide(s8, [], "normal")[0] == "REVISE"
    assert ed_mod.decide(s8, [], "normal", {"protected_mysteries": -2})[0] == "PASS"
    assert ed_mod.decide({"ending_openness": 6}, [], "normal", {"ending_openness": 1})[0] == "REVISE"
    assert story_choices.summary(ch)[0] == "Ending: Bittersweet"
    info = story_choices.field_info()
    assert [c["key"] for c in info["choices"]] == ["ending", "explain", "darkness", "dialogue", "pace", "humor"]
    assert len(info["matrix"]) == 7


# ====================================================================== P9 pure: the ledger
def test_rules_clean_lint_and_bounded_briefs():
    rules = story_rules.clean_rules({"rules": [
        {"category": "hard", "text": "The lamp only lights with the brass key.", "scope": ""},
        {"category": "belief", "text": "The drowned keepers guide the light.", "stated_by": ""},
        {"category": "mystery", "text": "Who the stranger was.", "id": "m1"},
        {"category": "seen", "text": "Boats turn for home.", "scope": "clear nights only"},
        {"category": "nope", "text": "x"}, {"category": "seen", "text": ""}, "junk",
        {"category": "hard_rule", "text": "The tide comes in twice a day."}]})
    assert [r["category"] for r in rules] == ["hard_rule", "belief", "mystery", "seen", "hard_rule"]
    assert [r["id"] for r in rules] == ["r1", "r2", "m1", "r4", "r5"] and all(r["status"] == "active" for r in rules)
    codes = {(p["rule"], p["code"]) for p in story_rules.lint(rules)}
    # "only" without limits: an unbounded exception (major); a plain hard rule without limits (minor)
    assert ("r1", "UNBOUNDED_EXCEPTION") in codes and ("r5", "NO_LIMITS") in codes and ("r2", "BELIEF_NO_HOLDER") in codes
    assert not any(r == "r4" for r, _c in codes)
    entry = {"rules": rules + [dict(rules[0], id="r9", text="Retired.", status="retired")]}
    picked = story_rules.chapter_rules(entry, "Mara turns for home in the boats", mystery_mode="explained", last=False)
    cats = [p["category"] for p in picked]
    assert cats[0] == "Protected mystery" and "Hard rule" in cats and "Retired." not in json.dumps(picked)
    assert picked[0]["keep"].startswith("stays unexplained until")
    assert story_rules.chapter_rules(entry, mystery_mode="explained", last=True)[0]["keep"].startswith("may be")
    many = {"rules": [dict(rules[0], id=f"r{i}", text=f"Rule number {i} " + "x" * 250, scope="y" * 290)
                      for i in range(24)]}
    big = story_rules.chapter_rules(many)
    assert len(json.dumps(big)) <= story_rules.BRIEF_BUDGET and len(big) <= story_rules.BRIEF_MAX_RULES
    assert story_rules.chapter_rules(None) == []
    applied = story_rules.apply_choices(rules, {"explain": "explain"})
    assert "may be explained at the end" in next(r for r in applied if r["category"] == "mystery")["scope"]


# ====================================================================== P10 pure: texture and its usage
def test_texture_clean_usage_and_pattern_finding():
    items = texture_mod.clean_items({"texture": [
        {"kind": "weather", "detail": "The evening tide floods the steps", "causes": "obstacle", "effect": "cut off",
         "words": "tide, flooded steps"},
        {"kind": "bogus", "detail": "Brass scissors trim the wick", "causes": "?", "words": []},
        {"detail": ""}, "junk"]})
    assert [i["id"] for i in items] == ["t1", "t2"] and items[1]["kind"] == "work" and items[1]["causes"] == "obstacle"
    assert items[0]["words"] == ["tide", "flooded steps"] and items[1]["words"]  # derived from the detail
    assert texture_mod.problems(items) == [{"item": "t2", "code": "NO_EFFECT", "severity": "minor",
                                            "message": texture_mod.problems(items)[0]["message"]}]
    text = ("The tides were high. " * 3) + "Her boots slipped on the flooded step. " + "Nothing else. " * 20
    u = texture_mod.usage(text, items)
    rows = {r["id"]: r for r in u["items"]}
    assert rows["t1"]["count"] == 4 and rows["t1"]["used"] and not rows["t2"]["used"] and u["unused"] == 1
    many = "The tide turned. " * 12
    rep = prose_audit.audit(many, settings={"texture": items})
    assert rep["stats"]["texture"]["overused"] == 1
    f = next(x for x in rep["findings"] if x["check"] == "texture_overused")
    assert f["passages"] and f["severity"] == "minor" and prose_audit.brief(rep)["texture"]["overused"] == 1
    bu = texture_mod.book_usage([("ch1", "the tide"), ("ch2", "no detail here")], items)
    assert next(r for r in bu["items"] if r["id"] == "t1")["chapters"] == ["ch1"]
    # the chapter brief: items its scene cards name first, bounded
    entry = {"items": texture_mod.clean_items({"texture": TEXTURE})}
    cb = texture_mod.chapter_brief(entry, [{"texture": ["t4"]}], "a quiet chapter")
    assert cb[0]["id"] == "t4" and len(cb) <= texture_mod.BRIEF_ITEMS
    assert len(json.dumps(texture_mod.scene_brief(entry))) <= texture_mod.SCENE_BUDGET


# ====================================================================== P11 pure: deterministic check and anchors
def test_planned_check_text_ai_merge_and_findings():
    items = [{"id": "i1", "kind": "name", "label": "Name", "text": "Mara Vell", "name": "Mara Vell", "words": [],
              "required": True},
             {"id": "i2", "kind": "beat", "label": "Beat", "text": "Mara climbs the lighthouse and finds the log",
              "words": planned_mod.keywords("Mara climbs the lighthouse and finds the log"), "required": True},
             {"id": "i3", "kind": "must_show", "label": "Must show", "text": MUST, "words": planned_mod.keywords(MUST),
              "required": True},
             {"id": "i4", "kind": "scene_goal", "label": "Goal", "text": "wants the money", "words": ["money"],
              "required": False}]
    text = ("# The light\n\nMara climbed the lighthouse in the fog. She found the keeper's log on the table.\n\n"
            "Tom watched the harbor from the quay for a long while.")
    res = planned_mod.check_text(text, items)
    st = {i["id"]: i["status"] for i in res}
    assert st == {"i1": "on_page", "i2": "on_page", "i3": "missing", "i4": "missing"}
    c = planned_mod.counts(res)
    assert c["missing"] == 1 and c["optional_missing"] == 1
    # the AI checker: "on page" counts only with a quote that is really in the chapter
    merged = planned_mod.apply_ai(res, {"items": [{"id": "i3", "on_page": True, "quote": "not in the text"}]}, text)
    assert next(i for i in merged if i["id"] == "i3")["status"] == "missing"
    merged = planned_mod.apply_ai(res, {"items": [{"id": "i3", "on_page": True,
                                                   "quote": "Tom watched the harbor from the quay"}]}, text)
    assert next(i for i in merged if i["id"] == "i3")["status"] == "on_page"
    fs = planned_mod.findings_for(text, res)
    assert len(fs) == 1 and fs[0]["dimension"] == "planned_to_page" and fs[0]["passage"] in text
    assert text.count(fs[0]["passage"]) == 1 and MUST in fs[0]["suggestion"]
    assert editor_rubric.LABELS["planned_to_page"] == "Planned but not on the page"


# ====================================================================== Make a book end to end with all of Section 4
def test_make_a_book_end_to_end_with_rules_texture_planned_and_choices(tmp_path):
    fake = SlotFake()
    fake.planned_fix = True
    app, fake, run = book(tmp_path, fake, {"choices": CHOICES}, editor=True)
    pid = run["project_id"]
    st = steps(run)
    ids = [s["id"] for s in run["steps"]]
    assert ids.index("world") == ids.index("characters") + 1 and ids.index("planned") == ids.index("chapters") + 1
    assert st["world"]["state"] == "done" and "Story rules" in st["world"]["message"]
    assert st["planned"]["state"] == "done"
    # P12: the choices are in the profile and in every planning prompt
    prof = app.review.bp("author", pid, "main").profile
    assert prof["choices"] == CHOICES
    for op in ("B01", "B03", "B11"):
        sys_, ctx = fake.prompts[op][-1]
        assert ctx["story_choices"]["darkness"].startswith("real") and "Peril level real" in sys_
    assert "ending_matrix" not in fake.prompts["B01"][-1][1]["story_choices"]
    assert fake.prompts["B03"][-1][1]["story_choices"]["ending_matrix"]["mystery"] == "protected"
    assert "ending-state" in fake.prompts["B11"][-1][0]
    # P9: drafted after the characters, updated for the plan as proposals accepted under the run consent
    entry = story_rules.get_entry(app.store, pid, "main")
    assert entry["version"] == 2 and len(story_rules.active(entry)) == len(RULES) + 1 and not entry["proposals"]
    dec = outbox(app, pid, "rules.proposals_decided")
    assert dec and dec[-1]["how"] == "run_consent" and dec[-1]["run_id"] == run["id"]
    assert any("Story rules updated for the plan" in e["message"] for e in run["events"])
    assert fake.prompts["rules"][1][1]["current_rules"]  # the update saw the current ledger
    assert "story_rules" in fake.prompts["B03"][-1][1] and "never break a hard rule" in fake.prompts["B03"][-1][0]
    # P10: the scene planner got the texture list; obstacles come from it and name its ids
    _sys, sctx = fake.prompts["scenes"][0]
    assert sctx["world_texture"] and "context.world_texture" in _sys and "Peril level real" in _sys
    bp = BookPath(app.engine, "author", pid, "main")
    from akowe import scenes as scenes_mod
    card = scenes_mod.get_entry(app.store, pid, "main", bp.outline()["record_id"], "ch1")["cards"][0]
    tex = {i["id"]: i for i in texture_mod.get_entry(app.store, pid, "main")["items"]}
    assert card["texture"] and card["obstacle"] == tex[card["texture"][0]]["detail"]
    # the writer: rules, texture, must-show details and the style; the ending matrix only in the last chapter
    first, last = fake.prompts["C02"][0], fake.prompts["C02"][-1]
    wb = first[1]["writing_brief"]
    cats = {r["category"] for r in wb["story_rules"]}
    assert {"Hard rule", "Protected mystery"} <= cats and wb["world_texture"] and "ending_matrix" not in wb["story_choices"]
    assert "never break a hard rule" in first[0] and "only if it causes something" in first[0]
    assert last[1]["writing_brief"]["story_choices"]["ending_matrix"]["external_plot"] == "incomplete"
    assert any(MUST in m for p in fake.prompts["C02"] for m in p[1]["writing_brief"].get("must_show") or [])
    # the editor: the story_rules dimension, the protected mysteries and the ending/mystery expectations
    crafts = list(app.review.editor.crafts(pid, "main").values())
    assert crafts and all("story_rules" in c["scores"] for c in crafts)
    assert all(c.get("relaxed") == {"protected_mysteries": 1, "ending_openness": 1} for c in crafts)
    ectx = fake.craft_contexts[-1]
    assert ectx["story_rules"]["protected_mysteries"] == ["Who the stranger on the reef was."]
    assert ectx["world_texture"] and "ending-state" in fake.prompts["craft"][-1][0]
    # the consistency review of a chapter and of the plot had the rules
    assert any("story_rules" in c for _s, c in fake.prompts["review"])
    # P11: the must-show detail was missing, the writer worked it in, the fix was kept and approved
    _bp, _o, chs = chapters(app, pid)
    texts = {cid: rec["data"]["text"] for cid, rec in chs}
    assert any(MUST in t for t in texts.values())
    ps = run["planned_summary"]
    assert ps["checked"] == 3 and ps["fixed"] >= 1
    assert any(e.get("code") == "PLANNED_FIX_KEPT" for e in run["events"])
    items = {i["id"]: i for i in st["chapters"]["items"]}
    assert all("planned" in i for i in items.values())
    assert "planned_rewrite" in fake.kinds and "planned" in fake.kinds
    checks = outbox(app, pid, "planned.checked")
    assert checks and all(c["independent"] in (True, None) for c in checks)
    # the planned checker is never the writer (AI-1 wrote; AI-2 checks)
    assert {s for s, k in fake.per_slot if k == "planned"} == {"AI-2"}
    # the journal: numbers only (no rule, texture or chapter text)
    jr = json.dumps(journal.build(app, pid, "main"))
    assert "Story rules" in jr and "Planned to page" in jr
    for secret in (RULES[0]["text"], TEXTURE[0]["detail"], MUST):
        assert secret not in jr


def test_planned_missing_is_flagged_and_never_blocks(tmp_path):
    fake = SlotFake()  # planned_fix off: the writer's fix changes nothing -> ⚠️ PLANNED_MISSING, the book is made
    app, fake, run = book(tmp_path, fake)
    flagged = run["planned_summary"]["flagged"]
    assert flagged and any(MUST in m for f in flagged for m in f["missing"])
    assert any(e.get("code") == "PLANNED_UNRESOLVED" for e in run["events"])
    assert any(e.get("code") == "PLANNED_MISSING" for e in run["events"])
    assert run["planned_summary"]["book"]["missing"] >= 1
    assert "⚠️" in steps(run)["planned"]["message"]
    # the checker failing never blocks the book either; a TIMEOUT pauses the step
    fake2 = SlotFake()
    fake2.kind_failures["planned"] = [AkoweError("INTERNAL_ERROR", "", "garbage")] * 3
    app2, fake2, run2 = book(tmp_path, fake2, name="d2")
    assert any(e.get("code") == "PLANNED_CHECK_FAILED" for e in run2["events"])
    fake3 = SlotFake()
    fake3.kind_failures["planned"] = [AkoweError("TIMEOUT", "", "slow")]
    app3 = make_app(tmp_path, fake3, slots=("AI-1", "AI-2"), name="d3")
    app3.review.editor.save_settings({"enabled": False})
    run3 = run_book(app3, {"slot_id": "AI-1"})
    assert run3["status"] == "paused" and run3["problem"]["code"] == "TIMEOUT"
    assert "planned" in run3["problem"]["message"]
    out = app3.autobook.resume("author", run3["id"])
    app3.autobook.wait_for(out["id"], 180)
    assert app3.autobook.get(run3["id"])["status"] == "done"


def test_world_failures_never_block_the_book(tmp_path):
    fake = SlotFake()
    fake.kind_failures["rules"] = [AkoweError("INTERNAL_ERROR", "", "no")]
    fake.kind_failures["texture"] = [AkoweError("INTERNAL_ERROR", "", "no")]
    app, fake, run = book(tmp_path, fake)
    codes = {e.get("code") for e in run["events"]}
    assert {"RULES_FAILED", "TEXTURE_FAILED"} <= codes
    assert story_rules.get_entry(app.store, run["project_id"], "main") is None
    # no ledger: the prompts simply have no rules (and nothing breaks)
    assert "story_rules" not in fake.prompts["C02"][0][1]["writing_brief"]


def test_old_runs_get_the_section_4_steps():
    from akowe.autobook import STEP_IDS, AutoBookService
    run = {"steps": [{"id": s, "state": "done"} for s in ("backup", "profile", "canon", "characters", "premise")]}
    AutoBookService._ensure_steps(run)
    assert [s["id"] for s in run["steps"]] == STEP_IDS
    assert next(s for s in run["steps"] if s["id"] == "world")["state"] == "pending"


# ====================================================================== the author's flows outside runs
def test_rules_author_edits_ai_proposals_and_decisions(tmp_path):
    app, fake, run = book(tmp_path)
    pid = run["project_id"]
    rv = app.review
    info = rv.world_info("author", pid, "main")
    e = info["rules"]
    assert e and info["fields"]["rules"]["categories"][0]["key"] == "hard_rule" and info["texture"]["items"]
    assert info["rules_changed"] == []  # updated for the plan in the run
    rules = [dict(r) for r in e["rules"]]
    rules[1]["scope"] = ""
    rules.append({"category": "hard_rule", "text": "The key works only once per night"})
    out = rv.save_rules("author", pid, "main", {"rules": rules, "version": e["version"]})
    assert out["entry"]["version"] == e["version"] + 1 and out["entry"]["made_by"]["kind"] == "author"
    assert any(p["code"] == "UNBOUNDED_EXCEPTION" for p in out["lint"])
    with pytest.raises(AkoweError) as x:
        rv.save_rules("author", pid, "main", {"rules": rules, "version": e["version"]})
    assert x.value.code == "VERSION_CONFLICT"
    for body, path in (({"rules": "x"}, "/rules"), ({"rules": [{"category": "x", "text": "y"}]}, "/rules/0/category"),
                       ({"rules": [{"category": "belief", "text": " "}]}, "/rules/0/text")):
        with pytest.raises(AkoweError) as x:
            rv.save_rules("author", pid, "main", body)
        assert x.value.code == "INVALID_INPUT" and x.value.errors[0]["path"] == path
    # ✨ suggest updates: stored as proposals, nothing changes until the author decides
    j = wait_job(app, rv.start_world_ai("author", pid, "main", "rules", {"update": True}))
    assert j["status"] == "done", j
    e2 = story_rules.get_entry(app.store, pid, "main")
    props = e2["proposals"]["items"]
    assert e2["version"] == out["entry"]["version"] and {p["action"] for p in props} >= {"add", "retire"}
    with pytest.raises(AkoweError) as x:
        rv.decide_rule_proposals("author", pid, "main", {"accept": []})
    assert x.value.code == "APPROVAL_REQUIRED"
    first = props[0]["id"]
    d = rv.decide_rule_proposals("author", pid, "main", {"author_confirms": True, "version": e2["version"],
                                                          "accept": [first]})
    assert d["entry"]["version"] == e2["version"] + 1 and not d["entry"]["proposals"]
    assert outbox(app, pid, "rules.proposals_decided")[-1] == {"version": d["entry"]["version"], "accepted": 1,
                                                               "rejected": len(props) - 1, "how": "author",
                                                               "run_id": None}
    with pytest.raises(AkoweError) as x:
        rv.decide_rule_proposals("author", pid, "main", {"author_confirms": True})
    assert x.value.code == "INVALID_INPUT"
    # texture: author edit with a version check; ✨ again with AI
    t = rv.world_info("author", pid, "main")["texture"]
    out = rv.save_texture("author", pid, "main", {"items": t["items"][:2] + [{"kind": "people", "detail": "Old Pell "
                                                  "sells bait and gossip", "causes": "cost", "words": "bait"}],
                                                  "version": t["version"]})
    assert len(out["entry"]["items"]) == 3 and out["entry"]["items"][2]["words"] == ["bait"]
    with pytest.raises(AkoweError) as x:
        rv.save_texture("author", pid, "main", {"items": [], "version": out["entry"]["version"]})
    assert x.value.code == "INVALID_INPUT"
    j = wait_job(app, rv.start_world_ai("author", pid, "main", "texture", {}))
    assert j["status"] == "done" and j["results"][0]["entry"]["version"] == out["entry"]["version"] + 1
    usage = rv.world_info("author", pid, "main")["texture_usage"]
    assert usage and usage["words"] > 0 and len(usage["items"]) == len(TEXTURE)
    # the ledger goes "out of date" when the plan changes (a new approved outline revision)
    now = story_rules.basis(BookPath(app.engine, "author", pid, "main"))
    assert story_rules.changed_since(dict(e2, basis=dict(now, B11="other:1")), now) == ["chapter outline"]


def test_editor_flags_rule_violations_and_an_explained_mystery(tmp_path):
    fake = SlotFake()
    fake.chapter_texts = {"ch2": "# The quay\n\nMara asked every captain about the night the light went dark. "
                                 "In truth the stranger was the keeper's brother, come back from the dead. "
                                 "It was proved that the drowned keepers guide the light."}
    fake.rule_flags = {"the stranger was the keeper's brother": "protected_mysteries",
                       "proved that the drowned keepers": "story_rules"}
    app, fake, run = book(tmp_path, fake)
    pid = run["project_id"]
    bp, _o, chs = chapters(app, pid)
    rec = dict(chs)["ch2"]
    resp = bp.dispatch("C02", "UPDATE", base_ref=rec["ref"], payload=dict(rec["data"]))
    rid = resp["output_refs"][0]["record_id"]
    j = wait_job(app, app.review.start_editor("author", pid, "main", {"record_id": rid}))
    assert j["status"] == "done", j
    craft = j["results"][0]["craft"]
    dims = {f["dimension"]: f for f in craft["findings"]}
    assert {"protected_mysteries", "story_rules"} <= set(dims)
    assert dims["protected_mysteries"]["found"] and "stranger was" in dims["protected_mysteries"]["passage"]
    assert dims["story_rules"]["label"] == "Story rules kept" and craft["verdict"] == "REVISE"
    ctx = fake.craft_contexts[-1]
    assert ctx["story_rules"]["rules"] and ctx["story_rules"]["protected_mysteries"]
    # ✍ the writer rewrites only those passages (P5)
    prop = wait_job(app, app.review.start_editor_fix("author", pid, "main", {"record_id": rid}))["results"][0]["proposal"]
    assert prop["applied"] == 2
    out = app.review.apply_editor_fix("author", pid, "main", {"record_id": rid, "version": prop["version"]})
    text = app.review._head(pid, "main", rid)["data"]["text"]
    assert out["ok"] and "keeper's brother" not in text and "nobody knew" in text


def test_plot_and_outline_reviews_get_the_rules_bounded_note(tmp_path):
    app, fake, run = book(tmp_path)
    pid = run["project_id"]
    e = story_rules.get_entry(app.store, pid, "main")
    rules = [dict(r) for r in e["rules"]] + [{"category": "hard_rule", "text": "The brass key only works sometimes."}]
    app.review.save_rules("author", pid, "main", {"rules": rules, "version": e["version"]})
    bp = BookPath(app.engine, "author", pid, "main")
    plot = bp.approved("B03")[0]
    resp = bp.dispatch("B03", "UPDATE", base_ref=plot["ref"], payload=dict(plot["data"]))
    rid = resp["output_refs"][0]["record_id"]
    job = ReviewJob("review", "author", pid, "main", [rid], None)
    job.started, job.status = time.time(), "running"
    app.review.review_one(job, rid, auto=False)
    sys_, ctx = fake.prompts["review"][-1]
    assert any("only works sometimes" in x for x in ctx["story_rules"]["not_bounded"])
    assert "not bounded" in sys_
    j = wait_job(app, app.review.start_editor("author", pid, "main", {"record_id": rid}))
    assert "rules_bounded" in j["results"][0]["craft"]["scores"]
    assert "Story rules bounded" in fake.prompts["craft"][-1][0] or "rules_bounded" in fake.prompts["craft"][-1][0]


def test_planned_missing_fix_with_ai_then_resolved(tmp_path):
    app, fake, run = book(tmp_path)  # planned_fix off in the run: the must-show detail stays missing
    pid = run["project_id"]
    rv = app.review
    bp, _o, chs = chapters(app, pid)
    target = next(rec for _cid, rec in chs
                  if any(MUST in i["text"] for i in rv.planned_info("author", pid, "main", rec["record_id"])["items"]))
    rid = target["record_id"]
    info = rv.planned_info("author", pid, "main", rid)
    must = next(i for i in info["items"] if i["kind"] == "must_show")
    assert must["status"] == "missing" and info["counts"]["missing"] >= 1 and info["stored"]
    # 🔎 check again with AI (an independent checker), then ✨ Fix with AI -> a proposal for the author
    j = wait_job(app, rv.start_planned("author", pid, "main", rid, {}))
    assert j["status"] == "done" and j["results"][0]["check"]["ai"]["slot"] == "AI-2"
    fake.planned_fix = True
    j = wait_job(app, rv.start_planned("author", pid, "main", rid, {}, fix=True))
    assert j["status"] == "done", j
    prop = j["results"][0]["proposal"]
    assert all(i["dimension"] == "planned_to_page" for i in prop["items"])
    assert any(i["ok"] and MUST in i["replacement"] for i in prop["items"])
    assert rv.editor_info("author", pid, "main", rid)["proposal"]["items"][0]["dimension"] == "planned_to_page"
    out = rv.apply_editor_fix("author", pid, "main", {"record_id": rid, "version": prop["version"]})
    assert out["ok"] and out["version"] == prop["version"] + 1
    after = rv.planned_info("author", pid, "main", rid)
    assert next(i for i in after["items"] if i["kind"] == "must_show")["status"] == "on_page"
    assert after["version"] == out["version"] and after["stored"] is None  # the new version is not AI-checked yet
    # the book-level list follows the approved text (the new version waits for approval)
    bk = rv.planned_book("author", pid, "main")
    assert bk["counts"]["chapters"] == 3 and isinstance(bk["missing"], list)
    with pytest.raises(AkoweError) as x:
        rv.planned_info("author", pid, "main", "nope")
    assert x.value.code == "NOT_FOUND"


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
    for _ in range(600):
        st, j, _ = call(port, "GET", f"/api/projects/{pid}/branches/main/review/ai/{job['job_id']}")
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_http_world_planned_and_choices(served):
    app, port, run = served
    pid = run["project_id"]
    base = f"/api/projects/{pid}/branches/main/review"
    st, ci, _ = call(port, "GET", "/api/story-choices")
    assert st == 200 and ci["choices"][0]["key"] == "ending" and ci["presets"]["open"]["mystery"] == "protected"
    st, prof, _ = call(port, "PUT", f"/api/projects/{pid}/profile", {"choices": {"ending": "dark", "pace": "slow"}})
    assert st == 200 and prof["choices"] == {"ending": "dark", "pace": "slow"} and prof["title"]
    st, e, _ = call(port, "PUT", f"/api/projects/{pid}/profile", {"choices": {"ending": "happy"}})
    assert st == 400 and e["errors"][0]["path"] == "/choices/ending"
    st, w, _ = call(port, "GET", f"{base}/world")
    assert st == 200 and w["rules"]["rules"] and w["texture"]["items"] and w["fields"]["texture"]["kinds"]
    st, out, _ = call(port, "PUT", f"{base}/world/rules", {"rules": w["rules"]["rules"], "version": 0})
    assert st == 409 and out["errors"][0]["code"] == "VERSION_CONFLICT"
    st, out, _ = call(port, "PUT", f"{base}/world/rules", {"rules": w["rules"]["rules"], "version": w["rules"]["version"]})
    assert st == 200 and out["entry"]["version"] == w["rules"]["version"] + 1
    st, job, _ = call(port, "POST", f"{base}/world/rules/ai", {"update": True})
    assert st == 202 and http_job(port, pid, job)["status"] == "done"
    st, e, _ = call(port, "POST", f"{base}/world/rules/proposals", {"accept": []})
    assert st == 400 and e["errors"][0]["code"] == "APPROVAL_REQUIRED"
    st, e, _ = call(port, "POST", f"{base}/world/bogus/ai", {})
    assert st == 404
    st, out, _ = call(port, "PUT", f"{base}/world/texture", {"items": [{"detail": "x"}], "version": w["texture"]["version"]})
    assert st == 200 and out["entry"]["items"][0]["kind"] == "work"
    st, e, _ = call(port, "POST", f"{base}/world/texture/ai", {"update": "yes"})
    assert st == 400 and e["errors"][0]["path"] == "/update"
    st, bk, _ = call(port, "GET", f"{base}/planned")
    assert st == 200 and bk["counts"]["chapters"] == 3
    rid = next(r for r in bk["chapters"] if r.get("written"))["record_id"]
    st, pi, _ = call(port, "GET", f"{base}/planned/{rid}")
    assert st == 200 and pi["items"] and pi["kind_words"]["beat"]
    st, job, _ = call(port, "POST", f"{base}/planned/{rid}/check", {})
    assert st == 202 and http_job(port, pid, job)["status"] == "done"
    st, e, _ = call(port, "GET", f"{base}/planned/nope")
    assert st == 404
    st, book_, _ = call(port, "GET", f"/api/projects/{pid}/branches/main/book")
    assert st == 200
