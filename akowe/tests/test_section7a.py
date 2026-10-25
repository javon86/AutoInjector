"""Section 7a: the timeline checker + terminology check in the editor (P26), the trade-facts lane (P31) and the
repetition sorter (P30).

Pure parts (age/year extraction and the arithmetic checks, the term scan and terminology check, the repetition
classes and trim plan), storage as companion data (author edits with a version check, verification only with the
author's confirmation, AI answers stored as advice), a Make-a-book run (terms found are added as "research needed",
⚠️ notes, never blocks), the chapter and book views, the AI jobs (find / research), the fixes through the P5 rewrite
machinery (wrong term replaced; accidental repeat trimmed, voice repeat kept), the editor's protection of voice/motif
repeats and its fact_checks context, the C02 brief, and the HTTP endpoints."""
from __future__ import annotations

import time

import pytest

from akowe import chapter_brief, fact_checks, repetition as rep_mod, terms as terms_mod
from akowe import timeline_check as tl
from akowe.book_path import BookPath
from akowe.errors import AkoweError

from test_failover_review import SlotFake, make_app, no_provider_sleep, run_book  # noqa: F401
from test_server import call  # noqa: F401

CH1 = "\n\n".join([
    "It was the winter of 1887. Mara Vell was twelve years old, and she carried the wick-key up to the gas lamp on "
    "the quay.",
    "\"Right, so we light them all,\" Tom said. The fog came down on the quay.",
    "Nessa counted the lamps. Thirty-two, thirty-three, thirty-four. The old brass rail was cold under her hand.",
    "\"Right, so that is the last one,\" Tom said. The old brass rail was cold under her hand again.",
    "Mara Vell was thirteen years old that night, or so she told the harbor master."])
CH2 = "\n\n".join([
    "The fog came down on the quay before dawn.",
    "Nessa counted again: thirty-five, thirty-six.",
    "The boats knocked together in the swell.",
    "Gulls fought over the nets by the sheds.",
    "A cart rattled past the chandler's door.",
    "The church bell rang the half hour.",
    "Somebody shouted from the breakwater.",
    "The fog came down on the quay once more.",
    "Mara Vell was ten years old."])
CH3 = "\n\n".join([
    "At low tide the reef rose out of the water like the spine of something sleeping.",
    "Mara found the keeper's brass key wedged between two stones, still warm from the sun."])


def wait_job(app, job):
    for _ in range(600):
        j = app.review.get_job("author", job["job_id"])
        if j["status"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def made(tmp_path, editor=False, name="data"):
    fake = SlotFake()
    fake.chapter_texts = {"ch1": CH1, "ch2": CH2, "ch3": CH3}
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"), name=name)
    if not editor:
        app.review.editor.save_settings({"enabled": False})
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    return app, fake, run


def rid_of(app, pid, chapter_id):
    bp = BookPath(app.engine, "author", pid, "main")
    outline = bp.outline()
    _c, latest, appr = bp.chapter_prose(outline, chapter_id)
    return (latest or appr)["record_id"]


# ====================================================================== P26 pure: timeline
def test_timeline_ages_years_and_arithmetic():
    assert [tl.number(w) for w in ("forty-two", "forty two", "12", "a hundred", "nineteen", "lots")] == \
        [42, 42, 12, 100, 19, None]
    book = tl.check_book([("c1", CH1), ("c2", CH2)], names=["Mara Vell", "Nessa Crane"])
    checks = {f["check"] for f in book["findings"]}
    assert {"age_conflict", "age_backwards"} <= checks
    assert book["ages"]["Mara Vell"][0]["age"] == 12 and book["story_year"] == 1887
    # arithmetic: born 1850 + "now forty" = 1890, but the text says 1887 and 1860 + twenty years = 1880
    t = ("It was the winter of 1887. Odile was born in 1850. Odile, forty years old, counted the lamps. "
         "Twenty years ago, in 1860, the light failed. Mara is three years older than Odile. Mara was twelve years old.")
    b = tl.check_book([("c1", t)], names=["Odile", "Mara"],
                      characters=[{"name": "Odile", "attributes": {"background": "A woman of forty-five."}}])
    by = {f["check"]: f for f in b["findings"]}
    assert "year_arithmetic" in by and "1890" in by["year_arithmetic"]["detail"]
    assert "age_gap" in by and by["age_canon"]["severity"] == "minor"
    # flashback sentences and things that are not ages are never compared
    calm = tl.check_book([("c1", "Mara was twelve years old. When Mara was eight years old she fell. Mara walked "
                                 "twelve steps.")], names=["Mara"])
    assert calm["findings"] == [] and [r["past"] for r in calm["ages"]["Mara"]] == [False, True]
    # a later chapter whose "now" is earlier; a flashback chapter is skipped
    back = tl.check_book([("c1", "It was 1887."), ("c2", "It was 1880.")])
    assert [f["check"] for f in back["findings"]] == ["time_backwards"]
    fb = tl.check_book([("c1", "It was 1887."), ("c2", "Years earlier, back then, it was 1880.")])
    assert fb["findings"] == []
    # the editor's brief is bounded and per chapter
    br = tl.brief(book, "c2")
    assert br["story_year"] == 1887 and all(len(f["detail"]) <= 240 for f in br["findings"])
    assert tl.check_book([])["findings"] == []


# ====================================================================== P31 pure: scan and terminology check
def test_terms_scan_check_and_brief():
    found = terms_mod.scan(CH1 + "\n\nShe closed the isolation valve. A telephone rang.", [], story_year=1870,
                           texture_words=["lighting pole"])
    by = {f["term"]: f for f in found}
    assert by["wick-key"]["why"].startswith("conflict") and "no wick" in by["wick-key"]["question"]
    assert "isolation valve" in by and by["telephone"]["kind"] == "period"
    assert "brass rail" not in by  # an everyday word is not a trade fact
    items = terms_mod.clean_items([{"term": "wick-key", "question": "q"}, {"term": "Wick-Key"}, {"term": "x"},
                                   {"term": "gas cock", "status": "verified", "note": "turned to light the lamp"}])
    assert [i["term"] for i in items] == ["wick-key", "gas cock"] and items[0]["words"][:2] == ["wick-key", "wick key"]
    assert items[0]["status"] == "research_needed" and items[1]["status"] == "verified"
    res = terms_mod.check_text(CH1, items, chapter="ch1", story_year=1887)
    checks = [f["check"] for f in res["findings"]]
    assert "term_unverified" in checks and "term_conflict" in checks
    conflict = next(f for f in res["findings"] if f["check"] == "term_conflict")
    assert conflict["passages"][0]["match"] == "wick-key" and "gas lamp" in conflict["passages"][0]["sentence"]
    wrong = [dict(items[0], status="wrong", use_instead="lighting pole")]
    res = terms_mod.check_text(CH1, wrong, chapter="ch1")
    tw = next(f for f in res["findings"] if f["check"] == "term_wrong")
    assert tw["severity"] == "major" and "lighting pole" in tw["detail"] and res["uses"] == {"k1": 1}
    assert not [f for f in res["findings"] if f["check"] == "term_conflict"]  # one use is reported once
    # a term the author verified silences the built-in conflict
    ok = terms_mod.check_text(CH1, [dict(items[0], status="verified")], chapter="ch1")
    assert not [f for f in ok["findings"] if f["check"] in ("term_conflict", "term_unverified")]
    # anachronism only when the story year is known
    assert terms_mod.check_text("A telephone rang.", [], story_year=1870)["findings"][0]["check"] == "term_anachronism"
    assert terms_mod.check_text("A telephone rang.", [])["findings"] == []
    brief = terms_mod.chapter_brief({"items": wrong + [items[1]]}, "")
    assert brief[0] == {"term": "wick-key", "status": "wrong", "use_instead": "lighting pole"}
    assert brief[1]["status"] == "verified" and brief[1]["note"]
    assert terms_mod.clean_year("1887") == 1887 and terms_mod.clean_year("") is None
    with pytest.raises(AkoweError):
        terms_mod.clean_year("soon")


# ====================================================================== P30 pure: the repetition sorter
def test_repetition_classes_trim_plan_labels_and_findings():
    res = rep_mod.sort_repeats([("c1", CH1), ("c2", CH2)], names=["Mara Vell", "Nessa Crane", "Tom Reed"])
    by = {r["key"]: r for r in res["repeats"]}
    assert by["right so"]["class"] == "voice" and by["right so"]["who"] == "Tom" and by["right so"]["trim_count"] == 0
    assert by["counting"]["class"] == "motif"
    assert by["the fog came down on the quay"]["class"] == "motif"  # back in two chapters, never crowded
    acc = by["the old brass rail was cold under her hand"]
    assert acc["class"] == "accident" and [o["trim"] for o in acc["occurrences"]] == [False, True]
    assert "Right, so" in res["protected"] and not any("brass rail" in p for p in res["protected"])
    # filler: the first use per chapter stays, the rest may go
    f = rep_mod.sort_repeats([("c", "She went very still. Later she went very still again.")])["repeats"][0]
    assert f["class"] == "filler" and [o["trim"] for o in f["occurrences"]] == [False, True]
    # the author's label wins; a voice-card phrase is voice even in narration
    lab = rep_mod.sort_repeats([("c1", CH1)], names=["Tom Reed"], labels={"Right, so": "accident"})
    assert {r["key"]: r for r in lab["repeats"]}["right so"]["source"] == "author"
    vc = rep_mod.sort_repeats([("c", "Fair enough, she thought. Fair enough, she said again later.")],
                              voices={"Mara Vell": {"phrases": ["Fair enough"], "aliases": ["Mara"]}})
    assert vc["repeats"][0]["class"] == "voice" and vc["repeats"][0]["who"] == "Mara Vell"
    # the chapter view, the keep list and the trim findings (never on a voice repeat)
    here = rep_mod.for_chapter(res, "c1")
    assert here["counts"]["trim"] == 1
    assert rep_mod.protected_in(res, CH1) and "Right, so" in rep_mod.protected_in(res, CH1)
    assert "Right, so" not in rep_mod.protected_in(res, CH1, except_keys={"right so"})
    fs, keys = rep_mod.findings_for(CH1, here)
    assert len(fs) == 1 and fs[0]["dimension"] == "repetition" and "again" in fs[0]["passage"]
    assert keys == {"the old brass rail was cold under her hand"}


def test_labels_and_terms_storage(tmp_path):
    from akowe.server import App  # noqa: PLC0415
    app = App(tmp_path / "d", token="t")
    store, pid, b = app.store, "p1", "main"
    e = rep_mod.save_labels(store, pid, b, {"Right, so": "voice"})
    assert e["labels"] == {"right so": "voice"} and e["version"] == 1
    e = rep_mod.save_labels(store, pid, b, {"right so": ""}, base_version=1)
    assert e["labels"] == {}
    for bad in ({"x": "keep"}, {}, "voice"):
        with pytest.raises(AkoweError):
            rep_mod.save_labels(store, pid, b, bad)
    with pytest.raises(AkoweError) as x:
        rep_mod.save_labels(store, pid, b, {"a b": "voice"}, base_version=1)
    assert x.value.code == "VERSION_CONFLICT"
    e, n = terms_mod.add_terms(store, pid, b, [{"term": "wick-key", "status": "verified"}, {"term": "wick key"}],
                               by="scan")
    assert n == 1 and e["items"][0]["status"] == "research_needed"  # adding never verifies
    with pytest.raises(AkoweError) as x:  # an edit cannot verify by itself
        terms_mod.save(store, pid, b, terms_mod.clean_items([dict(e["items"][0], status="verified")]), by="author",
                       base_version=e["version"])
    assert x.value.code == "APPROVAL_REQUIRED"
    with pytest.raises(AkoweError) as x:
        terms_mod.decide(store, pid, b, ids=["k1"], status="verified")
    assert x.value.code == "APPROVAL_REQUIRED"
    e = terms_mod.set_ai_notes(store, pid, b, {"k1": {"verdict": "wrong", "answer": "No wick.", "use_instead": "pole"}},
                               slot="AI-2", reviewer="Gemini")
    assert e["items"][0]["status"] == "research_needed" and e["items"][0]["ai_note"]["verdict"] == "wrong"
    e = terms_mod.decide(store, pid, b, ids=["k1"], status="wrong", use_instead="lighting pole", author_confirms=True,
                         version=e["version"])
    assert e["items"][0]["status"] == "wrong" and e["items"][0]["verified"]["by"] == "author"
    # an author edit keeps the verification and the AI note of an unchanged status
    e2 = terms_mod.save(store, pid, b, terms_mod.clean_items([dict(e["items"][0], note="checked")]), by="author",
                        base_version=e["version"], story_year=1887)
    assert e2["items"][0]["verified"] and e2["items"][0]["ai_note"] and e2["story_year"] == 1887
    with pytest.raises(AkoweError) as x:
        terms_mod.decide(store, pid, b, ids=["nope"], status="verified", author_confirms=True)
    assert x.value.code == "NOT_FOUND"
    app.store.close()


# ====================================================================== in a book: run, views, AI jobs, fixes
def test_run_adds_research_needed_terms_and_flags_without_blocking(tmp_path):
    app, fake, run = made(tmp_path)
    pid = run["project_id"]
    fs = run.get("facts_summary") or app.autobook.get(run["id"]).get("facts_summary")
    assert fs and fs["terms_added"] >= 1 and fs["timeline"]["major"] >= 1 and fs["voice"] >= 1
    codes = {e.get("code") for e in run["events"]}
    assert {"TERMS_RESEARCH_NEEDED", "TIMELINE_PROBLEMS", "TERMS_WRONG"} <= codes
    entry = terms_mod.get_entry(app.store, pid, "main")
    wick = next(i for i in entry["items"] if i["term"] == "wick-key")
    assert wick["status"] == "research_needed" and wick["added_by"] == "run" and wick["verified"] is None
    # the chapter page
    rid = rid_of(app, pid, "ch1")
    ch = app.review.facts.chapter("author", pid, "main", rid)
    assert {f["check"] for f in ch["timeline"]["findings"]} >= {"age_conflict"}
    assert any(f["check"] == "term_conflict" for f in ch["terms"]["findings"])
    assert {r["key"]: r for r in ch["repetition"]["repeats"]}["right so"]["class"] == "voice"
    assert ch["fix"] == {"terms": 1, "repeats": 1} and ch["story_year"] == 1887
    # the book page
    bk = app.review.facts.book("author", pid, "main")
    assert bk["chapters"] == 3 and bk["terms"]["counts"]["research_needed"] >= 1
    assert next(i for i in bk["terms"]["items"] if i["term"] == "wick-key")["in_chapters"] == [1]
    assert bk["timeline"]["findings"][0]["passages"][0]["number"] in (1, 2)
    with pytest.raises(AkoweError) as x:
        app.review.facts.chapter("author", pid, "main", "nope")
    assert x.value.code == "NOT_FOUND"


def test_ai_find_research_verify_and_fix_terms(tmp_path):
    app, fake, run = made(tmp_path)
    pid, rv = run["project_id"], app.review
    rid = rid_of(app, pid, "ch1")
    terms_mod.save(app.store, pid, "main", [], by="author")  # start from an empty list
    j = wait_job(app, rv.start_facts_job("author", pid, "main", "facts_find", rid, {}))
    assert j["status"] == "done" and j["results"][0]["added"] == 1, j
    assert fake.prompts["terms_find"][-1][1]["chapter_text"].startswith("It was the winter")
    j = wait_job(app, rv.start_facts_job("author", pid, "main", "facts_research", None, {}))
    assert j["status"] == "done", j
    e = terms_mod.get_entry(app.store, pid, "main")
    wick = e["items"][0]
    assert wick["ai_note"]["verdict"] == "wrong" and wick["status"] == "research_needed"  # advice, not a verification
    e = terms_mod.decide(app.store, pid, "main", ids=[wick["id"]], status="wrong", use_instead="lighting pole",
                         author_confirms=True)
    # the writer's brief now says not to use it
    bp = BookPath(app.engine, "author", pid, "main")
    brief, _m = chapter_brief.build(app.store, pid, "main", bp.outline(), "ch1")
    assert {"term": "wick-key", "status": "wrong", "use_instead": "lighting pole"} in brief["trade_terms"]
    assert terms_mod.RULE in brief["rules"]
    # ✨ fix: the writer replaces the wrong term; the author applies it
    j = wait_job(app, rv.start_facts_job("author", pid, "main", "facts_fix_terms", rid, {}))
    assert j["status"] == "done", j
    prop = j["results"][0]["proposal"]
    assert prop["applied"] >= 1 and all(i["dimension"] == "terminology" for i in prop["items"])
    out = rv.apply_editor_fix("author", pid, "main", {"record_id": rid, "version": prop["version"]})
    text = rv._head(pid, "main", rid)["data"]["text"]
    assert out["ok"] and "wick-key" not in text and "lighting pole" in text
    after = rv.facts.chapter("author", pid, "main", rid)
    assert not [f for f in after["terms"]["findings"] if f["check"] in ("term_wrong", "term_conflict")]
    # nothing left to fix -> a clear refusal
    j = wait_job(app, rv.start_facts_job("author", pid, "main", "facts_fix_terms", rid, {}))
    assert j["status"] == "error" and "nothing to fix" in j["error"]["message"]
    with pytest.raises(AkoweError):
        rv.start_facts_job("author", pid, "main", "facts_find", "nope", {})
    with pytest.raises(AkoweError):
        rv.start_facts_job("author", pid, "main", "facts_research", None, {"ids": "k1"})


def test_trim_accidental_repeat_keeps_voice_and_editor_protects_it(tmp_path):
    app, fake, run = made(tmp_path, editor=True)
    pid, rv = run["project_id"], app.review
    rid = rid_of(app, pid, "ch1")
    # ✨ trim: only the accidental repeat, "Right, so" (voice) stays
    j = wait_job(app, rv.start_facts_job("author", pid, "main", "facts_fix_repeats", rid, {}))
    assert j["status"] == "done", j
    prop = j["results"][0]["proposal"]
    assert [i["dimension"] for i in prop["items"]] == ["repetition"] and prop["applied"] == 1
    assert "Right, so" in prop["keep"]
    rv.apply_editor_fix("author", pid, "main", {"record_id": rid, "version": prop["version"]})
    text = rv._head(pid, "main", rid)["data"]["text"]
    assert text.count("The old brass rail was cold under her hand") == 1 and text.count("Right, so") == 2
    # the AI editor gets the fact checks in its context …
    fake.editor_flags = {"Right, so": "So"}
    j = wait_job(app, rv.start_editor("author", pid, "main", {"record_id": rid}))
    assert j["status"] == "done", j
    fc = fake.craft_contexts[-1]["fact_checks"]
    assert fc["repeats"]["keep"][0]["class"] in ("voice", "motif") and fc["timeline"]["findings"]
    assert any(t["check"] == "term_conflict" for t in fc["terms"])
    # … and a rewrite that cuts the voice repeat is refused word for word (KEEP_LOST), nothing is guessed
    j = wait_job(app, rv.start_editor_fix("author", pid, "main", {"record_id": rid}))
    assert j["status"] == "done", j
    items = j["results"][0]["proposal"]["items"]
    assert len(items) == 2 and all(not i["ok"] and i["reason"] == "KEEP_LOST" for i in items)
    # the author relabels it: now it is an accident, the first use stays, a trim may target the second
    rep_mod.save_labels(app.store, pid, "main", {"Right, so": "accident"})
    ch = rv.facts.chapter("author", pid, "main", rid)
    r = {x["key"]: x for x in ch["repetition"]["repeats"]}["right so"]
    assert r["class"] == "accident" and r["source"] == "author" and r["trim_here"] == 1


def test_fact_checks_never_break_the_editor():
    class Boom:
        store = None

        def __getattr__(self, k):
            raise RuntimeError("boom")
    assert fact_checks.editor_context(Boom(), "author", "p", "b", {"module_id": "C02", "record_id": "r"}) == {}
    assert fact_checks.editor_context(Boom(), "author", "p", "b", {"module_id": "B01"}) == {}
    assert fact_checks.protected_keep(Boom(), "author", "p", "b", "text") == []


# ====================================================================== HTTP
@pytest.fixture
def served(tmp_path):
    import threading
    from http.server import ThreadingHTTPServer
    from akowe.server import make_handler
    app, fake, run = made(tmp_path)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield app, httpd.server_address[1], run
    finally:
        httpd.shutdown()
        httpd.server_close()
        app.store.close()


def http_job(port, pid, job):
    for _ in range(600):
        st, j, _ = call(port, "GET", f"/api/projects/{pid}/branches/main/review/ai/{job['job_id']}")
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_http_fact_checks(served):
    app, port, run = served
    pid = run["project_id"]
    base = f"/api/projects/{pid}/branches/main/review/facts"
    st, bk, _ = call(port, "GET", base)
    assert st == 200 and bk["chapters"] == 3 and bk["fields"]["classes"][0]["key"] == "voice"
    rid = rid_of(app, pid, "ch1")
    st, ch, _ = call(port, "GET", f"{base}/{rid}")
    assert st == 200 and ch["chapter_id"] == "ch1" and ch["terms"]["findings"]
    st, e, _ = call(port, "GET", f"{base}/nope")
    assert st == 404
    v = bk["terms"]["version"]
    st, e, _ = call(port, "PUT", f"{base}/terms", {"items": bk["terms"]["items"], "version": v - 1})
    assert st == 409
    st, out, _ = call(port, "PUT", f"{base}/terms", {"items": bk["terms"]["items"], "version": v, "story_year": 1887})
    assert st == 200 and out["entry"]["story_year"] == 1887
    st, e, _ = call(port, "PUT", f"{base}/terms", {"items": [], "story_year": "soon"})
    assert st == 400 and e["errors"][0]["path"] == "/story_year"
    st, sc, _ = call(port, "POST", f"{base}/terms/scan", {})
    assert st == 200 and sc["added"] == 0  # the run already added them
    wid = next(i["id"] for i in out["entry"]["items"] if i["term"] == "wick-key")
    st, e, _ = call(port, "POST", f"{base}/terms/verify", {"ids": [wid], "status": "verified"})
    assert st == 400 and e["errors"][0]["code"] == "APPROVAL_REQUIRED"
    st, ok, _ = call(port, "POST", f"{base}/terms/verify", {"ids": [wid], "status": "wrong", "author_confirms": True,
                                                           "use_instead": "lighting pole"})
    assert st == 200 and next(i for i in ok["entry"]["items"] if i["id"] == wid)["status"] == "wrong"
    st, job, _ = call(port, "POST", f"{base}/terms/ai", {})
    assert st == 202 and http_job(port, pid, job)["status"] in ("done", "error")
    st, job, _ = call(port, "POST", f"{base}/{rid}/find", {})
    assert st == 202 and http_job(port, pid, job)["status"] == "done"
    st, e, _ = call(port, "POST", f"{base}/{rid}/fix", {"kind": "everything"})
    assert st == 400
    st, job, _ = call(port, "POST", f"{base}/{rid}/fix", {"kind": "repeats"})
    assert st == 202 and http_job(port, pid, job)["status"] == "done"
    st, lab, _ = call(port, "PUT", f"{base}/repeats", {"labels": {"Right, so": "voice"}})
    assert st == 200 and lab["entry"]["labels"] == {"right so": "voice"}
    st, e, _ = call(port, "PUT", f"{base}/repeats", {"labels": {"Right, so": "maybe"}})
    assert st == 400
    st, e, _ = call(port, "POST", f"{base}/terms/bogus", {})
    assert st == 404
