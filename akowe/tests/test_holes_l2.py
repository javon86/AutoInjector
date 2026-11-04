"""Holes H3, H5, H6, H10, H11, H12, H13 and H14 of docs/HOLES_2026-11.md — each reproduced with the fake AI, then
fixed: content limits / themes / the central question reach the writer, the reviewer and the editor (H3); a hand edit
to an approved chapter sets its tracked state aside and flags the later chapters (H5); no self-approval (H6); point of
view and tense decided and checked (H10); setups, vanished characters, the main character's change and the book's
question checked against the ending, with a fix (H11 / H12); instruction cuts least important first and said (H13);
"approve anyway" / auto-approve still get the editor and the plan check as notes, and are listed (H14)."""
from __future__ import annotations

import threading

import pytest

import autobook_fake
from akowe import approval_trust, book_promises, brief_cuts, continuity, ending_check, planned
from akowe import story_rules
from akowe.book_path import BookPath, get_profile, save_profile
from akowe.review import ReviewJob

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book, steps  # noqa: F401

BR = "main"
LIMITS = "No graphic violence; no swearing."


def bp_of(app, pid):
    return BookPath(app.engine, "author", pid, BR)


def chapter_recs(app, pid):
    bp = bp_of(app, pid)
    outline = bp.outline()
    out = []
    for c in bp.outline_chapters(outline):
        _ctx, latest, appr = bp.chapter_prose(outline, c["chapter_id"])
        out.append((c["chapter_id"], appr, latest))
    return out


def start_with_profile(app, profile: dict, body=None):
    """Start a run, and while the AI is still inventing the book put ``profile`` into it (as the author would)."""
    fake = app.engine.providers.test_adapter
    fake.gate = threading.Event()
    fake.waiting.clear()
    r = app.autobook.start("author", dict({"author_confirms": True, "length": "short_story", "pictures": False},
                                          **(body or {})))
    assert fake.waiting.wait(30)
    pid = app.autobook.get(r["id"])["project_id"]
    save_profile(app.store, pid, profile)
    fake.gate.set()
    app.autobook.wait_for(r["id"], 120)
    return app.autobook.get(r["id"]), pid


def hand_edit(app, pid, rid, new_text):
    bp = bp_of(app, pid)
    head = bp.rec(rid)
    data = dict(head["data"], text=new_text)
    resp = bp.dispatch("C02", "UPDATE", base_ref=head["ref"], payload=data)
    assert resp["status"] == "DRAFT", resp
    out = app.review.approve("author", pid, BR, {"record_ids": [rid], "author_confirms": True, "how": "one"})
    assert out["results"][0]["ok"], out
    return bp_of(app, pid).rec(rid)


# ====================================================================== H3: content limits, themes, the question
def test_h3_content_limits_themes_and_question_reach_the_writer_reviewer_and_editor(tmp_path):
    seen = {"breach": False}

    def verdict(ctx):  # the reviewer finds a breach in the first chapter it reads (and says APPROVE anyway)
        if (ctx.get("draft") or {}).get("module_id") == "C02" and not seen["breach"]:
            seen["breach"] = True
            return {"verdict": "APPROVE", "reasons": ["Well paced."], "confidence": 0.9,
                    "content_limits_breach": "a graphic killing in the cellar"}
        return "APPROVE"
    fake = BookFakeAI(default_verdict=verdict)
    app = make_app(tmp_path, fake=fake)
    run, pid = start_with_profile(app, {"content_limits": LIMITS, "themes": ["duty", "forgiveness"],
                                        "central_question": "Is a promise to the dead still binding?"})
    assert run["status"] == "done", (run.get("phase"), run.get("problem"))
    # the writer: in the book profile AND in the chapter instruction itself
    c02 = fake.prompts["C02"][0][1]
    assert c02["book_profile"]["content_limits"] == LIMITS
    assert c02["book_profile"]["themes"] == ["duty", "forgiveness"]
    assert c02["book_profile"]["central_question"] == "Is a promise to the dead still binding?"
    instr = c02["request_payload"]["instruction"]
    assert "Content limits (never show this): " + LIMITS in instr and "Themes: duty; forgiveness" in instr
    assert "central question: Is a promise to the dead still binding?" in instr
    # the reviewer: told the rule and given the limits; a breach is a REVISE (fixed), never approved
    sys_r, ctx_r = fake.prompts["review"][0]
    assert "content_limits_breach" in sys_r and ctx_r["book_profile"]["content_limits"] == LIMITS
    reviews = app.store.get_setting(f"ai_reviews:{pid}:{BR}")
    hit = [v for v in reviews.values() if v.get("content_limits_breach")]
    assert len(hit) == 1 and hit[0]["verdict"] == "REVISE" and hit[0]["reasons"][0].startswith("Content limits:")
    i = [k for k in fake.kinds if k in ("review", "fix", "C02")]
    first_c02_review = i.index("C02") + 1
    assert i[first_c02_review] == "review" and i[first_c02_review + 1] == "fix"
    # the editor: the rubric dimension "respects the author's content limits"
    sys_e = fake.prompts["craft"][0][0]
    assert "[content_limits]" in sys_e and "content limits" in sys_e.lower()


def test_h3_a_content_limit_breach_is_never_auto_approved_and_the_editor_says_revise(tmp_path):
    from akowe import editor as editor_mod
    v = book_promises.enforce_review({"verdict": "APPROVE", "reasons": ["fine"], "content_limits_breach": "gore"},
                                     {"content_limits": LIMITS})
    assert v["verdict"] == "REVISE" and v["reasons"][0] == "Content limits: gore"
    # no limits set: the reviewer's answer is left alone
    assert book_promises.enforce_review({"verdict": "APPROVE", "reasons": []}, {})["verdict"] == "APPROVE"
    # the editor: one minor content-limits note is a REVISE even when the editor is gentle
    verdict, why = editor_mod.decide({"subtext": 9}, [{"dimension": "content_limits", "severity": "minor"}], "gentle")
    assert verdict == "REVISE" and "content limits" in why[-1]
    assert "content_limits" in editor_mod.rubric.dimensions_for("C02", content_limits=True)
    assert "content_limits" not in editor_mod.rubric.dimensions_for("C02")


# ====================================================================== H6: no self-approval
def test_h6_one_ai_cannot_approve_its_own_writing(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake, second_ai=False)
    run = run_book(app, {"length": "short_story", "pictures": False}, trust_one_ai=False)
    assert run["status"] == "paused"
    prob = run["problem"]
    assert prob["code"] == "NO_SECOND_AI"
    assert prob["message"].startswith("Only Claude is working, so nobody else checked this")
    assert "approve it yourself, or wait for another AI" in prob["message"]
    assert prob["options"] == ["approve_anyway", "retry"]
    pid = run["project_id"]
    assert not [e for e in app.autobook.get(run["id"])["events"] if e.get("approval") == "run_consent"]
    # ✔ approve this one only: the next draft asks again
    first = prob["record_id"]
    app.autobook.decide("author", run["id"], {"action": "approve_anyway", "author_confirms": True})
    app.autobook.wait_for(run["id"], 60)
    run2 = app.autobook.public(app.autobook.get(run["id"]))
    assert run2["status"] == "paused" and run2["problem"]["code"] == "NO_SECOND_AI"
    assert run2["problem"]["record_id"] != first
    # ✔ … and trust this AI for the rest of the run
    app.autobook.decide("author", run["id"], {"action": "approve_anyway", "author_confirms": True,
                                              "for_rest_of_run": True})
    app.autobook.wait_for(run["id"], 120)
    done = app.autobook.public(app.autobook.get(run["id"]))
    assert done["status"] == "done", done.get("problem")
    hows = {e["how"] for e in approval_trust.entries(app.store, pid, BR)}
    assert hows == {"approve_anyway", "self_review"}  # every one of them is listed as approved without checks


@pytest.mark.parametrize("answer, code, words", [
    ({"verdict": "APPROVE", "reasons": [], "confidence": 0.9}, "NO_REASON", "gave no reason"),
    ({"verdict": "APPROVE", "reasons": ["Looks fine."], "confidence": 0.4}, "LOW_CONFIDENCE", "40%"),
    ({"verdict": "APPROVE", "reasons": ["Looks fine."], "confidence": None}, "LOW_CONFIDENCE", "no confidence"),
])
def test_h6_a_bare_or_unsure_approve_pauses_for_the_author(tmp_path, answer, code, words):
    fake = BookFakeAI(verdicts=[answer])
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story", "pictures": False})
    assert run["status"] == "paused" and run["problem"]["code"] == code, run.get("problem")
    assert words in run["problem"]["message"]
    # 🔁 Try again: the reviewer reads it again (now with a reason and confidence) and the book goes on
    app.autobook.decide("author", run["id"], {"action": "retry"})
    app.autobook.wait_for(run["id"], 120)
    assert app.autobook.get(run["id"])["status"] == "done"


def test_h6_standing_auto_approve_is_withheld_when_the_writer_reviewed_itself(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake, second_ai=False)
    run = run_book(app, {"length": "short_story", "pictures": False})
    assert run["status"] == "done"
    pid = run["project_id"]
    app.review.save_settings("author", pid, BR, {"auto_approve": True, "author_confirms": True})
    bp = bp_of(app, pid)
    out = bp.dispatch("B01", "CREATE", payload=bp.payload_for("B01"))
    rid = out["output_refs"][0]["record_id"]
    res = app.review.review_sync("author", pid, BR, rid)
    assert res["review"]["verdict"] == "APPROVE" and res["review"]["independent"] is False
    assert res["auto_approved"] is False and res["auto_approve"]["withheld"] == "NO_SECOND_AI"
    assert bp_of(app, pid).rec(rid)["lifecycle"] not in ("APPROVED", "LOCKED")


# ====================================================================== H14: approved without checks
def test_h14_approve_anyway_still_runs_the_editor_and_plan_check_and_is_listed(tmp_path):
    def verdict(ctx):  # the reviewer never passes chapter 1
        d = ctx.get("draft") or {}
        return "REVISE" if d.get("module_id") == "C02" and 'OBJECTIVE:ch1"' in d.get("data_json", "") else "APPROVE"
    fake = BookFakeAI(default_verdict=verdict)
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story", "pictures": False})
    assert run["status"] == "paused" and run["problem"]["code"] == "REVIEW_NOT_PASSED"
    pid, rid = run["project_id"], run["problem"]["record_id"]
    n_craft = fake.kinds.count("craft")
    app.autobook.decide("author", run["id"], {"action": "approve_anyway", "author_confirms": True})
    app.autobook.wait_for(run["id"], 120)
    done = app.autobook.get(run["id"])
    assert done["status"] == "done", done.get("problem")
    # the editor read it afterwards, as notes (no rewrite of an approved chapter), and the plan check ran
    assert fake.kinds.count("craft") > n_craft
    e = next(x for x in approval_trust.entries(app.store, pid, BR) if x["record_id"] == rid)
    assert e["how"] == "approve_anyway" and e["notes_done"]
    assert e["notes"]["editor"].startswith(("PASS", "REVISE")) and e["notes"]["planned"]
    assert any(ev.get("code") == "APPROVED_WITHOUT_CHECKS" for ev in done["events"])
    # listed in the book report and on 🏠 Book home
    rep = app.reports.make("author", pid, BR, ai=False)
    assert [u["chapter_id"] for u in rep["unchecked"]] == ["ch1"]
    assert any("approved without checks" in w for w in rep["warnings"])
    lines = bp_of(app, pid).status()["attention"]["lines"]
    assert any("chapter ch1: approved without checks" in x for x in lines)


# ====================================================================== H10: point of view and tense
FIRST_PRESENT = ("I climb the hundred steps of the lighthouse and I am cold. My lantern is out and I am afraid of "
                 "the dark. I find the logbook and I read it twice. My master is gone and I am alone here. I say "
                 "his name and the fog says nothing back. I go down again and I am shaking.")


def test_h10_point_of_view_and_tense_are_decided_put_in_every_brief_and_checked(tmp_path):
    fake = BookFakeAI()
    fake.chapter_texts["ch2"] = FIRST_PRESENT  # the writer slips into first person, present tense
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story", "pictures": False})
    pid = run["project_id"]
    prof = get_profile(app.store, pid)
    assert (prof["pov"], prof["tense"]) == ("third", "past")  # decided when the book was invented (Mystery)
    instrs = [c["request_payload"]["instruction"] for _s, c in fake.prompts["C02"]]
    assert all("Point of view: third person, past tense" in i for i in instrs)
    assert all(c["book_profile"]["point_of_view"].startswith("third person") for _s, c in fake.prompts["C02"])
    # chapter 2 switched: the review is a REVISE on every try, and the run stops for the author
    assert run["status"] == "paused" and run["problem"]["code"] == "REVIEW_NOT_PASSED"
    assert any("Point of view / tense" in r and "first person" in r for r in run["problem"]["reasons"])


def test_h10_defaults_and_the_cheap_check():
    assert book_promises.decide({"genre": "Young adult romance"})["pov"] == "first"
    assert book_promises.decide({"genre": "Mystery"}) == {"pov": "third", "tense": "past", "from": "the genre"}
    assert book_promises.decide({"genre": "Mystery", "pov": "first", "tense": "present"})["from"] == "you"
    assert book_promises.pov_tense_problem(FIRST_PRESENT, {"genre": "Mystery"})
    third = "\n\n".join(autobook_fake.CHAPTER_TEXT[1])
    assert book_promises.pov_tense_problem(third, {"genre": "Mystery"}) is None
    # dialogue in the first person is not a switch
    talk = " ".join(f'“I am here and I am cold,” she said to him.' for _ in range(6))
    assert book_promises.pov_tense_problem(talk, {"genre": "Mystery"}) is None


# ====================================================================== H5: a hand edit to an approved chapter
def test_h5_a_hand_edit_sets_the_tracked_state_aside_and_flags_the_later_chapters(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story", "pictures": False})
    assert run["status"] == "done"
    pid = run["project_id"]
    recs = chapter_recs(app, pid)
    assert len(recs) >= 3
    cid1, appr1, _ = recs[0]
    order = [c for c, _a, _l in recs]
    assert continuity.tracked(app.store, pid, BR, cid1, appr1)
    before = continuity.section(app.store, pid, BR, order, order[1])
    assert before.get("physical_state")  # chapter 2's writer was told where chapter 1 left things
    new = hand_edit(app, pid, appr1["record_id"], "# The Dark Light\n\nMara Vell walked home in the snow. "
                                                  "Nothing hurt at all.")
    # the state read from the old text is set aside — never given to the next writer — until tracked again
    assert not continuity.tracked(app.store, pid, BR, cid1, new)
    assert not continuity.section(app.store, pid, BR, order, order[1]).get("physical_state")
    # 🏠 Book home and the continuity page flag every later chapter, in plain words
    lines = bp_of(app, pid).status()["attention"]["lines"]
    assert "⚠ Chapter 1 changed after chapter 2 was written — check chapter 2" in lines
    assert "⚠ Chapter 1 changed after chapter 3 was written — check chapter 3" in lines
    assert continuity.get_chapter(app.store, pid, BR, "physical", cid1)["status"] == "out_of_date"
    # "I checked it" clears one flag
    st, out = continuity.route(app, "POST", ["recheck", order[1], "done"], {}, "author", pid, BR)
    assert st == 200 and out["ok"] and [r["chapter_id"] for r in out["rechecks"]] == [order[2]]


def test_h5_on_resume_a_draft_written_before_the_edit_is_not_reused(tmp_path):
    def verdict(ctx):  # chapter 2 never passes: the run pauses with its draft waiting
        d = ctx.get("draft") or {}
        return "REVISE" if d.get("module_id") == "C02" and 'OBJECTIVE:ch2"' in d.get("data_json", "") else "APPROVE"
    fake = BookFakeAI(default_verdict=verdict)
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story", "pictures": False})
    assert run["status"] == "paused" and run["problem"]["chapter_id"] == "ch2"
    pid, old_draft = run["project_id"], run["problem"]["record_id"]
    cid1, appr1, _ = chapter_recs(app, pid)[0]
    hand_edit(app, pid, appr1["record_id"], "# The Dark Light\n\nMara Vell walked home in the snow, and Tom Reed "
                                            "waited by the quay with the brass key.")
    fake.default_verdict = "APPROVE"
    app.autobook.decide("author", run["id"], {"action": "retry"})
    app.autobook.wait_for(run["id"], 120)
    done = app.autobook.get(run["id"])
    assert done["status"] == "done", done.get("problem")
    codes = [e.get("code") for e in done["events"]]
    assert "CHAPTER_CHANGED" in codes and "DRAFT_BEFORE_EDIT" in codes
    _cid2, appr2, _ = chapter_recs(app, pid)[1]
    assert appr2["record_id"] != old_draft  # written again from the changed chapter 1
    # chapter 1 was tracked again from its new text
    assert continuity.tracked(app.store, pid, BR, cid1, chapter_recs(app, pid)[0][1])


def test_h5_invalidate_after_chapter_runs_the_registered_hooks(tmp_path):
    app = make_app(tmp_path)
    called = []
    continuity.INVALIDATE_HOOKS.append(lambda *a: called.append(a))
    try:
        out = continuity.invalidate_after_chapter(app.store, "p1", BR, "ch5", number=5,
                                                  later=[{"chapter_id": "ch6", "number": 6, "record_id": "r6",
                                                          "version": 1}])
    finally:
        continuity.INVALIDATE_HOOKS.pop()
    assert out["flagged"] == ["ch6"] and called == [(app.store, "p1", BR, "ch5", 5)]
    assert continuity.rechecks(app.store, "p1", BR)[0]["message"] == \
        "⚠ Chapter 5 changed after chapter 6 was written — check chapter 6"


# ====================================================================== H11 / H12: the ending keeps the promises
def test_h11_h12_the_ending_is_checked_and_sent_back_for_a_fix(tmp_path):
    fake = BookFakeAI()
    seen = {}
    fix = "Mara finally asks Nessa Crane for help, and together they light the lamp."

    def first(ctx):
        seen["ctx"] = ctx
        return {"items": [{"id": p["id"], "kept": False, "where": "", "note": "Never paid off.",
                           "fix": "The brass key opens the lamp room at last."} for p in ctx["promises"]],
                "arc": {"kept": False, "note": "She never asks anyone for help.", "fix": fix},
                "question": {"kept": True, "note": "The light is back.", "fix": ""}}
    fake.ending_script = [first]  # the second check (after the fix) passes
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"checkers": "one", "length": "short_story", "pictures": False})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    ctx = seen["ctx"]
    assert ctx["main_character"]["name"] == "Mara Vell"
    assert {"want", "need", "change_limits"} <= set(ctx["main_character"])
    assert "Will Mara bring the light back before the winter storms?" in ctx["question"]
    # the last chapter was sent back, fixed by the writer, reviewed and approved again
    last = chapter_recs(app, pid)[-1][1]
    assert fix in last["data"]["text"] and last["version"] > 1
    events = app.autobook.get(run["id"])["events"]
    assert any(e.get("code") == "ENDING_FIX" for e in events)
    assert any(e.get("code") == "ENDING_KEPT" for e in events)
    assert ending_check.get(app.store, pid, BR)["open"] == []


def test_h11_what_stays_open_is_listed_for_the_author(tmp_path):
    fake = BookFakeAI()
    fake.ending_fix = False  # the writer cannot place it: nothing is guessed
    answer = {"items": [], "arc": {"kept": True, "note": "", "fix": ""},
              "question": {"kept": False, "note": "The ending never says whether the light returns.",
                           "fix": "Show the lamp burning again."}}
    fake.ending_script = [answer, answer]
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story", "pictures": False})
    assert run["status"] == "done"
    pid = run["project_id"]
    lines = bp_of(app, pid).status()["attention"]["lines"]
    assert any("The book's question is not kept by the ending" in x for x in lines)
    assert any(e.get("code") == "ENDING_OPEN" for e in app.autobook.get(run["id"])["events"])


def test_h11_vanished_characters_and_a_checkpoint_that_another_job_can_call(tmp_path):
    fake = BookFakeAI()
    fake.max_chapters = 6
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "novelette", "pictures": False})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    bp = bp_of(app, pid)
    from akowe.book_report import book_chapters
    chs = book_chapters(bp)
    # Tom Reed (mentor) is only named in the first chapters: by the end of a long book he has vanished
    for c in chs:
        c["text"] = c["text"].replace("Tom Reed", "the old keeper") if c["number"] > 1 else c["text"]
    pr = ending_check.promises(bp, chs)
    gone = [i for i in pr["items"] if i["kind"] == "character"]
    assert gone and gone[0]["name"] == "Tom Reed" and "last seen in chapter 1" in gone[0]["label"]
    # the checkpoint (L1 calls it after chapter N): only the first chapters, told it is not the end
    job = ReviewJob("ending_check", "author", pid, BR, ["book"], None)
    res = ending_check.check(app.review, job, upto=2, final=False)
    assert res["final"] is False and res["upto"] == 2 and res["chapters"] == 2
    assert "CHECKPOINT" in fake.prompts["ending"][-1][0]
    assert ending_check.get(app.store, pid, BR, "checkpoint")["upto"] == 2


# ====================================================================== H13: cut least important first, and say it
def test_h13_web_ais_get_realistic_context_limits(tmp_path):
    app = make_app(tmp_path)
    pr = app.engine.providers
    pr.configure_slot("AI-2", {"adapter_id": "autoinjector", "site": "chatgpt"})
    pr.configure_slot("AI-3", {"adapter_id": "autoinjector", "site": "claude", "context_limit_tokens": 150000})
    by = {s["slot_id"]: s for s in pr.slots()}
    assert by["AI-2"]["context_limit_tokens"] == 32000          # not the API's 200 000
    assert by["AI-3"]["context_limit_tokens"] == 150000         # the author's own setting wins
    assert by["AI-1"]["context_limit_tokens"] == 200000         # an API slot keeps its limit


def test_h13_a_full_rules_ledger_drops_retired_rules_before_new_ones(tmp_path):
    app = make_app(tmp_path)
    rules = [{"id": f"r{i}", "category": "hard_rule", "text": f"Rule number {i} holds.", "status":
              "retired" if i <= 4 else "active"} for i in range(1, story_rules.MAX_RULES + 1)]
    story_rules.save(app.store, "p1", BR, rules, by="author")
    entry = story_rules.get_entry(app.store, "p1", BR)
    new = [dict(r) for r in story_rules.active(entry)] + [{"id": "", "category": "hard_rule",
                                                           "text": "The newest rule must survive.", "scope": ""}]
    entry = story_rules.propose(app.store, "p1", BR, entry, story_rules.clean_rules(new), slot=None, basis_now={},
                                notes=[])
    e = story_rules.decide_proposals(app.store, "p1", BR)
    texts = [r["text"] for r in e["rules"]]
    assert "The newest rule must survive." in texts and len(texts) == story_rules.MAX_RULES
    assert sum(1 for r in e["rules"] if r["status"] == "retired") == 3  # one retired rule made room


def test_h13_must_shows_are_checked_before_scene_goals_and_details():
    items = [{"id": f"i{n}", "kind": "detail", "required": False} for n in range(14)] + \
        [{"id": "m1", "kind": "must_show", "required": True}, {"id": "m2", "kind": "must_show", "required": True},
         {"id": "b", "kind": "beat", "required": True}]
    kept = planned.most_important(items, 12)
    assert {"m1", "m2", "b"} <= {i["id"] for i in kept} and len(kept) == 12
    assert [i["id"] for i in kept][-3:] == ["m1", "m2", "b"]  # the order is kept


def test_h13_cut_instructions_are_said_in_the_run_the_chapter_page_and_book_home(tmp_path, monkeypatch):
    real = autobook_fake.sheet_for

    def many_must_shows(name, others=(), story_role=None):
        out = real(name, others, story_role)
        if name == "Mara Vell":
            out["must_show"] = [f"Mara keeps detail number {n} of the tide-tables" for n in range(1, 6)]
        return out
    monkeypatch.setattr(autobook_fake, "sheet_for", many_must_shows)
    monkeypatch.setattr(planned, "MUST_SHOW_BRIEF", 1)  # a tight brief: most must-shows do not fit
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story", "pictures": False})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    cut_events = [e for e in app.autobook.get(run["id"])["events"] if e.get("code") == "INSTRUCTIONS_CUT"]
    assert cut_events and "must-show details: Mara Vell: Mara keeps detail number" in cut_events[0]["message"]
    assert cut_events[0]["message"].startswith("⚠️ Chapter 1: the instructions were too long")
    listed = brief_cuts.listing(app.store, pid, BR)
    assert listed and listed[0]["chapter_id"] == "ch1"
    cid, appr, _ = chapter_recs(app, pid)[0]
    q = app.review.planned.quick("author", pid, BR, appr["record_id"])
    assert q["instructions_cut"]["line"].startswith("⚠️ Chapter 1")
    assert any(x.startswith("⚠️ Chapter 1: the instructions were too long") for x in
               bp_of(app, pid).status()["attention"]["lines"])
    # the must-shows the writer DID get are the first ones, and the item checker kept every must-show
    assert all(i["kind"] != "must_show" or i["required"] for i in q["items"])
