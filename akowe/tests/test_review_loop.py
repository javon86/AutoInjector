"""🔁 The review / fix loop (the Ansel case, Nov 2026) and the 🔔 plain alerts for every "needs you" stop.

* The reviewer judges a revision against APPROVED canon only: the AI's own notes made with the earlier draft and the
  previous draft are labelled NOT canon, and the reviewer gets the findings the fix was meant to answer.
* The same finding twice in a row after a fix, or a fix that would change an approved fact, becomes ONE specific
  decision (before → after, three choices) instead of more rounds.
* Every alert says the category, what it is about, what is wrong, why it stopped and what happens next.
"""
from __future__ import annotations

import json

import pytest

from akowe import alerts, characters as chars_mod, review_loop
from akowe.assist import AssistService
from akowe.errors import AkoweError
from akowe.review import CANON_RULE, REVISION_RULE, ReviewJob, ReviewService, _rkey
from akowe.status_push import alert_brief

from autobook_fake import BookFakeAI
from test_autobook import make_app, outbox, run_book, steps

from test_server import server  # noqa: F401

ODILE_BG = ("Their father drowned when Odile was twelve and Ansel was still an infant. When their mother died, Odile was "
            "twenty-two and Ansel about ten; she took the ledger and raised him.")
ANSEL_V1 = ("He was a boy of about ten when their mother died and Odile raised him. At eight, during their father's "
            "wake, he hid under the ledger table and watched the salt candle burn down, a memory he keeps to himself.")
ANSEL_V2 = ("Their father drowned when Ansel was still an infant. He was about ten when their mother died, and Odile "
            "raised him. During their mother's wake he hid under the ledger table and watched the salt candle burn "
            "down, a memory he keeps to himself.")
MEMORY_V1 = "At eight, during his father's wake, he hid under the ledger table and watched the salt candle burn down."
MEMORY_V2 = "At about ten, during his mother's wake, he hid under the ledger table and watched the salt candle burn down."
FLAG = {"verdict": "REVISE", "confidence": 0.95,
        "reasons": ["His background contains a timeline contradiction: he is eight at his father's wake but about ten "
                    "when his mother died, while the approved family timeline says the father drowned when he was an "
                    "infant."],
        "suggested_changes": ["Resolve the contradiction between Ansel being eight at his father's wake and about ten "
                              "when his mother died, keeping the approved order of the parents' deaths."]}


def fact(s, p, v, a="FACT"):
    return {"subject_id": s, "predicate": p, "value": v, "assertion_type": a, "effective_from": None,
            "effective_to": None, "source_refs": []}


class AnselAI:
    """A strict reviewer that, like the real one in the log, treats whatever it is handed as ``character_sheet`` as the
    truth — and a writer that fixes the contradiction correctly (and corrects its own notes)."""

    def __init__(self):
        self.reviews = []   # (task, context)
        self.fixes = []

    def submit(self, slot, system, user, schema):
        ctx = (json.loads(user.split("\n", 1)[1]).get("context")) or {}
        props = schema.get("properties") or {}
        usage = {"model": "fake", "input_tokens": 1, "output_tokens": 1}
        if "verdict" in props:
            self.reviews.append((system, ctx))
            bg = json.loads(ctx["draft"]["data_json"])["attributes"]["background"]
            if "eight, during their father's wake" in bg:
                return dict(FLAG), usage
            sheet = ctx.get("character_sheet")  # the OLD context: the earlier draft's notes sent as the truth
            if sheet and "father's wake" in (sheet.get("private_memory") or "") and "mother's wake" in bg:
                return {"verdict": "REVISE", "confidence": 0.99,
                        "reasons": ["The draft contradicts Ansel's character sheet by changing his private memory from "
                                    "his father's wake to his mother's wake."],
                        "suggested_changes": ["Restore the established private memory at age eight during his father's "
                                              "wake, or obtain an explicit revision of the character sheet."]}, usage
            return {"verdict": "APPROVE", "reasons": ["The family timeline now agrees with Odile's approved record."],
                    "suggested_changes": [], "confidence": 0.95}, usage
        self.fixes.append((system, ctx))
        data = json.loads(ctx["draft"]["data_json"])
        data["attributes"]["background"] = ANSEL_V2
        out = dict(data)
        if "character_sheet_update" in props:
            out["character_sheet_update"] = {"private_memory": MEMORY_V2}
        return out, usage


@pytest.fixture
def ansel(h):
    """Odile approved (the family timeline); Ansel v1 an AI draft with the contradiction, and the AI's notes on him."""
    ai = AnselAI()
    h.engine.providers.test_adapter = ai
    h.engine.providers.configure_slot("AI-1", {"adapter_id": "anthropic"})
    h.engine.providers.configure_slot("AI-2", {"adapter_id": "manual"})
    rv = ReviewService(h.engine, AssistService(h.engine, h.principal), h.principal)
    odile = h.create("A01", {"concept": "Odile Marrant"}, manual_candidate={
        "concept": "Odile Marrant", "attributes": {"background": ODILE_BG}, "linked_refs": [],
        "protected_fact_flags": [], "facts": [fact("odile", "entity.name", "Odile Marrant")]})["output_refs"][0]
    rv.approve(h.principal, h.project_id, "main", {"record_ids": [odile["record_id"]], "author_confirms": True})
    ref = h.create("A01", {"concept": "Ansel Marrant"}, manual_candidate={
        "concept": "Ansel Marrant", "attributes": {"background": ANSEL_V1}, "linked_refs": [],
        "protected_fact_flags": [], "facts": [fact("ansel", "entity.name", "Ansel Marrant")]})["output_refs"][0]
    chars_mod.save_entry(h.store, h.project_id, "main", ref["record_id"], by="ai", slot="AI-1",
                         sheet={"wants": "to leave Skerrow", "private_memory": MEMORY_V1}, voice={"rhythm": "quick"})
    return h, rv, ai, ref["record_id"]


def _review(h, rv, rid):
    job = ReviewJob("review", h.principal, h.project_id, "main", [rid], "AI-2")
    return rv.review_one(job, rid, auto=False)["review"]


def test_ansel_fix_is_approved_against_canon_not_the_old_draft(ansel):
    h, rv, ai, rid = ansel
    first = _review(h, rv, rid)
    assert first["verdict"] == "REVISE" and "timeline contradiction" in first["reasons"][0]
    job = ReviewJob("fix", h.principal, h.project_id, "main", [rid], "AI-1")
    rv._run_fix(job)
    assert job.results[0]["ok"] and job.results[0]["version"] == 2
    # the writer's own notes followed the fix (an AI-made sheet only)
    e = chars_mod.get_entry(h.store, h.project_id, "main", rid)
    assert e["sheet"]["private_memory"] == MEMORY_V2 and e["made_by"]["kind"] == "ai"
    fix_task, fix_ctx = ai.fixes[0]
    assert "character_sheet_update" in fix_task and "NOT canon" in fix_ctx["companion_draft"]["note"]

    second = _review(h, rv, rid)
    assert second["verdict"] == "APPROVE", second
    task, ctx = ai.reviews[-1]
    # the previous draft and the AI's notes are never presented as the sheet / canon
    assert "character_sheet" not in ctx and "author_sheet" not in ctx
    assert "NOT canon" in ctx["companion_draft"]["note"]
    assert ctx["revision"]["of_version"] == 1 and "not canon" in ctx["revision"]["previous_draft"]["label"]
    assert "eight, during their father's wake" in ctx["revision"]["previous_draft"]["data_json"]
    assert ctx["revision"]["previous_review"]["reasons"] == first["reasons"]
    assert all(a["record_id"] != rid for a in ctx["canon"]["approved_records"])  # never its own canon
    assert any("Odile" in a["concept"] for a in ctx["canon"]["approved_records"])
    assert CANON_RULE in task and REVISION_RULE in task
    assert "NOT canon" in CANON_RULE and "accept that change" in REVISION_RULE
    # a first review is not a revision
    assert REVISION_RULE not in ai.reviews[0][0] and "revision" not in ai.reviews[0][1]


def test_the_old_context_would_have_looped(ansel):
    """The same writer and reviewer, but the earlier notes handed over as ``character_sheet`` (the old context):
    the correct fix is refused — what the user's log shows."""
    h, rv, ai, rid = ansel
    rv._companion_extra = lambda pid, branch, rec: {"character_sheet": {"private_memory": MEMORY_V1}}
    _review(h, rv, rid)
    rv._run_fix(ReviewJob("fix", h.principal, h.project_id, "main", [rid], "AI-1"))
    assert _review(h, rv, rid)["verdict"] == "REVISE"


def test_the_authors_own_sheet_stays_canon_and_is_never_rewritten(ansel):
    h, rv, ai, rid = ansel
    chars_mod.save_entry(h.store, h.project_id, "main", rid, by="author",
                         sheet={"wants": "to leave Skerrow", "private_memory": MEMORY_V1})
    _review(h, rv, rid)
    _task, ctx = ai.reviews[-1]
    assert ctx["author_sheet"]["character_sheet"]["private_memory"] == MEMORY_V1 and "companion_draft" not in ctx
    rv._run_fix(ReviewJob("fix", h.principal, h.project_id, "main", [rid], "AI-1"))
    assert "character_sheet_update" not in ai.fixes[-1][0]
    assert chars_mod.get_entry(h.store, h.project_id, "main", rid)["sheet"]["private_memory"] == MEMORY_V1


# ---------------------------------------------------------------------------------------------- in a ⚡ run
def scripted(plan: dict):
    """A reviewer that answers per record (A01 concept / module) from ``plan``: name -> [review, …]; others APPROVE."""
    seen: dict[str, int] = {}

    def rv(ctx):
        d = json.loads(ctx["draft"]["data_json"])
        key = d.get("concept") if ctx["draft"]["module_id"] == "A01" else ctx["draft"]["module_id"]
        n = seen.get(key, 0)
        seen[key] = n + 1
        answers = plan.get(key) or []
        if n < len(answers):
            return dict(answers[n])
        return {"verdict": "APPROVE", "reasons": ["It fits."], "suggested_changes": [], "confidence": 0.9}
    return rv


SAME = {"verdict": "REVISE", "reasons": ["His background contradicts the approved family timeline about his father's "
                                         "drowning and the wake."],
        "suggested_changes": ["Move the private memory of the wake so it agrees with the family timeline of "
                              "his father's drowning."]}


def test_same_finding_twice_becomes_one_decision_not_round_three(tmp_path):
    fake = BookFakeAI()
    fake.verdicts = [scripted({"Tom Reed": [SAME, SAME, SAME]})] * 40
    app = make_app(tmp_path, fake=fake)
    run = run_book(app)
    assert run["status"] == "paused" and run["state"] == "needs_decision", run["phase"]
    prob = run["problem"]
    assert prob["code"] == "REVIEW_DECISION" and prob["decision"]["kind"] == "loop"
    assert prob["options"] == ["accept_change", "keep_original", "edit"]
    assert fake.kinds.count("fix") == 1  # one fix, then the decision — no second fix, no third review
    assert prob["subject"] == "Tom Reed (character)" and prob["prev_version"] == 1 and prob["version"] == 2
    ch = prob["decision"]["change"]
    assert ch["before"] and ch["after"] and ch["before"] != ch["after"] and "(revised)" in ch["after"]
    assert "still_unapproved" in prob["decision"] and "not approved" in prob["fix"]
    assert steps(run)["canon"]["state"] == "paused"
    a = run["alert"]
    assert (a["category"], a["icon"], a["label"]) == ("character", "🧑", "Character issue")
    assert a["what"] == "Tom Reed (character)" and "family timeline" in a["wrong"]
    assert "disagreed twice" in a["why"] and "accept the change, keep the original" in a["next"]
    assert [c["action"] for c in a["choices"]] == ["accept_change", "keep_original", "edit", "edited"]
    with pytest.raises(AkoweError):
        app.autobook.decide("author", run["id"], {"action": "keep_original"})  # needs the author's confirmation
    # ↩ keep the original: the version before the fix comes back, approved as the author's own
    app.autobook.decide("author", run["id"], {"action": "keep_original", "author_confirms": True})
    app.autobook.wait_for(run["id"], 120)
    run = app.autobook.public(app.autobook.get(run["id"]))
    assert run["status"] == "done", run["phase"]
    hist = app.store.history(run["project_id"], "main", prob["record_id"])
    assert hist[-1]["version"] == 3 and hist[-1]["data"] == hist[0]["data"]
    assert any("kept the original" in x for x in run["check_later"])
    by_author = outbox(app, run["project_id"], "review.approved_by_author")
    assert any(prob["record_id"] in e["record_ids"] for e in by_author)
    assert any(e.get("code") == "REVIEW_LOOP" for e in app.autobook.get(run["id"])["events"])


def test_a_change_to_an_approved_fact_is_one_decision_with_before_and_after(tmp_path):
    other = {"verdict": "REVISE", "reasons": ["Her age in the background is missing."],
             "suggested_changes": ["Add her age to the background."]}
    canon = {"verdict": "REVISE", "reasons": ["Mara's private memory disagrees with the approved Old Light record."],
             "suggested_changes": ["Change the approved Old Light record instead."],
             "canon_change": {"field": "private memory", "before": "the lamp was lit in autumn",
                              "after": "the lamp was lit in spring",
                              "approved_fact": "The Old Light record (approved) says the lamp was first lit in "
                                               "autumn."}}
    fake = BookFakeAI()
    fake.verdicts = [scripted({"Mara Vell": [other, canon]})] * 40
    app = make_app(tmp_path, fake=fake)
    run = run_book(app)
    prob = run["problem"]
    assert prob["code"] == "REVIEW_DECISION" and prob["decision"]["kind"] == "canon", run["phase"]
    assert fake.kinds.count("fix") == 1
    assert prob["options"] == ["accept_change", "keep_original", "edit"]
    assert prob["decision"]["change"]["before"] and prob["decision"]["change"]["after"]
    assert "Old Light record (approved)" in prob["decision"]["why"]
    assert run["alert"]["why"] == "This would change an approved fact, so only you can decide."
    events = [e for e in run["events"] if e.get("code") in ("CANON_CHANGE", "REVIEW_LOOP")]
    assert len(events) == 1  # exactly one decision, no loop
    app.autobook.decide("author", run["id"], {"action": "accept_change", "author_confirms": True})
    app.autobook.wait_for(run["id"], 120)
    run = app.autobook.public(app.autobook.get(run["id"]))
    assert run["status"] == "done", run["phase"]
    head = app.store.history(run["project_id"], "main", prob["record_id"])[-1]
    assert head["version"] == 2 and head.get("approved_version") in (None, 2)
    assert any(e.get("code") == "CHANGE_ACCEPTED" for e in app.autobook.get(run["id"])["events"])


def test_different_findings_still_get_the_usual_two_fixes(tmp_path):
    fake = BookFakeAI(verdicts=["REVISE", "REVISE", "REVISE"])  # three different notes (REVISE_NOTES)
    app = make_app(tmp_path, fake=fake)
    run = run_book(app)
    assert run["problem"]["code"] == "REVIEW_NOT_PASSED" and fake.kinds.count("fix") == 2
    a = run["alert"]
    assert a["category"] in ("place", "character") and a["what"] and a["wrong"]
    assert a["why"].startswith("The AI reviewer still asked for changes")
    assert "approve it anyway, edit it yourself, or let the AI try again" in a["next"]


# ---------------------------------------------------------------------------------------------- the pure parts
def test_same_finding_matches_reworded_findings_on_the_changed_field():
    v1 = {"attributes": {"background": ANSEL_V1}}
    v2 = {"attributes": {"background": ANSEL_V2}}
    again = {"verdict": "REVISE", "reasons": ["The draft contradicts Ansel's character sheet by changing his private "
                                              "memory from age eight at his father's wake to his mother's wake."],
             "suggested_changes": ["Restore the private memory of hiding beneath the ledger table at age eight during "
                                   "his father's wake."]}
    m = review_loop.same_finding(FLAG, again, v1, v2, ignore={"ansel"})
    assert m and m["field"] == "attributes.background"
    d = review_loop.decision(kind="loop", subject="Ansel Marrant (character)", review=again, prev_review=FLAG,
                             match=m, prev_data=v1, cur_data=v2, can_keep=True, ignore={"ansel"})
    assert "father's wake" in d["change"]["before"] and "mother's wake" in d["change"]["after"]
    assert d["change"]["field"] == "background" and "timeline contradiction" in d["wrong"]
    # unrelated findings are not a loop
    other = {"verdict": "REVISE", "reasons": ["The voice is flat."], "suggested_changes": ["Add a joke to his lines."]}
    assert review_loop.same_finding(FLAG, other, v1, v2, ignore={"ansel"}) is None


def _run(code=None, state="needs_decision", **prob):
    p = dict({"code": code, "message": "Something happened.", "where": {"step": "Write every chapter"}}, **prob)
    return {"status": "paused", "pause_reason": "problem", "problem": p if code else None, "current": "chapters"}


@pytest.mark.parametrize("run,state,cat", [
    (_run("REVIEW_DECISION", module_id="A01", subject="Ansel Marrant (character)",
          options=["accept_change", "keep_original", "edit"],
          decision={"wrong": "His age at his father's wake doesn't match the family timeline.",
                    "stop": "The reviewer and the writer disagreed twice about the same thing, so it needs you.",
                    "change": {"field": "background", "before": "a", "after": "b"}}), "needs_decision", "character"),
    (_run("REVIEW_NOT_PASSED", module_id="C02", chapter_id="ch3", reasons=["It fits.", "The pacing is wrong here."],
          options=["approve_anyway", "edit", "retry"]), "needs_decision", "chapter"),
    (_run("REVIEW_NOT_PASSED", module_id="A04", subject="Gullhaven Harbor (place)",
          options=["approve_anyway", "edit", "retry"], reasons=["The harbour is missing its lighthouse."]),
     "needs_decision", "place"),
    (_run("CHECKS_REFUSED", module_id="A12", details=["SCHEMA: a field is missing"], options=["edit", "retry"]),
     "needs_decision", "item"),
    (_run("REVIEW_NOT_PASSED", module_id="B11", options=["approve_anyway", "edit", "retry"], reasons=["Chapter 2 "
          "repeats chapter 1."]), "needs_decision", "plot"),
    (_run("REVIEW_NOT_PASSED", module_id="A14", options=["approve_anyway", "edit", "retry"],
          reasons=["Two events are out of order."]), "needs_decision", "timeline"),
    (_run("CHECKPOINT_WAITING", chapter_id="ch4", options=["retry"]), "problem", "continuity"),
    (_run("STORY_MAP_CONFLICT", options=["retry"]), "problem", "story_map"),
    (_run("HUMAN_PASS_FAILED", options=["retry"]), "problem", "style"),
    (_run("NO_SECOND_AI", module_id="C02", chapter_id="ch1", options=["approve_anyway", "retry"]), "needs_decision",
     "approval"),
    (_run("PICTURE_FAILED", step="pictures"), "problem", "picture"),
    (_run("TIMEOUT", options=["retry"]), "problem", "ai"),
    (_run("RATE_LIMITED"), "problem", "ai"),
    ({"status": "paused", "pause_reason": "author", "problem": None}, "paused", "paused"),
    ({"status": "interrupted", "problem": None}, "interrupted", "ai"),
])
def test_every_alert_has_category_what_why_and_next(run, state, cat):
    a = alerts.describe(run, state)
    assert a["category"] == cat and (a["icon"], a["label"]) == alerts.CATEGORIES[cat]
    for k in ("what", "wrong", "why", "next"):
        assert a[k] and len(a[k]) <= 220, (k, a)
    assert a["choices"] and all(c["label"] for c in a["choices"])
    if cat == "chapter":
        assert a["what"] == "Chapter 3" and a["wrong"] == "The pacing is wrong here."
    if cat == "paused":
        assert a["why"] == "You pressed Pause." and "Resume" in a["next"]
    brief = alert_brief(a)  # what AutoInjector gets: bounded, same words
    assert brief["label"] == a["label"] and brief["what"] == a["what"]
    assert alerts.describe(dict(run, status="running"), "working") is None


def test_a_working_run_has_no_alert_and_a_paused_one_does(tmp_path):
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    run = run_book(app)
    assert run["status"] == "done" and run["alert"] is None
