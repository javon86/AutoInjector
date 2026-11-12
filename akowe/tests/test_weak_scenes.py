"""🎯 The weakest scenes (weak_scenes.py): the final improve pass places every complaint in its scene, ranks the
scenes, rewrites only the top 3 (each within a +10 % word budget) and keeps the result only when the same reviewers
score the book higher — with the fake AI."""
from __future__ import annotations

import pytest

from akowe import improve_pass as ip
from akowe import run_forecast
from akowe import weak_scenes as ws
from akowe.book_path import BookPath
from akowe.book_report import DIM_KEYS, book_chapters

from test_failover_review import SlotFake, make_app, run_book  # noqa: F401

S1 = ("The fog rolled in over Gullhaven before dawn. Mara Vell climbed the hundred steps of the old lighthouse with "
      "a lantern in one hand and the keeper's last letter in the other, counting each step aloud.")
S2 = ("In the lamp room the lens was cracked. Tom Reed's logbook lay open, and the last line was written in a hand "
      "she did not know. It explained everything she needed: the stranger had come by boat, at night.")
S3 = ("Down at the harbour the boats knocked together. Only old Nessa at the net sheds would talk, and she told "
      "Mara everything for nothing, smiling, as if she had waited all week to help her with the answer.")
S4 = ("At high water the reef went under. Mara rowed out anyway, and the oar slipped, and the cold took her breath "
      "while the light behind her stayed dark and the keeper's key stayed hidden in the stones.")
CH1 = f"# The light\n\n{S1}\n\n* * *\n\n{S2}"
CH2 = f"# The harbour\n\n{S3}\n\n***\n\n{S4}"
CH3 = "# Mine\n\nWritten by the author herself, every word of it, about the reef and the key and the boat."


def _chapters():
    return [{"chapter_id": "c1", "number": 1, "record_id": "R1", "version": 1, "text": CH1, "objective": "climb"},
            {"chapter_id": "c2", "number": 2, "record_id": "R2", "version": 1, "text": CH2, "objective": "ask"},
            {"chapter_id": "c3", "number": 3, "record_id": "R3", "version": 1, "text": CH3, "objective": "end"}]


def _rep(**medians):
    dims = [{"dimension": d, "label": d, "median": medians.get(d, 7.0), "n": 2} for d in DIM_KEYS]
    return {"aggregate": {"overall": 7.0, "reviewers": 2, "dimensions": dims},
            "reviews": [{"status": "done", "slot": "AI-2", "weaknesses": [
                {"point": "Helpers hand Mara what she needs; nothing is at risk.", "quote":
                 "she told Mara everything for nothing", "verified": True},
                {"point": "The log explains the mystery outright.", "quote": "It explained everything she needed",
                 "verified": True},
                {"point": "Invented.", "quote": "A line that is nowhere in the book.", "verified": False}]},
                        {"status": "done", "slot": "AI-3", "weaknesses": [
                            {"point": "Too convenient: Nessa just helps.", "quote":
                             "Only old Nessa at the net sheds would talk", "verified": True},
                            {"point": "Not in this book.", "quote": "Mine, all mine, in the author's chapter",
                             "verified": True}]}]}


# ====================================================================== scenes on the page
def test_scene_spans_are_exact_and_leave_out_the_title_and_the_breaks():
    spans = ws.scene_spans(CH1)
    assert [CH1[a:b] for a, b in spans] == [S1, S2]
    # written without breaks: cut at paragraph ends into as many parts as the chapter has scene cards
    flat = f"# T\n\n{S1}\n\n{S2}\n\n{S3}"
    parts = [flat[a:b] for a, b in ws.scene_spans(flat, planned=3)]
    assert parts == [S1, S2, S3]
    two = [flat[a:b] for a, b in ws.scene_spans(flat, planned=2)]
    assert len(two) == 2 and two[0].startswith(S1) and two[-1].endswith(S3)
    assert [flat[a:b] for a, b in ws.scene_spans(flat)] == [flat[5:]]  # short, no plan: one scene


# ====================================================================== complaints -> scenes, ranking
def test_complaints_are_placed_in_their_scene_and_never_in_the_authors_chapter(tmp_path):
    app = make_app(tmp_path, SlotFake())
    chs = _chapters()
    crafts = {"R1:1": {"findings": [{"id": "f1", "dimension": "subtext", "severity": "major", "passage":
                                     "the last line was written in a hand she did not know", "why": "Told."}]}}
    beta = {"fixes": [{"kind": "lost", "chapter": 2, "strong": True, "text": "Chapter 2: I got lost.", "quote": ""}]}
    placed = ws.complaints(app.store, "P", "main", chs, _rep(), beta, crafts, skip={3})
    where = {k: [it["source"] for it in v["items"]] for k, v in placed["scenes"].items()}
    assert where[(2, 1)].count("review") == 2           # two reviewers quoting the same scene both count
    assert "beta_strong" in where[(2, 1)]                # no quote: the chapter's first scene, at half weight
    assert sorted(where[(1, 2)]) == ["editor", "review"]
    assert not any(k[0] == 3 for k in where)            # the author's own chapter is never touched
    assert placed["lost"] == 1                           # a quote found nowhere (the author's chapter) is not used
    beta_item = next(it for it in placed["scenes"][(2, 1)]["items"] if it["source"] == "beta_strong")
    assert beta_item["share"] == ws.UNQUOTED_SHARE and beta_item["passage"] == ""
    review = next(it for it in placed["scenes"][(2, 1)]["items"] if it["source"] == "review")
    assert review["passage"] in S3 and review["dimension"] == "peril_uncertainty"


def test_ranking_puts_the_books_lowest_dimensions_and_most_complaints_first(tmp_path):
    app = make_app(tmp_path, SlotFake())
    chs = _chapters()
    rep = _rep(peril_uncertainty=5.0, subtext=8.0)
    placed = ws.complaints(app.store, "P", "main", chs, rep, None, {}, skip={3})
    top = ws.rank(placed, rep)
    assert [(p["chapter"]["number"], p["scene"]["n"]) for p in top] == [(2, 1), (1, 2)]
    assert top[0]["score"] > top[1]["score"]
    # the same complaints, but now subtext is the book's weakest part: the log scene goes first
    rep2 = _rep(peril_uncertainty=8.0, subtext=3.0)
    placed2 = ws.complaints(app.store, "P", "main", chs, rep2, None, {}, skip={3})
    assert ws.rank(placed2, rep2)[0]["scene"]["text"] == S2
    assert ws.dim_factor(5) == 2.5 and ws.dim_factor(9) == 1.0 and ws.dim_factor(None) == 1.0
    assert len(ws.rank(placed, rep, limit=1)) == 1


def test_scene_labels_for_the_report():
    chs = _chapters()
    sc = ws.chapter_scenes(chs[0])
    assert ws.label_of(chs[0], sc[0], 3, 2) == "ch1 opening"
    sc2 = ws.chapter_scenes(chs[1], [{"beat": "The photograph investigation begins"}, {}])
    assert ws.label_of(chs[1], sc2[0], 3, 2) == "ch2 the photograph investigation begins"
    assert ws.label_of(chs[1], sc2[1], 2, 2) == "ch2 ending"
    assert ws.label_of(chs[1], sc2[1], 3, 2) == "ch2 scene 2"


# ====================================================================== the budget and the checks
def test_a_rewrite_must_keep_the_budget_names_and_kept_lines():
    old = S3
    n = ws._words(old)  # noqa: SLF001
    ok = old.replace("for nothing, smiling", "only for a coin, and slowly")
    assert ws.check_scene(old, ok, keep=[], names=["Nessa", "Mara"]) == (None, ok)
    longer = old + " " + " ".join(["more"] * (ws.budget(n) - n + 1))
    assert ws.check_scene(old, longer)[0] == "TOO_LONG"
    just = old + " " + " ".join(["more"] * (ws.budget(n) - n))
    assert ws.check_scene(old, just)[0] is None                    # +10 % is allowed, not more
    assert ws.check_scene(old, "Nessa talked.")[0] == "TOO_SHORT"
    assert ws.check_scene(old, ok.replace("Nessa", "Maud"), names=["Nessa"])[0] == "NAME_LOST"
    assert ws.check_scene(old, ok.replace("Down at the harbour", "At the quay"),
                          keep=["Down at the harbour"])[0] == "KEEP_LOST"
    assert ws.check_scene(old, old)[0] == "NO_CHANGE"
    assert ws.check_scene(old, ok + "\n\n***\n\nMore.")[0] == "FORM"
    assert ws.check_scene(old, None)[0] == "EMPTY"
    assert ws.names_in(old, ["Mara Vell", "Old Nessa", "Tom Reed"]) == ["Mara", "Nessa"]


def test_the_report_line():
    res = {"before": 7.9, "after": 8.4, "keep": True, "why": "ok"}
    assert ws.line(res, ["ch1 opening", "ch2 photograph investigation", "ch3 final miscalculation"]) == (
        "🎯 Rewrote 3 weakest scenes (ch1 opening, ch2 photograph investigation, ch3 final miscalculation): "
        "7.9 → 8.4 (kept)")
    bad = ws.line({"before": 7.9, "after": 7.7, "keep": False, "why": "the overall score did not go up"}, ["ch1 opening"])
    assert bad.startswith("🎯 Rewrote 1 weakest scene (ch1 opening): 7.9 → 7.7 (not kept")


# ====================================================================== settings and the forecast
def test_rounds_and_mode_settings():
    assert ws.enabled({"improve_mode": "scenes"}) and not ws.enabled({}) and not ws.enabled({"improve_mode": "chapters"})
    assert ip.rounds_of({"improve_mode": "scenes"}) == 1
    assert ip.rounds_of({"improve_mode": "scenes", "improve_rounds": 2}) == 2
    assert ip.rounds_of({"improve_mode": "scenes", "improve_rounds": 3}) == 2   # at most 2
    assert ip.rounds_of({"improve_mode": "chapters"}) == 2                      # the older way keeps its default


def test_the_forecast_counts_fewer_answers_than_two_whole_chapter_rounds(tmp_path):
    app = make_app(tmp_path, SlotFake())

    def calls(body):
        return run_forecast.option_calls(run_forecast.options_of(app, body), 6, 3)["improve"]
    scenes, old = calls({}), calls({"improve_mode": "chapters"})
    assert "weakest scenes" in scenes["label"] and scenes["calls"] < old["calls"]
    assert calls({"improve_rounds": 2})["calls"] > scenes["calls"] == calls({"improve_rounds": 1})["calls"]
    assert calls({"improve_rounds": 3})["calls"] == calls({"improve_rounds": 2})["calls"]
    assert calls({"improve_pass": False})["calls"] == 0
    with pytest.raises(Exception):
        app.autobook.start("author", {"author_confirms": True, "improve_mode": "pages"})


# ====================================================================== the whole run with the fake AI
def _better_review(ctx):
    quote = "The lamp room was cold."
    return {"book_scores": {d: (9 if d in ("atmosphere", "premise") else 8) for d in DIM_KEYS},
            "strengths": [{"point": "Vivid.", "quote": quote}],
            "weaknesses": [{"point": "Quiet.", "quote": quote}], "try_next": [], "summary": "Better.",
            "score_evidence": [{"dimension": d, "quote": quote, "why": "vivid"} for d in ("atmosphere", "premise")]}


def _worse_review(ctx):
    r = _better_review(ctx)
    r["book_scores"] = {d: 5 for d in DIM_KEYS}
    r.pop("score_evidence", None)
    return r


def _nessa_bargains(ctx):
    text = ctx["scene"]["text"]
    return {"rewritten_scene": text.replace("only in a whisper", "only for a silver coin"),
            "what_changed": ["Nessa asks a price."]}


def _too_long(ctx):
    return {"rewritten_scene": ctx["scene"]["text"] + " And then she said much more, " * 10}


def _book(app, run):
    return book_chapters(BookPath(app.engine, "author", run["project_id"], "main"))


def test_the_weakest_scene_rewrite_is_kept_when_the_same_reviewers_score_higher(tmp_path):
    fake = SlotFake()
    fake.weak_scene_script = [_nessa_bargains] * 3
    fake.book_review_script = [None, None, _better_review, _better_review]
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "opening_pass": False})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["improve"]
    assert mem["mode"] == "scenes" and mem["kept"] is True and mem["after"] > mem["before"], mem
    assert mem["line"].startswith("🎯 Rewrote 1 weakest scene (ch2 ") and mem["line"].endswith("(kept)")
    assert f"{mem['before']:g} → {mem['after']:g}" in mem["line"]
    # what the writer was given: the complaint with its quote, the plan beat, the neighbours and the budget
    ctx = fake.prompts["weak_scene"][0][1]
    assert any("Nessa" in c["passage"] for c in ctx["complaints"])
    assert ctx["scene"]["max_words"] == ws.budget(ctx["scene"]["words"]) and ctx["plan_beat"]
    assert "Mara asked every captain" in ctx["before"] and ctx["rules"] == ws.SCENE_RULES
    chs = _book(app, run)
    assert "only for a silver coin" in chs[1]["text"] and all(c["approved"] for c in chs)
    assert "weavers" not in chs[1]["text"] and chs[1]["text"].count("Only old Nessa") == 1  # spliced, not appended
    rep = app.reports.latest(run["project_id"], "main")
    assert rep["aggregate"]["overall"] == mem["after"] and rep.get("improve") == mem["line"]
    assert "IMPROVE_KEPT" in [e.get("code") for e in run["events"]]


def test_the_original_book_stays_when_the_score_drops(tmp_path):
    fake = SlotFake()
    fake.weak_scene_script = [_nessa_bargains] * 3
    fake.book_review_script = [None, None, _worse_review, _worse_review]
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "opening_pass": False})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["improve"]
    assert mem["kept"] is False and mem["after"] == mem["before"] and mem["last_try"] < mem["before"]
    assert "not kept" in mem["line"] and mem["line"].startswith("🎯 Rewrote 1 weakest scene")
    assert "silver coin" not in _book(app, run)[1]["text"]
    assert "IMPROVE_NOT_KEPT" in [e.get("code") for e in run["events"]]


def test_a_scene_over_its_word_budget_is_refused_and_nothing_is_rescored(tmp_path):
    fake = SlotFake()
    fake.weak_scene_script = [_too_long] * 3
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "opening_pass": False})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["improve"]
    assert mem["kept"] is False and mem["rounds"][0]["refused"][0]["code"] == "TOO_LONG"
    assert "word budget" in mem["line"]
    assert fake.kinds.count("book_review") == 2   # the report's two reviews only: no re-read for a refused rewrite
    assert "said much more" not in _book(app, run)[1]["text"]


# ====================================================================== 🎯 + 📏 / 🔁 (measure-fixes) together
def test_a_kept_scenes_round_is_akowes_own_and_the_final_book_is_read_again(tmp_path):
    from akowe import continuity
    fake = SlotFake()
    fake.weak_scene_script = [_nessa_bargains] * 3
    fake.book_review_script = [None, None, _better_review, _better_review]
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "opening_pass": False, "beta_reader": True})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["improve"]
    assert mem["mode"] == "scenes" and mem["kept"] is True, mem
    codes = [e.get("code") for e in run["events"]]
    assert "IMPROVE_KEPT" in codes and "CHAPTER_CHANGED" not in codes   # never "changed by hand"
    assert "BETA_AGAIN" in codes   # the beta reader read the book with the rewritten scene
    assert fake.kinds.count("beta") == 2
    ch2 = _book(app, run)[1]
    assert "only for a silver coin" in ch2["text"]
    assert continuity.is_own(app.store, run["project_id"], "main", ch2["record_id"], ch2["version"])
    assert continuity.check_edits(app.store, run["project_id"], "main") == []
    ids = [s["id"] for s in run["steps"]]
    assert ids.index("improve") < ids.index("reread")


def test_a_scenes_round_that_would_make_the_book_too_long_is_left_out(tmp_path, monkeypatch):
    import akowe.lengths as lengths
    fake = SlotFake()
    fake.weak_scene_script = [lambda ctx: {"rewritten_scene": ctx["scene"]["text"] + " The wind rose."}] * 3
    app = make_app(tmp_path, fake)
    real, propose, late = lengths.of_book, ws.propose, []

    def proposed(*a, **k):   # from the improve round on, the book is far past its cap (a 10-word target)
        late.append(1)
        return propose(*a, **k)

    def tiny(store, pid, *a, **k):
        out = dict(real(store, pid, *a, **k))
        if late:
            out["book_words"] = 10
        return out
    monkeypatch.setattr(ws, "propose", proposed)
    monkeypatch.setattr(lengths, "of_book", tiny)
    run = run_book(app, {"length": "short_story", "opening_pass": False})
    assert run["status"] == "done", run.get("problem")
    mem = app.autobook.get(run["id"])["improve"]
    assert mem["kept"] is False and mem["rounds"][0]["refused"][0]["code"] == "BOOK_TOO_LONG", mem
    assert "longer than its length allows" in mem["line"]
    assert "The wind rose." not in _book(app, run)[1]["text"]
