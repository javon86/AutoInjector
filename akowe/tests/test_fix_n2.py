"""🔁 Stress fixes n2 (R2): the ⚡ Make-a-book run goes back to an earlier book step when something changed, and damaged
stored format / assembly / export state is made again instead of reused or looped on.

One regression test per finding: F-14-d/e/j, F-15-d/e/o, F-16-a/d/e/j/k/l, F-17-d/e/k/l/m, E-13-m
(docs/stress/F-putting-the-book-together.md, docs/stress/E2-writing-part-2.md).
"""
from __future__ import annotations

import io
import zipfile

import pytest

from akowe import autobook as ab_mod, book_again, store as store_mod
from akowe.book_path import BookPath, get_profile, save_profile
from akowe.modules import set_g

from autobook_fake import BookFakeAI
from test_autobook import make_app, run_book, steps

BODY = {"genre": "Mystery", "length": "short_story"}


# ---------------------------------------------------------------------------------------------- helpers
def at_step(monkeypatch, sid, before=None, after=None, once=True):
    """Run ``before(app_run)`` / ``after(app_run)`` around the run's step ``sid`` (once by default: the step may be
    called again from a later step when the run goes back)."""
    orig = getattr(ab_mod.AutoBookService, f"_s_{sid}")
    seen = {"n": 0}

    def wrapped(self, run, st):
        first = seen["n"] == 0
        seen["n"] += 1
        if before and (first or not once):
            before(self, run)
        out = orig(self, run, st)
        if after and (first or not once):
            after(self, run)
        return out
    monkeypatch.setattr(ab_mod.AutoBookService, f"_s_{sid}", wrapped)
    return seen


def bp_of(app, run) -> BookPath:
    return BookPath(app.engine, "author", run["project_id"], run["branch_id"])


def chapters(app, run):
    """[(chapter id, approved record, latest record)] in outline order."""
    bp = bp_of(app, run)
    outline = bp.outline()
    out = []
    for c in bp.outline_chapters(outline):
        _ctx, latest, appr = bp.chapter_prose(outline, c["chapter_id"])
        out.append((c["chapter_id"], appr, latest))
    return out


def hand_edit(app, run, rid, text, approve=True):
    bp = bp_of(app, run)
    head = bp.rec(rid)
    resp = bp.dispatch("C02", "UPDATE", base_ref=head["ref"], payload=dict(head["data"], text=text))
    assert resp["status"] == "DRAFT", resp
    if approve:
        res = app.review.approve("author", run["project_id"], run["branch_id"],
                                 {"record_ids": [rid], "author_confirms": True, "how": "one"})
        assert (res.get("results") or [{}])[0].get("ok"), res


def book_steps(app, run) -> dict:
    return {s["id"]: s for s in bp_of(app, run).status()["steps"]}


def file_bytes(app, run, fmt):
    for f in run.get("files") or []:
        if f["format"] == fmt:
            rec = app.store.get_record(run["project_id"], run["branch_id"], f["record_id"], f["version"])
            return app.store.read_binary(rec)
    return None


def zip_text(data) -> str:
    z = zipfile.ZipFile(io.BytesIO(data))
    return "\n".join(z.read(n).decode("utf-8", "replace") for n in z.namelist()
                     if n.endswith((".xhtml", ".html", ".xml", ".opf", ".ncx")))


def codes(app, run_id, code):
    return [e for e in app.autobook.get(run_id)["events"] if e.get("code") == code]


def resume(app, run):
    app.autobook.resume("author", run["id"])
    app.autobook.wait_for(run["id"], 120)
    return app.autobook.public(app.autobook.get(run["id"]))


def all_book_steps_done(app, run):
    st = book_steps(app, run)
    return all(st[s]["state"] == "done" for s in ("format", "assemble", "export", "check"))


@pytest.fixture
def app(tmp_path):
    return make_app(tmp_path, fake=BookFakeAI())


# ---------------------------------------------------------------------------------------------- a plain run
def test_a_plain_run_makes_nothing_again_and_says_nothing_extra(app):
    run = run_book(app, BODY)
    assert run["status"] == "done", run.get("problem")
    for code in ("BOOK_AGAIN", "EXPORT_REMADE", "CHAPTER_NEARLY_EMPTY", "DRAFT_WAITING"):
        assert not codes(app, run["id"], code), code
    assert all_book_steps_done(app, run)


# ---------------------------------------------------------------------------------------------- F-14
def test_f14_d_garbage_remembered_format_is_made_again(app, monkeypatch):
    garbage = {"font": "garbage", "page": 12, "font_file": ["x"], "toc_style": {"record_id": 5}, "metadata": None,
               "language": 7}
    at_step(monkeypatch, "format", before=lambda svc, r: bp_of(app, r).remember(
        lambda m: m.__setitem__("format", dict(garbage))))
    run = run_book(app, BODY)
    assert run["status"] == "done", run.get("problem")
    assert all_book_steps_done(app, run)


def test_f14_d_a_damaged_path_memory_never_breaks_the_checklist(app):
    run = run_book(app, BODY)
    bp = bp_of(app, run)
    bp.remember(lambda m: m.update(format=["x"], assembly="?", exports=5, check=[1]))
    st = book_steps(app, run)  # no TypeError / AttributeError: the damaged parts read as missing
    assert st["format"]["state"] in ("ready", "needs_you") and st["assemble"]["state"] == "blocked"
    assert not BookPath.ref_shape_ok({"record_id": 5, "version": 1}) and not BookPath.ref_shape_ok("x")


def test_f14_e_empty_stored_title_is_a_plain_stop_and_resume_finishes(app, monkeypatch):
    keep = {}

    def clear(svc, r):
        p = get_profile(app.store, r["project_id"])
        keep["title"] = p.get("title")
        app.store.set_setting(f"book_profile:{r['project_id']}", dict(p, title=""))
    at_step(monkeypatch, "format", before=clear)
    run = run_book(app, BODY)
    assert run["status"] == "paused"
    prob = run["problem"]
    assert prob["code"] == "MISSING_INPUT" and "no title" in prob["message"] and "book profile" in prob["fix"]
    save_profile(app.store, run["project_id"], {"title": keep["title"] or "Restored"})
    run = resume(app, run)
    assert run["status"] == "done", run.get("problem")


@pytest.mark.parametrize("change", [{"title": "A Brand New Title"}, {"trim_size": "5x8"}])
def test_f14_j_renamed_or_new_page_size_after_the_format_the_run_makes_it_again(app, monkeypatch, change):
    at_step(monkeypatch, "format", after=lambda svc, r: save_profile(app.store, r["project_id"], dict(change)))
    run = run_book(app, BODY)
    assert run["status"] == "done", run.get("problem")
    assert any(e.get("made") == "format" for e in codes(app, run["id"], "BOOK_AGAIN"))
    assert all_book_steps_done(app, run)
    if "title" in change:
        assert change["title"] in zip_text(file_bytes(app, run, "EPUB"))
        assert all(f.get("title") == change["title"] for f in run["files"])


# ---------------------------------------------------------------------------------------------- F-15
def test_f15_d_garbage_remembered_assembly_is_made_again(app, monkeypatch):
    at_step(monkeypatch, "assemble", before=lambda svc, r: bp_of(app, r).remember(
        lambda m: m.__setitem__("assembly", {"G01": "x", "G07": 3, "chapters": 5, "title_page": "?"})))
    run = run_book(app, BODY)
    assert run["status"] == "done", run.get("problem")
    assert all_book_steps_done(app, run)


def test_f15_e_an_almost_empty_approved_chapter_is_named(app, monkeypatch):
    at_step(monkeypatch, "assemble", before=lambda svc, r: hand_edit(app, r, chapters(app, r)[1][1]["record_id"], "."))
    run = run_book(app, BODY)
    assert run["status"] == "done", run.get("problem")
    notes = codes(app, run["id"], "CHAPTER_NEARLY_EMPTY")
    assert notes and notes[0]["chapters"] == [2] and "Chapter 2" in notes[0]["message"]


def test_f15_o_a_newer_unapproved_draft_is_named_when_the_run_finishes(app, monkeypatch):
    def draft(svc, r):
        appr = chapters(app, r)[0][1]
        hand_edit(app, r, appr["record_id"], appr["data"]["text"] + " QZXDRAFT", approve=False)
    at_step(monkeypatch, "assemble", before=draft)
    run = run_book(app, BODY)
    assert run["status"] == "done", run.get("problem")
    assert "QZXDRAFT" not in zip_text(file_bytes(app, run, "EPUB"))  # the files carry the approved text
    notes = codes(app, run["id"], "DRAFT_WAITING")
    assert notes and notes[-1]["chapters"] == [1] and "not approved" in notes[-1]["message"]


# ---------------------------------------------------------------------------------------------- F-16
def test_f16_a_pause_in_a_step_without_ai_says_after_this_step(app):
    svc = app.autobook
    run = {"id": "x", "status": "pausing", "current": "export"}
    svc.alive = lambda rid: True  # noqa: ARG005 - the run is working
    assert svc.run_state(run) == ("pausing", "Pausing after this step.")
    assert svc.run_state(dict(run, current="chapters"))[1] == "Pausing after the current answer."


def test_f16_d_a_garbage_file_once_is_made_again_and_the_book_finishes(app, monkeypatch):
    orig = set_g.render_pdf
    n = {"c": 0}

    def once_garbage(*a, **k):
        n["c"] += 1
        return b"<html>not a pdf</html>" if n["c"] == 1 else orig(*a, **k)
    monkeypatch.setattr(set_g, "render_pdf", once_garbage)
    run = run_book(app, BODY)
    assert run["status"] == "done", run.get("problem")
    assert codes(app, run["id"], "EXPORT_REMADE")
    assert all_book_steps_done(app, run)


@pytest.mark.parametrize("bad", [b"<html>not a pdf</html>", b""], ids=["garbage-F-16-d", "empty-F-16-e"])
def test_f16_d_e_a_writer_broken_every_time_stops_plainly_and_resume_remakes(app, monkeypatch, bad):
    orig = set_g.render_pdf
    state = {"broken": True}
    monkeypatch.setattr(set_g, "render_pdf", lambda *a, **k: bad if state["broken"] else orig(*a, **k))
    run = run_book(app, BODY)
    assert run["status"] == "paused"
    prob = run["problem"]
    assert prob["code"] == "HASH_MISMATCH" and prob["message"].startswith("The PDF file Akọwe made does not read back")
    state["broken"] = False  # the cause is gone: Resume makes the stored bad file again (it no longer loops)
    run = resume(app, run)
    assert run["status"] == "done", run.get("problem")
    assert all_book_steps_done(app, run)


def test_f16_j_disk_full_while_the_pdf_is_written_says_so(app, monkeypatch):
    real = store_mod.replace_file
    flag = {"pdf": False, "n": 0}
    orig_pdf = set_g.render_pdf

    def mark(*a, **k):
        flag["pdf"] = True
        return orig_pdf(*a, **k)

    def full(tmp, path, *a, **k):
        if flag["pdf"] and flag["n"] < 1:
            flag["n"] += 1
            flag["pdf"] = False
            raise OSError(28, "No space left on device")
        return real(tmp, path, *a, **k)
    monkeypatch.setattr(set_g, "render_pdf", mark)
    monkeypatch.setattr(store_mod, "replace_file", full)
    run = run_book(app, BODY)
    assert run["status"] == "paused"
    prob = run["problem"]
    assert "disk is full" in prob["message"] and "PDF" in prob["message"] and "space" in prob["fix"]
    run = resume(app, run)
    assert run["status"] == "done", run.get("problem")


def test_f16_k_a_chapter_edited_between_assemble_and_export_goes_into_the_files(app, monkeypatch):
    def edit(svc, r):
        appr = chapters(app, r)[0][1]
        hand_edit(app, r, appr["record_id"], appr["data"]["text"] + " QZXNEWTEXT")
    at_step(monkeypatch, "export", before=edit)
    run = run_book(app, BODY)
    assert run["status"] == "done", run.get("problem")
    assert "QZXNEWTEXT" in zip_text(file_bytes(app, run, "EPUB"))
    assert "QZXNEWTEXT" in zip_text(file_bytes(app, run, "DOCX"))
    assert any(e.get("made") == "assemble" for e in codes(app, run["id"], "BOOK_AGAIN"))


def test_f16_l_a_damaged_saved_file_is_written_again(app, monkeypatch):
    orig = BookPath.a_export
    state = {"n": 0}

    def export_then_damage(self, body):
        out = orig(self, body)
        for f in {s["id"]: s for s in self.status()["steps"]}["export"].get("files") or []:
            if f["format"] == "DOCX" and state["n"] == 0:
                state["n"] += 1
                rec = self.store.get_record(self.pid, self.branch, f["record_id"], f["version"])
                path = self.store.asset_dir / rec["binary"]["storage_uri"].split("/")[-1]
                data = path.read_bytes()
                path.write_bytes(data[: len(data) // 2])  # cut in half on disk, never restored
        return out
    monkeypatch.setattr(BookPath, "a_export", export_then_damage)
    run = run_book(app, BODY)
    assert run["status"] == "done", run.get("problem")
    assert codes(app, run["id"], "EXPORT_REMADE")
    assert file_bytes(app, run, "DOCX")  # reads back with its hash


# ---------------------------------------------------------------------------------------------- F-17
def _h05(monkeypatch, result_of, state):
    orig = BookPath.dispatch

    def dispatch(self, op, action, **kw):
        r = orig(self, op, action, **kw)
        if op == "H05" and action == "CREATE" and state["on"]:
            return dict(r, result=result_of(r))
        return r
    monkeypatch.setattr(BookPath, "dispatch", dispatch)


@pytest.mark.parametrize("result", [{"findings": "garbage", "status": None}, {}], ids=["F-17-d", "F-17-e"])
def test_f17_d_e_an_unreadable_content_check_is_a_plain_stop(app, monkeypatch, result):
    state = {"on": True}
    _h05(monkeypatch, lambda r: dict(result), state)
    run = run_book(app, BODY)
    assert run["status"] == "paused"
    prob = run["problem"]
    assert prob["code"] == "INVALID_INPUT" and prob["message"] == "The content check gave an answer Akọwe could not read."
    assert "None" not in prob["message"]
    state["on"] = False
    run = resume(app, run)
    assert run["status"] == "done", run.get("problem")


def test_f17_d_check_message_reads_any_result():
    asm = {"chapters": ["C02-aaa:2", "C02-bbb:3"]}
    assert book_again.check_message("x", asm)["unreadable"]
    assert book_again.check_message({"status": "FAIL", "findings": "x"}, asm)["unreadable"]
    assert book_again.check_message({"status": "PASS", "findings": []}, asm)["ok"]
    out = book_again.check_message({"status": "FAIL", "findings": [
        5, {"rule_id": "DUPLICATE_CHAPTER_TEXT", "decision": "FAIL",
            "message": "sections C02-aaa and C02-bbb have identical text"}]}, asm)
    assert not out["ok"] and out["message"] == "Content check: Chapters 1 and 2 have the same text."


def test_f17_k_a_chapter_edited_after_the_export_goes_into_the_files(app, monkeypatch):
    def edit(svc, r):
        appr = chapters(app, r)[2][1]
        hand_edit(app, r, appr["record_id"], appr["data"]["text"] + " QZXLATEEDIT")
    at_step(monkeypatch, "check", before=edit)
    run = run_book(app, BODY)
    assert run["status"] == "done", run.get("problem")
    assert "QZXLATEEDIT" in zip_text(file_bytes(app, run, "EPUB"))
    assert all_book_steps_done(app, run)


def test_f17_l_a_failed_check_names_the_chapters_and_resume_after_the_fix_finishes(app, monkeypatch):
    state = {"on": True}

    def dup(r):
        asm = bp_of(app, app.autobook.get(run_id["id"])).mem_part("assembly")
        a, b = [x.rsplit(":", 1)[0] for x in asm["chapters"][:2]]
        return {"status": "FAIL", "findings": [{"rule_id": "DUPLICATE_CHAPTER_TEXT", "decision": "FAIL",
                                                "message": f"sections {a} and {b} have identical text"}]}
    run_id = {}
    orig_start = app.autobook.start

    def start(principal, body):
        r = orig_start(principal, body)
        run_id["id"] = r["id"]
        return r
    monkeypatch.setattr(app.autobook, "start", start)
    _h05(monkeypatch, dup, state)
    run = run_book(app, BODY)
    assert run["status"] == "paused"
    assert run["problem"]["message"] == "Content check: Chapters 1 and 2 have the same text."
    assert "Resume" in run["problem"]["fix"]
    state["on"] = False  # the author rewrites chapter 2 and approves it, then presses Resume
    hand_edit(app, run, chapters(app, run)[1][1]["record_id"], "Chapter two, rewritten by the author. QZXREWRITE")
    run = resume(app, run)
    assert run["status"] == "done", run.get("problem")
    assert "QZXREWRITE" in zip_text(file_bytes(app, run, "EPUB"))
    assert all_book_steps_done(app, run)


def test_f17_m_a_hand_assembly_during_the_check_never_leaves_a_done_run_on_a_stale_book(app, monkeypatch):
    orig = BookPath.a_check
    info = {}

    def again(self, body):
        if not info:
            info["asm"] = BookPath(app.engine, "author", self.pid, self.branch).a_assemble({}).get("ok")
        return orig(self, body)
    monkeypatch.setattr(BookPath, "a_check", again)
    run = run_book(app, BODY)
    assert info["asm"] is True
    assert run["status"] == "done", run.get("problem")
    assert all_book_steps_done(app, run)
    assert codes(app, run["id"], "BOOK_AGAIN")


# ---------------------------------------------------------------------------------------------- E-13-m
def test_e13_m_a_chapter_set_aside_near_the_end_is_written_again(app, monkeypatch):
    def aside(svc, r):
        bp = bp_of(app, r)
        _ctx, latest, appr = bp.chapter_prose(bp.outline(), "ch2")
        bp.set_aside(appr or latest, "the author marked it out of date")
    at_step(monkeypatch, "planned", before=aside)
    run = run_book(app, BODY)
    assert run["status"] == "done", run.get("problem")
    assert chapters(app, run)[1][1] is not None  # chapter 2 is approved again
    notes = [e for e in codes(app, run["id"], "BOOK_AGAIN") if e.get("made") == "chapters"]
    assert notes and "Chapter 2" in notes[0]["message"]
    assert all_book_steps_done(app, run)
