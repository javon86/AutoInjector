"""The Tide Ledger fixes: 💬 one dialogue finder for every quoting style, 📅 weekday / date arithmetic in the clock
check, 📏 the length guard of Akọwe's own rewrites, ✂ lists of three in the chapter polish and 🔁 Akọwe's own rewrites
never taken for hand edits (the final whole-book check read again)."""
from __future__ import annotations

import json

from akowe import chapter_polish as cp
from akowe import clock_check, continuity, dialogue, human_voice, length_guard, originality, readability
from akowe import improve_pass, quality_history, run_forecast
from akowe.editor import apply_replacements

BRITISH = ("'Come here,' Teo said. 'The boys' boat is gone, and I don't know where.'\n\n"
           "He'd loved rock 'n' roll since the '90s. Teo's mother hadn't.\n\n"
           "'Fine' she said, and went down to the slip with the twins' coats.\n\n"
           "'I told 'im,' Mara said. 'He wouldn't 'ave it.'")


# ====================================================================== 💬 A. the dialogue finder
def test_single_quote_dialogue_is_found_and_apostrophes_are_not():
    assert dialogue.quotes(BRITISH) == ["'Come here,'", "'The boys' boat is gone, and I don't know where.'",
                                        "'Fine'", "'I told 'im,'", "'He wouldn't 'ave it.'"]
    nar = dialogue.narration(BRITISH, "_")
    for kept in ("He'd loved rock 'n' roll since the '90s.", "Teo's mother hadn't.", "the twins' coats"):
        assert kept in nar  # apostrophes are never speech
    assert dialogue.style(BRITISH) == "single"


def test_every_quoting_style_is_dialogue():
    assert dialogue.quotes("“Hello,” he said. \"Bye,\" she said.") == ["“Hello,”", "\"Bye,\""]
    assert dialogue.quotes("‘Where are you going?’ asked Mara. ‘Out,’ he said.") == ["‘Where are you going?’",
                                                                                  "‘Out,’"]
    assert dialogue.quotes("— Where are you going? he asked.\n\nShe did not answer.") == [
        "— Where are you going? he asked."]
    # a speech carried over into the next paragraph (British style) is dialogue up to the paragraph's end
    assert dialogue.quotes("'The tide turns at four. You'll want to be off the sands by then.\n\nHe nodded.") == [
        "'The tide turns at four. You'll want to be off the sands by then."]
    assert dialogue.quotes("The so-called 'experts' were wrong. They sang 'em all night.") == []
    assert dialogue.starts_with_dialogue("'Is it Monday?' she asked.")
    assert not dialogue.starts_with_dialogue("'90s music played.")
    m = dialogue.FINDER.search("x 'Go on,' she said")
    assert m.group(1) == "Go on," and m.group(0) == "'Go on,'"


def test_the_readability_dialogue_share_counts_single_quotes():
    r = readability.chapter(BRITISH)
    assert r["dialogue_share"] > 0.3, r  # "0% dialogue" before


def test_the_polish_guard_never_lets_dialogue_change_in_any_style():
    names = ["Teo", "Mara"]
    assert cp.protected_change(BRITISH, BRITISH.replace("I don't know where", "I can't say where"), names) == \
        "DIALOGUE"
    assert cp.protected_change(BRITISH, BRITISH.replace("'Fine' she", "'Fine,' she"), names) == "DIALOGUE"
    dash = "— Where are you going? he asked.\n\nThe tide was out."
    assert cp.protected_change(dash, dash.replace("going?", "off to?"), names) == "DIALOGUE"
    curly = "‘Out,’ he said. The tide was out."
    assert cp.protected_change(curly, curly.replace("Out,", "Away,"), names) == "DIALOGUE"
    # narration may change; curly vs straight marks are the same line
    assert cp.protected_change(BRITISH, BRITISH.replace("went down to the slip", "walked down to the slip"),
                               names) is None
    assert cp.protected_change(curly, curly.replace("‘Out,’", "'Out,'"), names) is None
    # a paragraph with single-quote dialogue is never sent as a stretch to join
    text = "\n\n".join(["'Go. Now. Run,' Teo said. 'Go on.' She went. He did not."] * 3 + [
        "The sea was grey. The boat was old. The rope was wet. The gulls were loud."])
    assert all("'" not in s for s in cp._stretches(text))  # noqa: SLF001


def test_the_other_checks_skip_single_quote_dialogue():
    text = "'At the end of the day, it is what it is,' Teo said. The harbour was quiet."
    rep = originality.check([("c1", text)])
    assert rep["narration_words"] < rep["words"]
    assert human_voice.opening_kind("'Is it Monday?' she asked.") == "dialogue"
    assert human_voice.closing_kind("'Go home,' she said, 'and stay there.'") == "dialogue"
    # plain-word tics count the narration only
    assert "said" not in quality_history._QUOTED.sub(" ", "'said said said'")  # noqa: SLF001


# ====================================================================== 📅 G. weekdays and dates
def _cal(text):
    return [f for f in clock_check.check_book([("c1", text)])["findings"] if f["check"].startswith("weekday")]


def test_a_friday_four_days_after_the_day_after_the_first_monday_is_flagged():
    f = _cal("It was the first Monday of January, and the harbour was frozen.\n\nThe next morning Teo went down "
             "to the boats. Four days later, on the Friday, the ice broke.")
    assert len(f) == 1 and f[0]["check"] == "weekday_jump" and f[0]["severity"] == "major"
    assert "Saturday" in f[0]["detail"] and "Friday" in f[0]["detail"]
    assert f[0]["passages"][-1]["quote"].startswith("Four days later")
    assert not _cal("It was the first Monday of January.\n\nFour days later, on Friday, the ice broke.")


def test_a_sunday_followed_the_next_morning_by_a_saturday_is_flagged():
    f = _cal("On Sunday the ferry did not run.\n\nThe next morning, Saturday, Mara walked to the quay.")
    assert len(f) == 1 and "Monday" in f[0]["detail"]


def test_the_second_saturday_six_days_after_the_first_is_flagged():
    f = _cal("The first Saturday of March was market day. Mara sold eels.\n\nSix days later came the second "
             "Saturday, and the market again.")
    assert len(f) == 1 and f[0]["check"] == "weekday_jump"


def test_dates_and_weekdays_must_add_up():
    f = _cal("On Monday, 6 January, the ledger opened. Four days later, on Friday 9 January, it closed.")
    assert len(f) == 1 and "10 January" in f[0]["detail"]
    f = _cal("Monday, 6 January was cold.\n\nFriday, 14 January was colder.")
    assert len(f) == 1 and f[0]["check"] == "weekday_date"
    assert not _cal("Monday, 6 January was cold.\n\nFriday, 10 January was colder.")


def test_the_calendar_check_works_across_chapters_and_feeds_the_must_fix_flags():
    book = clock_check.check_book([("c1", "On Sunday the ferry did not run."),
                                   ("c2", "The next morning, Saturday, Mara walked to the quay.")])
    f = [x for x in book["findings"] if x["check"] == "weekday_jump"]
    assert f and clock_check.for_chapter(book, "c2") and not clock_check.for_chapter(book, "c1")


def test_vague_jumps_dialogue_and_plain_weeks_are_never_flagged():
    assert not _cal("On Sunday the ferry did not run. A few days later, on Saturday, it did.")
    assert not _cal("'On Sunday,' she said. 'The next morning was Saturday,' he lied.")
    assert not _cal("On Monday they mended nets. On Thursday the boat came back.")
    assert not _cal("On Friday she would go to the market. The next morning, Saturday, she went.")
    assert not _cal("It was Tuesday. Every Friday the boat came in. The next day, Wednesday, it rained.")


# ====================================================================== 📏 E. the length guard
def test_the_budget_and_the_check():
    b = length_guard.budget(1000, 4100, 4000)
    assert b["may_add"] == 100 and b["most_words"] == 1100 and b["book_share"] == "102%"
    assert length_guard.budget(1000, 4580, 4000)["may_add"] == 20   # the book's cap (4,600) is near
    assert length_guard.budget(1000, 5000, 4000)["may_add"] == 0    # already past it: only shorter
    assert length_guard.budget(100)["may_add"] == length_guard.SLACK_WORDS
    old = " ".join(["word"] * 1000)
    assert length_guard.check(old, old + " more" * 150) == "CHAPTER"
    assert length_guard.check(old, old + " more" * 50, 4560, 4000) == "BOOK"
    assert length_guard.check(old, old + " more" * 50, 4000, 4000) is None
    assert length_guard.check(old, " ".join(["word"] * 900), 9000, 4000) is None  # shorter is always fine
    assert length_guard.line(5756, 4000) == "📏 Length: 5,756 words (144% of the 4,000-word target) ⚠️ longer than " \
                                             "planned"


def test_trim_leaves_out_the_replacements_that_add_the_most_words():
    text = "Alpha one. Beta two. Gamma three."
    fs = [{"id": "f1", "passage": "Alpha one."}, {"id": "f2", "passage": "Beta two."},
          {"id": "f3", "passage": "Gamma three."}]
    reps = [{"finding_id": "f1", "original": "Alpha one.", "replacement": "Alpha one, and " + "more " * 30 + "."},
            {"finding_id": "f2", "original": "Beta two.", "replacement": "Beta, two."},
            {"finding_id": "f3", "original": "Gamma three.", "replacement": "Gamma three and four."}]
    res = apply_replacements(text, reps, fs, [])
    out, cut = length_guard.trim(text, res, fs, [], 5)
    assert cut == ["f1"] and {a["finding_id"] for a in out["applied"]} == {"f2", "f3"}
    assert any(u["finding_id"] == "f1" and u["reason"] == length_guard.TOO_LONG for u in out["unresolved"])
    assert "more more" not in out["text"]


def test_the_polish_may_not_grow_a_chapter_by_more_than_ten_percent():
    old = " ".join(["The sea was grey."] * 100)        # 400 words
    assert cp.protected_change(old, old + " It rained." * 30, []) == "LENGTH"      # +60 words = 15 %
    assert cp.protected_change(old, old + " It rained." * 15, []) is None          # +30 words = 7.5 %
    assert cp.protected_change(old, old + " It rained." * 30, [], None) is None    # the guard switched off


def test_an_improve_round_keeps_the_book_under_its_cap():
    class _Store:
        pass
    chapters = [{"chapter_id": f"c{i}", "text": " ".join(["w"] * 1500)} for i in range(3)]   # 4,500 words
    cands = [{"chapter_id": "c0", "text": " ".join(["w"] * 1600)},     # +100: 4,600 = the cap (4,000 × 1.15)
             {"chapter_id": "c1", "text": " ".join(["w"] * 1650)}]     # +150
    import akowe.lengths as lengths
    real = lengths.of_book
    lengths.of_book = lambda store, pid, n=None: {"book_words": 4000}
    try:
        kept = improve_pass.within_budget(chapters, cands, _Store(), "p", {})
        assert [c["chapter_id"] for c in kept] == ["c0"]
        assert improve_pass.within_budget(chapters, cands, _Store(), "p", {"length_guard": False}) == cands
    finally:
        lengths.of_book = real


# ====================================================================== ✂ F. lists of three
TRIADS = ("The harbour was cold, wet, and grey. Teo carried the rope, the hook, and the lamp to the slip. "
          "'We need salt, bread, and nets,' Mara said. He was tired, hungry, and late. The boat rocked.")


def test_lists_of_three_in_the_narration_call_for_a_polish():
    assert len(cp.triads(TRIADS)) == 3  # the one in dialogue never counts
    m = cp.measure(TRIADS, [])
    assert "triads" in cp.needs(m, None)
    assert "triads" not in cp.needs(m, None, {"polish_triads": False})
    fs = cp.findings(TRIADS, m, None, ["triads"])
    assert len(fs) == 3 and all(f["passage"] in TRIADS and "'" not in f["passage"] for f in fs)
    assert all("list of three" in f["why"].lower() for f in fs)
    calm = "The harbour was cold and grey. Teo carried the rope to the slip. " * 10
    assert "triads" not in cp.needs(cp.measure(calm, []), None)


def test_a_polish_that_breaks_up_triads_is_kept_and_one_that_adds_them_is_not():
    b = {"grade": 6.0, "repeats": 0, "tic_uses": 0, "ai": 0, "triads": 4, "words": 300}
    assert cp.judge(b, dict(b, triads=1), 5.0, 10.0) == (True, "KEPT")
    assert cp.judge(b, dict(b, triads=5), 5.0, 10.0) == (False, "MORE_TRIADS")
    assert cp.judge(b, b, 5.0, 10.0) == (False, "NO_GAIN")


def test_the_briefs_say_how_to_break_up_a_list_of_three():
    assert any("list of three" in r for r in cp.POLISH_RULES) and "list of three" in cp.POLISH_WORDS
    pat = next(p for p in human_voice.patterns() if p.startswith("lists of three"))
    assert "cold and wet" in pat and "socks" in pat
    assert "cold and wet" in quality_history.HABIT_LESSONS["triad"]


# ====================================================================== 🔁 B. Akọwe's own rewrites
class _MemStore:
    def __init__(self):
        self.s = {}

    def get_setting(self, k):
        return json.loads(json.dumps(self.s.get(k))) if k in self.s else None

    def set_setting(self, k, v):
        self.s[k] = json.loads(json.dumps(v))


def test_own_revisions_are_registered_and_dated():
    st = _MemStore()
    continuity.note_own(st, "p", "main", "r1", 4)
    assert continuity.is_own(st, "p", "main", "r1", 4) and not continuity.is_own(st, "p", "main", "r1", 5)
    assert continuity.own_changes_since(st, "p", "main", {1: "r1", 2: "r2"}, "2000-01-01T00:00:00Z") == [1]
    assert continuity.own_changes_since(st, "p", "main", {1: "r1"}, "2999-01-01T00:00:00Z") == []
    for v in range(30):
        continuity.note_own(st, "p", "main", "r2", v)
    assert len(st.s["continuity_rechecks:p:main"]["own"]["r2"]) == continuity.OWN_MAX


def test_the_forecast_counts_the_second_reads():
    opts = run_forecast.options_of(None, {"beta_reader": True})
    on = run_forecast.option_calls(opts, 3, 3)["reread"]["calls"]
    assert on == 3 + 1  # the final check by each checking AI + the beta reader once more
    off = run_forecast.options_of(None, {"beta_reader": True, "reread_after_rewrites": False, "beta_reread": False})
    assert run_forecast.option_calls(off, 3, 3)["reread"]["calls"] == 0
    none = run_forecast.options_of(None, {"opening_pass": False, "improve_pass": False})
    assert run_forecast.option_calls(none, 3, 3)["reread"]["calls"] == 0


# ====================================================================== 🔁 B / C. in a run
def _opening_kept_run(tmp_path, **extra):
    from test_opening_pass import SlotFake, _review, _rewrite_opening, make_app, run_book
    fake = SlotFake()
    fake.opening_rewrite_script = [_rewrite_opening]
    fake.book_review_script = [None, None, _review(8), _review(8)]
    app = make_app(tmp_path, fake)
    run = run_book(app, dict({"length": "short_story", "improve_pass": False, "first_page": False,
                              "beta_reader": True}, **extra))
    assert run["status"] == "done", run.get("problem")
    return app, fake, run


def test_after_akowes_own_rewrite_the_final_check_and_the_beta_reader_read_the_final_book(tmp_path):
    from akowe import beta_reader, checkpoints
    from akowe import book_report as br
    from akowe.book_path import BookPath
    app, fake, run = _opening_kept_run(tmp_path)
    codes = [e.get("code") for e in run["events"]]
    assert "OPENING_KEPT" in codes and "FINAL_CHECK_AGAIN" in codes and "BETA_AGAIN" in codes
    assert "CHAPTER_CHANGED" not in codes  # Akọwe's own rewrite is never "changed by hand"
    pid = run["project_id"]
    final = next(c for c in checkpoints.items(app.store, pid, "main") if c["id"] == "final")
    assert final["status"] == "done" and "read again after Akọwe's own rewrites" in checkpoints.line(final)
    assert "changed by hand" not in checkpoints.line(final)
    # the beta reader read twice; the newest read is of the final book (no "earlier version" warning)
    assert fake.kinds.count("beta") == 2
    chapters = br.book_chapters(BookPath(app.engine, "author", pid, "main"))
    latest = beta_reader.service_of(app).latest(pid, "main")
    assert latest["version_key"] == br.version_key(chapters)
    ids = [s["id"] for s in run["steps"]]
    assert ids[-1] == "reread" and ids.index("improve") < ids.index("reread")
    st = {s["id"]: s for s in run["steps"]}["reread"]
    assert "📏 Length:" in st["message"] and run["report"]["length"].startswith("📏 Length:")
    # the hand-edit check (run by the book page while a run works) never takes Akọwe's own revision for a hand edit
    ch1 = chapters[0]
    key = f"{continuity.RECHECK_KEY}:{pid}:main"
    cur = app.store.get_setting(key)
    cur["seen"][ch1["chapter_id"]]["version"] = ch1["version"] - 1  # as if read before note_written ran
    app.store.set_setting(key, cur)
    assert continuity.check_edits(app.store, pid, "main") == []
    final = next(c for c in checkpoints.items(app.store, pid, "main") if c["id"] == "final")
    assert final["status"] == "done" and not final.get("redo_because")
    # … while a real hand edit (a revision Akọwe did not make) still is one
    cur = app.store.get_setting(key)
    cur["seen"][ch1["chapter_id"]]["version"] = ch1["version"] - 1
    cur["own"] = {}
    app.store.set_setting(key, cur)
    assert [f["number"] for f in continuity.check_edits(app.store, pid, "main")] == [1]


def test_the_second_reads_can_be_switched_off(tmp_path):
    _app, fake, run = _opening_kept_run(tmp_path, reread_after_rewrites=False, beta_reread=False,
                                        length_guard=False)
    codes = [e.get("code") for e in run["events"]]
    assert "OPENING_KEPT" in codes and "FINAL_CHECK_AGAIN" not in codes and "BETA_AGAIN" not in codes
    assert fake.kinds.count("beta") == 1
    assert run["settings"]["length_guard"] is False


def test_the_rewrite_brief_carries_the_word_budget(tmp_path):
    from test_opening_pass import SlotFake, _rewrite_opening, make_app, run_book
    fake = SlotFake()
    fake.opening_rewrite_script = [_rewrite_opening]
    app = make_app(tmp_path, fake)
    run = run_book(app, {"length": "short_story", "improve_pass": False, "first_page": False})
    assert run["status"] == "done", run.get("problem")
    task, ctx = fake.prompts["opening_rewrite"][0]
    wb = ctx["word_budget"]
    assert wb["most_words"] >= wb["chapter_words"] and wb["book_target"] == 4000 and "WORD BUDGET" in task
