"""🚀 Launch kit (launch_kit.py): the KDP keyword rules, the length limits, the canon cross-check (invented names,
numbers, claims), the spoiler check (names first met after the spoiler point, sentences built from the secret plan),
the categories and age range, and — with a stand-in AI — making the kit, its versions and approvals, 🔁 Fix with AI
(the problems go to the AI; the plan after the spoiler point never does), 🔎 Check with AI, the A+ module pictures
and the Launch kit/ folder of the book save."""
from __future__ import annotations

import json
import time

import pytest

from akowe import launch_kit as lk
from akowe.errors import AkoweError

from launch_fake import LaunchFake, good_listing
from test_failover_review import make_app, run_book


# ====================================================================== pure checks (no AI, no book)
def kinds(issues):
    return [i["kind"] for i in issues]


GOOD_KW = ["cozy lighthouse mystery", "small harbor town secrets", "amateur sleuth heroine", "foggy coastal village",
           "missing mentor mystery", "eerie seaside cozy", "apprentice keeper story"]


def test_keywords_good_set_has_no_problems():
    assert lk.keyword_checks(GOOD_KW, title="The Keeper of Gullhaven", author="Rowan Ashby") == []


def test_keyword_rules_length_banned_authors_trademarks_repeats_and_count():
    kws = ["a" * 51, "bestseller cozy mystery", "free mystery books", "kindle unlimited cozy", "like stephen king",
           "harry potter for adults", "cozy lighthouse mystery", "Cozy lighthouse mystery"]
    out = lk.keyword_checks(kws, title="T", author="Rowan Ashby", comp_authors=["Richard Osman"])
    ks = kinds(out)
    assert "count" in ks and out[0]["severity"] == "problem"               # 8 > 7 boxes
    assert any(i["kind"] == "length" and i["where"] == "keywords:1" for i in out)
    banned = [i["where"] for i in out if i["kind"] == "banned"]
    assert {"keywords:2", "keywords:3", "keywords:4"} <= set(banned)
    assert any(i["kind"] == "author" and i["where"] == "keywords:5" for i in out)
    assert any(i["kind"] == "trademark" and i["where"] == "keywords:6" for i in out)
    assert any(i["kind"] == "repeat" and i["where"] == "keywords:8" for i in out)
    # a comparable title's author never belongs in the keywords either
    out = lk.keyword_checks(["cozy like richard osman"], comp_authors=["Richard Osman"])
    assert "author" in kinds(out)
    # too few boxes used is only a hint
    few = lk.keyword_checks(GOOD_KW[:4])
    assert kinds(few) == ["count"] and few[0]["severity"] == "check"
    # the pen name in a keyword is wasted space
    assert "redundant" in kinds(lk.keyword_checks(["rowan ashby mysteries"], author="Rowan Ashby"))


def test_length_limits_of_the_texts():
    assert lk._length_checks("blurb_short", " ".join(["word"] * 150)) == []
    short = lk._length_checks("blurb_short", " ".join(["word"] * 40))
    assert kinds(short) == ["length"] and "only 40 words" in short[0]["message"]
    long_ = lk._length_checks("blurb_short", " ".join(["word"] * 250))
    assert kinds(long_) == ["length"] and "250 words" in long_[0]["message"]
    huge = lk._length_checks("blurb_long", "x" * 4100)
    assert huge[0]["severity"] == "problem" and "4000" in huge[0]["message"]
    two = lk._length_checks("hook", "The light went out. Mara has a winter to find out why it did and who did it.")
    assert "more than one sentence" in two[0]["message"]
    ph = lk._length_checks("author_bio", "Rowan Ashby lives in [where you live] and writes cozy mysteries " * 4)
    assert "placeholder" in kinds(ph)


CANON = {
    "profile": {"title": "The Keeper of Gullhaven", "author": "Rowan Ashby", "genre": "Mystery", "audience": "Adult",
                "idea": "When the Gullhaven lighthouse goes dark, Mara Vell searches for her missing master."},
    "entries": [{"name": "Mara Vell", "kind": "character", "role": "protagonist", "aliases": [], "about": ""},
                {"name": "Tom Reed", "kind": "character", "role": "mentor", "aliases": ["Old Tom"], "about": ""},
                {"name": "Silas Crane", "kind": "character", "role": "antagonist", "aliases": [], "about": ""},
                {"name": "Gullhaven Harbor", "kind": "place", "role": "", "aliases": [], "about": ""}],
    "premise": {"premise": "An apprentice keeper searches a fog-bound harbor for her vanished master."},
    "main_plot": "", "mysteries": ["The keeper drowned the smuggler's brother long ago."],
    "chapters": [
        {"number": 1, "chapter_id": "ch1", "plan": "Mara climbs to the dark lighthouse and finds Tom Reed's log",
         "text": "Mara Vell climbed the steps. Tom Reed's logbook lay open."},
        {"number": 2, "chapter_id": "ch2", "plan": "Mara questions the harbor captains", "text": "The captains lied."},
        {"number": 3, "chapter_id": "ch3", "plan": "Silas Crane is unmasked as the wrecker who poisoned the beacon",
         "text": "Silas Crane laughed on the cliff."},
        {"number": 4, "chapter_id": "ch4", "plan": "Mara rescues Tom from the flooded cellar of the chapel",
         "text": "The chapel cellar flooded."}]}


def test_canon_check_catches_invented_names_and_numbers_but_not_canon():
    good = "In the harbor of Gullhaven, apprentice keeper Mara Vell looks for Old Tom when the light goes dark."
    assert lk.canon_checks("blurb_short", good, CANON, 2) == []
    bad = "Mara Vell teams up with Captain Varrow and the witch Elspeth to save Gullhaven in 1842."
    out = lk.canon_checks("blurb_short", bad, CANON, 2)
    names = [i["text"] for i in out if i["kind"] == "invented"]
    assert "Captain Varrow" in names and "Elspeth" in names and all(i["severity"] == "problem" for i in out
                                                                     if i["kind"] == "invented")
    assert [i["text"] for i in out if i["kind"] == "number"] == ["1842"]
    # a sentence's first word is not part of the name ("With Captain Varrow…")
    out = lk.canon_checks("hook", "With Captain Varrow at her side, Mara Vell sails.", CANON, 4)
    assert [i["text"] for i in out] == ["Captain Varrow"]
    # the A+ texts are checked too, and say which module
    aplus = [{"headline": "Meet Mara Vell", "text": "She sails with Captain Varrow.", "image": None}]
    out = lk.canon_checks("aplus", aplus, CANON, 2)
    assert out and out[0]["where"] == "aplus:1" and out[0]["text"] == "Captain Varrow"


def test_claims_akowe_cannot_check():
    out = lk.canon_checks("hook", "The bestselling, award-winning mystery of the year.", CANON, 4)
    assert {i["kind"] for i in out} == {"claim"} and len(out) == 2


def test_spoiler_check_names_and_secret_plan_after_the_cut():
    # Silas Crane first appears in chapter 3: past the midpoint (2 of 4 chapters may be told)
    out = lk.canon_checks("blurb_short", "Mara Vell must stop Silas Crane before the storms.", CANON, 2)
    sp = [i for i in out if i["kind"] == "spoiler"]
    assert sp and "chapter 3" in sp[0]["message"] and sp[0]["severity"] == "problem"
    # a sentence built from chapter 4's plan (rescue, flooded cellar, chapel) gives the ending away
    out = lk.canon_checks("blurb_long", "Can she reach the flooded chapel cellar in time to rescue him?", CANON, 2)
    assert any(i["kind"] == "spoiler" and "chapter 4" in i["message"] for i in out)
    # a protected mystery is a secret too
    out = lk.canon_checks("hook", "Her master drowned the smuggler's brother.", CANON, 2)
    assert any(i["kind"] == "spoiler" and "mystery" in i["message"] for i in out)
    # with the spoiler point at the end (cut = every chapter) nothing is a spoiler
    out = lk.canon_checks("blurb_short", "Mara Vell must stop Silas Crane at the flooded chapel cellar.", CANON, 4)
    assert not [i for i in out if i["kind"] == "spoiler"]
    # a twist word next to a canon name is worth a look
    out = lk.canon_checks("blurb_short", "In the end Tom Reed betrays her.", CANON, 2)
    assert "reveal" in kinds(out)
    assert not lk.canon_checks("blurb_short", "In the end Tom Reed betrays her.", CANON, 4)  # "none": no check


def test_cut_points():
    assert lk.cut_of("midpoint", 10) == 5 and lk.cut_of("midpoint", 3) == 2
    assert lk.cut_of("first_act", 12) == 3 and lk.cut_of("none", 7) == 7 and lk.cut_of("chapter:4", 7) == 4
    assert lk.cut_of("chapter:40", 7) == 7 and lk.cut_of("midpoint", 0) == 0
    with pytest.raises(AkoweError):
        lk.clean_spoiler("the end")


def test_categories_follow_genre_and_audience():
    cats = lk.category_list("Cozy mystery", "Adult")
    assert cats[0].startswith("FICTION / Mystery & Detective") and len(cats) == len(set(cats))
    assert all(c.startswith("YOUNG ADULT FICTION /") for c in lk.category_list("Fantasy", "Young adult"))
    assert all(c.startswith("JUVENILE FICTION /") for c in lk.category_list("Fantasy", "Middle grade"))
    assert lk.genre_keys("space opera") == ["science fiction"] and lk.genre_keys("") == ["literary"]


def test_age_range_and_content_notes_from_the_profile():
    a = lk.age_content({"audience": "Young adult", "content_limits": "no graphic violence", "genre": "Fantasy"})
    assert a["age_range"] == "Ages 13–18" and "no graphic violence" in a["notes"][0]
    assert lk.age_content({"audience": "Middle grade"})["age_range"] == "Ages 8–12"
    assert lk.age_content({"audience": "Children 7-10"})["age_range"] == "Ages 7–10"
    k = lk.age_content({"audience": "children"})
    assert any("children's book" in n for n in k["notes"])
    assert "no content limits" in lk.age_content({"audience": "Adult"})["notes"][0]


def test_as_text_is_what_copy_and_the_txt_files_hold():
    assert lk.as_text("keywords", ["a", "b"]) == "a\nb"
    assert lk.as_text("comps", [{"title": "T", "author": "A", "why": "w"}]) == "T by A — w"
    assert lk.as_text("age_content", {"age_range": "Ages 8–12", "notes": ["n"]}) == "Ages 8–12\nn"
    assert lk.as_text("aplus", [{"headline": "H", "text": "x", "image": None}]).startswith("Module 1: H\nx\n")


# ====================================================================== with a book and a stand-in AI
@pytest.fixture(scope="module")
def kb(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("launch")
    fake = LaunchFake()
    app = make_app(tmp, fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    return app, fake, run["project_id"]


def wait(app, j, principal="author"):
    for _ in range(1000):
        j = app.review.get_job(principal, j["job_id"])
        if j["status"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.01)
    raise AssertionError("the job did not finish")


def field(ov, f):
    return next(x for x in ov["fields"] if x["id"] == f)


def test_make_the_kit_with_ai_versions_approvals_and_the_check(kb):
    app, fake, pid = kb
    j = wait(app, lk.start_generate(app, "author", pid, "main", {}))
    assert j["status"] == "done", j.get("error")
    ctx = fake.launch_contexts[-1]
    # the generator sees the canon and the chapters up to the midpoint, never the rest of the plan
    assert {c["name"] for c in ctx["canon"]} >= {"Mara Vell", "Tom Reed"}
    assert [c["chapter"] for c in ctx["story_so_far"]] == [1, 2] and "reef" not in json.dumps(ctx["story_so_far"])
    assert ctx["category_choices"][0].startswith("FICTION / Mystery")
    ov = lk.overview(app, pid, "main")
    for f in lk.AI_FIELDS:
        x = field(ov, f)
        assert x["current"] == 1 and x["by"] == "ai" and x["approved"] is None, f
    assert field(ov, "age_content")["by"] == "akowe" and field(ov, "age_content")["value"]["age_range"] == "Adults (18+)"
    assert len(field(ov, "keywords")["value"]) == 7
    # the good listing has only the bio's [brackets] to fill in
    assert ov["problems"] == 0 and [i["kind"] for i in field(ov, "author_bio")["issues"]] == ["placeholder"]
    assert field(ov, "comps")["issues"] == [] and field(ov, "blurb_short")["issues"] == []
    # the author edits the hook: a new version (a draft); then approves it
    ov = lk.route(app, "PUT", ["field"], {}, {"field": "hook", "value": "  When the light dies,  Mara Vell must "
                                          "find out who put it out. ", "revision": ov["revision"]}, "author", pid,
                  "main")[1]
    h = field(ov, "hook")
    assert h["current"] == 2 and h["by"] == "author" and h["value"].startswith("When the light dies, Mara")
    ov = lk.approve(app, pid, "main", {"field": "hook", "n": 2})
    assert field(ov, "hook")["approved"] == 2
    with pytest.raises(AkoweError) as e:   # a stale page: refused, never overwrites
        lk.route(app, "PUT", ["field"], {}, {"field": "hook", "value": "x", "revision": 1}, "author", pid, "main")
    assert e.value.code == "VERSION_CONFLICT"
    with pytest.raises(AkoweError):
        lk.approve(app, pid, "main", {"field": "hook", "n": 99})
    # an edit with an invented name and a spoiler is caught at once (no AI)
    ov = lk.route(app, "PUT", ["field"], {}, {"field": "blurb_short", "value": good_listing(ctx)["blurb_short"] +
                                          " With Captain Varrow she finds the brass key wedged in the reef and "
                                          "relights the lamp."}, "author", pid, "main")[1]
    ks = {i["kind"] for i in field(ov, "blurb_short")["issues"]}
    assert {"invented", "spoiler"} <= ks and ov["problems"] >= 2
    # 🔁 Fix with AI: the problems are in the request
    j = wait(app, lk.start_generate(app, "author", pid, "main", {"fields": ["blurb_short"], "fix": True}))
    assert j["status"] == "done"
    ctx = fake.launch_contexts[-1]
    assert ctx["fields"] == ["blurb_short"] and "Captain Varrow" in ctx["current"]["blurb_short"]
    assert any("Captain Varrow" in p["problem"] for p in ctx["problems"])
    assert any("spoiler point" in p["problem"] for p in ctx["problems"])
    ov = lk.overview(app, pid, "main")
    assert field(ov, "blurb_short")["current"] == 3 and field(ov, "blurb_short")["issues"] == []
    assert [v["by"] for v in field(ov, "blurb_short")["versions"]] == ["ai", "author", "ai"]
    # the spoiler point moves to "none": the whole plan may be told
    ov = lk.set_spoiler(app, pid, "main", {"spoiler_point": "none"})
    assert ov["cut"] == ov["chapters"] == 3
    lk.set_spoiler(app, pid, "main", {"spoiler_point": "midpoint"})


def test_ai_check_reads_against_the_secret_plan_and_quotes_are_verified(kb):
    app, fake, pid = kb
    if not lk.newest(lk.doc(app.store, pid, "main"), "blurb_short"):
        wait(app, lk.start_generate(app, "author", pid, "main", {}))
    hero = "Mara"
    fake.check_script.append(lambda ctx: {"issues": [
        {"field": "hook", "kind": "genre", "quote": ctx["listing"]["hook"][:30], "problem": "Too grim for a cozy.",
         "fix": "Lighten it."},
        {"field": "blurb_short", "kind": "spoiler", "quote": "a sentence that is not there", "problem": "Hints at "
         "the reef.", "fix": "Cut it."},
        {"field": "nowhere", "kind": "other", "quote": "", "problem": "x", "fix": "y"}]})
    j = wait(app, lk.start_check(app, "author", pid, "main", {}))
    assert j["status"] == "done", j.get("error")
    ctx = fake.launch_contexts[-1]
    assert ctx["akowe_task"] == "launch_check" and [c["chapter"] for c in ctx["secret"]["chapters"]] == [3]
    assert hero in json.dumps(ctx["canon"])
    ov = lk.overview(app, pid, "main")
    aic = ov["ai_check"]
    assert not aic["stale"] and len(aic["issues"]) == 2           # the unknown field is dropped
    by_f = {i["field"]: i for i in aic["issues"]}
    assert by_f["hook"]["verified"] and not by_f["blurb_short"]["verified"]
    assert by_f["blurb_short"]["severity"] == "problem" and by_f["hook"]["severity"] == "check"
    # a change to the kit makes the AI check out of date
    lk.route(app, "PUT", ["field"], {}, {"field": "hook", "value": "A new hook for Mara Vell."}, "author", pid, "main")
    assert lk.overview(app, pid, "main")["ai_check"]["stale"]
    # 🔁 Fix with AI uses only the AI issues that still match the kit
    j = wait(app, lk.start_generate(app, "author", pid, "main", {"fields": ["hook"], "fix": True}))
    assert j["status"] == "done"
    assert not any(p["problem"] == "Too grim for a cozy." for p in fake.launch_contexts[-1]["problems"])


def test_aplus_pictures_export_and_the_book_save(kb, tmp_path):
    app, fake, pid = kb
    if not lk.newest(lk.doc(app.store, pid, "main"), "aplus"):
        wait(app, lk.start_generate(app, "author", pid, "main", {}))
    mods = lk.current_values(lk.doc(app.store, pid, "main"))["aplus"]
    assert 3 <= len(mods) <= 5 and mods[0]["image"] == "cover"
    st, (_tag, mime, svg, name, _dl) = lk.route(app, "GET", ["aplus", "1"], {}, None, "author", pid, "main")
    assert mime == "image/svg+xml" and name == "a-plus-module-1.svg"
    assert b"data:image/svg+xml;base64," in svg and b"Welcome to Gullhaven Harbor" in svg
    _st, (_t, _m, svg3, _n, _d) = lk.route(app, "GET", ["aplus", "3"], {}, None, "author", pid, "main")
    assert b"<image" not in svg3                                       # a text-only module
    with pytest.raises(AkoweError):
        lk.route(app, "GET", ["aplus", "9"], {}, None, "author", pid, "main")
    with pytest.raises(AkoweError):                                    # JPG: AutoInjector is not running here
        lk.route(app, "GET", ["aplus", "1"], {"format": "jpg"}, None, "author", pid, "main")
    _st, (_t, mime, md, mdname, _d) = lk.route(app, "GET", ["export.md"], {}, None, "author", pid, "main")
    text = md.decode("utf-8")
    assert mdname.endswith(" - launch kit.md") and "## Keywords (7 boxes)" in text
    assert "Suggestions to verify" in text and "DRAFT" in text
    # the book save writes Launch kit/
    files: dict = {}
    lk.save_files(app, pid, "main", files, lambda rel, s: files.__setitem__(rel, s.encode("utf-8")))
    for f, info in lk.FIELDS.items():
        assert f"Launch kit/{info['file']}" in files, f
    kw = files["Launch kit/keywords.txt"].decode("utf-8").strip().splitlines()
    assert len(kw) == 7 and kw[0] == "cozy lighthouse mystery"
    assert files["Launch kit/launch-kit.md"].decode("utf-8").startswith("# Launch kit: The Keeper of Gullhaven")
    assert "Launch kit/a-plus-module-1.svg" in files
    # 📕 Use on the back cover: the blurb goes into the book profile (the 🎨 Cover page's blurb)
    lk.use_on_cover(app, pid, "main", {"field": "blurb_short"})
    from akowe.book_path import get_profile
    assert get_profile(app.store, pid)["blurb"] == lk.newest(lk.doc(app.store, pid, "main"), "blurb_short")["value"]


def test_the_book_save_holds_the_launch_kit_folder(kb):
    app, _fake, pid = kb
    if not lk.newest(lk.doc(app.store, pid, "main"), "keywords"):
        wait(app, lk.start_generate(app, "author", pid, "main", {}))
    files, info = app.saver.collect(pid, "main")
    assert "Launch kit/launch-kit.md" in files and "Launch kit/hook.txt" in files
    assert not [p for p in info.get("skipped_parts") or [] if p["file"].startswith("Launch kit")]
    from akowe import book_save
    assert "Launch kit/" in book_save.README_TEXT


def test_bad_requests_are_plain_errors(kb):
    app, _fake, pid = kb
    for body in ({"fields": ["nope"]}, {"fields": "blurb"}, {"fix": "yes"}):
        with pytest.raises(AkoweError):
            lk.start_generate(app, "author", pid, "main", body)
    with pytest.raises(AkoweError):
        lk.route(app, "PUT", ["field"], {}, {"field": "nope", "value": "x"}, "author", pid, "main")
    with pytest.raises(AkoweError):
        lk.use_on_cover(app, pid, "main", {"field": "keywords"})
    with pytest.raises(AkoweError):
        lk.route(app, "GET", ["nothing"], {}, None, "author", pid, "main")
