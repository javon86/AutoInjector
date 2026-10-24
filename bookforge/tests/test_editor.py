"""🖋 The AI editor: craft review (P4) and targeted rewrites (P5), with the pattern checker (P6) feeding it.

Unit tests for the pure parts (clean_craft, decide, apply_replacements, judge_rewrite), the editor ≠ writer choice,
storage as advice per record+version, the manual flow outside runs (review -> fixes -> accept/reject per passage ->
new draft), the Make-a-book flow with the deterministic fake editor (rewrite kept, rewrite not kept after a score
drop / a consistency REVISE, rounds used up -> ⚠️ "editor still had notes", editor failing never blocks the book),
the settings and the HTTP endpoints."""
from __future__ import annotations

import json

import pytest

from bookforge import editor as ed_mod
from bookforge import journal
from bookforge.book_path import BookPath
from bookforge.errors import BookforgeError
from bookforge.review import ReviewJob

from autobook_fake import CHAPTER_TEXT
from test_failover_review import SlotFake, make_app, no_provider_sleep, run_book  # noqa: F401
from test_server import call  # noqa: F401

PHRASE = "every captain looked away"
BETTER = "every captain found a net that needed mending"
CH2 = "\n\n".join(CHAPTER_TEXT[2])
FLAGGED = "Mara asked every captain about the night the light went dark, and every captain looked away."
DIMS = ["subtext", "character_agency", "voice_distinction", "world_friction", "theme_restraint", "prose_variety",
        "tension_stakes", "protected_mysteries"]


def outbox(app, pid, et):
    return [json.loads(r["payload"]) for r in app.store.query(
        "SELECT payload FROM outbox WHERE project_id=? AND event_type=? ORDER BY rowid", (pid, et))]


def steps(run):
    return {s["id"]: s for s in run["steps"]}


# ====================================================================== pure helpers
def test_clean_craft_normalises_and_decides():
    raw = {"scores": {"subtext": 4, "character_agency": 11, "voice_distinction": 0.4, "bogus": 3, "world_friction": "x"},
           "findings": [{"id": "f1", "dimension": "subtext", "severity": "major", "passage": FLAGGED, "why": "told",
                         "suggestion": "show", "keep_nearby": ["Only old Nessa", 5]},
                        {"id": "f1", "dimension": "nope", "severity": "weird", "passage": "not in the text", "why": "x",
                         "suggestion": "y"},
                        {"passage": "", "why": ""}, "junk"],
           "keep": ["Only old Nessa at the net sheds would talk", "", 7], "verdict": "PASS"}
    c = ed_mod.clean_craft(raw, DIMS, CH2, "normal")
    assert c["scores"] == {"subtext": 4, "character_agency": 10, "voice_distinction": 1}
    assert c["missing_scores"] and "world_friction" in c["missing_scores"]
    assert [f["id"] for f in c["findings"]] == ["f1", "f1x"]
    f1, f2 = c["findings"]
    assert f1["found"] and f1["label"] == "Subtext" and f1["keep_nearby"] == ["Only old Nessa"]
    assert f2["dimension"] == "other" and f2["severity"] == "minor" and not f2["found"]
    assert c["keep"] == ["Only old Nessa at the net sheds would talk"] and c["keep_quotes"] == c["keep"]
    # BookForge decides, not the AI: a major finding and low scores mean REVISE although the AI said PASS
    assert c["verdict"] == "REVISE" and c["ai_verdict"] == "PASS" and c["counts"] == {"major": 1, "minor": 1}
    assert c["min_score"] == 1
    for bad in (None, {}, {"scores": {}}, {"scores": {"bogus": 5}}, {"scores": "8"}):
        with pytest.raises(BookforgeError) as e:
            ed_mod.clean_craft(bad, DIMS, CH2, "normal")
        assert e.value.code == "INTERNAL_ERROR"


def test_strictness_thresholds():
    s8 = {d: 8 for d in DIMS}
    minor = [{"severity": "minor"}] * 3
    assert ed_mod.decide(s8, [], "normal")[0] == "PASS"
    assert ed_mod.decide(dict(s8, subtext=5), [], "normal")[0] == "REVISE"
    assert ed_mod.decide(dict(s8, subtext=5), [], "gentle")[0] == "PASS"
    assert ed_mod.decide(dict(s8, subtext=6), [], "strict")[0] == "REVISE"
    assert ed_mod.decide(s8, [{"severity": "major"}], "gentle")[0] == "PASS"
    assert ed_mod.decide(s8, [{"severity": "major"}] * 2, "gentle")[0] == "REVISE"
    assert ed_mod.decide(s8, [{"severity": "major"}], "normal")[0] == "REVISE"
    assert ed_mod.decide(s8, minor, "normal")[0] == "PASS"
    verdict, why = ed_mod.decide(s8, minor, "strict")
    assert verdict == "REVISE" and "3 minor" in why[0]


def test_apply_replacements_exact_match_only():
    findings = [{"id": "f1", "passage": FLAGGED}, {"id": "f2", "passage": "Only old Nessa at the net sheds would talk"},
                {"id": "f3", "passage": "restless teeth"}]
    keep = ["the keeper had gone out to the reef with a stranger"]
    reps = [{"finding_id": "f1", "original": FLAGGED, "replacement": FLAGGED.replace(PHRASE, BETTER)},
            {"finding_id": "f2", "original": "Only old Nessa at the net sheds WOULD talk", "replacement": "x"},
            {"finding_id": "zz", "original": "Down in the harbor", "replacement": "Up"}]
    out = ed_mod.apply_replacements(CH2, reps, findings, keep)
    assert BETTER in out["text"] and PHRASE not in out["text"]
    assert out["text"].replace(FLAGGED.replace(PHRASE, BETTER), FLAGGED) == CH2  # nothing else changed
    assert [a["finding_id"] for a in out["applied"]] == ["f1"]
    reasons = {u["finding_id"]: u["reason"] for u in out["unresolved"]}
    assert reasons == {"f2": "NOT_FOUND", "f3": "NO_REPLACEMENT"}  # never guessed; "zz" was not asked for
    # ambiguous originals, unchanged text, a change elsewhere, too long, and dropping a keep quote are refused
    text = "He waited. He waited. The tide turned. " + CH2
    f = [{"id": "a", "passage": "He waited."}]
    assert ed_mod.apply_replacements(text, [{"finding_id": "a", "original": "He waited.", "replacement": "Hm."}], f,
                                     [])["unresolved"][0]["reason"] == "AMBIGUOUS"
    f = [{"id": "a", "passage": "The tide turned."}]
    assert ed_mod.apply_replacements(text, [{"finding_id": "a", "original": "The tide turned.",
                                             "replacement": "The tide turned. "}], f, [])["unresolved"][0]["reason"] \
        == "NO_CHANGE"
    assert ed_mod.apply_replacements(text, [{"finding_id": "a", "original": "Down in the harbor",
                                             "replacement": "Up"}], f, [])["unresolved"][0]["reason"] == "NOT_AT_PASSAGE"
    long_text = "The tide turned. " + "The rope creaked on the bollard. " * 30
    assert ed_mod.apply_replacements(long_text, [{"finding_id": "a", "original": long_text,
                                                  "replacement": "x"}], f, [])["unresolved"][0]["reason"] == "TOO_LONG"
    f = [{"id": "k", "passage": "Only old Nessa at the net sheds would talk"}]
    orig = "Only old Nessa at the net sheds would talk, and only in a whisper: the keeper had gone out to the reef " \
           "with a stranger"
    assert ed_mod.apply_replacements(CH2, [{"finding_id": "k", "original": orig, "replacement": "Nessa talked."}], f,
                                     keep)["unresolved"][0]["reason"] == "KEEP_LOST"


def test_judge_rewrite_accepts_only_when_nothing_got_worse():
    old = {"scores": {"subtext": 4, "prose_variety": 7}, "avg_score": 5.5, "counts": {"major": 1, "minor": 0}}
    good = {"scores": {"subtext": 7, "prose_variety": 7}, "avg_score": 7.0, "counts": {"major": 0, "minor": 0}}
    applied = [{"finding_id": "f1", "passage": FLAGGED}]
    kw = dict(consistency="APPROVE", checks_ok=True, keep_lost=[], applied=applied, new_text="new text")
    assert ed_mod.judge_rewrite(old, good, **kw)[:2] == (True, "KEPT")
    drop = {"scores": {"subtext": 7, "prose_variety": 5}, "avg_score": 6.0, "counts": {"major": 0, "minor": 0}}
    assert ed_mod.judge_rewrite(old, drop, **kw)[:2] == (False, "SCORE_DROP")
    lower_avg = {"scores": {"subtext": 4, "prose_variety": 6}, "avg_score": 5.0, "counts": {"major": 0, "minor": 0}}
    assert ed_mod.judge_rewrite(old, lower_avg, **kw)[1] == "SCORE_DROP"
    assert ed_mod.judge_rewrite(old, good, **dict(kw, keep_lost=["a kept line"]))[1] == "KEEP_LOST"
    assert ed_mod.judge_rewrite(old, good, **dict(kw, consistency="REVISE"))[1] == "CONSISTENCY"
    assert ed_mod.judge_rewrite(old, good, **dict(kw, checks_ok=False))[1] == "CHECKS_REFUSED"
    assert ed_mod.judge_rewrite(old, None, **kw)[1] == "EDITOR_FAILED"
    assert ed_mod.judge_rewrite(old, good, **dict(kw, new_text="x " + FLAGGED))[1] == "NOT_RESOLVED"
    more = dict(good, counts={"major": 2, "minor": 0})
    assert ed_mod.judge_rewrite(old, more, **kw)[1] == "NEW_PROBLEMS"


# ====================================================================== the editor outside runs
def chapter_book(tmp_path, fake, slots=("AI-1", "AI-2"), editor=None):
    """A finished book (made by a run with the editor off), plus a fresh draft of chapter 2 written by AI-1."""
    app = make_app(tmp_path, fake, slots=slots)
    app.review.editor.save_settings({"enabled": False})
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    if editor:
        app.review.editor.save_settings(editor)
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    ch = bp.outline_chapters(bp.outline())[1]["chapter_id"]
    _ctx, _latest, appr = bp.chapter_prose(bp.outline(), ch)
    # a new draft version of the approved chapter, written "by AI-1" (as an AI fix would be)
    resp = bp.dispatch("C02", "UPDATE", base_ref=appr["ref"], payload=dict(appr["data"]))
    new = resp["output_refs"][0]
    app.review._put(f"ai_fixes:{pid}:main", f"{new['record_id']}:{new['version']}", {"slot": "AI-1", "at": "x"})
    return app, pid, new["record_id"], new["version"], ch


def wait_job(app, job):
    import time
    for _ in range(400):
        j = app.review.get_job("author", job["job_id"])
        if j["status"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_editor_review_is_independent_stored_per_version_and_shown(tmp_path):
    fake = SlotFake()
    fake.editor_flags = {PHRASE: BETTER}
    app, pid, rid, ver, ch = chapter_book(tmp_path, fake)
    j = wait_job(app, app.review.start_editor("author", pid, "main", {"record_id": rid}))
    assert j["status"] == "done", j
    craft = j["results"][0]["craft"]
    assert craft["slot"] == "AI-2" and craft["writer_slot"] == "AI-1" and craft["independent"] is True
    assert craft["verdict"] == "REVISE" and craft["scores"]["subtext"] == 4 and craft["counts"]["major"] == 1
    assert craft["findings"][0]["passage"] == FLAGGED and craft["findings"][0]["found"]
    assert craft["chapter_id"] == ch and "ending_openness" not in craft["scores"]  # not the last chapter
    # the editor got the P6 pattern report, the outline place, the characters and protected facts
    ctx = fake.craft_contexts[-1]
    assert ctx["pattern_report"]["words"] > 20 and ctx["outline"]["chapter_id"] == ch and ctx["outline"]["of"] == 3
    assert "characters" in ctx and "protected_facts" in ctx and ctx["chapter_text"].count(PHRASE) == 1
    stored = app.review.editor.crafts(pid, "main")[f"{rid}:{ver}"]
    assert stored["verdict"] == "REVISE" and stored["version"] == ver
    # shown in the review queue (numbers only), on the record (per version) and in the journal
    item = next(i for i in app.review.queue("author", pid, "main")["items"] if i["record_id"] == rid)
    assert item["craft"]["verdict"] == "REVISE" and item["craft"]["counts"]["major"] == 1 and item["editable"]
    info = app.review.editor_info("author", pid, "main", rid)
    assert info["craft"][str(ver)]["verdict"] == "REVISE" and info["fixable"] and info["pattern"]["words"] > 20
    assert app.review.record_reviews("author", pid, "main", rid)["craft"][str(ver)]["verdict"] == "REVISE"
    ev = outbox(app, pid, "editor.craft_review")[-1]
    assert ev["verdict"] == "REVISE" and ev["independent"] is True and ev["ai_slot"] == "AI-2"
    assert PHRASE not in json.dumps(ev)  # activity events carry numbers, never text
    jr = journal.build(app, pid, "main")
    ent = [e for e in jr["entries"] if e["kind"] == "editor"]
    assert ent and "Editor: REVISE" in ent[-1]["what"] and PHRASE not in json.dumps(jr)


def test_single_ai_editor_is_marked_not_independent(tmp_path):
    fake = SlotFake()
    app, pid, rid, _ver, _ch = chapter_book(tmp_path, fake, slots=("AI-1",))
    craft = wait_job(app, app.review.start_editor("author", pid, "main", {"record_id": rid}))["results"][0]["craft"]
    assert craft["slot"] == "AI-1" and craft["independent"] is False and craft["warning"] == ed_mod.NOT_INDEPENDENT
    assert craft["verdict"] == "PASS"


def test_manual_fixes_accept_and_reject_per_passage(tmp_path):
    fake = SlotFake()
    fake.editor_flags = {PHRASE: BETTER, "only in a whisper": "only with her back to the harbour"}
    app, pid, rid, ver, _ch = chapter_book(tmp_path, fake)
    wait_job(app, app.review.start_editor("author", pid, "main", {"record_id": rid}))
    craft = app.review.editor.crafts(pid, "main")[f"{rid}:{ver}"]
    assert craft["counts"]["major"] == 2
    j = wait_job(app, app.review.start_editor_fix("author", pid, "main", {"record_id": rid}))
    assert j["status"] == "done", j
    prop = j["results"][0]["proposal"]
    assert prop["slot"] == "AI-1" and prop["applied"] == 2  # the WRITER rewrites, not the editor
    by = {i["finding_id"]: i for i in prop["items"]}
    assert all(i["ok"] and i["original"] in CH2 for i in by.values())
    rec_before = app.review._head(pid, "main", rid)
    assert rec_before["version"] == ver  # nothing changed in the book yet
    # the author keeps only the first change
    keep_id = next(i for i, x in by.items() if PHRASE in x["original"])
    out = app.review.apply_editor_fix("author", pid, "main", {"record_id": rid, "version": ver, "accept": [keep_id]})
    assert out["version"] == ver + 1 and len(out["applied"]) == 1
    assert {u["reason"] for u in out["unresolved"]} == {"REJECTED_BY_AUTHOR"}
    new = app.review._head(pid, "main", rid)
    assert BETTER in new["data"]["text"] and "only in a whisper" in new["data"]["text"] and new["lifecycle"] == "DRAFT"
    assert app.review.made_by(pid, "main", new, app.review.fixes(pid, "main"))["label"].startswith("Editor's fixes")
    rw = outbox(app, pid, "editor.rewrite")[-1]
    assert rw["applied"] == 1 and rw["unresolved"] == 1 and rw["how"] == "author" and BETTER not in json.dumps(rw)
    # the old fixes no longer fit the new version: refused, nothing changed
    with pytest.raises(BookforgeError) as e:
        app.review.apply_editor_fix("author", pid, "main", {"record_id": rid, "version": ver, "accept": [keep_id]})
    assert e.value.code == "VERSION_CONFLICT"
    with pytest.raises(BookforgeError) as e:
        app.review.start_editor_fix("author", pid, "main", {"record_id": rid})  # no editor review of v+1 yet
    assert e.value.code == "INVALID_INPUT"


def test_manual_fix_with_unfound_original_is_unresolved_not_guessed(tmp_path):
    fake = SlotFake()
    fake.editor_flags = {PHRASE: BETTER}
    fake.rewrite_script = [{"replacements": [{"finding_id": "f1", "original": FLAGGED.replace("asked", "begged"),
                                              "replacement": "Mara asked."}]}]
    app, pid, rid, ver, _ch = chapter_book(tmp_path, fake)
    wait_job(app, app.review.start_editor("author", pid, "main", {"record_id": rid}))
    prop = wait_job(app, app.review.start_editor_fix("author", pid, "main", {"record_id": rid}))["results"][0]["proposal"]
    assert prop["applied"] == 0 and prop["items"][0]["reason"] == "NOT_FOUND" and not prop["items"][0]["ok"]
    with pytest.raises(BookforgeError) as e:
        app.review.apply_editor_fix("author", pid, "main", {"record_id": rid, "version": ver})
    assert e.value.code == "INVALID_INPUT"
    assert app.review._head(pid, "main", rid)["version"] == ver


# ====================================================================== the editor inside Make-a-book runs
def chapter2_ids(app, run):
    bp = BookPath(app.engine, "author", run["project_id"], "main")
    ch = bp.outline_chapters(bp.outline())[1]["chapter_id"]
    _c, latest, appr = bp.chapter_prose(bp.outline(), ch)
    return bp, ch, latest, appr


def test_make_a_book_with_the_editor_end_to_end(tmp_path):
    fake = SlotFake()
    fake.editor_flags = {PHRASE: BETTER}
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    assert run["editor_settings"] == {"enabled": True, "rounds": 2, "strictness": "normal"}
    bp, ch, latest, appr = chapter2_ids(app, run)
    text = appr["data"]["text"]
    assert BETTER in text and PHRASE not in text  # the rewrite was kept and approved
    es = run["editor_summary"]
    assert es["reviewed"] == 3 and es["passed"] == 3 and es["kept"] == 1 and es["rejected"] == 0 and not es["flagged"]
    items = {i["id"]: i for i in steps(run)["chapters"]["items"]}
    assert items[ch]["editor"]["verdict"] == "PASS" and items[ch]["editor"]["rounds"] == 1
    assert not items[ch]["editor"]["flagged"]
    # the editor is never the writer; the rewrite came from the writer, not the editor
    crafts = [s for s, k in fake.per_slot if k == "craft"]
    rewrites = [s for s, k in fake.per_slot if k == "rewrite"]
    assert set(crafts) == {"AI-2"} and rewrites == ["AI-1"]
    # order for chapter 2: consistency review -> editor (REVISE) -> rewrite -> consistency review -> editor (PASS)
    k = [x for x in fake.kinds if x in ("review", "craft", "rewrite")]
    i = k.index("rewrite")
    assert k[i - 1] == "craft" and k[i + 1] == "review" and k[i + 2] == "craft"
    # last chapter got the ending dimension
    last = app.review.editor.crafts(run["project_id"], "main")
    assert any("ending_openness" in c["scores"] for c in last.values())
    # approvals came after the editor; the journal shows the editor without book text
    appr_ev = [a for a in outbox(app, run["project_id"], "autobook.approved_under_consent") if a["module_id"] == "C02"]
    assert appr_ev and all("editor: PASS" in a["why"] for a in appr_ev)
    rw = outbox(app, run["project_id"], "editor.rewrite")
    assert len(rw) == 1 and rw[0]["how"] == "run" and rw[0]["round"] == 1
    j = journal.build(app, run["project_id"], "main")
    assert any(e["kind"] == "editor" for e in j["entries"]) and BETTER not in json.dumps(j) and PHRASE not in \
        json.dumps(j)
    assert any("Editor: 3 chapter(s) read" in e["message"] for e in run["events"])


def test_rounds_used_up_marks_the_chapter_but_never_blocks_the_book(tmp_path):
    fake = SlotFake()
    fake.editor_flags = {PHRASE: PHRASE + " again"}  # every rewrite still has the phrase: the editor keeps asking
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    app.review.editor.save_settings({"rounds": 1})
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    bp, ch, latest, appr = chapter2_ids(app, run)
    assert appr is not None  # approved under the run consent despite the notes
    es = run["editor_summary"]
    assert es["rounds"] == 1 and [f["label"] for f in es["flagged"]] == [f"chapter {ch}"]
    assert "used up" in es["flagged"][0]["reason"] and es["flagged"][0]["notes"][0]["severity"] == "major"
    item = {i["id"]: i for i in steps(run)["chapters"]["items"]}[ch]
    assert item["editor"]["flagged"] is True
    assert any(e.get("code") == "EDITOR_NOTES" and "still had notes" in e["message"] for e in run["events"])
    j = journal.build(app, run["project_id"], "main", problems_only=True)
    assert any((e.get("problem") or {}).get("code") == "EDITOR_NOTES" for e in j["entries"])


def test_score_drop_keeps_the_earlier_text(tmp_path):
    fake = SlotFake()
    fake.editor_flags = {PHRASE: BETTER}
    plain_craft = fake._craft

    def craft(ctx, dims):
        out = plain_craft(ctx, dims)
        if BETTER in (ctx.get("chapter_text") or ""):  # the editor dislikes the rewrite even more
            out = {"scores": {d: 3 for d in dims}, "findings": [], "keep": [], "verdict": "REVISE"}
        return out
    fake._craft = craft
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    bp, ch, latest, appr = chapter2_ids(app, run)
    assert PHRASE in appr["data"]["text"] and BETTER not in appr["data"]["text"]  # the better (earlier) version
    hist = app.store.history(run["project_id"], "main", appr["record_id"])
    assert [BETTER in h["data"]["text"] for h in hist[-3:]] == [False, True, False]  # old, rewrite, restored
    rej = outbox(app, run["project_id"], "editor.rewrite_rejected")
    assert rej and rej[0]["why"] == "SCORE_DROP"
    es = run["editor_summary"]
    assert es["rejected"] == 1 and es["flagged"] and "not kept" in es["flagged"][0]["reason"]
    # the restored version carries the consistency verdict of the identical earlier text
    rv = app.review.reviews(run["project_id"], "main")[f"{appr['record_id']}:{appr['version']}"]
    assert rv["verdict"] == "APPROVE" and rv["copied_from_version"] == hist[-3]["version"]
    assert "version" in app.review.made_by(run["project_id"], "main", hist[-1], app.review.fixes(
        run["project_id"], "main"))["label"]


def test_consistency_revise_on_the_rewrite_rejects_it(tmp_path):
    fake = SlotFake()
    fake.editor_flags = {PHRASE: BETTER}
    orig = fake._answer

    def answer(ctx, props, schema):
        kind, out = orig(ctx, props, schema)
        if kind == "review" and BETTER in json.dumps(ctx.get("draft") or {}):
            out = dict(out, verdict="REVISE")
        return kind, out
    fake._answer = answer
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    _bp, _ch, _latest, appr = chapter2_ids(app, run)
    assert PHRASE in appr["data"]["text"]
    assert outbox(app, run["project_id"], "editor.rewrite_rejected")[0]["why"] == "CONSISTENCY"


def test_keep_quote_in_the_flagged_stretch_is_never_rewritten(tmp_path):
    fake = SlotFake()
    first = CHAPTER_TEXT[2][0].split(". ")[0] + "."  # "Down in the harbor ... restless teeth." is the keep quote
    fake.editor_flags = {"restless teeth": "loose teeth"}
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done"
    _bp, ch, _latest, appr = chapter2_ids(app, run)
    assert first in appr["data"]["text"] and "loose teeth" not in appr["data"]["text"]
    es = run["editor_summary"]
    assert es["flagged"] and "word for word" in es["flagged"][0]["reason"]
    assert any(e.get("code") == "EDITOR_UNRESOLVED" for e in run["events"])


def test_editor_off_and_rounds_zero_and_editor_failing(tmp_path):
    fake = SlotFake()
    fake.editor_flags = {PHRASE: BETTER}
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    app.review.editor.save_settings({"enabled": False})
    run = run_book(app)
    assert run["status"] == "done" and "craft" not in fake.kinds and not run.get("editor_summary")
    # rounds 0: the editor reads, nobody rewrites, the notes are kept for the author
    fake2 = SlotFake()
    fake2.editor_flags = {PHRASE: BETTER}
    app2 = make_app(tmp_path, fake2, slots=("AI-1", "AI-2"), name="d2")
    app2.review.editor.save_settings({"enabled": True, "rounds": 0})
    run2 = run_book(app2)
    assert run2["status"] == "done" and "craft" in fake2.kinds and "rewrite" not in fake2.kinds
    assert run2["editor_summary"]["flagged"] and "set to 0" in run2["editor_summary"]["flagged"][0]["reason"]
    # the editor's AI fails: the book is still made, with a ⚠️ note
    fake3 = SlotFake()
    fake3.fail_kind("craft", *[BookforgeError("INTERNAL_ERROR", "", "bad answer")] * 3)
    app3 = make_app(tmp_path, fake3, slots=("AI-1", "AI-2"), name="d3")
    run3 = run_book(app3)
    assert run3["status"] == "done", (run3["phase"], run3.get("problem"))
    assert sum(1 for e in run3["events"] if e.get("code") == "EDITOR_FAILED") == 3
    assert len(run3["editor_summary"]["flagged"]) == 3


# ====================================================================== settings and HTTP
def test_editor_settings_validation(tmp_path):
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    ed = app.review.editor
    assert {k: ed.settings()[k] for k in ("enabled", "rounds", "strictness")} == \
        {"enabled": True, "rounds": 2, "strictness": "normal"}
    assert ed.save_settings({"enabled": False, "rounds": 3, "strictness": "strict"})["rounds"] == 3
    assert ed.settings()["enabled"] is False and ed.settings()["strictness"] == "strict"
    for bad, path in (({"rounds": 4}, "/rounds"), ({"rounds": -1}, "/rounds"), ({"rounds": True}, "/rounds"),
                      ({"strictness": "brutal"}, "/strictness"), ({"enabled": "yes"}, "/enabled")):
        with pytest.raises(BookforgeError) as e:
            ed.save_settings(bad)
        assert e.value.errors[0]["path"] == path
    assert ed.settings()["rounds"] == 3  # nothing changed by a refused save
    assert set(ed.settings()["strictness_choices"]) == {"gentle", "normal", "strict"}


@pytest.fixture
def served(tmp_path):
    import threading
    from http.server import ThreadingHTTPServer
    from bookforge.server import make_handler
    fake = SlotFake()
    fake.editor_flags = {PHRASE: BETTER}
    app, pid, rid, ver, ch = chapter_book(tmp_path, fake, editor={"enabled": True})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield app, httpd.server_address[1], pid, rid, ver
    finally:
        httpd.shutdown()
        httpd.server_close()


def http_job(port, pid, job):
    import time
    for _ in range(400):
        st, j, _ = call(port, "GET", f"/api/projects/{pid}/branches/main/review/ai/{job['job_id']}")
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_http_endpoints(served):
    app, port, pid, rid, ver = served
    base = f"/api/projects/{pid}/branches/main/review"
    st, s, _ = call(port, "GET", "/api/settings/editor")
    assert st == 200 and s["enabled"] is True and s["rounds"] == 2 and len(s["dimensions"]) == 9
    st, s, _ = call(port, "PUT", "/api/settings/editor", {"rounds": 1, "strictness": "gentle"})
    assert st == 200 and s["rounds"] == 1 and s["strictness"] == "gentle"
    st, e, _ = call(port, "PUT", "/api/settings/editor", {"rounds": 9})
    assert st == 400 and e["errors"][0]["code"] == "INVALID_INPUT" and e["errors"][0]["path"] == "/rounds"
    st, info, _ = call(port, "GET", f"{base}/editor/{rid}")
    assert st == 200 and info["craft"] == {} and info["fixable"] and info["pattern"]["words"] > 0
    st, e, _ = call(port, "POST", f"{base}/editor/fix", {"record_id": rid})
    assert st == 400 and "Editor review" in e["errors"][0]["message"]
    st, job, _ = call(port, "POST", f"{base}/editor", {"record_id": rid})
    assert st == 202
    j = http_job(port, pid, job)
    assert j["status"] == "done" and j["results"][0]["craft"]["verdict"] == "REVISE"
    st, job, _ = call(port, "POST", f"{base}/editor/fix", {"record_id": rid})
    assert st == 202
    j = http_job(port, pid, job)
    fid = j["results"][0]["proposal"]["items"][0]["finding_id"]
    st, info, _ = call(port, "GET", f"{base}/editor/{rid}")
    assert info["proposal"]["items"][0]["finding_id"] == fid
    st, out, _ = call(port, "POST", f"{base}/editor/apply", {"record_id": rid, "version": ver, "accept": [fid]})
    assert st == 200 and out["version"] == ver + 1 and out["pattern_after"]["words"] > 0
    st, e, _ = call(port, "POST", f"{base}/editor/apply", {"record_id": rid, "version": ver, "accept": [fid]})
    assert st == 409 and e["errors"][0]["code"] == "VERSION_CONFLICT"
    for body, code in (({}, "MISSING_INPUT"), ({"record_id": "nope"}, "NOT_FOUND")):
        st, e, _ = call(port, "POST", f"{base}/editor", body)
        assert st in (400, 404) and e["errors"][0]["code"] == code
    st, q, _ = call(port, "GET", base)
    assert st == 200 and all("craft" in i for i in q["items"])


def test_editor_refuses_other_drafts(tmp_path):
    app = make_app(tmp_path, SlotFake(), slots=("AI-1",))
    pid = app.engine.bootstrap_project("author", "B")
    from autobook_fake import fact
    bp = BookPath(app.engine, "author", pid, "main")
    ref, _ = bp.create("A01", {"concept": "Old Tom"}, manual_candidate={
        "concept": "Old Tom", "attributes": {}, "linked_refs": [], "protected_fact_flags": [],
        "facts": [fact("tom", "entity.name", "Old Tom")]})
    with pytest.raises(BookforgeError) as e:
        app.review.start_editor("author", pid, "main", {"record_id": ref["record_id"]})
    assert e.value.code == "INVALID_INPUT"
    job = ReviewJob("editor", "author", pid, "main", [ref["record_id"]], None)
    with pytest.raises(BookforgeError):
        app.review.editor.craft_one(job, ref["record_id"])
