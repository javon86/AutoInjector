"""Holes H7, H15-H18, H22-H24 (docs/HOLES_2026-11.md): each one reproduced, then fixed.

* H7  a sequel looks for what changed first (also for a book on its own), waits for the author's review (or an
      explicit skip), and carries the 🔒 protected facts, the Character Forge dossiers, items, status and a summary of
      the book before; "exactly as they were at the end" is only said when it is true.
"""
from __future__ import annotations

import time

import pytest

from akowe import book_bible, characters as chars_mod, forge, series
from akowe.errors import AkoweError

from autobook_fake import BookFakeAI
from test_autobook import make_app, no_provider_sleep, run_book  # noqa: F401

BR = "main"


def wait_job(app, job, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = app.review._jobs[job["job_id"]].public()
        if j["status"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.05)
    raise AssertionError("job did not finish")


@pytest.fixture
def book1(tmp_path):
    app = make_app(tmp_path, fake=BookFakeAI())
    run = run_book(app, {"genre": "Mystery", "length": "short_story", "pictures": False})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    return app, run["project_id"]


def _mara(app, pid):
    return next(c for c in chars_mod.canon_characters(app.store, pid, BR) if c["name"] == "Mara Vell")


def _key(app, pid, name="Mara Vell"):
    s = series.linked(app.store, series.of_book(app.store, pid, BR))
    return next(k for k, c in s["characters"].items() if c["name"] == name)


# ====================================================================== H7 sequels
def test_h7_a_sequel_of_a_single_book_finds_what_changed_first_and_waits_for_review(book1):
    app, pid = book1
    assert series.member(app.store, pid) is None  # a book on its own: its run never looked for what changed
    st = series.sequel_status(app, pid, BR)
    assert st["changes"]["state"] == "not_found"
    out = series.start_sequel(app, "author", pid, BR, {"author_confirms": True, "pictures": False})
    assert out["run"] is None and out["changes"] == "finding" and "First, the AI reads this book" in out["message"]
    j = wait_job(app, out["finding"])
    assert j["status"] == "done", j
    # proposals are waiting: the sequel does not start until they are approved / dismissed (or skipped)
    with pytest.raises(AkoweError) as e:
        series.start_sequel(app, "author", pid, BR, {"author_confirms": True, "pictures": False})
    assert e.value.code == "APPROVAL_REQUIRED" and "waiting for you" in e.value.errors[0]["message"]
    s = series.of_book(app.store, pid, BR)
    for k in list((s["proposals"].get("1") or {})):
        series.approve(app.store, pid, BR, {"key": k})
    for k in list((s.get("thing_proposals") or {}).get("1") or {}):
        series.dismiss(app.store, pid, BR, {"key": k})
    assert series.sequel_status(app, pid, BR)["changes"]["state"] == "reviewed"
    bible, sequel = series.sequel_bible(app, pid, BR, {})
    assert "start exactly as they were at the end" in bible["profile"]["idea"] and sequel["changes"] == "reviewed"


def test_h7_skipping_the_review_is_explicit_and_the_message_stays_true(book1):
    app, pid = book1
    out = series.start_sequel(app, "author", pid, BR, {"author_confirms": True, "pictures": False,
                                                       "skip_changes": True})
    assert out["run"] and out["changes"] == "skipped"
    assert "exactly" not in out["message"] and "without reviewing" in out["message"]
    app.autobook.wait_for(out["run"]["id"], 120)
    run = app.autobook.get(out["run"]["id"])
    from akowe.book_path import get_profile
    idea = get_profile(app.store, run["project_id"])["idea"]
    assert "exactly as they were" not in idea and "may be missing" in idea
    assert series.of_book(app.store, pid, BR)["skipped"].get("1")


def test_h7_the_sequel_carries_status_items_dossier_locks_and_the_story_so_far(book1):
    app, pid = book1
    series.save_proposals(app.store, pid, BR, {"character_changes": [
        {"name": "Mara Vell", "items_gained": [{"text": "the Resonance Key"}],
         "status": [{"text": "injured: her left arm is broken"}]}]})
    series.approve(app.store, pid, BR, {"key": _key(app, pid)})
    rid = _mara(app, pid)["record_id"]
    sec = forge.FIELDS["eyes"]["section"]
    forge.edit(app.store, pid, BR, rid, {"sections": {sec: {"eyes": {"text": "Grey-green, a fleck of gold in the "
                                                                              "left one"}}}})
    forge.protect(app.store, pid, BR, rid, ["eyes"], by="run:test")  # a chapter relied on it: 🔒 locked
    from akowe import binder_fields
    binder_fields.edit(app.store, pid, BR, {"target": f"character:{rid}", "fields": {"handedness": "left"},
                                            "protected": {"handedness": True}})
    # the bible read back from a file keeps the dossier and lists the protected facts (they were wiped before)
    import json
    again = book_bible.clean(json.loads(json.dumps(book_bible.build(app, pid, BR))))
    mara = next(c for c in again["characters"] if c["name"] == "Mara Vell")
    assert mara["forge"]["fields"]["eyes"] == {"text": "Grey-green, a fleck of gold in the left one", "protected": True}
    assert mara["forge"]["binder"]["handedness"] == {"value": "left", "protected": True}
    assert any(p["name"] == "Mara Vell" and "eyes" in p["flags"] for p in again["protected_facts"])
    bible, sequel = series.sequel_bible(app, pid, BR, {})
    mara = next(c for c in bible["characters"] if c["name"] == "Mara Vell")
    attrs = mara["data"]["attributes"]
    assert "Status: injured: her left arm is broken" in attrs["constraints"] and "Resonance Key" in attrs["constraints"]
    assert mara["forge"]["fields"]["eyes"]["protected"] is True
    assert bible["story_so_far"]["text"] and "What happened in book 1:" in bible["profile"]["idea"]
    assert sequel["story_so_far"] == bible["story_so_far"]["text"]
    # the new book gets them: the record with the status and items, the dossier with its 🔒 lock
    out = series.start_sequel(app, "author", pid, BR, {"author_confirms": True, "pictures": False})
    app.autobook.wait_for(out["run"]["id"], 120)
    run = app.autobook.get(out["run"]["id"])
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    pid2 = run["project_id"]
    m2 = _mara(app, pid2)
    assert "broken" in m2["attributes"]["constraints"] and "Resonance Key" in m2["attributes"]["constraints"]
    assert not any(e.get("code") == "BIBLE_ENTRY_REFUSED" for e in run["events"])
    d2 = forge.raw_entry(app.store, pid2, BR, m2["record_id"])
    assert d2["fields"]["eyes"]["text"].startswith("Grey-green") and d2["fields"]["eyes"]["protected"] is True
    vals = binder_fields.values(app.store, pid2, BR, f"character:{m2['record_id']}")
    assert vals["handedness"]["value"] == "left" and vals["handedness"]["protected"] is True


# ====================================================================== H17 the whole-book report of a long book
def test_h17_book_parts_cover_every_word_and_merge_takes_the_median():
    from akowe import book_report as br
    chapters = [{"number": i + 1, "title": f"T{i}", "text": "\n\n".join(f"para {i}-{k} " + "word " * 300
                                                                         for k in range(12)),
                 "words": 3600, "objective": "x", "record_id": f"r{i}", "version": 1, "approved": True,
                 "chapter_id": f"ch{i}"} for i in range(6)]
    v = br.book_view(chapters, whole_max=5000, digest_max=4000)
    assert v["mode"] == "digest" and v["read_percent"] < 30
    parts = br.book_parts(chapters, part_max=5000)
    assert len(parts) > 3 and all(sum(len(c["text"]) for c in p["chapters"]) <= 5000 for p in parts)
    joined = "".join(c["text"] for p in parts for c in p["chapters"])
    assert all(f"para {i}-{k} " in joined for i in range(6) for k in range(12))  # nothing is skipped
    rows = [{"status": "done", "slot": "AI-2", "name": "B", "scores": {"plot_continuity": s, "ending": 5},
             "strengths": [{"point": "vivid", "quote": "q"}], "weaknesses": [{"point": f"w{s}", "quote": "q"}],
             "try_next": ["x"], "summary": f"s{s}", "calibration": {"flagged": s == 9}} for s in (4, 6, 9)]
    m = br.merge_part_rows(rows + [{"status": "failed", "error": "TIMEOUT"}])
    assert m["scores"] == {"plot_continuity": 6, "ending": 5} and m["parts"] == {"read": 3, "of": 4}
    assert len(m["strengths"]) == 1 and len(m["weaknesses"]) == 3 and m["calibration"]["flagged"] is True
    assert "1 of 4 part(s) could not be read" in m["message"]


def test_h17_a_long_book_report_says_sampled_and_read_the_whole_book_reads_every_part(tmp_path, monkeypatch):
    import functools
    from akowe import book_report as br
    from test_failover_review import SlotFake, make_app as make_slots_app, run_book as run_slots_book
    app = make_slots_app(tmp_path, SlotFake())
    run = run_slots_book(app, {"slot_id": "AI-1"})
    pid = run["project_id"]
    monkeypatch.setattr(br, "book_view", functools.partial(br.book_view, whole_max=600, digest_max=500))
    monkeypatch.setattr(br, "book_parts", functools.partial(br.book_parts, part_max=900))
    rep = app.reports.make("author", pid, BR, ai=True, slots=["AI-2"])
    assert rep["book_mode"] == "digest" and rep["read"]["percent"] < 100
    banner = next(w for w in rep["warnings"] if w.startswith("📖 Sampled"))
    assert "Read the whole book" in banner and f"about {rep['read']['percent']}%" in banner
    assert "📖 Sampled" in br.render_markdown(rep)
    full = app.reports.make("author", pid, BR, ai=True, slots=["AI-2"], full=True)
    n = len(br.book_parts(br.book_chapters(__import__("akowe.book_path", fromlist=["BookPath"]).BookPath(
        app.engine, "author", pid, BR))))
    assert full["book_mode"] == "parts" and full["read"] == {"mode": "parts", "percent": 100, "parts": n} and n > 1
    row = next(r for r in full["reviews"] if r["slot"] == "AI-2")
    assert row["status"] == "done" and row["parts"] == {"read": n, "of": n} and row["scores"]
    assert any(w.startswith("📖 Read in full") for w in full["warnings"])
    assert not any(w.startswith("📖 Sampled") for w in full["warnings"])
    # the job API takes full: true
    st, job = app.route("POST", f"/api/projects/{pid}/branches/{BR}/report", {}, {"slots": ["AI-2"], "full": True},
                        "author", {})
    assert st == 202
    for _ in range(400):
        j = app.reports.job("author", job["id"])
        if j["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert j["status"] == "done" and app.reports.get(pid, BR, j["report_id"])["book_mode"] == "parts"


# ====================================================================== H15 pictures and 🔒 locks vs the description
@pytest.fixture
def pictured(tmp_path):
    from test_book_pictures import PictureBridge
    app = make_app(tmp_path, fake=BookFakeAI())
    b = PictureBridge()
    forge.save_bridge_settings(app, {"url": b.url})
    run = run_book(app, {"genre": "Mystery", "length": "short_story"})
    assert run["status"] == "done", (run["phase"], run.get("problem"))
    yield app, b, run["project_id"]
    b.close()


def test_h15_a_changed_description_marks_pictures_and_lock_out_of_date_remake_and_ask_before_the_lock(pictured):
    from akowe import binder, book_pictures
    app, b, pid = pictured
    prot = book_pictures.protagonist_id(app.store, pid, BR)
    art = forge.raw_entry(app.store, pid, BR, prot)["art"]
    assert art["portrait"]["looks_fp"] and art["views"]["side"]["looks_fp"]  # each picture knows its description
    assert book_pictures.outdated(app.store, pid, BR) == []
    old_portrait = art["portrait"]["asset_id"]
    sec = forge.FIELDS["eyes"]["section"]
    forge.edit(app.store, pid, BR, prot, {"sections": {sec: {"eyes": {"text": "One eye is now milky white"}}}})
    old = book_pictures.outdated(app.store, pid, BR)
    assert [x["record_id"] for x in old] == [prot]
    assert old[0]["slots"] == list(book_pictures.FULL) and old[0]["lock"] is True
    g = binder.glance_live(app, pid, BR)
    assert g["pictures"]["outdated"]["count"] == 5
    assert "🖼 5 pictures are older than their description — remake" in g["pictures"]["outdated"]["words"]
    assert "replace it?" in g["pictures"]["outdated"]["words"]
    # 🖼 Remake: the pictures are made again from the description now — the lock is NOT replaced silently
    posts = len(b.lock_posts)
    job = book_pictures.start_remake(app, "author", pid, BR, {})
    j = wait_job(app, job)
    assert j["status"] == "done" and j["results"][-1]["made"] == 5, j
    assert "Replace the lock" in j["results"][-1]["message"]
    art = forge.raw_entry(app.store, pid, BR, prot)["art"]
    assert art["portrait"]["asset_id"] != old_portrait
    left = book_pictures.outdated(app.store, pid, BR)
    assert left == [{"record_id": prot, "name": left[0]["name"], "slots": [], "lock": True}]
    assert not any(p.get("replace") for p in b.lock_posts[posts:])
    # 🔒 Replace the lock: only with the author's yes
    with pytest.raises(AkoweError) as e:
        book_pictures.replace_lock(app, pid, BR, prot, {})
    assert e.value.code == "APPROVAL_REQUIRED"
    out = book_pictures.replace_lock(app, pid, BR, prot, {"author_confirms": True})
    assert out["ok"] and b.lock_posts[-1]["replace"] is True and "milky white" in b.lock_posts[-1]["prompt"]
    assert book_pictures.outdated(app.store, pid, BR) == []
    # nothing is out of date: Remake says so in plain words
    with pytest.raises(AkoweError) as e:
        book_pictures.start_remake(app, "author", pid, BR, {})
    assert "no picture is older" in e.value.errors[0]["message"]
