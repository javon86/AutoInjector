"""🧠 Smart memory with chapter needs lists (needs_list.py), end to end with the fake AI: the planner writes a needs
list with each chapter's scene cards, Akọwe validates it, the writer gets exactly the listed Book Bible sections
(and nothing else), an empty listed section is filled just in time once, what the page used without planning it is
logged, the reviewer and the checkpoints check the list (naming single-field codes) and the size saving is measured."""
from __future__ import annotations

import json
import time
import types

import pytest

from akowe import chapter_brief, costs, forge, needs_list, providers as prov_mod, scenes as scenes_mod
from akowe import story_details
from akowe.book_path import BookPath

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book, steps

BR = "main"


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def done(run):
    assert run["status"] == "done", (run["phase"], [(s["id"], s["state"], s.get("problem")) for s in run["steps"]])
    return run


def outline_of(app, pid):
    return BookPath(app.engine, "author", pid, BR).outline()


def chapter_ids(app, pid):
    return [c["chapter_id"] for c in BookPath.outline_chapters(None, outline_of(app, pid))]


def needs_for(ctx):
    """The fake planner's needs lists, like a real plan: Mara's looks in chapters 1 and 2 (with a single-field, an
    unknown and a wrong-kind code, and a character the book does not have), the brass key's powers and Mara's injuries
    and belongings when the key is used, relationships later; each later chapter points back to the one before."""
    n = int((ctx.get("chapter") or {}).get("number") or 1)
    if n <= 2:
        out = {"things": [{"thing": "Mara Vell", "kind": "character", "sections": ["C11", "C1c", "Z9", "P33"],
                           "note": "her looks"},
                          {"thing": "Nobody Here", "kind": "character", "sections": ["C11"], "note": ""}],
               "earlier": [], "notes": ["N11(Mara)", "N1a"]}
    elif n == 3:
        out = {"things": [{"thing": "The brass key", "kind": "item", "sections": ["I22"], "note": "it is used"}],
               "earlier": [], "notes": ["N22(Mara)"]}
    else:
        out = {"things": [{"thing": "Mara", "kind": "character", "sections": ["C55(Tom)"], "note": "she and Tom"}],
               "earlier": [], "notes": ["N33"]}
    if n > 1:
        out["earlier"] = [{"chapter": n - 1, "moment": "Mara climbed the steps of the old lighthouse with a lantern"
                           if n == 2 else "the captains looked away"}]
    return out


# ============================================================================================ 1. validation (no AI)
def test_clean_upgrades_field_codes_and_drops_bad_ones():
    raw = {"things": [{"thing": "Mara", "kind": "character", "sections": ["C11", "C1c", "X99", "P33", "C55(Tom)",
                                                                           "C44"], "note": "why"},
                      {"thing": "Harbour tower", "kind": "place", "sections": ["P33", "P55"], "note": ""},
                      {"thing": "Fog-spell", "kind": "", "sections": ["M22"], "note": ""},
                      {"thing": "", "kind": "item", "sections": ["I22"], "note": ""}],
           "earlier": [{"chapter": 3, "moment": "Tom gives Mara the key"}, {"chapter": "x", "moment": "?"}],
           "notes": ["N11(Mara)", "N4a", "C11", "N44(betrayal)"]}
    n = needs_list.clean(raw)
    mara = n["things"][0]
    assert [s["code"] for s in mara["sections"]] == ["C11", "C55", "C44"]  # C1c -> C11 (already there)
    assert mara["sections"][1]["about"] == "Tom"
    assert n["things"][2]["kind"] == "magic"  # the kind told by the codes
    assert [(x["code"], x.get("about")) for x in n["notes"]] == [("N11", "Mara"), ("N44", None),
                                                                 ("N44", "betrayal")]
    dropped = " | ".join(n["dropped"])
    assert "“C1c” is one detail; the whole section C11 was asked instead" in dropped
    assert "“X99” is not a code" in dropped and "“P33” is a place code" in dropped and "“C11” is a character code" \
        in dropped and "without a number" in dropped
    assert needs_list.line(n, 7) == ("Chapter 7 needs: Mara C11, C55(Tom), C44 · Harbour tower P33, P55 · Fog-spell "
                                     "M22 · Notes N11(Mara), N44, N44(betrayal) · Earlier: chapter 3 (Tom gives Mara "
                                     "the key)")
    v = needs_list.view(n, 7)
    looks = v["things"][0]["sections"][0]
    assert looks["label"] == "Looks" and ["C1c", "Eyes"] in looks["fields"]
    assert needs_list.clean(None) is None and needs_list.clean({"things": [], "earlier": [], "notes": []}) is None


def test_find_passage_matches_the_moment():
    text = ("# One\n\nThe fog came in. Tom held out the brass key and Mara took it without a word. "
            "She put it in her coat. Later the gulls screamed.")
    q = needs_list.find_passage(text, "Tom gives Mara the key")
    assert q.startswith("Tom held out the brass key") and len(q) <= needs_list.PASSAGE_CHARS
    assert needs_list.find_passage(text, "a dragon over the mountains") == ""


# ============================================================================================ 2. in a run
@pytest.fixture(scope="module")
def smart_book(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("smart")
    fake = BookFakeAI()
    fake.needs = needs_for
    fake.story_ledger = True
    fake.chapter_texts["ch2"] = ("Down in the harbor the fishing boats knocked together. Mara Vell narrowed her green "
                                 "eyes at the captains, and every captain looked away.\n\nOnly old Nessa at the net "
                                 "sheds would talk: the keeper had gone out to the reef with a stranger.")
    app = make_app(tmp, fake=fake)
    run = done(run_book(app, {"genre": "Mystery", "length": "novelette"}))
    return app, fake, run


def test_planner_needs_list_is_stored_with_the_scene_cards_and_validated(smart_book):
    app, fake, run = smart_book
    pid = run["project_id"]
    outline = outline_of(app, pid)
    cids = chapter_ids(app, pid)
    e = scenes_mod.get_entry(app.store, pid, BR, outline["record_id"], cids[1])
    n = e["needs"]
    things = {t["thing"]: t for t in n["things"]}
    assert "Nobody Here" not in things  # not one of the book's characters
    assert [s["code"] for s in things["Mara Vell"]["sections"]] == ["C11"] and things["Mara Vell"]["record_id"]
    assert any("Z9" in d for d in n["dropped"]) and any("P33" in d for d in n["dropped"])
    assert any("Nobody Here" in d for d in n["dropped"])
    assert [(x["code"], x.get("about")) for x in n["notes"]] == [("N11", "Mara"), ("N11", None)]
    # the planner was told what it may name: the codes and the book's records
    ctx = fake.prompts["scenes"][-1][1]
    assert "C11 Looks" in ctx["code_sections"]["character"] and "N44" in ctx["code_sections"]["notes"]
    assert "Needs list" in fake.prompts["scenes"][-1][0]


def test_brief_has_exactly_the_listed_sections(smart_book):
    app, fake, run = smart_book
    pid = run["project_id"]
    outline = outline_of(app, pid)
    cids = chapter_ids(app, pid)
    brief, meta = chapter_brief.build(app.store, pid, BR, outline, cids[1], measure=True)
    names = {d["name"]: d for d in brief["needed_details"]}
    assert set(names) <= {"Mara Vell", "The brass key"} and "Mara Vell" in names
    mara = names["Mara Vell"]["details"]
    assert mara["C1c Eyes"] == "storm-grey eyes" and "C1d Hair" in mara
    assert all(k.split()[0].startswith("C1") for k in mara)  # only C11 (Looks) codes: nothing unlisted
    # nothing the list did not ask for: no keyword-guessed details, no place details, no other character's dossier
    assert "character_details" not in brief and "world_details" not in brief and "fixed_details" not in brief
    assert "Tom Reed" not in json.dumps(brief.get("needed_details"))
    assert "world_texture" not in brief  # W55 was not asked for
    # the always-on essentials stay
    assert brief["voice_cards"] and brief["scene_cards"] and brief["pov"]["name"] == "Mara Vell"
    assert brief.get("story_so_far") or brief.get("previous_chapter_end")
    # the running notes: only the sections asked for (N11 → the people lines), the story so far kept
    led = brief.get("story_ledger") or {}
    assert set(led) <= {"people", "left_out"}
    # the earlier chapter's moment, quoted from its text
    em = brief["earlier_moments"][0]
    assert em["chapter"] == 1 and "hundred and twelve steps of the old lighthouse" in em["passage"]
    assert needs_list.RULE in brief["rules"] and needs_list.EARLIER_RULE in brief["rules"]
    assert brief["needs_list"].startswith("Chapter 2 needs: Mara C11")
    # the size: smaller than the old way
    sm = meta["smart_memory"]
    assert sm["chars"] == meta["chars"] and sm["old_chars"] > 0
    old, _m = chapter_brief.build(app.store, pid, BR, outline, cids[1], use_needs=False)
    assert "needed_details" not in old and ("fixed_details" in old or "world_texture" in old)  # the old way


def test_size_metric_in_the_run_and_the_time_page(smart_book):
    app, fake, run = smart_book
    pid = run["project_id"]
    items = steps(run)["chapters"]["items"]
    mem = [i.get("memory") for i in items]
    assert all(m and m["old_chars"] and m["chars"] for m in mem), mem
    bm = needs_list.book_metric(app.store, pid, BR)
    assert bm["chapters"] == len(items) and bm["saved_pct"] > 0 and bm["chars"] < bm["old_chars"]
    assert sum(1 for m in mem if m["chars"] < m["old_chars"]) > len(mem) // 2  # most chapters got smaller
    assert bm["line"] == f"🧠 Smart memory saved ~{bm['saved_pct']}% of instruction size"
    c = costs.book_costs(app, pid, BR)
    assert c["smart_memory"]["saved_pct"] == bm["saved_pct"]
    assert bm["line"] in costs.render_markdown(c)
    print(f"\nSMART MEMORY: {bm['chars']} vs {bm['old_chars']} characters -> saved {bm['saved_pct']}% "
          f"({[ (r['number'], r['chars'], r['old_chars']) for r in bm['per_chapter']]})")


def test_unplanned_use_is_logged_and_learned_and_listed_by_the_checkpoint(smart_book):
    app, fake, run = smart_book
    pid = run["project_id"]
    msgs = [e["message"] for e in app.autobook.get(run["id"])["events"] if e.get("code") == "NEEDS_UNPLANNED"]
    assert any(m.startswith("🧠 Chapter 1 also used") and "Tom Reed (not planned)" in m for m in msgs), msgs
    learned = needs_list.learned(app.store, pid, BR, 3)
    assert any("Chapter 1 also used Tom Reed (not planned)" == x for x in learned)
    # the next plan was told
    later = [ctx for _t, ctx in fake.prompts["scenes"] if (ctx.get("chapter") or {}).get("number") == 2]
    assert any("Chapter 1 also used Tom Reed (not planned)" in (ctx.get("needs_learned") or []) for ctx in later)
    from akowe import checkpoints
    rep = checkpoints.report(app.store, pid, BR)
    assert any("Chapter 1 also used Tom Reed (not planned)" in rep_c["unplanned"] for rep_c in rep)
    assert "🧠 Chapter 1 also used Tom Reed (not planned)" in "\n".join(checkpoints.markdown(rep))


def test_reviewer_and_checkpoint_get_the_list_and_name_the_field_code(smart_book):
    app, fake, run = smart_book
    revs = [ctx for _t, ctx in fake.prompts.get("review", []) if ctx.get("needs_list")]
    assert revs, "the chapter reviewer got no needs list"
    flagged = [f for ctx in revs for f in ctx["needs_list"]["akowe_flags"]]
    assert any("Mara Vell C1c (eyes) doesn't match" in f and "storm-grey" in f for f in flagged), flagged
    assert all(ctx["needs_note"] == needs_list.REVIEW_NOTE for ctx in revs)
    cps = [(t, ctx) for t, ctx in fake.prompts.get("checkpoint", []) if ctx.get("needs_lists")]
    assert cps, "no checkpoint got the needs lists"
    rows = [r for _t, ctx in cps for r in ctx["needs_lists"]]
    assert any("Mara Vell C1c (eyes)" in m for r in rows for m in r.get("mismatches") or [])
    assert any(r["needs"].startswith("Chapter 2 needs:") for r in rows)
    assert any(needs_list.CHECK_NOTE.strip()[:40] in t for t, _c in cps)


def test_page_info_for_the_chapter_page_and_the_book_bible(smart_book):
    app, fake, run = smart_book
    pid = run["project_id"]
    outline = outline_of(app, pid)
    cid = chapter_ids(app, pid)[1]
    info = needs_list.page_info(app.store, pid, BR, outline, cid, 2)
    assert info["needs"]["line"].startswith("Chapter 2 needs: Mara C11") and info["smart_memory"]["old_chars"] > 0
    assert info["smart_memory"]["line"].startswith("🧠 Smart memory")
    from akowe import binder
    data = binder.build(app, pid, BR)
    pages = [p for p in data["pages"] if p.get("template") == "11" and p.get("entry_id") == cid]
    assert pages and pages[0]["needs_list"]["needs"]["line"].startswith("Chapter 2 needs:")
    # the chapter page (✅ Planned to page) carries it too
    _ctx, _latest, appr = BookPath(app.engine, "author", pid, BR).chapter_prose(outline, cid)
    q = app.review.planned.quick("author", pid, BR, appr["record_id"])
    assert q["needs_list"]["needs"]["line"].startswith("Chapter 2 needs:") and q["needs_list"]["number"] == 2


def test_with_the_whole_book_bible_filled_it_saves_more_and_asks_nothing_just_in_time(tmp_path):
    fake = BookFakeAI()
    fake.needs = needs_for
    fake.story_ledger = True
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"genre": "Mystery", "length": "novelette", "fill_bible": True}))
    pid = run["project_id"]
    assert steps(run)["bible"]["state"] == "done"
    # every listed section was already filled: no just-in-time call for them
    asks = [ctx for _t, ctx in fake.prompts.get("details", []) if ctx.get("chapter")]
    assert not [s for ctx in asks for s in ctx["subjects"] if s["name"] == "Mara Vell"]
    bm = needs_list.book_metric(app.store, pid, BR)
    assert bm["saved_pct"] >= 15, bm  # a fuller Book Bible: the old way guessed much more
    print(f"\nSMART MEMORY (whole Book Bible filled): {bm['chars']} vs {bm['old_chars']} -> {bm['saved_pct']}%")


# ============================================================================================ 3. just in time + fallback
def test_an_empty_listed_section_is_filled_just_in_time_once(tmp_path):
    fake = BookFakeAI()
    fake.needs = lambda ctx: {"things": [{"thing": "Mara Vell", "kind": "character", "sections": ["C66"],
                                          "note": "her skills"}], "earlier": [], "notes": []}
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"genre": "Mystery", "length": "novelette"}))
    pid = run["project_id"]
    asks = [ctx for _t, ctx in fake.prompts.get("details", []) if ctx.get("chapter")]
    mara_asks = [(ctx["chapter"]["number"], sorted(k.split("__", 1)[1] for k in s["fields"]))
                 for ctx in asks for s in ctx["subjects"] if s["name"] == "Mara Vell"]
    assert len(mara_asks) == 1 and mara_asks[0][0] == 1, mara_asks  # once: chapter 1; later chapters have it
    c66 = {fk.split(":", 1)[1] for c in needs_list.code_map.expand("C66")
           for fk in needs_list.code_map.fields()[c]["forge"]}
    assert set(mara_asks[0][1]) <= c66 and "practical_skills" in mara_asks[0][1]
    from akowe import characters as chars_mod
    mara = next(c for c in chars_mod.canon_characters(app.store, pid, BR) if c["name"] == "Mara Vell")
    f = {x["key"]: x for s in forge.public(app.store, pid, BR, mara["record_id"])["sections"] for x in s["fields"]}
    assert f["practical_skills"]["text"] and f["practical_skills"]["status"] == "approved"
    # and the writer of chapter 2 got it under its code
    brief, _m = chapter_brief.build(app.store, pid, BR, outline_of(app, pid), chapter_ids(app, pid)[1])
    det = brief["needed_details"][0]["details"]
    assert any(k.startswith("C6a ") for k in det) and all(k.startswith("C6") for k in det)


def test_old_plans_without_a_needs_list_keep_the_keyword_guessing(tmp_path):
    fake = BookFakeAI()  # no needs list: a plan made before smart memory
    app = make_app(tmp_path, fake=fake)
    run = done(run_book(app, {"genre": "Mystery", "length": "novelette"}))
    pid = run["project_id"]
    outline = outline_of(app, pid)
    cids = chapter_ids(app, pid)
    e = scenes_mod.get_entry(app.store, pid, BR, outline["record_id"], cids[0])
    assert "needs" not in e
    brief, meta = chapter_brief.build(app.store, pid, BR, outline, cids[0], measure=True)
    assert "needed_details" not in brief and "needs_list" not in brief and "smart_memory" not in meta
    assert brief.get("character_details") or brief.get("world_details")  # the old way, unchanged
    assert all("memory" not in i for i in steps(run)["chapters"]["items"])
    assert needs_list.book_metric(app.store, pid, BR) is None
    assert not [e for e in app.autobook.get(run["id"])["events"] if e.get("code") == "NEEDS_UNPLANNED"]
    assert costs.book_costs(app, pid, BR)["smart_memory"] is None
    # an author's edit of the scene cards keeps a needs list made for the same outline (and none appears from nowhere)
    scenes_mod.save_cards(app.store, pid, BR, outline, cids[0], e["cards"], by="author", how="edited")
    assert "needs" not in scenes_mod.get_entry(app.store, pid, BR, outline["record_id"], cids[0])
    nl = needs_list.clean({"things": [{"thing": "Mara Vell", "kind": "character", "sections": ["C11"], "note": ""}],
                           "earlier": [], "notes": []}, app.store, pid, BR)
    scenes_mod.save_cards(app.store, pid, BR, outline, cids[0], e["cards"], by="ai", needs=nl)
    scenes_mod.save_cards(app.store, pid, BR, outline, cids[0], e["cards"], by="author", how="edited")
    assert scenes_mod.get_entry(app.store, pid, BR, outline["record_id"], cids[0])["needs"]["things"][0]["thing"] \
        == "Mara Vell"
    assert story_details.ledger(app.store, pid, BR)["chapters"]  # the just-in-time ledger worked as before
