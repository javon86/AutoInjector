"""✍ How Akọwe keeps the book sounding human (human_voice.py).

Unit tests: the brief block (its contents from ai_tells.json, the budget cap, a changed data file, the book's own
repeat offenders), the repeat check across chapters (each kind, on crafted chapters, and a stretch's focus), the
narrator voice without samples (derived, the AI's, cleaned, stored as an auto snapshot and replaced by a real style
card), the "Sounds like a person" stretch score (schema, malformed replies, verdicts, the report) and the score. Then
fake-AI ⚡ runs: every chapter brief carries the block (measured), the auto voice reaches the writer and the editor,
the checkpoint's stretch review gets the score and Akọwe's repeat findings, and the end-of-book pass (auto-run,
the cap, the guard, proposals through ✔ Use and an approval, before → after on Book home, the setting off, no AI
available, a bad AI answer).
"""
from __future__ import annotations

import json

import pytest

from akowe import checkpoints, chapter_brief, claude_code_book, human_voice as hv, style_card as sc
from akowe.book_path import BookPath
from akowe.errors import AkoweError

from autobook_fake import CHAPTER_TEXT
from test_failover_review import SlotFake, make_app, run_book  # noqa: F401
from test_failover_review import no_provider_sleep  # noqa: F401 - the fixture


class MemStore:
    def __init__(self):
        self.s = {}

    def get_setting(self, k, default=None):
        return json.loads(json.dumps(self.s[k])) if k in self.s else default

    def set_setting(self, k, v):
        self.s[k] = json.loads(json.dumps(v))


def _chs(*texts):
    return [{"chapter_id": f"ch{i + 1}", "number": i + 1, "text": t} for i, t in enumerate(texts)]


FILL = ("Mara walked the length of the quay and counted the boats tied up at the wall. Then she went back for the "
        "oil can she had left at the sheds, because Tom would ask about it. ")


# ====================================================================== 1. the brief block
def test_brief_block_has_the_lists_the_patterns_and_the_craft_rules():
    b = hv.brief()
    assert "a breath she didn't know she was holding" in b["never_write"]
    assert "a testament to" in b["never_write"] and "delve" in b["never_write"]  # placeholders and * shown plainly
    assert not any("{" in p or "*" in p for p in b["never_write"])
    assert any("Not X. Not Y." in p for p in b["never_do"]) and any("It wasn't X" in p for p in b["never_do"])
    assert any("lists of three" in p for p in b["never_do"]) and any("moral" in p for p in b["never_do"])
    joined = " ".join(b["do"]).lower()
    for want in ("sentence length", "concrete", "subtext", "dialogue", "action or an image", "gesture"):
        assert want in joined, want
    assert "this_book_so_far" not in b
    assert len(json.dumps(b, ensure_ascii=False)) <= hv.BRIEF_MAX
    assert "never_write" in hv.RULE and "this_book_so_far" in hv.RULE


def test_brief_is_built_from_the_data_file(tmp_path, monkeypatch):
    data = json.loads(hv.DATA_PATH.read_text(encoding="utf-8"))
    data["ai_phrases"]["items"].insert(0, ["a whisper of {poss} soul", "made up for this test"])
    data["writer_brief"]["take"] = {"ai_phrases": 3, "cliches": 0, "hedges": 0}
    data["writer_brief"]["always"] = []
    data["writer_brief"]["craft"] = ["Write like a sailor."]
    p = tmp_path / "ai_tells.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setattr(hv, "DATA_PATH", p)
    b = hv.brief()
    assert b["never_write"][0] == "a whisper of her soul" and len(b["never_write"]) == 3
    assert b["do"] == ["Write like a sailor."]


def test_brief_budget_cap_shortens_the_phrases_first_then_says_what_was_cut():
    weather = "Rain hammered the harbour roof all night. " + FILL
    earlier = _chs(*[weather + f"Her jaw tightened. Night {i}." for i in range(5)])
    cut: list = []
    big = hv.brief(earlier, cut)
    assert big["this_book_so_far"] and len(json.dumps(big, ensure_ascii=False)) <= hv.BRIEF_MAX
    small = hv.brief(earlier, cut, budget=1300)
    assert len(json.dumps(small, ensure_ascii=False)) <= 1300
    assert small["do"] == hv.craft()  # the craft rules are kept
    assert len(small["never_write"]) < len(big["never_write"])
    tiny_cut: list = []
    tiny = hv.brief(earlier, tiny_cut, budget=1000)
    assert len(json.dumps(tiny, ensure_ascii=False)) <= 1000 and "never_write" not in tiny and tiny["do"]
    assert tiny_cut and tiny_cut[0].startswith("sounding-human notes about this book")


def test_the_books_own_repeat_offenders_from_earlier_chapters():
    earlier = _chs("Rain fell on Gullhaven before dawn. Her jaw tightened. " + FILL,
                   "The fog came in off the reef. Mara's jaw tightened at the news. " + FILL,
                   "Wind shook the lamp room glass. Her jaw tightened again. " + FILL)
    lines = hv.offenders(earlier)
    assert any(ln.startswith("Don't open with the weather again (chapters 1, 2 and 3 did)") for ln in lines), lines
    assert any("jaw tightened" in ln and "3×" in ln for ln in lines), lines


def test_earlier_chapters_come_from_the_accepted_manuscript():
    class S:
        def get_state(self, pid, branch, ns, key):
            return {"chapter:a": {"ref": {"record_id": "r1", "version": 2}}}.get(key) if ns == "c_manuscript" else None

        def get_record(self, pid, branch, rid, version):
            return {"data": {"text": "The rain again."}} if (rid, version) == ("r1", 2) else None
    outline = {"data": {"chapters": [
        {"facts": [{"predicate": "plan.item_id", "value": c, "subject_id": c}]} for c in ("a", "b", "c")]}}
    got = hv.earlier_chapters(S(), "p", "main", outline, "c")
    assert [(c["chapter_id"], c["number"], c["text"]) for c in got] == [("a", 1, "The rain again.")]
    assert hv.earlier_chapters(S(), "p", "main", outline, "zzz") == []


# ====================================================================== 2. the repeat check across chapters
def _kinds(rep):
    return {(f["kind"], f.get("what")) for f in rep["findings"]}


def test_repeats_openings_and_closings_of_the_same_kind():
    chs = _chs(*[f"Snow lay on the quay when Mara came down. {FILL}She closed her eyes and slept." for _ in range(4)])
    rep = hv.repeats(chs)
    assert ("opening", "weather") in _kinds(rep) and ("closing", "sleep") in _kinds(rep)
    f = next(f for f in rep["findings"] if f["kind"] == "opening")
    assert f["chapters"] == [1, 2, 3, 4] and f["severity"] == "major" and "the weather" in f["message"]
    assert all(e["quote"] in chs[e["chapter"] - 1]["text"] for e in f["examples"])  # exact quotes
    waking = _chs(*[f"Mara woke before the gulls. {FILL}" for _ in range(3)] + [FILL])
    assert ("opening", "waking") in _kinds(hv.repeats(waking))
    talk = _chs(*[f"“Where is he?” Mara asked. {FILL}" for _ in range(3)] + [FILL, FILL])
    assert ("opening", "dialogue") not in _kinds(hv.repeats(talk))  # 3 of 5 is under the dialogue bar (4, half)
    moral = _chs(FILL + "\n\nSome things are never truly lost.", FILL + "\n\nThat was the truth of grief.", FILL)
    assert ("closing", "moral") in _kinds(hv.repeats(moral))


def test_repeats_gestures_phrases_similes_and_the_focus_of_a_stretch():
    chs = _chs(f"Mara's jaw tightened. {FILL}The boats knocked together like restless teeth in the dark.",
               f"Tom's jaw tightened. She let out a breath. {FILL}The hulls knocked like restless teeth again.",
               f"Her jaw tightened and she let out a breath. {FILL}")
    rep = hv.repeats(chs)
    g = next(f for f in rep["findings"] if f["kind"] == "gesture" and f["what"] == "jaw tightened")
    assert g["chapters"] == [1, 2, 3] and "3×" in g["message"]
    assert any(f["kind"] == "phrase" and "counted the boats tied up" in f["what"] for f in rep["findings"])
    assert any(f["kind"] == "phrase" and "restless teeth" in f["what"] for f in rep["findings"])  # the simile
    for f in rep["findings"]:
        for e in f["examples"]:
            assert e["quote"] in chs[e["chapter"] - 1]["text"]
    assert not hv.repeats(chs, focus={9})["findings"]
    assert rep["line"].startswith("🔁 Repeats across chapters")


def test_repeats_names_are_not_phrases():
    t = "Captain Ilse Marrow of the Grey Gull came aboard at noon. "
    chs = _chs(t + FILL, t + FILL)
    rep = hv.repeats(chs, names=["Ilse Marrow"])
    assert not any("marrow" in f["what"] for f in rep["findings"] if f["kind"] == "phrase")


def test_repeats_the_same_sentence_rhythm():
    even = " ".join("Mara walked down to the harbour wall and counted every boat." for _ in range(20))
    varied = " ".join(("She ran. " if i % 2 else "Mara walked down past the sheds and the dark water to where the "
                       "old boats were tied up for the winter storms. ") for i in range(20))
    rep = hv.repeats(_chs(even, even.replace("every", "each"), even.replace("Mara", "Nessa"), varied))
    f = next(f for f in rep["findings"] if f["kind"] == "rhythm")
    assert f["chapters"] == [1, 2, 3] and "steady beat" in f["message"]


def test_repeats_ai_tells_rising_chapter_by_chapter():
    tell = "It was a testament to her patience. The tapestry of nets was a symphony of rope. "
    chs = _chs(FILL * 6, FILL * 6, FILL * 5 + tell, FILL * 3 + tell * 2, FILL * 2 + tell * 4)
    rep = hv.repeats(chs)
    f = next(f for f in rep["findings"] if f["kind"] == "tell_trend")
    assert f["chapters"] == [3, 4, 5] and "rising" in f["message"]
    assert not any(f["kind"] == "tell_trend" for f in hv.repeats(_chs(FILL, FILL, FILL, FILL))["findings"])


def test_repeat_check_never_raises():
    assert hv.repeats([{"chapter_id": "x", "number": "?", "text": None}])["findings"] == []


# ====================================================================== the narrator voice without samples
def test_derive_voice_from_genre_tone_pov_tense_and_choices():
    v = hv.derive_voice({"genre": "Cozy mystery", "tone": "Warm and eerie", "pov": "first", "tense": "present"},
                        {"pace": "fast", "dialogue": "lots"})
    assert v["auto"] is True and "first-person" in v["voice_summary"] and "present tense" in v["voice_summary"]
    assert "clue" in v["rhythm"] and "short" in v["rhythm"]  # mystery + fast pace
    assert any("dialogue" in d for d in v["do"]) and len(v["do"]) <= 4 and len(v["avoid"]) <= 4
    other = hv.derive_voice({"genre": "Space opera science fiction"})
    assert other["rhythm"] != v["rhythm"] and "third" in other["voice_summary"]


def test_clean_voice_takes_the_ais_and_refuses_junk():
    good = hv.clean_voice({"voice_summary": "Dry and close.", "rhythm": "Short.", "diction": "Plain.",
                           "do": ["Notice hands", 5], "avoid": "nope"})
    assert good == {"voice_summary": "Dry and close.", "rhythm": "Short.", "diction": "Plain.",
                    "do": ["Notice hands"], "auto": True}
    for bad in (None, "text", {"rhythm": "x"}, {"voice_summary": "", "do": ["x"]}):
        assert hv.clean_voice(bad) is None


def test_auto_voice_is_stored_like_a_style_card_and_a_real_card_replaces_it():
    st = MemStore()
    e = hv.set_auto(st, "p1", hv.derive_voice({"genre": "Horror"}), source="profile", profile={"pov": "first"})
    assert e["on"] and e["auto"] and sc.brief_for(st, "p1")["auto"] is True
    assert sc.brief_for(st, "p1")["numbers"]["person"] == "first"
    assert hv.rule_for(sc.brief_for(st, "p1")) == hv.AUTO_RULE and hv.rule_for({"x": 1}) == sc.RULE
    assert hv.editor_note_for({"auto": True}) == hv.AUTO_EDITOR_NOTE and hv.editor_note_for({}) == sc.EDITOR_NOTE
    # the author's real card (✒️ Use for this book) replaces it …
    st.set_setting(sc.AUTHOR_KEY.format(principal="a"), {"stats": sc.stats(["She ran. " * 200]), "version": 3})
    real = sc.apply_to_book(st, "a", "p1")
    assert real and not real.get("auto") and not sc.brief_for(st, "p1").get("auto")
    # … and the auto voice never overwrites a real card, even one switched off
    assert hv.set_auto(st, "p1", hv.derive_voice({}), source="profile") is None
    st.set_setting(sc.BOOK_KEY.format(pid="p1"), dict(sc.book_entry(st, "p1"), on=False))
    assert hv.set_auto(st, "p1", hv.derive_voice({}), source="profile") is None and sc.brief_for(st, "p1") is None


# ====================================================================== the score
def test_person_score_takes_off_points_for_repeats():
    clean = _chs(FILL, "Tom mended the nets by the window. " * 8)
    tells = _chs(*[f"Rain again. Her jaw tightened. {FILL}" for _ in range(4)])
    a, b = hv.person_score(clean), hv.person_score(tells)
    assert a["score"] > b["score"] and b["repeat_penalty"] > 0 and 0 <= b["score"] <= 100
    assert a["rating"] == "sounds like a person"


# ====================================================================== the stretch score and schema
def test_stretch_review_human_score_quotes_and_verdicts_are_cleaned():
    raw = {"stretch_review": {"pacing": "ok", "arc": "", "drift": "", "working": [], "not_working": [],
                              "human": "Too many jaws.", "human_quotes": ["Her jaw tightened.", 7, "  "],
                              "repeats": [{"id": "rp1", "verdict": "confirmed", "why": "noticeable"},
                                          {"id": "rp2", "verdict": "maybe"}, "junk", {"verdict": "rejected"}],
                              "scores": {"human": 15, "pacing": "7", "continuity": True}}}
    out = checkpoints.clean_stretch(raw)
    assert out["human"] == "Too many jaws." and out["human_quotes"] == ["Her jaw tightened."]
    assert out["repeats"] == [{"id": "rp1", "verdict": "confirmed", "why": "noticeable"}]
    assert out["scores"] == {"human": 10}  # clamped; a string or a bool is not a score
    weird = checkpoints.clean_stretch({"stretch_review": {"human_quotes": "x", "repeats": {"a": 1},
                                                          "scores": "nine", "human": "Fine."}})
    assert weird["human_quotes"] == [] and weird["repeats"] == [] and weird["scores"] == {}
    for bad in (None, [], {"stretch_review": "text"}, {"stretch_review": {}}):
        assert checkpoints.clean_stretch(bad) is None
    assert checkpoints.STRETCH_SCORES["human"] == "Sounds like a person"
    props = checkpoints.CHECK_SCHEMA["properties"]["stretch_review"]["properties"]
    assert "human" in props["scores"]["properties"] and "human" not in props["scores"]["required"]
    assert "human" not in checkpoints.CHECK_SCHEMA["properties"]["stretch_review"]["required"]


def test_repeat_verdicts_and_the_stretch_report_words():
    found = [{"id": "rp1", "message": "“jaw tightened” 4× in chapters 1 and 2.", "examples": [
        {"chapter": 1, "quote": "Her jaw tightened."}]}, {"id": "rp2", "message": "3 chapters open with the weather."},
        {"id": "rp3", "message": "x"}]
    views = [{"name": "Claude", "repeats": [{"id": "rp1", "verdict": "confirmed", "why": ""},
                                            {"id": "rp2", "verdict": "rejected", "why": "a deliberate motif"}],
              "human": "Stock gestures.", "human_quotes": ["Her jaw tightened."],
              "scores": {"human": 5, "pacing": 7}},
             {"name": "Gemini", "repeats": [{"id": "rp1", "verdict": "rejected", "why": ""}], "scores": {"human": 7}}]
    v = {r["id"]: r for r in checkpoints.repeat_verdicts(found, views)}
    assert v["rp1"]["status"] == "confirmed" and v["rp1"]["confirmed_by"] == ["Claude"]  # a tie leans to confirmed
    assert v["rp2"]["status"] == "rejected" and v["rp2"]["why"] == "a deliberate motif"
    assert v["rp3"]["status"] == "not_checked"
    sr = checkpoints.combine_stretch(views, "chapters 1–5")
    sr["repeats"] = list(v.values())
    hs = next(s for s in sr["scores"] if s["key"] == "human")
    assert hs["label"] == "Sounds like a person" and hs["average"] == 6.0
    md = "\n".join(checkpoints.stretch_markdown(sr))
    assert "Sounds like a person: 6/10" in md and "🔁 “jaw tightened” 4×" in md and "the AIs confirm it" in md
    assert "✍ **Claude** on sounding like a person: Stock gestures." in md and "“Her jaw tightened.”" in md
    assert "🔁 2 repeat(s)" in checkpoints.stretch_line(sr)
    alone = dict(checkpoints.combine_stretch([], "chapters 1–5"), repeats=checkpoints.repeat_verdicts(found, []))
    assert "Akọwe's own check; no AI answered" in checkpoints.stretch_line(alone)


# ====================================================================== the end-of-book pass (pure parts)
def test_rank_spots_worst_first_one_per_sentence_exact_quotes():
    from akowe import originality
    text = ("It was a testament to her patience. The tapestry of nets lay out. " + FILL + "\n\n"
            "Her jaw tightened. " + FILL)
    chs = _chs(text, "Her jaw tightened. " + FILL, "Her jaw tightened. " + FILL)
    orig = originality.check(chs)
    reps = hv.repeats(chs)
    ai = {"ratings": [{"chapter": 1, "quote": "The tapestry of nets lay out.", "machine_score": 5, "in_chapter": True,
                       "reasons": ["stock image"], "rewrite": "The nets lay out."},
                      {"chapter": 1, "quote": "Not in the book at all.", "machine_score": 5, "in_chapter": False}]}
    spots = hv.rank_spots(chs, orig, reps, ai)
    assert spots[0]["quote"] == "The tapestry of nets lay out." and spots[0]["rewrite"] == "The nets lay out."
    assert all(s["quote"] in chs[s["number"] - 1]["text"] for s in spots)
    assert not any(s["quote"] == "Not in the book at all." for s in spots)
    assert len({(s["number"], s["quote"]) for s in spots}) == len(spots)
    assert [s["weight"] for s in spots] == sorted((s["weight"] for s in spots), reverse=True)


# ====================================================================== ⚡ runs on the fake AIs
def _book(app, run):
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    from akowe import book_report
    return pid, bp, book_report.book_chapters(bp)


JAW = {1: "Mara's jaw tightened when she saw the dark lamp. It was a testament to Tom Reed's care that the brass "
          "still shone. She couldn't help but smile. ",
       2: "The captains turned away and her jaw tightened. The harbor was a testament to bad winters, a tapestry of "
          "nets and rope. ",
       3: "Nessa's jaw tightened at the keeper's name. Mara let out a breath she didn't know she was holding. "}
END = {1: "Her jaw tightened on the stairs.", 2: "On night 2 she gave up.", 3: "She walked home by the water."}
PLAIN = ["Tom kept a tin of tobacco under the third step, and the tin was still there, rusted at the hinge.",
         "She oiled the winch, swept the glass from the gallery and wrote the hour in the log in her own hand.",
         "The ferryman wanted two shillings for the crossing and would not take the coin she offered him.",
         "Salt had eaten the paint off the shutters, so the wind came through the cracks and lifted the charts.",
         "Nessa sold mackerel by the pound from a barrow with one bad wheel that squealed on every turn.",
         "At the chandler's she bought wick, a new brass funnel and a box of matches that smelled of tar.",
         "The keeper's coat hung on its peg with a pencil stub and a bus ticket from Saltmarsh in the pocket.",
         "Gulls fought over a crab shell on the slipway until a dog ran down and scattered them.",
         "Ilse Marrow's boat lay low in the water, and nobody on the quay would say what she carried.",
         "Mara counted the steps again on the way down and got a hundred and eleven this time."]


def _jaw_fake():
    fake = SlotFake()
    for i in (1, 2, 3):
        plain = "\n\n".join(" ".join(PLAIN[(i * 3 + k) % len(PLAIN)] for k in range(j, j + 4)) for j in range(3))
        fake.chapter_texts[f"ch{i}"] = (JAW[i] + "\n\n".join(CHAPTER_TEXT[i]) + "\n\n" + plain + "\n\n"
                                        + END[i])
    return fake


def test_every_chapter_brief_carries_the_block_and_the_auto_voice(tmp_path):
    fake = _jaw_fake()
    fake.voice = {"voice_summary": "A wry, salt-dry narrator who notices tools and weather.", "rhythm": "Short.",
                  "diction": "Harbour words.", "do": ["Name the tool"], "avoid": ["Sermons"]}
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    pid, bp, chapters = _book(app, run)
    assert any(e.get("code") == "VOICE_SET" for e in run["events"])
    style = sc.brief_for(app.store, pid)
    assert style["auto"] and style["voice_summary"].startswith("A wry, salt-dry")  # the AI's, from the first call
    assert sc.book_entry(app.store, pid)["source"] == "ai"
    profile_ctx = fake.prompts["profile"][0]
    assert "narrator_voice" in profile_ctx[0]  # folded into the existing first call: no extra AI call
    ctxs = [c for _s, c in fake.prompts["C02"]]
    assert ctxs and all((c.get("writing_brief") or {}).get("human_voice") for c in ctxs)
    assert all(hv.RULE in c["writing_brief"]["rules"] and hv.AUTO_RULE in c["writing_brief"]["rules"] for c in ctxs)
    assert all(c["writing_brief"]["narrator_style"]["auto"] for c in ctxs)
    sizes = [len(json.dumps(c["writing_brief"]["human_voice"], ensure_ascii=False)) for c in ctxs]
    assert max(sizes) <= hv.BRIEF_MAX
    print("\nMEASURED human_voice block (chars of JSON):", sizes, "+ rule", len(hv.RULE))
    # the third chapter was told what the first two already overused
    last = ctxs[-1]["writing_brief"]["human_voice"]
    assert any("jaw tightened" in ln for ln in last.get("this_book_so_far") or []), last
    assert any("a testament to" in ln for ln in last.get("this_book_so_far") or []), last
    # the editor got the auto voice with its own note
    assert any(hv.AUTO_EDITOR_NOTE in s for s, _c in fake.prompts.get("craft", []))
    # the meta of a chapter brief says the block's size
    outline = bp.outline()
    _b, meta = chapter_brief.build(app.store, pid, "main", outline, bp.outline_chapters(outline)[-1]["chapter_id"])
    assert meta["human_voice"]["chars"] <= hv.BRIEF_MAX and meta["human_voice"]["own"] >= 1


def test_without_the_ais_voice_the_profile_gives_one(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1", "genre": "Horror"})
    assert run["status"] == "done"
    e = sc.book_entry(app.store, run["project_id"])
    assert e["auto"] and e["source"] == "profile" and "dread" in e["brief"]["rhythm"]


def test_the_stretch_review_gets_the_score_and_akowes_repeat_findings(tmp_path, monkeypatch):
    monkeypatch.setattr(checkpoints, "DEFAULT_EVERY", 2)
    fake = _jaw_fake()
    fake.story_ledger = True
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "human_pass": False})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid = run["project_id"]
    cp = {c["id"]: c for c in checkpoints.items(app.store, pid, "main")}["after-2"]
    assert cp["repeats"] and any(f["kind"] == "gesture" for f in cp["repeats"])
    sent = [c for _s, c in fake.prompts["checkpoint"] if (c.get("stretch") or {}).get("repeats_found")]
    assert sent and {f["id"] for f in sent[0]["stretch"]["repeats_found"]} == {f["id"] for f in cp["repeats"]}
    sr = cp["stretch"]
    hs = next(s for s in sr["scores"] if s["key"] == "human")
    assert hs["label"] == "Sounds like a person" and hs["average"] == 6
    assert all(v.get("human") for v in sr["views"]) and any(v.get("human_quotes") for v in sr["views"])
    assert sr["repeats"] and all(r["status"] == "confirmed" for r in sr["repeats"])
    md = "\n".join(checkpoints.markdown(checkpoints.report(app.store, pid, "main")))
    assert "Sounds like a person" in md and "🔁" in md


def test_end_of_book_pass_suggests_rewrites_the_author_approves(tmp_path):
    fake = _jaw_fake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    pid, bp, chapters = _book(app, run)
    rec = hv.stored(app.store, pid, "main")
    assert rec and rec["run_id"] == run["id"] and rec["proposals"] >= 1
    assert run["report"]["human"].startswith("✍ Sounds like a person:") and any(
        e.get("code") == "HUMAN_PASS" for e in run["events"])
    assert rec["ai"] and rec["ai"]["independent"]  # the AI read: not the AI that wrote the chapters
    assert any(k == "originality" for k in fake.kinds) and "human_rewrite" in fake.kinds
    assert rec["projected"] >= rec["before"]["score"]
    props = claude_code_book._proposals_get(app.store, pid, "main")  # noqa: SLF001
    items = [i for row in props.values() for i in row["items"] if i["kind"] == hv.KIND]
    assert 1 <= len(items) <= hv.MAX_FIXES and sorted(i["rank"] for i in items) == list(range(1, len(items) + 1))
    for i in items:  # nothing changed: every suggestion is still in the approved text, once
        ch = next(c for c in chapters if c["chapter_id"] in props and i in props[c["chapter_id"]]["items"])
        assert ch["text"].count(i["original"]) == 1 and i["original"] != i["replacement"]
        assert "Tom Reed" not in i["original"] or "Tom Reed" in i["replacement"]
    home = hv.home(bp)
    assert home["before"] == home["now"] == rec["before"]["score"] and home["waiting"] == len(items)
    s, book = app.route("GET", f"/api/projects/{pid}/branches/main/book", {}, None, "author", {})
    assert (book.get("human_voice") or {}).get("line", "").startswith("✍ Sounds like a person:")
    # ✔ Use: a new draft (never approved here); the author approves it; Book home shows before → after
    cid = next(cid for cid, row in props.items() if any(i["kind"] == hv.KIND for i in row["items"]))
    ch = next(c for c in chapters if c["chapter_id"] == cid)
    info = claude_code_book.chapter_info(app, "author", pid, "main", ch["record_id"])
    mine = [p for p in info["proposals"] if p["kind"] == hv.KIND]
    assert mine
    out = claude_code_book.use_proposals(app, "author", pid, "main", ch["record_id"], {"ids": [p["id"] for p in mine]})
    head = app.review._head(pid, "main", ch["record_id"])  # noqa: SLF001
    assert out["used"] >= 1 and head.get("approved_version") != head["version"]
    assert hv.home(BookPath(app.engine, "author", pid, "main"))["now"] == rec["before"]["score"]  # not approved yet
    assert bp.approve_ref(head["ref"])["ok"]
    after = hv.home(BookPath(app.engine, "author", pid, "main"))
    assert after["now"] != after["before"] and "→" in after["line"] and "after your approved fixes" in after["line"]


def test_end_of_book_pass_never_touches_locked_names_or_numbers(tmp_path, monkeypatch):
    fake = _jaw_fake()
    # the AI's rewrites: one drops a name, one changes a number, one is fine
    fake.human_script.append(lambda ctx: {"lines": [
        {"id": sp["id"], "quote": sp["quote"],
         "rewrite": sp["quote"].replace("Tom Reed", "the keeper") if "Tom Reed" in sp["quote"]
         else sp["quote"].replace("night 2", "night 9") if "night 2" in sp["quote"]
         else fake.plain_line(sp["quote"])} for sp in ctx["spots"]]})
    fake.originality_script.append(lambda ctx: {"machine_ratings": [], "summary": "fine"})  # no AI rewrites
    app = make_app(tmp_path, fake)
    from akowe import checkpoints as cpm
    monkeypatch.setattr(cpm, "_locked", lambda store, pid, branch: ["Mara Vell: eyes: storm grey",
                                                                    "The Old Light: lamp: the dark lamp"])
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done"
    pid, _bp, _chs2 = _book(app, run)
    items = [i for row in claude_code_book._proposals_get(app.store, pid, "main").values()  # noqa: SLF001
             for i in row["items"] if i["kind"] == hv.KIND]
    assert items
    for i in items:
        assert "Tom Reed" not in i["original"] or "Tom Reed" in i["replacement"]
        assert "night 9" not in i["replacement"]
        assert "the dark lamp" not in i["original"] or "the dark lamp" in i["replacement"]
    ctx = fake.prompts["human_rewrite"][0][1]
    assert "Mara Vell: eyes: storm grey" in ctx["keep_exactly"] and ctx["narrator_voice"]


def test_end_of_book_pass_cap_worst_first(tmp_path, monkeypatch):
    monkeypatch.setattr(hv, "MAX_FIXES", 2)
    app = make_app(tmp_path, _jaw_fake())
    run = run_book(app, {"slot_id": "AI-1"})
    pid = run["project_id"]
    items = [i for row in claude_code_book._proposals_get(app.store, pid, "main").values()  # noqa: SLF001
             for i in row["items"] if i["kind"] == hv.KIND]
    assert len(items) == 2 and hv.stored(app.store, pid, "main")["proposals"] == 2


def test_end_of_book_pass_can_be_switched_off(tmp_path):
    fake = _jaw_fake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1", "human_pass": False})
    assert run["status"] == "done"
    assert hv.stored(app.store, run["project_id"], "main") is None and "human_rewrite" not in fake.kinds
    assert any(e.get("code") == "HUMAN_PASS_OFF" for e in run["events"]) and "human" not in (run.get("report") or {})
    with pytest.raises(AkoweError):
        app.autobook.start("author", {"author_confirms": True, "human_pass": "no"})


def test_end_of_book_pass_without_any_ai_keeps_akowes_own_results(tmp_path, monkeypatch):
    fake = _jaw_fake()
    app = make_app(tmp_path, fake)
    from akowe import usage_limits
    real = usage_limits.current
    state = {"limited": False}
    monkeypatch.setattr(usage_limits, "current", lambda *a, **k: {"names": ["all"]} if state["limited"]
                        else real(*a, **k))
    orig = hv._end_pass  # noqa: SLF001

    def limited(*a, **k):
        state["limited"] = True  # every AI hits its usage limit just as the book is finished
        return orig(*a, **k)
    monkeypatch.setattr(hv, "_end_pass", limited)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done"
    rec = hv.stored(app.store, run["project_id"], "main")
    assert rec and rec["before"]["score"] is not None and rec["ai"] is None and rec["proposals"] == 0
    assert any("usage limit" in n for n in rec["notes"]) and rec["repeats"]
    assert "originality" not in fake.kinds and "human_rewrite" not in fake.kinds


def test_end_of_book_pass_survives_a_bad_ai_answer(tmp_path):
    fake = _jaw_fake()
    fake.human_script.append({"lines": [{"id": "nope", "quote": "x", "rewrite": "y"}]})
    fake.originality_script.append({"machine_ratings": [], "summary": ""})  # a useless read is stored as failed
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done"
    rec = hv.stored(app.store, run["project_id"], "main")
    assert rec and rec["proposals"] == 0 and rec["ai"] is None and "no rewrite to suggest" in rec["line"]
    assert any("Akọwe's own checks were used" in n for n in rec["notes"])


def test_rewrites_use_the_claude_code_helpers_when_they_work_else_the_web_ai(monkeypatch):
    from akowe import claude_code_jobs
    calls = []

    def fake_tells(store, text, *, earlier=None, keep_exactly=None, keep_repeats=None, spots=None, cancel=None):
        calls.append({"spots": spots, "keep": keep_exactly})
        if "BROKEN" in text:
            raise AkoweError("UPSTREAM_UNAVAILABLE", "/cc", "helper failed")
        return [{"quote": s["quote"], "problem": s["problem"], "rewrite": "Plain."} for s in spots], {}
    web = []
    monkeypatch.setattr(claude_code_jobs, "ai_tells", fake_tells)
    monkeypatch.setattr(claude_code_book, "active", lambda svc, run, job=None: True)
    monkeypatch.setattr(hv, "_web_rewrites", lambda svc, run, pid, branch, todo, *a, **k: (
        web.append([s["number"] for s in todo]) or "Gemini", {s["number"]: [{"quote": s["quote"], "problem": "p",
                                                                              "rewrite": "Web."}] for s in todo}))

    class Svc:
        store = MemStore()

        def check(self, run):
            return None
    by_num = {1: {"text": "A tapestry. " + FILL}, 2: {"text": "BROKEN tapestry. " + FILL}}
    todo = [{"number": 1, "quote": "A tapestry.", "problem": "stock"},
            {"number": 2, "quote": "BROKEN tapestry.", "problem": "stock"}]
    by, got = hv._rewrites(Svc(), {"id": "r"}, "p", "main", todo, by_num, ["X: y: z"], {}, [])  # noqa: SLF001
    assert by == f"{claude_code_book.NAME} and Gemini"
    assert got[1][0]["rewrite"] == "Plain." and got[2][0]["rewrite"] == "Web."  # the failed chapter: the web AI
    assert calls[0]["spots"] == [{"quote": "A tapestry.", "problem": "stock"}] and calls[0]["keep"] == ["X: y: z"]
    assert web == [[2]]
    monkeypatch.setattr(claude_code_book, "active", lambda svc, run, job=None: False)
    by, got = hv._rewrites(Svc(), {"id": "r"}, "p", "main", todo, by_num, [], {}, [])  # noqa: SLF001
    assert by == "Gemini" and web[-1] == [1, 2]
