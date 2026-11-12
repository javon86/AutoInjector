"""👥 Idea #14: the panel of beta readers (beta_reader.py).

Pure parts: the three default personas from the book profile, the reader's overall verdict (cleaned, the favourite
character checked against the book), one different AI per reader (``assign``: the author's picks, then independent
AIs, then the writer; an AI that is not working is skipped with a note), the request check, the comparison (strong
signals when 2-3 readers flag the same chapter, the same moment when their quotes overlap, disagreements, the heat
map, the top-5 fixes) and the report's Markdown section. On the deterministic fake AI: a ⚡ run with a panel of 3, a
reader whose AI is not working, a reader whose AI fails, a paused panel that continues (resumable), the HTTP API with
an edited persona, the report download and an old single read that still shows.
"""
from __future__ import annotations

import time

import pytest

from akowe import beta_reader as beta
from akowe.errors import AkoweError

from test_failover_review import SlotFake, make_app, run_book

CHAPTERS = [
    {"number": 1, "text": "# One\n\nThe fog rolled in over Gullhaven before dawn. Mara climbed the steps."},
    {"number": 2, "text": "# Two\n\nDown in the harbor the boats knocked together like restless teeth."},
    {"number": 3, "text": "# Three\n\nAt low tide the reef rose out of the water like a sleeping spine."},
]
PROFILE = {"audience": "Young adult (12-18)", "genre": "Mystery", "tone": "Eerie"}


def _read(n, name, *, reactions=(), interest=None, guesses=(), stop=None, overall=None, status="done"):
    """A cleaned read as the panel stores it (verified quotes unless the quote starts with '?')."""
    rx = [{"chapter": c, "kind": k, "quote": q, "note": "", "verified": not q.startswith("?"), "in_chapter": True}
          for c, k, q in reactions]
    return {"n": n, "status": status, "reader": {"slot": f"AI-{n}", "name": name, "independent": True},
            "persona": {"label": f"reader {n}", "a_label": f"a reader {n}"}, "reactions": rx,
            "interest": [{"chapter": c, "score": s, "would_keep_reading": True} for c, s in (interest or [])],
            "guesses": list(guesses), "stop": stop or {"would_finish": True, "chapter": 0, "why": ""},
            "overall": overall, "average_interest": None}


# ====================================================================== personas and the request
def test_three_default_readers_come_from_the_profile():
    ps = beta.personas(PROFILE)
    assert [p["kind"] for p in ps] == ["typical", "picky", "casual"]
    assert ps[0]["text"] == beta.persona(PROFILE)["text"]  # the single reader is reader 1, unchanged
    assert "mystery" in ps[1]["text"] and "picky" in ps[1]["text"] and ps[1]["a_label"] == "a picky reader of mystery"
    assert "slow" in ps[2]["text"] and "Young adult (12-18)" in ps[2]["text"]
    assert all(p["key"] == "young_adult" for p in ps)
    assert "this kind of book" in beta.personas({})[1]["text"]
    mine = beta.custom_persona("  a retired   sailor who hates boats " * 40, ps[1])
    assert mine["kind"] == "picky" and mine["edited"] and len(mine["text"]) <= beta.PERSONA_MAX
    assert mine["text"].startswith("a retired sailor who hates boats")


def test_request_is_checked():
    assert beta.clean_request({}) == {"size": 1, "readers": [{"slot_id": None, "persona": None}], "resume": None}
    assert beta.clean_request({"slot_id": "AI-3"})["readers"] == [{"slot_id": "AI-3", "persona": None}]
    r = beta.clean_request({"size": 3, "readers": [{"slot_id": "AI-2", "persona": "a nurse"}]})
    assert r["size"] == 3 and r["readers"][0] == {"slot_id": "AI-2", "persona": "a nurse"} and len(r["readers"]) == 3
    for bad in ({"size": 4}, {"size": 0}, {"size": True}, {"readers": [{"slot_id": "AI-1"}, {"slot_id": "AI-1"}]},
                {"readers": [{"persona": "x" * 700}]}, {"readers": [{"persona": 5}]}, {"readers": "AI-1"},
                {"readers": [{"slot_id": "AI-9"}]}):
        with pytest.raises(AkoweError):
            beta.clean_request(bad)


def test_each_reader_gets_a_different_ai_and_a_broken_one_is_skipped():
    opts = [{"slot_id": "AI-1", "name": "Claude", "working": True, "independent": False},
            {"slot_id": "AI-2", "name": "ChatGPT", "working": True, "independent": True},
            {"slot_id": "AI-3", "name": "Gemini", "working": False, "independent": True}]
    got = beta.assign(opts, [None, None, None])
    assert [(o and o["slot_id"], why is None) for o, why in got] == [("AI-2", True), ("AI-1", True), (None, False)]
    assert "different AI" in got[2][1]
    got = beta.assign(opts, ["AI-3", None])  # the author's pick is not working: skipped with a note
    assert got[0][0]["slot_id"] == "AI-3" and "not working" in got[0][1] and got[1][0]["slot_id"] == "AI-2"
    got = beta.assign(opts, [None, "AI-2"])  # an automatic reader never takes an AI the author picked
    assert got[0][0]["slot_id"] == "AI-1" and got[1][0]["slot_id"] == "AI-2"
    with pytest.raises(AkoweError):
        beta.assign(opts, ["AI-7"])


def test_overall_verdict_is_cleaned():
    raw = {"reactions": [], "interest": [{"chapter": 1, "score": 7, "would_keep_reading": True}], "guesses": [],
           "stop": {"would_finish": False, "chapter": 2, "why": "slow"}, "summary": "",
           "overall": {"would_recommend": "yes", "favourite_character": "mara", "best_chapter": 1,
                       "worst_chapter": 9, "score": 12, "why": "fine"}}
    ov = beta.clean(raw, CHAPTERS)["overall"]
    assert ov["favourite_in_book"] and ov["would_finish"] is False and ov["would_recommend"] is None
    assert ov["best_chapter"] == 1 and ov["worst_chapter"] is None and ov["score"] is None
    raw["overall"]["favourite_character"] = "Ma"  # a part of a word is not the name
    assert not beta.clean(raw, CHAPTERS)["overall"]["favourite_in_book"]
    del raw["overall"]
    assert beta.clean(raw, CHAPTERS)["overall"] is None  # an older answer: no verdict, still fine


# ====================================================================== the comparison
def test_strong_signals_disagreement_heat_map_and_fixes():
    q = "The fog rolled in over Gullhaven before dawn"
    reads = [
        _read(1, "Claude", reactions=[(1, "confused", q), (2, "hooked", "boats knocked together like restless")],
              interest=[(1, 8), (2, 9), (3, 6)],
              overall={"score": 9, "would_recommend": True, "favourite_character": "Mara", "best_chapter": 2,
                       "worst_chapter": 3}),
        _read(2, "ChatGPT", reactions=[(1, "confused", "rolled in over Gullhaven before dawn. Mara"),
                                       (2, "bored", "Down in the harbor the boats")],
              interest=[(1, 6), (2, 3), (3, 6)],
              overall={"score": 4, "would_recommend": False, "favourite_character": "mara", "best_chapter": 1,
                       "worst_chapter": 2}),
        _read(3, "Gemini", reactions=[(1, "confused", "?a line the AI made up"), (3, "doubted", "the reef rose")],
              interest=[(1, 5), (2, 4), (3, 4)], stop={"would_finish": False, "chapter": 2, "why": "too slow"},
              overall={"score": 6, "would_recommend": False, "favourite_character": "Nessa", "best_chapter": 1,
                       "worst_chapter": 2}),
        _read(4, "Broken", status="failed"),  # a failed reader never counts
    ]
    c = beta.compare(reads, 3)
    assert c["totals"]["readers"] == 3 and c["totals"]["average_score"] == 6.3
    assert c["totals"]["finish"] == 2 and c["totals"]["recommend"] == 1
    assert c["totals"]["favourite"] == {"name": "Mara", "votes": 2}
    assert c["totals"]["worst"] == {"chapter": 2, "votes": 2} and c["totals"]["best"]["chapter"] == 1
    agree = {(g["kind"], g["chapter"]): g for g in c["agree"]}
    lost = agree[("confused", 1)]
    assert lost["count"] == 2 and lost["same_moment"] and lost["names"] == ["Claude", "ChatGPT"]
    assert "2 of 3 readers got lost in chapter 1 — at the same moment" in lost["text"]
    assert agree[("bored", 2)]["count"] == 2  # ChatGPT's bored mark + Gemini's interest 4
    assert ("doubted", 3) not in agree  # one reader only
    assert agree[("worst", 2)]["count"] == 2 and agree[("best", 1)]["positive"]
    ids = {d["id"] for d in c["disagree"]}
    assert {"score", "recommend", "finish", "chapter"} <= ids
    ch2 = next(d for d in c["disagree"] if d["id"] == "chapter" and d["chapter"] == 2)
    assert ch2["liked"] == ["Claude"] and set(ch2["disliked"]) == {"ChatGPT", "Gemini"}
    heat = {x["chapter"]: x for x in c["heat"]}
    assert heat[1]["confused"] == 2 and heat[2]["bored"] == 2 and heat[3]["bored"] == 1  # Gemini's 4 in chapter 3
    assert heat[2]["cells"][0] == {"confused": 0, "bored": False, "interest": 9}
    assert len(c["fixes"]) == beta.TOP_FIXES and all(f["count"] >= 1 for f in c["fixes"])
    top = c["fixes"][0]
    assert top["strong"] and top["count"] == 2 and top["kind"] == "confused" and top["chapter"] == 1 and top["quote"]
    assert all(c["fixes"][i]["count"] >= c["fixes"][i + 1]["count"] for i in range(len(c["fixes"]) - 1))
    assert "3 readers: 2 of 3 would finish it, 1 of 3 would recommend it, average score 6.3/10" in c["headline"]


def test_one_reader_has_no_agreement_and_none_has_nothing():
    c = beta.compare([_read(1, "Claude", reactions=[(1, "confused", "The fog rolled in over")])], 3)
    assert c["agree"] == [] and c["disagree"] == [] and c["fixes"][0]["count"] == 1 and not c["fixes"][0]["strong"]
    empty = beta.compare([], 3)
    assert empty["totals"]["readers"] == 0 and empty["fixes"] == [] and len(empty["heat"]) == 3


def test_same_moment():
    assert beta._same_moment("The fog rolled in", "the fog rolled in over Gullhaven")
    assert beta._same_moment("and then the fog rolled in over Gullhaven", "fog rolled in over Gullhaven before dawn")
    assert not beta._same_moment("The fog rolled in", "Mara climbed the steps")
    assert not beta._same_moment("", "x")


def test_report_markdown_for_a_panel_and_an_old_single_read():
    rec = {"kind": "panel", "version_key": "k1", "skipped": [{"n": 3, "persona": {"label": "casual reader"},
                                                               "why": "Gemini is not working right now"}],
           "comparison": beta.compare([
               _read(1, "Claude", reactions=[(1, "confused", "The fog rolled in over")], overall={"score": 7}),
               _read(2, "ChatGPT", reactions=[(1, "confused", "The fog rolled in over")], overall={"score": 5})], 3)}
    md = "\n".join(beta.report_markdown(rec, "k2"))
    assert md.startswith("## Beta readers") and "earlier version" in md and "Strong signals" in md
    assert "Reader 3 (casual reader) skipped: Gemini is not working right now" in md and "1. Chapter 1" in md
    old = {"version_key": "k1", "reader": {"name": "Claude", "independent": True},
           "persona": {"label": "adult reader", "a_label": "an adult reader"}, "average_interest": 6.5,
           "stop": {"would_finish": True}, "findings": [{"label": "The reader got lost", "detail": "Chapter 1."}],
           "summary": "Nice."}  # stored before idea #14: no overall verdict
    md = "\n".join(beta.report_markdown(old, "k1"))
    assert "Claude read it as an adult reader · interest 6.5/10" in md and "The reader got lost" in md
    assert "earlier version" not in md


# ====================================================================== on the fake AI
def test_a_run_with_a_panel_of_three(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1", "beta_reader": True, "beta_readers": 3})
    assert run["status"] == "done", run.get("problem")
    st = next(s for s in run["steps"] if s["id"] == "beta")
    assert st["state"] == "done" and st["message"].startswith("3 beta readers"), st["message"]
    r = beta.service_of(app).latest(run["project_id"], "main")
    assert r["kind"] == "panel" and r["status"] == "done" and r["run_id"] == run["id"] and not r["skipped"]
    assert [x["reader"]["slot"] for x in r["readers"]] == ["AI-2", "AI-3", "AI-1"]  # independent first
    assert [x["persona"]["kind"] for x in r["readers"]] == ["typical", "picky", "casual"]
    assert r["readers"][2]["reader"]["independent"] is False
    # every reader saw its own persona and never the plan
    ctxs = fake.prompts["beta"]
    assert [c[1]["reader"]["who"] for c in ctxs] == ["typical", "picky", "casual"]
    assert all(set(c[1]) <= {"book", "reader", "chapters", "premise"} for c in ctxs)   # 🔮 the premise, no plan
    cmp_ = r["comparison"]
    agree = {(g["kind"], g["chapter"]): g for g in cmp_["agree"]}
    assert agree[("confused", 1)]["count"] == 3 and agree[("confused", 1)]["same_moment"]
    assert agree[("bored", 2)]["count"] == 2  # the picky and the casual reader
    assert cmp_["totals"]["finish"] == 2 and cmp_["totals"]["favourite"]["name"] == "Mara"
    assert cmp_["fixes"][0]["kind"] == "confused" and cmp_["fixes"][0]["count"] == 3
    assert any(d["id"] == "finish" for d in cmp_["disagree"])
    assert run["beta"]["panel"] and len(run["beta"]["readers"]) == 3 and run["beta"]["strong"]
    assert any(e.get("code") == "BETA_NOTES" for e in run["events"])


@pytest.fixture(scope="module")
def book(tmp_path_factory):
    """One written book (AI-1 wrote it) shared by the panel tests below (they run in this order)."""
    fake = SlotFake()
    app = make_app(tmp_path_factory.mktemp("panel"), fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    return fake, app, run


def test_a_reader_whose_ai_is_not_working_is_skipped(book):
    fake, app, run = book
    pid = run["project_id"]
    fake.states["AI-3"] = "repairing"
    try:
        svc = beta.service_of(app)
        working = {o["slot_id"]: o["working"] for o in svc.readers("author", pid, "main")}
        assert working["AI-3"] is False, working
        r = svc.panel("author", pid, "main", readers=[{"slot_id": None}, {"slot_id": "AI-3"}, {"slot_id": None}])
    finally:
        fake.states["AI-3"] = "ok"
    assert r["status"] == "done"
    assert [x["reader"]["slot"] for x in r["readers"]] == ["AI-2", "AI-1"]
    assert [(s["n"], "not working" in s["why"]) for s in r["skipped"]] == [(2, True)]
    assert r["comparison"]["totals"]["readers"] == 2


def test_a_reader_that_fails_is_noted_and_the_others_read(book):
    fake, app, run = book
    fake.fail_kind("beta", AkoweError("TIMEOUT", "/x", "the AI did not answer in time"))
    r = beta.service_of(app).panel("author", run["project_id"], "main", readers=[{"slot_id": None}] * 2)
    assert r["status"] == "done" and [x["status"] for x in r["readers"]] == ["failed", "done"]
    s = r["skipped"][0]
    assert s["failed"] and s["code"] == "TIMEOUT" and "did not answer in time" in s["why"]
    assert r["comparison"]["totals"]["readers"] == 1
    fake.fail_kind("beta", *[AkoweError("TIMEOUT", "/x", "the AI did not answer in time")] * 2)
    r = beta.service_of(app).panel("author", run["project_id"], "main", readers=[{"slot_id": None}] * 2)
    assert r["status"] == "failed" and "No beta reader could read the book" in r["message"]


class _Stop(Exception):
    control = True  # like the run's pause: re-raised, never stored as a failed read


def test_a_paused_panel_continues_where_it_stopped(book):
    fake, app, run = book
    pid = run["project_id"]
    svc = beta.service_of(app)
    start = len(fake.prompts.get("beta") or [])

    def check():
        if len(fake.prompts.get("beta") or []) >= start + 1:
            raise _Stop()
    with pytest.raises(_Stop):
        svc.panel("author", pid, "main", readers=[{"slot_id": None}] * 3, check=check)
    rec = svc.latest(pid, "main")
    assert rec["kind"] == "panel" and rec["status"] == "incomplete" and len(rec["readers"]) == 1
    ov = svc.overview("author", pid, "main")
    assert ov["can_resume"]
    before = len(fake.prompts["beta"])
    done = svc.panel("author", pid, "main", readers=[], resume=rec["id"])
    assert done["id"] == rec["id"] and done["status"] == "done" and len(done["readers"]) == 3
    assert len(fake.prompts["beta"]) - before == 2  # only the two readers still to read
    assert [x["n"] for x in done["readers"]] == [1, 2, 3]
    assert not svc.overview("author", pid, "main")["can_resume"]


def _wait(app, base, job):
    for _ in range(400):
        _, j = app.route("GET", f"{base}/job/{job['id']}", {}, None, "author", {})
        if j["status"] not in ("queued", "running"):
            return j
        time.sleep(0.05)
    raise AssertionError("the beta job did not finish")


def test_panel_api_saves_the_readers_and_the_report_shows_it(book):
    fake, app, run = book
    pid = run["project_id"]
    base = f"/api/projects/{pid}/branches/main/beta"
    _, ov = app.route("GET", base, {}, None, "author", {})
    assert ov["panel"]["size"] == 1 and [r["kind"] for r in ov["panel"]["readers"]] == ["typical", "picky", "casual"]
    assert ov["panel"]["readers"][1]["default"] and not ov["panel"]["readers"][1]["persona"] and not ov["can_resume"]
    code, job = app.route("POST", base, {}, {"size": 2, "readers": [
        {"slot_id": "AI-3"}, {"slot_id": None, "persona": "a retired lighthouse keeper who knows the sea"}]},
        "author", {})
    assert code == 202 and job["size"] == 2
    j = _wait(app, base, job)
    assert j["status"] == "done", j
    _, ov = app.route("GET", base, {}, None, "author", {})
    r = ov["latest"]
    assert r["id"] == j["read_id"] and r["kind"] == "panel"
    assert [x["reader"]["slot"] for x in r["readers"]] == ["AI-3", "AI-2"]
    assert r["readers"][1]["persona"]["edited"] and r["readers"][1]["persona"]["text"].startswith("a retired")
    assert "lighthouse keeper" in str(fake.prompts["beta"][-1][0])  # the AI plays the reader the author described
    assert ov["panel"]["size"] == 2 and ov["panel"]["readers"][1]["persona"].startswith("a retired lighthouse")
    assert ov["panel"]["readers"][0]["slot_id"] == "AI-3"
    assert ov["reads"][0]["kind"] == "panel" and ov["reads"][0]["readers"] == 2
    # the book report's Markdown has the panel's summary
    _, rov = app.route("GET", f"/api/projects/{pid}/branches/main/report", {}, None, "author", {})
    rid = (rov.get("latest") or {}).get("id") or rov["reports"][0]["id"]
    code, out = app.route("GET", f"/api/projects/{pid}/branches/main/report/{rid}", {"format": ["md"]}, None,
                          "author", {})
    md = out[2].decode("utf-8")
    assert "## Beta readers" in md and "2 readers:" in md and "Strong signals" in md
    code, out = app.route("GET", f"/api/projects/{pid}/branches/main/report/{rid}", {"format": ["pdf"]}, None,
                          "author", {})
    assert out[2][:4] == b"%PDF"


def test_single_reader_stays_as_before_and_old_reads_still_show(tmp_path):
    app = make_app(tmp_path, SlotFake())
    run = run_book(app, {"slot_id": "AI-1", "beta_reader": True})
    svc = beta.service_of(app)
    pid = run["project_id"]
    r = svc.latest(pid, "main")
    assert "kind" not in r and r["reader"]["slot"] == "AI-2" and r["overall"]["score"] == 7
    assert "beta_readers" not in run["settings"]
    # a read stored before idea #14 (no overall verdict) still shows in the overview and the report
    old = {k: v for k, v in r.items() if k != "overall"}
    old["id"] = "beta-old"
    svc._store(pid, "main", old)
    ov = svc.overview("author", pid, "main")
    assert ov["latest"]["id"] == "beta-old" and ov["reads"][0]["kind"] == "single"
    md = "\n".join(beta.report_markdown(old, old["version_key"]))
    assert "read it as" in md


def test_run_setting_beta_readers_is_checked(tmp_path):
    app = make_app(tmp_path, SlotFake())
    for bad in (0, 4, "2", True):
        with pytest.raises(AkoweError):
            app.autobook._clean_settings({"beta_readers": bad})
    assert app.autobook._clean_settings({"beta_readers": 2})["beta_readers"] == 2
    assert "beta_readers" not in app.autobook._clean_settings({"beta_readers": 1})
