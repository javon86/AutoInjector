"""✂ Cut about 10 % and label every cut (cut_pass.py) and 📊 the whole-book budgets (book_budgets.py) — research
recommendations 4 and 11 of "AI novel quality beyond eight"."""
from __future__ import annotations

from collections import Counter

import pytest

from akowe import book_budgets as bb
from akowe import chapter_brief
from akowe import cut_pass as cp
from akowe.errors import AkoweError

from test_failover_review import SlotFake
from test_world_planned import book, chapters

T = ("# Chapter 2\n\nOne two three. She felt sad because it rained. Four five six.\n\nA whole paragraph to cut here."
     "\n\n“We sail at nine,” Tom said. Then he left.\n\nThe last paragraph stays.")


# ====================================================================== ✂ pure: spans, checks, the cap
def test_span_takes_the_spaces_and_paragraph_breaks_with_the_cut():
    assert cp.span(T, "She felt sad because it rained.") == ("She felt sad because it rained. ", "")
    assert cp.span(T, "A whole paragraph to cut here.") == ("A whole paragraph to cut here.\n\n", "")
    assert cp.span(T, "Four five six.") == (" Four five six.", "")
    assert cp.span(T, "Four five six.", "Four six.") == ("Four five six.", "Four six.")
    head_end, last = cp.protected_from(T)
    assert T[:head_end] == "# Chapter 2\n" and T[last:] == "The last paragraph stays."


def test_validate_refuses_every_unsafe_cut_and_keeps_the_rest():
    raw = {"cuts": [{"quote": "She felt sad because it rained.", "label": "over_explaining"},
                    {"quote": "A whole paragraph to cut here.", "label": "padding"},
                    {"quote": "The last paragraph stays.", "label": "padding"},          # the last paragraph
                    {"quote": "“We sail at nine,” Tom said.", "label": "repetition"},    # dialogue with a plot fact
                    {"quote": "not in the chapter", "label": "generic"},                 # not word for word
                    {"quote": "One two", "label": "nonsense"},                           # no known label
                    {"quote": "Four five six.", "label": "telling", "shorter": "Four seven."},  # adds a new word
                    {"quote": "felt sad", "label": "telling"},                           # overlaps the first cut
                    {"quote": "# Chapter 2", "label": "padding"},                        # the heading
                    {"quote": "x", "label": "padding"}, "junk"]}
    cuts, refused = cp.validate(T, raw, plot_words={"sail"})
    assert [(c["label"], c["words"]) for c in cuts] == [("over_explaining", 6), ("padding", 6)]
    assert refused == Counter({"PROTECTED_END": 2, "DIALOGUE_FACT": 1, "NOT_FOUND": 1, "LABEL": 1, "SHORTER_NEW": 1,
                               "OVERLAP": 1, "TOO_SHORT": 1, "BAD": 1})
    assert cp.apply_cuts(T, cuts) == ("# Chapter 2\n\nOne two three. Four five six.\n\n“We sail at nine,” Tom said. "
                                      "Then he left.\n\nThe last paragraph stays.")
    # a keep quote of the editor, and a planned item that would leave the page, are never cut
    _c, r = cp.validate(T, {"cuts": [{"quote": "She felt sad because it rained.", "label": "telling"}]},
                        keep=["because it rained"])
    assert r == Counter({"KEEP": 1})
    item = {"id": "i1", "kind": "beat", "label": "Outline beat: rain", "text": "it rained sadly",
            "words": ["rain", "sad"], "required": True}
    _c, r = cp.validate(T, {"cuts": [{"quote": "She felt sad because it rained.", "label": "telling"}]},
                        planned_items=[item])
    assert r == Counter({"PLANNED": 1})
    # a twice-written passage and garbage answers
    assert cp.validate("Same line here. Same line here.\n\nEnd.", {"cuts": [{"quote": "Same line here.",
                                                                             "label": "repetition"}]})[1]["AMBIGUOUS"] == 1
    for bad in (None, "junk", {"cuts": "x"}, {"nothing": []}):
        assert cp.validate(T, bad) == ([], Counter())


def test_cap_keeps_targets_and_common_fat_first_within_the_share():
    text = " ".join(f"word{i}" for i in range(200)) + ".\n\nEnd."
    cuts = [{"id": f"cut-{i}", "quote": f"word{i * 10}", "label": lab, "words": w, "target": tg, "original": f"word{i * 10} ",
             "replacement": ""} for i, (lab, w, tg) in enumerate([("generic", 10, False), ("over_explaining", 12, False),
                                                                  ("padding", 9, True), ("structural", 20, False)])]
    refused = Counter()
    kept = cp.cap(text, cuts, refused)  # 202 words: at most 28 in all, one cut at most 16
    assert [c["label"] for c in kept] == ["over_explaining", "padding"]  # chapter order; the target went first
    assert refused == Counter({"TOO_BIG": 1, "OVER_CAP": 1})
    assert cp.cap(text, cuts, Counter(), floor_words=195) == []  # never below the chapter's floor
    assert cp.label_counts(kept) == {"over_explaining": 1, "padding": 1}
    assert cp.labels_line({"over_explaining": 3, "repetition": 2}) == "over-explaining 3, repetition 2"


def test_run_options_are_checked():
    assert cp.clean_run_option({}) == {"cut_pass": True, "book_budgets": True}
    assert cp.clean_run_option({"cut_pass": False, "book_budgets": False}) == {"cut_pass": False,
                                                                                "book_budgets": False}
    for k in ("cut_pass", "book_budgets"):
        with pytest.raises(AkoweError) as e:
            cp.clean_run_option({k: "no"})
        assert e.value.code == "INVALID_INPUT" and e.value.errors[0]["path"] == f"/{k}"


# ====================================================================== 📊 pure: counts, budgets, the reread filter
HABITS = ("It was not fear but hope. It was not cold, not warm, only grey. Red, green and blue. Salt, rope and tar. "
          "Fog, gulls and stone. The boats knocked like a restless ghost. The mast leaned like a restless ghost. "
          "She felt a wave of grief because the keeper was gone, which meant she was alone.\n\nShe slept.")


def test_measure_counts_the_habits_of_the_narration_only():
    m = bb.measure(HABITS + "\n\n“Not this but that, and red, green and blue,” Tom said.")
    assert m["not_but"] == 2 and m["triad"] == 3 and m["simile"] == {"like a restless ghost": 2}
    assert m["explain"] == 1 and m["ending"] == "dialogue"
    over = {o["code"]: o for o in bb.chapter_over(m)}
    assert over["not_but"] == {"code": "not_but", "count": 2, "cap": 1} and over["triad"]["cap"] == 2
    assert bb.chapter_over(bb.measure("A plain sentence here. Another plain one.")) == []
    assert "ghost" in m["vocab"] and "ghost" not in bb.measure(HABITS, ["ghost"])["vocab"]


def test_book_over_and_the_writer_lines():
    e1 = dict(bb.measure(HABITS), number=1)
    e2 = dict(bb.measure("The lamp swung like a restless ghost. Plain words follow here.\n\nShe slept."), number=2)
    bo = bb.book_over([e1, e2])
    assert bo["similes"] == [("like a restless ghost", 2)] and bo["ending"] == ("sleep", [1, 2])
    lines = bb.lines_for([e1, e2])
    text = " ".join(lines)
    assert "At most 1 “not X but Y” sentence" in text and "chapter 1 had 2" in text
    assert "At most 2 lists of three" in text and "“like a restless ghost” (2 chapters)" in text
    assert "Chapters 1, 2 both end on someone falling asleep" in text
    # a word the whole book leans on (not a name, not a plain-word tic of quality_history)
    many = [dict(number=i, words=1000, vocab={"sharp": 9, "looked": 9}, simile={}) for i in range(1, 4)]
    assert bb.book_over(many)["words"] == [("sharp", 27, 9.0)]
    assert bb.lines_for([]) == []


def test_strip_similes_leaves_dialogue_alone():
    s, n = bb._strip_similes("The mast creaked like a restless ghost, and “it moved like a restless ghost,” she said.",  # noqa: SLF001
                             ["like a restless ghost"])
    assert n == 1 and s == "The mast creaked, and “it moved like a restless ghost,” she said."


# ====================================================================== in a ⚡ run
CH1 = ("The fog rolled in over Gullhaven before dawn, and Mara Vell climbed the hundred and twelve steps of the old "
       "lighthouse with a lantern in one hand and her master's last letter in the other. It was not fear she felt but "
       "duty. It was not the cold, not the dark, not the height. The steps were wet, worn and narrow. The rail was "
       "rusted, bent and loose. The wind came like a restless ghost through the broken pane.\n\n"
       "The lamp room was cold. Tom Reed's logbook lay open beside a cracked lens, and the final line was written in a "
       "hand she did not know. The lens hung like a restless ghost above her.")
PAD = "She wondered, as she always wondered on such mornings, whether the gulls ever tired of their own crying."
EXPLAIN = "She felt a deep wave of sadness because nobody would help her, which meant she was alone in this."
CH2 = ("Down in the harbor the fishing boats knocked together like a restless ghost. Mara asked every captain about "
       "the night the light went dark, and every captain looked away. " + EXPLAIN + " The nets hung drying on their "
       "poles, and the tar smell of the sheds came and went with the wind off the water.\n\n"
       "Only old Nessa at the net sheds would talk, and only in a whisper: the keeper had gone out to the reef with a "
       "stranger, and only the stranger had come back. “The light went dark at 9,” Nessa said, and spat.\n\n"
       "Captain Harrow mended a lobster pot on the slip and would not look up from the willow. His son coiled a "
       "line at his feet, hand over hand, and counted the turns under his breath. Two women carried a basket of "
       "mackerel between them up the cobbles towards the smokehouse, their boots slipping on the weed, and a dog "
       "followed them with its nose in the air. Somebody had chalked a tide table on the harbor master's door and "
       "somebody else had rubbed out the evening line with a thumb.\n\n"
       "Mara bought a twist of salt fish from the stall by the steps and ate it standing, watching the reef come up "
       "out of the falling water, black and wet, a long way out past the moorings. A cormorant dried its wings on the "
       "end post. The bell buoy rang once, then again, and the gulls lifted off the warehouse roof all together and "
       "settled again a yard further along.\n\n"
       + PAD + " The tide turned under the pier and the moored boats swung round on their ropes to face the sea, "
       "every bow the same way.\n\n"
       "Mara walked home along the sea wall and counted the dark windows of the keepers' row, one by one.")


def _cuts(ctx):
    text = ctx["chapter_text"]
    if "net sheds" not in text:
        return {"cuts": [], "fat_percent": 5}
    return {"fat_percent": 18, "cuts": [
        {"quote": EXPLAIN, "label": "over_explaining"},
        {"quote": PAD, "label": "padding"},
        {"quote": "Mara walked home along the sea wall and counted the dark windows of the keepers' row, one by one.",
         "label": "padding"},                                                     # the last paragraph: refused
        {"quote": "“The light went dark at 9,” Nessa said, and spat.", "label": "padding"},  # a plot fact: refused
        {"quote": "a sentence the chapter never had", "label": "generic"}]}      # not word for word: refused


def _fake(**kw):
    fake = SlotFake(**kw)
    fake.chapter_texts = {"ch1": CH1, "ch2": CH2}
    return fake


def _cut_entry(app, pid, cid="ch2"):
    return cp.stored(app.store, pid, "main").get(cid)


def test_make_a_book_cuts_labels_and_reports_and_the_budgets_feed_forward(tmp_path, monkeypatch):
    monkeypatch.setattr(cp, "LENGTH_FLOOR", 0)  # the fake's chapters are far shorter than their share of the book
    fake = _fake()
    fake.cut_script = [_cuts, _cuts, _cuts]
    app, fake, run = book(tmp_path, fake)
    pid = run["project_id"]
    # 1. one editor call per chapter at most, and an independent editor (not the writer AI-1)
    asks = fake.prompts.get("cuts") or []
    assert 1 <= len(asks) <= 3
    _sys, ctx = next((s, c) for s, c in asks if "net sheds" in c["chapter_text"])
    assert set(ctx["cut_rules"]["labels"]) == set(cp.LABELS) and ctx["cut_rules"]["target_percent"] == 10
    assert ctx["must_stay"]  # the planned items on the page
    # 2. the cut version is the approved chapter 2: both cuts gone, the protected passages still there
    bp, outline, chs = chapters(app, pid)
    rec2 = dict(chs)["ch2"]
    text = rec2["data"]["text"]
    assert rec2["lifecycle"] == "APPROVED" and EXPLAIN not in text and PAD not in text
    assert "“The light went dark at 9,” Nessa said" in text and text.rstrip().endswith("one by one.")
    e = _cut_entry(app, pid)
    assert e["kept"] and e["labels"] == {"over_explaining": 1, "padding": 1} and e["cuts"] == 2
    assert e["refused"] == {"PROTECTED_END": 1, "DIALOGUE_FACT": 1, "NOT_FOUND": 1}
    assert e["to_version"] == rec2["version"] and e["fat_percent"] == 18 and 0.06 <= e["share"] <= 0.14
    ev = [x for x in run["events"] if x.get("code") == "CUT_PASS_KEPT"]
    assert ev and ev[0]["labels"] == {"over_explaining": 1, "padding": 1} and EXPLAIN not in ev[0]["message"]
    # 3. 📊 chapter 1 was over its budgets: chapter 2's writer was told; its rereading lost the repeated simile
    briefs = [((c.get("writing_brief") or (c.get("request_payload") or {}).get("writing_brief")) or {})
              for _s, c in fake.prompts.get("C02") or []]
    with_b = [b for b in briefs if b.get("book_budgets")]
    assert with_b and any("“not X but Y”" in x for x in with_b[0]["book_budgets"])
    assert bb.BRIEF_RULE in with_b[0]["rules"]
    st = bb.stored(app.store, pid, "main")["chapters"]
    assert set(st) >= {"ch1", "ch2"} and st["ch1"]["not_but"] == 2 and "text" not in st["ch1"]
    assert any(x.get("code") == "BUDGET_OVER" and x.get("chapter_id") == "ch1" for x in run["events"])
    b3, _m = chapter_brief.build(app.store, pid, "main", outline, chs[2][0])
    assert "Mara asked every captain" in b3["previous_chapter_end"]  # the over-used simile is gone …
    assert "like a restless ghost" not in b3["previous_chapter_end"] and bb.REREAD_RULE in b3["rules"]
    assert "like a restless ghost" in rec2["data"]["text"]  # … from what the writer rereads, not from the book
    assert any("like a restless ghost" in x for x in b3.get("book_budgets") or [])
    # 4. the book report lists the labels per chapter and the budgets
    info = cp.report_info(app.store, pid, "main")
    assert info["line"].startswith("✂ Cut pass: 1 of ") and info["totals"] == {"over_explaining": 1, "padding": 1}
    md = "\n".join(cp.report_md(info) + bb.report_md(bb.report_info(app.store, pid, "main")))
    assert "Chapter 2:" in md and "over-explaining 1, padding 1" in md and "## Book budgets (no AI)" in md
    rep = app.reports.latest(pid, "main")
    assert rep["cuts"]["line"] == info["line"] and rep["budgets"]["line"].startswith("📊 Book budgets: ")
    from akowe import book_report  # noqa: PLC0415
    full = book_report.render_markdown(rep)
    assert "## Cut 10% and label every cut" in full and "## Book budgets (no AI)" in full


def test_a_cut_the_reviewer_does_not_accept_is_put_back(tmp_path, monkeypatch):
    monkeypatch.setattr(cp, "LENGTH_FLOOR", 0)

    def verdict(ctx):
        data = (ctx.get("draft") or {}).get("data_json") or ""
        return "REVISE" if "net sheds" in data and EXPLAIN not in data else "APPROVE"
    fake = _fake(default_verdict=verdict)
    fake.cut_script = [_cuts, _cuts, _cuts]
    app, fake, run = book(tmp_path, fake)
    pid = run["project_id"]
    _bp, _o, chs = chapters(app, pid)
    text = dict(chs)["ch2"]["data"]["text"]
    assert EXPLAIN in text and PAD in text  # the earlier text came back and was approved
    e = _cut_entry(app, pid)
    assert e["outcome"] == "not_kept" and not e["kept"] and e["why"].startswith("review")
    assert any(x.get("code") == "CUT_PASS_NOT_KEPT" for x in run["events"])


@pytest.mark.parametrize("answer", ["junk", {"cuts": "x", "fat_percent": 3}, {"cuts": [{"quote": 4}]}, "fail"])
def test_no_or_garbage_answer_leaves_the_book_as_before(tmp_path, monkeypatch, answer):
    monkeypatch.setattr(cp, "LENGTH_FLOOR", 0)
    fake = _fake()
    if answer == "fail":
        fake.fail_kind("cuts", *[AkoweError("INTERNAL_ERROR", "/", "the editor broke")] * 3)
    else:
        fake.cut_script = [answer] * 3
    app, fake, run = book(tmp_path, fake)
    assert run["status"] == "done"
    _bp, _o, chs = chapters(app, run["project_id"])
    assert dict(chs)["ch2"]["data"]["text"] == CH2
    code = "CUT_PASS_FAILED" if answer == "fail" else "CUT_PASS_NOTHING"
    assert any(x.get("code") == code for x in run["events"])
    assert not any(x.get("code") == "CUT_PASS_KEPT" for x in run["events"])


def test_the_off_switches(tmp_path, monkeypatch):
    monkeypatch.setattr(cp, "LENGTH_FLOOR", 0)
    fake = _fake()
    fake.cut_script = [_cuts, _cuts, _cuts]
    app, fake, run = book(tmp_path, fake, body={"cut_pass": False, "book_budgets": False})
    pid = run["project_id"]
    assert not fake.prompts.get("cuts")
    _bp, outline, chs = chapters(app, pid)
    assert dict(chs)["ch2"]["data"]["text"] == CH2 and cp.report_info(app.store, pid, "main") is None
    assert bb.report_info(app.store, pid, "main") is None
    assert not any(b.get("book_budgets") for b in [
        ((c.get("writing_brief") or (c.get("request_payload") or {}).get("writing_brief")) or {})
        for _s, c in fake.prompts.get("C02") or []])
    assert not any(x.get("code") == "BUDGET_OVER" for x in run["events"])


def test_a_chapter_too_short_to_cut_costs_no_ai_call(tmp_path):
    fake = _fake()  # the real floor: the fake's chapters are far under their share of the book
    fake.cut_script = [_cuts, _cuts, _cuts]
    app, fake, run = book(tmp_path, fake)
    assert not fake.prompts.get("cuts")
    assert _cut_entry(app, run["project_id"]) is None


def test_reread_filter_takes_over_used_similes_out_of_what_the_writer_rereads(monkeypatch):
    class Store:
        def __init__(self):
            self.s = {}

        def get_setting(self, k):
            return self.s.get(k)

        def set_setting(self, k, v):
            self.s[k] = v
    store = Store()
    sim = {"like a restless ghost": 1}
    monkeypatch.setattr(bb, "before", lambda *a, **k: [dict(number=1, simile=sim), dict(number=2, simile=sim)])
    brief = {"previous_chapter_end": "The boats knocked together like a restless ghost. “Like a restless ghost,” "
                                     "she said.", "story_so_far": ["Chapter 1: the wind moved like a restless ghost."]}
    assert bb.reread_filter(brief, store, "p", "main", None, "ch3") == 2
    assert brief == {"previous_chapter_end": "The boats knocked together. “Like a restless ghost,” she said.",
                     "story_so_far": ["Chapter 1: the wind moved."]}
    bb.set_off(store, "p", "main", True)  # the run switched the budgets off: nothing is touched
    other = {"previous_chapter_end": "It moved like a restless ghost."}
    assert bb.reread_filter(other, store, "p", "main", None, "ch3") == 0 and "ghost" in other["previous_chapter_end"]
    assert bb.writer_block(store, "p", "main", None, "ch3") == []
