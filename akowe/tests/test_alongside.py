"""✍ Write alongside me (alongside.py): the author highlights a passage (or puts the cursor) and asks the AI to
continue / rewrite / describe more / expand / tighten it.

Unit tests for the request checks (no selection, a cursor only, out of range, too long), the focused brief (built
from chapter_brief: the passage and the text around it, the plan, the voice cards of the characters named there,
the locked details, the promises and content limits), the joining and the diff; the job and ✔ Use this through the
HTTP routes with the fake AI (a suggestion changes nothing; using it makes a new DRAFT version, the approved one
stays, and approving it flags the later chapters like any hand edit — H5); the error cases (AI busy, timeout,
the chapter changed meanwhile); and the quick local checks ⚠️ (point of view / tense slip, a locked detail)."""
from __future__ import annotations

import json
import time
import types

import pytest

from akowe import alongside as al
from akowe import providers as prov_mod
from akowe.book_path import BookPath, save_profile
from akowe.errors import AkoweError

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book

BR = "main"


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def route(app, method, pid, rest, body=None):
    return app.route(method, f"/api/projects/{pid}/branches/{BR}/review/{rest}", {}, body, "author", {})


def wait_job(app, job, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = app.review.get_job("author", job["job_id"])
        if j["status"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def outbox(app, pid, et):
    return [json.loads(r["payload"]) for r in app.store.query(
        "SELECT payload FROM outbox WHERE project_id=? AND event_type=? ORDER BY rowid", (pid, et))]


@pytest.fixture
def book(tmp_path):
    """A finished short book (three approved chapters) written by AI-1, reviewed by AI-2."""
    fake = BookFakeAI()
    app = make_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story", "pictures": False})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, BR)
    outline = bp.outline()
    chs = []
    for c in bp.outline_chapters(outline):
        _ctx, _latest, appr = bp.chapter_prose(outline, c["chapter_id"])
        chs.append(appr)
    return app, fake, pid, chs


def sentence(text, word="Mara"):
    i = text.index(word)
    return i, text.index(".", i) + 1


# ====================================================================== the request
def test_clean_request_refuses_a_missing_selection_in_plain_words():
    text = "Mara walked. The fog came in. She waited."
    with pytest.raises(AkoweError) as e:
        al.clean_request({"action": "rewrite"}, text)
    assert e.value.code == "MISSING_INPUT" and "highlight a passage" in e.value.errors[0]["message"]
    with pytest.raises(AkoweError) as e:  # a cursor only: rewriting needs highlighted words
        al.clean_request({"action": "tighten", "start": 5, "end": 5}, text)
    assert e.value.code == "MISSING_INPUT" and "Continue from here" in e.value.errors[0]["message"]
    with pytest.raises(AkoweError) as e:  # only spaces highlighted counts as nothing
        al.clean_request({"action": "describe", "start": 12, "end": 13}, text)
    assert e.value.code == "MISSING_INPUT"
    req = al.clean_request({"action": "continue", "start": 12, "end": 12}, text)  # the cursor is enough here
    assert req["passage"] == "" and req["start"] == req["end"] == 12
    req = al.clean_request({"action": "continue", "start": 0, "end": 12}, text)  # after the highlighted words
    assert req["start"] == req["end"] == 12
    req = al.clean_request({"action": "rewrite", "start": 13, "end": 0, "note": "  more   tense "}, text)
    assert (req["start"], req["end"], req["passage"], req["note"]) == (0, 13, "Mara walked. ", "more tense")
    for body, path in (({"action": "dance", "start": 0, "end": 3}, "/action"),
                       ({"action": "rewrite", "start": 0, "end": 999}, "/end"),
                       ({"action": "rewrite", "start": -1, "end": 3}, "/end"),
                       ({"action": "rewrite", "start": "0", "end": 3}, "/start"),
                       ({"action": "rewrite", "start": 0, "end": 3, "note": "x" * 301}, "/note"),
                       ({"action": "rewrite", "start": 0, "end": 3, "text": 5}, "/text")):
        with pytest.raises(AkoweError) as e:
            al.clean_request(body, text)
        assert e.value.errors[0]["path"] == path, body
    long_text = "word " * 3000
    with pytest.raises(AkoweError) as e:
        al.clean_request({"action": "rewrite", "start": 0, "end": len(long_text)}, long_text)
    assert "too long" in e.value.errors[0]["message"]
    with pytest.raises(AkoweError) as e:
        al.clean_request({"action": "continue", "start": 0, "end": 0}, "   ")
    assert e.value.code == "MISSING_INPUT" and "no text yet" in e.value.errors[0]["message"]


def test_joining_cleaning_and_the_word_diff():
    t = "Mara walked.The fog came in. She waited."
    assert al.joined(t, 12, 12, "Gulls cried.", "continue") == "Mara walked. Gulls cried. The fog came in. She waited."
    t2 = "Mara walked.\n\nShe waited."
    assert al.joined(t2, 14, 14, "Gulls cried.\n\n", "continue") == "Mara walked.\n\nGulls cried.\n\nShe waited."
    t3 = "A. The fog came in. B."
    assert al.joined(t3, 2, 20, "Fog.", "tighten") == "A. Fog. B."  # the spaces around the passage are kept
    req = {"action": "continue", "text": "She looked down at the water.", "start": 29, "end": 29, "passage": ""}
    assert al.clean_answer({"text": "```\nShe looked down at the water. The tide turned.\n```"}, req) == "The tide turned."
    assert al.clean_answer({"text": "“The tide turned.”"}, req) == "The tide turned."
    for raw in ({}, {"text": ""}, None, {"text": 4}):
        with pytest.raises(AkoweError):
            al.clean_answer(raw, req)
    req2 = {"action": "rewrite", "text": "x", "start": 0, "end": 1, "passage": "The  fog came."}
    with pytest.raises(AkoweError) as e:
        al.clean_answer({"text": "The fog came."}, req2)
    assert "same words" in e.value.errors[0]["message"]
    d = al.diff("the fog came in", "the thick fog came in fast")
    assert "".join(x["text"] for x in d if x["op"] != "del") == "the thick fog came in fast"
    assert "".join(x["text"] for x in d if x["op"] != "add") == "the fog came in"
    assert {x["op"] for x in d} == {"same", "add"}


# ====================================================================== the brief
def test_the_focused_brief_reuses_the_chapter_brief(book):
    app, fake, pid, chs = book
    save_profile(app.store, pid, {"content_limits": "No graphic violence."})
    rec = chs[0]
    text = rec["data"]["text"]
    i, j = sentence(text)
    req = al.clean_request({"action": "rewrite", "start": i, "end": j, "note": "more tense"}, text)
    ctx, _protected, extra = al.brief(app.review, "author", pid, BR, rec, req)
    assert ctx["akowe_task"] == "write_alongside" and ctx["passage"] == text[i:j] and ctx["author_note"] == "more tense"
    assert ctx["before"] == text[:i] and ctx["after"].startswith(text[j:j + 40])
    assert ctx["chapter_plan"]["number"] == 1 and ctx["chapter_plan"]["objective"]
    wb = ctx["writing_brief"]
    assert wb["main_character"]["name"] == "Mara Vell" and wb["fixed_details"]  # 🔒 locked details
    # the voice cards of the characters named around the passage only (the chapter brief may have more)
    names = [c["name"] for c in wb.get("voice_cards") or []]
    assert names and all(n.split()[0] in (ctx["before"] + ctx["passage"] + ctx["after"]) or n == wb["pov"]["name"]
                         for n in names)
    assert "length" not in wb and "story_so_far" not in wb  # whole-chapter parts are left out
    assert "third person" in ctx["promises"] and "No graphic violence" in ctx["promises"]
    assert ctx["book_profile"]["content_limits"] == "No graphic violence." and "past tense" in ctx["book_profile"]["tense"]
    assert extra["meta"]["chapter_id"] == rec["data"].get("chapter_id", extra["meta"]["chapter_id"])
    assert "author_note" in al.task("rewrite", "x") and "author_note" not in al.task("rewrite", "")


def test_focus_keeps_only_the_voices_named_near_the_passage():
    brief = {"voice_cards": [{"name": "Mara Vell"}, {"name": "Tom Reed"}, {"name": "Nessa Bright"}],
             "other_voices": ["Old Harl: gruff", "Pell: quick"], "pov": {"name": "Mara Vell"},
             "length": {"target_words": 1000}, "story_so_far": ["x"], "fixed_details": [{"name": "Tom Reed"}],
             "rules": ["keep it"]}
    out = al.focus(brief, "Tom said nothing to Harl.")
    assert [c["name"] for c in out["voice_cards"]] == ["Mara Vell", "Tom Reed"]
    assert out["other_voices"] == ["Old Harl: gruff"] and out["fixed_details"] and "length" not in out
    assert out["rules"] == ["keep it"] and "story_so_far" not in out
    assert al.focus(brief, "The fog came in.")["voice_cards"] == [{"name": "Mara Vell"}]  # the narrator stays
    assert len(al.focus(dict(brief, pov=None), "The fog came in.")["voice_cards"]) == 3  # nobody named: all
    assert al.focus(None, "x") == {}


# ====================================================================== the job and ✔ Use this
def test_a_suggestion_changes_nothing_and_using_it_makes_a_new_draft(book):
    app, fake, pid, chs = book
    rec = chs[0]
    text = rec["data"]["text"]
    i, j = sentence(text)
    st, job = route(app, "POST", pid, "alongside", {"record_id": rec["record_id"], "action": "describe",
                                                     "start": i, "end": j})
    assert st == 202
    j1 = wait_job(app, job)
    assert j1["status"] == "done", j1
    res = j1["results"][0]
    assert res["slot"] == "AI-1"  # by default the chapter's writer
    assert res["suggestion"].startswith(text[i:j]) and "Salt stung her lips" in res["suggestion"]
    assert res["passage"] == text[i:j] and res["notes"] == [] and res["words"]["after"] > res["words"]["before"]
    assert any(d["op"] == "add" and "Salt" in d["text"] for d in res["diff"])
    head = app.review._head(pid, BR, rec["record_id"])
    assert head["version"] == rec["version"]  # nothing changed in the book
    st, out = route(app, "POST", pid, "alongside/use", {
        "record_id": rec["record_id"], "version": res["version"], "action": "describe", "suggestion": res["suggestion"],
        "start": res["start"], "end": res["end"], "passage": res["passage"], "job_id": j1["job_id"]})
    assert st == 200 and out["version"] == rec["version"] + 1 and out["was_approved"]
    assert "approved version stays in the book" in out["message"]
    new = app.review._head(pid, BR, rec["record_id"])
    assert new["lifecycle"] == "DRAFT" and new["data"]["text"] == text[:i] + res["suggestion"] + text[j:]
    bp = BookPath(app.engine, "author", pid, BR)
    _c, _l, appr = bp.chapter_prose(bp.outline(), chs and bp.outline_chapters(bp.outline())[0]["chapter_id"])
    assert appr["version"] == rec["version"] and appr["data"]["text"] == text  # the approved text is still the book
    mb = app.review.made_by(pid, BR, new, app.review.fixes(pid, BR))
    assert mb["label"].startswith("Written alongside you by") and mb["slot"] == "AI-1"
    ev = outbox(app, pid, "alongside.used")[-1]
    assert ev["action"] == "describe" and ev["to_version"] == new["version"] and ev["was_approved"]
    assert "Salt" not in json.dumps(ev)  # activity events carry numbers, never book text
    # approving the new version runs the hand-edit follow-through (H5): the later chapters are flagged
    app.review.approve("author", pid, BR, {"record_ids": [rec["record_id"]], "versions": {rec["record_id"]:
                                                                                          new["version"]},
                                           "author_confirms": True})
    lines = BookPath(app.engine, "author", pid, BR).status()["attention"]["lines"]
    assert "⚠ Chapter 1 changed after chapter 2 was written — check chapter 2" in lines
    # the suggestion was for the old version: refused, nothing changed
    with pytest.raises(AkoweError) as e:
        route(app, "POST", pid, "alongside/use", {
            "record_id": rec["record_id"], "version": res["version"], "action": "describe",
            "suggestion": res["suggestion"], "start": res["start"], "end": res["end"], "passage": res["passage"]})
    assert e.value.code == "VERSION_CONFLICT" and e.value.errors[0]["fix"]


def test_continue_from_the_cursor_with_unsaved_text_and_a_moved_passage(book):
    app, fake, pid, chs = book
    rec = chs[1]
    title, body = rec["data"]["text"].split("\n\n", 1) if rec["data"]["text"].startswith("# ") else ("", rec["data"]["text"])
    mine = (title + "\n\n" if title else "") + body.rstrip() + "\n\nShe stopped at the quay."  # typed, not saved
    cur = len(mine)
    j1 = wait_job(app, route(app, "POST", pid, "alongside", {"record_id": rec["record_id"], "action": "continue",
                                                              "text": mine, "start": cur, "end": cur})[1])
    res = j1["results"][0]
    assert j1["status"] == "done" and res["passage"] == "" and res["anchor"].endswith("She stopped at the quay.")
    ctx = fake.prompts["alongside"][-1][1]
    assert ctx["before"].endswith("She stopped at the quay.") and "after" not in ctx and ctx["cursor"]
    # meanwhile the author added a line at the very top: the place is found again by the words before the cursor
    moved = "A new first line.\n\n" + mine
    out = route(app, "POST", pid, "alongside/use", {
        "record_id": rec["record_id"], "version": rec["version"], "action": "continue", "text": moved,
        "suggestion": res["suggestion"], "start": res["start"], "end": res["end"], "passage": "",
        "anchor": res["anchor"]})[1]
    new = app.review._head(pid, BR, rec["record_id"])
    assert out["version"] == new["version"] and new["data"]["text"] == moved + " " + res["suggestion"]


def test_a_chosen_ai_answers_and_the_suggestion_place_must_still_exist(book):
    app, fake, pid, chs = book
    rec = chs[2]
    text = rec["data"]["text"]
    i, j = sentence(text)
    j1 = wait_job(app, route(app, "POST", pid, "alongside", {"record_id": rec["record_id"], "action": "tighten",
                                                              "start": i, "end": j, "slot_id": "AI-2"})[1])
    res = j1["results"][0]
    assert j1["slot"] == "AI-2" and res["words"]["after"] < res["words"]["before"]
    with pytest.raises(AkoweError) as e:  # the highlighted words are gone from the text the author sends now
        route(app, "POST", pid, "alongside/use", {
            "record_id": rec["record_id"], "version": rec["version"], "action": "tighten", "text": "Something else.",
            "suggestion": res["suggestion"], "start": res["start"], "end": res["end"], "passage": res["passage"]})
    assert e.value.code == "VERSION_CONFLICT" and "highlight it again" in e.value.errors[0]["message"]
    assert app.review._head(pid, BR, rec["record_id"])["version"] == rec["version"]


def test_endpoint_refusals(book):
    app, fake, pid, chs = book
    rec = chs[0]
    for body, code in (({"record_id": rec["record_id"], "action": "rewrite"}, "MISSING_INPUT"),
                       ({"record_id": rec["record_id"], "action": "expand", "start": 4, "end": 4}, "MISSING_INPUT"),
                       ({"action": "rewrite", "start": 0, "end": 4}, "MISSING_INPUT"),
                       ({"record_id": "nope", "action": "rewrite", "start": 0, "end": 4}, "NOT_FOUND"),
                       ({"record_id": rec["record_id"], "action": "rewrite", "start": 0, "end": 4, "slot_id": "AI-9"},
                        "INVALID_INPUT")):
        with pytest.raises(AkoweError) as e:
            route(app, "POST", pid, "alongside", body)
        assert e.value.code == code, body
        assert e.value.errors[0].get("fix")  # every refusal carries a plain fix
    outline = BookPath(app.engine, "author", pid, BR).outline()
    with pytest.raises(AkoweError) as e:
        route(app, "POST", pid, "alongside", {"record_id": outline["record_id"], "action": "rewrite", "start": 0,
                                              "end": 4})
    assert "chapters only" in e.value.errors[0]["message"]
    with pytest.raises(AkoweError) as e:
        route(app, "POST", pid, "alongside/use", {"record_id": rec["record_id"], "version": rec["version"],
                                                  "action": "rewrite", "start": 0, "end": 4, "passage": "The ",
                                                  "suggestion": "  "})
    assert e.value.code == "MISSING_INPUT"
    assert fake.prompts.get("alongside") is None  # no AI was asked for any of these


# ====================================================================== AI busy, timeout
def test_a_busy_ai_is_waited_for_then_answers(book):
    app, fake, pid, chs = book
    rec = chs[0]
    i, j = sentence(rec["data"]["text"])
    fake.fail_next(AkoweError("RATE_LIMITED", "", "busy"))
    j1 = wait_job(app, route(app, "POST", pid, "alongside", {"record_id": rec["record_id"], "action": "rewrite",
                                                              "start": i, "end": j})[1])
    assert j1["status"] == "done" and "fail:RATE_LIMITED" in fake.kinds and fake.kinds[-1] == "alongside"


def test_a_site_error_moves_the_suggestion_to_another_working_ai(book):
    app, fake, pid, chs = book
    rec = chs[0]
    i, j = sentence(rec["data"]["text"])
    exc = AkoweError("UPSTREAM_UNAVAILABLE", "", "Claude showed “Something went wrong”")
    exc.site_state, exc.site_problem = "ok", "SITE_ERROR"
    fake.fail_next(exc)
    j1 = wait_job(app, route(app, "POST", pid, "alongside", {"record_id": rec["record_id"], "action": "expand",
                                                              "start": i, "end": j})[1])
    assert j1["status"] == "done" and j1["slot"] == "AI-2"  # the writer (AI-1) was not working: AI-2 answered


def test_an_ai_that_stays_busy_or_times_out_stops_with_a_plain_error_and_changes_nothing(book):
    app, fake, pid, chs = book
    rec = chs[0]
    i, j = sentence(rec["data"]["text"])
    body = {"record_id": rec["record_id"], "action": "rewrite", "start": i, "end": j, "slot_id": "AI-1"}
    app.assist.retry_busy = False  # (the waiting itself is the test above)
    fake.fail_next(*[AkoweError("RATE_LIMITED", "", "AI-1 is busy with another request") for _ in range(3)])
    j1 = wait_job(app, route(app, "POST", pid, "alongside", body)[1])
    assert j1["status"] == "error" and j1["error"]["code"] == "RATE_LIMITED" and j1["results"] == []
    assert not (app.jobstore.get(j1["job_id"]) or {}).get("resume")  # asked again, never "resumed" after a restart
    app.assist.retry_busy = True
    n = len(fake.calls)
    fake.fail_next(AkoweError("TIMEOUT", "", "the claude web session did not answer in time"))
    j2 = wait_job(app, route(app, "POST", pid, "alongside", dict(body, note="again"))[1])
    assert j2["status"] == "error" and j2["error"]["code"] == "TIMEOUT"
    assert len(fake.calls) == n + 1  # a timeout is never retried by itself (the answer may still come)
    assert app.review._head(pid, BR, rec["record_id"])["version"] == rec["version"]
    # 🔁 Try again works
    j3 = wait_job(app, route(app, "POST", pid, "alongside", dict(body, note="once more"))[1])
    assert j3["status"] == "done"


def test_an_empty_answer_is_an_error_not_a_suggestion(book):
    app, fake, pid, chs = book
    rec = chs[0]
    i, j = sentence(rec["data"]["text"])
    fake.alongside_script = [{"text": rec["data"]["text"][i:j]}]
    j1 = wait_job(app, route(app, "POST", pid, "alongside", {"record_id": rec["record_id"], "action": "rewrite",
                                                              "start": i, "end": j})[1])
    assert j1["status"] == "error" and "same words" in j1["error"]["message"]


# ====================================================================== quick local checks ⚠️
def test_local_checks_flag_a_pov_or_tense_slip_and_a_locked_detail(book):
    app, fake, pid, chs = book
    rec = chs[0]
    i, j = sentence(rec["data"]["text"])
    fake.alongside_script = [
        {"text": "I climb the steps and I hold my lantern high. I am cold, and the door is open. I see the lens."},
        {"text": "Mara climbed the steps, her blue eyes wide in the dark, and the lamp room was cold."}]
    body = {"record_id": rec["record_id"], "action": "rewrite", "start": i, "end": j}
    r1 = wait_job(app, route(app, "POST", pid, "alongside", body)[1])["results"][0]
    codes = {n["code"] for n in r1["notes"]}
    assert codes == {"POV_SLIP", "TENSE_SLIP"}
    assert any("first person" in n["message"] and "third person" in n["message"] for n in r1["notes"])
    r2 = wait_job(app, route(app, "POST", pid, "alongside", dict(body, note="x"))[1])["results"][0]
    locked = [n for n in r2["notes"] if n["code"] == "LOCKED_DETAIL"]
    assert locked and "Mara" in locked[0]["message"] and "blue eyes" in locked[0]["message"] \
        and "storm-grey" in locked[0]["message"]
    assert not [n for n in r2["notes"] if n["code"] in ("POV_SLIP", "TENSE_SLIP")]
