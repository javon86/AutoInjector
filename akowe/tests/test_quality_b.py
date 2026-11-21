"""📈 Book quality, batch 2 agent B ("AI novel quality beyond eight", recommendations 5 and 6): 🗣 voice tests on the
finished page (who says what, rhythm, shared habits and one blind "who said this line?" test, fed back into the
next chapters' brief) and 💬 the subtext check (on-the-nose dialogue found without AI, confirmed by one AI answer,
rewritten through the editor's exact-replacement machinery)."""
from __future__ import annotations

import pytest

from akowe import subtext_check as sc
from akowe import voice_test as vt
from akowe.book_report import render_markdown
from akowe.errors import AkoweError

from test_failover_review import SlotFake
from test_world_planned import book, chapters

CAST = ["Mara Vell", "Tom Reed", "Nessa Crane"]
NOSE = "I feel so betrayed by all of you,"
SUBTLER = "You all knew, and you let me climb those stairs alone,"


def chapter_text(n: int) -> str:
    """Mara and Tom share a stock phrase, a three-word signature and a rhythm; Nessa talks in short questions."""
    first = f"“{NOSE}” Mara said.\n\n" if n == 1 else ""
    return first + "\n\n".join([
        f"Night {n} came down over Gullhaven and the fog sat low on the black water of the harbour.",
        f"“Here's the thing, the light goes out before the boats come home on night {n},” Mara said.",
        f"“Here's the thing, the light goes out when nobody is watching the lamp on night {n},” Tom said.",
        f"“Who saw it on night {n}? You? Me?” Nessa asked.",
        f"“We keep the lamp burning for the boats out on the water, night {n} or not,” Mara said.",
        f"“We keep the lamp burning for the boats that never come home, night {n} or not,” Tom said.",
        f"“Fish? Nets? Supper on night {n}?” Nessa asked.",
        f"The keeper's stairs creaked under them as they climbed for the {n} time that week."])


# ====================================================================== 🗣 who says what (no AI)
def test_speaker_lines_tags_before_after_narration_and_pronouns():
    text = ("“The reef is quiet tonight,” Mara said.\n\n"
            "Tom Reed said, “Then we go out at first light.”\n\n"
            "Nessa laughed. “Fish don't talk, girl.” She turned away. “Nor do keepers.”\n\n"
            "“Nobody knows,” she said.\n\n"
            "“Who is it?” said Tom.")
    got = [(x["speaker"], x["line"]) for x in vt.speaker_lines(text, CAST)]
    assert got == [("Mara Vell", "The reef is quiet tonight,"), ("Tom Reed", "Then we go out at first light."),
                   ("Nessa Crane", "Fish don't talk, girl."), ("Nessa Crane", "Nor do keepers."),
                   ("Tom Reed", "Who is it?")]  # "she said" with nobody named is left out
    assert vt.speaker_lines(text, []) == [] and vt.speaker_lines("", CAST) == []


def test_analyse_finds_alike_pairs_shared_habits_and_smooth_dialogue():
    res = vt.analyse([(n, chapter_text(n)) for n in (1, 2, 3)], CAST)
    assert set(res["speakers"]) == {"Mara Vell", "Tom Reed", "Nessa Crane"}
    pairs = {tuple(p["names"]): p["why"] for p in res["pairs"]}
    assert ("Mara Vell", "Tom Reed") in pairs
    why = " ".join(pairs[("Mara Vell", "Tom Reed")])
    assert "both keep saying" in why and "“Here's the thing”" in why
    assert not any("Nessa Crane" in k for k in pairs)          # short questions: her own voice
    assert res["flat_chapters"] == [1, 2, 3]                   # nobody ever stumbles or breaks off
    assert vt.imperfect(["I— I never saw him.", "Wait...", "Fine."]) == 2
    distinct = vt.analyse([(1, "\n\n".join(
        [f"“Aye, the nets want mending before the squall, lad,” Tom said. “Line {i}.”" for i in range(5)] +
        [f"“Why? Who? When on {i}?” Nessa asked." for i in range(5)]))], CAST)
    assert distinct["pairs"] == []


def test_blind_lines_mask_names_need_two_speakers_and_score_the_answer():
    lines_by = {"Mara Vell": [f"Tom, the lamp on the reef burns low tonight {i}" for i in range(6)],
                "Tom Reed": [f"Mara Vell never listens to an old keeper {i}" for i in range(6)],
                "Nessa Crane": ["Too short"] * 5}
    lines = vt.blind_lines(lines_by, CAST)
    assert len(lines) == 2 * vt.BLIND_PER and {x["speaker"] for x in lines} == {"Mara Vell", "Tom Reed"}
    assert not any("Mara" in x["line"] or "Tom" in x["line"] for x in lines)
    assert all("[name]" in x["line"] for x in lines)
    assert vt.blind_lines({"Mara Vell": lines_by["Mara Vell"]}, CAST) == []   # one speaker: no test
    # every Tom line is given to Mara: they are confused; Mara's own lines are right
    raw = {"attributions": [{"id": x["id"], "speaker": "mara vell"} for x in lines] + [{"id": "L99", "speaker": "x"}]}
    s = vt.score_blind(lines, raw, CAST)
    assert s["asked"] == 8 and s["right"] == 4 and s["accuracy"] == 0.5 and s["chance"] == 0.5
    assert s["confused"] == [{"names": ["Mara Vell", "Tom Reed"], "count": 4}]
    assert s["per"]["Tom Reed"] == {"lines": 4, "right": 0}
    # unusable: garbage, no list, fewer than half answered
    assert vt.score_blind(lines, "junk", CAST) is None
    assert vt.score_blind(lines, {"attributions": "x"}, CAST) is None
    assert vt.score_blind(lines, {"attributions": [{"id": lines[0]["id"], "speaker": "Tom Reed"}]}, CAST) is None


def test_writer_brief_report_and_settings(tmp_path):
    class Store:
        def __init__(self):
            self.d = {}

        def get_setting(self, k):
            return self.d.get(k)

        def set_setting(self, k, v):
            self.d[k] = v
    st = Store()
    assert vt.writer_brief(st, "p", "main", ["Mara Vell"]) == [] and vt.report_info(st, "p", "main") is None
    st.d["voice_test:p:main"] = {"pairs": [{"names": ["Mara Vell", "Tom Reed"], "why": ["both keep saying “x y z”"]}],
                                 "flat_chapters": [2], "speakers": {"Mara Vell": {"lines": 5, "words_per_line": 9.0,
                                                                                  "questions": 0.0}}, "blind": []}
    notes = vt.writer_brief(st, "p", "main", ["Tom Reed"])
    assert notes[0].startswith("Mara Vell and Tom Reed read alike") and "chapter(s) 2" in notes[1]
    assert vt.writer_brief(st, "p", "main", ["Nessa Crane"])[0].startswith("Dialogue in chapter(s) 2")
    md = vt.report_md(vt.report_info(st, "p", "main"))
    assert md[0] == "## Voices on the page" and any("read alike" in x for x in md)
    for mod, key in ((vt, "voice_test"), (sc, "subtext_check")):
        assert mod.clean_run_option({}) == {key: True} and mod.clean_run_option({key: False}) == {key: False}
        with pytest.raises(AkoweError):
            mod.clean_run_option({key: "yes"})
        assert mod.enabled({"settings": {}}) and not mod.enabled({"settings": {key: False}})


# ====================================================================== 💬 subtext: the first pass and the checks
def test_candidates_find_on_the_nose_lines_only_in_dialogue():
    text = ("I feel the cold, Mara thought, and climbed on.\n\n"
            "“I'm so angry with you,” Mara said. “The tide turns at six.”\n\n"
            "“You always do this,” Tom said.\n\n"
            "“I only came back because the lamp was out,” Nessa said.\n\n"
            "“That's what family means,” Tom said.")
    c = sc.candidates(text)
    assert [x["kind"] for x in c] == ["names a feeling", "accuses in absolutes", "explains a motive",
                                      "states the theme"]
    assert [x["id"] for x in c] == ["s1", "s2", "s3", "s4"] and c[0]["quote"] == "I'm so angry with you,"
    many = "\n\n".join(f"“I feel tired, {i},” Mara said." for i in range(20))
    assert len(sc.candidates(many)) == sc.MAX_CANDIDATES
    assert sc.candidates("No dialogue here. I feel fine.") == []


def test_validate_keeps_only_exact_safe_subtler_lines():
    text = "“I'm so angry with you,” Mara said.\n\n“You always do this,” Tom said. “You always do this.”"
    c = sc.candidates(text)
    ok = {"id": "s1", "on_the_nose": True, "original": "I'm so angry with you,", "replacement": "You took the boat,",
          "implied": "she is angry"}
    out = sc.validate({"lines": [ok]}, text, c)
    assert out == [{"id": "s1", "kind": "names a feeling", "original": "I'm so angry with you,",
                    "replacement": "You took the boat,", "implied": "she is angry"}]
    bad = [dict(ok, on_the_nose=False),                                         # the AI says it is fine
           dict(ok, id="s9"),                                                    # not a candidate
           dict(ok, original="I'm so furious with you,"),                        # not in the text
           dict(ok, id="s2", original="You always do this"),                     # twice in the text
           dict(ok, replacement="I'm so angry with you,"),                       # no change
           dict(ok, replacement="I feel so angry, you took the boat,"),          # still on the nose
           dict(ok, replacement="x" * 200),                                      # far too long
           dict(ok, original="Mara said."),                                      # not the line of dialogue
           "junk"]
    assert sc.validate({"lines": bad}, text, c) == []
    assert sc.validate("junk", text, c) == [] and sc.validate({"lines": "x"}, text, c) == []
    # one fix per candidate
    assert len(sc.validate({"lines": [ok, dict(ok, replacement="You left me,")]}, text, c)) == 1


# ====================================================================== in a ⚡ run
def _blind_mixes_up_mara_and_tom(ctx):
    names = [c["name"] for c in ctx["cast"]]
    assert "Mara Vell" in names and all("Mara" not in x["line"] and "Tom" not in x["line"] for x in ctx["lines"])
    return {"attributions": [{"id": x["id"], "speaker": "Nessa Crane" if "?" in x["line"] else "Mara Vell"}
                             for x in ctx["lines"]]}


def _subtext(ctx):
    cand = next(c for c in ctx["candidates"] if c["line"] == NOSE)
    return {"lines": [{"id": cand["id"], "on_the_nose": True, "original": NOSE, "replacement": SUBTLER,
                       "implied": "she feels betrayed"}]}


def _setup(fake):
    fake.max_chapters = 6
    for n in range(1, 7):
        fake.chapter_texts[f"ch{n}"] = chapter_text(n)


def test_make_a_book_tests_the_voices_feeds_the_brief_and_fixes_the_subtext(tmp_path):
    fake = SlotFake()
    _setup(fake)
    fake.voice_blind_script = [_blind_mixes_up_mara_and_tom, _blind_mixes_up_mara_and_tom]
    fake.subtext_script = [_subtext]
    app, fake, run = book(tmp_path, fake, body={"length": "novelette", "pictures": False})
    pid = run["project_id"]
    codes = [e.get("code") for e in run["events"]]
    bp, outline, chs = chapters(app, pid)
    assert len(chs) == 6
    # 🗣 two blind tests (the middle of the book, the end), each from the masked lines of the main speakers
    assert len(fake.prompts.get("voice_blind") or []) == 2
    assert "VOICE_BLIND" in codes and "VOICES_ALIKE_ON_PAGE" in codes
    entry = vt.stored(app.store, pid, "main")
    assert entry["final"] and len(entry["blind"]) == 2 and entry["blind"][0]["upto"] == 3
    pair = next(p for p in entry["pairs"] if p["names"] == ["Mara Vell", "Tom Reed"])
    assert pair["why"][0].startswith("an AI mixed up")
    # the writer of the chapters after the middle got the voice note (and the rule), the first ones did not
    briefs = {}
    for _s, c in fake.prompts.get("C02") or []:
        b = c.get("writing_brief") or (c.get("request_payload") or {}).get("writing_brief") or {}
        cid = (c.get("request_payload") or {}).get("chapter_id")
        briefs[cid] = b
    assert not briefs["ch1"].get("voice_notes") and not briefs["ch3"].get("voice_notes")
    assert any("Mara Vell and Tom Reed read alike" in n for n in briefs["ch4"]["voice_notes"])
    assert vt.WRITER_RULE in briefs["ch4"]["rules"]
    # 💬 chapter 1's on-the-nose line was confirmed by another AI and rewritten (reviewed again, approved)
    assert len(fake.prompts.get("subtext") or []) == 1        # only chapter 1 has a candidate: one AI check
    text1 = (chs[0][1].get("data") or {}).get("text")
    assert SUBTLER in text1 and NOSE not in text1
    assert chs[0][1]["lifecycle"] in ("APPROVED", "LOCKED") or chs[0][1].get("approved_version")
    assert "SUBTEXT_FIXED" in codes
    rows = sc.stored(app.store, pid, "main")
    assert rows["ch1"]["kept"] is True and rows["ch1"]["rewritten"] == 1
    # the report lists both, for the author
    rep = app.reports.make("author", pid, "main", ai=False)
    md = render_markdown(rep)
    assert "## Voices on the page" in md and "Mara Vell and Tom Reed read alike" in md
    assert "## Subtext (what the dialogue says outright)" in md and "1 rewritten" in md
    # journal lines carry no book text
    assert not any(NOSE in (e.get("message") or "") or SUBTLER in (e.get("message") or "") for e in run["events"])


def test_no_or_garbage_answers_leave_the_book_as_before(tmp_path):
    fake = SlotFake()  # defaults: no usable blind answer, nothing on the nose
    _setup(fake)
    fake.subtext_script = ["junk", {"lines": [{"id": "s1", "on_the_nose": True, "original": "not in the text",
                                               "replacement": "x", "implied": ""}]}]
    app, fake, run = book(tmp_path, fake, body={"length": "novelette", "pictures": False})
    pid = run["project_id"]
    codes = [e.get("code") for e in run["events"]]
    _bp, _o, chs = chapters(app, pid)
    assert NOSE in chs[0][1]["data"]["text"]                       # nothing rewritten
    assert "SUBTEXT_FIXED" not in codes and "VOICE_BLIND" not in codes
    assert "VOICE_BLIND_UNUSABLE" in codes                         # said once per blind test, the book went on
    entry = vt.stored(app.store, pid, "main")
    assert entry["blind"] == [] and entry["pairs"]                 # the no-AI part still found the alike pair


def test_an_ai_failure_is_a_note_and_the_book_goes_on(tmp_path):
    fake = SlotFake()
    _setup(fake)
    boom = [AkoweError("INTERNAL_ERROR", "", "bad answer")] * 6
    fake.fail_kind("subtext", *boom)
    fake.fail_kind("voice_blind", *boom)
    app, fake, run = book(tmp_path, fake, body={"length": "novelette", "pictures": False})
    codes = [e.get("code") for e in run["events"]]
    assert "SUBTEXT_CHECK_FAILED" in codes and "VOICE_BLIND_FAILED" in codes
    _bp, _o, chs = chapters(app, run["project_id"])
    assert NOSE in chs[0][1]["data"]["text"]


def test_the_off_switches(tmp_path):
    fake = SlotFake()
    _setup(fake)
    fake.subtext_script = [_subtext]
    app, fake, run = book(tmp_path, fake, body={"length": "novelette", "pictures": False, "voice_test": False,
                                                "subtext_check": False})
    pid = run["project_id"]
    assert not fake.prompts.get("voice_blind") and not fake.prompts.get("subtext")
    assert vt.stored(app.store, pid, "main") is None and sc.stored(app.store, pid, "main") == {}
    _bp, _o, chs = chapters(app, pid)
    assert NOSE in chs[0][1]["data"]["text"]
    assert run["settings"]["voice_test"] is False and run["settings"]["subtext_check"] is False
