"""🔧 The trade card (trade_card.py) and 🔁 kept fresh (fresh_names.py).

🔧 At planning, Akọwe finds the trade the book relies on (no AI), ONE request writes "how it's really done" (Claude Code
with sources when ready, else a web AI), the card goes into the Book Bible, the briefs of the chapters that show the
craft and the editor's context; a watch phrase of a listed mistake on the page is a MAJOR note.

🔁 The author's recent books' title words, names, settings and motifs are avoided when the run invents things, a repeat
the author did not type is renamed in one answer, and the run window says "🔁 Kept fresh: avoided …".
"""
from __future__ import annotations

import json

from akowe import editor_rubric, fact_checks, run_forecast
from akowe import fresh_names as fn
from akowe import trade_card as tc
from akowe.book_bible import build as build_bible
from akowe.book_bible import render_markdown
from akowe.book_path import BookPath, get_profile

from cc_fake import install
from test_failover_review import SlotFake, make_app, run_book
from test_failover_review import no_provider_sleep  # noqa: F401 - the fixture

OFF = {"length": "short_story", "improve_pass": False, "first_page": False, "opening_pass": False,
       "human_pass": False, "story_doctor": False}


def _codes(run):
    return [e.get("code") for e in run["events"]]


def _msg(run, code):
    return next((e["message"] for e in run["events"] if e.get("code") == code), None)


CARD = {"craft": "piano tuner", "how_it_works": "A tuner sets one string at a time against a fork, then by ear.",
        "tools": ["tuning hammer (lever)", "rubber mutes", "tuning fork"],
        "steps": ["Mute the unisons", "Set the temperament octave", "Tune outward by octaves"],
        "terms": [{"term": "unison", "meaning": "the 2-3 strings of one note"},
                  {"term": "tuning pin", "meaning": "the pin a string is wound on"}],
        "mistakes": [{"wrong": "turning a tuning pin a quarter-turn", "right": "pins move a hair at a time",
                      "watch_words": ["quarter-turn", "quarter turn"]},
                     {"wrong": "squeezing bushings with pliers", "right": "bushings are replaced with a tool",
                      "watch_words": ["with pliers", "pliers"]}],
        "sensory": ["the beat between two strings slowing to nothing"]}


# ====================================================================== 🔧 no AI: the rules
def test_the_trade_is_found_without_ai_with_its_modifier():
    assert tc.detect(["Odile Harrow, a widowed piano tuner, hears a wrong note.", "The tuner works at night."]) == \
        ["piano tuner"]
    assert tc.detect(["Teo keeps the tide-gauge; the tide-gauge keeper logs the water."])[0] == "tide-gauge keeper"
    assert "glassblowing" in tc.detect(["A story of glassblowing in Murano."])
    assert tc.detect(["Two sisters argue about a wedding."]) == []


def test_the_card_is_cleaned_sources_only_from_research_and_watch_words_are_phrases():
    raw = {"craft_cards": [dict(CARD, sources=[{"url": "https://example.org/tuning", "about": "x"},
                                               {"url": "made up"}])]}
    research = tc.clean(raw, sourced=True)[0]
    assert research["sources"] == [{"url": "https://example.org/tuning", "about": "x"}]
    assert tc.clean(raw, sourced=False)[0]["sources"] == []  # a web AI's "sources" are never kept
    # a lone word ("pliers") is too loose for a check without AI: only phrases stay
    assert research["mistakes"][1]["watch_words"] == ["with pliers"]
    assert tc.clean({"craft_cards": [{"craft": "x", "how_it_works": "", "tools": [], "steps": [], "terms": [],
                                      "mistakes": [], "sensory": []}]}, sourced=False) == []


def test_a_wrong_procedure_on_the_page_is_a_major_note_and_the_editors_card_notes_are_major():
    card = tc.clean({"craft_cards": [CARD]}, sourced=False)
    text = ("She set the mute. Then she gave the tuning pin a quarter-turn and the note jumped. "
            "Outside, the rain kept on.")
    fl = tc.flags(card, text)
    assert len(fl) == 1 and fl[0]["quote"] == "Then she gave the tuning pin a quarter-turn and the note jumped."
    ctx = {"fact_checks": {"trade_card": card, "trade_flags": fl}}
    out = tc.trade_findings([{"id": "f1", "dimension": "trade_terms", "severity": "minor", "passage": "She set the "
                              "mute.", "why": "Against the trade card: mutes go in first.", "suggestion": "x"},
                             {"id": "f2", "dimension": "subtext", "severity": "minor", "passage": "Outside",
                              "why": "flat", "suggestion": "y"}], ctx, text)
    assert out[0]["severity"] == "major" and out[1]["severity"] == "minor"
    added = out[2]
    assert added["severity"] == "major" and added["dimension"] == "trade_terms" and added["source"] == "akowe_trade"
    assert added["passage"] in text and "quarter-turn" in added["why"] and "a hair at a time" in added["suggestion"]
    # without a card nothing changes
    assert tc.trade_findings([{"id": "f1", "dimension": "trade_terms", "severity": "minor", "why": "trade card"}],
                             {}, text)[0]["severity"] == "minor"
    assert "trade_terms" in editor_rubric.CHAPTER and "MAJOR" in tc.EDITOR_RULE


def test_the_card_is_cut_to_its_budget_and_only_for_text_that_shows_the_craft():
    class Store(dict):
        def get_setting(self, k, d=None):
            return self.get(k, d)

        def set_setting(self, k, v):
            self[k] = v
    st = Store()
    tc.save(st, "p", "main", tc.clean({"craft_cards": [CARD]}, sourced=False), by="ai", crafts=["piano tuner"])
    assert tc.for_text(st, "p", "main", "Ines tunes the unison by the window.", 2000)
    assert tc.for_text(st, "p", "main", "The tuner arrives at the chapel.", 2000)
    assert tc.for_text(st, "p", "main", "A storm, a quarrel at the harbour.", 2000) == []
    small = tc.compact(tc.cards_of(st, "p", "main")[0], 400)
    assert len(json.dumps(small, ensure_ascii=False)) <= 400 and small["how_it_works"]
    assert any("Not: turning a tuning pin" in r["detail"] for r in tc.bible_rows(st, "p", "main"))


def test_the_forecast_counts_the_trade_card_and_the_renames_and_their_switches():
    on = run_forecast.option_calls(run_forecast.options_of(None, {}), 10, 3)
    assert on["trade_card"]["calls"] == 1 and on["fresh_names"]["calls"] == 2 * run_forecast.FRESH_SHARE
    off = run_forecast.option_calls(run_forecast.options_of(None, {"trade_card": False, "fresh_names": False}), 10, 3)
    assert off["trade_card"]["calls"] == 0 and off["fresh_names"]["calls"] == 0
    cc_on = run_forecast.option_calls(dict(run_forecast.options_of(None, {}), claude_code=True), 10, 3)
    cc_off = run_forecast.option_calls(dict(run_forecast.options_of(None, {"trade_card": False}), claude_code=True),
                                       10, 3)
    assert cc_on["helpers"]["calls"] == cc_off["helpers"]["calls"] + 1  # the Claude Code research job
    assert {"trade_card", "fresh_names"} <= set(run_forecast.INSIDE_MEASURED)


# ====================================================================== 🔧 in a run
def test_a_run_makes_one_card_puts_it_in_the_bible_the_brief_and_the_editors_context(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, OFF)
    assert run["status"] == "done", run.get("problem")
    assert fake.kinds.count("trade_card") == 1
    pid = run["project_id"]
    cards = tc.cards_of(app.store, pid, "main")
    assert cards and cards[0]["craft"] == "keeper" and cards[0]["sources"] == []
    assert "TRADE_CARD_MADE" in _codes(run) and "written by the AI" in _msg(run, "TRADE_CARD_MADE")
    st = {s["id"]: s for s in run["steps"]}
    assert "🔧 Trade card" in st["outline"]["message"]
    # the request saw the book, the crafts and the plan
    _sys, ctx = fake.prompts["trade_card"][0]
    assert ctx["crafts"] == ["keeper"] and ctx["book"]["idea"] and ctx["plan"]
    # the Book Bible: the saved bible file and its words
    bible = build_bible(app, pid, "main")
    assert bible["trade_card"][0]["craft"] == "keeper"
    assert "## Trade card: keeper" in render_markdown(bible)
    # the writer of a chapter that shows the craft gets the card (and its rule)
    bp = BookPath(app.engine, "author", pid, "main")
    outline = bp.outline()
    briefs = [tc.add_to_brief(app.store, pid, "main", outline, c["chapter_id"], {"rules": []})
              for c in bp.outline_chapters(outline)]
    shown = [b for b in briefs if b.get("trade_card")]
    assert shown and all(tc.BRIEF_RULE in b["rules"] for b in shown)
    assert all(len(json.dumps(b["trade_card"], ensure_ascii=False)) <= tc.BRIEF_CHARS for b in shown)
    # the editor reads a chapter with a wrong procedure against the card
    _ctx, latest, _appr = bp.chapter_prose(outline, bp.outline_chapters(outline)[0]["chapter_id"])
    rec = dict(latest, data=dict(latest["data"], text=latest["data"]["text"] + " The keeper wound the lens with a "
                                                                              "brass crank."))
    fc = fact_checks.editor_context(app.engine, "author", pid, "main", rec)["fact_checks"]
    assert fc["trade_card"] and fc["trade_flags"][0]["quote"].endswith("with a brass crank.")
    # the editor's real review of a chapter that shows the craft carried the card and its rule
    eds = [c for _s, c in fake.prompts.get("craft", []) if (c.get("fact_checks") or {}).get("trade_card")]
    assert eds


def test_off_means_no_request_and_no_card(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, dict(OFF, trade_card=False))
    assert run["status"] == "done" and "trade_card" not in fake.kinds
    assert tc.cards_of(app.store, run["project_id"], "main") == []


def test_an_ai_problem_never_stops_the_book(tmp_path):
    from akowe.errors import AkoweError
    fake = SlotFake()
    fake.fail_kind("trade_card", AkoweError("INVALID_INPUT", "/x", "bad answer"))
    app = make_app(tmp_path, fake)
    run = run_book(app, OFF)
    assert run["status"] == "done", run.get("problem")
    assert "TRADE_CARD_FAILED" in _codes(run)


def test_claude_code_researches_the_card_with_real_sources(tmp_path, monkeypatch):
    from akowe import claude_code
    install(tmp_path, monkeypatch)
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    assert claude_code.detect(app.store, force=True)["state"] == "ready"
    run = run_book(app, dict(OFF, slot_id="AI-2"))
    assert run["status"] == "done", run.get("problem")
    assert "trade_card" not in fake.kinds  # no web AI was asked
    card = tc.cards_of(app.store, run["project_id"], "main")[0]
    assert card["sources"] == [{"url": "https://example.org/lighthouse-keeping", "about": "keeping"}]
    assert "researched by Claude Code with 1 source(s)" in _msg(run, "TRADE_CARD_MADE")


# ====================================================================== 🔁 no AI: the list
BOOKS = [  # newest first, as fresh_names.recent returns them
    {"title_words": ["salt", "tuner"], "names": ["odile", "wren"], "settings": ["coastal town"],
     "motifs": ["tides", "fog", "grief"], "kind": "rebirth"},
    {"title_words": ["salt", "keeper", "ledger"], "names": ["odile", "teo"], "settings": ["coastal town"],
     "motifs": ["tides", "flooding"], "kind": "quest"},
    {"title_words": ["salt", "organ"], "names": ["ines"], "settings": ["village or small town"],
     "motifs": ["fog"], "kind": "rebirth"},
    {"title_words": ["glass", "orchard"], "names": ["hal"], "settings": ["countryside"], "motifs": [], "kind": ""},
]


def test_labels_are_short_and_have_no_book_text():
    assert fn.title_words("The Salt Keeper's Ledger") == ["salt", "keeper", "ledger"]
    assert fn.first_name("Captain Odíle Marsh") == "odile"
    assert fn.labels("a fog-bound harbour town where the tide floods the quay") == ["coastal town"]
    assert set(fn.labels("a fog-bound harbour where the tide floods", fn._MOT_RE)) >= {"tides", "fog", "flooding"}  # noqa: SLF001


def test_the_avoid_list_takes_off_what_the_author_typed():
    av = fn.avoid_of(BOOKS)
    assert av["names"][0] == "odile" and {"wren", "teo", "ines", "hal"} <= set(av["names"])
    assert av["title_words"][0] == "salt"
    assert "coastal town" in av["settings"] and "countryside" not in av["settings"]  # 4th book, once: allowed
    assert set(av["motifs"]) == {"tides", "fog"} and av["kinds"] == ["rebirth", "quest"]
    assert av["prefer_different"]["settings"] == ["coastal town", "village or small town"]
    typed = fn.avoid_of(BOOKS, "Odile, a tuner in a coastal town where the tide comes in",
                        kind_chosen=True)
    assert "odile" not in typed["names"] and "coastal town" not in typed["settings"]
    assert "tides" not in typed["motifs"] and typed["kinds"] == []
    assert fn.is_empty(fn.avoid_of([]))
    view = fn.prompt_view(av)
    assert "Odile" in view["names"] and "Salt" in view["title_words"]
    assert "counts" not in view


# ====================================================================== 🔁 in a run
def test_a_second_book_renames_what_repeats_the_first_and_says_so(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    first = run_book(app, OFF)
    assert first["status"] == "done"
    assert "fresh_names" not in fake.kinds  # nothing on the shelf yet
    second = run_book(app, OFF)
    assert second["status"] == "done", second.get("problem")
    # the invented title and the idea's main character repeated the first book: one rename for the profile, one
    # for the cast sketch
    assert fake.kinds.count("fresh_names") == 2
    prof = get_profile(app.store, second["project_id"])
    assert prof["title"] == "A Light Over Brackwater" and "Mara" not in prof["idea"] and "Juno Vell" in prof["idea"]
    from akowe import characters
    names = [c["name"] for c in characters.canon_characters(app.store, second["project_id"], "main")]
    assert "Juno Vell" in names and not any(n.startswith("Mara") for n in names)
    line = _msg(second, "FRESH_KEPT")
    assert line.startswith("🔁 Kept fresh: avoided ") and "Mara" in line and "Gullhaven" in line
    assert "FRESH_RENAMED" in _codes(second)
    # the prompts carried the avoid list (labels and names only)
    _s, pctx = fake.prompts["profile"][-1]
    assert "Mara" in pctx["wishes"]["avoid_recently_used"]["names"]
    _s, sctx = fake.prompts["sketch"][-1]
    assert "Mara" in sctx["avoid_recently_used"]["names"]
    planner = [c for _s, c in fake.prompts.get("B01", []) if c.get("avoid_recently_used")]
    assert planner and "Mara" in planner[-1]["avoid_recently_used"]["names"]
    assert json.dumps(fn.saved(app.store, second["project_id"])).count("lighthouse goes dark") == 0


def test_what_the_author_typed_is_never_renamed_and_off_means_no_check(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run_book(app, OFF)
    typed = run_book(app, dict(OFF, idea="Mara Vell keeps the Gullhaven light after her master vanishes"))
    assert typed["status"] == "done", typed.get("problem")
    from akowe import characters
    names = [c["name"] for c in characters.canon_characters(app.store, typed["project_id"], "main")]
    assert "Mara Vell" in names
    av = app.autobook.get(typed["id"])["fresh"]["avoid"]
    assert "mara" not in av["names"] and "gullhaven" not in av["title_words"]
    n = fake.kinds.count("fresh_names")
    off = run_book(app, dict(OFF, fresh_names=False))
    assert off["status"] == "done" and fake.kinds.count("fresh_names") == n
    assert get_profile(app.store, off["project_id"])["title"] == "The Keeper of Gullhaven"
    assert "FRESH_KEPT" not in _codes(off)


def test_a_modifier_never_crosses_a_clause_and_fresh_names_skip_books_with_their_own_names():
    assert tc.detect(["the keeper's log (doctor fix)"]) == ["keeper", "doctor"]
    on = {"settings": {"fresh_names": True}}
    assert fn.enabled(on)
    for k in ("bible", "variant_of", "sequel", "continue"):  # their names are the book's own
        assert not fn.enabled({"settings": {"fresh_names": True, k: {"project_id": "p"}}})
    assert not fn.enabled({"settings": {}})  # a run saved before the setting existed
