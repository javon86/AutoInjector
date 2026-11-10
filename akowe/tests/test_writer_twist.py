"""🏆 Who writes best (writer_record.py), 🤫 hide the twist better (twist_guard.py) and the ✒️ writing-style tip.

* The writer track record: the editor's first score of each chapter, per AI family, numbers and codes only, counted
  once, a window of recent chapters; plain words for Settings and the run window.
* The choice: no preference until two working AIs have enough scored chapters; then the best writes, every 4th
  chapter goes to another AI; an AI that is not working is never preferred; the author's "Which AI" always wins; the
  setting switches it off. In a real run the preferred AI writes the chapters and the run window says why.
* The twist rules reach the planners (plot, reveal plan, outline) and the writer briefs before the point where a
  reader may work the twist out — not after it, and not when switched off.
* The style tip shows on the Make-a-book plan only while the writing style card is empty.
"""
from __future__ import annotations

import json
import math

from akowe import chapter_brief, story_rules, style_card, twist_guard, writer_record as wr
from akowe.autobook import _TimedProviders
from akowe.book_path import BookPath

from autobook_fake import BookFakeAI
from cc_fake import MemStore
from test_autobook import make_app, run_book
from test_checkers import make_app3
from test_server import call, server  # noqa: F401


_N = iter(range(10 ** 6))


def seed(store, fam, *scores):
    for s in scores:
        assert wr.note(store, fam, s, f"{fam}-r{next(_N)}:1")


# ---------------------------------------------------------------------------------------------- the record
def test_scores_are_stored_as_numbers_once_and_in_a_window():
    st = MemStore()
    assert wr.note(st, "claude", 8.0, "rec-1:2")
    assert not wr.note(st, "claude", 9.0, "rec-1:2")  # the same chapter version counts once
    assert not wr.note(st, "claude", "good", "rec-2:1") and not wr.note(st, None, 7, "x") and not wr.note(st, "c", 11)
    assert wr.stats(st)["claude"] == {"n": 1, "avg": 8.0, "enough": False}
    for i in range(wr.WINDOW + 5):
        wr.note(st, "gemini", 5 if i < 5 else 7, f"g{i}:1")
    g = wr.stats(st)["gemini"]
    assert g["n"] == wr.WINDOW and g["avg"] == 7.0  # the oldest fell out: recent books weigh most
    raw = st.d[wr.SETTING]
    assert set(raw["ais"]["claude"]["ev"][0]) <= {"s", "t", "i"}  # numbers and codes only


def test_no_preference_until_there_is_enough_evidence_then_the_best_writes_most():
    st = MemStore()
    seed(st, "claude", 8, 8)
    seed(st, "chatgpt", 7, 7, 7)
    assert wr.choose(st, ["claude", "chatgpt"], 1) is None  # Claude has only 2 scored chapters
    ex = wr.choose(st, ["claude", "chatgpt"], 4)  # every 4th chapter: the AI with the fewest scored chapters
    assert ex["family"] == "claude" and ex["why"] == "explore" and "learns how well each AI writes" in ex["line"]
    seed(st, "claude", 8.3)
    st.d[wr.SETTING]["ais"]["chatgpt"]["ev"][-1]["s"] = 7.4 * 3 - 14  # chatgpt averages 7.4
    pick = wr.choose(st, ["chatgpt", "claude"], 1)
    assert pick["family"] == "claude" and pick["why"] == "best"
    assert pick["line"] == "Claude writes most chapters: its chapters score 8.1 vs ChatGPT 7.4"
    fams = [wr.choose(st, ["chatgpt", "claude"], n)["family"] for n in range(1, 9)]
    assert fams.count("chatgpt") == 2 and fams[3] == fams[7] == "chatgpt"  # 1 in 4 keeps the record fair
    assert "so the record stays fair" in wr.choose(st, ["chatgpt", "claude"], 8)["line"]
    assert wr.choose(st, ["claude"], 1) is None  # one working AI: nothing to choose
    assert wr.choose(st, ["chatgpt"], 4) is None
    assert wr.choose(st, ["chatgpt", "claude"], 1, enabled=False) is None


def test_the_settings_card_and_the_switch():
    st = MemStore()
    seed(st, "gemini", 6)
    c = wr.card(st)
    rows = {r["family"]: r for r in c["ais"]}
    assert [r["family"] for r in c["ais"]][:3] == ["chatgpt", "claude", "gemini"]
    assert rows["claude"]["words"] == "Claude: no scored chapters yet"
    assert rows["gemini"]["words"].startswith("Gemini: needs more data — 1 scored chapter so far")
    assert c["enabled"] and not c["uses_data"] and "Not enough data yet" in c["order_words"]
    seed(st, "claude", 9, 9, 9)
    seed(st, "gemini", 6, 6)
    c = wr.card(st)
    assert c["uses_data"] and c["order_words"].startswith("Claude writes most chapters: its chapters score 9.0 vs "
                                                          "Gemini 6.0")
    assert wr.save_settings(st, {"enabled": False}) == {"enabled": False}
    assert wr.card(st)["order_words"].startswith("Switched off")


def test_the_preference_only_reorders_working_ais_and_the_authors_choice_wins(tmp_path):
    app = make_app3(tmp_path, BookFakeAI())
    prov = app.engine.providers
    pid = app.engine.bootstrap_project("author", "Writers")
    seed(app.store, "AI-2", 9, 9, 9)
    seed(app.store, "claude", 6, 6, 6)
    run = {"settings": {}}
    assert wr.before_chapter(app.store, prov, run, 1) == "AI-2"
    assert run["writer_pick"]["line"].startswith("AI-2 writes most chapters: its chapters score 9.0 vs Claude 6.0")
    assert wr.before_chapter(app.store, prov, {"settings": {"slot_id": "AI-1"}}, 1) is None  # "Which AI" wins
    assert wr.before_chapter(app.store, prov, {"settings": {}}, 1, editor_on=False) is None  # no editor, no scores
    # the providers of a run: C02 goes to the preferred AI first; other work and a pinned run are untouched
    tp = _TimedProviders(prov, None, lambda *a, **k: None)
    cap = prov.slots()[0]["capabilities"][0]
    assert tp.eligible(pid, cap, 10, "C02")[0]["slot_id"] == "AI-1"
    tp.prefer_writer = "AI-2"
    assert tp.eligible(pid, cap, 10, "C02")[0]["slot_id"] == "AI-2"
    assert tp.eligible(pid, cap, 10, "B11")[0]["slot_id"] == "AI-1"
    pinned = _TimedProviders(prov, "AI-1", lambda *a, **k: None)
    pinned.prefer_writer = "AI-2"
    assert [s["slot_id"] for s in pinned.eligible(pid, cap, 10, "C02")] == ["AI-1"]
    # an AI at its limit / not working is never preferred: the usual choice
    prov.health.mark_failed("AI-2", "USAGE_LIMIT")
    assert wr.before_chapter(app.store, prov, {"settings": {}}, 1) is None  # the others: not enough data -> usual
    seed(app.store, "AI-3", 7, 7, 7)
    assert wr.before_chapter(app.store, prov, {"settings": {}}, 1) == "AI-3"  # the best of the AIs that work
    prov.health.clear("AI-2")
    wr.save_settings(app.store, {"enabled": False})
    assert wr.before_chapter(app.store, prov, {"settings": {}}, 1) is None


def test_a_run_lets_the_best_writer_write_and_records_its_scores(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    seed(app.store, "AI-2", 9, 9, 9)
    seed(app.store, "claude", 6, 6, 6)
    run = run_book(app, {"pictures": False})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    ch = next(s for s in run["steps"] if s["id"] == "chapters")
    writers = [c["slot"] for c in fake.calls if c["props"] == ["objective_assessments", "text"]]
    assert writers and set(writers) == {"AI-2"}, writers  # the usual writer (AI-1, the cheapest) stepped aside
    assert ch["writer_note"].startswith("AI-2 writes most chapters: its chapters score")
    # the chapters' scores joined the record (the editor's first reading; the editor never was the writer)
    assert wr.stats(app.store)["AI-2"]["n"] > 3


# ---------------------------------------------------------------------------------------------- the twist
def test_earliest_chapter_and_the_planner_rule():
    assert [twist_guard.earliest_chapter(n) for n in (1, 2, 3, 10, 20)] == [1, 2, 2, 7, 13]
    assert twist_guard.earliest_chapter(None) is None
    r = twist_guard.planner_rule(10)
    assert "innocent explanation" in r and "red herring" in r and "chapter 7 of 10" in r
    assert "two-thirds" in twist_guard.planner_rule(None)


def _book(tmp_path):
    app = make_app(tmp_path, fake=BookFakeAI())
    run = run_book(app, {"pictures": False})
    assert run["status"] == "done", run["phase"]
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    outline = bp.outline()
    return app, pid, outline, [c["chapter_id"] for c in bp.outline_chapters(outline)]


def test_the_writer_briefs_before_the_twist_point_carry_the_rule(tmp_path):
    app, pid, outline, chs = _book(tmp_path)
    story_rules.save(app.store, pid, "main", story_rules.clean_rules([
        {"id": "", "category": "mystery", "text": "The keeper is the drowned man's brother.", "scope": ""}]),
        by="author")
    k = twist_guard.earliest_chapter(len(chs))
    first, meta = chapter_brief.build(app.store, pid, "main", outline, chs[0])
    tg = first["twist_guard"]
    assert tg["secrets"] == ["The keeper is the drowned man's brother."] and tg["may_be_worked_out_from_chapter"] == k
    assert "do not confirm or over-signal “The keeper is the drowned man's brother.”; keep its clues ambiguous" \
        in tg["rule"]
    assert twist_guard.WRITER_RULE in first["rules"] and meta["twist_guard"]["until"] == k
    last, _m = chapter_brief.build(app.store, pid, "main", outline, chs[-1])
    assert "twist_guard" not in last and twist_guard.WRITER_RULE not in last["rules"]
    twist_guard.save_settings(app.store, {"enabled": False})
    off, _m = chapter_brief.build(app.store, pid, "main", outline, chs[0])
    assert "twist_guard" not in off


def test_without_protected_mysteries_the_rule_names_the_plans_twist(tmp_path):
    app, pid, outline, chs = _book(tmp_path)
    story_rules.save(app.store, pid, "main", story_rules.clean_rules([
        {"id": "", "category": "hard_rule", "text": "The lamp burns only at night.", "scope": "always"}]), by="author")
    first, _m = chapter_brief.build(app.store, pid, "main", outline, chs[0])
    assert first["twist_guard"]["secrets"] == [twist_guard.GENERIC]
    assert "do not confirm or over-signal “the secret or twist the plan hides”" in first["twist_guard"]["rule"]
    assert first["twist_guard"]["may_be_worked_out_from_chapter"] == max(2, math.ceil(0.65 * len(chs)))


def test_the_planners_get_the_twist_rules(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"pictures": False})
    assert run["status"] == "done"
    systems = [s for k, ps in fake.prompts.items() for s, _c in ps if "Operation B11" in s or "Operation B03" in s]
    assert systems and all("believable innocent explanation" in s and "red herring" in s for s in systems)
    assert any("Operation B11" in s and " of " in s.split("earliest point")[1][:80] for s in systems)
    # switched off: not in the prompts of the next book
    fake2 = BookFakeAI()
    app2 = make_app(tmp_path, name="d2", fake=fake2)
    twist_guard.save_settings(app2.store, {"enabled": False})
    assert run_book(app2, {"pictures": False})["status"] == "done"
    s2 = [s for k, ps in fake2.prompts.items() for s, _c in ps if "Operation B11" in s]
    assert s2 and not any("red herring" in s for s in s2)


# ---------------------------------------------------------------------------------------------- the style tip
def test_the_style_tip_only_while_the_card_is_empty():
    st = MemStore()
    tip = style_card.nudge(st, "author")
    assert tip["href"] == "#/style" and tip["before"] + tip["link"] + tip["after"] == tip["text"]
    assert tip["text"].startswith("Tip: paste a few paragraphs of your own writing into ✒️ My writing style so every AI")
    st.set_setting(style_card.AUTHOR_KEY.format(principal="author"), {"samples": [{"name": "a", "text": "x"}]})
    assert style_card.nudge(st, "author") is None
    st2 = MemStore()
    st2.set_setting(style_card.NUDGE_SETTING, {"enabled": False})
    assert style_card.nudge(st2, "author") is None


def test_the_api(server):  # noqa: F811
    app, port = server
    st, body, _ = call(port, "POST", "/api/estimate", {})
    assert st == 200 and body["style_tip"]["link"] == "✒️ My writing style"
    st, body, _ = call(port, "PUT", "/api/settings/style-tip", {"enabled": False})
    assert st == 200
    st, body, _ = call(port, "POST", "/api/estimate", {})
    assert body["style_tip"] is None
    assert call(port, "PUT", "/api/settings/style-tip", {"enabled": "no"})[0] == 400
    seed(app.store, "claude", 8, 8, 8)
    st, body, _ = call(port, "GET", "/api/writers/record")
    assert st == 200 and next(r for r in body["ais"] if r["family"] == "claude")["enough"]
    st, body, _ = call(port, "PUT", "/api/settings/writer-pick", {"enabled": False})
    assert st == 200 and body["enabled"] is False
    assert call(port, "PUT", "/api/settings/writer-pick", {"enabled": 1})[0] == 400
    st, body, _ = call(port, "GET", "/api/settings/twist-guard")
    assert st == 200 and body == {"enabled": True}
    st, body, _ = call(port, "PUT", "/api/settings/twist-guard", {"enabled": False})
    assert body == {"enabled": False} and json.dumps(body)
