"""Section 5: 📊 P13 book report (aggregation, independence, quotes, Markdown/PDF, per version, the run step, the
📨 ask-other-AIs job, the shelf), ⚖️ P14 compare versions (blind mapping, no version leak in prompts, reveal,
pipeline switches honoured by a run, variants) and 📏 P15 longer books (length presets -> outline / scene / chapter
targets, scene-by-scene writing of long chapters, bounded continuation of a chapter far under target, a 25-chapter
novel end to end, ETA from measured times)."""
from __future__ import annotations

import json
import time
import types
from collections import Counter

import pytest

from akowe import book_report as br
from akowe import compare as cmp_mod
from akowe import h_checks as hc
from akowe import lengths, long_chapter, pipeline
from akowe import providers as prov_mod
from akowe.book_path import BookPath, chapter_target, save_profile
from akowe.errors import AkoweError
from akowe.server import content_disposition

from autobook_fake import BookFakeAI
from test_autobook import make_app as make_one_ai_app
from test_failover_review import SlotFake, make_app, run_book
from test_server import TOKEN, call, server  # noqa: F401


@pytest.fixture(autouse=True)
def no_provider_sleep(monkeypatch):
    monkeypatch.setattr(prov_mod, "time", types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic,
                                                                time=time.time))


def steps(run):
    return {s["id"]: s for s in run["steps"]}


def outbox(app, pid, et):
    return [json.loads(r["payload"]) for r in app.store.query(
        "SELECT payload FROM outbox WHERE project_id=? AND event_type=? ORDER BY created_at", (pid, et))]


def route(app, method, path, body=None, query=None):
    return app.route(method, path, query or {}, body, "author", {})


# ============================================================================================ P15 length presets
def test_length_presets_and_chapter_plan():
    tab = lengths.lengths_table()
    keys = [x["key"] for x in tab["lengths"]]
    assert keys == ["short_story", "novelette", "novella", "novel"]
    by = {x["key"]: x for x in tab["lengths"]}
    assert by["short_story"]["words"] == [3000, 5000] and by["short_story"]["chapters"] == [3, 5]
    assert by["novelette"]["words"] == [10000, 15000]
    assert by["novella"]["words"] == [20000, 40000] and by["novella"]["chapters"] == [8, 15]
    assert by["novel"]["words"] == [60000, 90000] and by["novel"]["chapters"] == [20, 35]
    for k, p in lengths.PRESETS.items():  # every target and default inside its range
        assert p["words"][0] <= p["target"] <= p["words"][1] and p["chapters"][0] <= p["default_chapters"] <= \
            p["chapters"][1], k
    novel = lengths.chapter_plan({"length": "novel"})
    assert novel["chapters"] == 25 and novel["target_words"] == 3000 and novel["scene_by_scene"]
    assert novel["scenes"] == 4 and novel["words_per_scene"] == 750 and novel["min_words"] == 1800
    short = lengths.chapter_plan({"length": "short_story"})
    assert short["chapters"] == 3 and not short["scene_by_scene"] and short["target_words"] == 1333
    # the profile's own chapter count wins; the outline's real count wins over both
    assert lengths.chapter_plan({"length": "novella", "chapters": 10})["target_words"] == 3000
    assert lengths.chapter_plan({"length": "novella", "chapters": 10}, 15)["target_words"] == 2000
    assert chapter_target({"length": "novel"}) == 25 and chapter_target({"length": "novelette"}) == 6
    assert chapter_target({"length": "novel", "chapters": 22}) == 22
    rule = lengths.rule(novel)
    assert "3,000 words" in rule and "never with padding" in rule and "novel" in rule


def test_length_settings_validated_and_scaled(tmp_path):
    app = make_one_ai_app(tmp_path)
    out = route(app, "GET", "/api/settings/length")[1]
    assert out["per_call_words"] == 2500 and out["expand_rounds"] == 1
    route(app, "PUT", "/api/settings/length", {"per_call_words": 1200, "expand_rounds": 2})
    s = lengths.settings(app.store)
    assert s["per_call_words"] == 1200 and s["expand_rounds"] == 2 and s["under_share"] == 0.6
    for bad in ({"per_call_words": 50}, {"expand_rounds": 9}, {"under_share": "x"}, {"expand_rounds": 1.5}):
        with pytest.raises(AkoweError) as x:
            route(app, "PUT", "/api/settings/length", bad)
        assert x.value.code == "INVALID_INPUT"
    plan = lengths.chapter_plan({"length": "novella"}, None, app.store)
    assert plan["target_words"] == 2500 and plan["scene_by_scene"]  # 2 500 > 1 200 per call
    assert route(app, "GET", "/api/lengths")[1]["lengths"][3]["key"] == "novel"


def test_new_text_only_never_pads():
    old = "The fog came in. Mara climbed the steps.\n\nThe lamp was cold."
    add = "# A title\n\nThe fog came in. Mara climbed the steps.\n\nShe trimmed the wick with brass scissors."
    assert long_chapter.new_text_only(old, add) == "She trimmed the wick with brass scissors."
    assert long_chapter.new_text_only(old, "The lamp was cold.") == ""


def test_outline_scene_and_chapter_prompts_get_the_length_targets(tmp_path):
    fake = BookFakeAI()
    app = make_one_ai_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "novelette"})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    assert len(bp.outline_chapters(bp.outline())) == 6  # novelette default: 6 chapters (target_length)
    task, ctx = fake.prompts["B11"][0]
    assert ctx["request_payload"]["target_length"] == {"unit": "chapters", "value": 6}
    assert "novelette of about 12,000 words" in task and "6 chapters of about 2,000 words" in task
    stask, sctx = fake.prompts["scenes"][0]
    assert sctx["chapter"]["scene_hint"] == "3" and sctx["chapter"]["target_words"] == 2000 and \
        sctx["chapter"]["words_per_scene"] == 667 and "about 2,000 words" in stask
    ctask, cctx = fake.prompts["C02"][0]
    assert cctx["writing_brief"]["length"]["target_words"] == 2000
    assert "about 2,000 words" in ctask and "never with padding" in ctask
    assert "Length: about 2,000 words" in cctx["request_payload"]["instruction"]
    # one chapter, one call: the fake's short chapter is far under target -> one continuation round (empty: nothing)
    assert fake.kinds.count("C02") == 6 and fake.kinds.count("expand") == 6 and "scene_prose" not in fake.kinds
    st = steps(run)["chapters"]
    assert all(i["length"]["mode"] == "whole" and i["length"]["target"] == 2000 for i in st["items"])
    assert "target about 12,000" in st["message"]
    assert bp.word_stats()["target_words"] == 12000


def test_long_chapters_are_written_scene_by_scene(tmp_path):
    fake = BookFakeAI()
    app = make_one_ai_app(tmp_path, fake=fake)
    route(app, "PUT", "/api/settings/length", {"per_call_words": 1000})  # a short story chapter (1 333) > 1 000
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    outline = bp.outline()
    # one call per scene card (the fake plans 2 per chapter); no whole-chapter call
    assert fake.kinds.count("scene_prose") == 6 and fake.kinds.count("C02") == 0
    calls = fake.prompts["scene_prose"]
    first, second = calls[0][1]["scene_writing"], calls[1][1]["scene_writing"]
    assert first["scene"] == 1 and first["of"] == 2 and first["first"] and first["previous_scene_end"] is None
    assert first["card"]["place"] and second["previous_scene_end"] and second["last"]
    assert second["story_so_far"] and second["story_so_far"][0].startswith("scene 1:")
    assert "scene 1 of 2" in calls[0][0] and "Start with the chapter's '# ' title line" in calls[0][0]
    assert "objective_assessments" in calls[1][0] and "No title line" in calls[1][0]
    for ch in bp.outline_chapters(outline):
        _c, _l, appr = bp.chapter_prose(outline, ch["chapter_id"])
        text = appr["data"]["text"]
        assert text.startswith("# Part of") and text.count("# ") == 1 and "\n\n***\n\n" in text
        assert any(f["rule_id"].startswith("OBJECTIVE") for f in appr["data"]["findings"])
        meta = app.store.get_state(pid, "main", "c_meta", appr["record_id"])
        assert meta["length"]["mode"] == "scene_by_scene" and meta["length"]["scenes"] == 2
    assert all(i["length"]["mode"] == "scene_by_scene" for i in steps(run)["chapters"]["items"])


def test_chapter_far_under_target_is_continued_in_bounded_rounds(tmp_path):
    fake = BookFakeAI()
    fake.expand_text = True
    app = make_one_ai_app(tmp_path, fake=fake)
    route(app, "PUT", "/api/settings/length", {"expand_rounds": 2})
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    # each continuation adds new text; still far under 1 333 words -> exactly 2 rounds per chapter (bounded)
    assert fake.kinds.count("expand") == 6
    ectx = fake.prompts["expand"][0][1]
    assert ectx["length"]["target_words"] == 1333 and ectx["chapter_end"] and ectx["words_so_far"] > 0
    bp = BookPath(app.engine, "author", pid, "main")
    outline = bp.outline()
    _c, _l, appr = bp.chapter_prose(outline, "ch1")
    assert appr["data"]["text"].count("Mara counted the cost") == 2
    meta = app.store.get_state(pid, "main", "c_meta", appr["record_id"])
    assert meta["length"]["expand_rounds"] == 2 and meta["length"]["expanded_words"] > 40
    # the editor still read the continued chapter (its pattern check and craft review)
    assert fake.kinds.count("craft") >= 3


def test_failed_continuation_keeps_the_chapter(tmp_path):
    fake = BookFakeAI()
    fake.fail_kind("expand", *[AkoweError("TIMEOUT", "", "slow")] * 3)
    app = make_one_ai_app(tmp_path, fake=fake)
    run = run_book(app, {"length": "short_story"})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    _c, _l, appr = bp.chapter_prose(bp.outline(), "ch1")
    meta = app.store.get_state(pid, "main", "c_meta", appr["record_id"])
    assert meta["length"]["expand_error"] == "TIMEOUT" and "Gullhaven" in appr["data"]["text"]


def test_novel_with_25_chapters_end_to_end(tmp_path):
    fake = BookFakeAI()
    fake.max_chapters = 30
    app = make_one_ai_app(tmp_path, fake=fake)
    t0 = time.time()
    run = run_book(app, {"length": "novel"}, timeout=600)
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    assert time.time() - t0 < 300
    st = steps(run)
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    chapters = bp.outline_chapters(bp.outline())
    assert len(chapters) == 25 and len(st["chapters"]["items"]) == 25
    c = Counter(fake.kinds)
    assert c["scene_prose"] == 50 and c["craft"] >= 25 and c["planned"] >= 25  # editor + planned on every chapter
    assert all(i["state"] == "done" and i["length"]["mode"] == "scene_by_scene" for i in st["chapters"]["items"])
    assert all(st[k]["state"] == "done" for k in ("planned", "format", "assemble", "export", "check", "report"))
    assert len(steps(run)["planned"]["items"]) == 25
    files = {f["format"]: f for f in run["files"]}
    assert set(files) == {"PDF", "EPUB", "DOCX"}
    pdf = app.store.read_binary(app.store.get_record(pid, "main", files["PDF"]["record_id"], files["PDF"]["version"]))
    assert hc.pdf_structure(pdf)[0] is not None
    assert bp.status()["words"]["target_words"] == 75000
    # measured times: every chapter timed, AI calls counted, ETA computed from them
    t = run["timing"]
    assert len(t["chapter_s"]) == 25 and t["calls"] > 100
    eta = app.autobook._eta(dict(run, steps=[dict(s, state="pending") if s["id"] in ("format", "report") else s
                                             for s in run["steps"]]), 20, 25)
    assert eta["chapters_left"] == 5 and eta["seconds_left"] >= 0 and eta["calls"] == t["calls"]
    # the book report reads the long book as a digest of every chapter only when it is long (here: whole)
    rep = app.reports.latest(pid, "main")
    assert rep and len(rep["words"]["chapters"]) == 25


def test_book_digest_is_bounded_for_long_books():
    chapters = [{"number": i + 1, "title": f"T{i}", "text": ("word " * 4000).strip(), "words": 4000,
                 "objective": "x", "record_id": f"r{i}", "version": 1, "approved": True, "chapter_id": f"ch{i}"}
                for i in range(25)]
    v = br.book_view(chapters)
    assert v["mode"] == "digest" and len(v["chapters"]) == 25
    assert len(json.dumps(v)) < br.DIGEST_MAX_CHARS + 6000
    assert all(c["opening"] and c["closing"] for c in v["chapters"])
    small = br.book_view(chapters[:2])
    assert small["mode"] == "whole" and small["chapters"][0]["text"]


# ============================================================================================ P14 pipeline switches
def test_pipeline_clean_and_presets():
    assert pipeline.clean(None)["preset"] == "full"
    b = pipeline.clean({"preset": "baseline"})
    assert b["preset"] == "baseline" and not any(b["flags"].values())
    c = pipeline.clean({"flags": {"editor": False}})
    assert c["preset"] == "custom" and c["flags"]["editor"] is False and c["flags"]["scenes"] is True
    assert "editor" in pipeline.describe(c).lower()
    for bad in ({"preset": "fast"}, {"flags": {"magic": True}}, {"flags": {"editor": "no"}}, 7):
        with pytest.raises(AkoweError):
            pipeline.clean(bad)


def test_baseline_run_honours_every_switch(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    run = run_book(app, {"slot_id": "AI-1", "pipeline": {"preset": "baseline"}})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    st = steps(run)
    for sid in ("characters", "world", "planned"):
        assert st[sid]["state"] == "skipped" and "Off in this run's pipeline" in st[sid]["message"]
    kinds = Counter(fake.kinds)
    for k in ("scenes", "scene_review", "craft", "planned", "rules", "texture", "rewrite", "planned_rewrite", "sheet"):
        assert kinds[k] == 0, (k, kinds)
    assert kinds["C02"] == 3 and kinds["review"] >= 3
    for _task, ctx in fake.prompts["C02"]:
        wb = ctx.get("writing_brief") or {}
        assert not wb.get("scene_cards") and not wb.get("voice_cards") and not wb.get("other_voices")
        assert "story_rules" not in wb and "world_texture" not in wb and "must_show" not in wb
        assert wb["length"]["target_words"] == 1333  # the length still applies
    assert pipeline.of_store(app.store, pid) == pipeline.PRESETS["baseline"]
    meta = app.store.get_state(pid, "main", "c_meta", next(iter(
        r["record_id"] for r in app.store.list_records(pid, "main", "C02", "OUTPUT"))))
    assert meta["brief"]["pipeline"] == pipeline.PRESETS["baseline"]
    assert not outbox(app, pid, "editor.craft_review") and not outbox(app, pid, "planned.checked")


def test_custom_switch_turns_off_only_the_editor(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    run = run_book(app, {"slot_id": "AI-1", "pipeline": {"flags": {"editor": False}}})
    assert run["status"] == "done", run.get("problem")
    kinds = Counter(fake.kinds)
    assert kinds["craft"] == 0 and kinds["scenes"] >= 3 and kinds["planned"] >= 3 and kinds["rules"] >= 1
    assert all(s["state"] == "done" for s in run["steps"])
    assert run["settings"]["pipeline"]["preset"] == "custom"


def test_variant_copies_the_profile_and_is_named(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake, slots=("AI-1", "AI-2"))
    first = run_book(app, {"slot_id": "AI-1", "length": "short_story", "choices": {"ending": "bittersweet"}})
    pid1 = first["project_id"]
    save_profile(app.store, pid1, {"title": "The Lantern Keeper", "idea": "A keeper hides a lantern from the board."})
    n_profile = fake.kinds.count("profile")
    var = run_book(app, {"slot_id": "AI-1", "variant_of": {"project_id": pid1}, "pipeline": {"preset": "baseline"}})
    assert var["status"] == "done", var.get("problem")
    pid2 = var["project_id"]
    assert fake.kinds.count("profile") == n_profile  # the profile was copied, not invented again
    from akowe.book_path import get_profile  # noqa: PLC0415
    p1, p2 = get_profile(app.store, pid1), get_profile(app.store, pid2)
    assert p2["title"] == "The Lantern Keeper" and p2["idea"] == p1["idea"] and p2["choices"] == {"ending": "bittersweet"}
    assert app.store.project(pid2)["name"] == "The Lantern Keeper (variant: baseline)"
    assert var["settings"]["variant_of"]["project_id"] == pid1
    shelf = {b["project_id"]: b for b in route(app, "GET", "/api/shelf")[1]["books"]}
    assert shelf[pid2]["variant_of"] == pid1 and shelf[pid2]["pipeline"]["preset"] == "baseline"
    with pytest.raises(AkoweError) as x:
        app.autobook.start("author", {"author_confirms": True, "variant_of": {"project_id": "nope"}})
    assert x.value.code == "NOT_FOUND"


# ============================================================================================ P13 book report
def test_report_aggregation_median_and_disagreement():
    rows = [{"slot": "AI-2", "status": "done", "independent": True, "scores": {"atmosphere": 9, "subtext": 3}},
            {"slot": "AI-3", "status": "done", "independent": True, "scores": {"atmosphere": 8, "subtext": 7}},
            {"slot": "AI-1", "status": "done", "independent": False, "scores": {"atmosphere": 9, "subtext": 4}},
            {"slot": "AI-9", "status": "failed"}]
    agg = br.aggregate(rows)
    by = {d["dimension"]: d for d in agg["dimensions"]}
    assert by["atmosphere"]["median"] == 9 and not by["atmosphere"]["disagree"]
    assert by["subtext"]["median"] == 4 and by["subtext"]["spread"] == 4 and by["subtext"]["disagree"]
    assert by["premise"]["n"] == 0 and agg["reviewers"] == 3 and agg["independent"] == 2
    assert agg["disagreements"] == ["Subtext"] and agg["overall"] == 6.5


def test_quotes_are_verified_against_the_book():
    norm = br._norm("“Fair enough,” she said. The fog rolled in over Gullhaven before dawn.")
    assert br.verify_quote("The fog rolled in over Gullhaven", norm)
    assert br.verify_quote('"Fair enough," she said.', norm)
    assert br.verify_quote("The fog rolled … before dawn", norm)
    assert not br.verify_quote("A sentence that is not there", norm)
    c = br.clean_review({"book_scores": {"atmosphere": 14, "subtext": 0, "bogus": 5},
                         "strengths": [{"point": "Mood", "quote": "The fog rolled in over Gullhaven"}],
                         "weaknesses": [{"point": "Invented", "quote": "Never written."}, {"point": ""}],
                         "try_next": ["x", ""], "summary": "ok"}, br.DIM_KEYS, norm)
    assert c["scores"] == {"atmosphere": 10, "subtext": 1}
    assert c["strengths"][0]["verified"] and not c["weaknesses"][0]["verified"] and len(c["weaknesses"]) == 1


def test_run_makes_the_report_with_independent_reviewers_only(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)  # AI-1 claude, AI-2 chatgpt, AI-3 gemini
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done", run.get("problem")
    pid = run["project_id"]
    st = steps(run)["report"]
    assert st["state"] == "done" and "2 AI(s) read the whole book" in st["message"]
    rep = app.reports.latest(pid, "main")
    slots = {r["slot"] for r in rep["reviews"]}
    assert slots == {"AI-2", "AI-3"} and all(r["independent"] for r in rep["reviews"])  # AI-1 wrote the book
    assert rep["usage"]["writer_slot"] == "AI-1" and rep["book_mode"] == "whole"
    assert run["report"]["id"] == rep["id"] and run["report"]["reviewers"] == 2
    by = {d["dimension"]: d for d in rep["aggregate"]["dimensions"]}
    assert by["atmosphere"]["median"] == 9 and by["subtext"]["median"] == 5
    weak = [p for r in rep["reviews"] for p in r["weaknesses"]]
    assert any(p["verified"] for p in weak) and any(not p["verified"] for p in weak)
    assert rep["words"]["total"] > 100 and rep["words"]["target"] == 4000
    assert rep["editor"]["read"] == 3 and rep["patterns"].get("summary") is not None
    assert {t["from"] for t in rep["try_next"]} >= {"reviewers"}
    # the reviewers got the whole book and no prompt text is in the activity log
    ctx = fake.prompts["book_review"][0][1]
    assert ctx["book"]["mode"] == "whole" and len(ctx["book"]["chapters"]) == 3
    assert "Gullhaven" not in json.dumps(outbox(app, pid, "quality.book_report"))
    # Markdown and PDF
    md = br.render_markdown(rep)
    assert "## Scores (whole book)" in md and "| Atmosphere | 9 |" in md and "## What to try next" in md
    assert "not found word for word" in md and "## AI usage" in md
    pdf = br.render_pdf(rep)
    doc, issues = hc.pdf_structure(pdf)
    assert doc is not None and not [i for i in issues if i.get("decision") == "FAIL"]
    assert br.file_name(rep["title"], rep["at"], "pdf") == f"The Keeper of Gullhaven - Akowe report - {rep['at'][:10]}.pdf"
    # shelf lists the report next to the book
    b = next(x for x in route(app, "GET", "/api/shelf")[1]["books"] if x["project_id"] == pid)
    assert b["report"]["id"] == rep["id"] and b["report"]["reviewers"] == 2


def test_report_without_an_independent_ai_says_so(tmp_path):
    fake = BookFakeAI()
    app = make_one_ai_app(tmp_path, fake=fake)
    run = run_book(app)
    assert run["status"] == "done"
    st = steps(run)["report"]
    assert st["state"] == "done" and "without an AI review" in st["message"]
    assert any(e.get("code") == "REPORT_NOT_INDEPENDENT" for e in app.autobook.get(run["id"])["events"])
    assert "book_review" not in fake.kinds
    rep = app.reports.latest(run["project_id"], "main")
    assert rep["aggregate"]["reviewers"] == 0 and any("No independent AI" in w for w in rep["warnings"])


def test_report_failure_never_blocks_the_book(tmp_path):
    fake = SlotFake()
    fake.fail_kind("book_review", AkoweError("INVALID_INPUT", "", "bad"), AkoweError("TIMEOUT", "", "slow"))
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    assert run["status"] == "done"
    rep = app.reports.latest(run["project_id"], "main")
    assert {r["status"] for r in rep["reviews"]} == {"failed"} and any("could not review" in w for w in rep["warnings"])


def test_ask_other_ais_job_api_and_downloads(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    pid = run["project_id"]
    base = f"/api/projects/{pid}/branches/main/report"
    ov = route(app, "GET", base)[1]
    assert ov["latest"] and not ov["stale"] and {o["slot_id"]: o["wrote_most"] for o in ov["reviewers"]}["AI-1"]
    first = ov["latest"]["id"]
    # 📨 ask one chosen AI (even the writer: marked not independent) -> added to the same report (same version)
    status, job = route(app, "POST", base, {"slots": ["AI-1"], "report_id": first})
    assert status == 202
    for _ in range(200):
        j = route(app, "GET", f"{base}/job/{job['id']}")[1]
        if j["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert j["status"] == "done" and j["report_id"] == first
    rep = app.reports.get(pid, "main", first)
    assert {r["slot"]: r["independent"] for r in rep["reviews"]} == {"AI-2": True, "AI-3": True, "AI-1": False}
    assert rep["aggregate"]["reviewers"] == 3 and rep["aggregate"]["independent"] == 2
    # downloads
    st, payload = route(app, "GET", f"{base}/{first}", query={"format": ["pdf"], "download": ["1"]})
    assert payload[0] == "__binary__" and payload[1] == "application/pdf" and payload[2][:4] == b"%PDF"
    assert payload[3].endswith(".pdf") and "Akowe report" in payload[3] and payload[4] == "attachment"
    st, payload = route(app, "GET", f"{base}/{first}", query={"format": ["md"]})
    assert payload[2].decode("utf-8").startswith("# The Keeper of Gullhaven")
    with pytest.raises(AkoweError):
        route(app, "GET", f"{base}/nope")
    with pytest.raises(AkoweError) as x:
        route(app, "POST", base, {"slots": ["AI-7"]})
    assert x.value.code == "INVALID_INPUT"
    # a new chapter version -> the stored report is for an older version (stale) and a new one is made
    bp = BookPath(app.engine, "author", pid, "main")
    _c, latest, appr = bp.chapter_prose(bp.outline(), "ch1")
    r = bp.dispatch("C02", "UPDATE", base_ref=appr["ref"], payload=dict(appr["data"], text=appr["data"]["text"]
                                                                         + " More."))
    assert not route(app, "GET", base)[1]["stale"]  # a draft does not change the approved book
    assert bp.approve_ref(r["output_refs"][0])["ok"]
    assert route(app, "GET", base)[1]["stale"]
    rep2 = app.reports.make("author", pid, "main", ai=False)
    assert rep2["id"] != first and rep2["version"]["key"] != rep["version"]["key"]
    assert len(route(app, "GET", base)[1]["reports"]) == 2
    # background work knows the job kind and can resume it
    assert app.jobstore.get(job["id"])["kind"] == "book_review"


def test_report_file_names_for_any_title():
    assert br.file_name('A/B: "C"?', "2026-10-24T10:00:00Z", "md") == "A B C - Akowe report - 2026-10-24.md"
    cd = content_disposition("attachment", "Über – Nacht - Akowe report - 2026-10-24.pdf")
    assert cd.startswith('attachment; filename="') and "filename*=UTF-8''%C3%9Cber" in cd
    cd.encode("latin-1")  # the header can always be sent
    assert content_disposition("inline", "plain.md") == 'inline; filename="plain.md"'


def test_report_http_download_with_unicode_title(server):  # noqa: F811
    app, port = server
    fake = SlotFake()
    pr = app.engine.providers
    pr.test_adapter = fake
    pr.health.hold_s = 0.0
    for sid, site in (("AI-1", "claude"), ("AI-2", "chatgpt")):
        pr.configure_slot(sid, {"adapter_id": "autoinjector", "site": site})
    from akowe.jobs import RetryPolicy  # noqa: PLC0415
    app.autobook.retry_policy = app.assist.retry_policy = RetryPolicy([0.01], 1)
    app.autobook.probe_timeout_s, app.autobook.probe_poll_s = 1, 0.01
    run = run_book(app, {"slot_id": "AI-1"})
    pid = run["project_id"]
    save_profile(app.store, pid, {"title": "Ünder the Lämp"})
    rep = app.reports.make("author", pid, "main", ai=False)
    status, body, resp = call(port, "GET", f"/api/projects/{pid}/branches/main/report/{rep['id']}?format=pdf&download=1")
    assert status == 200 and body[:4] == b"%PDF"
    assert "filename*=UTF-8''%C3%9Cnder%20the%20L%C3%A4mp%20-%20Akowe%20report" in resp.getheader(
        "Content-Disposition")


# ============================================================================================ P14 blind comparison
def _two_books(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    a = run_book(app, {"slot_id": "AI-1"})
    b = run_book(app, {"slot_id": "AI-1", "variant_of": {"project_id": a["project_id"]},
                       "pipeline": {"preset": "baseline"}})
    assert a["status"] == b["status"] == "done"
    return app, fake, a, b


def _wait_compare(app, job):
    for _ in range(300):
        j = app.compare.job("author", job["id"])
        if j["status"] not in ("queued", "running"):
            return j
        time.sleep(0.05)
    raise AssertionError("compare job did not finish")


def test_blind_comparison_random_mapping_no_leak_and_reveal(tmp_path, monkeypatch):
    app, fake, a, b = _two_books(tmp_path)
    pa, pb = a["project_id"], b["project_id"]
    # make version B clearly longer, so the fake (which prefers the longer text) prefers B in every order
    bp = BookPath(app.engine, "author", pb, "main")
    _c, _l, appr = bp.chapter_prose(bp.outline(), "ch1")
    longer = appr["data"]["text"] + "\n\n" + "The harbour board sealed the sheds and Mara paid in oil. " * 20
    r = bp.dispatch("C02", "UPDATE", base_ref=appr["ref"], payload=dict(appr["data"], text=longer))
    bp.approve_ref(r["output_refs"][0])
    picks = iter(["B", "A", "B"])
    monkeypatch.setattr(cmp_mod.secrets.SystemRandom, "choice", lambda self, seq: next(picks))
    status, job = route(app, "POST", "/api/compare", {"a": {"project_id": pa}, "b": {"project_id": pb}})
    assert status == 202
    j = _wait_compare(app, job)
    assert j["status"] == "done", j
    res = route(app, "GET", f"/api/compare/{j['comparison_id']}")[1]
    rows = res["reviews"]
    # AI-1 wrote both books: the independent AIs (AI-2, AI-3) are asked, each with its own random order
    assert [r["slot"] for r in rows] == ["AI-2", "AI-3"] and all(r["independent"] for r in rows)
    assert rows[0]["mapping"] == {"version_1": "B", "version_2": "A"} and rows[1]["mapping"]["version_1"] == "A"
    # revealed: B preferred by both, whatever its position; B wins every dimension
    assert all(r["revealed"]["preferred"] == "B" for r in rows)
    ag = res["aggregate"]
    assert ag["winner"] == "B" and ag["votes"]["B"] == 2 and ag["wins"]["B"] == len(br.DIM_KEYS)
    assert all(d["winner"] == "B" and d["b"] == 8 and d["a"] == 7 for d in ag["dimensions"])
    assert res["a"]["preset"] == "full" and res["b"]["preset"] == "baseline"
    # nothing in the prompts tells the versions apart except their text
    for task, ctx in fake.prompts["compare"]:
        blob = task + json.dumps(ctx, ensure_ascii=False)
        for leak in (pa, pb, "baseline", "Baseline", "variant", "pipeline", "run-", "proj-", "full pipeline",
                     a["id"], b["id"], "record_id", "project_id"):
            assert leak not in blob, leak
        assert set(ctx) == {"version_1", "version_2", "dimensions"}
    assert route(app, "GET", "/api/compare")[1]["items"][0]["winner"] == "B"
    assert outbox(app, pa, "quality.compared")[0]["side"] == "A" and outbox(app, pb, "quality.compared")


def test_compare_two_chapter_versions(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake)
    run = run_book(app, {"slot_id": "AI-1"})
    pid = run["project_id"]
    bp = BookPath(app.engine, "author", pid, "main")
    _c, _l, appr = bp.chapter_prose(bp.outline(), "ch2")
    rid = appr["record_id"]
    r = bp.dispatch("C02", "UPDATE", base_ref=appr["ref"], payload=dict(appr["data"], text=appr["data"]["text"] + " x"))
    v2 = r["output_refs"][0]["version"]
    job = app.compare.start("author", {"scope": "chapter", "a": {"project_id": pid, "record_id": rid, "version": appr["version"]},
                                       "b": {"project_id": pid, "record_id": rid, "version": v2}, "slots": ["AI-3"]})
    j = _wait_compare(app, job)
    res = app.compare.get("author", j["comparison_id"])
    keys = [d["key"] for d in res["dimensions"]]
    assert "subtext" in keys and "atmosphere" in keys and "premise" not in keys
    assert [x["slot"] for x in res["reviews"]] == ["AI-3"] and res["aggregate"]["winner"] in ("A", "B", "tie")
    assert any("one opinion" in w for w in res["warnings"])
    for bad, code in (({"scope": "chapter", "a": {"project_id": pid, "record_id": rid, "version": 1},
                        "b": {"project_id": pid, "record_id": rid, "version": 1}}, "INVALID_INPUT"),
                      ({"a": {"project_id": pid}, "b": {"project_id": pid}}, "INVALID_INPUT"),
                      ({"a": {"project_id": "nope"}, "b": {"project_id": pid}}, "NOT_FOUND"),
                      ({"scope": "page", "a": {}, "b": {}}, "INVALID_INPUT")):
        with pytest.raises(AkoweError) as x:
            app.compare.start("author", bad)
        assert x.value.code == code


def test_compare_marks_reviewers_that_wrote_a_version(tmp_path):
    fake = SlotFake()
    app = make_app(tmp_path, fake, slots=("AI-1",))  # only the writer works
    a = run_book(app, {"slot_id": "AI-1"})
    b = run_book(app, {"slot_id": "AI-1"})
    job = app.compare.start("author", {"a": {"project_id": a["project_id"]}, "b": {"project_id": b["project_id"]}})
    res = app.compare.get("author", _wait_compare(app, job)["comparison_id"])
    assert res["reviews"][0]["wrote"] == ["A", "B"] and not res["reviews"][0]["independent"]
    assert any("Not independent" in w for w in res["warnings"]) and res["aggregate"]["independent"] == 0


def test_compare_aggregate_ties_and_failures():
    dims = cmp_mod.dims_for("book")[:2]
    rows = [{"status": "done", "mapping": {"version_1": "A", "version_2": "B"},
             "answer": {"version_1": {"atmosphere": 8, "premise": 6}, "version_2": {"atmosphere": 8, "premise": 7},
                        "preferred": "tie"}},
            {"status": "failed", "mapping": {"version_1": "B", "version_2": "A"}}]
    ag = cmp_mod.aggregate(rows, dims)
    by = {d["dimension"]: d for d in ag["dimensions"]}
    assert by["atmosphere"]["winner"] == "tie" and by["premise"]["winner"] == "B"
    assert ag["votes"]["tie"] == 1 and ag["winner"] == "B" and ag["reviewers"] == 1
