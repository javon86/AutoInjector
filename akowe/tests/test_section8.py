"""Section 8 of the improvement plan: P36 (a tougher, calibrated AI editor) and P37.5 (a clear "ChatGPT isn't working —
here's why and how to fix it" before a run starts and while it runs).

P36: the trust check (a 9/10 needs a quoted proof, a near-perfect review needs 3 quoted problems), the strict re-ask,
caps and pattern notes for a review that stays unproven, two editors (the lower score counts), each AI's leniency
over time (settings ``reviewer_leniency``) and its discount, the new trade / logic / timeline dimensions, the settings,
the HTTP endpoint and the book report. P37.5: friendly words for every bridge state and classifier code, GET/POST
/api/ai-check, "Start without it" in a run (roles reassigned, said explicitly), and visible notices for AIs that do not
work at the start or stop working during a run. Everything runs on the deterministic fake AI (no network).
"""
from __future__ import annotations

import json

import pytest

from akowe import ai_check
from akowe import calibration as cal
from akowe import editor as ed_mod
from akowe import editor_rubric as rubric
from akowe import prose_audit

from autobook_fake import CHAPTER_TEXT
from test_editor import chapter_book, outbox, wait_job
from test_failover_review import SlotFake, make_app, no_provider_sleep, run_book  # noqa: F401
from test_server import TOKEN, call  # noqa: F401

CH2 = "\n\n".join(CHAPTER_TEXT[2])
Q1 = "Down in the harbor the fishing boats knocked together like restless teeth."
Q2 = "Only old Nessa at the net sheds would talk, and only in a whisper"
Q3 = "the keeper had gone out to the reef with a stranger"
Q4 = "Mara asked every captain about the night the light went dark"


def craft_of(scores, findings=(), keep=(), text=CH2):
    dims = list(scores)
    return ed_mod.clean_craft({"scores": scores, "findings": list(findings), "keep": list(keep)}, dims, text, "normal")


def finding(i, passage, sev="minor", dim="subtext"):
    return {"id": f"f{i}", "dimension": dim, "severity": sev, "passage": passage, "why": "w", "suggestion": "s",
            "keep_nearby": []}


# ====================================================================== P36 pure rules
def test_rubric_has_trade_logic_and_timeline_checks_and_asks_for_proof():
    dims = rubric.dimensions_for("C02")
    assert {"trade_terms", "cause_effect", "timeline"} <= set(dims)
    assert "cause_effect" in rubric.dimensions_for("B03") and "timeline" in rubric.dimensions_for("B11")
    task = rubric.task_text("C02", dims)
    assert "score_evidence" in task and "at least 3 concrete problems" in task and "weakest" in task
    assert "wick-key" in rubric.QUESTIONS["trade_terms"]
    sch = ed_mod._schema(dims)
    assert "weakest" in sch["properties"] and "score_evidence" in sch["properties"]
    assert "weakest" not in sch["required"]  # optional: older answers stay valid


def test_assess_distrusts_unproven_perfect_scores():
    dims = ["subtext", "prose_variety", "tension_stakes"]
    # Gemini in book 2: 10/10 everywhere, no findings, no evidence
    raw = {"scores": {d: 10 for d in dims}, "findings": [], "keep": []}
    c = ed_mod.clean_craft(raw, dims, CH2, "normal")
    a = cal.assess(raw, c, CH2)
    assert not a["trusted"] and a["too_clean"] and a["unjustified"] == sorted(dims)
    assert any("without a quoted proof" in r for r in a["reasons"])
    # proof for every 9/10 (curly quotes and extra spaces do not matter) + 3 quoted problems + a weakest passage
    raw = {"scores": {d: 9 for d in dims},
           "findings": [finding(1, Q1), finding(2, Q2), finding(3, Q4)],
           "weakest": [{"passage": Q3, "why": "flat"}],
           "score_evidence": [{"dimension": d, "quote": "“" + Q1.replace(" ", "  ") + "”"} for d in dims]}
    c = ed_mod.clean_craft(raw, dims, CH2, "normal")
    a = cal.assess(raw, c, CH2)
    assert a["trusted"], a["reasons"]
    assert a["findings_quoted"] == 3 and a["weakest"][0]["found"]
    # a quote that is not in the chapter proves nothing
    raw["score_evidence"] = [{"dimension": "subtext", "quote": "a sentence the editor made up entirely"}]
    a = cal.assess(raw, ed_mod.clean_craft(raw, dims, CH2, "normal"), CH2)
    assert set(a["unjustified"]) == set(dims)
    # honest 7-8s with few notes are trusted (not near-perfect)
    raw = {"scores": {d: 8 for d in dims}, "findings": []}
    assert cal.assess(raw, ed_mod.clean_craft(raw, dims, CH2, "normal"), CH2)["trusted"]


def test_caps_merge_discount_and_pattern_notes():
    a = {"unjustified": ["subtext"], "too_clean": False}
    scores, changed = cal.apply_caps({"subtext": 10, "prose_variety": 9, "tension_stakes": 5}, a)
    assert scores == {"subtext": 7, "prose_variety": 9, "tension_stakes": 5} and changed == {"subtext": [10, 7]}
    scores, _ = cal.apply_caps({"subtext": 10, "prose_variety": 9, "tension_stakes": 5}, {"too_clean": True})
    assert scores == {"subtext": 7, "prose_variety": 7, "tension_stakes": 5}
    m = cal.merge([{"scores": {"a": 10, "b": 6}, "findings": [finding(1, Q1)], "keep": ["k1"]},
                   {"scores": {"a": 7, "b": 8, "c": 5}, "findings": [finding(1, Q1), finding(1, Q2, "major")],
                    "keep": ["k1", "k2"]}])
    assert m["scores"] == {"a": 7, "b": 6, "c": 5}
    assert [f["passage"] for f in m["findings"]] == [Q2, Q1]  # duplicates removed, major first
    assert len({f["id"] for f in m["findings"]}) == 2 and m["keep"] == ["k1", "k2"]
    assert cal.discounted({"a": 8, "b": 1}, 2) == {"a": 6, "b": 1}
    assert cal.pair_gap({"a": 10, "b": 10}, {"a": 7, "b": 8, "z": 1}) == 2.5
    # leniency needs MIN_OBS observations; floor(leniency), at most MAX_DISCOUNT
    assert cal.discount_of({"other_n": 2, "other_sum": 6}) == 0
    assert cal.discount_of({"other_n": 3, "other_sum": 4.5}) == 1
    assert cal.discount_of({"other_n": 3, "other_sum": 30}) == 2
    assert cal.discount_of({"other_n": 2, "other_sum": -3, "audit_n": 2, "audit_sum": 0}) == 0
    # Akọwe's own pattern notes for a flagged review with nothing to rewrite
    text = ("She went very still. He went very still. They went very still and waited. " * 6 + "\n\n") * 3
    rep = prose_audit.audit(text)
    notes = cal.audit_findings(rep, text, ["prose_variety", "subtext"])
    assert notes and notes[0]["passage"] in text and notes[0]["source"] == "pattern_check"
    ceil = cal.audit_ceilings(rep)
    assert ceil.get("prose_variety") in (6, 8)
    gap, over = cal.audit_gap({"prose_variety": 10}, ceil)
    assert gap and over == ["prose_variety"]


def test_leniency_record_and_table(tmp_path):
    from akowe.store import Store
    st = Store(tmp_path / "d")
    for _ in range(3):
        cal.record(st, "gemini", "Gemini", vs_other=2.0, vs_audit=1.0, flagged=True)
        cal.record(st, "chatgpt", "ChatGPT", vs_other=-2.0)
    rows = {r["family"]: r for r in cal.table(st)}
    assert rows["gemini"]["leniency"] == 1.5 and rows["gemini"]["discount"] == 1 and rows["gemini"]["flagged"] == 3
    assert rows["gemini"]["words"] == "too generous" and rows["chatgpt"]["words"] == "stricter than the others"
    assert rows["chatgpt"]["discount"] == 0 and cal.discount_for(st, "gemini") == 1
    assert cal.table(st)[0]["family"] == "gemini"  # most lenient first
    stored = json.dumps(st.get_setting(cal.KEY))
    assert "Mara" not in stored  # numbers only


# ====================================================================== P36 in the editor
def perfect(dims, findings=(), evidence=False):
    out = {"scores": {d: 10 for d in dims}, "findings": list(findings), "keep": [], "verdict": "PASS"}
    if evidence:
        out["score_evidence"] = [{"dimension": d, "quote": Q1} for d in dims]
    return out


def scripted(fake, answers):
    """fake._craft answers from a list of callables(dims) -> answer, one per editor call."""
    calls = []

    def craft(ctx, dims):
        calls.append(ctx)
        return answers.pop(0)(dims) if answers else {"scores": {d: 8 for d in dims}, "findings": [], "keep": [],
                                                      "verdict": "PASS"}
    fake._craft = craft
    return calls


def test_too_clean_review_is_reasked_then_capped_and_cannot_pass(tmp_path):
    fake = SlotFake()
    app, pid, rid, ver, _ch = chapter_book(tmp_path, fake)
    prompts_before = len(fake.prompts.get("craft", []))
    scripted(fake, [lambda d: perfect(d), lambda d: perfect(d, [finding(1, Q4, "minor", d[0])])])
    j = wait_job(app, app.review.start_editor("author", pid, "main", {"record_id": rid}))
    assert j["status"] == "done", j
    craft = j["results"][0]["craft"]
    c = craft["calibration"]
    assert c["flagged"] and c["reasked"] == 1 and not c["two_reviewers"]
    # asked once more with the stricter prompt, to the same AI
    sys2, _ctx = fake.prompts["craft"][-1]
    assert len(fake.prompts["craft"]) - prompts_before == 2 and "was not accepted by Akọwe" in sys2
    assert [s for s, k in fake.per_slot if k == "craft"][-2:] == ["AI-2", "AI-2"]
    # unproven 10s count as 7; with a note to work on the verdict is REVISE (never a silent PASS)
    assert max(craft["scores"].values()) <= cal.CAP and craft["verdict"] == "REVISE"
    assert any("too clean to trust" in w for w in craft["verdict_why"])
    r0 = craft["reviewers"][0]
    assert r0["flagged"] and r0["reasked"] and r0["scores"]["subtext"] == 10 and r0["adjusted"]["subtext"] == 7
    assert any("asked once more" in n for n in c["notes"]) and any("⚠️" in n for n in c["notes"])
    ev = outbox(app, pid, "editor.craft_review")[-1]
    assert ev["flagged"] is True and ev["reasked"] == 1 and Q4 not in json.dumps(ev)
    lv = {r["family"]: r for r in cal.table(app.store)}
    assert lv["chatgpt"]["flagged"] == 1 and lv["chatgpt"]["reasked"] == 1
    assert ed_mod.EditorService.summary(craft)["flagged"] is True


def test_reask_that_brings_proof_is_used(tmp_path):
    fake = SlotFake()
    app, pid, rid, _ver, _ch = chapter_book(tmp_path, fake)
    honest = lambda d: {"scores": {x: 7 for x in d}, "findings": [finding(1, Q1, "minor", d[0]),  # noqa: E731
                                                                  finding(2, Q2, "minor", d[0]),
                                                                  finding(3, Q4, "minor", d[0])], "keep": [],
                        "verdict": "PASS"}
    scripted(fake, [lambda d: perfect(d), honest])
    craft = wait_job(app, app.review.start_editor("author", pid, "main", {"record_id": rid}))["results"][0]["craft"]
    assert craft["calibration"]["reasked"] == 1 and not craft["calibration"]["flagged"]
    assert craft["scores"] == {d: 7 for d in craft["dimensions"]} and craft["verdict"] == "PASS"
    assert craft["counts"]["minor"] == 3


def test_flagged_review_without_notes_gets_pattern_notes(tmp_path):
    fake = SlotFake()
    app, pid, rid, ver, _ch = chapter_book(tmp_path, fake)
    # a chapter full of tics, so Akọwe's own pattern check has notes
    from akowe.book_path import BookPath
    bp = BookPath(app.engine, "author", pid, "main")
    head = app.review._head(pid, "main", rid)
    tic = ("She went very still. He went very still. They waited for a long moment and went very still. " * 5)
    data = dict(head["data"], text=head["data"]["text"] + "\n\n" + tic + "\n\n" + tic)
    resp = bp.dispatch("C02", "UPDATE", base_ref=head["ref"], payload=data)
    new = resp["output_refs"][0]
    app.review._put(f"ai_fixes:{pid}:main", f"{rid}:{new['version']}", {"slot": "AI-1", "at": "x"})
    scripted(fake, [lambda d: perfect(d), lambda d: perfect(d)])
    craft = wait_job(app, app.review.start_editor("author", pid, "main", {"record_id": rid}))["results"][0]["craft"]
    assert craft["calibration"]["flagged"] and craft["calibration"]["pattern_notes_added"] >= 1
    assert craft["verdict"] == "REVISE" and all(f.get("source") == "pattern_check" for f in craft["findings"])
    assert all(f["passage"] in data["text"] for f in craft["findings"])


def test_two_editors_lower_score_counts_and_leniency_is_tracked(tmp_path):
    fake = SlotFake()
    app, pid, rid, _ver, _ch = chapter_book(tmp_path, fake, slots=("AI-1", "AI-2", "AI-3"))
    proven = lambda d: dict(perfect(d, [finding(1, Q1, "minor", d[0]), finding(2, Q2, "minor", d[0]),  # noqa: E731
                                        finding(3, Q4, "minor", d[0])], evidence=True),
                            weakest=[{"passage": Q3, "why": "flat"}])
    strict = lambda d: {"scores": {x: 6 for x in d}, "findings": [finding(1, Q1, "major", d[0])],  # noqa: E731
                        "keep": [], "verdict": "REVISE"}
    scripted(fake, [proven, strict])
    craft = wait_job(app, app.review.start_editor("author", pid, "main", {"record_id": rid}))["results"][0]["craft"]
    revs = craft["reviewers"]
    assert len(revs) == 2 and {r["slot"] for r in revs} == {"AI-2", "AI-3"} and "AI-1" not in [r["slot"] for r in revs]
    assert craft["calibration"]["two_reviewers"] and not craft["calibration"]["flagged"]
    assert set(craft["scores"].values()) == {6}  # the lower score per dimension
    # the same passage from both editors is one note; the stricter (major) one first
    assert craft["counts"]["major"] == 1 and len([f for f in craft["findings"] if f["passage"] == Q1]) == 1
    assert craft["verdict"] == "REVISE" and " + " in craft["reviewer"] and craft["independent"]
    first, second = revs[0]["family"], revs[1]["family"]
    raw = app.store.get_setting(cal.KEY)
    assert raw[first]["recent"][-1]["vs_other"] == 4.0 and raw[second]["recent"][-1]["vs_other"] == -4.0
    lv = {r["family"]: r for r in cal.table(app.store)}
    assert lv[first]["leniency"] > lv[second]["leniency"]
    # GET /api/reviewer-leniency shows the same, numbers only
    st, body = app._route("GET", ["reviewer-leniency"], "/reviewer-leniency", {}, None, "author", {})
    assert st == 200 and body["ais"][0]["family"] == first and body["rules"]["cap"] == cal.CAP


def test_lenient_ai_is_discounted_and_settings(tmp_path):
    fake = SlotFake()
    app, pid, rid, _ver, _ch = chapter_book(tmp_path, fake, slots=("AI-1", "AI-2", "AI-3"))
    app.store.set_setting(cal.KEY, {"chatgpt": {"name": "ChatGPT", "reviews": 3, "other_n": 3, "other_sum": 6.0}})
    app.review.editor.save_settings({"two_reviewers": False})
    assert app.review.editor.settings()["two_reviewers"] is False
    craft = wait_job(app, app.review.start_editor("author", pid, "main", {"record_id": rid}))["results"][0]["craft"]
    assert len(craft["reviewers"]) == 1 and craft["reviewers"][0]["family"] == "chatgpt"
    assert craft["reviewers"][0]["discount"] == 2 and set(craft["scores"].values()) == {6}  # 8 - 2
    assert any("lowered by 2" in n for n in craft["calibration"]["notes"])
    with pytest.raises(Exception):
        app.review.editor.save_settings({"two_reviewers": "yes"})
    # an AI the author picked for this review stays the only editor, even with two_reviewers on
    app.review.editor.save_settings({"two_reviewers": True})
    craft = wait_job(app, app.review.start_editor("author", pid, "main", {"record_id": rid, "slot_id": "AI-3"}))[
        "results"][0]["craft"]
    assert [r["slot"] for r in craft["reviewers"]] == ["AI-3"]


def test_make_a_book_with_two_editors_and_book_report_leniency(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    crafts = list(app.review.editor.crafts(run["project_id"], "main").values())
    assert crafts and all(len(c["reviewers"]) == 2 for c in crafts)
    assert all("AI-1" not in [r["slot"] for r in c["reviewers"]] for c in crafts)  # never the writer
    ov = app.reports.overview("author", run["project_id"], "main")
    assert ov["leniency"] and ov["calibration"]
    # the run's whole-book review fed the leniency too (vs the median of the other reviewers)
    rep = ov["latest"]
    assert rep and rep["aggregate"]["reviewers"] >= 2
    assert any(x["where"] == "book_report" for e in app.store.get_setting(cal.KEY).values() for x in e["recent"])


# ====================================================================== P37.5 plain words
@pytest.mark.parametrize("code,needle", [("LOGGED_OUT", "log in"), ("CAPTCHA", "complete the check"),
                                         ("USAGE_LIMIT", "usage limit"), ("NETWORK_ERROR", "internet"),
                                         ("NO_REPLY_FOUND", "🔢 Fix with a number"), ("TYPE_FAILED", "🎯")])
def test_describe_turns_codes_into_plain_words(code, needle):
    d = ai_check.describe({"slot_id": "AI-2", "adapter_id": "autoinjector", "site": "chatgpt", "state": "needs_user",
                           "problem": code, "source": "bridge"})
    assert not d["ok"] and d["ai"] == "ChatGPT" and "ChatGPT" in d["title"]
    assert needle in (d["what"] + " " + " ".join(d["fix"]))


def test_describe_states_and_sources():
    base = {"slot_id": "AI-3", "adapter_id": "autoinjector", "site": "gemini", "problem": None}
    assert "repairing" in ai_check.describe(dict(base, state="repairing", source="bridge"))["what"]
    assert "needs you" in ai_check.describe(dict(base, state="needs_user", source="bridge"))["what"]
    assert "🔢" in " ".join(ai_check.describe(dict(base, state="broken", source="bridge"))["fix"])
    assert "Start the AutoInjector" in " ".join(ai_check.describe(dict(base, state="unknown",
                                                                       source="bridge_error"))["fix"])
    assert "not connected" in ai_check.describe(dict(base, state="unknown", source="not_connected"))["what"]
    assert ai_check.describe(dict(base, state="unknown", source="bridge_v1"))["ok"]  # an older bridge
    assert ai_check.describe(dict(base, state="ok", source="bridge"))["ok"]
    note = ai_check.start_note(["ChatGPT"], ["Claude", "Gemini"])
    assert "Claude and Gemini do all the work" in note and "uses it again" in note
    assert "reviews its own writing" in ai_check.start_note(["ChatGPT", "Gemini"], ["Claude"])
    assert ai_check.clean_choice({"skipped": ["AI-2", "AI-9", 5]}, ["AI-1", "AI-2", "AI-3"]) == \
        {"skipped": ["AI-2"], "checked": True}
    assert ai_check.clean_choice("x", ["AI-1"]) is None


def test_alert_rows_new_and_back():
    rows = [{"slot_id": "AI-2", "name": "AI-2 · ChatGPT", "state": "needs_user", "problem": "LOGGED_OUT"},
            {"slot_id": "AI-1", "name": "AI-1 · Claude", "state": "ok"}]
    now, new, back = ai_check.alert_rows(rows, [], {"AI-2"})
    assert [a["slot_id"] for a in now] == ["AI-2"] and new == now and not back
    assert now[0]["ai"] == "ChatGPT" and now[0]["chosen"] and "logged out" in now[0]["what"]
    now2, new2, back2 = ai_check.alert_rows([dict(rows[0], state="ok"), rows[1]], now)
    assert not now2 and not new2 and [a["slot_id"] for a in back2] == ["AI-2"]


# ====================================================================== P37.5 GET/POST /api/ai-check
@pytest.fixture
def served_fake(tmp_path):
    from http.server import ThreadingHTTPServer
    import threading
    from akowe.server import make_handler
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield app, fake, httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


def test_ai_check_endpoint_explains_and_rechecks(served_fake):
    app, fake, port = served_fake
    st, out, _ = call(port, "GET", "/api/ai-check")
    assert st == 200 and out["ok"] and out["working"] == ["Claude", "ChatGPT", "Gemini"]
    fake.states["AI-2"], fake.problems["AI-2"] = "needs_user", "LOGGED_OUT"
    st, out, _ = call(port, "GET", "/api/ai-check?slot_id=AI-2")
    assert st == 200 and not out["ok"] and out["not_working"] == ["ChatGPT"] and out["pinned_ok"] is False
    row = next(a for a in out["ais"] if a["slot_id"] == "AI-2")
    assert row["title"].startswith("ChatGPT isn't working") and "logged out" in row["what"]
    assert any("log in" in f for f in row["fix"])
    assert "Claude and Gemini do all the work" in out["if_skipped"] and "Automatic" in out["if_skipped"]
    # 🔁 I fixed it — check again: AutoInjector checks in first (probe), then the answer is fresh
    fake.after_probe = {"AI-2": "ok"}
    st, out, _ = call(port, "POST", "/api/ai-check", {"probe": True})
    assert st == 200 and out["ok"] and out["probed"] and fake.probes
    st, out, _ = call(port, "POST", "/api/ai-check", {"probe": "yes"})
    assert st == 400
    # none working: a plain message, nothing to start without
    for s in ("AI-1", "AI-2", "AI-3"):
        fake.states[s] = "broken"
    st, out, _ = call(port, "GET", "/api/ai-check")
    assert not out["any_working"] and "None of your AIs works" in out["message"]


# ====================================================================== P37.5 inside a run
def codes(run):
    return [e.get("code") for e in run["events"]]


def test_start_without_it_reassigns_roles_and_says_so(tmp_path):
    fake = SlotFake()
    fake.states["AI-2"], fake.problems["AI-2"] = "needs_user", "LOGGED_OUT"
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-2", "ai_check": {"skipped": ["AI-2"]}})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    assert run["settings"]["slot_id"] is None and run["settings"]["ai_check"]["skipped"] == ["AI-2"]
    notes = [e["message"] for e in run["events"] if e.get("code") == "AI_SKIPPED"]
    assert any("You chose to start without ChatGPT" in m and "Claude and Gemini do all the work" in m for m in notes)
    assert any("uses Automatic" in m for m in notes)
    assert "AI_NOT_READY" not in codes(run)  # the author already decided: no second alarm
    assert [a["slot_id"] for a in run["ai_alerts"]] == ["AI-2"] and run["ai_alerts"][0]["chosen"]
    assert all(s != "AI-2" for s, k in fake.per_slot if k != "fail")


def test_an_ai_not_working_at_the_start_is_never_silent(tmp_path):
    fake = SlotFake()
    fake.states["AI-3"], fake.problems["AI-3"] = "broken", "NO_REPLY_FOUND"
    fake.after_probe = {"AI-3": "broken"}
    app = make_app(tmp_path, fake)
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    ev = next(e for e in run["events"] if e.get("code") == "AI_NOT_READY")
    assert "Gemini" in ev["message"] and "can't find its replies" in ev["message"] and "🔢" in ev["message"]
    assert "goes to Claude and ChatGPT" in ev["message"]
    a = run["ai_alerts"][0]
    assert a["slot_id"] == "AI-3" and not a["chosen"] and a["takes_over"] == ["Claude", "ChatGPT"]


def test_an_ai_that_breaks_mid_run_gets_a_visible_notice_and_comes_back(tmp_path):
    fake = SlotFake()
    fake.problems["AI-2"] = "USAGE_LIMIT"
    fake.schedule = {5: {"AI-2": "needs_user"}, 30: {"AI-2": "ok"}}
    app = make_app(tmp_path, fake)
    run = run_book(app)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    stopped = [e for e in run["events"] if e.get("code") == "AI_STOPPED"]
    assert stopped and "ChatGPT" in stopped[0]["message"] and "usage limit" in stopped[0]["message"]
    assert "during the run" in stopped[0]["message"]
    assert "AI_BACK" in codes(run) and not run.get("ai_alerts")  # cleared once it works again
